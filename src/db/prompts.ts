/**
 * Prompts SQLite Database
 *
 * Local prompt storage for the AI plugin using bun:sqlite.
 * Mirrors the backend Prompt model but stored locally on the developer's machine.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import os from "node:os";
import { existsSync, mkdirSync } from "node:fs";

// ── Types ───────────────────────────────────────────────────────────────

export type PromptCategory =
  | "GENERAL"
  | "CODING"
  | "DEBUGGING"
  | "REVIEW"
  | "DOCUMENTATION"
  | "TESTING"
  | "DEPLOYMENT"
  | "CUSTOM";

export interface Prompt {
  id: string;
  name: string;
  content: string;
  category: PromptCategory | null;
  tags: string[];
  variables: string[];
  isShared: boolean;
  createdBy: string;
  usageCount: number;
  lastUsed: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreatePromptInput {
  name: string;
  content: string;
  category?: PromptCategory;
  tags?: string[];
  variables?: string[];
  isShared?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UpdatePromptInput {
  name?: string;
  content?: string;
  category?: PromptCategory | null;
  tags?: string[];
  variables?: string[];
  isShared?: boolean;
  metadata?: Record<string, unknown>;
}

export interface PromptFilter {
  category?: PromptCategory;
  tags?: string[];
  isShared?: boolean;
  createdBy?: string;
}

// ── Database Row Type ───────────────────────────────────────────────────

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

// ── PromptDatabase ──────────────────────────────────────────────────────

const VALID_CATEGORIES: PromptCategory[] = [
  "GENERAL",
  "CODING",
  "DEBUGGING",
  "REVIEW",
  "DOCUMENTATION",
  "TESTING",
  "DEPLOYMENT",
  "CUSTOM",
];

export class PromptDatabase {
  private db: Database;

  constructor(dbPath?: string) {
    const dir = join(os.homedir(), ".vibecontrols");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const path = dbPath || join(dir, "ai-prompts.db");
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT CHECK(category IS NULL OR category IN ('GENERAL','CODING','DEBUGGING','REVIEW','DOCUMENTATION','TESTING','DEPLOYMENT','CUSTOM')),
        tags TEXT DEFAULT '[]',
        variables TEXT DEFAULT '[]',
        is_shared INTEGER DEFAULT 0,
        created_by TEXT NOT NULL DEFAULT 'local',
        usage_count INTEGER DEFAULT 0,
        last_used TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_prompts_category ON prompts(category);
      CREATE INDEX IF NOT EXISTS idx_prompts_is_shared ON prompts(is_shared);
      CREATE INDEX IF NOT EXISTS idx_prompts_created_by ON prompts(created_by);
      CREATE INDEX IF NOT EXISTS idx_prompts_deleted_at ON prompts(deleted_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_prompts_name ON prompts(name) WHERE deleted_at IS NULL;
    `);
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private generateId(): string {
    return crypto.randomUUID();
  }

  private rowToPrompt(row: PromptRow): Prompt {
    return {
      id: row.id,
      name: row.name,
      content: row.content,
      category: row.category as PromptCategory | null,
      tags: JSON.parse(row.tags || "[]"),
      variables: JSON.parse(row.variables || "[]"),
      isShared: row.is_shared === 1,
      createdBy: row.created_by,
      usageCount: row.usage_count,
      lastUsed: row.last_used,
      metadata: JSON.parse(row.metadata || "{}"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    };
  }

  private extractVariables(content: string): string[] {
    const variableRegex = /\{\{(\w+)\}\}/g;
    const variables: string[] = [];
    let match;
    while ((match = variableRegex.exec(content)) !== null) {
      if (match[1] && !variables.includes(match[1])) {
        variables.push(match[1]);
      }
    }
    return variables;
  }

  // ── CRUD Operations ─────────────────────────────────────────────────

  create(input: CreatePromptInput): Prompt {
    const id = this.generateId();
    const now = new Date().toISOString();
    const variables = input.variables || this.extractVariables(input.content);
    const category =
      input.category && VALID_CATEGORIES.includes(input.category)
        ? input.category
        : null;

    const stmt = this.db.prepare(`
      INSERT INTO prompts (id, name, content, category, tags, variables, is_shared, created_by, usage_count, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'local', 0, ?, ?, ?)
    `);

    stmt.run(
      id,
      input.name,
      input.content,
      category,
      JSON.stringify(input.tags || []),
      JSON.stringify(variables),
      input.isShared ? 1 : 0,
      JSON.stringify(input.metadata || {}),
      now,
      now,
    );

    return this.getById(id)!;
  }

  getById(id: string): Prompt | null {
    const row = this.db
      .prepare("SELECT * FROM prompts WHERE id = ? AND deleted_at IS NULL")
      .get(id) as PromptRow | null;
    return row ? this.rowToPrompt(row) : null;
  }

  list(
    filter?: PromptFilter,
    pagination?: { limit?: number; offset?: number },
  ): { items: Prompt[]; total: number; hasMore: boolean } {
    const conditions: string[] = ["deleted_at IS NULL"];
    const params: (string | number)[] = [];

    if (filter?.category) {
      conditions.push("category = ?");
      params.push(filter.category);
    }
    if (filter?.isShared !== undefined) {
      conditions.push("is_shared = ?");
      params.push(filter.isShared ? 1 : 0);
    }
    if (filter?.createdBy) {
      conditions.push("created_by = ?");
      params.push(filter.createdBy);
    }

    const whereClause = conditions.join(" AND ");
    const limit = pagination?.limit || 50;
    const offset = pagination?.offset || 0;

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM prompts WHERE ${whereClause}`)
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM prompts WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as PromptRow[];

    // If tag filter is specified, do it in-memory (SQLite JSON array filtering)
    let items = rows.map((r) => this.rowToPrompt(r));
    let total = countRow.count;

    if (filter?.tags && filter.tags.length > 0) {
      items = items.filter((prompt) =>
        filter.tags!.some((tag) => prompt.tags.includes(tag)),
      );
      total = items.length;
    }

    return {
      items,
      total,
      hasMore: offset + items.length < total,
    };
  }

  search(query: string, category?: PromptCategory, limit?: number): Prompt[] {
    const conditions: string[] = [
      "deleted_at IS NULL",
      "(LOWER(name) LIKE ? OR LOWER(content) LIKE ?)",
    ];
    const pattern = `%${query.toLowerCase()}%`;
    const params: (string | number)[] = [pattern, pattern];

    if (category) {
      conditions.push("category = ?");
      params.push(category);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM prompts WHERE ${conditions.join(" AND ")} ORDER BY usage_count DESC LIMIT ?`,
      )
      .all(...params, limit || 20) as PromptRow[];

    return rows.map((r) => this.rowToPrompt(r));
  }

  getPopular(limit?: number): Prompt[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM prompts WHERE deleted_at IS NULL ORDER BY usage_count DESC LIMIT ?",
      )
      .all(limit || 10) as PromptRow[];

    return rows.map((r) => this.rowToPrompt(r));
  }

  update(id: string, input: UpdatePromptInput): Prompt | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const sets: string[] = ["updated_at = ?"];
    const now = new Date().toISOString();
    const params: (string | number | null)[] = [now];

    if (input.name !== undefined) {
      sets.push("name = ?");
      params.push(input.name);
    }
    if (input.content !== undefined) {
      sets.push("content = ?");
      params.push(input.content);
      // Re-extract variables when content changes
      const variables = input.variables || this.extractVariables(input.content);
      sets.push("variables = ?");
      params.push(JSON.stringify(variables));
    }
    if (input.category !== undefined) {
      sets.push("category = ?");
      params.push(input.category);
    }
    if (input.tags !== undefined) {
      sets.push("tags = ?");
      params.push(JSON.stringify(input.tags));
    }
    if (input.variables !== undefined && input.content === undefined) {
      sets.push("variables = ?");
      params.push(JSON.stringify(input.variables));
    }
    if (input.isShared !== undefined) {
      sets.push("is_shared = ?");
      params.push(input.isShared ? 1 : 0);
    }
    if (input.metadata !== undefined) {
      sets.push("metadata = ?");
      params.push(JSON.stringify(input.metadata));
    }

    params.push(id);

    this.db
      .prepare(
        `UPDATE prompts SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(...params);

    return this.getById(id);
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE prompts SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
      )
      .run(id);
    return result.changes > 0;
  }

  use(id: string): Prompt | null {
    const existing = this.getById(id);
    if (!existing) return null;

    this.db
      .prepare(
        "UPDATE prompts SET usage_count = usage_count + 1, last_used = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      )
      .run(id);

    return this.getById(id);
  }

  duplicate(id: string, newName: string): Prompt | null {
    const original = this.getById(id);
    if (!original) return null;

    return this.create({
      name: newName,
      content: original.content,
      category: original.category || undefined,
      tags: original.tags,
      variables: original.variables,
      isShared: original.isShared,
      metadata: original.metadata,
    });
  }

  renderPrompt(content: string, variables: Record<string, unknown>): string {
    let rendered = content;
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{{${key}}}`;
      while (rendered.includes(placeholder)) {
        rendered = rendered.replace(placeholder, String(value));
      }
    }
    return rendered;
  }

  renderById(id: string, variables: Record<string, unknown>): string | null {
    const prompt = this.getById(id);
    if (!prompt) return null;
    return this.renderPrompt(prompt.content, variables);
  }

  close(): void {
    this.db.close();
  }
}
