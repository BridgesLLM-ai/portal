import net from 'net';
import type { ProjectSandboxExecutionContext } from '../../AgentProvider.interface';
import { buildProjectEgressConfig } from '../../../services/projectEgressCredentials';
import {
  PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL,
  attestProjectEgressFirewallStatements,
  attestProjectEgressNetworkMembership,
  attestProjectEgressNetworks,
  attestProjectEgressProxyContainer,
  buildProjectEgressPlaneSpec,
  type ProjectEgressPlaneConfig,
  type ProjectEgressPlaneSpec,
} from '../../../services/projectEgressPlane';
import { AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT } from './AgentZeroProjectModelBridgeCredential';

const MASTER_FIREWALL_CHAIN = 'P4E-MASTER-V1';
const DOCKER_USER_CHAIN = 'DOCKER-USER';
export const AGENT_ZERO_PROJECT_FIREWALL_CHAIN_PREFIX = 'A0P';
export const AGENT_ZERO_PROJECT_FIREWALL_COMMENT_PREFIX = 'a0p-v3';

export type AgentZeroProjectCommandRunner = (command: string, args: string[]) => string;

interface DockerNetworkInspect {
  Id?: string;
  Name?: string;
  Driver?: string;
  Internal?: boolean;
  EnableIPv6?: boolean;
  Labels?: Record<string, string> | null;
  IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> | null };
  Containers?: Record<string, { Name?: string; IPv4Address?: string; IPv6Address?: string }> | null;
}

interface DockerContainerInspect {
  Id?: string;
  Name?: string;
  Config?: {
    Image?: string;
    User?: string;
    Env?: string[];
    Cmd?: string[] | null;
    Labels?: Record<string, string> | null;
  };
  State?: { Running?: boolean };
  HostConfig?: Record<string, any>;
  Mounts?: unknown[];
  NetworkSettings?: {
    Networks?: Record<string, {
      IPAddress?: string;
      GlobalIPv6Address?: string;
      Aliases?: string[] | null;
      IPAMConfig?: { IPv4Address?: string; IPv6Address?: string } | null;
    }>;
  };
}

export interface AgentZeroProjectEgressAttestation {
  spec: ProjectEgressPlaneSpec;
  policyFingerprint: string;
  internalNetworkName: string;
  proxyContainerName: string;
  runtimeIpv4: string;
  proxyIpv4: string;
  bridgeGatewayIpv4: string;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseSingleInspect<T extends Record<string, any>>(payload: string, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error(`${label} returned an invalid inspection result`);
  }
  return parsed[0] as T;
}

function normalizedName(value: unknown): string {
  return String(value || '').replace(/^\//, '');
}

function addressWithoutPrefix(value: unknown): string {
  return String(value || '').split('/')[0];
}

function requireIpv4(value: unknown, label: string): string {
  const address = addressWithoutPrefix(value);
  if (!net.isIPv4(address)) throw new Error(`${label} did not have an IPv4 address`);
  return address;
}

function ipv4ToInteger(value: string, label: string): number {
  const address = requireIpv4(value, label);
  return address.split('.').reduce((result, part) => (result * 256) + Number(part), 0);
}

function integerToIpv4(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error('Agent Zero Project static runtime IPv4 allocation overflowed');
  }
  return [
    Math.floor(value / 0x1_00_00_00) % 256,
    Math.floor(value / 0x1_00_00) % 256,
    Math.floor(value / 0x1_00) % 256,
    value % 256,
  ].join('.');
}

