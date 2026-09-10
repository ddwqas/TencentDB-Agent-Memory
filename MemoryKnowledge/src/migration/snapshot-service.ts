import archiver from "archiver";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { basename, dirname, join, normalize, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import unzipper from "unzipper";

import type { WikiSourceManager } from "../engines/wiki/index.js";
import { evictWikiDb } from "../engines/wiki/index-db.js";
import { bootstrapLegacyWiki, getVersionDir } from "../engines/wiki/version-store.js";
import type { CodeGraphInstancePool } from "../module.js";
import type { CodeGraphService, WikiService } from "../store/index.js";
import type { CodeGraphRow, IKnowledgeStore, WikiRow } from "../store/types.js";

export type SnapshotKind = "wiki" | "code_graph";

export interface SnapshotManifest {
  schema: "tdai-knowledge-snapshot";
  version: 1;
  kind: SnapshotKind;
  source_id: string;
  source_name: string;
  exported_at: string;
  metadata: Record<string, unknown>;
}

export interface SnapshotArtifact {
  path: string;
  filename: string;
  size: number;
  sha256: string;
  cleanup(): void;
}

export interface ImportSnapshotInput {
  kind: SnapshotKind;
  archivePath: string;
  serviceId: string;
  teamId: string;
  userId: string;
  preferredName?: string;
  publicBaseUrl?: string;
  provenance?: Record<string, unknown>;
}

const MAX_FILES = 200_000;
const MAX_EXPANDED_BYTES = 10 * 1024 * 1024 * 1024;
const BLOCKED_NAMES = new Set([
  ".git", ".env", ".env.local", ".env.production", ".npmrc", ".pypirc",
  "credentials", "credentials.json", "id_rsa", "id_ed25519",
]);

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 96) || "asset";
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

function isBlocked(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.some((part) => BLOCKED_NAMES.has(part.toLowerCase()) || part.toLowerCase().startsWith(".env."))
    || parts.some((part) => part.toLowerCase() === "node_modules" || part.toLowerCase() === ".runtime" || part.toLowerCase() === "_debug")
    || relPath.endsWith("-wal")
    || relPath.endsWith("-shm");
}

function copyTree(source: string, target: string, root = source): void {
  if (!existsSync(source)) return;
  const info = lstatSync(source);
  if (info.isSymbolicLink()) return;
  const rel = relative(root, source).replace(/\\/g, "/");
  if (rel && isBlocked(rel)) return;
  if (info.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name), root);
    return;
  }
  if (!info.isFile()) return;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function sqliteSnapshot(source: string, target: string): void {
  if (!existsSync(source)) throw new Error(`snapshot index missing: ${basename(source)}`);
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { force: true });
  const sourceDb = new Database(source, { readonly: false });
  try {
    const quoted = target.replace(/'/g, "''");
    sourceDb.exec(`VACUUM INTO '${quoted}'`);
  } finally {
    sourceDb.close();
  }
  const checkDb = new Database(target, { readonly: true });
  try {
    const result = checkDb.pragma("quick_check") as Array<{ quick_check?: string }>;
    const ok = result.every((row) => Object.values(row).every((value) => value === "ok"));
    if (!ok) throw new Error(`snapshot SQLite quick_check failed: ${basename(source)}`);
  } finally {
    checkDb.close();
  }
}

function validateSqlite(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma("quick_check") as Array<Record<string, unknown>>;
    const ok = result.length > 0 && result.every((row) => Object.values(row).every((value) => value === "ok"));
    if (!ok) throw new Error(`${label} failed SQLite quick_check`);
  } finally {
    db.close();
  }
}

async function zipDirectory(sourceDir: string, targetZip: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(targetZip);
    const zip = archiver("zip", { zlib: { level: 6 } });
    output.on("close", resolvePromise);
    output.on("error", reject);
    zip.on("warning", (err) => err.code === "ENOENT" ? undefined : reject(err));
    zip.on("error", reject);
    zip.pipe(output);
    zip.directory(sourceDir, false);
    void zip.finalize();
  });
}

function safeArchivePath(root: string, raw: string): string {
  const unix = raw.replace(/\\/g, "/");
  if (!unix || unix.startsWith("/") || /^[a-zA-Z]:/.test(unix)) throw new Error(`unsafe archive path: ${raw}`);
  const normalized = normalize(unix).replace(/\\/g, "/");
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`archive traversal rejected: ${raw}`);
  }
  const target = resolve(root, normalized);
  const base = resolve(root) + sep;
  if (target !== resolve(root) && !target.startsWith(base)) throw new Error(`archive path escaped root: ${raw}`);
  return target;
}

