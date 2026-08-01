import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../../../AgentProvider.interface';
import {
  PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL,
  buildProjectEgressPlaneSpec,
  derivePreConfinementProjectEgressPolicyFingerprint,
  type ProjectEgressCommandExecutor,
  type ProjectEgressCommandResult,
  type ProjectEgressPlaneConfig,
  type ProjectEgressPlaneSpec,
} from '../../../../services/projectEgressPlane';
import { PROJECT_EGRESS_POLICY_VERSION } from '../../../../services/projectEgressPolicy';
import {
  NATIVE_CLI_PROJECT_CONTAINER_HOME,
  NATIVE_CLI_PROJECT_CONTAINER_ROOT,
  NATIVE_CLI_PROJECT_CONTAINER_USER,
  NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL,
  NativeCliProjectEgressRuntimeError,
  __nativeCliProjectEgressRuntimeTest,
  abortNativeCliProjectTurn,
  attestNativeCliProjectNamespaceFirewall,
  attestNativeCliProjectRuntimeContainer,
  buildNativeCliProjectInvocation,
  buildNativeCliProjectRuntimePlan,
  ensureNativeCliProjectEgressRuntime,
  nativeCliProjectDockerHostEnvironment,
  type NativeCliProjectRuntimePlan,
  type NativeCliProjectRuntimeProfile,
} from './NativeCliProjectEgressRuntime';

const RUNTIME_IMAGE = `sha256:${'a'.repeat(64)}`;
const PROXY_IMAGE = `sha256:${'b'.repeat(64)}`;
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789_-';
const PROXY_ADDRESS = '172.31.20.2';
const INTERNAL_NETWORK_ID = '8'.repeat(64);
const PROFILE: NativeCliProjectRuntimeProfile = Object.freeze({
  provider: 'CLAUDE_CODE',
  displayName: 'Claude Code',
  runtime: 'claude-code-project-adapter',
  containerNamePrefix: 'p4cc',
  runtimePolicyVersion: 'portal-claude-code-project-sandbox-v1',
  cliPath: '/usr/local/bin/claude',
  allowLoopback: false,
  environment: Object.freeze({ DISABLE_TELEMETRY: '1' }),
});
const GEMINI_PROFILE: NativeCliProjectRuntimeProfile = Object.freeze({
  ...PROFILE,
  provider: 'GEMINI',
  displayName: 'Google Antigravity',
  runtime: 'antigravity-project-adapter',
  containerNamePrefix: 'p4ag',
  runtimePolicyVersion: 'portal-antigravity-project-sandbox-v1',
  cliPath: '/usr/local/bin/agy',
});

// Mirror of the kernel-owned context policy fingerprint derivation; stale
// reconstruction recomputes this from the inspected image, so fixtures must
// carry the real derivation rather than a placeholder value.
function contextPolicyFingerprint(context: {
  userId: string;
  projectId: string;
  workspaceOwnerId: string;
  projectName: string;
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  runtimePolicyVersion: string;
  egressPolicyVersion: string;
  runtimeImageDigest: string;
}, profile: NativeCliProjectRuntimeProfile): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: context.runtimePolicyVersion,
    egressPolicyVersion: context.egressPolicyVersion,
    provider: profile.provider,
    runtime: profile.runtime,
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

interface Fixture {
  root: string;
  projectRoot: string;
  stateRoot: string;
  authPath: string;
  settingsPath: string;
  context: ProjectSandboxExecutionContext;
  egress: ProjectEgressPlaneConfig;
  spec: ProjectEgressPlaneSpec;
  plan: NativeCliProjectRuntimePlan;
}

function makeFixture(profile: NativeCliProjectRuntimeProfile = PROFILE): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cli-project-egress-test-'));
  const projectRoot = path.join(root, 'project');
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(projectRoot, { mode: 0o700 });
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  const authPath = path.join(stateRoot, 'auth.json');
  const settingsPath = path.join(stateRoot, 'settings.json');
  fs.writeFileSync(authPath, '{"oauth":true}', { mode: 0o400 });
  fs.writeFileSync(settingsPath, '{"sandbox":true}', { mode: 0o400 });
  fs.chownSync(authPath, 1000, 1000);
  fs.chownSync(settingsPath, 1000, 1000);
  const stat = fs.lstatSync(projectRoot, { bigint: true });
  const contextSeed = {
    scope: 'PROJECT_SANDBOX',
    source: 'PORTAL_SERVER',
    userId: 'actor-full-uuid',
    projectId: 'project-full-uuid',
    workspaceOwnerId: 'owner-full-uuid',
    projectName: 'demo',
    canonicalRoot: fs.realpathSync(projectRoot),
    rootDevice: stat.dev.toString(),
    rootInode: stat.ino.toString(),
    rootBirthtimeNs: stat.birthtimeNs.toString(),
    runtimePolicyVersion: profile.runtimePolicyVersion,
    egressPolicyVersion: PROJECT_EGRESS_POLICY_VERSION,
    runtimeImageDigest: RUNTIME_IMAGE,
  } as const;
  const context: ProjectSandboxExecutionContext = Object.freeze({
    ...contextSeed,
    policyFingerprint: contextPolicyFingerprint(contextSeed, profile),
  });
  const egress: ProjectEgressPlaneConfig = {
    identity: { actorId: context.userId, projectId: context.projectId, provider: profile.provider },
    proxyImage: PROXY_IMAGE,
    token: TOKEN,
  };
  const spec = buildProjectEgressPlaneSpec(egress);
  const plan = buildNativeCliProjectRuntimePlan({
    context,
    profile,
    spec,
    proxyAddress: PROXY_ADDRESS,
    internalNetworkId: INTERNAL_NETWORK_ID,
  });
  return { root, projectRoot, stateRoot, authPath, settingsPath, context, egress, spec, plan };
}

