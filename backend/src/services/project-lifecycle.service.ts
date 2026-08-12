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
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
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
import {
  acquireProjectDeletionLockWithoutGuard,
  assertHeldProjectDeletionLockLease,
  projectDeletionLockKey,
  type ProjectDeletionLockLease,
} from './projectDeletionLock';
import {
  buildProjectDependencyPromotionManifest,
  type ProjectDependencyPromotionEntryIdentity,
  type ProjectDependencyPromotionManifest,
} from './projectDependencyPromotionManifest';
import {
  deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup,
  findProjectDependencyPromotionDecisionByDestination,
  listProjectDependencyPromotionDecisions,
  listProjectDependencyPromotionLifecycleRecords,
  markProjectDependencyPromotionApplied,
  quarantineProjectDependencyPromotion,
  readProjectDependencyPromotionLifecycle,
  readProjectDependencyPromotionLifecycleByProject,
  resolveProjectDependencyPromotionDecision,
  ProjectDependencyPromotionDecisionError,
  type ProjectDependencyPromotionDecisionDatabase,
  type ProjectDependencyPromotionDecisionStatus,
  type ProjectDependencyPromotionLifecycleStatus,
  type ProjectDependencyPromotionLifecycleRecord,
  type ProjectDependencyPromotionDecisionRecord,
} from './projectDependencyPromotionDecision';

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

export interface PreparedProjectLifecycleArtifactPromotion {
  /** Immutable, server-computed binding used by the durable DB decision. */
  readonly manifest: ProjectDependencyPromotionManifest;
  /** Re-attest exact all-old/all-staged inode topology immediately before DB authorization. */
  reattest(): void;
  /** Journaled same-filesystem swaps only; expensive copies happen in prepare. */
  commit(): void;
  /** Restore the exact pre-commit artifacts while backups are still retained. */
  rollback(): void;
  /** Durably choose the all-new generation after its database lock commits. */
  finalize(): void;
  /** Remove evidence only after all-old or all-new convergence is verified. */
  cleanup(): Promise<void>;
  /**
   * Remove only exact private PREPARED evidence when an older admitted
   * mutation replaced the destination while the global writer fence drained.
   * This path never reads, renames, or removes a live Project artifact.
   */
  cleanupPreparedStagingOnly(): Promise<void>;
}

export interface ProjectLifecycleArtifactPromotionProjectProof {
  projectIdentityId: string;
  projectIdentityGeneration: number;
  workspaceOwnerId: string;
  projectName: string;
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
}

export type ProjectLifecycleArtifactPromotionCheckpoint =
  | 'after-staging-root'
  | 'after-preparation-temp'
  | 'after-preparation-create'
  | `after-copy:${number}`
  | 'after-preparation-ready-temp'
  | 'after-preparation-ready'
  | 'after-journal-temp'
  | 'after-journal-create'
  | `after-backup:${number}`
  | `after-promote:${number}`
  | 'after-swapped'
  | 'before-committed'
  | 'after-committed-temp'
  | 'after-committed'
  | 'after-staging-cleanup'
  | 'after-journal-cleanup';

type PromotionEntryIdentity = ProjectDependencyPromotionEntryIdentity;

type PromotionEntryPhase =
  | 'UNCHANGED'
  | 'PREPARED'
  | 'BACKED_UP'
  | 'PROMOTED'
  | 'NEW_RESTAGED'
  | 'RESTORED';

interface ProjectLifecycleArtifactPromotionEntry {
  artifact: string;
  stagedRelativePath: string;
  backupRelativePath: string;
  hadTarget: boolean;
  originalIdentity: PromotionEntryIdentity | null;
  stagedIdentity: PromotionEntryIdentity | null;
  stagedTreeDigest: string | null;
  phase: PromotionEntryPhase;
}

type ProjectLifecycleArtifactPromotionState =
  | 'PREPARED'
  | 'ABANDONED'
  | 'COMMITTING'
  | 'SWAPPED'
  | 'ROLLING_BACK'
  | 'ROLLED_BACK'
  | 'COMMITTED';

interface ProjectLifecycleArtifactPromotionJournal {
  schemaVersion: 1;
  operationId: string;
  workspaceOwnerId: string;
  projectName: string;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  projectRootBirthtimeNs: string;
  destinationCanonicalRoot: string;
  destinationIdentity: PromotionEntryIdentity;
  operationParentCanonicalRoot: string;
  operationParentIdentity: PromotionEntryIdentity;
  stagingCanonicalRoot: string;
  stagingIdentity: PromotionEntryIdentity;
  requestedArtifacts: string[];
  entries: ProjectLifecycleArtifactPromotionEntry[];
  state: ProjectLifecycleArtifactPromotionState;
  createdAt: string;
  updatedAt: string;
}

type ProjectLifecycleArtifactPromotionPreparationState = 'COPYING' | 'PREPARED';

interface ProjectLifecycleArtifactPromotionPreparation {
  schemaVersion: 1;
  operationId: string;
  workspaceOwnerId: string;
  projectName: string;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  projectRootBirthtimeNs: string;
  destinationCanonicalRoot: string;
  destinationIdentity: PromotionEntryIdentity;
  operationParentCanonicalRoot: string;
  operationParentIdentity: PromotionEntryIdentity;
  stagingCanonicalRoot: string;
  stagingIdentity: PromotionEntryIdentity;
  requestedArtifacts: string[];
  entries: ProjectLifecycleArtifactPromotionEntry[];
  state: ProjectLifecycleArtifactPromotionPreparationState;
  createdAt: string;
  updatedAt: string;
}

const PROJECT_ARTIFACT_PROMOTION_PREFIX = '.bridgesllm-project-promotion-';
const PROJECT_ARTIFACT_PROMOTION_JOURNAL_SUFFIX = '.journal.json';
const PROJECT_ARTIFACT_PROMOTION_PREPARATION_FILE = '.preparation.json';
const PROJECT_ARTIFACT_PROMOTION_MAX_JOURNAL_BYTES = 128 * 1024;
const PROJECT_ARTIFACT_PROMOTION_OPERATION_ID =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PROJECT_ARTIFACT_PROMOTION_STATES = new Set<ProjectLifecycleArtifactPromotionState>([
  'PREPARED',
  'ABANDONED',
  'COMMITTING',
  'SWAPPED',
  'ROLLING_BACK',
  'ROLLED_BACK',
  'COMMITTED',
]);
const PROJECT_ARTIFACT_PROMOTION_ENTRY_PHASES = new Set<PromotionEntryPhase>([
  'UNCHANGED',
  'PREPARED',
  'BACKED_UP',
  'PROMOTED',
  'NEW_RESTAGED',
  'RESTORED',
]);

export class ProjectLifecycleArtifactPromotionRecoveryError extends Error {
  readonly code = 'PROJECT_DEPENDENCY_PROMOTION_QUARANTINED';
  readonly retryable = false;
  readonly scope: 'global' | 'project';

  constructor(
    message = 'Interrupted Project dependency promotion is ambiguous and remains quarantined.',
    scope: 'global' | 'project' = 'global',
  ) {
    super(message);
    this.name = 'ProjectLifecycleArtifactPromotionRecoveryError';
    this.scope = scope;
  }
}

export type ProjectDependencyPromotionStartupEvidenceSourceKind =
  | 'decision'
  | 'lifecycle'
  | 'journal'
  | 'preparation'
  | 'staging'
  | 'topology'
  | 'journal_temporary'
  | 'preparation_temporary';

export interface ProjectDependencyPromotionStartupEvidenceSource {
  kind: ProjectDependencyPromotionStartupEvidenceSourceKind;
  operationId: string | null;
  state: string | null;
  canonicalPath: string | null;
  contentSha256: string | null;
}

export interface ProjectDependencyPromotionStartupTarget {
  projectIdentityId: string;
  projectIdentityGeneration: number;
  workspaceOwnerId: string;
  projectName: string;
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  lifecycleStatus: ProjectDependencyPromotionLifecycleStatus | null;
  decisionStatus: ProjectDependencyPromotionDecisionStatus | null;
  operationIds: string[];
  sources: ProjectDependencyPromotionStartupEvidenceSource[];
}

export interface ProjectDependencyPromotionStartupUnboundEvidence {
  kind: 'staging' | 'journal_temporary' | 'preparation_temporary';
  workspaceOwnerId: string;
  operationId: string | null;
  canonicalPath: string;
  safeCleanupCandidate: boolean;
  contentSha256: string | null;
}

export interface ProjectDependencyPromotionStartupUncertainEvidence {
  code: string;
  workspaceOwnerId: string | null;
  operationId: string | null;
  canonicalPath: string | null;
  /** Stable no-follow fingerprint of the unsafe evidence when one is available. */
  evidenceSha256: string | null;
}

export interface ProjectDependencyPromotionStartupEvidenceInspection {
  schemaVersion: 1;
  snapshotSha256: string;
  hasEvidence: boolean;
  targets: ProjectDependencyPromotionStartupTarget[];
  containedQuarantines: ProjectDependencyPromotionStartupTarget[];
  unboundEvidence: ProjectDependencyPromotionStartupUnboundEvidence[];
  uncertainEvidence: ProjectDependencyPromotionStartupUncertainEvidence[];
}

function promotionFail(message: string): never {
  throw new ProjectLifecycleArtifactPromotionRecoveryError(message);
}

function promotionContained(message: string): ProjectLifecycleArtifactPromotionRecoveryError {
  return new ProjectLifecycleArtifactPromotionRecoveryError(message, 'project');
}

export function isProjectAttributablePromotionFilesystemError(error: unknown): boolean {
  if (error instanceof ProjectLifecycleArtifactPromotionRecoveryError) return true;
  const code = String((error as { code?: unknown })?.code || '');
  return ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM', 'ESTALE', 'EXDEV'].includes(code);
}

function currentOwnerUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

function currentOwnerGid(): number {
  return typeof process.getgid === 'function' ? process.getgid() : 0;
}

function fsyncPromotionDirectory(directory: string): void {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY
      | (fs.constants.O_DIRECTORY || 0)
      | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

async function fsyncPromotionTree(root: string): Promise<void> {
  const entry = await fs.promises.lstat(root, { bigint: true });
  if (entry.isSymbolicLink()) return;
  if (entry.isFile()) {
    const descriptor = await fs.promises.open(
      root,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    try {
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    return;
  }
  if (!entry.isDirectory()) promotionFail('Project dependency staging contains an unsupported filesystem entry.');
  for (const child of (await fs.promises.readdir(root)).sort()) {
    await fsyncPromotionTree(path.join(root, child));
  }
  const descriptor = await fs.promises.open(
    root,
    fs.constants.O_RDONLY
      | (fs.constants.O_DIRECTORY || 0)
      | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

function promotionIdentity(candidate: string): PromotionEntryIdentity {
  const resolved = path.resolve(candidate);
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(resolved, { bigint: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') promotionFail('Project dependency promotion evidence disappeared.');
    throw error;
  }
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    promotionFail('Project dependency promotion evidence has an unsupported filesystem type.');
  }
  if (fs.realpathSync.native(resolved) !== resolved) {
    promotionFail('Project dependency promotion evidence no longer uses its canonical path.');
  }
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    kind: stat.isDirectory() ? 'directory' : 'file',
    mode: Number(stat.mode & 0o777n),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    birthtimeNs: stat.birthtimeNs.toString(),
  };
}

function optionalPromotionIdentity(candidate: string): PromotionEntryIdentity | null {
  try {
    fs.lstatSync(candidate);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return promotionIdentity(candidate);
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => (
    String.fromCharCode(Number.parseInt(octal, 8))
  ));
}

function descendantMountBoundaries(root: string): string[] {
  const canonicalRoot = path.resolve(root);
  const prefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : `${canonicalRoot}${path.sep}`;
  const mountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  return mountInfo.split('\n').filter(Boolean).flatMap((line) => {
    const fields = line.split(' ');
    if (fields.length < 6) promotionFail('Linux mount inventory is malformed.');
    const mountPoint = path.resolve(decodeMountInfoPath(fields[4]));
    return mountPoint === canonicalRoot || mountPoint.startsWith(prefix) ? [mountPoint] : [];
  }).sort();
}

function promotionTreeDigest(candidate: string): string {
  const root = path.resolve(candidate);
  const rootStat = fs.lstatSync(root, { bigint: true });
  const mountBoundariesBefore = descendantMountBoundaries(root);
  if (mountBoundariesBefore.length > 0) {
    promotionFail('Project dependency evidence crosses a mount or bind-mount boundary.');
  }
  const hash = crypto.createHash('sha256');
  const sameStableStat = (left: fs.BigIntStats, right: fs.BigIntStats): boolean => (
    left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs
    && left.size === right.size
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.isDirectory() === right.isDirectory()
    && left.isFile() === right.isFile()
    && left.isSymbolicLink() === right.isSymbolicLink()
  );
  const visit = (entryPath: string, relative: string): void => {
    const before = fs.lstatSync(entryPath, { bigint: true });
    if (before.dev !== rootStat.dev) {
      promotionFail('Project dependency evidence crosses a filesystem boundary.');
    }
    if (before.isSymbolicLink()) {
      const target = fs.readlinkSync(entryPath);
      const after = fs.lstatSync(entryPath, { bigint: true });
      if (
        !after.isSymbolicLink()
        || !sameStableStat(before, after)
      ) promotionFail('Project dependency staged symlink changed during digest attestation.');
      hash.update(JSON.stringify([
        relative,
        'symlink',
        Number(before.mode & 0o777n),
        Number(before.uid),
        Number(before.gid),
        before.size.toString(),
        target,
      ]));
      hash.update('\0');
      return;
    }
    let descriptor: number;
    try {
      descriptor = fs.openSync(
        entryPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
    } catch {
      promotionFail('Project dependency staged tree changed during digest attestation.');
    }
    try {
      const stat = fs.fstatSync(descriptor, { bigint: true });
      if (
        !sameStableStat(before, stat)
        || (!stat.isFile() && !stat.isDirectory())
      ) {
        promotionFail('Project dependency staged tree contains an unsupported entry.');
      }
      const kind = stat.isDirectory() ? 'directory' : 'file';
      hash.update(JSON.stringify([
        relative,
        kind,
        Number(stat.mode & 0o777n),
        Number(stat.uid),
        Number(stat.gid),
        stat.size.toString(),
      ]));
      hash.update('\0');
      if (stat.isDirectory()) {
        const names = fs.readdirSync(`/proc/self/fd/${descriptor}`).sort();
        for (const name of names) {
          if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
            promotionFail('Project dependency staged tree contains an unsafe entry name.');
          }
          visit(path.join(`/proc/self/fd/${descriptor}`, name), relative ? `${relative}/${name}` : name);
        }
        const namesAfter = fs.readdirSync(`/proc/self/fd/${descriptor}`).sort();
        if (namesAfter.length !== names.length
          || namesAfter.some((name, index) => name !== names[index])) {
          promotionFail('Project dependency staged directory changed during digest attestation.');
        }
      } else {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        for (;;) {
          const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, position);
          if (bytes === 0) break;
          hash.update(buffer.subarray(0, bytes));
          position += bytes;
        }
      }
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (!sameStableStat(stat, after)) {
        promotionFail('Project dependency staged tree changed during digest attestation.');
      }
    } finally {
      fs.closeSync(descriptor);
    }
  };
  visit(root, '');
  const mountBoundariesAfter = descendantMountBoundaries(root);
  if (JSON.stringify(mountBoundariesAfter) !== JSON.stringify(mountBoundariesBefore)) {
    promotionFail('Project dependency mount topology changed during digest attestation.');
  }
  return hash.digest('hex');
}

function requirePromotionTreeDigest(candidate: string, expected: string | null, label: string): void {
  if (!expected || promotionTreeDigest(candidate) !== expected) {
    promotionFail(`${label} no longer matches its durable recursive content digest.`);
  }
}

function promotionIdentitiesMatch(
  left: PromotionEntryIdentity | null,
  right: PromotionEntryIdentity | null,
): boolean {
  if (!left || !right) return left === right;
  return left.device === right.device
    && left.inode === right.inode
    && left.kind === right.kind
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.birthtimeNs === right.birthtimeNs;
}

function projectLifecycleArtifactPromotionManifest(
  journal: ProjectLifecycleArtifactPromotionJournal,
): ProjectDependencyPromotionManifest {
  return buildProjectDependencyPromotionManifest({
    schemaVersion: 1 as const,
    operationId: journal.operationId,
    workspaceOwnerId: journal.workspaceOwnerId,
    projectName: journal.projectName,
    projectIdentityId: journal.projectIdentityId,
    projectIdentityGeneration: journal.projectIdentityGeneration,
    projectRootBirthtimeNs: journal.projectRootBirthtimeNs,
    operationParentCanonicalRoot: journal.operationParentCanonicalRoot,
    operationParentIdentity: { ...journal.operationParentIdentity },
    destinationCanonicalRoot: journal.destinationCanonicalRoot,
    destinationIdentity: { ...journal.destinationIdentity },
    stagingCanonicalRoot: journal.stagingCanonicalRoot,
    stagingIdentity: { ...journal.stagingIdentity },
    entries: journal.entries.map((entry) => ({
      artifact: entry.artifact,
      originalIdentity: entry.originalIdentity ? { ...entry.originalIdentity } : null,
      stagedIdentity: entry.stagedIdentity ? { ...entry.stagedIdentity } : null,
      stagedTreeDigest: entry.stagedTreeDigest,
    })),
  });
}

function projectLifecycleArtifactPromotionJournalFromManifest(
  manifest: ProjectDependencyPromotionManifest,
): ProjectLifecycleArtifactPromotionJournal {
  const timestamp = new Date(0).toISOString();
  return {
    schemaVersion: 1,
    operationId: manifest.operationId,
    workspaceOwnerId: manifest.workspaceOwnerId,
    projectName: manifest.projectName,
    projectIdentityId: manifest.projectIdentityId,
    projectIdentityGeneration: manifest.projectIdentityGeneration,
    projectRootBirthtimeNs: manifest.projectRootBirthtimeNs,
    destinationCanonicalRoot: manifest.destinationCanonicalRoot,
    destinationIdentity: { ...manifest.destinationIdentity },
    operationParentCanonicalRoot: manifest.operationParentCanonicalRoot,
    operationParentIdentity: { ...manifest.operationParentIdentity },
    stagingCanonicalRoot: manifest.stagingCanonicalRoot,
    stagingIdentity: { ...manifest.stagingIdentity },
    requestedArtifacts: manifest.entries.map((entry) => entry.artifact),
    entries: manifest.entries.map((entry) => ({
      artifact: entry.artifact,
      stagedRelativePath: `artifacts/${entry.artifact}`,
      backupRelativePath: `backups/${entry.artifact}`,
      hadTarget: entry.originalIdentity !== null,
      originalIdentity: entry.originalIdentity ? { ...entry.originalIdentity } : null,
      stagedIdentity: entry.stagedIdentity ? { ...entry.stagedIdentity } : null,
      stagedTreeDigest: entry.stagedTreeDigest,
      phase: entry.stagedIdentity ? 'PROMOTED' : 'UNCHANGED',
    })),
    state: 'COMMITTED',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function requirePromotionIdentity(
  candidate: string,
  expected: PromotionEntryIdentity,
  label: string,
): void {
  if (!promotionIdentitiesMatch(optionalPromotionIdentity(candidate), expected)) {
    promotionFail(`${label} no longer matches its durable Project dependency promotion identity.`);
  }
}

function validPromotionIdentity(value: unknown): value is PromotionEntryIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as PromotionEntryIdentity;
  return /^\d+$/.test(String(identity.device))
    && /^\d+$/.test(String(identity.inode))
    && (identity.kind === 'file' || identity.kind === 'directory')
    && Number.isInteger(identity.mode)
    && identity.mode >= 0
    && identity.mode <= 0o777
    && Number.isInteger(identity.uid)
    && identity.uid >= 0
    && Number.isInteger(identity.gid)
    && identity.gid >= 0
    && /^\d+$/.test(identity.birthtimeNs);
}

function promotionJournalFile(parent: string, operationId: string): string {
  return path.join(
    parent,
    `${PROJECT_ARTIFACT_PROMOTION_PREFIX}${operationId}${PROJECT_ARTIFACT_PROMOTION_JOURNAL_SUFFIX}`,
  );
}

function promotionStagingRoot(parent: string, operationId: string): string {
  return path.join(parent, `${PROJECT_ARTIFACT_PROMOTION_PREFIX}${operationId}`);
}

function promotionJournalBasename(value: string): boolean {
  const escapedPrefix = PROJECT_ARTIFACT_PROMOTION_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedSuffix = PROJECT_ARTIFACT_PROMOTION_JOURNAL_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escapedPrefix}${PROJECT_ARTIFACT_PROMOTION_OPERATION_ID}${escapedSuffix}$`)
    .test(value);
}

function promotionJournalTemporaryOperationId(value: string): string | null {
  const escapedPrefix = PROJECT_ARTIFACT_PROMOTION_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedSuffix = PROJECT_ARTIFACT_PROMOTION_JOURNAL_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `^\\.${escapedPrefix}`
      + `(${PROJECT_ARTIFACT_PROMOTION_OPERATION_ID})`
      + `${escapedSuffix}\\.[1-9][0-9]*\\.`
      + '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$',
  ).exec(value);
  return match?.[1] || null;
}

function promotionPreparationTemporaryBasename(value: string): boolean {
  const escaped = PROJECT_ARTIFACT_PROMOTION_PREPARATION_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^\\.${escaped}\\.[1-9][0-9]*\\.`
      + '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$',
  ).test(value);
}

function assertPrivatePromotionTemporaryFile(file: string, label: string): void {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile()
      || stat.uid !== currentOwnerUid()
      || stat.gid !== currentOwnerGid()
      || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== 1
      || stat.size <= 0
      || stat.size > PROJECT_ARTIFACT_PROMOTION_MAX_JOURNAL_BYTES
    ) promotionFail(`${label} is not a private server-owned file.`);
  } finally {
    fs.closeSync(descriptor);
  }
}

