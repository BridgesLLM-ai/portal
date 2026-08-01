import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';
import { LEGACY_OPENCLAW_RETIREMENT_PENDING_MESSAGE } from './legacyOpenClawRetirementPolicy';
import { attestProjectRoot, ensureProjectIdentity } from './projectIdentity';

const LEGACY_OPENCLAW_DESTRUCTIVE_RETIREMENT_ENABLED = false as const;

const LEGACY_AGENT_ID_PATTERN = /^portal-([a-f0-9]{8})-([a-z0-9][a-z0-9_-]*)$/;
const USER_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LEGACY_IMAGE = 'openclaw-sandbox:bookworm-slim';
const LEGACY_CONTAINER_LABEL = 'openclaw.sandbox';
const LEGACY_SESSION_LABEL = 'openclaw.sessionKey';
const LEGACY_CONFIG_HASH_LABEL = 'openclaw.configHash';
const LEGACY_CREATED_AT_LABEL = 'openclaw.createdAtMs';
const LEGACY_MOUNT_FORMAT_LABEL = 'openclaw.mountFormatVersion';
const LEGACY_MOUNT_FORMAT = '3';

const CONFIG_RPC_TIMEOUT_MS = 15_000;
const MUTATION_RPC_TIMEOUT_MS = 20_000;
const DOCKER_TIMEOUT_MS = 15_000;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_CONFIG_AGENTS = 2_048;
const MAX_LEGACY_AGENTS = 128;
const MAX_SANDBOX_CONTAINERS = 512;
const MAX_SESSION_ROWS_PER_AGENT = 2_000;
const MAX_GLOBAL_SESSION_REGISTRATIONS = 10_000;
const SESSION_PAGE_SIZE = 200;
const MAX_RPC_CALLS = 1_024;
const MAX_DOCKER_CALLS = 2_048;
const HISTORICAL_PORTAL_PROJECTS_ROOT = '/portal/projects';
const MAX_HISTORY_ROWS_PER_SESSION = 8_192;
const MAX_HISTORY_ROWS_TOTAL = 8_192;
// OpenClaw's display projection is stateful across neighboring raw records, so
// independently projected offset pages are not safely composable. Import only
// a complete installed-API page and fail pending above that bounded contract.
const HISTORY_PAGE_SIZE = 1_000;
const MAX_HISTORY_BYTES_PER_SESSION = 8 * 1024 * 1024;
const MAX_HISTORY_BYTES_TOTAL = 32 * 1024 * 1024;
const MAX_HISTORY_MESSAGE_BYTES = 512 * 1024;
const MAX_DATABASE_ROWS_PER_PROJECT = 2_000;
const MAX_GLOBAL_DATABASE_PROVENANCE_ROWS = 10_000;
const MAX_DATABASE_BYTES_PER_PROJECT = 16 * 1024 * 1024;
const LEGACY_IMPORT_RUNTIME = 'openclaw-dedicated-project-agent';
const HISTORY_MAX_CHARS = 500_000;
const HISTORY_OMISSION_MARKERS = [
  '[chat.history omitted: message too large]',
  '[chat.history unavailable: transcript too large to display; the full history is preserved on disk]',
  '...(truncated)...',
] as const;
const LEGACY_IMPORT_MESSAGE_PREFIX = 'legacy-openclaw:';
const LEGACY_IMPORT_COMPLETE = 'COMPLETE';
const LEGACY_IMPORT_RETIRED = 'RETIRED';
const LEGACY_IMPORT_CLEARED = 'CLEARED';
const LEGACY_IMPORT_IMPORTED = 'IMPORTED';
const LEGACY_QUARANTINE_REASON = 'UNMATCHED_SQL';
const DESTRUCTIVE_RESET_ADMISSION_PREFIX = 'portal-runtime-admission:destructive-reset-';
const MIGRATION_LEASE_ID = 'portal-3x-openclaw-project-import-v1';
const MIGRATION_LEASE_DURATION_MS = 120_000;
const MIGRATION_LEASE_HEARTBEAT_MS = 30_000;
const MAX_HISTORY_SNAPSHOT_ATTEMPTS = 3;
const MAX_IMPORT_RECOVERY_PROOFS = 2_048;
const LEGACY_MODEL_SWITCH_PREFIX = '[Note: Model switched to ';
const LEGACY_PROJECT_CONTEXT_PREFIX = '[PORTAL PROJECT CONTEXT]\n';
const LEGACY_PROJECT_CONTEXT_END = '\n[END CONTEXT]\n\n';
const MAX_PROJECT_CREATION_COLLISION_SCAN_QUEUE = 8;
let projectCreationCollisionScanTail: Promise<void> = Promise.resolve();
let projectCreationCollisionScansPending = 0;

// Keep the testable database port below, but make the production build prove
// that the generated Prisma client really contains every migration field. A
// broad runtime cast must never be able to turn a missing schema into a boot-
// time surprise again.
type LegacyImportPrismaMessageContract = Pick<
  Prisma.ProjectChatMessageUncheckedCreateInput,
  | 'sourceOrdinal'
  | 'sourceKeyHash'
  | 'sourceEventId'
  | 'sourceEventSeq'
  | 'sourceProjectionIndex'
  | 'sourceFingerprint'
  | 'sourceSortKey'
  | 'legacyImportStatus'
>;
type LegacyImportPrismaJournalContract = Prisma.LegacyOpenClawProjectImportUncheckedCreateInput;
type LegacyImportPrismaQuarantineContract = Prisma.LegacyOpenClawProjectQuarantineUncheckedCreateInput;
void (0 as unknown as LegacyImportPrismaMessageContract);
void (0 as unknown as LegacyImportPrismaJournalContract);
void (0 as unknown as LegacyImportPrismaQuarantineContract);

interface RpcResponse {
  ok: boolean;
  data?: any;
  error?: any;
}

export interface LegacyRetirementCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface LegacyOpenClawProjectRetirementDependencies {
  readConfig(configPath: string): Promise<Record<string, any> | null> | Record<string, any> | null;
  rpc(method: string, params: Record<string, any>, timeoutMs: number): Promise<RpcResponse>;
  dockerAvailable(): boolean;
  docker(args: readonly string[], timeoutMs: number): Promise<LegacyRetirementCommandResult>;
  assertMutationLease(): Promise<void>;
  assertMutationLeaseInTransaction(transaction: LegacyOpenClawProjectRetirementTransaction): Promise<void>;
  markAffectedProjectIdentities(targets: readonly LegacyProjectMigrationTarget[]): Promise<void>;
  markCompletedProjectIdentities(targets: readonly LegacyProjectMigrationTarget[]): Promise<void>;
  log(message: string): void;
}

export interface LegacyOpenClawProjectRetirementOptions {
  portalProjectsRoot?: string;
  openClawHome?: string;
  openClawConfigPath?: string;
  database?: LegacyOpenClawProjectRetirementDatabase;
  dependencies?: Partial<LegacyOpenClawProjectRetirementDependencies>;
}

export interface LegacyOpenClawProjectRetirementResult {
  candidatesFound: number;
  canonicalSessionsImported: number;
  messagesImported: number;
  configuredAgentsRetired: number;
  sessionsRetired: number;
  containersRetired: number;
}

interface RetirementRoots {
  portalProjectsRoots: readonly string[];
  openClawHome: string;
  openClawSandboxesRoot: string;
  openClawConfigPath: string;
}

type LegacyGeneration = 'legacy-work' | 'legacy-workspace';

interface LegacyAgentCandidate {
  agentId: string;
  userId: string;
  projectName: string;
  projectSource: string;
  projectRoot: string;
  projectTarget: '/home/user/project' | '/workspace/project';
  workspace: string;
  generation: LegacyGeneration;
}

interface LegacySessionCandidate {
  agentId: string;
  key: string;
  sessionId?: string;
  lifecycleRevision?: string;
  updatedAt?: number;
  archived?: boolean;
}

interface DockerContainerInspect {
  Id?: string;
  Name?: string;
  Config?: {
    Image?: string;
    User?: string;
    WorkingDir?: string;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    Labels?: Record<string, string> | null;
    ExposedPorts?: Record<string, unknown> | null;
    Volumes?: Record<string, unknown> | null;
  };
  State?: { Running?: boolean };
  HostConfig?: {
    NetworkMode?: string;
    Binds?: string[] | null;
    ReadonlyRootfs?: boolean;
    Privileged?: boolean;
    CapAdd?: string[] | null;
    CapDrop?: string[] | null;
    SecurityOpt?: string[] | null;
    PortBindings?: Record<string, unknown> | null;
    PublishAllPorts?: boolean;
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
    AutoRemove?: boolean;
    Links?: string[] | null;
    VolumesFrom?: string[] | null;
    Devices?: unknown[] | null;
    DeviceRequests?: unknown[] | null;
  };
  Mounts?: Array<{
    Type?: string;
    Source?: string;
    Destination?: string;
    Mode?: string;
    RW?: boolean;
  }>;
  NetworkSettings?: {
    Networks?: Record<string, unknown> | null;
    Ports?: Record<string, unknown> | null;
  };
}

interface LegacyContainerCandidate {
  containerId: string;
  agentId: string;
  userId: string;
  projectName: string;
  sessionKey: string;
  projectSource: string;
  projectRoot: string;
  projectTarget: '/home/user/project' | '/workspace/project';
  fingerprint: string;
}

interface LegacyProjectIdentityRow {
  id: string;
  workspaceOwnerId: string;
  projectName: string;
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  generation: number;
  lifecycleStatus?: string;
  legacyOpenClawMigrationStatus?: string;
  lastRenameSourceName?: string | null;
  lastRenameCompletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LegacyProjectMigrationTarget {
  id: string;
  actorUserId: string;
  generation: number;
}

interface LegacyProjectMessageRow {
  id: string;
  projectId: string;
  userId: string;
  sessionKey: string;
  role: string;
  content: string;
  timestamp: Date;
  messageId: string | null;
  provider: string;
  runtime: string;
  model: string | null;
  providerSessionId: string | null;
  turnId?: string | null;
  presentation?: unknown | null;
  sourceOrdinal?: number | null;
  sourceKeyHash?: string | null;
  sourceEventId?: string | null;
  sourceEventSeq?: number | null;
  sourceProjectionIndex?: number | null;
  sourceFingerprint?: string | null;
  sourceSortKey?: string | null;
  legacyImportStatus?: string | null;
}

interface LegacyImportJournalRow {
  id: string;
  actorUserId: string;
  projectIdentityId: string;
  projectGeneration: number;
  candidateAgentId: string;
  candidateAgentHash: string;
  sourceAgentId: string;
  sourceAgentHash: string;
  sourceSessionKey: string;
  sessionKeyHash: string;
  sourceKind: string;
  sourceStatus: string;
  providerSessionId: string;
  providerSessionIdHash: string;
  sourceFingerprint: string;
  artifactInventoryFingerprint: string;
  agentInventoryFingerprint: string;
  totalMessages: number;
  importedMessages: number;
  transcriptDigest: string;
  projectionDigest: string;
  completedAt: Date;
  retiredAt: Date | null;
  clearedAt: Date | null;
  updatedAt: Date;
}

interface LegacyQuarantineRow {
  id: string;
  originalMessageId: string;
  actorUserId: string;
  projectIdentityId: string;
  projectGeneration: number;
  originalProjectId: string;
  sessionKey: string;
  role: string;
  content: string;
  timestamp: Date;
  messageId: string | null;
  provider: string;
  runtime: string;
  model: string | null;
  providerSessionId: string | null;
  reason: string;
  payloadDigest: string;
}

interface LegacyOpenClawProjectRetirementTransaction {
  projectIdentity: {
    findUnique(args: unknown): Promise<LegacyProjectIdentityRow | null>;
    findFirst(args: unknown): Promise<LegacyProjectIdentityRow | null>;
    findMany(args: unknown): Promise<LegacyProjectIdentityRow[]>;
    create(args: unknown): Promise<LegacyProjectIdentityRow>;
  };
  projectChatMessage: {
    findMany(args: unknown): Promise<LegacyProjectMessageRow[]>;
    findUnique(args: unknown): Promise<LegacyProjectMessageRow | null>;
    create(args: unknown): Promise<LegacyProjectMessageRow>;
    update(args: unknown): Promise<LegacyProjectMessageRow>;
    updateMany(args: unknown): Promise<{ count: number }>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
  projectChatSession: {
    findMany(args: unknown): Promise<Array<{
      id: string;
      userId: string;
      projectId: string;
      sessionKey: string;
      status: string;
      runtime: string;
    }>>;
  };
  projectChatProviderBinding: {
    findMany(args: unknown): Promise<Array<{
      id: string;
      userId: string;
      projectId: string;
      provider: string;
      runtime: string;
      status: string;
      sessionKey: string | null;
      externalSessionId: string | null;
    }>>;
  };
  projectChatTurn: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
  };
  projectChatDestructiveResetJournal: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
  };
  legacyOpenClawProjectClearTombstone: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
  };
  legacyOpenClawProjectImport: {
    findUnique(args: unknown): Promise<LegacyImportJournalRow | null>;
    findMany(args: unknown): Promise<LegacyImportJournalRow[]>;
    create(args: unknown): Promise<LegacyImportJournalRow>;
    update(args: unknown): Promise<LegacyImportJournalRow>;
  };
  legacyOpenClawProjectQuarantine: {
    findUnique(args: unknown): Promise<LegacyQuarantineRow | null>;
    findMany(args: unknown): Promise<LegacyQuarantineRow[]>;
    create(args: unknown): Promise<LegacyQuarantineRow>;
  };
}

export interface LegacyOpenClawProjectRetirementDatabase extends LegacyOpenClawProjectRetirementTransaction {
  $transaction<T>(
    callback: (tx: LegacyOpenClawProjectRetirementTransaction) => Promise<T>,
    options?: { isolationLevel?: 'Serializable'; maxWait?: number; timeout?: number },
  ): Promise<T>;
}

interface LegacyHistoryMessage {
  sourceId: string;
  sourceSeq: number;
  sourceRecordTimestampMs?: number;
  sourceFingerprint: string;
  role: 'user' | 'assistant';
  content: string;
  databaseMatchContents: readonly string[];
  timestamp: Date;
  model: string | null;
  deterministicId: string;
  deterministicMessageId: string;
  ordinal: number;
  projectionIndex: number;
}

interface LegacyCanonicalHistory {
  agentId: string;
  sessionKey: string;
  providerSessionId: string | null;
  status: 'missing' | 'present';
  totalMessages: number;
  serializedBytes: number;
  transcriptDigest: string;
  sourceFingerprint: string;
  describedSession: LegacySessionCandidate;
  messages: readonly LegacyHistoryMessage[];
}

interface LegacyProjectCandidate {
  agentId: string;
  userId: string;
  projectName: string;
  projectSource: string;
  projectRoot: string;
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
}

interface LegacyImportSummary {
  canonicalSessionsImported: number;
  messagesImported: number;
  sessions: readonly LegacyCanonicalHistory[];
  artifactInventoryFingerprints: ReadonlyMap<string, string>;
}

interface LegacyProjectSessionSource {
  candidate: LegacyProjectCandidate;
  identity: LegacyProjectIdentityRow;
  session: LegacySessionCandidate;
}

interface OperationBudget {
  rpcCalls: number;
  dockerCalls: number;
}

export class LegacyOpenClawProjectRetirementError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LegacyOpenClawProjectRetirementError';
    this.code = code;
  }
}

export function shouldRetryLegacyOpenClawProjectMigration(error: unknown): boolean {
  return !(
    error instanceof LegacyOpenClawProjectRetirementError
    && error.code === 'LEGACY_DESTRUCTIVE_RETIREMENT_DISABLED'
  );
}

function fail(code: string, message: string): never {
  throw new LegacyOpenClawProjectRetirementError(code, message);
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

function exactAbsolutePath(value: string, label: string): string {
  if (!value || !path.isAbsolute(value) || value.includes('\0')) {
    fail('INVALID_ROOT', `${label} must be an absolute host path`);
  }
  const resolved = path.resolve(value);
  if (resolved !== value) {
    fail('INVALID_ROOT', `${label} must be normalized before legacy retirement`);
  }
  return resolved;
}

function relativeSegments(root: string, target: string, label: string): string[] {
  if (!path.isAbsolute(target) || target.includes('\0') || path.resolve(target) !== target) {
    fail('PATH_ATTESTATION', `${label} was not a normalized absolute host path`);
  }
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('PATH_ATTESTATION', `${label} was outside its configured server-owned root`);
  }
  const segments = relative.split(path.sep);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail('PATH_ATTESTATION', `${label} contained an ambiguous path component`);
  }
  return segments;
}

function assertNoExistingSymlink(root: string, target: string, label: string): void {
  const segments = relativeSegments(root, target, label);
  let current = root;
  const paths = [root, ...segments.map((segment) => {
    current = path.join(current, segment);
    return current;
  })];
  for (const candidate of paths) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        fail('PATH_SYMLINK', `${label} resolved through a symbolic link`);
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

function parseLegacyAgentId(agentId: string): { userPrefix: string; slug: string } | null {
  if (agentId.length > 64) return null;
  const match = agentId.match(LEGACY_AGENT_ID_PATTERN);
  return match ? { userPrefix: match[1], slug: match[2] } : null;
}

function parseLegacySessionKey(value: string): { agentId: string; rest: string } | null {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const match = value.match(/^agent:([^:]+):(.+)$/);
  if (!match || !parseLegacyAgentId(match[1])) return null;
  return { agentId: match[1], rest: match[2] };
}

function attestProjectSource(
  source: string,
  agentId: string,
  roots: RetirementRoots,
): { userId: string; projectName: string; projectRoot: string } {
  const identity = parseLegacyAgentId(agentId);
  if (!identity) fail('AGENT_IDENTITY', 'Legacy Project agent id was not exact');
  if (!path.isAbsolute(source) || source.includes('\0') || path.resolve(source) !== source) {
    fail('PATH_ATTESTATION', 'Legacy Project bind source was not a normalized absolute host path');
  }
  const containing = roots.portalProjectsRoots.flatMap((projectRoot) => {
    const relative = path.relative(projectRoot, source);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return [];
    return [{ projectRoot, segments: relative.split(path.sep) }];
  });
  if (containing.length === 0) {
    fail('PATH_ATTESTATION', 'Legacy Project bind source was outside the exact Portal root allowlist');
  }
  const exact = containing.filter(({ segments }) => segments.length === 2);
  if (exact.length !== 1) {
    fail('PROJECT_BIND_DEPTH', 'Legacy Project bind must name exactly one user and one project');
  }
  const [{ projectRoot, segments }] = exact;
  if (segments.length !== 2) {
    fail('PROJECT_BIND_DEPTH', 'Legacy Project bind must name exactly one user and one project');
  }
  const [userId, projectName] = segments;
  if (!USER_ID_PATTERN.test(userId) || userId.slice(0, 8) !== identity.userPrefix) {
    fail('PROJECT_BIND_IDENTITY', 'Legacy Project bind did not match the agent user identity');
  }
  if (
    !projectName
    || projectName === '.'
    || projectName === '..'
    || projectName.length > 255
    || /[\u0000-\u001f\u007f]/.test(projectName)
  ) {
    fail('PROJECT_BIND_IDENTITY', 'Legacy Project bind had an invalid project name');
  }
  assertNoExistingSymlink(projectRoot, source, 'legacy Project bind source');
  return { userId, projectName, projectRoot };
}

function parseConfiguredProjectBind(
  value: unknown,
  agentId: string,
  roots: RetirementRoots,
): {
  source: string;
  target: '/home/user/project' | '/workspace/project';
  userId: string;
  projectName: string;
  projectRoot: string;
} {
  if (typeof value !== 'string') {
    fail('AGENT_BIND', 'Legacy Project agent bind was not a string');
  }
  const match = value.match(/^([^:]+):(\/home\/user\/project|\/workspace\/project):rw$/);
  if (!match) fail('AGENT_BIND', 'Legacy Project agent bind did not match a retired Portal layout');
  const source = match[1];
  const target = match[2] as '/home/user/project' | '/workspace/project';
  const project = attestProjectSource(source, agentId, roots);
  return {
    source,
    target,
    userId: project.userId,
    projectName: project.projectName,
    projectRoot: project.projectRoot,
  };
}

function hasLegacyAgentRuntimeSignal(entry: Record<string, any>, roots: RetirementRoots): boolean {
  const sandbox = isRecord(entry.sandbox) ? entry.sandbox : {};
  const docker = isRecord(sandbox.docker) ? sandbox.docker : {};
  const workspace = typeof entry.workspace === 'string' ? entry.workspace : '';
  const binds = Array.isArray(docker.binds) ? docker.binds : [];
  const workspaceLooksLegacy = workspace.startsWith(`${roots.openClawSandboxesRoot}${path.sep}portal-`)
    && workspace.endsWith('-workspace');
  const bindLooksLegacy = binds.some((bind) => typeof bind === 'string'
    && (bind.includes(':/home/user/project:rw') || bind.includes(':/workspace/project:rw')));
  return workspaceLooksLegacy
    || bindLooksLegacy
    || docker.image === LEGACY_IMAGE
    || docker.network === 'bridge';
}

function attestLegacyAgent(entry: Record<string, any>, roots: RetirementRoots): LegacyAgentCandidate {
  const agentId = typeof entry.id === 'string' ? entry.id : '';
  const identity = parseLegacyAgentId(agentId);
  if (!identity) fail('AGENT_IDENTITY', 'Legacy Project agent id was ambiguous');
  if (agentId === 'main' || agentId.startsWith('p4oc-')) {
    fail('PROTECTED_AGENT', 'Refusing to treat a protected OpenClaw agent as legacy');
  }

  const workspace = typeof entry.workspace === 'string' ? entry.workspace : '';
  const expectedWorkspace = path.join(roots.openClawSandboxesRoot, `${agentId}-workspace`);
  if (workspace !== expectedWorkspace) {
    fail('AGENT_WORKSPACE', `Legacy Project agent ${agentId} workspace was not server-owned`);
  }
  assertNoExistingSymlink(roots.openClawSandboxesRoot, workspace, 'legacy agent workspace');

  const sandbox = isRecord(entry.sandbox) ? entry.sandbox : {};
  const docker = isRecord(sandbox.docker) ? sandbox.docker : {};
  if (sandbox.mode !== 'all' || sandbox.scope !== 'session') {
    fail('AGENT_SANDBOX', `Legacy Project agent ${agentId} sandbox policy was not exact`);
  }
  if (sandbox.backend !== undefined && sandbox.backend !== 'docker') {
    fail('AGENT_SANDBOX', `Legacy Project agent ${agentId} had an unexpected sandbox backend`);
  }
  if (docker.image !== LEGACY_IMAGE || docker.network !== 'bridge') {
    fail('AGENT_RUNTIME', `Legacy Project agent ${agentId} runtime image or network drifted`);
  }
  if (docker.dangerouslyAllowExternalBindSources !== true) {
    fail('AGENT_RUNTIME', `Legacy Project agent ${agentId} external bind attestation was absent`);
  }
  if (!Array.isArray(docker.binds) || docker.binds.length !== 1) {
    fail('AGENT_BIND', `Legacy Project agent ${agentId} did not have exactly one Project bind`);
  }

  const bind = parseConfiguredProjectBind(docker.binds[0], agentId, roots);
  let generation: LegacyGeneration;
  if (bind.target === '/home/user/project') {
    if (
      sandbox.workspaceAccess !== 'none'
      || docker.workdir !== '/work'
      || docker.dangerouslyAllowReservedContainerTargets === true
    ) {
      fail('AGENT_GENERATION', `Legacy Project agent ${agentId} mixed retired runtime generations`);
    }
    generation = 'legacy-work';
  } else {
    if (
      sandbox.workspaceAccess !== 'rw'
      || docker.workdir !== '/workspace'
      || docker.dangerouslyAllowReservedContainerTargets !== true
    ) {
      fail('AGENT_GENERATION', `Legacy Project agent ${agentId} mixed retired runtime generations`);
    }
    generation = 'legacy-workspace';
  }

  return Object.freeze({
    agentId,
    userId: bind.userId,
    projectName: bind.projectName,
    projectSource: bind.source,
    projectRoot: bind.projectRoot,
    projectTarget: bind.target,
    workspace,
    generation,
  });
}

function configAgentList(config: Record<string, any>): Record<string, any>[] {
  const raw = config?.agents?.list;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail('CONFIG_SHAPE', 'OpenClaw agents.list was not an array');
  if (raw.length > MAX_CONFIG_AGENTS) fail('CONFIG_LIMIT', 'OpenClaw agents.list exceeded the retirement safety limit');
  return raw.filter(isRecord);
}

export function discoverLegacyOpenClawProjectAgents(
  config: Record<string, any>,
  input: { portalProjectsRoot: string; openClawHome: string } | RetirementRoots,
): LegacyAgentCandidate[] {
  const roots = 'portalProjectsRoots' in input
    ? input
    : buildRoots({
        portalProjectsRoot: input.portalProjectsRoot,
        openClawHome: input.openClawHome,
      });
  const candidates: LegacyAgentCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of configAgentList(config)) {
    const agentId = typeof entry.id === 'string' ? entry.id : '';
    const exactLegacyId = parseLegacyAgentId(agentId);
    const runtimeSignal = hasLegacyAgentRuntimeSignal(entry, roots);

    if (agentId === 'main' || /^p4oc-[a-f0-9]{40}$/.test(agentId)) {
      if (runtimeSignal && entry?.sandbox?.docker?.image === LEGACY_IMAGE) {
        fail('PROTECTED_AGENT_DRIFT', `Protected OpenClaw agent ${agentId} matched a legacy bridge runtime`);
      }
      continue;
    }
    if (!exactLegacyId) {
      if ((agentId.startsWith('portal-') || runtimeSignal) && runtimeSignal) {
        fail('AMBIGUOUS_AGENT', 'An OpenClaw agent resembled a legacy Project runtime but was not exactly attested');
      }
      continue;
    }
    if (seen.has(agentId)) fail('DUPLICATE_AGENT', `Legacy Project agent ${agentId} was duplicated`);
    seen.add(agentId);
    candidates.push(attestLegacyAgent(entry, roots));
  }
  if (candidates.length > MAX_LEGACY_AGENTS) {
    fail('AGENT_LIMIT', 'Legacy Project agent count exceeded the bounded retirement limit');
  }
  return candidates;
}

