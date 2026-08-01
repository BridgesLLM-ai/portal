import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn as spawnPty, type IPty, type IPtyForkOptions } from 'node-pty';
import { promisify } from 'util';
import { ensureRuntimeDirectory } from '../utils/runtimeDirectory';

const execFileAsync = promisify(execFile);

const SYSTEMD_RUN = '/usr/bin/systemd-run';
const SYSTEMCTL = '/usr/bin/systemctl';
const SYSTEMD_CGROUP_ROOT = '/sys/fs/cgroup';
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const TERMINAL_SCOPE_RUNTIME_ROOT = '/run/bridgesllm/terminal-scopes';
const PORTAL_SERVICE_UNIT = 'bridgesllm-product.service';
const SYSTEMD_OPERATION_TIMEOUT_MS = 45_000;
const SYSTEMD_ATTEST_TIMEOUT_MS = 10_000;
const SYSTEMD_SETTLE_TIMEOUT_MS = 30_000;
const SYSTEMD_POLL_MS = 100;
const SYSTEMD_LAUNCHER_TERM_GRACE_MS = 3_000;
const SYSTEMD_LAUNCHER_SETTLE_TIMEOUT_MS = 5_000;
const SYSTEMD_OUTPUT_MAX_BYTES = 1024 * 1024;
const ACTIVATION_HANDSHAKE_TIMEOUT_MS = 30_000;
const TARGET_ENVIRONMENT_MAX_BYTES = 256 * 1024;
const UNIX_SOCKET_PATH_MAX_BYTES = 100;
const TERMINAL_SCOPE_UNIT_PATTERN = /^bridgesllm-terminal-([0-9a-f]{32})\.scope$/;
const TERMINAL_SCOPE_TAG_PATTERN = /^[0-9a-f]{64}$/;
const INVOCATION_ID_PATTERN = /^[0-9a-f]{32}$/;
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DESCRIPTION_PREFIX = 'BridgesLLM privileged terminal tag=';
const SCOPE_TIMEOUT_STOP_USEC = '5s';
const MINIMUM_SUPPORTED_SYSTEMD_VERSION = 249;
const SYSTEMD_RUN_NO_EXPAND_MIN_VERSION = 254;

const SYSTEMD_BOOTSTRAP_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
});

type TerminalBoundaryErrorCode =
  | 'TERMINAL_SCOPE_IDENTITY_INVALID'
  | 'TERMINAL_SCOPE_LAUNCH_FAILED'
  | 'TERMINAL_SCOPE_ATTESTATION_UNPROVEN'
  | 'TERMINAL_SCOPE_IDENTITY_MISMATCH'
  | 'TERMINAL_SCOPE_SETTLEMENT_UNPROVEN'
  | 'TERMINAL_SCOPE_RECOVERY_UNPROVEN'
  | 'TERMINAL_SCOPE_RUNTIME_UNAVAILABLE';

export class TerminalSystemdScopeError extends Error {
  readonly statusCode = 503;
  readonly retryable = true;

  constructor(
    message: string,
    public readonly code: TerminalBoundaryErrorCode,
    public readonly settlementProven: boolean,
  ) {
    super(message);
    this.name = 'TerminalSystemdScopeError';
  }
}

export interface TerminalSystemdScopeReservation {
  scopeUnit: string;
  scopeTag: string;
  description: string;
  controlGroup: string;
  bootId: string;
}

export interface TerminalSystemdScopeIdentity extends TerminalSystemdScopeReservation {
  invocationId: string;
}

export interface TerminalSystemdScopeSnapshot {
  installed: boolean;
  loadState: string;
  activeState: string;
  subState: string;
  description: string;
  invocationId: string | null;
  controlGroup: string | null;
  killMode: string;
  timeoutStopUsec: string;
  bindsTo: string[];
  after: string[];
}

export interface TerminalSystemdScopeStopProof {
  scopeUnit: string;
  invocationId: string;
  bootId: string;
  stopRequested: boolean;
  bootChanged: boolean;
  cgroupEmpty: true;
  finalLoadState: string;
  finalActiveState: string;
  finalSubState: string;
}

export interface PreparedTerminalSystemdScope {
  readonly pty: IPty;
  readonly identity: TerminalSystemdScopeIdentity;
  activate(): Promise<void>;
  stop(): Promise<TerminalSystemdScopeStopProof>;
}

export interface PrepareTerminalSystemdScopeInput {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  terminalName?: string;
}

interface TerminalScopeActivationGate {
  readonly socketPath: string;
  readonly ready: Promise<void>;
  prepareTargetEnvironment(environment: NodeJS.ProcessEnv): void;
  release(): Promise<void>;
  abort(): Promise<void>;
}

export interface TerminalSystemdScopeDependencies {
  ptySpawn(
    file: string,
    args: string[],
    options: IPtyForkOptions,
  ): IPty;
  systemdRunVersion(): Promise<string>;
  systemctl(args: readonly string[]): Promise<string>;
  listTerminalScopeUnits(): Promise<string>;
  readCgroupEvents(controlGroup: string): Promise<string | null>;
  readBootId(): Promise<string>;
  randomUUID(): string;
  randomBytes(size: number): Buffer;
  wait(ms: number): Promise<void>;
  now(): number;
  createActivationGate(
    scopeUnit: string,
    scopeTag: string,
  ): Promise<TerminalScopeActivationGate>;
  initializeStorage(): string;
  scavengeActivationSockets(): void;
}

