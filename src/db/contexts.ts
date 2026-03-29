/**
 * Context SQLite Database
 *
 * Local context storage for reusable pieces of information (git repos,
 * API calls, markdown docs, commands, plain text, files, URLs) that can
 * be attached to prompts and sent to AI agents.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import os from "node:os";
import { existsSync, mkdirSync } from "node:fs";

// ── Types ───────────────────────────────────────────────────────────────

export type ContextType =
  | "git_repo"
  | "api_call"
  | "markdown_doc"
  | "command"
  | "plain_text"
  | "file"
  | "url";

export interface AIContextRecord {
  id: string;
  name: string;
  type: ContextType;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreateContextInput {
  name: string;
  type: ContextType;
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateContextInput {
  name?: string;
  type?: ContextType;
  content?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ContextFilter {
  type?: ContextType;
  tags?: string[];
  search?: string;
}

// ── Database Row ────────────────────────────────────────────────────────

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

// ── ContextDatabase ─────────────────────────────────────────────────────

const VALID_TYPES: ContextType[] = [
  "git_repo",
  "api_call",
  "markdown_doc",
  "command",
  "plain_text",
  "file",
  "url",
];

export class ContextDatabase {
  private db: Database;

  constructor(dbPath?: string) {
    const dir = join(os.homedir(), ".vibecontrols");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const path = dbPath || join(dir, "ai-contexts.db");
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contexts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('git_repo','api_call','markdown_doc','command','plain_text','file','url')),
        content TEXT NOT NULL,
        tags TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_contexts_type ON contexts(type);
      CREATE INDEX IF NOT EXISTS idx_contexts_deleted_at ON contexts(deleted_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contexts_name ON contexts(name) WHERE deleted_at IS NULL;
    `);
  }

  private rowToContext(row: ContextRow): AIContextRecord {
    return {
      id: row.id,
      name: row.name,
      type: row.type as ContextType,
      content: row.content,
      tags: JSON.parse(row.tags || "[]"),
      metadata: JSON.parse(row.metadata || "{}"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    };
  }

  create(input: CreateContextInput): AIContextRecord {
    if (!VALID_TYPES.includes(input.type)) {
      throw new Error(
        `Invalid context type: ${input.type}. Must be one of: ${VALID_TYPES.join(", ")}`,
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO contexts (id, name, type, content, tags, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.type,
        input.content,
        JSON.stringify(input.tags || []),
        JSON.stringify(input.metadata || {}),
        now,
        now,
      );

    return this.getById(id)!;
  }

  getById(id: string): AIContextRecord | null {
    const row = this.db
      .prepare("SELECT * FROM contexts WHERE id = ? AND deleted_at IS NULL")
      .get(id) as ContextRow | null;
    return row ? this.rowToContext(row) : null;
  }

  list(
    filter?: ContextFilter,
    pagination?: { limit?: number; offset?: number },
  ): { items: AIContextRecord[]; total: number; hasMore: boolean } {
    const conditions: string[] = ["deleted_at IS NULL"];
    const params: (string | number)[] = [];

    if (filter?.type) {
      conditions.push("type = ?");
      params.push(filter.type);
    }
    if (filter?.search) {
      conditions.push("(LOWER(name) LIKE ? OR LOWER(content) LIKE ?)");
      const pattern = `%${filter.search.toLowerCase()}%`;
      params.push(pattern, pattern);
    }

    const whereClause = conditions.join(" AND ");
    const limit = pagination?.limit || 50;
    const offset = pagination?.offset || 0;

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM contexts WHERE ${whereClause}`)
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM contexts WHERE ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as ContextRow[];

    let items = rows.map((r) => this.rowToContext(r));
    let total = countRow.count;

    // Tag filter in-memory
    if (filter?.tags && filter.tags.length > 0) {
      items = items.filter((ctx) =>
        filter.tags!.some((tag) => ctx.tags.includes(tag)),
      );
      total = items.length;
    }

    return { items, total, hasMore: offset + items.length < total };
  }

  search(query: string, type?: ContextType, limit?: number): AIContextRecord[] {
    const conditions: string[] = [
      "deleted_at IS NULL",
      "(LOWER(name) LIKE ? OR LOWER(content) LIKE ?)",
    ];
    const pattern = `%${query.toLowerCase()}%`;
    const params: (string | number)[] = [pattern, pattern];

    if (type) {
      conditions.push("type = ?");
      params.push(type);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM contexts WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params, limit || 20) as ContextRow[];

    return rows.map((r) => this.rowToContext(r));
  }

  update(id: string, input: UpdateContextInput): AIContextRecord | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const sets: string[] = ["updated_at = ?"];
    const now = new Date().toISOString();
    const params: (string | number | null)[] = [now];

    if (input.name !== undefined) {
      sets.push("name = ?");
      params.push(input.name);
    }
    if (input.type !== undefined) {
      if (!VALID_TYPES.includes(input.type)) {
        throw new Error(`Invalid context type: ${input.type}`);
      }
      sets.push("type = ?");
      params.push(input.type);
    }
    if (input.content !== undefined) {
      sets.push("content = ?");
      params.push(input.content);
    }
    if (input.tags !== undefined) {
      sets.push("tags = ?");
      params.push(JSON.stringify(input.tags));
    }
    if (input.metadata !== undefined) {
      sets.push("metadata = ?");
      params.push(JSON.stringify(input.metadata));
    }

    params.push(id);

    this.db
      .prepare(
        `UPDATE contexts SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(...params);

    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE contexts SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
      )
      .run(id);
    return result.changes > 0;
  }

  getMultiple(ids: string[]): AIContextRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM contexts WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      )
      .all(...ids) as ContextRow[];
    return rows.map((r) => this.rowToContext(r));
  }

  close(): void {
    this.db.close();
  }
}
