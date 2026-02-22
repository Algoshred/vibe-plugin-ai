import type { Command } from "commander";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Elysia } from "elysia";
import { PromptDatabase } from "./db/prompts.js";
import { createPromptRoutes } from "./routes/prompts.js";

/**
 * @burdenoff/vibe-plugin-ai v3.0.0
 *
 * AI tool management + prompt templates plugin for VibeControls Agent (Bun runtime).
 *
 * Features:
 *   - `vibe ai` CLI commands for managing AI coding tools
 *   - REST API for prompt template CRUD (SQLite-backed)
 *   - Prompt variable extraction and rendering
 *
 * Supported tools:
 *   - claude-code (Anthropic Claude Code)
 *   - opencode
 *   - codex (OpenAI Codex CLI)
 *   - copilot (GitHub Copilot)
 *   - cursor-agent
 *
 * Install: vibe plugin install @burdenoff/vibe-plugin-ai
 */

// ── Plugin Interfaces ────────────────────────────────────────────────────────

export interface HostServices {
  logger?: {
    info: (source: string, msg: string) => void;
    warn: (source: string, msg: string) => void;
    error: (source: string, msg: string) => void;
    debug: (source: string, msg: string) => void;
  };
  config?: Record<string, unknown>;
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
  onServerStop?: () => void;
}

// ── Re-exports ───────────────────────────────────────────────────────────────

export type {
  Prompt,
  PromptCategory,
  CreatePromptInput,
  UpdatePromptInput,
  PromptFilter,
} from "./db/prompts.js";

// ── Tool Definitions ─────────────────────────────────────────────────────────

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

// ── Helper Functions ─────────────────────────────────────────────────────────

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
      const version = proc.stdout.toString().trim();
      return { installed: true, version };
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

// ── Prompt Database (singleton) ──────────────────────────────────────────────

let promptDb: PromptDatabase | null = null;

function getPromptDb(): PromptDatabase {
  if (!promptDb) {
    promptDb = new PromptDatabase();
  }
  return promptDb;
}

// ── Plugin Export ────────────────────────────────────────────────────────────