const TERMINAL_ACTIVATION_WRAPPER_SOURCE = `
const net = require('net');
const { spawn } = require('child_process');
const [socketPath, scopeTag, command, ...args] = process.argv.slice(1);
let settled = false;
let target = null;
let phase = 'environment';
let inbound = Buffer.alloc(0);
let expectedEnvironmentBytes = null;
let targetEnvironment = null;
const failClosed = (code = 125) => {
  if (settled) return;
  settled = true;
  try { socket.destroy(); } catch {}
  process.exit(code);
};
if (!socketPath || !/^[0-9a-f]{64}$/.test(scopeTag || '') || !command) process.exit(126);
const socket = net.createConnection({ path: socketPath });
const deadline = setTimeout(() => failClosed(124), 35000);
socket.once('connect', () => socket.write(scopeTag + '\\n'));
socket.on('data', (chunk) => {
  if (settled || !Buffer.isBuffer(chunk)) return failClosed();
  inbound = Buffer.concat([inbound, chunk]);
  if (phase === 'environment') {
    if (expectedEnvironmentBytes === null) {
      const newline = inbound.indexOf(0x0a);
      if (newline < 0) {
        if (inbound.length > 32) failClosed();
        return;
      }
      const header = inbound.subarray(0, newline).toString('ascii');
      if (!/^E[1-9][0-9]{0,7}$/.test(header)) return failClosed();
      expectedEnvironmentBytes = Number(header.slice(1));
      if (!Number.isSafeInteger(expectedEnvironmentBytes) || expectedEnvironmentBytes > 400000) {
        return failClosed();
      }
      inbound = inbound.subarray(newline + 1);
    }
    if (inbound.length < expectedEnvironmentBytes) return;
    if (inbound.length !== expectedEnvironmentBytes) return failClosed();
    try {
      const decoded = Buffer.from(inbound.toString('ascii'), 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return failClosed();
      targetEnvironment = Object.create(null);
      for (const [key, value] of Object.entries(parsed)) {
        if (!key || key.includes('\\0') || key.includes('=') || typeof value !== 'string' || value.includes('\\0')) {
          return failClosed();
        }
        targetEnvironment[key] = value;
      }
    } catch {
      return failClosed();
    }
    phase = 'release';
    inbound = Buffer.alloc(0);
    socket.write('A');
    return;
  }

  if (inbound.length !== 1 || inbound[0] !== 0x31 || !targetEnvironment) return failClosed();
  settled = true;
  clearTimeout(deadline);
  socket.destroy();
  target = spawn(command, args, {
    cwd: process.cwd(),
    env: targetEnvironment,
    stdio: 'inherit',
    shell: false,
  });
  target.once('error', () => process.exit(127));
  target.once('exit', (code, signal) => {
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
socket.once('end', () => failClosed());
socket.once('close', () => failClosed());
socket.once('error', () => failClosed());
`;

function identityInvalid(message: string): TerminalSystemdScopeError {
  return new TerminalSystemdScopeError(
    message,
    'TERMINAL_SCOPE_IDENTITY_INVALID',
    true,
  );
}

function identityMismatch(message: string): TerminalSystemdScopeError {
  return new TerminalSystemdScopeError(
    message,
    'TERMINAL_SCOPE_IDENTITY_MISMATCH',
    false,
  );
}

function settlementUnproven(message: string): TerminalSystemdScopeError {
  return new TerminalSystemdScopeError(
    message,
    'TERMINAL_SCOPE_SETTLEMENT_UNPROVEN',
    false,
  );
}

function descriptionForTag(scopeTag: string): string {
  return `${DESCRIPTION_PREFIX}${scopeTag}`;
}

function controlGroupForUnit(scopeUnit: string): string {
  return `/system.slice/${scopeUnit}`;
}

function assertScopeUnit(scopeUnit: unknown): asserts scopeUnit is string {
  if (
    typeof scopeUnit !== 'string'
    || !TERMINAL_SCOPE_UNIT_PATTERN.test(scopeUnit)
  ) {
    throw identityInvalid('Terminal systemd scope unit is invalid');
  }
}

function assertScopeTag(scopeTag: unknown): asserts scopeTag is string {
  if (
    typeof scopeTag !== 'string'
    || !TERMINAL_SCOPE_TAG_PATTERN.test(scopeTag)
  ) {
    throw identityInvalid('Terminal systemd scope tag is invalid');
  }
}

function assertBootId(bootId: unknown): asserts bootId is string {
  if (typeof bootId !== 'string' || !BOOT_ID_PATTERN.test(bootId)) {
    throw identityInvalid('Terminal host boot identity is invalid');
  }
}

function assertReservation(
  reservation: TerminalSystemdScopeReservation,
): void {
  if (!reservation || typeof reservation !== 'object') {
    throw identityInvalid('Terminal systemd scope reservation is invalid');
  }
  assertScopeUnit(reservation.scopeUnit);
  assertScopeTag(reservation.scopeTag);
  assertBootId(reservation.bootId);
  if (reservation.description !== descriptionForTag(reservation.scopeTag)) {
    throw identityInvalid('Terminal systemd scope description is invalid');
  }
  if (reservation.controlGroup !== controlGroupForUnit(reservation.scopeUnit)) {
    throw identityInvalid('Terminal systemd cgroup identity is invalid');
  }
}

function assertIdentity(identity: TerminalSystemdScopeIdentity): void {
  assertReservation(identity);
  if (
    typeof identity.invocationId !== 'string'
    || !INVOCATION_ID_PATTERN.test(identity.invocationId)
  ) {
    throw identityInvalid('Terminal systemd invocation identity is invalid');
  }
}

function validatePrepareInput(input: PrepareTerminalSystemdScopeInput): void {
  if (
    typeof input.command !== 'string'
    || !path.posix.isAbsolute(input.command)
    || path.posix.normalize(input.command) !== input.command
    || input.command.includes('\0')
  ) {
    throw identityInvalid('Terminal command is invalid');
  }
  if (
    !Array.isArray(input.args)
    || input.args.some((argument) => (
      typeof argument !== 'string' || argument.includes('\0')
    ))
  ) {
    throw identityInvalid('Terminal command arguments are invalid');
  }
  if (
    typeof input.cwd !== 'string'
    || !path.posix.isAbsolute(input.cwd)
    || path.posix.normalize(input.cwd) !== input.cwd
    || input.cwd.includes('\0')
  ) {
    throw identityInvalid('Terminal working directory is invalid');
  }
  if (!input.env || typeof input.env !== 'object') {
    throw identityInvalid('Terminal target environment is invalid');
  }
  if (
    !Number.isSafeInteger(input.cols)
    || input.cols < 1
    || !Number.isSafeInteger(input.rows)
    || input.rows < 1
  ) {
    throw identityInvalid('Terminal dimensions are invalid');
  }
  if (
    input.terminalName !== undefined
    && (
      typeof input.terminalName !== 'string'
      || !/^[A-Za-z0-9._+-]{1,64}$/.test(input.terminalName)
    )
  ) {
    throw identityInvalid('Terminal type is invalid');
  }
}

function parseSystemdRunVersion(output: string): number {
  const firstLine = String(output || '').split(/\r?\n/, 1)[0];
  const match = /^systemd ([0-9]{1,4})(?:\s|$)/.exec(firstLine);
  if (!match) {
    throw new TerminalSystemdScopeError(
      'Terminal systemd-run version could not be attested',
      'TERMINAL_SCOPE_ATTESTATION_UNPROVEN',
      true,
    );
  }
  const version = Number(match[1]);
  if (
    !Number.isSafeInteger(version)
    || version < MINIMUM_SUPPORTED_SYSTEMD_VERSION
  ) {
    throw new TerminalSystemdScopeError(
      'Terminal systemd-run version is unsupported',
      'TERMINAL_SCOPE_ATTESTATION_UNPROVEN',
      true,
    );
  }
  return version;
}

