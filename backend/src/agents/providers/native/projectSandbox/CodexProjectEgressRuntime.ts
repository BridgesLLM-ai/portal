import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import type { ProjectSandboxExecutionContext } from '../../../AgentProvider.interface';
import { assertExecutionContextBinding } from '../../../executionScope';
import { attestProjectRoot } from '../../../../services/projectIdentity';
import { buildProjectEgressConfig } from '../../../../services/projectEgressCredentials';
import {
  PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL,
  buildProjectEgressPlaneSpec,
  constrainProjectRuntimeToEgressPlane,
  derivePreConfinementProjectEgressPolicyFingerprint,
  ensureProjectEgressPlane,
  resolveRecognizedProjectEgressInternalNetworkBinding,
  type ProjectEgressCommandExecutor,
  type ProjectEgressCommandResult,
  type ProjectEgressPlaneConfig,
  type ProjectEgressPlaneHandle,
  type ProjectEgressInternalNetworkBinding,
  type ProjectEgressPlaneSpec,
} from '../../../../services/projectEgressPlane';
import { PROJECT_EGRESS_POLICY_VERSION } from '../../../../services/projectEgressPolicy';
import {
  PROJECT_RUNTIME_GID,
  PROJECT_RUNTIME_UID,
  PROJECT_RUNTIME_USER,
} from '../../../../services/projectRuntimeIdentity';
import {
  assertCodexProjectRuntimeConfinementReadyForExecution,
  attestCodexProjectRuntimeSecurityOptions,
  attestPreConfinementProjectRuntimeSecurityOptions,
  attestProjectRuntimeSecurityOptions,
  codexProjectRuntimeSecurityOptArgs,
  codexProjectRuntimeSecurityOptionValues,
  projectRuntimeSecurityOptionValues,
} from '../../../../services/projectRuntimeConfinement';

export const CODEX_PROJECT_RUNTIME = 'codex-project-adapter';
export const CODEX_PROJECT_RUNTIME_POLICY_VERSION = 'portal-project-sandbox-v3';
export const CODEX_PROJECT_PREVIOUS_RUNTIME_POLICY_VERSION = 'portal-project-sandbox-v2';
export const CODEX_PROJECT_CONTAINER_USER = PROJECT_RUNTIME_USER;
export const CODEX_PROJECT_CONTAINER_ROOT = '/workspace/project';
export const CODEX_PROJECT_CONTAINER_HOME = '/home/codex';
export const CODEX_PROJECT_CONTAINER_CODEX_HOME = `${CODEX_PROJECT_CONTAINER_HOME}/.codex`;

const CONTAINER_MEMORY_BYTES = 1024 * 1024 * 1024;
const CONTAINER_NANO_CPUS = 2_000_000_000;
const CONTAINER_PIDS_LIMIT = 256;
const PROXY_PORT = 3128;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const RUNTIME_LABEL_PREFIX = 'com.bridgesllm.codex-project';
const RUNTIME_POLICY_LABEL = `${RUNTIME_LABEL_PREFIX}.policy`;
export const CODEX_PROJECT_RUNTIME_ACTOR_LABEL = `${RUNTIME_LABEL_PREFIX}.actor`;
export const CODEX_PROJECT_RUNTIME_IDENTITY_LABEL = `${RUNTIME_LABEL_PREFIX}.project`;
const RUNTIME_EGRESS_LABEL = `${RUNTIME_LABEL_PREFIX}.egress`;

const IDLE_SCRIPT = 'setInterval(() => {}, 2147483647)';
const EXPECTED_PROXY_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
]);

interface DockerContainerInspect {
  Id?: string;
  Image?: string;
  Name?: string;
  Config?: {
    Image?: string;
    User?: string;
    Env?: string[] | null;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    Labels?: Record<string, string> | null;
    WorkingDir?: string;
    ExposedPorts?: Record<string, unknown> | null;
    Volumes?: Record<string, unknown> | null;
  };
  State?: {
    Running?: boolean;
    Pid?: number;
    StartedAt?: string;
  };
  AppArmorProfile?: string;
  HostConfig?: {
    Init?: boolean;
    ReadonlyRootfs?: boolean;
    CapAdd?: string[] | null;
    CapDrop?: string[] | null;
    SecurityOpt?: string[] | null;
    Binds?: string[] | null;
    Mounts?: unknown[] | null;
    Tmpfs?: Record<string, string> | null;
    PortBindings?: Record<string, unknown> | null;
    PublishAllPorts?: boolean;
    NetworkMode?: string;
    Privileged?: boolean;
    PidMode?: string;
    IpcMode?: string;
    UTSMode?: string;
    UsernsMode?: string;
    CgroupnsMode?: string;
    RestartPolicy?: { Name?: string };
    AutoRemove?: boolean;
    OomKillDisable?: boolean;
    PidsLimit?: number | null;
    Memory?: number;
    MemorySwap?: number;
    NanoCpus?: number;
    Ulimits?: Array<{ Name?: string; Soft?: number; Hard?: number }> | null;
    Devices?: unknown[] | null;
    DeviceRequests?: unknown[] | null;
    DeviceCgroupRules?: string[] | null;
    Dns?: string[] | null;
    DnsOptions?: string[] | null;
    DnsSearch?: string[] | null;
    ExtraHosts?: string[] | null;
    Links?: string[] | null;
    VolumesFrom?: string[] | null;
  };
  Mounts?: Array<{
    Type?: string;
    Source?: string;
    Destination?: string;
    Mode?: string;
    RW?: boolean;
    Propagation?: string;
  }>;
  NetworkSettings?: {
    Ports?: Record<string, unknown> | null;
    Networks?: Record<string, {
      IPAddress?: string;
      GlobalIPv6Address?: string;
      NetworkID?: string;
    }>;
  };
}

export interface CodexProjectEgressRuntimeInput {
  context: ProjectSandboxExecutionContext;
  /**
   * Remove only the predecessor context's protected state after its immutable
   * actor/project runtime inventory has been proven absent.
   */
  retirePreviousManagedState(context: ProjectSandboxExecutionContext): void;
  prepareManagedState(proxyEnvironment: Readonly<Record<string, string>>): {
    authPath: string;
    profilePath: string;
  };
  egress?: ProjectEgressPlaneConfig;
}

export interface CodexProjectEgressRuntimeHandle {
  containerId: string;
  containerName: string;
  runtimeFingerprint: string;
  egressPolicyFingerprint: string;
  proxyAddress: string;
  proxyEnvironment: Readonly<Record<string, string>>;
  startedAt: string;
}

export interface CodexProjectEgressRuntimeDependencies {
  executor: ProjectEgressCommandExecutor;
  buildEgressConfig(context: ProjectSandboxExecutionContext): ProjectEgressPlaneConfig;
  buildPreviousEgressConfig(
    context: ProjectSandboxExecutionContext,
    current: ProjectEgressPlaneConfig,
  ): ProjectEgressPlaneConfig;
  buildEgressSpec(config: ProjectEgressPlaneConfig): ProjectEgressPlaneSpec;
  ensureEgressPlane(
    config: ProjectEgressPlaneConfig,
    executor: ProjectEgressCommandExecutor,
  ): Promise<ProjectEgressPlaneHandle>;
  resolveInternalNetworkBinding(
    executor: ProjectEgressCommandExecutor,
    spec: ProjectEgressPlaneSpec,
  ): Promise<ProjectEgressInternalNetworkBinding | null>;
  constrainRuntime(input: {
    spec: ProjectEgressPlaneSpec;
    runtimeContainerId: string;
    runtimeContainerName: string;
    expectedRuntimeFingerprint: string;
    executor?: ProjectEgressCommandExecutor;
  }): Promise<void>;
  assertConfinementReady(): void;
}

export class CodexProjectEgressRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CodexProjectEgressRuntimeError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new CodexProjectEgressRuntimeError(code, message);
}

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function codexProjectPolicyFingerprint(
  context: ProjectSandboxExecutionContext,
  runtimePolicyVersion: string,
): string {
  return stableHash({
    version: runtimePolicyVersion,
    egressPolicyVersion: context.egressPolicyVersion,
    provider: 'CODEX',
    runtime: CODEX_PROJECT_RUNTIME,
    runtimeImageDigest: context.runtimeImageDigest,
    actorUserId: context.userId,
    workspaceOwnerId: context.workspaceOwnerId,
    projectId: context.projectId,
    projectName: context.projectName,
    canonicalRoot: context.canonicalRoot,
    rootDevice: context.rootDevice,
    rootInode: context.rootInode,
    rootBirthtimeNs: context.rootBirthtimeNs,
  });
}

/**
 * Reconstruct the one exact server-owned context issued by the immediately
 * preceding Codex policy. No caller-provided legacy fingerprint is trusted.
 */
export function buildPreviousCodexProjectExecutionContext(
  context: ProjectSandboxExecutionContext,
): ProjectSandboxExecutionContext {
  assertProjectContext(context);
  return Object.freeze({
    ...context,
    runtimePolicyVersion: CODEX_PROJECT_PREVIOUS_RUNTIME_POLICY_VERSION,
    policyFingerprint: codexProjectPolicyFingerprint(
      context,
      CODEX_PROJECT_PREVIOUS_RUNTIME_POLICY_VERSION,
    ),
  });
}

export function hashCodexProjectRuntimeLabelIdentity(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    fail('RUNTIME_LABEL_IDENTITY', 'Codex Project runtime label identity is invalid');
  }
  return stableHash(normalized);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requirePinnedImage(value: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) {
    fail('RUNTIME_IMAGE', 'Codex Project runtime image must be pinned by Docker sha256 image ID');
  }
  return normalized;
}

