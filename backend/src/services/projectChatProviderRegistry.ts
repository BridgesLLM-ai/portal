import type { AgentProvider, AgentProviderName } from '../agents/AgentProvider.interface';
import { AgentRegistry } from '../agents';
import { config } from '../config/env';
import { AgentZeroProjectProvider } from '../agents/providers/agentZero/AgentZeroProjectProvider';
import type { AgentZeroProjectModelSelection } from '../agents/providers/agentZero/AgentZeroProjectModelBridgeCredential';
import {
  AGENT_ZERO_PROJECT_POLICY_VERSION,
  AGENT_ZERO_PROJECT_RUNTIME,
} from '../agents/providers/agentZero/AgentZeroProjectSandbox';
import { normalizeAgentZeroProjectSandboxImageId } from '../agents/providers/agentZero/AgentZeroProjectImage';
import {
  CODEX_PROJECT_RUNTIME,
} from '../agents/providers/native/projectSandbox/CodexProjectSandbox';
import {
  CODEX_PROJECT_RUNTIME_POLICY_VERSION,
} from '../agents/providers/native/projectSandbox/CodexProjectEgressRuntime';
import {
  CLAUDE_CODE_PROJECT_RUNTIME,
  CLAUDE_CODE_PROJECT_RUNTIME_POLICY_VERSION,
} from '../agents/providers/native/projectSandbox/ClaudeCodeProjectSandbox';
import {
  ANTIGRAVITY_PROJECT_RUNTIME,
  ANTIGRAVITY_PROJECT_RUNTIME_POLICY_VERSION,
} from '../agents/providers/native/projectSandbox/AntigravityProjectSandbox';
import { OllamaProjectProvider } from '../agents/providers/ollama/OllamaProjectProvider';
import {
  OLLAMA_PROJECT_RUNTIME,
  OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
} from '../agents/providers/ollama/OllamaProjectToolRuntime';

export const OPENCLAW_PROJECT_RUNTIME = 'openclaw-dedicated-project-agent';
export const OPENCLAW_PROJECT_RUNTIME_POLICY_VERSION = 'portal-project-sandbox-v2';
export const PROJECT_CHAT_EGRESS_POLICY_VERSION = 'portal-project-egress-v1';

/** Providers with a complete, confined Project runtime foundation. */
export type QualifiableProjectProvider = Extract<
  AgentProviderName,
  'OPENCLAW' | 'CODEX' | 'CLAUDE_CODE' | 'AGENT_ZERO' | 'GEMINI' | 'OLLAMA'
>;

/** Providers transported through Portal's durable native-run broker. */
export type DurableProjectProvider = QualifiableProjectProvider;

export type NativeProjectProvider = Exclude<DurableProjectProvider, 'OPENCLAW'>;

export interface ProjectChatProviderAdapter extends AgentProvider {
  resetSession?(sessionId: string): Promise<void>;
}

export interface ProjectChatProviderRuntimeDescriptor {
  readonly provider: QualifiableProjectProvider;
  readonly displayName: string;
  readonly runtime: string;
  readonly runtimePolicyVersion: string;
  readonly nativeSession: boolean;
  readonly runtimeImageDigest: () => string;
}

const DESCRIPTORS: Readonly<Record<QualifiableProjectProvider, ProjectChatProviderRuntimeDescriptor>> = Object.freeze({
  OPENCLAW: Object.freeze({
    provider: 'OPENCLAW' as const,
    displayName: 'OpenClaw',
    runtime: OPENCLAW_PROJECT_RUNTIME,
    runtimePolicyVersion: OPENCLAW_PROJECT_RUNTIME_POLICY_VERSION,
    nativeSession: false,
    runtimeImageDigest: () => config.openclawProjectSandboxImageId,
  }),
  CODEX: Object.freeze({
    provider: 'CODEX' as const,
    displayName: 'Codex',
    runtime: CODEX_PROJECT_RUNTIME,
    runtimePolicyVersion: CODEX_PROJECT_RUNTIME_POLICY_VERSION,
    nativeSession: true,
    runtimeImageDigest: () => config.codexProjectSandboxImageId,
  }),
  CLAUDE_CODE: Object.freeze({
    provider: 'CLAUDE_CODE' as const,
    displayName: 'Claude Code',
    runtime: CLAUDE_CODE_PROJECT_RUNTIME,
    runtimePolicyVersion: CLAUDE_CODE_PROJECT_RUNTIME_POLICY_VERSION,
    nativeSession: true,
    runtimeImageDigest: () => config.claudeCodeProjectSandboxImageId,
  }),
  AGENT_ZERO: Object.freeze({
    provider: 'AGENT_ZERO' as const,
    displayName: 'Agent Zero',
    runtime: AGENT_ZERO_PROJECT_RUNTIME,
    runtimePolicyVersion: AGENT_ZERO_PROJECT_POLICY_VERSION,
    nativeSession: true,
    runtimeImageDigest: () => {
      const imageId = normalizeAgentZeroProjectSandboxImageId(
        config.agentZeroProjectSandboxImageId,
      );
      if (!imageId) {
        throw new Error('Agent Zero Project Sandbox lacks an installer-attested derived image ID');
      }
      return imageId;
    },
  }),
  GEMINI: Object.freeze({
    provider: 'GEMINI' as const,
    displayName: 'Google Antigravity',
    runtime: ANTIGRAVITY_PROJECT_RUNTIME,
    runtimePolicyVersion: ANTIGRAVITY_PROJECT_RUNTIME_POLICY_VERSION,
    nativeSession: true,
    runtimeImageDigest: () => config.antigravityProjectSandboxImageId,
  }),
  OLLAMA: Object.freeze({
    provider: 'OLLAMA' as const,
    displayName: 'Ollama',
    runtime: OLLAMA_PROJECT_RUNTIME,
    runtimePolicyVersion: OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
    nativeSession: true,
    runtimeImageDigest: () => config.ollamaProjectSandboxImageId,
  }),
});