function parseUnitList(output: string): string[] {
  const units: string[] = [];
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const unit = line.split(/\s+/, 1)[0];
    if (!TERMINAL_SCOPE_UNIT_PATTERN.test(unit) || units.includes(unit)) {
      throw new TerminalSystemdScopeError(
        'Terminal systemd scope inventory is malformed',
        'TERMINAL_SCOPE_RECOVERY_UNPROVEN',
        false,
      );
    }
    units.push(unit);
  }
  return units.sort();
}

function parseUnitSet(raw: string): string[] {
  if (!raw.trim()) return [];
  const units = raw.trim().split(/\s+/);
  if (
    units.some((unit) => (
      !/^[A-Za-z0-9:_.@\\-]{1,255}$/.test(unit)
    ))
  ) {
    throw identityMismatch('Terminal systemd dependency state is malformed');
  }
  return [...new Set(units)].sort();
}

function parseSystemctlShow(output: string): TerminalSystemdScopeSnapshot {
  const expectedFields = new Set([
    'LoadState',
    'ActiveState',
    'SubState',
    'Description',
    'InvocationID',
    'ControlGroup',
    'KillMode',
    'TimeoutStopUSec',
    'BindsTo',
    'After',
  ]);
  const fields = new Map<string, string>();
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    if (!rawLine) continue;
    const delimiter = rawLine.indexOf('=');
    if (delimiter <= 0) {
      throw identityMismatch('Terminal systemd scope state is malformed');
    }
    const key = rawLine.slice(0, delimiter);
    if (!expectedFields.has(key) || fields.has(key)) {
      throw identityMismatch('Terminal systemd scope state is malformed');
    }
    fields.set(key, rawLine.slice(delimiter + 1));
  }
  if (fields.size !== expectedFields.size) {
    throw identityMismatch('Terminal systemd scope state is incomplete');
  }

  const loadState = String(fields.get('LoadState') || '').trim();
  const activeState = String(fields.get('ActiveState') || '').trim();
  const subState = String(fields.get('SubState') || '').trim();
  const description = String(fields.get('Description') || '');
  const invocationId = String(fields.get('InvocationID') || '').trim() || null;
  const controlGroup = String(fields.get('ControlGroup') || '').trim() || null;
  const killMode = String(fields.get('KillMode') || '').trim();
  const timeoutStopUsec = String(fields.get('TimeoutStopUSec') || '').trim();
  if (
    !/^[a-z][a-z0-9-]{1,63}$/.test(loadState)
    || !/^[a-z][a-z0-9-]{1,63}$/.test(activeState)
    || !/^[a-z][a-z0-9-]{1,63}$/.test(subState)
  ) {
    throw identityMismatch('Terminal systemd scope state is malformed');
  }
  if (invocationId && !INVOCATION_ID_PATTERN.test(invocationId)) {
    throw identityMismatch('Terminal systemd invocation identity is malformed');
  }
  if (
    controlGroup
    && (
      !controlGroup.startsWith('/system.slice/')
      || path.posix.normalize(controlGroup) !== controlGroup
      || controlGroup.includes('\0')
    )
  ) {
    throw identityMismatch('Terminal systemd cgroup identity is malformed');
  }

  return Object.freeze({
    installed: loadState !== 'not-found',
    loadState,
    activeState,
    subState,
    description,
    invocationId,
    controlGroup,
    killMode,
    timeoutStopUsec,
    bindsTo: parseUnitSet(String(fields.get('BindsTo') || '')),
    after: parseUnitSet(String(fields.get('After') || '')),
  });
}

function parseCgroupEvents(raw: string | null): {
  absent: boolean;
  populated: 0 | 1;
} {
  if (raw === null) return { absent: true, populated: 0 };
  let populated: 0 | 1 | null = null;
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== 'populated') continue;
    if (
      populated !== null
      || fields.length !== 2
      || (fields[1] !== '0' && fields[1] !== '1')
    ) {
      throw identityMismatch('Terminal systemd cgroup state is malformed');
    }
    populated = fields[1] === '0' ? 0 : 1;
  }
  if (populated === null) {
    throw identityMismatch('Terminal systemd cgroup state is incomplete');
  }
  return { absent: false, populated };
}

function assertSnapshotMatchesReservationMetadata(
  snapshot: TerminalSystemdScopeSnapshot,
  reservation: TerminalSystemdScopeReservation,
): void {
  if (!snapshot.installed || snapshot.loadState !== 'loaded') {
    throw identityMismatch('Terminal systemd scope is not loaded');
  }
  if (snapshot.description !== reservation.description) {
    throw identityMismatch('Terminal systemd scope tag does not match');
  }
  if (
    snapshot.controlGroup !== null
    && snapshot.controlGroup !== reservation.controlGroup
  ) {
    throw identityMismatch('Terminal systemd cgroup identity does not match');
  }
  if (snapshot.killMode !== 'control-group') {
    throw identityMismatch('Terminal systemd scope termination mode does not match');
  }
  if (snapshot.timeoutStopUsec !== SCOPE_TIMEOUT_STOP_USEC) {
    throw identityMismatch('Terminal systemd scope stop timeout does not match');
  }
  if (
    snapshot.bindsTo.length !== 1
    || snapshot.bindsTo[0] !== PORTAL_SERVICE_UNIT
    || !snapshot.after.includes(PORTAL_SERVICE_UNIT)
  ) {
    throw identityMismatch('Terminal systemd parent-service binding does not match');
  }
}

function assertSnapshotMatchesReservation(
  snapshot: TerminalSystemdScopeSnapshot,
  reservation: TerminalSystemdScopeReservation,
): void {
  assertSnapshotMatchesReservationMetadata(snapshot, reservation);
  if (snapshot.controlGroup !== reservation.controlGroup) {
    throw identityMismatch('Terminal systemd cgroup identity is missing');
  }
  if (!snapshot.invocationId) {
    throw identityMismatch('Terminal systemd invocation identity is missing');
  }
}

function assertSnapshotMatchesIdentity(
  snapshot: TerminalSystemdScopeSnapshot,
  identity: TerminalSystemdScopeIdentity,
): void {
  assertSnapshotMatchesReservation(snapshot, identity);
  if (snapshot.invocationId !== identity.invocationId) {
    throw identityMismatch('Terminal systemd invocation identity does not match');
  }
}

function initializeTerminalScopeStorage(): string {
  const runtimeRoot = ensureRuntimeDirectory(
    TERMINAL_SCOPE_RUNTIME_ROOT,
    { mode: 0o700, enforceMode: true },
  );
  const stat = fs.lstatSync(runtimeRoot);
  if (
    stat.uid !== 0
    || (stat.mode & 0o777) !== 0o700
    || stat.isSymbolicLink()
    || !stat.isDirectory()
  ) {
    throw new Error('Terminal scope runtime root is not root-owned mode 0700');
  }
  return runtimeRoot;
}

