import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../../AgentProvider.interface';
import { assertExecutionContextBinding } from '../../executionScope';
import { ensureRuntimeDirectory } from '../../../utils/runtimeDirectory';
import { attestProjectRoot } from '../../../services/projectIdentity';
import {
  PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL,
  buildProjectEgressPlaneSpec,
  constrainProjectRuntimeToEgressPlane,
  derivePreConfinementProjectEgressPolicyFingerprint,
  ensureProjectEgressPlane,
  projectEgressCommandExecutor,
  resolveRecognizedProjectEgressInternalNetworkBinding,
  type ProjectEgressCommandExecutor,
  type ProjectEgressInternalNetworkBinding,
  type ProjectEgressPlaneConfig,
  type ProjectEgressPlaneHandle,
  type ProjectEgressPlaneSpec,
} from '../../../services/projectEgressPlane';
import { PROJECT_EGRESS_POLICY_VERSION } from '../../../services/projectEgressPolicy';
import {
  AgentZeroAuthSessionManager,
  readProtectedAgentZeroCredentials,
  type AgentZeroCredentials,
} from './AgentZeroAuthSession';
import { AgentZeroConnectorClient } from './AgentZeroConnectorClient';
import {
  AGENT_ZERO_CONNECTOR_PROTOCOL,
  AGENT_ZERO_CONNECTOR_VERSION,
  AGENT_ZERO_VERSION,
} from './AgentZeroConnectorContract';
import {
  AGENT_ZERO_CONTAINER_PORT,
  AGENT_ZERO_DATA_CONTAINER_PATH,
} from './AgentZeroRuntime';
import {
  AGENT_ZERO_PROJECT_IMAGE_RECIPE_LABEL,
  AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER_LABEL,
  AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER,
  AGENT_ZERO_PROJECT_IMAGE_SOURCE_COMMIT_LABEL,
  AGENT_ZERO_PROJECT_IMAGE_UPSTREAM_DIGEST_LABEL,
  getAgentZeroProjectSandboxImageId,
  getAgentZeroProjectSourceCommit,
  getAgentZeroProjectUpstreamImageRef,
} from './AgentZeroProjectImage';
import {
  attestAgentZeroProjectEgressPlane,
  expectedAgentZeroProxyEnvironment,
  installAgentZeroProjectFirewall,
  resolveAgentZeroProjectBridgeGatewayIpv4,
  resolveAgentZeroProjectEgressConfig,
  resolveAgentZeroProjectRuntimeIpv4,
  type AgentZeroProjectCommandRunner,
  type AgentZeroProjectEgressAttestation,
} from './AgentZeroProjectEgress';
import {
  AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT,
  AGENT_ZERO_PROJECT_MODEL_BRIDGE_POLICY_VERSION,
  agentZeroProjectModelBridgeApiKeyEnvironmentName,
  authenticateAgentZeroProjectModelBridgeCredential,
  buildAgentZeroProjectModelBridgeBaseUrl,
  issueAgentZeroProjectModelBridgeCredential,
  normalizeAgentZeroProjectModelSelection,
  parseAgentZeroProjectModelBridgeToken,
  type AgentZeroProjectModelBridgeCredential,
  type AgentZeroProjectModelSelection,
  type AgentZeroProjectOAuthProviderId,
} from './AgentZeroProjectModelBridgeCredential';
import {
  assertProjectRuntimeConfinementReadyForExecution,
  attestPreConfinementProjectRuntimeSecurityOptions,
  attestProjectRuntimeSecurityOptions,
  projectRuntimeSecurityOptArgs,
  projectRuntimeSecurityOptionValues,
} from '../../../services/projectRuntimeConfinement';

export const AGENT_ZERO_PROJECT_RUNTIME = 'agent-zero-project-sandbox-v4';
export const AGENT_ZERO_PROJECT_POLICY_VERSION = 'agent-zero-project-isolation-v4';
export const AGENT_ZERO_PROJECT_NETWORK_POLICY = PROJECT_EGRESS_POLICY_VERSION;
export const AGENT_ZERO_PROJECT_ROOT = '/a0/usr/projects/portal';
export const AGENT_ZERO_PROJECT_IDENTITY_SCHEMA = 'bridgesllm.agent-zero-project-identity.v2';
export const AGENT_ZERO_PROJECT_QUALIFICATION_SCHEMA = 'bridgesllm.agent-zero-project-qualification.v5';
export const AGENT_ZERO_PROJECT_QUALIFICATION_TTL_MS = 24 * 60 * 60_000;
export const AGENT_ZERO_PROJECT_RUNTIME_UID = 1000;
export const AGENT_ZERO_PROJECT_RUNTIME_GID = 1000;
export const AGENT_ZERO_PROJECT_IMAGE_COMMAND = Object.freeze([
  '/opt/venv-a0/bin/python',
  '/a0/run_ui.py',
  '--dockerized=true',
  '--port=80',
  '--host=0.0.0.0',
] as const);

export const AGENT_ZERO_PROJECT_MANAGED_LABEL = 'io.bridgesllm.managed';
export const AGENT_ZERO_PROJECT_RUNTIME_LABEL = 'io.bridgesllm.runtime';
export const AGENT_ZERO_PROJECT_POLICY_LABEL = 'io.bridgesllm.policy';
export const AGENT_ZERO_PROJECT_KEY_LABEL = 'io.bridgesllm.project-key';
export const AGENT_ZERO_PROJECT_ID_LABEL = 'io.bridgesllm.project-id';
export const AGENT_ZERO_PROJECT_ACTOR_LABEL = 'io.bridgesllm.actor-id';
export const AGENT_ZERO_PROJECT_VOLUME_ROLE_LABEL = 'io.bridgesllm.volume-role';
export const AGENT_ZERO_PROJECT_DATA_VOLUME_ROLE = 'agent-zero-project-data';
const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;
const RUNTIME_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const RUNTIME_NANO_CPUS = 2_000_000_000;
const RUNTIME_PIDS_LIMIT = 512;
const PROXY_ENV_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
]);

type CommandRunner = AgentZeroProjectCommandRunner;

export interface AgentZeroProjectRuntimeDescriptor {
  key: string;
  actorUserId: string;
  projectIdentityId: string;
  stateRoot: string;
  stateDir: string;
  identityFile: string;
  authFile: string;
  modelBridgeEnvFile: string;
  qualificationFile: string;
  containerName: string;
  dataVolume: string;
  canonicalProjectRoot: string;
}

export interface AgentZeroProjectRuntimeIdentity {
  schema: typeof AGENT_ZERO_PROJECT_IDENTITY_SCHEMA;
  runtime: typeof AGENT_ZERO_PROJECT_RUNTIME;
  policyVersion: typeof AGENT_ZERO_PROJECT_POLICY_VERSION;
  actorUserId: string;
  projectIdentityId: string;
  projectKey: string;
  canonicalProjectRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  identityFingerprint: string;
}

export interface AgentZeroProjectQualification {
  schema: typeof AGENT_ZERO_PROJECT_QUALIFICATION_SCHEMA;
  policyVersion: typeof AGENT_ZERO_PROJECT_POLICY_VERSION;
  networkPolicy: typeof AGENT_ZERO_PROJECT_NETWORK_POLICY;
  runtime: typeof AGENT_ZERO_PROJECT_RUNTIME;
  projectKey: string;
  actorUserId: string;
  projectIdentityId: string;
  identityFingerprint: string;
  policyFingerprint: string;
  egressPolicyFingerprint: string;
  runtimeFingerprint: string;
  containerId: string;
  containerStartedAt: string;
  imageRef: string;
  dataVolumeMountpoint: string;
  protocol: typeof AGENT_ZERO_CONNECTOR_PROTOCOL;
  connectorVersion: typeof AGENT_ZERO_CONNECTOR_VERSION;
  agentZeroVersion: typeof AGENT_ZERO_VERSION;
  modelBridgePolicyVersion: typeof AGENT_ZERO_PROJECT_MODEL_BRIDGE_POLICY_VERSION;
  modelBridgePort: typeof AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT;
  modelBridgeGatewayIpv4: string;
  runtimeIpv4: string;
  modelBridgeCredentialHash: string;
  modelBridgeCredentialGeneration: string;
  oauthProviderId: AgentZeroProjectOAuthProviderId;
  model: string;
  modelPresetName: string;
  connectorAuthenticated: true;
  hostGatewayDisconnected: true;
  runtimeUid: typeof AGENT_ZERO_PROJECT_RUNTIME_UID;
  runtimeGid: typeof AGENT_ZERO_PROJECT_RUNTIME_GID;
  projectWriteProbe: true;
  projectReadProbe: true;
  projectUnlinkProbe: true;
  hostEscapeProbe: true;
  networkEscapeProbe: true;
  publicHttpsProbe: true;
  bridgeGatewayProbe: true;
  modelBridgeReachabilityProbe: true;
  websocketReplayProbe: true;
  modelRoundTripProbe: true;
  qualifiedAt: string;
  expiresAt: string;
}

export interface AgentZeroProjectRuntimeStatus {
  ready: boolean;
  selectable: boolean;
  reason: string;
  descriptor: AgentZeroProjectRuntimeDescriptor;
  imageRef?: string;
  containerId?: string;
  containerStartedAt?: string;
  baseUrl?: string;
  hostPort?: number;
  egressPolicyFingerprint?: string;
  runtimeFingerprint?: string;
  internalNetworkName?: string;
  bridgeGatewayIpv4?: string;
  runtimeIpv4?: string;
  modelBridgeBaseUrl?: string;
  modelBridgeCredentialHash?: string;
  modelBridgeCredentialGeneration?: string;
  modelSelection?: AgentZeroProjectModelSelection;
  modelPresetName?: string;
  dataVolumeMountpoint?: string;
  structuralIsolation: boolean;
  volumeProvenance: boolean;
  egressPlaneReady: boolean;
  firewallReady: boolean;
  connectorReady: boolean;
  authenticated: boolean;
  hostGatewayDisconnected: boolean;
  qualificationCurrent: boolean;
}

export interface AgentZeroProjectProbeOptions {
  stateRoot?: string;
  architecture?: string;
  sandboxImageId?: string;
  runCommand?: CommandRunner;
  readFile?: (filePath: string) => string;
  statFile?: (filePath: string) => fs.Stats;
  statVolumeRoot?: (filePath: string) => fs.Stats;
  now?: () => number;
  egress?: ProjectEgressPlaneConfig;
  modelSelection?: AgentZeroProjectModelSelection;
  credentialRoot?: string;
  assertConfinementReady?: () => void;
}

export interface AgentZeroProjectRuntimeHandle extends AgentZeroProjectRuntimeStatus {
  ready: true;
  baseUrl: string;
  hostPort: number;
  containerId: string;
  imageRef: string;
  client: AgentZeroConnectorClient;
  auth: AgentZeroAuthSessionManager;
  modelSelection: AgentZeroProjectModelSelection;
  modelPresetName: string;
}

export interface AgentZeroProjectConvergeOptions extends AgentZeroProjectProbeOptions {
  passwordFactory?: () => string;
  egressExecutor?: ProjectEgressCommandExecutor;
  buildEgressSpec?: (config: ProjectEgressPlaneConfig) => ProjectEgressPlaneSpec;
  ensureEgressPlane?: (
    config: ProjectEgressPlaneConfig,
    executor: ProjectEgressCommandExecutor,
  ) => Promise<ProjectEgressPlaneHandle>;
  constrainRuntime?: typeof constrainProjectRuntimeToEgressPlane;
  resolveInternalNetworkBinding?: (
    executor: ProjectEgressCommandExecutor,
    spec: ProjectEgressPlaneSpec,
  ) => Promise<ProjectEgressInternalNetworkBinding | null>;
  bridgeTokenFactory?: () => string;
  bridgeGenerationFactory?: () => string;
  bridgeCredentialTtlMs?: number;
}

export interface AgentZeroProjectIdentityRuntimeAttestationInput {
  context: ProjectSandboxExecutionContext;
  descriptor: AgentZeroProjectRuntimeDescriptor;
  expectedContainerId: string;
  expectedContainerStartedAt: string;
  imageRef: string;
  spec: ProjectEgressPlaneSpec;
  expectedRuntimeFingerprint: string;
  bridgeGatewayIpv4: string;
  runtimeIpv4: string;
  expectedInternalNetworkId: string;
  modelSelection: AgentZeroProjectModelSelection;
}

function defaultRunCommand(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    maxBuffer: MAX_COMMAND_OUTPUT,
  }).trim();
}

function resolveAgentZeroProjectImage(
  context: ProjectSandboxExecutionContext,
  options: AgentZeroProjectProbeOptions,
): string | null {
  if (!getAgentZeroProjectSourceCommit(options.architecture || process.arch)) return null;
  const imageId = getAgentZeroProjectSandboxImageId(options.sandboxImageId);
  return imageId && context.runtimeImageDigest === imageId ? imageId : null;
}

function expectedDerivedImageIdentity(architecture: string): {
  architecture: 'amd64' | 'arm64';
  sourceCommit: string;
  upstreamDigest: string;
} | null {
  const sourceCommit = getAgentZeroProjectSourceCommit(architecture);
  const upstreamRef = getAgentZeroProjectUpstreamImageRef(architecture);
  if (!sourceCommit || !upstreamRef) return null;
  const upstreamDigest = upstreamRef.split('@')[1] || '';
  const normalizedArchitecture = upstreamDigest
    ? (['arm64', 'aarch64'].includes(architecture) ? 'arm64' : 'amd64')
    : null;
  if (!normalizedArchitecture || !/^sha256:[a-f0-9]{64}$/.test(upstreamDigest)) return null;
  return { architecture: normalizedArchitecture, sourceCommit, upstreamDigest };
}

function exactDerivedImageLabels(
  labelsInput: unknown,
  architecture: string,
): boolean {
  const labels = isRecord(labelsInput) ? labelsInput : {};
  const expected = expectedDerivedImageIdentity(architecture);
  return Boolean(expected)
    && /^[a-f0-9]{64}$/.test(String(labels[AGENT_ZERO_PROJECT_IMAGE_RECIPE_LABEL] || ''))
    && labels[AGENT_ZERO_PROJECT_IMAGE_SOURCE_COMMIT_LABEL] === expected!.sourceCommit
    && labels[AGENT_ZERO_PROJECT_IMAGE_UPSTREAM_DIGEST_LABEL] === expected!.upstreamDigest
    && labels[AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER_LABEL] === AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER;
}

function exactDerivedImageInspect(
  inspect: Record<string, any>,
  imageRef: string,
  architecture: string,
): boolean {
  const expected = expectedDerivedImageIdentity(architecture);
  return Boolean(expected)
    && String(inspect.Id || '').toLowerCase() === imageRef
    && String(inspect.Os || '').toLowerCase() === 'linux'
    && String(inspect.Architecture || '').toLowerCase() === expected!.architecture
    && exactDerivedImageLabels(inspect.Config?.Labels, architecture);
}

