import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  PortalProjectWorkloadError,
  __projectWorkloadRuntimeTest,
  attestPortalProjectWorkloadContainer,
  buildPortalProjectWorkloadCreateArgs,
  buildPortalProjectWorkloadPlan,
  startPreparedPortalProjectWorkloadContainer,
  toProjectEgressWorkloadIdentity,
  type PortalProjectWorkloadContainerOptions,
  type PortalProjectWorkloadPlan,
} from './projectWorkloadRuntime';

const IMAGE = `sha256:${'a'.repeat(64)}`;

function options(workspace: string, workloadId = 'job-1'): PortalProjectWorkloadContainerOptions {
  return {
    identity: {
      actorId: 'actor-full-uuid',
      projectId: 'project-full-uuid',
      consumerKind: 'PORTAL_LIFECYCLE',
      workloadId,
    },
    containerName: `bridgesllm-project-job-${workloadId}`,
    workspace,
    image: IMAGE,
    command: 'npm',
    args: ['run', 'build'],
    environment: { HOME: '/tmp/project-home', CI: 'true' },
    networked: false,
    pidsLimit: 256,
    memoryBytes: 512 * 1024 * 1024,
    nanoCpus: 1_000_000_000,
    tmpfsSize: '128m',
  };
}

function inspect(plan: PortalProjectWorkloadPlan, running = false): any {
  const labels = __projectWorkloadRuntimeTest.workloadLabels(plan);
  const networkName = plan.egressSpec?.internalNetworkName || 'none';
  const portBindings = {};
  return {
    Id: 'b'.repeat(64),
    Name: `/${plan.containerName}`,
    Config: {
      Image: plan.image,
      User: '1000:1000',
      Cmd: [plan.command, ...plan.args],
      Env: Object.entries(plan.environment).map(([key, value]) => `${key}=${value}`),
      Labels: labels,
    },
    State: { Running: running, Status: running ? 'running' : 'created' },
    HostConfig: {
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      PidMode: '',
      IpcMode: '',
      NetworkMode: plan.egressHandle?.internalNetworkId || 'none',
      RestartPolicy: { Name: 'no' },
      PidsLimit: plan.pidsLimit,
      Memory: plan.memoryBytes,
      NanoCpus: plan.nanoCpus,
      Tmpfs: { '/tmp': `rw,nosuid,nodev,noexec,size=${plan.tmpfsSize}` },
      PortBindings: portBindings,
    },
    Mounts: [{ Type: 'bind', Source: plan.workspace, Destination: '/workspace/project', RW: true }],
    NetworkSettings: {
      Networks: {
        [networkName]: plan.applicationPort === undefined
          ? {}
          : { IPAddress: '172.30.0.4', NetworkID: plan.egressHandle?.internalNetworkId },
      },
      Ports: {},
    },
  };
}

