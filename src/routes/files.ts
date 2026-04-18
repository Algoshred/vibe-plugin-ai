/**
 * AI File Management REST API Routes
 *
 * Upload, list, and delete file attachments for AI sessions. Files live
 * under `{VIBECONTROLS_DATA_DIR}/ai-files/<sessionId>/` — the host agent
 * sets that env var to `.boff/vibecontrols/agents/{agentId}/` so
 * uploaded files stay per-agent and survive or disappear with the
 * agent's local state.
 * Mounted at /api/ai/sessions by the plugin system.
 */

import { Elysia, t } from "elysia";
import { join } from "node:path";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import type { SessionDatabase } from "../db/sessions.js";
import type { FileDatabase } from "../db/files.js";
import { getDataDir } from "../db/data-dir.js";

export interface FileRouteDeps {
  sessionDb: SessionDatabase;
  fileDb: FileDatabase;
}

function filesBaseDir(): string {
  return join(getDataDir(), "ai-files");
}

function ensureSessionDir(sessionId: string): string {
  const dir = join(filesBaseDir(), sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function createFileRoutes(deps: FileRouteDeps) {
  const { sessionDb, fileDb } = deps;

  return (
    new Elysia()
      // ── POST /sessions/:id/files — Upload file(s) ────────────────────
      .post(
        "/sessions/:id/files",
        async ({ params, body, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          const sessionDir = ensureSessionDir(params.id);
          const files = Array.isArray(body.files) ? body.files : [body.files];

          if (files.length === 0) {
            set.status = 400;
            return { error: "No files provided" };
          }

          const results: Array<{
            id: string;
            filename: string;
            mimeType: string;
            size: number;
          }> = [];

          for (const file of files) {
            if (!file || typeof file !== "object") continue;

            const f = file as {
              name?: string;
              type?: string;
              size?: number;
              arrayBuffer?: () => Promise<ArrayBuffer>;
            };
            const filename = f.name || `file-${crypto.randomUUID()}`;
            const mimeType = f.type || "application/octet-stream";
            const filePath = join(
              sessionDir,
              `${crypto.randomUUID()}-${filename}`,
            );

            if (f.arrayBuffer) {
              const buffer = await f.arrayBuffer();
              await Bun.write(filePath, buffer);

              const size = buffer.byteLength;
              const record = fileDb.add({
                sessionId: params.id,
                filename,
                mimeType,
                size,
                path: filePath,
              });

              results.push({
                id: record.id,
                filename: record.filename,
                mimeType: record.mimeType,
                size: record.size,
              });
            }
          }

          set.status = 201;
          return { uploaded: results };
        },
        {
          params: t.Object({ id: t.String() }),
          type: "multipart/form-data",
          body: t.Object({
            files: t.Union([t.File(), t.Array(t.File())]),
          }),
        },
      )

      // ── GET /sessions/:id/files — List attached files ────────────────
      .get(
        "/sessions/:id/files",
        ({ params, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          const files = fileDb.list(params.id);
          return {
            files: files.map((f) => ({
              id: f.id,
              filename: f.filename,
              mimeType: f.mimeType,
              size: f.size,
              createdAt: f.createdAt,
            })),
          };
        },
        { params: t.Object({ id: t.String() }) },
      )

      // ── DELETE /sessions/:id/files/:fileId — Remove attachment ───────
      .delete(
        "/sessions/:id/files/:fileId",
        ({ params, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          const file = fileDb.getById(params.fileId);
          if (!file) {
            set.status = 404;
            return { error: "File not found" };
          }
          if (file.sessionId !== params.id) {
            set.status = 404;
            return { error: "File not found in this session" };
          }

          // Delete file from disk
          try {
            if (existsSync(file.path)) {
              unlinkSync(file.path);
            }
          } catch {
            // Best-effort disk cleanup
          }

          fileDb.delete(params.fileId);
          return { success: true };
        },
        {
          params: t.Object({ id: t.String(), fileId: t.String() }),
        },
      )
  );
}
