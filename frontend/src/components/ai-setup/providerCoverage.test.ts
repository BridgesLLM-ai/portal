import { describe, expect, it } from 'vitest';
import { getPublicAiProviderCatalog } from '../../../../backend/src/config/aiProviders';
import type { ProviderStatus } from './ProviderCard';
import { parseProviderCatalog } from './providerConfig';
import {
  HARNESS_BY_PROVIDER,
  PORTAL_NATIVE_ONLY_PROVIDERS,
  buildProviderCoverageMap,
  deriveProviderCoverage,
  getLoginSurface,
  getSharedLoginNote,
  isSubscriptionProvider,
} from './providerCoverage';

// The real server catalog, parsed through the same validator the browser uses.
// Any drift in the backend projection fails here before it reaches the UI.
const catalog = parseProviderCatalog({ source: 'backend', providers: getPublicAiProviderCatalog() });
const byId = new Map(catalog.map((provider) => [provider.id, provider]));

function status(overrides: Partial<ProviderStatus> & { id: string }): ProviderStatus {
  return {
    status: 'unconfigured',
    authType: null,
    profileId: null,
    currentModel: null,
    isDefault: false,
    error: null,
    cooldownUntil: null,
    lastUsed: null,
    expiresAt: null,
    warning: null,
    nativeProvider: null,
    nativeCliAuthStatus: null,
    nativeCliAuthMessage: null,
    nativeCliLoginCommand: null,
    requiresSeparateNativeLogin: false,
    readiness: null,
    ...overrides,
  };
}

// Exact `/api/ai-setup/status` provider rows observed on TEST at 2026-09-15T14:44Z,
// after Robert's real Claude browser sign-in (audit baseline-1789483455673).
const TEST_BASELINE: ProviderStatus[] = [
  status({ id: 'anthropic', status: 'unconfigured', nativeProvider: 'CLAUDE_CODE', nativeCliAuthStatus: 'authenticated' }),
  status({ id: 'openai', status: 'unconfigured' }),
  status({ id: 'openai-codex', status: 'unconfigured', nativeProvider: 'CODEX', nativeCliAuthStatus: 'needs_login' }),
  status({ id: 'google-gemini-cli', status: 'unconfigured' }),
  status({ id: 'google-antigravity', status: 'unconfigured', nativeProvider: 'GEMINI', nativeCliAuthStatus: 'needs_login' }),
  status({ id: 'google', status: 'unconfigured' }),
  status({ id: 'xai', status: 'unconfigured', nativeProvider: 'GROK', nativeCliAuthStatus: 'needs_login' }),
];

describe('providerCoverage against the real server catalog', () => {
  it('classifies every subscription-style provider, including the ones this build cannot sign in', () => {
    const subscription = catalog.filter(isSubscriptionProvider).map((provider) => provider.id).sort();
    expect(subscription).toEqual(['anthropic', 'github-copilot', 'google-antigravity', 'google-gemini-cli', 'openai-codex', 'qwen-portal', 'xai']);
    // The catalog exposes all subscription choices. Live OAuth capability
    // discovery supplies an explanation if the installed core cannot run one.
    for (const id of ['anthropic', 'openai-codex', 'google-gemini-cli', 'xai']) {
      expect(deriveProviderCoverage(byId.get(id)!, undefined)).toMatchObject({
        subscription: true, guided: true, activatesOpenClaw: true,
      });
    }

  });

  it('keeps the login surface split: Claude is shared with OpenClaw, Antigravity/Hermes/OpenCode are Portal-native only', () => {
    expect(getLoginSurface('anthropic')).toBe('shared-native');
    expect(getLoginSurface('google-antigravity')).toBe('portal-native');
    expect(getLoginSurface('openai-codex')).toBe('openclaw');
    expect(getLoginSurface('xai')).toBe('openclaw');
    expect(getSharedLoginNote('anthropic')).toMatch(/same Claude credential store/i);
    expect(getSharedLoginNote('openai-codex')).toBeNull();
    for (const id of PORTAL_NATIVE_ONLY_PROVIDERS) {
      expect(HARNESS_BY_PROVIDER[id]?.login).toBe('harness-only');
    }
  });

  it('reports the TEST baseline truthfully: Claude signed in, OpenClaw not registered, no default', () => {
    const coverage = buildProviderCoverageMap(catalog, new Map(TEST_BASELINE.map((row) => [row.id, row])));

    const anthropic = coverage.get('anthropic')!;
    expect(anthropic.login).toMatchObject({ state: 'ready', label: 'Signed in' });
    expect(anthropic.openclawRuntime).toMatchObject({ state: 'needs_setup', label: 'Not registered' });
    expect(anthropic.openclawRuntime.detail).toMatch(/has not registered this login as a provider profile/i);
    expect(anthropic.harness).toMatchObject({ harness: 'CLAUDE_CODE', name: 'Claude Code', state: 'ready' });
    expect(anthropic.activatesOpenClaw).toBe(true);

    const codex = coverage.get('openai-codex')!;
    expect(codex.login).toMatchObject({ state: 'needs_login', label: 'Not signed in' });
    expect(codex.harness).toMatchObject({ harness: 'CODEX', state: 'needs_login' });

    const antigravity = coverage.get('google-antigravity')!;
    expect(antigravity.login).toMatchObject({ state: 'needs_login' });
    expect(antigravity.openclawRuntime).toMatchObject({ state: 'unavailable', label: 'Not an OpenClaw runtime' });
    expect(antigravity.activatesOpenClaw).toBe(false);

    const xai = coverage.get('xai')!;
    expect(xai.login).toMatchObject({ state: 'needs_login' });
    expect(xai.harness).toMatchObject({ harness: 'GROK', state: 'needs_login' });
  });

  it('turns a registered provider with a current model into a ready OpenClaw runtime and surfaces readiness problems', () => {
    const anthropic = byId.get('anthropic')!;
    expect(deriveProviderCoverage(anthropic, status({
      id: 'anthropic', status: 'configured', authType: 'cli', currentModel: 'anthropic/claude-opus-5', nativeCliAuthStatus: 'authenticated',
    })).openclawRuntime).toMatchObject({ state: 'ready', label: 'Registered · anthropic/claude-opus-5' });

    const bedrock = byId.get('amazon-bedrock')!;
    expect(deriveProviderCoverage(bedrock, status({
      id: 'amazon-bedrock',
      status: 'configured',
      readiness: { state: 'needs_setup', checkedAt: 'now', cached: false, availableModelCount: 0, message: 'No AWS credentials found.' },
    })).openclawRuntime).toMatchObject({ state: 'needs_setup', detail: 'No AWS credentials found.' });

    expect(deriveProviderCoverage(anthropic, status({ id: 'anthropic', status: 'expired', error: 'Stored OAuth credentials expired.' })).openclawRuntime)
      .toMatchObject({ state: 'attention', label: 'Expired' });
  });
});
