/**
 * Credential custody proof against the real docker CLI. Opt-in:
 *
 *   PORTAL_DOCKER_CLI_CONTRACT=1       run the host's docker CLI from PATH
 *   PORTAL_DOCKER_CLI_CONTRACT_OUT     optional directory for a metadata-only report
 *
 * No Docker daemon is contacted. DOCKER_HOST names a fake Engine API on a
 * private unix socket, and DOCKER_CONFIG is an empty directory. While each
 * create request is open, the fake Engine reads the waiting docker CLI's own
 * /proc cmdline and environ, so the proof covers the real argv and the real
 * subprocess environment. Run it where the real daemon socket is also
 * unreachable, for example under bwrap with a tmpfs over /run.
 *
 * Every credential here is synthetic, and assertions compare through booleans.
 */
jest.mock('../config/database', () => ({ prisma: {} }));
jest.mock('../config/env', () => ({
  config: {
    projectEgressProxyImageId: `sha256:${'a'.repeat(64)}`,
    projectEgressTokenSecret: require('crypto').randomBytes(32).toString('base64url'),
  },
}));
// The CLI reads and inlines the seccomp file; a fixture profile keeps the
// proof independent of the installer's host files.
jest.mock('./projectRuntimeConfinement', () => ({
  ...jest.requireActual('./projectRuntimeConfinement'),
  projectRuntimeSecurityOptArgs: () => Object.freeze([
    '--security-opt', 'no-new-privileges:true',
    '--security-opt', `seccomp=${process.env.PORTAL_DOCKER_CLI_CONTRACT_SECCOMP}`,
    '--security-opt', 'apparmor=bridgesllm-project-runtime-v1',
  ]),
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
import { execFileSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import {
  ProjectEgressAttestationError,
  __projectEgressPlaneTest,
  buildProjectEgressPlaneSpec,
  issueProjectEgressProxyToken,
  projectEgressCommandExecutor,
  type ProjectEgressCommandExecutor,
  type ProjectEgressCommandResult,
  type ProjectEgressPlaneSpec,
} from './projectEgressPlane';
import {
  PortalProjectWorkloadError,
  __projectWorkloadRuntimeTest,
  buildPortalProjectWorkloadPlan,
  preparePortalProjectWorkloadContainer,
  type PortalProjectWorkloadContainerOptions,
  type PortalProjectWorkloadPlan,
} from './projectWorkloadRuntime';
import { PROJECT_EGRESS_POLICY_VERSION } from './projectEgressPolicy';

const enabled = process.env.PORTAL_DOCKER_CLI_CONTRACT === '1';
const contract = enabled ? test : test.skip;
const OUT = process.env.PORTAL_DOCKER_CLI_CONTRACT_OUT || '';
const PROXY_IMAGE = `sha256:${'a'.repeat(64)}`;
const RUN = crypto.randomBytes(6).toString('hex');
const DOCKER_KEYS = ['DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
  'PORTAL_DOCKER_CLI_CONTRACT_SECCOMP', 'PROJECT_EGRESS_PROXY_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY',
  'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];

interface CliSnapshot {
  processes: number;
  argvCarriesSecret: boolean;
  environCarriesEverySecret: boolean;
  environNoProxy: string | null;
  environLowerNoProxy: string | null;
}

interface EngineCreate {
  name: string | null;
  env: string[];
  labels: Record<string, string>;
  cli: CliSnapshot;
}

let directory = '';
let socketPath = '';
let server: http.Server | null = null;
let engineMode: 'accept' | 'refuse-echo' = 'accept';
let expectedSecrets: Record<string, string> = {};
let cliMarker = '';
const creates: EngineCreate[] = [];
const requests: string[] = [];
const report: Record<string, unknown> = { run: RUN, cases: {} as Record<string, unknown> };
const saved = new Map<string, string | undefined>();

const usedSecrets: string[] = [];
const executorRefusals: boolean[] = [];

function expectSecrets(secrets: Record<string, string>, unexpected: readonly string[] = []): void {
  expectedSecrets = secrets;
  for (const value of [...Object.values(secrets), ...unexpected]) {
    if (!value) continue;
    usedSecrets.push(value);
    try {
      const password = new URL(value).password;
      if (password) usedSecrets.push(password);
    } catch {
      // Not a URL: the whole value is the secret.
    }
  }
}

function cliSnapshot(): CliSnapshot {
  const matches: Array<{ argv: string[]; environ: string[] }> = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(entry)) continue;
    let argv: string[];
    try {
      argv = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    if (argv.length === 0 || path.basename(argv[0]) !== 'docker' || !argv.includes(cliMarker)) continue;
    let environ: string[] = [];
    try {
      environ = fs.readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').filter(Boolean);
    } catch {
      environ = [];
    }
    matches.push({ argv, environ });
  }
  const secrets = Object.entries(expectedSecrets);
  const values = secrets.flatMap(([, value]) => {
    const password = (() => {
      try { return new URL(value).password; } catch { return ''; }
    })();
    return password ? [value, password] : [value];
  });
  const environValue = (environ: string[], key: string) => {
    const found = environ.find((item) => item.startsWith(`${key}=`));
    return found === undefined ? null : found.slice(key.length + 1);
  };
  return {
    processes: matches.length,
    argvCarriesSecret: matches.some(({ argv }) => argv.some((item) => values.some((value) => item.includes(value)))),
    environCarriesEverySecret: matches.length > 0 && matches.every(({ environ }) => (
      secrets.every(([key, value]) => environ.includes(`${key}=${value}`)))),
    environNoProxy: matches.length === 1 ? environValue(matches[0].environ, 'NO_PROXY') : null,
    environLowerNoProxy: matches.length === 1 ? environValue(matches[0].environ, 'no_proxy') : null,
  };
}

function startEngine(): Promise<void> {
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url || '/', 'http://engine');
      requests.push(`${request.method} ${url.pathname}`);
      if (/^\/(v[0-9.]+\/)?_ping$/.test(url.pathname)) {
        response.writeHead(200, { 'Api-Version': '1.56', 'Ostype': 'linux', 'Content-Type': 'text/plain' });
        response.end(request.method === 'HEAD' ? undefined : 'OK');
        return;
      }
      if (request.method === 'POST' && /^\/v[0-9.]+\/containers\/create$/.test(url.pathname)) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        creates.push({
          name: url.searchParams.get('name'),
          env: Array.isArray(body.Env) ? body.Env.map(String) : [],
          labels: body.Labels || {},
          cli: cliSnapshot(),
        });
        if (engineMode === 'refuse-echo') {
          // A hostile daemon echoing the credential entries it received, short
          // enough that the whole message lands in the quoted stderr tail.
          const echoed = (Array.isArray(body.Env) ? body.Env.map(String) : [])
            .filter((entry: string) => /^(PROJECT_EGRESS_PROXY_TOKEN|HTTPS?_PROXY|https?_proxy)=./.test(entry));
          response.writeHead(500, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ message: `synthetic refusal of ${echoed.join(' ')}` }));
          return;
        }
        response.writeHead(201, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ Id: crypto.randomBytes(32).toString('hex'), Warnings: [] }));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: 'page not found' }));
    });
  });
  return new Promise((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(socketPath, () => resolve());
  });
}

