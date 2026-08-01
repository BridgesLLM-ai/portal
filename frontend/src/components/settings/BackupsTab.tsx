import { useState, useEffect, useCallback, useRef } from 'react';
import { Download, Lock, Unlock, Trash2, RefreshCw, HardDrive, Archive, Calendar, Shield, Plus, Clock, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import client from '../../api/client';
import sounds from '../../utils/sounds';
import ConfirmDialog from '../ConfirmDialog';
import { useSettingsMutationCoordinator } from './SettingsMutationContext';

interface Backup {
  filename: string;
  size: number;
  sizeHuman: string;
  created: string;
  type: string;
  locked: boolean;
}

interface Summary {
  total: number;
  totalSize: number;
  totalSizeHuman: string;
  oldest: string | null;
  newest: string | null;
}

interface CronInfo {
  schedules: Array<{
    type: 'daily' | 'monthly' | 'comprehensive';
    source: 'systemd';
    timerUnit: string;
    serviceUnit: string;
    loaded: boolean;
    enabled: boolean;
    active: boolean;
    onCalendar: string | null;
    nextRun: string | null;
    lastRun: string | null;
  }>;
  active: string[];
  disabled: string[];
}

interface BackupRunStatus {
  id?: string;
  type?: string;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
  startedAt?: string;
  completedAt?: string;
  archivePath?: string;
  error?: string;
  output?: string;
}

const typeBadgeColors: Record<string, string> = {
  daily: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  weekly: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  monthly: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
  comprehensive: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
};

function sizeBadgeColor(size: number): string {
  if (size > 2 * 1024 * 1024 * 1024) return 'text-red-400'; // >2GB = red
  if (size > 1 * 1024 * 1024 * 1024) return 'text-amber-400'; // >1GB = amber
  if (size > 500 * 1024 * 1024) return 'text-blue-400'; // >500MB = blue
  return 'text-slate-400';
}

function parseCronLine(line: string): string {
  // Parse cron syntax into human-readable format
  const match = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
  if (!match) return line;
  
  const [, min, hour, day, , dow, command] = match;
  const scriptMatch = command.match(/backup-full\.sh\s+(\w+)|comprehensive-backup\.sh|config-backup\.sh/);
  const type = scriptMatch?.[1]
    || (command.includes('config-backup.sh') ? 'config' : command.includes('comprehensive-backup.sh') ? 'comprehensive' : 'backup');
  
  let schedule = '';
  
  // Parse day of week
  if (dow !== '*') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    schedule = days[parseInt(dow)] || `Day ${dow}`;
  }
  
  // Parse day of month
  if (day !== '*') {
    schedule = schedule ? `${schedule}, ${day}` : `${day} of month`;
  }
  
  // Parse hour/minute
  if (hour === '*' && min.includes('/')) {
    const interval = min.split('/')[1];
    schedule = `Every ${interval} hours`;
  } else if (hour !== '*') {
    const h = parseInt(hour);
    const m = parseInt(min);
    const time = `${h}:${m.toString().padStart(2, '0')}`;
    schedule = schedule ? `${schedule} at ${time}` : `Daily at ${time}`;
  }
  
  return `${schedule} (${type})`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

interface BackupsTabProps {
  backupPath?: string;
  onBackupPathChange?: (v: string) => void;
  onSaveBackupPath?: () => void;
  backupPathDirty?: boolean;
}

export default function BackupsTab({ backupPath, onBackupPathChange, onSaveBackupPath, backupPathDirty }: BackupsTabProps = {}) {
  const settingsMutation = useSettingsMutationCoordinator();
  const settingsClaim = settingsMutation?.claim;
  const settingsRelease = settingsMutation?.release;
  const [backups, setBackups] = useState<Backup[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createStatus, setCreateStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [cronInfo, setCronInfo] = useState<CronInfo | null>(null);
  const [lastRun, setLastRun] = useState<BackupRunStatus | null>(null);
  const [listError, setListError] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  const [operationStatus, setOperationStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [backupType, setBackupType] = useState<'daily' | 'comprehensive'>('daily');
  const pollTimerRef = useRef<number | null>(null);
  const pollGenerationRef = useRef(0);
  const dismissTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const operationAdmissionRef = useRef<string | null>(null);
  const settingsMutationOwnerRef = useRef<string | null>(null);

  const claimSettingsMutation = useCallback((owner: string) => {
    if (settingsMutationOwnerRef.current) return false;
    if (settingsClaim && !settingsClaim(owner)) return false;
    settingsMutationOwnerRef.current = owner;
    return true;
  }, [settingsClaim]);

  const releaseSettingsMutation = useCallback((owner: string) => {
    if (settingsMutationOwnerRef.current !== owner) return;
    settingsMutationOwnerRef.current = null;
    settingsRelease?.(owner);
  }, [settingsRelease]);

  const fetchBackups = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.get('/backups/list');
      setBackups(data.backups);
      setSummary(data.summary);
      setListError('');
    } catch (e: any) {
      console.error('Failed to fetch backups', e);
      setListError(e.response?.data?.error || 'Backup storage could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCronInfo = useCallback(async () => {
    try {
      const { data } = await client.get('/backups/cron-info');
      setCronInfo(data);
      setScheduleError('');
    } catch (e: any) {
      console.error('Failed to fetch cron info', e);
      setScheduleError(e.response?.data?.error || 'Installed backup schedules could not be read.');
    }
  }, []);

  const clearPollTimer = useCallback(() => {
    pollGenerationRef.current += 1;
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const showCreateStatus = useCallback((status: { type: 'success' | 'error'; message: string }) => {
    if (!mountedRef.current) return;
    setCreateStatus(status);
    if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setCreateStatus(null);
      dismissTimerRef.current = null;
    }, 8000);
  }, []);

  const pollBackupStatus = useCallback(() => {
    clearPollTimer();
    const generation = pollGenerationRef.current;
    const poll = async () => {
      try {
        const { data: status } = await client.get('/backups/status');
        if (!mountedRef.current || pollGenerationRef.current !== generation) return;
        setLastRun(status);
        if (status.status === 'completed') {
          setCreating(false);
          operationAdmissionRef.current = null;
          const settingsOwner = settingsMutationOwnerRef.current;
          if (settingsOwner?.startsWith('settings:backups:create:')) releaseSettingsMutation(settingsOwner);
          sounds.success();
          showCreateStatus({ type: 'success', message: 'Backup completed successfully.' });
          await fetchBackups();
          return;
        }
        if (status.status === 'failed') {
          setCreating(false);
          operationAdmissionRef.current = null;
          const settingsOwner = settingsMutationOwnerRef.current;
          if (settingsOwner?.startsWith('settings:backups:create:')) releaseSettingsMutation(settingsOwner);
          sounds.error();
          showCreateStatus({ type: 'error', message: status.error || 'Backup failed' });
          return;
        }
        pollTimerRef.current = window.setTimeout(poll, 3000);
      } catch (pollError) {
        console.error('Backup status poll error:', pollError);
        if (!mountedRef.current || pollGenerationRef.current !== generation) return;
        // A transient connection failure must not claim the systemd job was lost.
        pollTimerRef.current = window.setTimeout(poll, 5000);
      }
    };
    void poll();
  }, [clearPollTimer, fetchBackups, releaseSettingsMutation, showCreateStatus]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchBackups();
    void fetchCronInfo();
    void client.get('/backups/status').then(({ data }) => {
      if (mountedRef.current) setLastRun(data);
      if (mountedRef.current && (data.status === 'queued' || data.status === 'running')) {
        setCreating(true);
        pollBackupStatus();
      }
    }).catch((statusError: any) => {
      if (mountedRef.current) {
        setOperationStatus({
          type: 'error',
          message: statusError.response?.data?.error || 'The last backup status could not be read.',
        });
      }
    });
    return () => {
      mountedRef.current = false;
      clearPollTimer();
      if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
      const settingsOwner = settingsMutationOwnerRef.current;
      if (settingsOwner) releaseSettingsMutation(settingsOwner);
    };
  }, [clearPollTimer, fetchBackups, fetchCronInfo, pollBackupStatus, releaseSettingsMutation]);

  const handleCreateBackup = async () => {
    if (operationAdmissionRef.current || creating) return;
    const settingsOwner = `settings:backups:create:${backupType}`;
    if (!claimSettingsMutation(settingsOwner)) return;
    operationAdmissionRef.current = 'create';
    clearPollTimer();
    setCreating(true);
    setCreateStatus(null);
    try {
      const { data } = await client.post('/backups/create', { type: backupType });
      if (data.status === 'failed') {
        setCreating(false);
        operationAdmissionRef.current = null;
        releaseSettingsMutation(settingsOwner);
        sounds.error();
        showCreateStatus({ type: 'error', message: data.error || 'Backup failed to start' });
        return;
      }
      pollBackupStatus();
    } catch (e: any) {
      setCreating(false);
      operationAdmissionRef.current = null;
      releaseSettingsMutation(settingsOwner);
      sounds.error();
      showCreateStatus({ type: 'error', message: e.response?.data?.error || 'Failed to start backup' });
    }
  };

  const handleDownload = async (filename: string) => {
    if (operationAdmissionRef.current) return;
    operationAdmissionRef.current = `download:${filename}`;
    const baseUrl = import.meta.env.VITE_API_URL || '/api';
    setActionLoading(filename);
    setOperationStatus(null);
    try {
      await client.get(`/backups/download-info/${encodeURIComponent(filename)}`);
      const a = document.createElement('a');
      a.href = `${baseUrl.replace(/\/$/, '')}/backups/download/${encodeURIComponent(filename)}`;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setOperationStatus({ type: 'success', message: `Download started for ${filename}.` });
    } catch (e: any) {
      console.error('Backup download error', e);
      setOperationStatus({ type: 'error', message: e.response?.data?.error || 'Download failed. Please try again.' });
    } finally {
      operationAdmissionRef.current = null;
      setActionLoading(null);
    }
  };

  const handleLock = async (filename: string) => {
    if (operationAdmissionRef.current) return;
    const operationOwner = `lock:${filename}`;
    const settingsOwner = `settings:backups:${operationOwner}`;
    if (!claimSettingsMutation(settingsOwner)) return;
    operationAdmissionRef.current = operationOwner;
    setActionLoading(filename);
    setOperationStatus(null);
    try {
      await client.post(`/backups/lock/${encodeURIComponent(filename)}`);
      await fetchBackups();
      setOperationStatus({ type: 'success', message: `Retention lock updated for ${filename}.` });
    } catch (e: any) {
      console.error('Lock toggle failed', e);
      setOperationStatus({ type: 'error', message: e.response?.data?.error || 'Retention lock could not be updated.' });
    } finally {
      operationAdmissionRef.current = null;
      setActionLoading(null);
      releaseSettingsMutation(settingsOwner);
    }
  };

  const handleDelete = async (filename: string) => {
    if (operationAdmissionRef.current) return;
    const operationOwner = `delete:${filename}`;
    const settingsOwner = `settings:backups:${operationOwner}`;
    if (!claimSettingsMutation(settingsOwner)) return;
    operationAdmissionRef.current = operationOwner;
    setActionLoading(filename);
    setOperationStatus(null);
    setDeleteError(null);
    try {
      await client.delete(`/backups/${encodeURIComponent(filename)}`);
      sounds.delete();
      setConfirmDelete(null);
      await fetchBackups();
      setOperationStatus({ type: 'success', message: `${filename} was deleted.` });
    } catch (e: any) {
      sounds.error();
      const message = e.response?.data?.error || 'Delete failed.';
      setDeleteError(message);
      setOperationStatus({ type: 'error', message });
    } finally {
      operationAdmissionRef.current = null;
      setActionLoading(null);
      releaseSettingsMutation(settingsOwner);
    }
  };

  const filtered = filter === 'all' ? backups : backups.filter(b => b.type === filter);

  return (
    <div className="space-y-6">
      {operationStatus && (
        <div
          role={operationStatus.type === 'error' ? 'alert' : 'status'}
          className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${
            operationStatus.type === 'error'
              ? 'border-red-500/20 bg-red-500/10 text-red-300'
              : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          {operationStatus.type === 'error' ? <AlertCircle size={16} className="mt-0.5 shrink-0" /> : <CheckCircle size={16} className="mt-0.5 shrink-0" />}
          <span>{operationStatus.message}</span>
        </div>
      )}

      <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-sm text-blue-200">
        <div className="flex items-start gap-2">
          <Shield size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-medium">Recovery is an offline operation</p>
            <p className="mt-1 text-xs leading-relaxed text-blue-200/80">
              Download and retain an encrypted, access-controlled off-server copy: archives contain user data and service
              credentials. Portal intentionally does not restore a live archive while its database, mail, app, and OpenClaw
              services are running; recovery must quiesce those services and include a rollback plan.
            </p>
          </div>
        </div>
      </div>

      {/* Backup Path Configuration */}
      {onBackupPathChange && (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Backup Storage</h3>
          <div className="space-y-3">
            <div>
              <label htmlFor="backup-storage-path" className="text-sm font-medium text-slate-200 block mb-1.5">Backup Path</label>
              <p className="text-xs text-slate-500 mb-1.5">Directory for automated and manual backups</p>
              <input
                id="backup-storage-path"
                type="text"
                value={backupPath || '/root/backups'}
                onChange={e => onBackupPathChange(e.target.value)}
                placeholder="/root/backups"
                className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none accent-focus transition-all"
              />
            </div>
            {onSaveBackupPath && (
              <div className="flex justify-end">
                <button
                  onClick={onSaveBackupPath}
                  disabled={!backupPathDirty}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all border ${
                    backupPathDirty
                      ? 'accent-btn'
                      : 'bg-white/[0.04] text-slate-500 border-white/[0.06] cursor-not-allowed'
                  }`}
                  style={backupPathDirty ? {
                    background: 'var(--accent-bg)',
                    color: 'var(--accent)',
                    borderColor: 'var(--accent-border)',
                  } : undefined}
                >
                  Save Path
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create Backup + Status */}
      <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Plus size={16} className="text-emerald-400" />
            <h3 className="text-sm font-semibold text-white">Create Manual Backup</h3>
          </div>
          
          {/* Backup Type Selector */}
          <div className="flex gap-3">
            <label className="flex items-center gap-2 cursor-pointer group">
              <input
                type="radio"
                name="backupType"
                value="daily"
                checked={backupType === 'daily'}
                disabled={creating || Boolean(actionLoading)}
                onChange={(e) => setBackupType(e.target.value as 'daily')}
                className="w-4 h-4 text-emerald-500 bg-slate-800 border-slate-600 focus:ring-emerald-500 focus:ring-2"
              />
              <span className="text-sm text-slate-300 group-hover:text-white transition-colors">
                Standard <span className="text-xs text-slate-500">(all data + compact Portal install)</span>
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer group">
              <input
                type="radio"
                name="backupType"
                value="comprehensive"
                checked={backupType === 'comprehensive'}
                disabled={creating || Boolean(actionLoading)}
                onChange={(e) => setBackupType(e.target.value as 'comprehensive')}
                className="w-4 h-4 text-emerald-500 bg-slate-800 border-slate-600 focus:ring-emerald-500 focus:ring-2"
              />
              <span className="text-sm text-slate-300 group-hover:text-white transition-colors">
                Comprehensive <span className="text-xs text-slate-500">(all data + full Portal install)</span>
              </span>
            </label>
          </div>

          {/* Create Button + Status */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleCreateBackup}
              disabled={creating || Boolean(actionLoading)}
              aria-busy={creating}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/25 transition-all font-medium text-sm disabled:opacity-50"
            >
              {creating ? <Loader2 size={16} className="animate-spin" /> : <Archive size={16} />}
              {creating ? 'Creating Backup...' : 'Create Backup Now'}
            </button>
            {createStatus && (
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                createStatus.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
              }`}>
                {createStatus.type === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
                {createStatus.message}
              </div>
            )}
          </div>

          {lastRun && lastRun.status !== 'idle' && (
            <div className="rounded-xl border border-white/[0.06] bg-black/10 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`h-2 w-2 rounded-full ${
                  lastRun.status === 'running' || lastRun.status === 'queued' ? 'animate-pulse bg-blue-400'
                    : lastRun.status === 'completed' ? 'bg-emerald-400'
                      : 'bg-red-400'
                }`} />
                <span className="font-medium capitalize text-slate-200">{lastRun.type || 'Portal'} backup {lastRun.status}</span>
                {lastRun.startedAt && <span className="text-slate-500">Started {formatDate(lastRun.startedAt)}</span>}
                {lastRun.completedAt && <span className="text-slate-500">Finished {formatDate(lastRun.completedAt)}</span>}
              </div>
              {lastRun.error && <p className="mt-2 text-xs text-red-400">{lastRun.error}</p>}
              {lastRun.output && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-400">Show bounded backup log</summary>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/20 p-2 text-[11px] text-slate-500">{lastRun.output}</pre>
                </details>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { icon: Archive, label: 'Total Backups', value: summary.total, color: 'text-blue-400' },
            { icon: HardDrive, label: 'Storage Used', value: summary.totalSizeHuman, color: 'text-emerald-400' },
            { icon: Calendar, label: 'Newest', value: summary.newest ? formatDate(summary.newest) : 'N/A', color: 'text-purple-400' },
            { icon: Shield, label: 'Locked', value: backups.filter(b => b.locked).length, color: 'text-amber-400' },
          ].map(({ icon: Icon, label, value, color }) => (
            <div key={label} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
              <div className="flex items-center gap-2 mb-1">
                <Icon size={14} className={color} />
                <span className="text-xs text-slate-500">{label}</span>
              </div>
              <div className="text-lg font-semibold text-white">{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Auto-Backup Schedule Info */}
      {(cronInfo || scheduleError) && (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Clock size={16} className="text-blue-400" />
            <h3 className="text-sm font-semibold text-white">Auto-Backup Schedule</h3>
          </div>
          {scheduleError ? (
            <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">{scheduleError}</div>
          ) : cronInfo && cronInfo.schedules.length > 0 ? (
            <div className="space-y-2">
              {cronInfo.schedules.map(schedule => (
                <div key={schedule.timerUnit} className="flex items-start gap-3">
                  <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${schedule.loaded && schedule.enabled && schedule.active ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm capitalize text-slate-200">{schedule.type}</p>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${schedule.loaded && schedule.enabled && schedule.active ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}`}>
                        {schedule.loaded ? (schedule.enabled && schedule.active ? 'enabled' : 'inactive') : 'unit missing'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {schedule.onCalendar || 'No OnCalendar expression reported'}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Next: {schedule.nextRun || 'not scheduled'}
                      {schedule.lastRun ? ` • Last: ${schedule.lastRun}` : ''}
                    </p>
                    <code className="mt-1 block break-all text-[10px] text-slate-600">{schedule.timerUnit}</code>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">No installed backup timers were found.</p>
          )}
          {cronInfo && cronInfo.active.length > 0 && (
            <div className="mt-3 border-t border-white/[0.06] pt-3">
              <p className="mb-2 text-xs text-amber-400">Legacy cron entries still present:</p>
              {cronInfo.active.map((line, i) => (
                <code key={i} className="block break-all font-mono text-xs text-slate-500">{parseCronLine(line)} — {line}</code>
              ))}
            </div>
          )}
          {cronInfo && cronInfo.disabled.length > 0 && (
            <div className="mt-3 pt-3 border-t border-white/[0.06]">
              <p className="text-xs text-slate-500 mb-2">Disabled:</p>
              {cronInfo.disabled.map((line, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-slate-600 mt-1.5 flex-shrink-0" />
                  <code className="text-xs text-slate-600 font-mono break-all">{line}</code>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-slate-600 mt-3">Schedules shown above come from the installed systemd timers. Portal updates preserve the selected storage path and reconcile these units.</p>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 bg-white/[0.03] rounded-lg p-1 border border-white/[0.06]">
          {['all', 'daily', 'weekly', 'monthly', 'comprehensive'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all capitalize ${
                filter === f ? 'bg-emerald-500/20 text-emerald-400' : 'text-slate-400 hover:text-white'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <button
          onClick={fetchBackups}
          className="ml-auto flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-sm text-slate-400 hover:text-white transition-all"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Table */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl overflow-hidden">
        {listError && (
          <div role="alert" className="flex items-center justify-between gap-3 border-b border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            <span>{listError}</span>
            <button type="button" onClick={() => void fetchBackups()} className="rounded-lg border border-red-400/20 px-2.5 py-1 text-xs font-medium hover:bg-red-500/10">Retry</button>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Type</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Size</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Date</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Status</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-500">Loading...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-500">No backups found</td></tr>
              ) : filtered.map(b => (
                <tr key={b.filename} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-3">
                    <span className="text-slate-200 font-mono text-xs">{b.filename}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-md text-xs font-medium border ${typeBadgeColors[b.type] || 'text-slate-400'}`}>
                      {b.type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`font-mono text-xs ${sizeBadgeColor(b.size)}`}>{b.sizeHuman}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">{formatDate(b.created)}</td>
                  <td className="px-4 py-3 text-center">
                    {b.locked ? (
                      <Lock size={14} className="inline text-amber-400" />
                    ) : (
                      <Unlock size={14} className="inline text-slate-600" />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleDownload(b.filename)}
                        disabled={Boolean(actionLoading) || creating}
                        className="p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-all"
                        title="Download"
                        aria-label={`Download ${b.filename}`}
                      >
                        {actionLoading === b.filename ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                      </button>
                      <button
                        onClick={() => handleLock(b.filename)}
                        disabled={Boolean(actionLoading) || creating}
                        className="p-1.5 rounded-lg text-amber-400 hover:bg-amber-500/10 transition-all"
                        title={b.locked ? 'Unlock' : 'Lock'}
                        aria-label={`${b.locked ? 'Unlock' : 'Lock'} ${b.filename}`}
                      >
                        {b.locked ? <Unlock size={14} /> : <Lock size={14} />}
                      </button>
                      <button
                        onClick={() => {
                          if (operationAdmissionRef.current) return;
                          setDeleteError(null);
                          setConfirmDelete(b.filename);
                        }}
                        disabled={Boolean(actionLoading) || creating || b.locked}
                        className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-30"
                        title="Delete"
                        aria-label={`Delete ${b.filename}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Delete backup?"
        message="This permanently removes the recovery archive."
        detail={confirmDelete || undefined}
        error={deleteError}
        confirmLabel="Delete backup"
        busy={actionLoading === confirmDelete}
        busyLabel="Deleting backup…"
        onCancel={() => {
          if (!operationAdmissionRef.current) {
            setDeleteError(null);
            setConfirmDelete(null);
          }
        }}
        onConfirm={() => {
          if (confirmDelete) void handleDelete(confirmDelete);
        }}
      />
    </div>
  );
}
