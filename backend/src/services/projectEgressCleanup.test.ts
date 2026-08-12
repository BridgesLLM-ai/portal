import {
  __projectEgressPlaneTest,
  buildProjectEgressPlaneSpec,
  discoverProjectEgressPlaneResources,
  teardownExactProjectEgressPlane,
  teardownProjectEgressPlaneResources,
  type ProjectEgressCommandExecutor,
  type ProjectEgressCommandResult,
  type ProjectEgressPlaneSpec,
} from './projectEgressPlane';
import {
  createProjectAuthorizationEgressCleanupAdapter,
  createProjectEgressCleanupAdapter,
} from './projectEgressCleanupAdapter';
import {
  PROJECT_RUNTIME_CLEANUP_PROVIDERS,
  type ProjectRuntimeCleanupScope,
  type ProjectRuntimeResource,
} from './projectRuntimeCleanup';
import type { ProjectIdentityRecord } from './projectIdentity';
import { PROJECT_EGRESS_POLICY_VERSION } from './projectEgressPolicy';

const PROJECT_ID = '2be01c75-25e6-43d8-8f58-cb03c747d5a2';
const ACTOR_ID = 'actor-primary-full-id';
const UNKNOWN_ACTOR_ID = 'actor-with-no-binding';
const IMAGE = `registry.example/project-egress@sha256:${'a'.repeat(64)}`;
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789_-';

function plane(actorId = ACTOR_ID, provider = 'CODEX'): ProjectEgressPlaneSpec {
  return buildProjectEgressPlaneSpec({
    identity: { actorId, projectId: PROJECT_ID, provider },
    proxyImage: IMAGE,
    token: TOKEN,
    extraDeniedCidrs: ['203.0.114.9/32'],
  });
}

function labels(input: ProjectEgressPlaneSpec, role: 'proxy' | 'internal' | 'proxy-public') {
  return {
    [__projectEgressPlaneTest.labels.LABEL_POLICY]: PROJECT_EGRESS_POLICY_VERSION,
    [__projectEgressPlaneTest.labels.LABEL_FINGERPRINT]: input.policyFingerprint,
    [__projectEgressPlaneTest.labels.LABEL_IDENTITY]: input.identityFingerprint,
    [__projectEgressPlaneTest.labels.LABEL_ACTOR_ID]: input.identity.actorId,
    [__projectEgressPlaneTest.labels.LABEL_PROJECT_ID]: input.identity.projectId,
    [__projectEgressPlaneTest.labels.LABEL_PROVIDER]: input.identity.provider,
    [__projectEgressPlaneTest.labels.LABEL_ROLE]: role,
  };
}

interface FakeContainer {
  id: string;
  name: string;
  running: boolean;
  omitAttachments: boolean;
  attachmentsMaterialized: boolean;
  runtimeEndpointsCleared: boolean;
  attachmentDrifted: boolean;
  globalIpv6Address: string;
  configuredIpv6Address: string;
  labels: Record<string, string>;
  networks: string[];
}

interface FakeNetwork {
  id: string;
  name: string;
  internal: boolean;
  labels: Record<string, string>;
  members: string[];
}

interface FakeFirewall {
  chainName: string;
  chainDeclared: boolean;
  masterRules: string[];
  projectRules: string[];
  hostRules: string[];
}

class StatefulCleanupExecutor implements ProjectEgressCommandExecutor {
  readonly commands: Array<{ command: string; args: readonly string[] }> = [];
  readonly containers = new Map<string, FakeContainer>();
  readonly networks = new Map<string, FakeNetwork>();
  readonly firewalls = new Map<4 | 6, FakeFirewall>([
    [4, { chainName: '', chainDeclared: false, masterRules: [], projectRules: [], hostRules: [] }],
    [6, { chainName: '', chainDeclared: false, masterRules: [], projectRules: [], hostRules: [] }],
  ]);
  failNetworkRemovalOnce = false;
  proxyInspectCount = 0;
  mutateProxyIdOnInspect = 0;
  mutateProxyAttachmentOnStop = false;
  clearRuntimeEndpointsOnStop = false;
  ambiguousMissingContainer: string | null = null;

