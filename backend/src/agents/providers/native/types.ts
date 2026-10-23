import type { SpawnOptionsWithoutStdio } from 'child_process';
import path from 'path';
import type {
  AgentProviderName,
  AgentSessionConfig,
  AgentSendResult,
  OnChunkCallback,
  OnExecApprovalCallback,
  OnStatusCallback,
} from '../../AgentProvider.interface';
import type { NativeCliApprovalDecision, NativeCliApprovalDraft } from '../../nativeCliApprovals';
import type { NativeSessionData } from '../NativeSessionStore';
import type { ChatBridgeTurn } from '../../chatBridge/contract';
import type { NativeChatImage } from '../../../services/chatImages/directChatImages';

const NATIVE_HOST_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const NATIVE_HOST_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/;
const CLAUDE_HOST_TOOL_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const NATIVE_HOST_PROMPT_MAX_BYTES = 256 * 1024;
const MAX_CLAUDE_HOST_TOOLS = 32;
const MAX_CLAUDE_HOST_DIRECTORIES = 16;
const MAX_CLAUDE_HOST_DIRECTORY_BYTES = 4 * 1024;

export function validateNativeHostPrompt(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') < 1
    || Buffer.byteLength(value, 'utf8') > NATIVE_HOST_PROMPT_MAX_BYTES
  ) {
    throw new Error('Native host CLI prompt is invalid');
  }
  return value;
}

export function validateNativeHostModel(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !NATIVE_HOST_MODEL_PATTERN.test(value)) {
    throw new Error('Native host CLI model is invalid');
  }
  return value;
}

export function validateNativeHostSessionId(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error('Native host CLI session identity is required');
    return null;
  }
  if (typeof value !== 'string' || !NATIVE_HOST_SESSION_ID_PATTERN.test(value)) {
    throw new Error('Native host CLI session identity is invalid');
  }
  return value;
}

export function validateClaudeHostGrants(
  allowedToolInput: unknown,
  addDirectoryInput: unknown,
): { allowedTools: string[]; addDirs: string[] } {
  const allowedTools = Array.isArray(allowedToolInput) ? allowedToolInput : [];
  const addDirs = Array.isArray(addDirectoryInput) ? addDirectoryInput : [];
  if (allowedTools.length > MAX_CLAUDE_HOST_TOOLS) {
    throw new Error('Native Claude allowed-tool grants are invalid');
  }
  if (addDirs.length > MAX_CLAUDE_HOST_DIRECTORIES) {
    throw new Error('Native Claude add-directory grants are invalid');
  }
  const normalizedTools = allowedTools.map((entry) => {
    if (typeof entry !== 'string' || !CLAUDE_HOST_TOOL_PATTERN.test(entry)) {
      throw new Error('Native Claude allowed-tool grant is invalid');
    }
    return entry;
  });
  const normalizedDirs = addDirs.map((entry) => {
    if (
      typeof entry !== 'string'
      || entry.includes('\0')
      || entry.includes('\n')
      || entry.includes('\r')
      || Buffer.byteLength(entry, 'utf8') < 1
      || Buffer.byteLength(entry, 'utf8') > MAX_CLAUDE_HOST_DIRECTORY_BYTES
      || !path.posix.isAbsolute(entry)
      || path.posix.normalize(entry) !== entry
      || entry === '/'
    ) {
      throw new Error('Native Claude add-directory grant is invalid');
    }
    return entry;
  });
  if (
    new Set(normalizedTools).size !== normalizedTools.length
    || new Set(normalizedDirs).size !== normalizedDirs.length
  ) {
    throw new Error('Native Claude grants contain duplicates');
  }
  return {
    allowedTools: [...normalizedTools].sort(),
    addDirs: [...normalizedDirs].sort(),
  };
}

export interface NativeCliInvocation {
  command: string;
  args: string[];
  /**
   * Sensitive provider input that must cross an anonymous stdin pipe. Host
   * runs deliver it through the authenticated activation socket so it never
   * appears in systemd-run, wrapper, or target argv/environment.
   */
  stdinText?: string;
  options?: SpawnOptionsWithoutStdio;
  /**
   * Optional provider-owned hard-abort boundary. Project runtimes use this to
   * terminate the process inside the confined container; killing the local
   * `docker exec` client alone is not authoritative.
   */
  abort?: () => Promise<void | boolean>;
}

