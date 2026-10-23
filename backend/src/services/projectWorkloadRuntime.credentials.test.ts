/**
 * The credential mount on the resident App container: create arguments,
 * attestation of the exact mount list, refusals for every other workload and
 * cleanup on each removal path. Real credential directories (root-attested:
 * they are owned by the App user 1000:1000). Values are obvious dummies.
 */
jest.mock('../config/database', () => ({ prisma: {} }));
jest.mock('../config/env', () => ({ config: { projectEgressProxyImageId: 'sha256:' + 'a'.repeat(64) } }));
jest.mock('./projectEgressPlane', () => ({
  ...jest.requireActual('./projectEgressPlane'),
  teardownExactProjectEgressPlane: jest.fn(async () => ({ removed: [] })),
}));
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  PortalProjectWorkloadError,
  __projectWorkloadRuntimeTest,
  attestPortalProjectWorkloadContainer,
  buildPortalProjectWorkloadCreateArgs,
  buildPortalProjectWorkloadPlan,
  preparePortalProjectWorkloadContainer,
  removePortalProjectWorkloadByIdentity,
  removePreparedPortalProjectWorkloadContainer,
  type PortalProjectWorkloadContainerOptions,
  type PortalProjectWorkloadPlan,
} from './projectWorkloadRuntime';
import { __appCredentialProjectionTest as seams, materializeAppCredentials, type AppCredentialAttachment } from './appCredentials/projection';

const IMAGE = `sha256:${'a'.repeat(64)}`;
const APP = '11111111-2222-4333-8444-555555555555';
const SECRET = 'DUMMY-NOT-A-REAL-SECRET';

let base: string;
let workspace: string;
let attachment: AppCredentialAttachment;

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'workload-credentials-'));
  workspace = mkdtempSync(path.join(base, 'workspace-'));
  seams.setRuntimeRoot(path.join(base, 'app-credentials'));
  seams.setFilesystemType(() => seams.TMPFS_MAGIC);
  attachment = materializeAppCredentials({ appId: APP, revision: 4, entries: [
    { slot: 'api-token', value: `{"password":"${SECRET}"}` },
    { slot: 'legacy-key', value: '{"username":"123456"}' },
  ] });
});

afterEach(() => {
  seams.reset();
  rmSync(base, { recursive: true, force: true });
});

function appOptions(overrides: Partial<PortalProjectWorkloadContainerOptions> = {}): PortalProjectWorkloadContainerOptions {
  return {
    identity: { actorId: 'actor-full-uuid', projectId: 'project-full-uuid', consumerKind: 'PORTAL_APP', workloadId: APP },
    containerName: 'bridgesllm-project-app-credentials',
    workspace,
    image: IMAGE,
    command: 'npm',
    args: ['start'],
    environment: { HOME: '/tmp/project-home', PORTAL_CREDENTIALS_DIR: '/portal/credentials' },
    networked: false,
    pidsLimit: 256,
    memoryBytes: 512 * 1024 * 1024,
    nanoCpus: 1_000_000_000,
    tmpfsSize: '128m',
    credentialAttachment: attachment,
    ...overrides,
  };
}

function inspect(plan: PortalProjectWorkloadPlan): any {
  return {
    Id: 'b'.repeat(64),
    Name: `/${plan.containerName}`,
    Config: {
      Image: plan.image,
      User: '1000:1000',
      Cmd: [plan.command, ...plan.args],
      Env: Object.entries(plan.environment).map(([key, value]) => `${key}=${value}`),
      Labels: __projectWorkloadRuntimeTest.workloadLabels(plan),
    },
    State: { Running: false, Status: 'created' },
    HostConfig: {
      ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Privileged: false,
      PidMode: '', IpcMode: '', NetworkMode: 'none', RestartPolicy: { Name: 'no' },
      PidsLimit: plan.pidsLimit, Memory: plan.memoryBytes, NanoCpus: plan.nanoCpus,
      Tmpfs: { '/tmp': `rw,nosuid,nodev,noexec,size=${plan.tmpfsSize}` }, PortBindings: {},
    },
    Mounts: [
      { Type: 'bind', Source: plan.workspace, Destination: '/workspace/project', RW: true },
      { Type: 'bind', Source: attachment.sourceDirectory, Destination: '/portal/credentials', RW: false },
    ],
    NetworkSettings: { Networks: { none: {} }, Ports: {} },
  };
}

