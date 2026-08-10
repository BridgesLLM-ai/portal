/**
 * Project lifecycle sandbox
 *
 * Project-controlled install/build/start commands must never execute in the
 * Portal backend process. This module is the single Docker boundary for those
 * commands. Each job receives one writable workspace bind, a read-only root
 * filesystem, no Linux capabilities, no Docker socket, and an allowlisted
 * environment.
 */

import { ChildProcess, execFile, execFileSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../config/env';
import {
  projectEgressCommandExecutor,
  type ProjectEgressCommandExecutor,
} from './projectEgressPlane';
import {
  preparePortalProjectWorkloadContainer,
  removePortalProjectWorkloadByIdentity,
  removePreparedPortalProjectWorkloadContainer,
  resolvePinnedProjectRuntimeImage,
  startPreparedPortalProjectWorkloadContainer,
  type PortalProjectWorkloadPlan,
} from './projectWorkloadRuntime';
import {
  PROJECT_RUNTIME_GID,
  PROJECT_RUNTIME_UID,
} from './projectRuntimeIdentity';

export {
  PROJECT_RUNTIME_GID,
  PROJECT_RUNTIME_UID,
} from './projectRuntimeIdentity';

const DEFAULT_PROJECT_RUNTIME_IMAGE = 'bridgesllm-project-runtime:bookworm-node22';

function configuredProjectRuntimeImage(): string {
  const configured = String(config.portalProjectRuntimeImageId || '').trim();
  if (!configured) return DEFAULT_PROJECT_RUNTIME_IMAGE;
  if (!/^sha256:[a-f0-9]{64}$/.test(configured)) {
    throw new Error(
      'PORTAL_PROJECT_RUNTIME_IMAGE_ID must be an immutable Docker image ID.',
    );
  }
  return configured;
}

export const PROJECT_RUNTIME_IMAGE = configuredProjectRuntimeImage();

export class ProjectRuntimeImageUnavailableError extends Error {
  readonly code = 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE';
  readonly retryable = true;

  constructor() {
    super('The Project runtime image is unavailable. Re-run the Portal installer or update, then try again.');
    this.name = 'ProjectRuntimeImageUnavailableError';
  }
}

export async function assertProjectRuntimeImageAvailable(
  executor: ProjectEgressCommandExecutor = projectEgressCommandExecutor,
): Promise<string> {
  return resolvePinnedProjectRuntimeImage(PROJECT_RUNTIME_IMAGE, executor).catch(() => {
    // Keep the configured image identity out of all HTTP-facing errors.
    throw new ProjectRuntimeImageUnavailableError();
  });
}

const DOCKER_BIN = '/usr/bin/docker';
const PROJECT_MOUNT = '/workspace/project';
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const PROJECT_CHAT_WORKSPACE_PREPARATION_TIMEOUT_MS = 60_000;
const PROJECT_CHAT_WORKSPACE_PREPARATION_MAX_OUTPUT_BYTES = 64 * 1024;
const ALLOWED_COMMANDS = new Set([
  'npm',
  'node',
  'python3',
  'g++',
  `${PROJECT_MOUNT}/.venv/bin/pip`,
]);

export type ProjectLifecycleMode = 'job' | 'app';

export interface ProjectLifecycleCommand {
  actorId: string;
  projectId: string;
  workspace: string;
  command: string;
  args: string[];
  timeoutMs?: number;
  mode?: ProjectLifecycleMode;
  nameHint?: string;
  port?: number;
  production?: boolean;
  /** Public package/build traffic is brokered through the Portal proxy. */
  network?: boolean;
  /** Stable only for long-lived apps; one-shot jobs generate a unique value. */
  workloadId?: string;
}

export interface ProjectLifecycleProcess {
  process: ChildProcess;
  containerName: string;
  cancel: () => void;
  cleanup: Promise<void>;
  plan: PortalProjectWorkloadPlan;
}

export interface ProjectLifecycleWorkspace {
  path: string;
  cleanup: () => void;
}

export interface ProjectAppRuntimeIdentity {
  actorId: string;
  projectId: string;
  workloadId: string;
}

function dockerCliEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
}

