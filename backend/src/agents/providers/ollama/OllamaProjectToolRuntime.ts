import crypto from 'crypto';
import path from 'path';
import { spawn } from 'child_process';
import type { ProjectSandboxExecutionContext } from '../../AgentProvider.interface';
import { assertExecutionContextBinding } from '../../executionScope';
import { attestProjectRoot } from '../../../services/projectIdentity';
import { PROJECT_EGRESS_POLICY_VERSION } from '../../../services/projectEgressPolicy';
import {
  PROJECT_RUNTIME_GID,
  PROJECT_RUNTIME_UID,
  PROJECT_RUNTIME_USER,
} from '../../../services/projectRuntimeIdentity';
import {
  assertProjectRuntimeConfinementReadyForExecution,
  attestProjectRuntimeSecurityOptions,
  projectRuntimeSecurityOptArgs,
  projectRuntimeSecurityOptionValues,
} from '../../../services/projectRuntimeConfinement';

export const OLLAMA_PROJECT_RUNTIME = 'ollama-project-coding-agent-v1';
export const OLLAMA_PROJECT_RUNTIME_POLICY_VERSION = 'portal-ollama-project-sandbox-v1';
export const OLLAMA_PROJECT_CONTAINER_ROOT = '/workspace/project';
export const OLLAMA_PROJECT_CONTAINER_HOME = '/home/project-agent';
export const OLLAMA_PROJECT_CONTAINER_USER = PROJECT_RUNTIME_USER;

const CONTAINER_MEMORY_BYTES = 1024 * 1024 * 1024;
const CONTAINER_NANO_CPUS = 2_000_000_000;
const CONTAINER_PIDS_LIMIT = 256;
// The pinned node:22.23.1-bookworm-slim base declares these variables in its
// image config. Docker carries image environment into created containers even
// when Portal supplies its own --env entries, so make the inherited baseline
// explicit and override it to exact policy-owned values.
const OLLAMA_PROJECT_BASE_ENVIRONMENT = Object.freeze({
  NODE_VERSION: '22.23.1',
  YARN_VERSION: '1.22.22',
  DEBIAN_FRONTEND: 'noninteractive',
});
const MAX_HOST_OUTPUT_BYTES = 2 * 1024 * 1024;
const RUNTIME_LABEL_PREFIX = 'com.bridgesllm.ollama-project';
export const OLLAMA_PROJECT_PROVIDER_LABEL = RUNTIME_LABEL_PREFIX + '.provider';
export const OLLAMA_PROJECT_ACTOR_LABEL = RUNTIME_LABEL_PREFIX + '.actor';
export const OLLAMA_PROJECT_IDENTITY_LABEL = RUNTIME_LABEL_PREFIX + '.project';
export const OLLAMA_PROJECT_FINGERPRINT_LABEL = RUNTIME_LABEL_PREFIX + '.fingerprint';
export const OLLAMA_PROJECT_POLICY_LABEL = RUNTIME_LABEL_PREFIX + '.policy';
const IDLE_COMMAND = 'while :; do sleep 3600; done';

export type OllamaProjectToolName = 'project_list' | 'project_read' | 'project_write'
  | 'project_edit' | 'project_search' | 'project_exec';

export const OLLAMA_PROJECT_TOOL_NAMES: readonly OllamaProjectToolName[] = Object.freeze([
  'project_list',
  'project_read',
  'project_write',
  'project_edit',
  'project_search',
  'project_exec',
]);

export interface OllamaProjectToolResult {
  ok: boolean;
  output: string;
  exitCode?: number;
}

export interface OllamaProjectCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface OllamaProjectCommandOptions {
  allowExitCodes?: readonly number[];
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface OllamaProjectCommandExecutor {
  run(command: string, args: readonly string[], options?: OllamaProjectCommandOptions): Promise<OllamaProjectCommandResult>;
}

export interface OllamaProjectRuntimePlan {
  containerName: string;
  runtimeFingerprint: string;
  runtimeImage: string;
  projectRoot: string;
  expectedEnvironment: Readonly<Record<string, string>>;
  expectedLabels: Readonly<Record<string, string>>;
  createArgs: readonly string[];
}

export interface OllamaProjectRuntimeHandle {
  containerId: string;
  containerName: string;
  runtimeFingerprint: string;
  runtimeImage: string;
  startedAt: string;
  accessProof: OllamaProjectRuntimeAccessProof;
}

export interface OllamaProjectRuntimeAccessProof {
  runtimeUid: typeof PROJECT_RUNTIME_UID;
  runtimeGid: typeof PROJECT_RUNTIME_GID;
  projectRwWriteReadUnlink: true;
  evidenceSha256: string;
}

export class OllamaProjectRuntimeTerminationError extends Error {
  readonly code = 'OLLAMA_PROJECT_RUNTIME_TERMINATION_UNCONFIRMED';

  constructor() {
    super('Ollama Project tool stopped without verified runtime termination.');
    this.name = 'OllamaProjectRuntimeTerminationError';
  }
}

interface DockerInspect {
  Id?: string;
  Image?: string;
  Name?: string;
  Config?: {
    Image?: string;
    User?: string;
    WorkingDir?: string;
    Entrypoint?: string[] | null;
    Cmd?: string[] | null;
    Env?: string[] | null;
    Labels?: Record<string, string> | null;
    ExposedPorts?: Record<string, unknown> | null;
    Volumes?: Record<string, unknown> | null;
  };
  State?: { Running?: boolean; Pid?: number; StartedAt?: string };
  AppArmorProfile?: string;
  HostConfig?: {
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
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean; Propagation?: string }>;
  NetworkSettings?: {
    Ports?: Record<string, unknown> | null;
    Networks?: Record<string, unknown> | null;
  };
}

export class OllamaProjectToolRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OllamaProjectToolRuntimeError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new OllamaProjectToolRuntimeError(code, message);
}

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function hashOllamaProjectRuntimeIdentity(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) fail('LABEL_IDENTITY', 'Ollama Project identity is invalid');
  return stableHash(normalized);
}

function requirePinnedImage(value: string): string {
  const image = String(value || '').trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) fail('RUNTIME_IMAGE', 'Ollama Project runtime image must be an immutable Docker image ID');
  return image;
}

