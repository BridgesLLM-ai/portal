import { PORTAL_TOOL_VERSIONS } from '../config/toolVersions';
import { AGENT_ZERO_VERSION } from './providers/agentZero/AgentZeroConnectorContract';
import type {
  AgentExecutionScope,
  AgentHarnessId,
  AgentProviderName,
} from './AgentProvider.interface';

export type HarnessTransport =
  | 'gateway'
  | 'native-cli'
  | 'acp-stdio'
  | 'json-rpc-stdio'
  | 'connector';

export type HarnessAuthOwner =
  | 'model-provider-account'
  | 'harness-local-login'
  | 'none';

export type HarnessModelCatalogOwner =
  | 'portal-declared'
  | 'harness'
  | 'model-provider-account'
  | 'local-runtime'
  | 'none';

export type HarnessModelSelectionMode = 'none' | 'session' | 'launch' | 'prompt-command';
export type HarnessModelCatalogKind = 'none' | 'dynamic' | 'declared';
export type HarnessFollowUpMode = 'interrupt_and_send' | 'queued_follow_up';
export type HarnessCancellationMode = 'none' | 'protocol' | 'process-kill';
/**
 * Legacy `/providers` grouping retained only for compatibility consumers.
 * It is not a transport identity; HarnessDefinition.transport is authoritative.
 */
export type LegacyProviderAdapterFamily = 'openclaw-gateway' | 'native-cli' | 'agent-zero-connector';
/** @deprecated Use HarnessTransport, or LegacyProviderAdapterFamily for old provider payloads. */
export type HarnessAdapterFamily = LegacyProviderAdapterFamily;
export type HarnessReleaseStage = 'stable' | 'planned' | 'developer-preview';
export type HarnessVersionPolicyKind = 'unmanaged' | 'soft-pin' | 'exact-pin' | 'blocked-until-pinned';
export type HarnessHostStreamOwnership = 'provider' | 'route' | 'none';

export interface HarnessVersionPolicy {
  readonly kind: HarnessVersionPolicyKind;
  readonly testedVersion?: string;
  readonly reason?: string;
}

/**
 * Descriptive launch metadata only. It is never interpreted as an executable
 * adapter factory: concrete process creation remains trusted provider code.
 */
export interface HarnessRuntimeCommand {
  readonly executable: string | null;
  readonly args: readonly string[];
  readonly versionArgs: readonly string[];
  readonly versionPolicy: HarnessVersionPolicy;
}

export interface HarnessAuthDefinition {
  readonly owner: HarnessAuthOwner;
  readonly requiresSeparateLogin: boolean;
  /** Known model-provider account ids; an empty list means runtime-configured. */
  readonly modelProviderIds: readonly string[];
}

export interface HarnessModelDefinition {
  readonly catalogOwner: HarnessModelCatalogOwner;
  readonly catalogKind: HarnessModelCatalogKind;
  readonly selectionMode: HarnessModelSelectionMode;
  readonly canEnumerate: boolean;
  readonly supportsCustomInput: boolean;
}

/** Capabilities of the selected transport, separately gated by implemented/selectable. */
export interface HarnessCapabilities {
  readonly implemented: boolean;
  readonly requiresGateway: boolean;
  /** Legacy provider-payload grouping; never use it to choose a transport. */
  readonly adapterFamily: LegacyProviderAdapterFamily;
  readonly adapterKey: string;
  readonly supportsNewSession: boolean;
  readonly supportsHistory: boolean;
  readonly supportsSessionClose: boolean;
  readonly supportsModelSelection: boolean;
  readonly supportsModelReadback: boolean;
  readonly modelSelectionMode: HarnessModelSelectionMode;
  readonly supportsCustomModelInput: boolean;
  readonly canEnumerateModels: boolean;
  readonly modelCatalogKind: HarnessModelCatalogKind;
  readonly supportsSessionList: boolean;
  readonly supportsSessionResume: boolean;
  readonly supportsSessionFork: boolean;
  readonly supportsLiveText: boolean;
  readonly supportsReasoning: boolean;
  readonly supportsAskUser: boolean;
  readonly supportsAttachments: boolean;
  readonly supportsCancellation: boolean;
  readonly cancellationMode: HarnessCancellationMode;
  readonly supportsExecApproval: boolean;
  readonly supportsInTurnSteering: boolean;
  readonly supportsLiveToolEvents: boolean;
  readonly supportsQueuedFollowUps: boolean;
  readonly followUpMode: HarnessFollowUpMode;
  /** True only when one prompt has a protocol-owned terminal result. */
  readonly supportsPromptCausalCompletion: boolean;
  /** True only when a fresh broker/process can resume prior native context. */
  readonly supportsProcessRestartResume: boolean;
  /**
   * Trust zones supported by the harness as a product capability. Individual
   * transport adapters may intentionally accept only a subset: Agent Zero and
   * Ollama use separate, confined Project providers instead of their host adapters.
   */
  readonly supportedExecutionScopes: readonly AgentExecutionScope[];
}

