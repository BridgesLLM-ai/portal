/**
 * TasksPage — Shows background tasks (subagents, cron jobs) and their status.
 * 
 * Features:
 * - Scrollable within Agent Tools tab layout
 * - Status color coding with visual treatments
 * - Expandable task cards with full details
 * - Status filter bar
 * - Auto-refresh with visual indicator (30s)
 * - Task count summary bar
 * - Relative timestamps
 * - Dark theme matching portal design system
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ListTodo, RefreshCw, Clock, CheckCircle2, XCircle, Loader2, AlertCircle,
  ChevronRight, Filter, Timer, Ban, Hash, Cpu, GitBranch,
  Zap, Calendar, CircleDot
} from 'lucide-react';
import client from '../api/client';

/* ── Types ── */
interface Task {
  id: string;
  name: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'lost' | 'unknown';
  model: string;
  createdAt?: number | string;
  updatedAt?: number | string;
  endedAt?: number | string;
  duration?: number;
  summary?: string;
  parentSession?: string;
  parentName?: string;
  error?: string;
  kind?: 'subagent' | 'cron' | 'unknown';
  runtime?: string;
  deliveryStatus?: string | null;
  notifyPolicy?: string | null;
  agent?: string;
  childCount?: number;
  turns?: number;
  source?: 'history' | 'live' | string;
}

interface TasksResponse {
  ok?: boolean;
  tasks: Task[];
  error?: string;
}

type StatusFilter = 'all' | 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'lost';