function promotionStagingOperationId(value: string): string | null {
  const match = new RegExp(
    `^${PROJECT_ARTIFACT_PROMOTION_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
      + `(${PROJECT_ARTIFACT_PROMOTION_OPERATION_ID})$`,
  ).exec(value);
  return match?.[1] || null;
}

function promotionPreparationFile(stagingRoot: string): string {
  return path.join(stagingRoot, PROJECT_ARTIFACT_PROMOTION_PREPARATION_FILE);
}

function assertPromotionPreparationShape(
  value: unknown,
  file: string,
): ProjectLifecycleArtifactPromotionPreparation {
  if (!value || typeof value !== 'object') {
    promotionFail('Project dependency promotion preparation record is malformed.');
  }
  const preparation = value as ProjectLifecycleArtifactPromotionPreparation;
  const stagingRoot = path.dirname(file);
  const operationParent = path.dirname(stagingRoot);
  const operationId = promotionStagingOperationId(path.basename(stagingRoot));
  if (
    preparation.schemaVersion !== 1
    || !operationId
    || preparation.operationId !== operationId
    || path.basename(file) !== PROJECT_ARTIFACT_PROMOTION_PREPARATION_FILE
    || typeof preparation.workspaceOwnerId !== 'string'
    || !preparation.workspaceOwnerId
    || typeof preparation.projectName !== 'string'
    || !preparation.projectName
    || path.basename(preparation.projectName) !== preparation.projectName
    || preparation.projectName.includes('\\')
    || typeof preparation.projectIdentityId !== 'string'
    || !preparation.projectIdentityId
    || !Number.isSafeInteger(preparation.projectIdentityGeneration)
    || preparation.projectIdentityGeneration < 1
    || !/^\d+$/.test(preparation.projectRootBirthtimeNs)
    || preparation.workspaceOwnerId !== path.basename(operationParent)
    || preparation.operationParentCanonicalRoot !== operationParent
    || preparation.destinationCanonicalRoot !== path.join(operationParent, preparation.projectName)
    || preparation.stagingCanonicalRoot !== stagingRoot
    || !validPromotionIdentity(preparation.destinationIdentity)
    || preparation.destinationIdentity.kind !== 'directory'
    || !validPromotionIdentity(preparation.operationParentIdentity)
    || preparation.operationParentIdentity.kind !== 'directory'
    || !validPromotionIdentity(preparation.stagingIdentity)
    || preparation.stagingIdentity.kind !== 'directory'
    || !Array.isArray(preparation.requestedArtifacts)
    || preparation.requestedArtifacts.length === 0
    || preparation.requestedArtifacts.length > 16
    || new Set(preparation.requestedArtifacts).size !== preparation.requestedArtifacts.length
    || !preparation.requestedArtifacts.every((artifact) => /^[a-zA-Z0-9._-]+$/.test(artifact))
    || !Array.isArray(preparation.entries)
    || (preparation.state !== 'COPYING' && preparation.state !== 'PREPARED')
    || (preparation.state === 'COPYING' && preparation.entries.length !== 0)
    || (preparation.state === 'PREPARED'
      && preparation.entries.length !== preparation.requestedArtifacts.length)
  ) promotionFail('Project dependency promotion preparation record is incomplete or unsafe.');

  if (preparation.state === 'PREPARED') {
    for (const [index, entry] of preparation.entries.entries()) {
      const artifact = preparation.requestedArtifacts[index];
      if (
        !entry
        || entry.artifact !== artifact
        || entry.stagedRelativePath !== `artifacts/${artifact}`
        || entry.backupRelativePath !== `backups/${artifact}`
        || typeof entry.hadTarget !== 'boolean'
        || entry.hadTarget !== (entry.originalIdentity !== null)
        || (entry.originalIdentity !== null && !validPromotionIdentity(entry.originalIdentity))
        || (entry.stagedIdentity !== null && !validPromotionIdentity(entry.stagedIdentity))
        || (entry.stagedIdentity !== null && !/^[a-f0-9]{64}$/.test(entry.stagedTreeDigest || ''))
        || (entry.stagedIdentity === null && entry.stagedTreeDigest !== null)
        || entry.phase !== (entry.stagedIdentity ? 'PREPARED' : 'UNCHANGED')
      ) promotionFail('Project dependency promotion preparation entry is incomplete or unsafe.');
    }
  }
  return preparation;
}

function readPromotionPreparation(file: string): ProjectLifecycleArtifactPromotionPreparation {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY
        | (fs.constants.O_NOFOLLOW || 0)
        | (fs.constants.O_NONBLOCK || 0),
    );
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      promotionFail('Project dependency promotion preparation record disappeared.');
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile()
      || stat.uid !== currentOwnerUid()
      || stat.gid !== currentOwnerGid()
      || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== 1
      || stat.size <= 0
      || stat.size > PROJECT_ARTIFACT_PROMOTION_MAX_JOURNAL_BYTES
    ) promotionFail('Project dependency promotion preparation record is not a private server-owned file.');
    const content = Buffer.alloc(stat.size);
    if (fs.readSync(descriptor, content, 0, content.length, 0) !== content.length) {
      promotionFail('Project dependency promotion preparation record could not be read completely.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.toString('utf8'));
    } catch {
      promotionFail('Project dependency promotion preparation record cannot be parsed.');
    }
    return assertPromotionPreparationShape(parsed, file);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writePromotionPreparation(
  file: string,
  preparation: ProjectLifecycleArtifactPromotionPreparation,
  createOnly = false,
  beforePublish?: () => void,
): void {
  const directory = path.dirname(file);
  const updated = {
    ...preparation,
    updatedAt: new Date().toISOString(),
  } satisfies ProjectLifecycleArtifactPromotionPreparation;
  assertPromotionPreparationShape(updated, file);
  const serialized = `${JSON.stringify(updated)}\n`;
  if (createOnly) {
    const temporary = path.join(
      directory,
      `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    const descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, serialized, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    beforePublish?.();
    try {
      if (fs.existsSync(file)) {
        promotionFail('Project dependency promotion preparation record already exists.');
      }
      fs.renameSync(temporary, file);
      fsyncPromotionDirectory(directory);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
    Object.assign(preparation, updated);
    return;
  }

  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY
      | fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, serialized, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  beforePublish?.();
  try {
    fs.renameSync(temporary, file);
    fsyncPromotionDirectory(directory);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  Object.assign(preparation, updated);
}

function assertPromotionJournalShape(
  value: unknown,
  file: string,
): ProjectLifecycleArtifactPromotionJournal {
  if (!value || typeof value !== 'object') promotionFail('Project dependency promotion journal is malformed.');
  const journal = value as ProjectLifecycleArtifactPromotionJournal;
  const operationParent = path.dirname(file);
  if (
    journal.schemaVersion !== 1
    || !new RegExp(`^${PROJECT_ARTIFACT_PROMOTION_OPERATION_ID}$`).test(
      String(journal.operationId || ''),
    )
    || path.basename(file) !== path.basename(promotionJournalFile(operationParent, journal.operationId))
    || typeof journal.workspaceOwnerId !== 'string'
    || !journal.workspaceOwnerId
    || typeof journal.projectName !== 'string'
    || !journal.projectName
    || path.basename(journal.projectName) !== journal.projectName
    || journal.projectName.includes('\\')
    || typeof journal.projectIdentityId !== 'string'
    || !journal.projectIdentityId
    || !Number.isSafeInteger(journal.projectIdentityGeneration)
    || journal.projectIdentityGeneration < 1
    || !/^\d+$/.test(journal.projectRootBirthtimeNs)
    || path.resolve(journal.operationParentCanonicalRoot) !== operationParent
    || journal.operationParentCanonicalRoot !== operationParent
    || path.resolve(journal.destinationCanonicalRoot)
      !== path.join(operationParent, journal.projectName)
    || journal.destinationCanonicalRoot !== path.join(operationParent, journal.projectName)
    || path.basename(operationParent) !== journal.workspaceOwnerId
    || path.resolve(journal.stagingCanonicalRoot)
      !== promotionStagingRoot(operationParent, journal.operationId)
    || journal.stagingCanonicalRoot
      !== promotionStagingRoot(operationParent, journal.operationId)
    || !validPromotionIdentity(journal.destinationIdentity)
    || journal.destinationIdentity.kind !== 'directory'
    || !validPromotionIdentity(journal.operationParentIdentity)
    || journal.operationParentIdentity.kind !== 'directory'
    || !validPromotionIdentity(journal.stagingIdentity)
    || journal.stagingIdentity.kind !== 'directory'
    || !Array.isArray(journal.requestedArtifacts)
    || journal.requestedArtifacts.length === 0
    || journal.requestedArtifacts.length > 16
    || new Set(journal.requestedArtifacts).size !== journal.requestedArtifacts.length
    || !journal.requestedArtifacts.every((artifact) => /^[a-zA-Z0-9._-]+$/.test(artifact))
    || !Array.isArray(journal.entries)
    || journal.entries.length !== journal.requestedArtifacts.length
    || !PROJECT_ARTIFACT_PROMOTION_STATES.has(journal.state)
  ) promotionFail('Project dependency promotion journal is incomplete or unsafe.');

  for (const [index, entry] of journal.entries.entries()) {
    const artifact = journal.requestedArtifacts[index];
    if (
      !entry
      || entry.artifact !== artifact
      || entry.stagedRelativePath !== `artifacts/${artifact}`
      || entry.backupRelativePath !== `backups/${artifact}`
      || typeof entry.hadTarget !== 'boolean'
      || entry.hadTarget !== (entry.originalIdentity !== null)
      || (entry.originalIdentity !== null && !validPromotionIdentity(entry.originalIdentity))
      || (entry.stagedIdentity !== null && !validPromotionIdentity(entry.stagedIdentity))
      || (entry.stagedIdentity !== null && !/^[a-f0-9]{64}$/.test(entry.stagedTreeDigest || ''))
      || (entry.stagedIdentity === null && entry.stagedTreeDigest !== null)
      || !PROJECT_ARTIFACT_PROMOTION_ENTRY_PHASES.has(entry.phase)
      || (entry.stagedIdentity === null && entry.phase !== 'UNCHANGED')
    ) promotionFail('Project dependency promotion journal entry is incomplete or unsafe.');
    if (
      entry.originalIdentity
      && entry.stagedIdentity
      && promotionIdentitiesMatch(entry.originalIdentity, entry.stagedIdentity)
    ) promotionFail('Project dependency promotion generations do not have distinct identities.');
  }
  return journal;
}

function readPromotionJournal(file: string): ProjectLifecycleArtifactPromotionJournal {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY
        | (fs.constants.O_NOFOLLOW || 0)
        | (fs.constants.O_NONBLOCK || 0),
    );
  } catch (error: any) {
    if (error?.code === 'ENOENT') promotionFail('Project dependency promotion journal disappeared.');
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile()
      || stat.uid !== currentOwnerUid()
      || stat.gid !== currentOwnerGid()
      || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== 1
      || stat.size <= 0
      || stat.size > PROJECT_ARTIFACT_PROMOTION_MAX_JOURNAL_BYTES
    ) promotionFail('Project dependency promotion journal is not a private server-owned file.');
    const content = Buffer.alloc(stat.size);
    if (fs.readSync(descriptor, content, 0, content.length, 0) !== content.length) {
      promotionFail('Project dependency promotion journal could not be read completely.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.toString('utf8'));
    } catch {
      promotionFail('Project dependency promotion journal cannot be parsed.');
    }
    return assertPromotionJournalShape(parsed, file);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writePromotionJournal(
  file: string,
  journal: ProjectLifecycleArtifactPromotionJournal,
  createOnly = false,
  beforePublish?: () => void,
): void {
  const directory = path.dirname(file);
  const updated = {
    ...journal,
    updatedAt: new Date().toISOString(),
  } satisfies ProjectLifecycleArtifactPromotionJournal;
  assertPromotionJournalShape(updated, file);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY
      | fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(updated)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  beforePublish?.();
  try {
    if (createOnly && fs.existsSync(file)) {
      promotionFail('Project dependency promotion journal already exists.');
    }
    fs.renameSync(temporary, file);
    fsyncPromotionDirectory(directory);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  Object.assign(journal, updated);
}

function assertPromotionRoots(
  journal: ProjectLifecycleArtifactPromotionJournal,
  options: { allowMissingStaging?: boolean } = {},
): void {
  requirePromotionIdentity(
    journal.operationParentCanonicalRoot,
    journal.operationParentIdentity,
    'Project dependency promotion parent',
  );
  requirePromotionIdentity(
    journal.destinationCanonicalRoot,
    journal.destinationIdentity,
    'Project dependency destination',
  );
  const stagingIdentity = optionalPromotionIdentity(journal.stagingCanonicalRoot);
  if (!stagingIdentity && options.allowMissingStaging) return;
  if (!promotionIdentitiesMatch(stagingIdentity, journal.stagingIdentity)) {
    promotionFail('Project dependency promotion staging root changed identity.');
  }
  const stagingStat = fs.lstatSync(journal.stagingCanonicalRoot);
  if (
    stagingStat.uid !== currentOwnerUid()
    || stagingStat.gid !== currentOwnerGid()
    || (stagingStat.mode & 0o077) !== 0
  ) promotionFail('Project dependency promotion staging root is not server-private.');
}

function entryPaths(
  journal: ProjectLifecycleArtifactPromotionJournal,
  entry: ProjectLifecycleArtifactPromotionEntry,
): { target: string; staged: string; backup: string } {
  return {
    target: path.join(journal.destinationCanonicalRoot, entry.artifact),
    staged: path.join(journal.stagingCanonicalRoot, entry.stagedRelativePath),
    backup: path.join(journal.stagingCanonicalRoot, entry.backupRelativePath),
  };
}

function identifyEntryTopology(
  journal: ProjectLifecycleArtifactPromotionJournal,
  entry: ProjectLifecycleArtifactPromotionEntry,
): {
  target: PromotionEntryIdentity | null;
  staged: PromotionEntryIdentity | null;
  backup: PromotionEntryIdentity | null;
  oldLocation: 'target' | 'backup' | null;
  newLocation: 'target' | 'staged' | null;
} {
  const paths = entryPaths(journal, entry);
  const actual = {
    target: optionalPromotionIdentity(paths.target),
    staged: optionalPromotionIdentity(paths.staged),
    backup: optionalPromotionIdentity(paths.backup),
  };
  const allowed = [entry.originalIdentity, entry.stagedIdentity].filter(
    (identity): identity is PromotionEntryIdentity => identity !== null,
  );
  for (const [location, identity] of Object.entries(actual)) {
    if (identity && !allowed.some((expected) => promotionIdentitiesMatch(identity, expected))) {
      promotionFail(`Project dependency promotion ${location} entry has an unknown identity.`);
    }
  }
  if (!entry.stagedIdentity) {
    if (
      actual.staged
      || actual.backup
      || !promotionIdentitiesMatch(actual.target, entry.originalIdentity)
    ) promotionFail('An unchanged Project dependency artifact changed during promotion recovery.');
    return {
      ...actual,
      oldLocation: entry.originalIdentity ? 'target' : null,
      newLocation: null,
    };
  }

  const oldLocations = entry.originalIdentity
    ? (['target', 'backup'] as const).filter((location) => (
      promotionIdentitiesMatch(actual[location], entry.originalIdentity)
    ))
    : [];
  const newLocations = (['target', 'staged'] as const).filter((location) => (
    promotionIdentitiesMatch(actual[location], entry.stagedIdentity)
  ));
  if (
    oldLocations.length !== (entry.originalIdentity ? 1 : 0)
    || newLocations.length !== 1
    || (actual.backup && !entry.originalIdentity)
    || (oldLocations[0] === 'target' && newLocations[0] === 'target')
  ) promotionFail('Project dependency promotion has an ambiguous generation topology.');
  const newLocation = newLocations[0];
  if (!newLocation) promotionFail('Project dependency promotion lost its staged generation.');
  requirePromotionTreeDigest(paths[newLocation], entry.stagedTreeDigest, 'Project dependency staged generation');
  return {
    ...actual,
    oldLocation: oldLocations[0] || null,
    newLocation,
  };
}

function persistPromotionPhase(
  file: string,
  journal: ProjectLifecycleArtifactPromotionJournal,
  entry: ProjectLifecycleArtifactPromotionEntry,
  phase: PromotionEntryPhase,
): void {
  entry.phase = phase;
  writePromotionJournal(file, journal);
}

function verifyAllOldGeneration(
  journal: ProjectLifecycleArtifactPromotionJournal,
  allowCleanedStaging = false,
): void {
  assertPromotionRoots(journal, { allowMissingStaging: allowCleanedStaging });
  for (const entry of journal.entries) {
    const { target, staged, backup } = entryPaths(journal, entry);
    if (!promotionIdentitiesMatch(optionalPromotionIdentity(target), entry.originalIdentity)) {
      promotionFail('Project dependency promotion could not verify the prior live generation.');
    }
    if (optionalPromotionIdentity(backup)) {
      promotionFail('Project dependency promotion retained an unexpected backup after rollback.');
    }
    if (!allowCleanedStaging && entry.stagedIdentity
      && !promotionIdentitiesMatch(optionalPromotionIdentity(staged), entry.stagedIdentity)) {
      promotionFail('Project dependency promotion lost its staged generation before cleanup.');
    }
    if (!allowCleanedStaging && entry.stagedIdentity) {
      requirePromotionTreeDigest(staged, entry.stagedTreeDigest, 'Project dependency staged generation');
    }
  }
}

function verifyAllNewGeneration(
  journal: ProjectLifecycleArtifactPromotionJournal,
): void {
  assertPromotionRoots(journal, { allowMissingStaging: true });
  for (const entry of journal.entries) {
    const { target, staged, backup } = entryPaths(journal, entry);
    const expectedTarget = entry.stagedIdentity || entry.originalIdentity;
    if (!promotionIdentitiesMatch(optionalPromotionIdentity(target), expectedTarget)) {
      promotionFail('Project dependency promotion could not verify the committed live generation.');
    }
    if (entry.stagedIdentity) {
      requirePromotionTreeDigest(target, entry.stagedTreeDigest, 'Project dependency committed generation');
    }
    const stagedActual = optionalPromotionIdentity(staged);
    if (stagedActual && !promotionIdentitiesMatch(stagedActual, entry.stagedIdentity)) {
      promotionFail('Project dependency promotion staging contains an unknown identity.');
    }
    const backupActual = optionalPromotionIdentity(backup);
    if (backupActual && !promotionIdentitiesMatch(backupActual, entry.originalIdentity)) {
      promotionFail('Project dependency promotion backup contains an unknown identity.');
    }
  }
}

/**
 * Re-attest the all-new Project tree from the immutable database manifest.
 * This deliberately requires no filesystem journal or staging directory, so
 * an APPLIED receipt remains independently recoverable after cleanup crashes.
 */
export function verifyProjectDependencyPromotionManifestAllNew(
  manifest: ProjectDependencyPromotionManifest,
): void {
  const canonical = buildProjectDependencyPromotionManifest({
    schemaVersion: manifest.schemaVersion,
    operationId: manifest.operationId,
    workspaceOwnerId: manifest.workspaceOwnerId,
    projectName: manifest.projectName,
    projectIdentityId: manifest.projectIdentityId,
    projectIdentityGeneration: manifest.projectIdentityGeneration,
    projectRootBirthtimeNs: manifest.projectRootBirthtimeNs,
    operationParentCanonicalRoot: manifest.operationParentCanonicalRoot,
    operationParentIdentity: manifest.operationParentIdentity,
    destinationCanonicalRoot: manifest.destinationCanonicalRoot,
    destinationIdentity: manifest.destinationIdentity,
    stagingCanonicalRoot: manifest.stagingCanonicalRoot,
    stagingIdentity: manifest.stagingIdentity,
    entries: manifest.entries,
  });
  if (canonical.manifestDigest !== manifest.manifestDigest) {
    promotionFail('The durable Project dependency promotion manifest changed digest.');
  }
  verifyAllNewGeneration(projectLifecycleArtifactPromotionJournalFromManifest(canonical));
}

export type ProjectDependencyRepairCheckpoint =
  | `before-displace-target:${number}`
  | `after-displace-target:${number}`
  | `before-displace-backup:${number}`
  | `after-displace-backup:${number}`
  | `before-promote:${number}`
  | `after-promote:${number}`
  | 'after-all-new'
  | 'after-committed-journal'
  | 'after-promotion-evidence-cleanup';

export type ProjectDependencyRepairMovePhase =
  | 'PLANNED'
  | 'INTENT'
  | 'MOVED'
  | 'CLEANUP_INTENT'
  | 'CLEANED';
export type ProjectDependencyRepairMoveKind =
  | 'DISPLACE_TARGET'
  | 'DISPLACE_BACKUP'
  | 'PROMOTE_STAGED';

export interface ProjectDependencyRepairMovePlanStep {
  stepIndex: number;
  artifact: string;
  kind: ProjectDependencyRepairMoveKind;
  sourceCanonicalPath: string;
  destinationCanonicalPath: string;
  sourceIdentity: ProjectDependencyPromotionEntryIdentity;
  sourceTreeDigest: string;
  phase: ProjectDependencyRepairMovePhase;
}

export interface ProjectDependencyRepairMovePlan {
  schemaVersion: 1;
  operationId: string;
  manifestDigest: string;
  displacementCanonicalRoot: string;
  steps: ProjectDependencyRepairMovePlanStep[];
  planDigest: string;
}

export function projectDependencyRepairCleanupPlanDigest(
  plan: ProjectDependencyRepairMovePlan,
): string {
  const steps = plan.steps.map((step) => ({
    ...step,
    phase: step.kind === 'PROMOTE_STAGED' ? 'MOVED' : 'CLEANUP_INTENT',
  }));
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    operationId: plan.operationId,
    manifestDigest: plan.manifestDigest,
    displacementCanonicalRoot: plan.displacementCanonicalRoot,
    steps,
  }), 'utf8').digest('hex');
}

/** Full-tree proof immediately before SQL authorizes restartable deletion. */
export function attestProjectDependencyRepairCleanupBeforeGoBit(input: {
  manifest: ProjectDependencyPromotionManifest;
  displacementRoot: string;
  movePlan: ProjectDependencyRepairMovePlan;
}): string {
  const displacementRoot = requirePrivateRepairDisplacementRoot(
    input.displacementRoot,
    input.manifest,
  );
  assertRepairMovePlanShape(input.movePlan, input.manifest, displacementRoot);
  if (input.movePlan.steps.some((step) => step.phase !== 'MOVED')) {
    promotionFail('Dependency repair cleanup cannot be authorized after journal-only phase mutation.');
  }
  const planned = input.movePlan.steps.filter((step) => step.kind !== 'PROMOTE_STAGED');
  const expectedNames = planned.map((step) => path.basename(step.destinationCanonicalPath)).sort();
  const actualNames = fs.readdirSync(displacementRoot).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    promotionFail('Dependency repair displacement inventory changed before cleanup authorization.');
  }
  for (const step of planned) {
    if (!attestRepairMoveEndpoint(
      step.destinationCanonicalPath,
      step.sourceIdentity,
      step.sourceTreeDigest,
    )) promotionFail('Dependency repair displacement changed before cleanup authorization.');
  }
  return projectDependencyRepairCleanupPlanDigest(input.movePlan);
}

function immutableRepairMovePlan(plan: Omit<ProjectDependencyRepairMovePlan, 'planDigest'>) {
  return {
    schemaVersion: plan.schemaVersion,
    operationId: plan.operationId,
    manifestDigest: plan.manifestDigest,
    displacementCanonicalRoot: plan.displacementCanonicalRoot,
    steps: plan.steps.map(({ phase: _phase, ...step }) => step),
  };
}

function repairMovePlanDigest(plan: Omit<ProjectDependencyRepairMovePlan, 'planDigest'>): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(immutableRepairMovePlan(plan)), 'utf8')
    .digest('hex');
}

