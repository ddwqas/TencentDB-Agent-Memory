/**
 * Append-only Wiki version storage.
 *
 * A build is prepared below pages/<version-key>/ and becomes visible only after
 * active-version.json is atomically replaced. Published and failed generations
 * are never removed; deleting the whole Wiki is the sole hard-delete path.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export type WikiVersionState = "building" | "published" | "failed";

export interface WikiVersionManifest {
  schema_version: 1;
  version: number;
  version_key: string;
  state: WikiVersionState;
  base_version: number | null;
  base_version_key: string | null;
  index_file: string | null;
  page_count: number;
  summary: string | null;
  size_bytes: number;
  created_at: string;
  published_at: string | null;
  failed_at: string | null;
  error: string | null;
  reason: "ingest" | "manual" | "legacy-migration";
}

export interface ActiveWikiVersion {
  schema_version: 1;
  version: number;
  version_key: string;
  index_file: string;
  activated_at: string;
}

export interface WikiBuildGeneration {
  root: string;
  versionDir: string;
  versionKey: string;
  version: number;
  manifest: WikiVersionManifest;
}

export interface WikiVersionItem extends WikiVersionManifest {
  active: boolean;
}

const ACTIVE_FILE = "active-version.json";
const MANIFEST_FILE = "manifest.json";

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

function versionKey(version: number): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `v-${stamp}-${version}-${randomUUID().slice(0, 8)}`;
}

function directorySize(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else {
      try { total += statSync(full).size; } catch { /* best effort */ }
    }
  }
  return total;
}

function copyTree(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
}

function assertInside(root: string, candidate: string): void {
  const base = resolve(root);
  const path = resolve(candidate);
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (path !== base && !path.startsWith(prefix)) {
    throw new Error(`version path escapes wiki root: ${candidate}`);
  }
}

export function activeVersionPath(root: string): string {
  return join(root, ACTIVE_FILE);
}

export function sourceStateDbPath(root: string): string {
  return join(root, "source-state.db");
}

export function getActiveVersion(root: string): ActiveWikiVersion | null {
  const active = readJson<ActiveWikiVersion>(activeVersionPath(root));
  if (!active || active.schema_version !== 1) return null;
  if (!Number.isInteger(active.version) || !active.version_key || !active.index_file) return null;
  const versionDir = join(root, "pages", active.version_key);
  const indexPath = join(root, active.index_file);
  assertInside(root, versionDir);
  assertInside(root, indexPath);
  if (!existsSync(join(versionDir, MANIFEST_FILE)) || !existsSync(indexPath)) return null;
  return active;
}

export function getVersionDir(root: string, key: string): string {
  const dir = join(root, "pages", key);
  assertInside(root, dir);
  return dir;
}

export function getActiveVersionDir(root: string): string | null {
  const active = getActiveVersion(root);
  return active ? getVersionDir(root, active.version_key) : null;
}

export function getActiveIndexPath(root: string): string | null {
  const active = getActiveVersion(root);
  return active ? join(root, active.index_file) : null;
}

/** Create an isolated build with immutable snapshots of current inputs and pages. */
export function beginWikiBuild(
  root: string,
  version: number,
  reason: WikiVersionManifest["reason"] = "ingest",
): WikiBuildGeneration {
  mkdirSync(join(root, "pages"), { recursive: true });
  const active = getActiveVersion(root);
  const key = versionKey(version);
  const versionDir = getVersionDir(root, key);
  mkdirSync(join(versionDir, "pending", "sources"), { recursive: true });

  // Snapshot first. Uploads arriving after this point remain in root/raw and are
  // intentionally picked up by the next ingest batch.
  copyTree(join(root, "raw", "sources"), join(versionDir, "pending", "sources"));
  copyTree(join(versionDir, "pending", "sources"), join(versionDir, "raw", "sources"));
  if (active) {
    copyTree(join(getVersionDir(root, active.version_key), "wiki"), join(versionDir, "wiki"));
  }

  const createdAt = new Date().toISOString();
  const manifest: WikiVersionManifest = {
    schema_version: 1,
    version,
    version_key: key,
    state: "building",
    base_version: active?.version ?? null,
    base_version_key: active?.version_key ?? null,
    index_file: null,
    page_count: 0,
    summary: null,
    size_bytes: directorySize(versionDir),
    created_at: createdAt,
    published_at: null,
    failed_at: null,
    error: null,
    reason,
  };
  atomicWriteJson(join(versionDir, MANIFEST_FILE), manifest);
  return { root, versionDir, versionKey: key, version, manifest };
}

