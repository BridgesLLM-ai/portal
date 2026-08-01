import { describe, expect, it } from 'vitest';
import type { ProjectChatProviderCapabilitiesResponse } from '../../api/endpoints';
import {
  buildUnavailableProjectProviderCapabilities,
  canSendToProjectProvider,
  canSwitchProjectProvider,
  presentProjectProviderQualifications,
  resolveProjectProviderCapabilities,
} from './projectChatProviderState';

const supportedFeatures = {
  supportsAttachments: true,
  supportsModelSelection: true,
  supportsAbort: true,
  supportsReset: true,
  requiresOAuth: false,
} as const;

function response(
  overrides: Partial<ProjectChatProviderCapabilitiesResponse> = {},
): ProjectChatProviderCapabilitiesResponse {
  return {
    activeProvider: 'OPENCLAW',
    providers: [{
      provider: 'OPENCLAW',
      displayName: 'OpenClaw',
      runtime: 'openclaw-dedicated-project-agent',
      selectable: true,
      executionScope: 'PROJECT_SANDBOX',
      ...supportedFeatures,
      reason: 'Verified.',
    }],
    supportedProviders: [],
    bindings: [],
    executionContext: {
      scope: 'PROJECT_SANDBOX',
      projectId: 'project-id',
      policyFingerprint: 'fingerprint',
    },
    qualifications: {
      OPENCLAW: {
        provider: 'OPENCLAW',
        status: 'QUALIFIED',
        selectable: true,
        reason: 'Verified.',
        qualifiedAt: '2026-07-19T08:00:00.000Z',
        expiresAt: '2026-07-19T20:00:00.000Z',
        evidenceFingerprint: 'a'.repeat(64),
      },
      CODEX: {
        provider: 'CODEX',
        status: 'UNQUALIFIED',
        selectable: false,
        reason: 'Not qualified.',
        qualifiedAt: null,
        expiresAt: null,
        evidenceFingerprint: null,
      },
      CLAUDE_CODE: {
        provider: 'CLAUDE_CODE',
        status: 'UNQUALIFIED',
        selectable: false,
        reason: 'Not qualified.',
        qualifiedAt: null,
        expiresAt: null,
        evidenceFingerprint: null,
      },
      AGENT_ZERO: {
        provider: 'AGENT_ZERO',
        status: 'UNQUALIFIED',
        selectable: false,
        reason: 'Not qualified.',
        qualifiedAt: null,
        expiresAt: null,
        evidenceFingerprint: null,
      },
      GEMINI: {
        provider: 'GEMINI',
        status: 'UNQUALIFIED',
        selectable: false,
        reason: 'Not qualified.',
        qualifiedAt: null,
        expiresAt: null,
        evidenceFingerprint: null,
      },
      OLLAMA: {
        provider: 'OLLAMA',
        status: 'UNQUALIFIED',
        selectable: false,
        reason: 'Not qualified.',
        qualifiedAt: null,
        expiresAt: null,
        evidenceFingerprint: null,
      },
    },
    coordination: {
      stateVersion: 1,
      selectedProvider: 'OPENCLAW',
      transcriptCursor: 0,
      activeTurn: null,
    },
    ...overrides,
  };
}

