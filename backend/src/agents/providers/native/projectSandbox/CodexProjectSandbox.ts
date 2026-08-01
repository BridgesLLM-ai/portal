import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../../../AgentProvider.interface';
import { assertExecutionContextBinding } from '../../../executionScope';
import type { NativeCliInvocation } from '../types';
import { ensureRuntimeDirectory } from '../../../../utils/runtimeDirectory';
import { parseProjectEgressUrl } from '../../../../services/projectEgressPolicy';
import type { ProjectEgressPlaneConfig } from '../../../../services/projectEgressPlane';
import {
  PROJECT_RUNTIME_GID,
  PROJECT_RUNTIME_UID,
} from '../../../../services/projectRuntimeIdentity';
import {
  CODEX_PROJECT_CONTAINER_CODEX_HOME,
  CODEX_PROJECT_CONTAINER_HOME,
  CODEX_PROJECT_CONTAINER_ROOT,
  CODEX_PROJECT_CONTAINER_USER,
  buildCodexProjectDockerExecArgs,
  codexProjectEgressCommandExecutor,
  codexProjectDockerHostEnvironment,
  ensureCodexProjectEgressRuntime,
  type CodexProjectEgressRuntimeDependencies,
  type CodexProjectEgressRuntimeHandle,
} from './CodexProjectEgressRuntime';
import { buildExactNativeCliProjectInvocation } from './NativeCliProjectRunControl';
import { PORTAL_TOOL_VERSIONS } from '../../../../config/toolVersions';

export {
  CODEX_PROJECT_CONTAINER_ROOT,
  CODEX_PROJECT_RUNTIME,
} from './CodexProjectEgressRuntime';
export const CODEX_PROJECT_CLI_VERSION = PORTAL_TOOL_VERSIONS.codexCli;
export const CODEX_PROJECT_BWRAP_MIN_VERSION = '0.6.1';
export const CODEX_PROJECT_BWRAP_MAX_EXCLUSIVE_VERSION = '0.12.0';
export const CODEX_PROJECT_BWRAP_SUPPORTED_RANGE = `>=${CODEX_PROJECT_BWRAP_MIN_VERSION} <${CODEX_PROJECT_BWRAP_MAX_EXCLUSIVE_VERSION}`;
export const CODEX_PROJECT_PROFILE_NAME = 'portal-project';
export const CODEX_PROJECT_PERMISSION_PROFILE = 'portal_project';

const CONTAINER_HOME = CODEX_PROJECT_CONTAINER_HOME;
const CONTAINER_CODEX_HOME = CODEX_PROJECT_CONTAINER_CODEX_HOME;
const PROFILE_FILE_NAME = `${CODEX_PROJECT_PROFILE_NAME}.config.toml`;
const PROBE_TTL_MS = 5 * 60_000;
const MAX_AUTH_BYTES = 1024 * 1024;
const DEFAULT_PUBLIC_EGRESS_PROBE_URL = 'https://example.com/';

export interface CodexProjectSandboxAvailability {
  ready: boolean;
  reason: string;
  codexVersion?: string;
  bwrapVersion?: string;
}

export interface CodexProjectInvocationInput {
  executionContext: ProjectSandboxExecutionContext;
  turnId: string;
  nativeSessionId?: string | null;
  model?: string | null;
  message: string;
}

export interface CodexProjectInvocationDependencies {
  runtime: Partial<CodexProjectEgressRuntimeDependencies>;
  ensureRuntime(
    input: {
      context: ProjectSandboxExecutionContext;
      egress?: ProjectEgressPlaneConfig;
      retirePreviousManagedState(context: ProjectSandboxExecutionContext): void;
      prepareManagedState(proxyEnvironment: Readonly<Record<string, string>>): {
        authPath: string;
        profilePath: string;
      };
    },
    overrides?: Partial<CodexProjectEgressRuntimeDependencies>,
  ): Promise<CodexProjectEgressRuntimeHandle>;
  qualifyRuntime(
    context: ProjectSandboxExecutionContext,
    runtime: CodexProjectEgressRuntimeHandle,
    executor: CodexProjectEgressRuntimeDependencies['executor'],
  ): Promise<void>;
  now(): number;
}