/* ── Helpers ── */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function formatRelativeTime(timestamp: number | string | undefined): string {
  if (!timestamp) return '';
  const date = new Date(typeof timestamp === 'string' ? timestamp : timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 0) return 'just now';
  if (diff < 30000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 172800000) return 'yesterday';
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function toTimestamp(v: number | string | undefined): number | undefined {
  if (!v) return undefined;
  if (typeof v === 'number') return v;
  const t = new Date(v).getTime();
  return isNaN(t) ? undefined : t;
}

function truncateId(id: string): string {
  if (id.length <= 32) return id;
  return id.slice(0, 20) + '\u2026' + id.slice(-8);
}

function getTaskSortTimestamp(task: Task): number {
  return toTimestamp(task.endedAt) || toTimestamp(task.updatedAt) || toTimestamp(task.createdAt) || 0;
}

/* ── Status config ── */
// Status colors as inline styles to avoid Tailwind purging and theme pollution
const STATUS_CONFIG = {
  queued: {
    label: 'Queued',
    icon: Clock,
    iconStyle: { color: '#a5b4fc' }, // indigo-300
    bgStyle: { backgroundColor: 'rgba(99, 102, 241, 0.1)', borderColor: 'rgba(99, 102, 241, 0.2)' },
    badgeStyle: { backgroundColor: 'rgba(99, 102, 241, 0.2)', color: '#c7d2fe' }, // indigo-200
    dotStyle: { backgroundColor: '#a5b4fc' }, // indigo-300
    pulseRing: false,
    spinIcon: false,
  },
  running: {
    label: 'Running',
    icon: Loader2,
    iconStyle: { color: '#60a5fa' }, // blue-400
    bgStyle: { backgroundColor: 'rgba(59, 130, 246, 0.1)', borderColor: 'rgba(59, 130, 246, 0.2)' },
    badgeStyle: { backgroundColor: 'rgba(59, 130, 246, 0.2)', color: '#93c5fd' }, // blue-300
    dotStyle: { backgroundColor: '#60a5fa' }, // blue-400
    pulseRing: true,
    spinIcon: true,
  },
  succeeded: {
    label: 'Succeeded',
    icon: CheckCircle2,
    iconStyle: { color: '#34d399' }, // emerald-400
    bgStyle: { backgroundColor: 'rgba(16, 185, 129, 0.1)', borderColor: 'rgba(16, 185, 129, 0.2)' },
    badgeStyle: { backgroundColor: 'rgba(16, 185, 129, 0.2)', color: '#6ee7b7' }, // emerald-300
    dotStyle: { backgroundColor: '#34d399' }, // emerald-400
    pulseRing: false,
    spinIcon: false,
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    iconStyle: { color: '#f87171' }, // red-400
    bgStyle: { backgroundColor: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.2)' },
    badgeStyle: { backgroundColor: 'rgba(239, 68, 68, 0.2)', color: '#fca5a5' }, // red-300
    dotStyle: { backgroundColor: '#f87171' }, // red-400
    pulseRing: false,
    spinIcon: false,
  },
  timed_out: {
    label: 'Timed out',
    icon: AlertCircle,
    iconStyle: { color: '#fdba74' }, // orange-300
    bgStyle: { backgroundColor: 'rgba(249, 115, 22, 0.1)', borderColor: 'rgba(249, 115, 22, 0.2)' },
    badgeStyle: { backgroundColor: 'rgba(249, 115, 22, 0.2)', color: '#fed7aa' }, // orange-200
    dotStyle: { backgroundColor: '#fdba74' }, // orange-300
    pulseRing: false,
    spinIcon: false,
  },
  cancelled: {
    label: 'Cancelled',
    icon: Ban,
    iconStyle: { color: '#fbbf24' }, // amber-400
    bgStyle: { backgroundColor: 'rgba(245, 158, 11, 0.1)', borderColor: 'rgba(245, 158, 11, 0.2)' },
    badgeStyle: { backgroundColor: 'rgba(245, 158, 11, 0.2)', color: '#fcd34d' }, // amber-300
    dotStyle: { backgroundColor: '#fbbf24' }, // amber-400
    pulseRing: false,
    spinIcon: false,
  },
  lost: {
    label: 'Lost',
    icon: AlertCircle,
    iconStyle: { color: '#f0abfc' }, // fuchsia-300
    bgStyle: { backgroundColor: 'rgba(217, 70, 239, 0.1)', borderColor: 'rgba(217, 70, 239, 0.2)' },
    badgeStyle: { backgroundColor: 'rgba(217, 70, 239, 0.2)', color: '#f5d0fe' }, // fuchsia-200
    dotStyle: { backgroundColor: '#f0abfc' }, // fuchsia-300
    pulseRing: false,
    spinIcon: false,
  },
  unknown: {
    label: 'Unknown',
    icon: AlertCircle,
    iconStyle: { color: '#94a3b8' }, // slate-400
    bgStyle: { backgroundColor: 'rgba(100, 116, 139, 0.1)', borderColor: 'rgba(100, 116, 139, 0.2)' },
    badgeStyle: { backgroundColor: 'rgba(100, 116, 139, 0.2)', color: '#cbd5e1' }, // slate-300
    dotStyle: { backgroundColor: '#94a3b8' }, // slate-400
    pulseRing: false,
    spinIcon: false,
  },
} as const;

/* ── TaskCard ── */
function TaskCard({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.unknown;

  const created = toTimestamp(task.createdAt);
  const ended = toTimestamp(task.endedAt) || toTimestamp(task.updatedAt);
  const duration = task.duration || (created && ended ? ended - created : undefined);
  const kindLabel = task.runtime
    ? task.runtime.toUpperCase()
    : task.kind === 'cron'
      ? 'CRON'
      : task.kind === 'subagent'
        ? 'SUBAGENT'
        : null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4, transition: { duration: 0.15 } }}
      transition={{ duration: 0.2 }}
      className="rounded-xl border backdrop-blur-sm cursor-pointer transition-colors hover:border-white/[0.12]"
      style={cfg.bgStyle}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Main row */}
      <div className="flex items-center gap-3 p-4">
        {/* Status dot with optional pulse */}
        <div className="relative flex-shrink-0">
          <div className="w-2.5 h-2.5 rounded-full" style={cfg.dotStyle} />
          {cfg.pulseRing && (
            <div className="absolute inset-0 w-2.5 h-2.5 rounded-full animate-ping opacity-40" style={cfg.dotStyle} />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-medium text-white truncate min-w-0">{task.name}</h3>
            {kindLabel && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-slate-400 flex-shrink-0">
                {kindLabel}
              </span>
            )}
            {task.source === 'history' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 flex-shrink-0">
                Archived
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-slate-500">
            {task.model && task.model !== 'unknown' && (
              <span className="flex items-center gap-1">
                <Cpu size={11} />
                {task.model}
              </span>
            )}
            {duration != null && (
              <span className="flex items-center gap-1">
                <Timer size={11} />
                {formatDuration(duration)}
              </span>
            )}
            {created && (
              <span className="flex items-center gap-1">
                <Clock size={11} />
                {formatRelativeTime(created)}
              </span>
            )}
          </div>
        </div>

        {/* Status badge + chevron */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[11px] px-2 py-0.5 rounded-md font-medium" style={cfg.badgeStyle}>
            {cfg.label}
          </span>
          <motion.div
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={{ duration: 0.15 }}
          >
            <ChevronRight size={14} className="text-slate-500" />
          </motion.div>
        </div>
      </div>

      {/* Expanded details */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-0 border-t border-white/[0.04]">
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
                <DetailRow icon={Hash} label="Task ID" value={task.id} mono />
                {task.model && task.model !== 'unknown' && (
                  <DetailRow icon={Cpu} label="Model" value={task.model} />
                )}
                {task.agent && (
                  <DetailRow icon={Zap} label="Agent" value={task.agent} />
                )}
                {duration != null && (
                  <DetailRow icon={Timer} label="Duration" value={formatDuration(duration)} />
                )}
                {created && (
                  <DetailRow icon={Calendar} label="Started" value={new Date(created).toLocaleString()} />
                )}
                {ended && task.status !== 'running' && (
                  <DetailRow icon={Clock} label="Ended" value={new Date(ended).toLocaleString()} />
                )}
                {task.parentSession && (
                  <DetailRow icon={GitBranch} label="Parent" value={task.parentName || truncateId(task.parentSession)} />
                )}
                {task.turns != null && task.turns > 0 && (
                  <DetailRow icon={CircleDot} label="Turns" value={String(task.turns)} />
                )}
                {task.kind && task.kind !== 'unknown' && (
                  <DetailRow icon={Zap} label="Kind" value={task.kind} />
                )}
                {task.runtime && (
                  <DetailRow icon={Cpu} label="Runtime" value={task.runtime} />
                )}
                {task.deliveryStatus && (
                  <DetailRow icon={Zap} label="Delivery" value={task.deliveryStatus} />
                )}
                {task.notifyPolicy && (
                  <DetailRow icon={CircleDot} label="Notify" value={task.notifyPolicy} />
                )}
                {task.source && (
                  <DetailRow icon={CircleDot} label="Source" value={task.source} />
                )}
              </div>

              {task.summary && (
                <div className="mt-3 p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.04]">
                  <p className="text-xs text-slate-400 leading-relaxed whitespace-pre-wrap">{task.summary}</p>
                </div>
              )}

              {task.error && (
                <div className="mt-3 p-2.5 rounded-lg bg-red-500/[0.08] border border-red-500/[0.12]">
                  <div className="flex items-start gap-2">
                    <XCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-red-300 leading-relaxed whitespace-pre-wrap">{task.error}</p>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ── DetailRow ── */
function DetailRow({ icon: Icon, label, value, mono }: { icon: any; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2 py-1">
      <Icon size={12} className="text-slate-500 mt-0.5 flex-shrink-0" />
      <span className="text-slate-500 min-w-[60px]">{label}:</span>
      <span className={`text-slate-300 break-all ${mono ? 'font-mono text-[11px]' : ''}`}>{value}</span>
    </div>
  );
}

/* ── StatusFilterBar ── */
function StatusFilterBar({
  filter, setFilter, counts
}: {
  filter: StatusFilter;
  setFilter: (f: StatusFilter) => void;
  counts: Record<string, number>;
}) {
  const filters: { key: StatusFilter; label: string; color: string }[] = [
    { key: 'all', label: 'All', color: 'text-slate-300' },
    { key: 'queued', label: 'Queued', color: 'text-indigo-300' },
    { key: 'running', label: 'Running', color: 'text-blue-400' },
    { key: 'succeeded', label: 'Succeeded', color: 'text-emerald-400' },
    { key: 'failed', label: 'Failed', color: 'text-red-400' },
    { key: 'timed_out', label: 'Timed out', color: 'text-orange-300' },
    { key: 'cancelled', label: 'Cancelled', color: 'text-amber-400' },
    { key: 'lost', label: 'Lost', color: 'text-fuchsia-300' },
  ];

  return (
    <div className="flex items-center gap-1 flex-wrap">
      <Filter size={14} className="text-slate-500 mr-1" />
      {filters.map(({ key, label, color }) => {
        const count = key === 'all' ? Object.values(counts).reduce((a, b) => a + b, 0) : (counts[key] || 0);
        if (key !== 'all' && count === 0) return null;
        const active = filter === key;
        return (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-2.5 py-1 text-xs rounded-lg transition-all ${
              active
                ? 'bg-white/[0.1] ' + color + ' font-medium'
                : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.04]'
            }`}
          >
            {label}
            {count > 0 && <span className="ml-1 opacity-70">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ── CountSummary ── */
function CountSummary({ counts }: { counts: Record<string, number> }) {
  const parts: string[] = [];
  if (counts.queued) parts.push(`${counts.queued} queued`);
  if (counts.running) parts.push(`${counts.running} running`);
  if (counts.succeeded) parts.push(`${counts.succeeded} succeeded`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.timed_out) parts.push(`${counts.timed_out} timed out`);
  if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
  if (counts.lost) parts.push(`${counts.lost} lost`);
  if (counts.unknown) parts.push(`${counts.unknown} unknown`);
  if (parts.length === 0) return null;

  return (
    <div className="text-xs text-slate-500">
      {parts.join(' \u00b7 ')}
    </div>
  );
}

/* ── EmptyState ── */
function EmptyState({ filter }: { filter: StatusFilter }) {
  const isFiltered = filter !== 'all';
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-slate-800/50 to-slate-900/50 border border-white/[0.06] flex items-center justify-center mb-5">
        <ListTodo size={28} className="text-slate-500" />
      </div>
      {isFiltered ? (
        <>
          <h3 className="text-base font-medium text-white mb-2">No matching tasks</h3>
          <p className="text-sm text-slate-400 max-w-md">
            No tasks match the current filter. Try selecting &quot;All&quot; to see everything.
          </p>
        </>
      ) : (
        <>
          <h3 className="text-base font-medium text-white mb-2">No Tasks Yet</h3>
          <p className="text-sm text-slate-400 max-w-sm leading-relaxed">
            Background tasks and subagents will appear here when your agent spawns them.
            Try asking your agent to do something that requires a subagent — like coding,
            research, or multi-step work.
          </p>
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
            <RefreshCw size={12} />
            <span>Auto-refreshes every 30 seconds</span>
          </div>
        </>
      )}
    </div>
  );
}

/* ── useTasks hook ── */
function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());
  const [refreshing, setRefreshing] = useState(false);

  const fetchTasks = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const response = await client.get<TasksResponse>('/gateway/tasks');
      if (response.data.ok) {
        setTasks(response.data.tasks || []);
        setError(null);
      } else {
        setError(response.data.error || 'Failed to load tasks');
      }
    } catch (err: any) {
      console.error('Failed to fetch tasks:', err);
      setError(err.response?.data?.error || err.message || 'Failed to load tasks');
    } finally {
      setLoading(false);
      setLastRefresh(Date.now());
      if (manual) setTimeout(() => setRefreshing(false), 400);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(() => fetchTasks(), 30000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') fetchTasks();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchTasks]);

  return { tasks, loading, error, lastRefresh, refreshing, fetchTasks };
}

/* ── Standalone page (TasksPage) ── */
export default function TasksPage() {
  const { tasks, loading, error, lastRefresh, refreshing, fetchTasks } = useTasks();
  const [filter, setFilter] = useState<StatusFilter>('all');

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    tasks.forEach(t => { c[t.status] = (c[t.status] || 0) + 1; });
    return c;
  }, [tasks]);

  const filtered = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => {
      const priority = (status: Task['status']) => {
        if (status === 'running') return 2;
        if (status === 'queued') return 1;
        return 0;
      };
      const pa = priority(a.status);
      const pb = priority(b.status);
      if (pa !== pb) return pb - pa;
      return getTaskSortTimestamp(b) - getTaskSortTimestamp(a);
    });
    if (filter === 'all') return sorted;
    return sorted.filter(t => t.status === filter);
  }, [tasks, filter]);

  return (
    <div className="h-full flex flex-col bg-[#0A0E27]">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-[#0A0E27]/90 backdrop-blur-xl border-b border-white/[0.06]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-500/10 rounded-xl">
                <ListTodo size={24} className="text-blue-400" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">Background Tasks</h1>
                <p className="text-sm text-slate-400">Subagents and long-running operations</p>
              </div>
            </div>
            <button
              onClick={() => fetchTasks(true)}
              disabled={loading}
              className="flex items-center gap-2 px-3 py-2 text-sm bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded-lg transition-colors disabled:opacity-50"
            >
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-4">
          {loading && tasks.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={32} className="animate-spin text-blue-400" />
            </div>
          ) : error ? (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
              <p className="text-red-400">{error}</p>
              <button onClick={() => fetchTasks(true)} className="mt-2 text-sm text-slate-400 hover:text-white">
                Try again
              </button>
            </div>
          ) : (
            <>
              {tasks.length > 0 && (
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <StatusFilterBar filter={filter} setFilter={setFilter} counts={counts} />
                  <CountSummary counts={counts} />
                </div>
              )}

              {filtered.length === 0 ? (
                <EmptyState filter={filter} />
              ) : (
                <div className="space-y-2">
                  <AnimatePresence mode="popLayout">
                    {filtered.map(task => (
                      <TaskCard key={task.id} task={task} />
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </>
          )}

          <p className="text-center text-[10px] text-slate-600 pt-2">
            Auto-refreshes every 30s · Last: {new Date(lastRefresh).toLocaleTimeString()}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── Embeddable content for Agent Tools tab ── */
export function TasksContent({ agentId: _agentId, showHeader = false }: { agentId?: string; showHeader?: boolean }) {
  const { tasks, loading, error, lastRefresh, refreshing, fetchTasks } = useTasks();
  const [filter, setFilter] = useState<StatusFilter>('all');

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    tasks.forEach(t => { c[t.status] = (c[t.status] || 0) + 1; });
    return c;
  }, [tasks]);

  const filtered = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => {
      const priority = (status: Task['status']) => {
        if (status === 'running') return 2;
        if (status === 'queued') return 1;
        return 0;
      };
      const pa = priority(a.status);
      const pb = priority(b.status);
      if (pa !== pb) return pb - pa;
      return getTaskSortTimestamp(b) - getTaskSortTimestamp(a);
    });
    if (filter === 'all') return sorted;
    return sorted.filter(t => t.status === filter);
  }, [tasks, filter]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar area */}
      <div className="flex-shrink-0 px-6 pt-5 pb-3 space-y-3">
        {showHeader && (
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Background Tasks</h2>
          </div>
        )}

        {/* Filter + summary + refresh */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            {tasks.length > 0 && (
              <StatusFilterBar filter={filter} setFilter={setFilter} counts={counts} />
            )}
          </div>
          <div className="flex items-center gap-3">
            <CountSummary counts={counts} />
            <button
              onClick={() => fetchTasks(true)}
              disabled={loading}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-slate-300 rounded-lg transition-colors disabled:opacity-50"
              title="Refresh tasks"
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </div>
      </div>

      {/* Scrollable task list */}
      <div className="flex-1 overflow-y-auto px-6 pb-4">
        {loading && tasks.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-blue-400" />
          </div>
        ) : error ? (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
            <p className="text-red-400 text-sm">{error}</p>
            <button onClick={() => fetchTasks(true)} className="mt-2 text-xs text-slate-400 hover:text-white">
              Try again
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState filter={filter} />
        ) : (
          <div className="space-y-2">
            <AnimatePresence mode="popLayout">
              {filtered.map(task => (
                <TaskCard key={task.id} task={task} />
              ))}
            </AnimatePresence>
          </div>
        )}

        <p className="text-center text-[10px] text-slate-600 pt-3 pb-1">
          Auto-refreshes every 30s · Last: {new Date(lastRefresh).toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
}