export interface NativeCliTurnContext {
  session: NativeSessionData;
  originalSessionId: string;
  message: string;
  onChunk?: OnChunkCallback;
  onStatus?: OnStatusCallback;
  onExecApproval?: OnExecApprovalCallback;
  fullText: string;
  lastAssistantMessage: string;
  stderr: string;
  exitCode: number | null;
  state: Record<string, any>;
  emitChunk: (chunk: string) => void;
  emitStatus: (content: string, extra?: Record<string, unknown>) => void;
  setFullText: (text: string) => void;
  appendFullText: (text: string) => void;
  setLastAssistantMessage: (text: string) => void;
  appendStderr: (text: string) => void;
  requestApproval: (approval: Omit<NativeCliApprovalDraft, 'providerName' | 'sessionId' | 'cwd'> & { cwd?: string }) => Promise<NativeCliApprovalDecision>;
  updateSessionMetadata: (metadata: Record<string, unknown>) => void;
  stripAnsi: (text: string) => string;
  /**
   * Portal Chat Bridge capability for this logical turn (HOST_OPERATOR only),
   * shared by every attempt including approval retries. Null runs the harness
   * exactly as before, without Portal chat tools.
   */
  chatBridge?: ChatBridgeTurn | null;
  /** Server-prepared photos for this turn; empty unless the gateway admitted them. */
  chatImages?: readonly NativeChatImage[];
  /**
   * Write this turn's photos as root-only files for harnesses that take image
   * paths. The provider removes them on every settlement path.
   */
  materializeChatImageFiles?: () => string[];
}

export interface NativeCliProviderAdapter {
  providerName: AgentProviderName;
  displayName: string;
  cliCommand: string;
  messageIdPrefix: string;
  initialStatus?: string | ((ctx: NativeCliTurnContext) => string);
  spawnErrorPrefix?: string;
  /**
   * Nonzero process exit codes that the adapter explicitly attests still
   * represent a complete successful turn. All other nonzero exits fail closed,
   * even when the CLI emitted partial assistant text before exiting.
   */
  acceptedExitCodes?: readonly number[];
  configureSession?: (userId: string, config: AgentSessionConfig) => AgentSessionConfig | Promise<AgentSessionConfig>;
  /** The adapter wires the Portal Chat Bridge into HOST_OPERATOR invocations. */
  supportsChatBridge?: boolean;
  /** The adapter forwards server-prepared photos as native image input. */
  supportsChatImages?: boolean;
  /**
   * The harness restarts its tool-call ids every turn (Codex `item_N`). The
   * provider then scopes every emitted id to the run so persisted tool cards
   * and per-session widget bindings never collide across turns.
   */
  scopeToolCallIds?: boolean;
  /**
   * Resolve the session's effective model and prove from harness-advertised
   * metadata (never a model-name guess) that it accepts image input. Throws a
   * ChatImageError when it does not. Returns the model identity checked.
   */
  assertChatImageModel?: (session: NativeSessionData) => Promise<string>;
  /**
   * Deterministic host stdin encoding of this turn's prompt (and photos).
   * Host invocations must place exactly this on stdin; the provider recomputes
   * it and refuses anything else. Defaults to the prompt text itself.
   */
  encodeHostStdin?: (ctx: NativeCliTurnContext) => string;
  buildInvocation: (ctx: NativeCliTurnContext) => NativeCliInvocation | Promise<NativeCliInvocation>;
  handleStdoutLine: (line: string, ctx: NativeCliTurnContext) => void;
  handleStdoutRemainder?: (text: string, ctx: NativeCliTurnContext) => void;
  handleStderrChunk?: (chunk: string, ctx: NativeCliTurnContext) => void;
  finalizeTurn?: (ctx: NativeCliTurnContext) => void | Promise<void>;
  getResultText?: (ctx: NativeCliTurnContext) => string;
  getResultMetadata?: (ctx: NativeCliTurnContext) => Record<string, unknown>;
  getErrorMessage?: (ctx: NativeCliTurnContext) => string;
  transformResult?: (ctx: NativeCliTurnContext) => AgentSendResult | Promise<AgentSendResult>;
}
