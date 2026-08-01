import { describe, expect, it } from 'vitest';
import {
  isAgentZeroDefaultModelAlias,
  normalizeAgentChatModelCatalog,
  normalizeAgentChatModelId,
  normalizeAgentChatProvider,
  resolveAgentZeroCatalogModel,
} from './agentChatModelSelection';

describe('Agent Chat provider-scoped model selection', () => {
  it('normalizes provider keys before catalog lookup', () => {
    expect(normalizeAgentChatProvider(' agent_zero ')).toBe('AGENT_ZERO');
  });

  it('keeps OpenClaw ids qualified but converts native CLI catalogs to runtime ids', () => {
    expect(normalizeAgentChatModelId('OPENCLAW', 'codex/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(normalizeAgentChatModelId('CLAUDE_CODE', 'anthropic/claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(normalizeAgentChatModelId('CODEX', 'openai/gpt-5.5')).toBe('gpt-5.5');
    expect(normalizeAgentChatModelId('GROK', 'xai/grok-4')).toBe('grok-4');
    expect(normalizeAgentChatModelId('GEMINI', 'google-antigravity/gemini-3.5-flash')).toBe('gemini-3.5-flash');
  });

  it('preserves opaque Ollama tags even when they resemble Portal aliases', () => {
    expect(normalizeAgentChatModelId('OLLAMA', 'gpt-5.5')).toBe('gpt-5.5');
    expect(normalizeAgentChatModelId('OLLAMA', 'codex/gpt-5.5')).toBe('codex/gpt-5.5');
    expect(normalizeAgentChatModelCatalog('OLLAMA', [
      'gpt-5.5',
      'codex/gpt-5.5',
    ])).toEqual(['gpt-5.5', 'codex/gpt-5.5']);
  });

  it('preserves Agent Zero provider/model pairs and de-duplicates after normalization', () => {
    expect(normalizeAgentChatModelId('AGENT_ZERO', 'codex_oauth/gpt-5.5')).toBe('codex_oauth/gpt-5.5');
    expect(normalizeAgentChatModelCatalog('CODEX', [
      'openai/gpt-5.5',
      'codex/gpt-5.5',
      'gpt-5.5',
    ])).toEqual(['gpt-5.5']);
  });

  it('rejects Default/reset aliases only for Agent Zero exact-catalog selection', () => {
    expect(isAgentZeroDefaultModelAlias('AGENT_ZERO', 'default')).toBe(true);
    expect(isAgentZeroDefaultModelAlias('agent_zero', ' RESET ')).toBe(true);
    expect(isAgentZeroDefaultModelAlias('CODEX', 'default')).toBe(false);
    expect(isAgentZeroDefaultModelAlias('AGENT_ZERO', 'codex_oauth/default')).toBe(false);
  });

  it('keeps Agent Zero inactive without a catalog and replaces stale Sol only after Terra is catalog-backed', () => {
    const catalog = ['codex_oauth/gpt-5.6-terra', 'github_copilot/claude-sonnet-4'];

    expect(resolveAgentZeroCatalogModel('github_copilot/claude-sonnet-4', catalog))
      .toBe('github_copilot/claude-sonnet-4');
    expect(resolveAgentZeroCatalogModel('codex_oauth/gpt-5.6-sol', catalog))
      .toBe('codex_oauth/gpt-5.6-terra');
    expect(resolveAgentZeroCatalogModel('codex_oauth/gpt-5.6-sol', []))
      .toBe('');
    expect(resolveAgentZeroCatalogModel('', []))
      .toBe('');
  });
});