function assertProjectContext(
  context: ProjectSandboxExecutionContext,
  runtimePolicyVersion = CODEX_PROJECT_RUNTIME_POLICY_VERSION,
): void {
  assertExecutionContextBinding(context, context.userId, 'PROJECT_SANDBOX');
  if (context.runtimePolicyVersion !== runtimePolicyVersion) {
    fail('RUNTIME_POLICY', 'Codex Project runtime policy version is not qualified');
  }
  if (context.egressPolicyVersion !== PROJECT_EGRESS_POLICY_VERSION) {
    fail('EGRESS_POLICY', 'Codex Project egress policy version is not qualified');
  }
  requirePinnedImage(context.runtimeImageDigest);
  if (!/^[a-f0-9]{64}$/i.test(context.policyFingerprint)) {
    fail('POLICY_FINGERPRINT', 'Codex Project policy fingerprint is invalid');
  }
  const root = attestProjectRoot(context.canonicalRoot);
  if (
    root.canonicalRoot !== context.canonicalRoot
    || root.rootDevice !== context.rootDevice
    || root.rootInode !== context.rootInode
    || root.rootBirthtimeNs !== context.rootBirthtimeNs
  ) {
    fail('PROJECT_ROOT_IDENTITY', 'Codex Project root no longer matches its immutable identity');
  }
}

function assertEgressIdentity(
  context: ProjectSandboxExecutionContext,
  egress: ProjectEgressPlaneConfig,
): void {
  if (
    egress.identity.actorId !== context.userId
    || egress.identity.projectId !== context.projectId
    || String(egress.identity.provider || '').toUpperCase() !== 'CODEX'
  ) {
    fail('EGRESS_IDENTITY', 'Codex Project egress identity did not match the execution context');
  }
}

function pathContains(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertManagedStateFile(
  filePath: string,
  projectRoot: string,
  label: string,
): string {
  const resolved = path.resolve(String(filePath || ''));
  if (pathContains(projectRoot, resolved)) {
    fail('MANAGED_STATE_LOCATION', `${label} cannot be stored inside the Project`);
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync.native(resolved) !== resolved) {
    fail('MANAGED_STATE_FILE', `${label} must be a canonical regular file`);
  }
  if (stat.uid !== PROJECT_RUNTIME_UID || stat.gid !== PROJECT_RUNTIME_GID || (stat.mode & 0o777) !== 0o400) {
    fail('MANAGED_STATE_MODE', `${label} ownership or mode did not match the confined runtime`);
  }
  return resolved;
}

function expectedProxyEnvironment(spec: ProjectEgressPlaneSpec, proxyAddress: string): Readonly<Record<string, string>> {
  if (!net.isIPv4(proxyAddress)) {
    fail('PROXY_ADDRESS', 'Codex Project requires an attested IPv4 address for its egress proxy');
  }
  const proxyUrl = `http://portal:${encodeURIComponent(spec.token)}@${proxyAddress}:${PROXY_PORT}`;
  return Object.freeze({
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
  });
}

function assertEgressHandle(
  spec: ProjectEgressPlaneSpec,
  handle: ProjectEgressPlaneHandle,
): void {
  if (
    handle.policyVersion !== PROJECT_EGRESS_POLICY_VERSION
    || handle.policyFingerprint !== spec.policyFingerprint
    || handle.internalNetworkName !== spec.internalNetworkName
    || !/^[a-f0-9]{64}$/.test(String(handle.internalNetworkId || '').toLowerCase())
    || handle.publicNetworkName !== spec.publicNetworkName
    || handle.proxyContainerName !== spec.proxyContainerName
  ) {
    fail('EGRESS_ATTESTATION', 'Codex Project egress plane did not match its desired policy');
  }
  const expectedUrl = `http://portal:${encodeURIComponent(spec.token)}@${spec.proxyAlias}:${spec.proxyPort}`;
  const expectedEnvironment = {
    HTTP_PROXY: expectedUrl,
    HTTPS_PROXY: expectedUrl,
    http_proxy: expectedUrl,
    https_proxy: expectedUrl,
    NO_PROXY: '',
    no_proxy: '',
  };
  if (handle.proxyUrl !== expectedUrl || !valuesEqual(handle.proxyEnvironment, expectedEnvironment)) {
    fail('EGRESS_PROXY', 'Codex Project egress proxy environment did not match');
  }
}

function dockerInspectOne(output: string, label: string): DockerContainerInspect | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail('DOCKER_INSPECT_JSON', `${label} inspection returned invalid JSON`);
  }
  if (!Array.isArray(parsed)) fail('DOCKER_INSPECT_SHAPE', `${label} inspection returned an invalid shape`);
  if (parsed.length === 0) return null;
  if (parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== 'object') {
    fail('DOCKER_INSPECT_SHAPE', `${label} inspection returned an invalid shape`);
  }
  return parsed[0] as DockerContainerInspect;
}

async function inspectContainer(
  executor: ProjectEgressCommandExecutor,
  name: string,
): Promise<DockerContainerInspect | null> {
  const result = await executor.run('docker', ['container', 'inspect', name], { allowExitCodes: [0, 1] });
  if (result.exitCode === 1) return null;
  return dockerInspectOne(result.stdout, 'Codex Project runtime');
}

function isDockerContainerNotFound(result: ProjectEgressCommandResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return text.includes('no such object')
    || text.includes('no such container')
    || (text.includes('container') && text.includes('not found'))
    || (text.includes('object') && text.includes('not found'));
}

async function strictInspectContainer(
  executor: ProjectEgressCommandExecutor,
  reference: string,
): Promise<DockerContainerInspect | null> {
  const result = await executor.run(
    'docker',
    ['container', 'inspect', reference],
    { allowExitCodes: [0, 1] },
  );
  if (result.exitCode === 1) {
    if (isDockerContainerNotFound(result)) return null;
    fail('RUNTIME_INSPECT_FAILED', 'Codex Project runtime inspection failed without proving absence');
  }
  return dockerInspectOne(result.stdout, 'Codex Project runtime');
}

async function proxyInternalAddress(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
): Promise<string> {
  const result = await executor.run('docker', ['container', 'inspect', spec.proxyContainerName]);
  const inspect = dockerInspectOne(result.stdout, 'Codex Project proxy');
  const address = String(inspect?.NetworkSettings?.Networks?.[spec.internalNetworkName]?.IPAddress || '');
  if (!net.isIPv4(address)) fail('PROXY_ADDRESS', 'Codex Project proxy has no attested internal IPv4 address');
  return address;
}

function environmentMap(values: string[] | null | undefined): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const entry of values || []) {
    const separator = entry.indexOf('=');
    if (separator < 1) fail('RUNTIME_ENVIRONMENT', 'Codex Project runtime environment is malformed');
    const key = entry.slice(0, separator);
    const bucket = result.get(key) || [];
    bucket.push(entry.slice(separator + 1));
    result.set(key, bucket);
  }
  return result;
}

function hasNoNewPrivileges(values: string[] | null | undefined): boolean {
  return Boolean(values?.some((value) => (
    value.replace(/[^a-z0-9]/gi, '').toLowerCase() === 'nonewprivilegestrue'
  )));
}

function hasAllCapabilityDrop(values: string[] | null | undefined): boolean {
  return values?.length === 1 && values[0].toUpperCase() === 'ALL';
}

function assertExactMounts(
  inspect: DockerContainerInspect,
  projectRoot: string,
): void {
  const mounts = (inspect.Mounts || []).map((mount) => ({
    type: mount.Type,
    source: mount.Source ? path.resolve(mount.Source) : '',
    destination: mount.Destination,
    rw: mount.RW,
    propagation: mount.Propagation || 'rprivate',
  }));
  if (!valuesEqual(mounts, [{
    type: 'bind',
    source: projectRoot,
    destination: CODEX_PROJECT_CONTAINER_ROOT,
    rw: true,
    propagation: 'rprivate',
  }])) {
    fail('RUNTIME_MOUNTS', 'Codex Project runtime must have exactly one writable Project bind');
  }
  const binds = inspect.HostConfig?.Binds || [];
  if (binds.length !== 1 || !binds[0].startsWith(`${projectRoot}:${CODEX_PROJECT_CONTAINER_ROOT}:rw`)) {
    fail('RUNTIME_BINDS', 'Codex Project runtime bind configuration did not match');
  }
  if ((inspect.HostConfig?.Mounts?.length || 0) > 0) {
    fail('RUNTIME_MOUNTS', 'Codex Project runtime contains an undeclared Docker mount');
  }
}

export interface CodexProjectRuntimePlan {
  containerName: string;
  runtimeFingerprint: string;
  runtimeImage: string;
  projectRoot: string;
  expectedEnvironment: Readonly<Record<string, string>>;
  expectedLabels: Readonly<Record<string, string>>;
  internalNetworkId: string | null;
  networkMode: string;
  createArgs: readonly string[];
}

type CodexRuntimeFingerprintGeneration =
  | 'CURRENT'
  | 'SHARED_V1_CURRENT'
  | 'SHARED_V1_NO_PROXY_TOKEN'
  | 'LEGACY_PRE_CONFINEMENT';
type CodexRuntimeConfinementGeneration = 'CODEX_V1' | 'SHARED_V1' | 'LEGACY_PRE_CONFINEMENT';

