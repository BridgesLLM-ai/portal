import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, Clock, HardDrive, Loader2, Trash2 } from 'lucide-react';
import client from '../../api/client';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const WEEKDAY_LABELS: Record<string, string> = {
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
};
const SCHEDULE_LABELS: Record<string, string> = {
  daily: 'Daily backup',
  comprehensive: 'Weekly comprehensive backup',
  monthly: 'Monthly backup',
};
const KEEP_LABELS: Array<[keyof KeepLimits, string]> = [
  ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['comprehensive', 'Comprehensive'],
];

export interface BackupScheduleView {
  type: 'daily' | 'comprehensive' | 'monthly';
  frequency: 'daily' | 'weekly' | 'monthly';
  loaded: boolean;
  enabled: boolean;
  active: boolean;
  editable?: boolean;
  onCalendar: string | null;
  time?: string | null;
  weekday?: string | null;
  dayOfMonth?: number | null;
  customCalendar?: string | null;
  nextRun: string | null;
  nextRunAt?: string | null;
}

interface KeepLimits { daily: number; weekly: number; monthly: number; comprehensive: number }
interface BackupPolicy { keep: KeepLimits; autoCleanup: boolean; reserveGiB: number }
interface PolicyReport {
  policy: BackupPolicy | null;
  source: 'default' | 'saved' | 'invalid';
  defaults: BackupPolicy;
  limits: { keep: [number, number]; reserveGiB: [number, number] };
  storage: { freeBytes: number; totalBytes: number } | null;
}
interface CleanupPreview {
  token: string;
  archives: Array<{ name: string; type: string; sizeBytes: number; created: string }>;
  count: number;
  totalBytes: number;
  protected: { newest: number; locked: number; pinned: number };
  unverified: number;
}

type Claim = (owner: string) => boolean;
type Release = (owner: string) => void;
type Notice = { type: 'success' | 'error'; message: string } | null;

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function errorMessage(error: any, fallback: string): string {
  return error?.response?.data?.error || fallback;
}

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p role={notice.type === 'error' ? 'alert' : 'status'} className={`flex items-start gap-1.5 text-xs ${notice.type === 'error' ? 'text-red-300' : 'text-emerald-300'}`}>
      {notice.type === 'error' ? <AlertCircle size={13} className="mt-0.5 shrink-0" /> : <CheckCircle size={13} className="mt-0.5 shrink-0" />}
      <span>{notice.message}</span>
    </p>
  );
}

function nextRunText(schedule: BackupScheduleView, timeZone: string | null): string {
  if (!schedule.active) return schedule.enabled ? 'Not running right now' : 'Paused';
  if (schedule.nextRunAt) {
    try {
      return new Date(schedule.nextRunAt).toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        timeZoneName: 'short', ...(timeZone ? { timeZone } : {}),
      });
    } catch {}
  }
  return schedule.nextRun || 'Not scheduled';
}

const inputClass = 'rounded-lg border border-white/[0.08] bg-white/[0.05] px-2 py-1.5 text-sm text-slate-200 focus:outline-none accent-focus disabled:opacity-50';
const buttonClass = 'rounded-lg border border-white/[0.08] bg-white/[0.05] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40';

