/**
 * One-shot SQLite → KV import.
 *
 * On plugin boot, if a legacy `.db` file exists in the data dir, read
 * each row, map it to the new KV shape, and push it into the matching
 * KVStore. Rename the old DB to `.db.migrated` afterwards so we don't
 * re-import on subsequent boots.
 *
 * The SQLite dependency sits behind a dynamic import — when no legacy
 * files exist, `bun:sqlite` is never loaded and tests can stub this
 * module entirely.
 */

import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./data-dir.js";
import type { KVStore } from "./kv-store.js";
import type { AISessionRecord } from "./sessions.js";
import type { AIContextRecord } from "./contexts.js";
import type { Prompt } from "./prompts.js";
import type { AILogRecord } from "./logs.js";
import type { DispatchedPromptRecord } from "./dispatched-prompts.js";
import type { QueueItem } from "./queue.js";
import type { AIFileRecord } from "./files.js";

interface ImportTargets {
  sessions: KVStore<AISessionRecord>;
  contexts: KVStore<AIContextRecord>;
  prompts: KVStore<Prompt>;
  logs: KVStore<AILogRecord>;
  dispatched: KVStore<DispatchedPromptRecord>;
  queue: KVStore<QueueItem>;
  files: KVStore<AIFileRecord>;
}

interface Logger {
  info(source: string, msg: string): void;
  warn(source: string, msg: string): void;
  error(source: string, msg: string): void;
}

async function importDb<Row, Out extends object>(
  dbPath: string,
  table: string,
  target: KVStore<Out>,
  map: (row: Row) => Out,
  logger?: Logger,
): Promise<number> {
  if (!existsSync(dbPath)) return 0;
  let count = 0;
  try {
    const mod = await import("bun:sqlite");
    const Database: new (
      p: string,
      opts?: { readonly: boolean },
    ) => {
      prepare(sql: string): { all(): Row[] };
      close(): void;
    } = mod.Database;
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows) {
        try {
          target.put(map(row));
          count++;
        } catch (err) {
          logger?.warn(
            "sqlite-import",
            `[${table}] skip row: ${String(err)}`,
          );
        }
      }
    } finally {
      db.close();
    }
    renameSync(dbPath, `${dbPath}.migrated`);
    for (const ext of ["-wal", "-shm"]) {
      const sidecar = `${dbPath}${ext}`;
      if (existsSync(sidecar)) {
        try {
          renameSync(sidecar, `${sidecar}.migrated`);
        } catch {
          /* ignore */
        }
      }
    }
    logger?.info(
      "sqlite-import",
      `[${table}] imported ${count} rows from ${dbPath}`,
    );
  } catch (err) {
    logger?.error(
      "sqlite-import",
      `[${table}] import failed: ${String(err)}`,
    );
  }
  return count;
}