function assertRepairMovePlanShape(
  plan: ProjectDependencyRepairMovePlan,
  manifest: ProjectDependencyPromotionManifest,
  displacementRoot: string,
): void {
  if (plan.schemaVersion !== 1
    || plan.operationId !== manifest.operationId
    || plan.manifestDigest !== manifest.manifestDigest
    || plan.displacementCanonicalRoot !== displacementRoot
    || !Array.isArray(plan.steps)
    || plan.steps.length > manifest.entries.length * 3
    || plan.planDigest !== repairMovePlanDigest(plan)
    || new Set(plan.steps.map((step) => step.stepIndex)).size !== plan.steps.length) {
    promotionFail('The dependency repair displacement plan is malformed or changed digest.');
  }
  const entries = new Map(manifest.entries.map((entry) => [entry.artifact, entry]));
  for (const [index, step] of plan.steps.entries()) {
    const entry = entries.get(step.artifact);
    const target = path.join(manifest.destinationCanonicalRoot, step.artifact);
    const staged = path.join(manifest.stagingCanonicalRoot, `artifacts/${step.artifact}`);
    const backup = path.join(manifest.stagingCanonicalRoot, `backups/${step.artifact}`);
    const displacedTarget = path.join(displacementRoot, `${step.artifact}.target`);
    const displacedBackup = path.join(displacementRoot, `${step.artifact}.backup`);
    const pathsMatch = step.kind === 'DISPLACE_TARGET'
      ? step.sourceCanonicalPath === target && step.destinationCanonicalPath === displacedTarget
      : step.kind === 'DISPLACE_BACKUP'
        ? step.sourceCanonicalPath === backup && step.destinationCanonicalPath === displacedBackup
        : step.sourceCanonicalPath === staged && step.destinationCanonicalPath === target;
    if (!entry || !entry.stagedIdentity
      || step.stepIndex !== index
      || !pathsMatch
      || !promotionIdentitiesMatch(step.sourceIdentity, step.kind === 'PROMOTE_STAGED'
        ? entry.stagedIdentity
        : step.sourceIdentity)
      || !/^[a-f0-9]{64}$/.test(step.sourceTreeDigest)
      || !['PLANNED', 'INTENT', 'MOVED', 'CLEANUP_INTENT', 'CLEANED'].includes(step.phase)
      || ((step.phase === 'CLEANUP_INTENT' || step.phase === 'CLEANED')
        && step.kind === 'PROMOTE_STAGED')) {
      promotionFail('The dependency repair displacement plan contains an unsafe step.');
    }
    if (path.dirname(step.destinationCanonicalPath) !== (
      step.kind === 'PROMOTE_STAGED' ? manifest.destinationCanonicalRoot : displacementRoot
    )) promotionFail('A dependency repair move escapes its exact destination root.');
  }
}

/**
 * Capture the complete immutable move provenance while the Project is still
 * quarantined and all tracked writers are quiescent. Every later rename must
 * consume one of these exact source inode/tree records.
 */
export function buildProjectDependencyForceForwardMovePlan(input: {
  manifest: ProjectDependencyPromotionManifest;
  displacementRoot: string;
}): ProjectDependencyRepairMovePlan {
  const { journal } = requireExactPromotionJournalForManifest(input.manifest);
  const displacementRoot = requirePrivateRepairDisplacementRoot(
    input.displacementRoot,
    input.manifest,
  );
  if (fs.readdirSync(displacementRoot).length !== 0) {
    promotionFail('A new dependency repair displacement root is not empty.');
  }
  assertPromotionRoots(journal);
  const steps: ProjectDependencyRepairMovePlanStep[] = [];
  const addStep = (
    artifact: string,
    kind: ProjectDependencyRepairMoveKind,
    sourceCanonicalPath: string,
    destinationCanonicalPath: string,
    sourceIdentity: ProjectDependencyPromotionEntryIdentity,
    sourceTreeDigest: string,
  ) => {
    // Displacement destinations must be empty at plan capture. A staged
    // promotion destination may still hold the old/unknown live artifact;
    // its preceding DISPLACE_TARGET step is what durably makes that pathname
    // empty before renameat2(RENAME_NOREPLACE) consumes the staged inode.
    if (kind !== 'PROMOTE_STAGED' && optionalPromotionIdentity(destinationCanonicalPath)) {
      promotionFail('Dependency repair displacement evidence already occupies a planned path.');
    }
    steps.push({
      stepIndex: steps.length,
      artifact,
      kind,
      sourceCanonicalPath,
      destinationCanonicalPath,
      sourceIdentity,
      sourceTreeDigest,
      phase: 'PLANNED',
    });
  };
  for (const entry of journal.entries) {
    const paths = entryPaths(journal, entry);
    const target = optionalPromotionIdentity(paths.target);
    const staged = optionalPromotionIdentity(paths.staged);
    const backup = optionalPromotionIdentity(paths.backup);
    if (!entry.stagedIdentity) {
      if (!promotionIdentitiesMatch(target, entry.originalIdentity) || staged || backup) {
        promotionFail('An unchanged dependency artifact cannot be reconstructed from staged evidence.');
      }
      continue;
    }
    const targetIsNew = promotionIdentitiesMatch(target, entry.stagedIdentity);
    if (targetIsNew) {
      requirePromotionTreeDigest(paths.target, entry.stagedTreeDigest, 'Dependency repair committed generation');
    } else {
      if (!promotionIdentitiesMatch(staged, entry.stagedIdentity)) {
        promotionFail('The exact staged dependency generation is unavailable for force-forward repair.');
      }
      requirePromotionTreeDigest(paths.staged, entry.stagedTreeDigest, 'Dependency repair staged generation');
      if (target) {
        addStep(
          entry.artifact,
          'DISPLACE_TARGET',
          paths.target,
          path.join(displacementRoot, `${entry.artifact}.target`),
          target,
          promotionTreeDigest(paths.target),
        );
      }
    }
    if (backup) {
      addStep(
        entry.artifact,
        'DISPLACE_BACKUP',
        paths.backup,
        path.join(displacementRoot, `${entry.artifact}.backup`),
        backup,
        promotionTreeDigest(paths.backup),
      );
    }
    if (!targetIsNew) {
      addStep(
        entry.artifact,
        'PROMOTE_STAGED',
        paths.staged,
        paths.target,
        entry.stagedIdentity,
        entry.stagedTreeDigest!,
      );
    }
  }
  const withoutDigest = {
    schemaVersion: 1 as const,
    operationId: input.manifest.operationId,
    manifestDigest: input.manifest.manifestDigest,
    displacementCanonicalRoot: displacementRoot,
    steps,
  };
  return { ...withoutDigest, planDigest: repairMovePlanDigest(withoutDigest) };
}

export function attestProjectDependencyForceForwardMovePlanBeforeGoBit(input: {
  manifest: ProjectDependencyPromotionManifest;
  plan: ProjectDependencyRepairMovePlan;
}): void {
  assertRepairMovePlanShape(input.plan, input.manifest, input.plan.displacementCanonicalRoot);
  if (input.plan.steps.some((step) => step.phase !== 'PLANNED')) {
    promotionFail('A pre-go-bit dependency repair plan already contains move progress.');
  }
  const fresh = buildProjectDependencyForceForwardMovePlan({
    manifest: input.manifest,
    displacementRoot: input.plan.displacementCanonicalRoot,
  });
  if (fresh.planDigest !== input.plan.planDigest
    || JSON.stringify(immutableRepairMovePlan(fresh)) !== JSON.stringify(immutableRepairMovePlan(input.plan))) {
    promotionFail('Dependency repair move provenance changed before its durable go-bit.');
  }
}

