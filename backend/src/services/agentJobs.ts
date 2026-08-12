import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { prisma } from '../config/database';
import { ensureRuntimeDirectory } from '../utils/runtimeDirectory';
import { sendJobFailedAlert } from './email';
import { subscribeToAuthorizationChanges } from './authorizationChangeBus';
import {
  createHostAgentRunActivationGate,
  HOST_AGENT_RUN_ACTIVATION_WRAPPER_SOURCE,
} from './hostAgentRunActivationGate';
import {
  systemdHostRunBoundary,
  type SystemdHostRunScopeIdentity,
  type SystemdHostRunStopProof,
} from './systemdHostRunBoundary';
import type {
  TerminalSystemdScopeIdentity,
  TerminalSystemdScopeStopProof,
} from './terminalSystemdScopeBoundary';
import { acquireWorkspaceAuthorizationMutationLease } from './workspaceAuthorizationBarrier';

export type JobStatus = 'running' | 'completed' | 'error' | 'killed';

export type TranscriptEntry = {
  type: 'input' | 'output' | 'system';
  text: string;
  stream?: 'stdout' | 'stderr';
  timestamp: string;
};

export type StartJobInput = {
  userId: string;
  actorAuthorizationVersion: number;
  toolId: string;
  title?: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
};

type RuntimeJob = {
  id: string;
  userId: string;
  title: string;
  toolId: string;
  type: 'pty' | 'spawn';
  launchToken: string;
  metadata: PersistedJobMetadata;
  ptyProcess?: any;
  child?: ChildProcessWithoutNullStreams;
  pid: number;
  processStartTime: string | null;
  transcriptPath: string;
  transcriptBytes: number;
  outputBytes: number;
  pendingInputBytes: number;
  actorAuthorizationVersion: number;
  authorizationUnsubscribe?: () => void;
  scope: PreparedAgentJobSystemdScope;
  finalized: boolean;
  exited: boolean;
  requestedStatus?: Exclude<JobStatus, 'running' | 'completed'>;
  terminationPromise?: Promise<void>;
  finalizationPromise?: Promise<void>;
  scopeStopAttempted: boolean;
};

type PersistedAgentJobSystemdScopeIdentity = (
  | ({ kind: 'terminal-systemd-v1' } & TerminalSystemdScopeIdentity)
  | ({ kind: 'host-systemd-v1' } & SystemdHostRunScopeIdentity)
);

type PersistedRuntimeIdentity = {
  portalInstanceId: string;
  // Durable, high-entropy identity written before the process is spawned and
  // injected into the child environment. It lets restart reconciliation find
  // and prove-terminate an orphan even when the Portal crashed before the PID
  // was learned.
  launchToken?: string;
  activated: boolean;
  systemdScope?: PersistedAgentJobSystemdScopeIdentity;
  pid?: number;
  processStartTime?: string | null;
  processGroupId?: number;
  detached?: boolean;
  preparedAt?: string;
  startedAt?: string;
};

type PersistedTerminationOutcome = {
  matched: boolean;
  signaled: boolean;
  proven: boolean;
};

type AgentJobSystemdStopProof = SystemdHostRunStopProof | TerminalSystemdScopeStopProof;

type PreparedAgentJobSystemdScope = {
  type: 'pty' | 'spawn';
  pid: number;
  ptyProcess?: any;
  child?: ChildProcessWithoutNullStreams;
  identity: PersistedAgentJobSystemdScopeIdentity;
  activate(): Promise<void>;
  stop(): Promise<AgentJobSystemdStopProof>;
};

type PrepareAgentJobSystemdScopeInput = {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

type AgentJobSystemdScopeBoundary = {
  initialize(): Promise<void>;
  prepare(input: PrepareAgentJobSystemdScopeInput): Promise<PreparedAgentJobSystemdScope>;
  stopIdentity(identity: PersistedAgentJobSystemdScopeIdentity): Promise<AgentJobSystemdStopProof>;
};

type ProcessIdentityMarker = {
  pid: number;
  processStartTime: string;
};

type PersistedJobMetadata = Record<string, unknown> & {
  runtime?: Partial<PersistedRuntimeIdentity>;
};

type AgentJobActivationGate = {
  socketPath: string;
  ready: Promise<void>;
  release(): Promise<void>;
  abort(): void;
};

export interface AgentJobsStorageOptions {
  jobsDir?: string;
  portalRoot?: string;
}

function positiveLimit(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const AGENT_JOB_LIMITS = Object.freeze({
  maxToolIdBytes: positiveLimit('PORTAL_AGENT_JOB_MAX_TOOL_ID_BYTES', 256),
  maxCommandBytes: positiveLimit('PORTAL_AGENT_JOB_MAX_COMMAND_BYTES', 64 * 1024),
  maxTitleBytes: positiveLimit('PORTAL_AGENT_JOB_MAX_TITLE_BYTES', 4 * 1024),
  maxCwdBytes: positiveLimit('PORTAL_AGENT_JOB_MAX_CWD_BYTES', 4 * 1024),
  maxEnvEntries: positiveLimit('PORTAL_AGENT_JOB_MAX_ENV_ENTRIES', 128),
  maxEnvBytes: positiveLimit('PORTAL_AGENT_JOB_MAX_ENV_BYTES', 128 * 1024),
  maxInputBytes: positiveLimit('PORTAL_AGENT_JOB_MAX_INPUT_BYTES', 64 * 1024),
  maxPendingInputBytes: positiveLimit('PORTAL_AGENT_JOB_MAX_PENDING_INPUT_BYTES', 256 * 1024),
  maxOutputEntryBytes: positiveLimit('PORTAL_AGENT_JOB_MAX_OUTPUT_ENTRY_BYTES', 64 * 1024),
  maxOutputBytes: positiveLimit('PORTAL_AGENT_JOB_MAX_OUTPUT_BYTES', 8 * 1024 * 1024),
  maxTranscriptBytes: positiveLimit('PORTAL_AGENT_JOB_MAX_TRANSCRIPT_BYTES', 10 * 1024 * 1024),
  maxTranscriptReadBytes: positiveLimit('PORTAL_AGENT_JOB_MAX_TRANSCRIPT_READ_BYTES', 10 * 1024 * 1024),
  maxTranscriptEntries: positiveLimit('PORTAL_AGENT_JOB_MAX_TRANSCRIPT_ENTRIES', 10_000),
  terminateGraceMs: positiveLimit('PORTAL_AGENT_JOB_TERMINATE_GRACE_MS', 750),
  activationHandshakeMs: positiveLimit('PORTAL_AGENT_JOB_ACTIVATION_HANDSHAKE_MS', 5_000),
});

export class AgentJobRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AgentJobRequestError';
  }
}

export function resolveAgentJobsDirectory(options: AgentJobsStorageOptions = {}): string {
  return path.resolve(
    options.jobsDir
      || process.env.PORTAL_AGENT_JOBS_ROOT
      || path.join(options.portalRoot || process.env.PORTAL_ROOT || '/opt/bridgesllm/portal', '.data/jobs'),
  );
}

export const AGENT_JOBS_DIR = resolveAgentJobsDirectory();

export function initializeAgentJobsStorage(options: AgentJobsStorageOptions = {}): string {
  const jobsDir = Object.keys(options).length > 0 ? resolveAgentJobsDirectory(options) : AGENT_JOBS_DIR;
  return ensureRuntimeDirectory(jobsDir, { mode: 0o700, enforceMode: true });
}

const portalInstanceId = `${process.pid}-${crypto.randomUUID()}`;

// Environment marker carrying a per-job launch token into the spawned process
// tree. Reconciliation and authorization quiescence use it as the durable
// identity of last resort: it is present on the process even in the
// window after exec but before the PID is persisted, and it is inherited by
// descendants that escape the original process group.
const LAUNCH_TOKEN_ENV = 'PORTAL_AGENT_JOB_LAUNCH_TOKEN';
const LAUNCH_TOKEN_BYTES = 24;
const ACTIVATION_SOCKET_MAX_BYTES = 100;
const SYSTEMD_SCOPE_TAG_PATTERN = /^[0-9a-f]{64}$/;
const SYSTEMD_INVOCATION_ID_PATTERN = /^[0-9a-f]{32}$/;
const SYSTEMD_BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL_SCOPE_UNIT_PATTERN = /^bridgesllm-terminal-[0-9a-f]{32}\.scope$/;
const HOST_SCOPE_UNIT_PATTERN = /^bridgesllm-host-agent-[0-9a-f]{32}\.scope$/;
const TERMINAL_SCOPE_DESCRIPTION_PREFIX = 'BridgesLLM privileged terminal tag=';
const HOST_SCOPE_DESCRIPTION_PREFIX = 'BridgesLLM host agent run tag=';

