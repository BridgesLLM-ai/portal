import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import type {
  AgentProviderName,
  ProjectSandboxExecutionContext,
} from '../../../AgentProvider.interface';
import { assertExecutionContextBinding } from '../../../executionScope';
import type { NativeCliInvocation } from '../types';
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
  assertProjectRuntimeConfinementReadyForExecution,
  attestPreConfinementProjectRuntimeSecurityOptions,
  attestProjectRuntimeSecurityOptions,
  projectRuntimeSecurityOptArgs,
  projectRuntimeSecurityOptionValues,
} from '../../../../services/projectRuntimeConfinement';
import {
  __nativeCliProjectRunControlTest,
  abortExactNativeCliProjectRun,
  abortOrphanedExactNativeCliProjectRuns,
  buildExactNativeCliProjectInvocation,
} from './NativeCliProjectRunControl';

export type NativeCliProjectRuntimeProvider = Extract<AgentProviderName, 'CLAUDE_CODE' | 'GEMINI'>;

export const NATIVE_CLI_PROJECT_CONTAINER_USER = PROJECT_RUNTIME_USER;
export const NATIVE_CLI_PROJECT_CONTAINER_UID = PROJECT_RUNTIME_UID;
export const NATIVE_CLI_PROJECT_CONTAINER_GID = PROJECT_RUNTIME_GID;
export const NATIVE_CLI_PROJECT_CONTAINER_ROOT = '/workspace/project';
export const NATIVE_CLI_PROJECT_CONTAINER_HOME = '/home/project-agent';

const CONTAINER_MEMORY_BYTES = 1024 * 1024 * 1024;
const CONTAINER_NANO_CPUS = 2_000_000_000;
const CONTAINER_PIDS_LIMIT = 256;
const PROXY_PORT = 3128;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const RUNTIME_LABEL_PREFIX = 'com.bridgesllm.native-cli-project';
const RUNTIME_POLICY_LABEL = `${RUNTIME_LABEL_PREFIX}.policy`;
export const NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL = `${RUNTIME_LABEL_PREFIX}.provider`;
export const NATIVE_CLI_PROJECT_RUNTIME_ACTOR_LABEL = `${RUNTIME_LABEL_PREFIX}.actor`;
export const NATIVE_CLI_PROJECT_RUNTIME_IDENTITY_LABEL = `${RUNTIME_LABEL_PREFIX}.project`;
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

export interface NativeCliProjectRuntimeProfile {
  readonly provider: NativeCliProjectRuntimeProvider;
  readonly displayName: string;
  /** Kernel runtime descriptor string; must stay the registry's constant. */
  readonly runtime: string;
  readonly containerNamePrefix: string;
  readonly runtimePolicyVersion: string;
  readonly cliPath: string;
  readonly allowLoopback: boolean;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface NativeCliProjectManagedFile {
  /** Canonical, protected host-side staging file. */
  readonly sourcePath: string;
  /** Absolute path below the runtime's private HOME tmpfs. */
  readonly targetPath: string;
  readonly label: string;
}

export interface NativeCliProjectEgressRuntimeInput {
  readonly context: ProjectSandboxExecutionContext;
  readonly profile: NativeCliProjectRuntimeProfile;
  readonly prepareManagedState: (
    proxyEnvironment: Readonly<Record<string, string>>,
  ) => readonly NativeCliProjectManagedFile[];
  readonly egress?: ProjectEgressPlaneConfig;
}

export interface NativeCliProjectEgressRuntimeHandle {
  readonly provider: NativeCliProjectRuntimeProvider;
  readonly containerId: string;
  readonly containerName: string;
  readonly runtimeFingerprint: string;
  readonly egressPolicyFingerprint: string;
  readonly proxyAddress: string;
  readonly proxyEnvironment: Readonly<Record<string, string>>;
  readonly startedAt: string;
}

export interface NativeCliProjectEgressRuntimeDependencies {
  readonly executor: ProjectEgressCommandExecutor;
  readonly buildEgressConfig: (
    context: ProjectSandboxExecutionContext,
    provider: NativeCliProjectRuntimeProvider,
  ) => ProjectEgressPlaneConfig;
  readonly buildEgressSpec: (config: ProjectEgressPlaneConfig) => ProjectEgressPlaneSpec;
  readonly ensureEgressPlane: (
    config: ProjectEgressPlaneConfig,
    executor: ProjectEgressCommandExecutor,
  ) => Promise<ProjectEgressPlaneHandle>;
  readonly resolveInternalNetworkBinding: (
    executor: ProjectEgressCommandExecutor,
    spec: ProjectEgressPlaneSpec,
  ) => Promise<ProjectEgressInternalNetworkBinding | null>;
  readonly constrainRuntime: (input: {
    spec: ProjectEgressPlaneSpec;
    runtimeContainerId: string;
    runtimeContainerName: string;
    expectedRuntimeFingerprint: string;
    executor?: ProjectEgressCommandExecutor;
  }) => Promise<void>;
  readonly assertConfinementReady: () => void;
}

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
  State?: { Running?: boolean; Pid?: number; StartedAt?: string };
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

export interface NativeCliProjectRuntimePlan {
  readonly profile: NativeCliProjectRuntimeProfile;
  readonly containerName: string;
  readonly runtimeFingerprint: string;
  readonly runtimeImage: string;
  readonly projectRoot: string;
  readonly expectedEnvironment: Readonly<Record<string, string>>;
  readonly expectedLabels: Readonly<Record<string, string>>;
  readonly internalNetworkId: string | null;
  readonly networkMode: string;
  readonly createArgs: readonly string[];
}

export class NativeCliProjectEgressRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NativeCliProjectEgressRuntimeError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new NativeCliProjectEgressRuntimeError(code, message);
}

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function hashNativeCliProjectRuntimeLabelIdentity(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    fail('RUNTIME_LABEL_IDENTITY', 'Native CLI Project runtime label identity is invalid');
  }
  return stableHash(normalized);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requirePinnedImage(value: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) {
    fail('RUNTIME_IMAGE', 'Native CLI Project runtime image must be pinned by Docker sha256 image ID');
  }
  return normalized;
}

function assertProfile(profile: NativeCliProjectRuntimeProfile): void {
  if (!['CLAUDE_CODE', 'GEMINI'].includes(profile.provider)) {
    fail('RUNTIME_PROVIDER', 'Native CLI Project provider is unsupported');
  }
  if (!profile.displayName.trim() || !/^[a-z0-9]{2,8}$/.test(profile.containerNamePrefix)) {
    fail('RUNTIME_PROFILE', 'Native CLI Project runtime profile identity is invalid');
  }
  if (!/^portal-[a-z0-9-]+-project-sandbox-v[1-9][0-9]*$/.test(profile.runtimePolicyVersion)) {
    fail('RUNTIME_PROFILE', 'Native CLI Project runtime policy version is invalid');
  }
  if (!path.posix.isAbsolute(profile.cliPath) || profile.cliPath.includes('\u0000')) {
    fail('RUNTIME_PROFILE', 'Native CLI Project CLI path must be absolute');
  }
  for (const [key, value] of Object.entries(profile.environment || {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\u0000\r\n]/.test(value)) {
      fail('RUNTIME_PROFILE', 'Native CLI Project environment is invalid');
    }
    if (EXPECTED_PROXY_KEYS.includes(key) || key === 'HOME' || key === 'PWD') {
      fail('RUNTIME_PROFILE', 'Native CLI Project profile cannot override confinement environment');
    }
    if (/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/i.test(key)) {
      fail('RUNTIME_PROFILE', 'Native CLI Project profile cannot carry credentials in the environment');
    }
  }
}