function renameNoReplace(source: string, destination: string): void {
  const script = [
    'import ctypes, os, sys',
    'libc = ctypes.CDLL(None, use_errno=True)',
    'fn = libc.renameat2',
    'fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]',
    'fn.restype = ctypes.c_int',
    'rc = fn(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 1)',
    'err = ctypes.get_errno()',
    'if rc:',
    '    raise OSError(err, os.strerror(err))',
  ].join('\n');
  try {
    execFileSync('/usr/bin/python3', ['-c', script, source, destination], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
  } catch {
    promotionFail('Dependency repair no-replace rename was refused.');
  }
}

function attestRepairMoveEndpoint(
  candidate: string,
  expectedIdentity: ProjectDependencyPromotionEntryIdentity,
  expectedTreeDigest: string,
): boolean {
  const actual = optionalPromotionIdentity(candidate);
  if (!promotionIdentitiesMatch(actual, expectedIdentity)) return false;
  requirePromotionTreeDigest(candidate, expectedTreeDigest, 'Dependency repair move endpoint');
  return true;
}

function convergeRepairMoveStep(input: {
  step: ProjectDependencyRepairMovePlanStep;
  sourceReplacement?: ProjectDependencyRepairMovePlanStep;
  persistPhase(phase: ProjectDependencyRepairMovePhase): void;
  checkpoint?: (checkpoint: ProjectDependencyRepairCheckpoint) => void;
  artifactIndex: number;
}): void {
  const { step } = input;
  const beforeCheckpoint = step.kind === 'DISPLACE_TARGET'
    ? `before-displace-target:${input.artifactIndex}` as const
    : step.kind === 'DISPLACE_BACKUP'
      ? `before-displace-backup:${input.artifactIndex}` as const
      : `before-promote:${input.artifactIndex}` as const;
  const afterCheckpoint = step.kind === 'DISPLACE_TARGET'
    ? `after-displace-target:${input.artifactIndex}` as const
    : step.kind === 'DISPLACE_BACKUP'
      ? `after-displace-backup:${input.artifactIndex}` as const
      : `after-promote:${input.artifactIndex}` as const;
  if (step.phase === 'PLANNED') input.persistPhase('INTENT');
  if (step.phase === 'INTENT') {
    const sourcePresent = attestRepairMoveEndpoint(
      step.sourceCanonicalPath,
      step.sourceIdentity,
      step.sourceTreeDigest,
    );
    const destinationIdentity = optionalPromotionIdentity(step.destinationCanonicalPath);
    if (sourcePresent && !destinationIdentity) {
      input.checkpoint?.(beforeCheckpoint);
      renameNoReplace(step.sourceCanonicalPath, step.destinationCanonicalPath);
      fsyncPromotionDirectory(path.dirname(step.sourceCanonicalPath));
      fsyncPromotionDirectory(path.dirname(step.destinationCanonicalPath));
      input.checkpoint?.(afterCheckpoint);
    } else if (sourcePresent || !attestRepairMoveEndpoint(
      step.destinationCanonicalPath,
      step.sourceIdentity,
      step.sourceTreeDigest,
    )) {
      promotionFail('Dependency repair move topology does not match its durable intent.');
    }
    input.persistPhase('MOVED');
  }
  const sourceIdentity = optionalPromotionIdentity(step.sourceCanonicalPath);
  const sourceWasRepopulatedByExactReplacement = Boolean(
    sourceIdentity
    && input.sourceReplacement
    && input.sourceReplacement.destinationCanonicalPath === step.sourceCanonicalPath
    && !optionalPromotionIdentity(input.sourceReplacement.sourceCanonicalPath)
    && attestRepairMoveEndpoint(
      step.sourceCanonicalPath,
      input.sourceReplacement.sourceIdentity,
      input.sourceReplacement.sourceTreeDigest,
    ),
  );
  if (step.phase !== 'MOVED'
    || (sourceIdentity && !sourceWasRepopulatedByExactReplacement)
    || !attestRepairMoveEndpoint(
      step.destinationCanonicalPath,
      step.sourceIdentity,
      step.sourceTreeDigest,
    )) {
    promotionFail('Dependency repair move did not converge to its exact recorded destination.');
  }
}

function requireExactPromotionJournalForManifest(
  manifest: ProjectDependencyPromotionManifest,
): { file: string; journal: ProjectLifecycleArtifactPromotionJournal } {
  const canonical = buildProjectDependencyPromotionManifest({
    schemaVersion: manifest.schemaVersion,
    operationId: manifest.operationId,
    workspaceOwnerId: manifest.workspaceOwnerId,
    projectName: manifest.projectName,
    projectIdentityId: manifest.projectIdentityId,
    projectIdentityGeneration: manifest.projectIdentityGeneration,
    projectRootBirthtimeNs: manifest.projectRootBirthtimeNs,
    operationParentCanonicalRoot: manifest.operationParentCanonicalRoot,
    operationParentIdentity: manifest.operationParentIdentity,
    destinationCanonicalRoot: manifest.destinationCanonicalRoot,
    destinationIdentity: manifest.destinationIdentity,
    stagingCanonicalRoot: manifest.stagingCanonicalRoot,
    stagingIdentity: manifest.stagingIdentity,
    entries: manifest.entries,
  });
  if (canonical.manifestDigest !== manifest.manifestDigest) {
    promotionFail('The quarantined dependency manifest changed before repair.');
  }
  const file = promotionJournalFile(canonical.operationParentCanonicalRoot, canonical.operationId);
  const journal = readPromotionJournal(file);
  const journalManifest = projectLifecycleArtifactPromotionManifest(journal);
  if (JSON.stringify(journalManifest) !== JSON.stringify(canonical)) {
    promotionFail('The quarantined dependency journal conflicts with its durable manifest.');
  }
  return { file, journal };
}

function requirePrivateRepairDisplacementRoot(
  displacementRootInput: string,
  manifest: ProjectDependencyPromotionManifest,
): string {
  const displacementRoot = path.resolve(displacementRootInput);
  if (
    displacementRoot !== displacementRootInput
    || path.dirname(displacementRoot) !== manifest.operationParentCanonicalRoot
    || !path.basename(displacementRoot).startsWith('.bridgesllm-project-repair-')
  ) promotionFail('The dependency repair displacement root is outside the exact owner filesystem.');
  const identity = promotionIdentity(displacementRoot);
  if (
    identity.kind !== 'directory'
    || identity.device !== manifest.operationParentIdentity.device
    || identity.uid !== currentOwnerUid()
    || identity.gid !== currentOwnerGid()
    || identity.mode !== 0o700
  ) promotionFail('The dependency repair displacement root is not private and same-filesystem.');
  return displacementRoot;
}

/** Pre-go-bit proof that every changed artifact still has one exact staged copy. */
export function attestQuarantinedProjectDependencyPromotionRepairable(
  manifest: ProjectDependencyPromotionManifest,
): void {
  const { journal } = requireExactPromotionJournalForManifest(manifest);
  assertPromotionRoots(journal);
  for (const entry of journal.entries) {
    const paths = entryPaths(journal, entry);
    const target = optionalPromotionIdentity(paths.target);
    const staged = optionalPromotionIdentity(paths.staged);
    const backup = optionalPromotionIdentity(paths.backup);
    if (!entry.stagedIdentity) {
      if (!promotionIdentitiesMatch(target, entry.originalIdentity) || staged || backup) {
        promotionFail('An unchanged dependency artifact cannot be reconstructed from staged evidence.');
      }
      continue;
    }
    if (promotionIdentitiesMatch(target, entry.stagedIdentity)) {
      requirePromotionTreeDigest(paths.target, entry.stagedTreeDigest, 'Dependency repair committed generation');
      continue;
    }
    if (!promotionIdentitiesMatch(staged, entry.stagedIdentity)) {
      promotionFail('The exact staged dependency generation is unavailable for force-forward repair.');
    }
    requirePromotionTreeDigest(paths.staged, entry.stagedTreeDigest, 'Dependency repair staged generation');
  }
}

/**
 * Converge one quarantined operation only toward the exact staged generation.
 * Unknown live or backup roots are moved into private same-filesystem evidence;
 * they are never overwritten and this path has no preserve-current rollback.
 */
export function forceForwardQuarantinedProjectDependencyPromotion(input: {
  manifest: ProjectDependencyPromotionManifest;
  displacementRoot: string;
  movePlan: ProjectDependencyRepairMovePlan;
  persistMovePlan(plan: ProjectDependencyRepairMovePlan): void;
  checkpoint?: (checkpoint: ProjectDependencyRepairCheckpoint) => void;
}): void {
  const { file, journal } = requireExactPromotionJournalForManifest(input.manifest);
  const displacementRoot = requirePrivateRepairDisplacementRoot(
    input.displacementRoot,
    input.manifest,
  );
  assertPromotionRoots(journal);
  assertRepairMovePlanShape(input.movePlan, input.manifest, displacementRoot);
  const stepsByArtifact = new Map<string, ProjectDependencyRepairMovePlanStep[]>();
  for (const step of input.movePlan.steps) {
    const bucket = stepsByArtifact.get(step.artifact) || [];
    bucket.push(step);
    stepsByArtifact.set(step.artifact, bucket);
  }

  for (const [index, entry] of journal.entries.entries()) {
    const paths = entryPaths(journal, entry);
    let target = optionalPromotionIdentity(paths.target);
    let staged = optionalPromotionIdentity(paths.staged);
    let backup = optionalPromotionIdentity(paths.backup);

    if (!entry.stagedIdentity) {
      if (!promotionIdentitiesMatch(target, entry.originalIdentity) || staged || backup) {
        promotionFail('An unchanged dependency artifact cannot be reconstructed from staged evidence.');
      }
      continue;
    }

    const steps = stepsByArtifact.get(entry.artifact) || [];
    const targetIsNew = promotionIdentitiesMatch(target, entry.stagedIdentity);
    if (targetIsNew) {
      requirePromotionTreeDigest(paths.target, entry.stagedTreeDigest, 'Dependency repair committed generation');
    } else {
      if (!promotionIdentitiesMatch(staged, entry.stagedIdentity)) {
        promotionFail('The exact staged dependency generation is unavailable for force-forward repair.');
      }
      requirePromotionTreeDigest(paths.staged, entry.stagedTreeDigest, 'Dependency repair staged generation');
    }
    for (const step of steps) {
      const sourceReplacement = steps.find((candidate) => (
        candidate.kind === 'PROMOTE_STAGED'
        && candidate.destinationCanonicalPath === step.sourceCanonicalPath
      ));
      convergeRepairMoveStep({
        step,
        sourceReplacement,
        artifactIndex: index,
        checkpoint: input.checkpoint,
        persistPhase: (phase) => {
          step.phase = phase;
          input.persistMovePlan(input.movePlan);
        },
      });
    }

    target = optionalPromotionIdentity(paths.target);
    staged = optionalPromotionIdentity(paths.staged);
    backup = optionalPromotionIdentity(paths.backup);
    if (!promotionIdentitiesMatch(target, entry.stagedIdentity) || staged || backup) {
      promotionFail('Dependency repair did not converge the exact artifact to all-new.');
    }
    requirePromotionTreeDigest(paths.target, entry.stagedTreeDigest, 'Dependency repair committed generation');
  }

  if (input.movePlan.steps.some((step) => step.phase !== 'MOVED')) {
    promotionFail('Dependency repair did not consume every durable move intent.');
  }

  verifyProjectDependencyPromotionManifestAllNew(input.manifest);
  input.checkpoint?.('after-all-new');
  const committedJournal: ProjectLifecycleArtifactPromotionJournal = {
    ...journal,
    entries: journal.entries.map((entry) => ({ ...entry })),
    state: 'COMMITTED',
  };
  writePromotionJournal(file, committedJournal);
  input.checkpoint?.('after-committed-journal');
}

/**
 * Re-attest every displaced inode/content tree and its mount topology, then
 * remove only the exact destinations named by the immutable move plan.
 */
export function cleanupProjectDependencyRepairDisplacement(input: {
  manifest: ProjectDependencyPromotionManifest;
  displacementRoot: string;
  movePlan: ProjectDependencyRepairMovePlan;
  persistMovePlan(plan: ProjectDependencyRepairMovePlan): void;
}): void {
  if (!fs.existsSync(input.displacementRoot)) {
    const displacements = input.movePlan.steps.filter((step) => step.kind !== 'PROMOTE_STAGED');
    if (displacements.some((step) => step.phase !== 'CLEANUP_INTENT' && step.phase !== 'CLEANED')) {
      promotionFail('Dependency repair displacement root disappeared before cleanup intent.');
    }
    for (const step of displacements) {
      if (step.phase === 'CLEANUP_INTENT') {
        step.phase = 'CLEANED';
        input.persistMovePlan(input.movePlan);
      }
    }
    return;
  }
  const displacementRoot = requirePrivateRepairDisplacementRoot(
    input.displacementRoot,
    input.manifest,
  );
  assertRepairMovePlanShape(input.movePlan, input.manifest, displacementRoot);
  const planned = input.movePlan.steps.filter((step) => (
    step.kind === 'DISPLACE_TARGET' || step.kind === 'DISPLACE_BACKUP'
  ));
  if (input.movePlan.steps.some((step) => (
    step.kind === 'PROMOTE_STAGED'
      ? step.phase !== 'MOVED'
      : !['MOVED', 'CLEANUP_INTENT', 'CLEANED'].includes(step.phase)
  ))) {
    promotionFail('Dependency repair displacement cleanup saw an incomplete move plan.');
  }
  const expectedNames = planned
    .map((step) => path.basename(step.destinationCanonicalPath))
    .sort();
  const actualNames = fs.readdirSync(displacementRoot).sort();
  if (actualNames.some((name) => !expectedNames.includes(name))) {
    promotionFail('Dependency repair displacement inventory changed before cleanup.');
  }
  for (const step of planned) {
    if (!actualNames.includes(path.basename(step.destinationCanonicalPath))) continue;
    if (step.phase === 'CLEANED') {
      promotionFail('Cleaned dependency repair evidence reappeared.');
    }
    const current = optionalPromotionIdentity(step.destinationCanonicalPath);
    if (path.dirname(step.destinationCanonicalPath) !== displacementRoot
      || !promotionIdentitiesMatch(current, step.sourceIdentity)
      || (step.phase === 'MOVED' && !attestRepairMoveEndpoint(
        step.destinationCanonicalPath,
        step.sourceIdentity,
        step.sourceTreeDigest,
      ))) {
      promotionFail('Dependency repair displacement provenance changed before cleanup.');
    }
  }
  // Recheck mount inventory and recursive content immediately before each
  // deletion. The global writer fence and exact Project lock exclude tracked
  // writers while renameat2 no-replace provenance excludes path substitution.
  for (const step of [...planned].reverse()) {
    if (step.phase === 'CLEANED') continue;
    if (step.phase === 'MOVED') {
      if (!attestRepairMoveEndpoint(
        step.destinationCanonicalPath,
        step.sourceIdentity,
        step.sourceTreeDigest,
      )) promotionFail('Dependency repair displacement changed before cleanup intent.');
      step.phase = 'CLEANUP_INTENT';
      input.persistMovePlan(input.movePlan);
    }
    if (fs.existsSync(step.destinationCanonicalPath)) {
      const current = promotionIdentity(step.destinationCanonicalPath);
      if (!promotionIdentitiesMatch(current, step.sourceIdentity)) {
        promotionFail('Dependency repair cleanup root changed exact inode identity.');
      }
      const boundaries = descendantMountBoundaries(step.destinationCanonicalPath);
      if (boundaries.length > 0) {
        promotionFail('Dependency repair cleanup root crosses a mount or bind-mount boundary.');
      }
      // CLEANUP_INTENT makes a partial recursive deletion restartable. rmSync
      // never follows symlinks; the exact top inode and mount inventory are
      // re-attested on every resume while the writer fence remains held.
      fs.rmSync(step.destinationCanonicalPath, { recursive: true, force: false });
    }
    fsyncPromotionDirectory(displacementRoot);
    step.phase = 'CLEANED';
    input.persistMovePlan(input.movePlan);
  }
  if (fs.readdirSync(displacementRoot).length !== 0) {
    promotionFail('Dependency repair displacement root is not empty after cleanup.');
  }
  fs.rmdirSync(displacementRoot);
  fsyncPromotionDirectory(path.dirname(displacementRoot));
}

/** Remove only the original operation evidence after all-new is re-attested. */
export async function cleanupForceForwardedProjectDependencyPromotion(input: {
  manifest: ProjectDependencyPromotionManifest;
  checkpoint?: (checkpoint: ProjectDependencyRepairCheckpoint) => void;
}): Promise<void> {
  verifyProjectDependencyPromotionManifestAllNew(input.manifest);
  const file = promotionJournalFile(input.manifest.operationParentCanonicalRoot, input.manifest.operationId);
  if (!fs.existsSync(file) && !fs.existsSync(input.manifest.stagingCanonicalRoot)) return;
  const exact = requireExactPromotionJournalForManifest(input.manifest);
  if (exact.journal.state !== 'COMMITTED') {
    promotionFail('Dependency repair evidence cannot be cleaned before its committed journal.');
  }
  await removePromotionEvidence(exact.file, exact.journal);
  input.checkpoint?.('after-promotion-evidence-cleanup');
}

/**
 * Record that preparation was abandoned before any live rename. Child
 * artifacts may have changed externally, so this deliberately verifies only
 * the server-private staged generation and absence of backups. The durable
 * ABANDONED state lets startup finish cleanup without interpreting unknown
 * live bytes as either the old or new generation.
 */
function abandonPreparedPromotion(
  file: string,
  journal: ProjectLifecycleArtifactPromotionJournal,
): void {
  if (journal.state === 'ABANDONED') return;
  if (journal.state !== 'PREPARED') {
    promotionFail('Only a predecision Project dependency preparation can be abandoned.');
  }
  assertPromotionRoots(journal);
  for (const entry of journal.entries) {
    const { staged, backup } = entryPaths(journal, entry);
    if (entry.stagedIdentity
      && !promotionIdentitiesMatch(optionalPromotionIdentity(staged), entry.stagedIdentity)) {
      promotionFail('Abandoned Project dependency staging lost its prepared generation.');
    }
    if (optionalPromotionIdentity(backup)) {
      promotionFail('Abandoned Project dependency staging unexpectedly contains a backup.');
    }
  }
  journal.state = 'ABANDONED';
  writePromotionJournal(file, journal);
}

/**
 * Idempotently realize the durable database decision. Each rename is inferred
 * from exact inode topology, so retrying after a crash or one failed fsync can
 * only continue toward all-new; this path never restores the old generation.
 */
function convergePromotionJournalToAllNew(
  file: string,
  journal: ProjectLifecycleArtifactPromotionJournal,
  testCheckpoint?: (checkpoint: ProjectLifecycleArtifactPromotionCheckpoint) => void,
): void {
  assertPromotionRoots(journal);
  if (journal.state !== 'COMMITTED') {
    journal.state = 'COMMITTING';
    writePromotionJournal(file, journal);
  }
  for (const [index, entry] of journal.entries.entries()) {
    if (!entry.stagedIdentity) {
      identifyEntryTopology(journal, entry);
      continue;
    }
    let topology = identifyEntryTopology(journal, entry);
    const paths = entryPaths(journal, entry);
    if (entry.originalIdentity && topology.oldLocation === 'target') {
      if (topology.newLocation !== 'staged' || topology.backup) {
        promotionFail('Project dependency promotion did not retain a safe old/new topology.');
      }
      fs.renameSync(paths.target, paths.backup);
      fsyncPromotionDirectory(journal.destinationCanonicalRoot);
      fsyncPromotionDirectory(path.dirname(paths.backup));
      testCheckpoint?.(`after-backup:${index}`);
      persistPromotionPhase(file, journal, entry, 'BACKED_UP');
      topology = identifyEntryTopology(journal, entry);
    }
    if (topology.newLocation === 'staged') {
      if (
        topology.target
        || topology.oldLocation !== (entry.originalIdentity ? 'backup' : null)
      ) promotionFail('Project dependency promotion cannot publish over an unknown target.');
      fs.renameSync(paths.staged, paths.target);
      fsyncPromotionDirectory(path.dirname(paths.staged));
      fsyncPromotionDirectory(journal.destinationCanonicalRoot);
      testCheckpoint?.(`after-promote:${index}`);
      persistPromotionPhase(file, journal, entry, 'PROMOTED');
      topology = identifyEntryTopology(journal, entry);
    }
    if (
      topology.newLocation !== 'target'
      || topology.oldLocation !== (entry.originalIdentity ? 'backup' : null)
    ) promotionFail('Project dependency promotion did not converge to the new generation.');
  }
  verifyAllNewGeneration(journal);
  if (journal.state !== 'COMMITTED') {
    journal.state = 'SWAPPED';
    writePromotionJournal(file, journal);
    testCheckpoint?.('after-swapped');
  }
}

function rollbackPromotionJournal(
  file: string,
  journal: ProjectLifecycleArtifactPromotionJournal,
): void {
  if (journal.state === 'COMMITTED') {
    promotionFail('A committed Project dependency promotion cannot be rolled back.');
  }
  assertPromotionRoots(journal);
  journal.state = 'ROLLING_BACK';
  writePromotionJournal(file, journal);
  for (const entry of [...journal.entries].reverse()) {
    if (!entry.stagedIdentity) continue;
    let topology = identifyEntryTopology(journal, entry);
    const paths = entryPaths(journal, entry);
    if (topology.newLocation === 'target') {
      if (topology.staged) promotionFail('Project dependency rollback staging path is already occupied.');
      fs.renameSync(paths.target, paths.staged);
      fsyncPromotionDirectory(journal.destinationCanonicalRoot);
      fsyncPromotionDirectory(path.dirname(paths.staged));
      persistPromotionPhase(file, journal, entry, 'NEW_RESTAGED');
      topology = identifyEntryTopology(journal, entry);
    }
    if (topology.oldLocation === 'backup') {
      if (topology.target) promotionFail('Project dependency rollback target is already occupied.');
      fs.renameSync(paths.backup, paths.target);
      fsyncPromotionDirectory(path.dirname(paths.backup));
      fsyncPromotionDirectory(journal.destinationCanonicalRoot);
      persistPromotionPhase(file, journal, entry, 'RESTORED');
      topology = identifyEntryTopology(journal, entry);
    }
    if (
      topology.newLocation !== 'staged'
      || topology.oldLocation !== (entry.originalIdentity ? 'target' : null)
    ) promotionFail('Project dependency rollback did not converge to the prior generation.');
    persistPromotionPhase(file, journal, entry, 'RESTORED');
  }
  verifyAllOldGeneration(journal);
  journal.state = 'ROLLED_BACK';
  writePromotionJournal(file, journal);
}

async function removePromotionEvidence(
  file: string,
  journal: ProjectLifecycleArtifactPromotionJournal,
  testCheckpoint?: (checkpoint: ProjectLifecycleArtifactPromotionCheckpoint) => void,
): Promise<void> {
  if (journal.state === 'COMMITTED') verifyAllNewGeneration(journal);
  else if (journal.state === 'ROLLED_BACK') verifyAllOldGeneration(journal, true);
  else if (journal.state === 'ABANDONED') {
    assertPromotionRoots(journal);
    for (const entry of journal.entries) {
      const { staged, backup } = entryPaths(journal, entry);
      if (entry.stagedIdentity
        && !promotionIdentitiesMatch(optionalPromotionIdentity(staged), entry.stagedIdentity)) {
        promotionFail('Abandoned Project dependency staging changed before cleanup.');
      }
      if (optionalPromotionIdentity(backup)) {
        promotionFail('Abandoned Project dependency staging contains an unexpected backup.');
      }
    }
  }
  else promotionFail('Project dependency promotion evidence cannot be removed before convergence.');

  await fs.promises.rm(journal.stagingCanonicalRoot, { recursive: true, force: true });
  fsyncPromotionDirectory(journal.operationParentCanonicalRoot);
  testCheckpoint?.('after-staging-cleanup');
  // Retire operation-scoped write temporaries while the final COMMITTED or
  // ROLLED_BACK journal still proves how to recover. A crash must never leave
  // only an unparseable temporary after the authoritative journal is gone.
  for (const candidate of fs.readdirSync(journal.operationParentCanonicalRoot)) {
    const temporaryOperationId = promotionJournalTemporaryOperationId(candidate);
    if (!temporaryOperationId || temporaryOperationId !== journal.operationId) continue;
    const temporary = path.join(journal.operationParentCanonicalRoot, candidate);
    assertPrivatePromotionTemporaryFile(
      temporary,
      'Project dependency promotion temporary journal',
    );
    fs.unlinkSync(temporary);
  }
  fsyncPromotionDirectory(journal.operationParentCanonicalRoot);
  try {
    fs.unlinkSync(file);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  fsyncPromotionDirectory(journal.operationParentCanonicalRoot);
  testCheckpoint?.('after-journal-cleanup');
}

async function removePreparedPromotionPrivateEvidence(
  file: string,
  journal: ProjectLifecycleArtifactPromotionJournal,
  testCheckpoint?: (checkpoint: ProjectLifecycleArtifactPromotionCheckpoint) => void,
): Promise<void> {
  if (journal.state !== 'PREPARED' && journal.state !== 'ABANDONED') {
    promotionFail('Only predecision Project dependency evidence can use staging-only cleanup.');
  }
  requirePromotionIdentity(
    journal.operationParentCanonicalRoot,
    journal.operationParentIdentity,
    'Project dependency promotion parent',
  );
  const stagingPresent = optionalPromotionIdentity(journal.stagingCanonicalRoot);
  const journalPresent = optionalPromotionIdentity(file);
  if (!stagingPresent || !journalPresent) {
    if (stagingPresent || journalPresent) {
      promotionFail('Prepared Project dependency evidence is only partially absent.');
    }
    // A queued, already-admitted mutation may have acquired the guarded lock
    // first and completed the same PREPARED cleanup. Exact absence is
    // idempotent success; remove only operation-bound private temporaries.
    for (const candidate of fs.readdirSync(journal.operationParentCanonicalRoot)) {
      const temporaryOperationId = promotionJournalTemporaryOperationId(candidate);
      if (!temporaryOperationId || temporaryOperationId !== journal.operationId) continue;
      const temporary = path.join(journal.operationParentCanonicalRoot, candidate);
      assertPrivatePromotionTemporaryFile(
        temporary,
        'Project dependency promotion temporary journal',
      );
      fs.unlinkSync(temporary);
    }
    fsyncPromotionDirectory(journal.operationParentCanonicalRoot);
    return;
  }
  assertPrivatePromotionStagingRoot(journal.stagingCanonicalRoot, journal.stagingIdentity);
  for (const entry of journal.entries) {
    const { staged, backup } = entryPaths(journal, entry);
    if (
      entry.stagedIdentity
      && !promotionIdentitiesMatch(optionalPromotionIdentity(staged), entry.stagedIdentity)
    ) {
      promotionFail('Prepared Project dependency staging changed before private cleanup.');
    }
    if (optionalPromotionIdentity(backup)) {
      promotionFail('Prepared Project dependency staging unexpectedly contains a live backup.');
    }
  }
  await fs.promises.rm(journal.stagingCanonicalRoot, { recursive: true, force: true });
  fsyncPromotionDirectory(journal.operationParentCanonicalRoot);
  testCheckpoint?.('after-staging-cleanup');
  for (const candidate of fs.readdirSync(journal.operationParentCanonicalRoot)) {
    const temporaryOperationId = promotionJournalTemporaryOperationId(candidate);
    if (!temporaryOperationId || temporaryOperationId !== journal.operationId) continue;
    const temporary = path.join(journal.operationParentCanonicalRoot, candidate);
    assertPrivatePromotionTemporaryFile(
      temporary,
      'Project dependency promotion temporary journal',
    );
    fs.unlinkSync(temporary);
  }
  fsyncPromotionDirectory(journal.operationParentCanonicalRoot);
  try {
    fs.unlinkSync(file);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  fsyncPromotionDirectory(journal.operationParentCanonicalRoot);
  testCheckpoint?.('after-journal-cleanup');
}

function assertPrivatePromotionStagingRoot(
  stagingRoot: string,
  expectedIdentity?: PromotionEntryIdentity,
): PromotionEntryIdentity {
  const identity = promotionIdentity(stagingRoot);
  if (identity.kind !== 'directory'
    || identity.uid !== currentOwnerUid()
    || identity.gid !== currentOwnerGid()
    || identity.mode !== 0o700
    || (expectedIdentity && !promotionIdentitiesMatch(identity, expectedIdentity))) {
    promotionFail('Unjournaled Project dependency staging root is not a private server-owned directory.');
  }
  return identity;
}

function verifyPreparedUnjournaledPromotionIsAllOld(
  preparation: ProjectLifecycleArtifactPromotionPreparation,
): void {
  requirePromotionIdentity(
    preparation.operationParentCanonicalRoot,
    preparation.operationParentIdentity,
    'Project dependency preparation parent',
  );
  requirePromotionIdentity(
    preparation.destinationCanonicalRoot,
    preparation.destinationIdentity,
    'Project dependency preparation destination',
  );
  assertPrivatePromotionStagingRoot(
    preparation.stagingCanonicalRoot,
    preparation.stagingIdentity,
  );
  if (preparation.state !== 'PREPARED') return;

  for (const entry of preparation.entries) {
    const target = path.join(preparation.destinationCanonicalRoot, entry.artifact);
    const staged = path.join(preparation.stagingCanonicalRoot, entry.stagedRelativePath);
    const backup = path.join(preparation.stagingCanonicalRoot, entry.backupRelativePath);
    if (!promotionIdentitiesMatch(optionalPromotionIdentity(target), entry.originalIdentity)) {
      promotionFail('Unjournaled Project dependency staging cannot prove the live generation is unchanged.');
    }
    if (!promotionIdentitiesMatch(optionalPromotionIdentity(staged), entry.stagedIdentity)) {
      promotionFail('Unjournaled Project dependency staging lost its prepared generation.');
    }
    if (optionalPromotionIdentity(backup)) {
      promotionFail('Unjournaled Project dependency staging unexpectedly contains a live-generation backup.');
    }
  }
}

async function discardUnjournaledPromotionStagingRoot(
  stagingRoot: string,
  options: {
    expectedDestination?: string;
    allowUnboundEmpty?: boolean;
  } = {},
): Promise<boolean> {
  const operationParent = path.dirname(stagingRoot);
  const operationId = promotionStagingOperationId(path.basename(stagingRoot));
  if (!operationId) return false;
  if (fs.existsSync(promotionJournalFile(operationParent, operationId))) return false;

  const preparationFile = promotionPreparationFile(stagingRoot);
  if (!fs.existsSync(preparationFile)) {
    if (!options.allowUnboundEmpty) return false;
    assertPrivatePromotionStagingRoot(stagingRoot);
    const preparationTemporaries = fs.readdirSync(stagingRoot);
    if (!preparationTemporaries.every(promotionPreparationTemporaryBasename)) {
      promotionFail('Unjournaled Project dependency staging lacks durable preparation identity.');
    }
    for (const name of preparationTemporaries) {
      assertPrivatePromotionTemporaryFile(
        path.join(stagingRoot, name),
        'Project dependency preparation temporary record',
      );
      fs.unlinkSync(path.join(stagingRoot, name));
    }
    fs.rmdirSync(stagingRoot);
    fsyncPromotionDirectory(operationParent);
    return true;
  }

  const preparation = readPromotionPreparation(preparationFile);
  if (
    options.expectedDestination
    && preparation.destinationCanonicalRoot !== options.expectedDestination
  ) return false;
  verifyPreparedUnjournaledPromotionIsAllOld(preparation);
  await fs.promises.rm(stagingRoot, { recursive: true, force: false });
  fsyncPromotionDirectory(operationParent);
  return true;
}

function discardUnjournaledPromotionJournalTemporaries(
  operationParent: string,
  expectedDestination?: string,
  protectedOperationIds: ReadonlySet<string> = new Set(),
): number {
  let discarded = 0;
  for (const name of fs.readdirSync(operationParent).sort()) {
    const operationId = promotionJournalTemporaryOperationId(name);
    if (!operationId) continue;
    if (protectedOperationIds.has(operationId)) continue;
    const journalFile = promotionJournalFile(operationParent, operationId);
    if (fs.existsSync(journalFile)) continue;
    const stagingRoot = promotionStagingRoot(operationParent, operationId);
    if (fs.existsSync(stagingRoot)) {
      const preparation = readPromotionPreparation(promotionPreparationFile(stagingRoot));
      if (
        expectedDestination
        && preparation.destinationCanonicalRoot !== expectedDestination
      ) continue;
      verifyPreparedUnjournaledPromotionIsAllOld(preparation);
    } else if (expectedDestination) {
      // With only a project-scoped lease, an unbound owner-level temporary may
      // belong to another Project's active preparation seam. Startup owns the
      // owner-wide cleanup; a request guard must not interfere cross-Project.
      continue;
    }
    const temporary = path.join(operationParent, name);
    assertPrivatePromotionTemporaryFile(
      temporary,
      'Project dependency promotion temporary journal',
    );
    fs.unlinkSync(temporary);
    discarded += 1;
  }
  if (discarded > 0) fsyncPromotionDirectory(operationParent);
  return discarded;
}

async function recoverPromotionJournalFile(
  file: string,
  decision: ProjectDependencyPromotionDecisionRecord | null,
  lifecycleLock: ProjectDeletionLockLease,
  database?: ProjectDependencyPromotionDecisionDatabase,
): Promise<'rolled_back' | 'committed' | 'quarantined'> {
  const journal = readPromotionJournal(file);
  if (decision) {
    const manifest = projectLifecycleArtifactPromotionManifest(journal);
    if (
      decision.operationId !== manifest.operationId
      || decision.manifestDigest !== manifest.manifestDigest
      || decision.projectIdentityId !== manifest.projectIdentityId
      || decision.projectIdentityGeneration !== manifest.projectIdentityGeneration
      || decision.workspaceOwnerId !== manifest.workspaceOwnerId
      || decision.projectName !== manifest.projectName
      || decision.operationParentCanonicalRoot !== manifest.operationParentCanonicalRoot
      || decision.operationParentDevice !== manifest.operationParentIdentity.device
      || decision.operationParentInode !== manifest.operationParentIdentity.inode
      || decision.operationParentBirthtimeNs !== manifest.operationParentIdentity.birthtimeNs
      || decision.operationParentMode !== manifest.operationParentIdentity.mode
      || decision.operationParentUid !== manifest.operationParentIdentity.uid
      || decision.operationParentGid !== manifest.operationParentIdentity.gid
      || decision.destinationCanonicalRoot !== manifest.destinationCanonicalRoot
      || decision.destinationRootDevice !== manifest.destinationIdentity.device
      || decision.destinationRootInode !== manifest.destinationIdentity.inode
      || decision.destinationRootBirthtimeNs !== manifest.destinationIdentity.birthtimeNs
      || JSON.stringify(decision.manifest) !== JSON.stringify(manifest)
    ) promotionFail('The durable dependency promotion decision conflicts with filesystem evidence.');
    const lifecycle = await readProjectDependencyPromotionLifecycle({
      projectIdentityId: decision.projectIdentityId,
      database,
    });
    if (!lifecycle
      || lifecycle.workspaceOwnerId !== decision.workspaceOwnerId
      || lifecycle.projectName !== decision.projectName
      || lifecycle.canonicalRoot !== decision.destinationCanonicalRoot
      || lifecycle.rootDevice !== decision.destinationRootDevice
      || lifecycle.rootInode !== decision.destinationRootInode
      || lifecycle.rootBirthtimeNs !== decision.destinationRootBirthtimeNs
      || lifecycle.generation !== decision.projectIdentityGeneration) {
      promotionFail('The durable dependency promotion decision lost its exact Project lifecycle binding.');
    }
    if (lifecycle.lifecycleStatus === 'DEPENDENCY_QUARANTINED') return 'quarantined';
    try {
      if (journal.state === 'COMMITTED') {
      // Cleanup can crash after removing staging but before unlinking the
      // committed journal. COMMITTED itself is not trusted without the exact
      // DB row above; together they prove all-new and permit missing staging.
      verifyAllNewGeneration(journal);
      } else {
        convergePromotionJournalToAllNew(file, journal);
        const committedJournal: ProjectLifecycleArtifactPromotionJournal = {
          ...journal,
          entries: journal.entries.map((entry) => ({ ...entry })),
          state: 'COMMITTED',
        };
        writePromotionJournal(file, committedJournal);
        Object.assign(journal, committedJournal);
      }
    } catch (error) {
      if (!isProjectAttributablePromotionFilesystemError(error)) throw error;
      await quarantineProjectDependencyPromotion({
        operationId: decision.operationId,
        manifestDigest: decision.manifestDigest,
        lifecycleLock,
        database,
      });
      return 'quarantined';
    }
    let applied = decision;
    if (decision.status === 'AUTHORIZED') {
      applied = await markProjectDependencyPromotionApplied({
        operationId: manifest.operationId,
        manifestDigest: manifest.manifestDigest,
        database,
      });
    }
    if (applied.status !== 'APPLIED') {
      promotionFail('The durable dependency promotion decision did not become applied.');
    }
    try {
      await removePromotionEvidence(file, journal);
      await deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup({
        operationId: manifest.operationId,
        manifestDigest: manifest.manifestDigest,
        lifecycleLock,
        verifyAppliedGeneration: verifyProjectDependencyPromotionManifestAllNew,
        database,
      });
    } catch (error) {
      const attributableEvidenceFailure = error instanceof ProjectDependencyPromotionDecisionError
        && error.code === 'EVIDENCE_NOT_CLEAN';
      if (!attributableEvidenceFailure && !isProjectAttributablePromotionFilesystemError(error)) {
        throw error;
      }
      await quarantineProjectDependencyPromotion({
        operationId: applied.operationId,
        manifestDigest: applied.manifestDigest,
        lifecycleLock,
        database,
      });
      return 'quarantined';
    }
    return 'committed';
  }
  if (journal.state === 'COMMITTED') {
    promotionFail('Committed dependency promotion evidence has no durable database decision.');
  }
  if (journal.state === 'ABANDONED') {
    await removePromotionEvidence(file, journal);
    return 'rolled_back';
  }
  if (journal.state !== 'ROLLED_BACK') rollbackPromotionJournal(file, journal);
  else verifyAllOldGeneration(journal, true);
  await removePromotionEvidence(file, journal);
  return 'rolled_back';
}

async function recoverAppliedPromotionDecisionWithoutJournal(
  decision: ProjectDependencyPromotionDecisionRecord,
  lifecycleLock: ProjectDeletionLockLease,
  database?: ProjectDependencyPromotionDecisionDatabase,
): Promise<'committed' | 'quarantined'> {
  if (decision.status !== 'APPLIED') {
    promotionFail('Only an applied dependency promotion can recover without its retired journal.');
  }
  const lifecycle = await readProjectDependencyPromotionLifecycle({
    projectIdentityId: decision.projectIdentityId,
    database,
  });
  if (!lifecycle
    || lifecycle.workspaceOwnerId !== decision.workspaceOwnerId
    || lifecycle.projectName !== decision.projectName
    || lifecycle.canonicalRoot !== decision.destinationCanonicalRoot
    || lifecycle.rootDevice !== decision.destinationRootDevice
    || lifecycle.rootInode !== decision.destinationRootInode
    || lifecycle.rootBirthtimeNs !== decision.destinationRootBirthtimeNs
    || lifecycle.generation !== decision.projectIdentityGeneration) {
    promotionFail('The applied dependency promotion lost its exact Project lifecycle binding.');
  }
  if (lifecycle.lifecycleStatus === 'DEPENDENCY_QUARANTINED') return 'quarantined';
  try {
    await deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup({
      operationId: decision.operationId,
      manifestDigest: decision.manifestDigest,
      lifecycleLock,
      verifyAppliedGeneration: verifyProjectDependencyPromotionManifestAllNew,
      database,
    });
    return 'committed';
  } catch (error) {
    const attributableEvidenceFailure = error instanceof ProjectDependencyPromotionDecisionError
      && error.code === 'EVIDENCE_NOT_CLEAN';
    if (!attributableEvidenceFailure && !isProjectAttributablePromotionFilesystemError(error)) {
      throw error;
    }
    await quarantineProjectDependencyPromotion({
      operationId: decision.operationId,
      manifestDigest: decision.manifestDigest,
      lifecycleLock,
      database,
    });
    return 'quarantined';
  }
}

async function recoverInterruptedProjectLifecycleArtifactPromotionUnderLock(
  destination: string,
  lifecycleLock: ProjectDeletionLockLease,
  database?: ProjectDependencyPromotionDecisionDatabase,
): Promise<{ rolledBack: number; committed: number; quarantined: number; discarded: number }> {
  const destinationRoot = assertSafeWorkspace(destination);
  const parent = path.dirname(destinationRoot);
  const lockKey = projectDeletionLockKey(path.basename(parent), path.basename(destinationRoot));
  assertHeldProjectDeletionLockLease(lifecycleLock, lockKey);
  const decision = await findProjectDependencyPromotionDecisionByDestination({
    destinationCanonicalRoot: destinationRoot,
    database,
  });
  let rolledBack = 0;
  let committed = 0;
  let discarded = 0;
  let quarantined = 0;
  let recoveredDecisionOperation = false;
  for (const name of fs.readdirSync(parent).filter(promotionJournalBasename).sort()) {
    const file = path.join(parent, name);
    const journal = readPromotionJournal(file);
    if (journal.destinationCanonicalRoot !== destinationRoot) continue;
    const manifest = projectLifecycleArtifactPromotionManifest(journal);
    const operationDecision = await resolveProjectDependencyPromotionDecision({
      operationId: manifest.operationId,
      manifestDigest: manifest.manifestDigest,
      database,
    });
    if (
      (decision && operationDecision?.operationId !== decision.operationId)
      || (!decision && operationDecision)
    ) promotionFail('Dependency promotion decision lookup conflicts for this Project.');
    const result = await recoverPromotionJournalFile(
      file,
      operationDecision,
      lifecycleLock,
      database,
    );
    if (operationDecision) recoveredDecisionOperation = true;
    if (result === 'committed') committed += 1;
    else if (result === 'quarantined') quarantined += 1;
    else rolledBack += 1;
  }
  for (const name of fs.readdirSync(parent).sort()) {
    const stagedOperationId = promotionStagingOperationId(name);
    if (!stagedOperationId) continue;
    if (decision?.operationId === stagedOperationId) {
      if (decision.status === 'AUTHORIZED') {
        promotionFail('An authorized dependency promotion decision has staging evidence but no journal.');
      }
      // APPLIED/no-journal evidence is not safe to infer or delete. The final
      // durable-manifest recovery below will retain it and quarantine exactly
      // this Project when the evidence-absence proof fails.
      continue;
    }
    if (await discardUnjournaledPromotionStagingRoot(path.join(parent, name), {
      expectedDestination: destinationRoot,
    })) discarded += 1;
  }
  for (const name of fs.readdirSync(parent).sort()) {
    const temporaryOperationId = promotionJournalTemporaryOperationId(name);
    if (decision?.operationId === temporaryOperationId
      && !fs.existsSync(promotionJournalFile(parent, temporaryOperationId))) {
      if (decision.status === 'AUTHORIZED') {
        promotionFail('An authorized dependency promotion decision has only temporary journal evidence.');
      }
      continue;
    }
  }
  discarded += discardUnjournaledPromotionJournalTemporaries(
    parent,
    destinationRoot,
    new Set(decision ? [decision.operationId] : []),
  );
  if (decision && !recoveredDecisionOperation) {
    if (decision.status === 'AUTHORIZED') {
      promotionFail('An authorized dependency promotion decision has no durable journal.');
    }
    const result = await recoverAppliedPromotionDecisionWithoutJournal(
      decision,
      lifecycleLock,
      database,
    );
    if (result === 'committed') committed += 1;
    else quarantined += 1;
  }
  return { rolledBack, committed, quarantined, discarded };
}

/** Recover one Project while acquiring its exact owner/name lifecycle lock. */
export async function recoverInterruptedProjectLifecycleArtifactPromotion(
  destination: string,
  database?: ProjectDependencyPromotionDecisionDatabase,
): Promise<{ rolledBack: number; committed: number; quarantined: number; discarded: number }> {
  const destinationRoot = assertSafeWorkspace(destination);
  const lifecycleLock = await acquireProjectDeletionLockWithoutGuard(projectDeletionLockKey(
    path.basename(path.dirname(destinationRoot)),
    path.basename(destinationRoot),
  ));
  try {
    return await recoverInterruptedProjectLifecycleArtifactPromotionUnderLock(
      destinationRoot,
      lifecycleLock,
      database,
    );
  } finally {
    lifecycleLock();
  }
}

async function listAllProjectDependencyPromotionDecisions(
  database?: ProjectDependencyPromotionDecisionDatabase,
): Promise<ProjectDependencyPromotionDecisionRecord[]> {
  const result: ProjectDependencyPromotionDecisionRecord[] = [];
  let afterOperationId: string | undefined;
  for (;;) {
    const page = await listProjectDependencyPromotionDecisions({
      afterOperationId,
      limit: 1_000,
      database,
    });
    result.push(...page);
    if (page.length < 1_000) return result;
    afterOperationId = page[page.length - 1].operationId;
  }
}

async function listAllProjectDependencyPromotionLifecycles(
  database?: ProjectDependencyPromotionDecisionDatabase,
): Promise<ProjectDependencyPromotionLifecycleRecord[]> {
  const result: ProjectDependencyPromotionLifecycleRecord[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = await listProjectDependencyPromotionLifecycleRecords({
      afterId,
      limit: 1_000,
      database,
    });
    result.push(...page);
    if (page.length < 1_000) return result;
    afterId = page[page.length - 1].id;
  }
}

function canonicalPromotionInspectionJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalPromotionInspectionJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalPromotionInspectionJson(record[key])}`
  )).join(',')}}`;
}

function stablePrivatePromotionEvidenceBytes(file: string, label: string): {
  content: Buffer;
  digest: string;
} {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY
        | (fs.constants.O_NOFOLLOW || 0)
        | (fs.constants.O_NONBLOCK || 0),
    );
  } catch (error: any) {
    if (error?.code === 'ENOENT') promotionFail(`${label} disappeared during startup inspection.`);
    throw error;
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile()
      || before.uid !== BigInt(currentOwnerUid())
      || before.gid !== BigInt(currentOwnerGid())
      || (before.mode & 0o777n) !== 0o600n
      || before.nlink !== 1n
      || before.size <= 0n
      || before.size > BigInt(PROJECT_ARTIFACT_PROMOTION_MAX_JOURNAL_BYTES)
    ) promotionFail(`${label} is not a private server-owned file.`);
    const size = Number(before.size);
    const content = Buffer.alloc(size);
    if (fs.readSync(descriptor, content, 0, size, 0) !== size) {
      promotionFail(`${label} could not be read completely.`);
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.birthtimeNs !== after.birthtimeNs
      || before.ctimeNs !== after.ctimeNs
      || before.mtimeNs !== after.mtimeNs
      || before.size !== after.size
      || before.mode !== after.mode
      || before.uid !== after.uid
      || before.gid !== after.gid
      || before.nlink !== after.nlink
    ) promotionFail(`${label} changed during startup inspection.`);
    const contentSha256 = crypto.createHash('sha256').update(content).digest('hex');
    const digest = crypto.createHash('sha256').update(canonicalPromotionInspectionJson({
      device: before.dev.toString(),
      inode: before.ino.toString(),
      birthtimeNs: before.birthtimeNs.toString(),
      ctimeNs: before.ctimeNs.toString(),
      mtimeNs: before.mtimeNs.toString(),
      size: before.size.toString(),
      mode: before.mode.toString(),
      uid: before.uid.toString(),
      gid: before.gid.toString(),
      contentSha256,
    })).digest('hex');
    return { content, digest };
  } finally {
    fs.closeSync(descriptor);
  }
}

