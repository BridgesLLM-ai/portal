/**
 * Isolated execution for photo raster decoding.
 *
 * Each image runs in fresh network, IPC, UTS, PID and mount namespaces
 * (util-linux `unshare`), as nobody (65534) with no capabilities and
 * no_new_privs (`setpriv`), under data/CPU/file-count limits (`prlimit`) and a
 * hard wall-clock kill. Host trees that hold state, credentials or sockets
 * (/root, /home, /srv, /var/lib, /var/backups, /run, /tmp, /opt, ...) are
 * replaced by empty tmpfs mounts; the worker code and its modules are bound
 * read-only at /mnt. The environment is replaced entirely. The new network
 * namespace has no usable interface, so nothing inside can reach host services or the internet.
 *
 * If the sandbox cannot be established the image worker fails closed.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export const SANDBOX_HIDDEN_PATHS = [
  '/root', '/home', '/srv', '/var/lib', '/var/backups', '/var/portal-files', '/var/www', '/portal',
  '/run', '/tmp', '/var/tmp', '/opt', '/mnt', '/media', '/etc/bridgesllm', '/etc/ssl/private',
];

export interface SandboxBind {
  /** Real host directory to expose read-only. */
  source: string;
  /** Name under /mnt inside the sandbox (letters, digits, dashes). */
  name: string;
}

export interface SandboxRunOptions {
  /** Script path inside the sandbox, e.g. /mnt/app/dist/.../extractorWorker.js */
  script: string;
  binds: SandboxBind[];
  /** NODE_PATH inside the sandbox (optional). */
  nodePath?: string;
  env?: Record<string, string>;
  input: Buffer;
  timeoutMs: number;
  dataBytes: number;
  cpuSeconds: number;
  maxOutputBytes: number;
  heapMegabytes?: number;
}

export interface SandboxRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: Buffer;
  stderrTail: string;
  outputTruncated: boolean;
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

const BIND_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MIN_DATA_BYTES = 1024 * 1024 * 1024;
const SAFE_ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const TOOLS = ['/usr/bin/unshare', '/usr/bin/setpriv', '/usr/bin/prlimit', '/usr/bin/env', '/bin/sh'];

function shellQuote(value: string): string {
  if (value.includes('\0')) throw new SandboxUnavailableError('Sandbox argument contains a NUL byte.');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sandboxPrerequisites(): { ok: boolean; missing: string[] } {
  const missing = TOOLS.filter((tool) => !fs.existsSync(tool));
  if (typeof process.getuid === 'function' && process.getuid() !== 0) missing.push('root (namespace setup)');
  return { ok: missing.length === 0, missing };
}

/** The shell program run as root inside the new namespaces before dropping to nobody. */
export function buildSandboxScript(options: Pick<SandboxRunOptions, 'script' | 'binds' | 'nodePath' | 'env' | 'dataBytes' | 'cpuSeconds' | 'heapMegabytes'>, nodeBinary: string): string {
  const lines = ['set -eu', 'mount --make-rprivate /'];
  // Stage read-only binds on a private tmpfs before hiding their source trees.
  lines.push('mount -t tmpfs -o size=1m,mode=0755,nosuid,nodev tmpfs /mnt');
  for (const bind of options.binds) {
    if (!BIND_NAME.test(bind.name)) throw new SandboxUnavailableError('Sandbox bind name is invalid.');
    const source = fs.realpathSync(bind.source);
    lines.push(`mkdir /mnt/${bind.name}`);
    lines.push(`mount --bind ${shellQuote(source)} /mnt/${bind.name}`);
    lines.push(`mount -o remount,bind,ro,nosuid,nodev /mnt/${bind.name}`);
  }
  for (const hidden of SANDBOX_HIDDEN_PATHS) {
    if (hidden === '/mnt') continue;
    lines.push(`if [ -d ${shellQuote(hidden)} ] && [ ! -L ${shellQuote(hidden)} ]; then mount -t tmpfs -o size=1m,mode=0755,nosuid,nodev,noexec tmpfs ${shellQuote(hidden)}; fi`);
  }
  // A small private scratch area (decoder temporary files).
  lines.push('mount -t tmpfs -o size=96m,mode=1777,nosuid,nodev,noexec tmpfs /tmp');
  const env: string[] = ['PATH=/usr/bin:/bin', 'HOME=/nonexistent', 'LANG=C.UTF-8', 'TMPDIR=/tmp'];
  if (options.nodePath) env.push(`NODE_PATH=${options.nodePath}`);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!SAFE_ENV_KEY.test(key)) throw new SandboxUnavailableError('Sandbox environment key is invalid.');
    env.push(`${key}=${value}`);
  }
  const heap = Math.max(64, Math.min(4096, options.heapMegabytes ?? 384));
  lines.push([
    'exec setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all --',
    // V8 reserves its code range against RLIMIT_DATA; below ~1 GiB Node cannot start at all.
    `prlimit --data=${Math.max(MIN_DATA_BYTES, Math.floor(options.dataBytes))} --cpu=${Math.floor(options.cpuSeconds)} --nofile=128 --core=0 --`,
    '/usr/bin/env -i', ...env.map(shellQuote),
    shellQuote(nodeBinary), `--max-old-space-size=${heap}`, '--disallow-code-generation-from-strings', shellQuote(options.script),
  ].join(' '));
  return lines.join('\n');
}

export async function runSandboxed(options: SandboxRunOptions): Promise<SandboxRunResult> {
  const prerequisites = sandboxPrerequisites();
  if (!prerequisites.ok) throw new SandboxUnavailableError(`Image worker sandbox prerequisites missing: ${prerequisites.missing.join(', ')}`);
  const nodeBinary = process.execPath;
  if (SANDBOX_HIDDEN_PATHS.some((hidden) => nodeBinary === hidden || nodeBinary.startsWith(`${hidden}/`))) {
    throw new SandboxUnavailableError('The Node.js runtime lives under a path the sandbox hides.');
  }
  const script = buildSandboxScript(options, nodeBinary);
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/unshare', [
      '--net', '--ipc', '--uts', '--pid', '--fork', '--mount', '--mount-proc', '--kill-child', '--', '/bin/sh', '-c', script,
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, cwd: '/', detached: true });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > options.maxOutputBytes) {
        truncated = true;
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
        return;
      }
      stdoutBytes += chunk.length;
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.on('error', (error) => { clearTimeout(timer); reject(new SandboxUnavailableError(`Image worker sandbox could not start: ${error.message}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, timedOut, stdout: Buffer.concat(stdout), stderrTail: stderr, outputTruncated: truncated });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input);
  });
}
