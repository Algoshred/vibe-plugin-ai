/**
 * Local copy of the agent's StorageProvider shape. Duplicated here so
 * the plugin doesn't take a hard import on vibecontrols-agent — the
 * runtime object is passed in via HostServices.storage at plugin init.
 */
export interface StorageEntry {
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface StorageProvider {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  delete(namespace: string, key: string): Promise<boolean>;
  list(namespace: string): Promise<StorageEntry[]>;
  deleteAll(namespace: string): Promise<number>;
}