// The wrapper may establish the process identity and connect to the parent, but
// it cannot execute the caller's command until the parent has durably persisted
// PID/start-time identity and sends one release byte. If the Portal dies first,
// the Unix socket closes (or the later connect fails) and the wrapper exits.
const ACTIVATION_WRAPPER_SOURCE = `
const net = require('net');
const { spawn } = require('child_process');
const [socketPath, token, command] = process.argv.slice(1);
let released = false;
let child = null;
const failClosed = () => {
  if (released) return;
  released = true;
  process.exit(125);
};
const socket = net.createConnection({ path: socketPath });
socket.once('connect', () => socket.write(token + '\\n'));
socket.once('data', (chunk) => {
  if (!chunk || chunk[0] !== 0x31 || released) return failClosed();
  released = true;
  socket.destroy();
  child = spawn('/bin/bash', ['-lc', command], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  child.once('error', () => process.exit(127));
  child.once('exit', (code, signal) => {
    if (signal) {
      try {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
        return;
      } catch {}
    }
    process.exit(Number.isInteger(code) ? code : 1);
  });
});
socket.once('end', failClosed);
socket.once('close', failClosed);
socket.once('error', failClosed);
`;

function createLaunchToken(): string {
  return crypto.randomBytes(LAUNCH_TOKEN_BYTES).toString('hex');
}

function activationWrapperCommand(
  socketPath: string,
  launchToken: string,
  command: string,
): { executable: string; args: string[] } {
  return {
    executable: process.execPath,
    args: ['-e', ACTIVATION_WRAPPER_SOURCE, socketPath, launchToken, command],
  };
}

function unlinkActivationSocket(socketPath: string): void {
  try {
    fs.unlinkSync(socketPath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.warn('[agent-jobs] Failed to remove activation socket:', error?.message || error);
    }
  }
}

async function createAgentJobActivationGate(
  jobsDir: string,
  launchToken: string,
): Promise<AgentJobActivationGate> {
  if (process.platform !== 'linux') {
    throw new Error('Agent Jobs require the Linux pre-exec activation gate');
  }

  const socketPath = path.join(jobsDir, `.gate-${crypto.randomBytes(8).toString('hex')}.sock`);
  if (byteLength(socketPath) > ACTIVATION_SOCKET_MAX_BYTES) {
    throw new Error('Agent Jobs runtime path is too long for a fail-closed activation socket');
  }
  if (fs.existsSync(socketPath)) {
    throw new Error('Agent Jobs activation socket already exists');
  }

  let acceptedSocket: net.Socket | null = null;
  let released = false;
  let settled = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // The caller always awaits or aborts this promise; attach a handler now so a
  // child failure racing identity persistence cannot become an unhandled reject.
  void ready.catch(() => undefined);

  const server = net.createServer((socket) => {
    if (acceptedSocket || settled) {
      socket.destroy();
      return;
    }
    acceptedSocket = socket;
    let handshake = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      if (settled) return;
      handshake += chunk;
      if (handshake.length > launchToken.length + 1) {
        fail(new Error('Agent Jobs activation handshake exceeded its bound'));
        return;
      }
      const newline = handshake.indexOf('\n');
      if (newline < 0) return;
      const provided = handshake.slice(0, newline);
      const expectedBuffer = Buffer.from(launchToken, 'utf8');
      const providedBuffer = Buffer.from(provided, 'utf8');
      if (
        providedBuffer.length !== expectedBuffer.length
        || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
      ) {
        fail(new Error('Agent Jobs activation handshake identity mismatch'));
        return;
      }
      settled = true;
      clearTimeout(handshakeTimer);
      server.close();
      resolveReady();
    });
    socket.once('error', (error) => {
      if (!released) fail(error);
    });
    socket.once('close', () => {
      if (!released && !settled) fail(new Error('Agent Jobs activation socket closed before identity handshake'));
    });
  });

  const cleanup = (): void => {
    try { server.close(); } catch {}
    unlinkActivationSocket(socketPath);
  };

  const fail = (error: Error): void => {
    if (released) return;
    released = true;
    clearTimeout(handshakeTimer);
    acceptedSocket?.destroy();
    cleanup();
    if (!settled) {
      settled = true;
      rejectReady(error);
    }
  };

  const handshakeTimer = setTimeout(() => {
    fail(new Error('Agent Jobs activation handshake timed out'));
  }, AGENT_JOB_LIMITS.activationHandshakeMs);
  handshakeTimer.unref?.();

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(socketPath, () => {
        server.off('error', onError);
        resolve();
      });
    });
    server.on('error', (error) => fail(error));
    fs.chmodSync(socketPath, 0o600);
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  return {
    socketPath,
    ready,
    async release(): Promise<void> {
      await ready;
      if (released || !acceptedSocket) {
        throw new Error('Agent Jobs activation gate is unavailable');
      }
      released = true;
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = acceptedSocket as net.Socket;
          const onError = (error: Error) => reject(error);
          socket.once('error', onError);
          socket.end(Buffer.from('1'), () => {
            socket.off('error', onError);
            resolve();
          });
        });
      } finally {
        acceptedSocket?.destroy();
        cleanup();
      }
    },
    abort(): void {
      fail(new Error('Agent Jobs activation was aborted'));
    },
  };
}

const activationGateFactory: {
  create(jobsDir: string, launchToken: string): Promise<AgentJobActivationGate>;
} = {
  create: createAgentJobActivationGate,
};

function loadTerminalSystemdScopeBoundary(): typeof import('./terminalSystemdScopeBoundary') {
  // Keep node-pty optional for the Agent Jobs fallback while still using the
  // audited terminal boundary whenever the production runtime provides it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./terminalSystemdScopeBoundary') as typeof import('./terminalSystemdScopeBoundary');
}

function optionalTerminalRuntimeUnavailable(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate?.code === 'MODULE_NOT_FOUND'
    && typeof candidate.message === 'string'
    && candidate.message.includes('node-pty');
}

async function prepareHostAgentJobSystemdScope(
  input: PrepareAgentJobSystemdScopeInput,
): Promise<PreparedAgentJobSystemdScope> {
  const reservation = await systemdHostRunBoundary.reserve();
  const gate = await createHostAgentRunActivationGate(
    reservation.scopeUnit,
    reservation.scopeTag,
  );
  let launched: Awaited<ReturnType<typeof systemdHostRunBoundary.launch>> | null = null;
  try {
    gate.prepareTargetEnvironment(input.env);
    launched = await systemdHostRunBoundary.launch({
      reservation,
      wrapperCommand: process.execPath,
      wrapperArgs: [
        '-e',
        HOST_AGENT_RUN_ACTIVATION_WRAPPER_SOURCE,
        '--',
        gate.socketPath,
        reservation.scopeTag,
        '/bin/bash',
        '-lc',
        input.command,
      ],
      cwd: input.cwd,
      stdin: 'pipe',
    });
    await gate.ready;
    if (!launched.child.stdin || !launched.child.stdout || !launched.child.stderr) {
      throw new Error('Agent job systemd scope transport is unavailable');
    }

    let activated = false;
    let stopped = false;
    let stopPromise: Promise<SystemdHostRunStopProof> | null = null;
    const stop = (): Promise<SystemdHostRunStopProof> => {
      if (stopPromise) return stopPromise;
      stopped = true;
      stopPromise = (async () => {
        if (!activated) {
          try {
            await gate.abort();
          } catch {
            // Exact scope settlement remains authoritative.
          }
        }
        return systemdHostRunBoundary.stop(launched!.identity);
      })();
      return stopPromise;
    };

    return Object.freeze({
      type: 'spawn' as const,
      pid: Number.isSafeInteger(launched.child.pid) ? Number(launched.child.pid) : 0,
      child: launched.child as ChildProcessWithoutNullStreams,
      identity: Object.freeze({
        kind: 'host-systemd-v1' as const,
        ...launched.identity,
      }),
      async activate(): Promise<void> {
        if (stopped || activated) {
          throw new Error('Agent job systemd scope activation is unavailable');
        }
        try {
          await gate.release();
          activated = true;
        } catch (error) {
          await stop();
          throw error;
        }
      },
      stop,
    });
  } catch (error) {
    try {
      await gate.abort();
    } catch {}
    if (launched) {
      await systemdHostRunBoundary.stop(launched.identity);
    }
    throw error;
  }
}

