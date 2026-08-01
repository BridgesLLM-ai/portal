import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { ProjectSandboxExecutionContext } from '../agents/AgentProvider.interface';
import { attestProjectRoot } from './projectIdentity';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';
import {
  PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL,
  buildProjectEgressPlaneSpec,
  constrainProjectRuntimeToEgressPlane,
  derivePreConfinementProjectEgressPolicyFingerprint,
  ensureProjectEgressPlane,
  resolveRecognizedProjectEgressInternalNetworkBinding,
  type ProjectEgressCommandExecutor,
  type ProjectEgressPlaneConfig,
  type ProjectEgressPlaneHandle,
  type ProjectEgressInternalNetworkBinding,
  type ProjectEgressPlaneSpec,
} from './projectEgressPlane';
import { PROJECT_EGRESS_POLICY_VERSION } from './projectEgressPolicy';
import { OPENCLAW_PROJECT_EMBEDDED_RUNTIME_MODEL_KEYS } from './openclawProjectModel';
import {
  PROJECT_RUNTIME_APPARMOR_PROFILE,
  PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY,
  PROJECT_RUNTIME_SECCOMP_PROFILE_PATH,
  assertProjectRuntimeConfinementReadyForExecution,
  attestPreConfinementProjectRuntimeSecurityOptions,
  attestProjectRuntimeSecurityOptions,
  projectRuntimeSecurityOptArgs,
  resolveProjectRuntimeConfinementPolicy,
} from './projectRuntimeConfinement';

/**
 * OpenClaw 2026.7.1-compatible Project Chat isolation policy.
 *
 * This service deliberately does not send a chat turn. Callers must obtain
 * their project turn lease, call this immediately before every new/resumed
 * turn, and only send after it returns successfully.
 */
export const OPENCLAW_PROJECT_RUNTIME_POLICY_VERSION = 'portal-project-sandbox-v2';
export const OPENCLAW_PROJECT_ACTOR_LABEL = 'com.bridgesllm.openclaw-project.actor';
export const OPENCLAW_PROJECT_IDENTITY_LABEL = 'com.bridgesllm.openclaw-project.identity';
export const OPENCLAW_PROJECT_AGENT_LABEL = 'com.bridgesllm.openclaw-project.agent';

const OPENCLAW_SANDBOX_MOUNT_FORMAT_VERSION = 3;
const OPENCLAW_PROJECT_WORKDIR = '/workspace';
const OPENCLAW_PROJECT_MOUNT = '/workspace/project';
// The agent's working directory is the project itself, not the ro skeleton.
const OPENCLAW_PROJECT_CWD = OPENCLAW_PROJECT_MOUNT;
const OPENCLAW_CONTAINER_USER = '1000:1000';
const OPENCLAW_CONTAINER_MEMORY_BYTES = 1024 * 1024 * 1024;
const OPENCLAW_CONTAINER_NANO_CPUS = 2_000_000_000;
const OPENCLAW_CONTAINER_PIDS_LIMIT = 256;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const CONFIG_RPC_TIMEOUT_MS = 15_000;

const OPENCLAW_PROJECT_TOOL_ALLOW = Object.freeze([
  'exec',
  'process',
  'read',
  'write',
  'edit',
  'apply_patch',
]);

// Explicit direct names accompany groups because OpenClaw automatically adds
// `image` to non-empty allowlists unless it is explicitly denied.
const OPENCLAW_PROJECT_TOOL_DENY = Object.freeze([
  'group:web',
  'group:media',
  'group:ui',
  'group:messaging',
  'group:nodes',
  'group:automation',
  'group:sessions',
  'group:agents',
  'group:openclaw',
  'group:plugins',
  'web_search',
  'x_search',
  'web_fetch',
  'image',
  'browser',
  'canvas',
  'message',
  'nodes',
  'cron',
  'gateway',
  'sessions_spawn',
  'sessions_send',
]);

const EXPLICIT_PROXY_ENV_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
]);

interface GatewayRpcResponse {
  ok: boolean;
  data?: any;
  error?: any;
}

export interface OpenClawProjectSandboxInput {
  context: ProjectSandboxExecutionContext;
  /** Server-owned OpenClaw agent id. */
  agentId: string;
  /** Server-owned session key in `agent:<agentId>:...` form. */
  sessionKey: string;
  /** Root of OpenClaw state. Derived runtime paths never use project data. */
  openClawHome?: string;
  /** Stable, persisted egress token and pinned proxy image. */
  egress: ProjectEgressPlaneConfig;
}

export interface OpenClawProjectSandboxResult {
  agentId: string;
  sessionKey: string;
  containerId: string;
  containerStartedAt: string;
  containerName: string;
  configHash: string;
  runtimeFingerprint: string;
  egressPolicyFingerprint: string;
  attestedAt: string;
}

export interface OpenClawProjectSandboxDependencies {
  rpc(method: string, params: Record<string, any>, timeoutMs?: number): Promise<GatewayRpcResponse>;
  executor: ProjectEgressCommandExecutor;
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
  now(): Date;
}

interface OpenClawConfigSnapshot {
  config: Record<string, any>;
  hash: string;
}

export interface OpenClawProjectSandboxPlan {
  actorUserId: string;
  projectIdentityId: string;
  agentId: string;
  sessionKey: string;
  agentWorkspaceDir: string;
  sandboxWorkspaceRoot: string;
  sandboxWorkspaceDir: string;
  projectRoot: string;
  desiredAgent: Record<string, any>;
  desiredDocker: Record<string, any>;
  containerName: string;
  configHash: string;
  runtimeFingerprint: string;
  expectedBinds: readonly string[];
  expectedEnvironment: Readonly<Record<string, string>>;
  internalNetworkId: string | null;
  networkMode: string;
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
  State?: { Running?: boolean; StartedAt?: string };
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
    Networks?: Record<string, { NetworkID?: string }>;
  };
}

// Successful full ensures record their converged identity here so repeated
// panel opens and project switches skip the container stop/attest/start
// cycle. Entries are advisory: the fast path re-verifies the live container
// with one inspect and any mismatch falls back to the full ensure.
const CONVERGED_RUNTIME_TTL_MS = 10 * 60_000;
const convergedRuntimeCache = new Map<string, {
  runtimeFingerprint: string;
  egressPolicyFingerprint: string;
  attestedAtMs: number;
}>();

export function invalidateConvergedProjectRuntime(containerName?: string): void {
  if (containerName) convergedRuntimeCache.delete(containerName);
  else convergedRuntimeCache.clear();
}

function syntheticEgressHandle(
  spec: ProjectEgressPlaneSpec,
  _egressPolicyVersion: string,
  internalNetworkId = '',
): ProjectEgressPlaneHandle {
  const proxyUrl = `http://portal:${encodeURIComponent(spec.token)}@${spec.proxyAlias}:${spec.proxyPort}`;
  return {
    policyVersion: PROJECT_EGRESS_POLICY_VERSION,
    policyFingerprint: spec.policyFingerprint,
    internalNetworkName: spec.internalNetworkName,
    internalNetworkId,
    publicNetworkName: spec.publicNetworkName,
    proxyContainerName: spec.proxyContainerName,
    proxyUrl,
    proxyEnvironment: Object.freeze({
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: '',
      no_proxy: '',
    }),
  };
}

export class OpenClawProjectSandboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OpenClawProjectSandboxError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new OpenClawProjectSandboxError(code, message);
}

// Recent fingerprint → serialized inputs, kept small; consulted only when a
// runtime label mismatch needs its diverging field named in the log.
const runtimeFingerprintDebugRegistry = new Map<string, string>();
const RUNTIME_FINGERPRINT_DEBUG_LIMIT = 32;

function recordFingerprintDebugTrim(): void {
  while (runtimeFingerprintDebugRegistry.size > RUNTIME_FINGERPRINT_DEBUG_LIMIT) {
    const oldest = runtimeFingerprintDebugRegistry.keys().next().value;
    if (oldest === undefined) break;
    runtimeFingerprintDebugRegistry.delete(oldest);
  }
}

export function explainRuntimeFingerprintMismatch(expected: string, found: string): string {
  recordFingerprintDebugTrim();
  const expectedInputs = runtimeFingerprintDebugRegistry.get(expected);
  const foundInputs = runtimeFingerprintDebugRegistry.get(found);
  if (!expectedInputs || !foundInputs) return '';
  try {
    const left = JSON.parse(expectedInputs) as Record<string, string>;
    const right = JSON.parse(foundInputs) as Record<string, string>;
    const diffs = Object.keys(left)
      .filter((key) => left[key] !== right[key])
      .map((key) => `${key}: expected=${left[key]} found=${right[key]}`);
    return diffs.length ? ` Diverging inputs → ${diffs.join('; ')}` : '';
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableNormalize(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map(stableNormalize).filter((entry) => entry !== undefined);
  }
  if (isRecord(value)) {
    const normalized: Record<string, unknown> = {};
    // OpenClaw 2026.7.1 uses localeCompare here; bytewise Array.sort would
    // produce a different container config hash for mixed-case proxy env keys.
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
      const entry = stableNormalize(value[key]);
      if (entry !== undefined) normalized[key] = entry;
    }
    return normalized;
  }
  return value;
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(stableSerialize(value)).digest('hex');
}

export function hashOpenClawProjectLabelIdentity(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    fail('RUNTIME_LABEL_IDENTITY', 'OpenClaw Project runtime label identity is invalid');
  }
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableSerialize(left) === stableSerialize(right);
}

function requirePinnedImageDigest(value: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) {
    fail('UNPINNED_RUNTIME_IMAGE', 'OpenClaw Project runtime image must be an immutable sha256 digest');
  }
  return normalized;
}

function requireAgentId(value: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(normalized)) {
    fail('INVALID_AGENT_ID', 'OpenClaw Project agent id is invalid');
  }
  return normalized;
}

export function deriveOpenClawProjectAgentId(
  context: Pick<ProjectSandboxExecutionContext, 'userId' | 'projectId'>,
): string {
  const actorId = String(context.userId || '').trim();
  const projectId = String(context.projectId || '').trim();
  if (
    !actorId
    || !projectId
    || /[\u0000-\u001f\u007f]/.test(actorId)
    || /[\u0000-\u001f\u007f]/.test(projectId)
  ) {
    fail('AGENT_IDENTITY', 'OpenClaw Project agent identity inputs are invalid');
  }
  const identityHash = crypto.createHash('sha256')
    .update(actorId)
    .update('\0')
    .update(projectId)
    .digest('hex')
    .slice(0, 40);
  return `p4oc-${identityHash}`;
}

export function deriveOpenClawProjectSessionKey(
  context: Pick<ProjectSandboxExecutionContext, 'userId' | 'projectId'>,
): string {
  return `agent:${deriveOpenClawProjectAgentId(context)}:portal-project`;
}

