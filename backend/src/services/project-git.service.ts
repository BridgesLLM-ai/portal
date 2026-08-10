/**
 * Isolated Git control plane for Portal projects.
 *
 * Project repositories are attacker-controlled input. Git can execute hooks,
 * filters, credential helpers, remote helpers, pagers, editors, and signing
 * programs from repository configuration. Every Portal-owned Git invocation
 * therefore runs as an unprivileged user inside the project runtime image with
 * one project bind and a deliberately empty configuration/credential context.
 */

import { ChildProcess, execFileSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PROJECT_RUNTIME_GID, PROJECT_RUNTIME_IMAGE, PROJECT_RUNTIME_UID } from './project-lifecycle.service';
import {
  preparePortalProjectWorkloadContainer,
  removePreparedPortalProjectWorkloadContainer,
  resolvePinnedProjectRuntimeImage,
  type PortalProjectWorkloadPlan,
} from './projectWorkloadRuntime';

const DOCKER_BIN = '/usr/bin/docker';
const PROJECT_MOUNT = '/workspace/project';
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
// The OpenClaw project-sandbox image deliberately uses 1000:1000. Keeping
// project repositories on that identity preserves Project Chat write access
// after Portal Git operations while remaining non-root in both containers.
export const PROJECT_GIT_UID = PROJECT_RUNTIME_UID;
export const PROJECT_GIT_GID = PROJECT_RUNTIME_GID;

const SAFE_GIT_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.sshCommand=/bin/false',
  '-c', 'credential.helper=',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.http.allow=never',
  '-c', 'protocol.ssh.allow=never',
  '-c', 'protocol.file.allow=never',
  '-c', 'diff.external=',
  '-c', 'http.followRedirects=false',
  '-c', 'core.pager=cat',
  '-c', 'pager.branch=false',
  '-c', 'pager.diff=false',
  '-c', 'pager.log=false',
  '-c', 'interactive.singleKey=false',
  '-c', 'sequence.editor=true',
  '-c', 'core.editor=true',
  '-c', 'commit.gpgSign=false',
  '-c', 'tag.gpgSign=false',
  '-c', 'user.name=BridgesLLM Project Assistant',
  '-c', 'user.email=project-assistant@localhost',
] as const;

const ALLOWED_SUBCOMMANDS = new Set([
  'add',
  'branch',
  'cat-file',
  'checkout',
  'clone',
  'commit',
  'diff',
  'init',
  'log',
  'pull',
  'push',
  'remote',
  'rev-list',
  'rev-parse',
  'revert',
  'show',
  'stash',
  'status',
]);

const FORBIDDEN_CONFIG_SECTIONS = new Set([
  'alias',
  'credential',
  'diff',
  'filter',
  'gpg',
  'include',
  'includeif',
  'interactive',
  'merge',
  'pager',
  'sendemail',
  'url',
]);

const FORBIDDEN_CORE_KEYS = new Set([
  'editor',
  'fsmonitor',
  'hookspath',
  'pager',
  'sshcommand',
  'worktree',
]);

export interface ProjectGitCommandOptions {
  actorId: string;
  projectId: string;
  workspace: string;
  args: string[];
  timeoutMs?: number;
  network?: boolean;
  signal?: AbortSignal;
  nameHint?: string;
  maxOutputBytes?: number;
}

export interface ProjectGitProcess {
  process: ChildProcess;
  containerName: string;
  result: Promise<string>;
  cancel: () => void;
  cleanup: Promise<void>;
  plan: PortalProjectWorkloadPlan;
}

export class ProjectGitCommandError extends Error {
  stdout: string;
  stderr: string;
  code?: number | string | null;

  constructor(message: string, stdout = '', stderr = '', code?: number | string | null) {
    super(message);
    this.name = 'ProjectGitCommandError';
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
  }
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
    throw new Error('Refusing unsafe project Git workspace');
  }
  const entry = fs.lstatSync(resolved);
  if (entry.isSymbolicLink()) throw new Error('Project Git workspace cannot be a symbolic link');
  const canonical = fs.realpathSync(resolved);
  if (canonical !== resolved) throw new Error('Project Git workspace must use its canonical path');
  if (!fs.statSync(canonical).isDirectory()) throw new Error('Project Git workspace must be a directory');
  return canonical;
}

function parseConfigValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([\\"])/g, '$1');
  }
  const comment = trimmed.search(/\s[;#]/);
  return (comment >= 0 ? trimmed.slice(0, comment) : trimmed).trim();
}

function isPrivateOrLocalAddress(host: string): boolean {
  return host === '0.0.0.0'
    || host === '::'
    || host === '::1'
    || host === '169.254.169.254'
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
    || /^198\.(1[89])\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^::ffff:/i.test(host)
    || /^fc[0-9a-f]{2}:/i.test(host)
    || /^fd[0-9a-f]{2}:/i.test(host)
    || /^fe[89ab][0-9a-f]:/i.test(host);
}

/** HTTPS-only repository URL contract. Credentials and local/private targets
 * are rejected so repository configuration cannot smuggle remote helpers or
 * Portal-host access into a fetch/push operation. */
export function assertSafeProjectGitUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw new Error('Repository URL is required');
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Repository URL must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS Git remotes are supported');
  if (parsed.username || parsed.password) throw new Error('Repository URLs cannot contain credentials');
  const normalizedHostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (
    !parsed.hostname
    || normalizedHostname === 'localhost'
    || normalizedHostname.endsWith('.localhost')
    || normalizedHostname.endsWith('.local')
    || normalizedHostname.endsWith('.internal')
  ) throw new Error('Local Git remotes are not allowed');
  if (parsed.port && parsed.port !== '443') throw new Error('Git remotes must use the standard HTTPS port');

  const host = normalizedHostname.replace(/^\[|\]$/g, '');
  if (isPrivateOrLocalAddress(host)) {
    throw new Error('Local or private Git remotes are not allowed');
  }
  return parsed.toString();
}

/**
 * Reject executable or path-rebinding repository-local configuration before
 * Git ever parses the repository. Normal remotes are allowed only when their
 * URL passes the Portal HTTPS contract.
 */
export function assertSafeProjectGitRepository(
  workspace: string,
  allowMissing = false,
  validateRemotes = true,
  remoteUrls?: string[],
): string {
  const canonical = assertSafeWorkspace(workspace);
  const dotGit = path.join(canonical, '.git');
  if (!fs.existsSync(dotGit)) {
    if (allowMissing) return canonical;
    throw new Error('Project is not a Git repository');
  }
  const gitEntry = fs.lstatSync(dotGit);
  if (gitEntry.isSymbolicLink() || !gitEntry.isDirectory()) {
    throw new Error('Project .git must be a directory inside the project workspace');
  }
  const gitCanonical = fs.realpathSync(dotGit);
  if (gitCanonical !== dotGit || !gitCanonical.startsWith(`${canonical}${path.sep}`)) {
    throw new Error('Project Git metadata cannot leave the project workspace');
  }

  const configPath = path.join(dotGit, 'config');
  if (!fs.existsSync(configPath)) return canonical;
  const configEntry = fs.lstatSync(configPath);
  if (configEntry.isSymbolicLink() || !configEntry.isFile()) {
    throw new Error('Project Git config must be a regular file');
  }
  if (configEntry.size > 1024 * 1024) throw new Error('Project Git config is too large');

  let section = '';
  for (const originalLine of fs.readFileSync(configPath, 'utf8').split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase().split('.')[0];
      if (FORBIDDEN_CONFIG_SECTIONS.has(section)) {
        throw new Error(`Unsafe project Git config section: ${section}`);
      }
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9][A-Za-z0-9.-]*)\s*(?:=\s*(.*))?$/);
    if (!keyMatch) throw new Error('Malformed project Git config');
    const key = keyMatch[1].toLowerCase();
    const value = parseConfigValue(keyMatch[2] || '');
    if (section === 'core' && FORBIDDEN_CORE_KEYS.has(key)) {
      throw new Error(`Unsafe project Git config key: core.${key}`);
    }
    if (section === 'commit' && key === 'gpgsign') {
      throw new Error('Unsafe project Git signing configuration');
    }
    if (section === 'tag' && key === 'gpgsign') {
      throw new Error('Unsafe project Git signing configuration');
    }
    if (validateRemotes && section === 'remote' && (key === 'url' || key === 'pushurl')) {
      const safeRemoteUrl = assertSafeProjectGitUrl(value);
      remoteUrls?.push(safeRemoteUrl);
    }
    if (validateRemotes && section === 'remote' && ['proxy', 'receivepack', 'uploadpack', 'vcs'].includes(key)) {
      throw new Error(`Unsafe project Git remote configuration: ${key}`);
    }
    if (validateRemotes && section === 'http' && ['proxy', 'proxycommand'].includes(key)) {
      throw new Error(`Unsafe project Git HTTP configuration: ${key}`);
    }
  }
  return canonical;
}

