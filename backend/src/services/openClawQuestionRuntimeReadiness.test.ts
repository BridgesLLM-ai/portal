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

  it('accepts only exact tested runtime identities for question authority', () => {
    expect(questionAuthorityForOpenClawVersion('2026.7.1')).toBe('legacy-custom');
    expect(questionAuthorityForOpenClawVersion('2026.7.1-2')).toBe('legacy-custom');
    expect(questionAuthorityForOpenClawVersion('2026.9.1')).toBe('native');
    expect(questionAuthorityForOpenClawVersion('2026.9.2')).toBe('native');
    expect(questionAuthorityForOpenClawVersion('2026.9.3')).toBeNull();
    expect(questionAuthorityForOpenClawVersion('2026.7.1-3')).toBeNull();
    expect(questionAuthorityForOpenClawVersion('2026.9.1-1')).toBeNull();
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
      10_000,
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
      12_000,
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

  it('rejects duplicate gateway methods that conceal a missing exact method', async () => {
    const report = nativeReport({
      gatewayMethods: [
        nativeMethods[0],
        nativeMethods[0],
      ],
    });
    await expect(getOpenClawQuestionPluginReadiness(
      setupReadiness('current-2026.9.1'),
      dependencies(report),
    )).resolves.toMatchObject({ ready: false });
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
