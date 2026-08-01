import { beforeEach, describe, expect, it } from 'vitest';
import {
  createAgentChatProviderModelRequestGate,
  getAgentChatProviderModelsCache,
  invalidateAgentChatProviderModelsCache,
  setAgentChatProviderModelsCache,
} from './agentChatProviderModelsCache';

describe('Agent Chat provider model cache', () => {
  beforeEach(() => invalidateAgentChatProviderModelsCache());

  it('invalidates Agent Zero centrally across Settings and Agent Chat navigation', () => {
    setAgentChatProviderModelsCache('AGENT_ZERO', {
      models: ['codex_oauth/stale-model'],
    }, 1_000);
    expect(getAgentChatProviderModelsCache('agent_zero', 1_100)?.models)
      .toEqual(['codex_oauth/stale-model']);

    invalidateAgentChatProviderModelsCache('AGENT_ZERO');
    expect(getAgentChatProviderModelsCache('AGENT_ZERO', 1_100)).toBeNull();
  });

  it('expires the credential-sensitive Agent Zero catalog after five seconds', () => {
    setAgentChatProviderModelsCache('AGENT_ZERO', {
      models: ['codex_oauth/gpt-5.5'],
    }, 10_000);
    expect(getAgentChatProviderModelsCache('AGENT_ZERO', 14_999)).not.toBeNull();
    expect(getAgentChatProviderModelsCache('AGENT_ZERO', 15_000)).toBeNull();
  });

  it('rejects an older catalog response after a forced refresh starts', () => {
    const gate = createAgentChatProviderModelRequestGate();
    const initialRequest = gate.begin('agent_zero');
    const forcedRefresh = gate.begin('AGENT_ZERO');

    expect(gate.isCurrent('AGENT_ZERO', initialRequest)).toBe(false);
    expect(gate.isCurrent('agent_zero', forcedRefresh)).toBe(true);
  });

  it('orders providers independently', () => {
    const gate = createAgentChatProviderModelRequestGate();
    const agentZeroRequest = gate.begin('AGENT_ZERO');
    const openClawRequest = gate.begin('OPENCLAW');

    expect(gate.isCurrent('AGENT_ZERO', agentZeroRequest)).toBe(true);
    expect(gate.isCurrent('OPENCLAW', openClawRequest)).toBe(true);
  });
});
