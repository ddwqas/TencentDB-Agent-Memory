import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import { getPanelSession } from '../panelSession';

const BASE = '/api/v1/migration';

export type MigrationObjectKind = 'skill' | 'wiki' | 'code_graph';

export interface MigrationCatalogItem {
  kind: MigrationObjectKind;
  id: string;
  name: string;
  owner_user_id: string;
  visibility: string;
  status: string;
}

export interface MigrationPackageObject {
  key: string;
  kind: MigrationObjectKind;
  source_id: string;
  source_name: string;
  archive_path: string;
  size: number;
  sha256: string;
  proposed_name?: string;
}

export interface MigrationManifest {
  schema: 'tdai-runtime-migration';
  version: 1;
  created_at: string;
  source_instance_id: string;
  objects: MigrationPackageObject[];
  export_failures?: Array<{ key: string; kind: MigrationObjectKind; source_id: string; error: string }>;
  excludes: string[];
}

export interface MigrationJob {
  job_id: string;
  status: 'queued' | 'running' | 'completed' | 'completed_with_errors' | 'failed';
  total: number;
  processed: number;
  imported: number;
  failed: number;
  report_id?: string;
  error?: string;
}

export interface MigrationObjectResult {
  key: string;
  kind: MigrationObjectKind;
  source_id: string;
  source_name: string;
  status: 'imported' | 'failed' | 'skipped';
  target_id?: string;
  target_name?: string;
  error?: string;
}

export interface MigrationReport {
  report_id: string;
  job_id: string;
  started_at: string;
  completed_at: string;
  results: MigrationObjectResult[];
  summary: { total: number; imported: number; failed: number; skipped: number };
}

interface Envelope<T> {
  code: number;
  message: string;
  request_id?: string;
  data: T;
}

function sessionHeaders(contentType = 'application/json'): Record<string, string> {
  const session = getPanelSession();
  if (!session) throw new Error('No active Panel session');
  return {
    'Content-Type': contentType,
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  };
}

async function parseEnvelope<T>(response: Response): Promise<T> {
  const text = await response.text();
  let env: Envelope<T>;
  try {
    env = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new Error(text || response.statusText || 'Migration request failed');
  }
  if (!response.ok || env.code !== 0) throw new Error(env.message || `Migration request failed (${env.code})`);
  return env.data;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return parseEnvelope<T>(await fetch(`${BASE}${path}`, {
    method: 'POST', headers: sessionHeaders(), body: JSON.stringify(body),
  }));
}

export async function readMigrationManifest(file: File): Promise<MigrationManifest> {
  const reader = new ZipReader(new BlobReader(file));
  try {
    const entries = await reader.getEntries();
    const entry = entries.find((item) => item.filename === 'manifest.json' && !item.directory);
    if (!entry || !('getData' in entry)) throw new Error('ZIP does not contain manifest.json');
    if ((entry.uncompressedSize ?? 0) > 2 * 1024 * 1024) throw new Error('Migration manifest is too large');
    const text = await entry.getData(new TextWriter());
    const manifest = JSON.parse(text) as MigrationManifest;
    if (manifest.schema !== 'tdai-runtime-migration' || manifest.version !== 1 || !Array.isArray(manifest.objects)) {
      throw new Error('Unsupported migration package');
    }
    return manifest;
  } finally {
    await reader.close();
  }
}

export const migrationApi = {
  catalog(teamId: string): Promise<{ items: MigrationCatalogItem[]; total: number }> {
    return post('/catalog', { team_id: teamId });
  },

  preflight(teamId: string, manifest: MigrationManifest): Promise<{
    objects: MigrationPackageObject[];
    export_failures: MigrationManifest['export_failures'];
    append_only: true;
    imports_agents: false;
  }> {
    return post('/preflight', { team_id: teamId, manifest });
  },

  async export(teamId: string, objects: Array<{ kind: MigrationObjectKind; id: string }>): Promise<{ blob: Blob; filename: string }> {
    const response = await fetch(`${BASE}/export`, {
      method: 'POST', headers: sessionHeaders(), body: JSON.stringify({ team_id: teamId, objects }),
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/zip')) {
      await parseEnvelope<never>(response);
      throw new Error('Migration export failed');
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    return {
      blob: await response.blob(),
      filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? `tdai-migration-${Date.now()}.zip`,
    };
  },

  async import(teamId: string, file: File, objectKeys?: string[]): Promise<MigrationJob> {
    const query = new URLSearchParams({ team_id: teamId });
    if (objectKeys?.length) query.set('object_keys', objectKeys.join(','));
    return parseEnvelope<MigrationJob>(await fetch(`${BASE}/import?${query.toString()}`, {
      method: 'POST', headers: sessionHeaders('application/zip'), body: file,
    }));
  },

  getJob(jobId: string): Promise<MigrationJob> {
    return post('/job/get', { job_id: jobId });
  },

  getReport(reportId: string): Promise<MigrationReport> {
    return post('/report/get', { report_id: reportId });
  },
};