function deriveStaticRuntimeIpv4(network: DockerNetworkInspect): string {
  const ipam = Array.isArray(network.IPAM?.Config) ? network.IPAM!.Config! : [];
  if (ipam.length !== 1) throw new Error('Agent Zero project internal network IPAM is ambiguous');
  const subnet = String(ipam[0]?.Subnet || '');
  const match = subnet.match(/^((?:[0-9]{1,3}\.){3}[0-9]{1,3})\/([0-9]|[12][0-9]|3[0-2])$/);
  if (!match) throw new Error('Agent Zero project internal network IPv4 subnet is invalid');
  const prefix = Number(match[2]);
  const size = 2 ** (32 - prefix);
  const suppliedBase = ipv4ToInteger(match[1], 'Agent Zero internal network subnet');
  const networkBase = Math.floor(suppliedBase / size) * size;
  const broadcast = networkBase + size - 1;
  // Each identity gets a dedicated network. The gateway conventionally owns
  // host 1 and the proxy owns host 2; reserve host 3 for the exact runtime.
  const candidate = networkBase + 3;
  const gateway = ipv4ToInteger(String(ipam[0]?.Gateway || ''), 'Agent Zero bridge gateway');
  if (gateway <= networkBase || gateway >= broadcast || candidate >= broadcast || candidate === gateway) {
    throw new Error('Agent Zero project internal network has no deterministic runtime IPv4 slot');
  }
  return integerToIpv4(candidate);
}

function normalizeFirewallStatements(payload: string): string[] {
  return payload.split(/\r?\n/)
    .map((line) => line.trim().replace(/--comment "([^"]+)"/g, '--comment $1'))
    .filter(Boolean);
}

function rulesForChain(statements: readonly string[], chain: string): string[] {
  return statements.filter((line) => line.startsWith(`-A ${chain} `));
}

function runtimeChain(spec: ProjectEgressPlaneSpec): string {
  return `${AGENT_ZERO_PROJECT_FIREWALL_CHAIN_PREFIX}-${spec.identityFingerprint.slice(0, 24).toUpperCase()}`;
}

function runtimeFirewallComment(spec: ProjectEgressPlaneSpec): string {
  return `${AGENT_ZERO_PROJECT_FIREWALL_COMMENT_PREFIX}:${spec.projectFingerprint}:${spec.identityFingerprint}`;
}

function runtimeFirewallRules(input: {
  spec: ProjectEgressPlaneSpec;
  proxyIpv4: string;
  bridgeGatewayIpv4: string;
  modelBridgePort?: number;
}): string[] {
  const chain = runtimeChain(input.spec);
  const comment = runtimeFirewallComment(input.spec);
  const modelBridgePort = input.modelBridgePort || AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT;
  return [
    `-A ${chain} -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment ${comment} -j ACCEPT`,
    `-A ${chain} -d ${input.proxyIpv4}/32 -p tcp -m tcp --dport ${input.spec.proxyPort} -m comment --comment ${comment} -j ACCEPT`,
    `-A ${chain} -d ${input.bridgeGatewayIpv4}/32 -p tcp -m tcp --dport ${modelBridgePort} -m comment --comment ${comment} -j ACCEPT`,
    `-A ${chain} -m comment --comment ${comment} -j REJECT --reject-with icmp-port-unreachable`,
  ];
}

function runtimeJump(input: {
  parent: 'INPUT' | typeof DOCKER_USER_CHAIN;
  spec: ProjectEgressPlaneSpec;
  runtimeIpv4: string;
}): string {
  return `-A ${input.parent} -s ${input.runtimeIpv4}/32 -m comment --comment ${runtimeFirewallComment(input.spec)}`
    + ` -j ${runtimeChain(input.spec)}`;
}

function managedRuntimeJumpPattern(parent: 'INPUT' | typeof DOCKER_USER_CHAIN): RegExp {
  return new RegExp(
    `^-A ${parent} -s [0-9.]+/32 -m comment --comment ${AGENT_ZERO_PROJECT_FIREWALL_COMMENT_PREFIX}`
      + ':[a-f0-9]{64}:[a-f0-9]{64}'
      + ` -j ${AGENT_ZERO_PROJECT_FIREWALL_CHAIN_PREFIX}-[A-F0-9]{24}$`,
  );
}

