/**
 * Prompt Dispatch REST API Routes
 *
 * Compose prompts from templates + variables + contexts,
 * then dispatch to AI sessions (sync or queued).
 * Mounted at /api/ai/dispatch by the plugin system.
 */

import { Elysia, t } from "elysia";
import type {
  DispatchedPromptDatabase,
  DispatchStatus,
} from "../db/dispatched-prompts.js";
import type { PromptDatabase } from "../db/prompts.js";
import type { ContextDatabase } from "../db/contexts.js";
import type { SessionDatabase } from "../db/sessions.js";
import type { LogDatabase } from "../db/logs.js";
import type { QueueDatabase } from "../db/queue.js";

export interface DispatchRouteDeps {
  dispatchDb: DispatchedPromptDatabase;
  promptDb: PromptDatabase;
  contextDb: ContextDatabase;
  sessionDb: SessionDatabase;
  logDb: LogDatabase;
  queueDb: QueueDatabase;
  getAIProvider: (agentType: string) => unknown | undefined;
}

export function createDispatchRoutes(deps: DispatchRouteDeps) {
  const {
    dispatchDb,
    promptDb,
    contextDb,
    sessionDb,
    logDb,
    queueDb,
    getAIProvider,
  } = deps;

  /**
   * Helper: send a prompt to a session synchronously via the provider.
   * Used for immediate (non-scheduled) dispatches.
   */
  async function sendToSession(
    dispatchId: string,
    content: string,
    sessionId: string,
  ): Promise<{ success: boolean; response?: unknown; error?: string }> {
    const session = sessionDb.getById(sessionId);
    if (!session) return { success: false, error: "Session not found" };
    if (session.status === "terminated")
      return { success: false, error: "Session is terminated" };

    const provider = getAIProvider(session.agentType) as
      | {
          sendPrompt?: (sid: string, prompt: string) => Promise<unknown>;
          createSession?: (config: Record<string, unknown>) => Promise<unknown>;
        }
      | undefined;

    if (!provider?.sendPrompt) {
      return {
        success: false,
        error: `Provider '${session.agentType}' not available`,
      };
    }

    dispatchDb.update(dispatchId, { status: "processing" });
    sessionDb.update(sessionId, { status: "processing" });

    logDb.append({ sessionId, type: "input", content });

    try {
      let response: unknown;
      try {
        response = await provider.sendPrompt(sessionId, content);
      } catch (firstErr) {
        // Re-create provider session if lost after restart
        const msg = firstErr instanceof Error ? firstErr.message : "";
        if (msg.includes("not found") && provider.createSession) {
          await provider.createSession({
            ...session.config,
            name: session.name,
            agentType: session.agentType,
            providerConfig: {
              ...((session.config?.providerConfig as Record<string, unknown>) ||
                {}),
              sessionId,
            },
          });
          response = await provider.sendPrompt(sessionId, content);
        } else {
          throw firstErr;
        }
      }

      const resp = response as Record<string, unknown>;
      logDb.append({
        sessionId,
        type: "output",
        content:
          typeof resp.content === "string"
            ? resp.content
            : JSON.stringify(resp),
        tokenCount: (resp.outputTokens as number) || undefined,
        model: (resp.model as string) || undefined,
        durationMs: (resp.durationMs as number) || undefined,
      });

      dispatchDb.update(dispatchId, { status: "completed", result: resp });
      sessionDb.update(sessionId, { status: "active" });

      return { success: true, response };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      logDb.append({ sessionId, type: "error", content: errorMsg });
      dispatchDb.update(dispatchId, { status: "failed" });
      sessionDb.update(sessionId, { status: "error" });
      return { success: false, error: errorMsg };
    }
  }

  return (
    new Elysia()
      // ── POST /dispatch/compose — Compose and preview a prompt ─────────
      .post(
        "/dispatch/compose",
        ({ body, set }) => {
          let content: string;

          if (body.templateId) {
            const rendered = promptDb.renderById(
              body.templateId,
              body.variables || {},
            );
            if (rendered === null) {
              set.status = 404;
              return { error: "Template not found" };
            }
            content = rendered;
            promptDb.use(body.templateId);
          } else if (body.content) {
            content = body.content;
          } else {
            set.status = 400;
            return { error: "Either templateId or content is required" };
          }

          let contextContents: string[] = [];
          if (body.contextIds && body.contextIds.length > 0) {
            const contexts = contextDb.getMultiple(body.contextIds);
            contextContents = contexts.map(
              (ctx) =>
                `--- Context: ${ctx.name} (${ctx.type}) ---\n${ctx.content}`,
            );
          }

          const fullContent =
            contextContents.length > 0
              ? `${content}\n\n${contextContents.join("\n\n")}`
              : content;

          const dispatch = dispatchDb.create({
            templateId: body.templateId,
            content: fullContent,
            resolvedVariables: body.variables || {},
            contextIds: body.contextIds || [],
            sessionId: body.sessionId,
          });

          return { dispatch, preview: fullContent };
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

      // ── POST /dispatch/send — Dispatch a prompt (sync or scheduled) ───
      .post(
        "/dispatch/send",
        async ({ body, set }) => {
          let dispatchRecord;
          let sessionId: string;

          if (body.dispatchId) {
            dispatchRecord = dispatchDb.getById(body.dispatchId);
            if (!dispatchRecord) {
              set.status = 404;
              return { error: "Dispatch record not found" };
            }
            sessionId = (body.sessionId || dispatchRecord.sessionId) as string;
            if (!sessionId) {
              set.status = 400;
              return { error: "sessionId is required" };
            }
            dispatchDb.update(body.dispatchId, { sessionId });
          } else {
            // Direct send
            if (!body.content) {
              set.status = 400;
              return { error: "Either dispatchId or content is required" };
            }
            sessionId = body.sessionId as string;
            if (!sessionId) {
              set.status = 400;
              return { error: "sessionId is required for direct send" };
            }
            dispatchRecord = dispatchDb.create({
              content: body.content,
              contextIds: body.contextIds || [],
              sessionId,
              scheduledAt: body.scheduledAt,
            });
          }

          // If scheduled for the future, enqueue and return
          if (body.scheduledAt && new Date(body.scheduledAt) > new Date()) {
            dispatchDb.update(dispatchRecord.id, { status: "queued" });
            queueDb.enqueue({
              dispatchedPromptId: dispatchRecord.id,
              sessionId,
              scheduledAt: body.scheduledAt,
            });
            return {
              status: "queued",
              dispatchId: dispatchRecord.id,
              sessionId,
            };
          }

          // Session must exist for synchronous dispatch. If it doesn't,
          // fall back to enqueuing so the dispatch isn't lost — the
          // queue worker will pick it up once a session bound to this
          // ID is created. This also lets doctor / smoke tests exercise
          // the dispatch route without a fully-wired AI provider.
          if (!sessionDb.getById(sessionId)) {
            dispatchDb.update(dispatchRecord.id, { status: "queued" });
            queueDb.enqueue({
              dispatchedPromptId: dispatchRecord.id,
              sessionId,
            });
            return {
              status: "queued",
              dispatchId: dispatchRecord.id,
              sessionId,
              reason: "Session not present yet; dispatch enqueued",
            };
          }

          // Immediate dispatch — send synchronously
          const result = await sendToSession(
            dispatchRecord.id,
            dispatchRecord.content,
            sessionId,
          );

          if (!result.success) {
            set.status = 500;
            return {
              status: "failed",
              dispatchId: dispatchRecord.id,
              sessionId,
              error: result.error,
            };
          }

          return {
            status: "completed",
            dispatchId: dispatchRecord.id,
            sessionId,
            response: result.response,
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
        "/dispatch/history",
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
        "/dispatch/:id",
        ({ params, set }) => {
          const dispatch = dispatchDb.getById(params.id);
          if (!dispatch) {
            set.status = 404;
            return { error: "Dispatch record not found" };
          }
          return dispatch;
        },
        { params: t.Object({ id: t.String() }) },
      )
  );
}
