import { execFile, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { constants as fsConstants } from 'fs';
import { access, chmod, unlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { TAILSCALE_BINARY_ALLOWLIST } from './tailscalePeerAttestor';

const execFileAsync = promisify(execFile);

const STATUS_TIMEOUT_MS = 5_000;
const VERSION_TIMEOUT_MS = 5_000;
const SYSTEMCTL_TIMEOUT_MS = 30_000;
const INSTALL_DOWNLOAD_TIMEOUT_MS = 30_000;
const INSTALL_RUN_TIMEOUT_MS = 240_000;
const AUTH_KEY_CONNECT_TIMEOUT_MS = 90_000;
const LOGIN_URL_POLL_TIMEOUT_MS = 12_000;
const LOGIN_URL_POLL_INTERVAL_MS = 1_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const INSTALL_SCRIPT_URL = 'https://tailscale.com/install.sh';
const INSTALL_SCRIPT_MAX_BYTES = 512 * 1024;
const SYSTEMCTL = '/usr/bin/systemctl';
const DEFAULT_HOSTNAME = 'bridgesllm-portal';

const SAFE_ENV = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
} satisfies NodeJS.ProcessEnv);

export type TailnetServerNetworkErrorCode =
  | 'SERVER_NETWORK_BUSY'
  | 'SERVER_NETWORK_UNSUPPORTED'
  | 'TAILSCALE_INSTALL_FAILED'
  | 'TAILSCALE_CONNECT_FAILED'
  | 'REQUEST_INVALID';

export class TailnetServerNetworkError extends Error {
  constructor(
    public readonly code: TailnetServerNetworkErrorCode,
    message: string,
    public readonly statusCode = 502,
  ) {
    super(message);
    this.name = 'TailnetServerNetworkError';
  }
}

export interface TailnetServerNetworkStatus {
  installed: boolean;
  version: string | null;
  daemonActive: boolean;
  backendState: string | null;
  running: boolean;
  tailnetName: string | null;
  hostName: string | null;
  tailnetIp: string | null;
  loginUrl: string | null;
}

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

type SpawnLike = typeof spawn;

export interface TailnetServerNetworkDependencies {
  execFileImpl?: ExecFileLike;
  spawnImpl?: SpawnLike;
  fetchImpl?: typeof fetch;
  accessImpl?: (candidate: string, mode: number) => Promise<void>;
  tempDir?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  platform?: NodeJS.Platform;
}

// One mutating operation at a time; a second click must not stack installers
// or interleave two `tailscale up` invocations.
let activeOperation: string | null = null;

function claimOperation(kind: string): void {
  if (activeOperation) {
    throw new TailnetServerNetworkError(
      'SERVER_NETWORK_BUSY',
      `Another server network operation (${activeOperation}) is still running. Wait for it to finish.`,
      409,
    );
  }
  activeOperation = kind;
}

function releaseOperation(kind: string): void {
  if (activeOperation === kind) activeOperation = null;
}

function scrubSecrets(value: string): string {
  return value.replace(/tskey-[A-Za-z0-9_-]+/gu, 'tskey-[redacted]');
}

function boundedOutputTail(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return scrubSecrets(lines.slice(-3).join(' ')).slice(0, 400);
}