async function extractSafe(zipPath: string, target: string): Promise<void> {
  const archive = await unzipper.Open.file(zipPath);
  if (archive.files.length > MAX_FILES) throw new Error(`snapshot has too many files (${archive.files.length})`);
  let expanded = 0;
  for (const entry of archive.files) {
    const declared = Number(entry.uncompressedSize ?? 0);
    expanded += declared;
    if (expanded > MAX_EXPANDED_BYTES) throw new Error("snapshot expanded size exceeds limit");
    const outPath = safeArchivePath(target, entry.path);
    const unixMode = Number(entry.externalFileAttributes ?? 0) >>> 16;
    if ((unixMode & 0o170000) === 0o120000) throw new Error(`symbolic link rejected: ${entry.path}`);
    if (entry.type === "Directory") {
      mkdirSync(outPath, { recursive: true });
      continue;
    }
    if (entry.type !== "File") throw new Error(`unsupported archive entry: ${entry.path}`);
    mkdirSync(dirname(outPath), { recursive: true });
    await pipeline(entry.stream(), createWriteStream(outPath));
  }
}

function parseManifest(root: string): SnapshotManifest {
  const raw = JSON.parse(readFileSync(join(root, "metadata.json"), "utf8")) as SnapshotManifest;
  if (raw.schema !== "tdai-knowledge-snapshot" || raw.version !== 1) throw new Error("unsupported knowledge snapshot");
  if (raw.kind !== "wiki" && raw.kind !== "code_graph") throw new Error("invalid snapshot kind");
  return raw;
}

