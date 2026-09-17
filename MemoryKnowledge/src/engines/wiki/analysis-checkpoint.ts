/** AI 响应与单文档候选页的持久化检查点，恢复时不重复调用已完成的模型请求。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./index-db.js";
import { atomicWriteJson } from "./version-store.js";
import { parseFileBlocks } from "./ingest-v2/file-protocol.js";
import type { LlmClient } from "./ingest-v2/llm.js";
import type { IngestProgress } from "./manager.js";

export interface WikiAnalysisProgress extends IngestProgress {
  version: number;
  updated_at: string;
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function readAnalysisProgress(root: string): WikiAnalysisProgress | null {
  return readJson(join(root, "analysis-progress.json")) as WikiAnalysisProgress | null;
}

export function saveAnalysisProgress(root: string, version: number, progress: IngestProgress): void {
  atomicWriteJson(join(root, "analysis-progress.json"), { ...progress, version, updated_at: new Date().toISOString() });
}

/** 检查点隔离于生效知识版本和模型配置，防止回滚或换模型时复用不适用的结果。 */
export class WikiAnalysisCheckpoint {
  public readonly directory: string;

  constructor(root: string, baseVersionKey: string | null, modelConfig: Record<string, unknown>) {
    const model = Object.fromEntries(Object.entries(modelConfig).filter(([key]) => key !== "apiKey").sort(([a], [b]) => a.localeCompare(b)));
    this.directory = join(root, "analysis-cache", sha256(JSON.stringify({ baseVersionKey, model })));
  }

  public readCandidates(filename: string, sourceHash: string): Map<string, string> | null {
    const path = join(this.directory, `source-${sha256(`${filename}\0${sourceHash}`)}.json`);
    const entry = readJson(path) as { filename?: string; sha256?: string; candidates?: unknown } | null;
    if (entry?.filename !== filename || entry.sha256 !== sourceHash || !Array.isArray(entry.candidates)
        || !entry.candidates.every((item) => Array.isArray(item) && item.length === 2 && item.every((value) => typeof value === "string"))) return null;
    return new Map(entry.candidates as Array<[string, string]>);
  }

  public writeCandidates(filename: string, sourceHash: string, candidates: Map<string, string>): void {
    atomicWriteJson(join(this.directory, `source-${sha256(`${filename}\0${sourceHash}`)}.json`), {
      filename, sha256: sourceHash, candidates: [...candidates],
    });
  }

  public client(inner: LlmClient, signal?: AbortSignal): LlmClient {
    return {
      config: inner.config,
      chat: async (params) => {
        signal?.throwIfAborted();
        params.abortSignal?.throwIfAborted();
        const { abortSignal, ...input } = params;
        const path = join(this.directory, `response-${sha256(JSON.stringify(input))}.json`);
        const cached = readJson(path) as { text?: unknown } | null;
        if (typeof cached?.text === "string" && cached.text.trim()) return cached.text;
        const response = await inner.chat({ ...params,
          abortSignal: signal && abortSignal ? AbortSignal.any([signal, abortSignal]) : signal ?? abortSignal,
        });
        signal?.throwIfAborted();
        params.abortSignal?.throwIfAborted();
        // 非法生成结果不缓存，重试时仍有机会重新生成合法候选页。
        if (response.trim() && (!params.label?.startsWith("generate:") || parseFileBlocks(response).files.length > 0)) {
          atomicWriteJson(path, { text: response });
        }
        return response;
      },
    };
  }
}