function terminalGatePath(scopeUnit: string, scopeTag: string): string {
  const match = scopeUnit.match(TERMINAL_SCOPE_UNIT_PATTERN);
  assertScopeTag(scopeTag);
  if (!match) throw identityInvalid('Terminal activation gate identity is invalid');
  const socketPath = path.join(
    initializeTerminalScopeStorage(),
    `gate-${match[1]}.sock`,
  );
  if (Buffer.byteLength(socketPath, 'utf8') > UNIX_SOCKET_PATH_MAX_BYTES) {
    throw identityInvalid('Terminal activation socket path exceeds its bound');
  }
  return socketPath;
}

function removeTerminalGate(
  socketPath: string,
  scopeUnit: string,
  scopeTag: string,
): void {
  if (
    typeof socketPath !== 'string'
    || path.resolve(socketPath) !== socketPath
    || socketPath !== terminalGatePath(scopeUnit, scopeTag)
  ) {
    throw identityInvalid('Terminal activation socket path is not canonical');
  }
  try {
    const stat = fs.lstatSync(socketPath);
    if (
      stat.uid !== 0
      || stat.isSymbolicLink()
      || !stat.isSocket()
      || (stat.mode & 0o777) !== 0o600
    ) {
      throw new Error('Terminal activation socket identity drifted');
    }
    fs.unlinkSync(socketPath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function createTerminalActivationGate(
  scopeUnit: string,
  scopeTag: string,
): Promise<TerminalScopeActivationGate> {
  if (process.platform !== 'linux') {
    throw new Error('Privileged terminals require a Linux activation gate');
  }
  const socketPath = terminalGatePath(scopeUnit, scopeTag);
  if (fs.existsSync(socketPath)) {
    throw new Error('Terminal activation socket already exists');
  }

  let acceptedSocket: net.Socket | null = null;
  let handshakeSettled = false;
  let closed = false;
  let released = false;
  let encodedTargetEnvironment: string | null = null;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);

  const server = net.createServer((socket) => {
    if (acceptedSocket || closed) {
      socket.destroy();
      return;
    }
    acceptedSocket = socket;
    socket.setEncoding('utf8');
    let inbound = '';
    let authenticated = false;
    socket.on('data', (chunk: string) => {
      if (handshakeSettled || closed) return;
      inbound += chunk;
      if (!authenticated) {
        if (inbound.length > scopeTag.length + 1) {
          void abortWith(new Error('Terminal activation handshake exceeded its bound'));
          return;
        }
        const newline = inbound.indexOf('\n');
        if (newline < 0) return;
        if (newline !== inbound.length - 1) {
          void abortWith(new Error('Terminal activation handshake contained trailing data'));
          return;
        }
        const provided = Buffer.from(inbound.slice(0, newline), 'utf8');
        const expected = Buffer.from(scopeTag, 'utf8');
        if (
          provided.length !== expected.length
          || !crypto.timingSafeEqual(provided, expected)
        ) {
          void abortWith(new Error('Terminal activation identity mismatch'));
          return;
        }
        if (encodedTargetEnvironment === null) {
          void abortWith(new Error('Terminal target environment was not prepared'));
          return;
        }
        authenticated = true;
        inbound = '';
        socket.write(
          `E${Buffer.byteLength(encodedTargetEnvironment, 'ascii')}\n${encodedTargetEnvironment}`,
        );
        return;
      }
      if (inbound !== 'A') {
        if (inbound.length > 1 || !'A'.startsWith(inbound)) {
          void abortWith(new Error('Terminal target environment acknowledgement mismatch'));
        }
        return;
      }
      handshakeSettled = true;
      clearTimeout(handshakeTimer);
      server.close();
      resolveReady();
    });
    socket.once('error', (error) => {
      if (!released) void abortWith(error);
    });
    socket.once('close', () => {
      if (!released && !closed) {
        void abortWith(new Error('Terminal activation socket closed before release'));
      }
    });
  });

  const cleanup = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    removeTerminalGate(socketPath, scopeUnit, scopeTag);
  };

  const abortWith = async (error: Error): Promise<void> => {
    if (closed) return;
    closed = true;
    clearTimeout(handshakeTimer);
    acceptedSocket?.destroy();
    try {
      await cleanup();
    } finally {
      if (!handshakeSettled) {
        handshakeSettled = true;
        rejectReady(error);
      }
    }
  };

  const handshakeTimer = setTimeout(() => {
    void abortWith(new Error('Terminal activation handshake timed out'));
  }, ACTIVATION_HANDSHAKE_TIMEOUT_MS);
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
    server.on('error', (error) => {
      void abortWith(error);
    });
    fs.chmodSync(socketPath, 0o600);
    const stat = fs.lstatSync(socketPath);
    if (
      stat.uid !== 0
      || !stat.isSocket()
      || stat.isSymbolicLink()
      || (stat.mode & 0o777) !== 0o600
    ) {
      throw new Error('Terminal activation socket is not root-owned mode 0600');
    }
  } catch (error) {
    await abortWith(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  return Object.freeze({
    socketPath,
    ready,
    prepareTargetEnvironment(environment: NodeJS.ProcessEnv): void {
      if (closed || acceptedSocket || encodedTargetEnvironment !== null) {
        throw new Error('Terminal target environment can no longer be prepared');
      }
      if (!environment || typeof environment !== 'object') {
        throw new Error('Terminal target environment is invalid');
      }
      const normalized: Record<string, string> = Object.create(null);
      for (const [key, value] of Object.entries(environment)) {
        if (
          !key
          || key.includes('\0')
          || key.includes('=')
          || (
            value !== undefined
            && (typeof value !== 'string' || value.includes('\0'))
          )
        ) {
          throw new Error('Terminal target environment is invalid');
        }
        if (value !== undefined) normalized[key] = value;
      }
      const serialized = JSON.stringify(normalized);
      if (Buffer.byteLength(serialized, 'utf8') > TARGET_ENVIRONMENT_MAX_BYTES) {
        throw new Error('Terminal target environment exceeds its bound');
      }
      encodedTargetEnvironment = Buffer.from(serialized, 'utf8').toString('base64');
    },
    async release(): Promise<void> {
      await ready;
      if (closed || released || !acceptedSocket) {
        throw new Error('Terminal activation gate is unavailable');
      }
      released = true;
      closed = true;
      clearTimeout(handshakeTimer);
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = acceptedSocket as net.Socket;
          const onError = (error: Error) => reject(error);
          socket.once('error', onError);
          socket.end(Buffer.from([0x31]), () => {
            socket.off('error', onError);
            resolve();
          });
        });
      } finally {
        acceptedSocket.destroy();
        await cleanup();
      }
    },
    async abort(): Promise<void> {
      await abortWith(new Error('Terminal activation was aborted'));
    },
  });
}