function requireProjectContext(context: ProjectSandboxExecutionContext): string {
  assertExecutionContextBinding(context, context.userId, 'PROJECT_SANDBOX');
  if (context.runtimePolicyVersion !== OLLAMA_PROJECT_RUNTIME_POLICY_VERSION) {
    fail('RUNTIME_POLICY', 'Ollama Project runtime policy version does not match');
  }
  if (context.egressPolicyVersion !== PROJECT_EGRESS_POLICY_VERSION) {
    fail('EGRESS_POLICY', 'Ollama Project egress policy version does not match');
  }
  if (!/^[a-f0-9]{64}$/i.test(context.policyFingerprint)) {
    fail('POLICY_FINGERPRINT', 'Ollama Project policy fingerprint is invalid');
  }
  const attested = attestProjectRoot(context.canonicalRoot);
  if (
    attested.canonicalRoot !== path.resolve(context.canonicalRoot)
    || attested.rootDevice !== context.rootDevice
    || attested.rootInode !== context.rootInode
    || attested.rootBirthtimeNs !== context.rootBirthtimeNs
    || attested.canonicalRoot === path.parse(attested.canonicalRoot).root
  ) {
    fail('PROJECT_IDENTITY', 'Ollama Project root identity changed');
  }
  return attested.canonicalRoot;
}

export function buildOllamaProjectRuntimePlan(context: ProjectSandboxExecutionContext): OllamaProjectRuntimePlan {
  const projectRoot = requireProjectContext(context);
  const runtimeImage = requirePinnedImage(context.runtimeImageDigest);
  const expectedEnvironment = Object.freeze({
    ...OLLAMA_PROJECT_BASE_ENVIRONMENT,
    HOME: OLLAMA_PROJECT_CONTAINER_HOME,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  });
  const runtimeFingerprint = stableHash({
    runtime: OLLAMA_PROJECT_RUNTIME,
    policy: OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
    actorId: context.userId,
    projectId: context.projectId,
    workspaceOwnerId: context.workspaceOwnerId,
    projectRoot,
    rootDevice: context.rootDevice,
    rootInode: context.rootInode,
    rootBirthtimeNs: context.rootBirthtimeNs,
    policyFingerprint: context.policyFingerprint,
    runtimeImage,
    network: 'none',
    confinementSecurityOptions: projectRuntimeSecurityOptionValues(),
  });
  const containerName = 'p4ol-' + runtimeFingerprint.slice(0, 24);
  const expectedLabels = Object.freeze({
    [OLLAMA_PROJECT_PROVIDER_LABEL]: 'OLLAMA',
    [OLLAMA_PROJECT_ACTOR_LABEL]: hashOllamaProjectRuntimeIdentity(context.userId),
    [OLLAMA_PROJECT_IDENTITY_LABEL]: hashOllamaProjectRuntimeIdentity(context.projectId),
    [OLLAMA_PROJECT_FINGERPRINT_LABEL]: runtimeFingerprint,
    [OLLAMA_PROJECT_POLICY_LABEL]: OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
  });
  const createArgs: string[] = ['container', 'create', '--name', containerName];
  for (const [key, value] of Object.entries(expectedLabels)) createArgs.push('--label', key + '=' + value);
  createArgs.push(
    '--network', 'none',
    '--user', OLLAMA_PROJECT_CONTAINER_USER,
    '--workdir', OLLAMA_PROJECT_CONTAINER_ROOT,
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
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=67108864',
    '--tmpfs', OLLAMA_PROJECT_CONTAINER_HOME + `:rw,noexec,nosuid,nodev,size=16777216,uid=${PROJECT_RUNTIME_UID},gid=${PROJECT_RUNTIME_GID},mode=0700`,
    '--volume', projectRoot + ':' + OLLAMA_PROJECT_CONTAINER_ROOT + ':rw,rprivate',
  );
  for (const [key, value] of Object.entries(expectedEnvironment)) createArgs.push('--env', key + '=' + value);
  createArgs.push('--entrypoint', '/bin/sh', runtimeImage, '-lc', IDLE_COMMAND);
  return Object.freeze({
    containerName,
    runtimeFingerprint,
    runtimeImage,
    projectRoot,
    expectedEnvironment,
    expectedLabels,
    createArgs: Object.freeze(createArgs),
  });
}

function environmentMap(entries: string[] | null | undefined): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const entry of entries || []) {
    const index = entry.indexOf('=');
    const key = index >= 0 ? entry.slice(0, index) : entry;
    const value = index >= 0 ? entry.slice(index + 1) : '';
    result.set(key, [...(result.get(key) || []), value]);
  }
  return result;
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactOllamaProjectUlimits(
  actual: Array<{ Name?: string; Soft?: number; Hard?: number }> | null | undefined,
): boolean {
  if (!Array.isArray(actual) || actual.length !== 2) return false;
  const byName = new Map<string, { soft: number; hard: number }>();
  for (const entry of actual) {
    const name = typeof entry?.Name === 'string' ? entry.Name : '';
    if (!name || byName.has(name) || !Number.isSafeInteger(entry.Soft) || !Number.isSafeInteger(entry.Hard)) {
      return false;
    }
    byName.set(name, { soft: Number(entry.Soft), hard: Number(entry.Hard) });
  }
  return byName.get('nofile')?.soft === 1024
    && byName.get('nofile')?.hard === 1024
    && byName.get('nproc')?.soft === 256
    && byName.get('nproc')?.hard === 256;
}

