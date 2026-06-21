import fs from 'fs';
import os from 'os';
import path from 'path';

describe('OpenClaw Codex auth bridge', () => {
  const originalHome = process.env.HOME;
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  let tempDir: string;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-auth-'));
    process.env.HOME = path.join(tempDir, 'home');
    process.env.OPENCLAW_HOME = path.join(tempDir, 'openclaw');
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
});
