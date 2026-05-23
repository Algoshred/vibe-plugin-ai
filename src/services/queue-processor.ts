/**
 * Queue Processor
 *
 * Background service that drains the prompt queue and dispatches
 * queued prompts to their target AI sessions via provider plugins.
 *
 * Wakeup strategy:
 *   1. Event-driven: `QueueDatabase.on("enqueued", …)` triggers an
 *      immediate drain. Producers (dispatch routes) and the processor
 *      live in the same agent process, so an in-process EventEmitter
 *      is the right primitive here — no broker required.
 *   2. Safety timer: a low-frequency (60s) `setInterval` re-runs the
 *      drain so any item that was somehow missed by an event (e.g. a
 *      listener crash, scheduled-for-future items now ready, server
 *      restart with un-drained backlog) still gets picked up.
 */

import type { QueueDatabase } from "../db/queue.js";
import type { DispatchedPromptDatabase } from "../db/dispatched-prompts.js";
import type { SessionDatabase } from "../db/sessions.js";
import type { LogDatabase } from "../db/logs.js";

const SAFETY_INTERVAL_MS = 60_000;

export interface QueueProcessorDeps {
  queueDb: QueueDatabase;
  dispatchDb: DispatchedPromptDatabase;
  sessionDb: SessionDatabase;
  logDb: LogDatabase;
  getAIProvider: (agentType: string) => unknown | undefined;
  logger?: {
    info?: (source: string, msg: string, meta?: Record<string, unknown>) => void;
    error?: (source: string, msg: string, meta?: Record<string, unknown>) => void;
    debug?: (source: string, msg: string, meta?: Record<string, unknown>) => void;
  };
}

export class QueueProcessor {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private pendingDrain = false;
  private unsubscribeEnqueue: (() => void) | null = null;
  private deps: QueueProcessorDeps;

  constructor(deps: QueueProcessorDeps) {
    this.deps = deps;
  }

  /**
   * Start the processor.
   *
   * @param safetyIntervalMs - Low-frequency safety drain. Defaults to 60s;
   *   only intended as a backstop for missed events. Pass smaller values
   *   in tests.
   */
  start(safetyIntervalMs = SAFETY_INTERVAL_MS): void {
    if (this.intervalId || this.unsubscribeEnqueue) return;

    this.deps.logger?.info?.(
      "queue-processor",
      `Started (event-driven, safety drain every ${safetyIntervalMs}ms)`,
    );

    // Wire up the event-driven path. We coalesce bursts via `pendingDrain`
    // so a flood of enqueues doesn't spawn a flood of overlapping drains.
    this.unsubscribeEnqueue = this.deps.queueDb.on("enqueued", () => {
      this.scheduleDrain();
    });

    // Safety timer — runs much less often than the old 5s poll.
    this.intervalId = setInterval(() => {
      this.scheduleDrain();
    }, safetyIntervalMs);

    // Drain anything that was already pending at startup (e.g. items
    // persisted across an agent restart).
    this.scheduleDrain();
  }

  stop(): void {
    if (this.unsubscribeEnqueue) {
      this.unsubscribeEnqueue();
      this.unsubscribeEnqueue = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.deps.logger?.info?.("queue-processor", "Stopped");
    }
  }

  /**
   * Coalesce drain requests. If a drain is already running, mark a
   * follow-up so any items that arrived mid-drain still get picked up.
   * Microtask scheduling lets multiple synchronous `enqueue()` calls fold
   * into a single drain pass.
   */
  private scheduleDrain(): void {
    if (this.processing) {
      this.pendingDrain = true;
      return;
    }
    queueMicrotask(() => {
      void this.runDrain();
    });
  }

  private async runDrain(): Promise<void> {
    if (this.processing) {
      this.pendingDrain = true;
      return;
    }
    this.processing = true;
    try {
      do {
        this.pendingDrain = false;
        await this.processQueue();
      } while (this.pendingDrain);
    } finally {
      this.processing = false;
    }
  }

  private async processQueue(): Promise<void> {
    try {
      const items = this.deps.queueDb.getReady(5);
      if (items.length === 0) return;

      this.deps.logger?.debug?.(
        "queue-processor",
        `Processing ${items.length} queued items`,
      );

      for (const item of items) {
        await this.processItem(item.id);
      }
    } catch (err) {
      this.deps.logger?.error?.(
        "queue-processor",
        `Queue processing error: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
  }

  private async processItem(queueItemId: string): Promise<void> {
    const claimed = this.deps.queueDb.markProcessing(queueItemId);
    if (!claimed) return;

    const item = this.deps.queueDb.getById(queueItemId);
    if (!item) return;

    const dispatch = this.deps.dispatchDb.getById(item.dispatchedPromptId);
    if (!dispatch) {
      this.deps.queueDb.markFailed(queueItemId, "Dispatch record not found");
      return;
    }

    const session = this.deps.sessionDb.getById(item.sessionId);
    if (!session) {
      this.deps.queueDb.markFailed(queueItemId, "Session not found");
      return;
    }

    if (session.status === "terminated") {
      this.deps.queueDb.markFailed(queueItemId, "Session is terminated");
      return;
    }

    const provider = this.deps.getAIProvider(session.agentType) as
      | {
          sendPrompt?: (
            sessionId: string,
            prompt: string,
            context?: unknown[],
          ) => Promise<unknown>;
        }
      | undefined;

    if (!provider?.sendPrompt) {
      this.deps.queueDb.markFailed(
        queueItemId,
        `No provider for agent type '${session.agentType}'`,
      );
      return;
    }

    // Update dispatch status
    this.deps.dispatchDb.update(dispatch.id, { status: "processing" });
    this.deps.sessionDb.update(session.id, { status: "processing" });

    // Log input
    this.deps.logDb.append({
      sessionId: session.id,
      type: "input",
      content: dispatch.content,
    });

    try {
      const response = await provider.sendPrompt(session.id, dispatch.content);

      // Log output
      const resp = response as Record<string, unknown>;
      this.deps.logDb.append({
        sessionId: session.id,
        type: "output",
        content:
          typeof resp.content === "string"
            ? resp.content
            : JSON.stringify(resp),
        tokenCount: (resp.outputTokens as number) || undefined,
        model: (resp.model as string) || undefined,
        durationMs: (resp.durationMs as number) || undefined,
      });

      // Mark completed
      this.deps.dispatchDb.update(dispatch.id, {
        status: "completed",
        result: resp,
      });
      this.deps.sessionDb.update(session.id, { status: "active" });
      this.deps.queueDb.markCompleted(queueItemId);

      this.deps.logger?.info?.(
        "queue-processor",
        `Completed: ${dispatch.id} → session ${session.id}`,
      );
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Unknown dispatch error";

      this.deps.logDb.append({
        sessionId: session.id,
        type: "error",
        content: errorMsg,
      });

      this.deps.dispatchDb.update(dispatch.id, { status: "failed" });
      this.deps.sessionDb.update(session.id, { status: "error" });
      this.deps.queueDb.markFailed(queueItemId, errorMsg);

      this.deps.logger?.error?.(
        "queue-processor",
        `Failed: ${dispatch.id} — ${errorMsg}`,
      );
    }
  }
}
