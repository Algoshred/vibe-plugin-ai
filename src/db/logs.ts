/**
 * AI Logs SQLite Database
 *
 * Per-session log storage for AI interactions. Tracks input, output,
 * thinking steps, events, errors, and metadata from AI agent providers.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import os from "node:os";
import { existsSync, mkdirSync } from "node:fs";

// ── Types ───────────────────────────────────────────────────────────────

export type LogType =
  | "input"
  | "output"
  | "thinking"
  | "event"
  | "error"
  | "metadata";

export interface AILogRecord {
  id: string;
  sessionId: string;
  type: LogType;
  content: string;
  tokenCount: number | null;
  model: string | null;
  durationMs: number | null;
  agentMetadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateLogInput {
  sessionId: string;
  type: LogType;
  content: string;
  tokenCount?: number;
  model?: string;
  durationMs?: number;
  agentMetadata?: Record<string, unknown>;
}

export interface LogFilter {
  types?: LogType[];
  startDate?: string;
  endDate?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

// ── Database Row ────────────────────────────────────────────────────────

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

// ── LogDatabase ─────────────────────────────────────────────────────────

export class LogDatabase {
  private db: Database;

  constructor(dbPath?: string) {
    const dir = join(os.homedir(), ".vibecontrols");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const path = dbPath || join(dir, "ai-logs.db");
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('input','output','thinking','event','error','metadata')),
        content TEXT NOT NULL,
        token_count INTEGER,
        model TEXT,
        duration_ms INTEGER,
        agent_metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_logs_session_id ON ai_logs(session_id);
      CREATE INDEX IF NOT EXISTS idx_logs_type ON ai_logs(type);
      CREATE INDEX IF NOT EXISTS idx_logs_created_at ON ai_logs(created_at);
    `);
  }

  private rowToLog(row: LogRow): AILogRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      type: row.type as LogType,
      content: row.content,
      tokenCount: row.token_count,
      model: row.model,
      durationMs: row.duration_ms,
      agentMetadata: JSON.parse(row.agent_metadata || "{}"),
      createdAt: row.created_at,
    };
  }

  append(input: CreateLogInput): AILogRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO ai_logs (id, session_id, type, content, token_count, model, duration_ms, agent_metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.type,
        input.content,
        input.tokenCount ?? null,
        input.model ?? null,
        input.durationMs ?? null,
        JSON.stringify(input.agentMetadata || {}),
        now,
      );

    return this.getById(id)!;
  }

  getById(id: string): AILogRecord | null {
    const row = this.db
      .prepare("SELECT * FROM ai_logs WHERE id = ?")
      .get(id) as LogRow | null;
    return row ? this.rowToLog(row) : null;
  }

  getBySession(sessionId: string, filter?: LogFilter): {
    items: AILogRecord[];
    total: number;
    hasMore: boolean;
  } {
    const conditions: string[] = ["session_id = ?"];
    const params: (string | number)[] = [sessionId];

    if (filter?.types && filter.types.length > 0) {
      const placeholders = filter.types.map(() => "?").join(",");
      conditions.push(`type IN (${placeholders})`);
      params.push(...filter.types);
    }
    if (filter?.startDate) {
      conditions.push("created_at >= ?");
      params.push(filter.startDate);
    }
    if (filter?.endDate) {
      conditions.push("created_at <= ?");
      params.push(filter.endDate);
    }
    if (filter?.search) {
      conditions.push("LOWER(content) LIKE ?");
      params.push(`%${filter.search.toLowerCase()}%`);
    }

    const whereClause = conditions.join(" AND ");
    const limit = filter?.limit || 100;
    const offset = filter?.offset || 0;

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM ai_logs WHERE ${whereClause}`)
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM ai_logs WHERE ${whereClause} ORDER BY created_at ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as LogRow[];

    return {
      items: rows.map((r) => this.rowToLog(r)),
      total: countRow.count,
      hasMore: offset + rows.length < countRow.count,
    };
  }

  getSessionStats(sessionId: string): {
    totalLogs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalDurationMs: number;
    logsByType: Record<string, number>;
  } {
    const totalRow = this.db
      .prepare(
        `SELECT
        COUNT(*) as total_logs,
        COALESCE(SUM(CASE WHEN type = 'input' THEN token_count ELSE 0 END), 0) as total_input_tokens,
        COALESCE(SUM(CASE WHEN type = 'output' THEN token_count ELSE 0 END), 0) as total_output_tokens,
        COALESCE(SUM(duration_ms), 0) as total_duration_ms
       FROM ai_logs WHERE session_id = ?`,
      )
      .get(sessionId) as {
      total_logs: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_duration_ms: number;
    };

    const typeRows = this.db
      .prepare(
        "SELECT type, COUNT(*) as count FROM ai_logs WHERE session_id = ? GROUP BY type",
      )
      .all(sessionId) as { type: string; count: number }[];

    const logsByType: Record<string, number> = {};
    for (const row of typeRows) {
      logsByType[row.type] = row.count;
    }

    return {
      totalLogs: totalRow.total_logs,
      totalInputTokens: totalRow.total_input_tokens,
      totalOutputTokens: totalRow.total_output_tokens,
      totalDurationMs: totalRow.total_duration_ms,
      logsByType,
    };
  }

  deleteBySession(sessionId: string): number {
    const result = this.db
      .prepare("DELETE FROM ai_logs WHERE session_id = ?")
      .run(sessionId);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
