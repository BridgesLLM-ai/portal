import crypto from 'crypto';
import net from 'net';
import os from 'os';
import { spawn } from 'child_process';
import {
  PROJECT_EGRESS_BLOCKED_IPV4_CIDRS,
  PROJECT_EGRESS_BLOCKED_IPV6_CIDRS,
  PROJECT_EGRESS_POLICY_VERSION,
  isPublicProjectEgressAddress,
} from './projectEgressPolicy';
import {
  assertProjectRuntimeConfinementReadyForExecution,
  attestPreConfinementProjectRuntimeSecurityOptions,
  attestProjectRuntimeSecurityOptions,
  projectRuntimeSecurityOptArgs,
  projectRuntimeSecurityOptionValues,
} from './projectRuntimeConfinement';

const MASTER_FIREWALL_CHAIN = 'P4E-MASTER-V1';
const HOST_FIREWALL_CHAIN = 'P4E-HOST-V1';
const DOCKER_USER_CHAIN = 'DOCKER-USER';
const PROXY_ALIAS = 'portal-project-egress';
const PROXY_PORT = 3128;
const PROXY_BASE_ENVIRONMENT = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  NODE_VERSION: '22.16.0',
  YARN_VERSION: '1.22.22',
});
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
export const PROJECT_EGRESS_PROXY_IMAGE_TAG = 'bridgesllm-project-egress-proxy:v1';

const LABEL_PREFIX = 'com.bridgesllm.project-egress';
const LABEL_POLICY = `${LABEL_PREFIX}.policy`;
const LABEL_FINGERPRINT = `${LABEL_PREFIX}.fingerprint`;
const LABEL_ROLE = `${LABEL_PREFIX}.role`;
const LABEL_TOKEN_HASH = `${LABEL_PREFIX}.token-hash`;
const LABEL_RUNTIME_FINGERPRINT = `${LABEL_PREFIX}.runtime-fingerprint`;
const LABEL_IDENTITY = `${LABEL_PREFIX}.identity`;
const LABEL_ACTOR_ID = `${LABEL_PREFIX}.actor-id`;
const LABEL_PROJECT_ID = `${LABEL_PREFIX}.project-id`;
const LABEL_PROVIDER = `${LABEL_PREFIX}.provider`;
const LABEL_CONSUMER_KIND = `${LABEL_PREFIX}.consumer-kind`;
const LABEL_WORKLOAD_ID = `${LABEL_PREFIX}.workload-id`;
const FIREWALL_COMMENT_PREFIX = 'p4e-v1';

export const PROJECT_EGRESS_WORKLOAD_CONSUMER_KINDS = Object.freeze([
  'PORTAL_GIT',
  'PORTAL_LIFECYCLE',
  'PORTAL_APP',
] as const);
export type ProjectEgressWorkloadConsumerKind = typeof PROJECT_EGRESS_WORKLOAD_CONSUMER_KINDS[number];

export interface ProjectEgressIdentity {
  actorId: string;
  projectId: string;
  provider: string;
  /** Present only for Portal-owned non-provider workloads. */
  consumerKind?: ProjectEgressWorkloadConsumerKind;
  /** Server-owned invocation/app identifier. Never derived from project files. */
  workloadId?: string;
}

export interface ProjectEgressPlaneConfig {
  identity: ProjectEgressIdentity;
  proxyImage: string;
  token: string;
  proxyCommand?: readonly string[];
  extraDeniedCidrs?: readonly string[];
}

export interface ProjectEgressPlaneSpec {
  identity: Readonly<ProjectEgressIdentity>;
  identityFingerprint: string;
  actorFingerprint: string;
  projectFingerprint: string;
  providerFingerprint: string;
  policyFingerprint: string;
  internalNetworkName: string;
  publicNetworkName: string;
  proxyContainerName: string;
  firewallChainName: string;
  proxyImage: string;
  proxyCommand: readonly string[];
  token: string;
  tokenHash: string;
  deniedCidrs: readonly string[];
  proxyAlias: string;
  proxyPort: number;
  firewallComment: string;
}

export interface ProjectEgressIdentityScope {
  identity: Readonly<ProjectEgressIdentity>;
  identityFingerprint: string;
  actorFingerprint: string;
  projectFingerprint: string;
  providerFingerprint: string;
  internalNetworkName: string;
  publicNetworkName: string;
  proxyContainerName: string;
  firewallChainName: string;
  firewallComment: string;
}

export interface ProjectEgressPlaneHandle {
  policyVersion: string;
  policyFingerprint: string;
  internalNetworkName: string;
  internalNetworkId: string;
  publicNetworkName: string;
  proxyContainerName: string;
  proxyUrl: string;
  proxyEnvironment: Readonly<Record<string, string>>;
}

export interface ProjectEgressCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProjectEgressCommandExecutor {
  run(
    command: string,
    args: readonly string[],
    options?: { allowExitCodes?: readonly number[]; input?: string },
  ): Promise<ProjectEgressCommandResult>;
}

export interface DockerNetworkInspect {
  Id?: string;
  Name?: string;
  Driver?: string;
  Internal?: boolean;
  Labels?: Record<string, string> | null;
  Containers?: Record<string, { Name?: string }> | null;
  IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string } | null> | null } | null;
}

export interface DockerContainerInspect {
  Id?: string;
  Image?: string;
  Name?: string;
  Config?: {
    Image?: string;
    User?: string;
    Env?: string[];
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    WorkingDir?: string;
    Labels?: Record<string, string> | null;
  };
  State?: { Running?: boolean; Health?: { Status?: string } };
  AppArmorProfile?: string;
  HostConfig?: {
    Init?: boolean | null;
    ReadonlyRootfs?: boolean;
    CapAdd?: string[] | null;
    CapDrop?: string[] | null;
    SecurityOpt?: string[] | null;
    Binds?: string[] | null;
    Mounts?: unknown[] | null;
    PortBindings?: Record<string, unknown> | null;
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
    NanoCpus?: number;
    Tmpfs?: Record<string, string> | null;
    PublishAllPorts?: boolean;
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
  Mounts?: unknown[];
  NetworkSettings?: {
    Networks?: Record<string, {
      IPAddress?: string;
      GlobalIPv6Address?: string;
      Aliases?: string[] | null;
      NetworkID?: string;
      EndpointID?: string;
      IPAMConfig?: { IPv4Address?: string; IPv6Address?: string } | null;
    }>;
  };
}

export type ProjectEgressDiscoveredResourceKind =
  | 'PROXY_CONTAINER'
  | 'INTERNAL_NETWORK'
  | 'PUBLIC_NETWORK'
  | 'FIREWALL_CHAIN';

export interface ProjectEgressDiscoveredResource {
  kind: ProjectEgressDiscoveredResourceKind;
  name: string;
  projectId: string;
  actorId: string | null;
  provider: string | null;
  consumerKind: ProjectEgressWorkloadConsumerKind | null;
  workloadId: string | null;
  identityFingerprint: string;
  policyFingerprint: string | null;
  dockerId: string | null;
  family: 4 | 6 | null;
  firewallComment: string | null;
  sourceCidrs: readonly string[];
  chainDeclared: boolean;
  snapshotFingerprint: string;
  transitionInvariantFingerprint: string | null;
}

export interface ProjectEgressDiscoveryOptions {
  expectedIdentities?: readonly ProjectEgressIdentity[];
  /** Teardown requires provider runtimes to be gone; read-only preflight does not. */
  requireNoRuntimeMembers?: boolean;
  /**
   * Exact teardown may recover a Docker-stopped proxy whose two declared
   * network attachments no longer have endpoints. Ordinary discovery keeps
   * this state fail-closed so it can never be mistaken for a live plane.
   */
  allowExitedDetachedProxyDebris?: boolean;
}

export interface ProjectEgressTeardownResult {
  projectId: string;
  discoveredResourceCount: number;
  removedResourceCount: number;
  alreadyAbsent: boolean;
}

export class ProjectEgressAttestationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProjectEgressAttestationError';
    this.code = code;
  }
}

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requireOpaqueId(value: string, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function normalizeProvider(value: string): string {
  const provider = requireOpaqueId(value, 'provider').toUpperCase() === 'GROK'
    ? 'GROK_BUILD'
    : value.toUpperCase();
  if (![
    'OPENCLAW',
    'CLAUDE_CODE',
    'CODEX',
    'AGENT_ZERO',
    'GEMINI',
    'OLLAMA',
    'GROK_BUILD',
    'PORTAL_WORKLOAD',
  ].includes(provider)) {
    throw new Error('provider is invalid');
  }
  return provider;
}

export function buildProjectEgressIdentityScope(identityInput: ProjectEgressIdentity): ProjectEgressIdentityScope {
  const provider = normalizeProvider(identityInput.provider);
  const workload = provider === 'PORTAL_WORKLOAD';
  if (workload) {
    if (!PROJECT_EGRESS_WORKLOAD_CONSUMER_KINDS.includes(identityInput.consumerKind as ProjectEgressWorkloadConsumerKind)) {
      throw new Error('consumerKind is invalid');
    }
    requireOpaqueId(identityInput.workloadId || '', 'workloadId');
  } else if (identityInput.consumerKind !== undefined || identityInput.workloadId !== undefined) {
    throw new Error('Provider egress identities cannot carry workload fields');
  }
  const identity = Object.freeze({
    actorId: requireOpaqueId(identityInput.actorId, 'actorId'),
    projectId: requireOpaqueId(identityInput.projectId, 'projectId'),
    provider,
    ...(workload ? {
      consumerKind: identityInput.consumerKind as ProjectEgressWorkloadConsumerKind,
      workloadId: requireOpaqueId(identityInput.workloadId || '', 'workloadId'),
    } : {}),
  });
  const identityFingerprint = stableHash(identity);
  const actorFingerprint = stableHash({ actorId: identity.actorId });
  const projectFingerprint = stableHash({ projectId: identity.projectId });
  const providerFingerprint = stableHash({ provider: identity.provider });
  const suffix = identityFingerprint.slice(0, 20);
  return Object.freeze({
    identity,
    identityFingerprint,
    actorFingerprint,
    projectFingerprint,
    providerFingerprint,
    internalNetworkName: `p4e-in-${suffix}`,
    publicNetworkName: `p4e-out-${suffix}`,
    proxyContainerName: `p4e-proxy-${suffix}`,
    firewallChainName: `P4E-${identityFingerprint.slice(0, 23).toUpperCase()}`,
    firewallComment: `${FIREWALL_COMMENT_PREFIX}:${projectFingerprint}:${identityFingerprint}`,
  });
}

function requirePinnedImage(image: string): string {
  if (!/^(?:[a-z0-9][a-z0-9._/-]*@)?sha256:[a-f0-9]{64}$/i.test(image)) {
    throw new Error('Project egress proxy image must be pinned by sha256 digest');
  }
  return image;
}

function cidrForAddress(address: string): string | null {
  if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(address)) return `${address}/32`;
  if (address.includes(':') && !address.includes('%')) return `${address}/128`;
  return null;
}

export function discoverProjectEgressHostDeniedCidrs(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const cidrs = new Set<string>();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      // Only the host's PUBLIC addresses need discovery: every private,
      // link-local, and CGN range is already statically denied. Private
      // addresses here would also poison the policy fingerprint, because
      // creating this plane's own Docker bridges mutates the interface set
      // and every later spec computation would hash differently.
      if (!isPublicProjectEgressAddress(address.address)) continue;
      const cidr = cidrForAddress(address.address);
      if (cidr) cidrs.add(cidr);
    }
  }
  return [...cidrs].sort();
}

export function issueProjectEgressProxyToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function buildProjectEgressPlaneSpec(config: ProjectEgressPlaneConfig): ProjectEgressPlaneSpec {
  const identityScope = buildProjectEgressIdentityScope(config.identity);
  const { identity } = identityScope;
  const proxyImage = requirePinnedImage(config.proxyImage);
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(config.token)) {
    throw new Error('Project egress proxy token must be base64url and contain at least 256 bits');
  }
  const deniedCidrs = [...new Set([
    ...PROJECT_EGRESS_BLOCKED_IPV4_CIDRS,
    ...PROJECT_EGRESS_BLOCKED_IPV6_CIDRS,
    ...discoverProjectEgressHostDeniedCidrs(),
    ...(config.extraDeniedCidrs || []),
  ])].sort();
  const proxyCommand = config.proxyCommand?.length
    ? [...config.proxyCommand]
    : ['node', '/opt/bridgesllm/backend/dist/services/projectEgressProxy.js'];
  if (proxyCommand.some((part) => !part || /[\u0000\r\n]/.test(part))) {
    throw new Error('Project egress proxy command is invalid');
  }
  const policyFingerprint = stableHash({
    policyVersion: PROJECT_EGRESS_POLICY_VERSION,
    identity,
    proxyImage,
    proxyCommand,
    deniedCidrs,
    ports: [80, 443],
    topology: 'runtime--internal-network--proxy--public-network',
    confinementSecurityOptions: projectRuntimeSecurityOptionValues(),
  });
  return {
    ...identityScope,
    policyFingerprint,
    proxyImage,
    proxyCommand,
    token: config.token,
    tokenHash: stableHash(config.token),
    deniedCidrs,
    proxyAlias: PROXY_ALIAS,
    proxyPort: PROXY_PORT,
  };
}

/**
 * Reconstruct the one egress policy generation immediately before
 * installer-managed runtime confinement became part of the policy hash.
 * Network names are identity-derived and therefore unchanged. Provider
 * runtimes use this digest solely to attest and retire that known generation
 * before the current plane converges.
 */
export function derivePreConfinementProjectEgressPolicyFingerprint(
  spec: ProjectEgressPlaneSpec,
): string {
  return stableHash({
    policyVersion: PROJECT_EGRESS_POLICY_VERSION,
    identity: spec.identity,
    proxyImage: spec.proxyImage,
    proxyCommand: [...spec.proxyCommand],
    deniedCidrs: [...spec.deniedCidrs],
    ports: [80, 443],
    topology: 'runtime--internal-network--proxy--public-network',
  });
}

function fail(code: string, message: string): never {
  throw new ProjectEgressAttestationError(code, message);
}

function assertExactLabels(
  labels: Record<string, string> | null | undefined,
  expected: Record<string, string>,
  code: string,
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (labels?.[key] !== value) fail(code, `Project egress label ${key} did not match`);
  }
}

function identityLabels(
  scope: ProjectEgressIdentityScope,
  role: 'internal' | 'proxy-public' | 'proxy',
): Record<string, string> {
  return {
    [LABEL_POLICY]: PROJECT_EGRESS_POLICY_VERSION,
    [LABEL_IDENTITY]: scope.identityFingerprint,
    [LABEL_ACTOR_ID]: scope.identity.actorId,
    [LABEL_PROJECT_ID]: scope.identity.projectId,
    [LABEL_PROVIDER]: scope.identity.provider,
    ...(scope.identity.consumerKind ? { [LABEL_CONSUMER_KIND]: scope.identity.consumerKind } : {}),
    ...(scope.identity.workloadId ? { [LABEL_WORKLOAD_ID]: scope.identity.workloadId } : {}),
    [LABEL_ROLE]: role,
  };
}

function policyLabels(
  spec: ProjectEgressPlaneSpec,
  role: 'internal' | 'proxy-public' | 'proxy',
): Record<string, string> {
  return {
    ...identityLabels(spec, role),
    [LABEL_FINGERPRINT]: spec.policyFingerprint,
  };
}

export function attestProjectEgressNetworks(
  spec: ProjectEgressPlaneSpec,
  internal: DockerNetworkInspect,
  publicNetwork: DockerNetworkInspect,
): void {
  attestExactCurrentProjectEgressNetwork(spec, internal, 'internal');
  attestExactCurrentProjectEgressNetwork(spec, publicNetwork, 'proxy-public');
}

function hasNoNewPrivileges(values: string[] | null | undefined): boolean {
  // Docker reports the flag exactly as created: bare `no-new-privileges`
  // and `no-new-privileges:true` are the same enforced setting.
  return Boolean(values?.some((value) => {
    const normalized = value.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return normalized === 'nonewprivilegestrue' || normalized === 'nonewprivileges';
  }));
}

function attestExactCurrentProjectEgressNetwork(
  spec: ProjectEgressPlaneSpec,
  network: DockerNetworkInspect,
  role: 'internal' | 'proxy-public',
): void {
  const expectedName = role === 'internal'
    ? spec.internalNetworkName
    : spec.publicNetworkName;
  if (network.Name !== expectedName
    || network.Driver !== 'bridge'
    || network.Internal !== (role === 'internal')) {
    fail(
      role === 'internal' ? 'INTERNAL_NETWORK_POLICY' : 'PUBLIC_NETWORK_POLICY',
      role === 'internal'
        ? 'Project egress internal network is not isolated'
        : 'Project egress proxy network is invalid',
    );
  }
  assertExactLabels(
    network.Labels,
    policyLabels(spec, role),
    role === 'internal' ? 'INTERNAL_NETWORK_LABELS' : 'PUBLIC_NETWORK_LABELS',
  );
}

function attestExactProxyHostHardening(
  inspect: DockerContainerInspect,
  code: string,
  message: string,
): void {
  const host = inspect.HostConfig || {};
  const capDrop = (host.CapDrop || []).map((value) => String(value).toUpperCase());
  const tmpfs = host.Tmpfs?.['/tmp'] || '';
  const tmpfsFlags = tmpfs.split(',').sort();
  const exactTmpfs = [
    ['nodev', 'noexec', 'nosuid', 'rw', 'size=16m'],
    ['nodev', 'noexec', 'nosuid', 'rw', 'size=16777216'],
  ];
  if (host.Privileged
    || host.ReadonlyRootfs !== true
    || (host.CapAdd?.length || 0) > 0
    || capDrop.length !== 1
    || capDrop[0] !== 'ALL'
    || !hasNoNewPrivileges(host.SecurityOpt)
    || String(host.PidMode || '') !== ''
    || !['', 'private'].includes(String(host.IpcMode || ''))
    || String(host.UTSMode || '') !== ''
    || String(host.UsernsMode || '') !== ''
    || !['', 'private'].includes(String(host.CgroupnsMode || ''))
    || host.RestartPolicy?.Name !== 'no'
    || host.Init === true
    || host.AutoRemove === true
    || host.OomKillDisable === true
    || host.PidsLimit !== 128
    || host.Memory !== 256 * 1024 * 1024
    || host.NanoCpus !== 500_000_000
    || (inspect.Mounts?.length || 0) > 0
    || (host.Binds?.length || 0) > 0
    || (host.Mounts?.length || 0) > 0
    || Object.keys(host.PortBindings || {}).length > 0
    || host.PublishAllPorts === true
    || (host.Devices?.length || 0) > 0
    || (host.DeviceRequests?.length || 0) > 0
    || (host.DeviceCgroupRules?.length || 0) > 0
    || (host.Dns?.length || 0) > 0
    || (host.DnsOptions?.length || 0) > 0
    || (host.DnsSearch?.length || 0) > 0
    || (host.ExtraHosts?.length || 0) > 0
    || (host.Links?.length || 0) > 0
    || (host.VolumesFrom?.length || 0) > 0
    || Object.keys(host.Tmpfs || {}).length !== 1
    || !exactTmpfs.some((expected) => JSON.stringify(expected) === JSON.stringify(tmpfsFlags))) {
    fail(code, message);
  }
}

