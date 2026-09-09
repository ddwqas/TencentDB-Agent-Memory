import archiver from 'archiver';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Hono } from 'hono';
import unzipper from 'unzipper';

import type { PanelDeps } from '../../panel-deps.js';
import type { MetaEnvelope } from '../../kernel/envelope.js';
import { toKernelCredentials, type MetaCallContext } from '../../kernel/types.js';
import type {
  CodeGraphDetail,
  KnowledgeSnapshotKind,
  WikiDetail,
} from '../../kernel/ports/knowledge-client-port.js';
import type {
  MigrationObjectKind,
  MigrationObjectResult,
} from '../../state/migration-job-store.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import {
  ASSET_TYPE_CODE_GRAPH,
  ASSET_TYPE_WIKI,
  buildCtx,
  checkAssetPermission,
  deleteKnowledgeCascade,
  ensureKnowledgeAsset,
  fetchAllMetaListItems,
  isActiveMetaAsset,
  okEnvelope,
  readJson,
  requireTeamMember,
  str,
  type KnowledgeAssetMetaRaw,
} from './knowledge/common.js';

const PACKAGE_SCHEMA = 'tdai-runtime-migration';
const PACKAGE_VERSION = 1;
const SKILL_ASSET_TYPE = 'skill';
const MAX_OBJECTS = 500;
const MAX_SKILL_FILES = 101;
const MAX_SKILL_FILE_BYTES = 256 * 1024 * 1024;
const MAX_SKILL_EXPANDED_BYTES = 512 * 1024 * 1024;

interface MigrationPackageObject {
  key: string;
  kind: MigrationObjectKind;
  source_id: string;
  source_name: string;
  archive_path: string;
  size: number;
  sha256: string;
  metadata?: Record<string, unknown>;
}

interface MigrationPackageManifest {
  schema: typeof PACKAGE_SCHEMA;
  version: typeof PACKAGE_VERSION;
  created_at: string;
  source_instance_id: string;
  objects: MigrationPackageObject[];
  export_failures?: Array<{ key: string; kind: MigrationObjectKind; source_id: string; error: string }>;
  excludes: ['agent', 'agent_memory', 'chat_memory', 'task', 'asset_binding'];
}

interface CatalogItem {
  kind: MigrationObjectKind;
  id: string;
  name: string;
  owner_user_id: string;
  visibility: string;
  status: string;
}

interface SkillExportData {
  zip_base64: string;
  filename: string;
  name: string;
  version: number;
  file_count: number;
  total_bytes: number;
  warnings?: string[];
}

interface SkillCreateData {
  skill_id: string;
  name: string;
}

function isKind(value: unknown): value is MigrationObjectKind {
  return value === 'skill' || value === 'wiki' || value === 'code_graph';
}

function kindAssetType(kind: MigrationObjectKind): string {
  if (kind === 'skill') return SKILL_ASSET_TYPE;
  return kind === 'wiki' ? ASSET_TYPE_WIKI : ASSET_TYPE_CODE_GRAPH;
}

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100) || 'asset';
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 2000);
}

function hashBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function spoolReadable(source: Readable, path: string, maxBytes: number): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(size > maxBytes ? new Error('migration object exceeds configured size limit') : null, chunk);
    },
  });
  await pipeline(source, limiter, createWriteStream(path, { flags: 'wx' }));
  return { size, sha256: hash.digest('hex') };
}

async function zipDirectory(sourceDir: string, targetZip: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(targetZip, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.once('close', resolvePromise);
    output.once('error', reject);
    archive.once('error', reject);
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });
    archive.pipe(output);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });
}