export function resolveAgentZeroProjectStateRoot(override?: string): string {
  const configured = String(override || process.env.PORTAL_AGENT_ZERO_PROJECT_STATE_ROOT || '').trim();
  if (configured) return path.resolve(configured);
  const portalRoot = path.resolve(process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || '/portal');
  return path.join(portalRoot, '.data', 'project-sandboxes', 'agent-zero');
}

function pathContains(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requireCanonicalProjectRoot(context: ProjectSandboxExecutionContext): string {
  assertExecutionContextBinding(context, context.userId, 'PROJECT_SANDBOX');
  if (context.runtimePolicyVersion !== AGENT_ZERO_PROJECT_POLICY_VERSION) {
    throw new Error('Agent Zero Project runtime policy version does not match the execution context');
  }
  if (context.egressPolicyVersion !== PROJECT_EGRESS_POLICY_VERSION) {
    throw new Error('Agent Zero Project egress policy version does not match the shared policy');
  }
  if (!/^[a-f0-9]{64}$/i.test(context.policyFingerprint)) {
    throw new Error('Agent Zero Project policy fingerprint is invalid');
  }
  const root = attestProjectRoot(context.canonicalRoot);
  if (root.canonicalRoot !== path.resolve(context.canonicalRoot)
    || root.rootDevice !== context.rootDevice
    || root.rootInode !== context.rootInode
    || root.rootBirthtimeNs !== context.rootBirthtimeNs
    || root.canonicalRoot === path.parse(root.canonicalRoot).root) {
    throw new Error('Agent Zero project root must be canonical and may not be a filesystem root');
  }
  return root.canonicalRoot;
}

function projectKey(context: ProjectSandboxExecutionContext): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    runtime: AGENT_ZERO_PROJECT_RUNTIME,
    policy: AGENT_ZERO_PROJECT_POLICY_VERSION,
    userId: context.userId,
    projectId: context.projectId,
    canonicalRoot: context.canonicalRoot,
    policyFingerprint: context.policyFingerprint,
  })).digest('hex');
}

export function describeAgentZeroProjectRuntime(
  context: ProjectSandboxExecutionContext,
  stateRootOverride?: string,
): AgentZeroProjectRuntimeDescriptor {
  const canonicalProjectRoot = requireCanonicalProjectRoot(context);
  const stateRoot = resolveAgentZeroProjectStateRoot(stateRootOverride);
  if (pathContains(canonicalProjectRoot, stateRoot) || pathContains(stateRoot, canonicalProjectRoot)) {
    throw new Error('Agent Zero project files and protected runtime state must not overlap');
  }
  const key = projectKey({ ...context, canonicalRoot: canonicalProjectRoot });
  const short = key.slice(0, 24);
  return {
    key,
    actorUserId: context.userId,
    projectIdentityId: context.projectId,
    stateRoot,
    stateDir: path.join(stateRoot, key),
    identityFile: path.join(stateRoot, key, 'identity.json'),
    authFile: path.join(stateRoot, key, 'agent-zero.env'),
    modelBridgeEnvFile: path.join(stateRoot, key, 'model-bridge.env'),
    qualificationFile: path.join(stateRoot, key, 'qualification.json'),
    containerName: `bridgesllm-a0p-${short}`,
    dataVolume: `bridgesllm-a0p-${short}-usr`,
    canonicalProjectRoot,
  };
}

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildAgentZeroProjectRuntimeIdentity(
  context: ProjectSandboxExecutionContext,
  descriptor: AgentZeroProjectRuntimeDescriptor,
): AgentZeroProjectRuntimeIdentity {
  if (descriptor.actorUserId !== context.userId
    || descriptor.projectIdentityId !== context.projectId
    || descriptor.canonicalProjectRoot !== context.canonicalRoot) {
    throw new Error('Agent Zero Project runtime identity does not match its immutable execution context.');
  }
  const identity = {
    schema: AGENT_ZERO_PROJECT_IDENTITY_SCHEMA,
    runtime: AGENT_ZERO_PROJECT_RUNTIME,
    policyVersion: AGENT_ZERO_PROJECT_POLICY_VERSION,
    actorUserId: context.userId,
    projectIdentityId: context.projectId,
    projectKey: descriptor.key,
    canonicalProjectRoot: descriptor.canonicalProjectRoot,
    rootDevice: context.rootDevice,
    rootInode: context.rootInode,
    rootBirthtimeNs: context.rootBirthtimeNs,
  } as const;
  return Object.freeze({
    ...identity,
    identityFingerprint: stableHash(identity),
  });
}

function buildAgentZeroProjectRuntimeFingerprintValue(input: {
  context: ProjectSandboxExecutionContext;
  descriptor: AgentZeroProjectRuntimeDescriptor;
  imageRef: string;
  spec: ProjectEgressPlaneSpec;
  bridgeGatewayIpv4: string;
  runtimeIpv4?: string;
  modelBridgeCredential: AgentZeroProjectModelBridgeCredential;
  includeConfinement?: boolean;
}): string {
  const identity = buildAgentZeroProjectRuntimeIdentity(input.context, input.descriptor);
  const selection = normalizeAgentZeroProjectModelSelection({
    providerId: input.modelBridgeCredential.record.providerId,
    model: input.modelBridgeCredential.record.model,
  });
  return stableHash({
    runtime: AGENT_ZERO_PROJECT_RUNTIME,
    runtimePolicy: AGENT_ZERO_PROJECT_POLICY_VERSION,
    egressPolicy: PROJECT_EGRESS_POLICY_VERSION,
    egressPolicyFingerprint: input.spec.policyFingerprint,
    actorId: input.context.userId,
    projectId: input.context.projectId,
    projectKey: input.descriptor.key,
    identityFingerprint: identity.identityFingerprint,
    projectRoot: input.descriptor.canonicalProjectRoot,
    rootDevice: input.context.rootDevice,
    rootInode: input.context.rootInode,
    rootBirthtimeNs: input.context.rootBirthtimeNs,
    imageRef: input.imageRef,
    ...(input.runtimeIpv4 ? { runtimeIpv4: input.runtimeIpv4 } : {}),
    modelBridge: {
      policyVersion: AGENT_ZERO_PROJECT_MODEL_BRIDGE_POLICY_VERSION,
      gatewayIpv4: input.bridgeGatewayIpv4,
      port: AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT,
      providerId: selection.providerId,
      model: selection.model,
      credentialHash: input.modelBridgeCredential.record.tokenHash,
      credentialGeneration: input.modelBridgeCredential.record.generation,
      baseUrl: buildAgentZeroProjectModelBridgeBaseUrl(
        input.bridgeGatewayIpv4,
        selection.providerId,
      ),
    },
    mounts: [
      `${input.descriptor.dataVolume}:${AGENT_ZERO_DATA_CONTAINER_PATH}:rw`,
      `${input.descriptor.canonicalProjectRoot}:${AGENT_ZERO_PROJECT_ROOT}:rw`,
    ],
    authEnvironmentFile: input.descriptor.authFile,
    network: input.spec.internalNetworkName,
    proxyEnvironment: expectedAgentZeroProxyEnvironment(input.spec, input.bridgeGatewayIpv4),
    modelBridgeEnvironmentFile: input.descriptor.modelBridgeEnvFile,
    hostPort: `127.0.0.1:${AGENT_ZERO_CONTAINER_PORT}`,
    ...(input.includeConfinement === false
      ? {}
      : { confinementSecurityOptions: projectRuntimeSecurityOptionValues() }),
  });
}

export function buildAgentZeroProjectRuntimeFingerprint(input: {
  context: ProjectSandboxExecutionContext;
  descriptor: AgentZeroProjectRuntimeDescriptor;
  imageRef: string;
  spec: ProjectEgressPlaneSpec;
  bridgeGatewayIpv4: string;
  runtimeIpv4: string;
  modelBridgeCredential: AgentZeroProjectModelBridgeCredential;
}): string {
  return buildAgentZeroProjectRuntimeFingerprintValue(input);
}

export function buildAgentZeroProjectLegacyRuntimeFingerprint(input: {
  context: ProjectSandboxExecutionContext;
  descriptor: AgentZeroProjectRuntimeDescriptor;
  imageRef: string;
  spec: ProjectEgressPlaneSpec;
  bridgeGatewayIpv4: string;
  modelBridgeCredential: AgentZeroProjectModelBridgeCredential;
}): string {
  return buildAgentZeroProjectRuntimeFingerprintValue({
    ...input,
    spec: {
      ...input.spec,
      policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(input.spec),
    },
    includeConfinement: false,
  });
}

export function buildAgentZeroProjectContainerCreateArgs(
  input: {
    descriptor: AgentZeroProjectRuntimeDescriptor;
    imageRef: string;
    spec: ProjectEgressPlaneSpec;
    internalNetworkId: string;
    runtimeFingerprint: string;
    bridgeGatewayIpv4: string;
    runtimeIpv4: string;
    modelBridgeCredential: AgentZeroProjectModelBridgeCredential;
  },
): string[] {
  const {
    descriptor,
    imageRef,
    spec,
    runtimeFingerprint,
    bridgeGatewayIpv4,
  } = input;
  const proxyEnvironment = expectedAgentZeroProxyEnvironment(spec, bridgeGatewayIpv4);
  return [
    'container', 'create',
    '--name', descriptor.containerName,
    '--hostname', 'agent-zero-project',
    '--init',
    '--user', AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER,
    '--read-only',
    '--cap-drop', 'ALL',
    ...projectRuntimeSecurityOptArgs(),
    '--pids-limit', String(RUNTIME_PIDS_LIMIT),
    '--memory', String(RUNTIME_MEMORY_BYTES),
    '--memory-swap', String(RUNTIME_MEMORY_BYTES),
    '--cpus', '2',
    '--ulimit', 'nofile=1024:1024',
    '--ulimit', 'nproc=512:512',
    '--restart', 'no',
    '--stop-timeout', '30',
    '--network', input.internalNetworkId,
    '--ip', input.runtimeIpv4,
    '--publish', `127.0.0.1::${AGENT_ZERO_CONTAINER_PORT.replace('/tcp', '')}`,
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777',
    '--tmpfs', '/a0/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777',
    '--mount', `type=volume,source=${descriptor.dataVolume},target=${AGENT_ZERO_DATA_CONTAINER_PATH}`,
    '--mount', `type=bind,source=${descriptor.canonicalProjectRoot},target=${AGENT_ZERO_PROJECT_ROOT},bind-propagation=rprivate`,
    '--env-file', descriptor.authFile,
    '--env-file', descriptor.modelBridgeEnvFile,
    '--label', `${AGENT_ZERO_PROJECT_MANAGED_LABEL}=agent-zero-project`,
    '--label', `${AGENT_ZERO_PROJECT_RUNTIME_LABEL}=${AGENT_ZERO_PROJECT_RUNTIME}`,
    '--label', `${AGENT_ZERO_PROJECT_POLICY_LABEL}=${AGENT_ZERO_PROJECT_POLICY_VERSION}`,
    '--label', `${AGENT_ZERO_PROJECT_KEY_LABEL}=${descriptor.key}`,
    '--label', `${AGENT_ZERO_PROJECT_ID_LABEL}=${descriptor.projectIdentityId}`,
    '--label', `${AGENT_ZERO_PROJECT_ACTOR_LABEL}=${descriptor.actorUserId}`,
    '--label', `${PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL}=${runtimeFingerprint}`,
    ...Object.entries(proxyEnvironment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    imageRef,
  ];
}

export function buildAgentZeroProjectVolumeCreateArgs(
  descriptor: AgentZeroProjectRuntimeDescriptor,
): string[] {
  return [
    'volume', 'create',
    '--driver', 'local',
    '--label', `${AGENT_ZERO_PROJECT_MANAGED_LABEL}=agent-zero-project`,
    '--label', `${AGENT_ZERO_PROJECT_RUNTIME_LABEL}=${AGENT_ZERO_PROJECT_RUNTIME}`,
    '--label', `${AGENT_ZERO_PROJECT_POLICY_LABEL}=${AGENT_ZERO_PROJECT_POLICY_VERSION}`,
    '--label', `${AGENT_ZERO_PROJECT_KEY_LABEL}=${descriptor.key}`,
    '--label', `${AGENT_ZERO_PROJECT_ID_LABEL}=${descriptor.projectIdentityId}`,
    '--label', `${AGENT_ZERO_PROJECT_ACTOR_LABEL}=${descriptor.actorUserId}`,
    '--label', `${AGENT_ZERO_PROJECT_VOLUME_ROLE_LABEL}=${AGENT_ZERO_PROJECT_DATA_VOLUME_ROLE}`,
    descriptor.dataVolume,
  ];
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseSingleInspect(payload: string, label: string): Record<string, any> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error(`${label} returned an invalid inspection result`);
  }
  return parsed[0];
}

function dockerCommandErrorText(error: unknown): string {
  if (!isRecord(error)) return String(error || '');
  return [
    error.message,
    Buffer.isBuffer(error.stdout) ? error.stdout.toString('utf8') : error.stdout,
    Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : error.stderr,
  ].map((value) => String(value || '')).join('\n');
}

function isDockerContainerNotFound(error: unknown): boolean {
  const text = dockerCommandErrorText(error).toLowerCase();
  return text.includes('no such container')
    || text.includes('no such object')
    || (text.includes('container') && text.includes('not found'))
    || (text.includes('object') && text.includes('not found'));
}

function inspectOptionalAgentZeroContainer(
  runCommand: CommandRunner,
  reference: string,
): Record<string, any> | null {
  try {
    return parseSingleInspect(
      runCommand('docker', ['container', 'inspect', reference]),
      'Agent Zero project container',
    );
  } catch (error) {
    if (isDockerContainerNotFound(error)) return null;
    throw error;
  }
}

function exactAgentZeroContainerId(inspect: Record<string, any>): string {
  const containerId = String(inspect.Id || '');
  if (!/^[a-f0-9]{64}$/i.test(containerId)) {
    throw new Error('Agent Zero project container immutable ID is invalid.');
  }
  return containerId.toLowerCase();
}

function requireExactAgentZeroDockerId(value: unknown, label: string): string {
  const dockerId = String(value || '');
  if (!/^[a-f0-9]{64}$/i.test(dockerId)) {
    throw new Error(`${label} immutable ID is invalid.`);
  }
  return dockerId.toLowerCase();
}

function requireCreatedAgentZeroContainerId(output: string): string {
  const value = output.trim();
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('Created Agent Zero project container did not return one immutable ID.');
  }
  return value.toLowerCase();
}

function listExactAgentZeroProjectRuntimeIds(
  runCommand: CommandRunner,
  descriptor: AgentZeroProjectRuntimeDescriptor,
): string[] {
  const output = runCommand('docker', [
    'container', 'ls',
    '--all',
    '--no-trunc',
    '--filter', `label=${AGENT_ZERO_PROJECT_ID_LABEL}=${descriptor.projectIdentityId}`,
    '--filter', `label=${AGENT_ZERO_PROJECT_ACTOR_LABEL}=${descriptor.actorUserId}`,
    '--format', '{{.ID}}',
  ]);
  const ids = output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (ids.length > 8
    || ids.some((value) => !/^[a-f0-9]{64}$/i.test(value))
    || new Set(ids.map((value) => value.toLowerCase())).size !== ids.length) {
    throw new Error('Agent Zero project runtime identity inventory is invalid.');
  }
  return ids.map((value) => value.toLowerCase()).sort();
}

