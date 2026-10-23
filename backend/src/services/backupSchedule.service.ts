import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BACKUP_STATE_DIR, expectedBackupOwnerIdentity, parseSystemctlProperties } from './backup.service';

/**
 * Owner-adjustable schedules for the installer's three backup timers. A change
 * is a durable systemd drop-in (OnCalendar only) plus the timer's own
 * enable/disable state, so Portal updates — which never rewrite the timers —
 * keep both. Input is structured fields; no calendar text is accepted.
 */

const execFileAsync = promisify(execFile);

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type Weekday = typeof WEEKDAYS[number];
export type ScheduledBackupType = 'daily' | 'comprehensive' | 'monthly';
export const SCHEDULE_DROP_IN = '60-bridgesllm-portal-schedule.conf';
const JOURNAL_SCHEMA = 'bridgesllm.backup-schedule-change.v1';

const TIMERS: Record<ScheduledBackupType, { timerUnit: string; serviceUnit: string; frequency: 'daily' | 'weekly' | 'monthly' }> = {
  daily: { timerUnit: 'bridgesllm-backup-daily.timer', serviceUnit: 'bridgesllm-backup@daily.service', frequency: 'daily' },
  comprehensive: { timerUnit: 'bridgesllm-backup-comprehensive.timer', serviceUnit: 'bridgesllm-backup@comprehensive.service', frequency: 'weekly' },
  monthly: { timerUnit: 'bridgesllm-backup-monthly.timer', serviceUnit: 'bridgesllm-backup@monthly.service', frequency: 'monthly' },
};
const SCHEDULED_TYPES = Object.keys(TIMERS) as ScheduledBackupType[];

export interface BackupScheduleHost {
  systemctl: string;
  unitDirectory: string;
  stampDirectory: string;
  journalPath: string;
  localtime: string;
}

export function defaultBackupScheduleHost(): BackupScheduleHost {
  return {
    systemctl: '/usr/bin/systemctl',
    unitDirectory: '/etc/systemd/system',
    stampDirectory: '/var/lib/systemd/timers',
    journalPath: path.join(BACKUP_STATE_DIR, 'schedule-change.json'),
    localtime: '/etc/localtime',
  };
}

export interface BackupScheduleInput {
  enabled: boolean;
  time: string;
  weekday?: Weekday;
  dayOfMonth?: number;
}

export interface BackupScheduleView {
  type: ScheduledBackupType;
  frequency: 'daily' | 'weekly' | 'monthly';
  source: 'systemd';
  timerUnit: string;
  serviceUnit: string;
  loaded: boolean;
  enabled: boolean;
  active: boolean;
  editable: boolean;
  onCalendar: string | null;
  time: string | null;
  weekday: Weekday | null;
  dayOfMonth: number | null;
  customCalendar: string | null;
  nextRun: string | null;
  nextRunAt: string | null;
}

export class BackupScheduleError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackupScheduleError';
  }
}

interface ScheduleJournal {
  schema: typeof JOURNAL_SCHEMA;
  unit: string;
  dropIn: string;
  previous: string | null;
  wasEnabled: boolean;
  wasActive: boolean;
}

const invalid = (message: string) => new BackupScheduleError(400, 'SCHEDULE_INVALID', message);

export function validateBackupScheduleInput(type: string, raw: unknown): { type: ScheduledBackupType; input: BackupScheduleInput } {
  if (!SCHEDULED_TYPES.includes(type as ScheduledBackupType)) throw invalid('Unknown backup schedule');
  const scheduled = type as ScheduledBackupType;
  const frequency = TIMERS[scheduled].frequency;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('Schedule must be an object');
  const value = raw as Record<string, unknown>;
  const allowed = ['enabled', 'time', ...(frequency === 'weekly' ? ['weekday'] : frequency === 'monthly' ? ['dayOfMonth'] : [])];
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || allowed.some((key) => !(key in value))) {
    throw invalid(`This schedule takes exactly: ${allowed.join(', ')}`);
  }
  if (typeof value.enabled !== 'boolean') throw invalid('Choose whether this schedule is on or paused');
  if (typeof value.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) {
    throw invalid('Time must be HH:MM in 24-hour form');
  }
  const input: BackupScheduleInput = { enabled: value.enabled, time: value.time };
  if (frequency === 'weekly') {
    if (!WEEKDAYS.includes(value.weekday as Weekday)) throw invalid('Choose a day of the week');
    input.weekday = value.weekday as Weekday;
  }
  if (frequency === 'monthly') {
    if (!Number.isInteger(value.dayOfMonth) || (value.dayOfMonth as number) < 1 || (value.dayOfMonth as number) > 28) {
      throw invalid('Day of the month must be 1 to 28 so it runs every month');
    }
    input.dayOfMonth = value.dayOfMonth as number;
  }
  return { type: scheduled, input };
}

