import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const PORTAL_SELF_UPDATE_STATE_ROOT =
  '/var/lib/bridgesllm-installer/dashboard-updates';
export const PORTAL_SELF_UPDATE_CURRENT = `${PORTAL_SELF_UPDATE_STATE_ROOT}/current`;
export const PORTAL_SELF_UPDATE_LOG_ROOT = '/opt/bridgesllm/logs';
export const PORTAL_SELF_UPDATE_UNIT = 'bridgesllm-portal-self-update.service';
export const PORTAL_SELF_UPDATE_PROGRESS_HELPER =
  '/var/lib/bridgesllm-installer/dashboard-update-progress.py';

const MAX_STATE_BYTES = 64 * 1024;
const MAX_LOG_TAIL_BYTES = 128 * 1024;
const MAX_INITIAL_LOG_BYTES = 16 * 1024;
const MAX_EVENTS = 12;
const SYSTEMCTL_TIMEOUT_MS = 2_000;
const START_GRACE_MS = 15_000;

export type PortalSelfUpdateProgressStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'recovering'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'
  | 'updated_with_errors'
  | 'recovery_required';

export type PortalSelfUpdateProgressEvent = {
  status: 'running' | 'recovering' | 'rolled_back' | 'updated_with_errors' | 'recovery_required';
  phase: string;
  percent: number;
  label: string;
  detail: string;
  at: string;
};

export type PortalSelfUpdateProgress = {
  schema: 1;
  operationId: string | null;
  previousVersion: string | null;
  expectedVersion: string | null;
  status: PortalSelfUpdateProgressStatus;
  phase: string;
  percent: number;
  label: string;
  detail: string;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  events: PortalSelfUpdateProgressEvent[];
  logAvailable: boolean;
  isCurrent: boolean;
  admissionBlocked: boolean;
};

type StoredProgress = PortalSelfUpdateProgress & {
  operationId: string;
  previousVersion: string;
  expectedVersion: string;
  status: Exclude<PortalSelfUpdateProgressStatus, 'idle'>;
  startedAt: string;
  updatedAt: string;
  logFile: string;
  pendingOutcome?: 'rolled_back' | 'updated_with_errors' | 'recovery_required' | null;
};

export type PortalSelfUpdateUnitActivity = 'active' | 'inactive' | 'unknown';
export type PortalSelfUpdateUnitIdentity = {
  activity: PortalSelfUpdateUnitActivity;
  operationId: string | null;
};
type ProgressReadDependencies = {
  stateRoot?: string;
  logRoot?: string;
  readUnitActivity?: () => Promise<PortalSelfUpdateUnitActivity>;
  hasTransactionJournal?: () => boolean;
  reconcileOrphan?: (operationId: string) => Promise<void>;
  resolveCurrentOperation?: () => Promise<string | null>;
  now?: () => Date;
};

type LogCreateDependencies = {
  logRoot?: string;
  trustedAncestor?: string;
  expectedUid?: number;
  nowMs?: number;
};

const OPERATION_ID = /^[a-f0-9]{32}$/;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const PHASE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const TERMINAL = new Set<PortalSelfUpdateProgressStatus>([
  'succeeded', 'failed', 'rolled_back', 'updated_with_errors', 'recovery_required',
]);
const STATUSES = new Set<PortalSelfUpdateProgressStatus>([
  'starting', 'running', 'recovering', ...TERMINAL,
]);
const EVENT_STATUSES = new Set<PortalSelfUpdateProgressEvent['status']>([
  'running', 'recovering', 'rolled_back', 'updated_with_errors', 'recovery_required',
]);

function idleProgress(): PortalSelfUpdateProgress {
  return {
    schema: 1,
    operationId: null,
    previousVersion: null,
    expectedVersion: null,
    status: 'idle',
    phase: 'idle',
    percent: 0,
    label: 'No update is running',
    detail: '',
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    events: [],
    logAvailable: false,
    isCurrent: false,
    admissionBlocked: false,
  };
}

function pathEntryExists(entryPath: string): boolean {
  try {
    fs.lstatSync(entryPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    // An unreadable or otherwise unprovable recovery authority is present for
    // safety purposes; never downgrade it to "no journal".
    return true;
  }
}

function safeText(value: unknown, limit: number, allowEmpty = true): value is string {
  return typeof value === 'string'
    && value.length <= limit
    && (allowEmpty || value.length > 0)
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function assertSecureDirectory(directory: string): void {
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0
    || (metadata.mode & 0o777) !== 0o700) {
    throw new Error('Portal self-update state directory failed its ownership contract');
  }
}

function assertSecureOwnedDirectory(directory: string, expectedUid: number): fs.Stats {
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== expectedUid
    || (metadata.mode & 0o022) !== 0) {
    throw new Error('Portal self-update log directory failed its ownership contract');
  }
  return metadata;
}