function inspectFor(fixture: Fixture, running = true): any {
  return {
    Id: 'd'.repeat(64),
    Image: fixture.plan.runtimeImage,
    Name: `/${fixture.plan.containerName}`,
    Config: {
      Image: fixture.plan.runtimeImage,
      User: NATIVE_CLI_PROJECT_CONTAINER_USER,
      Env: [
        ...Object.entries(fixture.plan.expectedEnvironment).map(([key, value]) => `${key}=${value}`),
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ],
      Cmd: ['-e', __nativeCliProjectEgressRuntimeTest.IDLE_SCRIPT],
      Entrypoint: ['node'],
      Labels: { ...fixture.plan.expectedLabels },
      WorkingDir: NATIVE_CLI_PROJECT_CONTAINER_ROOT,
      ExposedPorts: {},
      Volumes: {},
    },
    State: {
      Running: running,
      Pid: running ? 4242 : 0,
      StartedAt: running ? '2026-07-20T12:00:00Z' : '0001-01-01T00:00:00Z',
    },
    HostConfig: {
      Init: true,
      ReadonlyRootfs: true,
      CapAdd: [],
      CapDrop: ['ALL'],
      SecurityOpt: [
        'no-new-privileges:true',
        'seccomp=/etc/bridgesllm/project-runtime/bridgesllm-project-runtime-v1.seccomp.json',
        'apparmor=bridgesllm-project-runtime-v1',
      ],
      Binds: [`${fixture.projectRoot}:${NATIVE_CLI_PROJECT_CONTAINER_ROOT}:rw,rprivate`],
      Mounts: [],
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,nodev,size=134217728,uid=1000,gid=1000,mode=0700',
        '/run': 'rw,noexec,nosuid,nodev,size=16777216,uid=1000,gid=1000,mode=0700',
        [NATIVE_CLI_PROJECT_CONTAINER_HOME]: 'rw,noexec,nosuid,nodev,size=268435456,uid=1000,gid=1000,mode=0700',
      },
      PortBindings: {},
      PublishAllPorts: false,
      NetworkMode: fixture.plan.networkMode,
      Privileged: false,
      PidMode: '',
      IpcMode: '',
      UTSMode: '',
      UsernsMode: '',
      CgroupnsMode: 'private',
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
      OomKillDisable: false,
      PidsLimit: 256,
      Memory: 1024 * 1024 * 1024,
      MemorySwap: 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
      Ulimits: [
        { Name: 'nofile', Soft: 1024, Hard: 1024 },
        { Name: 'nproc', Soft: 256, Hard: 256 },
      ],
      Devices: [],
      DeviceRequests: [],
      DeviceCgroupRules: [],
      Dns: [],
      DnsOptions: [],
      DnsSearch: [],
      ExtraHosts: [],
      Links: [],
      VolumesFrom: [],
    },
    AppArmorProfile: 'bridgesllm-project-runtime-v1',
    Mounts: [{
      Type: 'bind',
      Source: fixture.projectRoot,
      Destination: NATIVE_CLI_PROJECT_CONTAINER_ROOT,
      Mode: 'rw,rprivate',
      RW: true,
      Propagation: 'rprivate',
    }],
    NetworkSettings: {
      Ports: {},
      Networks: {
        [fixture.spec.internalNetworkName]: {
          IPAddress: '172.31.20.3',
          NetworkID: running ? fixture.plan.internalNetworkId : '',
        },
      },
    },
  };
}

function legacyPreConfinementFixture(fixture: Fixture): Fixture {
  const runtimeFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    provider: fixture.plan.profile.provider,
    profile: fixture.plan.profile,
    actorId: fixture.context.userId,
    projectId: fixture.context.projectId,
    workspaceOwnerId: fixture.context.workspaceOwnerId,
    policyFingerprint: fixture.context.policyFingerprint,
    runtimePolicyVersion: fixture.context.runtimePolicyVersion,
    egressPolicyVersion: fixture.context.egressPolicyVersion,
    egressPolicyFingerprint: derivePreConfinementProjectEgressPolicyFingerprint(fixture.spec),
    egressProxyCredentialHash: fixture.spec.tokenHash,
    runtimeImage: fixture.plan.runtimeImage,
    projectRoot: fixture.plan.projectRoot,
    user: NATIVE_CLI_PROJECT_CONTAINER_USER,
  })).digest('hex');
  return {
    ...fixture,
    plan: {
      ...fixture.plan,
      containerName: `${fixture.plan.profile.containerNamePrefix}-${runtimeFingerprint.slice(0, 24)}`,
      runtimeFingerprint,
      networkMode: fixture.spec.internalNetworkName,
      expectedLabels: {
        ...fixture.plan.expectedLabels,
        [PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL]: runtimeFingerprint,
        [__nativeCliProjectEgressRuntimeTest.constants.RUNTIME_EGRESS_LABEL]:
          derivePreConfinementProjectEgressPolicyFingerprint(fixture.spec),
      },
    },
  };
}

function legacyPreConfinementInspect(fixture: Fixture, running = true): any {
  const inspect = inspectFor(legacyPreConfinementFixture(fixture), running);
  inspect.HostConfig.SecurityOpt = ['no-new-privileges:true'];
  inspect.AppArmorProfile = 'docker-default';
  return inspect;
}

function currentNameModeInspect(fixture: Fixture, running: boolean): any {
  const historical = {
    ...fixture,
    plan: {
      ...fixture.plan,
      networkMode: fixture.spec.internalNetworkName,
    },
  };
  const inspect = inspectFor(historical, running);
  inspect.NetworkSettings.Networks[fixture.spec.internalNetworkName].NetworkID =
    INTERNAL_NETWORK_ID;
  return inspect;
}

function validFirewall(allowLoopback = false): { ipv4: string; ipv6: string } {
  const loopbackInput = allowLoopback ? ['-A INPUT -i lo -j ACCEPT'] : [];
  const loopbackOutput = allowLoopback ? ['-A OUTPUT -o lo -j ACCEPT'] : [];
  return {
    ipv4: [
      '-P INPUT DROP',
      '-P FORWARD DROP',
      '-P OUTPUT DROP',
      ...loopbackInput,
      `-A INPUT -s ${PROXY_ADDRESS}/32 -p tcp -m tcp --sport 3128 -m conntrack --ctstate ESTABLISHED -j ACCEPT`,
      ...loopbackOutput,
      `-A OUTPUT -d ${PROXY_ADDRESS}/32 -p tcp -m tcp --dport 3128 -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT`,
    ].join('\n'),
    ipv6: [
      '-P INPUT DROP',
      '-P FORWARD DROP',
      '-P OUTPUT DROP',
      ...loopbackInput,
      ...loopbackOutput,
    ].join('\n'),
  };
}