function arrayEquals(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sortedStrings(value: string[] | null | undefined): string[] {
  return [...(value || [])].sort();
}

function containerFingerprint(candidate: Omit<LegacyContainerCandidate, 'fingerprint'>, inspect: DockerContainerInspect): string {
  const labels = inspect.Config?.Labels || {};
  return JSON.stringify({
    id: candidate.containerId,
    name: inspect.Name,
    agentId: candidate.agentId,
    sessionKey: candidate.sessionKey,
    projectSource: candidate.projectSource,
    projectTarget: candidate.projectTarget,
    image: inspect.Config?.Image,
    user: inspect.Config?.User,
    workingDir: inspect.Config?.WorkingDir,
    labels: {
      sandbox: labels[LEGACY_CONTAINER_LABEL],
      session: labels[LEGACY_SESSION_LABEL],
      configHash: labels[LEGACY_CONFIG_HASH_LABEL],
      createdAt: labels[LEGACY_CREATED_AT_LABEL],
      mountFormat: labels[LEGACY_MOUNT_FORMAT_LABEL],
    },
    binds: sortedStrings(inspect.HostConfig?.Binds),
    mounts: [...(inspect.Mounts || [])]
      .map((mount) => ({
        type: mount.Type,
        source: mount.Source,
        destination: mount.Destination,
        mode: mount.Mode,
        rw: mount.RW,
      }))
      .sort((left, right) => String(left.destination).localeCompare(String(right.destination))),
    networkMode: inspect.HostConfig?.NetworkMode,
  });
}

function containerHasLegacySignal(inspect: DockerContainerInspect, roots: RetirementRoots): boolean {
  const labels = inspect.Config?.Labels || {};
  const sessionKey = String(labels[LEGACY_SESSION_LABEL] || '');
  const name = String(inspect.Name || '');
  const mounts = inspect.Mounts || [];
  return /^agent:portal-[a-f0-9]{8}-/.test(sessionKey)
    || name.startsWith('/openclaw-sbx-agent-portal-')
    || mounts.some((mount) => String(mount.Source || '').startsWith(`${roots.openClawSandboxesRoot}${path.sep}agent-portal-`))
    || (
      inspect.Config?.Image === LEGACY_IMAGE
      && mounts.some((mount) => (
        mount.Destination === '/home/user/project'
        || mount.Destination === '/workspace/project'
      ) && roots.portalProjectsRoots.some((projectRoot) => (
        String(mount.Source || '').startsWith(`${projectRoot}${path.sep}`)
      )))
    );
}

function attestLegacyContainer(
  inspect: DockerContainerInspect,
  roots: RetirementRoots,
): LegacyContainerCandidate | null {
  const labels = inspect.Config?.Labels || {};
  const legacySignal = containerHasLegacySignal(inspect, roots);
  if (labels[LEGACY_CONTAINER_LABEL] !== '1') {
    if (legacySignal) {
      fail('AMBIGUOUS_CONTAINER', 'A container resembled a legacy Project runtime without its exact ownership label');
    }
    return null;
  }

  const sessionKey = String(labels[LEGACY_SESSION_LABEL] || '');
  const anySession = sessionKey.match(/^agent:([^:]+):(.+)$/);
  const sessionAgentId = anySession?.[1] || '';
  if (sessionAgentId === 'main' || /^p4oc-[a-f0-9]{40}$/.test(sessionAgentId)) {
    const unmistakablyLegacyRuntime = inspect.Config?.Image === LEGACY_IMAGE
      || inspect.HostConfig?.NetworkMode === 'bridge'
      || String(inspect.Name || '').startsWith('/openclaw-sbx-agent-portal-')
      || (inspect.Mounts || []).some((mount) => String(mount.Source || '')
        .startsWith(`${roots.openClawSandboxesRoot}${path.sep}agent-portal-`));
    if (unmistakablyLegacyRuntime) {
      fail('PROTECTED_CONTAINER', 'A protected OpenClaw identity was attached to a legacy bridge runtime');
    }
    return null;
  }
  const parsedSession = parseLegacySessionKey(sessionKey);
  if (!parsedSession) {
    if (legacySignal) {
      fail('AMBIGUOUS_CONTAINER', 'An OpenClaw sandbox resembled a legacy Project container without an exact session identity');
    }
    return null;
  }
  const containerId = String(inspect.Id || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(containerId)) {
    fail('CONTAINER_ID', 'Legacy Project container did not have a full immutable Docker id');
  }
  const identity = parseLegacyAgentId(parsedSession.agentId)!;
  const internalNamePattern = new RegExp(`^agent-portal-${identity.userPrefix}-[a-z0-9_-]+-[a-f0-9]{8}$`);
  const name = String(inspect.Name || '');
  const config = inspect.Config || {};
  const host = inspect.HostConfig || {};

  if (typeof inspect.State?.Running !== 'boolean') {
    fail('CONTAINER_STATE', `Legacy Project container ${containerId} state was incomplete`);
  }
  if (
    config.Image !== LEGACY_IMAGE
    || config.User !== '0:0'
    || (config.WorkingDir !== '/work' && config.WorkingDir !== '/workspace')
    || !arrayEquals(config.Cmd || [], ['sleep', 'infinity'])
    || !isEmpty(config.Entrypoint)
    || !isEmpty(config.ExposedPorts)
    || !isEmpty(config.Volumes)
  ) {
    fail('CONTAINER_RUNTIME', `Legacy Project container ${containerId} runtime did not match exactly`);
  }
  const workspaceGeneration = config.WorkingDir === '/workspace';
  if (
    host.NetworkMode !== 'bridge'
    || host.ReadonlyRootfs !== true
    || host.Privileged !== false
    || !isEmpty(host.CapAdd)
    || !arrayEquals(sortedStrings(host.CapDrop), ['ALL'])
    || !arrayEquals(sortedStrings(host.SecurityOpt), ['no-new-privileges'])
    || !isEmpty(host.PortBindings)
    || host.PublishAllPorts !== false
    || host.RestartPolicy?.Name !== 'no'
    || host.AutoRemove !== false
    || !isEmpty(host.Links)
    || !isEmpty(host.VolumesFrom)
    || !isEmpty(host.Devices)
    || !isEmpty(host.DeviceRequests)
    || !isEmpty(inspect.NetworkSettings?.Ports)
  ) {
    fail('CONTAINER_HOST_POLICY', `Legacy Project container ${containerId} host policy drifted`);
  }
  const networks = Object.keys(inspect.NetworkSettings?.Networks || {}).sort();
  if (!arrayEquals(networks, ['bridge'])) {
    fail('CONTAINER_NETWORKS', `Legacy Project container ${containerId} had unexpected network attachments`);
  }
  if (
    !/^[a-f0-9]{64}$/.test(String(labels[LEGACY_CONFIG_HASH_LABEL] || ''))
    || !/^\d{10,}$/.test(String(labels[LEGACY_CREATED_AT_LABEL] || ''))
    || labels[LEGACY_MOUNT_FORMAT_LABEL] !== LEGACY_MOUNT_FORMAT
  ) {
    fail('CONTAINER_LABELS', `Legacy Project container ${containerId} labels were incomplete`);
  }

  // Portal 3.x produced two container generations. The older one worked from
  // an internal read-only '/work' mount with the project at /home/user/project;
  // the newer one mounts the agent workspace read-write at '/workspace' plus a
  // read-only sandbox-skills mount, with the project at /workspace/project.
  // Each generation is attested exactly; mixing their traits fails closed.
  const mounts = inspect.Mounts || [];
  const expectedMountCount = workspaceGeneration ? 3 : 2;
  if (mounts.length !== expectedMountCount || (host.Binds || []).length !== expectedMountCount) {
    fail('CONTAINER_MOUNTS', `Legacy Project container ${containerId} mount count drifted`);
  }
  const expectedProjectTarget = workspaceGeneration ? '/workspace/project' : '/home/user/project';
  const projectMounts = mounts.filter((mount) => (
    mount.Destination === '/home/user/project' || mount.Destination === '/workspace/project'
  ));
  const expectedBinds: string[] = [];
  if (workspaceGeneration) {
    const workspaceMount = mounts.find((mount) => mount.Destination === '/workspace');
    if (
      !workspaceMount
      || workspaceMount.Type !== 'bind'
      || workspaceMount.RW !== true
      || workspaceMount.Mode !== 'z'
      || typeof workspaceMount.Source !== 'string'
    ) {
      fail('CONTAINER_INTERNAL_MOUNT', `Legacy Project container ${containerId} workspace mount drifted`);
    }
    const workspaceSegments = relativeSegments(
      roots.openClawSandboxesRoot,
      workspaceMount.Source,
      'legacy container workspace',
    );
    if (workspaceSegments.length !== 1 || workspaceSegments[0] !== `${parsedSession.agentId}-workspace`) {
      fail('CONTAINER_INTERNAL_MOUNT', `Legacy Project container ${containerId} workspace identity drifted`);
    }
    assertNoExistingSymlink(roots.openClawSandboxesRoot, workspaceMount.Source, 'legacy container workspace');

    const skillsMount = mounts.find((mount) => mount.Destination === '/workspace/.openclaw/sandbox-skills/skills');
    if (
      !skillsMount
      || skillsMount.Type !== 'bind'
      || skillsMount.RW !== false
      || skillsMount.Mode !== 'ro,z'
      || typeof skillsMount.Source !== 'string'
    ) {
      fail('CONTAINER_SKILLS_MOUNT', `Legacy Project container ${containerId} sandbox-skills mount drifted`);
    }
    const skillsRoot = path.join(roots.openClawHome, 'sandbox', 'skills-workspaces');
    const skillsSegments = relativeSegments(skillsRoot, skillsMount.Source, 'legacy container sandbox skills');
    if (
      skillsSegments.length !== 4
      || !internalNamePattern.test(skillsSegments[0])
      || skillsSegments[1] !== '.openclaw'
      || skillsSegments[2] !== 'sandbox-skills'
      || skillsSegments[3] !== 'skills'
    ) {
      fail('CONTAINER_SKILLS_MOUNT', `Legacy Project container ${containerId} sandbox-skills identity drifted`);
    }
    assertNoExistingSymlink(skillsRoot, skillsMount.Source, 'legacy container sandbox skills');
    if (name !== `/openclaw-sbx-${skillsSegments[0]}`) {
      fail('CONTAINER_NAME', `Legacy Project container ${containerId} name did not match its sandbox-skills identity`);
    }
    expectedBinds.push(
      `${workspaceMount.Source}:/workspace:z`,
      `${skillsMount.Source}:/workspace/.openclaw/sandbox-skills/skills:ro,z`,
    );
  } else {
    const internalMount = mounts.find((mount) => mount.Destination === '/work');
    if (
      !internalMount
      || internalMount.Type !== 'bind'
      || internalMount.RW !== false
      || internalMount.Mode !== 'ro,z'
      || typeof internalMount.Source !== 'string'
    ) {
      fail('CONTAINER_INTERNAL_MOUNT', `Legacy Project container ${containerId} internal workspace mount drifted`);
    }
    const internalSegments = relativeSegments(
      roots.openClawSandboxesRoot,
      internalMount.Source,
      'legacy container internal workspace',
    );
    if (internalSegments.length !== 1 || !internalNamePattern.test(internalSegments[0])) {
      fail('CONTAINER_INTERNAL_MOUNT', `Legacy Project container ${containerId} internal workspace identity drifted`);
    }
    assertNoExistingSymlink(roots.openClawSandboxesRoot, internalMount.Source, 'legacy container internal workspace');
    if (name !== `/openclaw-sbx-${internalSegments[0]}`) {
      fail('CONTAINER_NAME', `Legacy Project container ${containerId} name did not match its internal workspace`);
    }
    expectedBinds.push(`${internalMount.Source}:/work:ro,z`);
  }

  if (projectMounts.length !== 1) {
    fail('CONTAINER_PROJECT_MOUNT', `Legacy Project container ${containerId} Project mount was ambiguous`);
  }
  const projectMount = projectMounts[0];
  if (
    projectMount.Type !== 'bind'
    || projectMount.RW !== true
    || projectMount.Mode !== 'rw'
    || typeof projectMount.Source !== 'string'
    || projectMount.Destination !== expectedProjectTarget
  ) {
    fail('CONTAINER_PROJECT_MOUNT', `Legacy Project container ${containerId} Project mount drifted`);
  }
  const project = attestProjectSource(projectMount.Source, parsedSession.agentId, roots);
  const projectTarget = projectMount.Destination as '/home/user/project' | '/workspace/project';
  expectedBinds.push(`${projectMount.Source}:${projectTarget}:rw`);
  expectedBinds.sort();
  if (!arrayEquals(sortedStrings(host.Binds), expectedBinds)) {
    fail('CONTAINER_BINDS', `Legacy Project container ${containerId} bind configuration drifted`);
  }

  const candidate = {
    containerId,
    agentId: parsedSession.agentId,
    userId: project.userId,
    projectName: project.projectName,
    sessionKey,
    projectSource: projectMount.Source,
    projectRoot: project.projectRoot,
    projectTarget,
  };
  return Object.freeze({
    ...candidate,
    fingerprint: containerFingerprint(candidate, inspect),
  });
}

function buildRoots(input: {
  portalProjectsRoot?: string;
  openClawHome?: string;
  openClawConfigPath?: string;
}): RetirementRoots {
  const portalRoot = process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || '/portal';
  const portalProjectsRoot = exactAbsolutePath(
    input.portalProjectsRoot || process.env.PORTAL_PROJECTS_ROOT || path.join(portalRoot, 'projects'),
    'Portal projects root',
  );
  const portalProjectsRoots = Array.from(new Set([
    portalProjectsRoot,
    exactAbsolutePath(HISTORICAL_PORTAL_PROJECTS_ROOT, 'Historical Portal projects root'),
  ]));
  const openClawHome = exactAbsolutePath(
    input.openClawHome || process.env.OPENCLAW_HOME || path.join(process.env.HOME || '/root', '.openclaw'),
    'OpenClaw home',
  );
  const openClawConfigPath = exactAbsolutePath(
    input.openClawConfigPath || process.env.OPENCLAW_CONFIG_PATH || path.join(openClawHome, 'openclaw.json'),
    'OpenClaw config path',
  );
  return {
    portalProjectsRoots: Object.freeze(portalProjectsRoots),
    openClawHome,
    openClawSandboxesRoot: path.join(openClawHome, 'sandboxes'),
    openClawConfigPath,
  };
}

export class LegacyOpenClawProjectCreationCollisionError extends Error {
  readonly code = 'LEGACY_OPENCLAW_PROJECT_NAME_COLLISION';

  constructor() {
    super('This Project name still has preserved OpenClaw 3.x state and cannot be reused safely.');
    this.name = 'LegacyOpenClawProjectCreationCollisionError';
  }
}

export class LegacyOpenClawProjectCreationScanCapacityError extends Error {
  readonly code = 'LEGACY_OPENCLAW_PROJECT_CREATION_SCAN_BUSY';

  constructor() {
    super('Project creation safety scans are busy. Retry this request shortly.');
    this.name = 'LegacyOpenClawProjectCreationScanCapacityError';
  }
}

async function withSerializedProjectCreationRuntimeScan<T>(work: () => Promise<T>): Promise<T> {
  if (projectCreationCollisionScansPending >= MAX_PROJECT_CREATION_COLLISION_SCAN_QUEUE) {
    throw new LegacyOpenClawProjectCreationScanCapacityError();
  }
  projectCreationCollisionScansPending += 1;
  const previous = projectCreationCollisionScanTail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.catch(() => undefined).then(() => gate);
  projectCreationCollisionScanTail = current;
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    projectCreationCollisionScansPending -= 1;
    release();
    if (projectCreationCollisionScanTail === current) {
      void current.finally(() => {
        if (projectCreationCollisionScanTail === current) {
          projectCreationCollisionScanTail = Promise.resolve();
        }
      });
    }
  }
}

/**
 * Prove that an authoritative Portal 4 creation is not reusing a name/root
 * still owned by a preserved 3.x runtime or SQL projection. Artifact-only
 * legacy sessions are intentionally not a collision: CURRENT projects never
 * consume name-keyed rows and use a disjoint p4oc-* agent/session namespace.
 */
export async function assertNoLegacyOpenClawProjectCreationCollision(input: {
  workspaceOwnerId: string;
  projectName: string;
  projectRoot: string;
}, options: LegacyOpenClawProjectRetirementOptions = {}): Promise<void> {
  const roots = buildRoots(options);
  const dependencies = { ...defaultDependencies, ...(options.dependencies || {}) };
  const database = options.database || prisma as unknown as LegacyOpenClawProjectRetirementDatabase;
  const root = attestProjectRoot(input.projectRoot);
  const runtimeCandidates = await withSerializedProjectCreationRuntimeScan(async () => {
    const budget: OperationBudget = { rpcCalls: 0, dockerCalls: 0 };
    const localConfig = await dependencies.readConfig(roots.openClawConfigPath);
    const localAgents = localConfig
      ? discoverLegacyOpenClawProjectAgents(localConfig, roots)
      : [];
    const gatewayConfig = parseConfigRpc(await boundedRpc(
      dependencies,
      budget,
      'config.get',
      {},
      CONFIG_RPC_TIMEOUT_MS,
    ));
    const gatewayAgents = discoverLegacyOpenClawProjectAgents(gatewayConfig, roots);
    if (!dependencies.dockerAvailable()) {
      fail('DOCKER_UNAVAILABLE', 'Docker inventory could not be inspected before current Project enrollment');
    }
    const containers = await discoverLegacyContainers(dependencies, budget, roots);
    return [...localAgents, ...gatewayAgents, ...containers];
  });
  const runtimeCollision = runtimeCandidates.some((candidate) => (
    candidate.userId === input.workspaceOwnerId
    && (
      candidate.projectName === input.projectName
      || path.resolve(candidate.projectSource) === root.canonicalRoot
    )
  ));
  const [sessions, bindings, messages] = await Promise.all([
    database.projectChatSession.findMany({
      where: { userId: input.workspaceOwnerId, projectId: input.projectName },
      select: { id: true },
      take: 1,
    }),
    database.projectChatProviderBinding.findMany({
      where: { userId: input.workspaceOwnerId, projectId: input.projectName },
      select: { id: true },
      take: 1,
    }),
    database.projectChatMessage.findMany({
      where: {
        userId: input.workspaceOwnerId,
        projectId: input.projectName,
        provider: 'OPENCLAW',
      },
      select: { id: true },
      take: 1,
    }),
  ]);
  if (runtimeCollision || sessions.length > 0 || bindings.length > 0 || messages.length > 0) {
    throw new LegacyOpenClawProjectCreationCollisionError();
  }
}

function readConfigFile(configPath: string): Record<string, any> | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(configPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
    fail('CONFIG_FILE', 'OpenClaw config file was not a bounded regular file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    fail('CONFIG_FILE', 'OpenClaw config file could not be parsed for legacy retirement');
  }
  if (!isRecord(parsed)) fail('CONFIG_FILE', 'OpenClaw config root was not an object');
  return parsed;
}

function runDockerCommand(args: readonly string[], timeoutMs: number): Promise<LegacyRetirementCommandResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', LANG: 'C' };
    delete env.DOCKER_HOST;
    delete env.DOCKER_CONTEXT;
    delete env.DOCKER_TLS_VERIFY;
    delete env.DOCKER_CERT_PATH;
    const child = spawn('/usr/bin/docker', [...args], {
      cwd: '/',
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let terminalError: Error | null = null;
    let settled = false;
    const finish = (error: Error | null, value?: LegacyRetirementCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES && !terminalError) {
        terminalError = new Error('Legacy retirement Docker output exceeded the safety limit');
        child.kill('SIGKILL');
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', () => finish(new Error('Legacy retirement Docker command failed to start')));
    child.once('close', (code) => {
      if (terminalError) {
        finish(terminalError);
        return;
      }
      finish(null, {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code ?? 1,
      });
    });
    const timer = setTimeout(() => {
      terminalError = new Error(`Legacy retirement Docker command exceeded ${timeoutMs}ms`);
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();
  });
}

const defaultDependencies: LegacyOpenClawProjectRetirementDependencies = {
  readConfig: readConfigFile,
  rpc: gatewayRpcCall,
  dockerAvailable: () => fs.existsSync('/usr/bin/docker'),
  docker: runDockerCommand,
  assertMutationLease: async () => undefined,
  assertMutationLeaseInTransaction: async () => undefined,
  markAffectedProjectIdentities: async () => undefined,
  markCompletedProjectIdentities: async () => undefined,
  log: (message) => console.log(message),
};

interface LegacyMigrationLeaseClaim {
  tokenHash: string;
  owner: string;
}

interface LegacyMigrationLeaseStore {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
}

interface LegacyMigrationLeaseMutationStore {
  updateMany(args: unknown): Promise<{ count: number }>;
}

export interface LegacyOpenClawProjectMigrationCoordinator {
  completion: Promise<LegacyOpenClawProjectRetirementResult>;
  start(): void;
}

async function claimLegacyMigrationLeaseFromStore(
  store: LegacyMigrationLeaseStore,
  claim: LegacyMigrationLeaseClaim,
): Promise<LegacyMigrationLeaseClaim | null> {
  // One PostgreSQL statement covers initial creation, expired-row takeover,
  // and a clean miss behind a live owner. The database clock is shared by all
  // contenders, and the conflict WHERE clause is evaluated while the unique
  // row is locked. This avoids both exception-driven P2002 logging and split
  // read/update races without ever overwriting a live lease.
  const rows = await store.$queryRaw<Array<{ leaseTokenHash: string; leaseOwner: string }>>(Prisma.sql`
    INSERT INTO "LegacyOpenClawProjectMigrationLease" (
      "id",
      "leaseTokenHash",
      "leaseOwner",
      "phase",
      "leaseExpiresAt",
      "heartbeatAt",
      "createdAt",
      "updatedAt"
    ) VALUES (
      ${MIGRATION_LEASE_ID},
      ${claim.tokenHash},
      ${claim.owner},
      'DISCOVERING',
      clock_timestamp()::timestamp + (${MIGRATION_LEASE_DURATION_MS} * INTERVAL '1 millisecond'),
      clock_timestamp()::timestamp,
      clock_timestamp()::timestamp,
      clock_timestamp()::timestamp
    )
    ON CONFLICT ("id") DO UPDATE SET
      "leaseTokenHash" = EXCLUDED."leaseTokenHash",
      "leaseOwner" = EXCLUDED."leaseOwner",
      "phase" = 'DISCOVERING',
      "leaseExpiresAt" = clock_timestamp()::timestamp
        + (${MIGRATION_LEASE_DURATION_MS} * INTERVAL '1 millisecond'),
      "heartbeatAt" = clock_timestamp()::timestamp,
      "updatedAt" = clock_timestamp()::timestamp
    WHERE "LegacyOpenClawProjectMigrationLease"."leaseExpiresAt" <= clock_timestamp()::timestamp
    RETURNING "leaseTokenHash", "leaseOwner"
  `);
  return rows.length === 1
    && rows[0].leaseTokenHash === claim.tokenHash
    && rows[0].leaseOwner === claim.owner
    ? claim
    : null;
}

async function claimLegacyMigrationLease(): Promise<LegacyMigrationLeaseClaim | null> {
  const claim = {
    tokenHash: sha256(crypto.randomBytes(32).toString('base64url')),
    owner: `${sha256(os.hostname()).slice(0, 16)}:${process.pid}`,
  };
  return claimLegacyMigrationLeaseFromStore(
    prisma as unknown as LegacyMigrationLeaseStore,
    claim,
  );
}

async function renewLegacyMigrationLeaseFromStore(
  store: LegacyMigrationLeaseStore,
  claim: LegacyMigrationLeaseClaim,
  phase?: 'MIGRATING',
): Promise<boolean> {
  const phaseUpdate = phase
    ? Prisma.sql`, "phase" = ${phase}`
    : Prisma.empty;
  const rows = await store.$queryRaw<Array<{ leaseTokenHash: string; leaseOwner: string }>>(Prisma.sql`
    UPDATE "LegacyOpenClawProjectMigrationLease"
    SET
      "heartbeatAt" = GREATEST("heartbeatAt", clock_timestamp()::timestamp),
      "leaseExpiresAt" = GREATEST(
        "leaseExpiresAt",
        clock_timestamp()::timestamp + (${MIGRATION_LEASE_DURATION_MS} * INTERVAL '1 millisecond')
      ),
      "updatedAt" = GREATEST("updatedAt", clock_timestamp()::timestamp)
      ${phaseUpdate}
    WHERE "id" = ${MIGRATION_LEASE_ID}
      AND "leaseTokenHash" = ${claim.tokenHash}
      AND "leaseOwner" = ${claim.owner}
      AND "leaseExpiresAt" > clock_timestamp()::timestamp
    RETURNING "leaseTokenHash", "leaseOwner"
  `);
  return rows.length === 1
    && rows[0].leaseTokenHash === claim.tokenHash
    && rows[0].leaseOwner === claim.owner;
}

interface LegacyMigrationHeartbeatTimer {
  unref?(): void;
}

interface LegacyMigrationHeartbeatScheduler {
  set(callback: () => void, delayMs: number): LegacyMigrationHeartbeatTimer;
  clear(timer: LegacyMigrationHeartbeatTimer): void;
}

interface LegacyMigrationHeartbeatController {
  stop(): void;
}

function startSerializedLegacyMigrationLeaseHeartbeat(input: {
  renew(): Promise<boolean>;
  onLeaseLost(): void;
  intervalMs?: number;
  scheduler?: LegacyMigrationHeartbeatScheduler;
}): LegacyMigrationHeartbeatController {
  const scheduler = input.scheduler || {
    set: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clear: (timer: LegacyMigrationHeartbeatTimer) => clearTimeout(timer as NodeJS.Timeout),
  };
  const intervalMs = input.intervalMs ?? MIGRATION_LEASE_HEARTBEAT_MS;
  let timer: LegacyMigrationHeartbeatTimer | null = null;
  let stopped = false;
  let running = false;

  const schedule = () => {
    if (stopped) return;
    timer = scheduler.set(() => {
      timer = null;
      void run();
    }, intervalMs);
    timer.unref?.();
  };
  const run = async () => {
    if (stopped || running) return;
    running = true;
    let renewed = false;
    try {
      renewed = await input.renew();
    } catch {
      renewed = false;
    } finally {
      running = false;
    }
    if (!renewed) {
      stopped = true;
      input.onLeaseLost();
      return;
    }
    schedule();
  };

  schedule();
  return {
    stop: () => {
      stopped = true;
      if (timer) scheduler.clear(timer);
      timer = null;
    },
  };
}

async function revokeLegacyMigrationLeaseAfterFailure(
  store: LegacyMigrationLeaseMutationStore,
  claim: LegacyMigrationLeaseClaim,
  now: Date,
  revokedClaim: LegacyMigrationLeaseClaim,
): Promise<void> {
  await store.updateMany({
    where: {
      id: MIGRATION_LEASE_ID,
      leaseTokenHash: claim.tokenHash,
      leaseOwner: claim.owner,
    },
    data: {
      leaseTokenHash: revokedClaim.tokenHash,
      leaseOwner: revokedClaim.owner,
      leaseExpiresAt: now,
      heartbeatAt: now,
    },
  });
}

async function assertLegacyMigrationLease(claim: LegacyMigrationLeaseClaim): Promise<void> {
  const lease = await prisma.legacyOpenClawProjectMigrationLease.findUnique({
    where: { id: MIGRATION_LEASE_ID },
    select: { leaseTokenHash: true, leaseOwner: true, leaseExpiresAt: true },
  });
  if (
    !lease
    || lease.leaseTokenHash !== claim.tokenHash
    || lease.leaseOwner !== claim.owner
    || lease.leaseExpiresAt.getTime() <= Date.now()
  ) {
    fail('MIGRATION_LEASE_LOST', 'Legacy Project migration lost its single-writer lease');
  }
}

async function renewLegacyMigrationLeaseInTransaction(
  claim: LegacyMigrationLeaseClaim,
  transaction: LegacyOpenClawProjectRetirementTransaction,
): Promise<void> {
  const renewed = await renewLegacyMigrationLeaseFromStore(
    transaction as unknown as LegacyMigrationLeaseStore,
    claim,
  );
  if (!renewed) {
    fail('MIGRATION_LEASE_LOST', 'Legacy Project migration lost its lease at a database commit boundary');
  }
}

async function transitionLegacyProjectMigrationTargets(input: {
  claim: LegacyMigrationLeaseClaim;
  targets: readonly LegacyProjectMigrationTarget[];
  status: 'PENDING' | 'COMPLETE';
}): Promise<void> {
  const targets = [...new Map(input.targets.map((target) => [target.id, target])).values()];
  if (targets.length === 0) return;
  await prisma.$transaction(async (tx) => {
    for (const target of targets) {
      if (input.status === 'PENDING') {
        const activeState = await tx.projectChatState.findFirst({
          where: {
            projectIdentityId: target.id,
            activeTurnId: { not: null },
          },
          select: { id: true },
        });
        if (activeState) {
          fail('PROJECT_TURN_ACTIVE', 'Project Chat turn was active when legacy migration tried to close admission');
        }
        const detachedActiveTurn = await tx.projectChatTurn.findFirst({
          where: {
            projectIdentityId: target.id,
            OR: [
              { status: { in: ['RUNNING', 'ABORTING'] } },
              { activeProjectKey: target.id },
            ],
          },
          select: { id: true },
        });
        if (detachedActiveTurn) {
          fail('PROJECT_TURN_ACTIVE', 'A detached Project Chat turn remained active during migration admission');
        }
        const dispatchedTerminalTurns = await tx.projectChatTurn.findMany({
          where: {
            projectIdentityId: target.id,
            status: { in: ['COMPLETED', 'ERROR', 'ABORTED', 'EXPIRED'] },
            resultMetadata: {
              path: ['providerDispatchStage'],
              equals: 'DISPATCH_ACCEPTED',
            },
          },
          select: { resultMetadata: true },
          take: MAX_IMPORT_RECOVERY_PROOFS + 1,
        });
        if (dispatchedTerminalTurns.length > MAX_IMPORT_RECOVERY_PROOFS) {
          fail('PROJECT_TURN_LIMIT', 'Project Chat settlement inventory exceeded the migration safety limit');
        }
        if (dispatchedTerminalTurns.some((turn) => {
          const metadata: unknown = turn.resultMetadata;
          return !isRecord(metadata) || metadata.atomicSettlementVersion !== 2;
        })) {
          fail(
            'PROJECT_TURN_UNSETTLED',
            'A dispatched Project Chat turn lacked an atomic terminal settlement proof',
          );
        }
      }
      const updated = await tx.projectIdentity.updateMany({
        where: {
          id: target.id,
          workspaceOwnerId: target.actorUserId,
          generation: target.generation,
          lifecycleStatus: 'ACTIVE',
          ...(input.status === 'COMPLETE'
            ? { legacyOpenClawMigrationStatus: 'PENDING' }
            : {}),
        },
        data: { legacyOpenClawMigrationStatus: input.status },
      });
      if (updated.count !== 1) {
        fail('PROJECT_MIGRATION_STATE', 'Legacy Project migration target changed during status commit');
      }
    }
    const leaseRenewed = await renewLegacyMigrationLeaseFromStore(
      tx as unknown as LegacyMigrationLeaseStore,
      input.claim,
      'MIGRATING',
    );
    if (!leaseRenewed) {
      fail('MIGRATION_LEASE_LOST', 'Legacy Project migration lost its lease during status commit');
    }
  }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 15_000 });
}

export async function legacyOpenClawProjectMigrationIsActive(
  projectIdentityId?: string,
): Promise<boolean> {
  return (await legacyOpenClawProjectMigrationGateState(projectIdentityId)).active;
}

async function legacyOpenClawProjectMigrationGateState(
  projectIdentityId?: string,
): Promise<{ active: boolean; retryable: boolean }> {
  const [lease, identity] = await prisma.$transaction(async (transaction) => Promise.all([
    transaction.legacyOpenClawProjectMigrationLease.findUnique({
      where: { id: MIGRATION_LEASE_ID },
      select: { phase: true, leaseExpiresAt: true },
    }),
    projectIdentityId
      ? transaction.projectIdentity.findUnique({
          where: { id: projectIdentityId },
          select: { legacyOpenClawMigrationStatus: true },
        })
      : Promise.resolve(null),
  ]), { isolationLevel: 'RepeatableRead' });
  const active = legacyOpenClawProjectMigrationGateIsActive({
    projectIdentityId,
    migrationStatus: identity?.legacyOpenClawMigrationStatus || null,
    lease,
  });
  return {
    active,
    retryable: active && (
      identity?.legacyOpenClawMigrationStatus === 'PENDING'
      || Boolean(lease && lease.leaseExpiresAt.getTime() > Date.now())
    ),
  };
}

function legacyOpenClawProjectMigrationGateIsActive(input: {
  projectIdentityId?: string;
  migrationStatus: string | null;
  lease: { phase: string; leaseExpiresAt: Date } | null;
  nowMs?: number;
}): boolean {
  if (input.migrationStatus === 'PENDING') return true;
  if (!input.lease) return false;
  if (input.lease.phase === 'DISCOVERING') {
    // CURRENT is issued only by the server-owned create/clone/upload boundary.
    // It names a Portal 4 project instance that must never adopt name-keyed 3.x
    // state, so unrelated preserved evidence cannot make it a migration target.
    // Identity-less checks stay sticky for every destructive Project route.
    return !(input.projectIdentityId && input.migrationStatus === 'CURRENT');
  }
  if (!input.projectIdentityId) {
    return input.lease.leaseExpiresAt.getTime() > (input.nowMs ?? Date.now());
  }
  return false;
}

export async function legacyOpenClawProjectMigrationRetryDelayMs(): Promise<number> {
  const lease = await prisma.legacyOpenClawProjectMigrationLease.findUnique({
    where: { id: MIGRATION_LEASE_ID },
    select: { leaseExpiresAt: true },
  });
  if (!lease) return 1_000;
  return Math.max(1_000, Math.min(60_000, lease.leaseExpiresAt.getTime() - Date.now() + 250));
}

export class LegacyOpenClawProjectMigrationActiveError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(options: { retryable?: boolean } = {}) {
    const retryable = options.retryable !== false;
    super(retryable
      ? 'Legacy OpenClaw Project history is being reconciled; retry this operation shortly.'
      : LEGACY_OPENCLAW_RETIREMENT_PENDING_MESSAGE);
    this.name = 'LegacyOpenClawProjectMigrationActiveError';
    this.code = retryable
      ? 'LEGACY_OPENCLAW_PROJECT_MIGRATION_ACTIVE'
      : 'LEGACY_OPENCLAW_PROJECT_RETIREMENT_PENDING';
    this.retryable = retryable;
  }
}

