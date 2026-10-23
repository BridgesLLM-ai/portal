import { describe, expect, it } from 'vitest';
import { isAnyNativeAgentChatSessionId, isNativeAgentChatProvider, nativeAgentChatSessionId } from './nativeAgentSession';

const CODEX_ID = 'codex-11111111-2222-4333-8444-555555555555-1760000000000-6a1b2c3d';

describe('native Agent Chat session ids', () => {
  it('names every harness the Portal runs itself, never OpenClaw', () => {
    for (const provider of ['CLAUDE_CODE', 'CODEX', 'GROK', 'AGENT_ZERO', 'GEMINI', 'OLLAMA', 'HERMES', 'OPENCODE']) {
      expect(isNativeAgentChatProvider(provider)).toBe(true);
    }
    expect(isNativeAgentChatProvider('OPENCLAW')).toBe(false);
    expect(isNativeAgentChatProvider('codex')).toBe(true);
  });

  it('accepts only an exact id minted for the same harness', () => {
    expect(nativeAgentChatSessionId('CODEX', CODEX_ID)).toBe(CODEX_ID);
    expect(nativeAgentChatSessionId('claude_code', 'claude_code-u1-1-x')).toBe('claude_code-u1-1-x');
    expect(nativeAgentChatSessionId('CLAUDE_CODE', CODEX_ID)).toBeNull();
    expect(nativeAgentChatSessionId('OPENCLAW', CODEX_ID)).toBeNull();
  });

  it('never treats Portal aliases or malformed values as a native session', () => {
    for (const value of ['main', 'new-1760000000000', 'agent:main:main', 'codex-', '', ` ${CODEX_ID}`, `${CODEX_ID}\n`, 'codex-a b', `codex-${'x'.repeat(600)}`]) {
      expect(nativeAgentChatSessionId('CODEX', value)).toBeNull();
    }
    expect(nativeAgentChatSessionId('CODEX', undefined)).toBeNull();
    expect(nativeAgentChatSessionId('CODEX', 42)).toBeNull();
  });

  it('recognizes a native id for any harness by its prefix', () => {
    expect(isAnyNativeAgentChatSessionId(CODEX_ID)).toBe(true);
    expect(isAnyNativeAgentChatSessionId('agent_zero-u1-1-x')).toBe(true);
    expect(isAnyNativeAgentChatSessionId('agent:main:portal-1')).toBe(false);
    expect(isAnyNativeAgentChatSessionId('main')).toBe(false);
  });
});
