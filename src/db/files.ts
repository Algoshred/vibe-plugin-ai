/**
 * AI Files — KV-backed file attachment metadata store.
 *
 * File blobs live on disk under {dataDir}/ai-files/<sessionId>/; this
 * table only tracks the metadata (id, filename, size, path, mime).
 */

import { KVStore } from "./kv-store.js";
import type { KVLogger } from "./kv-store.js";
import type { StorageProvider } from "./storage-provider-types.js";

// ── Types ───────────────────────────────────────────────────────────────

export interface AIFileRecord {
  id: string;
  sessionId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: string;
}

export interface CreateFileInput {
  sessionId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
}

const NAMESPACE = "ai:files";

export class FileDatabase {
  readonly store: KVStore<AIFileRecord>;

  constructor(storage: StorageProvider, logger?: KVLogger) {
    this.store = new KVStore(storage, NAMESPACE, "id", logger);
  }

  async hydrate(): Promise<void> {
    await this.store.hydrate();
  }

  add(input: CreateFileInput): AIFileRecord {
    const rec: AIFileRecord = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.size,
      path: input.path,
      createdAt: new Date().toISOString(),
    };
    this.store.put(rec);
    return rec;
  }

  getById(id: string): AIFileRecord | null {
    return this.store.get(id);
  }

  list(sessionId: string): AIFileRecord[] {
    return this.store
      .all()
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }

  deleteBySession(sessionId: string): number {
    return this.store.deleteWhere((r) => r.sessionId === sessionId);
  }

  close(): void {
    /* no-op */
  }
}