function stablePrivatePromotionEvidenceDigest(file: string, label: string): string {
  return stablePrivatePromotionEvidenceBytes(file, label).digest;
}

function stablePromotionEvidenceRead<T>(
  accessFile: string,
  canonicalFile: string,
  label: string,
  validate: (value: unknown, canonicalFile: string) => T,
): { value: T; contentSha256: string } {
  const evidence = stablePrivatePromotionEvidenceBytes(accessFile, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidence.content.toString('utf8'));
  } catch {
    promotionFail(`${label} cannot be parsed.`);
  }
  return {
    value: validate(parsed, canonicalFile),
    contentSha256: evidence.digest,
  };
}

function promotionInspectionStatSnapshot(stat: fs.BigIntStats): Record<string, string | boolean> {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    size: stat.size.toString(),
    mode: stat.mode.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    nlink: stat.nlink.toString(),
    directory: stat.isDirectory(),
    file: stat.isFile(),
    symlink: stat.isSymbolicLink(),
  };
}

function promotionInspectionComparableNamespaceStatSnapshot(
  stat: fs.BigIntStats,
): Record<string, string | boolean> {
  // Cross-inspection namespace identity must ignore timestamp-only churn. Entry
  // names and content-bearing evidence are hashed separately; the full stat
  // snapshot remains authoritative for fd-pinned intra-inspection race checks.
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
    mode: stat.mode.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    directory: stat.isDirectory(),
    file: stat.isFile(),
    symlink: stat.isSymbolicLink(),
  };
}

function samePromotionInspectionStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return canonicalPromotionInspectionJson(promotionInspectionStatSnapshot(left))
    === canonicalPromotionInspectionJson(promotionInspectionStatSnapshot(right));
}

interface PromotionInspectionDirectoryHandle {
  descriptor: number;
  descriptorPath: string;
  before: fs.BigIntStats;
  names: string[];
}

function openPromotionInspectionDirectory(
  accessPath: string,
  label: string,
): PromotionInspectionDirectoryHandle {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      accessPath,
      fs.constants.O_RDONLY
        | (fs.constants.O_DIRECTORY || 0)
        | (fs.constants.O_NOFOLLOW || 0)
        | (fs.constants.O_NONBLOCK || 0),
    );
  } catch {
    promotionFail(`${label} cannot be opened without following links.`);
  }
  const before = fs.fstatSync(descriptor, { bigint: true });
  if (!before.isDirectory()) {
    fs.closeSync(descriptor);
    promotionFail(`${label} is not a directory.`);
  }
  const descriptorPath = `/proc/self/fd/${descriptor}`;
  const names = fs.readdirSync(descriptorPath).sort();
  return { descriptor, descriptorPath, before, names };
}

function closeStablePromotionInspectionDirectory(
  handle: PromotionInspectionDirectoryHandle,
  label: string,
  expectedCanonicalPath?: string,
): void {
  try {
    const namesAfter = fs.readdirSync(handle.descriptorPath).sort();
    const after = fs.fstatSync(handle.descriptor, { bigint: true });
    if (
      !samePromotionInspectionStat(handle.before, after)
      || namesAfter.length !== handle.names.length
      || namesAfter.some((name, index) => name !== handle.names[index])
      || (expectedCanonicalPath
        && fs.realpathSync.native(handle.descriptorPath) !== expectedCanonicalPath)
    ) promotionFail(`${label} changed during startup inspection.`);
  } finally {
    fs.closeSync(handle.descriptor);
  }
}

function promotionInspectionDirectoryHandleDigest(
  handle: PromotionInspectionDirectoryHandle,
  canonicalPath: string,
): string {
  return crypto.createHash('sha256').update(canonicalPromotionInspectionJson({
    canonicalPath,
    stat: promotionInspectionStatSnapshot(handle.before),
    names: handle.names,
  })).digest('hex');
}

function promotionInspectionIdentityFromStat(stat: fs.BigIntStats): PromotionEntryIdentity {
  if (!stat.isDirectory() && !stat.isFile()) {
    promotionFail('Project dependency promotion evidence has an unsupported filesystem type.');
  }
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    kind: stat.isDirectory() ? 'directory' : 'file',
    mode: Number(stat.mode & 0o777n),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    birthtimeNs: stat.birthtimeNs.toString(),
  };
}

/**
 * Descriptor-relative recursive snapshot used only for startup evidence
 * inventory. Unlike the portable generation digest, this deliberately binds
 * inode topology and all mutable stat timestamps as well as file bytes.
 */
function promotionInspectionTreeDigestFromOpened(
  rootDescriptor: number,
  rootBefore: fs.BigIntStats,
): string {
  const hash = crypto.createHash('sha256');
  const visit = (
    entryPath: string,
    relative: string,
    existing?: { descriptor: number; before: fs.BigIntStats },
  ): void => {
    const before = existing?.before || fs.lstatSync(entryPath, { bigint: true });
    hash.update(canonicalPromotionInspectionJson({
      relative,
      stat: promotionInspectionStatSnapshot(before),
    }));
    hash.update('\0');
    if (before.isSymbolicLink()) {
      const target = fs.readlinkSync(entryPath);
      const after = fs.lstatSync(entryPath, { bigint: true });
      if (!after.isSymbolicLink() || !samePromotionInspectionStat(before, after)) {
        promotionFail('Project dependency promotion symlink changed during startup inspection.');
      }
      hash.update(target);
      hash.update('\0');
      return;
    }
    if (!before.isFile() && !before.isDirectory()) {
      promotionFail('Project dependency promotion evidence has an unsupported entry.');
    }
    let descriptor = existing?.descriptor;
    let ownsDescriptor = false;
    if (descriptor === undefined) {
      try {
        descriptor = fs.openSync(
          entryPath,
          fs.constants.O_RDONLY
            | (before.isDirectory() ? (fs.constants.O_DIRECTORY || 0) : 0)
            | (fs.constants.O_NOFOLLOW || 0)
            | (fs.constants.O_NONBLOCK || 0),
        );
        ownsDescriptor = true;
      } catch {
        promotionFail('Project dependency promotion evidence changed during startup inspection.');
      }
    }
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (
        !samePromotionInspectionStat(before, opened)
        || (!opened.isDirectory() && !opened.isFile())
      ) promotionFail('Project dependency promotion evidence has an unsupported entry.');
      if (opened.isDirectory()) {
        const descriptorPath = `/proc/self/fd/${descriptor}`;
        const names = fs.readdirSync(descriptorPath).sort();
        for (const name of names) {
          if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
            promotionFail('Project dependency promotion evidence has an unsafe entry name.');
          }
          visit(path.join(descriptorPath, name), relative ? `${relative}/${name}` : name);
        }
        const namesAfter = fs.readdirSync(descriptorPath).sort();
        if (
          namesAfter.length !== names.length
          || namesAfter.some((name, index) => name !== names[index])
        ) promotionFail('Project dependency promotion directory changed during startup inspection.');
      } else {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        for (;;) {
          const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, position);
          if (bytes === 0) break;
          hash.update(buffer.subarray(0, bytes));
          position += bytes;
        }
      }
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (!samePromotionInspectionStat(opened, after)) {
        promotionFail('Project dependency promotion evidence changed during startup inspection.');
      }
    } finally {
      if (ownsDescriptor) fs.closeSync(descriptor);
    }
  };
  visit(`/proc/self/fd/${rootDescriptor}`, '', {
    descriptor: rootDescriptor,
    before: rootBefore,
  });
  return hash.digest('hex');
}

function promotionInspectionTreeDigest(candidate: string): string {
  const before = fs.lstatSync(candidate, { bigint: true });
  if (before.isSymbolicLink()) {
    return crypto.createHash('sha256').update(canonicalPromotionInspectionJson({
      relative: '',
      stat: promotionInspectionStatSnapshot(before),
      linkTarget: fs.readlinkSync(candidate),
    })).digest('hex');
  }
  if (!before.isDirectory() && !before.isFile()) {
    promotionFail('Project dependency promotion evidence has an unsupported entry.');
  }
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY
      | (before.isDirectory() ? (fs.constants.O_DIRECTORY || 0) : 0)
      | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_NONBLOCK || 0),
  );
  try {
    return promotionInspectionTreeDigestFromOpened(descriptor, before);
  } finally {
    fs.closeSync(descriptor);
  }
}

function promotionInspectionOpaqueEvidenceDigest(
  candidate: string,
  canonicalCandidate = candidate,
): string {
  let entry: fs.BigIntStats | null = null;
  let linkTarget: string | null = null;
  let contentSha256: string | null = null;
  let directoryEntries: string[] | null = null;
  let truncated = false;
  let errorCode: string | null = null;
  try {
    entry = fs.lstatSync(candidate, { bigint: true });
    if (entry.isSymbolicLink()) {
      linkTarget = fs.readlinkSync(candidate);
    } else if (entry.isFile()) {
      const maximum = BigInt(PROJECT_ARTIFACT_PROMOTION_MAX_JOURNAL_BYTES);
      const readSize = Number(entry.size > maximum ? maximum : entry.size);
      truncated = entry.size > maximum;
      const descriptor = fs.openSync(
        candidate,
        fs.constants.O_RDONLY
          | (fs.constants.O_NOFOLLOW || 0)
          | (fs.constants.O_NONBLOCK || 0),
      );
      try {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!samePromotionInspectionStat(entry, opened)) {
          promotionFail('Opaque promotion evidence changed before inspection.');
        }
        const content = Buffer.alloc(readSize);
        if (readSize > 0 && fs.readSync(descriptor, content, 0, readSize, 0) !== readSize) {
          promotionFail('Opaque promotion evidence could not be read completely.');
        }
        const after = fs.fstatSync(descriptor, { bigint: true });
        if (!samePromotionInspectionStat(opened, after)) {
          promotionFail('Opaque promotion evidence changed during inspection.');
        }
        contentSha256 = crypto.createHash('sha256').update(content).digest('hex');
      } finally {
        fs.closeSync(descriptor);
      }
    } else if (entry.isDirectory()) {
      // Unsafe directories already force a startup hold. Bound their immediate
      // namespace without recursively opening attacker-controlled FIFOs or an
      // unbounded tree; the stat snapshot records later namespace changes.
      const descriptor = fs.openSync(
        candidate,
        fs.constants.O_RDONLY
          | (fs.constants.O_DIRECTORY || 0)
          | (fs.constants.O_NOFOLLOW || 0)
          | (fs.constants.O_NONBLOCK || 0),
      );
      try {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!opened.isDirectory() || !samePromotionInspectionStat(entry, opened)) {
          promotionFail('Opaque promotion evidence changed before inspection.');
        }
        const names = fs.readdirSync(`/proc/self/fd/${descriptor}`).sort();
        const maximumEntries = 4_096;
        directoryEntries = names.slice(0, maximumEntries);
        truncated = names.length > maximumEntries;
        const after = fs.fstatSync(descriptor, { bigint: true });
        if (!samePromotionInspectionStat(opened, after)) {
          promotionFail('Opaque promotion evidence changed during inspection.');
        }
      } finally {
        fs.closeSync(descriptor);
      }
    }
  } catch (error) {
    errorCode = promotionInspectionErrorCode('OPAQUE', error);
  }
  return crypto.createHash('sha256').update(canonicalPromotionInspectionJson({
    canonicalPath: path.resolve(canonicalCandidate),
    errorCode,
    stat: entry ? promotionInspectionStatSnapshot(entry) : null,
    linkTarget,
    contentSha256,
    directoryEntries,
    truncated,
  })).digest('hex');
}

function promotionInspectionOptionalEntryDigest(candidate: string): {
  present: boolean;
  digest: string | null;
} {
  try {
    fs.lstatSync(candidate);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { present: false, digest: null };
    throw error;
  }
  return { present: true, digest: promotionInspectionTreeDigest(candidate) };
}

