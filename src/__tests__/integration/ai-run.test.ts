/**
 * Integration tests for `vibe ai run <harness>` (Phase 8).
 *
 * Drives `runAiRunCore` directly with mocked AI + session providers to
 * cover the four contract branches:
 *   1. Anonymous session  → create + spawn with vibe-ai-<h>-<short>
 *   2. Named session, no existing match → create + sendCommand
 *   3. Named session, existing match same harness → attach
 *   4. Named session, existing match different harness → ERROR with the
 *      `'vibe session kill <name>'` instruction.
 *   + provider-without-CLI emits the `vibe ai sdk` redirect.
 */
import { describe, expect, it, mock } from "bun:test";
import { runAiRunCore } from "../../index.js";

interface MockSession {
  id: string;
  name: string;
  status: string;
  metadata?: Record<string, unknown>;
}

function makeAiProvider(opts: {
  name: string;
  binary?: string;
  env?: Record<string, string>;
}) {
  return {
    name: opts.name,
    getDisplayName: () => opts.name.toUpperCase(),
    getCliLaunchSpec: () =>
      opts.binary === undefined
        ? null
        : { binary: opts.binary, env: opts.env ?? {} },
    sdkOneShot: mock(async () => ({ text: "stub" })),
  };
}

function makeSessionProvider(initial: MockSession[] = []) {
  const store = new Map<string, MockSession>();
  for (const s of initial) store.set(s.name, s);
  const create = mock(
    async (cfg: {
      name: string;
      command?: string;
      environment?: Record<string, string>;
      metadata?: Record<string, unknown>;
    }) => {
      const id = `id-${cfg.name}`;
      const rec: MockSession = {
        id,
        name: cfg.name,
        status: "active",
        metadata: cfg.metadata,
      };
      store.set(cfg.name, rec);
      return { id, name: cfg.name };
    },
  );
  const sendCommand = mock(async (_id: string, _cmd: string) => {
    /* noop */
  });
  return {
    name: "tmux",
    list: mock(async () => Array.from(store.values())),
    create,
    sendCommand,
    store,
    _calls: { create, sendCommand },
  };
}

function makeBuffer() {
  const out: string[] = [];
  const errs: string[] = [];
  let exitCode: number | null = null;
  return {
    out,
    errs,
    get exit() {
      return exitCode;
    },
    log: (line: string) => {
      out.push(line);
    },
    err: (line: string) => {
      errs.push(line);
    },
    exitFn: (code: number) => {
      exitCode = code;
    },
  };
}

describe("vibe ai run — runAiRunCore", () => {
  it("creates an anonymous session when -s is omitted and forwards env", async () => {
    const provider = makeAiProvider({
      name: "claude",
      binary: "claude",
      env: { ANTHROPIC_API_KEY: "k1" },
    });
    const session = makeSessionProvider();
    const buf = makeBuffer();

    const result = await runAiRunCore(
      "claude",
      [],
      { json: true },
      {
        getAiProvider: (n) => (n === "claude" ? provider : undefined),
        listAiProviders: () => [{ pluginName: "claude" }],
        getSessionProvider: () => session,
        log: buf.log,
        err: buf.err,
        exit: buf.exitFn,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.action).toBe("create");
    expect(buf.exit).toBeNull();

    expect(session._calls.create.mock.calls.length).toBe(1);
    const createArg = session._calls.create.mock.calls[0]![0];
    expect(createArg.name).toMatch(/^vibe-ai-claude-/);
    expect(createArg.command).toBe("claude");
    expect(createArg.environment).toEqual({ ANTHROPIC_API_KEY: "k1" });
    expect(createArg.metadata?.["harness"]).toBe("claude");
    expect(createArg.metadata?.["ai"]).toBe(true);
  });

  it("attaches when -s names an existing session running the same harness", async () => {
    const provider = makeAiProvider({ name: "claude", binary: "claude" });
    const session = makeSessionProvider([
      {
        id: "id-x",
        name: "x",
        status: "active",
        metadata: { harness: "claude" },
      },
    ]);
    const buf = makeBuffer();

    const result = await runAiRunCore(
      "claude",
      [],
      { json: true, session: "x" },
      {
        getAiProvider: () => provider,
        listAiProviders: () => [{ pluginName: "claude" }],
        getSessionProvider: () => session,
        log: buf.log,
        err: buf.err,
        exit: buf.exitFn,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.action).toBe("attach");
    expect(session._calls.create.mock.calls.length).toBe(0);
    const json = JSON.parse(buf.out.at(-1) ?? "{}");
    expect(json.action).toBe("attach");
    expect(json.session.name).toBe("x");
  });

  it("hard-errors with kill instruction when -s names a session running a different harness", async () => {
    const provider = makeAiProvider({ name: "claude", binary: "claude" });
    const session = makeSessionProvider([
      {
        id: "id-y",
        name: "y",
        status: "active",
        metadata: { harness: "codex" },
      },
    ]);
    const buf = makeBuffer();

    const result = await runAiRunCore(
      "claude",
      [],
      { session: "y" },
      {
        getAiProvider: () => provider,
        listAiProviders: () => [{ pluginName: "claude" }],
        getSessionProvider: () => session,
        log: buf.log,
        err: buf.err,
        exit: buf.exitFn,
      },
    );

    expect(result.ok).toBe(false);
    expect(buf.exit).toBe(2);
    const message = result.error ?? "";
    expect(message).toContain("y is currently running codex");
    expect(message).toContain("vibe session kill y");
    expect(session._calls.create.mock.calls.length).toBe(0);
  });

  it("forwards harnessArgs verbatim via sendCommand", async () => {
    const provider = makeAiProvider({ name: "codex", binary: "codex" });
    const session = makeSessionProvider();
    const buf = makeBuffer();

    await runAiRunCore(
      "codex",
      ["--resume", "abc", "extra"],
      {},
      {
        getAiProvider: () => provider,
        listAiProviders: () => [{ pluginName: "codex" }],
        getSessionProvider: () => session,
        log: buf.log,
        err: buf.err,
        exit: buf.exitFn,
      },
    );

    expect(session._calls.sendCommand.mock.calls.length).toBe(1);
    const [, cmd] = session._calls.sendCommand.mock.calls[0]!;
    expect(cmd).toBe("codex --resume abc extra");
  });

  it("rejects providers that have no CLI mode with an `vibe ai sdk` hint", async () => {
    const provider = makeAiProvider({ name: "openrouter" }); // no binary
    const session = makeSessionProvider();
    const buf = makeBuffer();

    const result = await runAiRunCore(
      "openrouter",
      [],
      {},
      {
        getAiProvider: () => provider,
        listAiProviders: () => [{ pluginName: "openrouter" }],
        getSessionProvider: () => session,
        log: buf.log,
        err: buf.err,
        exit: buf.exitFn,
      },
    );

    expect(result.ok).toBe(false);
    expect(buf.exit).toBe(1);
    expect(result.error).toContain("vibe ai sdk openrouter");
  });

  it("returns unknown-harness error when provider name does not resolve", async () => {
    const session = makeSessionProvider();
    const buf = makeBuffer();

    const result = await runAiRunCore(
      "ghost",
      [],
      {},
      {
        getAiProvider: () => undefined,
        listAiProviders: () => [],
        getSessionProvider: () => session,
        log: buf.log,
        err: buf.err,
        exit: buf.exitFn,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown harness 'ghost'");
  });
});
