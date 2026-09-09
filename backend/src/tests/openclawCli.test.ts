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
    expect(canonicalizeProviderModelId('google-gemini-cli', 'gemini-3.1-pro-preview')).toBe('google/gemini-3.1-pro-preview');
    expect(canonicalizeProviderModelId('google-antigravity', 'gemini-3-flash')).toBe('google-antigravity/gemini-3.5-flash');
    expect(canonicalizeProviderModelId('openrouter', 'anthropic/claude-sonnet-4-6')).toBe('openrouter/anthropic/claude-sonnet-4-6');
    expect(canonicalizeProviderModelId('anthropic', 'claude-cli/claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
    expect(canonicalizeProviderModelId('anthropic', 'claude-cli/claude-fable-5.1')).toBe('anthropic/claude-fable-5-1');
    expect(canonicalizeProviderModelId('openai-codex', 'gpt-5.5')).toBe('openai/gpt-5.5');
    expect(canonicalizeProviderModelId('openai-codex', 'openai/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(canonicalizeProviderModelId('openai-codex', 'openai-codex/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(canonicalizeProviderModelId('openai-codex', 'gpt-6-astra')).toBe('openai/gpt-6-astra');
    expect(canonicalizeProviderModelId('google-gemini-cli', 'google/gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
    expect(canonicalizeProviderModelId('google-antigravity', 'google-gemini-cli/gemini-3-flash')).toBe('google-antigravity/gemini-3.5-flash');
  });

  test('canonicalizeProviderModelId repairs provider-owned alias subtleties', () => {
    expect(canonicalizeProviderModelId('google-gemini-cli', 'gemini-3.1-flash')).toBe('google/gemini-3-flash-preview');
    expect(canonicalizeProviderModelId('google-gemini-cli', 'gemini-3.1-flash-lite-preview')).toBe('google/gemini-3.1-flash-lite');
    expect(canonicalizeProviderModelId('google', 'google-gemini-cli/gemini-3.1-flash-lite-preview')).toBe('google/gemini-3.1-flash-lite');
    expect(canonicalizeProviderModelId('google', 'gemini-3.1-pro')).toBe('google/gemini-3.1-pro-preview');
    expect(canonicalizeProviderModelId('google-antigravity', 'gemini-3.1-pro-preview')).toBe('google-antigravity/gemini-3.1-pro-high');
    expect(canonicalizeProviderModelId('google-antigravity', 'gemini-3-pro-preview')).toBe('google-antigravity/gemini-3.1-pro-high');
    expect(canonicalizeProviderModelId('openai-codex', 'gpt-5.4-codex')).toBe('openai/gpt-5.4');
    expect(canonicalizeProviderModelId('openai-codex', 'gpt-5.4-mini')).toBe('openai/gpt-5.4-mini');
    expect(canonicalizeProviderModelId('openai-codex', 'gpt-5.5-pro')).toBe('openai/gpt-5.5-pro');
  });

  test('normalizeOpenClawConfigModelId repairs OpenClaw doctor provider drift conservatively', () => {
    expect(normalizeOpenClawConfigModelId('google/gemini-3-flash-preview')).toBe('google/gemini-3-flash-preview');
    expect(normalizeOpenClawConfigModelId('google-gemini-cli/gemini-3.1-pro-preview')).toBe('google/gemini-3.1-pro-preview');
    expect(normalizeOpenClawConfigModelId('google/gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
    expect(normalizeOpenClawConfigModelId('openai/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(normalizeOpenClawConfigModelId('codex/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(normalizeOpenClawConfigModelId('gpt-5.6')).toBe('openai/gpt-5.6-sol');
    expect(normalizeOpenClawConfigModelId('openai/gpt-5.6-terra')).toBe('openai/gpt-5.6-terra');
    expect(normalizeOpenClawConfigModelId('openai/gpt-4.1')).toBe('openai/gpt-4.1');
  });

  test('canonicalizes only exact Astra aliases without inventing a generic GPT-6 alias', () => {
    expect(normalizeOpenClawConfigModelId('gpt-6-astra')).toBe('openai/gpt-6-astra');
    expect(normalizeOpenClawConfigModelId('openai/gpt-6-astra')).toBe('openai/gpt-6-astra');
    expect(normalizeOpenClawConfigModelId('codex/gpt-6-astra')).toBe('openai/gpt-6-astra');
    expect(normalizeOpenClawConfigModelId('openai-codex/gpt-6-astra')).toBe('openai/gpt-6-astra');
    expect(normalizeOpenClawConfigModelId('gpt-6')).toBe('gpt-6');
    expect(normalizeOpenClawConfigModelId('openai/gpt-6')).toBe('openai/gpt-6');
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
        entries: { main: {} },
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
    const catalog = ['openai/gpt-5.5', 'openai/gpt-5.6-terra', 'openai/gpt-5.4', 'anthropic/claude-sonnet-4-6'];
    expect(resolvePortalModelFromCatalog('openai-codex/gpt-5.5', catalog)).toBe('openai/gpt-5.5');
    expect(resolvePortalModelFromCatalog('openai-codex/gpt-5.5', ['openai/gpt-5.5', 'openai-codex/gpt-5.5'])).toBe('openai/gpt-5.5');
    expect(resolvePortalModelFromCatalog('openai-codex/gpt-5.5', ['codex/gpt-5.5', 'openai/gpt-5.5'])).toBe('openai/gpt-5.5');
    expect(resolvePortalModelFromCatalog('gpt-5.4', catalog)).toBe('openai/gpt-5.4');
    expect(resolvePortalModelFromCatalog('gpt-5.4', ['openai/gpt-5.6-terra'])).toBe('');
    expect(resolvePortalModelFromCatalog('google-gemini-cli/gemini-2.5-flash', ['google/gemini-2.5-flash'])).toBe('google/gemini-2.5-flash');
  });

  test('modelForOpenClawSessionPatch maps OpenAI-family Codex aliases to current runtime ids', () => {
    expect(modelForOpenClawSessionPatch(
      { agentRuntime: { id: 'codex' }, modelProvider: 'openai', model: 'gpt-6-astra' },
      'openai-codex/gpt-6-astra',
    )).toBe('openai/gpt-6-astra');
    expect(modelForOpenClawSessionPatch(
      { agentRuntime: { id: 'codex' }, modelProvider: 'openai', model: 'gpt-5.5' },
      'openai/gpt-5.5',
    )).toBe('openai/gpt-5.5');
    expect(modelForOpenClawSessionPatch(
      { agentRuntime: { id: 'codex' }, modelProvider: 'openai', model: 'gpt-5.4-mini' },
      'openai/gpt-5.4-mini',
    )).toBe('openai/gpt-5.4-mini');
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
        entries: { main: {} },
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

  test('ensureOpenClawModelDeclaration pins Astra only for the 9.1 Codex OAuth profile', () => {
    const home = setupHome({
      auth: {
        order: { openai: ['openai:default'] },
      },
      agents: {
        entries: { main: {} },
        defaults: {
          model: { primary: 'openai/gpt-5.5', fallbacks: [] },
          models: {},
        },
      },
    });
    const authProfilePath = path.join(home, 'agents', 'main', 'agent', 'auth-profiles.json');
    fs.mkdirSync(path.dirname(authProfilePath), { recursive: true });
    fs.writeFileSync(authProfilePath, JSON.stringify({
      version: 1,
      profiles: { 'openai:default': { provider: 'openai', type: 'oauth' } },
    }, null, 2));
    const mod = loadModule();

    expect(mod.ensureOpenClawModelDeclaration('openai-codex/gpt-6-astra')).toEqual({
      changed: true,
      model: 'openai/gpt-6-astra',
    });
    const written = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    expect(written.agents.defaults.models['openai/gpt-6-astra']).toEqual({
      agentRuntime: { id: 'codex' },
    });
    expect(written.models?.providers?.openai).toBeUndefined();
    expect(written.agents.defaults.model).toEqual({ primary: 'openai/gpt-5.5', fallbacks: [] });
  });

  test('ensureOpenClawModelDeclaration does not admit Astra on a retained 7.1 Codex route', () => {
    const home = setupHome({
      auth: { order: { openai: ['openai:codex-cli'] } },
      agents: {
        list: [{ id: 'main', default: true }],
        defaults: {
          model: { primary: 'openai/gpt-5.5', fallbacks: [] },
          models: {},
        },
      },
    });
    const mod = loadModule();

    expect(mod.ensureOpenClawModelDeclaration('gpt-6-astra')).toEqual({
      changed: false,
      model: 'openai/gpt-6-astra',
    });
    const written = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    expect(written.agents.defaults.models['openai/gpt-6-astra']).toBeUndefined();
    expect(written.agents.defaults.model).toEqual({ primary: 'openai/gpt-5.5', fallbacks: [] });
  });

  test('ensureOpenClawModelDeclaration does not treat a 9.1 catalog row as Codex entitlement', () => {
    const home = setupHome({
      auth: {
        profiles: { 'openai:api': { provider: 'openai', mode: 'api_key' } },
        order: { openai: ['openai:api'] },
      },
      agents: {
        entries: { main: {} },
        defaults: {
          model: { primary: 'openai/gpt-5.5', fallbacks: [] },
          models: {},
        },
      },
    });
    const mod = loadModule();

    expect(mod.ensureOpenClawModelDeclaration('openai/gpt-6-astra')).toEqual({
      changed: false,
      model: 'openai/gpt-6-astra',
    });
    const written = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    expect(written.agents.defaults.models['openai/gpt-6-astra']).toBeUndefined();
  });

  test('ensureOpenClawModelDeclaration leaves API-key OpenAI models on ordinary routing', () => {
    const home = setupHome({
      auth: {
        profiles: { 'openai:api': { provider: 'openai', mode: 'api_key' } },
        order: { openai: ['openai:api'] },
      },
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-4.1', fallbacks: [] },
          models: {
            'openai/gpt-4.1': { agentRuntime: { id: 'openclaw' } },
          },
        },
      },
    });
    const mod = loadModule();

    expect(mod.ensureOpenClawModelDeclaration('openai/gpt-4.1-mini')).toEqual({
      changed: true,
      model: 'openai/gpt-4.1-mini',
    });
    const written = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    expect(written.agents.defaults.models['openai/gpt-4.1-mini']).toEqual({});
    expect(written.agents.defaults.models['openai/gpt-4.1']).toEqual({ agentRuntime: { id: 'openclaw' } });
  });

  test('ensureOpenClawModelDeclaration does not infer Codex from an ambiguous mixed OpenAI profile set', () => {
    const home = setupHome({
      auth: {
        profiles: {
          'openai:api': { provider: 'openai', mode: 'api_key' },
          'openai:default': { provider: 'openai', mode: 'oauth' },
        },
        order: { openai: ['openai:api', 'openai:default'] },
      },
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-4.1', fallbacks: [] },
          models: {},
        },
      },
    });
    const mod = loadModule();

    expect(mod.ensureOpenClawModelDeclaration('openai/gpt-4.1-mini')).toEqual({
      changed: true,
      model: 'openai/gpt-4.1-mini',
    });
    const written = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    expect(written.agents.defaults.models['openai/gpt-4.1-mini']).toEqual({});
  });

  test('ensureOpenClawModelDeclaration honors an explicit empty OpenAI auth order over stale OAuth profiles', () => {
    const home = setupHome({
      auth: {
        order: { openai: [] },
      },
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-4.1', fallbacks: [] },
          models: {},
        },
      },
    });
    const authProfilePath = path.join(home, 'agents', 'main', 'agent', 'auth-profiles.json');
    fs.mkdirSync(path.dirname(authProfilePath), { recursive: true });
    fs.writeFileSync(authProfilePath, JSON.stringify({
      version: 1,
      profiles: { 'openai:default': { provider: 'openai', type: 'oauth' } },
    }, null, 2));
    const mod = loadModule();

    expect(mod.ensureOpenClawModelDeclaration('openai/gpt-4.1-mini')).toEqual({
      changed: true,
      model: 'openai/gpt-4.1-mini',
    });
    const written = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    expect(written.agents.defaults.models['openai/gpt-4.1-mini']).toEqual({});
  });

  test.each(['template', 'api-key', 'mixed', 'legacy-id-api-key', 'unordered-api-key', 'custom-endpoint', 'extra-header', 'extra-model'])
  ('maintenance retires only its exact subscription routing template: %s', (kind) => {
    const provider: any = { baseUrl: 'https://api.openai.com/v1', models: [
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', api: 'openai-chatgpt-responses' },
    ] };
    const profiles: any = { 'openai:subscription': { provider: 'openai', mode: 'oauth' } };
    const order = ['openai:subscription'];
    if (kind === 'api-key' || kind === 'mixed') {
      profiles['openai:api'] = { provider: 'openai', mode: 'api_key' };
      if (kind === 'api-key') order.splice(0, 1);
      order.push('openai:api');
    }
    if (kind === 'legacy-id-api-key') {
      profiles['openai:codex-cli'] = { provider: 'openai', mode: 'api_key' };
      order.splice(0, 1, 'openai:codex-cli');
    }
    if (kind === 'unordered-api-key') profiles['openai:api'] = { provider: 'openai', mode: 'api_key' };
    if (kind === 'custom-endpoint') provider.baseUrl = 'https://example.test/v1';
    if (kind === 'extra-header') provider.headers = { 'X-User-Route': 'retained' };
    if (kind === 'extra-model') provider.models.push({ id: 'gpt-5.5', name: 'Custom model' });
    const config = { auth: { profiles, order: { openai: order } }, models: { providers: { openai: provider } },
      agents: { entries: { main: {} }, defaults: {
        model: { primary: 'openai/gpt-5.5', fallbacks: [] },
        models: { 'openai/gpt-6-astra': { agentRuntime: { id: 'codex' } } },
      } } };
    const home = setupHome(config), mod = loadModule();
    mod.repairClaudeSubscriptionConfig();
    const written = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    expect(written.models.providers.openai).toEqual(kind === 'template' ? undefined : provider);
    expect(written.auth).toEqual(config.auth);
    expect(written.agents.defaults.model).toEqual(config.agents.defaults.model);
    mod.repairClaudeSubscriptionConfig();
    const repeated = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    expect(repeated.models.providers.openai).toEqual(kind === 'template' ? undefined : provider);
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
        entries: { main: {} },
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
    expect(models['anthropic/claude-fable-5-1']).toEqual({ agentRuntime: { id: 'claude-cli' } });
    expect(models['anthropic/claude-fable-5']).toEqual({ agentRuntime: { id: 'claude-cli' } });
    // Sonnet 5 must NOT be seeded: its claude-cli thinking profile is off-only
    // and a sonnet-5 default poisons thinking patches portal-wide.
    expect(models['anthropic/claude-sonnet-5']).toBeUndefined();
    expect(models['openai/gpt-6-astra']).toEqual({ agentRuntime: { id: 'codex' } });
    expect(models['openai/gpt-5.6-sol']).toEqual({ agentRuntime: { id: 'codex' } });
    expect(models['openai/gpt-5.6-terra']).toEqual({ agentRuntime: { id: 'codex' } });
    expect(models['openai/gpt-5.6-luna']).toEqual({ agentRuntime: { id: 'codex' } });
    expect(models['openai/gpt-5.5']).toEqual({ agentRuntime: { id: 'codex' } });
    // A newly declared model is selectable, not an implicit routing migration.
    expect(written.agents.defaults.model.primary).toBe('anthropic/claude-sonnet-4-6');
    // Seeding must not grow the fallback chain.
    expect(written.agents.defaults.model.fallbacks).toEqual(['openai/gpt-5.5']);
  });

  test('repairClaudeSubscriptionConfig moves only legacy Codex refs onto explicit Codex runtime policy', () => {
    const home = setupHome({
      auth: {
        profiles: { 'openai:api': { provider: 'openai', mode: 'api_key' } },
        order: { openai: ['openai:api'] },
      },
      agents: {
        entries: { main: {} },
        defaults: {
          model: { primary: 'openai/gpt-4.1', fallbacks: ['codex/gpt-5.4'] },
          models: {
            'openai/gpt-4.1': {},
            'codex/gpt-5.4': {
              alias: 'Legacy subscription route',
              agentRuntime: { id: 'codex-cli', fallback: 'none' },
            },
          },
        },
      },
    });
    const mod = loadModule();

    expect(mod.repairClaudeSubscriptionConfig().changed).toBe(true);
    const written = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    expect(written.agents.defaults.models['openai/gpt-4.1']).toEqual({});
    expect(written.agents.defaults.models['openai/gpt-5.4']).toEqual({
      alias: 'Legacy subscription route',
      agentRuntime: { id: 'codex', fallback: 'none' },
    });
    expect(written.agents.defaults.models['codex/gpt-5.4']).toBeUndefined();
    expect(written.agents.defaults.model.fallbacks).toEqual(['openai/gpt-5.4']);
  });

  test('retained 2026.7.1 config removes 9.1-only Codex runtime pins', () => {
    const home = setupHome({
      auth: {
        order: { openai: ['openai:codex-cli'] },
      },
      agents: {
        list: [{ id: 'main', default: true }],
        defaults: {
          model: { primary: 'openai/gpt-5.5', fallbacks: [] },
          models: {
            'openai/gpt-5.5': { agentRuntime: { id: 'codex' } },
          },
        },
      },
    });
    const mod = loadModule();

    expect(mod.repairClaudeSubscriptionConfig().changed).toBe(true);
    const written = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    expect(written.agents.list).toEqual([{ id: 'main', default: true }]);
    expect(written.agents.defaults.models['openai/gpt-5.5']).toEqual({});
    expect(written.agents.defaults.models['openai/gpt-5.6-sol']).toEqual({});
    expect(written.agents.defaults.models['openai/gpt-6-astra']).toBeUndefined();
  });

  test('retained 7.1 Claude subscription never seeds or admits Fable 5.1', () => {
    const home = setupHome({
      auth: { profiles: { 'anthropic:claude-cli': { provider: 'claude-cli', mode: 'oauth' } }, order: { anthropic: ['anthropic:claude-cli'] } },
      agents: { list: [{ id: 'main' }], defaults: { model: { primary: 'anthropic/claude-fable-5' }, models: {} } },
    });
    const mod = loadModule();
    mod.repairClaudeSubscriptionConfig();
    expect(mod.ensureOpenClawModelDeclaration('anthropic/claude-fable-5-1').changed).toBe(false);
    const written = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    expect(written.agents.defaults.models['anthropic/claude-fable-5-1']).toBeUndefined();
    expect(written.agents.defaults.models['anthropic/claude-fable-5']).toBeDefined();
  });

  test('Codex declaration refuses a missing or mixed roster contract', () => {
    for (const agents of [
      { defaults: { models: {} } },
      { list: [{ id: 'main' }], entries: { main: {} }, defaults: { models: {} } },
    ]) {
      setupHome({
        auth: { order: { openai: ['openai:codex-cli'] } },
        agents,
      });
      const mod = loadModule();
      expect(() => mod.ensureOpenClawModelDeclaration('openai/gpt-5.5')).toThrow(/roster contract/i);
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
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
