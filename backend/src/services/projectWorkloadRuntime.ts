import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { config } from '../config/env';
import {
  PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL,
  buildProjectEgressPlaneSpec,
  constrainProjectRuntimeToEgressPlane,
  ensureProjectEgressPlane,
  projectEgressCommandExecutor,
  teardownExactProjectEgressPlane,
  type ProjectEgressCommandExecutor,
  type ProjectEgressIdentity,
  type ProjectEgressPlaneHandle,
  type ProjectEgressPlaneSpec,
  type ProjectEgressWorkloadConsumerKind,
} from './projectEgressPlane';

const WORKLOAD_POLICY_VERSION = 'portal-project-workload-v1';
const LABEL_PREFIX = 'com.bridgesllm.project-workload';
const LABEL_POLICY = `${LABEL_PREFIX}.policy`;
const LABEL_ACTOR = `${LABEL_PREFIX}.actor-id`;
const LABEL_PROJECT = `${LABEL_PREFIX}.project-id`;
const LABEL_KIND = `${LABEL_PREFIX}.kind`;
const LABEL_WORKLOAD = `${LABEL_PREFIX}.workload-id`;
const MAX_IDENTIFIER_BYTES = 512;

export interface PortalProjectWorkloadIdentity {
  actorId: string;
  projectId: string;
  consumerKind: ProjectEgressWorkloadConsumerKind;
  workloadId: string;
}

export interface PortalProjectWorkloadContainerOptions {
  identity: PortalProjectWorkloadIdentity;
  containerName: string;
  workspace: string;
  image: string;
  command: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  networked: boolean;
  pidsLimit: number;
  memoryBytes: number;
  nanoCpus: number;
  tmpfsSize: string;
  applicationPort?: number;
}

export interface PortalProjectWorkloadPlan extends PortalProjectWorkloadContainerOptions {
  identity: Readonly<PortalProjectWorkloadIdentity>;
  egressIdentity: Readonly<ProjectEgressIdentity>;
  workspaceDevice: string;
  workspaceInode: string;
  workspaceBirthtimeNs: string;
  runtimeFingerprint: string;
  egressSpec: ProjectEgressPlaneSpec | null;
  egressHandle: ProjectEgressPlaneHandle | null;
}

interface ContainerInspect {
  Id?: string;
  Name?: string;
  Config?: {
    Image?: string;
    User?: string;
    Cmd?: string[] | null;
    Env?: string[] | null;
    Labels?: Record<string, string> | null;
  };
  State?: { Running?: boolean; Status?: string };
  HostConfig?: {
    ReadonlyRootfs?: boolean;
    CapDrop?: string[] | null;
    SecurityOpt?: string[] | null;
    Privileged?: boolean;
    PidMode?: string;
    IpcMode?: string;
    NetworkMode?: string;
    RestartPolicy?: { Name?: string };
    PidsLimit?: number | null;
    Memory?: number;
    NanoCpus?: number;
    Tmpfs?: Record<string, string> | null;
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null;
  };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>;
  NetworkSettings?: {
    Networks?: Record<string, {
      IPAddress?: string;
      NetworkID?: string;
    }>;
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null;
  };
}

export interface StartedPortalProjectWorkloadContainer {
  containerId: string;
  /** Attested address on the workload's exact internal egress network. */
  networkAddress: string | null;
}

export class PortalProjectWorkloadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PortalProjectWorkloadError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new PortalProjectWorkloadError(code, message);
}

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requireIdentifier(value: string, label: string): string {
  const normalized = String(value || '');
  if (!normalized || Buffer.byteLength(normalized) > MAX_IDENTIFIER_BYTES || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function requireContainerName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error('Portal workload container name is invalid');
  return value;
}

function requirePinnedImage(value: string, label: string): string {
  const image = String(value || '').trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error(`${label} must be pinned by Docker image digest`);
  return image;
}

function requireProxySecret(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(value || '')) fail('EGRESS_SECRET', 'Portal workload egress secret is unavailable');
  const secret = Buffer.from(value, 'base64url');
  if (secret.length < 32) fail('EGRESS_SECRET', 'Portal workload egress secret is too short');
  return secret;
}

