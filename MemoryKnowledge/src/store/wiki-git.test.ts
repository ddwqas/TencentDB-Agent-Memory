import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import simpleGit from "simple-git";
import { createDb } from "../db/client.js";
import { SqliteKnowledgeStore } from "./sqlite-store.js";
import { WikiService } from "./wiki-service.js";
import { GitSourceFetcher } from "../source-fetcher/git-fetcher.js";
import { normalizeWikiGitConfig, readGitMarkdown, readWikiGitMetadata } from "../source-fetcher/wiki-git-source.js";
import { createWikiSourceManager } from "../engines/wiki/manager.js";
import { evictWikiDb, sha256 } from "../engines/wiki/index-db.js";
import { buildPage, parseFrontmatter } from "../engines/wiki/ingest-v2/frontmatter.js";
import { sourceFilename } from "../engines/wiki/ingest-v2/source-path.js";
import * as ingest from "../engines/wiki/ingest-v2/index.js";
import * as llm from "../engines/wiki/ingest-v2/llm.js";
import * as merge from "../engines/wiki/ingest-v2/merge.js";
import * as overview from "../engines/wiki/ingest-v2/overview.js";
import { createWikiRoutes } from "../routes/wiki.js";

const cleanups: Array<() => void> = [];
vi.setConfig({ testTimeout: 30_000 });
const failingSources = new Set<string>();
const extracted: string[] = [];

