import {
  execFile,
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const SYSTEMD_RUN = '/usr/bin/systemd-run';
const SYSTEMCTL = '/usr/bin/systemctl';
const SYSTEMD_CGROUP_ROOT = '/sys/fs/cgroup';
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const SYSTEMD_OPERATION_TIMEOUT_MS = 45_000;
const SYSTEMD_ATTEST_TIMEOUT_MS = 10_000;
const SYSTEMD_SETTLE_TIMEOUT_MS = 30_000;
const SYSTEMD_POLL_MS = 100;
const SYSTEMD_LAUNCHER_TERM_GRACE_MS = 3_000;
const SYSTEMD_LAUNCHER_SETTLE_TIMEOUT_MS = 5_000;
const SYSTEMD_OUTPUT_MAX_BYTES = 1024 * 1024;
const SCOPE_UNIT_PATTERN = /^bridgesllm-host-agent-[0-9a-f]{32}\.scope$/;
const SCOPE_TAG_PATTERN = /^[0-9a-f]{64}$/;
const INVOCATION_ID_PATTERN = /^[0-9a-f]{32}$/;
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DESCRIPTION_PREFIX = 'BridgesLLM host agent run tag=';
const SCOPE_TIMEOUT_STOP_USEC = '5s';
const MINIMUM_SUPPORTED_SYSTEMD_VERSION = 249;
const SYSTEMD_RUN_NO_EXPAND_MIN_VERSION = 254;

const SYSTEMD_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
});

type BoundaryErrorCode =
  | 'HOST_RUN_SCOPE_IDENTITY_INVALID'
  | 'HOST_RUN_SCOPE_LAUNCH_FAILED'
  | 'HOST_RUN_SCOPE_ATTESTATION_UNPROVEN'
  | 'HOST_RUN_SCOPE_IDENTITY_MISMATCH'
  | 'HOST_RUN_SCOPE_SETTLEMENT_UNPROVEN';

export class SystemdHostRunBoundaryError extends Error {
  readonly statusCode = 503;
  readonly retryable = true;

  constructor(
    message: string,
    public readonly code: BoundaryErrorCode,
    public readonly quarantine: boolean,
  ) {
    super(message);
    this.name = 'SystemdHostRunBoundaryError';
  }
}

export interface SystemdHostRunScopeReservation {
  scopeUnit: string;
  scopeTag: string;
  description: string;
  controlGroup: string;
  bootId: string;
}

export interface SystemdHostRunScopeIdentity extends SystemdHostRunScopeReservation {
  invocationId: string;
}

export interface SystemdHostRunUnitSnapshot {
  installed: boolean;
  loadState: string;
  activeState: string;
  subState: string;
  description: string;
  invocationId: string | null;
  controlGroup: string | null;
  killMode: string;
  timeoutStopUsec: string;
}

export interface SystemdHostRunScopeLaunchInput {
  reservation: SystemdHostRunScopeReservation;
  wrapperCommand: string;
  wrapperArgs: readonly string[];
  cwd: string;
  stdin?: 'ignore' | 'pipe';
}

export interface LaunchedSystemdHostRunScope {
  child: ChildProcess;
  identity: SystemdHostRunScopeIdentity;
}

export interface SystemdHostRunStopProof {
  scopeUnit: string;
  invocationId: string;
  bootId: string;
  stopRequested: boolean;
  cgroupEmpty: true;
  finalLoadState: string;
  finalActiveState: string;
  finalSubState: string;
}