function canonicalWorkspace(workspace: string): {
  path: string;
  device: string;
  inode: string;
  birthtimeNs: string;
} {
  const resolved = path.resolve(workspace);
  const root = path.parse(resolved).root;
  if (!path.isAbsolute(workspace) || resolved === root || resolved.length < root.length + 4) {
    throw new Error('Refusing unsafe Portal workload workspace');
  }
  const entry = fs.lstatSync(resolved, { bigint: true });
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Portal workload workspace must be a real directory');
  const canonical = fs.realpathSync.native(resolved);
  if (canonical !== resolved) throw new Error('Portal workload workspace must use its canonical path');
  return {
    path: canonical,
    device: entry.dev.toString(),
    inode: entry.ino.toString(),
    birthtimeNs: entry.birthtimeNs.toString(),
  };
}

function workloadIdentity(input: PortalProjectWorkloadIdentity): Readonly<PortalProjectWorkloadIdentity> {
  const consumerKind = input.consumerKind;
  if (!['PORTAL_GIT', 'PORTAL_LIFECYCLE', 'PORTAL_APP'].includes(consumerKind)) {
    throw new Error('Portal workload consumer kind is invalid');
  }
  return Object.freeze({
    actorId: requireIdentifier(input.actorId, 'actorId'),
    projectId: requireIdentifier(input.projectId, 'projectId'),
    consumerKind,
    workloadId: requireIdentifier(input.workloadId, 'workloadId'),
  });
}

export function toProjectEgressWorkloadIdentity(
  input: PortalProjectWorkloadIdentity,
): Readonly<ProjectEgressIdentity> {
  const identity = workloadIdentity(input);
  return Object.freeze({ ...identity, provider: 'PORTAL_WORKLOAD' });
}

export function derivePortalWorkloadProxyToken(
  identityInput: PortalProjectWorkloadIdentity,
  secretInput = config.projectEgressTokenSecret,
): string {
  const identity = workloadIdentity(identityInput);
  const secret = requireProxySecret(secretInput);
  return crypto.createHmac('sha256', secret).update(JSON.stringify({
    version: WORKLOAD_POLICY_VERSION,
    identity,
  })).digest('base64url');
}

export async function resolvePinnedProjectRuntimeImage(
  imageTag: string,
  executor: ProjectEgressCommandExecutor = projectEgressCommandExecutor,
): Promise<string> {
  const result = await executor.run('docker', ['image', 'inspect', '--format', '{{.Id}}', imageTag]);
  return requirePinnedImage(result.stdout.trim(), 'Project runtime image');
}

function environmentEntries(environment: Readonly<Record<string, string>>): string[] {
  return Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/i.test(key) || /[\u0000\r\n]/.test(value)) throw new Error('Portal workload environment is invalid');
    return `${key}=${value}`;
  });
}

