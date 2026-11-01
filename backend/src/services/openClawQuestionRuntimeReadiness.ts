import { openClawDiagnosticCommand } from '../utils/openclawDiagnosticLease';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { readFileSync, realpathSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { buildOpenClawCliEnv, extractJsonFromCliOutput } from '../utils/openclawCli';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';
import {
  OPENCLAW_PLUGIN_INSPECT_TIMEOUT_MS,
  isOpenClawCliTimeout,
  type OpenClawSetupReadiness,
} from './openclawSetupReadiness';
import { isOpenClawExecutionCapableGatewayMethod } from './openClawExecutionCapableMethods';
import { openClawRuntimeFamilyForVersion } from './openClawRuntimeContract';

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

/**
 * The native plugin must provide its steer method and must not grow a second
 * question authority or another execution-capable surface. Additive read-only
 * methods (a status read, say) are not a reason to refuse every chat.
 */
const SECOND_QUESTION_AUTHORITY_METHODS: ReadonlySet<string> = new Set([
  'bridgesllm.ask_user.probe',
  'bridgesllm.ask_user.pending',
  'bridgesllm.ask_user.answer',
  'bridgesllm.ask_user.dismiss',
]);

function deniedNativeGatewayMethod(method: string, expected: Set<string>): boolean {
  if (expected.has(method)) return false;
  return method.startsWith('question.')
    || SECOND_QUESTION_AUTHORITY_METHODS.has(method)
    || isOpenClawExecutionCapableGatewayMethod(method);
}

function nativeGatewayMethodsAreSafeSuperset(methods: unknown[], expected: Set<string>): boolean {
  if (!methods.every((method) => typeof method === 'string')) return false;
  const actual = new Set(methods as string[]);
  return [...expected].every((method) => actual.has(method))
    && ![...actual].some((method) => deniedNativeGatewayMethod(method, expected));
}

/** Tools that would make the plugin a second question authority beside native `ask_user`. */
function nativeToolNamesAreSafe(toolNames: unknown[]): boolean {
  return toolNames.every((name) => typeof name === 'string'
    && !/^ask_user/i.test(name)
    && !/question/i.test(name));
}

/** A tool-call interceptor is how the retained legacy plugin took over questions. */
function nativeTypedHooksAreSafe(typedHooks: unknown[]): boolean {
  return typedHooks.every((hook: any) => typeof hook?.name === 'string' && hook.name !== 'before_tool_call');
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
      ? nativeToolNamesAreSafe(toolNames)
        && nativeTypedHooksAreSafe(typedHooks)
        && nativeGatewayMethodsAreSafeSuperset(gatewayMethods, expectedGatewayMethods)
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

/** Retained 2026.7.1 keeps its plugin authority; the floor family uses native questions. */
export function questionAuthorityForOpenClawVersion(
  version: unknown,
): OpenClawQuestionAuthority | null {
  const family = openClawRuntimeFamilyForVersion(typeof version === 'string' ? version.trim() : '');
  if (family === 'legacy-2026.7.1') return 'legacy-custom';
  return family === 'current-2026.9.1' ? 'native' : null;
}

export interface OpenClawQuestionPluginReadiness {
  ready: boolean;
  questionAuthority: OpenClawQuestionAuthority | null;
  expectedPluginVersion: string | null;
  issue: string | null;
  /** The runtime-guard inspect was killed at its timeout: no plugin evidence. */
  inspectTimedOut?: boolean;
}

export interface OpenClawQuestionPluginReadinessDependencies {
  runCli: (
    args: string[],
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; stdout: string; stderr: string; error?: string; timedOut?: boolean }>;
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
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string; timedOut?: boolean }> {
  try {
    const result = await execFileAsync(...openClawDiagnosticCommand('openclaw', args), {
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
      ...(isOpenClawCliTimeout(error) ? { timedOut: true } : {}),
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
      issue: 'OpenClaw question authority needs an admitted OpenClaw runtime (see the OpenClaw readiness blockers).',
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
    OPENCLAW_PLUGIN_INSPECT_TIMEOUT_MS,
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
    // Only an inspect that answered can show a mismatch; a killed or failed
    // inspect says nothing about the plugin surface. All three stay not ready.
    return {
      ready: false,
      questionAuthority,
      expectedPluginVersion,
      ...(inspection.timedOut ? { inspectTimedOut: true } : {}),
      issue: inspection.timedOut
        ? `OpenClaw did not finish inspecting the runtime-guard plugin within ${Math.round(OPENCLAW_PLUGIN_INSPECT_TIMEOUT_MS / 1000)} s; the host may be busy. Retry shortly.`
        : !inspection.ok
          ? `OpenClaw could not inspect the runtime-guard plugin: ${String(inspection.stderr || inspection.error || 'unknown error').slice(0, 300)}`
          : questionAuthority === 'native'
            ? 'OpenClaw native-question runtimes must run the bundled 4.0 runtime-guard plugin with its steer method and no second question authority.'
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

  // A cold native 10.6 catalog took 12.4 s on installed TEST despite a
  // healthy gateway. Match the installer's bounded catalog allowance; the
  // semantic tool/authority checks and other RPC budgets remain unchanged.
  const toolCatalog = await dependencies.callGatewayRpc('tools.catalog', {
    agentId: 'main',
    includePlugins: true,
  }, 30_000);
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
