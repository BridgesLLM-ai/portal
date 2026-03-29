import { getProviderAvailability } from './providerAvailability';

describe('providerAvailability', () => {
  test('OpenClaw exposes live in-turn steering semantics', () => {
    const provider = getProviderAvailability('OPENCLAW');
    expect(provider.capabilities.adapterFamily).toBe('openclaw-gateway');
    expect(provider.capabilities.adapterKey).toBe('openclaw');
    expect(provider.capabilities.supportsInTurnSteering).toBe(true);
    expect(provider.capabilities.supportsQueuedFollowUps).toBe(false);
    expect(provider.capabilities.followUpMode).toBe('in_turn_inject');
  });

  test.each(['CLAUDE_CODE', 'CODEX', 'GEMINI'] as const)('%s exposes queued native-cli follow-up semantics', (name) => {
    const provider = getProviderAvailability(name);
    expect(provider.capabilities.adapterFamily).toBe('native-cli');
    expect(provider.capabilities.supportsInTurnSteering).toBe(false);
    expect(provider.capabilities.supportsQueuedFollowUps).toBe(true);
    expect(provider.capabilities.followUpMode).toBe('queued_follow_up');
  });

  test('every declared provider exposes adapter + follow-up metadata', () => {
    for (const name of ['OPENCLAW', 'CLAUDE_CODE', 'CODEX', 'AGENT_ZERO', 'GEMINI', 'OLLAMA'] as const) {
      const provider = getProviderAvailability(name);
      expect(provider.capabilities.adapterFamily).toBeTruthy();
      expect(provider.capabilities.adapterKey).toBeTruthy();
      expect(provider.capabilities.followUpMode).toBeTruthy();
      expect(typeof provider.capabilities.supportsInTurnSteering).toBe('boolean');
      expect(typeof provider.capabilities.supportsQueuedFollowUps).toBe('boolean');
    }
  });
});