function parseManifest(value: unknown): MigrationPackageManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest must be an object');
  const raw = value as Partial<MigrationPackageManifest>;
  if (raw.schema !== PACKAGE_SCHEMA || raw.version !== PACKAGE_VERSION || !Array.isArray(raw.objects)) {
    throw new Error('unsupported migration package');
  }
  if (raw.objects.length > MAX_OBJECTS) throw new Error(`migration package exceeds ${MAX_OBJECTS} objects`);
  const paths = new Set<string>();
  const keys = new Set<string>();
  for (const object of raw.objects) {
    if (!object || !isKind(object.kind) || typeof object.key !== 'string' || typeof object.source_id !== 'string'
      || typeof object.source_name !== 'string' || typeof object.archive_path !== 'string'
      || typeof object.sha256 !== 'string' || typeof object.size !== 'number') {
      throw new Error('invalid migration object descriptor');
    }
    const normalized = normalize(object.archive_path).replace(/\\/g, '/');
    if (!normalized.startsWith(`objects/${object.kind}/`) || normalized.includes('../') || normalized.startsWith('/')) {
      throw new Error(`unsafe migration object path: ${object.archive_path}`);
    }
    if (paths.has(normalized) || keys.has(object.key)) throw new Error('duplicate migration object path or key');
    object.archive_path = normalized;
    paths.add(normalized);
    keys.add(object.key);
  }
  return raw as MigrationPackageManifest;
}