/**
 * Create the updater's outer log without following a privileged path first.
 * The directory descriptor pins the attested root, O_EXCL prevents timestamp
 * collisions from becoming appends, and O_NOFOLLOW protects the final leaf.
 */
export function createPortalSelfUpdateLog(
  initialContent: string,
  dependencies: LogCreateDependencies = {},
): string {
  const logRoot = path.resolve(dependencies.logRoot || PORTAL_SELF_UPDATE_LOG_ROOT);
  const trustedAncestor = path.resolve(dependencies.trustedAncestor || '/opt');
  const expectedUid = dependencies.expectedUid ?? 0;
  if (!logRoot.startsWith(`${trustedAncestor}${path.sep}`)
    || typeof initialContent !== 'string'
    || Buffer.byteLength(initialContent, 'utf8') < 1
    || Buffer.byteLength(initialContent, 'utf8') > MAX_INITIAL_LOG_BYTES
    || /\u0000/.test(initialContent)) {
    throw new Error('Portal self-update log request is invalid');
  }

  assertSecureOwnedDirectory(trustedAncestor, expectedUid);
  const relative = path.relative(trustedAncestor, logRoot).split(path.sep).filter(Boolean);
  let cursor = trustedAncestor;
  for (let index = 0; index < relative.length; index += 1) {
    cursor = path.join(cursor, relative[index]);
    try {
      assertSecureOwnedDirectory(cursor, expectedUid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || index !== relative.length - 1) throw error;
      fs.mkdirSync(cursor, { mode: 0o750 });
      assertSecureOwnedDirectory(cursor, expectedUid);
      const parentDescriptor = fs.openSync(path.dirname(cursor), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
      try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
    }
  }

  const directoryDescriptor = fs.openSync(
    logRoot,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const openedDirectory = fs.fstatSync(directoryDescriptor);
    const namedDirectory = assertSecureOwnedDirectory(logRoot, expectedUid);
    if (openedDirectory.dev !== namedDirectory.dev || openedDirectory.ino !== namedDirectory.ino) {
      throw new Error('Portal self-update log directory changed during admission');
    }
    const payload = Buffer.from(initialContent, 'utf8');
    const baseTime = dependencies.nowMs ?? Date.now();
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const timestamp = new Date(baseTime + attempt).toISOString().replace(/[:.]/g, '-');
      const basename = `self-update-${timestamp}.log`;
      const descriptorPath = `/proc/self/fd/${directoryDescriptor}/${basename}`;
      let fileDescriptor: number;
      try {
        fileDescriptor = fs.openSync(
          descriptorPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
        throw error;
      }
      let createdIdentity: { dev: number; ino: number } | null = null;
      try {
        fs.fchmodSync(fileDescriptor, 0o600);
        const opened = fs.fstatSync(fileDescriptor);
        createdIdentity = { dev: opened.dev, ino: opened.ino };
        if (!opened.isFile() || opened.uid !== expectedUid || opened.nlink !== 1
          || (opened.mode & 0o777) !== 0o600) {
          throw new Error('Portal self-update log file failed its ownership contract');
        }
        let offset = 0;
        while (offset < payload.length) {
          const written = fs.writeSync(fileDescriptor, payload, offset, payload.length - offset);
          if (written <= 0) throw new Error('Portal self-update log could not be written');
          offset += written;
        }
        fs.fsyncSync(fileDescriptor);
      } catch (error) {
        fs.closeSync(fileDescriptor);
        fileDescriptor = -1;
        if (createdIdentity) {
          try {
            const named = fs.lstatSync(descriptorPath);
            if (named.dev === createdIdentity.dev && named.ino === createdIdentity.ino) {
              fs.unlinkSync(descriptorPath);
              fs.fsyncSync(directoryDescriptor);
            }
          } catch {}
        }
        throw error;
      } finally {
        if (fileDescriptor >= 0) fs.closeSync(fileDescriptor);
      }
      fs.fsyncSync(directoryDescriptor);
      return path.join(logRoot, basename);
    }
    throw new Error('Portal self-update log name space is exhausted');
  } finally {
    fs.closeSync(directoryDescriptor);
  }
}

function readSecureFile(filePath: string, maxBytes: number, allowTail = false): string {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0
      || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
      || (!allowTail && metadata.size > maxBytes)) {
      throw new Error('Portal self-update state file failed its ownership contract');
    }
    const length = Math.min(metadata.size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length) fs.readSync(descriptor, buffer, 0, length, allowTail ? metadata.size - length : 0);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseEvent(value: unknown): PortalSelfUpdateProgressEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!EVENT_STATUSES.has(item.status as PortalSelfUpdateProgressEvent['status'])
    || !safeText(item.phase, 48, false) || !PHASE.test(item.phase)
    || !Number.isInteger(item.percent) || Number(item.percent) < 0 || Number(item.percent) > 99
    || !safeText(item.label, 160, false) || !safeText(item.detail, 800)
    || !timestamp(item.at)) return null;
  return item as PortalSelfUpdateProgressEvent;
}