function scavengeTerminalActivationSockets(): void {
  const runtimeRoot = initializeTerminalScopeStorage();
  for (const entry of fs.readdirSync(runtimeRoot)) {
    if (!/^gate-[0-9a-f]{32}\.sock$/.test(entry)) {
      throw new TerminalSystemdScopeError(
        'Terminal activation storage contains an unknown entry',
        'TERMINAL_SCOPE_RECOVERY_UNPROVEN',
        false,
      );
    }
    const socketPath = path.join(runtimeRoot, entry);
    const stat = fs.lstatSync(socketPath);
    if (
      stat.uid !== 0
      || stat.isSymbolicLink()
      || !stat.isSocket()
      || (stat.mode & 0o777) !== 0o600
    ) {
      throw new TerminalSystemdScopeError(
        'Terminal activation storage identity drifted',
        'TERMINAL_SCOPE_RECOVERY_UNPROVEN',
        false,
      );
    }
    fs.unlinkSync(socketPath);
  }
}

async function defaultSystemdRunVersion(): Promise<string> {
  try {
    const result = await execFileAsync(SYSTEMD_RUN, ['--version'], {
      encoding: 'utf8',
      timeout: SYSTEMD_ATTEST_TIMEOUT_MS,
      maxBuffer: SYSTEMD_OUTPUT_MAX_BYTES,
      windowsHide: true,
      env: SYSTEMD_BOOTSTRAP_ENV,
    });
    return String(result.stdout || '');
  } catch {
    throw new TerminalSystemdScopeError(
      'Terminal systemd-run version could not be read',
      'TERMINAL_SCOPE_ATTESTATION_UNPROVEN',
      true,
    );
  }
}

async function defaultSystemctl(args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync(SYSTEMCTL, [...args], {
      encoding: 'utf8',
      timeout: SYSTEMD_OPERATION_TIMEOUT_MS,
      maxBuffer: SYSTEMD_OUTPUT_MAX_BYTES,
      windowsHide: true,
      env: SYSTEMD_BOOTSTRAP_ENV,
    });
    return String(result.stdout || '');
  } catch {
    throw new TerminalSystemdScopeError(
      'Terminal systemd operation failed',
      'TERMINAL_SCOPE_ATTESTATION_UNPROVEN',
      false,
    );
  }
}

async function defaultListTerminalScopeUnits(): Promise<string> {
  return defaultSystemctl([
    'list-units',
    '--all',
    '--plain',
    '--no-legend',
    '--no-pager',
    'bridgesllm-terminal-*.scope',
  ]);
}

