/**
 * QueueProcessor tests — event-driven drain + safety timer.
 *
 * Covers the two contract guarantees that matter to the agent:
 *   1. enqueue → processor picks up within ~50ms (event-driven path).
 *   2. an item that slips past the event (e.g. listener miss) is still
 *      picked up by the safety timer.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { QueueDatabase } from "../../db/queue.js";
import { DispatchedPromptDatabase } from "../../db/dispatched-prompts.js";
import { SessionDatabase } from "../../db/sessions.js";
import { LogDatabase } from "../../db/logs.js";
import { QueueProcessor } from "../../services/queue-processor.js";
import { createMockStorage } from "../helpers/mock-storage.js";

async function setup() {
  const storage = createMockStorage();
  const queueDb = new QueueDatabase(storage);
  const dispatchDb = new DispatchedPromptDatabase(storage);
  const sessionDb = new SessionDatabase(storage);
  const logDb = new LogDatabase(storage);
  await Promise.all([
    queueDb.hydrate(),
    dispatchDb.hydrate(),
    sessionDb.hydrate(),
    logDb.hydrate(),
  ]);

  const session = await sessionDb.create({ name: "T", agentType: "claude" });
  const dispatch = dispatchDb.create({
    sessionId: session.id,
    content: "hello",
  });

  const sendPrompt = mock(async () => ({ content: "ok" }));
  const provider = { sendPrompt };
  const processor = new QueueProcessor({
    queueDb,
    dispatchDb,
    sessionDb,
    logDb,
    getAIProvider: () => provider,
  });

  return {
    queueDb,
    dispatchDb,
    sessionDb,
    processor,
    sendPrompt,
    session,
    dispatch,
  };
}

describe("QueueProcessor", () => {
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    teardown = null;
  });
  afterEach(() => {
    teardown?.();
  });

  it("picks up an enqueued item within 50ms via the event path", async () => {
    const { queueDb, dispatchDb, processor, sendPrompt, session, dispatch } =
      await setup();
    processor.start(60_000); // safety timer effectively disabled
    teardown = () => processor.stop();

    queueDb.enqueue({
      dispatchedPromptId: dispatch.id,
      sessionId: session.id,
    });

    // Yield repeatedly up to ~50ms for the microtask drain to land.
    const deadline = Date.now() + 50;
    while (Date.now() < deadline && sendPrompt.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    const completed = dispatchDb.getById(dispatch.id);
    expect(completed?.status).toBe("completed");
  });

  it("safety timer drains an item the event path missed", async () => {
    const { queueDb, processor, sendPrompt, session, dispatch } = await setup();

    // Enqueue BEFORE start, then attach a listener that throws to simulate
    // the event being lost. Start with a very short safety interval so the
    // backstop fires inside the test window.
    queueDb.enqueue({
      dispatchedPromptId: dispatch.id,
      sessionId: session.id,
    });

    // Overwrite the emitter path: any subsequent `enqueued` events get
    // swallowed by attaching a no-op listener BEFORE the processor's own
    // listener. The pre-start enqueue above is already stranded — only the
    // safety timer (or the start-time initial drain) can pick it up. We
    // disable the start-time initial drain by stubbing scheduleDrain via
    // start() trickery: simplest = use a long-enough safety interval and
    // rely on the explicit start-time drain. So instead we add a SECOND
    // stranded item AFTER start, with a listener that throws.
    processor.start(40); // 40ms safety timer
    teardown = () => processor.stop();

    // First item drains via start-time scheduleDrain. Wait for it.
    {
      const deadline = Date.now() + 200;
      while (Date.now() < deadline && sendPrompt.mock.calls.length < 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(sendPrompt).toHaveBeenCalledTimes(1);
    }

    // Now attach an interfering listener that simulates a dropped event by
    // throwing — the EventEmitter will surface it but the processor's own
    // microtask schedule still fires; to truly simulate "missed event" we
    // just bypass it by writing directly to the underlying KV store.
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    queueDb.store.put({
      id,
      dispatchedPromptId: dispatch.id,
      sessionId: session.id,
      priority: 0,
      scheduledAt: null,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    // No event was emitted — only the safety timer can pick this up.

    const deadline = Date.now() + 500;
    while (Date.now() < deadline && sendPrompt.mock.calls.length < 2) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(sendPrompt).toHaveBeenCalledTimes(2);
  });
});