interface AgentZeroProjectRuntimeInventory {
  ids: string[];
  inspections: Record<string, any>[];
}

function inspectExactAgentZeroProjectRuntimeInventory(
  runCommand: CommandRunner,
  descriptor: AgentZeroProjectRuntimeDescriptor,
): AgentZeroProjectRuntimeInventory {
  const ids = listExactAgentZeroProjectRuntimeIds(runCommand, descriptor);
  const inspections = ids.map((containerId) => {
    const inspect = inspectOptionalAgentZeroContainer(runCommand, containerId);
    if (!inspect || exactAgentZeroContainerId(inspect) !== containerId) {
      throw new Error('Agent Zero project runtime identity inventory changed during inspection.');
    }
    return inspect;
  });
  return { ids, inspections };
}

function exactAgentZeroRuntimeInventoryEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveExactAgentZeroInternalNetworkId(
  runCommand: CommandRunner,
  spec: ProjectEgressPlaneSpec,
): string {
  const network = parseSingleInspect(
    runCommand('docker', ['network', 'inspect', spec.internalNetworkName]),
    'Agent Zero project internal egress network',
  );
  if (String(network.Name || '') !== spec.internalNetworkName) {
    throw new Error('Agent Zero project internal network name changed during inspection.');
  }
  return requireExactAgentZeroDockerId(
    network.Id,
    'Agent Zero project internal network',
  );
}

function protectedProjectCredentials(
  filePath: string,
  readFile: (filePath: string) => string,
  statFile: (filePath: string) => fs.Stats,
): AgentZeroCredentials | null {
  try {
    return readProtectedAgentZeroCredentials(filePath, readFile, statFile);
  } catch {
    return null;
  }
}

function readProtectedModelBridgeCredential(
  descriptor: AgentZeroProjectRuntimeDescriptor,
  options: AgentZeroProjectProbeOptions,
  readFile: (filePath: string) => string,
  statFile: (filePath: string) => fs.Stats,
): AgentZeroProjectModelBridgeCredential | null {
  try {
    const stat = statFile(descriptor.modelBridgeEnvFile);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid || (stat.mode & 0o077) !== 0) {
      return null;
    }
    const entries = readFile(descriptor.modelBridgeEnvFile).split(/\r?\n/).filter(Boolean);
    if (entries.length !== 1) return null;
    const separator = entries[0].indexOf('=');
    if (separator <= 0) return null;
    const key = entries[0].slice(0, separator);
    const token = entries[0].slice(separator + 1);
    const parsed = parseAgentZeroProjectModelBridgeToken(token);
    if (parsed.projectKey !== descriptor.key) return null;
    const providerId = ([
      'codex_oauth',
      'github_copilot_oauth',
      'gemini_api_oauth',
      'xai_grok_oauth',
    ] as AgentZeroProjectOAuthProviderId[]).find((candidate) => (
      agentZeroProjectModelBridgeApiKeyEnvironmentName(candidate) === key
    ));
    if (!providerId) return null;
    const record = authenticateAgentZeroProjectModelBridgeCredential(token, providerId, {
      credentialRoot: options.credentialRoot,
      now: options.now,
    });
    if (!record
      || record.actorUserId !== descriptor.actorUserId
      || record.projectIdentityId !== descriptor.projectIdentityId
      || (options.modelSelection
        && JSON.stringify(normalizeAgentZeroProjectModelSelection(options.modelSelection))
          !== JSON.stringify({ providerId: record.providerId, model: record.model }))) {
      return null;
    }
    return Object.freeze({ token, record });
  } catch {
    return null;
  }
}

export function buildAgentZeroProjectModelPresetName(
  descriptor: AgentZeroProjectRuntimeDescriptor,
): string {
  return `BridgesLLM Project OAuth ${descriptor.key.slice(0, 16)}`;
}

function exactMounts(inspect: Record<string, any>, descriptor: AgentZeroProjectRuntimeDescriptor): boolean {
  const mounts = Array.isArray(inspect.Mounts) ? inspect.Mounts : [];
  if (mounts.length !== 2) return false;
  const data = mounts.find((mount: any) => mount?.Destination === AGENT_ZERO_DATA_CONTAINER_PATH);
  const project = mounts.find((mount: any) => mount?.Destination === AGENT_ZERO_PROJECT_ROOT);
  return data?.Type === 'volume' && data?.Name === descriptor.dataVolume && data?.RW === true
    && project?.Type === 'bind' && project?.Source === descriptor.canonicalProjectRoot && project?.RW === true
    && (!project?.Propagation || project.Propagation === 'rprivate');
}

function exactVolumeProvenance(
  inspect: Record<string, any>,
  descriptor: AgentZeroProjectRuntimeDescriptor,
): string | null {
  const labels = inspect.Labels || {};
  const options = inspect.Options;
  const mountpoint = String(inspect.Mountpoint || '');
  const volumePathSuffix = path.join('volumes', descriptor.dataVolume, '_data');
  return inspect.Name === descriptor.dataVolume
    && inspect.Driver === 'local'
    && inspect.Scope === 'local'
    && (options == null || (isRecord(options) && Object.keys(options).length === 0))
    && labels[AGENT_ZERO_PROJECT_MANAGED_LABEL] === 'agent-zero-project'
    && labels[AGENT_ZERO_PROJECT_RUNTIME_LABEL] === AGENT_ZERO_PROJECT_RUNTIME
    && labels[AGENT_ZERO_PROJECT_POLICY_LABEL] === AGENT_ZERO_PROJECT_POLICY_VERSION
    && labels[AGENT_ZERO_PROJECT_KEY_LABEL] === descriptor.key
    && labels[AGENT_ZERO_PROJECT_ID_LABEL] === descriptor.projectIdentityId
    && labels[AGENT_ZERO_PROJECT_ACTOR_LABEL] === descriptor.actorUserId
    && labels[AGENT_ZERO_PROJECT_VOLUME_ROLE_LABEL] === AGENT_ZERO_PROJECT_DATA_VOLUME_ROLE
    && path.isAbsolute(mountpoint)
    && mountpoint.endsWith(volumePathSuffix)
      ? mountpoint
      : null;
}

function exactVolumeRuntimeOwner(
  mountpoint: string,
  statVolumeRoot: (filePath: string) => fs.Stats,
): boolean {
  try {
    const stat = statVolumeRoot(mountpoint);
    return stat.isDirectory()
      && !stat.isSymbolicLink()
      && stat.uid === AGENT_ZERO_PROJECT_RUNTIME_UID
      && stat.gid === AGENT_ZERO_PROJECT_RUNTIME_GID;
  } catch {
    return false;
  }
}

function exactPort(inspect: Record<string, any>): number | null {
  const bindings = inspect.HostConfig?.PortBindings;
  if (!isRecord(bindings) || Object.keys(bindings).length !== 1) return null;
  const values = bindings[AGENT_ZERO_CONTAINER_PORT];
  if (!Array.isArray(values) || values.length !== 1 || values[0]?.HostIp !== '127.0.0.1') return null;
  const port = Number(values[0]?.HostPort);
  return Number.isSafeInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

function exactPortContract(inspect: Record<string, any>, requireRunning: boolean): boolean {
  const bindings = inspect.HostConfig?.PortBindings;
  if (!isRecord(bindings) || Object.keys(bindings).length !== 1) return false;
  const configured = bindings[AGENT_ZERO_CONTAINER_PORT];
  if (!Array.isArray(configured) || configured.length !== 1 || configured[0]?.HostIp !== '127.0.0.1') {
    return false;
  }
  const configuredPort = String(configured[0]?.HostPort || '');
  if (requireRunning) {
    const hostPort = exactPort(inspect);
    if (hostPort === null || configuredPort !== String(hostPort)) return false;
    const live = inspect.NetworkSettings?.Ports;
    if (!isRecord(live) || Object.keys(live).length !== 1) return false;
    const published = live[AGENT_ZERO_CONTAINER_PORT];
    return Array.isArray(published)
      && published.length === 1
      && published[0]?.HostIp === '127.0.0.1'
      && String(published[0]?.HostPort || '') === String(hostPort);
  }

  if (configuredPort && exactPort(inspect) === null) return false;
  const pending = inspect.NetworkSettings?.Ports;
  return pending == null
    || (isRecord(pending)
      && (Object.keys(pending).length === 0
        || (Object.keys(pending).length === 1 && pending[AGENT_ZERO_CONTAINER_PORT] == null)));
}

function exactProxyEnvironment(
  inspect: Record<string, any>,
  spec: ProjectEgressPlaneSpec,
  bridgeGatewayIpv4: string,
  modelBridgeCredential: AgentZeroProjectModelBridgeCredential,
  authCredentials: AgentZeroCredentials,
): boolean {
  const values = new Map<string, string>();
  const keys = new Set<string>();
  for (const entry of inspect.Config?.Env || []) {
    const separator = String(entry).indexOf('=');
    if (separator < 1) continue;
    const key = String(entry).slice(0, separator);
    if (keys.has(key)) return false;
    keys.add(key);
    values.set(key, String(entry).slice(separator + 1));
  }
  const expected = expectedAgentZeroProxyEnvironment(spec, bridgeGatewayIpv4);
  const selectedKey = agentZeroProjectModelBridgeApiKeyEnvironmentName(
    modelBridgeCredential.record.providerId,
  );
  const oauthKeys = [
    'codex_oauth',
    'github_copilot_oauth',
    'gemini_api_oauth',
    'xai_grok_oauth',
  ].map((providerId) => agentZeroProjectModelBridgeApiKeyEnvironmentName(
    providerId as AgentZeroProjectOAuthProviderId,
  ));
  return PROXY_ENV_KEYS.every((key) => values.get(key) === expected[key])
    && values.get('AUTH_LOGIN') === authCredentials.username
    && values.get('AUTH_PASSWORD') === authCredentials.password
    && values.get(selectedKey) === modelBridgeCredential.token
    && oauthKeys.every((key) => key === selectedKey || !values.has(key))
    && !values.has('ALL_PROXY')
    && !values.has('all_proxy');
}

function exactTmpfs(host: Record<string, any>): boolean {
  const tmpfs = host.Tmpfs;
  if (!isRecord(tmpfs) || Object.keys(tmpfs).length !== 2) return false;
  const expected = new Map<string, readonly string[]>([
    ['/tmp', ['size=256m', `size=${256 * 1024 * 1024}`]],
    ['/a0/tmp', ['size=512m', `size=${512 * 1024 * 1024}`]],
  ]);
  return [...expected].every(([target, sizes]) => {
    const options = String(tmpfs[target] || '').toLowerCase().split(',').sort();
    return sizes.some((size) => JSON.stringify(options)
      === JSON.stringify(['rw', 'noexec', 'nosuid', 'nodev', size, 'mode=1777'].sort()));
  });
}

function exactUlimits(host: Record<string, any>): boolean {
  const values = Array.isArray(host.Ulimits) ? host.Ulimits.map((value: any) => ({
    name: String(value?.Name || ''),
    soft: Number(value?.Soft),
    hard: Number(value?.Hard),
  })).sort((left: any, right: any) => left.name.localeCompare(right.name)) : [];
  return JSON.stringify(values) === JSON.stringify([
    { name: 'nofile', soft: 1024, hard: 1024 },
    { name: 'nproc', soft: 512, hard: 512 },
  ]);
}

function emptyList(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0);
}

function exactProjectRuntimeConfinement(inspect: Record<string, any>): boolean {
  try {
    attestProjectRuntimeSecurityOptions({
      securityOpt: inspect.HostConfig?.SecurityOpt,
      appArmorProfile: inspect.AppArmorProfile,
    });
    return true;
  } catch {
    return false;
  }
}

function exactPreConfinementProjectRuntimeSecurity(inspect: Record<string, any>): boolean {
  try {
    attestPreConfinementProjectRuntimeSecurityOptions({
      securityOpt: inspect.HostConfig?.SecurityOpt,
      appArmorProfile: inspect.AppArmorProfile,
    });
    return true;
  } catch {
    return false;
  }
}

type AgentZeroRuntimeConfinementGeneration = 'CURRENT' | 'LEGACY_PRE_CONFINEMENT';
type AgentZeroRuntimeNetworkGeneration =
  | 'IMMUTABLE_ID'
  | 'CURRENT_NAME_MODE'
  | 'DETERMINISTIC_NAME';

