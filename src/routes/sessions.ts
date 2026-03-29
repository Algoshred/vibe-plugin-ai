/**
 * AI Session REST API Routes
 *
 * Elysia routes for AI session management. Sessions connect to
 * AI provider plugins via the ServiceRegistry.
 * Mounted at /api/ai/sessions by the plugin system.
 */

import { Elysia, t } from "elysia";
import type { SessionDatabase, SessionStatus } from "../db/sessions.js";
import type { LogDatabase } from "../db/logs.js";

export interface SessionRouteDeps {
  sessionDb: SessionDatabase;
  logDb: LogDatabase;
  getAIProvider: (agentType: string) => unknown | undefined;
  listAIProviders: () => Array<{ pluginName: string; isDefault: boolean }>;
}

export function createSessionRoutes(deps: SessionRouteDeps) {
  const { sessionDb, logDb, getAIProvider, listAIProviders } = deps;

  return new Elysia({ prefix: "/sessions" })
    // ── GET /sessions — List sessions ─────────────────────────────────
    .get(
      "/",
      ({ query }) => {
        const filter: { agentType?: string; status?: SessionStatus } = {};
        if (query.agentType) filter.agentType = query.agentType;
        if (query.status) filter.status = query.status as SessionStatus;

        const pagination = {
          limit: query.limit ? parseInt(query.limit, 10) : 50,
          offset: query.offset ? parseInt(query.offset, 10) : 0,
        };

        return sessionDb.list(
          Object.keys(filter).length > 0 ? filter : undefined,
          pagination,
        );
      },
      {
        query: t.Object({
          agentType: t.Optional(t.String()),
          status: t.Optional(t.String()),
          limit: t.Optional(t.String()),
          offset: t.Optional(t.String()),
        }),
      },
    )

    // ── GET /sessions/providers — List available AI providers ──────────
    .get("/providers", () => {
      return { providers: listAIProviders() };
    })

    // ── GET /sessions/:id — Get session detail ────────────────────────
    .get(
      "/:id",
      ({ params, set }) => {
        const session = sessionDb.getById(params.id);
        if (!session) {
          set.status = 404;
          return { error: "Session not found" };
        }
        return session;
      },
      { params: t.Object({ id: t.String() }) },
    )

    // ── POST /sessions — Create session ───────────────────────────────
    .post(
      "/",
      async ({ body, set }) => {
        // Check if provider is available
        const provider = getAIProvider(body.agentType) as {
          createSession?: (config: Record<string, unknown>) => Promise<unknown>;
        } | undefined;

        if (!provider) {
          set.status = 400;
          return {
            error: `No AI provider registered for agent type '${body.agentType}'. Install the corresponding plugin (e.g., @vibecontrols/vibe-plugin-${body.agentType}).`,
            availableProviders: listAIProviders(),
          };
        }

        // Create local record
        const session = sessionDb.create({
          name: body.name,
          agentType: body.agentType,
          providerPlugin: body.agentType,
          config: body.config,
        });

        // Initialize provider session
        try {
          if (provider.createSession) {
            await provider.createSession({
              ...body.config,
              name: body.name,
              agentType: body.agentType,
              providerConfig: { ...body.config?.providerConfig, sessionId: session.id },
            });
          }
          sessionDb.update(session.id, { status: "active" });
          set.status = 201;
          return sessionDb.getById(session.id);
        } catch (err) {
          sessionDb.update(session.id, { status: "error" });
          set.status = 500;
          return {
            error:
              err instanceof Error
                ? err.message
                : "Failed to initialize AI session",
            session: sessionDb.getById(session.id),
          };
        }
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          agentType: t.String({ minLength: 1 }),
          config: t.Optional(t.Record(t.String(), t.Any())),
        }),
      },
    )

    // ── POST /sessions/:id/send — Send prompt to session ──────────────
    .post(
      "/:id/send",
      async ({ params, body, set }) => {
        const session = sessionDb.getById(params.id);
        if (!session) {
          set.status = 404;
          return { error: "Session not found" };
        }
        if (session.status === "terminated") {
          set.status = 400;
          return { error: "Session is terminated" };
        }

        const provider = getAIProvider(session.agentType) as {
          sendPrompt?: (
            sessionId: string,
            prompt: string,
            context?: unknown[],
          ) => Promise<unknown>;
          createSession?: (config: Record<string, unknown>) => Promise<unknown>;
        } | undefined;

        if (!provider?.sendPrompt) {
          set.status = 500;
          return { error: `Provider '${session.agentType}' not available` };
        }

        sessionDb.update(params.id, { status: "processing" });

        // Log input
        logDb.append({
          sessionId: params.id,
          type: "input",
          content: body.prompt,
          tokenCount: body.prompt.length, // approximate, provider will give exact
        });

        // Helper: ensure provider session exists (re-create if lost after restart)
        const ensureProviderSession = async () => {
          if (provider.createSession) {
            try {
              await provider.createSession({
                ...session.config,
                name: session.name,
                agentType: session.agentType,
                providerConfig: { ...(session.config?.providerConfig as Record<string, unknown> || {}), sessionId: params.id },
              });
            } catch {
              // Already exists or creation failed — proceed anyway
            }
          }
        };

        try {
          let response: unknown;
          try {
            response = await provider.sendPrompt(
              params.id,
              body.prompt,
              body.contexts,
            );
          } catch (firstErr) {
            // If session not found in provider (lost after restart), re-create and retry
            const errMsg = firstErr instanceof Error ? firstErr.message : "";
            if (errMsg.includes("not found") || errMsg.includes("Not found")) {
              await ensureProviderSession();
              response = await provider.sendPrompt(
                params.id,
                body.prompt,
                body.contexts,
              );
            } else {
              throw firstErr;
            }
          }

          sessionDb.update(params.id, { status: "active" });

          // Log output
          const resp = response as Record<string, unknown>;
          logDb.append({
            sessionId: params.id,
            type: "output",
            content:
              typeof resp.content === "string" ? resp.content : JSON.stringify(resp),
            tokenCount: (resp.outputTokens as number) || undefined,
            model: (resp.model as string) || undefined,
            durationMs: (resp.durationMs as number) || undefined,
          });

          return response;
        } catch (err) {
          sessionDb.update(params.id, { status: "error" });

          logDb.append({
            sessionId: params.id,
            type: "error",
            content: err instanceof Error ? err.message : "Unknown error",
          });

          set.status = 500;
          return {
            error:
              err instanceof Error ? err.message : "Failed to send prompt",
          };
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          prompt: t.String({ minLength: 1 }),
          contexts: t.Optional(t.Array(t.Any())),
        }),
      },
    )

    // ── GET /sessions/:id/logs — Get session logs ─────────────────────
    .get(
      "/:id/logs",
      ({ params, query, set }) => {
        const session = sessionDb.getById(params.id);
        if (!session) {
          set.status = 404;
          return { error: "Session not found" };
        }

        return logDb.getBySession(params.id, {
          types: query.types
            ? (query.types.split(",") as Array<"input" | "output" | "thinking" | "event" | "error" | "metadata">)
            : undefined,
          startDate: query.startDate || undefined,
          endDate: query.endDate || undefined,
          search: query.search || undefined,
          limit: query.limit ? parseInt(query.limit, 10) : undefined,
          offset: query.offset ? parseInt(query.offset, 10) : undefined,
        });
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({
          types: t.Optional(t.String()),
          startDate: t.Optional(t.String()),
          endDate: t.Optional(t.String()),
          search: t.Optional(t.String()),
          limit: t.Optional(t.String()),
          offset: t.Optional(t.String()),
        }),
      },
    )

    // ── GET /sessions/:id/stats — Get session stats ───────────────────
    .get(
      "/:id/stats",
      ({ params, set }) => {
        const session = sessionDb.getById(params.id);
        if (!session) {
          set.status = 404;
          return { error: "Session not found" };
        }

        const logStats = logDb.getSessionStats(params.id);
        return {
          session: {
            id: session.id,
            name: session.name,
            agentType: session.agentType,
            status: session.status,
            createdAt: session.createdAt,
          },
          stats: {
            ...session.stats,
            ...logStats,
          },
        };
      },
      { params: t.Object({ id: t.String() }) },
    )

    // ── PUT /sessions/:id/config — Update session config ──────────────
    .put(
      "/:id/config",
      async ({ params, body, set }) => {
        const session = sessionDb.getById(params.id);
        if (!session) {
          set.status = 404;
          return { error: "Session not found" };
        }

        const provider = getAIProvider(session.agentType) as {
          configureSession?: (
            sessionId: string,
            config: Record<string, unknown>,
          ) => Promise<void>;
        } | undefined;

        // Update local config
        const mergedConfig = { ...session.config, ...body.config };
        sessionDb.update(params.id, {
          name: body.name,
          config: mergedConfig,
        });

        // Notify provider
        if (provider?.configureSession) {
          try {
            await provider.configureSession(params.id, mergedConfig);
          } catch {
            // Non-fatal: local config is still updated
          }
        }

        return sessionDb.getById(params.id);
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          name: t.Optional(t.String({ minLength: 1 })),
          config: t.Optional(t.Record(t.String(), t.Any())),
        }),
      },
    )

    // ── DELETE /sessions/:id — Terminate session ──────────────────────
    .delete(
      "/:id",
      async ({ params, set }) => {
        const session = sessionDb.getById(params.id);
        if (!session) {
          set.status = 404;
          return { error: "Session not found" };
        }

        const provider = getAIProvider(session.agentType) as {
          destroySession?: (sessionId: string) => Promise<void>;
        } | undefined;

        // Destroy provider session
        if (provider?.destroySession) {
          try {
            await provider.destroySession(params.id);
          } catch {
            // Best-effort cleanup
          }
        }

        sessionDb.terminate(params.id);
        return { success: true };
      },
      { params: t.Object({ id: t.String() }) },
    );
}
