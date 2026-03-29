/**
 * Dispatched Prompts SQLite Database
 *
 * Tracks composed prompts that have been assembled from templates,
 * variables, and contexts, and dispatched to AI sessions.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import os from "node:os";
import { existsSync, mkdirSync } from "node:fs";

// ── Types ───────────────────────────────────────────────────────────────

export type DispatchStatus =
  | "draft"
  | "queued"
  | "dispatched"
  | "processing"
  | "completed"
  | "failed";

export interface DispatchedPromptRecord {
  id: string;
  templateId: string | null;
  content: string;
  resolvedVariables: Record<string, unknown>;
  contextIds: string[];
  sessionId: string | null;
  status: DispatchStatus;
  result: Record<string, unknown> | null;
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDispatchInput {
  templateId?: string;
  content: string;
  resolvedVariables?: Record<string, unknown>;
  contextIds?: string[];
  sessionId?: string;
  scheduledAt?: string;
}

export interface UpdateDispatchInput {
  status?: DispatchStatus;
  sessionId?: string;
  result?: Record<string, unknown>;
}

// ── Database Row ────────────────────────────────────────────────────────

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

// ── DispatchedPromptDatabase ────────────────────────────────────────────

export class DispatchedPromptDatabase {
  private db: Database;

  constructor(dbPath?: string) {
    const dir = join(os.homedir(), ".vibecontrols");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const path = dbPath || join(dir, "ai-dispatched.db");
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatched_prompts (
        id TEXT PRIMARY KEY,
        template_id TEXT,
        content TEXT NOT NULL,
        resolved_variables TEXT DEFAULT '{}',
        context_ids TEXT DEFAULT '[]',
        session_id TEXT,
        status TEXT DEFAULT 'draft' CHECK(status IN ('draft','queued','dispatched','processing','completed','failed')),
        result TEXT,
        scheduled_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_dispatch_status ON dispatched_prompts(status);
      CREATE INDEX IF NOT EXISTS idx_dispatch_session ON dispatched_prompts(session_id);
      CREATE INDEX IF NOT EXISTS idx_dispatch_scheduled ON dispatched_prompts(scheduled_at);
    `);
  }

  private rowToRecord(row: DispatchRow): DispatchedPromptRecord {
    return {
      id: row.id,
      templateId: row.template_id,
      content: row.content,
      resolvedVariables: JSON.parse(row.resolved_variables || "{}"),
      contextIds: JSON.parse(row.context_ids || "[]"),
      sessionId: row.session_id,
      status: row.status as DispatchStatus,
      result: row.result ? JSON.parse(row.result) : null,
      scheduledAt: row.scheduled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  create(input: CreateDispatchInput): DispatchedPromptRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO dispatched_prompts (id, template_id, content, resolved_variables, context_ids, session_id, status, scheduled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      )
      .run(
        id,
        input.templateId ?? null,
        input.content,
        JSON.stringify(input.resolvedVariables || {}),
        JSON.stringify(input.contextIds || []),
        input.sessionId ?? null,
        input.scheduledAt ?? null,
        now,
        now,
      );

    return this.getById(id)!;
  }

  getById(id: string): DispatchedPromptRecord | null {
    const row = this.db
      .prepare("SELECT * FROM dispatched_prompts WHERE id = ?")
      .get(id) as DispatchRow | null;
    return row ? this.rowToRecord(row) : null;
  }

  list(
    filter?: { status?: DispatchStatus; sessionId?: string },
    pagination?: { limit?: number; offset?: number },
  ): { items: DispatchedPromptRecord[]; total: number; hasMore: boolean } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.sessionId) {
      conditions.push("session_id = ?");
      params.push(filter.sessionId);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = pagination?.limit || 50;
    const offset = pagination?.offset || 0;

    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM dispatched_prompts ${whereClause}`,
      )
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM dispatched_prompts ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as DispatchRow[];

    return {
      items: rows.map((r) => this.rowToRecord(r)),
      total: countRow.count,
      hasMore: offset + rows.length < countRow.count,
    };
  }

  update(id: string, input: UpdateDispatchInput): DispatchedPromptRecord | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const sets: string[] = ["updated_at = ?"];
    const now = new Date().toISOString();
    const params: (string | number | null)[] = [now];

    if (input.status !== undefined) {
      sets.push("status = ?");
      params.push(input.status);
    }
    if (input.sessionId !== undefined) {
      sets.push("session_id = ?");
      params.push(input.sessionId);
    }
    if (input.result !== undefined) {
      sets.push("result = ?");
      params.push(JSON.stringify(input.result));
    }

    params.push(id);
    this.db
      .prepare(
        `UPDATE dispatched_prompts SET ${sets.join(", ")} WHERE id = ?`,
      )
      .run(...params);

    return this.getById(id);
  }

  getQueued(limit?: number): DispatchedPromptRecord[] {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM dispatched_prompts
       WHERE status = 'queued' AND (scheduled_at IS NULL OR scheduled_at <= ?)
       ORDER BY created_at ASC LIMIT ?`,
      )
      .all(now, limit || 10) as DispatchRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  close(): void {
    this.db.close();
  }
}
