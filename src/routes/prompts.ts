/**
 * Prompt REST API Routes
 *
 * Elysia routes for prompt CRUD operations.
 * Mounted at /api/ai/prompts by the plugin system.
 */

import { Elysia, t } from "elysia";
import type { PromptDatabase, PromptCategory } from "../db/prompts.js";

const PromptCategoryEnum = t.Optional(
  t.Union([
    t.Literal("GENERAL"),
    t.Literal("CODING"),
    t.Literal("DEBUGGING"),
    t.Literal("REVIEW"),
    t.Literal("DOCUMENTATION"),
    t.Literal("TESTING"),
    t.Literal("DEPLOYMENT"),
    t.Literal("CUSTOM"),
  ]),
);

export function createPromptRoutes(promptDb: PromptDatabase) {
  return (
    new Elysia()
      // ── GET /prompts — List prompts ──────────────────────────────────
      .get(
        "/prompts",
        ({ query }) => {
          const filter: {
            category?: PromptCategory;
            tags?: string[];
            isShared?: boolean;
            createdBy?: string;
          } = {};

          if (query.category) {
            filter.category = query.category as PromptCategory;
          }
          if (query.tags) {
            filter.tags = query.tags.split(",").map((t) => t.trim());
          }
          if (query.isShared !== undefined) {
            filter.isShared = query.isShared === "true";
          }
          if (query.createdBy) {
            filter.createdBy = query.createdBy;
          }

          const pagination = {
            limit: query.limit ? parseInt(query.limit, 10) : 50,
            offset: query.offset ? parseInt(query.offset, 10) : 0,
          };

          return promptDb.list(
            Object.keys(filter).length > 0 ? filter : undefined,
            pagination,
          );
        },
        {
          query: t.Object({
            category: t.Optional(t.String()),
            tags: t.Optional(t.String()),
            isShared: t.Optional(t.String()),
            createdBy: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )

      // ── GET /prompts/search — Search prompts ─────────────────────────
      .get(
        "/prompts/search",
        ({ query }) => {
          const results = promptDb.search(
            query.q,
            query.category as PromptCategory | undefined,
            query.limit ? parseInt(query.limit, 10) : undefined,
          );
          return { items: results, total: results.length };
        },
        {
          query: t.Object({
            q: t.String(),
            category: t.Optional(t.String()),
            limit: t.Optional(t.String()),
          }),
        },
      )

      // ── GET /prompts/popular — Popular prompts ───────────────────────
      .get(
        "/prompts/popular",
        ({ query }) => {
          const results = promptDb.getPopular(
            query.limit ? parseInt(query.limit, 10) : undefined,
          );
          return { items: results, total: results.length };
        },
        {
          query: t.Object({
            limit: t.Optional(t.String()),
          }),
        },
      )

      // ── GET /prompts/:id — Get single prompt ─────────────────────────
      .get(
        "/prompts/:id",
        ({ params, set }) => {
          const prompt = promptDb.getById(params.id);
          if (!prompt) {
            set.status = 404;
            return { error: "Prompt not found" };
          }
          return prompt;
        },
        {
          params: t.Object({ id: t.String() }),
        },
      )

      // ── POST /prompts — Create prompt ────────────────────────────────
      .post(
        "/prompts",
        ({ body, set }) => {
          try {
            const prompt = promptDb.create(body);
            set.status = 201;
            return prompt;
          } catch (err) {
            set.status = 400;
            return {
              error:
                err instanceof Error ? err.message : "Failed to create prompt",
            };
          }
        },
        {
          body: t.Object({
            name: t.String({ minLength: 1 }),
            content: t.String({ minLength: 1 }),
            category: PromptCategoryEnum,
            tags: t.Optional(t.Array(t.String())),
            variables: t.Optional(t.Array(t.String())),
            isShared: t.Optional(t.Boolean()),
            metadata: t.Optional(t.Record(t.String(), t.Any())),
          }),
        },
      )

      // ── PUT /prompts/:id — Update prompt ─────────────────────────────
      .put(
        "/prompts/:id",
        ({ params, body, set }) => {
          const updated = promptDb.update(params.id, body);
          if (!updated) {
            set.status = 404;
            return { error: "Prompt not found" };
          }
          return updated;
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            name: t.Optional(t.String({ minLength: 1 })),
            content: t.Optional(t.String({ minLength: 1 })),
            category: t.Optional(
              t.Union([
                t.Literal("GENERAL"),
                t.Literal("CODING"),
                t.Literal("DEBUGGING"),
                t.Literal("REVIEW"),
                t.Literal("DOCUMENTATION"),
                t.Literal("TESTING"),
                t.Literal("DEPLOYMENT"),
                t.Literal("CUSTOM"),
                t.Null(),
              ]),
            ),
            tags: t.Optional(t.Array(t.String())),
            variables: t.Optional(t.Array(t.String())),
            isShared: t.Optional(t.Boolean()),
            metadata: t.Optional(t.Record(t.String(), t.Any())),
          }),
        },
      )

      // ── DELETE /prompts/:id — Soft-delete prompt ─────────────────────
      .delete(
        "/prompts/:id",
        ({ params, set }) => {
          const deleted = promptDb.delete(params.id);
          if (!deleted) {
            set.status = 404;
            return { error: "Prompt not found" };
          }
          return { success: true };
        },
        {
          params: t.Object({ id: t.String() }),
        },
      )

      // ── POST /prompts/:id/use — Increment usage ─────────────────────
      .post(
        "/prompts/:id/use",
        ({ params, set }) => {
          const prompt = promptDb.use(params.id);
          if (!prompt) {
            set.status = 404;
            return { error: "Prompt not found" };
          }
          return prompt;
        },
        {
          params: t.Object({ id: t.String() }),
        },
      )

      // ── POST /prompts/:id/duplicate — Duplicate prompt ───────────────
      .post(
        "/prompts/:id/duplicate",
        ({ params, body, set }) => {
          try {
            const prompt = promptDb.duplicate(params.id, body.name);
            if (!prompt) {
              set.status = 404;
              return { error: "Prompt not found" };
            }
            set.status = 201;
            return prompt;
          } catch (err) {
            set.status = 400;
            return {
              error:
                err instanceof Error
                  ? err.message
                  : "Failed to duplicate prompt",
            };
          }
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            name: t.String({ minLength: 1 }),
          }),
        },
      )

      // ── POST /prompts/:id/render — Render with variables ─────────────
      .post(
        "/prompts/:id/render",
        ({ params, body, set }) => {
          const rendered = promptDb.renderById(params.id, body.variables);
          if (rendered === null) {
            set.status = 404;
            return { error: "Prompt not found" };
          }
          return { rendered };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            variables: t.Record(t.String(), t.Any()),
          }),
        },
      )
  );
}
