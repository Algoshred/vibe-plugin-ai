/**
 * AI Streaming REST API Routes
 *
 * SSE streaming endpoint for AI responses. Sends prompt to provider
 * and streams back chunks via Server-Sent Events.
 * Mounted at /api/ai/sessions by the plugin system (alongside session routes).
 */

import { Elysia, t } from "elysia";
import type { SessionDatabase } from "../db/sessions.js";
import type { LogDatabase } from "../db/logs.js";

export interface StreamRouteDeps {
  sessionDb: SessionDatabase;
  logDb: LogDatabase;
  getAIProvider: (agentType: string) => unknown | undefined;
}

export function createStreamRoutes(deps: StreamRouteDeps) {
  const { sessionDb, logDb, getAIProvider } = deps;

  return (
    new Elysia()
      // ── POST /sessions/:id/stream — Stream AI response via SSE ───────
      .post(
        "/sessions/:id/stream",
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

          const provider = getAIProvider(session.agentType) as
            | {
                streamPrompt?: (
                  sessionId: string,
                  prompt: string,
                  contexts?: unknown[],
                ) => AsyncIterable<{ type: string; content: string }>;
                sendPrompt?: (
                  sessionId: string,
                  prompt: string,
                  contexts?: unknown[],
                ) => Promise<unknown>;
                createSession?: (
                  config: Record<string, unknown>,
                ) => Promise<unknown>;
              }
            | undefined;

          if (!provider) {
            set.status = 500;
            return { error: `Provider '${session.agentType}' not available` };
          }

          sessionDb.update(params.id, { status: "processing" });

          // Log input
          logDb.append({
            sessionId: params.id,
            type: "input",
            content: body.prompt,
            tokenCount: body.prompt.length,
          });

          // Helper: ensure provider session exists
          const ensureProviderSession = async () => {
            if (provider.createSession) {
              try {
                await provider.createSession({
                  ...session.config,
                  name: session.name,
                  agentType: session.agentType,
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

          // If provider supports streaming, use it
          if (provider.streamPrompt) {
            const streamPrompt = provider.streamPrompt.bind(provider);
            const sessionId = params.id;
            const prompt = body.prompt;
            const contexts = body.contexts;

            set.headers["content-type"] = "text/event-stream";
            set.headers["cache-control"] = "no-cache";
            set.headers["connection"] = "keep-alive";

            const stream = new ReadableStream({
              async start(controller) {
                const encoder = new TextEncoder();
                const collected: string[] = [];

                const sendEvent = (event: string, data: unknown) => {
                  controller.enqueue(
                    encoder.encode(
                      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                    ),
                  );
                };

                try {
                  let iterable: AsyncIterable<{
                    type: string;
                    content: string;
                  }>;
                  try {
                    iterable = streamPrompt(sessionId, prompt, contexts);
                  } catch (firstErr) {
                    const errMsg =
                      firstErr instanceof Error ? firstErr.message : "";
                    if (
                      errMsg.includes("not found") ||
                      errMsg.includes("Not found")
                    ) {
                      await ensureProviderSession();
                      iterable = streamPrompt(sessionId, prompt, contexts);
                    } else {
                      throw firstErr;
                    }
                  }

                  for await (const chunk of iterable) {
                    collected.push(chunk.content);
                    sendEvent("chunk", {
                      type: chunk.type,
                      content: chunk.content,
                    });
                  }

                  const fullContent = collected.join("");
                  sessionDb.update(sessionId, { status: "active" });

                  logDb.append({
                    sessionId,
                    type: "output",
                    content: fullContent,
                  });

                  sendEvent("done", { content: fullContent });
                } catch (err) {
                  sessionDb.update(sessionId, { status: "error" });

                  const errorMessage =
                    err instanceof Error
                      ? err.message
                      : "Unknown streaming error";

                  logDb.append({
                    sessionId,
                    type: "error",
                    content: errorMessage,
                  });

                  sendEvent("error", { error: errorMessage });
                } finally {
                  controller.close();
                }
              },
            });

            return stream;
          }

          // Fallback to non-streaming sendPrompt
          if (provider.sendPrompt) {
            try {
              let response: unknown;
              try {
                response = await provider.sendPrompt(
                  params.id,
                  body.prompt,
                  body.contexts,
                );
              } catch (firstErr) {
                const errMsg =
                  firstErr instanceof Error ? firstErr.message : "";
                if (
                  errMsg.includes("not found") ||
                  errMsg.includes("Not found")
                ) {
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

              const resp = response as Record<string, unknown>;
              const content =
                typeof resp.content === "string"
                  ? resp.content
                  : JSON.stringify(resp);

              logDb.append({
                sessionId: params.id,
                type: "output",
                content,
                tokenCount: (resp.outputTokens as number) || undefined,
                model: (resp.model as string) || undefined,
                durationMs: (resp.durationMs as number) || undefined,
              });

              set.headers["content-type"] = "text/event-stream";
              set.headers["cache-control"] = "no-cache";
              set.headers["connection"] = "keep-alive";

              const encoder = new TextEncoder();
              return new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    encoder.encode(
                      `event: chunk\ndata: ${JSON.stringify({ type: "text", content })}\n\n`,
                    ),
                  );
                  controller.enqueue(
                    encoder.encode(
                      `event: done\ndata: ${JSON.stringify({ content })}\n\n`,
                    ),
                  );
                  controller.close();
                },
              });
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
          }

          set.status = 500;
          return {
            error: `Provider '${session.agentType}' has no sendPrompt or streamPrompt`,
          };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            prompt: t.String({ minLength: 1 }),
            contexts: t.Optional(t.Array(t.Unknown())),
          }),
        },
      )
  );
}
