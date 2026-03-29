/**
 * API Descriptor Routes
 *
 * Returns a JSON description of all AI plugin endpoints for the
 * frontend playground and curl command generation.
 * Mounted at /api/ai/descriptor by the plugin system.
 */

import { Elysia } from "elysia";

interface EndpointDescriptor {
  method: string;
  path: string;
  description: string;
  parameters?: Record<string, { type: string; required: boolean; description: string }>;
  body?: Record<string, { type: string; required: boolean; description: string }>;
}

const AI_ENDPOINTS: EndpointDescriptor[] = [
  // Tools
  { method: "GET", path: "/api/ai/tools", description: "List installed AI tools and their status" },

  // Prompt Templates
  { method: "GET", path: "/api/ai/prompts", description: "List prompt templates", parameters: { category: { type: "string", required: false, description: "Filter by category" }, tags: { type: "string", required: false, description: "Comma-separated tags" }, limit: { type: "number", required: false, description: "Max results" }, offset: { type: "number", required: false, description: "Pagination offset" } } },
  { method: "GET", path: "/api/ai/prompts/search", description: "Search prompt templates", parameters: { q: { type: "string", required: true, description: "Search query" } } },
  { method: "GET", path: "/api/ai/prompts/:id", description: "Get a prompt template by ID" },
  { method: "POST", path: "/api/ai/prompts", description: "Create a prompt template", body: { name: { type: "string", required: true, description: "Template name" }, content: { type: "string", required: true, description: "Template content with {{variables}}" }, category: { type: "string", required: false, description: "Category" }, tags: { type: "string[]", required: false, description: "Tags array" } } },
  { method: "PUT", path: "/api/ai/prompts/:id", description: "Update a prompt template" },
  { method: "DELETE", path: "/api/ai/prompts/:id", description: "Delete a prompt template" },
  { method: "POST", path: "/api/ai/prompts/:id/render", description: "Render template with variables", body: { variables: { type: "object", required: true, description: "Key-value map of variable values" } } },

  // Contexts
  { method: "GET", path: "/api/ai/contexts", description: "List context pieces", parameters: { type: { type: "string", required: false, description: "Filter by type" }, tags: { type: "string", required: false, description: "Comma-separated tags" } } },
  { method: "GET", path: "/api/ai/contexts/:id", description: "Get a context piece by ID" },
  { method: "POST", path: "/api/ai/contexts", description: "Create a context piece", body: { name: { type: "string", required: true, description: "Context name" }, type: { type: "string", required: true, description: "Type: git_repo|api_call|markdown_doc|command|plain_text|file|url" }, content: { type: "string", required: true, description: "Context content" }, tags: { type: "string[]", required: false, description: "Tags array" } } },
  { method: "PUT", path: "/api/ai/contexts/:id", description: "Update a context piece" },
  { method: "DELETE", path: "/api/ai/contexts/:id", description: "Delete a context piece" },

  // Sessions
  { method: "GET", path: "/api/ai/sessions", description: "List AI sessions", parameters: { agentType: { type: "string", required: false, description: "Filter by agent type" }, status: { type: "string", required: false, description: "Filter by status" } } },
  { method: "GET", path: "/api/ai/sessions/providers", description: "List available AI providers" },
  { method: "GET", path: "/api/ai/sessions/:id", description: "Get session details" },
  { method: "POST", path: "/api/ai/sessions", description: "Create an AI session", body: { name: { type: "string", required: true, description: "Session name" }, agentType: { type: "string", required: true, description: "Agent type (claude, codex, etc.)" }, config: { type: "object", required: false, description: "Session configuration" } } },
  { method: "POST", path: "/api/ai/sessions/:id/send", description: "Send a prompt to a session", body: { prompt: { type: "string", required: true, description: "Prompt content" }, contexts: { type: "array", required: false, description: "Context objects to include" } } },
  { method: "GET", path: "/api/ai/sessions/:id/logs", description: "Get session logs", parameters: { types: { type: "string", required: false, description: "Comma-separated log types" }, limit: { type: "number", required: false, description: "Max results" } } },
  { method: "GET", path: "/api/ai/sessions/:id/stats", description: "Get session usage stats" },
  { method: "PUT", path: "/api/ai/sessions/:id/config", description: "Update session configuration" },
  { method: "DELETE", path: "/api/ai/sessions/:id", description: "Terminate a session" },

  // Dispatch
  { method: "POST", path: "/api/ai/dispatch/compose", description: "Compose a prompt from template + vars + contexts" },
  { method: "POST", path: "/api/ai/dispatch/send", description: "Dispatch a prompt to a session" },
  { method: "GET", path: "/api/ai/dispatch/history", description: "View dispatch history" },
  { method: "GET", path: "/api/ai/dispatch/:id", description: "Get dispatch details" },

  // Queue
  { method: "GET", path: "/api/ai/queue", description: "List queue items" },
  { method: "POST", path: "/api/ai/queue/enqueue", description: "Add item to queue" },
  { method: "GET", path: "/api/ai/queue/:id", description: "Get queue item" },
  { method: "POST", path: "/api/ai/queue/:id/cancel", description: "Cancel queue item" },

  // Stats
  { method: "GET", path: "/api/ai/stats/overview", description: "Aggregated usage overview" },
  { method: "GET", path: "/api/ai/stats/sessions/:id", description: "Per-session stats" },
  { method: "GET", path: "/api/ai/stats/usage", description: "Usage breakdown by provider" },
];

export function createApiDescriptorRoutes() {
  return new Elysia({ prefix: "/descriptor" })
    .get("/", () => {
      return {
        name: "VibeControls AI Plugin API",
        version: "3.0.0",
        baseUrl: "/api/ai",
        endpoints: AI_ENDPOINTS,
      };
    })

    .post("/curl", ({ body }) => {
      const { method, path, baseUrl, headers, body: reqBody } = body;
      const fullUrl = `${baseUrl || "http://localhost:3005"}${path}`;

      let curl = `curl -X ${method} '${fullUrl}'`;

      // Add headers
      const allHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        ...headers,
      };
      for (const [key, value] of Object.entries(allHeaders)) {
        curl += ` \\\n  -H '${key}: ${value}'`;
      }

      // Add body
      if (reqBody && ["POST", "PUT", "PATCH"].includes(method)) {
        curl += ` \\\n  -d '${JSON.stringify(reqBody, null, 2)}'`;
      }

      return { curl };
    });
}
