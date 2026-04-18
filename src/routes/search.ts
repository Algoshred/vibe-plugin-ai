/**
 * AI Search REST API Routes
 *
 * Cross-session full-text search across all session logs.
 * Mounted at /api/ai/search by the plugin system.
 */

import { Elysia, t } from "elysia";
import type { LogDatabase, LogType } from "../db/logs.js";

export interface SearchRouteDeps {
  logDb: LogDatabase;
}

type SearchResult = {
  id: string;
  sessionId: string;
  type: string;
  content: string;
  createdAt: string;
};

export function createSearchRoutes(deps: SearchRouteDeps) {
  const { logDb } = deps;

  return new Elysia().get(
    "/search",
    ({ query, set }) => {
      if (!query.query || query.query.trim().length === 0) {
        set.status = 400;
        return { error: "Query parameter 'query' is required" };
      }

      const needle = query.query.toLowerCase();
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
            .filter(Boolean) as LogType[])
        : undefined;
      const limit = query.limit ? parseInt(query.limit, 10) : 50;
      const offset = query.offset ? parseInt(query.offset, 10) : 0;

      // Walk the in-memory KV cache directly via LogDatabase.store so
      // we don't pay per-session query overhead. Filter -> sort -> page.
      const wantSession = sessionIds
        ? new Set(sessionIds)
        : null;
      const wantType = types ? new Set(types) : null;

      const matches: SearchResult[] = [];
      for (const r of logDb.store.all()) {
        if (wantSession && !wantSession.has(r.sessionId)) continue;
        if (wantType && !wantType.has(r.type)) continue;
        if (!r.content.toLowerCase().includes(needle)) continue;
        matches.push({
          id: r.id,
          sessionId: r.sessionId,
          type: r.type,
          content: r.content,
          createdAt: r.createdAt,
        });
      }

      matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const paged = matches.slice(offset, offset + limit);

      return {
        results: paged,
        total: matches.length,
        hasMore: offset + paged.length < matches.length,
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
  );
}