function exactContainerIsolation(
  inspect: Record<string, any>,
  descriptor: AgentZeroProjectRuntimeDescriptor,
  imageRef: string,
  architecture: string,
  spec: ProjectEgressPlaneSpec,
  runtimeFingerprint: string,
  bridgeGatewayIpv4: string,
  runtimeIpv4: string | null,
  modelBridgeCredential: AgentZeroProjectModelBridgeCredential,
  authCredentials: AgentZeroCredentials,
  requireRunning: boolean,
  expectedInternalNetworkId: string,
  networkGeneration: AgentZeroRuntimeNetworkGeneration,
  confinementGeneration: AgentZeroRuntimeConfinementGeneration = 'CURRENT',
): boolean {
  const host = inspect.HostConfig || {};
  const labels = inspect.Config?.Labels || {};
  const capDrop = Array.isArray(host.CapDrop) ? host.CapDrop.map((value: unknown) => String(value).toUpperCase()) : [];
  const security = Array.isArray(host.SecurityOpt) ? host.SecurityOpt.map(String) : [];
  const networks = Object.keys(inspect.NetworkSettings?.Networks || {});
  const runtimeAttachment = inspect.NetworkSettings?.Networks?.[spec.internalNetworkName];
  const runtimeAttachmentHasNetworkId = isRecord(runtimeAttachment)
    && Object.prototype.hasOwnProperty.call(runtimeAttachment, 'NetworkID');
  const reportedInternalNetworkId = String(runtimeAttachment?.NetworkID || '').toLowerCase();
  const exactInternalNetworkIdentity = runtimeAttachmentHasNetworkId
    && /^[a-f0-9]{64}$/.test(expectedInternalNetworkId)
    && (reportedInternalNetworkId === expectedInternalNetworkId
      || (networkGeneration === 'IMMUTABLE_ID'
        && !requireRunning
        && reportedInternalNetworkId === ''
        && networks.length === 1
        && networks[0] === spec.internalNetworkName
        && String(host.NetworkMode || '').toLowerCase() === expectedInternalNetworkId));
  const exactRuntimeAttachment = runtimeIpv4
    ? runtimeAttachment?.IPAMConfig?.IPv4Address === runtimeIpv4
      && !runtimeAttachment?.IPAMConfig?.IPv6Address
      && !runtimeAttachment?.GlobalIPv6Address
      && (requireRunning
        ? runtimeAttachment?.IPAddress === runtimeIpv4
        : !runtimeAttachment?.IPAddress || runtimeAttachment.IPAddress === runtimeIpv4)
    : !runtimeAttachment?.IPAMConfig?.IPv4Address
      && !runtimeAttachment?.IPAMConfig?.IPv6Address
      && !runtimeAttachment?.GlobalIPv6Address
      && (requireRunning
        ? net.isIPv4(String(runtimeAttachment?.IPAddress || ''))
        : !runtimeAttachment?.IPAddress || net.isIPv4(String(runtimeAttachment.IPAddress)));
  return /^[a-f0-9]{64}$/i.test(String(inspect.Id || ''))
    && String(inspect.Name || '').replace(/^\//, '') === descriptor.containerName
    && inspect.State?.Running === requireRunning
    && inspect.Image === imageRef
    && inspect.Config?.Image === imageRef
    && String(inspect.Config?.User || '') === AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER
    && JSON.stringify(inspect.Config?.Cmd || []) === JSON.stringify(AGENT_ZERO_PROJECT_IMAGE_COMMAND)
    && emptyList(inspect.Config?.Entrypoint)
    && String(inspect.Config?.WorkingDir || '') === '/a0'
    && labels[AGENT_ZERO_PROJECT_MANAGED_LABEL] === 'agent-zero-project'
    && labels[AGENT_ZERO_PROJECT_RUNTIME_LABEL] === AGENT_ZERO_PROJECT_RUNTIME
    && labels[AGENT_ZERO_PROJECT_POLICY_LABEL] === AGENT_ZERO_PROJECT_POLICY_VERSION
    && labels[AGENT_ZERO_PROJECT_KEY_LABEL] === descriptor.key
    && labels[AGENT_ZERO_PROJECT_ID_LABEL] === descriptor.projectIdentityId
    && labels[AGENT_ZERO_PROJECT_ACTOR_LABEL] === descriptor.actorUserId
    && labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] === runtimeFingerprint
    && exactDerivedImageLabels(labels, architecture)
    && host.Privileged !== true
    && host.ReadonlyRootfs === true
    && emptyList(host.CapAdd)
    && capDrop.length === 1
    && capDrop[0] === 'ALL'
    && security.some((entry: string) => /no-new-privileges(?::true)?/.test(entry))
    && !security.some((entry: string) => /unconfined/i.test(entry))
    && (confinementGeneration === 'LEGACY_PRE_CONFINEMENT'
      ? exactPreConfinementProjectRuntimeSecurity(inspect)
      : exactProjectRuntimeConfinement(inspect))
    && String(host.NetworkMode || '').toLowerCase() === (
      networkGeneration === 'IMMUTABLE_ID'
        ? expectedInternalNetworkId
        : spec.internalNetworkName.toLowerCase()
    )
    && String(host.PidMode || '') === ''
    && ['', 'private'].includes(String(host.IpcMode || ''))
    && String(host.UTSMode || '') === ''
    && String(host.UsernsMode || '') === ''
    && ['', 'private'].includes(String(host.CgroupnsMode || ''))
    && emptyList(host.Devices)
    && emptyList(host.DeviceRequests)
    && emptyList(host.DeviceCgroupRules)
    && emptyList(host.Links)
    && emptyList(host.VolumesFrom)
    && emptyList(host.Dns)
    && emptyList(host.DnsOptions)
    && emptyList(host.DnsSearch)
    && emptyList(host.ExtraHosts)
    && host.RestartPolicy?.Name === 'no'
    && host.AutoRemove !== true
    && host.OomKillDisable !== true
    && host.PidsLimit === RUNTIME_PIDS_LIMIT
    && host.Memory === RUNTIME_MEMORY_BYTES
    && host.MemorySwap === RUNTIME_MEMORY_BYTES
    && host.NanoCpus === RUNTIME_NANO_CPUS
    && exactTmpfs(host)
    && exactUlimits(host)
    && exactPortContract(inspect, requireRunning)
    && networks.length === 1
    && networks[0] === spec.internalNetworkName
    && exactInternalNetworkIdentity
    && exactRuntimeAttachment
    && exactMounts(inspect, descriptor)
    && exactProxyEnvironment(
      inspect,
      spec,
      bridgeGatewayIpv4,
      modelBridgeCredential,
      authCredentials,
    );
}

export function attestOnlyAgentZeroProjectIdentityRuntime(
  input: AgentZeroProjectIdentityRuntimeAttestationInput,
  options: AgentZeroProjectProbeOptions = {},
): void {
  const runCommand = options.runCommand || defaultRunCommand;
  const readFile = options.readFile || ((filePath: string) => fs.readFileSync(filePath, 'utf8'));
  const statFile = options.statFile || fs.lstatSync;
  const architecture = options.architecture || process.arch;
  const expectedContainerId = requireExactAgentZeroDockerId(
    input.expectedContainerId,
    'Expected Agent Zero project container',
  );
  const expectedInternalNetworkId = requireExactAgentZeroDockerId(
    input.expectedInternalNetworkId,
    'Expected Agent Zero project internal network',
  );
  if (input.descriptor.actorUserId !== input.context.userId
    || input.descriptor.projectIdentityId !== input.context.projectId
    || input.descriptor.canonicalProjectRoot !== input.context.canonicalRoot) {
    throw new Error('Agent Zero project identity attestation context is invalid.');
  }
  if (!runtimeIdentityCurrent(
    requireProtectedRuntimeIdentity(input.descriptor.identityFile, readFile, statFile),
    buildAgentZeroProjectRuntimeIdentity(input.context, input.descriptor),
  )) {
    throw new Error('Agent Zero project identity attestation manifest is invalid.');
  }
  const authCredentials = protectedProjectCredentials(
    input.descriptor.authFile,
    readFile,
    statFile,
  );
  if (!authCredentials) {
    throw new Error('Agent Zero project identity attestation credentials are invalid.');
  }
  const modelBridgeCredential = readProtectedModelBridgeCredential(
    input.descriptor,
    { ...options, modelSelection: input.modelSelection },
    readFile,
    statFile,
  );
  if (!modelBridgeCredential) {
    throw new Error('Agent Zero project identity attestation model credential is invalid.');
  }
  const computedRuntimeFingerprint = buildAgentZeroProjectRuntimeFingerprint({
    context: input.context,
    descriptor: input.descriptor,
    imageRef: input.imageRef,
    spec: input.spec,
    bridgeGatewayIpv4: input.bridgeGatewayIpv4,
    runtimeIpv4: input.runtimeIpv4,
    modelBridgeCredential,
  });
  if (input.expectedRuntimeFingerprint !== computedRuntimeFingerprint) {
    throw new Error('Agent Zero project identity attestation runtime plan is invalid.');
  }

  const attestRound = (): string[] => {
    if (resolveExactAgentZeroInternalNetworkId(runCommand, input.spec)
      !== expectedInternalNetworkId) {
      throw new Error('Agent Zero project identity attestation network changed.');
    }
    const inventory = inspectExactAgentZeroProjectRuntimeInventory(
      runCommand,
      input.descriptor,
    );
    if (inventory.ids.length !== 1 || inventory.ids[0] !== expectedContainerId) {
      throw new Error('Agent Zero project identity attestation inventory is not exact.');
    }
    const candidate = inventory.inspections[0];
    const namedCandidate = inspectOptionalAgentZeroContainer(
      runCommand,
      input.descriptor.containerName,
    );
    if (!namedCandidate
      || exactAgentZeroContainerId(namedCandidate) !== expectedContainerId
      || String(candidate.State?.StartedAt || '') !== input.expectedContainerStartedAt
      || !exactContainerIsolation(
        candidate,
        input.descriptor,
        input.imageRef,
        architecture,
        input.spec,
        input.expectedRuntimeFingerprint,
        input.bridgeGatewayIpv4,
        input.runtimeIpv4,
        modelBridgeCredential,
        authCredentials,
        true,
        expectedInternalNetworkId,
        'IMMUTABLE_ID',
      )) {
      throw new Error('Agent Zero project identity attestation runtime is not exact.');
    }
    return inventory.ids;
  };

  const initialIds = attestRound();
  const finalIds = attestRound();
  if (!exactAgentZeroRuntimeInventoryEqual(initialIds, finalIds)) {
    throw new Error('Agent Zero project identity attestation inventory changed.');
  }
}

function requireProtectedQualification(
  filePath: string,
  readFile: (filePath: string) => string,
  statFile: (filePath: string) => fs.Stats,
): AgentZeroProjectQualification | null {
  try {
    const stat = statFile(filePath);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid || (stat.mode & 0o077) !== 0) return null;
    const parsed = JSON.parse(readFile(filePath));
    return isRecord(parsed) ? parsed as AgentZeroProjectQualification : null;
  } catch {
    return null;
  }
}

function requireProtectedRuntimeIdentity(
  filePath: string,
  readFile: (filePath: string) => string,
  statFile: (filePath: string) => fs.Stats,
): AgentZeroProjectRuntimeIdentity | null {
  try {
    const stat = statFile(filePath);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid || (stat.mode & 0o077) !== 0) return null;
    const parsed = JSON.parse(readFile(filePath));
    return isRecord(parsed) ? parsed as AgentZeroProjectRuntimeIdentity : null;
  } catch {
    return null;
  }
}

function runtimeIdentityCurrent(
  value: AgentZeroProjectRuntimeIdentity | null,
  expected: AgentZeroProjectRuntimeIdentity,
): boolean {
  return Boolean(value)
    && JSON.stringify(value) === JSON.stringify(expected);
}

function qualificationCurrent(input: {
  qualification: AgentZeroProjectQualification | null;
  context: ProjectSandboxExecutionContext;
  descriptor: AgentZeroProjectRuntimeDescriptor;
  imageRef: string;
  containerId: string;
  containerStartedAt: string;
  egressPolicyFingerprint: string;
  runtimeFingerprint: string;
  dataVolumeMountpoint: string;
  bridgeGatewayIpv4: string;
  runtimeIpv4: string;
  modelBridgeCredential: AgentZeroProjectModelBridgeCredential;
  now: number;
}): boolean {
  const value = input.qualification;
  if (!value) return false;
  const qualifiedAt = Date.parse(value.qualifiedAt);
  const expiresAt = Date.parse(value.expiresAt);
  return value.schema === AGENT_ZERO_PROJECT_QUALIFICATION_SCHEMA
    && value.policyVersion === AGENT_ZERO_PROJECT_POLICY_VERSION
    && value.networkPolicy === AGENT_ZERO_PROJECT_NETWORK_POLICY
    && value.runtime === AGENT_ZERO_PROJECT_RUNTIME
    && value.projectKey === input.descriptor.key
    && value.actorUserId === input.descriptor.actorUserId
    && value.projectIdentityId === input.descriptor.projectIdentityId
    && value.identityFingerprint === buildAgentZeroProjectRuntimeIdentity(input.context, input.descriptor).identityFingerprint
    && value.policyFingerprint === input.context.policyFingerprint
    && value.egressPolicyFingerprint === input.egressPolicyFingerprint
    && value.runtimeFingerprint === input.runtimeFingerprint
    && value.containerId === input.containerId
    && value.containerStartedAt === input.containerStartedAt
    && value.imageRef === input.imageRef
    && value.dataVolumeMountpoint === input.dataVolumeMountpoint
    && value.protocol === AGENT_ZERO_CONNECTOR_PROTOCOL
    && value.connectorVersion === AGENT_ZERO_CONNECTOR_VERSION
    && value.agentZeroVersion === AGENT_ZERO_VERSION
    && value.modelBridgePolicyVersion === AGENT_ZERO_PROJECT_MODEL_BRIDGE_POLICY_VERSION
    && value.modelBridgePort === AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT
    && value.modelBridgeGatewayIpv4 === input.bridgeGatewayIpv4
    && value.runtimeIpv4 === input.runtimeIpv4
    && value.modelBridgeCredentialHash === input.modelBridgeCredential.record.tokenHash
    && value.modelBridgeCredentialGeneration === input.modelBridgeCredential.record.generation
    && value.oauthProviderId === input.modelBridgeCredential.record.providerId
    && value.model === input.modelBridgeCredential.record.model
    && value.modelPresetName === buildAgentZeroProjectModelPresetName(input.descriptor)
    && value.connectorAuthenticated === true
    && value.hostGatewayDisconnected === true
    && value.runtimeUid === AGENT_ZERO_PROJECT_RUNTIME_UID
    && value.runtimeGid === AGENT_ZERO_PROJECT_RUNTIME_GID
    && value.projectReadProbe === true
    && value.projectWriteProbe === true
    && value.projectUnlinkProbe === true
    && value.hostEscapeProbe === true
    && value.networkEscapeProbe === true
    && value.publicHttpsProbe === true
    && value.bridgeGatewayProbe === true
    && value.modelBridgeReachabilityProbe === true
    && value.websocketReplayProbe === true
    && value.modelRoundTripProbe === true
    && Number.isFinite(qualifiedAt)
    && Number.isFinite(expiresAt)
    && qualifiedAt <= input.now
    && expiresAt > input.now
    && expiresAt - qualifiedAt <= AGENT_ZERO_PROJECT_QUALIFICATION_TTL_MS;
}

function emptyStatus(
  descriptor: AgentZeroProjectRuntimeDescriptor,
  reason: string,
): AgentZeroProjectRuntimeStatus {
  return {
    ready: false,
    selectable: false,
    reason,
    descriptor,
    structuralIsolation: false,
    volumeProvenance: false,
    egressPlaneReady: false,
    firewallReady: false,
    connectorReady: false,
    authenticated: false,
    hostGatewayDisconnected: false,
    qualificationCurrent: false,
  };
}

