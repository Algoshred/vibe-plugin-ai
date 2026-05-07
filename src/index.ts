import type { Command } from "commander";
import { Elysia } from "elysia";
import {
  runMultimode,
  pickOutputMode,
  maybePrintJson,
} from "./utils/multimode.js";
import {
  interactiveTable,
  interactiveDetail,
  type TableRow,
} from "./utils/interactive.js";
import { PromptDatabase } from "./db/prompts.js";
import { ContextDatabase } from "./db/contexts.js";
import { SessionDatabase } from "./db/sessions.js";
import { LogDatabase } from "./db/logs.js";
import { DispatchedPromptDatabase } from "./db/dispatched-prompts.js";
import { QueueDatabase } from "./db/queue.js";
import { FileDatabase } from "./db/files.js";
import { createPromptRoutes } from "./routes/prompts.js";
import { createContextRoutes } from "./routes/contexts.js";
import { createSessionRoutes } from "./routes/sessions.js";
import { createDispatchRoutes } from "./routes/dispatch.js";
import { createQueueRoutes } from "./routes/queue.js";
import { createStatsRoutes } from "./routes/stats.js";
import { createApiDescriptorRoutes } from "./routes/api-descriptor.js";
import { createStreamRoutes } from "./routes/stream.js";
import { createFileRoutes } from "./routes/files.js";
import { createModelRoutes } from "./routes/models.js";
import { createCancelRoutes } from "./routes/cancel.js";
import { createMcpRoutes } from "./routes/mcp.js";
import { createSearchRoutes } from "./routes/search.js";
import { createExportRoutes } from "./routes/export.js";
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

import type { StorageProvider } from "./db/storage-provider-types.js";
import type { ProviderMode } from "./provider.js";

const PROVIDER_MODES: ProviderMode[] = ["sdk", "cli"];

export interface AIProviderSummary {
  pluginName: string;
  name: string;
  displayName: string;
  isDefault: boolean;
  currentMode: ProviderMode;
  defaultMode: ProviderMode;
  supportedModes: ProviderMode[];
  unsupportedModes: ProviderMode[];
  modes: Record<ProviderMode, boolean>;
  prereqApiPrefix?: string;
}

interface RegisteredAIProvider {
  readonly name?: string;
  getMode?: () => ProviderMode;
  getSupportedModes?: () => ProviderMode[];
  getDisplayName?: () => string;
  getPrereqApiPrefix?: () => string;
}

export interface CliContributorRegistryLike {
  addStatusSection(section: {
    source: string;
    title: string;
    render: (ctx: { agentUrl: string }) => Promise<string | null>;
    json?: (ctx: { agentUrl: string }) => Promise<unknown>;
    jsonKey?: string;
  }): void;
  addDoctorCheck(check: {
    source: string;
    run: () => Promise<
      Array<{
        name: string;
        ok: boolean;
        grade?: "warn";
        message: string;
        hint?: string;
      }>
    >;
  }): void;
}