export function parseStoredPortalSelfUpdateProgress(
  value: unknown,
  logRoot = PORTAL_SELF_UPDATE_LOG_ROOT,
): StoredProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const status = item.status as PortalSelfUpdateProgressStatus;
  const eventsInput = Array.isArray(item.events) ? item.events : null;
  const pending = item.pendingOutcome;
  if (item.schema !== 1 || !OPERATION_ID.test(String(item.operationId || ''))
    || !VERSION.test(String(item.previousVersion || ''))
    || !VERSION.test(String(item.expectedVersion || ''))
    || !STATUSES.has(status)
    || !safeText(item.phase, 48, false) || !PHASE.test(item.phase)
    || !Number.isInteger(item.percent) || Number(item.percent) < 0 || Number(item.percent) > 100
    || !safeText(item.label, 160, false) || !safeText(item.detail, 800)
    || !timestamp(item.startedAt) || !timestamp(item.updatedAt)
    || !(item.finishedAt === null || timestamp(item.finishedAt))
    || TERMINAL.has(status) !== Boolean(item.finishedAt)
    || !eventsInput || eventsInput.length > MAX_EVENTS
    || typeof item.logAvailable !== 'boolean'
    || !safeText(item.logFile, 512, false) || !path.isAbsolute(item.logFile)
    || !(pending === undefined || pending === null
      || ['rolled_back', 'updated_with_errors', 'recovery_required'].includes(String(pending)))) {
    return null;
  }
  const events = eventsInput.map(parseEvent);
  if (events.some((event) => event === null)) return null;
  const typedEvents = events as PortalSelfUpdateProgressEvent[];
  if (typedEvents.some((event, index) => index > 0 && event.percent < typedEvents[index - 1].percent)
    || (typedEvents.length > 0 && typedEvents[typedEvents.length - 1].percent > Number(item.percent))) {
    return null;
  }
  const root = path.resolve(logRoot);
  const logFile = path.resolve(item.logFile);
  if (path.dirname(logFile) !== root
    || !/^self-update-[0-9TZ-]+\.log$/.test(path.basename(logFile))) return null;
  return { ...item, events: typedEvents } as StoredProgress;
}

