jest.mock('../config/database', () => ({ prisma: {} }));
// A synthetic per-run workload egress secret; never a real credential.
jest.mock('../config/env', () => ({
  config: {
    projectEgressProxyImageId: `sha256:${'a'.repeat(64)}`,
    projectEgressTokenSecret: require('crypto').randomBytes(32).toString('base64url'),
  },
}));
// The real plane needs Docker networks and host firewall chains. This handle
// has the production proxy environment shape for the real derived token.
jest.mock('./projectEgressPlane', () => {
  const actual = jest.requireActual('./projectEgressPlane');
  return {
    ...actual,
    ensureProjectEgressPlane: jest.fn(async (egress: any) => {
      const spec = actual.buildProjectEgressPlaneSpec(egress);
      const proxyUrl = `http://portal:${encodeURIComponent(spec.token)}@${spec.proxyAlias}:${spec.proxyPort}`;
      return {
        policyVersion: 'fixture',
        policyFingerprint: spec.policyFingerprint,
        internalNetworkName: spec.internalNetworkName,
        internalNetworkId: 'd'.repeat(64),
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
    }),
    constrainProjectRuntimeToEgressPlane: jest.fn(async () => undefined),
    teardownExactProjectEgressPlane: jest.fn(async () => undefined),
  };
});
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  PortalProjectWorkloadError,
  __projectWorkloadRuntimeTest,
  buildPortalProjectWorkloadCreateArgs,
  buildPortalProjectWorkloadCreateCommand,
  buildPortalProjectWorkloadPlan,
  preparePortalProjectWorkloadContainer,
  type PortalProjectWorkloadContainerOptions,
  type PortalProjectWorkloadPlan,
} from './projectWorkloadRuntime';
import {
  teardownExactProjectEgressPlane,
  type ProjectEgressCommandExecutor,
  type ProjectEgressCommandResult,
} from './projectEgressPlane';

const IMAGE = `sha256:${'b'.repeat(64)}`;
const CONTAINER_ID = 'c'.repeat(64);

function options(workspace: string, networked = true): PortalProjectWorkloadContainerOptions {
  return {
    identity: {
      actorId: 'actor-full-uuid',
      projectId: 'project-full-uuid',
      consumerKind: 'PORTAL_APP',
      workloadId: 'app-custody',
    },
    containerName: 'bridgesllm-project-app-custody',
    workspace,
    image: IMAGE,
    command: 'node',
    args: ['server.js'],
    environment: { HOME: '/tmp/project-home', CI: 'true' },
    networked,
    pidsLimit: 256,
    memoryBytes: 1536 * 1024 * 1024,
    nanoCpus: 1_500_000_000,
    tmpfsSize: '512m',
  };
}

function envArguments(args: readonly string[]): string[] {
  return args.flatMap((value, index) => (value === '--env' ? [String(args[index + 1])] : []));
}

// Docker's `--env NAME`: a bare name takes that variable's value from the
// CLI's own environment, and a name the CLI does not have never arrives.
function receivedEnvironment(
  args: readonly string[],
  secretEnvironment?: Readonly<Record<string, string>>,
): string[] {
  return envArguments(args).flatMap((entry) => {
    if (entry.includes('=')) return [entry];
    return secretEnvironment && Object.prototype.hasOwnProperty.call(secretEnvironment, entry)
      ? [`${entry}=${secretEnvironment[entry]}`] : [];
  });
}

// What the create argv carried before this change: every entry inline.
function inlineEnvironment(plan: PortalProjectWorkloadPlan): string[] {
  return Object.entries(plan.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
}

class WorkloadDocker implements ProjectEgressCommandExecutor {
  readonly calls: Array<{ args: readonly string[]; secretEnvironment?: Readonly<Record<string, string>> }> = [];
  honorSecretEnvironment = true;
  refuseCreate = false;
  plan: PortalProjectWorkloadPlan | null = null;
  private env: string[] | null = null;

  async run(
    command: string,
    args: readonly string[],
    options: { secretEnvironment?: Readonly<Record<string, string>> } = {},
  ): Promise<ProjectEgressCommandResult> {
    this.calls.push({ args, secretEnvironment: options.secretEnvironment });
    const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
    if (command !== 'docker') return ok();
    if (args[0] === 'container' && args[1] === 'create') {
      if (this.refuseCreate) {
        throw new Error('Project egress host command failed with exit code 125 (docker container create --name x …)');
      }
      this.env = receivedEnvironment(args, this.honorSecretEnvironment ? options.secretEnvironment : undefined);
      return ok(`${CONTAINER_ID}\n`);
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      if (!this.env || !this.plan) return { stdout: '', stderr: 'Error: No such container', exitCode: 1 };
      return ok(JSON.stringify([this.inspect(this.plan, this.env)]));
    }
    if (args[0] === 'container' && args[1] === 'rm') this.env = null;
    return ok();
  }

  private inspect(plan: PortalProjectWorkloadPlan, env: string[]): any {
    const networkName = plan.egressSpec?.internalNetworkName || 'none';
    return {
      Id: CONTAINER_ID,
      Name: `/${plan.containerName}`,
      Image: plan.image,
      Config: {
        Image: plan.image,
        User: '1000:1000',
        Cmd: [plan.command, ...plan.args],
        Env: env,
        Labels: __projectWorkloadRuntimeTest.workloadLabels(plan),
      },
      State: { Running: false, Status: 'created' },
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
        PortBindings: {},
      },
      Mounts: [{ Type: 'bind', Source: plan.workspace, Destination: '/workspace/project', RW: true }],
      NetworkSettings: { Networks: { [networkName]: { NetworkID: '' } }, Ports: {} },
    };
  }
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the operation to fail');
}