function exactOllamaProjectNetworklessState(
  networks: Record<string, unknown> | null | undefined,
): boolean {
  if (!networks || Object.keys(networks).length === 0) return true;
  if (Object.keys(networks).length !== 1 || !Object.prototype.hasOwnProperty.call(networks, 'none')) {
    return false;
  }
  const endpoint = networks.none;
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) return false;
  const record = endpoint as Record<string, unknown>;
  const allowedFields = new Set([
    'IPAMConfig',
    'Links',
    'Aliases',
    'MacAddress',
    'DriverOpts',
    'GwPriority',
    'NetworkID',
    'EndpointID',
    'Gateway',
    'IPAddress',
    'IPPrefixLen',
    'IPv6Gateway',
    'GlobalIPv6Address',
    'GlobalIPv6PrefixLen',
    'DNSNames',
  ]);
  if (Object.keys(record).some((key) => !allowedFields.has(key))) return false;
  const absentOrEmptyString = (value: unknown) => value == null || value === '';
  const absentOrZero = (value: unknown) => value == null || value === 0;
  const absentOrEmptyCollection = (value: unknown) => value == null
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0);
  return absentOrEmptyCollection(record.IPAMConfig)
    && absentOrEmptyCollection(record.Links)
    && absentOrEmptyCollection(record.Aliases)
    && absentOrEmptyString(record.MacAddress)
    && absentOrEmptyCollection(record.DriverOpts)
    && absentOrZero(record.GwPriority)
    // Docker assigns opaque IDs for its built-in `none` network endpoint.
    // They are identity only; the address, route, DNS, and link fields below
    // must remain empty, and no second network key is permitted.
    && (record.NetworkID == null || typeof record.NetworkID === 'string')
    && (record.EndpointID == null || typeof record.EndpointID === 'string')
    && absentOrEmptyString(record.Gateway)
    && absentOrEmptyString(record.IPAddress)
    && absentOrZero(record.IPPrefixLen)
    && absentOrEmptyString(record.IPv6Gateway)
    && absentOrEmptyString(record.GlobalIPv6Address)
    && absentOrZero(record.GlobalIPv6PrefixLen)
    && absentOrEmptyCollection(record.DNSNames);
}

export function attestOllamaProjectRuntimeContainer(input: {
  inspect: DockerInspect;
  plan: OllamaProjectRuntimePlan;
  requireRunning: boolean;
}): { containerId: string; startedAt: string } {
  const { inspect, plan } = input;
  const containerId = String(inspect.Id || '');
  if (!/^[a-f0-9]{64}$/i.test(containerId)) fail('CONTAINER_ID', 'Ollama Project container identity is invalid');
  if (String(inspect.Name || '').replace(/^\//, '') !== plan.containerName) fail('CONTAINER_NAME', 'Ollama Project container name changed');
  if (String(inspect.Image || '').toLowerCase() !== plan.runtimeImage || String(inspect.Config?.Image || '').toLowerCase() !== plan.runtimeImage) {
    fail('CONTAINER_IMAGE', 'Ollama Project container image identity changed');
  }
  if (
    inspect.Config?.User !== OLLAMA_PROJECT_CONTAINER_USER
    || inspect.Config?.WorkingDir !== OLLAMA_PROJECT_CONTAINER_ROOT
    || !exactJson(inspect.Config?.Entrypoint || [], ['/bin/sh'])
    || !exactJson(inspect.Config?.Cmd || [], ['-lc', IDLE_COMMAND])
  ) {
    fail('CONTAINER_PROCESS', 'Ollama Project container process identity changed');
  }
  const labels = inspect.Config?.Labels || {};
  for (const [key, value] of Object.entries(plan.expectedLabels)) {
    if (labels[key] !== value) fail('CONTAINER_LABELS', 'Ollama Project container labels changed');
  }
  const host = inspect.HostConfig || {};
  try {
    attestProjectRuntimeSecurityOptions({
      securityOpt: host.SecurityOpt,
      appArmorProfile: inspect.AppArmorProfile,
    });
  } catch {
    fail('CONTAINER_CONFINEMENT', 'Ollama Project container confinement profiles changed');
  }
  if (
    host.ReadonlyRootfs !== true
    || !Array.isArray(host.CapDrop)
    || !host.CapDrop.map((value) => value.toUpperCase()).includes('ALL')
    || (host.CapAdd?.length || 0) > 0
    || !host.SecurityOpt?.includes('no-new-privileges:true')
    || host.Privileged
    || host.PidMode === 'host'
    || host.IpcMode === 'host'
    || host.UTSMode === 'host'
    || host.UsernsMode === 'host'
    || host.CgroupnsMode === 'host'
    || host.RestartPolicy?.Name !== 'no'
    || host.AutoRemove
    || host.OomKillDisable
  ) {
    fail('CONTAINER_HARDENING', 'Ollama Project container hardening changed');
  }
  if (
    host.PidsLimit !== CONTAINER_PIDS_LIMIT
    || host.Memory !== CONTAINER_MEMORY_BYTES
    || host.MemorySwap !== CONTAINER_MEMORY_BYTES
    || host.NanoCpus !== CONTAINER_NANO_CPUS
  ) {
    fail('CONTAINER_RESOURCES', 'Ollama Project container resource limits changed');
  }
  if (!exactOllamaProjectUlimits(host.Ulimits)) {
    fail('CONTAINER_ULIMITS', 'Ollama Project container ulimits changed');
  }
  const expectedTmpfs = new Map<string, readonly string[]>([
    ['/tmp', ['rw', 'noexec', 'nosuid', 'nodev', 'size=67108864']],
    [OLLAMA_PROJECT_CONTAINER_HOME, [
      'rw',
      'noexec',
      'nosuid',
      'nodev',
      'size=16777216',
      `uid=${PROJECT_RUNTIME_UID}`,
      `gid=${PROJECT_RUNTIME_GID}`,
      'mode=0700',
    ]],
  ]);
  const actualTmpfs = host.Tmpfs || {};
  if (Object.keys(actualTmpfs).length !== expectedTmpfs.size) fail('CONTAINER_TMPFS', 'Ollama Project tmpfs policy changed');
  for (const [target, required] of expectedTmpfs) {
    const flags = new Set(String(actualTmpfs[target] || '').split(','));
    if (flags.size !== required.length || required.some((flag) => !flags.has(flag))) {
      fail('CONTAINER_TMPFS', 'Ollama Project tmpfs policy changed');
    }
  }
  if (
    host.NetworkMode !== 'none'
    || !exactOllamaProjectNetworklessState(inspect.NetworkSettings?.Networks)
    || (host.Dns?.length || 0) > 0
    || (host.DnsOptions?.length || 0) > 0
    || (host.DnsSearch?.length || 0) > 0
    || (host.ExtraHosts?.length || 0) > 0
    || (host.Links?.length || 0) > 0
  ) {
    fail('CONTAINER_NETWORK', 'Ollama Project container must remain completely networkless');
  }
  if (
    (host.Devices?.length || 0) > 0
    || (host.DeviceRequests?.length || 0) > 0
    || (host.DeviceCgroupRules?.length || 0) > 0
    || (host.VolumesFrom?.length || 0) > 0
    || host.PublishAllPorts
    || Object.keys(host.PortBindings || {}).length > 0
    || Object.keys(inspect.NetworkSettings?.Ports || {}).length > 0
    || Object.keys(inspect.Config?.ExposedPorts || {}).length > 0
    || Object.keys(inspect.Config?.Volumes || {}).length > 0
    || (host.Mounts?.length || 0) > 0
  ) {
    fail('CONTAINER_EXPOSURE', 'Ollama Project container exposes an undeclared host resource');
  }
  const mounts = (inspect.Mounts || []).map((mount) => ({
    type: mount.Type,
    source: mount.Source ? path.resolve(mount.Source) : '',
    destination: mount.Destination,
    rw: mount.RW,
    propagation: mount.Propagation || 'rprivate',
  }));
  if (!exactJson(mounts, [{
    type: 'bind',
    source: plan.projectRoot,
    destination: OLLAMA_PROJECT_CONTAINER_ROOT,
    rw: true,
    propagation: 'rprivate',
  }])) {
    fail('CONTAINER_MOUNTS', 'Ollama Project container must have exactly one writable Project bind');
  }
  const binds = host.Binds || [];
  if (binds.length !== 1 || binds[0] !== plan.projectRoot + ':' + OLLAMA_PROJECT_CONTAINER_ROOT + ':rw,rprivate') {
    fail('CONTAINER_BINDS', 'Ollama Project bind declaration changed');
  }
  const environment = environmentMap(inspect.Config?.Env);
  if (environment.size !== Object.keys(plan.expectedEnvironment).length) {
    fail('CONTAINER_ENVIRONMENT', 'Ollama Project container inherited undeclared environment');
  }
  for (const [key, value] of Object.entries(plan.expectedEnvironment)) {
    if (!exactJson(environment.get(key), [value])) fail('CONTAINER_ENVIRONMENT', 'Ollama Project environment changed');
  }
  for (const key of environment.keys()) {
    if (/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|PROXY|OLLAMA)/i.test(key)) {
      fail('CONTAINER_SECRETS', 'Ollama Project container received a credential or network override');
    }
  }
  if (inspect.State?.Running !== input.requireRunning) {
    fail('CONTAINER_STATE', 'Ollama Project container state changed');
  }
  if (input.requireRunning && (!Number.isSafeInteger(inspect.State?.Pid) || Number(inspect.State?.Pid) < 2 || !inspect.State?.StartedAt)) {
    fail('CONTAINER_PROCESS', 'Ollama Project container process is unavailable');
  }
  return { containerId, startedAt: String(inspect.State?.StartedAt || '') };
}

class SpawnOllamaProjectCommandExecutor implements OllamaProjectCommandExecutor {
  async run(
    command: string,
    args: readonly string[],
    options: OllamaProjectCommandOptions = {},
  ): Promise<OllamaProjectCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const maximum = options.maxOutputBytes || MAX_HOST_OUTPUT_BYTES;
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(error);
      };
      const collect = (target: Buffer[], chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maximum) {
          finishError(new OllamaProjectToolRuntimeError('COMMAND_OUTPUT', 'Ollama Project command output exceeded the safety limit'));
          return;
        }
        target.push(Buffer.from(chunk));
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.once('error', () => finishError(new OllamaProjectToolRuntimeError('COMMAND_START', 'Ollama Project host command failed to start')));
      const timeout = setTimeout(() => finishError(new OllamaProjectToolRuntimeError('COMMAND_TIMEOUT', 'Ollama Project command timed out')), options.timeoutMs || 30_000);
      const onAbort = () => finishError(new OllamaProjectToolRuntimeError('COMMAND_ABORTED', 'Ollama Project command was aborted'));
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.once('close', (code) => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        const result = {
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: code ?? 1,
        };
        if (!(options.allowExitCodes || [0]).includes(result.exitCode)) {
          reject(new OllamaProjectToolRuntimeError('COMMAND_EXIT', 'Ollama Project command exited with ' + result.exitCode));
        } else {
          resolve(result);
        }
      });
      child.stdin.end(options.input || '');
    });
  }
}

