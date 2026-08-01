import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createProjectSandboxExecutionContext } from '../agents/executionScope';
import type { AgentZeroAuthSessionManager } from '../agents/providers/agentZero/AgentZeroAuthSession';
import type { AgentZeroConnectorClient } from '../agents/providers/agentZero/AgentZeroConnectorClient';
import {
  __agentZeroProjectEgressTest,
  assertAgentZeroProjectRuntimeFirewall,
  expectedAgentZeroProxyEnvironment,
  resolveAgentZeroProjectRuntimeIpv4,
  type AgentZeroProjectCommandRunner,
} from '../agents/providers/agentZero/AgentZeroProjectEgress';
import {
  AGENT_ZERO_PROJECT_NETWORK_POLICY,
  AGENT_ZERO_PROJECT_POLICY_VERSION,
  AGENT_ZERO_PROJECT_QUALIFICATION_SCHEMA,
  AGENT_ZERO_PROJECT_QUALIFICATION_TTL_MS,
  AGENT_ZERO_PROJECT_IMAGE_COMMAND,
  AGENT_ZERO_PROJECT_ROOT,
  AGENT_ZERO_PROJECT_RUNTIME,
  AGENT_ZERO_PROJECT_RUNTIME_GID,
  AGENT_ZERO_PROJECT_RUNTIME_UID,
  attestOnlyAgentZeroProjectIdentityRuntime,
  buildAgentZeroProjectContainerCreateArgs,
  buildAgentZeroProjectLegacyRuntimeFingerprint,
  buildAgentZeroProjectRuntimeIdentity,
  buildAgentZeroProjectRuntimeFingerprint,
  buildAgentZeroProjectVolumeCreateArgs,
  convergeAgentZeroProjectSandboxRuntime,
  describeAgentZeroProjectRuntime,
  hardAbortAgentZeroProjectRuntime,
  probeAgentZeroProjectSandboxRuntime,
  qualifyAgentZeroProjectSandboxRuntime,
  type AgentZeroProjectQualification,
} from '../agents/providers/agentZero/AgentZeroProjectSandbox';
import {
  AGENT_ZERO_PROJECT_IMAGE_RECIPE_LABEL,
  AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER_LABEL,
  AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER,
  AGENT_ZERO_PROJECT_IMAGE_SOURCE_COMMIT_LABEL,
  AGENT_ZERO_PROJECT_IMAGE_UPSTREAM_DIGEST_LABEL,
  AGENT_ZERO_PROJECT_SANDBOX_IMAGE_ENV,
  AGENT_ZERO_PROJECT_SOURCE_COMMITS,
  AGENT_ZERO_PROJECT_UPSTREAM_IMAGE_DIGESTS,
  getAgentZeroProjectSandboxImageId,
  getAgentZeroProjectSourceCommit,
  getAgentZeroProjectUpstreamImageRef,
  normalizeAgentZeroProjectSandboxImageId,
} from '../agents/providers/agentZero/AgentZeroProjectImage';
import {
  AGENT_ZERO_PROJECT_MODEL_BRIDGE_POLICY_VERSION,
  AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT,
  agentZeroProjectModelBridgeApiKeyEnvironmentName,
  buildAgentZeroProjectModelBridgeBaseUrl,
  issueAgentZeroProjectModelBridgeCredential,
  type AgentZeroProjectModelSelection,
} from '../agents/providers/agentZero/AgentZeroProjectModelBridgeCredential';
import {
  AGENT_ZERO_CONTAINER_PORT,
  AGENT_ZERO_DATA_CONTAINER_PATH,
} from '../agents/providers/agentZero/AgentZeroRuntime';
import {
  PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL,
  __projectEgressPlaneTest,
  buildProjectEgressPlaneSpec,
  derivePreConfinementProjectEgressPolicyFingerprint,
  type ProjectEgressPlaneConfig,
  type ProjectEgressPlaneHandle,
} from '../services/projectEgressPlane';
import { PROJECT_EGRESS_POLICY_VERSION } from '../services/projectEgressPolicy';
import { getProjectChatProviderCapability } from '../services/projectChatKernel';

const NOW = Date.parse('2026-07-19T16:00:00.000Z');
const STARTED_AT = '2026-07-19T15:55:00.000Z';
const RUNTIME_IPV4 = '172.30.0.3';
const PROXY_INTERNAL_IPV4 = '172.30.0.2';
const PROXY_PUBLIC_IPV4 = '172.29.0.2';
const BRIDGE_GATEWAY_IPV4 = '172.30.0.1';
const PROXY_IMAGE = `sha256:${'c'.repeat(64)}`;
const PROJECT_IMAGE_ID = `sha256:${'d'.repeat(64)}`;
const PROJECT_RECIPE_SHA256 = '9'.repeat(64);
const PROXY_TOKEN = 'A'.repeat(43);
const MODEL_SELECTION: AgentZeroProjectModelSelection = {
  providerId: 'codex_oauth',
  model: 'gpt-5.2-codex',
};

let root: string;
let projectRoot: string;
let stateRoot: string;

