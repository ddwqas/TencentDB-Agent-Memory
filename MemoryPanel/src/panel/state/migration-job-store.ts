import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type MigrationObjectKind = 'skill' | 'wiki' | 'code_graph';
export type MigrationJobStatus = 'queued' | 'running' | 'completed' | 'completed_with_errors' | 'failed';

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
  schema: 'tdai-migration-report';
  version: 1;
  report_id: string;
  job_id: string;
  team_id: string;
  user_id: string;
  source_instance_id?: string;
  target_instance_id: string;
  started_at: string;
  completed_at: string;
  results: MigrationObjectResult[];
  summary: { total: number; imported: number; failed: number; skipped: number };
}

export interface MigrationJob {
  job_id: string;
  instance_id: string;
  team_id: string;
  user_id: string;
  status: MigrationJobStatus;
  created_at: string;
  updated_at: string;
  total: number;
  processed: number;
  imported: number;
  failed: number;
  report_id?: string;
  error?: string;
}

export class MigrationJobStore {
  private readonly jobs = new Map<string, MigrationJob>();
  readonly tempDir: string;
  readonly reportDir: string;

  constructor(rootDir: string, retentionDays: number) {
    this.tempDir = join(rootDir, 'tmp');
    this.reportDir = join(rootDir, 'reports');
    mkdirSync(this.tempDir, { recursive: true });
    mkdirSync(this.reportDir, { recursive: true });
    for (const name of readdirSync(this.tempDir)) {
      try { rmSync(join(this.tempDir, name), { recursive: true, force: true }); } catch { /* best effort */ }
    }
    this.cleanupReports(retentionDays);
  }

  create(instanceId: string, teamId: string, userId: string): MigrationJob {
    const now = new Date().toISOString();
    const job: MigrationJob = {
      job_id: `migjob-${randomUUID()}`,
      instance_id: instanceId, team_id: teamId, user_id: userId,
      status: 'queued', created_at: now, updated_at: now,
      total: 0, processed: 0, imported: 0, failed: 0,
    };
    this.jobs.set(job.job_id, job);
    return { ...job };
  }

  patch(jobId: string, patch: Partial<Omit<MigrationJob, 'job_id' | 'created_at'>>): MigrationJob | null {
    const current = this.jobs.get(jobId);
    if (!current) return null;
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    this.jobs.set(jobId, next);
    return { ...next };
  }

  get(jobId: string): MigrationJob | null {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  saveReport(report: Omit<MigrationReport, 'report_id'>): MigrationReport {
    const result: MigrationReport = { ...report, report_id: `migrep-${randomUUID()}` };
    writeFileSync(join(this.reportDir, `${result.report_id}.json`), JSON.stringify(result, null, 2), 'utf8');
    return result;
  }

  getReport(reportId: string): MigrationReport | null {
    if (!/^migrep-[A-Za-z0-9-]+$/.test(reportId)) return null;
    const path = join(this.reportDir, `${reportId}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as MigrationReport;
    } catch {
      return null;
    }
  }

  private cleanupReports(retentionDays: number): void {
    const cutoff = Date.now() - Math.max(1, retentionDays) * 86_400_000;
    for (const name of readdirSync(this.reportDir)) {
      if (!/^migrep-[A-Za-z0-9-]+\.json$/.test(name)) continue;
      const path = join(this.reportDir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
      } catch {
        // Best-effort retention cleanup must not prevent Panel startup.
      }
    }
  }
}
