import { __gatewayVersionProbeTest } from '../routes/gateway';
import {
  getOpenClawSetupReadiness,
  invalidateOpenClawSetupReadinessCache,
  type OpenClawSetupReadiness,
  type OpenClawSetupReadinessDependencies,
} from '../services/openclawSetupReadiness';

type CliResult = { ok: boolean; stdout: string; stderr: string; error?: string };

const ok = (stdout: string): CliResult => ({ ok: true, stdout, stderr: '' });

function healthyReadiness(overrides: Partial<OpenClawSetupReadiness> = {}): OpenClawSetupReadiness {
  return {
    installed: true,
    version: '2026.7.1-2',
    corePackageVersion: '2026.7.1-2',
    runningVersion: '2026.7.1-2',
    gatewayRunning: true,
    authenticatedRpc: true,
    gatewayProbeOk: true,
    gatewayProbeError: null,
    gatewayUrl: 'http://127.0.0.1:18789',
    hasToken: true,
    tokenParity: true,
    codexPluginVersion: '2026.7.1-1',
    codexPluginInstallSpec: '@openclaw/codex@2026.7.1-1',
    credentialStoreReady: true,
    credentialStoreWritable: true,
    testedCorePackageVersion: '2026.7.1-2',
    testedRuntimeVersion: '2026.7.1',
    testedCodexPluginVersion: '2026.7.1-1',
    testedPairReady: true,
    ready: true,
    blockers: [],
    description: 'ready',
    ...overrides,
  };
}