function assertSafeWorkspace(workspace: string): string {
  const resolved = path.resolve(workspace);
  const filesystemRoot = path.parse(resolved).root;
  if (!path.isAbsolute(workspace) || resolved === filesystemRoot || resolved.length < filesystemRoot.length + 4) {
    throw new Error('Refusing unsafe project lifecycle workspace');
  }
  const entry = fs.lstatSync(resolved);
  if (entry.isSymbolicLink()) throw new Error('Project lifecycle workspace cannot be a symbolic link');
  const canonical = fs.realpathSync(resolved);
  if (canonical !== resolved) throw new Error('Project lifecycle workspace must use its canonical path');
  const stat = fs.statSync(canonical);
  if (!stat.isDirectory()) throw new Error('Project lifecycle workspace must be a directory');
  return canonical;
}

function assertAllowedCommand(command: string): void {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(`Project lifecycle command is not allowed: ${command}`);
  }
}

function projectContainerName(prefix: string, hint: string): string {
  const digest = crypto.createHash('sha256').update(hint).digest('hex').slice(0, 20);
  return `${prefix}-${digest}`;
}

export function projectAppContainerName(identity: ProjectAppRuntimeIdentity): string {
  return projectContainerName(
    'bridgesllm-project-app',
    `${identity.actorId}\0${identity.projectId}\0app\0${identity.workloadId}`,
  );
}

/**
 * The disposable deployment/job workspace is owned by the shared project-
 * sandbox identity.
 * --no-dereference prevents a project-created symlink from turning ownership
 * preparation into a host path traversal.
 */
export function prepareProjectLifecycleWorkspace(workspace: string): string {
  const resolved = assertSafeWorkspace(workspace);
  execFileSync('/usr/bin/chown', [
    '-R',
    '--no-dereference',
    `${PROJECT_RUNTIME_UID}:${PROJECT_RUNTIME_GID}`,
    resolved,
  ], {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: dockerCliEnvironment(),
  });
  return resolved;
}

export class ProjectLifecycleWorkspacePreparationError extends Error {
  readonly code = 'PROJECT_WORKSPACE_PREPARATION_FAILED';
  readonly retryable = true;
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'ProjectLifecycleWorkspacePreparationError';
    this.cause = cause;
  }
}

/**
 * Project Chat uses the same exact canonical workspace and ownership contract
 * as lifecycle jobs, but chown must run outside the Express event loop. Large
 * repositories can legitimately take time to traverse; awaiting execFile
 * keeps other requests responsive while retaining a hard process deadline.
 */
export async function prepareProjectChatLifecycleWorkspace(workspace: string): Promise<string> {
  const resolved = assertSafeWorkspace(workspace);
  await new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/chown', [
      '-R',
      '--no-dereference',
      `${PROJECT_RUNTIME_UID}:${PROJECT_RUNTIME_GID}`,
      resolved,
    ], {
      encoding: 'utf8',
      timeout: PROJECT_CHAT_WORKSPACE_PREPARATION_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: PROJECT_CHAT_WORKSPACE_PREPARATION_MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: dockerCliEnvironment(),
    }, (error) => {
      if (!error) {
        resolve();
        return;
      }
      const timedOut = Boolean((error as any).killed)
        || (error as any).code === 'ETIMEDOUT';
      reject(new ProjectLifecycleWorkspacePreparationError(
        timedOut
          ? 'Project workspace ownership preparation exceeded 60 seconds.'
          : 'Project workspace ownership preparation failed.',
        error,
      ));
    });
  });
  return resolved;
}

export function buildProjectContainerArgs(
  options: ProjectLifecycleCommand,
  containerName: string,
  detached = false,
): string[] {
  assertAllowedCommand(options.command);
  const workspace = assertSafeWorkspace(options.workspace);
  const mode = options.mode || 'job';
  const args = [
    'run',
    '--name', containerName,
    '--label', 'com.bridgesllm.project-runtime=true',
    '--label', `com.bridgesllm.project-runtime.mode=${mode}`,
    '--init',
    '--user', `${PROJECT_RUNTIME_UID}:${PROJECT_RUNTIME_GID}`,
    '--workdir', PROJECT_MOUNT,
    '--mount', `type=bind,src=${workspace},dst=${PROJECT_MOUNT}`,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '256',
    '--memory', mode === 'app' ? '1536m' : '2048m',
    '--cpus', mode === 'app' ? '1.5' : '2',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m',
    '--network', 'none',
    '--env', 'HOME=/tmp/project-home',
    '--env', 'CI=true',
    '--env', 'NPM_CONFIG_CACHE=/tmp/npm-cache',
    '--env', 'NPM_CONFIG_UPDATE_NOTIFIER=false',
  ];

  if (options.production) {
    args.push('--env', 'NODE_ENV=production');
  }
  if (options.port !== undefined) {
    if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
      throw new Error('Invalid project app port');
    }
    args.push(
      '--publish', `127.0.0.1:${options.port}:${options.port}`,
      '--env', `PORT=${options.port}`,
      '--env', 'HOST=0.0.0.0',
    );
  }
  if (detached) {
    args.push('--detach', '--restart', 'no');
  }

  args.push(PROJECT_RUNTIME_IMAGE, options.command, ...options.args);
  return args;
}