export function probeAgentZeroProjectSandboxRuntime(
  context: ProjectSandboxExecutionContext,
  options: AgentZeroProjectProbeOptions = {},
): AgentZeroProjectRuntimeStatus {
  const descriptor = describeAgentZeroProjectRuntime(context, options.stateRoot);
  try {
    (options.assertConfinementReady || assertProjectRuntimeConfinementReadyForExecution)();
  } catch {
    return emptyStatus(
      descriptor,
      'Agent Zero Project runtime confinement profiles are unavailable or changed.',
    );
  }
  const architecture = options.architecture || process.arch;
  const imageRef = resolveAgentZeroProjectImage(context, options);
  if (!imageRef) {
    return emptyStatus(
      descriptor,
      'Agent Zero Project Sandbox lacks an installer-attested non-root image ID for this architecture.',
    );
  }
  const runCommand = options.runCommand || defaultRunCommand;
  const readFile = options.readFile || ((filePath: string) => fs.readFileSync(filePath, 'utf8'));
  const statFile = options.statFile || fs.lstatSync;
  const statVolumeRoot = options.statVolumeRoot || fs.lstatSync;

  let image: Record<string, any>;
  let container: Record<string, any>;
  let volume: Record<string, any>;
  let spec: ProjectEgressPlaneSpec;
  let internalNetworkId: string;
  let bridgeGatewayIpv4: string;
  let runtimeIpv4: string;
  let modelBridgeCredential: AgentZeroProjectModelBridgeCredential;
  try {
    const egress = resolveAgentZeroProjectEgressConfig(context, options.egress);
    spec = buildProjectEgressPlaneSpec(egress);
    internalNetworkId = resolveExactAgentZeroInternalNetworkId(runCommand, spec);
    bridgeGatewayIpv4 = resolveAgentZeroProjectBridgeGatewayIpv4(spec, runCommand);
    runtimeIpv4 = resolveAgentZeroProjectRuntimeIpv4(spec, descriptor.containerName, runCommand);
    const protectedCredential = readProtectedModelBridgeCredential(
      descriptor,
      options,
      readFile,
      statFile,
    );
    if (!protectedCredential) {
      throw new Error('Agent Zero Project model bridge credential is unavailable.');
    }
    modelBridgeCredential = protectedCredential;
    image = parseSingleInspect(
      runCommand('docker', ['image', 'inspect', imageRef]),
      'Agent Zero project derived image',
    );
    container = parseSingleInspect(
      runCommand('docker', ['container', 'inspect', descriptor.containerName]),
      'Agent Zero project container',
    );
    volume = parseSingleInspect(
      runCommand('docker', ['volume', 'inspect', descriptor.dataVolume]),
      'Agent Zero project data volume',
    );
  } catch {
    return emptyStatus(
      descriptor,
      'The isolated Agent Zero v2.5 Project runtime or its controlled-egress identity is unavailable.',
    );
  }

  const containerId = String(container.Id || '');
  const containerStartedAt = String(container.State?.StartedAt || '');
  const hostPort = exactPort(container);
  const runtimeFingerprint = buildAgentZeroProjectRuntimeFingerprint({
    context,
    descriptor,
    imageRef,
    spec,
    bridgeGatewayIpv4,
    runtimeIpv4,
    modelBridgeCredential,
  });
  const runtimeIdentity = buildAgentZeroProjectRuntimeIdentity(context, descriptor);
  const authCredentials = protectedProjectCredentials(descriptor.authFile, readFile, statFile);
  const identityCurrent = runtimeIdentityCurrent(
    requireProtectedRuntimeIdentity(descriptor.identityFile, readFile, statFile),
    runtimeIdentity,
  );
  const structuralIsolation = containerId.length >= 12
    && Number.isFinite(Date.parse(containerStartedAt))
    && authCredentials !== null
    && exactDerivedImageInspect(image, imageRef, architecture)
    && exactContainerIsolation(
      container,
      descriptor,
      imageRef,
      architecture,
      spec,
      runtimeFingerprint,
      bridgeGatewayIpv4,
      runtimeIpv4,
      modelBridgeCredential,
      authCredentials!,
      true,
      internalNetworkId,
      'IMMUTABLE_ID',
    )
    && hostPort !== null
    && identityCurrent;
  const dataVolumeMountpoint = exactVolumeProvenance(volume, descriptor);
  const volumeProvenance = dataVolumeMountpoint !== null
    && exactVolumeRuntimeOwner(dataVolumeMountpoint, statVolumeRoot);
  let egressAttestation: AgentZeroProjectEgressAttestation | null = null;
  try {
    if (structuralIsolation && volumeProvenance) {
      egressAttestation = attestAgentZeroProjectEgressPlane({
        context,
        runtimeContainerName: descriptor.containerName,
        expectedRuntimeFingerprint: runtimeFingerprint,
        expectedRuntimeIpv4: runtimeIpv4,
        egress: options.egress,
        runCommand,
      });
      if (egressAttestation.spec.policyFingerprint !== spec.policyFingerprint
        || egressAttestation.bridgeGatewayIpv4 !== bridgeGatewayIpv4) {
        egressAttestation = null;
      }
    }
  } catch {
    egressAttestation = null;
  }
  const egressPlaneReady = egressAttestation !== null;
  const baseUrl = hostPort ? `http://127.0.0.1:${hostPort}` : undefined;
  const currentQualification = requireProtectedQualification(descriptor.qualificationFile, readFile, statFile);
  const qualified = structuralIsolation && volumeProvenance && egressPlaneReady && qualificationCurrent({
    qualification: currentQualification,
    context,
    descriptor,
    imageRef,
    containerId,
    containerStartedAt,
    egressPolicyFingerprint: spec.policyFingerprint,
    runtimeFingerprint,
    dataVolumeMountpoint: dataVolumeMountpoint!,
    bridgeGatewayIpv4,
    runtimeIpv4,
    modelBridgeCredential,
    now: (options.now || Date.now)(),
  });

  const reason = !structuralIsolation
    ? 'Agent Zero Project Sandbox failed its exact image, mount, port, privilege, resource, credential, or proxy-environment contract.'
    : !volumeProvenance
      ? 'Agent Zero Project Sandbox data volume lacks exact local-driver provenance.'
      : !egressPlaneReady
        ? 'Agent Zero Project Sandbox shared egress plane, membership, or ordered firewall is missing or drifted.'
        : !qualified
          ? 'Agent Zero Project Sandbox is isolated but lacks a current exact live public-egress, escape, replay, gateway, and model qualification.'
          : 'Agent Zero v2.5 Project Sandbox has a current exact live qualification.';

  return {
    ready: structuralIsolation && volumeProvenance && egressPlaneReady,
    selectable: qualified,
    reason,
    descriptor,
    imageRef,
    containerId,
    containerStartedAt,
    ...(baseUrl ? { baseUrl, hostPort: hostPort! } : {}),
    egressPolicyFingerprint: spec.policyFingerprint,
    runtimeFingerprint,
    internalNetworkName: spec.internalNetworkName,
    bridgeGatewayIpv4,
    runtimeIpv4,
    modelBridgeBaseUrl: buildAgentZeroProjectModelBridgeBaseUrl(
      bridgeGatewayIpv4,
      modelBridgeCredential.record.providerId,
    ),
    modelBridgeCredentialHash: modelBridgeCredential.record.tokenHash,
    modelBridgeCredentialGeneration: modelBridgeCredential.record.generation,
    modelSelection: Object.freeze({
      providerId: modelBridgeCredential.record.providerId,
      model: modelBridgeCredential.record.model,
    }),
    modelPresetName: buildAgentZeroProjectModelPresetName(descriptor),
    ...(dataVolumeMountpoint ? { dataVolumeMountpoint } : {}),
    structuralIsolation,
    volumeProvenance,
    egressPlaneReady,
    firewallReady: egressPlaneReady,
    connectorReady: qualified,
    authenticated: qualified,
    hostGatewayDisconnected: qualified,
    qualificationCurrent: qualified,
  };
}

function writeProtectedJsonAtomic(filePath: string, value: unknown): void {
  const directory = ensureRuntimeDirectory(path.dirname(filePath), { mode: 0o700, enforceMode: true });
  const temp = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const descriptor = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function writeProtectedTextAtomic(filePath: string, value: string): void {
  const directory = ensureRuntimeDirectory(path.dirname(filePath), { mode: 0o700, enforceMode: true });
  const temp = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const descriptor = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, value, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function ensureProjectCredentials(
  context: ProjectSandboxExecutionContext,
  descriptor: AgentZeroProjectRuntimeDescriptor,
  options: AgentZeroProjectConvergeOptions,
): void {
  ensureRuntimeDirectory(descriptor.stateDir, { mode: 0o700, enforceMode: true });
  const expectedIdentity = buildAgentZeroProjectRuntimeIdentity(context, descriptor);
  const currentIdentity = requireProtectedRuntimeIdentity(
    descriptor.identityFile,
    (filePath) => fs.readFileSync(filePath, 'utf8'),
    fs.lstatSync,
  );
  if (currentIdentity && !runtimeIdentityCurrent(currentIdentity, expectedIdentity)) {
    throw new Error('Existing Agent Zero project state belongs to another immutable project identity.');
  }
  if (!currentIdentity) {
    if (fs.existsSync(descriptor.identityFile)) {
      throw new Error('Existing Agent Zero project identity manifest is malformed or unprotected.');
    }
    writeProtectedJsonAtomic(descriptor.identityFile, expectedIdentity);
  }
  if (!runtimeIdentityCurrent(requireProtectedRuntimeIdentity(
    descriptor.identityFile,
    (filePath) => fs.readFileSync(filePath, 'utf8'),
    fs.lstatSync,
  ), expectedIdentity)) {
    throw new Error('Agent Zero project identity manifest could not be proven after persistence.');
  }
  try {
    readProtectedAgentZeroCredentials(descriptor.authFile);
    return;
  } catch (error: any) {
    if (fs.existsSync(descriptor.authFile)) throw error;
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('Agent Zero project credentials require the root Portal service.');
  }
  const password = String(options.passwordFactory?.() || crypto.randomBytes(36).toString('base64url'));
  if (password.length < 32 || /[^A-Za-z0-9_-]/.test(password)) {
    throw new Error('Agent Zero project password factory returned an unsafe value.');
  }
  const username = `portal-project-${descriptor.key.slice(0, 16)}`;
  writeProtectedTextAtomic(
    descriptor.authFile,
    `AUTH_LOGIN=${username}\nAUTH_PASSWORD=${password}\n`,
  );
  readProtectedAgentZeroCredentials(descriptor.authFile);
}

function sameModelSelection(
  left: AgentZeroProjectModelSelection,
  right: AgentZeroProjectModelSelection,
): boolean {
  const normalizedLeft = normalizeAgentZeroProjectModelSelection(left);
  const normalizedRight = normalizeAgentZeroProjectModelSelection(right);
  return normalizedLeft.providerId === normalizedRight.providerId
    && normalizedLeft.model === normalizedRight.model;
}

function ensureProjectModelBridgeCredential(
  descriptor: AgentZeroProjectRuntimeDescriptor,
  options: AgentZeroProjectConvergeOptions,
): AgentZeroProjectModelBridgeCredential {
  const requested = options.modelSelection
    ? normalizeAgentZeroProjectModelSelection(options.modelSelection)
    : null;
  const current = readProtectedModelBridgeCredential(
    descriptor,
    options,
    (filePath) => fs.readFileSync(filePath, 'utf8'),
    fs.lstatSync,
  );
  if (current) {
    if (requested && !sameModelSelection(requested, {
      providerId: current.record.providerId,
      model: current.record.model,
    })) {
      throw new Error(
        'Agent Zero Project model selection changed; revoke and re-converge the exact runtime before reuse.',
      );
    }
    return current;
  }
  if (fs.existsSync(descriptor.modelBridgeEnvFile)) {
    throw new Error('Existing Agent Zero Project model bridge credential is malformed, expired, or unprotected.');
  }
  if (!requested) {
    throw new Error('Agent Zero Project model selection is required for initial runtime convergence.');
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('Agent Zero Project model bridge credentials require the root Portal service.');
  }
  const issued = issueAgentZeroProjectModelBridgeCredential({
    projectKey: descriptor.key,
    actorUserId: descriptor.actorUserId,
    projectIdentityId: descriptor.projectIdentityId,
  }, requested, {
    credentialRoot: options.credentialRoot,
    now: options.now,
    tokenFactory: options.bridgeTokenFactory,
    generationFactory: options.bridgeGenerationFactory,
    ttlMs: options.bridgeCredentialTtlMs,
  });
  writeProtectedTextAtomic(
    descriptor.modelBridgeEnvFile,
    `${agentZeroProjectModelBridgeApiKeyEnvironmentName(requested.providerId)}=${issued.token}\n`,
  );
  const persisted = readProtectedModelBridgeCredential(
    descriptor,
    { ...options, modelSelection: requested },
    (filePath) => fs.readFileSync(filePath, 'utf8'),
    fs.lstatSync,
  );
  if (!persisted
    || persisted.record.tokenHash !== issued.record.tokenHash
    || persisted.record.generation !== issued.record.generation) {
    throw new Error('Agent Zero Project model bridge credential could not be proven after persistence.');
  }
  return persisted;
}

const agentZeroProjectConvergeLocks = new Map<string, Promise<void>>();

async function withAgentZeroProjectConvergeLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = agentZeroProjectConvergeLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = prior.catch(() => undefined).then(() => current);
  agentZeroProjectConvergeLocks.set(key, queued);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (agentZeroProjectConvergeLocks.get(key) === queued) {
      agentZeroProjectConvergeLocks.delete(key);
    }
  }
}

