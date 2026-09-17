import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { WikiAnalysisCheckpoint } from "./analysis-checkpoint.js";
import { createThrottledProgressFn } from "./manager.js";
import { beginWikiBuild, listWikiVersions, pauseInterruptedWikiBuilds } from "./version-store.js";
import type { LlmClient } from "./ingest-v2/llm.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(root).toContain("wiki-checkpoint-");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Wiki analysis checkpoints", () => {
  it("marks an interrupted build as paused without changing its document snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-checkpoint-")); roots.push(root);
    mkdirSync(join(root, "raw", "sources"), { recursive: true });
    writeFileSync(join(root, "raw", "sources", "a.md"), "pinned input");
    const build = beginWikiBuild(root, 1);
    pauseInterruptedWikiBuilds(root);
    expect(listWikiVersions(root)[0].state).toBe("paused");
    expect(readFileSync(join(build.versionDir, "pending", "sources", "a.md"), "utf8")).toBe("pinned input");
  });
  it("reuses completed AI responses across instances and rejects reuse across baseline/model changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-checkpoint-")); roots.push(root);
    const chat = vi.fn().mockResolvedValue("saved analysis");
    const inner = { chat } as unknown as LlmClient;
    const params = { system: "s", prompt: "p", label: "analysis:chapter" };
    await new WikiAnalysisCheckpoint(root, "v1", { model: "model-a", apiKey: "private" }).client(inner).chat(params);
    await new WikiAnalysisCheckpoint(root, "v1", { apiKey: "rotated", model: "model-a" }).client(inner).chat(params);
    expect(chat).toHaveBeenCalledTimes(1);
    await new WikiAnalysisCheckpoint(root, "v2", { model: "model-a" }).client(inner).chat(params);
    await new WikiAnalysisCheckpoint(root, "v1", { model: "model-b" }).client(inner).chat(params);
    expect(chat).toHaveBeenCalledTimes(3);
    const controller = new AbortController(); controller.abort();
    await expect(new WikiAnalysisCheckpoint(root, "v1", { model: "model-a" }).client(inner, controller.signal).chat(params)).rejects.toThrow();
  });

  it("does not cache invalid generated file blocks", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-checkpoint-")); roots.push(root);
    const chat = vi.fn().mockResolvedValue("invalid response");
    const client = new WikiAnalysisCheckpoint(root, null, {}).client({ chat } as unknown as LlmClient);
    const params = { system: "s", prompt: "p", label: "generate:chapter" };
    await client.chat(params); await client.chat(params);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("reports document progress even when the rounded percentage has not changed", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const report = createThrottledProgressFn(callback)!;
    report({ phase: "extracting", total: 2615, completed: 0, failed: 0, skipped: 0, percent: 0 });
    vi.advanceTimersByTime(600);
    report({ phase: "extracting", total: 2615, completed: 1, failed: 0, skipped: 0, percent: 0 });
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
