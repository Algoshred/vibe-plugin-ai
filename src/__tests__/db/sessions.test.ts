/**
 * SessionDatabase Tests
 *
 * Tests for the AI Sessions store (in-memory).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SessionDatabase } from "../../db/sessions.js";
import { createMockStorage } from "../helpers/mock-storage.js";

describe("SessionDatabase", () => {
  let db: SessionDatabase;

  beforeEach(async () => {
    db = new SessionDatabase(createMockStorage());
    await db.hydrate();
  });

  afterEach(() => {
    db.close();
  });

  // ── create ──────────────────────────────────────────────────────

  describe("create", () => {
    it("creates a session with generated ID and default status", () => {
      const session = db.create({
        name: "Test Session",
        agentType: "claude",
      });

      expect(session.id).toBeDefined();
      expect(session.id.length).toBeGreaterThan(0);
      expect(session.name).toBe("Test Session");
      expect(session.agentType).toBe("claude");
      expect(session.providerPlugin).toBe("claude"); // defaults to agentType
      expect(session.status).toBe("idle");
      expect(session.config).toEqual({});
      expect(session.createdAt).toBeDefined();
      expect(session.updatedAt).toBeDefined();
      expect(session.terminatedAt).toBeNull();
    });

    it("uses providerPlugin when specified", () => {
      const session = db.create({
        name: "Custom Provider",
        agentType: "claude",
        providerPlugin: "claude-custom",
      });

      expect(session.providerPlugin).toBe("claude-custom");
    });

    it("stores config as JSON", () => {
      const config = { model: "claude-sonnet-4-20250514", maxTokens: 8192 };
      const session = db.create({
        name: "With Config",
        agentType: "claude",
        config,
      });

      expect(session.config).toEqual(config);
    });
  });

  // ── getById ─────────────────────────────────────────────────────

  describe("getById", () => {
    it("returns session by ID", () => {
      const created = db.create({ name: "Find Me", agentType: "codex" });
      const found = db.getById(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe("Find Me");
    });

    it("returns null for unknown ID", () => {
      const result = db.getById("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  // ── list ────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns all sessions with total count", () => {
      db.create({ name: "S1", agentType: "claude" });
      db.create({ name: "S2", agentType: "codex" });
      db.create({ name: "S3", agentType: "claude" });

      const result = db.list();
      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(3);
    });

    it("filters by agentType", () => {
      db.create({ name: "Claude 1", agentType: "claude" });
      db.create({ name: "Claude 2", agentType: "claude" });
      db.create({ name: "Codex 1", agentType: "codex" });

      const result = db.list({ agentType: "claude" });
      expect(result.total).toBe(2);
      expect(result.items.every((s) => s.agentType === "claude")).toBe(true);
    });

    it("filters by status", () => {
      const s1 = db.create({ name: "Active", agentType: "claude" });
      db.create({ name: "Idle", agentType: "claude" });

      db.update(s1.id, { status: "active" });

      const result = db.list({ status: "active" });
      expect(result.total).toBe(1);
      expect(result.items[0]!.status).toBe("active");
    });

    it("supports pagination with limit and offset", () => {
      for (let i = 0; i < 10; i++) {
        db.create({ name: `Session ${i}`, agentType: "claude" });
      }

      const page1 = db.list(undefined, { limit: 3, offset: 0 });
      expect(page1.items).toHaveLength(3);
      expect(page1.total).toBe(10);
      expect(page1.hasMore).toBe(true);

      const page2 = db.list(undefined, { limit: 3, offset: 3 });
      expect(page2.items).toHaveLength(3);
      expect(page2.hasMore).toBe(true);

      const lastPage = db.list(undefined, { limit: 3, offset: 9 });
      expect(lastPage.items).toHaveLength(1);
      expect(lastPage.hasMore).toBe(false);
    });

    it("returns empty result when no sessions exist", () => {
      const result = db.list();
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });

    it("combines filters", () => {
      const s1 = db.create({ name: "Active Claude", agentType: "claude" });
      db.create({ name: "Idle Claude", agentType: "claude" });
      db.create({ name: "Active Codex", agentType: "codex" });

      db.update(s1.id, { status: "active" });

      const result = db.list({ agentType: "claude", status: "active" });
      expect(result.total).toBe(1);
      expect(result.items[0]!.name).toBe("Active Claude");
    });
  });

  // ── update ──────────────────────────────────────────────────────

  describe("update", () => {
    it("updates name", () => {
      const session = db.create({ name: "Old Name", agentType: "claude" });
      const updated = db.update(session.id, { name: "New Name" });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("New Name");
    });

    it("updates config", () => {
      const session = db.create({ name: "S", agentType: "claude" });
      const newConfig = { model: "claude-opus-4-20250514" };
      const updated = db.update(session.id, { config: newConfig });

      expect(updated!.config).toEqual(newConfig);
    });

    it("updates status", () => {
      const session = db.create({ name: "S", agentType: "claude" });
      const updated = db.update(session.id, { status: "processing" });

      expect(updated!.status).toBe("processing");
    });

    it("sets terminatedAt when status becomes terminated", () => {
      const session = db.create({ name: "S", agentType: "claude" });
      const updated = db.update(session.id, { status: "terminated" });

      expect(updated!.status).toBe("terminated");
      expect(updated!.terminatedAt).not.toBeNull();
    });

    it("updates stats", () => {
      const session = db.create({ name: "S", agentType: "claude" });
      const newStats = {
        inputTokens: 100,
        outputTokens: 200,
        requestCount: 5,
        estimatedCostUsd: 0.01,
      };
      const updated = db.update(session.id, { stats: newStats });

      expect(updated!.stats).toEqual(newStats);
    });

    it("sets updatedAt on update", () => {
      const session = db.create({ name: "S", agentType: "claude" });
      const updated = db.update(session.id, { name: "Changed" });

      // updatedAt should be a valid ISO string
      expect(updated!.updatedAt).toBeDefined();
      expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(0);
    });

    it("returns null for unknown ID", () => {
      const result = db.update("nonexistent", { name: "X" });
      expect(result).toBeNull();
    });
  });

  // ── terminate ───────────────────────────────────────────────────

  describe("terminate", () => {
    it("terminates an active session", () => {
      const session = db.create({ name: "Active", agentType: "claude" });
      const result = db.terminate(session.id);

      expect(result).toBe(true);

      const terminated = db.getById(session.id);
      expect(terminated!.status).toBe("terminated");
      expect(terminated!.terminatedAt).not.toBeNull();
    });

    it("returns false for already terminated session", () => {
      const session = db.create({ name: "Done", agentType: "claude" });
      db.terminate(session.id);

      const result = db.terminate(session.id);
      expect(result).toBe(false);
    });

    it("returns false for unknown ID", () => {
      const result = db.terminate("no-such-id");
      expect(result).toBe(false);
    });
  });
});