async function prepareLifecyclePlan(
  options: ProjectLifecycleCommand,
  mode: ProjectLifecycleMode,
  executor: ProjectEgressCommandExecutor = projectEgressCommandExecutor,
): Promise<PortalProjectWorkloadPlan> {
  assertAllowedCommand(options.command);
  const workspace = prepareProjectLifecycleWorkspace(options.workspace);
  const workloadId = options.workloadId || crypto.randomUUID();
  const containerName = projectContainerName(
    mode === 'app' ? 'bridgesllm-project-app' : 'bridgesllm-project-job',
    `${options.actorId}\0${options.projectId}\0${mode}\0${workloadId}`,
  );
  const image = await assertProjectRuntimeImageAvailable(executor);
  const environment: Record<string, string> = {
    HOME: '/tmp/project-home',
    CI: 'true',
    NPM_CONFIG_CACHE: '/tmp/npm-cache',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
  if (options.production) environment.NODE_ENV = 'production';
  if (options.port !== undefined) {
    if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
      throw new Error('Invalid project app port');
    }
    environment.PORT = String(options.port);
    environment.HOST = '0.0.0.0';
  }
  return preparePortalProjectWorkloadContainer({
    identity: {
      actorId: options.actorId,
      projectId: options.projectId,
      consumerKind: mode === 'app' ? 'PORTAL_APP' : 'PORTAL_LIFECYCLE',
      workloadId,
    },
    containerName,
    workspace,
    image,
    command: options.command,
    args: options.args,
    environment,
    networked: options.network === true || mode === 'app',
    pidsLimit: 256,
    memoryBytes: mode === 'app' ? 1536 * 1024 * 1024 : 2048 * 1024 * 1024,
    nanoCpus: mode === 'app' ? 1_500_000_000 : 2_000_000_000,
    tmpfsSize: '512m',
    applicationPort: options.port,
  }, { allowExisting: mode === 'app', executor });
}

export async function spawnProjectLifecycleCommand(options: ProjectLifecycleCommand): Promise<ProjectLifecycleProcess> {
  const plan = await prepareLifecyclePlan({ ...options, mode: 'job' }, 'job');
  const child = spawn(DOCKER_BIN, ['container', 'start', '--attach', plan.containerName], {
    env: dockerCliEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    if (!cleanupPromise) cleanupPromise = removePreparedPortalProjectWorkloadContainer(plan);
    return cleanupPromise;
  };
  const cleanupDone = new Promise<void>((resolve, reject) => {
    const finish = () => { void cleanup().then(resolve, reject); };
    child.once('close', finish);
    child.once('error', finish);
  });

  return {
    process: child,
    containerName: plan.containerName,
    cancel: () => {
      void cleanup();
      if (!child.killed) child.kill('SIGTERM');
    },
    cleanup: cleanupDone,
    plan,
  };
}

export async function runProjectLifecycleCommand(options: ProjectLifecycleCommand): Promise<string> {
  const job = await spawnProjectLifecycleCommand(options);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  const collect = (target: Buffer[], chunk: Buffer | string) => {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_OUTPUT_BYTES) job.cancel();
    else target.push(value);
  };
  job.process.stdout?.on('data', (chunk) => collect(stdout, chunk));
  job.process.stderr?.on('data', (chunk) => collect(stderr, chunk));
  const timeout = setTimeout(() => job.cancel(), options.timeoutMs || 120_000);
  timeout.unref?.();
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    job.process.once('error', reject);
    job.process.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  await job.cleanup;
  const output = Buffer.concat(stdout).toString('utf8');
  const errorOutput = Buffer.concat(stderr).toString('utf8');
  if (bytes > MAX_OUTPUT_BYTES) throw Object.assign(new Error('Project lifecycle command output limit exceeded'), { stdout: output, stderr: errorOutput });
  if (exit.code !== 0) {
    throw Object.assign(new Error(errorOutput.trim() || `Project lifecycle command exited with code ${exit.code ?? exit.signal}`), {
      stdout: output,
      stderr: errorOutput,
      code: exit.code ?? exit.signal,
    });
  }
  return output;
}