function assertAllowedArguments(args: readonly string[]): void {
  if (!Array.isArray(args) || args.length === 0 || !ALLOWED_SUBCOMMANDS.has(args[0])) {
    throw new Error('Project Git subcommand is not allowed');
  }
  if (args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('Invalid project Git argument');
  }
  if (args[0] === 'clone') {
    if (args.length !== 5 || args[1] !== '--depth' || args[2] !== '1' || args[4] !== '.') {
      throw new Error('Project Git clone arguments are not allowed');
    }
    assertSafeProjectGitUrl(args[3]);
  }
  if (args[0] === 'pull' && (args.length !== 2 || args[1] !== '--ff-only')) {
    throw new Error('Project Git pull arguments are not allowed');
  }
  if (args[0] === 'push') {
    const upstreamPush = args.length === 4
      && args[1] === '-u'
      && args[2] === 'origin'
      && /^[a-zA-Z0-9_./-]+$/.test(args[3])
      && !args[3].startsWith('-')
      && !args[3].includes('..')
      && !args[3].includes('@{');
    if (args.length !== 1 && !upstreamPush) throw new Error('Project Git push arguments are not allowed');
  }
  if (args[0] === 'remote') {
    const safeRemoteName = (value: string | undefined) => (
      typeof value === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(value)
    );
    if (args.length === 2 && args[1] === '-v') return;
    if (args.length === 3 && args[1] === 'remove' && safeRemoteName(args[2])) return;
    if (args.length === 4 && args[1] === 'add' && safeRemoteName(args[2])) {
      assertSafeProjectGitUrl(args[3]);
      return;
    }
    throw new Error('Project Git remote arguments are not allowed');
  }
}

function commandMutatesWorkspace(args: readonly string[]): boolean {
  if (['add', 'checkout', 'clone', 'commit', 'init', 'pull', 'push', 'revert', 'stash'].includes(args[0])) return true;
  if (args[0] === 'remote') return args[1] !== '-v';
  if (args[0] === 'branch') return args.length > 1 && args[1] !== '-r' && args[1] !== '--remotes';
  return false;
}

function prepareProjectGitWorkspace(workspace: string): string {
  const canonical = assertSafeWorkspace(workspace);
  execFileSync('/usr/bin/chown', [
    '-R',
    '--no-dereference',
    `${PROJECT_GIT_UID}:${PROJECT_GIT_GID}`,
    canonical,
  ], {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: dockerCliEnvironment(),
  });
  return canonical;
}

function projectContainerName(hint: string): string {
  const digest = crypto.createHash('sha256').update(hint).digest('hex').slice(0, 20);
  return `bridgesllm-project-git-${digest}`;
}

export function buildProjectGitContainerArgs(
  options: ProjectGitCommandOptions,
  containerName: string,
): string[] {
  assertAllowedArguments(options.args);
  const workspace = assertSafeProjectGitRepository(
    options.workspace,
    options.args[0] === 'init' || options.args[0] === 'clone',
    options.network === true || options.args[0] === 'clone',
  );
  const args = [
    'run',
    '--name', containerName,
    '--label', 'com.bridgesllm.project-git=true',
    '--init',
    '--user', `${PROJECT_GIT_UID}:${PROJECT_GIT_GID}`,
    '--workdir', PROJECT_MOUNT,
    '--mount', `type=bind,src=${workspace},dst=${PROJECT_MOUNT}`,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '128',
    '--memory', '512m',
    '--cpus', '1',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=128m',
    '--network', 'none',
    '--env', 'HOME=/tmp/project-home',
    '--env', 'XDG_CONFIG_HOME=/tmp/project-config',
    '--env', 'GIT_CONFIG_NOSYSTEM=1',
    '--env', 'GIT_CONFIG_GLOBAL=/dev/null',
    '--env', 'GIT_TERMINAL_PROMPT=0',
    '--env', 'GIT_ASKPASS=/bin/false',
    '--env', 'SSH_ASKPASS=/bin/false',
    '--env', 'GIT_PAGER=cat',
    '--env', 'PAGER=cat',
    '--env', 'GIT_OPTIONAL_LOCKS=0',
  ];
  args.push(PROJECT_RUNTIME_IMAGE, 'git', ...SAFE_GIT_CONFIG, ...options.args);
  return args;
}

function prepareOptions(
  options: ProjectGitCommandOptions,
  normalizeMutatingOwnership: boolean,
): ProjectGitCommandOptions {
  const remoteUrls: string[] = [];
  const checked = assertSafeProjectGitRepository(
    options.workspace,
    options.args[0] === 'init' || options.args[0] === 'clone',
    options.network === true || options.args[0] === 'clone',
    remoteUrls,
  );
  if (options.args[0] === 'clone') remoteUrls.push(assertSafeProjectGitUrl(options.args[3]));
  const workspace = normalizeMutatingOwnership && commandMutatesWorkspace(options.args)
    ? prepareProjectGitWorkspace(checked)
    : checked;
  return { ...options, workspace };
}