export async function assertLegacyOpenClawProjectMigrationInactive(
  projectIdentityId?: string,
): Promise<void> {
  const state = await legacyOpenClawProjectMigrationGateState(projectIdentityId);
  if (state.active) {
    throw new LegacyOpenClawProjectMigrationActiveError({ retryable: state.retryable });
  }
}

/**
 * Acquires the cross-process DISCOVERING gate before returning. Callers may
 * defer `start()` until the real listener and persistent Gateway client exist;
 * no Project mutation can slip through that startup handoff.
 */
export async function beginLegacyOpenClawProjectMigration(): Promise<
  LegacyOpenClawProjectMigrationCoordinator | null
> {
  const claim = await claimLegacyMigrationLease();
  if (!claim) return null;
  let leaseLost = false;
  const heartbeat = startSerializedLegacyMigrationLeaseHeartbeat({
    renew: () => renewLegacyMigrationLeaseFromStore(
      prisma as unknown as LegacyMigrationLeaseStore,
      claim,
    ),
    onLeaseLost: () => {
      leaseLost = true;
    },
  });

  const execute = async (): Promise<LegacyOpenClawProjectRetirementResult> => {
    let completed = false;
    try {
      const result = await retireLegacyOpenClawProjectAgentsAtStartup({
        dependencies: {
          assertMutationLease: async () => {
            if (leaseLost) fail('MIGRATION_LEASE_LOST', 'Legacy Project migration lease heartbeat failed');
            await assertLegacyMigrationLease(claim);
          },
          assertMutationLeaseInTransaction: async (transaction) => {
            if (leaseLost) fail('MIGRATION_LEASE_LOST', 'Legacy Project migration lease heartbeat failed');
            await renewLegacyMigrationLeaseInTransaction(claim, transaction);
          },
          markAffectedProjectIdentities: async (targets) => {
            if (leaseLost) fail('MIGRATION_LEASE_LOST', 'Legacy Project migration lease heartbeat failed');
            await transitionLegacyProjectMigrationTargets({ claim, targets, status: 'PENDING' });
          },
          markCompletedProjectIdentities: async (targets) => {
            if (leaseLost) fail('MIGRATION_LEASE_LOST', 'Legacy Project migration lease heartbeat failed');
            await transitionLegacyProjectMigrationTargets({ claim, targets, status: 'COMPLETE' });
          },
        },
      });
      completed = true;
      return result;
    } finally {
      heartbeat.stop();
      if (completed) {
        await prisma.legacyOpenClawProjectMigrationLease.deleteMany({
          where: {
            id: MIGRATION_LEASE_ID,
            leaseTokenHash: claim.tokenHash,
            leaseOwner: claim.owner,
          },
        });
      } else {
        // Preserve DISCOVERING as a durable global OpenClaw gate when failure
        // happened before affected identities could be proven. Revoke both
        // ownership fields while expiring the row: stopping the scheduler
        // cannot cancel a heartbeat query already in flight, and retaining the old token
        // would let that stale query extend the released lease afterward.
        const now = new Date();
        await revokeLegacyMigrationLeaseAfterFailure(
          prisma.legacyOpenClawProjectMigrationLease as unknown as LegacyMigrationLeaseMutationStore,
          claim,
          now,
          {
            tokenHash: sha256(crypto.randomBytes(32).toString('base64url')),
            owner: `released:${sha256(crypto.randomBytes(32).toString('base64url')).slice(0, 16)}`,
          },
        ).catch(() => undefined);
      }
    }
  };
  let started = false;
  let resolveCompletion!: (value: LegacyOpenClawProjectRetirementResult) => void;
  let rejectCompletion!: (reason: unknown) => void;
  const completion = new Promise<LegacyOpenClawProjectRetirementResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const start = () => {
    if (started) return;
    started = true;
    void execute().then(resolveCompletion, rejectCompletion);
  };
  return { completion, start };
}

function candidateSignature(candidate: LegacyAgentCandidate): string {
  return JSON.stringify(candidate);
}

function candidateMap(candidates: LegacyAgentCandidate[]): Map<string, LegacyAgentCandidate> {
  return new Map(candidates.map((candidate) => [candidate.agentId, candidate]));
}

function assertConfigSnapshotsMatch(
  local: LegacyAgentCandidate[],
  gateway: LegacyAgentCandidate[],
): void {
  const localMap = candidateMap(local);
  const gatewayMap = candidateMap(gateway);
  if (localMap.size !== gatewayMap.size) {
    fail('CONFIG_RACE', 'Local and Gateway legacy agent snapshots did not match');
  }
  for (const [agentId, candidate] of localMap) {
    const remote = gatewayMap.get(agentId);
    if (!remote || candidateSignature(candidate) !== candidateSignature(remote)) {
      fail('CONFIG_RACE', `Legacy Project agent ${agentId} changed during discovery`);
    }
  }
}