function buildCodexRuntimeFingerprint(input: {
  context: ProjectSandboxExecutionContext;
  spec: ProjectEgressPlaneSpec;
  runtimeImage: string;
  projectRoot: string;
  generation: CodexRuntimeFingerprintGeneration;
  tokenHash?: string;
}): string {
  const egressPolicyFingerprint = input.generation === 'LEGACY_PRE_CONFINEMENT'
    ? derivePreConfinementProjectEgressPolicyFingerprint(input.spec)
    : input.spec.policyFingerprint;
  const common = {
    provider: 'CODEX',
    actorId: input.context.userId,
    projectId: input.context.projectId,
    workspaceOwnerId: input.context.workspaceOwnerId,
    policyFingerprint: input.context.policyFingerprint,
    runtimePolicyVersion: input.context.runtimePolicyVersion,
    egressPolicyVersion: input.context.egressPolicyVersion,
    egressPolicyFingerprint,
  };
  if (input.generation === 'CURRENT') {
    return stableHash({
      ...common,
      egressProxyCredentialHash: input.tokenHash || input.spec.tokenHash,
      runtimeImage: input.runtimeImage,
      projectRoot: input.projectRoot,
      user: CODEX_PROJECT_CONTAINER_USER,
      confinementSecurityOptions: codexProjectRuntimeSecurityOptionValues(),
    });
  }
  if (input.generation === 'SHARED_V1_CURRENT') {
    return stableHash({
      ...common,
      egressProxyCredentialHash: input.tokenHash || input.spec.tokenHash,
      runtimeImage: input.runtimeImage,
      projectRoot: input.projectRoot,
      user: CODEX_PROJECT_CONTAINER_USER,
      confinementSecurityOptions: projectRuntimeSecurityOptionValues(),
    });
  }
  if (input.generation === 'SHARED_V1_NO_PROXY_TOKEN') {
    return stableHash({
      ...common,
      runtimeImage: input.runtimeImage,
      projectRoot: input.projectRoot,
      user: CODEX_PROJECT_CONTAINER_USER,
      confinementSecurityOptions: projectRuntimeSecurityOptionValues(),
    });
  }
  return stableHash({
    ...common,
    runtimeImage: input.runtimeImage,
    projectRoot: input.projectRoot,
    user: CODEX_PROJECT_CONTAINER_USER,
  });
}