function readOperation(stateRoot: string, operationId: string, logRoot: string): StoredProgress | null {
  if (!OPERATION_ID.test(operationId)) throw new Error('invalid Portal self-update operation identifier');
  assertSecureDirectory(stateRoot);
  const statePath = path.join(stateRoot, `${operationId}.json`);
  try {
    const parsed = parseStoredPortalSelfUpdateProgress(
      JSON.parse(readSecureFile(statePath, MAX_STATE_BYTES)),
      logRoot,
    );
    if (!parsed || parsed.operationId !== operationId) {
      throw new Error('Portal self-update state is malformed');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

function currentOperationId(stateRoot: string): string | null {
  if (!fs.existsSync(stateRoot)) return null;
  assertSecureDirectory(stateRoot);
  try {
    const value = readSecureFile(path.join(stateRoot, 'current'), 128).trim();
    if (!OPERATION_ID.test(value)) throw new Error('Portal self-update current pointer is malformed');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

function secureStateRootIsEmpty(stateRoot: string): boolean {
  assertSecureDirectory(stateRoot);
  return fs.readdirSync(stateRoot).length === 0;
}

function publicProgress(state: StoredProgress, isCurrent: boolean): PortalSelfUpdateProgress {
  const { logFile: _logFile, pendingOutcome: _pending, ...progress } = state;
  return {
    ...progress,
    isCurrent,
    admissionBlocked: isCurrent && (
      ['starting', 'running', 'recovering'].includes(state.status)
      || ['updated_with_errors', 'recovery_required'].includes(state.status)
    ),
  };
}

function enforceTerminalJournalSafety(
  progress: PortalSelfUpdateProgress,
  hasJournal: boolean,
  now: Date,
): PortalSelfUpdateProgress {
  if (!hasJournal || progress.status === 'recovery_required') return progress;
  const inconsistentAt = now.toISOString();
  return {
    ...progress,
    status: 'recovery_required',
    phase: 'recovery-required',
    label: 'Update needs recovery attention',
    detail: 'A recovery journal still exists after the reported terminal result. Do not start another update.',
    updatedAt: inconsistentAt,
    finishedAt: inconsistentAt,
    admissionBlocked: true,
  };
}

export async function readPortalSelfUpdateUnitActivity(): Promise<PortalSelfUpdateUnitActivity> {
  return (await readPortalSelfUpdateUnitIdentity()).activity;
}

export async function readPortalSelfUpdateUnitIdentity(): Promise<PortalSelfUpdateUnitIdentity> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/systemctl', [
      'show', PORTAL_SELF_UPDATE_UNIT,
      '--property=LoadState', '--property=ActiveState', '--property=SubState', '--property=Job',
      '--property=Environment',
      '--no-pager',
    ], { timeout: SYSTEMCTL_TIMEOUT_MS, maxBuffer: 32 * 1024, windowsHide: true });
    return parsePortalSelfUpdateUnitIdentity(String(stdout || ''));
  } catch {
    return { activity: 'unknown', operationId: null };
  }
}

export function parsePortalSelfUpdateUnitActivity(text: string): PortalSelfUpdateUnitActivity {
  const properties = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) properties.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const loadState = properties.get('LoadState') || '';
  const activeState = properties.get('ActiveState') || '';
  const subState = properties.get('SubState') || '';
  const job = properties.get('Job');
  // A loaded/inactive transient unit may still have a queued start job after
  // systemd-run lost its reply. Only an empty, explicitly reported Job plus a
  // terminal substate proves that no main process or ExecStopPost can follow.
  const noJob = job === '';
  if (loadState === 'not-found' && noJob) return 'inactive';
  if (loadState === 'loaded' && noJob
    && ['inactive', 'failed'].includes(activeState)
    && ['dead', 'failed', 'exited'].includes(subState)) return 'inactive';
  if (loadState === 'loaded' && (job !== ''
    || ['active', 'activating', 'reloading', 'deactivating'].includes(activeState))) return 'active';
  return 'unknown';
}

export function parsePortalSelfUpdateUnitIdentity(text: string): PortalSelfUpdateUnitIdentity {
  const activity = parsePortalSelfUpdateUnitActivity(text);
  const environment = text.split(/\r?\n/)
    .find((line) => line.startsWith('Environment='))?.slice('Environment='.length) || '';
  const matches = [...environment.matchAll(
    /(?:^|\s)BRIDGESLLM_DASHBOARD_UPDATE_ID=([a-f0-9]{32})(?=\s|$)/g,
  )];
  return {
    activity,
    operationId: matches.length === 1 ? matches[0][1] : null,
  };
}

async function reconcilePortalSelfUpdateOrphan(operationId: string): Promise<void> {
  await execFileAsync('/usr/bin/python3', [
    PORTAL_SELF_UPDATE_PROGRESS_HELPER,
    'reconcile-orphan',
    '--operation-id', operationId,
  ], { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
}

async function resolveCurrentPortalSelfUpdateOperation(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/python3', [
      PORTAL_SELF_UPDATE_PROGRESS_HELPER,
      'current-operation',
    ], { timeout: 10_000, maxBuffer: 256, windowsHide: true });
    const output = String(stdout || '');
    if (!/^[a-f0-9]{32}\n$/.test(output)) {
      throw new Error('Portal self-update current operation output is malformed');
    }
    return output.trim();
  } catch (error) {
    if (Number((error as { code?: unknown })?.code) === 3) return null;
    throw error;
  }
}

