/**
 * AI Sessions — KV-backed session registry.
 *
 * Thin wrapper around KVStore<AISessionRecord>. Reads hit an in-memory
 * cache; writes update the cache synchronously and fire an async
 * storage.set/delete against the agent's encrypted StorageProvider.
 */

import { KVStore, query } from "./kv-store.js";
import type { KVLogger } from "./kv-store.js";
import type { StorageProvider } from "./storage-provider-types.js";

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

const NAMESPACE = "ai:sessions";
const DEFAULT_STATS: Record<string, unknown> = {
  inputTokens: 0,
  outputTokens: 0,
  requestCount: 0,
  estimatedCostUsd: 0,
};

export class SessionDatabase {
  readonly store: KVStore<AISessionRecord>;

  constructor(storage: StorageProvider, logger?: KVLogger) {
    this.store = new KVStore(storage, NAMESPACE, "id", logger);
  }

  async hydrate(): Promise<void> {
    await this.store.hydrate();
  }

  async create(input: CreateSessionInput): Promise<AISessionRecord> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const rec: AISessionRecord = {
      id,
      name: input.name,
      agentType: input.agentType,
      providerPlugin: input.providerPlugin || input.agentType,
      config: input.config || {},
      status: "idle",
      stats: { ...DEFAULT_STATS },
      createdAt: now,
      updatedAt: now,
      terminatedAt: null,
    };
    // Durable write — the UI hands the returned sessionId to a CLI that
    // expects to look it up immediately. A fire-and-forget put would lose
    // sessions if the agent crashed between cache update and disk flush,
    // surfacing as "Session not found" on the very next request.
    await this.store.putDurable(rec);
    return rec;
  }

  getById(id: string): AISessionRecord | null {
    return this.store.get(id);
  }

  list(
    filter?: { agentType?: string; status?: SessionStatus; search?: string },
    pagination?: { limit?: number; offset?: number },
  ): { items: AISessionRecord[]; total: number; hasMore: boolean } {
    const needle = filter?.search?.toLowerCase();
    return query(this.store.all(), {
      filter: (r) =>
        (!filter?.agentType || r.agentType === filter.agentType) &&
        (!filter?.status || r.status === filter.status) &&
        (!needle || r.name.toLowerCase().includes(needle)),
      sort: (a, b) => b.createdAt.localeCompare(a.createdAt),
      limit: pagination?.limit ?? 50,
      offset: pagination?.offset ?? 0,
    });
  }

  update(id: string, input: UpdateSessionInput): AISessionRecord | null {
    const existing = this.store.get(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const next: AISessionRecord = {
      ...existing,
      updatedAt: now,
    };
    if (input.name !== undefined) next.name = input.name;
    if (input.config !== undefined) next.config = input.config;
    if (input.stats !== undefined) next.stats = input.stats;
    if (input.status !== undefined) {
      next.status = input.status;
      if (input.status === "terminated" && !next.terminatedAt) {
        next.terminatedAt = now;
      }
    }
    this.store.put(next);
    return next;
  }

  terminate(id: string): boolean {
    const existing = this.store.get(id);
    if (!existing || existing.status === "terminated") return false;
    const now = new Date().toISOString();
    this.store.put({
      ...existing,
      status: "terminated",
      terminatedAt: now,
      updatedAt: now,
    });
    return true;
  }

  close(): void {
    /* KVStore is fire-and-forget; nothing to close. */
  }
}