function assertProjectContext(
  context: ProjectSandboxExecutionContext,
  profile: NativeCliProjectRuntimeProfile,
): void {
  assertProfile(profile);
  assertExecutionContextBinding(context, context.userId, 'PROJECT_SANDBOX');
  if (context.runtimePolicyVersion !== profile.runtimePolicyVersion) {
    fail('RUNTIME_POLICY', `${profile.displayName} Project runtime policy version is not qualified`);
  }
  if (context.egressPolicyVersion !== PROJECT_EGRESS_POLICY_VERSION) {
    fail('EGRESS_POLICY', `${profile.displayName} Project egress policy version is not qualified`);
  }
  requirePinnedImage(context.runtimeImageDigest);
  if (!/^[a-f0-9]{64}$/i.test(context.policyFingerprint)) {
    fail('POLICY_FINGERPRINT', `${profile.displayName} Project policy fingerprint is invalid`);
  }
  const root = attestProjectRoot(context.canonicalRoot);
  if (
    root.canonicalRoot !== context.canonicalRoot
    || root.rootDevice !== context.rootDevice
    || root.rootInode !== context.rootInode
    || root.rootBirthtimeNs !== context.rootBirthtimeNs
  ) {
    fail('PROJECT_ROOT_IDENTITY', `${profile.displayName} Project root no longer matches its immutable identity`);
  }
}

function assertEgressIdentity(
  context: ProjectSandboxExecutionContext,
  profile: NativeCliProjectRuntimeProfile,
  egress: ProjectEgressPlaneConfig,
): void {
  if (
    egress.identity.actorId !== context.userId
    || egress.identity.projectId !== context.projectId
    || String(egress.identity.provider || '').toUpperCase() !== profile.provider
  ) {
    fail('EGRESS_IDENTITY', `${profile.displayName} Project egress identity did not match the execution context`);
  }
}

function pathContains(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertManagedStateFiles(
  files: readonly NativeCliProjectManagedFile[],
  projectRoot: string,
): readonly NativeCliProjectManagedFile[] {
  if (files.length < 1 || files.length > 8) {
    fail('MANAGED_STATE_COUNT', 'Native CLI Project managed state file count is invalid');
  }
  const targets = new Set<string>();
  return Object.freeze(files.map((file) => {
    const sourcePath = path.resolve(String(file.sourcePath || ''));
    const targetPath = path.posix.normalize(String(file.targetPath || ''));
    if (pathContains(projectRoot, sourcePath)) {
      fail('MANAGED_STATE_LOCATION', `${file.label} cannot be stored inside the Project`);
    }
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync.native(sourcePath) !== sourcePath) {
      fail('MANAGED_STATE_FILE', `${file.label} must be a canonical regular file`);
    }
    if (
      stat.uid !== NATIVE_CLI_PROJECT_CONTAINER_UID
      || stat.gid !== NATIVE_CLI_PROJECT_CONTAINER_GID
      || (stat.mode & 0o777) !== 0o400
    ) {
      fail('MANAGED_STATE_MODE', `${file.label} ownership or mode did not match the confined runtime`);
    }
    if (
      targetPath === NATIVE_CLI_PROJECT_CONTAINER_HOME
      || !targetPath.startsWith(`${NATIVE_CLI_PROJECT_CONTAINER_HOME}/`)
      || targetPath.includes('\u0000')
    ) {
      fail('MANAGED_STATE_TARGET', `${file.label} target must remain inside the private runtime home`);
    }
    if (targets.has(targetPath)) fail('MANAGED_STATE_TARGET', 'Native CLI Project managed state targets must be unique');
    targets.add(targetPath);
    return Object.freeze({ sourcePath, targetPath, label: String(file.label || 'managed state') });
  }));
}

function expectedProxyEnvironment(
  spec: ProjectEgressPlaneSpec,
  proxyAddress: string,
): Readonly<Record<string, string>> {
  if (!net.isIPv4(proxyAddress)) {
    fail('PROXY_ADDRESS', 'Native CLI Project requires an attested IPv4 address for its egress proxy');
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

function assertEgressHandle(spec: ProjectEgressPlaneSpec, handle: ProjectEgressPlaneHandle): void {
  if (
    handle.policyVersion !== PROJECT_EGRESS_POLICY_VERSION
    || handle.policyFingerprint !== spec.policyFingerprint
    || handle.internalNetworkName !== spec.internalNetworkName
    || !/^[a-f0-9]{64}$/.test(String(handle.internalNetworkId || '').toLowerCase())
    || handle.publicNetworkName !== spec.publicNetworkName
    || handle.proxyContainerName !== spec.proxyContainerName
  ) {
    fail('EGRESS_ATTESTATION', 'Native CLI Project egress plane did not match its desired policy');
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
    fail('EGRESS_PROXY', 'Native CLI Project egress proxy environment did not match');
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
    fail('RUNTIME_INSPECT_FAILED', 'Native CLI Project runtime inspection failed without proving absence');
  }
  return dockerInspectOne(result.stdout, 'Native CLI Project runtime');
}

async function proxyInternalAddress(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
): Promise<string> {
  const result = await executor.run('docker', ['container', 'inspect', spec.proxyContainerName]);
  const inspect = dockerInspectOne(result.stdout, 'Native CLI Project proxy');
  const address = String(inspect?.NetworkSettings?.Networks?.[spec.internalNetworkName]?.IPAddress || '');
  if (!net.isIPv4(address)) fail('PROXY_ADDRESS', 'Native CLI Project proxy has no attested internal IPv4 address');
  return address;
}

function environmentMap(values: string[] | null | undefined): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const entry of values || []) {
    const separator = entry.indexOf('=');
    if (separator < 1) fail('RUNTIME_ENVIRONMENT', 'Native CLI Project runtime environment is malformed');
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

function assertExactMounts(inspect: DockerContainerInspect, projectRoot: string): void {
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
    destination: NATIVE_CLI_PROJECT_CONTAINER_ROOT,
    rw: true,
    propagation: 'rprivate',
  }])) {
    fail('RUNTIME_MOUNTS', 'Native CLI Project runtime must have exactly one writable Project bind');
  }
  const binds = inspect.HostConfig?.Binds || [];
  if (
    binds.length !== 1
    || !binds[0].startsWith(`${projectRoot}:${NATIVE_CLI_PROJECT_CONTAINER_ROOT}:rw`)
  ) {
    fail('RUNTIME_BINDS', 'Native CLI Project runtime bind configuration did not match');
  }
  if ((inspect.HostConfig?.Mounts?.length || 0) > 0) {
    fail('RUNTIME_MOUNTS', 'Native CLI Project runtime contains an undeclared Docker mount');
  }
}

