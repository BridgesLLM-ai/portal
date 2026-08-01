import { describe, expect, test } from 'vitest';
import { providerUsesPortalStreamBus } from './agentChatTransport';

describe('agentChatTransport', () => {
  test.each(['OPENCLAW', 'CLAUDE_CODE', 'CODEX', 'GROK', 'AGENT_ZERO', 'GEMINI', 'OLLAMA'])(
    '%s hydrates live turns through the Portal stream bus',
    (provider) => {
      expect(providerUsesPortalStreamBus(provider)).toBe(true);
    },
  );

  test.each(['', undefined])(
    '%s does not claim the Portal stream-bus contract',
    (provider) => {
      expect(providerUsesPortalStreamBus(provider)).toBe(false);
    },
  );
});