async function resolveInstalledBinary(
  dependencies: TailnetServerNetworkDependencies,
): Promise<string | null> {
  const accessImpl = dependencies.accessImpl
    || ((candidate: string, mode: number) => access(candidate, mode));
  for (const candidate of TAILSCALE_BINARY_ALLOWLIST) {
    try {
      await accessImpl(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next fixed absolute location.
    }
  }
  return null;
}

function execOptions(timeout: number): Record<string, unknown> {
  return {
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: SAFE_ENV,
    windowsHide: true,
    shell: false,
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseStatusJson(raw: string): Pick<
  TailnetServerNetworkStatus,
  'backendState' | 'running' | 'tailnetName' | 'hostName' | 'tailnetIp' | 'loginUrl'
> {
  let parsed: Record<string, unknown> = {};
  try {
    const candidate = JSON.parse(raw) as unknown;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    // A malformed status is reported as an unknown state, not a crash.
  }
  const backendState = readString(parsed.BackendState);
  const self = parsed.Self && typeof parsed.Self === 'object'
    ? parsed.Self as Record<string, unknown>
    : {};
  const tailnet = parsed.CurrentTailnet && typeof parsed.CurrentTailnet === 'object'
    ? parsed.CurrentTailnet as Record<string, unknown>
    : {};
  const addresses = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  const firstIp = addresses.find((entry) => typeof entry === 'string' && entry.includes('.'))
    ?? addresses.find((entry) => typeof entry === 'string');
  const rawLoginUrl = readString(parsed.AuthURL);
  let loginUrl: string | null = null;
  if (rawLoginUrl) {
    try {
      const url = new URL(rawLoginUrl);
      if (url.protocol === 'https:') loginUrl = url.toString();
    } catch {
      loginUrl = null;
    }
  }
  return {
    backendState,
    running: backendState === 'Running',
    tailnetName: readString(tailnet.Name),
    hostName: readString(self.HostName),
    tailnetIp: typeof firstIp === 'string' ? firstIp : null,
    loginUrl,
  };
}

export async function readTailnetServerNetworkStatus(
  dependencies: TailnetServerNetworkDependencies = {},
): Promise<TailnetServerNetworkStatus> {
  const execFileImpl = dependencies.execFileImpl || (execFileAsync as unknown as ExecFileLike);
  const binary = await resolveInstalledBinary(dependencies);
  if (!binary) {
    return {
      installed: false,
      version: null,
      daemonActive: false,
      backendState: null,
      running: false,
      tailnetName: null,
      hostName: null,
      tailnetIp: null,
      loginUrl: null,
    };
  }

  let version: string | null = null;
  try {
    const result = await execFileImpl(binary, ['version'], execOptions(VERSION_TIMEOUT_MS));
    version = readString(result.stdout.split(/\r?\n/u)[0]);
  } catch {
    version = null;
  }

  let daemonActive = false;
  try {
    await execFileImpl(SYSTEMCTL, ['is-active', '--quiet', 'tailscaled'], execOptions(SYSTEMCTL_TIMEOUT_MS));
    daemonActive = true;
  } catch {
    daemonActive = false;
  }

  let statusFields: ReturnType<typeof parseStatusJson> = {
    backendState: null,
    running: false,
    tailnetName: null,
    hostName: null,
    tailnetIp: null,
    loginUrl: null,
  };
  try {
    const result = await execFileImpl(binary, ['status', '--json'], execOptions(STATUS_TIMEOUT_MS));
    statusFields = parseStatusJson(result.stdout);
  } catch {
    // The daemon may be stopped; installed/daemonActive already tell the story.
  }

  return {
    installed: true,
    version,
    daemonActive,
    ...statusFields,
  };
}

async function ensureDaemonStarted(
  execFileImpl: ExecFileLike,
): Promise<void> {
  try {
    await execFileImpl(SYSTEMCTL, ['enable', '--now', 'tailscaled'], execOptions(SYSTEMCTL_TIMEOUT_MS));
  } catch {
    // Some distros manage tailscaled differently; the follow-up status read
    // reports the truth either way.
  }
}

/**
 * Runs Tailscale's official install script — the same documented step an
 * operator would run by hand — from an explicit Owner action in Settings.
 */
export async function installTailscaleOnServer(
  dependencies: TailnetServerNetworkDependencies = {},
): Promise<TailnetServerNetworkStatus> {
  const platform = dependencies.platform || process.platform;
  if (platform !== 'linux') {
    throw new TailnetServerNetworkError(
      'SERVER_NETWORK_UNSUPPORTED',
      'Automatic Tailscale install is supported only on Linux Portal servers.',
      400,
    );
  }
  claimOperation('install');
  const execFileImpl = dependencies.execFileImpl || (execFileAsync as unknown as ExecFileLike);
  const fetchImpl = dependencies.fetchImpl || fetch;
  const scriptPath = path.join(
    dependencies.tempDir || os.tmpdir(),
    `bridgesllm-tailscale-install-${randomBytes(8).toString('hex')}.sh`,
  );
  try {
    const existing = await resolveInstalledBinary(dependencies);
    if (existing) {
      const status = await readTailnetServerNetworkStatus(dependencies);
      if (!status.daemonActive) await ensureDaemonStarted(execFileImpl);
      return readTailnetServerNetworkStatus(dependencies);
    }

    let script: string;
    try {
      const response = await fetchImpl(INSTALL_SCRIPT_URL, {
        signal: AbortSignal.timeout(INSTALL_DOWNLOAD_TIMEOUT_MS),
        redirect: 'follow',
      });
      if (!response.ok) {
        throw new Error(`installer download returned HTTP ${response.status}`);
      }
      script = await response.text();
    } catch (error: any) {
      throw new TailnetServerNetworkError(
        'TAILSCALE_INSTALL_FAILED',
        `Portal could not download the official Tailscale installer from tailscale.com: ${boundedOutputTail(error?.message) || 'network failure'}. Check the server's outbound connectivity and retry.`,
        502,
      );
    }
    if (
      Buffer.byteLength(script, 'utf8') > INSTALL_SCRIPT_MAX_BYTES
      || !script.startsWith('#!/bin/sh')
    ) {
      throw new TailnetServerNetworkError(
        'TAILSCALE_INSTALL_FAILED',
        'The downloaded Tailscale installer did not look like the official shell script. Aborting without running it.',
        502,
      );
    }

    await writeFile(scriptPath, script, { mode: 0o700 });
    await chmod(scriptPath, 0o700);
    try {
      await execFileImpl('/bin/sh', [scriptPath], execOptions(INSTALL_RUN_TIMEOUT_MS));
    } catch (error: any) {
      throw new TailnetServerNetworkError(
        'TAILSCALE_INSTALL_FAILED',
        `The Tailscale installer failed on this server: ${boundedOutputTail(error?.stderr) || boundedOutputTail(error?.message) || 'unknown installer error'}.`,
        502,
      );
    }

    await ensureDaemonStarted(execFileImpl);
    const status = await readTailnetServerNetworkStatus(dependencies);
    if (!status.installed) {
      throw new TailnetServerNetworkError(
        'TAILSCALE_INSTALL_FAILED',
        'The installer finished but no tailscale binary appeared at a supported location.',
        502,
      );
    }
    return status;
  } finally {
    await unlink(scriptPath).catch(() => undefined);
    releaseOperation('install');
  }
}

function sanitizeHostname(value: unknown): string {
  if (value === undefined || value === null || value === '') return DEFAULT_HOSTNAME;
  const hostname = String(value).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(hostname)) {
    throw new TailnetServerNetworkError(
      'REQUEST_INVALID',
      'The tailnet hostname may contain only letters, digits, and hyphens (max 63 characters).',
      400,
    );
  }
  return hostname;
}

function sanitizeAuthKey(value: unknown): string {
  const key = String(value ?? '').trim();
  if (!/^tskey-[A-Za-z0-9_-]{5,200}$/u.test(key)) {
    throw new TailnetServerNetworkError(
      'REQUEST_INVALID',
      'That does not look like a Tailscale auth key (they start with "tskey-"). Generate one at login.tailscale.com under Settings → Keys.',
      400,
    );
  }
  return key;
}

/**
 * Joins the tailnet non-interactively with an operator-provided auth key. The
 * key travels via a root-only temp file (never argv, never logs) and is
 * deleted immediately; Portal keeps no copy.
 */
export async function connectServerWithAuthKey(
  input: { authKey: unknown; hostname?: unknown },
  dependencies: TailnetServerNetworkDependencies = {},
): Promise<TailnetServerNetworkStatus> {
  const authKey = sanitizeAuthKey(input.authKey);
  const hostname = sanitizeHostname(input.hostname);
  claimOperation('connect');
  const execFileImpl = dependencies.execFileImpl || (execFileAsync as unknown as ExecFileLike);
  const keyPath = path.join(
    dependencies.tempDir || os.tmpdir(),
    `bridgesllm-tskey-${randomBytes(8).toString('hex')}`,
  );
  try {
    const binary = await resolveInstalledBinary(dependencies);
    if (!binary) {
      throw new TailnetServerNetworkError(
        'TAILSCALE_CONNECT_FAILED',
        'Tailscale is not installed on this server yet. Use the install step first.',
        409,
      );
    }
    await ensureDaemonStarted(execFileImpl);
    await writeFile(keyPath, authKey, { mode: 0o600 });
    try {
      await execFileImpl(binary, [
        'up',
        `--hostname=${hostname}`,
        `--auth-key=file:${keyPath}`,
      ], execOptions(AUTH_KEY_CONNECT_TIMEOUT_MS));
    } catch (error: any) {
      throw new TailnetServerNetworkError(
        'TAILSCALE_CONNECT_FAILED',
        `Tailscale rejected the connection: ${boundedOutputTail(error?.stderr) || boundedOutputTail(error?.message) || 'unknown error'}. Check that the auth key is valid and not expired.`,
        502,
      );
    }
    const status = await readTailnetServerNetworkStatus(dependencies);
    if (!status.running) {
      throw new TailnetServerNetworkError(
        'TAILSCALE_CONNECT_FAILED',
        `Tailscale accepted the key but the backend is ${status.backendState || 'not running'}. Retry, or check the machine's approval state in your tailnet admin console.`,
        502,
      );
    }
    return status;
  } finally {
    await unlink(keyPath).catch(() => undefined);
    releaseOperation('connect');
  }
}

/**
 * Starts the browser sign-in flow and returns the login URL for the Owner to
 * open. The background `tailscale up` completes by itself once the Owner
 * authorizes the machine; the UI polls status until Running.
 */
export async function startServerLoginFlow(
  input: { hostname?: unknown } = {},
  dependencies: TailnetServerNetworkDependencies = {},
): Promise<TailnetServerNetworkStatus> {
  const hostname = sanitizeHostname(input.hostname);
  claimOperation('login');
  const execFileImpl = dependencies.execFileImpl || (execFileAsync as unknown as ExecFileLike);
  const spawnImpl = dependencies.spawnImpl || spawn;
  const sleep = dependencies.sleep
    || ((milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); }));
  try {
    const binary = await resolveInstalledBinary(dependencies);
    if (!binary) {
      throw new TailnetServerNetworkError(
        'TAILSCALE_CONNECT_FAILED',
        'Tailscale is not installed on this server yet. Use the install step first.',
        409,
      );
    }
    await ensureDaemonStarted(execFileImpl);

    const current = await readTailnetServerNetworkStatus(dependencies);
    if (current.running) return current;
    if (current.loginUrl) return current;

    try {
      const child = spawnImpl(binary, [
        'up',
        `--hostname=${hostname}`,
      ], {
        detached: true,
        stdio: 'ignore',
        env: SAFE_ENV,
      });
      // child_process.spawn reports ENOENT/EACCES/resource failures on the
      // asynchronous `error` event, not necessarily by throwing. Wait for the
      // mutually exclusive spawn/error result before detaching so an invalid
      // executable can never become an unhandled process-level error.
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          child.removeListener('error', onError);
          resolve();
        };
        const onError = (error: Error) => {
          child.removeListener('spawn', onSpawn);
          reject(error);
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      });
      child.unref?.();
    } catch (error: any) {
      throw new TailnetServerNetworkError(
        'TAILSCALE_CONNECT_FAILED',
        `Portal could not start the Tailscale sign-in flow: ${boundedOutputTail(error?.message) || 'spawn failure'}.`,
        502,
      );
    }

    const deadline = Date.now() + LOGIN_URL_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(LOGIN_URL_POLL_INTERVAL_MS);
      const status = await readTailnetServerNetworkStatus(dependencies);
      if (status.running || status.loginUrl) return status;
    }
    // The URL can lag on slow hosts; the UI keeps polling the status endpoint.
    return readTailnetServerNetworkStatus(dependencies);
  } finally {
    releaseOperation('login');
  }
}