export function assertAgentZeroProjectRuntimeFirewall(input: {
  spec: ProjectEgressPlaneSpec;
  runtimeIpv4: string;
  proxyIpv4: string;
  bridgeGatewayIpv4: string;
  modelBridgePort?: number;
  statements: string;
}): void {
  const statements = normalizeFirewallStatements(input.statements);
  const chain = runtimeChain(input.spec);
  const chainRules = rulesForChain(statements, chain);
  if (JSON.stringify(chainRules) !== JSON.stringify(runtimeFirewallRules(input))) {
    throw new Error('Agent Zero project runtime firewall chain drifted from the proxy-only policy');
  }

  const inputRules = rulesForChain(statements, 'INPUT');
  const expectedInputJump = runtimeJump({
    parent: 'INPUT',
    spec: input.spec,
    runtimeIpv4: input.runtimeIpv4,
  });
  const inputIndex = inputRules.indexOf(expectedInputJump);
  if (inputIndex < 0 || inputRules.filter((line) => line === expectedInputJump).length !== 1
    || inputRules.slice(0, inputIndex).some((line) => !managedRuntimeJumpPattern('INPUT').test(line))) {
    throw new Error('Agent Zero project INPUT firewall jump is missing or shadowed');
  }

  const dockerUserRules = rulesForChain(statements, DOCKER_USER_CHAIN);
  if (dockerUserRules[0] !== `-A ${DOCKER_USER_CHAIN} -j ${MASTER_FIREWALL_CHAIN}`) {
    throw new Error('Agent Zero project firewall is not behind the first shared egress master jump');
  }
  const expectedDockerJump = runtimeJump({
    parent: DOCKER_USER_CHAIN,
    spec: input.spec,
    runtimeIpv4: input.runtimeIpv4,
  });
  const dockerIndex = dockerUserRules.indexOf(expectedDockerJump);
  if (dockerIndex < 1 || dockerUserRules.filter((line) => line === expectedDockerJump).length !== 1
    || dockerUserRules.slice(1, dockerIndex).some((line) => !managedRuntimeJumpPattern(DOCKER_USER_CHAIN).test(line))) {
    throw new Error('Agent Zero project DOCKER-USER firewall jump is missing or shadowed');
  }
}

function checkCommand(
  runCommand: AgentZeroProjectCommandRunner,
  command: string,
  args: string[],
): boolean {
  try {
    runCommand(command, args);
    return true;
  } catch {
    return false;
  }
}

function removeExactJump(
  runCommand: AgentZeroProjectCommandRunner,
  parent: 'INPUT' | typeof DOCKER_USER_CHAIN,
  spec: ProjectEgressPlaneSpec,
  runtimeIpv4: string,
): void {
  const args = [
    '-w', '5', '-D', parent,
    '-s', `${runtimeIpv4}/32`,
    '-m', 'comment', '--comment', runtimeFirewallComment(spec),
    '-j', runtimeChain(spec),
  ];
  while (checkCommand(runCommand, 'iptables', args)) {
    // Remove every duplicate before installing one ordered jump.
  }
}

