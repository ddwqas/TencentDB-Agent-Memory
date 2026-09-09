import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Alert, Button, Card, StatusTip } from 'tea-component';
import { useTranslation } from 'react-i18next';

import { ResourcePage } from '@/pages/ResourcePage';
import { useTeams } from '@/stores/backend';
import { tea } from '@/lib/tea-bridge';
import {
  migrationApi,
  readMigrationManifest,
  type MigrationCatalogItem,
  type MigrationJob,
  type MigrationObjectKind,
  type MigrationPackageObject,
  type MigrationReport,
} from '@/lib/api/migration';
import './migration-page.css';

const KIND_LABEL: Record<MigrationObjectKind, string> = {
  skill: 'Skill', wiki: 'Wiki', code_graph: 'Code Graph',
};

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function isTerminal(job: MigrationJob): boolean {
  return job.status === 'completed' || job.status === 'completed_with_errors' || job.status === 'failed';
}

async function waitForJob(jobId: string, onUpdate: (job: MigrationJob) => void): Promise<MigrationJob> {
  for (;;) {
    const job = await migrationApi.getJob(jobId);
    onUpdate(job);
    if (isTerminal(job)) return job;
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
}

export function MigrationPage() {
  const { t } = useTranslation();
  const { activeTeamId, activeTeam } = useTeams();
  const inputRef = useRef<HTMLInputElement>(null);
  const retryKeysRef = useRef<string[] | null>(null);
  const [catalog, setCatalog] = useState<MigrationCatalogItem[]>([]);
  const [selectedExport, setSelectedExport] = useState<Set<string>>(new Set());
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [preflight, setPreflight] = useState<MigrationPackageObject[]>([]);
  const [selectedImport, setSelectedImport] = useState<Set<string>>(new Set());
  const [packageFailures, setPackageFailures] = useState<Array<{ key: string; error: string }>>([]);
  const [importing, setImporting] = useState(false);
  const [job, setJob] = useState<MigrationJob | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);

  useEffect(() => {
    setCatalog([]);
    setSelectedExport(new Set());
    setImportFile(null);
    setPreflight([]);
    setReport(null);
    if (!activeTeamId) return;
    setLoadingCatalog(true);
    migrationApi.catalog(activeTeamId)
      .then((result) => setCatalog(result.items))
      .catch((err) => tea.notify.error(err))
      .finally(() => setLoadingCatalog(false));
  }, [activeTeamId]);

  const grouped = useMemo(() => ({
    skill: catalog.filter((item) => item.kind === 'skill'),
    wiki: catalog.filter((item) => item.kind === 'wiki'),
    code_graph: catalog.filter((item) => item.kind === 'code_graph'),
  }), [catalog]);

  const toggleExport = (key: string) => {
    setSelectedExport((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleExport = async () => {
    if (!activeTeamId || selectedExport.size === 0) return;
    setExporting(true);
    try {
      const objects = catalog
        .filter((item) => selectedExport.has(`${item.kind}:${item.id}`))
        .map((item) => ({ kind: item.kind, id: item.id }));
      const result = await migrationApi.export(activeTeamId, objects);
      saveBlob(result.blob, result.filename);
      tea.notify.success(t('migration.export.success', { count: objects.length }));
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setExporting(false);
    }
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !activeTeamId) return;
    try {
      const manifest = await readMigrationManifest(file);
      const result = await migrationApi.preflight(activeTeamId, manifest);
      const retryKeys = retryKeysRef.current;
      const allowed = retryKeys ? new Set(retryKeys) : null;
      setImportFile(file);
      setPreflight(result.objects);
      setSelectedImport(new Set(result.objects.filter((object) => !allowed || allowed.has(object.key)).map((object) => object.key)));
      setPackageFailures((result.export_failures ?? []).map((failure) => ({ key: failure.key, error: failure.error })));
      setJob(null);
      setReport(null);
      retryKeysRef.current = null;
    } catch (err) {
      tea.notify.error(err);
      setImportFile(null);
      setPreflight([]);
    }
  };

  const handleImport = async () => {
    if (!activeTeamId || !importFile || selectedImport.size === 0) return;
    setImporting(true);
    try {
      const accepted = await migrationApi.import(activeTeamId, importFile, [...selectedImport]);
      setJob(accepted);
      // The server discards its upload after processing; require a fresh file selection for every retry.
      setImportFile(null);
      if (inputRef.current) inputRef.current.value = '';
      const completed = await waitForJob(accepted.job_id, setJob);
      if (completed.report_id) setReport(await migrationApi.getReport(completed.report_id));
      if (completed.failed > 0 || completed.status === 'failed') tea.notify.warning(t('migration.import.partial'));
      else tea.notify.success(t('migration.import.success', { count: completed.imported }));
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setImporting(false);
    }
  };

  const retryFailed = () => {
    if (!report) return;
    retryKeysRef.current = report.results.filter((item) => item.status === 'failed').map((item) => item.key);
    inputRef.current?.click();
  };

  if (!activeTeamId) {
    return <ResourcePage><StatusTip status="empty" emptyText={t('migration.noTeam')} /></ResourcePage>;
  }

  return (
    <ResourcePage>
      <div className="_migration-page">
        <Card>
          <Card.Body>
            <h2>{t('migration.title')}</h2>
            <p className="_migration-muted">{t('migration.subtitle', { team: activeTeam?.name ?? activeTeamId })}</p>
            <Alert>{t('migration.scopeNotice')}</Alert>
          </Card.Body>
        </Card>

        <div className="_migration-columns">
          <Card>
            <Card.Body>
              <div className="_migration-section-title">
                <div><h3>{t('migration.export.title')}</h3><p>{t('migration.export.desc')}</p></div>
                <Button type="primary" loading={exporting} disabled={selectedExport.size === 0} onClick={handleExport}>
                  {t('migration.export.button', { count: selectedExport.size })}
                </Button>
              </div>
              {loadingCatalog ? <StatusTip status="loading" /> : catalog.length === 0 ? (
                <StatusTip status="empty" emptyText={t('migration.catalog.empty')} />
              ) : (Object.keys(grouped) as MigrationObjectKind[]).map((kind) => (
                <div className="_migration-kind" key={kind}>
                  <strong>{KIND_LABEL[kind]} ({grouped[kind].length})</strong>
                  {grouped[kind].map((item) => {
                    const key = `${item.kind}:${item.id}`;
                    return (
                      <label className="_migration-row" key={key}>
                        <input type="checkbox" checked={selectedExport.has(key)} onChange={() => toggleExport(key)} />
                        <span><b>{item.name}</b><small>{item.id}</small></span>
                      </label>
                    );
                  })}
                </div>
              ))}
            </Card.Body>
          </Card>

          <Card>
            <Card.Body>
              <div className="_migration-section-title">
                <div><h3>{t('migration.import.title')}</h3><p>{t('migration.import.desc')}</p></div>
                <Button onClick={() => inputRef.current?.click()}>{t('migration.import.choose')}</Button>
                <input ref={inputRef} type="file" accept=".zip,application/zip" hidden onChange={handleFile} />
              </div>
              {preflight.length > 0 ? (
                <>
                  <div className="_migration-file">{t('migration.import.file')}: {importFile?.name ?? t('migration.import.reselect')}</div>
                  {preflight.map((object) => (
                    <label className="_migration-row" key={object.key}>
                      <input
                        type="checkbox"
                        checked={selectedImport.has(object.key)}
                        disabled={!importFile || importing}
                        onChange={() => setSelectedImport((current) => {
                          const next = new Set(current);
                          if (next.has(object.key)) next.delete(object.key); else next.add(object.key);
                          return next;
                        })}
                      />
                      <span>
                        <b>{KIND_LABEL[object.kind]} · {object.source_name}</b>
                        <small>→ {object.proposed_name}</small>
                      </span>
                    </label>
                  ))}
                  {packageFailures.length > 0 && <Alert type="warning">{t('migration.packageFailures', { count: packageFailures.length })}</Alert>}
                  <Button type="primary" loading={importing} disabled={!importFile || selectedImport.size === 0} onClick={handleImport}>
                    {t('migration.import.button', { count: selectedImport.size })}
                  </Button>
                </>
              ) : <StatusTip status="empty" emptyText={t('migration.import.empty')} />}
            </Card.Body>
          </Card>
        </div>

        {job && (
          <Card>
            <Card.Body>
              <h3>{t('migration.job.title')}</h3>
              <div className="_migration-progress"><span style={{ width: `${job.total ? (job.processed / job.total) * 100 : 0}%` }} /></div>
              <p>{job.status} · {job.processed}/{job.total} · {t('migration.job.imported')} {job.imported} · {t('migration.job.failed')} {job.failed}</p>
              {job.error && <Alert type="error">{job.error}</Alert>}
            </Card.Body>
          </Card>
        )}

        {report && (
          <Card>
            <Card.Body>
              <div className="_migration-section-title">
                <h3>{t('migration.report.title')}</h3>
                {report.summary.failed > 0 && <Button onClick={retryFailed}>{t('migration.retry')}</Button>}
              </div>
              {report.results.map((result) => (
                <div className={`_migration-result _migration-result--${result.status}`} key={result.key}>
                  <b>{KIND_LABEL[result.kind]} · {result.source_name}</b>
                  <span>{result.status === 'imported' ? `→ ${result.target_name} (${result.target_id})` : result.error}</span>
                </div>
              ))}
              {report.summary.failed > 0 && <p className="_migration-muted">{t('migration.retryNotice')}</p>}
            </Card.Body>
          </Card>
        )}
      </div>
    </ResourcePage>
  );
}
