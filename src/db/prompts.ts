/**
 * AI Prompts — KV-backed prompt library.
 *
 * Reusable prompt templates with variable substitution. Mirrors the
 * backend Prompt model but stored locally on the developer's machine.
 */

import { KVStore, query } from "./kv-store.js";
import type { KVLogger } from "./kv-store.js";
import type { StorageProvider } from "./storage-provider-types.js";

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

const NAMESPACE = "ai:prompts";

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
  readonly store: KVStore<Prompt>;

  constructor(storage: StorageProvider, logger?: KVLogger) {
    this.store = new KVStore(storage, NAMESPACE, "id", logger);
  }

  async hydrate(): Promise<void> {
    await this.store.hydrate();
  }

  private live(): Prompt[] {
    return this.store.all().filter((p) => !p.deletedAt);
  }

  private extractVariables(content: string): string[] {
    const re = /\{\{(\w+)\}\}/g;
    const out: string[] = [];
    let m;
    while ((m = re.exec(content)) !== null) {
      if (m[1] && !out.includes(m[1])) out.push(m[1]);
    }
    return out;
  }

  create(input: CreatePromptInput): Prompt {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const rec: Prompt = {
      id,
      name: input.name,
      content: input.content,
      category:
        input.category && VALID_CATEGORIES.includes(input.category)
          ? input.category
          : null,
      tags: input.tags || [],
      variables: input.variables || this.extractVariables(input.content),
      isShared: !!input.isShared,
      createdBy: "local",
      usageCount: 0,
      lastUsed: null,
      metadata: input.metadata || {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.store.put(rec);
    return rec;
  }

  getById(id: string): Prompt | null {
    const rec = this.store.get(id);
    return rec && !rec.deletedAt ? rec : null;
  }

  list(
    filter?: PromptFilter,
    pagination?: { limit?: number; offset?: number },
  ): { items: Prompt[]; total: number; hasMore: boolean } {
    const tags = filter?.tags;
    return query(this.live(), {
      filter: (r) => {
        if (filter?.category && r.category !== filter.category) return false;
        if (filter?.isShared !== undefined && r.isShared !== filter.isShared)
          return false;
        if (filter?.createdBy && r.createdBy !== filter.createdBy) return false;
        if (tags && tags.length > 0 && !tags.some((t) => r.tags.includes(t)))
          return false;
        return true;
      },
      sort: (a, b) => b.createdAt.localeCompare(a.createdAt),
      limit: pagination?.limit ?? 50,
      offset: pagination?.offset ?? 0,
    });
  }

  search(q: string, category?: PromptCategory, limit?: number): Prompt[] {
    const needle = q.toLowerCase();
    return this.live()
      .filter(
        (r) =>
          (!category || r.category === category) &&
          `${r.name}\n${r.content}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, limit ?? 20);
  }

  getPopular(limit?: number): Prompt[] {
    return this.live()
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, limit ?? 10);
  }

  update(id: string, input: UpdatePromptInput): Prompt | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const next: Prompt = {
      ...existing,
      name: input.name ?? existing.name,
      content: input.content ?? existing.content,
      category:
        input.category !== undefined ? input.category : existing.category,
      tags: input.tags ?? existing.tags,
      isShared: input.isShared ?? existing.isShared,
      metadata: input.metadata ?? existing.metadata,
      updatedAt: new Date().toISOString(),
    };
    if (input.content !== undefined) {
      next.variables = input.variables || this.extractVariables(input.content);
    } else if (input.variables !== undefined) {
      next.variables = input.variables;
    }
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

  use(id: string): Prompt | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const next: Prompt = {
      ...existing,
      usageCount: existing.usageCount + 1,
      lastUsed: now,
      updatedAt: now,
    };
    this.store.put(next);
    return next;
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
    for (const [k, v] of Object.entries(variables)) {
      const ph = `{{${k}}}`;
      while (rendered.includes(ph)) rendered = rendered.replace(ph, String(v));
    }
    return rendered;
  }

  renderById(id: string, variables: Record<string, unknown>): string | null {
    const p = this.getById(id);
    return p ? this.renderPrompt(p.content, variables) : null;
  }

  close(): void {
    /* no-op */
  }
}
