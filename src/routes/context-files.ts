/**
 * Context-file fetch REST API Route
 *
 * Materialises a Files-module file onto the agent's machine: the agent fetches a
 * short-lived signed download URL server-side and writes the bytes into
 * `<workingDir>/.vibe/context/<file>`, returning the absolute path so the caller
 * can attach it to the conversation's contexts[] (the LLM CLI then reads it).
 *
 * SSRF: the agent makes the outbound fetch, so the URL is validated against an
 * https-only host-suffix allowlist and IP-literals / metadata hosts are rejected.
 *
 * Mounted under /api/ai by the plugin system.
 */

import { Elysia, t } from "elysia";
import { existsSync, mkdirSync } from "node:fs";
import type { SessionDatabase } from "../db/sessions.js";
import { safeBasename, safeJoinWithin } from "./safe-fs.js";

export interface ContextFileRouteDeps {
  sessionDb: SessionDatabase;
}

const DEFAULT_ALLOWED_HOST_SUFFIXES = [
  "amazonaws.com", // S3
  "blob.core.windows.net", // Azure Blob
  "storage.googleapis.com", // GCS
  "r2.cloudflarestorage.com", // Cloudflare R2
];

function allowedHostSuffixes(): string[] {
  const fromEnv = (process.env.VIBE_CONTEXT_FETCH_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_ALLOWED_HOST_SUFFIXES;
}

function maxBytes(): number {
  const n = Number(process.env.VIBE_CONTEXT_FETCH_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 25 * 1024 * 1024; // 25 MB default
}

const IP_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$|:/; // IPv4 dotted or any IPv6 colon form

/** Returns an error message if the URL is unsafe to fetch, else null. */
function validateDownloadUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "downloadUrl is not a valid URL";
  }
  if (url.protocol !== "https:") return "downloadUrl must be https";
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost"))
    return "downloadUrl host is not allowed";
  if (IP_LITERAL.test(host)) return "downloadUrl must not target an IP literal";
  const suffixes = allowedHostSuffixes();
  if (!suffixes.some((s) => host === s || host.endsWith(`.${s}`))) {
    return `downloadUrl host "${host}" is not in the allowlist`;
  }
  return null;
}

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

const TEXT_MIME =
  /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|typescript))/i;
const INLINE_MAX = 256 * 1024; // return inline text only for small text files

export function createContextFileRoutes(deps: ContextFileRouteDeps) {
  const { sessionDb } = deps;

  return new Elysia().post(
    "/context/fetch-file",
    async ({ body, set }) => {
      const urlError = validateDownloadUrl(body.downloadUrl);
      if (urlError) {
        set.status = 400;
        return { error: urlError };
      }

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

      let destPath: string;
      let contextDir: string;
      try {
        contextDir = safeJoinWithin(workingDir, ".vibe", "context");
        destPath = safeJoinWithin(contextDir, safeBasename(body.filename));
      } catch (err) {
        set.status = 400;
        return {
          error: err instanceof Error ? err.message : "Invalid filename",
        };
      }

      const cap = maxBytes();
      let buffer: ArrayBuffer;
      let contentType = "application/octet-stream";
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        const res = await fetch(body.downloadUrl, {
          redirect: "error",
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) {
          set.status = 502;
          return { error: `Download failed with status ${res.status}` };
        }
        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > cap) {
          set.status = 413;
          return { error: `File exceeds the ${cap}-byte limit` };
        }
        contentType = res.headers.get("content-type") || contentType;
        buffer = await res.arrayBuffer();
        if (buffer.byteLength > cap) {
          set.status = 413;
          return { error: `File exceeds the ${cap}-byte limit` };
        }
      } catch (err) {
        set.status = 502;
        return {
          error: err instanceof Error ? err.message : "Failed to download file",
        };
      }

      try {
        if (!existsSync(contextDir)) mkdirSync(contextDir, { recursive: true });
        await Bun.write(destPath, buffer);
      } catch (err) {
        set.status = 500;
        return {
          error:
            err instanceof Error ? err.message : "Failed to write context file",
        };
      }

      const bytes = buffer.byteLength;
      let inline: string | null = null;
      if (TEXT_MIME.test(contentType) && bytes <= INLINE_MAX) {
        try {
          inline = new TextDecoder().decode(buffer);
        } catch {
          inline = null;
        }
      }

      set.status = 201;
      return { path: destPath, bytes, contentType, inline };
    },
    {
      body: t.Object({
        downloadUrl: t.String({ minLength: 1 }),
        filename: t.String({ minLength: 1 }),
        sessionId: t.Optional(t.String()),
        workingDirectory: t.Optional(t.String()),
      }),
    },
  );
}
