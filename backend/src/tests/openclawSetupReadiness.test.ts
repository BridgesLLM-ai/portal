import {
  getOpenClawSetupReadiness,
  invalidateOpenClawSetupReadinessCache,
  type OpenClawSetupReadinessDependencies,
} from '../services/openclawSetupReadiness';

type CliResponse = { ok: boolean; stdout: string; stderr: string };

const ok = (stdout = ''): CliResponse => ({ ok: true, stdout, stderr: '' });
const failed = (stderr = 'failed'): CliResponse => ({ ok: false, stdout: '', stderr });

function makeDependencies(options: {
  corePackageVersion?: string | null;
  cliVersion?: string;
  gatewayStatus?: CliResponse;
  gatewayRunningVersion?: string;
  gatewayStatusVersion?: string;
  gatewayProbeSelfVersion?: string | null;
  gatewayProbeOk?: boolean;
  pluginVersion?: string;
  pluginSpec?: string;
  pluginResolvedSpec?: string | null;
  pluginResolvedVersion?: string | null;
  pluginSource?: string;
  pluginRecordedVersion?: string;
  authStore?: CliResponse;
  gatewayToken?: string | null;
  credentialStoreWritable?: boolean;
} = {}): OpenClawSetupReadinessDependencies {
  const corePackageVersion = options.corePackageVersion === undefined ? '2026.7.1-2' : options.corePackageVersion;
  const cliVersion = options.cliVersion || '2026.7.1';
  const gatewayRunningVersion = options.gatewayRunningVersion || '2026.7.1';
  const gatewayProbeOk = options.gatewayProbeOk !== false;
  const pluginVersion = options.pluginVersion || '2026.7.1-1';
  const pluginSpec = options.pluginSpec || '@openclaw/codex@2026.7.1-1';
  const pluginSource = options.pluginSource || 'npm';
  const pluginRecordedVersion = options.pluginRecordedVersion || '2026.7.1-1';

  return {
    runOpenClawCli: async (args) => {
      const command = args.join(' ');
      if (command === '--version') return ok(`OpenClaw ${cliVersion}`);
      if (command.startsWith('gateway status ')) {
        return options.gatewayStatus || ok(JSON.stringify({
          gateway: { version: options.gatewayStatusVersion || gatewayRunningVersion },
        }));
      }
      if (command === 'gateway probe --json') {
        // The real CLI omits self.version when the probe lacks operator scope.
        const self = options.gatewayProbeSelfVersion === null
          ? {}
          : { version: options.gatewayProbeSelfVersion || gatewayRunningVersion };
        return ok(JSON.stringify({
          ok: gatewayProbeOk,
          targets: [{ self }],
        }));
      }
      if (command === 'plugins inspect codex --json') {
        // Mirrors the real record: `spec` is what was requested, the resolved*
        // fields are what is actually installed.
        return ok(JSON.stringify({
          plugin: { version: pluginVersion },
          install: {
            source: pluginSource,
            spec: pluginSpec,
            version: pluginRecordedVersion,
            ...(options.pluginResolvedSpec === undefined
              ? {}
              : { resolvedSpec: options.pluginResolvedSpec }),
            ...(options.pluginResolvedVersion === undefined
              ? {}
              : { resolvedVersion: options.pluginResolvedVersion }),
          },
        }));
      }
      if (command === 'models auth --agent main list --json') {
        return options.authStore || ok(JSON.stringify({ profiles: [] }));
      }
      return failed(`unexpected command: ${command}`);
    },
    resolvePackageMetadata: async () => corePackageVersion
      ? { packageDir: '/usr/lib/node_modules/openclaw', version: corePackageVersion }
      : null,
    readGatewayToken: () => options.gatewayToken === undefined ? 'matching-token' : options.gatewayToken,
    credentialStoreWritable: () => options.credentialStoreWritable !== false,
  };
}

