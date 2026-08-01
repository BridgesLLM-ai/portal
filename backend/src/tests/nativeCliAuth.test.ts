import fs from 'fs';
import os from 'os';
import path from 'path';
import { classifyGrokAuthStore, getNativeCliAuthStatus } from '../agents/nativeCliAuth';

describe('Grok Build native credential classification', () => {
  const now = Date.parse('2026-07-18T12:00:00Z');

  test('accepts a scoped API key without a local expiry', () => {
    expect(classifyGrokAuthStore({
      'xai::api_key': {
        key: 'redacted-test-value',
        auth_mode: 'api_key',
      },
    }, now)).toBe('authenticated');
  });

  test('accepts an OAuth credential with a refresh token after access-token expiry', () => {
    expect(classifyGrokAuthStore({
      'xai::oauth': {
        key: 'redacted-access-token',
        refresh_token: 'redacted-refresh-token',
        expires_at: '2026-07-18T11:00:00Z',
      },
    }, now)).toBe('authenticated');
  });

  test('requires login when the only OAuth access token is expired', () => {
    expect(classifyGrokAuthStore({
      'xai::oauth': {
        key: 'redacted-access-token',
        expires_at: Math.floor((now - 60_000) / 1000),
      },
    }, now)).toBe('needs_login');
  });

  test('distinguishes empty and malformed local state', () => {
    expect(classifyGrokAuthStore({}, now)).toBe('needs_login');
    expect(classifyGrokAuthStore({ unexpected: { value: true } }, now)).toBe('unknown');
    expect(classifyGrokAuthStore('not-an-object', now)).toBe('unknown');
  });

  test('reports the update-suppressed native login command', () => {
    const previous = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = 'redacted-test-value';
    try {
      expect(getNativeCliAuthStatus('GROK')).toMatchObject({
        status: 'authenticated',
        loginCommand: 'grok --no-auto-update login --device-auth',
      });
    } finally {
      if (previous === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previous;
    }
  });
});

describe('native CLI custom credential homes', () => {
  test('Claude auth remains usable when an expired access token has a refresh token', () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-claude-home-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    fs.writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'expired-test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() - 60_000,
      },
    }), { mode: 0o600 });
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    try {
      expect(getNativeCliAuthStatus('CLAUDE_CODE')).toMatchObject({ status: 'authenticated' });
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  test('Claude auth still rejects an expired access token with no refresh token', () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-claude-home-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    fs.writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'expired-test-access-token',
        expiresAt: Date.now() - 60_000,
      },
    }), { mode: 0o600 });
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    try {
      expect(getNativeCliAuthStatus('CLAUDE_CODE')).toMatchObject({ status: 'needs_login' });
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  test('Codex auth detection follows CODEX_HOME', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-home-'));
    const previous = process.env.CODEX_HOME;
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: 'test-access-token' },
    }), { mode: 0o600 });
    process.env.CODEX_HOME = codexHome;
    try {
      expect(getNativeCliAuthStatus('CODEX')).toMatchObject({ status: 'authenticated' });
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
