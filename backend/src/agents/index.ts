/**
 * Agent abstraction layer — barrel export.
 */
export type {
  AgentProvider,
  AgentProviderName,
  AgentSessionId,
  AgentSessionConfig,
  AgentMessage,
  AgentSendResult,
  AgentSessionSummary,
  OnChunkCallback,
  OnStatusCallback,
} from './AgentProvider.interface';

export { AgentRegistry } from './AgentRegistry';