async function spawnProjectGitCommandInternal(
  options: ProjectGitCommandOptions,
  normalizeMutatingOwnership: boolean,
): Promise<ProjectGitProcess> {
  const prepared = prepareOptions(options, normalizeMutatingOwnership);
  const workloadId = crypto.randomUUID();
  const containerName = projectContainerName(
    `${prepared.actorId}\0${prepared.projectId}\0${workloadId}`,
  );
  const image = await resolvePinnedProjectRuntimeImage(PROJECT_RUNTIME_IMAGE).catch(() => {
    throw new Error(
      `Project runtime image ${PROJECT_RUNTIME_IMAGE} is unavailable. Re-run the Portal installer/update before using project Git.`,
    );
  });
  const plan = await preparePortalProjectWorkloadContainer({
    identity: {
      actorId: prepared.actorId,
      projectId: prepared.projectId,
      consumerKind: 'PORTAL_GIT',
      workloadId,
    },
    containerName,
    workspace: prepared.workspace,
    image,
    command: 'git',
    args: [...SAFE_GIT_CONFIG, ...prepared.args],
    environment: {
      HOME: '/tmp/project-home',
      XDG_CONFIG_HOME: '/tmp/project-config',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/false',
      SSH_ASKPASS: '/bin/false',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_OPTIONAL_LOCKS: '0',
    },
    networked: prepared.network === true,
    pidsLimit: 128,
    memoryBytes: 512 * 1024 * 1024,
    nanoCpus: 1_000_000_000,
    tmpfsSize: '128m',
  });
  const child = spawn(DOCKER_BIN, ['container', 'start', '--attach', plan.containerName], {
    env: dockerCliEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const maxOutput = prepared.maxOutputBytes || MAX_OUTPUT_BYTES;
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let settled = false;
  let timedOut = false;
  let cancelled = false;
  let cleanupPromise: Promise<void> | null = null;
  const cleanupOnce = () => {
    if (!cleanupPromise) cleanupPromise = removePreparedPortalProjectWorkloadContainer(plan);
    return cleanupPromise;
  };

  const cancel = () => {
    if (settled) return;
    cancelled = true;
    void cleanupOnce();
    if (!child.killed) child.kill('SIGTERM');
  };
  const onAbort = () => cancel();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, prepared.timeoutMs || DEFAULT_TIMEOUT_MS);
  timer.unref?.();

  const collect = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
    const text = chunk.toString();
    outputBytes += Buffer.byteLength(text);
    if (outputBytes > maxOutput) {
      cancel();
      return;
    }
    if (target === 'stdout') stdout += text;
    else stderr += text;
  };
  child.stdout?.on('data', (chunk) => collect('stdout', chunk));
  child.stderr?.on('data', (chunk) => collect('stderr', chunk));

  let resolveCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    resolveCleanup = resolve;
  });
  const result = new Promise<string>((resolve, reject) => {
    const finish = (error?: Error, code?: number | string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void cleanupOnce().then(() => {
        resolveCleanup();
        if (error) reject(new ProjectGitCommandError(error.message, stdout, stderr, code));
        else resolve(stdout);
      }, (cleanupError) => {
        resolveCleanup();
        reject(new ProjectGitCommandError(
          cleanupError instanceof Error ? cleanupError.message : 'Project Git cleanup failed',
          stdout,
          stderr,
          code,
        ));
      });
    };
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (timedOut) finish(new Error('Project Git command timed out'), code ?? signal);
      else if (outputBytes > maxOutput) finish(new Error('Project Git command output limit exceeded'), code ?? signal);
      else if (cancelled || options.signal?.aborted) finish(new Error('Project Git command cancelled'), code ?? signal);
      else if (code !== 0) finish(new Error(stderr.trim() || `Project Git exited with code ${code}`), code);
      else finish(undefined, code);
    });
  });

  if (options.signal?.aborted) cancel();

  return { process: child, containerName, result, cancel, cleanup, plan };
}

export async function spawnProjectGitCommand(options: ProjectGitCommandOptions): Promise<ProjectGitProcess> {
  return spawnProjectGitCommandInternal(options, true);
}

export async function runProjectGitCommand(options: ProjectGitCommandOptions): Promise<string> {
  return (await spawnProjectGitCommand(options)).result;
}

/**
 * Project Chat has already normalized legacy trees during provider preparation,
 * and every Portal mutation boundary preserves the shared runtime UID/GID.
 * Its post-turn checkpoint therefore must not recursively traverse the warm
 * repository before each Git mutation.
 */
export async function runPreparedProjectGitCommand(options: ProjectGitCommandOptions): Promise<string> {
  return (await spawnProjectGitCommandInternal(options, false)).result;
}

export const __projectGitTest = {
  dockerCliEnvironment,
  commandMutatesWorkspace,
  prepareOptions,
  projectContainerName,
  safeGitConfig: SAFE_GIT_CONFIG,
};
