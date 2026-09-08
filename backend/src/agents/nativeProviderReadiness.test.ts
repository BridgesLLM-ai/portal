import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));
jest.mock('../services/nativeHostCliAdmission', () => ({
  attestNativeHostCli: jest.fn(),
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
import { attestNativeHostCli } from '../services/nativeHostCliAdmission';

const mockedExecFile = jest.mocked(execFile);
const mockedNativeHostCliAdmission = jest.mocked(attestNativeHostCli);

describe('nativeProviderReadiness cache and invalidation', () => {
  let codexHome: string;
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    __resetNativeReadinessForTests();
    __resetNativeCliAuthForTests();
    mockedNativeHostCliAdmission.mockReset();
    mockedNativeHostCliAdmission.mockImplementation(async (toolId, executablePath) => ({
      toolId,
      executablePath: executablePath || (toolId === 'codex' ? '/usr/bin/codex' : '/usr/bin/claude'),
      packageName: toolId === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code',
      version: toolId === 'codex' ? '0.153.2' : '2.1.260',
      fingerprint: 'a'.repeat(64),
      checkedAt: new Date().toISOString(),
    }));
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

  test('reports admitted host Codex advisory-ready without spawning the CLI', async () => {
    await expect(getNativeProviderReadiness('CODEX')).resolves.toMatchObject({
      state: 'login_present',
      usable: true,
      message: expect.stringContaining('login is present locally'),
      credentialFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      runtimeFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      runtimeVersion: '0.153.2',
    });
    expect(mockedNativeHostCliAdmission).toHaveBeenCalledWith('codex', '/usr/bin/codex');
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  test('keeps host Codex fail-closed when filesystem admission detects drift', async () => {
    mockedNativeHostCliAdmission.mockRejectedValueOnce(Object.assign(
      new Error('native host CLI drift'),
      { code: 'DRIFT_DETECTED' },
    ));

    await expect(getNativeProviderReadiness('CODEX', { force: true })).resolves.toMatchObject({
      state: 'runtime_unavailable',
      usable: false,
      message: expect.stringContaining('DRIFT_DETECTED'),
      runtimeInstalled: true,
      runtimeAdmissionCode: 'DRIFT_DETECTED',
    });
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  test('does not let an in-flight host admission overwrite a newer auth rejection', async () => {
    const admitted = await getNativeProviderReadiness('CODEX');
    let markAdmissionStarted!: () => void;
    let releaseAdmission!: () => void;
    const admissionStarted = new Promise<void>((resolve) => { markAdmissionStarted = resolve; });
    const admissionReleased = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    mockedNativeHostCliAdmission.mockImplementationOnce(async (toolId, executablePath) => {
      markAdmissionStarted();
      await admissionReleased;
      return {
        toolId,
        executablePath: executablePath || '/usr/bin/codex',
        packageName: '@openai/codex',
        version: '0.153.2',
        fingerprint: 'b'.repeat(64),
        checkedAt: new Date().toISOString(),
      };
    });

    const pending = getNativeProviderReadiness('CODEX', { force: true });
    await admissionStarted;
    recordNativeProviderAuthFailure(
      'CODEX',
      'The provider rejected this credential generation.',
      admitted,
      { confirmed: true },
    );
    releaseAdmission();

    await expect(pending).resolves.toMatchObject({
      state: 'needs_login',
      usable: false,
      runtimeVersion: '0.153.2',
      runtimeInstalled: true,
    });
    expect(getCachedNativeProviderReadiness('CODEX')).toMatchObject({
      state: 'needs_login',
      runtimeVersion: '0.153.2',
      runtimeInstalled: true,
    });
  });

  test('reports package drift before a retained auth rejection for the same credentials', async () => {
    const admitted = await getNativeProviderReadiness('CODEX');
    recordNativeProviderAuthFailure(
      'CODEX',
      'The provider rejected this credential generation.',
      admitted,
      { confirmed: true },
    );
    mockedNativeHostCliAdmission.mockRejectedValueOnce(Object.assign(
      new Error('native host CLI drift'),
      {
        code: 'DRIFT_DETECTED',
        observedVersion: '0.145.0',
      },
    ));

    await expect(getNativeProviderReadiness('CODEX', { force: true })).resolves.toMatchObject({
      state: 'runtime_unavailable',
      usable: false,
      runtimeVersion: '0.145.0',
      runtimeInstalled: true,
      runtimeAdmissionCode: 'DRIFT_DETECTED',
    });
  });

  test('returns a fresh cached Project Sandbox result without spawning a host version probe', async () => {
    const first = await getNativeProviderReadiness('CODEX', { executionScope: 'PROJECT_SANDBOX' });
    const second = await getNativeProviderReadiness('CODEX', { executionScope: 'PROJECT_SANDBOX' });

    expect(first.state).toBe('login_present');
    expect(second).toBe(first);
    expect(mockedNativeHostCliAdmission).not.toHaveBeenCalled();
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  test.each([
    ['HERMES', 'PORTAL_HERMES_HOME', 'hermes', ['acp', '--version']],
    ['OPENCODE', 'PORTAL_OPENCODE_HOME', 'opencode', ['--version']],
  ] as const)('%s readiness probes the exact CLI inside its isolated environment', async (
    provider,
    rootVariable,
    command,
    versionArgs,
  ) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `portal-readiness-${provider.toLowerCase()}-`));
    const previousRoot = process.env[rootVariable];
    const previousJwt = process.env.JWT_SECRET;
    process.env[rootVariable] = root;
    process.env.JWT_SECRET = 'must-not-leak';
    if (provider === 'HERMES') {
      fs.writeFileSync(path.join(root, '.env'), 'OPENROUTER_API_KEY=test-only\n', { mode: 0o600 });
    } else {
      const authDirectory = path.join(root, 'data', 'opencode');
      fs.mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(authDirectory, 'auth.json'), JSON.stringify({
        openai: { type: 'oauth', access: 'test-only' },
      }), { mode: 0o600 });
    }
    mockedExecFile.mockImplementation(((invokedCommand: string, args: string[], options: any, callback: Function) => {
      expect(invokedCommand).toBe(command);
      expect(args).toEqual(versionArgs);
      expect(options.env.JWT_SECRET).toBeUndefined();
      if (provider === 'HERMES') {
        expect(options.env.HERMES_HOME).toBe(fs.realpathSync(root));
        expect(options.env.HERMES_ACP_SKIP_CONFIGURED_MCP).toBe('1');
      } else {
        expect(options.env.XDG_DATA_HOME).toBe(fs.realpathSync(path.join(root, 'data')));
        expect(options.env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
      }
      callback(null, `${command} ${provider === 'HERMES' ? '0.20.4' : '1.18.19'}`, '');
      return {} as any;
    }) as any);

    try {
      __resetNativeReadinessForTests();
      __setNativeReadinessProbeForTests(provider, async () => ({ state: 'unknown' }));
      await expect(getNativeProviderReadiness(provider)).resolves.toMatchObject({
        provider,
        state: 'login_present',
        usable: true,
      });
      expect(mockedExecFile).toHaveBeenCalledTimes(1);
    } finally {
      if (previousRoot === undefined) delete process.env[rootVariable];
      else process.env[rootVariable] = previousRoot;
      if (previousJwt === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousJwt;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('invalidates cached OpenCode readiness when its provider/model config changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-readiness-opencode-config-'));
    const previousRoot = process.env.PORTAL_OPENCODE_HOME;
    const authDirectory = path.join(root, 'data', 'opencode');
    const configDirectory = path.join(root, 'config', 'opencode');
    fs.mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(authDirectory, 'auth.json'), JSON.stringify({
      openai: { type: 'oauth', access: 'test-only' },
    }), { mode: 0o600 });
    const configPath = path.join(configDirectory, 'opencode.json');
    fs.writeFileSync(configPath, JSON.stringify({ model: 'openai/model-a' }), { mode: 0o600 });
    process.env.PORTAL_OPENCODE_HOME = root;
    mockedExecFile.mockImplementation(((_command: string, _args: string[], _options: unknown, callback: Function) => {
      callback(null, 'opencode 1.18.19', '');
      return {} as any;
    }) as any);

    try {
      __resetNativeReadinessForTests();
      __setNativeReadinessProbeForTests('OPENCODE', async () => ({ state: 'unknown' }));
      const first = await getNativeProviderReadiness('OPENCODE');
      const cached = await getNativeProviderReadiness('OPENCODE');
      expect(cached).toBe(first);
      expect(mockedExecFile).toHaveBeenCalledTimes(1);

      fs.writeFileSync(configPath, JSON.stringify({ model: 'openai/model-b' }), { mode: 0o600 });
      const changed = await getNativeProviderReadiness('OPENCODE');
      expect(changed.credentialFingerprint).not.toBe(first.credentialFingerprint);
      expect(mockedExecFile).toHaveBeenCalledTimes(2);
    } finally {
      if (previousRoot === undefined) delete process.env.PORTAL_OPENCODE_HOME;
      else process.env.PORTAL_OPENCODE_HOME = previousRoot;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('singleflights Project Sandbox readiness across concurrent cold reads', async () => {
    let releaseProbe!: () => void;
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
    const probeReleased = new Promise<void>((resolve) => { releaseProbe = resolve; });
    __setNativeReadinessProbeForTests('CODEX', async () => {
      markProbeStarted();
      await probeReleased;
      return { state: 'unknown' };
    });

    const first = getNativeProviderReadiness('CODEX', { executionScope: 'PROJECT_SANDBOX' });
    const second = getNativeProviderReadiness('CODEX', { executionScope: 'PROJECT_SANDBOX' });
    await probeStarted;
    expect(mockedExecFile).not.toHaveBeenCalled();
    releaseProbe();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toBe(firstResult);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  test.each(['GEMINI', 'GROK'] as const)(
    'keeps unqualified %s readiness fixed unavailable without executing vendor bytes',
    async (provider) => {
      await expect(getNativeProviderReadiness(provider, { force: true })).resolves.toMatchObject({
        provider,
        state: 'runtime_unavailable',
        usable: false,
        credentialFingerprint: 'not-inspected',
        runtimeFingerprint: 'unqualified-native-binary-lane',
        message: expect.stringMatching(/detection-only.*systemd 249\/255.*matching-architecture/i),
      });
      expect(mockedExecFile).not.toHaveBeenCalled();
    },
  );

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

    const pending = getNativeProviderReadiness('CODEX', { executionScope: 'PROJECT_SANDBOX' });
    await probeStarted;
    invalidateNativeProviderReadiness('CODEX');
    releaseProbe();
    await expect(pending).resolves.toMatchObject({ state: 'unknown', usable: false });

    expect(getCachedNativeProviderReadiness('CODEX')).toBeNull();
  });

  test('keeps Antigravity fixed unavailable across stale in-flight test hooks', async () => {
    await expect(getNativeProviderReadiness('GEMINI')).resolves.toMatchObject({
      state: 'runtime_unavailable', usable: false,
    });
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  test('does not turn Antigravity auth evidence into execution readiness', async () => {
    await expect(getNativeProviderReadiness('GEMINI')).resolves.toMatchObject({
      state: 'runtime_unavailable', usable: false,
    });
    expect(getNativeCliAuthStatus('GEMINI')).toMatchObject({ status: 'not_applicable' });
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  test('does not inspect Antigravity credential generations while the lane is unqualified', async () => {
    await expect(getNativeProviderReadiness('GEMINI', { force: true })).resolves.toMatchObject({
      state: 'runtime_unavailable',
      usable: false,
      credentialFingerprint: 'not-inspected',
    });
    expect(mockedExecFile).not.toHaveBeenCalled();
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
      const admitted = await getNativeProviderReadiness('CLAUDE_CODE', { executionScope: 'PROJECT_SANDBOX' });
      expect(admitted).toMatchObject({ state: 'login_present', usable: true });

      recordNativeProviderAuthFailure(
        'CLAUDE_CODE',
        'Claude Code provider error: authentication_failed',
        admitted,
      );

      await expect(getNativeProviderReadiness('CLAUDE_CODE', {
        force: true,
        executionScope: 'PROJECT_SANDBOX',
      })).resolves.toMatchObject({
        state: 'needs_login',
        usable: false,
        credentialFingerprint: admitted.credentialFingerprint,
      });

      // Rewriting the same credential store must not masquerade as a new login.
      fs.writeFileSync(credentialsPath, firstCredential, { mode: 0o600 });
      fs.chmodSync(credentialsPath, 0o640);
      const metadataOnlyTime = new Date(Date.now() + 5_000);
      fs.utimesSync(credentialsPath, metadataOnlyTime, metadataOnlyTime);
      await expect(getNativeProviderReadiness('CLAUDE_CODE', {
        force: true,
        executionScope: 'PROJECT_SANDBOX',
      })).resolves.toMatchObject({
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
      await expect(getNativeProviderReadiness('CLAUDE_CODE', {
        force: true,
        executionScope: 'PROJECT_SANDBOX',
      })).resolves.toMatchObject({
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
      const admitted = await getNativeProviderReadiness('CLAUDE_CODE', { executionScope: 'PROJECT_SANDBOX' });
      let releaseProbe!: () => void;
      let markProbeStarted!: () => void;
      const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
      const probeReleased = new Promise<void>((resolve) => { releaseProbe = resolve; });
      __setNativeReadinessProbeForTests('CLAUDE_CODE', async () => {
        markProbeStarted();
        await probeReleased;
        return { state: 'live_verified' };
      });

      const pending = getNativeProviderReadiness('CLAUDE_CODE', {
        force: true,
        executionScope: 'PROJECT_SANDBOX',
      });
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
