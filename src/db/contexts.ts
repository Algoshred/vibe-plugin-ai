/**
 * AI Contexts — KV-backed context registry.
 *
 * Reusable context blobs (git repos, API calls, markdown docs,
 * commands, plain text, files, URLs) that can be attached to prompts.
 */

import { KVStore, query } from "./kv-store.js";
import type { KVLogger } from "./kv-store.js";
import type { StorageProvider } from "./storage-provider-types.js";

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

const NAMESPACE = "ai:contexts";

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
  readonly store: KVStore<AIContextRecord>;

  constructor(storage: StorageProvider, logger?: KVLogger) {
    this.store = new KVStore(storage, NAMESPACE, "id", logger);
  }

  async hydrate(): Promise<void> {
    await this.store.hydrate();
  }

  private live(): AIContextRecord[] {
    return this.store.all().filter((c) => !c.deletedAt);
  }

  create(input: CreateContextInput): AIContextRecord {
    if (!VALID_TYPES.includes(input.type)) {
      throw new Error(
        `Invalid context type: ${input.type}. Must be one of: ${VALID_TYPES.join(", ")}`,
      );
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const rec: AIContextRecord = {
      id,
      name: input.name,
      type: input.type,
      content: input.content,
      tags: input.tags || [],
      metadata: input.metadata || {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.store.put(rec);
    return rec;
  }

  getById(id: string): AIContextRecord | null {
    const rec = this.store.get(id);
    return rec && !rec.deletedAt ? rec : null;
  }

  list(
    filter?: ContextFilter,
    pagination?: { limit?: number; offset?: number },
  ): { items: AIContextRecord[]; total: number; hasMore: boolean } {
    const needle = filter?.search?.toLowerCase();
    const tags = filter?.tags;
    return query(this.live(), {
      filter: (r) => {
        if (filter?.type && r.type !== filter.type) return false;
        if (tags && tags.length > 0 && !tags.some((t) => r.tags.includes(t)))
          return false;
        if (needle) {
          const hay = `${r.name}\n${r.content}`.toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        return true;
      },
      sort: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      limit: pagination?.limit ?? 50,
      offset: pagination?.offset ?? 0,
    });
  }

  search(q: string, type?: ContextType, limit?: number): AIContextRecord[] {
    const needle = q.toLowerCase();
    return this.live()
      .filter(
        (r) =>
          (!type || r.type === type) &&
          `${r.name}\n${r.content}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit ?? 20);
  }

  update(id: string, input: UpdateContextInput): AIContextRecord | null {
    const existing = this.getById(id);
    if (!existing) return null;
    if (input.type !== undefined && !VALID_TYPES.includes(input.type)) {
      throw new Error(`Invalid context type: ${input.type}`);
    }
    const next: AIContextRecord = {
      ...existing,
      name: input.name ?? existing.name,
      type: input.type ?? existing.type,
      content: input.content ?? existing.content,
      tags: input.tags ?? existing.tags,
      metadata: input.metadata ?? existing.metadata,
      updatedAt: new Date().toISOString(),
    };
    this.store.put(next);
    return next;
  }

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;
    const now = new Date().toISOString();
    this.store.put({ ...existing, deletedAt: now, updatedAt: now });
    return true;
  }

  getMultiple(ids: string[]): AIContextRecord[] {
    return ids
      .map((id) => this.getById(id))
      .filter((r): r is AIContextRecord => r !== null);
  }

  close(): void {
    /* no-op */
  }
}
