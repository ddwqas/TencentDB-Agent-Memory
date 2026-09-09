/**
 * Knowledge HTTP 客户端 — 调 core 的 /v3/wiki/* 和 /v3/code-graph/*.
 *
 * 路径与请求体严格对齐 docs/knowledge/knowledge-api.yaml（07/08/11 定稿）。
 * 注：core router 实际监听 `/v3/wiki/*`、`/v3/code-graph/*`，
 * 故此处 baseUrl 不含 /v3，路径带 /v3 前缀。
 *
 * 与 HttpSkillClient 同模式：Bearer + service-id + envelope 解析。
 */
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { CoreUpstreamError } from '../../domain/errors.js';
import type {
  KnowledgeClientPort,
  WikiDetail,
  WikiListResult,
  WikiIngestResult,
  WikiGraphData,
  WikiSearchResult,
  BatchDeleteResult,
  RawFileEntry,
  PageEntry,
  WikiRawReadItem,
  WikiRawWriteFile,
  WikiRawWriteItem,
  WikiRawRmResult,
  WikiPageReadItem,
  WikiPageWriteItem,
  WikiPageWriteResultItem,
  WikiPageRmResult,
  CodeGraphDetail,
  CodeGraphListResult,
  CodeGraphSyncResult,
  CodeGraphToolResult,
  KnowledgeSnapshotKind,
  KnowledgeSnapshotDownload,
  KnowledgeSnapshotImportOptions,
} from '../ports/knowledge-client-port.js';

export interface KnowledgeClientConfig {
  baseUrl: string;
  authToken: string;
  serviceId?: string;
  timeoutMs?: number;
  migrationTimeoutMs?: number;
}

interface CoreEnvelope<T> {
  code: number;
  message?: string;
  request_id?: string;
  data?: T;
}