export const ollamaProjectCommandExecutor: OllamaProjectCommandExecutor = new SpawnOllamaProjectCommandExecutor();

async function inspectContainer(
  executor: OllamaProjectCommandExecutor,
  identity: string,
): Promise<DockerInspect | null> {
  const result = await executor.run('docker', ['container', 'inspect', identity], { allowExitCodes: [0, 1] });
  if (result.exitCode === 1) {
    if (!/no such (?:object|container)|not found/i.test(result.stderr)) {
      fail('CONTAINER_DISCOVERY', 'Ollama Project container absence could not be proven');
    }
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('one inspect required');
    return parsed[0] as DockerInspect;
  } catch {
    fail('CONTAINER_INSPECT', 'Ollama Project container inspect returned invalid JSON');
  }
}

const TOOL_RUNNER = String.raw`
import json, os, re, signal, subprocess, sys, tempfile
ROOT = os.path.realpath('/workspace/project')
MAX_TEXT = 1024 * 1024
def clean_rel(value):
    if not isinstance(value, str) or '\x00' in value or os.path.isabs(value):
        raise ValueError('path must be project-relative')
    value = value.strip() or '.'
    target = os.path.realpath(os.path.join(ROOT, value))
    if os.path.commonpath([ROOT, target]) != ROOT:
        raise ValueError('path escapes project')
    return target
def text(value, maximum=MAX_TEXT):
    if not isinstance(value, str):
        raise ValueError('text argument is required')
    if len(value.encode('utf-8')) > maximum:
        raise ValueError('text exceeds safety limit')
    return value
def atomic_write(target, content):
    parent = os.path.dirname(target)
    os.makedirs(parent, exist_ok=True)
    if os.path.islink(target):
        raise ValueError('refusing to replace symbolic link')
    fd, temporary = tempfile.mkstemp(prefix='.portal-ollama-', dir=parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
def emit(ok, output, exit_code=None):
    body = {'ok': bool(ok), 'output': str(output)[:524288]}
    if exit_code is not None: body['exitCode'] = int(exit_code)
    sys.stdout.write(json.dumps(body, separators=(',', ':')))
try:
    request = json.loads(sys.stdin.read())
    action = request.get('action')
    args = request.get('args') or {}
    if not isinstance(args, dict): raise ValueError('tool arguments must be an object')
    if action == 'project_list':
        target = clean_rel(args.get('path', '.'))
        if not os.path.isdir(target): raise ValueError('directory not found')
        rows = []
        for entry in sorted(os.scandir(target), key=lambda item: item.name)[:500]:
            kind = 'symlink' if entry.is_symlink() else 'dir' if entry.is_dir(follow_symlinks=False) else 'file'
            rows.append(kind + '\t' + os.path.relpath(entry.path, ROOT))
        emit(True, '\n'.join(rows))
    elif action == 'project_read':
        target = clean_rel(args.get('path'))
        if not os.path.isfile(target) or os.path.islink(target): raise ValueError('regular file not found')
        start = max(1, int(args.get('start_line', 1)))
        count = min(2000, max(1, int(args.get('line_count', 400))))
        with open(target, 'r', encoding='utf-8', errors='replace') as handle:
            lines = handle.readlines()
        selected = lines[start - 1:start - 1 + count]
        emit(True, ''.join(str(start + index) + ': ' + line for index, line in enumerate(selected)))
    elif action == 'project_write':
        target = clean_rel(args.get('path'))
        content = text(args.get('content'))
        atomic_write(target, content)
        emit(True, 'wrote ' + str(len(content.encode('utf-8'))) + ' bytes to ' + os.path.relpath(target, ROOT))
    elif action == 'project_edit':
        target = clean_rel(args.get('path'))
        if not os.path.isfile(target) or os.path.islink(target): raise ValueError('regular file not found')
        old = text(args.get('old_text'))
        new = text(args.get('new_text'))
        if not old: raise ValueError('old_text cannot be empty')
        with open(target, 'r', encoding='utf-8', errors='strict') as handle: current = handle.read(MAX_TEXT + 1)
        if len(current.encode('utf-8')) > MAX_TEXT: raise ValueError('file exceeds safety limit')
        occurrences = current.count(old)
        if occurrences != 1: raise ValueError('old_text must match exactly once; matched ' + str(occurrences))
        atomic_write(target, current.replace(old, new, 1))
        emit(True, 'edited ' + os.path.relpath(target, ROOT))
    elif action == 'project_search':
        query = text(args.get('query'), 4096)
        target = clean_rel(args.get('path', '.'))
        use_regex = args.get('regex') is True
        matcher = re.compile(query) if use_regex else None
        matches = []
        for base, dirs, files in os.walk(target, followlinks=False):
            dirs[:] = [name for name in dirs if name not in {'.git', 'node_modules', '.venv', 'dist', 'build'}][:200]
            for name in sorted(files)[:1000]:
                candidate = os.path.join(base, name)
                if os.path.islink(candidate) or os.path.getsize(candidate) > MAX_TEXT: continue
                try:
                    with open(candidate, 'r', encoding='utf-8', errors='replace') as handle:
                        for number, line in enumerate(handle, 1):
                            if (matcher.search(line) if matcher else query in line):
                                matches.append(os.path.relpath(candidate, ROOT) + ':' + str(number) + ':' + line.rstrip())
                                if len(matches) >= 200: break
                except OSError: pass
                if len(matches) >= 200: break
            if len(matches) >= 200: break
        emit(True, '\n'.join(matches))
    elif action == 'project_exec':
        command = text(args.get('command'), 10000)
        cwd = clean_rel(args.get('cwd', '.'))
        if not os.path.isdir(cwd): raise ValueError('working directory not found')
        timeout = min(120, max(1, int(args.get('timeout_seconds', 60))))
        env = {'HOME': '/home/project-agent', 'TMPDIR': '/tmp', 'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'}
        process = subprocess.Popen(['/bin/sh', '-lc', command], cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            stdout, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, _ = process.communicate()
            emit(False, stdout.decode('utf-8', errors='replace') + '\ncommand timed out', 124)
        else:
            output = stdout.decode('utf-8', errors='replace')
            emit(process.returncode == 0, output, process.returncode)
    else:
        raise ValueError('unsupported project tool')
except Exception as error:
    emit(False, str(error))
`;

