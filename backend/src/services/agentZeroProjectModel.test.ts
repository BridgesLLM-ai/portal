import {
  AgentZeroProjectModelSelectionError,
  agentZeroProjectModelBindingValue,
  parseAgentZeroProjectModelBinding,
  resolveAllowedAgentZeroProjectModel,
} from './agentZeroProjectModel';

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    available: true as const,
    checkedAt: '2026-07-20T00:00:00.000Z',
    providers: [
      {
        providerId: 'codex_oauth' as const,
        displayName: 'OpenAI Codex',
        accountLabel: 'owner',
        connectionState: 'connected' as const,
        models: [{ id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: '' }],
      },
      {
        providerId: 'gemini_api_oauth' as const,
        displayName: 'Gemini',
        accountLabel: 'owner',
        connectionState: 'expired' as const,
        models: [{ id: 'gpt-5.6-terra', displayName: 'Wrong provider', description: '' }],
      },
    ],
    ...overrides,
  };
}

describe('Agent Zero Project OAuth model selection', () => {
  test('returns only an exact model from one connected provider catalog entry', async () => {
    const modelCatalog = jest.fn(async () => catalog());
    await expect(resolveAllowedAgentZeroProjectModel({
      providerId: 'codex_oauth',
      model: 'gpt-5.6-terra',
    }, { modelCatalog } as any)).resolves.toEqual({
      providerId: 'codex_oauth',
      model: 'gpt-5.6-terra',
    });
    expect(modelCatalog).toHaveBeenCalledTimes(1);
  });

  test('does not borrow a same-named model from an expired or different provider', async () => {
    await expect(resolveAllowedAgentZeroProjectModel({
      providerId: 'gemini_api_oauth',
      model: 'gpt-5.6-terra',
    }, { modelCatalog: async () => catalog() } as any)).rejects.toMatchObject({
      name: 'AgentZeroProjectModelSelectionError',
      code: 'AGENT_ZERO_PROJECT_MODEL_INVALID',
    });
    await expect(resolveAllowedAgentZeroProjectModel({
      providerId: 'codex_oauth',
      model: 'gemini-3.1-pro',
    }, { modelCatalog: async () => catalog() } as any)).rejects.toThrow(/qualification candidate/i);
  });

  test.each([
    ['codex_oauth', 'gpt-5.6-sol'],
    ['codex_oauth', 'codex-auto-review'],
    ['codex_oauth', 'future-unreviewed-model'],
    ['github_copilot_oauth', 'gpt-5.6-terra'],
  ])('rejects unqualified Project candidate %s/%s before catalog access', async (providerId, model) => {
    const modelCatalog = jest.fn(async () => catalog());

    await expect(resolveAllowedAgentZeroProjectModel({
      providerId,
      model,
    }, { modelCatalog } as any)).rejects.toMatchObject({
      name: 'AgentZeroProjectModelSelectionError',
      code: 'AGENT_ZERO_PROJECT_MODEL_INVALID',
      message: expect.stringMatching(/qualification candidate/i),
    });
    expect(modelCatalog).not.toHaveBeenCalled();
  });

  test('fails closed on duplicate provider or model catalog identities', async () => {
    const duplicateProvider = catalog();
    duplicateProvider.providers.push({ ...duplicateProvider.providers[0] });
    await expect(resolveAllowedAgentZeroProjectModel({
      providerId: 'codex_oauth',
      model: 'gpt-5.6-terra',
    }, { modelCatalog: async () => duplicateProvider } as any)).rejects.toThrow(/uniquely/i);

    const duplicateModel = catalog();
    duplicateModel.providers[0].models.push({ ...duplicateModel.providers[0].models[0] });
    await expect(resolveAllowedAgentZeroProjectModel({
      providerId: 'codex_oauth',
      model: 'gpt-5.6-terra',
    }, { modelCatalog: async () => duplicateModel } as any)).rejects.toThrow(/not available/i);
  });

  test('round-trips the exact provider/model binding without ambiguous parsing', () => {
    const selection = { providerId: 'xai_grok_oauth' as const, model: 'grok/code/fast' };
    const binding = agentZeroProjectModelBindingValue(selection);
    expect(binding).toBe('xai_grok_oauth/grok/code/fast');
    expect(parseAgentZeroProjectModelBinding(binding)).toEqual(selection);
    expect(() => parseAgentZeroProjectModelBinding('grok/code/fast')).toThrow(
      AgentZeroProjectModelSelectionError,
    );
  });
});
