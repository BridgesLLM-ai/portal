import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../../AgentProvider.interface';
import { PROJECT_EGRESS_POLICY_VERSION } from '../../../services/projectEgressPolicy';
import {
  PROJECT_RUNTIME_GID,
  PROJECT_RUNTIME_UID,
} from '../../../services/projectRuntimeIdentity';
import {
  OLLAMA_PROJECT_CONTAINER_HOME,
  OLLAMA_PROJECT_CONTAINER_ROOT,
  OLLAMA_PROJECT_CONTAINER_USER,
  OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
  OllamaProjectToolRuntime,
  attestOllamaProjectRuntimeContainer,
  buildOllamaProjectRuntimePlan,
  cleanupOllamaProjectRuntimeByIdentity,
  stopOllamaProjectRuntimesForRecoveryContext,
  type OllamaProjectCommandExecutor,
  type OllamaProjectCommandOptions,
  type OllamaProjectCommandResult,
} from './OllamaProjectToolRuntime';

interface Fixture {
  root: string;
  context: ProjectSandboxExecutionContext;
  plan: ReturnType<typeof buildOllamaProjectRuntimePlan>;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-project-runtime-'));
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot, { mode: 0o700 });
  const stat = fs.lstatSync(projectRoot, { bigint: true });
  const context: ProjectSandboxExecutionContext = Object.freeze({
    scope: 'PROJECT_SANDBOX',
    source: 'PORTAL_SERVER',
    userId: 'actor-runtime',
    projectId: 'project-runtime',
    workspaceOwnerId: 'owner-runtime',
    projectName: 'runtime-test',
    canonicalRoot: fs.realpathSync(projectRoot),
    rootDevice: stat.dev.toString(),
    rootInode: stat.ino.toString(),
    rootBirthtimeNs: stat.birthtimeNs.toString(),
    runtimePolicyVersion: OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
    egressPolicyVersion: PROJECT_EGRESS_POLICY_VERSION,
    runtimeImageDigest: 'sha256:' + 'a'.repeat(64),
    policyFingerprint: 'b'.repeat(64),
  });
  return { root, context, plan: buildOllamaProjectRuntimePlan(context) };
}

function inspectFor(fixture: Fixture, running = true): any {
  return {
    Id: 'd'.repeat(64),
    Image: fixture.plan.runtimeImage,
    Name: '/' + fixture.plan.containerName,
    Config: {
      Image: fixture.plan.runtimeImage,
      User: OLLAMA_PROJECT_CONTAINER_USER,
      WorkingDir: OLLAMA_PROJECT_CONTAINER_ROOT,
      Entrypoint: ['/bin/sh'],
      Cmd: ['-lc', 'while :; do sleep 3600; done'],
      Env: Object.entries(fixture.plan.expectedEnvironment).map(([key, value]) => key + '=' + value),
      Labels: { ...fixture.plan.expectedLabels },
      ExposedPorts: {},
      Volumes: {},
    },
    State: { Running: running, Pid: running ? 4242 : 0, StartedAt: running ? '2026-07-20T12:00:00Z' : '' },
    HostConfig: {
      ReadonlyRootfs: true,
      CapAdd: [],
      CapDrop: ['ALL'],
      SecurityOpt: [
        'no-new-privileges:true',
        'seccomp=/etc/bridgesllm/project-runtime/bridgesllm-project-runtime-v1.seccomp.json',
        'apparmor=bridgesllm-project-runtime-v1',
      ],
      Binds: [fixture.plan.projectRoot + ':' + OLLAMA_PROJECT_CONTAINER_ROOT + ':rw,rprivate'],
      Mounts: [],
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,nodev,size=67108864',
        [OLLAMA_PROJECT_CONTAINER_HOME]: `rw,noexec,nosuid,nodev,size=16777216,uid=${PROJECT_RUNTIME_UID},gid=${PROJECT_RUNTIME_GID},mode=0700`,
      },
      PortBindings: {},
      PublishAllPorts: false,
      NetworkMode: 'none',
      Privileged: false,
      PidMode: '',
      IpcMode: 'private',
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
      Source: fixture.plan.projectRoot,
      Destination: OLLAMA_PROJECT_CONTAINER_ROOT,
      RW: true,
      Propagation: 'rprivate',
    }],
    NetworkSettings: { Ports: {}, Networks: {} },
  };
}

