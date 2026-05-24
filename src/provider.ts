/**
 * AIAgentProvider Interface
 *
 * Abstraction layer for AI coding agents. Implementations can wrap
 * Claude Code, OpenAI Codex, OpenCode, GitHub Copilot, Gemini,
 * or any other AI coding agent.
 *
 * Default implementation: @vibecontrols/vibe-plugin-claude
 */

// ── Types ───────────────────────────────────────────────────────────────

export type AISessionStatus =
  | "active"
  | "idle"
  | "processing"
  | "error"
  | "terminated";

export type AILogType =
  | "input"
  | "output"
  | "thinking"
  | "event"
  | "error"
  | "metadata";

export type AIContextType =
  | "git_repo"
  | "api_call"
  | "markdown_doc"
  | "command"
  | "plain_text"
  | "file"
  | "url";

export interface AISessionConfig {
  /** Display name for the session */
  name: string;
  /** AI agent type (e.g., "claude", "codex", "opencode") */
  agentType: string;
  /** Model to use (e.g., "claude-sonnet-4-5-20250514", "gpt-4o") */
  model?: string;
  /** Maximum tokens for output */
  maxTokens?: number;
  /** Sampling temperature (0-1) */
  temperature?: number;
  /** System prompt / instructions */
  systemPrompt?: string;
  /** Working directory for the agent */
  workingDirectory?: string;
  /**
   * Autonomy / permission level for CLI-mode sessions. Provider-agnostic;
   * each CLI plugin maps it to its native approval flags. Ignored by SDK
   * adapters (direct API calls). Defaults to "acceptEdits" at the adapter
   * when unset.
   */
  permissionMode?: PermissionMode;
  /** Additional provider-specific configuration */
  providerConfig?: Record<string, unknown>;
}

export interface AISession {
  /** Unique session identifier */
  id: string;
  /** Display name */
  name: string;
  /** Current status */
  status: AISessionStatus;
  /** AI agent type */
  agentType: string;
  /** Provider plugin name */
  provider: string;
  /** Session configuration */
  config: AISessionConfig;
  /** Usage statistics */
  stats: AIUsageStats;
  /** Creation timestamp */
  createdAt: string;
  /** Last activity timestamp */
  updatedAt: string;
}