export async function startProjectAppContainer(options: ProjectLifecycleCommand): Promise<{
  containerName: string;
  containerId: string;
  networkAddress: string;
  plan: PortalProjectWorkloadPlan;
}> {
  if (!options.workloadId) throw new Error('Project app workload identity is required');
  const plan = await prepareLifecyclePlan({ ...options, mode: 'app', network: true }, 'app');
  const started = await startPreparedPortalProjectWorkloadContainer(plan);
  if (!started.networkAddress) {
    await removePreparedPortalProjectWorkloadContainer(plan).catch(() => undefined);
    throw new Error('Project app runtime did not obtain an attested internal address');
  }
  return {
    containerName: plan.containerName,
    containerId: started.containerId,
    networkAddress: started.networkAddress,
    plan,
  };
}

export async function stopProjectAppContainer(
  runtime: PortalProjectWorkloadPlan | ProjectAppRuntimeIdentity | null,
): Promise<void> {
  if (!runtime) return;
  if ('runtimeFingerprint' in runtime) {
    await removePreparedPortalProjectWorkloadContainer(runtime);
    return;
  }
  await removePortalProjectWorkloadByIdentity({
    ...runtime,
    consumerKind: 'PORTAL_APP',
  }, projectAppContainerName(runtime));
}

/**
 * Bridge a container's own address to an app that only bound loopback.
 *
 * Before 4.0 a fullstack app ran as a host process and the Portal proxied to
 * 127.0.0.1, so `listen(port, '127.0.0.1')` was correct and common. In the
 * isolated runtime the Portal reaches the app on the container's address, and
 * a loopback-only listener is invisible there — the deploy times out with no
 * indication of why, and an app that worked for years stops working on upgrade.
 *
 * Forwarding the container address to its own loopback restores the old
 * behaviour without loosening isolation: this listens inside the container's
 * network namespace only, and reaches nothing the app could not already reach.
 * Returns false when no forwarder is available, leaving the caller to report
 * the real cause.
 */
export function bridgeContainerLoopbackPort(
  containerName: string,
  networkAddress: string,
  port: number,
): boolean {
  if (!/^[A-Za-z0-9_.-]+$/.test(containerName)) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(networkAddress)) return false;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  // Use whatever the runtime image actually ships: socat is absent from the app
  // runtime, but the interpreter the app itself runs on is always present.
  // Each forwarder is passed as argv, never through a shell, so nothing here
  // depends on quoting surviving two levels of interpretation.
  const hasCommand = (command: string): boolean => {
    try {
      const found = execFileSync(
        DOCKER_BIN,
        ['exec', containerName, 'sh', '-c', `command -v ${command} >/dev/null 2>&1 && echo yes`],
        { timeout: 8_000, encoding: 'utf8' },
      );
      return String(found).trim() === 'yes';
    } catch {
      return false;
    }
  };
  const spawnDetached = (argv: string[]): boolean => {
    try {
      execFileSync(DOCKER_BIN, ['exec', '-d', containerName, ...argv], {
        timeout: 10_000,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  };

  if (hasCommand('socat')) {
    return spawnDetached([
      'socat',
      `TCP-LISTEN:${port},bind=${networkAddress},fork,reuseaddr`,
      `TCP:127.0.0.1:${port}`,
    ]);
  }
  if (hasCommand('node')) {
    return spawnDetached([
      'node', '-e',
      'const net=require("net");'
      + `net.createServer(c=>{const u=net.connect(${port},"127.0.0.1");`
      + 'c.pipe(u);u.pipe(c);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());})'
      + `.listen(${port},"${networkAddress}");`,
    ]);
  }
  if (hasCommand('python3')) {
    return spawnDetached([
      'python3', '-c',
      'import socket,threading\n'
      + 'def pipe(a,b):\n'
      + '    try:\n'
      + '        while True:\n'
      + '            d=a.recv(65536)\n'
      + '            if not d: break\n'
      + '            b.sendall(d)\n'
      + '    except Exception: pass\n'
      + '    finally:\n'
      + '        a.close(); b.close()\n'
      + 's=socket.socket()\n'
      + 's.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)\n'
      + `s.bind(("${networkAddress}",${port}))\n`
      + 's.listen(64)\n'
      + 'while True:\n'
      + '    c,_=s.accept()\n'
      + '    try:\n'
      + `        u=socket.create_connection(("127.0.0.1",${port}))\n`
      + '    except Exception:\n'
      + '        c.close(); continue\n'
      + '    threading.Thread(target=pipe,args=(c,u),daemon=True).start()\n'
      + '    threading.Thread(target=pipe,args=(u,c),daemon=True).start()\n',
    ]);
  }
  return false;
}

export function inspectProjectAppContainer(containerName: string): {
  running: boolean;
  status: string;
  exitCode: number;
  restartCount: number;
  error: string;
} | null {
  try {
    const raw = execFileSync(DOCKER_BIN, [
      'inspect',
      '--format',
      '{{json .State}}|{{.RestartCount}}',
      containerName,
    ], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: dockerCliEnvironment(),
    }).trim();
    const divider = raw.lastIndexOf('|');
    if (divider < 0) return null;
    const state = JSON.parse(raw.slice(0, divider));
    return {
      running: state?.Running === true,
      status: typeof state?.Status === 'string' ? state.Status : 'unknown',
      exitCode: Number.isInteger(state?.ExitCode) ? state.ExitCode : 0,
      restartCount: Number.parseInt(raw.slice(divider + 1), 10) || 0,
      error: typeof state?.Error === 'string' ? state.Error : '',
    };
  } catch {
    return null;
  }
}

export function readProjectAppLogs(containerName: string, lines = 50): string[] {
  try {
    const output = execFileSync(DOCKER_BIN, ['logs', '--tail', String(Math.max(1, Math.min(lines, 200))), containerName], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: dockerCliEnvironment(),
    });
    return output.split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch (error: any) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    return stderr.split(/\r?\n/).filter(Boolean).slice(-lines);
  }
}

