/**
 * Prompt Queue SQLite Database
 *
 * Priority-based queue for prompt dispatch. Supports immediate,
 * scheduled, and event-triggered execution.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import os from "node:os";
import { existsSync, mkdirSync } from "node:fs";

// ── Types ───────────────────────────────────────────────────────────────

export type QueueStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export interface QueueItem {
  id: string;
  dispatchedPromptId: string;
  sessionId: string;
  priority: number;
  scheduledAt: string | null;
  status: QueueStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueInput {
  dispatchedPromptId: string;
  sessionId: string;
  priority?: number;
  scheduledAt?: string;
  maxAttempts?: number;
}

// ── Database Row ────────────────────────────────────────────────────────

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

// ── QueueDatabase ───────────────────────────────────────────────────────

export class QueueDatabase {
  private db: Database;

  constructor(dbPath?: string) {
    const dir = join(os.homedir(), ".vibecontrols");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const path = dbPath || join(dir, "ai-queue.db");
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_queue (
        id TEXT PRIMARY KEY,
        dispatched_prompt_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        scheduled_at TEXT,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed','cancelled')),
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_queue_status ON prompt_queue(status);
      CREATE INDEX IF NOT EXISTS idx_queue_priority ON prompt_queue(priority DESC);
      CREATE INDEX IF NOT EXISTS idx_queue_scheduled ON prompt_queue(scheduled_at);
    `);
  }

  private rowToItem(row: QueueRow): QueueItem {
    return {
      id: row.id,
      dispatchedPromptId: row.dispatched_prompt_id,
      sessionId: row.session_id,
      priority: row.priority,
      scheduledAt: row.scheduled_at,
      status: row.status as QueueStatus,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  enqueue(input: EnqueueInput): QueueItem {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO prompt_queue (id, dispatched_prompt_id, session_id, priority, scheduled_at, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.dispatchedPromptId,
        input.sessionId,
        input.priority ?? 0,
        input.scheduledAt ?? null,
        input.maxAttempts ?? 3,
        now,
        now,
      );

    return this.getById(id)!;
  }

  getById(id: string): QueueItem | null {
    const row = this.db
      .prepare("SELECT * FROM prompt_queue WHERE id = ?")
      .get(id) as QueueRow | null;
    return row ? this.rowToItem(row) : null;
  }

  list(
    filter?: { status?: QueueStatus },
    pagination?: { limit?: number; offset?: number },
  ): { items: QueueItem[]; total: number; hasMore: boolean } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = pagination?.limit || 50;
    const offset = pagination?.offset || 0;

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM prompt_queue ${whereClause}`)
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM prompt_queue ${whereClause} ORDER BY priority DESC, created_at ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as QueueRow[];

    return {
      items: rows.map((r) => this.rowToItem(r)),
      total: countRow.count,
      hasMore: offset + rows.length < countRow.count,
    };
  }

  /** Get next batch of items ready for processing */
  getReady(limit?: number): QueueItem[] {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM prompt_queue
       WHERE status = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= ?) AND attempts < max_attempts
       ORDER BY priority DESC, created_at ASC LIMIT ?`,
      )
      .all(now, limit || 5) as QueueRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  markProcessing(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE prompt_queue SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(now, id);
    return result.changes > 0;
  }

  markCompleted(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE prompt_queue SET status = 'completed', updated_at = ? WHERE id = ?",
      )
      .run(now, id);
    return result.changes > 0;
  }

  markFailed(id: string, error: string): boolean {
    const now = new Date().toISOString();
    const item = this.getById(id);
    if (!item) return false;

    const newStatus = item.attempts >= item.maxAttempts ? "failed" : "pending";
    const result = this.db
      .prepare(
        "UPDATE prompt_queue SET status = ?, last_error = ?, updated_at = ? WHERE id = ?",
      )
      .run(newStatus, error, now, id);
    return result.changes > 0;
  }

  cancel(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE prompt_queue SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending','processing')",
      )
      .run(now, id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
