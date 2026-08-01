import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getProviderAuthAliases,
  getStaleProviderProfileIds,
  hasAnthropicClaudeCliReferences,
  isClaudeCliModelId,
  mergeProviderRuntimeCatalog,
  OPENCLAW_CODEX_PLUGIN_VERSION,
  parseOpenClawAuthStoreProfiles,
  registerProviderRuntimeModels,
  removeInvalidRuntimeOnlyModelProviderConfigs,
} from '../services/openclawConfigManager';

describe('openclawConfigManager Claude CLI helpers', () => {
  test('defaults to the exact Portal-tested Codex plugin package revision', () => {
    expect(OPENCLAW_CODEX_PLUGIN_VERSION).toBe('2026.7.1-1');
  });

  test('detects claude-cli model ids', () => {
    expect(isClaudeCliModelId('claude-cli/claude-sonnet-4-6')).toBe(true);
    expect(isClaudeCliModelId('anthropic/claude-sonnet-4-6')).toBe(false);
    expect(isClaudeCliModelId(null)).toBe(false);
  });

  test('detects anthropic Claude CLI references from primary model', () => {
    expect(hasAnthropicClaudeCliReferences({
      agents: { defaults: { model: { primary: 'claude-cli/claude-sonnet-4-6' } } },
    })).toBe(true);
  });

  test('detects anthropic Claude CLI references from fallbacks and model registry', () => {
    expect(hasAnthropicClaudeCliReferences({
      agents: {
        defaults: {
          model: { fallbacks: ['openai/gpt-4.1', 'claude-cli/claude-haiku-4-5'] },
          models: {
            'claude-cli/claude-sonnet-4-6': { enabled: true },
          },
        },
      },
    })).toBe(true);
  });

  test('does not report Claude CLI references when none exist', () => {
    expect(hasAnthropicClaudeCliReferences({
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-4.1', fallbacks: ['anthropic/claude-sonnet-4-6'] },
          models: {
            'anthropic/claude-sonnet-4-6': { enabled: true },
          },
        },
      },
    })).toBe(false);
  });
});