function buildCodexProjectRuntimePlanForPolicy(input: {
  context: ProjectSandboxExecutionContext;
  spec: ProjectEgressPlaneSpec;
  proxyAddress: string;
  internalNetworkId?: string;
  useHistoricalNetworkMode?: boolean;
}, runtimePolicyVersion: string): CodexProjectRuntimePlan {
  assertProjectContext(input.context, runtimePolicyVersion);
  const runtimeImage = requirePinnedImage(input.context.runtimeImageDigest);
  const projectRoot = path.resolve(input.context.canonicalRoot);
  const expectedEnvironment = Object.freeze({
    HOME: CODEX_PROJECT_CONTAINER_HOME,
    CODEX_HOME: CODEX_PROJECT_CONTAINER_CODEX_HOME,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    ...expectedProxyEnvironment(input.spec, input.proxyAddress),
  });
  // Docker cannot update an existing container's proxy environment. Keep the
  // credential itself out of labels/names, but rotate the immutable runtime
  // generation whenever its server-owned token rotates.
  const runtimeFingerprint = buildCodexRuntimeFingerprint({
    context: input.context,
    spec: input.spec,
    runtimeImage,
    projectRoot,
    generation: 'CURRENT',
  });
  const containerName = `p4cx-${runtimeFingerprint.slice(0, 24)}`;
  const internalNetworkId = input.internalNetworkId
    ? String(input.internalNetworkId).toLowerCase()
    : null;
  if (internalNetworkId && !/^[a-f0-9]{64}$/.test(internalNetworkId)) {
    fail('RUNTIME_NETWORK', 'Codex Project internal network ID is invalid');
  }
  const networkMode = internalNetworkId && !input.useHistoricalNetworkMode
    ? internalNetworkId
    : input.spec.internalNetworkName;
  const labels = {
    [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: runtimeFingerprint,
    [RUNTIME_POLICY_LABEL]: input.context.runtimePolicyVersion,
    [CODEX_PROJECT_RUNTIME_ACTOR_LABEL]: hashCodexProjectRuntimeLabelIdentity(input.context.userId),
    [CODEX_PROJECT_RUNTIME_IDENTITY_LABEL]: hashCodexProjectRuntimeLabelIdentity(input.context.projectId),
    [RUNTIME_EGRESS_LABEL]: input.spec.policyFingerprint,
  };
  const createArgs: string[] = ['container', 'create', '--name', containerName];
  for (const [key, value] of Object.entries(labels)) createArgs.push('--label', `${key}=${value}`);
  createArgs.push(
    '--network', networkMode,
    '--user', CODEX_PROJECT_CONTAINER_USER,
    '--workdir', CODEX_PROJECT_CONTAINER_ROOT,
    '--read-only',
    '--cap-drop', 'ALL',
    ...codexProjectRuntimeSecurityOptArgs(),
    '--pids-limit', String(CONTAINER_PIDS_LIMIT),
    '--memory', String(CONTAINER_MEMORY_BYTES),
    '--memory-swap', String(CONTAINER_MEMORY_BYTES),
    '--cpus', '2',
    '--ulimit', 'nofile=1024:1024',
    '--ulimit', 'nproc=256:256',
    '--restart', 'no',
    // Keep an actual subreaper at PID 1 so an interrupted docker-exec wrapper
    // cannot strand exited Codex descendants in the persistent container.
    '--init',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=67108864',
    '--tmpfs', '/run:rw,noexec,nosuid,nodev,size=16777216',
    '--tmpfs', `${CODEX_PROJECT_CONTAINER_CODEX_HOME}:rw,noexec,nosuid,nodev,size=67108864,uid=${PROJECT_RUNTIME_UID},gid=${PROJECT_RUNTIME_GID},mode=0700`,
    '--volume', `${projectRoot}:${CODEX_PROJECT_CONTAINER_ROOT}:rw,rprivate`,
  );
  for (const [key, value] of Object.entries(expectedEnvironment)) createArgs.push('--env', `${key}=${value}`);
  createArgs.push('--entrypoint', 'node', runtimeImage, '-e', IDLE_SCRIPT);
  return Object.freeze({
    containerName,
    runtimeFingerprint,
    runtimeImage,
    projectRoot,
    expectedEnvironment,
    expectedLabels: Object.freeze(labels),
    internalNetworkId,
    networkMode,
    createArgs: Object.freeze(createArgs),
  });
}

export function buildCodexProjectRuntimePlan(input: {
  context: ProjectSandboxExecutionContext;
  spec: ProjectEgressPlaneSpec;
  proxyAddress: string;
  internalNetworkId?: string;
  useHistoricalNetworkMode?: boolean;
}): CodexProjectRuntimePlan {
  return buildCodexProjectRuntimePlanForPolicy(input, CODEX_PROJECT_RUNTIME_POLICY_VERSION);
}

function buildPreviousCodexProjectRuntimePlan(input: {
  context: ProjectSandboxExecutionContext;
  spec: ProjectEgressPlaneSpec;
  proxyAddress: string;
  internalNetworkId?: string;
  useHistoricalNetworkMode?: boolean;
}): CodexProjectRuntimePlan {
  return buildCodexProjectRuntimePlanForPolicy(
    input,
    CODEX_PROJECT_PREVIOUS_RUNTIME_POLICY_VERSION,
  );
}

function attestCodexProjectRuntimeContainerForGeneration(input: {
  inspect: DockerContainerInspect;
  plan: CodexProjectRuntimePlan;
  spec: ProjectEgressPlaneSpec;
  requireRunning: boolean;
  confinementGeneration: CodexRuntimeConfinementGeneration;
}): { containerId: string; pid: number; startedAt: string } {
  const { inspect, plan, spec } = input;
  const containerId = String(inspect.Id || '');
  if (!/^[a-f0-9]{64}$/i.test(containerId)) fail('RUNTIME_ID', 'Codex Project runtime ID is invalid');
  if (String(inspect.Name || '').replace(/^\//, '') !== plan.containerName) {
    fail('RUNTIME_NAME', 'Codex Project runtime name did not match');
  }
  if (String(inspect.Image || '').toLowerCase() !== plan.runtimeImage
    || String(inspect.Config?.Image || '').toLowerCase() !== plan.runtimeImage) {
    fail('RUNTIME_IMAGE', 'Codex Project runtime image digest did not match');
  }
  if (inspect.Config?.User !== CODEX_PROJECT_CONTAINER_USER
    || inspect.Config?.WorkingDir !== CODEX_PROJECT_CONTAINER_ROOT
    || !valuesEqual(inspect.Config?.Entrypoint || [], ['node'])
    || !valuesEqual(inspect.Config?.Cmd || [], ['-e', IDLE_SCRIPT])) {
    fail('RUNTIME_PROCESS', 'Codex Project runtime process identity did not match');
  }
  const labels = inspect.Config?.Labels || {};
  for (const [key, value] of Object.entries(plan.expectedLabels)) {
    if (labels[key] !== value) fail('RUNTIME_LABELS', 'Codex Project runtime labels did not match');
  }
  const host = inspect.HostConfig || {};
  try {
    if (input.confinementGeneration === 'LEGACY_PRE_CONFINEMENT') {
      attestPreConfinementProjectRuntimeSecurityOptions({
        securityOpt: host.SecurityOpt,
        appArmorProfile: inspect.AppArmorProfile,
      });
    } else if (input.confinementGeneration === 'SHARED_V1') {
      attestProjectRuntimeSecurityOptions({
        securityOpt: host.SecurityOpt,
        appArmorProfile: inspect.AppArmorProfile,
      });
    } else {
      attestCodexProjectRuntimeSecurityOptions({
        securityOpt: host.SecurityOpt,
        appArmorProfile: inspect.AppArmorProfile,
      });
    }
  } catch {
    fail('RUNTIME_CONFINEMENT', 'Codex Project runtime confinement profiles did not match');
  }
  if (
    host.Init !== true
    || host.ReadonlyRootfs !== true
    || !hasAllCapabilityDrop(host.CapDrop)
    || (host.CapAdd?.length || 0) > 0
    || !hasNoNewPrivileges(host.SecurityOpt)
    || host.Privileged
    || String(host.PidMode || '') !== ''
    || !['', 'private'].includes(String(host.IpcMode || ''))
    || String(host.UTSMode || '') !== ''
    || String(host.UsernsMode || '') !== ''
    || !['', 'private'].includes(String(host.CgroupnsMode || ''))
    || host.RestartPolicy?.Name !== 'no'
    || host.AutoRemove
    || host.OomKillDisable
  ) {
    fail('RUNTIME_HARDENING', 'Codex Project runtime hardening did not match');
  }
  if (
    host.PidsLimit !== CONTAINER_PIDS_LIMIT
    || host.Memory !== CONTAINER_MEMORY_BYTES
    || host.MemorySwap !== CONTAINER_MEMORY_BYTES
    || host.NanoCpus !== CONTAINER_NANO_CPUS
  ) {
    fail('RUNTIME_RESOURCES', 'Codex Project runtime resource limits did not match');
  }
  const expectedUlimits = [
    { name: 'nofile', soft: 1024, hard: 1024 },
    { name: 'nproc', soft: 256, hard: 256 },
  ];
  const actualUlimits = (Array.isArray(host.Ulimits) ? host.Ulimits : [])
    .map((entry: { Name?: string; Soft?: number; Hard?: number }) => ({
      name: String(entry.Name || ''),
      soft: Number(entry.Soft),
      hard: Number(entry.Hard),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!valuesEqual(actualUlimits, expectedUlimits)) {
    fail('RUNTIME_ULIMITS', 'Codex Project runtime ulimits did not match');
  }
  const tmpfs = host.Tmpfs || {};
  const expectedTmpfs = new Map<string, { required: string[]; sizes: string[] }>([
    ['/tmp', { required: ['rw', 'noexec', 'nosuid', 'nodev'], sizes: ['size=67108864', 'size=64m'] }],
    ['/run', { required: ['rw', 'noexec', 'nosuid', 'nodev'], sizes: ['size=16777216', 'size=16m'] }],
    [CODEX_PROJECT_CONTAINER_CODEX_HOME, {
      required: ['rw', 'noexec', 'nosuid', 'nodev', `uid=${PROJECT_RUNTIME_UID}`, `gid=${PROJECT_RUNTIME_GID}`, 'mode=0700'],
      sizes: ['size=67108864', 'size=64m'],
    }],
  ]);
  if (Object.keys(tmpfs).length !== expectedTmpfs.size) fail('RUNTIME_TMPFS', 'Codex Project tmpfs policy did not match');
  for (const [target, expected] of expectedTmpfs) {
    const flags = String(tmpfs[target] || '').split(',').map((flag) => flag.trim().toLowerCase()).sort();
    if (!expected.sizes.some((size) => valuesEqual(flags, [...expected.required, size].sort()))) {
      fail('RUNTIME_TMPFS', 'Codex Project tmpfs policy did not match');
    }
  }
  if (
    (host.Devices?.length || 0) > 0
    || (host.DeviceRequests?.length || 0) > 0
    || (host.DeviceCgroupRules?.length || 0) > 0
    || (host.Dns?.length || 0) > 0
    || (host.DnsOptions?.length || 0) > 0
    || (host.DnsSearch?.length || 0) > 0
    || (host.ExtraHosts?.length || 0) > 0
    || (host.Links?.length || 0) > 0
    || (host.VolumesFrom?.length || 0) > 0
    || host.PublishAllPorts
    || Object.keys(host.PortBindings || {}).length > 0
    || Object.keys(inspect.NetworkSettings?.Ports || {}).length > 0
    || Object.keys(inspect.Config?.ExposedPorts || {}).length > 0
    || Object.keys(inspect.Config?.Volumes || {}).length > 0
  ) {
    fail('RUNTIME_EXPOSURE', 'Codex Project runtime exposes an undeclared host resource');
  }
  assertExactMounts(inspect, plan.projectRoot);
  const networks = Object.keys(inspect.NetworkSettings?.Networks || {});
  const attachmentId = String(
    inspect.NetworkSettings?.Networks?.[spec.internalNetworkName]?.NetworkID || '',
  ).toLowerCase();
  const idPrimary = /^[a-f0-9]{64}$/.test(plan.networkMode);
  const stoppedIdPrimary = idPrimary
    && input.requireRunning === false
    && attachmentId === ''
    && String(host.NetworkMode || '').toLowerCase() === plan.networkMode;
  if (networks.length !== 1
    || networks[0] !== spec.internalNetworkName
    || !plan.internalNetworkId
    || String(host.NetworkMode || '').toLowerCase() !== plan.networkMode.toLowerCase()
    || (attachmentId !== plan.internalNetworkId && !stoppedIdPrimary)) {
    fail('RUNTIME_NETWORK', 'Codex Project runtime network attachment did not match');
  }
  const environment = environmentMap(inspect.Config?.Env);
  for (const [key, value] of Object.entries(plan.expectedEnvironment)) {
    const actual = environment.get(key);
    if (!actual || actual.length !== 1 || actual[0] !== value) {
      fail('RUNTIME_ENVIRONMENT', `Codex Project runtime environment ${key} did not match`);
    }
  }
  for (const key of EXPECTED_PROXY_KEYS) {
    if ((environment.get(key)?.length || 0) !== 1) {
      fail('RUNTIME_PROXY_ENVIRONMENT', 'Codex Project runtime proxy environment is ambiguous');
    }
  }
  for (const key of environment.keys()) {
    if (/(?:^|_)(?:AWS|AZURE|GCP|GOOGLE|OPENAI|ANTHROPIC|XAI|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)(?:_|$)/i.test(key)) {
      fail('RUNTIME_SECRET_ENVIRONMENT', 'Codex Project runtime inherited a host credential variable');
    }
  }
  if (inspect.State?.Running !== input.requireRunning) {
    fail('RUNTIME_STATE', `Codex Project runtime must be ${input.requireRunning ? 'running' : 'stopped'}`);
  }
  const pid = Number(inspect.State?.Pid || 0);
  const startedAt = String(inspect.State?.StartedAt || '');
  if (input.requireRunning && (!Number.isSafeInteger(pid) || pid < 2 || !startedAt)) {
    fail('RUNTIME_PROCESS', 'Codex Project runtime process is unavailable');
  }
  return { containerId, pid, startedAt };
}

export function attestCodexProjectRuntimeContainer(input: {
  inspect: DockerContainerInspect;
  plan: CodexProjectRuntimePlan;
  spec: ProjectEgressPlaneSpec;
  requireRunning: boolean;
}): { containerId: string; pid: number; startedAt: string } {
  return attestCodexProjectRuntimeContainerForGeneration({
    ...input,
    confinementGeneration: 'CODEX_V1',
  });
}

function normalizeFirewallStatements(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function attestCodexProjectNamespaceFirewall(input: {
  proxyAddress: string;
  ipv4: string;
  ipv6: string;
}): void {
  const expectedIpv4 = [
    '-P INPUT DROP',
    '-P FORWARD DROP',
    '-P OUTPUT DROP',
    `-A INPUT -s ${input.proxyAddress}/32 -p tcp -m tcp --sport ${PROXY_PORT} -m conntrack --ctstate ESTABLISHED -j ACCEPT`,
    `-A OUTPUT -d ${input.proxyAddress}/32 -p tcp -m tcp --dport ${PROXY_PORT} -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT`,
  ];
  const expectedIpv6 = ['-P INPUT DROP', '-P FORWARD DROP', '-P OUTPUT DROP'];
  if (!valuesEqual(normalizeFirewallStatements(input.ipv4), expectedIpv4)) {
    fail('RUNTIME_IPV4_FIREWALL', 'Codex Project IPv4 namespace firewall did not match exactly');
  }
  if (!valuesEqual(normalizeFirewallStatements(input.ipv6), expectedIpv6)) {
    fail('RUNTIME_IPV6_FIREWALL', 'Codex Project IPv6 namespace firewall did not match exactly');
  }
}

async function namespaceCommand(
  executor: ProjectEgressCommandExecutor,
  pid: number,
  command: string,
  args: readonly string[],
): Promise<ProjectEgressCommandResult> {
  return executor.run('/usr/bin/nsenter', [
    '--target', String(pid), '--net', '--', command, ...args,
  ]);
}

async function installAndAttestNamespaceFirewall(
  executor: ProjectEgressCommandExecutor,
  pid: number,
  proxyAddress: string,
): Promise<void> {
  for (const tool of ['iptables', 'ip6tables']) {
    for (const chain of ['INPUT', 'FORWARD', 'OUTPUT']) {
      await namespaceCommand(executor, pid, tool, ['-w', '-F', chain]);
      await namespaceCommand(executor, pid, tool, ['-w', '-P', chain, 'DROP']);
    }
  }
  await namespaceCommand(executor, pid, 'iptables', [
    '-w', '-A', 'INPUT', '-s', `${proxyAddress}/32`, '-p', 'tcp', '--sport', String(PROXY_PORT),
    '-m', 'conntrack', '--ctstate', 'ESTABLISHED', '-j', 'ACCEPT',
  ]);
  await namespaceCommand(executor, pid, 'iptables', [
    '-w', '-A', 'OUTPUT', '-d', `${proxyAddress}/32`, '-p', 'tcp', '--dport', String(PROXY_PORT),
    '-m', 'conntrack', '--ctstate', 'NEW,ESTABLISHED', '-j', 'ACCEPT',
  ]);
  const ipv4 = await namespaceCommand(executor, pid, 'iptables', ['-w', '-S']);
  const ipv6 = await namespaceCommand(executor, pid, 'ip6tables', ['-w', '-S']);
  attestCodexProjectNamespaceFirewall({ proxyAddress, ipv4: ipv4.stdout, ipv6: ipv6.stdout });
}

function managedFileHash(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function injectAndAttestManagedState(input: {
  executor: ProjectEgressCommandExecutor;
  containerId: string;
  authPath: string;
  profilePath: string;
}): Promise<void> {
  const files = [
    { source: input.authPath, target: `${CODEX_PROJECT_CONTAINER_CODEX_HOME}/auth.json` },
    { source: input.profilePath, target: `${CODEX_PROJECT_CONTAINER_CODEX_HOME}/${path.basename(input.profilePath)}` },
  ];
  const expected = files.map((file) => ({
    path: file.target,
    hash: managedFileHash(file.source),
  }));
  const script = `
const crypto = require('crypto');
const fs = require('fs');
const expected = ${JSON.stringify(expected)};
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!Array.isArray(payload) || payload.length !== expected.length) process.exit(41);
for (let index = 0; index < expected.length; index += 1) {
  const data = Buffer.from(String(payload[index] || ''), 'base64');
  if (crypto.createHash('sha256').update(data).digest('hex') !== expected[index].hash) process.exit(42);
  fs.writeFileSync(expected[index].path, data, { flag: 'wx', mode: 0o400 });
  fs.chmodSync(expected[index].path, 0o400);
}
const actual = expected.map((entry) => {
  const stat = fs.lstatSync(entry.path);
  return {
    path: entry.path,
    hash: crypto.createHash('sha256').update(fs.readFileSync(entry.path)).digest('hex'),
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o777,
    file: stat.isFile(),
    symlink: stat.isSymbolicLink(),
  };
});
process.stdout.write(JSON.stringify(actual));
`;
  const result = await input.executor.run('docker', [
    'container', 'exec', '--interactive', '--user', CODEX_PROJECT_CONTAINER_USER,
    input.containerId, 'node', '-e', script,
  ], {
    input: JSON.stringify(files.map((file) => fs.readFileSync(file.source).toString('base64'))),
  });
  let actual: any;
  try {
    actual = JSON.parse(result.stdout);
  } catch {
    fail('RUNTIME_STATE_JSON', 'Codex Project managed state attestation returned invalid JSON');
  }
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    fail('RUNTIME_STATE', 'Codex Project managed state attestation was incomplete');
  }
  for (let index = 0; index < expected.length; index += 1) {
    const entry = actual[index];
    if (
      entry?.path !== expected[index].path
      || entry?.hash !== expected[index].hash
      || entry?.uid !== PROJECT_RUNTIME_UID
      || entry?.gid !== PROJECT_RUNTIME_GID
      || entry?.mode !== 0o400
      || entry?.file !== true
      || entry?.symlink !== false
    ) {
      fail('RUNTIME_STATE', 'Codex Project managed state did not match its protected source');
    }
  }
}

class CodexProjectCommandExecutor implements ProjectEgressCommandExecutor {
  async run(
    command: string,
    args: readonly string[],
    options: { allowExitCodes?: readonly number[]; input?: string } = {},
  ): Promise<ProjectEgressCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          HOME: '/nonexistent',
          DOCKER_CONFIG: '/nonexistent',
          DOCKER_HOST: 'unix:///var/run/docker.sock',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
        },
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (error?: Error, result?: ProjectEgressCommandResult) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          finish(new Error('Codex Project host command output exceeded the safety limit'));
          return;
        }
        target.push(Buffer.from(chunk));
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.once('error', () => finish(new Error('Codex Project host command failed to start')));
      child.once('close', (code) => {
        const exitCode = code ?? 1;
        if (!(options.allowExitCodes || [0]).includes(exitCode)) {
          finish(new Error(`Codex Project host command failed with exit code ${exitCode}`));
          return;
        }
        finish(undefined, {
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode,
        });
      });
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }
}

export const codexProjectEgressCommandExecutor: ProjectEgressCommandExecutor = new CodexProjectCommandExecutor();

const defaultDependencies: CodexProjectEgressRuntimeDependencies = {
  executor: codexProjectEgressCommandExecutor,
  buildEgressConfig: (context) => buildProjectEgressConfig({ context, provider: 'CODEX' }),
  buildPreviousEgressConfig: (context, current) => buildProjectEgressConfig({
    context,
    provider: 'CODEX',
    proxyImageId: current.proxyImage,
  }),
  buildEgressSpec: buildProjectEgressPlaneSpec,
  ensureEgressPlane: ensureProjectEgressPlane,
  resolveInternalNetworkBinding: resolveRecognizedProjectEgressInternalNetworkBinding,
  constrainRuntime: constrainProjectRuntimeToEgressPlane,
  assertConfinementReady: () => { assertCodexProjectRuntimeConfinementReadyForExecution(); },
};

async function listExactIdentityRuntimeIds(input: {
  executor: ProjectEgressCommandExecutor;
  plan: CodexProjectRuntimePlan;
}): Promise<string[]> {
  const labels = input.plan.expectedLabels;
  const result = await input.executor.run('docker', [
    'container', 'ls', '--all', '--no-trunc',
    '--filter', `label=${CODEX_PROJECT_RUNTIME_ACTOR_LABEL}=${labels[CODEX_PROJECT_RUNTIME_ACTOR_LABEL]}`,
    '--filter', `label=${CODEX_PROJECT_RUNTIME_IDENTITY_LABEL}=${labels[CODEX_PROJECT_RUNTIME_IDENTITY_LABEL]}`,
    '--format', '{{.ID}}',
  ]);
  const ids = result.stdout.split(/\r?\n/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (ids.length > 8 || new Set(ids).size !== ids.length
    || ids.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    fail('STALE_RUNTIME_LIST', 'Docker returned an ambiguous Codex Project runtime inventory');
  }
  return ids;
}

function staleRuntimeAttestationPlan(input: {
  inspect: DockerContainerInspect;
  plan: CodexProjectRuntimePlan;
  context: ProjectSandboxExecutionContext;
  spec: ProjectEgressPlaneSpec;
  previousPlan: CodexProjectRuntimePlan;
  previousContext: ProjectSandboxExecutionContext;
  previousSpec: ProjectEgressPlaneSpec;
}): {
  plan: CodexProjectRuntimePlan;
  spec: ProjectEgressPlaneSpec;
  confinementGeneration: CodexRuntimeConfinementGeneration;
} {
  const labels = input.inspect.Config?.Labels || {};
  const runtimeFingerprint = String(labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] || '').toLowerCase();
  const runtimePolicy = String(labels[RUNTIME_POLICY_LABEL] || '');
  const staleEgressFingerprint = String(labels[RUNTIME_EGRESS_LABEL] || '').toLowerCase();
  const containerName = String(input.inspect.Name || '').replace(/^\//, '');
  if (!/^[a-f0-9]{64}$/.test(runtimeFingerprint)
    || containerName !== `p4cx-${runtimeFingerprint.slice(0, 24)}`) {
    fail('STALE_RUNTIME_GENERATION', 'Managed Codex Project stale runtime identity is invalid');
  }
  if (
    runtimePolicy !== CODEX_PROJECT_RUNTIME_POLICY_VERSION
    && runtimePolicy !== CODEX_PROJECT_PREVIOUS_RUNTIME_POLICY_VERSION
  ) {
    fail('STALE_RUNTIME_POLICY', 'Managed Codex Project stale runtime policy label did not match');
  }
  const predecessor = runtimePolicy === CODEX_PROJECT_PREVIOUS_RUNTIME_POLICY_VERSION;
  const candidateSpec = predecessor ? input.previousSpec : input.spec;
  const candidatePlan = predecessor ? input.previousPlan : input.plan;
  // A stale runtime keeps the pinned image its own generation was created
  // from, so reconstruction must run against the inspected image rather than
  // the current plan's image: a routine sandbox-image rebuild would otherwise
  // wedge retirement forever. The fingerprint candidates below still commit
  // to this exact image (directly and through the context policy
  // fingerprint), so a runtime whose image was swapped after creation cannot
  // reconstruct any recognized generation and stays fail-closed.
  const inspectedImage = String(input.inspect.Image || '').toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(inspectedImage)
    || String(input.inspect.Config?.Image || '').toLowerCase() !== inspectedImage) {
    fail('STALE_RUNTIME_IMAGE', 'Managed Codex Project stale runtime image did not match');
  }
  const baseContext = predecessor ? input.previousContext : input.context;
  const candidateContext = Object.freeze({
    ...baseContext,
    runtimeImageDigest: inspectedImage,
    policyFingerprint: codexProjectPolicyFingerprint(
      { ...baseContext, runtimeImageDigest: inspectedImage },
      baseContext.runtimePolicyVersion,
    ),
  });

  const environment = environmentMap(input.inspect.Config?.Env);
  const requiredProxyEnvironment: Record<string, string> = Object.fromEntries(EXPECTED_PROXY_KEYS.map((key) => {
    const values = environment.get(key);
    if (!values || values.length !== 1) {
      fail('STALE_RUNTIME_PROXY', 'Managed Codex Project stale runtime proxy environment is ambiguous');
    }
    return [key, values[0]];
  }));
  const proxyUrls = [
    requiredProxyEnvironment.HTTP_PROXY,
    requiredProxyEnvironment.HTTPS_PROXY,
    requiredProxyEnvironment.http_proxy,
    requiredProxyEnvironment.https_proxy,
  ];
  if (new Set(proxyUrls).size !== 1
    || requiredProxyEnvironment.NO_PROXY !== ''
    || requiredProxyEnvironment.no_proxy !== '') {
    fail('STALE_RUNTIME_PROXY', 'Managed Codex Project stale runtime proxy environment is invalid');
  }
  let parsedProxy: URL;
  try {
    parsedProxy = new URL(proxyUrls[0]);
  } catch {
    fail('STALE_RUNTIME_PROXY', 'Managed Codex Project stale runtime proxy URL is invalid');
  }
  if (parsedProxy.protocol !== 'http:'
    || parsedProxy.username !== 'portal'
    || !/^[A-Za-z0-9_-]{43,256}$/.test(parsedProxy.password)
    || !net.isIPv4(parsedProxy.hostname)
    || parsedProxy.port !== String(PROXY_PORT)
    || parsedProxy.pathname !== '/'
    || parsedProxy.search
    || parsedProxy.hash) {
    fail('STALE_RUNTIME_PROXY', 'Managed Codex Project stale runtime proxy URL is invalid');
  }
  const inspectedTokenHash = stableHash(parsedProxy.password);
  if (predecessor && parsedProxy.password !== candidateSpec.token) {
    fail(
      'STALE_RUNTIME_PROXY',
      'Managed Codex Project predecessor runtime proxy credential did not match',
    );
  }
  const candidates: Array<{
    runtimeFingerprint: string;
    egressPolicyFingerprint: string;
    confinementGeneration: CodexRuntimeConfinementGeneration;
  }> = predecessor
    ? [
      {
        runtimeFingerprint: buildCodexRuntimeFingerprint({
          context: candidateContext,
          spec: candidateSpec,
          runtimeImage: inspectedImage,
          projectRoot: candidatePlan.projectRoot,
          generation: 'LEGACY_PRE_CONFINEMENT',
        }),
        egressPolicyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(candidateSpec),
        confinementGeneration: 'LEGACY_PRE_CONFINEMENT',
      },
      {
        runtimeFingerprint: buildCodexRuntimeFingerprint({
          context: candidateContext,
          spec: candidateSpec,
          runtimeImage: inspectedImage,
          projectRoot: candidatePlan.projectRoot,
          generation: 'SHARED_V1_NO_PROXY_TOKEN',
        }),
        egressPolicyFingerprint: candidateSpec.policyFingerprint,
        confinementGeneration: 'SHARED_V1',
      },
      {
        runtimeFingerprint: buildCodexRuntimeFingerprint({
          context: candidateContext,
          spec: candidateSpec,
          runtimeImage: inspectedImage,
          projectRoot: candidatePlan.projectRoot,
          generation: 'SHARED_V1_CURRENT',
          tokenHash: inspectedTokenHash,
        }),
        egressPolicyFingerprint: candidateSpec.policyFingerprint,
        confinementGeneration: 'SHARED_V1',
      },
    ]
    : [
      {
        runtimeFingerprint: buildCodexRuntimeFingerprint({
          context: candidateContext,
          spec: candidateSpec,
          runtimeImage: inspectedImage,
          projectRoot: candidatePlan.projectRoot,
          generation: 'CURRENT',
          tokenHash: inspectedTokenHash,
        }),
        egressPolicyFingerprint: candidateSpec.policyFingerprint,
        confinementGeneration: 'CODEX_V1',
      },
    ];
  const candidate = candidates.find((entry) => (
    runtimeFingerprint === entry.runtimeFingerprint
    && staleEgressFingerprint === entry.egressPolicyFingerprint
  ));
  if (!candidate) {
    fail(
      'STALE_RUNTIME_GENERATION',
      'Managed Codex Project runtime is not an exact recognized prior generation',
    );
  }
  const fixedKeys = ['HOME', 'CODEX_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'NO_COLOR'] as const;
  const expectedEnvironment: Record<string, string> = {};
  for (const key of fixedKeys) {
    const values = environment.get(key);
    if (!values || values.length !== 1 || values[0] !== candidatePlan.expectedEnvironment[key]) {
      fail('STALE_RUNTIME_ENVIRONMENT', 'Managed Codex Project stale runtime base environment is invalid');
    }
    expectedEnvironment[key] = values[0];
  }
  Object.assign(expectedEnvironment, requiredProxyEnvironment);
  const inspectedNetworkMode = String(input.inspect.HostConfig?.NetworkMode || '').toLowerCase();
  const networkMode = inspectedNetworkMode === candidateSpec.internalNetworkName
    ? candidateSpec.internalNetworkName
    : inspectedNetworkMode === candidatePlan.networkMode
      && /^[a-f0-9]{64}$/.test(candidatePlan.networkMode)
      ? candidatePlan.networkMode
      : fail('STALE_RUNTIME_NETWORK', 'Managed Codex Project stale runtime network mode is not a recognized generation');
  const stalePlan = Object.freeze({
    ...candidatePlan,
    containerName,
    runtimeFingerprint,
    runtimeImage: inspectedImage,
    expectedEnvironment: Object.freeze(expectedEnvironment),
    expectedLabels: Object.freeze({
      ...candidatePlan.expectedLabels,
      [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: runtimeFingerprint,
      [RUNTIME_POLICY_LABEL]: candidateContext.runtimePolicyVersion,
      [RUNTIME_EGRESS_LABEL]: candidate.egressPolicyFingerprint,
    }),
    networkMode,
    createArgs: Object.freeze([]),
  });
  return Object.freeze({
    plan: stalePlan,
    spec: candidateSpec,
    confinementGeneration: candidate.confinementGeneration,
  });
}

function attestInventoryRuntime(input: {
  inspect: DockerContainerInspect;
  plan: CodexProjectRuntimePlan;
  context: ProjectSandboxExecutionContext;
  spec: ProjectEgressPlaneSpec;
  previousPlan: CodexProjectRuntimePlan;
  previousContext: ProjectSandboxExecutionContext;
  previousSpec: ProjectEgressPlaneSpec;
  requireRunning: boolean;
}): {
  containerId: string;
  current: boolean;
  attestationPlan: ReturnType<typeof staleRuntimeAttestationPlan>;
} {
  const attestationPlan = staleRuntimeAttestationPlan(input);
  const runtimeFingerprint = String(
    input.inspect.Config?.Labels?.[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] || '',
  ).toLowerCase();
  const containerName = String(input.inspect.Name || '').replace(/^\//, '');
  const currentFingerprint = runtimeFingerprint === input.plan.runtimeFingerprint;
  const currentName = containerName === input.plan.containerName;
  if (currentFingerprint !== currentName) {
    fail('STALE_RUNTIME_IDENTITY', 'Codex Project runtime current identity is internally inconsistent');
  }
  const attested = attestCodexProjectRuntimeContainerForGeneration({
    inspect: input.inspect,
    plan: attestationPlan.plan,
    spec: attestationPlan.spec,
    requireRunning: input.requireRunning,
    confinementGeneration: attestationPlan.confinementGeneration,
  });
  return {
    containerId: attested.containerId.toLowerCase(),
    current: currentFingerprint && attestationPlan.plan.networkMode === input.plan.networkMode,
    attestationPlan,
  };
}

async function retireExactManagedStaleRuntimes(input: {
  executor: ProjectEgressCommandExecutor;
  plan: CodexProjectRuntimePlan;
  context: ProjectSandboxExecutionContext;
  spec: ProjectEgressPlaneSpec;
  previousPlan: CodexProjectRuntimePlan;
  previousContext: ProjectSandboxExecutionContext;
  previousSpec: ProjectEgressPlaneSpec;
}): Promise<void> {
  const initial = await listExactIdentityRuntimeIds(input);
  const attestedInventory: Array<{
    containerId: string;
    current: boolean;
    attestationPlan: ReturnType<typeof staleRuntimeAttestationPlan>;
  }> = [];
  for (const discoveredId of initial) {
    const before = await strictInspectContainer(input.executor, discoveredId);
    if (!before) {
      fail('STALE_RUNTIME_RACE', 'Managed Codex Project runtime disappeared before attestation');
    }
    const attested = attestInventoryRuntime({
      ...input,
      inspect: before,
      requireRunning: before.State?.Running === true,
    });
    if (attested.containerId !== discoveredId) {
      fail('STALE_RUNTIME_RACE', 'Managed Codex Project runtime immutable identity changed');
    }
    attestedInventory.push(attested);
  }
  if (attestedInventory.filter((entry) => entry.current).length > 1) {
    fail('RUNTIME_IDENTITY_INVENTORY', 'Codex Project runtime identity has multiple current claimants');
  }
  if (!valuesEqual(await listExactIdentityRuntimeIds(input), initial)) {
    fail('STALE_RUNTIME_RACE', 'Managed Codex Project runtime inventory changed before retirement');
  }
  for (const candidate of attestedInventory.filter((entry) => !entry.current)) {
    const before = await strictInspectContainer(input.executor, candidate.containerId);
    if (!before) fail('STALE_RUNTIME_RACE', 'Managed Codex Project stale runtime disappeared before retirement');
    const reattested = attestCodexProjectRuntimeContainerForGeneration({
      inspect: before,
      plan: candidate.attestationPlan.plan,
      spec: candidate.attestationPlan.spec,
      requireRunning: before.State?.Running === true,
      confinementGeneration: candidate.attestationPlan.confinementGeneration,
    });
    if (reattested.containerId.toLowerCase() !== candidate.containerId) {
      fail('STALE_RUNTIME_RACE', 'Managed Codex Project stale runtime changed before retirement');
    }
    if (before.State?.Running === true) {
      await input.executor.run('docker', ['container', 'stop', '--time', '1', candidate.containerId]);
    }
    const stopped = await strictInspectContainer(input.executor, candidate.containerId);
    if (!stopped) fail('STALE_RUNTIME_RACE', 'Managed Codex Project stale runtime disappeared before removal');
    const stoppedAttestation = attestCodexProjectRuntimeContainerForGeneration({
      inspect: stopped,
      plan: candidate.attestationPlan.plan,
      spec: candidate.attestationPlan.spec,
      requireRunning: false,
      confinementGeneration: candidate.attestationPlan.confinementGeneration,
    });
    if (stoppedAttestation.containerId.toLowerCase() !== candidate.containerId) {
      fail('STALE_RUNTIME_RACE', 'Managed Codex Project stale runtime changed before removal');
    }
    await input.executor.run('docker', ['container', 'rm', candidate.containerId]);
    if (await strictInspectContainer(input.executor, candidate.containerId)) {
      fail('STALE_RUNTIME_REMOVE', 'Managed Codex Project stale runtime still exists after exact removal');
    }
  }
  const expectedCurrentIds = attestedInventory
    .filter((entry) => entry.current)
    .map((entry) => entry.containerId)
    .sort();
  const residualIds = await listExactIdentityRuntimeIds(input);
  if (!valuesEqual(residualIds, expectedCurrentIds)) {
    fail('STALE_RUNTIME_RESIDUAL', 'Managed Codex Project runtime inventory changed during retirement');
  }
  for (const residualId of residualIds) {
    const residual = await strictInspectContainer(input.executor, residualId);
    if (!residual) {
      fail('STALE_RUNTIME_RACE', 'Managed Codex Project runtime inventory changed during verification');
    }
    const attested = attestInventoryRuntime({
      ...input,
      inspect: residual,
      requireRunning: residual.State?.Running === true,
    });
    if (!attested.current || attested.containerId !== residualId) {
      fail('STALE_RUNTIME_RESIDUAL', 'Managed Codex Project stale runtime convergence did not reach an exact state');
    }
  }
}

const runtimeEnsureLocks = new Map<string, Promise<void>>();

async function withRuntimeEnsureLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = runtimeEnsureLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = prior.catch(() => undefined).then(() => current);
  runtimeEnsureLocks.set(key, queued);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (runtimeEnsureLocks.get(key) === queued) runtimeEnsureLocks.delete(key);
  }
}

async function reattestCurrentRuntimeByImmutableId(input: {
  executor: ProjectEgressCommandExecutor;
  containerId: string;
  plan: CodexProjectRuntimePlan;
  spec: ProjectEgressPlaneSpec;
  requireRunning: boolean;
}): Promise<{ containerId: string; pid: number; startedAt: string }> {
  const inspect = await strictInspectContainer(input.executor, input.containerId);
  if (!inspect) fail('RUNTIME_RACE', 'Codex Project runtime identity disappeared during convergence');
  const attested = attestCodexProjectRuntimeContainer({
    inspect,
    plan: input.plan,
    spec: input.spec,
    requireRunning: input.requireRunning,
  });
  if (attested.containerId.toLowerCase() !== input.containerId.toLowerCase()) {
    fail('RUNTIME_RACE', 'Codex Project runtime immutable identity changed during convergence');
  }
  return attested;
}

export async function attestOnlyCodexProjectIdentityRuntime(input: {
  executor: ProjectEgressCommandExecutor;
  containerId: string;
  plan: CodexProjectRuntimePlan;
  spec: ProjectEgressPlaneSpec;
}): Promise<void> {
  const expectedContainerId = input.containerId.toLowerCase();
  const ids = await listExactIdentityRuntimeIds({
    executor: input.executor,
    plan: input.plan,
  });
  if (ids.length !== 1 || ids[0] !== expectedContainerId) {
    fail(
      'RUNTIME_IDENTITY_INVENTORY',
      'Codex Project runtime identity has an unexpected concurrent generation',
    );
  }
  const named = await strictInspectContainer(input.executor, input.plan.containerName);
  if (!named) fail('RUNTIME_IDENTITY_INVENTORY', 'Codex Project runtime name disappeared');
  const namedAttestation = attestCodexProjectRuntimeContainer({
    inspect: named,
    plan: input.plan,
    spec: input.spec,
    requireRunning: true,
  });
  if (namedAttestation.containerId.toLowerCase() !== expectedContainerId) {
    fail('RUNTIME_IDENTITY_INVENTORY', 'Codex Project runtime name resolved to another immutable identity');
  }
  await reattestCurrentRuntimeByImmutableId({
    ...input,
    requireRunning: true,
  });
  if (!valuesEqual(
    await listExactIdentityRuntimeIds({ executor: input.executor, plan: input.plan }),
    ids,
  )) {
    fail('RUNTIME_IDENTITY_INVENTORY', 'Codex Project runtime identity changed during attestation');
  }
}

async function stopExactCurrentRuntimeAfterFailure(input: {
  executor: ProjectEgressCommandExecutor;
  containerId: string;
  plan: CodexProjectRuntimePlan;
  spec: ProjectEgressPlaneSpec;
}): Promise<void> {
  try {
    const inspect = await strictInspectContainer(input.executor, input.containerId);
    if (!inspect || inspect.State?.Running !== true) return;
    const attested = attestCodexProjectRuntimeContainer({
      inspect,
      plan: input.plan,
      spec: input.spec,
      requireRunning: true,
    });
    if (attested.containerId.toLowerCase() !== input.containerId.toLowerCase()) return;
    await input.executor.run(
      'docker',
      ['container', 'stop', '--time', '1', input.containerId],
      { allowExitCodes: [0, 1] },
    );
    await reattestCurrentRuntimeByImmutableId({
      ...input,
      requireRunning: false,
    });
  } catch {
    // Never fall back to the deterministic name: a replacement may own it.
  }
}

function assertCodexProjectRuntimeStopTarget(
  inspect: DockerContainerInspect,
  context: ProjectSandboxExecutionContext,
): string {
  const containerId = String(inspect.Id || '').toLowerCase();
  const labels = inspect.Config?.Labels || {};
  if (
    !/^[a-f0-9]{64}$/.test(containerId)
    || !/^\/?p4cx-[a-f0-9]{24}$/.test(String(inspect.Name || ''))
    || labels[RUNTIME_POLICY_LABEL] !== CODEX_PROJECT_RUNTIME_POLICY_VERSION
    || labels[CODEX_PROJECT_RUNTIME_ACTOR_LABEL] !== hashCodexProjectRuntimeLabelIdentity(context.userId)
    || labels[CODEX_PROJECT_RUNTIME_IDENTITY_LABEL] !== hashCodexProjectRuntimeLabelIdentity(context.projectId)
    || inspect.Config?.User !== CODEX_PROJECT_CONTAINER_USER
    || inspect.Config?.WorkingDir !== CODEX_PROJECT_CONTAINER_ROOT
    || !valuesEqual(inspect.Config?.Entrypoint || [], ['node'])
    || !valuesEqual(inspect.Config?.Cmd || [], ['-e', IDLE_SCRIPT])
  ) {
    fail('RUNTIME_STOP_IDENTITY', 'Refusing to stop an unattested Codex Project runtime');
  }
  assertExactMounts(inspect, context.canonicalRoot);
  return containerId;
}

/**
 * Stop every runtime bound to one immutable actor/project identity. This is
 * the recovery boundary used when Portal no longer has the in-memory abort
 * closure for an orphaned Codex run (for example after a process restart).
 * Label discovery is followed by full-ID and exact-project-mount attestation,
 * so no other actor, Project, or provider can be targeted.
 */
export async function stopCodexProjectRuntimesForContext(
  context: ProjectSandboxExecutionContext,
  executor: ProjectEgressCommandExecutor = codexProjectEgressCommandExecutor,
): Promise<readonly string[]> {
  assertProjectContext(context);
  const actorLabel = hashCodexProjectRuntimeLabelIdentity(context.userId);
  const projectLabel = hashCodexProjectRuntimeLabelIdentity(context.projectId);
  const listed = await executor.run('docker', [
    'container', 'ls', '-a', '--no-trunc',
    '--filter', `label=${RUNTIME_POLICY_LABEL}=${CODEX_PROJECT_RUNTIME_POLICY_VERSION}`,
    '--filter', `label=${CODEX_PROJECT_RUNTIME_ACTOR_LABEL}=${actorLabel}`,
    '--filter', `label=${CODEX_PROJECT_RUNTIME_IDENTITY_LABEL}=${projectLabel}`,
    '--format', '{{.ID}}',
  ]);
  const containerIds = listed.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (containerIds.length > 8 || new Set(containerIds).size !== containerIds.length) {
    fail('RUNTIME_STOP_DISCOVERY', 'Codex Project runtime discovery was ambiguous');
  }
  if (containerIds.some((entry) => !/^[a-f0-9]{64}$/i.test(entry))) {
    fail('RUNTIME_STOP_DISCOVERY', 'Codex Project runtime discovery returned an unsafe identity');
  }

  const stopped: string[] = [];
  for (const discoveredId of containerIds) {
    const inspect = await inspectContainer(executor, discoveredId);
    if (!inspect) continue;
    const containerId = assertCodexProjectRuntimeStopTarget(inspect, context);
    if (containerId !== discoveredId.toLowerCase()) {
      fail('RUNTIME_STOP_IDENTITY', 'Codex Project runtime changed during stop attestation');
    }
    if (inspect.State?.Running) {
      await executor.run(
        'docker',
        ['container', 'stop', '--time', '3', containerId],
        { allowExitCodes: [0, 1] },
      );
    }
    const after = await inspectContainer(executor, containerId);
    if (after) {
      const afterId = assertCodexProjectRuntimeStopTarget(after, context);
      if (afterId !== containerId || after.State?.Running) {
        fail('RUNTIME_STOP_UNCONFIRMED', 'Codex Project runtime remained active after stop');
      }
    }
    stopped.push(containerId);
  }
  assertProjectContext(context);
  return Object.freeze(stopped);
}

export async function ensureCodexProjectEgressRuntime(
  input: CodexProjectEgressRuntimeInput,
  overrides: Partial<CodexProjectEgressRuntimeDependencies> = {},
): Promise<CodexProjectEgressRuntimeHandle> {
  assertProjectContext(input.context);
  const dependencies = { ...defaultDependencies, ...overrides };
  dependencies.assertConfinementReady();
  const egress = input.egress || dependencies.buildEgressConfig(input.context);
  assertEgressIdentity(input.context, egress);
  const spec = dependencies.buildEgressSpec(egress);
  const previousContext = buildPreviousCodexProjectExecutionContext(input.context);
  const previousEgress = dependencies.buildPreviousEgressConfig(previousContext, egress);
  assertEgressIdentity(previousContext, previousEgress);
  const previousSpec = dependencies.buildEgressSpec(previousEgress);
  if (
    previousEgress.proxyImage !== egress.proxyImage
    || previousEgress.token === egress.token
    || previousSpec.policyFingerprint !== spec.policyFingerprint
    || previousSpec.identityFingerprint !== spec.identityFingerprint
    || previousSpec.internalNetworkName !== spec.internalNetworkName
    || previousSpec.publicNetworkName !== spec.publicNetworkName
    || previousSpec.proxyContainerName !== spec.proxyContainerName
  ) {
    fail(
      'PREVIOUS_EGRESS',
      'Codex Project predecessor egress context did not preserve the shared plane identity',
    );
  }
  const runtime = await withRuntimeEnsureLock(spec.identityFingerprint, async () => {
    const preflightNetworkBinding = await dependencies.resolveInternalNetworkBinding(
      dependencies.executor,
      spec,
    );
    // The desired generation is independent of the proxy's runtime address.
    // Retire exact prior generations before stale-network convergence sees
    // their attachment; project files and Codex state live outside them.
    const preflightPlan = buildCodexProjectRuntimePlan({
      context: input.context,
      spec,
      proxyAddress: '127.0.0.1',
      ...(preflightNetworkBinding
        ? {
          internalNetworkId: preflightNetworkBinding.networkId,
          useHistoricalNetworkMode: preflightNetworkBinding.generation === 'LEGACY_PRE_CONFINEMENT',
        }
        : {}),
    });
    const previousPreflightPlan = buildPreviousCodexProjectRuntimePlan({
      context: previousContext,
      spec: previousSpec,
      proxyAddress: '127.0.0.1',
      ...(preflightNetworkBinding
        ? {
          internalNetworkId: preflightNetworkBinding.networkId,
          useHistoricalNetworkMode: preflightNetworkBinding.generation === 'LEGACY_PRE_CONFINEMENT',
        }
        : {}),
    });
    await retireExactManagedStaleRuntimes({
      executor: dependencies.executor,
      plan: preflightPlan,
      context: input.context,
      spec,
      previousPlan: previousPreflightPlan,
      previousContext,
      previousSpec,
    });
    // The callback receives only the server-reconstructed v2 context and runs
    // after immutable-ID retirement plus residual inventory verification.
    input.retirePreviousManagedState(previousContext);

    const egressHandle = await dependencies.ensureEgressPlane(egress, dependencies.executor);
    assertEgressHandle(spec, egressHandle);
    const postPlaneBinding = await dependencies.resolveInternalNetworkBinding(
      dependencies.executor,
      spec,
    );
    if (!postPlaneBinding
      || postPlaneBinding.generation !== 'CURRENT'
      || egressHandle.internalNetworkId !== postPlaneBinding.networkId
      || (preflightNetworkBinding?.generation === 'CURRENT'
        && postPlaneBinding.networkId !== preflightNetworkBinding.networkId)) {
      fail('EGRESS_ATTESTATION', 'Codex Project internal network identity changed during convergence');
    }
    const postPlanePlan = buildCodexProjectRuntimePlan({
      context: input.context,
      spec,
      proxyAddress: '127.0.0.1',
      internalNetworkId: postPlaneBinding.networkId,
    });
    const previousPostPlanePlan = buildPreviousCodexProjectRuntimePlan({
      context: previousContext,
      spec: previousSpec,
      proxyAddress: '127.0.0.1',
      internalNetworkId: postPlaneBinding.networkId,
    });
    // A second inventory closes the in-process post-retirement/pre-plane
    // window. A cross-process attachment during plane convergence is rejected
    // by the plane's own stale-member guard; one appearing immediately after
    // convergence is fully attested and retired here before current creation.
    await retireExactManagedStaleRuntimes({
      executor: dependencies.executor,
      plan: postPlanePlan,
      context: input.context,
      spec,
      previousPlan: previousPostPlanePlan,
      previousContext,
      previousSpec,
    });
    const proxyAddress = await proxyInternalAddress(dependencies.executor, spec);
    const runtimeProxyEnvironment = expectedProxyEnvironment(spec, proxyAddress);
    const plan = buildCodexProjectRuntimePlan({
      context: input.context,
      spec,
      proxyAddress,
      internalNetworkId: postPlaneBinding.networkId,
    });
    if (plan.runtimeFingerprint !== preflightPlan.runtimeFingerprint
      || plan.containerName !== preflightPlan.containerName
      || plan.networkMode !== postPlanePlan.networkMode) {
      fail('RUNTIME_GENERATION', 'Codex Project runtime generation changed during egress convergence');
    }
    const managedState = input.prepareManagedState(runtimeProxyEnvironment);
    const authPath = assertManagedStateFile(managedState.authPath, plan.projectRoot, 'Codex authentication state');
    const profilePath = assertManagedStateFile(managedState.profilePath, plan.projectRoot, 'Codex permission profile');
    let existing = await strictInspectContainer(dependencies.executor, plan.containerName);
    if (!existing) {
      const createResult = await dependencies.executor.run('docker', plan.createArgs);
      const createdId = createResult.stdout.trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(createdId)) {
        fail('RUNTIME_CREATE_ID', 'Docker returned an invalid Codex Project runtime creation ID');
      }
      existing = await strictInspectContainer(dependencies.executor, createdId);
      if (!existing) fail('RUNTIME_CREATE', 'Codex Project runtime could not be inspected after creation');
      const created = attestCodexProjectRuntimeContainer({
        inspect: existing,
        plan,
        spec,
        requireRunning: false,
      });
      if (created.containerId.toLowerCase() !== createdId) {
        fail('RUNTIME_CREATE_ID', 'Codex Project runtime creation identity changed before attestation');
      }
    }
    if (typeof existing.State?.Running !== 'boolean') {
      fail('RUNTIME_STATE', 'Codex Project runtime state is ambiguous');
    }
    const initialAttestation = attestCodexProjectRuntimeContainer({
      inspect: existing,
      plan,
      spec,
      requireRunning: existing.State.Running,
    });
    const initialContainerId = initialAttestation.containerId.toLowerCase();
    if (!valuesEqual(
      await listExactIdentityRuntimeIds({ executor: dependencies.executor, plan }),
      [initialContainerId],
    )) {
      fail('RUNTIME_IDENTITY_INVENTORY', 'Codex Project runtime identity was ambiguous before convergence');
    }

    let currentContainerId: string | null = null;
    try {
      let stopped: { containerId: string; pid: number; startedAt: string };
      if (existing.State?.Running === true) {
        const running = attestCodexProjectRuntimeContainer({
          inspect: existing,
          plan,
          spec,
          requireRunning: true,
        });
        currentContainerId = running.containerId.toLowerCase();
        await dependencies.executor.run(
          'docker',
          ['container', 'stop', '--time', '1', currentContainerId],
        );
        stopped = await reattestCurrentRuntimeByImmutableId({
          executor: dependencies.executor,
          containerId: currentContainerId,
          plan,
          spec,
          requireRunning: false,
        });
      } else {
        stopped = attestCodexProjectRuntimeContainer({
          inspect: existing,
          plan,
          spec,
          requireRunning: false,
        });
        currentContainerId = stopped.containerId.toLowerCase();
        stopped = await reattestCurrentRuntimeByImmutableId({
          executor: dependencies.executor,
          containerId: currentContainerId,
          plan,
          spec,
          requireRunning: false,
        });
      }
      await dependencies.constrainRuntime({
        spec,
        runtimeContainerId: stopped.containerId,
        runtimeContainerName: plan.containerName,
        expectedRuntimeFingerprint: plan.runtimeFingerprint,
        executor: dependencies.executor,
      });
      await reattestCurrentRuntimeByImmutableId({
        executor: dependencies.executor,
        containerId: currentContainerId,
        plan,
        spec,
        requireRunning: false,
      });
      await dependencies.executor.run('docker', ['container', 'start', currentContainerId]);
      const attested = await reattestCurrentRuntimeByImmutableId({
        executor: dependencies.executor,
        containerId: currentContainerId,
        plan,
        spec,
        requireRunning: true,
      });
      await installAndAttestNamespaceFirewall(
        dependencies.executor,
        attested.pid,
        proxyAddress,
      );
      await injectAndAttestManagedState({
        executor: dependencies.executor,
        containerId: attested.containerId,
        authPath,
        profilePath,
      });
      const final = await reattestCurrentRuntimeByImmutableId({
        executor: dependencies.executor,
        containerId: currentContainerId,
        plan,
        spec,
        requireRunning: true,
      });
      await attestOnlyCodexProjectIdentityRuntime({
        executor: dependencies.executor,
        containerId: final.containerId,
        plan,
        spec,
      });
      assertProjectContext(input.context);
      return Object.freeze({
        containerId: final.containerId,
        containerName: plan.containerName,
        runtimeFingerprint: plan.runtimeFingerprint,
        egressPolicyFingerprint: spec.policyFingerprint,
        proxyAddress,
        proxyEnvironment: runtimeProxyEnvironment,
        startedAt: final.startedAt,
      });
    } catch (error) {
      if (currentContainerId) {
        await stopExactCurrentRuntimeAfterFailure({
          executor: dependencies.executor,
          containerId: currentContainerId,
          plan,
          spec,
        });
      }
      throw error;
    }
  });
  assertProjectContext(input.context);
  return runtime;
}

export function buildCodexProjectDockerExecArgs(input: {
  runtime: CodexProjectEgressRuntimeHandle;
  command: string;
  args: readonly string[];
}): string[] {
  if (!/^[a-f0-9]{64}$/i.test(input.runtime.containerId)) {
    fail('RUNTIME_ID', 'Codex Project runtime ID is invalid at invocation boundary');
  }
  const args = [
    'container', 'exec',
    '--user', CODEX_PROJECT_CONTAINER_USER,
    '--workdir', CODEX_PROJECT_CONTAINER_ROOT,
  ];
  for (const [key, value] of Object.entries(input.runtime.proxyEnvironment)) {
    args.push('--env', `${key}=${value}`);
  }
  args.push(input.runtime.containerId, input.command, ...input.args);
  return args;
}

export function codexProjectDockerHostEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/nonexistent',
    DOCKER_CONFIG: '/nonexistent',
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
}

export const __codexProjectEgressRuntimeTest = {
  IDLE_SCRIPT,
  constants: {
    CONTAINER_MEMORY_BYTES,
    CONTAINER_NANO_CPUS,
    CONTAINER_PIDS_LIMIT,
    RUNTIME_POLICY_LABEL,
    RUNTIME_EGRESS_LABEL,
  },
};
