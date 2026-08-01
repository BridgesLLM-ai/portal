import crypto from 'crypto';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../../../AgentProvider.interface';
import { assertExecutionContextBinding } from '../../../executionScope';
import type { NativeCliInvocation } from '../types';
import type { ProjectEgressPlaneConfig } from '../../../../services/projectEgressPlane';
import {
  NATIVE_CLI_PROJECT_CONTAINER_HOME,
  NATIVE_CLI_PROJECT_CONTAINER_ROOT,
  buildNativeCliProjectInvocation,
  ensureNativeCliProjectEgressRuntime,
  type NativeCliProjectEgressRuntimeDependencies,
  type NativeCliProjectEgressRuntimeHandle,
  type NativeCliProjectRuntimeProfile,
} from './NativeCliProjectEgressRuntime';
import {
  readProtectedNativeCliSource,
  stageNativeCliProjectManagedFile,
} from './NativeCliProjectManagedState';
import { renderAntigravityProjectBridge } from './AntigravityProjectBridge';
import { PORTAL_TOOL_VERSIONS } from '../../../../config/toolVersions';

export const ANTIGRAVITY_PROJECT_RUNTIME = 'antigravity-project-adapter';
export const ANTIGRAVITY_PROJECT_RUNTIME_POLICY_VERSION = 'portal-antigravity-project-sandbox-v1';
export const ANTIGRAVITY_PROJECT_CLI_VERSION = PORTAL_TOOL_VERSIONS.antigravity;
export const ANTIGRAVITY_PROJECT_CLI_PATH = '/usr/local/bin/agy';
export const ANTIGRAVITY_PROJECT_BRIDGE_PATH = `${NATIVE_CLI_PROJECT_CONTAINER_HOME}/portal-antigravity-project-bridge.cjs`;
export const ANTIGRAVITY_PROJECT_TOKEN_PATH = `${NATIVE_CLI_PROJECT_CONTAINER_HOME}/.gemini/antigravity-cli/antigravity-oauth-token`;
export const ANTIGRAVITY_PROJECT_SETTINGS_PATH = `${NATIVE_CLI_PROJECT_CONTAINER_HOME}/.gemini/antigravity-cli/settings.json`;

const MAX_AUTH_BYTES = 1024 * 1024;

export const ANTIGRAVITY_PROJECT_RUNTIME_PROFILE: NativeCliProjectRuntimeProfile = Object.freeze({
  provider: 'GEMINI',
  displayName: 'Google Antigravity',
  runtime: ANTIGRAVITY_PROJECT_RUNTIME,
  containerNamePrefix: 'p4ag',
  runtimePolicyVersion: ANTIGRAVITY_PROJECT_RUNTIME_POLICY_VERSION,
  // The hash-attested bridge invokes the fixed Antigravity binary. Using Node
  // here lets the bridge project the native transcript into structured events.
  // The pinned Antigravity runtime image installs Node under /usr/local/bin.
  // Using the host service path (/usr/bin/node) made every confined bridge
  // invocation exit 127 even though image readiness passed `node --version`.
  cliPath: '/usr/local/bin/node',
  allowLoopback: true,
  environment: Object.freeze({
    AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    GOOGLE_CLOUD_TELEMETRY_DISABLED: '1',
  }),
});

export interface AntigravityProjectInvocationInput {
  readonly executionContext: ProjectSandboxExecutionContext;
  readonly nativeSessionId?: string | null;
  readonly model?: string | null;
  readonly message: string;
  readonly turnId?: string;
  readonly egress?: ProjectEgressPlaneConfig;
  /** Run the authenticated model challenge outside the writable Project cwd. */
  readonly qualification?: boolean;
}

export interface AntigravityProjectSandboxDependencies {
  readonly runtime: Partial<NativeCliProjectEgressRuntimeDependencies>;
  readonly ensureRuntime: typeof ensureNativeCliProjectEgressRuntime;
  readonly authSource: () => string;
}