async function convergeAgentZeroProjectSandboxRuntimeLocked(
  context: ProjectSandboxExecutionContext,
  descriptor: AgentZeroProjectRuntimeDescriptor,
  options: AgentZeroProjectConvergeOptions,
): Promise<AgentZeroProjectRuntimeStatus> {
  (options.assertConfinementReady || assertProjectRuntimeConfinementReadyForExecution)();
  const architecture = options.architecture || process.arch;
  const imageRef = resolveAgentZeroProjectImage(context, options);
  if (!imageRef) {
    throw new Error('Agent Zero Project Sandbox lacks an installer-attested non-root image ID for this architecture.');
  }
  const runCommand = options.runCommand || defaultRunCommand;
  let image: Record<string, any>;
  try {
    image = parseSingleInspect(
      runCommand('docker', ['image', 'inspect', imageRef]),
      'Agent Zero project derived image',
    );
  } catch {
    throw new Error('Agent Zero Project Sandbox derived image inspection is unavailable.');
  }
  if (!exactDerivedImageInspect(image, imageRef, architecture)) {
    throw new Error('Agent Zero Project Sandbox derived image labels do not match the audited recipe.');
  }

  const egress = resolveAgentZeroProjectEgressConfig(context, options.egress);
  const buildEgressSpec = options.buildEgressSpec || buildProjectEgressPlaneSpec;
  const ensureEgressPlane = options.ensureEgressPlane || ensureProjectEgressPlane;
  const constrainRuntime = options.constrainRuntime || constrainProjectRuntimeToEgressPlane;
  const resolveInternalNetworkBinding = options.resolveInternalNetworkBinding
    || resolveRecognizedProjectEgressInternalNetworkBinding;
  const egressExecutor = options.egressExecutor || projectEgressCommandExecutor;
  const spec = buildEgressSpec(egress);
  const preflightNetworkBinding = await resolveInternalNetworkBinding(egressExecutor, spec);
  const initialRuntimeInventory = inspectExactAgentZeroProjectRuntimeInventory(runCommand, descriptor);
  const namedContainer = inspectOptionalAgentZeroContainer(runCommand, descriptor.containerName);
  if (initialRuntimeInventory.ids.length > 1) {
    throw new Error('Multiple Agent Zero project containers claim the same immutable identity.');
  }
  if (!namedContainer && initialRuntimeInventory.ids.length !== 0) {
    throw new Error('An Agent Zero project identity container exists outside its deterministic name.');
  }
  if (namedContainer) {
    const namedContainerId = exactAgentZeroContainerId(namedContainer);
    if (initialRuntimeInventory.ids.length !== 1
      || initialRuntimeInventory.ids[0] !== namedContainerId) {
      throw new Error('Agent Zero project deterministic name and identity inventory do not match.');
    }
  }
  const hasExistingRuntimeClaimant = initialRuntimeInventory.ids.length !== 0;
  let authCredentials: AgentZeroCredentials;
  let modelBridgeCredential: AgentZeroProjectModelBridgeCredential;
  if (hasExistingRuntimeClaimant) {
    const expectedIdentity = buildAgentZeroProjectRuntimeIdentity(context, descriptor);
    if (!runtimeIdentityCurrent(requireProtectedRuntimeIdentity(
      descriptor.identityFile,
      (filePath) => fs.readFileSync(filePath, 'utf8'),
      fs.lstatSync,
    ), expectedIdentity)) {
      throw new Error('Existing Agent Zero project runtime has no exact protected identity manifest.');
    }
    try {
      authCredentials = readProtectedAgentZeroCredentials(descriptor.authFile);
    } catch {
      throw new Error('Existing Agent Zero project runtime has no exact protected authentication credential.');
    }
    const protectedModelBridgeCredential = readProtectedModelBridgeCredential(
      descriptor,
      options,
      (filePath) => fs.readFileSync(filePath, 'utf8'),
      fs.lstatSync,
    );
    if (!protectedModelBridgeCredential) {
      throw new Error('Existing Agent Zero project runtime has no exact protected model bridge credential.');
    }
    modelBridgeCredential = protectedModelBridgeCredential;
  } else {
    ensureProjectCredentials(context, descriptor, options);
    authCredentials = readProtectedAgentZeroCredentials(descriptor.authFile);
    modelBridgeCredential = ensureProjectModelBridgeCredential(descriptor, options);
  }

  let volume: Record<string, any> | null = null;
  try {
    volume = parseSingleInspect(
      runCommand('docker', ['volume', 'inspect', descriptor.dataVolume]),
      'Agent Zero project data volume',
    );
  } catch {
    if (hasExistingRuntimeClaimant) {
      throw new Error('Existing Agent Zero project runtime has no exact managed data volume.');
    }
    runCommand('docker', buildAgentZeroProjectVolumeCreateArgs(descriptor));
    volume = parseSingleInspect(
      runCommand('docker', ['volume', 'inspect', descriptor.dataVolume]),
      'Agent Zero project data volume',
    );
  }
  const dataVolumeMountpoint = exactVolumeProvenance(volume, descriptor);
  if (!dataVolumeMountpoint) {
    throw new Error('Existing Agent Zero project data volume drifted from the local-driver provenance contract.');
  }
  let container: Record<string, any> | null = initialRuntimeInventory.inspections[0] || null;
  let currentContainerId: string | null = null;
  let attestCurrentBeforeEgress:
    ((candidate: Record<string, any>) => boolean) | null = null;
  if (container) {
    const requireRunning = container.State?.Running === true;
    if (typeof container.State?.Running !== 'boolean') {
      throw new Error('Existing Agent Zero project container state is ambiguous.');
    }
    if (!preflightNetworkBinding) {
      throw new Error('Existing Agent Zero project container has no exact recognized egress plane.');
    }
    const preConfinementSpec: ProjectEgressPlaneSpec = {
      ...spec,
      policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(spec),
    };
    const preflightNetworkSpec = preflightNetworkBinding.generation === 'CURRENT'
      ? spec
      : preConfinementSpec;
    const preflightInternalNetworkId = requireExactAgentZeroDockerId(
      preflightNetworkBinding.networkId,
      'Existing Agent Zero project internal network',
    );
    let preflightBridgeGatewayIpv4: string;
    let preflightRuntimeIpv4: string;
    try {
      preflightBridgeGatewayIpv4 = resolveAgentZeroProjectBridgeGatewayIpv4(
        preflightNetworkSpec,
        runCommand,
      );
      preflightRuntimeIpv4 = resolveAgentZeroProjectRuntimeIpv4(
        preflightNetworkSpec,
        descriptor.containerName,
        runCommand,
      );
    } catch {
      throw new Error('Existing Agent Zero project container could not be bound to an exact recognized egress plane.');
    }
    const currentFingerprint = buildAgentZeroProjectRuntimeFingerprint({
      context,
      descriptor,
      imageRef,
      spec,
      bridgeGatewayIpv4: preflightBridgeGatewayIpv4,
      runtimeIpv4: preflightRuntimeIpv4,
      modelBridgeCredential,
    });
    const legacyFingerprint = buildAgentZeroProjectRuntimeFingerprintValue({
      context,
      descriptor,
      imageRef,
      spec: preConfinementSpec,
      bridgeGatewayIpv4: preflightBridgeGatewayIpv4,
      modelBridgeCredential,
      includeConfinement: false,
    });
    const preConfinementFingerprint = buildAgentZeroProjectRuntimeFingerprintValue({
      context,
      descriptor,
      imageRef,
      spec: preConfinementSpec,
      bridgeGatewayIpv4: preflightBridgeGatewayIpv4,
      runtimeIpv4: preflightRuntimeIpv4,
      modelBridgeCredential,
      includeConfinement: false,
    });
    const current = preflightNetworkBinding.generation === 'CURRENT'
      && exactContainerIsolation(
      container,
      descriptor,
      imageRef,
      architecture,
      spec,
      currentFingerprint,
      preflightBridgeGatewayIpv4,
      preflightRuntimeIpv4,
      modelBridgeCredential,
      authCredentials,
      requireRunning,
      preflightInternalNetworkId,
      'IMMUTABLE_ID',
    );
    const currentNameMode = !current
      && preflightNetworkBinding.generation === 'CURRENT'
      && exactContainerIsolation(
      container,
      descriptor,
      imageRef,
      architecture,
      spec,
      currentFingerprint,
      preflightBridgeGatewayIpv4,
      preflightRuntimeIpv4,
      modelBridgeCredential,
      authCredentials,
      requireRunning,
      preflightInternalNetworkId,
      'CURRENT_NAME_MODE',
    );
    const preConfinement = !current && !currentNameMode
      && preflightNetworkBinding.generation === 'LEGACY_PRE_CONFINEMENT'
      && exactContainerIsolation(
      container,
      descriptor,
      imageRef,
      architecture,
      preConfinementSpec,
      preConfinementFingerprint,
      preflightBridgeGatewayIpv4,
      preflightRuntimeIpv4,
      modelBridgeCredential,
      authCredentials,
      requireRunning,
      preflightInternalNetworkId,
      'DETERMINISTIC_NAME',
      'LEGACY_PRE_CONFINEMENT',
    );
    const legacy = !current && !currentNameMode && !preConfinement
      && preflightNetworkBinding.generation === 'LEGACY_PRE_CONFINEMENT'
      && exactContainerIsolation(
      container,
      descriptor,
      imageRef,
      architecture,
      preConfinementSpec,
      legacyFingerprint,
      preflightBridgeGatewayIpv4,
      null,
      modelBridgeCredential,
      authCredentials,
      requireRunning,
      preflightInternalNetworkId,
      'DETERMINISTIC_NAME',
      'LEGACY_PRE_CONFINEMENT',
    );
    if (!current && !currentNameMode && !preConfinement && !legacy) {
      throw new Error('Existing Agent Zero project container is neither the current nor a recognized legacy generation.');
    }
    currentContainerId = exactAgentZeroContainerId(container);
    if (current) {
      attestCurrentBeforeEgress = (candidate) => exactContainerIsolation(
        candidate,
        descriptor,
        imageRef,
        architecture,
        spec,
        currentFingerprint,
        preflightBridgeGatewayIpv4,
        preflightRuntimeIpv4,
        modelBridgeCredential,
        authCredentials,
        requireRunning,
        preflightInternalNetworkId,
        'IMMUTABLE_ID',
      );
    }
    if (currentNameMode || preConfinement || legacy) {
      const retirementFingerprint = currentNameMode
        ? currentFingerprint
        : preConfinement
          ? preConfinementFingerprint
          : legacyFingerprint;
      const retirementRuntimeIpv4 = legacy ? null : preflightRuntimeIpv4;
      const retirementSpec = currentNameMode ? spec : preConfinementSpec;
      const retirementNetworkGeneration: AgentZeroRuntimeNetworkGeneration
        = currentNameMode ? 'CURRENT_NAME_MODE' : 'DETERMINISTIC_NAME';
      const retirementConfinement: AgentZeroRuntimeConfinementGeneration
        = currentNameMode ? 'CURRENT' : 'LEGACY_PRE_CONFINEMENT';
      const beforeStopInventory = inspectExactAgentZeroProjectRuntimeInventory(
        runCommand,
        descriptor,
      );
      if (!exactAgentZeroRuntimeInventoryEqual(
        initialRuntimeInventory.ids,
        beforeStopInventory.ids,
      ) || beforeStopInventory.ids.length !== 1
        || beforeStopInventory.ids[0] !== currentContainerId) {
        throw new Error('Agent Zero project runtime identity inventory changed before legacy retirement.');
      }
      const beforeStop = beforeStopInventory.inspections[0];
      if (!exactContainerIsolation(
        beforeStop,
        descriptor,
        imageRef,
        architecture,
        retirementSpec,
        retirementFingerprint,
        preflightBridgeGatewayIpv4,
        retirementRuntimeIpv4,
        modelBridgeCredential,
        authCredentials,
        requireRunning,
        preflightInternalNetworkId,
        retirementNetworkGeneration,
        retirementConfinement,
      )) {
        throw new Error('Recognized legacy Agent Zero project container changed before retirement.');
      }
      if (requireRunning) {
        runCommand('docker', ['container', 'stop', '--time', '10', currentContainerId]);
      }
      const stopped = inspectOptionalAgentZeroContainer(runCommand, currentContainerId);
      if (!stopped || !exactContainerIsolation(
        stopped,
        descriptor,
        imageRef,
        architecture,
        retirementSpec,
        retirementFingerprint,
        preflightBridgeGatewayIpv4,
        retirementRuntimeIpv4,
        modelBridgeCredential,
        authCredentials,
        false,
        preflightInternalNetworkId,
        retirementNetworkGeneration,
        retirementConfinement,
      )) {
        throw new Error('Recognized legacy Agent Zero project container changed before retirement.');
      }
      const beforeRemoveInventory = inspectExactAgentZeroProjectRuntimeInventory(
        runCommand,
        descriptor,
      );
      if (!exactAgentZeroRuntimeInventoryEqual(
        initialRuntimeInventory.ids,
        beforeRemoveInventory.ids,
      ) || beforeRemoveInventory.ids.length !== 1
        || beforeRemoveInventory.ids[0] !== currentContainerId) {
        throw new Error('Agent Zero project runtime identity inventory changed before exact removal.');
      }
      runCommand('docker', ['container', 'rm', currentContainerId]);
      if (inspectOptionalAgentZeroContainer(runCommand, currentContainerId)) {
        throw new Error('Recognized legacy Agent Zero project container still exists after exact removal.');
      }
      if (inspectOptionalAgentZeroContainer(runCommand, descriptor.containerName)) {
        throw new Error('Agent Zero project container name was replaced during legacy migration.');
      }
      if (listExactAgentZeroProjectRuntimeIds(runCommand, descriptor).length !== 0) {
        throw new Error('Agent Zero project identity was replaced during legacy migration.');
      }
      container = null;
      currentContainerId = null;
    }
  }

  const beforeEgressInventory = inspectExactAgentZeroProjectRuntimeInventory(
    runCommand,
    descriptor,
  );
  const expectedBeforeEgressIds = currentContainerId ? [currentContainerId] : [];
  if (!exactAgentZeroRuntimeInventoryEqual(
    expectedBeforeEgressIds,
    beforeEgressInventory.ids,
  ) || (currentContainerId !== null
    && (!attestCurrentBeforeEgress
      || !attestCurrentBeforeEgress(beforeEgressInventory.inspections[0])))) {
    throw new Error('Agent Zero project runtime identity changed before shared egress convergence.');
  }
  const handle = await ensureEgressPlane(egress, egressExecutor);
  const expectedProxyEnvironment = expectedAgentZeroProxyEnvironment(spec);
  const handleInternalNetworkId = requireExactAgentZeroDockerId(
    handle.internalNetworkId,
    'Agent Zero Project shared egress internal network',
  );
  if (handle.policyVersion !== PROJECT_EGRESS_POLICY_VERSION
    || handle.policyFingerprint !== spec.policyFingerprint
    || handle.internalNetworkName !== spec.internalNetworkName
    || handle.publicNetworkName !== spec.publicNetworkName
    || handle.proxyContainerName !== spec.proxyContainerName
    || JSON.stringify(handle.proxyEnvironment) !== JSON.stringify(expectedProxyEnvironment)) {
    throw new Error('Agent Zero Project shared egress handle did not match its immutable specification.');
  }
  const postPlaneBinding = await resolveInternalNetworkBinding(egressExecutor, spec);
  const currentInternalNetworkId = resolveExactAgentZeroInternalNetworkId(runCommand, spec);
  if (!postPlaneBinding
    || postPlaneBinding.generation !== 'CURRENT'
    || postPlaneBinding.networkId !== handleInternalNetworkId
    || currentInternalNetworkId !== handleInternalNetworkId
    || (preflightNetworkBinding?.generation === 'CURRENT'
      && preflightNetworkBinding.networkId !== postPlaneBinding.networkId)) {
    throw new Error('Agent Zero Project shared egress network identity changed after convergence.');
  }
  const bridgeGatewayIpv4 = resolveAgentZeroProjectBridgeGatewayIpv4(spec, runCommand);
  const runtimeIpv4 = resolveAgentZeroProjectRuntimeIpv4(spec, descriptor.containerName, runCommand);
  const runtimeFingerprint = buildAgentZeroProjectRuntimeFingerprint({
    context,
    descriptor,
    imageRef,
    spec,
    bridgeGatewayIpv4,
    runtimeIpv4,
    modelBridgeCredential,
  });
  if (!container) {
    const beforeCreateInventory = inspectExactAgentZeroProjectRuntimeInventory(
      runCommand,
      descriptor,
    );
    if (beforeCreateInventory.ids.length !== 0) {
      throw new Error('Agent Zero project runtime identity became occupied before exact creation.');
    }
    if (inspectOptionalAgentZeroContainer(runCommand, descriptor.containerName)) {
      throw new Error('Agent Zero project container name became occupied before exact creation.');
    }
    const createdContainerId = requireCreatedAgentZeroContainerId(
      runCommand('docker', buildAgentZeroProjectContainerCreateArgs({
        descriptor,
        imageRef,
        spec,
        internalNetworkId: handleInternalNetworkId,
        runtimeFingerprint,
        bridgeGatewayIpv4,
        runtimeIpv4,
        modelBridgeCredential,
      })),
    );
    container = inspectOptionalAgentZeroContainer(runCommand, createdContainerId);
    if (!container
      || exactAgentZeroContainerId(container) !== createdContainerId
      || String(container.Name || '').replace(/^\//, '') !== descriptor.containerName) {
      throw new Error('Created Agent Zero project container immutable identity changed before attestation.');
    }
    const createdInventory = inspectExactAgentZeroProjectRuntimeInventory(runCommand, descriptor);
    if (createdInventory.ids.length !== 1
      || createdInventory.ids[0] !== createdContainerId) {
      throw new Error('Created Agent Zero project container did not own the exact runtime identity.');
    }
    const createdByName = inspectOptionalAgentZeroContainer(runCommand, descriptor.containerName);
    if (!createdByName || exactAgentZeroContainerId(createdByName) !== createdContainerId) {
      throw new Error('Created Agent Zero project container name changed before attestation.');
    }
    currentContainerId = createdContainerId;
  } else {
    container = inspectOptionalAgentZeroContainer(runCommand, currentContainerId!);
    if (!container || !exactContainerIsolation(
      container,
      descriptor,
      imageRef,
      architecture,
      spec,
      runtimeFingerprint,
      bridgeGatewayIpv4,
      runtimeIpv4,
      modelBridgeCredential,
      authCredentials,
      container.State?.Running === true,
      handleInternalNetworkId,
      'IMMUTABLE_ID',
    )) {
      throw new Error('Current Agent Zero project container changed during egress convergence.');
    }
  }
  if (!container || !currentContainerId) {
    throw new Error('Agent Zero project container identity was unavailable after exact convergence.');
  }
  // Docker initializes a brand-new named volume from the image at container
  // creation time. Check after that one safe copy-up point; existing volumes
  // are never chowned or repaired in place.
  if (!exactVolumeRuntimeOwner(dataVolumeMountpoint, options.statVolumeRoot || fs.lstatSync)) {
    throw new Error('Existing Agent Zero project data volume is not rooted at the exact non-root runtime identity.');
  }
  if (container.State?.Running === true) {
    runCommand('docker', ['container', 'stop', '--time', '10', currentContainerId!]);
    container = inspectOptionalAgentZeroContainer(runCommand, currentContainerId!);
    if (!container) throw new Error('Agent Zero project container disappeared while stopping.');
  }
  if (!exactContainerIsolation(
    container,
    descriptor,
    imageRef,
    architecture,
    spec,
    runtimeFingerprint,
    bridgeGatewayIpv4,
    runtimeIpv4,
    modelBridgeCredential,
    authCredentials,
    false,
    handleInternalNetworkId,
    'IMMUTABLE_ID',
  )) {
    throw new Error('Existing Agent Zero project container drifted from the isolation contract.');
  }
  await constrainRuntime({
    spec,
    runtimeContainerId: currentContainerId!,
    runtimeContainerName: descriptor.containerName,
    expectedRuntimeFingerprint: runtimeFingerprint,
    executor: egressExecutor,
  });
  container = inspectOptionalAgentZeroContainer(runCommand, currentContainerId!);
  if (!container) throw new Error('Agent Zero project container disappeared during egress constraint.');
  if (!exactContainerIsolation(
    container,
    descriptor,
    imageRef,
    architecture,
    spec,
    runtimeFingerprint,
    bridgeGatewayIpv4,
    runtimeIpv4,
    modelBridgeCredential,
    authCredentials,
    false,
    handleInternalNetworkId,
    'IMMUTABLE_ID',
  )) {
    throw new Error('Agent Zero project container drifted while its egress attachment was constrained.');
  }

  const topology = attestAgentZeroProjectEgressPlane({
    context,
    runtimeContainerName: descriptor.containerName,
    expectedRuntimeFingerprint: runtimeFingerprint,
    expectedRuntimeIpv4: runtimeIpv4,
    egress,
    runCommand,
    requireRuntimeRunning: false,
    requireRuntimeFirewall: false,
  });
  installAgentZeroProjectFirewall({
    spec,
    runtimeIpv4: topology.runtimeIpv4,
    proxyIpv4: topology.proxyIpv4,
    bridgeGatewayIpv4,
    runCommand,
  });
  attestAgentZeroProjectEgressPlane({
    context,
    runtimeContainerName: descriptor.containerName,
    expectedRuntimeFingerprint: runtimeFingerprint,
    expectedRuntimeIpv4: runtimeIpv4,
    egress,
    runCommand,
    requireRuntimeRunning: false,
  });
  const beforeStartInventory = inspectExactAgentZeroProjectRuntimeInventory(
    runCommand,
    descriptor,
  );
  if (beforeStartInventory.ids.length !== 1
    || beforeStartInventory.ids[0] !== currentContainerId
    || !exactContainerIsolation(
      beforeStartInventory.inspections[0],
      descriptor,
      imageRef,
      architecture,
      spec,
      runtimeFingerprint,
      bridgeGatewayIpv4,
      runtimeIpv4,
      modelBridgeCredential,
      authCredentials,
      false,
      handleInternalNetworkId,
      'IMMUTABLE_ID',
    )) {
    throw new Error('Agent Zero project runtime identity changed before exact start.');
  }
  runCommand('docker', ['container', 'start', currentContainerId!]);

  const status = probeAgentZeroProjectSandboxRuntime(context, {
    ...options,
    egress,
    modelSelection: {
      providerId: modelBridgeCredential.record.providerId,
      model: modelBridgeCredential.record.model,
    },
  });
  if (!status.ready) {
    try {
      runCommand('docker', ['container', 'stop', '--time', '10', currentContainerId!]);
    } catch {
      // Preserve the original post-start attestation failure.
    }
    throw new Error(status.reason);
  }
  let finalIdentityFailure: Error | null = null;
  try {
    const finalIdentityInventory = inspectExactAgentZeroProjectRuntimeInventory(
      runCommand,
      descriptor,
    );
    if (finalIdentityInventory.ids.length !== 1
      || finalIdentityInventory.ids[0] !== currentContainerId) {
      finalIdentityFailure = new Error('Agent Zero project runtime identity changed after final qualification.');
    }
  } catch (error) {
    finalIdentityFailure = error instanceof Error
      ? error
      : new Error('Agent Zero project runtime identity inventory failed after final qualification.');
  }
  if (finalIdentityFailure) {
    const currentBeforeCleanup = inspectOptionalAgentZeroContainer(runCommand, currentContainerId!);
    if (currentBeforeCleanup && exactContainerIsolation(
      currentBeforeCleanup,
      descriptor,
      imageRef,
      architecture,
      spec,
      runtimeFingerprint,
      bridgeGatewayIpv4,
      runtimeIpv4,
      modelBridgeCredential,
      authCredentials,
      true,
      handleInternalNetworkId,
      'IMMUTABLE_ID',
    )) {
      runCommand('docker', ['container', 'stop', '--time', '10', currentContainerId!]);
      const currentAfterCleanup = inspectOptionalAgentZeroContainer(runCommand, currentContainerId!);
      if (!currentAfterCleanup || !exactContainerIsolation(
        currentAfterCleanup,
        descriptor,
        imageRef,
        architecture,
        spec,
        runtimeFingerprint,
        bridgeGatewayIpv4,
        runtimeIpv4,
        modelBridgeCredential,
        authCredentials,
        false,
        handleInternalNetworkId,
        'IMMUTABLE_ID',
      )) {
        throw new Error('Agent Zero project runtime changed while containing a final identity failure.');
      }
    }
    throw finalIdentityFailure;
  }
  return status;
}

/**
 * Converge the isolated container foundation without enabling the provider.
 * Existing drift is never repaired in-place. A current or recognized legacy
 * container is first attested by immutable ID; only the legacy container
 * object is retired, preserving its named data volume and protected state.
 */
export async function convergeAgentZeroProjectSandboxRuntime(
  context: ProjectSandboxExecutionContext,
  options: AgentZeroProjectConvergeOptions = {},
): Promise<AgentZeroProjectRuntimeStatus> {
  const descriptor = describeAgentZeroProjectRuntime(context, options.stateRoot);
  return withAgentZeroProjectConvergeLock(
    descriptor.key,
    () => convergeAgentZeroProjectSandboxRuntimeLocked(context, descriptor, options),
  );
}

export const AGENT_ZERO_PROJECT_ESCAPE_PROBE = String.raw`
import json, os, socket, sys, urllib.request
root = os.path.realpath(sys.argv[1])
bridge_gateway = sys.argv[2]
model_bridge_port = int(sys.argv[3])
public_url = sys.argv[4]
probe_name = sys.argv[5]
result = {
    "runtime_uid": os.geteuid(),
    "runtime_gid": os.getegid(),
    "project_read": False,
    "project_write": False,
    "project_unlink": False,
    "project_file_uid": -1,
    "project_file_gid": -1,
    "host_escape_blocked": False,
    "network_escape_blocked": False,
    "public_https_succeeded": False,
    "bridge_gateway_blocked": False,
    "model_bridge_reachable": False,
}
if not probe_name.startswith(".portal-agent-zero-sandbox-probe-") or not probe_name.replace("-", "").replace(".", "").isalnum():
    raise SystemExit("invalid probe name")
probe = os.path.join(root, probe_name)
try:
    descriptor = os.open(probe, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, b"bridgesllm-agent-zero-project-probe")
        metadata = os.fstat(descriptor)
        result["project_file_uid"] = metadata.st_uid
        result["project_file_gid"] = metadata.st_gid
        result["project_write"] = metadata.st_size == len(b"bridgesllm-agent-zero-project-probe")
    finally:
        os.close(descriptor)
    with open(probe, "rb") as handle:
        result["project_read"] = handle.read() == b"bridgesllm-agent-zero-project-probe"
    os.unlink(probe)
    result["project_unlink"] = not os.path.exists(probe)
finally:
    try: os.unlink(probe)
    except FileNotFoundError: pass
forbidden = [
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/root/.openclaw",
    "/etc/bridgesllm",
    "/opt/bridgesllm",
    "/host",
    "/proc/1/root/root/.openclaw",
]
result["host_escape_blocked"] = all(not os.path.exists(item) for item in forbidden)

def reachable(host, port, family=socket.AF_INET):
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.settimeout(0.35)
    try:
        sock.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        sock.close()

ipv4_targets = [
    ("1.1.1.1", 443),
    ("127.0.0.1", 80),
    ("10.0.0.1", 443),
    ("100.64.0.1", 443),
    ("169.254.169.254", 80),
    ("172.17.0.1", 2375),
    ("192.168.0.1", 443),
]
ipv6_targets = [
    ("::1", 80),
    ("fd00::1", 443),
    ("fe80::1", 80),
]
direct_escape = any(reachable(host, port) for host, port in ipv4_targets)
direct_escape = direct_escape or any(reachable(host, port, socket.AF_INET6) for host, port in ipv6_targets)
result["network_escape_blocked"] = not direct_escape
result["bridge_gateway_blocked"] = all(
    not reachable(bridge_gateway, port) for port in [22, 80, 2375, 4001, 50001]
)
result["model_bridge_reachable"] = reachable(bridge_gateway, model_bridge_port)
try:
    request = urllib.request.Request(public_url, headers={"User-Agent": "BridgesLLM-Project-Qualification/1"})
    with urllib.request.urlopen(request, timeout=8) as response:
        result["public_https_succeeded"] = 200 <= int(response.status) < 400
        response.read(1024)
except Exception:
    result["public_https_succeeded"] = False
print(json.dumps(result, sort_keys=True))
`;

function validateEscapeProbe(value: unknown): boolean {
  return isRecord(value)
    && value.runtime_uid === AGENT_ZERO_PROJECT_RUNTIME_UID
    && value.runtime_gid === AGENT_ZERO_PROJECT_RUNTIME_GID
    && value.project_read === true
    && value.project_write === true
    && value.project_unlink === true
    && value.project_file_uid === AGENT_ZERO_PROJECT_RUNTIME_UID
    && value.project_file_gid === AGENT_ZERO_PROJECT_RUNTIME_GID
    && value.host_escape_blocked === true
    && value.network_escape_blocked === true
    && value.public_https_succeeded === true
    && value.bridge_gateway_blocked === true
    && value.model_bridge_reachable === true;
}

function hostGatewayDisconnected(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.connected === false
    && value.multiple_hosts === false
    && ['stopped', 'disconnected', 'not_connected', 'idle'].includes(String(value.state || '').toLowerCase())
    && value.gateway == null
    && Array.isArray(value.gateways)
    && value.gateways.length === 0;
}

function connectorContextId(value: unknown): string {
  const contextId = isRecord(value) ? String(value.context_id || '').trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(contextId)) {
    throw new Error('Agent Zero qualification returned an invalid connector context id.');
  }
  return contextId;
}

