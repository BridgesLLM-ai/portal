import { useState, useEffect, useCallback } from 'react';
import { Download, Lock, Unlock, Trash2, RefreshCw, HardDrive, Archive, Calendar, Shield, Plus, Clock, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import client from '../../api/client';
import sounds from '../../utils/sounds';

interface Backup {
  filename: string;
  fullPath: string;
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
  active: string[];
  disabled: string[];
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
  
  const [, min, hour, day, month, dow, command] = match;
  const scriptMatch = command.match(/backup-full\.sh\s+(\w+)|comprehensive-backup\.sh|config-backup\.sh/);
  const type = scriptMatch ? (scriptMatch[1] || 'comprehensive' || 'config') : 'backup';
  
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

export default function BackupsTab() {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createStatus, setCreateStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [cronInfo, setCronInfo] = useState<CronInfo | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [backupType, setBackupType] = useState<'daily' | 'comprehensive'>('daily');

  const fetchBackups = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.get('/backups/list');
      setBackups(data.backups);
      setSummary(data.summary);
    } catch (e) {
      console.error('Failed to fetch backups', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCronInfo = useCallback(async () => {
    try {
      const { data } = await client.get('/backups/cron-info');
      setCronInfo(data);
    } catch (e) {
      console.error('Failed to fetch cron info', e);
    }
  }, []);

  useEffect(() => { fetchBackups(); fetchCronInfo(); }, [fetchBackups, fetchCronInfo]);

  const handleCreateBackup = async () => {
    setCreating(true);
    setCreateStatus(null);
    try {
      // Start backup (returns immediately)
      const { data } = await client.post('/backups/create', { type: backupType });
      
      if (data.status === 'running') {
        // Poll for status every 3 seconds
        const pollInterval = setInterval(async () => {
          try {
            const statusRes = await client.get('/backups/status');
            const status = statusRes.data;
            
            if (status.status === 'completed') {
              clearInterval(pollInterval);
              setCreating(false);
              sounds.success();
              setCreateStatus({ type: 'success', message: 'Backup completed successfully!' });
              await fetchBackups();
              setTimeout(() => setCreateStatus(null), 8000);
            } else if (status.status === 'failed') {
              clearInterval(pollInterval);
              setCreating(false);
              sounds.error();
              setCreateStatus({ 
                type: 'error', 
                message: status.error || 'Backup failed' 
              });
              setTimeout(() => setCreateStatus(null), 8000);
            }
            // If still running, continue polling
          } catch (pollError) {
            console.error('Status poll error:', pollError);
            clearInterval(pollInterval);
            setCreating(false);
            sounds.error();
            setCreateStatus({ type: 'error', message: 'Lost connection to backup process' });
            setTimeout(() => setCreateStatus(null), 8000);
          }
        }, 3000);
        
        // Set timeout to stop polling after 10 minutes
        setTimeout(() => {
          clearInterval(pollInterval);
          if (creating) {
            setCreating(false);
            sounds.error();
            setCreateStatus({ type: 'error', message: 'Backup timed out (may still be running)' });
            setTimeout(() => setCreateStatus(null), 8000);
          }
        }, 600000);
      } else {
        // Immediate response (shouldn't happen with new async backend)
        setCreating(false);
        sounds.notification();
        setCreateStatus({ type: 'success', message: data.message || 'Backup started' });
        setTimeout(() => setCreateStatus(null), 8000);
      }
    } catch (e: any) {
      setCreating(false);
      sounds.error();
      const errorMsg = e.response?.data?.error || 'Failed to start backup';
      setCreateStatus({ type: 'error', message: errorMsg });
      setTimeout(() => setCreateStatus(null), 8000);
    }
  };

  const handleDownload = async (filename: string, size: number) => {
    const CHUNK_SIZE = 5 * 1024 * 1024;
    const baseUrl = import.meta.env.VITE_API_URL || '';

    // For files under 90MB, use direct cookie-authenticated download
    if (size < 90 * 1024 * 1024) {
      setActionLoading(filename);
      try {
        const url = `${baseUrl}/backups/download/${encodeURIComponent(filename)}`;
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setActionLoading(null);
        return;
      } catch (e) {
        console.warn('Direct download failed, falling back to chunked', e);
      }
      setActionLoading(null);
    }

    // Chunked download for large files
    setDownloadProgress(p => ({ ...p, [filename]: 0 }));
    try {
      const { data: info } = await client.get(`/backups/download-info/${encodeURIComponent(filename)}`);
      const totalChunks = info.totalChunks;
      const chunks: ArrayBuffer[] = [];
      
      for (let i = 0; i < totalChunks; i++) {
        const resp = await fetch(`${baseUrl}/backups/chunk/${encodeURIComponent(filename)}?chunk=${i}`, {
          headers: {},
        });
        if (!resp.ok) throw new Error(`Chunk ${i} failed: ${resp.status}`);
        chunks.push(await resp.arrayBuffer());
        setDownloadProgress(p => ({ ...p, [filename]: Math.round(((i + 1) / totalChunks) * 100) }));
      }

      const blob = new Blob(chunks, { type: 'application/gzip' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      console.error('Chunked download error', e);
      alert('Download failed. Please try again.');
    } finally {
      setDownloadProgress(p => {
        const next = { ...p };
        delete next[filename];
        return next;
      });
    }
  };

  const handleLock = async (filename: string) => {
    setActionLoading(filename);
    try {
      await client.post(`/backups/lock/${encodeURIComponent(filename)}`);
      await fetchBackups();
    } catch (e) {
      console.error('Lock toggle failed', e);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (filename: string) => {
    setActionLoading(filename);
    try {
      await client.delete(`/backups/${encodeURIComponent(filename)}`);
      sounds.delete();
      setConfirmDelete(null);
      await fetchBackups();
    } catch (e: any) {
      sounds.error();
      alert(e.response?.data?.error || 'Delete failed');
    } finally {
      setActionLoading(null);
    }
  };

  const filtered = filter === 'all' ? backups : backups.filter(b => b.type === filter);

  return (
    <div className="space-y-6">
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
                onChange={(e) => setBackupType(e.target.value as 'daily')}
                className="w-4 h-4 text-emerald-500 bg-slate-800 border-slate-600 focus:ring-emerald-500 focus:ring-2"
              />
              <span className="text-sm text-slate-300 group-hover:text-white transition-colors">
                Standard <span className="text-xs text-slate-500">(Portal + apps + DB)</span>
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer group">
              <input
                type="radio"
                name="backupType"
                value="comprehensive"
                checked={backupType === 'comprehensive'}
                onChange={(e) => setBackupType(e.target.value as 'comprehensive')}
                className="w-4 h-4 text-emerald-500 bg-slate-800 border-slate-600 focus:ring-emerald-500 focus:ring-2"
              />
              <span className="text-sm text-slate-300 group-hover:text-white transition-colors">
                Comprehensive <span className="text-xs text-slate-500">(+ OpenClaw + projects + configs)</span>
              </span>
            </label>
          </div>

          {/* Create Button + Status */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleCreateBackup}
              disabled={creating}
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
      {cronInfo && (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Clock size={16} className="text-blue-400" />
            <h3 className="text-sm font-semibold text-white">Auto-Backup Schedule</h3>
          </div>
          {cronInfo.active.length > 0 ? (
            <div className="space-y-2">
              {cronInfo.active.map((line, i) => {
                const readable = parseCronLine(line);
                return (
                  <div key={i} className="flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-1.5 flex-shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm text-slate-200">{readable}</p>
                      <details className="mt-1">
                        <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-400">Show raw cron</summary>
                        <code className="text-xs text-slate-600 font-mono block mt-1">{line}</code>
                      </details>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-slate-500">No active backup cron jobs found.</p>
          )}
          {cronInfo.disabled.length > 0 && (
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
          <p className="text-xs text-slate-600 mt-3">💡 Tip: Backups include uploaded apps. Edit backup schedules from server-side cron configuration until in-portal schedule editing is added.</p>
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
                      {downloadProgress[b.filename] !== undefined ? (
                        <div className="flex items-center gap-2 text-xs text-emerald-400">
                          <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-emerald-400 rounded-full transition-all duration-300"
                              style={{ width: `${downloadProgress[b.filename]}%` }}
                            />
                          </div>
                          <span>{downloadProgress[b.filename]}%</span>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleDownload(b.filename, b.size)}
                          disabled={actionLoading === b.filename}
                          className="p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-all"
                          title="Download"
                        >
                          <Download size={14} />
                        </button>
                      )}
                      <button
                        onClick={() => handleLock(b.filename)}
                        disabled={actionLoading === b.filename}
                        className="p-1.5 rounded-lg text-amber-400 hover:bg-amber-500/10 transition-all"
                        title={b.locked ? 'Unlock' : 'Lock'}
                      >
                        {b.locked ? <Unlock size={14} /> : <Lock size={14} />}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(b.filename)}
                        disabled={actionLoading === b.filename || b.locked}
                        className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-30"
                        title="Delete"
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

      {/* Delete Confirmation Modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setConfirmDelete(null)}>
          <div className="bg-[#0D1130] border border-white/10 rounded-2xl p-6 max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">Delete Backup?</h3>
            <p className="text-sm text-slate-400 mb-1">This action cannot be undone.</p>
            <p className="text-xs text-slate-500 font-mono mb-6 break-all">{confirmDelete}</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white transition-all">
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmDelete)}
                disabled={actionLoading === confirmDelete}
                className="px-4 py-2 rounded-lg text-sm bg-red-500/20 text-red-400 border border-red-500/20 hover:bg-red-500/30 transition-all"
              >
                {actionLoading === confirmDelete ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
