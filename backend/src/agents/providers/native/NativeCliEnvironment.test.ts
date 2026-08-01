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
  });
});
