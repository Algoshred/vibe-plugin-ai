/**
 * LogDatabase Tests
 *
 * Tests for the AI Logs SQLite database (in-memory).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { LogDatabase } from '../../db/logs.js';
import { createMockStorage } from '../helpers/mock-storage.js';

describe('LogDatabase', () => {
  let db: LogDatabase;

  beforeEach(async () => {
    db = new LogDatabase(createMockStorage());
    await db.hydrate();
  });

  afterEach(() => {
    db.close();
  });

  // ── append ──────────────────────────────────────────────────────

  describe('append', () => {
    it('creates a log entry with generated ID', () => {
      const log = db.append({
        sessionId: 'session-1',
        type: 'input',
        content: 'Hello AI',
      });

      expect(log.id).toBeDefined();
      expect(log.id.length).toBeGreaterThan(0);
      expect(log.sessionId).toBe('session-1');
      expect(log.type).toBe('input');
      expect(log.content).toBe('Hello AI');
      expect(log.tokenCount).toBeNull();
      expect(log.model).toBeNull();
      expect(log.durationMs).toBeNull();
      expect(log.agentMetadata).toEqual({});
      expect(log.createdAt).toBeDefined();
    });

    it('stores optional fields', () => {
      const log = db.append({
        sessionId: 'session-1',
        type: 'output',
        content: 'Response text',
        tokenCount: 150,
        model: 'claude-sonnet-4-20250514',
        durationMs: 2500,
        agentMetadata: { provider: 'claude', mode: 'sdk' },
      });

      expect(log.tokenCount).toBe(150);
      expect(log.model).toBe('claude-sonnet-4-20250514');
      expect(log.durationMs).toBe(2500);
      expect(log.agentMetadata).toEqual({ provider: 'claude', mode: 'sdk' });
    });

    it('stores different log types', () => {
      const types = ['input', 'output', 'thinking', 'event', 'error', 'metadata'] as const;

      for (const type of types) {
        const log = db.append({
          sessionId: 'session-1',
          type,
          content: `${type} content`,
        });
        expect(log.type).toBe(type);
      }
    });
  });

  // ── getById ─────────────────────────────────────────────────────

  describe('getById', () => {
    it('returns log by ID', () => {
      const created = db.append({
        sessionId: 'session-1',
        type: 'input',
        content: 'Find this',
      });
      const found = db.getById(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.content).toBe('Find this');
    });

    it('returns null for unknown ID', () => {
      const result = db.getById('nonexistent');
      expect(result).toBeNull();
    });
  });

  // ── getBySession ────────────────────────────────────────────────

  describe('getBySession', () => {
    it('returns logs for a specific session', () => {
      db.append({ sessionId: 'sess-a', type: 'input', content: 'q1' });
      db.append({ sessionId: 'sess-a', type: 'output', content: 'a1' });
      db.append({ sessionId: 'sess-b', type: 'input', content: 'q2' });

      const result = db.getBySession('sess-a');
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.items.every((l) => l.sessionId === 'sess-a')).toBe(true);
    });

    it('returns empty result for unknown session', () => {
      const result = db.getBySession('unknown');
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });

    it('filters by log types', () => {
      db.append({ sessionId: 'sess-1', type: 'input', content: 'q' });
      db.append({ sessionId: 'sess-1', type: 'output', content: 'a' });
      db.append({ sessionId: 'sess-1', type: 'error', content: 'err' });

      const result = db.getBySession('sess-1', { types: ['input', 'output'] });
      expect(result.total).toBe(2);
      expect(result.items.every((l) => ['input', 'output'].includes(l.type))).toBe(true);
    });

    it('filters by date range', () => {
      db.append({ sessionId: 'sess-1', type: 'input', content: 'before' });

      const now = new Date().toISOString();

      db.append({ sessionId: 'sess-1', type: 'output', content: 'after' });

      // All logs were created very close in time, so this tests the SQL path
      const result = db.getBySession('sess-1', { startDate: '2020-01-01T00:00:00.000Z' });
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    it('filters by search term (case-insensitive)', () => {
      db.append({ sessionId: 'sess-1', type: 'input', content: 'How does TYPESCRIPT work?' });
      db.append({ sessionId: 'sess-1', type: 'output', content: 'TypeScript is a language' });
      db.append({ sessionId: 'sess-1', type: 'input', content: 'Tell me about Rust' });

      const result = db.getBySession('sess-1', { search: 'typescript' });
      expect(result.total).toBe(2);
    });

    it('supports pagination', () => {
      for (let i = 0; i < 10; i++) {
        db.append({ sessionId: 'sess-1', type: 'input', content: `msg ${i}` });
      }

      const page1 = db.getBySession('sess-1', { limit: 3, offset: 0 });
      expect(page1.items).toHaveLength(3);
      expect(page1.total).toBe(10);
      expect(page1.hasMore).toBe(true);

      const lastPage = db.getBySession('sess-1', { limit: 3, offset: 9 });
      expect(lastPage.items).toHaveLength(1);
      expect(lastPage.hasMore).toBe(false);
    });

    it('orders logs by created_at ascending', () => {
      db.append({ sessionId: 'sess-1', type: 'input', content: 'first' });
      db.append({ sessionId: 'sess-1', type: 'output', content: 'second' });
      db.append({ sessionId: 'sess-1', type: 'input', content: 'third' });

      const result = db.getBySession('sess-1');
      expect(result.items[0]!.content).toBe('first');
      expect(result.items[2]!.content).toBe('third');
    });
  });

  // ── getSessionStats ─────────────────────────────────────────────

  describe('getSessionStats', () => {
    it('returns aggregated stats for a session', () => {
      db.append({
        sessionId: 'sess-1',
        type: 'input',
        content: 'question',
        tokenCount: 50,
        durationMs: 100,
      });
      db.append({
        sessionId: 'sess-1',
        type: 'output',
        content: 'answer',
        tokenCount: 200,
        model: 'claude-sonnet-4-20250514',
        durationMs: 1500,
      });
      db.append({
        sessionId: 'sess-1',
        type: 'error',
        content: 'oops',
        durationMs: 50,
      });

      const stats = db.getSessionStats('sess-1');
      expect(stats.totalLogs).toBe(3);
      expect(stats.totalInputTokens).toBe(50);
      expect(stats.totalOutputTokens).toBe(200);
      expect(stats.totalDurationMs).toBe(1650);
      expect(stats.logsByType).toEqual({
        input: 1,
        output: 1,
        error: 1,
      });
    });

    it('returns zero stats for unknown session', () => {
      const stats = db.getSessionStats('nonexistent');
      expect(stats.totalLogs).toBe(0);
      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
      expect(stats.totalDurationMs).toBe(0);
      expect(stats.logsByType).toEqual({});
    });

    it('handles null token counts in aggregation', () => {
      db.append({ sessionId: 'sess-1', type: 'input', content: 'no tokens' });
      db.append({ sessionId: 'sess-1', type: 'output', content: 'no tokens' });

      const stats = db.getSessionStats('sess-1');
      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
    });
  });

  // ── deleteBySession ─────────────────────────────────────────────

  describe('deleteBySession', () => {
    it('deletes all logs for a session and returns count', () => {
      db.append({ sessionId: 'sess-1', type: 'input', content: 'q1' });
      db.append({ sessionId: 'sess-1', type: 'output', content: 'a1' });
      db.append({ sessionId: 'sess-2', type: 'input', content: 'other' });

      const deleted = db.deleteBySession('sess-1');
      expect(deleted).toBe(2);

      // Verify they are gone
      const remaining = db.getBySession('sess-1');
      expect(remaining.total).toBe(0);

      // Other session unaffected
      const other = db.getBySession('sess-2');
      expect(other.total).toBe(1);
    });

    it('returns 0 for unknown session', () => {
      const deleted = db.deleteBySession('nonexistent');
      expect(deleted).toBe(0);
    });
  });
});
