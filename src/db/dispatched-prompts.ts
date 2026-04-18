/**
 * Dispatched Prompts — KV-backed store.
 *
 * Tracks composed prompts that have been assembled from templates,
 * variables, and contexts, and dispatched to AI sessions.
 */

import { KVStore, query } from "./kv-store.js";
import type { KVLogger } from "./kv-store.js";
import type { StorageProvider } from "./storage-provider-types.js";

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

const NAMESPACE = "ai:dispatched";

export class DispatchedPromptDatabase {
  readonly store: KVStore<DispatchedPromptRecord>;

  constructor(storage: StorageProvider, logger?: KVLogger) {
    this.store = new KVStore(storage, NAMESPACE, "id", logger);
  }

  async hydrate(): Promise<void> {
    await this.store.hydrate();
  }

  create(input: CreateDispatchInput): DispatchedPromptRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const rec: DispatchedPromptRecord = {
      id,
      templateId: input.templateId ?? null,
      content: input.content,
      resolvedVariables: input.resolvedVariables || {},
      contextIds: input.contextIds || [],
      sessionId: input.sessionId ?? null,
      status: "draft",
      result: null,
      scheduledAt: input.scheduledAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.put(rec);
    return rec;
  }

  getById(id: string): DispatchedPromptRecord | null {
    return this.store.get(id);
  }

  list(
    filter?: { status?: DispatchStatus; sessionId?: string },
    pagination?: { limit?: number; offset?: number },
  ): { items: DispatchedPromptRecord[]; total: number; hasMore: boolean } {
    return query(this.store.all(), {
      filter: (r) =>
        (!filter?.status || r.status === filter.status) &&
        (!filter?.sessionId || r.sessionId === filter.sessionId),
      sort: (a, b) => b.createdAt.localeCompare(a.createdAt),
      limit: pagination?.limit ?? 50,
      offset: pagination?.offset ?? 0,
    });
  }

  update(
    id: string,
    input: UpdateDispatchInput,
  ): DispatchedPromptRecord | null {
    const existing = this.store.get(id);
    if (!existing) return null;
    const next: DispatchedPromptRecord = {
      ...existing,
      status: input.status ?? existing.status,
      sessionId:
        input.sessionId !== undefined ? input.sessionId : existing.sessionId,
      result: input.result !== undefined ? input.result : existing.result,
      updatedAt: new Date().toISOString(),
    };
    this.store.put(next);
    return next;
  }

  getQueued(limit?: number): DispatchedPromptRecord[] {
    const now = new Date().toISOString();
    return this.store
      .all()
      .filter(
        (r) =>
          r.status === "queued" &&
          (r.scheduledAt === null || r.scheduledAt <= now),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit ?? 10);
  }

  close(): void {
    /* no-op */
  }
}
