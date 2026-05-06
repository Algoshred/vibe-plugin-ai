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
import type { ProviderMode } from "../provider.js";

interface AIProviderSummary {
  pluginName: string;
  isDefault: boolean;
  supportedModes?: ProviderMode[];
}

interface ModeAwareProvider {
  setMode?: (mode: ProviderMode) => void;
  getSupportedModes?: () => ProviderMode[];
}

function isProviderMode(mode: unknown): mode is ProviderMode {
  return mode === "sdk" || mode === "cli";
}

function providerSupportsMode(
  provider: ModeAwareProvider,
  mode: ProviderMode,
): boolean {
  const modes = provider.getSupportedModes?.();
  return !modes || modes.includes(mode);
}

export interface SessionRouteDeps {
  sessionDb: SessionDatabase;
  logDb: LogDatabase;
  getAIProvider: (agentType: string) => unknown | undefined;
  listAIProviders: () => AIProviderSummary[];
}

export function createSessionRoutes(deps: SessionRouteDeps) {
  const { sessionDb, logDb, getAIProvider, listAIProviders } = deps;

  return (
    new Elysia()
      // ── GET /sessions — List sessions ─────────────────────────────────
      .get(
        "/sessions",
        ({ query }) => {
          const filter: {
            agentType?: string;
            status?: SessionStatus;
            search?: string;
          } = {};
          if (query.agentType) filter.agentType = query.agentType;
          if (query.status) filter.status = query.status as SessionStatus;
          if (query.search) filter.search = query.search;

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
            search: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )

      // ── GET /sessions/providers — List available AI providers ──────────
      .get("/sessions/providers", () => {
        return { providers: listAIProviders() };
      })

      // ── GET /sessions/:id — Get session detail ────────────────────────
      .get(
        "/sessions/:id",
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
        "/sessions",
        async ({ body, set }) => {
          // Check if provider is available
          const provider = getAIProvider(body.agentType) as
            | {
                createSession?: (
                  config: Record<string, unknown>,
                ) => Promise<unknown>;
                setMode?: (mode: ProviderMode) => void;
                getSupportedModes?: () => ProviderMode[];
              }
            | undefined;

          if (!provider) {
            set.status = 400;
            return {
              error: `No AI provider registered for agent type '${body.agentType}'. Install the corresponding plugin (e.g., @vibecontrols/vibe-plugin-${body.agentType}).`,
              availableProviders: listAIProviders(),
            };
          }

          const config = (body.config ?? {}) as Record<string, unknown>;
          const providerConfig =
            typeof config.providerConfig === "object" &&
            config.providerConfig !== null
              ? (config.providerConfig as Record<string, unknown>)
              : {};
          const requestedMode = config["mode"];
          if (isProviderMode(requestedMode)) {
            if (!providerSupportsMode(provider, requestedMode)) {
              set.status = 400;
              return {
                error: `Provider '${body.agentType}' does not support ${requestedMode.toUpperCase()} mode`,
                availableProviders: listAIProviders(),
              };
            }
            provider.setMode?.(requestedMode);
          }

          // Create local record. Durable to disk before returning so the
          // sessionId we hand back is immediately readable by a CLI/SDK.
          const session = await sessionDb.create({
            name: body.name,
            agentType: body.agentType,
            providerPlugin: body.agentType,
            config,
          });

          // Initialize provider session
          try {
            if (provider.createSession) {
              await provider.createSession({
                ...config,
                name: body.name,
                agentType: body.agentType,
                providerConfig: {
                  ...providerConfig,
                  sessionId: session.id,
                },
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
        "/sessions/:id/send",
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

          // Allow per-message provider override (for multi-harness sessions)
          const targetAgentType =
            ((body as Record<string, unknown>).agentType as string) ||
            session.agentType;

          const provider = getAIProvider(targetAgentType) as
            | {
                sendPrompt?: (
                  sessionId: string,
                  prompt: string,
                  context?: unknown[],
                ) => Promise<unknown>;
                createSession?: (
                  config: Record<string, unknown>,
                ) => Promise<unknown>;
              }
            | undefined;

          if (!provider?.sendPrompt) {
            set.status = 500;
            return { error: `Provider '${targetAgentType}' not available` };
          }

          // Switch provider mode if requested (sdk/cli)
          const modeOverride = (body as Record<string, unknown>).mode;
          if (isProviderMode(modeOverride)) {
            if (
              !providerSupportsMode(provider as ModeAwareProvider, modeOverride)
            ) {
              set.status = 400;
              return {
                error: `Provider '${targetAgentType}' does not support ${modeOverride.toUpperCase()} mode`,
                availableProviders: listAIProviders(),
              };
            }
            // Call setMode on the provider object to preserve `this` binding
            (provider as ModeAwareProvider).setMode?.(modeOverride);
          }

          // If a model override is provided, update the provider session config
          const modelOverride = (body as Record<string, unknown>).model as
            | string
            | undefined;
          if (modelOverride || targetAgentType !== session.agentType) {
            const configureSession = (provider as Record<string, unknown>)
              .configureSession as
              | ((
                  sessionId: string,
                  config: Record<string, unknown>,
                ) => Promise<void>)
              | undefined;
            if (configureSession) {
              try {
                await configureSession(params.id, {
                  model: modelOverride || undefined,
                  agentType: targetAgentType,
                });
              } catch {
                // Best-effort config update
              }
            }
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
                  agentType: targetAgentType,
                  model:
                    modelOverride ||
                    ((session.config as Record<string, unknown>)
                      ?.model as string) ||
                    undefined,
                  providerConfig: {
                    ...((session.config?.providerConfig as Record<
                      string,
                      unknown
                    >) || {}),
                    sessionId: params.id,
                  },
                });
              } catch {
                // Already exists or creation failed — proceed anyway
              }
            }
          };

          // Build prompt with conversation history context
          let fullPrompt = body.prompt;
          const history = (body as Record<string, unknown>)
            .conversationHistory as
            | Array<{ role: string; content: string }>
            | undefined;
          if (history && history.length > 0) {
            const historyText = history
              .map((msg) => `[${msg.role.toUpperCase()}]: ${msg.content}`)
              .join("\n\n");
            fullPrompt = `--- Conversation History ---\n${historyText}\n--- End History ---\n\n${body.prompt}`;
          }

          // Pre-create provider session when switching to a different provider
          if (targetAgentType !== session.agentType) {
            await ensureProviderSession();
          }

          try {
            let response: unknown;
            try {
              response = await provider.sendPrompt(
                params.id,
                fullPrompt,
                body.contexts,
              );
            } catch (firstErr) {
              // If session not found in provider (lost after restart), re-create and retry
              const errMsg = firstErr instanceof Error ? firstErr.message : "";
              if (
                errMsg.includes("not found") ||
                errMsg.includes("Not found")
              ) {
                await ensureProviderSession();
                response = await provider.sendPrompt(
                  params.id,
                  fullPrompt,
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
                typeof resp.content === "string"
                  ? resp.content
                  : JSON.stringify(resp),
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
            agentType: t.Optional(t.String()),
            model: t.Optional(t.String()),
            mode: t.Optional(t.String()),
            conversationHistory: t.Optional(
              t.Array(
                t.Object({
                  role: t.String(),
                  content: t.String(),
                }),
              ),
            ),
          }),
        },
      )

      // ── GET /sessions/:id/logs — Get session logs ─────────────────────
      .get(
        "/sessions/:id/logs",
        ({ params, query, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          return logDb.getBySession(params.id, {
            types: query.types
              ? (query.types.split(",") as Array<
                  | "input"
                  | "output"
                  | "thinking"
                  | "event"
                  | "error"
                  | "metadata"
                >)
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
        "/sessions/:id/stats",
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
        "/sessions/:id/config",
        async ({ params, body, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          const provider = getAIProvider(session.agentType) as
            | {
                configureSession?: (
                  sessionId: string,
                  config: Record<string, unknown>,
                ) => Promise<void>;
              }
            | undefined;

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
        "/sessions/:id",
        async ({ params, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          const provider = getAIProvider(session.agentType) as
            | {
                destroySession?: (sessionId: string) => Promise<void>;
              }
            | undefined;

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
      )

      // ── PUT /sessions/:id/name — Rename session ─────────────────────
      .put(
        "/sessions/:id/name",
        ({ params, body, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          sessionDb.update(params.id, { name: body.name });
          return sessionDb.getById(params.id);
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({ name: t.String({ minLength: 1 }) }),
        },
      )

      // ── PUT /sessions/:id/model — Switch model ──────────────────────
      .put(
        "/sessions/:id/model",
        ({ params, body, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          const mergedConfig = { ...session.config, model: body.model };
          sessionDb.update(params.id, { config: mergedConfig });
          return sessionDb.getById(params.id);
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({ model: t.String({ minLength: 1 }) }),
        },
      )

      // ── PUT /sessions/:id/sdk — Switch SDK/provider ─────────────────
      .put(
        "/sessions/:id/sdk",
        ({ params, body, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          // Validate that the provider exists
          const provider = getAIProvider(body.sdk);
          if (!provider) {
            set.status = 400;
            return {
              error: `No AI provider registered for '${body.sdk}'`,
              availableProviders: listAIProviders(),
            };
          }

          sessionDb.update(params.id, {
            config: { ...session.config, sdk: body.sdk },
          });
          return sessionDb.getById(params.id);
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({ sdk: t.String({ minLength: 1 }) }),
        },
      )

      // ── PUT /sessions/:id/mode — Switch provider mode ───────────────
      .put(
        "/sessions/:id/mode",
        ({ params, body, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          if (body.mode !== "sdk" && body.mode !== "cli") {
            set.status = 400;
            return { error: "Mode must be 'sdk' or 'cli'" };
          }

          sessionDb.update(params.id, {
            config: { ...session.config, mode: body.mode },
          });
          return sessionDb.getById(params.id);
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            mode: t.Union([t.Literal("sdk"), t.Literal("cli")]),
          }),
        },
      )

      // ── POST /sessions/bulk-delete — Delete multiple sessions ────────
      .post(
        "/sessions/bulk-delete",
        async ({ body, set }) => {
          if (!body.ids || body.ids.length === 0) {
            set.status = 400;
            return { error: "No session IDs provided" };
          }

          const results: Array<{
            id: string;
            success: boolean;
            error?: string;
          }> = [];

          for (const id of body.ids) {
            const session = sessionDb.getById(id);
            if (!session) {
              results.push({ id, success: false, error: "Not found" });
              continue;
            }

            const provider = getAIProvider(session.agentType) as
              | {
                  destroySession?: (sessionId: string) => Promise<void>;
                }
              | undefined;

            if (provider?.destroySession) {
              try {
                await provider.destroySession(id);
              } catch {
                // Best-effort cleanup
              }
            }

            sessionDb.terminate(id);
            results.push({ id, success: true });
          }

          return {
            deleted: results.filter((r) => r.success).length,
            failed: results.filter((r) => !r.success).length,
            results,
          };
        },
        {
          body: t.Object({
            ids: t.Array(t.String(), { minItems: 1 }),
          }),
        },
      )

      // ── GET /sessions/:id/messages — Get conversation messages ───────
      .get(
        "/sessions/:id/messages",
        ({ params, query, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          const limit = query.limit ? parseInt(query.limit, 10) : 100;
          const offset = query.offset ? parseInt(query.offset, 10) : 0;

          const logs = logDb.getBySession(params.id, {
            types: ["input", "output"],
            limit: limit * 2, // Fetch double to ensure we get paired messages
            offset,
          });

          // Pair input/output into messages
          const messages: Array<{
            id: string;
            role: "user" | "assistant";
            content: string;
            model?: string | null;
            tokenCount?: number | null;
            durationMs?: number | null;
            createdAt: string;
          }> = [];

          for (const log of logs.items) {
            messages.push({
              id: log.id,
              role: log.type === "input" ? "user" : "assistant",
              content: log.content,
              model: log.model,
              tokenCount: log.tokenCount,
              durationMs: log.durationMs,
              createdAt: log.createdAt,
            });
          }

          return {
            messages: messages.slice(0, limit),
            total: logs.total,
            hasMore: logs.hasMore,
          };
        },
        {
          params: t.Object({ id: t.String() }),
          query: t.Object({
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )
  );
}