export type SystemdRunSpawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface SystemdHostRunBoundaryDependencies {
  spawn(file: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  systemdRunVersion(): Promise<string>;
  systemctl(args: readonly string[]): Promise<string>;
  readCgroupEvents(controlGroup: string): Promise<string | null>;
  readBootId(): Promise<string>;
  randomUUID(): string;
  randomBytes(size: number): Buffer;
  wait(ms: number): Promise<void>;
  now(): number;
}

function identityInvalid(message: string): SystemdHostRunBoundaryError {
  return new SystemdHostRunBoundaryError(
    message,
    'HOST_RUN_SCOPE_IDENTITY_INVALID',
    false,
  );
}

function identityMismatch(message: string): SystemdHostRunBoundaryError {
  return new SystemdHostRunBoundaryError(
    message,
    'HOST_RUN_SCOPE_IDENTITY_MISMATCH',
    true,
  );
}

function descriptionForTag(tag: string): string {
  return `${DESCRIPTION_PREFIX}${tag}`;
}

function controlGroupForUnit(unit: string): string {
  return `/system.slice/${unit}`;
}

function assertScopeUnit(unit: unknown): asserts unit is string {
  if (typeof unit !== 'string' || !SCOPE_UNIT_PATTERN.test(unit)) {
    throw identityInvalid('Host agent systemd scope unit is invalid');
  }
}

function assertScopeTag(tag: unknown): asserts tag is string {
  if (typeof tag !== 'string' || !SCOPE_TAG_PATTERN.test(tag)) {
    throw identityInvalid('Host agent systemd scope tag is invalid');
  }
}

function assertBootId(bootId: unknown): asserts bootId is string {
  if (typeof bootId !== 'string' || !BOOT_ID_PATTERN.test(bootId)) {
    throw identityInvalid('Host boot identity is invalid');
  }
}

function assertReservation(
  reservation: SystemdHostRunScopeReservation,
): void {
  if (!reservation || typeof reservation !== 'object') {
    throw identityInvalid('Host agent systemd scope reservation is invalid');
  }
  assertScopeUnit(reservation.scopeUnit);
  assertScopeTag(reservation.scopeTag);
  assertBootId(reservation.bootId);
  if (reservation.description !== descriptionForTag(reservation.scopeTag)) {
    throw identityInvalid('Host agent systemd scope description is invalid');
  }
  if (reservation.controlGroup !== controlGroupForUnit(reservation.scopeUnit)) {
    throw identityInvalid('Host agent systemd cgroup identity is invalid');
  }
}

function assertIdentity(identity: SystemdHostRunScopeIdentity): void {
  assertReservation(identity);
  if (
    typeof identity.invocationId !== 'string'
    || !INVOCATION_ID_PATTERN.test(identity.invocationId)
  ) {
    throw identityInvalid('Host agent systemd invocation identity is invalid');
  }
}

function validateLaunchInput(input: SystemdHostRunScopeLaunchInput): void {
  assertReservation(input.reservation);
  if (
    typeof input.wrapperCommand !== 'string'
    || !path.posix.isAbsolute(input.wrapperCommand)
    || path.posix.normalize(input.wrapperCommand) !== input.wrapperCommand
    || input.wrapperCommand.includes('\0')
  ) {
    throw identityInvalid('Host agent scope wrapper command is invalid');
  }
  if (
    !Array.isArray(input.wrapperArgs)
    || input.wrapperArgs.some((argument) => (
      typeof argument !== 'string' || argument.includes('\0')
    ))
  ) {
    throw identityInvalid('Host agent scope wrapper arguments are invalid');
  }
  if (
    typeof input.cwd !== 'string'
    || !path.posix.isAbsolute(input.cwd)
    || path.posix.normalize(input.cwd) !== input.cwd
    || input.cwd.includes('\0')
  ) {
    throw identityInvalid('Host agent scope working directory is invalid');
  }
  if (input.stdin !== undefined && input.stdin !== 'ignore' && input.stdin !== 'pipe') {
    throw identityInvalid('Host agent scope stdin transport is invalid');
  }
}

function parseSystemctlShow(output: string): SystemdHostRunUnitSnapshot {
  const expectedFields = new Set([
    'LoadState',
    'ActiveState',
    'SubState',
    'Description',
    'InvocationID',
    'ControlGroup',
    'KillMode',
    'TimeoutStopUSec',
  ]);
  const fields = new Map<string, string>();
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    if (!rawLine) continue;
    const delimiter = rawLine.indexOf('=');
    if (delimiter <= 0) {
      throw identityMismatch('Host agent systemd scope state is malformed');
    }
    const key = rawLine.slice(0, delimiter);
    if (!expectedFields.has(key) || fields.has(key)) {
      throw identityMismatch('Host agent systemd scope state is malformed');
    }
    fields.set(key, rawLine.slice(delimiter + 1));
  }
  if (fields.size !== expectedFields.size) {
    throw identityMismatch('Host agent systemd scope state is incomplete');
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
    || !killMode
    || !timeoutStopUsec
  ) {
    throw identityMismatch('Host agent systemd scope state is malformed');
  }
  if (invocationId && !INVOCATION_ID_PATTERN.test(invocationId)) {
    throw identityMismatch('Host agent systemd invocation identity is malformed');
  }
  if (
    controlGroup
    && (
      !controlGroup.startsWith('/system.slice/')
      || path.posix.normalize(controlGroup) !== controlGroup
      || controlGroup.includes('\0')
    )
  ) {
    throw identityMismatch('Host agent systemd cgroup identity is malformed');
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
  });
}

