/**
 * Queue REST API Routes
 *
 * Manage the prompt dispatch queue.
 * Mounted at /api/ai/queue by the plugin system.
 */

import { Elysia, t } from "elysia";
import type { QueueDatabase, QueueStatus } from "../db/queue.js";

export function createQueueRoutes(queueDb: QueueDatabase) {
  return new Elysia({ prefix: "/queue" })
    // ── GET /queue — List queue items ─────────────────────────────────
    .get(
      "/",
      ({ query }) => {
        const filter: { status?: QueueStatus } = {};
        if (query.status) filter.status = query.status as QueueStatus;

        const pagination = {
          limit: query.limit ? parseInt(query.limit, 10) : 50,
          offset: query.offset ? parseInt(query.offset, 10) : 0,
        };

        return queueDb.list(
          Object.keys(filter).length > 0 ? filter : undefined,
          pagination,
        );
      },
      {
        query: t.Object({
          status: t.Optional(t.String()),
          limit: t.Optional(t.String()),
          offset: t.Optional(t.String()),
        }),
      },
    )

    // ── POST /queue/enqueue — Add to queue ────────────────────────────
    .post(
      "/enqueue",
      ({ body, set }) => {
        try {
          const item = queueDb.enqueue(body);
          set.status = 201;
          return item;
        } catch (err) {
          set.status = 400;
          return {
            error: err instanceof Error ? err.message : "Failed to enqueue",
          };
        }
      },
      {
        body: t.Object({
          dispatchedPromptId: t.String({ minLength: 1 }),
          sessionId: t.String({ minLength: 1 }),
          priority: t.Optional(t.Number()),
          scheduledAt: t.Optional(t.String()),
          maxAttempts: t.Optional(t.Number()),
        }),
      },
    )

    // ── GET /queue/:id — Get queue item ───────────────────────────────
    .get(
      "/:id",
      ({ params, set }) => {
        const item = queueDb.getById(params.id);
        if (!item) {
          set.status = 404;
          return { error: "Queue item not found" };
        }
        return item;
      },
      { params: t.Object({ id: t.String() }) },
    )

    // ── POST /queue/:id/cancel — Cancel queue item ────────────────────
    .post(
      "/:id/cancel",
      ({ params, set }) => {
        const cancelled = queueDb.cancel(params.id);
        if (!cancelled) {
          set.status = 404;
          return { error: "Queue item not found or already processed" };
        }
        return { success: true };
      },
      { params: t.Object({ id: t.String() }) },
    )

    // ── DELETE /queue/:id — Remove queue item ─────────────────────────
    .delete(
      "/:id",
      ({ params, set }) => {
        const cancelled = queueDb.cancel(params.id);
        if (!cancelled) {
          set.status = 404;
          return { error: "Queue item not found or already processed" };
        }
        return { success: true };
      },
      { params: t.Object({ id: t.String() }) },
    );
}
