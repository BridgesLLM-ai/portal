import type {
  ProjectChatProviderCapability,
  ProjectChatProviderCapabilitiesResponse,
  ProjectChatProviderName,
  ProjectChatProviderQualificationStatus,
} from '../../api/endpoints';

export type ProjectProviderVerificationState = 'unknown' | 'verifying' | 'ready' | 'failed';

const PROJECT_PROVIDER_CATALOG: ReadonlyArray<Pick<
  ProjectChatProviderCapability,
  'provider' | 'displayName' | 'runtime'
>> = Object.freeze([
  { provider: 'OPENCLAW', displayName: 'OpenClaw', runtime: 'openclaw-dedicated-project-agent' },
  { provider: 'CLAUDE_CODE', displayName: 'Claude Code', runtime: 'claude-code-project-adapter' },
  { provider: 'CODEX', displayName: 'Codex', runtime: 'codex-project-adapter' },
  { provider: 'GROK', displayName: 'Grok Build', runtime: 'grok-build-project-adapter' },
  { provider: 'AGENT_ZERO', displayName: 'Agent Zero', runtime: 'agent-zero-project-sandbox-v1' },
  { provider: 'GEMINI', displayName: 'Antigravity', runtime: 'antigravity-project-adapter' },
  { provider: 'OLLAMA', displayName: 'Ollama', runtime: 'ollama-project-adapter' },
]);

const KNOWN_PROJECT_PROVIDERS = new Set<ProjectChatProviderName>(
  PROJECT_PROVIDER_CATALOG.map((entry) => entry.provider),
);

function explicitReason(reason: unknown, fallback: string): string {
  const normalized = String(reason || '').trim();
  return normalized || fallback;
}

function providerDisplayName(provider: ProjectChatProviderName): string {
  return PROJECT_PROVIDER_CATALOG.find((entry) => entry.provider === provider)?.displayName || provider;
}

function qualificationDisplayReason(
  qualification: ProjectChatProviderQualificationStatus,
): string {
  const displayName = providerDisplayName(qualification.provider);
  if (qualification.status === 'QUALIFIED') return `${displayName} is verified for this project.`;
  if (qualification.status === 'EXPIRED') return `${displayName} verification expired. Verify it again before use.`;
  if (qualification.status === 'INVALID') return `${displayName} verification needs to be renewed before use.`;
  if (qualification.status === 'UNAVAILABLE') return `${displayName} is not available for Project Chat on this system.`;
  return `${displayName} has not been verified for this project yet.`;
}

/**
 * Provider readiness responses can contain command output and host paths used
 * to diagnose an attestation failure. Those details belong in server logs,
 * never in the Project Chat DOM. Keep the status/evidence contract intact and
 * derive the user-facing explanation from the bounded status enum.
 */
export function presentProjectProviderQualifications(
  qualifications: Partial<Record<ProjectChatProviderName, ProjectChatProviderQualificationStatus>> | null | undefined,
): Partial<Record<ProjectChatProviderName, ProjectChatProviderQualificationStatus>> {
  const presented: Partial<Record<ProjectChatProviderName, ProjectChatProviderQualificationStatus>> = {};
  for (const [provider, qualification] of Object.entries(qualifications || {})) {
    if (!qualification || !KNOWN_PROJECT_PROVIDERS.has(provider as ProjectChatProviderName)) continue;
    presented[provider as ProjectChatProviderName] = {
      ...qualification,
      reason: qualificationDisplayReason(qualification),
    };
  }
  return presented;
}

export function buildUnavailableProjectProviderCapabilities(
  reason: string,
): ProjectChatProviderCapability[] {
  const unavailableReason = explicitReason(
    reason,
    'Project provider verification did not complete. No provider can be used.',
  );
  return PROJECT_PROVIDER_CATALOG.map((entry) => ({
    ...entry,
    selectable: false,
    executionScope: null,
    supportsAttachments: false,
    supportsModelSelection: false,
    supportsAbort: false,
    supportsReset: false,
    requiresOAuth: false,
    reason: unavailableReason,
  }));
}

export interface ResolvedProjectProviderCapabilities {
  providers: ProjectChatProviderCapability[];
  activeProvider: ProjectChatProviderName | null;
  activeCapability: ProjectChatProviderCapability | null;
  error: string | null;
}