function ScheduleRow({ schedule, timeZone, claim, release, onSaved }: {
  schedule: BackupScheduleView;
  timeZone: string | null;
  claim: Claim;
  release: Release;
  onSaved: (schedule: BackupScheduleView) => void;
}) {
  const initial = useCallback(() => ({
    enabled: schedule.enabled && schedule.active,
    time: schedule.time || (schedule.frequency === 'monthly' ? '04:00' : schedule.frequency === 'weekly' ? '03:00' : '02:00'),
    weekday: schedule.weekday || 'Sun',
    dayOfMonth: schedule.dayOfMonth || 1,
  }), [schedule]);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  useEffect(() => { setDraft(initial()); }, [initial]);

  const original = initial();
  const dirty = draft.enabled !== original.enabled || draft.time !== original.time
    || (schedule.frequency === 'weekly' && draft.weekday !== original.weekday)
    || (schedule.frequency === 'monthly' && draft.dayOfMonth !== original.dayOfMonth)
    || Boolean(schedule.customCalendar);
  const label = SCHEDULE_LABELS[schedule.type] || schedule.type;

  const save = async () => {
    const owner = `settings:backups:schedule:${schedule.type}`;
    if (saving || !claim(owner)) return;
    setSaving(true);
    setNotice(null);
    try {
      const body: Record<string, unknown> = { enabled: draft.enabled, time: draft.time };
      if (schedule.frequency === 'weekly') body.weekday = draft.weekday;
      if (schedule.frequency === 'monthly') body.dayOfMonth = draft.dayOfMonth;
      const { data } = await client.put(`/backups/schedules/${schedule.type}`, body);
      onSaved(data.schedule);
      setNotice({ type: 'success', message: draft.enabled ? 'Schedule saved.' : 'Paused. Existing backups are kept.' });
    } catch (error: any) {
      setNotice({ type: 'error', message: errorMessage(error, 'The schedule could not be changed.') });
    } finally {
      setSaving(false);
      release(owner);
    }
  };

  if (!schedule.loaded || schedule.editable === false) {
    return (
      <div className="py-3">
        <p className="text-sm text-slate-200">{label}</p>
        <p className="mt-0.5 text-xs text-amber-300">
          {schedule.loaded ? 'Managed outside Portal on this server.' : 'Not installed on this server.'}
        </p>
      </div>
    );
  }

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-[11rem] text-sm text-slate-200">{label}</p>
        <label className="flex items-center gap-1.5 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={saving}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            aria-label={`${label} on`}
          />
          On
        </label>
        {schedule.frequency === 'weekly' && (
          <select
            className={inputClass}
            value={draft.weekday}
            disabled={saving}
            aria-label={`${label} day`}
            onChange={(event) => setDraft({ ...draft, weekday: event.target.value })}
          >
            {WEEKDAYS.map((day) => <option key={day} value={day}>{WEEKDAY_LABELS[day]}</option>)}
          </select>
        )}
        {schedule.frequency === 'monthly' && (
          <select
            className={inputClass}
            value={draft.dayOfMonth}
            disabled={saving}
            aria-label={`${label} day of month`}
            onChange={(event) => setDraft({ ...draft, dayOfMonth: Number(event.target.value) })}
          >
            {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>Day {day}</option>)}
          </select>
        )}
        <input
          type="time"
          className={inputClass}
          value={draft.time}
          disabled={saving}
          required
          aria-label={`${label} time`}
          onChange={(event) => setDraft({ ...draft, time: event.target.value })}
        />
        <button type="button" className={buttonClass} disabled={!dirty || saving || !/^\d{2}:\d{2}$/.test(draft.time)} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {schedule.customCalendar ? `Custom schedule (${schedule.customCalendar}). Saving replaces it. ` : ''}
        Next: {nextRunText(schedule, timeZone)}
      </p>
      <div className="mt-1"><NoticeLine notice={notice} /></div>
    </div>
  );
}

export function BackupScheduleSection({ schedules, hostTimezone, error, claim, release, onSaved }: {
  schedules: BackupScheduleView[];
  hostTimezone: string | null;
  error: string;
  claim: Claim;
  release: Release;
  onSaved: (schedule: BackupScheduleView) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Clock size={16} className="text-blue-400" />
        <h3 className="text-sm font-semibold text-white">Automatic backups</h3>
        {hostTimezone && <span className="ml-auto text-xs text-slate-500">Server time zone: {hostTimezone}</span>}
      </div>
      {error ? (
        <div role="alert" className="mt-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>
      ) : schedules.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">No automatic backups are installed on this server.</p>
      ) : (
        <div className="divide-y divide-white/[0.06]">
          {schedules.map((schedule) => (
            <ScheduleRow key={schedule.type} schedule={schedule} timeZone={hostTimezone} claim={claim} release={release} onSaved={onSaved} />
          ))}
        </div>
      )}
      <p className="mt-2 text-xs text-slate-600">Times use the server's time zone. Saving a schedule never starts a backup by itself.</p>
    </div>
  );
}

