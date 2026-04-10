/**
 * AI Files SQLite Database
 *
 * Tracks file attachments for AI sessions. Files are stored on disk
 * at ~/.vibecontrols/ai-files/<sessionId>/ and metadata is tracked here.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import os from "node:os";
import { existsSync, mkdirSync } from "node:fs";

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

// ── Database Row ────────────────────────────────────────────────────────

interface FileRow {
  id: string;
  session_id: string;
  filename: string;
  mime_type: string;
  size: number;
  path: string;
  created_at: string;
}

// ── FileDatabase ────────────────────────────────────────────────────────

export class FileDatabase {
  private db: Database;

  constructor(dbPath?: string) {
    const dir = join(os.homedir(), ".vibecontrols");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const path = dbPath || join(dir, "ai-files.db");
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_files (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        size INTEGER NOT NULL DEFAULT 0,
        path TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_files_session_id ON ai_files(session_id);
    `);
  }

  private rowToFile(row: FileRow): AIFileRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      filename: row.filename,
      mimeType: row.mime_type,
      size: row.size,
      path: row.path,
      createdAt: row.created_at,
    };
  }

  add(input: CreateFileInput): AIFileRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO ai_files (id, session_id, filename, mime_type, size, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.filename,
        input.mimeType,
        input.size,
        input.path,
        now,
      );

    return this.getById(id)!;
  }

  getById(id: string): AIFileRecord | null {
    const row = this.db
      .prepare("SELECT * FROM ai_files WHERE id = ?")
      .get(id) as FileRow | null;
    return row ? this.rowToFile(row) : null;
  }

  list(sessionId: string): AIFileRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM ai_files WHERE session_id = ? ORDER BY created_at ASC",
      )
      .all(sessionId) as FileRow[];
    return rows.map((r) => this.rowToFile(r));
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM ai_files WHERE id = ?").run(id);
    return result.changes > 0;
  }

  deleteBySession(sessionId: string): number {
    const result = this.db
      .prepare("DELETE FROM ai_files WHERE session_id = ?")
      .run(sessionId);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
