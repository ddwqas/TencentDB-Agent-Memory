/** 原文选择、按目录筛选、独立同步和确认清理；分析本身由现有后台任务执行。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Input, Select, Text } from 'tea-component';
import { knowledgeApi, type WikiDetail, type WikiDocument, type WikiDocumentList } from '@/lib/api/knowledge-api';
import { tea } from '@/lib/tea-bridge';
import { documentDirectories, filterDocuments, selectDocuments } from '../utils/document-selection';

const PAGE_SIZE = 50;

export function WikiDocumentsPanel({ wiki, refreshKey, active, onChanged }: {
  wiki: WikiDetail; refreshKey: number; active: boolean; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [listing, setListing] = useState<WikiDocumentList>({ items: [], total: 0, completed: 0, deleted: 0 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [directory, setDirectory] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [working, setWorking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ filename: string; content: string } | null>(null);
  const busy = working || wiki.ingest_status === 'pending' || wiki.ingest_status === 'processing';

  const reload = useCallback(async () => {
    const result = await knowledgeApi.wiki.documents(wiki.wiki_id);
    setListing(result);
    setError('');
    const names = new Set(result.items.map((file) => file.filename));
    setSelected((previous) => new Set([...previous].filter((name) => names.has(name))));
  }, [wiki.wiki_id]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    const read = async () => {
      try { const result = await knowledgeApi.wiki.documents(wiki.wiki_id); if (!cancelled) { setListing(result); setError(''); } }
      catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); }
      finally { if (!cancelled) setLoading(false); }
    };
    void read();
    const timer = window.setInterval(() => void read(), 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [wiki.wiki_id, wiki.ingest_status, refreshKey, active]);
  useEffect(() => { setPage(1); }, [query, directory, status]);
  const filtered = useMemo(() => filterDocuments(listing.items, query, directory, status), [listing.items, query, directory, status]);
  const directories = useMemo(() => documentDirectories(listing.items), [listing.items]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const chosen = listing.items.filter((file) => selected.has(file.filename));
  const analyzeNames = chosen.filter((file) => file.status !== 'deleted').map((file) => file.filename);
  const deletedNames = chosen.filter((file) => file.status === 'deleted').map((file) => file.filename);
  const toggle = (files: WikiDocument[], checked = true) => setSelected((previous) => selectDocuments(previous, files.map((file) => file.filename), checked));

  const act = async (operation: () => Promise<void>) => {
    if (busy) return;
    setWorking(true);
    try { await operation(); await reload(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); tea.notify.error(e); }
    finally { setWorking(false); }
  };
  const analyze = async (force = false) => {
    if (!analyzeNames.length || busy) return;
    if (wiki.selection_resumable && !await tea.confirm({ message: t('wiki.documents.replaceTask') })) return;
    if (force && !await tea.confirm({ message: t('wiki.documents.forceConfirm', { count: analyzeNames.length }), description: t('wiki.documents.forceHint') })) return;
    await act(async () => {
      await knowledgeApi.wiki.analyze(wiki.wiki_id, { filenames: analyzeNames, force });
      setSelected((previous) => selectDocuments(previous, analyzeNames, false));
      tea.notify.success(t('wiki.documents.started', { count: analyzeNames.length }));
    });
  };
  const cleanup = async () => {
    if (!deletedNames.length || busy) return;
    if (wiki.selection_resumable && !await tea.confirm({ message: t('wiki.documents.replaceTask') })) return;
    if (!await tea.confirm({ message: t('wiki.documents.cleanupConfirm', { count: deletedNames.length }),
      description: t('wiki.documents.cleanupHint') })) return;
    await act(async () => {
      await knowledgeApi.wiki.analyze(wiki.wiki_id, { filenames: [], deleted_filenames: deletedNames });
      setSelected((previous) => selectDocuments(previous, deletedNames, false));
    });
  };

  return <section className="_wiki-documents" aria-label={t('wiki.documents.title')}>
    <Alert type="info">{t('wiki.documents.hint')}</Alert>
    <div className="_wiki-documents-summary">{t('wiki.documents.overall', { total: listing.total, completed: listing.completed, deleted: listing.deleted })}</div>
    <div className="_wiki-documents-toolbar">
      <Input value={query} onChange={setQuery} placeholder={t('wiki.documents.search')} />
      <Select value={directory} onChange={setDirectory} options={[
        { value: '', text: t('wiki.documents.allDirectories') },
        ...directories.map((value) => ({ value, text: value })),
      ]} />
      <Select value={status} onChange={setStatus} options={['all', 'pending-work', 'pending', 'changed', 'processing', 'completed', 'failed', 'deleted'].map((value) => ({ value, text: t(`wiki.documents.status.${value}`) }))} />
      <Button disabled={busy} onClick={() => toggle(listing.items.filter((file) => ['pending', 'changed', 'failed'].includes(file.status)))}>{t('wiki.documents.selectPending')}</Button>
      <Button disabled={busy} onClick={() => toggle(listing.items.filter((file) => file.status === 'failed'))}>{t('wiki.documents.selectFailed')}</Button>
      <Button disabled={busy || !directory} onClick={() => toggle(listing.items.filter((file) => file.filename.startsWith(directory + '/')))}>{t('wiki.documents.selectDirectory')}</Button>
    </div>
    <div className="_wiki-documents-toolbar">
      <Text>{t('wiki.documents.selected', { count: chosen.length })}</Text>
      <Button disabled={busy} onClick={() => toggle(filtered)}>{t('wiki.documents.selectFiltered', { count: filtered.length })}</Button>
      <Button disabled={busy || selected.size === 0} onClick={() => setSelected(new Set())}>{t('wiki.documents.clear')}</Button>
      <Button type="primary" disabled={busy || !analyzeNames.length} onClick={() => void analyze()}>{t('wiki.documents.analyze', { count: analyzeNames.length })}</Button>
      <Button disabled={busy || !analyzeNames.length} onClick={() => void analyze(true)}>{t('wiki.documents.force')}</Button>
      <Button disabled={busy || !deletedNames.length} onClick={() => void cleanup()}>{t('wiki.documents.cleanup', { count: deletedNames.length })}</Button>
      {wiki.source_type === 'git' && <Button disabled={busy} onClick={() => void act(async () => {
        await knowledgeApi.wiki.syncDocuments(wiki.wiki_id);
        tea.notify.info(t('wiki.documents.syncStarted'));
      })}>{t('wiki.documents.syncOnly')}</Button>}
    </div>
    {error && <Alert type="error">{error}</Alert>}
    {!error && wiki.sync_error && <Alert type="error">{wiki.sync_error}</Alert>}
    {loading ? <Text>{t('wiki.detail.rawFiles.loading')}</Text> : <div className="_wiki-documents-table-wrap">
      <table className="_wiki-documents-table">
        <thead><tr><th><label><input type="checkbox" disabled={busy || !visible.length}
          checked={visible.length > 0 && visible.every((file) => selected.has(file.filename))}
          onChange={(e) => toggle(visible, e.target.checked)} /> {t('wiki.documents.selectPage')}</label></th>
          <th>{t('wiki.documents.path')}</th><th>{t('wiki.documents.state')}</th><th>{t('wiki.documents.size')}</th></tr></thead>
        <tbody>{visible.map((file) => <tr key={file.filename}>
          <td><input aria-label={file.filename} type="checkbox" disabled={busy} checked={selected.has(file.filename)} onChange={(e) => toggle([file], e.target.checked)} /></td>
          <td><Button type="link" disabled={file.status === 'deleted'} onClick={() => {
            void knowledgeApi.wiki.rawRead(wiki.wiki_id, [file.filename]).then((result) => {
              if (result.items[0]?.not_found) throw new Error(t('wiki.documents.notFound'));
              setPreview({ filename: file.filename, content: result.items[0]?.content ?? '' });
            }).catch((e) => tea.notify.error(e));
          }}>{file.filename}</Button>{file.error && <div className="_wiki-detail-ingest-log-error">{file.error}</div>}</td>
          <td>{t(`wiki.documents.status.${file.status}`)}</td><td>{(file.size / 1024).toFixed(1)} KiB</td>
        </tr>)}</tbody>
      </table>
      {!filtered.length && <Text>{t('wiki.documents.empty')}</Text>}
    </div>}
    <div className="_wiki-documents-toolbar">
      <Button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>{t('wiki.documents.previous')}</Button>
      <Text>{t('wiki.documents.pagination', { page: currentPage, pages: pageCount, count: filtered.length })}</Text>
      <Button disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>{t('wiki.documents.next')}</Button>
    </div>
    {preview && <div className="_wiki-document-preview"><strong>{preview.filename}</strong>
      <Button onClick={() => setPreview(null)}>{t('common.close')}</Button><pre>{preview.content}</pre></div>}
  </section>;
}