describe('OpenClaw setup readiness', () => {
  afterEach(() => invalidateOpenClawSetupReadinessCache());

  it('allows provider setup only for the exact authenticated and writable tested pair', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies());

    expect(status.ready).toBe(true);
    expect(status.testedPairReady).toBe(true);
    expect(status.tokenParity).toBe(true);
    expect(status.gatewayProbeOk).toBe(true);
    expect(status.gatewayProbeError).toBeNull();
    expect(status.credentialStoreReady).toBe(true);
    expect(status.blockers).toEqual([]);
  });

  it('reads the running gateway version from status when the probe lacks operator scope', async () => {
    // a stock gateway answers `gateway probe` with
    // "missing scope: operator.read", so self.version is absent. The Portal
    // then reported "detected unknown" on a healthy, correctly versioned host.
    const status = await getOpenClawSetupReadiness(makeDependencies({
      gatewayProbeSelfVersion: null,
      gatewayStatusVersion: '2026.7.1-2',
    }));

    expect(status.runningVersion).toBe('2026.7.1-2');
    expect(status.blockers.map((blocker) => blocker.code)).not.toContain('gateway-runtime-mismatch');
  });

  it('accepts the resolved Codex install identity rather than the requested spec', async () => {
    // the CLI records spec "@openclaw/codex" for an install that
    // resolved to "@openclaw/codex@2026.7.1-1". Comparing the requested spec
    // rejected a correctly pinned, integrity-verified official install.
    const status = await getOpenClawSetupReadiness(makeDependencies({
      pluginSpec: '@openclaw/codex',
      pluginResolvedSpec: '@openclaw/codex@2026.7.1-1',
      pluginResolvedVersion: '2026.7.1-1',
    }));

    expect(status.blockers.map((blocker) => blocker.code)).not.toContain('codex-plugin-mismatch');
    expect(status.codexPluginInstallSpec).toBe('@openclaw/codex@2026.7.1-1');
  });

  it('still rejects a Codex install that resolved to another version', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({
      pluginSpec: '@openclaw/codex',
      pluginResolvedSpec: '@openclaw/codex@2026.6.9-1',
      pluginResolvedVersion: '2026.6.9-1',
    }));

    expect(status.blockers.map((blocker) => blocker.code)).toContain('codex-plugin-mismatch');
  });

  it('serializes the five bounded CLI checks within one readiness pass', async () => {
    const base = makeDependencies();
    const commands: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const dependencies: OpenClawSetupReadinessDependencies = {
      ...base,
      runOpenClawCli: async (args, timeoutMs) => {
        commands.push(`${args.join(' ')}@${timeoutMs}`);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setImmediate(resolve));
        const result = await base.runOpenClawCli(args, timeoutMs);
        active -= 1;
        return result;
      },
    };

    const status = await getOpenClawSetupReadiness(dependencies);

    expect(status.ready).toBe(true);
    expect(maximumActive).toBe(1);
    expect(commands).toEqual([
      '--version@4000',
      'gateway status --require-rpc --timeout 10000 --json@15000',
      'gateway probe --json@10000',
      'plugins inspect codex --json@10000',
      'models auth --agent main list --json@10000',
    ]);
  });

  it('deduplicates shared callers, reuses a fresh result, and honors a forced refresh', async () => {
    const base = makeDependencies();
    let cliCalls = 0;
    const dependencies: OpenClawSetupReadinessDependencies = {
      ...base,
      runOpenClawCli: async (args, timeoutMs) => {
        cliCalls += 1;
        await new Promise(resolve => setImmediate(resolve));
        return base.runOpenClawCli(args, timeoutMs);
      },
    };

    const first = getOpenClawSetupReadiness(
      dependencies,
      { force: true, useSharedCache: true },
    );
    const concurrent = getOpenClawSetupReadiness();
    const [firstStatus, concurrentStatus] = await Promise.all([first, concurrent]);

    expect(firstStatus).toBe(concurrentStatus);
    expect(cliCalls).toBe(5);
    expect(await getOpenClawSetupReadiness()).toBe(firstStatus);
    expect(cliCalls).toBe(5);

    const refreshed = await getOpenClawSetupReadiness(
      dependencies,
      { force: true, useSharedCache: true },
    );
    expect(refreshed.ready).toBe(true);
    expect(cliCalls).toBe(10);
  });

  it('rejects a configured token that cannot authenticate to the running gateway', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({ gatewayStatus: failed('unauthorized') }));

    expect(status.ready).toBe(false);
    expect(status.gatewayRunning).toBe(false);
    expect(status.blockers.map(blocker => blocker.code)).toEqual(expect.arrayContaining([
      'gateway-rpc-unavailable',
      'gateway-token-mismatch',
    ]));
  });

  it('rejects a stale listener running a different OpenClaw runtime', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({ gatewayRunningVersion: '2026.6.9' }));

    expect(status.ready).toBe(false);
    expect(status.testedPairReady).toBe(false);
    expect(status.blockers).toContainEqual(expect.objectContaining({ code: 'gateway-runtime-mismatch' }));
  });

  it('rejects a mismatched core package even when the CLI and gateway answer', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({ corePackageVersion: '2026.7.1' }));

    expect(status.ready).toBe(false);
    expect(status.blockers).toContainEqual(expect.objectContaining({ code: 'core-package-mismatch' }));
  });

  it('rejects a plugin that is not the exact pinned npm install record', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({
      pluginVersion: '2026.7.1',
      pluginSpec: '@openclaw/codex@2026.7.1',
      pluginRecordedVersion: '2026.7.1',
    }));

    expect(status.ready).toBe(false);
    expect(status.blockers).toContainEqual(expect.objectContaining({ code: 'codex-plugin-mismatch' }));
  });

  it('rejects an unavailable or unwritable credential control plane', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({
      authStore: failed('store unavailable'),
      credentialStoreWritable: false,
    }));

    expect(status.ready).toBe(false);
    expect(status.blockers.map(blocker => blocker.code)).toEqual(expect.arrayContaining([
      'auth-store-unavailable',
      'credential-store-not-writable',
    ]));
  });

  it('rejects a missing gateway token without misreporting it as a mismatch', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({ gatewayToken: null }));

    expect(status.ready).toBe(false);
    expect(status.blockers).toContainEqual(expect.objectContaining({ code: 'gateway-token-missing' }));
    expect(status.blockers).not.toContainEqual(expect.objectContaining({ code: 'gateway-token-mismatch' }));
  });
});
