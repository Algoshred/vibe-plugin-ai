/**
 * Prompt Queue — KV-backed priority queue.
 *
 * Priority-based queue for prompt dispatch. Supports immediate,
 * scheduled, and event-triggered execution.
 */

import { KVStore, query } from "./kv-store.js";
import type { KVLogger } from "./kv-store.js";
import type { StorageProvider } from "./storage-provider-types.js";

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

const NAMESPACE = "ai:queue";

export class QueueDatabase {
  readonly store: KVStore<QueueItem>;

  constructor(storage: StorageProvider, logger?: KVLogger) {
    this.store = new KVStore(storage, NAMESPACE, "id", logger);
  }

  async hydrate(): Promise<void> {
    await this.store.hydrate();
  }

  enqueue(input: EnqueueInput): QueueItem {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const rec: QueueItem = {
      id,
      dispatchedPromptId: input.dispatchedPromptId,
      sessionId: input.sessionId,
      priority: input.priority ?? 0,
      scheduledAt: input.scheduledAt ?? null,
      status: "pending",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.put(rec);
    return rec;
  }

  getById(id: string): QueueItem | null {
    return this.store.get(id);
  }

  list(
    filter?: { status?: QueueStatus },
    pagination?: { limit?: number; offset?: number },
  ): { items: QueueItem[]; total: number; hasMore: boolean } {
    return query(this.store.all(), {
      filter: (r) => !filter?.status || r.status === filter.status,
      sort: (a, b) =>
        b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
      limit: pagination?.limit ?? 50,
      offset: pagination?.offset ?? 0,
    });
  }

  /** Get next batch of items ready for processing */
  getReady(limit?: number): QueueItem[] {
    const now = new Date().toISOString();
    return this.store
      .all()
      .filter(
        (r) =>
          r.status === "pending" &&
          (r.scheduledAt === null || r.scheduledAt <= now) &&
          r.attempts < r.maxAttempts,
      )
      .sort(
        (a, b) =>
          b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
      )
      .slice(0, limit ?? 5);
  }

  markProcessing(id: string): boolean {
    const existing = this.store.get(id);
    if (!existing || existing.status !== "pending") return false;
    this.store.put({
      ...existing,
      status: "processing",
      attempts: existing.attempts + 1,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  markCompleted(id: string): boolean {
    const existing = this.store.get(id);
    if (!existing) return false;
    this.store.put({
      ...existing,
      status: "completed",
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  markFailed(id: string, error: string): boolean {
    const existing = this.store.get(id);
    if (!existing) return false;
    const newStatus: QueueStatus =
      existing.attempts >= existing.maxAttempts ? "failed" : "pending";
    this.store.put({
      ...existing,
      status: newStatus,
      lastError: error,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  cancel(id: string): boolean {
    const existing = this.store.get(id);
    if (
      !existing ||
      (existing.status !== "pending" && existing.status !== "processing")
    ) {
      return false;
    }
    this.store.put({
      ...existing,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  close(): void {
    /* no-op */
  }
}
