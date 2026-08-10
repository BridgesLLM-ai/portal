import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

import {
  __resetNativeReadinessForTests,
  __setNativeReadinessProbeForTests,
  getCachedNativeProviderReadiness,
  getNativeProviderReadiness,
  invalidateNativeProviderReadiness,
  recordNativeProviderAuthFailure,
} from './nativeProviderReadiness';
import {
  __resetNativeCliAuthForTests,
  getNativeCliAuthStatus,
} from './nativeCliAuth';

const mockedExecFile = jest.mocked(execFile);

describe('nativeProviderReadiness cache and invalidation', () => {
  let codexHome: string;
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    __resetNativeReadinessForTests();
    __resetNativeCliAuthForTests();
    mockedExecFile.mockReset();
    mockedExecFile.mockImplementation(((_command: string, _args: string[], _options: unknown, callback: Function) => {
      callback(null, 'codex-cli 1.2.3', '');
      return {} as any;
    }) as any);
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-readiness-codex-'));
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: 'test-access-token' },
    }), { mode: 0o600 });
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    __resetNativeReadinessForTests();
    __resetNativeCliAuthForTests();
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  test('returns a fresh cached result without spawning another version probe', async () => {
    const first = await getNativeProviderReadiness('CODEX');
    const second = await getNativeProviderReadiness('CODEX');

    expect(first.state).toBe('login_present');
    expect(second).toBe(first);
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
  });

  test('singleflights the CLI version probe across concurrent cold readiness reads', async () => {
    let releaseVersion!: () => void;
    let markVersionStarted!: () => void;
    const versionStarted = new Promise<void>((resolve) => { markVersionStarted = resolve; });
    mockedExecFile.mockImplementation(((_command: string, _args: string[], _options: unknown, callback: Function) => {
      markVersionStarted();
      releaseVersion = () => callback(null, 'codex-cli 1.2.3', '');
      return {} as any;
    }) as any);

    const first = getNativeProviderReadiness('CODEX');
    const second = getNativeProviderReadiness('CODEX');
    await versionStarted;
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    releaseVersion();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toBe(firstResult);
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
  });

  test('singleflights both Antigravity version and live-auth probes across concurrent catalog reads', async () => {
    const geminiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-readiness-gemini-singleflight-'));
    const previousHome = process.env.HOME;
    const previousGeminiKey = process.env.GEMINI_API_KEY;
    const previousGoogleKey = process.env.GOOGLE_API_KEY;
    const configDir = path.join(geminiHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'state.json'), '{}', { mode: 0o600 });
    process.env.HOME = geminiHome;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    let releaseModels!: () => void;
    let markModelsStarted!: () => void;
    const modelsStarted = new Promise<void>((resolve) => { markModelsStarted = resolve; });
    const stdinEnds: jest.Mock[] = [];
    mockedExecFile.mockImplementation(((_command: string, args: string[], _options: any, callback: Function) => {
      const end = jest.fn();
      stdinEnds.push(end);
      expect(_command).toBe('agy');
      expect(_options?.env?.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('1');
      if (args[0] === '--version') callback(null, 'agy 1.1.5', '');
      else if (args[0] === 'models') {
        markModelsStarted();
        releaseModels = () => callback(null, 'gemini-3.1-pro-high', '');
      } else callback(new Error('unexpected command'), '', '');
      return { stdin: { end } } as any;
    }) as any);

    try {
      const first = getNativeProviderReadiness('GEMINI');
      const second = getNativeProviderReadiness('GEMINI');
      await modelsStarted;
      expect(mockedExecFile.mock.calls.filter(([, args]) => Array.isArray(args) && args[0] === '--version')).toHaveLength(1);
      expect(mockedExecFile.mock.calls.filter(([, args]) => Array.isArray(args) && args[0] === 'models')).toHaveLength(1);
      expect(stdinEnds).toHaveLength(2);
      expect(stdinEnds.every((end) => end.mock.calls.length === 1)).toBe(true);
      releaseModels();

      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toMatchObject({ state: 'live_verified', usable: true });
      expect(secondResult).toBe(firstResult);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiKey;
      if (previousGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = previousGoogleKey;
      fs.rmSync(geminiHome, { recursive: true, force: true });
    }
  });

  test('keeps an ambiguous Antigravity live probe fail-closed even when an API key is present', async () => {
    const previousGeminiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-only-key';
    mockedExecFile.mockImplementation(((_command: string, args: string[], _options: unknown, callback: Function) => {
      if (args[0] === '--version') callback(null, 'agy 1.1.5', '');
      else if (args[0] === 'models') callback(new Error('probe failed'), '', 'provider temporarily unavailable');
      else callback(new Error('unexpected command'), '', '');
      return {} as any;
    }) as any);

    try {
      await expect(getNativeProviderReadiness('GEMINI')).resolves.toMatchObject({
        state: 'unknown',
        usable: false,
      });
    } finally {
      if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiKey;
    }
  });

  test('an invalidated in-flight refresh cannot repopulate stale readiness', async () => {
    let releaseProbe!: () => void;
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
    const probeReleased = new Promise<void>((resolve) => { releaseProbe = resolve; });
    __setNativeReadinessProbeForTests('CODEX', async () => {
      markProbeStarted();
      await probeReleased;
      return { state: 'live_verified' };
    });

    const pending = getNativeProviderReadiness('CODEX');
    await probeStarted;
    invalidateNativeProviderReadiness('CODEX');
    releaseProbe();
    await expect(pending).resolves.toMatchObject({ state: 'unknown', usable: false });

    expect(getCachedNativeProviderReadiness('CODEX')).toBeNull();
  });

  test('an in-flight Antigravity success returns the newer fail-closed rejection state', async () => {
    const geminiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-readiness-gemini-race-'));
    const previousHome = process.env.HOME;
    const configDir = path.join(geminiHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'state.json'), '{}', { mode: 0o600 });
    process.env.HOME = geminiHome;

    let releaseModels!: () => void;
    let markModelsStarted!: () => void;
    const modelsStarted = new Promise<void>((resolve) => { markModelsStarted = resolve; });
    mockedExecFile.mockImplementation(((_command: string, args: string[], _options: unknown, callback: Function) => {
      if (args[0] === '--version') callback(null, 'agy 1.1.5', '');
      else if (args[0] === 'models') {
        markModelsStarted();
        releaseModels = () => callback(null, 'gemini-3.1-pro-high', '');
      } else callback(new Error('unexpected command'), '', '');
      return {} as any;
    }) as any);

    try {
      const pending = getNativeProviderReadiness('GEMINI');
      await modelsStarted;
      recordNativeProviderAuthFailure('GEMINI', 'Google provider authentication required (401)');
      releaseModels();

      await expect(pending).resolves.toMatchObject({ state: 'needs_login', usable: false });
      expect(getCachedNativeProviderReadiness('GEMINI')).toMatchObject({
        state: 'needs_login',
        usable: false,
      });
      expect(getNativeCliAuthStatus('GEMINI')).toMatchObject({ status: 'needs_login' });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(geminiHome, { recursive: true, force: true });
    }
  });

  test('a real Antigravity auth rejection invalidates cached success and fails closed immediately', async () => {
    const geminiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-readiness-gemini-'));
    const previousHome = process.env.HOME;
    const configDir = path.join(geminiHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'state.json'), '{}', { mode: 0o600 });
    process.env.HOME = geminiHome;
    mockedExecFile.mockImplementation(((_command: string, args: string[], _options: unknown, callback: Function) => {
      if (args[0] === '--version') callback(null, 'agy 1.1.5', '');
      else if (args[0] === 'models') callback(null, 'gemini-3.1-pro-high', '');
      else callback(new Error('unexpected command'), '', '');
      return {} as any;
    }) as any);

    try {
      const verified = await getNativeProviderReadiness('GEMINI');
      expect(verified).toMatchObject({ state: 'live_verified', usable: true });
      expect(getNativeCliAuthStatus('GEMINI')).toMatchObject({ status: 'authenticated' });

      recordNativeProviderAuthFailure('GEMINI', 'Google provider authentication required (401)');

      expect(getNativeCliAuthStatus('GEMINI')).toMatchObject({ status: 'needs_login' });
      await expect(getNativeProviderReadiness('GEMINI')).resolves.toMatchObject({
        state: 'needs_login',
        usable: false,
      });
      expect(mockedExecFile.mock.calls.filter(([, args]) => Array.isArray(args) && args[0] === 'models')).toHaveLength(1);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(geminiHome, { recursive: true, force: true });
    }
  });

  test('binds a typed Antigravity auth rejection to exact credential content', async () => {
    const geminiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-readiness-gemini-generation-'));
    const previousHome = process.env.HOME;
    const previousGeminiKey = process.env.GEMINI_API_KEY;
    const previousGoogleKey = process.env.GOOGLE_API_KEY;
    const configDir = path.join(geminiHome, '.gemini', 'antigravity-cli');
    // Credential attestation covers specific files, not the whole state
    // directory; jetski_state.pbtxt is the credential-bearing one.
    const statePath = path.join(configDir, 'jetski_state.pbtxt');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ credential: 'first-generation' }), { mode: 0o600 });
    process.env.HOME = geminiHome;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    mockedExecFile.mockImplementation(((_command: string, args: string[], _options: unknown, callback: Function) => {
      if (args[0] === '--version') callback(null, 'agy 1.1.5', '');
      else if (args[0] === 'models') callback(null, 'gemini-3.1-pro-high', '');
      else callback(new Error('unexpected command'), '', '');
      return { stdin: { end: jest.fn() } } as any;
    }) as any);

    try {
      const admitted = await getNativeProviderReadiness('GEMINI');
      expect(admitted).toMatchObject({ state: 'live_verified', usable: true });

      // The adapter has already classified this provider-specific prompt as
      // AUTH_REQUIRED even though the shared raw matcher intentionally does not
      // trust a bare URL. The typed classification must still fail readiness.
      recordNativeProviderAuthFailure(
        'GEMINI',
        'Complete sign-in at https://accounts.google.com/o/oauth2/auth',
        admitted,
        { confirmed: true },
      );

      await expect(getNativeProviderReadiness('GEMINI', { force: true })).resolves.toMatchObject({
        state: 'needs_login',
        usable: false,
        credentialFingerprint: admitted.credentialFingerprint,
      });

      fs.chmodSync(statePath, 0o640);
      const metadataOnlyTime = new Date(Date.now() + 5_000);
      fs.utimesSync(statePath, metadataOnlyTime, metadataOnlyTime);
      fs.utimesSync(configDir, metadataOnlyTime, metadataOnlyTime);
      await expect(getNativeProviderReadiness('GEMINI', { force: true })).resolves.toMatchObject({
        state: 'needs_login',
        usable: false,
        credentialFingerprint: admitted.credentialFingerprint,
      });

      fs.writeFileSync(statePath, JSON.stringify({ credential: 'second-generation' }), { mode: 0o600 });
      const recovered = await getNativeProviderReadiness('GEMINI', { force: true });
      expect(recovered).toMatchObject({ state: 'live_verified', usable: true });
      expect(recovered.credentialFingerprint).not.toBe(admitted.credentialFingerprint);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiKey;
      if (previousGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = previousGoogleKey;
      fs.rmSync(geminiHome, { recursive: true, force: true });
    }
  });

  test('keeps a rejected Claude credential generation blocked until credential material changes', async () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-readiness-claude-generation-'));
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const credentialsPath = path.join(claudeHome, '.credentials.json');
    const firstCredential = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'first-access-token',
        refreshToken: 'first-refresh-token',
      },
    });
    fs.writeFileSync(credentialsPath, firstCredential, { mode: 0o600 });
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    try {
      const admitted = await getNativeProviderReadiness('CLAUDE_CODE');
      expect(admitted).toMatchObject({ state: 'login_present', usable: true });

      recordNativeProviderAuthFailure(
        'CLAUDE_CODE',
        'Claude Code provider error: authentication_failed',
        admitted,
      );

      await expect(getNativeProviderReadiness('CLAUDE_CODE', { force: true })).resolves.toMatchObject({
        state: 'needs_login',
        usable: false,
        credentialFingerprint: admitted.credentialFingerprint,
      });

      // Rewriting the same credential store must not masquerade as a new login.
      fs.writeFileSync(credentialsPath, firstCredential, { mode: 0o600 });
      fs.chmodSync(credentialsPath, 0o640);
      const metadataOnlyTime = new Date(Date.now() + 5_000);
      fs.utimesSync(credentialsPath, metadataOnlyTime, metadataOnlyTime);
      await expect(getNativeProviderReadiness('CLAUDE_CODE', { force: true })).resolves.toMatchObject({
        state: 'needs_login',
        usable: false,
        credentialFingerprint: admitted.credentialFingerprint,
      });

      fs.writeFileSync(credentialsPath, JSON.stringify({
        claudeAiOauth: {
          accessToken: 'second-access-token',
          refreshToken: 'second-refresh-token',
        },
      }), { mode: 0o600 });
      await expect(getNativeProviderReadiness('CLAUDE_CODE', { force: true })).resolves.toMatchObject({
        state: 'login_present',
        usable: true,
      });
    } finally {
      if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  test('an older Claude readiness success cannot overwrite an exact-generation rejection', async () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-readiness-claude-race-'));
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    fs.writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'race-access-token',
        refreshToken: 'race-refresh-token',
      },
    }), { mode: 0o600 });
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    try {
      const admitted = await getNativeProviderReadiness('CLAUDE_CODE');
      let releaseProbe!: () => void;
      let markProbeStarted!: () => void;
      const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
      const probeReleased = new Promise<void>((resolve) => { releaseProbe = resolve; });
      __setNativeReadinessProbeForTests('CLAUDE_CODE', async () => {
        markProbeStarted();
        await probeReleased;
        return { state: 'live_verified' };
      });

      const pending = getNativeProviderReadiness('CLAUDE_CODE', { force: true });
      await probeStarted;
      recordNativeProviderAuthFailure(
        'CLAUDE_CODE',
        'OAuth session expired and could not be refreshed.',
        admitted,
      );
      releaseProbe();

      await expect(pending).resolves.toMatchObject({
        state: 'needs_login',
        usable: false,
        credentialFingerprint: admitted.credentialFingerprint,
      });
      expect(getCachedNativeProviderReadiness('CLAUDE_CODE')).toMatchObject({
        state: 'needs_login',
        usable: false,
      });
    } finally {
      if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });
});
