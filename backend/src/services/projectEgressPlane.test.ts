import crypto from 'crypto';
import {
  PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL,
  PROJECT_EGRESS_PROXY_IMAGE_TAG,
  ProjectEgressAttestationError,
  attestCurrentProjectEgressPlaneByImmutableIdentity,
  attestProjectEgressFirewallStatements,
  attestProjectEgressNetworks,
  attestProjectEgressNetworkMembership,
  attestProjectEgressProxyContainer,
  attestProjectRuntimeEgressAttachment,
  buildProjectEgressPlaneSpec,
  constrainProjectRuntimeToEgressPlane,
  discoverProjectEgressHostDeniedCidrs,
  derivePreConfinementProjectEgressPolicyFingerprint,
  ensureProjectEgressPlane,
  issueProjectEgressProxyToken,
  resolvePinnedProjectEgressProxyImage,
  type ProjectEgressCommandExecutor,
  type ProjectEgressCommandResult,
  type ProjectEgressPlaneSpec,
  __projectEgressPlaneTest,
} from './projectEgressPlane';
import { PROJECT_EGRESS_POLICY_VERSION } from './projectEgressPolicy';

const IMAGE = `registry.example/bridgesllm/project-egress@sha256:${'a'.repeat(64)}`;
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789_-';

function spec(): ProjectEgressPlaneSpec {
  return buildProjectEgressPlaneSpec({
    identity: { actorId: 'user-full-uuid', projectId: 'project-full-uuid', provider: 'codex' },
    proxyImage: IMAGE,
    token: TOKEN,
    extraDeniedCidrs: ['203.0.114.7/32'],
  });
}

test('reconstructs the exact parent-generation egress fingerprint without confinement inputs', () => {
  const input = spec();
  const expected = crypto.createHash('sha256').update(JSON.stringify({
    policyVersion: PROJECT_EGRESS_POLICY_VERSION,
    identity: input.identity,
    proxyImage: input.proxyImage,
    proxyCommand: [...input.proxyCommand],
    deniedCidrs: [...input.deniedCidrs],
    ports: [80, 443],
    topology: 'runtime--internal-network--proxy--public-network',
  })).digest('hex');
  expect(derivePreConfinementProjectEgressPolicyFingerprint(input)).toBe(expected);
  expect(expected).not.toBe(input.policyFingerprint);
});

function labelsFor(input: ProjectEgressPlaneSpec, role: string): Record<string, string> {
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

function proxyInspect(input: ProjectEgressPlaneSpec, running = true): any {
  return {
    Id: 'c'.repeat(64),
    Name: `/${input.proxyContainerName}`,
    Image: `sha256:${input.proxyImage.split('sha256:').at(-1)}`,
    Config: {
      Image: input.proxyImage,
      User: '65532:65532',
      Cmd: [...input.proxyCommand],
      Entrypoint: null,
      WorkingDir: '/opt/bridgesllm/backend',
      Env: [
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'NODE_VERSION=22.16.0',
        'YARN_VERSION=1.22.22',
        `PROJECT_EGRESS_PROXY_TOKEN=${input.token}`,
        `PROJECT_EGRESS_PROXY_PORT=${input.proxyPort}`,
        `PROJECT_EGRESS_DENY_CIDRS=${JSON.stringify(input.deniedCidrs)}`,
      ],
      Labels: {
        ...labelsFor(input, 'proxy'),
        [__projectEgressPlaneTest.labels.LABEL_TOKEN_HASH]: input.tokenHash,
      },
    },
    State: { Running: running },
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
      NetworkMode: input.publicNetworkName,
      Privileged: false,
      PidMode: '',
      IpcMode: '',
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
        [input.publicNetworkName]: {
          IPAddress: '172.29.0.2',
          GlobalIPv6Address: '',
          Aliases: [],
          NetworkID: 'e'.repeat(64),
          IPAMConfig: { IPv4Address: '172.29.0.2' },
        },
        [input.internalNetworkName]: {
          IPAddress: '172.30.0.2',
          Aliases: [input.proxyAlias],
          NetworkID: 'd'.repeat(64),
        },
      },
    },
  };
}

function preConfinementSpec(input: ProjectEgressPlaneSpec): ProjectEgressPlaneSpec {
  return {
    ...input,
    policyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(input),
  };
}

function preConfinementProxyInspect(input: ProjectEgressPlaneSpec, running = true): any {
  const inspect = proxyInspect(preConfinementSpec(input), running);
  inspect.HostConfig.SecurityOpt = ['no-new-privileges:true'];
  inspect.AppArmorProfile = 'docker-default';
  return inspect;
}