function assertServerOwnedRuntimeIdentity(
  context: ProjectSandboxExecutionContext,
  agentIdInput: string,
  sessionKeyInput: string,
): { agentId: string; sessionKey: string } {
  const agentId = requireAgentId(agentIdInput);
  if (agentId !== deriveOpenClawProjectAgentId(context)) {
    fail('AGENT_IDENTITY', 'OpenClaw Project agent id did not match its immutable actor/project identity');
  }
  const sessionKey = requireSessionKey(sessionKeyInput, agentId);
  if (sessionKey !== deriveOpenClawProjectSessionKey(context)) {
    fail('SESSION_IDENTITY', 'OpenClaw Project session key did not match its immutable actor/project identity');
  }
  return { agentId, sessionKey };
}

function requireSessionKey(value: string, agentId: string): string {
  const normalized = String(value || '').trim();
  if (
    normalized.length < 1
    || normalized.length > 512
    || /[\u0000-\u001f\u007f]/.test(normalized)
    || !normalized.startsWith(`agent:${agentId}:`)
  ) {
    fail('INVALID_SESSION_KEY', 'OpenClaw Project session key is not bound to its server-owned agent');
  }
  return normalized;
}

function requireAbsoluteSafePath(value: string, label: string): string {
  const resolved = path.resolve(String(value || ''));
  if (!path.isAbsolute(String(value || '')) || resolved.includes('\0') || resolved.includes(':')) {
    fail('INVALID_RUNTIME_PATH', `${label} is not a safe absolute host path`);
  }
  return resolved;
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function ensurePrivateDirectory(target: string): string {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const entry = fs.lstatSync(target);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    fail('RUNTIME_PATH_IDENTITY', 'OpenClaw Project runtime path is not a real directory');
  }
  fs.chmodSync(target, 0o700);
  const canonical = fs.realpathSync.native(target);
  if (canonical !== target) {
    fail('RUNTIME_PATH_IDENTITY', 'OpenClaw Project runtime path resolved through a symbolic link');
  }
  return canonical;
}

// The directory bind-mounted as the container's /workspace must be traversable
// by the sandbox uid (1000) or the agent cannot reach the rw project mount at
// /workspace/project. 0711 grants traverse only (no list, no write); the host
// parent chain stays 0700 root, so only the container — via Docker's
// root-performed mount — ever reaches it.
function ensureTraversableDirectory(target: string): string {
  fs.mkdirSync(target, { recursive: true, mode: 0o711 });
  const entry = fs.lstatSync(target);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    fail('RUNTIME_PATH_IDENTITY', 'OpenClaw Project runtime path is not a real directory');
  }
  fs.chmodSync(target, 0o711);
  const stat = fs.statSync(target);
  if ((stat.mode & 0o022) !== 0) {
    fail('RUNTIME_PATH_IDENTITY', 'OpenClaw Project workspace mount is group/other writable');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('RUNTIME_PATH_IDENTITY', 'OpenClaw Project workspace mount has an unexpected owner');
  }
  const canonical = fs.realpathSync.native(target);
  if (canonical !== target) {
    fail('RUNTIME_PATH_IDENTITY', 'OpenClaw Project runtime path resolved through a symbolic link');
  }
  return canonical;
}

function assertProjectContext(context: ProjectSandboxExecutionContext): void {
  if (context.scope !== 'PROJECT_SANDBOX' || context.source !== 'PORTAL_SERVER') {
    fail('EXECUTION_SCOPE', 'OpenClaw Project runtime requires a server-owned PROJECT_SANDBOX context');
  }
  if (context.runtimePolicyVersion !== OPENCLAW_PROJECT_RUNTIME_POLICY_VERSION) {
    fail('RUNTIME_POLICY_VERSION', 'OpenClaw Project runtime policy version did not match');
  }
  if (context.egressPolicyVersion !== PROJECT_EGRESS_POLICY_VERSION) {
    fail('EGRESS_POLICY_VERSION', 'OpenClaw Project egress policy version did not match');
  }
  if (!/^[a-f0-9]{64}$/i.test(context.policyFingerprint)) {
    fail('POLICY_FINGERPRINT', 'OpenClaw Project policy fingerprint is invalid');
  }
  requirePinnedImageDigest(context.runtimeImageDigest);
  const root = attestProjectRoot(context.canonicalRoot);
  if (
    root.canonicalRoot !== context.canonicalRoot
    || root.rootDevice !== context.rootDevice
    || root.rootInode !== context.rootInode
    || root.rootBirthtimeNs !== context.rootBirthtimeNs
  ) {
    fail('PROJECT_ROOT_IDENTITY', 'OpenClaw Project root no longer matches its immutable identity');
  }
}

function assertEgressIdentity(
  context: ProjectSandboxExecutionContext,
  egress: ProjectEgressPlaneConfig,
): void {
  if (
    egress.identity.actorId !== context.userId
    || egress.identity.projectId !== context.projectId
    || String(egress.identity.provider || '').toUpperCase() !== 'OPENCLAW'
  ) {
    fail('EGRESS_IDENTITY', 'OpenClaw Project egress identity did not match the execution context');
  }
}

/** OpenClaw 2026.7.1-compatible session slug. */
export function slugifyOpenClawProjectSessionKey(value: string): string {
  const trimmed = value.trim() || 'session';
  const hash = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 8);
  const normalized = trimmed.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'session';
  return `${normalized}-${hash}`;
}

function buildDesiredDocker(input: {
  image: string;
  containerPrefix: string;
  network: string;
  projectRoot: string;
  proxyEnvironment: Readonly<Record<string, string>>;
}): Record<string, any> {
  const confinementPolicy = resolveProjectRuntimeConfinementPolicy();
  return {
    image: input.image,
    containerPrefix: input.containerPrefix,
    workdir: OPENCLAW_PROJECT_CWD,
    readOnlyRoot: true,
    tmpfs: [
      '/tmp:rw,noexec,nosuid,nodev,size=67108864',
      '/var/tmp:rw,noexec,nosuid,nodev,size=67108864',
      '/run:rw,noexec,nosuid,nodev,size=16777216',
    ],
    network: input.network,
    user: OPENCLAW_CONTAINER_USER,
    capDrop: ['ALL'],
    env: {
      LANG: 'C.UTF-8',
      HOME: '/home/openclaw',
      TMPDIR: '/tmp',
      ...input.proxyEnvironment,
    },
    setupCommand: '',
    pidsLimit: OPENCLAW_CONTAINER_PIDS_LIMIT,
    memory: OPENCLAW_CONTAINER_MEMORY_BYTES,
    memorySwap: OPENCLAW_CONTAINER_MEMORY_BYTES,
    cpus: 2,
    ulimits: {
      nofile: { soft: 1024, hard: 1024 },
      nproc: { soft: 256, hard: 256 },
    },
    // Empty strings/arrays intentionally override unsafe global defaults.
    seccompProfile: PROJECT_RUNTIME_SECCOMP_PROFILE_PATH,
    apparmorProfile: confinementPolicy === PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY
      ? PROJECT_RUNTIME_APPARMOR_PROFILE
      : '',
    dns: [],
    extraHosts: [],
    binds: [`${input.projectRoot}:${OPENCLAW_PROJECT_MOUNT}:rw`],
    dangerouslyAllowReservedContainerTargets: true,
    dangerouslyAllowExternalBindSources: true,
    dangerouslyAllowContainerNamespaceJoin: false,
  };
}

function buildLegacyPreConfinementDesiredDocker(input: {
  image: string;
  containerPrefix: string;
  network: string;
  projectRoot: string;
  proxyEnvironment: Readonly<Record<string, string>>;
}): Record<string, any> {
  return {
    ...buildDesiredDocker(input),
    // Exact values written by the legacy pre-confinement generation.
    // Docker itself supplied the engine-default seccomp/AppArmor profiles.
    seccompProfile: '',
    apparmorProfile: '',
  };
}

function buildDesiredAgent(input: {
  agentId: string;
  agentWorkspaceDir: string;
  sandboxWorkspaceRoot: string;
  docker: Record<string, any>;
}): Record<string, any> {
  const allow = [...OPENCLAW_PROJECT_TOOL_ALLOW];
  const deny = [...OPENCLAW_PROJECT_TOOL_DENY];
  return {
    id: input.agentId,
    workspace: input.agentWorkspaceDir,
    // Never inherit a host CLI/plugin runtime or global model fallback. Every
    // supported provider family is forced through the embedded OpenClaw runner.
    model: { fallbacks: [] },
    models: Object.fromEntries(OPENCLAW_PROJECT_EMBEDDED_RUNTIME_MODEL_KEYS.map((modelRef) => [
      modelRef,
      { agentRuntime: { id: 'openclaw' } },
    ])),
    sandbox: {
      mode: 'all',
      backend: 'docker',
      workspaceAccess: 'none',
      scope: 'session',
      workspaceRoot: input.sandboxWorkspaceRoot,
      docker: input.docker,
      browser: {
        enabled: false,
        allowHostControl: false,
        autoStart: false,
        binds: [],
      },
    },
    tools: {
      allow,
      deny,
      elevated: { enabled: false },
      exec: {
        host: 'sandbox',
        security: 'full',
        ask: 'off',
        strictInlineEval: true,
        applyPatch: { enabled: true, workspaceOnly: true },
      },
      fs: { workspaceOnly: true },
      sandbox: { tools: { allow: [...allow], deny: [...deny] } },
    },
  };
}

function resolveEffectiveDocker(config: Record<string, any>, agent: Record<string, any>): Record<string, any> {
  const globalDocker = config?.agents?.defaults?.sandbox?.docker;
  const agentDocker = agent?.sandbox?.docker;
  const global = isRecord(globalDocker) ? globalDocker : {};
  const local = isRecord(agentDocker) ? agentDocker : {};
  const env = isRecord(local.env)
    ? { ...(isRecord(global.env) ? global.env : { LANG: 'C.UTF-8' }), ...local.env }
    : (isRecord(global.env) ? global.env : { LANG: 'C.UTF-8' });
  const ulimits = isRecord(local.ulimits)
    ? { ...(isRecord(global.ulimits) ? global.ulimits : {}), ...local.ulimits }
    : (isRecord(global.ulimits) ? global.ulimits : undefined);
  const binds = [
    ...(Array.isArray(global.binds) ? global.binds : []),
    ...(Array.isArray(local.binds) ? local.binds : []),
  ];
  const first = (key: string, fallback?: unknown) => local[key] ?? global[key] ?? fallback;
  const gpus = String(first('gpus', '') || '').trim() || undefined;
  return {
    image: first('image', 'openclaw-sandbox:bookworm-slim'),
    containerPrefix: first('containerPrefix', 'openclaw-sbx-'),
    workdir: first('workdir', '/workspace'),
    readOnlyRoot: first('readOnlyRoot', true),
    tmpfs: first('tmpfs', ['/tmp', '/var/tmp', '/run']),
    network: first('network', 'none'),
    user: first('user'),
    capDrop: first('capDrop', ['ALL']),
    env,
    setupCommand: first('setupCommand'),
    pidsLimit: first('pidsLimit'),
    memory: first('memory'),
    memorySwap: first('memorySwap'),
    cpus: first('cpus'),
    gpus,
    ulimits,
    seccompProfile: first('seccompProfile'),
    apparmorProfile: first('apparmorProfile'),
    dns: first('dns'),
    extraHosts: first('extraHosts'),
    binds: binds.length ? binds : undefined,
    dangerouslyAllowReservedContainerTargets:
      local.dangerouslyAllowReservedContainerTargets ?? global.dangerouslyAllowReservedContainerTargets,
    dangerouslyAllowExternalBindSources:
      local.dangerouslyAllowExternalBindSources ?? global.dangerouslyAllowExternalBindSources,
    dangerouslyAllowContainerNamespaceJoin:
      local.dangerouslyAllowContainerNamespaceJoin ?? global.dangerouslyAllowContainerNamespaceJoin,
  };
}