function modelResponseText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';
  for (const key of ['response', 'message', 'text', 'content']) {
    const nested = modelResponseText(value[key]);
    if (nested) return nested;
  }
  return '';
}

function modelStateMatchesSelection(
  value: unknown,
  selection: AgentZeroProjectModelSelection,
): boolean {
  if (!isRecord(value)) return false;
  const normalized = normalizeAgentZeroProjectModelSelection(selection);
  const main = isRecord(value.main_model) ? value.main_model : {};
  const utility = isRecord(value.utility_model) ? value.utility_model : {};
  return value.ok === true
    && value.allowed === true
    && String(value.effective_preset || '') !== ''
    && String(main.provider || '') === normalized.providerId
    && String(main.name || '') === normalized.model
    && String(utility.provider || '') === normalized.providerId
    && String(utility.name || '') === normalized.model;
}

function presetSlotMatches(
  value: unknown,
  expected: { provider: string; name: string; api_base: string },
): boolean {
  return isRecord(value)
    && String(value.provider || '') === expected.provider
    && String(value.name || '') === expected.name
    && String(value.api_base || '') === expected.api_base
    && !('api_key' in value);
}

function resolvedModelPresetIsExact(
  value: unknown,
  presetName: string,
  selection: AgentZeroProjectModelSelection,
  baseUrl: string,
): boolean {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.preset)) return false;
  const preset = value.preset;
  const normalized = normalizeAgentZeroProjectModelSelection(selection);
  const expected = { provider: normalized.providerId, name: normalized.model, api_base: baseUrl };
  return String(preset.name || '') === presetName
    && presetSlotMatches(preset.chat, expected)
    && presetSlotMatches(preset.utility, expected);
}

async function assertAgentZeroProjectModelPreset(
  client: AgentZeroConnectorClient,
  presetName: string,
  selection: AgentZeroProjectModelSelection,
  baseUrl: string,
): Promise<void> {
  const resolved = await client.call('model_presets', { action: 'resolve', name: presetName });
  if (!resolvedModelPresetIsExact(resolved, presetName, selection, baseUrl)) {
    throw new Error('Agent Zero Project model preset does not match its qualified OAuth bridge binding.');
  }
}

async function ensureAgentZeroProjectModelPreset(
  client: AgentZeroConnectorClient,
  presetName: string,
  selection: AgentZeroProjectModelSelection,
  baseUrl: string,
): Promise<void> {
  const normalized = normalizeAgentZeroProjectModelSelection(selection);
  const modelSlot = Object.freeze({
    provider: normalized.providerId,
    name: normalized.model,
    api_base: baseUrl,
    kwargs: Object.freeze({}),
  });
  const embeddingSlot = Object.freeze({
    provider: 'huggingface',
    name: 'sentence-transformers/all-MiniLM-L6-v2',
    api_base: '',
    kwargs: Object.freeze({}),
  });
  const presets = [
    { name: 'Default', chat: modelSlot, utility: modelSlot, embedding: embeddingSlot },
    { name: presetName, chat: modelSlot, utility: modelSlot, embedding: embeddingSlot },
  ];
  const saved = await client.call('model_presets', { action: 'save', presets });
  if (!isRecord(saved) || saved.ok !== true || !Array.isArray(saved.presets)
    || saved.presets.length !== presets.length) {
    throw new Error('Agent Zero Project model preset could not be converged exactly.');
  }
  await assertAgentZeroProjectModelPreset(client, presetName, normalized, baseUrl);
}