describe('shared native CLI Project controlled-egress runtime policy', () => {
  const fixtures: Fixture[] = [];
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test('builds a pinned, non-root runtime with one Project bind and no host resource', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    expect(fixture.plan.createArgs).toEqual(expect.arrayContaining([
      '--network', INTERNAL_NETWORK_ID,
      '--user', NATIVE_CLI_PROJECT_CONTAINER_USER,
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true',
      '--init',
      '--volume', `${fixture.projectRoot}:${NATIVE_CLI_PROJECT_CONTAINER_ROOT}:rw,rprivate`,
      fixture.plan.runtimeImage,
    ]));
    expect(fixture.plan.createArgs.join(' ')).not.toContain('/var/run/docker.sock');
    expect(fixture.plan.expectedLabels[NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL]).toBe('CLAUDE_CODE');
    expect(fixture.plan.expectedEnvironment).toMatchObject({
      HTTP_PROXY: `http://portal:${TOKEN}@${PROXY_ADDRESS}:3128`,
      HTTPS_PROXY: `http://portal:${TOKEN}@${PROXY_ADDRESS}:3128`,
      NO_PROXY: '',
      no_proxy: '',
    });
  });

  test('attests the exact stopped and running runtime', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    expect(attestNativeCliProjectRuntimeContainer({
      inspect: inspectFor(fixture, false), plan: fixture.plan, spec: fixture.spec, requireRunning: false,
    })).toMatchObject({ containerId: 'd'.repeat(64), pid: 0 });
    expect(attestNativeCliProjectRuntimeContainer({
      inspect: inspectFor(fixture, true), plan: fixture.plan, spec: fixture.spec, requireRunning: true,
    })).toMatchObject({ containerId: 'd'.repeat(64), pid: 4242 });
  });

  test.each([
    ['Claude Code', PROFILE],
    ['Google Antigravity', GEMINI_PROFILE],
  ])('attests %s when Docker returns the exact ulimits in either order', (_label, profile) => {
    const fixture = makeFixture(profile);
    fixtures.push(fixture);
    const inspect = inspectFor(fixture, true);
    inspect.HostConfig.Ulimits = inspect.HostConfig.Ulimits
      .slice()
      .reverse()
      .map(({ Name, Soft, Hard }: any) => ({ Name, Hard, Soft }));
    expect(attestNativeCliProjectRuntimeContainer({
      inspect,
      plan: fixture.plan,
      spec: fixture.spec,
      requireRunning: true,
    })).toMatchObject({ containerId: 'd'.repeat(64), pid: 4242 });
  });

  test.each([
    ['image', (value: any) => { value.Image = `sha256:${'e'.repeat(64)}`; }],
    ['root user', (value: any) => { value.Config.User = 'root'; }],
    ['missing init subreaper', (value: any) => { value.HostConfig.Init = false; }],
    ['mutable root', (value: any) => { value.HostConfig.ReadonlyRootfs = false; }],
    ['capability', (value: any) => { value.HostConfig.CapAdd = ['NET_ADMIN']; }],
    ['missing no-new-privileges', (value: any) => { value.HostConfig.SecurityOpt = []; }],
    ['wrong seccomp profile', (value: any) => { value.HostConfig.SecurityOpt[1] = 'seccomp=/tmp/foreign.json'; }],
    ['wrong AppArmor profile', (value: any) => { value.AppArmorProfile = 'docker-default'; }],
    ['host namespace', (value: any) => { value.HostConfig.PidMode = 'host'; }],
    ['container namespace join', (value: any) => { value.HostConfig.IpcMode = `container:${'f'.repeat(64)}`; }],
    ['extra capability drop', (value: any) => { value.HostConfig.CapDrop = ['ALL', 'SYS_ADMIN']; }],
    ['restart policy', (value: any) => { value.HostConfig.RestartPolicy.Name = 'always'; }],
    ['resource limit', (value: any) => { value.HostConfig.Memory = 0; }],
    ['weak private home', (value: any) => { value.HostConfig.Tmpfs[NATIVE_CLI_PROJECT_CONTAINER_HOME] = 'rw'; }],
    ['conflicting tmpfs flag', (value: any) => {
      value.HostConfig.Tmpfs[NATIVE_CLI_PROJECT_CONTAINER_HOME] += ',exec';
    }],
    ['device', (value: any) => { value.HostConfig.Devices = [{}]; }],
    ['published port', (value: any) => { value.HostConfig.PortBindings = { '80/tcp': [{}] }; }],
    ['host DNS', (value: any) => { value.HostConfig.Dns = ['8.8.8.8']; }],
    ['sibling mount', (value: any) => { value.Mounts.push({ Type: 'bind', Source: '/other', Destination: '/other', RW: true }); }],
    ['read-only Project', (value: any) => { value.Mounts[0].RW = false; }],
    ['lateral network', (value: any) => { value.NetworkSettings.Networks.bridge = {}; }],
    ['container network mode', (value: any) => { value.HostConfig.NetworkMode = `container:${'f'.repeat(64)}`; }],
    ['missing proxy', (value: any) => { value.Config.Env = value.Config.Env.filter((item: string) => !item.startsWith('HTTPS_PROXY=')); }],
    ['NO_PROXY bypass', (value: any) => {
      value.Config.Env = value.Config.Env.map((item: string) => item === 'NO_PROXY=' ? 'NO_PROXY=localhost' : item);
    }],
    ['host credential', (value: any) => { value.Config.Env.push('ANTHROPIC_API_KEY=secret'); }],
    ['runtime label', (value: any) => { value.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] = 'wrong'; }],
  ])('fails closed for runtime drift: %s', (_label, mutate) => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const inspect = inspectFor(fixture, true);
    mutate(inspect);
    expect(() => attestNativeCliProjectRuntimeContainer({
      inspect, plan: fixture.plan, spec: fixture.spec, requireRunning: true,
    })).toThrow(NativeCliProjectEgressRuntimeError);
  });

  test('firewall permits only proxy egress and optional container-local loopback', () => {
    expect(() => attestNativeCliProjectNamespaceFirewall({
      proxyAddress: PROXY_ADDRESS,
      allowLoopback: false,
      ...validFirewall(false),
    })).not.toThrow();
    expect(() => attestNativeCliProjectNamespaceFirewall({
      proxyAddress: PROXY_ADDRESS,
      allowLoopback: true,
      ...validFirewall(true),
    })).not.toThrow();
    const drifted = validFirewall(false);
    expect(() => attestNativeCliProjectNamespaceFirewall({
      proxyAddress: PROXY_ADDRESS,
      allowLoopback: false,
      ...drifted,
      ipv4: `${drifted.ipv4}\n-A OUTPUT -d 169.254.169.254/32 -j ACCEPT`,
    })).toThrow('IPv4 namespace firewall');
  });

  test('invocation uses the full container ID, fixed command, private pid identity, and hard abort hook', async () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const executor: ProjectEgressCommandExecutor = {
      run: async (command, args) => {
        calls.push({ command, args });
        if (args[1] === 'inspect') {
          return {
            stdout: JSON.stringify([{
              Id: runtime.containerId,
              State: { Running: true, StartedAt: runtime.startedAt },
            }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const runtime = {
      provider: 'CLAUDE_CODE' as const,
      containerId: 'd'.repeat(64),
      containerName: fixture.plan.containerName,
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
      egressPolicyFingerprint: fixture.spec.policyFingerprint,
      proxyAddress: PROXY_ADDRESS,
      proxyEnvironment: Object.freeze({}),
      startedAt: '2026-07-20T12:00:00Z',
    };
    const invocation = buildNativeCliProjectInvocation({
      runtime,
      profile: PROFILE,
      command: PROFILE.cliPath,
      args: ['--version'],
      turnId: 'durable-turn-id',
      executor,
    });
    expect(invocation.command).toBe('docker');
    expect(invocation.args).toEqual(expect.arrayContaining([
      'container', 'exec', '--user', NATIVE_CLI_PROJECT_CONTAINER_USER,
      '--workdir', NATIVE_CLI_PROJECT_CONTAINER_ROOT,
      runtime.containerId, 'node', '-e',
    ]));
    expect(invocation.args).toContain(PROFILE.cliPath);
    expect(invocation.args.join(' ')).not.toContain(TOKEN);
    expect(invocation.args).not.toEqual(expect.arrayContaining(['--mount']));
    expect(invocation.args).not.toEqual(expect.arrayContaining(['--volume']));
    expect(invocation.args).not.toEqual(expect.arrayContaining(['--privileged']));
    expect(invocation.args).not.toEqual(expect.arrayContaining(['--pid']));
    expect(invocation.args.join(' ')).not.toContain('/var/run/docker.sock');
    await invocation.abort?.();
    expect(calls).toHaveLength(2);
    expect(calls[0].args.slice(0, 2)).toEqual(['container', 'inspect']);
    expect(calls[1]).toMatchObject({ command: 'docker' });
    expect(calls[1].args.join(' ')).toContain('/run/portal-project-run-claude-code-');
    expect(nativeCliProjectDockerHostEnvironment()).toEqual({
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/nonexistent',
      DOCKER_CONFIG: '/nonexistent',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    });
  });

  test('rejects a mismatched provider command at the invocation boundary', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    expect(() => buildNativeCliProjectInvocation({
      runtime: {
        provider: 'CLAUDE_CODE',
        containerId: 'd'.repeat(64),
        containerName: fixture.plan.containerName,
        runtimeFingerprint: fixture.plan.runtimeFingerprint,
        egressPolicyFingerprint: fixture.spec.policyFingerprint,
        proxyAddress: PROXY_ADDRESS,
        proxyEnvironment: {},
        startedAt: 'now',
      },
      profile: PROFILE,
      command: '/bin/sh',
      args: [],
      turnId: 'turn',
    })).toThrow('attested provider profile');
  });

  test('abort boundary rejects arbitrary pid paths without running Docker', async () => {
    const executor = { run: jest.fn() } as unknown as ProjectEgressCommandExecutor;
    await expect(abortNativeCliProjectTurn({
      runtime: {
        containerId: 'd'.repeat(64),
        startedAt: 'now',
      },
      containerUser: NATIVE_CLI_PROJECT_CONTAINER_USER,
      containerRoot: NATIVE_CLI_PROJECT_CONTAINER_ROOT,
      identity: {
        markerPath: '/workspace/project/evil.pid',
        runHash: 'a'.repeat(64),
        runToken: 'b'.repeat(64),
      },
      executor,
    })).rejects.toThrow('abort identity');
    expect(executor.run).not.toHaveBeenCalled();
  });
});

class RuntimeExecutor implements ProjectEgressCommandExecutor {
  readonly commands: Array<{ command: string; args: readonly string[]; input?: string }> = [];
  readonly staleRuntimes = new Map<string, any>();
  exists = false;
  running = false;

  constructor(readonly fixture: Fixture) {}

  addStaleRuntime(inspect: any): void {
    this.staleRuntimes.set(String(inspect.Name || '').replace(/^\//, ''), inspect);
  }

  private staleRuntime(reference: string): any | null {
    return [...this.staleRuntimes.values()].find((inspect) => (
      String(inspect.Name || '').replace(/^\//, '') === reference || inspect.Id === reference
    )) || null;
  }

  async run(
    command: string,
    args: readonly string[],
    options: { allowExitCodes?: readonly number[]; input?: string } = {},
  ): Promise<ProjectEgressCommandResult> {
    this.commands.push({ command, args, input: options.input });
    if (command === 'docker' && args[0] === 'container' && args[1] === 'ls') {
      if (args[args.indexOf('--format') + 1] === '{{.ID}}') {
        const ids = [
          ...(this.exists ? ['d'.repeat(64)] : []),
          ...[...this.staleRuntimes.values()].map((inspect) => String(inspect.Id || '')),
        ].sort();
        return { stdout: ids.join('\n'), stderr: '', exitCode: 0 };
      }
      const names = [
        ...(this.exists ? [this.fixture.plan.containerName] : []),
        ...this.staleRuntimes.keys(),
      ].sort();
      return { stdout: names.join('\n'), stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
      const name = String(args[2]);
      if (name === this.fixture.spec.proxyContainerName) {
        return {
          stdout: JSON.stringify([{
            Id: 'f'.repeat(64),
            NetworkSettings: {
              Networks: { [this.fixture.spec.internalNetworkName]: { IPAddress: PROXY_ADDRESS } },
            },
          }]),
          stderr: '',
          exitCode: 0,
        };
      }
      const stale = this.staleRuntime(name);
      if (stale) return { stdout: JSON.stringify([stale]), stderr: '', exitCode: 0 };
      const isCurrent = name === this.fixture.plan.containerName || name === 'd'.repeat(64);
      if (!this.exists || !isCurrent) {
        return {
          stdout: '',
          stderr: `Error response from daemon: No such container: ${name}`,
          exitCode: 1,
        };
      }
      return { stdout: JSON.stringify([inspectFor(this.fixture, this.running)]), stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'create') {
      this.exists = true;
      return { stdout: `${'d'.repeat(64)}\n`, stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'start') this.running = true;
    if (command === 'docker' && args[0] === 'container' && args[1] === 'stop') {
      const stale = this.staleRuntime(String(args.at(-1)));
      if (stale) {
        stale.State.Running = false;
        stale.State.Pid = 0;
      } else {
        this.running = false;
      }
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'rm') {
      const stale = this.staleRuntime(String(args.at(-1)));
      if (stale) this.staleRuntimes.delete(String(stale.Name || '').replace(/^\//, ''));
    }
    if (command === '/usr/bin/nsenter' && args.includes('-S')) {
      const tool = String(args[4]);
      const firewall = validFirewall(this.fixture.plan.profile.allowLoopback);
      return { stdout: tool === 'iptables' ? firewall.ipv4 : firewall.ipv6, stderr: '', exitCode: 0 };
    }
    if (command === 'docker' && args[0] === 'container' && args[1] === 'exec' && args.includes('node')) {
      const expected = [
        { path: `${NATIVE_CLI_PROJECT_CONTAINER_HOME}/auth.json`, source: this.fixture.authPath },
        { path: `${NATIVE_CLI_PROJECT_CONTAINER_HOME}/settings.json`, source: this.fixture.settingsPath },
      ];
      return {
        stdout: JSON.stringify(expected.map((entry) => ({
          path: entry.path,
          hash: crypto.createHash('sha256').update(fs.readFileSync(entry.source)).digest('hex'),
          uid: 1000,
          gid: 1000,
          mode: 0o400,
          file: true,
          symlink: false,
        }))),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

describe('shared native CLI Project runtime orchestration', () => {
  let fixture: Fixture;

  beforeEach(() => { fixture = makeFixture(); });
  afterEach(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  function managedStateInput() {
    return {
      context: fixture.context,
      profile: fixture.plan.profile,
      egress: fixture.egress,
      prepareManagedState: () => [
        { sourcePath: fixture.authPath, targetPath: `${NATIVE_CLI_PROJECT_CONTAINER_HOME}/auth.json`, label: 'auth' },
        { sourcePath: fixture.settingsPath, targetPath: `${NATIVE_CLI_PROJECT_CONTAINER_HOME}/settings.json`, label: 'settings' },
      ],
    };
  }

  function orchestrationDependencies(
    executor: RuntimeExecutor,
    constrainRuntime: (input: any) => Promise<void> = jest.fn(async () => undefined),
  ) {
    const encodedToken = encodeURIComponent(fixture.egress.token);
    const proxyUrl = `http://portal:${encodedToken}@${fixture.spec.proxyAlias}:3128`;
    return {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      resolveInternalNetworkBinding: jest.fn(async () => ({
        networkId: INTERNAL_NETWORK_ID,
        generation: 'CURRENT' as const,
      })),
      ensureEgressPlane: jest.fn(async () => ({
        policyVersion: PROJECT_EGRESS_POLICY_VERSION,
        policyFingerprint: fixture.spec.policyFingerprint,
        internalNetworkName: fixture.spec.internalNetworkName,
        internalNetworkId: INTERNAL_NETWORK_ID,
        publicNetworkName: fixture.spec.publicNetworkName,
        proxyContainerName: fixture.spec.proxyContainerName,
        proxyUrl,
        proxyEnvironment: {
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          NO_PROXY: '',
          no_proxy: '',
        },
      })),
      constrainRuntime,
    };
  }

  test.each([
    ['Claude Code', PROFILE],
    ['Google Antigravity', GEMINI_PROFILE],
  ])('retires only an exact prior managed %s generation before creating the new fingerprint', async (
    _label,
    profile,
  ) => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fixture = makeFixture(profile);
    const executor = new RuntimeExecutor(fixture);
    const stalePlan = legacyPreConfinementFixture(fixture).plan;
    expect(stalePlan.containerName).not.toBe(fixture.plan.containerName);
    const staleInspect = legacyPreConfinementInspect(fixture);
    staleInspect.Id = 'e'.repeat(64);
    executor.addStaleRuntime(staleInspect);

    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      orchestrationDependencies(executor),
    )).resolves.toMatchObject({
      containerName: fixture.plan.containerName,
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });

    const stop = executor.commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'stop' && args.at(-1) === 'e'.repeat(64)
    ));
    const remove = executor.commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'rm' && args.at(-1) === 'e'.repeat(64)
    ));
    const create = executor.commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'create'
    ));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(stop);
    expect(create).toBeGreaterThan(remove);
    const listing = executor.commands.find(({ args }) => (
      args[0] === 'container' && args[1] === 'ls'
    ));
    expect(listing?.args).toEqual(expect.arrayContaining([
      '--filter', `label=${NATIVE_CLI_PROJECT_RUNTIME_PROVIDER_LABEL}=${profile.provider}`,
      '--filter', expect.stringContaining('com.bridgesllm.native-cli-project.actor='),
      '--filter', expect.stringContaining('com.bridgesllm.native-cli-project.project='),
    ]));
    expect(executor.commands.filter(({ args }) => args[1] === 'rm')).toEqual([
      expect.objectContaining({ args: ['container', 'rm', 'e'.repeat(64)] }),
    ]);
    expect(executor.commands.some(({ args }) => args.includes('--force'))).toBe(false);
  });

  function imageVariantFixture(base: Fixture, runtimeImageDigest: string): Fixture {
    const profile = base.plan.profile;
    const seed = { ...base.context, runtimeImageDigest };
    const context: ProjectSandboxExecutionContext = Object.freeze({
      ...seed,
      policyFingerprint: contextPolicyFingerprint(seed, profile),
    });
    return {
      ...base,
      context,
      plan: buildNativeCliProjectRuntimePlan({
        context,
        profile,
        spec: base.spec,
        proxyAddress: PROXY_ADDRESS,
        internalNetworkId: INTERNAL_NETWORK_ID,
      }),
    };
  }

  test.each([
    ['Claude Code', PROFILE],
    ['Google Antigravity', GEMINI_PROFILE],
  ])('retires a stale %s runtime created from a since-rebuilt sandbox image', async (
    _label,
    profile,
  ) => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fixture = makeFixture(profile);
    const executor = new RuntimeExecutor(fixture);
    const rebuiltAway = imageVariantFixture(fixture, `sha256:${'9'.repeat(64)}`);
    expect(rebuiltAway.plan.runtimeFingerprint).not.toBe(fixture.plan.runtimeFingerprint);
    const stale = inspectFor(rebuiltAway, true);
    stale.Id = 'e'.repeat(64);
    executor.addStaleRuntime(stale);

    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      orchestrationDependencies(executor),
    )).resolves.toMatchObject({
      containerName: fixture.plan.containerName,
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });
    const stop = executor.commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'stop' && args.at(-1) === 'e'.repeat(64)
    ));
    const remove = executor.commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'rm' && args.at(-1) === 'e'.repeat(64)
    ));
    const create = executor.commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'create'
    ));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(stop);
    expect(create).toBeGreaterThan(remove);
    expect(executor.staleRuntimes.size).toBe(0);
  });

  test('fails closed when a stale runtime image was swapped after creation', async () => {
    const executor = new RuntimeExecutor(fixture);
    const rebuiltAway = imageVariantFixture(fixture, `sha256:${'9'.repeat(64)}`);
    const stale = inspectFor(rebuiltAway, true);
    stale.Id = 'e'.repeat(64);
    // The fingerprint label commits to the creation image; a different
    // inspected image must not reconstruct any recognized generation.
    stale.Image = `sha256:${'7'.repeat(64)}`;
    stale.Config.Image = stale.Image;
    executor.addStaleRuntime(stale);
    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      orchestrationDependencies(executor),
    )).rejects.toThrow('Managed Native CLI Project runtime is not an exact recognized prior generation');
    expect(executor.staleRuntimes.size).toBe(1);
    expect(executor.commands.some(({ args }) => args[1] === 'rm')).toBe(false);
  });

  test.each([
    ['running', true],
    ['stopped', false],
  ])('migrates an exact %s current-fingerprint name-mode runtime once and remains idempotent', async (
    _state,
    running,
  ) => {
    const executor = new RuntimeExecutor(fixture);
    const stale = currentNameModeInspect(fixture, running);
    stale.Id = 'e'.repeat(64);
    executor.addStaleRuntime(stale);
    const dependencies = orchestrationDependencies(executor);

    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      dependencies,
    )).resolves.toMatchObject({
      containerId: 'd'.repeat(64),
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });
    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      dependencies,
    )).resolves.toMatchObject({
      containerId: 'd'.repeat(64),
      runtimeFingerprint: fixture.plan.runtimeFingerprint,
    });
    expect(executor.commands.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'rm' && args.at(-1) === 'e'.repeat(64)
    ))).toHaveLength(1);
    expect(executor.commands.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'create'
    ))).toHaveLength(1);
    expect(executor.commands.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'stop' && args.at(-1) === 'e'.repeat(64)
    ))).toHaveLength(running ? 1 : 0);
  });

  test('does not mutate a current-fingerprint name-mode runtime bound to another network ID', async () => {
    const executor = new RuntimeExecutor(fixture);
    const counterfeit = currentNameModeInspect(fixture, true);
    counterfeit.Id = 'e'.repeat(64);
    counterfeit.NetworkSettings.Networks[fixture.spec.internalNetworkName].NetworkID =
      'f'.repeat(64);
    executor.addStaleRuntime(counterfeit);
    const dependencies = orchestrationDependencies(executor);

    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      dependencies,
    )).rejects.toMatchObject({ code: 'RUNTIME_NETWORK' });
    expect(dependencies.ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm', 'create'].includes(String(args[1]))
    ))).toBe(false);
  });

  test.each([
    ['privileged mode', (value: any) => { value.HostConfig.Privileged = true; }, 'RUNTIME_HARDENING'],
    ['container namespace join', (value: any) => {
      value.HostConfig.PidMode = `container:${'f'.repeat(64)}`;
    }, 'RUNTIME_HARDENING'],
    ['conflicting tmpfs', (value: any) => {
      value.HostConfig.Tmpfs['/tmp'] += ',exec';
    }, 'RUNTIME_TMPFS'],
  ])('fails closed without mutating a stale runtime with hostile %s', async (
    _label,
    mutate,
    expectedCode,
  ) => {
    const executor = new RuntimeExecutor(fixture);
    const counterfeit = legacyPreConfinementInspect(fixture);
    counterfeit.Id = 'e'.repeat(64);
    mutate(counterfeit);
    executor.addStaleRuntime(counterfeit);

    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      orchestrationDependencies(executor),
    )).rejects.toMatchObject({ code: expectedCode });
    expect(executor.commands.some(({ args }) => ['stop', 'rm', 'create'].includes(String(args[1])))).toBe(false);
  });

  test.each([
    ['exact first', 'e', 'f'],
    ['counterfeit first', 'f', 'e'],
  ])('preflights the complete %s mixed native inventory before mutation', async (
    _label,
    exactPrefix,
    counterfeitPrefix,
  ) => {
    const executor = new RuntimeExecutor(fixture);
    const exact = legacyPreConfinementInspect(fixture);
    exact.Id = exactPrefix.repeat(64);
    const counterfeit = legacyPreConfinementInspect(fixture);
    counterfeit.Id = counterfeitPrefix.repeat(64);
    counterfeit.Config.Labels[PROJECT_EGRESS_RUNTIME_FINGERPRINT_LABEL] = '8'.repeat(64);
    counterfeit.Name = `/${fixture.plan.profile.containerNamePrefix}-${'8'.repeat(24)}`;
    executor.addStaleRuntime(exact);
    executor.addStaleRuntime(counterfeit);
    const dependencies = orchestrationDependencies(executor);

    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      dependencies,
    )).rejects.toBeInstanceOf(NativeCliProjectEgressRuntimeError);
    expect(dependencies.ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.commands.some(({ args }) => ['stop', 'rm', 'create'].includes(String(args[1])))).toBe(false);
    expect(executor.staleRuntimes.has(String(exact.Name).replace(/^\//, ''))).toBe(true);
  });

  test('does not retire an exact native predecessor when a counterfeit claims the current identity', async () => {
    const executor = new RuntimeExecutor(fixture);
    const exact = legacyPreConfinementInspect(fixture);
    exact.Id = 'e'.repeat(64);
    const counterfeitCurrent = inspectFor(fixture, true);
    counterfeitCurrent.Id = 'f'.repeat(64);
    counterfeitCurrent.HostConfig.Privileged = true;
    executor.addStaleRuntime(exact);
    executor.addStaleRuntime(counterfeitCurrent);
    const dependencies = orchestrationDependencies(executor);

    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      dependencies,
    )).rejects.toBeInstanceOf(NativeCliProjectEgressRuntimeError);
    expect(dependencies.ensureEgressPlane).not.toHaveBeenCalled();
    expect(executor.commands.some(({ args }) => ['stop', 'rm', 'create'].includes(String(args[1])))).toBe(false);
    expect(executor.staleRuntimes.has(String(exact.Name).replace(/^\//, ''))).toBe(true);
  });

  test('never mutates a foreign occupant of the current-generation runtime name', async () => {
    const executor = new RuntimeExecutor(fixture);
    executor.exists = true;
    executor.running = true;
    const foreign = inspectFor(fixture, true);
    foreign.HostConfig.Privileged = true;
    const originalRun = executor.run.bind(executor);
    executor.run = async (command, args, options) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        const reference = String(args[2]);
        if (reference === fixture.plan.containerName || reference === 'd'.repeat(64)) {
          return { stdout: JSON.stringify([foreign]), stderr: '', exitCode: 0 };
        }
      }
      return originalRun(command, args, options);
    };

    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      orchestrationDependencies(executor),
    )).rejects.toMatchObject({ code: 'RUNTIME_HARDENING' });
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'start', 'rm'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('never mutates a same-name substitute returned after native runtime creation', async () => {
    const executor = new RuntimeExecutor(fixture);
    const replacement = inspectFor(fixture, false);
    replacement.Id = 'f'.repeat(64);
    replacement.HostConfig.Privileged = true;
    const originalRun = executor.run.bind(executor);
    let created = false;
    executor.run = async (command, args, options) => {
      const result = await originalRun(command, args, options);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'create') created = true;
      if (created && command === 'docker' && args[0] === 'container' && args[1] === 'inspect'
        && String(args[2]) === 'd'.repeat(64)) {
        return { stdout: JSON.stringify([replacement]), stderr: '', exitCode: 0 };
      }
      return result;
    };
    const constrainRuntime = jest.fn(async () => undefined);
    const dependencies = orchestrationDependencies(executor, constrainRuntime);

    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      dependencies,
    )).rejects.toBeInstanceOf(NativeCliProjectEgressRuntimeError);
    expect(constrainRuntime).not.toHaveBeenCalled();
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'start', 'rm'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('does not start or clean up a same-name replacement that wins the pre-start race', async () => {
    const executor = new RuntimeExecutor(fixture);
    executor.exists = true;
    executor.running = false;
    const oldContainerId = 'd'.repeat(64);
    const replacement = inspectFor(fixture, false);
    replacement.Id = 'f'.repeat(64);
    replacement.HostConfig.Privileged = true;
    let replacementInstalled = false;
    const originalRun = executor.run.bind(executor);
    executor.run = async (command, args, options) => {
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect'
        && replacementInstalled) {
        const reference = String(args[2]);
        if (reference === oldContainerId) {
          return {
            stdout: '',
            stderr: `Error response from daemon: No such container: ${oldContainerId}`,
            exitCode: 1,
          };
        }
        if (reference === fixture.plan.containerName) {
          return { stdout: JSON.stringify([replacement]), stderr: '', exitCode: 0 };
        }
      }
      return originalRun(command, args, options);
    };
    const constrainRuntime = jest.fn(async () => {
      replacementInstalled = true;
      executor.exists = false;
    });

    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      orchestrationDependencies(executor, constrainRuntime),
    )).rejects.toMatchObject({ code: 'RUNTIME_RACE' });
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'start', 'rm'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('does not stop a same-name replacement from catch cleanup after the attested runtime disappears', async () => {
    const executor = new RuntimeExecutor(fixture);
    executor.exists = true;
    executor.running = false;
    const oldContainerId = 'd'.repeat(64);
    const replacement = inspectFor(fixture, true);
    replacement.Id = 'f'.repeat(64);
    replacement.HostConfig.Privileged = true;
    let replacementInstalled = false;
    const originalRun = executor.run.bind(executor);
    executor.run = async (command, args, options) => {
      if (command === '/usr/bin/nsenter' && !replacementInstalled) {
        replacementInstalled = true;
        executor.exists = false;
        throw new Error('firewall setup failed');
      }
      if (command === 'docker' && args[0] === 'container' && args[1] === 'inspect'
        && replacementInstalled) {
        const reference = String(args[2]);
        if (reference === oldContainerId) {
          return {
            stdout: '',
            stderr: `Error response from daemon: No such container: ${oldContainerId}`,
            exitCode: 1,
          };
        }
        if (reference === fixture.plan.containerName) {
          return { stdout: JSON.stringify([replacement]), stderr: '', exitCode: 0 };
        }
      }
      return originalRun(command, args, options);
    };

    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      orchestrationDependencies(executor),
    )).rejects.toThrow('firewall setup failed');
    expect(executor.commands.filter(({ args }) => (
      args[0] === 'container' && args[1] === 'start'
    ))).toEqual([
      expect.objectContaining({ args: ['container', 'start', oldContainerId] }),
    ]);
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container' && ['stop', 'rm'].includes(String(args[1]))
    ))).toBe(false);
  });

  test('rejects a same-name replacement in the final full-ID inventory window', async () => {
    const executor = new RuntimeExecutor(fixture);
    const oldContainerId = 'd'.repeat(64);
    const replacementId = 'f'.repeat(64);
    const replacement = inspectFor(fixture, true);
    replacement.Id = replacementId;
    replacement.HostConfig.Privileged = true;
    let replacementInstalled = false;
    const originalRun = executor.run.bind(executor);
    executor.run = async (command, args, options) => {
      if (command === 'docker'
        && args[0] === 'container'
        && args[1] === 'inspect'
        && replacementInstalled) {
        const reference = String(args[2]);
        if (reference === oldContainerId) {
          return {
            stdout: '',
            stderr: `Error response from daemon: No such container: ${oldContainerId}`,
            exitCode: 1,
          };
        }
        if (reference === fixture.plan.containerName) {
          return { stdout: JSON.stringify([replacement]), stderr: '', exitCode: 0 };
        }
      }
      const result = await originalRun(command, args, options);
      if (command === 'docker'
        && args[0] === 'container'
        && args[1] === 'ls'
        && args[args.indexOf('--format') + 1] === '{{.ID}}') {
        replacementInstalled = true;
        executor.exists = false;
        return { stdout: replacementId, stderr: '', exitCode: 0 };
      }
      return result;
    };

    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      orchestrationDependencies(executor),
    )).rejects.toMatchObject({ code: 'STALE_RUNTIME_RACE' });
    expect(replacementInstalled).toBe(true);
    expect(executor.commands).toContainEqual(expect.objectContaining({
      args: expect.arrayContaining(['--no-trunc', '--format', '{{.ID}}']),
    }));
    expect(executor.commands.some(({ args }) => (
      args[0] === 'container'
      && ['stop', 'rm'].includes(String(args[1]))
      && args.at(-1) === replacementId
    ))).toBe(false);
  });

  test('retires the old runtime before a policy-fingerprint network replacement can begin', async () => {
    const executor = new RuntimeExecutor(fixture);
    const stale = legacyPreConfinementInspect(fixture);
    stale.Id = 'e'.repeat(64);
    executor.addStaleRuntime(stale);
    const dependencies = orchestrationDependencies(executor);
    dependencies.ensureEgressPlane = jest.fn(async () => {
      expect(executor.staleRuntimes.size).toBe(0);
      return orchestrationDependencies(executor).ensureEgressPlane();
    });

    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      dependencies,
    )).resolves.toMatchObject({ runtimeFingerprint: fixture.plan.runtimeFingerprint });
    const removeIndex = executor.commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'rm' && args[2] === 'e'.repeat(64)
    ));
    expect(removeIndex).toBeGreaterThanOrEqual(0);
    expect(dependencies.ensureEgressPlane).toHaveBeenCalledTimes(1);
  });

  test('rotates proxy credentials through a hash-keyed runtime generation without exposing the token in its identity', async () => {
    const previous = fixture;
    const rotatedToken = 'Z'.repeat(43);
    const rotatedEgress = { ...fixture.egress, token: rotatedToken };
    const rotatedSpec = buildProjectEgressPlaneSpec(rotatedEgress);
    const rotatedPlan = buildNativeCliProjectRuntimePlan({
      context: fixture.context,
      profile: PROFILE,
      spec: rotatedSpec,
      proxyAddress: PROXY_ADDRESS,
      internalNetworkId: INTERNAL_NETWORK_ID,
    });
    expect(rotatedSpec.policyFingerprint).toBe(previous.spec.policyFingerprint);
    expect(rotatedPlan.runtimeFingerprint).not.toBe(previous.plan.runtimeFingerprint);
    expect(rotatedPlan.containerName).not.toBe(previous.plan.containerName);
    fixture = { ...fixture, egress: rotatedEgress, spec: rotatedSpec, plan: rotatedPlan };
    const executor = new RuntimeExecutor(fixture);
    const stale = inspectFor(previous, true);
    stale.Id = 'e'.repeat(64);
    executor.addStaleRuntime(stale);

    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      orchestrationDependencies(executor),
    )).resolves.toMatchObject({
      containerName: rotatedPlan.containerName,
      runtimeFingerprint: rotatedPlan.runtimeFingerprint,
    });
    expect(rotatedPlan.containerName).not.toContain(rotatedToken);
    expect(Object.values(rotatedPlan.expectedLabels).join(' ')).not.toContain(rotatedToken);
    const removeIndex = executor.commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'rm' && args[2] === 'e'.repeat(64)
    ));
    const createIndex = executor.commands.findIndex(({ args }) => (
      args[0] === 'container' && args[1] === 'create'
      && args.includes(rotatedPlan.containerName)
    ));
    expect(removeIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(removeIndex);
  });

  test('does not remove a same-name replacement that appears after immutable stale-runtime stop', async () => {
    const executor = new RuntimeExecutor(fixture);
    const stalePlan = legacyPreConfinementFixture(fixture).plan;
    const stale = legacyPreConfinementInspect(fixture);
    stale.Id = 'e'.repeat(64);
    executor.addStaleRuntime(stale);
    const originalRun = executor.run.bind(executor);
    executor.run = async (command, args, options) => {
      const result = await originalRun(command, args, options);
      if (command === 'docker' && args[0] === 'container' && args[1] === 'stop'
        && args.at(-1) === 'e'.repeat(64)) {
        executor.staleRuntimes.clear();
        const replacement = legacyPreConfinementInspect(fixture, false);
        replacement.Id = 'f'.repeat(64);
        replacement.HostConfig.Privileged = true;
        executor.addStaleRuntime(replacement);
      }
      return result;
    };

    await expect(ensureNativeCliProjectEgressRuntime(
      managedStateInput(),
      orchestrationDependencies(executor),
    )).rejects.toMatchObject({ code: 'STALE_RUNTIME_RACE' });
    expect(executor.staleRuntimes.get(stalePlan.containerName)?.Id).toBe('f'.repeat(64));
    expect(executor.commands.some(({ args }) => args[1] === 'rm')).toBe(false);
  });

  test('serializes concurrent ensures and creates one native runtime generation', async () => {
    const executor = new RuntimeExecutor(fixture);
    let active = 0;
    let maximum = 0;
    const dependencies = orchestrationDependencies(executor);
    const baseEnsure = dependencies.ensureEgressPlane;
    dependencies.ensureEgressPlane = jest.fn(async (...args) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      const result = await baseEnsure(...args);
      active -= 1;
      return result;
    });

    await expect(Promise.all([
      ensureNativeCliProjectEgressRuntime(managedStateInput(), dependencies),
      ensureNativeCliProjectEgressRuntime(managedStateInput(), dependencies),
    ])).resolves.toHaveLength(2);
    expect(maximum).toBe(1);
    expect(executor.commands.filter(({ args }) => args[0] === 'container' && args[1] === 'create'))
      .toHaveLength(1);
    expect(executor.commands.some(({ args }) => args[1] === 'rm')).toBe(false);
  });

  test('creates, constrains, starts, firewalls, injects protected state, and reattests', async () => {
    const executor = new RuntimeExecutor(fixture);
    const constrainRuntime = jest.fn(async () => undefined);
    const handle = await ensureNativeCliProjectEgressRuntime({
      context: fixture.context,
      profile: PROFILE,
      egress: fixture.egress,
      prepareManagedState: () => [
        { sourcePath: fixture.authPath, targetPath: `${NATIVE_CLI_PROJECT_CONTAINER_HOME}/auth.json`, label: 'auth' },
        { sourcePath: fixture.settingsPath, targetPath: `${NATIVE_CLI_PROJECT_CONTAINER_HOME}/settings.json`, label: 'settings' },
      ],
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      resolveInternalNetworkBinding: jest.fn(async () => ({
        networkId: INTERNAL_NETWORK_ID,
        generation: 'CURRENT' as const,
      })),
      ensureEgressPlane: jest.fn(async () => ({
        policyVersion: PROJECT_EGRESS_POLICY_VERSION,
        policyFingerprint: fixture.spec.policyFingerprint,
        internalNetworkName: fixture.spec.internalNetworkName,
        internalNetworkId: INTERNAL_NETWORK_ID,
        publicNetworkName: fixture.spec.publicNetworkName,
        proxyContainerName: fixture.spec.proxyContainerName,
        proxyUrl: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
        proxyEnvironment: {
          HTTP_PROXY: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          HTTPS_PROXY: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          http_proxy: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          https_proxy: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          NO_PROXY: '',
          no_proxy: '',
        },
      })),
      constrainRuntime,
    });
    expect(handle).toMatchObject({ provider: 'CLAUDE_CODE', containerId: 'd'.repeat(64) });
    const createIndex = executor.commands.findIndex(({ args }) => args[1] === 'create');
    const startIndex = executor.commands.findIndex(({ args }) => args[1] === 'start');
    const firewallIndex = executor.commands.findIndex(({ command }) => command === '/usr/bin/nsenter');
    const injectionIndex = executor.commands.findIndex(({ args }) => (
      args[1] === 'exec' && args.includes('--interactive') && args.includes('node')
    ));
    expect(startIndex).toBeGreaterThan(createIndex);
    expect(firewallIndex).toBeGreaterThan(startIndex);
    expect(injectionIndex).toBeGreaterThan(firewallIndex);
    expect(executor.commands.some(({ args }) => args[1] === 'cp')).toBe(false);
    expect(executor.commands[injectionIndex].input).toBe(JSON.stringify([
      fs.readFileSync(fixture.authPath).toString('base64'),
      fs.readFileSync(fixture.settingsPath).toString('base64'),
    ]));
    expect(constrainRuntime).toHaveBeenCalledWith(expect.objectContaining({
      runtimeContainerId: 'd'.repeat(64),
      runtimeContainerName: fixture.plan.containerName,
      expectedRuntimeFingerprint: fixture.plan.runtimeFingerprint,
      executor,
    }));
    expect(constrainRuntime).toHaveBeenCalledTimes(1);
    expect(executor.commands[startIndex].args).toEqual(['container', 'start', 'd'.repeat(64)]);
  });

  test('reuses an attested running container so native session state survives turns', async () => {
    const executor = new RuntimeExecutor(fixture);
    executor.exists = true;
    executor.running = true;
    const constrainRuntime = jest.fn(async () => undefined);
    await ensureNativeCliProjectEgressRuntime({
      context: fixture.context,
      profile: PROFILE,
      egress: fixture.egress,
      prepareManagedState: () => [
        { sourcePath: fixture.authPath, targetPath: `${NATIVE_CLI_PROJECT_CONTAINER_HOME}/auth.json`, label: 'auth' },
        { sourcePath: fixture.settingsPath, targetPath: `${NATIVE_CLI_PROJECT_CONTAINER_HOME}/settings.json`, label: 'settings' },
      ],
    }, {
      executor,
      buildEgressSpec: buildProjectEgressPlaneSpec,
      resolveInternalNetworkBinding: jest.fn(async () => ({
        networkId: INTERNAL_NETWORK_ID,
        generation: 'CURRENT' as const,
      })),
      ensureEgressPlane: async () => ({
        policyVersion: PROJECT_EGRESS_POLICY_VERSION,
        policyFingerprint: fixture.spec.policyFingerprint,
        internalNetworkName: fixture.spec.internalNetworkName,
        internalNetworkId: INTERNAL_NETWORK_ID,
        publicNetworkName: fixture.spec.publicNetworkName,
        proxyContainerName: fixture.spec.proxyContainerName,
        proxyUrl: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
        proxyEnvironment: {
          HTTP_PROXY: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          HTTPS_PROXY: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          http_proxy: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          https_proxy: `http://portal:${TOKEN}@${fixture.spec.proxyAlias}:3128`,
          NO_PROXY: '',
          no_proxy: '',
        },
      }),
      constrainRuntime,
    });
    expect(executor.commands.some(({ args }) => args[1] === 'stop')).toBe(false);
    expect(executor.commands.some(({ args }) => args[1] === 'start')).toBe(false);
    expect(executor.commands.some(({ args }) => args[1] === 'create')).toBe(false);
    expect(constrainRuntime).not.toHaveBeenCalled();
    const sweep = executor.commands.find(({ args }) => args[1] === 'exec' && args.includes('sweep'));
    expect(sweep?.args).toEqual(expect.arrayContaining([
      '--user', NATIVE_CLI_PROJECT_CONTAINER_USER,
      '--workdir', NATIVE_CLI_PROJECT_CONTAINER_ROOT,
      'd'.repeat(64),
      'sweep', '', '', '', 'claude-code',
    ]));
    const exactInspect = executor.commands.find(({ args }) => (
      args[1] === 'inspect' && args[2] === 'd'.repeat(64)
    ));
    expect(exactInspect).toBeDefined();
  });

  test.each([
    ['actor', (value: Fixture) => ({ ...value.egress, identity: { ...value.egress.identity, actorId: 'other' } })],
    ['project', (value: Fixture) => ({ ...value.egress, identity: { ...value.egress.identity, projectId: 'other' } })],
    ['provider', (value: Fixture) => ({ ...value.egress, identity: { ...value.egress.identity, provider: 'CODEX' } })],
  ])('rejects mismatched %s egress identity before creating a runtime', async (_label, mutate) => {
    const executor = new RuntimeExecutor(fixture);
    await expect(ensureNativeCliProjectEgressRuntime({
      context: fixture.context,
      profile: PROFILE,
      egress: mutate(fixture),
      prepareManagedState: () => [],
    }, { executor })).rejects.toMatchObject({ code: 'EGRESS_IDENTITY' });
    expect(executor.exists).toBe(false);
  });
});