export function computeOpenClawProjectConfigHash(input: {
  docker: Record<string, any>;
  sandboxWorkspaceDir: string;
  agentWorkspaceDir: string;
}): string {
  return stableHash({
    docker: input.docker,
    workspaceAccess: 'none',
    workspaceDir: input.sandboxWorkspaceDir,
    agentWorkspaceDir: input.agentWorkspaceDir,
    mountFormatVersion: OPENCLAW_SANDBOX_MOUNT_FORMAT_VERSION,
    readOnlyWorkspaceSkillMounts: [],
  });
}

function buildOpenClawRuntimeFingerprint(input: {
  context: ProjectSandboxExecutionContext;
  egressPolicyFingerprint: string;
  image: string;
  agentId: string;
  sessionKey: string;
  configHash: string;
}): { fingerprint: string; inputs: Record<string, string> } {
  const inputs = {
    provider: 'OPENCLAW',
    actorId: input.context.userId,
    projectId: input.context.projectId,
    workspaceOwnerId: input.context.workspaceOwnerId,
    policyFingerprint: input.context.policyFingerprint,
    runtimePolicyVersion: input.context.runtimePolicyVersion,
    egressPolicyVersion: input.context.egressPolicyVersion,
    egressPolicyFingerprint: input.egressPolicyFingerprint,
    runtimeImageDigest: input.image,
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    configHash: input.configHash,
  };
  return { fingerprint: stableHash(inputs), inputs };
}

function buildRuntimePaths(input: {
  context: ProjectSandboxExecutionContext;
  agentId: string;
  sessionKey: string;
  openClawHome?: string;
}): {
  agentWorkspaceDir: string;
  sandboxWorkspaceRoot: string;
  sandboxWorkspaceDir: string;
} {
  const requestedHome = requireAbsoluteSafePath(
    input.openClawHome || process.env.OPENCLAW_HOME || path.join(process.env.HOME || '/root', '.openclaw'),
    'OpenClaw home',
  );
  if (
    pathContains(input.context.canonicalRoot, requestedHome)
    || pathContains(requestedHome, input.context.canonicalRoot)
  ) {
    fail('RUNTIME_PROJECT_OVERLAP', 'OpenClaw state and Project data paths must not overlap');
  }
  const home = ensurePrivateDirectory(requestedHome);
  if (pathContains(input.context.canonicalRoot, home) || pathContains(home, input.context.canonicalRoot)) {
    fail('RUNTIME_PROJECT_OVERLAP', 'OpenClaw state and Project data paths must not overlap');
  }
  const actor = stableHash(input.context.userId).slice(0, 20);
  const project = stableHash(input.context.projectId).slice(0, 20);
  const agentWorkspaceDir = ensurePrivateDirectory(path.join(
    home, 'project-agents', actor, project, input.agentId,
  ));
  const sandboxWorkspaceRoot = ensurePrivateDirectory(path.join(
    home, 'sandboxes', 'portal-project', actor, project, input.agentId,
  ));
  const sandboxWorkspaceDir = ensureTraversableDirectory(path.join(
    sandboxWorkspaceRoot, slugifyOpenClawProjectSessionKey(input.sessionKey),
  ));
  // The project bind mounts at <workspace>/project inside the workspace bind;
  // the mountpoint must exist and be traversable so the sandbox uid can enter
  // it (the rw project bind overlays it with the project's own perms).
  ensureTraversableDirectory(path.join(sandboxWorkspaceDir, 'project'));
  return { agentWorkspaceDir, sandboxWorkspaceRoot, sandboxWorkspaceDir };
}

export function buildOpenClawProjectSandboxPlan(input: {
  context: ProjectSandboxExecutionContext;
  agentId: string;
  sessionKey: string;
  openClawHome?: string;
  egressSpec: ProjectEgressPlaneSpec;
  egressHandle: ProjectEgressPlaneHandle;
  useHistoricalNetworkMode?: boolean;
}): OpenClawProjectSandboxPlan {
  assertProjectContext(input.context);
  const { agentId, sessionKey } = assertServerOwnedRuntimeIdentity(
    input.context,
    input.agentId,
    input.sessionKey,
  );
  const image = requirePinnedImageDigest(input.context.runtimeImageDigest);
  const projectRoot = requireAbsoluteSafePath(input.context.canonicalRoot, 'Project root');
  const paths = buildRuntimePaths({
    context: input.context,
    agentId,
    sessionKey,
    openClawHome: input.openClawHome,
  });
  const containerPrefix = `p4oc-${input.context.policyFingerprint.slice(0, 16)}-`;
  const internalNetworkId = String(input.egressHandle.internalNetworkId || '').toLowerCase();
  if (internalNetworkId && !/^[a-f0-9]{64}$/.test(internalNetworkId)) {
    fail('RUNTIME_NETWORK_MODE', 'OpenClaw Project internal network ID is invalid');
  }
  const networkMode = internalNetworkId && !input.useHistoricalNetworkMode
    ? internalNetworkId
    : input.egressSpec.internalNetworkName;
  const desiredDocker = buildDesiredDocker({
    image,
    containerPrefix,
    network: input.egressSpec.internalNetworkName,
    projectRoot,
    proxyEnvironment: input.egressHandle.proxyEnvironment,
  });
  const desiredAgent = buildDesiredAgent({
    agentId,
    agentWorkspaceDir: paths.agentWorkspaceDir,
    sandboxWorkspaceRoot: paths.sandboxWorkspaceRoot,
    docker: desiredDocker,
  });
  const configHash = computeOpenClawProjectConfigHash({
    docker: desiredDocker,
    sandboxWorkspaceDir: paths.sandboxWorkspaceDir,
    agentWorkspaceDir: paths.agentWorkspaceDir,
  });
  const containerName = `${containerPrefix}${slugifyOpenClawProjectSessionKey(sessionKey)}`.slice(0, 63);
  const runtimeGeneration = buildOpenClawRuntimeFingerprint({
    context: input.context,
    egressPolicyFingerprint: input.egressSpec.policyFingerprint,
    image,
    agentId,
    sessionKey,
    configHash,
  });
  const runtimeFingerprint = runtimeGeneration.fingerprint;
  // Fingerprint drift between two ensure paths for the same runtime is a
  // correctness bug; the per-field summary (ids/digests only, no secrets)
  // identifies the diverging input without exposing configuration values.
  runtimeFingerprintDebugRegistry.set(runtimeFingerprint, JSON.stringify(runtimeGeneration.inputs));
  return {
    actorUserId: input.context.userId,
    projectIdentityId: input.context.projectId,
    agentId,
    sessionKey,
    ...paths,
    projectRoot,
    desiredAgent,
    desiredDocker,
    containerName,
    configHash,
    runtimeFingerprint,
    expectedBinds: Object.freeze([
      `${paths.sandboxWorkspaceDir}:${OPENCLAW_PROJECT_WORKDIR}:ro,z`,
      `${projectRoot}:${OPENCLAW_PROJECT_MOUNT}:rw`,
    ]),
    expectedEnvironment: Object.freeze({
      ...desiredDocker.env,
      OPENCLAW_CLI: '1',
    }),
    internalNetworkId: internalNetworkId || null,
    networkMode,
  };
}

async function readOpenClawConfig(
  rpc: OpenClawProjectSandboxDependencies['rpc'],
): Promise<OpenClawConfigSnapshot> {
  const response = await rpc('config.get', {}, CONFIG_RPC_TIMEOUT_MS);
  if (!response.ok) fail('CONFIG_GET_FAILED', 'OpenClaw Project config could not be read');
  const config = response.data?.config ?? response.data?.parsed;
  const hash = String(response.data?.hash || '').trim();
  if (!isRecord(config) || !hash) {
    fail('CONFIG_GET_INVALID', 'OpenClaw Project config response was incomplete');
  }
  return { config, hash };
}

function findAgent(config: Record<string, any>, agentId: string): Record<string, any> | null {
  const agents = config?.agents?.list;
  if (!Array.isArray(agents)) return null;
  const matches = agents.filter((entry) => isRecord(entry) && entry.id === agentId);
  if (matches.length > 1) fail('DUPLICATE_AGENT', 'OpenClaw Project agent identity is duplicated');
  return matches[0] || null;
}

/**
 * OpenClaw resolves the default agent as `agents.list[].default`, else the
 * FIRST list entry (fallback `main`). Project agents joining the list can
 * therefore silently capture default routing — auth probes and agent-unscoped
 * CLI operations then execute inside a project docker sandbox instead of the
 * host `main` agent. Pin `default: true` on `main` whenever it is present.
 */
function withMainAgentDefaultRouting(agents: unknown[]): unknown[] {
  const hasMain = agents.some((entry) => isRecord(entry) && entry.id === 'main');
  if (!hasMain) return agents;
  return agents.map((entry) => (
    isRecord(entry) && entry.id === 'main' && entry.default !== true
      ? { ...entry, default: true }
      : entry
  ));
}

function mainAgentDefaultRoutingMissing(config: Record<string, any>): boolean {
  const agents = config?.agents?.list;
  if (!Array.isArray(agents)) return false;
  const main = agents.find((entry: unknown) => isRecord(entry) && (entry as Record<string, unknown>).id === 'main') as Record<string, unknown> | undefined;
  return Boolean(main) && main?.default !== true;
}

