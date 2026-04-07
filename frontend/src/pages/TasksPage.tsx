/**
 * TasksPage — Shows background tasks (subagents) and their status.
 */
import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import {
  ListTodo,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import client from '../api/client';

interface Task {
  id: string;
  name: string;
  status: 'running' | 'done' | 'failed' | 'unknown';
  model: string;
  kind?: 'subagent' | 'cron' | string;
  createdAt?: number | string;
  updatedAt?: number | string;
  duration?: number;
  prompt?: string;
  summary?: string;
  detail?: string | null;
  parentSession?: string;
  error?: string;
}

interface TasksResponse {
  ok?: boolean;
  tasks: Task[];
  error?: string;
}

function toMillis(timestamp: number | string | undefined): number | undefined {
  if (!timestamp && timestamp !== 0) return undefined;
  if (typeof timestamp === 'number') return timestamp;
  const ms = new Date(timestamp).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

function formatTime(timestamp: number | string | undefined): string {
  const ms = toMillis(timestamp);
  if (!ms) return '';
  const date = new Date(ms);
  const diff = Date.now() - ms;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return date.toLocaleDateString();
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const aTime = toMillis(a.updatedAt) ?? toMillis(a.createdAt) ?? 0;
    const bTime = toMillis(b.updatedAt) ?? toMillis(b.createdAt) ?? 0;
    return bTime - aTime;
  });
}