describe('Project Chat provider fail-closed state', () => {
  it('marks every known provider unavailable with an explicit reason before or after failed verification', () => {
    const providers = buildUnavailableProjectProviderCapabilities('Capability verification failed.');

    expect(providers.map((entry) => entry.provider)).toEqual([
      'OPENCLAW',
      'CLAUDE_CODE',
      'CODEX',
      'GROK',
      'AGENT_ZERO',
      'GEMINI',
      'OLLAMA',
    ]);
    expect(providers.every((entry) => entry.selectable === false)).toBe(true);
    expect(providers.every((entry) => entry.executionScope === null)).toBe(true);
    expect(providers.every((entry) => entry.reason === 'Capability verification failed.')).toBe(true);
  });

  it('never replaces an unavailable server-selected provider with a supported-provider fallback', () => {
    const result = resolveProjectProviderCapabilities(response({
      activeProvider: 'OPENCLAW',
      providers: [
        {
          provider: 'OPENCLAW',
          displayName: 'OpenClaw',
          runtime: 'openclaw-dedicated-project-agent',
          selectable: false,
          executionScope: null,
          ...supportedFeatures,
          reason: 'Runtime attestation failed.',
        },
        {
          provider: 'CODEX',
          displayName: 'Codex',
          runtime: 'codex-project-sandbox-v1',
          selectable: true,
          executionScope: 'PROJECT_SANDBOX',
          ...supportedFeatures,
          reason: 'Verified.',
        },
      ],
      supportedProviders: [{
        provider: 'CODEX',
        displayName: 'Codex',
        runtime: 'codex-project-sandbox-v1',
        selectable: true,
        executionScope: 'PROJECT_SANDBOX',
        ...supportedFeatures,
        reason: 'Verified.',
      }],
    }));

    expect(result.activeProvider).toBe('OPENCLAW');
    expect(result.activeCapability?.selectable).toBe(false);
    expect(result.error).toMatch(/server-selected provider.*unavailable/i);
    expect(canSwitchProjectProvider({
      verificationState: 'ready',
      serverSelectedProvider: result.activeProvider,
      turnActive: false,
      transitionPending: false,
    })).toBe(true);
  });

  it('keeps the provider picker available when no lane is qualified yet', () => {
    const result = resolveProjectProviderCapabilities(response({
      providers: response().providers.map((provider) => ({
        ...provider,
        selectable: false,
        executionScope: null,
        reason: 'Live project qualification is required.',
      })),
      supportedProviders: [],
      qualifications: {
        ...response().qualifications,
        OPENCLAW: {
          ...response().qualifications.OPENCLAW,
          status: 'UNQUALIFIED',
          selectable: false,
          reason: 'Live project qualification is required.',
          qualifiedAt: null,
          expiresAt: null,
          evidenceFingerprint: null,
        },
      },
    }));

    expect(result.activeProvider).toBe('OPENCLAW');
    expect(result.activeCapability?.selectable).toBe(false);
    expect(result.error).toMatch(/unavailable/i);
    expect(canSwitchProjectProvider({
      verificationState: 'ready',
      serverSelectedProvider: result.activeProvider,
      turnActive: false,
      transitionPending: false,
    })).toBe(true);
  });

  it('keeps the provider picker usable after verification fails, so another provider can be chosen', () => {
    // a failed verification also clears the server-selected provider.
    // Disabling the picker in that state left the user with nothing but a
    // retry of the provider that had just failed.
    expect(canSwitchProjectProvider({
      verificationState: 'failed',
      serverSelectedProvider: null,
      turnActive: false,
      transitionPending: false,
    })).toBe(true);
  });

  it('still refuses a provider switch during a live turn or an in-flight transition', () => {
    expect(canSwitchProjectProvider({
      verificationState: 'failed',
      serverSelectedProvider: null,
      turnActive: true,
      transitionPending: false,
    })).toBe(false);
    expect(canSwitchProjectProvider({
      verificationState: 'failed',
      serverSelectedProvider: null,
      turnActive: false,
      transitionPending: true,
    })).toBe(false);
  });

  it('fills omitted providers as unavailable instead of fabricating a selectable OpenClaw capability', () => {
    const result = resolveProjectProviderCapabilities(response({
      activeProvider: 'CODEX',
      providers: [],
      supportedProviders: [],
    }));

    expect(result.providers).toHaveLength(7);
    expect(result.providers.every((entry) => !entry.selectable && Boolean(entry.reason))).toBe(true);
    expect(result.activeCapability?.provider).toBe('CODEX');
    expect(result.error).toMatch(/did not report a verified Codex/i);
  });

  it('derives readiness explanations from bounded status instead of exposing probe output', () => {
    const rawProbe = 'docker exec portal-project id -u; pwd -P=/root/.openclaw; nonce=secret';
    const result = resolveProjectProviderCapabilities(response({
      providers: [{
        ...response().providers[0],
        selectable: false,
        executionScope: null,
        reason: rawProbe,
      }],
    }));
    const qualifications = presentProjectProviderQualifications({
      OPENCLAW: {
        ...response().qualifications.OPENCLAW,
        status: 'INVALID',
        selectable: false,
        reason: rawProbe,
      },
    });

    expect(result.activeCapability?.reason).toBe('OpenClaw is not verified for this project yet.');
    expect(result.error).not.toContain('docker exec');
    expect(qualifications.OPENCLAW?.reason).toBe('OpenClaw verification needs to be renewed before use.');
    expect(JSON.stringify({ result, qualifications })).not.toContain('/root/.openclaw');
    expect(JSON.stringify({ result, qualifications })).not.toContain('nonce=secret');
  });

  it('describes Grok Build as unsupported instead of implying that qualification can enable it', () => {
    const result = resolveProjectProviderCapabilities(response({
      providers: [
        ...response().providers,
        {
          provider: 'GROK',
          displayName: 'Grok Build',
          runtime: 'grok-build-project-adapter',
          selectable: false,
          executionScope: null,
          ...supportedFeatures,
          reason: 'host details must not reach the browser',
        },
      ],
    }));

    expect(result.providers.find((provider) => provider.provider === 'GROK')?.reason)
      .toBe('Grok Build is not supported for Project Chat in this release.');
    expect(JSON.stringify(result)).not.toContain('host details');
  });

  it('permits sends only to the verified server-selected provider', () => {
    const capability = response().providers[0];
    const baseline = {
      verificationState: 'ready' as const,
      serverSelectedProvider: 'OPENCLAW' as const,
      renderedProvider: 'OPENCLAW' as const,
      selectedCapability: capability,
      sessionReady: true,
      turnActive: false,
      transitionPending: false,
    };

    expect(canSendToProjectProvider(baseline)).toBe(true);
    expect(canSendToProjectProvider({ ...baseline, renderedProvider: 'CODEX' })).toBe(false);
    expect(canSendToProjectProvider({ ...baseline, verificationState: 'unknown' })).toBe(false);
    expect(canSendToProjectProvider({ ...baseline, turnActive: true })).toBe(false);
    expect(canSendToProjectProvider({ ...baseline, transitionPending: true })).toBe(false);
  });

  it('blocks provider switching while capability state is unknown or a turn is active', () => {
    const baseline = {
      verificationState: 'ready' as const,
      serverSelectedProvider: 'OPENCLAW' as const,
      turnActive: false,
      transitionPending: false,
    };

    expect(canSwitchProjectProvider(baseline)).toBe(true);
    expect(canSwitchProjectProvider({ ...baseline, verificationState: 'unknown' })).toBe(false);
    expect(canSwitchProjectProvider({ ...baseline, verificationState: 'verifying' })).toBe(false);
    expect(canSwitchProjectProvider({ ...baseline, turnActive: true })).toBe(false);
    expect(canSwitchProjectProvider({ ...baseline, transitionPending: true })).toBe(false);
  });
});

