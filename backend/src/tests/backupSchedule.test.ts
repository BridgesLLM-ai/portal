import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  backupScheduleCalendar,
  BackupScheduleHost,
  readBackupScheduleSettings,
  recoverInterruptedBackupScheduleChange,
  SCHEDULE_DROP_IN,
  updateBackupSchedule,
} from '../services/backupSchedule.service';

jest.mock('../config/database', () => ({ prisma: {} }));

const TIMERS = {
  daily: ['bridgesllm-backup-daily.timer', '*-*-* 02:00:00'],
  comprehensive: ['bridgesllm-backup-comprehensive.timer', 'Sun *-*-* 03:00:00'],
  monthly: ['bridgesllm-backup-monthly.timer', '*-*-01 04:00:00'],
} as const;

// A systemctl double with systemd's relevant semantics: unit files and
// drop-ins take effect only on daemon-reload, `OnCalendar=` clears earlier
// values, and every call is journaled for ordering assertions.
const FAKE_SYSTEMCTL = String.raw`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const statePath = process.env.FAKE_SYSTEMD_STATE || path.join(__dirname, 'state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
const command = args[0];
const unit = args.filter((arg) => !arg.startsWith('-'))[1];
const stamp = (name) => { try { return fs.statSync(path.join(state.stampDirectory, 'stamp-' + name)).mtimeMs; } catch { return null; } };
state.calls.push({ args, stampMtimeMs: unit ? stamp(unit) : null });
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (state.fail[command] && state.fail[command] > 0) {
  state.fail[command] -= 1;
  save();
  process.stderr.write('Failed to ' + command + '\n');
  process.exit(1);
}
const loadCalendar = (name) => {
  const files = [path.join(state.unitDirectory, name)];
  const directory = path.join(state.unitDirectory, name + '.d');
  if (!state.ignoreDropIns && fs.existsSync(directory)) {
    for (const entry of fs.readdirSync(directory).filter((file) => file.endsWith('.conf')).sort()) files.push(path.join(directory, entry));
  }
  let calendars = [];
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = /^OnCalendar=(.*)$/.exec(line.trim());
      if (match) calendars = match[1] ? [...calendars, match[1]] : [];
    }
  }
  return { calendars, dropIns: files.slice(1) };
};
const timer = state.units[unit];
if (command === 'daemon-reload') {
  for (const name of Object.keys(state.units)) Object.assign(state.units[name], loadCalendar(name));
} else if (command === 'show') {
  const t = timer || { load: 'not-found' };
  const out = {
    LoadState: t.load || 'loaded',
    UnitFileState: t.enabled || '',
    ActiveState: t.active ? 'active' : 'inactive',
    TimersCalendar: (t.calendars || []).map((c) => '{ OnCalendar=' + c + ' ; next_elapse=Fri 2026-10-09 02:00:00 EDT }').join(' '),
    DropInPaths: (t.dropIns || []).join(' '),
    NextElapseUSecRealtime: t.active ? 'Fri 2026-10-09 02:00:00 EDT' : '',
  };
  process.stdout.write(Object.entries(out).map(([key, value]) => key + '=' + value).join('\n') + '\n');
} else if (command === 'list-timers') {
  const rows = Object.entries(state.units).filter(([, t]) => t.active)
    .map(([name]) => ({ next: 1791525600000000, left: 1, last: null, passed: null, unit: name, activates: name }));
  process.stdout.write(JSON.stringify(rows));
} else if (['start', 'stop', 'enable', 'disable'].includes(command)) {
  if (!timer) { process.stderr.write('Unit not found\n'); process.exit(5); }
  if (command === 'start') timer.active = true;
  if (command === 'stop') timer.active = false;
  if (command === 'enable') { timer.enabled = 'enabled'; if (args.includes('--now')) timer.active = true; }
  if (command === 'disable') { timer.enabled = 'disabled'; if (args.includes('--now')) timer.active = false; }
} else {
  process.stderr.write('unsupported\n');
  process.exit(2);
}
save();
`;

