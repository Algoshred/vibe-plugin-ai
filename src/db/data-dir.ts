/**
 * Resolves the on-disk directory the AI plugin writes to.
 *
 * The host agent (vibecontrols-agent) sets `VIBECONTROLS_DATA_DIR` to
 * `.boff/vibecontrols/agents/{agentId}/` at boot so all plugins share a
 * per-agent, reset-aware, encryption-at-rest-friendly data directory.
 *
 * When the plugin is loaded standalone (CLI tests, ad-hoc usage without
 * the host agent), we fall back to the legacy `~/.vibecontrols/`
 * location so existing tooling keeps working.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function getDataDir(): string {
  const dir = process.env.VIBECONTROLS_DATA_DIR || join(homedir(), ".vibecontrols");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
