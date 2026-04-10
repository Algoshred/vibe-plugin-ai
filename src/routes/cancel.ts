/**
 * AI Cancel REST API Routes
 *
 * Cancel in-progress AI requests for a session.
 * Mounted at /api/ai/sessions by the plugin system.
 */

import { Elysia, t } from "elysia";
import type { SessionDatabase } from "../db/sessions.js";

export interface CancelRouteDeps {
  sessionDb: SessionDatabase;
  getAIProvider: (agentType: string) => unknown | undefined;
}

export function createCancelRoutes(deps: CancelRouteDeps) {
  const { sessionDb, getAIProvider } = deps;

  return (
    new Elysia()
      // ── POST /sessions/:id/cancel — Cancel ongoing request ───────────
      .post(
        "/sessions/:id/cancel",
        async ({ params, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }
          if (session.status === "terminated") {
            set.status = 400;
            return { error: "Session is terminated" };
          }
          if (session.status !== "processing") {
            return { success: true, message: "No request in progress" };
          }

          const provider = getAIProvider(session.agentType) as
            | {
                cancelRequest?: (sessionId: string) => Promise<void> | void;
              }
            | undefined;

          if (provider?.cancelRequest) {
            try {
              await provider.cancelRequest(params.id);
            } catch {
              // Best-effort cancellation
            }
          }

          sessionDb.update(params.id, { status: "active" });

          return { success: true, message: "Request cancelled" };
        },
        { params: t.Object({ id: t.String() }) },
      )
  );
}
