/**
 * Agent Provider Interface
 *
 * Defines the contract every agent backend (OpenClaw, Claude Code, Codex, etc.)
 * must satisfy so the portal can treat them uniformly.
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** Provider identifiers — kept in sync with the Prisma AgentProviderType enum. */
export type AgentProviderName = 'OPENCLAW' | 'CLAUDE_CODE' | 'CODEX' | 'AGENT_ZERO' | 'GEMINI' | 'OLLAMA';

/** Opaque session handle returned by startSession. */
export type AgentSessionId = string;

/** Configuration passed when starting a new agent session. */
export interface AgentSessionConfig {
  /** Model override, e.g. "anthropic/claude-haiku-4-5" */
  model?: string;
  /** Free-form provider-specific options */
  metadata?: Record<string, unknown>;
}

/** A single chat message (input or output). */
export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string; // ISO-8601
}

/** Callback invoked for each incremental text chunk during streaming. */
export type OnChunkCallback = (chunk: string) => void;

/** Callback for real-time status/events (thinking, tool use, approvals, etc.) */
export type OnStatusCallback = (event: { type: string; content?: string; [key: string]: any }) => void;

/** Callback for exec approval requests from the agent. */
export type OnExecApprovalCallback = (approval: any) => void;

/** Identifies the authenticated human sender for this message. */
export interface SenderIdentity {
  /** Human-readable label shown in agent context (e.g. "robert@example.com") */
  label: string;
  /** Stable user ID from the auth system */
  userId: string;
}

/** Result returned after a (possibly streamed) sendMessage completes. */
export interface AgentSendResult {
  /** The full assembled response text. */
  fullText: string;
  /** Provider-specific metadata (token counts, model used, etc.) */
  metadata?: Record<string, unknown>;
}

/** Summary of one agent session, returned by listSessions. */
export interface AgentSessionSummary {
  sessionId: AgentSessionId;
  status: 'active' | 'terminated' | 'error';
  createdAt: string;
  lastActivityAt: string;
  title?: string;
  preview?: string;
  metadata?: Record<string, unknown>;
}

// ── Interface ───────────────────────────────────────────────────────────────

export interface AgentProvider {
  /** Human-readable name shown in UI. */
  readonly displayName: string;

  /** Machine identifier matching the Prisma enum. */
  readonly providerName: AgentProviderName;

  /**
   * Start a new conversational session.
   * @returns External session identifier managed by the provider.
   */
  startSession(userId: string, config?: AgentSessionConfig): Promise<AgentSessionId>;

  /**
   * Send a user message and stream the response back.
   * The provider MUST call `onChunk` for each incremental piece of text,
   * and resolve the promise with the complete result once finished.
   * Optionally call `onStatus` for real-time lifecycle events (thinking, tool use).
   */
  sendMessage(
    sessionId: AgentSessionId,
    message: string,
    onChunk?: OnChunkCallback,
    onStatus?: OnStatusCallback,
    onExecApproval?: OnExecApprovalCallback,
    sender?: SenderIdentity,
  ): Promise<AgentSendResult>;

  /**
   * Retrieve the message history for a session.
   */
  getHistory(sessionId: AgentSessionId): Promise<AgentMessage[]>;

  /**
   * List all sessions owned by a user.
   */
  listSessions(userId: string): Promise<AgentSessionSummary[]>;

  /**
   * Tear down a session and release resources.
   */
  terminateSession(sessionId: AgentSessionId): Promise<void>;
}
