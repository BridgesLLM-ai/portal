import path from 'path';
import {
  getOpenClawQuestionPluginReadiness,
  questionAuthorityForOpenClawVersion,
  type OpenClawQuestionPluginReadinessDependencies,
} from './openClawQuestionRuntimeReadiness';
import type { OpenClawSetupReadiness } from './openclawSetupReadiness';

const stateRoot = '/test/.openclaw';
const pluginRoot = path.join(stateRoot, 'extensions/bridgesllm-ask-user');
const pluginSource = path.join(pluginRoot, 'index.js');
const nativeMethods = [
  'bridgesllm.ask_user.steer',
];
const legacyMethods = [
  'bridgesllm.ask_user.probe',
  'bridgesllm.ask_user.pending',
  'bridgesllm.ask_user.answer',
  'bridgesllm.ask_user.dismiss',
  ...nativeMethods,
];
const retainedLegacyMethods = [
  'bridgesllm.ask_user.probe',
  'bridgesllm.ask_user.pending',
  'bridgesllm.ask_user.answer',
  'bridgesllm.ask_user.dismiss',
  'bridgesllm.ask_user.steer',
];

function setupReadiness(
  family: 'legacy-2026.7.1' | 'current-2026.9.1' | null,
): OpenClawSetupReadiness {
  const current = family === 'current-2026.9.1';
  const runtimeVersion = current ? '2026.9.1' : '2026.7.1';
  return {
    installed: true,
    version: runtimeVersion,
    corePackageVersion: current ? '2026.9.1' : '2026.7.1-2',
    runningVersion: runtimeVersion,
    gatewayRunning: true,
    authenticatedRpc: true,
    gatewayProbeOk: true,
    gatewayProbeError: null,
    gatewayUrl: 'http://127.0.0.1:18789',
    hasToken: true,
    tokenParity: true,
    codexPluginVersion: current ? '2026.9.1' : '2026.7.1-1',
    codexPluginInstallSpec: current
      ? '@openclaw/codex@2026.9.1'
      : '@openclaw/codex@2026.7.1-1',
    credentialStoreReady: true,
    credentialStoreWritable: true,
    testedCorePackageVersion: current ? '2026.9.1' : '2026.7.1-2',
    testedRuntimeVersion: runtimeVersion,
    testedCodexPluginVersion: current ? '2026.9.1' : '2026.7.1-1',
    testedRuntimeFamily: family,
    testedPairReady: family !== null,
    ready: family !== null,
    blockers: [],
    description: family ? 'ready' : 'unsupported runtime',
  };
}

function nativeReport(overrides: Record<string, any> = {}): any {
  const { plugin: pluginOverrides = {}, ...reportOverrides } = overrides;
  return {
    plugin: {
      id: 'bridgesllm-ask-user',
      version: '4.0.0',
      status: 'loaded',
      enabled: true,
      activated: true,
      rootDir: pluginRoot,
      source: pluginSource,
      toolNames: [],
      hookCount: 0,
      ...pluginOverrides,
    },
    typedHooks: [],
    gatewayMethods: [...nativeMethods],
    diagnostics: [],
    ...reportOverrides,
  };
}

function legacyReport(overrides: Record<string, any> = {}): any {
  const { plugin: pluginOverrides = {}, ...reportOverrides } = overrides;
  return {
    plugin: {
      id: 'bridgesllm-ask-user',
      version: '3.3.0',
      status: 'loaded',
      enabled: true,
      activated: true,
      rootDir: pluginRoot,
      source: pluginSource,
      toolNames: ['ask_user_question'],
      hookCount: 1,
      ...pluginOverrides,
    },
    typedHooks: [{ name: 'before_tool_call', priority: 100 }],
    gatewayMethods: [...legacyMethods],
    diagnostics: [],
    ...reportOverrides,
  };
}

function retainedLegacyReport(overrides: Record<string, any> = {}): any {
  return legacyReport({
    plugin: { version: '3.3.0' },
    gatewayMethods: [...retainedLegacyMethods],
    ...overrides,
  });
}