export interface AIContext {
  /** Context identifier */
  id: string;
  /** Context type */
  type: AIContextType;
  /** Context content */
  content: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export interface AIResponse {
  /** Response content */
  content: string;
  /** Model used */
  model: string;
  /** Input token count */
  inputTokens: number;
  /** Output token count */
  outputTokens: number;
  /** Thinking/reasoning steps (if available) */
  thinkingSteps?: string[];
  /** Response duration in milliseconds */
  durationMs: number;
  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
}

export interface AIStreamChunk {
  /** Chunk type */
  type: "text" | "thinking" | "error" | "done";
  /** Chunk content */
  content: string;
  /** Cumulative token count so far */
  tokensUsed?: number;
}

export interface AILog {
  /** Log entry identifier */
  id: string;
  /** Session this log belongs to */
  sessionId: string;
  /** Log type */
  type: AILogType;
  /** Log content */
  content: string;
  /** Token count (for input/output entries) */
  tokenCount?: number;
  /** Model used */
  model?: string;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Provider-specific metadata */
  agentMetadata?: Record<string, unknown>;
  /** Timestamp */
  createdAt: string;
}

export interface AILogFilter {
  /** Filter by log types */
  types?: AILogType[];
  /** Start date (ISO string) */
  startDate?: string;
  /** End date (ISO string) */
  endDate?: string;
  /** Search text in content */
  search?: string;
  /** Maximum number of entries */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

export interface AIUsageStats {
  /** Total input tokens consumed */
  inputTokens: number;
  /** Total output tokens consumed */
  outputTokens: number;
  /** Total number of requests */
  requestCount: number;
  /** Estimated cost in USD */
  estimatedCostUsd: number;
  /** Breakdown by model */
  modelBreakdown?: Record<
    string,
    { inputTokens: number; outputTokens: number; requestCount: number }
  >;
}

// ── Model & Capability Types ────────────────────────────────────────────

export type ProviderMode = "sdk" | "cli";

/**
 * Autonomy level for CLI-mode sessions.
 * - "plan": read-only / planning, no edits or commands applied.
 * - "acceptEdits": auto-apply file edits, gate risky commands (default).
 * - "fullAuto": unattended — run commands & edits without approval.
 */
export type PermissionMode = "plan" | "acceptEdits" | "fullAuto";

export interface AIProviderModeMetadata {
  /** Modes this provider can execute for real requests. */
  supportedModes: ProviderMode[];
  /** Modes intentionally unavailable for this provider. */
  unsupportedModes: ProviderMode[];
  /** Current mode selected by the provider's auto-detection or explicit override. */
  currentMode: ProviderMode;
  /** Mode the UI should select when creating new sessions. */
  defaultMode: ProviderMode;
}

export interface AIProviderDescriptor extends AIProviderModeMetadata {
  /** Provider registry key, e.g. "claude". */
  name: string;
  /** Human-readable provider label. */
  displayName: string;
  /** Standard prereq endpoint prefix, if the provider exposes one. */
  prereqApiPrefix?: string;
}

export interface AIModelInfo {
  /** Model identifier (e.g., "claude-sonnet-4-20250514") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Provider name */
  provider: string;
  /** Context window size in tokens */
  contextWindow: number;
  /** Maximum output tokens */
  maxOutputTokens: number;
  /** Whether the model supports vision/image input */
  supportsVision: boolean;
  /** Whether the model supports streaming responses */
  supportsStreaming: boolean;
  /** Price per million input tokens (USD) */
  inputPricePerMToken: number;
  /** Price per million output tokens (USD) */
  outputPricePerMToken: number;
}

export interface AIProviderCapabilities {
  /** Supports streaming responses */
  streaming: boolean;
  /** Supports vision/image input */
  vision: boolean;
  /** Supports file attachments as context */
  fileAttachments: boolean;
  /** Supports tool use / function calling */
  toolUse: boolean;
  /** Supports MCP server integration */
  mcpSupport: boolean;
  /** Supports voice mode */
  voiceMode: boolean;
  /** Supports cancelling in-progress requests */
  cancelSupport: boolean;
  /** Supports listing available models */
  modelListing: boolean;
}

export interface AIFileAttachment {
  /** File name */
  filename: string;
  /** MIME type */
  mimeType: string;
  /** File content (text or binary) */
  content: Buffer | string;
  /** File size in bytes */
  size: number;
}

// ── Provider Adapter Interface (for dual-mode SDK/CLI) ──────────────────

export interface ProviderAdapter {
  /** Send a prompt and return complete response */
  sendPrompt(
    sessionId: string,
    prompt: string,
    context?: AIContext[],
  ): Promise<AIResponse>;

  /** Send a prompt with streaming response (optional) */
  streamPrompt?(
    sessionId: string,
    prompt: string,
    context?: AIContext[],
    onChunk?: (chunk: AIStreamChunk) => void,
  ): Promise<AIResponse>;

  /** Cancel an in-progress request (optional) */
  cancelRequest?(sessionId: string): Promise<void>;

  /** Health check for the adapter */
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}

// ── Provider Interface ──────────────────────────────────────────────────

export interface AIAgentProvider {
  /** Provider name (e.g., "claude", "codex", "opencode") */
  readonly name: string;

  /**
   * Create a new AI session with the given configuration.
   * Returns the created session with its ID and initial status.
   */
  createSession(config: AISessionConfig): Promise<AISession>;