function absentExecutor(calls: string[][] = []) {
  return {
    run: jest.fn(async (command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      if (args[0] === 'container' && args[1] === 'inspect') return { stdout: '', stderr: 'Error: No such container', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
  };
}

describe('App credential mount on the resident App container', () => {
  test('mounts the directory read-only at /portal/credentials and puts only its path in the environment', async () => {
    const plan = await buildPortalProjectWorkloadPlan(appOptions());
    const args = buildPortalProjectWorkloadCreateArgs(plan);
    expect(args).toContain(`type=bind,src=${attachment.sourceDirectory},dst=/portal/credentials,readonly`);
    expect(args.filter((value) => value.startsWith('PORTAL_CREDENTIALS_DIR='))).toEqual(['PORTAL_CREDENTIALS_DIR=/portal/credentials']);
    expect(args.filter((value) => value.startsWith('type=bind,') && !value.endsWith(',readonly'))).toEqual([
      `type=bind,src=${workspace},dst=/workspace/project`,
    ]);
    // Values never reach argv, the environment, labels or the fingerprint.
    for (const haystack of [args.join('\n'), JSON.stringify(plan), JSON.stringify(__projectWorkloadRuntimeTest.workloadLabels(plan))]) {
      expect(haystack).not.toContain(SECRET);
      expect(haystack).not.toContain('123456');
    }
    expect(() => attestPortalProjectWorkloadContainer(plan, inspect(plan), { running: false, networkName: 'none' })).not.toThrow();
  });

  test.each([
    ['the mount is missing', (value: any) => { value.Mounts.pop(); }],
    ['the mount is writable', (value: any) => { value.Mounts[1].RW = true; }],
    ['the mount comes from another directory', (value: any) => { value.Mounts[1].Source = `${attachment.sourceDirectory}x`; }],
    ['the mount sits elsewhere in the container', (value: any) => { value.Mounts[1].Destination = '/workspace/project/credentials'; }],
    ['an extra read-only mount appears', (value: any) => { value.Mounts.push({ Type: 'bind', Source: '/etc', Destination: '/portal/etc', RW: false }); }],
  ])('attestation fails closed when %s', async (_label, mutate) => {
    const plan = await buildPortalProjectWorkloadPlan(appOptions());
    const actual = inspect(plan);
    mutate(actual);
    expect(() => attestPortalProjectWorkloadContainer(plan, actual, { running: false, networkName: 'none' }))
      .toThrow(PortalProjectWorkloadError);
  });

  test('attestation fails closed when the directory changes after planning', async () => {
    const plan = await buildPortalProjectWorkloadPlan(appOptions());
    rmSync(attachment.sourceDirectory, { recursive: true });
    expect(() => attestPortalProjectWorkloadContainer(plan, inspect(plan), { running: false, networkName: 'none' }))
      .toThrow(expect.objectContaining({ code: 'APP_CREDENTIAL_MOUNT_SOURCE' }));
  });

  test('no other workload can receive credentials, and the path needs an attested attachment', async () => {
    const lifecycle = appOptions({ identity: { actorId: 'actor-full-uuid', projectId: 'project-full-uuid', consumerKind: 'PORTAL_LIFECYCLE', workloadId: APP } });
    await expect(buildPortalProjectWorkloadPlan(lifecycle)).rejects.toThrow('credential attachment identity is invalid');
    const git = appOptions({ identity: { actorId: 'actor-full-uuid', projectId: 'project-full-uuid', consumerKind: 'PORTAL_GIT', workloadId: APP } });
    await expect(buildPortalProjectWorkloadPlan(git)).rejects.toThrow('credential attachment identity is invalid');
    const otherApp = appOptions({ identity: { actorId: 'actor-full-uuid', projectId: 'project-full-uuid', consumerKind: 'PORTAL_APP', workloadId: '66666666-7777-4888-8999-000000000000' } });
    await expect(buildPortalProjectWorkloadPlan(otherApp)).rejects.toThrow('credential attachment identity is invalid');
    await expect(buildPortalProjectWorkloadPlan(appOptions({ environment: { HOME: '/tmp/project-home', PORTAL_CREDENTIALS_DIR: '/workspace/project' } })))
      .rejects.toThrow('credential attachment identity is invalid');
    await expect(buildPortalProjectWorkloadPlan(appOptions({ environment: { HOME: '/tmp/project-home' } })))
      .rejects.toThrow('credential attachment identity is invalid');
    await expect(buildPortalProjectWorkloadPlan(appOptions({ credentialAttachment: undefined })))
      .rejects.toThrow('requires an attested attachment');
    rmSync(path.join(attachment.sourceDirectory, 'legacy-key'), { force: true });
    await expect(buildPortalProjectWorkloadPlan(appOptions())).rejects.toThrow('changed or is unsafe');
  });

  test('removing the prepared container removes its directory, even when Docker removal fails', async () => {
    const plan = await buildPortalProjectWorkloadPlan(appOptions());
    await removePreparedPortalProjectWorkloadContainer(plan, absentExecutor());
    expect(existsSync(attachment.sourceDirectory)).toBe(false);

    attachment = materializeAppCredentials({ appId: APP, revision: 5, entries: [{ slot: 'api-token', value: 'x' }] });
    const second = await buildPortalProjectWorkloadPlan(appOptions());
    const broken = { run: jest.fn(async () => { throw new Error('docker unavailable'); }) };
    await expect(removePreparedPortalProjectWorkloadContainer(second, broken)).rejects.toThrow('docker unavailable');
    expect(existsSync(attachment.sourceDirectory)).toBe(false);
  });

  // Each start writes a fresh directory, so an App container left from an
  // earlier start (a Portal crash leaves it behind) is replaced, never resumed.
  function replacementExecutor(existing: any) {
    const calls: string[][] = [];
    let current: any = existing;
    let createdPlan: PortalProjectWorkloadPlan | null = null;
    const executor = {
      run: jest.fn(async (command: string, args: readonly string[]) => {
        calls.push([command, ...args]);
        if (args[0] === 'container' && args[1] === 'inspect') {
          return current
            ? { stdout: JSON.stringify([current]), stderr: '', exitCode: 0 }
            : { stdout: '', stderr: 'Error: No such container', exitCode: 1 };
        }
        if (args[0] === 'container' && args[1] === 'rm') current = null;
        if (args[0] === 'container' && args[1] === 'create') {
          current = inspect(createdPlan!);
          if (!createdPlan!.credentialAttachment) current.Mounts = current.Mounts.slice(0, 1);
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    };
    return { calls, executor, setPlan: (plan: PortalProjectWorkloadPlan) => { createdPlan = plan; } };
  }

  test('a credential-bearing start replaces an earlier container of the same App instead of resuming it', async () => {
    const plan = await buildPortalProjectWorkloadPlan(appOptions());
    const earlier = inspect(plan);
    earlier.Mounts[1].Source = '/run/bridgesllm/app-credentials/removed-at-boot';
    earlier.State = { Running: true, Status: 'running' };
    const fake = replacementExecutor(earlier);
    fake.setPlan(plan);
    const prepared = await preparePortalProjectWorkloadContainer(appOptions(), { allowExisting: true, executor: fake.executor });
    const commands = fake.calls.map((call) => call.slice(1, 3).join(' '));
    expect(commands.indexOf('container rm')).toBeGreaterThan(-1);
    expect(commands.indexOf('container rm')).toBeLessThan(commands.indexOf('container create'));
    expect(fake.calls.find((call) => call[2] === 'rm')).toEqual(['docker', 'container', 'rm', '--force', plan.containerName]);
    expect(commands).not.toContain('container stop');
    expect(prepared.credentialAttachment).toBe(attachment);
  });

  test('a start without credentials also replaces a container that still mounts a credential directory', async () => {
    const plan = await buildPortalProjectWorkloadPlan(appOptions());
    const fake = replacementExecutor(inspect(plan));
    const withoutCredentials = appOptions({ credentialAttachment: undefined, environment: { HOME: '/tmp/project-home' } });
    fake.setPlan(await buildPortalProjectWorkloadPlan(withoutCredentials));
    await preparePortalProjectWorkloadContainer(withoutCredentials, { allowExisting: true, executor: fake.executor });
    expect(fake.calls.filter((call) => call[2] === 'rm')).toEqual([['docker', 'container', 'rm', '--force', plan.containerName]]);
  });

  test('replacement refuses a container whose durable identity does not match', async () => {
    const plan = await buildPortalProjectWorkloadPlan(appOptions());
    const foreign = inspect(plan);
    foreign.Config.Labels = { ...foreign.Config.Labels,
      [__projectWorkloadRuntimeTest.labels.LABEL_WORKLOAD]: '66666666-7777-4888-8999-000000000000' };
    const fake = replacementExecutor(foreign);
    fake.setPlan(plan);
    await expect(preparePortalProjectWorkloadContainer(appOptions(), { allowExisting: true, executor: fake.executor }))
      .rejects.toMatchObject({ code: 'CONTAINER_REPLACEMENT_IDENTITY' });
    expect(fake.calls.some((call) => call[2] === 'rm' || call[2] === 'create')).toBe(false);
  });

  test('durable cleanup by identity removes every directory of that App only', async () => {
    const newer = materializeAppCredentials({ appId: APP, revision: 5, entries: [{ slot: 'api-token', value: 'x' }] });
    const other = materializeAppCredentials({ appId: '66666666-7777-4888-8999-000000000000', revision: 1, entries: [{ slot: 'api-token', value: 'x' }] });
    await removePortalProjectWorkloadByIdentity(
      { actorId: 'actor-full-uuid', projectId: 'project-full-uuid', consumerKind: 'PORTAL_APP', workloadId: APP },
      'bridgesllm-project-app-credentials',
      absentExecutor(),
    );
    expect(existsSync(attachment.sourceDirectory)).toBe(false);
    expect(existsSync(newer.sourceDirectory)).toBe(false);
    expect(existsSync(other.sourceDirectory)).toBe(true);
    // A lifecycle job with the same workload id never touches App credentials.
    await removePortalProjectWorkloadByIdentity(
      { actorId: 'actor-full-uuid', projectId: 'project-full-uuid', consumerKind: 'PORTAL_LIFECYCLE', workloadId: '66666666-7777-4888-8999-000000000000' },
      'bridgesllm-project-job-credentials',
      absentExecutor(),
    );
    expect(readdirSync(path.dirname(other.sourceDirectory))).toEqual([path.basename(other.sourceDirectory)]);
  });
});