class RuntimeExecutor implements OllamaProjectCommandExecutor {
  readonly calls: Array<{ command: string; args: readonly string[]; options?: OllamaProjectCommandOptions }> = [];
  private removed = false;

  constructor(private readonly fixture: Fixture) {}

  async run(command: string, args: readonly string[], options?: OllamaProjectCommandOptions): Promise<OllamaProjectCommandResult> {
    this.calls.push({ command, args, options });
    if (args[0] === 'image' && args[1] === 'inspect') {
      return { stdout: this.fixture.plan.runtimeImage + '\n', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      return this.removed
        ? { stdout: '', stderr: 'Error: No such container', exitCode: 1 }
        : { stdout: JSON.stringify([inspectFor(this.fixture)]), stderr: '', exitCode: 0 };
    }
    if (args[0] === 'container' && args[1] === 'exec') {
      const source = String(args[args.indexOf('-c') + 1] || '');
      if (source.includes("shutil.which('python3')")) {
        const nonce = String(args.at(-1) || '');
        return {
          stdout: JSON.stringify({
            uid: PROJECT_RUNTIME_UID,
            gid: PROJECT_RUNTIME_GID,
            cwd: OLLAMA_PROJECT_CONTAINER_ROOT,
            python: '/usr/bin/python3',
            shell: '/usr/bin/sh',
            git: '/usr/bin/git',
            node: '/usr/bin/node',
            ripgrep: '/usr/bin/rg',
            writeReadUnlink: true,
            evidenceSha256: crypto.createHash('sha256').update(nonce).digest('hex'),
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      expect(options?.input).toContain('"action":"project_read"');
      return { stdout: JSON.stringify({ ok: true, output: '1: hello\n' }), stderr: '', exitCode: 0 };
    }
    if (args[0] === 'container' && args[1] === 'rm') {
      this.removed = true;
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    throw new Error('unexpected command: ' + command + ' ' + args.join(' '));
  }
}

describe('confined Ollama Project coding tool runtime', () => {
  test('plan and attestation require one RW project bind and no network or host exposure', () => {
    const fixture = makeFixture();
    try {
      expect(fixture.plan.createArgs).toEqual(expect.arrayContaining([
        '--network', 'none',
        '--read-only',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true',
        '--security-opt', 'seccomp=/etc/bridgesllm/project-runtime/bridgesllm-project-runtime-v1.seccomp.json',
        '--security-opt', 'apparmor=bridgesllm-project-runtime-v1',
      ]));
      expect(fixture.plan.createArgs.filter((value) => value === '--volume')).toHaveLength(1);
      expect(fixture.plan.createArgs.join(' ')).not.toMatch(/OLLAMA_HOST|HTTP_PROXY|docker\.sock/);
      expect(fixture.plan.expectedEnvironment).toMatchObject({
        NODE_VERSION: '22.23.1',
        YARN_VERSION: '1.22.22',
        DEBIAN_FRONTEND: 'noninteractive',
      });
      expect(() => attestOllamaProjectRuntimeContainer({
        inspect: inspectFor(fixture),
        plan: fixture.plan,
        requireRunning: true,
      })).not.toThrow();

      const wrongSeccomp = inspectFor(fixture);
      wrongSeccomp.HostConfig.SecurityOpt[1] = 'seccomp=/tmp/foreign.json';
      expect(() => attestOllamaProjectRuntimeContainer({
        inspect: wrongSeccomp,
        plan: fixture.plan,
        requireRunning: true,
      })).toThrow('confinement');

      const wrongAppArmor = inspectFor(fixture);
      wrongAppArmor.AppArmorProfile = 'docker-default';
      expect(() => attestOllamaProjectRuntimeContainer({
        inspect: wrongAppArmor,
        plan: fixture.plan,
        requireRunning: true,
      })).toThrow('confinement');

      const networked = inspectFor(fixture);
      networked.HostConfig.NetworkMode = 'bridge';
      networked.NetworkSettings.Networks = { bridge: {} };
      expect(() => attestOllamaProjectRuntimeContainer({ inspect: networked, plan: fixture.plan, requireRunning: true }))
        .toThrow('networkless');

      const dockerNoneNetwork = inspectFor(fixture);
      dockerNoneNetwork.NetworkSettings.Networks = {
        none: {
          IPAMConfig: null,
          Links: null,
          Aliases: null,
          MacAddress: '',
          DriverOpts: null,
          GwPriority: 0,
          NetworkID: 'built-in-none-network-id',
          EndpointID: 'container-none-endpoint-id',
          Gateway: '',
          IPAddress: '',
          IPPrefixLen: 0,
          IPv6Gateway: '',
          GlobalIPv6Address: '',
          GlobalIPv6PrefixLen: 0,
          DNSNames: null,
        },
      };
      expect(() => attestOllamaProjectRuntimeContainer({
        inspect: dockerNoneNetwork,
        plan: fixture.plan,
        requireRunning: true,
      })).not.toThrow();

      const addressedNoneNetwork = inspectFor(fixture);
      addressedNoneNetwork.NetworkSettings.Networks = {
        none: { IPAddress: '172.18.0.2' },
      };
      expect(() => attestOllamaProjectRuntimeContainer({
        inspect: addressedNoneNetwork,
        plan: fixture.plan,
        requireRunning: true,
      })).toThrow('networkless');

      const unknownNoneNetworkField = inspectFor(fixture);
      unknownNoneNetworkField.NetworkSettings.Networks = {
        none: { FutureRoute: 'enabled' },
      };
      expect(() => attestOllamaProjectRuntimeContainer({
        inspect: unknownNoneNetworkField,
        plan: fixture.plan,
        requireRunning: true,
      })).toThrow('networkless');

      const injectedEnvironment = inspectFor(fixture);
      injectedEnvironment.Config.Env.push('NODE_OPTIONS=--require=/tmp/untrusted.js');
      expect(() => attestOllamaProjectRuntimeContainer({
        inspect: injectedEnvironment,
        plan: fixture.plan,
        requireRunning: true,
      })).toThrow('undeclared environment');

      const driftedBaseEnvironment = inspectFor(fixture);
      driftedBaseEnvironment.Config.Env = driftedBaseEnvironment.Config.Env.map((entry: string) => (
        entry.startsWith('NODE_VERSION=') ? 'NODE_VERSION=0.0.0' : entry
      ));
      expect(() => attestOllamaProjectRuntimeContainer({
        inspect: driftedBaseEnvironment,
        plan: fixture.plan,
        requireRunning: true,
      })).toThrow('environment changed');

      const dockerOrderedUlimits = inspectFor(fixture);
      dockerOrderedUlimits.HostConfig.Ulimits = [
        { Name: 'nproc', Hard: 256, Soft: 256 },
        { Name: 'nofile', Hard: 1024, Soft: 1024 },
      ];
      expect(() => attestOllamaProjectRuntimeContainer({
        inspect: dockerOrderedUlimits,
        plan: fixture.plan,
        requireRunning: true,
      })).not.toThrow();

      const changedUlimit = inspectFor(fixture);
      changedUlimit.HostConfig.Ulimits[0].Hard = 2048;
      expect(() => attestOllamaProjectRuntimeContainer({
        inspect: changedUlimit,
        plan: fixture.plan,
        requireRunning: true,
      })).toThrow('ulimits changed');

      const extraMount = inspectFor(fixture);
      extraMount.Mounts.push({ Type: 'bind', Source: '/etc', Destination: '/host', RW: false });
      expect(() => attestOllamaProjectRuntimeContainer({ inspect: extraMount, plan: fixture.plan, requireRunning: true }))
        .toThrow('exactly one');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test(`reattests the container and runs only the fixed tool runner as uid ${PROJECT_RUNTIME_UID}`, async () => {
    const fixture = makeFixture();
    const executor = new RuntimeExecutor(fixture);
    const runtime = new OllamaProjectToolRuntime(executor);
    try {
      await expect(runtime.runTool(fixture.context, 'project_read', { path: 'README.md' }))
        .resolves.toEqual({ ok: true, output: '1: hello\n' });
      const execCalls = executor.calls.filter((call) => call.args[0] === 'container' && call.args[1] === 'exec');
      expect(execCalls).toHaveLength(2);
      expect(execCalls[1].args).toEqual(expect.arrayContaining([
        '-i', '--user', OLLAMA_PROJECT_CONTAINER_USER,
        '--workdir', OLLAMA_PROJECT_CONTAINER_ROOT,
        'python3', '-c',
      ]));
      expect(execCalls[1].options?.timeoutMs).toBe(30_000);
      expect(executor.calls.filter((call) => call.args[0] === 'container' && call.args[1] === 'inspect')).toHaveLength(2);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('abort removes only a fully-attested project runtime', async () => {
    const fixture = makeFixture();
    const executor = new RuntimeExecutor(fixture);
    const runtime = new OllamaProjectToolRuntime(executor);
    try {
      await expect(runtime.abort(fixture.context)).resolves.toBe(true);
      expect(executor.calls).toContainEqual(expect.objectContaining({
        command: 'docker',
        args: ['container', 'rm', '-f', 'd'.repeat(64)],
      }));
      expect(executor.calls.filter((call) => (
        call.args[0] === 'container' && call.args[1] === 'inspect'
      ))).toHaveLength(2);

      const cleanupExecutor = new RuntimeExecutor(fixture);
      cleanupExecutor.run = jest.fn(async (command: string, args: readonly string[]) => {
        if (args[0] === 'container' && args[1] === 'ls') return { stdout: 'd'.repeat(64) + '\n', stderr: '', exitCode: 0 };
        if (args[0] === 'container' && args[1] === 'inspect') return { stdout: JSON.stringify([inspectFor(fixture)]), stderr: '', exitCode: 0 };
        if (args[0] === 'container' && args[1] === 'rm') return { stdout: '', stderr: '', exitCode: 0 };
        throw new Error('unexpected');
      });
      await expect(cleanupOllamaProjectRuntimeByIdentity({
        actorUserId: fixture.context.userId,
        projectIdentityId: fixture.context.projectId,
        executor: cleanupExecutor,
      })).resolves.toBe(1);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('restart recovery stops but does not remove an exact policy-and-image-drifted runtime', async () => {
    const fixture = makeFixture();
    const historicalSeed = {
      ...fixture.context,
      runtimePolicyVersion: 'portal-ollama-project-sandbox-v2',
      runtimeImageDigest: `sha256:${'9'.repeat(64)}`,
    };
    const historicalContext: ProjectSandboxExecutionContext = Object.freeze({
      ...historicalSeed,
      policyFingerprint: crypto.createHash('sha256').update(JSON.stringify({
        version: historicalSeed.runtimePolicyVersion,
        egressPolicyVersion: historicalSeed.egressPolicyVersion,
        provider: 'OLLAMA',
        runtime: 'ollama-project-coding-agent-v1',
        runtimeImageDigest: historicalSeed.runtimeImageDigest,
        actorUserId: historicalSeed.userId,
        workspaceOwnerId: historicalSeed.workspaceOwnerId,
        projectId: historicalSeed.projectId,
        projectName: historicalSeed.projectName,
        canonicalRoot: historicalSeed.canonicalRoot,
        rootDevice: historicalSeed.rootDevice,
        rootInode: historicalSeed.rootInode,
        rootBirthtimeNs: historicalSeed.rootBirthtimeNs,
      })).digest('hex'),
    });
    const historicalFixture: Fixture = {
      ...fixture,
      context: historicalContext,
      plan: {
        ...fixture.plan,
        runtimeImage: historicalContext.runtimeImageDigest,
        expectedLabels: {
          ...fixture.plan.expectedLabels,
          'com.bridgesllm.ollama-project.policy': historicalContext.runtimePolicyVersion,
        },
      },
    };
    let running = true;
    const calls: string[][] = [];
    const executor: OllamaProjectCommandExecutor = {
      async run(_command, args) {
        calls.push([...args]);
        if (args[0] === 'container' && args[1] === 'ls') {
          return { stdout: `${'d'.repeat(64)}\n`, stderr: '', exitCode: 0 };
        }
        if (args[0] === 'container' && args[1] === 'inspect') {
          return {
            stdout: JSON.stringify([inspectFor(historicalFixture, running)]),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args[0] === 'container' && args[1] === 'stop') {
          running = false;
          return { stdout: String(args.at(-1)), stderr: '', exitCode: 0 };
        }
        throw new Error(`unexpected recovery command: ${args.join(' ')}`);
      },
    };
    try {
      await expect(stopOllamaProjectRuntimesForRecoveryContext(
        historicalContext,
        executor,
      )).resolves.toEqual(['d'.repeat(64)]);
      expect(calls.some((args) => args[0] === 'container' && args[1] === 'stop')).toBe(true);
      expect(calls.some((args) => args[0] === 'container' && args[1] === 'rm')).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('abort waits for a racing ensure and proves the late-created container is gone', async () => {
    const fixture = makeFixture();
    let releaseInitialInspect!: () => void;
    const initialInspectGate = new Promise<void>((resolve) => { releaseInitialInspect = resolve; });
    let announceInitialInspect!: () => void;
    const initialInspectStarted = new Promise<void>((resolve) => { announceInitialInspect = resolve; });
    let firstInspect = true;
    let present = false;
    let running = false;
    const calls: string[][] = [];
    const executor: OllamaProjectCommandExecutor = {
      async run(_command, args) {
        calls.push([...args]);
        if (args[0] === 'image' && args[1] === 'inspect') {
          return { stdout: fixture.plan.runtimeImage + '\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'container' && args[1] === 'inspect') {
          if (firstInspect) {
            firstInspect = false;
            announceInitialInspect();
            await initialInspectGate;
          }
          return present
            ? { stdout: JSON.stringify([inspectFor(fixture, running)]), stderr: '', exitCode: 0 }
            : { stdout: '', stderr: 'Error: No such container', exitCode: 1 };
        }
        if (args[0] === 'container' && args[1] === 'create') {
          present = true;
          running = false;
          return { stdout: fixture.plan.containerName + '\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'container' && args[1] === 'start') {
          running = true;
          return { stdout: fixture.plan.containerName + '\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'container' && args[1] === 'exec') {
          const nonce = String(args.at(-1) || '');
          return {
            stdout: JSON.stringify({
              uid: PROJECT_RUNTIME_UID,
              gid: PROJECT_RUNTIME_GID,
              cwd: OLLAMA_PROJECT_CONTAINER_ROOT,
              python: '/usr/bin/python3',
              shell: '/usr/bin/sh',
              git: '/usr/bin/git',
              node: '/usr/bin/node',
              ripgrep: '/usr/bin/rg',
              writeReadUnlink: true,
              evidenceSha256: crypto.createHash('sha256').update(nonce).digest('hex'),
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args[0] === 'container' && args[1] === 'rm') {
          present = false;
          running = false;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        throw new Error('unexpected command: ' + args.join(' '));
      },
    };
    const admittingRuntime = new OllamaProjectToolRuntime(executor);
    const abortingRuntime = new OllamaProjectToolRuntime(executor);
    try {
      const ensuring = admittingRuntime.ensure(fixture.context);
      await initialInspectStarted;
      let abortSettled = false;
      const aborting = abortingRuntime.abort(fixture.context).then((result) => {
        abortSettled = true;
        return result;
      });
      await Promise.resolve();
      expect(abortSettled).toBe(false);

      releaseInitialInspect();
      await expect(ensuring).resolves.toEqual(expect.objectContaining({
        containerName: fixture.plan.containerName,
      }));
      await expect(aborting).resolves.toBe(true);
      expect(present).toBe(false);
      const startIndex = calls.findIndex((args) => args[0] === 'container' && args[1] === 'start');
      const removeIndex = calls.findIndex((args) => args[0] === 'container' && args[1] === 'rm');
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(removeIndex).toBeGreaterThan(startIndex);
    } finally {
      releaseInitialInspect();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
