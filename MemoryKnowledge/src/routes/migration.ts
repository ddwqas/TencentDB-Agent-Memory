import { createWriteStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Hono } from "hono";

import { isValidIdSegment, toCodeGraphDetail, toWikiDetail, wrapError, wrapOk } from "../api-helpers.js";
import {
  KnowledgeSnapshotService,
  copySnapshotStream,
  type SnapshotKind,
} from "../migration/snapshot-service.js";

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

function isKind(value: unknown): value is SnapshotKind {
  return value === "wiki" || value === "code_graph";
}

function safeDownloadName(value: string): string {
  return value.replace(/[\r\n"\\]/g, "-");
}

function decodeProvenance(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (value.length > 32_768) throw new Error("migration provenance header is too large");
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("migration provenance must be an object");
  }
  return parsed as Record<string, unknown>;
}

export function createMigrationRoutes(snapshotService: KnowledgeSnapshotService, publicBaseUrl?: string): Hono {
  const app = new Hono();

  app.post("/export", async (c) => {
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const kind = body.kind;
    const id = body.id;
    if (!isKind(kind) || !isValidIdSegment(id)) {
      return c.json(wrapError(400, "kind and id are required"), 400);
    }

    const artifact = await snapshotService.export(kind, serviceId, id);
    const source = copySnapshotStream(artifact.path);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      artifact.cleanup();
    };
    source.once("end", cleanup);
    source.once("close", cleanup);
    source.once("error", cleanup);
    const bodyStream = Readable.toWeb(source) as ReadableStream<Uint8Array>;
    return new Response(bodyStream, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeDownloadName(artifact.filename)}"`,
        "Content-Length": String(artifact.size),
        "X-Tdai-Snapshot-Sha256": artifact.sha256,
        "X-Tdai-Snapshot-Kind": kind,
      },
    });
  });

  app.post("/import", async (c) => {
    const serviceId = c.req.header("x-tdai-service-id");
    const kind = c.req.query("kind");
    const teamId = c.req.query("team_id");
    const userId = c.req.query("user_id");
    if (!isValidIdSegment(serviceId) || !isKind(kind) || !isValidIdSegment(teamId) || !isValidIdSegment(userId)) {
      return c.json(wrapError(400, "service, kind, team_id and user_id are required"), 400);
    }
    const declaredLength = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
      return c.json(wrapError(413, "snapshot exceeds the 4 GiB upload limit"), 413);
    }
    if (!c.req.raw.body) return c.json(wrapError(400, "snapshot body is required"), 400);

    const tempRoot = mkdtempSync(join(tmpdir(), "tdai-knowledge-upload-"));
    const uploadPath = join(tempRoot, "snapshot.zip");
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        callback(received > MAX_UPLOAD_BYTES ? new Error("snapshot exceeds the 4 GiB upload limit") : null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(c.req.raw.body as ReadableStream<Uint8Array>),
        limiter,
        createWriteStream(uploadPath, { flags: "wx" }),
      );
      if (statSync(uploadPath).size === 0) return c.json(wrapError(400, "snapshot body is empty"), 400);
      const preferredName = c.req.query("preferred_name")?.trim().slice(0, 255) || undefined;
      const provenance = decodeProvenance(c.req.header("x-tdai-migration-provenance"));
      const row = await snapshotService.import({
        kind,
        archivePath: uploadPath,
        serviceId,
        teamId,
        userId,
        preferredName,
        provenance,
        publicBaseUrl,
      });
      if (kind === "wiki" && "wiki_id" in row) return c.json(wrapOk(toWikiDetail(row)), 201);
      if (kind === "code_graph" && "code_graph_id" in row) return c.json(wrapOk(toCodeGraphDetail(row)), 201);
      throw new Error("knowledge snapshot returned an unexpected object kind");
    } finally {
      // Uploaded packages are deliberately ephemeral; retries must upload again.
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  return app;
}