export async function getPortalSelfUpdateProgress(
  requestedOperationId?: string,
  dependencies: ProgressReadDependencies = {},
): Promise<PortalSelfUpdateProgress> {
  if (requestedOperationId && !OPERATION_ID.test(requestedOperationId)) {
    throw new Error('invalid Portal self-update operation identifier');
  }
  const stateRoot = dependencies.stateRoot || PORTAL_SELF_UPDATE_STATE_ROOT;
  const logRoot = dependencies.logRoot || PORTAL_SELF_UPDATE_LOG_ROOT;
  if (!fs.existsSync(stateRoot)) return idleProgress();
  const resolveCurrent = dependencies.resolveCurrentOperation
    || resolveCurrentPortalSelfUpdateOperation;
  let currentId = currentOperationId(stateRoot);
  // A rejected first admission can leave only the securely created empty
  // state directory before the stable helper is bootstrapped. That exact
  // shape is idle; any entry requires the helper's locked reconciliation.
  if (!requestedOperationId && currentId === null && secureStateRootIsEmpty(stateRoot)) {
    return idleProgress();
  }
  if (!requestedOperationId) currentId = await resolveCurrent();
  const operationId = requestedOperationId || currentId;
  if (!operationId) return idleProgress();
  const state = readOperation(stateRoot, operationId, logRoot);
  if (!state) return idleProgress();
  if (requestedOperationId && state.status && !TERMINAL.has(state.status)
    && operationId !== currentId) {
    // A crash between record and pointer commits can leave an explicitly
    // pinned active receipt behind a stale terminal pointer. Ask the locked
    // stable helper to repair/prove current identity before classifying it.
    currentId = await resolveCurrent();
  }
  const progress = publicProgress(state, operationId === currentId);
  const hasJournalNow = () => dependencies.hasTransactionJournal
    ? dependencies.hasTransactionJournal()
    : pathEntryExists('/var/lib/bridgesllm-installer/active-update.json')
      || pathEntryExists('/var/lib/bridgesllm-installer/cutover-update.json');
  if (TERMINAL.has(progress.status)) {
    return enforceTerminalJournalSafety(
      progress,
      operationId === currentId && hasJournalNow(),
      (dependencies.now || (() => new Date()))(),
    );
  }

  const activity = await (dependencies.readUnitActivity || readPortalSelfUpdateUnitActivity)();
  if (activity !== 'inactive') return progress;
  const now = (dependencies.now || (() => new Date()))();
  const ageMs = now.getTime() - Date.parse(state.updatedAt);
  if (ageMs >= 0 && ageMs < START_GRACE_MS) return progress;
  // Historical receipts are immutable observations. Only the operation named
  // by the durable current pointer may be reconciled after a dead unit.
  if (operationId !== currentId) return progress;
  // Do not fabricate a terminal response in memory. A reboot, SIGKILL, or
  // failed ExecStopPost must converge the same durable receipt that admission
  // reads; otherwise the UI can say "retry" while every retry remains busy.
  // ExecStopPost can finish between our first state read and unit query. Read
  // once more before invoking the orphan command; a successful receipt is
  // deliberately not an accepted reconcile-orphan input.
  const beforeReconcile = readOperation(stateRoot, operationId, logRoot);
  if (beforeReconcile && TERMINAL.has(beforeReconcile.status)) {
    return enforceTerminalJournalSafety(publicProgress(beforeReconcile, true), hasJournalNow(), now);
  }
  try {
    await (dependencies.reconcileOrphan || reconcilePortalSelfUpdateOrphan)(operationId);
  } catch (error) {
    const racedTerminal = readOperation(stateRoot, operationId, logRoot);
    if (racedTerminal && TERMINAL.has(racedTerminal.status)) {
      return enforceTerminalJournalSafety(publicProgress(racedTerminal, true), hasJournalNow(), now);
    }
    throw error;
  }
  const reconciled = readOperation(stateRoot, operationId, logRoot);
  if (!reconciled || !TERMINAL.has(reconciled.status)) {
    throw new Error('Portal self-update orphan reconciliation did not produce a terminal receipt');
  }
  const durableProgress = publicProgress(reconciled, true);
  return enforceTerminalJournalSafety(durableProgress, hasJournalNow(), now);
}

export function getPortalSelfUpdateLog(
  operationId: string,
  dependencies: Pick<ProgressReadDependencies, 'stateRoot' | 'logRoot'> = {},
): { operationId: string; content: string } {
  const stateRoot = dependencies.stateRoot || PORTAL_SELF_UPDATE_STATE_ROOT;
  const logRoot = dependencies.logRoot || PORTAL_SELF_UPDATE_LOG_ROOT;
  if (!fs.existsSync(stateRoot)) throw new Error('Portal self-update operation was not found');
  const state = readOperation(stateRoot, operationId, logRoot);
  if (!state) throw new Error('Portal self-update operation was not found');
  const raw = readSecureFile(state.logFile, MAX_LOG_TAIL_BYTES, true);
  return {
    operationId,
    content: raw
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .split(/\r?\n/).slice(-200).join('\n'),
  };
}
