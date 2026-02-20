# @burdenoff/vibe-plugin-ai

AI tool management plugin for [VibeControls Agent](https://www.npmjs.com/package/@burdenoff/vibe-agent).

## Installation

```bash
vibe plugin install @burdenoff/vibe-plugin-ai
```

Or install globally alongside the agent:

```bash
npm install -g @burdenoff/vibe-plugin-ai
```

## Features

- **Tool Detection** — Detect installed AI coding tools
- **Tool Installation** — Install AI tools via CLI
- **Config Management** — Initialize project configs for AI tools (CLAUDE.md, AGENTS.md, etc.)
- **Multi-Tool Support** — Claude Code, OpenCode, Codex, Copilot, Cursor Agent

## Supported Tools

| Tool | CLI Command | Config Files |
|------|------------|-------------|
| Claude Code | `claude` | `CLAUDE.md`, `.claude/settings.json` |
| OpenCode | `opencode` | `OPENCODE.md`, `.opencode/config.json` |
| Codex CLI | `codex` | `AGENTS.md`, `codex.json` |
| GitHub Copilot | `gh copilot` | `.github/copilot-instructions.md` |
| Cursor Agent | `cursor` | `.cursor/rules`, `.cursorrules` |

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

## License

Proprietary — Copyright Burdenoff Consultancy Services Pvt. Ltd.