export function installAgentZeroProjectFirewall(input: {
  spec: ProjectEgressPlaneSpec;
  runtimeIpv4: string;
  proxyIpv4: string;
  bridgeGatewayIpv4: string;
  modelBridgePort?: number;
  runCommand: AgentZeroProjectCommandRunner;
}): void {
  requireIpv4(input.runtimeIpv4, 'Agent Zero runtime');
  requireIpv4(input.proxyIpv4, 'Agent Zero egress proxy');
  requireIpv4(input.bridgeGatewayIpv4, 'Agent Zero model bridge gateway');
  const modelBridgePort = input.modelBridgePort || AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT;
  if (!Number.isSafeInteger(modelBridgePort) || modelBridgePort < 1024 || modelBridgePort > 65_535) {
    throw new Error('Agent Zero Project model bridge port is invalid');
  }
  const chain = runtimeChain(input.spec);
  checkCommand(input.runCommand, 'iptables', ['-w', '5', '-N', chain]);
  input.runCommand('iptables', ['-w', '5', '-F', chain]);
  for (const statement of runtimeFirewallRules(input)) {
    input.runCommand('iptables', ['-w', '5', '-A', chain, ...statement.split(' ').slice(2)]);
  }

  const before = normalizeFirewallStatements(input.runCommand('iptables', ['-w', '5', '-S']));
  if (rulesForChain(before, DOCKER_USER_CHAIN)[0] !== `-A ${DOCKER_USER_CHAIN} -j ${MASTER_FIREWALL_CHAIN}`) {
    throw new Error('Shared Project egress master firewall must be first before Agent Zero can start');
  }
  removeExactJump(input.runCommand, 'INPUT', input.spec, input.runtimeIpv4);
  removeExactJump(input.runCommand, DOCKER_USER_CHAIN, input.spec, input.runtimeIpv4);
  input.runCommand('iptables', [
    '-w', '5', '-I', 'INPUT', '1',
    '-s', `${input.runtimeIpv4}/32`,
    '-m', 'comment', '--comment', runtimeFirewallComment(input.spec),
    '-j', chain,
  ]);
  input.runCommand('iptables', [
    '-w', '5', '-I', DOCKER_USER_CHAIN, '2',
    '-s', `${input.runtimeIpv4}/32`,
    '-m', 'comment', '--comment', runtimeFirewallComment(input.spec),
    '-j', chain,
  ]);
  assertAgentZeroProjectRuntimeFirewall({
    ...input,
    statements: input.runCommand('iptables', ['-w', '5', '-S']),
  });
}

export function resolveAgentZeroProjectEgressConfig(
  context: ProjectSandboxExecutionContext,
  override?: ProjectEgressPlaneConfig,
): ProjectEgressPlaneConfig {
  const config = override || buildProjectEgressConfig({ context, provider: 'AGENT_ZERO' });
  if (config.identity.actorId !== context.userId
    || config.identity.projectId !== context.projectId
    || String(config.identity.provider || '').toUpperCase() !== 'AGENT_ZERO') {
    throw new Error('Agent Zero Project egress identity does not match the authenticated project actor');
  }
  return config;
}

export function expectedAgentZeroProxyEnvironment(
  spec: ProjectEgressPlaneSpec,
  bridgeGatewayIpv4 = '',
): Readonly<Record<string, string>> {
  const proxyUrl = `http://portal:${encodeURIComponent(spec.token)}@${spec.proxyAlias}:${spec.proxyPort}`;
  return Object.freeze({
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: bridgeGatewayIpv4,
    no_proxy: bridgeGatewayIpv4,
  });
}

export function resolveAgentZeroProjectBridgeGatewayIpv4(
  spec: ProjectEgressPlaneSpec,
  runCommand: AgentZeroProjectCommandRunner,
): string {
  const internal = parseSingleInspect<DockerNetworkInspect>(
    runCommand('docker', ['network', 'inspect', spec.internalNetworkName]),
    'Agent Zero project internal egress network',
  );
  if (internal.Name !== spec.internalNetworkName
    || internal.Driver !== 'bridge'
    || internal.Internal !== true
    || internal.EnableIPv6 === true) {
    throw new Error('Agent Zero project internal network cannot host the model bridge route');
  }
  const ipam = Array.isArray(internal.IPAM?.Config) ? internal.IPAM!.Config! : [];
  if (ipam.length !== 1) throw new Error('Agent Zero project internal network IPAM is ambiguous');
  return requireIpv4(ipam[0]?.Gateway, 'Agent Zero model bridge gateway');
}