const RUNTIME_ACCESS_PROBE = String.raw`
import hashlib, json, os, shutil, stat, sys
ROOT = os.path.realpath('/workspace/project')
nonce = sys.argv[1]
digest = hashlib.sha256(nonce.encode('utf-8')).hexdigest()
target = os.path.join(ROOT, '.portal-ollama-rw-probe-' + digest[:24])
fd = None
removed = False
try:
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    if hasattr(os, 'O_NOFOLLOW'): flags |= os.O_NOFOLLOW
    fd = os.open(target, flags, 0o600)
    payload = nonce.encode('utf-8')
    if os.write(fd, payload) != len(payload): raise RuntimeError('short write')
    os.fsync(fd)
    os.close(fd)
    fd = None
    info = os.lstat(target)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_gid != os.getgid():
        raise RuntimeError('probe identity mismatch')
    with open(target, 'rb') as handle:
        if handle.read() != payload: raise RuntimeError('probe readback mismatch')
    os.unlink(target)
    removed = not os.path.lexists(target)
finally:
    if fd is not None: os.close(fd)
    if os.path.lexists(target): os.unlink(target)
print(json.dumps({
    'uid': os.getuid(),
    'gid': os.getgid(),
    'cwd': os.getcwd(),
    'python': shutil.which('python3'),
    'shell': shutil.which('sh'),
    'git': shutil.which('git'),
    'node': shutil.which('node'),
    'ripgrep': shutil.which('rg'),
    'writeReadUnlink': removed,
    'evidenceSha256': digest,
}, separators=(',', ':')))
`;