const defaultAgentJobSystemdScopeBoundary: AgentJobSystemdScopeBoundary = {
  async initialize(): Promise<void> {
    if (process.env.PORTAL_AGENT_JOBS_DISABLE_PTY === '1') return;
    try {
      await loadTerminalSystemdScopeBoundary().initializeTerminalSystemdScopeRuntime();
    } catch (error) {
      if (!optionalTerminalRuntimeUnavailable(error)) throw error;
    }
  },
  async prepare(
    input: PrepareAgentJobSystemdScopeInput,
  ): Promise<PreparedAgentJobSystemdScope> {
    if (process.env.PORTAL_AGENT_JOBS_DISABLE_PTY !== '1') {
      try {
        const terminal = loadTerminalSystemdScopeBoundary();
        const session = await terminal.prepareTerminalSystemdScope({
          command: '/bin/bash',
          args: ['-lc', input.command],
          cwd: input.cwd,
          env: input.env,
          cols: 120,
          rows: 40,
          terminalName: 'xterm-color',
        });
        return Object.freeze({
          type: 'pty' as const,
          pid: Number.isSafeInteger(session.pty.pid) ? Number(session.pty.pid) : 0,
          ptyProcess: session.pty,
          identity: Object.freeze({
            kind: 'terminal-systemd-v1' as const,
            ...session.identity,
          }),
          activate: () => session.activate(),
          stop: () => session.stop(),
        });
      } catch (error: any) {
        // A terminal-boundary error that did not prove its failed scope empty
        // must remain the authoritative failure. A proven node-pty/transport
        // failure may use the equally contained non-PTY host-scope fallback.
        if (
          error?.settlementProven !== true
          && !optionalTerminalRuntimeUnavailable(error)
        ) {
          throw error;
        }
        console.warn('[agent-jobs] PTY scope unavailable, using systemd host-scope fallback:', error);
      }
    }
    return prepareHostAgentJobSystemdScope(input);
  },
  async stopIdentity(
    identity: PersistedAgentJobSystemdScopeIdentity,
  ): Promise<AgentJobSystemdStopProof> {
    if (identity.kind === 'host-systemd-v1') {
      const { kind: _kind, ...hostIdentity } = identity;
      if (!(await systemdHostRunBoundary.sameBoot(hostIdentity.bootId))) {
        return {
          scopeUnit: hostIdentity.scopeUnit,
          invocationId: hostIdentity.invocationId,
          bootId: hostIdentity.bootId,
          stopRequested: false,
          cgroupEmpty: true,
          finalLoadState: 'boot-changed',
          finalActiveState: 'inactive',
          finalSubState: 'dead',
        };
      }
      return systemdHostRunBoundary.stop(hostIdentity);
    }
    const { kind: _kind, ...terminalIdentity } = identity;
    return loadTerminalSystemdScopeBoundary().stopTerminalSystemdScopeIdentity(
      terminalIdentity,
    );
  },
};

const agentJobSystemdScopeBoundary: AgentJobSystemdScopeBoundary = {
  initialize: (...args) => defaultAgentJobSystemdScopeBoundary.initialize(...args),
  prepare: (...args) => defaultAgentJobSystemdScopeBoundary.prepare(...args),
  stopIdentity: (...args) => defaultAgentJobSystemdScopeBoundary.stopIdentity(...args),
};

const runtimes = new Map<string, RuntimeJob>();
const listeners = new Set<(event: { jobId: string; entry: TranscriptEntry }) => void>();
const statusListeners = new Set<(event: {
  jobId: string;
  status: Exclude<JobStatus, 'running'>;
  exitCode: number | null;
  finishedAt: string;
}) => void>();
const activeStarts = new Set<Promise<unknown>>();
let startupPromise: Promise<{ reconciled: number; signaled: number }> | null = null;
let shutdownPromise: Promise<void> | null = null;
let shuttingDown = false;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parsePersistedSystemdScope(
  value: unknown,
): PersistedAgentJobSystemdScopeIdentity | null {
  const scope = asObject(value);
  const kind = scope.kind;
  const scopeUnit = scope.scopeUnit;
  const scopeTag = scope.scopeTag;
  const description = scope.description;
  const controlGroup = scope.controlGroup;
  const bootId = scope.bootId;
  const invocationId = scope.invocationId;
  if (
    (kind !== 'terminal-systemd-v1' && kind !== 'host-systemd-v1')
    || typeof scopeUnit !== 'string'
    || typeof scopeTag !== 'string'
    || typeof description !== 'string'
    || typeof controlGroup !== 'string'
    || typeof bootId !== 'string'
    || typeof invocationId !== 'string'
    || !SYSTEMD_SCOPE_TAG_PATTERN.test(scopeTag)
    || !SYSTEMD_BOOT_ID_PATTERN.test(bootId)
    || !SYSTEMD_INVOCATION_ID_PATTERN.test(invocationId)
    || controlGroup !== `/system.slice/${scopeUnit}`
  ) {
    return null;
  }
  if (
    kind === 'terminal-systemd-v1'
    && (
      !TERMINAL_SCOPE_UNIT_PATTERN.test(scopeUnit)
      || description !== `${TERMINAL_SCOPE_DESCRIPTION_PREFIX}${scopeTag}`
    )
  ) {
    return null;
  }
  if (
    kind === 'host-systemd-v1'
    && (
      !HOST_SCOPE_UNIT_PATTERN.test(scopeUnit)
      || description !== `${HOST_SCOPE_DESCRIPTION_PREFIX}${scopeTag}`
    )
  ) {
    return null;
  }
  return {
    kind,
    scopeUnit,
    scopeTag,
    description,
    controlGroup,
    bootId,
    invocationId,
  } as PersistedAgentJobSystemdScopeIdentity;
}

function validateStartInput(input: StartJobInput): void {
  if (
    !Number.isSafeInteger(input.actorAuthorizationVersion)
    || input.actorAuthorizationVersion < 1
  ) {
    throw new AgentJobRequestError(
      'actor authorization generation is invalid',
      400,
      'AUTHORIZATION_VERSION_INVALID',
    );
  }
  if (!input.toolId.length || byteLength(input.toolId) > AGENT_JOB_LIMITS.maxToolIdBytes) {
    throw new AgentJobRequestError('toolId is invalid or exceeds the job size limit', 413, 'TOOL_ID_TOO_LARGE');
  }
  if (!input.command.length) {
    throw new AgentJobRequestError('command is required', 400, 'COMMAND_REQUIRED');
  }
  if (byteLength(input.command) > AGENT_JOB_LIMITS.maxCommandBytes) {
    throw new AgentJobRequestError('command exceeds the job size limit', 413, 'COMMAND_TOO_LARGE');
  }
  if (input.title && byteLength(input.title) > AGENT_JOB_LIMITS.maxTitleBytes) {
    throw new AgentJobRequestError('title exceeds the job size limit', 413, 'TITLE_TOO_LARGE');
  }
  if (input.cwd && byteLength(input.cwd) > AGENT_JOB_LIMITS.maxCwdBytes) {
    throw new AgentJobRequestError('cwd exceeds the job size limit', 413, 'CWD_TOO_LARGE');
  }

  const envEntries = Object.entries(input.env || {});
  if (envEntries.length > AGENT_JOB_LIMITS.maxEnvEntries) {
    throw new AgentJobRequestError('environment has too many entries', 413, 'ENV_TOO_LARGE');
  }
  const envBytes = envEntries.reduce((total, [key, value]) => total + byteLength(key) + byteLength(value), 0);
  if (envBytes > AGENT_JOB_LIMITS.maxEnvBytes) {
    throw new AgentJobRequestError('environment exceeds the job size limit', 413, 'ENV_TOO_LARGE');
  }
}

function assertInputWithinLimits(inputText: string): number {
  const inputBytes = byteLength(inputText);
  if (inputBytes > AGENT_JOB_LIMITS.maxInputBytes) {
    throw new AgentJobRequestError('input exceeds the job size limit', 413, 'INPUT_TOO_LARGE');
  }
  return inputBytes;
}

function transcriptSize(transcriptPath: string): number {
  try {
    return fs.statSync(transcriptPath).size;
  } catch {
    return 0;
  }
}

function appendBoundedTranscriptEntry(
  transcriptPath: string,
  currentBytes: number,
  entry: TranscriptEntry,
): { written: boolean; bytes: number } {
  const line = `${JSON.stringify(entry)}\n`;
  const lineBytes = byteLength(line);
  if (lineBytes > AGENT_JOB_LIMITS.maxTranscriptBytes - currentBytes) {
    return { written: false, bytes: currentBytes };
  }
  fs.appendFileSync(transcriptPath, line, { encoding: 'utf8', flag: 'a', mode: 0o600 });
  return { written: true, bytes: currentBytes + lineBytes };
}