// The executor refuses a named credential without its value before spawning.
// To keep exercising the post-create defenses, a CLI that never receives the
// value is spawned directly.
function spawnCliWithoutCredentials(args: readonly string[]): Promise<ProjectEgressCommandResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_PROXY: '*', no_proxy: '*' };
  for (const key of ['PROJECT_EGRESS_PROXY_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    delete env[key];
  }
  return new Promise((resolve) => {
    const child = spawn('docker', [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('close', (code) => resolve({
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      exitCode: code ?? 1,
    }));
  });
}

// Forward only `container create` to the real CLI; it must reach the fake Engine.
async function realCreate(
  args: readonly string[],
  options: { secretEnvironment?: Readonly<Record<string, string>> },
  dropSecretEnvironment: boolean,
  received: (created: EngineCreate | null) => void = () => undefined,
): Promise<{ result: ProjectEgressCommandResult; created: EngineCreate | null }> {
  if (process.env.DOCKER_HOST !== `unix://${socketPath}` || process.env.DOCKER_CONTEXT !== undefined) {
    throw new Error('Refusing to run the docker CLI outside the fake Engine');
  }
  const before = creates.length;
  const nameIndex = args.indexOf('--name');
  cliMarker = String(args[nameIndex + 1]);
  const engineRecord = () => (creates.length > before ? creates[creates.length - 1] : null);
  try {
    if (dropSecretEnvironment) {
      const refusal = await projectEgressCommandExecutor.run('docker', args, { ...options, secretEnvironment: undefined })
        .then(() => null, (error: Error) => error);
      executorRefusals.push(refusal?.message === 'Project egress protected environment is incomplete'
        && creates.length === before);
      const result = await spawnCliWithoutCredentials(args);
      if (result.exitCode !== 0) throw new Error('docker create without credentials failed');
      return { result, created: engineRecord() };
    }
    const result = await projectEgressCommandExecutor.run('docker', args, options);
    return { result, created: engineRecord() };
  } finally {
    // A refused create still reports what the Engine received.
    received(engineRecord());
  }
}

function labelsFor(spec: ProjectEgressPlaneSpec): Record<string, string> {
  const labels = __projectEgressPlaneTest.labels;
  return {
    [labels.LABEL_POLICY]: PROJECT_EGRESS_POLICY_VERSION,
    [labels.LABEL_FINGERPRINT]: spec.policyFingerprint,
    [labels.LABEL_IDENTITY]: spec.identityFingerprint,
    [labels.LABEL_ACTOR_ID]: spec.identity.actorId,
    [labels.LABEL_PROJECT_ID]: spec.identity.projectId,
    [labels.LABEL_PROVIDER]: spec.identity.provider,
    ...(spec.identity.consumerKind ? { [labels.LABEL_CONSUMER_KIND]: spec.identity.consumerKind } : {}),
    ...(spec.identity.workloadId ? { [labels.LABEL_WORKLOAD_ID]: spec.identity.workloadId } : {}),
  };
}

// Canned inventory and networks; the proxy object reflects what the Engine received.
class ProxyHarness implements ProjectEgressCommandExecutor {
  readonly calls: Array<readonly string[]> = [];
  proxy: any = null;
  created: EngineCreate | null = null;
  dropSecretEnvironment = false;

  constructor(readonly spec: ProjectEgressPlaneSpec) {}

  async run(
    command: string,
    args: readonly string[],
    options: { secretEnvironment?: Readonly<Record<string, string>> } = {},
  ): Promise<ProjectEgressCommandResult> {
    this.calls.push(args);
    const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
    const spec = this.spec;
    if (command !== 'docker') return ok();
    if (args[0] === 'container' && args[1] === 'create') {
      const { result, created } = await realCreate(args, options, this.dropSecretEnvironment, (value) => {
        this.created = value;
      });
      const id = result.stdout.trim();
      this.proxy = {
        Id: id,
        Name: `/${created?.name}`,
        Image: PROXY_IMAGE,
        Config: {
          Image: PROXY_IMAGE,
          User: '65532:65532',
          Cmd: [...spec.proxyCommand],
          Entrypoint: null,
          WorkingDir: '/opt/bridgesllm/backend',
          Env: [
            'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'NODE_VERSION=22.16.0',
            'YARN_VERSION=1.22.22',
            ...(created?.env || []),
          ],
          Labels: created?.labels || {},
        },
        State: { Running: false },
        HostConfig: {
          ReadonlyRootfs: true, CapAdd: [], CapDrop: ['ALL'],
          SecurityOpt: [
            'no-new-privileges:true',
            'seccomp=/etc/bridgesllm/project-runtime/bridgesllm-project-runtime-v1.seccomp.json',
            'apparmor=bridgesllm-project-runtime-v1',
          ],
          Binds: null, Mounts: null, PortBindings: {}, NetworkMode: 'e'.repeat(64), Privileged: false,
          PidMode: '', IpcMode: '', RestartPolicy: { Name: 'no' }, PidsLimit: 128,
          Memory: 256 * 1024 * 1024, NanoCpus: 500_000_000,
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m' },
        },
        AppArmorProfile: 'bridgesllm-project-runtime-v1',
        Mounts: [],
        NetworkSettings: {
          Networks: {
            [spec.publicNetworkName]: {
              IPAddress: '', GlobalIPv6Address: '', Aliases: [], NetworkID: 'e'.repeat(64),
              IPAMConfig: { IPv4Address: '172.29.0.2' },
            },
          },
        },
      };
      return result;
    }
    if (args[0] === 'container' && args[1] === 'ls') return ok(this.proxy ? `${this.proxy.Id}\n` : '');
    if (args[0] === 'container' && args[1] === 'inspect') {
      if (!this.proxy) return { stdout: '', stderr: 'Error: No such container', exitCode: 1 };
      return ok(JSON.stringify([this.proxy]));
    }
    if (args[0] === 'container' && args[1] === 'rm') this.proxy = null;
    if (args[0] === 'network' && args[1] === 'ls') return ok(`${'d'.repeat(64)}\n${'e'.repeat(64)}\n`);
    if (args[0] === 'network' && args[1] === 'inspect') {
      const internal = [spec.internalNetworkName, 'd'.repeat(64)].includes(String(args[2]));
      return ok(JSON.stringify([internal ? {
        Id: 'd'.repeat(64), Name: spec.internalNetworkName, Driver: 'bridge', Internal: true,
        Labels: { ...labelsFor(spec), [__projectEgressPlaneTest.labels.LABEL_ROLE]: 'internal' }, Containers: {},
      } : {
        Id: 'e'.repeat(64), Name: spec.publicNetworkName, Driver: 'bridge', Internal: false,
        Labels: { ...labelsFor(spec), [__projectEgressPlaneTest.labels.LABEL_ROLE]: 'proxy-public' },
        Containers: {}, IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
      }]));
    }
    if (args[0] === 'network' && args[1] === 'connect') {
      this.proxy.NetworkSettings.Networks[spec.internalNetworkName] = {
        IPAddress: '', Aliases: [spec.proxyAlias], NetworkID: 'd'.repeat(64),
      };
    }
    return ok();
  }
}

class WorkloadHarness implements ProjectEgressCommandExecutor {
  readonly calls: Array<readonly string[]> = [];
  plan: PortalProjectWorkloadPlan | null = null;
  created: EngineCreate | null = null;
  containerId = '';
  dropSecretEnvironment = false;

  async run(
    command: string,
    args: readonly string[],
    options: { secretEnvironment?: Readonly<Record<string, string>> } = {},
  ): Promise<ProjectEgressCommandResult> {
    this.calls.push(args);
    const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
    if (command !== 'docker') return ok();
    if (args[0] === 'container' && args[1] === 'create') {
      const { result } = await realCreate(args, options, this.dropSecretEnvironment, (value) => {
        this.created = value;
      });
      this.containerId = result.stdout.trim();
      return result;
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      if (!this.containerId || !this.plan || !this.created) {
        return { stdout: '', stderr: 'Error: No such container', exitCode: 1 };
      }
      const plan = this.plan;
      return ok(JSON.stringify([{
        Id: this.containerId,
        Name: `/${this.created.name}`,
        Image: plan.image,
        Config: {
          Image: plan.image, User: '1000:1000', Cmd: [plan.command, ...plan.args],
          Env: this.created.env, Labels: this.created.labels,
        },
        State: { Running: false, Status: 'created' },
        HostConfig: {
          ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Privileged: false,
          PidMode: '', IpcMode: '', NetworkMode: plan.egressHandle?.internalNetworkId || 'none',
          RestartPolicy: { Name: 'no' }, PidsLimit: plan.pidsLimit, Memory: plan.memoryBytes,
          NanoCpus: plan.nanoCpus, Tmpfs: { '/tmp': `rw,nosuid,nodev,noexec,size=${plan.tmpfsSize}` },
          PortBindings: {},
        },
        Mounts: [{ Type: 'bind', Source: plan.workspace, Destination: '/workspace/project', RW: true }],
        NetworkSettings: {
          Networks: { [plan.egressSpec?.internalNetworkName || 'none']: { NetworkID: '' } }, Ports: {},
        },
      }]));
    }
    if (args[0] === 'container' && args[1] === 'rm') this.containerId = '';
    return ok();
  }
}

function proxySpec(): ProjectEgressPlaneSpec {
  return buildProjectEgressPlaneSpec({
    identity: {
      actorId: `contract-actor-${RUN}-${crypto.randomBytes(4).toString('hex')}`,
      projectId: 'contract-project',
      provider: 'PORTAL_WORKLOAD',
      consumerKind: 'PORTAL_APP',
      workloadId: 'contract-app',
    },
    proxyImage: PROXY_IMAGE,
    token: issueProjectEgressProxyToken(),
  });
}

function workloadOptions(workspace: string): PortalProjectWorkloadContainerOptions {
  const suffix = crypto.randomBytes(4).toString('hex');
  return {
    identity: {
      actorId: `contract-actor-${RUN}`, projectId: 'contract-project',
      consumerKind: 'PORTAL_APP', workloadId: `contract-app-${suffix}`,
    },
    containerName: `bridgesllm-project-app-contract-${RUN}-${suffix}`,
    workspace,
    image: `sha256:${'b'.repeat(64)}`,
    command: 'node',
    args: ['server.js'],
    environment: { HOME: '/tmp/project-home', CI: 'true' },
    networked: true,
    pidsLimit: 256,
    memoryBytes: 1536 * 1024 * 1024,
    nanoCpus: 1_500_000_000,
    tmpfsSize: '512m',
  };
}

// The docker CLI rebuilds `--env` through a map, so the Engine sees the
// entries in a varying order; compare the exact entries and values.
function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function inlineEnvironment(plan: PortalProjectWorkloadPlan): string[] {
  return Object.entries(plan.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the operation to fail');
}

function record(name: string, value: Record<string, unknown>): void {
  (report.cases as Record<string, unknown>)[name] = value;
}

beforeAll(async () => {
  if (!enabled) return;
  for (const key of DOCKER_KEYS) saved.set(key, process.env[key]);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-cli-contract-'));
  fs.chmodSync(directory, 0o700);
  socketPath = path.join(directory, 'engine.sock');
  const config = path.join(directory, 'docker-config');
  fs.mkdirSync(config, { mode: 0o700 });
  const seccomp = path.join(directory, 'seccomp.json');
  fs.writeFileSync(seccomp, JSON.stringify({ defaultAction: 'SCMP_ACT_ALLOW' }));
  for (const key of DOCKER_KEYS) delete process.env[key];
  process.env.DOCKER_HOST = `unix://${socketPath}`;
  process.env.DOCKER_CONFIG = config;
  process.env.PORTAL_DOCKER_CLI_CONTRACT_SECCOMP = seccomp;
  await startEngine();
  report.dockerClient = execFileSync('docker', ['--version'], { encoding: 'utf8' }).trim();
});

afterAll(async () => {
  if (!enabled) return;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  report.engineRequests = [...new Set(requests)].sort();
  if (OUT) {
    const text = `${JSON.stringify(report, null, 2)}\n`;
    // Metadata only: refuse to write a report that carries any credential used here.
    if (usedSecrets.some((secret) => text.includes(secret))) throw new Error('Contract report would carry a credential');
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'docker-cli-contract-report.json'), text, { mode: 0o644 });
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('docker CLI credential custody (real CLI, fake Engine)', () => {
  contract('proxy token: named on argv, only in the CLI environment, delivered to the Engine', async () => {
    const spec = proxySpec();
    expectSecrets({ PROJECT_EGRESS_PROXY_TOKEN: spec.token });
    const harness = new ProxyHarness(spec);
    await expect(__projectEgressPlaneTest.ensureProxyContainer(harness, spec)).resolves.toBeTruthy();
    const created = harness.created!;
    const expectedEnv = [
      `PROJECT_EGRESS_PROXY_TOKEN=${spec.token}`,
      `PROJECT_EGRESS_PROXY_PORT=${spec.proxyPort}`,
      `PROJECT_EGRESS_DENY_CIDRS=${JSON.stringify(spec.deniedCidrs)}`,
    ];
    const exactEnv = sameEntries(created.env, expectedEnv);
    const argvClean = !harness.calls.some((args) => args.some((value) => value.includes(spec.token)));
    expect(created.name).toBe(spec.proxyContainerName);
    expect(exactEnv).toBe(true);
    expect(argvClean).toBe(true);
    expect(created.cli.processes).toBe(1);
    expect(created.cli.argvCarriesSecret).toBe(false);
    expect(created.cli.environCarriesEverySecret).toBe(true);
    expect(created.cli.environNoProxy).toBe('*');
    expect(created.labels[__projectEgressPlaneTest.labels.LABEL_TOKEN_HASH]).toBe(spec.tokenHash);
    expect(harness.calls.some((args) => args[0] === 'container' && args[1] === 'rm')).toBe(false);
    record('proxyCreate', {
      engineEnvNames: created.env.map((entry) => entry.split('=')[0]),
      engineEnvExactEntries: exactEnv,
      engineOrderMatchedArgv: JSON.stringify(created.env) === JSON.stringify(expectedEnv),
      argvClean, cli: created.cli, removed: false,
    });
  });

  contract('workload proxy credentials: named on argv, Engine receives the exact environment entries', async () => {
    const workspace = fs.mkdtempSync(path.join(directory, 'workspace-'));
    const harness = new WorkloadHarness();
    const options = workloadOptions(workspace);
    harness.plan = await buildPortalProjectWorkloadPlan(options, harness);
    const plan = harness.plan;
    const token = plan.egressSpec!.token;
    expectSecrets(Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']
      .map((key) => [key, plan.environment[key]])));
    await expect(preparePortalProjectWorkloadContainer(options, { executor: harness })).resolves.toBeTruthy();
    const created = harness.created!;
    const exactEnv = sameEntries(created.env, inlineEnvironment(plan));
    const argvClean = !harness.calls.some((args) => args.some((value) => value.includes(token)));
    expect(exactEnv).toBe(true);
    expect(argvClean).toBe(true);
    expect(created.env).toEqual(expect.arrayContaining(['NO_PROXY=', 'no_proxy=']));
    expect(created.cli.processes).toBe(1);
    expect(created.cli.argvCarriesSecret).toBe(false);
    expect(created.cli.environCarriesEverySecret).toBe(true);
    expect(created.cli.environNoProxy).toBe('*');
    expect(created.cli.environLowerNoProxy).toBe('*');
    expect(created.labels).toEqual(expect.objectContaining(__projectWorkloadRuntimeTest.workloadLabels(plan)));
    expect(harness.calls.some((args) => args[0] === 'container' && args[1] === 'rm')).toBe(false);
    record('workloadCreate', {
      engineEnvNames: created.env.map((entry) => entry.split('=')[0]),
      engineEnvExactEntries: exactEnv,
      engineOrderMatchedArgv: JSON.stringify(created.env) === JSON.stringify(inlineEnvironment(plan)),
      argvClean, cli: created.cli, removed: false,
    });
  });

  contract('a hostile Engine echo of the credential is redacted and nothing is removed', async () => {
    engineMode = 'refuse-echo';
    try {
      const spec = proxySpec();
      expectSecrets({ PROJECT_EGRESS_PROXY_TOKEN: spec.token });
      const proxy = new ProxyHarness(spec);
      const proxyFailure = await failureOf(__projectEgressPlaneTest.ensureProxyContainer(proxy, spec));
      const proxyEchoed = proxy.created!.env.some((entry) => entry.includes(spec.token));

      const workspace = fs.mkdtempSync(path.join(directory, 'workspace-'));
      const workload = new WorkloadHarness();
      const options = workloadOptions(workspace);
      workload.plan = await buildPortalProjectWorkloadPlan(options, workload);
      const token = workload.plan.egressSpec!.token;
      expectSecrets({ HTTPS_PROXY: workload.plan.environment.HTTPS_PROXY }, [token]);
      const workloadFailure = await failureOf(preparePortalProjectWorkloadContainer(options, { executor: workload }));

      for (const [failure, secret] of [[proxyFailure, spec.token], [workloadFailure, token]] as const) {
        expect(failure.message).toContain('synthetic refusal');
        expect(failure.message).toContain('[redacted]');
        expect(failure.message.includes(secret)).toBe(false);
      }
      expect(proxyEchoed).toBe(true);
      expect(proxy.calls.some((args) => args[0] === 'container' && args[1] === 'rm')).toBe(false);
      expect(workload.calls.some((args) => args[0] === 'container' && args[1] === 'rm')).toBe(false);
      record('hostileEcho', {
        engineReceivedCredential: proxyEchoed,
        proxyErrorRedacted: !proxyFailure.message.includes(spec.token),
        workloadErrorRedacted: !workloadFailure.message.includes(token),
        removed: false,
      });
    } finally {
      engineMode = 'accept';
    }
  });

  contract('a credential that never reaches the CLI environment never reaches Docker; the creation is removed', async () => {
    const spec = proxySpec();
    expectSecrets({}, [spec.token]);
    const proxy = new ProxyHarness(spec);
    proxy.dropSecretEnvironment = true;
    const proxyFailure = await failureOf(__projectEgressPlaneTest.ensureProxyContainer(proxy, spec));
    expect(proxyFailure).toBeInstanceOf(ProjectEgressAttestationError);
    expect((proxyFailure as ProjectEgressAttestationError).code).toBe('STALE_PROXY_ENVIRONMENT');
    expect(proxy.created!.env.some((entry) => entry.startsWith('PROJECT_EGRESS_PROXY_TOKEN='))).toBe(false);
    expect(proxy.calls.some((args) => args.some((value) => value.includes(spec.token)))).toBe(false);
    const proxyRemovals = proxy.calls.filter((args) => args[0] === 'container' && args[1] === 'rm');
    expect(proxyRemovals).toHaveLength(1);
    expect(proxyRemovals[0]).not.toContain('--force');

    const workspace = fs.mkdtempSync(path.join(directory, 'workspace-'));
    const workload = new WorkloadHarness();
    const options = workloadOptions(workspace);
    workload.plan = await buildPortalProjectWorkloadPlan(options, workload);
    expectSecrets({}, [workload.plan.egressSpec!.token]);
    workload.dropSecretEnvironment = true;
    const workloadFailure = await failureOf(preparePortalProjectWorkloadContainer(options, { executor: workload }));
    expect(workloadFailure).toBeInstanceOf(PortalProjectWorkloadError);
    expect((workloadFailure as PortalProjectWorkloadError).code).toBe('CONTAINER_ENVIRONMENT');
    expect(workload.created!.env.some((entry) => /^(HTTPS?_PROXY|https?_proxy)=/.test(entry))).toBe(false);
    const workloadToken = workload.plan.egressSpec!.token;
    expect(workload.calls.some((args) => args.some((value) => value.includes(workloadToken)))).toBe(false);
    // The existing workload failure cleanup removes the container this call
    // created by its deterministic name.
    expect(workload.calls.filter((args) => args[0] === 'container' && args[1] === 'rm'))
      .toEqual([['container', 'rm', '--force', workload.plan.containerName]]);
    // The production executor refused both commands before any CLI ran.
    expect(executorRefusals).toEqual([true, true]);
    record('credentialNeverArrives', {
      executorRefusedBeforeSpawn: executorRefusals.length === 2 && executorRefusals.every(Boolean),
      proxyCode: (proxyFailure as ProjectEgressAttestationError).code,
      proxyBareNameSentToEngine: proxy.created!.env.includes('PROJECT_EGRESS_PROXY_TOKEN'),
      proxyRemovedByImmutableId: proxyRemovals.length === 1,
      workloadCode: (workloadFailure as PortalProjectWorkloadError).code,
      workloadBareNamesSentToEngine: ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']
        .filter((key) => workload.created!.env.includes(key)),
      workloadRemoved: true,
    });
  });

  contract('--env NAME delivers values that an env-file line cannot carry', async () => {
    const value = ` lead #hash = "double" 'single' $HOME \\back\nsecond line\r\tend é漢 ${RUN} `;
    expectSecrets({ PROJECT_EGRESS_PROXY_TOKEN: value });
    const name = `docker-cli-contract-${RUN}-values`;
    const { created } = await realCreate(
      ['container', 'create', '--name', name, '--env', 'PROJECT_EGRESS_PROXY_TOKEN', PROXY_IMAGE],
      { secretEnvironment: { PROJECT_EGRESS_PROXY_TOKEN: value } },
      false,
    );
    const exact = JSON.stringify(created!.env) === JSON.stringify([`PROJECT_EGRESS_PROXY_TOKEN=${value}`]);
    expect(exact).toBe(true);
    expect(created!.cli.argvCarriesSecret).toBe(false);
    const refusal = await failureOf(projectEgressCommandExecutor.run(
      'docker',
      ['container', 'create', '--name', `${name}-nul`, '--env', 'PROJECT_EGRESS_PROXY_TOKEN', PROXY_IMAGE],
      { secretEnvironment: { PROJECT_EGRESS_PROXY_TOKEN: `${value}\0` } },
    ));
    expect(refusal.message).toBe('Project egress protected environment is invalid');
    record('valueSemantics', {
      newlineCarriageReturnTabHashQuotesUnicodeExact: exact,
      nulRefusedBeforeSpawn: refusal.message === 'Project egress protected environment is invalid',
    });
  });
});