function uniqueName(baseValue: string, used: Set<string>, maxLength = 64): string {
  const base = (baseValue.trim() || 'Imported asset').slice(0, maxLength);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; n < 10_000; n++) {
    const suffix = `（导入 ${n}）`;
    const candidate = `${base.slice(0, Math.max(1, maxLength - suffix.length))}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error('unable to allocate import name');
}

/**
 * Skill frontmatter names are portable slugs (`^[a-z0-9][a-z0-9-]*$`), so
 * the human-facing `（导入 N）` suffix used by Wiki and Code Graph cannot be
 * written into SKILL.md. Keep imported Skills valid by using its ASCII
 * equivalent while retaining the same collision numbering semantics.
 */
function uniqueSkillName(baseValue: string, used: Set<string>, maxLength = 64): string {
  const base = (baseValue.trim() || 'imported-skill').slice(0, maxLength);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-import-${n}`;
    const stem = base.slice(0, Math.max(1, maxLength - suffix.length)).replace(/-+$/g, '');
    const candidate = `${stem}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error('unable to allocate a unique skill name');
}

function rewriteSkillName(content: string, name: string): string {
  if (!content.startsWith('---')) throw new Error('SKILL.md frontmatter is missing');
  const end = content.indexOf('\n---', 3);
  if (end < 0) throw new Error('SKILL.md frontmatter is invalid');
  const head = content.slice(0, end);
  if (!/^name\s*:/m.test(head)) throw new Error('SKILL.md frontmatter.name is missing');
  return `${head.replace(/^name\s*:.*$/m, `name: ${JSON.stringify(name)}`)}${content.slice(end)}`;
}

type ZipEntry = Awaited<ReturnType<typeof unzipper.Open.file>>['files'][number];

function isSymlink(entry: ZipEntry): boolean {
  const mode = Number(entry.externalFileAttributes ?? 0) >>> 16;
  return (mode & 0o170000) === 0o120000;
}

async function readSkillSnapshot(path: string, targetName: string): Promise<{
  content: string;
  resources: Array<{ path: string; content: string; encoding: 'base64'; is_executable: boolean }>;
}> {
  const zip = await unzipper.Open.file(path);
  const files = zip.files.filter((entry) => entry.type === 'File');
  if (files.length === 0 || files.length > MAX_SKILL_FILES) throw new Error('skill snapshot has an invalid file count');
  let expanded = 0;
  for (const entry of files) {
    if (isSymlink(entry)) throw new Error(`skill snapshot symlink rejected: ${entry.path}`);
    const size = Number(entry.uncompressedSize ?? 0);
    if (size > MAX_SKILL_FILE_BYTES) throw new Error(`skill snapshot file is too large: ${entry.path}`);
    expanded += size;
    if (expanded > MAX_SKILL_EXPANDED_BYTES) throw new Error('skill snapshot expanded size is too large');
    const normalized = normalize(entry.path).replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../')) {
      throw new Error(`unsafe skill snapshot path: ${entry.path}`);
    }
  }
  const skillEntry = files.find((entry) => entry.path.replace(/\\/g, '/').endsWith('/SKILL.md'))
    ?? files.find((entry) => entry.path.replace(/\\/g, '/') === 'SKILL.md');
  if (!skillEntry) throw new Error('skill snapshot does not contain SKILL.md');
  const skillPath = skillEntry.path.replace(/\\/g, '/');
  const root = skillPath.slice(0, -'SKILL.md'.length);
  const content = rewriteSkillName((await skillEntry.buffer()).toString('utf8'), targetName);
  const resources = [] as Array<{ path: string; content: string; encoding: 'base64'; is_executable: boolean }>;
  for (const entry of files) {
    if (entry === skillEntry) continue;
    const normalized = entry.path.replace(/\\/g, '/');
    if (root && !normalized.startsWith(root)) throw new Error('skill snapshot contains multiple roots');
    const rel = root ? normalized.slice(root.length) : normalized;
    if (!rel || rel === 'SKILL.md') continue;
    const mode = Number(entry.externalFileAttributes ?? 0) >>> 16;
    resources.push({ path: rel, content: (await entry.buffer()).toString('base64'), encoding: 'base64', is_executable: (mode & 0o111) !== 0 });
  }
  return { content, resources };
}

async function catalogForTeam(deps: PanelDeps, ctx: MetaCallContext, teamId: string, userId: string): Promise<CatalogItem[]> {
  const types: Array<[MigrationObjectKind, string]> = [
    ['skill', SKILL_ASSET_TYPE], ['wiki', ASSET_TYPE_WIKI], ['code_graph', ASSET_TYPE_CODE_GRAPH],
  ];
  const groups = await Promise.all(types.map(async ([kind, assetType]) => {
    const assets = await fetchAllMetaListItems<KnowledgeAssetMetaRaw>(deps, ctx, 'asset/list-accessible', {
      user_id: userId, team_id: teamId, asset_type: assetType, action: 'read',
    });
    return assets.filter((asset) => isActiveMetaAsset(asset.status)).map((asset): CatalogItem => ({
      kind, id: asset.asset_id, name: asset.name, owner_user_id: asset.owner_user_id,
      visibility: asset.visibility, status: asset.status,
    }));
  }));
  return groups.flat();
}

async function readableAsset(
  deps: PanelDeps,
  ctx: MetaCallContext,
  teamId: string,
  userId: string,
  kind: MigrationObjectKind,
  id: string,
): Promise<KnowledgeAssetMetaRaw> {
  const env = await deps.metaKernel.invoke('asset/get', { asset_id: id }, ctx);
  if (env.code !== 0 || !env.data) throw new Error('asset not found');
  const asset = env.data as KnowledgeAssetMetaRaw;
  if (asset.team_id !== teamId || asset.asset_type !== kindAssetType(kind) || !isActiveMetaAsset(asset.status)) {
    throw new Error('asset does not belong to the requested team or kind');
  }
  if (!(await checkAssetPermission(deps, ctx, userId, id, 'read'))) throw new Error('asset is not readable');
  return asset;
}

async function syncKnowledgeDetail(
  deps: PanelDeps,
  ctx: MetaCallContext,
  kind: KnowledgeSnapshotKind,
  detail: WikiDetail | CodeGraphDetail,
  userId: string,
): Promise<void> {
  const cred = toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true });
  const isWiki = kind === 'wiki';
  const wiki = isWiki ? detail as WikiDetail : null;
  const graph = !isWiki ? detail as CodeGraphDetail : null;
  const serviceUrl = wiki?.service_url ?? graph?.service_url;
  if (!serviceUrl) throw new Error('imported knowledge service_url is missing');
  const env = await deps.kernelHttp.postEnvelope('/v3/knowledge/create', {
    knowledge_id: wiki?.wiki_id ?? graph?.code_graph_id,
    type: isWiki ? 'wiki' : 'code-graph',
    service_url: serviceUrl,
    name: wiki?.name ?? graph?.repo_name ?? graph?.repo_url,
    summary: wiki?.summary ?? graph?.summary ?? '',
    team_id: detail.team_id,
    user_id: userId,
    ...(graph ? { repo_url: graph.repo_url, branch: graph.branch } : {}),
  }, cred);
  if (env.code !== 0) throw new Error(`knowledge detail registration failed: ${env.message ?? env.code}`);
}

async function importSkill(
  deps: PanelDeps,
  ctx: MetaCallContext,
  teamId: string,
  userId: string,
  object: MigrationPackageObject,
  archivePath: string,
  usedNames: Set<string>,
  sourceInstanceId: string,
): Promise<SkillCreateData> {
  let name = uniqueSkillName(object.source_name, usedNames);
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = await readSkillSnapshot(archivePath, name);
    const env = await deps.skillKernel.invoke('create', {
      user_id: userId,
      team_id: teamId,
      owner_scope: 'team',
      name,
      content: snapshot.content,
      resources: snapshot.resources,
      metadata: {
        migration_origin: {
          source_instance_id: sourceInstanceId,
          source_id: object.source_id,
          source_name: object.source_name,
          exported_at: object.metadata?.exported_at,
        },
      },
    }, ctx) as MetaEnvelope<SkillCreateData>;
    if (env.code === 0 && env.data) return env.data;
    if (!/(exist|unique|duplicate|conflict|already)/i.test(env.message ?? '')) {
      throw new Error(env.message || `skill import failed (${env.code})`);
    }
    name = uniqueSkillName(object.source_name, usedNames);
  }
  throw new Error('unable to allocate a unique skill name');
}

async function runImportJob(
  deps: PanelDeps,
  ctx: MetaCallContext,
  packagePath: string,
  jobTempRoot: string,
  jobId: string,
  teamId: string,
  userId: string,
  selectedKeys?: Set<string>,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const results: MigrationObjectResult[] = [];
  try {
    const outer = await unzipper.Open.file(packagePath);
    const manifestEntries = outer.files.filter((entry) => entry.type === 'File' && entry.path.replace(/\\/g, '/') === 'manifest.json');
    if (manifestEntries.length !== 1) throw new Error('migration package must contain one manifest.json');
    const manifestEntry = manifestEntries[0]!;
    if (Number(manifestEntry.uncompressedSize ?? 0) > 2 * 1024 * 1024) throw new Error('migration manifest is too large');
    const manifest = parseManifest(JSON.parse((await manifestEntry.buffer()).toString('utf8')) as unknown);
    const objects = selectedKeys ? manifest.objects.filter((object) => selectedKeys.has(object.key)) : manifest.objects;
    deps.migrationJobStore.patch(jobId, { status: 'running', total: objects.length });

    const catalog = await catalogForTeam(deps, ctx, teamId, userId);
    const usedSkillNames = new Set(catalog.filter((item) => item.kind === 'skill').map((item) => item.name));
    const kc = deps.knowledgeClientFactory(ctx.instanceId);

    for (let index = 0; index < objects.length; index++) {
      const object = objects[index]!;
      const base: MigrationObjectResult = {
        key: object.key, kind: object.kind, source_id: object.source_id,
        source_name: object.source_name, status: 'failed',
      };
      const nestedPath = join(jobTempRoot, `object-${index}-${safePart(object.source_id)}.zip`);
      try {
        const entry = outer.files.find((candidate) => candidate.type === 'File' && candidate.path.replace(/\\/g, '/') === object.archive_path);
        if (!entry || isSymlink(entry)) throw new Error('object archive is missing or unsafe');
        const actual = await spoolReadable(entry.stream(), nestedPath, deps.config.migration.maxUploadBytes);
        if (actual.size !== object.size || actual.sha256.toLowerCase() !== object.sha256.toLowerCase()) {
          throw new Error('object archive checksum mismatch');
        }

        if (object.kind === 'skill') {
          const created = await importSkill(deps, ctx, teamId, userId, object, nestedPath, usedSkillNames, manifest.source_instance_id);
          results.push({ ...base, status: 'imported', target_id: created.skill_id, target_name: created.name });
        } else {
          const detail = await kc.snapshotImport(object.kind, nestedPath, {
            teamId, userId, preferredName: object.source_name,
            provenance: { source_instance_id: manifest.source_instance_id, package_created_at: manifest.created_at },
          });
          const assetId = object.kind === 'wiki' ? (detail as WikiDetail).wiki_id : (detail as CodeGraphDetail).code_graph_id;
          const targetName = object.kind === 'wiki'
            ? (detail as WikiDetail).name
            : ((detail as CodeGraphDetail).repo_name || (detail as CodeGraphDetail).repo_url);
          try {
            const registration = await ensureKnowledgeAsset(deps, ctx, {
              assetId, teamId,
              assetType: object.kind === 'wiki' ? ASSET_TYPE_WIKI : ASSET_TYPE_CODE_GRAPH,
              name: targetName, ownerUserId: userId, serviceUrl: detail.service_url,
            });
            if (!registration.ok) throw new Error(registration.env.message || 'asset registration failed');
            await syncKnowledgeDetail(deps, ctx, object.kind, detail, userId);
          } catch (err) {
            await deleteKnowledgeCascade(deps, ctx, [assetId]);
            if (object.kind === 'wiki') await kc.wikiDelete([assetId]);
            else await kc.codeGraphDelete([assetId]);
            throw err;
          }
          results.push({ ...base, status: 'imported', target_id: assetId, target_name: targetName });
        }
      } catch (err) {
        results.push({ ...base, error: errorText(err) });
      } finally {
        rmSync(nestedPath, { force: true });
      }
      const imported = results.filter((result) => result.status === 'imported').length;
      const failed = results.filter((result) => result.status === 'failed').length;
      deps.migrationJobStore.patch(jobId, { processed: results.length, imported, failed });
    }

    const imported = results.filter((result) => result.status === 'imported').length;
    const failed = results.filter((result) => result.status === 'failed').length;
    const skipped = results.filter((result) => result.status === 'skipped').length;
    const report = deps.migrationJobStore.saveReport({
      schema: 'tdai-migration-report', version: 1, job_id: jobId,
      team_id: teamId, user_id: userId, source_instance_id: manifest.source_instance_id,
      target_instance_id: ctx.instanceId, started_at: startedAt, completed_at: new Date().toISOString(),
      results, summary: { total: results.length, imported, failed, skipped },
    });
    deps.migrationJobStore.patch(jobId, {
      status: failed > 0 ? 'completed_with_errors' : 'completed', report_id: report.report_id,
      total: results.length, processed: results.length, imported, failed,
    });
  } catch (err) {
    deps.migrationJobStore.patch(jobId, { status: 'failed', error: errorText(err) });
  } finally {
    rmSync(jobTempRoot, { recursive: true, force: true });
  }
}

export function registerMigrationRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  api.post('/migration/catalog', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const items = await catalogForTeam(deps, ctx, teamId, gate.userId);
    return respondEnvelope(c, okEnvelope(c, { items, total: items.length }));
  });

  api.post('/migration/preflight', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    let manifest: MigrationPackageManifest;
    try {
      manifest = parseManifest(body.manifest);
    } catch (err) {
      return respondControlError(c, 400, errorText(err));
    }
    const catalog = await catalogForTeam(deps, ctx, teamId, gate.userId);
    const used = new Map<MigrationObjectKind, Set<string>>([
      ['skill', new Set(catalog.filter((item) => item.kind === 'skill').map((item) => item.name))],
      ['wiki', new Set(catalog.filter((item) => item.kind === 'wiki').map((item) => item.name))],
      ['code_graph', new Set(catalog.filter((item) => item.kind === 'code_graph').map((item) => item.name))],
    ]);
    const objects = manifest.objects.map((object) => ({
      ...object,
      proposed_name: object.kind === 'skill'
        ? uniqueSkillName(object.source_name, used.get(object.kind)!, 64)
        : uniqueName(object.source_name, used.get(object.kind)!, 255),
    }));
    return respondEnvelope(c, okEnvelope(c, {
      manifest: { source_instance_id: manifest.source_instance_id, created_at: manifest.created_at },
      objects,
      export_failures: manifest.export_failures ?? [],
      append_only: true,
      imports_agents: false,
    }));
  });

  api.post('/migration/export', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const selections = Array.isArray(body.objects) ? body.objects : [];
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (selections.length === 0 || selections.length > MAX_OBJECTS) return respondControlError(c, 400, 'INVALID_OBJECT_SELECTION');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;

    const tempRoot = mkdtempSync(join(deps.migrationJobStore.tempDir, 'export-'));
    const packageDir = join(tempRoot, 'package');
    const objects: MigrationPackageObject[] = [];
    const failures: MigrationPackageManifest['export_failures'] = [];
    try {
      for (const raw of selections) {
        const kind = raw && typeof raw === 'object' ? (raw as { kind?: unknown }).kind : undefined;
        const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
        if (!isKind(kind) || typeof id !== 'string' || !id) {
          failures.push({ key: `invalid:${objects.length + failures.length}`, kind: 'skill', source_id: '', error: 'invalid object selection' });
          continue;
        }
        const key = `${kind}:${id}`;
        try {
          const asset = await readableAsset(deps, ctx, teamId, gate.userId, kind, id);
          const relPath = `objects/${kind}/${safePart(id)}.zip`;
          const target = join(packageDir, ...relPath.split('/'));
          mkdirSync(dirname(target), { recursive: true });
          let size: number;
          let sha256: string;
          let sourceName = asset.name;
          let metadata: Record<string, unknown> | undefined;
          if (kind === 'skill') {
            const env = await deps.skillKernel.invoke('export', {
              user_id: gate.userId, team_id: teamId, skill_id: id, format: 'zip',
            }, ctx) as MetaEnvelope<SkillExportData>;
            if (env.code !== 0 || !env.data) throw new Error(env.message || `skill export failed (${env.code})`);
            const zip = Buffer.from(env.data.zip_base64, 'base64');
            if (zip.length > deps.config.migration.maxUploadBytes) throw new Error('skill export exceeds configured size limit');
            writeFileSync(target, zip, { flag: 'wx' });
            size = zip.length;
            sha256 = hashBuffer(zip);
            sourceName = env.data.name;
            metadata = { version: env.data.version, warnings: env.data.warnings ?? [] };
          } else {
            const download = await deps.knowledgeClientFactory(ctx.instanceId).snapshotExport(kind, id);
            const spooled = await spoolReadable(download.stream, target, deps.config.migration.maxUploadBytes);
            if (download.sha256 && download.sha256.toLowerCase() !== spooled.sha256.toLowerCase()) {
              throw new Error('knowledge snapshot checksum mismatch');
            }
            size = spooled.size;
            sha256 = spooled.sha256;
          }
          objects.push({ key, kind, source_id: id, source_name: sourceName, archive_path: relPath, size, sha256, metadata });
        } catch (err) {
          failures.push({ key, kind, source_id: id, error: errorText(err) });
        }
      }
      if (objects.length === 0) {
        rmSync(tempRoot, { recursive: true, force: true });
        return respondControlError(c, 422, 'NO_EXPORTABLE_OBJECTS');
      }
      const manifest: MigrationPackageManifest = {
        schema: PACKAGE_SCHEMA, version: PACKAGE_VERSION, created_at: new Date().toISOString(),
        source_instance_id: ctx.instanceId, objects, export_failures: failures,
        excludes: ['agent', 'agent_memory', 'chat_memory', 'task', 'asset_binding'],
      };
      writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
      const zipPath = join(tempRoot, `tdai-migration-${safePart(ctx.instanceId)}-${Date.now()}.zip`);
      await zipDirectory(packageDir, zipPath);
      const size = statSync(zipPath).size;
      const sha256 = await hashFile(zipPath);
      const source = createReadStream(zipPath);
      let cleaned = false;
      const cleanup = () => { if (!cleaned) { cleaned = true; rmSync(tempRoot, { recursive: true, force: true }); } };
      source.once('end', cleanup); source.once('close', cleanup); source.once('error', cleanup);
      return new Response(Readable.toWeb(source) as ReadableStream<Uint8Array>, {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${basename(zipPath)}"`,
          'Content-Length': String(size),
          'X-Tdai-Package-Sha256': sha256,
          'X-Tdai-Exported-Objects': String(objects.length),
          'X-Tdai-Export-Failures': String(failures.length),
        },
      });
    } catch (err) {
      rmSync(tempRoot, { recursive: true, force: true });
      throw err;
    }
  });

  api.post('/migration/import', mw, async (c) => {
    const ctx = buildCtx(c);
    const teamId = c.req.query('team_id')?.trim();
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    if (!c.req.raw.body) return respondControlError(c, 400, 'MISSING_MIGRATION_PACKAGE');
    const declared = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > deps.config.migration.maxUploadBytes) {
      return respondControlError(c, 413, 'MIGRATION_PACKAGE_TOO_LARGE');
    }

    const jobTempRoot = mkdtempSync(join(deps.migrationJobStore.tempDir, 'import-'));
    const packagePath = join(jobTempRoot, 'package.zip');
    try {
      await spoolReadable(
        Readable.fromWeb(c.req.raw.body as ReadableStream<Uint8Array>),
        packagePath,
        deps.config.migration.maxUploadBytes,
      );
    } catch (err) {
      rmSync(jobTempRoot, { recursive: true, force: true });
      return respondControlError(c, 400, errorText(err));
    }
    const retryKeysRaw = c.req.query('object_keys');
    const selectedKeys = retryKeysRaw
      ? new Set(retryKeysRaw.split(',').map((key) => key.trim()).filter(Boolean))
      : undefined;
    const job = deps.migrationJobStore.create(ctx.instanceId, teamId, gate.userId);
    void runImportJob(deps, ctx, packagePath, jobTempRoot, job.job_id, teamId, gate.userId, selectedKeys);
    return c.json(okEnvelope(c, job), 202);
  });

  api.post('/migration/job/get', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const jobId = str(body, 'job_id');
    if (!jobId) return respondControlError(c, 400, 'MISSING_JOB_ID');
    const job = deps.migrationJobStore.get(jobId);
    if (!job || job.instance_id !== ctx.instanceId) return respondControlError(c, 404, 'MIGRATION_JOB_NOT_FOUND');
    const gate = await requireTeamMember(deps, c, ctx, job.team_id);
    if ('error' in gate) return gate.error;
    if (gate.userId !== job.user_id) return respondControlError(c, 403, 'FORBIDDEN');
    return respondEnvelope(c, okEnvelope(c, job));
  });

  api.post('/migration/report/get', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const reportId = str(body, 'report_id');
    if (!reportId) return respondControlError(c, 400, 'MISSING_REPORT_ID');
    const report = deps.migrationJobStore.getReport(reportId);
    if (!report || report.target_instance_id !== ctx.instanceId) return respondControlError(c, 404, 'MIGRATION_REPORT_NOT_FOUND');
    const gate = await requireTeamMember(deps, c, ctx, report.team_id);
    if ('error' in gate) return gate.error;
    if (gate.userId !== report.user_id) return respondControlError(c, 403, 'FORBIDDEN');
    return respondEnvelope(c, okEnvelope(c, report));
  });
}