function dependencies(report: any): OpenClawQuestionPluginReadinessDependencies {
  return {
    runCli: jest.fn(async (args: string[]) => ({
      ok: true,
      stdout: JSON.stringify(args[0] === 'plugins' ? report : {
        ok: true,
        primaryTargetId: 'local',
        targets: [{
          id: 'local',
          active: true,
          connect: { ok: true },
          auth: { scopes: ['operator.read'] },
        }],
      }),
      stderr: '',
    })),
    readBundledVersion: () => '4.0.0',
    callGatewayRpc: jest.fn(async (method: string, params: Record<string, any>) => {
      if (method === 'bridgesllm.ask_user.steer') {
        return {
          ok: true,
          data: { accepted: false, code: 'NO_ACTIVE_RUN', requestId: params.requestId },
        };
      }
      if (method === 'bridgesllm.ask_user.probe') {
        return {
          ok: true,
          data: {
            ok: true,
            code: 'SEMANTIC_PROBE_OK',
            toolName: 'ask_user_question',
            answer: true,
            dismiss: true,
            steer: true,
            ...(report?.plugin?.version === '3.3.0' ? {} : { activeRunSteer: true }),
          },
        };
      }
      if (method === 'bridgesllm.ask_user.pending') {
        return { ok: true, data: { pending: false, code: 'NO_ACTIVE_RUN' } };
      }
      if (method === 'bridgesllm.ask_user.answer' || method === 'bridgesllm.ask_user.dismiss') {
        return {
          ok: true,
          data: { accepted: false, code: 'NO_ACTIVE_RUN', requestId: params.requestId },
        };
      }
      if (method === 'tools.catalog') {
        return {
          ok: true,
          data: {
            groups: [{
              source: 'core',
              tools: [{ id: 'ask_user', source: 'core' }],
            }],
          },
        };
      }
      if (method === 'question.list') return { ok: true, data: { questions: [] } };
      if (method === 'question.get' || method === 'question.resolve') {
        return {
          ok: false,
          errorCode: 'INVALID_REQUEST',
          errorMessage: `question '${params.id}' was not found`,
        };
      }
      return { ok: false, error: `unexpected method ${method}` };
    }),
    resolveRealPath: (target) => path.resolve(target),
    stateRoot,
  };
}

