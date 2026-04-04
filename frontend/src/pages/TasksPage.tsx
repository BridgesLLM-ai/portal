/**
 * TasksPage — Shows background tasks (subagents) and their status.
 * 
 * Displays:
 * - Active tasks (currently running)
 * - Recent completed tasks (last 24h)
 * - Failed tasks
 * 
 * Each task card shows: name/label, model, status, duration, summary
 */
import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { ListTodo, RefreshCw, Clock, CheckCircle2, XCircle, Loader2, AlertCircle } from 'lucide-react';
import client from '../api/client';

interface Task {
  id: string;
  name: string;
  status: 'running' | 'done' | 'failed' | 'unknown';
  model: string;
  createdAt?: number | string;
  updatedAt?: number | string;
  duration?: number;
  summary?: string;
  parentSession?: string;
  error?: string;
}

interface TasksResponse {
  ok?: boolean;
  tasks: Task[];
  error?: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

function formatTime(timestamp: number | string | undefined): string {
  if (!timestamp) return '';
  const date = new Date(typeof timestamp === 'string' ? timestamp : timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return date.toLocaleDateString();
}

function TaskCard({ task }: { task: Task }) {
  const statusIcon = {
    running: <Loader2 size={16} className="animate-spin text-blue-400" />,
    done: <CheckCircle2 size={16} className="text-emerald-400" />,
    failed: <XCircle size={16} className="text-red-400" />,
    unknown: <AlertCircle size={16} className="text-slate-400" />,
  }[task.status];
  
  const statusBg = {
    running: 'bg-blue-500/10 border-blue-500/20',
    done: 'bg-emerald-500/10 border-emerald-500/20',
    failed: 'bg-red-500/10 border-red-500/20',
    unknown: 'bg-slate-500/10 border-slate-500/20',
  }[task.status];
  
  const createdAt = task.createdAt 
    ? (typeof task.createdAt === 'number' ? task.createdAt : new Date(task.createdAt).getTime())
    : undefined;
  const updatedAt = task.updatedAt
    ? (typeof task.updatedAt === 'number' ? task.updatedAt : new Date(task.updatedAt).getTime())
    : undefined;
  const duration = task.duration || (createdAt && updatedAt ? updatedAt - createdAt : undefined);
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`p-4 rounded-xl border ${statusBg} backdrop-blur-sm`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {statusIcon}
            <h3 className="text-sm font-medium text-white truncate">{task.name}</h3>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="bg-slate-700/50 px-2 py-0.5 rounded">{task.model}</span>
            {duration && (
              <span className="flex items-center gap-1">
                <Clock size={12} />
                {formatDuration(duration)}
              </span>
            )}
            {createdAt && (
              <span>{formatTime(createdAt)}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <span className={`text-xs px-2 py-1 rounded ${
            task.status === 'running' ? 'bg-blue-500/20 text-blue-300' :
            task.status === 'done' ? 'bg-emerald-500/20 text-emerald-300' :
            task.status === 'failed' ? 'bg-red-500/20 text-red-300' :
            'bg-slate-500/20 text-slate-300'
          }`}>
            {task.status}
          </span>
        </div>
      </div>
      
      {task.summary && (
        <p className="mt-2 text-xs text-slate-400 line-clamp-2">{task.summary}</p>
      )}
      
      {task.error && (
        <p className="mt-2 text-xs text-red-400 line-clamp-2">{task.error}</p>
      )}
      
      {task.parentSession && (
        <p className="mt-1 text-[10px] text-slate-500 truncate">
          Parent: {task.parentSession}
        </p>
      )}
    </motion.div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="w-16 h-16 rounded-full bg-slate-800/50 flex items-center justify-center mb-4">
        <ListTodo size={28} className="text-slate-500" />
      </div>
      <h3 className="text-lg font-medium text-white mb-2">No Tasks Yet</h3>
      <p className="text-sm text-slate-400 max-w-md">
        Background tasks and subagents will appear here when they're running.
        Start a conversation that spawns a subagent to see tasks.
      </p>
    </div>
  );
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());
  
  const fetchTasks = useCallback(async () => {
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
    }
  }, []);
  
  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 30000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') fetchTasks();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchTasks]);
  
  const runningTasks = tasks.filter(t => t.status === 'running');
  const completedTasks = tasks.filter(t => t.status === 'done');
  const failedTasks = tasks.filter(t => t.status === 'failed');
  const otherTasks = tasks.filter(t => t.status !== 'running' && t.status !== 'done' && t.status !== 'failed');
  
  return (
    <div className="min-h-full bg-theme-bg">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-theme-bg/80 backdrop-blur-xl border-b border-theme-border">
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
      
      {/* Content */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        {loading && tasks.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={32} className="animate-spin text-blue-400" />
          </div>
        ) : error ? (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
            <p className="text-red-400">{error}</p>
            <button
              onClick={fetchTasks}
              className="mt-2 text-sm text-slate-400 hover:text-white"
            >
              Try again
            </button>
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-6">
            {/* Running Tasks */}
            {runningTasks.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-slate-400 mb-3 flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  Running ({runningTasks.length})
                </h2>
                <div className="space-y-3">
                  {runningTasks.map(task => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </div>
              </section>
            )}
            
            {/* Completed Tasks */}
            {completedTasks.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-slate-400 mb-3 flex items-center gap-2">
                  <CheckCircle2 size={14} className="text-emerald-400" />
                  Completed ({completedTasks.length})
                </h2>
                <div className="space-y-3">
                  {completedTasks.map(task => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </div>
              </section>
            )}
            
            {/* Failed Tasks */}
            {failedTasks.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-slate-400 mb-3 flex items-center gap-2">
                  <XCircle size={14} className="text-red-400" />
                  Failed ({failedTasks.length})
                </h2>
                <div className="space-y-3">
                  {failedTasks.map(task => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </div>
              </section>
            )}
            
            {/* Other Tasks */}
            {otherTasks.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-slate-400 mb-3">
                  Other ({otherTasks.length})
                </h2>
                <div className="space-y-3">
                  {otherTasks.map(task => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
        
        {/* Last refresh time */}
        <p className="mt-6 text-center text-xs text-slate-500">
          Last refreshed: {new Date(lastRefresh).toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
}

/* ── Embeddable content for Agent Tools tab ── */
export function TasksContent({ agentId: _agentId, showHeader = false }: { agentId?: string; showHeader?: boolean }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());

  const fetchTasks = useCallback(async () => {
    try {
      const response = await client.get<TasksResponse>('/gateway/tasks');
      if (response.data.ok) {
        setTasks(response.data.tasks || []);
        setError(null);
      } else {
        setError(response.data.error || 'Failed to load tasks');
      }
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to load tasks');
    } finally {
      setLoading(false);
      setLastRefresh(Date.now());
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 30000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') fetchTasks();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchTasks]);

  const runningTasks = tasks.filter(t => t.status === 'running');
  const completedTasks = tasks.filter(t => t.status === 'done');
  const failedTasks = tasks.filter(t => t.status === 'failed');

  return (
    <div className="space-y-6">
      {showHeader && (
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Background Tasks</h2>
          <button onClick={fetchTasks} disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 text-xs bg-slate-800/50 hover:bg-slate-700/50 text-slate-300 rounded-lg">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      )}

      {loading && tasks.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-blue-400" />
        </div>
      ) : error ? (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
          <p className="text-red-400 text-sm">{error}</p>
          <button onClick={fetchTasks} className="mt-2 text-xs text-slate-400 hover:text-white">Try again</button>
        </div>
      ) : tasks.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {runningTasks.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-slate-400 mb-3 flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" /> Running ({runningTasks.length})
              </h3>
              <div className="space-y-3">{runningTasks.map(t => <TaskCard key={t.id} task={t} />)}</div>
            </section>
          )}
          {completedTasks.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-slate-400 mb-3 flex items-center gap-2">
                <CheckCircle2 size={14} className="text-emerald-400" /> Completed ({completedTasks.length})
              </h3>
              <div className="space-y-3">{completedTasks.map(t => <TaskCard key={t.id} task={t} />)}</div>
            </section>
          )}
          {failedTasks.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-slate-400 mb-3 flex items-center gap-2">
                <XCircle size={14} className="text-red-400" /> Failed ({failedTasks.length})
              </h3>
              <div className="space-y-3">{failedTasks.map(t => <TaskCard key={t.id} task={t} />)}</div>
            </section>
          )}
        </>
      )}
      <p className="text-center text-[10px] text-slate-500 mt-4">
        Last refreshed: {new Date(lastRefresh).toLocaleTimeString()}
      </p>
    </div>
  );
}
