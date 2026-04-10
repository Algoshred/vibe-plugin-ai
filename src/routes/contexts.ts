/**
 * Context REST API Routes
 *
 * Elysia routes for context CRUD operations.
 * Mounted at /api/ai/contexts by the plugin system.
 */

import { Elysia, t } from "elysia";
import type { ContextDatabase, ContextType } from "../db/contexts.js";

export function createContextRoutes(contextDb: ContextDatabase) {
  return (
    new Elysia()
      // ── GET /contexts — List contexts ─────────────────────────────────
      .get(
        "/contexts",
        ({ query }) => {
          const filter: {
            type?: ContextType;
            tags?: string[];
            search?: string;
          } = {};

          if (query.type) filter.type = query.type as ContextType;
          if (query.tags)
            filter.tags = query.tags.split(",").map((t) => t.trim());
          if (query.search) filter.search = query.search;

          const pagination = {
            limit: query.limit ? parseInt(query.limit, 10) : 50,
            offset: query.offset ? parseInt(query.offset, 10) : 0,
          };

          return contextDb.list(
            Object.keys(filter).length > 0 ? filter : undefined,
            pagination,
          );
        },
        {
          query: t.Object({
            type: t.Optional(t.String()),
            tags: t.Optional(t.String()),
            search: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )

      // ── GET /contexts/search — Search contexts ────────────────────────
      .get(
        "/contexts/search",
        ({ query }) => {
          const results = contextDb.search(
            query.q,
            query.type as ContextType | undefined,
            query.limit ? parseInt(query.limit, 10) : undefined,
          );
          return { items: results, total: results.length };
        },
        {
          query: t.Object({
            q: t.String(),
            type: t.Optional(t.String()),
            limit: t.Optional(t.String()),
          }),
        },
      )

      // ── GET /contexts/:id — Get single context ────────────────────────
      .get(
        "/contexts/:id",
        ({ params, set }) => {
          const ctx = contextDb.getById(params.id);
          if (!ctx) {
            set.status = 404;
            return { error: "Context not found" };
          }
          return ctx;
        },
        {
          params: t.Object({ id: t.String() }),
        },
      )

      // ── POST /contexts — Create context ───────────────────────────────
      .post(
        "/contexts",
        ({ body, set }) => {
          try {
            const ctx = contextDb.create(body);
            set.status = 201;
            return ctx;
          } catch (err) {
            set.status = 400;
            return {
              error:
                err instanceof Error ? err.message : "Failed to create context",
            };
          }
        },
        {
          body: t.Object({
            name: t.String({ minLength: 1 }),
            type: t.Union([
              t.Literal("git_repo"),
              t.Literal("api_call"),
              t.Literal("markdown_doc"),
              t.Literal("command"),
              t.Literal("plain_text"),
              t.Literal("file"),
              t.Literal("url"),
            ]),
            content: t.String({ minLength: 1 }),
            tags: t.Optional(t.Array(t.String())),
            metadata: t.Optional(t.Record(t.String(), t.Any())),
          }),
        },
      )

      // ── PUT /contexts/:id — Update context ────────────────────────────
      .put(
        "/contexts/:id",
        ({ params, body, set }) => {
          try {
            const updated = contextDb.update(params.id, body);
            if (!updated) {
              set.status = 404;
              return { error: "Context not found" };
            }
            return updated;
          } catch (err) {
            set.status = 400;
            return {
              error:
                err instanceof Error ? err.message : "Failed to update context",
            };
          }
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            name: t.Optional(t.String({ minLength: 1 })),
            type: t.Optional(
              t.Union([
                t.Literal("git_repo"),
                t.Literal("api_call"),
                t.Literal("markdown_doc"),
                t.Literal("command"),
                t.Literal("plain_text"),
                t.Literal("file"),
                t.Literal("url"),
              ]),
            ),
            content: t.Optional(t.String({ minLength: 1 })),
            tags: t.Optional(t.Array(t.String())),
            metadata: t.Optional(t.Record(t.String(), t.Any())),
          }),
        },
      )

      // ── DELETE /contexts/:id — Soft-delete context ────────────────────
      .delete(
        "/contexts/:id",
        ({ params, set }) => {
          const deleted = contextDb.delete(params.id);
          if (!deleted) {
            set.status = 404;
            return { error: "Context not found" };
          }
          return { success: true };
        },
        {
          params: t.Object({ id: t.String() }),
        },
      )
  );
}
