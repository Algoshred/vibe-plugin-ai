/**
 * Prompt Dispatch REST API Routes
 *
 * Compose prompts from templates + variables + contexts,
 * then dispatch to AI sessions.
 * Mounted at /api/ai/dispatch by the plugin system.
 */

import { Elysia, t } from "elysia";
import type {
  DispatchedPromptDatabase,
  DispatchStatus,
} from "../db/dispatched-prompts.js";
import type { PromptDatabase } from "../db/prompts.js";
import type { ContextDatabase } from "../db/contexts.js";

export interface DispatchRouteDeps {
  dispatchDb: DispatchedPromptDatabase;
  promptDb: PromptDatabase;
  contextDb: ContextDatabase;
}

export function createDispatchRoutes(deps: DispatchRouteDeps) {
  const { dispatchDb, promptDb, contextDb } = deps;

  return new Elysia({ prefix: "/dispatch" })
    // ── POST /dispatch/compose — Compose and preview a prompt ─────────
    .post(
      "/compose",
      ({ body, set }) => {
        let content: string;

        if (body.templateId) {
          // Render from template
          const rendered = promptDb.renderById(
            body.templateId,
            body.variables || {},
          );
          if (rendered === null) {
            set.status = 404;
            return { error: "Template not found" };
          }
          content = rendered;
          // Increment template usage
          promptDb.use(body.templateId);
        } else if (body.content) {
          content = body.content;
        } else {
          set.status = 400;
          return { error: "Either templateId or content is required" };
        }

        // Attach contexts
        let contextContents: string[] = [];
        if (body.contextIds && body.contextIds.length > 0) {
          const contexts = contextDb.getMultiple(body.contextIds);
          contextContents = contexts.map(
            (ctx) => `--- Context: ${ctx.name} (${ctx.type}) ---\n${ctx.content}`,
          );
        }

        const fullContent =
          contextContents.length > 0
            ? `${content}\n\n${contextContents.join("\n\n")}`
            : content;

        // Create draft dispatch record
        const dispatch = dispatchDb.create({
          templateId: body.templateId,
          content: fullContent,
          resolvedVariables: body.variables || {},
          contextIds: body.contextIds || [],
          sessionId: body.sessionId,
        });

        return {
          dispatch,
          preview: fullContent,
        };
      },
      {
        body: t.Object({
          templateId: t.Optional(t.String()),
          content: t.Optional(t.String()),
          variables: t.Optional(t.Record(t.String(), t.Any())),
          contextIds: t.Optional(t.Array(t.String())),
          sessionId: t.Optional(t.String()),
        }),
      },
    )

    // ── POST /dispatch/send — Dispatch a composed prompt ──────────────
    .post(
      "/send",
      ({ body, set }) => {
        if (body.dispatchId) {
          // Send existing dispatch
          const dispatch = dispatchDb.getById(body.dispatchId);
          if (!dispatch) {
            set.status = 404;
            return { error: "Dispatch record not found" };
          }

          const sessionId = body.sessionId || dispatch.sessionId;
          if (!sessionId) {
            set.status = 400;
            return { error: "sessionId is required" };
          }

          dispatchDb.update(body.dispatchId, {
            status: "queued",
            sessionId,
          });

          return {
            status: "queued",
            dispatchId: body.dispatchId,
            sessionId,
          };
        }

        // Direct send (compose + queue in one step)
        if (!body.content) {
          set.status = 400;
          return { error: "Either dispatchId or content is required" };
        }
        if (!body.sessionId) {
          set.status = 400;
          return { error: "sessionId is required for direct send" };
        }

        const dispatch = dispatchDb.create({
          content: body.content,
          contextIds: body.contextIds || [],
          sessionId: body.sessionId,
          scheduledAt: body.scheduledAt,
        });

        dispatchDb.update(dispatch.id, { status: "queued" });

        return {
          status: "queued",
          dispatchId: dispatch.id,
          sessionId: body.sessionId,
        };
      },
      {
        body: t.Object({
          dispatchId: t.Optional(t.String()),
          content: t.Optional(t.String()),
          sessionId: t.Optional(t.String()),
          contextIds: t.Optional(t.Array(t.String())),
          scheduledAt: t.Optional(t.String()),
        }),
      },
    )

    // ── GET /dispatch/history — Dispatch history ──────────────────────
    .get(
      "/history",
      ({ query }) => {
        const filter: { status?: DispatchStatus; sessionId?: string } = {};
        if (query.status) filter.status = query.status as DispatchStatus;
        if (query.sessionId) filter.sessionId = query.sessionId;

        const pagination = {
          limit: query.limit ? parseInt(query.limit, 10) : 50,
          offset: query.offset ? parseInt(query.offset, 10) : 0,
        };

        return dispatchDb.list(
          Object.keys(filter).length > 0 ? filter : undefined,
          pagination,
        );
      },
      {
        query: t.Object({
          status: t.Optional(t.String()),
          sessionId: t.Optional(t.String()),
          limit: t.Optional(t.String()),
          offset: t.Optional(t.String()),
        }),
      },
    )

    // ── GET /dispatch/:id — Get single dispatch ───────────────────────
    .get(
      "/:id",
      ({ params, set }) => {
        const dispatch = dispatchDb.getById(params.id);
        if (!dispatch) {
          set.status = 404;
          return { error: "Dispatch record not found" };
        }
        return dispatch;
      },
      { params: t.Object({ id: t.String() }) },
    );
}