beforeEach(() => {
  process.env[AGENT_ZERO_PROJECT_SANDBOX_IMAGE_ENV] = PROJECT_IMAGE_ID;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zero-project-sandbox-'));
  projectRoot = path.join(root, 'projects', 'owner', 'project-a');
  stateRoot = path.join(root, 'state');
  fs.mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  delete process.env[AGENT_ZERO_PROJECT_SANDBOX_IMAGE_ENV];
  delete process.env.AGENT_ZERO_PROJECT_MODEL_BRIDGE_CREDENTIAL_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function context() {
  const rootStat = fs.statSync(projectRoot, { bigint: true });
  return createProjectSandboxExecutionContext({
    userId: 'owner-user-id',
    projectId: 'immutable-project-uuid',
    workspaceOwnerId: 'owner-user-id',
    projectName: 'project-a',
    canonicalRoot: fs.realpathSync(projectRoot),
    rootDevice: rootStat.dev.toString(),
    rootInode: rootStat.ino.toString(),
    rootBirthtimeNs: rootStat.birthtimeNs.toString(),
    runtimePolicyVersion: AGENT_ZERO_PROJECT_POLICY_VERSION,
    egressPolicyVersion: PROJECT_EGRESS_POLICY_VERSION,
    runtimeImageDigest: PROJECT_IMAGE_ID,
    policyFingerprint: 'a'.repeat(64),
  });
}

function egressConfig(): ProjectEgressPlaneConfig {
  const executionContext = context();
  return {
    identity: {
      actorId: executionContext.userId,
      projectId: executionContext.projectId,
      provider: 'AGENT_ZERO',
    },
    proxyImage: PROXY_IMAGE,
    token: PROXY_TOKEN,
  };
}

function egressLabels(spec: ReturnType<typeof buildProjectEgressPlaneSpec>, role: string) {
  return {
    [__projectEgressPlaneTest.labels.LABEL_POLICY]: PROJECT_EGRESS_POLICY_VERSION,
    [__projectEgressPlaneTest.labels.LABEL_FINGERPRINT]: spec.policyFingerprint,
    [__projectEgressPlaneTest.labels.LABEL_IDENTITY]: spec.identityFingerprint,
    [__projectEgressPlaneTest.labels.LABEL_ACTOR_ID]: spec.identity.actorId,
    [__projectEgressPlaneTest.labels.LABEL_PROJECT_ID]: spec.identity.projectId,
    [__projectEgressPlaneTest.labels.LABEL_PROVIDER]: spec.identity.provider,
    [__projectEgressPlaneTest.labels.LABEL_ROLE]: role,
  };
}

function fixture() {
  const executionContext = context();
  const egress = egressConfig();
  const spec = buildProjectEgressPlaneSpec(egress);
  const descriptor = describeAgentZeroProjectRuntime(executionContext, stateRoot);
  const credentialRoot = path.join(root, 'model-bridge-credentials');
  process.env.AGENT_ZERO_PROJECT_MODEL_BRIDGE_CREDENTIAL_ROOT = credentialRoot;
  fs.mkdirSync(descriptor.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    descriptor.authFile,
    'AUTH_LOGIN=portal-project\nAUTH_PASSWORD=correct-horse-battery-staple\n',
    { mode: 0o600 },
  );
  fs.chmodSync(descriptor.authFile, 0o600);
  const runtimeIdentity = buildAgentZeroProjectRuntimeIdentity(executionContext, descriptor);
  fs.writeFileSync(descriptor.identityFile, JSON.stringify(runtimeIdentity), { mode: 0o600 });
  fs.chmodSync(descriptor.identityFile, 0o600);
  const imageRef = PROJECT_IMAGE_ID;
  const modelBridgeCredential = issueAgentZeroProjectModelBridgeCredential({
    projectKey: descriptor.key,
    actorUserId: descriptor.actorUserId,
    projectIdentityId: descriptor.projectIdentityId,
  }, MODEL_SELECTION, {
    credentialRoot,
    now: () => NOW,
    tokenFactory: () => 'T'.repeat(43),
    generationFactory: () => '22222222-2222-4222-8222-222222222222',
  });
  fs.writeFileSync(
    descriptor.modelBridgeEnvFile,
    `${agentZeroProjectModelBridgeApiKeyEnvironmentName(MODEL_SELECTION.providerId)}=${modelBridgeCredential.token}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(descriptor.modelBridgeEnvFile, 0o600);
  const runtimeFingerprint = buildAgentZeroProjectRuntimeFingerprint({
    context: executionContext,
    descriptor,
    imageRef,
    spec,
    bridgeGatewayIpv4: BRIDGE_GATEWAY_IPV4,
    runtimeIpv4: RUNTIME_IPV4,
    modelBridgeCredential,
  });
  const containerId = 'b'.repeat(64);
  const proxyId = 'c'.repeat(64);
  const internalNetworkId = 'd'.repeat(64);
  const publicNetworkId = 'e'.repeat(64);
  const proxyEnvironment = expectedAgentZeroProxyEnvironment(spec, BRIDGE_GATEWAY_IPV4);
  const derivedImageLabels = {
    [AGENT_ZERO_PROJECT_IMAGE_RECIPE_LABEL]: PROJECT_RECIPE_SHA256,
    [AGENT_ZERO_PROJECT_IMAGE_SOURCE_COMMIT_LABEL]: AGENT_ZERO_PROJECT_SOURCE_COMMITS.amd64,
    [AGENT_ZERO_PROJECT_IMAGE_UPSTREAM_DIGEST_LABEL]: AGENT_ZERO_PROJECT_UPSTREAM_IMAGE_DIGESTS.amd64,
    [AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER_LABEL]: AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER,
  };
  const image: Record<string, any> = {
    Id: imageRef,
    Os: 'linux',
    Architecture: 'amd64',
    Config: { Labels: { ...derivedImageLabels } },
  };
  const container: Record<string, any> = {
    Id: containerId,
    Image: imageRef,
    Name: `/${descriptor.containerName}`,
    State: { Running: true, StartedAt: STARTED_AT },
    Config: {
      Image: imageRef,
      User: AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER,
      Cmd: [...AGENT_ZERO_PROJECT_IMAGE_COMMAND],
      Entrypoint: [],
      WorkingDir: '/a0',
      Env: [
        'PATH=/usr/local/bin:/usr/bin:/bin',
        'AUTH_LOGIN=portal-project',
        'AUTH_PASSWORD=correct-horse-battery-staple',
        ...Object.entries(proxyEnvironment).map(([key, value]) => `${key}=${value}`),
        `${agentZeroProjectModelBridgeApiKeyEnvironmentName(MODEL_SELECTION.providerId)}=${modelBridgeCredential.token}`,
      ],
      Labels: {
        ...derivedImageLabels,
        'io.bridgesllm.managed': 'agent-zero-project',
        'io.bridgesllm.runtime': AGENT_ZERO_PROJECT_RUNTIME,
        'io.bridgesllm.policy': AGENT_ZERO_PROJECT_POLICY_VERSION,
        'io.bridgesllm.project-key': descriptor.key,
        'io.bridgesllm.project-id': descriptor.projectIdentityId,
        'io.bridgesllm.actor-id': descriptor.actorUserId,
        [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: runtimeFingerprint,
      },
    },
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      CapAdd: [],
      CapDrop: ['ALL'],
      SecurityOpt: [
        'no-new-privileges:true',
        'seccomp=/etc/bridgesllm/project-runtime/bridgesllm-project-runtime-v1.seccomp.json',
        'apparmor=bridgesllm-project-runtime-v1',
      ],
      NetworkMode: internalNetworkId,
      PidMode: '',
      IpcMode: '',
      UTSMode: '',
      UsernsMode: '',
      CgroupnsMode: '',
      Devices: [],
      DeviceRequests: [],
      DeviceCgroupRules: [],
      Links: [],
      VolumesFrom: [],
      Dns: [],
      DnsOptions: [],
      DnsSearch: [],
      ExtraHosts: [],
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
      OomKillDisable: false,
      PidsLimit: 512,
      Memory: 2 * 1024 * 1024 * 1024,
      MemorySwap: 2 * 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
      Ulimits: [
        { Name: 'nofile', Soft: 1024, Hard: 1024 },
        { Name: 'nproc', Soft: 512, Hard: 512 },
      ],
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,nodev,size=256m,mode=1777',
        '/a0/tmp': 'rw,noexec,nosuid,nodev,size=512m,mode=1777',
      },
      PortBindings: {
        [AGENT_ZERO_CONTAINER_PORT]: [{ HostIp: '127.0.0.1', HostPort: '49152' }],
      },
    },
    AppArmorProfile: 'bridgesllm-project-runtime-v1',
    NetworkSettings: {
      Networks: {
        [spec.internalNetworkName]: {
          IPAddress: RUNTIME_IPV4,
          GlobalIPv6Address: '',
          NetworkID: internalNetworkId,
          IPAMConfig: { IPv4Address: RUNTIME_IPV4, IPv6Address: '' },
        },
      },
      Ports: {
        [AGENT_ZERO_CONTAINER_PORT]: [{ HostIp: '127.0.0.1', HostPort: '49152' }],
      },
    },
    Mounts: [
      { Type: 'volume', Name: descriptor.dataVolume, Destination: AGENT_ZERO_DATA_CONTAINER_PATH, RW: true },
      {
        Type: 'bind',
        Source: descriptor.canonicalProjectRoot,
        Destination: AGENT_ZERO_PROJECT_ROOT,
        RW: true,
        Propagation: 'rprivate',
      },
    ],
  };
  const dataVolumeRoot = path.join(root, 'docker-volumes', descriptor.dataVolume, '_data');
  fs.mkdirSync(dataVolumeRoot, { recursive: true });
  fs.chownSync(dataVolumeRoot, AGENT_ZERO_PROJECT_RUNTIME_UID, AGENT_ZERO_PROJECT_RUNTIME_GID);
  const volume: Record<string, any> = {
    Name: descriptor.dataVolume,
    Driver: 'local',
    Scope: 'local',
    Options: null,
    Mountpoint: dataVolumeRoot,
    Labels: {
      'io.bridgesllm.managed': 'agent-zero-project',
      'io.bridgesllm.runtime': AGENT_ZERO_PROJECT_RUNTIME,
      'io.bridgesllm.policy': AGENT_ZERO_PROJECT_POLICY_VERSION,
      'io.bridgesllm.project-key': descriptor.key,
      'io.bridgesllm.project-id': descriptor.projectIdentityId,
      'io.bridgesllm.actor-id': descriptor.actorUserId,
      'io.bridgesllm.volume-role': 'agent-zero-project-data',
    },
  };
  const proxy: Record<string, any> = {
    Id: proxyId,
    Image: PROXY_IMAGE,
    Name: `/${spec.proxyContainerName}`,
    Config: {
      Image: spec.proxyImage,
      User: '65532:65532',
      Cmd: [...spec.proxyCommand],
      Entrypoint: [],
      WorkingDir: '/opt/bridgesllm/backend',
      Env: [
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'NODE_VERSION=22.16.0',
        'YARN_VERSION=1.22.22',
        `PROJECT_EGRESS_PROXY_TOKEN=${spec.token}`,
        `PROJECT_EGRESS_PROXY_PORT=${spec.proxyPort}`,
        `PROJECT_EGRESS_DENY_CIDRS=${JSON.stringify(spec.deniedCidrs)}`,
      ],
      Labels: {
        ...egressLabels(spec, 'proxy'),
        [__projectEgressPlaneTest.labels.LABEL_TOKEN_HASH]: spec.tokenHash,
      },
    },
    State: { Running: true },
    HostConfig: {
      ReadonlyRootfs: true,
      CapAdd: [],
      CapDrop: ['ALL'],
      SecurityOpt: [
        'no-new-privileges:true',
        'seccomp=/etc/bridgesllm/project-runtime/bridgesllm-project-runtime-v1.seccomp.json',
        'apparmor=bridgesllm-project-runtime-v1',
      ],
      Binds: null,
      Mounts: null,
      PortBindings: {},
      NetworkMode: spec.publicNetworkName,
      Privileged: false,
      PidMode: '',
      IpcMode: '',
      UTSMode: '',
      UsernsMode: '',
      CgroupnsMode: '',
      RestartPolicy: { Name: 'no' },
      PidsLimit: 128,
      Memory: 256 * 1024 * 1024,
      NanoCpus: 500_000_000,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m' },
    },
    AppArmorProfile: 'bridgesllm-project-runtime-v1',
    Mounts: [],
    NetworkSettings: {
      Networks: {
        [spec.publicNetworkName]: {
          IPAddress: PROXY_PUBLIC_IPV4,
          GlobalIPv6Address: '',
          NetworkID: publicNetworkId,
          IPAMConfig: { IPv4Address: PROXY_PUBLIC_IPV4, IPv6Address: '' },
          Aliases: [],
        },
        [spec.internalNetworkName]: {
          IPAddress: PROXY_INTERNAL_IPV4,
          NetworkID: internalNetworkId,
          Aliases: [spec.proxyAlias],
        },
      },
    },
  };
  const internalNetwork: Record<string, any> = {
    Id: internalNetworkId,
    Name: spec.internalNetworkName,
    Driver: 'bridge',
    Internal: true,
    EnableIPv6: false,
    Labels: egressLabels(spec, 'internal'),
    IPAM: { Config: [{ Subnet: '172.30.0.0/16', Gateway: BRIDGE_GATEWAY_IPV4 }] },
    Containers: {
      [containerId]: { Name: descriptor.containerName, IPv4Address: `${RUNTIME_IPV4}/16`, IPv6Address: '' },
      [proxyId]: { Name: spec.proxyContainerName, IPv4Address: `${PROXY_INTERNAL_IPV4}/16`, IPv6Address: '' },
    },
  };
  const publicNetwork: Record<string, any> = {
    Id: publicNetworkId,
    Name: spec.publicNetworkName,
    Driver: 'bridge',
    Internal: false,
    EnableIPv6: false,
    Labels: egressLabels(spec, 'proxy-public'),
    IPAM: { Config: [{ Subnet: '172.29.0.0/16', Gateway: '172.29.0.1' }] },
    Containers: {
      [proxyId]: { Name: spec.proxyContainerName, IPv4Address: `${PROXY_PUBLIC_IPV4}/16`, IPv6Address: '' },
    },
  };

  const firewallLines = [
    `-A DOCKER-USER -j ${__agentZeroProjectEgressTest.MASTER_FIREWALL_CHAIN}`,
    __agentZeroProjectEgressTest.runtimeJump({ parent: 'DOCKER-USER', spec, runtimeIpv4: RUNTIME_IPV4 }),
    __agentZeroProjectEgressTest.runtimeJump({ parent: 'INPUT', spec, runtimeIpv4: RUNTIME_IPV4 }),
    `-A ${__agentZeroProjectEgressTest.MASTER_FIREWALL_CHAIN} -s ${PROXY_PUBLIC_IPV4}/32 -m comment --comment ${spec.firewallComment} -j ${spec.firewallChainName}`,
    `-A ${__agentZeroProjectEgressTest.MASTER_FIREWALL_CHAIN} -j RETURN`,
    ...__projectEgressPlaneTest.expectedFirewallRules(spec, 4),
    ...__agentZeroProjectEgressTest.runtimeFirewallRules({
      spec,
      proxyIpv4: PROXY_INTERNAL_IPV4,
      bridgeGatewayIpv4: BRIDGE_GATEWAY_IPV4,
    }),
  ];
  const calls: Array<{ command: string; args: string[] }> = [];
  let stoppedNetworkInspectCount = 0;
  let containerExists = true;

  function insertFirewallRule(chain: string, position: number, line: string): void {
    const indices = firewallLines.map((value, index) => value.startsWith(`-A ${chain} `) ? index : -1)
      .filter((index) => index >= 0);
    const target = position <= indices.length ? indices[position - 1] : (indices.at(-1) ?? firewallLines.length - 1) + 1;
    firewallLines.splice(target, 0, line);
  }

  const runCommand: AgentZeroProjectCommandRunner = (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === 'docker' && args[0] === 'image' && args[1] === 'inspect') {
      if (args[2] === imageRef) return JSON.stringify([image]);
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
      return containerExists ? `${container.Id}\n` : '';
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
      const actualContainerName = String(container.Name || '').replace(/^\//, '');
      if ((args[2] === actualContainerName || args[2] === container.Id) && containerExists) {
        return JSON.stringify([container]);
      }
      if (args[2] === spec.proxyContainerName) return JSON.stringify([proxy]);
      throw new Error(`Error response from daemon: No such container: ${args[2]}`);
    }
    if (command === 'docker' && args[0] === 'volume' && args[1] === 'inspect') return JSON.stringify([volume]);
    if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
      if (args[2] === spec.internalNetworkName) {
        if (container.State.Running === false && !internalNetwork.Containers[container.Id]) {
          stoppedNetworkInspectCount += 1;
        }
        return JSON.stringify([internalNetwork]);
      }
      if (args[2] === spec.publicNetworkName) return JSON.stringify([publicNetwork]);
    }
    if (command === 'docker' && args[0] === 'exec') {
      return JSON.stringify({
        runtime_uid: AGENT_ZERO_PROJECT_RUNTIME_UID,
        runtime_gid: AGENT_ZERO_PROJECT_RUNTIME_GID,
        project_read: true,
        project_write: true,
        project_unlink: true,
        project_file_uid: AGENT_ZERO_PROJECT_RUNTIME_UID,
        project_file_gid: AGENT_ZERO_PROJECT_RUNTIME_GID,
        host_escape_blocked: true,
        network_escape_blocked: true,
        public_https_succeeded: true,
        bridge_gateway_blocked: true,
        model_bridge_reachable: true,
      });
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'stop') {
      if (!containerExists || (args.at(-1) !== descriptor.containerName && args.at(-1) !== container.Id)) {
        throw new Error('No such container');
      }
      container.State.Running = false;
      container.NetworkSettings.Networks[spec.internalNetworkName].IPAddress = '';
      container.NetworkSettings.Ports = { [AGENT_ZERO_CONTAINER_PORT]: null };
      delete internalNetwork.Containers[container.Id];
      return container.Id;
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'rm') {
      if (!containerExists || args[2] !== container.Id || container.State.Running) {
        throw new Error('Agent Zero test container removal was not immutable and stopped');
      }
      containerExists = false;
      delete internalNetwork.Containers[container.Id];
      return container.Id;
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'create') {
      if (containerExists) throw new Error('container name is already in use');
      const labelPrefix = `${PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL}=`;
      const runtimeFingerprintLabel = args.find((value) => value.startsWith(labelPrefix));
      const ipIndex = args.indexOf('--ip');
      const networkIndex = args.indexOf('--network');
      if (!runtimeFingerprintLabel || ipIndex < 0 || networkIndex < 0) {
        throw new Error('static runtime create args missing');
      }
      const securityOptions = args.flatMap((value, index) => (
        value === '--security-opt' ? [String(args[index + 1])] : []
      ));
      const appArmorOption = securityOptions.find((value) => value.startsWith('apparmor='));
      container.HostConfig.SecurityOpt = securityOptions;
      container.AppArmorProfile = appArmorOption?.slice('apparmor='.length) || '';
      container.HostConfig.NetworkMode = args[networkIndex + 1];
      container.Id = 'a'.repeat(64);
      container.State.Running = false;
      container.State.StartedAt = '0001-01-01T00:00:00Z';
      container.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]
        = runtimeFingerprintLabel.slice(labelPrefix.length);
      container.NetworkSettings.Networks[spec.internalNetworkName] = {
        IPAddress: '',
        GlobalIPv6Address: '',
        NetworkID: '',
        IPAMConfig: { IPv4Address: args[ipIndex + 1], IPv6Address: '' },
      };
      container.NetworkSettings.Ports = { [AGENT_ZERO_CONTAINER_PORT]: null };
      containerExists = true;
      return container.Id;
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'start') {
      if (!containerExists || (args[2] !== descriptor.containerName && args[2] !== container.Id)) {
        throw new Error('No such container');
      }
      container.State.Running = true;
      container.State.StartedAt = '2026-07-19T16:01:00.000Z';
      container.NetworkSettings.Networks[spec.internalNetworkName].IPAddress = RUNTIME_IPV4;
      container.NetworkSettings.Networks[spec.internalNetworkName].NetworkID = internalNetworkId;
      container.NetworkSettings.Ports = {
        [AGENT_ZERO_CONTAINER_PORT]: [{ HostIp: '127.0.0.1', HostPort: '49152' }],
      };
      internalNetwork.Containers[container.Id] = {
        Name: descriptor.containerName,
        IPv4Address: `${RUNTIME_IPV4}/16`,
        IPv6Address: '',
      };
      return descriptor.containerName;
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'restart') {
      if (!containerExists || (args.at(-1) !== descriptor.containerName && args.at(-1) !== container.Id)) {
        throw new Error('No such container');
      }
      container.State.Running = true;
      container.State.StartedAt = '2026-07-19T16:02:00.000Z';
      container.NetworkSettings.Ports = {
        [AGENT_ZERO_CONTAINER_PORT]: [{ HostIp: '127.0.0.1', HostPort: '49152' }],
      };
      return descriptor.containerName;
    }
    if (command === 'iptables') {
      if (args[2] === '-S') return firewallLines.join('\n');
      if (args[2] === '-N') {
        const declaration = `-N ${args[3]}`;
        if (firewallLines.includes(declaration)) throw new Error('chain exists');
        firewallLines.unshift(declaration);
        return '';
      }
      if (args[2] === '-F') {
        const chain = args[3];
        for (let index = firewallLines.length - 1; index >= 0; index -= 1) {
          if (firewallLines[index].startsWith(`-A ${chain} `)) firewallLines.splice(index, 1);
        }
        return '';
      }
      if (args[2] === '-A') {
        firewallLines.push(`-A ${args[3]} ${args.slice(4).join(' ')}`);
        return '';
      }
      if (args[2] === '-D') {
        const target = `-A ${args[3]} ${args.slice(4).join(' ')}`;
        const index = firewallLines.indexOf(target);
        if (index < 0) throw new Error('rule missing');
        firewallLines.splice(index, 1);
        return '';
      }
      if (args[2] === '-I') {
        const chain = args[3];
        const position = Number(args[4]);
        insertFirewallRule(chain, position, `-A ${chain} ${args.slice(5).join(' ')}`);
        return '';
      }
    }
    throw new Error(`Unexpected command ${command} ${args.join(' ')}`);
  };
  return {
    executionContext,
    egress,
    spec,
    descriptor,
    credentialRoot,
    modelBridgeCredential,
    imageRef,
    image,
    runtimeFingerprint,
    containerId,
    container,
    volume,
    proxy,
    internalNetwork,
    internalNetworkId,
    publicNetwork,
    publicNetworkId,
    firewallLines,
    runCommand,
    calls,
    get stoppedNetworkInspectCount() {
      return stoppedNetworkInspectCount;
    },
  };
}

function qualification(input: ReturnType<typeof fixture>): AgentZeroProjectQualification {
  return {
    schema: AGENT_ZERO_PROJECT_QUALIFICATION_SCHEMA,
    policyVersion: AGENT_ZERO_PROJECT_POLICY_VERSION,
    networkPolicy: AGENT_ZERO_PROJECT_NETWORK_POLICY,
    runtime: AGENT_ZERO_PROJECT_RUNTIME,
    projectKey: input.descriptor.key,
    actorUserId: input.descriptor.actorUserId,
    projectIdentityId: input.descriptor.projectIdentityId,
    identityFingerprint: buildAgentZeroProjectRuntimeIdentity(
      input.executionContext,
      input.descriptor,
    ).identityFingerprint,
    policyFingerprint: input.executionContext.policyFingerprint,
    egressPolicyFingerprint: input.spec.policyFingerprint,
    runtimeFingerprint: input.runtimeFingerprint,
    containerId: input.containerId,
    containerStartedAt: input.container.State.StartedAt,
    imageRef: input.imageRef,
    dataVolumeMountpoint: input.volume.Mountpoint,
    protocol: 'a0-connector.v1',
    connectorVersion: '0.1.0',
    agentZeroVersion: '2.5',
    modelBridgePolicyVersion: AGENT_ZERO_PROJECT_MODEL_BRIDGE_POLICY_VERSION,
    modelBridgePort: AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT,
    modelBridgeGatewayIpv4: BRIDGE_GATEWAY_IPV4,
    runtimeIpv4: RUNTIME_IPV4,
    modelBridgeCredentialHash: input.modelBridgeCredential.record.tokenHash,
    modelBridgeCredentialGeneration: input.modelBridgeCredential.record.generation,
    oauthProviderId: MODEL_SELECTION.providerId,
    model: MODEL_SELECTION.model,
    modelPresetName: `BridgesLLM Project OAuth ${input.descriptor.key.slice(0, 16)}`,
    connectorAuthenticated: true,
    hostGatewayDisconnected: true,
    runtimeUid: AGENT_ZERO_PROJECT_RUNTIME_UID,
    runtimeGid: AGENT_ZERO_PROJECT_RUNTIME_GID,
    projectWriteProbe: true,
    projectReadProbe: true,
    projectUnlinkProbe: true,
    hostEscapeProbe: true,
    networkEscapeProbe: true,
    publicHttpsProbe: true,
    bridgeGatewayProbe: true,
    modelBridgeReachabilityProbe: true,
    websocketReplayProbe: true,
    modelRoundTripProbe: true,
    qualifiedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + AGENT_ZERO_PROJECT_QUALIFICATION_TTL_MS).toISOString(),
  };
}

function writeQualification(input: ReturnType<typeof fixture>): void {
  fs.writeFileSync(input.descriptor.qualificationFile, JSON.stringify(qualification(input)), { mode: 0o600 });
  fs.chmodSync(input.descriptor.qualificationFile, 0o600);
}

function exactEgressHandle(input: ReturnType<typeof fixture>): ProjectEgressPlaneHandle {
  const proxyEnvironment = expectedAgentZeroProxyEnvironment(input.spec);
  return {
    policyVersion: PROJECT_EGRESS_POLICY_VERSION,
    policyFingerprint: input.spec.policyFingerprint,
    internalNetworkName: input.spec.internalNetworkName,
    internalNetworkId: input.internalNetworkId,
    publicNetworkName: input.spec.publicNetworkName,
    proxyContainerName: input.spec.proxyContainerName,
    proxyUrl: proxyEnvironment.HTTPS_PROXY,
    proxyEnvironment,
  };
}

function exactIdentityRuntimeAttestationInput(input: ReturnType<typeof fixture>) {
  return {
    context: input.executionContext,
    descriptor: input.descriptor,
    expectedContainerId: input.containerId,
    expectedContainerStartedAt: input.container.State.StartedAt,
    imageRef: input.imageRef,
    spec: input.spec,
    expectedRuntimeFingerprint: input.runtimeFingerprint,
    bridgeGatewayIpv4: BRIDGE_GATEWAY_IPV4,
    runtimeIpv4: RUNTIME_IPV4,
    expectedInternalNetworkId: input.internalNetworkId,
    modelSelection: MODEL_SELECTION,
  };
}

function recognizedInternalNetworkBinding(input: ReturnType<typeof fixture>) {
  return jest.fn(async () => {
    const labels = input.internalNetwork.Labels || {};
    if (labels[__projectEgressPlaneTest.labels.LABEL_IDENTITY] !== input.spec.identityFingerprint
      || labels[__projectEgressPlaneTest.labels.LABEL_ACTOR_ID] !== input.spec.identity.actorId
      || labels[__projectEgressPlaneTest.labels.LABEL_PROJECT_ID] !== input.spec.identity.projectId
      || labels[__projectEgressPlaneTest.labels.LABEL_PROVIDER] !== input.spec.identity.provider
      || labels[__projectEgressPlaneTest.labels.LABEL_ROLE] !== 'internal') {
      throw new Error('Agent Zero test egress network identity inventory is invalid');
    }
    if (labels[__projectEgressPlaneTest.labels.LABEL_FINGERPRINT] === input.spec.policyFingerprint) {
      return { networkId: input.internalNetworkId, generation: 'CURRENT' as const };
    }
    if (labels[__projectEgressPlaneTest.labels.LABEL_FINGERPRINT]
      === derivePreConfinementProjectEgressPolicyFingerprint(input.spec)) {
      return { networkId: input.internalNetworkId, generation: 'LEGACY_PRE_CONFINEMENT' as const };
    }
    return null;
  });
}

function buildExactLegacyPreConfinementStaticRuntimeFingerprint(
  input: ReturnType<typeof fixture>,
): string {
  const predecessorSpec = {
    ...input.spec,
    policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(input.spec),
  };
  const identity = buildAgentZeroProjectRuntimeIdentity(input.executionContext, input.descriptor);
  const selection = {
    providerId: input.modelBridgeCredential.record.providerId,
    model: input.modelBridgeCredential.record.model,
  };
  return crypto.createHash('sha256').update(JSON.stringify({
    runtime: AGENT_ZERO_PROJECT_RUNTIME,
    runtimePolicy: AGENT_ZERO_PROJECT_POLICY_VERSION,
    egressPolicy: PROJECT_EGRESS_POLICY_VERSION,
    egressPolicyFingerprint: predecessorSpec.policyFingerprint,
    actorId: input.executionContext.userId,
    projectId: input.executionContext.projectId,
    projectKey: input.descriptor.key,
    identityFingerprint: identity.identityFingerprint,
    projectRoot: input.descriptor.canonicalProjectRoot,
    rootDevice: input.executionContext.rootDevice,
    rootInode: input.executionContext.rootInode,
    rootBirthtimeNs: input.executionContext.rootBirthtimeNs,
    imageRef: input.imageRef,
    runtimeIpv4: RUNTIME_IPV4,
    modelBridge: {
      policyVersion: AGENT_ZERO_PROJECT_MODEL_BRIDGE_POLICY_VERSION,
      gatewayIpv4: BRIDGE_GATEWAY_IPV4,
      port: AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT,
      providerId: selection.providerId,
      model: selection.model,
      credentialHash: input.modelBridgeCredential.record.tokenHash,
      credentialGeneration: input.modelBridgeCredential.record.generation,
      baseUrl: buildAgentZeroProjectModelBridgeBaseUrl(
        BRIDGE_GATEWAY_IPV4,
        selection.providerId,
      ),
    },
    mounts: [
      `${input.descriptor.dataVolume}:${AGENT_ZERO_DATA_CONTAINER_PATH}:rw`,
      `${input.descriptor.canonicalProjectRoot}:${AGENT_ZERO_PROJECT_ROOT}:rw`,
    ],
    authEnvironmentFile: input.descriptor.authFile,
    network: predecessorSpec.internalNetworkName,
    proxyEnvironment: expectedAgentZeroProxyEnvironment(
      predecessorSpec,
      BRIDGE_GATEWAY_IPV4,
    ),
    modelBridgeEnvironmentFile: input.descriptor.modelBridgeEnvFile,
    hostPort: `127.0.0.1:${AGENT_ZERO_CONTAINER_PORT}`,
  })).digest('hex');
}

function installExactLegacyPreConfinementRuntime(input: ReturnType<typeof fixture>): void {
  const predecessorSpec = {
    ...input.spec,
    policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(input.spec),
  };
  input.container.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]
    = buildExactLegacyPreConfinementStaticRuntimeFingerprint(input);
  input.container.HostConfig.SecurityOpt = ['no-new-privileges:true'];
  input.container.AppArmorProfile = 'docker-default';
  input.container.HostConfig.NetworkMode = input.spec.internalNetworkName;
  input.internalNetwork.Labels = egressLabels(predecessorSpec, 'internal');
  input.publicNetwork.Labels = egressLabels(predecessorSpec, 'proxy-public');
}

function installExactSharedV1CurrentNameModeRuntime(
  input: ReturnType<typeof fixture>,
  options: {
    stopped?: boolean;
    blankNetworkId?: boolean;
  } = {},
): void {
  input.container.HostConfig.NetworkMode = input.spec.internalNetworkName;
  if (options.stopped) {
    input.container.State.Running = false;
    input.container.NetworkSettings.Networks[input.spec.internalNetworkName].IPAddress = '';
    input.container.NetworkSettings.Ports = { [AGENT_ZERO_CONTAINER_PORT]: null };
    delete input.internalNetwork.Containers[input.containerId];
  }
  if (options.blankNetworkId) {
    input.container.NetworkSettings.Networks[input.spec.internalNetworkName].NetworkID = '';
  }
}

function qualificationClient(overrides: {
  features?: string[];
  replay?: boolean;
  model?: boolean;
  gateway?: unknown;
} = {}) {
  let streamCount = 0;
  const features = overrides.features || [
    'chat_create',
    'chat_delete',
    'message_send',
    'launcher_gateway',
    'model_presets',
    'model_switcher',
  ];
  return {
    getCapabilities: jest.fn(async () => ({
      protocol: 'a0-connector.v1',
      connectorVersion: '0.1.0',
      agentZeroVersion: '2.5',
      auth: ['session'],
      authRequired: true,
      transports: ['http', 'websocket'],
      websocketNamespace: '/ws',
      websocketHandlers: ['plugins/_a0_connector/ws_connector'],
      features,
    })),
    call: jest.fn(async (operation: string, payload: Record<string, any> = {}) => {
      if (operation === 'chat_create') return { context_id: 'A0QualificationContext' };
      if (operation === 'model_presets' && payload.action === 'save') {
        return { ok: true, presets: payload.presets };
      }
      if (operation === 'model_presets' && payload.action === 'resolve') {
        const baseUrl = buildAgentZeroProjectModelBridgeBaseUrl(
          BRIDGE_GATEWAY_IPV4,
          MODEL_SELECTION.providerId,
        );
        return {
          ok: true,
          preset: {
            name: payload.name,
            chat: { ...MODEL_SELECTION, provider: MODEL_SELECTION.providerId, name: MODEL_SELECTION.model, api_base: baseUrl },
            utility: { ...MODEL_SELECTION, provider: MODEL_SELECTION.providerId, name: MODEL_SELECTION.model, api_base: baseUrl },
          },
        };
      }
      if (operation === 'model_switcher' && payload.action === 'set_preset') {
        return {
          ok: true,
          allowed: true,
          effective_preset: payload.preset_name,
          main_model: { provider: MODEL_SELECTION.providerId, name: MODEL_SELECTION.model },
          utility_model: { provider: MODEL_SELECTION.providerId, name: MODEL_SELECTION.model },
        };
      }
      if (operation === 'launcher_gateway_status') {
        return overrides.gateway || {
          state: 'stopped',
          connected: false,
          multiple_hosts: false,
          gateway: null,
          gateways: [],
        };
      }
      if (operation === 'chat_delete') return { ok: true };
      throw new Error(`Unexpected connector operation ${operation}`);
    }),
    streamMessage: jest.fn(async (request: any) => {
      streamCount += 1;
      const token = String(request.message).match(/P4A0-[a-f0-9]+/)?.[0] || '';
      if (streamCount === 2 && overrides.replay !== false) request.onTransportStatus?.('replayed');
      return {
        contextId: request.contextId,
        status: 'completed',
        response: overrides.model === false ? 'wrong response' : token,
        lastSequence: streamCount * 2,
        reconnects: 0,
        eventsProcessed: 1,
      };
    }),
  };
}

function authenticatedSession() {
  return {
    probe: jest.fn(async () => ({ authenticated: true, state: 'authenticated', reason: 'ready' })),
  } as unknown as AgentZeroAuthSessionManager;
}

describe('Agent Zero Project Sandbox controlled-egress v2', () => {
  test('pins both upstream architectures to the same audited v2.5 source commit', () => {
    expect(AGENT_ZERO_PROJECT_UPSTREAM_IMAGE_DIGESTS).toEqual({
      amd64: 'sha256:9b48534c1279fb831513b8c970e2d9004e7a2a6708a4d53a91a76d24a4f9f7eb',
      arm64: 'sha256:da107b689828124369d83f017b9664493c0699c60e57809fbd32f647078de49c',
    });
    expect(AGENT_ZERO_PROJECT_SOURCE_COMMITS).toEqual({
      amd64: 'd1d48bc9c0e6e253e87c354ce757c518820c6e25',
      arm64: 'd1d48bc9c0e6e253e87c354ce757c518820c6e25',
    });
    expect(getAgentZeroProjectUpstreamImageRef('amd64')).toContain('@sha256:9b48534');
    expect(getAgentZeroProjectSourceCommit('aarch64')).toBe(AGENT_ZERO_PROJECT_SOURCE_COMMITS.arm64);
    expect(getAgentZeroProjectUpstreamImageRef('riscv64')).toBeNull();
    expect(normalizeAgentZeroProjectSandboxImageId(PROJECT_IMAGE_ID)).toBe(PROJECT_IMAGE_ID);
    expect(normalizeAgentZeroProjectSandboxImageId(
      AGENT_ZERO_PROJECT_UPSTREAM_IMAGE_DIGESTS.amd64,
    )).toBeNull();
    expect(getAgentZeroProjectSandboxImageId(undefined, {
      [AGENT_ZERO_PROJECT_SANDBOX_IMAGE_ENV]: PROJECT_IMAGE_ID,
    })).toBe(PROJECT_IMAGE_ID);
    expect(getAgentZeroProjectSandboxImageId('', {
      [AGENT_ZERO_PROJECT_SANDBOX_IMAGE_ENV]: PROJECT_IMAGE_ID,
    })).toBeNull();
  });

  test('derives a project-only runtime with proxy-only networking and a local managed volume', () => {
    const value = fixture();
    const containerArgs = buildAgentZeroProjectContainerCreateArgs({
      descriptor: value.descriptor,
      imageRef: value.imageRef,
      spec: value.spec,
      internalNetworkId: value.internalNetworkId,
      runtimeFingerprint: value.runtimeFingerprint,
      bridgeGatewayIpv4: BRIDGE_GATEWAY_IPV4,
      runtimeIpv4: RUNTIME_IPV4,
      modelBridgeCredential: value.modelBridgeCredential,
    });
    const volumeArgs = buildAgentZeroProjectVolumeCreateArgs(value.descriptor);

    expect(value.descriptor.containerName).toMatch(/^bridgesllm-a0p-[a-f0-9]{24}$/);
    expect(containerArgs).toEqual(expect.arrayContaining([
      '--network', value.internalNetworkId,
      '--ip', RUNTIME_IPV4,
      '--restart', 'no',
      '--user', AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER,
      '--read-only',
      '--cap-drop', 'ALL',
      '--env', `HTTPS_PROXY=${expectedAgentZeroProxyEnvironment(value.spec).HTTPS_PROXY}`,
      '--env', `NO_PROXY=${BRIDGE_GATEWAY_IPV4}`,
      '--env-file', value.descriptor.authFile,
      '--env-file', value.descriptor.modelBridgeEnvFile,
      '--label', `${PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL}=${value.runtimeFingerprint}`,
      `type=bind,source=${value.descriptor.canonicalProjectRoot},target=${AGENT_ZERO_PROJECT_ROOT},bind-propagation=rprivate`,
    ]));
    expect(containerArgs).not.toContain(`type=bind,source=${value.descriptor.authFile},target=/a0/.env,readonly`);
    expect(containerArgs.join(' ')).not.toMatch(/docker\.sock|host-gateway|--privileged|--network host|--network bridge|\/root\/.openclaw/);
    expect(volumeArgs).toEqual(expect.arrayContaining([
      '--driver', 'local',
      '--label', 'io.bridgesllm.volume-role=agent-zero-project-data',
    ]));
    expect(volumeArgs.join(' ')).not.toMatch(/type=none|device=|o=bind|nfs/);
  });

  test('read-only identity attestation binds the sole current runtime twice by immutable IDs', () => {
    const value = fixture();

    expect(() => attestOnlyAgentZeroProjectIdentityRuntime(
      exactIdentityRuntimeAttestationInput(value),
      {
        architecture: 'amd64',
        runCommand: value.runCommand,
        now: () => NOW,
      },
    )).not.toThrow();
    expect(value.calls.filter(({ command, args }) => (
      command === 'docker' && args[0] === 'container' && args[1] === 'ls'
    ))).toHaveLength(2);
    expect(value.calls.filter(({ command, args }) => (
      command === 'docker'
      && args[0] === 'container'
      && (args[1] === 'stop' || args[1] === 'rm' || args[1] === 'create')
    ))).toHaveLength(0);
  });

  test('read-only identity attestation rejects a same-ID restart generation', () => {
    const value = fixture();
    const input = exactIdentityRuntimeAttestationInput(value);
    value.container.State.StartedAt = '2026-07-19T16:03:00.000Z';

    expect(() => attestOnlyAgentZeroProjectIdentityRuntime(input, {
      architecture: 'amd64',
      runCommand: value.runCommand,
      now: () => NOW,
    })).toThrow(/runtime is not exact/i);
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(args[1])
    ))).toBe(false);
  });

  test('read-only identity attestation rejects an extra actor/project claimant', () => {
    const value = fixture();
    const duplicateId = 'f'.repeat(64);
    const duplicate = JSON.parse(JSON.stringify(value.container));
    duplicate.Id = duplicateId;
    duplicate.Name = `/${value.descriptor.containerName}-duplicate`;
    const runCommand: AgentZeroProjectCommandRunner = (command, args) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
        return `${value.containerId}\n${duplicateId}\n`;
      }
      if (command === 'docker'
        && args[0] === 'container'
        && args[1] === 'inspect'
        && args[2] === duplicateId) {
        return JSON.stringify([duplicate]);
      }
      return value.runCommand(command, args);
    };

    expect(() => attestOnlyAgentZeroProjectIdentityRuntime(
      exactIdentityRuntimeAttestationInput(value),
      { architecture: 'amd64', runCommand, now: () => NOW },
    )).toThrow(/inventory is not exact/i);
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(args[1])
    ))).toBe(false);
  });

  test('read-only identity attestation rejects a hostile deterministic-name substitution', () => {
    const value = fixture();
    const replacement = JSON.parse(JSON.stringify(value.container));
    replacement.Id = 'f'.repeat(64);
    replacement.HostConfig.Privileged = true;
    const runCommand: AgentZeroProjectCommandRunner = (command, args) => {
      if (command === 'docker'
        && args[0] === 'container'
        && args[1] === 'inspect'
        && args[2] === value.descriptor.containerName) {
        return JSON.stringify([replacement]);
      }
      return value.runCommand(command, args);
    };

    expect(() => attestOnlyAgentZeroProjectIdentityRuntime(
      exactIdentityRuntimeAttestationInput(value),
      { architecture: 'amd64', runCommand, now: () => NOW },
    )).toThrow(/runtime is not exact/i);
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(args[1])
    ))).toBe(false);
  });

  test('read-only identity attestation rejects an inventory race at its second barrier', () => {
    const value = fixture();
    const duplicateId = 'f'.repeat(64);
    const duplicate = JSON.parse(JSON.stringify(value.container));
    duplicate.Id = duplicateId;
    duplicate.Name = `/${value.descriptor.containerName}-duplicate`;
    let inventoryCount = 0;
    const runCommand: AgentZeroProjectCommandRunner = (command, args) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
        inventoryCount += 1;
        return inventoryCount === 1
          ? `${value.containerId}\n`
          : `${value.containerId}\n${duplicateId}\n`;
      }
      if (command === 'docker'
        && args[0] === 'container'
        && args[1] === 'inspect'
        && args[2] === duplicateId) {
        return JSON.stringify([duplicate]);
      }
      return value.runCommand(command, args);
    };

    expect(() => attestOnlyAgentZeroProjectIdentityRuntime(
      exactIdentityRuntimeAttestationInput(value),
      { architecture: 'amd64', runCommand, now: () => NOW },
    )).toThrow(/inventory is not exact/i);
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(args[1])
    ))).toBe(false);
  });

  test('derives the static runtime address only from the exact identity-labelled egress subnet', () => {
    const value = fixture();
    expect(resolveAgentZeroProjectRuntimeIpv4(
      value.spec,
      value.descriptor.containerName,
      value.runCommand,
    )).toBe(RUNTIME_IPV4);

    value.internalNetwork.Labels[__projectEgressPlaneTest.labels.LABEL_IDENTITY] = 'foreign';
    expect(() => resolveAgentZeroProjectRuntimeIpv4(
      value.spec,
      value.descriptor.containerName,
      value.runCommand,
    )).toThrow(/label/i);
  });

  test('is ready only when container, volume, shared plane, membership, and ordered firewall all attest', () => {
    const value = fixture();
    expect(probeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      now: () => NOW,
    })).toMatchObject({
      ready: true,
      selectable: false,
      structuralIsolation: true,
      volumeProvenance: true,
      egressPlaneReady: true,
      firewallReady: true,
      bridgeGatewayIpv4: BRIDGE_GATEWAY_IPV4,
      hostPort: 49152,
    });
  });

  test('rejects exact seccomp or AppArmor identity drift before Project selection', () => {
    const wrongSeccomp = fixture();
    wrongSeccomp.container.HostConfig.SecurityOpt[1] = 'seccomp=/tmp/foreign.json';
    expect(probeAgentZeroProjectSandboxRuntime(wrongSeccomp.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: wrongSeccomp.egress,
      runCommand: wrongSeccomp.runCommand,
      now: () => NOW,
    })).toMatchObject({ ready: false, structuralIsolation: false, selectable: false });

    const wrongAppArmor = fixture();
    wrongAppArmor.container.AppArmorProfile = 'docker-default';
    expect(probeAgentZeroProjectSandboxRuntime(wrongAppArmor.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: wrongAppArmor.egress,
      runCommand: wrongAppArmor.runCommand,
      now: () => NOW,
    })).toMatchObject({ ready: false, structuralIsolation: false, selectable: false });
  });

  test('rejects a dynamic or mismatched runtime address even when the live network member looks valid', () => {
    const dynamic = fixture();
    delete dynamic.container.NetworkSettings.Networks[dynamic.spec.internalNetworkName].IPAMConfig;
    expect(probeAgentZeroProjectSandboxRuntime(dynamic.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: dynamic.egress,
      runCommand: dynamic.runCommand,
    })).toMatchObject({ ready: false, structuralIsolation: false });

    const mismatched = fixture();
    mismatched.container.NetworkSettings.Networks[mismatched.spec.internalNetworkName]
      .IPAMConfig.IPv4Address = '172.30.0.4';
    expect(probeAgentZeroProjectSandboxRuntime(mismatched.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: mismatched.egress,
      runCommand: mismatched.runCommand,
    })).toMatchObject({ ready: false, structuralIsolation: false });
  });

  test('rejects an arbitrary content-addressed image without exact derived-image labels', async () => {
    const unlabeled = fixture();
    unlabeled.image.Config.Labels = {};
    expect(probeAgentZeroProjectSandboxRuntime(unlabeled.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: unlabeled.egress,
      runCommand: unlabeled.runCommand,
    })).toMatchObject({ ready: false, structuralIsolation: false });

    const wrongUpstream = fixture();
    wrongUpstream.image.Config.Labels[AGENT_ZERO_PROJECT_IMAGE_UPSTREAM_DIGEST_LABEL]
      = AGENT_ZERO_PROJECT_UPSTREAM_IMAGE_DIGESTS.arm64;
    await expect(convergeAgentZeroProjectSandboxRuntime(wrongUpstream.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: wrongUpstream.egress,
      runCommand: wrongUpstream.runCommand,
    })).rejects.toThrow(/derived image labels/i);
    expect(wrongUpstream.calls).not.toContainEqual(expect.objectContaining({
      command: 'docker',
      args: expect.arrayContaining(['container', 'create']),
    }));
  });

  test('rejects bind-backed volume tricks and unlabeled or foreign volume provenance', () => {
    const bindBacked = fixture();
    bindBacked.volume.Options = { type: 'none', device: '/root', o: 'bind' };
    expect(probeAgentZeroProjectSandboxRuntime(bindBacked.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: bindBacked.egress,
      runCommand: bindBacked.runCommand,
    })).toMatchObject({ ready: false, volumeProvenance: false });

    const foreign = fixture();
    foreign.volume.Labels['io.bridgesllm.project-key'] = 'foreign';
    expect(probeAgentZeroProjectSandboxRuntime(foreign.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: foreign.egress,
      runCommand: foreign.runCommand,
    })).toMatchObject({ ready: false, volumeProvenance: false });

    const rootOwned = fixture();
    fs.chownSync(rootOwned.volume.Mountpoint, 0, 0);
    expect(probeAgentZeroProjectSandboxRuntime(rootOwned.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: rootOwned.egress,
      runCommand: rootOwned.runCommand,
    })).toMatchObject({ ready: false, volumeProvenance: false });
  });

  test('fails when an earlier ACCEPT can shadow the runtime proxy-only jump', () => {
    const value = fixture();
    value.firewallLines.splice(1, 0, '-A DOCKER-USER -j ACCEPT');
    expect(() => assertAgentZeroProjectRuntimeFirewall({
      spec: value.spec,
      runtimeIpv4: RUNTIME_IPV4,
      proxyIpv4: PROXY_INTERNAL_IPV4,
      bridgeGatewayIpv4: BRIDGE_GATEWAY_IPV4,
      statements: value.firewallLines.join('\n'),
    })).toThrow(/shadowed/i);
    expect(probeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
    })).toMatchObject({ ready: false, egressPlaneReady: false, firewallReady: false });
  });

  test('rejects extra runtime networks, direct-proxy bypass variables, and lateral network members', () => {
    const rootRuntimeUser = fixture();
    rootRuntimeUser.container.Config.User = '0:0';
    expect(probeAgentZeroProjectSandboxRuntime(rootRuntimeUser.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: rootRuntimeUser.egress,
      runCommand: rootRuntimeUser.runCommand,
    })).toMatchObject({ ready: false, structuralIsolation: false });

    const extraNetwork = fixture();
    extraNetwork.container.NetworkSettings.Networks.bridge = { IPAddress: '172.17.0.9' };
    expect(probeAgentZeroProjectSandboxRuntime(extraNetwork.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: extraNetwork.egress,
      runCommand: extraNetwork.runCommand,
    })).toMatchObject({ ready: false, structuralIsolation: false });

    const proxyBypass = fixture();
    proxyBypass.container.Config.Env.push('NO_PROXY=127.0.0.1,169.254.169.254');
    expect(probeAgentZeroProjectSandboxRuntime(proxyBypass.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: proxyBypass.egress,
      runCommand: proxyBypass.runCommand,
    })).toMatchObject({ ready: false, structuralIsolation: false });

    const lateral = fixture();
    lateral.internalNetwork.Containers['f'.repeat(64)] = {
      Name: 'foreign-container',
      IPv4Address: '172.30.0.9/16',
      IPv6Address: '',
    };
    expect(probeAgentZeroProjectSandboxRuntime(lateral.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: lateral.egress,
      runCommand: lateral.runCommand,
    })).toMatchObject({ ready: false, egressPlaneReady: false });

    const publishedToAllInterfaces = fixture();
    publishedToAllInterfaces.container.NetworkSettings.Ports[AGENT_ZERO_CONTAINER_PORT][0].HostIp = '0.0.0.0';
    expect(probeAgentZeroProjectSandboxRuntime(publishedToAllInterfaces.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: publishedToAllInterfaces.egress,
      runCommand: publishedToAllInterfaces.runCommand,
    })).toMatchObject({ ready: false, structuralIsolation: false });
  });

  test('accepts only a protected current qualification bound to start time, volume, runtime, and egress', () => {
    const value = fixture();
    writeQualification(value);
    expect(probeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      now: () => NOW + 1_000,
    })).toMatchObject({ ready: true, selectable: true, qualificationCurrent: true });

    const wrongAddress = { ...qualification(value), runtimeIpv4: '172.30.0.4' };
    fs.writeFileSync(value.descriptor.qualificationFile, JSON.stringify(wrongAddress), { mode: 0o600 });
    expect(probeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      now: () => NOW + 1_000,
    })).toMatchObject({ ready: true, selectable: false, qualificationCurrent: false });
    writeQualification(value);

    value.container.State.StartedAt = '2026-07-19T16:10:00.000Z';
    expect(probeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      now: () => NOW + 1_000,
    })).toMatchObject({ ready: true, selectable: false, qualificationCurrent: false });
  });

  test('collects gateway, public/private network, replay, and model evidence itself', async () => {
    const value = fixture();
    const client = qualificationClient();
    await expect(qualifyAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      now: () => NOW,
      auth: authenticatedSession(),
      client: client as unknown as AgentZeroConnectorClient,
    })).resolves.toMatchObject({ selectable: true, qualificationCurrent: true });
    expect(client.call).toHaveBeenCalledWith('launcher_gateway_status', {});
    expect(client.call).toHaveBeenCalledWith('chat_create', { project_name: 'portal-qualification' });
    expect(client.call).toHaveBeenCalledWith('chat_delete', { context_id: 'A0QualificationContext' });
    expect(client.streamMessage).toHaveBeenCalledTimes(2);
    expect(value.calls).toContainEqual(expect.objectContaining({
      command: 'docker',
      args: expect.arrayContaining([AGENT_ZERO_PROJECT_ROOT, BRIDGE_GATEWAY_IPV4, 'https://example.com/']),
    }));
    expect(fs.statSync(value.descriptor.qualificationFile).mode & 0o077).toBe(0);
  });

  test('targets the escape probe at the immutable runtime when a same-name substitute could answer', async () => {
    const value = fixture();
    let originalTargeted = false;
    let sameNameSubstituteTargeted = false;
    const runCommand: AgentZeroProjectCommandRunner = (command, args) => {
      if (command === 'docker' && args[0] === 'exec') {
        if (args[1] === value.descriptor.containerName) {
          sameNameSubstituteTargeted = true;
          return JSON.stringify({
            runtime_uid: AGENT_ZERO_PROJECT_RUNTIME_UID,
            runtime_gid: AGENT_ZERO_PROJECT_RUNTIME_GID,
            project_read: true,
            project_write: true,
            project_unlink: true,
            project_file_uid: AGENT_ZERO_PROJECT_RUNTIME_UID,
            project_file_gid: AGENT_ZERO_PROJECT_RUNTIME_GID,
            host_escape_blocked: true,
            network_escape_blocked: true,
            public_https_succeeded: true,
            bridge_gateway_blocked: true,
            model_bridge_reachable: true,
          });
        }
        if (args[1] === value.containerId) originalTargeted = true;
      }
      return value.runCommand(command, args);
    };

    await expect(qualifyAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand,
      now: () => NOW,
      auth: authenticatedSession(),
      client: qualificationClient() as unknown as AgentZeroConnectorClient,
    })).resolves.toMatchObject({ selectable: true, qualificationCurrent: true });
    expect(originalTargeted).toBe(true);
    expect(sameNameSubstituteTargeted).toBe(false);
  });

  test('rejects an immutable runtime restart during the escape probe before writing qualification', async () => {
    const value = fixture();
    const runCommand: AgentZeroProjectCommandRunner = (command, args) => {
      const output = value.runCommand(command, args);
      if (command === 'docker'
        && args[0] === 'exec'
        && args[1] === value.containerId) {
        value.container.State.StartedAt = '2026-07-19T16:10:00.000Z';
      }
      return output;
    };

    await expect(qualifyAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand,
      now: () => NOW,
      auth: authenticatedSession(),
      client: qualificationClient() as unknown as AgentZeroConnectorClient,
    })).rejects.toThrow(/changed during its immutable escape probe/i);
    expect(fs.existsSync(value.descriptor.qualificationFile)).toBe(false);
  });

  test('binds Project write qualification to the exact numeric runtime user', async () => {
    for (const escapeResult of [
      {
        runtime_uid: 0,
        runtime_gid: 0,
        project_read: true,
        project_write: true,
        project_unlink: true,
        project_file_uid: 0,
        project_file_gid: 0,
      },
      {
        runtime_uid: AGENT_ZERO_PROJECT_RUNTIME_UID,
        runtime_gid: AGENT_ZERO_PROJECT_RUNTIME_GID,
        project_read: true,
        project_write: false,
        project_unlink: true,
        project_file_uid: AGENT_ZERO_PROJECT_RUNTIME_UID,
        project_file_gid: AGENT_ZERO_PROJECT_RUNTIME_GID,
      },
    ]) {
      const value = fixture();
      const runCommand: AgentZeroProjectCommandRunner = (command, args) => {
        if (command === 'docker' && args[0] === 'exec') {
          return JSON.stringify({
            ...escapeResult,
            host_escape_blocked: true,
            network_escape_blocked: true,
            public_https_succeeded: true,
            bridge_gateway_blocked: true,
            model_bridge_reachable: true,
          });
        }
        return value.runCommand(command, args);
      };
      await expect(qualifyAgentZeroProjectSandboxRuntime(value.executionContext, {
        stateRoot,
        architecture: 'amd64',
        egress: value.egress,
        runCommand,
        now: () => NOW,
        auth: authenticatedSession(),
        client: qualificationClient() as unknown as AgentZeroConnectorClient,
      })).rejects.toThrow(/escape probe failed closed/i);
      expect(fs.existsSync(value.descriptor.qualificationFile)).toBe(false);
    }
  });

  test('does not infer gateway disconnection and rejects missing replay or model proof', async () => {
    const missingGateway = fixture();
    await expect(qualifyAgentZeroProjectSandboxRuntime(missingGateway.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: missingGateway.egress,
      runCommand: missingGateway.runCommand,
      auth: authenticatedSession(),
      client: qualificationClient({
        features: ['chat_create', 'chat_delete', 'message_send'],
      }) as unknown as AgentZeroConnectorClient,
    })).rejects.toThrow(/mandatory launcher_gateway/i);
    expect(fs.existsSync(missingGateway.descriptor.qualificationFile)).toBe(false);

    const ambiguousGateway = fixture();
    await expect(qualifyAgentZeroProjectSandboxRuntime(ambiguousGateway.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: ambiguousGateway.egress,
      runCommand: ambiguousGateway.runCommand,
      auth: authenticatedSession(),
      client: qualificationClient({ gateway: {} }) as unknown as AgentZeroConnectorClient,
    })).rejects.toThrow(/host gateway/i);
    expect(fs.existsSync(ambiguousGateway.descriptor.qualificationFile)).toBe(false);

    const replayFailure = fixture();
    await expect(qualifyAgentZeroProjectSandboxRuntime(replayFailure.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: replayFailure.egress,
      runCommand: replayFailure.runCommand,
      auth: authenticatedSession(),
      client: qualificationClient({ replay: false }) as unknown as AgentZeroConnectorClient,
    })).rejects.toThrow(/replay qualification/i);
    expect(fs.existsSync(replayFailure.descriptor.qualificationFile)).toBe(false);

    const modelFailure = fixture();
    await expect(qualifyAgentZeroProjectSandboxRuntime(modelFailure.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: modelFailure.egress,
      runCommand: modelFailure.runCommand,
      auth: authenticatedSession(),
      client: qualificationClient({ model: false }) as unknown as AgentZeroConnectorClient,
    })).rejects.toThrow(/model round-trip/i);
    expect(fs.existsSync(modelFailure.descriptor.qualificationFile)).toBe(false);
  });

  test('attests a stopped static attachment, installs the firewall before start, and leaves Agent Zero unselectable without live evidence', async () => {
    const value = fixture();
    const handle = exactEgressHandle(value);
    const ensureEgressPlane = jest.fn(async () => handle);
    const constrainRuntime = jest.fn(async () => undefined);
    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime,
      egressExecutor: { run: jest.fn() },
    })).resolves.toMatchObject({ ready: true, selectable: false });
    expect(ensureEgressPlane).toHaveBeenCalled();
    expect(constrainRuntime).toHaveBeenCalledWith(expect.objectContaining({
      runtimeContainerName: value.descriptor.containerName,
      expectedRuntimeFingerprint: value.runtimeFingerprint,
    }));
    expect(value.stoppedNetworkInspectCount).toBeGreaterThan(0);
    const stopIndex = value.calls.findIndex(({ command, args }) => (
      command === 'docker' && args[0] === 'container' && args[1] === 'stop'
    ));
    const firewallIndex = value.calls.findIndex(({ command, args }) => (
      command === 'iptables' && args[2] === '-N'
      && String(args[3]).startsWith('A0P-')
    ));
    const startIndex = value.calls.findIndex(({ command, args }) => (
      command === 'docker' && args[0] === 'container' && args[1] === 'start'
    ));
    expect(firewallIndex).toBeGreaterThan(stopIndex);
    expect(startIndex).toBeGreaterThan(firewallIndex);

    const postStartDrift = fixture();
    const driftedRunCommand: AgentZeroProjectCommandRunner = (command, args) => {
      const output = postStartDrift.runCommand(command, args);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'start') {
        postStartDrift.container.NetworkSettings.Ports[AGENT_ZERO_CONTAINER_PORT][0].HostIp = '0.0.0.0';
      }
      return output;
    };
    await expect(convergeAgentZeroProjectSandboxRuntime(postStartDrift.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: postStartDrift.egress,
      runCommand: driftedRunCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(postStartDrift),
      ensureEgressPlane: jest.fn(async () => handle),
      constrainRuntime,
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/exact image, mount, port/i);
    expect(postStartDrift.calls).toContainEqual({
      command: 'docker',
      args: ['container', 'stop', '--time', '10', postStartDrift.containerId],
    });
  });

  test('rejects a substituted shared-handle network ID before stopping the current runtime', async () => {
    const value = fixture();
    const substitutedHandle = {
      ...exactEgressHandle(value),
      internalNetworkId: 'f'.repeat(64),
    };

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane: jest.fn(async () => substitutedHandle),
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/network identity changed after convergence/i);
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
    ))).toBe(false);
    expect(value.calls.some(({ args }) => (
      args[0] === 'volume' && args[1] === 'create'
    ))).toBe(false);
  });

  test('migrates the exact running shared-v1 current-name runtime to immutable network-ID mode idempotently', async () => {
    const value = fixture();
    installExactSharedV1CurrentNameModeRuntime(value);
    const ensureEgressPlane = jest.fn(async () => {
      expect(value.calls).toContainEqual({
        command: 'docker',
        args: ['container', 'rm', value.containerId],
      });
      return exactEgressHandle(value);
    });

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).resolves.toMatchObject({
      ready: true,
      containerId: 'a'.repeat(64),
      runtimeFingerprint: value.runtimeFingerprint,
    });

    expect(value.calls).toContainEqual({
      command: 'docker',
      args: ['container', 'stop', '--time', '10', value.containerId],
    });
    const createCall = value.calls.find(({ command, args }) => (
      command === 'docker' && args[0] === 'container' && args[1] === 'create'
    ));
    const networkIndex = createCall?.args.indexOf('--network') ?? -1;
    expect(networkIndex).toBeGreaterThanOrEqual(0);
    expect(createCall?.args[networkIndex + 1]).toBe(value.internalNetworkId);

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane: jest.fn(async () => exactEgressHandle(value)),
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).resolves.toMatchObject({ ready: true, containerId: 'a'.repeat(64) });
    expect(value.calls.filter(({ command, args }) => (
      command === 'docker' && args[0] === 'container' && args[1] === 'rm'
    ))).toHaveLength(1);
  });

  test('migrates an exact stopped shared-v1 current-name runtime with an immutable attachment ID', async () => {
    const value = fixture();
    installExactSharedV1CurrentNameModeRuntime(value, {
      stopped: true,
    });

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane: jest.fn(async () => exactEgressHandle(value)),
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).resolves.toMatchObject({
      ready: true,
      containerId: 'a'.repeat(64),
      runtimeFingerprint: value.runtimeFingerprint,
    });

    expect(value.calls).toContainEqual({
      command: 'docker',
      args: ['container', 'rm', value.containerId],
    });
    expect(value.calls).not.toContainEqual({
      command: 'docker',
      args: ['container', 'stop', '--time', '10', value.containerId],
    });
  });

  test('rejects a stopped shared-v1 current-name runtime with an unprovable blank attachment ID', async () => {
    const value = fixture();
    installExactSharedV1CurrentNameModeRuntime(value, {
      stopped: true,
      blankNetworkId: true,
    });
    const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/neither the current nor a recognized legacy/i);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
    ))).toBe(false);
  });

  test.each([
    ['an arbitrary full-ID network mode', (value: ReturnType<typeof fixture>) => {
      value.container.HostConfig.NetworkMode = 'f'.repeat(64);
    }],
    ['a wrong attachment ID', (value: ReturnType<typeof fixture>) => {
      value.container.NetworkSettings.Networks[value.spec.internalNetworkName].NetworkID
        = 'f'.repeat(64);
    }],
    ['a blank running attachment ID', (value: ReturnType<typeof fixture>) => {
      value.container.NetworkSettings.Networks[value.spec.internalNetworkName].NetworkID = '';
    }],
    ['a missing attachment ID field', (value: ReturnType<typeof fixture>) => {
      delete value.container.NetworkSettings.Networks[value.spec.internalNetworkName].NetworkID;
    }],
  ])('rejects a current-name claimant with %s without mutation', async (_label, drift) => {
    const value = fixture();
    installExactSharedV1CurrentNameModeRuntime(value);
    drift(value);
    const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/neither the current nor a recognized legacy/i);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
    ))).toBe(false);
  });

  test('rejects a partial current-name generation without mutation', async () => {
    const value = fixture();
    installExactSharedV1CurrentNameModeRuntime(value);
    value.container.HostConfig.SecurityOpt = ['no-new-privileges:true'];
    value.container.AppArmorProfile = 'docker-default';
    const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/neither the current nor a recognized legacy/i);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
    ))).toBe(false);
  });

  test('rejects a mixed identity inventory before current-name retirement mutation', async () => {
    const value = fixture();
    installExactSharedV1CurrentNameModeRuntime(value);
    const duplicateId = 'f'.repeat(64);
    const duplicate = JSON.parse(JSON.stringify(value.container));
    duplicate.Id = duplicateId;
    duplicate.Name = `/${value.descriptor.containerName}-duplicate`;
    let inventoryCount = 0;
    const racingRunner: AgentZeroProjectCommandRunner = (command, args) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
        inventoryCount += 1;
        return inventoryCount === 1
          ? `${value.containerId}\n`
          : `${duplicateId}\n${value.containerId}\n`;
      }
      if (command === 'docker'
        && args[0] === 'container'
        && args[1] === 'inspect'
        && args[2] === duplicateId) {
        return JSON.stringify([duplicate]);
      }
      return value.runCommand(command, args);
    };
    const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: racingRunner,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/inventory changed before legacy retirement/i);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
    ))).toBe(false);
  });

  test.each([
    ['LEGACY_PRE_CONFINEMENT', installExactLegacyPreConfinementRuntime],
    ['CURRENT_NAME_MODE', installExactSharedV1CurrentNameModeRuntime],
  ])('rejects %s runtime exactness drift before mutation', async (_generation, installGeneration) => {
    const driftCases: Array<[
      string,
      (value: ReturnType<typeof fixture>) => void,
    ]> = [
      ['wrong immutable image ID', (value) => {
        value.container.Image = `sha256:${'f'.repeat(64)}`;
      }],
      ['duplicate proxy environment key', (value) => {
        const [key, expected] = Object.entries(
          expectedAgentZeroProxyEnvironment(value.spec, BRIDGE_GATEWAY_IPV4),
        )[0];
        value.container.Config.Env.push(`${key}=${expected}`);
      }],
      ['duplicate authentication environment key', (value) => {
        value.container.Config.Env.push('AUTH_LOGIN=portal-project');
      }],
      ['duplicate model environment key', (value) => {
        const key = agentZeroProjectModelBridgeApiKeyEnvironmentName(
          value.modelBridgeCredential.record.providerId,
        );
        value.container.Config.Env.push(`${key}=${value.modelBridgeCredential.token}`);
      }],
    ];

    for (const [_label, drift] of driftCases) {
      const value = fixture();
      installGeneration(value);
      drift(value);
      const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));

      await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
        stateRoot,
        architecture: 'amd64',
        egress: value.egress,
        runCommand: value.runCommand,
        resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
        ensureEgressPlane,
        constrainRuntime: jest.fn(async () => undefined),
        egressExecutor: { run: jest.fn() },
      })).rejects.toThrow(/neither the current nor a recognized legacy/i);
      expect(ensureEgressPlane).not.toHaveBeenCalled();
      expect(value.calls.some(({ args }) => (
        args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
      ))).toBe(false);
    }
  });

  test('migrates the exact static-IP pre-confinement predecessor before egress replacement while preserving its state volume', async () => {
    const value = fixture();
    const predecessorSpec = {
      ...value.spec,
      policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(value.spec),
    };
    value.container.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]
      = buildExactLegacyPreConfinementStaticRuntimeFingerprint(value);
    value.container.HostConfig.SecurityOpt = ['no-new-privileges:true'];
    value.container.AppArmorProfile = 'docker-default';
    value.container.HostConfig.NetworkMode = value.spec.internalNetworkName;
    value.internalNetwork.Labels = egressLabels(predecessorSpec, 'internal');
    value.publicNetwork.Labels = egressLabels(predecessorSpec, 'proxy-public');
    const originalVolume = JSON.parse(JSON.stringify(value.volume));
    const ensureEgressPlane = jest.fn(async () => {
      expect(value.calls.some(({ command, args }) => (
        command === 'docker' && args.join(' ') === `container rm ${value.containerId}`
      ))).toBe(true);
      value.internalNetwork.Labels = egressLabels(value.spec, 'internal');
      value.publicNetwork.Labels = egressLabels(value.spec, 'proxy-public');
      return exactEgressHandle(value);
    });

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).resolves.toMatchObject({
      ready: true,
      containerId: 'a'.repeat(64),
      runtimeFingerprint: value.runtimeFingerprint,
      runtimeIpv4: RUNTIME_IPV4,
    });

    const stopIndex = value.calls.findIndex(({ command, args }) => (
      command === 'docker' && args[0] === 'container' && args[1] === 'stop'
      && args.at(-1) === value.containerId
    ));
    const removeIndex = value.calls.findIndex(({ command, args }) => (
      command === 'docker' && args.join(' ') === `container rm ${value.containerId}`
    ));
    const createIndex = value.calls.findIndex(({ command, args }) => (
      command === 'docker' && args[0] === 'container' && args[1] === 'create'
    ));
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(removeIndex).toBeGreaterThan(stopIndex);
    expect(createIndex).toBeGreaterThan(removeIndex);
    expect(value.calls.some(({ args }) => args[0] === 'volume' && args[1] === 'rm')).toBe(false);
    expect(value.volume).toEqual(originalVolume);
    expect(value.container.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]).toBe(value.runtimeFingerprint);
    expect(value.container.NetworkSettings.Networks[value.spec.internalNetworkName].IPAMConfig.IPv4Address)
      .toBe(RUNTIME_IPV4);
    const identityListing = value.calls.find(({ command, args }) => (
      command === 'docker' && args[0] === 'container' && args[1] === 'ls'
    ));
    expect(identityListing?.args).toEqual(expect.arrayContaining([
      '--filter', `label=io.bridgesllm.project-id=${value.descriptor.projectIdentityId}`,
      '--filter', `label=io.bridgesllm.actor-id=${value.descriptor.actorUserId}`,
    ]));
    expect(identityListing?.args).not.toEqual(expect.arrayContaining([
      'label=io.bridgesllm.managed=agent-zero-project',
      `label=io.bridgesllm.runtime=${AGENT_ZERO_PROJECT_RUNTIME}`,
      `label=io.bridgesllm.project-key=${value.descriptor.key}`,
      `label=io.bridgesllm.policy=${AGENT_ZERO_PROJECT_POLICY_VERSION}`,
    ]));

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane: jest.fn(async () => exactEgressHandle(value)),
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).resolves.toMatchObject({ ready: true, containerId: 'a'.repeat(64) });
    expect(value.calls.filter(({ command, args }) => (
      command === 'docker' && args[0] === 'container' && args[1] === 'rm'
    ))).toHaveLength(1);
  });

  test('retains compatibility with the exact older dynamic-address predecessor generation', async () => {
    const value = fixture();
    const predecessorSpec = {
      ...value.spec,
      policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(value.spec),
    };
    value.container.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]
      = buildAgentZeroProjectLegacyRuntimeFingerprint({
        context: value.executionContext,
        descriptor: value.descriptor,
        imageRef: value.imageRef,
        spec: value.spec,
        bridgeGatewayIpv4: BRIDGE_GATEWAY_IPV4,
        modelBridgeCredential: value.modelBridgeCredential,
      });
    value.container.HostConfig.SecurityOpt = ['no-new-privileges:true'];
    value.container.AppArmorProfile = 'docker-default';
    value.container.HostConfig.NetworkMode = value.spec.internalNetworkName;
    delete value.container.NetworkSettings.Networks[value.spec.internalNetworkName].IPAMConfig;
    value.internalNetwork.Labels = egressLabels(predecessorSpec, 'internal');
    value.publicNetwork.Labels = egressLabels(predecessorSpec, 'proxy-public');

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane: jest.fn(async () => {
        value.internalNetwork.Labels = egressLabels(value.spec, 'internal');
        value.publicNetwork.Labels = egressLabels(value.spec, 'proxy-public');
        return exactEgressHandle(value);
      }),
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).resolves.toMatchObject({
      ready: true,
      containerId: 'a'.repeat(64),
      runtimeFingerprint: value.runtimeFingerprint,
    });
    expect(value.calls).toContainEqual({
      command: 'docker',
      args: ['container', 'rm', value.containerId],
    });
  });

  test('rejects an arbitrary predecessor-looking fingerprint without mutation', async () => {
    const value = fixture();
    const predecessorSpec = {
      ...value.spec,
      policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(value.spec),
    };
    value.container.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] = '8'.repeat(64);
    value.container.HostConfig.SecurityOpt = ['no-new-privileges:true'];
    value.container.AppArmorProfile = 'docker-default';
    value.container.HostConfig.NetworkMode = value.spec.internalNetworkName;
    value.internalNetwork.Labels = egressLabels(predecessorSpec, 'internal');
    value.publicNetwork.Labels = egressLabels(predecessorSpec, 'proxy-public');
    const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/neither the current nor a recognized legacy/i);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
    ))).toBe(false);
  });

  test('discovers a markerless actor/project claimant and rejects it without mutation', async () => {
    const value = fixture();
    delete value.container.Config.Labels['io.bridgesllm.managed'];
    delete value.container.Config.Labels['io.bridgesllm.runtime'];
    delete value.container.Config.Labels['io.bridgesllm.policy'];
    delete value.container.Config.Labels['io.bridgesllm.project-key'];
    const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/neither the current nor a recognized legacy/i);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
    ))).toBe(false);
    const identityListing = value.calls.find(({ command, args }) => (
      command === 'docker' && args[0] === 'container' && args[1] === 'ls'
    ));
    expect(identityListing?.args).toEqual(expect.arrayContaining([
      `label=io.bridgesllm.project-id=${value.descriptor.projectIdentityId}`,
      `label=io.bridgesllm.actor-id=${value.descriptor.actorUserId}`,
    ]));
    expect(identityListing?.args.join(' ')).not.toMatch(
      /io\.bridgesllm\.(managed|runtime|policy|project-key)/,
    );
  });

  test('rejects a markerless same-name predecessor network before mutating its runtime', async () => {
    const value = fixture();
    const predecessorSpec = {
      ...value.spec,
      policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(value.spec),
    };
    value.container.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]
      = buildExactLegacyPreConfinementStaticRuntimeFingerprint(value);
    value.container.HostConfig.SecurityOpt = ['no-new-privileges:true'];
    value.container.AppArmorProfile = 'docker-default';
    value.container.HostConfig.NetworkMode = value.spec.internalNetworkName;
    value.internalNetwork.Labels = egressLabels(predecessorSpec, 'internal');
    value.publicNetwork.Labels = egressLabels(predecessorSpec, 'proxy-public');
    delete value.internalNetwork.Labels[__projectEgressPlaneTest.labels.LABEL_IDENTITY];
    const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/network identity inventory is invalid/i);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
    ))).toBe(false);
  });

  test('rejects an arbitrary immutable-looking predecessor network mode without mutation', async () => {
    const value = fixture();
    const predecessorSpec = {
      ...value.spec,
      policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(value.spec),
    };
    value.container.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]
      = buildExactLegacyPreConfinementStaticRuntimeFingerprint(value);
    value.container.HostConfig.SecurityOpt = ['no-new-privileges:true'];
    value.container.AppArmorProfile = 'docker-default';
    value.container.HostConfig.NetworkMode = '9'.repeat(64);
    value.internalNetwork.Labels = egressLabels(predecessorSpec, 'internal');
    value.publicNetwork.Labels = egressLabels(predecessorSpec, 'proxy-public');
    const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/neither the current nor a recognized legacy/i);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
    ))).toBe(false);
  });

  test.each([
    ['added capability', (value: ReturnType<typeof fixture>) => {
      value.container.HostConfig.CapAdd = ['SYS_ADMIN'];
    }],
    ['duplicate capability drop', (value: ReturnType<typeof fixture>) => {
      value.container.HostConfig.CapDrop = ['ALL', 'ALL'];
    }],
    ['host PID namespace', (value: ReturnType<typeof fixture>) => {
      value.container.HostConfig.PidMode = 'host';
    }],
    ['container IPC namespace', (value: ReturnType<typeof fixture>) => {
      value.container.HostConfig.IpcMode = `container:${'9'.repeat(64)}`;
    }],
    ['extra tmpfs option', (value: ReturnType<typeof fixture>) => {
      value.container.HostConfig.Tmpfs['/tmp']
        = 'rw,noexec,nosuid,nodev,size=256m,mode=1777,exec';
    }],
    ['extra tmpfs mount', (value: ReturnType<typeof fixture>) => {
      value.container.HostConfig.Tmpfs['/foreign'] = 'rw,noexec,nosuid,nodev,size=1m';
    }],
  ])('rejects current runtime drift in %s before shared egress mutation', async (_label, drift) => {
    const value = fixture();
    drift(value);
    const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/neither the current nor a recognized legacy/i);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
    ))).toBe(false);
  });

  test('fails closed without mutation when duplicate containers claim one Agent Zero project identity', async () => {
    const value = fixture();
    const duplicateId = 'f'.repeat(64);
    const duplicate = JSON.parse(JSON.stringify(value.container));
    duplicate.Id = duplicateId;
    duplicate.Name = `/${value.descriptor.containerName}-duplicate`;
    const inspectedIds: string[] = [];
    const duplicateListingRunner: AgentZeroProjectCommandRunner = (command, args) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
        return `${duplicateId}\n${value.containerId}\n`;
      }
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        if (args[2] === duplicateId) {
          inspectedIds.push(duplicateId);
          return JSON.stringify([duplicate]);
        }
        if (args[2] === value.containerId) inspectedIds.push(value.containerId);
      }
      return value.runCommand(command, args);
    };
    const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: duplicateListingRunner,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/multiple .* containers claim the same immutable identity/i);
    expect(inspectedIds).toEqual(expect.arrayContaining([value.containerId, duplicateId]));
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
    ))).toBe(false);
  });

  test('rejects a truncated identity inventory ID before inspecting or mutating a claimant', async () => {
    const value = fixture();
    const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));
    const truncatedRunner: AgentZeroProjectCommandRunner = (command, args) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
        return value.containerId.slice(0, 12);
      }
      return value.runCommand(command, args);
    };

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: truncatedRunner,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/identity inventory is invalid/i);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
    ))).toBe(false);
  });

  test('detects but never retires a renamed wrong-policy Agent Zero identity claimant', async () => {
    const value = fixture();
    const renamed = `${value.descriptor.containerName}-renamed`;
    value.container.Name = `/${renamed}`;
    value.container.Config.Labels['io.bridgesllm.policy'] = 'foreign-policy-generation';
    value.internalNetwork.Containers[value.containerId].Name = renamed;
    const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/exists outside its deterministic name/i);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
    ))).toBe(false);
    const identityListing = value.calls.find(({ command, args }) => (
      command === 'docker' && args[0] === 'container' && args[1] === 'ls'
    ));
    expect(identityListing?.args.some((value) => (
      value.startsWith('label=io.bridgesllm.policy')
    ))).toBe(false);
  });

  test('does not remove a same-name replacement after immutable predecessor stop', async () => {
    const value = fixture();
    const predecessorSpec = {
      ...value.spec,
      policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(value.spec),
    };
    value.container.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]
      = buildExactLegacyPreConfinementStaticRuntimeFingerprint(value);
    value.container.HostConfig.SecurityOpt = ['no-new-privileges:true'];
    value.container.AppArmorProfile = 'docker-default';
    value.container.HostConfig.NetworkMode = value.spec.internalNetworkName;
    value.internalNetwork.Labels = egressLabels(predecessorSpec, 'internal');
    value.publicNetwork.Labels = egressLabels(predecessorSpec, 'proxy-public');
    const replacement = JSON.parse(JSON.stringify(value.container));
    replacement.Id = 'f'.repeat(64);
    replacement.State.Running = true;
    replacement.HostConfig.Privileged = true;
    let replacementInstalled = false;
    const racingRunner: AgentZeroProjectCommandRunner = (command, args) => {
      if (replacementInstalled
        && command === 'docker'
        && args[0] === 'container'
        && args[1] === 'inspect') {
        if (args[2] === value.containerId) {
          throw new Error(`Error response from daemon: No such container: ${value.containerId}`);
        }
        if (args[2] === value.descriptor.containerName) return JSON.stringify([replacement]);
      }
      const output = value.runCommand(command, args);
      if (command === 'docker'
        && args[0] === 'container'
        && args[1] === 'stop'
        && args.at(-1) === value.containerId) {
        replacementInstalled = true;
      }
      return output;
    };
    const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: racingRunner,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/changed before retirement/i);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(value.calls).toContainEqual({
      command: 'docker',
      args: ['container', 'stop', '--time', '10', value.containerId],
    });
    expect(value.calls.some(({ args }) => args[1] === 'rm')).toBe(false);
    expect(value.calls.some(({ args }) => args.includes(replacement.Id))).toBe(false);
  });

  test('rejects an identity race that adds a current claimant before predecessor stop', async () => {
    const value = fixture();
    const currentClaimant = JSON.parse(JSON.stringify(value.container));
    currentClaimant.Id = 'f'.repeat(64);
    currentClaimant.Name = `/${value.descriptor.containerName}-current-claimant`;
    const predecessorSpec = {
      ...value.spec,
      policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(value.spec),
    };
    value.container.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]
      = buildExactLegacyPreConfinementStaticRuntimeFingerprint(value);
    value.container.HostConfig.SecurityOpt = ['no-new-privileges:true'];
    value.container.AppArmorProfile = 'docker-default';
    value.container.HostConfig.NetworkMode = value.spec.internalNetworkName;
    value.internalNetwork.Labels = egressLabels(predecessorSpec, 'internal');
    value.publicNetwork.Labels = egressLabels(predecessorSpec, 'proxy-public');
    let inventoryCount = 0;
    const racingRunner: AgentZeroProjectCommandRunner = (command, args) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
        inventoryCount += 1;
        return inventoryCount === 1
          ? `${value.containerId}\n`
          : `${currentClaimant.Id}\n${value.containerId}\n`;
      }
      if (command === 'docker'
        && args[0] === 'container'
        && args[1] === 'inspect'
        && args[2] === currentClaimant.Id) {
        return JSON.stringify([currentClaimant]);
      }
      return value.runCommand(command, args);
    };
    const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: racingRunner,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/inventory changed before legacy retirement/i);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
    ))).toBe(false);
  });

  test.each([
    ['a truncated ID', 'a'.repeat(12)],
    ['multiple IDs', `${'a'.repeat(64)}\n${'f'.repeat(64)}`],
  ])('rejects docker create stdout containing %s before inspecting or starting by name', async (_label, output) => {
    const value = fixture();
    installExactLegacyPreConfinementRuntime(value);
    const createOutputRunner: AgentZeroProjectCommandRunner = (command, args) => {
      const result = value.runCommand(command, args);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'create') {
        return output;
      }
      return result;
    };

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: createOutputRunner,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane: jest.fn(async () => {
        value.internalNetwork.Labels = egressLabels(value.spec, 'internal');
        value.publicNetwork.Labels = egressLabels(value.spec, 'proxy-public');
        return exactEgressHandle(value);
      }),
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/did not return one immutable ID/i);
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && args[1] === 'start' && args[2] === value.container.Id
    ))).toBe(false);
  });

  test('rejects docker create immutable-ID substitution before any post-create mutation', async () => {
    const value = fixture();
    installExactLegacyPreConfinementRuntime(value);
    const substitutedId = 'f'.repeat(64);
    const substitutedRunner: AgentZeroProjectCommandRunner = (command, args) => {
      const result = value.runCommand(command, args);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'create') {
        return substitutedId;
      }
      return result;
    };

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: substitutedRunner,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane: jest.fn(async () => {
        value.internalNetwork.Labels = egressLabels(value.spec, 'internal');
        value.publicNetwork.Labels = egressLabels(value.spec, 'proxy-public');
        return exactEgressHandle(value);
      }),
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/immutable identity changed before attestation/i);
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && args[1] === 'start'
    ))).toBe(false);
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && args[1] === 'stop' && args.at(-1) === substitutedId
    ))).toBe(false);
  });

  test('rejects a post-create deterministic-name substitution before constrain or start', async () => {
    const value = fixture();
    installExactLegacyPreConfinementRuntime(value);
    const constrainRuntime = jest.fn(async () => undefined);
    const nameSubstitutionRunner: AgentZeroProjectCommandRunner = (command, args) => {
      const result = value.runCommand(command, args);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'create') {
        value.container.Name = `/${value.descriptor.containerName}-substituted`;
      }
      return result;
    };

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: nameSubstitutionRunner,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane: jest.fn(async () => {
        value.internalNetwork.Labels = egressLabels(value.spec, 'internal');
        value.publicNetwork.Labels = egressLabels(value.spec, 'proxy-public');
        return exactEgressHandle(value);
      }),
      constrainRuntime,
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/immutable identity changed before attestation/i);
    expect(constrainRuntime).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => args[1] === 'start')).toBe(false);
  });

  test('rejects a post-create network-ID substitution before constrain or start', async () => {
    const value = fixture();
    installExactLegacyPreConfinementRuntime(value);
    const constrainRuntime = jest.fn(async () => undefined);
    const networkSubstitutionRunner: AgentZeroProjectCommandRunner = (command, args) => {
      const result = value.runCommand(command, args);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'create') {
        value.container.HostConfig.NetworkMode = 'f'.repeat(64);
        value.container.NetworkSettings.Networks[value.spec.internalNetworkName].NetworkID
          = 'f'.repeat(64);
      }
      return result;
    };

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: networkSubstitutionRunner,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane: jest.fn(async () => {
        value.internalNetwork.Labels = egressLabels(value.spec, 'internal');
        value.publicNetwork.Labels = egressLabels(value.spec, 'proxy-public');
        return exactEgressHandle(value);
      }),
      constrainRuntime,
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/drifted from the isolation contract/i);
    expect(constrainRuntime).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => args[1] === 'start')).toBe(false);
  });

  test('stops only the exact current runtime when final identity inventory gains a duplicate', async () => {
    const value = fixture();
    const duplicateId = 'f'.repeat(64);
    const duplicate = JSON.parse(JSON.stringify(value.container));
    duplicate.Id = duplicateId;
    duplicate.Name = `/${value.descriptor.containerName}-duplicate`;
    let identityListingCount = 0;
    const duplicateAtFinalRunner: AgentZeroProjectCommandRunner = (command, args) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
        identityListingCount += 1;
        if (identityListingCount > 3) return `${value.container.Id}\n${duplicateId}\n`;
      }
      if (command === 'docker'
        && args[0] === 'container'
        && args[1] === 'inspect'
        && args[2] === duplicateId) {
        return JSON.stringify([duplicate]);
      }
      return value.runCommand(command, args);
    };

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: duplicateAtFinalRunner,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane: jest.fn(async () => exactEgressHandle(value)),
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/identity changed after final qualification/i);
    expect(value.container.State.Running).toBe(false);
    expect(value.calls.filter(({ command, args }) => (
      command === 'docker'
      && args[0] === 'container'
      && args[1] === 'stop'
      && args.at(-1) === value.containerId
    ))).toHaveLength(2);
    expect(value.calls.some(({ args }) => args.includes(duplicateId))).toBe(false);
    expect(value.calls.some(({ args }) => args[1] === 'rm')).toBe(false);
  });

  test('does not stop or remove a foreign container occupying the deterministic Agent Zero name', async () => {
    const value = fixture();
    value.container.Config.Labels['io.bridgesllm.actor-id'] = 'foreign-actor';
    const ensureEgressPlane = jest.fn(async () => exactEgressHandle(value));

    await expect(convergeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    })).rejects.toThrow(/neither the current nor a recognized legacy/i);
    expect(ensureEgressPlane).not.toHaveBeenCalled();
    expect(value.calls.some(({ args }) => (
      args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')
    ))).toBe(false);
  });

  test('serializes concurrent Agent Zero convergence for one immutable project identity', async () => {
    const value = fixture();
    let active = 0;
    let maximum = 0;
    const ensureEgressPlane = jest.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return exactEgressHandle(value);
    });
    const options = {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      resolveInternalNetworkBinding: recognizedInternalNetworkBinding(value),
      ensureEgressPlane,
      constrainRuntime: jest.fn(async () => undefined),
      egressExecutor: { run: jest.fn() },
    };

    await expect(Promise.all([
      convergeAgentZeroProjectSandboxRuntime(value.executionContext, options),
      convergeAgentZeroProjectSandboxRuntime(value.executionContext, options),
    ])).resolves.toHaveLength(2);
    expect(maximum).toBe(1);
    expect(value.calls.some(({ args }) => args[1] === 'rm')).toBe(false);
  });

  test('hard abort reattests before and after restart and invalidates the old start-bound qualification', () => {
    const value = fixture();
    writeQualification(value);
    expect(hardAbortAgentZeroProjectRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      now: () => NOW,
    })).toBe(true);
    expect(value.calls).toContainEqual({
      command: 'docker',
      args: ['container', 'restart', '--time', '10', value.containerId],
    });
    expect(probeAgentZeroProjectSandboxRuntime(value.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: value.egress,
      runCommand: value.runCommand,
      now: () => NOW,
    })).toMatchObject({ ready: true, selectable: false, qualificationCurrent: false });

    const drift = fixture();
    drift.container.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] = 'foreign';
    expect(hardAbortAgentZeroProjectRuntime(drift.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: drift.egress,
      runCommand: drift.runCommand,
    })).toBe(false);
    expect(drift.calls.some((call) => call.args.includes('restart'))).toBe(false);

    const postRestartDrift = fixture();
    const driftedRestart: AgentZeroProjectCommandRunner = (command, args) => {
      const output = postRestartDrift.runCommand(command, args);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'restart') {
        postRestartDrift.firewallLines.splice(1, 0, '-A DOCKER-USER -j ACCEPT');
      }
      return output;
    };
    expect(hardAbortAgentZeroProjectRuntime(postRestartDrift.executionContext, {
      stateRoot,
      architecture: 'amd64',
      egress: postRestartDrift.egress,
      runCommand: driftedRestart,
    })).toBe(false);
    expect(postRestartDrift.calls).toContainEqual({
      command: 'docker',
      args: ['container', 'stop', '--time', '10', postRestartDrift.containerId],
    });
  });

  test('keeps the Project provider catalog fail-closed despite the draft runtime implementation', () => {
    expect(getProjectChatProviderCapability('AGENT_ZERO')).toMatchObject({
      selectable: false,
      executionScope: null,
      runtime: AGENT_ZERO_PROJECT_RUNTIME,
    });
  });
});