function useTasksData() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());

  const fetchTasks = useCallback(async () => {
    try {
      const response = await client.get<TasksResponse>('/gateway/tasks');
      if (response.data.ok) {
        setTasks(Array.isArray(response.data.tasks) ? response.data.tasks : []);
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
    }
  }, []);

  const hasRunning = tasks.some((task) => task.status === 'running');
  const refreshMs = hasRunning ? 10000 : 30000;

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  useEffect(() => {
    const interval = setInterval(fetchTasks, refreshMs);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') fetchTasks();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchTasks, refreshMs]);

  return { tasks, loading, error, lastRefresh, fetchTasks, refreshMs, hasRunning };
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="w-16 h-16 rounded-full bg-slate-800/50 flex items-center justify-center mb-4">
        <ListTodo size={28} className="text-slate-500" />
      </div>
      <h3 className="text-lg font-medium text-white mb-2">No Tasks Yet</h3>
      <p className="text-sm text-slate-400 max-w-md">
        Background tasks and subagents will appear here when they&apos;re running.
        Start a conversation that spawns a subagent to see tasks.
      </p>
    </div>
  );
}

function DetailBlock({
  label,
  value,
  tone = 'slate',
}: {
  label: string;
  value?: string | null;
  tone?: 'slate' | 'red' | 'blue';
}) {
  if (!value) return null;
  const toneClass = tone === 'red'
    ? 'bg-red-500/8 border-red-500/15 text-red-200'
    : tone === 'blue'
      ? 'bg-blue-500/8 border-blue-500/15 text-blue-100'
      : 'bg-black/15 border-white/5 text-slate-300';

  return (
    <div className={`rounded-xl border px-3 py-2.5 ${toneClass}`}>
      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-1.5">{label}</div>
      <div className="max-h-40 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-xs leading-5">
        {value}
      </div>
    </div>
  );
}

function TaskCard({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = {
    running: <Loader2 size={16} className="animate-spin text-blue-400" />,
    done: <CheckCircle2 size={16} className="text-emerald-400" />,
    failed: <XCircle size={16} className="text-red-400" />,
    unknown: <AlertCircle size={16} className="text-slate-400" />,
  }[task.status];

  const statusBg = {
    running: 'bg-blue-500/10 border-blue-500/20 shadow-blue-950/20',
    done: 'bg-emerald-500/10 border-emerald-500/20 shadow-emerald-950/20',
    failed: 'bg-red-500/10 border-red-500/20 shadow-red-950/20',
    unknown: 'bg-slate-500/10 border-slate-500/20 shadow-slate-950/20',
  }[task.status];

  const createdAt = toMillis(task.createdAt);
  const updatedAt = toMillis(task.updatedAt);
  const duration = task.duration || (createdAt && updatedAt ? Math.max(updatedAt - createdAt, 0) : undefined);
  const prompt = task.prompt && task.prompt !== task.name ? task.prompt : null;
  const summary = task.summary && task.summary !== prompt ? task.summary : null;
  const detail = task.detail && task.detail !== summary ? task.detail : null;
  const canExpand = Boolean(prompt || detail || task.error || task.parentSession || task.id || (summary && summary.length > 180));

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-2xl border p-4 backdrop-blur-sm shadow-lg ${statusBg}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2 mb-2">
            <div className="mt-0.5 flex-shrink-0">{statusIcon}</div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-white leading-5 break-words">{task.name}</h3>
              {prompt ? (
                <p className="mt-1 text-xs text-slate-400 line-clamp-2">{prompt}</p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="rounded-md bg-slate-700/50 px-2 py-0.5">{task.model}</span>
            {task.kind ? (
              <span className="rounded-md bg-slate-800/70 px-2 py-0.5 uppercase tracking-wide">{task.kind}</span>
            ) : null}
            {duration ? (
              <span className="flex items-center gap-1">
                <Clock size={12} />
                {formatDuration(duration)}
              </span>
            ) : null}
            {updatedAt || createdAt ? <span>updated {formatTime(updatedAt || createdAt)}</span> : null}
          </div>
        </div>

        <div className="flex items-center gap-2 pl-2">
          <span className={`text-xs px-2 py-1 rounded-full border ${
            task.status === 'running' ? 'border-blue-400/20 bg-blue-500/15 text-blue-200' :
            task.status === 'done' ? 'border-emerald-400/20 bg-emerald-500/15 text-emerald-200' :
            task.status === 'failed' ? 'border-red-400/20 bg-red-500/15 text-red-200' :
            'border-slate-400/20 bg-slate-500/15 text-slate-200'
          }`}>
            {task.status}
          </span>
          {canExpand ? (
            <button
              onClick={() => setExpanded((value) => !value)}
              className="inline-flex items-center gap-1 rounded-lg border border-white/8 bg-white/5 px-2 py-1 text-[11px] text-slate-300 hover:bg-white/10 hover:text-white transition-colors"
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {expanded ? 'Less' : 'Details'}
            </button>
          ) : null}
        </div>
      </div>

      {summary ? (
        <div className="mt-3 rounded-xl border border-white/5 bg-black/15 px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-1.5">Latest update</div>
          <div className={`text-xs text-slate-300 whitespace-pre-wrap break-words leading-5 ${expanded ? 'max-h-40 overflow-y-auto overscroll-contain' : 'line-clamp-3'}`}>
            {summary}
          </div>
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-3 space-y-3">
          <DetailBlock label="Task" value={prompt} tone="blue" />
          <DetailBlock label="Details" value={detail} />
          <DetailBlock label="Error" value={task.error} tone="red" />

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-white/5 bg-black/15 px-3 py-2.5 text-xs text-slate-300">
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-1.5">Task session</div>
              <div className="break-all font-mono text-[11px] text-slate-400">{task.id}</div>
            </div>
            {task.parentSession ? (
              <div className="rounded-xl border border-white/5 bg-black/15 px-3 py-2.5 text-xs text-slate-300">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-1.5">Parent session</div>
                <div className="break-all font-mono text-[11px] text-slate-400">{task.parentSession}</div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </motion.div>
  );
}

function TaskSection({
  title,
  icon,
  tasks,
}: {
  title: string;
  icon?: ReactNode;
  tasks: Task[];
}) {
  if (tasks.length === 0) return null;
  return (
    <section>
      <h3 className="text-sm font-medium text-slate-400 mb-3 flex items-center gap-2">
        {icon}
        {title} ({tasks.length})
      </h3>
      <div className="space-y-3">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} />
        ))}
      </div>
    </section>
  );
}

function TasksBody({
  tasks,
  loading,
  error,
  fetchTasks,
  lastRefresh,
  refreshMs,
}: {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  fetchTasks: () => Promise<void>;
  lastRefresh: number;
  refreshMs: number;
}) {
  const runningTasks = useMemo(() => sortTasks(tasks.filter((task) => task.status === 'running')), [tasks]);
  const completedTasks = useMemo(() => sortTasks(tasks.filter((task) => task.status === 'done')), [tasks]);
  const failedTasks = useMemo(() => sortTasks(tasks.filter((task) => task.status === 'failed')), [tasks]);
  const otherTasks = useMemo(() => sortTasks(tasks.filter((task) => !['running', 'done', 'failed'].includes(task.status))), [tasks]);

  if (loading && tasks.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={32} className="animate-spin text-blue-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
        <p className="text-red-400">{error}</p>
        <button onClick={fetchTasks} className="mt-2 text-sm text-slate-400 hover:text-white">
          Try again
        </button>
      </div>
    );
  }

  if (tasks.length === 0) {
    return <EmptyState />;
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-white/5 bg-white/[0.03] px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Total tasks</div>
          <div className="mt-1 text-lg font-semibold text-white">{tasks.length}</div>
        </div>
        <div className="rounded-2xl border border-blue-500/15 bg-blue-500/8 px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-blue-200/60">Running now</div>
          <div className="mt-1 text-lg font-semibold text-blue-100">{runningTasks.length}</div>
        </div>
        <div className="rounded-2xl border border-white/5 bg-white/[0.03] px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Auto refresh</div>
          <div className="mt-1 text-sm font-medium text-white">every {Math.round(refreshMs / 1000)}s</div>
        </div>
      </div>

      <div className="space-y-6 mt-6">
        <TaskSection title="Running" icon={<Loader2 size={14} className="animate-spin" />} tasks={runningTasks} />
        <TaskSection title="Failed" icon={<XCircle size={14} className="text-red-400" />} tasks={failedTasks} />
        <TaskSection title="Completed" icon={<CheckCircle2 size={14} className="text-emerald-400" />} tasks={completedTasks} />
        <TaskSection title="Other" tasks={otherTasks} />
      </div>

      <p className="mt-6 text-center text-xs text-slate-500">
        Last refreshed: {new Date(lastRefresh).toLocaleTimeString()}
      </p>
    </>
  );
}

export default function TasksPage() {
  const { tasks, loading, error, lastRefresh, fetchTasks, refreshMs } = useTasksData();

  return (
    <div className="min-h-full bg-theme-bg">
      <div className="sticky top-0 z-10 bg-theme-bg/80 backdrop-blur-xl border-b border-theme-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-500/10 rounded-xl">
                <ListTodo size={24} className="text-blue-400" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">Background Tasks</h1>
                <p className="text-sm text-slate-400">Subagents, cron work, and long-running operations</p>
              </div>
            </div>
            <button
              onClick={fetchTasks}
              disabled={loading}
              className="flex items-center gap-2 px-3 py-2 text-sm bg-slate-800/50 hover:bg-slate-700/50 text-slate-300 rounded-lg transition-colors disabled:opacity-50"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        <TasksBody
          tasks={tasks}
          loading={loading}
          error={error}
          fetchTasks={fetchTasks}
          lastRefresh={lastRefresh}
          refreshMs={refreshMs}
        />
      </div>
    </div>
  );
}

export function TasksContent({ agentId: _agentId, showHeader = false }: { agentId?: string; showHeader?: boolean }) {
  const { tasks, loading, error, lastRefresh, fetchTasks, refreshMs } = useTasksData();

  return (
    <div className="min-h-0 h-full overflow-y-auto pr-1 space-y-6">
      {showHeader ? (
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Background Tasks</h2>
            <p className="text-xs text-slate-400">Auto refresh every {Math.round(refreshMs / 1000)}s</p>
          </div>
          <button
            onClick={fetchTasks}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 text-xs bg-slate-800/50 hover:bg-slate-700/50 text-slate-300 rounded-lg disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      ) : null}

      <TasksBody
        tasks={tasks}
        loading={loading}
        error={error}
        fetchTasks={fetchTasks}
        lastRefresh={lastRefresh}
        refreshMs={refreshMs}
      />
    </div>
  );
}