export function attestProjectEgressProxyContainer(
  spec: ProjectEgressPlaneSpec,
  inspect: DockerContainerInspect,
  requireRunning = true,
  requireInternalAttachment = true,
  expectedPublicNetworkId?: string,
  expectedInternalNetworkId?: string,
  expectedPublicIpv4?: string,
): { publicIpv4: string | null; publicIpv6: string | null } {
  assertExactLabels(inspect.Config?.Labels, {
    ...policyLabels(spec, 'proxy'),
    [LABEL_TOKEN_HASH]: spec.tokenHash,
  }, 'PROXY_LABELS');
  const expectedImageId = `sha256:${spec.proxyImage.split('sha256:').at(-1) || ''}`.toLowerCase();
  if (inspect.Config?.Image !== spec.proxyImage
    || String(inspect.Image || '').toLowerCase() !== expectedImageId) {
    fail('PROXY_IMAGE', 'Project egress proxy image digest did not match');
  }
  if (JSON.stringify(inspect.Config?.Cmd || []) !== JSON.stringify(spec.proxyCommand)
    || (inspect.Config?.Entrypoint?.length || 0) !== 0
    || inspect.Config?.WorkingDir !== '/opt/bridgesllm/backend') {
    fail('PROXY_COMMAND', 'Project egress proxy command did not match');
  }
  const environment = proxyEnvironmentValues(inspect);
  attestExactProxyEnvironmentShape(environment);
  if (requireSingleProxyEnvironment(environment, 'PROJECT_EGRESS_PROXY_TOKEN') !== spec.token
    || requireSingleProxyEnvironment(environment, 'PROJECT_EGRESS_PROXY_PORT') !== String(spec.proxyPort)
    || requireSingleProxyEnvironment(environment, 'PROJECT_EGRESS_DENY_CIDRS') !== JSON.stringify(spec.deniedCidrs)) {
    fail('PROXY_ENVIRONMENT', 'Project egress proxy security environment did not match');
  }
  if (inspect.Config?.User !== '65532:65532') {
    fail('PROXY_USER', 'Project egress proxy user did not match');
  }
  if (inspect.State?.Running !== requireRunning) {
    fail('PROXY_STATE', `Project egress proxy must be ${requireRunning ? 'running' : 'stopped'}`);
  }
  const host = inspect.HostConfig || {};
  try {
    attestProjectRuntimeSecurityOptions({
      securityOpt: host.SecurityOpt,
      appArmorProfile: inspect.AppArmorProfile,
    });
  } catch {
    fail('PROXY_CONFINEMENT', 'Project egress proxy confinement profiles did not match');
  }
  attestExactProxyHostHardening(
    inspect,
    'PROXY_HARDENING',
    'Project egress proxy container hardening did not match',
  );
  const networks = inspect.NetworkSettings?.Networks || {};
  const names = Object.keys(networks).sort();
  const expectedNames = requireInternalAttachment
    ? [spec.internalNetworkName, spec.publicNetworkName].sort()
    : [spec.publicNetworkName];
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    fail('PROXY_NETWORK_ATTACHMENTS', 'Project egress proxy has unexpected network attachments');
  }
  if (requireInternalAttachment
    && !networks[spec.internalNetworkName]?.Aliases?.includes(spec.proxyAlias)) {
    fail('PROXY_ALIAS', 'Project egress proxy internal alias is missing');
  }
  const publicAttachment = networks[spec.publicNetworkName];
  const staticPublicIpv4 = String(publicAttachment?.IPAMConfig?.IPv4Address || '');
  if (!net.isIPv4(staticPublicIpv4)
    || (expectedPublicIpv4 && staticPublicIpv4 !== expectedPublicIpv4)
    || (requireRunning && publicAttachment?.IPAddress !== staticPublicIpv4)) {
    fail('PROXY_PUBLIC_ADDRESS', 'Project egress proxy static public address did not match');
  }
  const networkMode = String(host.NetworkMode || '').toLowerCase();
  const networkModeMatches = expectedPublicNetworkId
    ? networkMode === expectedPublicNetworkId
      || (networkMode === spec.publicNetworkName
        && String(publicAttachment?.NetworkID || '').toLowerCase() === expectedPublicNetworkId)
    : networkMode === spec.publicNetworkName
      || (/^[a-f0-9]{64}$/i.test(networkMode)
        && String(publicAttachment?.NetworkID || '').toLowerCase() === networkMode);
  const internalNetworkId = String(networks[spec.internalNetworkName]?.NetworkID || '').toLowerCase();
  const publicNetworkId = String(publicAttachment?.NetworkID || '').toLowerCase();
  if (!networkModeMatches
    || (expectedPublicNetworkId
      && publicNetworkId !== expectedPublicNetworkId
      && !(networkMode === expectedPublicNetworkId && !requireRunning && publicNetworkId === ''))
    || (requireInternalAttachment && expectedInternalNetworkId
      && internalNetworkId !== expectedInternalNetworkId
      && !(networkMode === expectedPublicNetworkId && !requireRunning && internalNetworkId === ''))) {
    fail('PROXY_NETWORK_MODE', 'Project egress proxy primary network did not match');
  }
  // Docker only fills IPAddress while the container runs. The firewall must
  // know the address before start, so the proxy is created with a static
  // IPAM assignment; read that when the runtime address is absent.
  return {
    publicIpv4: publicAttachment?.IPAddress || publicAttachment?.IPAMConfig?.IPv4Address || null,
    publicIpv6: publicAttachment?.GlobalIPv6Address || publicAttachment?.IPAMConfig?.IPv6Address || null,
  };
}

export function attestProjectEgressNetworkMembership(input: {
  network: DockerNetworkInspect;
  expectedNames: readonly string[];
  /**
   * Members that are legitimately attached but may be stopped. Docker's
   * network inspect only lists running containers, so a stopped runtime
   * (its attachment is attested container-side) must not fail membership.
   */
  optionalNames?: readonly string[];
  role: 'internal' | 'proxy-public';
}): void {
  const optional = new Set(input.optionalNames || []);
  const actualNames = Object.values(input.network.Containers || {})
    .map((container) => container.Name || '')
    .filter(Boolean)
    .filter((name) => !optional.has(name))
    .sort();
  const expectedNames = [...input.expectedNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    fail('NETWORK_MEMBERSHIP', `Project egress ${input.role} network has unexpected members`);
  }
}

export function attestProjectRuntimeEgressAttachment(
  spec: ProjectEgressPlaneSpec,
  inspect: DockerContainerInspect,
  expectedRuntimeFingerprint: string,
  expectedInternalNetworkId?: string,
): void {
  if (inspect.State?.Running !== false) {
    fail('RUNTIME_RUNNING_DURING_ATTESTATION', 'Project runtime must be stopped while its network policy is attested');
  }
  if (inspect.Config?.Labels?.[LABEL_RUNTIME_FINGERPRINT] !== expectedRuntimeFingerprint) {
    fail('RUNTIME_IDENTITY', 'Project runtime identity fingerprint did not match');
  }
  const networks = Object.keys(inspect.NetworkSettings?.Networks || {});
  if (networks.length !== 1 || networks[0] !== spec.internalNetworkName) {
    fail('RUNTIME_NETWORK_ATTACHMENTS', 'Project runtime must be attached only to its isolated project network');
  }
  if (expectedInternalNetworkId
    ) {
    const expectedId = requireImmutableDockerId(
      expectedInternalNetworkId,
      'Project egress internal network',
    );
    const reportedId = String(
      inspect.NetworkSettings?.Networks?.[spec.internalNetworkName]?.NetworkID || '',
    ).toLowerCase();
    // A never-started container reports no attachment ids: neither its
    // create-time `--network none` mode nor a later `network connect` to the
    // internal network materializes NetworkID before first start. The
    // immutable binding for that stopped shape is proven from the network
    // side (exact-id membership attestation), so only the two creation modes
    // the Portal itself uses are tolerated here.
    const stoppedIdPrimary = reportedId === ''
      && ['none', expectedId].includes(String(inspect.HostConfig?.NetworkMode || '').toLowerCase());
    if (reportedId !== expectedId && !stoppedIdPrimary) {
      fail('RUNTIME_NETWORK_IDENTITY', 'Project runtime is attached to another immutable network');
    }
  }
  if (inspect.HostConfig?.NetworkMode === 'host') {
    fail('RUNTIME_HOST_NETWORK', 'Project runtime cannot share the host network');
  }
}

function expectedFirewallRules(spec: ProjectEgressPlaneSpec, family: 4 | 6): string[] {
  const cidrs = spec.deniedCidrs.filter((cidr) => (family === 4 ? cidr.includes('.') : cidr.includes(':')));
  const comment = `-m comment --comment ${spec.firewallComment}`;
  return [
    ...cidrs.map((cidr) => `-A ${spec.firewallChainName} -d ${cidr} ${comment} -j REJECT`),
    family === 4
      ? `-A ${spec.firewallChainName} -p tcp -m multiport --dports 80,443 ${comment} -j RETURN`
      : `-A ${spec.firewallChainName} -d 2000::/3 -p tcp -m multiport --dports 80,443 ${comment} -j RETURN`,
    `-A ${spec.firewallChainName} ${comment} -j REJECT`,
  ];
}

// iptables 1.8+ (nf_tables) canonicalizes `-S` output: comments print quoted
// and REJECT expands to its default `--reject-with`. Normalize to the
// unquoted, unexpanded form the expected-rule builders produce, or every
// real-host attestation fails against rules this code itself installed.
function normalizeFirewallStatement(line: string): string {
  return line
    .replace(/--comment "([^"]*)"/g, '--comment $1')
    .replace(/ -j REJECT --reject-with icmp6?-port-unreachable$/, ' -j REJECT');
}

function statementRules(output: string, chain: string): string[] {
  return output.split(/\r?\n/)
    .map((line) => normalizeFirewallStatement(line.trim()))
    .filter((line) => line.startsWith(`-A ${chain} `));
}

export function attestProjectEgressFirewallStatements(input: {
  spec: ProjectEgressPlaneSpec;
  family: 4 | 6;
  proxyAddress: string;
  dockerUserStatements: string;
  masterStatements: string;
  projectStatements: string;
}): void {
  const tool = input.family === 4 ? 'iptables' : 'ip6tables';
  const dockerUser = statementRules(input.dockerUserStatements, DOCKER_USER_CHAIN);
  if (dockerUser[0] !== `-A ${DOCKER_USER_CHAIN} -j ${MASTER_FIREWALL_CHAIN}`) {
    fail('FIREWALL_PRECEDENCE', `${tool} project egress jump is not the first DOCKER-USER rule`);
  }
  const master = statementRules(input.masterStatements, MASTER_FIREWALL_CHAIN);
  const expectedJump = `-A ${MASTER_FIREWALL_CHAIN} -s ${input.proxyAddress}/`
    + `${input.family === 4 ? '32' : '128'} -m comment --comment ${input.spec.firewallComment}`
    + ` -j ${input.spec.firewallChainName}`;
  const jumpIndex = master.indexOf(expectedJump);
  const returnIndex = master.indexOf(`-A ${MASTER_FIREWALL_CHAIN} -j RETURN`);
  if (jumpIndex < 0 || (returnIndex >= 0 && jumpIndex > returnIndex)) {
    fail('FIREWALL_SOURCE_JUMP', `${tool} project egress source jump is missing or shadowed`);
  }
  const permittedPrecedingRule = new RegExp(
    `^-A ${MASTER_FIREWALL_CHAIN} -s (?!${input.proxyAddress.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/)`
      + `[^ ]+ -m comment --comment ${FIREWALL_COMMENT_PREFIX}:[a-f0-9]{64}:[a-f0-9]{64}`
      + ` -j P4E-[A-F0-9]{23}$`,
  );
  if (master.slice(0, jumpIndex).some((rule) => !permittedPrecedingRule.test(rule))) {
    fail('FIREWALL_MASTER_PRECEDENCE', `${tool} project egress source jump is preceded by a bypass rule`);
  }
  const actualProjectRules = statementRules(input.projectStatements, input.spec.firewallChainName);
  const expectedProjectRules = expectedFirewallRules(input.spec, input.family);
  if (JSON.stringify(actualProjectRules) !== JSON.stringify(expectedProjectRules)) {
    fail('FIREWALL_PROJECT_RULES', `${tool} project egress firewall rules did not match exactly`);
  }
}

class SpawnCommandExecutor implements ProjectEgressCommandExecutor {
  async run(
    command: string,
    args: readonly string[],
    options: { allowExitCodes?: readonly number[]; input?: string } = {},
  ): Promise<ProjectEgressCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      const collect = (target: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          reject(new Error('Project egress command output exceeded the safety limit'));
          return;
        }
        target.push(Buffer.from(chunk));
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.once('error', () => reject(new Error('Project egress host command failed to start')));
      child.once('close', (code) => {
        const exitCode = code ?? 1;
        const result = {
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode,
        };
        if (!(options.allowExitCodes || [0]).includes(exitCode)) {
          // Command shape + stderr tail: these are fixed portal-owned docker
          // and iptables invocations, and a bare exit code has repeatedly
          // proven undiagnosable on live hosts.
          const summary = [command, ...args.slice(0, 4)].join(' ');
          const detail = result.stderr.trim().slice(-300);
          reject(new Error(`Project egress host command failed with exit code ${exitCode} (${summary}${args.length > 4 ? ' …' : ''})${detail ? `: ${detail}` : ''}`));
          return;
        }
        resolve(result);
      });
      if (options.input) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }
}

export const projectEgressCommandExecutor: ProjectEgressCommandExecutor = new SpawnCommandExecutor();

/**
 * Resolve the installer-built proxy tag to its immutable local image ID. A
 * local Docker image ID is content-addressed even when no registry RepoDigest
 * exists, and Docker accepts it directly for container creation.
 */
export async function resolvePinnedProjectEgressProxyImage(
  imageTag = PROJECT_EGRESS_PROXY_IMAGE_TAG,
  executor: ProjectEgressCommandExecutor = projectEgressCommandExecutor,
): Promise<string> {
  const result = await executor.run('docker', [
    'image', 'inspect', '--format', '{{.Id}}', imageTag,
  ]);
  const imageId = result.stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/i.test(imageId)) {
    fail('PROXY_IMAGE_ID', 'Project egress proxy image did not resolve to an immutable Docker image ID');
  }
  return imageId;
}

function requireDockerName(value: unknown, label: string): string {
  const name = String(value || '').replace(/^\//, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) {
    fail('DOCKER_RESOURCE_NAME', `${label} name is invalid`);
  }
  return name;
}

function requireDockerId(value: unknown, label: string): string {
  const id = String(value || '');
  if (!/^[a-f0-9]{12,64}$/i.test(id)) fail('DOCKER_RESOURCE_ID', `${label} id is invalid`);
  return id;
}

function requireImmutableDockerId(value: unknown, label: string): string {
  const id = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(id)) fail('DOCKER_RESOURCE_ID', `${label} immutable id is invalid`);
  return id;
}

function isDockerNotFound(result: ProjectEgressCommandResult, kind: 'network' | 'container'): boolean {
  // Docker 29 rephrased inspect errors ("network X not found") from the
  // older "no such network"; accept both or absence can never be proven.
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (kind === 'network') {
    return text.includes('no such network')
      || (text.includes('network') && text.includes('not found'));
  }
  return text.includes('no such object')
    || text.includes('no such container')
    || (text.includes('container') && text.includes('not found'))
    || (text.includes('object') && text.includes('not found'));
}

