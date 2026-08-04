import fs from 'fs';
import os from 'os';
import path from 'path';

describe('OpenClaw Codex auth bridge', () => {
  const originalHome = process.env.HOME;
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  const originalCodexHome = process.env.CODEX_HOME;
  let tempDir: string;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-auth-'));
    process.env.HOME = path.join(tempDir, 'home');
    process.env.OPENCLAW_HOME = path.join(tempDir, 'openclaw');
    delete process.env.CODEX_HOME;
    fs.mkdirSync(process.env.HOME, { recursive: true });
    fs.mkdirSync(process.env.OPENCLAW_HOME, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalOpenClawHome;
    }
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('pins Codex through a dedicated OpenAI auth slot without deleting OpenAI API keys', () => {
    const openclawHome = process.env.OPENCLAW_HOME as string;
    const authProfilesPath = path.join(openclawHome, 'agents', 'main', 'agent', 'auth-profiles.json');
    const configPath = path.join(openclawHome, 'openclaw.json');
    const codexAuthPath = path.join(process.env.HOME as string, '.codex', 'auth.json');
    const openclawCodexAuthPath = path.join(openclawHome, 'agents', 'main', 'agent', 'codex-home', 'auth.json');

    fs.mkdirSync(path.dirname(authProfilesPath), { recursive: true });
    fs.mkdirSync(path.dirname(codexAuthPath), { recursive: true });
    fs.writeFileSync(authProfilesPath, JSON.stringify({
      version: 2,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'sk-test' },
      },
    }, null, 2));
    fs.writeFileSync(configPath, JSON.stringify({
      auth: {
        order: {
          openai: ['openai:default'],
          'openai-codex': ['openai-codex:default'],
        },
        profiles: {
          'openai:default': { provider: 'openai', mode: 'api_key' },
        },
      },
    }, null, 2));
    fs.writeFileSync(codexAuthPath, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      },
    }, null, 2));

    const manager = require('../services/openclawConfigManager');
    const result = manager.pinCodexExternalCliAuthProfile();

    const authProfiles = JSON.parse(fs.readFileSync(authProfilesPath, 'utf8'));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(result).toEqual({ profileId: 'openai:codex-cli', syncedCodexHomeAuth: true });
    expect(authProfiles.profiles['openai:default']).toMatchObject({ type: 'api_key', provider: 'openai', key: 'sk-test' });
    expect(authProfiles.profiles['openai:codex-cli']).toMatchObject({ type: 'oauth', provider: 'openai' });
    expect(config.auth.order.openai[0]).toBe('openai:codex-cli');
    expect(config.auth.order).not.toHaveProperty('openai-codex');
    expect(config.auth.profiles['openai:codex-cli']).toMatchObject({ provider: 'openai', mode: 'oauth' });
    expect(JSON.parse(fs.readFileSync(openclawCodexAuthPath, 'utf8')).tokens.access_token).toBe('access-token');
  });

  test('bridges the exact credential selected by CODEX_HOME', () => {
    const openclawHome = process.env.OPENCLAW_HOME as string;
    const customCodexHome = path.join(tempDir, 'custom-codex-home');
    const authProfilesPath = path.join(openclawHome, 'agents', 'main', 'agent', 'auth-profiles.json');
    const configPath = path.join(openclawHome, 'openclaw.json');
    const openclawCodexAuthPath = path.join(openclawHome, 'agents', 'main', 'agent', 'codex-home', 'auth.json');
    process.env.CODEX_HOME = customCodexHome;

    fs.mkdirSync(path.dirname(authProfilesPath), { recursive: true });
    fs.mkdirSync(customCodexHome, { recursive: true });
    fs.writeFileSync(authProfilesPath, JSON.stringify({ version: 2, profiles: {} }));
    fs.writeFileSync(configPath, JSON.stringify({ auth: { profiles: {}, order: {} } }));
    fs.writeFileSync(path.join(customCodexHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: 'custom-home-access', refresh_token: 'custom-home-refresh' },
    }), { mode: 0o600 });

    const manager = require('../services/openclawConfigManager');
    expect(manager.pinCodexExternalCliAuthProfile()).toMatchObject({ syncedCodexHomeAuth: true });
    expect(JSON.parse(fs.readFileSync(openclawCodexAuthPath, 'utf8')).tokens.access_token)
      .toBe('custom-home-access');
  });

  test('refuses to pin an OpenClaw profile when no usable file credential was copied', () => {
    const openclawHome = process.env.OPENCLAW_HOME as string;
    const authProfilesPath = path.join(openclawHome, 'agents', 'main', 'agent', 'auth-profiles.json');
    const configPath = path.join(openclawHome, 'openclaw.json');
    fs.mkdirSync(path.dirname(authProfilesPath), { recursive: true });
    const originalAuthProfiles = JSON.stringify({ version: 2, profiles: { 'openai:default': { type: 'api_key', provider: 'openai' } } }, null, 2);
    const originalConfig = JSON.stringify({ auth: { profiles: {}, order: { openai: ['openai:default'] } } }, null, 2);
    fs.writeFileSync(authProfilesPath, originalAuthProfiles);
    fs.writeFileSync(configPath, originalConfig);

    const manager = require('../services/openclawConfigManager');
    expect(() => manager.pinCodexExternalCliAuthProfile()).toThrow(/could not bridge a usable file-backed Codex credential/i);
    expect(fs.readFileSync(authProfilesPath, 'utf8')).toBe(originalAuthProfiles);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalConfig);
  });

  test('removes legacy Codex OAuth profiles while preserving real OpenAI API-key profiles', () => {
    const openclawHome = process.env.OPENCLAW_HOME as string;
    const authProfilesPath = path.join(openclawHome, 'agents', 'main', 'agent', 'auth-profiles.json');
    const configPath = path.join(openclawHome, 'openclaw.json');
    const codexAuthPath = path.join(process.env.HOME as string, '.codex', 'auth.json');

    fs.mkdirSync(path.dirname(authProfilesPath), { recursive: true });
    fs.mkdirSync(path.dirname(codexAuthPath), { recursive: true });
    fs.writeFileSync(authProfilesPath, JSON.stringify({
      version: 2,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'sk-test' },
        'openai:codex-cli': { type: 'oauth', provider: 'openai', access: 'current', refresh: 'current' },
        'openai-codex:default': { type: 'oauth', provider: 'openai-codex' },
        'openai-codex:user@example.com': { type: 'oauth', provider: 'openai-codex', access: 'stale', refresh: 'stale' },
        'openai:user@example.com': { type: 'oauth', provider: 'openai-codex', access: 'stale', refresh: 'stale' },
      },
      usageStats: {
        'openai-codex:user@example.com': { errorCount: 2 },
      },
      lastGood: {
        'openai-codex': 'openai-codex:user@example.com',
      },
    }, null, 2));
    fs.writeFileSync(configPath, JSON.stringify({
      auth: {
        order: {
          openai: ['openai-codex:user@example.com', 'openai:default'],
          'openai-codex': ['openai-codex:default'],
          codex: ['codex:default'],
        },
        profiles: {
          'openai:default': { provider: 'openai', mode: 'api_key' },
          'openai:codex-cli': { provider: 'openai', mode: 'oauth' },
          'openai-codex:user@example.com': { provider: 'openai-codex', mode: 'oauth' },
          'codex:default': { provider: 'codex', mode: 'oauth' },
        },
      },
    }, null, 2));
    fs.writeFileSync(codexAuthPath, JSON.stringify({
      tokens: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      },
    }, null, 2));

    const manager = require('../services/openclawConfigManager');
    manager.pinCodexExternalCliAuthProfile();

    const authProfiles = JSON.parse(fs.readFileSync(authProfilesPath, 'utf8'));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    expect(authProfiles.profiles['openai:default']).toMatchObject({ type: 'api_key', provider: 'openai', key: 'sk-test' });
    expect(authProfiles.profiles['openai:codex-cli']).toMatchObject({ type: 'oauth', provider: 'openai' });
    expect(Object.keys(authProfiles.profiles).sort()).toEqual(['openai:codex-cli', 'openai:default']);
    expect(authProfiles.usageStats).not.toHaveProperty('openai-codex:user@example.com');
    expect(authProfiles.lastGood).not.toHaveProperty('openai-codex');
    expect(config.auth.order.openai).toEqual(['openai:codex-cli', 'openai:default']);
    expect(config.auth.order).not.toHaveProperty('openai-codex');
    expect(config.auth.order).not.toHaveProperty('codex');
    expect(Object.keys(config.auth.profiles).sort()).toEqual(['openai:codex-cli', 'openai:default']);
  });

  test('removes stale legacy Codex plugin state without touching current project installs', () => {
    const openclawHome = process.env.OPENCLAW_HOME as string;
    const installsPath = path.join(openclawHome, 'plugins', 'installs.json');
    const staleGlobalPluginDir = path.join(openclawHome, 'npm', 'node_modules', '@openclaw', 'codex');
    const currentProjectPluginSource = path.join(
      openclawHome,
      'npm',
      'projects',
      'openclaw-codex-current',
      'node_modules',
      '@openclaw',
      'codex',
      'dist',
      'index.js',
    );

    fs.mkdirSync(path.dirname(installsPath), { recursive: true });
    fs.mkdirSync(staleGlobalPluginDir, { recursive: true });
    fs.writeFileSync(path.join(staleGlobalPluginDir, 'package.json'), JSON.stringify({
      name: '@openclaw/codex',
      version: '2026.5.27',
    }, null, 2));
    fs.writeFileSync(installsPath, JSON.stringify({
      installRecords: {
        codex: {
          pluginId: 'codex',
          packageName: '@openclaw/codex',
          packageVersion: '2026.5.27',
          source: path.join(staleGlobalPluginDir, 'dist', 'index.js'),
        },
      },
      plugins: [
        {
          pluginId: 'codex',
          packageName: '@openclaw/codex',
          packageVersion: '2026.5.27',
          source: path.join(staleGlobalPluginDir, 'dist', 'index.js'),
        },
        {
          pluginId: 'codex',
          packageName: '@openclaw/codex',
          packageVersion: '2026.6.8',
          source: currentProjectPluginSource,
        },
        {
          pluginId: 'other',
          source: '/tmp/other-plugin/dist/index.js',
        },
      ],
    }, null, 2));

    const manager = require('../services/openclawConfigManager');
    const result = manager.repairOpenClawCodexPluginInstallState('2026.6.8');
    const installs = JSON.parse(fs.readFileSync(installsPath, 'utf8'));

    expect(result).toMatchObject({
      expectedVersion: '2026.6.8',
      removedLegacyInstallRecord: true,
      removedLegacyPluginEntries: 1,
      globalPluginVersion: '2026.5.27',
    });
    expect(result.quarantinedGlobalPluginDir).toContain('plugin-backups');
    expect(installs.installRecords).not.toHaveProperty('codex');
    expect(installs.plugins).toEqual([
      expect.objectContaining({
        pluginId: 'codex',
        packageVersion: '2026.6.8',
        source: currentProjectPluginSource,
      }),
      expect.objectContaining({ pluginId: 'other' }),
    ]);
    expect(fs.existsSync(staleGlobalPluginDir)).toBe(false);
    expect(fs.existsSync(result.quarantinedGlobalPluginDir)).toBe(true);
  });
});