export function buildNativeCliProjectRuntimePlan(input: {
  context: ProjectSandboxExecutionContext;
  profile: NativeCliProjectRuntimeProfile;
  spec: ProjectEgressPlaneSpec;
  proxyAddress: string;
  internalNetworkId?: string;
  useHistoricalNetworkMode?: boolean;
}): NativeCliProjectRuntimePlan {
  assertProjectContext(input.context, input.profile);
  const runtimeImage = requirePinnedImage(input.context.runtimeImageDigest);
  const projectRoot = path.resolve(input.context.canonicalRoot);
  const expectedEnvironment = Object.freeze({
    HOME: NATIVE_CLI_PROJECT_CONTAINER_HOME,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    ...(input.profile.environment || {}),
    ...expectedProxyEnvironment(input.spec, input.proxyAddress),
  });
  const runtimeFingerprint = buildNativeCliRuntimeFingerprint({
    context: input.context,
    profile: input.profile,
    spec: input.spec,
    runtimeImage,
    projectRoot,
    generation: 'CURRENT',
  });
  const containerName = `${input.profile.containerNamePrefix}-${runtimeFingerprint.slice(0, 24)}`;
  const internalNetworkId = input.internalNetworkId
    ? String(input.internalNetworkId).toLowerCase()
    : null;
  if (internalNetworkId && !/^[a-f0-9]{64}$/.test(internalNetworkId)) {
    fail('RUNTIME_NETWORK', `${input.profile.displayName} Project internal network ID is invalid`);
  }
  const networkMode = internalNetworkId && !input.useHistoricalNetworkMode
    ? internalNetworkId
    : input.spec.internalNetworkName;
  const labels = {
    [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: runtimeFingerprint,
    [RUNTIME_POLICY_LABEL]: input.profile.runtimePolicyVersion,
    [NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL]: input.profile.provider,
    [NATIVE_CLI_PROJECT_RUNTIME_ACTOR_LABEL]: hashNativeCliProjectRuntimeLabelIdentity(input.context.userId),
    [NATIVE_CLI_PROJECT_RUNTIME_IDENTITY_LABEL]: hashNativeCliProjectRuntimeLabelIdentity(input.context.projectId),
    [RUNTIME_EGRESS_LABEL]: input.spec.policyFingerprint,
  };
  const createArgs: string[] = ['container', 'create', '--name', containerName];
  for (const [key, value] of Object.entries(labels)) createArgs.push('--label', `${key}=${value}`);
  createArgs.push(
    '--network', networkMode,
    '--user', NATIVE_CLI_PROJECT_CONTAINER_USER,
    '--workdir', NATIVE_CLI_PROJECT_CONTAINER_ROOT,
    '--read-only',
    '--cap-drop', 'ALL',
    ...projectRuntimeSecurityOptArgs(),
    '--pids-limit', String(CONTAINER_PIDS_LIMIT),
    '--memory', String(CONTAINER_MEMORY_BYTES),
    '--memory-swap', String(CONTAINER_MEMORY_BYTES),
    '--cpus', '2',
    '--ulimit', 'nofile=1024:1024',
    '--ulimit', 'nproc=256:256',
    '--restart', 'no',
    // docker-init is the PID-1 subreaper for detached provider process trees.
    // Without it, an interrupted docker-exec wrapper can leave exited children
    // as permanent zombies under a non-reaping image entrypoint.
    '--init',
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=134217728,uid=${NATIVE_CLI_PROJECT_CONTAINER_UID},gid=${NATIVE_CLI_PROJECT_CONTAINER_GID},mode=0700`,
    '--tmpfs', `/run:rw,noexec,nosuid,nodev,size=16777216,uid=${NATIVE_CLI_PROJECT_CONTAINER_UID},gid=${NATIVE_CLI_PROJECT_CONTAINER_GID},mode=0700`,
    '--tmpfs', `${NATIVE_CLI_PROJECT_CONTAINER_HOME}:rw,noexec,nosuid,nodev,size=268435456,uid=${NATIVE_CLI_PROJECT_CONTAINER_UID},gid=${NATIVE_CLI_PROJECT_CONTAINER_GID},mode=0700`,
    '--volume', `${projectRoot}:${NATIVE_CLI_PROJECT_CONTAINER_ROOT}:rw,rprivate`,
  );
  for (const [key, value] of Object.entries(expectedEnvironment)) createArgs.push('--env', `${key}=${value}`);
  createArgs.push('--entrypoint', 'node', runtimeImage, '-e', IDLE_SCRIPT);
  return Object.freeze({
    profile: input.profile,
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

type NativeCliRuntimeFingerprintGeneration = 'CURRENT' | 'LEGACY_PRE_CONFINEMENT';
type NativeCliRuntimeConfinementGeneration = 'CURRENT' | 'LEGACY_PRE_CONFINEMENT';

function buildNativeCliRuntimeFingerprint(input: {
  context: ProjectSandboxExecutionContext;
  profile: NativeCliProjectRuntimeProfile;
  spec: ProjectEgressPlaneSpec;
  runtimeImage: string;
  projectRoot: string;
  generation: NativeCliRuntimeFingerprintGeneration;
  tokenHash?: string;
}): string {
  const common = {
    provider: input.profile.provider,
    profile: input.profile,
    actorId: input.context.userId,
    projectId: input.context.projectId,
    workspaceOwnerId: input.context.workspaceOwnerId,
    policyFingerprint: input.context.policyFingerprint,
    runtimePolicyVersion: input.context.runtimePolicyVersion,
    egressPolicyVersion: input.context.egressPolicyVersion,
    egressPolicyFingerprint: input.generation === 'LEGACY_PRE_CONFINEMENT'
      ? derivePreConfinementProjectEgressPolicyFingerprint(input.spec)
      : input.spec.policyFingerprint,
  };
  if (input.generation === 'LEGACY_PRE_CONFINEMENT') {
    return stableHash({
      ...common,
      egressProxyCredentialHash: input.tokenHash || input.spec.tokenHash,
      runtimeImage: input.runtimeImage,
      projectRoot: input.projectRoot,
      user: NATIVE_CLI_PROJECT_CONTAINER_USER,
    });
  }
  return stableHash({
    ...common,
    // The proxy token is intentionally absent from labels and container names.
    // Its hash still has to participate in the immutable runtime generation:
    // Docker cannot update an existing container's proxy environment in place.
    egressProxyCredentialHash: input.tokenHash || input.spec.tokenHash,
    runtimeImage: input.runtimeImage,
    projectRoot: input.projectRoot,
    user: NATIVE_CLI_PROJECT_CONTAINER_USER,
    confinementSecurityOptions: projectRuntimeSecurityOptionValues(),
  });
}

function attestNativeCliProjectRuntimeContainerForGeneration(input: {
  inspect: DockerContainerInspect;
  plan: NativeCliProjectRuntimePlan;
  spec: ProjectEgressPlaneSpec;
  requireRunning: boolean;
  confinementGeneration: NativeCliRuntimeConfinementGeneration;
}): { containerId: string; pid: number; startedAt: string } {
  const { inspect, plan, spec } = input;
  const prefix = plan.profile.displayName;
  const containerId = String(inspect.Id || '');
  if (!/^[a-f0-9]{64}$/i.test(containerId)) fail('RUNTIME_ID', `${prefix} Project runtime ID is invalid`);
  if (String(inspect.Name || '').replace(/^\//, '') !== plan.containerName) {
    fail('RUNTIME_NAME', `${prefix} Project runtime name did not match`);
  }
  if (
    String(inspect.Image || '').toLowerCase() !== plan.runtimeImage
    || String(inspect.Config?.Image || '').toLowerCase() !== plan.runtimeImage
  ) {
    fail('RUNTIME_IMAGE', `${prefix} Project runtime image digest did not match`);
  }
  if (
    inspect.Config?.User !== NATIVE_CLI_PROJECT_CONTAINER_USER
    || inspect.Config?.WorkingDir !== NATIVE_CLI_PROJECT_CONTAINER_ROOT
    || !valuesEqual(inspect.Config?.Entrypoint || [], ['node'])
    || !valuesEqual(inspect.Config?.Cmd || [], ['-e', IDLE_SCRIPT])
  ) {
    fail('RUNTIME_PROCESS', `${prefix} Project runtime process identity did not match`);
  }
  const labels = inspect.Config?.Labels || {};
  for (const [key, value] of Object.entries(plan.expectedLabels)) {
    if (labels[key] !== value) fail('RUNTIME_LABELS', `${prefix} Project runtime labels did not match`);
  }
  const host = inspect.HostConfig || {};
  try {
    if (input.confinementGeneration === 'LEGACY_PRE_CONFINEMENT') {
      attestPreConfinementProjectRuntimeSecurityOptions({
        securityOpt: host.SecurityOpt,
        appArmorProfile: inspect.AppArmorProfile,
      });
    } else {
      attestProjectRuntimeSecurityOptions({
        securityOpt: host.SecurityOpt,
        appArmorProfile: inspect.AppArmorProfile,
      });
    }
  } catch {
    fail('RUNTIME_CONFINEMENT', `${plan.profile.displayName} Project runtime confinement profiles did not match`);
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
    fail('RUNTIME_HARDENING', `${prefix} Project runtime hardening did not match`);
  }
  if (
    host.PidsLimit !== CONTAINER_PIDS_LIMIT
    || host.Memory !== CONTAINER_MEMORY_BYTES
    || host.MemorySwap !== CONTAINER_MEMORY_BYTES
    || host.NanoCpus !== CONTAINER_NANO_CPUS
  ) {
    fail('RUNTIME_RESOURCES', `${prefix} Project runtime resource limits did not match`);
  }
  const expectedUlimits = [
    { name: 'nofile', soft: 1024, hard: 1024 },
    { name: 'nproc', soft: 256, hard: 256 },
  ];
  // Docker preserves the values but does not promise the insertion order of
  // HostConfig.Ulimits. Attest the exact set after canonicalization so an
  // engine-side reorder cannot disable every shared native Project provider.
  const actualUlimits = (Array.isArray(host.Ulimits) ? host.Ulimits : [])
    .map((entry) => ({
      name: String(entry.Name || ''),
      soft: Number(entry.Soft),
      hard: Number(entry.Hard),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!valuesEqual(actualUlimits, expectedUlimits)) {
    fail('RUNTIME_ULIMITS', `${prefix} Project runtime ulimits did not match`);
  }
  const tmpfs = host.Tmpfs || {};
  const expectedTmpfs = new Map<string, { required: string[]; sizes: string[] }>([
    ['/tmp', {
      required: ['rw', 'noexec', 'nosuid', 'nodev', `uid=${NATIVE_CLI_PROJECT_CONTAINER_UID}`, `gid=${NATIVE_CLI_PROJECT_CONTAINER_GID}`, 'mode=0700'],
      sizes: ['size=134217728', 'size=128m'],
    }],
    ['/run', {
      required: ['rw', 'noexec', 'nosuid', 'nodev', `uid=${NATIVE_CLI_PROJECT_CONTAINER_UID}`, `gid=${NATIVE_CLI_PROJECT_CONTAINER_GID}`, 'mode=0700'],
      sizes: ['size=16777216', 'size=16m'],
    }],
    [NATIVE_CLI_PROJECT_CONTAINER_HOME, {
      required: ['rw', 'noexec', 'nosuid', 'nodev', `uid=${NATIVE_CLI_PROJECT_CONTAINER_UID}`, `gid=${NATIVE_CLI_PROJECT_CONTAINER_GID}`, 'mode=0700'],
      sizes: ['size=268435456', 'size=256m'],
    }],
  ]);
  if (Object.keys(tmpfs).length !== expectedTmpfs.size) {
    fail('RUNTIME_TMPFS', `${prefix} Project tmpfs policy did not match`);
  }
  for (const [target, expected] of expectedTmpfs) {
    const flags = String(tmpfs[target] || '').split(',').map((flag) => flag.trim().toLowerCase()).sort();
    if (!expected.sizes.some((size) => valuesEqual(flags, [...expected.required, size].sort()))) {
      fail('RUNTIME_TMPFS', `${prefix} Project tmpfs policy did not match`);
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
    fail('RUNTIME_EXPOSURE', `${prefix} Project runtime exposes an undeclared host resource`);
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
    fail('RUNTIME_NETWORK', `${prefix} Project runtime network attachment did not match`);
  }
  const environment = environmentMap(inspect.Config?.Env);
  for (const [key, value] of Object.entries(plan.expectedEnvironment)) {
    const actual = environment.get(key);
    if (!actual || actual.length !== 1 || actual[0] !== value) {
      fail('RUNTIME_ENVIRONMENT', `${prefix} Project runtime environment ${key} did not match`);
    }
  }
  for (const key of EXPECTED_PROXY_KEYS) {
    if ((environment.get(key)?.length || 0) !== 1) {
      fail('RUNTIME_PROXY_ENVIRONMENT', `${prefix} Project runtime proxy environment is ambiguous`);
    }
  }
  for (const key of environment.keys()) {
    if (/(?:^|_)(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY)(?:_|$)/i.test(key)) {
      fail('RUNTIME_SECRET_ENVIRONMENT', `${prefix} Project runtime inherited a credential variable`);
    }
  }
  if (inspect.State?.Running !== input.requireRunning) {
    fail('RUNTIME_STATE', `${prefix} Project runtime must be ${input.requireRunning ? 'running' : 'stopped'}`);
  }
  const pid = Number(inspect.State?.Pid || 0);
  const startedAt = String(inspect.State?.StartedAt || '');
  if (input.requireRunning && (!Number.isSafeInteger(pid) || pid < 2 || !startedAt)) {
    fail('RUNTIME_PROCESS', `${prefix} Project runtime process is unavailable`);
  }
  return { containerId, pid, startedAt };
}

export function attestNativeCliProjectRuntimeContainer(input: {
  inspect: DockerContainerInspect;
  plan: NativeCliProjectRuntimePlan;
  spec: ProjectEgressPlaneSpec;
  requireRunning: boolean;
}): { containerId: string; pid: number; startedAt: string } {
  return attestNativeCliProjectRuntimeContainerForGeneration({
    ...input,
    confinementGeneration: 'CURRENT',
  });
}

function normalizeFirewallStatements(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function attestNativeCliProjectNamespaceFirewall(input: {
  proxyAddress: string;
  allowLoopback: boolean;
  ipv4: string;
  ipv6: string;
}): void {
  const loopbackInputIpv4 = input.allowLoopback ? ['-A INPUT -i lo -j ACCEPT'] : [];
  const loopbackOutputIpv4 = input.allowLoopback ? ['-A OUTPUT -o lo -j ACCEPT'] : [];
  const loopbackIpv6 = input.allowLoopback
    ? ['-A INPUT -i lo -j ACCEPT', '-A OUTPUT -o lo -j ACCEPT']
    : [];
  const expectedIpv4 = [
    '-P INPUT DROP',
    '-P FORWARD DROP',
    '-P OUTPUT DROP',
    // iptables -S emits rules grouped by built-in chain, regardless of the
    // order in which INPUT and OUTPUT rules were appended.
    ...loopbackInputIpv4,
    `-A INPUT -s ${input.proxyAddress}/32 -p tcp -m tcp --sport ${PROXY_PORT} -m conntrack --ctstate ESTABLISHED -j ACCEPT`,
    ...loopbackOutputIpv4,
    `-A OUTPUT -d ${input.proxyAddress}/32 -p tcp -m tcp --dport ${PROXY_PORT} -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT`,
  ];
  const expectedIpv6 = ['-P INPUT DROP', '-P FORWARD DROP', '-P OUTPUT DROP', ...loopbackIpv6];
  if (!valuesEqual(normalizeFirewallStatements(input.ipv4), expectedIpv4)) {
    fail('RUNTIME_IPV4_FIREWALL', 'Native CLI Project IPv4 namespace firewall did not match exactly');
  }
  if (!valuesEqual(normalizeFirewallStatements(input.ipv6), expectedIpv6)) {
    fail('RUNTIME_IPV6_FIREWALL', 'Native CLI Project IPv6 namespace firewall did not match exactly');
  }
}

async function namespaceCommand(
  executor: ProjectEgressCommandExecutor,
  pid: number,
  command: string,
  args: readonly string[],
): Promise<ProjectEgressCommandResult> {
  return executor.run('/usr/bin/nsenter', ['--target', String(pid), '--net', '--', command, ...args]);
}

async function installAndAttestNamespaceFirewall(input: {
  executor: ProjectEgressCommandExecutor;
  pid: number;
  proxyAddress: string;
  allowLoopback: boolean;
}): Promise<void> {
  for (const tool of ['iptables', 'ip6tables']) {
    for (const chain of ['INPUT', 'FORWARD', 'OUTPUT']) {
      await namespaceCommand(input.executor, input.pid, tool, ['-w', '-F', chain]);
      await namespaceCommand(input.executor, input.pid, tool, ['-w', '-P', chain, 'DROP']);
    }
  }
  if (input.allowLoopback) {
    for (const tool of ['iptables', 'ip6tables']) {
      await namespaceCommand(input.executor, input.pid, tool, ['-w', '-A', 'INPUT', '-i', 'lo', '-j', 'ACCEPT']);
      await namespaceCommand(input.executor, input.pid, tool, ['-w', '-A', 'OUTPUT', '-o', 'lo', '-j', 'ACCEPT']);
    }
  }
  await namespaceCommand(input.executor, input.pid, 'iptables', [
    '-w', '-A', 'INPUT', '-s', `${input.proxyAddress}/32`, '-p', 'tcp', '--sport', String(PROXY_PORT),
    '-m', 'conntrack', '--ctstate', 'ESTABLISHED', '-j', 'ACCEPT',
  ]);
  await namespaceCommand(input.executor, input.pid, 'iptables', [
    '-w', '-A', 'OUTPUT', '-d', `${input.proxyAddress}/32`, '-p', 'tcp', '--dport', String(PROXY_PORT),
    '-m', 'conntrack', '--ctstate', 'NEW,ESTABLISHED', '-j', 'ACCEPT',
  ]);
  const ipv4 = await namespaceCommand(input.executor, input.pid, 'iptables', ['-w', '-S']);
  const ipv6 = await namespaceCommand(input.executor, input.pid, 'ip6tables', ['-w', '-S']);
  attestNativeCliProjectNamespaceFirewall({
    proxyAddress: input.proxyAddress,
    allowLoopback: input.allowLoopback,
    ipv4: ipv4.stdout,
    ipv6: ipv6.stdout,
  });
}

function managedFileHash(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function injectAndAttestManagedState(input: {
  executor: ProjectEgressCommandExecutor;
  containerId: string;
  files: readonly NativeCliProjectManagedFile[];
}): Promise<void> {
  const directories = Array.from(new Set(input.files.map((file) => path.posix.dirname(file.targetPath))));
  const expected = input.files.map((file) => ({
    path: file.targetPath,
    hash: managedFileHash(file.sourcePath),
  }));
  const payload = input.files.map((file) => fs.readFileSync(file.sourcePath).toString('base64'));
  const script = `
const crypto = require('crypto');
const fs = require('fs');
const dirs = ${JSON.stringify(directories)};
const expected = ${JSON.stringify(expected)};
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!Array.isArray(payload) || payload.length !== expected.length) process.exit(41);
for (const dir of dirs) {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) process.exit(42);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(dir, 0o700);
}
for (let index = 0; index < expected.length; index += 1) {
  const data = Buffer.from(String(payload[index] || ''), 'base64');
  if (crypto.createHash('sha256').update(data).digest('hex') !== expected[index].hash) process.exit(43);
  try {
    const stat = fs.lstatSync(expected[index].path);
    if (!stat.isFile() || stat.isSymbolicLink()) process.exit(44);
    fs.unlinkSync(expected[index].path);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
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
    'container', 'exec', '--interactive', '--user', NATIVE_CLI_PROJECT_CONTAINER_USER,
    input.containerId, 'node', '-e', script,
  ], { input: JSON.stringify(payload) });
  let actual: unknown;
  try {
    actual = JSON.parse(result.stdout);
  } catch {
    fail('RUNTIME_STATE_JSON', 'Native CLI Project managed state attestation returned invalid JSON');
  }
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    fail('RUNTIME_STATE', 'Native CLI Project managed state attestation was incomplete');
  }
  for (let index = 0; index < expected.length; index += 1) {
    const entry = actual[index] as Record<string, unknown> | undefined;
    if (
      entry?.path !== expected[index].path
      || entry?.hash !== expected[index].hash
      || entry?.uid !== NATIVE_CLI_PROJECT_CONTAINER_UID
      || entry?.gid !== NATIVE_CLI_PROJECT_CONTAINER_GID
      || entry?.mode !== 0o400
      || entry?.file !== true
      || entry?.symlink !== false
    ) {
      fail('RUNTIME_STATE', 'Native CLI Project managed state did not match its protected source');
    }
  }
}