  install(input: ProjectEgressPlaneSpec): void {
    this.containers.set(input.proxyContainerName, {
      id: 'c'.repeat(64),
      name: input.proxyContainerName,
      running: true,
      omitAttachments: false,
      attachmentsMaterialized: true,
      runtimeEndpointsCleared: false,
      attachmentDrifted: false,
      globalIpv6Address: '',
      configuredIpv6Address: '',
      labels: {
        ...labels(input, 'proxy'),
        [__projectEgressPlaneTest.labels.LABEL_TOKEN_HASH]: input.tokenHash,
      },
      networks: [input.internalNetworkName, input.publicNetworkName],
    });
    this.networks.set(input.internalNetworkName, {
      id: 'd'.repeat(64),
      name: input.internalNetworkName,
      internal: true,
      labels: labels(input, 'internal'),
      members: [input.proxyContainerName],
    });
    this.networks.set(input.publicNetworkName, {
      id: 'e'.repeat(64),
      name: input.publicNetworkName,
      internal: false,
      labels: labels(input, 'proxy-public'),
      members: [input.proxyContainerName],
    });
    for (const family of [4, 6] as const) {
      const source = family === 4 ? '172.29.0.2/32' : '2001:db8:ffff::2/128';
      this.firewalls.set(family, {
        chainName: input.firewallChainName,
        chainDeclared: true,
        masterRules: [
          `-A ${__projectEgressPlaneTest.MASTER_FIREWALL_CHAIN} -s ${source} -m comment --comment ${input.firewallComment} -j ${input.firewallChainName}`,
        ],
        projectRules: __projectEgressPlaneTest.expectedFirewallRules(input, family),
        hostRules: family === 4
          ? [
              `-A P4E-HOST-V1 -s 172.30.0.0/24 -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment ${input.firewallComment} -j ACCEPT`,
              `-A P4E-HOST-V1 -s 172.30.0.0/24 -m comment --comment ${input.firewallComment} -j REJECT`,
            ]
          : [],
      });
    }
  }

  private result(stdout = '', exitCode = 0, stderr = ''): ProjectEgressCommandResult {
    return { stdout, stderr, exitCode };
  }

  private containerByReference(reference: string): FakeContainer | undefined {
    return this.containers.get(reference)
      || [...this.containers.values()].find((container) => container.id === reference);
  }

  private networkByReference(reference: string): FakeNetwork | undefined {
    return this.networks.get(reference)
      || [...this.networks.values()].find((network) => network.id === reference);
  }

  private containerInspect(container: FakeContainer) {
    return {
      Id: container.id,
      Name: `/${container.name}`,
      Config: { Labels: container.labels },
      State: { Running: container.running },
      HostConfig: { NetworkMode: container.networks.find((name) => !this.networks.get(name)?.internal) || '' },
      NetworkSettings: {
        Networks: container.omitAttachments ? {} : Object.fromEntries(container.networks.map((name) => [name, {
          NetworkID: container.attachmentsMaterialized ? this.networks.get(name)?.id || '' : '',
          EndpointID: container.attachmentsMaterialized && !container.runtimeEndpointsCleared
            ? `${container.id}-${name}`
            : '',
          IPAddress: container.attachmentsMaterialized && !container.runtimeEndpointsCleared
            ? container.attachmentDrifted
              ? '192.0.2.99'
              : this.networks.get(name)?.internal ? '172.30.0.2' : '172.29.0.2'
            : '',
          GlobalIPv6Address: container.runtimeEndpointsCleared ? '' : container.globalIpv6Address,
          IPAMConfig: this.networks.get(name)?.internal
            ? { IPv6Address: container.configuredIpv6Address }
            : { IPv4Address: '172.29.0.2', IPv6Address: container.configuredIpv6Address },
          Aliases: this.networks.get(name)?.internal ? ['portal-project-egress'] : [],
        }])),
      },
    };
  }

  private networkInspect(network: FakeNetwork) {
    return {
      Id: network.id,
      Name: network.name,
      Driver: 'bridge',
      Internal: network.internal,
      Labels: network.labels,
      Containers: Object.fromEntries(network.members.map((name, index) => [String(index), { Name: name }])),
    };
  }