// Every runtime instance (provider sends, qualification, and cleanup recovery)
// participates in the same actor/project container lifecycle. Keeping this
// map at module scope prevents a second adapter instance from recreating the
// deterministic container while another instance is proving its removal.
const ollamaProjectLifecycleTails = new Map<string, Promise<void>>();

export class OllamaProjectToolRuntime {
  private readonly executor: OllamaProjectCommandExecutor;
  private readonly assertConfinementReady: () => void;
  private readonly qualifiedContainers = new Map<string, OllamaProjectRuntimeAccessProof>();

  constructor(
    executor: OllamaProjectCommandExecutor = ollamaProjectCommandExecutor,
    assertConfinementReady: () => void = () => {
      assertProjectRuntimeConfinementReadyForExecution();
    },
  ) {
    this.executor = executor;
    this.assertConfinementReady = assertConfinementReady;
  }

  private async withLifecycleLock<T>(
    context: ProjectSandboxExecutionContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = buildOllamaProjectRuntimePlan(context).containerName;
    const previous = ollamaProjectLifecycleTails.get(key) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    ollamaProjectLifecycleTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (ollamaProjectLifecycleTails.get(key) === tail) ollamaProjectLifecycleTails.delete(key);
    }
  }

  private async removeOwned(plan: OllamaProjectRuntimePlan, inspect: DockerInspect): Promise<void> {
    attestOllamaProjectRuntimeContainer({ inspect, plan, requireRunning: inspect.State?.Running === true });
    const containerId = String(inspect.Id);
    await this.executor.run('docker', ['container', 'rm', '-f', containerId]);
    this.qualifiedContainers.delete(containerId);
  }

  private async ensureUnlocked(context: ProjectSandboxExecutionContext): Promise<OllamaProjectRuntimeHandle> {
    this.assertConfinementReady();
    const plan = buildOllamaProjectRuntimePlan(context);
    const image = await this.executor.run('docker', ['image', 'inspect', '--format', '{{.Id}}', plan.runtimeImage]);
    if (image.stdout.trim().toLowerCase() !== plan.runtimeImage) fail('RUNTIME_IMAGE', 'Installed Ollama Project runtime image identity did not match');

    let inspect = await inspectContainer(this.executor, plan.containerName);
    if (inspect?.State?.Running === true) {
      const attested = attestOllamaProjectRuntimeContainer({ inspect, plan, requireRunning: true });
      const accessProof = await this.qualifyRuntimeAccess(attested.containerId, false);
      return Object.freeze({
        containerId: attested.containerId,
        containerName: plan.containerName,
        runtimeFingerprint: plan.runtimeFingerprint,
        runtimeImage: plan.runtimeImage,
        startedAt: attested.startedAt,
        accessProof,
      });
    }
    if (inspect) {
      await this.removeOwned(plan, inspect);
      inspect = null;
    }

    try {
      await this.executor.run('docker', plan.createArgs);
      await this.executor.run('docker', ['container', 'start', plan.containerName]);
      inspect = await inspectContainer(this.executor, plan.containerName);
      if (!inspect) fail('CONTAINER_CREATE', 'Ollama Project container disappeared during creation');
      const attested = attestOllamaProjectRuntimeContainer({ inspect, plan, requireRunning: true });
      const accessProof = await this.qualifyRuntimeAccess(attested.containerId, true);
      return Object.freeze({
        containerId: attested.containerId,
        containerName: plan.containerName,
        runtimeFingerprint: plan.runtimeFingerprint,
        runtimeImage: plan.runtimeImage,
        startedAt: attested.startedAt,
        accessProof,
      });
    } catch (error) {
      const candidate = await inspectContainer(this.executor, plan.containerName).catch(() => null);
      if (candidate) await this.removeOwned(plan, candidate).catch(() => undefined);
      throw error;
    }
  }

  async ensure(context: ProjectSandboxExecutionContext): Promise<OllamaProjectRuntimeHandle> {
    return this.withLifecycleLock(context, () => this.ensureUnlocked(context));
  }

  /**
   * Re-proves the actual bind as the runtime identity. Image and mount
   * inspection alone cannot establish that uid/gid 1000 can edit a real
   * customer checkout, so qualification performs a write/read/unlink round
   * trip through the exact mounted Project directory.
   */
  private async qualifyRuntimeAccess(
    containerId: string,
    force: boolean,
  ): Promise<OllamaProjectRuntimeAccessProof> {
    const cached = this.qualifiedContainers.get(containerId);
    if (cached && !force) return cached;
    const nonce = crypto.randomBytes(32).toString('base64url');
    const result = await this.executor.run('docker', [
      'container', 'exec', '--user', OLLAMA_PROJECT_CONTAINER_USER,
      '--workdir', OLLAMA_PROJECT_CONTAINER_ROOT,
      containerId, 'python3', '-c', RUNTIME_ACCESS_PROBE, nonce,
    ]);
    let proof: any;
    try { proof = JSON.parse(result.stdout); } catch { fail('TOOL_PROOF', 'Ollama Project runtime tool proof was invalid'); }
    const expectedEvidence = crypto.createHash('sha256').update(nonce).digest('hex');
    if (
      proof?.uid !== PROJECT_RUNTIME_UID
      || proof?.gid !== PROJECT_RUNTIME_GID
      || proof?.cwd !== OLLAMA_PROJECT_CONTAINER_ROOT
      || !proof?.python
      || !proof?.shell
      || !proof?.git
      || !proof?.node
      || !proof?.ripgrep
      || proof?.writeReadUnlink !== true
      || proof?.evidenceSha256 !== expectedEvidence
    ) {
      fail('TOOL_PROOF', 'Ollama Project runtime does not provide the exact confined coding toolchain');
    }
    const accessProof = Object.freeze({
      runtimeUid: PROJECT_RUNTIME_UID,
      runtimeGid: PROJECT_RUNTIME_GID,
      projectRwWriteReadUnlink: true as const,
      evidenceSha256: expectedEvidence,
    });
    this.qualifiedContainers.set(containerId, accessProof);
    return accessProof;
  }

  /** Force a fresh live access proof for admission evidence. */
  async qualify(context: ProjectSandboxExecutionContext): Promise<OllamaProjectRuntimeHandle> {
    const runtime = await this.ensure(context);
    const accessProof = await this.qualifyRuntimeAccess(runtime.containerId, true);
    return Object.freeze({ ...runtime, accessProof });
  }

  async runTool(
    context: ProjectSandboxExecutionContext,
    toolName: OllamaProjectToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OllamaProjectToolResult> {
    if (!OLLAMA_PROJECT_TOOL_NAMES.includes(toolName)) fail('TOOL_NAME', 'Ollama Project tool is not allowed');
    const payload = JSON.stringify({ action: toolName, args });
    if (Buffer.byteLength(payload, 'utf8') > 2 * 1024 * 1024) fail('TOOL_INPUT', 'Ollama Project tool input exceeded the safety limit');
    if (signal?.aborted) {
      const error = new Error('Ollama Project tool was aborted before runtime admission');
      error.name = 'AbortError';
      throw error;
    }
    try {
      const plan = buildOllamaProjectRuntimePlan(context);
      const runtime = await this.ensure(context);
      if (signal?.aborted) {
        const error = new Error('Ollama Project tool was aborted during runtime admission');
        error.name = 'AbortError';
        throw error;
      }
      const inspect = await inspectContainer(this.executor, runtime.containerId);
      if (!inspect) fail('CONTAINER_STATE', 'Ollama Project container disappeared');
      attestOllamaProjectRuntimeContainer({ inspect, plan, requireRunning: true });
      const result = await this.executor.run('docker', [
        'container', 'exec', '-i', '--user', OLLAMA_PROJECT_CONTAINER_USER,
        '--workdir', OLLAMA_PROJECT_CONTAINER_ROOT,
        runtime.containerId, 'python3', '-c', TOOL_RUNNER,
      ], {
        input: payload,
        timeoutMs: toolName === 'project_exec' ? 130_000 : 30_000,
        maxOutputBytes: 1024 * 1024,
        signal,
      });
      const parsed = JSON.parse(result.stdout);
      if (!parsed || typeof parsed.ok !== 'boolean' || typeof parsed.output !== 'string') {
        fail('TOOL_RESULT', 'Ollama Project tool returned an invalid result');
      }
      return {
        ok: parsed.ok,
        output: parsed.output.slice(0, 524_288),
        ...(Number.isSafeInteger(parsed.exitCode) ? { exitCode: parsed.exitCode } : {}),
      };
    } catch (error: any) {
      if (signal?.aborted || error?.code === 'COMMAND_TIMEOUT' || error?.code === 'COMMAND_ABORTED') {
        let stopped = false;
        try { stopped = await this.terminate(context) === true; } catch { stopped = false; }
        if (!stopped) {
          throw new OllamaProjectRuntimeTerminationError();
        }
      }
      throw error;
    }
  }

  private async terminateUnlocked(context: ProjectSandboxExecutionContext): Promise<boolean> {
    const plan = buildOllamaProjectRuntimePlan(context);
    const inspect = await inspectContainer(this.executor, plan.containerName);
    if (inspect) await this.removeOwned(plan, inspect);
    const remaining = await inspectContainer(this.executor, plan.containerName);
    if (!remaining) return true;
    // A remaining object must still be proved as the exact actor/project
    // runtime before reporting an unconfirmed stop. Never collapse an
    // untrusted name collision into a generic boolean.
    attestOllamaProjectRuntimeContainer({
      inspect: remaining,
      plan,
      requireRunning: remaining.State?.Running === true,
    });
    return false;
  }

  async terminate(context: ProjectSandboxExecutionContext): Promise<boolean> {
    return this.withLifecycleLock(context, () => this.terminateUnlocked(context));
  }

  async abort(context: ProjectSandboxExecutionContext): Promise<boolean> {
    return this.terminate(context);
  }
}