  /**
   * Send a prompt to an active AI session.
   * Returns the complete response after processing finishes.
   */
  sendPrompt(
    sessionId: string,
    prompt: string,
    context?: AIContext[],
  ): Promise<AIResponse>;

  /**
   * Send a prompt with streaming response.
   * Calls onChunk for each chunk received, returns the complete response.
   * Optional — falls back to sendPrompt if not implemented.
   */
  streamPrompt?(
    sessionId: string,
    prompt: string,
    context?: AIContext[],
    onChunk?: (chunk: AIStreamChunk) => void,
  ): Promise<AIResponse>;

  /**
   * Get logs for a session, optionally filtered.
   */
  getSessionLogs(sessionId: string, filter?: AILogFilter): Promise<AILog[]>;

  /**
   * Get usage statistics for a session.
   */
  getUsageStats(sessionId: string): Promise<AIUsageStats>;

  /**
   * Update session configuration (e.g., change model, temperature).
   */
  configureSession(
    sessionId: string,
    config: Partial<AISessionConfig>,
  ): Promise<void>;

  /**
   * Terminate and clean up an AI session.
   * Kills any spawned processes and frees resources.
   */
  destroySession(sessionId: string): Promise<void>;

  /**
   * List all sessions managed by this provider.
   */
  listSessions(): Promise<AISession[]>;

  /**
   * Get the current status of a specific session.
   */
  getSessionStatus(sessionId: string): Promise<AISessionStatus>;

  /**
   * Health check for the provider.
   * Verifies the underlying AI tool/SDK is available and functional.
   */
  healthCheck(): Promise<{ ok: boolean; message?: string }>;

  /**
   * List available models for this provider.
   * Optional — returns empty array if not implemented.
   */
  listModels?(): Promise<AIModelInfo[]>;

  /**
   * Cancel an in-progress request for a session.
   * Optional — not all providers support cancellation.
   */
  cancelRequest?(sessionId: string): Promise<void>;

  /**
   * Get provider capabilities (varies by active mode: sdk vs cli).
   * Optional — returns a default set if not implemented.
   */
  getCapabilities?(): AIProviderCapabilities;

  /**
   * Attach files to a session's context for use in subsequent prompts.
   * Optional — not all providers support file attachments.
   */
  attachFiles?(sessionId: string, files: AIFileAttachment[]): Promise<void>;

  /**
   * Get the current execution mode (sdk or cli).
   * Optional — defaults to "cli" if not implemented.
   */
  getMode?(): ProviderMode;

  /**
   * Modes this provider actually supports. Optional — defaults to current mode.
   */
  getSupportedModes?(): ProviderMode[];

  /**
   * Display label used by provider selectors.
   */
  getDisplayName?(): string;

  /**
   * Standard prereq endpoint prefix for this provider plugin.
   */
  getPrereqApiPrefix?(): string;

  /**
   * Set the execution mode (sdk or cli).
   * Optional — no-op if provider doesn't support dual mode.
   */
  setMode?(mode: ProviderMode): void;

  /**
   * CLI binary spec for `vibe ai run`.
   * Returns the binary name + base args + env to inherit, or `null` when
   * this provider has no CLI mode (e.g. SDK-only providers like openrouter).
   *
   * REQUIRED on every provider — return null instead of leaving the method
   * undefined so callers don't need to defensive-check existence.
   */
  getCliLaunchSpec(): {
    binary: string;
    baseArgs?: string[];
    env?: Record<string, string>;
  } | null;

  /**
   * One-shot non-interactive prompt via the provider's SDK adapter.
   * Most providers wire this to their existing `sendPrompt(...)` SDK path.
   *
   * REQUIRED on every provider — return a rejected promise instead of leaving
   * the method undefined so callers don't need to defensive-check existence.
   */
  sdkOneShot(opts: {
    prompt: string;
    model?: string;
    maxTokens?: number;
    extras?: Record<string, unknown>;
  }): Promise<{ text: string; usage?: unknown }>;
}
