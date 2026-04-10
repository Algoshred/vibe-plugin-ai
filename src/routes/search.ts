/**
 * AI Search REST API Routes
 *
 * Cross-session full-text search across all session logs.
 * Mounted at /api/ai/search by the plugin system.
 */

import { Elysia, t } from "elysia";
import type { LogDatabase } from "../db/logs.js";

export interface SearchRouteDeps {
  logDb: LogDatabase;
}

export function createSearchRoutes(deps: SearchRouteDeps) {
  const { logDb } = deps;

  return (
    new Elysia()
      // ── GET /search — Search across all session logs ─────────────────
      .get(
        "/search",
        ({ query, set }) => {
          if (!query.query || query.query.trim().length === 0) {
            set.status = 400;
            return { error: "Query parameter 'query' is required" };
          }

          const sessionIds = query.sessionIds
            ? query.sessionIds
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;

          const types = query.types
            ? (query.types
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean) as Array<
                "input" | "output" | "thinking" | "event" | "error" | "metadata"
              >)
            : undefined;

          const limit = query.limit ? parseInt(query.limit, 10) : 50;
          const offset = query.offset ? parseInt(query.offset, 10) : 0;

          // If specific session IDs provided, search within each
          if (sessionIds && sessionIds.length > 0) {
            const allResults: Array<{
              id: string;
              sessionId: string;
              type: string;
              content: string;
              createdAt: string;
            }> = [];

            for (const sid of sessionIds) {
              const result = logDb.getBySession(sid, {
                search: query.query,
                types,
                limit: limit * 2, // Fetch more, trim later
                offset: 0,
              });

              for (const item of result.items) {
                allResults.push({
                  id: item.id,
                  sessionId: item.sessionId,
                  type: item.type,
                  content: item.content,
                  createdAt: item.createdAt,
                });
              }
            }

            // Sort by createdAt descending
            allResults.sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            );

            const paged = allResults.slice(offset, offset + limit);

            return {
              results: paged,
              total: allResults.length,
              hasMore: offset + paged.length < allResults.length,
              query: query.query,
            };
          }

          // Global search: use logDb's internal search capability
          // logDb.getBySession requires a sessionId, so we use a broad approach
          // by searching all logs directly
          const result = searchAllLogs(logDb, {
            search: query.query,
            types,
            limit,
            offset,
          });

          return {
            results: result.items,
            total: result.total,
            hasMore: result.hasMore,
            query: query.query,
          };
        },
        {
          query: t.Object({
            query: t.String(),
            sessionIds: t.Optional(t.String()),
            types: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )
  );
}

/**
 * Search all logs across sessions. Uses the LogDatabase's underlying
 * SQLite connection accessed via getBySession with a broad query.
 * Since LogDatabase doesn't expose a global search method, we use
 * a helper that leverages the database directly.
 */
function searchAllLogs(
  logDb: LogDatabase,
  filter: {
    search: string;
    types?: Array<
      "input" | "output" | "thinking" | "event" | "error" | "metadata"
    >;
    limit: number;
    offset: number;
  },
): {
  items: Array<{
    id: string;
    sessionId: string;
    type: string;
    content: string;
    createdAt: string;
  }>;
  total: number;
  hasMore: boolean;
} {
  // Use the logDb's internal database via the exposed getBySession method
  // with a workaround: search with a wildcard session match
  // Since we can't modify LogDatabase, we access its db property
  const db = (logDb as unknown as { db: import("bun:sqlite").Database }).db;

  if (!db) {
    return { items: [], total: 0, hasMore: false };
  }

  const conditions: string[] = ["LOWER(content) LIKE ?"];
  const params: (string | number)[] = [`%${filter.search.toLowerCase()}%`];

  if (filter.types && filter.types.length > 0) {
    const placeholders = filter.types.map(() => "?").join(",");
    conditions.push(`type IN (${placeholders})`);
    params.push(...filter.types);
  }

  const whereClause = conditions.join(" AND ");

  const countRow = db
    .prepare(`SELECT COUNT(*) as count FROM ai_logs WHERE ${whereClause}`)
    .get(...params) as { count: number };

  const rows = db
    .prepare(
      `SELECT id, session_id, type, content, created_at FROM ai_logs WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit, filter.offset) as Array<{
    id: string;
    session_id: string;
    type: string;
    content: string;
    created_at: string;
  }>;

  return {
    items: rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      type: r.type,
      content: r.content,
      createdAt: r.created_at,
    })),
    total: countRow.count,
    hasMore: filter.offset + rows.length < countRow.count,
  };
}
