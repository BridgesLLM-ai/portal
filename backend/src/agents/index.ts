/**
 * Agent abstraction layer — barrel export.
 */
export type {
  AgentProvider,
  AgentHarnessId,
  AgentProviderName,
  PersistedAgentProviderName,
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
export {
  AGENT_HARNESS_CATALOG,
  AGENT_HARNESS_IDS,
  REGISTERED_AGENT_HARNESS_IDS,
  getHarnessDefinition,
  isAgentHarnessId,
  isRegisteredAgentProviderName,
  requireHarnessDefinition,
} from './harnessCatalog';
export type {
  HarnessAdapterFamily,
  HarnessAuthDefinition,
  HarnessAuthOwner,
  HarnessCapabilities,
  HarnessCancellationMode,
  HarnessDefinition,
  HarnessFollowUpMode,
  HarnessHostStreamOwnership,
  HarnessModelCatalogKind,
  HarnessModelCatalogOwner,
  HarnessModelDefinition,
  HarnessModelSelectionMode,
  HarnessReleaseStage,
  HarnessRuntimeCommand,
  HarnessTransport,
  LegacyProviderAdapterFamily,
  HarnessVersionPolicy,
  HarnessVersionPolicyKind,
} from './harnessCatalog';
