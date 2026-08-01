import crypto, { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../../../AgentProvider.interface';
import { NativeProviderDiagnosticError } from '../NativeProviderDiagnostics';
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
import { PORTAL_TOOL_VERSIONS } from '../../../../config/toolVersions';

export const CLAUDE_CODE_PROJECT_RUNTIME = 'claude-code-project-adapter';
export const CLAUDE_CODE_PROJECT_RUNTIME_POLICY_VERSION = 'portal-claude-code-project-sandbox-v1';
export const CLAUDE_CODE_PROJECT_CLI_VERSION = PORTAL_TOOL_VERSIONS.claudeCode;
export const CLAUDE_CODE_PROJECT_CLI_PATH = '/usr/local/bin/claude';
export const CLAUDE_CODE_PROJECT_CREDENTIAL_PATH = `${NATIVE_CLI_PROJECT_CONTAINER_HOME}/.claude/.credentials.json`;
export const CLAUDE_CODE_PROJECT_SETTINGS_PATH = `${NATIVE_CLI_PROJECT_CONTAINER_HOME}/.claude/portal-project-settings.json`;

const MAX_AUTH_BYTES = 1024 * 1024;

export const CLAUDE_CODE_PROJECT_RUNTIME_PROFILE: NativeCliProjectRuntimeProfile = Object.freeze({
  provider: 'CLAUDE_CODE',
  displayName: 'Claude Code',
  runtime: CLAUDE_CODE_PROJECT_RUNTIME,
  containerNamePrefix: 'p4cc',
  runtimePolicyVersion: CLAUDE_CODE_PROJECT_RUNTIME_POLICY_VERSION,
  cliPath: CLAUDE_CODE_PROJECT_CLI_PATH,
  allowLoopback: false,
  environment: Object.freeze({
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
  }),
});

export interface ClaudeCodeProjectInvocationInput {
  readonly executionContext: ProjectSandboxExecutionContext;
  readonly nativeSessionId?: string | null;
  /** True only after Claude emitted an authoritative init/result event. */
  readonly nativeSessionEstablished?: boolean;
  readonly model?: string | null;
  readonly message: string;
  readonly turnId?: string;
  readonly egress?: ProjectEgressPlaneConfig;
  /** Qualification challenges must not expose any Project tools. */
  readonly qualification?: boolean;
}

export interface ClaudeCodeProjectSandboxDependencies {
  readonly runtime: Partial<NativeCliProjectEgressRuntimeDependencies>;
  readonly ensureRuntime: typeof ensureNativeCliProjectEgressRuntime;
  readonly authSource: () => string;
}

function configuredAuthSource(): string {
  const configured = String(process.env.PORTAL_CLAUDE_CODE_AUTH_PATH || '').trim();
  return path.resolve(configured || path.join(process.env.HOME || '/root', '.claude', '.credentials.json'));
}

// Unusable host credentials are an operator-actionable sign-in condition, not
// a portal defect. The typed AUTH_REQUIRED diagnostic lets qualification and
// turn routes answer with real sign-in guidance instead of a generic failure.
function sanitizeClaudeCredentials(source: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.toString('utf8'));
  } catch {
    throw new NativeProviderDiagnosticError('AUTH_REQUIRED', 'Claude Code authentication file is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NativeProviderDiagnosticError('AUTH_REQUIRED', 'Claude Code authentication file has an invalid shape');
  }
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) {
    throw new NativeProviderDiagnosticError('AUTH_REQUIRED', 'Claude Code OAuth credentials are missing');
  }
  const record = oauth as Record<string, unknown>;
  if (
    (typeof record.accessToken !== 'string' || !record.accessToken.trim())
    && (typeof record.refreshToken !== 'string' || !record.refreshToken.trim())
  ) {
    throw new NativeProviderDiagnosticError('AUTH_REQUIRED', 'Claude Code OAuth credentials contain no usable token');
  }
  return Buffer.from(`${JSON.stringify({ claudeAiOauth: record })}\n`, 'utf8');
}

export function renderClaudeCodeProjectSettings(): string {
  return `${JSON.stringify({
    permissions: {
      defaultMode: 'dontAsk',
      allow: [
        'Read(/workspace/project/**)',
        'Edit(/workspace/project/**)',
        'Write(/workspace/project/**)',
        'Glob(/workspace/project/**)',
        'Grep(/workspace/project/**)',
        'Bash(*)',
        'WebFetch(*)',
        'WebSearch(*)',
      ],
      deny: [
        'Read(/home/project-agent/**)',
        'Edit(/home/project-agent/**)',
        'Write(/home/project-agent/**)',
        'Read(/proc/**)',
        'Read(/sys/**)',
        'Read(/dev/**)',
      ],
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: {
        allowWrite: [NATIVE_CLI_PROJECT_CONTAINER_ROOT],
        denyWrite: [NATIVE_CLI_PROJECT_CONTAINER_HOME, '/proc', '/sys', '/dev'],
        denyRead: [NATIVE_CLI_PROJECT_CONTAINER_HOME, '/proc', '/sys', '/dev'],
      },
    },
    disableBypassPermissionsMode: 'disable',
    cleanupPeriodDays: 0,
  }, null, 2)}\n`;
}

