jest.mock('node-pty', () => ({ spawn: jest.fn() }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pty from 'node-pty';
import * as openclawConfigManager from '../services/openclawConfigManager';
import * as providerLifecycleLedger from '../services/providerCredentialLifecycleLedger';
import {
  __deleteOAuthSessionForTests,
  __resetCredentialLifecycleLeasesForTests,
  __resetCredentialLifecycleMemoryForTests,
  __setOAuthSessionForTests,
  authProfileStateFingerprint,
  attestCodexCredentialFile,
  beginClaudeSetupTokenFinalization,
  buildCodexOAuthEnvironment,
  buildOAuthFlowStatusPayload,
  buildOAuthLoginArgs,
  buildXaiOAuthProfileId,
  captureNativeCredentialSnapshot,
  classifyCodexDeviceLoginError,
  cleanupStaleClaudeSetupTokenProcesses,
  ClaudeOrphanLifecycleError,
  cancelOAuthFlow,
  cancelOAuthSessionRecord,
  completeClaudeCliImportForSession,
  completeNativeCliFlow,
  completeOAuthFlow,
  completeClaudeSetupTokenProcessExit,
  commitClaudeSetupTokenCredential,
  getOAuthFlowStatus,
  getClaudeSetupToken,
  getCredentialLifecycleNamespaceForNativeProvider,
  getCredentialLifecycleNamespaceForOpenClawProvider,
  isOAuthSessionCleanupPending,
  maybeCaptureClaudeSetupToken,
  pasteCodeToClaudeSession,
  readExpectedXaiOAuthProfile,
  readXaiOAuthPreflightState,
  scheduleXaiExitProfileReconciliation,
  extractClaudeAuthUrl,
  extractClaudeSetupToken,
  extractDeviceCodeExpiry,
  extractDeviceCodeInstructions,
  expireOAuthSessionRecord,
  getOpenClawOAuthProviderId,
  GROK_BUILD_DEVICE_LOGIN_ARGS,
  googleGeminiCliProfileHasUsableCredential,
  parseAntigravityReauthArgs,
  probeCodexLoginStatus,
  normalizeTerminalScreenText,
  outputLooksLikeClaudeCliAuthImportSuccess,
  selectCompletedProviderProfileId,
  startClaudeSetupTokenFlow,
  startDeviceCodeFlow,
  startNativeCliFlow,
  startOAuthFlow,
  squashPromptText,
  textContainsCallbackPastePrompt,
  waitForChangedProviderProfile,
  type OAuthSession,
} from '../services/oauthFlowManager';
import {
  __readProviderCredentialLifecycleLedgerForTests,
  bindProviderCredentialLifecycle,
  claimProviderCredentialLifecycle,
} from '../services/providerCredentialLifecycleLedger';

function silentPty(onKill?: () => void) {
  let exitHandler: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  return {
    onData: jest.fn(),
    onExit: jest.fn((handler) => { exitHandler = handler; }),
    write: jest.fn(),
    kill: jest.fn(() => {
      onKill?.();
      exitHandler?.({ exitCode: 143, signal: 15 });
    }),
  } as any;
}

function controllablePty() {
  let dataHandler: ((chunk: string) => void) | undefined;
  let exitHandler: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  return {
    process: {
      pid: process.pid,
      onData: jest.fn((handler: (chunk: string) => void) => { dataHandler = handler; }),
      onExit: jest.fn((handler: (event: { exitCode: number; signal?: number }) => void) => { exitHandler = handler; }),
      write: jest.fn(),
      kill: jest.fn(),
    } as any,
    emitData: (chunk: string) => dataHandler?.(chunk),
    emitExit: (exitCode: number) => exitHandler?.({ exitCode }),
  };
}

async function waitForPtyListener(listener: jest.Mock): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (listener.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for native CLI PTY listeners.');
}

describe('oauthFlowManager terminal parsing', () => {
  afterEach(() => {
    __resetCredentialLifecycleLeasesForTests();
  });
  test('attests a CLI state directory that contains a symlink', () => {
    // The Antigravity CLI rewrites ~/.gemini/antigravity-cli/cli.log as a
    // symlink to the current log file on every run. Treating that as
    // unverifiable made every Google Gemini sign-in fail before it started.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-cli-state-'));
    fs.mkdirSync(path.join(stateDir, 'log'));
    fs.writeFileSync(path.join(stateDir, 'log', 'cli-1.log'), 'first');
    fs.symlinkSync(path.join('log', 'cli-1.log'), path.join(stateDir, 'cli.log'));

    const before = captureNativeCredentialSnapshot([stateDir]);
    expect(before.state).toBe('verified');

    // Repointing the link is a real change and must move the fingerprint.
    fs.writeFileSync(path.join(stateDir, 'log', 'cli-2.log'), 'second');
    fs.unlinkSync(path.join(stateDir, 'cli.log'));
    fs.symlinkSync(path.join('log', 'cli-2.log'), path.join(stateDir, 'cli.log'));

    const after = captureNativeCredentialSnapshot([stateDir]);
    expect(after.state).toBe('verified');
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test('stays fail-closed when the attested credential file itself is a symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-cred-swap-'));
    const credentialPath = path.join(dir, 'auth.json');
    fs.writeFileSync(path.join(dir, 'elsewhere.json'), '{}');
    fs.symlinkSync(path.join(dir, 'elsewhere.json'), credentialPath);

    expect(captureNativeCredentialSnapshot([credentialPath]).state).toBe('indeterminate');
  });

  test('fingerprints credential bytes and labels metadata-only profiles as opaque', () => {
    const first = authProfileStateFingerprint({
      provider: 'openai',
      type: 'oauth',
      access: 'first-access-token',
      refresh: 'first-refresh-token',
      expires: 123,
    });
    const rotated = authProfileStateFingerprint({
      provider: 'openai',
      type: 'oauth',
      access: 'rotated-access-token',
      refresh: 'rotated-refresh-token',
      expires: 123,
    });
    const opaque = authProfileStateFingerprint({
      provider: 'openai',
      type: 'oauth',
      managedBy: 'openclaw-auth-store',
      expires: 123,
    });

    expect(first).toMatch(/^complete:/);
    expect(rotated).toMatch(/^complete:/);
    expect(rotated).not.toBe(first);
    expect(opaque).toMatch(/^opaque:/);
    expect(first).not.toContain('first-access-token');
  });

  test.each([
    ['Claude', 'anthropic', 'claude-code' as const],
    ['OpenAI/Codex', 'openai-codex', 'codex' as const],
    ['Google/Gemini', 'google-gemini-cli', 'gemini' as const],
    ['xAI/Grok', 'xai', 'grok' as const],
  ])('serializes %s auth methods through one credential-domain lease', (
    _label,
    openClawProvider,
    nativeProvider,
  ) => {
    const openClawNamespace = getCredentialLifecycleNamespaceForOpenClawProvider(openClawProvider);
    const nativeNamespace = getCredentialLifecycleNamespaceForNativeProvider(nativeProvider);
    expect(nativeNamespace).toBe(openClawNamespace);

    claimProviderCredentialLifecycle(openClawNamespace, 'user:one', 'openclaw-method');
    expect(() => claimProviderCredentialLifecycle(nativeNamespace, 'user:one', 'native-method'))
      .toThrow(/Another authorization lifecycle/);
    expect(() => claimProviderCredentialLifecycle(nativeNamespace, 'user:two', 'native-method'))
      .toThrow(/Another authorization lifecycle/);
  });

  test('waits for stale Claude PTY exit before proving stable absence', async () => {
    let alive = true;
    const signals: string[] = [];
    let reads = 0;
    const cleaned = await cleanupStaleClaudeSetupTokenProcesses({
      listProcesses: () => [{ pid: 4242, ppid: 1, ageSeconds: 700, startTicks: '100', portalMarker: '123e4567-e89b-42d3-a456-426614174000' }],
      signalProcess: (_identity, signal) => { signals.push(signal); },
      processStillAlive: () => alive,
      readInventoryProof: async () => { reads += 1; return { fingerprint: 'unchanged', absent: true }; },
      delay: async () => { alive = false; },
      stableReads: 3,
      stableReadIntervalMs: 1,
    });
    expect(cleaned).toBe(1);
    expect(signals).toEqual(['SIGTERM']);
    expect(reads).toBe(3);
  });

  test('escalates stale Claude PTY cleanup and blocks replacement when exit cannot be proven', async () => {
    const signals: string[] = [];
    await expect(cleanupStaleClaudeSetupTokenProcesses({
      listProcesses: () => [{ pid: 4242, ppid: 1, ageSeconds: 700, startTicks: '100', portalMarker: '123e4567-e89b-42d3-a456-426614174000' }],
      signalProcess: (_identity, signal) => { signals.push(signal); },
      processStillAlive: () => true,
      readInventoryProof: async () => ({ fingerprint: 'unchanged', absent: true }),
      delay: async () => undefined,
      termWaitMs: 0,
      killWaitMs: 0,
    })).rejects.toMatchObject({
      credentialState: 'indeterminate',
      cleanupPending: true,
      retainLifecycle: true,
    });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('preserves an unowned Claude setup process and blocks replacement', async () => {
    const signalProcess = jest.fn();
    await expect(cleanupStaleClaudeSetupTokenProcesses({
      listProcesses: () => [{
        pid: 4242,
        ppid: 1,
        ageSeconds: 700,
        startTicks: '100',
        portalMarker: null,
      }],
      signalProcess,
      processStillAlive: () => true,
    })).rejects.toMatchObject({
      credentialState: 'indeterminate',
      cleanupPending: true,
    });
    expect(signalProcess).not.toHaveBeenCalled();
  });

  test('blocks replacement when a stale Claude PTY commits credentials during shutdown', async () => {
    let alive = true;
    let reads = 0;
    await expect(cleanupStaleClaudeSetupTokenProcesses({
      listProcesses: () => [{ pid: 4242, ppid: 1, ageSeconds: 700, startTicks: '100', portalMarker: '123e4567-e89b-42d3-a456-426614174000' }],
      signalProcess: () => undefined,
      processStillAlive: () => alive,
      readInventoryProof: async () => {
        reads += 1;
        return reads === 1
          ? { fingerprint: 'before', absent: true }
          : { fingerprint: 'after-commit', absent: false };
      },
      delay: async () => { alive = false; },
      stableReads: 3,
    })).rejects.toBeInstanceOf(ClaudeOrphanLifecycleError);
    await expect(cleanupStaleClaudeSetupTokenProcesses({
      listProcesses: () => [],
    })).resolves.toBe(0);
  });

  test('does not treat a credential committed before orphan discovery as verified absence', async () => {
    let alive = true;
    await expect(cleanupStaleClaudeSetupTokenProcesses({
      listProcesses: () => [{ pid: 4242, ppid: 1, ageSeconds: 700, startTicks: '100', portalMarker: '123e4567-e89b-42d3-a456-426614174000' }],
      signalProcess: () => undefined,
      processStillAlive: () => alive,
      // Stable equality to a cleanup-time baseline is deliberately insufficient:
      // the orphan may have committed this credential before Portal found it.
      readInventoryProof: async () => ({
        fingerprint: 'present-before-cleanup-scan',
        absent: false,
      }),
      delay: async () => { alive = false; },
      stableReads: 3,
    })).rejects.toMatchObject({ credentialState: 'committed', retainLifecycle: true });
  });

  test('does not signal a reused PID while reconciling stale Claude setup', async () => {
    const signalProcess = jest.fn();
    await expect(cleanupStaleClaudeSetupTokenProcesses({
      listProcesses: () => [{ pid: 4242, ppid: 1, ageSeconds: 700, startTicks: 'old-start', portalMarker: '123e4567-e89b-42d3-a456-426614174000' }],
      signalProcess,
      processStillAlive: () => false,
      readInventoryProof: async () => ({ fingerprint: 'unchanged', absent: true }),
      delay: async () => undefined,
      stableReads: 2,
    })).resolves.toBe(1);
    expect(signalProcess).not.toHaveBeenCalled();
  });

  test('checks durable Claude ownership before scanning an old live PTY as orphaned', async () => {
    (pty.spawn as jest.Mock).mockClear();
    const claim = claimProviderCredentialLifecycle(
      'credential-domain:anthropic',
      'user:durable-owner',
      'existing-request',
      { baselineFingerprint: 'combined-before', reviewAfterMs: 60_000 },
    );
    bindProviderCredentialLifecycle(claim, 'existing-session', {
      binding: { kind: 'owned-child', processPid: process.pid },
    });
    const cleanupOrphans = jest.fn().mockResolvedValue(0);

    await expect(startClaudeSetupTokenFlow('user:new-owner', {
      cleanupOrphans,
      readInventoryFingerprint: async () => 'combined-before',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PROVIDER_CREDENTIAL_LIFECYCLE_RECOVERY_REQUIRED',
    });
    expect(cleanupOrphans).not.toHaveBeenCalled();
    expect(pty.spawn).not.toHaveBeenCalled();
  });

  test('durably quarantines a pre-ledger Claude orphan that leaves credentials behind', async () => {
    const committed = new ClaudeOrphanLifecycleError(
      'orphan committed credentials',
      'committed',
      false,
    );
    await expect(startClaudeSetupTokenFlow('user:orphan-owner', {
      cleanupOrphans: jest.fn().mockRejectedValue(committed),
      readInventoryFingerprint: async () => 'combined-current',
    })).rejects.toBe(committed);
    expect(__readProviderCredentialLifecycleLedgerForTests().records['credential-domain:anthropic'])
      .toMatchObject({ state: 'committed', lifecycleKind: 'claude-setup-token-orphan' });

    __resetCredentialLifecycleMemoryForTests();
    const replacementCleanup = jest.fn().mockResolvedValue(0);
    await expect(startClaudeSetupTokenFlow('user:orphan-owner', {
      cleanupOrphans: replacementCleanup,
      readInventoryFingerprint: async () => 'combined-current',
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(replacementCleanup).not.toHaveBeenCalled();
  });
  test('squashes screen-control fragments that render prompts one glyph per line', () => {
    const raw = 'P\r[2m\na\r[2m\ns\r[2m\nt\r[2m\ne\r[2m\n';
    expect(normalizeTerminalScreenText(raw)).toContain('P');
    expect(squashPromptText(raw)).toBe('paste');
  });

  test('detects OpenClaw Codex callback prompts rendered one glyph per line', () => {
    const raw = [
      'P', 'a', 's', 't', 'e', ' ', 't', 'h', 'e', ' ',
      'a', 'u', 't', 'h', 'o', 'r', 'i', 'z', 'a', 't', 'i', 'o', 'n', ' ',
      'c', 'o', 'd', 'e', ' ', '(', 'o', 'r', ' ', 'f', 'u', 'l', 'l', ' ',
      'r', 'e', 'd', 'i', 'r', 'e', 'c', 't', ' ', 'U', 'R', 'L', ')', ':',
    ].join('\n');

    expect(textContainsCallbackPastePrompt(raw)).toBe(true);
  });

  test('extracts Claude setup tokens from screen-normalized PTY output', () => {
    const fakeToken = ['sk', 'ant', 'oat01', 'abcdefghijklmnopqrstuvwxyz1234567890+/='].join('-');
    const raw = `Done!\r\nsetup token:\r\n${fakeToken}\r\n`;
    expect(extractClaudeSetupToken(raw)).toBe(fakeToken);
  });

  test('extracts wrapped Claude auth URLs from PTY output', () => {
    const raw = [
      'Open this URL in your browser:',
      'https://claude.ai/oauth/authorize?code=true&',
      'state=abc123',
      'Paste code here if prompted >',
    ].join('\r\n');

    expect(extractClaudeAuthUrl(raw)).toBe('https://claude.ai/oauth/authorize?code=true&state=abc123');
  });

  test('maps Portal Codex setup to OpenClaw 2026.6 auth provider id', () => {
    expect(getOpenClawOAuthProviderId('openai-codex')).toBe('openai');
    expect(getOpenClawOAuthProviderId('google-gemini-cli')).toBe('google-gemini-cli');
  });

  test('classifies Codex device-login failures without reflecting terminal output', () => {
    expect(classifyCodexDeviceLoginError('Error: device code login is not enabled token=must-not-leak'))
      .toBe('Codex device login is disabled. Enable device code login in your personal ChatGPT Security settings or ask your workspace admin to enable it in Permissions, then try again.');
    expect(classifyCodexDeviceLoginError('authorization was denied secret=must-not-leak'))
      .toBe('OpenAI authorization was denied. Start a fresh Codex sign-in when you are ready to approve it.');
    expect(classifyCodexDeviceLoginError('TLS handshake failed: unknown issuer'))
      .toBe('Codex could not establish a trusted TLS connection to OpenAI. Check the server trust store or configure CODEX_CA_CERTIFICATE, then retry.');
    expect(classifyCodexDeviceLoginError('unexpected provider response token=must-not-leak')).toBeNull();
  });

  test('classifies the read-only Codex login-status probe without exposing command output', () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'must-not-cross-the-status-probe';
    const runner = jest.fn(() => ({
      status: 0,
      stdout: '',
      stderr: 'Logged in using ChatGPT\n',
    }));
    try {
      expect(probeCodexLoginStatus('/fixture/codex', runner)).toBe('authenticated');
      expect(runner).toHaveBeenCalledWith(
        '/fixture/codex',
        ['login', '-c', 'cli_auth_credentials_store="file"', 'status'],
        expect.objectContaining({
          env: expect.not.objectContaining({ OPENAI_API_KEY: expect.anything() }),
        }),
      );
      expect(probeCodexLoginStatus('/fixture/codex', jest.fn(() => ({
        status: 1,
        stdout: '',
        stderr: 'Not logged in\n',
      })))).toBe('signed_out');
      expect(probeCodexLoginStatus('/fixture/codex', jest.fn(() => ({
        status: 1,
        stdout: '',
        stderr: 'Error checking login status: keyring unavailable\n',
      })))).toBe('indeterminate');
      expect(probeCodexLoginStatus('/fixture/codex', jest.fn(() => ({
        status: 2,
        stdout: '',
        stderr: 'unexpected failure\n',
      })))).toBe('indeterminate');
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
    }
  });

  test('passes only allowlisted Codex OAuth network and trust settings', () => {
    const env = buildCodexOAuthEnvironment({
      HOME: '/srv/portal',
      PATH: '/usr/local/bin:/usr/bin',
      CODEX_HOME: '/srv/portal/codex',
      OPENAI_API_KEY: 'must-not-cross-oauth',
      HTTPS_PROXY: 'http://proxy.example:8443',
      no_proxy: '127.0.0.1,localhost',
      SSL_CERT_FILE: '/etc/portal/custom-ca.pem',
      CODEX_CA_CERTIFICATE: '/etc/portal/codex-ca.pem',
      DATABASE_URL: 'postgres://must-not-cross',
      PORTAL_JWT_SECRET: 'must-not-cross',
    });

    expect(env).toMatchObject({
      HOME: '/srv/portal',
      PATH: '/usr/local/bin:/usr/bin',
      CODEX_HOME: '/srv/portal/codex',
      HTTPS_PROXY: 'http://proxy.example:8443',
      no_proxy: '127.0.0.1,localhost',
      SSL_CERT_FILE: '/etc/portal/custom-ca.pem',
      CODEX_CA_CERTIFICATE: '/etc/portal/codex-ca.pem',
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PORTAL_JWT_SECRET).toBeUndefined();
  });

  test('treats only a missing Codex auth file as absent', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-file-attestation-'));
    const authPath = path.join(codexHome, 'auth.json');
    try {
      expect(attestCodexCredentialFile(authPath)).toBe('absent');
      fs.writeFileSync(authPath, '{not-json', { mode: 0o600 });
      expect(attestCodexCredentialFile(authPath)).toBe('indeterminate');
      fs.writeFileSync(authPath, '{}', { mode: 0o600 });
      expect(attestCodexCredentialFile(authPath)).toBe('indeterminate');
      fs.writeFileSync(authPath, JSON.stringify({
        tokens: { access_token: 'fixture-access-token' },
      }), { mode: 0o600 });
      expect(attestCodexCredentialFile(authPath)).toBe('committed');
    } finally {
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test('reuses an attested existing Codex login without spawning destructive reauthentication', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-oauth-reuse-'));
    process.env.CODEX_HOME = codexHome;
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: 'existing-access-token', refresh_token: 'existing-refresh-token' },
    }), { mode: 0o600 });
    (pty.spawn as jest.Mock).mockClear();
    let sessionId: string | null = null;

    try {
      const result = await startNativeCliFlow('codex', {
        ownerId: 'user:codex-reuse',
        codexLoginStatusProbe: () => 'authenticated',
      });
      sessionId = result.sessionId;
      expect(result).toMatchObject({
        status: 'complete',
        alreadyAuthenticated: true,
        reauthSupported: true,
      });
      expect(getOAuthFlowStatus(sessionId, 'user:codex-reuse')).toMatchObject({
        status: 'complete',
        credentialState: 'committed',
        cleanupPending: false,
      });
      expect(pty.spawn).not.toHaveBeenCalled();
    } finally {
      if (sessionId) __deleteOAuthSessionForTests(sessionId);
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test('requires explicit replacement before touching an existing unconfirmed Codex credential', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-oauth-protected-'));
    process.env.CODEX_HOME = codexHome;
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: 'protected-access-token', refresh_token: 'protected-refresh-token' },
    }), { mode: 0o600 });
    (pty.spawn as jest.Mock).mockClear();

    try {
      await expect(startNativeCliFlow('codex', {
        ownerId: 'user:codex-protected',
        codexLoginStatusProbe: () => 'signed_out',
      })).rejects.toMatchObject({
        code: 'CODEX_REAUTHENTICATION_REQUIRED',
        statusCode: 409,
        message: expect.stringMatching(/stopped before it could delete/i),
      });
      expect(pty.spawn).not.toHaveBeenCalled();
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test('requires explicit replacement when Codex login status is indeterminate', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-oauth-indeterminate-'));
    process.env.CODEX_HOME = codexHome;
    (pty.spawn as jest.Mock).mockClear();

    try {
      await expect(startNativeCliFlow('codex', {
        ownerId: 'user:codex-indeterminate',
        codexLoginStatusProbe: () => 'indeterminate',
      })).rejects.toMatchObject({
        code: 'CODEX_REAUTHENTICATION_REQUIRED',
        statusCode: 409,
        message: expect.stringMatching(/could not verify whether Codex is already signed in/i),
      });
      expect(pty.spawn).not.toHaveBeenCalled();
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test('blocks ordinary Codex setup when auth.json changes during the status probe', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-oauth-probe-race-'));
    const authPath = path.join(codexHome, 'auth.json');
    process.env.CODEX_HOME = codexHome;
    fs.writeFileSync(authPath, JSON.stringify({
      tokens: { access_token: 'before-probe-token' },
    }), { mode: 0o600 });
    (pty.spawn as jest.Mock).mockClear();

    try {
      await expect(startNativeCliFlow('codex', {
        ownerId: 'user:codex-probe-race',
        codexLoginStatusProbe: () => {
          fs.writeFileSync(authPath, JSON.stringify({
            tokens: { access_token: 'after-probe-token' },
          }), { mode: 0o600 });
          return 'authenticated';
        },
      })).rejects.toMatchObject({
        code: 'CODEX_REAUTHENTICATION_REQUIRED',
        statusCode: 409,
      });
      expect(pty.spawn).not.toHaveBeenCalled();
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test('keeps native Codex non-terminal until CODEX_HOME credential proof succeeds', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const previousApiKey = process.env.OPENAI_API_KEY;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-oauth-home-'));
    const ptyControl = controllablePty();
    process.env.CODEX_HOME = codexHome;
    process.env.OPENAI_API_KEY = 'must-not-cross-the-device-login';
    (pty.spawn as jest.Mock).mockReturnValueOnce(ptyControl.process);
    let sessionId: string | null = null;

    try {
      const pending = startNativeCliFlow('codex', {
        ownerId: 'user:codex-home',
        codexLoginStatusProbe: () => 'signed_out',
      });
      await waitForPtyListener(ptyControl.process.onData);
      const [, args, spawnOptions] = (pty.spawn as jest.Mock).mock.calls.at(-1);
      expect(args.slice(-4)).toEqual(['login', '-c', 'cli_auth_credentials_store="file"', '--device-auth']);
      expect(spawnOptions.env.CODEX_HOME).toBe(codexHome);
      expect(spawnOptions.env.OPENAI_API_KEY).toBeUndefined();
      ptyControl.emitData('Open https://auth.openai.com/codex/device to continue.');
      const started = await pending;
      sessionId = started.sessionId;

      ptyControl.emitData('Successfully logged in');
      expect(getOAuthFlowStatus(sessionId, 'user:codex-home')).toMatchObject({
        status: 'processing',
        credentialState: null,
        createdProfileId: null,
      });

      fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
        tokens: { access_token: 'test-access-token', refresh_token: 'test-refresh-token' },
      }), { mode: 0o600 });
      ptyControl.emitExit(0);

      expect(getOAuthFlowStatus(sessionId, 'user:codex-home')).toMatchObject({
        status: 'complete',
        credentialState: 'committed',
        cleanupPending: false,
        createdProfileId: null,
      });
    } finally {
      if (sessionId) __deleteOAuthSessionForTests(sessionId);
      (pty.spawn as jest.Mock).mockReset();
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test('overrides premature Codex success text when no usable file credential exists', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-oauth-empty-'));
    const ptyControl = controllablePty();
    process.env.CODEX_HOME = codexHome;
    (pty.spawn as jest.Mock).mockReturnValueOnce(ptyControl.process);
    let sessionId: string | null = null;

    try {
      const pending = startNativeCliFlow('codex', {
        ownerId: 'user:codex-empty',
        codexLoginStatusProbe: () => 'signed_out',
      });
      await waitForPtyListener(ptyControl.process.onData);
      ptyControl.emitData('Open https://auth.openai.com/codex/device to continue.');
      const started = await pending;
      sessionId = started.sessionId;
      ptyControl.emitData('Successfully logged in');
      ptyControl.emitExit(0);

      expect(getOAuthFlowStatus(sessionId, 'user:codex-empty')).toMatchObject({
        status: 'error',
        credentialState: 'absent',
        cleanupPending: false,
        createdProfileId: null,
        error: expect.stringMatching(/file-backed credential/i),
      });
    } finally {
      if (sessionId) __deleteOAuthSessionForTests(sessionId);
      (pty.spawn as jest.Mock).mockReset();
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test('does not mistake an unchanged preexisting Codex credential for a successful reauthentication', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-oauth-existing-'));
    const ptyControl = controllablePty();
    process.env.CODEX_HOME = codexHome;
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: 'existing-access-token', refresh_token: 'existing-refresh-token' },
    }), { mode: 0o600 });
    (pty.spawn as jest.Mock).mockReturnValueOnce(ptyControl.process);
    let sessionId: string | null = null;

    try {
      const pending = startNativeCliFlow('codex', {
        ownerId: 'user:codex-existing',
        forceReauth: true,
        codexLoginStatusProbe: () => 'signed_out',
      });
      await waitForPtyListener(ptyControl.process.onData);
      ptyControl.emitData('Open https://auth.openai.com/codex/device to continue.');
      const started = await pending;
      sessionId = started.sessionId;
      ptyControl.emitData('Successfully logged in');
      ptyControl.emitExit(1);

      expect(getOAuthFlowStatus(sessionId, 'user:codex-existing')).toMatchObject({
        status: 'error',
        credentialState: 'absent',
        cleanupPending: false,
        createdProfileId: null,
        error: expect.stringMatching(/without committing a new usable file-backed credential/i),
      });
    } finally {
      if (sessionId) __deleteOAuthSessionForTests(sessionId);
      (pty.spawn as jest.Mock).mockReset();
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test('records an unclean changed Codex credential for review without stranding the lifecycle lease', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-oauth-unclean-'));
    const firstPty = controllablePty();
    const retryPty = controllablePty();
    process.env.CODEX_HOME = codexHome;
    (pty.spawn as jest.Mock)
      .mockReturnValueOnce(firstPty.process)
      .mockReturnValueOnce(retryPty.process);
    let firstSessionId: string | null = null;
    let retrySessionId: string | null = null;

    try {
      const firstPending = startNativeCliFlow('codex', {
        ownerId: 'user:codex-unclean',
        codexLoginStatusProbe: () => 'signed_out',
      });
      await waitForPtyListener(firstPty.process.onData);
      firstPty.emitData('Open https://auth.openai.com/codex/device to continue.');
      const first = await firstPending;
      firstSessionId = first.sessionId;
      fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
        tokens: { access_token: 'changed-access-token', refresh_token: 'changed-refresh-token' },
      }), { mode: 0o600 });
      firstPty.emitData('Successfully logged in');
      firstPty.emitExit(1);

      expect(getOAuthFlowStatus(firstSessionId, 'user:codex-unclean')).toMatchObject({
        status: 'error',
        credentialState: 'committed',
        cleanupPending: false,
        createdProfileId: null,
        error: expect.stringMatching(/wrote a usable credential.*exited with code 1/i),
      });

      const retryPending = startNativeCliFlow('codex', {
        ownerId: 'user:codex-unclean',
        forceReauth: true,
        codexLoginStatusProbe: () => 'signed_out',
      });
      await waitForPtyListener(retryPty.process.onData);
      retryPty.emitData('Open https://auth.openai.com/codex/device to continue.');
      const retry = await retryPending;
      retrySessionId = retry.sessionId;
      expect(retrySessionId).not.toBe(firstSessionId);
    } finally {
      if (firstSessionId) __deleteOAuthSessionForTests(firstSessionId);
      if (retrySessionId) __deleteOAuthSessionForTests(retrySessionId);
      (pty.spawn as jest.Mock).mockReset();
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test('uses the exact audited xAI OAuth argv without changing the default model', () => {
    const profileId = buildXaiOAuthProfileId('oauth_test_123');
    const args = buildOAuthLoginArgs('xai', profileId);
    expect(profileId).toBe('xai:portal-oauth-oauth-test-123');
    expect(args).toEqual([
      'models', 'auth', '--agent', 'main', 'login', '--provider', 'xai',
      '--method', 'oauth', '--profile-id', 'xai:portal-oauth-oauth-test-123',
    ]);
    expect(args).not.toContain('--force');
    expect(args).not.toContain('--set-default');
  });

  test('extracts structured xAI device instructions from ANSI/chunk-normalized output', () => {
    const parsed = extractDeviceCodeInstructions('xai', [
      '\u001b[2mxAI OAuth\u001b[0m',
      'Open this URL in your LOCAL browser and enter the code below.',
      'URL: https://auth.x.ai/device?flow=portal',
      'Co\u001b[2mde:\u001b[0m GROK-42AB',
      'Code expires in 5 minutes. Never share it.',
    ].join('\r\n'));

    expect(parsed).toEqual({
      verificationUrl: 'https://auth.x.ai/device?flow=portal',
      deviceCode: 'GROK-42AB',
    });
  });

  test('extracts Grok Build device login instructions only from trusted xAI hosts', () => {
    expect(GROK_BUILD_DEVICE_LOGIN_ARGS).toEqual(['--no-auto-update', 'login', '--device-auth']);
    expect(extractDeviceCodeInstructions('grok', [
      'To sign in, open this URL in your browser:',
      'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH',
      'Confirm this code in your browser:',
      'ABCD-EFGH',
    ].join('\n'))).toEqual({
      verificationUrl: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH',
      deviceCode: 'ABCD-EFGH',
    });

    expect(extractDeviceCodeInstructions('grok', [
      'https://attacker.invalid/oauth2/device?user_code=ABCD-EFGH',
      'Confirm this code in your browser:',
      'ABCD-EFGH',
    ].join('\n'))).toEqual({ verificationUrl: null, deviceCode: 'ABCD-EFGH' });
  });

  test('extracts and bounds structured device-code expiry', () => {
    const now = 1_700_000_000_000;
    expect(extractDeviceCodeExpiry('Code expires in 5 minutes.', now)).toBe(now + 300_000);
    expect(extractDeviceCodeExpiry('expires_in: 300', now)).toBe(now + 300_000);
    expect(extractDeviceCodeExpiry('Code expires in 90000 seconds.', now)).toBeNull();
  });

  test('rejects non-xAI URLs while parsing xAI device instructions', () => {
    expect(extractDeviceCodeInstructions('xai', [
      'URL: https://attacker.invalid/device',
      'Code: GROK-42AB',
    ].join('\n'))).toEqual({ verificationUrl: null, deviceCode: 'GROK-42AB' });
  });

  test('OAuth status payload is structured and never exposes the PTY transcript', () => {
    const payload = buildOAuthFlowStatusPayload({
      id: 'oauth_test',
      provider: 'xai',
      mode: 'device_code',
      authUrl: null,
      callbackHintUrl: null,
      verificationUrl: 'https://auth.x.ai/device',
      deviceCode: 'GROK-42AB',
      expiresAt: 1_700_000_300_000,
      status: 'polling_device',
      error: null,
      cleanOutput: 'access_token=must-not-leak',
    } as any, null);

    expect(payload).toMatchObject({
      id: 'oauth_test',
      provider: 'xai',
      mode: 'device_code',
      verificationUrl: 'https://auth.x.ai/device',
      deviceCode: 'GROK-42AB',
      expiresAt: 1_700_000_300_000,
      status: 'polling_device',
    });
    expect(payload).not.toHaveProperty('output');
    expect(JSON.stringify(payload)).not.toContain('must-not-leak');
  });

  test('reports truthful Antigravity already-authenticated capability without exposing a fake URL', () => {
    const payload = buildOAuthFlowStatusPayload({
      id: 'oauth_antigravity',
      provider: 'gemini',
      mode: 'oauth',
      status: 'complete',
      authUrl: null,
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      error: null,
      alreadyAuthenticated: true,
      reauthSupported: false,
    } as any, null);

    expect(payload).toMatchObject({
      provider: 'gemini',
      status: 'complete',
      authUrl: null,
      alreadyAuthenticated: true,
      reauthSupported: false,
    });
  });

  test('uses only re-auth commands explicitly advertised by Antigravity help', () => {
    expect(parseAntigravityReauthArgs('Commands:\n  login    Sign in again\n  models')).toEqual(['login']);
    expect(parseAntigravityReauthArgs('Available subcommands:\n  login           Sign in again\n  models          List models')).toEqual(['login']);
    expect(parseAntigravityReauthArgs('Options:\n  --reauthenticate  Replace the current login')).toEqual(['--reauthenticate']);
    expect(parseAntigravityReauthArgs('Commands:\n  models\n  plugins\n  update')).toBeNull();
    expect(parseAntigravityReauthArgs('Login is performed automatically when needed.')).toBeNull();
    expect(parseAntigravityReauthArgs('Commands:\n  Login is performed automatically\n  models')).toBeNull();
  });

  test('owner-bound cancellation kills the PTY and marks the session cancelled', () => {
    const kill = jest.fn();
    const session = {
      ownerId: 'user:owner',
      status: 'polling_device',
      error: 'stale error',
      completedAt: null,
      process: { kill },
    } as any;

    expect(cancelOAuthSessionRecord(session, 'user:other')).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(session.status).toBe('polling_device');

    expect(cancelOAuthSessionRecord(session, 'user:owner')).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(session.status).toBe('cancelled');
    expect(session.error).toBeNull();
    expect(session.completedAt).toEqual(expect.any(Number));

    const completed = {
      ...session,
      status: 'complete',
      credentialResolution: 'committed',
      process: { kill: jest.fn() },
    } as any;
    expect(cancelOAuthSessionRecord(completed, 'user:owner')).toBe(false);
    expect(completed.status).toBe('complete');
    expect(completed.process.kill).not.toHaveBeenCalled();
  });

  test('cancellation while OAuth callback readiness is pending remains terminal and writes nothing', async () => {
    jest.useFakeTimers();
    const sessionId = 'oauth_cancel_during_prompt_wait';
    const write = jest.fn();
    const session = {
      id: sessionId,
      provider: 'hostile-test-provider',
      mode: 'oauth',
      ownerId: 'user:owner',
      process: { write, kill: jest.fn() },
      authUrl: null,
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      localPort: null,
      oauthState: null,
      status: 'awaiting_callback',
      error: null,
      output: '',
      cleanOutput: '',
      createdAt: Date.now(),
      completedAt: null,
      profileKeyBefore: [],
    } as unknown as OAuthSession;
    __setOAuthSessionForTests(session);

    try {
      const pending = completeOAuthFlow(
        sessionId,
        'http://localhost:1455/oauth/callback?code=latest',
        'user:owner',
      );
      await Promise.resolve();

      expect(cancelOAuthSessionRecord(session, 'user:owner')).toBe(true);
      await jest.advanceTimersByTimeAsync(200);

      await expect(pending).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/cancelled/i),
      });
      expect(session.status).toBe('cancelled');
      expect(write).not.toHaveBeenCalled();
    } finally {
      __deleteOAuthSessionForTests(sessionId);
      jest.useRealTimers();
    }
  });

  test('cancellation during OAuth callback submission prevents the final enter key', async () => {
    jest.useFakeTimers();
    const sessionId = 'oauth_cancel_during_callback_submit';
    const write = jest.fn();
    const session = {
      id: sessionId,
      provider: 'hostile-test-provider',
      mode: 'oauth',
      ownerId: 'user:owner',
      process: { write, kill: jest.fn() },
      authUrl: null,
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      localPort: null,
      oauthState: null,
      status: 'awaiting_callback',
      error: null,
      output: '',
      cleanOutput: 'Paste the callback URL here',
      createdAt: Date.now(),
      completedAt: null,
      profileKeyBefore: [],
    } as unknown as OAuthSession;
    __setOAuthSessionForTests(session);

    try {
      const callbackUrl = 'http://localhost:1455/oauth/callback?code=latest';
      const pending = completeOAuthFlow(sessionId, callbackUrl, 'user:owner');
      expect(write).toHaveBeenCalledWith(callbackUrl);

      expect(cancelOAuthSessionRecord(session, 'user:owner')).toBe(true);
      await jest.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/cancelled/i),
      });
      expect(session.status).toBe('cancelled');
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalledWith('\r');
    } finally {
      __deleteOAuthSessionForTests(sessionId);
      jest.useRealTimers();
    }
  });

  test('same-owner concurrent OAuth completion writes the callback and enter key exactly once', async () => {
    jest.useFakeTimers();
    const sessionId = 'oauth_concurrent_callback_single_flight';
    const write = jest.fn();
    const session = {
      id: sessionId,
      provider: 'hostile-test-provider',
      mode: 'oauth',
      ownerId: 'user:owner',
      process: { write, kill: jest.fn() },
      authUrl: null,
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      localPort: null,
      oauthState: null,
      status: 'awaiting_callback',
      error: null,
      output: '',
      cleanOutput: 'Paste the callback URL here',
      createdAt: Date.now(),
      completedAt: null,
      profileKeyBefore: [],
    } as unknown as OAuthSession;
    __setOAuthSessionForTests(session);

    try {
      const callbackUrl = 'http://localhost:1455/oauth/callback?code=one-attempt';
      const first = completeOAuthFlow(sessionId, callbackUrl, 'user:owner');
      const second = completeOAuthFlow(sessionId, callbackUrl, 'user:owner');

      expect(second).toBe(first);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith(callbackUrl);

      await jest.advanceTimersByTimeAsync(100);
      expect(write).toHaveBeenCalledTimes(2);
      expect(write).toHaveBeenLastCalledWith('\r');

      session.status = 'complete';
      await jest.advanceTimersByTimeAsync(250);
      await expect(Promise.all([first, second])).resolves.toEqual([
        { success: true },
        { success: true },
      ]);
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      __deleteOAuthSessionForTests(sessionId);
      jest.useRealTimers();
    }
  });

  test('rejects a different concurrent OAuth callback without writing it', async () => {
    jest.useFakeTimers();
    const sessionId = 'oauth_concurrent_callback_mismatch';
    const write = jest.fn();
    const session = {
      id: sessionId,
      provider: 'hostile-test-provider',
      mode: 'oauth',
      ownerId: 'user:owner',
      process: { write, kill: jest.fn() },
      authUrl: null,
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      localPort: null,
      oauthState: null,
      status: 'awaiting_callback',
      error: null,
      output: '',
      cleanOutput: 'Paste the callback URL here',
      createdAt: Date.now(),
      completedAt: null,
      profileKeyBefore: [],
    } as unknown as OAuthSession;
    __setOAuthSessionForTests(session);

    try {
      const first = completeOAuthFlow(
        sessionId,
        'http://localhost:1455/oauth/callback?code=first',
        'user:owner',
      );
      await expect(completeOAuthFlow(
        sessionId,
        'http://localhost:1455/oauth/callback?code=second',
        'user:owner',
      )).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/already processing/i),
      });
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls.flat().join('')).not.toContain('code=second');

      expect(cancelOAuthSessionRecord(session, 'user:owner')).toBe(true);
      await jest.advanceTimersByTimeAsync(100);
      await expect(first).resolves.toMatchObject({ success: false });
    } finally {
      __deleteOAuthSessionForTests(sessionId);
      jest.useRealTimers();
    }
  });

  test('cancellation during Claude code processing prevents late success or token capture', async () => {
    jest.useFakeTimers();
    const sessionId = 'oauth_cancel_during_claude_paste';
    const write = jest.fn();
    const session = {
      id: sessionId,
      provider: 'anthropic',
      mode: 'oauth',
      ownerId: 'user:owner',
      process: { write, kill: jest.fn() },
      authUrl: null,
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      localPort: null,
      oauthState: null,
      status: 'awaiting_callback',
      error: null,
      output: '',
      cleanOutput: '',
      createdAt: Date.now(),
      completedAt: null,
      profileKeyBefore: [],
      capturedToken: null,
    } as unknown as OAuthSession;
    __setOAuthSessionForTests(session);

    try {
      const pending = pasteCodeToClaudeSession(sessionId, 'authorization-code', 'user:owner');
      expect(write).toHaveBeenCalledWith('authorization-code\r\n');
      expect(session.status).toBe('processing');

      expect(cancelOAuthSessionRecord(session, 'user:owner')).toBe(true);
      session.cleanOutput = `setup token: ${['sk', 'ant', 'oat01', 'late-token-must-not-persist-1234567890+/='].join('-')}`;
      await jest.advanceTimersByTimeAsync(1_200);

      await expect(pending).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/cancelled/i),
      });
      expect(session.status).toBe('cancelled');
      expect(session.capturedToken).toBeNull();
    } finally {
      __deleteOAuthSessionForTests(sessionId);
      jest.useRealTimers();
    }
  });

  test('native CLI sessions reject cross-owner status and callback mutation', async () => {
    const sessionId = 'native_owner_bound_callback';
    const session = {
      id: sessionId,
      provider: 'claude-code',
      mode: 'oauth',
      ownerId: 'user:owner',
      process: null,
      authUrl: 'https://platform.claude.com/oauth/authorize',
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      localPort: null,
      oauthState: 'state-owner',
      status: 'awaiting_callback',
      error: null,
      output: '',
      cleanOutput: '',
      createdAt: Date.now(),
      completedAt: null,
      profileKeyBefore: [],
      extraEnv: { codeVerifier: 'verifier-owner' },
      processExited: true,
    } as unknown as OAuthSession;
    __setOAuthSessionForTests(session);

    try {
      expect(getOAuthFlowStatus(sessionId, 'user:other')).toBeNull();
      await expect(completeNativeCliFlow(sessionId, 'code#fragment', 'user:other'))
        .rejects.toThrow('Native CLI session not found');
      expect(session.status).toBe('awaiting_callback');
    } finally {
      __deleteOAuthSessionForTests(sessionId);
    }
  });

  test('same-owner concurrent native Claude completion exchanges and writes credentials once', async () => {
    jest.useFakeTimers();
    const sessionId = 'native_claude_concurrent_callback_single_flight';
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_in: 3600,
      scope: 'user:inference',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const persistClaudeCredentials = jest.fn();
    const session = {
      id: sessionId,
      provider: 'claude-code',
      mode: 'oauth',
      ownerId: 'user:owner',
      process: null,
      authUrl: 'https://platform.claude.com/oauth/authorize',
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      localPort: null,
      oauthState: 'state-owner',
      status: 'awaiting_callback',
      error: null,
      output: '',
      cleanOutput: '',
      createdAt: Date.now(),
      completedAt: null,
      profileKeyBefore: [],
      extraEnv: { codeVerifier: 'verifier-owner' },
      processExited: true,
    } as unknown as OAuthSession;
    __setOAuthSessionForTests(session);

    try {
      const dependencies = { fetchImpl, persistClaudeCredentials };
      const first = completeNativeCliFlow(sessionId, 'code#fragment', 'user:owner', dependencies);
      const second = completeNativeCliFlow(sessionId, 'code#fragment', 'user:owner', dependencies);
      expect(second).toBe(first);

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(persistClaudeCredentials).toHaveBeenCalledTimes(1);

      session.status = 'complete';
      await jest.advanceTimersByTimeAsync(250);
      await expect(Promise.all([first, second])).resolves.toEqual([
        { success: true },
        { success: true },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(persistClaudeCredentials).toHaveBeenCalledTimes(1);
    } finally {
      __deleteOAuthSessionForTests(sessionId);
      jest.useRealTimers();
    }
  });

  test('native Claude completion writes and verifies the configured CLAUDE_CONFIG_DIR', async () => {
    const sessionId = 'native_claude_custom_config_dir';
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-claude-config-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({
      access_token: 'custom-dir-access-token',
      refresh_token: 'custom-dir-refresh-token',
      expires_in: 3600,
      scope: 'user:inference',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const session = {
      id: sessionId,
      provider: 'claude-code',
      mode: 'oauth',
      ownerId: 'user:owner',
      process: null,
      authUrl: 'https://platform.claude.com/oauth/authorize',
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      localPort: null,
      oauthState: 'state-owner',
      status: 'awaiting_callback',
      error: null,
      output: '',
      cleanOutput: '',
      createdAt: Date.now(),
      completedAt: null,
      profileKeyBefore: [],
      extraEnv: { codeVerifier: 'verifier-owner' },
      processExited: true,
    } as unknown as OAuthSession;
    __setOAuthSessionForTests(session);

    try {
      await expect(completeNativeCliFlow(
        sessionId,
        'code#fragment',
        'user:owner',
        { fetchImpl },
      )).resolves.toEqual({ success: true });
      const stored = JSON.parse(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8'));
      expect(stored.claudeAiOauth).toMatchObject({
        accessToken: 'custom-dir-access-token',
        refreshToken: 'custom-dir-refresh-token',
      });
    } finally {
      __deleteOAuthSessionForTests(sessionId);
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('native Claude token exchange cannot overwrite cancellation when fetch ignores abort', async () => {
    const sessionId = 'native_cancel_during_token_exchange';
    const originalFetch = global.fetch;
    global.fetch = jest.fn(() => new Promise(() => undefined)) as typeof fetch;
    const session = {
      id: sessionId,
      provider: 'claude-code',
      mode: 'oauth',
      ownerId: 'user:owner',
      process: null,
      authUrl: 'https://platform.claude.com/oauth/authorize',
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      localPort: null,
      oauthState: 'state-owner',
      status: 'awaiting_callback',
      error: null,
      output: '',
      cleanOutput: '',
      createdAt: Date.now(),
      completedAt: null,
      profileKeyBefore: [],
      extraEnv: { codeVerifier: 'verifier-owner' },
      processExited: true,
    } as unknown as OAuthSession;
    __setOAuthSessionForTests(session);

    try {
      const pending = completeNativeCliFlow(sessionId, 'code#fragment', 'user:owner');
      await Promise.resolve();
      expect(global.fetch).toHaveBeenCalledTimes(1);

      expect(cancelOAuthSessionRecord(session, 'user:owner')).toBe(true);

      await expect(pending).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/cancelled/i),
      });
      expect(session.status).toBe('cancelled');
      expect(session.error).toBeNull();
    } finally {
      __deleteOAuthSessionForTests(sessionId);
      global.fetch = originalFetch;
    }
  });

  test('native Claude token exchange has an abortable body-inclusive deadline', async () => {
    jest.useFakeTimers();
    const sessionId = 'native_claude_exchange_deadline';
    const originalFetch = global.fetch;
    global.fetch = jest.fn(() => new Promise(() => undefined)) as typeof fetch;
    const session = {
      id: sessionId,
      provider: 'claude-code',
      mode: 'oauth',
      ownerId: 'user:owner',
      process: null,
      authUrl: 'https://platform.claude.com/oauth/authorize',
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      localPort: null,
      oauthState: 'state-owner',
      status: 'awaiting_callback',
      error: null,
      output: '',
      cleanOutput: '',
      createdAt: Date.now(),
      completedAt: null,
      profileKeyBefore: [],
      extraEnv: { codeVerifier: 'verifier-owner' },
      processExited: true,
    } as unknown as OAuthSession;
    __setOAuthSessionForTests(session);

    try {
      const pending = completeNativeCliFlow(sessionId, 'code#fragment', 'user:owner');
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(30_000);

      await expect(pending).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/timed out/i),
      });
      expect(session.status).toBe('error');
      expect(session.completionAbortController).toBeUndefined();
    } finally {
      __deleteOAuthSessionForTests(sessionId);
      global.fetch = originalFetch;
      jest.useRealTimers();
    }
  });

  test('post-await Claude CLI import cannot resurrect a cancelled setup session', async () => {
    let releaseImport!: () => void;
    const importer = jest.fn(() => new Promise<void>((resolve) => { releaseImport = resolve; }));
    const session = {
      id: 'claude_import_cancel_guard',
      provider: 'anthropic',
      status: 'processing',
      completedAt: null,
    } as unknown as OAuthSession;

    const pending = completeClaudeCliImportForSession(session, importer);
    expect(importer).toHaveBeenCalledWith(30_000);
    session.status = 'cancelled';
    releaseImport();

    await expect(pending).resolves.toBe(false);
    expect(session.status).toBe('cancelled');
    expect(session.completedAt).toBeNull();
  });

  test('never treats a stale native Claude credential as setup-token completion', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-claude-stale-native-'));
    const credentialPath = path.join(tempDir, '.credentials.json');
    const sessionId = 'claude_setup_token_requires_owned_token';
    fs.writeFileSync(credentialPath, JSON.stringify({
      claudeAiOauth: { accessToken: 'stale-native-access-token' },
    }));
    const session = {
      id: sessionId,
      provider: 'anthropic',
      mode: 'oauth',
      ownerId: 'user:owner',
      process: silentPty(),
      processExited: true,
      processExitCode: 0,
      authUrl: 'https://claude.ai/oauth/authorize',
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      localPort: null,
      oauthState: null,
      status: 'complete',
      error: null,
      output: '',
      cleanOutput: 'Claude setup-token exited successfully without printing a token.',
      createdAt: Date.now(),
      completedAt: Date.now(),
      profileKeyBefore: [],
      nativeCredentialProvider: 'CLAUDE_CODE',
      nativeCredentialPaths: [credentialPath],
      _tokenPromise: Promise.resolve(null),
    } as unknown as OAuthSession;
    __setOAuthSessionForTests(session);

    try {
      await expect(getClaudeSetupToken(sessionId, 'user:owner')).resolves.toEqual({
        success: false,
        error: 'Claude completed but the token could not be extracted from the output.',
      });
      expect((await getClaudeSetupToken(sessionId, 'user:owner') as any).usedCliImport).toBeUndefined();
    } finally {
      __deleteOAuthSessionForTests(sessionId);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('native cancellation reports a credential committed during PTY shutdown', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-native-cancel-'));
    const credentialPath = path.join(tempDir, 'auth.json');
    const sessionId = 'native_cancel_committed_credential';
    const session = {
      id: sessionId,
      provider: 'codex',
      mode: 'device_code',
      ownerId: 'user:owner',
      process: null as any,
      authUrl: null,
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      localPort: null,
      oauthState: null,
      status: 'polling_device',
      error: null,
      output: '',
      cleanOutput: '',
      createdAt: Date.now(),
      completedAt: null,
      profileKeyBefore: [],
      nativeCredentialProvider: 'CODEX',
      nativeCredentialPaths: [credentialPath],
      nativeCredentialSnapshotBefore: captureNativeCredentialSnapshot([credentialPath]),
    } as OAuthSession;
    const process = silentPty(() => {
      fs.writeFileSync(credentialPath, JSON.stringify({ committed: true }), { mode: 0o600 });
      session.processExited = true;
      session.processExitedAt = Date.now();
    });
    session.process = process;
    __setOAuthSessionForTests(session);

    try {
      await expect(cancelOAuthFlow(sessionId, 'user:owner')).resolves.toMatchObject({
        success: false,
        status: 'error',
        credentialState: 'committed',
        error: expect.stringMatching(/credential changed/i),
      });
      await expect(cancelOAuthFlow(sessionId, 'user:owner')).resolves.toMatchObject({
        success: false,
        status: 'error',
        credentialState: 'committed',
        error: expect.stringMatching(/credential changed/i),
      });
      expect(process.kill).toHaveBeenCalledTimes(1);
    } finally {
      __deleteOAuthSessionForTests(sessionId);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('native cancellation remains indeterminate when the credential path becomes a symlink', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-native-cancel-link-'));
    const credentialPath = path.join(tempDir, 'auth.json');
    const targetPath = path.join(tempDir, 'target.json');
    const sessionId = 'native_cancel_indeterminate_credential';
    const session = {
      id: sessionId,
      provider: 'codex',
      mode: 'device_code',
      ownerId: 'user:owner',
      process: null as any,
      authUrl: null,
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      localPort: null,
      oauthState: null,
      status: 'polling_device',
      error: null,
      output: '',
      cleanOutput: '',
      createdAt: Date.now(),
      completedAt: null,
      profileKeyBefore: [],
      nativeCredentialProvider: 'CODEX',
      nativeCredentialPaths: [credentialPath],
      nativeCredentialSnapshotBefore: captureNativeCredentialSnapshot([credentialPath]),
    } as OAuthSession;
    const process = silentPty(() => {
      fs.writeFileSync(targetPath, '{}', { mode: 0o600 });
      fs.symlinkSync(targetPath, credentialPath);
      session.processExited = true;
      session.processExitedAt = Date.now();
    });
    session.process = process;
    __setOAuthSessionForTests(session);

    try {
      await expect(cancelOAuthFlow(sessionId, 'user:owner')).resolves.toMatchObject({
        success: false,
        status: 'error',
        cleanupPending: true,
        credentialState: 'indeterminate',
      });
      expect(getOAuthFlowStatus(sessionId, 'user:owner')).toMatchObject({
        status: 'error',
        cleanupPending: true,
        credentialState: 'indeterminate',
      });

      // The credential path can become attestable again after a transient
      // mount/symlink race. A repeated cancel must re-run the proof instead of
      // leaving the session permanently indeterminate.
      fs.unlinkSync(credentialPath);
      await expect(cancelOAuthFlow(sessionId, 'user:owner')).resolves.toEqual({
        success: true,
        status: 'cancelled',
      });
      expect(getOAuthFlowStatus(sessionId, 'user:owner')).toMatchObject({
        status: 'cancelled',
        cleanupPending: false,
        credentialState: 'absent',
      });
      expect(process.kill).toHaveBeenCalledTimes(1);
    } finally {
      __deleteOAuthSessionForTests(sessionId);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('re-attests a terminal native error instead of treating terminal status as credential proof', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-native-terminal-error-'));
    const credentialPath = path.join(tempDir, 'auth.json');
    const sessionId = 'native_terminal_error_requires_proof';
    const session = {
      id: sessionId,
      provider: 'codex',
      mode: 'device_code',
      ownerId: 'user:owner',
      process: silentPty(),
      processExited: true,
      authUrl: null,
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      localPort: null,
      oauthState: null,
      status: 'error',
      error: 'CLI exited unexpectedly.',
      output: '',
      cleanOutput: '',
      createdAt: Date.now(),
      completedAt: Date.now(),
      profileKeyBefore: [],
      nativeCredentialProvider: 'CODEX',
      nativeCredentialPaths: [credentialPath],
      nativeCredentialSnapshotBefore: captureNativeCredentialSnapshot([credentialPath]),
    } as OAuthSession;
    fs.writeFileSync(credentialPath, JSON.stringify({ committed: true }), { mode: 0o600 });
    __setOAuthSessionForTests(session);

    try {
      expect(getOAuthFlowStatus(sessionId, 'user:owner')).toMatchObject({
        status: 'error',
        cleanupPending: true,
        credentialState: null,
      });
      await expect(cancelOAuthFlow(sessionId, 'user:owner')).resolves.toMatchObject({
        success: false,
        status: 'error',
        credentialState: 'committed',
      });
    } finally {
      __deleteOAuthSessionForTests(sessionId);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('keeps a pre-existing metadata-only OpenClaw profile indeterminate', async () => {
    const sessionId = 'openclaw_opaque_profile_requires_review';
    const session = {
      id: sessionId,
      provider: 'qwen-portal',
      mode: 'oauth',
      ownerId: 'user:owner',
      process: silentPty(),
      processExited: true,
      authUrl: null,
      callbackHintUrl: null,
      deviceCode: null,
      verificationUrl: null,
      localPort: null,
      oauthState: null,
      status: 'error',
      error: 'Provider login exited.',
      output: '',
      cleanOutput: '',
      createdAt: Date.now(),
      completedAt: Date.now(),
      profileKeyBefore: ['qwen-portal:existing'],
      profileStateBefore: {
        'qwen-portal:existing': authProfileStateFingerprint({
          provider: 'qwen-portal',
          type: 'oauth',
          managedBy: 'openclaw-auth-store',
        }),
      },
    } as OAuthSession;
    __setOAuthSessionForTests(session);

    try {
      await expect(cancelOAuthFlow(sessionId, 'user:owner')).resolves.toMatchObject({
        success: false,
        status: 'error',
        cleanupPending: true,
        credentialState: 'indeterminate',
      });
      expect(getOAuthFlowStatus(sessionId, 'user:owner')).toMatchObject({
        cleanupPending: true,
        credentialState: 'indeterminate',
      });
    } finally {
      __deleteOAuthSessionForTests(sessionId);
    }
  });

  test('durably binds native Claude manual PKCE as an attested processless lifecycle', async () => {
    const originalHome = process.env.HOME;
    const originalClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-native-claude-processless-'));
    process.env.HOME = tempHome;
    process.env.CLAUDE_CONFIG_DIR = path.join(tempHome, '.claude');
    let sessionId: string | null = null;
    try {
      const result = await startNativeCliFlow('claude-code', { ownerId: 'user:processless' });
      sessionId = result.sessionId;
      expect(result).toMatchObject({ status: 'awaiting_callback' });
      expect(__readProviderCredentialLifecycleLedgerForTests().records['credential-domain:anthropic'])
        .toMatchObject({
          bindingState: 'attested-processless',
          processPid: null,
          processStartTicks: null,
        });
    } finally {
      if (sessionId) __deleteOAuthSessionForTests(sessionId);
      process.env.HOME = originalHome;
      if (originalClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfig;
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test.each([
    ['OpenClaw OAuth', 'credential-domain:openai', () => startOAuthFlow('openai-codex', { ownerId: 'user:owner' }), 20_200],
    ['device-code OAuth', 'credential-domain:openclaw:github-copilot', () => startDeviceCodeFlow('github-copilot', 'user:owner'), 20_200],
    ['Claude setup-token', 'credential-domain:anthropic', () => startClaudeSetupTokenFlow('user:owner'), 30_200],
    ['native Codex', 'credential-domain:openai', () => startNativeCliFlow('codex', {
      ownerId: 'user:owner',
      forceReauth: true,
      codexLoginStatusProbe: () => 'signed_out',
    }), 20_200],
  ])('binds %s PTYs before the first await, then safely handles startup timeout', async (
    _label,
    namespace,
    start,
    timeoutMs,
  ) => {
    jest.useFakeTimers();
    const originalHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-oauth-start-'));
    process.env.HOME = tempHome;
    const processMock = silentPty();
    processMock.pid = process.pid;
    (pty.spawn as jest.Mock).mockReturnValueOnce(processMock);

    try {
      const settled = start().then(
        () => ({ error: null as any }),
        (error) => ({ error }),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(__readProviderCredentialLifecycleLedgerForTests().records[namespace]).toMatchObject({
        processPid: process.pid,
        processStartTicks: expect.stringMatching(/^\d+$/),
        state: 'active',
      });
      expect(processMock.write).toHaveBeenCalledWith('\n');
      // Simulate backend memory loss while the PTY is still awaiting its first
      // prompt. The durable PID/start-time proof must remain authoritative.
      __resetCredentialLifecycleMemoryForTests();
      await jest.advanceTimersByTimeAsync(timeoutMs);
      // OpenClaw-backed flows perform a separate bounded, strict post-exit
      // credential-store convergence window before classifying the timeout.
      await jest.advanceTimersByTimeAsync(3_500);
      const { error } = await settled;

      expect(error).toBeInstanceOf(Error);
      expect(error.sessionId).toEqual(expect.stringMatching(/^oauth_/));
      expect(error.oauthSessionId).toBe(error.sessionId);
      expect(['absent', 'indeterminate']).toContain(error.credentialState);
      expect(Boolean(error.cleanupPending)).toBe(error.credentialState === 'indeterminate');
      expect(processMock.kill).toHaveBeenCalledTimes(1);
      expect(getOAuthFlowStatus(error.sessionId, 'user:owner')).toMatchObject({
        id: error.sessionId,
        status: 'error',
        cleanupPending: error.credentialState === 'indeterminate',
        credentialState: error.credentialState,
      });
      expect(__readProviderCredentialLifecycleLedgerForTests().records[namespace]).toMatchObject({
        processPid: process.pid,
        processStartTicks: expect.stringMatching(/^\d+$/),
      });
      __deleteOAuthSessionForTests(error.sessionId);
    } finally {
      (pty.spawn as jest.Mock).mockReset();
      process.env.HOME = originalHome;
      fs.rmSync(tempHome, { recursive: true, force: true });
      jest.useRealTimers();
    }
  });

  test.each([
    ['OpenClaw OAuth', () => startOAuthFlow('openai-codex', { ownerId: 'user:bind-failure' })],
    ['native Codex', () => startNativeCliFlow('codex', {
      ownerId: 'user:bind-failure',
      forceReauth: true,
      codexLoginStatusProbe: () => 'signed_out',
    })],
    ['Claude setup-token', () => startClaudeSetupTokenFlow('user:bind-failure')],
  ])('stops and attests a newly spawned %s PTY when durable PID binding fails', async (_label, start) => {
    const originalHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-oauth-bind-failure-'));
    process.env.HOME = tempHome;
    const processMock = silentPty();
    processMock.pid = process.pid;
    (pty.spawn as jest.Mock).mockReturnValueOnce(processMock);
    const bindFailure = jest.spyOn(providerLifecycleLedger, 'bindProviderCredentialLifecycle')
      .mockImplementationOnce(() => { throw new Error('injected ledger bind/fsync failure'); });

    try {
      await expect(start()).rejects.toMatchObject({
        sessionId: expect.stringMatching(/^oauth_/),
        credentialState: expect.stringMatching(/^(absent|indeterminate|committed)$/),
      });
      expect(processMock.kill).toHaveBeenCalledTimes(1);
      expect(processMock.write).not.toHaveBeenCalled();
      for (const record of Object.values(__readProviderCredentialLifecycleLedgerForTests().records)) {
        expect(record.state).not.toBe('active');
      }
    } finally {
      bindFailure.mockRestore();
      (pty.spawn as jest.Mock).mockReset();
      process.env.HOME = originalHome;
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test('joins an exact device-code start and rejects conflicting credential ownership before spawning', async () => {
    let dataHandler: ((chunk: string) => void) | undefined;
    const processMock = {
      onData: jest.fn((handler) => { dataHandler = handler; }),
      onExit: jest.fn(),
      write: jest.fn(),
      kill: jest.fn(),
    } as any;
    (pty.spawn as jest.Mock).mockReturnValueOnce(processMock);

    try {
      const first = startDeviceCodeFlow('github-copilot', 'user:start-owner');
      const second = startDeviceCodeFlow('github-copilot', 'user:start-owner');
      await expect(startDeviceCodeFlow('github-copilot', 'user:other-owner'))
        .rejects.toMatchObject({ statusCode: 409 });

      await new Promise((resolve) => setImmediate(resolve));
      expect(pty.spawn).toHaveBeenCalledTimes(1);
      dataHandler?.('Visit https://github.com/login/device and enter code ABCD-EFGH');
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.sessionId).toBe(secondResult.sessionId);
      await expect(startDeviceCodeFlow('github-copilot', 'user:start-owner'))
        .resolves.toMatchObject({ sessionId: firstResult.sessionId });
      expect(pty.spawn).toHaveBeenCalledTimes(1);
      __deleteOAuthSessionForTests(firstResult.sessionId);
    } finally {
      (pty.spawn as jest.Mock).mockReset();
    }
  });

  test('restart-memory loss retains device admission and never spawns a duplicate upstream flow', async () => {
    let dataHandler: ((chunk: string) => void) | undefined;
    const processMock = {
      onData: jest.fn((handler) => { dataHandler = handler; }),
      onExit: jest.fn(),
      write: jest.fn(),
      kill: jest.fn(),
    } as any;
    (pty.spawn as jest.Mock).mockReturnValueOnce(processMock);

    try {
      const first = startDeviceCodeFlow('github-copilot', 'user:restart-owner');
      await new Promise((resolve) => setImmediate(resolve));
      dataHandler?.('Visit https://github.com/login/device and enter code ABCD-EFGH');
      const firstResult = await first;
      expect(__readProviderCredentialLifecycleLedgerForTests().records['credential-domain:openclaw:github-copilot'])
        .toMatchObject({ state: 'active' });

      __resetCredentialLifecycleMemoryForTests();
      await expect(startDeviceCodeFlow('github-copilot', 'user:restart-owner'))
        .rejects.toMatchObject({
          statusCode: 409,
          code: 'PROVIDER_CREDENTIAL_LIFECYCLE_RECOVERY_REQUIRED',
        });
      expect(pty.spawn).toHaveBeenCalledTimes(1);
      __deleteOAuthSessionForTests(firstResult.sessionId);
    } finally {
      (pty.spawn as jest.Mock).mockReset();
    }
  });

  test('never saves a Claude setup token flushed after cancellation kills the PTY', () => {
    const token = ['sk', 'ant', 'oat01', 'cancelled-token-must-never-persist-1234567890+/='].join('-');
    const persistToken = jest.fn();
    const session = {
      id: 'oauth_cancelled_claude',
      provider: 'anthropic',
      mode: 'oauth',
      ownerId: 'user:owner',
      status: 'awaiting_callback',
      error: null,
      completedAt: null,
      capturedToken: null,
      cleanOutput: '',
      process: { kill: jest.fn() },
    } as any;

    expect(cancelOAuthSessionRecord(session, 'user:owner')).toBe(true);
    // PTYs can flush buffered output after kill() but before onExit. Simulate
    // the hostile ordering where that final chunk contains a valid token.
    session.cleanOutput = `setup token:\r\n${token}\r\n`;

    expect(maybeCaptureClaudeSetupToken(session)).toBeNull();
    expect(completeClaudeSetupTokenProcessExit(session, 0, persistToken)).toBeNull();
    expect(persistToken).not.toHaveBeenCalled();
    expect(session.status).toBe('cancelled');
    expect(session.capturedToken).toBeNull();
    expect(session.processExited).toBe(true);
    expect(session.processExitCode).toBe(0);
  });

  test('Claude PTY exit captures token evidence but never writes credentials itself', () => {
    const token = ['sk', 'ant', 'oat01', 'owned-completion-write-only-1234567890+/='].join('-');
    const persistToken = jest.fn();
    const session = {
      id: 'oauth_claude_exit_evidence_only',
      provider: 'anthropic',
      mode: 'oauth',
      ownerId: 'user:owner',
      status: 'processing',
      error: null,
      completedAt: null,
      capturedToken: token,
      cleanOutput: `setup token: ${token}`,
      process: { kill: jest.fn() },
    } as any;

    expect(completeClaudeSetupTokenProcessExit(session, 0, persistToken)).toBe(token);
    expect(persistToken).not.toHaveBeenCalled();
    expect(session.processExited).toBe(true);
    expect(session.status).toBe('complete');
  });

  test('cancellation invalidates Claude completion ownership before the sole credential write', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-claude-finalize-generation-'));
    const credentialPath = path.join(tempDir, 'native-credential.json');
    const token = ['sk', 'ant', 'oat01', 'generation-owned-write-1234567890+/='].join('-');
    const read = jest.spyOn(openclawConfigManager, 'readAuthProfilesStrictAsync')
      .mockResolvedValue({ version: 2, profiles: {} } as any);
    const save = jest.spyOn(openclawConfigManager, 'saveProviderToken')
      .mockImplementation(() => ({ profileId: 'anthropic:test' }));
    const session = {
      id: 'oauth_claude_cancel_before_owned_write',
      provider: 'anthropic',
      mode: 'oauth',
      ownerId: 'user:owner',
      process: silentPty(),
      processExited: true,
      processExitCode: 0,
      status: 'complete',
      error: null,
      createdAt: Date.now(),
      completedAt: Date.now(),
      capturedToken: token,
      cleanOutput: `setup token: ${token}`,
      profileKeyBefore: [],
      profileStateBefore: {},
      nativeCredentialPaths: [credentialPath],
      nativeCredentialSnapshotBefore: captureNativeCredentialSnapshot([credentialPath]),
    } as unknown as OAuthSession;
    __setOAuthSessionForTests(session);
    try {
      const generation = beginClaudeSetupTokenFinalization(session.id, 'user:owner');
      expect(generation).toEqual(expect.any(Number));
      await expect(cancelOAuthFlow(session.id, 'user:owner')).resolves.toEqual({
        success: true,
        status: 'cancelled',
      });
      expect(commitClaudeSetupTokenCredential(
        session.id,
        token,
        generation!,
        'user:owner',
      )).toMatchObject({ success: false });
      expect(save).not.toHaveBeenCalled();
      expect(session.credentialResolution).toBe('absent');
    } finally {
      __deleteOAuthSessionForTests(session.id);
      read.mockRestore();
      save.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('marks a stopped manual callback session pending until credential absence is attested', () => {
    const session = {
      ownerId: 'user:owner',
      provider: 'claude-code',
      status: 'awaiting_callback',
      error: null,
      completedAt: null,
      process: null,
    } as any;

    expect(cancelOAuthSessionRecord(session, 'user:owner')).toBe(true);
    expect(session.status).toBe('cancelled');
    expect(session.processExited).toBe(true);
    expect(session.processExitedAt).toEqual(expect.any(Number));
    expect(isOAuthSessionCleanupPending(session)).toBe(true);
  });

  test('does not cancel or expire xAI after credential finalization begins', () => {
    const kill = jest.fn();
    const session = {
      provider: 'xai',
      ownerId: 'user:owner',
      status: 'processing',
      expiresAt: 1_700_000_000_000,
      error: null,
      completedAt: null,
      process: { kill },
    } as any;

    expect(cancelOAuthSessionRecord(session, 'user:owner')).toBe(false);
    expect(expireOAuthSessionRecord(session, 1_700_000_000_001)).toBe(false);
    expect(session.status).toBe('processing');
    expect(kill).not.toHaveBeenCalled();
  });

  test('keeps repeated cancellation indeterminate until PTY exit and profile reconciliation finish', () => {
    expect(isOAuthSessionCleanupPending({ status: 'cancelled', processExited: false })).toBe(true);
    expect(isOAuthSessionCleanupPending({ status: 'cancelled', processExited: true, profileReconciliationPending: true })).toBe(true);
    expect(isOAuthSessionCleanupPending({ status: 'cancelled', processExited: true, profileReconciliationPending: false })).toBe(true);
    expect(isOAuthSessionCleanupPending({
      status: 'cancelled',
      processExited: true,
      profileReconciliationPending: false,
      credentialResolution: 'absent',
    })).toBe(false);
  });

  test('requires consecutive strict empty reads after an outage before proving credential absence', async () => {
    const session = {
      id: 'stable-empty-proof',
      provider: 'openai-codex',
      profileKeyBefore: [],
      authStoreReadIndeterminate: false,
    } as unknown as OAuthSession;
    const outageReader = jest.fn(() => {
      session.authStoreReadIndeterminate = true;
      throw new Error('locked store unavailable');
    });
    const delay = jest.fn(async () => undefined);

    await expect(waitForChangedProviderProfile(session, 0, outageReader, delay)).resolves.toBeNull();
    expect(outageReader).toHaveBeenCalledTimes(1);
    expect(session.authStoreReadIndeterminate).toBe(true);

    const recoveredReader = jest.fn(() => {
      session.authStoreReadIndeterminate = false;
      return null;
    });
    await expect(waitForChangedProviderProfile(session, 0, recoveredReader, delay)).resolves.toBeNull();
    expect(recoveredReader).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
  });

  test('accepts a credential that becomes visible between the two stable-empty reads', async () => {
    const session = {
      id: 'late-visible-proof',
      provider: 'openai-codex',
      profileKeyBefore: [],
      authStoreReadIndeterminate: false,
    } as unknown as OAuthSession;
    const reader = jest.fn()
      .mockImplementationOnce(() => null)
      .mockImplementationOnce(() => 'openai-codex:late-profile');

    await expect(waitForChangedProviderProfile(
      session,
      0,
      reader,
      async () => undefined,
    )).resolves.toBe('openai-codex:late-profile');
    expect(reader).toHaveBeenCalledTimes(2);
  });

  test('keeps the event loop responsive while xAI authoritative reconciliation is stalled', async () => {
    const expectedProfileId = 'xai:portal-oauth-responsive';
    let releaseRead!: (profiles: Record<string, any>) => void;
    const read = jest.spyOn(openclawConfigManager, 'readOpenClawAuthStoreProfilesAsync')
      .mockImplementationOnce(() => new Promise((resolve) => { releaseRead = resolve; }));
    const session = {
      id: 'xai-responsive-reconciliation',
      provider: 'xai',
      mode: 'device_code',
      ownerId: 'user:owner',
      process: silentPty(),
      processExited: true,
      processExitCode: 0,
      status: 'polling_device',
      error: null,
      completedAt: null,
      createdAt: Date.now(),
      profileKeyBefore: [],
      expectedProfileId,
    } as unknown as OAuthSession;

    try {
      const reconciliation = scheduleXaiExitProfileReconciliation(session, 0);
      let independentTimerFired = false;
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          independentTimerFired = true;
          resolve();
        }, 0);
      });

      expect(independentTimerFired).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
      releaseRead({
        [expectedProfileId]: { provider: 'xai', type: 'oauth' },
      });
      await expect(reconciliation).resolves.toBe('committed');
    } finally {
      read.mockRestore();
    }
  });

  test('xAI status returns durable state without invoking the synchronous auth-store reader', () => {
    const syncRead = jest.spyOn(openclawConfigManager, 'readOpenClawAuthStoreProfiles')
      .mockImplementation(() => { throw new Error('sync reader must not run'); });
    const session = {
      id: 'xai-nonblocking-status',
      provider: 'xai',
      mode: 'device_code',
      ownerId: 'user:owner',
      process: silentPty(),
      processExited: false,
      status: 'polling_device',
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      profileKeyBefore: [],
      profileStateBefore: {},
      expectedProfileId: 'xai:portal-oauth-nonblocking',
    } as unknown as OAuthSession;
    __setOAuthSessionForTests(session);
    try {
      expect(getOAuthFlowStatus(session.id, 'user:owner')).toMatchObject({
        id: session.id,
        createdProfileId: null,
      });
      expect(syncRead).not.toHaveBeenCalled();
    } finally {
      syncRead.mockRestore();
      __deleteOAuthSessionForTests(session.id);
    }
  });

  test('unexpected xAI inventory drift never becomes credential absence or expected-profile success', async () => {
    jest.useFakeTimers();
    const expectedProfileId = 'xai:portal-oauth-owned';
    const baselineProfile = { provider: 'xai', type: 'oauth' as const, access: 'baseline' };
    const read = jest.spyOn(openclawConfigManager, 'readOpenClawAuthStoreProfilesAsync')
      .mockResolvedValue({
        'xai:baseline': { ...baselineProfile, access: 'rotated-outside-flow' },
        [expectedProfileId]: { provider: 'xai', type: 'oauth', access: 'owned' },
      });
    const session = {
      id: 'xai-unexpected-drift',
      provider: 'xai',
      mode: 'device_code',
      ownerId: 'user:owner',
      process: silentPty(),
      processExited: true,
      processExitCode: 0,
      status: 'polling_device',
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      profileKeyBefore: ['xai:baseline'],
      profileStateBefore: {
        'xai:baseline': authProfileStateFingerprint(baselineProfile),
      },
      expectedProfileId,
    } as unknown as OAuthSession;
    try {
      void scheduleXaiExitProfileReconciliation(session, 0);
      await jest.advanceTimersByTimeAsync(0);
      expect(session.credentialResolution).toBe('indeterminate');
      expect(session.persistedProfileId).toBeUndefined();
      expect(session.profileReconciliationPending).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      if (session.profileReconciliationTimer) clearTimeout(session.profileReconciliationTimer);
      read.mockRestore();
      jest.useRealTimers();
    }
  });

  test('joins xAI reconciliation and never overlaps persistent strict-store probes', async () => {
    jest.useFakeTimers();
    const expectedProfileId = 'xai:portal-oauth-no-overlap';
    const probes: Array<{
      resolve: (profiles: Record<string, any>) => void;
      reject: (error: Error) => void;
    }> = [];
    let activeReads = 0;
    let maxActiveReads = 0;
    const read = jest.spyOn(openclawConfigManager, 'readOpenClawAuthStoreProfilesAsync')
      .mockImplementation(() => new Promise((resolve, reject) => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        probes.push({
          resolve: (profiles) => {
            activeReads -= 1;
            resolve(profiles);
          },
          reject: (error) => {
            activeReads -= 1;
            reject(error);
          },
        });
      }));
    const session = {
      id: 'xai-no-overlap-reconciliation',
      provider: 'xai',
      mode: 'device_code',
      ownerId: 'user:owner',
      process: silentPty(),
      processExited: true,
      processExitCode: 0,
      status: 'polling_device',
      error: null,
      completedAt: null,
      createdAt: Date.now(),
      profileKeyBefore: [],
      expectedProfileId,
    } as unknown as OAuthSession;

    try {
      const first = scheduleXaiExitProfileReconciliation(session, 0);
      const joined = scheduleXaiExitProfileReconciliation(session, 0);
      expect(joined).toBe(first);
      await Promise.resolve();
      expect(read).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(30_000);
      expect(read).toHaveBeenCalledTimes(1);
      expect(maxActiveReads).toBe(1);

      probes[0].reject(new Error('auth store unavailable'));
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(999);
      expect(read).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(2);
      expect(maxActiveReads).toBe(1);

      probes[1].resolve({
        [expectedProfileId]: { provider: 'xai', type: 'oauth' },
      });
      await expect(first).resolves.toBe('committed');
      expect(activeReads).toBe(0);
    } finally {
      read.mockRestore();
      jest.useRealTimers();
    }
  });

  test('resets xAI stable-empty proof after a failed strict read', async () => {
    jest.useFakeTimers();
    const startedAt = Date.now();
    let postDeadlineEmptySeen = false;
    let failureInjected = false;
    let emptyReadsAfterFailure = 0;
    const read = jest.spyOn(openclawConfigManager, 'readOpenClawAuthStoreProfilesAsync')
      .mockImplementation(async () => {
        if (Date.now() - startedAt < 10_000) return {};
        if (!postDeadlineEmptySeen) {
          postDeadlineEmptySeen = true;
          return {};
        }
        if (!failureInjected) {
          failureInjected = true;
          throw new Error('transient auth-store outage');
        }
        emptyReadsAfterFailure += 1;
        return {};
      });
    const session = {
      id: 'xai-stable-empty-reset',
      provider: 'xai',
      mode: 'device_code',
      ownerId: 'user:owner',
      process: silentPty(),
      processExited: true,
      processExitCode: 143,
      status: 'cancelled',
      error: null,
      completedAt: Date.now(),
      createdAt: Date.now(),
      profileKeyBefore: [],
      expectedProfileId: 'xai:portal-oauth-empty-reset',
    } as unknown as OAuthSession;

    try {
      const reconciliation = scheduleXaiExitProfileReconciliation(session, 143);
      let settled = false;
      void reconciliation.finally(() => { settled = true; });

      await jest.advanceTimersByTimeAsync(10_250);
      expect(failureInjected).toBe(true);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1_000);
      expect(emptyReadsAfterFailure).toBe(1);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(250);
      await expect(reconciliation).resolves.toBe('absent');
      expect(emptyReadsAfterFailure).toBe(2);
    } finally {
      read.mockRestore();
      jest.useRealTimers();
    }
  });

  test.each(['committed', 'absent'] as const)(
    'joins the authoritative xAI exit reconciliation before reporting %s',
    async (resolution) => {
      const sessionId = `xai_joined_exit_reconciliation_${resolution}`;
      let settle!: (value: 'committed' | 'absent') => void;
      const profileReconciliationPromise = new Promise<'committed' | 'absent'>((resolve) => {
        settle = resolve;
      });
      const session = {
        id: sessionId,
        provider: 'xai',
        mode: 'device_code',
        ownerId: 'user:owner',
        process: silentPty(),
        processExited: true,
        processExitCode: 143,
        authUrl: null,
        callbackHintUrl: null,
        deviceCode: null,
        verificationUrl: null,
        localPort: null,
        oauthState: null,
        status: 'polling_device',
        error: null,
        output: '',
        cleanOutput: '',
        createdAt: Date.now(),
        completedAt: null,
        profileKeyBefore: [],
        profileReconciliationPending: true,
        profileReconciliationPromise,
      } as OAuthSession;
      __setOAuthSessionForTests(session);

      try {
        const cancellation = cancelOAuthFlow(sessionId, 'user:owner');
        let settled = false;
        void cancellation.finally(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        session.profileReconciliationPending = false;
        settle(resolution);
        if (resolution === 'committed') {
          await expect(cancellation).resolves.toMatchObject({
            success: false,
            status: 'error',
            credentialState: 'committed',
          });
        } else {
          await expect(cancellation).resolves.toEqual({
            success: true,
            status: 'cancelled',
          });
        }
        expect(getOAuthFlowStatus(sessionId, 'user:owner')).toMatchObject({
          cleanupPending: false,
          credentialState: resolution,
        });
      } finally {
        __deleteOAuthSessionForTests(sessionId);
      }
    },
  );

  test('treats an unreadable xAI auth store as indeterminate instead of profile absence', () => {
    const reader = jest.fn(() => { throw new Error('control plane unavailable'); });
    expect(() => readExpectedXaiOAuthProfile('xai:portal-oauth-test', reader as any)).toThrow('control plane unavailable');
    expect(reader).toHaveBeenCalledWith('xai', { strict: true });
    expect(isOAuthSessionCleanupPending({
      status: 'error',
      processExited: true,
      profileReconciliationPending: false,
      authStoreReadIndeterminate: true,
    })).toBe(true);
  });

  test('fails xAI OAuth preflight before spawn when the locked auth store is unreadable', () => {
    const reader = jest.fn(() => { throw new Error('locked store unavailable'); });
    expect(() => readXaiOAuthPreflightState('xai:portal-oauth-new', reader as any)).toThrow('locked store unavailable');
    expect(reader).toHaveBeenCalledWith('xai', { strict: true });
  });

  test('device-code expiry kills an active PTY but never rewrites terminal state', () => {
    const kill = jest.fn();
    const session = {
      status: 'polling_device',
      expiresAt: 1_700_000_000_000,
      error: null,
      completedAt: null,
      process: { kill },
    } as any;

    expect(expireOAuthSessionRecord(session, 1_700_000_000_001)).toBe(true);
    expect(session.status).toBe('expired');
    expect(session.completedAt).toBe(1_700_000_000_001);
    expect(kill).toHaveBeenCalledTimes(1);

    expect(expireOAuthSessionRecord(session, 1_700_000_000_002)).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  test('xAI completion never falls back to a pre-existing OAuth or API-key profile', () => {
    expect(selectCompletedProviderProfileId('xai', [
      'xai:default',
      'xai:subscription-user',
    ], [
      'xai:default',
      'xai:subscription-user',
    ], {
      'xai:default': { provider: 'xai', type: 'api_key' },
      'xai:subscription-user': { provider: 'xai', type: 'oauth' },
    })).toBeNull();

    expect(selectCompletedProviderProfileId('xai', [
      'xai:default',
      'xai:portal-oauth-new',
    ], [
      'xai:default',
    ], {
      'xai:default': { provider: 'xai', type: 'api_key' },
      'xai:portal-oauth-new': { provider: 'xai', type: 'oauth' },
    })).toBe('xai:portal-oauth-new');
  });

  test('requires reusable credential material for Gemini CLI OAuth profiles', () => {
    expect(googleGeminiCliProfileHasUsableCredential({ type: 'oauth' })).toBe(false);
    expect(googleGeminiCliProfileHasUsableCredential({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 3600_000,
    })).toBe(true);
    expect(googleGeminiCliProfileHasUsableCredential({ type: 'api_key', key: 'AIza-test' })).toBe(true);
  });

  test('accepts Claude CLI auth import output even when wrapper exits non-zero', () => {
    const raw = [
      'Updated config: ~/.openclaw/openclaw.json',
      'Auth profile: anthropic:claude-cli (claude-cli/oauth)',
      'Default model available: anthropic/claude-opus-4-8 (use --set-default to apply)',
      'Claude CLI auth detected; kept Anthropic model refs and selected the local Claude CLI runtime.',
    ].join('\n');

    expect(outputLooksLikeClaudeCliAuthImportSuccess(raw)).toBe(true);
  });
});