function openOptionalPromotionInspectionDirectory(
  accessPath: string,
  label: string,
): PromotionInspectionDirectoryHandle | null {
  try {
    fs.lstatSync(accessPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return openPromotionInspectionDirectory(accessPath, label);
}

function promotionInspectionDescendantDigest(
  root: PromotionInspectionDirectoryHandle | null,
  relativePath: string,
): { present: boolean; digest: string | null } {
  if (!root) return { present: false, digest: null };
  if (
    !relativePath
    || path.isAbsolute(relativePath)
    || relativePath.includes('\\')
    || relativePath.includes('\0')
  ) promotionFail('Project dependency promotion topology has an unsafe relative path.');
  const components = relativePath.split('/');
  if (components.some((component) => !component || component === '.' || component === '..')) {
    promotionFail('Project dependency promotion topology has an unsafe relative path.');
  }
  const parents: PromotionInspectionDirectoryHandle[] = [];
  let current = root;
  try {
    for (const component of components.slice(0, -1)) {
      const nextAccess = path.join(current.descriptorPath, component);
      const next = openOptionalPromotionInspectionDirectory(
        nextAccess,
        'Project dependency promotion topology parent',
      );
      if (!next) return { present: false, digest: null };
      parents.push(next);
      current = next;
    }
    return promotionInspectionOptionalEntryDigest(
      path.join(current.descriptorPath, components[components.length - 1]),
    );
  } finally {
    for (const parent of parents.reverse()) {
      closeStablePromotionInspectionDirectory(
        parent,
        'Project dependency promotion topology parent',
      );
    }
  }
}

function promotionInspectionRecoveryTopologyDigest(input: {
  operationId: string;
  operationParentIdentity: PromotionEntryIdentity;
  operationParentActualIdentity?: PromotionEntryIdentity;
  destinationCanonicalRoot: string;
  destinationIdentity: PromotionEntryIdentity;
  stagingCanonicalRoot: string;
  stagingIdentity: PromotionEntryIdentity;
  destinationAccessRoot?: string;
  stagingAccessRoot?: string;
  entries: Array<{
    artifact: string;
    stagedRelativePath: string;
    backupRelativePath: string;
  }>;
}): string {
  let destination: PromotionInspectionDirectoryHandle | null = null;
  let staging: PromotionInspectionDirectoryHandle | null = null;
  let digest: string;
  let topology: Array<{
    artifact: string;
    target: { present: boolean; digest: string | null };
    staged: { present: boolean; digest: string | null };
    backup: { present: boolean; digest: string | null };
  }>;
  try {
    destination = openOptionalPromotionInspectionDirectory(
      input.destinationAccessRoot || input.destinationCanonicalRoot,
      'Project dependency promotion destination topology',
    );
    staging = openOptionalPromotionInspectionDirectory(
      input.stagingAccessRoot || input.stagingCanonicalRoot,
      'Project dependency promotion staging topology',
    );
    const actualDestination = destination
      ? promotionInspectionIdentityFromStat(destination.before)
      : null;
    const actualStaging = staging
      ? promotionInspectionIdentityFromStat(staging.before)
      : null;
    if (
      input.operationParentActualIdentity
      && !promotionIdentitiesMatch(
        input.operationParentIdentity,
        input.operationParentActualIdentity,
      )
    ) promotionFail('Project dependency promotion owner identity changed before startup recovery.');
    topology = input.entries.map((entry) => ({
      artifact: entry.artifact,
      target: promotionInspectionDescendantDigest(destination, entry.artifact),
      staged: promotionInspectionDescendantDigest(staging, entry.stagedRelativePath),
      backup: promotionInspectionDescendantDigest(staging, entry.backupRelativePath),
    }));
    digest = crypto.createHash('sha256').update(canonicalPromotionInspectionJson({
      operationId: input.operationId,
      operationParentIdentityExpected: input.operationParentIdentity,
      operationParentIdentityActual: input.operationParentActualIdentity || null,
      destinationIdentityExpected: input.destinationIdentity,
      destinationIdentityActual: actualDestination,
      destinationSnapshot: destination ? {
        stat: promotionInspectionStatSnapshot(destination.before),
        names: destination.names,
      } : null,
      stagingIdentityExpected: input.stagingIdentity,
      stagingIdentityActual: actualStaging,
      stagingSnapshot: staging ? {
        stat: promotionInspectionStatSnapshot(staging.before),
        names: staging.names,
      } : null,
      topology,
    })).digest('hex');
  } finally {
    if (staging) {
      closeStablePromotionInspectionDirectory(
        staging,
        'Project dependency promotion staging topology',
        input.stagingCanonicalRoot,
      );
    }
    if (destination) {
      closeStablePromotionInspectionDirectory(
        destination,
        'Project dependency promotion destination topology',
        input.destinationCanonicalRoot,
      );
    }
  }
  return digest!;
}

function promotionInspectionErrorCode(prefix: string, error: unknown): string {
  const suffix = String((error as { code?: unknown })?.code || (error as Error)?.name || 'UNSAFE')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .toUpperCase()
    .slice(0, 64) || 'UNSAFE';
  return `${prefix}_${suffix}`;
}

/**
 * Read-only startup inventory for the complete durable decision + filesystem
 * evidence namespace. This function deliberately performs no cleanup and no
 * lifecycle transition: callers compare its canonical digest before and after
 * runtime quiescence, then invoke the existing mutating recovery separately.
 */
export async function inspectProjectDependencyPromotionStartupEvidence(
  projectsRootInput: string,
  database?: ProjectDependencyPromotionDecisionDatabase,
): Promise<ProjectDependencyPromotionStartupEvidenceInspection> {
  const projectsRoot = assertSafeWorkspace(projectsRootInput);
  const inspectionDatabase = database || (prisma as unknown as ProjectDependencyPromotionDecisionDatabase);
  const [decisions, lifecycles] = await inspectionDatabase.$transaction(
    async (transaction) => Promise.all([
      listAllProjectDependencyPromotionDecisions(
        transaction as ProjectDependencyPromotionDecisionDatabase,
      ),
      listAllProjectDependencyPromotionLifecycles(
        transaction as ProjectDependencyPromotionDecisionDatabase,
      ),
    ]),
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: 30_000,
    },
  );
  const projectsRootInspection = openPromotionInspectionDirectory(
    projectsRoot,
    'Project dependency promotion storage root',
  );
  if (fs.realpathSync.native(projectsRootInspection.descriptorPath) !== projectsRoot) {
    fs.closeSync(projectsRootInspection.descriptor);
    promotionFail('Project dependency promotion storage descriptor lost its canonical binding.');
  }
  try {
  const namespaceSnapshots = new Map<string, {
    canonicalPath: string;
    stat: Record<string, string | boolean>;
    names: string[] | null;
    dependencyArtifactsSha256?: string | null;
  }>();
  namespaceSnapshots.set(projectsRoot, {
    canonicalPath: projectsRoot,
    stat: promotionInspectionComparableNamespaceStatSnapshot(projectsRootInspection.before),
    names: [...projectsRootInspection.names],
  });
  const decisionsByOperation = new Map(decisions.map((decision) => [decision.operationId, decision]));
  const decisionsByDestination = new Map(decisions.map((decision) => [
    decision.destinationCanonicalRoot,
    decision,
  ]));
  const lifecyclesByIdentity = new Map(lifecycles.map((identity) => [identity.id, identity]));
  const uncertainEvidence: ProjectDependencyPromotionStartupUncertainEvidence[] = [];
  const unboundEvidence: ProjectDependencyPromotionStartupUnboundEvidence[] = [];
  const targetMap = new Map<string, ProjectDependencyPromotionStartupTarget>();
  const exactJournalDecisionOperations = new Set<string>();

  const uncertain = (input: Omit<
    ProjectDependencyPromotionStartupUncertainEvidence,
    'evidenceSha256'
  > & { evidenceSha256?: string | null }): void => {
    uncertainEvidence.push({
      code: input.code.replace(/[^A-Z0-9_-]/gi, '_').toUpperCase().slice(0, 96),
      workspaceOwnerId: input.workspaceOwnerId,
      operationId: input.operationId,
      canonicalPath: input.canonicalPath,
      evidenceSha256: input.evidenceSha256 || null,
    });
  };
  const targetIdentityKey = (input: {
    projectIdentityId: string;
    projectIdentityGeneration: number;
  }): string => `${input.projectIdentityId}\0${input.projectIdentityGeneration}`;
  const targetKey = (input: {
    projectIdentityId: string;
    projectIdentityGeneration: number;
    workspaceOwnerId: string;
    projectName: string;
    canonicalRoot: string;
    rootDevice: string;
    rootInode: string;
    rootBirthtimeNs: string;
  }): string => canonicalPromotionInspectionJson({
    identity: targetIdentityKey(input),
    workspaceOwnerId: input.workspaceOwnerId,
    projectName: input.projectName,
    canonicalRoot: input.canonicalRoot,
    rootDevice: input.rootDevice,
    rootInode: input.rootInode,
    rootBirthtimeNs: input.rootBirthtimeNs,
  });
  const targetBindingsByIdentity = new Map<string, Set<string>>();
  const attestedTargetKeys = new Set<string>();
  const addTargetSource = (input: {
    projectIdentityId: string;
    projectIdentityGeneration: number;
    workspaceOwnerId: string;
    projectName: string;
    canonicalRoot: string;
    rootDevice: string;
    rootInode: string;
    rootBirthtimeNs: string;
    lifecycleStatus?: ProjectDependencyPromotionLifecycleStatus | null;
    decisionStatus?: ProjectDependencyPromotionDecisionStatus | null;
    source: ProjectDependencyPromotionStartupEvidenceSource;
  }): void => {
    const key = targetKey(input);
    const identityKey = targetIdentityKey(input);
    const identityBindings = targetBindingsByIdentity.get(identityKey) || new Set<string>();
    if (identityBindings.size > 0 && !identityBindings.has(key)) {
      uncertain({
        code: 'BOUND_TARGET_IDENTITY_CONFLICT',
        workspaceOwnerId: input.workspaceOwnerId,
        operationId: input.source.operationId,
        canonicalPath: input.source.canonicalPath || input.canonicalRoot,
        evidenceSha256: input.source.contentSha256,
      });
    }
    identityBindings.add(key);
    targetBindingsByIdentity.set(identityKey, identityBindings);
    const current = targetMap.get(key);
    if (!current) {
      targetMap.set(key, {
        projectIdentityId: input.projectIdentityId,
        projectIdentityGeneration: input.projectIdentityGeneration,
        workspaceOwnerId: input.workspaceOwnerId,
        projectName: input.projectName,
        canonicalRoot: input.canonicalRoot,
        rootDevice: input.rootDevice,
        rootInode: input.rootInode,
        rootBirthtimeNs: input.rootBirthtimeNs,
        lifecycleStatus: input.lifecycleStatus || null,
        decisionStatus: input.decisionStatus || null,
        operationIds: input.source.operationId ? [input.source.operationId] : [],
        sources: [input.source],
      });
      return;
    }
    if (
      input.lifecycleStatus
      && current.lifecycleStatus
      && current.lifecycleStatus !== input.lifecycleStatus
    ) uncertain({
      code: 'BOUND_TARGET_LIFECYCLE_CONFLICT',
      workspaceOwnerId: input.workspaceOwnerId,
      operationId: input.source.operationId,
      canonicalPath: input.source.canonicalPath,
    });
    if (
      input.decisionStatus
      && current.decisionStatus
      && current.decisionStatus !== input.decisionStatus
    ) uncertain({
      code: 'BOUND_TARGET_DECISION_CONFLICT',
      workspaceOwnerId: input.workspaceOwnerId,
      operationId: input.source.operationId,
      canonicalPath: input.source.canonicalPath,
    });
    current.lifecycleStatus = input.lifecycleStatus || current.lifecycleStatus;
    current.decisionStatus = input.decisionStatus || current.decisionStatus;
    if (input.source.operationId && !current.operationIds.includes(input.source.operationId)) {
      current.operationIds.push(input.source.operationId);
    }
    const sourceKey = canonicalPromotionInspectionJson(input.source);
    if (!current.sources.some((source) => canonicalPromotionInspectionJson(source) === sourceKey)) {
      current.sources.push(input.source);
    }
  };
  const addJournalTarget = (
    journal: ProjectLifecycleArtifactPromotionJournal,
    canonicalPath: string,
    contentSha256: string,
  ): void => {
    addTargetSource({
      projectIdentityId: journal.projectIdentityId,
      projectIdentityGeneration: journal.projectIdentityGeneration,
      workspaceOwnerId: journal.workspaceOwnerId,
      projectName: journal.projectName,
      canonicalRoot: journal.destinationCanonicalRoot,
      rootDevice: journal.destinationIdentity.device,
      rootInode: journal.destinationIdentity.inode,
      rootBirthtimeNs: journal.destinationIdentity.birthtimeNs,
      source: {
        kind: 'journal',
        operationId: journal.operationId,
        state: journal.state,
        canonicalPath,
        contentSha256,
      },
    });
  };
  const addPreparationTarget = (
    preparation: ProjectLifecycleArtifactPromotionPreparation,
    canonicalPath: string,
    contentSha256: string,
  ): void => {
    addTargetSource({
      projectIdentityId: preparation.projectIdentityId,
      projectIdentityGeneration: preparation.projectIdentityGeneration,
      workspaceOwnerId: preparation.workspaceOwnerId,
      projectName: preparation.projectName,
      canonicalRoot: preparation.destinationCanonicalRoot,
      rootDevice: preparation.destinationIdentity.device,
      rootInode: preparation.destinationIdentity.inode,
      rootBirthtimeNs: preparation.destinationIdentity.birthtimeNs,
      source: {
        kind: 'preparation',
        operationId: preparation.operationId,
        state: preparation.state,
        canonicalPath,
        contentSha256,
      },
    });
  };
  const addTopologyTarget = (input: {
    projectIdentityId: string;
    projectIdentityGeneration: number;
    workspaceOwnerId: string;
    projectName: string;
    destinationCanonicalRoot: string;
    destinationIdentity: PromotionEntryIdentity;
    stagingCanonicalRoot: string;
    stagingIdentity: PromotionEntryIdentity;
    operationParentIdentity: PromotionEntryIdentity;
    operationParentActualIdentity?: PromotionEntryIdentity;
    destinationAccessRoot?: string;
    stagingAccessRoot?: string;
    operationId: string;
    state: string;
    entries: Array<{
      artifact: string;
      stagedRelativePath: string;
      backupRelativePath: string;
    }>;
  }): void => {
    addTargetSource({
      projectIdentityId: input.projectIdentityId,
      projectIdentityGeneration: input.projectIdentityGeneration,
      workspaceOwnerId: input.workspaceOwnerId,
      projectName: input.projectName,
      canonicalRoot: input.destinationCanonicalRoot,
      rootDevice: input.destinationIdentity.device,
      rootInode: input.destinationIdentity.inode,
      rootBirthtimeNs: input.destinationIdentity.birthtimeNs,
      source: {
        kind: 'topology',
        operationId: input.operationId,
        state: input.state,
        canonicalPath: input.destinationCanonicalRoot,
        contentSha256: promotionInspectionRecoveryTopologyDigest(input),
      },
    });
  };

  if (decisionsByOperation.size !== decisions.length || decisionsByDestination.size !== decisions.length) {
    uncertain({ code: 'DECISION_UNIQUENESS_CONFLICT', workspaceOwnerId: null, operationId: null, canonicalPath: null });
  }
  if (lifecyclesByIdentity.size !== lifecycles.length) {
    uncertain({ code: 'LIFECYCLE_UNIQUENESS_CONFLICT', workspaceOwnerId: null, operationId: null, canonicalPath: null });
  }
  for (const decision of decisions) {
    addTargetSource({
      projectIdentityId: decision.projectIdentityId,
      projectIdentityGeneration: decision.projectIdentityGeneration,
      workspaceOwnerId: decision.workspaceOwnerId,
      projectName: decision.projectName,
      canonicalRoot: decision.destinationCanonicalRoot,
      rootDevice: decision.destinationRootDevice,
      rootInode: decision.destinationRootInode,
      rootBirthtimeNs: decision.destinationRootBirthtimeNs,
      decisionStatus: decision.status,
      source: {
        kind: 'decision',
        operationId: decision.operationId,
        state: decision.status,
        canonicalPath: null,
        contentSha256: decision.manifestDigest,
      },
    });
  }
  for (const lifecycle of lifecycles) {
    addTargetSource({
      projectIdentityId: lifecycle.id,
      projectIdentityGeneration: lifecycle.generation,
      workspaceOwnerId: lifecycle.workspaceOwnerId,
      projectName: lifecycle.projectName,
      canonicalRoot: lifecycle.canonicalRoot,
      rootDevice: lifecycle.rootDevice,
      rootInode: lifecycle.rootInode,
      rootBirthtimeNs: lifecycle.rootBirthtimeNs,
      lifecycleStatus: lifecycle.lifecycleStatus,
      source: {
        kind: 'lifecycle',
        operationId: decisions.find((decision) => (
          decision.projectIdentityId === lifecycle.id
          && decision.projectIdentityGeneration === lifecycle.generation
        ))?.operationId || null,
        state: lifecycle.lifecycleStatus,
        canonicalPath: lifecycle.canonicalRoot,
        contentSha256: null,
      },
    });
  }

  const ownerEntries = projectsRootInspection.names;
  for (const workspaceOwnerId of ownerEntries) {
    const ownerRoot = path.join(projectsRoot, workspaceOwnerId);
    const ownerAccessRoot = path.join(projectsRootInspection.descriptorPath, workspaceOwnerId);
    let ownerEntry: fs.BigIntStats;
    try {
      ownerEntry = fs.lstatSync(ownerAccessRoot, { bigint: true });
    } catch (error) {
      uncertain({
        code: promotionInspectionErrorCode('OWNER_NAMESPACE', error),
        workspaceOwnerId,
        operationId: null,
        canonicalPath: ownerRoot,
        evidenceSha256: promotionInspectionOpaqueEvidenceDigest(ownerAccessRoot, ownerRoot),
      });
      continue;
    }
    if (ownerEntry.isSymbolicLink() || !ownerEntry.isDirectory()) {
      namespaceSnapshots.set(ownerRoot, {
        canonicalPath: ownerRoot,
        stat: promotionInspectionComparableNamespaceStatSnapshot(ownerEntry),
        names: null,
      });
      if (ownerEntry.isSymbolicLink()) uncertain({
        code: 'OWNER_NAMESPACE_SYMLINK',
        workspaceOwnerId,
        operationId: null,
        canonicalPath: ownerRoot,
        evidenceSha256: promotionInspectionOpaqueEvidenceDigest(ownerAccessRoot, ownerRoot),
      });
      else if (
        decisions.some((decision) => decision.workspaceOwnerId === workspaceOwnerId)
        || lifecycles.some((lifecycle) => lifecycle.workspaceOwnerId === workspaceOwnerId)
      ) uncertain({
        code: 'BOUND_OWNER_NAMESPACE_UNSAFE',
        workspaceOwnerId,
        operationId: null,
        canonicalPath: ownerRoot,
        evidenceSha256: promotionInspectionOpaqueEvidenceDigest(ownerAccessRoot, ownerRoot),
      });
      continue;
    }
    const ownerInspection = openPromotionInspectionDirectory(
      ownerAccessRoot,
      'Project dependency promotion owner namespace',
    );
    namespaceSnapshots.set(ownerRoot, {
      canonicalPath: ownerRoot,
      stat: promotionInspectionComparableNamespaceStatSnapshot(ownerInspection.before),
      names: [...ownerInspection.names],
    });
    const ownerIdentity = promotionInspectionIdentityFromStat(ownerInspection.before);
    const ownerChildBasename = (canonicalChild: string): string | null => {
      if (
        path.dirname(canonicalChild) !== ownerRoot
        || path.basename(canonicalChild) === '.'
        || path.basename(canonicalChild) === '..'
      ) return null;
      return path.basename(canonicalChild);
    };
    const ownerChildAccess = (canonicalChild: string): string => {
      const basename = ownerChildBasename(canonicalChild);
      if (!basename) promotionFail('Project dependency promotion evidence escaped its owner namespace.');
      return path.join(ownerInspection.descriptorPath, basename);
    };
    const ownerChildOpaqueDigest = (canonicalChild: string): string | null => {
      const basename = ownerChildBasename(canonicalChild);
      return basename
        ? promotionInspectionOpaqueEvidenceDigest(
            path.join(ownerInspection.descriptorPath, basename),
            canonicalChild,
          )
        : null;
    };
    try {
    const names = ownerInspection.names;
    const journalTargets = new Map<string, ProjectLifecycleArtifactPromotionJournal>();
    const preparationTargets = new Map<string, ProjectLifecycleArtifactPromotionPreparation>();
    for (const decision of decisions.filter((candidate) => (
      candidate.workspaceOwnerId === workspaceOwnerId
    ))) {
      try {
        addTopologyTarget({
          projectIdentityId: decision.projectIdentityId,
          projectIdentityGeneration: decision.projectIdentityGeneration,
          workspaceOwnerId: decision.workspaceOwnerId,
          projectName: decision.projectName,
          operationParentIdentity: decision.manifest.operationParentIdentity,
          operationParentActualIdentity: ownerIdentity,
          destinationCanonicalRoot: decision.destinationCanonicalRoot,
          destinationIdentity: decision.manifest.destinationIdentity,
          destinationAccessRoot: ownerChildAccess(decision.destinationCanonicalRoot),
          stagingCanonicalRoot: decision.manifest.stagingCanonicalRoot,
          stagingIdentity: decision.manifest.stagingIdentity,
          stagingAccessRoot: ownerChildAccess(decision.manifest.stagingCanonicalRoot),
          operationId: decision.operationId,
          state: decision.status,
          entries: decision.manifest.entries.map((entry) => ({
            artifact: entry.artifact,
            stagedRelativePath: `artifacts/${entry.artifact}`,
            backupRelativePath: `backups/${entry.artifact}`,
          })),
        });
      } catch (error) {
        uncertain({
          code: promotionInspectionErrorCode('DECISION_TOPOLOGY', error),
          workspaceOwnerId,
          operationId: decision.operationId,
          canonicalPath: decision.destinationCanonicalRoot,
          evidenceSha256: ownerChildOpaqueDigest(decision.destinationCanonicalRoot),
        });
      }
    }
    for (const name of names.filter(promotionJournalBasename)) {
      const file = path.join(ownerRoot, name);
      const accessFile = path.join(ownerInspection.descriptorPath, name);
      try {
        const evidence = stablePromotionEvidenceRead(
          accessFile,
          file,
          'Project dependency promotion journal',
          assertPromotionJournalShape,
        );
        const journal = evidence.value;
        if (journal.workspaceOwnerId !== workspaceOwnerId) {
          promotionFail('Project dependency promotion journal changed workspace ownership.');
        }
        journalTargets.set(journal.operationId, journal);
        addJournalTarget(journal, file, evidence.contentSha256);
        try {
          addTopologyTarget({
            ...journal,
            state: journal.state,
            operationParentActualIdentity: ownerIdentity,
            destinationAccessRoot: ownerChildAccess(journal.destinationCanonicalRoot),
            stagingAccessRoot: ownerChildAccess(journal.stagingCanonicalRoot),
          });
        } catch (error) {
          uncertain({
            code: promotionInspectionErrorCode('JOURNAL_TOPOLOGY', error),
            workspaceOwnerId,
            operationId: journal.operationId,
            canonicalPath: journal.destinationCanonicalRoot,
            evidenceSha256: ownerChildOpaqueDigest(journal.destinationCanonicalRoot),
          });
        }
        const decision = decisionsByOperation.get(journal.operationId);
        if (decision) {
          const manifest = projectLifecycleArtifactPromotionManifest(journal);
          if (
            decision.manifestDigest === manifest.manifestDigest
            && canonicalPromotionInspectionJson(decision.manifest)
              === canonicalPromotionInspectionJson(manifest)
            && decision.workspaceOwnerId === workspaceOwnerId
            && decision.destinationCanonicalRoot === journal.destinationCanonicalRoot
          ) {
            exactJournalDecisionOperations.add(journal.operationId);
          } else {
            uncertain({
              code: 'JOURNAL_DECISION_SNAPSHOT_CONFLICT',
              workspaceOwnerId,
              operationId: journal.operationId,
              canonicalPath: file,
              evidenceSha256: evidence.contentSha256,
            });
          }
        }
        const destinationDecision = decisionsByDestination.get(journal.destinationCanonicalRoot);
        if (destinationDecision && destinationDecision.operationId !== journal.operationId) {
          uncertain({
            code: 'JOURNAL_DESTINATION_DECISION_CONFLICT',
            workspaceOwnerId,
            operationId: journal.operationId,
            canonicalPath: file,
            evidenceSha256: evidence.contentSha256,
          });
        }
        if (
          !decision
          && !['PREPARED', 'ABANDONED', 'ROLLING_BACK', 'ROLLED_BACK'].includes(journal.state)
        ) uncertain({
          code: 'MUTATED_JOURNAL_WITHOUT_DECISION',
          workspaceOwnerId,
          operationId: journal.operationId,
          canonicalPath: file,
        });
      } catch (error) {
        uncertain({
          code: promotionInspectionErrorCode('JOURNAL', error),
          workspaceOwnerId,
          operationId: null,
          canonicalPath: file,
          evidenceSha256: promotionInspectionOpaqueEvidenceDigest(accessFile, file),
        });
      }
    }
    for (const name of names) {
      const operationId = promotionStagingOperationId(name);
      if (!operationId) continue;
      const stagingRoot = path.join(ownerRoot, name);
      const stagingAccessRoot = path.join(ownerInspection.descriptorPath, name);
      try {
        const stagingInspection = openPromotionInspectionDirectory(
          stagingAccessRoot,
          'Project dependency promotion staging root',
        );
        const stagingIdentity = promotionInspectionIdentityFromStat(stagingInspection.before);
        if (
          stagingIdentity.uid !== currentOwnerUid()
          || stagingIdentity.gid !== currentOwnerGid()
          || stagingIdentity.mode !== 0o700
        ) {
          fs.closeSync(stagingInspection.descriptor);
          promotionFail('Unjournaled Project dependency staging root is not a private server-owned directory.');
        }
        try {
        const stagingDigest = promotionInspectionTreeDigestFromOpened(
          stagingInspection.descriptor,
          stagingInspection.before,
        );
        const preparationFile = promotionPreparationFile(stagingRoot);
        const preparationAccessFile = path.join(
          stagingInspection.descriptorPath,
          path.basename(preparationFile),
        );
        let preparation: ProjectLifecycleArtifactPromotionPreparation | null = null;
        if (fs.existsSync(preparationAccessFile)) {
          const evidence = stablePromotionEvidenceRead(
            preparationAccessFile,
            preparationFile,
            'Project dependency promotion preparation record',
            assertPromotionPreparationShape,
          );
          preparation = evidence.value;
          if (preparation.workspaceOwnerId !== workspaceOwnerId || preparation.operationId !== operationId) {
            promotionFail('Project dependency promotion preparation changed operation identity.');
          }
          preparationTargets.set(operationId, preparation);
          addPreparationTarget(preparation, preparationFile, evidence.contentSha256);
          try {
            addTopologyTarget({
              ...preparation,
              state: preparation.state,
              operationParentActualIdentity: ownerIdentity,
              destinationAccessRoot: ownerChildAccess(preparation.destinationCanonicalRoot),
              stagingAccessRoot,
              entries: preparation.entries.length > 0
                ? preparation.entries
                : preparation.requestedArtifacts.map((artifact) => ({
                    artifact,
                    stagedRelativePath: `artifacts/${artifact}`,
                    backupRelativePath: `backups/${artifact}`,
                  })),
            });
          } catch (error) {
            uncertain({
              code: promotionInspectionErrorCode('PREPARATION_TOPOLOGY', error),
              workspaceOwnerId,
              operationId,
              canonicalPath: preparation.destinationCanonicalRoot,
              evidenceSha256: ownerChildOpaqueDigest(preparation.destinationCanonicalRoot),
            });
          }
        }
        const journal = journalTargets.get(operationId) || null;
        const bound = preparation || journal;
        if (bound) {
          if (!promotionIdentitiesMatch(stagingIdentity, bound.stagingIdentity)) {
            promotionFail('Project dependency promotion staging changed bound identity.');
          }
          if (preparation && journal && (
            canonicalPromotionInspectionJson({
              operationId: preparation.operationId,
              workspaceOwnerId: preparation.workspaceOwnerId,
              projectName: preparation.projectName,
              projectIdentityId: preparation.projectIdentityId,
              projectIdentityGeneration: preparation.projectIdentityGeneration,
              projectRootBirthtimeNs: preparation.projectRootBirthtimeNs,
              destinationCanonicalRoot: preparation.destinationCanonicalRoot,
              destinationIdentity: preparation.destinationIdentity,
              operationParentCanonicalRoot: preparation.operationParentCanonicalRoot,
              operationParentIdentity: preparation.operationParentIdentity,
              stagingCanonicalRoot: preparation.stagingCanonicalRoot,
              stagingIdentity: preparation.stagingIdentity,
              requestedArtifacts: preparation.requestedArtifacts,
              entries: preparation.entries.map((entry) => ({
                artifact: entry.artifact,
                stagedRelativePath: entry.stagedRelativePath,
                backupRelativePath: entry.backupRelativePath,
                hadTarget: entry.hadTarget,
                originalIdentity: entry.originalIdentity,
                stagedIdentity: entry.stagedIdentity,
                stagedTreeDigest: entry.stagedTreeDigest,
              })),
            }) !== canonicalPromotionInspectionJson({
              operationId: journal.operationId,
              workspaceOwnerId: journal.workspaceOwnerId,
              projectName: journal.projectName,
              projectIdentityId: journal.projectIdentityId,
              projectIdentityGeneration: journal.projectIdentityGeneration,
              projectRootBirthtimeNs: journal.projectRootBirthtimeNs,
              destinationCanonicalRoot: journal.destinationCanonicalRoot,
              destinationIdentity: journal.destinationIdentity,
              operationParentCanonicalRoot: journal.operationParentCanonicalRoot,
              operationParentIdentity: journal.operationParentIdentity,
              stagingCanonicalRoot: journal.stagingCanonicalRoot,
              stagingIdentity: journal.stagingIdentity,
              requestedArtifacts: journal.requestedArtifacts,
              entries: journal.entries.map((entry) => ({
                artifact: entry.artifact,
                stagedRelativePath: entry.stagedRelativePath,
                backupRelativePath: entry.backupRelativePath,
                hadTarget: entry.hadTarget,
                originalIdentity: entry.originalIdentity,
                stagedIdentity: entry.stagedIdentity,
                stagedTreeDigest: entry.stagedTreeDigest,
              })),
            })
          )) promotionFail('Project dependency promotion preparation conflicts with its journal.');
          addTargetSource({
            projectIdentityId: bound.projectIdentityId,
            projectIdentityGeneration: bound.projectIdentityGeneration,
            workspaceOwnerId: bound.workspaceOwnerId,
            projectName: bound.projectName,
            canonicalRoot: bound.destinationCanonicalRoot,
            rootDevice: bound.destinationIdentity.device,
            rootInode: bound.destinationIdentity.inode,
            rootBirthtimeNs: bound.destinationIdentity.birthtimeNs,
            source: {
              kind: 'staging',
              operationId,
              state: preparation?.state || journal?.state || null,
              canonicalPath: stagingRoot,
              contentSha256: stagingDigest,
            },
          });
        } else {
          const stagingNames = stagingInspection.names;
          let safeCleanupCandidate = stagingIdentity.mode === 0o700;
          for (const temporaryName of stagingNames) {
            if (!promotionPreparationTemporaryBasename(temporaryName)) {
              safeCleanupCandidate = false;
              continue;
            }
            const temporary = path.join(stagingRoot, temporaryName);
            const temporaryAccess = path.join(stagingInspection.descriptorPath, temporaryName);
            try {
              const contentSha256 = stablePrivatePromotionEvidenceDigest(
                temporaryAccess,
                'Project dependency preparation temporary record',
              );
              unboundEvidence.push({
                kind: 'preparation_temporary',
                workspaceOwnerId,
                operationId: null,
                canonicalPath: temporary,
                safeCleanupCandidate: true,
                contentSha256,
              });
            } catch (error) {
              safeCleanupCandidate = false;
              uncertain({
                code: promotionInspectionErrorCode('PREPARATION_TEMPORARY', error),
                workspaceOwnerId,
                operationId: null,
                canonicalPath: temporary,
                evidenceSha256: promotionInspectionOpaqueEvidenceDigest(temporaryAccess, temporary),
              });
            }
          }
          unboundEvidence.push({
            kind: 'staging',
            workspaceOwnerId,
            operationId: null,
            canonicalPath: stagingRoot,
            safeCleanupCandidate,
            contentSha256: stagingDigest,
          });
          if (!safeCleanupCandidate) uncertain({
            code: 'UNBOUND_STAGING_UNSAFE',
            workspaceOwnerId,
            operationId: null,
            canonicalPath: stagingRoot,
          });
        }
        if (preparation) {
          for (const temporaryName of stagingInspection.names) {
            if (!promotionPreparationTemporaryBasename(temporaryName)) continue;
            const temporary = path.join(stagingRoot, temporaryName);
            const temporaryAccess = path.join(stagingInspection.descriptorPath, temporaryName);
            try {
              const contentSha256 = stablePrivatePromotionEvidenceDigest(
                temporaryAccess,
                'Project dependency preparation temporary record',
              );
              addTargetSource({
                projectIdentityId: preparation.projectIdentityId,
                projectIdentityGeneration: preparation.projectIdentityGeneration,
                workspaceOwnerId: preparation.workspaceOwnerId,
                projectName: preparation.projectName,
                canonicalRoot: preparation.destinationCanonicalRoot,
                rootDevice: preparation.destinationIdentity.device,
                rootInode: preparation.destinationIdentity.inode,
                rootBirthtimeNs: preparation.destinationIdentity.birthtimeNs,
                source: {
                  kind: 'preparation_temporary',
                  operationId: preparation.operationId,
                  state: preparation.state,
                  canonicalPath: temporary,
                  contentSha256,
                },
              });
            } catch (error) {
              uncertain({
                code: promotionInspectionErrorCode('PREPARATION_TEMPORARY', error),
                workspaceOwnerId,
                operationId,
                canonicalPath: temporary,
                evidenceSha256: promotionInspectionOpaqueEvidenceDigest(temporaryAccess, temporary),
              });
            }
          }
        }
        } finally {
          closeStablePromotionInspectionDirectory(
            stagingInspection,
            'Project dependency promotion staging root',
            stagingRoot,
          );
        }
      } catch (error) {
        uncertain({
          code: promotionInspectionErrorCode('STAGING', error),
          workspaceOwnerId,
          operationId: null,
          canonicalPath: stagingRoot,
          evidenceSha256: promotionInspectionOpaqueEvidenceDigest(stagingAccessRoot, stagingRoot),
        });
      }
    }
    for (const name of names) {
      const operationId = promotionJournalTemporaryOperationId(name);
      if (!operationId) continue;
      const file = path.join(ownerRoot, name);
      const accessFile = path.join(ownerInspection.descriptorPath, name);
      try {
        const contentSha256 = stablePrivatePromotionEvidenceDigest(
          accessFile,
          'Project dependency promotion temporary journal',
        );
        const bound = preparationTargets.get(operationId) || journalTargets.get(operationId) || null;
        if (bound) {
          addTargetSource({
            projectIdentityId: bound.projectIdentityId,
            projectIdentityGeneration: bound.projectIdentityGeneration,
            workspaceOwnerId: bound.workspaceOwnerId,
            projectName: bound.projectName,
            canonicalRoot: bound.destinationCanonicalRoot,
            rootDevice: bound.destinationIdentity.device,
            rootInode: bound.destinationIdentity.inode,
            rootBirthtimeNs: bound.destinationIdentity.birthtimeNs,
            source: {
              kind: 'journal_temporary',
              operationId,
              state: null,
              canonicalPath: file,
              contentSha256,
            },
          });
        } else {
          unboundEvidence.push({
            kind: 'journal_temporary',
            workspaceOwnerId,
            operationId: null,
            canonicalPath: file,
            safeCleanupCandidate: true,
            contentSha256,
          });
        }
      } catch (error) {
        uncertain({
          code: promotionInspectionErrorCode('JOURNAL_TEMPORARY', error),
          workspaceOwnerId,
          operationId: null,
          canonicalPath: file,
          evidenceSha256: promotionInspectionOpaqueEvidenceDigest(accessFile, file),
        });
      }
    }
    for (const target of [...targetMap.values()].filter((candidate) => (
      candidate.workspaceOwnerId === workspaceOwnerId
    ))) {
      const expectedCanonicalRoot = path.join(ownerRoot, target.projectName);
      if (
        !target.projectName
        || path.basename(target.projectName) !== target.projectName
        || target.projectName.includes('\\')
        || path.dirname(expectedCanonicalRoot) !== ownerRoot
        || target.canonicalRoot !== expectedCanonicalRoot
      ) continue;
      const key = targetKey(target);
      attestedTargetKeys.add(key);
      const accessRoot = ownerChildAccess(target.canonicalRoot);
      let targetInspection: PromotionInspectionDirectoryHandle | null = null;
      try {
        targetInspection = openOptionalPromotionInspectionDirectory(
          accessRoot,
          'Project dependency promotion bound target',
        );
        if (!targetInspection) {
          uncertain({
            code: 'BOUND_TARGET_ROOT_UNATTESTED',
            workspaceOwnerId,
            operationId: target.operationIds[0] || null,
            canonicalPath: target.canonicalRoot,
          });
          continue;
        }
        namespaceSnapshots.set(target.canonicalRoot, {
          canonicalPath: target.canonicalRoot,
          stat: promotionInspectionComparableNamespaceStatSnapshot(targetInspection.before),
          names: [...targetInspection.names],
          dependencyArtifactsSha256: crypto.createHash('sha256')
            .update(canonicalPromotionInspectionJson([
              'node_modules',
              'package-lock.json',
              '.deps-installed',
            ].map((artifact) => ({
              artifact,
              topology: promotionInspectionDescendantDigest(targetInspection, artifact),
            }))))
            .digest('hex'),
        });
        const actualRoot = promotionInspectionIdentityFromStat(targetInspection.before);
        if (
          actualRoot.kind !== 'directory'
          || actualRoot.device !== target.rootDevice
          || actualRoot.inode !== target.rootInode
          || actualRoot.birthtimeNs !== target.rootBirthtimeNs
        ) uncertain({
          code: 'BOUND_TARGET_ROOT_UNATTESTED',
          workspaceOwnerId,
          operationId: target.operationIds[0] || null,
          canonicalPath: target.canonicalRoot,
          evidenceSha256: promotionInspectionDirectoryHandleDigest(
            targetInspection,
            target.canonicalRoot,
          ),
        });
      } catch (error) {
        uncertain({
          code: promotionInspectionErrorCode('BOUND_TARGET_ROOT', error),
          workspaceOwnerId,
          operationId: target.operationIds[0] || null,
          canonicalPath: target.canonicalRoot,
          evidenceSha256: promotionInspectionOpaqueEvidenceDigest(
            accessRoot,
            target.canonicalRoot,
          ),
        });
      } finally {
        if (targetInspection) {
          closeStablePromotionInspectionDirectory(
            targetInspection,
            'Project dependency promotion bound target',
            target.canonicalRoot,
          );
        }
      }
    }
    } finally {
      closeStablePromotionInspectionDirectory(
        ownerInspection,
        'Project dependency promotion owner namespace',
        ownerRoot,
      );
    }
  }

  for (const decision of decisions) {
    const lifecycle = lifecyclesByIdentity.get(decision.projectIdentityId);
    if (!lifecycle) uncertain({
      code: 'DECISION_WITHOUT_LIFECYCLE',
      workspaceOwnerId: decision.workspaceOwnerId,
      operationId: decision.operationId,
      canonicalPath: decision.destinationCanonicalRoot,
    });
    if (
      decision.status === 'AUTHORIZED'
      && !exactJournalDecisionOperations.has(decision.operationId)
    ) {
      uncertain({
        code: 'AUTHORIZED_DECISION_WITHOUT_JOURNAL',
        workspaceOwnerId: decision.workspaceOwnerId,
        operationId: decision.operationId,
        canonicalPath: decision.destinationCanonicalRoot,
      });
    }
  }
  for (const lifecycle of lifecycles) {
    if (!decisions.some((decision) => (
      decision.projectIdentityId === lifecycle.id
      && decision.projectIdentityGeneration === lifecycle.generation
    ))) uncertain({
      code: 'LIFECYCLE_WITHOUT_DECISION',
      workspaceOwnerId: lifecycle.workspaceOwnerId,
      operationId: null,
      canonicalPath: lifecycle.canonicalRoot,
    });
  }
  const destinations = new Map<string, string>();
  for (const target of targetMap.values()) {
    const expectedOwnerRoot = path.join(projectsRoot, target.workspaceOwnerId);
    const expectedCanonicalRoot = path.join(expectedOwnerRoot, target.projectName);
    if (
      !target.workspaceOwnerId
      || path.basename(target.workspaceOwnerId) !== target.workspaceOwnerId
      || target.workspaceOwnerId === '.'
      || target.workspaceOwnerId === '..'
      || !target.projectName
      || path.basename(target.projectName) !== target.projectName
      || target.projectName.includes('\\')
      || path.dirname(expectedOwnerRoot) !== projectsRoot
      || path.dirname(expectedCanonicalRoot) !== expectedOwnerRoot
      || target.canonicalRoot !== expectedCanonicalRoot
    ) {
      uncertain({
        code: 'BOUND_TARGET_STORAGE_PATH_UNSAFE',
        workspaceOwnerId: target.workspaceOwnerId,
        operationId: target.operationIds[0] || null,
        canonicalPath: target.canonicalRoot,
      });
      continue;
    }
    if (!attestedTargetKeys.has(targetKey(target))) {
      uncertain({
        code: 'BOUND_TARGET_ROOT_UNATTESTED',
        workspaceOwnerId: target.workspaceOwnerId,
        operationId: target.operationIds[0] || null,
        canonicalPath: target.canonicalRoot,
      });
    }
    const prior = destinations.get(target.canonicalRoot);
    const key = targetKey(target);
    if (prior && prior !== key) uncertain({
      code: 'DESTINATION_TARGET_CONFLICT',
      workspaceOwnerId: target.workspaceOwnerId,
      operationId: target.operationIds[0] || null,
      canonicalPath: target.canonicalRoot,
    });
    else destinations.set(target.canonicalRoot, key);
  }

  const sourceOrder = (source: ProjectDependencyPromotionStartupEvidenceSource): string => (
    `${source.kind}\0${source.operationId || ''}\0${source.canonicalPath || ''}\0${source.state || ''}`
  );
  const targets = [...targetMap.values()].map((target) => ({
    ...target,
    operationIds: [...target.operationIds].sort(),
    sources: [...target.sources].sort((left, right) => sourceOrder(left).localeCompare(sourceOrder(right))),
  })).sort((left, right) => (
    `${left.workspaceOwnerId}\0${left.projectName}\0${left.projectIdentityId}\0${left.projectIdentityGeneration}`
      .localeCompare(`${right.workspaceOwnerId}\0${right.projectName}\0${right.projectIdentityId}\0${right.projectIdentityGeneration}`)
  ));
  unboundEvidence.sort((left, right) => (
    `${left.canonicalPath}\0${left.kind}`.localeCompare(`${right.canonicalPath}\0${right.kind}`)
  ));
  uncertainEvidence.sort((left, right) => (
    `${left.code}\0${left.canonicalPath || ''}\0${left.operationId || ''}`
      .localeCompare(`${right.code}\0${right.canonicalPath || ''}\0${right.operationId || ''}`)
  ));
  const containedQuarantines = targets.filter((target) => (
    target.lifecycleStatus === 'DEPENDENCY_QUARANTINED'
  ));
  const snapshot = {
    schemaVersion: 1 as const,
    namespaces: [...namespaceSnapshots.values()].sort((left, right) => (
      left.canonicalPath.localeCompare(right.canonicalPath)
    )),
    targets,
    containedQuarantines,
    unboundEvidence,
    uncertainEvidence,
  };
  return {
    schemaVersion: 1,
    snapshotSha256: crypto.createHash('sha256')
      .update(canonicalPromotionInspectionJson(snapshot))
      .digest('hex'),
    hasEvidence: targets.length > 0 || unboundEvidence.length > 0 || uncertainEvidence.length > 0,
    targets,
    containedQuarantines,
    unboundEvidence,
    uncertainEvidence,
  };
  } finally {
    closeStablePromotionInspectionDirectory(
      projectsRootInspection,
      'Project dependency promotion storage root',
      projectsRoot,
    );
  }
}

/** Recover every interrupted promotion before the real Portal listener opens. */
async function recoverInterruptedProjectLifecycleArtifactPromotionsInternal(
  projectsRootInput: string,
  database?: ProjectDependencyPromotionDecisionDatabase,
  options: { protectedRepairOperationIds?: readonly string[] } = {},
): Promise<{ rolledBack: number; committed: number; quarantined: number; discarded: number }> {
  const projectsRoot = assertSafeWorkspace(projectsRootInput);
  const protectedRepairOperationIds = new Set(options.protectedRepairOperationIds || []);
  const [decisions, lifecycles] = await Promise.all([
    listAllProjectDependencyPromotionDecisions(database),
    listAllProjectDependencyPromotionLifecycles(database),
  ]);
  const decisionsByOperation = new Map(decisions.map((decision) => [decision.operationId, decision]));
  const decisionsByDestination = new Map(decisions.map((decision) => [
    decision.destinationCanonicalRoot,
    decision,
  ]));
  if (decisionsByOperation.size !== decisions.length || decisionsByDestination.size !== decisions.length) {
    promotionFail('Dependency promotion decisions do not have unique operation and destination bindings.');
  }
  const lifecyclesByIdentity = new Map(lifecycles.map((identity) => [identity.id, identity]));
  if (lifecyclesByIdentity.size !== lifecycles.length) {
    promotionFail('Dependency promotion lifecycle identities are not unique.');
  }
  for (const decision of decisions) {
    const lifecycle = lifecyclesByIdentity.get(decision.projectIdentityId);
    if (!lifecycle
      || lifecycle.workspaceOwnerId !== decision.workspaceOwnerId
      || lifecycle.projectName !== decision.projectName
      || lifecycle.canonicalRoot !== decision.destinationCanonicalRoot
      || lifecycle.rootDevice !== decision.destinationRootDevice
      || lifecycle.rootInode !== decision.destinationRootInode
      || lifecycle.rootBirthtimeNs !== decision.destinationRootBirthtimeNs
      || lifecycle.generation !== decision.projectIdentityGeneration) {
      promotionFail('Dependency promotion decision and lifecycle containment are inconsistent.');
    }
  }
  for (const lifecycle of lifecycles) {
    const decision = decisions.find((candidate) => candidate.projectIdentityId === lifecycle.id);
    if (!decision) {
      promotionFail('A dependency promotion lifecycle fence has no durable decision.');
    }
  }
  const seenDecisions = new Set<string>();
  let rolledBack = 0;
  let committed = 0;
  let discarded = 0;
  let quarantined = 0;
  for (const workspaceOwnerId of fs.readdirSync(projectsRoot).sort()) {
    const ownerRoot = path.join(projectsRoot, workspaceOwnerId);
    const ownerEntry = fs.lstatSync(ownerRoot);
    const ownerHasDecision = decisions.some((decision) => (
      decision.workspaceOwnerId === workspaceOwnerId
    ));
    if (ownerEntry.isSymbolicLink() || !ownerEntry.isDirectory()) {
      if (ownerHasDecision) {
        promotionFail('A decision-bound Project owner namespace cannot be attested.');
      }
      // Do not follow unrelated legacy/debris entries. They cannot contain
      // Portal promotion evidence without first becoming an owner directory.
      console.warn('[Project Dependencies] Ignoring unrelated non-directory owner namespace entry.');
      continue;
    }
    for (const name of fs.readdirSync(ownerRoot).filter(promotionJournalBasename).sort()) {
      const file = path.join(ownerRoot, name);
      const journal = readPromotionJournal(file);
      if (protectedRepairOperationIds.has(journal.operationId)) {
        promotionFail('Generic recovery encountered evidence owned by a dependency repair.');
      }
      if (journal.workspaceOwnerId !== workspaceOwnerId) {
        promotionFail('Project dependency promotion journal changed workspace ownership.');
      }
      const release = await acquireProjectDeletionLockWithoutGuard(
        projectDeletionLockKey(journal.workspaceOwnerId, journal.projectName),
      );
      try {
        const manifest = projectLifecycleArtifactPromotionManifest(journal);
        const decision = decisionsByOperation.get(manifest.operationId) || null;
        const destinationDecision = decisionsByDestination.get(journal.destinationCanonicalRoot);
        if (destinationDecision && destinationDecision.operationId !== manifest.operationId) {
          promotionFail('Filesystem promotion evidence conflicts with another durable destination decision.');
        }
        const result = await recoverPromotionJournalFile(file, decision, release, database);
        if (decision) seenDecisions.add(decision.operationId);
        if (result === 'committed') committed += 1;
        else if (result === 'quarantined') quarantined += 1;
        else rolledBack += 1;
      } finally {
        release();
      }
    }
    for (const name of fs.readdirSync(ownerRoot).sort()) {
      if (!promotionStagingOperationId(name)) continue;
      const stagingRoot = path.join(ownerRoot, name);
      const operationId = promotionStagingOperationId(name)!;
      if (protectedRepairOperationIds.has(operationId)) {
        promotionFail('Generic recovery encountered staging owned by a dependency repair.');
      }
      if (fs.existsSync(promotionJournalFile(ownerRoot, operationId))) continue;
      const evidenceDecision = decisionsByOperation.get(operationId);
      if (evidenceDecision) {
        if (evidenceDecision.status === 'AUTHORIZED') {
          promotionFail('An authorized dependency promotion decision has staging evidence but no journal.');
        }
        continue;
      }
      const preparationFile = promotionPreparationFile(stagingRoot);
      if (!fs.existsSync(preparationFile)) {
        if (await discardUnjournaledPromotionStagingRoot(stagingRoot, {
          allowUnboundEmpty: true,
        })) discarded += 1;
        continue;
      }
      const preparation = readPromotionPreparation(preparationFile);
      if (preparation.workspaceOwnerId !== workspaceOwnerId) {
        promotionFail('Project dependency preparation record changed workspace ownership.');
      }
      const release = await acquireProjectDeletionLockWithoutGuard(
        projectDeletionLockKey(preparation.workspaceOwnerId, preparation.projectName),
      );
      try {
        if (await discardUnjournaledPromotionStagingRoot(stagingRoot, {
          expectedDestination: preparation.destinationCanonicalRoot,
        })) discarded += 1;
      } finally {
        release();
      }
    }
    for (const name of fs.readdirSync(ownerRoot).sort()) {
      const operationId = promotionJournalTemporaryOperationId(name);
      if (operationId && !fs.existsSync(promotionJournalFile(ownerRoot, operationId))) {
        const evidenceDecision = decisionsByOperation.get(operationId);
        if (evidenceDecision?.status === 'AUTHORIZED') {
          promotionFail('An authorized dependency promotion decision has only temporary journal evidence.');
        }
      }
    }
    discarded += discardUnjournaledPromotionJournalTemporaries(
      ownerRoot,
      undefined,
      new Set(decisions
        .filter((decision) => decision.workspaceOwnerId === workspaceOwnerId)
        .map((decision) => decision.operationId)),
    );
  }
  for (const decision of decisions) {
    if (protectedRepairOperationIds.has(decision.operationId)) {
      promotionFail('Generic recovery encountered a decision owned by a dependency repair.');
    }
    if (seenDecisions.has(decision.operationId)) continue;
    if (decision.status === 'AUTHORIZED') {
      promotionFail('An authorized dependency promotion decision has no durable journal evidence.');
    }
    const lifecycleLock = await acquireProjectDeletionLockWithoutGuard(projectDeletionLockKey(
      decision.workspaceOwnerId,
      decision.projectName,
    ));
    try {
      const result = await recoverAppliedPromotionDecisionWithoutJournal(
        decision,
        lifecycleLock,
        database,
      );
      if (result === 'committed') committed += 1;
      else quarantined += 1;
    } finally {
      lifecycleLock();
    }
  }
  return { rolledBack, committed, quarantined, discarded };
}

export async function recoverInterruptedProjectLifecycleArtifactPromotions(
  projectsRootInput: string,
  database?: ProjectDependencyPromotionDecisionDatabase,
  options: { protectedRepairOperationIds?: readonly string[] } = {},
): Promise<{ rolledBack: number; committed: number; quarantined: number; discarded: number }> {
  try {
    return await recoverInterruptedProjectLifecycleArtifactPromotionsInternal(
      projectsRootInput,
      database,
      options,
    );
  } catch (error) {
    if (error instanceof ProjectLifecycleArtifactPromotionRecoveryError) throw error;
    promotionFail(
      `Dependency promotion database/filesystem reconciliation failed (${String(
        (error as { code?: unknown })?.code || (error as Error)?.name || 'unknown',
      ).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}).`,
    );
  }
}

async function recoverInterruptedProjectLifecycleArtifactPromotionForLockInternal(input: {
  key: string;
  workspaceOwnerId: string;
  projectName: string;
  lifecycleLock: ProjectDeletionLockLease;
}): Promise<void> {
  const { resolveProjectStoragePaths } = await import('./projectStoragePaths');
  const configuredProjectsRoot = resolveProjectStoragePaths().projectsDir;
  assertHeldProjectDeletionLockLease(input.lifecycleLock, input.key);
  const assertLifecycleAdmissionOpen = async (): Promise<void> => {
    const contained = await readProjectDependencyPromotionLifecycleByProject({
      workspaceOwnerId: input.workspaceOwnerId,
      projectName: input.projectName,
    });
    if (contained) {
      throw promotionContained(
        contained.lifecycleStatus === 'DEPENDENCY_QUARANTINED'
          ? 'This Project is quarantined after an interrupted dependency promotion. Use the authenticated recovery flow.'
          : 'This Project is still completing an interrupted dependency promotion. Try again after recovery.',
      );
    }
  };
  if (!fs.existsSync(configuredProjectsRoot)) {
    await assertLifecycleAdmissionOpen();
    return;
  }
  const projectsRoot = assertSafeWorkspace(configuredProjectsRoot);
  const ownerRoot = path.join(projectsRoot, input.workspaceOwnerId);
  const destination = path.join(ownerRoot, input.projectName);
  const decision = await findProjectDependencyPromotionDecisionByDestination({
    destinationCanonicalRoot: destination,
  });
  const destinationEntry = optionalPromotionIdentity(destination);
  if (destinationEntry) {
    if (destinationEntry.kind !== 'directory') {
      promotionFail('Project dependency promotion destination is not a directory.');
    }
    await recoverInterruptedProjectLifecycleArtifactPromotionUnderLock(
      destination,
      input.lifecycleLock,
    );
    await assertLifecycleAdmissionOpen();
    return;
  }
  if (decision) {
    if (decision.status === 'AUTHORIZED') {
      promotionFail('An authorized dependency promotion decision lost its Project destination.');
    }
    const result = await recoverAppliedPromotionDecisionWithoutJournal(
      decision,
      input.lifecycleLock,
    );
    if (result === 'quarantined') {
      throw promotionContained(
        'This Project is quarantined after an interrupted dependency promotion. Use the authenticated recovery flow.',
      );
    }
    await assertLifecycleAdmissionOpen();
    return;
  }
  if (!fs.existsSync(ownerRoot)) {
    // Filesystem evidence is optional. A lifecycle-only containment row is
    // still authoritative and must close every owner/name mutation lane.
    await assertLifecycleAdmissionOpen();
    return;
  }
  for (const name of fs.readdirSync(ownerRoot).sort()) {
    if (promotionJournalBasename(name)) {
      const journal = readPromotionJournal(path.join(ownerRoot, name));
      if (journal.destinationCanonicalRoot === destination) {
        promotionFail('Unresolved Project dependency promotion evidence blocks lifecycle mutation.');
      }
      continue;
    }
    if (!promotionStagingOperationId(name)) continue;
    const stagingRoot = path.join(ownerRoot, name);
    const preparationFile = promotionPreparationFile(stagingRoot);
    if (!fs.existsSync(preparationFile)) {
      // An empty root or known preparation temp has no target binding and no
      // live mutation; startup owns its cleanup and it cannot block another
      // missing Project name.
      continue;
    }
    const preparation = readPromotionPreparation(preparationFile);
    if (preparation.destinationCanonicalRoot === destination) {
      promotionFail('Unresolved Project dependency preparation blocks lifecycle mutation.');
    }
  }
  await assertLifecycleAdmissionOpen();
}

export async function recoverInterruptedProjectLifecycleArtifactPromotionForLock(input: {
  key: string;
  workspaceOwnerId: string;
  projectName: string;
  lifecycleLock: ProjectDeletionLockLease;
}): Promise<void> {
  try {
    await recoverInterruptedProjectLifecycleArtifactPromotionForLockInternal(input);
  } catch (error) {
    if (error instanceof ProjectLifecycleArtifactPromotionRecoveryError) throw error;
    promotionFail(
      `Dependency promotion lifecycle reconciliation failed (${String(
        (error as { code?: unknown })?.code || (error as Error)?.name || 'unknown',
      ).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}).`,
    );
  }
}

/**
 * Copy dependency artifacts into a sibling staging directory asynchronously,
 * leaving the live Project untouched. The returned commit is deliberately a
 * tiny sequence of same-filesystem renames so a caller can hold its durable
 * authorization lock across the only live mutation without blocking the event
 * loop for a recursive copy.
 */
export async function prepareProjectLifecycleArtifactPromotion(
  workspace: string,
  destination: string,
  artifacts: readonly string[],
  projectProof: ProjectLifecycleArtifactPromotionProjectProof,
  options: {
    testCheckpoint?: (checkpoint: ProjectLifecycleArtifactPromotionCheckpoint) => void;
  } = {},
): Promise<PreparedProjectLifecycleArtifactPromotion> {
  const sourceRoot = assertSafeWorkspace(workspace);
  const destinationRoot = assertSafeWorkspace(destination);
  if (
    !projectProof.projectIdentityId
    || !Number.isSafeInteger(projectProof.projectIdentityGeneration)
    || projectProof.projectIdentityGeneration < 1
    || projectProof.workspaceOwnerId !== path.basename(path.dirname(destinationRoot))
    || projectProof.projectName !== path.basename(destinationRoot)
    || projectProof.canonicalRoot !== destinationRoot
    || !/^\d+$/.test(projectProof.rootDevice)
    || !/^\d+$/.test(projectProof.rootInode)
    || !/^\d+$/.test(projectProof.rootBirthtimeNs)
  ) promotionFail('Project dependency promotion Project identity proof is invalid.');
  if (
    artifacts.length === 0
    || artifacts.length > 16
    || new Set(artifacts).size !== artifacts.length
    || !artifacts.every((artifact) => /^[a-zA-Z0-9._-]+$/.test(artifact))
  ) throw new Error('Invalid project lifecycle artifact list');

  const operationParent = path.dirname(destinationRoot);
  const operationId = crypto.randomUUID();
  const stagingRoot = promotionStagingRoot(operationParent, operationId);
  const journalFile = promotionJournalFile(operationParent, operationId);
  const operationParentIdentity = promotionIdentity(operationParent);
  const destinationIdentity = promotionIdentity(destinationRoot);
  if (
    destinationIdentity.device !== projectProof.rootDevice
    || destinationIdentity.inode !== projectProof.rootInode
    || destinationIdentity.birthtimeNs !== projectProof.rootBirthtimeNs
    || destinationIdentity.device !== operationParentIdentity.device
  ) promotionFail('Project dependency promotion destination changed identity before preparation.');
  await fs.promises.mkdir(stagingRoot, { mode: 0o700 });
  await fs.promises.chmod(stagingRoot, 0o700);
  const stagingIdentity = promotionIdentity(stagingRoot);
  options.testCheckpoint?.('after-staging-root');
  const now = new Date().toISOString();
  const preparation: ProjectLifecycleArtifactPromotionPreparation = {
    schemaVersion: 1,
    operationId,
    workspaceOwnerId: path.basename(operationParent),
    projectName: path.basename(destinationRoot),
    projectIdentityId: projectProof.projectIdentityId,
    projectIdentityGeneration: projectProof.projectIdentityGeneration,
    projectRootBirthtimeNs: projectProof.rootBirthtimeNs,
    destinationCanonicalRoot: destinationRoot,
    destinationIdentity,
    operationParentCanonicalRoot: operationParent,
    operationParentIdentity,
    stagingCanonicalRoot: stagingRoot,
    stagingIdentity,
    requestedArtifacts: [...artifacts],
    entries: [],
    state: 'COPYING',
    createdAt: now,
    updatedAt: now,
  };
  writePromotionPreparation(
    promotionPreparationFile(stagingRoot),
    preparation,
    true,
    () => options.testCheckpoint?.('after-preparation-temp'),
  );
  fsyncPromotionDirectory(operationParent);
  options.testCheckpoint?.('after-preparation-create');
  const stagedRoot = path.join(stagingRoot, 'artifacts');
  const backupRoot = path.join(stagingRoot, 'backups');
  await fs.promises.mkdir(stagedRoot, { mode: 0o700 });
  await fs.promises.mkdir(backupRoot, { mode: 0o700 });

  const entries: ProjectLifecycleArtifactPromotionEntry[] = [];
  let journal: ProjectLifecycleArtifactPromotionJournal | null = null;
  let committed = false;
  let rolledBack = false;
  let finalized = false;
  let cleanupPromise: Promise<void> | null = null;

  try {
    for (const [index, artifact] of artifacts.entries()) {
      const source = path.join(sourceRoot, artifact);
      const target = path.join(destinationRoot, artifact);
      let sourceEntry: fs.Stats | null = null;
      try {
        sourceEntry = await fs.promises.lstat(source);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (sourceEntry && (
        sourceEntry.isSymbolicLink()
        || (!sourceEntry.isDirectory() && !sourceEntry.isFile())
      )) {
        throw new Error('Project lifecycle artifact has an unsupported root type');
      }
      const stagedPath = path.join(stagedRoot, artifact);
      if (sourceEntry) {
        await fs.promises.cp(source, stagedPath, {
          recursive: sourceEntry.isDirectory(),
          dereference: false,
        });
        await fsyncPromotionTree(stagedPath);
        options.testCheckpoint?.(`after-copy:${index}`);
      }
      const originalIdentity = optionalPromotionIdentity(target);
      const stagedIdentity = sourceEntry ? promotionIdentity(stagedPath) : null;
      const stagedTreeDigest = sourceEntry ? promotionTreeDigest(stagedPath) : null;
      entries.push({
        artifact,
        stagedRelativePath: `artifacts/${artifact}`,
        backupRelativePath: `backups/${artifact}`,
        hadTarget: originalIdentity !== null,
        originalIdentity,
        stagedIdentity,
        stagedTreeDigest,
        phase: stagedIdentity ? 'PREPARED' : 'UNCHANGED',
      });
    }

    await fsyncPromotionTree(stagingRoot);
    fsyncPromotionDirectory(destinationRoot);
    fsyncPromotionDirectory(operationParent);
    preparation.entries = entries.map((entry) => ({ ...entry }));
    preparation.state = 'PREPARED';
    writePromotionPreparation(
      promotionPreparationFile(stagingRoot),
      preparation,
      false,
      () => options.testCheckpoint?.('after-preparation-ready-temp'),
    );
    options.testCheckpoint?.('after-preparation-ready');
    journal = {
      schemaVersion: 1,
      operationId,
      workspaceOwnerId: path.basename(operationParent),
      projectName: path.basename(destinationRoot),
      projectIdentityId: projectProof.projectIdentityId,
      projectIdentityGeneration: projectProof.projectIdentityGeneration,
      projectRootBirthtimeNs: projectProof.rootBirthtimeNs,
      destinationCanonicalRoot: destinationRoot,
      destinationIdentity,
      operationParentCanonicalRoot: operationParent,
      operationParentIdentity,
      stagingCanonicalRoot: stagingRoot,
      stagingIdentity,
      requestedArtifacts: [...artifacts],
      entries,
      state: 'PREPARED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writePromotionJournal(
      journalFile,
      journal,
      true,
      () => options.testCheckpoint?.('after-journal-temp'),
    );
    options.testCheckpoint?.('after-journal-create');
    fsyncPromotionDirectory(stagedRoot);
    fsyncPromotionDirectory(backupRoot);
    fsyncPromotionDirectory(destinationRoot);
    fsyncPromotionDirectory(operationParent);
  } catch (error) {
    // No live artifact rename can happen during preparation. If a final
    // journal was published, retire it durably before deleting its staging
    // identity so a second crash never strands a journal that appears to have
    // lost mutation evidence.
    try {
      fs.unlinkSync(journalFile);
      fsyncPromotionDirectory(operationParent);
    } catch (unlinkError: any) {
      if (unlinkError?.code !== 'ENOENT') throw unlinkError;
    }
    await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    try { fsyncPromotionDirectory(operationParent); } catch {}
    throw error;
  }

  const requireJournal = (): ProjectLifecycleArtifactPromotionJournal => {
    if (!journal) promotionFail('Project dependency promotion lost its durable journal.');
    return journal;
  };

  const rollback = () => {
    if (finalized) promotionFail('A finalized Project dependency promotion cannot be rolled back.');
    const current = requireJournal();
    if (rolledBack) return;
    rollbackPromotionJournal(journalFile, current);
    rolledBack = true;
  };

  const commit = () => {
    const current = requireJournal();
    if (committed) throw new Error('Project lifecycle artifact promotion was already committed');
    if (cleanupPromise) throw new Error('Project lifecycle artifact promotion was already cleaned');
    committed = true;
    try {
      convergePromotionJournalToAllNew(journalFile, current, options.testCheckpoint);
    } catch (firstError) {
      // A transient rename/fsync/write failure may have happened after the
      // filesystem mutation. Re-attest topology and continue only forward.
      // Persistent/ambiguous failures leave evidence for guarded recovery.
      try {
        convergePromotionJournalToAllNew(journalFile, current, options.testCheckpoint);
      } catch {
        throw firstError;
      }
    }
  };

  const finalize = () => {
    const current = requireJournal();
    if (!committed || rolledBack || current.state !== 'SWAPPED') {
      promotionFail('Project dependency promotion cannot finalize before a verified swap.');
    }
    verifyAllNewGeneration(current);
    options.testCheckpoint?.('before-committed');
    const committedJournal: ProjectLifecycleArtifactPromotionJournal = {
      ...current,
      entries: current.entries.map((entry) => ({ ...entry })),
      state: 'COMMITTED',
    };
    writePromotionJournal(
      journalFile,
      committedJournal,
      false,
      () => options.testCheckpoint?.('after-committed-temp'),
    );
    Object.assign(current, committedJournal);
    options.testCheckpoint?.('after-committed');
    finalized = true;
  };

  const cleanup = (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        const current = requireJournal();
        if (!finalized && !rolledBack) {
          if (!committed && (current.state === 'PREPARED' || current.state === 'ABANDONED')) {
            abandonPreparedPromotion(journalFile, current);
          } else {
            rollback();
          }
        }
        await removePromotionEvidence(journalFile, current, options.testCheckpoint);
      })();
    }
    return cleanupPromise;
  };

  const cleanupPreparedStagingOnly = (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        const current = requireJournal();
        if (committed || rolledBack || finalized) {
          promotionFail('Committed Project dependency evidence cannot use staging-only cleanup.');
        }
        await removePreparedPromotionPrivateEvidence(
          journalFile,
          current,
          options.testCheckpoint,
        );
      })();
    }
    return cleanupPromise;
  };

  return {
    manifest: projectLifecycleArtifactPromotionManifest(requireJournal()),
    reattest: () => {
      const current = requireJournal();
      try {
        verifyAllOldGeneration(current);
      } catch (error) {
        abandonPreparedPromotion(journalFile, current);
        throw error;
      }
    },
    commit,
    rollback,
    finalize,
    cleanup,
    cleanupPreparedStagingOnly,
  };
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
  stagingRoot: string;
  stagingIdentity: {
    rootDevice: string;
    rootInode: string;
    rootBirthtimeNs: string;
  };
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