interface Fixture {
  root: string;
  host: BackupScheduleHost;
  statePath: string;
  state(): any;
  update(mutator: (state: any) => void): void;
  dropIn(unit: string): string;
}

const roots: string[] = [];

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join('/root', 'portal-schedule-test-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const unitDirectory = path.join(root, 'etc-systemd-system');
  const stampDirectory = path.join(root, 'timers');
  const stateDirectory = path.join(root, 'state');
  for (const directory of [unitDirectory, stampDirectory, stateDirectory]) fs.mkdirSync(directory, { mode: 0o755 });
  const units: Record<string, any> = {};
  for (const [name, calendar] of Object.values(TIMERS)) {
    fs.writeFileSync(path.join(unitDirectory, name), `[Timer]\nOnCalendar=${calendar}\nPersistent=true\n`, { mode: 0o644 });
    const stamp = path.join(stampDirectory, `stamp-${name}`);
    fs.writeFileSync(stamp, '');
    fs.utimesSync(stamp, new Date('2026-10-08T06:00:00Z'), new Date('2026-10-08T06:00:00Z'));
    units[name] = { load: 'loaded', enabled: 'enabled', active: true, calendars: [calendar], dropIns: [] };
  }
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ units, unitDirectory, stampDirectory, calls: [], fail: {}, ignoreDropIns: false }));
  const systemctl = path.join(root, 'systemctl');
  fs.writeFileSync(systemctl, FAKE_SYSTEMCTL, { mode: 0o755 });
  const localtime = path.join(root, 'localtime');
  fs.symlinkSync('/usr/share/zoneinfo/America/New_York', localtime);
  const host: BackupScheduleHost = {
    systemctl, unitDirectory, stampDirectory, localtime, journalPath: path.join(stateDirectory, 'schedule-change.json'),
  };
  return {
    root,
    host,
    statePath,
    state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    update(mutator) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      mutator(state);
      fs.writeFileSync(statePath, JSON.stringify(state));
    },
    dropIn: (unit) => path.join(unitDirectory, `${unit}.d`, SCHEDULE_DROP_IN),
  };
}