describe('Portal project workload runtime', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(os.tmpdir(), 'portal-workload-runtime-test-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test('creates a stopped, offline, one-bind, non-root runtime with restart disabled', async () => {
    const plan = await buildPortalProjectWorkloadPlan(options(workspace));
    const args = buildPortalProjectWorkloadCreateArgs(plan);
    expect(args.slice(0, 2)).toEqual(['container', 'create']);
    expect(args).toEqual(expect.arrayContaining([
      '--network', 'none',
      '--user', '1000:1000',
      '--mount', `type=bind,src=${workspace},dst=/workspace/project`,
      '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true',
      '--restart', 'no',
      IMAGE, 'npm', 'run', 'build',
    ]));
    expect(args.filter((entry) => entry.startsWith('type=bind,'))).toHaveLength(1);
    expect(args).not.toContain('--privileged');
    expect(args.join(' ')).not.toContain('/var/run/docker.sock');
    expect(() => attestPortalProjectWorkloadContainer(plan, inspect(plan), { running: false, networkName: 'none' })).not.toThrow();
  });

  test('full actor/project/workload identity changes fingerprints and container names', async () => {
    const first = await buildPortalProjectWorkloadPlan(options(workspace, 'job-a'));
    const second = await buildPortalProjectWorkloadPlan({
      ...options(workspace, 'job-b'),
      containerName: 'bridgesllm-project-job-job-b',
    });
    expect(first.runtimeFingerprint).not.toBe(second.runtimeFingerprint);
    expect(first.identity.workloadId).not.toBe(second.identity.workloadId);
    expect(toProjectEgressWorkloadIdentity(first.identity)).toEqual({
      ...first.identity,
      provider: 'PORTAL_WORKLOAD',
    });
  });

  test('creates networked apps without host publication and returns only the attested internal address', async () => {
    const base = await buildPortalProjectWorkloadPlan(options(workspace, 'app-1'));
    const internalNetworkId = 'c'.repeat(64);
    const plan = {
      ...base,
      identity: { ...base.identity, consumerKind: 'PORTAL_APP' as const },
      containerName: 'bridgesllm-project-app-app-1',
      networked: true,
      applicationPort: 5001,
      egressSpec: { internalNetworkName: 'p4e-in-app-1' } as any,
      egressHandle: { internalNetworkId } as any,
    };
    const args = buildPortalProjectWorkloadCreateArgs(plan);
    expect(args).toEqual(expect.arrayContaining([
      '--network', internalNetworkId,
    ]));
    expect(args).not.toContain('--publish');
    expect(args).not.toEqual(expect.arrayContaining(['--network', 'none']));
    expect(() => buildPortalProjectWorkloadCreateArgs({
      ...plan,
      egressHandle: null,
    })).toThrow(PortalProjectWorkloadError);

    const running = inspect(plan, true);
    expect(() => attestPortalProjectWorkloadContainer(
      plan,
      running,
      { running: true, networkName: 'p4e-in-app-1' },
    )).not.toThrow();

    const neverStarted = inspect(plan, false);
    neverStarted.NetworkSettings.Networks['p4e-in-app-1'].NetworkID = '';
    expect(() => attestPortalProjectWorkloadContainer(
      plan,
      neverStarted,
      { running: false, networkName: 'p4e-in-app-1' },
    )).not.toThrow();
    neverStarted.HostConfig.NetworkMode = 'p4e-in-app-1';
    expect(() => attestPortalProjectWorkloadContainer(
      plan,
      neverStarted,
      { running: false, networkName: 'p4e-in-app-1' },
    )).toThrow(PortalProjectWorkloadError);
    neverStarted.HostConfig.NetworkMode = internalNetworkId;
    neverStarted.State.Status = 'exited';
    expect(() => attestPortalProjectWorkloadContainer(
      plan,
      neverStarted,
      { running: false, networkName: 'p4e-in-app-1' },
    )).toThrow(PortalProjectWorkloadError);

    const executor = {
      run: jest.fn(async (command: string, commandArgs: readonly string[]) => {
        if (command === 'docker' && commandArgs[0] === 'container' && commandArgs[1] === 'inspect') {
          return { stdout: JSON.stringify([running]), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };
    await expect(startPreparedPortalProjectWorkloadContainer(plan, executor)).resolves.toEqual({
      containerId: 'b'.repeat(64),
      networkAddress: '172.30.0.4',
    });

    running.HostConfig.PortBindings = {
      '5001/tcp': [{ HostIp: '127.0.0.1', HostPort: '5001' }],
    };
    expect(() => attestPortalProjectWorkloadContainer(
      plan,
      running,
      { running: true, networkName: 'p4e-in-app-1' },
    )).toThrow(PortalProjectWorkloadError);
    running.HostConfig.PortBindings = {};
    running.NetworkSettings.Networks['p4e-in-app-1'].NetworkID = 'd'.repeat(64);
    expect(() => attestPortalProjectWorkloadContainer(
      plan,
      running,
      { running: true, networkName: 'p4e-in-app-1' },
    )).toThrow(PortalProjectWorkloadError);
    running.NetworkSettings.Networks['p4e-in-app-1'].NetworkID = internalNetworkId;
    running.NetworkSettings.Networks['p4e-in-app-1'].IPAddress = '';
    await expect(startPreparedPortalProjectWorkloadContainer(plan, executor))
      .rejects.toMatchObject({ code: 'CONTAINER_UPSTREAM' });
  });

  test.each([
    ['host network', (value: any) => { value.HostConfig.NetworkMode = 'host'; value.NetworkSettings.Networks = { host: {} }; }],
    ['extra writable mount', (value: any) => { value.Mounts.push({ Type: 'bind', Source: '/tmp/other', Destination: '/other', RW: true }); }],
    ['root user', (value: any) => { value.Config.User = '0:0'; }],
    ['automatic restart', (value: any) => { value.HostConfig.RestartPolicy.Name = 'unless-stopped'; }],
    ['published port', (value: any) => { value.HostConfig.PortBindings = { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] }; }],
  ])('fails closed on %s', async (_label, mutate) => {
    const plan = await buildPortalProjectWorkloadPlan(options(workspace));
    const actual = inspect(plan);
    mutate(actual);
    expect(() => attestPortalProjectWorkloadContainer(plan, actual, { running: false, networkName: 'none' }))
      .toThrow(PortalProjectWorkloadError);
  });
});