describe('OpenClaw dashboard version probe', () => {
  afterEach(() => invalidateOpenClawSetupReadinessCache());

  it('shares one serialized readiness sequence with a concurrent dashboard version request', async () => {
    const calls: Array<{ command: string; timeoutMs: number }> = [];
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    const responses = new Map<string, CliResult>([
      ['--version', ok('OpenClaw 2026.7.1-2')],
      ['gateway status --require-rpc --timeout 10000 --json', ok(JSON.stringify({
        gateway: { version: '2026.7.1-2' },
      }))],
      ['gateway probe --json', ok(JSON.stringify({
        ok: true,
        targets: [{ self: { version: '2026.7.1-2' } }],
      }))],
      ['plugins inspect codex --json', ok(JSON.stringify({
        plugin: { version: '2026.7.1-1' },
        install: {
          source: 'npm',
          spec: '@openclaw/codex@2026.7.1-1',
          version: '2026.7.1-1',
        },
      }))],
      ['models auth --agent main list --json', ok(JSON.stringify({ profiles: [] }))],
      ['update status --json --timeout 3', ok(JSON.stringify({
        availability: { latestVersion: '2026.7.1-2' },
        channel: { value: 'stable' },
      }))],
    ]);
    const runCli = async (args: string[], timeoutMs = 8000): Promise<CliResult> => {
      const command = args.join(' ');
      calls.push({ command, timeoutMs });
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await new Promise(resolve => setImmediate(resolve));
      activeCalls -= 1;
      const response = responses.get(command);
      if (!response) throw new Error(`Unexpected OpenClaw CLI command: ${command}`);
      return response;
    };
    const readinessDependencies: OpenClawSetupReadinessDependencies = {
      runOpenClawCli: runCli,
      resolvePackageMetadata: async () => ({
        packageDir: '/usr/lib/node_modules/openclaw',
        version: '2026.7.1-2',
      }),
      readGatewayToken: () => 'matching-token',
      credentialStoreWritable: () => true,
    };

    const readinessPromise = getOpenClawSetupReadiness(
      readinessDependencies,
      { force: true, useSharedCache: true },
    );
    const versionPromise = __gatewayVersionProbeTest.probeOpenClawVersionStatusWithDependencies({
      runCli,
      getSetupReadiness: getOpenClawSetupReadiness,
      getPackageMetadata: () => ({
        packageDir: '/usr/lib/node_modules/openclaw',
        version: '2026.7.1-2',
        mtimeMs: 1_750_000_000_000,
      }),
      getListenerProcess: () => ({
        pid: 1234,
        startedAt: '2025-06-15T15:06:39.000Z',
        startedAtMs: 1_750_000_000_000,
      }),
    });

    const [readiness, status] = await Promise.all([readinessPromise, versionPromise]);

    expect(calls).toEqual([
      { command: '--version', timeoutMs: 4000 },
      { command: 'gateway status --require-rpc --timeout 10000 --json', timeoutMs: 15000 },
      { command: 'gateway probe --json', timeoutMs: 10000 },
      { command: 'plugins inspect codex --json', timeoutMs: 10000 },
      { command: 'models auth --agent main list --json', timeoutMs: 10000 },
      { command: 'update status --json --timeout 3', timeoutMs: 9000 },
    ]);
    expect(maximumActiveCalls).toBe(1);
    expect(readiness.ready).toBe(true);
    expect(status).toEqual(expect.objectContaining({
      installedVersion: '2026.7.1-2',
      installedPackageVersion: '2026.7.1-2',
      runningVersion: '2026.7.1-2',
      codexPluginVersion: '2026.7.1-1',
      codexPluginInstallSpec: '@openclaw/codex@2026.7.1-1',
      latestVersion: '2026.7.1-2',
      updateChannel: 'stable',
      testedPairReady: true,
      testedPairReason: null,
      mismatch: false,
      restartRecommended: false,
      probeOk: true,
      probeError: null,
    }));
    expect(__gatewayVersionProbeTest.OPENCLAW_VERSION_STATUS_COLD_PROBE_BUDGET_MS).toBe(75_000);
  });

  it('propagates a forced refresh to shared readiness before update discovery', async () => {
    const events: string[] = [];
    const getSetupReadiness = jest.fn(async (_overrides, options) => {
      events.push(`readiness:${options?.force === true ? 'force' : 'cached'}`);
      return healthyReadiness();
    });

    await __gatewayVersionProbeTest.probeOpenClawVersionStatusWithDependencies({
      runCli: async (args) => {
        events.push(args.join(' '));
        return ok(JSON.stringify({ availability: { latestVersion: '2026.7.1-2' } }));
      },
      getSetupReadiness,
      getPackageMetadata: () => ({
        packageDir: '/usr/lib/node_modules/openclaw',
        version: '2026.7.1-2',
        mtimeMs: 1_750_000_000_000,
      }),
      getListenerProcess: () => ({ pid: 1234, startedAt: null, startedAtMs: null }),
    }, true);

    expect(events).toEqual([
      'readiness:force',
      'update status --json --timeout 3',
    ]);
    expect(getSetupReadiness).toHaveBeenCalledWith({}, { force: true });
  });

  it('preserves failed readiness proof instead of accepting update discovery alone', async () => {
    const readiness = healthyReadiness({
      authenticatedRpc: false,
      gatewayRunning: false,
      gatewayProbeOk: false,
      gatewayProbeError: 'authenticated gateway probe timed out',
      tokenParity: false,
      testedPairReady: false,
      ready: false,
      blockers: [{
        code: 'gateway-rpc-unavailable',
        message: 'The OpenClaw gateway did not pass an authenticated RPC probe.',
      }],
    });

    const status = await __gatewayVersionProbeTest.probeOpenClawVersionStatusWithDependencies({
      runCli: async () => ok(JSON.stringify({ availability: { latestVersion: '2026.7.1-2' } })),
      getSetupReadiness: async () => readiness,
      getPackageMetadata: () => ({
        packageDir: '/usr/lib/node_modules/openclaw',
        version: '2026.7.1-2',
        mtimeMs: 1_750_000_000_000,
      }),
      getListenerProcess: () => ({ pid: 1234, startedAt: null, startedAtMs: null }),
    });

    expect(status.probeOk).toBe(false);
    expect(status.probeError).toBe('authenticated gateway probe timed out');
    expect(status.testedPairReady).toBe(false);
    expect(status.testedPairReason).toBe('The OpenClaw gateway did not pass an authenticated RPC probe.');
  });

  it('preserves protocol-mismatch stderr and recommends restarting the stale listener', async () => {
    const readinessDependencies: OpenClawSetupReadinessDependencies = {
      runOpenClawCli: async (args) => {
        const command = args.join(' ');
        if (command === '--version') return ok('OpenClaw 2026.7.1-2');
        if (command.startsWith('gateway status ')) return ok('RPC probe: ok');
        if (command === 'gateway probe --json') {
          return {
            ok: false,
            stdout: '',
            stderr: 'Gateway connect failed: protocol mismatch with stale listener',
          };
        }
        if (command === 'plugins inspect codex --json') {
          return ok(JSON.stringify({
            plugin: { version: '2026.7.1-1' },
            install: {
              source: 'npm',
              spec: '@openclaw/codex@2026.7.1-1',
              version: '2026.7.1-1',
            },
          }));
        }
        if (command === 'models auth --agent main list --json') {
          return ok(JSON.stringify({ profiles: [] }));
        }
        throw new Error(`Unexpected OpenClaw readiness command: ${command}`);
      },
      resolvePackageMetadata: async () => ({
        packageDir: '/usr/lib/node_modules/openclaw',
        version: '2026.7.1-2',
      }),
      readGatewayToken: () => 'matching-token',
      credentialStoreWritable: () => true,
    };

    const status = await __gatewayVersionProbeTest.probeOpenClawVersionStatusWithDependencies({
      runCli: async () => ok(JSON.stringify({ availability: { latestVersion: '2026.7.1-2' } })),
      getSetupReadiness: (_overrides, options) => getOpenClawSetupReadiness(
        readinessDependencies,
        { ...options, useSharedCache: true },
      ),
      getPackageMetadata: () => ({
        packageDir: '/usr/lib/node_modules/openclaw',
        version: '2026.7.1-2',
        mtimeMs: 1_750_000_000_000,
      }),
      getListenerProcess: () => ({ pid: 1234, startedAt: null, startedAtMs: null }),
    });

    expect(status.probeOk).toBe(false);
    expect(status.probeError).toBe('Gateway connect failed: protocol mismatch with stale listener');
    expect(status.mismatch).toBe(true);
    expect(status.restartRecommended).toBe(true);
    expect(status.reason).toMatch(/protocol/i);
  });
});