export const vibePlugin: VibePlugin = {
  name: "ai",
  version: "3.0.0",
  description: "AI tool management, prompt templates, and integration",
  tags: ["backend", "cli", "integration"],
  cliCommand: "ai",
  apiPrefix: "/api/ai",

  createRoutes() {
    const db = getPromptDb();

    return (
      new Elysia()
        // ── Tool detection endpoint ─────────────────────────────────────
        .get("/tools", () => {
          return {
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
          };
        })
        // ── Prompt CRUD routes ──────────────────────────────────────────
        .use(createPromptRoutes(db))
    );
  },

  onServerStart(_app, hostServices) {
    // Ensure prompt DB is initialized when server starts
    getPromptDb();
    hostServices?.logger?.info(
      "ai-plugin",
      "AI plugin started — prompt database initialized",
    );
  },

  onServerStop() {
    if (promptDb) {
      promptDb.close();
      promptDb = null;
    }
  },

  onCliSetup(program: Command, _hostServices?: HostServices) {
    const aiCmd = program
      .command("ai")
      .description("Manage AI coding tools and prompt templates");

    // ── vibe ai list ────────────────────────────────────────────────
    aiCmd
      .command("list")
      .description("List all supported AI tools and their status")
      .option(
        "--cwd <dir>",
        "Project directory to check configs",
        process.cwd(),
      )
      .action((options: { cwd: string }) => {
        console.log("\n  \x1b[1m── AI Tools ──\x1b[0m\n");

        for (const tool of AI_TOOLS) {
          const { installed, version } = isToolInstalled(tool);
          const icon = installed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
          const versionStr = installed ? ` (${version.split("\n")[0]})` : "";

          console.log(
            `  ${icon} \x1b[1m${tool.displayName}\x1b[0m${versionStr}`,
          );
          console.log(`    ${tool.description}`);

          const configs = findConfigFiles(tool, options.cwd);
          if (configs.length > 0) {
            console.log(`    Config: ${configs.join(", ")}`);
          } else {
            console.log(`    Config: (none found)`);
          }
          console.log();
        }
      });

    // ── vibe ai install <tool> ──────────────────────────────────────
    aiCmd
      .command("install")
      .description("Install an AI tool")
      .argument(
        "<tool>",
        `Tool name (${AI_TOOLS.map((t) => t.name).join(", ")})`,
      )
      .action((toolName: string) => {
        const tool = AI_TOOLS.find((t) => t.name === toolName);
        if (!tool) {
          console.error(
            `\x1b[31mError:\x1b[0m Unknown tool '${toolName}'. Available: ${AI_TOOLS.map((t) => t.name).join(", ")}`,
          );
          process.exit(1);
        }

        if (!tool.installCommand) {
          console.error(
            `\x1b[31mError:\x1b[0m '${tool.displayName}' must be installed manually.`,
          );
          process.exit(1);
        }

        const { installed } = isToolInstalled(tool);
        if (installed) {
          console.log(
            `  \x1b[32m✓ ${tool.displayName} is already installed.\x1b[0m`,
          );
          return;
        }

        console.log(`  Installing ${tool.displayName}...`);
        const success = runInstallCommand(tool.installCommand);

        if (success) {
          console.log(
            `\n  \x1b[32m✓ ${tool.displayName} installed successfully.\x1b[0m\n`,
          );
        } else {
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
      .action(async (toolName: string, options: { cwd: string }) => {
        const tool = AI_TOOLS.find((t) => t.name === toolName);
        if (!tool) {
          console.error(
            `\x1b[31mError:\x1b[0m Unknown tool '${toolName}'. Available: ${AI_TOOLS.map((t) => t.name).join(", ")}`,
          );
          process.exit(1);
        }

        const dir = options.cwd;
        const primaryConfig = tool.configFiles[0];
        const configPath = join(dir, primaryConfig);

        try {
          if (Bun.file(configPath).size >= 0) {
            console.log(
              `  \x1b[33m⚠\x1b[0m  ${primaryConfig} already exists in ${dir}`,
            );
            return;
          }
        } catch {
          // File doesn't exist — proceed to create it.
        }

        // Create parent directory if needed (e.g. .claude/)
        const segments = primaryConfig.split("/");
        if (segments.length > 1) {
          const parentDir = join(dir, ...segments.slice(0, -1));
          mkdirSync(parentDir, { recursive: true });
        }

        const content = generateStarterConfig(tool);
        await Bun.write(configPath, content);
        console.log(
          `\n  \x1b[32m✓ Created ${primaryConfig}\x1b[0m in ${dir}\n`,
        );
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
      .action(
        (options: { shared?: boolean; category?: string; limit: string }) => {
          const db = getPromptDb();
          const result = db.list(
            {
              isShared:
                options.shared !== undefined ? options.shared : undefined,
              category: options.category as
                | "GENERAL"
                | "CODING"
                | "DEBUGGING"
                | "REVIEW"
                | "DOCUMENTATION"
                | "TESTING"
                | "DEPLOYMENT"
                | "CUSTOM"
                | undefined,
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
      );

    promptsCmd
      .command("search")
      .description("Search prompts by name or content")
      .argument("<query>", "Search query")
      .option("--limit <n>", "Max results", "10")
      .action((query: string, options: { limit: string }) => {
        const db = getPromptDb();
        const results = db.search(
          query,
          undefined,
          parseInt(options.limit, 10),
        );

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
        if (prompt.tags.length > 0) {
          console.log(`  Tags: ${prompt.tags.join(", ")}`);
        }
        if (prompt.variables.length > 0) {
          console.log(
            `  Variables: ${prompt.variables.map((v) => `{{${v}}}`).join(", ")}`,
          );
        }
        console.log(
          `  Shared: ${prompt.isShared ? "yes" : "no"} | Uses: ${prompt.usageCount}`,
        );
        console.log(`\n${prompt.content}\n`);
      });
  },
};

// ── Config Templates ─────────────────────────────────────────────────────────

function generateStarterConfig(tool: AiTool): string {
  switch (tool.name) {
    case "claude-code":
      return `# CLAUDE.md

This file provides guidance to Claude Code when working with this project.

## Project Overview

<!-- Describe your project here -->

## Build & Development Commands

\`\`\`bash
# Add your development commands
bun run dev
bun run build
bun run test
\`\`\`

## Code Style & Conventions

- TypeScript strict mode
- Prettier + ESLint for formatting

## Architecture Notes

<!-- Describe key architecture decisions -->
`;

    case "codex":
      return `# AGENTS.md

Instructions for AI agents working on this project.

## Project Overview

<!-- Describe your project here -->

## Key Files

<!-- List important files and their purpose -->

## Development Workflow

\`\`\`bash
bun run dev
bun run build
bun run test
\`\`\`
`;

    case "copilot":
      return `# Copilot Instructions

## Project Context

<!-- Describe your project for GitHub Copilot -->

## Coding Standards

- Use TypeScript strict mode
- Follow existing patterns in the codebase
- Write tests for new functionality

## Common Patterns

<!-- Describe common patterns in your codebase -->
`;

    case "cursor-agent":
      return `# Cursor Rules

## Project Overview

<!-- Describe your project here -->

## Coding Standards

- TypeScript strict mode
- Use functional patterns where appropriate
- Keep functions small and focused

## File Structure

<!-- Describe your file organization -->
`;

    default:
      return `# ${tool.displayName} Configuration\n\n<!-- Add your configuration here -->\n`;
  }
}

export default vibePlugin;