export function resolveAgentZeroProjectRuntimeIpv4(
  spec: ProjectEgressPlaneSpec,
  runtimeContainerName: string,
  runCommand: AgentZeroProjectCommandRunner,
): string {
  const internal = parseSingleInspect<DockerNetworkInspect>(
    runCommand('docker', ['network', 'inspect', spec.internalNetworkName]),
    'Agent Zero project internal egress network',
  );
  const publicNetwork = parseSingleInspect<DockerNetworkInspect>(
    runCommand('docker', ['network', 'inspect', spec.publicNetworkName]),
    'Agent Zero project public egress network',
  );
  attestProjectEgressNetworks(spec, internal, publicNetwork);
  if (internal.EnableIPv6 === true) {
    throw new Error('Agent Zero project internal egress network must not expose direct IPv6');
  }
  const runtimeIpv4 = deriveStaticRuntimeIpv4(internal);
  const allowedNames = new Set([
    normalizedName(spec.proxyContainerName),
    normalizedName(runtimeContainerName),
  ]);
  for (const member of Object.values(internal.Containers || {})) {
    const name = normalizedName(member.Name);
    if (!allowedNames.has(name)) {
      throw new Error('Agent Zero project internal network has a foreign member before static allocation');
    }
    const address = requireIpv4(member.IPv4Address, `Agent Zero internal member ${name}`);
    if (address === runtimeIpv4 && name !== normalizedName(runtimeContainerName)) {
      throw new Error('Agent Zero project deterministic runtime IPv4 is already occupied');
    }
  }
  return runtimeIpv4;
}

function containerAddress(
  network: DockerNetworkInspect,
  containerName: string,
  label: string,
): string {
  const matches = Object.values(network.Containers || {}).filter(
    (entry) => normalizedName(entry.Name) === normalizedName(containerName),
  );
  if (matches.length !== 1) throw new Error(`${label} network membership is ambiguous`);
  if (matches[0].IPv6Address) throw new Error(`${label} unexpectedly has direct IPv6 connectivity`);
  return requireIpv4(matches[0].IPv4Address, label);
}