export interface HostServices {
  logger?: {
    info: (source: string, msg: string) => void;
    warn: (source: string, msg: string) => void;
    error: (source: string, msg: string) => void;
    debug: (source: string, msg: string) => void;
  };
  config?: Record<string, unknown>;
  storage?: StorageProvider;
  serviceRegistry?: {
    registerService: (
      pluginName: string,
      serviceName: string,
      service: unknown,
    ) => void;
    getProviderByName: <T>(type: string, name: string) => T | undefined;
    listProvidersForType: (type: string) => Array<{
      pluginName: string;
      isDefault: boolean;
    }>;
  };
  cliContributors?: CliContributorRegistryLike;
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

export type * from "./provider.js";

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

export type { AIFileRecord, CreateFileInput } from "./db/files.js";

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

const SECRET_KEY_RE = /(token|secret|password|apikey|api_key)/i;

function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

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
let fileDb: FileDatabase | null = null;
let queueProcessor: QueueProcessor | null = null;
let hostServicesRef: HostServices | null = null;

function requireDb<T extends object | null>(
  db: T,
  name: string,
): NonNullable<T> {
  if (!db) {
    throw new Error(
      `AI plugin: ${name} accessed before onServerStart hydrated storage`,
    );
  }
  return db as NonNullable<T>;
}

function getPromptDb(): PromptDatabase {
  return requireDb(promptDb, "PromptDatabase");
}
function getContextDb(): ContextDatabase {
  return requireDb(contextDb, "ContextDatabase");
}
function getSessionDb(): SessionDatabase {
  return requireDb(sessionDb, "SessionDatabase");
}
function getLogDb(): LogDatabase {
  return requireDb(logDb, "LogDatabase");
}
function getDispatchDb(): DispatchedPromptDatabase {
  return requireDb(dispatchDb, "DispatchedPromptDatabase");
}
function getQueueDb(): QueueDatabase {
  return requireDb(queueDb, "QueueDatabase");
}
function getFileDb(): FileDatabase {
  return requireDb(fileDb, "FileDatabase");
}

function getAIProvider(agentType: string): unknown | undefined {
  return hostServicesRef?.serviceRegistry?.getProviderByName("ai", agentType);
}

function providerDisplayName(name: string): string {
  return name
    .replace(/^ai-/, "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeModes(modes: ProviderMode[] | undefined): ProviderMode[] {
  const unique = new Set<ProviderMode>();
  for (const mode of modes ?? []) {
    if (PROVIDER_MODES.includes(mode)) unique.add(mode);
  }
  return [...unique];
}

function listAIProviders(): AIProviderSummary[] {
  const registry = hostServicesRef?.serviceRegistry;
  if (!registry) return [];

  return registry.listProvidersForType("ai").map((entry) => {
    const provider = registry.getProviderByName<RegisteredAIProvider>(
      "ai",
      entry.pluginName,
    );
    const currentMode = provider?.getMode?.() ?? "cli";
    const supportedModes = normalizeModes(provider?.getSupportedModes?.());
    if (supportedModes.length === 0) supportedModes.push(currentMode);

    const unsupportedModes = PROVIDER_MODES.filter(
      (mode) => !supportedModes.includes(mode),
    );
    const defaultMode = supportedModes.includes(currentMode)
      ? currentMode
      : (supportedModes[0] ?? "cli");

    return {
      pluginName: entry.pluginName,
      name: provider?.name ?? entry.pluginName,
      displayName:
        provider?.getDisplayName?.() ?? providerDisplayName(entry.pluginName),
      isDefault: entry.isDefault,
      currentMode,
      defaultMode,
      supportedModes,
      unsupportedModes,
      modes: {
        sdk: supportedModes.includes("sdk"),
        cli: supportedModes.includes("cli"),
      },
      prereqApiPrefix: provider?.getPrereqApiPrefix?.(),
    };
  });
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

  createRoutes(deps?: { hostServices?: HostServices }) {
    // Build all sub-routes first, then compose into a single Elysia
    // NOTE: We use Elysia.mount() pattern instead of .use() chaining
    // because deeply nested .use() breaks route resolution in some
    // Elysia versions when the parent router also uses .use() nesting.
    //
    // Storage provider comes from the agent's PluginRouteDeps
    // (passed by plugin-router.ts). DBs are instantiated here with
    // an empty cache — hydration happens async in onServerStart.
    const storage = deps?.hostServices?.storage;
    if (!storage) {
      throw new Error(
        "vibe-plugin-ai: hostServices.storage is required but missing — " +
          "the agent must pass a StorageProvider via PluginRouteDeps.",
      );
    }
    hostServicesRef = deps?.hostServices || null;
    const kvLogger = deps?.hostServices?.logger;

    promptDb = new PromptDatabase(storage, kvLogger);
    contextDb = new ContextDatabase(storage, kvLogger);
    sessionDb = new SessionDatabase(storage, kvLogger);
    logDb = new LogDatabase(storage, kvLogger);
    dispatchDb = new DispatchedPromptDatabase(storage, kvLogger);
    queueDb = new QueueDatabase(storage, kvLogger);
    fileDb = new FileDatabase(storage, kvLogger);

    const app = new Elysia();

    // Tool detection (inline)
    app.get("/tools", () => ({
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
    }));

    // Mount sub-route modules
    const subRoutes = [
      createSessionRoutes({
        sessionDb: getSessionDb(),
        logDb: getLogDb(),
        getAIProvider,
        listAIProviders,
      }),
      createDispatchRoutes({
        dispatchDb: getDispatchDb(),
        promptDb: getPromptDb(),
        contextDb: getContextDb(),
        sessionDb: getSessionDb(),
        logDb: getLogDb(),
        queueDb: getQueueDb(),
        getAIProvider,
      }),
      createPromptRoutes(getPromptDb()),
      createContextRoutes(getContextDb()),
      createStreamRoutes({
        sessionDb: getSessionDb(),
        logDb: getLogDb(),
        getAIProvider,
      }),
      createFileRoutes({
        sessionDb: getSessionDb(),
        fileDb: getFileDb(),
      }),
      createCancelRoutes({
        sessionDb: getSessionDb(),
        getAIProvider,
      }),
      createExportRoutes({
        sessionDb: getSessionDb(),
        logDb: getLogDb(),
      }),
      createModelRoutes({
        getAIProvider,
        listAIProviders,
      }),
      createMcpRoutes({
        sessionDb: getSessionDb(),
      }),
      createSearchRoutes({
        logDb: getLogDb(),
      }),
      createQueueRoutes(getQueueDb()),
      createStatsRoutes(getSessionDb(), getLogDb()),
      createApiDescriptorRoutes(),
    ];

    for (const subRoute of subRoutes) {
      app.use(subRoute);
    }

    return app;
  },

  async onServerStart(_app, hostServices) {
    hostServicesRef = hostServices || null;

    // Hydrate all KV tables from the agent's encrypted storage
    // before handling any requests. DBs were constructed in
    // createRoutes; here we warm the in-memory cache.
    if (
      promptDb &&
      contextDb &&
      sessionDb &&
      logDb &&
      dispatchDb &&
      queueDb &&
      fileDb
    ) {
      await Promise.all([
        promptDb.hydrate(),
        contextDb.hydrate(),
        sessionDb.hydrate(),
        logDb.hydrate(),
        dispatchDb.hydrate(),
        queueDb.hydrate(),
        fileDb.hydrate(),
      ]);

      // Legacy local database import is intentionally disabled. AI plugin
      // state must flow through the agent storage provider backed by Skalex.
    }

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
      "AI orchestration hub started — all databases hydrated",
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
    // Event-driven now — `start()` defaults to a 60s safety drain.
    queueProcessor.start();

    hostServices?.logger?.info(
      "ai-plugin",
      "Queue processor started (event-driven)",
    );
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
    if (fileDb) {
      fileDb.close();
      fileDb = null;
    }

    hostServicesRef = null;
  },

  onCliSetup(program: Command, hostServices?: HostServices) {
    registerStatusContributors(hostServices);
    const aiCmd = program
      .command("ai")
      .description(
        "AI orchestration — tools, prompts, contexts, sessions, dispatch",
      );

    // ── vibe ai list ────────────────────────────────────────────────
    aiCmd
      .command("list")
      .description("List all supported AI tools and their status")
      .option(
        "--cwd <dir>",
        "Project directory to check configs",
        process.cwd(),
      )
      .option("--json", "Emit JSON")
      .option("--plain", "Force plain text output")
      .action(
        async (options: { cwd: string; json?: boolean; plain?: boolean }) => {
          interface ToolRow {
            tool: AiTool;
            installed: boolean;
            version: string;
            configs: string[];
          }
          await runMultimode<ToolRow[]>({
            mode: pickOutputMode(options),
            fetchData: () =>
              AI_TOOLS.map((tool) => {
                const { installed, version } = isToolInstalled(tool);
                const configs = findConfigFiles(tool, options.cwd);
                return { tool, installed, version, configs };
              }),
            plain: (rows) => {
              console.log("\n  \x1b[1m── AI Tools ──\x1b[0m\n");
              for (const { tool, installed, version, configs } of rows) {
                const icon = installed
                  ? "\x1b[32m✓\x1b[0m"
                  : "\x1b[31m✗\x1b[0m";
                const versionStr = installed
                  ? ` (${version.split("\n")[0]})`
                  : "";
                console.log(
                  `  ${icon} \x1b[1m${tool.displayName}\x1b[0m${versionStr}`,
                );
                console.log(`    ${tool.description}`);
                console.log(
                  configs.length > 0
                    ? `    Config: ${configs.join(", ")}`
                    : "    Config: (none found)",
                );
                console.log();
              }
            },
            interactive: async (rows) => {
              const tableRows: TableRow[] = rows.map(
                ({ tool, installed, version, configs }) => ({
                  id: tool.name,
                  label: tool.displayName,
                  hint: installed
                    ? `installed${version ? " " + version.split("\n")[0] : ""}`
                    : "not installed",
                  detail: [
                    `\x1b[1m${tool.displayName}\x1b[0m`,
                    "",
                    `  Status:    ${installed ? "installed" : "not installed"}`,
                    `  Version:   ${installed ? version.split("\n")[0] : "-"}`,
                    `  Detect:    ${tool.detectCommand}`,
                    `  Install:   ${tool.installCommand ?? "(manual)"}`,
                    `  Configs:   ${tool.configFiles.join(", ")}`,
                    `  Found:     ${configs.length > 0 ? configs.join(", ") : "(none)"}`,
                    "",
                    `  ${tool.description}`,
                  ].join("\n"),
                }),
              );
              await interactiveTable({
                title: `vibe ai list — ${rows.length} tool(s)`,
                rows: tableRows,
                footer: "↑/↓ navigate · q to quit",
              });
            },
            json: (rows) =>
              redactSecrets(
                rows.map(({ tool, installed, version, configs }) => ({
                  name: tool.name,
                  displayName: tool.displayName,
                  description: tool.description,
                  installed,
                  version: installed ? version.split("\n")[0] : "",
                  detectCommand: tool.detectCommand,
                  installCommand: tool.installCommand ?? null,
                  configFiles: tool.configFiles,
                  foundConfigs: configs,
                })),
              ),
          });
        },
      );

    // ── vibe ai install <tool> ──────────────────────────────────────
    aiCmd
      .command("install")
      .description("Install an AI tool")
      .argument(
        "<tool>",
        `Tool name (${AI_TOOLS.map((t) => t.name).join(", ")})`,
      )
      .option("--json", "Emit JSON result")
      .action((toolName: string, options: { json?: boolean }) => {
        const tool = AI_TOOLS.find((t) => t.name === toolName);
        if (!tool) {
          if (
            maybePrintJson(options, {
              ok: false,
              action: "install",
              tool: toolName,
              error: `Unknown tool '${toolName}'`,
              available: AI_TOOLS.map((t) => t.name),
            })
          ) {
            process.exit(1);
          }
          console.error(
            `\x1b[31mError:\x1b[0m Unknown tool '${toolName}'. Available: ${AI_TOOLS.map((t) => t.name).join(", ")}`,
          );
          process.exit(1);
        }
        if (!tool.installCommand) {
          if (
            maybePrintJson(options, {
              ok: false,
              action: "install",
              tool: tool.name,
              error: `'${tool.displayName}' must be installed manually.`,
            })
          ) {
            process.exit(1);
          }
          console.error(
            `\x1b[31mError:\x1b[0m '${tool.displayName}' must be installed manually.`,
          );
          process.exit(1);
        }
        const { installed: alreadyInstalled, version } = isToolInstalled(tool);
        if (alreadyInstalled) {
          if (
            maybePrintJson(options, {
              ok: true,
              action: "install",
              tool: tool.name,
              alreadyInstalled: true,
              version: version.split("\n")[0],
            })
          ) {
            return;
          }
          console.log(
            `  \x1b[32m✓ ${tool.displayName} is already installed.\x1b[0m`,
          );
          return;
        }
        if (!options.json) {
          console.log(`  Installing ${tool.displayName}...`);
        }
        const success = runInstallCommand(tool.installCommand);
        if (success) {
          if (
            maybePrintJson(options, {
              ok: true,
              action: "install",
              tool: tool.name,
              alreadyInstalled: false,
              installCommand: tool.installCommand,
            })
          ) {
            return;
          }
          console.log(
            `\n  \x1b[32m✓ ${tool.displayName} installed successfully.\x1b[0m\n`,
          );
        } else {
          if (
            maybePrintJson(options, {
              ok: false,
              action: "install",
              tool: tool.name,
              error: `Failed to install ${tool.displayName}`,
              installCommand: tool.installCommand,
            })
          ) {
            process.exit(1);
          }
          console.error(
            `\n  \x1b[31m✗ Failed to install ${tool.displayName}.\x1b[0m`,
          );
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
      .option("--json", "Emit JSON result")
      .action(
        async (
          toolName: string,
          options: { cwd: string; json?: boolean },
        ) => {
          const tool = AI_TOOLS.find((t) => t.name === toolName);
          if (!tool) {
            if (
              maybePrintJson(options, {
                ok: false,
                action: "init",
                tool: toolName,
                error: `Unknown tool '${toolName}'`,
              })
            ) {
              process.exit(1);
            }
            console.error(`\x1b[31mError:\x1b[0m Unknown tool '${toolName}'.`);
            process.exit(1);
          }
          const dir = options.cwd;
          const primaryConfig = tool.configFiles[0];
          const configPath = join(dir, primaryConfig);
          try {
            if (Bun.file(configPath).size >= 0) {
              if (
                maybePrintJson(options, {
                  ok: true,
                  action: "init",
                  tool: tool.name,
                  alreadyExists: true,
                  configFile: primaryConfig,
                  directory: dir,
                })
              ) {
                return;
              }
              console.log(
                `  \x1b[33m⚠\x1b[0m  ${primaryConfig} already exists in ${dir}`,
              );
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
          if (
            maybePrintJson(options, {
              ok: true,
              action: "init",
              tool: tool.name,
              alreadyExists: false,
              configFile: primaryConfig,
              directory: dir,
            })
          ) {
            return;
          }
          console.log(
            `\n  \x1b[32m✓ Created ${primaryConfig}\x1b[0m in ${dir}\n`,
          );
        },
      );

    // ── vibe ai check ───────────────────────────────────────────────
    aiCmd
      .command("check")
      .description("Check which AI tools are installed")
      .option("--json", "Emit JSON")
      .option("--plain", "Force plain text output")
      .action(async (options: { json?: boolean; plain?: boolean }) => {
        interface CheckRow {
          tool: AiTool;
          installed: boolean;
          version: string;
        }
        await runMultimode<CheckRow[]>({
          mode: pickOutputMode(options),
          fetchData: () =>
            AI_TOOLS.map((tool) => {
              const { installed, version } = isToolInstalled(tool);
              return { tool, installed, version };
            }),
          plain: (rows) => {
            console.log("\n  \x1b[1m── AI Tool Check ──\x1b[0m\n");
            let allInstalled = true;
            for (const { tool, installed, version } of rows) {
              const icon = installed
                ? "\x1b[32m✓\x1b[0m"
                : "\x1b[31m✗\x1b[0m";
              console.log(
                `  ${icon} ${tool.displayName.padEnd(20)} ${installed ? version.split("\n")[0] : "not installed"}`,
              );
              if (!installed) allInstalled = false;
            }
            console.log();
            if (!allInstalled) {
              console.log(
                "  Install missing tools: \x1b[1mvibe ai install <tool>\x1b[0m\n",
              );
            }
          },
          interactive: async (rows) => {
            const tableRows: TableRow[] = rows.map(
              ({ tool, installed, version }) => ({
                id: tool.name,
                label: tool.displayName,
                hint: installed ? "ok" : "fail",
                detail: [
                  `\x1b[1m${tool.displayName}\x1b[0m`,
                  "",
                  `  Status:    ${installed ? "ok (installed)" : "fail (not installed)"}`,
                  `  Version:   ${installed ? version.split("\n")[0] : "-"}`,
                  `  Detect:    ${tool.detectCommand}`,
                  `  Install:   ${tool.installCommand ?? "(manual)"}`,
                  "",
                  installed
                    ? "  All good."
                    : `  Run: vibe ai install ${tool.name}`,
                ].join("\n"),
              }),
            );
            await interactiveTable({
              title: `vibe ai check — ${rows.filter((r) => r.installed).length}/${rows.length} installed`,
              rows: tableRows,
              footer: "↑/↓ navigate · q to quit",
            });
          },
          json: (rows) =>
            redactSecrets({
              ok: rows.every((r) => r.installed),
              checks: rows.map(({ tool, installed, version }) => ({
                name: tool.name,
                displayName: tool.displayName,
                installed,
                ok: installed,
                version: installed ? version.split("\n")[0] : null,
                message: installed ? "installed" : "not installed",
              })),
            }),
        });
      });

    // ── vibe ai prompts ─────────────────────────────────────────────
    const promptsCmd = aiCmd
      .command("prompts")
      .description("Manage prompt templates");

    promptsCmd
      .command("list")
      .description("List all prompt templates")
      .option("--shared", "Show only shared prompts")
      .option("--category <cat>", "Filter by category")
      .option("--limit <n>", "Max results", "20")
      .option("--json", "Emit JSON")
      .option("--plain", "Force plain text output")
      .action(
        async (options: {
          shared?: boolean;
          category?: string;
          limit: string;
          json?: boolean;
          plain?: boolean;
        }) => {
          await runMultimode<ReturnType<PromptDatabase["list"]>>({
            mode: pickOutputMode(options),
            fetchData: () => {
              const db = getPromptDb();
              return db.list(
                {
                  isShared:
                    options.shared !== undefined ? options.shared : undefined,
                  category: options.category as Parameters<
                    typeof db.list
                  >[0] extends { category?: infer C }
                    ? C
                    : undefined,
                },
                { limit: parseInt(options.limit, 10) },
              );
            },
            plain: (result) => {
              if (result.items.length === 0) {
                console.log("\n  No prompts found.\n");
                return;
              }
              console.log(
                `\n  \x1b[1m── Prompts (${result.total}) ──\x1b[0m\n`,
              );
              for (const prompt of result.items) {
                const shared = prompt.isShared
                  ? " \x1b[36m[shared]\x1b[0m"
                  : "";
                const tags =
                  prompt.tags.length > 0
                    ? ` \x1b[33m[${prompt.tags.join(", ")}]\x1b[0m`
                    : "";
                const uses =
                  prompt.usageCount > 0
                    ? ` \x1b[90m(${prompt.usageCount} uses)\x1b[0m`
                    : "";
                console.log(
                  `  \x1b[1m${prompt.name}\x1b[0m${shared}${tags}${uses}`,
                );
                const preview = prompt.content
                  .replace(/\n/g, " ")
                  .slice(0, 60)
                  .trim();
                console.log(
                  `    ${preview}${prompt.content.length > 60 ? "..." : ""}`,
                );
                console.log();
              }
            },
            interactive: async (result) => {
              if (result.items.length === 0) {
                console.log("\n  No prompts found.\n");
                return;
              }
              const tableRows: TableRow[] = result.items.map((prompt) => ({
                id: prompt.id,
                label: prompt.name,
                hint: [
                  prompt.isShared ? "shared" : null,
                  prompt.category ?? null,
                  prompt.usageCount > 0 ? `${prompt.usageCount} uses` : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
                detail: [
                  `\x1b[1m${prompt.name}\x1b[0m`,
                  "",
                  `  ID:        ${prompt.id}`,
                  `  Shared:    ${prompt.isShared ? "yes" : "no"}`,
                  `  Category:  ${prompt.category ?? "-"}`,
                  `  Tags:      ${prompt.tags.length > 0 ? prompt.tags.join(", ") : "-"}`,
                  `  Variables: ${prompt.variables.length > 0 ? prompt.variables.map((v) => `{{${v}}}`).join(", ") : "-"}`,
                  `  Uses:      ${prompt.usageCount}`,
                  "",
                  prompt.content,
                ].join("\n"),
              }));
              await interactiveTable({
                title: `vibe ai prompts list — ${result.total} prompt(s)`,
                rows: tableRows,
                footer: "↑/↓ navigate · q to quit",
              });
            },
            json: (result) => redactSecrets(result),
          });
        },
      );

    promptsCmd
      .command("search")
      .description("Search prompts")
      .argument("<query>", "Search query")
      .option("--limit <n>", "Max results", "10")
      .option("--json", "Emit JSON")
      .option("--plain", "Force plain text output")
      .action(
        async (
          query: string,
          options: { limit: string; json?: boolean; plain?: boolean },
        ) => {
          await runMultimode<ReturnType<PromptDatabase["search"]>>({
            mode: pickOutputMode(options),
            fetchData: () => {
              const db = getPromptDb();
              return db.search(query, undefined, parseInt(options.limit, 10));
            },
            plain: (results) => {
              if (results.length === 0) {
                console.log(`\n  No prompts matching "${query}".\n`);
                return;
              }
              console.log(
                `\n  \x1b[1m── Search: "${query}" (${results.length} results) ──\x1b[0m\n`,
              );
              for (const prompt of results) {
                console.log(
                  `  \x1b[1m${prompt.name}\x1b[0m \x1b[90m(${prompt.usageCount} uses)\x1b[0m`,
                );
                const preview = prompt.content
                  .replace(/\n/g, " ")
                  .slice(0, 60)
                  .trim();
                console.log(
                  `    ${preview}${prompt.content.length > 60 ? "..." : ""}`,
                );
                console.log();
              }
            },
            interactive: async (results) => {
              if (results.length === 0) {
                console.log(`\n  No prompts matching "${query}".\n`);
                return;
              }
              const tableRows: TableRow[] = results.map((prompt) => ({
                id: prompt.id,
                label: prompt.name,
                hint: `${prompt.usageCount} uses`,
                detail: [
                  `\x1b[1m${prompt.name}\x1b[0m`,
                  "",
                  `  ID:    ${prompt.id}`,
                  `  Uses:  ${prompt.usageCount}`,
                  `  Tags:  ${prompt.tags.length > 0 ? prompt.tags.join(", ") : "-"}`,
                  "",
                  prompt.content,
                ].join("\n"),
              }));
              await interactiveTable({
                title: `vibe ai prompts search "${query}" — ${results.length} match(es)`,
                rows: tableRows,
                footer: "↑/↓ navigate · q to quit",
              });
            },
            json: (results) => redactSecrets({ query, results }),
          });
        },
      );

    promptsCmd
      .command("show")
      .description("Show a prompt by ID")
      .argument("<id>", "Prompt ID")
      .option("--json", "Emit JSON")
      .option("--plain", "Force plain text output")
      .action(
        async (
          id: string,
          options: { json?: boolean; plain?: boolean },
        ) => {
          await runMultimode<ReturnType<PromptDatabase["getById"]>>({
            mode: pickOutputMode(options),
            fetchData: () => {
              const db = getPromptDb();
              const prompt = db.getById(id);
              if (!prompt) {
                console.error(`\x1b[31mError:\x1b[0m Prompt not found: ${id}`);
                process.exit(1);
              }
              return prompt;
            },
            plain: (prompt) => {
              if (!prompt) return;
              console.log(`\n  \x1b[1m${prompt.name}\x1b[0m`);
              if (prompt.tags.length > 0)
                console.log(`  Tags: ${prompt.tags.join(", ")}`);
              if (prompt.variables.length > 0)
                console.log(
                  `  Variables: ${prompt.variables.map((v) => `{{${v}}}`).join(", ")}`,
                );
              console.log(
                `  Shared: ${prompt.isShared ? "yes" : "no"} | Uses: ${prompt.usageCount}`,
              );
              console.log(`\n${prompt.content}\n`);
            },
            interactive: async (prompt) => {
              if (!prompt) return;
              await interactiveDetail({
                title: `vibe ai prompts show — ${prompt.name}`,
                body: [
                  `\x1b[1m${prompt.name}\x1b[0m`,
                  "",
                  `  ID:        ${prompt.id}`,
                  `  Shared:    ${prompt.isShared ? "yes" : "no"}`,
                  `  Tags:      ${prompt.tags.length > 0 ? prompt.tags.join(", ") : "-"}`,
                  `  Variables: ${prompt.variables.length > 0 ? prompt.variables.map((v) => `{{${v}}}`).join(", ") : "-"}`,
                  `  Uses:      ${prompt.usageCount}`,
                  "",
                  prompt.content,
                ].join("\n"),
              });
            },
            json: (prompt) => redactSecrets(prompt),
          });
        },
      );

    // ── vibe ai contexts ────────────────────────────────────────────
    const contextsCmd = aiCmd
      .command("contexts")
      .description("Manage reusable context pieces");

    contextsCmd
      .command("list")
      .description("List all contexts")
      .option("--type <type>", "Filter by type")
      .option("--limit <n>", "Max results", "20")
      .option("--json", "Emit JSON")
      .option("--plain", "Force plain text output")
      .action(
        async (options: {
          type?: string;
          limit: string;
          json?: boolean;
          plain?: boolean;
        }) => {
          await runMultimode<ReturnType<ContextDatabase["list"]>>({
            mode: pickOutputMode(options),
            fetchData: () => {
              const db = getContextDb();
              return db.list(
                options.type
                  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    { type: options.type as any }
                  : undefined,
                { limit: parseInt(options.limit, 10) },
              );
            },
            plain: (result) => {
              if (result.items.length === 0) {
                console.log("\n  No contexts found.\n");
                return;
              }
              console.log(
                `\n  \x1b[1m── Contexts (${result.total}) ──\x1b[0m\n`,
              );
              for (const ctx of result.items) {
                const tags =
                  ctx.tags.length > 0
                    ? ` \x1b[33m[${ctx.tags.join(", ")}]\x1b[0m`
                    : "";
                console.log(
                  `  \x1b[1m${ctx.name}\x1b[0m \x1b[90m(${ctx.type})\x1b[0m${tags}`,
                );
                const preview = ctx.content
                  .replace(/\n/g, " ")
                  .slice(0, 60)
                  .trim();
                console.log(
                  `    ${preview}${ctx.content.length > 60 ? "..." : ""}`,
                );
                console.log();
              }
            },
            interactive: async (result) => {
              if (result.items.length === 0) {
                console.log("\n  No contexts found.\n");
                return;
              }
              const tableRows: TableRow[] = result.items.map((ctx) => ({
                id: ctx.id,
                label: ctx.name,
                hint: ctx.type,
                detail: [
                  `\x1b[1m${ctx.name}\x1b[0m`,
                  "",
                  `  ID:    ${ctx.id}`,
                  `  Type:  ${ctx.type}`,
                  `  Tags:  ${ctx.tags.length > 0 ? ctx.tags.join(", ") : "-"}`,
                  "",
                  ctx.content,
                ].join("\n"),
              }));
              await interactiveTable({
                title: `vibe ai contexts list — ${result.total} context(s)`,
                rows: tableRows,
                footer: "↑/↓ navigate · q to quit",
              });
            },
            json: (result) => redactSecrets(result),
          });
        },
      );

    contextsCmd
      .command("show")
      .description("Show a context by ID")
      .argument("<id>", "Context ID")
      .option("--json", "Emit JSON")
      .option("--plain", "Force plain text output")
      .action(
        async (
          id: string,
          options: { json?: boolean; plain?: boolean },
        ) => {
          await runMultimode<ReturnType<ContextDatabase["getById"]>>({
            mode: pickOutputMode(options),
            fetchData: () => {
              const db = getContextDb();
              const ctx = db.getById(id);
              if (!ctx) {
                console.error(`\x1b[31mError:\x1b[0m Context not found: ${id}`);
                process.exit(1);
              }
              return ctx;
            },
            plain: (ctx) => {
              if (!ctx) return;
              console.log(
                `\n  \x1b[1m${ctx.name}\x1b[0m \x1b[90m(${ctx.type})\x1b[0m`,
              );
              if (ctx.tags.length > 0)
                console.log(`  Tags: ${ctx.tags.join(", ")}`);
              console.log(`\n${ctx.content}\n`);
            },
            interactive: async (ctx) => {
              if (!ctx) return;
              await interactiveDetail({
                title: `vibe ai contexts show — ${ctx.name}`,
                body: [
                  `\x1b[1m${ctx.name}\x1b[0m \x1b[90m(${ctx.type})\x1b[0m`,
                  "",
                  `  ID:    ${ctx.id}`,
                  `  Type:  ${ctx.type}`,
                  `  Tags:  ${ctx.tags.length > 0 ? ctx.tags.join(", ") : "-"}`,
                  "",
                  ctx.content,
                ].join("\n"),
              });
            },
            json: (ctx) => redactSecrets(ctx),
          });
        },
      );

    // ── vibe ai sessions ────────────────────────────────────────────
    const sessionsCmd = aiCmd
      .command("sessions")
      .description("Manage AI sessions");

    sessionsCmd
      .command("list")
      .description("List AI sessions")
      .option("--status <status>", "Filter by status")
      .option("--json", "Emit JSON")
      .option("--plain", "Force plain text output")
      .action(
        async (options: {
          status?: string;
          json?: boolean;
          plain?: boolean;
        }) => {
          await runMultimode<ReturnType<SessionDatabase["list"]>>({
            mode: pickOutputMode(options),
            fetchData: () => {
              const db = getSessionDb();
              return db.list(
                options.status
                  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    { status: options.status as any }
                  : undefined,
              );
            },
            plain: (result) => {
              if (result.items.length === 0) {
                console.log("\n  No sessions found.\n");
                return;
              }
              console.log(
                `\n  \x1b[1m── AI Sessions (${result.total}) ──\x1b[0m\n`,
              );
              for (const session of result.items) {
                const statusColor =
                  session.status === "active"
                    ? "\x1b[32m"
                    : session.status === "error"
                      ? "\x1b[31m"
                      : "\x1b[33m";
                console.log(
                  `  \x1b[1m${session.name}\x1b[0m ${statusColor}[${session.status}]\x1b[0m \x1b[90m(${session.agentType})\x1b[0m`,
                );
                console.log(
                  `    ID: ${session.id} | Created: ${session.createdAt}`,
                );
                console.log();
              }
            },
            interactive: async (result) => {
              if (result.items.length === 0) {
                console.log("\n  No sessions found.\n");
                return;
              }
              const tableRows: TableRow[] = result.items.map((session) => ({
                id: session.id,
                label: session.name,
                hint: `${session.status} · ${session.agentType}`,
                detail: [
                  `\x1b[1m${session.name}\x1b[0m`,
                  "",
                  `  ID:        ${session.id}`,
                  `  Status:    ${session.status}`,
                  `  Agent:     ${session.agentType}`,
                  `  Created:   ${session.createdAt}`,
                ].join("\n"),
              }));
              await interactiveTable({
                title: `vibe ai sessions list — ${result.total} session(s)`,
                rows: tableRows,
                footer: "↑/↓ navigate · q to quit",
              });
            },
            json: (result) => redactSecrets(result),
          });
        },
      );

    // ── vibe ai stats ───────────────────────────────────────────────
    aiCmd
      .command("stats")
      .description("Show AI usage statistics")
      .option("--json", "Emit JSON")
      .option("--plain", "Force plain text output")
      .action(async (options: { json?: boolean; plain?: boolean }) => {
        interface StatsShape {
          total: number;
          active: number;
          totalInputTokens: number;
          totalOutputTokens: number;
        }
        await runMultimode<StatsShape>({
          mode: pickOutputMode(options),
          fetchData: () => {
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
            return {
              total: sessions.total,
              active: sessions.items.filter(
                (s) => s.status !== "terminated",
              ).length,
              totalInputTokens: totalInput,
              totalOutputTokens: totalOutput,
            };
          },
          plain: (stats) => {
            console.log("\n  \x1b[1m── AI Usage Stats ──\x1b[0m\n");
            console.log(`  Sessions:      ${stats.total}`);
            console.log(`  Active:        ${stats.active}`);
            console.log(
              `  Input tokens:  ${stats.totalInputTokens.toLocaleString()}`,
            );
            console.log(
              `  Output tokens: ${stats.totalOutputTokens.toLocaleString()}`,
            );
            console.log();
          },
          interactive: async (stats) => {
            await interactiveDetail({
              title: "vibe ai stats — AI Usage Statistics",
              body: [
                "\x1b[1mAI Usage Stats\x1b[0m",
                "",
                `  Sessions:      ${stats.total}`,
                `  Active:        ${stats.active}`,
                `  Input tokens:  ${stats.totalInputTokens.toLocaleString()}`,
                `  Output tokens: ${stats.totalOutputTokens.toLocaleString()}`,
              ].join("\n"),
            });
          },
          json: (stats) => redactSecrets(stats),
        });
      });

    // ── vibe ai run <harness> [-s session] [-- ...harnessArgs] ──────
    // Spawn an interactive AI harness binary inside a managed terminal
    // session. With `-s <name>` the session is reused (attach if running
    // the same harness, hard error on harness mismatch). Without `-s`
    // an anonymous `vibe-ai-<harness>-<short>` session is created.
    aiCmd
      .command("run <harness> [harnessArgs...]")
      .description(
        "Run an AI harness inside a session manager (creates or attaches)",
      )
      .option(
        "-s, --session <name>",
        "Session name (attach if exists, create if not)",
      )
      .option(
        "--list-harnesses",
        "List harnesses that support `vibe ai run`",
      )
      .option("--json", "Emit JSON envelope on errors / list")
      .allowUnknownOption(true)
      .passThroughOptions()
      .action(
        async (
          harness: string,
          harnessArgs: string[],
          opts: {
            session?: string;
            listHarnesses?: boolean;
            json?: boolean;
          },
        ) => {
          await runAiRunCommand(harness, harnessArgs ?? [], opts);
        },
      );

    // ── vibe ai sdk <provider> [-- ...sdkArgs] ──────────────────────
    // One-shot non-interactive SDK call. `--prompt`, `--model`,
    // `--max-tokens` are parsed; everything else is forwarded as
    // `extras` to the provider.
    aiCmd
      .command("sdk <provider> [sdkArgs...]")
      .description("One-shot SDK prompt against an AI provider")
      .option("--json", "Emit JSON envelope")
      .allowUnknownOption(true)
      .passThroughOptions()
      .action(
        async (
          providerName: string,
          sdkArgs: string[],
          opts: { json?: boolean },
        ) => {
          await runAiSdkCommand(providerName, sdkArgs ?? [], opts);
        },
      );
  },
};

// ── vibe ai run / vibe ai sdk implementation ─────────────────────────────

interface CliLaunchSpec {
  binary: string;
  baseArgs?: string[];
  env?: Record<string, string>;
}

interface SdkOneShotResult {
  text: string;
  usage?: unknown;
}

interface AIProviderRunCapable {
  readonly name: string;
  getDisplayName?: () => string;
  getCliLaunchSpec?: () => CliLaunchSpec | null;
  sdkOneShot?: (opts: {
    prompt: string;
    model?: string;
    maxTokens?: number;
    extras?: Record<string, unknown>;
  }) => Promise<SdkOneShotResult>;
}

interface SessionProviderLike {
  readonly name: string;
  list: () => Promise<
    Array<{
      id: string;
      name: string;
      status: string;
      metadata?: Record<string, unknown>;
    }>
  >;
  get?: (sessionId: string) => Promise<{
    id: string;
    name: string;
    status: string;
    metadata?: Record<string, unknown>;
  } | null>;
  create: (config: {
    name: string;
    command?: string;
    environment?: Record<string, string>;
    workingDirectory?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<{ id: string; name: string }>;
  sendCommand?: (sessionId: string, command: string) => Promise<void>;
}

function shortUuid(): string {
  return crypto.randomUUID().split("-")[0] ?? "anon";
}

function defaultSessionNameFor(harness: string): string {
  return `vibe-ai-${harness}-${shortUuid()}`;
}

function formatRunCommand(spec: CliLaunchSpec, extraArgs: string[]): string {
  const parts = [spec.binary, ...(spec.baseArgs ?? []), ...extraArgs];
  return parts
    .map((p) =>
      /[\s"']/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p,
    )
    .join(" ");
}

// Test surface: directly exercise the run/sdk core without going through the
// global hostServicesRef. The CLI shim (registered via onCliSetup) calls
// `runAiRunCommand` / `runAiSdkCommand` which simply delegate here with the
// hostServices closure already bound.
export interface AiRunDeps {
  getAiProvider: (name: string) => AIProviderRunCapable | undefined;
  listAiProviders: () => Array<{ pluginName: string }>;
  getSessionProvider: () => SessionProviderLike | undefined;
  log?: (line: string) => void;
  err?: (line: string) => void;
  exit?: (code: number) => void;
}

export async function runAiRunCore(
  harness: string,
  harnessArgs: string[],
  opts: { session?: string; listHarnesses?: boolean; json?: boolean },
  deps: AiRunDeps,
): Promise<{ ok: boolean; action?: "create" | "attach"; error?: string }> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const err = deps.err ?? ((s: string) => console.error(s));
  const exit = deps.exit ?? ((c: number) => process.exit(c));

  if (opts.listHarnesses) {
    const rows = deps
      .listAiProviders()
      .map((entry) => {
        const provider = deps.getAiProvider(entry.pluginName);
        if (!provider) return null;
        const spec = provider.getCliLaunchSpec?.() ?? null;
        if (!spec) return null;
        return {
          name: provider.name ?? entry.pluginName,
          displayName: provider.getDisplayName?.() ?? entry.pluginName,
          binary: spec.binary,
        };
      })
      .filter(
        (r): r is { name: string; displayName: string; binary: string } =>
          r !== null,
      );
    if (opts.json) {
      log(JSON.stringify({ ok: true, harnesses: rows }, null, 2));
    } else if (rows.length === 0) {
      log("\n  No AI harnesses available for `vibe ai run`.\n");
    } else {
      log("\n  \x1b[1m── AI Harnesses ──\x1b[0m\n");
      for (const row of rows) {
        log(
          `  \x1b[1m${row.name.padEnd(16)}\x1b[0m ${row.displayName.padEnd(22)} \x1b[90m(${row.binary})\x1b[0m`,
        );
      }
      log("");
    }
    return { ok: true };
  }

  const aiProvider = deps.getAiProvider(harness);
  if (!aiProvider) {
    const message = `unknown harness '${harness}'`;
    if (opts.json) err(JSON.stringify({ ok: false, error: message }, null, 2));
    else err(`\x1b[31mError:\x1b[0m ${message}`);
    exit(1);
    return { ok: false, error: message };
  }
  const spec = aiProvider.getCliLaunchSpec?.() ?? null;
  if (!spec) {
    const message = `provider '${harness}' has no CLI mode (sdkOneShot only). Use 'vibe ai sdk ${harness}' instead.`;
    if (opts.json) err(JSON.stringify({ ok: false, error: message }, null, 2));
    else err(`\x1b[31mError:\x1b[0m ${message}`);
    exit(1);
    return { ok: false, error: message };
  }

  const sessionProvider = deps.getSessionProvider();
  if (!sessionProvider) {
    const message =
      "no session provider registered (install vibe-plugin-session-tmux or similar)";
    if (opts.json) err(JSON.stringify({ ok: false, error: message }, null, 2));
    else err(`\x1b[31mError:\x1b[0m ${message}`);
    exit(1);
    return { ok: false, error: message };
  }

  const sessionName = opts.session ?? defaultSessionNameFor(harness);
  const launchArgs = [...(spec.baseArgs ?? []), ...harnessArgs];
  const launchCmd = formatRunCommand(spec, harnessArgs);
  const env: Record<string, string> = { ...(spec.env ?? {}) };

  // Look up existing session if explicit name given.
  let existing: Awaited<ReturnType<SessionProviderLike["list"]>>[number] | null =
    null;
  if (opts.session) {
    const all = await sessionProvider.list();
    existing = all.find((s) => s.name === sessionName) ?? null;
  }

  if (existing) {
    const recordedHarness =
      typeof existing.metadata?.["harness"] === "string"
        ? (existing.metadata["harness"] as string)
        : null;
    if (recordedHarness && recordedHarness !== harness) {
      const message = `session ${sessionName} is currently running ${recordedHarness}; kill it first with 'vibe session kill ${sessionName}' or pick a different -s name`;
      if (opts.json)
        err(JSON.stringify({ ok: false, error: message }, null, 2));
      else err(`\x1b[31mError:\x1b[0m ${message}`);
      exit(2);
      return { ok: false, error: message };
    }
    if (opts.json) {
      log(
        JSON.stringify(
          {
            ok: true,
            action: "attach",
            session: { id: existing.id, name: existing.name },
            harness,
            command: launchCmd,
          },
          null,
          2,
        ),
      );
    } else {
      log(
        `\n  \x1b[32mAttached\x1b[0m to session \x1b[1m${existing.name}\x1b[0m (${harness}).\n  Use 'vibe session attach ${existing.name}' to reach the terminal.\n`,
      );
    }
    return { ok: true, action: "attach" };
  }

  // Create + spawn.
  const created = await sessionProvider.create({
    name: sessionName,
    command: spec.binary,
    environment: env,
    metadata: {
      harness,
      ai: true,
      cliArgs: launchArgs,
    },
  });

  // Send the launch line so harness picks up the args we collected.
  if (sessionProvider.sendCommand && launchArgs.length > 0) {
    try {
      await sessionProvider.sendCommand(created.id, launchCmd);
    } catch {
      // Non-fatal — harness already running with `command: spec.binary`.
    }
  }

  if (opts.json) {
    log(
      JSON.stringify(
        {
          ok: true,
          action: "create",
          session: { id: created.id, name: created.name },
          harness,
          command: launchCmd,
        },
        null,
        2,
      ),
    );
  } else {
    log(
      `\n  \x1b[32mStarted\x1b[0m \x1b[1m${harness}\x1b[0m in session \x1b[1m${created.name}\x1b[0m.\n  Command: ${launchCmd}\n  Use 'vibe session attach ${created.name}' to reach the terminal.\n`,
    );
  }
  return { ok: true, action: "create" };
}

async function runAiRunCommand(
  harness: string,
  harnessArgs: string[],
  opts: { session?: string; listHarnesses?: boolean; json?: boolean },
): Promise<void> {
  const registry = hostServicesRef?.serviceRegistry;
  await runAiRunCore(harness, harnessArgs, opts, {
    getAiProvider: (name) =>
      registry?.getProviderByName<AIProviderRunCapable>("ai", name),
    listAiProviders: () => registry?.listProvidersForType("ai") ?? [],
    getSessionProvider: () => pickFirstSessionProvider(),
  });
}

function pickFirstSessionProvider(): SessionProviderLike | undefined {
  const registry = hostServicesRef?.serviceRegistry;
  if (!registry) return undefined;
  for (const entry of registry.listProvidersForType("session")) {
    const provider = registry.getProviderByName<SessionProviderLike>(
      "session",
      entry.pluginName,
    );
    if (provider) return provider;
  }
  return undefined;
}

interface ParsedSdkArgs {
  prompt: string | null;
  model?: string;
  maxTokens?: number;
  extras: Record<string, unknown>;
}

function parseSdkArgs(rawArgs: string[]): ParsedSdkArgs {
  const out: ParsedSdkArgs = { prompt: null, extras: {} };
  for (let i = 0; i < rawArgs.length; i++) {
    const tok = rawArgs[i];
    if (tok === undefined) continue;
    if (tok === "--prompt" || tok === "-p") {
      out.prompt = rawArgs[++i] ?? "";
      continue;
    }
    if (tok === "--model" || tok === "-m") {
      out.model = rawArgs[++i] ?? undefined;
      continue;
    }
    if (tok === "--max-tokens") {
      const v = rawArgs[++i];
      const n = v === undefined ? NaN : Number.parseInt(v, 10);
      if (!Number.isNaN(n)) out.maxTokens = n;
      continue;
    }
    if (tok.startsWith("--")) {
      const key = tok.replace(/^--/, "");
      const next = rawArgs[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.extras[key] = next;
        i++;
      } else {
        out.extras[key] = true;
      }
      continue;
    }
    // Positional after the parsed flags becomes the prompt if not already set
    if (out.prompt === null) {
      out.prompt = tok;
    } else {
      const arr = (out.extras["_"] as unknown[] | undefined) ?? [];
      arr.push(tok);
      out.extras["_"] = arr;
    }
  }
  return out;
}

export interface AiSdkDeps {
  getAiProvider: (name: string) => AIProviderRunCapable | undefined;
  log?: (line: string) => void;
  err?: (line: string) => void;
  exit?: (code: number) => void;
  write?: (chunk: string) => void;
}

export async function runAiSdkCore(
  providerName: string,
  rawArgs: string[],
  opts: { json?: boolean },
  deps: AiSdkDeps,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const err = deps.err ?? ((s: string) => console.error(s));
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const write = deps.write ?? ((s: string) => process.stdout.write(s));

  const provider = deps.getAiProvider(providerName);
  if (!provider) {
    const message = `unknown provider '${providerName}'`;
    if (opts.json) err(JSON.stringify({ ok: false, error: message }, null, 2));
    else err(`\x1b[31mError:\x1b[0m ${message}`);
    exit(1);
    return { ok: false, error: message };
  }
  if (typeof provider.sdkOneShot !== "function") {
    const message = `provider '${providerName}' does not implement sdkOneShot()`;
    if (opts.json) err(JSON.stringify({ ok: false, error: message }, null, 2));
    else err(`\x1b[31mError:\x1b[0m ${message}`);
    exit(1);
    return { ok: false, error: message };
  }

  const parsed = parseSdkArgs(rawArgs);
  if (parsed.prompt === null || parsed.prompt === "") {
    const message =
      "missing --prompt <text> (pass after `--`, e.g. `vibe ai sdk claude -- --prompt 'hello'`)";
    if (opts.json) err(JSON.stringify({ ok: false, error: message }, null, 2));
    else err(`\x1b[31mError:\x1b[0m ${message}`);
    exit(1);
    return { ok: false, error: message };
  }

  try {
    const result = await provider.sdkOneShot({
      prompt: parsed.prompt,
      model: parsed.model,
      maxTokens: parsed.maxTokens,
      extras: parsed.extras,
    });
    if (opts.json) {
      log(
        JSON.stringify(
          {
            ok: true,
            provider: providerName,
            model: parsed.model ?? null,
            text: result.text,
            usage: result.usage ?? null,
          },
          null,
          2,
        ),
      );
    } else {
      write(result.text);
      if (!result.text.endsWith("\n")) write("\n");
    }
    return { ok: true, text: result.text };
  } catch (caught) {
    const msg = caught instanceof Error ? caught.message : String(caught);
    if (opts.json) err(JSON.stringify({ ok: false, error: msg }, null, 2));
    else err(`\x1b[31mError:\x1b[0m ${msg}`);
    exit(1);
    return { ok: false, error: msg };
  }
}

async function runAiSdkCommand(
  providerName: string,
  rawArgs: string[],
  opts: { json?: boolean },
): Promise<void> {
  const registry = hostServicesRef?.serviceRegistry;
  await runAiSdkCore(providerName, rawArgs, opts, {
    getAiProvider: (name) =>
      registry?.getProviderByName<AIProviderRunCapable>("ai", name),
  });
}

function registerStatusContributors(hostServices?: HostServices): void {
  const reg = hostServices?.cliContributors;
  if (!reg) return; // older agent without contributor registry — graceful no-op

  reg.addStatusSection({
    source: "ai",
    title: "AI",
    render: async ({ agentUrl }) => {
      try {
        const res = await fetch(`${agentUrl}/api/ai/sessions`);
        if (!res.ok) return null;
        const data = (await res.json()) as unknown;
        const list = Array.isArray(data)
          ? data
          : Array.isArray((data as { sessions?: unknown[] })?.sessions)
            ? ((data as { sessions: unknown[] }).sessions as unknown[])
            : [];
        if (list.length === 0) return "\x1b[2m(none)\x1b[22m";
        const providers = new Set<string>();
        for (const item of list) {
          const p = (item as { provider?: string; agentType?: string })
            ?.provider ??
            (item as { agentType?: string })?.agentType;
          if (p) providers.add(p);
        }
        const providerList =
          providers.size > 0 ? ` (${[...providers].join(", ")})` : "";
        return `\x1b[32m${list.length} active\x1b[39m${providerList}`;
      } catch {
        return null;
      }
    },
    json: async ({ agentUrl }) => {
      try {
        const res = await fetch(`${agentUrl}/api/ai/sessions`);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
    jsonKey: "ai",
  });

  reg.addDoctorCheck({
    source: "ai",
    run: async () => {
      try {
        const port = (process.env.AGENT_URL ?? "http://localhost:3005").replace(
          /\/+$/,
          "",
        );
        const res = await fetch(`${port}/api/ai/providers`);
        if (!res.ok) {
          return [
            {
              name: "AI providers",
              ok: false,
              grade: "warn" as const,
              message: `/api/ai/providers returned ${res.status}`,
            },
          ];
        }
        const body = (await res.json()) as unknown;
        const list = Array.isArray(body)
          ? body
          : Array.isArray((body as { providers?: unknown[] })?.providers)
            ? ((body as { providers: unknown[] }).providers as unknown[])
            : [];
        if (list.length === 0) {
          return [
            {
              name: "AI providers",
              ok: false,
              grade: "warn" as const,
              message: "no AI providers configured",
              hint: "Install one, e.g. `vibe plugin install @vibecontrols/vibe-plugin-ai-claude`.",
            },
          ];
        }
        return [
          {
            name: "AI providers",
            ok: true,
            message: `${list.length} provider(s) configured`,
          },
        ];
      } catch {
        return [];
      }
    },
  });
}

export default vibePlugin;