function appendRuntimeEntry(runtime: RuntimeJob, entry: TranscriptEntry): boolean {
  const result = appendBoundedTranscriptEntry(runtime.transcriptPath, runtime.transcriptBytes, entry);
  runtime.transcriptBytes = result.bytes;
  if (result.written) emitOutput(runtime.id, entry);
  return result.written;
}

function appendStandaloneEntry(transcriptPath: string | null | undefined, entry: TranscriptEntry): void {
  if (!transcriptPath) return;
  const resolved = path.resolve(transcriptPath);
  const jobsDir = path.resolve(AGENT_JOBS_DIR);
  if (resolved !== jobsDir && !resolved.startsWith(`${jobsDir}${path.sep}`)) return;
  try {
    const currentBytes = transcriptSize(resolved);
    appendBoundedTranscriptEntry(resolved, currentBytes, entry);
  } catch (error) {
    console.warn('[agent-jobs] Failed to append reconciliation transcript entry:', error);
  }
}

function emitOutput(jobId: string, entry: TranscriptEntry): void {
  for (const listener of listeners) {
    try {
      listener({ jobId, entry });
    } catch (error) {
      console.warn('[agent-jobs] Output listener failed:', error);
    }
  }
}

function emitStatus(
  jobId: string,
  status: Exclude<JobStatus, 'running'>,
  exitCode: number | null,
  finishedAt: Date,
): void {
  const event = { jobId, status, exitCode, finishedAt: finishedAt.toISOString() };
  for (const listener of statusListeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn('[agent-jobs] Status listener failed:', error);
    }
  }
}

function readProcessStartTime(pid: number): string | null {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 1) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(') ');
    if (commandEnd < 0) return null;
    const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTime = fieldsAfterCommand[19]; // proc(5) field 22; this slice begins at field 3.
    return /^\d+$/.test(startTime || '') ? startTime : null;
  } catch {
    return null;
  }
}

const runtimeStartTimeProbe: {
  read(pid: number): string | null;
} = {
  read: readProcessStartTime,
};

function processIdentityMatches(identity: Partial<PersistedRuntimeIdentity> | undefined): identity is PersistedRuntimeIdentity {
  if (!identity || !Number.isInteger(identity.pid) || (identity.pid as number) <= 1) return false;
  if (typeof identity.processStartTime !== 'string' || !identity.processStartTime) return false;
  return readProcessStartTime(identity.pid as number) === identity.processStartTime;
}

function listDescendantPids(rootPid: number): number[] {
  if (process.platform !== 'linux' || !Number.isInteger(rootPid) || rootPid <= 1) return [];
  const children = new Map<number, number[]>();
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number.parseInt(entry, 10);
      if (pid <= 1 || pid === rootPid) continue;
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const commandEnd = stat.lastIndexOf(') ');
        if (commandEnd < 0) continue;
        const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
        const parentPid = Number.parseInt(fieldsAfterCommand[1] || '', 10); // proc(5) field 4.
        if (!Number.isInteger(parentPid) || parentPid <= 0) continue;
        const siblings = children.get(parentPid) || [];
        siblings.push(pid);
        children.set(parentPid, siblings);
      } catch {
        // Processes can exit while /proc is being traversed.
      }
    }
  } catch {
    return [];
  }

  const descendants: number[] = [];
  const pending = [...(children.get(rootPid) || [])];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.shift() as number;
    if (visited.has(pid)) continue;
    visited.add(pid);
    descendants.push(pid);
    pending.push(...(children.get(pid) || []));
  }
  return descendants;
}

function captureDescendantIdentities(rootPid: number): ProcessIdentityMarker[] {
  return listDescendantPids(rootPid).flatMap((pid) => {
    const processStartTime = readProcessStartTime(pid);
    return processStartTime ? [{ pid, processStartTime }] : [];
  });
}

function signalCapturedProcesses(identities: ProcessIdentityMarker[], signal: NodeJS.Signals): boolean {
  let signaled = false;
  for (const identity of identities.slice().reverse()) {
    if (readProcessStartTime(identity.pid) !== identity.processStartTime) continue;
    try {
      process.kill(identity.pid, signal);
      signaled = true;
    } catch (error: any) {
      if (error?.code !== 'ESRCH') {
        console.warn(`[agent-jobs] Failed to signal captured descendant ${identity.pid}:`, error?.message || error);
      }
    }
  }
  return signaled;
}

function readProcessLaunchToken(pid: number): string | null {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 1) return null;
  try {
    const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    for (const entry of environ.split('\0')) {
      const separator = entry.indexOf('=');
      if (separator <= 0) continue;
      if (entry.slice(0, separator) === LAUNCH_TOKEN_ENV) return entry.slice(separator + 1);
    }
  } catch {
    // Process exited, is a reaped zombie (environ is freed), or is unreadable.
  }
  return null;
}

function findProcessesByLaunchTokenImpl(launchToken: string): number[] {
  if (process.platform !== 'linux' || !launchToken) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  const matches: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    if (pid <= 1 || pid === process.pid) continue;
    if (readProcessLaunchToken(pid) === launchToken) matches.push(pid);
  }
  return matches;
}

// Indirection so hostile crash fixtures can simulate an orphan that cannot be
// proven terminated without needing a genuinely unkillable real process.
const persistedProcessProbe: { findByLaunchToken: (launchToken: string) => number[] } = {
  findByLaunchToken: findProcessesByLaunchTokenImpl,
};

async function killProcessesByLaunchToken(launchToken: string): Promise<boolean> {
  const initial = persistedProcessProbe.findByLaunchToken(launchToken);
  if (initial.length === 0) return false;
  const capturedDescendants = initial.flatMap((pid) => {
    const processStartTime = readProcessStartTime(pid);
    const self = processStartTime ? [{ pid, processStartTime }] : [];
    return [...self, ...captureDescendantIdentities(pid)];
  });
  for (const pid of initial) signalProcessTree(pid, 'SIGTERM');
  await wait(AGENT_JOB_LIMITS.terminateGraceMs);
  for (const pid of persistedProcessProbe.findByLaunchToken(launchToken)) {
    signalProcessTree(pid, 'SIGKILL');
  }
  signalCapturedProcesses(capturedDescendants, 'SIGKILL');
  return true;
}