describe('project egress plane specification and attestation', () => {
  test('resolves the installer-built proxy tag to an immutable local image id', async () => {
    const executor = {
      run: jest.fn(async () => ({
        stdout: `sha256:${'b'.repeat(64)}\n`,
        stderr: '',
        exitCode: 0,
      })),
    };
    await expect(resolvePinnedProjectEgressProxyImage(undefined, executor)).resolves.toBe(`sha256:${'b'.repeat(64)}`);
    expect(executor.run).toHaveBeenCalledWith('docker', [
      'image', 'inspect', '--format', '{{.Id}}', PROJECT_EGRESS_PROXY_IMAGE_TAG,
    ]);
  });

  test('rejects a mutable or malformed local proxy image id', async () => {
    const executor = {
      run: jest.fn(async () => ({ stdout: 'latest\n', stderr: '', exitCode: 0 })),
    };
    await expect(resolvePinnedProjectEgressProxyImage(undefined, executor)).rejects.toMatchObject({
      code: 'PROXY_IMAGE_ID',
    });
  });

  test('derives collision-resistant names from the full actor/project/provider identity', () => {
    const first = spec();
    const same = spec();
    const otherActor = buildProjectEgressPlaneSpec({
      identity: { actorId: 'user-full-uuid-2', projectId: 'project-full-uuid', provider: 'codex' },
      proxyImage: IMAGE,
      token: TOKEN,
      extraDeniedCidrs: ['203.0.114.7/32'],
    });
    expect(first.policyFingerprint).toBe(same.policyFingerprint);
    expect(first.internalNetworkName).toBe(same.internalNetworkName);
    expect(first.internalNetworkName).not.toBe(otherActor.internalNetworkName);
    expect(first.publicNetworkName).not.toBe(otherActor.publicNetworkName);
    expect(first.proxyContainerName).not.toBe(otherActor.proxyContainerName);
    expect(first.deniedCidrs).toEqual(expect.arrayContaining([
      '10.0.0.0/8',
      '100.64.0.0/10',
      '169.254.0.0/16',
      '203.0.114.7/32',
      'fc00::/7',
    ]));
  });

  test('requires a digest-pinned sidecar image and a high-entropy token', () => {
    expect(() => buildProjectEgressPlaneSpec({
      identity: { actorId: 'actor', projectId: 'project', provider: 'CODEX' },
      proxyImage: 'registry.example/proxy:latest',
      token: TOKEN,
    })).toThrow('pinned by sha256');
    expect(() => buildProjectEgressPlaneSpec({
      identity: { actorId: 'actor', projectId: 'project', provider: 'CODEX' },
      proxyImage: IMAGE,
      token: 'weak',
    })).toThrow('256 bits');
    expect(issueProjectEgressProxyToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('discovers only public host addresses so ephemeral bridges cannot poison the policy fingerprint', () => {
    expect(discoverProjectEgressHostDeniedCidrs({
      eth0: [
        { address: '93.184.216.34', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
        { address: '2606:2800:220:1::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '', internal: false, cidr: null, scopeid: 0 },
      ],
      // Docker bridge and loopback addresses are statically denied already;
      // including them here would change the egress policy fingerprint every
      // time this plane creates or removes one of its own bridges.
      docker0: [
        { address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', mac: '', internal: false, cidr: null },
      ],
      'br-abc123': [
        { address: '172.29.0.1', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
      ],
      lo: [
        { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null },
      ],
      bad: undefined,
    } as any)).toEqual(['2606:2800:220:1::1/128', '93.184.216.34/32']);
  });

  test('accepts exactly one internal bridge and one labelled proxy-public bridge', () => {
    const input = spec();
    expect(() => attestProjectEgressNetworks(input, {
      Name: input.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(input, 'internal'),
    }, {
      Name: input.publicNetworkName,
      Driver: 'bridge',
      Internal: false,
      Labels: labelsFor(input, 'proxy-public'),
    })).not.toThrow();
  });

  test('rejects lateral containers on either project egress network', () => {
    const input = spec();
    expect(() => attestProjectEgressNetworkMembership({
      network: { Containers: { proxy: { Name: input.proxyContainerName } } },
      expectedNames: [input.proxyContainerName],
      role: 'proxy-public',
    })).not.toThrow();
    expect(() => attestProjectEgressNetworkMembership({
      network: {
        Containers: {
          proxy: { Name: input.proxyContainerName },
          attacker: { Name: 'unrelated-container' },
        },
      },
      expectedNames: [input.proxyContainerName],
      role: 'proxy-public',
    })).toThrow('unexpected members');
  });

  test('refuses stale-network replacement while any provider runtime remains attached', async () => {
    const current = spec();
    const previous = preConfinementSpec(current);
    expect(previous.policyFingerprint).not.toBe(current.policyFingerprint);
    const runtimeId = 'f'.repeat(64);
    const network = {
      Id: 'd'.repeat(64),
      Name: current.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(previous, 'internal'),
      Containers: {
        [runtimeId]: { Name: 'p4cc-managed-runtime' },
      },
    };
    const executor = { run: jest.fn() } as unknown as ProjectEgressCommandExecutor;

    await expect(__projectEgressPlaneTest.removeStaleNetwork(
      executor,
      current,
      network,
    )).rejects.toMatchObject({ code: 'STALE_NETWORK_RUNTIME_ATTACHED' });
    expect(executor.run).not.toHaveBeenCalled();
  });

  test('replaces a stale policy network only after immutable-ID proxy attestation and retirement', async () => {
    const current = spec();
    const previous = preConfinementSpec(current);
    const proxyId = 'c'.repeat(64);
    const networkId = 'd'.repeat(64);
    const network: any = {
      Id: networkId,
      Name: current.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(previous, 'internal'),
      Containers: {
        [proxyId]: { Name: current.proxyContainerName },
      },
    };
    const proxy = preConfinementProxyInspect(current, true);
    let proxyExists = true;
    let networkExists = true;
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
          return {
            stdout: proxyExists ? `${proxy.Id}\n` : '',
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          if (!proxyExists) {
            return { stdout: '', stderr: 'Error: No such container', exitCode: 1 };
          }
          return { stdout: JSON.stringify([proxy]), stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'stop') {
          expect(args[4]).toBe(proxyId);
          proxy.State.Running = false;
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'rm') {
          expect(args).toEqual(['container', 'rm', proxyId]);
          proxyExists = false;
          network.Containers = {};
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          if (!networkExists) {
            return { stdout: '', stderr: 'Error: network not found', exitCode: 1 };
          }
          return { stdout: JSON.stringify([network]), stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return { stdout: networkExists ? `${network.Id}\n` : '', stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'rm') {
          expect(args).toEqual(['network', 'rm', networkId]);
          networkExists = false;
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(__projectEgressPlaneTest.removeStaleNetwork(
      executor,
      current,
      network,
    )).resolves.toBeUndefined();
    expect(commands).toEqual(expect.arrayContaining([
      { command: 'docker', args: ['container', 'stop', '--time', '1', proxyId] },
      { command: 'docker', args: ['container', 'rm', proxyId] },
      { command: 'docker', args: ['network', 'rm', networkId] },
    ]));
    expect(commands.some(({ args }) => args.includes('--force'))).toBe(false);
    expect(proxyExists).toBe(false);
    expect(networkExists).toBe(false);
  });

  test('converges the exact pre-confinement plane once and is idempotent', async () => {
    const current = spec();
    const previous = preConfinementSpec(current);
    const proxyId = 'c'.repeat(64);
    let proxy: any | null = preConfinementProxyInspect(current, true);
    let internal: any | null = {
      Id: 'd'.repeat(64),
      Name: current.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(previous, 'internal'),
      Containers: { [proxyId]: { Name: current.proxyContainerName } },
    };
    let publicNetwork: any | null = {
      Id: 'e'.repeat(64),
      Name: current.publicNetworkName,
      Driver: 'bridge',
      Internal: false,
      Labels: labelsFor(previous, 'proxy-public'),
      Containers: { [proxyId]: { Name: current.proxyContainerName } },
      IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
    };
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const absent = (label: string): ProjectEgressCommandResult => ({
      stdout: '',
      stderr: `Error: No such ${label}`,
      exitCode: 1,
    });
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
          return { stdout: proxy ? `${proxy.Id}\n` : '', stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return {
            stdout: [internal?.Id, publicNetwork?.Id].filter(Boolean).join('\n'),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          return proxy
            ? { stdout: JSON.stringify([proxy]), stderr: '', exitCode: 0 }
            : absent('container');
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'stop') {
          proxy.State.Running = false;
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'rm') {
          proxy = null;
          if (internal) internal.Containers = {};
          if (publicNetwork) publicNetwork.Containers = {};
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          const reference = String(args[2]);
          const network = [internal, publicNetwork].find((value) => (
            value && (value.Name === reference || value.Id === reference)
          ));
          return network
            ? { stdout: JSON.stringify([network]), stderr: '', exitCode: 0 }
            : absent('network');
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'rm') {
          if (internal?.Id === args[2]) internal = null;
          if (publicNetwork?.Id === args[2]) publicNetwork = null;
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'create') {
          const name = String(args.at(-1));
          if (name === current.internalNetworkName) {
            internal = {
              Id: '1'.repeat(64),
              Name: name,
              Driver: 'bridge',
              Internal: true,
              Labels: labelsFor(current, 'internal'),
              Containers: {},
            };
            return { stdout: `${internal.Id}\n`, stderr: '', exitCode: 0 };
          } else {
            publicNetwork = {
              Id: '2'.repeat(64),
              Name: name,
              Driver: 'bridge',
              Internal: false,
              Labels: labelsFor(current, 'proxy-public'),
              Containers: {},
            };
            return { stdout: `${publicNetwork.Id}\n`, stderr: '', exitCode: 0 };
          }
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(__projectEgressPlaneTest.ensureNetworks(executor, current)).resolves.toBeUndefined();
    const mutationsAfterFirst = commands.filter(({ args }) => (
      (args[0] === 'container' && ['stop', 'rm'].includes(String(args[1])))
      || (args[0] === 'network' && ['rm', 'create'].includes(String(args[1])))
    ));
    await expect(__projectEgressPlaneTest.ensureNetworks(executor, current)).resolves.toBeUndefined();
    expect(commands.filter(({ args }) => (
      (args[0] === 'container' && ['stop', 'rm'].includes(String(args[1])))
      || (args[0] === 'network' && ['rm', 'create'].includes(String(args[1])))
    ))).toEqual(mutationsAfterFirst);
    expect(mutationsAfterFirst.filter(({ args }) => args[0] === 'container')).toHaveLength(2);
    expect(mutationsAfterFirst.filter(({ args }) => args[0] === 'network' && args[1] === 'rm'))
      .toHaveLength(2);
    expect(mutationsAfterFirst.filter(({ args }) => args[0] === 'network' && args[1] === 'create'))
      .toHaveLength(2);
  });

  test('preflights a malformed current network before creating its missing counterpart', async () => {
    const current = spec();
    const publicNetwork: any = {
      Id: 'e'.repeat(64),
      Name: current.publicNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(current, 'proxy-public'),
      Containers: {},
    };
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          if (String(args[2]) === current.internalNetworkName) {
            return { stdout: '', stderr: 'Error: No such network', exitCode: 1 };
          }
          return { stdout: JSON.stringify([publicNetwork]), stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return { stdout: `${publicNetwork.Id}\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(__projectEgressPlaneTest.ensureNetworks(executor, current))
      .rejects.toBeInstanceOf(ProjectEgressAttestationError);
    expect(commands.some(({ args }) => (
      args[0] === 'network' && ['create', 'rm'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('does not mutate either named network when the paired inspect fails transiently', async () => {
    const current = spec();
    const previous = preConfinementSpec(current);
    const internal = {
      Id: 'd'.repeat(64),
      Name: current.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(previous, 'internal'),
      Containers: {},
    };
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          if (String(args[2]) === current.internalNetworkName) {
            return { stdout: JSON.stringify([internal]), stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: 'Error response from daemon: daemon is busy', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(__projectEgressPlaneTest.ensureNetworks(executor, current))
      .rejects.toBeInstanceOf(ProjectEgressAttestationError);
    expect(commands.some(({ args }) => (
      (args[0] === 'network' && ['create', 'rm'].includes(String(args[1])))
      || (args[0] === 'container' && ['stop', 'rm'].includes(String(args[1])))
    ))).toBe(false);
  });

  test('jointly preflights both predecessor networks before any mutation', async () => {
    const current = spec();
    const previous = preConfinementSpec(current);
    const internal = {
      Id: 'd'.repeat(64),
      Name: current.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(previous, 'internal'),
      Containers: {},
    };
    const publicNetwork = {
      Id: 'e'.repeat(64),
      Name: current.publicNetworkName,
      Driver: 'bridge',
      Internal: false,
      Labels: {
        ...labelsFor(previous, 'proxy-public'),
        [__projectEgressPlaneTest.labels.LABEL_FINGERPRINT]: '8'.repeat(64),
      },
      Containers: {},
      IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
    };
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          return {
            stdout: JSON.stringify([
              String(args[2]) === current.internalNetworkName ? internal : publicNetwork,
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return {
            stdout: `${internal.Id}\n${publicNetwork.Id}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(__projectEgressPlaneTest.ensureNetworks(executor, current))
      .rejects.toBeInstanceOf(ProjectEgressAttestationError);
    expect(commands.some(({ args }) => (
      (args[0] === 'network' && ['create', 'rm'].includes(String(args[1])))
      || (args[0] === 'container' && ['stop', 'rm'].includes(String(args[1])))
    ))).toBe(false);
  });

  test.each([
    ['renamed', [`${'f'.repeat(64)}\n`]],
    ['duplicate', [`${'d'.repeat(64)}\n${'f'.repeat(64)}\n`]],
  ])('rejects %s network identity claimants before mutation', async (_label, [internalInventory]) => {
    const current = spec();
    const internal = _label === 'duplicate'
      ? {
        Id: 'd'.repeat(64),
        Name: current.internalNetworkName,
        Driver: 'bridge',
        Internal: true,
        Labels: labelsFor(current, 'internal'),
        Containers: {},
      }
      : null;
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          if (internal && String(args[2]) === current.internalNetworkName) {
            return { stdout: JSON.stringify([internal]), stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: 'Error: No such network', exitCode: 1 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return {
            stdout: internalInventory,
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(__projectEgressPlaneTest.ensureNetworks(executor, current))
      .rejects.toMatchObject({ code: 'NETWORK_IDENTITY_INVENTORY' });
    expect(commands.some(({ args }) => args[0] === 'network' && ['create', 'rm'].includes(String(args[1]))))
      .toBe(false);
  });

  test('rejects a stale network with a truncated Docker ID before mutation', async () => {
    const current = spec();
    const previous = preConfinementSpec(current);
    const network = {
      Id: 'd'.repeat(12),
      Name: current.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(previous, 'internal'),
      Containers: {},
    };
    const executor = { run: jest.fn() } as unknown as ProjectEgressCommandExecutor;
    await expect(__projectEgressPlaneTest.removeStaleNetwork(executor, current, network))
      .rejects.toMatchObject({ code: 'DOCKER_RESOURCE_ID' });
    expect(executor.run).not.toHaveBeenCalled();
  });

  test('blocks a proxy identity that appears after an empty stale-plane preflight', async () => {
    const current = spec();
    const previous = preConfinementSpec(current);
    const internal = {
      Id: 'd'.repeat(64),
      Name: current.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(previous, 'internal'),
      Containers: {},
    };
    const publicNetwork = {
      Id: 'e'.repeat(64),
      Name: current.publicNetworkName,
      Driver: 'bridge',
      Internal: false,
      Labels: labelsFor(previous, 'proxy-public'),
      Containers: {},
      IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
    };
    let proxyInventoryReads = 0;
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          const reference = String(args[2]);
          return {
            stdout: JSON.stringify([
              [current.internalNetworkName, internal.Id].includes(reference)
                ? internal
                : publicNetwork,
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return {
            stdout: `${internal.Id}\n${publicNetwork.Id}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
          proxyInventoryReads += 1;
          return {
            stdout: proxyInventoryReads === 1 ? '' : `${'f'.repeat(64)}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          return { stdout: '', stderr: 'Error: No such container', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(__projectEgressPlaneTest.ensureNetworks(executor, current))
      .rejects.toMatchObject({ code: 'STALE_PLANE_INVENTORY_RACE' });
    expect(commands.some(({ args }) => (
      (args[0] === 'network' && ['rm', 'create'].includes(String(args[1])))
      || (args[0] === 'container' && ['stop', 'rm'].includes(String(args[1])))
    ))).toBe(false);
  });

  test('does not mutate stale networks around a stopped foreign deterministic-name proxy', async () => {
    const current = spec();
    const previous = preConfinementSpec(current);
    const internal = {
      Id: 'd'.repeat(64),
      Name: current.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(previous, 'internal'),
      Containers: {},
    };
    const publicNetwork = {
      Id: 'e'.repeat(64),
      Name: current.publicNetworkName,
      Driver: 'bridge',
      Internal: false,
      Labels: labelsFor(previous, 'proxy-public'),
      Containers: {},
      IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
    };
    const foreign = preConfinementProxyInspect(current, false);
    foreign.Id = 'f'.repeat(64);
    foreign.Config.Labels = {};
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          const reference = String(args[2]);
          return {
            stdout: JSON.stringify([
              [current.internalNetworkName, internal.Id].includes(reference)
                ? internal
                : publicNetwork,
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return {
            stdout: `${internal.Id}\n${publicNetwork.Id}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          return { stdout: JSON.stringify([foreign]), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(__projectEgressPlaneTest.ensureNetworks(executor, current))
      .rejects.toMatchObject({ code: 'STALE_PROXY_IDENTITY_INVENTORY' });
    expect(commands.some(({ args }) => (
      (args[0] === 'network' && ['rm', 'create'].includes(String(args[1])))
      || (args[0] === 'container' && ['stop', 'rm'].includes(String(args[1])))
    ))).toBe(false);
  });

  test.each([
    ['renamed', `${'f'.repeat(64)}\n`],
    ['duplicate', `${'c'.repeat(64)}\n${'f'.repeat(64)}\n`],
  ])('rejects %s proxy identity inventory before mutation', async (_label, inventory) => {
    const current = spec();
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
          return { stdout: inventory, stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          return { stdout: '', stderr: 'Error: No such container', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    await expect(__projectEgressPlaneTest.ensureProxyContainer(executor, current))
      .rejects.toMatchObject({ code: 'PROXY_IDENTITY_INVENTORY' });
    expect(commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('binds network creation to the returned immutable ID before creating the paired role', async () => {
    const current = spec();
    const createdId = 'd'.repeat(64);
    const substituted = {
      Id: 'f'.repeat(64),
      Name: current.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(current, 'internal'),
      Containers: {},
    };
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          if (String(args[2]) === createdId) {
            return { stdout: JSON.stringify([substituted]), stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: 'Error: No such network', exitCode: 1 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'create') {
          return { stdout: `${createdId}\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(__projectEgressPlaneTest.ensureNetworks(executor, current))
      .rejects.toMatchObject({ code: 'NETWORK_IDENTITY' });
    expect(commands.filter(({ args }) => args[0] === 'network' && args[1] === 'create'))
      .toHaveLength(1);
    expect(commands.some(({ args }) => args[0] === 'network' && args[1] === 'rm')).toBe(false);
  });

  test('never connects a same-name substitute after proxy creation', async () => {
    const current = spec();
    const createdId = 'c'.repeat(64);
    const replacement = proxyInspect(current, false);
    replacement.Id = 'f'.repeat(64);
    replacement.HostConfig.Privileged = true;
    const internal = {
      Id: 'd'.repeat(64),
      Name: current.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(current, 'internal'),
      Containers: {},
    };
    const publicNetwork = {
      Id: 'e'.repeat(64),
      Name: current.publicNetworkName,
      Driver: 'bridge',
      Internal: false,
      Labels: labelsFor(current, 'proxy-public'),
      Containers: {},
      IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
    };
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          if (String(args[2]) === createdId) {
            return { stdout: JSON.stringify([replacement]), stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: 'Error: No such container', exitCode: 1 };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'create') {
          return { stdout: `${createdId}\n`, stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return {
            stdout: `${internal.Id}\n${publicNetwork.Id}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          const reference = String(args[2]);
          return {
            stdout: JSON.stringify([
              [current.internalNetworkName, internal.Id].includes(reference)
                ? internal
                : publicNetwork,
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(__projectEgressPlaneTest.ensureProxyContainer(executor, current))
      .rejects.toMatchObject({ code: 'PROXY_IDENTITY' });
    expect(commands.some(({ args }) => (
      (args[0] === 'network' && args[1] === 'connect')
      || (args[0] === 'container' && ['stop', 'start', 'rm'].includes(String(args[1])))
    ))).toBe(false);
  });

  test.each([
    ['policy fingerprint', (network: any) => {
      network.Labels[__projectEgressPlaneTest.labels.LABEL_FINGERPRINT] = '8'.repeat(64);
    }],
    ['pinned image', (_network: any, proxy: any) => {
      proxy.Config.Image = `sha256:${'9'.repeat(64)}`;
      proxy.Image = `sha256:${'9'.repeat(64)}`;
    }],
    ['bounded command', (_network: any, proxy: any) => {
      proxy.Config.Cmd = ['node', '/tmp/foreign-proxy.js'];
    }],
    ['denied CIDRs', (_network: any, proxy: any) => {
      proxy.Config.Env = proxy.Config.Env.map((entry: string) => (
        entry.startsWith('PROJECT_EGRESS_DENY_CIDRS=')
          ? 'PROJECT_EGRESS_DENY_CIDRS=["203.0.113.9/32"]'
          : entry
      ));
    }],
    ['added capability', (_network: any, proxy: any) => {
      proxy.HostConfig.CapAdd = ['NET_ADMIN'];
    }],
    ['container namespace join', (_network: any, proxy: any) => {
      proxy.HostConfig.PidMode = `container:${'f'.repeat(64)}`;
    }],
    ['conflicting tmpfs flag', (_network: any, proxy: any) => {
      proxy.HostConfig.Tmpfs['/tmp'] += ',exec';
    }],
    ['Node runtime option', (_network: any, proxy: any) => {
      proxy.Config.Env.push('NODE_OPTIONS=--inspect=0.0.0.0:9229');
    }],
  ])('never mutates an arbitrary predecessor-looking %s', async (_label, mutate) => {
    const current = spec();
    const previous = preConfinementSpec(current);
    const proxyId = 'c'.repeat(64);
    const network: any = {
      Id: 'd'.repeat(64),
      Name: current.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(previous, 'internal'),
      Containers: {
        [proxyId]: { Name: current.proxyContainerName },
      },
    };
    const proxy = preConfinementProxyInspect(current, true);
    mutate(network, proxy);
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
          return {
            stdout: `${proxy.Id}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          return { stdout: JSON.stringify([proxy]), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(__projectEgressPlaneTest.removeStaleNetwork(
      executor,
      current,
      network,
    )).rejects.toBeInstanceOf(ProjectEgressAttestationError);
    expect(commands.some(({ args }) => (
      (args[0] === 'container' && ['stop', 'rm'].includes(String(args[1])))
      || (args[0] === 'network' && args[1] === 'rm')
    ))).toBe(false);
  });

  test('replaces a rotated-token proxy by immutable ID before creating the new credential generation', async () => {
    const previous = spec();
    const rotatedToken = 'Z'.repeat(43);
    const current = buildProjectEgressPlaneSpec({
      identity: previous.identity,
      proxyImage: previous.proxyImage,
      token: rotatedToken,
      extraDeniedCidrs: ['203.0.114.7/32'],
    });
    expect(current.policyFingerprint).toBe(previous.policyFingerprint);
    expect(current.tokenHash).not.toBe(previous.tokenHash);
    let proxy: any = proxyInspect(previous, true);
    let proxyExists = true;
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const internalNetwork = {
      Id: 'd'.repeat(64),
      Name: current.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(current, 'internal'),
      Containers: {},
    };
    const publicNetwork = {
      Id: 'e'.repeat(64),
      Name: current.publicNetworkName,
      Driver: 'bridge',
      Internal: false,
      Labels: labelsFor(current, 'proxy-public'),
      Containers: {},
      IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
    };
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
          return { stdout: proxyExists ? `${proxy.Id}\n` : '', stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return {
            stdout: `${internalNetwork.Id}\n${publicNetwork.Id}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          if (!proxyExists) {
            return { stdout: '', stderr: 'Error: No such container', exitCode: 1 };
          }
          return { stdout: JSON.stringify([proxy]), stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'stop') {
          expect(args.at(-1)).toBe('c'.repeat(64));
          proxy.State.Running = false;
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'rm') {
          expect(args).toEqual(['container', 'rm', 'c'.repeat(64)]);
          proxyExists = false;
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'create') {
          expect(proxyExists).toBe(false);
          proxy = proxyInspect(current, false);
          proxy.Id = '1'.repeat(64);
          proxy.HostConfig.NetworkMode = publicNetwork.Id;
          delete proxy.NetworkSettings.Networks[current.internalNetworkName];
          proxyExists = true;
          return { stdout: `${proxy.Id}\n`, stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'connect') {
          proxy.NetworkSettings.Networks[current.internalNetworkName] = {
            IPAddress: '',
            Aliases: [current.proxyAlias],
            NetworkID: 'd'.repeat(64),
          };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          const reference = String(args[2]);
          return {
            stdout: JSON.stringify([
              [current.internalNetworkName, internalNetwork.Id].includes(reference)
                ? internalNetwork
                : publicNetwork,
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(__projectEgressPlaneTest.ensureProxyContainer(executor, current))
      .resolves.toMatchObject({
        Id: '1'.repeat(64),
        Config: {
          Labels: {
            [__projectEgressPlaneTest.labels.LABEL_TOKEN_HASH]: current.tokenHash,
          },
        },
      });
    const removeIndex = commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'rm'
    ));
    const createIndex = commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'create'
    ));
    expect(removeIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(removeIndex);
    expect(commands.some(({ args }) => args.includes('--force'))).toBe(false);
  });

  test.each([
    ['image', (value: any) => {
      value.Config.Image = `sha256:${'9'.repeat(64)}`;
      value.Image = `sha256:${'9'.repeat(64)}`;
    }],
    ['command', (value: any) => { value.Config.Cmd = ['node', '/tmp/foreign.js']; }],
    ['denied CIDRs', (value: any) => {
      value.Config.Env = value.Config.Env.map((entry: string) => (
        entry.startsWith('PROJECT_EGRESS_DENY_CIDRS=')
          ? 'PROJECT_EGRESS_DENY_CIDRS=["203.0.113.9/32"]'
          : entry
      ));
    }],
    ['namespace join', (value: any) => {
      value.HostConfig.IpcMode = `container:${'f'.repeat(64)}`;
    }],
    ['capability add', (value: any) => { value.HostConfig.CapAdd = ['NET_ADMIN']; }],
    ['Node runtime option', (value: any) => {
      value.Config.Env.push('NODE_OPTIONS=--inspect=0.0.0.0:9229');
    }],
  ])('never rotates a current-policy old-token proxy with hostile %s drift', async (_label, mutate) => {
    const previous = spec();
    const current = buildProjectEgressPlaneSpec({
      identity: previous.identity,
      proxyImage: previous.proxyImage,
      token: 'Z'.repeat(43),
      extraDeniedCidrs: ['203.0.114.7/32'],
    });
    const proxy = proxyInspect(previous, true);
    mutate(proxy);
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const internalNetwork = {
      Id: 'd'.repeat(64),
      Name: current.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(current, 'internal'),
      Containers: {},
    };
    const publicNetwork = {
      Id: 'e'.repeat(64),
      Name: current.publicNetworkName,
      Driver: 'bridge',
      Internal: false,
      Labels: labelsFor(current, 'proxy-public'),
      Containers: {},
      IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
    };
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
          return { stdout: `${proxy.Id}\n`, stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          return { stdout: JSON.stringify([proxy]), stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return {
            stdout: `${internalNetwork.Id}\n${publicNetwork.Id}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          const reference = String(args[2]);
          return {
            stdout: JSON.stringify([
              [current.internalNetworkName, internalNetwork.Id].includes(reference)
                ? internalNetwork
                : publicNetwork,
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(__projectEgressPlaneTest.ensureProxyContainer(executor, current))
      .rejects.toBeInstanceOf(ProjectEgressAttestationError);
    expect(commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(String(args[1]))
    ))).toBe(false);
  });

  test.each([
    ['internal network accidentally routable', (input: ProjectEgressPlaneSpec) => ({
      Name: input.internalNetworkName, Driver: 'bridge', Internal: false, Labels: labelsFor(input, 'internal'),
    })],
    ['wrong network driver', (input: ProjectEgressPlaneSpec) => ({
      Name: input.internalNetworkName, Driver: 'macvlan', Internal: true, Labels: labelsFor(input, 'internal'),
    })],
    ['missing policy label', (input: ProjectEgressPlaneSpec) => ({
      Name: input.internalNetworkName, Driver: 'bridge', Internal: true, Labels: {},
    })],
  ])('fails closed when %s', (_label, mutate) => {
    const input = spec();
    expect(() => attestProjectEgressNetworks(input, mutate(input), {
      Name: input.publicNetworkName,
      Driver: 'bridge',
      Internal: false,
      Labels: labelsFor(input, 'proxy-public'),
    })).toThrow(ProjectEgressAttestationError);
  });

  test('attests an unprivileged, mount-free, unexposed proxy with exactly two networks', () => {
    const input = spec();
    expect(attestProjectEgressProxyContainer(input, proxyInspect(input))).toEqual({
      publicIpv4: '172.29.0.2',
      publicIpv6: null,
    });
  });

  test.each([
    ['root user', (value: any) => { value.Config.User = 'root'; }],
    ['mutable rootfs', (value: any) => { value.HostConfig.ReadonlyRootfs = false; }],
    ['privileged mode', (value: any) => { value.HostConfig.Privileged = true; }],
    ['missing cap drop', (value: any) => { value.HostConfig.CapDrop = []; }],
    ['added capability', (value: any) => { value.HostConfig.CapAdd = ['NET_ADMIN']; }],
    ['missing no-new-privileges', (value: any) => { value.HostConfig.SecurityOpt = []; }],
    ['wrong seccomp profile', (value: any) => { value.HostConfig.SecurityOpt[1] = 'seccomp=/tmp/foreign.json'; }],
    ['wrong AppArmor profile', (value: any) => { value.AppArmorProfile = 'docker-default'; }],
    ['project mount', (value: any) => { value.Mounts = [{ Source: '/portal/projects/a' }]; }],
    ['published port', (value: any) => { value.HostConfig.PortBindings = { '3128/tcp': [{ HostPort: '3128' }] }; }],
    ['extra network', (value: any) => { value.NetworkSettings.Networks.bridge = { IPAddress: '172.17.0.3' }; }],
    ['missing alias', (value: any, input: ProjectEgressPlaneSpec) => { value.NetworkSettings.Networks[input.internalNetworkName].Aliases = []; }],
    ['wrong image', (value: any) => { value.Config.Image = `example/proxy@sha256:${'b'.repeat(64)}`; }],
    ['auto-restart', (value: any) => { value.HostConfig.RestartPolicy.Name = 'unless-stopped'; }],
    ['wrong command', (value: any) => { value.Config.Cmd = ['sleep', 'infinity']; }],
    ['wrong security env', (value: any) => { value.Config.Env = []; }],
    ['missing pid limit', (value: any) => { value.HostConfig.PidsLimit = 0; }],
    ['weak tmpfs', (value: any) => { value.HostConfig.Tmpfs['/tmp'] = 'rw'; }],
    ['conflicting tmpfs flag', (value: any) => { value.HostConfig.Tmpfs['/tmp'] += ',exec'; }],
    ['container pid namespace', (value: any) => { value.HostConfig.PidMode = `container:${'f'.repeat(64)}`; }],
    ['container ipc namespace', (value: any) => { value.HostConfig.IpcMode = `container:${'f'.repeat(64)}`; }],
    ['container uts namespace', (value: any) => { value.HostConfig.UTSMode = `container:${'f'.repeat(64)}`; }],
    ['container user namespace', (value: any) => { value.HostConfig.UsernsMode = `container:${'f'.repeat(64)}`; }],
    ['container cgroup namespace', (value: any) => { value.HostConfig.CgroupnsMode = `container:${'f'.repeat(64)}`; }],
    ['device request', (value: any) => { value.HostConfig.DeviceRequests = [{}]; }],
    ['publish all ports', (value: any) => { value.HostConfig.PublishAllPorts = true; }],
    ['custom DNS', (value: any) => { value.HostConfig.Dns = ['8.8.8.8']; }],
    ['duplicate token env', (value: any, input: ProjectEgressPlaneSpec) => {
      value.Config.Env.push(`PROJECT_EGRESS_PROXY_TOKEN=${input.token}`);
    }],
    ['Node runtime option', (value: any) => {
      value.Config.Env.push('NODE_OPTIONS=--inspect=0.0.0.0:9229');
    }],
  ])('rejects proxy drift: %s', (_label, mutate) => {
    const input = spec();
    const value = proxyInspect(input);
    mutate(value, input);
    expect(() => attestProjectEgressProxyContainer(input, value)).toThrow(ProjectEgressAttestationError);
  });

  test('attests a stopped project runtime on only its private network and bound identity', () => {
    const input = spec();
    const runtime = {
      Config: { Labels: { [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: 'runtime-fingerprint' } },
      State: { Running: false },
      HostConfig: { NetworkMode: input.internalNetworkName },
      NetworkSettings: { Networks: { [input.internalNetworkName]: { IPAddress: '172.30.0.3' } } },
    };
    expect(() => attestProjectRuntimeEgressAttachment(input, runtime, 'runtime-fingerprint')).not.toThrow();
    runtime.NetworkSettings.Networks = {
      ...runtime.NetworkSettings.Networks,
      bridge: { IPAddress: '172.17.0.5' },
    };
    expect(() => attestProjectRuntimeEgressAttachment(input, runtime, 'runtime-fingerprint'))
      .toThrow(ProjectEgressAttestationError);
  });

  test('attests a never-started runtime reconnected onto its internal network without an id yet', () => {
    const input = spec();
    const internalId = 'd'.repeat(64);
    // Created with --network none, then network-connected to the internal
    // network before first start: NetworkID stays blank and NetworkMode stays
    // the create-time none.
    const runtime = {
      Config: { Labels: { [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: 'runtime-fingerprint' } },
      State: { Running: false },
      HostConfig: { NetworkMode: 'none' },
      NetworkSettings: { Networks: { [input.internalNetworkName]: { NetworkID: '' } } },
    };
    expect(() => attestProjectRuntimeEgressAttachment(input, runtime, 'runtime-fingerprint', internalId))
      .not.toThrow();
    const foreignMode = {
      ...runtime,
      HostConfig: { NetworkMode: 'bridge' },
    };
    expect(() => attestProjectRuntimeEgressAttachment(input, foreignMode, 'runtime-fingerprint', internalId))
      .toThrow(ProjectEgressAttestationError);
    const foreignId = {
      ...runtime,
      NetworkSettings: { Networks: { [input.internalNetworkName]: { NetworkID: 'a'.repeat(64) } } },
    };
    expect(() => attestProjectRuntimeEgressAttachment(input, foreignId, 'runtime-fingerprint', internalId))
      .toThrow(ProjectEgressAttestationError);
  });

  test('constrains a stopped ID-primary runtime when Docker leaves its sole attachment ID blank', async () => {
    const input = spec();
    const internalId = 'd'.repeat(64);
    const publicId = 'e'.repeat(64);
    const runtimeId = 'f'.repeat(64);
    const internal = {
      Id: internalId,
      Name: input.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(input, 'internal'),
      Containers: { proxy: { Name: input.proxyContainerName } },
    };
    const publicNetwork = {
      Id: publicId,
      Name: input.publicNetworkName,
      Driver: 'bridge',
      Internal: false,
      Labels: labelsFor(input, 'proxy-public'),
      Containers: { proxy: { Name: input.proxyContainerName } },
      IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
    };
    const runtime = {
      Id: runtimeId,
      Name: '/project-runtime',
      State: { Running: false },
      Config: { Labels: { [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: 'runtime-fingerprint' } },
      HostConfig: { NetworkMode: internalId },
      NetworkSettings: {
        Networks: {
          [input.internalNetworkName]: { NetworkID: '' },
        },
      },
    };
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return { stdout: `${internalId}\n${publicId}\n`, stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          const reference = String(args[2]);
          const network = [input.internalNetworkName, internalId].includes(reference)
            ? internal
            : publicNetwork;
          return { stdout: JSON.stringify([network]), stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          return { stdout: JSON.stringify([runtime]), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(constrainProjectRuntimeToEgressPlane({
      spec: input,
      runtimeContainerId: runtimeId,
      runtimeContainerName: 'project-runtime',
      expectedRuntimeFingerprint: 'runtime-fingerprint',
      executor,
    })).resolves.toBeUndefined();
    expect(commands.some(({ args }) => (
      args[0] === 'network' && ['connect', 'disconnect'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('confines a never-started runtime whose sole none attachment has no id yet', async () => {
    // Docker reports NetworkID as an empty string until a container's first
    // start, so a freshly created `--network none` workload must still be
    // attributable to the singleton none network and then moved onto its
    // internal project network.
    const input = spec();
    const internalId = 'd'.repeat(64);
    const publicId = 'e'.repeat(64);
    const noneId = '1'.repeat(64);
    const runtimeId = 'f'.repeat(64);
    const internal = {
      Id: internalId,
      Name: input.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(input, 'internal'),
      Containers: { proxy: { Name: input.proxyContainerName } },
    };
    const publicNetwork = {
      Id: publicId,
      Name: input.publicNetworkName,
      Driver: 'bridge',
      Internal: false,
      Labels: labelsFor(input, 'proxy-public'),
      Containers: { proxy: { Name: input.proxyContainerName } },
      IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
    };
    const noneNetwork = { Id: noneId, Name: 'none', Driver: 'null', Internal: false, Labels: {} };
    const baseRuntime = {
      Id: runtimeId,
      Name: '/project-runtime',
      State: { Running: false },
      Config: { Labels: { [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: 'runtime-fingerprint' } },
      HostConfig: { NetworkMode: 'none' },
    };
    let disconnected = false;
    let connected = false;
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return { stdout: `${internalId}\n${publicId}\n`, stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          const reference = String(args[2]);
          const network = reference === 'none' || reference === noneId
            ? noneNetwork
            : [input.internalNetworkName, internalId].includes(reference)
              ? internal
              : publicNetwork;
          return { stdout: JSON.stringify([network]), stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'disconnect') {
          disconnected = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'connect') {
          connected = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          const networks = connected
            ? { [input.internalNetworkName]: { NetworkID: internalId } }
            : disconnected
              ? {}
              : { none: { NetworkID: '' } };
          return {
            stdout: JSON.stringify([{ ...baseRuntime, NetworkSettings: { Networks: networks } }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(constrainProjectRuntimeToEgressPlane({
      spec: input,
      runtimeContainerId: runtimeId,
      runtimeContainerName: 'project-runtime',
      expectedRuntimeFingerprint: 'runtime-fingerprint',
      executor,
    })).resolves.toBeUndefined();
    expect(commands.some(({ args }) => (
      args[0] === 'network' && args[1] === 'disconnect' && args[3] === noneId
    ))).toBe(true);
    expect(commands.some(({ args }) => (
      args[0] === 'network' && args[1] === 'connect' && args[2] === internalId
    ))).toBe(true);
  });

  test('rejects a blank none-attachment id when the create mode was not none', async () => {
    const input = spec();
    const internalId = 'd'.repeat(64);
    const publicId = 'e'.repeat(64);
    const noneId = '1'.repeat(64);
    const runtimeId = 'f'.repeat(64);
    const internal = {
      Id: internalId,
      Name: input.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(input, 'internal'),
      Containers: { proxy: { Name: input.proxyContainerName } },
    };
    const publicNetwork = {
      Id: publicId,
      Name: input.publicNetworkName,
      Driver: 'bridge',
      Internal: false,
      Labels: labelsFor(input, 'proxy-public'),
      Containers: { proxy: { Name: input.proxyContainerName } },
      IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
    };
    const noneNetwork = { Id: noneId, Name: 'none', Driver: 'null', Internal: false, Labels: {} };
    const runtime = {
      Id: runtimeId,
      Name: '/project-runtime',
      State: { Running: false },
      Config: { Labels: { [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: 'runtime-fingerprint' } },
      HostConfig: { NetworkMode: input.internalNetworkName },
      NetworkSettings: { Networks: { none: { NetworkID: '' } } },
    };
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return { stdout: `${internalId}\n${publicId}\n`, stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          const reference = String(args[2]);
          const network = reference === 'none' || reference === noneId
            ? noneNetwork
            : [input.internalNetworkName, internalId].includes(reference)
              ? internal
              : publicNetwork;
          return { stdout: JSON.stringify([network]), stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          return { stdout: JSON.stringify([runtime]), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    await expect(constrainProjectRuntimeToEgressPlane({
      spec: input,
      runtimeContainerId: runtimeId,
      runtimeContainerName: 'project-runtime',
      expectedRuntimeFingerprint: 'runtime-fingerprint',
      executor,
    })).rejects.toBeInstanceOf(ProjectEgressAttestationError);
    expect(commands.some(({ args }) => (
      args[0] === 'network' && ['connect', 'disconnect'].includes(String(args[1]))
    ))).toBe(false);
  });

  test.each([
    ['name-only primary mode', { Running: false }, 'named'],
    ['ambiguous stopped state', {}, 'id'],
  ])('rejects blank runtime NetworkID with %s before mutation', async (_label, state, mode) => {
    const input = spec();
    const internalId = 'd'.repeat(64);
    const publicId = 'e'.repeat(64);
    const runtimeId = 'f'.repeat(64);
    const internal = {
      Id: internalId,
      Name: input.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(input, 'internal'),
      Containers: { proxy: { Name: input.proxyContainerName } },
    };
    const publicNetwork = {
      Id: publicId,
      Name: input.publicNetworkName,
      Driver: 'bridge',
      Internal: false,
      Labels: labelsFor(input, 'proxy-public'),
      Containers: { proxy: { Name: input.proxyContainerName } },
      IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
    };
    const runtime = {
      Id: runtimeId,
      Name: '/project-runtime',
      State: state,
      Config: { Labels: { [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: 'runtime-fingerprint' } },
      HostConfig: { NetworkMode: mode === 'id' ? internalId : input.internalNetworkName },
      NetworkSettings: {
        Networks: {
          [input.internalNetworkName]: { NetworkID: '' },
        },
      },
    };
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return { stdout: `${internalId}\n${publicId}\n`, stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          const reference = String(args[2]);
          return {
            stdout: JSON.stringify([
              [input.internalNetworkName, internalId].includes(reference) ? internal : publicNetwork,
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          return { stdout: JSON.stringify([runtime]), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    await expect(constrainProjectRuntimeToEgressPlane({
      spec: input,
      runtimeContainerId: runtimeId,
      runtimeContainerName: 'project-runtime',
      expectedRuntimeFingerprint: 'runtime-fingerprint',
      executor,
    })).rejects.toBeInstanceOf(ProjectEgressAttestationError);
    expect(commands.some(({ args }) => (
      args[0] === 'network' && ['connect', 'disconnect'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('never connects a runtime after the exact internal network ID disappears', async () => {
    const input = spec();
    const internalId = 'd'.repeat(64);
    const publicId = 'e'.repeat(64);
    const replacementId = 'a'.repeat(64);
    const runtimeId = 'f'.repeat(64);
    const internal = {
      Id: internalId,
      Name: input.internalNetworkName,
      Driver: 'bridge',
      Internal: true,
      Labels: labelsFor(input, 'internal'),
      Containers: { proxy: { Name: input.proxyContainerName } },
    };
    const publicNetwork = {
      Id: publicId,
      Name: input.publicNetworkName,
      Driver: 'bridge',
      Internal: false,
      Labels: labelsFor(input, 'proxy-public'),
      Containers: { proxy: { Name: input.proxyContainerName } },
      IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
    };
    const runtime = {
      Id: runtimeId,
      Name: '/project-runtime',
      State: { Running: false },
      Config: { Labels: { [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: 'runtime-fingerprint' } },
      HostConfig: { NetworkMode: 'none' },
      NetworkSettings: { Networks: {} },
    };
    let internalIdInspects = 0;
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        commands.push({ command, args });
        if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
          return { stdout: `${internalId}\n${publicId}\n`, stderr: '', exitCode: 0 };
        }
        if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          const reference = String(args[2]);
          if (reference === internalId) {
            internalIdInspects += 1;
            if (internalIdInspects >= 2) {
              return { stdout: '', stderr: 'Error: No such network', exitCode: 1 };
            }
          }
          return {
            stdout: JSON.stringify([
              [input.internalNetworkName, internalId].includes(reference) ? internal : publicNetwork,
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
          return { stdout: JSON.stringify([runtime]), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await expect(constrainProjectRuntimeToEgressPlane({
      spec: input,
      runtimeContainerId: runtimeId,
      runtimeContainerName: 'project-runtime',
      expectedRuntimeFingerprint: 'runtime-fingerprint',
      executor,
    })).rejects.toMatchObject({ code: 'INTERNAL_NETWORK_INSPECT' });
    expect(commands.some(({ args }) => (
      args[0] === 'network' && ['connect', 'disconnect'].includes(String(args[1]))
    ))).toBe(false);
    expect(commands.some(({ args }) => args.includes(replacementId))).toBe(false);
  });

  test('requires firewall precedence, an unshadowed source jump, and exact ordered deny/allow rules', () => {
    const input = spec();
    const projectRules = __projectEgressPlaneTest.expectedFirewallRules(input, 4).join('\n');
    const valid = {
      spec: input,
      family: 4 as const,
      proxyAddress: '172.29.0.2',
      dockerUserStatements: [
        '-P DOCKER-USER ACCEPT',
        `-A DOCKER-USER -j ${__projectEgressPlaneTest.MASTER_FIREWALL_CHAIN}`,
        '-A DOCKER-USER -j RETURN',
      ].join('\n'),
      masterStatements: [
        `-A ${__projectEgressPlaneTest.MASTER_FIREWALL_CHAIN} -s 172.29.0.2/32 -m comment --comment ${input.firewallComment} -j ${input.firewallChainName}`,
        `-A ${__projectEgressPlaneTest.MASTER_FIREWALL_CHAIN} -j RETURN`,
      ].join('\n'),
      projectStatements: projectRules,
    };
    expect(() => attestProjectEgressFirewallStatements(valid)).not.toThrow();
    expect(() => attestProjectEgressFirewallStatements({
      ...valid,
      dockerUserStatements: `-A DOCKER-USER -j ACCEPT\n${valid.dockerUserStatements}`,
    })).toThrow('first DOCKER-USER rule');
    expect(() => attestProjectEgressFirewallStatements({
      ...valid,
      masterStatements: `-A ${__projectEgressPlaneTest.MASTER_FIREWALL_CHAIN} -j RETURN\n${valid.masterStatements}`,
    })).toThrow('missing or shadowed');
    expect(() => attestProjectEgressFirewallStatements({
      ...valid,
      masterStatements: `-A ${__projectEgressPlaneTest.MASTER_FIREWALL_CHAIN} -j ACCEPT\n${valid.masterStatements}`,
    })).toThrow('bypass rule');
    expect(() => attestProjectEgressFirewallStatements({
      ...valid,
      projectStatements: projectRules.replace('100.64.0.0/10', '100.64.0.0/11'),
    })).toThrow('did not match exactly');
    expect(__projectEgressPlaneTest.expectedFirewallRules(input, 6)).toEqual(expect.arrayContaining([
      `-A ${input.firewallChainName} -d 2000::/3 -p tcp -m multiport --dports 80,443 -m comment --comment ${input.firewallComment} -j RETURN`,
      `-A ${input.firewallChainName} -d 3fff::/20 -m comment --comment ${input.firewallComment} -j REJECT`,
    ]));
  });
});

class ExistingPlaneExecutor implements ProjectEgressCommandExecutor {
  readonly commands: Array<{ command: string; args: readonly string[] }> = [];
  readonly input: ProjectEgressPlaneSpec;
  running = true;
  dockerUserRules = ['-A DOCKER-USER -j RETURN'];
  masterRules = [`-A ${__projectEgressPlaneTest.MASTER_FIREWALL_CHAIN} -j RETURN`];
  projectRules: string[] = [];
  inputRules: string[] = ['-A INPUT -j RETURN'];
  hostRules: string[] = [];

  constructor(input: ProjectEgressPlaneSpec) {
    this.input = input;
  }

  async run(command: string, args: readonly string[]): Promise<ProjectEgressCommandResult> {
    this.commands.push({ command, args });
    if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
      return {
        stdout: `${'d'.repeat(64)}\n${'e'.repeat(64)}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
      return { stdout: `${'c'.repeat(64)}\n`, stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
      const reference = String(args[2]);
      const value = [this.input.internalNetworkName, 'd'.repeat(64)].includes(reference)
        ? {
            Id: 'd'.repeat(64),
            Name: this.input.internalNetworkName,
            Driver: 'bridge',
            Internal: true,
            Labels: labelsFor(this.input, 'internal'),
            Containers: {},
            IPAM: { Config: [{ Subnet: '172.30.0.0/24', Gateway: '172.30.0.1' }] },
          }
        : {
          Id: 'e'.repeat(64),
          Name: this.input.publicNetworkName,
          Driver: 'bridge',
          Internal: false,
          Labels: labelsFor(this.input, 'proxy-public'),
          Containers: { proxy: { Name: this.input.proxyContainerName } },
          IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
        };
      return { stdout: JSON.stringify([value]), stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
      return { stdout: JSON.stringify([proxyInspect(this.input, this.running)]), stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'start') this.running = true;
    if (command === 'docker' && args[0] === 'container' && args[1] === 'stop') this.running = false;
    if ((command === 'iptables' || command === 'ip6tables') && args[1] === '-S') {
      const chain = args[2];
      const rules = chain === 'DOCKER-USER'
        ? this.dockerUserRules
        : chain === 'INPUT'
          ? this.inputRules
          : chain === 'P4E-HOST-V1'
            ? this.hostRules
            : chain === __projectEgressPlaneTest.MASTER_FIREWALL_CHAIN
              ? this.masterRules
              : this.projectRules;
      return { stdout: rules.join('\n'), stderr: '', exitCode: 0 };
    }
    if ((command === 'iptables' || command === 'ip6tables') && args[1] === '-I') {
      const chain = args[2];
      const position = Number(args[3]) - 1;
      const rule = `-A ${chain} ${args.slice(4).join(' ')}`;
      const target = chain === 'DOCKER-USER'
        ? this.dockerUserRules
        : chain === 'INPUT'
          ? this.inputRules
          : chain === 'P4E-HOST-V1'
            ? this.hostRules
            : this.masterRules;
      target.splice(position, 0, rule);
    }
    if ((command === 'iptables' || command === 'ip6tables') && args[1] === '-F') this.projectRules = [];
    if ((command === 'iptables' || command === 'ip6tables') && args[1] === '-A') {
      this.projectRules.push(`-A ${args[2]} ${args.slice(3).join(' ')}`);
    }
    if ((command === 'iptables' || command === 'ip6tables') && args[1] === '-D') {
      const chain = args[2];
      const rule = `-A ${chain} ${args.slice(3).join(' ')}`;
      const target = chain === 'P4E-HOST-V1' ? this.hostRules : this.masterRules;
      const index = target.indexOf(rule);
      if (index >= 0) target.splice(index, 1);
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

describe('project egress plane orchestration', () => {
  test('returns only a raw-inventory-proven current plane reinspected by immutable IDs', async () => {
    const input = spec();
    const executor = new ExistingPlaneExecutor(input);

    await expect(attestCurrentProjectEgressPlaneByImmutableIdentity(
      executor,
      input,
    )).resolves.toMatchObject({
      internalNetworkId: 'd'.repeat(64),
      publicNetworkId: 'e'.repeat(64),
      proxyContainerId: 'c'.repeat(64),
    });
    expect(executor.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        args: ['network', 'inspect', 'd'.repeat(64)],
      }),
      expect.objectContaining({
        args: ['network', 'inspect', 'e'.repeat(64)],
      }),
      expect.objectContaining({
        args: ['container', 'inspect', 'c'.repeat(64)],
      }),
    ]));
  });

  test('rejects a final deterministic-name network substitution without mutation', async () => {
    const input = spec();
    const executor = new ExistingPlaneExecutor(input);
    const originalRun = executor.run.bind(executor);
    let namedInternalReads = 0;
    executor.run = async (command, args) => {
      if (command === 'docker'
        && args[0] === 'network'
        && args[1] === 'inspect'
        && args[2] === input.internalNetworkName) {
        namedInternalReads += 1;
        if (namedInternalReads === 2) {
          return {
            stdout: JSON.stringify([{
              Id: 'f'.repeat(64),
              Name: input.internalNetworkName,
              Driver: 'bridge',
              Internal: true,
              Labels: {},
              Containers: {},
            }]),
            stderr: '',
            exitCode: 0,
          };
        }
      }
      return originalRun(command, args);
    };

    await expect(attestCurrentProjectEgressPlaneByImmutableIdentity(
      executor,
      input,
    )).rejects.toMatchObject({ code: 'PLANE_IDENTITY_RACE' });
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'start', 'rm'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('rejects a proxy identity claimant introduced across the final barrier without mutation', async () => {
    const input = spec();
    const executor = new ExistingPlaneExecutor(input);
    const originalRun = executor.run.bind(executor);
    let proxyInventoryReads = 0;
    executor.run = async (command, args) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
        proxyInventoryReads += 1;
        if (proxyInventoryReads === 2) {
          return {
            stdout: `${'c'.repeat(64)}\n${'f'.repeat(64)}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
      }
      return originalRun(command, args);
    };

    await expect(attestCurrentProjectEgressPlaneByImmutableIdentity(
      executor,
      input,
    )).rejects.toMatchObject({ code: 'PLANE_IDENTITY_RACE' });
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'start', 'rm'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('rejects a network identity claimant introduced across the final barrier without mutation', async () => {
    const input = spec();
    const executor = new ExistingPlaneExecutor(input);
    const originalRun = executor.run.bind(executor);
    let networkInventoryReads = 0;
    executor.run = async (command, args) => {
      if (command === 'docker' && args[0] === 'network' && args[1] === 'ls') {
        networkInventoryReads += 1;
        if (networkInventoryReads === 4) {
          return {
            stdout: `${'d'.repeat(64)}\n${'e'.repeat(64)}\n${'f'.repeat(64)}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
      }
      return originalRun(command, args);
    };

    await expect(attestCurrentProjectEgressPlaneByImmutableIdentity(
      executor,
      input,
    )).rejects.toMatchObject({ code: 'PLANE_IDENTITY_RACE' });
    expect(networkInventoryReads).toBe(4);
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'start', 'rm'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('stops the sidecar, installs and attests firewall rules, then starts before returning proxy env', async () => {
    const input = spec();
    const executor = new ExistingPlaneExecutor(input);
    const result = await ensureProjectEgressPlane({
      identity: { actorId: 'user-full-uuid', projectId: 'project-full-uuid', provider: 'codex' },
      proxyImage: IMAGE,
      token: TOKEN,
      extraDeniedCidrs: ['203.0.114.7/32'],
    }, executor);
    expect(executor.running).toBe(true);
    expect(result.policyFingerprint).toBe(input.policyFingerprint);
    expect(result.internalNetworkName).toBe(input.internalNetworkName);
    expect(result.proxyUrl).toBe(`http://portal:${TOKEN}@${input.proxyAlias}:3128`);
    expect(result.proxyEnvironment).toMatchObject({
      HTTP_PROXY: result.proxyUrl,
      HTTPS_PROXY: result.proxyUrl,
      NO_PROXY: '',
    });
    const stopIndex = executor.commands.findIndex(({ args }) => args[0] === 'container' && args[1] === 'stop');
    // Host-input protection may install before the sidecar stops (it does not
    // depend on the proxy address); the proxy-scoped master rules must not.
    const firewallIndex = executor.commands.findIndex(({ command, args }) => (
      command === 'iptables' && args.includes(__projectEgressPlaneTest.MASTER_FIREWALL_CHAIN)
    ));
    const startIndex = executor.commands.findIndex(({ args }) => args[0] === 'container' && args[1] === 'start');
    const hostProtectionIndex = executor.commands.findIndex(({ command, args }) => (
      command === 'iptables' && args.includes('P4E-HOST-V1')
    ));
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(hostProtectionIndex).toBeGreaterThanOrEqual(0);
    expect(firewallIndex).toBeGreaterThan(stopIndex);
    expect(startIndex).toBeGreaterThan(firewallIndex);
    expect(executor.commands[stopIndex].args.at(-1)).toBe('c'.repeat(64));
    expect(executor.commands[startIndex].args).toEqual(['container', 'start', 'c'.repeat(64)]);
    for (const subnet of ['172.30.0.0/24', '172.29.0.0/24']) {
      const established = `-A P4E-HOST-V1 -s ${subnet} -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment ${input.firewallComment} -j ACCEPT`;
      const rejected = `-A P4E-HOST-V1 -s ${subnet} -m comment --comment ${input.firewallComment} -j REJECT`;
      expect(executor.hostRules.filter((rule) => rule === established)).toHaveLength(1);
      expect(executor.hostRules.filter((rule) => rule === rejected)).toHaveLength(1);
      expect(executor.hostRules.indexOf(established)).toBeLessThan(executor.hostRules.indexOf(rejected));
    }
    expect(executor.hostRules.some((rule) => (
      rule.endsWith('-j ACCEPT') && !rule.includes('--ctstate RELATED,ESTABLISHED')
    ))).toBe(false);
  });

  test('never stops, starts, or removes a foreign proxy occupying the current deterministic name', async () => {
    const input = spec();
    const executor = new ExistingPlaneExecutor(input);
    const foreign = proxyInspect(input, true);
    foreign.Id = 'f'.repeat(64);
    foreign.HostConfig.Privileged = true;
    const originalRun = executor.run.bind(executor);
    executor.run = async (command, args) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
        return { stdout: `${foreign.Id}\n`, stderr: '', exitCode: 0 };
      }
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        return { stdout: JSON.stringify([foreign]), stderr: '', exitCode: 0 };
      }
      return originalRun(command, args);
    };

    await expect(ensureProjectEgressPlane({
      identity: { actorId: 'user-full-uuid', projectId: 'project-full-uuid', provider: 'codex' },
      proxyImage: IMAGE,
      token: TOKEN,
      extraDeniedCidrs: ['203.0.114.7/32'],
    }, executor)).rejects.toMatchObject({ code: 'PROXY_HARDENING' });
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'start', 'rm'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('does not mutate a same-name proxy replacement that appears before the initial stop', async () => {
    const input = spec();
    const executor = new ExistingPlaneExecutor(input);
    const oldContainerId = 'c'.repeat(64);
    const replacement = proxyInspect(input, true);
    replacement.Id = 'f'.repeat(64);
    replacement.HostConfig.Privileged = true;
    const originalRun = executor.run.bind(executor);
    let containerInspectCount = 0;
    let replacementInstalled = false;
    executor.run = async (command, args) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        containerInspectCount += 1;
        if (containerInspectCount >= 2) replacementInstalled = true;
        if (replacementInstalled && String(args[2]) === oldContainerId) {
          return {
            stdout: '',
            stderr: `Error response from daemon: No such container: ${oldContainerId}`,
            exitCode: 1,
          };
        }
        if (replacementInstalled && String(args[2]) === input.proxyContainerName) {
          return { stdout: JSON.stringify([replacement]), stderr: '', exitCode: 0 };
        }
      }
      return originalRun(command, args);
    };

    await expect(ensureProjectEgressPlane({
      identity: { actorId: 'user-full-uuid', projectId: 'project-full-uuid', provider: 'codex' },
      proxyImage: IMAGE,
      token: TOKEN,
      extraDeniedCidrs: ['203.0.114.7/32'],
    }, executor)).rejects.toMatchObject({ code: 'PROXY_RACE' });
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'start', 'rm'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('does not start a same-name proxy replacement that appears at the pre-start re-attestation', async () => {
    const input = spec();
    const executor = new ExistingPlaneExecutor(input);
    const oldContainerId = 'c'.repeat(64);
    const replacement = proxyInspect(input, false);
    replacement.Id = 'f'.repeat(64);
    replacement.HostConfig.Privileged = true;
    const originalRun = executor.run.bind(executor);
    let containerInspectCount = 0;
    let replacementInstalled = false;
    executor.run = async (command, args) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        containerInspectCount += 1;
        if (containerInspectCount >= 4) replacementInstalled = true;
        if (replacementInstalled && String(args[2]) === oldContainerId) {
          return {
            stdout: '',
            stderr: `Error response from daemon: No such container: ${oldContainerId}`,
            exitCode: 1,
          };
        }
        if (replacementInstalled && String(args[2]) === input.proxyContainerName) {
          return { stdout: JSON.stringify([replacement]), stderr: '', exitCode: 0 };
        }
      }
      return originalRun(command, args);
    };

    await expect(ensureProjectEgressPlane({
      identity: { actorId: 'user-full-uuid', projectId: 'project-full-uuid', provider: 'codex' },
      proxyImage: IMAGE,
      token: TOKEN,
      extraDeniedCidrs: ['203.0.114.7/32'],
    }, executor)).rejects.toMatchObject({ code: 'PROXY_RACE' });
    expect(executor.commands.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'stop'
    ))).toEqual([
      expect.objectContaining({ args: ['container', 'stop', '--time', '1', oldContainerId] }),
    ]);
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && ['start', 'rm'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('catch cleanup does not stop a same-name replacement after the attested proxy starts', async () => {
    const input = spec();
    const executor = new ExistingPlaneExecutor(input);
    const oldContainerId = 'c'.repeat(64);
    const replacement = proxyInspect(input, true);
    replacement.Id = 'f'.repeat(64);
    replacement.HostConfig.Privileged = true;
    const originalRun = executor.run.bind(executor);
    let started = false;
    let postStartReattested = false;
    let replacementInstalled = false;
    executor.run = async (command, args) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'start') {
        const result = await originalRun(command, args);
        started = true;
        return result;
      }
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        if (replacementInstalled && String(args[2]) === oldContainerId) {
          return {
            stdout: '',
            stderr: `Error response from daemon: No such container: ${oldContainerId}`,
            exitCode: 1,
          };
        }
        if (replacementInstalled && String(args[2]) === input.proxyContainerName) {
          return { stdout: JSON.stringify([replacement]), stderr: '', exitCode: 0 };
        }
        const result = await originalRun(command, args);
        if (started) postStartReattested = true;
        return result;
      }
      if (command === 'docker' && args[0] === 'network' && args[1] === 'inspect'
        && String(args[2]) === input.publicNetworkName && postStartReattested) {
        replacementInstalled = true;
        return {
          stdout: JSON.stringify([{
            Id: 'e'.repeat(64),
            Name: input.publicNetworkName,
            Driver: 'bridge',
            Internal: false,
            Labels: labelsFor(input, 'proxy-public'),
            Containers: {
              proxy: { Name: input.proxyContainerName },
              foreign: { Name: 'foreign-container' },
            },
            IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
          }]),
          stderr: '',
          exitCode: 0,
        };
      }
      return originalRun(command, args);
    };

    await expect(ensureProjectEgressPlane({
      identity: { actorId: 'user-full-uuid', projectId: 'project-full-uuid', provider: 'codex' },
      proxyImage: IMAGE,
      token: TOKEN,
      extraDeniedCidrs: ['203.0.114.7/32'],
    }, executor)).rejects.toMatchObject({ code: 'NETWORK_MEMBERSHIP' });
    expect(executor.commands.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'stop'
    ))).toEqual([
      expect.objectContaining({ args: ['container', 'stop', '--time', '1', oldContainerId] }),
    ]);
    expect(executor.commands.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'start'
    ))).toEqual([
      expect.objectContaining({ args: ['container', 'start', oldContainerId] }),
    ]);
    expect(executor.commands.some(({ args }) => args[0] === 'container' && args[1] === 'rm')).toBe(false);
  });

  test('leaves the sidecar stopped when firewall attestation cannot be proven', async () => {
    const input = spec();
    const executor = new ExistingPlaneExecutor(input);
    executor.dockerUserRules = ['-A DOCKER-USER -j ACCEPT'];
    const originalRun = executor.run.bind(executor);
    executor.run = async (command, args) => {
      if (command === 'iptables' && args[1] === '-I' && args[2] === 'DOCKER-USER') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return originalRun(command, args);
    };
    await expect(ensureProjectEgressPlane({
      identity: { actorId: 'user-full-uuid', projectId: 'project-full-uuid', provider: 'codex' },
      proxyImage: IMAGE,
      token: TOKEN,
      extraDeniedCidrs: ['203.0.114.7/32'],
    }, executor)).rejects.toThrow(ProjectEgressAttestationError);
    expect(executor.running).toBe(false);
  });
});