export function resolveProjectProviderCapabilities(
  response: ProjectChatProviderCapabilitiesResponse | null | undefined,
): ResolvedProjectProviderCapabilities {
  const reportedProviders = new Map<ProjectChatProviderName, ProjectChatProviderCapability>();
  for (const capability of Array.isArray(response?.providers) ? response.providers : []) {
    if (!KNOWN_PROJECT_PROVIDERS.has(capability?.provider)) continue;
    const validProjectScope = capability.selectable === true
      && capability.executionScope === 'PROJECT_SANDBOX';
    reportedProviders.set(capability.provider, {
      provider: capability.provider,
      displayName: explicitReason(capability.displayName, capability.provider),
      runtime: explicitReason(capability.runtime, 'unverified-project-runtime'),
      selectable: validProjectScope,
      executionScope: validProjectScope ? 'PROJECT_SANDBOX' : null,
      supportsAttachments: capability.supportsAttachments === true,
      supportsModelSelection: capability.supportsModelSelection === true,
      supportsAbort: capability.supportsAbort === true,
      supportsReset: capability.supportsReset === true,
      requiresOAuth: capability.requiresOAuth === true,
      reason: validProjectScope
        ? `${explicitReason(capability.displayName, capability.provider)} is verified for this project.`
        : capability.provider === 'GROK'
          ? 'Grok Build is not supported for Project Chat in this release.'
        : `${explicitReason(capability.displayName, capability.provider)} is not verified for this project yet.`,
    });
  }

  const providers = PROJECT_PROVIDER_CATALOG.map((catalogEntry) => (
    reportedProviders.get(catalogEntry.provider) || {
      ...catalogEntry,
      selectable: false,
      executionScope: null,
      supportsAttachments: false,
      supportsModelSelection: false,
      supportsAbort: false,
      supportsReset: false,
      requiresOAuth: false,
      reason: `Portal did not report a verified ${catalogEntry.displayName} Project Sandbox capability.`,
    }
  ));

  const activeProvider = KNOWN_PROJECT_PROVIDERS.has(response?.activeProvider as ProjectChatProviderName)
    ? response!.activeProvider
    : null;
  if (!activeProvider) {
    return {
      providers,
      activeProvider: null,
      activeCapability: null,
      error: 'Portal did not return a recognized server-selected Project Chat provider.',
    };
  }

  const activeCapability = providers.find((entry) => entry.provider === activeProvider) || null;
  if (!activeCapability?.selectable || activeCapability.executionScope !== 'PROJECT_SANDBOX') {
    // A missing runtime and an unverified provider both land here, but they
    // need opposite actions: "pick a different provider" versus "verify this
    // one". Calling a runtime that was never installed "not verified yet"
    // points people at a button that cannot help them.
    const runtime = response?.activeProviderRuntime;
    const runtimeUnavailable = runtime?.available === false && runtime.provider === activeProvider;
    const displayName = activeCapability?.displayName || activeProvider;
    return {
      providers,
      activeProvider,
      activeCapability,
      error: runtimeUnavailable
        ? `${displayName} is the server-selected provider, but its runtime is not installed on this server. Choose a different provider to keep working.`
        : `${displayName} is the server-selected provider but is unavailable: ${activeCapability?.reason || 'Project Sandbox verification failed.'}`,
    };
  }

  return { providers, activeProvider, activeCapability, error: null };
}

export function canSwitchProjectProvider(input: {
  verificationState: ProjectProviderVerificationState;
  serverSelectedProvider: ProjectChatProviderName | null;
  turnActive: boolean;
  transitionPending: boolean;
}): boolean {
  // Switching away from a provider that cannot run is the recovery action, so
  // a failed verification must not disable the control that performs it. On
  // failure the panel also clears the server-selected provider, and requiring
  // one here left the menu permanently disabled: the user could only retry the
  // provider that had just failed, and nothing short of a full page reload
  // restored the ability to choose a different one.
  //
  // A live turn and an in-flight transition still block a switch, and the
  // server re-qualifies every selection regardless. This gate is a usability
  // guard, not the isolation boundary.
  if (input.turnActive || input.transitionPending) return false;
  if (input.verificationState === 'failed') return true;
  return input.verificationState === 'ready'
    && input.serverSelectedProvider !== null;
}

export function canSendToProjectProvider(input: {
  verificationState: ProjectProviderVerificationState;
  serverSelectedProvider: ProjectChatProviderName | null;
  renderedProvider: ProjectChatProviderName;
  selectedCapability: ProjectChatProviderCapability | null;
  sessionReady: boolean;
  turnActive: boolean;
  transitionPending: boolean;
}): boolean {
  return input.verificationState === 'ready'
    && input.serverSelectedProvider !== null
    && input.renderedProvider === input.serverSelectedProvider
    && input.selectedCapability?.provider === input.serverSelectedProvider
    && input.selectedCapability.selectable === true
    && input.selectedCapability.executionScope === 'PROJECT_SANDBOX'
    && input.sessionReady
    && !input.turnActive
    && !input.transitionPending;
}
