/**
 * Agent Provider Interface
 *
 * Defines the contract every agent backend (OpenClaw, Claude Code, Codex, etc.)
 * must satisfy so the portal can treat them uniformly.
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** Provider identifiers — kept in sync with the Prisma AgentProviderType enum. */
export type AgentProviderName = 'OPENCLAW' | 'CLAUDE_CODE' | 'CODEX' | 'GROK' | 'AGENT_ZERO' | 'GEMINI' | 'OLLAMA';

/** Opaque session handle returned by startSession. */
export type AgentSessionId = string;

/**
 * Server-owned execution trust zones. These are authorization boundaries, not
 * UI hints: Agent Chat runs as a host operator, while Project Chat must remain
 * inside its project sandbox.
 */
export type AgentExecutionScope = 'HOST_OPERATOR' | 'PROJECT_SANDBOX';

interface AgentExecutionContextBase {
  readonly scope: AgentExecutionScope;
  readonly source: 'PORTAL_SERVER';
  readonly userId: string;
}

export interface HostOperatorExecutionContext extends AgentExecutionContextBase {
  readonly scope: 'HOST_OPERATOR';
}

export interface ProjectSandboxExecutionContext extends AgentExecutionContextBase {
  readonly scope: 'PROJECT_SANDBOX';
  /** Immutable server-owned ProjectIdentity UUID, never a user-controlled name. */
  readonly projectId: string;
  /** Workspace owner may differ from the authenticated actor for elevated shared workspaces. */
  readonly workspaceOwnerId: string;
  readonly projectName: string;
  readonly canonicalRoot: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly rootBirthtimeNs: string;
  readonly runtimePolicyVersion: string;
  readonly egressPolicyVersion: string;
  readonly runtimeImageDigest: string;
  readonly policyFingerprint: string;
}

export type AgentExecutionContext = HostOperatorExecutionContext | ProjectSandboxExecutionContext;

/** Configuration passed when starting a new agent session. */
export interface AgentSessionConfig {
  /** Immutable, server-assigned execution boundary for this session. */
  readonly executionContext: AgentExecutionContext;
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
  /** Portal role, when available, for provider-side approval gating. */
  role?: string;
  /** Exact server-attested authorization generation admitted for this turn. */
  authorizationVersion?: number;
  /** Server-owned idempotency identity for a durable provider turn. */
  requestId?: string;
  /**
   * Browser message identity attested by the Portal route. Providers may use
   * this only for delivery-mirror deduplication; requestId remains the
   * server-owned host-run/journal identity.
   */
  clientMessageId?: string;
  /**
   * Internal server callback invoked immediately after the provider accepts
   * the external dispatch. Provider code must await it before exposing any
   * successful send settlement.
   */
  onProviderDispatchAccepted?(upstreamRunId: string): Promise<void>;
}

/** Result returned after a (possibly streamed) sendMessage completes. */
export interface AgentSendResult {
  /** The full assembled response text. */
  fullText: string;
  /** Provider-specific metadata (token counts, model used, etc.) */
  metadata?: Record<string, unknown>;
}

/** Authoritative result of changing (or clearing) a live session model. */
export interface AgentSessionModelResult {
  /** Canonical provider model/preset stored for the session; null means default. */
  model: string | null;
  metadata?: Record<string, unknown>;
}

export class AgentAbortError extends Error {
  constructor(message = 'Request cancelled') {
    super(message);
    this.name = 'AgentAbortError';
  }
}

/**
 * Extra scoping for `listSessions`. Only the OpenClaw provider reads these;
 * other providers own their own session inventory and ignore them.
 */
export interface ListOpenClawSessionsOptions {
  /**
   * Include sessions created outside the Portal on this host (OpenClaw web UI,
   * CLI, `dashboard:` lanes). Callers must set this only for the Portal OWNER,
   * who is the host operator. Sessions scoped to another Portal user stay
   * hidden regardless.
   */
  includeHostSessions?: boolean;
  /** Agents to sweep for host sessions — normally the Agent Chat selector set. */
  hostAgentIds?: readonly string[];
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

/** Exact immutable identity supplied only after a Project cleanup adapter has
 * removed and re-attested the provider-owned external runtime boundary. */
export interface AttestedProjectRuntimeCleanup {
  readonly userId: string;
  readonly projectId: string;
  readonly canonicalRoot: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly rootBirthtimeNs: string;
  readonly sessionIds: readonly string[];
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
  startSession(userId: string, config: AgentSessionConfig): Promise<AgentSessionId>;

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
  listSessions(
    userId: string,
    options?: ListOpenClawSessionsOptions,
  ): Promise<AgentSessionSummary[]>;

  /**
   * Tear down a session and release resources.
   */
  terminateSession(sessionId: AgentSessionId): Promise<void>;

  /**
   * Apply a model change to an already-created provider session. Implementations
   * must not resolve until the provider runtime and Portal's durable session
   * record agree. A null model deliberately clears the session override.
   */
  setSessionModel?(
    sessionId: AgentSessionId,
    model: string | null,
  ): Promise<AgentSessionModelResult>;

  /**
   * Abort an in-flight run if the provider supports it.
   * When supplied, runId is an optimistic-concurrency guard: providers must
   * leave a newer run untouched when the identifier does not match.
   */
  abortActiveRun?(sessionId: AgentSessionId, runId?: string): Promise<boolean>;

  /** Retire process-local Project reservations only after an external cleanup
   * adapter has proved exact runtime absence. Implementations must reject a
   * newer or differently-bound in-memory operation. */
  convergeAttestedProjectCleanup?(input: AttestedProjectRuntimeCleanup): Promise<void>;
}