function uniqueName(baseName: string, names: Set<string>): string {
  if (!names.has(baseName)) return baseName;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${baseName}（导入 ${i}）`;
    if (!names.has(candidate)) return candidate;
  }
  throw new Error("unable to allocate import name");
}

export class KnowledgeSnapshotService {
  constructor(private readonly deps: {
    store: IKnowledgeStore;
    wikiService: WikiService;
    cgService: CodeGraphService;
    wikiMgr: WikiSourceManager;
    instancePool: CodeGraphInstancePool;
  }) {}

  async export(kind: SnapshotKind, serviceId: string, id: string): Promise<SnapshotArtifact> {
    const tempRoot = mkdtempSync(join(tmpdir(), "tdai-knowledge-export-"));
    try {
      const payloadDir = join(tempRoot, "payload");
      const dataDir = join(payloadDir, "data");
      mkdirSync(dataDir, { recursive: true });

      let manifest: SnapshotManifest;
      if (kind === "wiki") {
        const row = this.deps.wikiService.getById(serviceId, id);
        if (!row || row.status !== "ready") throw new Error("wiki is not ready or not found");
        evictWikiDb(id);
        const source = this.deps.wikiService.dirFor(row.service_id, row.team_id, row.wiki_id);
        const active = bootstrapLegacyWiki(source, row.active_version ?? row.version);
        if (!active) throw new Error("wiki has no published version");
        copyTree(join(source, "raw"), join(dataDir, "raw"));
        copyTree(join(getVersionDir(source, active.version_key), "wiki"), join(dataDir, "wiki"));
        // Materialize the complete logical view. An active index may reuse an
        // unchanged page from an older layer, which is not otherwise portable.
        for (const page of this.deps.wikiMgr.getPages(id)) {
          const target = safeArchivePath(dataDir, page.relPath);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, page.content, "utf8");
        }
        copyFileSync(join(source, active.index_file), join(dataDir, "index.db"));
        const portableIndex = new Database(join(dataDir, "index.db"));
        try {
          const columns = portableIndex.pragma("table_info(page_meta)") as Array<{ name: string }>;
          if (columns.some((column) => column.name === "storage_key")) {
            portableIndex.prepare("UPDATE page_meta SET storage_key = NULL, storage_rel_path = rel_path").run();
          }
        } finally {
          portableIndex.close();
        }
        validateSqlite(join(dataDir, "index.db"), "wiki index.db");
        manifest = {
          schema: "tdai-knowledge-snapshot", version: 1, kind, source_id: id,
          source_name: row.name, exported_at: new Date().toISOString(),
          metadata: {
            source_type: row.source_type, source_url: row.source_url, summary: row.summary,
            page_count: row.page_count, visibility: row.visibility, last_sync_at: row.last_sync_at,
          },
        };
      } else {
        const row = this.deps.cgService.getById(serviceId, id);
        if (!row || row.status !== "ready") throw new Error("code graph is not ready or not found");
        this.deps.cgService.releaseForSnapshot(id);
        const source = this.deps.cgService.dirFor(row.service_id, row.team_id, row.code_graph_id);
        copyTree(source, dataDir);
        const sourceIndex = join(source, ".codegraph", "codegraph.db");
        if (existsSync(sourceIndex)) sqliteSnapshot(sourceIndex, join(dataDir, ".codegraph", "codegraph.db"));
        manifest = {
          schema: "tdai-knowledge-snapshot", version: 1, kind, source_id: id,
          source_name: row.repo_name || row.repo_url, exported_at: new Date().toISOString(),
          metadata: {
            repo_name: row.repo_name, repo_url: row.repo_url, branch: row.branch,
            commit_hash: row.commit_hash, stats_json: row.stats_json, summary: row.summary,
            visibility: row.visibility, last_sync_at: row.last_sync_at,
          },
        };
      }
      writeFileSync(join(payloadDir, "metadata.json"), JSON.stringify(manifest, null, 2), "utf8");
      const zipPath = join(tempRoot, `${kind}-${safeSegment(id)}.zip`);
      await zipDirectory(payloadDir, zipPath);
      return {
        path: zipPath, filename: basename(zipPath), size: statSync(zipPath).size,
        sha256: await sha256File(zipPath), cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
      };
    } catch (err) {
      rmSync(tempRoot, { recursive: true, force: true });
      throw err;
    }
  }

  async import(input: ImportSnapshotInput): Promise<WikiRow | CodeGraphRow> {
    const tempRoot = mkdtempSync(join(tmpdir(), "tdai-knowledge-import-"));
    let created: WikiRow | CodeGraphRow | null = null;
    try {
      await extractSafe(input.archivePath, tempRoot);
      const manifest = parseManifest(tempRoot);
      if (manifest.kind !== input.kind) throw new Error("snapshot kind mismatch");
      const data = join(tempRoot, "data");
      const migration = JSON.stringify({
        migration_origin: {
          type: manifest.kind, source_id: manifest.source_id, source_name: manifest.source_name,
          exported_at: manifest.exported_at, ...input.provenance,
        },
      });

      if (input.kind === "wiki") {
        validateSqlite(join(data, "index.db"), "wiki index.db");
        const existing = this.deps.store.listWikis(input.serviceId, input.teamId, { limit: 100_000 });
        const name = uniqueName(input.preferredName || manifest.source_name, new Set(existing.map((row) => row.name)));
        const meta = manifest.metadata;
        created = this.deps.store.importWiki({
          service_id: input.serviceId, team_id: input.teamId, name,
          source_type: typeof meta.source_type === "string" ? meta.source_type : undefined,
          source_url: typeof meta.source_url === "string" ? meta.source_url : undefined,
          owner_user_id: input.userId, user_id: input.userId, visibility: "team",
          service_url: input.publicBaseUrl,
          page_count: typeof meta.page_count === "number" ? meta.page_count : null,
          summary: typeof meta.summary === "string" ? meta.summary : null,
          last_sync_at: typeof meta.last_sync_at === "string" ? meta.last_sync_at : null,
          metadata_json: migration,
        });
        const target = this.deps.wikiService.dirFor(input.serviceId, input.teamId, created.wiki_id);
        mkdirSync(dirname(target), { recursive: true });
        copyTree(data, target);
        const restored = this.deps.wikiMgr.restore({ name: created.wiki_id, path: target });
        this.deps.wikiMgr.setVersionSummary(created.wiki_id, restored.activeVersion ?? 0, created.summary);
        this.deps.store.updateWikiStatus(input.serviceId, created.wiki_id, {
          status: "ready",
          ingest_status: "idle",
          active_version: restored.activeVersion ?? 0,
          building_version: null,
          page_count: restored.pageCount ?? created.page_count,
        });
        created = this.deps.store.getWikiById(input.serviceId, created.wiki_id) ?? created;
        this.deps.store.appendWikiAudit({ service_id: input.serviceId, asset_id: created.wiki_id, version: created.version, action: "create", user_id: input.userId, detail: migration });
        return created;
      }

      const existing = this.deps.store.listCodeGraphs(input.serviceId, input.teamId, { limit: 100_000 });
      const meta = manifest.metadata;
      validateSqlite(join(data, ".codegraph", "codegraph.db"), "code graph index");
      const name = uniqueName(input.preferredName || manifest.source_name, new Set(existing.map((row) => row.repo_name || row.repo_url)));
      created = this.deps.store.importCodeGraph({
        service_id: input.serviceId, team_id: input.teamId,
        repo_name: name, repo_url: String(meta.repo_url ?? ""), branch: String(meta.branch ?? "main"),
        commit_hash: typeof meta.commit_hash === "string" ? meta.commit_hash : null,
        stats_json: typeof meta.stats_json === "string" ? meta.stats_json : null,
        summary: typeof meta.summary === "string" ? meta.summary : null,
        last_sync_at: typeof meta.last_sync_at === "string" ? meta.last_sync_at : null,
        owner_user_id: input.userId, user_id: input.userId, visibility: "team", metadata_json: migration,
        service_url: input.publicBaseUrl,
      });
      const target = this.deps.cgService.dirFor(input.serviceId, input.teamId, created.code_graph_id);
      mkdirSync(dirname(target), { recursive: true });
      copyTree(data, target);
      const loaded = await this.deps.instancePool.loadIfMissing?.(created.code_graph_id, target);
      if (!loaded) throw new Error("imported code graph index could not be opened");
      this.deps.store.appendCodeGraphAudit({ service_id: input.serviceId, asset_id: created.code_graph_id, version: created.version, action: "create", user_id: input.userId, detail: migration });
      return created;
    } catch (err) {
      if (created) {
        if ("wiki_id" in created) {
          this.deps.wikiMgr.remove(created.wiki_id);
          this.deps.wikiService.delete(input.serviceId, input.teamId, created.wiki_id);
        }
        else this.deps.cgService.delete(input.serviceId, input.teamId, created.code_graph_id);
      }
      throw err;
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

export function copySnapshotStream(path: string) {
  return createReadStream(path);
}