  private firewallOutput(family: 4 | 6): string {
    const firewall = this.firewalls.get(family)!;
    return [
      `-N ${__projectEgressPlaneTest.MASTER_FIREWALL_CHAIN}`,
      ...firewall.masterRules,
      ...(firewall.chainDeclared ? [`-N ${firewall.chainName}`] : []),
      ...firewall.projectRules,
      ...firewall.hostRules,
    ].join('\n');
  }

  async run(command: string, args: readonly string[]): Promise<ProjectEgressCommandResult> {
    this.commands.push({ command, args: [...args] });
    if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
      const projectLabel = String(args[4] || '').split('=').slice(2).join('=');
      return this.result([...this.containers.values()]
        .filter((entry) => entry.labels[__projectEgressPlaneTest.labels.LABEL_PROJECT_ID] === projectLabel)
        .map((entry) => entry.name).join('\n'));
    }
    if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
      const projectLabel = String(args[3] || '').split('=').slice(2).join('=');
      return this.result([...this.networks.values()]
        .filter((entry) => entry.labels[__projectEgressPlaneTest.labels.LABEL_PROJECT_ID] === projectLabel)
        .map((entry) => entry.name).join('\n'));
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
      const reference = String(args[2]);
      const container = this.containerByReference(reference);
      if (!container) {
        if (this.ambiguousMissingContainer === reference) return this.result('', 1, 'permission denied');
        return this.result('', 1, `Error: No such object: ${reference}`);
      }
      this.proxyInspectCount += 1;
      if (this.mutateProxyIdOnInspect === this.proxyInspectCount) container.id = 'f'.repeat(64);
      return this.result(JSON.stringify([this.containerInspect(container)]));
    }
    if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
      const reference = String(args[2]);
      const network = this.networkByReference(reference);
      return network
        ? this.result(JSON.stringify([this.networkInspect(network)]))
        : this.result('', 1, `Error: No such network: ${reference}`);
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'stop') {
      const container = this.containerByReference(String(args.at(-1)));
      if (!container) return this.result('', 1, 'No such container');
      container.running = false;
      if (this.clearRuntimeEndpointsOnStop) container.runtimeEndpointsCleared = true;
      if (this.mutateProxyAttachmentOnStop) container.attachmentDrifted = true;
      return this.result(container.name);
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'rm') {
      const container = this.containerByReference(String(args[2]));
      if (!container || !this.containers.delete(container.name)) return this.result('', 1, 'No such container');
      for (const network of this.networks.values()) {
        network.members = network.members.filter((member) => member !== container.name);
      }
      return this.result(container.name);
    }
    if (command === 'docker' && args[0] === 'network' && args[1] === 'rm') {
      const reference = String(args[2]);
      if (this.failNetworkRemovalOnce) {
        this.failNetworkRemovalOnce = false;
        throw new Error('simulated Docker network failure');
      }
      const network = this.networkByReference(reference);
      if (!network || network.members.length > 0) throw new Error('network removal failed');
      this.networks.delete(network.name);
      return this.result(network.name);
    }
    if ((command === 'iptables' || command === 'ip6tables') && args[1] === '-S') {
      const family = command === 'iptables' ? 4 : 6;
      if (args[2] === 'P4E-HOST-V1') {
        return this.result(this.firewalls.get(family)!.hostRules.join('\n'));
      }
      return this.result(this.firewallOutput(family));
    }
    if ((command === 'iptables' || command === 'ip6tables') && args[1] === '-D') {
      const firewall = this.firewalls.get(command === 'iptables' ? 4 : 6)!;
      const rule = `-A ${args[2]} ${args.slice(3).join(' ')}`;
      const rules = args[2] === 'P4E-HOST-V1' ? firewall.hostRules : firewall.masterRules;
      const index = rules.indexOf(rule);
      if (index < 0) throw new Error('source jump missing');
      rules.splice(index, 1);
      return this.result();
    }
    if ((command === 'iptables' || command === 'ip6tables') && args[1] === '-F') {
      this.firewalls.get(command === 'iptables' ? 4 : 6)!.projectRules = [];
      return this.result();
    }
    if ((command === 'iptables' || command === 'ip6tables') && args[1] === '-X') {
      const firewall = this.firewalls.get(command === 'iptables' ? 4 : 6)!;
      if (firewall.projectRules.length > 0) throw new Error('chain is not empty');
      firewall.chainDeclared = false;
      return this.result();
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  }
}