async function defaultReadCgroupEvents(controlGroup: string): Promise<string | null> {
  const expectedPrefix = '/system.slice/bridgesllm-terminal-';
  if (
    !controlGroup.startsWith(expectedPrefix)
    || path.posix.normalize(controlGroup) !== controlGroup
  ) {
    throw identityInvalid('Terminal systemd cgroup identity is invalid');
  }
  const resolved = path.resolve(
    SYSTEMD_CGROUP_ROOT,
    `.${controlGroup}`,
    'cgroup.events',
  );
  if (
    !resolved.startsWith(
      `${SYSTEMD_CGROUP_ROOT}${path.sep}system.slice${path.sep}`,
    )
  ) {
    throw identityInvalid('Terminal systemd cgroup path escaped its fixed hierarchy');
  }
  try {
    return await fs.promises.readFile(resolved, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw new TerminalSystemdScopeError(
      'Terminal systemd cgroup state could not be read',
      'TERMINAL_SCOPE_ATTESTATION_UNPROVEN',
      false,
    );
  }
}

async function defaultReadBootId(): Promise<string> {
  try {
    return String(await fs.promises.readFile(BOOT_ID_PATH, 'utf8')).trim();
  } catch {
    throw new TerminalSystemdScopeError(
      'Terminal host boot identity could not be read',
      'TERMINAL_SCOPE_ATTESTATION_UNPROVEN',
      false,
    );
  }
}

const defaultDependencies: TerminalSystemdScopeDependencies = {
  ptySpawn: (file, args, options) => spawnPty(file, args, options),
  systemdRunVersion: defaultSystemdRunVersion,
  systemctl: defaultSystemctl,
  listTerminalScopeUnits: defaultListTerminalScopeUnits,
  readCgroupEvents: defaultReadCgroupEvents,
  readBootId: defaultReadBootId,
  randomUUID: () => crypto.randomUUID(),
  randomBytes: (size) => crypto.randomBytes(size),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  createActivationGate: createTerminalActivationGate,
  initializeStorage: initializeTerminalScopeStorage,
  scavengeActivationSockets: scavengeTerminalActivationSockets,
};

export function createTerminalSystemdScopeBoundary(
  overrides: Partial<TerminalSystemdScopeDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const activeSessions = new Set<PreparedTerminalSystemdScope>();
  const activePreparations = new Set<Promise<PreparedTerminalSystemdScope>>();
  let startupPromise: Promise<{ recovered: number }> | null = null;
  let initialized = false;
  let shuttingDown = false;

  const readAttestedBootId = async (): Promise<string> => {
    const bootId = String(await dependencies.readBootId()).trim();
    assertBootId(bootId);
    return bootId;
  };

  const sameBoot = async (expectedBootId: string): Promise<boolean> => {
    assertBootId(expectedBootId);
    return await readAttestedBootId() === expectedBootId;
  };

  const inspect = async (
    scopeUnit: string,
  ): Promise<TerminalSystemdScopeSnapshot> => {
    assertScopeUnit(scopeUnit);
    let output: string;
    try {
      output = await dependencies.systemctl([
        'show',
        scopeUnit,
        '--property=LoadState',
        '--property=ActiveState',
        '--property=SubState',
        '--property=Description',
        '--property=InvocationID',
        '--property=ControlGroup',
        '--property=KillMode',
        '--property=TimeoutStopUSec',
        '--property=BindsTo',
        '--property=After',
        '--no-pager',
      ]);
    } catch (error) {
      if (error instanceof TerminalSystemdScopeError) throw error;
      throw new TerminalSystemdScopeError(
        'Terminal systemd scope state could not be read',
        'TERMINAL_SCOPE_ATTESTATION_UNPROVEN',
        false,
      );
    }
    return parseSystemctlShow(output);
  };

  const readCgroupState = async (
    controlGroup: string,
  ): Promise<{ absent: boolean; populated: 0 | 1 }> => {
    let raw: string | null;
    try {
      raw = await dependencies.readCgroupEvents(controlGroup);
    } catch (error) {
      if (error instanceof TerminalSystemdScopeError) throw error;
      throw new TerminalSystemdScopeError(
        'Terminal systemd cgroup state could not be read',
        'TERMINAL_SCOPE_ATTESTATION_UNPROVEN',
        false,
      );
    }
    return parseCgroupEvents(raw);
  };

  const waitForEmpty = async (
    identity: TerminalSystemdScopeIdentity,
  ): Promise<TerminalSystemdScopeSnapshot> => {
    const deadline = dependencies.now() + SYSTEMD_SETTLE_TIMEOUT_MS;
    let lastSnapshot: TerminalSystemdScopeSnapshot | null = null;
    while (true) {
      if (!(await sameBoot(identity.bootId))) {
        throw identityMismatch('Terminal host boot changed during scope settlement');
      }
      const snapshot = await inspect(identity.scopeUnit);
      lastSnapshot = snapshot;
      const cgroup = await readCgroupState(identity.controlGroup);
      if (!snapshot.installed) {
        if (cgroup.populated === 0) return snapshot;
      } else {
        assertSnapshotMatchesIdentity(snapshot, identity);
        if (
          (snapshot.activeState === 'inactive' || snapshot.activeState === 'failed')
          && cgroup.populated === 0
        ) {
          return snapshot;
        }
      }
      if (dependencies.now() >= deadline) break;
      await dependencies.wait(SYSTEMD_POLL_MS);
    }
    throw settlementUnproven(
      lastSnapshot?.installed
        ? 'Terminal systemd scope remained active after settlement'
        : 'Terminal systemd cgroup emptiness could not be proven',
    );
  };

  const stopIdentity = async (
    identity: TerminalSystemdScopeIdentity,
  ): Promise<TerminalSystemdScopeStopProof> => {
    assertIdentity(identity);
    if (!(await sameBoot(identity.bootId))) {
      return Object.freeze({
        scopeUnit: identity.scopeUnit,
        invocationId: identity.invocationId,
        bootId: identity.bootId,
        stopRequested: false,
        bootChanged: true,
        cgroupEmpty: true as const,
        finalLoadState: 'boot-changed',
        finalActiveState: 'inactive',
        finalSubState: 'dead',
      });
    }
    const before = await inspect(identity.scopeUnit);
    if (!before.installed) {
      const cgroup = await readCgroupState(identity.controlGroup);
      if (cgroup.populated !== 0) {
        throw settlementUnproven(
          'Terminal systemd scope is absent but its cgroup remains populated',
        );
      }
      return Object.freeze({
        scopeUnit: identity.scopeUnit,
        invocationId: identity.invocationId,
        bootId: identity.bootId,
        stopRequested: false,
        bootChanged: false,
        cgroupEmpty: true as const,
        finalLoadState: before.loadState,
        finalActiveState: before.activeState,
        finalSubState: before.subState,
      });
    }
    assertSnapshotMatchesIdentity(before, identity);
    try {
      await dependencies.systemctl(['stop', identity.scopeUnit]);
    } catch {
      // The exact recursive emptiness proof below is authoritative.
    }
    const finalSnapshot = await waitForEmpty(identity);
    return Object.freeze({
      scopeUnit: identity.scopeUnit,
      invocationId: identity.invocationId,
      bootId: identity.bootId,
      stopRequested: true,
      bootChanged: false,
      cgroupEmpty: true as const,
      finalLoadState: finalSnapshot.loadState,
      finalActiveState: finalSnapshot.activeState,
      finalSubState: finalSnapshot.subState,
    });
  };

  const reserve = async (): Promise<TerminalSystemdScopeReservation> => {
    const uuid = String(dependencies.randomUUID()).toLowerCase();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)
    ) {
      throw identityInvalid('Terminal systemd scope randomness is invalid');
    }
    const randomTag = dependencies.randomBytes(32);
    if (!Buffer.isBuffer(randomTag) || randomTag.length !== 32) {
      throw identityInvalid('Terminal systemd scope tag randomness is invalid');
    }
    const scopeUnit = `bridgesllm-terminal-${uuid.replace(/-/g, '')}.scope`;
    const scopeTag = randomTag.toString('hex');
    const reservation = Object.freeze({
      scopeUnit,
      scopeTag,
      description: descriptionForTag(scopeTag),
      controlGroup: controlGroupForUnit(scopeUnit),
      bootId: await readAttestedBootId(),
    });
    assertReservation(reservation);
    return reservation;
  };

  const settleFailedLauncher = async (
    reservation: TerminalSystemdScopeReservation,
    pty: IPty,
    exited: () => boolean,
  ): Promise<void> => {
    const startedAt = dependencies.now();
    const termDeadline = startedAt + SYSTEMD_LAUNCHER_TERM_GRACE_MS;
    const settleDeadline = startedAt + SYSTEMD_LAUNCHER_SETTLE_TIMEOUT_MS;
    let sigtermSent = false;
    let sigkillSent = false;
    while (!exited()) {
      const now = dependencies.now();
      if (!sigtermSent) {
        sigtermSent = true;
        try {
          pty.kill('SIGTERM');
        } catch {}
      } else if (!sigkillSent && now >= termDeadline) {
        sigkillSent = true;
        try {
          pty.kill('SIGKILL');
        } catch {}
      }
      if (now >= settleDeadline) {
        throw settlementUnproven(
          'Terminal systemd-run launcher settlement could not be proven',
        );
      }
      await dependencies.wait(SYSTEMD_POLL_MS);
    }
    const adoptionDeadline = dependencies.now() + SYSTEMD_SETTLE_TIMEOUT_MS;
    while (true) {
      if (!(await sameBoot(reservation.bootId))) return;
      const snapshot = await inspect(reservation.scopeUnit);
      if (!snapshot.installed) {
        const cgroup = await readCgroupState(reservation.controlGroup);
        if (cgroup.populated === 0) return;
      } else {
        // systemd may publish the exact transient unit metadata briefly before
        // it attaches the process and assigns ControlGroup/InvocationID. Never
        // signal that incomplete identity; wait until it either disappears or
        // becomes a complete exact authority that can be stopped safely.
        assertSnapshotMatchesReservationMetadata(snapshot, reservation);
        if (
          snapshot.controlGroup === reservation.controlGroup
          && snapshot.invocationId
        ) {
          await stopIdentity({
            ...reservation,
            invocationId: snapshot.invocationId,
          });
          return;
        }
      }
      if (dependencies.now() >= adoptionDeadline) {
        throw settlementUnproven(
          'Terminal scope launch cleanup identity did not converge',
        );
      }
      await dependencies.wait(SYSTEMD_POLL_MS);
    }
  };

  const prepareInternal = async (
    input: PrepareTerminalSystemdScopeInput,
  ): Promise<PreparedTerminalSystemdScope> => {
    validatePrepareInput(input);
    if (!initialized || shuttingDown) {
      throw new TerminalSystemdScopeError(
        'Terminal systemd scope runtime is unavailable',
        'TERMINAL_SCOPE_RUNTIME_UNAVAILABLE',
        true,
      );
    }

    const reservation = await reserve();
    let gate: TerminalScopeActivationGate | null = null;
    let pty: IPty | null = null;
    let ptyExited = false;
    let exitSubscription: { dispose(): void } | null = null;
    let identity: TerminalSystemdScopeIdentity | null = null;
    try {
      gate = await dependencies.createActivationGate(
        reservation.scopeUnit,
        reservation.scopeTag,
      );
      gate.prepareTargetEnvironment(input.env);
      let versionOutput: string;
      try {
        versionOutput = await dependencies.systemdRunVersion();
      } catch (error) {
        if (error instanceof TerminalSystemdScopeError) throw error;
        throw new TerminalSystemdScopeError(
          'Terminal systemd-run version could not be read',
          'TERMINAL_SCOPE_ATTESTATION_UNPROVEN',
          true,
        );
      }
      const systemdVersion = parseSystemdRunVersion(versionOutput);
      const systemdRunArgs = [
        '--system',
        '--scope',
        '--quiet',
        '--collect',
        '--no-ask-password',
        ...(systemdVersion >= SYSTEMD_RUN_NO_EXPAND_MIN_VERSION
          ? ['--expand-environment=no']
          : []),
        `--unit=${reservation.scopeUnit}`,
        `--description=${reservation.description}`,
        '--property=KillMode=control-group',
        `--property=TimeoutStopSec=${SCOPE_TIMEOUT_STOP_USEC}`,
        `--property=BindsTo=${PORTAL_SERVICE_UNIT}`,
        `--property=After=${PORTAL_SERVICE_UNIT}`,
        '--',
        process.execPath,
        '-e',
        TERMINAL_ACTIVATION_WRAPPER_SOURCE,
        '--',
        gate.socketPath,
        reservation.scopeTag,
        input.command,
        ...input.args,
      ];
      pty = dependencies.ptySpawn(SYSTEMD_RUN, systemdRunArgs, {
        name: input.terminalName || 'xterm-256color',
        cols: input.cols,
        rows: input.rows,
        cwd: input.cwd,
        env: SYSTEMD_BOOTSTRAP_ENV,
      });
      exitSubscription = pty.onExit(() => {
        ptyExited = true;
      });

      let gateReady = false;
      let gateError: unknown = null;
      void gate.ready.then(
        () => { gateReady = true; },
        (error) => { gateError = error; },
      );
      const deadline = dependencies.now() + SYSTEMD_ATTEST_TIMEOUT_MS;
      while (true) {
        if (ptyExited) {
          throw new TerminalSystemdScopeError(
            'Terminal systemd scope exited before identity attestation',
            'TERMINAL_SCOPE_LAUNCH_FAILED',
            false,
          );
        }
        if (gateError) {
          throw new TerminalSystemdScopeError(
            'Terminal activation gate failed before identity attestation',
            'TERMINAL_SCOPE_LAUNCH_FAILED',
            false,
          );
        }
        if (!(await sameBoot(reservation.bootId))) {
          throw identityMismatch(
            'Terminal host boot changed before scope attestation',
          );
        }
        const snapshot = await inspect(reservation.scopeUnit);
        if (snapshot.installed) {
          assertSnapshotMatchesReservationMetadata(snapshot, reservation);
          if (
            snapshot.activeState === 'active'
            && snapshot.subState === 'running'
            && snapshot.controlGroup === reservation.controlGroup
            && snapshot.invocationId
            && gateReady
          ) {
            identity = Object.freeze({
              ...reservation,
              invocationId: snapshot.invocationId,
            });
            break;
          }
          if (
            (snapshot.activeState === 'inactive' || snapshot.activeState === 'failed')
            && snapshot.controlGroup === reservation.controlGroup
            && snapshot.invocationId
          ) {
            throw new TerminalSystemdScopeError(
              'Terminal systemd scope failed before identity attestation',
              'TERMINAL_SCOPE_LAUNCH_FAILED',
              false,
            );
          }
        }
        if (dependencies.now() >= deadline) {
          throw new TerminalSystemdScopeError(
            'Terminal systemd scope identity could not be attested',
            'TERMINAL_SCOPE_ATTESTATION_UNPROVEN',
            false,
          );
        }
        await dependencies.wait(SYSTEMD_POLL_MS);
      }

      let activated = false;
      let stopped = false;
      let stopPromise: Promise<TerminalSystemdScopeStopProof> | null = null;
      let session!: PreparedTerminalSystemdScope;
      const stop = (): Promise<TerminalSystemdScopeStopProof> => {
        if (stopPromise) return stopPromise;
        stopped = true;
        stopPromise = (async () => {
          if (!activated) {
            try {
              await gate!.abort();
            } catch {
              // Exact scope settlement below remains authoritative.
            }
          }
          const proof = await stopIdentity(identity!);
          exitSubscription?.dispose();
          activeSessions.delete(session);
          return proof;
        })();
        return stopPromise;
      };
      session = Object.freeze({
        pty,
        identity,
        async activate(): Promise<void> {
          if (stopped || activated) {
            throw new TerminalSystemdScopeError(
              'Terminal activation is no longer available',
              'TERMINAL_SCOPE_LAUNCH_FAILED',
              Boolean(stopped),
            );
          }
          try {
            await gate!.release();
            activated = true;
          } catch {
            try {
              await stop();
            } catch {
              throw settlementUnproven(
                'Terminal activation failed and scope settlement was unproven',
              );
            }
            throw new TerminalSystemdScopeError(
              'Terminal activation failed',
              'TERMINAL_SCOPE_LAUNCH_FAILED',
              true,
            );
          }
        },
        stop,
      });
      activeSessions.add(session);
      exitSubscription.dispose();
      exitSubscription = pty.onExit(() => {
        ptyExited = true;
        void stop().catch(() => undefined);
      });
      if (ptyExited) {
        await stop();
        throw new TerminalSystemdScopeError(
          'Terminal systemd scope exited during handoff',
          'TERMINAL_SCOPE_LAUNCH_FAILED',
          true,
        );
      }
      return session;
    } catch (error) {
      try {
        await gate?.abort();
      } catch {}
      if (identity) {
        try {
          await stopIdentity(identity);
        } catch {
          throw settlementUnproven(
            'Terminal scope launch failed and exact settlement was unproven',
          );
        }
      } else if (pty) {
        try {
          await settleFailedLauncher(reservation, pty, () => ptyExited);
        } catch {
          throw settlementUnproven(
            'Terminal scope launcher failed and exact settlement was unproven',
          );
        }
      }
      if (error instanceof TerminalSystemdScopeError) {
        if (error.settlementProven) throw error;
        throw new TerminalSystemdScopeError(
          error.message,
          error.code,
          true,
        );
      }
      throw new TerminalSystemdScopeError(
        'Terminal systemd scope could not be prepared',
        'TERMINAL_SCOPE_LAUNCH_FAILED',
        true,
      );
    } finally {
      if (!identity) exitSubscription?.dispose();
    }
  };

  const recover = async (): Promise<{ recovered: number }> => {
    dependencies.initializeStorage();
    let recovered = 0;
    for (let pass = 0; pass < 3; pass += 1) {
      let inventory: string;
      try {
        inventory = await dependencies.listTerminalScopeUnits();
      } catch {
        throw new TerminalSystemdScopeError(
          'Terminal scope recovery inventory could not be read',
          'TERMINAL_SCOPE_RECOVERY_UNPROVEN',
          false,
        );
      }
      const units = parseUnitList(inventory);
      if (units.length === 0) break;
      for (const scopeUnit of units) {
        const snapshot = await inspect(scopeUnit);
        if (!snapshot.installed) continue;
        const descriptionMatch = snapshot.description.match(
          /^BridgesLLM privileged terminal tag=([0-9a-f]{64})$/,
        );
        if (!descriptionMatch) {
          throw new TerminalSystemdScopeError(
            'A prefixed terminal scope did not match Portal ownership evidence',
            'TERMINAL_SCOPE_RECOVERY_UNPROVEN',
            false,
          );
        }
        const reservation: TerminalSystemdScopeReservation = {
          scopeUnit,
          scopeTag: descriptionMatch[1],
          description: snapshot.description,
          controlGroup: controlGroupForUnit(scopeUnit),
          bootId: await readAttestedBootId(),
        };
        assertSnapshotMatchesReservation(snapshot, reservation);
        await stopIdentity({
          ...reservation,
          invocationId: snapshot.invocationId!,
        });
        recovered += 1;
      }
      await dependencies.wait(SYSTEMD_POLL_MS);
      if (pass === 2) {
        const residual = parseUnitList(
          await dependencies.listTerminalScopeUnits(),
        );
        if (residual.length > 0) {
          throw new TerminalSystemdScopeError(
            'Terminal scope recovery did not converge',
            'TERMINAL_SCOPE_RECOVERY_UNPROVEN',
            false,
          );
        }
      }
    }

    dependencies.scavengeActivationSockets();
    return { recovered };
  };

  const initialize = async (): Promise<{ recovered: number }> => {
    if (shuttingDown) {
      throw new TerminalSystemdScopeError(
        'Terminal scope runtime is shutting down',
        'TERMINAL_SCOPE_RUNTIME_UNAVAILABLE',
        false,
      );
    }
    if (!startupPromise) {
      startupPromise = recover().then((result) => {
        initialized = true;
        return result;
      }).catch((error) => {
        startupPromise = null;
        throw error;
      });
    }
    return startupPromise;
  };

  const prepare = (
    input: PrepareTerminalSystemdScopeInput,
  ): Promise<PreparedTerminalSystemdScope> => {
    const operation = prepareInternal(input);
    activePreparations.add(operation);
    operation.then(
      () => activePreparations.delete(operation),
      () => activePreparations.delete(operation),
    );
    return operation;
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (startupPromise) await Promise.allSettled([startupPromise]);
    await Promise.allSettled([...activePreparations]);
    const results = await Promise.allSettled(
      [...activeSessions].map((session) => session.stop()),
    );
    if (results.some((result) => result.status === 'rejected')) {
      throw settlementUnproven(
        'One or more terminal systemd scopes did not settle during shutdown',
      );
    }
    activeSessions.clear();
    await recover();
  };

  return Object.freeze({
    initialize,
    prepare,
    shutdown,
    recover,
    inspect,
    sameBoot,
    stopIdentity,
    snapshot: () => ({
      initialized,
      shuttingDown,
      activeSessions: activeSessions.size,
      activePreparations: activePreparations.size,
    }),
    resetForTests(): void {
      activeSessions.clear();
      activePreparations.clear();
      startupPromise = null;
      initialized = false;
      shuttingDown = false;
    },
  });
}

