/**
 * Path-safety helpers for routes that write into the agent's working folder.
 *
 * The AI plugin is an external package and cannot import the agent's
 * `src/core/safe-paths.ts`, so the `isPathInside` guard is replicated here.
 * Everything written by `instructions.ts` / `context-files.ts` must stay inside
 * the resolved working directory — never escape via `..` or absolute names.
 */

import { resolve, sep } from "node:path";

/** True when `child` resolves to `parent` itself or a path strictly inside it. */
export function isPathInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  if (c === p) return true;
  const withSep = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(withSep);
}

/**
 * Validate + normalise a user-supplied filename to a safe basename. Rejects path
 * separators, traversal, and anything outside a conservative charset.
 */
export function safeBasename(name: string): string {
  const trimmed = (name ?? "").trim();
  // Strip any directory component a caller may have included.
  const base = trimmed.replace(/^.*[\\/]/, "");
  if (
    !base ||
    base === "." ||
    base === ".." ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(base)
  ) {
    throw new Error(`Unsafe filename: ${name}`);
  }
  return base;
}

/**
 * Resolve `baseDir` + segments and assert the result stays within `baseDir`.
 * Throws on traversal. Segments are not basename-validated here — pass already
 * validated basenames (or fixed subdir names you control).
 */
export function safeJoinWithin(baseDir: string, ...segments: string[]): string {
  const joined = resolve(baseDir, ...segments);
  if (!isPathInside(joined, baseDir)) {
    throw new Error("Resolved path escapes the working directory");
  }
  return joined;
}
