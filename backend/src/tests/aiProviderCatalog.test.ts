import {
  AI_PROVIDERS,
  assertAiProviderGuidedSetupContract,
  getPublicAiProviderCatalog,
  isGuidedSetupAuthTypeAvailable,
} from '../config/aiProviders';

describe('server-owned AI provider catalog', () => {
  it('publishes every provider exactly once without operational validation metadata', () => {
    const catalog = getPublicAiProviderCatalog();
    expect(catalog.map((provider) => provider.id)).toEqual(AI_PROVIDERS.map((provider) => provider.id));
    expect(new Set(catalog.map((provider) => provider.id)).size).toBe(catalog.length);
    for (const provider of catalog) {
      expect(provider).not.toHaveProperty('validationEndpoint');
      expect(provider).not.toHaveProperty('validationMethod');
      expect(provider).not.toHaveProperty('onboardKeyFlag');
      expect(provider.guidedSetup).toBeDefined();
      for (const model of provider.defaultModels) expect(model.id).toContain('/');
    }
  });

  it('makes unsupported guided setup explicit and keeps every selectable API-key flow validated', () => {
    const expectedManual = [
      'opencode',
      'ollama',
      'huggingface',
      'moonshot',
      'venice',
      'cerebras',
      'kilocode',
      'cloudflare-ai-gateway',
      'byteplus',
      'volcengine',
      'custom',
    ];
    const catalog = getPublicAiProviderCatalog();
    expect(catalog
      .filter((provider) => provider.guidedSetup.status === 'manual')
      .map((provider) => provider.id))
      .toEqual(expectedManual);

    for (const provider of AI_PROVIDERS) {
      expect(() => assertAiProviderGuidedSetupContract(provider)).not.toThrow();
      if (
        provider.guidedSetup.status === 'available'
        && provider.guidedSetup.authTypes.includes('api_key')
      ) {
        expect(provider.validationEndpoint).toMatch(/^https:\/\//);
        expect(provider.validationMethod).toBeDefined();
        expect(provider.onboardAuthChoice).toBeTruthy();
        expect(provider.onboardKeyFlag).toBeTruthy();
        expect(isGuidedSetupAuthTypeAvailable(provider.id, 'api_key')).toBe(true);
      }
    }
    for (const providerId of expectedManual) {
      expect(isGuidedSetupAuthTypeAvailable(providerId, 'api_key')).toBe(false);
      expect(isGuidedSetupAuthTypeAvailable(providerId, 'token')).toBe(false);
    }
  });

  it('fails closed when a provider claims an incomplete guided API-key flow', () => {
    const openAi = AI_PROVIDERS.find((provider) => provider.id === 'openai');
    expect(openAi).toBeDefined();
    expect(() => assertAiProviderGuidedSetupContract({
      ...openAi!,
      validationEndpoint: undefined,
    })).toThrow(/complete guided API-key validation\/save contract/i);
  });

  it('uses the session-owned setup-token flow as the primary Anthropic path', () => {
    const anthropic = getPublicAiProviderCatalog().find((provider) => provider.id === 'anthropic');
    expect(anthropic?.primaryAuthType).toBe('setup_token');
    expect(anthropic?.description).toMatch(/session-owned setup-token flow/i);
    expect(anthropic?.description).toMatch(/never imported implicitly/i);
    expect(anthropic?.defaultModels.map((model) => model.id)).toContain('anthropic/claude-sonnet-4-6');
    expect(anthropic?.defaultModels.map((model) => model.id)).toContain('anthropic/claude-fable-5');
    expect(anthropic?.dangerNote).toBeUndefined();
    expect(JSON.stringify(anthropic)).not.toMatch(/extra usage.*(required|enable)|enable.*extra usage/i);
  });

  it('keeps xAI subscription OAuth and API-key billing as explicit separate paths', () => {
    const xai = getPublicAiProviderCatalog().find((provider) => provider.id === 'xai');
    expect(xai?.primaryAuthType).toBe('oauth');
    expect(xai?.authOptions).toEqual([
      expect.objectContaining({ type: 'oauth', recommended: true }),
      expect.objectContaining({ type: 'api_key' }),
    ]);
    expect(`${xai?.pricingNote} ${xai?.description}`).not.toMatch(/free monthly|\$\d+.*credit/i);
  });

  it('publishes Bedrock as AWS SDK setup instead of a fake OAuth flow', () => {
    const bedrock = getPublicAiProviderCatalog().find((provider) => provider.id === 'amazon-bedrock');
    expect(bedrock?.primaryAuthType).toBe('aws_sdk');
    expect(bedrock?.consoleUrl).toBe('https://console.aws.amazon.com/bedrock');
    expect(bedrock?.description).toMatch(/does not use an OAuth browser sign-in/i);
    expect(bedrock?.setupInstructions.map((instruction) => instruction.detail).join(' ')).toMatch(/AWS SDK default credential chain/i);
    expect(bedrock?.setupInstructions.map((instruction) => instruction.detail).join(' ')).toMatch(/amazon-bedrock-provider/i);
  });
});