function workloadLabels(plan: Pick<PortalProjectWorkloadPlan, 'identity' | 'runtimeFingerprint'>): Record<string, string> {
  return {
    [LABEL_POLICY]: WORKLOAD_POLICY_VERSION,
    [LABEL_ACTOR]: plan.identity.actorId,
    [LABEL_PROJECT]: plan.identity.projectId,
    [LABEL_KIND]: plan.identity.consumerKind,
    [LABEL_WORKLOAD]: plan.identity.workloadId,
    [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: plan.runtimeFingerprint,
  };
}

function expectedWorkloadContainerName(identity: PortalProjectWorkloadIdentity): string {
  const prefix = identity.consumerKind === 'PORTAL_GIT'
    ? 'bridgesllm-project-git'
    : identity.consumerKind === 'PORTAL_APP'
      ? 'bridgesllm-project-app'
      : 'bridgesllm-project-job';
  const discriminator = identity.consumerKind === 'PORTAL_GIT'
    ? `${identity.actorId}\0${identity.projectId}\0${identity.workloadId}`
    : `${identity.actorId}\0${identity.projectId}\0${identity.consumerKind === 'PORTAL_APP' ? 'app' : 'job'}\0${identity.workloadId}`;
  const digest = crypto.createHash('sha256').update(discriminator).digest('hex').slice(0, 20);
  return `${prefix}-${digest}`;
}

function labelArgs(labels: Readonly<Record<string, string>>): string[] {
  return Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}

export async function buildPortalProjectWorkloadPlan(
  options: PortalProjectWorkloadContainerOptions,
  executor: ProjectEgressCommandExecutor = projectEgressCommandExecutor,
): Promise<PortalProjectWorkloadPlan> {
  const identity = workloadIdentity(options.identity);
  const egressIdentity = toProjectEgressWorkloadIdentity(identity);
  const workspace = canonicalWorkspace(options.workspace);
  const image = requirePinnedImage(options.image, 'Project runtime image');
  const containerName = requireContainerName(options.containerName);
  if (!options.command || /[\u0000\r\n]/.test(options.command)
    || options.args.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('Portal workload command is invalid');
  }
  if (!Number.isInteger(options.pidsLimit) || options.pidsLimit < 16
    || !Number.isInteger(options.memoryBytes) || options.memoryBytes < 64 * 1024 * 1024
    || !Number.isInteger(options.nanoCpus) || options.nanoCpus < 100_000_000) {
    throw new Error('Portal workload resource policy is invalid');
  }
  if (options.applicationPort !== undefined
    && (!Number.isInteger(options.applicationPort) || options.applicationPort < 1024 || options.applicationPort > 65535)) {
    throw new Error('Portal workload application port is invalid');
  }

  let egressSpec: ProjectEgressPlaneSpec | null = null;
  let egressHandle: ProjectEgressPlaneHandle | null = null;
  if (options.networked) {
    const proxyImage = requirePinnedImage(config.projectEgressProxyImageId, 'Project egress proxy image');
    const egressConfig = {
      identity: egressIdentity,
      proxyImage,
      token: derivePortalWorkloadProxyToken(identity),
    };
    egressSpec = buildProjectEgressPlaneSpec(egressConfig);
    egressHandle = await ensureProjectEgressPlane(egressConfig, executor);
  }
  const environment = Object.freeze({
    ...options.environment,
    ...(egressHandle?.proxyEnvironment || {}),
  });
  const runtimeFingerprint = stableHash({
    policy: WORKLOAD_POLICY_VERSION,
    identity,
    workspace,
    image,
    command: options.command,
    args: options.args,
    environment: environmentEntries(environment),
    networked: options.networked,
    egressPolicyFingerprint: egressSpec?.policyFingerprint || null,
    pidsLimit: options.pidsLimit,
    memoryBytes: options.memoryBytes,
    nanoCpus: options.nanoCpus,
    tmpfsSize: options.tmpfsSize,
    applicationPort: options.applicationPort || null,
  });
  return Object.freeze({
    ...options,
    identity,
    egressIdentity,
    workspace: workspace.path,
    workspaceDevice: workspace.device,
    workspaceInode: workspace.inode,
    workspaceBirthtimeNs: workspace.birthtimeNs,
    image,
    containerName,
    environment,
    runtimeFingerprint,
    egressSpec,
    egressHandle,
  });
}

export function buildPortalProjectWorkloadCreateArgs(plan: PortalProjectWorkloadPlan): string[] {
  if (Boolean(plan.egressSpec) !== Boolean(plan.egressHandle)) {
    fail('EGRESS_NETWORK_IDENTITY', 'Portal workload egress plan is incomplete');
  }
  const initialNetwork = plan.egressSpec
    ? String(plan.egressHandle?.internalNetworkId || '').toLowerCase()
    : 'none';
  if (plan.egressSpec && !/^[a-f0-9]{64}$/.test(initialNetwork)) {
    fail('EGRESS_NETWORK_IDENTITY', 'Portal workload internal network identity is invalid');
  }
  const args = [
    'container', 'create',
    '--name', plan.containerName,
    // A networked workload starts attached to the already-attested immutable
    // internal-network ID; confinement re-attests that exact singleton
    // attachment before execution. App traffic stays on that internal bridge:
    // no workload may publish a host port.
    '--network', initialNetwork,
    '--init',
    '--user', '1000:1000',
    '--workdir', '/workspace/project',
    // --mount takes key=value fields only; a bare `rw` (the -v flag style)
    // is rejected by the daemon and broke every project git/workload run.
    // Bind mounts are read-write by default.
    '--mount', `type=bind,src=${plan.workspace},dst=/workspace/project`,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--pids-limit', String(plan.pidsLimit),
    '--memory', String(plan.memoryBytes),
    '--cpus', String(plan.nanoCpus / 1_000_000_000),
    '--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=${plan.tmpfsSize}`,
    '--restart', 'no',
    ...labelArgs(workloadLabels(plan)),
  ];
  for (const entry of environmentEntries(plan.environment)) args.push('--env', entry);
  args.push(plan.image, plan.command, ...plan.args);
  return args;
}

function parseInspect(result: string): ContainerInspect | null {
  let parsed: unknown;
  try { parsed = JSON.parse(result); } catch { fail('INSPECT_JSON', 'Portal workload inspection returned invalid JSON'); }
  if (!Array.isArray(parsed)) fail('INSPECT_SHAPE', 'Portal workload inspection returned an invalid shape');
  if (parsed.length === 0) return null;
  if (parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== 'object') {
    fail('INSPECT_SHAPE', 'Portal workload inspection returned an invalid shape');
  }
  return parsed[0] as ContainerInspect;
}

async function inspectContainer(
  name: string,
  executor: ProjectEgressCommandExecutor,
): Promise<ContainerInspect | null> {
  const result = await executor.run('docker', ['container', 'inspect', name], { allowExitCodes: [0, 1] });
  if (result.exitCode === 1) {
    const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (!text.includes('no such container') && !text.includes('no such object') && !text.includes('not found')) {
      fail('INSPECT_FAILED', 'Portal workload inspection failed without proving absence');
    }
    return null;
  }
  return parseInspect(result.stdout);
}

function hasAll(values: string[] | null | undefined): boolean {
  return Boolean(values?.some((value) => value.toUpperCase() === 'ALL'));
}

function hasNoNewPrivileges(values: string[] | null | undefined): boolean {
  return Boolean(values?.some((value) => value.replace(/[^a-z0-9]/gi, '').toLowerCase() === 'nonewprivilegestrue'));
}

export function attestPortalProjectWorkloadContainer(
  plan: PortalProjectWorkloadPlan,
  inspect: ContainerInspect,
  expected: { running: boolean; networkName: string },
): void {
  const name = String(inspect.Name || '').replace(/^\//, '');
  if (name !== plan.containerName || !/^[a-f0-9]{12,64}$/i.test(String(inspect.Id || ''))) {
    fail('CONTAINER_IDENTITY', 'Portal workload container identity did not match');
  }
  const labels = inspect.Config?.Labels || {};
  for (const [key, value] of Object.entries(workloadLabels(plan))) {
    if (labels[key] !== value) fail('CONTAINER_LABELS', `Portal workload label ${key} did not match`);
  }
  if (inspect.Config?.Image !== plan.image || inspect.Config?.User !== '1000:1000'
    || JSON.stringify(inspect.Config?.Cmd || []) !== JSON.stringify([plan.command, ...plan.args])) {
    fail('CONTAINER_CONFIG', 'Portal workload image, user, or command did not match');
  }
  const actualEnv = new Set(inspect.Config?.Env || []);
  for (const entry of environmentEntries(plan.environment)) {
    if (!actualEnv.has(entry)) fail('CONTAINER_ENVIRONMENT', 'Portal workload environment did not match');
  }
  const host = inspect.HostConfig || {};
  if (host.Privileged || host.ReadonlyRootfs !== true || !hasAll(host.CapDrop) || !hasNoNewPrivileges(host.SecurityOpt)
    || host.PidMode === 'host' || host.IpcMode === 'host' || host.RestartPolicy?.Name !== 'no') {
    fail('CONTAINER_HARDENING', 'Portal workload hardening did not match');
  }
  if (host.PidsLimit !== plan.pidsLimit || host.Memory !== plan.memoryBytes || host.NanoCpus !== plan.nanoCpus) {
    fail('CONTAINER_RESOURCES', 'Portal workload resource policy did not match');
  }
  const tmpfs = host.Tmpfs?.['/tmp'] || '';
  if (!['nosuid', 'nodev', 'noexec', `size=${plan.tmpfsSize}`].every((flag) => tmpfs.split(',').includes(flag))) {
    fail('CONTAINER_TMPFS', 'Portal workload temporary filesystem policy did not match');
  }
  const writableMounts = (inspect.Mounts || []).filter((mount) => mount.RW === true);
  if ((inspect.Mounts || []).length !== 1 || writableMounts.length !== 1
    || writableMounts[0].Type !== 'bind' || writableMounts[0].Source !== plan.workspace
    || writableMounts[0].Destination !== '/workspace/project') {
    fail('CONTAINER_MOUNTS', 'Portal workload must have exactly one writable project bind');
  }
  const bindings = host.PortBindings || {};
  const activeBindings = inspect.NetworkSettings?.Ports || {};
  if (Object.keys(bindings).length > 0
    || Object.values(activeBindings).some((binding) => Array.isArray(binding) && binding.length > 0)) {
    fail('CONTAINER_PORTS', 'Portal workload must not publish host ports');
  }
  if (inspect.State?.Running !== expected.running) fail('CONTAINER_STATE', 'Portal workload running state did not match');
  const attachments = inspect.NetworkSettings?.Networks || {};
  const networks = Object.keys(attachments);
  if (networks.length !== 1 || networks[0] !== expected.networkName || host.NetworkMode === 'host') {
    fail('CONTAINER_NETWORK', 'Portal workload network attachment did not match');
  }
  if (plan.egressSpec) {
    const expectedNetworkId = String(plan.egressHandle?.internalNetworkId || '').toLowerCase();
    const attachedNetworkId = String(attachments[expected.networkName]?.NetworkID || '').toLowerCase();
    // Docker leaves NetworkSettings.Networks[*].NetworkID empty until a
    // container's first start, even when `container create --network` received
    // the immutable network ID. In that one truthful pre-start shape,
    // HostConfig.NetworkMode remains the exact ID supplied at creation. Once
    // started (and after every later stop), require the attachment's own ID.
    const stoppedIdPrimary = expected.running === false
      && inspect.State?.Status === 'created'
      && attachedNetworkId === ''
      && String(host.NetworkMode || '').toLowerCase() === expectedNetworkId;
    if (!/^[a-f0-9]{64}$/.test(expectedNetworkId)
      || (attachedNetworkId !== expectedNetworkId && !stoppedIdPrimary)) {
      fail('CONTAINER_NETWORK', 'Portal workload immutable network identity did not match');
    }
  }
}

export async function preparePortalProjectWorkloadContainer(
  options: PortalProjectWorkloadContainerOptions,
  input: { allowExisting?: boolean; executor?: ProjectEgressCommandExecutor } = {},
): Promise<PortalProjectWorkloadPlan> {
  const executor = input.executor || projectEgressCommandExecutor;
  const plan = await buildPortalProjectWorkloadPlan(options, executor);
  let inspect = await inspectContainer(plan.containerName, executor);
  let created = false;
  try {
    if (inspect) {
      if (!input.allowExisting) fail('CONTAINER_EXISTS', 'A Portal workload container with this identity already exists');
      if (inspect.State?.Running) {
        await executor.run('docker', ['container', 'stop', '--time', '10', plan.containerName]);
        inspect = await inspectContainer(plan.containerName, executor);
      }
    } else {
      await executor.run('docker', buildPortalProjectWorkloadCreateArgs(plan));
      created = true;
      inspect = await inspectContainer(plan.containerName, executor);
    }
    if (!inspect) fail('CONTAINER_CREATE', 'Portal workload container could not be inspected after creation');
    // Networked workloads are created directly on the exact internal egress
    // network; offline one-shot workloads use `none`. Attest that existing
    // attachment before confinement so neither initial creation nor durable
    // app restore can turn an arbitrary network into a fail-open escape hatch.
    attestPortalProjectWorkloadContainer(plan, inspect, {
      running: false,
      networkName: plan.egressSpec?.internalNetworkName || 'none',
    });
    if (plan.egressSpec) {
      await constrainProjectRuntimeToEgressPlane({
        spec: plan.egressSpec,
        runtimeContainerId: String(inspect.Id || ''),
        runtimeContainerName: plan.containerName,
        expectedRuntimeFingerprint: plan.runtimeFingerprint,
        executor,
      });
      inspect = await inspectContainer(plan.containerName, executor);
      if (!inspect) fail('CONTAINER_REINSPECT', 'Portal workload container disappeared after egress confinement');
      attestPortalProjectWorkloadContainer(plan, inspect, {
        running: false,
        networkName: plan.egressSpec.internalNetworkName,
      });
    }
    return plan;
  } catch (error) {
    if (created) await executor.run('docker', ['container', 'rm', '--force', plan.containerName], { allowExitCodes: [0, 1] }).catch(() => undefined);
    if (plan.egressSpec) await teardownExactProjectEgressPlane(plan.egressIdentity, executor).catch(() => undefined);
    throw error;
  }
}

export async function startPreparedPortalProjectWorkloadContainer(
  plan: PortalProjectWorkloadPlan,
  executor: ProjectEgressCommandExecutor = projectEgressCommandExecutor,
): Promise<StartedPortalProjectWorkloadContainer> {
  await executor.run('docker', ['container', 'start', plan.containerName]);
  const inspect = await inspectContainer(plan.containerName, executor);
  if (!inspect) fail('CONTAINER_START', 'Portal workload container disappeared after start');
  const networkName = plan.egressSpec?.internalNetworkName || 'none';
  attestPortalProjectWorkloadContainer(plan, inspect, {
    running: true,
    networkName,
  });
  let networkAddress: string | null = null;
  if (plan.applicationPort !== undefined) {
    if (!plan.egressSpec) {
      fail('CONTAINER_UPSTREAM', 'Portal app runtime has no attested internal egress network');
    }
    const attachment = inspect.NetworkSettings?.Networks?.[networkName];
    networkAddress = String(attachment?.IPAddress || '').trim();
    if (net.isIP(networkAddress) !== 4) {
      fail('CONTAINER_UPSTREAM', 'Portal app runtime has no attested internal IPv4 address');
    }
  }
  return {
    containerId: String(inspect.Id || ''),
    networkAddress,
  };
}

export async function removePreparedPortalProjectWorkloadContainer(
  plan: PortalProjectWorkloadPlan,
  executor: ProjectEgressCommandExecutor = projectEgressCommandExecutor,
): Promise<void> {
  const inspect = await inspectContainer(plan.containerName, executor);
  if (inspect) {
    const labels = inspect.Config?.Labels || {};
    if (labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] !== plan.runtimeFingerprint
      || labels[LABEL_PROJECT] !== plan.identity.projectId
      || labels[LABEL_WORKLOAD] !== plan.identity.workloadId) {
      fail('CONTAINER_REMOVAL_IDENTITY', 'Portal workload identity changed before removal');
    }
    await executor.run('docker', ['container', 'rm', '--force', plan.containerName]);
    if (await inspectContainer(plan.containerName, executor)) {
      fail('CONTAINER_REMOVAL_VERIFY', 'Portal workload container remained after removal');
    }
  }
  if (plan.egressSpec) await teardownExactProjectEgressPlane(plan.egressIdentity, executor);
}

/** Crash/restart cleanup path when only durable server-owned identity remains. */
export async function removePortalProjectWorkloadByIdentity(
  identityInput: PortalProjectWorkloadIdentity,
  containerNameInput: string,
  executor: ProjectEgressCommandExecutor = projectEgressCommandExecutor,
): Promise<void> {
  const identity = workloadIdentity(identityInput);
  const containerName = requireContainerName(containerNameInput);
  const inspect = await inspectContainer(containerName, executor);
  if (inspect) {
    const labels = inspect.Config?.Labels || {};
    if (labels[LABEL_POLICY] !== WORKLOAD_POLICY_VERSION
      || labels[LABEL_ACTOR] !== identity.actorId
      || labels[LABEL_PROJECT] !== identity.projectId
      || labels[LABEL_KIND] !== identity.consumerKind
      || labels[LABEL_WORKLOAD] !== identity.workloadId
      || !/^[a-f0-9]{64}$/i.test(labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] || '')) {
      fail('CONTAINER_REMOVAL_IDENTITY', 'Portal workload durable identity changed before removal');
    }
    await executor.run('docker', ['container', 'rm', '--force', containerName]);
    if (await inspectContainer(containerName, executor)) {
      fail('CONTAINER_REMOVAL_VERIFY', 'Portal workload container remained after durable cleanup');
    }
  }
  await teardownExactProjectEgressPlane(toProjectEgressWorkloadIdentity(identity), executor);
}