export async function applyAgentZeroProjectModelPreset(
  client: AgentZeroConnectorClient,
  contextId: string,
  presetName: string,
  selection: AgentZeroProjectModelSelection,
): Promise<void> {
  const state = await client.call('model_switcher', {
    action: 'set_preset',
    context_id: contextId,
    preset_name: presetName,
  });
  if (!modelStateMatchesSelection(state, selection)
    || String((state as Record<string, unknown>).effective_preset || '') !== presetName) {
    throw new Error('Agent Zero Project chat did not apply its exact OAuth model preset.');
  }
}

async function collectReplayAndModelEvidence(
  client: AgentZeroConnectorClient,
  presetName: string,
  selection: AgentZeroProjectModelSelection,
): Promise<void> {
  const created = await client.call('chat_create', { project_name: 'portal-qualification' });
  const contextId = connectorContextId(created);
  let probeError: unknown = null;
  try {
    await applyAgentZeroProjectModelPreset(client, contextId, presetName, selection);
    const firstToken = `P4A0-${crypto.randomBytes(12).toString('hex')}`;
    let toolAttempted = false;
    const first = await client.streamMessage({
      contextId,
      message: `Qualification only. Do not call tools. Reply with exactly ${firstToken}`,
      fromSequence: 0,
      onEvent: (event) => {
        if (event.event === 'tool_start'
          || event.event === 'tool_output'
          || event.event === 'tool_end'
          || event.event === 'code_start'
          || event.event === 'code_output') {
          toolAttempted = true;
        }
      },
    });
    if (toolAttempted
      || first.status !== 'completed'
      || first.lastSequence < 1
      || first.eventsProcessed < 1
      || modelResponseText(first.response) !== firstToken) {
      throw new Error('Agent Zero Project model round-trip qualification failed.');
    }

    const secondToken = `P4A0-${crypto.randomBytes(12).toString('hex')}`;
    let replayObserved = false;
    toolAttempted = false;
    const second = await client.streamMessage({
      contextId,
      message: `Qualification only. Do not call tools. Reply with exactly ${secondToken}`,
      fromSequence: 0,
      onTransportStatus: (status) => {
        if (status === 'replayed') replayObserved = true;
      },
      onEvent: (event) => {
        if (event.event === 'tool_start'
          || event.event === 'tool_output'
          || event.event === 'tool_end'
          || event.event === 'code_start'
          || event.event === 'code_output') {
          toolAttempted = true;
        }
      },
    });
    if (toolAttempted
      || !replayObserved
      || second.status !== 'completed'
      || second.lastSequence <= first.lastSequence
      || second.eventsProcessed < 1
      || modelResponseText(second.response) !== secondToken) {
      throw new Error('Agent Zero Project WebSocket replay qualification failed.');
    }
  } catch (error) {
    probeError = error;
  }

  try {
    await client.call('chat_delete', { context_id: contextId });
  } catch {
    throw new Error('Agent Zero Project qualification could not clean its temporary connector context.');
  }
  if (probeError) throw probeError;
}

/**
 * Performs the live, project-specific qualification. This cannot be replaced
 * by unit-test mocks or a global host-runtime probe: it binds the exact
 * container id, image digest, project policy fingerprint, authenticated
 * connector, escape probe, replay test, and model round-trip for at most 24h.
 */
export async function qualifyAgentZeroProjectSandboxRuntime(
  context: ProjectSandboxExecutionContext,
  options: AgentZeroProjectProbeOptions & {
    client?: AgentZeroConnectorClient;
    auth?: AgentZeroAuthSessionManager;
  } = {},
): Promise<AgentZeroProjectRuntimeStatus> {
  const status = probeAgentZeroProjectSandboxRuntime(context, options);
  if (!status.ready || !status.baseUrl || !status.containerId || !status.imageRef) {
    throw new Error(status.reason);
  }
  if (!status.containerStartedAt
    || !status.egressPolicyFingerprint
    || !status.runtimeFingerprint
    || !status.bridgeGatewayIpv4
    || !status.runtimeIpv4
    || !status.modelBridgeBaseUrl
    || !status.modelBridgeCredentialHash
    || !status.modelBridgeCredentialGeneration
    || !status.modelSelection
    || !status.modelPresetName
    || !status.dataVolumeMountpoint) {
    throw new Error('Agent Zero Project Sandbox attestation evidence is incomplete.');
  }
  const auth = options.auth || new AgentZeroAuthSessionManager({
    baseUrl: status.baseUrl,
    authFilePath: status.descriptor.authFile,
  });
  const client = options.client || new AgentZeroConnectorClient({
    baseUrl: status.baseUrl,
    sessionProvider: auth,
  });
  const readiness = await auth.probe(true);
  if (!readiness.authenticated) throw new Error(readiness.reason);
  const capabilities = await client.getCapabilities(true);
  for (const feature of [
    'chat_create',
    'chat_delete',
    'message_send',
    'launcher_gateway',
    'model_presets',
    'model_switcher',
  ]) {
    if (!capabilities.features.includes(feature)) {
      throw new Error(`Agent Zero Project Sandbox connector lacks mandatory ${feature} qualification support.`);
    }
  }

  const gatewayDisconnected = hostGatewayDisconnected(
    await client.call('launcher_gateway_status', {}),
  );
  if (!gatewayDisconnected) {
    throw new Error('Agent Zero Project Sandbox is connected to a host gateway and was rejected.');
  }

  const requireSameRuntimeGeneration = (
    candidate: AgentZeroProjectRuntimeStatus,
    stage: string,
  ): void => {
    if (!candidate.ready
      || candidate.containerId !== status.containerId
      || candidate.containerStartedAt !== status.containerStartedAt
      || candidate.imageRef !== status.imageRef
      || candidate.egressPolicyFingerprint !== status.egressPolicyFingerprint
      || candidate.runtimeFingerprint !== status.runtimeFingerprint
      || candidate.bridgeGatewayIpv4 !== status.bridgeGatewayIpv4
      || candidate.runtimeIpv4 !== status.runtimeIpv4
      || candidate.modelBridgeBaseUrl !== status.modelBridgeBaseUrl
      || candidate.modelBridgeCredentialHash !== status.modelBridgeCredentialHash
      || candidate.modelBridgeCredentialGeneration !== status.modelBridgeCredentialGeneration
      || JSON.stringify(candidate.modelSelection) !== JSON.stringify(status.modelSelection)
      || candidate.modelPresetName !== status.modelPresetName
      || candidate.dataVolumeMountpoint !== status.dataVolumeMountpoint) {
      throw new Error(`Agent Zero Project Sandbox changed ${stage}.`);
    }
  };

  const runCommand = options.runCommand || defaultRunCommand;
  requireSameRuntimeGeneration(
    probeAgentZeroProjectSandboxRuntime(context, options),
    'before its immutable escape probe',
  );
  const rawEscape = runCommand('docker', [
    'exec', status.containerId,
    'python3', '-c', AGENT_ZERO_PROJECT_ESCAPE_PROBE,
    AGENT_ZERO_PROJECT_ROOT,
    status.bridgeGatewayIpv4,
    String(AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT),
    'https://example.com/',
    `.portal-agent-zero-sandbox-probe-${crypto.randomBytes(12).toString('hex')}`,
  ]);
  let escape: unknown;
  try {
    escape = JSON.parse(rawEscape);
  } catch {
    throw new Error('Agent Zero Project Sandbox escape probe returned invalid JSON.');
  }
  if (!validateEscapeProbe(escape)) {
    throw new Error('Agent Zero Project Sandbox escape probe failed closed.');
  }
  requireSameRuntimeGeneration(
    probeAgentZeroProjectSandboxRuntime(context, options),
    'during its immutable escape probe',
  );
  await ensureAgentZeroProjectModelPreset(
    client,
    status.modelPresetName,
    status.modelSelection,
    status.modelBridgeBaseUrl,
  );
  await collectReplayAndModelEvidence(
    client,
    status.modelPresetName,
    status.modelSelection,
  );

  const reattested = probeAgentZeroProjectSandboxRuntime(context, options);
  requireSameRuntimeGeneration(reattested, 'while live qualification was running');

  const now = (options.now || Date.now)();
  const qualification: AgentZeroProjectQualification = {
    schema: AGENT_ZERO_PROJECT_QUALIFICATION_SCHEMA,
    policyVersion: AGENT_ZERO_PROJECT_POLICY_VERSION,
    networkPolicy: AGENT_ZERO_PROJECT_NETWORK_POLICY,
    runtime: AGENT_ZERO_PROJECT_RUNTIME,
    projectKey: status.descriptor.key,
    actorUserId: status.descriptor.actorUserId,
    projectIdentityId: status.descriptor.projectIdentityId,
    identityFingerprint: buildAgentZeroProjectRuntimeIdentity(
      context,
      status.descriptor,
    ).identityFingerprint,
    policyFingerprint: context.policyFingerprint,
    egressPolicyFingerprint: status.egressPolicyFingerprint,
    runtimeFingerprint: status.runtimeFingerprint,
    containerId: status.containerId,
    containerStartedAt: status.containerStartedAt,
    imageRef: status.imageRef,
    dataVolumeMountpoint: status.dataVolumeMountpoint,
    protocol: AGENT_ZERO_CONNECTOR_PROTOCOL,
    connectorVersion: AGENT_ZERO_CONNECTOR_VERSION,
    agentZeroVersion: AGENT_ZERO_VERSION,
    modelBridgePolicyVersion: AGENT_ZERO_PROJECT_MODEL_BRIDGE_POLICY_VERSION,
    modelBridgePort: AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT,
    modelBridgeGatewayIpv4: status.bridgeGatewayIpv4,
    runtimeIpv4: status.runtimeIpv4,
    modelBridgeCredentialHash: status.modelBridgeCredentialHash,
    modelBridgeCredentialGeneration: status.modelBridgeCredentialGeneration,
    oauthProviderId: status.modelSelection.providerId,
    model: status.modelSelection.model,
    modelPresetName: status.modelPresetName,
    connectorAuthenticated: true,
    hostGatewayDisconnected: true,
    runtimeUid: Number((escape as Record<string, unknown>).runtime_uid) as typeof AGENT_ZERO_PROJECT_RUNTIME_UID,
    runtimeGid: Number((escape as Record<string, unknown>).runtime_gid) as typeof AGENT_ZERO_PROJECT_RUNTIME_GID,
    projectReadProbe: true,
    projectWriteProbe: true,
    projectUnlinkProbe: true,
    hostEscapeProbe: true,
    networkEscapeProbe: true,
    publicHttpsProbe: true,
    bridgeGatewayProbe: true,
    modelBridgeReachabilityProbe: true,
    websocketReplayProbe: true,
    modelRoundTripProbe: true,
    qualifiedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + AGENT_ZERO_PROJECT_QUALIFICATION_TTL_MS).toISOString(),
  };
  writeProtectedJsonAtomic(status.descriptor.qualificationFile, qualification);
  return probeAgentZeroProjectSandboxRuntime(context, options);
}

/**
 * Open an already-qualified runtime. The exact container/firewall stamp is
 * rechecked synchronously, then the authenticated connector and absent host
 * gateway are re-proved. This is intentionally not a provisioner: ordinary
 * Project Chat requests may never create a privileged Docker runtime.
 */
export async function openQualifiedAgentZeroProjectRuntime(
  context: ProjectSandboxExecutionContext,
  options: AgentZeroProjectProbeOptions & {
    client?: AgentZeroConnectorClient;
    auth?: AgentZeroAuthSessionManager;
  } = {},
): Promise<AgentZeroProjectRuntimeHandle> {
  const status = probeAgentZeroProjectSandboxRuntime(context, options);
  if (!status.selectable
    || !status.baseUrl
    || !status.hostPort
    || !status.containerId
    || !status.imageRef
    || !status.modelBridgeBaseUrl
    || !status.modelSelection
    || !status.modelPresetName) {
    throw new Error(status.reason);
  }
  const auth = options.auth || new AgentZeroAuthSessionManager({
    baseUrl: status.baseUrl,
    authFilePath: status.descriptor.authFile,
  });
  const client = options.client || new AgentZeroConnectorClient({
    baseUrl: status.baseUrl,
    sessionProvider: auth,
  });
  const readiness = await auth.probe(false);
  if (!readiness.authenticated) throw new Error(readiness.reason);
  const capabilities = await client.getCapabilities(true);
  if (!capabilities.features.includes('message_send')
    || !capabilities.features.includes('launcher_gateway')
    || !capabilities.features.includes('model_presets')
    || !capabilities.features.includes('model_switcher')) {
    throw new Error('Agent Zero Project Sandbox connector lacks mandatory message or gateway attestation support.');
  }
  const gateway = await client.call('launcher_gateway_status', {});
  if (!hostGatewayDisconnected(gateway)) {
    throw new Error('Agent Zero Project Sandbox is connected to a host gateway and was rejected.');
  }
  await assertAgentZeroProjectModelPreset(
    client,
    status.modelPresetName,
    status.modelSelection,
    status.modelBridgeBaseUrl,
  );
  return {
    ...status,
    ready: true,
    baseUrl: status.baseUrl,
    hostPort: status.hostPort,
    containerId: status.containerId,
    imageRef: status.imageRef,
    connectorReady: true,
    authenticated: true,
    hostGatewayDisconnected: true,
    modelSelection: status.modelSelection,
    modelPresetName: status.modelPresetName,
    client,
    auth,
  };
}

/** Hard-abort only this project runtime; it never signals the global host bridge. */
export function hardAbortAgentZeroProjectRuntime(
  context: ProjectSandboxExecutionContext,
  options: AgentZeroProjectProbeOptions = {},
): boolean {
  const runCommand = options.runCommand || defaultRunCommand;
  let exactContainerId: string | null = null;
  try {
    const before = probeAgentZeroProjectSandboxRuntime(context, options);
    if (!before.ready || !before.containerId || !before.runtimeFingerprint) return false;
    exactContainerId = before.containerId;
    runCommand('docker', ['container', 'restart', '--time', '10', exactContainerId]);
    const after = probeAgentZeroProjectSandboxRuntime(context, options);
    const reattested = after.ready
      && after.containerId === before.containerId
      && after.runtimeFingerprint === before.runtimeFingerprint
      && after.egressPolicyFingerprint === before.egressPolicyFingerprint;
    if (!reattested) {
      try {
        runCommand('docker', ['container', 'stop', '--time', '10', exactContainerId]);
      } catch {
        // The caller still receives a fail-closed abort result.
      }
    }
    return reattested;
  } catch {
    if (exactContainerId) {
      try {
        runCommand('docker', ['container', 'stop', '--time', '10', exactContainerId]);
      } catch {
        // The caller still receives a fail-closed abort result.
      }
    }
    return false;
  }
}