async function ensureExactOpenClawAgentConfig(
  plan: OpenClawProjectSandboxPlan,
  rpc: OpenClawProjectSandboxDependencies['rpc'],
): Promise<void> {
  let snapshot = await readOpenClawConfig(rpc);
  let current = findAgent(snapshot.config, plan.agentId);
  if (
    !current
    || !valuesEqual(current, plan.desiredAgent)
    || mainAgentDefaultRoutingMissing(snapshot.config)
  ) {
    const agents = Array.isArray(snapshot.config?.agents?.list)
      ? snapshot.config.agents.list.filter((entry: unknown) => !isRecord(entry) || entry.id !== plan.agentId)
      : [];
    const response = await rpc('config.patch', {
      raw: JSON.stringify({
        agents: { list: [...withMainAgentDefaultRouting(agents), plan.desiredAgent] },
      }),
      baseHash: snapshot.hash,
    }, CONFIG_RPC_TIMEOUT_MS);
    if (!response.ok) fail('CONFIG_PATCH_FAILED', 'OpenClaw Project config could not be patched');
    snapshot = await readOpenClawConfig(rpc);
    current = findAgent(snapshot.config, plan.agentId);
  }
  if (!current || !valuesEqual(current, plan.desiredAgent)) {
    fail('CONFIG_REREAD_MISMATCH', 'OpenClaw Project agent config did not match after synchronous re-read');
  }
  const effectiveDocker = resolveEffectiveDocker(snapshot.config, current);
  if (!valuesEqual(effectiveDocker, plan.desiredDocker)) {
    fail('GLOBAL_CONFIG_DRIFT', 'Global OpenClaw sandbox defaults contaminated the Project runtime policy');
  }
  const rereadHash = computeOpenClawProjectConfigHash({
    docker: effectiveDocker,
    sandboxWorkspaceDir: plan.sandboxWorkspaceDir,
    agentWorkspaceDir: plan.agentWorkspaceDir,
  });
  if (rereadHash !== plan.configHash) {
    fail('CONFIG_HASH_MISMATCH', 'OpenClaw Project sandbox config hash did not match the desired policy');
  }
}

function hasNoNewPrivileges(values: string[] | null | undefined): boolean {
  // Docker reports the flag exactly as created: bare `no-new-privileges`
  // and `no-new-privileges:true` are the same enforced setting.
  return Boolean(values?.some((entry) => {
    const normalized = entry.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return normalized === 'nonewprivilegestrue' || normalized === 'nonewprivileges';
  }));
}

function requireEmpty(value: unknown[] | Record<string, unknown> | null | undefined, code: string, message: string): void {
  if (Array.isArray(value) ? value.length > 0 : Boolean(value && Object.keys(value).length > 0)) {
    fail(code, message);
  }
}

function parseEnvironment(entries: string[] | null | undefined): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const entry of entries || []) {
    const index = entry.indexOf('=');
    const key = index >= 0 ? entry.slice(0, index) : entry;
    const value = index >= 0 ? entry.slice(index + 1) : '';
    const values = result.get(key) || [];
    values.push(value);
    result.set(key, values);
  }
  return result;
}

function attestEnvironment(
  entries: string[] | null | undefined,
  expected: Readonly<Record<string, string>>,
): void {
  const env = parseEnvironment(entries);
  for (const values of env.values()) {
    if (values.length !== 1) {
      fail('RUNTIME_ENVIRONMENT_DUPLICATE', 'OpenClaw Project runtime has duplicate environment keys');
    }
  }
  for (const [key, value] of Object.entries(expected)) {
    const values = env.get(key);
    if (!values || values.length !== 1 || values[0] !== value) {
      fail('RUNTIME_ENVIRONMENT', `OpenClaw Project runtime environment key ${key} did not match`);
    }
  }
  for (const [key, _values] of env.entries()) {
    if (/^(?:ALL_PROXY|all_proxy|DOCKER_HOST|KUBECONFIG|SSH_AUTH_SOCK)$/i.test(key)) {
      fail('RUNTIME_ENVIRONMENT_ESCAPE', 'OpenClaw Project runtime inherited a host/network escape environment key');
    }
    if (
      !Object.prototype.hasOwnProperty.call(expected, key)
      && /(?:API[_-]?KEY|TOKEN|PASSWORD|PRIVATE[_-]?KEY|SECRET|CREDENTIAL|OPENCLAW_GATEWAY)/i.test(key)
    ) {
      fail('RUNTIME_ENVIRONMENT_SECRET', 'OpenClaw Project runtime inherited a credential environment key');
    }
    if (/_PROXY$/i.test(key) && !EXPLICIT_PROXY_ENV_KEYS.includes(key)) {
      fail('RUNTIME_ENVIRONMENT_PROXY', 'OpenClaw Project runtime inherited an unapproved proxy environment key');
    }
  }
}

function normalizedSecurityOptions(values: string[] | null | undefined): string[] {
  return (values || []).map((value) => value.trim().toLowerCase()).sort();
}

