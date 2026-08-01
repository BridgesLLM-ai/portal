import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  buildProjectEgressIdentityScope,
  projectEgressCommandExecutor,
  type ProjectEgressCommandExecutor,
  type ProjectEgressCommandResult,
} from '../../../services/projectEgressPlane';
import {
  AGENT_ZERO_PROJECT_FIREWALL_CHAIN_PREFIX,
  AGENT_ZERO_PROJECT_FIREWALL_COMMENT_PREFIX,
} from './AgentZeroProjectEgress';
import {
  AGENT_ZERO_PROJECT_ACTOR_LABEL,
  AGENT_ZERO_PROJECT_DATA_VOLUME_ROLE,
  AGENT_ZERO_PROJECT_IDENTITY_SCHEMA,
  AGENT_ZERO_PROJECT_ID_LABEL,
  AGENT_ZERO_PROJECT_KEY_LABEL,
  AGENT_ZERO_PROJECT_MANAGED_LABEL,
  AGENT_ZERO_PROJECT_POLICY_LABEL,
  AGENT_ZERO_PROJECT_POLICY_VERSION,
  AGENT_ZERO_PROJECT_RUNTIME,
  AGENT_ZERO_PROJECT_RUNTIME_LABEL,
  AGENT_ZERO_PROJECT_VOLUME_ROLE_LABEL,
  resolveAgentZeroProjectStateRoot,
  type AgentZeroProjectRuntimeIdentity,
} from './AgentZeroProjectSandbox';
import {
  agentZeroProjectModelBridgeCredentialPath,
  readAgentZeroProjectModelBridgeCredentialRecord,
  resolveAgentZeroProjectModelBridgeCredentialRoot,
  revokeAgentZeroProjectModelBridgeCredential,
  type AgentZeroProjectModelBridgeCredentialRecord,
} from './AgentZeroProjectModelBridgeCredential';

const DOCKER_USER_CHAIN = 'DOCKER-USER';
const INPUT_CHAIN = 'INPUT';
const PROJECT_KEY_RE = /^[a-f0-9]{64}$/;
const DOCKER_ID_RE = /^[a-f0-9]{64}$/;
const OPAQUE_ID_RE = /^[^\u0000-\u001f\u007f]{1,512}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STATE_TOMBSTONE_RE = /^([a-f0-9]{64})\.cleanup\.([a-f0-9]{64})$/;
const ALLOWED_STATE_FILES = new Set([
  'identity.json',
  'agent-zero.env',
  'model-bridge.env',
  'qualification.json',
]);

export type AgentZeroProjectRuntimeResourceKind =
  | 'CONTAINER'
  | 'NETWORK_MEMBERSHIP'
  | 'DATA_VOLUME'
  | 'FIREWALL_CHAIN'
  | 'CREDENTIAL_FILE'
  | 'MODEL_BRIDGE_ENV_FILE'
  | 'MODEL_BRIDGE_CREDENTIAL'
  | 'QUALIFICATION_FILE'
  | 'STATE_DIRECTORY';

export interface AgentZeroProjectRuntimeResource {
  kind: AgentZeroProjectRuntimeResourceKind;
  name: string;
  projectIdentityId: string;
  actorUserId: string | null;
  projectKey: string | null;
  dockerId: string | null;
  networkName: string | null;
  firewallStatements: readonly string[];
  snapshotFingerprint: string;
}

export interface AgentZeroProjectRuntimeDiscoveryOptions {
  stateRoot?: string;
  credentialRoot?: string;
  knownActorIds?: readonly string[];
}

export interface AgentZeroProjectRuntimeTeardownResult {
  projectIdentityId: string;
  discoveredResourceCount: number;
  removedResourceCount: number;
  alreadyAbsent: boolean;
}

export type AgentZeroProjectCleanupErrorCode =
  | 'INVALID_INPUT'
  | 'STATE_ROOT'
  | 'STATE_IDENTITY'
  | 'STATE_CONTENTS'
  | 'DOCKER_LIST'
  | 'DOCKER_INSPECT'
  | 'DOCKER_IDENTITY'
  | 'VOLUME_PROVENANCE'
  | 'FIREWALL_IDENTITY'
  | 'CLEANUP_RACE'
  | 'CLEANUP_FAILED'
  | 'RESIDUAL_RESOURCE';

export class AgentZeroProjectCleanupError extends Error {
  constructor(
    public readonly code: AgentZeroProjectCleanupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentZeroProjectCleanupError';
  }
}

interface DockerContainerInspect {
  Id?: string;
  Name?: string;
  State?: { Running?: boolean; StartedAt?: string };
  Config?: { Labels?: Record<string, string> | null; Image?: string };
  HostConfig?: { NetworkMode?: string };
  NetworkSettings?: { Networks?: Record<string, unknown> | null };
  Mounts?: unknown[];
}

interface DockerVolumeInspect {
  Name?: string;
  Driver?: string;
  Scope?: string;
  Options?: Record<string, string> | null;
  Mountpoint?: string;
  Labels?: Record<string, string> | null;
}

function fail(code: AgentZeroProjectCleanupErrorCode, message: string): never {
  throw new AgentZeroProjectCleanupError(code, message);
}

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requiredOpaqueId(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!OPAQUE_ID_RE.test(normalized)) fail('INVALID_INPUT', `Invalid ${label}`);
  return normalized;
}

function requiredProjectIdentityId(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(normalized)) fail('INVALID_INPUT', 'Invalid immutable project identity UUID');
  return normalized;
}

function requiredProjectKey(value: unknown, label = 'Agent Zero project key'): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!PROJECT_KEY_RE.test(normalized)) fail('DOCKER_IDENTITY', `${label} is invalid`);
  return normalized;
}

