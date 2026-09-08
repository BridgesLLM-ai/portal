import path from 'path';

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
// The route imports validated process configuration at module load time.
// Load it only after the isolated test database URL exists.
const { __gatewayCompatibilityHotfixTest } = require('../routes/gateway') as typeof import('../routes/gateway');

const stateRoot = '/test/.openclaw';
const pluginRoot = path.join(stateRoot, 'extensions/bridgesllm-ask-user');
const pluginSource = path.join(pluginRoot, 'index.js');
const identityRealPath = (target: string) => path.resolve(target);
const requiredGatewayMethods = [
  'bridgesllm.ask_user.steer',
];
const legacyGatewayMethods = [
  'bridgesllm.ask_user.probe',
  'bridgesllm.ask_user.pending',
  'bridgesllm.ask_user.answer',
  'bridgesllm.ask_user.dismiss',
  ...requiredGatewayMethods,
];

function healthyRuntimeReport(overrides: Record<string, any> = {}): any {
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
    gatewayMethods: [...requiredGatewayMethods],
    diagnostics: [],
    ...reportOverrides,
  };
}

function healthyLegacyRuntimeReport(overrides: Record<string, any> = {}): any {
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
    gatewayMethods: [...legacyGatewayMethods],
    diagnostics: [],
    ...reportOverrides,
  };
}

function healthyGatewayProbe(scopes = ['operator.admin', 'operator.read', 'operator.questions']) {
  return {
    ok: true,
    primaryTargetId: 'local',
    targets: [{
      id: 'local',
      active: true,
      connect: { ok: true },
      auth: { role: 'operator', scopes },
    }],
  };
}

async function healthyGatewayRpc(method: string, params: Record<string, any>): Promise<any> {
  if (method === 'tools.catalog') {
    return {
      ok: true,
      data: {
        groups: [{
          id: 'interaction',
          source: 'core',
          tools: [{ id: 'ask_user', source: 'core' }],
        }],
      },
    };
  }
  if (method === 'question.list') {
    return { ok: true, data: { questions: [] } };
  }
  if (method === 'question.get' || method === 'question.resolve') {
    return {
      ok: false,
      errorCode: 'INVALID_REQUEST',
      errorMessage: `question '${params.id}' was not found`,
    };
  }
  if (method === 'bridgesllm.ask_user.steer') {
    return {
      ok: true,
      data: { accepted: false, code: 'NO_ACTIVE_RUN', requestId: params.requestId },
    };
  }
  return { ok: false, error: `unexpected method ${method}` };
}

async function healthyLegacyGatewayRpc(method: string, params: Record<string, any>): Promise<any> {
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
        activeRunSteer: true,
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
  return healthyGatewayRpc(method, params);
}

function runtimeDependencies(
  report: any = healthyRuntimeReport(),
  runtimeVersion = '2026.9.1',
) {
  const legacy = runtimeVersion.startsWith('2026.7.1');
  return {
    stateRoot,
    resolveRealPath: identityRealPath,
    readBundledVersion: () => '4.0.0',
    runCli: jest.fn(async (args: string[]) => ({
      ok: true,
      stdout: JSON.stringify(args[0] === 'plugins' ? report : healthyGatewayProbe()),
      stderr: '',
    })),
    callGatewayRpc: jest.fn(async (method: string, params: Record<string, any>) => (
      method === 'status'
        ? { ok: true, data: { runtimeVersion } }
        : legacy
          ? healthyLegacyGatewayRpc(method, params)
          : healthyGatewayRpc(method, params)
    )),
  };
}