function parseCgroupEvents(raw: string | null): {
  absent: boolean;
  populated: 0 | 1 | null;
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
      throw identityMismatch('Host agent systemd cgroup state is malformed');
    }
    populated = fields[1] === '0' ? 0 : 1;
  }
  if (populated === null) {
    throw identityMismatch('Host agent systemd cgroup state is incomplete');
  }
  return { absent: false, populated };
}

function parseSystemdRunVersion(output: string): number {
  const firstLine = String(output || '').split(/\r?\n/, 1)[0];
  const match = /^systemd ([0-9]{1,4})(?:\s|$)/.exec(firstLine);
  if (!match) {
    throw new SystemdHostRunBoundaryError(
      'Host systemd-run version could not be attested',
      'HOST_RUN_SCOPE_ATTESTATION_UNPROVEN',
      true,
    );
  }
  const version = Number(match[1]);
  if (
    !Number.isSafeInteger(version)
    || version < MINIMUM_SUPPORTED_SYSTEMD_VERSION
  ) {
    throw new SystemdHostRunBoundaryError(
      'Host systemd-run version is unsupported',
      'HOST_RUN_SCOPE_ATTESTATION_UNPROVEN',
      true,
    );
  }
  return version;
}

function assertSnapshotMatchesReservationMetadata(
  snapshot: SystemdHostRunUnitSnapshot,
  reservation: SystemdHostRunScopeReservation,
): void {
  if (!snapshot.installed || snapshot.loadState !== 'loaded') {
    throw identityMismatch('Host agent systemd scope is not loaded');
  }
  if (snapshot.description !== reservation.description) {
    throw identityMismatch('Host agent systemd scope tag does not match');
  }
  if (
    snapshot.controlGroup !== null
    && snapshot.controlGroup !== reservation.controlGroup
  ) {
    throw identityMismatch('Host agent systemd cgroup identity does not match');
  }
  if (snapshot.killMode !== 'control-group') {
    throw identityMismatch('Host agent systemd scope termination mode does not match');
  }
  if (snapshot.timeoutStopUsec !== SCOPE_TIMEOUT_STOP_USEC) {
    throw identityMismatch('Host agent systemd scope stop timeout does not match');
  }
}

function assertSnapshotMatchesReservation(
  snapshot: SystemdHostRunUnitSnapshot,
  reservation: SystemdHostRunScopeReservation,
): void {
  assertSnapshotMatchesReservationMetadata(snapshot, reservation);
  if (snapshot.controlGroup !== reservation.controlGroup) {
    throw identityMismatch('Host agent systemd cgroup identity is missing');
  }
  if (!snapshot.invocationId) {
    throw identityMismatch('Host agent systemd invocation identity is missing');
  }
}

function assertSnapshotMatchesIdentity(
  snapshot: SystemdHostRunUnitSnapshot,
  identity: SystemdHostRunScopeIdentity,
): void {
  assertSnapshotMatchesReservation(snapshot, identity);
  if (snapshot.invocationId !== identity.invocationId) {
    throw identityMismatch('Host agent systemd invocation identity does not match');
  }
}

async function defaultSystemctl(args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync(SYSTEMCTL, [...args], {
      encoding: 'utf8',
      timeout: SYSTEMD_OPERATION_TIMEOUT_MS,
      maxBuffer: SYSTEMD_OUTPUT_MAX_BYTES,
      windowsHide: true,
      env: SYSTEMD_ENV,
    });
    return String(result.stdout || '');
  } catch {
    throw new SystemdHostRunBoundaryError(
      'Host agent systemd operation failed',
      'HOST_RUN_SCOPE_ATTESTATION_UNPROVEN',
      true,
    );
  }
}

async function defaultSystemdRunVersion(): Promise<string> {
  try {
    const result = await execFileAsync(SYSTEMD_RUN, ['--version'], {
      encoding: 'utf8',
      timeout: SYSTEMD_ATTEST_TIMEOUT_MS,
      maxBuffer: SYSTEMD_OUTPUT_MAX_BYTES,
      windowsHide: true,
      env: SYSTEMD_ENV,
    });
    return String(result.stdout || '');
  } catch {
    throw new SystemdHostRunBoundaryError(
      'Host systemd-run version could not be read',
      'HOST_RUN_SCOPE_ATTESTATION_UNPROVEN',
      true,
    );
  }
}

