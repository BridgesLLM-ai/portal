import { execFile } from 'child_process';
import {
  OllamaBackendAddressFamily,
  NativeOllamaBackendBindingState,
} from '@prisma/client';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

import {
  FEATURE_READINESS_MATRIX,
  buildOllamaFeatureReadiness,
  evaluateFeatureReadinessCheck,
  isSuccessfulReadinessHttpStatus,
  probePinnedCliVersion,
  summarizeFeature,
  type ReadinessCheckResult,
} from '../config/featureReadiness';
import { PORTAL_TOOL_VERSIONS } from '../config/toolVersions';
import {
  OllamaBackendAuthorityError,
  type OllamaBackendAuthorityResponse,
  type ResolvedOllamaBackendAuthority,
} from '../services/ollamaBackendAuthority';

const mockedExecFile = jest.mocked(execFile);

function check(required: boolean, ok: boolean): ReadinessCheckResult {
  return { id: `${required}-${ok}`, label: 'check', type: 'command', required, ok, message: '', remediation: '' };
}

function ollamaFeatures() {
  const local = FEATURE_READINESS_MATRIX.find((feature) => feature.id === 'ollamaLocal');
  const tailnet = FEATURE_READINESS_MATRIX.find((feature) => feature.id === 'ollamaRemote');
  if (!local || !tailnet) throw new Error('Ollama readiness features are missing');
  return { local, tailnet };
}

function localAuthority(): ResolvedOllamaBackendAuthority {
  return {
    authority: {
      kind: 'LOCAL',
      source: 'local-policy',
      endpoint: 'http://127.0.0.1:11434',
      generation: null,
      version: null,
      bindingFingerprint: 'local-ollama-v1:127.0.0.1:11434',
      selectedModel: null,
      selectedModelDigest: null,
    },
    bindingView: {
      purposeId: 'PRIMARY',
      authority: null,
      candidate: null,
    },
  };
}

function tailnetAuthority(): ResolvedOllamaBackendAuthority {
  const now = new Date('2026-07-24T04:30:00.000Z');
  return {
    authority: {
      kind: 'TAILNET',
      source: 'tailnet-binding',
      endpoint: null,
      generation: 9,
      version: 4,
      bindingFingerprint: 'sensitive-binding-fingerprint',
      selectedModel: 'qwen3:8b',
      selectedModelDigest: `sha256:${'a'.repeat(64)}`,
    },
    bindingView: {
      purposeId: 'PRIMARY',
      authority: {
        id: 'binding-id',
        purposeId: 'PRIMARY',
        generation: 9,
        version: 4,
        state: NativeOllamaBackendBindingState.ACTIVE,
        tailnetName: 'private-tailnet.example',
        stableNodeId: 'sensitive-stable-node-id',
        nodePublicKey: `nodekey:${'b'.repeat(64)}`,
        observedAddress: '100.64.20.30',
        addressFamily: OllamaBackendAddressFamily.IPV4,
        servePort: 11435,
        bindingFingerprint: 'sensitive-binding-fingerprint',
        selectedModel: 'qwen3:8b',
        selectedModelDigest: `sha256:${'a'.repeat(64)}`,
        grantPeerAttestationFingerprint:
          'sensitive-grant-peer-attestation-fingerprint',
        grantTemplateHash: 'sensitive-grant-template-hash',
        grantAcknowledgedAt: now,
        grantAcknowledgedBy: 'sensitive-grant-actor',
        legacyHelperRetirementAcknowledgedAt: null,
        legacyHelperRetirementAcknowledgedBy: null,
        legacyHelperRetirementEvidence: null,
        configuredByUserId: 'sensitive-owner-id',
        observedAt: now,
        verifiedAt: now,
        activatedAt: now,
        disconnectedAt: null,
        createdAt: now,
        updatedAt: now,
        removedAt: null,
      },
      candidate: null,
    },
  };
}

function authorityResponse(
  resolved: ResolvedOllamaBackendAuthority,
  statusCode = 200,
): OllamaBackendAuthorityResponse {
  return {
    authority: resolved.authority,
    statusCode,
    headers: Object.freeze({ 'content-type': 'application/json' }),
    body: Buffer.from('{"models":[]}'),
    streaming: false,
  };
}

