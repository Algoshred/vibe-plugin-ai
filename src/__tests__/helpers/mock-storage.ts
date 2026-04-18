/**
 * In-memory StorageProvider for tests.
 *
 * Matches the contract in src/db/storage-provider-types.ts — keys are
 * namespaced, values are opaque JSON strings.
 */
import type {
  StorageProvider,
  StorageEntry,
} from "../../db/storage-provider-types.js";

export function createMockStorage(): StorageProvider {
  const store = new Map<string, Map<string, StorageEntry>>();

  function ns(namespace: string): Map<string, StorageEntry> {
    let m = store.get(namespace);
    if (!m) {
      m = new Map();
      store.set(namespace, m);
    }
    return m;
  }

  return {
    async get(namespace, key) {
      return ns(namespace).get(key)?.value ?? null;
    },
    async set(namespace, key, value) {
      const now = new Date().toISOString();
      const existing = ns(namespace).get(key);
      ns(namespace).set(key, {
        key,
        value,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    },
    async delete(namespace, key) {
      return ns(namespace).delete(key);
    },
    async list(namespace) {
      return Array.from(ns(namespace).values());
    },
    async deleteAll(namespace) {
      const m = ns(namespace);
      const n = m.size;
      m.clear();
      return n;
    },
  };
}
