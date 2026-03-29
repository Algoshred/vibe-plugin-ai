/**
 * AI Stats REST API Routes
 *
 * Aggregated usage statistics across all AI sessions.
 * Mounted at /api/ai/stats by the plugin system.
 */

import { Elysia, t } from "elysia";
import type { SessionDatabase } from "../db/sessions.js";
import type { LogDatabase } from "../db/logs.js";

export function createStatsRoutes(
  sessionDb: SessionDatabase,
  logDb: LogDatabase,
) {
  return new Elysia({ prefix: "/stats" })
    // ── GET /stats/overview — High-level overview ─────────────────────
    .get("/overview", () => {
      const sessions = sessionDb.list(undefined, { limit: 1000 });
      const activeSessions = sessions.items.filter(
        (s) => s.status !== "terminated",
      );

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalRequests = 0;

      for (const session of sessions.items) {
        const stats = logDb.getSessionStats(session.id);
        totalInputTokens += stats.totalInputTokens;
        totalOutputTokens += stats.totalOutputTokens;
        totalRequests += stats.totalLogs;
      }

      // Group by agent type
      const byAgentType: Record<string, number> = {};
      for (const session of sessions.items) {
        byAgentType[session.agentType] =
          (byAgentType[session.agentType] || 0) + 1;
      }

      return {
        totalSessions: sessions.total,
        activeSessions: activeSessions.length,
        totalInputTokens,
        totalOutputTokens,
        totalRequests,
        sessionsByAgentType: byAgentType,
      };
    })

    // ── GET /stats/sessions/:id — Per-session stats ───────────────────
    .get(
      "/sessions/:id",
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
          stats: logStats,
        };
      },
      { params: t.Object({ id: t.String() }) },
    )

    // ── GET /stats/usage — Usage breakdown by model/provider ──────────
    .get("/usage", () => {
      const sessions = sessionDb.list(undefined, { limit: 1000 });
      const byProvider: Record<
        string,
        {
          inputTokens: number;
          outputTokens: number;
          requestCount: number;
          sessionCount: number;
        }
      > = {};

      for (const session of sessions.items) {
        const stats = logDb.getSessionStats(session.id);
        const key = session.agentType;

        if (!byProvider[key]) {
          byProvider[key] = {
            inputTokens: 0,
            outputTokens: 0,
            requestCount: 0,
            sessionCount: 0,
          };
        }

        byProvider[key].inputTokens += stats.totalInputTokens;
        byProvider[key].outputTokens += stats.totalOutputTokens;
        byProvider[key].requestCount += stats.totalLogs;
        byProvider[key].sessionCount += 1;
      }

      return { usage: byProvider };
    });
}
