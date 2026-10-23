/**
 * Credential custody proof for the OpenClaw, Codex and native CLI Project
 * runtimes against the real docker CLI. Opt-in:
 *
 *   PORTAL_DOCKER_CLI_CONTRACT=1       run the host's docker CLI
 *   PORTAL_DOCKER_CLI_CONTRACT_OUT     optional directory for a metadata-only report
 *
 * The production executors hard-code unix:///var/run/docker.sock, so the fake
 * Engine listens there. It refuses to start unless /run is a private, empty
 * tmpfs and the network namespace holds only loopback, for example under
 * `bwrap --tmpfs /run --unshare-net --unshare-pid`. No Docker daemon is
 * contacted. While each create or exec request is open, the fake Engine reads
 * the waiting docker CLI's own /proc cmdline and environ.
 *
 * Every credential here is synthetic and generated per run; assertions compare
 * through booleans.
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
jest.mock('./projectRuntimeConfinement', () => {
  const securityOptArgs = () => Object.freeze([
    '--security-opt', 'no-new-privileges:true',
    '--security-opt', `seccomp=${process.env.PORTAL_DOCKER_CLI_CONTRACT_SECCOMP}`,
    '--security-opt', 'apparmor=bridgesllm-project-runtime-v1',
  ]);
  return {
    ...jest.requireActual('./projectRuntimeConfinement'),
    projectRuntimeSecurityOptArgs: securityOptArgs,
    codexProjectRuntimeSecurityOptArgs: securityOptArgs,
  };
});
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { ProjectSandboxExecutionContext } from '../agents/AgentProvider.interface';
import {
  CODEX_PROJECT_RUNTIME,
  CODEX_PROJECT_RUNTIME_POLICY_VERSION,
  buildCodexProjectDockerExecCommand,
  buildCodexProjectRuntimePlan,
  codexProjectEgressCommandExecutor,
  type CodexProjectEgressRuntimeHandle,
} from '../agents/providers/native/projectSandbox/CodexProjectEgressRuntime';
import {
  buildNativeCliProjectRuntimePlan,
  nativeCliProjectEgressCommandExecutor,
  type NativeCliProjectRuntimeProfile,
} from '../agents/providers/native/projectSandbox/NativeCliProjectEgressRuntime';
import { buildExactNativeCliProjectInvocation } from '../agents/providers/native/projectSandbox/NativeCliProjectRunControl';
import { __openClawProjectSandboxTest } from './openclawProjectSandbox';
import { buildProjectEgressPlaneSpec, type ProjectEgressPlaneSpec } from './projectEgressPlane';
import { PROJECT_EGRESS_POLICY_VERSION } from './projectEgressPolicy';

const enabled = process.env.PORTAL_DOCKER_CLI_CONTRACT === '1';
const contract = enabled ? test : test.skip;
const OUT = process.env.PORTAL_DOCKER_CLI_CONTRACT_OUT || '';
const SOCKET = '/run/docker.sock';
const RUNTIME_IMAGE = `sha256:${'a'.repeat(64)}`;
const PROXY_IMAGE = `sha256:${'b'.repeat(64)}`;
const RUN = crypto.randomBytes(6).toString('hex');
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;
const CLAUDE_PROFILE: NativeCliProjectRuntimeProfile = Object.freeze({
  provider: 'CLAUDE_CODE',
  displayName: 'Claude Code',
  runtime: 'claude-code-project-adapter',
  containerNamePrefix: 'p4cc',
  runtimePolicyVersion: 'portal-claude-code-project-sandbox-v1',
  cliPath: '/usr/local/bin/claude',
  allowLoopback: false,
  environment: Object.freeze({ DISABLE_TELEMETRY: '1' }),
});

interface CliSnapshot {
  processes: number;
  argvCarriesSecret: boolean;
  environCarriesEverySecret: boolean;
  environNoProxy: string | null;
  environLowerNoProxy: string | null;
}

interface EngineRecord {
  kind: 'create' | 'exec';
  env: string[];
  cli: CliSnapshot;
}

let directory = '';
let server: http.Server | null = null;
let engineMode: 'accept' | 'refuse-echo' = 'accept';
let expectedSecrets: Record<string, string> = {};
let cliMarker = '';
const records: EngineRecord[] = [];
const requests: string[] = [];
const usedSecrets: string[] = [];
const report: Record<string, unknown> = { run: RUN, cases: {} as Record<string, unknown> };
const savedEnvironment = new Map<string, string | undefined>();
const ENVIRONMENT_KEYS = ['DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'PORTAL_DOCKER_CLI_CONTRACT_SECCOMP',
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];

// Unmistakably synthetic and valid for the egress token rule.
function canaryToken(): string {
  return `SYNTHETICCANARY_${crypto.randomBytes(32).toString('base64url')}`;
}

function expectSecrets(secrets: Record<string, string>, unexpected: readonly string[] = []): void {
  expectedSecrets = secrets;
  for (const value of [...Object.values(secrets), ...unexpected]) {
    if (!value) continue;
    usedSecrets.push(value);
    try {
      const password = new URL(value).password;
      if (password) usedSecrets.push(password, decodeURIComponent(password));
    } catch {
      // Not a URL: the whole value is the secret.
    }
  }
}

function secretFragments(): string[] {
  return Object.values(expectedSecrets).flatMap((value) => {
    try {
      const password = new URL(value).password;
      return password ? [value, password, decodeURIComponent(password)] : [value];
    } catch {
      return [value];
    }
  });
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
  const fragments = secretFragments();
  const environValue = (environ: string[], key: string) => {
    const found = environ.find((item) => item.startsWith(`${key}=`));
    return found === undefined ? null : found.slice(key.length + 1);
  };
  return {
    processes: matches.length,
    argvCarriesSecret: matches.some(({ argv }) => argv.some((item) => fragments.some((value) => item.includes(value)))),
    environCarriesEverySecret: matches.length > 0 && matches.every(({ environ }) => (
      Object.entries(expectedSecrets).every(([key, value]) => environ.includes(`${key}=${value}`)))),
    environNoProxy: matches.length === 1 ? environValue(matches[0].environ, 'NO_PROXY') : null,
    environLowerNoProxy: matches.length === 1 ? environValue(matches[0].environ, 'no_proxy') : null,
  };
}

function normalizedPath(pathname: string): string {
  return pathname.replace(/\/[a-f0-9]{64}\//, '/<id>/');
}

function startEngine(): Promise<void> {
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url || '/', 'http://engine');
      requests.push(`${request.method} ${normalizedPath(url.pathname)}`);
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json', 'Api-Version': '1.56' });
        response.end(JSON.stringify(body));
      };
      if (/^\/(v[0-9.]+\/)?_ping$/.test(url.pathname)) {
        response.writeHead(200, { 'Api-Version': '1.56', Ostype: 'linux', 'Content-Type': 'text/plain' });
        response.end(request.method === 'HEAD' ? undefined : 'OK');
        return;
      }
      const body = () => JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (request.method === 'POST' && /^\/v[0-9.]+\/containers\/create$/.test(url.pathname)) {
        const parsed = body();
        const env = Array.isArray(parsed.Env) ? parsed.Env.map(String) : [];
        records.push({ kind: 'create', env, cli: cliSnapshot() });
        if (engineMode === 'refuse-echo') {
          // A hostile daemon echoing the credential entries it received.
          const echoed = env.filter((entry: string) => /^(HTTPS?_PROXY|https?_proxy)=./.test(entry)).slice(0, 1);
          json(500, { message: `synthetic refusal of ${echoed.join(' ')}` });
          return;
        }
        json(201, { Id: crypto.randomBytes(32).toString('hex'), Warnings: [] });
        return;
      }
      if (request.method === 'GET' && /^\/v[0-9.]+\/containers\/[a-f0-9]{64}\/json$/.test(url.pathname)) {
        json(200, { Id: url.pathname.split('/')[3], Name: '/contract', State: { Running: true, Status: 'running' } });
        return;
      }
      if (request.method === 'POST' && /^\/v[0-9.]+\/containers\/[a-f0-9]{64}\/exec$/.test(url.pathname)) {
        const parsed = body();
        records.push({ kind: 'exec', env: Array.isArray(parsed.Env) ? parsed.Env.map(String) : [], cli: cliSnapshot() });
        json(201, { Id: crypto.randomBytes(32).toString('hex') });
        return;
      }
      if (request.method === 'GET' && /^\/v[0-9.]+\/exec\/[a-f0-9]{64}\/json$/.test(url.pathname)) {
        json(200, { ExitCode: 0, Running: false, Pid: 0, ProcessConfig: {} });
        return;
      }
      json(404, { message: 'page not found' });
    });
  });
  // exec start is hijacked: answer 101 and send one multiplexed stdout frame.
  server.on('upgrade', (request, socket) => {
    requests.push(`${request.method} ${normalizedPath(new URL(request.url || '/', 'http://engine').pathname)} (upgrade)`);
    socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\n'
      + 'Connection: Upgrade\r\nUpgrade: tcp\r\nApi-Version: 1.56\r\n\r\n');
    const payload = Buffer.from('contract-exec-ok\n');
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(payload.length, 4);
    socket.end(Buffer.concat([header, payload]));
  });
  return new Promise((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(SOCKET, () => resolve());
  });
}

// The executors talk to unix:///var/run/docker.sock; only a private, empty
// /run in an isolated network namespace may hold the fake Engine there.
function assertPrivateRunAndNetwork(): void {
  const interfaces = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)
    .map((line) => line.split(':')[0].trim()).filter(Boolean);
  if (fs.readdirSync('/run').length !== 0 || interfaces.join(',') !== 'lo') {
    throw new Error('Refusing to bind /run/docker.sock outside a private /run and an isolated network');
  }
}

function contextPolicyFingerprint(seed: Record<string, string>, provider: string, runtime: string): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: seed.runtimePolicyVersion,
    egressPolicyVersion: seed.egressPolicyVersion,
    provider,
    runtime,
    runtimeImageDigest: seed.runtimeImageDigest,
    actorUserId: seed.userId,
    workspaceOwnerId: seed.workspaceOwnerId,
    projectId: seed.projectId,
    projectName: seed.projectName,
    canonicalRoot: seed.canonicalRoot,
    rootDevice: seed.rootDevice,
    rootInode: seed.rootInode,
    rootBirthtimeNs: seed.rootBirthtimeNs,
  })).digest('hex');
}

function projectContext(provider: string, runtime: string, runtimePolicyVersion: string): ProjectSandboxExecutionContext {
  const projectRoot = fs.mkdtempSync(path.join(directory, 'project-'));
  const stat = fs.lstatSync(projectRoot, { bigint: true });
  const seed = {
    scope: 'PROJECT_SANDBOX',
    source: 'PORTAL_SERVER',
    userId: `contract-actor-${RUN}`,
    projectId: `contract-project-${RUN}`,
    workspaceOwnerId: `contract-owner-${RUN}`,
    projectName: 'contract',
    canonicalRoot: fs.realpathSync(projectRoot),
    rootDevice: stat.dev.toString(),
    rootInode: stat.ino.toString(),
    rootBirthtimeNs: stat.birthtimeNs.toString(),
    runtimePolicyVersion,
    egressPolicyVersion: PROJECT_EGRESS_POLICY_VERSION,
    runtimeImageDigest: RUNTIME_IMAGE,
  };
  return Object.freeze({ ...seed, policyFingerprint: contextPolicyFingerprint(seed, provider, runtime) }) as ProjectSandboxExecutionContext;
}

function egressSpec(context: ProjectSandboxExecutionContext, provider: 'CODEX' | 'CLAUDE_CODE'): ProjectEgressPlaneSpec {
  return buildProjectEgressPlaneSpec({
    identity: { actorId: context.userId, projectId: context.projectId, provider },
    proxyImage: PROXY_IMAGE,
    token: canaryToken(),
  });
}

function proxyEnvironment(token: string, address = '172.31.10.2'): Record<string, string> {
  const url = `http://portal:${encodeURIComponent(token)}@${address}:3128`;
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: '', no_proxy: '' };
}

function credentialsOf(environment: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(PROXY_KEYS.map((key) => [key, environment[key]]));
}

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function entriesOf(environment: Readonly<Record<string, string>>): string[] {
  return Object.entries(environment).map(([key, value]) => `${key}=${value}`);
}

function lastRecord(kind: EngineRecord['kind'], before: number): EngineRecord | null {
  const found = records.slice(before).filter((entry) => entry.kind === kind);
  return found.length === 1 ? found[0] : null;
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

function codexRuntime(context: ProjectSandboxExecutionContext, spec: ProjectEgressPlaneSpec): CodexProjectEgressRuntimeHandle {
  return Object.freeze({
    containerId: crypto.randomBytes(32).toString('hex'),
    containerName: `p4cx-contract-${RUN}`,
    runtimeFingerprint: 'c'.repeat(64),
    egressPolicyFingerprint: spec.policyFingerprint,
    proxyAddress: '172.31.10.2',
    proxyEnvironment: Object.freeze(proxyEnvironment(spec.token)),
    startedAt: '2026-10-07T12:00:00Z',
  });
}

beforeAll(async () => {
  if (!enabled) return;
  assertPrivateRunAndNetwork();
  for (const key of ENVIRONMENT_KEYS) savedEnvironment.set(key, process.env[key]);
  for (const key of ENVIRONMENT_KEYS) delete process.env[key];
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-cli-runtimes-contract-'));
  fs.chmodSync(directory, 0o700);
  const seccomp = path.join(directory, 'seccomp.json');
  fs.writeFileSync(seccomp, JSON.stringify({ defaultAction: 'SCMP_ACT_ALLOW' }));
  process.env.PORTAL_DOCKER_CLI_CONTRACT_SECCOMP = seccomp;
  await startEngine();
  report.dockerClient = await new Promise<string>((resolve) => {
    const child = spawn('docker', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.on('close', () => resolve(Buffer.concat(out).toString('utf8').trim()));
  });
});

afterAll(async () => {
  if (!enabled) return;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  report.engineRequests = [...new Set(requests)].sort();
  if (OUT) {
    const text = `${JSON.stringify(report, null, 2)}\n`;
    // Metadata only: refuse to write a report that carries any credential used here.
    if (usedSecrets.some((secret) => text.includes(secret)) || text.includes('SYNTHETICCANARY')) {
      throw new Error('Contract report would carry a credential');
    }
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'docker-cli-runtimes-contract-report.json'), text, { mode: 0o644 });
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('docker CLI credential custody for Project runtimes (real CLI, fake Engine)', () => {
  contract('OpenClaw sandbox create: credentials named on argv, delivered from the CLI environment', async () => {
    const token = canaryToken();
    const env = { LANG: 'C.UTF-8', HOME: '/home/openclaw', TMPDIR: '/tmp', ...proxyEnvironment(token) };
    const plan = {
      containerName: `p4oc-contract-${RUN}`,
      runtimeScopeKey: `agent:contract:${RUN}`,
      actorUserId: `contract-actor-${RUN}`,
      projectIdentityId: `contract-project-${RUN}`,
      agentId: 'contract-agent',
      mountFormatVersion: 4,
      configHash: 'e'.repeat(64),
      runtimeFingerprint: 'f'.repeat(64),
      networkMode: 'none',
      expectedBinds: [`${fs.mkdtempSync(path.join(directory, 'openclaw-'))}:/workspace/project:rw`],
      desiredDocker: {
        image: RUNTIME_IMAGE, tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=67108864'], user: '1000:1000', env,
        capDrop: ['ALL'], pidsLimit: 256, memory: 1073741824, memorySwap: 1073741824, cpus: 2,
        ulimits: { nofile: { soft: 1024, hard: 1024 } },
      },
    } as any;
    const command = __openClawProjectSandboxTest.buildContainerCreateCommand(plan, Date.now());
    expectSecrets(command.secretEnvironment, [token]);
    cliMarker = plan.containerName;
    const before = records.length;
    const result = await __openClawProjectSandboxTest.commandExecutor.run('docker', command.args, {
      secretEnvironment: command.secretEnvironment,
    });
    const created = lastRecord('create', before)!;
    const exact = sameEntries(created.env, [...entriesOf(env), 'OPENCLAW_CLI=1']);
    expect(/^[a-f0-9]{64}$/.test(result.stdout.trim())).toBe(true);
    expect(exact).toBe(true);
    expect(command.args.some((value) => value.includes(token))).toBe(false);
    expect(created.cli.processes).toBe(1);
    expect(created.cli.argvCarriesSecret).toBe(false);
    expect(created.cli.environCarriesEverySecret).toBe(true);
    expect(created.cli.environNoProxy).toBe('*');
    expect(created.env).toEqual(expect.arrayContaining(['NO_PROXY=', 'no_proxy=']));
    record('openclawCreate', {
      engineEnvNames: created.env.map((entry) => entry.split('=')[0]).sort(),
      engineEnvExactEntries: exact, cli: created.cli,
    });
  });

  contract('Codex runtime create: credentials named on argv, delivered from the CLI environment', async () => {
    const context = projectContext('CODEX', CODEX_PROJECT_RUNTIME, CODEX_PROJECT_RUNTIME_POLICY_VERSION);
    const spec = egressSpec(context, 'CODEX');
    const plan = buildCodexProjectRuntimePlan({
      context, spec, proxyAddress: '172.31.10.2', internalNetworkId: 'd'.repeat(64),
    });
    expectSecrets(plan.createSecretEnvironment, [spec.token]);
    cliMarker = plan.containerName;
    const before = records.length;
    await codexProjectEgressCommandExecutor.run('docker', plan.createArgs, {
      secretEnvironment: plan.createSecretEnvironment,
    });
    const created = lastRecord('create', before)!;
    const exact = sameEntries(created.env, entriesOf(plan.expectedEnvironment));
    expect(exact).toBe(true);
    expect(plan.createSecretEnvironment).toEqual(credentialsOf(plan.expectedEnvironment));
    expect(plan.createArgs.some((value) => value.includes(spec.token))).toBe(false);
    expect(created.cli.processes).toBe(1);
    expect(created.cli.argvCarriesSecret).toBe(false);
    expect(created.cli.environCarriesEverySecret).toBe(true);
    expect(created.cli.environNoProxy).toBe('*');
    expect(created.cli.environLowerNoProxy).toBe('*');
    record('codexCreate', {
      engineEnvNames: created.env.map((entry) => entry.split('=')[0]).sort(),
      engineEnvExactEntries: exact, cli: created.cli,
    });
  });

  contract('native CLI runtime create: credentials named on argv, delivered from the CLI environment', async () => {
    const context = projectContext('CLAUDE_CODE', CLAUDE_PROFILE.runtime, CLAUDE_PROFILE.runtimePolicyVersion);
    const spec = egressSpec(context, 'CLAUDE_CODE');
    const plan = buildNativeCliProjectRuntimePlan({
      context, profile: CLAUDE_PROFILE, spec, proxyAddress: '172.31.20.2', internalNetworkId: 'd'.repeat(64),
    });
    expectSecrets(plan.createSecretEnvironment, [spec.token]);
    cliMarker = plan.containerName;
    const before = records.length;
    await nativeCliProjectEgressCommandExecutor.run('docker', plan.createArgs, {
      secretEnvironment: plan.createSecretEnvironment,
    });
    const created = lastRecord('create', before)!;
    const exact = sameEntries(created.env, entriesOf(plan.expectedEnvironment));
    expect(exact).toBe(true);
    expect(plan.createArgs.some((value) => value.includes(spec.token))).toBe(false);
    expect(created.cli.processes).toBe(1);
    expect(created.cli.argvCarriesSecret).toBe(false);
    expect(created.cli.environCarriesEverySecret).toBe(true);
    expect(created.cli.environNoProxy).toBe('*');
    record('nativeCliCreate', {
      engineEnvNames: created.env.map((entry) => entry.split('=')[0]).sort(),
      engineEnvExactEntries: exact, cli: created.cli,
    });
  });

  contract('Codex exec: credentials named on argv, delivered to the exec environment', async () => {
    const context = projectContext('CODEX', CODEX_PROJECT_RUNTIME, CODEX_PROJECT_RUNTIME_POLICY_VERSION);
    const spec = egressSpec(context, 'CODEX');
    const runtime = codexRuntime(context, spec);
    const command = buildCodexProjectDockerExecCommand({ runtime, command: '/usr/bin/codex', args: ['--version'] });
    expectSecrets(command.secretEnvironment, [spec.token]);
    cliMarker = runtime.containerId;
    const before = records.length;
    const result = await codexProjectEgressCommandExecutor.run('docker', command.args, {
      secretEnvironment: command.secretEnvironment,
    });
    const exec = lastRecord('exec', before)!;
    const exact = sameEntries(exec.env, entriesOf(runtime.proxyEnvironment));
    expect(result.stdout).toBe('contract-exec-ok\n');
    expect(exact).toBe(true);
    expect(command.args.some((value) => value.includes(spec.token))).toBe(false);
    expect(exec.cli.processes).toBe(1);
    expect(exec.cli.argvCarriesSecret).toBe(false);
    expect(exec.cli.environCarriesEverySecret).toBe(true);
    expect(exec.cli.environNoProxy).toBe('*');
    record('codexExec', {
      engineEnvNames: exec.env.map((entry) => entry.split('=')[0]).sort(),
      engineEnvExactEntries: exact, cli: exec.cli, stdoutDelivered: result.stdout === 'contract-exec-ok\n',
    });
  });

  contract('Codex turn invocation: spawned like the provider, credentials only in the CLI environment', async () => {
    const context = projectContext('CODEX', CODEX_PROJECT_RUNTIME, CODEX_PROJECT_RUNTIME_POLICY_VERSION);
    const spec = egressSpec(context, 'CODEX');
    const runtime = codexRuntime(context, spec);
    const invocation = buildExactNativeCliProjectInvocation({
      runtime,
      containerUser: '1000:1000',
      containerRoot: '/workspace/project',
      markerNamespace: 'codex',
      command: '/usr/bin/codex',
      args: ['exec', '--json', '--', 'contract prompt'],
      runId: `contract-turn-${RUN}`,
      executor: codexProjectEgressCommandExecutor,
      hostEnvironment: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/nonexistent',
        DOCKER_CONFIG: '/nonexistent',
        DOCKER_HOST: 'unix:///var/run/docker.sock',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      },
      containerEnvironment: runtime.proxyEnvironment,
    });
    expectSecrets(credentialsOf(runtime.proxyEnvironment), [spec.token]);
    cliMarker = runtime.containerId;
    const before = records.length;
    // NativeCliAdapterProvider spawns the invocation with its own options.env.
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(invocation.command, invocation.args, {
        ...(invocation.options || {}), stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('close', (code) => resolve(code));
    });
    const exec = lastRecord('exec', before)!;
    const exact = sameEntries(exec.env, entriesOf(runtime.proxyEnvironment));
    expect(exitCode).toBe(0);
    expect(exact).toBe(true);
    expect(invocation.args.some((value) => value.includes(spec.token))).toBe(false);
    expect(exec.cli.processes).toBe(1);
    expect(exec.cli.argvCarriesSecret).toBe(false);
    expect(exec.cli.environCarriesEverySecret).toBe(true);
    expect(exec.cli.environNoProxy).toBe('*');
    record('codexTurnInvocation', {
      engineEnvNames: exec.env.map((entry) => entry.split('=')[0]).sort(),
      engineEnvExactEntries: exact, cli: exec.cli,
    });
  });

  contract('a named credential without its value never spawns the CLI or reaches the Engine', async () => {
    const context = projectContext('CODEX', CODEX_PROJECT_RUNTIME, CODEX_PROJECT_RUNTIME_POLICY_VERSION);
    const spec = egressSpec(context, 'CODEX');
    const runtime = codexRuntime(context, spec);
    const command = buildCodexProjectDockerExecCommand({ runtime, command: '/usr/bin/codex', args: ['--version'] });
    expectSecrets({}, [spec.token]);
    const before = requests.length;
    const failures = await Promise.all([
      failureOf(codexProjectEgressCommandExecutor.run('docker', command.args)),
      failureOf(nativeCliProjectEgressCommandExecutor.run('docker', command.args)),
      failureOf(__openClawProjectSandboxTest.commandExecutor.run('docker', command.args)),
    ]);
    expect(failures.map((failure) => failure.message))
      .toEqual(Array(3).fill('Project egress protected environment is incomplete'));
    expect(requests.length).toBe(before);
    record('missingValueRefusedBeforeSpawn', {
      executors: 3, refused: failures.length, engineRequestsDuringCase: requests.length - before,
    });
  });

  contract('a hostile Engine echo of a credential is redacted from OpenClaw failure text', async () => {
    engineMode = 'refuse-echo';
    try {
      const token = canaryToken();
      const env = { LANG: 'C.UTF-8', ...proxyEnvironment(token) };
      const plan = {
        containerName: `p4oc-contract-echo-${RUN}`,
        runtimeScopeKey: `agent:contract:${RUN}`,
        actorUserId: `contract-actor-${RUN}`,
        projectIdentityId: `contract-project-${RUN}`,
        agentId: 'contract-agent',
        mountFormatVersion: 4,
        configHash: 'e'.repeat(64),
        runtimeFingerprint: 'f'.repeat(64),
        networkMode: 'none',
        expectedBinds: [],
        desiredDocker: {
          image: RUNTIME_IMAGE, tmpfs: [], user: '1000:1000', env, capDrop: ['ALL'],
          pidsLimit: 256, memory: 1073741824, memorySwap: 1073741824, cpus: 2, ulimits: {},
        },
      } as any;
      const command = __openClawProjectSandboxTest.buildContainerCreateCommand(plan, Date.now());
      expectSecrets(command.secretEnvironment, [token]);
      cliMarker = plan.containerName;
      const before = records.length;
      const failure = await failureOf(__openClawProjectSandboxTest.commandExecutor.run('docker', command.args, {
        secretEnvironment: command.secretEnvironment,
      }));
      const echoed = lastRecord('create', before)!.env.some((entry) => entry.includes(token));
      expect(echoed).toBe(true);
      expect(failure.message).toContain('synthetic refusal');
      expect(failure.message).toContain('[redacted]');
      expect(failure.message.includes(token)).toBe(false);
      record('openclawHostileEcho', {
        engineReceivedCredential: echoed, errorRedacted: !failure.message.includes(token),
      });
    } finally {
      engineMode = 'accept';
    }
  });
});
