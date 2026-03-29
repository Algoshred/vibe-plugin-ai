import type { Command } from "commander";
import { Elysia } from "elysia";
import { PromptDatabase } from "./db/prompts.js";
import { ContextDatabase } from "./db/contexts.js";
import { SessionDatabase } from "./db/sessions.js";
import { LogDatabase } from "./db/logs.js";
import { DispatchedPromptDatabase } from "./db/dispatched-prompts.js";
import { QueueDatabase } from "./db/queue.js";
import { createPromptRoutes } from "./routes/prompts.js";
import { createContextRoutes } from "./routes/contexts.js";
import { createSessionRoutes } from "./routes/sessions.js";
import { createDispatchRoutes } from "./routes/dispatch.js";
import { createQueueRoutes } from "./routes/queue.js";
import { createStatsRoutes } from "./routes/stats.js";
import { createApiDescriptorRoutes } from "./routes/api-descriptor.js";
import { QueueProcessor } from "./services/queue-processor.js";

/**
 * @burdenoff/vibe-plugin-ai v4.0.0
 *
 * AI orchestration hub for VibeControls Agent.
 *
 * Features:
 *   - AI tool detection and management
 *   - Prompt templates with variable substitution
 *   - Context management (git repos, API calls, docs, commands, etc.)
 *   - AI session management (connects to provider plugins)
 *   - Prompt composition, dispatch, and queuing
 *   - Per-session logging with full visibility
 *   - Usage stats and monitoring
 *   - API descriptor for playground
 *
 * Supported provider plugins:
 *   - @vibecontrols/vibe-plugin-claude (Claude Code)
 *   - @vibecontrols/vibe-plugin-codex (OpenAI Codex CLI)
 *   - @vibecontrols/vibe-plugin-opencode (OpenCode)
 *   - @vibecontrols/vibe-plugin-copilot (GitHub Copilot)
 *   - @vibecontrols/vibe-plugin-gemini (Google Gemini/Vertex AI)
 */

// ── Plugin Interfaces ────────────────────────────────────────────────────

export interface HostServices {
  logger?: {
    info: (source: string, msg: string) => void;
    warn: (source: string, msg: string) => void;
    error: (source: string, msg: string) => void;
    debug: (source: string, msg: string) => void;
  };
  config?: Record<string, unknown>;
  serviceRegistry?: {
    registerService: (
      pluginName: string,
      serviceName: string,
      service: unknown,
    ) => void;
    getProviderByName: <T>(type: string, name: string) => T | undefined;
    listProvidersForType: (
      type: string,
    ) => Array<{ pluginName: string; isDefault: boolean }>;
  };
}

export interface VibePlugin {
  name: string;
  version: string;
  description: string;
  tags?: Array<
    "backend" | "frontend" | "cli" | "provider" | "adapter" | "integration"
  >;
  cliCommand: string;
  apiPrefix?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createRoutes?: () => any;
  onCliSetup: (program: Command, hostServices?: HostServices) => void;
  onServerStart?: (app: unknown, hostServices?: HostServices) => void;
  onServerReady?: (app: unknown, hostServices?: HostServices) => void;
  onServerStop?: () => void;
}

// ── Re-exports ───────────────────────────────────────────────────────────

export type {
  Prompt,
  PromptCategory,
  CreatePromptInput,
  UpdatePromptInput,
  PromptFilter,
} from "./db/prompts.js";

export type {
  AIContextRecord,
  ContextType,
  CreateContextInput,
  UpdateContextInput,
  ContextFilter,
} from "./db/contexts.js";

export type {
  AISessionRecord,
  SessionStatus,
  CreateSessionInput,
  UpdateSessionInput,
} from "./db/sessions.js";

export type {
  AILogRecord,
  LogType,
  CreateLogInput,
  LogFilter,
} from "./db/logs.js";

export type {
  DispatchedPromptRecord,
  DispatchStatus,
} from "./db/dispatched-prompts.js";

export type { QueueItem, QueueStatus } from "./db/queue.js";

// ── Tool Definitions ─────────────────────────────────────────────────────

interface AiTool {
  name: string;
  displayName: string;
  detectCommand: string;
  installCommand?: string;
  configFiles: string[];
  description: string;
}