describe('openclawConfigManager OpenClaw auth store bridge', () => {
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  const originalProbe = process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE;
  let tempDir: string | null = null;

  afterEach(() => {
    jest.dontMock('child_process');
    jest.resetModules();
    if (originalOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalOpenClawHome;
    }
    if (originalProbe === undefined) {
      delete process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE;
    } else {
      process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE = originalProbe;
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  test('strict merged auth inventory never converts an OpenClaw probe outage into absence', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-auth-strict-'));
    process.env.OPENCLAW_HOME = tempDir;
    process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE = '1';
    fs.writeFileSync(path.join(tempDir, 'openclaw.json'), JSON.stringify({ auth: { profiles: {} } }), { mode: 0o600 });

    let authStoreAvailable = true;
    jest.resetModules();
    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(() => {
        if (!authStoreAvailable) throw new Error('auth control plane unavailable');
        return JSON.stringify({ profiles: [] });
      }),
    }));

    const manager = require('../services/openclawConfigManager');
    expect(manager.readAuthProfiles()).toMatchObject({ profiles: {} });
    authStoreAvailable = false;
    expect(() => manager.readAuthProfilesStrict()).toThrow(/could not verify/i);
  });

  test('async strict auth inventory never joins a fail-open lenient refresh', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-auth-async-strict-'));
    process.env.OPENCLAW_HOME = tempDir;
    process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE = '1';
    fs.writeFileSync(path.join(tempDir, 'openclaw.json'), JSON.stringify({ auth: { profiles: {} } }), { mode: 0o600 });

    const callbacks: Function[] = [];
    const execFile = jest.fn((_cmd: string, _args: string[], _options: any, callback: Function) => {
      callbacks.push(callback);
    });
    jest.resetModules();
    jest.doMock('child_process', () => ({
      execFile,
      execFileSync: jest.fn(() => ''),
    }));

    const manager = require('../services/openclawConfigManager');
    const lenient = manager.readOpenClawAuthStoreProfilesAsync();
    const strict = manager.readAuthProfilesStrictAsync();

    expect(execFile).toHaveBeenCalledTimes(2);
    callbacks[0](new Error('lenient probe failed'), '', '');
    callbacks[1](new Error('strict probe failed'), '', '');
    await expect(lenient).resolves.toEqual({});
    await expect(strict).rejects.toThrow(/could not verify/i);
  });

  test('strict auth inventory treats malformed successful JSON as unavailable', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-auth-malformed-success-'));
    process.env.OPENCLAW_HOME = tempDir;
    process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE = '1';

    jest.resetModules();
    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(() => JSON.stringify({ profiles: 'not-an-inventory' })),
      execFile: jest.fn((_cmd: string, _args: string[], _options: any, callback: Function) => {
        callback(null, JSON.stringify({ profiles: [{ id: 'missing-provider', type: 'oauth' }] }), '');
      }),
    }));

    const manager = require('../services/openclawConfigManager');
    expect(() => manager.readOpenClawAuthStoreProfiles(undefined, { strict: true }))
      .toThrow(/could not verify/i);
    await expect(manager.readOpenClawAuthStoreProfilesAsync(undefined, { strict: true }))
      .rejects.toThrow(/could not verify/i);
  });

  test('treats OpenClaw auth-store Claude CLI profiles as configured credentials', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-auth-'));
    process.env.OPENCLAW_HOME = tempDir;
    process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE = '1';

    fs.writeFileSync(path.join(tempDir, 'openclaw.json'), JSON.stringify({
      auth: {
        order: {
          anthropic: ['anthropic:claude-cli'],
        },
      },
      agents: {
        defaults: {
          model: { primary: 'anthropic/claude-opus-4-8' },
          compaction: {
            model: 'codex/gpt-5.5',
            memoryFlush: { enabled: true },
          },
        },
      },
    }, null, 2));

    jest.resetModules();
    jest.doMock('child_process', () => ({
      execFileSync: jest.fn((cmd: string, args: string[]) => {
        if (cmd === 'openclaw' && args.join(' ') === 'models auth --agent main list --json') {
          return JSON.stringify({
            profiles: [
              {
                id: 'anthropic:claude-cli',
                provider: 'anthropic',
                type: 'oauth',
                email: 'claude-user@example.invalid',
                expiresAt: '2026-06-28T06:27:01.731Z',
              },
            ],
          });
        }
        return '';
      }),
    }));

    const manager = require('../services/openclawConfigManager');
    const authProfiles = manager.readAuthProfiles();
    expect(authProfiles.profiles['anthropic:claude-cli']).toMatchObject({
      provider: 'anthropic',
      type: 'oauth',
      managedBy: 'openclaw-auth-store',
      email: 'claude-user@example.invalid',
    });

    const anthropicStatus = manager.getProviderStatuses().find((status: any) => status.id === 'anthropic');
    expect(anthropicStatus).toMatchObject({
      status: 'configured',
      authType: 'oauth',
      profileId: 'anthropic:claude-cli',
      error: null,
    });

    manager.cleanupStaleProviderAuthProfiles('anthropic', 'anthropic:claude-cli', 'oauth');
    const legacyAuthPath = path.join(tempDir, 'agents', 'main', 'agent', 'auth-profiles.json');
    const legacyAuth = JSON.parse(fs.readFileSync(legacyAuthPath, 'utf8'));
    expect(legacyAuth.profiles['anthropic:claude-cli']).toBeUndefined();
  });

  test('preserves unrecognized OpenClaw auth-store types as unknown', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-auth-unknown-'));
    process.env.OPENCLAW_HOME = tempDir;
    process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE = '1';

    jest.resetModules();
    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(() => JSON.stringify({
        profiles: [{
          id: 'anthropic:future-profile',
          provider: 'anthropic',
          type: 'future-oauth-kind',
        }],
      })),
    }));

    const manager = require('../services/openclawConfigManager');
    expect(manager.readOpenClawAuthStoreProfiles(undefined, { strict: true }))
      .toMatchObject({
        'anthropic:future-profile': {
          provider: 'anthropic',
          type: 'unknown',
          managedBy: 'openclaw-auth-store',
        },
      });
  });

  test('strictly rejects unsupported or ambiguous successful auth-store JSON', () => {
    const malformedInventories = [
      '{}',
      '{"profiles":null}',
      '{"profiles":"none"}',
      '{"profiles":[null]}',
      '{"profiles":[{"provider":"openai","type":"oauth"}]}',
      '{"profiles":[{"id":"openai:one","provider":"","type":"oauth"}]}',
      '{"profiles":[{"id":"openai:one","provider":"openai","type":{}}]}',
      '{"profiles":[{"id":"openai:one","provider":"openai","type":"oauth","mode":{}}]}',
      '{"profiles":[{"id":"openai:one","provider":"openai","type":"oauth","mode":"api_key"}]}',
      '{"profiles":[{"id":"openai:one","provider":"openai","type":"oauth"},{"id":"openai:one","provider":"openai","type":"oauth"}]}',
      '{"profiles":{"openai:one":{"id":"openai:two","provider":"openai","type":"oauth"}}}',
      '{"profiles":{"__proto__":{"provider":"openai","type":"oauth"}}}',
    ];
    for (const inventory of malformedInventories) {
      expect(() => parseOpenClawAuthStoreProfiles(inventory)).toThrow();
    }
  });

  test('normalizes provider ids but preserves future credential types as unknown', () => {
    expect(parseOpenClawAuthStoreProfiles(JSON.stringify({
      profiles: [{
        id: 'openai:future-profile',
        provider: ' OpenAI ',
        type: 'future-oauth-kind',
      }],
    }))).toEqual({
      'openai:future-profile': {
        provider: 'openai',
        type: 'unknown',
        managedBy: 'openclaw-auth-store',
      },
    });
  });

  test('commits xAI API keys through OpenClaw stdin and verifies the exact SQLite profile', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-xai-auth-'));
    process.env.OPENCLAW_HOME = tempDir;
    process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE = '1';
    fs.writeFileSync(path.join(tempDir, 'openclaw.json'), JSON.stringify({
      auth: { order: { xai: ['xai:old-profile'] } },
    }, null, 2), { mode: 0o600 });

    const execFileSyncMock = jest.fn((cmd: string, args: string[], _options?: any) => {
      if (cmd === 'openclaw' && args.join(' ') === 'models auth --agent main list --provider xai --json') {
        return JSON.stringify({
          profiles: [{ id: 'xai:portal-api-key', provider: 'xai', type: 'api_key' }],
        });
      }
      if (cmd === 'openclaw' && args.join(' ') === 'models auth --agent main order get --provider xai --json') {
        return JSON.stringify({ order: null });
      }
      if (cmd === 'openclaw' && args.join(' ') === 'config unset auth.order["xai"]') {
        const configPath = path.join(tempDir!, 'openclaw.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        delete config.auth.order.xai;
        fs.writeFileSync(configPath, JSON.stringify(config));
        return '';
      }
      return '';
    });
    jest.resetModules();
    jest.doMock('child_process', () => ({ execFileSync: execFileSyncMock }));

    const manager = require('../services/openclawConfigManager');
    expect(manager.saveProviderApiKeyToOpenClawAuthStore('xai', 'xai-secret-test')).toEqual({
      profileId: 'xai:portal-api-key',
    });

    const pasteCall = execFileSyncMock.mock.calls.find(([, args]) => args.includes('paste-api-key'));
    expect(pasteCall?.[1]).toEqual([
      'models', 'auth', '--agent', 'main', 'paste-api-key',
      '--provider', 'xai', '--profile-id', 'xai:portal-api-key',
    ]);
    expect(pasteCall?.[1]).not.toContain('xai-secret-test');
    expect(pasteCall?.[2]).toMatchObject({ input: 'xai-secret-test\n' });
    expect(execFileSyncMock).toHaveBeenCalledWith('openclaw', [
      'models', 'auth', '--agent', 'main', 'order', 'get', '--provider', 'xai', '--json',
    ], expect.any(Object));
    expect(execFileSyncMock).not.toHaveBeenCalledWith('openclaw', [
      'models', 'auth', '--agent', 'main', 'order', 'clear', '--provider', 'xai',
    ], expect.any(Object));

    const config = JSON.parse(fs.readFileSync(path.join(tempDir, 'openclaw.json'), 'utf8'));
    expect(config.auth.order.xai).toBeUndefined();
  });

  test('does not mistake a pre-existing fixed xAI profile for a successful key rotation', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-xai-rotate-'));
    process.env.OPENCLAW_HOME = tempDir;
    process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE = '1';
    fs.writeFileSync(path.join(tempDir, 'openclaw.json'), JSON.stringify({}), { mode: 0o600 });

    const execFileSyncMock = jest.fn((_cmd: string, args: string[]) => {
      if (args.includes('list')) {
        return JSON.stringify({ profiles: [{ id: 'xai:portal-api-key', provider: 'xai', type: 'api_key' }] });
      }
      if (args.includes('paste-api-key')) {
        const error: any = new Error('paste failed before replacement was proven');
        error.stderr = 'new-secret appeared and new-secret appeared again';
        throw error;
      }
      return '';
    });
    jest.resetModules();
    jest.doMock('child_process', () => ({ execFileSync: execFileSyncMock }));

    const manager = require('../services/openclawConfigManager');
    try {
      manager.saveProviderApiKeyToOpenClawAuthStore('xai', 'new-secret');
      throw new Error('expected key rotation to fail');
    } catch (error: any) {
      expect(error).toBeInstanceOf(manager.ProviderApiKeySaveError);
      expect(error.credentialState).toBe('indeterminate');
      expect(error.message).not.toContain('new-secret');
      expect(error.message.match(/\[REDACTED\]/g)).toHaveLength(2);
    }
  });

  test('reports a verified xAI credential as committed when later order cleanup fails', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-xai-post-write-'));
    process.env.OPENCLAW_HOME = tempDir;
    process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE = '1';
    fs.writeFileSync(path.join(tempDir, 'openclaw.json'), JSON.stringify({}), { mode: 0o600 });

    let listCalls = 0;
    const execFileSyncMock = jest.fn((_cmd: string, args: string[]) => {
      if (args.includes('list')) {
        listCalls += 1;
        return JSON.stringify({
          profiles: listCalls === 1
            ? []
            : [{ id: 'xai:portal-api-key', provider: 'xai', type: 'api_key' }],
        });
      }
      if (args.join(' ') === 'models auth --agent main order get --provider xai --json') {
        throw new Error('order control plane unavailable');
      }
      return '';
    });
    jest.resetModules();
    jest.doMock('child_process', () => ({ execFileSync: execFileSyncMock }));

    const manager = require('../services/openclawConfigManager');
    try {
      manager.saveProviderApiKeyToOpenClawAuthStore('xai', 'new-secret');
      throw new Error('expected order cleanup to fail');
    } catch (error: any) {
      expect(error).toBeInstanceOf(manager.ProviderApiKeySaveError);
      expect(error.credentialState).toBe('committed');
    }
  });

  test('keeps bundled xAI catalog metadata unconfigured after all credentials are removed', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-xai-disconnected-'));
    process.env.OPENCLAW_HOME = tempDir;
    process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE = '1';
    fs.writeFileSync(path.join(tempDir, 'openclaw.json'), JSON.stringify({}), { mode: 0o600 });

    jest.resetModules();
    jest.doMock('child_process', () => ({
      execFileSync: jest.fn((_cmd: string, args: string[]) => {
        if (args.includes('list')) return JSON.stringify({ profiles: [] });
        return '';
      }),
    }));
    const manager = require('../services/openclawConfigManager');
    fs.mkdirSync(path.dirname(manager.MODELS_JSON_PATH), { recursive: true });
    fs.writeFileSync(manager.MODELS_JSON_PATH, JSON.stringify({
      providers: { xai: { models: [{ id: 'grok-4.3' }] } },
    }), { mode: 0o600 });

    expect(manager.getProviderStatuses().find((status: any) => status.id === 'xai')).toMatchObject({
      status: 'unconfigured',
      error: null,
      profileId: null,
    });
  });

  test('reports Bedrock as externally managed AWS SDK auth instead of OAuth', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-bedrock-manual-'));
    process.env.OPENCLAW_HOME = tempDir;
    process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE = '1';
    fs.writeFileSync(path.join(tempDir, 'openclaw.json'), JSON.stringify({}), { mode: 0o600 });

    jest.resetModules();
    jest.doMock('child_process', () => ({
      execFileSync: jest.fn((_cmd: string, args: string[]) => {
        if (args.includes('list')) return JSON.stringify({ profiles: [] });
        return '';
      }),
    }));

    const manager = require('../services/openclawConfigManager');
    expect(manager.getProviderStatuses().find((status: any) => status.id === 'amazon-bedrock')).toMatchObject({
      status: 'manual',
      authType: 'aws_sdk',
      profileId: null,
      error: null,
      warning: expect.stringMatching(/gateway host.*not Portal/i),
      readiness: null,
    });
  });

  test('reports Bedrock as configured only after read-only model discovery succeeds', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-bedrock-ready-'));
    process.env.OPENCLAW_HOME = tempDir;
    process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE = '1';
    fs.writeFileSync(path.join(tempDir, 'openclaw.json'), JSON.stringify({}), { mode: 0o600 });

    jest.resetModules();
    jest.doMock('child_process', () => ({
      execFileSync: jest.fn((_cmd: string, args: string[]) => {
        if (args.includes('list')) return JSON.stringify({ profiles: [] });
        return '';
      }),
    }));

    const manager = require('../services/openclawConfigManager');
    const readiness = {
      state: 'ready',
      checkedAt: '2026-07-20T23:00:00.000Z',
      cached: false,
      availableModelCount: 2,
      message: 'Read-only discovery found 2 usable Bedrock models.',
    };
    expect(manager.getProviderStatuses({
      authStoreProfiles: {},
      providerReadiness: { 'amazon-bedrock': readiness },
    }).find((status: any) => status.id === 'amazon-bedrock')).toMatchObject({
      status: 'configured',
      authType: 'aws_sdk',
      profileId: null,
      error: null,
      warning: null,
      readiness,
    });
  });

  test('reports xAI status as indeterminate when the locked auth store cannot be read', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-xai-status-error-'));
    process.env.OPENCLAW_HOME = tempDir;
    process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE = '1';
    fs.writeFileSync(path.join(tempDir, 'openclaw.json'), JSON.stringify({}), { mode: 0o600 });

    jest.resetModules();
    jest.doMock('child_process', () => ({
      execFileSync: jest.fn((_cmd: string, args: string[]) => {
        if (args.includes('list')) {
          throw new Error('locked store unavailable');
        }
        return '';
      }),
    }));
    const manager = require('../services/openclawConfigManager');
    expect(manager.getProviderStatuses().find((status: any) => status.id === 'xai')).toMatchObject({
      status: 'error',
      profileId: null,
      authType: null,
    });
  });

  test('coalesces concurrent async provider status reads into one auth-store process', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-xai-status-coalesce-'));
    process.env.OPENCLAW_HOME = tempDir;
    process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE = '1';
    fs.writeFileSync(path.join(tempDir, 'openclaw.json'), JSON.stringify({
      auth: {
        profiles: {
          'xai:portal-oauth-test': { provider: 'xai', mode: 'oauth' },
        },
      },
    }), { mode: 0o600 });

    const execFileMock = jest.fn((cmd: string, args: string[], _options: any, callback: Function) => {
      if (cmd === 'openclaw') {
        const command = args.join(' ');
        if (command === 'plugins info amazon-bedrock --json') {
          setImmediate(() => callback(null, JSON.stringify({
            plugin: { id: 'amazon-bedrock', enabled: true, status: 'loaded' },
          }), ''));
        } else if (command === 'models list --provider amazon-bedrock --json') {
          setImmediate(() => callback(null, JSON.stringify({
            count: 1,
            models: [{ key: 'amazon-bedrock/us.test-model', available: true, missing: false }],
          }), ''));
        } else {
          setImmediate(() => callback(null, JSON.stringify({
            profiles: [{ id: 'xai:portal-oauth-test', provider: 'xai', type: 'oauth' }],
          }), ''));
        }
        return;
      }
      setImmediate(() => callback(new Error('sign-in required'), '', 'Please sign in'));
    });
    jest.resetModules();
    jest.doMock('child_process', () => ({
      execFile: execFileMock,
      execFileSync: jest.fn(() => ''),
    }));

    const manager = require('../services/openclawConfigManager');
    const [first, second, third] = await Promise.all([
      manager.getProviderStatusesAsync(),
      manager.getProviderStatusesAsync(),
      manager.getProviderStatusesAsync(),
    ]);

    expect(execFileMock.mock.calls.filter(([cmd, args]) => (
      cmd === 'openclaw' && args.join(' ').startsWith('models auth ')
    ))).toHaveLength(1);
    expect(execFileMock.mock.calls.filter(([cmd, args]) => (
      cmd === 'openclaw' && args.join(' ') === 'plugins info amazon-bedrock --json'
    ))).toHaveLength(1);
    expect(execFileMock.mock.calls.filter(([cmd, args]) => (
      cmd === 'openclaw' && args.join(' ') === 'models list --provider amazon-bedrock --json'
    ))).toHaveLength(1);
    expect(execFileMock.mock.calls.filter(([cmd]) => cmd === 'agy').length).toBeLessThanOrEqual(1);
    for (const statuses of [first, second, third]) {
      expect(statuses.find((status: any) => status.id === 'xai')).toMatchObject({
        status: 'configured',
        profileId: 'xai:portal-oauth-test',
        authType: 'oauth',
      });
    }
  });

  test('clears an existing OpenClaw auth-store order before removing the config order', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-openclaw-xai-order-'));
    process.env.OPENCLAW_HOME = tempDir;
    process.env.PORTAL_ENABLE_OPENCLAW_AUTH_STORE_PROBE = '1';
    fs.writeFileSync(path.join(tempDir, 'openclaw.json'), JSON.stringify({
      auth: { order: { xai: ['xai:oauth', 'xai:api-key'] } },
    }, null, 2), { mode: 0o600 });

    const execFileSyncMock = jest.fn((_cmd: string, args: string[]) => {
      if (args.join(' ') === 'models auth --agent main order get --provider xai --json') {
        return JSON.stringify({ order: ['xai:oauth', 'xai:api-key'] });
      }
      if (args.join(' ') === 'config unset auth.order["xai"]') {
        const configPath = path.join(tempDir!, 'openclaw.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        delete config.auth.order.xai;
        fs.writeFileSync(configPath, JSON.stringify(config));
      }
      return '';
    });
    jest.resetModules();
    jest.doMock('child_process', () => ({ execFileSync: execFileSyncMock }));

    const manager = require('../services/openclawConfigManager');
    manager.clearProviderAuthOrder('xai');

    expect(execFileSyncMock).toHaveBeenCalledWith('openclaw', [
      'models', 'auth', '--agent', 'main', 'order', 'clear', '--provider', 'xai',
    ], expect.any(Object));
    expect(execFileSyncMock).toHaveBeenCalledWith('openclaw', [
      'config', 'unset', 'auth.order["xai"]',
    ], expect.any(Object));
    const config = JSON.parse(fs.readFileSync(path.join(tempDir, 'openclaw.json'), 'utf8'));
    expect(config.auth.order.xai).toBeUndefined();
  });
});