export function BackupStorageLimitsSection({ claim, release, onBackupsChanged }: {
  claim: Claim;
  release: Release;
  onBackupsChanged: () => Promise<void> | void;
}) {
  const [report, setReport] = useState<PolicyReport | null>(null);
  const [draft, setDraft] = useState<BackupPolicy | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cleanupNotice, setCleanupNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await client.get('/backups/settings');
      setReport(data);
      setDraft(data.policy || data.defaults);
      setLoadError('');
    } catch (error: any) {
      setLoadError(errorMessage(error, 'Backup storage limits could not be loaded.'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loadError) {
    return <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">{loadError}</div>;
  }
  if (!report || !draft) return <p className="text-sm text-slate-500">Loading storage limits…</p>;

  const saved = report.policy || report.defaults;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || report.source === 'invalid';
  const [keepMin, keepMax] = report.limits.keep;
  const [reserveMin, reserveMax] = report.limits.reserveGiB;
  const valid = Object.values(draft.keep).every((value) => Number.isInteger(value) && value >= keepMin && value <= keepMax)
    && Number.isInteger(draft.reserveGiB) && draft.reserveGiB >= reserveMin && draft.reserveGiB <= reserveMax;
  const busy = saving || previewing || deleting;

  const save = async () => {
    const owner = 'settings:backups:storage-limits';
    if (busy || !valid || !claim(owner)) return;
    setSaving(true);
    setNotice(null);
    try {
      const { data } = await client.put('/backups/settings', draft);
      setReport(data);
      setDraft(data.policy);
      setPreview(null);
      setNotice({ type: 'success', message: 'Saved. Nothing was deleted; limits apply after the next backup or a reviewed cleanup.' });
    } catch (error: any) {
      setNotice({ type: 'error', message: errorMessage(error, 'Backup storage limits could not be saved.') });
    } finally {
      setSaving(false);
      release(owner);
    }
  };

  const review = async () => {
    if (busy) return;
    setPreviewing(true);
    setCleanupNotice(null);
    try {
      const { data } = await client.get('/backups/cleanup/preview');
      setPreview(data);
    } catch (error: any) {
      setPreview(null);
      setCleanupNotice({ type: 'error', message: errorMessage(error, 'The cleanup could not be reviewed.') });
    } finally {
      setPreviewing(false);
    }
  };

  const confirmCleanup = async () => {
    const owner = 'settings:backups:cleanup';
    if (!preview || busy || !claim(owner)) return;
    setDeleting(true);
    setCleanupNotice(null);
    try {
      const { data } = await client.post('/backups/cleanup', { planToken: preview.token, confirm: true });
      setPreview(null);
      const held = data.heldBytes > 0
        ? ` ${formatBytes(data.heldBytes)} is still held by an open download and will be released when it finishes.`
        : '';
      setCleanupNotice({
        type: 'success',
        message: `Deleted ${data.deletedCount} backup${data.deletedCount === 1 ? '' : 's'} (${formatBytes(data.deletedBytes)}). `
          + `Free space went up by ${formatBytes(data.freedBytes)}.${held}`,
      });
    } catch (error: any) {
      setPreview(null);
      setCleanupNotice({ type: 'error', message: errorMessage(error, 'Backup cleanup failed. Review it again.') });
    } finally {
      setDeleting(false);
      release(owner);
      await Promise.all([load(), onBackupsChanged()]);
    }
  };

  const setKeep = (kind: keyof KeepLimits, value: string) => setDraft({ ...draft, keep: { ...draft.keep, [kind]: Number(value) } });
  const kept = preview ? [
    preview.protected.newest ? 'your newest complete backup' : '',
    preview.protected.locked ? `${preview.protected.locked} locked` : '',
    preview.protected.pinned ? `${preview.protected.pinned} in use by a Project repair` : '',
  ].filter(Boolean) : [];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <HardDrive size={16} className="text-emerald-400" />
        <h3 className="text-sm font-semibold text-white">Storage limits</h3>
        {report.storage && (
          <span className="ml-auto text-xs text-slate-500">
            Backup disk: {formatBytes(report.storage.freeBytes)} free of {formatBytes(report.storage.totalBytes)}
          </span>
        )}
      </div>
      {report.source === 'invalid' && (
        <p role="alert" className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Saved backup limits could not be read, so no backups are being removed. Review these values and save them.
        </p>
      )}
      <fieldset disabled={busy} className="space-y-3">
        <div>
          <p className="mb-1.5 text-xs text-slate-400">Keep at most this many complete backups of each type</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {KEEP_LABELS.map(([kind, label]) => (
              <label key={kind} className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-xs text-slate-300">
                {label}
                <input type="number" min={keepMin} max={keepMax} step={1} value={draft.keep[kind]} className={`${inputClass} w-16`}
                  aria-label={`Keep ${label.toLowerCase()} backups`} onChange={(event) => setKeep(kind, event.target.value)} />
              </label>
            ))}
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-200">
          <input type="checkbox" className="mt-1" checked={draft.autoCleanup}
            onChange={(event) => setDraft({ ...draft, autoCleanup: event.target.checked })} />
          <span>
            Make room automatically
            <span className="block text-xs text-slate-500">Before each backup, delete the oldest backups when there isn't room for the new one.</span>
          </span>
        </label>
        {draft.autoCleanup && (
          <label className="ml-6 flex items-center gap-2 text-xs text-slate-300">
            Keep at least
            <input type="number" min={reserveMin} max={reserveMax} step={1} value={draft.reserveGiB} className={`${inputClass} w-20`}
              aria-label="Free space to keep in GB" onChange={(event) => setDraft({ ...draft, reserveGiB: Number(event.target.value) })} />
            GB free
          </label>
        )}
      </fieldset>
      <p className="mt-3 text-xs text-slate-500">
        Locked backups, backups a Project repair is using, and your newest complete backup are never deleted automatically.
        Saving doesn't delete anything.
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void review()}>
          {previewing ? 'Checking…' : 'Clean up old backups…'}
        </button>
        <button type="button" className={buttonClass} disabled={!dirty || !valid || busy} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save limits'}
        </button>
      </div>
      <div className="mt-2 space-y-1">
        <NoticeLine notice={notice} />
        <NoticeLine notice={cleanupNotice} />
      </div>
      {preview && (
        <section aria-label="Clean up old backups" className="mt-3 rounded-lg border border-white/[0.08] bg-black/20 p-3">
          {preview.count === 0 ? (
            <p className="text-sm text-slate-300">Nothing to clean up. Every backup is within your limits.</p>
          ) : (
            <>
              <p className="text-sm text-slate-200">
                {preview.count} backup{preview.count === 1 ? ' is' : 's are'} over your limits ({formatBytes(preview.totalBytes)}):
              </p>
              <ul className="mt-2 max-h-48 space-y-1 overflow-auto">
                {preview.archives.map((archive) => (
                  <li key={archive.name} className="flex justify-between gap-3 font-mono text-[11px] text-slate-400">
                    <span className="break-all">{archive.name}</span>
                    <span className="shrink-0">{formatBytes(archive.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {kept.length > 0 && <p className="mt-2 text-xs text-slate-500">Always kept: {kept.join(', ')}.</p>}
          {preview.unverified > 0 && (
            <p className="mt-1 text-xs text-slate-500">{preview.unverified} backup{preview.unverified === 1 ? '' : 's'} that Portal can't verify {preview.unverified === 1 ? 'is' : 'are'} never removed automatically.</p>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className={buttonClass} disabled={deleting} onClick={() => setPreview(null)}>
              {preview.count === 0 ? 'Close' : 'Cancel'}
            </button>
            {preview.count > 0 && (
              <button type="button" disabled={deleting} onClick={() => void confirmCleanup()}
                className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/15 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/25 disabled:opacity-50">
                {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                {deleting ? 'Deleting…' : `Delete ${preview.count} backup${preview.count === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