const terminalSystemdScopeBoundary = createTerminalSystemdScopeBoundary();

export const initializeTerminalSystemdScopeRuntime = (
): Promise<{ recovered: number }> => terminalSystemdScopeBoundary.initialize();

export const prepareTerminalSystemdScope = (
  input: PrepareTerminalSystemdScopeInput,
): Promise<PreparedTerminalSystemdScope> => (
  terminalSystemdScopeBoundary.prepare(input)
);

export const stopTerminalSystemdScopeIdentity = (
  identity: TerminalSystemdScopeIdentity,
): Promise<TerminalSystemdScopeStopProof> => (
  terminalSystemdScopeBoundary.stopIdentity(identity)
);

export const shutdownTerminalSystemdScopeRuntime = (): Promise<void> => (
  terminalSystemdScopeBoundary.shutdown()
);

export const __terminalSystemdScopeBoundaryTest = Object.freeze({
  SYSTEMD_RUN,
  SYSTEMCTL,
  SYSTEMD_CGROUP_ROOT,
  BOOT_ID_PATH,
  TERMINAL_SCOPE_RUNTIME_ROOT,
  PORTAL_SERVICE_UNIT,
  TERMINAL_SCOPE_UNIT_PATTERN,
  TERMINAL_SCOPE_TAG_PATTERN,
  INVOCATION_ID_PATTERN,
  DESCRIPTION_PREFIX,
  SCOPE_TIMEOUT_STOP_USEC,
  MINIMUM_SUPPORTED_SYSTEMD_VERSION,
  SYSTEMD_RUN_NO_EXPAND_MIN_VERSION,
  SYSTEMD_BOOTSTRAP_ENV,
  TERMINAL_ACTIVATION_WRAPPER_SOURCE,
  descriptionForTag,
  controlGroupForUnit,
  parseSystemdRunVersion,
  parseUnitList,
  parseSystemctlShow,
  parseCgroupEvents,
});
