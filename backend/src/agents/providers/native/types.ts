import type { SpawnOptionsWithoutStdio } from 'child_process';
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

export interface NativeCliInvocation {
  command: string;
  args: string[];
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
