# @vibecontrols/vibe-plugin-ai

AI tool management plugin for [VibeControls Agent](https://www.npmjs.com/package/@vibecontrols/agent).

## Installation

```bash
vibe plugin install @vibecontrols/vibe-plugin-ai
```

Or install globally alongside the agent:

```bash
npm install -g @vibecontrols/vibe-plugin-ai
```

## Features

- **Tool Detection** — Detect installed AI coding tools
- **Tool Installation** — Install AI tools via CLI
- **Config Management** — Initialize project configs for AI tools (CLAUDE.md, AGENTS.md, etc.)
- **Multi-Tool Support** — Claude Code, OpenCode, Codex, Copilot, Cursor Agent

## Supported Tools

| Tool           | CLI Command  | Config Files                           |
| -------------- | ------------ | -------------------------------------- |
| Claude Code    | `claude`     | `CLAUDE.md`, `.claude/settings.json`   |
| OpenCode       | `opencode`   | `OPENCODE.md`, `.opencode/config.json` |
| Codex CLI      | `codex`      | `AGENTS.md`, `codex.json`              |
| GitHub Copilot | `gh copilot` | `.github/copilot-instructions.md`      |
| Cursor Agent   | `cursor`     | `.cursor/rules`, `.cursorrules`        |

## CLI Commands

```bash
vibe ai list                  # List all AI tools and their status
vibe ai check                 # Quick check which tools are installed
vibe ai install claude-code   # Install an AI tool
vibe ai init claude-code      # Create starter config (CLAUDE.md)
vibe ai init codex            # Create AGENTS.md for Codex
vibe ai init copilot          # Create copilot-instructions.md
```

## Requirements

- VibeControls Agent >= 1.1.0
- Node.js >= 18.0.0

<!-- VIBECONTROLS_OSS_FOOTER_START -->

---

## About VibeControls

**VibeControls** is the agentic engineering mission control for AI-native teams. Vibe-plugins extend the VibeControls agent with new providers, tools, sessions, tunnels, storage backends, and security stages.

- Website: <https://vibecontrols.com>
- Documentation: <https://docs.vibecontrols.com>
- Plugin SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- All plugins: <https://github.com/algoshred?q=vibe-plugin-&type=all>

## License

Released under the [MIT License](./LICENSE).

Copyright (c) 2026 Burdenoff Consultancy Services Private Limited, Algoshred Technologies Private Limited, and all its sister companies.

Maintainer: **Vignesh T.V** — <https://github.com/tvvignesh>

**Note**: this plugin is open source under MIT. The `@vibecontrols/agent` runtime that loads and orchestrates plugins is **closed source** and proprietary to Burdenoff Consultancy Services Pvt. Ltd. If you want a fully self-hostable agent, please open an issue or contact the maintainer.

<!-- VIBECONTROLS_OSS_FOOTER_END -->
