/**
 * AI Logs — KV-backed per-session log store.
 *
 * Tracks input, output, thinking steps, events, errors, and metadata
 * from AI agent providers. Each log record is keyed by its UUID under
 * the `ai:logs` namespace.
 */

import { KVStore, query } from "./kv-store.js";
import type { KVLogger } from "./kv-store.js";
import type { StorageProvider } from "./storage-provider-types.js";

// ── Types ───────────────────────────────────────────────────────────────

export type LogType =
  | "input"
  | "output"
  | "thinking"
  | "event"
  | "error"
  | "metadata";

export interface AILogRecord {
  id: string;
  sessionId: string;
  type: LogType;
  content: string;
  tokenCount: number | null;
  model: string | null;
  durationMs: number | null;
  agentMetadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateLogInput {
  sessionId: string;
  type: LogType;
  content: string;
  tokenCount?: number;
  model?: string;
  durationMs?: number;
  agentMetadata?: Record<string, unknown>;
}

export interface LogFilter {
  types?: LogType[];
  startDate?: string;
  endDate?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

const NAMESPACE = "ai:logs";

export class LogDatabase {
  readonly store: KVStore<AILogRecord>;

  constructor(storage: StorageProvider, logger?: KVLogger) {
    this.store = new KVStore(storage, NAMESPACE, "id", logger);
  }

  async hydrate(): Promise<void> {
    await this.store.hydrate();
  }

  append(input: CreateLogInput): AILogRecord {
    const id = crypto.randomUUID();
    const rec: AILogRecord = {
      id,
      sessionId: input.sessionId,
      type: input.type,
      content: input.content,
      tokenCount: input.tokenCount ?? null,
      model: input.model ?? null,
      durationMs: input.durationMs ?? null,
      agentMetadata: input.agentMetadata || {},
      createdAt: new Date().toISOString(),
    };
    this.store.put(rec);
    return rec;
  }

  getById(id: string): AILogRecord | null {
    return this.store.get(id);
  }

  getBySession(
    sessionId: string,
    filter?: LogFilter,
  ): { items: AILogRecord[]; total: number; hasMore: boolean } {
    const types = filter?.types;
    const needle = filter?.search?.toLowerCase();
    return query(this.store.all(), {
      filter: (r) => {
        if (r.sessionId !== sessionId) return false;
        if (types && types.length > 0 && !types.includes(r.type)) return false;
        if (filter?.startDate && r.createdAt < filter.startDate) return false;
        if (filter?.endDate && r.createdAt > filter.endDate) return false;
        if (needle && !r.content.toLowerCase().includes(needle)) return false;
        return true;
      },
      sort: (a, b) => a.createdAt.localeCompare(b.createdAt),
      limit: filter?.limit ?? 100,
      offset: filter?.offset ?? 0,
    });
  }

  getSessionStats(sessionId: string): {
    totalLogs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalDurationMs: number;
    logsByType: Record<string, number>;
  } {
    let totalInput = 0;
    let totalOutput = 0;
    let totalDuration = 0;
    let totalLogs = 0;
    const logsByType: Record<string, number> = {};
    for (const r of this.store.all()) {
      if (r.sessionId !== sessionId) continue;
      totalLogs++;
      logsByType[r.type] = (logsByType[r.type] || 0) + 1;
      if (r.type === "input") totalInput += r.tokenCount ?? 0;
      if (r.type === "output") totalOutput += r.tokenCount ?? 0;
      totalDuration += r.durationMs ?? 0;
    }
    return {
      totalLogs,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalDurationMs: totalDuration,
      logsByType,
    };
  }

  deleteBySession(sessionId: string): number {
    return this.store.deleteWhere((r) => r.sessionId === sessionId);
  }

  close(): void {
    /* no-op */
  }
}
