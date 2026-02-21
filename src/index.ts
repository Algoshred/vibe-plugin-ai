import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

/**
 * @burdenoff/vibe-plugin-ai
 *
 * AI tool management plugin for VibeControls Agent.
 * Adds the `vibe ai` command group for managing AI coding tools
 * and their configurations.
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
    detectCommand: "claude --version",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    configFiles: ["CLAUDE.md", ".claude/settings.json"],
    description: "Anthropic's AI coding agent",
  },
  {
    name: "opencode",
    displayName: "OpenCode",
    detectCommand: "opencode --version",
    installCommand: "npm install -g opencode",
    configFiles: ["OPENCODE.md", ".opencode/config.json"],
    description: "Open-source AI coding assistant",
  },
  {
    name: "codex",
    displayName: "OpenAI Codex CLI",
    detectCommand: "codex --version",
    installCommand: "npm install -g @openai/codex",
    configFiles: ["AGENTS.md", "codex.json"],
    description: "OpenAI's Codex CLI agent",
  },
  {
    name: "copilot",
    displayName: "GitHub Copilot",
    detectCommand: "gh copilot --version",
    configFiles: [".github/copilot-instructions.md"],
    description: "GitHub Copilot in the CLI",
  },
  {
    name: "cursor-agent",
    displayName: "Cursor Agent",
    detectCommand: "cursor --version",
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
    const version = execSync(tool.detectCommand, {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { installed: true, version };
  } catch {
    return { installed: false, version: "" };
  }
}

function findConfigFiles(tool: AiTool, directory: string): string[] {
  return tool.configFiles.filter((f) => existsSync(join(directory, f)));
}

// ── Plugin Export ────────────────────────────────────────────────────────────

export interface VibePlugin {
  name: string;
  version: string;
  description?: string;
  cliCommand?: string;
  apiPrefix?: string;
  onCliSetup?: (program: Command) => void | Promise<void>;
}

export const vibePlugin: VibePlugin = {
  name: "ai",
  version: "1.0.0",
  description: "AI tool management for VibeControls Agent",
  cliCommand: "ai",

  onCliSetup(program: Command) {
    const aiCmd = program
      .command("ai")
      .description("Manage AI coding tools and configurations");

    // ── vibe ai list ────────────────────────────────────────────────
    aiCmd
      .command("list")
      .description("List all supported AI tools and their status")
      .option(
        "--cwd <dir>",
        "Project directory to check configs",
        process.cwd(),
      )
      .action((options) => {
        console.log("\n  \x1b[1m── AI Tools ──\x1b[0m\n");

        for (const tool of AI_TOOLS) {
          const { installed, version } = isToolInstalled(tool);
          const icon = installed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
          const versionStr = installed ? ` (${version.split("\n")[0]})` : "";

          console.log(
            `  ${icon} \x1b[1m${tool.displayName}\x1b[0m${versionStr}`,
          );
          console.log(`    ${tool.description}`);

          // Check for config files
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
        try {
          execSync(tool.installCommand, { stdio: "inherit", timeout: 120000 });
          console.log(
            `\n  \x1b[32m✓ ${tool.displayName} installed successfully.\x1b[0m\n`,
          );
        } catch {
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
      .action((toolName: string, options) => {
        const tool = AI_TOOLS.find((t) => t.name === toolName);
        if (!tool) {
          console.error(
            `\x1b[31mError:\x1b[0m Unknown tool '${toolName}'. Available: ${AI_TOOLS.map((t) => t.name).join(", ")}`,
          );
          process.exit(1);
        }

        const dir = options.cwd as string;
        const primaryConfig = tool.configFiles[0];
        const configPath = join(dir, primaryConfig);

        if (existsSync(configPath)) {
          console.log(
            `  \x1b[33m⚠\x1b[0m  ${primaryConfig} already exists in ${dir}`,
          );
          return;
        }

        // Create parent directory if needed (e.g. .claude/)
        const parentDir = join(
          dir,
          primaryConfig.split("/").slice(0, -1).join("/"),
        );
        if (parentDir !== dir) {
          mkdirSync(parentDir, { recursive: true });
        }

        // Generate a starter config
        const content = generateStarterConfig(tool);
        writeFileSync(configPath, content);
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
npm run dev
npm run build
npm run test
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
npm run dev
npm run build
npm run test
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
