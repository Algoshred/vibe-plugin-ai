/**
 * KV-backed in-memory table.
 *
 * Wraps the agent's StorageProvider (async KV) with a synchronous
 * in-memory cache so route handlers can keep their existing sync API.
 *
 * Contract:
 *   - Construct with (storage, namespace, idField).
 *   - Call `await hydrate()` once at plugin boot before any reads.
 *   - Reads (get / all / filter) hit the in-memory Map and are sync.
 *   - Writes update the Map synchronously and fire an async
 *     storage.set / storage.delete — failures are logged, not thrown.
 *     Callers treat writes as persisted once the Map has been updated.
 *     On crash the last few writes may be lost; this is an acceptable
 *     trade for keeping the sync API and ~145 existing callers unchanged.
 *
 * Storage key = record[idField] (must be a string). Value is JSON.
 */
import type {
  StorageProvider,
  StorageEntry,
} from "./storage-provider-types.js";

export interface KVLogger {
  warn(source: string, msg: string): void;
  error(source: string, msg: string): void;
}

export class KVStore<T extends object> {
  private cache = new Map<string, T>();
  private hydrated = false;

  constructor(
    private storage: StorageProvider,
    private namespace: string,
    private idField: keyof T,
    private logger?: KVLogger,
  ) {}

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const entries: StorageEntry[] = await this.storage.list(this.namespace);
    for (const e of entries) {
      try {
        const rec = JSON.parse(e.value) as T;
        this.cache.set(e.key, rec);
      } catch (err) {
        this.logger?.warn(
          "kv-store",
          `[${this.namespace}] drop corrupt key ${e.key}: ${String(err)}`,
        );
      }
    }
    this.hydrated = true;
  }

  async replaceAll(records: T[]): Promise<void> {
    await this.storage.deleteAll(this.namespace);
    this.cache.clear();
    for (const rec of records) this.put(rec);
  }

  size(): number {
    return this.cache.size;
  }

  has(id: string): boolean {
    return this.cache.has(id);
  }

  get(id: string): T | null {
    return this.cache.get(id) ?? null;
  }

  all(): T[] {
    return Array.from(this.cache.values());
  }

  put(record: T): T {
    const id = record[this.idField] as unknown;
    if (typeof id !== "string" || !id) {
      throw new Error(
        `KVStore[${this.namespace}]: record missing string id field '${String(this.idField)}'`,
      );
    }
    this.cache.set(id, record);
    void this.storage
      .set(this.namespace, id, JSON.stringify(record))
      .catch((err) =>
        this.logger?.error(
          "kv-store",
          `[${this.namespace}] set ${id} failed: ${String(err)}`,
        ),
      );
    return record;
  }

  delete(id: string): boolean {
    const existed = this.cache.delete(id);
    if (existed) {
      void this.storage
        .delete(this.namespace, id)
        .catch((err) =>
          this.logger?.error(
            "kv-store",
            `[${this.namespace}] delete ${id} failed: ${String(err)}`,
          ),
        );
    }
    return existed;
  }

  deleteWhere(pred: (r: T) => boolean): number {
    let n = 0;
    for (const [id, rec] of this.cache.entries()) {
      if (pred(rec)) {
        this.cache.delete(id);
        n++;
        void this.storage
          .delete(this.namespace, id)
          .catch((err) =>
            this.logger?.error(
              "kv-store",
              `[${this.namespace}] delete ${id} failed: ${String(err)}`,
            ),
          );
      }
    }
    return n;
  }

  clear(): void {
    this.cache.clear();
    void this.storage
      .deleteAll(this.namespace)
      .catch((err) =>
        this.logger?.error(
          "kv-store",
          `[${this.namespace}] deleteAll failed: ${String(err)}`,
        ),
      );
  }
}

export interface ListQuery<T> {
  filter?: (r: T) => boolean;
  sort?: (a: T, b: T) => number;
  limit?: number;
  offset?: number;
}

export interface ListResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

export function query<T>(all: T[], q?: ListQuery<T>): ListResult<T> {
  let list = q?.filter ? all.filter(q.filter) : all.slice();
  if (q?.sort) list.sort(q.sort);
  const total = list.length;
  const offset = q?.offset ?? 0;
  const limit = q?.limit ?? list.length;
  list = list.slice(offset, offset + limit);
  return {
    items: list,
    total,
    hasMore: offset + list.length < total,
  };
}