export function fingerprintFullstackDeploymentTree(root: string): string {
  const normalized = path.resolve(String(root || ''));
  if (
    !path.isAbsolute(root)
    || normalized !== root
    || fs.realpathSync.native(root) !== root
  ) throw new Error('Deployment fingerprint root is unsafe');
  return fingerprintCopiedDeploymentTree(root);
}

function prepareDeploymentTree(
  source: string,
  destination: string,
  options: {
    excludeStaticPrivateFiles: boolean;
    expectedSourceDigest?: string;
    preparationNonce?: string;
  },
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

  const nonce = options.preparationNonce
    ? String(options.preparationNonce)
    : `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nonce)) {
    throw new Error('Deployment preparation identity is invalid');
  }
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
  const stagingBigIntEntry = fs.lstatSync(stagingRoot, { bigint: true });
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
    stagingRoot,
    stagingIdentity: {
      rootDevice: stagingBigIntEntry.dev.toString(),
      rootInode: stagingBigIntEntry.ino.toString(),
      rootBirthtimeNs: stagingBigIntEntry.birthtimeNs.toString(),
    },
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
  preparationNonce?: string,
): ProjectDeploymentPromotion {
  return prepareDeploymentTree(source, destination, {
    excludeStaticPrivateFiles: false,
    ...(expectedSourceDigest ? { expectedSourceDigest } : {}),
    ...(preparationNonce ? { preparationNonce } : {}),
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