class NativeCliProjectCommandExecutor implements ProjectEgressCommandExecutor {
  async run(
    command: string,
    args: readonly string[],
    options: { allowExitCodes?: readonly number[]; input?: string } = {},
  ): Promise<ProjectEgressCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: nativeCliProjectDockerHostEnvironment(),
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
          finish(new Error('Native CLI Project host command output exceeded the safety limit'));
          return;
        }
        target.push(Buffer.from(chunk));
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.once('error', () => finish(new Error('Native CLI Project host command failed to start')));
      child.once('close', (code) => {
        const exitCode = code ?? 1;
        if (!(options.allowExitCodes || [0]).includes(exitCode)) {
          finish(new Error(`Native CLI Project host command failed with exit code ${exitCode}`));
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

export function nativeCliProjectDockerHostEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/nonexistent',
    DOCKER_CONFIG: '/nonexistent',
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
}

export const nativeCliProjectEgressCommandExecutor: ProjectEgressCommandExecutor = new NativeCliProjectCommandExecutor();

const defaultDependencies: NativeCliProjectEgressRuntimeDependencies = {
  executor: nativeCliProjectEgressCommandExecutor,
  buildEgressConfig: (context, provider) => buildProjectEgressConfig({ context, provider }),
  buildEgressSpec: buildProjectEgressPlaneSpec,
  ensureEgressPlane: ensureProjectEgressPlane,
  resolveInternalNetworkBinding: resolveRecognizedProjectEgressInternalNetworkBinding,
  constrainRuntime: constrainProjectRuntimeToEgressPlane,
  assertConfinementReady: () => { assertProjectRuntimeConfinementReadyForExecution(); },
};

async function listExactIdentityRuntimeIds(input: {
  executor: ProjectEgressCommandExecutor;
  plan: NativeCliProjectRuntimePlan;
}): Promise<string[]> {
  const labels = input.plan.expectedLabels;
  const result = await input.executor.run('docker', [
    'container', 'ls', '--all', '--no-trunc',
    '--filter', `label=${NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL}=${labels[NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL]}`,
    '--filter', `label=${NATIVE_CLI_PROJECT_RUNTIME_ACTOR_LABEL}=${labels[NATIVE_CLI_PROJECT_RUNTIME_ACTOR_LABEL]}`,
    '--filter', `label=${NATIVE_CLI_PROJECT_RUNTIME_IDENTITY_LABEL}=${labels[NATIVE_CLI_PROJECT_RUNTIME_IDENTITY_LABEL]}`,
    '--format', '{{.ID}}',
  ]);
  const ids = result.stdout.split(/\r?\n/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (ids.length > 8
    || new Set(ids).size !== ids.length
    || ids.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    fail('RUNTIME_IDENTITY_INVENTORY', 'Docker returned an invalid Native CLI Project runtime identity inventory');
  }
  return ids;
}

// Mirror of the kernel-owned context policy fingerprint derivation
// (projectChatKernel.buildProjectSandboxExecutionContextInternal). The
// runtime string is profile-owned so this file stays cycle-free with the
// provider registry, which freezes the same constant.
function nativeCliContextPolicyFingerprint(
  context: ProjectSandboxExecutionContext,
  profile: NativeCliProjectRuntimeProfile,
): string {
  return stableHash({
    version: context.runtimePolicyVersion,
    egressPolicyVersion: context.egressPolicyVersion,
    provider: profile.provider,
    runtime: profile.runtime,
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

function staleRuntimeAttestationPlan(input: {
  inspect: DockerContainerInspect;
  containerName: string;
  plan: NativeCliProjectRuntimePlan;
  context: ProjectSandboxExecutionContext;
  spec: ProjectEgressPlaneSpec;
}): {
  plan: NativeCliProjectRuntimePlan;
  confinementGeneration: NativeCliRuntimeConfinementGeneration;
} {
  const labels = input.inspect.Config?.Labels || {};
  const runtimeFingerprint = String(labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] || '').toLowerCase();
  const runtimePolicy = String(labels[RUNTIME_POLICY_LABEL] || '');
  const staleEgressFingerprint = String(labels[RUNTIME_EGRESS_LABEL] || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(runtimeFingerprint)
    || input.containerName
      !== `${input.plan.profile.containerNamePrefix}-${runtimeFingerprint.slice(0, 24)}`) {
    fail('STALE_RUNTIME_GENERATION', 'Managed Native CLI Project stale runtime identity is invalid');
  }
  if (runtimePolicy !== input.plan.profile.runtimePolicyVersion
    || labels[NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL] !== input.plan.profile.provider) {
    fail('STALE_RUNTIME_POLICY', 'Managed Native CLI Project stale runtime policy did not match');
  }
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
    fail('STALE_RUNTIME_IMAGE', 'Managed Native CLI Project stale runtime image did not match');
  }
  const candidateContext = Object.freeze({
    ...input.context,
    runtimeImageDigest: inspectedImage,
    policyFingerprint: nativeCliContextPolicyFingerprint(
      { ...input.context, runtimeImageDigest: inspectedImage },
      input.plan.profile,
    ),
  });
  const environment = environmentMap(input.inspect.Config?.Env);
  const requiredProxyEnvironment: Record<string, string> = Object.fromEntries(EXPECTED_PROXY_KEYS.map((key) => {
    const values = environment.get(key);
    if (!values || values.length !== 1) {
      fail('STALE_RUNTIME_PROXY', 'Managed Native CLI Project stale runtime proxy environment is ambiguous');
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
    fail('STALE_RUNTIME_PROXY', 'Managed Native CLI Project stale runtime proxy environment is invalid');
  }
  let parsedProxy: URL;
  try {
    parsedProxy = new URL(proxyUrls[0]);
  } catch {
    fail('STALE_RUNTIME_PROXY', 'Managed Native CLI Project stale runtime proxy URL is invalid');
  }
  if (parsedProxy.protocol !== 'http:'
    || parsedProxy.username !== 'portal'
    || !/^[A-Za-z0-9_-]{43,256}$/.test(parsedProxy.password)
    || !net.isIPv4(parsedProxy.hostname)
    || parsedProxy.port !== String(input.spec.proxyPort)
    || parsedProxy.pathname !== '/'
    || parsedProxy.search
    || parsedProxy.hash) {
    fail('STALE_RUNTIME_PROXY', 'Managed Native CLI Project stale runtime proxy URL is invalid');
  }
  const inspectedTokenHash = stableHash(parsedProxy.password);
  const priorEgressFingerprint = derivePreConfinementProjectEgressPolicyFingerprint(input.spec);
  const candidates: Array<{
    runtimeFingerprint: string;
    egressPolicyFingerprint: string;
    confinementGeneration: NativeCliRuntimeConfinementGeneration;
  }> = [
    {
      runtimeFingerprint: buildNativeCliRuntimeFingerprint({
        context: candidateContext,
        profile: input.plan.profile,
        spec: input.spec,
        runtimeImage: inspectedImage,
        projectRoot: input.plan.projectRoot,
        generation: 'LEGACY_PRE_CONFINEMENT',
        tokenHash: inspectedTokenHash,
      }),
      egressPolicyFingerprint: priorEgressFingerprint,
      confinementGeneration: 'LEGACY_PRE_CONFINEMENT',
    },
    {
      runtimeFingerprint: buildNativeCliRuntimeFingerprint({
        context: candidateContext,
        profile: input.plan.profile,
        spec: input.spec,
        runtimeImage: inspectedImage,
        projectRoot: input.plan.projectRoot,
        generation: 'CURRENT',
        tokenHash: inspectedTokenHash,
      }),
      egressPolicyFingerprint: input.spec.policyFingerprint,
      confinementGeneration: 'CURRENT',
    },
  ];
  const candidate = candidates.find((entry) => (
    runtimeFingerprint === entry.runtimeFingerprint
    && staleEgressFingerprint === entry.egressPolicyFingerprint
  ));
  if (!candidate) {
    fail(
      'STALE_RUNTIME_GENERATION',
      'Managed Native CLI Project runtime is not an exact recognized prior generation',
    );
  }
  const inspectedTokenSpec = {
    ...input.spec,
    token: parsedProxy.password,
    tokenHash: inspectedTokenHash,
  };
  const exactProxyEnvironment = expectedProxyEnvironment(inspectedTokenSpec, parsedProxy.hostname);
  if (!valuesEqual(requiredProxyEnvironment, exactProxyEnvironment)) {
    fail('STALE_RUNTIME_PROXY', 'Managed Native CLI Project stale runtime proxy credentials did not match');
  }
  const requiredEnvironment: Record<string, string> = {};
  for (const [key, expected] of Object.entries(input.plan.expectedEnvironment)) {
    const value = EXPECTED_PROXY_KEYS.includes(key as (typeof EXPECTED_PROXY_KEYS)[number])
      ? exactProxyEnvironment[key]
      : expected;
    const actual = environment.get(key);
    if (!actual || actual.length !== 1 || actual[0] !== value) {
      fail('STALE_RUNTIME_ENVIRONMENT', 'Managed Native CLI Project stale runtime environment did not match');
    }
    requiredEnvironment[key] = value;
  }
  const inspectedNetworkMode = String(input.inspect.HostConfig?.NetworkMode || '').toLowerCase();
  const networkMode = inspectedNetworkMode === input.spec.internalNetworkName
    ? input.spec.internalNetworkName
    : inspectedNetworkMode === input.plan.networkMode
      && /^[a-f0-9]{64}$/.test(input.plan.networkMode)
      ? input.plan.networkMode
      : fail(
        'STALE_RUNTIME_NETWORK',
        'Managed Native CLI Project stale runtime network mode is not a recognized generation',
      );
  const stalePlan = Object.freeze({
    ...input.plan,
    containerName: input.containerName,
    runtimeFingerprint,
    runtimeImage: inspectedImage,
    expectedEnvironment: Object.freeze(requiredEnvironment),
    expectedLabels: Object.freeze({
      ...input.plan.expectedLabels,
      [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: runtimeFingerprint,
      [RUNTIME_EGRESS_LABEL]: candidate.egressPolicyFingerprint,
    }),
    networkMode,
  });
  return Object.freeze({
    plan: stalePlan,
    confinementGeneration: candidate.confinementGeneration,
  });
}

function attestInventoryRuntime(input: {
  inspect: DockerContainerInspect;
  containerName: string;
  plan: NativeCliProjectRuntimePlan;
  context: ProjectSandboxExecutionContext;
  spec: ProjectEgressPlaneSpec;
  requireRunning: boolean;
}): {
  containerId: string;
  current: boolean;
  attestationPlan: ReturnType<typeof staleRuntimeAttestationPlan>;
} {
  if (typeof input.inspect.State?.Running !== 'boolean') {
    fail('STALE_RUNTIME_STATE', 'Managed Native CLI Project runtime state is ambiguous');
  }
  const attestationPlan = staleRuntimeAttestationPlan(input);
  const runtimeFingerprint = String(
    input.inspect.Config?.Labels?.[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] || '',
  ).toLowerCase();
  const currentFingerprint = runtimeFingerprint === input.plan.runtimeFingerprint;
  const currentName = input.containerName === input.plan.containerName;
  if (currentFingerprint !== currentName) {
    fail('STALE_RUNTIME_IDENTITY', 'Native CLI Project runtime current identity is internally inconsistent');
  }
  const attested = attestNativeCliProjectRuntimeContainerForGeneration({
    inspect: input.inspect,
    plan: attestationPlan.plan,
    spec: input.spec,
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
  plan: NativeCliProjectRuntimePlan;
  context: ProjectSandboxExecutionContext;
  spec: ProjectEgressPlaneSpec;
}): Promise<void> {
  const initial = await listExactIdentityRuntimeIds(input);
  const attestedInventory: Array<{
    containerId: string;
    current: boolean;
    containerName: string;
    attestationPlan: ReturnType<typeof staleRuntimeAttestationPlan>;
  }> = [];
  for (const discoveredId of initial) {
    const before = await strictInspectContainer(input.executor, discoveredId);
    if (!before) {
      fail('STALE_RUNTIME_RACE', 'Managed Native CLI Project runtime disappeared before attestation');
    }
    const containerName = String(before.Name || '').replace(/^\//, '');
    const attested = attestInventoryRuntime({
      inspect: before,
      containerName,
      plan: input.plan,
      context: input.context,
      spec: input.spec,
      requireRunning: before.State?.Running === true,
    });
    if (attested.containerId !== discoveredId) {
      fail('STALE_RUNTIME_RACE', 'Managed Native CLI Project runtime immutable identity changed');
    }
    attestedInventory.push({ ...attested, containerName });
  }
  if (attestedInventory.filter((entry) => entry.current).length > 1) {
    fail('RUNTIME_IDENTITY_INVENTORY', 'Native CLI Project runtime identity has multiple current claimants');
  }
  if (!valuesEqual(await listExactIdentityRuntimeIds(input), initial)) {
    fail('STALE_RUNTIME_RACE', 'Managed Native CLI Project runtime inventory changed before retirement');
  }
  for (const candidate of attestedInventory.filter((entry) => !entry.current)) {
    const before = await strictInspectContainer(input.executor, candidate.containerId);
    if (!before) {
      fail('STALE_RUNTIME_RACE', 'Managed Native CLI Project stale runtime disappeared before retirement');
    }
    const reattested = attestNativeCliProjectRuntimeContainerForGeneration({
      inspect: before,
      plan: candidate.attestationPlan.plan,
      spec: input.spec,
      requireRunning: before.State?.Running === true,
      confinementGeneration: candidate.attestationPlan.confinementGeneration,
    });
    if (reattested.containerId.toLowerCase() !== candidate.containerId) {
      fail('STALE_RUNTIME_RACE', 'Managed Native CLI Project stale runtime changed before retirement');
    }
    if (before.State?.Running === true) {
      await input.executor.run('docker', ['container', 'stop', '--time', '1', candidate.containerId]);
    }
    const stopped = await strictInspectContainer(input.executor, candidate.containerId);
    if (!stopped) {
      fail('STALE_RUNTIME_RACE', 'Managed Native CLI Project stale runtime disappeared before removal');
    }
    const stoppedAttestation = attestNativeCliProjectRuntimeContainerForGeneration({
      inspect: stopped,
      plan: candidate.attestationPlan.plan,
      spec: input.spec,
      requireRunning: false,
      confinementGeneration: candidate.attestationPlan.confinementGeneration,
    });
    if (stoppedAttestation.containerId.toLowerCase() !== candidate.containerId) {
      fail('STALE_RUNTIME_RACE', 'Managed Native CLI Project stale runtime changed before removal');
    }
    await input.executor.run('docker', ['container', 'rm', candidate.containerId]);
    if (await strictInspectContainer(input.executor, candidate.containerId)) {
      fail('STALE_RUNTIME_REMOVE', 'Managed Native CLI Project stale runtime still exists after exact removal');
    }
  }
  const expectedCurrentIds = attestedInventory
    .filter((entry) => entry.current)
    .map((entry) => entry.containerId)
    .sort();
  const residualIds = await listExactIdentityRuntimeIds(input);
  if (!valuesEqual(residualIds, expectedCurrentIds)) {
    fail('STALE_RUNTIME_RESIDUAL', 'Managed Native CLI Project runtime inventory changed during retirement');
  }
  for (const residualId of residualIds) {
    const residual = await strictInspectContainer(input.executor, residualId);
    if (!residual) fail('STALE_RUNTIME_RACE', 'Managed Native CLI Project residual runtime disappeared');
    const attested = attestInventoryRuntime({
      inspect: residual,
      containerName: String(residual.Name || '').replace(/^\//, ''),
      plan: input.plan,
      context: input.context,
      spec: input.spec,
      requireRunning: residual.State?.Running === true,
    });
    if (!attested.current || attested.containerId !== residualId) {
      fail('STALE_RUNTIME_RESIDUAL', 'Managed Native CLI Project stale runtime convergence did not reach an exact state');
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
  plan: NativeCliProjectRuntimePlan;
  spec: ProjectEgressPlaneSpec;
  requireRunning: boolean;
}): Promise<{ containerId: string; pid: number; startedAt: string }> {
  const inspect = await strictInspectContainer(input.executor, input.containerId);
  if (!inspect) {
    fail('RUNTIME_RACE', 'Native CLI Project runtime identity disappeared during convergence');
  }
  const attested = attestNativeCliProjectRuntimeContainer({
    inspect,
    plan: input.plan,
    spec: input.spec,
    requireRunning: input.requireRunning,
  });
  if (attested.containerId !== input.containerId) {
    fail('RUNTIME_RACE', 'Native CLI Project runtime immutable identity changed during convergence');
  }
  return attested;
}

export async function attestOnlyNativeCliProjectIdentityRuntime(input: {
  executor: ProjectEgressCommandExecutor;
  containerId: string;
  plan: NativeCliProjectRuntimePlan;
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
      'Native CLI Project runtime identity has an unexpected concurrent generation',
    );
  }
  const named = await strictInspectContainer(input.executor, input.plan.containerName);
  if (!named) fail('RUNTIME_IDENTITY_INVENTORY', 'Native CLI Project runtime name disappeared');
  const namedAttestation = attestNativeCliProjectRuntimeContainer({
    inspect: named,
    plan: input.plan,
    spec: input.spec,
    requireRunning: true,
  });
  if (namedAttestation.containerId.toLowerCase() !== expectedContainerId) {
    fail(
      'RUNTIME_IDENTITY_INVENTORY',
      'Native CLI Project runtime name resolved to another immutable identity',
    );
  }
  await reattestCurrentRuntimeByImmutableId({
    ...input,
    requireRunning: true,
  });
  if (!valuesEqual(
    await listExactIdentityRuntimeIds({ executor: input.executor, plan: input.plan }),
    ids,
  )) {
    fail('RUNTIME_IDENTITY_INVENTORY', 'Native CLI Project runtime identity changed during attestation');
  }
}

async function stopExactCurrentRuntimeAfterFailure(input: {
  executor: ProjectEgressCommandExecutor;
  containerId: string;
  plan: NativeCliProjectRuntimePlan;
  spec: ProjectEgressPlaneSpec;
}): Promise<void> {
  // Cleanup is deliberately best-effort and fail-closed. The triggering error
  // remains authoritative; any ambiguity here leaves the container untouched.
  try {
    const inspect = await strictInspectContainer(input.executor, input.containerId);
    if (!inspect || inspect.State?.Running !== true) return;
    const attested = attestNativeCliProjectRuntimeContainer({
      inspect,
      plan: input.plan,
      spec: input.spec,
      requireRunning: true,
    });
    if (attested.containerId !== input.containerId) return;
    await input.executor.run(
      'docker',
      ['container', 'stop', '--time', '1', input.containerId],
      { allowExitCodes: [0, 1] },
    );
    const stopped = await strictInspectContainer(input.executor, input.containerId);
    if (!stopped) return;
    const stoppedAttested = attestNativeCliProjectRuntimeContainer({
      inspect: stopped,
      plan: input.plan,
      spec: input.spec,
      requireRunning: false,
    });
    if (stoppedAttested.containerId !== input.containerId) {
      fail('RUNTIME_RACE', 'Native CLI Project runtime immutable identity changed during cleanup');
    }
  } catch {
    // Never fall back to the deterministic name: it may now belong to an
    // unrelated container. Preserving the original failure is safer.
  }
}

async function ensureRuntimeLocked(input: {
  dependencies: NativeCliProjectEgressRuntimeDependencies;
  plan: NativeCliProjectRuntimePlan;
  spec: ProjectEgressPlaneSpec;
  proxyAddress: string;
  proxyEnvironment: Readonly<Record<string, string>>;
  files: readonly NativeCliProjectManagedFile[];
}): Promise<NativeCliProjectEgressRuntimeHandle> {
  const { dependencies, plan, spec, proxyAddress, proxyEnvironment, files } = input;
  let existing = await strictInspectContainer(dependencies.executor, plan.containerName);
  if (!existing) {
    const createResult = await dependencies.executor.run('docker', plan.createArgs);
    const createdId = createResult.stdout.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(createdId)) {
      fail('RUNTIME_CREATE_ID', 'Docker returned an invalid Native CLI Project runtime creation ID');
    }
    existing = await strictInspectContainer(dependencies.executor, createdId);
    if (!existing) fail('RUNTIME_CREATE', `${plan.profile.displayName} Project runtime could not be inspected after creation`);
    const created = attestNativeCliProjectRuntimeContainer({
      inspect: existing,
      plan,
      spec,
      requireRunning: false,
    });
    if (created.containerId.toLowerCase() !== createdId) {
      fail('RUNTIME_CREATE_ID', `${plan.profile.displayName} Project runtime creation identity changed`);
    }
  }
  if (typeof existing.State?.Running !== 'boolean') {
    fail('RUNTIME_STATE', `${plan.profile.displayName} Project runtime state is ambiguous`);
  }
  const initialAttestation = attestNativeCliProjectRuntimeContainer({
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
    fail('RUNTIME_IDENTITY_INVENTORY', `${plan.profile.displayName} Project runtime identity was ambiguous before convergence`);
  }
  let cleanupContainerId: string | null = null;
  try {
    let attested: { containerId: string; pid: number; startedAt: string };
    if (existing.State?.Running) {
      attested = attestNativeCliProjectRuntimeContainer({ inspect: existing, plan, spec, requireRunning: true });
      cleanupContainerId = attested.containerId;
    } else {
      const stopped = attestNativeCliProjectRuntimeContainer({
        inspect: existing,
        plan,
        spec,
        requireRunning: false,
      });
      cleanupContainerId = stopped.containerId;
      await reattestCurrentRuntimeByImmutableId({
        executor: dependencies.executor,
        containerId: stopped.containerId,
        plan,
        spec,
        requireRunning: false,
      });
      await dependencies.constrainRuntime({
        spec,
        runtimeContainerId: stopped.containerId,
        runtimeContainerName: plan.containerName,
        expectedRuntimeFingerprint: plan.runtimeFingerprint,
        executor: dependencies.executor,
      });
      await reattestCurrentRuntimeByImmutableId({
        executor: dependencies.executor,
        containerId: stopped.containerId,
        plan,
        spec,
        requireRunning: false,
      });
      await dependencies.executor.run('docker', ['container', 'start', stopped.containerId]);
      attested = await reattestCurrentRuntimeByImmutableId({
        executor: dependencies.executor,
        containerId: stopped.containerId,
        plan,
        spec,
        requireRunning: true,
      });
    }
    await installAndAttestNamespaceFirewall({
      executor: dependencies.executor,
      pid: attested.pid,
      proxyAddress,
      allowLoopback: plan.profile.allowLoopback,
    });
    await injectAndAttestManagedState({
      executor: dependencies.executor,
      containerId: attested.containerId,
      files,
    });
    const final = await reattestCurrentRuntimeByImmutableId({
      executor: dependencies.executor,
      containerId: attested.containerId,
      plan,
      spec,
      requireRunning: true,
    });
    const identityRuntimeIds = await listExactIdentityRuntimeIds({
      executor: dependencies.executor,
      plan,
    });
    if (!valuesEqual(identityRuntimeIds, [final.containerId.toLowerCase()])) {
      fail(
        'RUNTIME_IDENTITY_INVENTORY',
        'Native CLI Project runtime identity has an unexpected concurrent generation',
      );
    }
    const finalIdentity = await reattestCurrentRuntimeByImmutableId({
      executor: dependencies.executor,
      containerId: final.containerId,
      plan,
      spec,
      requireRunning: true,
    });
    const runtime = Object.freeze({
      provider: plan.profile.provider,
      containerId: finalIdentity.containerId,
      containerName: plan.containerName,
      runtimeFingerprint: plan.runtimeFingerprint,
      egressPolicyFingerprint: spec.policyFingerprint,
      proxyAddress,
      proxyEnvironment,
      startedAt: finalIdentity.startedAt,
    });
    await abortOrphanedExactNativeCliProjectRuns({
      runtime,
      containerUser: NATIVE_CLI_PROJECT_CONTAINER_USER,
      containerRoot: NATIVE_CLI_PROJECT_CONTAINER_ROOT,
      markerNamespace: plan.profile.provider.toLowerCase().replace(/_/g, '-'),
      executor: dependencies.executor,
    });
    return runtime;
  } catch (error) {
    if (cleanupContainerId) {
      await stopExactCurrentRuntimeAfterFailure({
        executor: dependencies.executor,
        containerId: cleanupContainerId,
        plan,
        spec,
      });
    }
    throw error;
  }
}

export async function ensureNativeCliProjectEgressRuntime(
  input: NativeCliProjectEgressRuntimeInput,
  overrides: Partial<NativeCliProjectEgressRuntimeDependencies> = {},
): Promise<NativeCliProjectEgressRuntimeHandle> {
  assertProjectContext(input.context, input.profile);
  const dependencies = { ...defaultDependencies, ...overrides };
  dependencies.assertConfinementReady();
  const egress = input.egress || dependencies.buildEgressConfig(input.context, input.profile.provider);
  assertEgressIdentity(input.context, input.profile, egress);
  const spec = dependencies.buildEgressSpec(egress);
  const runtime = await withRuntimeEnsureLock(spec.identityFingerprint, async () => {
    const preflightNetworkBinding = await dependencies.resolveInternalNetworkBinding(
      dependencies.executor,
      spec,
    );
    // The desired generation does not depend on the proxy's runtime address.
    // Build it before touching the plane so an old runtime can be retired by
    // immutable ID before stale-network convergence considers that network.
    const preflightPlan = buildNativeCliProjectRuntimePlan({
      context: input.context,
      profile: input.profile,
      spec,
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
    });
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
      fail('EGRESS_ATTESTATION', 'Native CLI Project internal network identity changed during convergence');
    }
    const postPlanePlan = buildNativeCliProjectRuntimePlan({
      context: input.context,
      profile: input.profile,
      spec,
      proxyAddress: '127.0.0.1',
      internalNetworkId: postPlaneBinding.networkId,
    });
    await retireExactManagedStaleRuntimes({
      executor: dependencies.executor,
      plan: postPlanePlan,
      context: input.context,
      spec,
    });
    const proxyAddress = await proxyInternalAddress(dependencies.executor, spec);
    const proxyEnvironment = expectedProxyEnvironment(spec, proxyAddress);
    const plan = buildNativeCliProjectRuntimePlan({
      context: input.context,
      profile: input.profile,
      spec,
      proxyAddress,
      internalNetworkId: postPlaneBinding.networkId,
    });
    if (plan.runtimeFingerprint !== preflightPlan.runtimeFingerprint
      || plan.containerName !== preflightPlan.containerName
      || plan.networkMode !== postPlanePlan.networkMode) {
      fail('RUNTIME_GENERATION', 'Native CLI Project runtime generation changed during egress convergence');
    }
    const files = assertManagedStateFiles(input.prepareManagedState(proxyEnvironment), plan.projectRoot);
    return ensureRuntimeLocked({
      dependencies,
      plan,
      spec,
      proxyAddress,
      proxyEnvironment,
      files,
    });
  });
  assertProjectContext(input.context, input.profile);
  return runtime;
}

function assertRuntimeInvocation(input: {
  runtime: NativeCliProjectEgressRuntimeHandle;
  profile: NativeCliProjectRuntimeProfile;
  command: string;
  args: readonly string[];
  turnId: string;
}): void {
  if (!/^[a-f0-9]{64}$/i.test(input.runtime.containerId)) {
    fail('RUNTIME_ID', 'Native CLI Project runtime ID is invalid at invocation boundary');
  }
  if (input.runtime.provider !== input.profile.provider || input.command !== input.profile.cliPath) {
    fail('RUNTIME_INVOCATION', 'Native CLI Project invocation does not match its attested provider profile');
  }
  if (input.args.length > 256 || input.args.some((entry) => /[\u0000]/.test(entry))) {
    fail('RUNTIME_INVOCATION', 'Native CLI Project invocation arguments are invalid');
  }
  const normalizedTurnId = String(input.turnId || '').trim();
  if (!normalizedTurnId || normalizedTurnId.length > 512 || /[\u0000-\u001f\u007f]/.test(normalizedTurnId)) {
    fail('RUNTIME_INVOCATION', 'Native CLI Project turn identity is invalid');
  }
}

export const abortNativeCliProjectTurn = abortExactNativeCliProjectRun;

export function buildNativeCliProjectInvocation(input: {
  runtime: NativeCliProjectEgressRuntimeHandle;
  profile: NativeCliProjectRuntimeProfile;
  command: string;
  args: readonly string[];
  turnId: string;
  executor?: ProjectEgressCommandExecutor;
}): NativeCliInvocation {
  assertRuntimeInvocation(input);
  return buildExactNativeCliProjectInvocation({
    runtime: input.runtime,
    containerUser: NATIVE_CLI_PROJECT_CONTAINER_USER,
    containerRoot: NATIVE_CLI_PROJECT_CONTAINER_ROOT,
    markerNamespace: input.profile.provider.toLowerCase().replace(/_/g, '-'),
    command: input.command,
    args: input.args,
    runId: input.turnId,
    executor: input.executor || nativeCliProjectEgressCommandExecutor,
    hostEnvironment: nativeCliProjectDockerHostEnvironment(),
  });
}

export const __nativeCliProjectEgressRuntimeTest = {
  IDLE_SCRIPT,
  TURN_WRAPPER_SCRIPT: __nativeCliProjectRunControlTest.TURN_WRAPPER_SCRIPT,
  ABORT_SCRIPT: __nativeCliProjectRunControlTest.RUN_CONTROL_SCRIPT,
  constants: {
    CONTAINER_MEMORY_BYTES,
    CONTAINER_NANO_CPUS,
    CONTAINER_PIDS_LIMIT,
    RUNTIME_POLICY_LABEL,
    RUNTIME_EGRESS_LABEL,
  },
};
