/**
 * Instruction-file REST API Routes
 *
 * CRUDL of AGENTS.md / CLAUDE.md / GEMINI.md (and safe custom names) inside a
 * session's working directory, so the LLM CLI picks them up. The backend is the
 * shareable source of truth; on session open the frontend pushes each linked
 * instruction file here via the AI proxy.
 *
 * Mounted under /api/ai by the plugin system. Deletes are exposed as POST
 * (/instructions/delete) because the backend AI proxy only forwards GET/POST.
 */

import { Elysia, t } from "elysia";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import type { SessionDatabase } from "../db/sessions.js";
import { safeBasename, safeJoinWithin } from "./safe-fs.js";

export interface InstructionRouteDeps {
  sessionDb: SessionDatabase;
}

// Canonical names the LLM CLIs read from cwd, plus a conservative custom allow.
const CANONICAL = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);

/** Resolve the working directory from an explicit value or the session config. */
function resolveWorkingDir(
  sessionDb: SessionDatabase,
  sessionId?: string,
  workingDirectory?: string,
): string | null {
  if (workingDirectory && workingDirectory.trim())
    return workingDirectory.trim();
  if (sessionId) {
    const session = sessionDb.getById(sessionId);
    const wd = (session?.config as Record<string, unknown> | undefined)
      ?.workingDirectory;
    if (typeof wd === "string" && wd.trim()) return wd.trim();
  }
  return null;
}

export function createInstructionRoutes(deps: InstructionRouteDeps) {
  const { sessionDb } = deps;

  return (
    new Elysia()
      // ── POST /instructions — write/overwrite an instruction file ──────
      .post(
        "/instructions",
        async ({ body, set }) => {
          const workingDir = resolveWorkingDir(
            sessionDb,
            body.sessionId,
            body.workingDirectory,
          );
          if (!workingDir) {
            set.status = 400;
            return {
              error:
                "A sessionId with a workingDirectory, or an explicit workingDirectory, is required",
            };
          }

          let filePath: string;
          try {
            const base = safeBasename(body.filename);
            filePath = safeJoinWithin(workingDir, base);
          } catch (err) {
            set.status = 400;
            return {
              error: err instanceof Error ? err.message : "Invalid filename",
            };
          }

          try {
            if (!existsSync(workingDir))
              mkdirSync(workingDir, { recursive: true });
            await Bun.write(filePath, body.content);
          } catch (err) {
            set.status = 500;
            return {
              error:
                err instanceof Error
                  ? err.message
                  : "Failed to write instruction file",
            };
          }

          set.status = 201;
          return {
            path: filePath,
            bytes: Buffer.byteLength(body.content, "utf8"),
          };
        },
        {
          body: t.Object({
            filename: t.String({ minLength: 1 }),
            content: t.String(),
            sessionId: t.Optional(t.String()),
            workingDirectory: t.Optional(t.String()),
          }),
        },
      )

      // ── GET /instructions — read instruction files present on disk ────
      .get(
        "/instructions",
        async ({ query, set }) => {
          const workingDir = resolveWorkingDir(
            sessionDb,
            query.sessionId,
            query.workingDirectory,
          );
          if (!workingDir) {
            set.status = 400;
            return {
              error:
                "A sessionId with a workingDirectory, or an explicit workingDirectory, is required",
            };
          }

          // A single filename returns its content; otherwise probe the canonical set.
          const names = query.filename
            ? [query.filename]
            : Array.from(CANONICAL);
          const files: Array<{
            filename: string;
            path: string;
            exists: boolean;
            content: string | null;
          }> = [];
          for (const name of names) {
            let path: string;
            try {
              path = safeJoinWithin(workingDir, safeBasename(name));
            } catch {
              continue;
            }
            const exists = existsSync(path);
            let content: string | null = null;
            if (exists) {
              try {
                content = await readFile(path, "utf8");
              } catch {
                content = null;
              }
            }
            files.push({ filename: name, path, exists, content });
          }
          return { workingDirectory: workingDir, files };
        },
        {
          query: t.Object({
            filename: t.Optional(t.String()),
            sessionId: t.Optional(t.String()),
            workingDirectory: t.Optional(t.String()),
          }),
        },
      )

      // ── POST /instructions/delete — remove an instruction file ────────
      .post(
        "/instructions/delete",
        async ({ body, set }) => {
          const workingDir = resolveWorkingDir(
            sessionDb,
            body.sessionId,
            body.workingDirectory,
          );
          if (!workingDir) {
            set.status = 400;
            return {
              error:
                "A sessionId with a workingDirectory, or an explicit workingDirectory, is required",
            };
          }

          let filePath: string;
          try {
            filePath = safeJoinWithin(workingDir, safeBasename(body.filename));
          } catch (err) {
            set.status = 400;
            return {
              error: err instanceof Error ? err.message : "Invalid filename",
            };
          }

          try {
            if (existsSync(filePath)) await unlink(filePath);
          } catch (err) {
            set.status = 500;
            return {
              error:
                err instanceof Error
                  ? err.message
                  : "Failed to delete instruction file",
            };
          }
          return { success: true, path: filePath };
        },
        {
          body: t.Object({
            filename: t.String({ minLength: 1 }),
            sessionId: t.Optional(t.String()),
            workingDirectory: t.Optional(t.String()),
          }),
        },
      )
  );
}