export async function cleanupOllamaProjectRuntimeByIdentity(input: {
  actorUserId: string;
  projectIdentityId: string;
  executor?: OllamaProjectCommandExecutor;
}): Promise<number> {
  const executor = input.executor || ollamaProjectCommandExecutor;
  const actor = hashOllamaProjectRuntimeIdentity(input.actorUserId);
  const project = hashOllamaProjectRuntimeIdentity(input.projectIdentityId);
  const listed = await executor.run('docker', [
    'container', 'ls', '-aq',
    '--filter', 'label=' + OLLAMA_PROJECT_PROVIDER_LABEL + '=OLLAMA',
    '--filter', 'label=' + OLLAMA_PROJECT_ACTOR_LABEL + '=' + actor,
    '--filter', 'label=' + OLLAMA_PROJECT_IDENTITY_LABEL + '=' + project,
  ]);
  const ids = listed.stdout.split(/\s+/).filter(Boolean);
  let removed = 0;
  for (const id of ids) {
    const inspect = await inspectContainer(executor, id);
    const labels = inspect?.Config?.Labels || {};
    if (
      !inspect
      || labels[OLLAMA_PROJECT_PROVIDER_LABEL] !== 'OLLAMA'
      || labels[OLLAMA_PROJECT_ACTOR_LABEL] !== actor
      || labels[OLLAMA_PROJECT_IDENTITY_LABEL] !== project
      || labels[OLLAMA_PROJECT_POLICY_LABEL] !== OLLAMA_PROJECT_RUNTIME_POLICY_VERSION
    ) {
      fail('CLEANUP_ATTESTATION', 'Ollama Project cleanup discovered an untrusted container');
    }
    await executor.run('docker', ['container', 'rm', '-f', String(inspect.Id)]);
    removed += 1;
  }
  return removed;
}