/** systemd's normalized OnCalendar form for the structured schedule. */
export function backupScheduleCalendar(type: ScheduledBackupType, input: BackupScheduleInput): string {
  const at = `${input.time}:00`;
  if (TIMERS[type].frequency === 'weekly') return `${input.weekday} *-*-* ${at}`;
  if (TIMERS[type].frequency === 'monthly') return `*-*-${String(input.dayOfMonth).padStart(2, '0')} ${at}`;
  return `*-*-* ${at}`;
}

export function calendarExpressions(timersCalendar: string): string[] {
  return [...timersCalendar.matchAll(/OnCalendar=([^;}]*)/g)].map((match) => match[1].trim()).filter(Boolean);
}

export function parseBackupScheduleCalendar(type: ScheduledBackupType, timersCalendar: string): Pick<BackupScheduleView,
  'onCalendar' | 'time' | 'weekday' | 'dayOfMonth' | 'customCalendar'> {
  const expressions = calendarExpressions(timersCalendar);
  const none = { onCalendar: expressions[0] || null, time: null, weekday: null, dayOfMonth: null };
  if (expressions.length !== 1) return { ...none, customCalendar: expressions.join(', ') || null };
  const expression = expressions[0];
  const time = '([01]\\d|2[0-3]):([0-5]\\d):00';
  const frequency = TIMERS[type].frequency;
  const match = frequency === 'weekly'
    ? new RegExp(`^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \\*-\\*-\\* ${time}$`).exec(expression)
    : frequency === 'monthly'
      ? new RegExp(`^\\*-\\*-(0[1-9]|1\\d|2[0-8]) ${time}$`).exec(expression)
      : new RegExp(`^\\*-\\*-\\* ${time}$`).exec(expression);
  if (!match) return { ...none, customCalendar: expression };
  const [hour, minute] = match.slice(-2);
  return {
    onCalendar: expression,
    time: `${hour}:${minute}`,
    weekday: frequency === 'weekly' ? match[1] as Weekday : null,
    dayOfMonth: frequency === 'monthly' ? Number(match[1]) : null,
    customCalendar: null,
  };
}

export function renderBackupScheduleDropIn(calendar: string): string {
  return '# Managed by BridgesLLM Portal: Settings > Backups > Automatic backups.\n'
    + '[Timer]\nOnCalendar=\n'
    + `OnCalendar=${calendar}\n`;
}

async function systemctl(host: BackupScheduleHost, args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync(host.systemctl, args, { timeout, maxBuffer: 256 * 1024, encoding: 'utf8' });
  return stdout;
}

async function showTimer(host: BackupScheduleHost, unit: string): Promise<Record<string, string>> {
  return parseSystemctlProperties(await systemctl(host, [
    'show', unit, '--no-pager',
    '--property=LoadState', '--property=UnitFileState', '--property=ActiveState',
    '--property=TimersCalendar', '--property=DropInPaths', '--property=NextElapseUSecRealtime',
  ], 5_000));
}

async function nextElapses(host: BackupScheduleHost): Promise<Map<string, string>> {
  const next = new Map<string, string>();
  try {
    const rows = JSON.parse(await systemctl(host, [
      'list-timers', '--all', '--output=json', '--no-pager', ...SCHEDULED_TYPES.map((type) => TIMERS[type].timerUnit),
    ], 5_000));
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.unit === 'string' && Number.isSafeInteger(row.next) && row.next > 0) {
        next.set(row.unit, new Date(Math.floor(row.next / 1000)).toISOString());
      }
    }
  } catch {}
  return next;
}

export function readHostTimezone(localtime = '/etc/localtime'): string | null {
  try {
    const match = /(?:^|\/)zoneinfo\/((?:[A-Za-z0-9_+-]+\/){0,2}[A-Za-z0-9_+-]+)$/.exec(fs.readlinkSync(localtime));
    if (match) return match[1];
  } catch {}
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && /^[A-Za-z0-9_+/-]{1,64}$/.test(zone) ? zone : null;
}

function systemdText(value: string | undefined): string | null {
  const normalized = String(value || '').trim();
  return normalized && normalized !== 'n/a' ? normalized : null;
}