describe('openclawConfigManager auth profile cleanup helpers', () => {
  test('marks stale same-provider Codex profiles without touching OpenAI API-key profiles', () => {
    const stale = getStaleProviderProfileIds({
      'openai-codex:default': { provider: 'openai-codex' },
      'openai-codex:user@example.com': { provider: 'openai-codex' },
      'openai:default': { provider: 'openai' },
      'google-gemini-cli:default': { provider: 'google-gemini-cli' },
    }, 'openai-codex', 'openai-codex:user@example.com');

    expect(stale).toEqual(['openai-codex:default']);
  });

  test('treats Claude CLI imports as Anthropic profiles for replacement cleanup', () => {
    const stale = getStaleProviderProfileIds({
      'anthropic:manual': { provider: 'anthropic' },
      'anthropic:claude-cli': { provider: 'claude-cli' },
      'openai-codex:default': { provider: 'openai-codex' },
    }, 'anthropic', 'anthropic:claude-cli');

    expect(stale).toEqual(['anthropic:manual']);
  });

  test('uses the same Anthropic cleanup aliases when called from the Claude CLI provider side', () => {
    expect(Array.from(getProviderAuthAliases('claude-cli')).sort()).toEqual(['anthropic', 'claude-cli']);
  });

  test('keeps Gemini CLI and Antigravity auth profiles separate', () => {
    expect(Array.from(getProviderAuthAliases('google-gemini-cli'))).toEqual(['google-gemini-cli']);
    expect(Array.from(getProviderAuthAliases('google-antigravity'))).toEqual(['google-antigravity']);

    const stale = getStaleProviderProfileIds({
      'google-gemini-cli:default': { provider: 'google-gemini-cli' },
      'google-antigravity:default': { provider: 'google-antigravity' },
    }, 'google-gemini-cli', 'google-gemini-cli:default');

    expect(stale).toEqual([]);
  });

  test('keeps xAI OAuth and API-key credentials as separate auth paths', () => {
    const profiles = {
      'xai:oauth-user': { provider: 'xai', type: 'oauth' as const },
      'xai:default': { provider: 'xai', type: 'api_key' as const },
      'xai:old-oauth': { provider: 'xai', type: 'oauth' as const },
    };

    expect(getStaleProviderProfileIds(profiles, 'xai', 'xai:oauth-user', 'oauth')).toEqual(['xai:old-oauth']);
    expect(getStaleProviderProfileIds(profiles, 'xai', 'xai:default', 'api_key')).toEqual([]);
  });
});