interface CodexProjectSandboxPaths {
  stateRoot: string;
  stateDir: string;
  profilePath: string;
  authPath: string;
}

let probeCache: {
  at: number;
  key: string;
  value: CodexProjectSandboxAvailability;
} | null = null;

function detectedVersion(output: string): string {
  return String(output || '').match(/\d+\.\d+\.\d+/)?.[0] || '';
}

function exactVersion(output: string, expected: string): boolean {
  const detected = detectedVersion(output);
  return detected === expected;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number(part));
  const rightParts = right.split('.').map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function isSupportedBubblewrapVersionOutput(output: string): boolean {
  const version = detectedVersion(output);
  if (!version) return false;
  return compareVersions(version, CODEX_PROJECT_BWRAP_MIN_VERSION) >= 0
    && compareVersions(version, CODEX_PROJECT_BWRAP_MAX_EXCLUSIVE_VERSION) < 0;
}

function configuredStateRoot(): string {
  const configured = String(process.env.PORTAL_CODEX_PROJECT_STATE_ROOT || '').trim();
  if (configured) return path.resolve(configured);
  const dataRoot = path.resolve(process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || '/portal');
  return path.join(dataRoot, '.data', 'project-sandboxes', 'codex');
}

function configuredAuthSource(): string {
  const configured = String(process.env.PORTAL_CODEX_AUTH_PATH || '').trim();
  return path.resolve(configured || path.join(process.env.HOME || '/root', '.codex', 'auth.json'));
}

function pathContains(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertCodexProjectSandboxPathSeparation(input: {
  projectRoot: string;
  stateRoot: string;
  authSource: string;
}): void {
  const projectRoot = path.resolve(input.projectRoot);
  const stateRoot = path.resolve(input.stateRoot);
  const authSource = path.resolve(input.authSource);
  if (projectRoot === path.parse(projectRoot).root) {
    throw new Error('Codex project root may not be a filesystem root');
  }
  if (pathContains(projectRoot, stateRoot) || pathContains(stateRoot, projectRoot)) {
    throw new Error('Codex project root and protected sandbox state must not overlap');
  }
  if (pathContains(projectRoot, authSource)) {
    throw new Error('Codex authentication source must not be inside the project root');
  }
}

function requireProtectedRegularFile(filePath: string, label: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file and may not be a symbolic link`);
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (stat.uid !== currentUid || (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must be owned by the Portal service account with mode 0600 or stricter`);
  }
  return stat;
}

