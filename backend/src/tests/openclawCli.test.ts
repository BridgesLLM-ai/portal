import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  canonicalizeProviderModelId,
  ensureMemoryFlushMaintenanceModel,
  extractJsonFromCliOutput,
  modelForOpenClawSessionPatch,
  normalizeOpenClawConfigModelId,
  resolvePortalModelFromCatalog,
  usesClaudeCliAuthProfile,
} from '../utils/openclawCli';

describe('openclawCli helpers', () => {
  test('canonicalizeProviderModelId prefixes provider-specific runtime ids', () => {
    expect(canonicalizeProviderModelId('google', 'models/gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
    expect(canonicalizeProviderModelId('google-gemini-cli', 'gemini-3.1-pro-preview')).toBe('google-gemini-cli/gemini-3.1-pro-preview');
    expect(canonicalizeProviderModelId('google-antigravity', 'gemini-3-flash')).toBe('google-antigravity/gemini-3.5-flash');
    expect(canonicalizeProviderModelId('openrouter', 'anthropic/claude-sonnet-4-6')).toBe('openrouter/anthropic/claude-sonnet-4-6');
    expect(canonicalizeProviderModelId('anthropic', 'claude-cli/claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
    expect(canonicalizeProviderModelId('openai-codex', 'gpt-5.5')).toBe('openai/gpt-5.5');
    expect(canonicalizeProviderModelId('openai-codex', 'openai/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(canonicalizeProviderModelId('openai-codex', 'openai-codex/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(canonicalizeProviderModelId('google-gemini-cli', 'google/gemini-2.5-pro')).toBe('google-gemini-cli/gemini-2.5-pro');
    expect(canonicalizeProviderModelId('google-antigravity', 'google-gemini-cli/gemini-3-flash')).toBe('google-antigravity/gemini-3.5-flash');
  });

  test('canonicalizeProviderModelId repairs provider-owned alias subtleties', () => {
    expect(canonicalizeProviderModelId('google-gemini-cli', 'gemini-3.1-flash')).toBe('google-gemini-cli/gemini-3-flash-preview');
    expect(canonicalizeProviderModelId('google-gemini-cli', 'gemini-3.1-flash-lite-preview')).toBe('google-gemini-cli/gemini-3.1-flash-lite');
    expect(canonicalizeProviderModelId('google', 'google-gemini-cli/gemini-3.1-flash-lite-preview')).toBe('google/gemini-3.1-flash-lite');
    expect(canonicalizeProviderModelId('google', 'gemini-3.1-pro')).toBe('google/gemini-3.1-pro-preview');
    expect(canonicalizeProviderModelId('google-antigravity', 'gemini-3.1-pro-preview')).toBe('google-antigravity/gemini-3.1-pro-high');
    expect(canonicalizeProviderModelId('google-antigravity', 'gemini-3-pro-preview')).toBe('google-antigravity/gemini-3.1-pro-high');
    expect(canonicalizeProviderModelId('openai-codex', 'gpt-5.4-codex')).toBe('openai/gpt-5.5');
  });

  test('normalizeOpenClawConfigModelId repairs OpenClaw doctor provider drift conservatively', () => {
    expect(normalizeOpenClawConfigModelId('google/gemini-3-flash-preview')).toBe('google-antigravity/gemini-3-flash-preview');
    expect(normalizeOpenClawConfigModelId('google/gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
    expect(normalizeOpenClawConfigModelId('openai/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(normalizeOpenClawConfigModelId('codex/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(normalizeOpenClawConfigModelId('gpt-5.6')).toBe('openai/gpt-5.6-sol');
    expect(normalizeOpenClawConfigModelId('openai/gpt-5.6-terra')).toBe('openai/gpt-5.6-terra');
    expect(normalizeOpenClawConfigModelId('openai/gpt-4.1')).toBe('openai/gpt-4.1');
  });

  test('usesClaudeCliAuthProfile detects OpenClaw 2026.6 config auth metadata', () => {
    expect(usesClaudeCliAuthProfile({
      auth: {
        profiles: {
          'anthropic:claude-cli': { provider: 'anthropic', mode: 'oauth' },
        },
        order: {
          anthropic: ['anthropic:claude-cli'],
        },
      },
    })).toBe(true);
    expect(usesClaudeCliAuthProfile({ auth: { profiles: { 'anthropic:api': { provider: 'anthropic', mode: 'api_key' } } } })).toBe(false);
  });

  test('ensureMemoryFlushMaintenanceModel pins flushes to the compaction model when omitted', () => {
    const config: any = {
      agents: {
        defaults: {
          compaction: {
            model: 'codex/gpt-5.5',
            memoryFlush: { enabled: true, softThresholdTokens: 6000 },
          },
        },
      },
    };

    expect(ensureMemoryFlushMaintenanceModel(config)).toEqual({ changed: true, model: 'openai/gpt-5.5' });
    expect(config.agents.defaults.compaction.memoryFlush.model).toBe('openai/gpt-5.5');
  });

  test('ensureMemoryFlushMaintenanceModel creates a maintenance flush model from a configured Codex fallback', () => {
    const config: any = {
      auth: {
        order: {
          openai: ['openai:codex-cli'],
        },
      },
      agents: {
        defaults: {
          model: {
            primary: 'anthropic/claude-sonnet-4-6',
            fallbacks: ['anthropic/claude-haiku-4-5', 'codex/gpt-5.5'],
          },
        },
      },
    };

    expect(ensureMemoryFlushMaintenanceModel(config)).toEqual({ changed: true, model: 'openai/gpt-5.5' });
    expect(config.agents.defaults.compaction).toEqual({
      model: 'openai/gpt-5.5',
      memoryFlush: {
        model: 'openai/gpt-5.5',
      },
    });
  });

  test('ensureMemoryFlushMaintenanceModel normalizes existing flush model aliases without inventing a fallback', () => {
    const config = {
      agents: {
        defaults: {
          compaction: {
            model: 'openai/gpt-5.5',
            memoryFlush: { enabled: true, model: 'codex/gpt-5.5' },
          },
        },
      },
    };

    expect(ensureMemoryFlushMaintenanceModel(config)).toEqual({ changed: true, model: 'openai/gpt-5.5' });
    expect(config.agents.defaults.compaction.memoryFlush.model).toBe('openai/gpt-5.5');
    expect(ensureMemoryFlushMaintenanceModel({ agents: { defaults: {} } })).toEqual({ changed: false, model: null });
  });

  test('resolvePortalModelFromCatalog chooses live catalog aliases and rejects unavailable full ids', () => {
    const catalog = ['openai/gpt-5.5', 'openai/gpt-5.4', 'anthropic/claude-sonnet-4-6'];
    expect(resolvePortalModelFromCatalog('openai-codex/gpt-5.5', catalog)).toBe('openai/gpt-5.5');
    expect(resolvePortalModelFromCatalog('openai-codex/gpt-5.5', ['openai/gpt-5.5', 'openai-codex/gpt-5.5'])).toBe('openai/gpt-5.5');
    expect(resolvePortalModelFromCatalog('openai-codex/gpt-5.5', ['codex/gpt-5.5', 'openai/gpt-5.5'])).toBe('openai/gpt-5.5');
    expect(resolvePortalModelFromCatalog('gpt-5.4', catalog)).toBe('openai/gpt-5.5');
    expect(resolvePortalModelFromCatalog('google-gemini-cli/gemini-2.5-flash', catalog)).toBe('');
  });

  test('modelForOpenClawSessionPatch maps OpenAI-family Codex aliases to current runtime ids', () => {
    expect(modelForOpenClawSessionPatch(
      { agentRuntime: { id: 'codex' }, modelProvider: 'openai', model: 'gpt-5.5' },
      'openai/gpt-5.5',
    )).toBe('openai/gpt-5.5');
    expect(modelForOpenClawSessionPatch(
      { agentRuntime: { id: 'codex' }, modelProvider: 'openai', model: 'gpt-5.4-mini' },
      'openai/gpt-5.4-mini',
    )).toBe('openai/gpt-5.5');
    expect(modelForOpenClawSessionPatch(
      { modelProvider: 'openai-codex', model: 'gpt-5.5' },
      'openai-codex/gpt-5.5',
    )).toBe('openai/gpt-5.5');
    expect(modelForOpenClawSessionPatch(
      { agentRuntime: { id: 'codex' }, modelProvider: 'openai-codex', model: 'gpt-5.5' },
      'gpt-5.5',
    )).toBe('openai/gpt-5.5');
    expect(modelForOpenClawSessionPatch(
      { modelProvider: 'openai', model: 'gpt-5.5' },
      'openai/gpt-5.5',
    )).toBe('openai/gpt-5.5');
  });

  test('modelForOpenClawSessionPatch keeps Claude CLI runtime sessions on allowed Anthropic catalog ids', () => {
    expect(modelForOpenClawSessionPatch(
      { agentRuntime: { id: 'claude-cli' }, modelProvider: 'anthropic', model: 'claude-sonnet-4-6' },
      'anthropic/claude-sonnet-4-6',
    )).toBe('anthropic/claude-sonnet-4-6');
    expect(modelForOpenClawSessionPatch(
      { agentRuntimeOverride: 'claude-cli', modelProvider: 'anthropic', model: 'claude-haiku-4-5' },
      'claude-cli/claude-haiku-4-5',
    )).toBe('anthropic/claude-haiku-4-5');
  });

  test('extractJsonFromCliOutput strips non-JSON prefix noise', () => {
    const raw = '[agents/model-providers] refreshed\n[{"id":"gemini-2.5-pro"}]\n';
    const extracted = extractJsonFromCliOutput(raw);
    expect(JSON.parse(extracted)).toEqual([{ id: 'gemini-2.5-pro' }]);
  });
});

describe('openclawCli model declaration self-heal', () => {
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  let tempDir: string | null = null;

  afterEach(() => {
    jest.resetModules();
    if (originalOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalOpenClawHome;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function setupHome(config: any): string {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-cli-'));
    process.env.OPENCLAW_HOME = tempDir;
    fs.writeFileSync(path.join(tempDir, 'openclaw.json'), JSON.stringify(config, null, 2));
    return tempDir;
  }

  function loadModule() {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../utils/openclawCli');
  }

  test('ensureOpenClawModelDeclaration declares catalog models with claude-cli pin for subscription auth', () => {
    const home = setupHome({
      auth: {
        profiles: { 'anthropic:claude-cli': { provider: 'claude-cli', mode: 'oauth' } },
        order: { anthropic: ['anthropic:claude-cli'] },
      },
      agents: {
        defaults: {
          model: { primary: 'anthropic/claude-sonnet-4-6', fallbacks: [] },
          models: { 'anthropic/claude-sonnet-4-6': { agentRuntime: { id: 'claude-cli' } } },
        },
      },
    });
    const mod = loadModule();

    const result = mod.ensureOpenClawModelDeclaration('anthropic/claude-fable-5');
    expect(result).toEqual({ changed: true, model: 'anthropic/claude-fable-5' });

    const written = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    expect(written.agents.defaults.models['anthropic/claude-fable-5']).toEqual({ agentRuntime: { id: 'claude-cli' } });
    // Declaration-only self-heal must not touch the fallback chain.
    expect(written.agents.defaults.model.fallbacks).toEqual([]);

    expect(mod.ensureOpenClawModelDeclaration('anthropic/claude-fable-5')).toEqual({ changed: false, model: 'anthropic/claude-fable-5' });
  });

  test('repairClaudeSubscriptionConfig seeds recommended models for existing subscription auth', () => {
    const home = setupHome({
      auth: {
        profiles: {
          'anthropic:claude-cli': { provider: 'claude-cli', mode: 'oauth' },
        },
        order: { anthropic: ['anthropic:claude-cli'], openai: ['openai:codex-cli'] },
      },
      agents: {
        defaults: {
          model: { primary: 'anthropic/claude-sonnet-4-6', fallbacks: ['openai/gpt-5.5'] },
          models: {
            'anthropic/claude-sonnet-4-6': { agentRuntime: { id: 'claude-cli' } },
            'openai/gpt-5.5': {},
          },
        },
      },
    });
    const mod = loadModule();

    const result = mod.repairClaudeSubscriptionConfig();
    expect(result.changed).toBe(true);

    const written = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    const models = written.agents.defaults.models;
    expect(models['anthropic/claude-fable-5']).toEqual({ agentRuntime: { id: 'claude-cli' } });
    // Sonnet 5 must NOT be seeded: its claude-cli thinking profile is off-only
    // and a sonnet-5 default poisons thinking patches portal-wide.
    expect(models['anthropic/claude-sonnet-5']).toBeUndefined();
    expect(models['openai/gpt-5.6-sol']).toEqual({});
    expect(models['openai/gpt-5.6-terra']).toEqual({});
    expect(models['openai/gpt-5.6-luna']).toEqual({});
    // Seeding must not grow the fallback chain.
    expect(written.agents.defaults.model.fallbacks).toEqual(['openai/gpt-5.5']);
  });

  test('repairClaudeSubscriptionConfig demotes a claude-cli-unusable sonnet-5 default and strips its declarations', () => {
    const home = setupHome({
      auth: {
        profiles: { 'anthropic:claude-cli': { provider: 'claude-cli', mode: 'oauth' } },
        order: { anthropic: ['anthropic:claude-cli'] },
      },
      agents: {
        defaults: {
          model: {
            primary: 'anthropic/claude-sonnet-5',
            fallbacks: ['anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4-5'],
          },
          models: {
            'anthropic/claude-sonnet-5': { agentRuntime: { id: 'claude-cli' } },
            'anthropic/claude-sonnet-4-6': { agentRuntime: { id: 'claude-cli' } },
          },
        },
      },
    });
    const mod = loadModule();

    const result = mod.repairClaudeSubscriptionConfig();
    expect(result.changed).toBe(true);
    expect(result.defaultModel).toBe('anthropic/claude-fable-5');

    const written = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    expect(written.agents.defaults.model.primary).toBe('anthropic/claude-fable-5');
    expect(written.agents.defaults.models['anthropic/claude-sonnet-5']).toBeUndefined();
    expect(written.agents.defaults.models['anthropic/claude-fable-5']).toEqual({ agentRuntime: { id: 'claude-cli' } });
    expect(written.agents.defaults.model.fallbacks).toEqual(['anthropic/claude-haiku-4-5']);
  });
});
