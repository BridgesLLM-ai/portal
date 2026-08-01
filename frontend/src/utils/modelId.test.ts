import { describe, expect, it } from 'vitest';
import {
  canonicalizePortalModelId,
  getModelDisplayName,
  getModelProviderLabel,
  getModelRuntimeLabel,
  isKnownOpenClawCatalogModelId,
  resolvePortalModelFromCatalog,
} from './modelId';

describe('xAI model presentation and catalog behavior', () => {
  it('preserves canonical xAI model IDs', () => {
    expect(canonicalizePortalModelId('xai/grok-4.3')).toBe('xai/grok-4.3');
    expect(resolvePortalModelFromCatalog('xai/grok-4.3', ['xai/grok-4.3'])).toBe('xai/grok-4.3');
  });

  it('shows Grok with explicit xAI and mixed OAuth/API runtime labels', () => {
    expect(getModelDisplayName('xai/grok-build-0.1')).toBe('Grok Build 0.1');
    expect(getModelProviderLabel('xai/grok-build-0.1')).toBe('xAI');
    expect(getModelRuntimeLabel('xai/grok-build-0.1')).toBe('OAuth/API');
  });

  it('treats live xai/* rows as known OpenClaw catalog selections', () => {
    expect(isKnownOpenClawCatalogModelId('xai/grok-4.3')).toBe(true);
    expect(isKnownOpenClawCatalogModelId('unknown/model')).toBe(false);
  });

  it('renders vendor casing for display names instead of naive capitalization', () => {
    // The old prettifier produced "Gpt 5.6 sol" — wrong acronym case and a
    // lowercase code name — on every model chip and picker row.
    expect(getModelDisplayName('openai/gpt-5.6-sol')).toBe('GPT 5.6 Sol');
    expect(getModelDisplayName('openai/gpt-5.6-terra')).toBe('GPT 5.6 Terra');
    expect(getModelDisplayName('openai/gpt-5.5')).toBe('GPT 5.5');
    expect(getModelDisplayName('anthropic/claude-fable-5')).toBe('Fable 5');
    expect(getModelDisplayName('anthropic/claude-opus-5')).toBe('Opus 5');
    expect(getModelDisplayName('deepseek/deepseek-chat')).toBe('DeepSeek Chat');
    expect(getModelDisplayName('google/gemini-3-pro')).toBe('Gemini 3 Pro');
  });

  it('normalizes Opus 5 aliases to the canonical Anthropic id', () => {
    expect(canonicalizePortalModelId('anthropic/opus-5')).toBe('anthropic/claude-opus-5');
    expect(canonicalizePortalModelId('claude-cli/claude-opus-5')).toBe('anthropic/claude-opus-5');
  });
});

describe('OpenAI model identity', () => {
  it('repairs legacy provider aliases without entitlement-sensitive upgrades', () => {
    expect(canonicalizePortalModelId('openai-codex/gpt-5.4')).toBe('openai/gpt-5.4');
    expect(canonicalizePortalModelId('codex/gpt-5.4-mini')).toBe('openai/gpt-5.4-mini');
    expect(canonicalizePortalModelId('gpt-5.4-codex')).toBe('openai/gpt-5.4');
    expect(canonicalizePortalModelId('openai-codex/gpt-5.5-pro')).toBe('openai/gpt-5.5-pro');
  });

  it('does not replace an unavailable explicit model with a different tier', () => {
    expect(resolvePortalModelFromCatalog('openai/gpt-5.4', ['openai/gpt-5.6-terra'])).toBe('');
  });
});
