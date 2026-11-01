import {
  __openClawSetupReadinessTest,
  getOpenClawSetupReadiness,
  __openClawSetupReadinessCacheTest,
  invalidateOpenClawSetupReadinessCache,
  isOpenClawCliTimeout,
  OPENCLAW_PLUGIN_INSPECT_TIMEOUT_MS,
  type OpenClawSetupReadinessDependencies,
} from '../services/openclawSetupReadiness';

import { capabilitiesFromHello } from '../services/openClawCompatibility';
import { OPENCLAW_REQUIRED_GATEWAY_EVENTS, OPENCLAW_REQUIRED_GATEWAY_METHODS } from '../services/openClawRuntimeContract';

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
  pluginInspect?: CliResponse & { timedOut?: boolean };
  authStore?: CliResponse;
  gatewayToken?: string | null;
  credentialStoreWritable?: boolean;
  /** Hello of the backend's own Gateway connection; `null` means the connect failed. */
  hello?: Record<string, any> | null;
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
        if (options.pluginInspect) return options.pluginInspect;
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
    // Gateway `plugins.inspect {pluginId:'codex'}`: same install record as the CLI
    // report, with `source.spec` = resolvedSpec ?? spec.
    inspectCodexPluginRpc: async () => {
      if (options.pluginInspect) {
        if (!options.pluginInspect.ok) {
          return { ok: false, error: options.pluginInspect.stderr, ...(options.pluginInspect.timedOut ? { timedOut: true } : {}) };
        }
        const report = JSON.parse(options.pluginInspect.stdout);
        return { ok: true, data: { ok: true, plugin: { id: 'codex', name: 'Codex', version: report.plugin?.version, installed: true, enabled: true }, source: { kind: report.install?.source, spec: report.install?.resolvedSpec ?? report.install?.spec } } };
      }
      return {
        ok: true,
        data: {
          ok: true,
          plugin: { id: 'codex', name: 'Codex', version: pluginVersion, installed: true, enabled: true },
          source: {
            kind: pluginSource,
            spec: options.pluginResolvedSpec ?? pluginSpec,
            packageName: '@openclaw/codex',
            integrity: 'sha512-fixture',
            integrityKind: 'ssri',
          },
        },
      };
    },
    readGatewayHello: async () => (options.hello === null
      ? { ok: false as const, error: 'connect failed' }
      : { ok: true as const, capabilities: capabilitiesFromHello(options.hello ?? gatewayHello(gatewayRunningVersion)) }),
  };
}