// Bounded confirmation that no process still carries the launch token. Polls to
// give a just-SIGKILLed process time to be reaped (its environ frees on exit)
// before declaring termination proven.
async function launchTokenProvenAbsent(launchToken: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (persistedProcessProbe.findByLaunchToken(launchToken).length === 0) return true;
    await wait(50);
  }
  return persistedProcessProbe.findByLaunchToken(launchToken).length === 0;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error: any) {
      if (error?.code !== 'ESRCH') {
        console.warn(`[agent-jobs] Failed to signal process group ${pid}:`, error?.message || error);
      }
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch (error: any) {
    if (error?.code !== 'ESRCH') {
      console.warn(`[agent-jobs] Failed to signal process ${pid}:`, error?.message || error);
    }
    return false;
  }
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): boolean {
  let signaled = false;
  // Signal deepest descendants directly as well as the original process group.
  // This catches children that created a new process group/session after launch.
  for (const descendantPid of listDescendantPids(pid).reverse()) {
    try {
      process.kill(descendantPid, signal);
      signaled = true;
    } catch (error: any) {
      if (error?.code !== 'ESRCH') {
        console.warn(`[agent-jobs] Failed to signal descendant ${descendantPid}:`, error?.message || error);
      }
    }
  }
  return signalProcessGroup(pid, signal) || signaled;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function createRuntimeBase(input: {
  id: string;
  userId: string;
  actorAuthorizationVersion: number;
  title: string;
  toolId: string;
  type: 'pty' | 'spawn';
  launchToken: string;
  metadata: PersistedJobMetadata;
  scope: PreparedAgentJobSystemdScope;
  pid: number;
  transcriptPath: string;
}): RuntimeJob {
  return {
    ...input,
    processStartTime: runtimeStartTimeProbe.read(input.pid),
    transcriptBytes: transcriptSize(input.transcriptPath),
    outputBytes: 0,
    pendingInputBytes: 0,
    finalized: false,
    exited: false,
    scopeStopAttempted: false,
  };
}

async function proveRuntimeScopeEmpty(
  runtime: RuntimeJob,
): Promise<AgentJobSystemdStopProof> {
  if (!runtime.scopeStopAttempted) {
    runtime.scopeStopAttempted = true;
    return runtime.scope.stop();
  }
  return agentJobSystemdScopeBoundary.stopIdentity(runtime.scope.identity);
}

async function finalizeRuntime(
  runtime: RuntimeJob,
  status: Exclude<JobStatus, 'running'>,
  exitCode: number | null,
): Promise<void> {
  if (runtime.finalizationPromise) return runtime.finalizationPromise;
  runtime.finalizationPromise = (async () => {
    let proof: AgentJobSystemdStopProof;
    try {
      // Launcher/PTY exit is transport state only. The exact systemd scope and
      // recursive cgroup emptiness are the sole terminal authority.
      proof = await proveRuntimeScopeEmpty(runtime);
    } catch (error) {
      appendRuntimeEntry(runtime, {
        type: 'system',
        text: 'The job transport ended, but its exact systemd scope could not be proven empty. The job remains fenced as running.',
        timestamp: new Date().toISOString(),
      });
      throw error;
    }

    const finishedAt = new Date();
    const updated = await prisma.agentJob.updateMany({
      where: {
        id: runtime.id,
        userId: runtime.userId,
        actorAuthorizationVersion: runtime.actorAuthorizationVersion,
        status: 'running',
      },
      data: {
        status,
        exitCode,
        finishedAt,
        metadata: {
          ...runtime.metadata,
          runtime: {
            ...persistedRuntimeMetadata(runtime, true),
            settlement: {
              proven: proof.cgroupEmpty === true,
              scopeUnit: proof.scopeUnit,
              invocationId: proof.invocationId,
              bootId: proof.bootId,
              stopRequested: proof.stopRequested,
              bootChanged: 'bootChanged' in proof ? proof.bootChanged : false,
              finalLoadState: proof.finalLoadState,
              finalActiveState: proof.finalActiveState,
              finalSubState: proof.finalSubState,
              settledAt: finishedAt.toISOString(),
            },
          },
        } as any,
      },
    });
    if (updated.count !== 1) {
      const current = await prisma.agentJob.findUnique({ where: { id: runtime.id } });
      if (!current || current.status === 'running') {
        throw new Error('Agent job terminal state could not be committed after scope settlement');
      }
    } else {
      emitStatus(runtime.id, status, exitCode, finishedAt);
    }
    runtime.finalized = true;
    runtime.authorizationUnsubscribe?.();
    runtime.authorizationUnsubscribe = undefined;
    if (runtimes.get(runtime.id) === runtime) runtimes.delete(runtime.id);

    if (status === 'error') {
      await sendJobFailedAlert(
        runtime.userId,
        runtime.title,
        runtime.toolId,
        exitCode === null ? 'Job was terminated by the Portal safety limits' : `Exited with code ${exitCode}`,
      ).catch((error) => console.warn('[agent-jobs] Failed to send job-failed alert:', error));
    }
  })();
  try {
    await runtime.finalizationPromise;
  } catch (error) {
    runtime.finalizationPromise = undefined;
    throw error;
  }
}

async function handleRuntimeExit(runtime: RuntimeJob, exitCode: number | null): Promise<void> {
  if (runtime.exited) return;
  runtime.exited = true;
  if (runtimes.get(runtime.id) !== runtime && !runtime.finalizationPromise) return;
  const status = runtime.requestedStatus || (exitCode === 0 ? 'completed' : 'error');
  await finalizeRuntime(runtime, status, exitCode);
}

async function terminateRuntime(
  runtime: RuntimeJob,
  status: 'error' | 'killed',
  reason: string,
): Promise<void> {
  if (runtime.terminationPromise) return runtime.terminationPromise;
  runtime.requestedStatus = status;
  runtime.terminationPromise = (async () => {
    appendRuntimeEntry(runtime, {
      type: 'system',
      text: reason,
      timestamp: new Date().toISOString(),
    });
    await finalizeRuntime(runtime, status, null);
  })();
  try {
    await runtime.terminationPromise;
  } catch (error) {
    runtime.terminationPromise = undefined;
    throw error;
  }
}

function recordJobOutput(runtime: RuntimeJob, data: string | Buffer, stream: 'stdout' | 'stderr'): void {
  if (runtime.finalized || runtime.requestedStatus) return;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const remaining = Math.max(0, AGENT_JOB_LIMITS.maxOutputBytes - runtime.outputBytes);
  const acceptedBytes = Math.min(buffer.length, remaining);
  let offset = 0;
  let transcriptFull = false;

  while (offset < acceptedBytes) {
    const end = Math.min(acceptedBytes, offset + AGENT_JOB_LIMITS.maxOutputEntryBytes);
    const entry: TranscriptEntry = {
      type: 'output',
      text: buffer.subarray(offset, end).toString('utf8'),
      stream,
      timestamp: new Date().toISOString(),
    };
    if (!appendRuntimeEntry(runtime, entry)) {
      transcriptFull = true;
      break;
    }
    offset = end;
  }

  runtime.outputBytes += buffer.length;
  if (buffer.length > remaining || transcriptFull) {
    void terminateRuntime(
      runtime,
      'error',
      `Job terminated after exceeding the ${AGENT_JOB_LIMITS.maxOutputBytes}-byte output limit.`,
    );
  }
}

function persistedRuntimeMetadata(
  runtime: RuntimeJob,
  activated: boolean,
): PersistedRuntimeIdentity {
  return {
    portalInstanceId,
    launchToken: runtime.launchToken,
    activated,
    systemdScope: runtime.scope.identity,
    ...(runtime.pid > 1 ? { pid: runtime.pid } : {}),
    processStartTime: runtime.processStartTime,
    detached: false,
    ...(activated
      ? { startedAt: new Date().toISOString() }
      : { preparedAt: new Date().toISOString() }),
  };
}

function attachPtyRuntime(runtime: RuntimeJob, ptyProcess: any): void {
  runtime.ptyProcess = ptyProcess;
  ptyProcess.onData((data: string) => recordJobOutput(runtime, data, 'stdout'));
  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    void handleRuntimeExit(runtime, Number.isInteger(exitCode) ? exitCode : null)
      .catch((error) => {
        console.error('[agent-jobs] PTY scope settlement remains fenced:', error);
      });
  });
}