export function createProjectLifecycleWorkspace(sourceDir: string): ProjectLifecycleWorkspace {
  const source = assertSafeWorkspace(sourceDir);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgesllm-project-job-'));
  fs.cpSync(source, workspace, {
    recursive: true,
    dereference: false,
    filter: (sourcePath) => {
      const relative = path.relative(source, sourcePath);
      if (!relative) return true;
      const first = relative.split(path.sep)[0];
      return first !== '.git' && first !== 'node_modules' && first !== '.venv';
    },
  });
  return {
    path: workspace,
    cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }),
  };
}

export function promoteProjectLifecycleArtifacts(
  workspace: string,
  destination: string,
  artifacts: readonly string[],
): void {
  const sourceRoot = assertSafeWorkspace(workspace);
  const destinationRoot = assertSafeWorkspace(destination);
  for (const artifact of artifacts) {
    if (!/^[a-zA-Z0-9._-]+$/.test(artifact)) throw new Error('Invalid project lifecycle artifact');
    const source = path.join(sourceRoot, artifact);
    if (!fs.existsSync(source)) continue;
    const target = path.join(destinationRoot, artifact);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true, dereference: false });
  }
}

const DEPLOYMENT_EXCLUDED_ROOTS = new Set(['.git', 'node_modules', '.venv', '.portal']);
const STATIC_DEPLOYMENT_PRIVATE_FILES = new Set([
  '.npmrc',
  '.agent-session.json',
  '.assistant-session.json',
  '.marcus-session.json',
  '.agent-history.json',
  '.assistant-history.json',
  '.marcus-history.json',
  '.agent-memory.md',
  '.assistant-memory.md',
  '.marcus-memory.md',
  '.marcus-pending-commit',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'NOTES.md',
]);
const STATIC_DEPLOYMENT_PRIVATE_SUFFIXES = ['.key', '.p12', '.pfx', '.pem'];

export interface ProjectDeploymentPromotion {
  sourceDigest: string;
  promote: () => void;
  finalize: () => void;
  rollback: () => void;
}

export class ProjectDeploymentReplayStaleError extends Error {
  readonly code = 'PROJECT_RUNTIME_RECOVERY_REPLAY_STALE';

  constructor() {
    super('The Project source changed after the failed runtime action, so Portal did not replay it.');
    this.name = 'ProjectDeploymentReplayStaleError';
  }
}