/** A stock Gateway hello: protocol 4 and the methods/events the Portal uses. */
function gatewayHello(version: string, overrides: Record<string, any> = {}): Record<string, any> {
  return {
    type: 'hello-ok',
    protocol: 4,
    server: { version, connId: 'conn-1' },
    features: {
      methods: [...OPENCLAW_REQUIRED_GATEWAY_METHODS, 'sessions.goal.update', 'sessions.goal.clear', 'progressCard.get', 'canvas.document.view'],
      events: [...OPENCLAW_REQUIRED_GATEWAY_EVENTS, 'session.message', 'session.tool'],
    },
    ...overrides,
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
    // At or above the floor, an unlisted release is admitted by capability.
    ['2026.9.4', '2026.9.4', true],
    ['2026.9.36', '2026.9.36', true],
    ['2026.10.9', '2026.10.9', true],
    ['2026.10.9', '2026.10.6', false],
    ['2027.1.1', '2027.1.1', true],
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
    // The Codex plugin is inspected over the Gateway RPC, not a cold CLI process.
    expect(commands).toEqual([
      '--version@4000',
      'gateway status --require-rpc --timeout 10000 --json@15000',
      'models auth --agent main list --json@25000',
    ]);
  });

  it('gives the plugin and auth-store probes the discovery budget so a slow but healthy store is not reported unavailable', async () => {
    // Production measurement 2026-09-09: `models auth --agent main list` succeeded
    // in ~7s at rest, ~15s cold, and ~21s under CLI contention, and `plugins
    // inspect codex` measured ~7s. A 10s budget produced the false
    // `auth-store-unavailable` blocker on a healthy host. The auth store keeps
    // the 25s discovery bound; the plugin inspect has its own registry budget.
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
    // The CLI registry load (20-60 s cold) is gone from the current family's chain.
    expect(budgets.has('plugins inspect codex --json')).toBe(false);
    expect(OPENCLAW_PLUGIN_INSPECT_TIMEOUT_MS).toBe(60_000);
  });

  it('inspects the Codex plugin over plugins.inspect for the current family and the CLI for retained 2026.7.1', async () => {
    const current = makeDependencies();
    const currentRpc = jest.fn(current.inspectCodexPluginRpc);
    const currentCli = jest.fn(current.runOpenClawCli);
    expect((await getOpenClawSetupReadiness({ ...current, runOpenClawCli: currentCli, inspectCodexPluginRpc: currentRpc })).ready).toBe(true);
    expect(currentRpc).toHaveBeenCalledTimes(1);
    expect(currentCli.mock.calls.map(([args]) => args.join(' '))).not.toContain('plugins inspect codex --json');

    const legacy = makeDependencies({
      corePackageVersion: '2026.7.1-2', cliVersion: '2026.7.1', gatewayRunningVersion: '2026.7.1',
      pluginVersion: '2026.7.1-1', pluginSpec: '@openclaw/codex@2026.7.1-1', pluginRecordedVersion: '2026.7.1-1',
    });
    const legacyRpc = jest.fn(legacy.inspectCodexPluginRpc);
    const legacyCli = jest.fn(legacy.runOpenClawCli);
    expect((await getOpenClawSetupReadiness({ ...legacy, runOpenClawCli: legacyCli, inspectCodexPluginRpc: legacyRpc })).ready).toBe(true);
    expect(legacyRpc).not.toHaveBeenCalled();
    expect(legacyCli.mock.calls.map(([args]) => args.join(' '))).toContain('plugins inspect codex --json');
  });

  it.each([
    ['an uninstalled record', { plugin: { id: 'codex', name: 'Codex', version: '2026.9.1', installed: false, enabled: false } }],
    ['a non-npm source', { source: { kind: 'path', spec: '/tmp/codex' } }],
    ['an unversioned spec', { source: { kind: 'npm', spec: '@openclaw/codex' } }],
    ['another package', { source: { kind: 'npm', spec: '@evil/codex@2026.9.1' } }],
  ])('refuses %s from plugins.inspect', async (_label, override) => {
    const base = makeDependencies();
    const healthy = await base.inspectCodexPluginRpc();
    const status = await getOpenClawSetupReadiness({
      ...base,
      inspectCodexPluginRpc: async () => ({ ...healthy, data: { ...healthy.data, ...override } }),
    });
    expect(status.ready).toBe(false);
    expect(status.blockers).toContainEqual(expect.objectContaining({ code: 'codex-plugin-mismatch' }));
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
    // --version, gateway status, models auth: the Codex plugin is an RPC now.
    expect(cliCalls).toBe(3);
    expect(await getOpenClawSetupReadiness()).toBe(firstStatus);
    expect(cliCalls).toBe(3);

    const refreshed = await getOpenClawSetupReadiness(
      dependencies,
      { force: true, useSharedCache: true },
    );
    expect(refreshed.ready).toBe(true);
    expect(cliCalls).toBe(6);
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

  it('admits a package republish above the floor only with its own lockstep Codex plugin', async () => {
    const republish = { corePackageVersion: '2026.10.9-1', cliVersion: '2026.10.9-1', gatewayRunningVersion: '2026.10.9-1' };
    const stalePlugin = await getOpenClawSetupReadiness(makeDependencies({ ...republish, pluginVersion: '2026.10.6', pluginSpec: '@openclaw/codex@2026.10.6', pluginRecordedVersion: '2026.10.6' }));
    expect(stalePlugin.ready).toBe(false);
    expect(stalePlugin.blockers).toContainEqual(expect.objectContaining({ code: 'codex-plugin-mismatch' }));
    expect(stalePlugin.blockers).not.toContainEqual(expect.objectContaining({ code: 'core-package-mismatch' }));

    for (const plugin of ['2026.10.9-1', '2026.10.9']) {
      const status = await getOpenClawSetupReadiness(makeDependencies({ ...republish, pluginVersion: plugin, pluginSpec: `@openclaw/codex@${plugin}`, pluginRecordedVersion: plugin }));
      expect(status.ready).toBe(true);
      expect(status.testedRuntimeFamily).toBe('current-2026.9.1');
    }
  });

  it.each(['2026.8.30', '2026.9.0', '2026.6.9', 'nightly'])('refuses core %s below the floor with the floor in the reason', async (core) => {
    const status = await getOpenClawSetupReadiness(makeDependencies({
      corePackageVersion: core, cliVersion: core, gatewayRunningVersion: core,
      pluginVersion: core, pluginSpec: `@openclaw/codex@${core}`, pluginRecordedVersion: core,
    }));
    expect(status.ready).toBe(false);
    expect(status.testedRuntimeFamily).toBeNull();
    expect(status.runtimeFloor).toBe('2026.9.1');
    expect(status.blockers.find((blocker) => blocker.code === 'core-package-mismatch')?.message)
      .toMatch(/2026\.9\.1 or newer/);
  });

  it('admits OpenClaw 10.9 with a stock hello and reports the installed release', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({
      corePackageVersion: '2026.10.9', cliVersion: '2026.10.9', gatewayRunningVersion: '2026.10.9',
      pluginVersion: '2026.10.9', pluginSpec: '@openclaw/codex@2026.10.9', pluginRecordedVersion: '2026.10.9',
      // A newer Gateway lists more methods and events than the Portal needs.
      hello: gatewayHello('2026.10.9', {
        features: {
          methods: [...OPENCLAW_REQUIRED_GATEWAY_METHODS, 'sessions.reactions.list', 'sessions.processes.list'],
          events: [...OPENCLAW_REQUIRED_GATEWAY_EVENTS, 'session.reaction'],
          capabilities: ['chat-send-routing-contract'],
        },
      }),
    }));
    expect(status).toMatchObject({
      ready: true,
      testedPairReady: true,
      testedRuntimeFamily: 'current-2026.9.1',
      testedCorePackageVersion: '2026.10.9',
      testedRuntimeVersion: '2026.10.9',
      testedCodexPluginVersion: '2026.10.9',
      blockers: [],
    });
  });

  it.each([
    ['a required method', { features: { methods: OPENCLAW_REQUIRED_GATEWAY_METHODS.filter((method) => method !== 'chat.send'), events: [...OPENCLAW_REQUIRED_GATEWAY_EVENTS] } }, /missing methods chat\.send/],
    ['a required event', { features: { methods: [...OPENCLAW_REQUIRED_GATEWAY_METHODS], events: ['chat', 'agent'] } }, /missing events sessions\.changed/],
    ['a supported protocol', { protocol: 5 }, /protocol 5 is outside 3-4/],
  ])('refuses a current Gateway whose hello lacks %s', async (_label, overrides, reason) => {
    const status = await getOpenClawSetupReadiness(makeDependencies({ hello: gatewayHello('2026.9.1', overrides) }));
    expect(status.ready).toBe(false);
    expect(status.testedPairReady).toBe(false);
    expect(status.blockers.find((blocker) => blocker.code === 'gateway-contract-mismatch')?.message).toMatch(reason);
  });

  it('fails closed when the backend cannot read the Gateway hello, without blaming the version', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({ hello: null }));
    expect(status.ready).toBe(false);
    const codes = status.blockers.map((blocker) => blocker.code);
    expect(codes).toContain('gateway-contract-unverified');
    expect(codes).not.toContain('core-package-mismatch');
    expect(codes).not.toContain('gateway-runtime-mismatch');
  });

  it('refuses when the backend reaches a Gateway running another release than the CLI reported', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({ hello: gatewayHello('2026.10.6') }));
    expect(status.ready).toBe(false);
    expect(status.blockers.find((blocker) => blocker.code === 'gateway-runtime-mismatch')?.message).toMatch(/detected 2026\.10\.6 for core 2026\.9\.1/);
  });

  it('does not ask the legacy tuple for a hello and keeps it exact', async () => {
    const readGatewayHello = jest.fn(async () => ({ ok: false as const, error: 'unused' }));
    const status = await getOpenClawSetupReadiness({
      ...makeDependencies({
        corePackageVersion: '2026.7.1-2', cliVersion: '2026.7.1', gatewayRunningVersion: '2026.7.1',
        pluginVersion: '2026.7.1-1', pluginSpec: '@openclaw/codex@2026.7.1-1', pluginRecordedVersion: '2026.7.1-1',
      }),
      readGatewayHello,
    });
    expect(status.ready).toBe(true);
    expect(readGatewayHello).not.toHaveBeenCalled();
  });

  it('restores exact tested releases with PORTAL_OPENCLAW_STRICT_TUPLES=1', async () => {
    const previous = process.env.PORTAL_OPENCLAW_STRICT_TUPLES;
    process.env.PORTAL_OPENCLAW_STRICT_TUPLES = '1';
    try {
      const status = await getOpenClawSetupReadiness(makeDependencies({
        corePackageVersion: '2026.10.9', cliVersion: '2026.10.9', gatewayRunningVersion: '2026.10.9',
        pluginVersion: '2026.10.9', pluginSpec: '@openclaw/codex@2026.10.9', pluginRecordedVersion: '2026.10.9',
      }));
      expect(status.ready).toBe(false);
      expect(status.blockers.find((blocker) => blocker.code === 'core-package-mismatch')?.message).toMatch(/Strict tested-release mode/);
      expect((await getOpenClawSetupReadiness(makeDependencies())).ready).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PORTAL_OPENCLAW_STRICT_TUPLES;
      else process.env.PORTAL_OPENCLAW_STRICT_TUPLES = previous;
    }
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

  it('reports a killed Codex plugin inspect as a timeout, not a version mismatch', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({
      pluginInspect: { ok: false, stdout: '', stderr: 'Command failed', timedOut: true },
    }));

    expect(status.ready).toBe(false);
    expect(status.testedPairReady).toBe(false);
    const codes = status.blockers.map((blocker) => blocker.code);
    expect(codes).toContain('codex-plugin-inspect-timeout');
    expect(codes).not.toContain('codex-plugin-mismatch');
    expect(status.blockers.find((blocker) => blocker.code === 'codex-plugin-inspect-timeout')?.message)
      .toMatch(/did not finish inspecting the Codex plugin within 30 s/);
  });

  it('surfaces a failed Codex plugin inspect error instead of inventing a detected version', async () => {
    const status = await getOpenClawSetupReadiness(makeDependencies({
      pluginInspect: failed('plugin registry failed to load'),
    }));

    expect(status.ready).toBe(false);
    expect(status.blockers).toContainEqual({
      code: 'codex-plugin-mismatch',
      message: 'OpenClaw could not inspect the Codex plugin (expected @openclaw/codex@2026.9.1): plugin registry failed to load',
    });
  });

  it('classifies only an execFile timeout kill as a CLI timeout', () => {
    expect(isOpenClawCliTimeout({ killed: true, signal: 'SIGTERM' })).toBe(true);
    expect(isOpenClawCliTimeout({ killed: false, code: 1 })).toBe(false);
    expect(isOpenClawCliTimeout({
      killed: true,
      signal: 'SIGTERM',
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    })).toBe(false);
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
