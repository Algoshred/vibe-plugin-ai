/**
 * Integration tests for `vibe ai sdk <provider>` (Phase 8).
 *
 * Drives `runAiSdkCore` directly, asserting:
 *   - --prompt / --model / --max-tokens are pulled out of `--`-passthrough
 *     args and threaded to sdkOneShot
 *   - unrecognised --foo flags fall into `extras`
 *   - JSON envelope matches contract when --json is set
 *   - missing --prompt errors with a helpful hint
 *   - unknown provider errors out
 */
import { describe, expect, it, mock } from "bun:test";
import { runAiSdkCore } from "../../index.js";

function makeProvider(text = "stub-output") {
  const sdkOneShot = mock(
    async (_opts: {
      prompt: string;
      model?: string;
      maxTokens?: number;
      extras?: Record<string, unknown>;
    }) => ({
      text,
      usage: { inputTokens: 4, outputTokens: 8, model: _opts.model ?? "x" },
    }),
  );
  return {
    name: "claude",
    getCliLaunchSpec: () => ({ binary: "claude" }),
    sdkOneShot,
  };
}

function makeBuffer() {
  const out: string[] = [];
  const errs: string[] = [];
  let written = "";
  let exitCode: number | null = null;
  return {
    out,
    errs,
    written: () => written,
    get exit() {
      return exitCode;
    },
    log: (line: string) => {
      out.push(line);
    },
    err: (line: string) => {
      errs.push(line);
    },
    write: (chunk: string) => {
      written += chunk;
    },
    exitFn: (code: number) => {
      exitCode = code;
    },
  };
}

describe("vibe ai sdk — runAiSdkCore", () => {
  it("threads --prompt / --model / --max-tokens to sdkOneShot", async () => {
    const provider = makeProvider("hello world");
    const buf = makeBuffer();

    const result = await runAiSdkCore(
      "claude",
      [
        "--prompt",
        "hello",
        "--model",
        "claude-haiku-4-5-20251001",
        "--max-tokens",
        "256",
      ],
      {},
      {
        getAiProvider: (n) => (n === "claude" ? provider : undefined),
        log: buf.log,
        err: buf.err,
        exit: buf.exitFn,
        write: buf.write,
      },
    );

    expect(result.ok).toBe(true);
    expect(provider.sdkOneShot.mock.calls.length).toBe(1);
    const callArg = provider.sdkOneShot.mock.calls[0]![0];
    expect(callArg.prompt).toBe("hello");
    expect(callArg.model).toBe("claude-haiku-4-5-20251001");
    expect(callArg.maxTokens).toBe(256);
    // Plain mode writes text to stdout, no JSON
    expect(buf.written()).toBe("hello world\n");
    expect(buf.out.length).toBe(0);
  });

  it("forwards unknown flags into the `extras` bag", async () => {
    const provider = makeProvider();
    const buf = makeBuffer();

    await runAiSdkCore(
      "claude",
      [
        "--prompt",
        "x",
        "--temperature",
        "0.5",
        "--system",
        "you are helpful",
        "--reasoning",
      ],
      {},
      {
        getAiProvider: () => provider,
        log: buf.log,
        err: buf.err,
        exit: buf.exitFn,
        write: buf.write,
      },
    );

    const arg = provider.sdkOneShot.mock.calls[0]![0];
    expect(arg.extras).toMatchObject({
      temperature: "0.5",
      system: "you are helpful",
      reasoning: true,
    });
  });

  it("emits JSON envelope when --json is set", async () => {
    const provider = makeProvider("text-out");
    const buf = makeBuffer();

    await runAiSdkCore(
      "claude",
      ["--prompt", "p", "--model", "m"],
      { json: true },
      {
        getAiProvider: () => provider,
        log: buf.log,
        err: buf.err,
        exit: buf.exitFn,
        write: buf.write,
      },
    );

    expect(buf.written()).toBe("");
    const payload = JSON.parse(buf.out.at(-1) ?? "{}");
    expect(payload).toMatchObject({
      ok: true,
      provider: "claude",
      model: "m",
      text: "text-out",
    });
    expect(payload.usage).toMatchObject({ inputTokens: 4, outputTokens: 8 });
  });

  it("errors when --prompt is missing", async () => {
    const provider = makeProvider();
    const buf = makeBuffer();

    const result = await runAiSdkCore(
      "claude",
      ["--model", "m"],
      {},
      {
        getAiProvider: () => provider,
        log: buf.log,
        err: buf.err,
        exit: buf.exitFn,
        write: buf.write,
      },
    );

    expect(result.ok).toBe(false);
    expect(buf.exit).toBe(1);
    expect(result.error).toContain("missing --prompt");
    expect(provider.sdkOneShot.mock.calls.length).toBe(0);
  });

  it("errors when the provider is unknown", async () => {
    const buf = makeBuffer();

    const result = await runAiSdkCore(
      "ghost",
      ["--prompt", "p"],
      {},
      {
        getAiProvider: () => undefined,
        log: buf.log,
        err: buf.err,
        exit: buf.exitFn,
        write: buf.write,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown provider 'ghost'");
  });

  it("propagates sdkOneShot rejections as ok=false with the underlying message", async () => {
    const provider = {
      name: "claude",
      getCliLaunchSpec: () => null,
      sdkOneShot: mock(async () => {
        throw new Error("boom");
      }),
    };
    const buf = makeBuffer();

    const result = await runAiSdkCore(
      "claude",
      ["--prompt", "p"],
      {},
      {
        getAiProvider: () => provider,
        log: buf.log,
        err: buf.err,
        exit: buf.exitFn,
        write: buf.write,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("boom");
    expect(buf.exit).toBe(1);
  });
});