export function attestAgentZeroProjectEgressPlane(input: {
  context: ProjectSandboxExecutionContext;
  runtimeContainerName: string;
  expectedRuntimeFingerprint: string;
  expectedRuntimeIpv4: string;
  egress?: ProjectEgressPlaneConfig;
  runCommand: AgentZeroProjectCommandRunner;
  requireRuntimeRunning?: boolean;
  requireRuntimeFirewall?: boolean;
}): AgentZeroProjectEgressAttestation {
  const config = resolveAgentZeroProjectEgressConfig(input.context, input.egress);
  const spec = buildProjectEgressPlaneSpec(config);
  const internal = parseSingleInspect<DockerNetworkInspect>(
    input.runCommand('docker', ['network', 'inspect', spec.internalNetworkName]),
    'Agent Zero project internal egress network',
  );
  const publicNetwork = parseSingleInspect<DockerNetworkInspect>(
    input.runCommand('docker', ['network', 'inspect', spec.publicNetworkName]),
    'Agent Zero project public egress network',
  );
  const proxy = parseSingleInspect<DockerContainerInspect>(
    input.runCommand('docker', ['container', 'inspect', spec.proxyContainerName]),
    'Agent Zero project egress proxy',
  );
  const runtime = parseSingleInspect<DockerContainerInspect>(
    input.runCommand('docker', ['container', 'inspect', input.runtimeContainerName]),
    'Agent Zero project runtime',
  );
  attestProjectEgressNetworks(spec, internal, publicNetwork);
  if (internal.EnableIPv6 === true) {
    throw new Error('Agent Zero project internal egress network must not expose direct IPv6');
  }
  const addresses = attestProjectEgressProxyContainer(spec, proxy, true);
  const requireRuntimeRunning = input.requireRuntimeRunning !== false;
  const runtimeNetworks = runtime.NetworkSettings?.Networks || {};
  const runtimeAttachment = runtimeNetworks[spec.internalNetworkName];
  const runtimeIpv4 = requireIpv4(input.expectedRuntimeIpv4, 'Agent Zero expected runtime');
  if (runtimeIpv4 !== deriveStaticRuntimeIpv4(internal)
    || !/^[a-f0-9]{64}$/i.test(input.expectedRuntimeFingerprint)
    || normalizedName(runtime.Name) !== normalizedName(input.runtimeContainerName)
    || runtime.State?.Running !== requireRuntimeRunning
    || runtime.Config?.Labels?.[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] !== input.expectedRuntimeFingerprint
    || Object.keys(runtimeNetworks).length !== 1
    || !runtimeAttachment
    || runtimeAttachment.IPAMConfig?.IPv4Address !== runtimeIpv4
    || Boolean(runtimeAttachment.IPAMConfig?.IPv6Address)
    || Boolean(runtimeAttachment.GlobalIPv6Address)
    || (requireRuntimeRunning
      ? runtimeAttachment.IPAddress !== runtimeIpv4
      : Boolean(runtimeAttachment.IPAddress) && runtimeAttachment.IPAddress !== runtimeIpv4)) {
    throw new Error('Agent Zero project runtime static network identity drifted');
  }
  attestProjectEgressNetworkMembership({
    network: internal,
    expectedNames: requireRuntimeRunning
      ? [spec.proxyContainerName, input.runtimeContainerName]
      : [spec.proxyContainerName],
    optionalNames: requireRuntimeRunning ? [] : [input.runtimeContainerName],
    role: 'internal',
  });
  attestProjectEgressNetworkMembership({
    network: publicNetwork,
    expectedNames: [spec.proxyContainerName],
    role: 'proxy-public',
  });

  const statementsByFamily = new Map<4 | 6, string>();
  if (addresses.publicIpv4) statementsByFamily.set(4, input.runCommand('iptables', ['-w', '5', '-S']));
  if (addresses.publicIpv6) statementsByFamily.set(6, input.runCommand('ip6tables', ['-w', '5', '-S']));
  for (const [family, statements] of statementsByFamily) {
    attestProjectEgressFirewallStatements({
      spec,
      family,
      proxyAddress: family === 4 ? addresses.publicIpv4! : addresses.publicIpv6!,
      dockerUserStatements: statements,
      masterStatements: statements,
      projectStatements: statements,
    });
  }
  if (!addresses.publicIpv4) {
    throw new Error('Agent Zero Project egress currently requires an IPv4 proxy route');
  }

  if (requireRuntimeRunning) {
    if (containerAddress(internal, input.runtimeContainerName, 'Agent Zero runtime') !== runtimeIpv4) {
      throw new Error('Agent Zero runtime network membership address drifted');
    }
  } else {
    const stoppedMember = Object.values(internal.Containers || {}).find(
      (entry) => normalizedName(entry.Name) === normalizedName(input.runtimeContainerName),
    );
    if (stoppedMember && requireIpv4(stoppedMember.IPv4Address, 'Agent Zero stopped runtime') !== runtimeIpv4) {
      throw new Error('Agent Zero stopped runtime network membership address drifted');
    }
  }
  const proxyIpv4 = containerAddress(internal, spec.proxyContainerName, 'Agent Zero proxy');
  const ipam = Array.isArray(internal.IPAM?.Config) ? internal.IPAM!.Config! : [];
  if (ipam.length !== 1) throw new Error('Agent Zero project internal network IPAM is ambiguous');
  const bridgeGatewayIpv4 = requireIpv4(ipam[0]?.Gateway, 'Agent Zero bridge gateway');
  if (input.requireRuntimeFirewall !== false) {
    assertAgentZeroProjectRuntimeFirewall({
      spec,
      runtimeIpv4,
      proxyIpv4,
      bridgeGatewayIpv4,
      statements: statementsByFamily.get(4)!,
    });
  }
  return {
    spec,
    policyFingerprint: spec.policyFingerprint,
    internalNetworkName: spec.internalNetworkName,
    proxyContainerName: spec.proxyContainerName,
    runtimeIpv4,
    proxyIpv4,
    bridgeGatewayIpv4,
  };
}

export const __agentZeroProjectEgressTest = {
  MASTER_FIREWALL_CHAIN,
  DOCKER_USER_CHAIN,
  runtimeChain,
  runtimeFirewallComment,
  runtimeFirewallRules,
  runtimeJump,
  deriveStaticRuntimeIpv4,
};