async function boundedRpc(
  dependencies: LegacyOpenClawProjectRetirementDependencies,
  budget: OperationBudget,
  method: string,
  params: Record<string, any>,
  timeoutMs: number,
): Promise<RpcResponse> {
  budget.rpcCalls += 1;
  if (budget.rpcCalls > MAX_RPC_CALLS) fail('RPC_LIMIT', 'Legacy retirement exceeded its RPC call budget');
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      dependencies.rpc(method, params, timeoutMs),
      new Promise<RpcResponse>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${method} exceeded ${timeoutMs}ms`)), timeoutMs + 250);
        timer.unref();
      }),
    ]);
  } catch {
    throw new LegacyOpenClawProjectRetirementError(
      'RPC_FAILURE',
      `OpenClaw ${method} failed during bounded legacy inspection`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function dockerCall(
  dependencies: LegacyOpenClawProjectRetirementDependencies,
  budget: OperationBudget,
  args: readonly string[],
): Promise<LegacyRetirementCommandResult> {
  budget.dockerCalls += 1;
  if (budget.dockerCalls > MAX_DOCKER_CALLS) fail('DOCKER_LIMIT', 'Legacy retirement exceeded its Docker call budget');
  try {
    return await dependencies.docker(args, DOCKER_TIMEOUT_MS);
  } catch {
    fail('DOCKER_FAILURE', 'Legacy retirement Docker operation failed during bounded inspection');
  }
}

function parseConfigRpc(response: RpcResponse): Record<string, any> {
  if (!response.ok) fail('CONFIG_RPC', 'OpenClaw config.get failed during legacy inspection');
  const config = response.data?.config || response.data?.parsed;
  if (!isRecord(config)) fail('CONFIG_RPC', 'OpenClaw config.get returned an invalid config snapshot');
  return config;
}

function dockerNotFound(result: LegacyRetirementCommandResult): boolean {
  return result.exitCode === 1 && /no such (?:object|container)/i.test(result.stderr);
}

function parseInspectOutput(stdout: string): DockerContainerInspect {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail('DOCKER_INSPECT', 'Docker container inspection was not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    fail('DOCKER_INSPECT', 'Docker container inspection was ambiguous');
  }
  return parsed[0] as DockerContainerInspect;
}

async function inspectContainer(
  dependencies: LegacyOpenClawProjectRetirementDependencies,
  budget: OperationBudget,
  containerId: string,
): Promise<DockerContainerInspect | null> {
  const result = await dockerCall(dependencies, budget, ['container', 'inspect', containerId]);
  if (result.exitCode === 0) return parseInspectOutput(result.stdout);
  if (dockerNotFound(result)) return null;
  fail('DOCKER_INSPECT', `Docker could not authoritatively inspect container ${containerId}`);
}

async function discoverLegacyContainers(
  dependencies: LegacyOpenClawProjectRetirementDependencies,
  budget: OperationBudget,
  roots: RetirementRoots,
): Promise<LegacyContainerCandidate[]> {
  const listed = await dockerCall(dependencies, budget, [
    'container', 'ls', '--all', '--no-trunc',
    '--format', '{{.ID}}',
  ]);
  if (listed.exitCode !== 0) fail('DOCKER_LIST', 'Docker sandbox container discovery failed');
  const ids = listed.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (ids.length > MAX_SANDBOX_CONTAINERS) {
    fail('CONTAINER_LIMIT', 'OpenClaw sandbox container count exceeded the retirement safety limit');
  }
  if (new Set(ids).size !== ids.length || ids.some((id) => !/^[a-f0-9]{64}$/i.test(id))) {
    fail('DOCKER_LIST', 'Docker sandbox discovery returned an invalid container identity');
  }

  const candidates: LegacyContainerCandidate[] = [];
  for (const id of ids) {
    const inspect = await inspectContainer(dependencies, budget, id.toLowerCase());
    if (!inspect || String(inspect.Id || '').toLowerCase() !== id.toLowerCase()) {
      fail('DOCKER_RACE', `OpenClaw sandbox container ${id} changed during discovery`);
    }
    const candidate = attestLegacyContainer(inspect, roots);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function isExactLegacySessionRegistrationKey(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 512) return false;
  if (parseLegacySessionKey(value)) return true;
  const sharedPrefix = 'agent:portal:portal-';
  if (!value.startsWith(sharedPrefix)) return false;
  const remainder = value.slice(sharedPrefix.length);
  const actorUserId = remainder.slice(0, 36);
  if (!USER_ID_PATTERN.test(actorUserId) || remainder[36] !== '-') return false;
  const stableSlug = remainder.slice(37);
  return /^[a-z0-9][a-z0-9_-]{0,95}$/.test(stableSlug);
}

async function listGlobalLegacySessionRegistrations(
  dependencies: LegacyOpenClawProjectRetirementDependencies,
  budget: OperationBudget,
): Promise<readonly string[]> {
  const found = new Set<string>();
  let totalRowsSeen = 0;
  for (const archived of [false, true]) {
    let offset = 0;
    let pages = 0;
    while (true) {
      pages += 1;
      if (pages > Math.ceil(MAX_GLOBAL_SESSION_REGISTRATIONS / SESSION_PAGE_SIZE) + 1) {
        fail('SESSION_PAGINATION', 'Global OpenClaw session inventory exceeded bounded pagination');
      }
      const response = await boundedRpc(dependencies, budget, 'sessions.list', {
        archived,
        includeGlobal: true,
        includeUnknown: true,
        configuredAgentsOnly: false,
        limit: SESSION_PAGE_SIZE,
        offset,
      }, CONFIG_RPC_TIMEOUT_MS);
      if (!response.ok || !Array.isArray(response.data?.sessions)) {
        fail('SESSION_LIST', 'Global OpenClaw session inventory could not be inspected');
      }
      const rows = response.data.sessions;
      totalRowsSeen += rows.length;
      if (totalRowsSeen > MAX_GLOBAL_SESSION_REGISTRATIONS) {
        fail('SESSION_LIMIT', 'Global OpenClaw session inventory exceeded its safety limit');
      }
      for (const row of rows) {
        if (!isRecord(row) || typeof row.key !== 'string') {
          fail('SESSION_SHAPE', 'Global OpenClaw session inventory returned an invalid row');
        }
        if (isExactLegacySessionRegistrationKey(row.key)) found.add(row.key);
      }
      if (response.data.hasMore !== true) break;
      const nextOffset = response.data.nextOffset;
      if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) {
        fail('SESSION_PAGINATION', 'Global OpenClaw session inventory returned invalid pagination');
      }
      offset = nextOffset;
    }
  }
  return Object.freeze([...found].sort());
}

function sessionFromRow(
  agentId: string,
  row: Record<string, any>,
  archived: boolean,
): LegacySessionCandidate | null {
  if (typeof row.key !== 'string') fail('SESSION_SHAPE', 'OpenClaw sessions.list returned a row without a key');
  if (!row.key.startsWith(`agent:${agentId}:`)) return null;
  const parsed = parseLegacySessionKey(row.key);
  if (!parsed || parsed.agentId !== agentId) {
    fail('SESSION_IDENTITY', `OpenClaw session for ${agentId} had an ambiguous identity`);
  }
  const candidate: LegacySessionCandidate = { agentId, key: row.key, archived };
  if (typeof row.sessionId === 'string' && row.sessionId.trim()) candidate.sessionId = row.sessionId.trim();
  if (typeof row.lifecycleRevision === 'string' && row.lifecycleRevision.trim()) {
    candidate.lifecycleRevision = row.lifecycleRevision.trim();
  }
  if (Number.isSafeInteger(row.updatedAt) && row.updatedAt >= 0) candidate.updatedAt = row.updatedAt;
  return candidate;
}

async function listLegacySessionsForAgent(
  dependencies: LegacyOpenClawProjectRetirementDependencies,
  budget: OperationBudget,
  agentId: string,
): Promise<LegacySessionCandidate[]> {
  if (!parseLegacyAgentId(agentId)) fail('SESSION_IDENTITY', 'Refusing to inspect sessions for an unsafe agent id');
  const found = new Map<string, LegacySessionCandidate>();
  let totalRowsSeen = 0;
  for (const archived of [false, true]) {
    let offset = 0;
    let pages = 0;
    while (true) {
      pages += 1;
      if (pages > Math.ceil(MAX_SESSION_ROWS_PER_AGENT / SESSION_PAGE_SIZE) + 1) {
        fail('SESSION_PAGINATION', `OpenClaw sessions for ${agentId} exceeded bounded pagination`);
      }
      const response = await boundedRpc(dependencies, budget, 'sessions.list', {
        agentId,
        archived,
        includeGlobal: false,
        includeUnknown: true,
        limit: SESSION_PAGE_SIZE,
        offset,
      }, CONFIG_RPC_TIMEOUT_MS);
      if (!response.ok || !Array.isArray(response.data?.sessions)) {
        fail('SESSION_LIST', `OpenClaw sessions for ${agentId} could not be inspected`);
      }
      const rows = response.data.sessions;
      totalRowsSeen += rows.length;
      if (totalRowsSeen > MAX_SESSION_ROWS_PER_AGENT) {
        fail('SESSION_LIMIT', `OpenClaw sessions for ${agentId} exceeded the retirement safety limit`);
      }
      for (const row of rows) {
        if (!isRecord(row)) fail('SESSION_SHAPE', 'OpenClaw sessions.list returned an invalid row');
        const candidate = sessionFromRow(agentId, row, archived);
        if (!candidate) continue;
        if (found.has(candidate.key)) fail('SESSION_DUPLICATE', `OpenClaw session ${candidate.key} was duplicated`);
        found.set(candidate.key, candidate);
      }
      if (response.data.hasMore !== true) break;
      const nextOffset = response.data.nextOffset;
      if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) {
        fail('SESSION_PAGINATION', `OpenClaw sessions for ${agentId} returned invalid pagination`);
      }
      offset = nextOffset;
    }
  }
  return [...found.values()];
}

async function listLegacySessions(
  dependencies: LegacyOpenClawProjectRetirementDependencies,
  budget: OperationBudget,
  agentIds: Iterable<string>,
): Promise<LegacySessionCandidate[]> {
  const sessions: LegacySessionCandidate[] = [];
  for (const agentId of [...new Set(agentIds)].sort()) {
    sessions.push(...await listLegacySessionsForAgent(dependencies, budget, agentId));
  }
  return sessions;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function legacyProofCandidateIsAttested(proof: LegacyImportJournalRow): boolean {
  const candidate = parseLegacyAgentId(proof.candidateAgentId);
  return Boolean(
    candidate
    && candidate.userPrefix === proof.actorUserId.slice(0, 8)
    && proof.candidateAgentHash === sha256(proof.candidateAgentId)
    && [proof.candidateAgentId, 'portal'].includes(proof.sourceAgentId),
  );
}

function normalizedMessageText(value: string): string {
  return String(value || '').replace(/\r\n?/g, '\n').normalize('NFC');
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map(normalizedMessageText)));
}

function exactLegacyProjectPrompt(text: string, firstUserMessage: boolean, projectNames: readonly string[]): {
  display: string;
  databaseMatches: readonly string[];
} {
  const normalized = normalizedMessageText(text);
  let matches = [normalized];
  let display = normalized;
  if (firstUserMessage && normalized.startsWith(LEGACY_PROJECT_CONTEXT_PREFIX)) {
    const boundary = normalized.indexOf(LEGACY_PROJECT_CONTEXT_END, LEGACY_PROJECT_CONTEXT_PREFIX.length);
    if (boundary < 0) fail('HISTORY_CONTEXT', 'Legacy Project context envelope was incomplete');
    if (normalized.indexOf(LEGACY_PROJECT_CONTEXT_END, boundary + LEGACY_PROJECT_CONTEXT_END.length) >= 0) {
      fail('HISTORY_CONTEXT', 'Legacy Project context envelope was ambiguous');
    }
    const envelope = normalized.slice(LEGACY_PROJECT_CONTEXT_PREFIX.length, boundary);
    const lines = envelope.split('\n');
    const assistantPrefix = 'You are ';
    const matchedProjectName = projectNames.find((projectName) => (
      lines[0]?.startsWith(assistantPrefix)
      && lines[0].endsWith(`, an AI coding assistant working on the project "${projectName}".`)
    ));
    const assistantSuffix = matchedProjectName
      ? `, an AI coding assistant working on the project "${matchedProjectName}".`
      : '';
    const assistantName = assistantSuffix
      ? lines[0].slice(assistantPrefix.length, -assistantSuffix.length)
      : '';
    const projectType = lines[1]?.startsWith('Project Type: ')
      ? lines[1].slice('Project Type: '.length)
      : '';
    const allowedProjectTypes = new Set([
      'React', 'Vue', 'Next.js', 'Svelte', 'Node.js', 'Python', 'Rust', 'Go', 'Static HTML', 'Unknown',
    ]);
    const dedicatedDirectory = '/workspace/project/';
    const sharedDirectory = matchedProjectName ? `/home/user/projects/${matchedProjectName}/` : '';
    const directory = lines[2]?.startsWith('Project Directory (inside sandbox): ')
      ? lines[2].slice('Project Directory (inside sandbox): '.length)
      : '';
    const fileOperations = directory === dedicatedDirectory
      ? `**Project File Operations:**\n- Use exec tool for project file reads and writes. Start from /workspace/project or set workdir to /workspace/project before editing.\n- Use shell commands like cat, sed, python, node, perl, tee, or here-docs to inspect and modify files.\n- Never write project files into /workspace root by accident.\n- All real project paths should be under ${dedicatedDirectory}`
      : directory === sharedDirectory
        ? `**File Operations:**\n- Use Read tool with file_path to read files. For large files (>1MB), use offset (line number) and limit (max lines) to read in chunks.\n- Use Write tool to create/overwrite files.\n- Use Edit tool for surgical find-and-replace edits.\n- All paths should be absolute: ${sharedDirectory}filename.ext`
        : '';
    const commandDirectory = directory === dedicatedDirectory
      ? 'Your default shell starts in /workspace, so cd /workspace/project first or set workdir to /workspace/project.'
      : directory === sharedDirectory
        ? `Set workdir to ${sharedDirectory} or cd there first`
        : '';
    const expectedEnvelope = assistantName && assistantName.length <= 128
      && !/[\u0000-\u001f\u007f]/.test(assistantName)
      && allowedProjectTypes.has(projectType)
      && fileOperations
      && commandDirectory
      ? `${lines[0]}\nProject Type: ${projectType}\nProject Directory (inside sandbox): ${directory}\n\n**CRITICAL: You are sandboxed to this project directory.**\n\n${fileOperations}\n\n**Commands:**\n- Use exec tool to run shell commands (git, npm, node, ls, grep, find, etc.)\n- ${commandDirectory}\n- Examples: exec git status, exec npm install, exec ls -la\n\n**Internet:**\n- Use web_search for research\n- Use web_fetch to download documentation or resources\n\n**Project Memory:**\n- Read .agent-memory.md to learn project context\n- Update .agent-memory.md when you learn important patterns or decisions\n\n**Security:** Do not try to access files outside ${directory} - the sandbox prevents this anyway.\n`
      : '';
    if (!expectedEnvelope || envelope !== expectedEnvelope) {
      fail(
        'HISTORY_CONTEXT',
        `Legacy Project context envelope did not match the Portal 3.x template (${envelope.length}/${expectedEnvelope.length}; ${sha256(envelope).slice(0, 12)}/${sha256(expectedEnvelope).slice(0, 12)})`,
      );
    }
    const originalPrompt = normalized.slice(boundary + LEGACY_PROJECT_CONTEXT_END.length);
    if (!originalPrompt) fail('HISTORY_CONTEXT', 'Legacy Project context envelope had no user prompt');
    // Never treat a SQL copy of the private Portal context envelope as visible
    // content. Only the exact user payload following that envelope is eligible.
    matches = [originalPrompt];
    display = originalPrompt;
  } else if (normalized.startsWith(LEGACY_MODEL_SWITCH_PREFIX)) {
    const modelBoundary = normalized.indexOf(']\n\n', LEGACY_MODEL_SWITCH_PREFIX.length);
    const model = modelBoundary < 0
      ? ''
      : normalized.slice(LEGACY_MODEL_SWITCH_PREFIX.length, modelBoundary);
    if (model && model.length <= 256 && !/[\r\n\]]/.test(model)) {
      const originalPrompt = normalized.slice(modelBoundary + 3);
      if (originalPrompt) {
        matches.push(originalPrompt);
        // Unlike the first-turn envelope, a literal user prompt can begin with
        // this text. Keep the Gateway projection unless an exact SQL match later
        // proves the original pre-transport prompt.
      }
    }
  }
  return { display, databaseMatches: uniqueStrings(matches) };
}

function displayTextFromHistoryMessage(message: Record<string, any>): string {
  if (typeof message.content === 'string') return normalizedMessageText(message.content);
  if (!Array.isArray(message.content)) return '';
  const text: string[] = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'text') continue;
    if (typeof block.text !== 'string') fail('HISTORY_CONTENT', 'OpenClaw text block was not a string');
    text.push(block.text);
  }
  return normalizedMessageText(text.join('\n'));
}

function historyTimestamp(value: unknown): Date {
  const milliseconds = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Date.parse(value)
      : Number.NaN;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    fail('HISTORY_TIMESTAMP', 'OpenClaw history message had no stable timestamp');
  }
  const result = new Date(milliseconds);
  if (Number.isNaN(result.getTime())) fail('HISTORY_TIMESTAMP', 'OpenClaw history timestamp was invalid');
  return result;
}

function descriptionFingerprint(session: LegacySessionCandidate): string {
  return sha256(JSON.stringify({
    agentId: session.agentId,
    key: session.key,
    sessionId: session.sessionId || null,
    lifecycleRevision: session.lifecycleRevision || null,
    updatedAt: session.updatedAt ?? null,
    archived: session.archived ?? null,
  }));
}

function describedSessionFromResponse(
  response: RpcResponse,
  expectedAgentId: string,
  expectedKey: string,
): LegacySessionCandidate | null {
  if (!response.ok) {
    if (isNotFoundError(response.error)) return null;
    fail('SESSION_DESCRIBE', 'OpenClaw could not describe an exact legacy session');
  }
  if (
    isRecord(response.data)
    && Object.prototype.hasOwnProperty.call(response.data, 'session')
    && response.data.session === null
  ) return null;
  const row = isRecord(response.data) && Object.prototype.hasOwnProperty.call(response.data, 'session')
    ? response.data.session
    : response.data;
  if (!isRecord(row)) fail('SESSION_DESCRIBE', 'OpenClaw sessions.describe returned an invalid row');
  const key = typeof row.key === 'string' ? row.key.trim() : '';
  if (!key || key !== expectedKey) {
    fail('SESSION_DESCRIBE', 'OpenClaw did not attest the exact legacy session key');
  }
  const session: LegacySessionCandidate = { agentId: expectedAgentId, key };
  if (typeof row.sessionId === 'string' && row.sessionId.trim()) session.sessionId = row.sessionId.trim();
  if (!session.sessionId || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(session.sessionId)) {
    fail('SESSION_DESCRIBE', 'OpenClaw legacy session had no valid immutable session id');
  }
  if (typeof row.lifecycleRevision === 'string' && row.lifecycleRevision.trim()) {
    session.lifecycleRevision = row.lifecycleRevision.trim();
  }
  if (Number.isSafeInteger(row.updatedAt) && row.updatedAt >= 0) session.updatedAt = row.updatedAt;
  if (session.updatedAt === undefined) {
    fail('SESSION_DESCRIBE', 'OpenClaw legacy session had no update CAS value');
  }
  if (typeof row.archived === 'boolean') session.archived = row.archived;
  return session;
}

async function describeExactLegacySession(
  dependencies: LegacyOpenClawProjectRetirementDependencies,
  budget: OperationBudget,
  expectedAgentId: string,
  expectedKey: string,
): Promise<LegacySessionCandidate | null> {
  const response = await boundedRpc(
    dependencies,
    budget,
    'sessions.describe',
    { key: expectedKey },
    CONFIG_RPC_TIMEOUT_MS,
  );
  return describedSessionFromResponse(response, expectedAgentId, expectedKey);
}

function assertHistoryPageMessageIdentity(message: Record<string, any>): {
  sourceId: string;
  sourceSeq: number;
} {
  const metadata = isRecord(message.__openclaw) ? message.__openclaw : null;
  const sourceId = typeof metadata?.id === 'string' ? metadata.id.trim() : '';
  const sourceSeq = metadata?.seq;
  if (!sourceId || sourceId.length > 512 || /[\u0000-\u001f\u007f]/.test(sourceId)) {
    fail('HISTORY_SOURCE_ID', 'OpenClaw history message had no safe source event id');
  }
  if (!Number.isSafeInteger(sourceSeq) || sourceSeq <= 0) {
    fail('HISTORY_SOURCE_SEQ', 'OpenClaw history message had no stable source sequence');
  }
  return { sourceId, sourceSeq };
}

function deterministicLegacyMessageId(input: {
  actorUserId: string;
  projectIdentityId: string;
  projectGeneration: number;
  agentId: string;
  sessionKey: string;
  providerSessionId: string;
  sourceId: string;
  sourceSeq: number;
  projectionIndex: number;
}): string {
  return `${LEGACY_IMPORT_MESSAGE_PREFIX}${sha256(JSON.stringify([
    'v1',
    input.actorUserId,
    input.projectIdentityId,
    input.projectGeneration,
    input.agentId,
    input.sessionKey,
    input.providerSessionId,
    input.sourceId,
    input.sourceSeq,
    input.projectionIndex,
  ]))}`;
}

function legacySourceSortKey(input: {
  timestamp: Date;
  sourceRank: string;
  sourceSeq: number;
  projectionIndex: number;
}): string {
  return [
    input.timestamp.getTime().toString().padStart(16, '0'),
    input.sourceRank,
    input.sourceSeq.toString().padStart(16, '0'),
    input.projectionIndex.toString().padStart(4, '0'),
  ].join(':');
}

function legacyImportedProjectionDigest(rows: readonly LegacyProjectMessageRow[]): string {
  const ordered = [...rows].sort((left, right) => (
    (left.sourceOrdinal ?? -1) - (right.sourceOrdinal ?? -1)
    || String(left.messageId || '').localeCompare(String(right.messageId || ''))
  ));
  const ordinals = new Set<number>();
  const projection = ordered.map((row, index) => {
    const ordinal = row.sourceOrdinal;
    if (
      row.legacyImportStatus !== LEGACY_IMPORT_IMPORTED
      || !row.messageId?.startsWith(LEGACY_IMPORT_MESSAGE_PREFIX)
      || !['user', 'assistant'].includes(row.role)
      || !(row.timestamp instanceof Date)
      || !Number.isSafeInteger(ordinal)
      || ordinal !== index
      || ordinals.has(ordinal as number)
      || typeof row.sourceKeyHash !== 'string'
      || typeof row.sourceEventId !== 'string'
      || !Number.isSafeInteger(row.sourceEventSeq)
      || !Number.isSafeInteger(row.sourceProjectionIndex)
      || typeof row.sourceFingerprint !== 'string'
      || typeof row.sourceSortKey !== 'string'
    ) {
      fail('MESSAGE_COLLISION', 'Imported legacy projection contained malformed provenance');
    }
    ordinals.add(ordinal as number);
    return [
      row.userId,
      row.projectId,
      row.messageId,
      row.sessionKey,
      row.role,
      sha256(row.content),
      row.timestamp.toISOString(),
      row.provider,
      row.runtime,
      row.model || null,
      row.providerSessionId || null,
      row.turnId || null,
      row.presentation ?? null,
      ordinal,
      row.sourceKeyHash,
      row.sourceEventId,
      row.sourceEventSeq,
      row.sourceProjectionIndex,
      row.sourceFingerprint,
      row.sourceSortKey,
      row.legacyImportStatus,
    ];
  });
  return sha256(JSON.stringify(projection));
}

function assertProjectionRowsMatchProof(
  rows: readonly LegacyProjectMessageRow[],
  proof: LegacyImportJournalRow,
): void {
  if (rows.length !== proof.importedMessages) {
    fail('IMPORT_PROOF', 'Legacy source no longer had its exact imported message projection');
  }
  for (const row of rows) {
    if (
      row.userId !== proof.actorUserId
      || row.projectId !== proof.projectIdentityId
      || row.sessionKey !== proof.sourceSessionKey
      || row.sourceKeyHash !== proof.sessionKeyHash
      || !row.messageId?.startsWith(LEGACY_IMPORT_MESSAGE_PREFIX)
      || row.provider !== 'OPENCLAW'
      || row.runtime !== LEGACY_IMPORT_RUNTIME
      || (row.providerSessionId || '') !== proof.providerSessionId
      || row.turnId != null
      || row.presentation != null
      || !Number.isSafeInteger(row.sourceEventSeq)
      || !Number.isSafeInteger(row.sourceProjectionIndex)
      || typeof row.sourceEventId !== 'string'
      || row.messageId !== deterministicLegacyMessageId({
        actorUserId: proof.actorUserId,
        projectIdentityId: proof.projectIdentityId,
        projectGeneration: proof.projectGeneration,
        agentId: proof.sourceAgentId,
        sessionKey: proof.sourceSessionKey,
        providerSessionId: proof.providerSessionId,
        sourceId: row.sourceEventId || '',
        sourceSeq: row.sourceEventSeq || 0,
        projectionIndex: row.sourceProjectionIndex || 0,
      })
      || row.sourceSortKey !== legacySourceSortKey({
        timestamp: row.timestamp,
        sourceRank: proof.sessionKeyHash,
        sourceSeq: row.sourceEventSeq || 0,
        projectionIndex: row.sourceProjectionIndex || 0,
      })
    ) {
      fail('MESSAGE_COLLISION', 'Imported legacy source projection no longer matched its deterministic proof');
    }
  }
  if (legacyImportedProjectionDigest(rows) !== proof.projectionDigest) {
    fail('MESSAGE_COLLISION', 'Imported legacy source projection no longer matched its committed digest');
  }
}

async function assertCommittedProjection(
  database: LegacyOpenClawProjectRetirementTransaction,
  proof: LegacyImportJournalRow,
): Promise<void> {
  const rows = await database.projectChatMessage.findMany({
    where: {
      userId: proof.actorUserId,
      projectId: proof.projectIdentityId,
      sessionKey: proof.sourceSessionKey,
      sourceKeyHash: proof.sessionKeyHash,
      legacyImportStatus: LEGACY_IMPORT_IMPORTED,
    },
    orderBy: [{ sourceOrdinal: 'asc' }, { id: 'asc' }],
    take: proof.importedMessages + 1,
  });
  assertProjectionRowsMatchProof(rows, proof);
}

async function assertClearedProjectionAbsent(
  database: LegacyOpenClawProjectRetirementTransaction,
  proof: LegacyImportJournalRow,
): Promise<void> {
  const rows = await database.projectChatMessage.findMany({
    where: {
      userId: proof.actorUserId,
      projectId: proof.projectIdentityId,
      sessionKey: proof.sourceSessionKey,
      sourceKeyHash: proof.sessionKeyHash,
      legacyImportStatus: LEGACY_IMPORT_IMPORTED,
    },
    select: { id: true },
    take: 1,
  });
  if (rows.length > 0) {
    fail('IMPORT_PROOF', 'Cleared legacy source unexpectedly retained a visible imported projection');
  }
}

async function readCanonicalHistoryOnce(input: {
  source: LegacyProjectSessionSource;
  described: LegacySessionCandidate;
  dependencies: LegacyOpenClawProjectRetirementDependencies;
  budget: OperationBudget;
}): Promise<LegacyCanonicalHistory> {
  const { source, described, dependencies, budget } = input;
  const providerSessionId = described.sessionId || '';
  if (!providerSessionId) fail('SESSION_DESCRIBE', 'Legacy session identity disappeared before history read');
  const pages: Record<string, any>[][] = [];
  const offset = 0;
  let expectedTotal: number | null = null;
  let serializedBytes = 0;
  let pageCount = 0;
  const visitedOffsets = new Set<number>();
  while (true) {
    if (visitedOffsets.has(offset)) fail('HISTORY_PAGINATION', 'OpenClaw history offset repeated');
    visitedOffsets.add(offset);
    pageCount += 1;
    if (pageCount > Math.ceil(MAX_HISTORY_ROWS_PER_SESSION / HISTORY_PAGE_SIZE) + 2) {
      fail('HISTORY_PAGINATION', 'Legacy history exceeded bounded pagination');
    }
    const response = await boundedRpc(dependencies, budget, 'chat.history', {
      sessionKey: described.key,
      agentId: described.agentId,
      limit: HISTORY_PAGE_SIZE,
      offset,
      maxChars: HISTORY_MAX_CHARS,
    }, CONFIG_RPC_TIMEOUT_MS);
    if (!response.ok || !Array.isArray(response.data?.messages)) {
      fail('HISTORY_READ', 'OpenClaw legacy history could not be read completely');
    }
    if (response.data.sessionKey !== described.key) {
      fail('HISTORY_SESSION', 'OpenClaw history returned a different session key');
    }
    if (typeof response.data.sessionId !== 'string' || response.data.sessionId !== providerSessionId) {
      fail('HISTORY_SESSION', 'OpenClaw history session identity changed');
    }
    if (response.data.offset !== offset) fail('HISTORY_PAGINATION', 'OpenClaw history offset changed');
    if (typeof response.data.hasMore !== 'boolean') {
      fail('HISTORY_PAGINATION', 'OpenClaw history omitted its pagination completion flag');
    }
    if (response.data.messages.length > HISTORY_PAGE_SIZE) {
      fail('HISTORY_PAGINATION', 'OpenClaw history exceeded the requested page size');
    }
    if (
      response.data.truncated === true
      || response.data.omitted === true
      || response.data.metadata?.truncated === true
    ) {
      fail('HISTORY_OMITTED', 'OpenClaw history reported a truncated response');
    }
    const total = response.data.totalMessages;
    if (!Number.isSafeInteger(total) || total < 0 || total > MAX_HISTORY_ROWS_PER_SESSION) {
      fail('HISTORY_LIMIT', 'OpenClaw history total exceeded the import safety limit');
    }
    if (total > HISTORY_PAGE_SIZE) {
      fail('HISTORY_API_LIMIT', 'OpenClaw history exceeded the non-composable complete-page limit');
    }
    if (expectedTotal === null) expectedTotal = total;
    if (expectedTotal !== total) fail('HISTORY_UNSTABLE', 'OpenClaw history total changed during pagination');
    if (offset !== 0 || response.data.messages.length !== total) {
      fail('HISTORY_OMITTED', 'OpenClaw history did not return its complete declared projection');
    }
    const page: Record<string, any>[] = [];
    for (const raw of response.data.messages) {
      if (!isRecord(raw)) fail('HISTORY_SHAPE', 'OpenClaw history contained a malformed message');
      const serialized = JSON.stringify(raw);
      const bytes = Buffer.byteLength(serialized, 'utf8');
      if (bytes > MAX_HISTORY_MESSAGE_BYTES) fail('HISTORY_MESSAGE_LIMIT', 'OpenClaw history message exceeded the import limit');
      if (HISTORY_OMISSION_MARKERS.some((marker) => serialized.includes(marker))) {
        fail('HISTORY_OMITTED', 'OpenClaw history contained an omission marker');
      }
      if (raw.__openclaw?.truncated === true) {
        fail('HISTORY_OMITTED', 'OpenClaw history contained a truncated source event');
      }
      assertHistoryPageMessageIdentity(raw);
      serializedBytes += bytes;
      if (serializedBytes > MAX_HISTORY_BYTES_PER_SESSION) {
        fail('HISTORY_BYTES', 'OpenClaw history exceeded the per-session byte limit');
      }
      page.push(raw);
    }
    pages.unshift(page);
    const hasMore = response.data.hasMore;
    if (hasMore) {
      fail('HISTORY_OMITTED', 'OpenClaw could not return the canonical transcript as one complete projection');
    }
    if (response.data.nextOffset !== undefined) {
      fail('HISTORY_PAGINATION', 'OpenClaw history returned a continuation offset after exhaustion');
    }
    break;
  }

  const rawMessages = pages.flat();
  const sourceIds = new Set<string>();
  const sourceSeqs = new Set<number>();
  const digestRows: unknown[] = [];
  const messages: LegacyHistoryMessage[] = [];
  let firstUserMessage = true;
  let previousSeq = 0;
  let previousVisibleTimestampMs = 0;
  let rootBirthtimeMs: number;
  try {
    rootBirthtimeMs = Number(BigInt(source.identity.rootBirthtimeNs) / 1_000_000n);
  } catch {
    fail('PROJECT_IDENTITY', 'Legacy Project root generation timestamp was invalid');
  }
  if (!Number.isSafeInteger(rootBirthtimeMs) || rootBirthtimeMs <= 0) {
    fail('PROJECT_IDENTITY', 'Legacy Project root generation timestamp was unavailable');
  }
  for (const raw of rawMessages) {
    const { sourceId, sourceSeq } = assertHistoryPageMessageIdentity(raw);
    if (sourceIds.has(sourceId) || sourceSeqs.has(sourceSeq) || sourceSeq <= previousSeq) {
      fail('HISTORY_ORDER', 'OpenClaw history source order was duplicated or unstable');
    }
    sourceIds.add(sourceId);
    sourceSeqs.add(sourceSeq);
    previousSeq = sourceSeq;
    const timestamp = historyTimestamp(raw.timestamp);
    if (timestamp.getTime() < rootBirthtimeMs) {
      fail('HISTORY_ROOT_GENERATION', 'Legacy history predated the attested Project root generation');
    }
    const role = raw.role;
    const rawText = displayTextFromHistoryMessage(raw);
    const metadata = raw.__openclaw as Record<string, any>;
    digestRows.push([
      sourceId,
      sourceSeq,
      typeof role === 'string' ? role : null,
      sha256(rawText),
      raw.timestamp ?? null,
      metadata.recordTimestampMs ?? null,
      typeof raw.model === 'string' ? raw.model : null,
      sha256(JSON.stringify(raw)),
    ]);
    if (role !== 'user' && role !== 'assistant') continue;
    let content = rawText;
    let databaseMatchContents: readonly string[] = [content];
    if (role === 'user') {
      const prompt = exactLegacyProjectPrompt(content, firstUserMessage, Array.from(new Set([
        source.candidate.projectName,
        source.identity.projectName,
        source.identity.lastRenameSourceName || '',
      ].filter(Boolean))));
      firstUserMessage = false;
      content = prompt.display;
      databaseMatchContents = prompt.databaseMatches;
    } else {
      // chat.history already returns the Gateway's display projection. Do not
      // run generic envelope/control parsing during a historical migration:
      // only the two exact 3.26 Project prefixes above are recognized.
      content = normalizedMessageText(content);
      databaseMatchContents = [content];
    }
    if (!content) continue;
    if (timestamp.getTime() < previousVisibleTimestampMs) {
      fail('HISTORY_ORDER', 'OpenClaw history timestamps moved backwards relative to source order');
    }
    previousVisibleTimestampMs = timestamp.getTime();
    const sourceRecordTimestampMs = Number.isSafeInteger(metadata.recordTimestampMs)
      && metadata.recordTimestampMs > 0
      ? metadata.recordTimestampMs
      : timestamp.getTime();
    const sourceFingerprint = sha256(JSON.stringify([
      sourceId,
      sourceSeq,
      role,
      sha256(content),
      timestamp.getTime(),
      sourceRecordTimestampMs,
    ]));
    const projectionIndex = 0;
    const deterministicMessageId = deterministicLegacyMessageId({
      actorUserId: source.candidate.userId,
      projectIdentityId: source.identity.id,
      projectGeneration: source.identity.generation,
      agentId: described.agentId,
      sessionKey: described.key,
      providerSessionId,
      sourceId,
      sourceSeq,
      projectionIndex,
    });
    messages.push({
      sourceId,
      sourceSeq,
      sourceRecordTimestampMs,
      sourceFingerprint,
      role,
      content,
      databaseMatchContents,
      timestamp,
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim().slice(0, 512) : null,
      deterministicId: deterministicMessageId,
      deterministicMessageId,
      ordinal: messages.length,
      projectionIndex,
    });
  }
  return {
    agentId: described.agentId,
    sessionKey: described.key,
    providerSessionId,
    status: 'present',
    totalMessages: expectedTotal ?? 0,
    serializedBytes,
    transcriptDigest: sha256(JSON.stringify(digestRows)),
    sourceFingerprint: descriptionFingerprint(described),
    describedSession: described,
    messages: Object.freeze(messages),
  };
}

async function readStableCanonicalHistory(input: {
  source: LegacyProjectSessionSource;
  dependencies: LegacyOpenClawProjectRetirementDependencies;
  budget: OperationBudget;
}): Promise<LegacyCanonicalHistory> {
  for (let attempt = 0; attempt < MAX_HISTORY_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await describeExactLegacySession(
      input.dependencies,
      input.budget,
      input.source.session.agentId,
      input.source.session.key,
    );
    if (!before) fail('HISTORY_MISSING', 'Legacy session disappeared before its transcript was imported');
    if (
      input.source.session.sessionId
      && before.sessionId !== input.source.session.sessionId
    ) {
      fail('SESSION_RACE', 'Legacy session id changed after discovery');
    }
    let first: LegacyCanonicalHistory;
    try {
      first = await readCanonicalHistoryOnce({ ...input, described: before });
    } catch (error) {
      if (
        error instanceof LegacyOpenClawProjectRetirementError
        && ['HISTORY_UNSTABLE', 'HISTORY_ORDER', 'HISTORY_SESSION'].includes(error.code)
      ) {
        continue;
      }
      throw error;
    }
    const middle = await describeExactLegacySession(
      input.dependencies,
      input.budget,
      input.source.session.agentId,
      input.source.session.key,
    );
    if (!middle || descriptionFingerprint(before) !== descriptionFingerprint(middle)) continue;
    let second: LegacyCanonicalHistory;
    try {
      second = await readCanonicalHistoryOnce({ ...input, described: middle });
    } catch (error) {
      if (
        error instanceof LegacyOpenClawProjectRetirementError
        && ['HISTORY_UNSTABLE', 'HISTORY_ORDER', 'HISTORY_SESSION'].includes(error.code)
      ) {
        continue;
      }
      throw error;
    }
    const after = await describeExactLegacySession(
      input.dependencies,
      input.budget,
      input.source.session.agentId,
      input.source.session.key,
    );
    if (
      after
      && descriptionFingerprint(before) === descriptionFingerprint(after)
      && first.transcriptDigest === second.transcriptDigest
      && first.totalMessages === second.totalMessages
      && first.messages.length === second.messages.length
    ) return second;
  }
  fail('HISTORY_UNSTABLE', 'Legacy session changed during every bounded import attempt');
}

function projectCandidateKey(candidate: LegacyProjectCandidate): string {
  return [
    candidate.userId,
    candidate.canonicalRoot,
    candidate.rootDevice,
    candidate.rootInode,
    candidate.rootBirthtimeNs,
  ].join('\0');
}

function assertLegacyCandidateRootUnchanged(candidate: LegacyProjectCandidate): void {
  const current = attestProjectRoot(candidate.projectSource);
  if (
    current.canonicalRoot !== candidate.canonicalRoot
    || current.rootDevice !== candidate.rootDevice
    || current.rootInode !== candidate.rootInode
    || current.rootBirthtimeNs !== candidate.rootBirthtimeNs
  ) {
    fail('PROJECT_ROOT_RACE', 'Legacy Project root identity changed during transcript migration');
  }
}

function collectLegacyProjectCandidates(
  agents: readonly LegacyAgentCandidate[],
  containers: readonly LegacyContainerCandidate[],
): LegacyProjectCandidate[] {
  const byAgent = new Map<string, LegacyProjectCandidate>();
  for (const entry of [...agents, ...containers]) {
    const root = attestProjectRoot(entry.projectSource);
    const candidate: LegacyProjectCandidate = {
      agentId: entry.agentId,
      userId: entry.userId,
      projectName: entry.projectName,
      projectSource: entry.projectSource,
      projectRoot: entry.projectRoot,
      ...root,
    };
    const existing = byAgent.get(candidate.agentId);
    if (existing && projectCandidateKey(existing) !== projectCandidateKey(candidate)) {
      fail('PROJECT_RACE', 'Legacy agent and container mapped to different Projects');
    }
    byAgent.set(candidate.agentId, candidate);
  }
  return [...byAgent.values()].sort((left, right) => left.agentId.localeCompare(right.agentId));
}

function legacyAgentIdFromSessionValue(userId: string, value: unknown): string | null {
  if (!USER_ID_PATTERN.test(userId) || typeof value !== 'string') return null;
  const dedicated = parseLegacySessionKey(value);
  if (dedicated) {
    const parsed = parseLegacyAgentId(dedicated.agentId);
    if (!parsed || parsed.userPrefix !== userId.slice(0, 8)) {
      fail('SESSION_OWNERSHIP', 'Legacy database session key did not match its actor');
    }
    return dedicated.agentId;
  }
  const bases = collectExactLegacyBaseSessionIds(userId, value);
  if (bases.length === 0) return null;
  const prefix = `portal-${userId}-`;
  const slug = bases[0].slice(prefix.length);
  if (/-v(?:[1-9]|10)$/.test(slug)) return null;
  const agentId = `portal-${userId.slice(0, 8)}-${slug}`;
  return parseLegacyAgentId(agentId) ? agentId : null;
}

function ambiguousVersionedSharedAgentIds(userId: string, value: unknown): readonly string[] {
  const bases = collectExactLegacyBaseSessionIds(userId, value);
  if (bases.length !== 1) return [];
  const prefix = `portal-${userId}-`;
  const literalSlug = bases[0].slice(prefix.length);
  const version = literalSlug.match(/^(.*)-v(?:[1-9]|10)$/);
  if (!version || !version[1]) return [];
  return [literalSlug, version[1]]
    .map((slug) => `portal-${userId.slice(0, 8)}-${slug}`)
    .filter((agentId) => Boolean(parseLegacyAgentId(agentId)));
}

function immutableOpenClawProjectSessionKey(actorUserId: string, projectIdentityId: string): string {
  const identityHash = crypto.createHash('sha256')
    .update(actorUserId)
    .update('\0')
    .update(projectIdentityId)
    .digest('hex')
    .slice(0, 40);
  return `agent:p4oc-${identityHash}:portal-project`;
}

async function discoverDatabaseLegacyProjectCandidates(input: {
  existing: readonly LegacyProjectCandidate[];
  database: LegacyOpenClawProjectRetirementDatabase;
  roots: RetirementRoots;
  dependencies: LegacyOpenClawProjectRetirementDependencies;
  budget: OperationBudget;
}): Promise<LegacyProjectCandidate[]> {
  const [sessions, bindings, messages] = await Promise.all([
    input.database.projectChatSession.findMany({
      where: { activeProvider: 'OPENCLAW' },
      select: { id: true, userId: true, projectId: true, sessionKey: true, status: true, runtime: true },
      take: MAX_GLOBAL_DATABASE_PROVENANCE_ROWS + 1,
    }),
    input.database.projectChatProviderBinding.findMany({
      where: { provider: 'OPENCLAW' },
      select: {
        id: true,
        userId: true,
        projectId: true,
        provider: true,
        runtime: true,
        status: true,
        sessionKey: true,
        externalSessionId: true,
      },
      take: MAX_GLOBAL_DATABASE_PROVENANCE_ROWS + 1,
    }),
    input.database.projectChatMessage.findMany({
      where: {
        provider: 'OPENCLAW',
        // The provenance check permits only NULL (legacy/native) or IMPORTED.
        // An SQL `NOT status = 'IMPORTED'` predicate does not match NULL under
        // PostgreSQL three-valued logic, which would hide every 3.x row.
        legacyImportStatus: null,
      },
      select: {
        id: true,
        userId: true,
        projectId: true,
        sessionKey: true,
        providerSessionId: true,
        messageId: true,
        runtime: true,
      },
      take: MAX_GLOBAL_DATABASE_PROVENANCE_ROWS + 1,
    }),
  ]);
  if (
    sessions.length > MAX_GLOBAL_DATABASE_PROVENANCE_ROWS
    || bindings.length > MAX_GLOBAL_DATABASE_PROVENANCE_ROWS
    || messages.length > MAX_GLOBAL_DATABASE_PROVENANCE_ROWS
  ) {
    fail('DATABASE_ROWS', 'Global legacy Project provenance exceeded the discovery safety limit');
  }

  const rows = [
    ...sessions.map((row) => ({
      ...row,
      messageId: null,
      provenanceKind: 'SESSION' as const,
      values: [row.sessionKey],
    })),
    ...bindings.map((row) => ({
      ...row,
      messageId: null,
      provenanceKind: 'BINDING' as const,
      values: [row.sessionKey, row.externalSessionId],
    })),
    ...messages.map((row) => ({
      ...row,
      provenanceKind: 'MESSAGE' as const,
      values: [row.sessionKey, row.providerSessionId],
    })),
  ];
  const byAgent = new Map(input.existing.map((candidate) => [candidate.agentId, candidate]));
  const modernIdentityCache = new Map<string, LegacyProjectIdentityRow | null>();
  for (const row of rows) {
    if (row.provenanceKind === 'SESSION' && row.status !== 'active') {
      let clearedIdentity = await input.database.projectIdentity.findUnique({ where: { id: row.projectId } });
      if (!clearedIdentity) {
        clearedIdentity = await input.database.projectIdentity.findUnique({
          where: {
            workspaceOwnerId_projectName: {
              workspaceOwnerId: row.userId,
              projectName: row.projectId,
            },
          },
        });
      }
      if (clearedIdentity && clearedIdentity.workspaceOwnerId === row.userId) {
        const tombstone = await input.database.legacyOpenClawProjectClearTombstone.findFirst({
          where: {
            actorUserId: row.userId,
            projectIdentityId: clearedIdentity.id,
          },
          select: { id: true },
        });
        if (tombstone) {
          const probes = new Map<string, { agentId: string; key: string }>();
          for (const value of row.values) {
            if (typeof value !== 'string') continue;
            const dedicated = parseLegacySessionKey(value);
            if (dedicated) probes.set(value, { agentId: dedicated.agentId, key: value });
            for (const rawBase of collectExactLegacyBaseSessionIds(row.userId, value)) {
              const bases = new Set([rawBase]);
              const prefix = `portal-${row.userId}-`;
              const slug = rawBase.slice(prefix.length);
              const versioned = slug.match(/^(.*)-v(?:[1-9]|10)$/);
              if (versioned?.[1]) bases.add(`${prefix}${versioned[1]}`);
              for (const base of bases) {
                for (const suffix of ['', ...Array.from({ length: 10 }, (_unused, index) => `-v${index + 1}`)]) {
                  const key = `agent:portal:${base}${suffix}`;
                  probes.set(key, { agentId: 'portal', key });
                }
              }
            }
          }
          const clearedProofs = await input.database.legacyOpenClawProjectImport.findMany({
            where: {
              actorUserId: row.userId,
              projectIdentityId: clearedIdentity.id,
              sourceStatus: LEGACY_IMPORT_CLEARED,
            },
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
            take: MAX_IMPORT_RECOVERY_PROOFS + 1,
          });
          if (clearedProofs.length > MAX_IMPORT_RECOVERY_PROOFS) {
            fail('IMPORT_PROOF_LIMIT', 'Cleared legacy source proof inventory exceeded its safety limit');
          }
          for (const proof of clearedProofs) {
            if (
              proof.actorUserId !== row.userId
              || proof.projectIdentityId !== clearedIdentity.id
              || proof.sourceStatus !== LEGACY_IMPORT_CLEARED
              || !legacyProofCandidateIsAttested(proof)
              || proof.sourceAgentHash !== sha256(proof.sourceAgentId)
              || proof.sessionKeyHash !== sha256(proof.sourceSessionKey)
            ) {
              fail('IMPORT_PROOF', 'Cleared legacy source proof was malformed during expired-row discovery');
            }
            probes.set(proof.sourceSessionKey, {
              agentId: proof.sourceAgentId,
              key: proof.sourceSessionKey,
            });
          }
          if (probes.size > 0) {
            for (const probe of probes.values()) {
              if (await describeExactLegacySession(
                input.dependencies,
                input.budget,
                probe.agentId,
                probe.key,
              )) {
                fail('SOURCE_CLEARED', 'Cleared legacy Project history reappeared and will not be imported');
              }
            }
            continue;
          }
        }
      }
    }
    const agentIds = new Set<string>();
    for (const value of row.values) {
      const directAgentId = legacyAgentIdFromSessionValue(row.userId, value);
      if (directAgentId) {
        agentIds.add(directAgentId);
        continue;
      }
      const versionCandidates = ambiguousVersionedSharedAgentIds(row.userId, value);
      if (versionCandidates.length === 0) continue;
      const attestedCandidates = versionCandidates.filter((agentId) => byAgent.has(agentId));
      if (attestedCandidates.length !== 1) {
        fail(
          'PROJECT_SOURCE_AMBIGUOUS',
          'Versioned shared OpenClaw provenance lacked one attested base Project identity',
        );
      }
      agentIds.add(attestedCandidates[0]);
    }
    if (agentIds.size === 0) {
      const cacheKey = `${row.userId}\0${row.projectId}`;
      let modernIdentity = modernIdentityCache.get(cacheKey);
      if (modernIdentity === undefined) {
        modernIdentity = await input.database.projectIdentity.findUnique({ where: { id: row.projectId } });
        modernIdentityCache.set(cacheKey, modernIdentity);
      }
      const expectedSessionKey = modernIdentity
        && modernIdentity.workspaceOwnerId === row.userId
        && (modernIdentity.lifecycleStatus || 'ACTIVE') === 'ACTIVE'
        ? immutableOpenClawProjectSessionKey(row.userId, modernIdentity.id)
        : null;
      const nonemptyValues = row.values
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
      let protectedResetBinding = false;
      if (
        expectedSessionKey
        && row.provenanceKind === 'BINDING'
        && row.runtime === LEGACY_IMPORT_RUNTIME
        && row.status === 'reset'
        && nonemptyValues.length === 0
      ) {
        protectedResetBinding = Boolean(await input.database.legacyOpenClawProjectClearTombstone.findFirst({
          where: {
            actorUserId: row.userId,
            projectIdentityId: modernIdentity!.id,
          },
          select: { id: true },
        }));
      }
      const isProtectedModernRow = Boolean(
        protectedResetBinding
        || (
          expectedSessionKey
          && row.runtime === LEGACY_IMPORT_RUNTIME
          && nonemptyValues.length > 0
          && nonemptyValues.every((value) => value === expectedSessionKey)
          && (row.provenanceKind !== 'MESSAGE'
            || (typeof row.messageId === 'string' && row.messageId.length > 0))
        ),
      );
      if (isProtectedModernRow) continue;
      fail(
        'PROJECT_SOURCE_AMBIGUOUS',
        'OpenClaw database provenance was neither an exact legacy source nor an immutable current Project session',
      );
    }
    if (agentIds.size !== 1) {
      fail('PROJECT_SOURCE_AMBIGUOUS', 'Legacy database provenance named multiple dedicated agents');
    }
    const agentId = [...agentIds][0];
    let identity = await input.database.projectIdentity.findUnique({ where: { id: row.projectId } });
    if (!identity) {
      identity = await input.database.projectIdentity.findUnique({
        where: {
          workspaceOwnerId_projectName: {
            workspaceOwnerId: row.userId,
            projectName: row.projectId,
          },
        },
      });
    }
    let projectSource: string;
    if (identity) {
      if (identity.workspaceOwnerId !== row.userId || (identity.lifecycleStatus || 'ACTIVE') !== 'ACTIVE') {
        fail('PROJECT_IDENTITY', 'Legacy database provenance did not match an active Project owner');
      }
      projectSource = identity.canonicalRoot;
    } else {
      if (!row.projectId || path.basename(row.projectId) !== row.projectId || row.projectId.includes('\\')) {
        fail('PROJECT_IDENTITY', 'Legacy database provenance had no attested Project identity');
      }
      const possibleRoots = input.roots.portalProjectsRoots
        .map((root) => path.join(root, row.userId, row.projectId))
        .filter((candidate) => fs.existsSync(candidate));
      if (possibleRoots.length !== 1) {
        fail('PROJECT_IDENTITY', 'Legacy database provenance had no unique live Project root');
      }
      projectSource = possibleRoots[0];
    }
    const attested = attestProjectSource(projectSource, agentId, input.roots);
    if (identity && (
      identity.canonicalRoot !== projectSource
      || identity.projectName !== attested.projectName
    )) {
      fail('PROJECT_IDENTITY', 'Legacy database provenance changed Project roots during discovery');
    }
    const candidate: LegacyProjectCandidate = {
      agentId,
      userId: attested.userId,
      projectName: attested.projectName,
      projectSource,
      projectRoot: attested.projectRoot,
      ...attestProjectRoot(projectSource),
    };
    const existing = byAgent.get(agentId);
    if (existing && projectCandidateKey(existing) !== projectCandidateKey(candidate)) {
      fail('PROJECT_RACE', 'Legacy database and runtime provenance mapped one agent to different Projects');
    }
    byAgent.set(agentId, candidate);
  }
  return [...byAgent.values()].sort((left, right) => left.agentId.localeCompare(right.agentId));
}

/**
 * Release-only database inventory for the compile-time-disabled migration.
 *
 * Exact Portal 4 rows can be dismissed from their immutable identity/session
 * key without touching the filesystem. Everything else is evidence, including
 * missing identities, old name-keyed Projects, malformed values, and versioned
 * legacy aliases. Those ambiguous rows must keep the global gate closed, but
 * they do not need (and must not attempt) Project-root attribution while the
 * destructive migration is unreachable.
 */
async function discoverDisabledReleaseDatabaseEvidence(
  database: LegacyOpenClawProjectRetirementDatabase,
): Promise<readonly string[]> {
  const [sessions, bindings, messages] = await Promise.all([
    database.projectChatSession.findMany({
      where: { activeProvider: 'OPENCLAW' },
      select: { id: true, userId: true, projectId: true, sessionKey: true, status: true, runtime: true },
      take: MAX_GLOBAL_DATABASE_PROVENANCE_ROWS + 1,
    }),
    database.projectChatProviderBinding.findMany({
      where: { provider: 'OPENCLAW' },
      select: {
        id: true,
        userId: true,
        projectId: true,
        provider: true,
        runtime: true,
        status: true,
        sessionKey: true,
        externalSessionId: true,
      },
      take: MAX_GLOBAL_DATABASE_PROVENANCE_ROWS + 1,
    }),
    database.projectChatMessage.findMany({
      where: { provider: 'OPENCLAW', legacyImportStatus: null },
      select: {
        id: true,
        userId: true,
        projectId: true,
        sessionKey: true,
        providerSessionId: true,
        messageId: true,
        runtime: true,
      },
      take: MAX_GLOBAL_DATABASE_PROVENANCE_ROWS + 1,
    }),
  ]);

  if (
    sessions.length > MAX_GLOBAL_DATABASE_PROVENANCE_ROWS
    || bindings.length > MAX_GLOBAL_DATABASE_PROVENANCE_ROWS
    || messages.length > MAX_GLOBAL_DATABASE_PROVENANCE_ROWS
  ) {
    return ['database:provenance-inventory-overflow'];
  }

  const rows: Array<{
    id: string;
    userId: string;
    projectId: string;
    runtime: string;
    status: string | null;
    messageId: string | null;
    kind: 'session' | 'binding' | 'message';
    values: readonly unknown[];
  }> = [
    ...sessions.map((row) => ({
      ...row,
      status: row.status || null,
      messageId: null,
      kind: 'session' as const,
      values: [row.sessionKey],
    })),
    ...bindings.map((row) => ({
      ...row,
      status: row.status || null,
      messageId: null,
      kind: 'binding' as const,
      values: [row.sessionKey, row.externalSessionId],
    })),
    ...messages.map((row) => ({
      ...row,
      status: null,
      messageId: row.messageId || null,
      kind: 'message' as const,
      values: [row.sessionKey, row.providerSessionId],
    })),
  ];
  const identityCache = new Map<string, LegacyProjectIdentityRow | null>();
  const evidence: string[] = [];
  for (const row of rows) {
    const cacheKey = `${row.userId}\0${row.projectId}`;
    let identity = identityCache.get(cacheKey);
    if (!identityCache.has(cacheKey)) {
      identity = await database.projectIdentity.findUnique({ where: { id: row.projectId } });
      identityCache.set(cacheKey, identity || null);
    }
    const expectedSessionKey = identity
      && identity.workspaceOwnerId === row.userId
      && (identity.lifecycleStatus || 'ACTIVE') === 'ACTIVE'
      ? immutableOpenClawProjectSessionKey(row.userId, identity.id)
      : null;
    const nonemptyValues = row.values
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    let protectedResetBinding = false;
    if (
      expectedSessionKey
      && row.kind === 'binding'
      && row.runtime === LEGACY_IMPORT_RUNTIME
      && row.status === 'reset'
      && nonemptyValues.length === 0
    ) {
      protectedResetBinding = Boolean(await database.legacyOpenClawProjectClearTombstone.findFirst({
        where: {
          actorUserId: row.userId,
          projectIdentityId: identity!.id,
        },
        select: { id: true },
      }));
    }
    const exactModernRow = Boolean(
      protectedResetBinding
      || (
        expectedSessionKey
        && row.runtime === LEGACY_IMPORT_RUNTIME
        && nonemptyValues.length > 0
        && nonemptyValues.every((value) => value === expectedSessionKey)
        && (row.kind !== 'message' || Boolean(row.messageId))
      ),
    );
    if (!exactModernRow) evidence.push(`database-${row.kind}:${row.id}`);
  }
  return evidence;
}

async function assertNoUnknownLegacyAgentDirectories(input: {
  candidates: readonly LegacyProjectCandidate[];
  roots: RetirementRoots;
  database: LegacyOpenClawProjectRetirementDatabase;
}): Promise<void> {
  const agentsRoot = path.join(input.roots.openClawHome, 'agents');
  let entries: fs.Dirent[];
  try {
    const stat = fs.lstatSync(agentsRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail('AGENT_DIRECTORY', 'OpenClaw agent inventory root was not a real directory');
    }
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (entries.length > MAX_CONFIG_AGENTS * 4) {
    fail('AGENT_LIMIT', 'OpenClaw agent directory inventory exceeded its safety limit');
  }
  const proofs = await input.database.legacyOpenClawProjectImport.findMany({
    where: { sourceKind: 'DEDICATED' },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: MAX_IMPORT_RECOVERY_PROOFS + 1,
  });
  if (proofs.length > MAX_IMPORT_RECOVERY_PROOFS) {
    fail('IMPORT_PROOF_LIMIT', 'Legacy dedicated-agent proof inventory exceeded its safety limit');
  }
  const known = new Set([
    ...input.candidates.map((candidate) => candidate.agentId),
    ...proofs.map((proof) => proof.sourceAgentId),
  ]);
  for (const entry of entries) {
    if (!parseLegacyAgentId(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail('AGENT_DIRECTORY', 'Legacy agent artifact was not a real directory');
    }
    if (!known.has(entry.name)) {
      fail('UNACCOUNTED_AGENT_DIRECTORY', 'An unproved legacy agent directory remains preserved');
    }
  }
}

function listLegacyAgentArtifactIds(roots: RetirementRoots): readonly string[] {
  const agentsRoot = path.join(roots.openClawHome, 'agents');
  let entries: fs.Dirent[];
  try {
    const stat = fs.lstatSync(agentsRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail('AGENT_DIRECTORY', 'OpenClaw agent inventory root was not a real directory');
    }
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (entries.length > MAX_CONFIG_AGENTS * 4) {
    fail('AGENT_LIMIT', 'OpenClaw agent directory inventory exceeded its safety limit');
  }
  const legacyAgentIds: string[] = [];
  for (const entry of entries) {
    if (!parseLegacyAgentId(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail('AGENT_DIRECTORY', 'Legacy agent artifact was not a real directory');
    }
    legacyAgentIds.push(entry.name);
  }
  return Object.freeze(legacyAgentIds.sort());
}

async function resolveLegacyProjectIdentity(
  candidate: LegacyProjectCandidate,
  database: LegacyOpenClawProjectRetirementTransaction,
): Promise<LegacyProjectIdentityRow> {
  const root = attestProjectRoot(candidate.projectSource);
  assertLegacyCandidateRootUnchanged(candidate);
  const byRoot = await database.projectIdentity.findFirst({
    where: {
      workspaceOwnerId: candidate.userId,
      canonicalRoot: root.canonicalRoot,
    },
  });
  if (byRoot) {
    if ((byRoot.lifecycleStatus || 'ACTIVE') !== 'ACTIVE') {
      fail('PROJECT_LIFECYCLE', 'Legacy Project identity was not active during import');
    }
    if (byRoot.legacyOpenClawMigrationStatus === 'CURRENT') {
      fail(
        'CURRENT_PROJECT_COLLISION',
        'Preserved legacy OpenClaw state collided with a current Portal 4 Project instance',
      );
    }
    if (
      byRoot.canonicalRoot !== root.canonicalRoot
      || byRoot.rootDevice !== root.rootDevice
      || byRoot.rootInode !== root.rootInode
      || byRoot.rootBirthtimeNs !== root.rootBirthtimeNs
    ) {
      fail('PROJECT_IDENTITY', 'Legacy Project root no longer matched its immutable identity');
    }
    return byRoot;
  }
  return ensureProjectIdentity({
    workspaceOwnerId: candidate.userId,
    projectName: candidate.projectName,
    projectRoot: candidate.projectSource,
  }, database as any) as Promise<LegacyProjectIdentityRow>;
}

async function assertNoPendingLegacyDestructiveReset(
  candidates: readonly LegacyProjectCandidate[],
  identities: ReadonlyMap<string, LegacyProjectIdentityRow>,
  database: LegacyOpenClawProjectRetirementDatabase,
): Promise<void> {
  for (const candidate of candidates) {
    const identity = identities.get(candidate.agentId);
    if (!identity) fail('PROJECT_IDENTITY', 'Legacy Project identity was not resolved');
    const [resetJournal, legacyAdmission] = await Promise.all([
      database.projectChatDestructiveResetJournal.findFirst({
        where: {
          actorUserId: candidate.userId,
          projectIdentityId: identity.id,
          status: 'RESETTING',
        },
        select: { id: true },
      }),
      // Compatibility fence for a reset admitted before the durable journal
      // migration was installed. New resets remain fenced by resetJournal even
      // if generic lease recovery later finalizes their management turn.
      database.projectChatTurn.findFirst({
        where: {
          actorUserId: candidate.userId,
          projectIdentityId: identity.id,
          status: { in: ['RUNNING', 'ABORTING'] },
          requestId: { startsWith: DESTRUCTIVE_RESET_ADMISSION_PREFIX },
        },
        select: { id: true },
      }),
    ]);
    if (resetJournal || legacyAdmission) {
      fail('RESET_PENDING', 'A destructive Project Chat reset must converge before legacy history import');
    }
  }
}

async function assertLegacyHistoryWasNotCleared(
  candidates: readonly LegacyProjectCandidate[],
  identities: ReadonlyMap<string, LegacyProjectIdentityRow>,
  database: LegacyOpenClawProjectRetirementDatabase,
): Promise<void> {
  for (const candidate of candidates) {
    const identity = identities.get(candidate.agentId);
    if (!identity) fail('PROJECT_IDENTITY', 'Legacy Project identity was not resolved');
    const cleared = await database.legacyOpenClawProjectClearTombstone.findFirst({
      where: {
        actorUserId: candidate.userId,
        projectIdentityId: identity.id,
      },
      select: { id: true },
    });
    if (cleared) {
      fail('SOURCE_CLEARED', 'Cleared legacy Project history reappeared and will not be imported');
    }
  }
}

function exactLegacyBaseSessionId(userId: string, value: string): string | null {
  const normalized = String(value || '').trim();
  const prefix = `portal-${userId}-`;
  if (!normalized.startsWith(prefix) || normalized.length > 256) return null;
  if (/[^a-zA-Z0-9_-]/.test(normalized)) return null;
  return normalized;
}

function collectExactLegacyBaseSessionIds(userId: string, value: unknown): string[] {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return [];
  const direct = exactLegacyBaseSessionId(userId, normalized);
  if (direct) return [direct];
  const sharedPrefix = 'agent:portal:';
  if (!normalized.startsWith(sharedPrefix)) return [];
  const shared = exactLegacyBaseSessionId(userId, normalized.slice(sharedPrefix.length));
  return shared ? [shared] : [];
}

async function discoverLegacyProjectSessionSources(input: {
  candidates: readonly LegacyProjectCandidate[];
  identities: ReadonlyMap<string, LegacyProjectIdentityRow>;
  containers: readonly LegacyContainerCandidate[];
  dependencies: LegacyOpenClawProjectRetirementDependencies;
  database: LegacyOpenClawProjectRetirementDatabase;
  budget: OperationBudget;
}): Promise<LegacyProjectSessionSource[]> {
  const dedicated = await listLegacySessions(
    input.dependencies,
    input.budget,
    input.candidates.map((candidate) => candidate.agentId),
  );
  const dedicatedByKey = new Map(dedicated.map((session) => [session.key, session]));
  for (const container of input.containers) {
    if (!dedicatedByKey.has(container.sessionKey)) {
      dedicatedByKey.set(container.sessionKey, {
        agentId: container.agentId,
        key: container.sessionKey,
      });
    }
  }

  const result = new Map<string, LegacyProjectSessionSource>();
  const claimedSessionKeys = new Map<string, string>();
  for (const candidate of input.candidates) {
    const identity = input.identities.get(candidate.agentId);
    if (!identity) fail('PROJECT_IDENTITY', 'Legacy Project identity was not resolved');
    const parsedAgent = parseLegacyAgentId(candidate.agentId);
    if (!parsedAgent || parsedAgent.userPrefix !== candidate.userId.slice(0, 8)) {
      fail('AGENT_IDENTITY', 'Legacy Project agent id no longer matched its authenticated owner');
    }
    const baseSessionId = `portal-${candidate.userId}-${parsedAgent.slug}`;
    const allowedSharedReferences = new Set([
      baseSessionId,
      ...Array.from({ length: 10 }, (_unused, index) => `${baseSessionId}-v${index + 1}`),
    ]);
    const assertSharedReferenceOwnership = (value: unknown): void => {
      for (const referenced of collectExactLegacyBaseSessionIds(candidate.userId, value)) {
        if (!allowedSharedReferences.has(referenced)) {
          fail('SESSION_OWNERSHIP', 'Legacy database session provenance did not match its attested Project');
        }
      }
    };
    for (const session of dedicatedByKey.values()) {
      if (session.agentId !== candidate.agentId) continue;
      assertSharedReferenceOwnership(session.key);
      const described = await describeExactLegacySession(
        input.dependencies,
        input.budget,
        session.agentId,
        session.key,
      );
      if (!described) {
        const retiredProof = await input.database.legacyOpenClawProjectImport.findUnique({
          where: {
            actorUserId_sourceAgentHash_sessionKeyHash: {
              actorUserId: candidate.userId,
              sourceAgentHash: sha256(session.agentId),
              sessionKeyHash: sha256(session.key),
            },
          },
        });
        if (
          retiredProof
          && retiredProof.projectIdentityId === identity.id
          && retiredProof.projectGeneration === identity.generation
          && retiredProof.sourceAgentId === session.agentId
          && retiredProof.sourceSessionKey === session.key
          && retiredProof.sourceStatus === LEGACY_IMPORT_RETIRED
        ) {
          continue;
        }
        fail('SESSION_RACE', 'Legacy dedicated session disappeared during exact source discovery');
      }
      const owner = claimedSessionKeys.get(session.key);
      if (owner && owner !== candidate.agentId) fail('SESSION_OWNERSHIP', 'Legacy session mapped to multiple Projects');
      claimedSessionKeys.set(session.key, candidate.agentId);
      result.set(session.key, { candidate, identity, session: described });
    }
    const databaseSessions = await input.database.projectChatSession.findMany({
      where: {
        userId: candidate.userId,
        status: 'active',
        projectId: {
          in: Array.from(new Set([
            candidate.projectName,
            identity.projectName,
            identity.lastRenameSourceName || '',
            identity.id,
          ].filter(Boolean))),
        },
      },
      select: { id: true, userId: true, projectId: true, sessionKey: true },
    });
    for (const row of databaseSessions) {
      assertSharedReferenceOwnership(row.sessionKey);
    }
    const projectIds = Array.from(new Set([
      candidate.projectName,
      identity.projectName,
      identity.lastRenameSourceName || '',
      identity.id,
    ].filter(Boolean)));
    const [databaseBindings, databaseMessages] = await Promise.all([
      input.database.projectChatProviderBinding.findMany({
        where: {
          userId: candidate.userId,
          projectId: { in: projectIds },
          provider: 'OPENCLAW',
        },
        select: {
          id: true,
          userId: true,
          projectId: true,
          provider: true,
          sessionKey: true,
          externalSessionId: true,
        },
      }),
      input.database.projectChatMessage.findMany({
        where: {
          userId: candidate.userId,
          projectId: { in: projectIds },
          provider: 'OPENCLAW',
        },
        select: { sessionKey: true, providerSessionId: true },
        take: MAX_DATABASE_ROWS_PER_PROJECT + 1,
      }),
    ]);
    if (databaseMessages.length > MAX_DATABASE_ROWS_PER_PROJECT) {
      fail('DATABASE_ROWS', 'Legacy Project session provenance exceeded the import row limit');
    }
    for (const binding of databaseBindings) {
      for (const value of [binding.sessionKey, binding.externalSessionId]) {
        assertSharedReferenceOwnership(value);
      }
    }
    for (const message of databaseMessages) {
      for (const value of [message.sessionKey, message.providerSessionId]) {
        assertSharedReferenceOwnership(value);
      }
    }
    for (const suffix of ['', ...Array.from({ length: 10 }, (_value, index) => `-v${index + 1}`)]) {
      const key = `agent:portal:${baseSessionId}${suffix}`;
      const described = await describeExactLegacySession(
        input.dependencies,
        input.budget,
        'portal',
        key,
      );
      if (!described) continue;
      const owner = claimedSessionKeys.get(key);
      if (owner && owner !== candidate.agentId) fail('SESSION_OWNERSHIP', 'Shared legacy session mapped to multiple Projects');
      claimedSessionKeys.set(key, candidate.agentId);
      result.set(key, { candidate, identity, session: described });
    }
    const committedProofs = await input.database.legacyOpenClawProjectImport.findMany({
      where: {
        actorUserId: candidate.userId,
        projectIdentityId: identity.id,
        projectGeneration: identity.generation,
        sourceStatus: { in: [LEGACY_IMPORT_COMPLETE, LEGACY_IMPORT_RETIRED] },
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: MAX_SESSION_ROWS_PER_AGENT + 1,
    });
    if (committedProofs.length > MAX_SESSION_ROWS_PER_AGENT) {
      fail('IMPORT_PROOF_LIMIT', 'Legacy Project source proofs exceeded the per-agent safety limit');
    }
    for (const proof of committedProofs) {
      if (
        proof.actorUserId !== candidate.userId
        || proof.projectIdentityId !== identity.id
        || proof.projectGeneration !== identity.generation
        || !legacyProofCandidateIsAttested(proof)
        || proof.candidateAgentId !== candidate.agentId
        || ![candidate.agentId, 'portal'].includes(proof.sourceAgentId)
        || proof.sourceAgentHash !== sha256(proof.sourceAgentId)
        || proof.sessionKeyHash !== sha256(proof.sourceSessionKey)
        || proof.providerSessionIdHash !== sha256(proof.providerSessionId || '')
      ) {
        fail('IMPORT_PROOF', 'Legacy source proof did not match its exact actor and Project generation');
      }
      const described = await describeExactLegacySession(
        input.dependencies,
        input.budget,
        proof.sourceAgentId,
        proof.sourceSessionKey,
      );
      if (proof.sourceStatus === LEGACY_IMPORT_RETIRED) {
        if (described) fail('SESSION_RACE', 'A retired legacy source registration reappeared');
        // A surviving container can synthesize a source row after the exact
        // Gateway registration was already retired. Keep it out of history
        // capture; its container is handled later under this durable proof.
        result.delete(proof.sourceSessionKey);
        continue;
      }
      if (!described) {
        fail('IMPORT_PROOF', 'A complete legacy source proof lost its registration before recovery');
      }
      const owner = claimedSessionKeys.get(described.key);
      if (owner && owner !== candidate.agentId) {
        fail('SESSION_OWNERSHIP', 'Proved legacy session mapped to multiple Projects');
      }
      claimedSessionKeys.set(described.key, candidate.agentId);
      result.set(described.key, { candidate, identity, session: described });
    }
  }
  const immutableSessionOwners = new Map<string, LegacyProjectSessionSource>();
  for (const source of result.values()) {
    if (!source.session.sessionId) continue;
    const immutableKey = source.session.sessionId;
    const prior = immutableSessionOwners.get(immutableKey);
    if (prior && (
      prior.identity.id !== source.identity.id
      || prior.session.key !== source.session.key
    )) {
      fail(
        source.session.agentId === 'portal' || prior.session.agentId === 'portal'
          ? 'SHARED_SESSION_ALIAS_AMBIGUOUS'
          : 'SESSION_ALIAS_AMBIGUOUS',
        'Multiple exact legacy keys resolved to one immutable transcript',
      );
    }
    immutableSessionOwners.set(immutableKey, source);
  }
  return [...result.values()].sort((left, right) => left.session.key.localeCompare(right.session.key));
}

function legacyTranscriptArtifactClass(name: string): { sessionId: string; artifactClass: string } | null {
  const sessionId = '[a-z0-9][a-z0-9._-]{0,127}';
  const archiveStamp = '(?:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}(?:\\.[0-9]{3})?Z|[0-9]+)';
  const branchArchive = name.match(new RegExp(
    `^\\d{4}-\\d{2}-\\d{2}T[0-9TZ.-]+_(${sessionId})\\.jsonl\\.((?:reset|deleted|bak)\\.${archiveStamp})$`,
    'i',
  ));
  if (branchArchive) {
    return { sessionId: branchArchive[1], artifactClass: branchArchive[2].split('.')[0] };
  }
  const archive = name.match(new RegExp(
    `^(${sessionId})\\.jsonl\\.((?:reset|deleted|bak)\\.${archiveStamp})$`,
    'i',
  ));
  if (archive) return { sessionId: archive[1], artifactClass: archive[2].split('.')[0] };
  const checkpoint = name.match(new RegExp(
    `^(${sessionId})\\.checkpoint\\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.jsonl$`,
    'i',
  ));
  if (checkpoint) return { sessionId: checkpoint[1], artifactClass: 'checkpoint' };
  const branchTrajectory = name.match(new RegExp(
    `^\\d{4}-\\d{2}-\\d{2}T[0-9TZ.-]+_(${sessionId})\\.(trajectory\\.jsonl|trajectory-path\\.json)$`,
    'i',
  ));
  if (branchTrajectory) return { sessionId: branchTrajectory[1], artifactClass: 'trajectory' };
  const trajectory = name.match(new RegExp(
    `^(${sessionId})\\.(trajectory\\.jsonl|trajectory-path\\.json)$`,
    'i',
  ));
  if (trajectory) return { sessionId: trajectory[1], artifactClass: 'trajectory' };
  const branch = name.match(new RegExp(
    `^\\d{4}-\\d{2}-\\d{2}T[0-9TZ.-]+_(${sessionId})\\.jsonl$`,
    'i',
  ));
  if (branch) return { sessionId: branch[1], artifactClass: 'branch-canonical' };
  const canonical = name.match(new RegExp(`^(${sessionId})\\.jsonl$`, 'i'));
  if (canonical) return { sessionId: canonical[1], artifactClass: 'canonical' };
  return null;
}

interface LegacyTranscriptArtifactInventory {
  rows: unknown[];
  canonicalSessionIdCounts: ReadonlyMap<string, number>;
}

function inventoryLegacyTranscriptDirectory(input: {
  sessionsDir: string;
  knownSessionIds: ReadonlySet<string>;
  provedSessionIdHashes: ReadonlySet<string>;
  shared: boolean;
}): LegacyTranscriptArtifactInventory {
  let directory: fs.BigIntStats;
  try {
    directory = fs.lstatSync(input.sessionsDir, { bigint: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { rows: [], canonicalSessionIdCounts: new Map() };
    throw error;
  }
  if (
    directory.isSymbolicLink()
    || !directory.isDirectory()
    || fs.realpathSync.native(input.sessionsDir) !== input.sessionsDir
  ) {
    fail('TRANSCRIPT_DIRECTORY', 'Legacy transcript root was not an exact real directory');
  }
  const directoryRow = [
    'directory',
    directory.dev.toString(),
    directory.ino.toString(),
    directory.mode.toString(),
    directory.nlink.toString(),
    directory.birthtimeNs.toString(),
  ];
  const inventory: unknown[] = [directoryRow];
  const canonicalSessionIdCounts = new Map<string, number>();
  const exactArtifactFingerprints = new Map<string, string>();
  const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const fileFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
  let directoryFd: number | null = null;
  try {
    directoryFd = fs.openSync(input.sessionsDir, directoryFlags);
    const openedDirectory = fs.fstatSync(directoryFd, { bigint: true });
    if (
      openedDirectory.dev !== directory.dev
      || openedDirectory.ino !== directory.ino
      || openedDirectory.birthtimeNs !== directory.birthtimeNs
    ) {
      fail('TRANSCRIPT_DIRECTORY', 'Legacy transcript root changed while its inventory handle opened');
    }
    const anchoredDirectory = `/proc/self/fd/${directoryFd}`;
    const entries = fs.readdirSync(anchoredDirectory, { withFileTypes: true });
    if (entries.length > MAX_SESSION_ROWS_PER_AGENT * 4) {
      fail('TRANSCRIPT_LIMIT', 'Legacy transcript directory exceeded the inventory limit');
    }
    const belongsToSource = (sessionId: string): boolean => (
      input.knownSessionIds.has(sessionId)
      || input.provedSessionIdHashes.has(sha256(sessionId))
    );
    for (const entry of entries) {
      const classified = legacyTranscriptArtifactClass(entry.name);
      const belongs = classified && belongsToSource(classified.sessionId);
      const stronglyExactUnprojectable = !classified && [...input.knownSessionIds].some((sessionId) => (
        entry.name.startsWith(`${sessionId}.`)
        || entry.name.startsWith(`${sessionId}-topic-`)
        || entry.name.includes(`_${sessionId}.jsonl`)
      ));
      if (!belongs) {
        if (stronglyExactUnprojectable) {
          fail('TRANSCRIPT_ARTIFACT_UNPROJECTABLE', 'Legacy transcript artifact lacked authoritative metadata');
        }
        if (!input.shared && entry.name.includes('.jsonl')) {
          fail('TRANSCRIPT_ORPHAN', 'Legacy transcript artifacts were not covered by a canonical session snapshot');
        }
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail('TRANSCRIPT_FILE', 'Legacy transcript artifact was not a regular file');
      }
      if (!['canonical', 'branch-canonical'].includes(classified.artifactClass)) {
        // The live Gateway history does not prove the content or privacy intent
        // of reset/deleted/backup/checkpoint/trajectory residue.
        fail('TRANSCRIPT_ARCHIVE_PENDING', 'Legacy transcript archives require a separate provenance import');
      }
      const artifactPath = path.join(anchoredDirectory, entry.name);
      let artifactFd: number | null = null;
      try {
        artifactFd = fs.openSync(artifactPath, fileFlags);
        const artifact = fs.fstatSync(artifactFd, { bigint: true });
        if (!artifact.isFile()) {
          fail('TRANSCRIPT_FILE', 'Legacy transcript artifact changed type during inventory');
        }
        const artifactRow = [
          classified.artifactClass,
          sha256(entry.name),
          artifact.dev.toString(),
          artifact.ino.toString(),
          artifact.mode.toString(),
          artifact.nlink.toString(),
          artifact.size.toString(),
          artifact.mtimeNs.toString(),
          artifact.ctimeNs.toString(),
          artifact.birthtimeNs.toString(),
        ];
        inventory.push(artifactRow);
        exactArtifactFingerprints.set(entry.name, JSON.stringify(artifactRow));
        const sessionIdHash = sha256(classified.sessionId);
        canonicalSessionIdCounts.set(
          sessionIdHash,
          (canonicalSessionIdCounts.get(sessionIdHash) || 0) + 1,
        );
      } finally {
        if (artifactFd != null) fs.closeSync(artifactFd);
      }
    }
    const finalEntries = fs.readdirSync(anchoredDirectory, { withFileTypes: true });
    if (finalEntries.length > MAX_SESSION_ROWS_PER_AGENT * 4) {
      fail('TRANSCRIPT_LIMIT', 'Legacy transcript directory changed beyond the inventory limit');
    }
    const finalArtifactFingerprints = new Map<string, string>();
    for (const entry of finalEntries) {
      const classified = legacyTranscriptArtifactClass(entry.name);
      const belongs = classified && belongsToSource(classified.sessionId);
      const stronglyExactUnprojectable = !classified && [...input.knownSessionIds].some((sessionId) => (
        entry.name.startsWith(`${sessionId}.`)
        || entry.name.startsWith(`${sessionId}-topic-`)
        || entry.name.includes(`_${sessionId}.jsonl`)
      ));
      if (!belongs) {
        if (stronglyExactUnprojectable) {
          fail('TRANSCRIPT_ARTIFACT_UNPROJECTABLE', 'Legacy transcript artifact changed to an unknown format');
        }
        if (!input.shared && entry.name.includes('.jsonl')) {
          fail('TRANSCRIPT_ORPHAN', 'Legacy transcript inventory changed to include an unproved artifact');
        }
        continue;
      }
      if (
        !entry.isFile()
        || entry.isSymbolicLink()
        || !['canonical', 'branch-canonical'].includes(classified.artifactClass)
      ) {
        fail('TRANSCRIPT_FILE', 'Legacy transcript artifact changed during inventory');
      }
      let artifactFd: number | null = null;
      try {
        artifactFd = fs.openSync(path.join(anchoredDirectory, entry.name), fileFlags);
        const artifact = fs.fstatSync(artifactFd, { bigint: true });
        if (!artifact.isFile()) fail('TRANSCRIPT_FILE', 'Legacy transcript artifact changed type during inventory');
        finalArtifactFingerprints.set(entry.name, JSON.stringify([
          classified.artifactClass,
          sha256(entry.name),
          artifact.dev.toString(),
          artifact.ino.toString(),
          artifact.mode.toString(),
          artifact.nlink.toString(),
          artifact.size.toString(),
          artifact.mtimeNs.toString(),
          artifact.ctimeNs.toString(),
          artifact.birthtimeNs.toString(),
        ]));
      } finally {
        if (artifactFd != null) fs.closeSync(artifactFd);
      }
    }
    if (
      JSON.stringify([...finalArtifactFingerprints.entries()].sort())
      !== JSON.stringify([...exactArtifactFingerprints.entries()].sort())
    ) {
      fail('TRANSCRIPT_RACE', 'Legacy transcript artifact inventory changed during its anchored scan');
    }
    const finalDirectory = fs.fstatSync(directoryFd, { bigint: true });
    if (
      finalDirectory.dev !== openedDirectory.dev
      || finalDirectory.ino !== openedDirectory.ino
      || finalDirectory.birthtimeNs !== openedDirectory.birthtimeNs
    ) {
      fail('TRANSCRIPT_DIRECTORY', 'Legacy transcript root changed during its anchored inventory');
    }
  } finally {
    if (directoryFd != null) fs.closeSync(directoryFd);
  }
  return { rows: inventory.sort(), canonicalSessionIdCounts };
}

function assertRetiredProofArtifactInventory(
  roots: RetirementRoots,
  proofs: readonly LegacyImportJournalRow[],
): void {
  const byCandidate = new Map<string, LegacyImportJournalRow[]>();
  for (const proof of proofs) {
    if (!legacyProofCandidateIsAttested(proof)) {
      fail('IMPORT_PROOF', 'Retired proof lacked an exact candidate agent inventory locator');
    }
    const group = byCandidate.get(proof.candidateAgentId) || [];
    group.push(proof);
    byCandidate.set(proof.candidateAgentId, group);
  }
  for (const [candidateAgentId, candidateProofs] of byCandidate) {
    const dedicatedProofs = candidateProofs.filter((proof) => proof.sourceAgentId === candidateAgentId);
    const sharedProofs = candidateProofs.filter((proof) => proof.sourceAgentId === 'portal');
    const dedicatedInventory = inventoryLegacyTranscriptDirectory({
      sessionsDir: path.join(roots.openClawHome, 'agents', candidateAgentId, 'sessions'),
      knownSessionIds: new Set(dedicatedProofs.map((proof) => proof.providerSessionId)),
      provedSessionIdHashes: new Set(dedicatedProofs.map((proof) => proof.providerSessionIdHash)),
      shared: false,
    });
    const sharedInventory = sharedProofs.length > 0
      ? inventoryLegacyTranscriptDirectory({
          sessionsDir: path.join(roots.openClawHome, 'agents', 'portal', 'sessions'),
          knownSessionIds: new Set(sharedProofs.map((proof) => proof.providerSessionId)),
          provedSessionIdHashes: new Set(sharedProofs.map((proof) => proof.providerSessionIdHash)),
          shared: true,
        })
      : { rows: [], canonicalSessionIdCounts: new Map<string, number>() };
    const currentFingerprint = sha256(JSON.stringify({
      dedicated: dedicatedInventory.rows,
      shared: sharedInventory.rows,
    }));
    for (const proof of candidateProofs) {
      if (proof.artifactInventoryFingerprint !== currentFingerprint) {
        fail('TRANSCRIPT_RACE', 'Retired legacy transcript artifact inventory changed before recovery completion');
      }
      if (proof.totalMessages > 0) {
        const inventory = proof.sourceAgentId === 'portal' ? sharedInventory : dedicatedInventory;
        const canonicalCount = inventory.canonicalSessionIdCounts.get(proof.providerSessionIdHash) || 0;
        if (canonicalCount !== 1) {
          fail(
            'TRANSCRIPT_ARTIFACT_UNPROJECTABLE',
            'Retired non-empty legacy source lost its exact canonical transcript artifact',
          );
        }
      }
    }
  }
}

function assertNoUnaccountedDedicatedTranscripts(input: {
  roots: RetirementRoots;
  candidates: readonly LegacyProjectCandidate[];
  identities: ReadonlyMap<string, LegacyProjectIdentityRow>;
  sources: readonly LegacyProjectSessionSource[];
  proofs: readonly LegacyImportJournalRow[];
  histories?: readonly LegacyCanonicalHistory[];
}): ReadonlyMap<string, string> {
  const fingerprints = new Map<string, string>();
  for (const candidate of input.candidates) {
    const identity = input.identities.get(candidate.agentId);
    const knownDedicatedSessionIds = new Set([
      ...input.sources
        .filter((source) => source.session.agentId === candidate.agentId)
        .map((source) => source.session.sessionId)
        .filter((value): value is string => Boolean(value)),
      ...input.proofs
        .filter((proof) => (
          identity
          && proof.actorUserId === candidate.userId
          && proof.projectIdentityId === identity.id
          && proof.projectGeneration > 0
          && proof.projectGeneration <= identity.generation
          && proof.candidateAgentId === candidate.agentId
          && proof.candidateAgentHash === sha256(candidate.agentId)
          && proof.sourceAgentId === candidate.agentId
          && proof.sourceAgentHash === sha256(candidate.agentId)
        ))
        .map((proof) => proof.providerSessionId),
    ]);
    const provedDedicatedSessionIdHashes = new Set(
      input.proofs
        .filter((proof) => (
          identity
          && proof.actorUserId === candidate.userId
          && proof.projectIdentityId === identity.id
          && proof.projectGeneration > 0
          && proof.projectGeneration <= identity.generation
          && proof.candidateAgentId === candidate.agentId
          && proof.candidateAgentHash === sha256(candidate.agentId)
          && proof.sourceAgentId === candidate.agentId
          && proof.sourceAgentHash === sha256(candidate.agentId)
        ))
        .map((proof) => proof.providerSessionIdHash)
        .filter((value): value is string => Boolean(value)),
    );
    const knownSharedSessionIds = new Set([
      ...input.sources
        .filter((source) => (
          source.candidate.agentId === candidate.agentId && source.session.agentId === 'portal'
        ))
        .map((source) => source.session.sessionId)
        .filter((value): value is string => Boolean(value)),
      ...input.proofs
        .filter((proof) => (
          identity
          && proof.actorUserId === candidate.userId
          && proof.projectIdentityId === identity.id
          && proof.projectGeneration > 0
          && proof.projectGeneration <= identity.generation
          && proof.candidateAgentId === candidate.agentId
          && proof.candidateAgentHash === sha256(candidate.agentId)
          && proof.sourceAgentId === 'portal'
          && proof.sourceAgentHash === sha256('portal')
        ))
        .map((proof) => proof.providerSessionId),
    ]);
    const provedSharedSessionIdHashes = new Set(
      input.proofs
        .filter((proof) => (
          identity
          && proof.actorUserId === candidate.userId
          && proof.projectIdentityId === identity.id
          && proof.projectGeneration > 0
          && proof.projectGeneration <= identity.generation
          && proof.candidateAgentId === candidate.agentId
          && proof.candidateAgentHash === sha256(candidate.agentId)
          && proof.sourceAgentId === 'portal'
          && proof.sourceAgentHash === sha256('portal')
        ))
        .map((proof) => proof.providerSessionIdHash),
    );
    const dedicatedInventory = inventoryLegacyTranscriptDirectory({
      sessionsDir: path.join(input.roots.openClawHome, 'agents', candidate.agentId, 'sessions'),
      knownSessionIds: knownDedicatedSessionIds,
      provedSessionIdHashes: provedDedicatedSessionIdHashes,
      shared: false,
    });
    const sharedInventory = knownSharedSessionIds.size > 0 || provedSharedSessionIdHashes.size > 0
      ? inventoryLegacyTranscriptDirectory({
          sessionsDir: path.join(input.roots.openClawHome, 'agents', 'portal', 'sessions'),
          knownSessionIds: knownSharedSessionIds,
          provedSessionIdHashes: provedSharedSessionIdHashes,
          shared: true,
        })
      : { rows: [], canonicalSessionIdCounts: new Map<string, number>() };
    for (const history of input.histories || []) {
      const source = input.sources.find((entry) => entry.session.key === history.sessionKey);
      if (!source || source.candidate.agentId !== candidate.agentId || history.totalMessages === 0) continue;
      const inventory = history.agentId === 'portal' ? sharedInventory : dedicatedInventory;
      const canonicalCount = inventory.canonicalSessionIdCounts.get(sha256(history.providerSessionId || '')) || 0;
      if (canonicalCount !== 1) {
        fail(
          'TRANSCRIPT_ARTIFACT_UNPROJECTABLE',
          'Non-empty legacy history did not have exactly one canonical transcript artifact',
        );
      }
    }
    fingerprints.set(candidate.agentId, sha256(JSON.stringify({
      dedicated: dedicatedInventory.rows,
      shared: sharedInventory.rows,
    })));
  }
  return fingerprints;
}

async function recoverAbsentCompletedImportProofs(input: {
  dependencies: LegacyOpenClawProjectRetirementDependencies;
  budget: OperationBudget;
  database: LegacyOpenClawProjectRetirementDatabase;
}): Promise<void> {
  const proofs = await input.database.legacyOpenClawProjectImport.findMany({
    where: {
      sourceStatus: {
        in: [LEGACY_IMPORT_COMPLETE, LEGACY_IMPORT_RETIRED, LEGACY_IMPORT_CLEARED],
      },
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: MAX_IMPORT_RECOVERY_PROOFS + 1,
  });
  if (proofs.length > MAX_IMPORT_RECOVERY_PROOFS) {
    fail('IMPORT_PROOF_LIMIT', 'Legacy import recovery proof inventory exceeded its safety limit');
  }
  for (const proof of proofs) {
    const identity = await input.database.projectIdentity.findUnique({
      where: { id: proof.projectIdentityId },
    });
    if (
      !identity
      || identity.workspaceOwnerId !== proof.actorUserId
      || proof.projectGeneration <= 0
      || proof.projectGeneration > identity.generation
      || !legacyProofCandidateIsAttested(proof)
      || proof.sourceAgentHash !== sha256(proof.sourceAgentId)
      || proof.sessionKeyHash !== sha256(proof.sourceSessionKey)
      || proof.providerSessionIdHash !== sha256(proof.providerSessionId || '')
      || !['DEDICATED', 'SHARED_PORTAL'].includes(proof.sourceKind)
      || (proof.sourceKind === 'SHARED_PORTAL') !== (proof.sourceAgentId === 'portal')
    ) {
      fail('IMPORT_PROOF', 'Legacy import recovery proof was malformed or outside its Project generation');
    }
    const isolateReappearedSource = async (): Promise<void> => {
      await input.dependencies.markAffectedProjectIdentities([{
        id: identity.id,
        actorUserId: proof.actorUserId,
        generation: identity.generation,
      }]);
    };
    const firstReadback = await describeExactLegacySession(
      input.dependencies,
      input.budget,
      proof.sourceAgentId,
      proof.sourceSessionKey,
    );
    if (proof.sourceStatus !== LEGACY_IMPORT_COMPLETE) {
      if (firstReadback) {
        await isolateReappearedSource();
        fail(
          proof.sourceStatus === LEGACY_IMPORT_CLEARED ? 'CLEARED_SOURCE_REAPPEARED' : 'RETIRED_SOURCE_REAPPEARED',
          'A retired legacy source registration reappeared and will not be imported',
        );
      }
      const secondReadback = await describeExactLegacySession(
        input.dependencies,
        input.budget,
        proof.sourceAgentId,
        proof.sourceSessionKey,
      );
      if (secondReadback) {
        await isolateReappearedSource();
        fail(
          proof.sourceStatus === LEGACY_IMPORT_CLEARED ? 'CLEARED_SOURCE_REAPPEARED' : 'RETIRED_SOURCE_REAPPEARED',
          'A retired legacy source registration reappeared during absence verification',
        );
      }
      continue;
    }
    if (firstReadback) continue;
    const currentProof = await input.database.legacyOpenClawProjectImport.findUnique({
      where: {
        actorUserId_sourceAgentHash_sessionKeyHash: {
          actorUserId: proof.actorUserId,
          sourceAgentHash: proof.sourceAgentHash,
          sessionKeyHash: proof.sessionKeyHash,
        },
      },
    });
    if (
      !currentProof
      || currentProof.id !== proof.id
      || currentProof.sourceStatus !== LEGACY_IMPORT_COMPLETE
      || currentProof.candidateAgentId !== proof.candidateAgentId
      || currentProof.candidateAgentHash !== proof.candidateAgentHash
      || currentProof.sourceFingerprint !== proof.sourceFingerprint
      || currentProof.transcriptDigest !== proof.transcriptDigest
      || currentProof.projectionDigest !== proof.projectionDigest
      || currentProof.artifactInventoryFingerprint !== proof.artifactInventoryFingerprint
      || currentProof.agentInventoryFingerprint !== proof.agentInventoryFingerprint
    ) {
      fail('IMPORT_PROOF', 'Legacy import recovery proof changed before retirement readback');
    }
    await assertCommittedProjection(input.database, currentProof);
    const secondReadback = await describeExactLegacySession(
      input.dependencies,
      input.budget,
      proof.sourceAgentId,
      proof.sourceSessionKey,
    );
    if (secondReadback) fail('SESSION_RACE', 'Legacy source reappeared during retirement recovery');
    await input.database.$transaction(async (transaction) => {
      await input.dependencies.assertMutationLeaseInTransaction(transaction);
      const commitProof = await transaction.legacyOpenClawProjectImport.findUnique({
        where: {
          actorUserId_sourceAgentHash_sessionKeyHash: {
            actorUserId: proof.actorUserId,
            sourceAgentHash: proof.sourceAgentHash,
            sessionKeyHash: proof.sessionKeyHash,
          },
        },
      });
      if (
        !commitProof
        || commitProof.id !== currentProof.id
        || commitProof.sourceStatus !== LEGACY_IMPORT_COMPLETE
        || commitProof.candidateAgentId !== currentProof.candidateAgentId
        || commitProof.candidateAgentHash !== currentProof.candidateAgentHash
        || commitProof.sourceFingerprint !== currentProof.sourceFingerprint
        || commitProof.transcriptDigest !== currentProof.transcriptDigest
        || commitProof.projectionDigest !== currentProof.projectionDigest
        || commitProof.artifactInventoryFingerprint !== currentProof.artifactInventoryFingerprint
        || commitProof.agentInventoryFingerprint !== currentProof.agentInventoryFingerprint
      ) {
        fail('IMPORT_PROOF', 'Legacy import recovery proof changed at its retirement commit');
      }
      await assertCommittedProjection(transaction, commitProof);
      await transaction.legacyOpenClawProjectImport.update({
        where: { id: proof.id },
        data: { sourceStatus: LEGACY_IMPORT_RETIRED, retiredAt: new Date() },
      });
    }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 15_000 });
    const finalReadback = await describeExactLegacySession(
      input.dependencies,
      input.budget,
      proof.sourceAgentId,
      proof.sourceSessionKey,
    );
    if (finalReadback) {
      await isolateReappearedSource();
      fail('SESSION_RACE', 'Legacy source reappeared after retirement recovery');
    }
  }
}

interface RecoverablePendingMigration {
  targets: readonly LegacyProjectMigrationTarget[];
  dedicatedAgentIds: ReadonlySet<string>;
  fingerprint: string;
}

async function loadRecoverablePendingMigrations(input: {
  dependencies: LegacyOpenClawProjectRetirementDependencies;
  budget: OperationBudget;
  database: LegacyOpenClawProjectRetirementDatabase;
  roots: RetirementRoots;
  excludeProjectIdentityIds: ReadonlySet<string>;
}): Promise<RecoverablePendingMigration> {
  const identities = await input.database.projectIdentity.findMany({
    where: { legacyOpenClawMigrationStatus: 'PENDING' },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: MAX_LEGACY_AGENTS + 1,
  });
  if (identities.length > MAX_LEGACY_AGENTS) {
    fail('PROJECT_LIMIT', 'Pending legacy Project migration inventory exceeded its safety limit');
  }
  const targets: LegacyProjectMigrationTarget[] = [];
  const dedicatedAgentIds = new Set<string>();
  const fingerprintRows: unknown[] = [];
  for (const identity of identities) {
    if (input.excludeProjectIdentityIds.has(identity.id)) continue;
    if ((identity.lifecycleStatus || 'ACTIVE') !== 'ACTIVE') {
      fail('PROJECT_LIFECYCLE', 'Pending legacy Project identity was no longer active');
    }
    const proofs = await input.database.legacyOpenClawProjectImport.findMany({
      where: {
        actorUserId: identity.workspaceOwnerId,
        projectIdentityId: identity.id,
        projectGeneration: { lte: identity.generation },
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: MAX_IMPORT_RECOVERY_PROOFS + 1,
    });
    if (proofs.length === 0 || proofs.length > MAX_IMPORT_RECOVERY_PROOFS) {
      fail('IMPORT_PROOF', 'Pending legacy Project identity lacked a bounded import proof inventory');
    }
    const allRetired = proofs.every((proof) => proof.sourceStatus === LEGACY_IMPORT_RETIRED);
    const allCleared = proofs.every((proof) => proof.sourceStatus === LEGACY_IMPORT_CLEARED);
    if (!allRetired && !allCleared) {
      fail('IMPORT_PROOF', 'Pending legacy Project identity had a mixed or incomplete proof lifecycle');
    }
    if (allCleared) {
      const clearTombstone = await input.database.legacyOpenClawProjectClearTombstone.findFirst({
        where: {
          actorUserId: identity.workspaceOwnerId,
          projectIdentityId: identity.id,
        },
        select: { id: true },
      });
      if (!clearTombstone) {
        fail('IMPORT_PROOF', 'Cleared legacy Project proofs lacked their permanent privacy tombstone');
      }
    }
    for (const proof of proofs) {
      if (
        ![LEGACY_IMPORT_RETIRED, LEGACY_IMPORT_CLEARED].includes(proof.sourceStatus)
        || proof.actorUserId !== identity.workspaceOwnerId
        || proof.projectIdentityId !== identity.id
        || proof.projectGeneration <= 0
        || proof.projectGeneration > identity.generation
        || !legacyProofCandidateIsAttested(proof)
        || proof.sourceAgentHash !== sha256(proof.sourceAgentId)
        || proof.sessionKeyHash !== sha256(proof.sourceSessionKey)
        || proof.providerSessionIdHash !== sha256(proof.providerSessionId || '')
        || typeof proof.projectionDigest !== 'string'
        || typeof proof.artifactInventoryFingerprint !== 'string'
        || !['DEDICATED', 'SHARED_PORTAL'].includes(proof.sourceKind)
        || (proof.sourceKind === 'SHARED_PORTAL') !== (proof.sourceAgentId === 'portal')
      ) {
        fail('IMPORT_PROOF', 'Pending legacy Project identity had an incomplete or malformed retirement proof');
      }
      if (proof.sourceStatus === LEGACY_IMPORT_CLEARED) {
        await assertClearedProjectionAbsent(input.database, proof);
      } else {
        await assertCommittedProjection(input.database, proof);
      }
      if (await describeExactLegacySession(
        input.dependencies,
        input.budget,
        proof.sourceAgentId,
        proof.sourceSessionKey,
      )) {
        fail('SESSION_RACE', 'A retired legacy source reappeared before Project migration completion');
      }
      if (proof.sourceAgentId !== 'portal') dedicatedAgentIds.add(proof.sourceAgentId);
      fingerprintRows.push([
        identity.id,
        identity.generation,
        proof.projectGeneration,
        proof.id,
        proof.candidateAgentHash,
        proof.sourceAgentHash,
        proof.sessionKeyHash,
        proof.sourceFingerprint,
        proof.artifactInventoryFingerprint,
        proof.agentInventoryFingerprint,
        proof.transcriptDigest,
        proof.projectionDigest,
        proof.retiredAt?.toISOString() || '',
      ]);
    }
    assertRetiredProofArtifactInventory(input.roots, proofs);
    targets.push({
      id: identity.id,
      actorUserId: identity.workspaceOwnerId,
      generation: identity.generation,
    });
  }
  return {
    targets,
    dedicatedAgentIds,
    fingerprint: sha256(JSON.stringify(fingerprintRows.sort())),
  };
}

function legacyMessageRowsBytes(rows: readonly LegacyProjectMessageRow[]): number {
  let bytes = 0;
  for (const row of rows) {
    bytes += Buffer.byteLength(row.content, 'utf8');
    if (bytes > MAX_DATABASE_BYTES_PER_PROJECT) {
      fail('DATABASE_BYTES', 'Legacy Project message rows exceeded the import byte limit');
    }
  }
  return bytes;
}

function rowMatchKey(role: string, content: string): string {
  return `${role}\0${normalizedMessageText(content)}`;
}

interface LegacyMessageRowAlignment {
  rows: readonly LegacyProjectMessageRow[];
  cursor: number;
}

function chooseMatchingLegacyRow(
  message: LegacyHistoryMessage,
  alignment: LegacyMessageRowAlignment,
  used: Set<string>,
): LegacyProjectMessageRow | null {
  const keys = new Set(message.databaseMatchContents.map((content) => rowMatchKey(message.role, content)));
  for (let index = alignment.cursor; index < alignment.rows.length; index += 1) {
    const row = alignment.rows[index];
    if (used.has(row.id) || !keys.has(rowMatchKey(row.role, row.content))) continue;
    // SQL and Gateway writes could fail independently, but surviving matches
    // must form one ordered subsequence. Timestamps establish the SQL order;
    // they must never select a later alternate-content row ahead of an earlier
    // literal occurrence.
    alignment.cursor = index + 1;
    return row;
  }
  return null;
}

function assertImportedMessageMatches(
  row: LegacyProjectMessageRow,
  message: LegacyHistoryMessage,
  identity: LegacyProjectIdentityRow,
  history: LegacyCanonicalHistory,
  sourceKeyHash: string,
  sourceRank: string,
): void {
  if (
    row.userId !== identity.workspaceOwnerId
    || row.projectId !== identity.id
    || row.messageId !== message.deterministicMessageId
    || row.sessionKey !== history.sessionKey
    || row.role !== message.role
    || (message.role === 'user'
      ? !message.databaseMatchContents.some((content) => (
        normalizedMessageText(row.content) === normalizedMessageText(content)
      ))
      : normalizedMessageText(row.content) !== normalizedMessageText(message.content))
    || row.timestamp.getTime() !== message.timestamp.getTime()
    || row.provider !== 'OPENCLAW'
    || row.runtime !== LEGACY_IMPORT_RUNTIME
    || (row.model || null) !== message.model
    || (row.providerSessionId || null) !== history.providerSessionId
    || row.turnId != null
    || row.presentation != null
    || row.sourceOrdinal !== message.ordinal
    || row.sourceKeyHash !== sourceKeyHash
    || row.sourceEventId !== message.sourceId
    || row.sourceEventSeq !== message.sourceSeq
    || row.sourceProjectionIndex !== message.projectionIndex
    || row.sourceFingerprint !== message.sourceFingerprint
    || row.sourceSortKey !== legacySourceSortKey({
      timestamp: message.timestamp,
      sourceRank,
      sourceSeq: message.sourceSeq,
      projectionIndex: message.projectionIndex,
    })
    || row.legacyImportStatus !== LEGACY_IMPORT_IMPORTED
  ) {
    fail('MESSAGE_COLLISION', 'Deterministic legacy message id collided with different data');
  }
}

function legacyAgentInventoryFingerprint(
  histories: readonly LegacyCanonicalHistory[],
  artifactInventoryFingerprint: string,
  retiredProofs: readonly LegacyImportJournalRow[] = [],
): string {
  const inventory = new Map<string, {
    agentId: string;
    sessionKey: string;
    providerSessionId: string | null;
    sourceFingerprint: string;
    transcriptDigest: string;
  }>();
  for (const history of histories) {
    inventory.set(`${history.agentId}\0${history.sessionKey}`, {
      agentId: history.agentId,
      sessionKey: history.sessionKey,
      providerSessionId: history.providerSessionId,
      sourceFingerprint: history.sourceFingerprint,
      transcriptDigest: history.transcriptDigest,
    });
  }
  for (const proof of retiredProofs) {
    const key = `${proof.sourceAgentId}\0${proof.sourceSessionKey}`;
    if (inventory.has(key)) continue;
    inventory.set(key, {
      agentId: proof.sourceAgentId,
      sessionKey: proof.sourceSessionKey,
      providerSessionId: proof.providerSessionId,
      sourceFingerprint: proof.sourceFingerprint,
      transcriptDigest: proof.transcriptDigest,
    });
  }
  return sha256(JSON.stringify({
    artifactInventoryFingerprint,
    histories: [...inventory.values()].sort((left, right) => (
      left.agentId.localeCompare(right.agentId) || left.sessionKey.localeCompare(right.sessionKey)
    )),
  }));
}

async function reconcileLegacyProjectHistories(input: {
  candidate: LegacyProjectCandidate;
  identity: LegacyProjectIdentityRow;
  histories: readonly LegacyCanonicalHistory[];
  artifactInventoryFingerprint: string;
  dependencies: LegacyOpenClawProjectRetirementDependencies;
  database: LegacyOpenClawProjectRetirementDatabase;
}): Promise<number> {
  const orderedHistories = [...input.histories].sort((left, right) => (
    (left.messages[0]?.timestamp.getTime() ?? Number.MAX_SAFE_INTEGER)
      - (right.messages[0]?.timestamp.getTime() ?? Number.MAX_SAFE_INTEGER)
    || left.sessionKey.localeCompare(right.sessionKey)
  ));
  for (let index = 1; index < orderedHistories.length; index += 1) {
    const previous = orderedHistories[index - 1];
    const current = orderedHistories[index];
    const previousEnd = previous.messages.at(-1)?.timestamp.getTime();
    const currentStart = current.messages[0]?.timestamp.getTime();
    if (previousEnd !== undefined && currentStart !== undefined && previousEnd >= currentStart) {
      fail(
        'HISTORY_ALIGNMENT_AMBIGUOUS',
        'Legacy session timelines overlapped and could not be reconciled as one ordered SQL projection',
      );
    }
  }
  const legacyProjectIds = Array.from(new Set([
    input.candidate.projectName,
    input.identity.projectName,
    input.identity.lastRenameSourceName || '',
  ].filter(Boolean)));
  assertLegacyCandidateRootUnchanged(input.candidate);
  const importedMessages = await input.database.$transaction(async (transaction) => {
    await input.dependencies.assertMutationLeaseInTransaction(transaction);
    const commitIdentity = await transaction.projectIdentity.findUnique({
      where: { id: input.identity.id },
    });
    if (
      !commitIdentity
      || commitIdentity.workspaceOwnerId !== input.candidate.userId
      || commitIdentity.generation !== input.identity.generation
      || (commitIdentity.lifecycleStatus || 'ACTIVE') !== 'ACTIVE'
      || commitIdentity.legacyOpenClawMigrationStatus !== 'PENDING'
      || commitIdentity.canonicalRoot !== input.candidate.canonicalRoot
      || commitIdentity.rootDevice !== input.candidate.rootDevice
      || commitIdentity.rootInode !== input.candidate.rootInode
      || commitIdentity.rootBirthtimeNs !== input.candidate.rootBirthtimeNs
    ) {
      fail('PROJECT_MIGRATION_STATE', 'Project identity changed before legacy history reconciliation committed');
    }
    // Portal 4.0 preview builds could already have native-provider rows under
    // the old name-keyed namespace. They are not OpenClaw transcript residue:
    // retarget them intact instead of feeding them to reconciliation/quarantine.
    await transaction.projectChatMessage.updateMany({
      where: {
        userId: input.candidate.userId,
        projectId: { in: legacyProjectIds },
        NOT: {
          provider: 'OPENCLAW',
          runtime: LEGACY_IMPORT_RUNTIME,
        },
      },
      data: { projectId: input.identity.id },
    });
    const existingRows = await transaction.projectChatMessage.findMany({
      where: {
        userId: input.candidate.userId,
        OR: [
          {
            projectId: { in: legacyProjectIds },
            provider: 'OPENCLAW',
            runtime: LEGACY_IMPORT_RUNTIME,
          },
          {
            projectId: input.identity.id,
            provider: 'OPENCLAW',
            runtime: LEGACY_IMPORT_RUNTIME,
            OR: [
              { messageId: null },
              { messageId: { startsWith: LEGACY_IMPORT_MESSAGE_PREFIX } },
            ],
          },
        ],
      },
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      take: MAX_DATABASE_ROWS_PER_PROJECT + 1,
    });
    if (existingRows.length > MAX_DATABASE_ROWS_PER_PROJECT) {
      fail('DATABASE_ROWS', 'Legacy Project message rows exceeded the import row limit');
    }
    if (existingRows.some((row) => row.turnId != null)) {
      fail('DATABASE_ROW_LIFECYCLE', 'Legacy SQL residue was still attached to a durable Project Chat turn');
    }
    legacyMessageRowsBytes(existingRows);
    const used = new Set<string>();
    const rowAlignment: LegacyMessageRowAlignment = { rows: existingRows, cursor: 0 };
    let importedMessages = 0;
    const retiredProofs = await transaction.legacyOpenClawProjectImport.findMany({
      where: {
        actorUserId: input.candidate.userId,
        projectIdentityId: input.identity.id,
        projectGeneration: { lte: input.identity.generation },
        sourceStatus: LEGACY_IMPORT_RETIRED,
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: MAX_IMPORT_RECOVERY_PROOFS + 1,
    });
    if (retiredProofs.length > MAX_IMPORT_RECOVERY_PROOFS) {
      fail('IMPORT_PROOF_LIMIT', 'Retired legacy source proof inventory exceeded its safety limit');
    }
    const agentInventoryFingerprint = legacyAgentInventoryFingerprint(
      orderedHistories,
      input.artifactInventoryFingerprint,
      retiredProofs,
    );
    for (const proof of retiredProofs) {
      if (
        proof.actorUserId !== input.candidate.userId
        || proof.projectIdentityId !== input.identity.id
        || proof.projectGeneration <= 0
        || proof.projectGeneration > input.identity.generation
        || !legacyProofCandidateIsAttested(proof)
        || proof.candidateAgentId !== input.candidate.agentId
        || proof.sourceAgentHash !== sha256(proof.sourceAgentId)
        || proof.sessionKeyHash !== sha256(proof.sourceSessionKey)
        || proof.providerSessionIdHash !== sha256(proof.providerSessionId || '')
      ) {
        fail('IMPORT_PROOF', 'Retired legacy source proof changed before reconciliation');
      }
      const sourceRows = existingRows.filter((row) => (
        row.legacyImportStatus === LEGACY_IMPORT_IMPORTED
        && row.sourceKeyHash === proof.sessionKeyHash
        && row.sessionKey === proof.sourceSessionKey
      ));
      assertProjectionRowsMatchProof(sourceRows, proof);
      for (const row of sourceRows) used.add(row.id);
    }
    for (const history of orderedHistories) {
      const sourceKeyHash = sha256(history.sessionKey);
      const sourceRank = sourceKeyHash;
      const sourceKind = history.agentId === 'portal' ? 'SHARED_PORTAL' : 'DEDICATED';
      const projectedRows: LegacyProjectMessageRow[] = [];
      const existingJournal = await transaction.legacyOpenClawProjectImport.findUnique({
        where: {
          actorUserId_sourceAgentHash_sessionKeyHash: {
            actorUserId: input.candidate.userId,
            sourceAgentHash: sha256(history.agentId),
            sessionKeyHash: sourceKeyHash,
          },
        },
      });
      if (existingJournal && (
        existingJournal.actorUserId !== input.candidate.userId
        || existingJournal.projectIdentityId !== input.identity.id
        || existingJournal.projectGeneration !== input.identity.generation
        || existingJournal.candidateAgentId !== input.candidate.agentId
        || existingJournal.candidateAgentHash !== sha256(input.candidate.agentId)
        || existingJournal.sourceAgentId !== history.agentId
        || existingJournal.sourceAgentHash !== sha256(history.agentId)
        || existingJournal.sourceSessionKey !== history.sessionKey
        || existingJournal.sourceKind !== sourceKind
        || existingJournal.providerSessionId !== history.providerSessionId
        || existingJournal.providerSessionIdHash !== sha256(history.providerSessionId || '')
        || existingJournal.transcriptDigest !== history.transcriptDigest
        || existingJournal.sourceFingerprint !== history.sourceFingerprint
        || existingJournal.artifactInventoryFingerprint !== input.artifactInventoryFingerprint
        || existingJournal.agentInventoryFingerprint !== agentInventoryFingerprint
        || existingJournal.totalMessages !== history.totalMessages
        || existingJournal.importedMessages !== history.messages.length
        || typeof existingJournal.projectionDigest !== 'string'
      )) {
        fail('IMPORT_JOURNAL_COLLISION', 'Legacy import proof collided with a changed source');
      }
      for (const message of history.messages) {
        const deterministic = existingRows.find((row) => row.messageId === message.deterministicMessageId)
          || await transaction.projectChatMessage.findUnique({
            where: {
              userId_projectId_messageId: {
                userId: input.candidate.userId,
                projectId: input.identity.id,
                messageId: message.deterministicMessageId,
              },
            },
        });
        if (deterministic) {
          assertImportedMessageMatches(
            deterministic,
            message,
            input.identity,
            history,
            sourceKeyHash,
            sourceRank,
          );
          used.add(deterministic.id);
          projectedRows.push(deterministic);
          importedMessages += 1;
          continue;
        }
        const matched = chooseMatchingLegacyRow(message, rowAlignment, used);
        // A role+exact-content match is the only trustworthy record of the
        // pre-transport user payload. Prefer it for model-switch-prefixed turns;
        // unmatched Gateway text remains unchanged to avoid stripping a literal
        // user-authored prefix.
        const content = matched?.role === 'user' ? matched.content : message.content;
        const sourceSortKey = legacySourceSortKey({
          timestamp: message.timestamp,
          sourceRank,
          sourceSeq: message.sourceSeq,
          projectionIndex: message.projectionIndex,
        });
        if (matched) {
          used.add(matched.id);
          const updated = await transaction.projectChatMessage.update({
            where: { id: matched.id },
            data: {
              projectId: input.identity.id,
              sessionKey: history.sessionKey,
              role: message.role,
              content,
              timestamp: message.timestamp,
              messageId: message.deterministicMessageId,
              provider: 'OPENCLAW',
              runtime: LEGACY_IMPORT_RUNTIME,
              model: message.model,
              providerSessionId: history.providerSessionId,
              turnId: null,
              presentation: null,
              sourceOrdinal: message.ordinal,
              sourceKeyHash,
              sourceEventId: message.sourceId,
              sourceEventSeq: message.sourceSeq,
              sourceProjectionIndex: message.projectionIndex,
              sourceFingerprint: message.sourceFingerprint,
              sourceSortKey,
              legacyImportStatus: LEGACY_IMPORT_IMPORTED,
            },
          });
          projectedRows.push(updated);
        } else {
          const created = await transaction.projectChatMessage.create({
            data: {
              projectId: input.identity.id,
              userId: input.candidate.userId,
              sessionKey: history.sessionKey,
              role: message.role,
              content,
              timestamp: message.timestamp,
              messageId: message.deterministicMessageId,
              provider: 'OPENCLAW',
              runtime: LEGACY_IMPORT_RUNTIME,
              model: message.model,
              providerSessionId: history.providerSessionId,
              turnId: null,
              presentation: null,
              sourceOrdinal: message.ordinal,
              sourceKeyHash,
              sourceEventId: message.sourceId,
              sourceEventSeq: message.sourceSeq,
              sourceProjectionIndex: message.projectionIndex,
              sourceFingerprint: message.sourceFingerprint,
              sourceSortKey,
              legacyImportStatus: LEGACY_IMPORT_IMPORTED,
            },
          });
          projectedRows.push(created);
        }
        importedMessages += 1;
      }
      const projectionDigest = legacyImportedProjectionDigest(projectedRows);
      if (existingJournal && existingJournal.projectionDigest !== projectionDigest) {
        fail('IMPORT_JOURNAL_COLLISION', 'Legacy import proof collided with a changed message projection');
      }
      const journalData = {
        actorUserId: input.candidate.userId,
        projectIdentityId: input.identity.id,
        projectGeneration: input.identity.generation,
        candidateAgentId: input.candidate.agentId,
        candidateAgentHash: sha256(input.candidate.agentId),
        sourceAgentId: history.agentId,
        sourceAgentHash: sha256(history.agentId),
        sourceSessionKey: history.sessionKey,
        sessionKeyHash: sourceKeyHash,
        sourceKind,
        sourceStatus: existingJournal?.sourceStatus === LEGACY_IMPORT_RETIRED
          ? LEGACY_IMPORT_RETIRED
          : LEGACY_IMPORT_COMPLETE,
        providerSessionId: history.providerSessionId,
        providerSessionIdHash: sha256(history.providerSessionId || ''),
        sourceFingerprint: history.sourceFingerprint,
        artifactInventoryFingerprint: input.artifactInventoryFingerprint,
        agentInventoryFingerprint,
        totalMessages: history.totalMessages,
        importedMessages: history.messages.length,
        transcriptDigest: history.transcriptDigest,
        projectionDigest,
        completedAt: existingJournal?.completedAt || new Date(),
      };
      if (existingJournal) {
        await transaction.legacyOpenClawProjectImport.update({
          where: { id: existingJournal.id },
          data: journalData,
        });
      } else {
        await transaction.legacyOpenClawProjectImport.create({ data: journalData });
      }
    }
    const quarantineRows = existingRows
      .filter((row) => !used.has(row.id))
      .filter((row) => (
        legacyProjectIds.includes(row.projectId)
        || row.messageId === null
        || row.messageId.startsWith(LEGACY_IMPORT_MESSAGE_PREFIX)
      ));
    for (const row of quarantineRows) {
      const payloadDigest = sha256(JSON.stringify({
        originalMessageId: row.id,
        actorUserId: input.candidate.userId,
        projectIdentityId: input.identity.id,
        projectGeneration: input.identity.generation,
        originalProjectId: row.projectId,
        sessionKey: row.sessionKey,
        role: row.role,
        content: row.content,
        timestamp: row.timestamp.toISOString(),
        messageId: row.messageId,
        provider: row.provider,
        runtime: row.runtime,
        model: row.model,
        providerSessionId: row.providerSessionId,
        reason: LEGACY_QUARANTINE_REASON,
      }));
      const existingQuarantine = await transaction.legacyOpenClawProjectQuarantine.findUnique({
        where: { originalMessageId: row.id },
      });
      if (existingQuarantine) {
        if (
          existingQuarantine.payloadDigest !== payloadDigest
          || existingQuarantine.actorUserId !== input.candidate.userId
          || existingQuarantine.projectIdentityId !== input.identity.id
          || existingQuarantine.projectGeneration !== input.identity.generation
          || existingQuarantine.reason !== LEGACY_QUARANTINE_REASON
        ) {
          fail('QUARANTINE_COLLISION', 'Legacy SQL quarantine collided with different provenance');
        }
      } else {
        await transaction.legacyOpenClawProjectQuarantine.create({
          data: {
            originalMessageId: row.id,
            actorUserId: input.candidate.userId,
            projectIdentityId: input.identity.id,
            projectGeneration: input.identity.generation,
            originalProjectId: row.projectId,
            sessionKey: row.sessionKey,
            role: row.role,
            content: row.content,
            timestamp: row.timestamp,
            messageId: row.messageId,
            provider: row.provider,
            runtime: row.runtime,
            model: row.model,
            providerSessionId: row.providerSessionId,
            reason: LEGACY_QUARANTINE_REASON,
            payloadDigest,
          },
        });
      }
    }
    if (quarantineRows.length > 0) {
      const deleted = await transaction.projectChatMessage.deleteMany({
        where: { id: { in: quarantineRows.map((row) => row.id) } },
      });
      if (deleted.count !== quarantineRows.length) {
        fail('QUARANTINE_RACE', 'Legacy SQL rows changed during quarantine');
      }
    }
    assertLegacyCandidateRootUnchanged(input.candidate);
    return importedMessages;
  }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 });
  assertLegacyCandidateRootUnchanged(input.candidate);
  return importedMessages;
}

async function importLegacyProjectHistories(input: {
  candidates: readonly LegacyProjectCandidate[];
  identities: ReadonlyMap<string, LegacyProjectIdentityRow>;
  sources: readonly LegacyProjectSessionSource[];
  dependencies: LegacyOpenClawProjectRetirementDependencies;
  database: LegacyOpenClawProjectRetirementDatabase;
  budget: OperationBudget;
  artifactInventoryFingerprints: ReadonlyMap<string, string>;
}): Promise<LegacyImportSummary> {
  const histories: Array<{ source: LegacyProjectSessionSource; history: LegacyCanonicalHistory }> = [];
  let totalHistoryBytes = 0;
  let totalHistoryRows = 0;
  for (const source of input.sources) {
    const history = await readStableCanonicalHistory({
      source,
      dependencies: input.dependencies,
      budget: input.budget,
    });
    totalHistoryBytes += history.serializedBytes;
    totalHistoryRows += history.totalMessages;
    if (totalHistoryBytes > MAX_HISTORY_BYTES_TOTAL) fail('HISTORY_BYTES', 'Legacy histories exceeded the total byte limit');
    if (totalHistoryRows > MAX_HISTORY_ROWS_TOTAL) fail('HISTORY_LIMIT', 'Legacy histories exceeded the total row limit');
    histories.push({ source, history });
  }
  let messagesImported = 0;
  const identityOwners = new Map<string, string>();
  for (const candidate of input.candidates) {
    const identity = input.identities.get(candidate.agentId);
    if (!identity) fail('PROJECT_IDENTITY', 'Legacy Project import lost its immutable identity');
    const priorAgent = identityOwners.get(identity.id);
    if (priorAgent && priorAgent !== candidate.agentId) {
      fail('PROJECT_SOURCE_AMBIGUOUS', 'Multiple legacy agents mapped to one immutable Project identity');
    }
    identityOwners.set(identity.id, candidate.agentId);
  }
  for (const candidate of input.candidates) {
    const projectHistories = histories
      .filter((entry) => entry.source.candidate.agentId === candidate.agentId)
      .map((entry) => entry.history);
    const identity = input.identities.get(candidate.agentId);
    if (!identity) fail('PROJECT_IDENTITY', 'Legacy Project import lost its immutable identity');
    messagesImported += await reconcileLegacyProjectHistories({
      candidate,
      identity,
      histories: projectHistories,
      artifactInventoryFingerprint: input.artifactInventoryFingerprints.get(candidate.agentId) || sha256('[]'),
      dependencies: input.dependencies,
      database: input.database,
    });
  }
  return {
    canonicalSessionsImported: histories.length,
    messagesImported,
    sessions: Object.freeze(histories.map((entry) => entry.history)),
    artifactInventoryFingerprints: input.artifactInventoryFingerprints,
  };
}

function isNotFoundError(error: unknown): boolean {
  return /not found|no such|unknown agent/i.test(String(error || ''));
}

async function deleteLegacySession(
  dependencies: LegacyOpenClawProjectRetirementDependencies,
  budget: OperationBudget,
  session: LegacySessionCandidate,
): Promise<boolean> {
  // sessions.delete owns the Gateway lifecycle barrier and active-run
  // convergence. A separate chat.abort would mutate updatedAt and invalidate
  // the exact CAS snapshot supplied below.
  const params: Record<string, any> = {
    key: session.key,
    agentId: session.agentId,
    // Registration retirement must never be the transcript-retention boundary.
    // Imported source files remain recoverable until a later, separately
    // attested garbage-collection policy exists.
    deleteTranscript: false,
  };
  if (session.sessionId) params.expectedSessionId = session.sessionId;
  if (session.lifecycleRevision) params.expectedLifecycleRevision = session.lifecycleRevision;
  if (session.updatedAt !== undefined) params.expectedSessionUpdatedAt = session.updatedAt;
  await dependencies.assertMutationLease();
  const deleted = await boundedRpc(
    dependencies,
    budget,
    'sessions.delete',
    params,
    MUTATION_RPC_TIMEOUT_MS,
  );
  if (!deleted.ok && !isNotFoundError(deleted.error)) {
    fail('SESSION_DELETE', `OpenClaw session ${session.key} could not be deleted`);
  }
  return deleted.ok;
}

async function retireLegacySessions(
  dependencies: LegacyOpenClawProjectRetirementDependencies,
  budget: OperationBudget,
  database: LegacyOpenClawProjectRetirementDatabase,
  sources: readonly LegacyProjectSessionSource[],
  histories: readonly LegacyCanonicalHistory[],
  artifactInventoryFingerprints: ReadonlyMap<string, string>,
): Promise<number> {
  let retired = 0;
  const sourceByKey = new Map(sources.map((source) => [source.session.key, source]));
  const historyByKey = new Map(histories.map((history) => [history.sessionKey, history]));
  for (const key of [...sourceByKey.keys()].sort()) {
    const source = sourceByKey.get(key)!;
    const history = historyByKey.get(key);
    if (!history) fail('IMPORT_PROOF', 'Legacy session had no committed import snapshot');
    const candidateHistories = histories.filter((candidateHistory) => (
      sourceByKey.get(candidateHistory.sessionKey)?.candidate.agentId === source.candidate.agentId
    ));
    const retiredProofs = await database.legacyOpenClawProjectImport.findMany({
      where: {
        actorUserId: source.candidate.userId,
        projectIdentityId: source.identity.id,
        projectGeneration: source.identity.generation,
        sourceStatus: LEGACY_IMPORT_RETIRED,
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: MAX_IMPORT_RECOVERY_PROOFS + 1,
    });
    if (retiredProofs.length > MAX_IMPORT_RECOVERY_PROOFS) {
      fail('IMPORT_PROOF_LIMIT', 'Retired legacy source proof inventory exceeded its safety limit');
    }
    for (const retiredProof of retiredProofs) {
      if (
        retiredProof.actorUserId !== source.candidate.userId
        || retiredProof.projectIdentityId !== source.identity.id
        || retiredProof.projectGeneration !== source.identity.generation
        || !legacyProofCandidateIsAttested(retiredProof)
        || retiredProof.candidateAgentId !== source.candidate.agentId
        || retiredProof.sourceAgentHash !== sha256(retiredProof.sourceAgentId)
        || retiredProof.sessionKeyHash !== sha256(retiredProof.sourceSessionKey)
        || retiredProof.providerSessionIdHash !== sha256(retiredProof.providerSessionId)
        || !['DEDICATED', 'SHARED_PORTAL'].includes(retiredProof.sourceKind)
        || (retiredProof.sourceKind === 'SHARED_PORTAL') !== (retiredProof.sourceAgentId === 'portal')
      ) {
        fail('IMPORT_PROOF', 'Retired legacy source proof inventory was malformed');
      }
    }
    const agentInventoryFingerprint = legacyAgentInventoryFingerprint(
      candidateHistories,
      artifactInventoryFingerprints.get(source.candidate.agentId) || sha256('[]'),
      retiredProofs,
    );
    const sessionKeyHash = sha256(key);
    const proof = await database.legacyOpenClawProjectImport.findUnique({
      where: {
        actorUserId_sourceAgentHash_sessionKeyHash: {
          actorUserId: source.candidate.userId,
          sourceAgentHash: sha256(history.agentId),
          sessionKeyHash,
        },
      },
    });
    if (!proof || (
      ![LEGACY_IMPORT_COMPLETE, LEGACY_IMPORT_RETIRED].includes(proof.sourceStatus)
      || proof.projectGeneration !== source.identity.generation
      || !legacyProofCandidateIsAttested(proof)
      || proof.candidateAgentId !== source.candidate.agentId
      || proof.sourceAgentId !== history.agentId
      || proof.sourceAgentHash !== sha256(history.agentId)
      || proof.sourceSessionKey !== history.sessionKey
      || proof.sessionKeyHash !== sessionKeyHash
      || proof.sourceKind !== (history.agentId === 'portal' ? 'SHARED_PORTAL' : 'DEDICATED')
      || proof.providerSessionId !== history.providerSessionId
      || proof.providerSessionIdHash !== sha256(history.providerSessionId || '')
      || proof.sourceFingerprint !== history.sourceFingerprint
      || proof.artifactInventoryFingerprint
        !== (artifactInventoryFingerprints.get(source.candidate.agentId) || sha256('[]'))
      || proof.agentInventoryFingerprint !== agentInventoryFingerprint
      || proof.transcriptDigest !== history.transcriptDigest
      || typeof proof.projectionDigest !== 'string'
      || proof.totalMessages !== history.totalMessages
      || proof.importedMessages !== history.messages.length
    )) {
      fail('IMPORT_PROOF', 'Legacy session import proof was incomplete or stale');
    }
    await assertCommittedProjection(database, proof);
    const current = await describeExactLegacySession(
      dependencies,
      budget,
      history.agentId,
      history.sessionKey,
    );
    if (current && descriptionFingerprint(current) !== history.sourceFingerprint) {
      fail('SESSION_RACE', 'Legacy session changed after its import proof committed');
    }
    if (current && proof.sourceStatus === LEGACY_IMPORT_RETIRED) {
      fail('SESSION_RACE', 'A retired legacy session registration reappeared');
    }
    if (current && await deleteLegacySession(dependencies, budget, current)) retired += 1;
    const residue = await describeExactLegacySession(
      dependencies,
      budget,
      history.agentId,
      history.sessionKey,
    );
    if (residue) fail('SESSION_RESIDUE', 'Legacy session remained after registration retirement');
    if (proof.sourceStatus !== LEGACY_IMPORT_RETIRED || !proof.retiredAt) {
      await database.$transaction(async (transaction) => {
        await dependencies.assertMutationLeaseInTransaction(transaction);
        const commitProof = await transaction.legacyOpenClawProjectImport.findUnique({
          where: {
            actorUserId_sourceAgentHash_sessionKeyHash: {
              actorUserId: proof.actorUserId,
              sourceAgentHash: proof.sourceAgentHash,
              sessionKeyHash: proof.sessionKeyHash,
            },
          },
        });
        if (!commitProof || commitProof.id !== proof.id || commitProof.sourceStatus !== LEGACY_IMPORT_COMPLETE) {
          fail('IMPORT_PROOF', 'Legacy session proof changed at its retirement commit');
        }
        await assertCommittedProjection(transaction, commitProof);
        await transaction.legacyOpenClawProjectImport.update({
          where: { id: proof.id },
          data: {
            sourceStatus: LEGACY_IMPORT_RETIRED,
            retiredAt: new Date(),
          },
        });
      }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 15_000 });
    }
  }
  return retired;
}

async function assertLegacyContainerImportProof(input: {
  container: LegacyContainerCandidate;
  candidate: LegacyProjectCandidate;
  identity: LegacyProjectIdentityRow;
  sources: readonly LegacyProjectSessionSource[];
  histories: readonly LegacyCanonicalHistory[];
  artifactInventoryFingerprint: string;
  database: LegacyOpenClawProjectRetirementDatabase;
}): Promise<void> {
  const retiredProofs = await input.database.legacyOpenClawProjectImport.findMany({
    where: {
      actorUserId: input.candidate.userId,
      projectIdentityId: input.identity.id,
      projectGeneration: input.identity.generation,
      sourceStatus: LEGACY_IMPORT_RETIRED,
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: MAX_IMPORT_RECOVERY_PROOFS + 1,
  });
  if (retiredProofs.length > MAX_IMPORT_RECOVERY_PROOFS) {
    fail('IMPORT_PROOF_LIMIT', 'Container retirement proof inventory exceeded its safety limit');
  }
  for (const proof of retiredProofs) {
    if (
      proof.actorUserId !== input.candidate.userId
      || proof.projectIdentityId !== input.identity.id
      || proof.projectGeneration !== input.identity.generation
      || !legacyProofCandidateIsAttested(proof)
      || proof.candidateAgentId !== input.candidate.agentId
      || proof.sourceAgentHash !== sha256(proof.sourceAgentId)
      || proof.sessionKeyHash !== sha256(proof.sourceSessionKey)
      || proof.providerSessionIdHash !== sha256(proof.providerSessionId)
      || typeof proof.projectionDigest !== 'string'
      || !['DEDICATED', 'SHARED_PORTAL'].includes(proof.sourceKind)
    ) {
      fail('IMPORT_PROOF', 'Container retirement proof inventory was malformed');
    }
  }
  const candidateHistories = input.histories.filter((history) => (
    input.sources.find((source) => source.session.key === history.sessionKey)?.candidate.agentId
      === input.candidate.agentId
  ));
  const expectedInventoryFingerprint = legacyAgentInventoryFingerprint(
    candidateHistories,
    input.artifactInventoryFingerprint,
    retiredProofs,
  );
  const proof = retiredProofs.find((entry) => (
    entry.sourceAgentId === input.container.agentId
    && entry.sourceSessionKey === input.container.sessionKey
  ));
  if (
    !proof
    || proof.sourceKind !== 'DEDICATED'
    || !legacyProofCandidateIsAttested(proof)
    || proof.candidateAgentId !== input.candidate.agentId
    || proof.sourceAgentHash !== sha256(input.container.agentId)
    || proof.sessionKeyHash !== sha256(input.container.sessionKey)
    || proof.artifactInventoryFingerprint !== input.artifactInventoryFingerprint
    || proof.agentInventoryFingerprint !== expectedInventoryFingerprint
  ) {
    fail('IMPORT_PROOF', 'Legacy container had no exact retired transcript inventory proof');
  }
  await assertCommittedProjection(input.database, proof);
}

async function removeLegacyContainer(
  dependencies: LegacyOpenClawProjectRetirementDependencies,
  budget: OperationBudget,
  roots: RetirementRoots,
  expected: LegacyContainerCandidate,
): Promise<boolean> {
  let inspect = await inspectContainer(dependencies, budget, expected.containerId);
  if (!inspect) return false;
  let current = attestLegacyContainer(inspect, roots);
  if (!current || current.fingerprint !== expected.fingerprint) {
    fail('CONTAINER_RACE', `Legacy Project container ${expected.containerId} changed before retirement`);
  }

  await dependencies.assertMutationLease();
  const stopped = await dockerCall(dependencies, budget, [
    'container', 'stop', '--time', '3', expected.containerId,
  ]);
  if (stopped.exitCode !== 0 && stopped.exitCode !== 1) {
    fail('CONTAINER_STOP', `Legacy Project container ${expected.containerId} could not be stopped`);
  }
  inspect = await inspectContainer(dependencies, budget, expected.containerId);
  if (!inspect) return true;
  current = attestLegacyContainer(inspect, roots);
  if (!current || current.fingerprint !== expected.fingerprint || inspect.State?.Running === true) {
    fail('CONTAINER_STOP', `Legacy Project container ${expected.containerId} did not stop with its attestation intact`);
  }

  await dependencies.assertMutationLease();
  const removed = await dockerCall(dependencies, budget, ['container', 'rm', expected.containerId]);
  if (removed.exitCode !== 0 && removed.exitCode !== 1) {
    fail('CONTAINER_REMOVE', `Legacy Project container ${expected.containerId} could not be removed`);
  }
  if (await inspectContainer(dependencies, budget, expected.containerId)) {
    fail('CONTAINER_RESIDUE', `Legacy Project container ${expected.containerId} remained after removal`);
  }
  return true;
}

async function retireConfiguredAgents(
  dependencies: LegacyOpenClawProjectRetirementDependencies,
  budget: OperationBudget,
  roots: RetirementRoots,
  expectedAgents: LegacyAgentCandidate[],
): Promise<number> {
  const trustedIds = new Set(expectedAgents.map((candidate) => candidate.agentId));
  const retired = 0;
  for (const expected of [...expectedAgents].sort((left, right) => left.agentId.localeCompare(right.agentId))) {
    const snapshot = parseConfigRpc(await boundedRpc(
      dependencies,
      budget,
      'config.get',
      {},
      CONFIG_RPC_TIMEOUT_MS,
    ));
    const candidates = discoverLegacyOpenClawProjectAgents(snapshot, roots);
    if (candidates.some((candidate) => !trustedIds.has(candidate.agentId))) {
      fail('CONFIG_RACE', 'A new legacy Project agent appeared during retirement');
    }
    const current = candidates.find((candidate) => candidate.agentId === expected.agentId);
    if (!current) continue;
    if (candidateSignature(current) !== candidateSignature(expected)) {
      fail('CONFIG_RACE', `Legacy Project agent ${expected.agentId} changed before deletion`);
    }
    // Re-list active and archived sessions at the final mutation boundary. A
    // direct Gateway client can create a new source after the import snapshot;
    // deleting the agent registration in that state would orphan unproved
    // history even though deleteFiles remains false.
    if ((await listLegacySessions(dependencies, budget, new Set([expected.agentId]))).length > 0) {
      fail('SESSION_RACE', 'A legacy session appeared after the import inventory was retired');
    }
    // OpenClaw 2026.7.1 has no atomic no-new-session fence. agents.delete
    // purges the session store even with deleteFiles:false, while config.patch
    // CASes only the disk config and does not fence already-admitted sends.
    // Preserve the registration and every transcript rather than convert a
    // late session into a configless orphan. A future Gateway retirement CAS
    // can replace this fail-closed gate.
    fail(
      'AGENT_RETIREMENT_FENCE_UNAVAILABLE',
      'OpenClaw cannot yet prove quiescent legacy agent retirement without risking late transcript loss',
    );
  }
  return retired;
}

async function verifyClean(
  dependencies: LegacyOpenClawProjectRetirementDependencies,
  budget: OperationBudget,
  roots: RetirementRoots,
  trustedAgentIds: Set<string>,
): Promise<void> {
  const localConfig = await dependencies.readConfig(roots.openClawConfigPath);
  if (localConfig) {
    const localResidue = discoverLegacyOpenClawProjectAgents(localConfig, roots);
    if (localResidue.length > 0) fail('CONFIG_RESIDUE', 'Legacy Project agents remained in the local OpenClaw config');
  }
  const gatewayConfig = parseConfigRpc(await boundedRpc(
    dependencies,
    budget,
    'config.get',
    {},
    CONFIG_RPC_TIMEOUT_MS,
  ));
  if (discoverLegacyOpenClawProjectAgents(gatewayConfig, roots).length > 0) {
    fail('CONFIG_RESIDUE', 'Legacy Project agents remained in the Gateway config');
  }
  if ((await listLegacySessions(dependencies, budget, trustedAgentIds)).length > 0) {
    fail('SESSION_RESIDUE', 'Legacy Project sessions remained after retirement');
  }
  if ((await discoverLegacyContainers(dependencies, budget, roots)).length > 0) {
    fail('CONTAINER_RESIDUE', 'Legacy Project containers remained after retirement');
  }
}

/**
 * Dormant destructive implementation retained for a future Gateway version
 * with the missing retirement primitives. Portal runtime code reaches it only
 * through the literal-false release branch in the safe wrapper below. Project
 * source data is never removed by this release path.
 */
async function retireLegacyOpenClawProjectAgentsDestructively(
  options: LegacyOpenClawProjectRetirementOptions = {},
): Promise<LegacyOpenClawProjectRetirementResult> {
  const roots = buildRoots(options);
  const dependencies = { ...defaultDependencies, ...(options.dependencies || {}) };
  const database = options.database || prisma as unknown as LegacyOpenClawProjectRetirementDatabase;
  const budget: OperationBudget = { rpcCalls: 0, dockerCalls: 0 };
  const empty: LegacyOpenClawProjectRetirementResult = {
    candidatesFound: 0,
    canonicalSessionsImported: 0,
    messagesImported: 0,
    configuredAgentsRetired: 0,
    sessionsRetired: 0,
    containersRetired: 0,
  };

  const localConfig = await dependencies.readConfig(roots.openClawConfigPath);
  const localAgents = localConfig
    ? discoverLegacyOpenClawProjectAgents(localConfig, roots)
    : [];

  // The local file is useful cross-check evidence, but the running Gateway is
  // authoritative. Always inspect it before deciding that this host is clean:
  // the file can be missing, stale, or point at a different OpenClaw profile.
  const gatewayConfig = parseConfigRpc(await boundedRpc(
    dependencies,
    budget,
    'config.get',
    {},
    CONFIG_RPC_TIMEOUT_MS,
  ));
  const gatewayAgents = discoverLegacyOpenClawProjectAgents(gatewayConfig, roots);

  // Recover the narrow crash boundary where an exact session registration was
  // removed after import committed but before its RETIRED marker committed.
  // This runs even when no legacy config/container remains, and it proves
  // absence by exact locator instead of inferring it from a listing omission.
  await recoverAbsentCompletedImportProofs({ dependencies, budget, database });

  const preContainerCandidates = await discoverDatabaseLegacyProjectCandidates({
    existing: collectLegacyProjectCandidates(gatewayAgents, []),
    database,
    roots,
    dependencies,
    budget,
  });

  if (!dependencies.dockerAvailable()) {
    await assertNoUnknownLegacyAgentDirectories({
      candidates: preContainerCandidates,
      roots,
      database,
    });
    const pendingIdentities = await database.projectIdentity.findMany({
      where: { legacyOpenClawMigrationStatus: 'PENDING' },
      select: { id: true },
      take: 1,
    });
    if (preContainerCandidates.length > 0 || pendingIdentities.length > 0) {
      fail('DOCKER_UNAVAILABLE', 'Docker is unavailable while legacy Project agents remain configured');
    }
    return empty;
  }

  const containers = await discoverLegacyContainers(dependencies, budget, roots);
  if (localConfig) assertConfigSnapshotsMatch(localAgents, gatewayAgents);

  const trustedAgentIds = new Set([
    ...gatewayAgents.map((candidate) => candidate.agentId),
    ...containers.map((candidate) => candidate.agentId),
  ]);
  if (trustedAgentIds.size > MAX_LEGACY_AGENTS) {
    fail('AGENT_LIMIT', 'Combined legacy Project identity count exceeded the retirement safety limit');
  }
  const candidates = await discoverDatabaseLegacyProjectCandidates({
    existing: collectLegacyProjectCandidates(gatewayAgents, containers),
    database,
    roots,
    dependencies,
    budget,
  });
  for (const candidate of candidates) trustedAgentIds.add(candidate.agentId);
  if (trustedAgentIds.size > MAX_LEGACY_AGENTS) {
    fail('AGENT_LIMIT', 'Combined legacy Project identity count exceeded the retirement safety limit');
  }
  await assertNoUnknownLegacyAgentDirectories({ candidates, roots, database });
  const identities = new Map<string, LegacyProjectIdentityRow>();
  for (const candidate of candidates) {
    const identity = await database.$transaction(async (transaction) => {
      await dependencies.assertMutationLeaseInTransaction(transaction);
      return resolveLegacyProjectIdentity(candidate, transaction);
    }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 15_000 });
    identities.set(candidate.agentId, identity);
  }
  const migrationTargets = [...new Map(candidates.map((candidate) => {
    const identity = identities.get(candidate.agentId);
    if (!identity) fail('PROJECT_IDENTITY', 'Legacy Project identity was not resolved');
    const target: LegacyProjectMigrationTarget = {
      id: identity.id,
      actorUserId: candidate.userId,
      generation: identity.generation,
    };
    return [identity.id, target] as const;
  })).values()];
  // A Clear tombstone must win before the importer marks an identity PENDING;
  // otherwise startup and the authenticated retry would deadlock each other.
  // The database trigger on ProjectIdentity closes the cross-process race
  // between this read and the status transition below.
  await assertNoPendingLegacyDestructiveReset(candidates, identities, database);
  // A zero-source candidate has no per-source journal in which to commit the
  // exact empty inventory. Mutating SQL residue or closing Project admission
  // in that state would create an unrecoverable PENDING identity after a
  // crash. Preserve it behind the global discovery gate until a durable empty-
  // inventory ledger exists.
  const sources = candidates.length > 0
    ? await discoverLegacyProjectSessionSources({
        candidates,
        identities,
        containers,
        dependencies,
        database,
        budget,
      })
    : [];
  const existingProofs = candidates.length > 0
    ? await database.legacyOpenClawProjectImport.findMany({
        where: {
          OR: candidates.map((candidate) => ({
            actorUserId: candidate.userId,
            projectIdentityId: identities.get(candidate.agentId)?.id,
          })),
        },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: MAX_IMPORT_RECOVERY_PROOFS + 1,
      })
    : [];
  if (existingProofs.length > MAX_IMPORT_RECOVERY_PROOFS) {
    fail('IMPORT_PROOF_LIMIT', 'Legacy Project proof inventory exceeded its safety limit');
  }
  const artifactInventoryFingerprints = assertNoUnaccountedDedicatedTranscripts({
    roots,
    candidates,
    identities,
    sources,
    proofs: existingProofs,
  });
  for (const candidate of candidates) {
    const identity = identities.get(candidate.agentId);
    const hasSource = sources.some((source) => source.candidate.agentId === candidate.agentId);
    const hasDurableProof = existingProofs.some((proof) => (
      identity
      && proof.actorUserId === candidate.userId
      && proof.projectIdentityId === identity.id
      && proof.projectGeneration > 0
      && proof.projectGeneration <= identity.generation
    ));
    if (!hasSource && !hasDurableProof) {
      fail(
        'EMPTY_SOURCE_INVENTORY_UNPROVED',
        'Legacy Project had no durable source inventory proof; preserving it behind the migration gate',
      );
    }
  }
  // This transition and the coordinator phase flip commit atomically. Readers
  // therefore see either a global DISCOVERING gate or the exact affected
  // Project identities in PENDING state; there is no unguarded handoff.
  await dependencies.markAffectedProjectIdentities(migrationTargets);
  // If a retired source reappears after the user cleared it, keep the exact
  // identity gated and preserve the source for a separately attested cleanup.
  // Re-importing it would resurrect private history by design.
  await assertLegacyHistoryWasNotCleared(candidates, identities, database);
  const currentIdentityIds = new Set(migrationTargets.map((target) => target.id));
  const recoverablePending = await loadRecoverablePendingMigrations({
    dependencies,
    budget,
    database,
    roots,
    excludeProjectIdentityIds: currentIdentityIds,
  });
  for (const agentId of recoverablePending.dedicatedAgentIds) trustedAgentIds.add(agentId);
  if (trustedAgentIds.size > MAX_LEGACY_AGENTS) {
    fail('AGENT_LIMIT', 'Combined active and recovering legacy identity count exceeded the safety limit');
  }
  if (candidates.length === 0) {
    if (recoverablePending.targets.length === 0) return empty;
    await verifyClean(dependencies, budget, roots, trustedAgentIds);
    const confirmedPending = await loadRecoverablePendingMigrations({
      dependencies,
      budget,
      database,
      roots,
      excludeProjectIdentityIds: currentIdentityIds,
    });
    if (confirmedPending.fingerprint !== recoverablePending.fingerprint) {
      fail('IMPORT_PROOF', 'Pending legacy Project recovery proofs changed during final verification');
    }
    await dependencies.markCompletedProjectIdentities(confirmedPending.targets);
    return empty;
  }
  const imported = await importLegacyProjectHistories({
    candidates,
    identities,
    sources,
    dependencies,
    database,
    budget,
    artifactInventoryFingerprints,
  });

  const preRetirementArtifactInventory = assertNoUnaccountedDedicatedTranscripts({
    roots,
    candidates,
    identities,
    sources,
    proofs: existingProofs,
    histories: imported.sessions,
  });
  for (const candidate of candidates) {
    if (
      preRetirementArtifactInventory.get(candidate.agentId)
      !== artifactInventoryFingerprints.get(candidate.agentId)
    ) {
      fail('TRANSCRIPT_RACE', 'Legacy transcript artifact inventory changed during import');
    }
  }

  dependencies.log(
    `[legacy-project-retirement] imported ${imported.canonicalSessionsImported} canonical session(s) `
      + `and ${imported.messagesImported} visible message(s); retiring ${gatewayAgents.length} registration(s) `
      + `and ${containers.length} attested container(s)`,
  );

  const sessionsRetired = await retireLegacySessions(
    dependencies,
    budget,
    database,
    sources,
    imported.sessions,
    imported.artifactInventoryFingerprints,
  );
  let containersRetired = 0;
  for (const container of [...containers].sort((left, right) => left.containerId.localeCompare(right.containerId))) {
    const candidate = candidates.find((entry) => entry.agentId === container.agentId);
    const identity = identities.get(container.agentId);
    if (!candidate || !identity) {
      fail('IMPORT_PROOF', 'Legacy container lost its attested Project identity before retirement');
    }
    await assertLegacyContainerImportProof({
      container,
      candidate,
      identity,
      sources,
      histories: imported.sessions,
      artifactInventoryFingerprint:
        imported.artifactInventoryFingerprints.get(candidate.agentId) || sha256('[]'),
      database,
    });
    if (await removeLegacyContainer(dependencies, budget, roots, container)) containersRetired += 1;
  }
  const configuredAgentsRetired = await retireConfiguredAgents(
    dependencies,
    budget,
    roots,
    gatewayAgents,
  );

  // A direct OpenClaw client could have materialized one last container while
  // the legacy config still existed. Only identities attested in the initial
  // snapshot are eligible for this bounded final sweep.
  for (let round = 0; round < 2; round += 1) {
    const late = await discoverLegacyContainers(dependencies, budget, roots);
    if (late.length === 0) break;
    if (late.some((candidate) => !trustedAgentIds.has(candidate.agentId))) {
      fail('LATE_CONTAINER', 'An unplanned legacy Project container appeared during retirement');
    }
    for (const container of late) {
      if (!imported.sessions.some((history) => history.sessionKey === container.sessionKey)) {
        fail('LATE_CONTAINER', 'A legacy container appeared for a session without import proof');
      }
      const candidate = candidates.find((entry) => entry.agentId === container.agentId);
      const identity = identities.get(container.agentId);
      if (!candidate || !identity) {
        fail('IMPORT_PROOF', 'Late legacy container lost its attested Project identity');
      }
      await assertLegacyContainerImportProof({
        container,
        candidate,
        identity,
        sources,
        histories: imported.sessions,
        artifactInventoryFingerprint:
          imported.artifactInventoryFingerprints.get(candidate.agentId) || sha256('[]'),
        database,
      });
      if (await removeLegacyContainer(dependencies, budget, roots, container)) containersRetired += 1;
    }
  }

  await verifyClean(dependencies, budget, roots, trustedAgentIds);
  const confirmedPending = await loadRecoverablePendingMigrations({
    dependencies,
    budget,
    database,
    roots,
    excludeProjectIdentityIds: currentIdentityIds,
  });
  if (confirmedPending.fingerprint !== recoverablePending.fingerprint) {
    fail('IMPORT_PROOF', 'Pending legacy Project recovery proofs changed during final verification');
  }
  for (const candidate of candidates) assertLegacyCandidateRootUnchanged(candidate);
  await dependencies.markCompletedProjectIdentities([
    ...migrationTargets,
    ...confirmedPending.targets,
  ]);
  const result = {
    candidatesFound: trustedAgentIds.size,
    canonicalSessionsImported: imported.canonicalSessionsImported,
    messagesImported: imported.messagesImported,
    configuredAgentsRetired,
    sessionsRetired,
    containersRetired,
  };
  dependencies.log(
    `[legacy-project-retirement] complete: ${configuredAgentsRetired} agent(s), `
      + `${sessionsRetired} session registration(s), ${containersRetired} container(s); `
      + 'source transcript files preserved and zero executable residue verified',
  );
  return result;
}

/**
 * Release-safe startup inspection for Portal 3.x OpenClaw Project state.
 *
 * The destructive implementation is deliberately unreachable from the Portal
 * runtime while the compile-time policy is false. This lane may inspect exact
 * config, database, filesystem, and Docker inventory, but it must not create a
 * Project identity, import/quarantine SQL, or mutate a Gateway/container.
 * The coordinator's DISCOVERING lease remains the durable fail-closed gate when
 * preserved legacy evidence is found.
 */
export async function retireLegacyOpenClawProjectAgentsAtStartup(
  options: LegacyOpenClawProjectRetirementOptions = {},
): Promise<LegacyOpenClawProjectRetirementResult> {
  if (LEGACY_OPENCLAW_DESTRUCTIVE_RETIREMENT_ENABLED) {
    return retireLegacyOpenClawProjectAgentsDestructively(options);
  }

  const roots = buildRoots(options);
  const dependencies = { ...defaultDependencies, ...(options.dependencies || {}) };
  const database = options.database || prisma as unknown as LegacyOpenClawProjectRetirementDatabase;
  const budget: OperationBudget = { rpcCalls: 0, dockerCalls: 0 };
  const empty: LegacyOpenClawProjectRetirementResult = {
    candidatesFound: 0,
    canonicalSessionsImported: 0,
    messagesImported: 0,
    configuredAgentsRetired: 0,
    sessionsRetired: 0,
    containersRetired: 0,
  };

  const localConfig = await dependencies.readConfig(roots.openClawConfigPath);
  const localAgents = localConfig
    ? discoverLegacyOpenClawProjectAgents(localConfig, roots)
    : [];
  const gatewayConfig = parseConfigRpc(await boundedRpc(
    dependencies,
    budget,
    'config.get',
    {},
    CONFIG_RPC_TIMEOUT_MS,
  ));
  const gatewayAgents = discoverLegacyOpenClawProjectAgents(gatewayConfig, roots);

  if (!dependencies.dockerAvailable()) {
    fail(
      'DOCKER_UNAVAILABLE',
      'Docker inventory could not be inspected while destructive legacy retirement is disabled',
    );
  }
  const containers = await discoverLegacyContainers(dependencies, budget, roots);
  const sessionRegistrations = await listGlobalLegacySessionRegistrations(dependencies, budget);
  const databaseEvidence = await discoverDisabledReleaseDatabaseEvidence(database);
  const agentArtifactIds = listLegacyAgentArtifactIds(roots);
  const [pendingIdentities, importProofs, quarantineRows, legacyMessageProjections] = await Promise.all([
    database.projectIdentity.findMany({
      where: { legacyOpenClawMigrationStatus: 'PENDING' },
      select: { id: true },
      take: 1,
    }),
    database.legacyOpenClawProjectImport.findMany({
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: 1,
    }),
    database.legacyOpenClawProjectQuarantine.findMany({
      select: { id: true },
      take: 1,
    }),
    database.projectChatMessage.findMany({
      where: {
        OR: [
          { legacyImportStatus: LEGACY_IMPORT_IMPORTED },
          { messageId: { startsWith: LEGACY_IMPORT_MESSAGE_PREFIX } },
        ],
      },
      select: { id: true },
      take: 1,
    }),
  ]);

  const legacyEvidenceCount = new Set([
    ...localAgents.map((candidate) => `local:${candidate.agentId}`),
    ...gatewayAgents.map((candidate) => `gateway:${candidate.agentId}`),
    ...databaseEvidence,
    ...containers.map((candidate) => `container:${candidate.containerId}`),
    ...sessionRegistrations.map((sessionKey) => `session:${sessionKey}`),
    ...agentArtifactIds.map((agentId) => `artifact:${agentId}`),
    ...pendingIdentities.map((identity) => `pending:${identity.id}`),
    ...importProofs.map((proof) => `proof:${proof.id}`),
    ...quarantineRows.map((row) => `quarantine:${row.id}`),
    ...legacyMessageProjections.map((row) => `projection:${row.id}`),
  ]).size;
  if (legacyEvidenceCount > 0) {
    dependencies.log(
      `[legacy-project-retirement] preserving ${legacyEvidenceCount} legacy evidence locator(s); `
        + 'destructive retirement is compile-time disabled',
    );
    fail('LEGACY_DESTRUCTIVE_RETIREMENT_DISABLED', LEGACY_OPENCLAW_RETIREMENT_PENDING_MESSAGE);
  }

  return empty;
}

/**
 * Comprehensive release gate shared by startup and every destructive Project
 * route. It is deliberately global: when an exact Project attribution is not
 * available, preserving all Portal 3.x state is safer than guessing ownership.
 */
export async function assertNoLegacyOpenClawProjectEvidence(
  options: LegacyOpenClawProjectRetirementOptions = {},
): Promise<void> {
  await retireLegacyOpenClawProjectAgentsAtStartup(options);
}

export const __legacyOpenClawProjectRetirementTest = Object.freeze({
  LEGACY_IMAGE,
  LEGACY_MOUNT_FORMAT,
  attestLegacyContainer,
  buildRoots,
  claimLegacyMigrationLeaseFromStore,
  legacyOpenClawProjectMigrationGateIsActive,
  renewLegacyMigrationLeaseFromStore,
  resolveLegacyProjectIdentity,
  revokeLegacyMigrationLeaseAfterFailure,
  startSerializedLegacyMigrationLeaseHeartbeat,
});
