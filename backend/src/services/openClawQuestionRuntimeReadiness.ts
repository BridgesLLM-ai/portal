import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { readFileSync, realpathSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { buildOpenClawCliEnv, extractJsonFromCliOutput } from '../utils/openclawCli';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';
import {
  LEGACY_TESTED_OPENCLAW_CORE_PACKAGE_VERSION,
  LEGACY_TESTED_OPENCLAW_RUNTIME_VERSION,
  TESTED_OPENCLAW_RUNTIME_VERSION,
  QUALIFIED_OPENCLAW_NATIVE_PATCHES,
  type OpenClawSetupReadiness,
} from './openclawSetupReadiness';

const execFileAsync = promisify(execFile);

export type OpenClawQuestionAuthority = 'legacy-custom' | 'native';

export const RETAINED_LEGACY_BRIDGESLLM_ASK_USER_PLUGIN_VERSION = '3.3.0';
export const NATIVE_BRIDGESLLM_ASK_USER_PLUGIN_VERSION = '4.0.0';

const NATIVE_ASK_USER_GATEWAY_METHODS = new Set([
  'bridgesllm.ask_user.steer',
]);

const RETAINED_LEGACY_ASK_USER_GATEWAY_METHODS = new Set([
  'bridgesllm.ask_user.probe',
  'bridgesllm.ask_user.pending',
  'bridgesllm.ask_user.answer',
  'bridgesllm.ask_user.dismiss',
  'bridgesllm.ask_user.steer',
]);

function expectedGatewayMethodsForProfile(
  questionAuthority: OpenClawQuestionAuthority,
  expectedVersion: string,
): Set<string> | null {
  if (
    questionAuthority === 'native'
    && expectedVersion === NATIVE_BRIDGESLLM_ASK_USER_PLUGIN_VERSION
  ) return NATIVE_ASK_USER_GATEWAY_METHODS;
  return questionAuthority === 'legacy-custom'
    && expectedVersion === RETAINED_LEGACY_BRIDGESLLM_ASK_USER_PLUGIN_VERSION
    ? RETAINED_LEGACY_ASK_USER_GATEWAY_METHODS
    : null;
}

function gatewayMethodSetIsExact(methods: unknown[], expected: Set<string>): boolean {
  if (
    methods.length !== expected.size
    || !methods.every((method) => typeof method === 'string')
  ) return false;
  const actual = new Set(methods as string[]);
  return actual.size === expected.size
    && [...expected].every((method) => actual.has(method));
}

export function askUserRuntimeReportIsReady(params: {
  report: any;
  expectedVersion: string;
  expectedRoot: string;
  expectedSource: string;
  questionAuthority: OpenClawQuestionAuthority;
  resolveRealPath: (target: string) => string;
}): boolean {
  const {
    report,
    expectedVersion,
    expectedRoot,
    expectedSource,
    questionAuthority,
    resolveRealPath,
  } = params;
  const plugin = report?.plugin;
  const toolNames = plugin?.toolNames;
  const typedHooks = report?.typedHooks;
  const gatewayMethods = report?.gatewayMethods;
  const diagnostics = report?.diagnostics;
  const expectedGatewayMethods = expectedGatewayMethodsForProfile(
    questionAuthority,
    expectedVersion,
  );
  let pluginPathsReady = false;
  try {
    pluginPathsReady = typeof plugin?.rootDir === 'string'
      && typeof plugin?.source === 'string'
      && resolveRealPath(plugin.rootDir) === resolveRealPath(expectedRoot)
      && resolveRealPath(plugin.source) === resolveRealPath(expectedSource);
  } catch {
    pluginPathsReady = false;
  }
  return Boolean(
    expectedVersion
    && expectedGatewayMethods
    && plugin?.id === 'bridgesllm-ask-user'
    && plugin?.version === expectedVersion
    && plugin?.status === 'loaded'
    && plugin?.enabled === true
    && plugin?.activated === true
    && !plugin?.error
    && pluginPathsReady
    && Array.isArray(toolNames)
    && Array.isArray(typedHooks)
    && Array.isArray(gatewayMethods)
    && (questionAuthority === 'native'
      ? toolNames.length === 0
        && plugin?.hookCount === 0
        && typedHooks.length === 0
        && gatewayMethodSetIsExact(gatewayMethods, expectedGatewayMethods)
      : toolNames.length === 1
        && toolNames[0] === 'ask_user_question'
        && plugin?.hookCount === 1
        && typedHooks.length === 1
        && typedHooks[0]?.name === 'before_tool_call'
        && gatewayMethodSetIsExact(gatewayMethods, expectedGatewayMethods))
    && Array.isArray(diagnostics)
    && !diagnostics.some((item: any) => item?.level === 'error')
  );
}

export function questionAuthorityForOpenClawVersion(
  version: unknown,
): OpenClawQuestionAuthority | null {
  const normalized = typeof version === 'string' ? version.trim() : '';
  if (
    normalized === LEGACY_TESTED_OPENCLAW_RUNTIME_VERSION
    || normalized === LEGACY_TESTED_OPENCLAW_CORE_PACKAGE_VERSION
  ) return 'legacy-custom';
  if (normalized === TESTED_OPENCLAW_RUNTIME_VERSION || QUALIFIED_OPENCLAW_NATIVE_PATCHES.includes(normalized)) return 'native';
  return null;
}

export interface OpenClawQuestionPluginReadiness {
  ready: boolean;
  questionAuthority: OpenClawQuestionAuthority | null;
  expectedPluginVersion: string | null;
  issue: string | null;
}

export interface OpenClawQuestionPluginReadinessDependencies {
  runCli: (
    args: string[],
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }>;
  readBundledVersion: () => string;
  callGatewayRpc: (
    method: string,
    params: Record<string, any>,
    timeoutMs?: number,
  ) => Promise<{
    ok: boolean;
    data?: any;
    error?: any;
    errorCode?: string;
    errorMessage?: string;
  }>;
  resolveRealPath: (target: string) => string;
  stateRoot: string;
}

function strictJson(raw: string): any | null {
  try {
    return JSON.parse(extractJsonFromCliOutput(String(raw || '').trim()));
  } catch {
    return null;
  }
}

function nativeAskUserToolCatalogIsReady(result: any): boolean {
  if (!result?.ok || !Array.isArray(result.data?.groups)) return false;
  const tools = result.data.groups.flatMap((group: any) => (
    Array.isArray(group?.tools)
      ? group.tools.map((tool: any) => ({ ...tool, groupSource: group?.source }))
      : []
  ));
  const nativeAskUser = tools.filter((tool: any) => tool?.id === 'ask_user');
  return nativeAskUser.length === 1
    && nativeAskUser[0]?.source === 'core'
    && nativeAskUser[0]?.groupSource === 'core'
    && !tools.some((tool: any) => tool?.id === 'ask_user_question');
}

function gatewayNotFoundProbeIsValid(result: any, expectedId: string): boolean {
  const code = String(result?.errorCode || '').toLowerCase();
  const message = String(result?.errorMessage || result?.error || '').toLowerCase();
  return result?.ok === false
    && code === 'invalid_request'
    && message.includes(expectedId.toLowerCase())
    && message.includes('not found');
}

function failedSemanticReadiness(
  questionAuthority: OpenClawQuestionAuthority,
  expectedPluginVersion: string,
  label: string,
  result: any,
): OpenClawQuestionPluginReadiness {
  const detail = String(
    result?.errorMessage
    || result?.error
    || result?.stderr
    || 'unexpected response',
  ).trim();
  return {
    ready: false,
    questionAuthority,
    expectedPluginVersion,
    issue: `OpenClaw question-runtime semantic readiness failed at ${label}: ${detail}`,
  };
}

async function runOpenClawCli(
  args: string[],
  timeoutMs = 12_000,
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  try {
    const result = await execFileAsync('openclaw', args, {
      encoding: 'utf8',
      env: buildOpenClawCliEnv(),
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      ok: true,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim(),
    };
  } catch (error: any) {
    return {
      ok: false,
      stdout: String(error?.stdout || '').trim(),
      stderr: String(error?.stderr || error?.message || '').trim(),
      error: error?.message || String(error),
    };
  }
}

export async function getOpenClawQuestionPluginReadiness(
  readiness: OpenClawSetupReadiness,
  dependencyOverrides: Partial<OpenClawQuestionPluginReadinessDependencies> = {},
): Promise<OpenClawQuestionPluginReadiness> {
  const portalRoot = path.resolve(__dirname, '../../..');
  const dependencies: OpenClawQuestionPluginReadinessDependencies = {
    runCli: runOpenClawCli,
    readBundledVersion: () => {
      const bundledPackage = JSON.parse(readFileSync(
        path.join(portalRoot, 'installer/openclaw-ask-user-plugin/package.json'),
        'utf8',
      ));
      return typeof bundledPackage?.version === 'string' ? bundledPackage.version : '';
    },
    callGatewayRpc: gatewayRpcCall,
    resolveRealPath: (target) => realpathSync(target),
    stateRoot: process.env.OPENCLAW_STATE_DIR
      || path.join(process.env.HOME || '/root', '.openclaw'),
    ...dependencyOverrides,
  };

  const family = readiness.testedRuntimeFamily;
  const questionAuthority: OpenClawQuestionAuthority | null = family === 'legacy-2026.7.1'
    ? 'legacy-custom'
    : family === 'current-2026.9.1'
      ? 'native'
      : null;
  if (!questionAuthority) {
    return {
      ready: false,
      questionAuthority: null,
      expectedPluginVersion: null,
      issue: 'OpenClaw question authority has no exact tested runtime family.',
    };
  }

  let expectedPluginVersion = RETAINED_LEGACY_BRIDGESLLM_ASK_USER_PLUGIN_VERSION;
  if (questionAuthority === 'native') {
    let bundledVersion = '';
    try {
      bundledVersion = dependencies.readBundledVersion();
    } catch {
      // Handled by the exact version check below.
    }
    if (bundledVersion !== NATIVE_BRIDGESLLM_ASK_USER_PLUGIN_VERSION) {
      return {
        ready: false,
        questionAuthority,
        expectedPluginVersion: NATIVE_BRIDGESLLM_ASK_USER_PLUGIN_VERSION,
        issue: `Bundled OpenClaw runtime-guard plugin must be ${NATIVE_BRIDGESLLM_ASK_USER_PLUGIN_VERSION}; detected ${bundledVersion || 'unknown'}.`,
      };
    }
    expectedPluginVersion = NATIVE_BRIDGESLLM_ASK_USER_PLUGIN_VERSION;
  }

  const inspection = await dependencies.runCli(
    ['plugins', 'inspect', 'bridgesllm-ask-user', '--json', '--runtime'],
    12_000,
  );
  const report = inspection.ok ? strictJson(inspection.stdout) : null;
  const expectedRoot = path.join(
    dependencies.stateRoot,
    'extensions/bridgesllm-ask-user',
  );
  const metadataReady = inspection.ok && askUserRuntimeReportIsReady({
    report,
    expectedVersion: expectedPluginVersion,
    expectedRoot,
    expectedSource: path.join(expectedRoot, 'index.js'),
    questionAuthority,
    resolveRealPath: dependencies.resolveRealPath,
  });
  if (!metadataReady) {
    return {
      ready: false,
      questionAuthority,
      expectedPluginVersion,
      issue: questionAuthority === 'native'
        ? 'OpenClaw native-question runtimes must run the exact 4.0 steer-only plugin surface with no second question authority.'
        : 'Retained OpenClaw 2026.7.1 must run the exact 3.3 legacy question plugin surface.',
    };
  }

  const nonce = randomUUID();
  const questionId = `bridgesllm-native-question-readiness-${nonce}`;
  const sessionKey = `agent:main:bridgesllm-runtime-readiness-${nonce}`;
  const expectedRunId = `readiness-${nonce}`;
  const requestId = `readiness-request-${nonce}`;

  const steerProbe = await dependencies.callGatewayRpc('bridgesllm.ask_user.steer', {
    sessionKey,
    expectedRunId,
    requestId,
    text: 'BridgesLLM readiness probe.',
  }, 10_000);
  if (!(
    steerProbe.ok
    && steerProbe.data?.accepted === false
    && steerProbe.data?.code === 'NO_ACTIVE_RUN'
    && steerProbe.data?.requestId === requestId
  )) {
    return failedSemanticReadiness(
      questionAuthority,
      expectedPluginVersion,
      'exact-run steer',
      steerProbe,
    );
  }

  if (questionAuthority === 'legacy-custom') {
    const legacyProbe = await dependencies.callGatewayRpc('bridgesllm.ask_user.probe', {
      nonce,
    }, 10_000);
    if (!(
      legacyProbe.ok
      && legacyProbe.data?.ok === true
      && legacyProbe.data?.code === 'SEMANTIC_PROBE_OK'
      && legacyProbe.data?.toolName === 'ask_user_question'
      && legacyProbe.data?.answer === true
      && legacyProbe.data?.dismiss === true
      && legacyProbe.data?.steer === true
      && (
        expectedPluginVersion === RETAINED_LEGACY_BRIDGESLLM_ASK_USER_PLUGIN_VERSION
        || legacyProbe.data?.activeRunSteer === true
      )
    )) {
      return failedSemanticReadiness(
        questionAuthority,
        expectedPluginVersion,
        'legacy ask-user tool execution',
        legacyProbe,
      );
    }
    const legacyPending = await dependencies.callGatewayRpc('bridgesllm.ask_user.pending', {
      sessionKey,
      expectedRunId,
    }, 10_000);
    if (!(
      legacyPending.ok
      && legacyPending.data?.pending === false
      && legacyPending.data?.code === 'NO_ACTIVE_RUN'
    )) {
      return failedSemanticReadiness(
        questionAuthority,
        expectedPluginVersion,
        'legacy pending',
        legacyPending,
      );
    }
    for (const [method, label] of [
      ['bridgesllm.ask_user.answer', 'legacy answer'],
      ['bridgesllm.ask_user.dismiss', 'legacy dismiss'],
    ] as const) {
      const legacySettlement = await dependencies.callGatewayRpc(method, {
        sessionKey,
        expectedRunId,
        requestId,
        ...(method.endsWith('.answer') ? { text: 'BridgesLLM readiness probe.' } : {}),
      }, 10_000);
      if (!(
        legacySettlement.ok
        && legacySettlement.data?.accepted === false
        && legacySettlement.data?.code === 'NO_ACTIVE_RUN'
        && legacySettlement.data?.requestId === requestId
      )) {
        return failedSemanticReadiness(
          questionAuthority,
          expectedPluginVersion,
          label,
          legacySettlement,
        );
      }
    }
    return {
      ready: true,
      questionAuthority,
      expectedPluginVersion,
      issue: null,
    };
  }

  const toolCatalog = await dependencies.callGatewayRpc('tools.catalog', {
    agentId: 'main',
    includePlugins: true,
  }, 10_000);
  if (!nativeAskUserToolCatalogIsReady(toolCatalog)) {
    return failedSemanticReadiness(
      questionAuthority,
      expectedPluginVersion,
      'native ask_user tool catalog',
      toolCatalog,
    );
  }
  const questionList = await dependencies.callGatewayRpc('question.list', {}, 10_000);
  if (!(questionList.ok && Array.isArray(questionList.data?.questions))) {
    return failedSemanticReadiness(
      questionAuthority,
      expectedPluginVersion,
      'question.list',
      questionList,
    );
  }
  for (const [method, params, label] of [
    ['question.get', { id: questionId }, 'question.get'],
    [
      'question.resolve',
      { id: questionId, cancel: true, resolvedBy: 'bridgesllm-readiness' },
      'question.resolve',
    ],
  ] as const) {
    const probe = await dependencies.callGatewayRpc(method, params, 10_000);
    if (!gatewayNotFoundProbeIsValid(probe, questionId)) {
      return failedSemanticReadiness(
        questionAuthority,
        expectedPluginVersion,
        label,
        probe,
      );
    }
  }
  return {
    ready: true,
    questionAuthority,
    expectedPluginVersion,
    issue: null,
  };
}