function writeProtectedFileAtomic(filePath: string, content: Buffer | string): void {
  const parent = ensureRuntimeDirectory(path.dirname(filePath), { mode: 0o700, enforceMode: true });
  try {
    const existing = fs.lstatSync(filePath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`Refusing to replace unsafe sandbox state file: ${filePath}`);
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const tempPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const handle = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(handle, content);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function sealManagedRuntimeFile(filePath: string): void {
  fs.chownSync(filePath, PROJECT_RUNTIME_UID, PROJECT_RUNTIME_GID);
  fs.chmodSync(filePath, 0o400);
}

function requireManagedRuntimeFile(filePath: string, label: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file and may not be a symbolic link`);
  }
  if (stat.uid !== PROJECT_RUNTIME_UID || stat.gid !== PROJECT_RUNTIME_GID || (stat.mode & 0o777) !== 0o400) {
    throw new Error(`${label} must be owned by the confined runtime with mode 0400`);
  }
  return stat;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function requireExactProxyEnvironment(
  proxyEnvironment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
  if (Object.keys(proxyEnvironment).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error('Codex Project proxy environment must contain exactly the Portal-managed variables');
  }
  if (
    !proxyEnvironment.HTTP_PROXY
    || proxyEnvironment.HTTP_PROXY !== proxyEnvironment.HTTPS_PROXY
    || proxyEnvironment.HTTP_PROXY !== proxyEnvironment.http_proxy
    || proxyEnvironment.HTTP_PROXY !== proxyEnvironment.https_proxy
    || proxyEnvironment.NO_PROXY !== ''
    || proxyEnvironment.no_proxy !== ''
  ) {
    throw new Error('Codex Project proxy environment is invalid');
  }
  return proxyEnvironment;
}

export function renderCodexProjectProfile(
  proxyEnvironment: Readonly<Record<string, string>>,
): string {
  const proxy = requireExactProxyEnvironment(proxyEnvironment);
  const environment = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: CONTAINER_HOME,
    CODEX_HOME: CONTAINER_CODEX_HOME,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    ...proxy,
  };
  const serializedEnvironment = Object.entries(environment)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(', ');
  return `default_permissions = "${CODEX_PROJECT_PERMISSION_PROFILE}"

[permissions.${CODEX_PROJECT_PERMISSION_PROFILE}]
description = "Portal project confinement"

[permissions.${CODEX_PROJECT_PERMISSION_PROFILE}.filesystem]
":minimal" = "read"
":slash_tmp" = "write"
":tmpdir" = "write"
"~/.codex" = "deny"
"${CONTAINER_CODEX_HOME}" = "deny"

[permissions.${CODEX_PROJECT_PERMISSION_PROFILE}.filesystem.":workspace_roots"]
"." = "write"

[permissions.${CODEX_PROJECT_PERMISSION_PROFILE}.network]
enabled = true

[shell_environment_policy]
inherit = "none"
set = { ${serializedEnvironment} }
ignore_default_excludes = false

[features]
apps = false
auth_elicitation = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
computer_use = false
hooks = false
image_generation = false
in_app_browser = false
multi_agent = false
plugins = false
remote_plugin = false
skill_mcp_dependency_install = false
tool_call_mcp_elicitation = false
`;
}

function stateKey(context: ProjectSandboxExecutionContext): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    userId: context.userId,
    projectId: context.projectId,
    canonicalRoot: context.canonicalRoot,
    policyFingerprint: context.policyFingerprint,
  })).digest('hex');
}

export function retireCodexProjectManagedStateForContext(
  context: ProjectSandboxExecutionContext,
): void {
  assertExecutionContextBinding(context, context.userId, 'PROJECT_SANDBOX');
  const stateRoot = configuredStateRoot();
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(stateRoot);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : rootStat.uid;
  if (
    rootStat.isSymbolicLink()
    || !rootStat.isDirectory()
    || rootStat.uid !== currentUid
    || (rootStat.mode & 0o077) !== 0
    || fs.realpathSync.native(stateRoot) !== stateRoot
  ) {
    throw new Error('Codex project state root is unsafe for predecessor cleanup');
  }

  const key = stateKey(context);
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw new Error('Codex project predecessor state identity is invalid');
  }
  const stateDir = path.join(stateRoot, key);
  if (!pathContains(stateRoot, stateDir) || stateDir === stateRoot) {
    throw new Error('Codex project predecessor state path escaped its protected root');
  }
  let stateStat: fs.Stats;
  try {
    stateStat = fs.lstatSync(stateDir);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (
    stateStat.isSymbolicLink()
    || !stateStat.isDirectory()
    || stateStat.uid !== PROJECT_RUNTIME_UID
    || stateStat.gid !== PROJECT_RUNTIME_GID
    || (stateStat.mode & 0o777) !== 0o500
    || fs.realpathSync.native(stateDir) !== stateDir
  ) {
    throw new Error('Codex project predecessor state directory is unsafe');
  }

  const allowed = new Set(['auth.json', PROFILE_FILE_NAME]);
  const entries = fs.readdirSync(stateDir).sort();
  if (entries.some((entry) => !allowed.has(entry))) {
    throw new Error('Codex project predecessor state contains an unmanaged entry');
  }
  for (const entry of entries) {
    const target = path.join(stateDir, entry);
    const stat = requireManagedRuntimeFile(target, `Codex project predecessor ${entry}`);
    if (stat.nlink !== 1 || fs.realpathSync.native(target) !== target) {
      throw new Error('Codex project predecessor state file identity is unsafe');
    }
  }
  if (fs.readdirSync(stateDir).sort().join('\0') !== entries.join('\0')) {
    throw new Error('Codex project predecessor state inventory changed during cleanup');
  }
  for (const entry of entries) {
    fs.unlinkSync(path.join(stateDir, entry));
  }
  if (fs.readdirSync(stateDir).length !== 0) {
    throw new Error('Codex project predecessor state was not emptied exactly');
  }
  fs.rmdirSync(stateDir);
  if (fs.existsSync(stateDir)) {
    throw new Error('Codex project predecessor state directory remained after cleanup');
  }
}

function prepareState(
  context: ProjectSandboxExecutionContext,
  proxyEnvironment: Readonly<Record<string, string>>,
): CodexProjectSandboxPaths {
  assertExecutionContextBinding(context, context.userId, 'PROJECT_SANDBOX');
  const canonicalProjectRoot = fs.realpathSync(context.canonicalRoot);
  if (canonicalProjectRoot !== path.resolve(context.canonicalRoot)) {
    throw new Error('Codex project root must be canonical and may not resolve through a symbolic link');
  }
  const rootStat = fs.lstatSync(canonicalProjectRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Codex project root must be a real directory');
  }

  const configuredState = configuredStateRoot();
  const sourceAuthPath = configuredAuthSource();
  const sourceStat = requireProtectedRegularFile(sourceAuthPath, 'Codex authentication file');
  const canonicalAuthPath = fs.realpathSync(sourceAuthPath);
  if (canonicalAuthPath !== path.resolve(sourceAuthPath)) {
    throw new Error('Codex authentication source may not resolve through a symbolic link');
  }
  assertCodexProjectSandboxPathSeparation({
    projectRoot: canonicalProjectRoot,
    stateRoot: configuredState,
    authSource: canonicalAuthPath,
  });

  const stateRoot = ensureRuntimeDirectory(configuredState, { mode: 0o700, enforceMode: true });
  const stateDir = ensureRuntimeDirectory(path.join(stateRoot, stateKey(context)), { mode: 0o700, enforceMode: true });
  const baseConfig = path.join(stateDir, 'config.toml');
  if (fs.existsSync(baseConfig)) {
    throw new Error('Codex project state contains an unmanaged base configuration');
  }

  if (sourceStat.size <= 0 || sourceStat.size > MAX_AUTH_BYTES) {
    throw new Error('Codex authentication file has an invalid size');
  }

  const profilePath = path.join(stateDir, PROFILE_FILE_NAME);
  const expectedProfile = renderCodexProjectProfile(proxyEnvironment);
  let currentProfile = '';
  try {
    requireManagedRuntimeFile(profilePath, 'Codex project permission profile');
    currentProfile = fs.readFileSync(profilePath, 'utf8');
  } catch (error: any) {
    if (!/missing/.test(String(error?.message || ''))) throw error;
  }
  if (currentProfile !== expectedProfile) {
    writeProtectedFileAtomic(profilePath, expectedProfile);
    sealManagedRuntimeFile(profilePath);
  }

  const authPath = path.join(stateDir, 'auth.json');
  let managedAuthStat: fs.Stats | null = null;
  try {
    managedAuthStat = requireManagedRuntimeFile(authPath, 'Managed Codex project authentication file');
  } catch (error: any) {
    if (!/missing/.test(String(error?.message || ''))) throw error;
  }
  const sourceAuth = fs.readFileSync(sourceAuthPath);
  const managedAuth = managedAuthStat ? fs.readFileSync(authPath) : null;
  if (!managedAuth || !sourceAuth.equals(managedAuth)) {
    writeProtectedFileAtomic(authPath, sourceAuth);
    sealManagedRuntimeFile(authPath);
  }

  fs.chownSync(stateDir, PROJECT_RUNTIME_UID, PROJECT_RUNTIME_GID);
  fs.chmodSync(stateDir, 0o500);

  return { stateRoot, stateDir, profilePath, authPath };
}

function codexGlobalArgs(): string[] {
  return [
    '--ask-for-approval', 'never',
    '--profile', CODEX_PROJECT_PROFILE_NAME,
    '--strict-config',
    '--cd', CODEX_PROJECT_CONTAINER_ROOT,
  ];
}

function qualificationKey(
  context: ProjectSandboxExecutionContext,
  runtime: CodexProjectEgressRuntimeHandle,
): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    context: context.policyFingerprint,
    runtime: runtime.runtimeFingerprint,
    containerId: runtime.containerId,
    startedAt: runtime.startedAt,
  })).digest('hex');
}

function publicEgressProbeUrl(): string {
  const configured = String(process.env.PORTAL_CODEX_PROJECT_EGRESS_PROBE_URL || '').trim();
  const parsed = parseProjectEgressUrl(configured || DEFAULT_PUBLIC_EGRESS_PROBE_URL);
  if (parsed.url.protocol !== 'https:') {
    throw new Error('Codex Project public-egress probe must use HTTPS');
  }
  return parsed.url.toString();
}

async function runCodexProjectQualification(
  _context: ProjectSandboxExecutionContext,
  runtime: CodexProjectEgressRuntimeHandle,
  executor: CodexProjectEgressRuntimeDependencies['executor'],
): Promise<void> {
  const versionResult = await executor.run('docker', buildCodexProjectDockerExecArgs({
    runtime,
    command: '/usr/bin/codex',
    args: ['--version'],
  }));
  if (!exactVersion(versionResult.stdout, CODEX_PROJECT_CLI_VERSION)) {
    throw new Error(`Codex Project runtime requires the Portal-tested CLI ${CODEX_PROJECT_CLI_VERSION}`);
  }

  const publicUrl = publicEgressProbeUrl();
  const shellScript = `
set -eu
test "$PWD" = "${CODEX_PROJECT_CONTAINER_ROOT}"
probe_file=".portal-codex-egress-probe-$$"
trap 'rm -f "$probe_file"' EXIT HUP INT TERM
printf 'inside-ok' > "$probe_file"
test "$(cat "$probe_file")" = "inside-ok"
if cat "${CONTAINER_CODEX_HOME}/auth.json" >/dev/null 2>&1; then exit 61; fi
curl --fail --silent --show-error --max-time 20 --proxy "$HTTPS_PROXY" ${JSON.stringify(publicUrl)} >/dev/null
for target in \
  http://127.0.0.1/ \
  http://10.255.255.1/ \
  http://169.254.169.254/latest/meta-data/ \
  http://192.168.255.254/; do
  if curl --fail --silent --max-time 2 --noproxy '*' "$target" >/dev/null 2>&1; then exit 71; fi
  if curl --fail --silent --max-time 2 --proxy "$HTTP_PROXY" "$target" >/dev/null 2>&1; then exit 72; fi
done
`;
  const args = [
    'sandbox',
    '--profile', CODEX_PROJECT_PROFILE_NAME,
    '--permission-profile', CODEX_PROJECT_PERMISSION_PROFILE,
    '--cd', CODEX_PROJECT_CONTAINER_ROOT,
    '/bin/sh', '-c', shellScript,
  ];
  const runner = `
const { spawnSync } = require('child_process');
const result = spawnSync('/usr/bin/codex', ${JSON.stringify(args)}, {
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 60000,
  env: process.env,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error || result.signal) process.exit(124);
process.exit(result.status == null ? 125 : result.status);
`;
  await executor.run('docker', buildCodexProjectDockerExecArgs({
    runtime,
    command: 'node',
    args: ['-e', runner],
  }));
}

const defaultInvocationDependencies: CodexProjectInvocationDependencies = {
  runtime: {},
  ensureRuntime: ensureCodexProjectEgressRuntime,
  qualifyRuntime: runCodexProjectQualification,
  now: () => Date.now(),
};

async function prepareQualifiedRuntime(
  context: ProjectSandboxExecutionContext,
  overrides: Partial<CodexProjectInvocationDependencies>,
  egress?: ProjectEgressPlaneConfig,
): Promise<CodexProjectEgressRuntimeHandle> {
  const dependencies: CodexProjectInvocationDependencies = {
    ...defaultInvocationDependencies,
    ...overrides,
    runtime: { ...defaultInvocationDependencies.runtime, ...(overrides.runtime || {}) },
  };
  const runtime = await dependencies.ensureRuntime({
    context,
    egress,
    retirePreviousManagedState: retireCodexProjectManagedStateForContext,
    prepareManagedState: (proxyEnvironment) => {
      const state = prepareState(context, proxyEnvironment);
      return { authPath: state.authPath, profilePath: state.profilePath };
    },
  }, dependencies.runtime);
  const key = qualificationKey(context, runtime);
  if (!probeCache || probeCache.key !== key || dependencies.now() - probeCache.at >= PROBE_TTL_MS || !probeCache.value.ready) {
    try {
      await dependencies.qualifyRuntime(
        context,
        runtime,
        dependencies.runtime.executor || codexProjectEgressCommandExecutor,
      );
      probeCache = {
        at: dependencies.now(),
        key,
        value: {
          ready: true,
          reason: `Codex ${CODEX_PROJECT_CLI_VERSION} passed pinned-runtime, Project filesystem, controlled-public-egress, and private-network denial qualification.`,
          codexVersion: CODEX_PROJECT_CLI_VERSION,
        },
      };
    } catch (error: any) {
      probeCache = {
        at: dependencies.now(),
        key,
        value: {
          ready: false,
          reason: `${String(error?.message || error || 'Codex Project qualification failed').replace(/[.\s]+$/, '')}.`,
        },
      };
      throw error;
    }
  }
  return runtime;
}

/**
 * Provision and synchronously attest the exact confined runtime used by Codex
 * Project turns. The qualification service supplies the actor/project-bound
 * egress configuration explicitly so a provider lane cannot silently qualify
 * a different proxy identity from the one recorded in its evidence.
 */
export async function ensureCodexProjectQualifiedRuntime(
  input: {
    context: ProjectSandboxExecutionContext;
    egress: ProjectEgressPlaneConfig;
  },
  overrides: Partial<CodexProjectInvocationDependencies> = {},
): Promise<CodexProjectEgressRuntimeHandle> {
  return prepareQualifiedRuntime(input.context, overrides, input.egress);
}

export async function buildCodexProjectInvocation(
  input: CodexProjectInvocationInput,
  overrides: Partial<CodexProjectInvocationDependencies> = {},
): Promise<NativeCliInvocation> {
  assertExecutionContextBinding(input.executionContext, input.executionContext.userId, 'PROJECT_SANDBOX');
  const turnId = String(input.turnId || '').trim();
  if (!turnId || turnId.length > 512 || /[\u0000-\u001f\u007f]/.test(turnId)) {
    throw new Error('Codex project turn identity is invalid');
  }
  const nativeSessionId = String(input.nativeSessionId || '').trim();
  if (nativeSessionId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(nativeSessionId)) {
    throw new Error('Codex project session identity is invalid');
  }
  const model = String(input.model || '').trim();
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model)) {
    throw new Error('Codex project model identity is invalid');
  }
  const runtime = await prepareQualifiedRuntime(input.executionContext, overrides);
  const codexArgs = codexGlobalArgs();

  if (nativeSessionId) {
    codexArgs.push('exec', 'resume', '--skip-git-repo-check', '--ignore-rules', '--json');
    if (model) codexArgs.push('--model', model);
    codexArgs.push(nativeSessionId, '--', input.message);
  } else {
    codexArgs.push('exec', '--skip-git-repo-check', '--ignore-rules', '--color', 'never', '--json');
    if (model) codexArgs.push('--model', model);
    codexArgs.push('--', input.message);
  }

  return buildExactNativeCliProjectInvocation({
    runtime,
    containerUser: CODEX_PROJECT_CONTAINER_USER,
    containerRoot: CODEX_PROJECT_CONTAINER_ROOT,
    markerNamespace: 'codex',
    command: '/usr/bin/codex',
    args: codexArgs,
    runId: turnId,
    executor: overrides.runtime?.executor || codexProjectEgressCommandExecutor,
    hostCwd: input.executionContext.canonicalRoot,
    hostEnvironment: codexProjectDockerHostEnvironment(),
    containerEnvironment: runtime.proxyEnvironment,
  });
}

/**
 * Build the same two-layer sandbox used by real turns, but execute a local
 * shell through Codex's named permission profile. This exists so release tests
 * can prove filesystem denials without making a model/API request.
 */
export async function buildCodexProjectSandboxVerificationInvocation(
  executionContext: ProjectSandboxExecutionContext,
  shellScript: string,
  overrides: Partial<CodexProjectInvocationDependencies> = {},
): Promise<NativeCliInvocation> {
  assertExecutionContextBinding(executionContext, executionContext.userId, 'PROJECT_SANDBOX');
  const runtime = await prepareQualifiedRuntime(executionContext, overrides);
  return {
    command: 'docker',
    args: buildCodexProjectDockerExecArgs({
      runtime,
      command: '/usr/bin/codex',
      args: ['sandbox',
      '--profile', CODEX_PROJECT_PROFILE_NAME,
      '--permission-profile', CODEX_PROJECT_PERMISSION_PROFILE,
      '--cd', CODEX_PROJECT_CONTAINER_ROOT,
      '/bin/sh', '-c', shellScript,
      ],
    }),
    options: {
      cwd: executionContext.canonicalRoot,
      env: codexProjectDockerHostEnvironment(),
    },
  };
}

export function probeCodexProjectSandboxRuntime(options: { force?: boolean } = {}): CodexProjectSandboxAvailability {
  if (!options.force && probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
    return { ...probeCache.value };
  }

  let value: CodexProjectSandboxAvailability;
  try {
    if (process.platform !== 'linux') throw new Error('Codex Project Sandbox requires Linux');
    if (!fs.existsSync('/usr/bin/docker')) throw new Error('Codex Project Sandbox requires /usr/bin/docker');
    if (!fs.existsSync('/usr/bin/nsenter')) throw new Error('Codex Project Sandbox requires /usr/bin/nsenter');
    execFileSync('/usr/bin/docker', ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
      env: codexProjectDockerHostEnvironment(),
    });
    requireProtectedRegularFile(configuredAuthSource(), 'Codex authentication file');
    value = probeCache?.value.ready
      ? { ...probeCache.value }
      : {
        ready: false,
        reason: 'Codex Project Sandbox remains unavailable until a pinned per-project runtime passes live filesystem and controlled-egress qualification.',
      };
  } catch (error: any) {
    value = {
      ready: false,
      reason: `${String(error?.message || error || 'Codex Project Sandbox validation failed').replace(/[.\s]+$/, '')}.`,
    };
  }
  probeCache = { at: Date.now(), key: probeCache?.key || 'unqualified', value };
  return { ...value };
}

export function clearCodexProjectSandboxProbeCacheForTests(): void {
  probeCache = null;
}

export function getCodexProjectSandboxStateRootForTests(): string {
  return configuredStateRoot();
}

export function makeCodexProjectSandboxTestRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-project-'));
}