function attachSpawnRuntime(runtime: RuntimeJob, child: ChildProcessWithoutNullStreams): void {
  runtime.child = child;
  child.stdout.on('data', (chunk: Buffer) => recordJobOutput(runtime, chunk, 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => recordJobOutput(runtime, chunk, 'stderr'));
  child.once('exit', (code) => {
    void handleRuntimeExit(runtime, Number.isInteger(code) ? code : null)
      .catch((error) => {
        console.error('[agent-jobs] Spawn scope settlement remains fenced:', error);
      });
  });
  child.once('error', (error) => {
    appendRuntimeEntry(runtime, {
      type: 'system',
      text: `Job process error: ${error.message}`,
      timestamp: new Date().toISOString(),
    });
    void handleRuntimeExit(runtime, null).catch((settlementError) => {
      console.error('[agent-jobs] Spawn error scope settlement remains fenced:', settlementError);
    });
  });
}

async function assertAgentJobAdmission(
  transaction: any,
  input: StartJobInput,
): Promise<void> {
  const [actor, transition] = await Promise.all([
    transaction.user.findUnique({
      where: { id: input.userId },
      select: {
        authorizationVersion: true,
        accountStatus: true,
        isActive: true,
      },
    }),
    transaction.projectAuthorizationTransition.findFirst({
      where: { phase: { not: 'COMPLETE' } },
      select: { id: true },
    }),
  ]);
  if (transition) {
    throw new AgentJobRequestError(
      'Host job admission is closed during an authorization transition',
      503,
      'AUTHORIZATION_TRANSITION_ACTIVE',
    );
  }
  if (
    !actor
    || actor.accountStatus !== 'ACTIVE'
    || actor.isActive !== true
    || actor.authorizationVersion !== input.actorAuthorizationVersion
  ) {
    throw new AgentJobRequestError(
      'Host job authorization changed before process admission',
      409,
      'AUTHORIZATION_CHANGED',
    );
  }
}

async function startAgentJobInternal(input: StartJobInput) {
  validateStartInput(input);
  const releaseAuthorizationLease = acquireWorkspaceAuthorizationMutationLease(input.userId);
  let preparedScope: PreparedAgentJobSystemdScope | null = null;
  let runtime: RuntimeJob | null = null;
  try {
    if (shuttingDown) throw new Error('Agent job runtime is shutting down');
    await initializeAgentJobsRuntime();
    if (shuttingDown) throw new Error('Agent job runtime is shutting down');

    const jobsDir = initializeAgentJobsStorage();
    const transcriptPath = path.join(jobsDir, `${Date.now()}-${crypto.randomBytes(12).toString('hex')}.jsonl`);
    const cwd = input.cwd || process.cwd();
    const launchToken = createLaunchToken();
    const metadata: PersistedJobMetadata = {
      command: input.command,
      cwd,
      env: input.env || {},
    };
    const baseEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(input.env || {}),
    };
    // The launch token remains for backwards-compatible crash recovery, but the
    // exact systemd scope/cgroup is now the authoritative process identity.
    const launchEnv: Record<string, string> = {
      ...baseEnv,
      [LAUNCH_TOKEN_ENV]: launchToken,
    };

    // Reject stale callers before reserving host resources, then re-attest in
    // both durable scope-persistence transactions below.
    await prisma.$transaction(async (transaction) => {
      await assertAgentJobAdmission(transaction, input);
    }, { isolationLevel: 'Serializable' });

    // prepare() launches only the fixed gate wrapper. Caller code remains
    // blocked while systemd publishes and attests the exact unit, InvocationID,
    // boot identity, and cgroup.
    preparedScope = await agentJobSystemdScopeBoundary.prepare({
      command: input.command,
      cwd,
      env: launchEnv,
    });
    if (!parsePersistedSystemdScope(preparedScope.identity)) {
      throw new Error('Agent job systemd scope identity is invalid');
    }

    const job = await prisma.$transaction(async (transaction) => {
      await assertAgentJobAdmission(transaction, input);
      return transaction.agentJob.create({
        data: {
          userId: input.userId,
          actorAuthorizationVersion: input.actorAuthorizationVersion,
          toolId: input.toolId,
          title: input.title || `${input.toolId} job`,
          status: 'running',
          startedAt: new Date(),
          transcriptPath,
          metadata: {
            ...metadata,
            runtime: {
              portalInstanceId,
              launchToken,
              activated: false,
              systemdScope: preparedScope!.identity,
              preparedAt: new Date().toISOString(),
            },
          } as any,
        },
      });
    }, { isolationLevel: 'Serializable' });

    const title = job.title || `${job.toolId} job`;
    runtime = createRuntimeBase({
      id: job.id,
      userId: input.userId,
      actorAuthorizationVersion: input.actorAuthorizationVersion,
      title,
      toolId: job.toolId,
      type: preparedScope.type,
      launchToken,
      metadata,
      scope: preparedScope,
      pid: preparedScope.pid,
      transcriptPath,
    });
    if (preparedScope.type === 'pty' && preparedScope.ptyProcess) {
      attachPtyRuntime(runtime, preparedScope.ptyProcess);
    } else if (preparedScope.type === 'spawn' && preparedScope.child) {
      attachSpawnRuntime(runtime, preparedScope.child);
    } else {
      throw new Error('Agent job systemd scope transport is unavailable');
    }
    runtimes.set(job.id, runtime);
    runtime.authorizationUnsubscribe = subscribeToAuthorizationChanges(input.userId, () => {
      void terminateRuntime(
        runtime!,
        'killed',
        'Job cancelled because its owner authorization changed.',
      ).catch(() => undefined);
    });
    try {
      if (runtime.exited || runtime.finalized || runtime.requestedStatus) {
        throw new Error('Agent job scope exited before durable activation');
      }
      await prisma.$transaction(async (transaction) => {
        await assertAgentJobAdmission(transaction, input);
        const activated = await transaction.agentJob.updateMany({
          where: {
            id: job.id,
            userId: input.userId,
            actorAuthorizationVersion: input.actorAuthorizationVersion,
            status: 'running',
          },
          data: {
            metadata: {
              ...metadata,
              runtime: persistedRuntimeMetadata(runtime!, true),
            } as any,
          },
        });
        if (activated.count !== 1) {
          throw new Error('Agent job exact scope identity could not be activated durably');
        }
      }, { isolationLevel: 'Serializable' });
      if (runtime.exited || runtime.finalized || runtime.requestedStatus) {
        throw new Error('Agent job scope exited before caller-code release');
      }
      await preparedScope.activate();
    } catch (error) {
      await terminateRuntime(runtime, 'error', 'Job terminated because its runtime identity could not be persisted.');
      throw error;
    }
    return job;
  } catch (error) {
    if (
      preparedScope
      && (!runtime || runtimes.get(runtime.id) !== runtime)
    ) {
      await preparedScope.stop();
    }
    throw error;
  } finally {
    releaseAuthorizationLease();
  }
}

export function startAgentJob(input: StartJobInput) {
  const operation = startAgentJobInternal(input);
  activeStarts.add(operation);
  operation.then(
    () => activeStarts.delete(operation),
    () => activeStarts.delete(operation),
  );
  return operation;
}

export async function writeToAgentJob(jobId: string, userId: string, inputText: string): Promise<void> {
  const inputBytes = assertInputWithinLimits(inputText);
  const releaseAuthorizationLease = acquireWorkspaceAuthorizationMutationLease(userId);
  try {
    await initializeAgentJobsRuntime();
    const [job, actor, transition] = await Promise.all([
      prisma.agentJob.findUnique({ where: { id: jobId } }),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          authorizationVersion: true,
          accountStatus: true,
          isActive: true,
        },
      }),
      prisma.projectAuthorizationTransition.findFirst({
        where: { phase: { not: 'COMPLETE' } },
        select: { id: true },
      }),
    ]);
    if (!job) throw new Error('Job not found');
    if (job.userId !== userId) throw new Error('Forbidden');
    if (
      transition
      || !actor
      || actor.accountStatus !== 'ACTIVE'
      || actor.isActive !== true
      || actor.authorizationVersion !== job.actorAuthorizationVersion
    ) {
      throw new AgentJobRequestError(
        'Job authorization changed; the retained process cannot accept more input',
        409,
        'AUTHORIZATION_CHANGED',
      );
    }

    const runtime = runtimes.get(jobId);
    if (
      !runtime
      || runtime.finalized
      || runtime.exited
      || runtime.requestedStatus
    ) {
      throw new Error('Job is not running');
    }
    if (
      runtime.userId !== userId
      || runtime.actorAuthorizationVersion !== job.actorAuthorizationVersion
    ) {
      throw new Error('Forbidden');
    }
    if (runtime.pendingInputBytes + inputBytes > AGENT_JOB_LIMITS.maxPendingInputBytes) {
      throw new AgentJobRequestError('job input queue is full', 429, 'INPUT_QUEUE_FULL');
    }

    const entry: TranscriptEntry = {
      type: 'input',
      text: inputText,
      timestamp: new Date().toISOString(),
    };
    if (!appendRuntimeEntry(runtime, entry)) {
      await terminateRuntime(runtime, 'error', 'Job terminated because its transcript reached the size limit.');
      throw new AgentJobRequestError('job transcript has reached its size limit', 413, 'TRANSCRIPT_FULL');
    }

    runtime.pendingInputBytes += inputBytes;
    if (runtime.type === 'pty' && runtime.ptyProcess) {
      try {
        runtime.ptyProcess.write(inputText);
      } finally {
        runtime.pendingInputBytes -= inputBytes;
      }
      return;
    }

    if (runtime.child?.stdin.writable) {
      try {
        runtime.child.stdin.write(inputText, () => {
          runtime.pendingInputBytes = Math.max(0, runtime.pendingInputBytes - inputBytes);
        });
      } catch (error) {
        runtime.pendingInputBytes = Math.max(0, runtime.pendingInputBytes - inputBytes);
        throw error;
      }
      return;
    }

    runtime.pendingInputBytes = Math.max(0, runtime.pendingInputBytes - inputBytes);
    throw new Error('Job stdin unavailable');
  } finally {
    releaseAuthorizationLease();
  }
}

export async function killAgentJob(jobId: string, userId: string): Promise<void> {
  await initializeAgentJobsRuntime();
  const job = await prisma.agentJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error('Job not found');
  if (job.userId !== userId) throw new Error('Forbidden');

  // Cancellation is intentionally idempotent. A browser retry, reconnect, or
  // duplicated operator request can arrive after the first request has already
  // committed the terminal state. Treat that as success without signaling a
  // reused PID or changing the retained transcript.
  if (job.status !== 'running') return;

  const runtime = runtimes.get(jobId);
  if (!runtime || runtime.finalized) throw new Error('Job runtime is unavailable');
  if (runtime.userId !== userId) throw new Error('Forbidden');
  await terminateRuntime(runtime, 'killed', 'Job cancelled by a Portal host operator.');
}

export interface AgentJobAuthorizationQuiescence {
  jobCount: number;
  liveRuntimeCount: number;
  persistedRuntimeSignalCount: number;
}

type AgentJobQuiescenceReason = 'authorization_transition' | 'project_dependency_promotion';

