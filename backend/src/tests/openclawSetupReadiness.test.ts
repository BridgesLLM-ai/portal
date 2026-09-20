import {
  __openClawSetupReadinessTest,
  getOpenClawSetupReadiness,
  __openClawSetupReadinessCacheTest,
  invalidateOpenClawSetupReadinessCache,
  type OpenClawSetupReadinessDependencies,
} from '../services/openclawSetupReadiness';
import fs from 'fs';
import os from 'os';
import path from 'path';

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
  gatewayProbeUrl?: string;
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
  const corePackageVersion = options.corePackageVersion === undefined ? '2026.9.1' : options.corePackageVersion;
  const cliVersion = options.cliVersion || '2026.9.1';
  const gatewayRunningVersion = options.gatewayRunningVersion || '2026.9.1';
  const gatewayProbeOk = options.gatewayProbeOk !== false;
  const pluginVersion = options.pluginVersion || '2026.9.1';
  const pluginSpec = options.pluginSpec || '@openclaw/codex@2026.9.1';
  const pluginSource = options.pluginSource || 'npm';
  const pluginRecordedVersion = options.pluginRecordedVersion || '2026.9.1';

  return {
    runOpenClawCli: async (args) => {
      const command = args.join(' ');
      if (command === '--version') return ok(`OpenClaw ${cliVersion}`);
      if (command.startsWith('gateway status ')) {
        return options.gatewayStatus || ok(JSON.stringify({
          gateway: { version: options.gatewayStatusVersion || gatewayRunningVersion },
          rpc: { ok: true },
        }));
      }
      if (command === 'gateway probe --json') {
        // The real CLI omits self.version when the probe lacks operator scope.
        const self = options.gatewayProbeSelfVersion === null
          ? {}
          : { version: options.gatewayProbeSelfVersion || gatewayRunningVersion };
        return ok(JSON.stringify({
          ok: gatewayProbeOk,
          targets: [{ self, url: options.gatewayProbeUrl || 'ws://127.0.0.1:18789', connect: { rpcOk: true } }],
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

  it('accepts a writable regular config file with a writable parent directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-readiness-file-'));
    try {
      const configPath = path.join(root, 'openclaw.json');
      fs.writeFileSync(configPath, '{}\n', { mode: 0o600 });
      expect(__openClawSetupReadinessTest.existingPathChainIsSafeAndWritable(configPath)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows provider setup only for the exact authenticated and writable tested pair', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies());

    expect(status.ready).toBe(true);
    expect(status.testedPairReady).toBe(true);
    expect(status.tokenParity).toBe(true);
    expect(status.gatewayProbeOk).toBe(true);
    expect(status.gatewayProbeError).toBeNull();
    expect(status.credentialStoreReady).toBe(true);
    expect(status.testedRuntimeFamily).toBe('current-2026.9.1');
    expect(status.blockers).toEqual([]);
  });

  it.each([
    ['2026.9.2', '2026.9.2', true],
    ['2026.9.2', '2026.9.1', false],
    ['2026.9.3', '2026.9.3', true],
    ['2026.9.3', '2026.9.2', false],
    ['2026.9.4', '2026.9.4', false],
  ])('checks the native patch tuple core=%s plugin=%s', async (core, plugin, expected) => {
    const status = await getOpenClawSetupReadiness(makeDependencies({
      corePackageVersion: core, cliVersion: core, gatewayRunningVersion: core,
      pluginVersion: plugin, pluginSpec: `@openclaw/codex@${plugin}`, pluginRecordedVersion: plugin,
    }));
    expect(status.ready).toBe(expected);
    if (expected) {
      expect(status.testedRuntimeFamily).toBe('current-2026.9.1');
      expect(status.testedCorePackageVersion).toBe(core);
      expect(status.testedCodexPluginVersion).toBe(plugin);
      expect(status.blockers).toEqual([]);
    }
  });

  it('retains the exact Portal-only-update 2026.7.1 package/runtime/plugin tuple', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({
      corePackageVersion: '2026.7.1-2',
      cliVersion: '2026.7.1',
      gatewayRunningVersion: '2026.7.1',
      pluginVersion: '2026.7.1-1',
      pluginSpec: '@openclaw/codex@2026.7.1-1',
      pluginRecordedVersion: '2026.7.1-1',
    }));

    expect(status.ready).toBe(true);
    expect(status.testedPairReady).toBe(true);
    expect(status.testedRuntimeFamily).toBe('legacy-2026.7.1');
    expect(status.testedCorePackageVersion).toBe('2026.7.1-2');
    expect(status.testedRuntimeVersion).toBe('2026.7.1');
    expect(status.testedCodexPluginVersion).toBe('2026.7.1-1');
    expect(status.blockers).toEqual([]);
  });

  it('accepts the exact legacy package banner without accepting arbitrary suffixes', async () => {
    const legacyPackageBanner = await getOpenClawSetupReadiness(makeDependencies({
      corePackageVersion: '2026.7.1-2',
      cliVersion: '2026.7.1-2',
      gatewayRunningVersion: '2026.7.1-2',
      pluginVersion: '2026.7.1-1',
      pluginSpec: '@openclaw/codex@2026.7.1-1',
      pluginRecordedVersion: '2026.7.1-1',
    }));
    expect(legacyPackageBanner.testedPairReady).toBe(true);

    const inventedSuffix = await getOpenClawSetupReadiness(makeDependencies({
      corePackageVersion: '2026.9.1',
      cliVersion: '2026.9.1-1',
      gatewayRunningVersion: '2026.9.1-1',
    }));
    expect(inventedSuffix.testedPairReady).toBe(false);
    expect(inventedSuffix.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      'cli-runtime-mismatch',
      'gateway-runtime-mismatch',
    ]));
  });

  it('rejects mixed core, runtime, gateway, and Codex plugin families', async () => {
    const mixedRuntime = await getOpenClawSetupReadiness(makeDependencies({
      corePackageVersion: '2026.7.1-2',
      cliVersion: '2026.9.1',
      gatewayRunningVersion: '2026.9.1',
      pluginVersion: '2026.7.1-1',
      pluginSpec: '@openclaw/codex@2026.7.1-1',
      pluginRecordedVersion: '2026.7.1-1',
    }));
    expect(mixedRuntime.testedPairReady).toBe(false);
    expect(mixedRuntime.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      'cli-runtime-mismatch',
      'gateway-runtime-mismatch',
    ]));

    const mixedPlugin = await getOpenClawSetupReadiness(makeDependencies({
      corePackageVersion: '2026.7.1-2',
      cliVersion: '2026.7.1',
      gatewayRunningVersion: '2026.7.1',
      pluginVersion: '2026.9.1',
      pluginSpec: '@openclaw/codex@2026.9.1',
      pluginRecordedVersion: '2026.9.1',
    }));
    expect(mixedPlugin.testedPairReady).toBe(false);
    expect(mixedPlugin.blockers).toContainEqual(expect.objectContaining({ code: 'codex-plugin-mismatch' }));
  });

  it('reads the running gateway version from status when the probe lacks operator scope', async () => {
    // a stock gateway answers `gateway probe` with
    // "missing scope: operator.read", so self.version is absent. The Portal
    // then reported "detected unknown" on a healthy, correctly versioned host.
    const status = await getOpenClawSetupReadiness(makeDependencies({
      gatewayProbeSelfVersion: null,
      gatewayStatusVersion: '2026.9.1',
    }));

    expect(status.runningVersion).toBe('2026.9.1');
    expect(status.blockers.map((blocker) => blocker.code)).not.toContain('gateway-runtime-mismatch');
  });

  it('accepts the resolved Codex install identity rather than the requested spec', async () => {
    // the CLI records spec "@openclaw/codex" for an install that
    // resolved to "@openclaw/codex@2026.9.1". Comparing the requested spec
    // rejected a correctly pinned, integrity-verified official install.
    const status = await getOpenClawSetupReadiness(makeDependencies({
      pluginSpec: '@openclaw/codex',
      pluginResolvedSpec: '@openclaw/codex@2026.9.1',
      pluginResolvedVersion: '2026.9.1',
    }));

    expect(status.blockers.map((blocker) => blocker.code)).not.toContain('codex-plugin-mismatch');
    expect(status.codexPluginInstallSpec).toBe('@openclaw/codex@2026.9.1');
  });

  it('still rejects a Codex install that resolved to another version', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({
      pluginSpec: '@openclaw/codex',
      pluginResolvedSpec: '@openclaw/codex@2026.6.9-1',
      pluginResolvedVersion: '2026.6.9-1',
    }));

    expect(status.blockers.map((blocker) => blocker.code)).toContain('codex-plugin-mismatch');
  });

  it('serializes bounded checks without redundant discovery when RPC metadata is complete', async () => {
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
      'plugins inspect codex --json@25000',
      'models auth --agent main list --json@25000',
    ]);
  });

  it('gives the plugin and auth-store probes the discovery budget so a slow but healthy store is not reported unavailable', async () => {
    // Production measurement 2026-09-09: `models auth --agent main list` succeeded
    // in ~7s at rest, ~15s cold, and ~21s under CLI contention, and `plugins
    // inspect codex` measured ~7s. A 10s budget produced the false
    // `auth-store-unavailable` blocker on a healthy host. Keep both at the same
    // 25s bound as gateway discovery.
    const base = makeDependencies();
    const budgets = new Map<string, number | undefined>();
    const status = await getOpenClawSetupReadiness({
      ...base,
      runOpenClawCli: async (args, timeoutMs) => {
        budgets.set(args.join(' '), timeoutMs);
        return base.runOpenClawCli(args, timeoutMs);
      },
    });

    expect(status.credentialStoreReady).toBe(true);
    expect(status.blockers).not.toContainEqual(expect.objectContaining({ code: 'auth-store-unavailable' }));
    expect(budgets.get('models auth --agent main list --json')).toBe(25_000);
    expect(budgets.get('plugins inspect codex --json')).toBe(25_000);
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
    expect(cliCalls).toBe(4);
    expect(await getOpenClawSetupReadiness()).toBe(firstStatus);
    expect(cliCalls).toBe(4);

    const refreshed = await getOpenClawSetupReadiness(
      dependencies,
      { force: true, useSharedCache: true },
    );
    expect(refreshed.ready).toBe(true);
    expect(cliCalls).toBe(8);
  });

  it('serves a ready result while revalidating off the request path, and survives one contended probe', async () => {
    const started = Date.parse('2026-09-20T04:00:00.000Z');
    let now = started;
    const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    try {
      const healthy = makeDependencies();
      const busy = makeDependencies({ gatewayStatus: failed('gateway timeout after 10000ms') });
      let cliCalls = 0;
      let gatewayBusy = false;
      const dependencies: OpenClawSetupReadinessDependencies = {
        ...healthy,
        runOpenClawCli: async (args, timeoutMs) => {
          cliCalls += 1;
          return (gatewayBusy ? busy : healthy).runOpenClawCli(args, timeoutMs);
        },
      };
      const shared = { useSharedCache: true } as const;

      const first = await getOpenClawSetupReadiness(dependencies, shared);
      expect(first.ready).toBe(true);
      const collected = cliCalls;

      // Well past the old one-minute TTL: still served without a single spawn.
      now = started + __openClawSetupReadinessCacheTest.READINESS_REFRESH_AFTER_MS - 1;
      expect(await getOpenClawSetupReadiness(dependencies, shared)).toBe(first);
      expect(cliCalls).toBe(collected);

      // Stale: the caller still gets the ready result at once while one
      // background probe runs against a gateway that is merely busy.
      gatewayBusy = true;
      now = started + __openClawSetupReadinessCacheTest.READINESS_REFRESH_AFTER_MS;
      expect(await getOpenClawSetupReadiness(dependencies, shared)).toBe(first);
      await settle();
      await settle();
      expect(cliCalls).toBeGreaterThan(collected);
      const afterFirstFailure = cliCalls;
      expect(await getOpenClawSetupReadiness(dependencies, shared)).toBe(first);
      await settle();
      expect(cliCalls).toBe(afterFirstFailure);

      // A second consecutive failure after the retry interval displaces it.
      now += __openClawSetupReadinessCacheTest.READINESS_BACKGROUND_RETRY_MS;
      expect(await getOpenClawSetupReadiness(dependencies, shared)).toBe(first);
      await settle();
      await settle();
      const displaced = await getOpenClawSetupReadiness(dependencies, shared);
      expect(displaced.ready).toBe(false);
      expect(displaced.blockers.map(blocker => blocker.code)).toContain('gateway-rpc-unavailable');

      // Not-ready is short-lived: recovery is collected on the next request.
      gatewayBusy = false;
      now += __openClawSetupReadinessCacheTest.READINESS_NOT_READY_TTL_MS;
      expect((await getOpenClawSetupReadiness(dependencies, shared)).ready).toBe(true);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('gives a diagnostic surface the one-minute freshness it asks for', async () => {
    const started = Date.parse('2026-09-20T04:00:00.000Z');
    let now = started;
    const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const base = makeDependencies();
      let cliCalls = 0;
      const dependencies: OpenClawSetupReadinessDependencies = {
        ...base,
        runOpenClawCli: async (args, timeoutMs) => { cliCalls += 1; return base.runOpenClawCli(args, timeoutMs); },
      };
      await getOpenClawSetupReadiness(dependencies, { useSharedCache: true });
      const collected = cliCalls;

      now = started + 59_999;
      await getOpenClawSetupReadiness(dependencies, { useSharedCache: true, maxAgeMs: 60_000 });
      expect(cliCalls).toBe(collected);

      now = started + 60_000;
      // A chat request path is still served the long-lived result…
      await getOpenClawSetupReadiness(dependencies, { useSharedCache: true });
      expect(cliCalls).toBe(collected);
      // …while the maintenance page collects a current one.
      await getOpenClawSetupReadiness(dependencies, { useSharedCache: true, maxAgeMs: 60_000 });
      expect(cliCalls).toBeGreaterThan(collected);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('never lets a probe that began before an invalidation repopulate the cache', async () => {
    const base = makeDependencies();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let gated = true;
    let cliCalls = 0;
    const dependencies: OpenClawSetupReadinessDependencies = {
      ...base,
      runOpenClawCli: async (args, timeoutMs) => {
        cliCalls += 1;
        if (gated) await gate;
        return base.runOpenClawCli(args, timeoutMs);
      },
    };
    const shared = { useSharedCache: true } as const;

    const preBoundary = getOpenClawSetupReadiness(dependencies, shared);
    invalidateOpenClawSetupReadinessCache();
    gated = false;
    release();
    await preBoundary;
    const callsBefore = cliCalls;

    // The pre-boundary result was returned to its caller but not cached.
    await getOpenClawSetupReadiness(dependencies, shared);
    expect(cliCalls).toBeGreaterThan(callsBefore);
  });

  it('collects fresh for an attestation without giving up the contention debounce', async () => {
    const healthy = makeDependencies();
    const busy = makeDependencies({ gatewayStatus: failed('gateway timeout after 10000ms') });
    let gatewayBusy = false;
    let cliCalls = 0;
    const dependencies: OpenClawSetupReadinessDependencies = {
      ...healthy,
      runOpenClawCli: async (args, timeoutMs) => {
        cliCalls += 1;
        return (gatewayBusy ? busy : healthy).runOpenClawCli(args, timeoutMs);
      },
    };

    const first = await getOpenClawSetupReadiness(dependencies, { useSharedCache: true });
    const collected = cliCalls;
    gatewayBusy = true;
    const fresh = await getOpenClawSetupReadiness(dependencies, { useSharedCache: true, fresh: true });
    expect(cliCalls).toBeGreaterThan(collected);
    // The fresh caller sees the truth; cached readers keep the ready result.
    expect(fresh.ready).toBe(false);
    expect(await getOpenClawSetupReadiness(dependencies, { useSharedCache: true })).toBe(first);
  });

  it('counts a second failure only after the retry interval, whichever path collected it', async () => {
    const started = Date.parse('2026-09-20T04:00:00.000Z');
    let now = started;
    const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const healthy = makeDependencies();
      const busy = makeDependencies({ gatewayStatus: failed('gateway timeout after 10000ms') });
      let gatewayBusy = false;
      const dependencies: OpenClawSetupReadinessDependencies = {
        ...healthy,
        runOpenClawCli: async (args, timeoutMs) => (gatewayBusy ? busy : healthy).runOpenClawCli(args, timeoutMs),
      };
      const shared = { useSharedCache: true } as const;
      const first = await getOpenClawSetupReadiness(dependencies, shared);
      gatewayBusy = true;

      // Two fresh collections inside one burst of contention are one piece of
      // evidence, not two: the ready result survives both.
      expect((await getOpenClawSetupReadiness(dependencies, { ...shared, fresh: true })).ready).toBe(false);
      now += __openClawSetupReadinessCacheTest.READINESS_BACKGROUND_RETRY_MS - 1;
      expect((await getOpenClawSetupReadiness(dependencies, { ...shared, fresh: true })).ready).toBe(false);
      expect(await getOpenClawSetupReadiness(dependencies, shared)).toBe(first);

      // A failure after the interval is independent, and displaces it.
      now += 1;
      expect((await getOpenClawSetupReadiness(dependencies, { ...shared, fresh: true })).ready).toBe(false);
      expect((await getOpenClawSetupReadiness(dependencies, shared)).ready).toBe(false);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('publishes directly when a forced recheck joins a debounced collection', async () => {
    const healthy = makeDependencies();
    const busy = makeDependencies({ gatewayStatus: failed('gateway timeout after 10000ms') });
    let gatewayBusy = false;
    let release!: () => void;
    let gate: Promise<void> | null = null;
    const dependencies: OpenClawSetupReadinessDependencies = {
      ...healthy,
      runOpenClawCli: async (args, timeoutMs) => {
        if (gate) await gate;
        return (gatewayBusy ? busy : healthy).runOpenClawCli(args, timeoutMs);
      },
    };
    const shared = { useSharedCache: true } as const;
    await getOpenClawSetupReadiness(dependencies, shared);

    gatewayBusy = true;
    gate = new Promise<void>((resolve) => { release = resolve; });
    const debounced = getOpenClawSetupReadiness(dependencies, { ...shared, fresh: true });
    const forced = getOpenClawSetupReadiness(dependencies, { ...shared, force: true });
    release();
    expect((await forced).ready).toBe(false);
    expect(await debounced).toBe(await forced);
    // One probe ran, and the operator's recheck decided how it was published.
    expect((await getOpenClawSetupReadiness(dependencies, shared)).ready).toBe(false);
  });

  it('serves a not-ready result for twice its collection time, within fifteen seconds to a minute', () => {
    const ttl = __openClawSetupReadinessCacheTest.notReadySetupReadinessTtlMs;
    expect(ttl(0)).toBe(__openClawSetupReadinessCacheTest.READINESS_NOT_READY_TTL_MS);
    expect(ttl(Number.NaN)).toBe(15_000);
    expect(ttl(27_000)).toBe(54_000);
    expect(ttl(90_000)).toBe(__openClawSetupReadinessCacheTest.READINESS_NOT_READY_MAX_TTL_MS);
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

  it('does not disable a healthy gateway when unrelated discovery would time out', async () => {
    const base = makeDependencies();
    const run = jest.fn(async (args: string[], timeout?: number) => {
      if (args[1] === 'probe') throw new Error('slow discovery must not run');
      return base.runOpenClawCli(args, timeout);
    });
    const status = await getOpenClawSetupReadiness({ ...base, runOpenClawCli: run });
    expect(status.ready).toBe(true);
    expect(status.authenticatedRpc).toBe(true);
    expect(status.gatewayProbeError).toBeNull();
  });

  it.each([
    ok('not JSON'), ok('{}'), ok(JSON.stringify({ rpc: { ok: false }, gateway: { version: '2026.9.1' } })),
    failed('command timed out'),
  ])('does not treat exit status or discovery success as RPC proof', async (gatewayStatus) => {
    const status = await getOpenClawSetupReadiness(makeDependencies({ gatewayStatus }));
    expect(status.ready).toBe(false);
    expect(status.authenticatedRpc).toBe(false);
    expect(status.blockers).toContainEqual(expect.objectContaining({ code: 'gateway-rpc-unavailable' }));
    expect(status.blockers).not.toContainEqual(expect.objectContaining({ code: 'gateway-token-mismatch' }));
  });

  it('uses authenticated discovery only to fill missing version metadata', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({
      gatewayStatus: ok(JSON.stringify({ rpc: { ok: true, url: 'ws://127.0.0.1:18789' } })),
    }));
    expect(status.ready).toBe(true);
    expect(status.runningVersion).toBe('2026.9.1');
    const unavailable = await getOpenClawSetupReadiness(makeDependencies({
      gatewayStatus: ok(JSON.stringify({ rpc: { ok: true, url: 'ws://127.0.0.1:18789' } })), gatewayProbeOk: false,
    }));
    expect(unavailable.ready).toBe(false);
    expect(unavailable.blockers).toContainEqual(expect.objectContaining({ code: 'gateway-runtime-mismatch' }));
    expect(unavailable.blockers).not.toContainEqual(expect.objectContaining({ code: 'gateway-token-mismatch' }));
  });

  it.each(['ws://127.0.0.1:18790', 'wss://unrelated.example:18789', 'ws://127.0.0.1:18789/?untrusted=1'])('rejects discovery version from a different endpoint: %s', async (gatewayProbeUrl) => {
    const status = await getOpenClawSetupReadiness(makeDependencies({
      gatewayStatus: ok(JSON.stringify({ rpc: { ok: true, url: 'ws://127.0.0.1:18789' } })), gatewayProbeUrl,
    }));
    expect(status.ready).toBe(false);
    expect(status.authenticatedRpc).toBe(true);
    expect(status.blockers).toContainEqual(expect.objectContaining({ code: 'gateway-runtime-mismatch' }));
  });

  it('does not use discovery metadata without an authenticated endpoint binding', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({ gatewayStatus: ok(JSON.stringify({ rpc: { ok: true } })) }));
    expect(status.ready).toBe(false);
    expect(status.runningVersion).toBeNull();
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

  it('rejects an unqualified package suffix instead of treating it as the release family', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({
      corePackageVersion: '2026.9.1-1',
      cliVersion: '2026.9.1-1',
      gatewayRunningVersion: '2026.9.1-1',
    }));

    expect(status.ready).toBe(false);
    expect(status.testedPairReady).toBe(false);
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
