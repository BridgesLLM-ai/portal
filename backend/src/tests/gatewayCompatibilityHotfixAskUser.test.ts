import path from 'path';

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
// The route imports validated process configuration at module load time.
// Load it only after the isolated test database URL exists.
const { __gatewayCompatibilityHotfixTest } = require('../routes/gateway') as typeof import('../routes/gateway');

const stateRoot = '/test/.openclaw';
const pluginRoot = path.join(stateRoot, 'extensions/bridgesllm-ask-user');
const pluginSource = path.join(pluginRoot, 'index.js');
const identityRealPath = (target: string) => path.resolve(target);

function healthyRuntimeReport(overrides: Record<string, any> = {}) {
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
    gatewayMethods: [
      'bridgesllm.ask_user.probe',
      'bridgesllm.ask_user.pending',
      'bridgesllm.ask_user.answer',
      'bridgesllm.ask_user.dismiss',
      'bridgesllm.ask_user.steer',
    ],
    diagnostics: [],
    ...reportOverrides,
  };
}

async function healthyGatewayRpc(method: string, params: Record<string, any>): Promise<any> {
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
      },
    };
  }
  if (method === 'bridgesllm.ask_user.pending') {
    return { ok: true, data: { pending: false, code: 'NO_ACTIVE_RUN' } };
  }
  return {
    ok: true,
    data: {
      accepted: false,
      code: 'NO_ACTIVE_RUN',
      requestId: params.requestId,
    },
  };
}

function runtimeDependencies(report = healthyRuntimeReport()) {
  return {
    stateRoot,
    resolveRealPath: identityRealPath,
    readBundledVersion: () => '3.3.0',
    runCli: jest.fn(async () => ({
      ok: true,
      stdout: JSON.stringify(report),
      stderr: '',
    })),
    callGatewayRpc: jest.fn(healthyGatewayRpc),
  };
}

describe('compatibility hotfix ask-user runtime attestation', () => {
  const { askUserRuntimeReportIsReady, getOpenClawAskUserRuntimeReadiness } = __gatewayCompatibilityHotfixTest;

  it('accepts the exact loaded plugin and harmless runtime warnings', () => {
    expect(askUserRuntimeReportIsReady({
      report: healthyRuntimeReport({ diagnostics: [{ level: 'warn', message: 'harmless' }] }),
      expectedVersion: '3.3.0',
      expectedRoot: pluginRoot,
      expectedSource: pluginSource,
      resolveRealPath: identityRealPath,
    })).toBe(true);
  });

  it('rejects a shadow plugin root and missing hook or gateway registration', () => {
    expect(askUserRuntimeReportIsReady({
      report: healthyRuntimeReport({ plugin: { rootDir: '/tmp/shadow-plugin' } }),
      expectedVersion: '3.3.0',
      expectedRoot: pluginRoot,
      expectedSource: pluginSource,
      resolveRealPath: identityRealPath,
    })).toBe(false);
    expect(askUserRuntimeReportIsReady({
      report: healthyRuntimeReport({ plugin: { source: '/tmp/shadow-plugin/index.js' } }),
      expectedVersion: '3.3.0',
      expectedRoot: pluginRoot,
      expectedSource: pluginSource,
      resolveRealPath: identityRealPath,
    })).toBe(false);
    expect(askUserRuntimeReportIsReady({
      report: healthyRuntimeReport({ typedHooks: [] }),
      expectedVersion: '3.3.0',
      expectedRoot: pluginRoot,
      expectedSource: pluginSource,
      resolveRealPath: identityRealPath,
    })).toBe(false);
    expect(askUserRuntimeReportIsReady({
      report: healthyRuntimeReport({ gatewayMethods: ['bridgesllm.ask_user.pending'] }),
      expectedVersion: '3.3.0',
      expectedRoot: pluginRoot,
      expectedSource: pluginSource,
      resolveRealPath: identityRealPath,
    })).toBe(false);
  });

  it('fails before RPC when runtime inspection fails', async () => {
    const dependencies = runtimeDependencies();
    dependencies.runCli.mockResolvedValueOnce({
      ok: false,
      stdout: '',
      stderr: 'plugin inspect failed',
    });
    const readiness = await getOpenClawAskUserRuntimeReadiness(dependencies as any);
    expect(readiness).toEqual(expect.objectContaining({
      ready: false,
      pluginLoaded: false,
      toolExecutionCallable: false,
      pendingMethodCallable: false,
    }));
    expect(dependencies.callGatewayRpc).not.toHaveBeenCalled();
  });

  it('rejects a plugin whose declared tool does not pass actual execute semantics', async () => {
    const dependencies = runtimeDependencies();
    dependencies.callGatewayRpc.mockImplementation(async (method: string, params: any) => {
      if (method === 'bridgesllm.ask_user.probe') {
        return {
          ok: true,
          data: { ok: false, code: 'SEMANTIC_PROBE_FAILED', toolName: 'ask_user_question' },
        };
      }
      return healthyGatewayRpc(method, params);
    });
    const readiness = await getOpenClawAskUserRuntimeReadiness(dependencies as any);
    expect(readiness).toEqual(expect.objectContaining({
      ready: false,
      pluginLoaded: true,
      toolExecutionCallable: false,
    }));
  });

  it.each([
    'bridgesllm.ask_user.pending',
    'bridgesllm.ask_user.answer',
    'bridgesllm.ask_user.dismiss',
    'bridgesllm.ask_user.steer',
  ])('requires live semantics from %s instead of trusting inspect metadata', async (brokenMethod) => {
    const dependencies = runtimeDependencies();
    dependencies.callGatewayRpc.mockImplementation(async (method: string, params: any) => {
      if (method === brokenMethod) return { ok: false, error: 'method unavailable' };
      return healthyGatewayRpc(method, params);
    });
    const readiness = await getOpenClawAskUserRuntimeReadiness(dependencies as any);
    expect(readiness.ready).toBe(false);
  });

  it('reports ready only after inspect and callable-method proofs both pass', async () => {
    const dependencies = runtimeDependencies();
    const readiness = await getOpenClawAskUserRuntimeReadiness(dependencies as any);
    expect(readiness).toEqual({
      ready: true,
      pluginLoaded: true,
      toolExecutionCallable: true,
      pendingMethodCallable: true,
      answerMethodCallable: true,
      dismissMethodCallable: true,
      steerMethodCallable: true,
    });
    expect(dependencies.callGatewayRpc).toHaveBeenCalledWith(
      'bridgesllm.ask_user.probe',
      expect.objectContaining({ nonce: expect.any(String) }),
      10_000,
    );
    expect(dependencies.callGatewayRpc).toHaveBeenCalledWith(
      'bridgesllm.ask_user.pending',
      expect.objectContaining({
        sessionKey: expect.stringContaining('agent:main:bridgesllm-ask-user-readiness-'),
      }),
      10_000,
    );
    for (const method of [
      'bridgesllm.ask_user.answer',
      'bridgesllm.ask_user.dismiss',
      'bridgesllm.ask_user.steer',
    ]) {
      expect(dependencies.callGatewayRpc).toHaveBeenCalledWith(
        method,
        expect.objectContaining({ requestId: expect.any(String) }),
        10_000,
      );
    }
  });
});