/** Publish a fully closed candidate index. The pointer is deliberately written last. */
export function publishWikiBuild(
  build: WikiBuildGeneration,
  candidateIndexPath: string,
  pageCount: number,
): WikiVersionManifest {
  if (!existsSync(candidateIndexPath)) throw new Error(`candidate index missing: ${candidateIndexPath}`);
  const indexFile = `index-v${build.version}.db`;
  const publishedIndex = join(build.root, indexFile);
  if (existsSync(publishedIndex)) {
    throw new Error(`version index already exists: ${indexFile}`);
  }
  copyFileSync(candidateIndexPath, publishedIndex, 0);

  const publishedAt = new Date().toISOString();
  const manifest: WikiVersionManifest = {
    ...build.manifest,
    state: "published",
    index_file: indexFile,
    page_count: pageCount,
    size_bytes: directorySize(build.versionDir) + statSync(publishedIndex).size,
    published_at: publishedAt,
    failed_at: null,
    error: null,
  };
  atomicWriteJson(join(build.versionDir, MANIFEST_FILE), manifest);
  atomicWriteJson(activeVersionPath(build.root), {
    schema_version: 1,
    version: build.version,
    version_key: build.versionKey,
    index_file: indexFile,
    activated_at: publishedAt,
  } satisfies ActiveWikiVersion);
  return manifest;
}

export function failWikiBuild(build: WikiBuildGeneration, error: unknown): WikiVersionManifest {
  const manifest: WikiVersionManifest = {
    ...build.manifest,
    state: "failed",
    size_bytes: directorySize(build.versionDir),
    failed_at: new Date().toISOString(),
    error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
  };
  atomicWriteJson(join(build.versionDir, MANIFEST_FILE), manifest);
  return manifest;
}

