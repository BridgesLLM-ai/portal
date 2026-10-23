import type { AgentProviderName } from '../AgentProvider.interface';

/**
 * Portal Chat Bridge contract.
 *
 * The bridge gives every MCP-capable Agent Chat harness the same Portal-owned
 * chat capabilities OpenClaw already has natively: questions answered in the
 * Portal and sandboxed inline widgets. One stdio MCP server, launched by the
 * harness itself, talks to the backend over a root-only Unix socket with a
 * per-turn capability token. Authority comes from that token's server-side
 * binding, never from a tool name: a harness tool that merely calls itself
 * `show_widget` cannot mint a widget or a question.
 */

/** MCP server name every harness registers. Harness tool names derive from it
 * (Claude Code `mcp__bridgesllm__ask_user`, Codex `server: "bridgesllm"`). */
export const CHAT_BRIDGE_SERVER_NAME = 'bridgesllm';

/** Canonical Portal tool names the frontend renders. */
export const CHAT_BRIDGE_TOOL_NAMES = ['ask_user', 'show_widget', 'get_goal', 'update_goal'] as const;
export type ChatBridgeToolName = typeof CHAT_BRIDGE_TOOL_NAMES[number];

/** Environment carried to the MCP server process. Never place these in argv. */
export const CHAT_BRIDGE_ENV = Object.freeze({
  socket: 'BRIDGESLLM_CHAT_BRIDGE_SOCKET',
  token: 'BRIDGESLLM_CHAT_BRIDGE_TOKEN',
} as const);

export const CHAT_BRIDGE_RUNTIME_ROOT = '/run/bridgesllm/chat-bridge';
export const CHAT_BRIDGE_SOCKET_NAME = 'bridge.sock';

/** Longest a harness should wait on one bridge tool call (a question can take minutes). */
export const CHAT_BRIDGE_TOOL_TIMEOUT_MS = 15 * 60_000;
/** Server-side ceiling for one question; the broker expires it after this. */
export const CHAT_BRIDGE_QUESTION_WAIT_MS = 14 * 60_000;

export const CHAT_BRIDGE_WIDGET_MAX_BYTES = 2 * 1024 * 1024;
export const CHAT_BRIDGE_WIDGET_TITLE_MAX = 160;
export const CHAT_BRIDGE_WIDGETS_PER_SESSION_MAX = 200;
/** Loop guards: a single turn cannot flood the conversation. */
export const CHAT_BRIDGE_WIDGETS_PER_TURN_MAX = 25;
export const CHAT_BRIDGE_OPEN_QUESTIONS_PER_TURN_MAX = 4;

/** The exact server-attested turn a capability belongs to. */
export interface ChatBridgeTurnBinding {
  readonly provider: AgentProviderName;
  readonly portalSessionId: string;
  readonly runId: string;
  readonly userId: string;
  readonly authorizationVersion: number;
}

/** How a harness launches the bridge MCP server for one turn. */
export interface ChatBridgeMcpLaunch {
  readonly serverName: typeof CHAT_BRIDGE_SERVER_NAME;
  /** Absolute interpreter path (the Portal's own Node). */
  readonly command: string;
  /** Absolute compiled server path. */
  readonly args: readonly string[];
  /** Secret-bearing environment. Deliver through process env or a JSON-RPC
   * field, never argv or a world-readable file. */
  readonly env: Readonly<Record<string, string>>;
  readonly toolTimeoutMs: number;
}

/** Result of normalizing a harness-reported bridge tool call. */
export interface ChatBridgeToolIdentity {
  readonly name: ChatBridgeToolName;
}

export interface ChatBridgeTurn {
  readonly binding: ChatBridgeTurnBinding;
  readonly launch: ChatBridgeMcpLaunch;
  /**
   * Identify a bridge tool from what a harness reports. `server` is the MCP
   * server name when the harness reports it separately (Codex mcp_tool_call).
   * Returns null for anything that is not unambiguously this bridge's tool.
   * Naming only selects presentation; authority is checked by bindWidgetResult
   * and by the question registry.
   */
  identifyTool(rawName: string, server?: string | null): ChatBridgeToolIdentity | null;
  /**
   * Turn a completed bridge show_widget result into the canonical
   * `bridgesllm.widget-ref.v1` reference for `toolCallId` and record the
   * server-side binding. Returns null when the result does not carry a widget
   * minted by this turn (forged, foreign, revoked or malformed).
   */
  bindWidgetResult(toolCallId: string, rawResult: unknown): string | null;
  /**
   * In-process invocation for harnesses whose tool loop the Portal runs itself
   * (Ollama). Same authority checks as the MCP path. A widget result still has
   * to be bound with bindWidgetResult under the caller's own tool-call id.
   */
  call(name: ChatBridgeToolName, args: unknown, signal?: AbortSignal): Promise<{ text: string; isError: boolean }>;
  /** Revoke the token, cancel this run's open questions and drop unbound widgets. */
  revoke(): void;
}

/** Bounded tool-call record persisted on native assistant messages. */
export interface NativePersistedToolCall {
  readonly id: string;
  readonly name: string;
  readonly status: 'done' | 'error';
  readonly arguments?: unknown;
  readonly result?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export const NATIVE_TOOL_CALLS_PER_MESSAGE_MAX = 100;
export const NATIVE_TOOL_CALL_ARGUMENTS_MAX_BYTES = 8 * 1024;
export const NATIVE_TOOL_CALL_RESULT_MAX_BYTES = 16 * 1024;
export const NATIVE_TOOL_CALLS_MESSAGE_MAX_BYTES = 384 * 1024;