describe('openclawConfigManager runtime model catalog helpers', () => {
  test('does not rewrite plugin-owned xAI subscription transport during model registration', () => {
    expect(registerProviderRuntimeModels('xai', ['xai/grok-4.3'], {
      preserveProviderTransport: true,
    })).toEqual({ changed: false, addedModels: [] });
  });

  test('registers Antigravity models without converting the runtime provider into an HTTP API provider', () => {
    const merged = mergeProviderRuntimeCatalog('google-antigravity', {}, [
      'google-antigravity/gemini-3.5-flash',
      'google-antigravity/gemini-3.1-pro-high',
    ]);

    expect(merged.changed).toBe(true);
    expect(merged.addedModels).toEqual([
      'gemini-3.5-flash',
      'gemini-3.1-pro-high',
    ]);
    expect(merged.nextProviderConfig).toEqual({
      models: [
        { id: 'gemini-3.5-flash', name: 'gemini-3.5-flash' },
        { id: 'gemini-3.1-pro-high', name: 'gemini-3.1-pro-high' },
      ],
    });
  });

  test('keeps API provider endpoint config while adding runtime catalog models', () => {
    const merged = mergeProviderRuntimeCatalog('google', { models: ['google/gemini-3.1-flash-lite'] }, [
      'google/gemini-3.1-pro-preview',
    ]);

    expect(merged.nextProviderConfig).toMatchObject({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      api: 'google-generative-ai',
      auth: 'api-key',
      models: [
        { id: 'gemini-3.1-flash-lite', name: 'gemini-3.1-flash-lite' },
        { id: 'gemini-3.1-pro-preview', name: 'gemini-3.1-pro-preview' },
      ],
    });
  });

  test('stores canonical Google model ids as bare Gemini CLI runtime catalog entries', () => {
    const merged = mergeProviderRuntimeCatalog('google-gemini-cli', {}, [
      'google/gemini-3.1-pro-preview',
      'google-gemini-cli/gemini-3-flash-preview',
    ]);

    expect(merged.nextProviderConfig.models).toEqual([
      { id: 'gemini-3.1-pro-preview', name: 'gemini-3.1-pro-preview' },
      { id: 'gemini-3-flash-preview', name: 'gemini-3-flash-preview' },
    ]);
  });

  test('ignores unknown providers instead of creating invalid catalog entries', () => {
    const existing = { models: [{ id: 'custom-model', name: 'Custom Model' }] };
    const merged = mergeProviderRuntimeCatalog('unknown-provider', existing, ['unknown-provider/new-model']);

    expect(merged.changed).toBe(false);
    expect(merged.addedModels).toEqual([]);
    expect(merged.nextProviderConfig).toBe(existing);
  });

  test('removes runtime-only providers that would make OpenClaw config.patch invalid', () => {
    const cleanup = removeInvalidRuntimeOnlyModelProviderConfigs({
      models: {
        providers: {
          anthropic: { baseUrl: 'https://api.anthropic.com', models: [] },
          'google-gemini-cli': {
            models: [{ id: 'gemini-3-flash-preview', name: 'gemini-3-flash-preview' }],
          },
          'google-antigravity': {
            models: [{ id: 'gemini-3.5-flash', name: 'gemini-3.5-flash' }],
          },
        },
      },
    });

    expect(cleanup.removedProviders).toEqual(['google-gemini-cli', 'google-antigravity']);
    expect(cleanup.config.models.providers).toEqual({
      anthropic: { baseUrl: 'https://api.anthropic.com', models: [] },
    });
  });

  test('keeps explicit runtime-provider HTTP configs intact', () => {
    const cleanup = removeInvalidRuntimeOnlyModelProviderConfigs({
      models: {
        providers: {
          'google-gemini-cli': {
            baseUrl: 'https://example.invalid/v1',
            api: 'google-generative-ai',
            models: [],
          },
        },
      },
    });

    expect(cleanup.removedProviders).toEqual([]);
    expect(cleanup.config.models.providers['google-gemini-cli'].baseUrl).toBe('https://example.invalid/v1');
  });
});