describe('Portal workload egress credential custody', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(os.tmpdir(), 'portal-workload-custody-test-'));
    jest.mocked(teardownExactProjectEgressPlane).mockClear();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  async function preparedDocker(): Promise<{ docker: WorkloadDocker; plan: PortalProjectWorkloadPlan }> {
    const docker = new WorkloadDocker();
    docker.plan = await buildPortalProjectWorkloadPlan(options(workspace), docker);
    return { docker, plan: docker.plan };
  }

  test('names the proxy credentials on argv and preserves the exact container environment', async () => {
    const { docker, plan } = await preparedDocker();
    const token = plan.egressSpec!.token;
    const prepared = await preparePortalProjectWorkloadContainer(options(workspace), { executor: docker });
    expect(prepared.runtimeFingerprint).toBe(plan.runtimeFingerprint);

    const create = docker.calls.find(({ args }) => args[0] === 'container' && args[1] === 'create')!;
    expect(envArguments(create.args).filter((entry) => !entry.includes('=')).sort())
      .toEqual(['HTTPS_PROXY', 'HTTP_PROXY', 'http_proxy', 'https_proxy']);
    expect(envArguments(create.args)).toEqual(expect.arrayContaining([
      'CI=true', 'HOME=/tmp/project-home', 'NO_PROXY=', 'no_proxy=',
    ]));
    expect(Object.keys(create.secretEnvironment || {}).sort())
      .toEqual(['HTTPS_PROXY', 'HTTP_PROXY', 'http_proxy', 'https_proxy']);
    expect(Object.entries(create.secretEnvironment || {})
      .every(([key, value]) => value === plan.environment[key] && value.includes(token))).toBe(true);
    expect(docker.calls.some(({ args }) => args.some((value) => value.includes(token)))).toBe(false);
    // Resolving the bare names gives back, entry for entry, what argv carried inline.
    expect(JSON.stringify(receivedEnvironment(create.args, create.secretEnvironment))
      === JSON.stringify(inlineEnvironment(plan))).toBe(true);
    expect(docker.calls.some(({ args }) => args[0] === 'container' && args[1] === 'rm')).toBe(false);

    const command = buildPortalProjectWorkloadCreateCommand(plan);
    expect(buildPortalProjectWorkloadCreateArgs(plan)).toEqual(command.args);
    expect(command.args).toEqual(create.args);
  });

  test('removes the created runtime when the named credentials never arrive', async () => {
    const { docker, plan } = await preparedDocker();
    const token = plan.egressSpec!.token;
    docker.honorSecretEnvironment = false;
    const failure = await failureOf(preparePortalProjectWorkloadContainer(options(workspace), { executor: docker }));
    expect(failure).toBeInstanceOf(PortalProjectWorkloadError);
    expect((failure as PortalProjectWorkloadError).code).toBe('CONTAINER_ENVIRONMENT');
    expect(failure.message.includes(token)).toBe(false);
    // The existing failure cleanup removes the container this call created by
    // its deterministic workload name.
    expect(docker.calls.filter(({ args }) => args[0] === 'container' && args[1] === 'rm')
      .map(({ args }) => args)).toEqual([['container', 'rm', '--force', plan.containerName]]);
    expect(teardownExactProjectEgressPlane).toHaveBeenCalled();
    expect(docker.calls.some(({ args }) => args.some((value) => value.includes(token)))).toBe(false);
  });

  test('a refused create removes no container and still retires the plane', async () => {
    const { docker } = await preparedDocker();
    docker.refuseCreate = true;
    await expect(preparePortalProjectWorkloadContainer(options(workspace), { executor: docker }))
      .rejects.toThrow('exit code 125');
    expect(docker.calls.some(({ args }) => args[0] === 'container' && args[1] === 'rm')).toBe(false);
    expect(teardownExactProjectEgressPlane).toHaveBeenCalled();
  });

  test('refuses a plan that would put the egress credential on argv', async () => {
    const { plan } = await preparedDocker();
    const token = plan.egressSpec!.token;
    const leaked = { ...plan, environment: { ...plan.environment, APP_PROXY_COPY: plan.environment.HTTPS_PROXY } };
    const failure = (() => {
      try {
        buildPortalProjectWorkloadCreateCommand(leaked);
      } catch (error) {
        return error as PortalProjectWorkloadError;
      }
      return null;
    })();
    expect(failure?.code).toBe('EGRESS_SECRET_ARGV');
    expect(failure?.message.includes(token)).toBe(false);
  });

  test('offline workloads keep every entry inline and pass no protected environment', async () => {
    const plan = await buildPortalProjectWorkloadPlan(options(workspace, false), new WorkloadDocker());
    const command = buildPortalProjectWorkloadCreateCommand(plan);
    expect(command.secretEnvironment).toEqual({});
    expect(envArguments(command.args)).toEqual(inlineEnvironment(plan));
    expect(command.args).toEqual(expect.arrayContaining(['--network', 'none']));
  });
});