export async function readBackupScheduleSettings(host = defaultBackupScheduleHost()): Promise<{
  hostTimezone: string | null;
  schedules: BackupScheduleView[];
}> {
  const [rows, next] = await Promise.all([
    Promise.all(SCHEDULED_TYPES.map(async (type) => {
      try { return await showTimer(host, TIMERS[type].timerUnit); } catch { return {} as Record<string, string>; }
    })),
    nextElapses(host),
  ]);
  return {
    hostTimezone: readHostTimezone(host.localtime),
    schedules: SCHEDULED_TYPES.map((type, index) => {
      const properties = rows[index];
      const { timerUnit, serviceUnit, frequency } = TIMERS[type];
      const loaded = properties.LoadState === 'loaded';
      const active = properties.ActiveState === 'active';
      return {
        type,
        frequency,
        source: 'systemd' as const,
        timerUnit,
        serviceUnit,
        loaded,
        enabled: ['enabled', 'enabled-runtime', 'static'].includes(properties.UnitFileState),
        active,
        editable: loaded && ['enabled', 'disabled'].includes(properties.UnitFileState),
        ...parseBackupScheduleCalendar(type, properties.TimersCalendar || ''),
        nextRun: active ? systemdText(properties.NextElapseUSecRealtime) : null,
        nextRunAt: active ? next.get(timerUnit) || null : null,
      };
    }),
  };
}

function assertRootDirectory(directory: string): void {
  const expected = expectedBackupOwnerIdentity();
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expected.uid || (stat.mode & 0o022) !== 0) {
    throw new BackupScheduleError(409, 'SCHEDULE_UNMANAGED', 'The backup timer configuration directory is not safely owned');
  }
}