describe('OpenClaw exact question-runtime readiness', () => {
  it.each([
    {
      family: 'legacy-2026.7.1' as const,
      report: retainedLegacyReport(),
      authority: 'legacy-custom',
      pluginVersion: '3.3.0',
    },
    {
      family: 'current-2026.9.1' as const,
      report: nativeReport(),
      authority: 'native',
      pluginVersion: '4.0.0',
    },
  ])('accepts only the exact $family plugin surface', async ({
    family,
    report,
    authority,
    pluginVersion,
  }) => {
    await expect(getOpenClawQuestionPluginReadiness(
      setupReadiness(family),
      dependencies(report),
    )).resolves.toEqual({
      ready: true,
      questionAuthority: authority,
      expectedPluginVersion: pluginVersion,
      issue: null,
    });
  });

  it.each([
    { latency: 12_418, ready: true },
    { latency: 30_001, ready: false },
  ])('bounds native 10.6 cold catalog admission at $latency ms', async ({ latency, ready }) => {
    const deps = dependencies(nativeReport());
    const healthy = (deps.callGatewayRpc as jest.Mock).getMockImplementation()!;
    deps.callGatewayRpc = jest.fn(async (method, params, timeoutMs) => {
      if (method === 'tools.catalog' && latency > (timeoutMs || 0)) {
        return { ok: false, error: 'tools.catalog RPC timeout' };
      }
      return healthy(method, params, timeoutMs);
    });
    const setup = { ...setupReadiness('current-2026.9.1'),
      version: '2026.10.6', runningVersion: '2026.10.6', corePackageVersion: '2026.10.6' };
    const result = await getOpenClawQuestionPluginReadiness(setup, deps);
    expect(result.ready).toBe(ready);
    if (!ready) expect(result.issue).toContain('native ask_user tool catalog: tools.catalog RPC timeout');
  });

  it.each([
    {
      name: 'a killed inspect as a timeout',
      inspect: { ok: false, stdout: '', stderr: '', error: 'Command failed', timedOut: true },
      issue: /did not finish inspecting the runtime-guard plugin within 60 s/,
      timedOut: true,
    },
    {
      name: 'a failed inspect with its CLI error',
      inspect: { ok: false, stdout: '', stderr: 'plugin registry failed to load', error: 'Command failed' },
      issue: /^OpenClaw could not inspect the runtime-guard plugin: plugin registry failed to load$/,
      timedOut: undefined,
    },
  ])('reports $name, never as a plugin mismatch', async ({ inspect, issue, timedOut }) => {
    const deps = dependencies(nativeReport());
    const answer = deps.runCli;
    deps.runCli = jest.fn(async (args: string[], timeoutMs?: number) => (
      args[0] === 'plugins' ? inspect : answer(args, timeoutMs)
    ));

    const result = await getOpenClawQuestionPluginReadiness(setupReadiness('current-2026.9.1'), deps);

    expect(result.ready).toBe(false);
    expect(result.issue).toMatch(issue);
    expect(result.issue).not.toMatch(/steer-only/);
    expect(result.inspectTimedOut).toBe(timedOut);
  });

  it('keeps the retained 3.3 question surface exact and rejects retired cron methods on it', async () => {
    const result = await getOpenClawQuestionPluginReadiness(
      setupReadiness('legacy-2026.7.1'),
      dependencies(retainedLegacyReport({
        gatewayMethods: [...retainedLegacyMethods, 'bridgesllm.portal.cron.probe'],
      })),
    );
    expect(result).toMatchObject({
      ready: false,
      questionAuthority: 'legacy-custom',
      expectedPluginVersion: '3.3.0',
    });
  });

  it('admits retained 3.3 without inventing unavailable cron guards', async () => {
    const deps = dependencies(retainedLegacyReport());
    await expect(getOpenClawQuestionPluginReadiness(
      setupReadiness('legacy-2026.7.1'),
      deps,
    )).resolves.toMatchObject({ ready: true, expectedPluginVersion: '3.3.0' });
    const methods = (deps.callGatewayRpc as jest.Mock).mock.calls.map((call) => call[0]);
    expect(methods).toEqual(expect.arrayContaining([
      'bridgesllm.ask_user.probe',
      'bridgesllm.ask_user.pending',
      'bridgesllm.ask_user.answer',
      'bridgesllm.ask_user.dismiss',
      'bridgesllm.ask_user.steer',
    ]));
    expect(methods.some((method) => method.startsWith('bridgesllm.portal.cron.'))).toBe(false);
  });

  it('derives question authority from the legacy tuple or the floor family', () => {
    expect(questionAuthorityForOpenClawVersion('2026.7.1')).toBe('legacy-custom');
    expect(questionAuthorityForOpenClawVersion('2026.7.1-2')).toBe('legacy-custom');
    for (const version of ['2026.9.1', '2026.9.2', '2026.9.3', '2026.9.9', '2026.9.36', '2026.10.5', '2026.10.6', '2026.10.7', '2026.10.9', '2026.9.1-1']) {
      expect(questionAuthorityForOpenClawVersion(version)).toBe('native');
    }
    expect(questionAuthorityForOpenClawVersion('2026.7.1-3')).toBeNull();
    expect(questionAuthorityForOpenClawVersion('2026.8.30')).toBeNull();
    expect(questionAuthorityForOpenClawVersion('not-a-version')).toBeNull();
    expect(questionAuthorityForOpenClawVersion(undefined)).toBeNull();
  });

  it.each([
    'tools.catalog',
    'question.list',
    'question.get',
    'question.resolve',
  ])('fails native admission when %s is not semantically callable', async (brokenMethod) => {
    const deps = dependencies(nativeReport());
    const healthyGatewayRpc = deps.callGatewayRpc as jest.Mock;
    const healthyImplementation = healthyGatewayRpc.getMockImplementation()!;
    (deps.callGatewayRpc as jest.Mock).mockImplementation(async (
      method: string,
      params: Record<string, any>,
    ) => {
      if (method === brokenMethod) return { ok: false, error: 'method unavailable' };
      return healthyImplementation(method, params);
    });
    await expect(getOpenClawQuestionPluginReadiness(
      setupReadiness('current-2026.9.1'),
      deps,
    )).resolves.toMatchObject({
      ready: false,
      issue: expect.stringContaining(brokenMethod === 'tools.catalog'
        ? 'native ask_user tool catalog'
        : brokenMethod),
    });
  });

  it('rejects a second plugin-owned ask-user authority in the native tool catalog', async () => {
    const deps = dependencies(nativeReport());
    const healthyGatewayRpc = deps.callGatewayRpc as jest.Mock;
    const healthyImplementation = healthyGatewayRpc.getMockImplementation()!;
    healthyGatewayRpc.mockImplementation(async (method: string, params: Record<string, any>) => {
      if (method !== 'tools.catalog') return healthyImplementation(method, params);
      return {
        ok: true,
        data: {
          groups: [
            { source: 'core', tools: [{ id: 'ask_user', source: 'core' }] },
            { source: 'plugin', tools: [{ id: 'ask_user_question', source: 'plugin' }] },
          ],
        },
      };
    });

    await expect(getOpenClawQuestionPluginReadiness(
      setupReadiness('current-2026.9.1'),
      deps,
    )).resolves.toMatchObject({
      ready: false,
      issue: expect.stringContaining('native ask_user tool catalog'),
    });
    expect(healthyGatewayRpc).toHaveBeenCalledWith(
      'tools.catalog',
      { agentId: 'main', includePlugins: true },
      30_000,
    );
  });

  it('accepts native semantics without inventing operator.questions on the CLI probe', async () => {
    const deps = dependencies(nativeReport());

    await expect(getOpenClawQuestionPluginReadiness(
      setupReadiness('current-2026.9.1'),
      deps,
    )).resolves.toMatchObject({ ready: true, questionAuthority: 'native' });
    expect(deps.runCli).toHaveBeenCalledTimes(1);
    expect(deps.runCli).toHaveBeenCalledWith(
      ['plugins', 'inspect', 'bridgesllm-ask-user', '--json', '--runtime'],
      60_000,
    );
    expect(deps.callGatewayRpc).toHaveBeenCalledWith('question.list', {}, 10_000);
    expect(deps.callGatewayRpc).toHaveBeenCalledWith(
      'question.get',
      { id: expect.stringContaining('bridgesllm-native-question-readiness-') },
      10_000,
    );
    expect(deps.callGatewayRpc).toHaveBeenCalledWith(
      'question.resolve',
      expect.objectContaining({
        id: expect.stringContaining('bridgesllm-native-question-readiness-'),
      }),
      10_000,
    );
  });

  it.each([
    {
      family: 'legacy-2026.7.1' as const,
      report: nativeReport(),
      authority: 'legacy-custom',
      expectedVersion: '3.3.0',
    },
    {
      family: 'current-2026.9.1' as const,
      report: legacyReport(),
      authority: 'native',
      expectedVersion: '4.0.0',
    },
  ])('rejects a cross-family plugin surface on $family', async ({
    family,
    report,
    authority,
    expectedVersion,
  }) => {
    const result = await getOpenClawQuestionPluginReadiness(
      setupReadiness(family),
      dependencies(report),
    );
    expect(result).toMatchObject({
      ready: false,
      questionAuthority: authority,
      expectedPluginVersion: expectedVersion,
      issue: expect.any(String),
    });
  });

  it('never lets duplicate or additive methods stand in for the missing steer method', async () => {
    const report = nativeReport({
      gatewayMethods: ['bridgesllm.ask_user.steerStatus', 'bridgesllm.ask_user.steerStatus'],
    });
    await expect(getOpenClawQuestionPluginReadiness(
      setupReadiness('current-2026.9.1'),
      dependencies(report),
    )).resolves.toMatchObject({ ready: false });
  });

  it.each([
    ['an additive read-only method', { gatewayMethods: [...nativeMethods, 'bridgesllm.ask_user.steerStatus'] }],
    ['a duplicate listing of steer', { gatewayMethods: [...nativeMethods, ...nativeMethods] }],
    ['a tool that is not a question authority', { plugin: { toolNames: ['bridgesllm_runtime_status'] } }],
    ['a typed hook that cannot intercept tool calls', { typedHooks: [{ name: 'session_start' }], plugin: { hookCount: 1 } }],
  ])('stays ready when the plugin surface grows %s', async (_label, overrides) => {
    await expect(getOpenClawQuestionPluginReadiness(
      setupReadiness('current-2026.9.1'),
      dependencies(nativeReport(overrides)),
    )).resolves.toMatchObject({ ready: true, issue: null });
  });

  it.each([
    ['a second question method', { gatewayMethods: [...nativeMethods, 'bridgesllm.ask_user.answer'] }],
    ['a native question method', { gatewayMethods: [...nativeMethods, 'question.resolve'] }],
    ['an execution-capable method', { gatewayMethods: [...nativeMethods, 'chat.send'] }],
    ['a question tool', { plugin: { toolNames: ['ask_user_question'] } }],
    ['a tool-call interceptor', { typedHooks: [{ name: 'before_tool_call' }], plugin: { hookCount: 1 } }],
    ['a non-string method', { gatewayMethods: [...nativeMethods, 42] }],
  ])('refuses a native plugin surface with %s', async (_label, overrides) => {
    await expect(getOpenClawQuestionPluginReadiness(
      setupReadiness('current-2026.9.1'),
      dependencies(nativeReport(overrides)),
    )).resolves.toMatchObject({ ready: false, issue: expect.stringMatching(/no second question authority/) });
  });

  it('fails closed for unknown runtime families and an invalid native bundle', async () => {
    const unknownDependencies = dependencies(nativeReport());
    const unknown = await getOpenClawQuestionPluginReadiness(
      setupReadiness(null),
      unknownDependencies,
    );
    expect(unknown).toMatchObject({
      ready: false,
      questionAuthority: null,
      expectedPluginVersion: null,
    });
    expect(unknownDependencies.runCli).not.toHaveBeenCalled();

    const invalidBundleDependencies = {
      ...dependencies(nativeReport()),
      readBundledVersion: () => '3.4.0',
    };
    const invalidBundle = await getOpenClawQuestionPluginReadiness(
      setupReadiness('current-2026.9.1'),
      invalidBundleDependencies,
    );
    expect(invalidBundle).toMatchObject({
      ready: false,
      questionAuthority: 'native',
      expectedPluginVersion: '4.0.0',
      issue: expect.stringMatching(/must be 4\.0\.0/i),
    });
    expect(invalidBundleDependencies.runCli).not.toHaveBeenCalled();
  });
});