const IDENTITY: ProjectIdentityRecord = {
  id: PROJECT_ID,
  workspaceOwnerId: 'owner-full-id',
  projectName: 'project',
  canonicalRoot: '/portal/projects/owner-full-id/project',
  rootDevice: '1',
  rootInode: '2',
  rootBirthtimeNs: '3',
  generation: 1,
  createdAt: new Date('2026-07-19T00:00:00.000Z'),
  updatedAt: new Date('2026-07-19T00:00:00.000Z'),
};

function cleanupScope(actors: readonly string[] = [ACTOR_ID]): ProjectRuntimeCleanupScope {
  return {
    authenticatedActorId: ACTOR_ID,
    workspaceOwnerId: IDENTITY.workspaceOwnerId,
    projectIdentity: IDENTITY,
    knownActorIds: [...actors],
    bindings: [],
    sessions: [],
    activeTurns: [],
  };
}

describe('Project egress discovery and teardown', () => {
  test('discovers a crash-orphan plane by exact project labels even when its actor has no binding', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane(UNKNOWN_ACTOR_ID, 'GROK_BUILD');
    executor.install(input);

    const resources = await discoverProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [{ actorId: ACTOR_ID, projectId: PROJECT_ID, provider: 'CODEX' }],
    }, executor);

    expect(resources).toHaveLength(5);
    expect(resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'PROXY_CONTAINER', actorId: UNKNOWN_ACTOR_ID, provider: 'GROK_BUILD' }),
      expect.objectContaining({ kind: 'FIREWALL_CHAIN', family: 4, identityFingerprint: input.identityFingerprint }),
      expect.objectContaining({ kind: 'FIREWALL_CHAIN', family: 6, identityFingerprint: input.identityFingerprint }),
    ]));
  });

  test('double-attests, removes proxy then firewall then networks, and verifies zero residuals', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);

    const result = await teardownProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [input.identity],
    }, executor);

    expect(result).toEqual({
      projectId: PROJECT_ID,
      discoveredResourceCount: 5,
      removedResourceCount: 5,
      alreadyAbsent: false,
    });
    const stopIndex = executor.commands.findIndex(({ args }) => args[0] === 'container' && args[1] === 'stop');
    const firewallDeleteIndex = executor.commands.findIndex(({ command, args }) => command === 'iptables' && args[1] === '-D');
    const networkRemoveIndex = executor.commands.findIndex(({ args }) => args[0] === 'network' && args[1] === 'rm');
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(firewallDeleteIndex).toBeGreaterThan(stopIndex);
    expect(networkRemoveIndex).toBeGreaterThan(firewallDeleteIndex);
    expect([...executor.firewalls.values()].every((entry) => entry.hostRules.length === 0)).toBe(true);
    await expect(discoverProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [input.identity], requireNoRuntimeMembers: true,
    }, executor)).resolves.toEqual([]);
  });

  test('is idempotent after success', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);
    await teardownProjectEgressPlaneResources(PROJECT_ID, { expectedIdentities: [input.identity] }, executor);

    await expect(teardownProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [input.identity],
    }, executor)).resolves.toMatchObject({ alreadyAbsent: true, removedResourceCount: 0 });
  });

  test('does not enumerate or remove a different immutable project with valid managed labels', async () => {
    const executor = new StatefulCleanupExecutor();
    const foreign = buildProjectEgressPlaneSpec({
      identity: {
        actorId: ACTOR_ID,
        projectId: 'b6db2efc-ad1c-4706-ad6d-558cf9d95532',
        provider: 'CODEX',
      },
      proxyImage: IMAGE,
      token: TOKEN,
    });
    executor.install(foreign);

    await expect(teardownProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [plane().identity],
    }, executor)).resolves.toMatchObject({ alreadyAbsent: true });
    expect(executor.containers.has(foreign.proxyContainerName)).toBe(true);
    expect(executor.networks.has(foreign.internalNetworkName)).toBe(true);
  });

  test('fails without destructive calls when actor/provider labels do not match the combined identity', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);
    executor.containers.get(input.proxyContainerName)!.labels[__projectEgressPlaneTest.labels.LABEL_ACTOR_ID] = 'attacker';

    await expect(teardownProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [input.identity],
    }, executor)).rejects.toMatchObject({ code: 'MANAGED_IDENTITY_LABELS' });
    expect(executor.commands.some(({ args }) => args[1] === 'stop' || args[1] === 'rm')).toBe(false);
  });

  test('rejects a deterministic-name collision whose project label was stripped', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);
    delete executor.containers.get(input.proxyContainerName)!.labels[__projectEgressPlaneTest.labels.LABEL_PROJECT_ID];

    await expect(discoverProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [input.identity],
    }, executor)).rejects.toMatchObject({ code: 'PROXY_LABEL_FILTER' });
  });

  test('does not interpret an ambiguous Docker inspect failure as absence', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.ambiguousMissingContainer = input.proxyContainerName;

    await expect(discoverProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [input.identity],
    }, executor)).rejects.toMatchObject({ code: 'DOCKER_INSPECT_FAILED' });
  });

  test('detects identity replacement between the two pre-delete attestations', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);
    executor.mutateProxyIdOnInspect = 2;

    await expect(teardownProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [input.identity],
    }, executor)).rejects.toMatchObject({ code: 'CLEANUP_ATTESTATION_RACE' });
    expect(executor.containers.has(input.proxyContainerName)).toBe(true);
  });

  test('refuses teardown while a provider runtime remains on the internal network', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);
    executor.networks.get(input.internalNetworkName)!.members.push('provider-runtime');

    await expect(teardownProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [input.identity],
    }, executor)).rejects.toMatchObject({ code: 'INTERNAL_RUNTIME_STILL_ATTACHED' });
    expect(executor.containers.has(input.proxyContainerName)).toBe(true);
  });

  test('rejects an unscoped firewall reference to the managed chain', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);
    executor.firewalls.get(4)!.masterRules.push(
      `-A ${__projectEgressPlaneTest.MASTER_FIREWALL_CHAIN} -s 172.29.0.3/32 -j ${input.firewallChainName}`,
    );

    await expect(discoverProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [input.identity],
    }, executor)).rejects.toMatchObject({ code: 'FIREWALL_UNSCOPED_REFERENCE' });
  });

  test('retries safely after proxy and firewall removal when Docker network removal failed', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);
    executor.failNetworkRemovalOnce = true;

    await expect(teardownProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [input.identity],
    }, executor)).rejects.toThrow('simulated Docker network failure');
    expect(executor.containers.size).toBe(0);
    expect(executor.networks.size).toBe(2);
    expect([...executor.firewalls.values()].every((entry) => !entry.chainDeclared)).toBe(true);

    await expect(teardownProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [input.identity],
    }, executor)).resolves.toMatchObject({ alreadyAbsent: false });
    expect(executor.networks.size).toBe(0);
  });

  test('reclaims an exact exited proxy whose declared networks lost their endpoints', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);
    executor.containers.get(input.proxyContainerName)!.running = false;
    executor.containers.get(input.proxyContainerName)!.attachmentsMaterialized = false;
    executor.networks.get(input.internalNetworkName)!.members = [];
    executor.networks.get(input.publicNetworkName)!.members = [];

    await expect(discoverProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [input.identity],
    }, executor)).rejects.toMatchObject({ code: 'INTERNAL_PROXY_MEMBERSHIP' });

    await expect(teardownExactProjectEgressPlane(input.identity, executor)).resolves.toMatchObject({
      alreadyAbsent: false,
      removedResourceCount: 5,
    });
    expect(executor.containers.size).toBe(0);
    expect(executor.networks.size).toBe(0);
  });

  test('reclaims exact stopped debris after Docker drops the attachment map entirely', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);
    const proxy = executor.containers.get(input.proxyContainerName)!;
    proxy.running = false;
    proxy.omitAttachments = true;
    executor.networks.get(input.internalNetworkName)!.members = [];
    executor.networks.get(input.publicNetworkName)!.members = [];

    await expect(discoverProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [input.identity],
    }, executor)).rejects.toMatchObject({ code: 'PROXY_NETWORK_IDENTITY' });

    await expect(teardownExactProjectEgressPlane(input.identity, executor)).resolves.toMatchObject({
      alreadyAbsent: false,
      removedResourceCount: 5,
    });
    expect(executor.containers.size).toBe(0);
    expect(executor.networks.size).toBe(0);
  });

  test('keeps a running detached proxy fail-closed without destructive calls', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);
    executor.networks.get(input.internalNetworkName)!.members = [];
    executor.networks.get(input.publicNetworkName)!.members = [];

    await expect(teardownExactProjectEgressPlane(input.identity, executor)).rejects.toMatchObject({
      code: 'INTERNAL_PROXY_MEMBERSHIP',
    });
    expect(executor.commands.some(({ args }) => args[1] === 'stop' || args[1] === 'rm')).toBe(false);
    expect(executor.containers.has(input.proxyContainerName)).toBe(true);
  });

  test('keeps a stopped proxy with materialized endpoints fail-closed when memberships are empty', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);
    executor.containers.get(input.proxyContainerName)!.running = false;
    executor.networks.get(input.internalNetworkName)!.members = [];
    executor.networks.get(input.publicNetworkName)!.members = [];

    await expect(teardownExactProjectEgressPlane(input.identity, executor)).rejects.toMatchObject({
      code: 'INTERNAL_PROXY_MEMBERSHIP',
    });
    expect(executor.commands.some(({ args }) => args[1] === 'stop' || args[1] === 'rm')).toBe(false);
    expect(executor.containers.has(input.proxyContainerName)).toBe(true);
  });

  test('does not reclaim an otherwise unmaterialized proxy with residual IPv6 endpoint state', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);
    const proxy = executor.containers.get(input.proxyContainerName)!;
    proxy.running = false;
    proxy.attachmentsMaterialized = false;
    proxy.globalIpv6Address = '2001:db8::2';
    executor.networks.get(input.internalNetworkName)!.members = [];
    executor.networks.get(input.publicNetworkName)!.members = [];

    await expect(teardownExactProjectEgressPlane(input.identity, executor)).rejects.toMatchObject({
      code: 'INTERNAL_PROXY_MEMBERSHIP',
    });
    expect(executor.commands.some(({ args }) => args[1] === 'stop' || args[1] === 'rm')).toBe(false);
  });

  test('does not remove a proxy whose attachment changes after stop', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);
    executor.mutateProxyAttachmentOnStop = true;

    await expect(teardownExactProjectEgressPlane(input.identity, executor)).rejects.toMatchObject({
      code: 'PROXY_REMOVAL_RACE',
    });
    expect(executor.commands.some(({ args }) => args[1] === 'rm')).toBe(false);
    expect(executor.containers.has(input.proxyContainerName)).toBe(true);
  });

  test('accepts Docker clearing only runtime endpoint fields during a normal stop', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);
    executor.clearRuntimeEndpointsOnStop = true;

    await expect(teardownExactProjectEgressPlane(input.identity, executor)).resolves.toMatchObject({
      alreadyAbsent: false,
      removedResourceCount: 5,
    });
    expect(executor.containers.size).toBe(0);
    expect(executor.networks.size).toBe(0);
  });

  test('does not reclaim exited proxy state while a runtime member remains', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    executor.install(input);
    executor.containers.get(input.proxyContainerName)!.running = false;
    executor.networks.get(input.internalNetworkName)!.members = ['provider-runtime'];
    executor.networks.get(input.publicNetworkName)!.members = [];

    await expect(teardownExactProjectEgressPlane(input.identity, executor)).rejects.toMatchObject({
      code: 'INTERNAL_PROXY_MEMBERSHIP',
    });
    expect(executor.commands.some(({ args }) => args[1] === 'stop' || args[1] === 'rm')).toBe(false);
  });

  test('recovers an empty deterministic firewall chain left between flush and delete', async () => {
    const executor = new StatefulCleanupExecutor();
    const input = plane();
    for (const family of [4, 6] as const) {
      executor.firewalls.set(family, {
        chainName: input.firewallChainName,
        chainDeclared: true,
        masterRules: [],
        projectRules: [],
        hostRules: [],
      });
    }

    await expect(teardownProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [input.identity],
    }, executor)).resolves.toMatchObject({ removedResourceCount: 2 });
    expect([...executor.firewalls.values()].every((entry) => !entry.chainDeclared)).toBe(true);
  });

  test('fails closed on an empty managed firewall chain with no attributable identity', async () => {
    const executor = new StatefulCleanupExecutor();
    const unknownIdentity = '9'.repeat(64);
    executor.firewalls.get(4)!.chainName = `P4E-${unknownIdentity.slice(0, 23)}`;
    executor.firewalls.get(4)!.chainDeclared = true;

    await expect(discoverProjectEgressPlaneResources(PROJECT_ID, {
      expectedIdentities: [plane().identity],
    }, executor)).rejects.toMatchObject({ code: 'FIREWALL_AMBIGUOUS_CHAIN' });
  });
});