/**
 * Authorization transitions call this only while the global workspace
 * admission fence is closed. It converges both this process's runtime objects
 * and restart-surviving process groups identified by durable PID/start-time
 * metadata, then proves no selected row is still RUNNING.
 */
async function quiesceAgentJobs(input: {
  userIds?: readonly string[];
  reason: AgentJobQuiescenceReason;
}): Promise<AgentJobAuthorizationQuiescence> {
  const selectedUserIds = input.userIds === undefined ? null : Array.from(new Set(
    input.userIds.map((value) => String(value || '').trim()).filter(Boolean),
  )).sort();
  if (selectedUserIds?.length === 0) {
    return { jobCount: 0, liveRuntimeCount: 0, persistedRuntimeSignalCount: 0 };
  }

  await initializeAgentJobsRuntime();
  await Promise.allSettled(Array.from(activeStarts));
  const jobs = await prisma.agentJob.findMany({
    where: {
      status: 'running',
      ...(selectedUserIds ? { userId: { in: selectedUserIds } } : {}),
    },
    select: {
      id: true,
      userId: true,
      actorAuthorizationVersion: true,
      transcriptPath: true,
      metadata: true,
    },
  });
  let liveRuntimeCount = 0;
  let persistedRuntimeSignalCount = 0;

  for (const job of jobs) {
    const runtime = runtimes.get(job.id);
    if (runtime) {
      if (
        runtime.userId !== job.userId
        || runtime.actorAuthorizationVersion !== job.actorAuthorizationVersion
      ) {
        throw new Error('Agent job runtime identity drifted before authorization cleanup');
      }
      liveRuntimeCount += 1;
      await terminateRuntime(
        runtime,
        'killed',
        input.reason === 'authorization_transition'
          ? 'Job cancelled before its owner authorization generation changed.'
          : 'Job cancelled before a Project dependency generation was promoted.',
      );
      continue;
    }

    const metadata = asObject(job.metadata) as PersistedJobMetadata;
    const outcome = await terminatePersistedRuntime(metadata.runtime);
    const finishedAt = new Date();
    if (!outcome.proven) {
      // Fail closed: a possibly-live retained process could not be proven
      // terminated. Leave the row RUNNING so the residual guard below refuses
      // the authorization transition rather than marking the row terminal on
      // DB status alone.
      appendStandaloneEntry(job.transcriptPath, {
        type: 'system',
        text: input.reason === 'authorization_transition'
          ? 'A retained host process could not be proven terminated; the authorization transition is refused.'
          : 'A retained host process could not be proven terminated; dependency promotion is refused.',
        timestamp: finishedAt.toISOString(),
      });
      continue;
    }
    if (outcome.signaled) persistedRuntimeSignalCount += 1;
    appendStandaloneEntry(job.transcriptPath, {
      type: 'system',
      text: input.reason === 'authorization_transition'
        ? 'A retained host process was cancelled before its owner authorization generation changed.'
        : 'A retained host process was cancelled before a Project dependency generation was promoted.',
      timestamp: finishedAt.toISOString(),
    });
    await prisma.agentJob.updateMany({
      where: {
        id: job.id,
        status: 'running',
        actorAuthorizationVersion: job.actorAuthorizationVersion,
      },
      data: {
        status: 'killed',
        exitCode: null,
        finishedAt,
        metadata: {
          ...metadata,
          [input.reason === 'authorization_transition'
            ? 'authorizationTransition'
            : 'projectDependencyPromotion']: {
            portalInstanceId,
            quiescedAt: finishedAt.toISOString(),
            persistedRuntimeSignaled: outcome.signaled,
          },
        } as any,
      },
    });
  }

  const residual = await prisma.agentJob.findFirst({
    where: {
      status: 'running',
      ...(selectedUserIds ? { userId: { in: selectedUserIds } } : {}),
    },
    select: { id: true },
  });
  if (residual) {
    throw new Error(input.reason === 'authorization_transition'
      ? 'A host job remained active after authorization cleanup'
      : 'A host job remained active before dependency promotion');
  }
  return {
    jobCount: jobs.length,
    liveRuntimeCount,
    persistedRuntimeSignalCount,
  };
}

export function quiesceAgentJobsForAuthorizationTransition(
  userIds: readonly string[],
): Promise<AgentJobAuthorizationQuiescence> {
  return quiesceAgentJobs({ userIds, reason: 'authorization_transition' });
}

export function quiesceAgentJobsForProjectDependencyPromotion(
): Promise<AgentJobAuthorizationQuiescence> {
  return quiesceAgentJobs({ reason: 'project_dependency_promotion' });
}

function readBoundedTranscriptFile(transcriptPath: string, maxReadBytes = AGENT_JOB_LIMITS.maxTranscriptReadBytes): { text: string; truncated: boolean } {
  const stat = fs.statSync(transcriptPath);
  const readBytes = Math.min(stat.size, maxReadBytes);
  const start = Math.max(0, stat.size - readBytes);
  const buffer = Buffer.allocUnsafe(readBytes);
  const handle = fs.openSync(transcriptPath, 'r');
  try {
    const actual = fs.readSync(handle, buffer, 0, readBytes, start);
    let text = buffer.subarray(0, actual).toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : '';
    }
    return { text, truncated: start > 0 };
  } finally {
    fs.closeSync(handle);
  }
}

export interface ReadTranscriptOptions {
  maxEntries?: number;
  maxReadBytes?: number;
}

export async function readTranscript(jobId: string, options: ReadTranscriptOptions = {}): Promise<TranscriptEntry[]> {
  await initializeAgentJobsRuntime();
  const job = await prisma.agentJob.findUnique({ where: { id: jobId }, select: { transcriptPath: true } });
  if (!job?.transcriptPath || !fs.existsSync(job.transcriptPath)) return [];

  const resolved = path.resolve(job.transcriptPath);
  const jobsDir = path.resolve(AGENT_JOBS_DIR);
  if (!resolved.startsWith(`${jobsDir}${path.sep}`)) return [];
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) return [];

  const maxEntries = Number.isSafeInteger(options.maxEntries) && Number(options.maxEntries) > 0
    ? Math.min(Number(options.maxEntries), AGENT_JOB_LIMITS.maxTranscriptEntries)
    : AGENT_JOB_LIMITS.maxTranscriptEntries;
  const maxReadBytes = Number.isSafeInteger(options.maxReadBytes) && Number(options.maxReadBytes) > 0
    ? Math.min(Number(options.maxReadBytes), AGENT_JOB_LIMITS.maxTranscriptReadBytes)
    : AGENT_JOB_LIMITS.maxTranscriptReadBytes;
  const bounded = readBoundedTranscriptFile(resolved, maxReadBytes);
  const entries = bounded.text
    .split('\n')
    .filter(Boolean)
    .slice(-maxEntries)
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is TranscriptEntry => !!entry);

  if (bounded.truncated) {
    entries.unshift({
      type: 'system',
      text: 'Earlier transcript data was omitted by the Portal read limit.',
      timestamp: new Date().toISOString(),
    });
  }
  return entries;
}

async function terminatePersistedRuntime(
  identity: Partial<PersistedRuntimeIdentity> | undefined,
): Promise<PersistedTerminationOutcome> {
  if (identity && Object.prototype.hasOwnProperty.call(identity, 'systemdScope')) {
    const systemdScope = parsePersistedSystemdScope(identity.systemdScope);
    if (!systemdScope) {
      return { matched: false, signaled: false, proven: false };
    }
    try {
      const proof = await agentJobSystemdScopeBoundary.stopIdentity(systemdScope);
      return {
        matched: true,
        signaled: proof.stopRequested,
        proven: proof.cgroupEmpty === true,
      };
    } catch {
      // Never fall back to PID or environment-marker signaling once an exact
      // systemd identity exists. A mismatched/unreadable unit must remain fenced.
      return { matched: true, signaled: false, proven: false };
    }
  }

  let signaled = false;
  let matched = false;

  // Activated identity whose PID/start-time still match: authoritative group kill.
  if (processIdentityMatches(identity)) {
    matched = true;
    const pid = identity.pid as number;
    const capturedDescendants = captureDescendantIdentities(pid);
    signalProcessTree(pid, 'SIGTERM');
    await wait(AGENT_JOB_LIMITS.terminateGraceMs);
    if (processIdentityMatches(identity)) signalProcessTree(pid, 'SIGKILL');
    signalCapturedProcesses(capturedDescendants, 'SIGKILL');
    signaled = true;
  }

  // Durable launch token: finds and proves-absent an orphan even when the crash
  // happened before the PID was persisted, and catches descendants that escaped
  // the original process group. This is the authority on `proven`.
  const launchToken = typeof identity?.launchToken === 'string' && identity.launchToken.length > 0
    ? identity.launchToken
    : null;
  if (launchToken) {
    const tokenSignaled = await killProcessesByLaunchToken(launchToken);
    signaled = signaled || tokenSignaled;
    const tokenAbsent = await launchTokenProvenAbsent(launchToken);
    if (!tokenAbsent) {
      return { matched: matched || tokenSignaled, signaled, proven: false };
    }
    // A PREPARED row with neither persisted PID identity nor an observed token
    // cannot be declared dead merely because /proc is empty at this instant: a
    // forked child may not have exec'd the wrapper yet. The wrapper's parent-
    // bound socket prevents caller code from running, but the row remains fenced
    // until a later pass observes and kills the wrapper.
    if (identity?.activated === false && !matched && !tokenSignaled) {
      return { matched: false, signaled: false, proven: false };
    }
    return { matched: matched || tokenSignaled, signaled, proven: true };
  }

  // Legacy activated identity without a token: SIGKILL to a matched process
  // group is authoritative, so a completed signal pass is treated as proven.
  if (matched) {
    return { matched: true, signaled, proven: true };
  }

  // No durable identity of any kind: an orphan can neither be found nor proven
  // gone. Fail closed so callers do not mark the row terminal on DB status alone.
  return { matched: false, signaled: false, proven: false };
}