export class HttpKnowledgeClient implements KnowledgeClientPort {
  constructor(private readonly cfg: KnowledgeClientConfig) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 15_000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.cfg.authToken) headers.Authorization = `Bearer ${this.cfg.authToken}`;
      if (this.cfg.serviceId) headers['x-tdai-service-id'] = this.cfg.serviceId;
      const resp = await fetch(`${this.cfg.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const json = (await resp.json()) as CoreEnvelope<T>;
      if (json.code !== undefined && json.code !== 0) {
        throw new CoreUpstreamError(
          'CORE_UPSTREAM_ERROR',
          resp.status >= 400 ? resp.status : 502,
          json.message || `core error code ${json.code}`,
          json.code,
        );
      }
      if (!resp.ok) {
        throw new CoreUpstreamError('CORE_UPSTREAM_ERROR', resp.status, json.message || `HTTP ${resp.status}`, 0);
      }
      return json.data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(contentType: string): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': contentType };
    if (this.cfg.authToken) headers.Authorization = `Bearer ${this.cfg.authToken}`;
    if (this.cfg.serviceId) headers['x-tdai-service-id'] = this.cfg.serviceId;
    return headers;
  }

  private async upstreamError(resp: Response): Promise<never> {
    let message = `HTTP ${resp.status}`;
    let code = 0;
    try {
      const json = (await resp.json()) as CoreEnvelope<unknown>;
      message = json.message || message;
      code = json.code ?? 0;
    } catch {
      // Non-JSON upstream failure.
    }
    throw new CoreUpstreamError('CORE_UPSTREAM_ERROR', resp.status || 502, message, code);
  }

  async snapshotExport(kind: KnowledgeSnapshotKind, id: string): Promise<KnowledgeSnapshotDownload> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.migrationTimeoutMs ?? 60 * 60 * 1000);
    try {
      const resp = await fetch(`${this.cfg.baseUrl}/v3/internal/migration/export`, {
        method: 'POST', headers: this.headers('application/json'),
        body: JSON.stringify({ kind, id }), signal: ctrl.signal,
      });
      if (!resp.ok) return await this.upstreamError(resp);
      if (!resp.body) throw new CoreUpstreamError('CORE_UPSTREAM_ERROR', 502, 'knowledge snapshot body is missing', 0);
      const disposition = resp.headers.get('content-disposition') ?? '';
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${kind}-${id}.zip`;
      const sizeHeader = Number(resp.headers.get('content-length'));
      return {
        stream: Readable.fromWeb(resp.body as ReadableStream<Uint8Array>),
        filename,
        size: Number.isFinite(sizeHeader) && sizeHeader >= 0 ? sizeHeader : null,
        sha256: resp.headers.get('x-tdai-snapshot-sha256'),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async snapshotImport(
    kind: KnowledgeSnapshotKind,
    archivePath: string,
    options: KnowledgeSnapshotImportOptions,
  ): Promise<WikiDetail | CodeGraphDetail> {
    const query = new URLSearchParams({ kind, team_id: options.teamId, user_id: options.userId });
    if (options.preferredName) query.set('preferred_name', options.preferredName);
    const headers = this.headers('application/zip');
    headers['Content-Length'] = String(statSync(archivePath).size);
    if (options.provenance) {
      headers['x-tdai-migration-provenance'] = Buffer.from(JSON.stringify(options.provenance)).toString('base64url');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.migrationTimeoutMs ?? 60 * 60 * 1000);
    try {
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST', headers, body: createReadStream(archivePath) as unknown as RequestInit['body'],
        signal: ctrl.signal, duplex: 'half',
      };
      const resp = await fetch(`${this.cfg.baseUrl}/v3/internal/migration/import?${query.toString()}`, init);
      if (!resp.ok) return await this.upstreamError(resp);
      const json = (await resp.json()) as CoreEnvelope<WikiDetail | CodeGraphDetail>;
      if (json.code !== 0 || !json.data) {
        throw new CoreUpstreamError('CORE_UPSTREAM_ERROR', 502, json.message || 'knowledge import failed', json.code);
      }
      return json.data;
    } finally {
      clearTimeout(timer);
    }
  }

  // ═══════════════ Wiki · 资产层 ═══════════════

  async wikiCreate(teamId: string, name: string, userId?: string): Promise<WikiDetail> {
    return this.post('/v3/wiki/create', { team_id: teamId, name, user_id: userId });
  }

  async wikiGet(wikiId: string): Promise<WikiDetail> {
    return this.post('/v3/wiki/get', { wiki_id: wikiId });
  }

  async wikiIngest(wikiId: string): Promise<WikiIngestResult> {
    return this.post('/v3/wiki/ingest', { wiki_id: wikiId });
  }

  async wikiDelete(wikiIds: string[]): Promise<BatchDeleteResult> {
    return this.post('/v3/wiki/delete', { wiki_ids: wikiIds });
  }

  async wikiList(teamId: string, opts?: { status?: string; limit?: number; offset?: number }): Promise<WikiListResult> {
    return this.post('/v3/wiki/list', { team_id: teamId, ...opts });
  }

  // ═══════════════ Wiki · raw 文件层 ═══════════════

  async wikiRawLs(wikiId: string): Promise<{ items: RawFileEntry[] }> {
    return this.post('/v3/wiki/raw/ls', { wiki_id: wikiId });
  }

  async wikiRawRead(wikiId: string, filenames: string[]): Promise<{ items: WikiRawReadItem[] }> {
    return this.post('/v3/wiki/raw/read', { wiki_id: wikiId, filenames });
  }

  async wikiRawWrite(teamId: string, wikiId: string, files: WikiRawWriteFile[], userId?: string): Promise<{ items: WikiRawWriteItem[] }> {
    return this.post('/v3/wiki/raw/write', { team_id: teamId, user_id: userId, wiki_id: wikiId, files });
  }

  async wikiRawRm(teamId: string, wikiId: string, filenames: string[], userId?: string): Promise<WikiRawRmResult> {
    return this.post('/v3/wiki/raw/rm', { team_id: teamId, user_id: userId, wiki_id: wikiId, filenames });
  }

  // ═══════════════ Wiki · page 文件层 ═══════════════

  async wikiPageLs(wikiId: string): Promise<{ items: PageEntry[] }> {
    return this.post('/v3/wiki/page/ls', { wiki_id: wikiId });
  }

  async wikiPageRead(wikiId: string, refs: string[]): Promise<{ items: WikiPageReadItem[] }> {
    return this.post('/v3/wiki/page/read', { wiki_id: wikiId, refs });
  }

  async wikiPageWrite(teamId: string, wikiId: string, pages: WikiPageWriteItem[], userId?: string): Promise<{ items: WikiPageWriteResultItem[] }> {
    return this.post('/v3/wiki/page/write', { team_id: teamId, user_id: userId, wiki_id: wikiId, pages });
  }

  async wikiPageRm(teamId: string, wikiId: string, refs: string[], userId?: string): Promise<WikiPageRmResult> {
    return this.post('/v3/wiki/page/rm', { team_id: teamId, user_id: userId, wiki_id: wikiId, refs });
  }

  // ═══════════════ Wiki · 派生视图 ═══════════════

  async wikiGraph(wikiId: string): Promise<WikiGraphData> {
    return this.post('/v3/wiki/graph', { wiki_id: wikiId });
  }

  async wikiSearch(wikiId: string, query: string, limit?: number, graph?: { hop?: number; decay?: number; minScore?: number }): Promise<WikiSearchResult> {
    return this.post('/v3/wiki/search', { wiki_id: wikiId, query, limit: limit ?? 20, ...(graph && Object.keys(graph).length > 0 ? { graph } : {}) });
  }

  async wikiUpdateMeta(wikiId: string, patch: { name?: string; summary?: string | null }): Promise<WikiDetail> {
    return this.post('/v3/wiki/update-meta', { wiki_id: wikiId, ...patch });
  }

  // ═══════════════ Code-Graph ═══════════════

  async codeGraphCreate(teamId: string, repoUrl: string, branch?: string, userId?: string, repoName?: string): Promise<CodeGraphDetail> {
    return this.post('/v3/code-graph/create', {
      team_id: teamId,
      user_id: userId,
      repo_url: repoUrl,
      branch: branch ?? 'main',
      repo_name: repoName,
    });
  }

  async codeGraphList(teamId: string, opts?: { status?: string; limit?: number; offset?: number }): Promise<CodeGraphListResult> {
    return this.post('/v3/code-graph/list', { team_id: teamId, ...opts });
  }

  async codeGraphGet(codeGraphId: string): Promise<CodeGraphDetail> {
    return this.post('/v3/code-graph/get', { code_graph_id: codeGraphId });
  }

  async codeGraphSync(codeGraphId: string): Promise<CodeGraphSyncResult> {
    return this.post('/v3/code-graph/sync', { code_graph_id: codeGraphId });
  }

  async codeGraphDelete(codeGraphIds: string[]): Promise<BatchDeleteResult> {
    return this.post('/v3/code-graph/delete', { code_graph_ids: codeGraphIds });
  }

  async codeGraphUpdateMeta(codeGraphId: string, patch: { repo_name?: string; summary?: string | null }): Promise<CodeGraphDetail> {
    return this.post('/v3/code-graph/update-meta', { code_graph_id: codeGraphId, ...patch });
  }

  async codeGraphQuery(codeGraphId: string, tool: string, params: Record<string, unknown>): Promise<CodeGraphToolResult> {
    return this.post(`/v3/code-graph/${tool}`, { code_graph_id: codeGraphId, ...params });
  }
}
