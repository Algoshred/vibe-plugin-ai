/**
 * AI Sessions SQLite Database
 *
 * Local session tracking for AI agent sessions. Each session connects
 * to a specific AI provider plugin (claude, codex, opencode, etc.).
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import os from "node:os";
import { existsSync, mkdirSync } from "node:fs";

// ── Types ───────────────────────────────────────────────────────────────

export type SessionStatus =
  | "active"
  | "idle"
  | "processing"
  | "error"
  | "terminated";

export interface AISessionRecord {
  id: string;
  name: string;
  agentType: string;
  providerPlugin: string;
  config: Record<string, unknown>;
  status: SessionStatus;
  stats: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  terminatedAt: string | null;
}

export interface CreateSessionInput {
  name: string;
  agentType: string;
  providerPlugin?: string;
  config?: Record<string, unknown>;
}

export interface UpdateSessionInput {
  name?: string;
  config?: Record<string, unknown>;
  status?: SessionStatus;
  stats?: Record<string, unknown>;
}

// ── Database Row ────────────────────────────────────────────────────────

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

// ── SessionDatabase ─────────────────────────────────────────────────────

export class SessionDatabase {
  private db: Database;

  constructor(dbPath?: string) {
    const dir = join(os.homedir(), ".vibecontrols");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const path = dbPath || join(dir, "ai-sessions.db");
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        provider_plugin TEXT NOT NULL,
        config TEXT DEFAULT '{}',
        status TEXT DEFAULT 'idle' CHECK(status IN ('active','idle','processing','error','terminated')),
        stats TEXT DEFAULT '{"inputTokens":0,"outputTokens":0,"requestCount":0,"estimatedCostUsd":0}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        terminated_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_agent_type ON ai_sessions(agent_type);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON ai_sessions(status);
    `);
  }

  private rowToSession(row: SessionRow): AISessionRecord {
    return {
      id: row.id,
      name: row.name,
      agentType: row.agent_type,
      providerPlugin: row.provider_plugin,
      config: JSON.parse(row.config || "{}"),
      status: row.status as SessionStatus,
      stats: JSON.parse(row.stats || "{}"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      terminatedAt: row.terminated_at,
    };
  }

  create(input: CreateSessionInput): AISessionRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO ai_sessions (id, name, agent_type, provider_plugin, config, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.agentType,
        input.providerPlugin || input.agentType,
        JSON.stringify(input.config || {}),
        now,
        now,
      );

    return this.getById(id)!;
  }

  getById(id: string): AISessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM ai_sessions WHERE id = ?")
      .get(id) as SessionRow | null;
    return row ? this.rowToSession(row) : null;
  }

  list(
    filter?: { agentType?: string; status?: SessionStatus },
    pagination?: { limit?: number; offset?: number },
  ): { items: AISessionRecord[]; total: number; hasMore: boolean } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.agentType) {
      conditions.push("agent_type = ?");
      params.push(filter.agentType);
    }
    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = pagination?.limit || 50;
    const offset = pagination?.offset || 0;

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM ai_sessions ${whereClause}`)
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM ai_sessions ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as SessionRow[];

    return {
      items: rows.map((r) => this.rowToSession(r)),
      total: countRow.count,
      hasMore: offset + rows.length < countRow.count,
    };
  }

  update(id: string, input: UpdateSessionInput): AISessionRecord | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const sets: string[] = ["updated_at = ?"];
    const now = new Date().toISOString();
    const params: (string | number | null)[] = [now];

    if (input.name !== undefined) {
      sets.push("name = ?");
      params.push(input.name);
    }
    if (input.config !== undefined) {
      sets.push("config = ?");
      params.push(JSON.stringify(input.config));
    }
    if (input.status !== undefined) {
      sets.push("status = ?");
      params.push(input.status);
      if (input.status === "terminated") {
        sets.push("terminated_at = ?");
        params.push(now);
      }
    }
    if (input.stats !== undefined) {
      sets.push("stats = ?");
      params.push(JSON.stringify(input.stats));
    }

    params.push(id);
    this.db
      .prepare(`UPDATE ai_sessions SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);

    return this.getById(id);
  }

  terminate(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE ai_sessions SET status = 'terminated', terminated_at = ?, updated_at = ? WHERE id = ? AND status != 'terminated'",
      )
      .run(now, now, id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