export interface HarnessDefinition {
  readonly id: AgentHarnessId;
  readonly displayName: string;
  readonly transport: HarnessTransport;
  /** Preserves the established registry meaning: direct host runtime vs gateway/connector. */
  readonly native: boolean;
  readonly implemented: boolean;
  readonly selectable: boolean;
  readonly releaseStage: HarnessReleaseStage;
  /** User-visible, server-attested provenance for turns from this harness. */
  readonly provenanceLabel: string;
  /** Which trusted layer publishes the canonical Host Operator stream. */
  readonly hostStreamOwnership: HarnessHostStreamOwnership;
  /** Existing Prisma/API/local-storage `provider` value, or null until persistence is added. */
  readonly compatibilityProviderId: AgentProviderName | null;
  readonly command: HarnessRuntimeCommand;
  readonly auth: HarnessAuthDefinition;
  readonly models: HarnessModelDefinition;
  readonly capabilities: HarnessCapabilities;
  readonly documentationUrl?: string;
  readonly unavailableReason?: string;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function capabilities(input: Omit<HarnessCapabilities,
  | 'implemented'
  | 'requiresGateway'
  | 'adapterFamily'
  | 'adapterKey'
  | 'supportsModelSelection'
  | 'modelSelectionMode'
  | 'supportsCustomModelInput'
  | 'canEnumerateModels'
  | 'modelCatalogKind'
>, metadata: {
  implemented: boolean;
  requiresGateway: boolean;
  adapterFamily: LegacyProviderAdapterFamily;
  adapterKey: string;
  models: HarnessModelDefinition;
}): HarnessCapabilities {
  return {
    implemented: metadata.implemented,
    requiresGateway: metadata.requiresGateway,
    adapterFamily: metadata.adapterFamily,
    adapterKey: metadata.adapterKey,
    // `prompt-command` is descriptive runtime support, not a conventional
    // Portal model-control API and must not enable the existing picker.
    supportsModelSelection: metadata.models.selectionMode === 'session'
      || metadata.models.selectionMode === 'launch',
    modelSelectionMode: metadata.models.selectionMode,
    supportsCustomModelInput: metadata.models.supportsCustomInput,
    canEnumerateModels: metadata.models.canEnumerate,
    modelCatalogKind: metadata.models.catalogKind,
    ...input,
  };
}

const HOST_ONLY = ['HOST_OPERATOR'] as const;
const HOST_AND_PROJECT = ['HOST_OPERATOR', 'PROJECT_SANDBOX'] as const;

const OPENCLAW_MODELS: HarnessModelDefinition = {
  catalogOwner: 'harness',
  catalogKind: 'dynamic',
  selectionMode: 'session',
  canEnumerate: true,
  supportsCustomInput: true,
};
const CLAUDE_MODELS: HarnessModelDefinition = {
  catalogOwner: 'portal-declared',
  catalogKind: 'declared',
  selectionMode: 'session',
  canEnumerate: true,
  supportsCustomInput: false,
};
const CODEX_MODELS: HarnessModelDefinition = {
  catalogOwner: 'portal-declared',
  catalogKind: 'declared',
  selectionMode: 'session',
  canEnumerate: true,
  supportsCustomInput: true,
};
const GROK_MODELS: HarnessModelDefinition = {
  catalogOwner: 'harness',
  catalogKind: 'dynamic',
  selectionMode: 'session',
  canEnumerate: true,
  supportsCustomInput: true,
};
const GEMINI_MODELS: HarnessModelDefinition = {
  catalogOwner: 'harness',
  catalogKind: 'dynamic',
  selectionMode: 'launch',
  canEnumerate: true,
  supportsCustomInput: true,
};

const AGENT_ZERO_MODELS: HarnessModelDefinition = {
  catalogOwner: 'model-provider-account',
  catalogKind: 'dynamic',
  selectionMode: 'session',
  canEnumerate: true,
  supportsCustomInput: false,
};
const OLLAMA_MODELS: HarnessModelDefinition = {
  catalogOwner: 'local-runtime',
  catalogKind: 'dynamic',
  selectionMode: 'launch',
  canEnumerate: true,
  supportsCustomInput: true,
};
const HERMES_MODELS: HarnessModelDefinition = {
  catalogOwner: 'harness',
  catalogKind: 'dynamic',
  // Hermes v2026.8.18 exposes dynamic SessionModelState plus the standard ACP
  // session/set_model method. `/model` remains an optional command, not the
  // Portal control path.
  selectionMode: 'session',
  canEnumerate: true,
  supportsCustomInput: false,
};
const OPENCODE_MODELS: HarnessModelDefinition = {
  catalogOwner: 'harness',
  catalogKind: 'dynamic',
  selectionMode: 'session',
  canEnumerate: true,
  supportsCustomInput: false,
};
const DEEPSEEK_HARNESS_MODELS: HarnessModelDefinition = {
  catalogOwner: 'model-provider-account',
  catalogKind: 'declared',
  // The SDK route fixes provider/model during process initialize. Changing it
  // requires a deliberate fresh runtime, never model-prefix rerouting.
  selectionMode: 'launch',
  canEnumerate: false,
  supportsCustomInput: false,
};

const definitions: HarnessDefinition[] = [
  {
    id: 'OPENCLAW',
    displayName: 'OpenClaw',
    transport: 'gateway',
    native: false,
    implemented: true,
    selectable: true,
    releaseStage: 'stable',
    provenanceLabel: 'via OpenClaw',
    hostStreamOwnership: 'provider',
    compatibilityProviderId: 'OPENCLAW',
    command: {
      executable: 'openclaw',
      args: [],
      versionArgs: ['--version'],
      versionPolicy: { kind: 'exact-pin', testedVersion: PORTAL_TOOL_VERSIONS.openClaw },
    },
    auth: {
      owner: 'model-provider-account',
      requiresSeparateLogin: false,
      modelProviderIds: [],
    },
    models: OPENCLAW_MODELS,
    capabilities: capabilities({
      supportsNewSession: true,
      supportsHistory: true,
      supportsSessionClose: true,
      supportsModelReadback: true,
      supportsSessionList: true,
      supportsSessionResume: true,
      supportsSessionFork: false,
      supportsLiveText: true,
      supportsReasoning: true,
      supportsAskUser: true,
      supportsAttachments: true,
      supportsCancellation: true,
      cancellationMode: 'protocol',
      supportsExecApproval: false,
      supportsInTurnSteering: true,
      supportsLiveToolEvents: true,
      supportsQueuedFollowUps: false,
      followUpMode: 'interrupt_and_send',
      supportsPromptCausalCompletion: true,
      supportsProcessRestartResume: true,
      supportedExecutionScopes: HOST_AND_PROJECT,
    }, {
      implemented: true,
      requiresGateway: true,
      adapterFamily: 'openclaw-gateway',
      adapterKey: 'openclaw',
      models: OPENCLAW_MODELS,
    }),
  },
  {
    id: 'CLAUDE_CODE',
    displayName: 'Claude Code',
    transport: 'native-cli',
    native: true,
    implemented: true,
    selectable: true,
    releaseStage: 'stable',
    provenanceLabel: 'via Claude CLI',
    hostStreamOwnership: 'provider',
    compatibilityProviderId: 'CLAUDE_CODE',
    command: {
      executable: 'claude',
      args: ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'],
      versionArgs: ['--version'],
      versionPolicy: { kind: 'soft-pin', testedVersion: PORTAL_TOOL_VERSIONS.claudeCode },
    },
    auth: {
      owner: 'harness-local-login',
      requiresSeparateLogin: true,
      modelProviderIds: ['anthropic'],
    },
    models: CLAUDE_MODELS,
    capabilities: capabilities({
      supportsNewSession: true,
      supportsHistory: true,
      supportsSessionClose: true,
      supportsModelReadback: true,
      supportsSessionList: true,
      supportsSessionResume: true,
      supportsSessionFork: false,
      supportsLiveText: true,
      supportsReasoning: true,
      supportsAskUser: false,
      supportsAttachments: true,
      supportsCancellation: true,
      cancellationMode: 'process-kill',
      supportsExecApproval: true,
      supportsInTurnSteering: false,
      supportsLiveToolEvents: true,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',
      supportsPromptCausalCompletion: true,
      supportsProcessRestartResume: true,
      supportedExecutionScopes: HOST_AND_PROJECT,
    }, {
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'native-cli',
      adapterKey: 'claude-code',
      models: CLAUDE_MODELS,
    }),
  },
  {
    id: 'CODEX',
    displayName: 'Codex',
    transport: 'native-cli',
    native: true,
    implemented: true,
    selectable: true,
    releaseStage: 'stable',
    provenanceLabel: 'via Codex CLI',
    hostStreamOwnership: 'provider',
    compatibilityProviderId: 'CODEX',
    command: {
      executable: 'codex',
      args: ['exec', '--json'],
      versionArgs: ['--version'],
      versionPolicy: { kind: 'soft-pin', testedVersion: PORTAL_TOOL_VERSIONS.codexCli },
    },
    auth: {
      owner: 'harness-local-login',
      requiresSeparateLogin: true,
      modelProviderIds: ['openai'],
    },
    models: CODEX_MODELS,
    capabilities: capabilities({
      supportsNewSession: true,
      supportsHistory: true,
      supportsSessionClose: true,
      supportsModelReadback: true,
      supportsSessionList: true,
      supportsSessionResume: true,
      supportsSessionFork: false,
      supportsLiveText: true,
      supportsReasoning: true,
      supportsAskUser: false,
      supportsAttachments: true,
      supportsCancellation: true,
      cancellationMode: 'process-kill',
      supportsExecApproval: true,
      supportsInTurnSteering: false,
      supportsLiveToolEvents: true,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',
      supportsPromptCausalCompletion: true,
      supportsProcessRestartResume: true,
      supportedExecutionScopes: HOST_AND_PROJECT,
    }, {
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'native-cli',
      adapterKey: 'codex',
      models: CODEX_MODELS,
    }),
  },
  {
    id: 'GROK',
    displayName: 'Grok Build',
    transport: 'acp-stdio',
    native: true,
    implemented: true,
    selectable: true,
    releaseStage: 'stable',
    provenanceLabel: 'via Grok Build CLI',
    hostStreamOwnership: 'route',
    compatibilityProviderId: 'GROK',
    command: {
      executable: 'grok',
      args: ['--no-auto-update', 'agent', 'stdio'],
      versionArgs: ['--no-auto-update', '--version'],
      versionPolicy: { kind: 'exact-pin', testedVersion: PORTAL_TOOL_VERSIONS.grokBuild },
    },
    auth: {
      owner: 'harness-local-login',
      requiresSeparateLogin: true,
      modelProviderIds: ['xai'],
    },
    models: GROK_MODELS,
    capabilities: capabilities({
      supportsNewSession: true,
      supportsHistory: true,
      supportsSessionClose: true,
      supportsModelReadback: true,
      supportsSessionList: true,
      supportsSessionResume: true,
      supportsSessionFork: false,
      supportsLiveText: true,
      supportsReasoning: true,
      supportsAskUser: false,
      supportsAttachments: false,
      supportsCancellation: true,
      cancellationMode: 'protocol',
      supportsExecApproval: true,
      supportsInTurnSteering: false,
      supportsLiveToolEvents: true,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',
      supportsPromptCausalCompletion: true,
      supportsProcessRestartResume: true,
      supportedExecutionScopes: HOST_ONLY,
    }, {
      implemented: true,
      requiresGateway: false,
      // Compatibility family retained for current provider availability APIs;
      // transport above records the more precise ACP protocol.
      adapterFamily: 'native-cli',
      adapterKey: 'grok-build',
      models: GROK_MODELS,
    }),
  },
  {
    id: 'AGENT_ZERO',
    displayName: 'Agent Zero',
    transport: 'connector',
    native: false,
    implemented: true,
    selectable: true,
    releaseStage: 'stable',
    provenanceLabel: 'via Agent Zero',
    hostStreamOwnership: 'route',
    compatibilityProviderId: 'AGENT_ZERO',
    command: {
      executable: null,
      args: [],
      versionArgs: [],
      versionPolicy: { kind: 'exact-pin', testedVersion: AGENT_ZERO_VERSION },
    },
    auth: {
      owner: 'harness-local-login',
      requiresSeparateLogin: true,
      modelProviderIds: [],
    },
    models: AGENT_ZERO_MODELS,
    capabilities: capabilities({
      supportsNewSession: true,
      supportsHistory: true,
      supportsSessionClose: true,
      supportsModelReadback: true,
      supportsSessionList: true,
      supportsSessionResume: true,
      supportsSessionFork: false,
      supportsLiveText: true,
      supportsReasoning: true,
      supportsAskUser: false,
      supportsAttachments: false,
      supportsCancellation: false,
      cancellationMode: 'none',
      supportsExecApproval: false,
      supportsInTurnSteering: false,
      supportsLiveToolEvents: true,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',
      supportsPromptCausalCompletion: true,
      supportsProcessRestartResume: true,
      supportedExecutionScopes: HOST_AND_PROJECT,
    }, {
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'agent-zero-connector',
      adapterKey: 'agent-zero-v2.11-connector',
      models: AGENT_ZERO_MODELS,
    }),
  },
  {
    id: 'GEMINI',
    displayName: 'Google Antigravity',
    transport: 'native-cli',
    native: true,
    implemented: true,
    selectable: true,
    releaseStage: 'stable',
    provenanceLabel: 'via Antigravity',
    hostStreamOwnership: 'provider',
    compatibilityProviderId: 'GEMINI',
    command: {
      executable: 'agy',
      args: ['--print'],
      versionArgs: ['--version'],
      versionPolicy: { kind: 'exact-pin', testedVersion: PORTAL_TOOL_VERSIONS.antigravity },
    },
    auth: {
      owner: 'harness-local-login',
      requiresSeparateLogin: true,
      modelProviderIds: ['google'],
    },
    models: GEMINI_MODELS,
    capabilities: capabilities({
      supportsNewSession: true,
      supportsHistory: true,
      supportsSessionClose: true,
      supportsModelReadback: true,
      supportsSessionList: true,
      supportsSessionResume: true,
      supportsSessionFork: false,
      supportsLiveText: true,
      supportsReasoning: true,
      supportsAskUser: false,
      supportsAttachments: true,
      supportsCancellation: true,
      cancellationMode: 'process-kill',
      supportsExecApproval: true,
      supportsInTurnSteering: false,
      supportsLiveToolEvents: true,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',
      supportsPromptCausalCompletion: true,
      supportsProcessRestartResume: true,
      supportedExecutionScopes: HOST_ONLY,
    }, {
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'native-cli',
      adapterKey: 'antigravity',
      models: GEMINI_MODELS,
    }),
  },
  {
    id: 'OLLAMA',
    displayName: 'Ollama',
    transport: 'connector',
    native: true,
    implemented: true,
    selectable: true,
    releaseStage: 'stable',
    provenanceLabel: 'via Ollama',
    hostStreamOwnership: 'route',
    compatibilityProviderId: 'OLLAMA',
    command: {
      executable: 'ollama',
      args: [],
      versionArgs: ['--version'],
      versionPolicy: { kind: 'exact-pin', testedVersion: PORTAL_TOOL_VERSIONS.ollama },
    },
    auth: {
      owner: 'none',
      requiresSeparateLogin: false,
      modelProviderIds: [],
    },
    models: OLLAMA_MODELS,
    capabilities: capabilities({
      supportsNewSession: true,
      supportsHistory: true,
      supportsSessionClose: true,
      supportsModelReadback: true,
      supportsSessionList: true,
      supportsSessionResume: true,
      supportsSessionFork: false,
      supportsLiveText: true,
      supportsReasoning: false,
      supportsAskUser: false,
      supportsAttachments: true,
      supportsCancellation: true,
      cancellationMode: 'protocol',
      supportsExecApproval: false,
      supportsInTurnSteering: false,
      supportsLiveToolEvents: true,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',
      supportsPromptCausalCompletion: true,
      supportsProcessRestartResume: true,
      supportedExecutionScopes: HOST_AND_PROJECT,
    }, {
      implemented: true,
      requiresGateway: false,
      // Compatibility family retained until the legacy provider API grows a
      // connector family that is not Agent-Zero-specific.
      adapterFamily: 'native-cli',
      adapterKey: 'ollama',
      models: OLLAMA_MODELS,
    }),
  },
  {
    id: 'HERMES',
    displayName: 'Hermes',
    transport: 'acp-stdio',
    native: true,
    implemented: true,
    selectable: true,
    releaseStage: 'stable',
    provenanceLabel: 'via Hermes',
    hostStreamOwnership: 'route',
    compatibilityProviderId: 'HERMES',
    command: {
      executable: 'hermes',
      args: ['acp'],
      versionArgs: ['acp', '--version'],
      versionPolicy: {
        kind: 'exact-pin',
        testedVersion: PORTAL_TOOL_VERSIONS.hermes,
        reason: 'Pinned to Hermes v2026.9.7 (0.21.1), commit 2237be355906fbe6065ce1815711eee52b2d646e, canonical source-tree SHA-256 77aa1e1cabc237bb62b291e77927d99977ac356484a9d16f897bb66cda248773.',
      },
    },
    auth: {
      owner: 'harness-local-login',
      requiresSeparateLogin: true,
      modelProviderIds: [],
    },
    models: HERMES_MODELS,
    capabilities: capabilities({
      supportsNewSession: true,
      supportsHistory: true,
      // ACP can load/resume persisted state but has no delete or per-session
      // close method; Portal retirement must remain explicitly Portal-owned.
      supportsSessionClose: false,
      supportsModelReadback: true,
      supportsSessionList: true,
      supportsSessionResume: true,
      supportsSessionFork: true,
      supportsLiveText: true,
      supportsReasoning: true,
      supportsAskUser: false,
      supportsAttachments: true,
      supportsCancellation: true,
      cancellationMode: 'protocol',
      supportsExecApproval: true,
      supportsInTurnSteering: false,
      supportsLiveToolEvents: true,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',
      supportsPromptCausalCompletion: true,
      supportsProcessRestartResume: true,
      supportedExecutionScopes: HOST_ONLY,
    }, {
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'native-cli',
      adapterKey: 'hermes-acp',
      models: HERMES_MODELS,
    }),
    documentationUrl: 'https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/programmatic-integration.md',
  },
  {
    id: 'OPENCODE',
    displayName: 'OpenCode',
    transport: 'acp-stdio',
    native: true,
    implemented: true,
    selectable: true,
    releaseStage: 'stable',
    provenanceLabel: 'via OpenCode',
    hostStreamOwnership: 'route',
    compatibilityProviderId: 'OPENCODE',
    command: {
      executable: 'opencode',
      args: ['acp', '--pure', '--hostname', '127.0.0.1', '--port', '0', '--no-mdns'],
      versionArgs: ['--version'],
      versionPolicy: {
        kind: 'exact-pin',
        testedVersion: PORTAL_TOOL_VERSIONS.openCode,
        reason: 'Pinned to OpenCode v1.18.29; official glibc Linux x64 baseline asset opencode-linux-x64-baseline.tar.gz SHA-256 03a3f2f063e23477e3e4c3a738eb389f56c5a6ecf54d6a5a6d91caab557f042d.',
      },
    },
    auth: {
      owner: 'harness-local-login',
      requiresSeparateLogin: true,
      modelProviderIds: [],
    },
    models: OPENCODE_MODELS,
    capabilities: capabilities({
      supportsNewSession: true,
      supportsHistory: true,
      supportsSessionClose: true,
      supportsModelReadback: true,
      supportsSessionList: true,
      supportsSessionResume: true,
      supportsSessionFork: true,
      supportsLiveText: true,
      supportsReasoning: true,
      supportsAskUser: false,
      supportsAttachments: false,
      supportsCancellation: true,
      cancellationMode: 'protocol',
      supportsExecApproval: true,
      supportsInTurnSteering: false,
      supportsLiveToolEvents: true,
      supportsQueuedFollowUps: true,
      followUpMode: 'queued_follow_up',
      supportsPromptCausalCompletion: true,
      supportsProcessRestartResume: true,
      supportedExecutionScopes: HOST_ONLY,
    }, {
      implemented: true,
      requiresGateway: false,
      adapterFamily: 'native-cli',
      adapterKey: 'opencode-acp',
      models: OPENCODE_MODELS,
    }),
    documentationUrl: 'https://opencode.ai/docs/acp/',
  },
  {
    id: 'DEEPSEEK_HARNESS',
    displayName: 'DeepSeek Harness',
    transport: 'json-rpc-stdio',
    native: true,
    implemented: false,
    selectable: false,
    releaseStage: 'developer-preview',
    provenanceLabel: 'via DeepSeek Harness',
    hostStreamOwnership: 'provider',
    compatibilityProviderId: null,
    command: {
      // Upstream currently documents a repository composition, not a pinned
      // standalone Portal artifact. Null is deliberate: never run npx/latest
      // or turn catalog text into an arbitrary-command execution facility.
      executable: null,
      args: [],
      versionArgs: [],
      versionPolicy: {
        kind: 'blocked-until-pinned',
        testedVersion: '0.1.0-rc.8',
        reason: 'Candidate source pin: dsh-v0.1.0-rc.8, commit 141eb6fef83422698aef7a981029e843e8161534, archive SHA-256 f232ba127ad9120308436655c7c89ed1c81680c8eda0ff70d22c86c4331dfbdc. No matching qualified runtime artifact exists yet.',
      },
    },
    auth: {
      owner: 'model-provider-account',
      requiresSeparateLogin: true,
      modelProviderIds: ['deepseek'],
    },
    models: DEEPSEEK_HARNESS_MODELS,
    capabilities: capabilities({
      supportsNewSession: true,
      supportsHistory: false,
      supportsSessionClose: false,
      supportsModelReadback: false,
      supportsSessionList: false,
      supportsSessionResume: false,
      supportsSessionFork: false,
      supportsLiveText: true,
      supportsReasoning: true,
      supportsAskUser: false,
      supportsAttachments: false,
      supportsCancellation: true,
      // The preview SDK has no per-session cancel/close contract. Portal may
      // advertise only bounded child-process termination until that changes.
      cancellationMode: 'process-kill',
      // The automation ACP bridge resolves one-shot permissions by policy; it
      // does not expose a full human approval presentation contract.
      supportsExecApproval: false,
      supportsInTurnSteering: false,
      supportsLiveToolEvents: true,
      supportsQueuedFollowUps: false,
      followUpMode: 'queued_follow_up',
      // SDK completion is receipt-to-next-idle and can include unrelated queued
      // work, so Portal must not treat idle as a prompt-owned terminal result.
      supportsPromptCausalCompletion: false,
      supportsProcessRestartResume: false,
      supportedExecutionScopes: HOST_ONLY,
    }, {
      implemented: false,
      requiresGateway: false,
      adapterFamily: 'native-cli',
      adapterKey: 'deepseek-harness-json-rpc-preview',
      models: DEEPSEEK_HARNESS_MODELS,
    }),
    documentationUrl: 'https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md',
    unavailableReason: 'Developer Preview: the SDK supports resident multi-turn sessions and live assistant/reasoning/tool events, but has no protocol cancel, close, list/load/resume/fork, approval channel, prompt-causal terminal result, qualified runtime artifact, or restart recovery. Cancellation is bounded process-tree termination. Host Operator only.',
  },
];

export const AGENT_HARNESS_CATALOG: readonly HarnessDefinition[] = deepFreeze(definitions);

export const AGENT_HARNESS_IDS: readonly AgentHarnessId[] = deepFreeze(
  AGENT_HARNESS_CATALOG.map((definition) => definition.id),
);

export const REGISTERED_AGENT_HARNESS_IDS: readonly AgentProviderName[] = deepFreeze(
  AGENT_HARNESS_CATALOG
    .filter((definition): definition is HarnessDefinition & { compatibilityProviderId: AgentProviderName } => (
      definition.compatibilityProviderId !== null
    ))
    .map((definition) => definition.compatibilityProviderId),
);

const BY_ID = new Map<AgentHarnessId, HarnessDefinition>(
  AGENT_HARNESS_CATALOG.map((definition) => [definition.id, definition]),
);

export function isAgentHarnessId(value: unknown): value is AgentHarnessId {
  return typeof value === 'string' && BY_ID.has(value as AgentHarnessId);
}

/** Exact-id lookup only. Model ids and model-provider ids never select a harness. */
export function getHarnessDefinition(value: unknown): HarnessDefinition | null {
  return isAgentHarnessId(value) ? BY_ID.get(value)! : null;
}

export function requireHarnessDefinition(id: AgentHarnessId): HarnessDefinition {
  const definition = BY_ID.get(id);
  if (!definition) throw new Error(`Unknown agent harness: ${String(id)}`);
  return definition;
}

export function isRegisteredAgentProviderName(value: unknown): value is AgentProviderName {
  const definition = getHarnessDefinition(value);
  return definition?.compatibilityProviderId === value;
}