describe('server-selected provider whose runtime is missing', () => {
  const baseResponse = (overrides: any) => ({
    activeProvider: 'GEMINI',
    providers: [
      {
        provider: 'OPENCLAW', displayName: 'OpenClaw', runtime: 'openclaw-dedicated-project-agent',
        selectable: true, executionScope: 'PROJECT_SANDBOX', supportsAttachments: true,
        supportsModelSelection: true, supportsAbort: true, supportsReset: true, requiresOAuth: false, reason: '',
      },
      {
        provider: 'GEMINI', displayName: 'Antigravity', runtime: 'antigravity-project-adapter',
        selectable: false, executionScope: null, supportsAttachments: false,
        supportsModelSelection: false, supportsAbort: false, supportsReset: false, requiresOAuth: false, reason: '',
      },
    ],
    supportedProviders: [],
    bindings: [],
    executionContext: { scope: 'PROJECT_SANDBOX', projectId: 'p1', policyFingerprint: 'f' },
    qualifications: {},
    ...overrides,
  });

  it('says the runtime is not installed rather than "not verified yet"', () => {
    const resolved = resolveProjectProviderCapabilities(baseResponse({
      activeProviderRuntime: {
        provider: 'GEMINI', available: false,
        reason: 'Google Antigravity Project runtime is not installed and attested on this server.',
        identityProvider: 'OPENCLAW',
      },
    }) as any);
    expect(resolved.error).toContain('runtime is not installed on this server');
    expect(resolved.error).toContain('Choose a different provider');
    expect(resolved.error).not.toContain('not verified for this project yet');
  });

  it('keeps the working provider selectable so the user can recover', () => {
    const resolved = resolveProjectProviderCapabilities(baseResponse({
      activeProviderRuntime: {
        provider: 'GEMINI', available: false, reason: 'missing', identityProvider: 'OPENCLAW',
      },
    }) as any);
    expect(resolved.providers.find((p) => p.provider === 'OPENCLAW')?.selectable).toBe(true);
    // Switching away is the recovery action, so it must stay enabled.
    expect(canSwitchProjectProvider({
      verificationState: 'failed', serverSelectedProvider: null,
      turnActive: false, transitionPending: false,
    })).toBe(true);
  });

  it('falls back to the verification wording when the runtime is fine', () => {
    const resolved = resolveProjectProviderCapabilities(baseResponse({
      activeProviderRuntime: { provider: 'GEMINI', available: true, reason: null, identityProvider: 'GEMINI' },
    }) as any);
    expect(resolved.error).toContain('is unavailable:');
    expect(resolved.error).not.toContain('runtime is not installed');
  });

  it('tolerates an older server that does not send the field', () => {
    const resolved = resolveProjectProviderCapabilities(baseResponse({}) as any);
    expect(resolved.error).toContain('is unavailable:');
  });
});