function uuid(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

function prepareManagedState(
  context: ProjectSandboxExecutionContext,
  authSource: string,
): readonly [
  { sourcePath: string; targetPath: string; label: string },
  { sourcePath: string; targetPath: string; label: string },
] {
  if (!fs.existsSync(authSource)) {
    throw new NativeProviderDiagnosticError('AUTH_REQUIRED', 'Claude Code has not been signed in on this server');
  }
  const source = readProtectedNativeCliSource({
    sourcePath: authSource,
    projectRoot: context.canonicalRoot,
    label: 'Claude Code authentication file',
    maxBytes: MAX_AUTH_BYTES,
  });
  const authPath = stageNativeCliProjectManagedFile({
    context,
    provider: 'CLAUDE_CODE',
    fileName: 'claude-oauth.json',
    content: sanitizeClaudeCredentials(source),
    label: 'Managed Claude Code Project authentication file',
  });
  const settingsPath = stageNativeCliProjectManagedFile({
    context,
    provider: 'CLAUDE_CODE',
    fileName: 'claude-project-settings.json',
    content: renderClaudeCodeProjectSettings(),
    label: 'Managed Claude Code Project settings',
  });
  return Object.freeze([
    Object.freeze({
      sourcePath: authPath,
      targetPath: CLAUDE_CODE_PROJECT_CREDENTIAL_PATH,
      label: 'Claude Code Project authentication state',
    }),
    Object.freeze({
      sourcePath: settingsPath,
      targetPath: CLAUDE_CODE_PROJECT_SETTINGS_PATH,
      label: 'Claude Code Project settings',
    }),
  ]);
}

function invocationArgs(input: {
  nativeSessionId: string;
  resume: boolean;
  model?: string | null;
  message: string;
  qualification?: boolean;
}): string[] {
  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--safe-mode',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    '--settings', CLAUDE_CODE_PROJECT_SETTINGS_PATH,
    '--permission-mode', 'dontAsk',
    '--tools', input.qualification ? '' : 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch',
  ];
  if (input.resume) args.push('--resume', input.nativeSessionId);
  else args.push('--session-id', input.nativeSessionId);
  const model = String(input.model || '').trim();
  if (model) args.push('--model', model);
  args.push(input.message);
  return args;
}

const defaultDependencies: ClaudeCodeProjectSandboxDependencies = {
  runtime: {},
  ensureRuntime: ensureNativeCliProjectEgressRuntime,
  authSource: configuredAuthSource,
};

export async function ensureClaudeCodeProjectQualifiedRuntime(
  input: {
    executionContext: ProjectSandboxExecutionContext;
    egress?: ProjectEgressPlaneConfig;
  },
  overrides: Partial<ClaudeCodeProjectSandboxDependencies> = {},
): Promise<NativeCliProjectEgressRuntimeHandle> {
  assertExecutionContextBinding(input.executionContext, input.executionContext.userId, 'PROJECT_SANDBOX');
  if (input.executionContext.runtimePolicyVersion !== CLAUDE_CODE_PROJECT_RUNTIME_POLICY_VERSION) {
    throw new Error('Claude Code Project runtime policy has not been qualified');
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  return dependencies.ensureRuntime({
    context: input.executionContext,
    profile: CLAUDE_CODE_PROJECT_RUNTIME_PROFILE,
    egress: input.egress,
    prepareManagedState: () => prepareManagedState(input.executionContext, dependencies.authSource()),
  }, dependencies.runtime);
}

export async function buildClaudeCodeProjectInvocation(
  input: ClaudeCodeProjectInvocationInput,
  overrides: Partial<ClaudeCodeProjectSandboxDependencies> = {},
): Promise<NativeCliInvocation & { nativeSessionId: string; runtime: NativeCliProjectEgressRuntimeHandle }> {
  assertExecutionContextBinding(input.executionContext, input.executionContext.userId, 'PROJECT_SANDBOX');
  if (input.executionContext.runtimePolicyVersion !== CLAUDE_CODE_PROJECT_RUNTIME_POLICY_VERSION) {
    throw new Error('Claude Code Project runtime policy has not been qualified');
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  const nativeSessionId = uuid(input.nativeSessionId) || randomUUID();
  const resume = input.nativeSessionEstablished === true && Boolean(uuid(input.nativeSessionId));
  const runtime = await ensureClaudeCodeProjectQualifiedRuntime({
    executionContext: input.executionContext,
    egress: input.egress,
  }, dependencies);
  const turnId = String(input.turnId || '').trim() || crypto.createHash('sha256').update(JSON.stringify({
    nativeSessionId,
    message: input.message,
    at: Date.now(),
  })).digest('hex');
  return Object.assign(buildNativeCliProjectInvocation({
    runtime,
    profile: CLAUDE_CODE_PROJECT_RUNTIME_PROFILE,
    command: CLAUDE_CODE_PROJECT_CLI_PATH,
    args: invocationArgs({
      nativeSessionId,
      resume,
      model: input.model,
      message: input.message,
      qualification: input.qualification,
    }),
    turnId,
    executor: dependencies.runtime.executor,
  }), { nativeSessionId, runtime });
}

export const __claudeCodeProjectSandboxTest = {
  configuredAuthSource,
  sanitizeClaudeCredentials,
  invocationArgs,
  uuid,
};
