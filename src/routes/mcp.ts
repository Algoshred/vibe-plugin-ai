/**
 * MCP Server Management REST API Routes
 *
 * List available MCP servers from config, and attach/detach
 * MCP servers to AI sessions.
 * Mounted at /api/ai by the plugin system.
 */

import { Elysia, t } from "elysia";
import { join } from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import type { SessionDatabase } from "../db/sessions.js";

export interface McpRouteDeps {
  sessionDb: SessionDatabase;
}

interface McpServerConfig {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: string;
}

interface McpConfigFile {
  mcpServers?: Record<
    string,
    {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      transport?: string;
    }
  >;
}

function loadMcpConfig(): McpServerConfig[] {
  const configPaths = [
    join(os.homedir(), ".vibecontrols", "mcp-config.json"),
    join(os.homedir(), ".config", "mcp", "config.json"),
  ];

  for (const configPath of configPaths) {
    try {
      const text = readFileSync(configPath, "utf-8");
      if (!text) continue;

      const config = JSON.parse(text) as McpConfigFile;
      if (!config.mcpServers) continue;

      return Object.entries(config.mcpServers).map(([name, server]) => ({
        id: name,
        name,
        command: server.command,
        args: server.args,
        env: server.env,
        url: server.url,
        transport: server.transport,
      }));
    } catch {
      continue;
    }
  }

  return [];
}

export function createMcpRoutes(deps: McpRouteDeps) {
  const { sessionDb } = deps;

  // In-memory MCP-to-session attachment store (persisted in session config)
  function getSessionMcpServers(
    sessionId: string,
  ): Array<{ serverId: string; name: string; attachedAt: string }> {
    const session = sessionDb.getById(sessionId);
    if (!session) return [];
    const mcpServers = session.config?.mcpServers;
    if (!Array.isArray(mcpServers)) return [];
    return mcpServers as Array<{
      serverId: string;
      name: string;
      attachedAt: string;
    }>;
  }

  function setSessionMcpServers(
    sessionId: string,
    servers: Array<{ serverId: string; name: string; attachedAt: string }>,
  ): void {
    const session = sessionDb.getById(sessionId);
    if (!session) return;
    sessionDb.update(sessionId, {
      config: { ...session.config, mcpServers: servers },
    });
  }

  return (
    new Elysia()
      // ── GET /mcp/servers — List available MCP servers ────────────────
      .get("/mcp/servers", () => {
        const servers = loadMcpConfig();
        return { servers };
      })

      // ── POST /sessions/:id/mcp — Attach MCP server(s) to session ────
      .post(
        "/sessions/:id/mcp",
        ({ params, body, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          const available = loadMcpConfig();
          const availableIds = new Set(available.map((s) => s.id));
          const current = getSessionMcpServers(params.id);
          const currentIds = new Set(current.map((s) => s.serverId));

          const serverIds = Array.isArray(body.serverIds)
            ? body.serverIds
            : [body.serverIds];

          const attached: string[] = [];
          const skipped: string[] = [];
          const notFound: string[] = [];

          for (const sid of serverIds) {
            if (!availableIds.has(sid)) {
              notFound.push(sid);
            } else if (currentIds.has(sid)) {
              skipped.push(sid);
            } else {
              current.push({
                serverId: sid,
                name: sid,
                attachedAt: new Date().toISOString(),
              });
              attached.push(sid);
            }
          }

          if (attached.length > 0) {
            setSessionMcpServers(params.id, current);
          }

          if (notFound.length > 0) {
            set.status = 400;
            return {
              error: `MCP servers not found: ${notFound.join(", ")}`,
              attached,
              skipped,
              notFound,
            };
          }

          return { attached, skipped };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            serverIds: t.Union([t.String(), t.Array(t.String())]),
          }),
        },
      )

      // ── GET /sessions/:id/mcp — List MCP servers attached to session ─
      .get(
        "/sessions/:id/mcp",
        ({ params, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          const servers = getSessionMcpServers(params.id);
          return { servers };
        },
        { params: t.Object({ id: t.String() }) },
      )

      // ── DELETE /sessions/:id/mcp/:serverId — Detach MCP server ───────
      .delete(
        "/sessions/:id/mcp/:serverId",
        ({ params, set }) => {
          const session = sessionDb.getById(params.id);
          if (!session) {
            set.status = 404;
            return { error: "Session not found" };
          }

          const current = getSessionMcpServers(params.id);
          const filtered = current.filter(
            (s) => s.serverId !== params.serverId,
          );

          if (filtered.length === current.length) {
            set.status = 404;
            return { error: "MCP server not attached to this session" };
          }

          setSessionMcpServers(params.id, filtered);
          return { success: true };
        },
        {
          params: t.Object({ id: t.String(), serverId: t.String() }),
        },
      )
  );
}