export class ProjectChatProviderRuntimeUnavailableError extends Error {
  readonly provider: QualifiableProjectProvider;

  constructor(provider: QualifiableProjectProvider) {
    const displayName = DESCRIPTORS[provider]?.displayName || provider;
    super(
      `${displayName} Project runtime is not installed and attested on this server. `
      + 'Install the supported provider runtime, then run the Portal updater to enable it.',
    );
    this.name = 'ProjectChatProviderRuntimeUnavailableError';
    this.provider = provider;
  }
}

export const QUALIFIABLE_PROJECT_PROVIDERS: readonly QualifiableProjectProvider[] = Object.freeze([
  'OPENCLAW',
  'CODEX',
  'CLAUDE_CODE',
  'AGENT_ZERO',
  'GEMINI',
  'OLLAMA',
]);

const QUALIFIABLE = new Set<AgentProviderName>(QUALIFIABLE_PROJECT_PROVIDERS);

export function isQualifiableProjectProvider(
  provider: AgentProviderName,
): provider is QualifiableProjectProvider {
  return QUALIFIABLE.has(provider);
}

export function isNativeProjectProvider(
  provider: AgentProviderName,
): provider is NativeProjectProvider {
  return provider !== 'OPENCLAW' && isQualifiableProjectProvider(provider);
}

export function getProjectChatProviderRuntimeDescriptor(
  provider: QualifiableProjectProvider,
): ProjectChatProviderRuntimeDescriptor {
  const descriptor = DESCRIPTORS[provider];
  if (!descriptor) throw new Error('Project provider runtime descriptor is unavailable');
  return descriptor;
}

/**
 * Resolve the installer-attested immutable image for one Project provider.
 *
 * Capability discovery deliberately catches only this provider-scoped error
 * so an optional, unavailable runtime cannot hide every otherwise-usable
 * Project Chat lane. Mutating routes still call this same function and remain
 * fail-closed: no context, qualification grant, or session can be created
 * without the exact immutable image ID.
 */
export function requireProjectChatProviderRuntimeImageDigest(
  provider: QualifiableProjectProvider,
): string {
  const descriptor = getProjectChatProviderRuntimeDescriptor(provider);
  let imageId = '';
  try {
    imageId = String(descriptor.runtimeImageDigest() || '').trim().toLowerCase();
  } catch {
    throw new ProjectChatProviderRuntimeUnavailableError(provider);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    throw new ProjectChatProviderRuntimeUnavailableError(provider);
  }
  return imageId;
}

export function projectChatProviderDisplayName(provider: QualifiableProjectProvider): string {
  return getProjectChatProviderRuntimeDescriptor(provider).displayName;
}

// Agent Zero Project Chat must never resolve through AgentRegistry: that
// registry intentionally returns the unrestricted host-operator adapter.
// Keeping the dedicated provider singleton here also makes send/abort/reset
// observe one authoritative active-run set.
const agentZeroProjectProvider = new AgentZeroProjectProvider();
// The Main Ollama adapter has host-level HTTP access and no coding tool
// confinement. Project Chat must use this dedicated networkless tool runtime.
const ollamaProjectProvider = new OllamaProjectProvider();

export function getProjectChatProviderAdapter(
  provider: DurableProjectProvider,
): ProjectChatProviderAdapter {
  if (provider === 'AGENT_ZERO') return agentZeroProjectProvider;
  if (provider === 'OLLAMA') return ollamaProjectProvider;
  return AgentRegistry.get(provider) as ProjectChatProviderAdapter;
}

export async function resetProjectChatProviderSession(input: {
  provider: DurableProjectProvider;
  sessionId: string;
}): Promise<void> {
  const adapter = getProjectChatProviderAdapter(input.provider);
  if (typeof adapter.resetSession !== 'function') {
    throw new Error(`${projectChatProviderDisplayName(input.provider)} does not expose a Project session reset contract`);
  }
  await adapter.resetSession(input.sessionId);
}

export async function rebindAgentZeroProjectSessionModel(input: {
  sessionId: string;
  selection: AgentZeroProjectModelSelection;
}): Promise<void> {
  await agentZeroProjectProvider.rebindSessionModel(input.sessionId, input.selection);
}

export async function terminateProjectChatProviderSession(input: {
  provider: DurableProjectProvider;
  sessionId: string;
}): Promise<void> {
  await getProjectChatProviderAdapter(input.provider).terminateSession(input.sessionId);
}
