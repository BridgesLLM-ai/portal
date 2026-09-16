import { describe, expect, it } from 'vitest';
import {
  describeModelSource,
  describeMutationError,
  extractHttpsUrls,
  isWizardSignedIn,
  isWizardTerminal,
  parseModelDiscovery,
  parseOAuthProviderSupport,
  readWizardSession,
  readWizardStep,
  sameModel,
} from './openclawAuthWizardContract';

describe('openclawAuthWizardContract', () => {
  it('parses server-reported OAuth support and rejects malformed rows', () => {
    const support = parseOAuthProviderSupport({
      providers: [
        { id: 'openai-codex', supported: true, transport: 'native-wizard', methods: ['oauth'] },
        { id: 'google-gemini-cli', supported: false, reason: 'Gemini CLI OAuth is not installed.', documentationUrl: 'https://docs.openclaw.ai/providers/google' },
      ],
    });
    expect(support).toEqual([
      { id: 'openai-codex', supported: true, transport: 'native-wizard', methods: ['oauth'], authChoice: null, mode: null, code: null, reason: null, documentationUrl: null },
      { id: 'google-gemini-cli', supported: false, transport: null, methods: [], authChoice: null, mode: null, code: null, reason: 'Gemini CLI OAuth is not installed.', documentationUrl: 'https://docs.openclaw.ai/providers/google' },
    ]);
    expect(() => parseOAuthProviderSupport({ providers: [{ id: 'xai' }] })).toThrow(/invalid provider/);
    expect(() => parseOAuthProviderSupport({})).toThrow(/malformed/);
  });

  it('reads wizard steps with options, sensitivity, and https-only links', () => {
    const step = readWizardStep({
      id: 'method',
      type: 'select',
      title: 'Choose how to sign in',
      message: 'Open https://auth.example.com/device then continue. Never http://insecure.example.com.',
      options: [{ value: 'oauth', label: 'ChatGPT sign-in', description: 'Uses your subscription' }, 'api-key'],
      sensitive: false,
      url: 'http://not-https.example.com',
    });
    expect(step).toMatchObject({
      id: 'method',
      type: 'select',
      options: [
        { value: 'oauth', label: 'ChatGPT sign-in', description: 'Uses your subscription' },
        { value: 'api-key', label: 'api-key', description: null },
      ],
      sensitive: false,
      url: null,
    });
    expect(extractHttpsUrls(step!.message)).toEqual(['https://auth.example.com/device']);
    expect(readWizardStep({ type: 'text' })).toBeNull();
  });

  it('only treats a finalized complete session as signed in', () => {
    const complete = readWizardSession({ sessionId: 's1', transport: 'native-wizard', status: 'complete', finalized: true });
    expect(isWizardSignedIn(complete)).toBe(true);
    expect(isWizardSignedIn(readWizardSession({ sessionId: 's1', status: 'complete', finalized: false }))).toBe(false);
    expect(isWizardSignedIn(readWizardSession({ sessionId: 's1', status: 'complete', credentialState: 'absent' }))).toBe(false);
    expect(isWizardSignedIn(readWizardSession({ status: 'complete', finalized: true, credentialState: 'indeterminate' }))).toBe(false);
    expect(isWizardSignedIn(readWizardSession({ status: 'complete', finalized: true, recoveryRequired: true }))).toBe(false);
    expect(isWizardSignedIn(readWizardSession({ status: 'complete' }))).toBe(false);
    expect(isWizardTerminal('cancelled')).toBe(true);
    expect(isWizardTerminal('awaiting_input')).toBe(false);
  });

  it('keeps preset-only model lists unverified and honours server readiness when reported', () => {
    const legacyDefaults = parseModelDiscovery({
      source: 'defaults',
      models: [{ id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' }],
    });
    expect(legacyDefaults.models[0]).toMatchObject({ readiness: 'unknown', registered: false });
    expect(legacyDefaults.readinessReported).toBe(false);
    expect(describeModelSource(legacyDefaults)).toMatch(/candidates only/i);

    const legacyGateway = parseModelDiscovery({
      source: 'gateway',
      models: [{ id: 'claude-cli/claude-opus-5', name: 'Claude Opus 5' }, { id: 'claude-cli/claude-opus-5' }, { id: 'no-prefix' }],
    });
    expect(legacyGateway.models).toEqual([
      { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', description: null, readiness: 'ready', registered: true, runtime: null, reason: null },
    ]);

    const reported = parseModelDiscovery({
      source: 'native',
      runtime: 'claude-cli',
      warnings: ['catalog refreshed'],
      models: [
        { id: 'anthropic/claude-opus-5', readiness: 'ready', registered: false },
        { id: 'anthropic/claude-fable-5-1', readiness: { state: 'unavailable', message: 'Not entitled on this account.' }, registered: false },
      ],
    });
    expect(reported.readinessReported).toBe(true);
    expect(reported.models[1]).toMatchObject({ readiness: 'unavailable', reason: 'Not entitled on this account.' });
    expect(reported.warnings).toEqual(['catalog refreshed']);
    expect(() => parseModelDiscovery({ source: 'gateway' })).toThrow(/malformed/);
  });

  it('compares model ids canonically and formats server rejections with remediation and code', () => {
    expect(sameModel('claude-cli/claude-opus-5', 'anthropic/claude-opus-5')).toBe(true);
    expect(sameModel('anthropic/claude-opus-5', null)).toBe(false);
    expect(describeMutationError({
      response: { status: 503, data: { error: 'This OpenClaw host mutation is unavailable in this release.', remediation: 'Retry after the maintenance operation ships.', code: 'OPENCLAW_HOST_MUTATION_UNAVAILABLE' } },
    }, 'fallback')).toBe('This OpenClaw host mutation is unavailable in this release. Retry after the maintenance operation ships. (OPENCLAW_HOST_MUTATION_UNAVAILABLE)');
    expect(describeMutationError(new Error('boom'), 'fallback')).toBe('boom');
    expect(describeMutationError(undefined, 'fallback')).toBe('fallback');
  });
});