export async function importLegacySqlite(
  targets: ImportTargets,
  logger?: Logger,
): Promise<void> {
  const dir = getDataDir();

  interface SessionRow {
    id: string;
    name: string;
    agent_type: string;
    provider_plugin: string;
    config: string;
    status: string;
    stats: string;
    created_at: string;
    updated_at: string;
    terminated_at: string | null;
  }
  await importDb<SessionRow, AISessionRecord>(
    join(dir, "ai-sessions.db"),
    "ai_sessions",
    targets.sessions,
    (r) => ({
      id: r.id,
      name: r.name,
      agentType: r.agent_type,
      providerPlugin: r.provider_plugin,
      config: JSON.parse(r.config || "{}"),
      status: r.status as AISessionRecord["status"],
      stats: JSON.parse(r.stats || "{}"),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      terminatedAt: r.terminated_at,
    }),
    logger,
  );

  interface ContextRow {
    id: string;
    name: string;
    type: string;
    content: string;
    tags: string;
    metadata: string;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
  }
  await importDb<ContextRow, AIContextRecord>(
    join(dir, "ai-contexts.db"),
    "contexts",
    targets.contexts,
    (r) => ({
      id: r.id,
      name: r.name,
      type: r.type as AIContextRecord["type"],
      content: r.content,
      tags: JSON.parse(r.tags || "[]"),
      metadata: JSON.parse(r.metadata || "{}"),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
    }),
    logger,
  );

  interface PromptRow {
    id: string;
    name: string;
    content: string;
    category: string | null;
    tags: string;
    variables: string;
    is_shared: number;
    created_by: string;
    usage_count: number;
    last_used: string | null;
    metadata: string;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
  }
  await importDb<PromptRow, Prompt>(
    join(dir, "ai-prompts.db"),
    "prompts",
    targets.prompts,
    (r) => ({
      id: r.id,
      name: r.name,
      content: r.content,
      category: r.category as Prompt["category"],
      tags: JSON.parse(r.tags || "[]"),
      variables: JSON.parse(r.variables || "[]"),
      isShared: r.is_shared === 1,
      createdBy: r.created_by,
      usageCount: r.usage_count,
      lastUsed: r.last_used,
      metadata: JSON.parse(r.metadata || "{}"),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
    }),
    logger,
  );

  interface LogRow {
    id: string;
    session_id: string;
    type: string;
    content: string;
    token_count: number | null;
    model: string | null;
    duration_ms: number | null;
    agent_metadata: string;
    created_at: string;
  }
  await importDb<LogRow, AILogRecord>(
    join(dir, "ai-logs.db"),
    "ai_logs",
    targets.logs,
    (r) => ({
      id: r.id,
      sessionId: r.session_id,
      type: r.type as AILogRecord["type"],
      content: r.content,
      tokenCount: r.token_count,
      model: r.model,
      durationMs: r.duration_ms,
      agentMetadata: JSON.parse(r.agent_metadata || "{}"),
      createdAt: r.created_at,
    }),
    logger,
  );

  interface DispatchRow {
    id: string;
    template_id: string | null;
    content: string;
    resolved_variables: string;
    context_ids: string;
    session_id: string | null;
    status: string;
    result: string | null;
    scheduled_at: string | null;
    created_at: string;
    updated_at: string;
  }
  await importDb<DispatchRow, DispatchedPromptRecord>(
    join(dir, "ai-dispatched.db"),
    "dispatched_prompts",
    targets.dispatched,
    (r) => ({
      id: r.id,
      templateId: r.template_id,
      content: r.content,
      resolvedVariables: JSON.parse(r.resolved_variables || "{}"),
      contextIds: JSON.parse(r.context_ids || "[]"),
      sessionId: r.session_id,
      status: r.status as DispatchedPromptRecord["status"],
      result: r.result ? JSON.parse(r.result) : null,
      scheduledAt: r.scheduled_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
    logger,
  );

  interface QueueRow {
    id: string;
    dispatched_prompt_id: string;
    session_id: string;
    priority: number;
    scheduled_at: string | null;
    status: string;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  }
  await importDb<QueueRow, QueueItem>(
    join(dir, "ai-queue.db"),
    "prompt_queue",
    targets.queue,
    (r) => ({
      id: r.id,
      dispatchedPromptId: r.dispatched_prompt_id,
      sessionId: r.session_id,
      priority: r.priority,
      scheduledAt: r.scheduled_at,
      status: r.status as QueueItem["status"],
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      lastError: r.last_error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
    logger,
  );

  interface FileRow {
    id: string;
    session_id: string;
    filename: string;
    mime_type: string;
    size: number;
    path: string;
    created_at: string;
  }
  await importDb<FileRow, AIFileRecord>(
    join(dir, "ai-files.db"),
    "ai_files",
    targets.files,
    (r) => ({
      id: r.id,
      sessionId: r.session_id,
      filename: r.filename,
      mimeType: r.mime_type,
      size: r.size,
      path: r.path,
      createdAt: r.created_at,
    }),
    logger,
  );
}