function configuredAuthSource(): string {
  const configured = String(process.env.PORTAL_ANTIGRAVITY_AUTH_PATH || '').trim();
  return path.resolve(configured || path.join(
    process.env.HOME || '/root',
    '.gemini',
    'antigravity-cli',
    'antigravity-oauth-token',
  ));
}

export function normalizeAntigravityProjectModel(model?: string | null): string | null {
  const raw = String(model || '').trim();
  if (!raw) return null;
  const modelName = raw
    .replace(/^google-antigravity\//, '')
    .replace(/^google-gemini-cli\//, '')
    .replace(/^google\//, '');
  switch (modelName) {
    case 'gemini-3-flash-preview':
    case 'gemini-3-flash':
      return 'gemini-3.5-flash';
    case 'gemini-3.1-pro-preview':
    case 'gemini-3-pro-preview':
    case 'gemini-3-pro-high':
      return 'gemini-3.1-pro-high';
    case 'gemini-3.1-flash-lite':
    case 'gemini-3.1-flash-lite-preview':
      return 'gemini-3.5-flash';
    default:
      if (!/^[a-zA-Z0-9._:/-]{1,128}$/.test(modelName) || modelName.includes('..')) {
        throw new Error('Antigravity Project model identity is invalid');
      }
      return modelName;
  }
}

function conversationId(value?: string | null): string | null {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

function sanitizeAntigravityToken(source: Buffer): Buffer {
  const text = source.toString('utf8').trim();
  if (!text || text.includes('\u0000')) {
    throw new Error('Antigravity OAuth token is invalid');
  }
  return Buffer.from(`${text}\n`, 'utf8');
}

export function renderAntigravityProjectSettings(): string {
  return `${JSON.stringify({
    toolPermission: 'proceed-in-sandbox',
    agentMode: 'accept-edits',
    allowNonWorkspaceAccess: false,
    enableTerminalSandbox: true,
    enableTelemetry: false,
    permissions: {
      allow: [
        `read_file(${NATIVE_CLI_PROJECT_CONTAINER_ROOT})`,
        `write_file(${NATIVE_CLI_PROJECT_CONTAINER_ROOT})`,
        'command(*)',
        'read_url(*)',
      ],
      deny: [
        `read_file(${NATIVE_CLI_PROJECT_CONTAINER_HOME})`,
        `write_file(${NATIVE_CLI_PROJECT_CONTAINER_HOME})`,
        'unsandboxed(*)',
        'mcp(*)',
        'execute_url(*)',
      ],
      ask: [],
    },
    security: {
      auth: {
        selectedType: 'oauth-personal',
      },
    },
  }, null, 2)}\n`;
}

function prepareManagedState(
  context: ProjectSandboxExecutionContext,
  authSource: string,
): readonly {
  sourcePath: string;
  targetPath: string;
  label: string;
}[] {
  const source = readProtectedNativeCliSource({
    sourcePath: authSource,
    projectRoot: context.canonicalRoot,
    label: 'Antigravity OAuth token',
    maxBytes: MAX_AUTH_BYTES,
  });
  const tokenPath = stageNativeCliProjectManagedFile({
    context,
    provider: 'GEMINI',
    fileName: 'antigravity-oauth-token',
    content: sanitizeAntigravityToken(source),
    label: 'Managed Antigravity Project OAuth token',
  });
  const settingsPath = stageNativeCliProjectManagedFile({
    context,
    provider: 'GEMINI',
    fileName: 'antigravity-project-settings.json',
    content: renderAntigravityProjectSettings(),
    label: 'Managed Antigravity Project settings',
  });
  const bridgePath = stageNativeCliProjectManagedFile({
    context,
    provider: 'GEMINI',
    fileName: 'antigravity-project-bridge.cjs',
    content: renderAntigravityProjectBridge(),
    label: 'Managed Antigravity Project event bridge',
  });
  return Object.freeze([
    Object.freeze({
      sourcePath: tokenPath,
      targetPath: ANTIGRAVITY_PROJECT_TOKEN_PATH,
      label: 'Antigravity Project OAuth token',
    }),
    Object.freeze({
      sourcePath: settingsPath,
      targetPath: ANTIGRAVITY_PROJECT_SETTINGS_PATH,
      label: 'Antigravity Project settings',
    }),
    Object.freeze({
      sourcePath: bridgePath,
      targetPath: ANTIGRAVITY_PROJECT_BRIDGE_PATH,
      label: 'Antigravity Project event bridge',
    }),
  ]);
}

function invocationArgs(input: {
  message: string;
  model?: string | null;
  nativeSessionId?: string | null;
  qualification?: boolean;
}): string[] {
  const args = [
    ANTIGRAVITY_PROJECT_BRIDGE_PATH,
    '--message-base64', Buffer.from(input.message, 'utf8').toString('base64url'),
  ];
  const model = normalizeAntigravityProjectModel(input.model);
  if (model) args.push('--model', model);
  const sessionId = conversationId(input.nativeSessionId);
  if (sessionId) args.push('--conversation', sessionId);
  if (input.qualification) args.push('--qualification', '1');
  return args;
}

const defaultDependencies: AntigravityProjectSandboxDependencies = {
  runtime: {},
  ensureRuntime: ensureNativeCliProjectEgressRuntime,
  authSource: configuredAuthSource,
};

export async function ensureAntigravityProjectQualifiedRuntime(
  input: {
    executionContext: ProjectSandboxExecutionContext;
    egress?: ProjectEgressPlaneConfig;
  },
  overrides: Partial<AntigravityProjectSandboxDependencies> = {},
): Promise<NativeCliProjectEgressRuntimeHandle> {
  assertExecutionContextBinding(input.executionContext, input.executionContext.userId, 'PROJECT_SANDBOX');
  if (input.executionContext.runtimePolicyVersion !== ANTIGRAVITY_PROJECT_RUNTIME_POLICY_VERSION) {
    throw new Error('Antigravity Project runtime policy has not been qualified');
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  return dependencies.ensureRuntime({
    context: input.executionContext,
    profile: ANTIGRAVITY_PROJECT_RUNTIME_PROFILE,
    egress: input.egress,
    prepareManagedState: () => prepareManagedState(input.executionContext, dependencies.authSource()),
  }, dependencies.runtime);
}

export async function buildAntigravityProjectInvocation(
  input: AntigravityProjectInvocationInput,
  overrides: Partial<AntigravityProjectSandboxDependencies> = {},
): Promise<NativeCliInvocation & { runtime: NativeCliProjectEgressRuntimeHandle }> {
  assertExecutionContextBinding(input.executionContext, input.executionContext.userId, 'PROJECT_SANDBOX');
  if (input.executionContext.runtimePolicyVersion !== ANTIGRAVITY_PROJECT_RUNTIME_POLICY_VERSION) {
    throw new Error('Antigravity Project runtime policy has not been qualified');
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  const runtime = await ensureAntigravityProjectQualifiedRuntime({
    executionContext: input.executionContext,
    egress: input.egress,
  }, dependencies);
  const turnId = String(input.turnId || '').trim() || crypto.createHash('sha256').update(JSON.stringify({
    nativeSessionId: input.nativeSessionId || null,
    message: input.message,
    at: Date.now(),
  })).digest('hex');
  return Object.assign(buildNativeCliProjectInvocation({
    runtime,
    profile: ANTIGRAVITY_PROJECT_RUNTIME_PROFILE,
    command: ANTIGRAVITY_PROJECT_RUNTIME_PROFILE.cliPath,
    args: invocationArgs({
      message: input.message,
      model: input.model,
      nativeSessionId: input.nativeSessionId,
      qualification: input.qualification,
    }),
    turnId,
    executor: dependencies.runtime.executor,
  }), { runtime });
}

export const __antigravityProjectSandboxTest = {
  configuredAuthSource,
  conversationId,
  sanitizeAntigravityToken,
  invocationArgs,
};