function requireOllamaHistoricalRecoveryContext(
  context: ProjectSandboxExecutionContext,
): string {
  assertExecutionContextBinding(context, context.userId, 'PROJECT_SANDBOX');
  if (!/^portal-ollama-project-sandbox-v[1-9][0-9]*$/.test(context.runtimePolicyVersion)) {
    fail('RUNTIME_POLICY', 'Ollama Project historical runtime policy version is invalid');
  }
  if (!/^portal-project-egress-v[1-9][0-9]*$/.test(context.egressPolicyVersion)) {
    fail('EGRESS_POLICY', 'Ollama Project historical egress policy version is invalid');
  }
  requirePinnedImage(context.runtimeImageDigest);
  const expectedFingerprint = stableHash({
    version: context.runtimePolicyVersion,
    egressPolicyVersion: context.egressPolicyVersion,
    provider: 'OLLAMA',
    runtime: OLLAMA_PROJECT_RUNTIME,
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
  if (context.policyFingerprint !== expectedFingerprint) {
    fail('POLICY_FINGERPRINT', 'Ollama Project historical policy fingerprint is invalid');
  }
  const root = attestProjectRoot(context.canonicalRoot);
  if (
    root.canonicalRoot !== context.canonicalRoot
    || root.rootDevice !== context.rootDevice
    || root.rootInode !== context.rootInode
    || root.rootBirthtimeNs !== context.rootBirthtimeNs
  ) {
    fail('PROJECT_IDENTITY', 'Ollama Project root identity changed');
  }
  return root.canonicalRoot;
}

function attestOllamaHistoricalRecoveryTarget(
  inspect: DockerInspect,
  context: ProjectSandboxExecutionContext,
): { containerId: string; running: boolean } {
  const containerId = String(inspect.Id || '').toLowerCase();
  const labels = inspect.Config?.Labels || {};
  const runtimeFingerprint = String(labels[OLLAMA_PROJECT_FINGERPRINT_LABEL] || '').toLowerCase();
  const mounts = (inspect.Mounts || []).map((mount) => ({
    type: mount.Type,
    source: mount.Source ? path.resolve(mount.Source) : '',
    destination: mount.Destination,
    rw: mount.RW,
    propagation: mount.Propagation || 'rprivate',
  }));
  if (
    !/^[a-f0-9]{64}$/.test(containerId)
    || !/^[a-f0-9]{64}$/.test(runtimeFingerprint)
    || String(inspect.Name || '').replace(/^\//, '') !== `p4ol-${runtimeFingerprint.slice(0, 24)}`
    || String(inspect.Image || '').toLowerCase() !== context.runtimeImageDigest.toLowerCase()
    || String(inspect.Config?.Image || '').toLowerCase() !== context.runtimeImageDigest.toLowerCase()
    || inspect.Config?.User !== OLLAMA_PROJECT_CONTAINER_USER
    || inspect.Config?.WorkingDir !== OLLAMA_PROJECT_CONTAINER_ROOT
    || !exactJson(inspect.Config?.Entrypoint || [], ['/bin/sh'])
    || !exactJson(inspect.Config?.Cmd || [], ['-lc', IDLE_COMMAND])
    || labels[OLLAMA_PROJECT_PROVIDER_LABEL] !== 'OLLAMA'
    || labels[OLLAMA_PROJECT_ACTOR_LABEL] !== hashOllamaProjectRuntimeIdentity(context.userId)
    || labels[OLLAMA_PROJECT_IDENTITY_LABEL] !== hashOllamaProjectRuntimeIdentity(context.projectId)
    || labels[OLLAMA_PROJECT_POLICY_LABEL] !== context.runtimePolicyVersion
    || !exactJson(mounts, [{
      type: 'bind',
      source: context.canonicalRoot,
      destination: OLLAMA_PROJECT_CONTAINER_ROOT,
      rw: true,
      propagation: 'rprivate',
    }])
    || typeof inspect.State?.Running !== 'boolean'
  ) {
    fail('RECOVERY_ATTESTATION', 'Ollama Project restart target lost its immutable identity');
  }
  return { containerId, running: inspect.State.Running };
}

/**
 * Stop, but never delete, every exact container generation owned by a
 * server-persisted historical turn context.
 */
export async function stopOllamaProjectRuntimesForRecoveryContext(
  context: ProjectSandboxExecutionContext,
  executor: OllamaProjectCommandExecutor = ollamaProjectCommandExecutor,
): Promise<readonly string[]> {
  requireOllamaHistoricalRecoveryContext(context);
  const actor = hashOllamaProjectRuntimeIdentity(context.userId);
  const project = hashOllamaProjectRuntimeIdentity(context.projectId);
  const listed = await executor.run('docker', [
    'container', 'ls', '-a', '--no-trunc',
    '--filter', `${OLLAMA_PROJECT_PROVIDER_LABEL}=OLLAMA`,
    '--filter', `${OLLAMA_PROJECT_ACTOR_LABEL}=${actor}`,
    '--filter', `${OLLAMA_PROJECT_IDENTITY_LABEL}=${project}`,
    '--format', '{{.ID}}',
  ]);
  const ids = listed.stdout.split(/\r?\n/).map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (
    ids.length > 8
    || new Set(ids).size !== ids.length
    || ids.some((value) => !/^[a-f0-9]{64}$/.test(value))
  ) {
    fail('RECOVERY_DISCOVERY', 'Ollama Project restart discovery was ambiguous');
  }

  const attested: Array<{ containerId: string; running: boolean }> = [];
  for (const id of ids) {
    const inspect = await inspectContainer(executor, id);
    if (!inspect) continue;
    const target = attestOllamaHistoricalRecoveryTarget(inspect, context);
    if (target.containerId !== id) {
      fail('RECOVERY_ATTESTATION', 'Ollama Project runtime changed during stop attestation');
    }
    attested.push(target);
  }

  const stopped: string[] = [];
  for (const target of attested) {
    if (target.running) {
      await executor.run(
        'docker',
        ['container', 'stop', '--time', '3', target.containerId],
        { allowExitCodes: [0, 1] },
      );
    }
    const after = await inspectContainer(executor, target.containerId);
    if (after) {
      const reattested = attestOllamaHistoricalRecoveryTarget(after, context);
      if (reattested.containerId !== target.containerId || reattested.running) {
        fail('RECOVERY_UNCONFIRMED', 'Ollama Project runtime remained active after stop');
      }
    }
    stopped.push(target.containerId);
  }
  requireOllamaHistoricalRecoveryContext(context);
  return Object.freeze(stopped);
}
