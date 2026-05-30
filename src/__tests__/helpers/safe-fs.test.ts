/**
 * safe-fs Tests
 *
 * Guards for the instruction-file + context-file routes that write into the
 * agent's working directory. These must reject path traversal / separators so
 * a malicious filename can never escape the working dir.
 */
import { describe, expect, it } from "bun:test";
import {
  isPathInside,
  safeBasename,
  safeJoinWithin,
} from "../../routes/safe-fs.js";

describe("isPathInside", () => {
  it("accepts the dir itself and children", () => {
    expect(isPathInside("/work", "/work")).toBe(true);
    expect(isPathInside("/work/AGENTS.md", "/work")).toBe(true);
    expect(isPathInside("/work/.vibe/context/a.txt", "/work")).toBe(true);
  });

  it("rejects siblings and parents", () => {
    expect(isPathInside("/work-other/x", "/work")).toBe(false);
    expect(isPathInside("/etc/passwd", "/work")).toBe(false);
    expect(isPathInside("/work/../etc/passwd", "/work")).toBe(false);
  });
});

describe("safeBasename", () => {
  it("accepts canonical instruction filenames + safe customs", () => {
    expect(safeBasename("AGENTS.md")).toBe("AGENTS.md");
    expect(safeBasename("CLAUDE.md")).toBe("CLAUDE.md");
    expect(safeBasename(".cursorrules")).toBe(".cursorrules");
    expect(safeBasename("notes_v2.md")).toBe("notes_v2.md");
  });

  it("strips a leading directory component", () => {
    expect(safeBasename("/abs/path/AGENTS.md")).toBe("AGENTS.md");
    expect(safeBasename("nested/dir/file.md")).toBe("file.md");
  });

  it("rejects traversal + empty + unsafe chars", () => {
    expect(() => safeBasename("..")).toThrow();
    expect(() => safeBasename("")).toThrow();
    expect(() => safeBasename("a b.md")).toThrow();
    expect(() => safeBasename("évil.md")).toThrow();
  });
});

describe("safeJoinWithin", () => {
  it("joins safe segments inside the base", () => {
    const p = safeJoinWithin("/work", ".vibe", "context", "a.txt");
    expect(p).toBe("/work/.vibe/context/a.txt");
  });

  it("throws when a segment escapes the base", () => {
    expect(() => safeJoinWithin("/work", "..", "etc", "passwd")).toThrow();
    expect(() => safeJoinWithin("/work", "../../escape")).toThrow();
  });
});
