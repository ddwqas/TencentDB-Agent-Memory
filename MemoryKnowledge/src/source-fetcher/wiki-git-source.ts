/** Wiki 的 Git 文档配置、固定提交快照与差异统计；不执行知识分析。 */
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import simpleGit from "simple-git";
import { GitSourceFetcher } from "./git-fetcher.js";
import { sha256, type SourceStatus } from "../engines/wiki/index-db.js";

export const WIKI_GIT_MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface WikiGitConfig {
  repo_url: string;
  branch: string;
  docs_path: string;
}

export interface WikiGitProvenance extends WikiGitConfig {
  commit_hash: string;
}

export interface WikiGitSyncReport {
  commit_hash: string;
  checked_at: string;
  total: number;
  added: number;
  modified: number;
  deleted: number;
  skipped: number;
  retried: number;
  failed: number;
  no_changes: boolean;
  failures: Array<{ filename: string; error: string }>;
}

export interface WikiGitMetadata extends WikiGitConfig {
  commit_hash: string | null;
  last_sync: WikiGitSyncReport | null;
}

export interface WikiGitFile {
  filename: string;
  content: string;
  size: number;
  sha256: string;
}

/** 继续分析固定的原文快照，不在恢复操作中拉取新的远程提交。 */
export function readWikiGitSnapshot(directory: string, prefix = ""): WikiGitFile[] {
  const files: WikiGitFile[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const filename = prefix + entry.name;
    if (entry.isDirectory()) files.push(...readWikiGitSnapshot(path, `${filename}/`));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      const content = readFileSync(path, "utf8");
      files.push({ filename, content, sha256: sha256(content), size: Buffer.byteLength(content, "utf8") });
    }
  }
  return files;
}

export function normalizeWikiGitConfig(config: WikiGitConfig): WikiGitConfig {
  const repoUrl = config.repo_url.trim();
  new GitSourceFetcher().validate(repoUrl);
  const url = new URL(repoUrl);
  if (url.password || (url.username && url.protocol !== "ssh:")) {
    throw new Error("use the server's Git credentials instead of credentials in repo_url");
  }
  const branch = config.branch.trim();
  if (!branch || branch.startsWith("-") || /[\s\x00-\x1f]/.test(branch)) {
    throw new Error("a valid Git branch is required");
  }
  const directory = config.docs_path.trim().replace(/\\/g, "/");
  if (directory.startsWith("/") || directory.includes(":") || /[\x00-\x1f]/.test(directory)
      || directory.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")) {
    throw new Error("docs_path must be a directory relative to the repository root");
  }
  const docsPath = directory.split("/").filter((part) => part && part !== ".").join("/");
  return { repo_url: repoUrl, branch, docs_path: docsPath };
}

/** 配置存入已有 metadata_json，旧 Wiki 无需数据库迁移。 */
export function readWikiGitMetadata(metadataJson: string): WikiGitMetadata | null {
  try {
    const git = JSON.parse(metadataJson).git as WikiGitMetadata | undefined;
    return git && typeof git.repo_url === "string" && typeof git.branch === "string"
      && typeof git.docs_path === "string" ? git : null;
  } catch {
    return null;
  }
}

export function writeWikiGitMetadata(metadataJson: string, git: WikiGitMetadata): string {
  return JSON.stringify({ ...JSON.parse(metadataJson), git });
}

/** 只枚举当前提交跟踪的普通 Markdown 文件；缓存由同一 Wiki 的串行队列独占。 */
export async function readGitMarkdown(repoRoot: string, commit: string, docsPath: string, allowDeletedDirectory = false): Promise<WikiGitFile[]> {
  const git = simpleGit(repoRoot);
  const tree = await git.raw(["ls-tree", "-r", "-z", "--full-tree", commit]);
  const entries = tree.split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    return { mode: entry.slice(0, 6), path: entry.slice(tab + 1) };
  });
  const prefix = docsPath ? `${docsPath}/` : "";
  const scoped = entries.filter((entry) => entry.path.startsWith(prefix));
  if (docsPath && scoped.length === 0 && !allowDeletedDirectory) {
    throw new Error(`document directory not found in Git commit: ${docsPath}`);
  }
  const base = realpathSync(repoRoot);
  const files: WikiGitFile[] = [];
  for (const entry of scoped) {
    if (!/\.md$/i.test(entry.path)) continue;
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      throw new Error(`Markdown source must be a regular file: ${entry.path}`);
    }
    const filename = entry.path.slice(prefix.length);
    const full = resolve(repoRoot, entry.path);
    if (!full.startsWith(resolve(repoRoot) + sep) || lstatSync(full).isSymbolicLink()
        || !realpathSync(full).startsWith(base + sep)) {
      throw new Error(`document path escapes repository: ${entry.path}`);
    }
    const size = lstatSync(full).size;
    if (size > WIKI_GIT_MAX_FILE_BYTES) {
      throw new Error(`document exceeds 5 MiB: ${entry.path} (${size} bytes)`);
    }
    const content = readFileSync(full, "utf-8");
    const contentSize = Buffer.byteLength(content, "utf-8");
    if (contentSize > WIKI_GIT_MAX_FILE_BYTES) throw new Error(`document exceeds 5 MiB: ${entry.path}`);
    files.push({ filename, content, size: contentSize, sha256: sha256(content) });
  }
  return files;
}

/** Git 更新只发生在专用缓存；确认完整提交及全部文档后再交给 Wiki。 */
export async function fetchWikiGitSnapshot(config: WikiGitConfig, cacheDir: string, allowDeletedDirectory = false): Promise<{ source: WikiGitProvenance; files: WikiGitFile[] }> {
  const fetcher = new GitSourceFetcher();
  await simpleGit().raw(["check-ref-format", "--branch", config.branch]);
  if (existsSync(join(cacheDir, ".git"))) await fetcher.sync(config.repo_url, config.branch, cacheDir);
  else await fetcher.fetch(config.repo_url, config.branch, cacheDir);
  const commit = (await simpleGit(cacheDir).revparse(["HEAD"])).trim();
  const files = await readGitMarkdown(cacheDir, commit, config.docs_path, allowDeletedDirectory);
  if (files.length === 0 && !allowDeletedDirectory) throw new Error("no Markdown documents found in the configured Git directory");
  return { source: { ...config, commit_hash: commit }, files };
}

/** 差异以生效版本为准；已拉取但未发布的提交不会推进分析基线。 */
export function compareWikiGitFiles(files: WikiGitFile[], baseline: Map<string, { sha256: string; status: SourceStatus }>, commit: string): WikiGitSyncReport {
  const report: WikiGitSyncReport = {
    commit_hash: commit, checked_at: new Date().toISOString(), total: files.length,
    added: 0, modified: 0, deleted: 0, skipped: 0, retried: 0, failed: 0,
    no_changes: false, failures: [],
  };
  const names = new Set(files.map((file) => file.filename));
  for (const filename of baseline.keys()) if (!names.has(filename)) report.deleted++;
  for (const file of files) {
    const old = baseline.get(file.filename);
    if (!old) report.added++;
    else if (old.sha256 !== file.sha256) report.modified++;
    else if (old.status !== "ingested") report.retried++;
    else report.skipped++;
  }
  report.no_changes = report.added + report.modified + report.deleted + report.retried === 0;
  return report;
}
