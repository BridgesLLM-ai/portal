/**
 * Agent abstraction layer — barrel export.
 */
export type {
  AgentProvider,
  AgentProviderName,
  AgentSessionId,
  AgentSessionConfig,
  AgentExecutionScope,
  AgentExecutionContext,
  HostOperatorExecutionContext,
  ProjectSandboxExecutionContext,
  AgentMessage,
  AgentSendResult,
  AgentSessionModelResult,
  AgentSessionSummary,
  OnChunkCallback,
  OnStatusCallback,
} from './AgentProvider.interface';

export { AgentRegistry } from './AgentRegistry';