beforeEach(() => {
  failingSources.clear();
  extracted.length = 0;
  // 仅替代 LLM 输出；Git、SQLite、增量分类、级联删除与版本发布均运行真实实现。
  vi.spyOn(ingest, "extractSource").mockImplementation(async (project, source) => {
    const filename = sourceFilename(project, source);
    extracted.push(filename);
    if (failingSources.has(filename)) throw new Error(`test analysis failure: ${filename}`);
    return new Map([[`wiki/concepts/${sha256(filename).slice(0, 12)}.md`,
      buildPage({ type: "concept", title: filename, sources: [filename] }, readFileSync(source, "utf8"))]]);
  });
  vi.spyOn(llm, "createLlmClient").mockReturnValue({} as llm.LlmClient);
  vi.spyOn(merge, "mergePage").mockImplementation(async (_existing, candidate) => ({ action: "write", content: candidate }));
  vi.spyOn(overview, "generateOverview").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture(initial: Record<string, string> = { "docs/a/README.md": "alpha", "docs/b/README.md": "beta" }) {
  const root = mkdtempSync(join(tmpdir(), "wiki-git-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = simpleGit(repo);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.name", "Wiki test");
  await git.addConfig("user.email", "wiki-test@example.invalid");
  await git.addConfig("core.autocrlf", "false");
  const put = (name: string, content: string) => {
    const full = join(repo, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  };
  for (const [name, content] of Object.entries(initial)) put(name, content);
  const commit = async () => {
    await git.add(["--all"]);
    await git.commit("test documents");
    return (await git.revparse(["HEAD"])).trim();
  };
  const firstCommit = await commit();
  vi.spyOn(GitSourceFetcher.prototype, "fetch").mockImplementation(async (_url, branch, localPath) => {
    await simpleGit().clone(repo, localPath, ["--branch", branch]);
    return { localPath, version: (await simpleGit(localPath).revparse(["HEAD"])).trim(), sourceType: "git" };
  });
  const { db, raw } = createDb({ path: ":memory:" });
  const manager = createWikiSourceManager(join(root, "manager"));
  const store = new SqliteKnowledgeStore(db);
  const service = new WikiService({
    store, dataRoot: join(root, "data"), wikiManager: manager,
    worker: async (ctx) => {
      manager.init({ name: ctx.wikiId, path: ctx.dir });
      await manager.ingest(ctx.wikiId, {}, {
        version: ctx.version, gitSource: ctx.gitSource, sourceBaseline: ctx.sourceBaseline,
        signal: ctx.signal, sourceSnapshot: ctx.sourceSnapshot, saveProgress: ctx.setProgress,
      });
      return { pageCount: manager.getPages(ctx.wikiId).length };
    },
  });
  const { row } = service.create({ service_id: "service", team_id: "team", name: "Git docs", source_type: "git",
    git: { repo_url: "https://example.invalid/docs.git", branch: "main", docs_path: "docs" } });
  const wikiId = row.wiki_id;
  cleanups.push(() => {
    evictWikiDb(wikiId);
    raw.close();
    const checked = resolve(root);
    if (!checked.startsWith(resolve(tmpdir()) + sep) || !checked.includes("wiki-git-test-")) throw new Error("unsafe fixture path");
    rmSync(checked, { recursive: true, force: true });
  });
  const current = () => service.getById("service", wikiId)!;
  const metadata = () => readWikiGitMetadata(current().metadata_json)!;
  const sync = async () => {
    expect(service.sync("service", "team", wikiId).kind).toBe("ok");
    await service.onIdle(wikiId);
    return current();
  };
  return { root, repo, git, put, commit, firstCommit, service, manager, store, wikiId, current, metadata, sync };
}

describe("Wiki Git source", () => {
  it("keeps nested names, skips unchanged commits, applies deltas and uses the active version after rollback", async () => {
    const f = await fixture();
    expect(f.current().status).toBe("draft");
    expect(f.service.listVersions("service", f.wikiId)).toEqual([]);
    await f.sync();
    expect(f.current().active_version, f.current().sync_error ?? "").toBe(1);
    expect(f.metadata().commit_hash).toBe(f.firstCommit);
    expect(f.service.rawLs("service", "team", f.wikiId)?.map((file) => file.filename)).toEqual(["a/README.md", "b/README.md"]);
    expect(f.service.listVersions("service", f.wikiId)?.[0].git_source?.commit_hash).toBe(f.firstCommit);
    expect(extracted.sort()).toEqual(["a/README.md", "b/README.md"]);

    extracted.length = 0;
    f.put("ignored.txt", "a non-document change");
    const ignoredCommit = await f.commit();
    await f.sync();
    expect(extracted).toEqual([]);
    expect(f.current().version).toBe(1);
    expect(f.metadata().commit_hash).toBe(f.firstCommit);
    expect(f.metadata().last_sync).toMatchObject({ no_changes: true, commit_hash: ignoredCommit, skipped: 2 });

    f.put("docs/a/README.md", "changed alpha");
    renameSync(join(f.repo, "docs/b/README.md"), join(f.repo, "docs/b/renamed.md"));
    const secondCommit = await f.commit();
    await f.sync();
    expect(f.current().active_version).toBe(2);
    expect(f.metadata().last_sync).toMatchObject({ added: 1, modified: 1, deleted: 1 });
    expect(f.manager.getPages(f.wikiId).some((page) => page.title === "b/README.md")).toBe(false);
    expect(f.manager.getPages(f.wikiId).some((page) => page.title === "b/renamed.md")).toBe(true);

    expect(f.service.rollback("service", f.wikiId, 1, 2).kind).toBe("ok");
    expect(f.metadata().commit_hash).toBe(f.firstCommit);
    extracted.length = 0;
    await f.sync();
    expect(extracted).toEqual([]);
    expect(f.service.analysisProgress("service", f.wikiId)?.cached).toBe(2);
    expect(f.current().active_version).toBe(3);
    expect(f.metadata().commit_hash).toBe(secondCommit);
  });

  it("retains the published version on failure and retries failed documents without a new Git commit", async () => {
    const f = await fixture();
    await f.sync();
    f.put("docs/a/README.md", "updated alpha");
    const commit = await f.commit();
    failingSources.add("a/README.md");
    await f.sync();
    expect(f.current()).toMatchObject({ status: "ready", ingest_status: "failed", active_version: 1 });
    expect(f.metadata().commit_hash).toBe(f.firstCommit);
    expect(f.metadata().last_sync?.failures[0].filename).toBe("a/README.md");
    expect(f.service.listVersions("service", f.wikiId)?.[0].state).toBe("failed");
    failingSources.clear();
    await f.sync();
    expect(f.current()).toMatchObject({ status: "ready", ingest_status: "idle", active_version: 3 });
    expect(f.metadata().commit_hash).toBe(commit);

    f.put("docs/c.md", "new c");
    f.put("docs/d.md", "new d");
    await f.commit();
    failingSources.add("c.md");
    await f.sync();
    expect(f.current().ingest_status).toBe("idle");
    expect(f.metadata().last_sync?.failed).toBe(1);
    failingSources.clear();
    extracted.length = 0;
    await f.sync();
    expect(extracted).toEqual(["c.md"]);
    expect(f.metadata().last_sync).toMatchObject({ retried: 1, failed: 0 });
  });

  it("preserves shared knowledge, removes stale references and supports deleting all tracked documents", async () => {
    const f = await fixture();
    await f.sync();
    const aRef = sha256("a/README.md").slice(0, 12);
    f.service.pageWrite("service", "team", f.wikiId, "concepts/shared",
      buildPage({ type: "concept", title: "Shared", sources: ["a/README.md", "b/README.md"] }, `shared [[${aRef}]]`));
    const manual = f.service.listVersions("service", f.wikiId)![0];
    expect(manual.git_source?.commit_hash).toBe(f.firstCommit);
    rmSync(join(f.repo, "docs/a/README.md"));
    await f.commit();
    await f.sync();
    const shared = f.manager.readPage(f.wikiId, "concepts/shared")!;
    expect(parseFrontmatter(shared).frontmatter.sources).toEqual(["b/README.md"]);
    expect(shared).not.toContain(`[[${aRef}]]`);
    expect(f.manager.getPages(f.wikiId).some((page) => page.title === "b/README.md")).toBe(true);
    rmSync(join(f.repo, "docs/b/README.md"));
    f.put("README.txt", "repository without Markdown");
    await f.commit();
    await f.sync();
    expect(f.current().ingest_status).toBe("idle");
    expect(f.service.rawLs("service", "team", f.wikiId)).toEqual([]);
    expect(f.manager.readPage(f.wikiId, "concepts/shared")).toBeNull();
    expect(f.metadata().last_sync).toMatchObject({ total: 0, deleted: 1 });
  });

  it("keeps manual page versions on the published source after a failed Git refresh", async () => {
    const f = await fixture();
    await f.sync();
    f.put("docs/a/README.md", "unpublished revision");
    const nextCommit = await f.commit();
    failingSources.add("a/README.md");
    await f.sync();
    expect(f.current().ingest_status).toBe("failed");
    f.service.pageWrite("service", "team", f.wikiId, "concepts/editor-note",
      buildPage({ type: "concept", title: "Editor note" }, "manual knowledge edit"));
    const manual = f.service.listVersions("service", f.wikiId)![0];
    expect(manual.git_source?.commit_hash).toBe(f.firstCommit);
    const snapshot = join(f.service.dirFor("service", "team", f.wikiId), "pages", manual.version_key, "pending", "sources", "a", "README.md");
    expect(readFileSync(snapshot, "utf8")).toBe("alpha");
    failingSources.clear();
    extracted.length = 0;
    await f.sync();
    expect(extracted).toEqual(["a/README.md"]);
    expect(f.metadata().last_sync).toMatchObject({ modified: 1, retried: 0 });
    expect(f.metadata().commit_hash).toBe(nextCommit);
    expect(f.manager.readPage(f.wikiId, "concepts/editor-note")).toContain("manual knowledge edit");
  });

  it("rejects mixed sources, concurrent sync and oversized or missing-directory snapshots", async () => {
    const f = await fixture();
    expect(f.service.rawWrite("service", "team", f.wikiId, "extra.md", "extra")).toBe("git_managed");
    expect(f.service.rawWriteMany("service", "team", f.wikiId, [{ filename: "extra.md", content: "extra" }])).toBe("git_managed");
    expect(await f.service.rawRm("service", "team", f.wikiId, ["a/README.md"])).toBe("git_managed");
    expect(() => f.service.create({ service_id: "service", team_id: "team", name: "Git docs" })).toThrow("different source");
    expect(f.service.sync("service", "team", f.wikiId).kind).toBe("ok");
    expect(f.service.sync("service", "team", f.wikiId).kind).toBe("busy");
    await f.service.onIdle(f.wikiId);
    f.put("docs/large.md", "x".repeat(5 * 1024 * 1024 + 1));
    await f.commit();
    await f.sync();
    expect(f.current().active_version).toBe(1);
    expect(f.current().sync_error).toContain("large.md");
    expect(f.service.rawRead("service", "team", f.wikiId, "large.md")).toBeNull();
    await expect(readGitMarkdown(f.repo, "HEAD", "not-found")).rejects.toThrow("directory not found");
  });

  it("reads thousands of tracked nested Markdown files, including files larger than the upload limit", async () => {
    const f = await fixture({ "docs/large.md": "x".repeat(538_271) });
    for (let i = 0; i < 2614; i++) f.put(`docs/chapter-${Math.floor(i / 100)}/document-${i % 100}.md`, `document ${i}`);
    f.put("docs/ignored.txt", "not Markdown");
    const commit = await f.commit();
    f.put("docs/untracked.md", "not committed");
    const files = await readGitMarkdown(f.repo, commit, "docs");
    expect(files).toHaveLength(2615);
    expect(new Set(files.map((file) => file.filename)).size).toBe(2615);
    expect(files.find((file) => file.filename === "large.md")?.size).toBe(538_271);
    expect(files.some((file) => file.filename === "untracked.md")).toBe(false);
  }, 90_000);

  it("exposes Git creation and sync through the API while retaining upload validation", async () => {
    const f = await fixture();
    const app = createWikiRoutes({ wikiService: f.service, wikiMgr: f.manager, publicBaseUrl: "" });
    const post = (path: string, body: unknown, service = "service") => app.request(path, {
      method: "POST", headers: { "content-type": "application/json", "x-tdai-service-id": service }, body: JSON.stringify(body),
    });
    const gitDetail = await (await post("/get", { wiki_id: f.wikiId })).json();
    expect(gitDetail.data).toMatchObject({ source_type: "git", git: { branch: "main", docs_path: "docs", commit_hash: null } });
    expect((await post("/sync", { wiki_id: f.wikiId })).status).toBe(202);
    await f.service.onIdle(f.wikiId);
    expect((await post("/sync", { wiki_id: f.wikiId }, "foreign")).status).toBe(404);
    expect((await post("/raw/write", { team_id: "team", wiki_id: f.wikiId, files: [{ filename: "x.md", content: "x" }] })).status).toBe(409);
    const created = await post("/create", { team_id: "team", name: "Upload" });
    const upload = (await created.json()).data;
    expect(upload.source_type).toBe("upload");
    expect((await post("/ingest", { wiki_id: upload.wiki_id })).status).toBe(400);
    evictWikiDb(upload.wiki_id);
    expect(existsSync(join(f.repo, "docs/a/README.md"))).toBe(true);
  });

  it("validates immutable source configuration without embedding credentials", () => {
    const config = { repo_url: "https://example.invalid/docs.git", branch: "main", docs_path: "./文档/章节/" };
    expect(normalizeWikiGitConfig(config).docs_path).toBe("文档/章节");
    for (const docs_path of ["../outside", "docs/../outside", "/absolute", "C:/outside", ".git"]) {
      expect(() => normalizeWikiGitConfig({ ...config, docs_path })).toThrow("docs_path");
    }
    expect(() => normalizeWikiGitConfig({ ...config, repo_url: "https://token@example.invalid/docs.git" })).toThrow("credentials");
    expect(() => normalizeWikiGitConfig({ ...config, branch: "--upload-pack=bad" })).toThrow("branch");
  });

  it("pauses AI calls, survives service recreation, and resumes the pinned commit without repeating completed documents", async () => {
    const f = await fixture();
    const extract = vi.mocked(ingest.extractSource).getMockImplementation()!;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(llm.createLlmClient).mockReturnValue({
      chat: async (params) => new Promise<string>((_resolve, reject) => {
        entered();
        params.abortSignal!.addEventListener("abort", () => reject(params.abortSignal!.reason), { once: true });
      }),
    } as llm.LlmClient);
    vi.mocked(ingest.extractSource).mockImplementation(async (...args) => {
      if (sourceFilename(args[0], args[1]) === "b/README.md") {
        await args[4]!.llm!.chat({ system: "test", prompt: "blocked", label: "analysis:b" });
      }
      return extract(...args);
    });
    expect(f.service.sync("service", "team", f.wikiId).kind).toBe("ok");
    await waiting;
    await vi.waitFor(() => expect(f.service.analysisProgress("service", f.wikiId)?.completed).toBe(1));
    expect(f.service.pause("service", f.wikiId)).toMatchObject({ internal_status: "pausing" });
    await f.service.onIdle(f.wikiId);
    expect(f.current()).toMatchObject({ ingest_status: "paused", active_version: null });
    expect(f.service.listVersions("service", f.wikiId)?.[0].state).toBe("paused");

    f.put("docs/a/README.md", "remote changed while paused");
    const remoteCommit = await f.commit();
    // 模拟重启：运行标记恢复为暂停，新服务和新引擎仅从磁盘检查点恢复。
    f.store.updateWikiStatus("service", f.wikiId, { status: "processing", ingest_status: "processing" });
    f.store.markInterruptedAsFailed();
    expect(f.current().ingest_status).toBe("paused");
    const manager = createWikiSourceManager(join(f.root, "manager"));
    const resumed = new WikiService({ store: f.store, dataRoot: join(f.root, "data"), wikiManager: manager,
      worker: async (ctx) => {
        manager.init({ name: ctx.wikiId, path: ctx.dir });
        await manager.ingest(ctx.wikiId, {}, { version: ctx.version, gitSource: ctx.gitSource,
          sourceBaseline: ctx.sourceBaseline, signal: ctx.signal, sourceSnapshot: ctx.sourceSnapshot, saveProgress: ctx.setProgress });
        return { pageCount: manager.getPages(ctx.wikiId).length };
      },
    });
    vi.mocked(ingest.extractSource).mockImplementation(extract);
    vi.mocked(llm.createLlmClient).mockReturnValue({} as llm.LlmClient);
    extracted.length = 0;
    expect(resumed.resume("service", "team", f.wikiId).kind).toBe("ok");
    await resumed.onIdle(f.wikiId);
    expect(extracted).toEqual(["b/README.md"]);
    expect(f.current()).toMatchObject({ ingest_status: "idle", active_version: 2 });
    expect(f.metadata().commit_hash).toBe(f.firstCommit);
    expect(resumed.analysisProgress("service", f.wikiId)).toMatchObject({ completed: 2, cached: 1, percent: 100 });
    expect(resumed.rawRead("service", "team", f.wikiId, "a/README.md")).toBe("alpha");
    expect(resumed.sync("service", "team", f.wikiId).kind).toBe("ok");
    await resumed.onIdle(f.wikiId);
    expect(f.metadata().commit_hash).toBe(remoteCommit);
  });
});