/** Reconcile DB rows left running by a crashed or forcibly-restarted Portal. */
export async function reconcilePersistedAgentJobs(): Promise<{ reconciled: number; signaled: number }> {
  const jobs = await prisma.agentJob.findMany({
    where: { status: 'running' },
    select: {
      id: true,
      metadata: true,
      transcriptPath: true,
    },
  });
  let reconciled = 0;
  let signaled = 0;
  const candidates = jobs.filter((job) => !runtimes.has(job.id));
  const outcomes = await Promise.all(candidates.map((job) => {
    const metadata = asObject(job.metadata) as PersistedJobMetadata;
    return terminatePersistedRuntime(metadata.runtime);
  }));

  for (const [index, job] of candidates.entries()) {
    const metadata = asObject(job.metadata) as PersistedJobMetadata;
    const outcome = outcomes[index];
    const timestamp = new Date();

    if (!outcome.proven) {
      // Fail closed: a matching host process may still be alive and could not be
      // proven terminated. Keep the row RUNNING (fenced) so a later restart pass
      // retries, and never report a terminal state we cannot back up.
      console.error(
        `[agent-jobs] Reconciliation could not prove termination of job ${job.id}; leaving it fenced as running.`,
      );
      appendStandaloneEntry(job.transcriptPath, {
        type: 'system',
        text: 'Portal restarted before this job completed and a matching host process could not be proven terminated. The job remains fenced pending a successful reconciliation.',
        timestamp: timestamp.toISOString(),
      });
      await prisma.agentJob.updateMany({
        where: { id: job.id, status: 'running' },
        data: {
          metadata: {
            ...metadata,
            reconciliation: {
              portalInstanceId,
              reconciledAt: timestamp.toISOString(),
              orphanProcessSignaled: outcome.signaled,
              orphanProven: false,
            },
          } as any,
        },
      });
      continue;
    }

    if (outcome.signaled) signaled += 1;
    appendStandaloneEntry(job.transcriptPath, {
      type: 'system',
      text: 'Portal restarted before this job completed. Any matching orphaned process tree was terminated.',
      timestamp: timestamp.toISOString(),
    });
    const result = await prisma.agentJob.updateMany({
      where: { id: job.id, status: 'running' },
      data: {
        status: 'error',
        exitCode: null,
        finishedAt: timestamp,
        metadata: {
          ...metadata,
          reconciliation: {
            portalInstanceId,
            reconciledAt: timestamp.toISOString(),
            orphanProcessSignaled: outcome.signaled,
            orphanProven: true,
          },
        } as any,
      },
    });
    reconciled += result.count;
  }

  return { reconciled, signaled };
}

/**
 * Idempotent Portal-start hook. Call after the database health check and before
 * accepting agent-job HTTP/WebSocket traffic.
 */
export async function initializeAgentJobsRuntime(): Promise<{ reconciled: number; signaled: number }> {
  if (shuttingDown) throw new Error('Agent job runtime is shutting down');
  initializeAgentJobsStorage();
  if (!startupPromise) {
    startupPromise = (async () => {
      await agentJobSystemdScopeBoundary.initialize();
      return reconcilePersistedAgentJobs();
    })().catch((error) => {
      startupPromise = null;
      throw error;
    });
  }
  return startupPromise;
}

/** Call before disconnecting Prisma during graceful Portal shutdown. */
export function shutdownAgentJobsRuntime(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    if (startupPromise) await Promise.allSettled([startupPromise]);
    await Promise.allSettled(Array.from(activeStarts));
    await Promise.all(Array.from(runtimes.values()).map((runtime) => terminateRuntime(
      runtime,
      'killed',
      'Job cancelled because the Portal is shutting down.',
    )));
    runtimes.clear();
  })();
  return shutdownPromise;
}

export function onAgentJobOutput(listener: (event: { jobId: string; entry: TranscriptEntry }) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function onAgentJobStatus(listener: (event: {
  jobId: string;
  status: Exclude<JobStatus, 'running'>;
  exitCode: number | null;
  finishedAt: string;
}) => void) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export const __agentJobsTest = {
  portalInstanceId,
  runtimes,
  LAUNCH_TOKEN_ENV,
  readProcessStartTime,
  processIdentityMatches,
  captureDescendantIdentities,
  signalCapturedProcesses,
  signalProcessGroup,
  signalProcessTree,
  recordJobOutput,
  readProcessLaunchToken,
  findProcessesByLaunchToken: findProcessesByLaunchTokenImpl,
  terminatePersistedRuntime,
  prepareHostAgentJobSystemdScope,
  createAgentJobActivationGate,
  activationWrapperCommand,
  setSystemdScopeBoundary(boundary: AgentJobSystemdScopeBoundary): void {
    agentJobSystemdScopeBoundary.initialize = boundary.initialize;
    agentJobSystemdScopeBoundary.prepare = boundary.prepare;
    agentJobSystemdScopeBoundary.stopIdentity = boundary.stopIdentity;
  },
  restoreSystemdScopeBoundary(): void {
    agentJobSystemdScopeBoundary.initialize = (...args) => (
      defaultAgentJobSystemdScopeBoundary.initialize(...args)
    );
    agentJobSystemdScopeBoundary.prepare = (...args) => (
      defaultAgentJobSystemdScopeBoundary.prepare(...args)
    );
    agentJobSystemdScopeBoundary.stopIdentity = (...args) => (
      defaultAgentJobSystemdScopeBoundary.stopIdentity(...args)
    );
  },
  setActivationGateFactory(
    create: (jobsDir: string, launchToken: string) => Promise<AgentJobActivationGate>,
  ): void {
    activationGateFactory.create = create;
  },
  restoreActivationGateFactory(): void {
    activationGateFactory.create = createAgentJobActivationGate;
  },
  setRuntimeStartTimeProbe(read: (pid: number) => string | null): void {
    runtimeStartTimeProbe.read = read;
  },
  restoreRuntimeStartTimeProbe(): void {
    runtimeStartTimeProbe.read = readProcessStartTime;
  },
  setPersistedProcessProbe(findByLaunchToken: (launchToken: string) => number[]): void {
    persistedProcessProbe.findByLaunchToken = findByLaunchToken;
  },
  restorePersistedProcessProbe(): void {
    persistedProcessProbe.findByLaunchToken = findProcessesByLaunchTokenImpl;
  },
  resetRuntimeState(): void {
    for (const runtime of runtimes.values()) runtime.authorizationUnsubscribe?.();
    runtimes.clear();
    listeners.clear();
    statusListeners.clear();
    activeStarts.clear();
    startupPromise = null;
    shutdownPromise = null;
    shuttingDown = false;
    activationGateFactory.create = createAgentJobActivationGate;
    agentJobSystemdScopeBoundary.initialize = (...args) => (
      defaultAgentJobSystemdScopeBoundary.initialize(...args)
    );
    agentJobSystemdScopeBoundary.prepare = (...args) => (
      defaultAgentJobSystemdScopeBoundary.prepare(...args)
    );
    agentJobSystemdScopeBoundary.stopIdentity = (...args) => (
      defaultAgentJobSystemdScopeBoundary.stopIdentity(...args)
    );
    runtimeStartTimeProbe.read = readProcessStartTime;
    persistedProcessProbe.findByLaunchToken = findProcessesByLaunchTokenImpl;
  },
};