async function defaultReadCgroupEvents(controlGroup: string): Promise<string | null> {
  const expectedPrefix = '/system.slice/bridgesllm-host-agent-';
  if (
    !controlGroup.startsWith(expectedPrefix)
    || path.posix.normalize(controlGroup) !== controlGroup
  ) {
    throw identityInvalid('Host agent systemd cgroup identity is invalid');
  }
  const resolved = path.resolve(SYSTEMD_CGROUP_ROOT, `.${controlGroup}`, 'cgroup.events');
  if (!resolved.startsWith(`${SYSTEMD_CGROUP_ROOT}${path.sep}system.slice${path.sep}`)) {
    throw identityInvalid('Host agent systemd cgroup path escaped the fixed hierarchy');
  }
  try {
    return await fs.promises.readFile(resolved, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw new SystemdHostRunBoundaryError(
      'Host agent systemd cgroup state could not be read',
      'HOST_RUN_SCOPE_ATTESTATION_UNPROVEN',
      true,
    );
  }
}

async function defaultReadBootId(): Promise<string> {
  try {
    return String(await fs.promises.readFile(BOOT_ID_PATH, 'utf8')).trim();
  } catch {
    throw new SystemdHostRunBoundaryError(
      'Host boot identity could not be read',
      'HOST_RUN_SCOPE_ATTESTATION_UNPROVEN',
      true,
    );
  }
}

const defaultDependencies: SystemdHostRunBoundaryDependencies = {
  spawn: (file, args, options) => spawn(file, [...args], options),
  systemdRunVersion: defaultSystemdRunVersion,
  systemctl: defaultSystemctl,
  readCgroupEvents: defaultReadCgroupEvents,
  readBootId: defaultReadBootId,
  randomUUID: () => crypto.randomUUID(),
  randomBytes: (size) => crypto.randomBytes(size),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export function createSystemdHostRunBoundary(
  overrides: Partial<SystemdHostRunBoundaryDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  const readAttestedBootId = async (): Promise<string> => {
    const bootId = String(await dependencies.readBootId()).trim();
    assertBootId(bootId);
    return bootId;
  };

  const sameBoot = async (expectedBootId: string): Promise<boolean> => {
    assertBootId(expectedBootId);
    return await readAttestedBootId() === expectedBootId;
  };

  const assertSameBoot = async (expectedBootId: string): Promise<void> => {
    if (!(await sameBoot(expectedBootId))) {
      throw identityMismatch('Host boot identity changed before systemd scope control');
    }
  };

  const inspect = async (scopeUnit: string): Promise<SystemdHostRunUnitSnapshot> => {
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
        '--no-pager',
      ]);
    } catch (error) {
      if (error instanceof SystemdHostRunBoundaryError) throw error;
      throw new SystemdHostRunBoundaryError(
        'Host agent systemd scope state could not be read',
        'HOST_RUN_SCOPE_ATTESTATION_UNPROVEN',
        true,
      );
    }
    return parseSystemctlShow(output);
  };

  const readCgroupState = async (
    controlGroup: string,
  ): Promise<{ absent: boolean; populated: 0 | 1 | null }> => {
    let raw: string | null;
    try {
      raw = await dependencies.readCgroupEvents(controlGroup);
    } catch (error) {
      if (error instanceof SystemdHostRunBoundaryError) throw error;
      throw new SystemdHostRunBoundaryError(
        'Host agent systemd cgroup state could not be read',
        'HOST_RUN_SCOPE_ATTESTATION_UNPROVEN',
        true,
      );
    }
    return parseCgroupEvents(raw);
  };

  const waitForEmpty = async (
    identity: SystemdHostRunScopeIdentity,
  ): Promise<{
    snapshot: SystemdHostRunUnitSnapshot;
    cgroupEmpty: true;
  }> => {
    const deadline = dependencies.now() + SYSTEMD_SETTLE_TIMEOUT_MS;
    let lastSnapshot: SystemdHostRunUnitSnapshot | null = null;
    while (true) {
      await assertSameBoot(identity.bootId);
      const snapshot = await inspect(identity.scopeUnit);
      lastSnapshot = snapshot;
      const cgroup = await readCgroupState(identity.controlGroup);
      if (!snapshot.installed) {
        if (cgroup.populated === 0) {
          return { snapshot, cgroupEmpty: true };
        }
      } else {
        assertSnapshotMatchesIdentity(snapshot, identity);
        if (
          (snapshot.activeState === 'inactive' || snapshot.activeState === 'failed')
          && cgroup.populated === 0
        ) {
          return { snapshot, cgroupEmpty: true };
        }
      }
      if (dependencies.now() >= deadline) {
        break;
      }
      await dependencies.wait(SYSTEMD_POLL_MS);
    }
    throw new SystemdHostRunBoundaryError(
      lastSnapshot?.installed
        ? 'Host agent systemd scope remained active after settlement'
        : 'Host agent systemd cgroup emptiness could not be proven',
      'HOST_RUN_SCOPE_SETTLEMENT_UNPROVEN',
      true,
    );
  };

  const settleFailedLauncher = async (
    reservation: SystemdHostRunScopeReservation,
    child: ChildProcess,
    state: {
      failed(): boolean;
      exited(): boolean;
    },
  ): Promise<void> => {
    const launcherIsSettled = (): boolean => (
      state.exited()
      || child.exitCode !== null
      || child.signalCode !== null
      || (
        state.failed()
        && (!Number.isSafeInteger(child.pid) || Number(child.pid) < 1)
      )
    );
    const startedAt = dependencies.now();
    const termDeadline = startedAt + SYSTEMD_LAUNCHER_TERM_GRACE_MS;
    const settleDeadline = startedAt + SYSTEMD_LAUNCHER_SETTLE_TIMEOUT_MS;
    let sigtermSent = false;
    let sigkillSent = false;

    while (!launcherIsSettled()) {
      const now = dependencies.now();
      if (!sigtermSent) {
        sigtermSent = true;
        try {
          child.kill('SIGTERM');
        } catch {}
      } else if (!sigkillSent && now >= termDeadline) {
        sigkillSent = true;
        try {
          child.kill('SIGKILL');
        } catch {}
      }
      if (now >= settleDeadline) {
        throw new SystemdHostRunBoundaryError(
          'Host agent systemd-run launcher settlement could not be proven',
          'HOST_RUN_SCOPE_SETTLEMENT_UNPROVEN',
          true,
        );
      }
      await dependencies.wait(SYSTEMD_POLL_MS);
    }

    // systemd-run can fail after it submitted StartTransientUnit but before
    // Portal observed InvocationID. Once the launcher is settled, no late
    // submission from this process remains possible. Adopt only an exact
    // unit/tag/cgroup match, stop it, and prove recursive cgroup emptiness.
    const adoptionDeadline = dependencies.now() + SYSTEMD_SETTLE_TIMEOUT_MS;
    while (true) {
      if (!(await sameBoot(reservation.bootId))) return;
      const snapshot = await inspect(reservation.scopeUnit);
      if (!snapshot.installed) {
        const cgroup = await readCgroupState(reservation.controlGroup);
        if (cgroup.populated === 0) return;
      } else {
        // systemd can publish exact transient-unit metadata before cgroup and
        // InvocationID assignment. Never signal an incomplete identity. Wait
        // until it disappears or becomes a complete exact authority.
        assertSnapshotMatchesReservationMetadata(snapshot, reservation);
        if (
          snapshot.controlGroup === reservation.controlGroup
          && snapshot.invocationId
        ) {
          const identity: SystemdHostRunScopeIdentity = {
            ...reservation,
            invocationId: snapshot.invocationId,
          };
          try {
            await dependencies.systemctl(['stop', identity.scopeUnit]);
          } catch {
            // The exact recursive emptiness proof below is authoritative.
          }
          await waitForEmpty(identity);
          return;
        }
      }
      if (dependencies.now() >= adoptionDeadline) {
        throw new SystemdHostRunBoundaryError(
          'Host agent systemd scope cleanup identity did not converge',
          'HOST_RUN_SCOPE_SETTLEMENT_UNPROVEN',
          true,
        );
      }
      await dependencies.wait(SYSTEMD_POLL_MS);
    }
  };

  return Object.freeze({
    async reserve(): Promise<SystemdHostRunScopeReservation> {
      const uuid = String(dependencies.randomUUID()).toLowerCase();
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)
      ) {
        throw identityInvalid('Host agent systemd scope randomness is invalid');
      }
      const randomTag = dependencies.randomBytes(32);
      if (!Buffer.isBuffer(randomTag) || randomTag.length !== 32) {
        throw identityInvalid('Host agent systemd scope tag randomness is invalid');
      }
      const scopeUnit = `bridgesllm-host-agent-${uuid.replace(/-/g, '')}.scope`;
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
    },

    inspect,

    sameBoot,

    async launch(
      input: SystemdHostRunScopeLaunchInput,
    ): Promise<LaunchedSystemdHostRunScope> {
      validateLaunchInput(input);
      await assertSameBoot(input.reservation.bootId);
      let systemdVersionOutput: string;
      try {
        systemdVersionOutput = await dependencies.systemdRunVersion();
      } catch (error) {
        if (error instanceof SystemdHostRunBoundaryError) throw error;
        throw new SystemdHostRunBoundaryError(
          'Host systemd-run version could not be read',
          'HOST_RUN_SCOPE_ATTESTATION_UNPROVEN',
          true,
        );
      }
      const systemdRunVersion = parseSystemdRunVersion(systemdVersionOutput);
      // systemd 249-253 do not recognize --expand-environment, but scope mode
      // already execvpe()s the supplied argv without service-unit $/% parsing.
      // systemd 254+ supports an explicit no-expansion switch, which also
      // protects us if the upstream scope default changes. Do not rewrite '$'
      // to '$$' here: that escape belongs to unit-file ExecStart syntax and
      // would corrupt literal scope argv on the older supported releases.
      const systemdRunArgs = [
        '--system',
        '--scope',
        '--quiet',
        '--collect',
        '--no-ask-password',
        ...(systemdRunVersion >= SYSTEMD_RUN_NO_EXPAND_MIN_VERSION
          ? ['--expand-environment=no']
          : []),
        `--unit=${input.reservation.scopeUnit}`,
        `--description=${input.reservation.description}`,
        '--property=KillMode=control-group',
        `--property=TimeoutStopSec=${SCOPE_TIMEOUT_STOP_USEC}`,
        '--',
        input.wrapperCommand,
        ...input.wrapperArgs,
      ];

      let child: ChildProcess;
      try {
        child = dependencies.spawn(SYSTEMD_RUN, systemdRunArgs, {
          cwd: input.cwd,
          env: SYSTEMD_ENV,
          stdio: [input.stdin || 'ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        });
      } catch {
        throw new SystemdHostRunBoundaryError(
          'Host agent systemd scope could not be launched',
          'HOST_RUN_SCOPE_LAUNCH_FAILED',
          true,
        );
      }
      let childFailed = false;
      let childExited = child.exitCode !== null;
      const onError = () => { childFailed = true; };
      const onExit = () => { childExited = true; };
      child.once('error', onError);
      child.once('exit', onExit);
      try {
        if (!child.stdout || !child.stderr) {
          throw new SystemdHostRunBoundaryError(
            'Host agent systemd scope transport is unavailable',
            'HOST_RUN_SCOPE_LAUNCH_FAILED',
            true,
          );
        }
        const deadline = dependencies.now() + SYSTEMD_ATTEST_TIMEOUT_MS;
        while (true) {
          if (childFailed || childExited) {
            throw new SystemdHostRunBoundaryError(
              'Host agent systemd scope exited before identity attestation',
              'HOST_RUN_SCOPE_LAUNCH_FAILED',
              true,
            );
          }
          await assertSameBoot(input.reservation.bootId);
          const snapshot = await inspect(input.reservation.scopeUnit);
          if (snapshot.installed) {
            assertSnapshotMatchesReservationMetadata(
              snapshot,
              input.reservation,
            );
            if (
              snapshot.activeState === 'active'
              && snapshot.subState === 'running'
              && snapshot.controlGroup === input.reservation.controlGroup
              && snapshot.invocationId
            ) {
              return Object.freeze({
                child,
                identity: Object.freeze({
                  ...input.reservation,
                  invocationId: snapshot.invocationId,
                }),
              });
            }
            if (
              (snapshot.activeState === 'inactive' || snapshot.activeState === 'failed')
              && snapshot.controlGroup === input.reservation.controlGroup
              && snapshot.invocationId
            ) {
              throw new SystemdHostRunBoundaryError(
                'Host agent systemd scope failed before identity attestation',
                'HOST_RUN_SCOPE_LAUNCH_FAILED',
                true,
              );
            }
          }
          if (dependencies.now() >= deadline) {
            throw new SystemdHostRunBoundaryError(
              'Host agent systemd scope identity could not be attested',
              'HOST_RUN_SCOPE_ATTESTATION_UNPROVEN',
              true,
            );
          }
          await dependencies.wait(SYSTEMD_POLL_MS);
        }
      } catch (launchError) {
        try {
          await settleFailedLauncher(input.reservation, child, {
            failed: () => childFailed,
            exited: () => childExited,
          });
        } catch (cleanupError) {
          if (cleanupError instanceof SystemdHostRunBoundaryError) {
            throw cleanupError;
          }
          throw new SystemdHostRunBoundaryError(
            'Host agent systemd scope launch cleanup could not be proven',
            'HOST_RUN_SCOPE_SETTLEMENT_UNPROVEN',
            true,
          );
        }
        throw launchError;
      } finally {
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
      }
    },

    async proveEmpty(
      identity: SystemdHostRunScopeIdentity,
    ): Promise<SystemdHostRunStopProof> {
      assertIdentity(identity);
      await assertSameBoot(identity.bootId);
      const { snapshot } = await waitForEmpty(identity);
      return Object.freeze({
        scopeUnit: identity.scopeUnit,
        invocationId: identity.invocationId,
        bootId: identity.bootId,
        stopRequested: false,
        cgroupEmpty: true as const,
        finalLoadState: snapshot.loadState,
        finalActiveState: snapshot.activeState,
        finalSubState: snapshot.subState,
      });
    },

    async stop(
      identity: SystemdHostRunScopeIdentity,
    ): Promise<SystemdHostRunStopProof> {
      assertIdentity(identity);
      await assertSameBoot(identity.bootId);
      const before = await inspect(identity.scopeUnit);
      if (!before.installed) {
        const cgroup = await readCgroupState(identity.controlGroup);
        if (cgroup.populated !== 0) {
          throw new SystemdHostRunBoundaryError(
            'Host agent systemd scope is absent but its cgroup remains populated',
            'HOST_RUN_SCOPE_SETTLEMENT_UNPROVEN',
            true,
          );
        }
        return Object.freeze({
          scopeUnit: identity.scopeUnit,
          invocationId: identity.invocationId,
          bootId: identity.bootId,
          stopRequested: false,
          cgroupEmpty: true as const,
          finalLoadState: before.loadState,
          finalActiveState: before.activeState,
          finalSubState: before.subState,
        });
      }
      assertSnapshotMatchesIdentity(before, identity);

      let stopError: unknown = null;
      try {
        await dependencies.systemctl(['stop', identity.scopeUnit]);
      } catch (error) {
        stopError = error;
      }
      try {
        const { snapshot } = await waitForEmpty(identity);
        return Object.freeze({
          scopeUnit: identity.scopeUnit,
          invocationId: identity.invocationId,
          bootId: identity.bootId,
          stopRequested: true,
          cgroupEmpty: true as const,
          finalLoadState: snapshot.loadState,
          finalActiveState: snapshot.activeState,
          finalSubState: snapshot.subState,
        });
      } catch (error) {
        if (
          stopError
          && !(error instanceof SystemdHostRunBoundaryError)
        ) {
          throw new SystemdHostRunBoundaryError(
            'Host agent systemd scope stop could not be proven',
            'HOST_RUN_SCOPE_SETTLEMENT_UNPROVEN',
            true,
          );
        }
        throw error;
      }
    },
  });
}

export const systemdHostRunBoundary = createSystemdHostRunBoundary();

export const __systemdHostRunBoundaryTest = Object.freeze({
  SYSTEMD_RUN,
  SYSTEMCTL,
  SYSTEMD_CGROUP_ROOT,
  BOOT_ID_PATH,
  SCOPE_UNIT_PATTERN,
  SCOPE_TAG_PATTERN,
  INVOCATION_ID_PATTERN,
  DESCRIPTION_PREFIX,
  SCOPE_TIMEOUT_STOP_USEC,
  MINIMUM_SUPPORTED_SYSTEMD_VERSION,
  SYSTEMD_RUN_NO_EXPAND_MIN_VERSION,
  descriptionForTag,
  controlGroupForUnit,
  parseSystemdRunVersion,
  parseSystemctlShow,
  parseCgroupEvents,
});