function attestTmpfs(tmpfs: Record<string, string> | null | undefined): void {
  const expected = new Map([
    ['/tmp', ['size=67108864', 'size=64m']],
    ['/var/tmp', ['size=67108864', 'size=64m']],
    ['/run', ['size=16777216', 'size=16m']],
  ]);
  if (!tmpfs || Object.keys(tmpfs).length !== expected.size) {
    fail('RUNTIME_TMPFS', 'OpenClaw Project runtime temporary filesystems did not match');
  }
  for (const [target, sizes] of expected) {
    const options = String(tmpfs[target] || '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .sort();
    if (!sizes.some((size) => valuesEqual(
      options,
      ['rw', 'noexec', 'nosuid', 'nodev', size].sort(),
    ))) {
      fail('RUNTIME_TMPFS', 'OpenClaw Project runtime temporary filesystem policy did not match');
    }
  }
}

function attestUlimits(
  values: Array<{ Name?: string; Soft?: number; Hard?: number }> | null | undefined,
): void {
  const normalized = (values || []).map((entry) => ({
    name: String(entry.Name || ''),
    soft: Number(entry.Soft),
    hard: Number(entry.Hard),
  })).sort((left, right) => left.name.localeCompare(right.name));
  const expected = [
    { name: 'nofile', soft: 1024, hard: 1024 },
    { name: 'nproc', soft: 256, hard: 256 },
  ];
  if (!valuesEqual(normalized, expected)) {
    fail('RUNTIME_ULIMITS', 'OpenClaw Project runtime ulimits did not match');
  }
}

/**
 * Attests the complete desired/actual container policy. Any missing field is a
 * failure; callers may not infer safety from a partial Docker inspection.
 */
type OpenClawRuntimeConfinementGeneration = 'CURRENT' | 'LEGACY_PRE_CONFINEMENT';

function attestOpenClawProjectContainerForGeneration(input: {
  plan: OpenClawProjectSandboxPlan;
  spec: ProjectEgressPlaneSpec;
  inspect: DockerContainerInspect;
  requireRunning: boolean;
  confinementGeneration: OpenClawRuntimeConfinementGeneration;
}): { containerId: string; startedAt: string } {
  const { plan, spec, inspect } = input;
  const containerId = String(inspect.Id || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(containerId)) {
    fail('RUNTIME_ID', 'OpenClaw Project runtime immutable Docker identity is invalid');
  }
  if (inspect.Name !== `/${plan.containerName}` && inspect.Name !== plan.containerName) {
    fail('RUNTIME_NAME', 'OpenClaw Project runtime name did not match');
  }
  if (inspect.Image !== plan.desiredDocker.image || inspect.Config?.Image !== plan.desiredDocker.image) {
    fail('RUNTIME_IMAGE', 'OpenClaw Project runtime image digest did not match');
  }
  if (inspect.State?.Running !== input.requireRunning) {
    fail('RUNTIME_STATE', 'OpenClaw Project runtime state did not match the attestation phase');
  }
  const startedAt = String(inspect.State?.StartedAt || '').trim();
  if (input.requireRunning && (!startedAt || !Number.isFinite(Date.parse(startedAt)))) {
    fail('RUNTIME_STATE', 'OpenClaw Project runtime start identity was invalid');
  }
  const labels = inspect.Config?.Labels || {};
  const expectedLabels: Record<string, string> = {
    'openclaw.sandbox': '1',
    'openclaw.sessionKey': plan.sessionKey,
    [OPENCLAW_PROJECT_ACTOR_LABEL]: hashOpenClawProjectLabelIdentity(plan.actorUserId),
    [OPENCLAW_PROJECT_IDENTITY_LABEL]: hashOpenClawProjectLabelIdentity(plan.projectIdentityId),
    [OPENCLAW_PROJECT_AGENT_LABEL]: plan.agentId,
    'openclaw.mountFormatVersion': String(OPENCLAW_SANDBOX_MOUNT_FORMAT_VERSION),
    'openclaw.configHash': plan.configHash,
    [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: plan.runtimeFingerprint,
  };
  for (const [key, value] of Object.entries(expectedLabels)) {
    if (labels[key] !== value) {
      // Values here are digests/identifiers, never secrets; naming both
      // sides is the difference between a diagnosable qualification failure
      // and a dead end.
      const drift = key === PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL
        ? explainRuntimeFingerprintMismatch(value, labels[key] || '')
        : '';
      fail('RUNTIME_LABELS', `OpenClaw Project runtime label ${key} did not match (expected ${value}, found ${labels[key] || 'unset'}).${drift}`);
    }
  }
  if (!/^\d+$/.test(String(labels['openclaw.createdAtMs'] || ''))) {
    fail('RUNTIME_LABELS', 'OpenClaw Project runtime creation label is invalid');
  }
  if (inspect.Config?.User !== OPENCLAW_CONTAINER_USER) {
    fail('RUNTIME_USER', 'OpenClaw Project runtime must run as a non-root numeric user');
  }
  if (inspect.Config?.WorkingDir !== OPENCLAW_PROJECT_CWD) {
    fail('RUNTIME_WORKDIR', 'OpenClaw Project runtime working directory did not match');
  }
  if (!valuesEqual(inspect.Config?.Cmd, ['sleep', 'infinity'])) {
    fail('RUNTIME_COMMAND', 'OpenClaw Project runtime command did not match');
  }
  if ((inspect.Config?.Entrypoint?.length || 0) > 0) {
    fail('RUNTIME_ENTRYPOINT', 'OpenClaw Project runtime image has an unexpected entrypoint');
  }
  requireEmpty(inspect.Config?.ExposedPorts, 'RUNTIME_EXPOSED_PORTS', 'OpenClaw Project runtime exposes ports');
  requireEmpty(inspect.Config?.Volumes, 'RUNTIME_IMAGE_VOLUMES', 'OpenClaw Project runtime image declares writable volumes');

  const host = inspect.HostConfig || {};
  if (host.ReadonlyRootfs !== true) fail('RUNTIME_ROOTFS', 'OpenClaw Project runtime root filesystem is writable');
  if (!valuesEqual((host.CapDrop || []).map((cap) => cap.toUpperCase()).sort(), ['ALL'])) {
    fail('RUNTIME_CAP_DROP', 'OpenClaw Project runtime capability drop did not match');
  }
  requireEmpty(host.CapAdd, 'RUNTIME_CAP_ADD', 'OpenClaw Project runtime adds Linux capabilities');
  if (!hasNoNewPrivileges(host.SecurityOpt)) {
    fail('RUNTIME_NO_NEW_PRIVILEGES', 'OpenClaw Project runtime lacks no-new-privileges');
  }
  const securityOptions = normalizedSecurityOptions(host.SecurityOpt);
  if (securityOptions.some((option) => option.includes('unconfined'))) {
    fail('RUNTIME_UNCONFINED', 'OpenClaw Project runtime has an unconfined security profile');
  }
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
    fail('RUNTIME_CONFINEMENT', 'OpenClaw Project runtime confinement profiles did not match');
  }
  if (host.Privileged === true) fail('RUNTIME_PRIVILEGED', 'OpenClaw Project runtime is privileged');
  if (String(host.PidMode || '') !== ''
    || !['', 'private'].includes(String(host.IpcMode || ''))
    || String(host.UTSMode || '') !== ''
    || String(host.UsernsMode || '') !== ''
    || !['', 'private'].includes(String(host.CgroupnsMode || ''))) {
    fail('RUNTIME_HOST_NAMESPACE', 'OpenClaw Project runtime namespace policy did not match');
  }
  if (host.RestartPolicy?.Name && host.RestartPolicy.Name !== 'no') {
    fail('RUNTIME_RESTART_POLICY', 'OpenClaw Project runtime may restart without re-attestation');
  }
  if (host.AutoRemove === true || host.OomKillDisable === true) {
    fail('RUNTIME_LIFECYCLE', 'OpenClaw Project runtime lifecycle policy did not match');
  }
  if (
    host.PidsLimit !== OPENCLAW_CONTAINER_PIDS_LIMIT
    || host.Memory !== OPENCLAW_CONTAINER_MEMORY_BYTES
    || host.MemorySwap !== OPENCLAW_CONTAINER_MEMORY_BYTES
    || host.NanoCpus !== OPENCLAW_CONTAINER_NANO_CPUS
  ) {
    fail('RUNTIME_RESOURCE_POLICY', 'OpenClaw Project runtime resource limits did not match');
  }
  attestUlimits(host.Ulimits);
  attestTmpfs(host.Tmpfs);
  requireEmpty(host.Mounts, 'RUNTIME_MOUNT_CONFIG', 'OpenClaw Project runtime has undeclared mount objects');
  requireEmpty(host.Devices, 'RUNTIME_DEVICES', 'OpenClaw Project runtime has host devices');
  requireEmpty(host.DeviceRequests, 'RUNTIME_DEVICE_REQUESTS', 'OpenClaw Project runtime has device requests');
  requireEmpty(host.DeviceCgroupRules, 'RUNTIME_DEVICE_RULES', 'OpenClaw Project runtime has device rules');
  requireEmpty(host.PortBindings, 'RUNTIME_PORT_BINDINGS', 'OpenClaw Project runtime publishes host ports');
  requireEmpty(inspect.NetworkSettings?.Ports, 'RUNTIME_PORTS', 'OpenClaw Project runtime has network ports');
  if (host.PublishAllPorts === true) fail('RUNTIME_PORT_PUBLISH', 'OpenClaw Project runtime publishes all ports');
  requireEmpty(host.Dns, 'RUNTIME_DNS', 'OpenClaw Project runtime bypasses controlled DNS');
  requireEmpty(host.DnsOptions, 'RUNTIME_DNS', 'OpenClaw Project runtime has custom DNS options');
  requireEmpty(host.DnsSearch, 'RUNTIME_DNS', 'OpenClaw Project runtime has custom DNS search domains');
  requireEmpty(host.ExtraHosts, 'RUNTIME_EXTRA_HOSTS', 'OpenClaw Project runtime has custom host mappings');
  requireEmpty(host.Links, 'RUNTIME_LINKS', 'OpenClaw Project runtime has Docker links');
  requireEmpty(host.VolumesFrom, 'RUNTIME_VOLUMES_FROM', 'OpenClaw Project runtime inherits another container volume');

  const networks = Object.keys(inspect.NetworkSettings?.Networks || {});
  const attachmentId = String(
    inspect.NetworkSettings?.Networks?.[spec.internalNetworkName]?.NetworkID || '',
  ).toLowerCase();
  const idPrimary = /^[a-f0-9]{64}$/.test(plan.networkMode);
  const stoppedIdPrimary = idPrimary
    && input.requireRunning === false
    && attachmentId === ''
    && String(host.NetworkMode || '').toLowerCase() === plan.networkMode;
  if (String(host.NetworkMode || '').toLowerCase() !== plan.networkMode.toLowerCase()) {
    fail('RUNTIME_NETWORK_MODE', 'OpenClaw Project runtime network mode did not match');
  }
  if (networks.length !== 1
    || networks[0] !== spec.internalNetworkName
    || !plan.internalNetworkId
    || (attachmentId !== plan.internalNetworkId && !stoppedIdPrimary)) {
    fail('RUNTIME_NETWORK_ATTACHMENTS', 'OpenClaw Project runtime has unexpected network attachments');
  }

  if (!valuesEqual([...(host.Binds || [])].sort(), [...plan.expectedBinds].sort())) {
    fail('RUNTIME_BINDS', 'OpenClaw Project runtime bind configuration did not match');
  }
  const mounts = inspect.Mounts || [];
  if (mounts.length !== 2) fail('RUNTIME_MOUNTS', 'OpenClaw Project runtime mount count did not match');
  const byDestination = new Map(mounts.map((mount) => [mount.Destination, mount]));
  const workspaceMount = byDestination.get(OPENCLAW_PROJECT_WORKDIR);
  const projectMount = byDestination.get(OPENCLAW_PROJECT_MOUNT);
  if (
    workspaceMount?.Type !== 'bind'
    || workspaceMount.Source !== plan.sandboxWorkspaceDir
    || workspaceMount.RW !== false
  ) {
    fail('RUNTIME_WORKSPACE_MOUNT', 'OpenClaw Project sandbox workspace mount did not match');
  }
  if (
    projectMount?.Type !== 'bind'
    || projectMount.Source !== plan.projectRoot
    || projectMount.RW !== true
  ) {
    fail('RUNTIME_PROJECT_MOUNT', 'OpenClaw Project writable project mount did not match');
  }
  attestEnvironment(inspect.Config?.Env, plan.expectedEnvironment);
  return { containerId, startedAt };
}

export function attestOpenClawProjectContainer(input: {
  plan: OpenClawProjectSandboxPlan;
  spec: ProjectEgressPlaneSpec;
  inspect: DockerContainerInspect;
  requireRunning: boolean;
}): { containerId: string; startedAt: string } {
  return attestOpenClawProjectContainerForGeneration({
    ...input,
    confinementGeneration: 'CURRENT',
  });
}

function buildContainerCreateArgs(
  plan: OpenClawProjectSandboxPlan,
  createdAtMs: number,
): string[] {
  const docker = plan.desiredDocker;
  const args = ['container', 'create', '--name', plan.containerName];
  const labels: Record<string, string> = {
    'openclaw.sandbox': '1',
    'openclaw.sessionKey': plan.sessionKey,
    [OPENCLAW_PROJECT_ACTOR_LABEL]: hashOpenClawProjectLabelIdentity(plan.actorUserId),
    [OPENCLAW_PROJECT_IDENTITY_LABEL]: hashOpenClawProjectLabelIdentity(plan.projectIdentityId),
    [OPENCLAW_PROJECT_AGENT_LABEL]: plan.agentId,
    'openclaw.createdAtMs': String(createdAtMs),
    'openclaw.mountFormatVersion': String(OPENCLAW_SANDBOX_MOUNT_FORMAT_VERSION),
    'openclaw.configHash': plan.configHash,
    [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: plan.runtimeFingerprint,
  };
  for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`);
  args.push('--read-only');
  for (const tmpfs of docker.tmpfs) args.push('--tmpfs', tmpfs);
  args.push('--network', plan.networkMode);
  args.push('--user', docker.user);
  for (const [key, value] of Object.entries<string>(docker.env)) args.push('--env', `${key}=${value}`);
  args.push('--env', 'OPENCLAW_CLI=1');
  for (const cap of docker.capDrop) args.push('--cap-drop', cap);
  args.push(...projectRuntimeSecurityOptArgs());
  args.push('--pids-limit', String(docker.pidsLimit));
  args.push('--memory', String(docker.memory));
  args.push('--memory-swap', String(docker.memorySwap));
  args.push('--cpus', String(docker.cpus));
  for (const [name, value] of Object.entries<any>(docker.ulimits)) {
    args.push('--ulimit', `${name}=${value.soft}:${value.hard}`);
  }
  for (const bind of plan.expectedBinds) args.push('-v', bind);
  args.push('--workdir', OPENCLAW_PROJECT_CWD);
  args.push(docker.image, 'sleep', 'infinity');
  return args;
}

function parseInspect(stdout: string): DockerContainerInspect | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    fail('RUNTIME_INSPECT_INVALID', 'OpenClaw Project Docker inspection was not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    fail('RUNTIME_INSPECT_INVALID', 'OpenClaw Project Docker inspection was incomplete');
  }
  return parsed[0] as DockerContainerInspect;
}

async function inspectContainer(
  executor: ProjectEgressCommandExecutor,
  containerName: string,
): Promise<DockerContainerInspect | null> {
  const result = await executor.run('docker', ['container', 'inspect', containerName], { allowExitCodes: [0, 1] });
  if (result.exitCode === 1) return null;
  return parseInspect(result.stdout);
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
    const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (text.includes('no such object')
      || text.includes('no such container')
      || (text.includes('container') && text.includes('not found'))
      || (text.includes('object') && text.includes('not found'))) {
      return null;
    }
    fail('RUNTIME_INSPECT_FAILED', 'OpenClaw Project runtime inspection failed without proving absence');
  }
  return parseInspect(result.stdout);
}

async function reattestCurrentRuntimeByImmutableId(input: {
  executor: ProjectEgressCommandExecutor;
  containerId: string;
  plan: OpenClawProjectSandboxPlan;
  spec: ProjectEgressPlaneSpec;
  requireRunning: boolean;
}): Promise<{ containerId: string }> {
  const inspect = await strictInspectContainer(input.executor, input.containerId);
  if (!inspect) fail('RUNTIME_RACE', 'OpenClaw Project runtime identity disappeared during convergence');
  const attested = attestOpenClawProjectContainer({
    plan: input.plan,
    spec: input.spec,
    inspect,
    requireRunning: input.requireRunning,
  });
  if (attested.containerId !== input.containerId) {
    fail('RUNTIME_RACE', 'OpenClaw Project runtime immutable identity changed during convergence');
  }
  return attested;
}

async function stopExactCurrentRuntimeAfterFailure(input: {
  executor: ProjectEgressCommandExecutor;
  containerId: string;
  plan: OpenClawProjectSandboxPlan;
  spec: ProjectEgressPlaneSpec;
}): Promise<void> {
  try {
    const inspect = await strictInspectContainer(input.executor, input.containerId);
    if (!inspect || inspect.State?.Running !== true) return;
    const attested = attestOpenClawProjectContainer({
      plan: input.plan,
      spec: input.spec,
      inspect,
      requireRunning: true,
    });
    if (attested.containerId !== input.containerId) return;
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
    // Preserve the triggering error and never fall back to a mutable name.
  }
}

async function ensureExactRuntime(input: {
  plan: OpenClawProjectSandboxPlan;
  spec: ProjectEgressPlaneSpec;
  executor: ProjectEgressCommandExecutor;
  constrainRuntime: OpenClawProjectSandboxDependencies['constrainRuntime'];
  now: Date;
}): Promise<string> {
  const { plan, spec, executor } = input;
  let containerId: string | null = null;
  try {
    let inspect = await strictInspectContainer(executor, plan.containerName);
    if (!inspect) {
      const created = await executor.run('docker', buildContainerCreateArgs(plan, input.now.getTime()));
      const createdContainerId = created.stdout.trim();
      if (!/^[a-f0-9]{64}$/.test(createdContainerId)) {
        fail('RUNTIME_CREATE_ID', 'OpenClaw Project Docker create did not return one full immutable container identity');
      }
      inspect = await strictInspectContainer(executor, createdContainerId);
      if (!inspect) fail('RUNTIME_CREATE', 'OpenClaw Project runtime could not be inspected after creation');
      const attested = attestOpenClawProjectContainer({
        plan,
        spec,
        inspect,
        requireRunning: false,
      });
      if (attested.containerId !== createdContainerId) {
        fail('RUNTIME_CREATE_ID', 'OpenClaw Project runtime identity did not match Docker create output');
      }
    }
    const requireRunning = inspect.State?.Running === true;
    const initial = attestOpenClawProjectContainer({
      plan,
      spec,
      inspect,
      requireRunning,
    });
    await requireOnlyExactIdentityRuntime({
      executor,
      plan,
      containerId: initial.containerId,
    });
    await reattestCurrentRuntimeByImmutableId({
      executor,
      containerId: initial.containerId,
      plan,
      spec,
      requireRunning,
    });
    containerId = initial.containerId;
    if (requireRunning) {
      await executor.run('docker', ['container', 'stop', '--time', '1', containerId]);
      await reattestCurrentRuntimeByImmutableId({
        executor,
        containerId,
        plan,
        spec,
        requireRunning: false,
      });
    }
    await input.constrainRuntime({
      spec,
      runtimeContainerId: containerId,
      runtimeContainerName: plan.containerName,
      expectedRuntimeFingerprint: plan.runtimeFingerprint,
      executor,
    });
    await reattestCurrentRuntimeByImmutableId({
      executor,
      containerId,
      plan,
      spec,
      requireRunning: false,
    });
    await executor.run('docker', ['container', 'start', containerId]);
    await reattestCurrentRuntimeByImmutableId({
      executor,
      containerId,
      plan,
      spec,
      requireRunning: true,
    });
    return containerId;
  } catch (error) {
    if (containerId) {
      await stopExactCurrentRuntimeAfterFailure({
        executor,
        containerId,
        plan,
        spec,
      });
    }
    throw error;
  }
}

const commandExecutor: ProjectEgressCommandExecutor = {
  run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const childEnv: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', LANG: 'C' };
      delete childEnv.DOCKER_HOST;
      delete childEnv.DOCKER_CONTEXT;
      delete childEnv.DOCKER_TLS_VERIFY;
      delete childEnv.DOCKER_CERT_PATH;
      delete childEnv.DOCKER_CONFIG;
      delete childEnv.SSH_AUTH_SOCK;
      const commandArgs = command === 'docker'
        ? ['--host', 'unix:///var/run/docker.sock', ...args]
        : [...args];
      const child = spawn(command, commandArgs, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (error?: Error, result?: { stdout: string; stderr: string; exitCode: number }) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          finish(new Error('OpenClaw Project command output exceeded the safety limit'));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.on('error', (error) => finish(error));
      child.on('close', (code) => {
        const exitCode = code ?? 1;
        const allowed = options.allowExitCodes || [0];
        if (!allowed.includes(exitCode)) {
          // Keep the command shape and a bounded stderr excerpt: a bare exit
          // code makes real-host qualification failures undiagnosable.
          const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 400);
          const commandSummary = [command, ...args.slice(0, 4)].join(' ');
          finish(new Error(
            `OpenClaw Project command failed with exit code ${exitCode} (${commandSummary}${args.length > 4 ? ' …' : ''})${detail ? `: ${detail}` : ''}`,
          ));
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
  },
};

const defaultDependencies: OpenClawProjectSandboxDependencies = {
  rpc: gatewayRpcCall,
  executor: commandExecutor,
  buildEgressSpec: buildProjectEgressPlaneSpec,
  ensureEgressPlane: ensureProjectEgressPlane,
  resolveInternalNetworkBinding: resolveRecognizedProjectEgressInternalNetworkBinding,
  constrainRuntime: constrainProjectRuntimeToEgressPlane,
  assertConfinementReady: () => { assertProjectRuntimeConfinementReadyForExecution(); },
  now: () => new Date(),
};

async function listExactIdentityRuntimeIds(input: {
  executor: ProjectEgressCommandExecutor;
  plan: OpenClawProjectSandboxPlan;
}): Promise<string[]> {
  const result = await input.executor.run('docker', [
    'container', 'ls', '--all', '--no-trunc',
    '--filter', `label=${OPENCLAW_PROJECT_ACTOR_LABEL}=${hashOpenClawProjectLabelIdentity(input.plan.actorUserId)}`,
    '--filter', `label=${OPENCLAW_PROJECT_IDENTITY_LABEL}=${hashOpenClawProjectLabelIdentity(input.plan.projectIdentityId)}`,
    '--format', '{{.ID}}',
  ]);
  const ids = result.stdout.split(/\r?\n/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (ids.length > 8 || new Set(ids).size !== ids.length
    || ids.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    fail('STALE_RUNTIME_LIST', 'Docker returned an ambiguous OpenClaw Project runtime inventory');
  }
  return ids;
}

async function requireOnlyExactIdentityRuntime(input: {
  executor: ProjectEgressCommandExecutor;
  plan: OpenClawProjectSandboxPlan;
  containerId: string;
}): Promise<void> {
  const ids = await listExactIdentityRuntimeIds(input);
  if (ids.length !== 1 || ids[0] !== input.containerId) {
    fail(
      'RUNTIME_IDENTITY_INVENTORY',
      'OpenClaw Project runtime identity has an unexpected concurrent generation',
    );
  }
}

// Kernel runtime descriptor string for the OPENCLAW lane. Kept local because
// the provider registry cannot be imported from this module without a cycle;
// openclawProjectSandbox.test.ts pins it against the registry constant.
export const OPENCLAW_PROJECT_KERNEL_RUNTIME = 'openclaw-dedicated-project-agent';

// Mirror of the kernel-owned context policy fingerprint derivation
// (projectChatKernel.buildProjectSandboxExecutionContextInternal). The kernel
// hashes plain insertion-ordered JSON, so this deliberately does not use the
// key-normalizing stableHash from this module.
function openClawContextPolicyFingerprint(context: ProjectSandboxExecutionContext): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: context.runtimePolicyVersion,
    egressPolicyVersion: context.egressPolicyVersion,
    provider: 'OPENCLAW',
    runtime: OPENCLAW_PROJECT_KERNEL_RUNTIME,
    runtimeImageDigest: context.runtimeImageDigest,
    actorUserId: context.userId,
    workspaceOwnerId: context.workspaceOwnerId,
    projectId: context.projectId,
    projectName: context.projectName,
    canonicalRoot: context.canonicalRoot,
    rootDevice: context.rootDevice,
    rootInode: context.rootInode,
    rootBirthtimeNs: context.rootBirthtimeNs,
  })).digest('hex');
}

function staleRuntimeAttestationPlan(input: {
  inspect: DockerContainerInspect;
  plan: OpenClawProjectSandboxPlan;
  context: ProjectSandboxExecutionContext;
  spec: ProjectEgressPlaneSpec;
}): {
  plan: OpenClawProjectSandboxPlan;
  confinementGeneration: OpenClawRuntimeConfinementGeneration;
} {
  const labels = input.inspect.Config?.Labels || {};
  const runtimeFingerprint = String(labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] || '').toLowerCase();
  const configHash = String(labels['openclaw.configHash'] || '').toLowerCase();
  const containerName = String(input.inspect.Name || '').replace(/^\//, '');
  if (!/^[a-f0-9]{64}$/.test(runtimeFingerprint)) {
    fail('STALE_RUNTIME_FINGERPRINT', 'Managed OpenClaw Project stale runtime fingerprint is invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(configHash)) {
    fail('STALE_RUNTIME_CONFIG', 'Managed OpenClaw Project stale runtime config hash is invalid');
  }
  // A stale runtime keeps the pinned image its own generation was created
  // from, so reconstruction must run against the inspected image rather than
  // the current plan's image: a routine sandbox-image rebuild would otherwise
  // wedge retirement forever. The context policy fingerprint, container name
  // prefix, config hash, and runtime fingerprint below all commit to this
  // exact image, so a runtime whose image was swapped after creation cannot
  // reconstruct any recognized generation and stays fail-closed.
  const image = String(input.inspect.Image || '').toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)
    || String(input.inspect.Config?.Image || '').toLowerCase() !== image) {
    fail('STALE_RUNTIME_IMAGE', 'Managed OpenClaw Project stale runtime image did not match');
  }
  const candidateContext = Object.freeze({
    ...input.context,
    runtimeImageDigest: image,
    policyFingerprint: openClawContextPolicyFingerprint({
      ...input.context,
      runtimeImageDigest: image,
    }),
  });
  const containerPrefix = `p4oc-${candidateContext.policyFingerprint.slice(0, 16)}-`;
  if (containerName !== `${containerPrefix}${slugifyOpenClawProjectSessionKey(input.plan.sessionKey)}`.slice(0, 63)) {
    fail('STALE_RUNTIME_NAME', 'Managed OpenClaw Project stale runtime name did not match');
  }

  const environment = parseEnvironment(input.inspect.Config?.Env);
  const proxyEnvironment: Record<string, string> = {};
  for (const key of EXPLICIT_PROXY_ENV_KEYS) {
    const values = environment.get(key);
    if (!values || values.length !== 1) {
      fail('STALE_RUNTIME_PROXY', 'Managed OpenClaw Project stale runtime proxy environment is ambiguous');
    }
    proxyEnvironment[key] = values[0];
  }
  const proxyUrls = [
    proxyEnvironment.HTTP_PROXY,
    proxyEnvironment.HTTPS_PROXY,
    proxyEnvironment.http_proxy,
    proxyEnvironment.https_proxy,
  ];
  if (new Set(proxyUrls).size !== 1
    || proxyEnvironment.NO_PROXY !== ''
    || proxyEnvironment.no_proxy !== '') {
    fail('STALE_RUNTIME_PROXY', 'Managed OpenClaw Project stale runtime proxy environment is invalid');
  }
  let parsedProxy: URL;
  try {
    parsedProxy = new URL(proxyUrls[0]);
  } catch {
    fail('STALE_RUNTIME_PROXY', 'Managed OpenClaw Project stale runtime proxy URL is invalid');
  }
  if (parsedProxy.protocol !== 'http:'
    || parsedProxy.username !== 'portal'
    || !/^[A-Za-z0-9_-]{43,256}$/.test(parsedProxy.password)
    || parsedProxy.hostname !== input.spec.proxyAlias
    || parsedProxy.port !== String(input.spec.proxyPort)
    || parsedProxy.pathname !== '/'
    || parsedProxy.search
    || parsedProxy.hash) {
    fail('STALE_RUNTIME_PROXY', 'Managed OpenClaw Project stale runtime proxy URL is invalid');
  }
  for (const [key, value] of Object.entries({
    LANG: 'C.UTF-8',
    HOME: '/home/openclaw',
    TMPDIR: '/tmp',
    OPENCLAW_CLI: '1',
  })) {
    const values = environment.get(key);
    if (!values || values.length !== 1 || values[0] !== value) {
      fail('STALE_RUNTIME_ENVIRONMENT', 'Managed OpenClaw Project stale runtime base environment is invalid');
    }
  }
  const currentDesiredDocker = buildDesiredDocker({
    image,
    containerPrefix,
    network: input.spec.internalNetworkName,
    projectRoot: input.plan.projectRoot,
    proxyEnvironment,
  });
  const currentConfigHash = computeOpenClawProjectConfigHash({
    docker: currentDesiredDocker,
    sandboxWorkspaceDir: input.plan.sandboxWorkspaceDir,
    agentWorkspaceDir: input.plan.agentWorkspaceDir,
  });
  const currentFingerprint = buildOpenClawRuntimeFingerprint({
    context: candidateContext,
    egressPolicyFingerprint: input.spec.policyFingerprint,
    image,
    agentId: input.plan.agentId,
    sessionKey: input.plan.sessionKey,
    configHash: currentConfigHash,
  }).fingerprint;
  const legacyDesiredDocker = buildLegacyPreConfinementDesiredDocker({
    image,
    containerPrefix,
    network: input.spec.internalNetworkName,
    projectRoot: input.plan.projectRoot,
    proxyEnvironment,
  });
  const legacyConfigHash = computeOpenClawProjectConfigHash({
    docker: legacyDesiredDocker,
    sandboxWorkspaceDir: input.plan.sandboxWorkspaceDir,
    agentWorkspaceDir: input.plan.agentWorkspaceDir,
  });
  const legacyFingerprint = buildOpenClawRuntimeFingerprint({
    context: candidateContext,
    egressPolicyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(input.spec),
    image,
    agentId: input.plan.agentId,
    sessionKey: input.plan.sessionKey,
    configHash: legacyConfigHash,
  }).fingerprint;
  const candidate = runtimeFingerprint === legacyFingerprint && configHash === legacyConfigHash
    ? {
      desiredDocker: legacyDesiredDocker,
      confinementGeneration: 'LEGACY_PRE_CONFINEMENT' as const,
    }
    : runtimeFingerprint === currentFingerprint && configHash === currentConfigHash
      ? {
        desiredDocker: currentDesiredDocker,
        confinementGeneration: 'CURRENT' as const,
      }
      : null;
  if (!candidate) {
    fail(
      'STALE_RUNTIME_GENERATION',
      'Managed OpenClaw Project runtime is not an exact recognized prior generation',
    );
  }
  const inspectedNetworkMode = String(input.inspect.HostConfig?.NetworkMode || '').toLowerCase();
  const networkMode = inspectedNetworkMode === input.spec.internalNetworkName
    ? input.spec.internalNetworkName
    : inspectedNetworkMode === input.plan.networkMode
      && /^[a-f0-9]{64}$/.test(input.plan.networkMode)
      ? input.plan.networkMode
      : fail(
        'STALE_RUNTIME_NETWORK',
        'Managed OpenClaw Project stale runtime network mode is not a recognized generation',
      );
  const stalePlan = Object.freeze({
    ...input.plan,
    containerName,
    configHash,
    runtimeFingerprint,
    desiredDocker: candidate.desiredDocker,
    expectedEnvironment: Object.freeze({
      ...candidate.desiredDocker.env,
      OPENCLAW_CLI: '1',
    }),
    networkMode,
  });
  return Object.freeze({
    plan: stalePlan,
    confinementGeneration: candidate.confinementGeneration,
  });
}

function attestExactStaleRuntime(input: {
  inspect: DockerContainerInspect;
  plan: OpenClawProjectSandboxPlan;
  context: ProjectSandboxExecutionContext;
  spec: ProjectEgressPlaneSpec;
  requireRunning: boolean;
}): { containerId: string } {
  const stale = staleRuntimeAttestationPlan(input);
  if (stale.plan.runtimeFingerprint === input.plan.runtimeFingerprint
    && stale.plan.networkMode === input.plan.networkMode) {
    fail('STALE_RUNTIME_IDENTITY', 'Current OpenClaw Project runtime cannot be retired as stale');
  }
  return attestOpenClawProjectContainerForGeneration({
    plan: stale.plan,
    spec: input.spec,
    inspect: input.inspect,
    requireRunning: input.requireRunning,
    confinementGeneration: stale.confinementGeneration,
  });
}

async function retireExactManagedStaleRuntimes(input: {
  executor: ProjectEgressCommandExecutor;
  plan: OpenClawProjectSandboxPlan;
  context: ProjectSandboxExecutionContext;
  spec: ProjectEgressPlaneSpec;
}): Promise<void> {
  const initial = await listExactIdentityRuntimeIds(input);
  const attestedInventory: Array<{
    containerId: string;
    generation: 'CURRENT' | 'STALE';
    requireRunning: boolean;
  }> = [];

  // Phase one is deliberately read-only. Every identity-matched object must
  // attest as either the exact current generation or an exact recognized stale
  // generation before any member of the inventory may be stopped or removed.
  for (const discoveredId of initial) {
    const before = await strictInspectContainer(input.executor, discoveredId);
    if (!before) {
      fail('STALE_RUNTIME_RACE', 'Managed OpenClaw Project runtime disappeared before attestation');
    }
    const requireRunning = before.State?.Running === true;
    const reconstructed = staleRuntimeAttestationPlan({
      inspect: before,
      plan: input.plan,
      context: input.context,
      spec: input.spec,
    });
    const currentClaimant = before.Config?.Labels?.[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]
      === input.plan.runtimeFingerprint
      && reconstructed.plan.networkMode === input.plan.networkMode;
    const first = currentClaimant
      ? attestOpenClawProjectContainer({
        inspect: before,
        plan: input.plan,
        spec: input.spec,
        requireRunning,
      })
      : attestExactStaleRuntime({
        inspect: before,
        plan: input.plan,
        context: input.context,
        spec: input.spec,
        requireRunning,
      });
    if (first.containerId !== discoveredId) {
      fail('STALE_RUNTIME_RACE', 'Managed OpenClaw Project runtime immutable identity changed');
    }
    attestedInventory.push(Object.freeze({
      containerId: discoveredId,
      generation: currentClaimant ? 'CURRENT' : 'STALE',
      requireRunning,
    }));
  }
  if (attestedInventory.filter((entry) => entry.generation === 'CURRENT').length > 1) {
    fail('RUNTIME_IDENTITY_INVENTORY', 'OpenClaw Project runtime identity has multiple current claimants');
  }
  const attestedIds = attestedInventory.map((entry) => entry.containerId).sort();
  const barrierIds = await listExactIdentityRuntimeIds(input);
  if (!valuesEqual(barrierIds, attestedIds)) {
    fail('STALE_RUNTIME_RACE', 'Managed OpenClaw Project runtime inventory changed after initial attestation');
  }

  // Phase two uses only the immutable IDs captured above and re-attests each
  // stale object immediately before every destructive transition.
  for (const entry of attestedInventory) {
    if (entry.generation === 'CURRENT') continue;
    const beforeRetirement = await strictInspectContainer(input.executor, entry.containerId);
    if (!beforeRetirement) {
      fail('STALE_RUNTIME_RACE', 'Managed OpenClaw Project stale runtime disappeared before retirement');
    }
    const beforeAttestation = attestExactStaleRuntime({
      inspect: beforeRetirement,
      plan: input.plan,
      context: input.context,
      spec: input.spec,
      requireRunning: entry.requireRunning,
    });
    if (beforeAttestation.containerId !== entry.containerId) {
      fail('STALE_RUNTIME_RACE', 'Managed OpenClaw Project stale runtime changed before retirement');
    }
    if (entry.requireRunning) {
      await input.executor.run('docker', ['container', 'stop', '--time', '1', entry.containerId]);
    }
    const stopped = await strictInspectContainer(input.executor, entry.containerId);
    if (!stopped) {
      fail('STALE_RUNTIME_RACE', 'Managed OpenClaw Project stale runtime disappeared before retirement');
    }
    const stoppedAttestation = attestExactStaleRuntime({
      inspect: stopped,
      plan: input.plan,
      context: input.context,
      spec: input.spec,
      requireRunning: false,
    });
    if (stoppedAttestation.containerId !== entry.containerId) {
      fail('STALE_RUNTIME_RACE', 'Managed OpenClaw Project stale runtime changed before retirement');
    }
    await input.executor.run('docker', ['container', 'rm', entry.containerId]);
    if (await strictInspectContainer(input.executor, entry.containerId)) {
      fail('STALE_RUNTIME_REMOVE', 'Managed OpenClaw Project stale runtime still exists after exact removal');
    }
    invalidateConvergedProjectRuntime(containerNameFromInspect(stopped));
  }

  const expectedCurrentIds = attestedInventory
    .filter((entry) => entry.generation === 'CURRENT')
    .map((entry) => entry.containerId)
    .sort();
  const residualIds = await listExactIdentityRuntimeIds(input);
  if (!valuesEqual(residualIds, expectedCurrentIds)) {
    fail('STALE_RUNTIME_RESIDUAL', 'Managed OpenClaw Project stale runtime convergence did not reach an exact state');
  }
  for (const residualId of residualIds) {
    const residual = await strictInspectContainer(input.executor, residualId);
    if (!residual) {
      fail('STALE_RUNTIME_RACE', 'Managed OpenClaw Project runtime inventory changed during verification');
    }
    const requireRunning = residual.State?.Running === true;
    const residualAttestation = attestOpenClawProjectContainer({
      inspect: residual,
      plan: input.plan,
      spec: input.spec,
      requireRunning,
    });
    if (residualAttestation.containerId !== residualId) {
      fail('STALE_RUNTIME_RACE', 'Managed OpenClaw Project current runtime immutable identity changed');
    }
  }
}

export async function attestOnlyOpenClawProjectIdentityRuntime(input: {
  executor: ProjectEgressCommandExecutor;
  containerId: string;
  plan: OpenClawProjectSandboxPlan;
  spec: ProjectEgressPlaneSpec;
}): Promise<void> {
  await requireOnlyExactIdentityRuntime({
    executor: input.executor,
    plan: input.plan,
    containerId: input.containerId,
  });
  await reattestCurrentRuntimeByImmutableId({
    ...input,
    requireRunning: true,
  });
  const named = await strictInspectContainer(input.executor, input.plan.containerName);
  if (!named) fail('RUNTIME_IDENTITY_INVENTORY', 'OpenClaw Project runtime name disappeared');
  const namedAttestation = attestOpenClawProjectContainer({
    inspect: named,
    plan: input.plan,
    spec: input.spec,
    requireRunning: true,
  });
  if (namedAttestation.containerId !== input.containerId) {
    fail('RUNTIME_IDENTITY_INVENTORY', 'OpenClaw Project runtime name resolved to another immutable identity');
  }
  await requireOnlyExactIdentityRuntime({
    executor: input.executor,
    plan: input.plan,
    containerId: input.containerId,
  });
}

function containerNameFromInspect(inspect: DockerContainerInspect): string {
  const name = String(inspect.Name || '').replace(/^\//, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) {
    fail('STALE_RUNTIME_NAME', 'Managed OpenClaw Project runtime name became invalid');
  }
  return name;
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

export async function ensureOpenClawProjectSandbox(
  input: OpenClawProjectSandboxInput,
  overrides: Partial<OpenClawProjectSandboxDependencies> = {},
): Promise<OpenClawProjectSandboxResult> {
  assertProjectContext(input.context);
  assertEgressIdentity(input.context, input.egress);
  assertServerOwnedRuntimeIdentity(input.context, input.agentId, input.sessionKey);
  const dependencies = { ...defaultDependencies, ...overrides };
  dependencies.assertConfinementReady();
  const spec = dependencies.buildEgressSpec(input.egress);
  const result = await withRuntimeEnsureLock(spec.identityFingerprint, async () => {
    const preflightNetworkBinding = await dependencies.resolveInternalNetworkBinding(
      dependencies.executor,
      spec,
    );

    // Fast path: a runtime this process fully ensured recently, whose plan and
    // egress fingerprints are unchanged, and whose container one cheap inspect
    // confirms is still running with the same identity, needs no stop/attest/
    // start cycle. The identity inventory still runs first: a second obsolete
    // generation must never stay attached merely because the current one is
    // cached.
    const fastPathPlan = buildOpenClawProjectSandboxPlan({
      context: input.context,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      openClawHome: input.openClawHome,
      egressSpec: spec,
      egressHandle: syntheticEgressHandle(
        spec,
        input.context.egressPolicyVersion,
        preflightNetworkBinding?.networkId,
      ),
      useHistoricalNetworkMode: preflightNetworkBinding?.generation === 'LEGACY_PRE_CONFINEMENT',
    });
    await retireExactManagedStaleRuntimes({
      executor: dependencies.executor,
      plan: fastPathPlan,
      context: input.context,
      spec,
    });
    const converged = convergedRuntimeCache.get(fastPathPlan.containerName);
    if (
      preflightNetworkBinding?.generation === 'CURRENT'
      && converged
      && converged.runtimeFingerprint === fastPathPlan.runtimeFingerprint
      && converged.egressPolicyFingerprint === spec.policyFingerprint
      && Date.now() - converged.attestedAtMs < CONVERGED_RUNTIME_TTL_MS
    ) {
      const inspect = await inspectContainer(dependencies.executor, fastPathPlan.containerName);
      if (
        inspect?.State?.Running === true
        && inspect.Config?.Labels?.[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] === fastPathPlan.runtimeFingerprint
        && inspect.Config?.Image === fastPathPlan.desiredDocker.image
      ) {
        // The cache is only a latency hint. Re-read the exact agent entry (which
        // also repairs config drift) and attest the complete live Docker policy;
        // labels/image/running alone cannot prove a safe execution boundary.
        await ensureExactOpenClawAgentConfig(fastPathPlan, dependencies.rpc);
        try {
          const current = attestOpenClawProjectContainer({
            plan: fastPathPlan,
            spec,
            inspect,
            requireRunning: true,
          });
          await attestOnlyOpenClawProjectIdentityRuntime({
            executor: dependencies.executor,
            containerId: current.containerId,
            plan: fastPathPlan,
            spec,
          });
          return {
            agentId: fastPathPlan.agentId,
            sessionKey: fastPathPlan.sessionKey,
            containerId: current.containerId,
            containerStartedAt: current.startedAt,
            containerName: fastPathPlan.containerName,
            configHash: fastPathPlan.configHash,
            runtimeFingerprint: fastPathPlan.runtimeFingerprint,
            egressPolicyFingerprint: spec.policyFingerprint,
            attestedAt: new Date(converged.attestedAtMs).toISOString(),
          };
        } catch {
          // Full convergence below stops the runtime before inspecting or
          // replacing it. Never serve a weakly-attested cached container.
        }
      }
      convergedRuntimeCache.delete(fastPathPlan.containerName);
    }

    const handle = await dependencies.ensureEgressPlane(input.egress, dependencies.executor);
    if (
      handle.policyVersion !== PROJECT_EGRESS_POLICY_VERSION
      || handle.policyFingerprint !== spec.policyFingerprint
      || handle.internalNetworkName !== spec.internalNetworkName
      || !/^[a-f0-9]{64}$/.test(String(handle.internalNetworkId || '').toLowerCase())
      || handle.publicNetworkName !== spec.publicNetworkName
      || handle.proxyContainerName !== spec.proxyContainerName
    ) {
      fail('EGRESS_ATTESTATION', 'OpenClaw Project egress plane did not match its desired policy');
    }
    const expectedProxyUrl = `http://portal:${encodeURIComponent(spec.token)}@${spec.proxyAlias}:${spec.proxyPort}`;
    if (handle.proxyUrl !== expectedProxyUrl) {
      fail('EGRESS_PROXY', 'OpenClaw Project egress proxy endpoint did not match');
    }
    const expectedProxyEnvironment = {
      HTTP_PROXY: expectedProxyUrl,
      HTTPS_PROXY: expectedProxyUrl,
      http_proxy: expectedProxyUrl,
      https_proxy: expectedProxyUrl,
      NO_PROXY: '',
      no_proxy: '',
    };
    if (!valuesEqual(handle.proxyEnvironment, expectedProxyEnvironment)) {
      fail('EGRESS_PROXY_ENVIRONMENT', 'OpenClaw Project egress proxy environment did not match');
    }
    const postPlaneBinding = await dependencies.resolveInternalNetworkBinding(
      dependencies.executor,
      spec,
    );
    if (!postPlaneBinding
      || postPlaneBinding.generation !== 'CURRENT'
      || postPlaneBinding.networkId !== handle.internalNetworkId
      || (preflightNetworkBinding?.generation === 'CURRENT'
        && preflightNetworkBinding.networkId !== postPlaneBinding.networkId)) {
      fail('EGRESS_ATTESTATION', 'OpenClaw Project internal network identity changed during convergence');
    }
    const plan = buildOpenClawProjectSandboxPlan({
      context: input.context,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      openClawHome: input.openClawHome,
      egressSpec: spec,
      egressHandle: handle,
    });
    await retireExactManagedStaleRuntimes({
      executor: dependencies.executor,
      plan,
      context: input.context,
      spec,
    });
    await ensureExactOpenClawAgentConfig(plan, dependencies.rpc);
    assertProjectContext(input.context);
    const runtimeContainerId = await ensureExactRuntime({
      plan,
      spec,
      executor: dependencies.executor,
      constrainRuntime: dependencies.constrainRuntime,
      now: dependencies.now(),
    });
    try {
      await attestOnlyOpenClawProjectIdentityRuntime({
        executor: dependencies.executor,
        containerId: runtimeContainerId,
        plan,
        spec,
      });
      assertProjectContext(input.context);
    } catch (error) {
      await stopExactCurrentRuntimeAfterFailure({
        executor: dependencies.executor,
        containerId: runtimeContainerId,
        plan,
        spec,
      });
      throw error;
    }
    const finalInspect = await strictInspectContainer(dependencies.executor, runtimeContainerId);
    if (!finalInspect) {
      fail('RUNTIME_RACE', 'OpenClaw Project runtime disappeared before final start-identity capture');
    }
    const finalRuntime = attestOpenClawProjectContainer({
      plan,
      spec,
      inspect: finalInspect,
      requireRunning: true,
    });
    await attestOnlyOpenClawProjectIdentityRuntime({
      executor: dependencies.executor,
      containerId: runtimeContainerId,
      plan,
      spec,
    });
    convergedRuntimeCache.set(plan.containerName, {
      runtimeFingerprint: plan.runtimeFingerprint,
      egressPolicyFingerprint: spec.policyFingerprint,
      attestedAtMs: dependencies.now().getTime(),
    });
    return {
      agentId: plan.agentId,
      sessionKey: plan.sessionKey,
      containerId: runtimeContainerId,
      containerStartedAt: finalRuntime.startedAt,
      containerName: plan.containerName,
      configHash: plan.configHash,
      runtimeFingerprint: plan.runtimeFingerprint,
      egressPolicyFingerprint: spec.policyFingerprint,
      attestedAt: dependencies.now().toISOString(),
    };
  });
  assertProjectContext(input.context);
  return result;
}

export const __openClawProjectSandboxTest = {
  buildContainerCreateArgs,
  ensureExactOpenClawAgentConfig,
  ensureExactRuntime,
  resolveEffectiveDocker,
  stableHash,
  toolAllow: OPENCLAW_PROJECT_TOOL_ALLOW,
  toolDeny: OPENCLAW_PROJECT_TOOL_DENY,
};