function fingerprintCopiedDeploymentTree(root: string): string {
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const walk = (current: string, relative: string): void => {
    const entry = fs.lstatSync(current);
    const mode = entry.mode & 0o777;
    if (entry.isDirectory()) {
      digest.update(`d\0${relative}\0${mode.toString(8)}\0`);
      for (const child of fs.readdirSync(current).sort()) {
        walk(path.join(current, child), relative ? `${relative}/${child}` : child);
      }
      return;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('Deployment source contains an unsupported filesystem entry');
    }
    digest.update(`f\0${relative}\0${mode.toString(8)}\0${entry.size}\0`);
    const descriptor = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      let offset = 0;
      while (offset < entry.size) {
        const bytesRead = fs.readSync(
          descriptor,
          buffer,
          0,
          Math.min(buffer.length, entry.size - offset),
          offset,
        );
        if (bytesRead <= 0) throw new Error('Deployment source changed while it was being fingerprinted');
        digest.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (fs.fstatSync(descriptor).size !== entry.size) {
        throw new Error('Deployment source changed while it was being fingerprinted');
      }
    } finally {
      fs.closeSync(descriptor);
    }
    digest.update('\0');
  };
  walk(root, '');
  return digest.digest('hex');
}

function prepareDeploymentTree(
  source: string,
  destination: string,
  options: { excludeStaticPrivateFiles: boolean; expectedSourceDigest?: string },
): ProjectDeploymentPromotion {
  const sourceRoot = assertSafeWorkspace(source);
  const destinationRoot = path.resolve(destination);
  const filesystemRoot = path.parse(destinationRoot).root;
  if (!path.isAbsolute(destination) || destinationRoot === filesystemRoot || destinationRoot.length < filesystemRoot.length + 4) {
    throw new Error('Refusing unsafe static deployment destination');
  }

  const shouldInclude = (current: string): boolean => {
    const relative = path.relative(sourceRoot, current);
    if (!relative) return true;
    const normalized = relative.split(path.sep).join('/');
    const first = normalized.split('/')[0];
    if (DEPLOYMENT_EXCLUDED_ROOTS.has(first)) return false;
    if (!options.excludeStaticPrivateFiles) return true;
    const base = path.posix.basename(normalized);
    return !STATIC_DEPLOYMENT_PRIVATE_FILES.has(base)
      && base !== '.env'
      && !base.startsWith('.env.')
      && !STATIC_DEPLOYMENT_PRIVATE_SUFFIXES.some((suffix) => base.toLowerCase().endsWith(suffix));
  };

  const assertNoLinks = (current: string): void => {
    if (!shouldInclude(current)) return;
    const entry = fs.lstatSync(current);
    if (entry.isSymbolicLink()) {
      throw new Error(`Static deployment output cannot contain symbolic links: ${path.relative(sourceRoot, current)}`);
    }
    if (!entry.isDirectory()) return;
    for (const child of fs.readdirSync(current)) assertNoLinks(path.join(current, child));
  };
  assertNoLinks(sourceRoot);

  const destinationParent = path.dirname(destinationRoot);
  const parentEntry = fs.lstatSync(destinationParent);
  if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
    throw new Error('Static deployment destination parent must be a real directory');
  }
  if (fs.realpathSync(destinationParent) !== destinationParent) {
    throw new Error('Static deployment destination parent must use its canonical path');
  }
  const existingEntry = (() => {
    try { return fs.lstatSync(destinationRoot); } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  })();
  if (existingEntry?.isSymbolicLink()) {
    throw new Error('Static deployment destination cannot be a symbolic link');
  }

  const nonce = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const stagingRoot = path.join(destinationParent, `.${path.basename(destinationRoot)}.deploy-${nonce}`);
  const previousRoot = path.join(destinationParent, `.${path.basename(destinationRoot)}.previous-${nonce}`);
  let sourceDigest = '';
  try {
    fs.cpSync(sourceRoot, stagingRoot, {
      recursive: true,
      dereference: false,
      filter: shouldInclude,
    });
    assertNoLinks(stagingRoot);
    sourceDigest = fingerprintCopiedDeploymentTree(stagingRoot);
    if (
      options.expectedSourceDigest !== undefined
      && sourceDigest !== options.expectedSourceDigest
    ) {
      throw new ProjectDeploymentReplayStaleError();
    }
  } catch (error) {
    try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch {}
    throw error;
  }

  const stagingEntry = fs.lstatSync(stagingRoot);
  const sameEntry = (left: fs.Stats, right: fs.Stats): boolean => (
    left.dev === right.dev && left.ino === right.ino
  );
  const currentDestinationEntry = (): fs.Stats | null => {
    try { return fs.lstatSync(destinationRoot); } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };
  let previousMoved = false;
  let promoted = false;
  let settled = false;
  return {
    sourceDigest,
    promote: () => {
      if (settled) throw new Error('Deployment preparation has already been settled');
      if (promoted) return;
      const currentEntry = currentDestinationEntry();
      if (
        (existingEntry === null) !== (currentEntry === null)
        || (existingEntry && currentEntry && !sameEntry(existingEntry, currentEntry))
      ) {
        throw new Error('Deployment destination changed before promotion');
      }
      if (currentEntry?.isSymbolicLink()) {
        throw new Error('Static deployment destination cannot be a symbolic link');
      }
      try {
        if (currentEntry) {
          fs.renameSync(destinationRoot, previousRoot);
          previousMoved = true;
        }
        fs.renameSync(stagingRoot, destinationRoot);
        const promotedEntry = fs.lstatSync(destinationRoot);
        if (!sameEntry(stagingEntry, promotedEntry)) {
          throw new Error('Deployment staging identity changed during promotion');
        }
        promoted = true;
      } catch (error) {
        if (previousMoved && !fs.existsSync(destinationRoot) && fs.existsSync(previousRoot)) {
          try {
            fs.renameSync(previousRoot, destinationRoot);
            previousMoved = false;
          } catch (rollbackError: any) {
            throw Object.assign(
              new Error(`Deployment promotion failed and the prior deployment could not be restored: ${rollbackError.message}`),
              { cause: error },
            );
          }
        }
        throw error;
      }
    },
    finalize: () => {
      if (settled) return;
      if (!promoted) throw new Error('Deployment preparation was not promoted');
      if (previousMoved) fs.rmSync(previousRoot, { recursive: true, force: true });
      settled = true;
    },
    rollback: () => {
      if (settled) return;
      if (!promoted) {
        const currentStaging = fs.lstatSync(stagingRoot);
        if (!sameEntry(stagingEntry, currentStaging)) {
          throw new Error('Deployment staging identity changed before rollback');
        }
        fs.rmSync(stagingRoot, { recursive: true, force: true });
        settled = true;
        return;
      }
      const failedRoot = path.join(destinationParent, `.${path.basename(destinationRoot)}.failed-${nonce}`);
      const promotedEntry = currentDestinationEntry();
      if (!promotedEntry || !sameEntry(stagingEntry, promotedEntry)) {
        throw new Error('Promoted deployment identity changed before rollback');
      }
      fs.renameSync(destinationRoot, failedRoot);
      let restored = !previousMoved;
      try {
        if (previousMoved) {
          if (!fs.existsSync(previousRoot)) throw new Error('Prior deployment disappeared before rollback');
          fs.renameSync(previousRoot, destinationRoot);
          restored = true;
        }
      } finally {
        if (restored) fs.rmSync(failedRoot, { recursive: true, force: true });
      }
      settled = true;
    },
  };
}