async function listProjectWorkloadContainers(
  projectIdInput: string,
  executor: ProjectEgressCommandExecutor,
): Promise<Array<{ name: string; identity: Readonly<PortalProjectWorkloadIdentity> }>> {
  const projectId = requireIdentifier(projectIdInput, 'projectId');
  const listed = await executor.run('docker', [
    'container', 'ls', '--all',
    '--filter', `label=${LABEL_PROJECT}=${projectId}`,
    '--format', '{{.Names}}',
  ]);
  const names = Array.from(new Set(listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))).sort();
  const discovered: Array<{ name: string; identity: Readonly<PortalProjectWorkloadIdentity> }> = [];
  for (const name of names) {
    const inspect = await inspectContainer(name, executor);
    if (!inspect) fail('PROJECT_WORKLOAD_LIST_RACE', 'A listed Portal workload disappeared during cleanup discovery');
    const labels = inspect.Config?.Labels || {};
    const identity = workloadIdentity({
      actorId: String(labels[LABEL_ACTOR] || ''),
      projectId: String(labels[LABEL_PROJECT] || ''),
      consumerKind: labels[LABEL_KIND] as ProjectEgressWorkloadConsumerKind,
      workloadId: String(labels[LABEL_WORKLOAD] || ''),
    });
    if (labels[LABEL_POLICY] !== WORKLOAD_POLICY_VERSION
      || identity.projectId !== projectId
      || !/^[a-f0-9]{64}$/i.test(labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] || '')
      || name !== expectedWorkloadContainerName(identity)) {
      fail('PROJECT_WORKLOAD_IDENTITY', 'Portal workload cleanup discovered an invalid managed identity');
    }
    discovered.push({ name, identity });
  }
  return discovered;
}

