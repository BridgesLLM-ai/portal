import { describe, expect, it } from 'vitest';
import { getProviderConfig, parseProviderCatalog } from './providerConfig';

const xaiProvider = {
  id: 'xai',
  name: 'xAI (Grok)',
  tier: 1,
  icon: 'zap',
  primaryAuthType: 'oauth',
  guidedSetup: { status: 'available', authTypes: ['oauth', 'api_key'] },
  authOptions: [
    { type: 'oauth', label: 'Subscription', description: 'Use subscription OAuth.', recommended: true },
    { type: 'api_key', label: 'API key', description: 'Use separate API billing.' },
  ],
  keyPlaceholder: 'xai-...',
  consoleUrl: 'https://console.x.ai/',
  signupUrl: 'https://grok.com/',
  pricingNote: 'API-key usage is billed separately.',
  freeTier: null,
  description: 'Use Grok through OpenClaw.',
  setupInstructions: [{ stepNumber: 1, title: 'Sign in', detail: 'Complete device authorization.' }],
  defaultModels: [
    { id: 'xai/grok-4.3', name: 'Grok 4.3', tier: 'frontier', description: 'General Grok model.' },
    { id: 'xai/grok-build-0.1', name: 'Grok Build', tier: 'balanced', description: 'Coding model.' },
  ],
};

describe('server-owned provider catalog', () => {
  it('parses one provider with multiple auth paths and canonical models', () => {
    const providers = parseProviderCatalog({ source: 'backend', providers: [xaiProvider] });
    const xai = getProviderConfig(providers, 'xai');
    expect(xai?.authOptions).toEqual([
      expect.objectContaining({ type: 'oauth', recommended: true }),
      expect.objectContaining({ type: 'api_key' }),
    ]);
    expect(xai?.defaultModels.map((model) => model.id)).toEqual([
      'xai/grok-4.3',
      'xai/grok-build-0.1',
    ]);
  });

  it('rejects a frontend fallback payload or duplicate provider rows', () => {
    expect(() => parseProviderCatalog({ source: 'frontend', providers: [xaiProvider] })).toThrow(/malformed/i);
    expect(() => parseProviderCatalog({ source: 'backend', providers: [xaiProvider, xaiProvider] })).toThrow(/duplicate/i);
  });

  it('rejects non-canonical model IDs instead of silently upgrading them', () => {
    const invalid = {
      ...xaiProvider,
      defaultModels: [{ ...xaiProvider.defaultModels[0], id: 'grok-4.3' }],
    };
    expect(() => parseProviderCatalog({ source: 'backend', providers: [invalid] })).toThrow(/invalid provider/i);
  });

  it('accepts an AWS SDK provider without treating it as OAuth or an API key', () => {
    const bedrock = {
      ...xaiProvider,
      id: 'amazon-bedrock',
      name: 'Amazon Bedrock',
      primaryAuthType: 'aws_sdk',
      guidedSetup: { status: 'available', authTypes: ['aws_sdk'] },
      authOptions: undefined,
      consoleUrl: 'https://console.aws.amazon.com/bedrock',
      description: 'Uses AWS SDK credentials on the gateway host.',
      defaultModels: [],
    };

    const providers = parseProviderCatalog({ source: 'backend', providers: [bedrock] });
    expect(providers[0]).toMatchObject({ id: 'amazon-bedrock', primaryAuthType: 'aws_sdk' });
  });

  it('requires the backend guided-setup availability contract', () => {
    const unsupported = {
      ...xaiProvider,
      id: 'cerebras',
      name: 'Cerebras',
      primaryAuthType: 'token',
      authOptions: undefined,
      guidedSetup: {
        status: 'manual',
        reason: 'Portal does not render or validate Cerebras token setup yet.',
        action: { url: 'https://inference-docs.cerebras.ai/', label: 'Open Cerebras documentation' },
      },
      defaultModels: [],
    };
    expect(parseProviderCatalog({ source: 'backend', providers: [unsupported] })[0].guidedSetup)
      .toMatchObject({ status: 'manual' });
    expect(() => parseProviderCatalog({
      source: 'backend',
      providers: [{ ...unsupported, guidedSetup: undefined }],
    })).toThrow(/invalid provider/i);
  });
});
