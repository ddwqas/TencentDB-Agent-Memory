import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWikiSourceManager } from "./manager.js";
import { evictWikiDb, getReadDb, initIndexDb, listPageStorage, withWriteDb } from "./index-db.js";
import { getActiveVersion } from "./version-store.js";
import { createDb } from "../../db/client.js";
import { SqliteKnowledgeStore, WikiService } from "../../store/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    evictWikiDb("wiki-test");
    evictWikiDb("inspect");
    rmSync(root, { recursive: true, force: true });
  }
});

function page(title: string, body: string): string {
  return `---\ntype: concept\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;
}

describe("versioned Wiki storage", () => {
  it("publishes atomically, reuses unchanged pages, rolls back, and retains failures", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "wiki-version-test-"));
    roots.push(sandbox);
    const project = join(sandbox, "service", "team", "wiki-test");
    const managerDir = join(sandbox, "_wiki_engines");
    mkdirSync(join(project, "raw", "sources"), { recursive: true });

    const manager = createWikiSourceManager(managerDir);
    manager.init({ name: "wiki-test", path: project });

    const first = manager.publishMutation("wiki-test", 1, (candidate) => {
      const concepts = join(candidate, "wiki", "concepts");
      mkdirSync(concepts, { recursive: true });
      writeFileSync(join(concepts, "stable.md"), page("Stable", "version one"), "utf-8");
    });
    expect(first.version).toBe(1);
    expect(getActiveVersion(project)?.version).toBe(1);
    expect(manager.readPage("wiki-test", "concepts/stable")).toContain("version one");

    const second = manager.publishMutation("wiki-test", 2, (candidate) => {
      const concepts = join(candidate, "wiki", "concepts");
      writeFileSync(join(concepts, "new.md"), page("New", "version two"), "utf-8");
    });
    expect(second.pageCount).toBe(first.pageCount + 1);
    const v2 = manager.versions("wiki-test").find((item) => item.version === 2)!;
    const v2Db = getReadDb("inspect", project, join(project, v2.index_file!));
    const stableRow = listPageStorage(v2Db).find((row) => row.page_id === "concepts/stable");
    const newRow = listPageStorage(v2Db).find((row) => row.page_id === "concepts/new");
    expect(stableRow?.storage_key).toBe(manager.versions("wiki-test").find((item) => item.version === 1)?.version_key);
    expect(newRow?.storage_key).toBe(v2.version_key);
    expect(existsSync(join(project, "pages", v2.version_key, "wiki", "concepts", "stable.md"))).toBe(false);
    expect(existsSync(join(project, "pages", v2.version_key, "wiki", "concepts", "new.md"))).toBe(true);
    expect(existsSync(join(project, "pages", v2.version_key, "wiki", "index.md"))).toBe(true);

    manager.activate("wiki-test", 1, 2);
    expect(getActiveVersion(project)?.version).toBe(1);
    expect(manager.readPage("wiki-test", "concepts/stable")).toContain("version one");
    expect(manager.readPage("wiki-test", "concepts/new")).toBeNull();

    expect(() => manager.publishMutation("wiki-test", 3, () => {
      throw new Error("intentional build failure");
    })).toThrow("intentional build failure");
    expect(getActiveVersion(project)?.version).toBe(1);
    const failed = manager.versions("wiki-test").find((item) => item.version === 3)!;
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("intentional build failure");
    expect(existsSync(join(project, "pages", failed.version_key, "manifest.json"))).toBe(true);

    const restarted = createWikiSourceManager(managerDir);
    expect(restarted.get("wiki-test")?.activeVersion).toBe(1);
    expect(restarted.readPage("wiki-test", "concepts/stable")).toContain("version one");
    expect(JSON.parse(readFileSync(join(project, "active-version.json"), "utf-8")).version).toBe(1);
  });

  it("keeps the active Wiki available when a refresh fails", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "wiki-availability-test-"));
    roots.push(sandbox);
    const { db, raw } = createDb({ path: ":memory:" });
    const manager = createWikiSourceManager(join(sandbox, "_wiki_engines"));
    let rejectBuild: (reason: Error) => void = () => undefined;
    const blockedBuild = new Promise<never>((_resolve, reject) => { rejectBuild = reject; });
    const service = new WikiService({
      store: new SqliteKnowledgeStore(db),
      dataRoot: sandbox,
      wikiManager: manager,
      worker: async () => blockedBuild,
    });

    const { row } = service.create({ service_id: "service", team_id: "team", name: "Available" });
    try {
      const written = service.pageWrite(
        "service",
        "team",
        row.wiki_id,
        "concepts/available",
        page("Available", "published content"),
      );
      expect(written).toMatchObject({ ref: "concepts/available" });
      service.rawWrite("service", "team", row.wiki_id, "refresh.md", "new source");

      expect(service.ingest("service", "team", row.wiki_id).kind).toBe("ok");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const during = service.get("service", "team", row.wiki_id)!;
      expect(during.status).toBe("ready");
      expect(during.ingest_status).toBe("processing");
      expect(service.pageRead("service", "team", row.wiki_id, "concepts/available")).toContain(
        "published content",
      );
      expect(service.pageLs("service", "team", row.wiki_id)?.some((item) => item.id === "concepts/available")).toBe(true);
      expect(manager.search(row.wiki_id, "published", 10).results.length).toBeGreaterThan(0);
      expect(manager.graph(row.wiki_id).nodes.some((node) => node.id === "concepts/available")).toBe(true);
      expect(service.pageWrite("service", "team", row.wiki_id, "concepts/blocked", page("Blocked", "x"))).toBe("processing");
      expect(await service.pageRm("service", "team", row.wiki_id, ["concepts/available"])).toBe("processing");
      expect(await service.rawRm("service", "team", row.wiki_id, ["refresh.md"])).toBe("processing");
      expect(service.rawWrite("service", "team", row.wiki_id, "next-batch.md", "queued source")).toMatchObject({
        filename: "next-batch.md",
      });
      expect(service.rawLs("service", "team", row.wiki_id)?.find((item) => item.filename === "next-batch.md")?.status).toBe("uploaded");

      rejectBuild(new Error("refresh failed"));
      await service.onIdle(row.wiki_id);
      const after = service.get("service", "team", row.wiki_id)!;
      expect(after.status).toBe("ready");
      expect(after.ingest_status).toBe("failed");
      expect(after.active_version).toBe(1);
      expect(service.pageRead("service", "team", row.wiki_id, "concepts/available")).toContain(
        "published content",
      );
      expect(service.pageWrite(
        "service",
        "team",
        row.wiki_id,
        "concepts/available",
        page("Available", "newer content"),
      )).toMatchObject({ ref: "concepts/available" });
      const latest = service.get("service", "team", row.wiki_id)!;
      expect(latest.active_version).toBe(3);
      expect(service.rollback("service", row.wiki_id, 1, 3).kind).toBe("ok");
      expect(service.pageRead("service", "team", row.wiki_id, "concepts/available")).toContain(
        "published content",
      );
    } finally {
      service.delete("service", "team", row.wiki_id);
      raw.close();
    }
  });

  it("bootstraps a legacy wiki without removing the legacy snapshot", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "wiki-legacy-test-"));
    roots.push(sandbox);
    const project = join(sandbox, "service", "team", "legacy-wiki");
    const concepts = join(project, "wiki", "concepts");
    mkdirSync(concepts, { recursive: true });
    writeFileSync(join(concepts, "legacy.md"), page("Legacy", "legacy content"), "utf-8");
    initIndexDb(project);
    withWriteDb(project, (db) => {
      db.prepare(
        `INSERT INTO page_meta(page_id, title, type, rel_path, snippet)
         VALUES ('concepts/legacy', 'Legacy', 'concept', 'wiki/concepts/legacy.md', 'legacy content')`,
      ).run();
    });

    const manager = createWikiSourceManager(join(sandbox, "_wiki_engines"));
    const state = manager.restore({ name: "legacy-wiki", path: project });
    expect(state.status).toBe("ready");
    expect(state.activeVersion).toBe(0);
    expect(manager.readPage("legacy-wiki", "concepts/legacy")).toContain("legacy content");
    expect(existsSync(join(project, "wiki", "concepts", "legacy.md"))).toBe(true);
    expect(existsSync(join(project, "index.db"))).toBe(true);
    expect(existsSync(join(project, "index-v0.db"))).toBe(true);
    expect(manager.versions("legacy-wiki")[0]).toMatchObject({
      version: 0,
      state: "published",
      active: true,
      reason: "legacy-migration",
    });
    manager.remove("legacy-wiki");
  });
});