/** Project deletion barrier: remove every Portal-owned Git/build/app runtime
 * before the shared egress cleanup verifies that no runtime members remain. */
export async function removePortalProjectWorkloadsForProject(
  projectId: string,
  executor: ProjectEgressCommandExecutor = projectEgressCommandExecutor,
): Promise<number> {
  const initial = await listProjectWorkloadContainers(projectId, executor);
  const second = await listProjectWorkloadContainers(projectId, executor);
  if (JSON.stringify(initial) !== JSON.stringify(second)) {
    fail('PROJECT_WORKLOAD_DISCOVERY_RACE', 'Portal workloads changed during deletion discovery');
  }
  for (const runtime of second) {
    await removePortalProjectWorkloadByIdentity(runtime.identity, runtime.name, executor);
  }
  const after = await listProjectWorkloadContainers(projectId, executor);
  const verified = await listProjectWorkloadContainers(projectId, executor);
  if (after.length > 0 || verified.length > 0 || JSON.stringify(after) !== JSON.stringify(verified)) {
    fail('PROJECT_WORKLOAD_CLEANUP_RESIDUAL', 'Portal workload cleanup left a managed runtime behind');
  }
  return second.length;
}

export const __projectWorkloadRuntimeTest = {
  WORKLOAD_POLICY_VERSION,
  labels: { LABEL_POLICY, LABEL_ACTOR, LABEL_PROJECT, LABEL_KIND, LABEL_WORKLOAD },
  workloadLabels,
  expectedWorkloadContainerName,
};
