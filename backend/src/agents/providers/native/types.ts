import type { SpawnOptionsWithoutStdio } from 'child_process';

// Defined here to avoid circular import with NativeCliAdapterProvider
export type NativeCliPermissionLevel = 'sandboxed' | 'elevated';
import type {
  AgentProviderName,
  AgentSessionConfig,
  AgentSendResult,
  OnChunkCallback,
  OnStatusCallback,
} from '../../AgentProvider.interface';
import type { NativeSessionData } from '../NativeSessionStore';

export interface NativeCliInvocation {
  command: string;
  args: string[];
  options?: SpawnOptionsWithoutStdio;
}

export interface NativeCliTurnContext {
  session: NativeSessionData;
  originalSessionId: string;
  message: string;
  onChunk?: OnChunkCallback;
  onStatus?: OnStatusCallback;
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
  updateSessionMetadata: (metadata: Record<string, unknown>) => void;
  rekeySession: (nextSessionId: string) => void;
  stripAnsi: (text: string) => string;
}

export interface NativeCliProviderAdapter {
  providerName: AgentProviderName;
  displayName: string;
  cliCommand: string;
  messageIdPrefix: string;
  initialStatus?: string | ((ctx: NativeCliTurnContext) => string);
  spawnErrorPrefix?: string;
  configureSession?: (userId: string, config?: AgentSessionConfig) => AgentSessionConfig | Promise<AgentSessionConfig>;
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