export function copyStaticDeploymentTree(source: string, destination: string): void {
  const promotion = prepareDeploymentTree(source, destination, { excludeStaticPrivateFiles: true });
  promotion.promote();
  promotion.finalize();
}

export function prepareFullstackDeploymentTree(
  source: string,
  destination: string,
  expectedSourceDigest?: string,
): ProjectDeploymentPromotion {
  return prepareDeploymentTree(source, destination, {
    excludeStaticPrivateFiles: false,
    ...(expectedSourceDigest ? { expectedSourceDigest } : {}),
  });
}

export function copyFullstackDeploymentTree(
  source: string,
  destination: string,
  expectedSourceDigest?: string,
): ProjectDeploymentPromotion {
  const promotion = prepareFullstackDeploymentTree(source, destination, expectedSourceDigest);
  promotion.promote();
  return promotion;
}

/**
 * Desktop runtimes need the Project's private runtime configuration, but they
 * must never inherit relocatable build artifacts such as a container-created
 * .venv. Replace the complete tree so deleted source files cannot survive a
 * redeploy as stale host-executed code.
 */
export function copyDesktopRuntimeDeploymentTree(source: string, destination: string): void {
  const promotion = prepareDeploymentTree(source, destination, { excludeStaticPrivateFiles: false });
  promotion.promote();
  promotion.finalize();
}

export const __projectLifecycleTest = {
  dockerCliEnvironment,
  projectContainerName,
};