describe('feature readiness contract', () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  test('optional tools do not downgrade a feature whose required contract is healthy', () => {
    expect(summarizeFeature([check(true, true), check(false, false)])).toBe('ready');
    expect(summarizeFeature([check(true, false), check(false, true)])).toBe('partial');
    expect(summarizeFeature([check(true, false), check(false, false)])).toBe('missing');
  });

  test('every command check is one physical shell line', () => {
    // The executor runs checks with `bash -c`, where an embedded newline ends
    // the command and a continuation line starting with `&&` is a syntax
    // error. Two required Remote Desktop checks shipped that way and reported
    // a healthy install as PARTIAL with raw bash errors as the check message.
    for (const feature of FEATURE_READINESS_MATRIX) {
      for (const checkDef of feature.checks) {
        if (checkDef.type !== 'command' || !checkDef.command) continue;
        expect({
          feature: feature.id,
          check: checkDef.id,
          multiline: /[\r\n]/.test(checkDef.command),
        }).toEqual({ feature: feature.id, check: checkDef.id, multiline: false });
      }
    }
  });

  test('treats only 2xx HTTP responses as ready', () => {
    expect(isSuccessfulReadinessHttpStatus(200)).toBe(true);
    expect(isSuccessfulReadinessHttpStatus(204)).toBe(true);
    expect(isSuccessfulReadinessHttpStatus(299)).toBe(true);
    expect(isSuccessfulReadinessHttpStatus(300)).toBe(false);
    expect(isSuccessfulReadinessHttpStatus(307)).toBe(false);
    expect(isSuccessfulReadinessHttpStatus(308)).toBe(false);
    expect(isSuccessfulReadinessHttpStatus(400)).toBe(false);
  });

  test('keeps raw URLs out of the Tailnet readiness definition', () => {
    const { local, tailnet } = ollamaFeatures();
    expect(local?.checks.find((item) => item.id === 'ollamaBinary')?.command)
      .toBe('ollama --version');
    expect(local?.checks.find((item) => item.id === 'ollamaLocalApi')?.url)
      .toBe('http://127.0.0.1:11434/api/tags');

    expect(tailnet.checks).toEqual([
      expect.objectContaining({
        id: 'ollamaTailnetApi',
        label: 'Identity-bound Tailnet Ollama API',
        required: true,
      }),
    ]);
    expect(tailnet.checks[0]).not.toHaveProperty('url');
    expect(JSON.stringify(tailnet)).not.toContain('http://');
    expect(JSON.stringify(tailnet)).not.toContain('https://');
  });

  test('LOCAL selection probes the exact central authority and the local binary only', async () => {
    const { local, tailnet } = ollamaFeatures();
    const resolved = localAuthority();
    const resolveOllamaAuthorityImpl = jest.fn(async () => resolved);
    const response = authorityResponse(resolved);
    const requestResolvedOllamaImpl = jest.fn(async () => response);
    const probeLocalOllamaVersionImpl = jest.fn(async () => ({
      ok: true,
      message: 'ollama version 0.11.0',
    }));

    const result = await buildOllamaFeatureReadiness(local, tailnet, {
      resolveOllamaAuthorityImpl,
      requestResolvedOllamaImpl,
      probeLocalOllamaVersionImpl,
    });

    expect(resolveOllamaAuthorityImpl).toHaveBeenCalledTimes(1);
    expect(requestResolvedOllamaImpl).toHaveBeenCalledWith(resolved, {
      path: '/api/tags',
      method: 'GET',
      timeoutMs: 2000,
      maxResponseBytes: 1024 * 1024,
    });
    expect(probeLocalOllamaVersionImpl).toHaveBeenCalledTimes(1);
    expect(result.ollamaLocal).toMatchObject({
      status: 'ready',
      applicable: true,
      note: 'The selected backend is the fixed loopback Ollama authority.',
    });
    expect(result.ollamaRemote).toMatchObject({
      status: 'not_configured',
      applicable: false,
      note: 'Local Ollama is selected; no Tailnet backend is probed.',
    });
    expect(response.body.every((byte) => byte === 0)).toBe(true);
  });

  test('TAILNET selection uses the exact identity-bound authority without any local probe', async () => {
    const { local, tailnet } = ollamaFeatures();
    const resolved = tailnetAuthority();
    const resolveOllamaAuthorityImpl = jest.fn(async () => resolved);
    const response = authorityResponse(resolved);
    const requestResolvedOllamaImpl = jest.fn(async () => response);
    const probeLocalOllamaVersionImpl = jest.fn();

    const result = await buildOllamaFeatureReadiness(local, tailnet, {
      resolveOllamaAuthorityImpl,
      requestResolvedOllamaImpl,
      probeLocalOllamaVersionImpl,
    });

    expect(resolveOllamaAuthorityImpl).toHaveBeenCalledTimes(1);
    expect(requestResolvedOllamaImpl).toHaveBeenCalledWith(resolved, {
      path: '/api/tags',
      method: 'GET',
      timeoutMs: 2500,
      maxResponseBytes: 1024 * 1024,
    });
    expect(probeLocalOllamaVersionImpl).not.toHaveBeenCalled();
    expect(mockedExecFile).not.toHaveBeenCalled();
    expect(result.ollamaLocal).toMatchObject({
      status: 'not_configured',
      applicable: false,
      note: 'An identity-bound Tailnet Ollama backend is selected; local Ollama is not probed.',
    });
    expect(result.ollamaRemote).toMatchObject({
      status: 'ready',
      applicable: true,
      note: 'The selected backend is verified through its identity-bound private Tailscale Serve route.',
      checks: [{
        id: 'ollamaTailnetApi',
        ok: true,
        message: 'Identity-bound Tailnet Ollama API responded with HTTP 200.',
      }],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('100.64.20.30');
    expect(serialized).not.toContain('private-tailnet.example');
    expect(serialized).not.toContain('sensitive-stable-node-id');
    expect(serialized).not.toContain('sensitive-grant-actor');
    expect(serialized).not.toContain('sensitive-owner-id');
    expect(serialized).not.toContain('sensitive-binding-fingerprint');
    expect(response.body.every((byte) => byte === 0)).toBe(true);
  });

  test('disabled authority reports both modes as unconfigured without probing either transport', async () => {
    const { local, tailnet } = ollamaFeatures();
    const requestResolvedOllamaImpl = jest.fn();
    const probeLocalOllamaVersionImpl = jest.fn();

    const result = await buildOllamaFeatureReadiness(local, tailnet, {
      resolveOllamaAuthorityImpl: jest.fn(async () => {
        throw new OllamaBackendAuthorityError('LOCAL_DISABLED', 409);
      }),
      requestResolvedOllamaImpl,
      probeLocalOllamaVersionImpl,
    });

    expect(result.ollamaLocal).toMatchObject({
      status: 'not_configured',
      applicable: false,
    });
    expect(result.ollamaRemote).toMatchObject({
      status: 'not_configured',
      applicable: false,
    });
    expect(result.ollamaLocal.note).toContain('No Ollama backend authority is selected.');
    expect(requestResolvedOllamaImpl).not.toHaveBeenCalled();
    expect(probeLocalOllamaVersionImpl).not.toHaveBeenCalled();
  });

  test('disconnected Tailnet authority fails honestly and still never probes local', async () => {
    const { local, tailnet } = ollamaFeatures();
    const requestResolvedOllamaImpl = jest.fn();
    const probeLocalOllamaVersionImpl = jest.fn();

    const result = await buildOllamaFeatureReadiness(local, tailnet, {
      resolveOllamaAuthorityImpl: jest.fn(async () => {
        throw new OllamaBackendAuthorityError('REMOTE_DISCONNECTED', 409);
      }),
      requestResolvedOllamaImpl,
      probeLocalOllamaVersionImpl,
    });

    expect(result.ollamaLocal).toMatchObject({
      status: 'not_configured',
      applicable: false,
    });
    expect(result.ollamaRemote).toMatchObject({
      status: 'missing',
      applicable: true,
      note: 'The identity-bound Tailnet Ollama backend is disconnected and must be reverified.',
    });
    expect(requestResolvedOllamaImpl).not.toHaveBeenCalled();
    expect(probeLocalOllamaVersionImpl).not.toHaveBeenCalled();
  });

  test('redacts Tailnet transport errors and never falls back to local readiness', async () => {
    const { local, tailnet } = ollamaFeatures();
    const resolved = tailnetAuthority();
    const probeLocalOllamaVersionImpl = jest.fn();

    const result = await buildOllamaFeatureReadiness(local, tailnet, {
      resolveOllamaAuthorityImpl: jest.fn(async () => resolved),
      requestResolvedOllamaImpl: jest.fn(async () => {
        throw new Error('dial 100.64.20.30:11435 private route failed');
      }),
      probeLocalOllamaVersionImpl,
    });

    expect(result.ollamaRemote).toMatchObject({
      status: 'missing',
      applicable: true,
      checks: [{
        ok: false,
        message: 'The identity-bound Tailnet Ollama backend did not pass readiness verification.',
      }],
    });
    expect(probeLocalOllamaVersionImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('100.64.20.30');
    expect(JSON.stringify(result)).not.toContain('do-not-leak');
  });

  test('probes the local Ollama version without a shell or inherited endpoint/proxy authority', async () => {
    const previous = {
      OLLAMA_HOST: process.env.OLLAMA_HOST,
      OLLAMA_API_URL: process.env.OLLAMA_API_URL,
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
    };
    process.env.OLLAMA_HOST = 'http://100.64.0.20:11434';
    process.env.OLLAMA_API_URL = 'http://169.254.169.254:11434';
    process.env.HTTP_PROXY = 'http://proxy.invalid:3128';
    process.env.HTTPS_PROXY = 'http://proxy.invalid:3128';
    process.env.ALL_PROXY = 'socks5://proxy.invalid:1080';
    mockedExecFile.mockImplementation(((_command: string, _args: string[], _options: unknown, callback: Function) => {
      callback(null, 'ollama version 0.11.0\n', '');
      return {} as any;
    }) as any);

    try {
      const definition = FEATURE_READINESS_MATRIX
        .find((feature) => feature.id === 'ollamaLocal')
        ?.checks.find((item) => item.id === 'ollamaBinary');
      expect(definition).toBeDefined();
      await expect(evaluateFeatureReadinessCheck(definition!)).resolves.toMatchObject({
        ok: true,
        message: 'ollama version 0.11.0',
      });
      expect(mockedExecFile).toHaveBeenCalledWith(
        'ollama',
        ['--version'],
        {
          timeout: 3_000,
          env: {
            PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            HOME: process.env.HOME || '/root',
            LANG: 'C',
            LC_ALL: 'C',
            OLLAMA_HOST: 'http://127.0.0.1:11434',
          },
        },
        expect.any(Function),
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('requires the out-of-process Remote Desktop recovery timer', () => {
    const remoteDesktop = FEATURE_READINESS_MATRIX.find((feature) => feature.id === 'remoteDesktop');
    const recovery = remoteDesktop?.checks.find((item) => item.id === 'automaticRecovery');
    expect(recovery).toMatchObject({ type: 'command', required: true });
    expect(recovery?.command).toContain('systemctl is-active --quiet bridges-rd-healthcheck.timer');
    expect(recovery?.command).toContain('test -x /usr/local/bin/bridges-rd-healthcheck.sh');
  });

  test('requires the reconciled AI runtime desktop launchers', () => {
    const remoteDesktop = FEATURE_READINESS_MATRIX.find((feature) => feature.id === 'remoteDesktop');
    const launchers = remoteDesktop?.checks.find((item) => item.id === 'aiProviderLaunchers');
    expect(launchers).toMatchObject({ type: 'command', required: true });
    expect(launchers?.command).toContain('/usr/local/bin/bridges-rd-ai-launchers.sh verify');
  });

  test('reports the durable authorization-transition runtime as ready', async () => {
    const authorizationTransitions = FEATURE_READINESS_MATRIX.find(
      (feature) => feature.id === 'authorizationTransitions',
    );
    const quiescence = authorizationTransitions?.checks.find(
      (item) => item.id === 'projectAuthorizationTransitionQuiescence',
    );
    expect(quiescence).toMatchObject({ type: 'config', required: true });
    await expect(evaluateFeatureReadinessCheck(quiescence!)).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining(
        'durable restart-recoverable transition',
      ),
    });
    expect(quiescence?.remediation).toContain('repair the durable authorization-transition journal');
  });
});

describe('probePinnedCliVersion', () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  test('verifies the exact Portal-tested pin', async () => {
    mockedExecFile.mockImplementation(((_command: string, _args: string[], _options: unknown, callback: Function) => {
      callback(null, 'codex-cli 1.2.3\n', '');
    }) as any);
    await expect(probePinnedCliVersion({ binary: 'codex', args: ['--version'], tested: '1.2.3' }))
      .resolves.toEqual({ ok: true, message: 'Portal-tested 1.2.3 (verified)' });
  });

  test('reports drift with the actually installed version', async () => {
    mockedExecFile.mockImplementation(((_command: string, _args: string[], _options: unknown, callback: Function) => {
      callback(null, 'agy 9.9.9\n', '');
    }) as any);
    await expect(probePinnedCliVersion({
      binary: 'agy',
      args: ['--version'],
      tested: '1.1.7',
      env: { AGY_CLI_DISABLE_AUTO_UPDATE: '1' },
    })).resolves.toEqual({ ok: false, message: 'Installed 9.9.9 has drifted from the Portal-tested 1.1.7.' });
  });

  test('fails closed on missing binaries and versionless output', async () => {
    mockedExecFile.mockImplementation(((_command: string, _args: string[], _options: unknown, callback: Function) => {
      callback(new Error('spawn grok ENOENT'), '', '');
    }) as any);
    await expect(probePinnedCliVersion({ binary: 'grok', args: ['--no-auto-update', '--version'], tested: '0.2.112' }))
      .resolves.toMatchObject({ ok: false, message: expect.stringContaining('Could not verify the Portal-tested 0.2.112') });

    mockedExecFile.mockImplementation(((_command: string, _args: string[], _options: unknown, callback: Function) => {
      callback(null, 'no digits here', '');
    }) as any);
    await expect(probePinnedCliVersion({ binary: 'grok', args: ['--version'], tested: '0.2.112' }))
      .resolves.toEqual({ ok: false, message: 'No version reported (Portal-tested 0.2.112).' });
  });

  test('the probe never inherits ambient endpoint or proxy environment', async () => {
    mockedExecFile.mockImplementation(((_command: string, _args: string[], options: { env?: Record<string, string> }, callback: Function) => {
      expect(options.env).toEqual({
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        GROK_DISABLE_AUTOUPDATER: '1',
      });
      callback(null, 'grok 0.2.112\n', '');
    }) as any);
    await expect(probePinnedCliVersion({
      binary: 'grok',
      args: ['--no-auto-update', '--version'],
      tested: '0.2.112',
      env: { GROK_DISABLE_AUTOUPDATER: '1' },
    })).resolves.toEqual({ ok: true, message: 'Portal-tested 0.2.112 (verified)' });
  });

  test('the Agent Tools matrix pins every native provider CLI to the portal catalog', () => {
    const agentTools = FEATURE_READINESS_MATRIX.find((feature) => feature.id === 'agentTools');
    const byId = Object.fromEntries((agentTools?.checks || []).map((check) => [check.id, check]));
    expect(byId.codex?.pinnedCli).toMatchObject({ binary: 'codex', tested: PORTAL_TOOL_VERSIONS.codexCli });
    expect(byId.claude?.pinnedCli).toMatchObject({ binary: 'claude', tested: PORTAL_TOOL_VERSIONS.claudeCode });
    expect(byId.antigravity?.pinnedCli).toMatchObject({
      binary: 'agy',
      tested: PORTAL_TOOL_VERSIONS.antigravity,
      env: { AGY_CLI_DISABLE_AUTO_UPDATE: '1' },
    });
    expect(byId.grokBuild?.pinnedCli).toMatchObject({
      binary: 'grok',
      tested: PORTAL_TOOL_VERSIONS.grokBuild,
      env: { GROK_DISABLE_AUTOUPDATER: '1' },
    });
  });
});