describe('OpenClaw 2026.9.1 native-question runtime attestation', () => {
  const { askUserRuntimeReportIsReady, getOpenClawAskUserRuntimeReadiness } = __gatewayCompatibilityHotfixTest;

  it('accepts only the exact steer-only plugin surface', () => {
    const common = {
      expectedVersion: '4.0.0',
      expectedRoot: pluginRoot,
      expectedSource: pluginSource,
      questionAuthority: 'native' as const,
      resolveRealPath: identityRealPath,
    };
    expect(askUserRuntimeReportIsReady({
      ...common,
      report: healthyRuntimeReport({ diagnostics: [{ level: 'warn', message: 'harmless' }] }),
    })).toBe(true);
    expect(askUserRuntimeReportIsReady({
      ...common,
      report: healthyRuntimeReport({ plugin: { rootDir: '/tmp/shadow-plugin' } }),
    })).toBe(false);
    expect(askUserRuntimeReportIsReady({
      ...common,
      report: healthyRuntimeReport({
        plugin: { toolNames: ['ask_user_question'], hookCount: 1 },
        typedHooks: [{ name: 'before_tool_call' }],
      }),
    })).toBe(false);
    expect(askUserRuntimeReportIsReady({
      ...common,
      report: healthyRuntimeReport({
        gatewayMethods: [...requiredGatewayMethods, 'bridgesllm.ask_user.pending'],
      }),
    })).toBe(false);
    expect(askUserRuntimeReportIsReady({
      ...common,
      report: healthyRuntimeReport({ gatewayMethods: requiredGatewayMethods.slice(0, -1) }),
    })).toBe(false);
  });

  it('accepts only the exact installed 3.3 legacy surface for OpenClaw 2026.7.1', () => {
    const common = {
      expectedVersion: '3.3.0',
      expectedRoot: pluginRoot,
      expectedSource: pluginSource,
      questionAuthority: 'legacy-custom' as const,
      resolveRealPath: identityRealPath,
    };
    expect(askUserRuntimeReportIsReady({
      ...common,
      report: healthyLegacyRuntimeReport(),
    })).toBe(true);
    expect(askUserRuntimeReportIsReady({
      ...common,
      report: healthyRuntimeReport(),
    })).toBe(false);
    expect(askUserRuntimeReportIsReady({
      ...common,
      report: healthyLegacyRuntimeReport({
        gatewayMethods: legacyGatewayMethods.filter((method) => (
          method !== 'bridgesllm.ask_user.answer'
        )),
      }),
    })).toBe(false);
  });

  it('fails closed before RPC when runtime inspection fails', async () => {
    const dependencies = runtimeDependencies();
    dependencies.runCli.mockResolvedValueOnce({
      ok: false,
      stdout: '',
      stderr: 'plugin inspect failed',
    });

    await expect(getOpenClawAskUserRuntimeReadiness(dependencies as any)).resolves.toEqual(
      expect.objectContaining({ ready: false, pluginLoaded: false }),
    );
    expect(dependencies.runCli).toHaveBeenCalledTimes(1);
    expect(dependencies.callGatewayRpc).toHaveBeenCalledTimes(1);
    expect(dependencies.callGatewayRpc).toHaveBeenCalledWith(
      'status',
      { includeChannelSummary: false },
      10_000,
    );
  });

  it('requires operator.questions on the active Gateway authority', async () => {
    const dependencies = runtimeDependencies();
    dependencies.runCli.mockImplementation(async (args: string[]) => ({
      ok: true,
      stdout: JSON.stringify(args[0] === 'plugins'
        ? healthyRuntimeReport()
        : healthyGatewayProbe(['operator.admin', 'operator.read'])),
      stderr: '',
    }));

    const readiness = await getOpenClawAskUserRuntimeReadiness(dependencies as any);
    expect(readiness).toEqual(expect.objectContaining({
      ready: false,
      pluginLoaded: true,
      questionScopeReady: false,
    }));
  });

  it('fails closed on an unknown runtime family before inspecting either surface', async () => {
    const dependencies = runtimeDependencies(healthyRuntimeReport(), '2026.8.2');

    const readiness = await getOpenClawAskUserRuntimeReadiness(dependencies as any);

    expect(readiness).toEqual(expect.objectContaining({
      ready: false,
      pluginLoaded: false,
      questionAuthority: null,
      openClawVersion: '2026.8.2',
    }));
    expect(dependencies.runCli).not.toHaveBeenCalled();
    expect(dependencies.callGatewayRpc).toHaveBeenCalledTimes(1);
  });

  it('keeps a retained 7.1 + 3.3 legacy question authority fully usable', async () => {
    const dependencies = runtimeDependencies(
      healthyLegacyRuntimeReport(),
      '2026.7.1-2',
    );

    const readiness = await getOpenClawAskUserRuntimeReadiness(dependencies as any);

    expect(readiness).toEqual({
      ready: true,
      pluginLoaded: true,
      questionAuthority: 'legacy-custom',
      openClawVersion: '2026.7.1-2',
      legacyQuestionToolExecutionCallable: true,
      legacyPendingMethodCallable: true,
      legacyAnswerMethodCallable: true,
      legacyDismissMethodCallable: true,
      nativeAskUserToolCatalogReady: false,
      questionScopeReady: false,
      questionListCallable: false,
      questionGetCallable: false,
      questionResolveCallable: false,
      steerMethodCallable: true,
    });
    expect(dependencies.runCli).toHaveBeenCalledTimes(1);
    expect(dependencies.callGatewayRpc.mock.calls.map((call) => call[0]))
      .toEqual(expect.arrayContaining([
        'status',
        'bridgesllm.ask_user.probe',
        'bridgesllm.ask_user.pending',
        'bridgesllm.ask_user.answer',
        'bridgesllm.ask_user.dismiss',
        'bridgesllm.ask_user.steer',
      ]));
    expect(dependencies.callGatewayRpc.mock.calls.map((call) => call[0]))
      .not.toEqual(expect.arrayContaining([
        'tools.catalog',
        'question.list',
        'question.get',
        'question.resolve',
      ]));
  });

  it.each([
    'tools.catalog',
    'question.list',
    'question.get',
    'question.resolve',
    'bridgesllm.ask_user.steer',
  ])('requires live semantics from %s rather than inspect metadata', async (brokenMethod) => {
    const dependencies = runtimeDependencies();
    dependencies.callGatewayRpc.mockImplementation(async (method: string, params: any) => {
      if (method === brokenMethod) return { ok: false, error: 'method unavailable' };
      return healthyGatewayRpc(method, params);
    });

    const readiness = await getOpenClawAskUserRuntimeReadiness(dependencies as any);
    expect(readiness.ready).toBe(false);
  });

  it('rejects any legacy custom question tool in the native catalog proof', async () => {
    const dependencies = runtimeDependencies();
    dependencies.callGatewayRpc.mockImplementation(async (method: string, params: any) => {
      if (method !== 'tools.catalog') return healthyGatewayRpc(method, params);
      return {
        ok: true,
        data: {
          groups: [{
            source: 'core',
            tools: [
              { id: 'ask_user', source: 'core' },
              { id: 'ask_user_question', source: 'plugin' },
            ],
          }],
        },
      };
    });

    const readiness = await getOpenClawAskUserRuntimeReadiness(dependencies as any);
    expect(readiness).toEqual(expect.objectContaining({
      ready: false,
      nativeAskUserToolCatalogReady: false,
    }));
  });

  it('proves native questions and exact-run steer without creating visible state', async () => {
    const dependencies = runtimeDependencies();
    const readiness = await getOpenClawAskUserRuntimeReadiness(dependencies as any);

    expect(readiness).toEqual({
      ready: true,
      pluginLoaded: true,
      questionAuthority: 'native',
      openClawVersion: '2026.9.1',
      legacyQuestionToolExecutionCallable: false,
      legacyPendingMethodCallable: false,
      legacyAnswerMethodCallable: false,
      legacyDismissMethodCallable: false,
      nativeAskUserToolCatalogReady: true,
      questionScopeReady: true,
      questionListCallable: true,
      questionGetCallable: true,
      questionResolveCallable: true,
      steerMethodCallable: true,
    });
    expect(dependencies.runCli).toHaveBeenNthCalledWith(
      1,
      ['plugins', 'inspect', 'bridgesllm-ask-user', '--json', '--runtime'],
      12_000,
    );
    expect(dependencies.runCli).toHaveBeenNthCalledWith(
      2,
      ['gateway', 'probe', '--json', '--timeout', '3000'],
      12_000,
    );
    expect(dependencies.callGatewayRpc).toHaveBeenCalledWith(
      'tools.catalog',
      { agentId: 'main', includePlugins: false },
      10_000,
    );
    expect(dependencies.callGatewayRpc).toHaveBeenCalledWith('question.list', {}, 10_000);
    expect(dependencies.callGatewayRpc).toHaveBeenCalledWith(
      'question.get',
      { id: expect.stringContaining('bridgesllm-native-question-readiness-') },
      10_000,
    );
    expect(dependencies.callGatewayRpc).toHaveBeenCalledWith(
      'question.resolve',
      {
        id: expect.stringContaining('bridgesllm-native-question-readiness-'),
        cancel: true,
        resolvedBy: 'bridgesllm-readiness',
      },
      10_000,
    );
    expect(dependencies.callGatewayRpc.mock.calls.map((call) => call[0]))
      .not.toEqual(expect.arrayContaining([
        'bridgesllm.ask_user.probe',
        'bridgesllm.ask_user.pending',
        'bridgesllm.ask_user.answer',
        'bridgesllm.ask_user.dismiss',
        'bridgesllm.portal.cron.probe',
        'bridgesllm.portal.cron.updateOwnedIfIdle',
        'bridgesllm.portal.cron.disableIfIdle',
      ]));
  });
});
