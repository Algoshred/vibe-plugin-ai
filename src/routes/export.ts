/**
 * AI Session Export REST API Routes
 *
 * Export session data as JSON or human-readable Markdown.
 * Mounted at /api/ai/sessions by the plugin system.
 */

import { Elysia, t } from "elysia";
import type { SessionDatabase } from "../db/sessions.js";
import type { LogDatabase, AILogRecord } from "../db/logs.js";

export interface ExportRouteDeps {
  sessionDb: SessionDatabase;
  logDb: LogDatabase;
}

export function createExportRoutes(deps: ExportRouteDeps) {
  const { sessionDb, logDb } = deps;

  return (
    new Elysia()
      // ── GET /sessions/:id/export — Export session ────────────────────
      .get(
        "/sessions/:id/export",
        ({ params, query, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          const format = query.format || "json";
          if (format !== "json" && format !== "markdown") {
            set.status = 400;
            return { error: "Format must be 'json' or 'markdown'" };
          }

          // Fetch all logs for the session
          const logs = logDb.getBySession(params.id, { limit: 10000 });
          const stats = logDb.getSessionStats(params.id);

          if (format === "json") {
            return {
              session: {
                id: session.id,
                name: session.name,
                agentType: session.agentType,
                providerPlugin: session.providerPlugin,
                config: session.config,
                status: session.status,
                stats: session.stats,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                terminatedAt: session.terminatedAt,
              },
              logs: logs.items,
              logStats: stats,
              exportedAt: new Date().toISOString(),
            };
          }

          // Markdown format
          const markdown = formatSessionMarkdown(session, logs.items, stats);
          set.headers["content-type"] = "text/markdown; charset=utf-8";
          set.headers["content-disposition"] =
            `attachment; filename="session-${session.id}.md"`;
          return markdown;
        },
        {
          params: t.Object({ id: t.String() }),
          query: t.Object({
            format: t.Optional(t.String()),
          }),
        },
      )
  );
}

function formatSessionMarkdown(
  session: {
    id: string;
    name: string;
    agentType: string;
    providerPlugin: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    terminatedAt: string | null;
  },
  logs: AILogRecord[],
  stats: {
    totalLogs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalDurationMs: number;
    logsByType: Record<string, number>;
  },
): string {
  const lines: string[] = [];

  lines.push(`# AI Session: ${session.name}`);
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| **ID** | ${session.id} |`);
  lines.push(`| **Agent Type** | ${session.agentType} |`);
  lines.push(`| **Provider** | ${session.providerPlugin} |`);
  lines.push(`| **Status** | ${session.status} |`);
  lines.push(`| **Created** | ${session.createdAt} |`);
  lines.push(`| **Updated** | ${session.updatedAt} |`);
  if (session.terminatedAt) {
    lines.push(`| **Terminated** | ${session.terminatedAt} |`);
  }
  lines.push("");

  lines.push("## Stats");
  lines.push("");
  lines.push(`- **Total logs**: ${stats.totalLogs}`);
  lines.push(`- **Input tokens**: ${stats.totalInputTokens.toLocaleString()}`);
  lines.push(
    `- **Output tokens**: ${stats.totalOutputTokens.toLocaleString()}`,
  );
  lines.push(`- **Total duration**: ${stats.totalDurationMs}ms`);
  lines.push("");

  lines.push("## Conversation");
  lines.push("");

  for (const log of logs) {
    const timestamp = log.createdAt;
    const label = getLogLabel(log.type);

    lines.push(`### ${label} (${timestamp})`);
    lines.push("");

    if (log.type === "input" || log.type === "output") {
      lines.push(log.content);
    } else if (log.type === "error") {
      lines.push("```");
      lines.push(log.content);
      lines.push("```");
    } else if (log.type === "thinking") {
      lines.push(`> ${log.content.replace(/\n/g, "\n> ")}`);
    } else {
      lines.push(log.content);
    }

    if (log.model) {
      lines.push("");
      lines.push(`*Model: ${log.model}*`);
    }
    if (log.tokenCount) {
      lines.push(`*Tokens: ${log.tokenCount}*`);
    }
    if (log.durationMs) {
      lines.push(`*Duration: ${log.durationMs}ms*`);
    }

    lines.push("");
    lines.push("---");
    lines.push("");
  }

  lines.push(`*Exported at ${new Date().toISOString()}*`);
  lines.push("");

  return lines.join("\n");
}

function getLogLabel(type: string): string {
  switch (type) {
    case "input":
      return "User";
    case "output":
      return "Assistant";
    case "thinking":
      return "Thinking";
    case "event":
      return "Event";
    case "error":
      return "Error";
    case "metadata":
      return "Metadata";
    default:
      return type;
  }
}