const AI_TOOLS: AiTool[] = [
  {
    name: "claude-code",
    displayName: "Claude Code",
    detectCommand: "claude",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    configFiles: ["CLAUDE.md", ".claude/settings.json"],
    description: "Anthropic's AI coding agent",
  },
  {
    name: "opencode",
    displayName: "OpenCode",
    detectCommand: "opencode",
    installCommand: "npm install -g opencode",
    configFiles: ["OPENCODE.md", ".opencode/config.json"],
    description: "Open-source AI coding assistant",
  },
  {
    name: "codex",
    displayName: "OpenAI Codex CLI",
    detectCommand: "codex",
    installCommand: "npm install -g @openai/codex",
    configFiles: ["AGENTS.md", "codex.json"],
    description: "OpenAI's Codex CLI agent",
  },
  {
    name: "copilot",
    displayName: "GitHub Copilot",
    detectCommand: "github-copilot-cli",
    installCommand: "npm install -g @githubnext/github-copilot-cli",
    configFiles: [".github/copilot-instructions.md"],
    description: "GitHub Copilot in the CLI",
  },
  {
    name: "cursor-agent",
    displayName: "Cursor Agent",
    detectCommand: "cursor",
    configFiles: [".cursor/rules", ".cursorrules"],
    description: "Cursor AI code editor agent",
  },
];

// ── Helper Functions ─────────────────────────────────────────────────────

import { join } from "node:path";