export function listWikiVersions(root: string): WikiVersionItem[] {
  const active = getActiveVersion(root);
  const pagesDir = join(root, "pages");
  if (!existsSync(pagesDir)) return [];
  const versions: WikiVersionItem[] = [];
  for (const entry of readdirSync(pagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readJson<WikiVersionManifest>(join(pagesDir, entry.name, MANIFEST_FILE));
    if (!manifest || manifest.schema_version !== 1) continue;
    versions.push({ ...manifest, active: active?.version_key === manifest.version_key });
  }
  return versions.sort((a, b) => b.version - a.version || b.created_at.localeCompare(a.created_at));
}

export function updateWikiVersionSummary(root: string, version: number, summary: string | null): void {
  const target = listWikiVersions(root).find(
    (item) => item.version === version && item.state === "published",
  );
  if (!target) return;
  const { active: _active, ...manifest } = target;
  atomicWriteJson(join(getVersionDir(root, target.version_key), MANIFEST_FILE), {
    ...manifest,
    summary,
  } satisfies WikiVersionManifest);
}

export function activateWikiVersion(
  root: string,
  targetVersion: number,
  expectedActiveVersion?: number,
): WikiVersionManifest {
  const active = getActiveVersion(root);
  if (expectedActiveVersion !== undefined && active?.version !== expectedActiveVersion) {
    throw new Error(`active version changed: expected ${expectedActiveVersion}, actual ${active?.version ?? "none"}`);
  }
  const target = listWikiVersions(root).find(
    (item) => item.version === targetVersion && item.state === "published",
  );
  if (!target || !target.index_file) throw new Error(`published version not found: ${targetVersion}`);
  const indexPath = join(root, target.index_file);
  const versionDir = getVersionDir(root, target.version_key);
  if (!existsSync(indexPath) || !existsSync(join(versionDir, "wiki"))) {
    throw new Error(`version ${targetVersion} is incomplete`);
  }
  atomicWriteJson(activeVersionPath(root), {
    schema_version: 1,
    version: target.version,
    version_key: target.version_key,
    index_file: target.index_file,
    activated_at: new Date().toISOString(),
  } satisfies ActiveWikiVersion);
  return target;
}

/**
 * Import the pre-versioned wiki/index.db layout once. Original files are left in
 * place, and the active pointer is written only after the copied generation is valid.
 */
export function bootstrapLegacyWiki(root: string, preferredVersion = 0): ActiveWikiVersion | null {
  const existing = getActiveVersion(root);
  if (existing) return existing;

  const published = listWikiVersions(root).find(
    (item) => item.state === "published" && item.index_file && existsSync(join(root, item.index_file)),
  );
  if (published?.index_file) {
    atomicWriteJson(activeVersionPath(root), {
      schema_version: 1,
      version: published.version,
      version_key: published.version_key,
      index_file: published.index_file,
      activated_at: new Date().toISOString(),
    } satisfies ActiveWikiVersion);
    return getActiveVersion(root);
  }

  const legacyWiki = join(root, "wiki");
  const legacyIndex = join(root, "index.db");
  if (!existsSync(legacyWiki) || !existsSync(legacyIndex)) return null;

  let version = preferredVersion;
  while (existsSync(join(root, `index-v${version}.db`))) version++;
  const key = `v-legacy-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
  const versionDir = getVersionDir(root, key);
  copyTree(legacyWiki, join(versionDir, "wiki"));
  mkdirSync(join(versionDir, "pending", "sources"), { recursive: true });
  copyTree(join(root, "raw", "sources"), join(versionDir, "pending", "sources"));
  const indexFile = `index-v${version}.db`;
  copyFileSync(legacyIndex, join(root, indexFile), 0);
  const now = new Date().toISOString();
  const pageCount = countMarkdownFiles(join(versionDir, "wiki"));
  const manifest: WikiVersionManifest = {
    schema_version: 1,
    version,
    version_key: key,
    state: "published",
    base_version: null,
    base_version_key: null,
    index_file: indexFile,
    page_count: pageCount,
    summary: null,
    size_bytes: directorySize(versionDir) + statSync(join(root, indexFile)).size,
    created_at: now,
    published_at: now,
    failed_at: null,
    error: null,
    reason: "legacy-migration",
  };
  atomicWriteJson(join(versionDir, MANIFEST_FILE), manifest);
  atomicWriteJson(activeVersionPath(root), {
    schema_version: 1,
    version,
    version_key: key,
    index_file: indexFile,
    activated_at: now,
  } satisfies ActiveWikiVersion);
  return getActiveVersion(root);
}

function countMarkdownFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countMarkdownFiles(join(dir, entry.name));
    else if (entry.name.endsWith(".md")) count++;
  }
  return count;
}

/** Record every raw-file revision before the mutable intake copy changes. */
export function appendSourceHistory(
  root: string,
  filename: string,
  content: string | null,
  userId?: string,
): void {
  const now = new Date();
  const eventKey = `${now.toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID()}`;
  const eventDir = join(root, "source-history", eventKey);
  mkdirSync(eventDir, { recursive: true });
  const safeName = basename(filename);
  if (content !== null) writeFileSync(join(eventDir, safeName), content, "utf-8");
  atomicWriteJson(join(eventDir, MANIFEST_FILE), {
    schema_version: 1,
    event_key: eventKey,
    filename,
    operation: content === null ? "delete" : "write",
    content_file: content === null ? null : safeName,
    user_id: userId ?? null,
    created_at: now.toISOString(),
  });
}

/** Resolve an index storage reference without allowing it to escape the Wiki root. */
export function resolveStoredPage(root: string, storageKey: string, storageRelPath: string): string | null {
  const versionDir = getVersionDir(root, storageKey);
  const full = resolve(versionDir, storageRelPath);
  const prefix = resolve(versionDir) + sep;
  if (!full.startsWith(prefix)) return null;
  return full;
}

export function relativeStoredPath(versionDir: string, fullPath: string): string {
  return relative(versionDir, fullPath).replace(/\\/g, "/");
}