function readDropIn(dropIn: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dropIn);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedBackupOwnerIdentity().uid
    || (stat.mode & 0o022) !== 0 || stat.size > 4096) {
    throw new BackupScheduleError(409, 'SCHEDULE_UNMANAGED', 'The saved backup schedule file is not safely owned');
  }
  return fs.readFileSync(dropIn, 'utf8');
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function writePrivateAtomically(target: string, content: string, mode: number): void {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}`);
  try {
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0), mode);
    try {
      fs.fchmodSync(descriptor, mode);
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, target);
    fsyncDirectory(path.dirname(target));
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function writeDropIn(host: BackupScheduleHost, dropIn: string, content: string): void {
  assertRootDirectory(host.unitDirectory);
  const directory = path.dirname(dropIn);
  try {
    fs.mkdirSync(directory, { mode: 0o755 });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }
  assertRootDirectory(directory);
  readDropIn(dropIn);
  writePrivateAtomically(dropIn, content, 0o644);
}

function removeDropIn(dropIn: string): void {
  if (readDropIn(dropIn) === null) return;
  fs.unlinkSync(dropIn);
  fsyncDirectory(path.dirname(dropIn));
}

/**
 * Timers with Persistent=true fire at once when a missed run lies between the
 * last trigger and now. Restarting from a fresh stamp keeps a schedule save or
 * a resume from starting a backup by itself.
 */
function refreshTimerStamp(host: BackupScheduleHost, unit: string): void {
  const stamp = path.join(host.stampDirectory, `stamp-${unit}`);
  try {
    const stat = fs.lstatSync(stamp);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const now = new Date();
  fs.lutimesSync(stamp, now, now);
}

function writeJournal(host: BackupScheduleHost, journal: ScheduleJournal): void {
  writePrivateAtomically(host.journalPath, `${JSON.stringify(journal)}\n`, 0o600);
}

function readJournal(host: BackupScheduleHost): ScheduleJournal | null {
  let raw: string;
  try {
    const stat = fs.lstatSync(host.journalPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error('unsafe');
    raw = fs.readFileSync(host.journalPath, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw new BackupScheduleError(500, 'SCHEDULE_RECOVERY_REQUIRED', 'An interrupted schedule change needs attention');
  }
  let journal: ScheduleJournal | null = null;
  try { journal = JSON.parse(raw) as ScheduleJournal; } catch {}
  const type = SCHEDULED_TYPES.find((candidate) => TIMERS[candidate].timerUnit === journal?.unit);
  if (!journal || journal.schema !== JOURNAL_SCHEMA || !type
    || journal.dropIn !== path.join(host.unitDirectory, `${journal.unit}.d`, SCHEDULE_DROP_IN)
    || !(journal.previous === null || (typeof journal.previous === 'string' && journal.previous.length <= 4096))
    || typeof journal.wasEnabled !== 'boolean' || typeof journal.wasActive !== 'boolean') {
    throw new BackupScheduleError(500, 'SCHEDULE_RECOVERY_REQUIRED', 'An interrupted schedule change needs attention');
  }
  return journal;
}

async function restorePrevious(host: BackupScheduleHost, journal: ScheduleJournal): Promise<void> {
  if (journal.previous === null) removeDropIn(journal.dropIn);
  else writeDropIn(host, journal.dropIn, journal.previous);
  await systemctl(host, ['daemon-reload']);
  await systemctl(host, [journal.wasEnabled ? 'enable' : 'disable', journal.unit]);
  await systemctl(host, [journal.wasActive ? 'start' : 'stop', journal.unit]);
  fs.unlinkSync(host.journalPath);
}

let scheduleQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = scheduleQueue.then(work);
  scheduleQueue = run.catch(() => undefined);
  return run;
}

/** Undo a schedule change interrupted by a crash or restart. */
export function recoverInterruptedBackupScheduleChange(host = defaultBackupScheduleHost()): Promise<boolean> {
  return serialized(async () => {
    const journal = readJournal(host);
    if (!journal) return false;
    await restorePrevious(host, journal);
    return true;
  });
}

export async function updateBackupSchedule(
  type: string,
  raw: unknown,
  host = defaultBackupScheduleHost(),
): Promise<BackupScheduleView> {
  const validated = validateBackupScheduleInput(type, raw);
  return serialized(async () => {
    const pending = readJournal(host);
    if (pending) await restorePrevious(host, pending);
    const { timerUnit: unit } = TIMERS[validated.type];
    const calendar = backupScheduleCalendar(validated.type, validated.input);
    const before = await showTimer(host, unit);
    if (before.LoadState !== 'loaded') {
      throw new BackupScheduleError(409, 'SCHEDULE_UNAVAILABLE', 'This backup timer is not installed on the server.');
    }
    if (!['enabled', 'disabled'].includes(before.UnitFileState)) {
      throw new BackupScheduleError(409, 'SCHEDULE_UNMANAGED', 'This backup timer is managed outside Portal and was not changed.');
    }
    const dropIn = path.join(host.unitDirectory, `${unit}.d`, SCHEDULE_DROP_IN);
    const journal: ScheduleJournal = {
      schema: JOURNAL_SCHEMA,
      unit,
      dropIn,
      previous: readDropIn(dropIn),
      wasEnabled: before.UnitFileState === 'enabled',
      wasActive: before.ActiveState === 'active',
    };
    writeJournal(host, journal);
    try {
      // Stopped while systemd reloads, so the old trigger time is never
      // re-evaluated against the new calendar.
      await systemctl(host, ['stop', unit]);
      writeDropIn(host, dropIn, renderBackupScheduleDropIn(calendar));
      refreshTimerStamp(host, unit);
      await systemctl(host, ['daemon-reload']);
      const loaded = await showTimer(host, unit);
      const expressions = calendarExpressions(loaded.TimersCalendar || '');
      if (loaded.LoadState !== 'loaded' || expressions.length !== 1 || expressions[0] !== calendar
        || !String(loaded.DropInPaths || '').split(/\s+/).includes(dropIn)) {
        throw new Error('systemd did not load the requested calendar');
      }
      await systemctl(host, [validated.input.enabled ? 'enable' : 'disable', '--now', unit]);
      const after = await showTimer(host, unit);
      if (after.UnitFileState !== (validated.input.enabled ? 'enabled' : 'disabled')
        || after.ActiveState !== (validated.input.enabled ? 'active' : 'inactive')) {
        throw new Error('systemd did not apply the requested state');
      }
    } catch {
      try {
        await restorePrevious(host, journal);
      } catch {
        throw new BackupScheduleError(500, 'SCHEDULE_ROLLBACK_FAILED',
          'The schedule could not be changed or fully restored. Portal will finish restoring it when it restarts; '
          + 'check the automatic backup schedule before relying on it.');
      }
      throw new BackupScheduleError(502, 'SCHEDULE_APPLY_FAILED',
        'The server did not accept the new schedule, so the previous schedule was restored.');
    }
    fs.unlinkSync(host.journalPath);
    const settings = await readBackupScheduleSettings(host);
    return settings.schedules.find((schedule) => schedule.type === validated.type)!;
  });
}