function requiredDockerId(value: unknown, label: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!DOCKER_ID_RE.test(normalized)) fail('DOCKER_IDENTITY', `${label} id is invalid`);
  return normalized;
}

function requiredDockerName(value: unknown, label: string): string {
  const normalized = String(value || '').replace(/^\//, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(normalized)) {
    fail('DOCKER_IDENTITY', `${label} name is invalid`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFirewallLine(line: string): string {
  return line.trim().replace(/--comment "([^"]+)"/g, '--comment $1');
}

function requireCommandSuccess(
  result: ProjectEgressCommandResult,
  message: string,
): void {
  if (result.exitCode !== 0) fail('CLEANUP_FAILED', message);
}

function resource(input: Omit<AgentZeroProjectRuntimeResource, 'snapshotFingerprint'> & {
  snapshot: unknown;
}): AgentZeroProjectRuntimeResource {
  return Object.freeze({
    kind: input.kind,
    name: input.name,
    projectIdentityId: input.projectIdentityId,
    actorUserId: input.actorUserId,
    projectKey: input.projectKey,
    dockerId: input.dockerId,
    networkName: input.networkName,
    firewallStatements: Object.freeze([...input.firewallStatements]),
    snapshotFingerprint: stableHash(input.snapshot),
  });
}

function resourceKey(value: AgentZeroProjectRuntimeResource): string {
  return `${value.kind}\u0000${value.name}`;
}

function compareResourceSnapshots(
  expected: readonly AgentZeroProjectRuntimeResource[],
  actual: readonly AgentZeroProjectRuntimeResource[],
): void {
  const expectedMap = new Map(expected.map((value) => [resourceKey(value), value.snapshotFingerprint]));
  const actualMap = new Map(actual.map((value) => [resourceKey(value), value.snapshotFingerprint]));
  if (expectedMap.size !== actualMap.size
    || [...expectedMap].some(([key, fingerprint]) => actualMap.get(key) !== fingerprint)) {
    fail('CLEANUP_RACE', 'Agent Zero Project resources changed between cleanup attestations');
  }
}

function dockerNotFound(result: ProjectEgressCommandResult, kind: 'container' | 'volume'): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return kind === 'container'
    ? output.includes('no such object') || output.includes('no such container') || output.includes('not found')
    : output.includes('no such volume') || output.includes('no such object') || output.includes('not found');
}

async function strictInspectOne<T>(
  executor: ProjectEgressCommandExecutor,
  kind: 'container' | 'volume',
  name: string,
): Promise<T | null> {
  const args = kind === 'container'
    ? ['container', 'inspect', name]
    : ['volume', 'inspect', name];
  const result = await executor.run('docker', args, { allowExitCodes: [0, 1] });
  if (result.exitCode !== 0) {
    if (dockerNotFound(result, kind)) return null;
    fail('DOCKER_INSPECT', `Docker ${kind} inspection failed without proving absence`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail('DOCKER_INSPECT', `Docker ${kind} inspection returned invalid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    fail('DOCKER_INSPECT', `Docker ${kind} inspection returned an invalid shape`);
  }
  return parsed[0] as T;
}

async function listManagedNames(
  executor: ProjectEgressCommandExecutor,
  kind: 'container' | 'volume',
  projectIdentityId: string,
): Promise<string[]> {
  const args = kind === 'container'
    ? [
      'container', 'ls', '--all',
      '--filter', `label=${AGENT_ZERO_PROJECT_MANAGED_LABEL}=agent-zero-project`,
      '--filter', `label=${AGENT_ZERO_PROJECT_ID_LABEL}=${projectIdentityId}`,
      '--format', '{{.Names}}',
    ]
    : [
      'volume', 'ls',
      '--filter', `label=${AGENT_ZERO_PROJECT_MANAGED_LABEL}=agent-zero-project`,
      '--filter', `label=${AGENT_ZERO_PROJECT_ID_LABEL}=${projectIdentityId}`,
      '--format', '{{.Name}}',
    ];
  const result = await executor.run('docker', args);
  if (result.exitCode !== 0) fail('DOCKER_LIST', `Docker ${kind} discovery failed`);
  const names = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    .map((value) => requiredDockerName(value, `Agent Zero ${kind}`)).sort();
  if (new Set(names).size !== names.length) fail('DOCKER_LIST', `Docker returned duplicate Agent Zero ${kind} names`);
  return names;
}

function exactOwnershipLabels(
  labels: Record<string, string> | null | undefined,
  projectIdentityId: string,
  expectedRole?: typeof AGENT_ZERO_PROJECT_DATA_VOLUME_ROLE,
): { actorUserId: string; projectKey: string } {
  if (labels?.[AGENT_ZERO_PROJECT_MANAGED_LABEL] !== 'agent-zero-project'
    || labels?.[AGENT_ZERO_PROJECT_RUNTIME_LABEL] !== AGENT_ZERO_PROJECT_RUNTIME
    || labels?.[AGENT_ZERO_PROJECT_POLICY_LABEL] !== AGENT_ZERO_PROJECT_POLICY_VERSION
    || labels?.[AGENT_ZERO_PROJECT_ID_LABEL] !== projectIdentityId
    || (expectedRole && labels?.[AGENT_ZERO_PROJECT_VOLUME_ROLE_LABEL] !== expectedRole)) {
    fail('DOCKER_IDENTITY', 'Agent Zero Project resource labels do not match the immutable project');
  }
  return {
    actorUserId: requiredOpaqueId(labels[AGENT_ZERO_PROJECT_ACTOR_LABEL], 'Agent Zero actor label'),
    projectKey: requiredProjectKey(labels[AGENT_ZERO_PROJECT_KEY_LABEL]),
  };
}

function expectedContainerName(projectKey: string): string {
  return `bridgesllm-a0p-${projectKey.slice(0, 24)}`;
}

function expectedVolumeName(projectKey: string): string {
  return `${expectedContainerName(projectKey)}-usr`;
}

function containerResources(
  inspect: DockerContainerInspect,
  expectedName: string,
  projectIdentityId: string,
): AgentZeroProjectRuntimeResource[] {
  const name = requiredDockerName(inspect.Name, 'Agent Zero Project container');
  const dockerId = requiredDockerId(inspect.Id, 'Agent Zero Project container');
  const ownership = exactOwnershipLabels(inspect.Config?.Labels, projectIdentityId);
  if (name !== expectedName || name !== expectedContainerName(ownership.projectKey)) {
    fail('DOCKER_IDENTITY', 'Agent Zero Project container name does not match its immutable identity');
  }
  const networks = Object.keys(inspect.NetworkSettings?.Networks || {}).sort();
  const snapshot = {
    dockerId,
    name,
    labels: inspect.Config?.Labels,
    image: inspect.Config?.Image,
    running: inspect.State?.Running === true,
    startedAt: inspect.State?.StartedAt || '',
    networkMode: inspect.HostConfig?.NetworkMode || '',
    networks,
    mounts: inspect.Mounts || [],
  };
  return [
    resource({
      kind: 'CONTAINER',
      name,
      projectIdentityId,
      actorUserId: ownership.actorUserId,
      projectKey: ownership.projectKey,
      dockerId,
      networkName: null,
      firewallStatements: [],
      snapshot,
    }),
    ...networks.map((networkName) => resource({
      kind: 'NETWORK_MEMBERSHIP' as const,
      name: `${networkName}:${dockerId}`,
      projectIdentityId,
      actorUserId: ownership.actorUserId,
      projectKey: ownership.projectKey,
      dockerId,
      networkName,
      firewallStatements: [],
      snapshot: { dockerId, networkName, containerName: name },
    })),
  ];
}

function volumeResource(
  inspect: DockerVolumeInspect,
  expectedName: string,
  projectIdentityId: string,
): AgentZeroProjectRuntimeResource {
  const name = requiredDockerName(inspect.Name, 'Agent Zero Project volume');
  const ownership = exactOwnershipLabels(
    inspect.Labels,
    projectIdentityId,
    AGENT_ZERO_PROJECT_DATA_VOLUME_ROLE,
  );
  if (name !== expectedName || name !== expectedVolumeName(ownership.projectKey)) {
    fail('DOCKER_IDENTITY', 'Agent Zero Project volume name does not match its immutable identity');
  }
  const options = inspect.Options;
  const mountpoint = String(inspect.Mountpoint || '');
  if (inspect.Driver !== 'local'
    || inspect.Scope !== 'local'
    || (options != null && (!isRecord(options) || Object.keys(options).length > 0))
    || !path.isAbsolute(mountpoint)
    || !mountpoint.endsWith(path.join('volumes', name, '_data'))) {
    fail('VOLUME_PROVENANCE', 'Agent Zero Project volume is not an empty-options local Docker volume');
  }
  return resource({
    kind: 'DATA_VOLUME',
    name,
    projectIdentityId,
    actorUserId: ownership.actorUserId,
    projectKey: ownership.projectKey,
    dockerId: null,
    networkName: null,
    firewallStatements: [],
    snapshot: {
      name,
      driver: inspect.Driver,
      scope: inspect.Scope,
      options,
      mountpoint,
      labels: inspect.Labels,
    },
  });
}

function protectedStat(filePath: string, expectedKind: 'file' | 'directory'): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail('STATE_IDENTITY', `Agent Zero state disappeared during inspection: ${path.basename(filePath)}`);
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  const correctKind = expectedKind === 'file' ? stat.isFile() : stat.isDirectory();
  if (!correctKind || stat.isSymbolicLink() || stat.uid !== currentUid || (stat.mode & 0o077) !== 0) {
    fail('STATE_IDENTITY', `Agent Zero ${expectedKind} state is not privately owned`);
  }
  return stat;
}

function statSnapshot(stat: fs.Stats): Record<string, number> {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    birthtimeMs: stat.birthtimeMs,
  };
}

function validateRuntimeIdentity(value: unknown, directoryKey: string): AgentZeroProjectRuntimeIdentity {
  if (!isRecord(value)) fail('STATE_IDENTITY', 'Agent Zero identity manifest is malformed');
  const base = {
    schema: value.schema,
    runtime: value.runtime,
    policyVersion: value.policyVersion,
    actorUserId: value.actorUserId,
    projectIdentityId: value.projectIdentityId,
    projectKey: value.projectKey,
    canonicalProjectRoot: value.canonicalProjectRoot,
    rootDevice: value.rootDevice,
    rootInode: value.rootInode,
    rootBirthtimeNs: value.rootBirthtimeNs,
  };
  const actorUserId = requiredOpaqueId(base.actorUserId, 'Agent Zero identity actor');
  const projectIdentityId = requiredOpaqueId(base.projectIdentityId, 'Agent Zero identity project');
  const projectKey = requiredProjectKey(base.projectKey, 'Agent Zero identity project key');
  const canonicalProjectRoot = String(base.canonicalProjectRoot || '');
  if (base.schema !== AGENT_ZERO_PROJECT_IDENTITY_SCHEMA
    || base.runtime !== AGENT_ZERO_PROJECT_RUNTIME
    || base.policyVersion !== AGENT_ZERO_PROJECT_POLICY_VERSION
    || projectKey !== directoryKey
    || !path.isAbsolute(canonicalProjectRoot)
    || canonicalProjectRoot === path.parse(canonicalProjectRoot).root
    || !String(base.rootDevice || '')
    || !String(base.rootInode || '')
    || !String(base.rootBirthtimeNs || '')
    || value.identityFingerprint !== stableHash({
      ...base,
      actorUserId,
      projectIdentityId,
      projectKey,
      canonicalProjectRoot,
    })) {
    fail('STATE_IDENTITY', 'Agent Zero identity manifest does not match its protected state directory');
  }
  return value as AgentZeroProjectRuntimeIdentity;
}

function stateResources(
  projectIdentityId: string,
  stateRootOverride?: string,
): AgentZeroProjectRuntimeResource[] {
  const stateRoot = resolveAgentZeroProjectStateRoot(stateRootOverride);
  if (!fs.existsSync(stateRoot)) return [];
  protectedStat(stateRoot, 'directory');
  const projectFingerprint = stableHash({ projectId: projectIdentityId });
  const resources: AgentZeroProjectRuntimeResource[] = [];
  const entries = fs.readdirSync(stateRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail('STATE_ROOT', 'Agent Zero state root contains an unexpected non-directory entry');
    }
    const normalKey = PROJECT_KEY_RE.test(entry.name) ? entry.name : null;
    const tombstone = entry.name.match(STATE_TOMBSTONE_RE);
    if (!normalKey && !tombstone) fail('STATE_ROOT', 'Agent Zero state root contains an unrecognized directory');
    const projectKey = requiredProjectKey(normalKey || tombstone![1], 'Agent Zero state directory key');
    const directory = path.join(stateRoot, entry.name);
    const directoryStat = protectedStat(directory, 'directory');
    const names = fs.readdirSync(directory).sort();
    if (names.some((name) => !ALLOWED_STATE_FILES.has(name))) {
      fail('STATE_CONTENTS', 'Agent Zero state directory contains an unexpected file');
    }
    const identityPath = path.join(directory, 'identity.json');
    let identity: AgentZeroProjectRuntimeIdentity | null = null;
    if (fs.existsSync(identityPath)) {
      protectedStat(identityPath, 'file');
      try {
        identity = validateRuntimeIdentity(JSON.parse(fs.readFileSync(identityPath, 'utf8')), projectKey);
      } catch (error) {
        if (error instanceof AgentZeroProjectCleanupError) throw error;
        fail('STATE_IDENTITY', 'Agent Zero identity manifest is not valid JSON');
      }
    } else if (!tombstone || tombstone[2] !== projectFingerprint) {
      fail('STATE_IDENTITY', 'Agent Zero state directory lost its immutable identity manifest');
    }
    const belongsToProject = identity
      ? identity.projectIdentityId === projectIdentityId
      : tombstone?.[2] === projectFingerprint;
    if (!belongsToProject) continue;
    const actorUserId = identity?.actorUserId || null;
    const childSnapshots = names.map((name) => {
      const childPath = path.join(directory, name);
      return { name, stat: statSnapshot(protectedStat(childPath, 'file')) };
    });
    resources.push(resource({
      kind: 'STATE_DIRECTORY',
      name: directory,
      projectIdentityId,
      actorUserId,
      projectKey,
      dockerId: null,
      networkName: null,
      firewallStatements: [],
      snapshot: {
        directory: statSnapshot(directoryStat),
        identity,
        children: childSnapshots,
      },
    }));
    for (const [fileName, kind] of [
      ['agent-zero.env', 'CREDENTIAL_FILE'],
      ['model-bridge.env', 'MODEL_BRIDGE_ENV_FILE'],
      ['qualification.json', 'QUALIFICATION_FILE'],
    ] as const) {
      if (!names.includes(fileName)) continue;
      const filePath = path.join(directory, fileName);
      resources.push(resource({
        kind,
        name: filePath,
        projectIdentityId,
        actorUserId,
        projectKey,
        dockerId: null,
        networkName: null,
        firewallStatements: [],
        snapshot: statSnapshot(protectedStat(filePath, 'file')),
      }));
    }
  }
  return resources;
}

function modelBridgeCredentialStat(filePath: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail('STATE_IDENTITY', 'Agent Zero model bridge credential disappeared during inspection');
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== currentUid
    || (stat.mode & 0o037) !== 0) {
    fail('STATE_IDENTITY', 'Agent Zero model bridge credential record is not protected');
  }
  return stat;
}

function modelBridgeCredentialResource(
  record: AgentZeroProjectModelBridgeCredentialRecord,
  filePath: string,
): AgentZeroProjectRuntimeResource {
  const stat = modelBridgeCredentialStat(filePath);
  return resource({
    kind: 'MODEL_BRIDGE_CREDENTIAL',
    name: filePath,
    projectIdentityId: record.projectIdentityId,
    actorUserId: record.actorUserId,
    projectKey: record.projectKey,
    dockerId: null,
    networkName: null,
    firewallStatements: [],
    snapshot: { record, stat: statSnapshot(stat) },
  });
}

function modelBridgeCredentialResources(
  projectIdentityId: string,
  credentialRootOverride?: string,
): AgentZeroProjectRuntimeResource[] {
  const credentialRoot = resolveAgentZeroProjectModelBridgeCredentialRoot(credentialRootOverride);
  if (!fs.existsSync(credentialRoot)) return [];
  const rootStat = fs.lstatSync(credentialRoot);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : rootStat.uid;
  if (!rootStat.isDirectory()
    || rootStat.isSymbolicLink()
    || rootStat.uid !== currentUid
    || (rootStat.mode & 0o027) !== 0) {
    fail('STATE_ROOT', 'Agent Zero model bridge credential root is not protected');
  }
  const resources: AgentZeroProjectRuntimeResource[] = [];
  for (const entry of fs.readdirSync(credentialRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const match = entry.name.match(/^([a-f0-9]{64})\.json$/);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      fail('STATE_CONTENTS', 'Agent Zero model bridge credential root contains an unexpected entry');
    }
    const projectKey = requiredProjectKey(match[1], 'Agent Zero model bridge project key');
    const record = readAgentZeroProjectModelBridgeCredentialRecord(projectKey, {
      credentialRoot,
      expectedOwnerUid: currentUid,
    });
    if (!record) fail('STATE_IDENTITY', 'Agent Zero model bridge credential vanished during discovery');
    if (record.projectIdentityId !== projectIdentityId) continue;
    const filePath = agentZeroProjectModelBridgeCredentialPath(projectKey, credentialRoot);
    resources.push(modelBridgeCredentialResource(record, filePath));
  }
  return resources;
}

function firewallResources(
  statements: string,
  projectIdentityId: string,
  actorByIdentity: ReadonlyMap<string, string>,
): AgentZeroProjectRuntimeResource[] {
  const lines = statements.split(/\r?\n/).map(normalizeFirewallLine).filter(Boolean);
  const projectFingerprint = stableHash({ projectId: projectIdentityId });
  const commentPrefix = `${AGENT_ZERO_PROJECT_FIREWALL_COMMENT_PREFIX}:${projectFingerprint}:`;
  const identities = new Map<string, string>();
  for (const line of lines) {
    if (!line.includes(commentPrefix)) continue;
    const match = line.match(new RegExp(
      `--comment (${AGENT_ZERO_PROJECT_FIREWALL_COMMENT_PREFIX}:${projectFingerprint}:([a-f0-9]{64}))(?: |$)`,
      'i',
    ));
    if (!match) fail('FIREWALL_IDENTITY', 'Agent Zero firewall comment is malformed');
    identities.set(match[2].toLowerCase(), match[1].toLowerCase());
  }
  for (const identityFingerprint of actorByIdentity.keys()) {
    const chain = `${AGENT_ZERO_PROJECT_FIREWALL_CHAIN_PREFIX}-${identityFingerprint.slice(0, 24).toUpperCase()}`;
    if (lines.includes(`-N ${chain}`) && !identities.has(identityFingerprint)) {
      identities.set(
        identityFingerprint,
        `${AGENT_ZERO_PROJECT_FIREWALL_COMMENT_PREFIX}:${projectFingerprint}:${identityFingerprint}`,
      );
    }
  }

  const resources: AgentZeroProjectRuntimeResource[] = [];
  for (const [identityFingerprint, comment] of identities) {
    const chain = `${AGENT_ZERO_PROJECT_FIREWALL_CHAIN_PREFIX}-${identityFingerprint.slice(0, 24).toUpperCase()}`;
    const relevant = lines.filter((line) => line.startsWith(`-A ${chain} `)
      || line.includes(` -j ${chain}`)
      || line.includes(` -g ${chain}`));
    if (!lines.includes(`-N ${chain}`)
      || relevant.some((line) => !line.includes(`--comment ${comment}`))) {
      fail('FIREWALL_IDENTITY', 'Agent Zero firewall chain has an unscoped or missing reference');
    }
    const chainRules = relevant.filter((line) => line.startsWith(`-A ${chain} `));
    const jumps = relevant.filter((line) => !line.startsWith(`-A ${chain} `));
    const jumpPattern = new RegExp(
      `^-A (${INPUT_CHAIN}|${DOCKER_USER_CHAIN}) -s [0-9.]+/32 -m comment --comment ${comment} -j ${chain}$`,
    );
    const jumpParents = jumps.map((line) => line.match(jumpPattern)?.[1] || null);
    if (chainRules.some((line) => !line.startsWith(`-A ${chain} `))
      || jumpParents.some((parent) => parent == null)
      || new Set(jumpParents).size !== jumpParents.length
      || jumps.length > 2) {
      fail('FIREWALL_IDENTITY', 'Agent Zero firewall chain has an unsafe or duplicate parent reference');
    }
    const sortedRelevant = [...relevant].sort();
    resources.push(resource({
      kind: 'FIREWALL_CHAIN',
      name: chain,
      projectIdentityId,
      actorUserId: actorByIdentity.get(identityFingerprint) || null,
      projectKey: null,
      dockerId: null,
      networkName: null,
      firewallStatements: sortedRelevant,
      snapshot: { chain, comment, relevant: sortedRelevant },
    }));
  }
  const declarations = lines
    .map((line) => line.match(new RegExp(`^-N (${AGENT_ZERO_PROJECT_FIREWALL_CHAIN_PREFIX}-[A-F0-9]{24})$`))?.[1] || null)
    .filter((chain): chain is string => Boolean(chain));
  for (const chain of declarations) {
    const references = lines.filter((line) => line.startsWith(`-A ${chain} `)
      || line.includes(` -j ${chain}`)
      || line.includes(` -g ${chain}`));
    const knownEmptyChain = references.length === 0
      && [...actorByIdentity.keys()].some((identityFingerprint) => (
        chain === `${AGENT_ZERO_PROJECT_FIREWALL_CHAIN_PREFIX}-${identityFingerprint.slice(0, 24).toUpperCase()}`
      ));
    if ((!knownEmptyChain && references.length === 0)
      || references.some((line) => !line.includes(`--comment ${AGENT_ZERO_PROJECT_FIREWALL_COMMENT_PREFIX}:`))) {
      fail('FIREWALL_IDENTITY', 'An ambiguous Agent Zero managed firewall chain prevents safe cleanup');
    }
  }
  return resources;
}

function actorFingerprintMap(
  projectIdentityId: string,
  actors: readonly string[],
): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const actor of actors) {
    const actorUserId = requiredOpaqueId(actor, 'known Agent Zero actor');
    const scope = buildProjectEgressIdentityScope({
      actorId: actorUserId,
      projectId: projectIdentityId,
      provider: 'AGENT_ZERO',
    });
    mapping.set(scope.identityFingerprint, actorUserId);
  }
  return mapping;
}

/**
 * Discover provider-owned Agent Zero resources by immutable ProjectIdentity.
 * Docker labels and protected state manifests survive missing DB bindings;
 * firewall comments include the project fingerprint so firewall-only crash
 * residue remains attributable without trusting a writable project path.
 */
export async function discoverAgentZeroProjectRuntimeResources(
  projectIdentityIdInput: string,
  options: AgentZeroProjectRuntimeDiscoveryOptions = {},
  executor: ProjectEgressCommandExecutor = projectEgressCommandExecutor,
): Promise<readonly AgentZeroProjectRuntimeResource[]> {
  const projectIdentityId = requiredProjectIdentityId(projectIdentityIdInput);
  const state = stateResources(projectIdentityId, options.stateRoot);
  const modelBridgeCredentials = modelBridgeCredentialResources(
    projectIdentityId,
    options.credentialRoot,
  );
  const knownActors = new Set<string>(options.knownActorIds || []);
  for (const value of [...state, ...modelBridgeCredentials]) {
    if (value.actorUserId) knownActors.add(value.actorUserId);
  }

  const containerNames = await listManagedNames(executor, 'container', projectIdentityId);
  const volumeNames = await listManagedNames(executor, 'volume', projectIdentityId);
  const resources: AgentZeroProjectRuntimeResource[] = [...state, ...modelBridgeCredentials];
  const stateKeys = new Set([...state, ...modelBridgeCredentials]
    .map((value) => value.projectKey)
    .filter((value): value is string => Boolean(value)));
  for (const projectKey of stateKeys) {
    const expectedContainer = expectedContainerName(projectKey);
    const expectedVolume = expectedVolumeName(projectKey);
    if (!containerNames.includes(expectedContainer)
      && await strictInspectOne<DockerContainerInspect>(executor, 'container', expectedContainer)) {
      fail('DOCKER_IDENTITY', 'Deterministic Agent Zero container lost its immutable project label');
    }
    if (!volumeNames.includes(expectedVolume)
      && await strictInspectOne<DockerVolumeInspect>(executor, 'volume', expectedVolume)) {
      fail('DOCKER_IDENTITY', 'Deterministic Agent Zero volume lost its immutable project label');
    }
  }

  for (const name of containerNames) {
    const inspect = await strictInspectOne<DockerContainerInspect>(executor, 'container', name);
    if (!inspect) fail('DOCKER_INSPECT', 'A listed Agent Zero Project container disappeared during discovery');
    const discovered = containerResources(inspect, name, projectIdentityId);
    resources.push(...discovered);
    if (discovered[0].actorUserId) knownActors.add(discovered[0].actorUserId);
  }
  for (const name of volumeNames) {
    const inspect = await strictInspectOne<DockerVolumeInspect>(executor, 'volume', name);
    if (!inspect) fail('DOCKER_INSPECT', 'A listed Agent Zero Project volume disappeared during discovery');
    const discovered = volumeResource(inspect, name, projectIdentityId);
    resources.push(discovered);
    if (discovered.actorUserId) knownActors.add(discovered.actorUserId);
  }

  const firewall = await executor.run('iptables', ['-w', '5', '-S']);
  if (firewall.exitCode !== 0) fail('FIREWALL_IDENTITY', 'Agent Zero firewall discovery failed');
  resources.push(...firewallResources(
    firewall.stdout,
    projectIdentityId,
    actorFingerprintMap(projectIdentityId, [...knownActors]),
  ));

  const sorted = resources.sort((left, right) => resourceKey(left).localeCompare(resourceKey(right)));
  if (new Set(sorted.map(resourceKey)).size !== sorted.length) {
    fail('DOCKER_IDENTITY', 'Agent Zero Project discovery returned duplicate resource identities');
  }
  return Object.freeze(sorted);
}

function resourcesOfKind(
  resources: readonly AgentZeroProjectRuntimeResource[],
  kind: AgentZeroProjectRuntimeResourceKind,
): AgentZeroProjectRuntimeResource[] {
  return resources.filter((value) => value.kind === kind);
}

function compareRemainingSnapshots(
  before: readonly AgentZeroProjectRuntimeResource[],
  after: readonly AgentZeroProjectRuntimeResource[],
  removedKinds: ReadonlySet<AgentZeroProjectRuntimeResourceKind>,
): void {
  compareResourceSnapshots(
    before.filter((value) => !removedKinds.has(value.kind)),
    after.filter((value) => !removedKinds.has(value.kind)),
  );
}

async function removeContainer(
  executor: ProjectEgressCommandExecutor,
  value: AgentZeroProjectRuntimeResource,
): Promise<void> {
  const inspect = await strictInspectOne<DockerContainerInspect>(executor, 'container', value.name);
  if (!inspect) fail('CLEANUP_RACE', 'Agent Zero Project container disappeared before cleanup');
  const current = containerResources(inspect, value.name, value.projectIdentityId)
    .find((candidate) => candidate.kind === 'CONTAINER')!;
  if (current.dockerId !== value.dockerId || current.snapshotFingerprint !== value.snapshotFingerprint) {
    fail('CLEANUP_RACE', 'Agent Zero Project container changed before cleanup');
  }
  if (inspect.State?.Running === true) {
    requireCommandSuccess(
      await executor.run('docker', ['container', 'stop', '--time', '10', value.dockerId!]),
      'Agent Zero Project container stop failed',
    );
    const stopped = await strictInspectOne<DockerContainerInspect>(executor, 'container', value.dockerId!);
    if (!stopped || stopped.State?.Running === true
      || requiredDockerId(stopped.Id, 'stopped Agent Zero container') !== value.dockerId) {
      fail('CLEANUP_FAILED', 'Agent Zero Project container did not stop with the same immutable id');
    }
  }
  requireCommandSuccess(
    await executor.run('docker', ['container', 'rm', value.dockerId!]),
    'Agent Zero Project container removal failed',
  );
  if (await strictInspectOne<DockerContainerInspect>(executor, 'container', value.dockerId!)
    || await strictInspectOne<DockerContainerInspect>(executor, 'container', value.name)) {
    fail('CLEANUP_FAILED', 'Agent Zero Project container still exists after removal');
  }
}

async function removeFirewall(
  executor: ProjectEgressCommandExecutor,
  value: AgentZeroProjectRuntimeResource,
): Promise<void> {
  const result = await executor.run('iptables', ['-w', '5', '-S']);
  if (result.exitCode !== 0) {
    fail('CLEANUP_RACE', 'Agent Zero firewall could not be re-attested before cleanup');
  }
  const lines = result.stdout.split(/\r?\n/).map(normalizeFirewallLine).filter(Boolean);
  const current = lines.filter((line) => line.startsWith(`-A ${value.name} `)
    || line.includes(` -j ${value.name}`)
    || line.includes(` -g ${value.name}`)).sort();
  if (JSON.stringify(current) !== JSON.stringify([...value.firewallStatements].sort())) {
    fail('CLEANUP_RACE', 'Agent Zero firewall changed before cleanup');
  }
  for (const statement of current.filter((line) => !line.startsWith(`-A ${value.name} `))) {
    const tokens = statement.split(/\s+/);
    if (tokens[0] !== '-A' || ![INPUT_CHAIN, DOCKER_USER_CHAIN].includes(tokens[1])) {
      fail('FIREWALL_IDENTITY', 'Agent Zero firewall has an unsafe parent reference');
    }
    requireCommandSuccess(
      await executor.run('iptables', ['-w', '5', '-D', tokens[1], ...tokens.slice(2)]),
      'Agent Zero firewall parent jump removal failed',
    );
  }
  requireCommandSuccess(
    await executor.run('iptables', ['-w', '5', '-F', value.name]),
    'Agent Zero firewall chain flush failed',
  );
  requireCommandSuccess(
    await executor.run('iptables', ['-w', '5', '-X', value.name]),
    'Agent Zero firewall chain removal failed',
  );
}

async function removeVolume(
  executor: ProjectEgressCommandExecutor,
  value: AgentZeroProjectRuntimeResource,
): Promise<void> {
  const inspect = await strictInspectOne<DockerVolumeInspect>(executor, 'volume', value.name);
  if (!inspect) fail('CLEANUP_RACE', 'Agent Zero Project volume disappeared before cleanup');
  const current = volumeResource(inspect, value.name, value.projectIdentityId);
  if (current.snapshotFingerprint !== value.snapshotFingerprint) {
    fail('CLEANUP_RACE', 'Agent Zero Project volume changed before cleanup');
  }
  requireCommandSuccess(
    await executor.run('docker', ['volume', 'rm', value.name]),
    'Agent Zero Project volume removal failed',
  );
  if (await strictInspectOne<DockerVolumeInspect>(executor, 'volume', value.name)) {
    fail('CLEANUP_FAILED', 'Agent Zero Project volume still exists after removal');
  }
}

function removeModelBridgeCredential(
  value: AgentZeroProjectRuntimeResource,
  options: AgentZeroProjectRuntimeDiscoveryOptions,
): void {
  const projectKey = requiredProjectKey(value.projectKey, 'Agent Zero model bridge cleanup key');
  const credentialRoot = resolveAgentZeroProjectModelBridgeCredentialRoot(options.credentialRoot);
  const expectedPath = agentZeroProjectModelBridgeCredentialPath(projectKey, credentialRoot);
  if (value.name !== expectedPath) {
    fail('STATE_IDENTITY', 'Agent Zero model bridge cleanup path is not deterministic');
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const record = readAgentZeroProjectModelBridgeCredentialRecord(projectKey, {
    credentialRoot,
    expectedOwnerUid: currentUid,
  });
  if (!record || record.projectIdentityId !== value.projectIdentityId) {
    fail('CLEANUP_RACE', 'Agent Zero model bridge credential changed before cleanup');
  }
  const current = modelBridgeCredentialResource(record, expectedPath);
  if (current.snapshotFingerprint !== value.snapshotFingerprint) {
    fail('CLEANUP_RACE', 'Agent Zero model bridge credential changed before cleanup');
  }
  if (!revokeAgentZeroProjectModelBridgeCredential(projectKey, {
    credentialRoot,
    expectedOwnerUid: currentUid,
  })) {
    fail('CLEANUP_FAILED', 'Agent Zero model bridge credential could not be revoked');
  }
  if (readAgentZeroProjectModelBridgeCredentialRecord(projectKey, {
    credentialRoot,
    expectedOwnerUid: currentUid,
  })) {
    fail('CLEANUP_FAILED', 'Agent Zero model bridge credential survived revocation');
  }
}

function removeStateDirectory(
  value: AgentZeroProjectRuntimeResource,
  projectIdentityId: string,
): void {
  const projectKey = requiredProjectKey(value.projectKey, 'Agent Zero cleanup state key');
  const projectFingerprint = stableHash({ projectId: projectIdentityId });
  const stateRoot = path.dirname(value.name);
  const normalName = projectKey;
  const tombstoneName = `${projectKey}.cleanup.${projectFingerprint}`;
  const currentName = path.basename(value.name);
  if (currentName !== normalName && currentName !== tombstoneName) {
    fail('STATE_IDENTITY', 'Agent Zero cleanup state directory name is invalid');
  }
  let directory = value.name;
  const current = stateResources(projectIdentityId, stateRoot)
    .find((candidate) => candidate.kind === 'STATE_DIRECTORY' && candidate.name === value.name);
  if (!current || current.snapshotFingerprint !== value.snapshotFingerprint) {
    fail('CLEANUP_RACE', 'Agent Zero protected state changed before cleanup');
  }
  if (currentName === normalName) {
    const tombstone = path.join(stateRoot, tombstoneName);
    if (fs.existsSync(tombstone)) fail('CLEANUP_RACE', 'Agent Zero cleanup tombstone already exists');
    fs.renameSync(directory, tombstone);
    directory = tombstone;
  }
  protectedStat(directory, 'directory');
  const names = fs.readdirSync(directory).sort();
  if (names.some((name) => !ALLOWED_STATE_FILES.has(name))) {
    fail('STATE_CONTENTS', 'Agent Zero cleanup tombstone contains an unexpected file');
  }
  for (const fileName of [
    'qualification.json',
    'model-bridge.env',
    'agent-zero.env',
    'identity.json',
  ]) {
    const filePath = path.join(directory, fileName);
    if (!fs.existsSync(filePath)) continue;
    protectedStat(filePath, 'file');
    fs.unlinkSync(filePath);
  }
  fs.rmdirSync(directory);
}

/**
 * Destructively remove only resources proven to belong to one immutable
 * ProjectIdentity. Discovery is repeated before mutation and after every
 * ownership boundary; shared proxy/networks are deliberately left to the
 * Project egress cleanup adapter after runtime membership is gone.
 */
export async function teardownAgentZeroProjectRuntimeResources(
  projectIdentityIdInput: string,
  options: AgentZeroProjectRuntimeDiscoveryOptions = {},
  executor: ProjectEgressCommandExecutor = projectEgressCommandExecutor,
): Promise<AgentZeroProjectRuntimeTeardownResult> {
  const projectIdentityId = requiredProjectIdentityId(projectIdentityIdInput);
  const initial = await discoverAgentZeroProjectRuntimeResources(projectIdentityId, options, executor);
  const second = await discoverAgentZeroProjectRuntimeResources(projectIdentityId, options, executor);
  compareResourceSnapshots(initial, second);

  for (const container of resourcesOfKind(second, 'CONTAINER')) await removeContainer(executor, container);
  const afterContainers = await discoverAgentZeroProjectRuntimeResources(projectIdentityId, options, executor);
  if (resourcesOfKind(afterContainers, 'CONTAINER').length > 0
    || resourcesOfKind(afterContainers, 'NETWORK_MEMBERSHIP').length > 0) {
    fail('RESIDUAL_RESOURCE', 'Agent Zero container or network membership survived cleanup');
  }
  compareRemainingSnapshots(second, afterContainers, new Set(['CONTAINER', 'NETWORK_MEMBERSHIP']));

  for (const firewall of resourcesOfKind(afterContainers, 'FIREWALL_CHAIN')) {
    await removeFirewall(executor, firewall);
  }
  const afterFirewall = await discoverAgentZeroProjectRuntimeResources(projectIdentityId, options, executor);
  if (resourcesOfKind(afterFirewall, 'FIREWALL_CHAIN').length > 0) {
    fail('RESIDUAL_RESOURCE', 'Agent Zero firewall survived cleanup');
  }
  compareRemainingSnapshots(afterContainers, afterFirewall, new Set(['FIREWALL_CHAIN']));

  for (const volume of resourcesOfKind(afterFirewall, 'DATA_VOLUME')) await removeVolume(executor, volume);
  const afterVolumes = await discoverAgentZeroProjectRuntimeResources(projectIdentityId, options, executor);
  if (resourcesOfKind(afterVolumes, 'DATA_VOLUME').length > 0) {
    fail('RESIDUAL_RESOURCE', 'Agent Zero data volume survived cleanup');
  }
  compareRemainingSnapshots(afterFirewall, afterVolumes, new Set(['DATA_VOLUME']));

  for (const credential of resourcesOfKind(afterVolumes, 'MODEL_BRIDGE_CREDENTIAL')) {
    removeModelBridgeCredential(credential, options);
  }
  const afterCredentials = await discoverAgentZeroProjectRuntimeResources(
    projectIdentityId,
    options,
    executor,
  );
  if (resourcesOfKind(afterCredentials, 'MODEL_BRIDGE_CREDENTIAL').length > 0) {
    fail('RESIDUAL_RESOURCE', 'Agent Zero model bridge credential survived cleanup');
  }
  compareRemainingSnapshots(
    afterVolumes,
    afterCredentials,
    new Set(['MODEL_BRIDGE_CREDENTIAL']),
  );

  for (const state of resourcesOfKind(afterCredentials, 'STATE_DIRECTORY')) {
    removeStateDirectory(state, projectIdentityId);
  }
  const final = await discoverAgentZeroProjectRuntimeResources(projectIdentityId, options, executor);
  if (final.length > 0) fail('RESIDUAL_RESOURCE', 'Agent Zero Project cleanup left managed resources behind');
  return {
    projectIdentityId,
    discoveredResourceCount: initial.length,
    removedResourceCount: initial.length,
    alreadyAbsent: initial.length === 0,
  };
}

export const __agentZeroProjectCleanupTest = {
  stableHash,
  expectedContainerName,
  expectedVolumeName,
};
