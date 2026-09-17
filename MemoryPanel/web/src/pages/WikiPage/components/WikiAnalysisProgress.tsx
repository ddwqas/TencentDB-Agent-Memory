/** Wiki 列表与详情共用的业务进度：文档计数、当前文件和更新时间。 */
import { Progress } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { wikiStageLabel, type WikiDetail } from '@/lib/api/knowledge-api';

export function WikiAnalysisProgress({ wiki, compact = false }: { wiki: WikiDetail; compact?: boolean }) {
  const { t } = useTranslation();
  const analysis = wiki.analysis ?? wiki.progress;
  const running = wiki.ingest_status === 'pending' || wiki.ingest_status === 'processing';
  const paused = wiki.ingest_status === 'paused';
  const failed = wiki.ingest_status === 'failed';
  if (!analysis && !running && !paused && !failed) return null;

  const stage = paused ? t('wiki.analysis.paused') : failed ? t('wiki.analysis.failedState')
    : !running ? t('wiki.analysis.complete')
      : wiki.internal_status === 'fetching' || wiki.internal_status === 'pausing'
        ? wikiStageLabel('processing', wiki.internal_status)
        : analysis ? t(`wiki.analysis.phase.${analysis.phase}`) : t('wiki.analysis.waitingProgress');
  const done = analysis ? analysis.completed + analysis.failed : 0;
  const percent = analysis?.total ? Math.min(100, (done / analysis.total) * 100) : running ? 0 : 100;
  const remaining = analysis ? Math.max(0, analysis.total - done) : 0;
  const currentFiles = running ? analysis?.current_files ?? [] : [];
  const stats = analysis ? [
    { label: t('wiki.analysis.completedCount'), value: analysis.completed },
    { label: t('wiki.analysis.failedCount'), value: analysis.failed },
    { label: t('wiki.analysis.remainingCount'), value: remaining },
    { label: t('wiki.analysis.skippedCount'), value: analysis.skipped },
    { label: t('wiki.analysis.cachedCount'), value: analysis.cached ?? 0 },
  ] : [];

  return (
    <section className={`_wiki-analysis-progress${compact ? ' _wiki-analysis-progress--compact' : ''}`} aria-label={t('wiki.analysis.progressTitle')}>
      <div className="_wiki-analysis-progress-heading">
        <span>{stage}</span>
        {analysis && <strong>{t('wiki.analysis.documentCount', { done, total: analysis.total })}</strong>}
      </div>
      {analysis ? <>
        <Progress percent={Number(percent.toFixed(2))} />
        <div className="_wiki-analysis-progress-stats">
          {stats.map((stat) => <span key={stat.label}>{stat.label} <strong>{stat.value}</strong></span>)}
        </div>
        {currentFiles.length > 0 && <div className="_wiki-analysis-current-files">
          <span>{t('wiki.analysis.currentFiles', { count: currentFiles.length })}</span>
          <ul>{currentFiles.map((filename) => <li key={filename} title={filename}>{filename}</li>)}</ul>
        </div>}
        {analysis.updated_at && <time dateTime={analysis.updated_at} className="_wiki-analysis-updated">
          {t('wiki.analysis.updatedAt', { time: new Date(analysis.updated_at).toLocaleString() })}
        </time>}
      </> : <span>{paused ? t('wiki.analysis.pausedHint') : t('wiki.analysis.waitingProgress')}</span>}
      {failed && wiki.sync_error && <div className="_wiki-detail-ingest-log-error">{wiki.sync_error}</div>}
    </section>
  );
}