function isToolInstalled(tool: AiTool): {
  installed: boolean;
  version: string;
} {
  try {
    const proc = Bun.spawnSync([tool.detectCommand, "--version"], {
      timeout: 5000,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode === 0) {
      return { installed: true, version: proc.stdout.toString().trim() };
    }
    return { installed: false, version: "" };
  } catch {
    return { installed: false, version: "" };
  }
}

function runInstallCommand(command: string): boolean {
  const parts = command.split(" ");
  const proc = Bun.spawnSync(parts, {
    timeout: 120_000,
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exitCode === 0;
}

function findConfigFiles(tool: AiTool, directory: string): string[] {
  return tool.configFiles.filter((f) => {
    try {
      return Bun.file(join(directory, f)).size > 0;
    } catch {
      return false;
    }
  });
}

function generateStarterConfig(tool: AiTool): string {
  switch (tool.name) {
    case "claude-code":
      return `# CLAUDE.md\n\nThis file provides guidance to Claude Code when working with this project.\n\n## Project Overview\n\n<!-- Describe your project here -->\n\n## Build & Development Commands\n\n\`\`\`bash\nbun run dev\nbun run build\nbun run test\n\`\`\`\n`;
    case "codex":
      return `# AGENTS.md\n\nInstructions for AI agents working on this project.\n\n## Project Overview\n\n<!-- Describe your project here -->\n`;
    case "copilot":
      return `# Copilot Instructions\n\n## Project Context\n\n<!-- Describe your project for GitHub Copilot -->\n`;
    case "cursor-agent":
      return `# Cursor Rules\n\n## Project Overview\n\n<!-- Describe your project here -->\n`;
    default:
      return `# ${tool.displayName} Configuration\n\n<!-- Add your configuration here -->\n`;
  }
}

// ── Database Singletons ──────────────────────────────────────────────────

let promptDb: PromptDatabase | null = null;
let contextDb: ContextDatabase | null = null;
let sessionDb: SessionDatabase | null = null;
let logDb: LogDatabase | null = null;
let dispatchDb: DispatchedPromptDatabase | null = null;
let queueDb: QueueDatabase | null = null;
let queueProcessor: QueueProcessor | null = null;
let hostServicesRef: HostServices | null = null;

function getPromptDb(): PromptDatabase {
  if (!promptDb) promptDb = new PromptDatabase();
  return promptDb;
}

function getContextDb(): ContextDatabase {
  if (!contextDb) contextDb = new ContextDatabase();
  return contextDb;
}

function getSessionDb(): SessionDatabase {
  if (!sessionDb) sessionDb = new SessionDatabase();
  return sessionDb;
}

function getLogDb(): LogDatabase {
  if (!logDb) logDb = new LogDatabase();
  return logDb;
}

function getDispatchDb(): DispatchedPromptDatabase {
  if (!dispatchDb) dispatchDb = new DispatchedPromptDatabase();
  return dispatchDb;
}

function getQueueDb(): QueueDatabase {
  if (!queueDb) queueDb = new QueueDatabase();
  return queueDb;
}

function getAIProvider(agentType: string): unknown | undefined {
  return hostServicesRef?.serviceRegistry?.getProviderByName("ai", agentType);
}

function listAIProviders(): Array<{
  pluginName: string;
  isDefault: boolean;
}> {
  return hostServicesRef?.serviceRegistry?.listProvidersForType("ai") || [];
}

// ── Log Ingester Service ────────────────────────────────────────────────

/**
 * Log ingester service registered via ServiceRegistry.
 * Provider plugins call this to log AI interactions.
 */
const logIngester = {
  append(input: {
    sessionId: string;
    type: "input" | "output" | "thinking" | "event" | "error" | "metadata";
    content: string;
    tokenCount?: number;
    model?: string;
    durationMs?: number;
    agentMetadata?: Record<string, unknown>;
  }) {
    const db = getLogDb();
    return db.append(input);
  },
};

// ── Plugin Export ────────────────────────────────────────────────────────

export const vibePlugin: VibePlugin = {
  name: "ai",
  version: "4.0.0",
  description:
    "AI orchestration hub — prompt templates, context management, session dispatch, logging, and stats",
  tags: ["backend", "cli", "integration"],
  cliCommand: "ai",
  apiPrefix: "/api/ai",

  createRoutes() {
    return new Elysia()
      // Tool detection
      .get("/tools", () => ({
        tools: AI_TOOLS.map((tool) => {
          const { installed, version } = isToolInstalled(tool);
          const configs = findConfigFiles(tool, process.cwd());
          return {
            name: tool.name,
            displayName: tool.displayName,
            description: tool.description,
            installed,
            version: installed ? version.split("\n")[0] : "",
            configFiles: tool.configFiles,
            foundConfigs: configs,
            installCommand: tool.installCommand,
          };
        }),
      }))
      // Prompt templates
      .use(createPromptRoutes(getPromptDb()))
      // Context management
      .use(createContextRoutes(getContextDb()))
      // AI sessions
      .use(
        createSessionRoutes({
          sessionDb: getSessionDb(),
          logDb: getLogDb(),
          getAIProvider,
          listAIProviders,
        }),
      )
      // Prompt dispatch
      .use(
        createDispatchRoutes({
          dispatchDb: getDispatchDb(),
          promptDb: getPromptDb(),
          contextDb: getContextDb(),
          sessionDb: getSessionDb(),
          logDb: getLogDb(),
          queueDb: getQueueDb(),
          getAIProvider,
        }),
      )
      // Queue management
      .use(createQueueRoutes(getQueueDb()))
      // Stats
      .use(createStatsRoutes(getSessionDb(), getLogDb()))
      // API descriptor
      .use(createApiDescriptorRoutes());
  },

  onServerStart(_app, hostServices) {
    hostServicesRef = hostServices || null;

    // Initialize all databases
    getPromptDb();
    getContextDb();
    getSessionDb();
    getLogDb();
    getDispatchDb();
    getQueueDb();

    // Register log ingester service for provider plugins
    if (hostServices?.serviceRegistry) {
      hostServices.serviceRegistry.registerService(
        "ai",
        "log-ingester",
        logIngester,
      );
    }

    hostServices?.logger?.info(
      "ai-plugin",
      "AI orchestration hub started — all databases initialized",
    );
  },

  onServerReady(_app, hostServices) {
    // Start queue processor
    queueProcessor = new QueueProcessor({
      queueDb: getQueueDb(),
      dispatchDb: getDispatchDb(),
      sessionDb: getSessionDb(),
      logDb: getLogDb(),
      getAIProvider,
      logger: hostServices?.logger,
    });
    queueProcessor.start(5000);

    hostServices?.logger?.info("ai-plugin", "Queue processor started");
  },

  onServerStop() {
    // Stop queue processor
    if (queueProcessor) {
      queueProcessor.stop();
      queueProcessor = null;
    }

    // Close all databases
    if (promptDb) {
      promptDb.close();
      promptDb = null;
    }
    if (contextDb) {
      contextDb.close();
      contextDb = null;
    }
    if (sessionDb) {
      sessionDb.close();
      sessionDb = null;
    }
    if (logDb) {
      logDb.close();
      logDb = null;
    }
    if (dispatchDb) {
      dispatchDb.close();
      dispatchDb = null;
    }
    if (queueDb) {
      queueDb.close();
      queueDb = null;
    }

    hostServicesRef = null;
  },

  onCliSetup(program: Command, _hostServices?: HostServices) {
    const aiCmd = program
      .command("ai")
      .description(
        "AI orchestration — tools, prompts, contexts, sessions, dispatch",
      );

    // ── vibe ai list ────────────────────────────────────────────────
    aiCmd
      .command("list")
      .description("List all supported AI tools and their status")
      .option("--cwd <dir>", "Project directory to check configs", process.cwd())
      .action((options: { cwd: string }) => {
        console.log("\n  \x1b[1m── AI Tools ──\x1b[0m\n");
        for (const tool of AI_TOOLS) {
          const { installed, version } = isToolInstalled(tool);
          const icon = installed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
          const versionStr = installed ? ` (${version.split("\n")[0]})` : "";
          console.log(`  ${icon} \x1b[1m${tool.displayName}\x1b[0m${versionStr}`);
          console.log(`    ${tool.description}`);
          const configs = findConfigFiles(tool, options.cwd);
          console.log(configs.length > 0 ? `    Config: ${configs.join(", ")}` : "    Config: (none found)");
          console.log();
        }
      });

    // ── vibe ai install <tool> ──────────────────────────────────────
    aiCmd
      .command("install")
      .description("Install an AI tool")
      .argument("<tool>", `Tool name (${AI_TOOLS.map((t) => t.name).join(", ")})`)
      .action((toolName: string) => {
        const tool = AI_TOOLS.find((t) => t.name === toolName);
        if (!tool) {
          console.error(`\x1b[31mError:\x1b[0m Unknown tool '${toolName}'. Available: ${AI_TOOLS.map((t) => t.name).join(", ")}`);
          process.exit(1);
        }
        if (!tool.installCommand) {
          console.error(`\x1b[31mError:\x1b[0m '${tool.displayName}' must be installed manually.`);
          process.exit(1);
        }
        const { installed } = isToolInstalled(tool);
        if (installed) {
          console.log(`  \x1b[32m✓ ${tool.displayName} is already installed.\x1b[0m`);
          return;
        }
        console.log(`  Installing ${tool.displayName}...`);
        const success = runInstallCommand(tool.installCommand);
        if (success) {
          console.log(`\n  \x1b[32m✓ ${tool.displayName} installed successfully.\x1b[0m\n`);
        } else {
          console.error(`\n  \x1b[31m✗ Failed to install ${tool.displayName}.\x1b[0m`);
          console.error(`  Try manually: ${tool.installCommand}\n`);
          process.exit(1);
        }
      });

    // ── vibe ai init <tool> ─────────────────────────────────────────
    aiCmd
      .command("init")
      .description("Initialize AI tool config in the current project")
      .argument("<tool>", "Tool name")
      .option("--cwd <dir>", "Project directory", process.cwd())
      .action(async (toolName: string, options: { cwd: string }) => {
        const tool = AI_TOOLS.find((t) => t.name === toolName);
        if (!tool) {
          console.error(`\x1b[31mError:\x1b[0m Unknown tool '${toolName}'.`);
          process.exit(1);
        }
        const dir = options.cwd;
        const primaryConfig = tool.configFiles[0];
        const configPath = join(dir, primaryConfig);
        try {
          if (Bun.file(configPath).size >= 0) {
            console.log(`  \x1b[33m⚠\x1b[0m  ${primaryConfig} already exists in ${dir}`);
            return;
          }
        } catch {
          // File doesn't exist — proceed
        }
        const { mkdirSync } = await import("node:fs");
        const segments = primaryConfig.split("/");
        if (segments.length > 1) {
          mkdirSync(join(dir, ...segments.slice(0, -1)), { recursive: true });
        }
        const content = generateStarterConfig(tool);
        await Bun.write(configPath, content);
        console.log(`\n  \x1b[32m✓ Created ${primaryConfig}\x1b[0m in ${dir}\n`);
      });

    // ── vibe ai check ───────────────────────────────────────────────
    aiCmd
      .command("check")
      .description("Check which AI tools are installed")
      .action(() => {
        console.log("\n  \x1b[1m── AI Tool Check ──\x1b[0m\n");
        let allInstalled = true;
        for (const tool of AI_TOOLS) {
          const { installed, version } = isToolInstalled(tool);
          const icon = installed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
          console.log(`  ${icon} ${tool.displayName.padEnd(20)} ${installed ? version.split("\n")[0] : "not installed"}`);
          if (!installed) allInstalled = false;
        }
        console.log();
        if (!allInstalled) {
          console.log("  Install missing tools: \x1b[1mvibe ai install <tool>\x1b[0m\n");
        }
      });

    // ── vibe ai prompts ─────────────────────────────────────────────
    const promptsCmd = aiCmd.command("prompts").description("Manage prompt templates");

    promptsCmd
      .command("list")
      .description("List all prompt templates")
      .option("--shared", "Show only shared prompts")
      .option("--category <cat>", "Filter by category")
      .option("--limit <n>", "Max results", "20")
      .action((options: { shared?: boolean; category?: string; limit: string }) => {
        const db = getPromptDb();
        const result = db.list(
          {
            isShared: options.shared !== undefined ? options.shared : undefined,
            category: options.category as Parameters<typeof db.list>[0] extends { category?: infer C } ? C : undefined,
          },
          { limit: parseInt(options.limit, 10) },
        );
        if (result.items.length === 0) {
          console.log("\n  No prompts found.\n");
          return;
        }
        console.log(`\n  \x1b[1m── Prompts (${result.total}) ──\x1b[0m\n`);
        for (const prompt of result.items) {
          const shared = prompt.isShared ? " \x1b[36m[shared]\x1b[0m" : "";
          const tags = prompt.tags.length > 0 ? ` \x1b[33m[${prompt.tags.join(", ")}]\x1b[0m` : "";
          const uses = prompt.usageCount > 0 ? ` \x1b[90m(${prompt.usageCount} uses)\x1b[0m` : "";
          console.log(`  \x1b[1m${prompt.name}\x1b[0m${shared}${tags}${uses}`);
          const preview = prompt.content.replace(/\n/g, " ").slice(0, 60).trim();
          console.log(`    ${preview}${prompt.content.length > 60 ? "..." : ""}`);
          console.log();
        }
      });

    promptsCmd
      .command("search")
      .description("Search prompts")
      .argument("<query>", "Search query")
      .option("--limit <n>", "Max results", "10")
      .action((query: string, options: { limit: string }) => {
        const db = getPromptDb();
        const results = db.search(query, undefined, parseInt(options.limit, 10));
        if (results.length === 0) {
          console.log(`\n  No prompts matching "${query}".\n`);
          return;
        }
        console.log(`\n  \x1b[1m── Search: "${query}" (${results.length} results) ──\x1b[0m\n`);
        for (const prompt of results) {
          console.log(`  \x1b[1m${prompt.name}\x1b[0m \x1b[90m(${prompt.usageCount} uses)\x1b[0m`);
          const preview = prompt.content.replace(/\n/g, " ").slice(0, 60).trim();
          console.log(`    ${preview}${prompt.content.length > 60 ? "..." : ""}`);
          console.log();
        }
      });

    promptsCmd
      .command("show")
      .description("Show a prompt by ID")
      .argument("<id>", "Prompt ID")
      .action((id: string) => {
        const db = getPromptDb();
        const prompt = db.getById(id);
        if (!prompt) {
          console.error(`\x1b[31mError:\x1b[0m Prompt not found: ${id}`);
          process.exit(1);
        }
        console.log(`\n  \x1b[1m${prompt.name}\x1b[0m`);
        if (prompt.tags.length > 0) console.log(`  Tags: ${prompt.tags.join(", ")}`);
        if (prompt.variables.length > 0) console.log(`  Variables: ${prompt.variables.map((v) => `{{${v}}}`).join(", ")}`);
        console.log(`  Shared: ${prompt.isShared ? "yes" : "no"} | Uses: ${prompt.usageCount}`);
        console.log(`\n${prompt.content}\n`);
      });

    // ── vibe ai contexts ────────────────────────────────────────────
    const contextsCmd = aiCmd.command("contexts").description("Manage reusable context pieces");

    contextsCmd
      .command("list")
      .description("List all contexts")
      .option("--type <type>", "Filter by type")
      .option("--limit <n>", "Max results", "20")
      .action((options: { type?: string; limit: string }) => {
        const db = getContextDb();
        const result = db.list(
          options.type ? { type: options.type as Parameters<typeof db.list>[0] extends { type?: infer T } ? T : undefined } : undefined,
          { limit: parseInt(options.limit, 10) },
        );
        if (result.items.length === 0) {
          console.log("\n  No contexts found.\n");
          return;
        }
        console.log(`\n  \x1b[1m── Contexts (${result.total}) ──\x1b[0m\n`);
        for (const ctx of result.items) {
          const tags = ctx.tags.length > 0 ? ` \x1b[33m[${ctx.tags.join(", ")}]\x1b[0m` : "";
          console.log(`  \x1b[1m${ctx.name}\x1b[0m \x1b[90m(${ctx.type})\x1b[0m${tags}`);
          const preview = ctx.content.replace(/\n/g, " ").slice(0, 60).trim();
          console.log(`    ${preview}${ctx.content.length > 60 ? "..." : ""}`);
          console.log();
        }
      });

    contextsCmd
      .command("show")
      .description("Show a context by ID")
      .argument("<id>", "Context ID")
      .action((id: string) => {
        const db = getContextDb();
        const ctx = db.getById(id);
        if (!ctx) {
          console.error(`\x1b[31mError:\x1b[0m Context not found: ${id}`);
          process.exit(1);
        }
        console.log(`\n  \x1b[1m${ctx.name}\x1b[0m \x1b[90m(${ctx.type})\x1b[0m`);
        if (ctx.tags.length > 0) console.log(`  Tags: ${ctx.tags.join(", ")}`);
        console.log(`\n${ctx.content}\n`);
      });

    // ── vibe ai sessions ────────────────────────────────────────────
    const sessionsCmd = aiCmd.command("sessions").description("Manage AI sessions");

    sessionsCmd
      .command("list")
      .description("List AI sessions")
      .option("--status <status>", "Filter by status")
      .action((options: { status?: string }) => {
        const db = getSessionDb();
        const result = db.list(
          options.status ? { status: options.status as Parameters<typeof db.list>[0] extends { status?: infer S } ? S : undefined } : undefined,
        );
        if (result.items.length === 0) {
          console.log("\n  No sessions found.\n");
          return;
        }
        console.log(`\n  \x1b[1m── AI Sessions (${result.total}) ──\x1b[0m\n`);
        for (const session of result.items) {
          const statusColor = session.status === "active" ? "\x1b[32m" : session.status === "error" ? "\x1b[31m" : "\x1b[33m";
          console.log(`  \x1b[1m${session.name}\x1b[0m ${statusColor}[${session.status}]\x1b[0m \x1b[90m(${session.agentType})\x1b[0m`);
          console.log(`    ID: ${session.id} | Created: ${session.createdAt}`);
          console.log();
        }
      });

    // ── vibe ai stats ───────────────────────────────────────────────
    aiCmd
      .command("stats")
      .description("Show AI usage statistics")
      .action(() => {
        const sDb = getSessionDb();
        const lDb = getLogDb();
        const sessions = sDb.list(undefined, { limit: 1000 });

        let totalInput = 0;
        let totalOutput = 0;
        for (const session of sessions.items) {
          const stats = lDb.getSessionStats(session.id);
          totalInput += stats.totalInputTokens;
          totalOutput += stats.totalOutputTokens;
        }

        console.log("\n  \x1b[1m── AI Usage Stats ──\x1b[0m\n");
        console.log(`  Sessions:      ${sessions.total}`);
        console.log(`  Active:        ${sessions.items.filter((s) => s.status !== "terminated").length}`);
        console.log(`  Input tokens:  ${totalInput.toLocaleString()}`);
        console.log(`  Output tokens: ${totalOutput.toLocaleString()}`);
        console.log();
      });
  },
};

export default vibePlugin;