describe('concrete Project egress cleanup adapter', () => {
  test('maps orphan resources and tears them down through the coordinator contract', async () => {
    const executor = new StatefulCleanupExecutor();
    executor.install(plane(UNKNOWN_ACTOR_ID, 'GROK_BUILD'));
    const adapter = createProjectEgressCleanupAdapter({ executor });
    const scope = cleanupScope();

    const enumerated = await adapter.enumerate(scope);
    expect(enumerated).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'EGRESS_PROXY_CONTAINER',
        actorUserId: UNKNOWN_ACTOR_ID,
        provider: 'GROK_BUILD',
        projectIdentityId: PROJECT_ID,
      }),
    ]));
    await adapter.cleanup(scope, enumerated);
    await expect(adapter.verifyClean(scope)).resolves.toEqual([]);
  });

  test('rejects resources that materialize after coordinator enumeration', async () => {
    const executor = new StatefulCleanupExecutor();
    const adapter = createProjectEgressCleanupAdapter({ executor });
    const scope = cleanupScope();
    const enumerated: readonly ProjectRuntimeResource[] = await adapter.enumerate(scope);
    expect(enumerated).toEqual([]);
    executor.install(plane());

    await expect(adapter.cleanup(scope, enumerated)).rejects.toThrow(
      'Project egress resources appeared after cleanup enumeration',
    );
    expect(executor.containers.size).toBe(1);
  });

  test('builds expected collision probes for every actor and persisted provider', async () => {
    const executor = new StatefulCleanupExecutor();
    const adapter = createProjectEgressCleanupAdapter({ executor });
    await adapter.enumerate(cleanupScope([ACTOR_ID, 'second-actor']));

    const directContainerInspects = executor.commands.filter(({ args }) => args[0] === 'container'
      && args[1] === 'inspect');
    expect(directContainerInspects).toHaveLength(2 * PROJECT_RUNTIME_CLEANUP_PROVIDERS.length);
  });

  test('authorization cleanup tears down the exact provider plane and re-attests absence', async () => {
    const executor = new StatefulCleanupExecutor();
    executor.install(plane(ACTOR_ID, 'CODEX'));
    const adapter = createProjectAuthorizationEgressCleanupAdapter({ executor });
    const scope = cleanupScope();

    const enumerated = await adapter.enumerate(scope);
    expect(enumerated).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorUserId: ACTOR_ID,
        provider: 'CODEX',
        projectIdentityId: PROJECT_ID,
      }),
    ]));
    await adapter.cleanup(scope, enumerated);
    await expect(adapter.verifyClean(scope)).resolves.toEqual([]);
  });
});
