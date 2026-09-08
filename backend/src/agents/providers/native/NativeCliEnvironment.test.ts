import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildNativeCliEnvironment,
  resolveNativeCliCredentialPaths,
} from './NativeCliEnvironment';

describe('NativeCliEnvironment credential paths', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('resolves the same custom homes used by provider execution', () => {
    expect(resolveNativeCliCredentialPaths('CLAUDE_CODE', {
      HOME: '/home/portal',
      CLAUDE_CONFIG_DIR: '/srv/claude-profile',
    })).toEqual(['/srv/claude-profile/.credentials.json']);
    expect(resolveNativeCliCredentialPaths('CODEX', {
      HOME: '/home/portal',
      CODEX_HOME: '/srv/codex-profile',
    })).toEqual(['/srv/codex-profile/auth.json']);
    expect(resolveNativeCliCredentialPaths('GROK', {
      HOME: '/home/portal',
      GROK_AUTH_PATH: '/run/secrets/grok-auth.json',
    })).toEqual(['/run/secrets/grok-auth.json']);
    expect(resolveNativeCliCredentialPaths('HERMES', {
      PORTAL_HERMES_HOME: '/srv/hermes-profile',
    })).toEqual([
      '/srv/hermes-profile/auth.json',
      '/srv/hermes-profile/.env',
      '/srv/hermes-profile/config.yaml',
    ]);
    expect(resolveNativeCliCredentialPaths('OPENCODE', {
      PORTAL_OPENCODE_HOME: '/srv/opencode-profile',
    })).toEqual(['/srv/opencode-profile/data/opencode/auth.json']);
  });

  test('matches the installer-owned default state roots for ACP harness auth', () => {
    expect(resolveNativeCliCredentialPaths('HERMES', {})).toEqual([
      '/var/lib/bridgesllm/hermes/auth.json',
      '/var/lib/bridgesllm/hermes/.env',
      '/var/lib/bridgesllm/hermes/config.yaml',
    ]);
    expect(resolveNativeCliCredentialPaths('OPENCODE', {})).toEqual([
      '/var/lib/bridgesllm/opencode/data/opencode/auth.json',
    ]);
  });

  test('custom Claude OAuth suppresses inherited Anthropic API credentials', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-claude-config-'));
    temporaryDirectories.push(configDir);
    fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'test-oauth-token' },
    }), { mode: 0o600 });

    const env = buildNativeCliEnvironment('CLAUDE_CODE', {
      HOME: '/home/portal',
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_API_KEY: 'must-not-win',
      ANTHROPIC_AUTH_TOKEN: 'must-not-win-either',
    });

    expect(env.CLAUDE_CONFIG_DIR).toBe(configDir);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
  });

  test('host Codex and Claude never inherit an ambient interpreter search path', () => {
    const hostilePath = '/tmp/attacker-bin:/usr/local/bin:/usr/bin';

    expect(buildNativeCliEnvironment('CODEX', { PATH: hostilePath }).PATH).toBe('/usr/bin:/bin');
    expect(buildNativeCliEnvironment('CLAUDE_CODE', { PATH: hostilePath }).PATH).toBe('/usr/bin:/bin');
    expect(buildNativeCliEnvironment('GEMINI', { PATH: hostilePath }).PATH).toBe(hostilePath);
  });
});