function verbs(state: any): string[] {
  return state.calls.map((call: any) => call.args.filter((arg: string) => !arg.startsWith('--property')).join(' '));
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe('backup schedule settings', () => {
  it('reads installed timers as structured schedules with the host time zone', async () => {
    const f = fixture();
    const settings = await readBackupScheduleSettings(f.host);
    expect(settings.hostTimezone).toBe('America/New_York');
    expect(settings.schedules.map((s) => [s.type, s.time, s.weekday, s.dayOfMonth, s.enabled, s.active, s.editable]))
      .toEqual([
        ['daily', '02:00', null, null, true, true, true],
        ['comprehensive', '03:00', 'Sun', null, true, true, true],
        ['monthly', '04:00', null, 1, true, true, true],
      ]);
    expect(settings.schedules[0].nextRunAt).toBe('2026-10-09T06:00:00.000Z');
    expect(fs.existsSync(f.host.journalPath)).toBe(false);
  });

  it('applies a new time through a durable drop-in without starting a backup', async () => {
    const f = fixture();
    const startedAt = Date.now();
    const schedule = await updateBackupSchedule('daily', { enabled: true, time: '03:30' }, f.host);
    const unit = TIMERS.daily[0];
    expect(fs.readFileSync(f.dropIn(unit), 'utf8')).toBe(
      '# Managed by BridgesLLM Portal: Settings > Backups > Automatic backups.\n[Timer]\nOnCalendar=\nOnCalendar=*-*-* 03:30:00\n',
    );
    expect(schedule).toMatchObject({ type: 'daily', time: '03:30', enabled: true, active: true });
    const state = f.state();
    const sequence = verbs(state).filter((verb) => !verb.startsWith('show') && !verb.startsWith('list-timers'));
    expect(sequence).toEqual([`stop ${unit}`, 'daemon-reload', `enable --now ${unit}`]);
    // The timer restarts from a fresh stamp, so Persistent= has no missed run to replay.
    const enable = state.calls.find((call: any) => call.args[0] === 'enable');
    expect(enable.stampMtimeMs).toBeGreaterThanOrEqual(startedAt - 1000);
    expect(JSON.stringify(state.calls)).not.toMatch(/bridgesllm-backup@/);
    expect(fs.existsSync(f.host.journalPath)).toBe(false);
  });

  it('pauses without losing the chosen day and time, and resumes with them', async () => {
    const f = fixture();
    const unit = TIMERS.comprehensive[0];
    const paused = await updateBackupSchedule('comprehensive', { enabled: false, time: '05:15', weekday: 'Wed' }, f.host);
    expect(paused).toMatchObject({ enabled: false, active: false, time: '05:15', weekday: 'Wed', nextRunAt: null });
    expect(f.state().units[unit]).toMatchObject({ enabled: 'disabled', active: false });
    // Updates never rewrite timer state; a later read still shows the pause and the custom time.
    const reread = (await readBackupScheduleSettings(f.host)).schedules.find((s) => s.type === 'comprehensive')!;
    expect(reread).toMatchObject({ enabled: false, active: false, time: '05:15', weekday: 'Wed' });
    const resumed = await updateBackupSchedule('comprehensive', { enabled: true, time: '05:15', weekday: 'Wed' }, f.host);
    expect(resumed).toMatchObject({ enabled: true, active: true, time: '05:15', weekday: 'Wed' });
    expect(fs.readFileSync(f.dropIn(unit), 'utf8')).toContain('OnCalendar=Wed *-*-* 05:15:00\n');
  });

  it.each([
    ['daemon-reload fails', (state: any) => { state.fail['daemon-reload'] = 1; }],
    ['systemd ignores the drop-in', (state: any) => { state.ignoreDropIns = true; }],
    ['enable fails', (state: any) => { state.fail.enable = 1; }],
  ])('restores the previous schedule when %s', async (_label, inject) => {
    const f = fixture();
    const unit = TIMERS.monthly[0];
    await updateBackupSchedule('monthly', { enabled: false, time: '06:45', dayOfMonth: 9 }, f.host);
    const before = fs.readFileSync(f.dropIn(unit), 'utf8');
    f.update(inject);
    await expect(updateBackupSchedule('monthly', { enabled: true, time: '01:00', dayOfMonth: 20 }, f.host))
      .rejects.toMatchObject({ code: 'SCHEDULE_APPLY_FAILED', status: 502 });
    expect(fs.readFileSync(f.dropIn(unit), 'utf8')).toBe(before);
    expect(f.state().units[unit]).toMatchObject({ enabled: 'disabled', active: false });
    expect(fs.existsSync(f.host.journalPath)).toBe(false);
  });

  it('rolls back when systemd does not load the drop-in even if the calendar happens to match', async () => {
    const f = fixture();
    const unit = TIMERS.monthly[0];
    f.update((state) => { state.ignoreDropIns = true; });
    // Same calendar as the installed unit: only the drop-in readback can tell
    // that the saved schedule would not survive a unit file rewrite.
    await expect(updateBackupSchedule('monthly', { enabled: true, time: '04:00', dayOfMonth: 1 }, f.host))
      .rejects.toMatchObject({ code: 'SCHEDULE_APPLY_FAILED' });
    expect(fs.existsSync(f.dropIn(unit))).toBe(false);
    expect(f.state().units[unit]).toMatchObject({ enabled: 'enabled', active: true });
  });

  it('removes a first drop-in again when the first change fails', async () => {
    const f = fixture();
    const unit = TIMERS.daily[0];
    f.update((state) => { state.fail['daemon-reload'] = 1; });
    await expect(updateBackupSchedule('daily', { enabled: true, time: '23:59' }, f.host))
      .rejects.toMatchObject({ code: 'SCHEDULE_APPLY_FAILED' });
    expect(fs.existsSync(f.dropIn(unit))).toBe(false);
    expect(f.state().units[unit]).toMatchObject({ enabled: 'enabled', active: true, calendars: ['*-*-* 02:00:00'] });
  });

  it('keeps a journal when even the undo fails and finishes the undo on recovery', async () => {
    const f = fixture();
    const unit = TIMERS.daily[0];
    f.update((state) => { state.fail['daemon-reload'] = 2; });
    await expect(updateBackupSchedule('daily', { enabled: false, time: '11:00' }, f.host))
      .rejects.toMatchObject({ code: 'SCHEDULE_ROLLBACK_FAILED' });
    expect(fs.existsSync(f.host.journalPath)).toBe(true);
    await expect(recoverInterruptedBackupScheduleChange(f.host)).resolves.toBe(true);
    expect(fs.existsSync(f.dropIn(unit))).toBe(false);
    expect(fs.existsSync(f.host.journalPath)).toBe(false);
    expect(f.state().units[unit]).toMatchObject({ enabled: 'enabled', active: true, calendars: ['*-*-* 02:00:00'] });
    await expect(recoverInterruptedBackupScheduleChange(f.host)).resolves.toBe(false);
  });

  it.each([
    ['weekly', { enabled: true, time: '02:00' }],
    ['daily', { enabled: true, time: '24:00' }],
    ['daily', { enabled: true, time: '2:00' }],
    ['daily', { enabled: true, time: '02:00; systemctl start x' }],
    ['daily', { enabled: 'yes', time: '02:00' }],
    ['daily', { enabled: true, time: '02:00', weekday: 'Mon' }],
    ['daily', { enabled: true, time: '02:00', onCalendar: 'minutely' }],
    ['comprehensive', { enabled: true, time: '02:00' }],
    ['comprehensive', { enabled: true, time: '02:00', weekday: 'Funday' }],
    ['monthly', { enabled: true, time: '02:00', dayOfMonth: 29 }],
    ['monthly', { enabled: true, time: '02:00', dayOfMonth: 1.5 }],
    ['monthly', { enabled: true, time: '02:00', dayOfMonth: '1' }],
    ['daily', ['02:00']],
  ])('rejects %s %j before touching systemd', async (type, body) => {
    const f = fixture();
    await expect(updateBackupSchedule(type, body, f.host)).rejects.toMatchObject({ code: 'SCHEDULE_INVALID', status: 400 });
    expect(f.state().calls).toEqual([]);
    expect(fs.readdirSync(f.host.unitDirectory).filter((name) => name.endsWith('.d'))).toEqual([]);
  });

  it('refuses timers that are missing or managed outside Portal', async () => {
    const f = fixture();
    f.update((state) => {
      state.units[TIMERS.daily[0]].load = 'not-found';
      state.units[TIMERS.monthly[0]].enabled = 'masked';
    });
    await expect(updateBackupSchedule('daily', { enabled: true, time: '01:00' }, f.host))
      .rejects.toMatchObject({ code: 'SCHEDULE_UNAVAILABLE' });
    await expect(updateBackupSchedule('monthly', { enabled: true, time: '01:00', dayOfMonth: 2 }, f.host))
      .rejects.toMatchObject({ code: 'SCHEDULE_UNMANAGED' });
    expect(fs.readdirSync(f.host.unitDirectory).filter((name) => name.endsWith('.d'))).toEqual([]);
  });

  it('generates exactly the calendar text real systemd normalizes to', () => {
    const analyze = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
    if (analyze.status !== 0) return;
    const samples = [
      backupScheduleCalendar('daily', { enabled: true, time: '00:05' }),
      backupScheduleCalendar('comprehensive', { enabled: true, time: '23:59', weekday: 'Thu' }),
      backupScheduleCalendar('monthly', { enabled: true, time: '07:30', dayOfMonth: 5 }),
    ];
    for (const expression of samples) {
      const result = spawnSync('systemd-analyze', ['calendar', '--iterations=1', expression], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Normalized form: ${expression}\n`);
    }
  });
});