async function strictInspectOne<T>(
  executor: ProjectEgressCommandExecutor,
  kind: 'network' | 'container',
  name: string,
): Promise<T | null> {
  const result = await executor.run('docker', [kind, 'inspect', name], { allowExitCodes: [0, 1] });
  if (result.exitCode !== 0) {
    if (isDockerNotFound(result, kind)) return null;
    fail('DOCKER_INSPECT_FAILED', `Docker ${kind} inspection failed without proving absence`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail('DOCKER_INSPECT_JSON', `Docker ${kind} inspection returned invalid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== 'object') {
    fail('DOCKER_INSPECT_SHAPE', `Docker ${kind} inspection returned an invalid shape`);
  }
  return parsed[0] as T;
}

async function listProjectDockerResourceNames(
  executor: ProjectEgressCommandExecutor,
  kind: 'network' | 'container',
  projectId: string,
): Promise<string[]> {
  const args = kind === 'container'
    ? ['container', 'ls', '--all', '--filter', `label=${LABEL_PROJECT_ID}=${projectId}`, '--format', '{{.Names}}']
    : ['network', 'ls', '--filter', `label=${LABEL_PROJECT_ID}=${projectId}`, '--format', '{{.Name}}'];
  const result = await executor.run('docker', args);
  const names = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    .map((value) => requireDockerName(value, `Project egress ${kind}`));
  if (new Set(names).size !== names.length) {
    fail('DOCKER_RESOURCE_DUPLICATE', `Docker returned duplicate Project egress ${kind} names`);
  }
  return names.sort();
}

function managedIdentityFromLabels(
  labels: Record<string, string> | null | undefined,
  expectedProjectId: string,
  expectedRole: 'internal' | 'proxy-public' | 'proxy',
): { scope: ProjectEgressIdentityScope; policyFingerprint: string } {
  const actorId = requireOpaqueId(labels?.[LABEL_ACTOR_ID] || '', 'managed actor label');
  const projectId = requireOpaqueId(labels?.[LABEL_PROJECT_ID] || '', 'managed project label');
  const provider = normalizeProvider(labels?.[LABEL_PROVIDER] || '');
  if (projectId !== expectedProjectId) {
    fail('MANAGED_PROJECT_LABEL', 'Project egress resource belonged to another immutable project');
  }
  const scope = buildProjectEgressIdentityScope({
    actorId,
    projectId,
    provider,
    ...(provider === 'PORTAL_WORKLOAD' ? {
      consumerKind: labels?.[LABEL_CONSUMER_KIND] as ProjectEgressWorkloadConsumerKind,
      workloadId: labels?.[LABEL_WORKLOAD_ID] || '',
    } : {}),
  });
  assertExactLabels(labels, identityLabels(scope, expectedRole), 'MANAGED_IDENTITY_LABELS');
  const policyFingerprint = String(labels?.[LABEL_FINGERPRINT] || '');
  if (!/^[a-f0-9]{64}$/i.test(policyFingerprint)) {
    fail('MANAGED_POLICY_LABEL', 'Project egress policy fingerprint label is invalid');
  }
  return { scope, policyFingerprint };
}

function dockerResourceSnapshot(value: unknown): string {
  return stableHash(value);
}

function baseDiscoveredResource(input: {
  kind: ProjectEgressDiscoveredResourceKind;
  name: string;
  scope: ProjectEgressIdentityScope;
  policyFingerprint: string | null;
  dockerId?: string | null;
  family?: 4 | 6 | null;
  firewallComment?: string | null;
  sourceCidrs?: readonly string[];
  chainDeclared?: boolean;
  snapshot: unknown;
  transitionInvariant?: unknown;
}): ProjectEgressDiscoveredResource {
  return Object.freeze({
    kind: input.kind,
    name: input.name,
    projectId: input.scope.identity.projectId,
    actorId: input.scope.identity.actorId || null,
    provider: input.scope.identity.provider || null,
    consumerKind: input.scope.identity.consumerKind || null,
    workloadId: input.scope.identity.workloadId || null,
    identityFingerprint: input.scope.identityFingerprint,
    policyFingerprint: input.policyFingerprint,
    dockerId: input.dockerId || null,
    family: input.family || null,
    firewallComment: input.firewallComment || null,
    sourceCidrs: Object.freeze([...(input.sourceCidrs || [])]),
    chainDeclared: input.chainDeclared === true,
    snapshotFingerprint: dockerResourceSnapshot(input.snapshot),
    transitionInvariantFingerprint: input.transitionInvariant === undefined
      ? null
      : dockerResourceSnapshot(input.transitionInvariant),
  });
}

function namesInNetwork(network: DockerNetworkInspect): string[] {
  return Object.values(network.Containers || {}).map((entry) => requireDockerName(entry.Name, 'network member')).sort();
}

function proxyDiscoverySnapshot(inspect: DockerContainerInspect) {
  const attachments = inspect.NetworkSettings?.Networks || {};
  return {
    dockerId: requireDockerId(inspect.Id, 'Project egress proxy'),
    labels: inspect.Config?.Labels,
    attached: Object.keys(attachments).sort(),
    attachments: Object.fromEntries(Object.entries(attachments)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, attachment]) => [name, {
        networkId: attachment.NetworkID || '',
        endpointId: attachment.EndpointID || '',
        address: attachment.IPAddress || '',
        globalIpv6Address: attachment.GlobalIPv6Address || '',
        configuredIpv4Address: attachment.IPAMConfig?.IPv4Address || '',
        configuredIpv6Address: attachment.IPAMConfig?.IPv6Address || '',
        aliases: [...(attachment.Aliases || [])].sort(),
      }])),
    networkMode: inspect.HostConfig?.NetworkMode,
    running: inspect.State?.Running,
  };
}

function proxyStoppedTransitionInvariant(inspect: DockerContainerInspect) {
  const snapshot = proxyDiscoverySnapshot(inspect);
  return {
    dockerId: snapshot.dockerId,
    labels: snapshot.labels,
    attached: snapshot.attached,
    attachments: Object.fromEntries(Object.entries(snapshot.attachments).map(([name, attachment]) => [name, {
      networkId: attachment.networkId,
      configuredIpv4Address: attachment.configuredIpv4Address,
      configuredIpv6Address: attachment.configuredIpv6Address,
      aliases: attachment.aliases,
    }])),
    networkMode: snapshot.networkMode,
  };
}

function proxyRuntimeEndpointsAreEmpty(inspect: DockerContainerInspect): boolean {
  return Object.values(inspect.NetworkSettings?.Networks || {}).every((attachment) => (
    String(attachment.EndpointID || '') === ''
    && String(attachment.IPAddress || '') === ''
    && String(attachment.GlobalIPv6Address || '') === ''
  ));
}

function proxyAttachmentIsUnmaterialized(
  attachment: NonNullable<NonNullable<DockerContainerInspect['NetworkSettings']>['Networks']>[string]
    | undefined,
): boolean {
  return !attachment || (
    String(attachment.NetworkID || '') === ''
    && String(attachment.EndpointID || '') === ''
    && String(attachment.IPAddress || '') === ''
    && String(attachment.GlobalIPv6Address || '') === ''
    && String(attachment.IPAMConfig?.IPv6Address || '') === ''
  );
}

function assertPolicyConsistency(resources: readonly ProjectEgressDiscoveredResource[]): void {
  const fingerprints = new Map<string, string>();
  for (const resource of resources) {
    if (!resource.policyFingerprint) continue;
    const existing = fingerprints.get(resource.identityFingerprint);
    if (existing && existing !== resource.policyFingerprint) {
      fail('POLICY_FINGERPRINT_DRIFT', 'Project egress resources disagreed on their policy fingerprint');
    }
    fingerprints.set(resource.identityFingerprint, resource.policyFingerprint);
  }
}

function normalizeFirewallLine(line: string): string {
  // Must match normalizeFirewallStatement: nf_tables canonicalizes REJECT
  // with its default --reject-with, and shape checks compare against the
  // unexpanded form this code writes.
  return line.trim()
    .replace(/--comment "([^"]+)"/g, '--comment $1')
    .replace(/ -j REJECT --reject-with icmp6?-port-unreachable$/, ' -j REJECT');
}

function parseFirewallIdentityComment(
  line: string,
  projectFingerprint: string,
): { comment: string; identityFingerprint: string } | null {
  const prefix = `${FIREWALL_COMMENT_PREFIX}:${projectFingerprint}:`;
  if (!line.includes(prefix)) return null;
  const match = normalizeFirewallLine(line).match(new RegExp(
    `--comment (${FIREWALL_COMMENT_PREFIX}:${projectFingerprint}:([a-f0-9]{64}))(?: |$)`,
    'i',
  ));
  if (!match) fail('FIREWALL_IDENTITY_COMMENT', 'Project egress firewall identity comment is malformed');
  return { comment: match[1].toLowerCase(), identityFingerprint: match[2].toLowerCase() };
}

function identityScopeFromFingerprint(input: {
  projectId: string;
  identityFingerprint: string;
  knownScopes: ReadonlyMap<string, ProjectEgressIdentityScope>;
}): ProjectEgressIdentityScope {
  const known = input.knownScopes.get(input.identityFingerprint);
  if (known) return known;
  const projectFingerprint = stableHash({ projectId: input.projectId });
  const suffix = input.identityFingerprint.slice(0, 20);
  return Object.freeze({
    identity: Object.freeze({ actorId: '', projectId: input.projectId, provider: '' }),
    identityFingerprint: input.identityFingerprint,
    actorFingerprint: '',
    projectFingerprint,
    providerFingerprint: '',
    internalNetworkName: `p4e-in-${suffix}`,
    publicNetworkName: `p4e-out-${suffix}`,
    proxyContainerName: `p4e-proxy-${suffix}`,
    firewallChainName: `P4E-${input.identityFingerprint.slice(0, 23).toUpperCase()}`,
    firewallComment: `${FIREWALL_COMMENT_PREFIX}:${projectFingerprint}:${input.identityFingerprint}`,
  });
}

async function discoverProjectFirewallResources(input: {
  executor: ProjectEgressCommandExecutor;
  projectId: string;
  knownScopes: ReadonlyMap<string, ProjectEgressIdentityScope>;
}): Promise<ProjectEgressDiscoveredResource[]> {
  const projectFingerprint = stableHash({ projectId: input.projectId });
  const discovered: ProjectEgressDiscoveredResource[] = [];
  for (const family of [4, 6] as const) {
    const tool = family === 4 ? 'iptables' : 'ip6tables';
    const result = await input.executor.run(tool, ['-w', '-S']);
    const lines = result.stdout.split(/\r?\n/).map(normalizeFirewallLine).filter(Boolean);
    const identities = new Map<string, { comment: string; relevant: string[] }>();
    for (const line of lines) {
      const parsed = parseFirewallIdentityComment(line, projectFingerprint);
      if (!parsed) continue;
      const entry = identities.get(parsed.identityFingerprint) || { comment: parsed.comment, relevant: [] };
      if (entry.comment !== parsed.comment) fail('FIREWALL_IDENTITY_COMMENT', 'Project firewall comments disagreed');
      entry.relevant.push(line);
      identities.set(parsed.identityFingerprint, entry);
    }
    for (const [identityFingerprint, evidence] of identities) {
      const scope = identityScopeFromFingerprint({
        projectId: input.projectId,
        identityFingerprint,
        knownScopes: input.knownScopes,
      });
      if (evidence.comment !== scope.firewallComment) {
        fail('FIREWALL_IDENTITY_COMMENT', 'Project firewall comment did not match its identity');
      }
      const chain = scope.firewallChainName;
      const allReferences = lines.filter((line) => line.startsWith(`-A ${chain} `)
        || line.includes(` -j ${chain}`)
        || line.includes(` -g ${chain}`));
      if (allReferences.some((line) => !evidence.relevant.includes(line))) {
        fail('FIREWALL_UNSCOPED_REFERENCE', 'Project firewall chain has an unscoped reference');
      }
      const sourceCidrs: string[] = [];
      for (const line of evidence.relevant) {
        const escapedComment = evidence.comment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedChain = chain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const jump = line.match(new RegExp(
          `^-A ${MASTER_FIREWALL_CHAIN} -s ([^ ]+) -m comment --comment ${escapedComment} -j ${escapedChain}$`,
        ));
        if (jump) {
          if ((family === 4 && !jump[1].includes('.')) || (family === 6 && !jump[1].includes(':'))) {
            fail('FIREWALL_SOURCE_FAMILY', 'Project firewall source jump used the wrong address family');
          }
          sourceCidrs.push(jump[1]);
          continue;
        }
        // Host-input protection rules legitimately carry this identity
        // comment. Established replies permit only host-initiated traffic to
        // an attested app address; the following rule rejects every NEW
        // container→host flow from the plane subnet.
        const hostInputRule = line.startsWith(`-A ${HOST_FIREWALL_CHAIN} -s `)
          && line.includes(`-m comment --comment ${evidence.comment} `)
          && (line.endsWith('-j REJECT')
            || (line.includes('-m conntrack --ctstate RELATED,ESTABLISHED ')
              && line.endsWith('-j ACCEPT')));
        if (hostInputRule) continue;
        if (!line.startsWith(`-A ${chain} `)
          || !line.includes(`-m comment --comment ${evidence.comment} `)
          || (!line.endsWith('-j REJECT') && !line.endsWith('-j RETURN'))) {
          fail('FIREWALL_SCOPED_RULE', 'Project firewall identity comment appeared on an unsafe rule');
        }
      }
      const chainDeclared = lines.includes(`-N ${chain}`);
      if (!chainDeclared && evidence.relevant.some((line) => line.startsWith(`-A ${chain} `))) {
        fail('FIREWALL_CHAIN_DECLARATION', 'Project firewall chain rules exist without a chain declaration');
      }
      discovered.push(baseDiscoveredResource({
        kind: 'FIREWALL_CHAIN',
        name: chain,
        scope,
        policyFingerprint: null,
        family,
        firewallComment: evidence.comment,
        sourceCidrs: sourceCidrs.sort(),
        chainDeclared,
        snapshot: { family, chainDeclared, lines: evidence.relevant.sort() },
      }));
    }
    for (const scope of input.knownScopes.values()) {
      const declaration = `-N ${scope.firewallChainName}`;
      if (lines.includes(declaration)
        && !discovered.some((resource) => resource.family === family
          && resource.identityFingerprint === scope.identityFingerprint)) {
        const references = lines.filter((line) => line.startsWith(`-A ${scope.firewallChainName} `)
          || line.includes(` -j ${scope.firewallChainName}`)
          || line.includes(` -g ${scope.firewallChainName}`));
        if (references.length > 0) {
          fail('FIREWALL_UNLABELLED_CHAIN', 'A deterministic Project firewall chain lost its identity comments');
        }
        // A crash between flush and delete can leave an empty chain. The
        // expected actor/project/provider identity is sufficient to recover it
        // without broadening deletion to another deterministic name.
        discovered.push(baseDiscoveredResource({
          kind: 'FIREWALL_CHAIN',
          name: scope.firewallChainName,
          scope,
          policyFingerprint: null,
          family,
          firewallComment: scope.firewallComment,
          chainDeclared: true,
          snapshot: { family, chainDeclared: true, lines: [declaration] },
        }));
      }
    }
    const managedDeclarations = lines
      .map((line) => line.match(/^-N (P4E-[A-F0-9]{23})$/)?.[1] || null)
      .filter((chain): chain is string => Boolean(chain));
    for (const chain of managedDeclarations) {
      if (discovered.some((resource) => resource.family === family && resource.name === chain)) continue;
      const references = lines.filter((line) => line.startsWith(`-A ${chain} `)
        || line.includes(` -j ${chain}`)
        || line.includes(` -g ${chain}`));
      const comments = references.map((line) => normalizeFirewallLine(line).match(
        /--comment (p4e-v1:[a-f0-9]{64}:([a-f0-9]{64}))(?: |$)/i,
      ));
      if (references.length === 0 || comments.some((match) => !match)) {
        fail('FIREWALL_AMBIGUOUS_CHAIN', 'An unscoped managed firewall chain prevents safe Project cleanup');
      }
      const identities = new Set(comments.map((match) => match![2].toUpperCase()));
      if (identities.size !== 1 || chain !== `P4E-${[...identities][0].slice(0, 23)}`) {
        fail('FIREWALL_AMBIGUOUS_CHAIN', 'A managed firewall chain does not match its identity comments');
      }
    }
  }
  return discovered;
}

function compareResourceSnapshots(
  expected: readonly ProjectEgressDiscoveredResource[],
  actual: readonly ProjectEgressDiscoveredResource[],
): void {
  const key = (resource: ProjectEgressDiscoveredResource) => [
    resource.kind,
    resource.name,
    resource.family || 0,
    resource.identityFingerprint,
  ].join('\u0000');
  const expectedMap = new Map(expected.map((resource) => [key(resource), resource.snapshotFingerprint]));
  const actualMap = new Map(actual.map((resource) => [key(resource), resource.snapshotFingerprint]));
  if (expectedMap.size !== actualMap.size
    || [...expectedMap].some(([resourceKey, fingerprint]) => actualMap.get(resourceKey) !== fingerprint)) {
    fail('CLEANUP_ATTESTATION_RACE', 'Project egress resources changed between cleanup attestations');
  }
}

/**
 * Discover every managed egress resource for one immutable project. Docker
 * lookup is project-label based so a plane created before its DB binding commits
 * is still found. Firewall comments carry the project and combined identity
 * fingerprints so firewall-only partial state remains attributable.
 */
export async function discoverProjectEgressPlaneResources(
  projectIdInput: string,
  options: ProjectEgressDiscoveryOptions = {},
  executor: ProjectEgressCommandExecutor = projectEgressCommandExecutor,
): Promise<readonly ProjectEgressDiscoveredResource[]> {
  const projectId = requireOpaqueId(projectIdInput, 'projectId');
  const expectedScopes = (options.expectedIdentities || []).map(buildProjectEgressIdentityScope);
  if (new Set(expectedScopes.map((scope) => scope.identityFingerprint)).size !== expectedScopes.length) {
    fail('EXPECTED_IDENTITY_DUPLICATE', 'Project egress expected identities contain duplicates');
  }
  const knownScopes = new Map(expectedScopes.map((scope) => [scope.identityFingerprint, scope]));
  const containerNames = await listProjectDockerResourceNames(executor, 'container', projectId);
  const networkNames = await listProjectDockerResourceNames(executor, 'network', projectId);

  for (const scope of expectedScopes) {
    if (!containerNames.includes(scope.proxyContainerName)
      && await strictInspectOne<DockerContainerInspect>(executor, 'container', scope.proxyContainerName)) {
      fail('PROXY_LABEL_FILTER', 'A deterministic Project egress proxy is missing its project label');
    }
    for (const networkName of [scope.internalNetworkName, scope.publicNetworkName]) {
      if (!networkNames.includes(networkName)
        && await strictInspectOne<DockerNetworkInspect>(executor, 'network', networkName)) {
        fail('NETWORK_LABEL_FILTER', 'A deterministic Project egress network is missing its project label');
      }
    }
  }

  const resources: ProjectEgressDiscoveredResource[] = [];
  const proxies = new Map<string, { inspect: DockerContainerInspect; scope: ProjectEgressIdentityScope }>();
  const networks = new Map<string, { inspect: DockerNetworkInspect; scope: ProjectEgressIdentityScope; role: 'internal' | 'proxy-public' }>();

  for (const name of containerNames) {
    const inspect = await strictInspectOne<DockerContainerInspect>(executor, 'container', name);
    if (!inspect) fail('PROXY_LIST_RACE', 'A listed Project egress proxy disappeared during discovery');
    const normalizedName = requireDockerName(inspect.Name, 'Project egress proxy');
    if (normalizedName !== name) fail('PROXY_NAME', 'Project egress proxy inspection returned another name');
    const managed = managedIdentityFromLabels(inspect.Config?.Labels, projectId, 'proxy');
    if (name !== managed.scope.proxyContainerName) fail('PROXY_IDENTITY_NAME', 'Project egress proxy name did not match its identity');
    const dockerId = requireDockerId(inspect.Id, 'Project egress proxy');
    const tokenHash = String(inspect.Config?.Labels?.[LABEL_TOKEN_HASH] || '');
    if (!/^[a-f0-9]{64}$/i.test(tokenHash)) fail('PROXY_TOKEN_LABEL', 'Project egress proxy token hash label is invalid');
    const attached = Object.keys(inspect.NetworkSettings?.Networks || {}).sort();
    const expectedAttached = [managed.scope.internalNetworkName, managed.scope.publicNetworkName].sort();
    const stoppedWithNoAttachments = options.allowExitedDetachedProxyDebris === true
      && inspect.State?.Running === false
      && attached.length === 0;
    if ((!stoppedWithNoAttachments && JSON.stringify(attached) !== JSON.stringify(expectedAttached))
      || inspect.HostConfig?.NetworkMode === 'host') {
      fail('PROXY_NETWORK_IDENTITY', 'Project egress proxy network attachment did not match its identity');
    }
    knownScopes.set(managed.scope.identityFingerprint, managed.scope);
    proxies.set(managed.scope.identityFingerprint, { inspect, scope: managed.scope });
    resources.push(baseDiscoveredResource({
      kind: 'PROXY_CONTAINER',
      name,
      scope: managed.scope,
      policyFingerprint: managed.policyFingerprint,
      dockerId,
      snapshot: proxyDiscoverySnapshot(inspect),
      transitionInvariant: proxyStoppedTransitionInvariant(inspect),
    }));
  }

  for (const name of networkNames) {
    const inspect = await strictInspectOne<DockerNetworkInspect>(executor, 'network', name);
    if (!inspect) fail('NETWORK_LIST_RACE', 'A listed Project egress network disappeared during discovery');
    if (requireDockerName(inspect.Name, 'Project egress network') !== name) {
      fail('NETWORK_NAME', 'Project egress network inspection returned another name');
    }
    const role = inspect.Labels?.[LABEL_ROLE];
    if (role !== 'internal' && role !== 'proxy-public') {
      fail('NETWORK_ROLE', 'Project egress network role is invalid');
    }
    const managed = managedIdentityFromLabels(inspect.Labels, projectId, role);
    const expectedName = role === 'internal' ? managed.scope.internalNetworkName : managed.scope.publicNetworkName;
    if (name !== expectedName || inspect.Driver !== 'bridge' || inspect.Internal !== (role === 'internal')) {
      fail('NETWORK_IDENTITY_POLICY', 'Project egress network policy did not match its identity');
    }
    const dockerId = requireDockerId(inspect.Id, 'Project egress network');
    knownScopes.set(managed.scope.identityFingerprint, managed.scope);
    networks.set(`${managed.scope.identityFingerprint}:${role}`, { inspect, scope: managed.scope, role });
    resources.push(baseDiscoveredResource({
      kind: role === 'internal' ? 'INTERNAL_NETWORK' : 'PUBLIC_NETWORK',
      name,
      scope: managed.scope,
      policyFingerprint: managed.policyFingerprint,
      dockerId,
      snapshot: {
        dockerId,
        labels: inspect.Labels,
        driver: inspect.Driver,
        internal: inspect.Internal,
        members: namesInNetwork(inspect),
      },
    }));
  }

  const exitedDetachedProxyDebris = new Set<string>();
  for (const [identityFingerprint, proxy] of proxies) {
    if (!networks.has(`${identityFingerprint}:internal`) || !networks.has(`${identityFingerprint}:proxy-public`)) {
      fail('PROXY_NETWORK_MISSING', 'Project egress proxy references a missing managed network');
    }
    const internal = networks.get(`${identityFingerprint}:internal`)!;
    const publicNetwork = networks.get(`${identityFingerprint}:proxy-public`)!;
    const internalAttachment = proxy.inspect.NetworkSettings?.Networks?.[proxy.scope.internalNetworkName];
    const publicAttachment = proxy.inspect.NetworkSettings?.Networks?.[proxy.scope.publicNetworkName];
    if (
      options.allowExitedDetachedProxyDebris === true
      && proxy.inspect.State?.Running === false
      && proxyAttachmentIsUnmaterialized(internalAttachment)
      && proxyAttachmentIsUnmaterialized(publicAttachment)
      && namesInNetwork(internal.inspect).length === 0
      && namesInNetwork(publicNetwork.inspect).length === 0
    ) {
      exitedDetachedProxyDebris.add(identityFingerprint);
    } else {
      const internalAlias = internalAttachment?.Aliases || [];
      if (!internalAlias.includes(PROXY_ALIAS)) fail('PROXY_ALIAS', 'Project egress proxy internal alias is missing');
    }
  }
  for (const entry of networks.values()) {
    const proxy = proxies.get(entry.scope.identityFingerprint);
    const members = namesInNetwork(entry.inspect);
    const expectedProxy = proxy && !exitedDetachedProxyDebris.has(entry.scope.identityFingerprint)
      ? [entry.scope.proxyContainerName]
      : [];
    if (entry.role === 'proxy-public' && JSON.stringify(members) !== JSON.stringify(expectedProxy)) {
      fail('PUBLIC_NETWORK_MEMBERSHIP', 'Project egress public network has unexpected members');
    }
    if (entry.role === 'internal') {
      if (proxy && expectedProxy.length > 0 && !members.includes(entry.scope.proxyContainerName)) {
        fail('INTERNAL_PROXY_MEMBERSHIP', 'Project egress internal network lost its proxy member');
      }
      if (options.requireNoRuntimeMembers
        && JSON.stringify(members) !== JSON.stringify(expectedProxy)) {
        fail('INTERNAL_RUNTIME_STILL_ATTACHED', 'Project provider runtime is still attached to its egress plane');
      }
    }
  }

  resources.push(...await discoverProjectFirewallResources({ executor, projectId, knownScopes }));
  assertPolicyConsistency(resources);
  return Object.freeze(resources.sort((left, right) => [
    left.identityFingerprint, left.kind, left.family || 0, left.name,
  ].join(':').localeCompare([
    right.identityFingerprint, right.kind, right.family || 0, right.name,
  ].join(':'))));
}

function resourcesOfKind(
  resources: readonly ProjectEgressDiscoveredResource[],
  kind: ProjectEgressDiscoveredResourceKind,
): ProjectEgressDiscoveredResource[] {
  return resources.filter((resource) => resource.kind === kind);
}

async function reattestProxyBeforeRemoval(
  executor: ProjectEgressCommandExecutor,
  resource: ProjectEgressDiscoveredResource,
  state: 'unchanged' | 'stopped-transition' = 'unchanged',
): Promise<DockerContainerInspect> {
  const dockerId = requireDockerId(resource.dockerId, 'Project egress proxy');
  const inspect = await strictInspectOne<DockerContainerInspect>(executor, 'container', dockerId);
  if (!inspect) fail('PROXY_REMOVAL_RACE', 'Project egress proxy disappeared before removal');
  if (requireDockerId(inspect.Id, 'Project egress proxy') !== dockerId
    || requireDockerName(inspect.Name, 'Project egress proxy') !== resource.name) {
    fail('PROXY_REMOVAL_IDENTITY', 'Project egress proxy identity changed before removal');
  }
  const managed = managedIdentityFromLabels(inspect.Config?.Labels, resource.projectId, 'proxy');
  if (managed.scope.identityFingerprint !== resource.identityFingerprint
    || managed.policyFingerprint !== resource.policyFingerprint) {
    fail('PROXY_REMOVAL_LABELS', 'Project egress proxy labels changed before removal');
  }
  const snapshot = proxyDiscoverySnapshot(inspect);
  const unchanged = dockerResourceSnapshot(snapshot) === resource.snapshotFingerprint;
  const stoppedTransition = state === 'stopped-transition'
    && inspect.State?.Running === false
    && (
      dockerResourceSnapshot({ ...snapshot, running: true }) === resource.snapshotFingerprint
      || (
        proxyRuntimeEndpointsAreEmpty(inspect)
        && resource.transitionInvariantFingerprint !== null
        && dockerResourceSnapshot(proxyStoppedTransitionInvariant(inspect))
          === resource.transitionInvariantFingerprint
      )
    );
  if (!unchanged && !stoppedTransition) {
    fail('PROXY_REMOVAL_RACE', 'Project egress proxy state changed before removal');
  }
  return inspect;
}

async function reattestNetworkBeforeRemoval(
  executor: ProjectEgressCommandExecutor,
  resource: ProjectEgressDiscoveredResource,
  role: 'internal' | 'proxy-public',
): Promise<DockerNetworkInspect> {
  const dockerId = requireDockerId(resource.dockerId, 'Project egress network');
  const inspect = await strictInspectOne<DockerNetworkInspect>(executor, 'network', dockerId);
  if (!inspect) fail('NETWORK_REMOVAL_RACE', 'Project egress network disappeared before removal');
  if (requireDockerId(inspect.Id, 'Project egress network') !== dockerId
    || requireDockerName(inspect.Name, 'Project egress network') !== resource.name) {
    fail('NETWORK_REMOVAL_IDENTITY', 'Project egress network identity changed before removal');
  }
  const managed = managedIdentityFromLabels(inspect.Labels, resource.projectId, role);
  if (managed.scope.identityFingerprint !== resource.identityFingerprint
    || managed.policyFingerprint !== resource.policyFingerprint) {
    fail('NETWORK_REMOVAL_LABELS', 'Project egress network labels changed before removal');
  }
  if (namesInNetwork(inspect).length > 0) {
    fail('NETWORK_REMOVAL_MEMBERS', 'Project egress network still has attached containers');
  }
  return inspect;
}

async function removeFirewallResource(
  executor: ProjectEgressCommandExecutor,
  resource: ProjectEgressDiscoveredResource,
): Promise<void> {
  if (resource.kind !== 'FIREWALL_CHAIN' || !resource.family || !resource.firewallComment) {
    fail('FIREWALL_REMOVAL_RESOURCE', 'Project firewall cleanup received an invalid resource');
  }
  const tool = resource.family === 4 ? 'iptables' : 'ip6tables';
  for (const source of resource.sourceCidrs) {
    await executor.run(tool, [
      '-w', '-D', MASTER_FIREWALL_CHAIN, '-s', source,
      '-m', 'comment', '--comment', resource.firewallComment, '-j', resource.name,
    ]);
  }
  if (resource.chainDeclared) {
    await executor.run(tool, ['-w', '-F', resource.name]);
    await executor.run(tool, ['-w', '-X', resource.name]);
  }
  // Host-input protection rules carry this identity's comment too; leaving
  // them behind both fails removal verification and accumulates dead rules
  // for every retired plane.
  const hostChain = await executor.run(tool, ['-w', '-S', HOST_FIREWALL_CHAIN], { allowExitCodes: [0, 1] });
  for (const raw of hostChain.stdout.split(/\r?\n/)) {
    const line = normalizeFirewallLine(raw);
    if (!line.startsWith(`-A ${HOST_FIREWALL_CHAIN} `) || !line.includes(`--comment ${resource.firewallComment} `)) continue;
    const subnet = line.match(new RegExp(`^-A ${HOST_FIREWALL_CHAIN} -s ([^ ]+) `))?.[1];
    if (!subnet) continue;
    const establishedReply = line.includes('-m conntrack --ctstate RELATED,ESTABLISHED ')
      && line.endsWith('-j ACCEPT');
    await executor.run(tool, establishedReply
      ? [
          '-w', '-D', HOST_FIREWALL_CHAIN, '-s', subnet,
          '-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED',
          '-m', 'comment', '--comment', resource.firewallComment, '-j', 'ACCEPT',
        ]
      : [
          '-w', '-D', HOST_FIREWALL_CHAIN, '-s', subnet,
          '-m', 'comment', '--comment', resource.firewallComment, '-j', 'REJECT',
        ], { allowExitCodes: [0, 1] });
  }
}

/**
 * Remove every egress plane owned by one immutable ProjectIdentity. The caller
 * must first stop new Project turns and remove provider runtimes. Discovery is
 * repeated before mutation and after each ownership boundary; any drift aborts
 * cleanup without deleting an unverified resource.
 */
export async function teardownProjectEgressPlaneResources(
  projectIdInput: string,
  options: ProjectEgressDiscoveryOptions = {},
  executor: ProjectEgressCommandExecutor = projectEgressCommandExecutor,
): Promise<ProjectEgressTeardownResult> {
  const projectId = requireOpaqueId(projectIdInput, 'projectId');
  const strictOptions = {
    ...options,
    requireNoRuntimeMembers: true,
    allowExitedDetachedProxyDebris: true,
  };
  const initial = await discoverProjectEgressPlaneResources(projectId, strictOptions, executor);
  const secondAttestation = await discoverProjectEgressPlaneResources(projectId, strictOptions, executor);
  compareResourceSnapshots(initial, secondAttestation);

  for (const proxy of resourcesOfKind(secondAttestation, 'PROXY_CONTAINER')) {
    const proxyId = requireDockerId(proxy.dockerId, 'Project egress proxy');
    await reattestProxyBeforeRemoval(executor, proxy);
    await executor.run('docker', ['container', 'stop', '--time', '10', proxyId]);
    await reattestProxyBeforeRemoval(executor, proxy, 'stopped-transition');
    await executor.run('docker', ['container', 'rm', proxyId]);
    if (await strictInspectOne<DockerContainerInspect>(executor, 'container', proxyId)) {
      fail('PROXY_REMOVAL_VERIFY', 'Project egress proxy still exists after removal');
    }
  }

  const afterProxy = await discoverProjectEgressPlaneResources(projectId, strictOptions, executor);
  if (resourcesOfKind(afterProxy, 'PROXY_CONTAINER').length > 0) {
    fail('PROXY_REMOVAL_VERIFY', 'Project egress proxy reappeared during cleanup');
  }
  const initialFirewall = resourcesOfKind(secondAttestation, 'FIREWALL_CHAIN');
  const currentFirewall = resourcesOfKind(afterProxy, 'FIREWALL_CHAIN');
  compareResourceSnapshots(initialFirewall, currentFirewall);
  for (const firewall of currentFirewall) await removeFirewallResource(executor, firewall);

  const afterFirewall = await discoverProjectEgressPlaneResources(projectId, strictOptions, executor);
  if (resourcesOfKind(afterFirewall, 'FIREWALL_CHAIN').length > 0) {
    fail('FIREWALL_REMOVAL_VERIFY', 'Project egress firewall state still exists after removal');
  }
  for (const network of [
    ...resourcesOfKind(afterFirewall, 'INTERNAL_NETWORK'),
    ...resourcesOfKind(afterFirewall, 'PUBLIC_NETWORK'),
  ]) {
    const role = network.kind === 'INTERNAL_NETWORK' ? 'internal' : 'proxy-public';
    const networkId = requireDockerId(network.dockerId, 'Project egress network');
    await reattestNetworkBeforeRemoval(executor, network, role);
    await executor.run('docker', ['network', 'rm', networkId]);
    if (await strictInspectOne<DockerNetworkInspect>(executor, 'network', networkId)) {
      fail('NETWORK_REMOVAL_VERIFY', 'Project egress network still exists after removal');
    }
  }

  const final = await discoverProjectEgressPlaneResources(projectId, strictOptions, executor);
  if (final.length > 0) {
    fail('CLEANUP_RESIDUAL', 'Project egress cleanup left managed resources behind');
  }
  return {
    projectId,
    discoveredResourceCount: initial.length,
    removedResourceCount: initial.length,
    alreadyAbsent: initial.length === 0,
  };
}

/**
 * Remove exactly one actor/project/consumer plane without touching provider
 * planes or concurrent Portal workloads for the same project. This is the
 * normal completion path for one-shot Git/lifecycle jobs and the stop path for
 * a durable hosted app. Project-wide deletion continues to use
 * teardownProjectEgressPlaneResources after every runtime has been quiesced.
 */
export async function teardownExactProjectEgressPlane(
  identityInput: ProjectEgressIdentity,
  executor: ProjectEgressCommandExecutor = projectEgressCommandExecutor,
): Promise<ProjectEgressTeardownResult> {
  const scope = buildProjectEgressIdentityScope(identityInput);
  const options: ProjectEgressDiscoveryOptions = {
    expectedIdentities: [scope.identity],
    allowExitedDetachedProxyDebris: true,
  };
  const target = (resources: readonly ProjectEgressDiscoveredResource[]) => resources
    .filter((resource) => resource.identityFingerprint === scope.identityFingerprint);

  const initial = target(await discoverProjectEgressPlaneResources(scope.identity.projectId, options, executor));
  const second = target(await discoverProjectEgressPlaneResources(scope.identity.projectId, options, executor));
  compareResourceSnapshots(initial, second);
  if (initial.length === 0) {
    return {
      projectId: scope.identity.projectId,
      discoveredResourceCount: 0,
      removedResourceCount: 0,
      alreadyAbsent: true,
    };
  }

  const internal = await strictInspectOne<DockerNetworkInspect>(executor, 'network', scope.internalNetworkName);
  if (internal) {
    const members = namesInNetwork(internal);
    if (members.some((name) => name !== scope.proxyContainerName)) {
      fail('EXACT_RUNTIME_STILL_ATTACHED', 'The Portal workload runtime is still attached to its egress plane');
    }
  }

  for (const proxy of resourcesOfKind(second, 'PROXY_CONTAINER')) {
    const proxyId = requireDockerId(proxy.dockerId, 'Project egress proxy');
    await reattestProxyBeforeRemoval(executor, proxy);
    await executor.run('docker', ['container', 'stop', '--time', '10', proxyId], { allowExitCodes: [0, 1] });
    await reattestProxyBeforeRemoval(executor, proxy, 'stopped-transition');
    await executor.run('docker', ['container', 'rm', proxyId]);
    if (await strictInspectOne<DockerContainerInspect>(executor, 'container', proxyId)) {
      fail('EXACT_PROXY_REMOVAL_VERIFY', 'The Portal workload egress proxy still exists after removal');
    }
  }

  const afterProxy = target(await discoverProjectEgressPlaneResources(scope.identity.projectId, options, executor));
  const initialFirewall = resourcesOfKind(second, 'FIREWALL_CHAIN');
  const currentFirewall = resourcesOfKind(afterProxy, 'FIREWALL_CHAIN');
  compareResourceSnapshots(initialFirewall, currentFirewall);
  for (const firewall of currentFirewall) await removeFirewallResource(executor, firewall);

  const afterFirewall = target(await discoverProjectEgressPlaneResources(scope.identity.projectId, options, executor));
  if (resourcesOfKind(afterFirewall, 'FIREWALL_CHAIN').length > 0) {
    fail('EXACT_FIREWALL_REMOVAL_VERIFY', 'The Portal workload firewall state still exists after removal');
  }
  for (const network of [
    ...resourcesOfKind(afterFirewall, 'INTERNAL_NETWORK'),
    ...resourcesOfKind(afterFirewall, 'PUBLIC_NETWORK'),
  ]) {
    const role = network.kind === 'INTERNAL_NETWORK' ? 'internal' : 'proxy-public';
    const networkId = requireDockerId(network.dockerId, 'Project egress network');
    await reattestNetworkBeforeRemoval(executor, network, role);
    await executor.run('docker', ['network', 'rm', networkId]);
    if (await strictInspectOne<DockerNetworkInspect>(executor, 'network', networkId)) {
      fail('EXACT_NETWORK_REMOVAL_VERIFY', 'The Portal workload egress network still exists after removal');
    }
  }

  const final = target(await discoverProjectEgressPlaneResources(scope.identity.projectId, options, executor));
  if (final.length > 0) fail('EXACT_CLEANUP_RESIDUAL', 'The Portal workload egress cleanup left managed resources behind');
  return {
    projectId: scope.identity.projectId,
    discoveredResourceCount: initial.length,
    removedResourceCount: initial.length,
    alreadyAbsent: false,
  };
}

function labelArgs(labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}

function proxyEnvironmentValues(inspect: DockerContainerInspect): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const entry of inspect.Config?.Env || []) {
    const separator = entry.indexOf('=');
    if (separator < 1) fail('STALE_PROXY_ENVIRONMENT', 'Managed Project egress proxy environment is malformed');
    const key = entry.slice(0, separator);
    const bucket = values.get(key) || [];
    bucket.push(entry.slice(separator + 1));
    values.set(key, bucket);
  }
  return values;
}

function attestExactProxyEnvironmentShape(values: Map<string, string[]>): void {
  const expectedKeys = new Set([
    ...Object.keys(PROXY_BASE_ENVIRONMENT),
    'PROJECT_EGRESS_PROXY_TOKEN',
    'PROJECT_EGRESS_PROXY_PORT',
    'PROJECT_EGRESS_DENY_CIDRS',
  ]);
  if (values.size !== expectedKeys.size
    || [...values.keys()].some((key) => !expectedKeys.has(key))
    || [...values.values()].some((entries) => entries.length !== 1)
    || Object.entries(PROXY_BASE_ENVIRONMENT).some(([key, value]) => values.get(key)?.[0] !== value)) {
    fail('STALE_PROXY_ENVIRONMENT', 'Managed Project egress proxy environment contract did not match');
  }
}

async function listExactIdentityProxyIds(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
): Promise<string[]> {
  const labels: Record<string, string> = {
    [LABEL_ACTOR_ID]: spec.identity.actorId,
    [LABEL_PROJECT_ID]: spec.identity.projectId,
    [LABEL_PROVIDER]: spec.identity.provider,
    ...(spec.identity.consumerKind ? { [LABEL_CONSUMER_KIND]: spec.identity.consumerKind } : {}),
    ...(spec.identity.workloadId ? { [LABEL_WORKLOAD_ID]: spec.identity.workloadId } : {}),
  };
  const immutableLabelKeys = [
    LABEL_ACTOR_ID,
    LABEL_PROJECT_ID,
    LABEL_PROVIDER,
    LABEL_CONSUMER_KIND,
    LABEL_WORKLOAD_ID,
  ];
  const filters = immutableLabelKeys
    .filter((key) => labels[key])
    .flatMap((key) => ['--filter', `label=${key}=${labels[key]}`]);
  const result = await executor.run('docker', [
    'container', 'ls', '--all', '--no-trunc',
    ...filters,
    '--format', '{{.ID}}',
  ]);
  const ids = result.stdout.split(/\r?\n/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (ids.length > 8
    || new Set(ids).size !== ids.length
    || ids.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    fail('PROXY_IDENTITY_INVENTORY', 'Docker returned an invalid Project egress proxy identity inventory');
  }
  return ids;
}

async function listExactIdentityNetworkIds(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
): Promise<string[]> {
  const labels: Record<string, string> = {
    [LABEL_ACTOR_ID]: spec.identity.actorId,
    [LABEL_PROJECT_ID]: spec.identity.projectId,
    [LABEL_PROVIDER]: spec.identity.provider,
    ...(spec.identity.consumerKind ? { [LABEL_CONSUMER_KIND]: spec.identity.consumerKind } : {}),
    ...(spec.identity.workloadId ? { [LABEL_WORKLOAD_ID]: spec.identity.workloadId } : {}),
  };
  const immutableLabelKeys = [
    LABEL_ACTOR_ID,
    LABEL_PROJECT_ID,
    LABEL_PROVIDER,
    LABEL_CONSUMER_KIND,
    LABEL_WORKLOAD_ID,
  ];
  const filters = immutableLabelKeys
    .filter((key) => labels[key])
    .flatMap((key) => ['--filter', `label=${key}=${labels[key]}`]);
  const result = await executor.run('docker', [
    'network', 'ls', '--no-trunc',
    ...filters,
    '--format', '{{.ID}}',
  ]);
  const ids = result.stdout.split(/\r?\n/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (ids.length > 8
    || new Set(ids).size !== ids.length
    || ids.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    fail('NETWORK_IDENTITY_INVENTORY', 'Docker returned an invalid Project egress network identity inventory');
  }
  return ids;
}

interface ProjectEgressNetworkIdentityInventory {
  ids: string[];
  internal: DockerNetworkInspect | null;
  publicNetwork: DockerNetworkInspect | null;
}

async function inspectProjectEgressNetworkIdentityInventory(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
): Promise<ProjectEgressNetworkIdentityInventory> {
  const ids = await listExactIdentityNetworkIds(executor, spec);
  if (ids.length > 2) {
    fail('NETWORK_IDENTITY_INVENTORY', 'Too many networks claim one Project egress plane identity');
  }
  let internal: DockerNetworkInspect | null = null;
  let publicNetwork: DockerNetworkInspect | null = null;
  const expectedRawLabels: Record<string, string> = {
    [LABEL_ACTOR_ID]: spec.identity.actorId,
    [LABEL_PROJECT_ID]: spec.identity.projectId,
    [LABEL_PROVIDER]: spec.identity.provider,
    ...(spec.identity.consumerKind ? { [LABEL_CONSUMER_KIND]: spec.identity.consumerKind } : {}),
    ...(spec.identity.workloadId ? { [LABEL_WORKLOAD_ID]: spec.identity.workloadId } : {}),
  };
  for (const id of ids) {
    const inspect = await strictInspectOne<DockerNetworkInspect>(executor, 'network', id);
    if (!inspect) {
      fail('NETWORK_IDENTITY_INVENTORY', 'A listed Project egress network disappeared during attestation');
    }
    if (requireImmutableDockerId(inspect.Id, 'Project egress network') !== id) {
      fail('NETWORK_IDENTITY_INVENTORY', 'A listed Project egress network resolved to another immutable id');
    }
    assertExactLabels(
      inspect.Labels,
      expectedRawLabels,
      'NETWORK_IDENTITY_INVENTORY',
    );
    const role = inspect.Labels?.[LABEL_ROLE];
    if (role !== 'internal' && role !== 'proxy-public') {
      fail('NETWORK_IDENTITY_INVENTORY', 'A Project egress network identity claimant has an invalid role');
    }
    const expectedName = role === 'internal' ? spec.internalNetworkName : spec.publicNetworkName;
    if (requireDockerName(inspect.Name, 'Project egress network') !== expectedName) {
      fail('NETWORK_IDENTITY_INVENTORY', 'A Project egress network identity claimant has an unexpected name');
    }
    if (role === 'internal') {
      if (internal) fail('NETWORK_IDENTITY_INVENTORY', 'Multiple internal networks claim one Project egress identity');
      internal = inspect;
    } else {
      if (publicNetwork) fail('NETWORK_IDENTITY_INVENTORY', 'Multiple public networks claim one Project egress identity');
      publicNetwork = inspect;
    }
  }
  return { ids, internal, publicNetwork };
}

/**
 * Resolve the immutable internal-network ID only when the discovered plane is
 * an exact current or LEGACY_PRE_CONFINEMENT generation. The returned generation lets
 * provider retirement enforce the predecessor's historical name-bound
 * NetworkMode without trusting a candidate container's arbitrary ID.
 */
export interface ProjectEgressInternalNetworkBinding {
  networkId: string;
  generation: 'CURRENT' | 'LEGACY_PRE_CONFINEMENT';
}

export async function resolveRecognizedProjectEgressInternalNetworkBinding(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
): Promise<ProjectEgressInternalNetworkBinding | null> {
  const namedInternal = await strictInspectOne<DockerNetworkInspect>(
    executor,
    'network',
    spec.internalNetworkName,
  );
  const namedPublic = await strictInspectOne<DockerNetworkInspect>(
    executor,
    'network',
    spec.publicNetworkName,
  );
  const inventory = await inspectProjectEgressNetworkIdentityInventory(executor, spec);
  if (inventory.ids.length === 0) {
    if (namedInternal || namedPublic) {
      fail('NETWORK_IDENTITY_INVENTORY', 'A deterministic Project egress network escaped identity inventory');
    }
    return null;
  }
  const internalId = inventory.internal
    ? requireImmutableDockerId(inventory.internal.Id, 'Project egress internal network')
    : null;
  const publicId = inventory.publicNetwork
    ? requireImmutableDockerId(inventory.publicNetwork.Id, 'Project egress public network')
    : null;
  if (Boolean(namedInternal) !== Boolean(internalId)
    || Boolean(namedPublic) !== Boolean(publicId)
    || (namedInternal
      && requireImmutableDockerId(namedInternal.Id, 'Project egress internal network') !== internalId)
    || (namedPublic
      && requireImmutableDockerId(namedPublic.Id, 'Project egress public network') !== publicId)) {
    fail('NETWORK_IDENTITY_INVENTORY', 'Project egress network names and identity inventory disagree');
  }
  const predecessorSpec: ProjectEgressPlaneSpec = {
    ...spec,
    policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(spec),
  };
  const networkEntries: Array<{
    role: 'internal' | 'proxy-public';
    network: DockerNetworkInspect;
  }> = [
    ...(inventory.internal ? [{ role: 'internal' as const, network: inventory.internal }] : []),
    ...(inventory.publicNetwork
      ? [{ role: 'proxy-public' as const, network: inventory.publicNetwork }]
      : []),
  ];
  const generations = networkEntries.map(({ role, network }) => {
    if (network.Labels?.[LABEL_FINGERPRINT] === spec.policyFingerprint) {
      attestExactCurrentProjectEgressNetwork(spec, network, role);
      return 'CURRENT';
    }
    const managed = managedIdentityFromLabels(
      network.Labels,
      predecessorSpec.identity.projectId,
      role,
    );
    const expectedName = role === 'internal'
      ? predecessorSpec.internalNetworkName
      : predecessorSpec.publicNetworkName;
    if (managed.scope.identityFingerprint !== predecessorSpec.identityFingerprint
      || managed.policyFingerprint !== predecessorSpec.policyFingerprint
      || requireDockerName(network.Name, 'Pre-confinement Project egress network') !== expectedName
      || network.Driver !== 'bridge'
      || network.Internal !== (role === 'internal')) {
      fail('STALE_NETWORK_IDENTITY', 'Project egress network is not an exact recognized generation');
    }
    return 'LEGACY_PRE_CONFINEMENT';
  });
  if (new Set(generations).size !== 1) {
    fail('STALE_PLANE_GENERATION', 'Project egress networks span current and predecessor generations');
  }
  if (!internalId) return null;
  return {
    networkId: internalId,
    generation: generations[0] as 'CURRENT' | 'LEGACY_PRE_CONFINEMENT',
  };
}

export async function resolveCurrentProjectEgressInternalNetworkId(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
): Promise<string | null> {
  const binding = await resolveRecognizedProjectEgressInternalNetworkBinding(executor, spec);
  return binding?.generation === 'CURRENT' ? binding.networkId : null;
}

function requireSingleProxyEnvironment(
  values: Map<string, string[]>,
  key: string,
): string {
  const entries = values.get(key);
  if (!entries || entries.length !== 1) {
    fail('STALE_PROXY_ENVIRONMENT', 'Managed Project egress proxy security environment is ambiguous');
  }
  return entries[0];
}

function attestManagedProxyForRetirement(input: {
  spec: ProjectEgressPlaneSpec;
  inspect: DockerContainerInspect;
  expectedContainerId: string;
  expectedPolicyFingerprint: string;
  requireRunning: boolean;
  confinementGeneration: 'CURRENT' | 'LEGACY_PRE_CONFINEMENT';
  expectedPublicNetworkId?: string;
  expectedInternalNetworkId?: string;
  expectedPublicIpv4?: string;
}): void {
  const { spec, inspect } = input;
  if (requireImmutableDockerId(inspect.Id, 'Managed Project egress proxy') !== input.expectedContainerId
    || requireDockerName(inspect.Name, 'Managed Project egress proxy') !== spec.proxyContainerName) {
    fail('STALE_PROXY_IDENTITY', 'Managed Project egress proxy immutable identity changed');
  }
  const managed = managedIdentityFromLabels(inspect.Config?.Labels, spec.identity.projectId, 'proxy');
  if (managed.scope.identityFingerprint !== spec.identityFingerprint
    || managed.policyFingerprint !== input.expectedPolicyFingerprint
    || input.expectedPolicyFingerprint !== spec.policyFingerprint) {
    fail('STALE_PROXY_LABELS', 'Managed Project egress proxy ownership labels did not match');
  }
  const tokenHash = String(inspect.Config?.Labels?.[LABEL_TOKEN_HASH] || '');
  if (!/^[a-f0-9]{64}$/i.test(tokenHash)) {
    fail('STALE_PROXY_TOKEN', 'Managed Project egress proxy token hash label is invalid');
  }
  const expectedImageId = `sha256:${spec.proxyImage.split('sha256:').at(-1) || ''}`.toLowerCase();
  if (String(inspect.Config?.Image || '') !== spec.proxyImage
    || String(inspect.Image || '').toLowerCase() !== expectedImageId
    || JSON.stringify(inspect.Config?.Cmd || []) !== JSON.stringify(spec.proxyCommand)
    || (inspect.Config?.Entrypoint?.length || 0) !== 0
    || inspect.Config?.WorkingDir !== '/opt/bridgesllm/backend'
    || inspect.Config?.User !== '65532:65532') {
    fail('STALE_PROXY_PROCESS', 'Managed Project egress proxy process identity is invalid');
  }
  const environment = proxyEnvironmentValues(inspect);
  attestExactProxyEnvironmentShape(environment);
  const token = requireSingleProxyEnvironment(environment, 'PROJECT_EGRESS_PROXY_TOKEN');
  const port = requireSingleProxyEnvironment(environment, 'PROJECT_EGRESS_PROXY_PORT');
  const denied = requireSingleProxyEnvironment(environment, 'PROJECT_EGRESS_DENY_CIDRS');
  let deniedCidrs: unknown;
  try {
    deniedCidrs = JSON.parse(denied);
  } catch {
    fail('STALE_PROXY_ENVIRONMENT', 'Managed Project egress proxy denied-CIDR environment is invalid');
  }
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(token)
    || stableHash(token) !== tokenHash
    || port !== String(spec.proxyPort)
    || !Array.isArray(deniedCidrs)
    || JSON.stringify(deniedCidrs) !== JSON.stringify(spec.deniedCidrs)) {
    fail('STALE_PROXY_ENVIRONMENT', 'Managed Project egress proxy security environment is invalid');
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
    fail('STALE_PROXY_CONFINEMENT', 'Managed Project egress proxy confinement generation did not match');
  }
  if (inspect.State?.Running !== input.requireRunning) {
    fail('STALE_PROXY_STATE', 'Managed Project egress proxy state did not match');
  }
  attestExactProxyHostHardening(
    inspect,
    'STALE_PROXY_HARDENING',
    'Managed Project egress proxy hardening did not match',
  );
  const networks = inspect.NetworkSettings?.Networks || {};
  const names = Object.keys(networks).sort();
  const expectedNames = [spec.internalNetworkName, spec.publicNetworkName].sort();
  const publicAttachment = networks[spec.publicNetworkName];
  const staticPublicIpv4 = String(publicAttachment?.IPAMConfig?.IPv4Address || '');
  if (!net.isIPv4(staticPublicIpv4)
    || (input.expectedPublicIpv4 && staticPublicIpv4 !== input.expectedPublicIpv4)
    || (input.requireRunning && publicAttachment?.IPAddress !== staticPublicIpv4)) {
    fail('STALE_PROXY_STATIC_ADDRESS', 'Managed Project egress proxy static public address did not match');
  }
  const networkMode = String(host.NetworkMode || '').toLowerCase();
  const networkModeMatches = input.expectedPublicNetworkId
    ? networkMode === input.expectedPublicNetworkId
      || (networkMode === spec.publicNetworkName
        && String(publicAttachment?.NetworkID || '').toLowerCase() === input.expectedPublicNetworkId)
    : networkMode === spec.publicNetworkName
      || (/^[a-f0-9]{64}$/i.test(networkMode)
        && String(publicAttachment?.NetworkID || '').toLowerCase() === networkMode);
  const internalNetworkId = String(networks[spec.internalNetworkName]?.NetworkID || '').toLowerCase();
  const publicNetworkId = String(publicAttachment?.NetworkID || '').toLowerCase();
  if (!networkModeMatches
    || (input.expectedPublicNetworkId
      && publicNetworkId !== input.expectedPublicNetworkId
      && !(networkMode === input.expectedPublicNetworkId
        && !input.requireRunning
        && publicNetworkId === ''))
    || (input.expectedInternalNetworkId
      && internalNetworkId !== input.expectedInternalNetworkId
      && !(networkMode === input.expectedPublicNetworkId
        && !input.requireRunning
        && internalNetworkId === ''))
    || JSON.stringify(names) !== JSON.stringify(expectedNames)
    || !networks[spec.internalNetworkName]?.Aliases?.includes(spec.proxyAlias)) {
    fail('STALE_PROXY_NETWORK', 'Managed Project egress proxy network identity did not match');
  }
}

async function retireManagedProxyByImmutableId(input: {
  executor: ProjectEgressCommandExecutor;
  spec: ProjectEgressPlaneSpec;
  inspect: DockerContainerInspect;
  expectedContainerId: string;
  expectedPolicyFingerprint: string;
  confinementGeneration: 'CURRENT' | 'LEGACY_PRE_CONFINEMENT';
  expectedPublicNetworkId?: string;
  expectedInternalNetworkId?: string;
  expectedPublicIpv4?: string;
}): Promise<void> {
  const inventory = await listExactIdentityProxyIds(input.executor, input.spec);
  const named = await strictInspectOne<DockerContainerInspect>(
    input.executor,
    'container',
    input.spec.proxyContainerName,
  );
  if (inventory.length !== 1
    || inventory[0] !== input.expectedContainerId
    || !named
    || requireImmutableDockerId(named.Id, 'Managed Project egress proxy') !== input.expectedContainerId) {
    fail('STALE_PROXY_INVENTORY_RACE', 'Managed Project egress proxy identity changed before retirement');
  }
  const reattested = await strictInspectOne<DockerContainerInspect>(
    input.executor,
    'container',
    input.expectedContainerId,
  );
  if (!reattested) fail('STALE_PROXY_RACE', 'Managed Project egress proxy disappeared before exact retirement');
  attestManagedProxyForRetirement({
    ...input,
    inspect: reattested,
    requireRunning: reattested.State?.Running === true,
  });
  if (reattested.State?.Running === true) {
    await input.executor.run('docker', ['container', 'stop', '--time', '1', input.expectedContainerId]);
  }
  const stopped = await strictInspectOne<DockerContainerInspect>(
    input.executor,
    'container',
    input.expectedContainerId,
  );
  if (!stopped) fail('STALE_PROXY_RACE', 'Managed Project egress proxy disappeared before exact retirement');
  attestManagedProxyForRetirement({
    ...input,
    inspect: stopped,
    requireRunning: false,
  });
  await input.executor.run('docker', ['container', 'rm', input.expectedContainerId]);
  if (await strictInspectOne<DockerContainerInspect>(input.executor, 'container', input.expectedContainerId)) {
    fail('STALE_PROXY_REMOVE', 'Managed Project egress proxy still exists after exact removal');
  }
}

interface StaleNetworkRetirementPlan {
  predecessorSpec: ProjectEgressPlaneSpec;
  networkId: string;
  networkName: string;
  role: 'internal' | 'proxy-public';
  members: Array<{ containerId: string; inspect: DockerContainerInspect }>;
  expectedProxyPublicIpv4?: string;
}

async function preflightStaleNetworkRetirement(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
  network: DockerNetworkInspect,
  expectedProxyPublicIpv4Input?: string,
): Promise<StaleNetworkRetirementPlan> {
  const predecessorSpec: ProjectEgressPlaneSpec = {
    ...spec,
    policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(spec),
  };
  const role = network.Labels?.[LABEL_ROLE];
  if (role !== 'internal' && role !== 'proxy-public') {
    fail('STALE_NETWORK_ROLE', 'Managed stale Project egress network role is invalid');
  }
  const networkId = requireImmutableDockerId(network.Id, 'Managed stale Project egress network');
  const networkName = requireDockerName(network.Name, 'Managed stale Project egress network');
  const expectedName = role === 'internal'
    ? predecessorSpec.internalNetworkName
    : predecessorSpec.publicNetworkName;
  const managed = managedIdentityFromLabels(network.Labels, predecessorSpec.identity.projectId, role);
  if (managed.scope.identityFingerprint !== predecessorSpec.identityFingerprint
    || managed.policyFingerprint !== predecessorSpec.policyFingerprint
    || networkName !== expectedName
    || network.Driver !== 'bridge'
    || network.Internal !== (role === 'internal')) {
    fail('STALE_NETWORK_IDENTITY', 'Managed stale Project egress network identity did not match');
  }

  const members: Array<{ containerId: string; inspect: DockerContainerInspect }> = [];
  let expectedProxyPublicIpv4 = expectedProxyPublicIpv4Input;
  for (const [memberIdInput, member] of Object.entries(network.Containers || {})) {
    const memberId = requireImmutableDockerId(memberIdInput, 'Managed stale Project egress member');
    const memberName = requireDockerName(member?.Name, 'Managed stale Project egress member');
    // Provider runtimes carry provider-specific mount and process contracts.
    // They must be retired by that provider before shared network mutation.
    if (memberName !== predecessorSpec.proxyContainerName) {
      fail('STALE_NETWORK_RUNTIME_ATTACHED', 'A Project runtime must be exactly retired before stale network replacement');
    }
    const inspect = await strictInspectOne<DockerContainerInspect>(executor, 'container', memberId);
    if (!inspect) fail('STALE_PROXY_RACE', 'Managed stale Project egress proxy disappeared before attestation');
    expectedProxyPublicIpv4 ||= String(
      inspect.NetworkSettings?.Networks?.[predecessorSpec.publicNetworkName]?.IPAMConfig?.IPv4Address || '',
    );
    attestManagedProxyForRetirement({
      spec: predecessorSpec,
      inspect,
      expectedContainerId: memberId,
      expectedPolicyFingerprint: predecessorSpec.policyFingerprint,
      requireRunning: inspect.State?.Running === true,
      confinementGeneration: 'LEGACY_PRE_CONFINEMENT',
      expectedPublicIpv4: expectedProxyPublicIpv4,
    });
    members.push({ containerId: memberId, inspect });
  }
  return {
    predecessorSpec,
    networkId,
    networkName,
    role,
    members,
    expectedProxyPublicIpv4,
  };
}

async function retirePreflightedStalePlane(input: {
  executor: ProjectEgressCommandExecutor;
  spec: ProjectEgressPlaneSpec;
  plans: readonly StaleNetworkRetirementPlan[];
  inventoryMembers: readonly { containerId: string; inspect: DockerContainerInspect }[];
  expectedNetworkIds?: readonly string[];
  expectedProxyIds?: readonly string[];
}): Promise<void> {
  const { executor, spec, plans } = input;
  const predecessorSpec: ProjectEgressPlaneSpec = {
    ...spec,
    policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(spec),
  };
  const expectedProxyPublicIpv4 = plans
    .map((plan) => plan.expectedProxyPublicIpv4)
    .find(Boolean);
  const expectedInternalNetworkId = plans.find((plan) => plan.role === 'internal')?.networkId;
  const expectedPublicNetworkId = plans.find((plan) => plan.role === 'proxy-public')?.networkId;
  const members = new Map<string, DockerContainerInspect>();
  for (const member of [
    ...plans.flatMap((plan) => plan.members),
    ...input.inventoryMembers,
  ]) {
    members.set(member.containerId, member.inspect);
  }
  const expectedProxyIds = [...(input.expectedProxyIds || members.keys())].sort();
  const expectedNetworkIds = [...(input.expectedNetworkIds || plans.map((plan) => plan.networkId))].sort();
  const proxyBarrier = await listExactIdentityProxyIds(executor, spec);
  const networkBarrier = await inspectProjectEgressNetworkIdentityInventory(executor, spec);
  const namedProxyBarrier = await strictInspectOne<DockerContainerInspect>(
    executor,
    'container',
    spec.proxyContainerName,
  );
  if (JSON.stringify(proxyBarrier) !== JSON.stringify(expectedProxyIds)
    || JSON.stringify(networkBarrier.ids) !== JSON.stringify(expectedNetworkIds)
    || (expectedProxyIds.length === 0 && namedProxyBarrier)
    || (expectedProxyIds.length === 1
      && (!namedProxyBarrier
        || requireImmutableDockerId(
          namedProxyBarrier.Id,
          'Managed stale Project egress proxy',
        ) !== expectedProxyIds[0]))) {
    fail('STALE_PLANE_INVENTORY_RACE', 'Project egress identity inventory changed before stale retirement');
  }
  for (const [containerId, inspect] of members) {
    await retireManagedProxyByImmutableId({
      executor,
      spec: predecessorSpec,
      inspect,
      expectedContainerId: containerId,
      expectedPolicyFingerprint: predecessorSpec.policyFingerprint,
      confinementGeneration: 'LEGACY_PRE_CONFINEMENT',
      expectedPublicIpv4: expectedProxyPublicIpv4,
      expectedPublicNetworkId,
      expectedInternalNetworkId,
    });
  }
  if ((await listExactIdentityProxyIds(executor, spec)).length !== 0
    || await strictInspectOne<DockerContainerInspect>(
      executor,
      'container',
      spec.proxyContainerName,
    )) {
    fail('STALE_PROXY_RESIDUAL', 'Managed stale Project egress proxy identity remained after exact retirement');
  }

  const reattestedPlans: StaleNetworkRetirementPlan[] = [];
  for (const plan of plans) {
    const reattested = await strictInspectOne<DockerNetworkInspect>(
      executor,
      'network',
      plan.networkId,
    );
    if (!reattested) fail('STALE_NETWORK_RACE', 'Managed stale Project egress network disappeared before retirement');
    const reattestedManaged = managedIdentityFromLabels(
      reattested.Labels,
      predecessorSpec.identity.projectId,
      plan.role,
    );
    if (requireImmutableDockerId(reattested.Id, 'Managed stale Project egress network') !== plan.networkId
      || requireDockerName(reattested.Name, 'Managed stale Project egress network') !== plan.networkName
      || reattestedManaged.scope.identityFingerprint !== predecessorSpec.identityFingerprint
      || reattestedManaged.policyFingerprint !== predecessorSpec.policyFingerprint
      || reattested.Driver !== 'bridge'
      || reattested.Internal !== (plan.role === 'internal')
      || Object.keys(reattested.Containers || {}).length > 0) {
      fail('STALE_NETWORK_REATTEST', 'Managed stale Project egress network changed before retirement');
    }
    reattestedPlans.push(plan);
  }
  const remainingNetworkIds = new Set(expectedNetworkIds);
  for (const plan of reattestedPlans) {
    const currentNetworkInventory = await inspectProjectEgressNetworkIdentityInventory(executor, spec);
    if ((await listExactIdentityProxyIds(executor, spec)).length !== 0
      || await strictInspectOne<DockerContainerInspect>(
        executor,
        'container',
        spec.proxyContainerName,
      )) {
      fail('STALE_PROXY_RESIDUAL', 'A managed Project egress proxy appeared before stale network retirement');
    }
    if (JSON.stringify(currentNetworkInventory.ids) !== JSON.stringify([...remainingNetworkIds].sort())) {
      fail('STALE_PLANE_INVENTORY_RACE', 'Project egress network inventory changed before stale retirement');
    }
    const immediateNetwork = await strictInspectOne<DockerNetworkInspect>(
      executor,
      'network',
      plan.networkId,
    );
    if (!immediateNetwork) {
      fail('STALE_NETWORK_RACE', 'Managed stale Project egress network disappeared before exact removal');
    }
    const immediatePlan = await preflightStaleNetworkRetirement(
      executor,
      spec,
      immediateNetwork,
      expectedProxyPublicIpv4,
    );
    if (immediatePlan.networkId !== plan.networkId
      || immediatePlan.networkName !== plan.networkName
      || immediatePlan.role !== plan.role
      || immediatePlan.members.length !== 0) {
      fail('STALE_NETWORK_REATTEST', 'Managed stale Project egress network changed before exact removal');
    }
    await executor.run('docker', ['network', 'rm', plan.networkId]);
    if (await strictInspectOne<DockerNetworkInspect>(executor, 'network', plan.networkId)) {
      fail('STALE_NETWORK_REMOVE', 'Managed stale Project egress network still exists after exact removal');
    }
    remainingNetworkIds.delete(plan.networkId);
  }
}

async function removeStaleNetwork(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
  network: DockerNetworkInspect,
): Promise<void> {
  const plan = await preflightStaleNetworkRetirement(executor, spec, network);
  await retirePreflightedStalePlane({
    executor,
    spec,
    plans: [plan],
    inventoryMembers: plan.members,
  });
}

function networkFingerprintCurrent(spec: ProjectEgressPlaneSpec, network: DockerNetworkInspect | null): boolean {
  return network?.Labels?.[LABEL_FINGERPRINT] === spec.policyFingerprint;
}

async function ensureNetworks(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
): Promise<void> {
  let internal = await strictInspectOne<DockerNetworkInspect>(executor, 'network', spec.internalNetworkName);
  let existingPublic = await strictInspectOne<DockerNetworkInspect>(executor, 'network', spec.publicNetworkName);
  const initialInventory = await inspectProjectEgressNetworkIdentityInventory(executor, spec);
  for (const [role, network, inventoryNetwork] of [
    ['internal', internal, initialInventory.internal],
    ['proxy-public', existingPublic, initialInventory.publicNetwork],
  ] as const) {
    if (!network && inventoryNetwork) {
      fail('NETWORK_IDENTITY_INVENTORY', `A Project egress ${role} network exists outside its deterministic name`);
    }
    if (network) {
      const networkId = requireImmutableDockerId(network.Id, `Project egress ${role} network`);
      if (!inventoryNetwork
        || requireImmutableDockerId(
          inventoryNetwork.Id,
          `Project egress ${role} inventory network`,
        ) !== networkId) {
        fail('NETWORK_IDENTITY_INVENTORY', `Project egress ${role} name and identity inventory do not match`);
      }
    }
  }
  if (internal && networkFingerprintCurrent(spec, internal)) {
    attestExactCurrentProjectEgressNetwork(spec, internal, 'internal');
  }
  if (existingPublic && networkFingerprintCurrent(spec, existingPublic)) {
    attestExactCurrentProjectEgressNetwork(spec, existingPublic, 'proxy-public');
  }
  const staleNetworks = [internal, existingPublic]
    .filter((network): network is DockerNetworkInspect => Boolean(
      network && !networkFingerprintCurrent(spec, network),
    ));
  if (staleNetworks.length > 0) {
    if ((internal && networkFingerprintCurrent(spec, internal))
      || (existingPublic && networkFingerprintCurrent(spec, existingPublic))) {
      fail('STALE_PLANE_GENERATION', 'Project egress networks span current and predecessor generations');
    }
    // Preflight both named roles and the label-scoped proxy inventory before
    // the first stop/remove. Unknown public state can therefore never cause an
    // exact predecessor internal plane to be partially retired.
    const plans: StaleNetworkRetirementPlan[] = [];
    const expectedProxyPublicIpv4 = existingPublic
      ? deriveStaticProxyIpv4(existingPublic)
      : undefined;
    for (const network of staleNetworks) {
      plans.push(await preflightStaleNetworkRetirement(
        executor,
        spec,
        network,
        expectedProxyPublicIpv4,
      ));
    }
    const proxyIds = await listExactIdentityProxyIds(executor, spec);
    if (proxyIds.length > 1) {
      fail('STALE_PROXY_IDENTITY_INVENTORY', 'Multiple proxies claim one Project egress identity');
    }
    const inventoryMembers: Array<{ containerId: string; inspect: DockerContainerInspect }> = [];
    const predecessorSpec: ProjectEgressPlaneSpec = {
      ...spec,
      policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(spec),
    };
    const namedProxy = await strictInspectOne<DockerContainerInspect>(
      executor,
      'container',
      spec.proxyContainerName,
    );
    if (!namedProxy && proxyIds.length !== 0) {
      fail('STALE_PROXY_IDENTITY_INVENTORY', 'A stale Project egress proxy exists outside its deterministic name');
    }
    if (namedProxy) {
      if (!expectedProxyPublicIpv4) {
        fail('STALE_PROXY_STATIC_ADDRESS', 'Stale proxy cannot be attested without its exact public network');
      }
      const proxyId = requireImmutableDockerId(namedProxy.Id, 'Managed stale Project egress proxy');
      if (proxyIds.length !== 1 || proxyIds[0] !== proxyId) {
        fail('STALE_PROXY_IDENTITY_INVENTORY', 'Stale proxy name and identity inventory do not match');
      }
      attestManagedProxyForRetirement({
        spec: predecessorSpec,
        inspect: namedProxy,
        expectedContainerId: proxyId,
        expectedPolicyFingerprint: predecessorSpec.policyFingerprint,
        requireRunning: namedProxy.State?.Running === true,
        confinementGeneration: 'LEGACY_PRE_CONFINEMENT',
        expectedPublicIpv4: expectedProxyPublicIpv4,
      });
      inventoryMembers.push({ containerId: proxyId, inspect: namedProxy });
    }
    const memberIds = new Set(plans.flatMap((plan) => plan.members.map((member) => member.containerId)));
    if ([...memberIds].some((memberId) => !proxyIds.includes(memberId))) {
      fail('STALE_PROXY_IDENTITY_INVENTORY', 'Stale network proxy membership escaped identity inventory');
    }
    const networkBarrier = await inspectProjectEgressNetworkIdentityInventory(executor, spec);
    const proxyBarrier = await listExactIdentityProxyIds(executor, spec);
    if (JSON.stringify(networkBarrier.ids) !== JSON.stringify(initialInventory.ids)
      || JSON.stringify(proxyBarrier) !== JSON.stringify(proxyIds)) {
      fail('STALE_PLANE_INVENTORY_RACE', 'Project egress identity inventory changed before stale retirement');
    }
    await retirePreflightedStalePlane({
      executor,
      spec,
      plans,
      inventoryMembers,
      expectedNetworkIds: initialInventory.ids,
      expectedProxyIds: proxyIds,
    });
    if (internal) internal = null;
    if (existingPublic) existingPublic = null;
  }
  if (!internal) {
    const createResult = await executor.run('docker', [
      'network', 'create', '--driver', 'bridge', '--internal',
      ...labelArgs({
        ...policyLabels(spec, 'internal'),
      }),
      spec.internalNetworkName,
    ]);
    const createdNetworkId = requireImmutableDockerId(
      createResult.stdout.trim(),
      'Created Project egress internal network',
    );
    internal = await strictInspectOne<DockerNetworkInspect>(executor, 'network', createdNetworkId);
    if (!internal) {
      fail('NETWORK_CREATE', 'Created Project egress internal network disappeared before attestation');
    }
    if (requireImmutableDockerId(internal.Id, 'Created Project egress internal network') !== createdNetworkId
      || requireDockerName(internal.Name, 'Created Project egress internal network') !== spec.internalNetworkName) {
      fail('NETWORK_IDENTITY', 'Created Project egress internal network name changed before attestation');
    }
    attestExactCurrentProjectEgressNetwork(spec, internal, 'internal');
    const createdInventory = await inspectProjectEgressNetworkIdentityInventory(executor, spec);
    if (createdInventory.ids.length !== 1
      || createdInventory.ids[0] !== createdNetworkId
      || requireImmutableDockerId(
        createdInventory.internal?.Id,
        'Created Project egress internal inventory network',
      ) !== createdNetworkId) {
      fail('NETWORK_IDENTITY_INVENTORY', 'Created Project egress internal network identity was ambiguous');
    }
  }
  let publicNetwork = await strictInspectOne<DockerNetworkInspect>(executor, 'network', spec.publicNetworkName);
  if (!publicNetwork) {
    const createResult = await executor.run('docker', [
      'network', 'create', '--driver', 'bridge',
      ...labelArgs({
        ...policyLabels(spec, 'proxy-public'),
      }),
      spec.publicNetworkName,
    ]);
    const createdNetworkId = requireImmutableDockerId(
      createResult.stdout.trim(),
      'Created Project egress public network',
    );
    publicNetwork = await strictInspectOne<DockerNetworkInspect>(executor, 'network', createdNetworkId);
    if (!publicNetwork) {
      fail('NETWORK_CREATE', 'Created Project egress public network disappeared before attestation');
    }
    if (requireImmutableDockerId(publicNetwork.Id, 'Created Project egress public network') !== createdNetworkId
      || requireDockerName(publicNetwork.Name, 'Created Project egress public network') !== spec.publicNetworkName) {
      fail('NETWORK_IDENTITY', 'Created Project egress public network name changed before attestation');
    }
    attestExactCurrentProjectEgressNetwork(spec, publicNetwork, 'proxy-public');
    const createdInventory = await inspectProjectEgressNetworkIdentityInventory(executor, spec);
    if (createdInventory.ids.length !== 2
      || !createdInventory.ids.includes(createdNetworkId)
      || !createdInventory.ids.includes(requireImmutableDockerId(
        internal.Id,
        'Project egress internal network',
      ))
      || requireImmutableDockerId(
        createdInventory.publicNetwork?.Id,
        'Created Project egress public inventory network',
      ) !== createdNetworkId) {
      fail('NETWORK_IDENTITY_INVENTORY', 'Created Project egress public network identity was ambiguous');
    }
  }
  if (!internal || !publicNetwork) fail('NETWORK_CREATE', 'Project egress networks could not be created');
  const finalInventory = await inspectProjectEgressNetworkIdentityInventory(executor, spec);
  if (finalInventory.ids.length !== 2
    || requireImmutableDockerId(finalInventory.internal?.Id, 'Project egress internal network')
      !== requireImmutableDockerId(internal.Id, 'Project egress internal network')
    || requireImmutableDockerId(finalInventory.publicNetwork?.Id, 'Project egress public network')
      !== requireImmutableDockerId(publicNetwork.Id, 'Project egress public network')) {
    fail('NETWORK_IDENTITY_INVENTORY', 'Project egress network convergence did not reach an exact identity inventory');
  }
  attestProjectEgressNetworks(spec, internal, publicNetwork);
}

export interface ExactCurrentProjectEgressNetworks {
  internal: DockerNetworkInspect;
  internalId: string;
  publicNetwork: DockerNetworkInspect;
  publicNetworkId: string;
  proxyPublicIpv4: string;
}

export async function resolveExactCurrentProjectEgressNetworks(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
): Promise<ExactCurrentProjectEgressNetworks> {
  const internal = await strictInspectOne<DockerNetworkInspect>(
    executor,
    'network',
    spec.internalNetworkName,
  ) || fail('INTERNAL_NETWORK_INSPECT', 'Project egress internal network could not be inspected');
  const publicNetwork = await strictInspectOne<DockerNetworkInspect>(
    executor,
    'network',
    spec.publicNetworkName,
  ) || fail('PUBLIC_NETWORK_INSPECT', 'Project egress public network could not be inspected');
  attestProjectEgressNetworks(spec, internal, publicNetwork);
  const internalId = requireImmutableDockerId(internal.Id, 'Project egress internal network');
  const publicNetworkId = requireImmutableDockerId(publicNetwork.Id, 'Project egress public network');
  const inventory = await inspectProjectEgressNetworkIdentityInventory(executor, spec);
  if (inventory.ids.length !== 2
    || requireImmutableDockerId(inventory.internal?.Id, 'Project egress internal network') !== internalId
    || requireImmutableDockerId(inventory.publicNetwork?.Id, 'Project egress public network') !== publicNetworkId) {
    fail('NETWORK_IDENTITY_INVENTORY', 'Project egress network identity changed before proxy convergence');
  }
  const proxyPublicIpv4 = deriveStaticProxyIpv4(publicNetwork);
  return {
    internal,
    internalId,
    publicNetwork,
    publicNetworkId,
    proxyPublicIpv4,
  };
}

export async function reattestExactCurrentProjectEgressNetworksByImmutableId(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
  expected: Pick<ExactCurrentProjectEgressNetworks, 'internalId' | 'publicNetworkId'>,
): Promise<ExactCurrentProjectEgressNetworks> {
  const internal = await strictInspectOne<DockerNetworkInspect>(
    executor,
    'network',
    expected.internalId,
  ) || fail('INTERNAL_NETWORK_INSPECT', 'Project egress internal network could not be reinspected by immutable id');
  const publicNetwork = await strictInspectOne<DockerNetworkInspect>(
    executor,
    'network',
    expected.publicNetworkId,
  ) || fail('PUBLIC_NETWORK_INSPECT', 'Project egress public network could not be reinspected by immutable id');
  const internalId = requireImmutableDockerId(internal.Id, 'Project egress internal network');
  const publicNetworkId = requireImmutableDockerId(publicNetwork.Id, 'Project egress public network');
  if (internalId !== expected.internalId || publicNetworkId !== expected.publicNetworkId) {
    fail('NETWORK_IDENTITY_RACE', 'Project egress immutable network identity changed');
  }
  attestProjectEgressNetworks(spec, internal, publicNetwork);
  const inventory = await inspectProjectEgressNetworkIdentityInventory(executor, spec);
  if (inventory.ids.length !== 2
    || requireImmutableDockerId(inventory.internal?.Id, 'Project egress internal network') !== internalId
    || requireImmutableDockerId(inventory.publicNetwork?.Id, 'Project egress public network') !== publicNetworkId) {
    fail('NETWORK_IDENTITY_INVENTORY', 'Project egress network identity changed during immutable re-attestation');
  }
  return {
    internal,
    internalId,
    publicNetwork,
    publicNetworkId,
    proxyPublicIpv4: deriveStaticProxyIpv4(publicNetwork),
  };
}

function deriveStaticProxyIpv4(publicNetwork: DockerNetworkInspect): string {
  const config = publicNetwork.IPAM?.Config?.find((entry) => entry?.Subnet?.includes('.'));
  const gateway = config?.Gateway || '';
  const subnet = config?.Subnet || '';
  const base = gateway || subnet.split('/')[0] || '';
  const parts = base.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    fail('PUBLIC_NETWORK_SUBNET', 'Project egress public network has no usable IPv4 subnet');
  }
  // Gateway is conventionally .1; the proxy takes the next address. The
  // public network's only member is the proxy, so the slot is always free.
  parts[3] = (gateway ? parts[3] + 1 : parts[3] + 2);
  return parts.join('.');
}

async function ensureProxyContainer(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
  exactNetworksInput?: ExactCurrentProjectEgressNetworks,
): Promise<DockerContainerInspect> {
  const identityProxyIds = await listExactIdentityProxyIds(executor, spec);
  if (identityProxyIds.length > 1) {
    fail('PROXY_IDENTITY_INVENTORY', 'Multiple proxies claim one Project egress identity');
  }
  let inspect = await strictInspectOne<DockerContainerInspect>(executor, 'container', spec.proxyContainerName);
  if (!inspect && identityProxyIds.length !== 0) {
    fail('PROXY_IDENTITY_INVENTORY', 'A Project egress proxy exists outside its deterministic name');
  }
  if (inspect) {
    const namedId = requireImmutableDockerId(inspect.Id, 'Managed Project egress proxy');
    if (identityProxyIds.length !== 1 || identityProxyIds[0] !== namedId) {
      fail('PROXY_IDENTITY_INVENTORY', 'Project egress proxy name and identity inventory do not match');
    }
  }
  const hasStaticPublicAddress = (candidate: DockerContainerInspect | null): boolean => Boolean(
    candidate?.NetworkSettings?.Networks?.[spec.publicNetworkName]?.IPAMConfig?.IPv4Address,
  );
  const matchesCurrentSpec = (candidate: DockerContainerInspect | null): boolean => (
    candidate?.Config?.Labels?.[LABEL_FINGERPRINT] === spec.policyFingerprint
    && candidate?.Config?.Labels?.[LABEL_TOKEN_HASH] === spec.tokenHash
  );
  let exactNetworks = exactNetworksInput;
  const getExactNetworks = async (): Promise<ExactCurrentProjectEgressNetworks> => {
    exactNetworks ||= await resolveExactCurrentProjectEgressNetworks(executor, spec);
    return exactNetworks;
  };
  const onlyPublicNetworkAttached = (candidate: DockerContainerInspect): boolean => (
    JSON.stringify(Object.keys(candidate.NetworkSettings?.Networks || {}))
      === JSON.stringify([spec.publicNetworkName])
  );
  if (inspect && matchesCurrentSpec(inspect) && hasStaticPublicAddress(inspect)
    && onlyPublicNetworkAttached(inspect)) {
    const networks = await getExactNetworks();
    const containerId = requireImmutableDockerId(inspect.Id, 'Managed Project egress proxy');
    attestProjectEgressProxyContainer(
      spec,
      inspect,
      false,
      false,
      networks.publicNetworkId,
      undefined,
      networks.proxyPublicIpv4,
    );
    await executor.run('docker', [
      'network', 'connect', '--alias', spec.proxyAlias,
      networks.internalId, containerId,
    ]);
    inspect = await strictInspectOne<DockerContainerInspect>(executor, 'container', containerId);
    if (!inspect) fail('PROXY_RACE', 'Project egress proxy disappeared while resuming network attachment');
    attestCurrentProxyByImmutableId({
      spec,
      inspect,
      requireRunning: false,
      expectedContainerId: containerId,
      expectedPublicNetworkId: networks.publicNetworkId,
      expectedInternalNetworkId: networks.internalId,
      expectedPublicIpv4: networks.proxyPublicIpv4,
    });
  }
  if (inspect && (!hasStaticPublicAddress(inspect) || !matchesCurrentSpec(inspect))) {
    // Only a current-policy, static-address proxy with an inspected prior
    // token is a recognized retirement generation here. Older address-policy
    // generations require explicit administrator repair.
    if (!hasStaticPublicAddress(inspect)) {
      fail('STALE_PROXY_GENERATION', 'Managed Project egress proxy lacks the exact current static-address contract');
    }
    const expectedContainerId = requireImmutableDockerId(inspect.Id, 'Managed Project egress proxy');
    const expectedPolicyFingerprint = String(inspect.Config?.Labels?.[LABEL_FINGERPRINT] || '');
    if (expectedPolicyFingerprint !== spec.policyFingerprint) {
      fail('STALE_PROXY_GENERATION', 'Managed Project egress proxy is not an exact recognized current generation');
    }
    const networks = await getExactNetworks();
    await retireManagedProxyByImmutableId({
      executor,
      spec,
      inspect,
      expectedContainerId,
      expectedPolicyFingerprint,
      confinementGeneration: 'CURRENT',
      expectedPublicNetworkId: networks.publicNetworkId,
      expectedInternalNetworkId: networks.internalId,
    });
    if ((await listExactIdentityProxyIds(executor, spec)).length !== 0
      || await strictInspectOne<DockerContainerInspect>(
        executor,
        'container',
        spec.proxyContainerName,
      )) {
      fail('STALE_PROXY_RESIDUAL', 'Managed Project egress proxy remained after exact token rotation');
    }
    inspect = null;
  }
  if (!inspect) {
    const networks = await getExactNetworks();
    const staticIpv4 = deriveStaticProxyIpv4(networks.publicNetwork);
    const createResult = await executor.run('docker', [
      'container', 'create',
      '--name', spec.proxyContainerName,
      '--network', networks.publicNetworkId,
      '--ip', staticIpv4,
      '--read-only',
      '--cap-drop', 'ALL',
      ...projectRuntimeSecurityOptArgs(),
      '--user', '65532:65532',
      '--pids-limit', '128',
      '--memory', '256m',
      '--cpus', '0.50',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
      '--restart', 'no',
      ...labelArgs({
        ...policyLabels(spec, 'proxy'),
        [LABEL_TOKEN_HASH]: spec.tokenHash,
      }),
      '--env', `PROJECT_EGRESS_PROXY_TOKEN=${spec.token}`,
      '--env', `PROJECT_EGRESS_PROXY_PORT=${spec.proxyPort}`,
      '--env', `PROJECT_EGRESS_DENY_CIDRS=${JSON.stringify(spec.deniedCidrs)}`,
      spec.proxyImage,
      ...spec.proxyCommand,
    ]);
    const createdContainerId = requireImmutableDockerId(
      createResult.stdout.trim(),
      'Created Project egress proxy',
    );
    const preConnectInspect = await strictInspectOne<DockerContainerInspect>(
      executor,
      'container',
      createdContainerId,
    );
    if (!preConnectInspect
      || requireImmutableDockerId(preConnectInspect.Id, 'Created Project egress proxy') !== createdContainerId
      || requireDockerName(preConnectInspect.Name, 'Created Project egress proxy') !== spec.proxyContainerName) {
      fail('PROXY_IDENTITY', 'Created Project egress proxy identity changed before network attachment');
    }
    const preConnectIdentityIds = await listExactIdentityProxyIds(executor, spec);
    if (preConnectIdentityIds.length !== 1 || preConnectIdentityIds[0] !== createdContainerId) {
      fail('PROXY_IDENTITY_INVENTORY', 'Created Project egress proxy did not own the exact identity before network attachment');
    }
    attestProjectEgressProxyContainer(
      spec,
      preConnectInspect,
      false,
      false,
      networks.publicNetworkId,
      undefined,
      networks.proxyPublicIpv4,
    );
    await executor.run('docker', [
      'network', 'connect', '--alias', spec.proxyAlias,
      networks.internalId, createdContainerId,
    ]);
    inspect = await strictInspectOne<DockerContainerInspect>(executor, 'container', createdContainerId);
    if (inspect
      && (requireImmutableDockerId(inspect.Id, 'Created Project egress proxy') !== createdContainerId
        || requireDockerName(inspect.Name, 'Created Project egress proxy') !== spec.proxyContainerName)) {
      fail('PROXY_IDENTITY', 'Created Project egress proxy name changed before attestation');
    }
    if (inspect) attestProjectEgressProxyContainer(
      spec,
      inspect,
      false,
      true,
      networks.publicNetworkId,
      networks.internalId,
      networks.proxyPublicIpv4,
    );
  }
  if (!inspect) fail('PROXY_CREATE', 'Project egress proxy container could not be created');
  const createdId = requireImmutableDockerId(inspect.Id, 'Managed Project egress proxy');
  const finalIdentityIds = await listExactIdentityProxyIds(executor, spec);
  if (finalIdentityIds.length !== 1 || finalIdentityIds[0] !== createdId) {
    fail('PROXY_IDENTITY_INVENTORY', 'Project egress proxy creation did not reach an exact identity inventory');
  }
  return inspect;
}

async function ensureFirewallFamily(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
  family: 4 | 6,
  proxyAddress: string,
): Promise<void> {
  const tool = family === 4 ? 'iptables' : 'ip6tables';
  await executor.run(tool, ['-w', '-N', MASTER_FIREWALL_CHAIN], { allowExitCodes: [0, 1] });
  const dockerUserBefore = await executor.run(tool, ['-w', '-S', DOCKER_USER_CHAIN]);
  const firstRule = statementRules(dockerUserBefore.stdout, DOCKER_USER_CHAIN)[0];
  if (firstRule !== `-A ${DOCKER_USER_CHAIN} -j ${MASTER_FIREWALL_CHAIN}`) {
    await executor.run(tool, ['-w', '-I', DOCKER_USER_CHAIN, '1', '-j', MASTER_FIREWALL_CHAIN]);
  }
  await executor.run(tool, ['-w', '-N', spec.firewallChainName], { allowExitCodes: [0, 1] });
  await executor.run(tool, ['-w', '-F', spec.firewallChainName]);
  for (const rule of expectedFirewallRules(spec, family)) {
    const args = rule.split(' ').slice(2);
    await executor.run(tool, ['-w', '-A', spec.firewallChainName, ...args]);
  }
  const prefix = family === 4 ? '32' : '128';
  await executor.run(tool, [
    '-w', '-D', MASTER_FIREWALL_CHAIN, '-s', `${proxyAddress}/${prefix}`,
    '-m', 'comment', '--comment', spec.firewallComment, '-j', spec.firewallChainName,
  ], { allowExitCodes: [0, 1] });
  await executor.run(tool, [
    '-w', '-I', MASTER_FIREWALL_CHAIN, '1', '-s', `${proxyAddress}/${prefix}`,
    '-m', 'comment', '--comment', spec.firewallComment, '-j', spec.firewallChainName,
  ]);
  const dockerUser = await executor.run(tool, ['-w', '-S', DOCKER_USER_CHAIN]);
  const master = await executor.run(tool, ['-w', '-S', MASTER_FIREWALL_CHAIN]);
  const project = await executor.run(tool, ['-w', '-S', spec.firewallChainName]);
  attestProjectEgressFirewallStatements({
    spec,
    family,
    proxyAddress,
    dockerUserStatements: dockerUser.stdout,
    masterStatements: master.stdout,
    projectStatements: project.stdout,
  });
}

// Container→host traffic to host-local addresses (any bridge gateway IP, the
// host's public IPs) travels the INPUT path, which DOCKER-USER never sees.
// Services bound to 0.0.0.0 — Caddy, the portal itself — would otherwise be
// reachable from inside every project sandbox. Both plane subnets are
// rejected wholesale except for ESTABLISHED replies to a connection initiated
// by the Portal host. That narrow reply path lets the Portal reverse-proxy an
// app by its attested internal address without publishing a host port; NEW
// container→host flows still hit the per-subnet REJECT. Runtimes otherwise
// talk only to the proxy sidecar (bridge-local, FORWARD path) and Docker's
// embedded DNS (delivered inside the netns).
async function ensureHostInputProtection(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
  family: 4 | 6,
  subnets: readonly string[],
): Promise<void> {
  if (!subnets.length) return;
  const tool = family === 4 ? 'iptables' : 'ip6tables';
  await executor.run(tool, ['-w', '-N', HOST_FIREWALL_CHAIN], { allowExitCodes: [0, 1] });
  const inputBefore = await executor.run(tool, ['-w', '-S', 'INPUT']);
  const firstInputRule = statementRules(inputBefore.stdout, 'INPUT')[0];
  if (firstInputRule !== `-A INPUT -j ${HOST_FIREWALL_CHAIN}`) {
    await executor.run(tool, ['-w', '-I', 'INPUT', '1', '-j', HOST_FIREWALL_CHAIN]);
  }
  const before = statementRules(
    (await executor.run(tool, ['-w', '-S', HOST_FIREWALL_CHAIN])).stdout,
    HOST_FIREWALL_CHAIN,
  );
  for (const subnet of subnets) {
    const established = `-A ${HOST_FIREWALL_CHAIN} -s ${subnet} -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment ${spec.firewallComment} -j ACCEPT`;
    const rejected = `-A ${HOST_FIREWALL_CHAIN} -s ${subnet} -m comment --comment ${spec.firewallComment} -j REJECT`;
    for (const statement of before) {
      if (statement !== established && statement !== rejected) continue;
      await executor.run(tool, statement === established
        ? [
            '-w', '-D', HOST_FIREWALL_CHAIN, '-s', subnet,
            '-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED',
            '-m', 'comment', '--comment', spec.firewallComment, '-j', 'ACCEPT',
          ]
        : [
            '-w', '-D', HOST_FIREWALL_CHAIN, '-s', subnet,
            '-m', 'comment', '--comment', spec.firewallComment, '-j', 'REJECT',
          ], { allowExitCodes: [0, 1] });
    }
    // Insert the deny first and its narrow established-reply exception second
    // at the same position, leaving ACCEPT immediately ahead of REJECT.
    await executor.run(tool, [
      '-w', '-I', HOST_FIREWALL_CHAIN, '1', '-s', subnet,
      '-m', 'comment', '--comment', spec.firewallComment, '-j', 'REJECT',
    ]);
    await executor.run(tool, [
      '-w', '-I', HOST_FIREWALL_CHAIN, '1', '-s', subnet,
      '-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED',
      '-m', 'comment', '--comment', spec.firewallComment, '-j', 'ACCEPT',
    ]);
  }
  const hostChain = await executor.run(tool, ['-w', '-S', HOST_FIREWALL_CHAIN]);
  const statements = statementRules(hostChain.stdout, HOST_FIREWALL_CHAIN);
  const expectedIdentityRules: string[] = [];
  for (const subnet of subnets) {
    const established = `-A ${HOST_FIREWALL_CHAIN} -s ${subnet} -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment ${spec.firewallComment} -j ACCEPT`;
    const rejected = `-A ${HOST_FIREWALL_CHAIN} -s ${subnet} -m comment --comment ${spec.firewallComment} -j REJECT`;
    expectedIdentityRules.push(established, rejected);
    const establishedIndex = statements.indexOf(established);
    const rejectedIndex = statements.indexOf(rejected);
    if (establishedIndex < 0 || rejectedIndex < 0 || establishedIndex >= rejectedIndex) {
      fail('FIREWALL_HOST_INPUT', `${tool} project host-input protection for ${subnet} is missing`);
    }
  }
  const identityRules = statements.filter((line) => (
    line.includes(`-m comment --comment ${spec.firewallComment} `)
  ));
  if (JSON.stringify([...identityRules].sort()) !== JSON.stringify([...expectedIdentityRules].sort())) {
    fail('FIREWALL_HOST_INPUT', `${tool} project host-input protection has unsafe or duplicate rules`);
  }
}

function attestCurrentProxyByImmutableId(input: {
  spec: ProjectEgressPlaneSpec;
  inspect: DockerContainerInspect;
  requireRunning: boolean;
  expectedContainerId?: string;
  expectedPublicNetworkId?: string;
  expectedInternalNetworkId?: string;
  expectedPublicIpv4?: string;
}): {
  containerId: string;
  addresses: { publicIpv4: string | null; publicIpv6: string | null };
  inspect: DockerContainerInspect;
} {
  const containerId = requireImmutableDockerId(input.inspect.Id, 'Project egress proxy');
  const containerName = requireDockerName(input.inspect.Name, 'Project egress proxy');
  if (containerName !== input.spec.proxyContainerName
    || (input.expectedContainerId && containerId !== input.expectedContainerId)) {
    fail('PROXY_IDENTITY', 'Project egress proxy immutable identity did not match');
  }
  return {
    containerId,
    inspect: input.inspect,
    addresses: attestProjectEgressProxyContainer(
      input.spec,
      input.inspect,
      input.requireRunning,
      true,
      input.expectedPublicNetworkId,
      input.expectedInternalNetworkId,
      input.expectedPublicIpv4,
    ),
  };
}

async function reattestCurrentProxyByImmutableId(input: {
  executor: ProjectEgressCommandExecutor;
  spec: ProjectEgressPlaneSpec;
  containerId: string;
  requireRunning: boolean;
  expectedPublicNetworkId?: string;
  expectedInternalNetworkId?: string;
  expectedPublicIpv4?: string;
}): Promise<{
  containerId: string;
  addresses: { publicIpv4: string | null; publicIpv6: string | null };
  inspect: DockerContainerInspect;
}> {
  const inspect = await strictInspectOne<DockerContainerInspect>(
    input.executor,
    'container',
    input.containerId,
  );
  if (!inspect) fail('PROXY_RACE', 'Project egress proxy disappeared during convergence');
  return attestCurrentProxyByImmutableId({
    spec: input.spec,
    inspect,
    requireRunning: input.requireRunning,
    expectedContainerId: input.containerId,
    expectedPublicNetworkId: input.expectedPublicNetworkId,
    expectedInternalNetworkId: input.expectedInternalNetworkId,
    expectedPublicIpv4: input.expectedPublicIpv4,
  });
}

export interface ProjectEgressCurrentPlaneAttestation {
  internalNetworkId: string;
  publicNetworkId: string;
  proxyContainerId: string;
  internalNetwork: DockerNetworkInspect;
  publicNetwork: DockerNetworkInspect;
  proxyContainer: DockerContainerInspect;
}

/**
 * Read-only final-plane attestation for callers that must retain immutable
 * Docker identities beyond egress convergence. Raw actor/project/provider
 * inventories, deterministic names, and ID-addressed reinspection must all
 * agree before any snapshot is returned.
 */
export async function attestCurrentProjectEgressPlaneByImmutableIdentity(
  executor: ProjectEgressCommandExecutor,
  spec: ProjectEgressPlaneSpec,
): Promise<ProjectEgressCurrentPlaneAttestation> {
  const namedNetworks = await resolveExactCurrentProjectEgressNetworks(executor, spec);
  const exactNetworks = await reattestExactCurrentProjectEgressNetworksByImmutableId(
    executor,
    spec,
    namedNetworks,
  );
  const proxyIds = await listExactIdentityProxyIds(executor, spec);
  if (proxyIds.length !== 1) {
    fail('PROXY_IDENTITY_INVENTORY', 'Project egress proxy identity inventory was not exact');
  }
  const proxyContainerId = proxyIds[0];
  const namedProxy = await strictInspectOne<DockerContainerInspect>(
    executor,
    'container',
    spec.proxyContainerName,
  );
  if (!namedProxy
    || requireImmutableDockerId(namedProxy.Id, 'Project egress proxy') !== proxyContainerId) {
    fail('PROXY_IDENTITY_INVENTORY', 'Project egress proxy name and immutable identity did not agree');
  }
  const proxy = await reattestCurrentProxyByImmutableId({
    executor,
    spec,
    containerId: proxyContainerId,
    requireRunning: true,
    expectedPublicNetworkId: exactNetworks.publicNetworkId,
    expectedInternalNetworkId: exactNetworks.internalId,
    expectedPublicIpv4: exactNetworks.proxyPublicIpv4,
  });
  const finalNetworks = await reattestExactCurrentProjectEgressNetworksByImmutableId(
    executor,
    spec,
    exactNetworks,
  );
  const [finalNamedInternal, finalNamedPublic, finalNamedProxy] = await Promise.all([
    strictInspectOne<DockerNetworkInspect>(executor, 'network', spec.internalNetworkName),
    strictInspectOne<DockerNetworkInspect>(executor, 'network', spec.publicNetworkName),
    strictInspectOne<DockerContainerInspect>(executor, 'container', spec.proxyContainerName),
  ]);
  let finalNetworkInventory: ProjectEgressNetworkIdentityInventory;
  let finalProxyIds: string[];
  try {
    [finalNetworkInventory, finalProxyIds] = await Promise.all([
      inspectProjectEgressNetworkIdentityInventory(executor, spec),
      listExactIdentityProxyIds(executor, spec),
    ]);
  } catch {
    fail('PLANE_IDENTITY_RACE', 'Project egress immutable identity inventories changed');
  }
  if (!finalNamedInternal
    || !finalNamedPublic
    || !finalNamedProxy
    || requireImmutableDockerId(finalNamedInternal.Id, 'Project egress internal network')
      !== finalNetworks.internalId
    || requireImmutableDockerId(finalNamedPublic.Id, 'Project egress public network')
      !== finalNetworks.publicNetworkId
    || requireImmutableDockerId(finalNamedProxy.Id, 'Project egress proxy') !== proxyContainerId
    || finalNetworkInventory.ids.length !== 2
    || requireImmutableDockerId(
      finalNetworkInventory.internal?.Id,
      'Project egress internal network',
    ) !== finalNetworks.internalId
    || requireImmutableDockerId(
      finalNetworkInventory.publicNetwork?.Id,
      'Project egress public network',
    ) !== finalNetworks.publicNetworkId
    || JSON.stringify(finalProxyIds) !== JSON.stringify([proxyContainerId])) {
    fail('PLANE_IDENTITY_RACE', 'Project egress names and immutable identity inventories changed');
  }
  attestProjectEgressNetworks(spec, finalNamedInternal, finalNamedPublic);
  return Object.freeze({
    internalNetworkId: finalNetworks.internalId,
    publicNetworkId: finalNetworks.publicNetworkId,
    proxyContainerId,
    internalNetwork: finalNetworks.internal,
    publicNetwork: finalNetworks.publicNetwork,
    proxyContainer: proxy.inspect,
  });
}

async function stopExactCurrentProxyAfterFailure(input: {
  executor: ProjectEgressCommandExecutor;
  spec: ProjectEgressPlaneSpec;
  containerId: string;
  expectedPublicNetworkId?: string;
  expectedInternalNetworkId?: string;
  expectedPublicIpv4?: string;
}): Promise<void> {
  // Cleanup must never fall back to the deterministic name. If the immutable
  // object disappeared or drifted, preserve the original error without
  // touching the container that may now own that name.
  try {
    const inspect = await strictInspectOne<DockerContainerInspect>(
      input.executor,
      'container',
      input.containerId,
    );
    if (!inspect || inspect.State?.Running !== true) return;
    attestCurrentProxyByImmutableId({
      spec: input.spec,
      inspect,
      requireRunning: true,
      expectedContainerId: input.containerId,
      expectedPublicNetworkId: input.expectedPublicNetworkId,
      expectedInternalNetworkId: input.expectedInternalNetworkId,
      expectedPublicIpv4: input.expectedPublicIpv4,
    });
    await input.executor.run(
      'docker',
      ['container', 'stop', '--time', '1', input.containerId],
      { allowExitCodes: [0, 1] },
    );
    const stopped = await strictInspectOne<DockerContainerInspect>(
      input.executor,
      'container',
      input.containerId,
    );
    if (!stopped) return;
    attestCurrentProxyByImmutableId({
      spec: input.spec,
      inspect: stopped,
      requireRunning: false,
      expectedContainerId: input.containerId,
      expectedPublicNetworkId: input.expectedPublicNetworkId,
      expectedInternalNetworkId: input.expectedInternalNetworkId,
      expectedPublicIpv4: input.expectedPublicIpv4,
    });
  } catch {
    // Ambiguous cleanup is intentionally a no-op.
  }
}

export async function ensureProjectEgressPlane(
  config: ProjectEgressPlaneConfig,
  executor: ProjectEgressCommandExecutor = projectEgressCommandExecutor,
): Promise<ProjectEgressPlaneHandle> {
  assertProjectRuntimeConfinementReadyForExecution();
  const spec = buildProjectEgressPlaneSpec(config);
  await ensureNetworks(executor, spec);
  const exactNetworks = await resolveExactCurrentProjectEgressNetworks(executor, spec);
  const firewallNetworks = await reattestExactCurrentProjectEgressNetworksByImmutableId(
    executor,
    spec,
    exactNetworks,
  );
  const planeSubnetsV4: string[] = [];
  for (const network of [firewallNetworks.internal, firewallNetworks.publicNetwork]) {
    for (const entry of network?.IPAM?.Config || []) {
      if (entry?.Subnet && entry.Subnet.includes('.')) planeSubnetsV4.push(entry.Subnet);
    }
  }
  await ensureHostInputProtection(executor, spec, 4, planeSubnetsV4);
  const proxyInspect = await ensureProxyContainer(executor, spec, exactNetworks);
  let proxyContainerId: string | null = null;
  try {
    if (typeof proxyInspect.State?.Running !== 'boolean') {
      fail('PROXY_STATE', 'Project egress proxy state is ambiguous');
    }
    const initial = attestCurrentProxyByImmutableId({
      spec,
      inspect: proxyInspect,
      requireRunning: proxyInspect.State.Running,
      expectedPublicNetworkId: exactNetworks.publicNetworkId,
      expectedInternalNetworkId: exactNetworks.internalId,
      expectedPublicIpv4: exactNetworks.proxyPublicIpv4,
    });
    proxyContainerId = initial.containerId;
    if (proxyInspect.State.Running) {
      await reattestCurrentProxyByImmutableId({
        executor,
        spec,
        containerId: proxyContainerId,
        requireRunning: true,
        expectedPublicNetworkId: exactNetworks.publicNetworkId,
        expectedInternalNetworkId: exactNetworks.internalId,
        expectedPublicIpv4: exactNetworks.proxyPublicIpv4,
      });
      await executor.run('docker', ['container', 'stop', '--time', '1', proxyContainerId]);
    }
    const stopped = await reattestCurrentProxyByImmutableId({
      executor,
      spec,
      containerId: proxyContainerId,
      requireRunning: false,
      expectedPublicNetworkId: exactNetworks.publicNetworkId,
      expectedInternalNetworkId: exactNetworks.internalId,
      expectedPublicIpv4: exactNetworks.proxyPublicIpv4,
    });
    const { addresses } = stopped;
    if (!addresses.publicIpv4 && !addresses.publicIpv6) {
      fail('PROXY_PUBLIC_ADDRESS', 'Project egress proxy has no public-network address');
    }
    if (addresses.publicIpv4) await ensureFirewallFamily(executor, spec, 4, addresses.publicIpv4);
    if (addresses.publicIpv6) await ensureFirewallFamily(executor, spec, 6, addresses.publicIpv6);
    await reattestCurrentProxyByImmutableId({
      executor,
      spec,
      containerId: proxyContainerId,
      requireRunning: false,
      expectedPublicNetworkId: exactNetworks.publicNetworkId,
      expectedInternalNetworkId: exactNetworks.internalId,
      expectedPublicIpv4: exactNetworks.proxyPublicIpv4,
    });
    await executor.run('docker', ['container', 'start', proxyContainerId]);
    const running = await reattestCurrentProxyByImmutableId({
      executor,
      spec,
      containerId: proxyContainerId,
      requireRunning: true,
      expectedPublicNetworkId: exactNetworks.publicNetworkId,
      expectedInternalNetworkId: exactNetworks.internalId,
      expectedPublicIpv4: exactNetworks.proxyPublicIpv4,
    });
    const finalNetworks = await resolveExactCurrentProjectEgressNetworks(executor, spec);
    if (finalNetworks.internalId !== exactNetworks.internalId
      || finalNetworks.publicNetworkId !== exactNetworks.publicNetworkId
      || String(running.inspect.NetworkSettings?.Networks?.[spec.internalNetworkName]?.NetworkID || '').toLowerCase()
        !== exactNetworks.internalId
      || String(running.inspect.NetworkSettings?.Networks?.[spec.publicNetworkName]?.NetworkID || '').toLowerCase()
        !== exactNetworks.publicNetworkId) {
      fail('PROXY_NETWORK_IDENTITY', 'Project egress proxy network identities changed during convergence');
    }
    attestProjectEgressNetworkMembership({
      network: finalNetworks.publicNetwork,
      expectedNames: [spec.proxyContainerName],
      role: 'proxy-public',
    });
    const finalIdentityProxyIds = await listExactIdentityProxyIds(executor, spec);
    if (finalIdentityProxyIds.length !== 1
      || finalIdentityProxyIds[0] !== proxyContainerId.toLowerCase()) {
      fail('PROXY_IDENTITY_INVENTORY', 'Project egress proxy identity changed after final convergence');
    }
    await reattestCurrentProxyByImmutableId({
      executor,
      spec,
      containerId: proxyContainerId,
      requireRunning: true,
      expectedPublicNetworkId: exactNetworks.publicNetworkId,
      expectedInternalNetworkId: exactNetworks.internalId,
      expectedPublicIpv4: exactNetworks.proxyPublicIpv4,
    });
  } catch (error) {
    if (proxyContainerId) {
      await stopExactCurrentProxyAfterFailure({
        executor,
        spec,
        containerId: proxyContainerId,
        expectedPublicNetworkId: exactNetworks.publicNetworkId,
        expectedInternalNetworkId: exactNetworks.internalId,
        expectedPublicIpv4: exactNetworks.proxyPublicIpv4,
      });
    }
    throw error;
  }

  const proxyUrl = `http://portal:${encodeURIComponent(spec.token)}@${spec.proxyAlias}:${spec.proxyPort}`;
  return {
    policyVersion: PROJECT_EGRESS_POLICY_VERSION,
    policyFingerprint: spec.policyFingerprint,
    internalNetworkName: spec.internalNetworkName,
    internalNetworkId: exactNetworks.internalId,
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

export async function constrainProjectRuntimeToEgressPlane(input: {
  spec: ProjectEgressPlaneSpec;
  runtimeContainerId: string;
  runtimeContainerName: string;
  expectedRuntimeFingerprint: string;
  executor?: ProjectEgressCommandExecutor;
}): Promise<void> {
  const executor = input.executor || projectEgressCommandExecutor;
  const runtimeContainerId = requireImmutableDockerId(
    input.runtimeContainerId,
    'Project runtime container',
  );
  const runtimeContainerName = requireDockerName(input.runtimeContainerName, 'Project runtime container');
  const exactNetworks = await resolveExactCurrentProjectEgressNetworks(executor, input.spec);
  const attestRuntimeIdentity = (candidate: DockerContainerInspect): void => {
    if (requireImmutableDockerId(candidate.Id, 'Project runtime container') !== runtimeContainerId
      || requireDockerName(candidate.Name, 'Project runtime container') !== runtimeContainerName) {
      fail('RUNTIME_IDENTITY', 'Project runtime immutable identity changed before confinement');
    }
    if (candidate.State?.Running !== false) {
      fail('RUNTIME_RUNNING', 'Project runtime must be stopped before network confinement');
    }
    if (candidate.Config?.Labels?.[LABEL_RUNTIME_FINGERPRINT] !== input.expectedRuntimeFingerprint) {
      fail('RUNTIME_IDENTITY', 'Project runtime identity fingerprint did not match before confinement');
    }
  };
  // Docker reports an empty NetworkID for a container that has never been
  // started; the id materializes on first start and then persists across
  // stops. A freshly created workload therefore arrives here with its sole
  // `--network none` attachment carrying no id, and only the singleton none
  // network can legitimately explain that shape.
  const noneNetwork = await strictInspectOne<DockerNetworkInspect>(executor, 'network', 'none');
  const noneNetworkId = noneNetwork
    ? requireImmutableDockerId(noneNetwork.Id, 'Docker none network')
    : '';
  const runtimeAttachments = (candidate: DockerContainerInspect): Array<{
    networkName: string;
    networkId: string;
  }> => {
    const entries = Object.entries(candidate.NetworkSettings?.Networks || {});
    return entries.map(([networkNameInput, attachment]) => {
      const networkName = requireDockerName(networkNameInput, 'Project runtime attached network');
      const reportedId = String(attachment.NetworkID || '').toLowerCase();
      const stoppedNoId = reportedId === ''
        && entries.length === 1
        && candidate.State?.Running !== true;
      const stoppedIdPrimary = stoppedNoId
        && networkName === input.spec.internalNetworkName
        && String(candidate.HostConfig?.NetworkMode || '').toLowerCase() === exactNetworks.internalId;
      const stoppedIdNone = stoppedNoId
        && networkName === 'none'
        && noneNetworkId !== ''
        && String(candidate.HostConfig?.NetworkMode || '').toLowerCase() === 'none';
      return {
        networkName,
        networkId: stoppedIdPrimary
          ? exactNetworks.internalId
          : stoppedIdNone
            ? noneNetworkId
            : requireImmutableDockerId(reportedId, 'Project runtime attached network'),
      };
    }).sort((left, right) => left.networkName.localeCompare(right.networkName));
  };
  let inspect = await strictInspectOne<DockerContainerInspect>(executor, 'container', runtimeContainerId);
  if (!inspect) fail('RUNTIME_MISSING', 'Project runtime container is missing');
  attestRuntimeIdentity(inspect);

  const initialAttachments = runtimeAttachments(inspect);
  if (new Set(initialAttachments.map(({ networkId }) => networkId)).size !== initialAttachments.length) {
    fail('RUNTIME_NETWORK_IDENTITY', 'Project runtime network attachment identities are ambiguous');
  }
  for (const attachment of initialAttachments) {
    const attachedNetwork = await strictInspectOne<DockerNetworkInspect>(
      executor,
      'network',
      attachment.networkId,
    );
    if (!attachedNetwork
      || requireImmutableDockerId(
        attachedNetwork.Id,
        'Project runtime attached network',
      ) !== attachment.networkId
      || requireDockerName(
        attachedNetwork.Name,
        'Project runtime attached network',
      ) !== attachment.networkName) {
      fail('RUNTIME_NETWORK_IDENTITY', 'Project runtime attached network identity changed before confinement');
    }
    if ((attachment.networkName === input.spec.internalNetworkName)
      !== (attachment.networkId === exactNetworks.internalId)) {
      fail('RUNTIME_NETWORK_IDENTITY', 'Project runtime internal network name and immutable identity disagree');
    }
  }

  await reattestExactCurrentProjectEgressNetworksByImmutableId(executor, input.spec, exactNetworks);
  inspect = await strictInspectOne<DockerContainerInspect>(executor, 'container', runtimeContainerId);
  if (!inspect) fail('RUNTIME_REINSPECT', 'Project runtime could not be reinspected before confinement');
  attestRuntimeIdentity(inspect);
  const barrierAttachments = runtimeAttachments(inspect);
  if (JSON.stringify(barrierAttachments) !== JSON.stringify(initialAttachments)) {
    fail('RUNTIME_NETWORK_RACE', 'Project runtime network attachments changed before confinement');
  }

  for (const attachment of barrierAttachments) {
    if (attachment.networkId === exactNetworks.internalId) continue;
    await executor.run('docker', [
      'network', 'disconnect', '--force', attachment.networkId, runtimeContainerId,
    ]);
  }
  inspect = await strictInspectOne<DockerContainerInspect>(executor, 'container', runtimeContainerId);
  if (!inspect) fail('RUNTIME_REINSPECT', 'Project runtime could not be reinspected after network disconnection');
  attestRuntimeIdentity(inspect);
  const remainingAttachments = runtimeAttachments(inspect);
  if (remainingAttachments.some((attachment) => (
    attachment.networkName !== input.spec.internalNetworkName
      || attachment.networkId !== exactNetworks.internalId
  ))) {
    fail('RUNTIME_NETWORK_RACE', 'Project runtime retained an unexpected network attachment');
  }
  if (remainingAttachments.length === 0) {
    await reattestExactCurrentProjectEgressNetworksByImmutableId(executor, input.spec, exactNetworks);
    await executor.run('docker', [
      'network', 'connect', exactNetworks.internalId, runtimeContainerId,
    ]);
  }
  inspect = await strictInspectOne<DockerContainerInspect>(executor, 'container', runtimeContainerId);
  if (!inspect) fail('RUNTIME_REINSPECT', 'Project runtime could not be reinspected');
  attestRuntimeIdentity(inspect);
  attestProjectRuntimeEgressAttachment(
    input.spec,
    inspect,
    input.expectedRuntimeFingerprint,
    exactNetworks.internalId,
  );
  const finalNetworks = await reattestExactCurrentProjectEgressNetworksByImmutableId(
    executor,
    input.spec,
    exactNetworks,
  );
  attestProjectEgressNetworkMembership({
    network: finalNetworks.internal,
    expectedNames: [input.spec.proxyContainerName],
    optionalNames: [runtimeContainerName],
    role: 'internal',
  });
}

export const PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL = LABEL_RUNTIME_FINGERPRINT;

export const __projectEgressPlaneTest = {
  MASTER_FIREWALL_CHAIN,
  DOCKER_USER_CHAIN,
  expectedFirewallRules,
  statementRules,
  removeStaleNetwork,
  ensureNetworks,
  ensureProxyContainer,
  labels: {
    LABEL_POLICY,
    LABEL_FINGERPRINT,
    LABEL_ROLE,
    LABEL_TOKEN_HASH,
    LABEL_RUNTIME_FINGERPRINT,
    LABEL_IDENTITY,
    LABEL_ACTOR_ID,
    LABEL_PROJECT_ID,
    LABEL_PROVIDER,
    LABEL_CONSUMER_KIND,
    LABEL_WORKLOAD_ID,
  },
  FIREWALL_COMMENT_PREFIX,
};
