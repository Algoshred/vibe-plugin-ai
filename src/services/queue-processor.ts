/**
 * Queue Processor
 *
 * Background service that polls the prompt queue and dispatches
 * queued prompts to their target AI sessions via provider plugins.
 */

import type { QueueDatabase } from "../db/queue.js";
import type { DispatchedPromptDatabase } from "../db/dispatched-prompts.js";
import type { SessionDatabase } from "../db/sessions.js";
import type { LogDatabase } from "../db/logs.js";

export interface QueueProcessorDeps {
  queueDb: QueueDatabase;
  dispatchDb: DispatchedPromptDatabase;
  sessionDb: SessionDatabase;
  logDb: LogDatabase;
  getAIProvider: (agentType: string) => unknown | undefined;
  logger?: {
    info: (source: string, msg: string) => void;
    error: (source: string, msg: string) => void;
    debug: (source: string, msg: string) => void;
  };
}

export class QueueProcessor {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private deps: QueueProcessorDeps;

  constructor(deps: QueueProcessorDeps) {
    this.deps = deps;
  }

  start(intervalMs = 5000): void {
    if (this.intervalId) return;

    this.deps.logger?.info("queue-processor", `Started (polling every ${intervalMs}ms)`);

    this.intervalId = setInterval(async () => {
      if (this.processing) return;
      await this.processQueue();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.deps.logger?.info("queue-processor", "Stopped");
    }
  }

  private async processQueue(): Promise<void> {
    this.processing = true;

    try {
      const items = this.deps.queueDb.getReady(5);
      if (items.length === 0) {
        this.processing = false;
        return;
      }

      this.deps.logger?.debug(
        "queue-processor",
        `Processing ${items.length} queued items`,
      );

      for (const item of items) {
        await this.processItem(item.id);
      }
    } catch (err) {
      this.deps.logger?.error(
        "queue-processor",
        `Queue processing error: ${err instanceof Error ? err.message : "unknown"}`,
      );
    } finally {
      this.processing = false;
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

    const provider = this.deps.getAIProvider(session.agentType) as {
      sendPrompt?: (
        sessionId: string,
        prompt: string,
        context?: unknown[],
      ) => Promise<unknown>;
    } | undefined;

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
      const response = await provider.sendPrompt(
        session.id,
        dispatch.content,
      );

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

      this.deps.logger?.info(
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

      this.deps.logger?.error(
        "queue-processor",
        `Failed: ${dispatch.id} — ${errorMsg}`,
      );
    }
  }
}
