/**
 * TasksPage — Shows background tasks (subagents) and their status.
 */
import { useState, useEffect, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { UNSAFE_NavigationContext } from 'react-router-dom';
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
import { agentJobsAPI, type AgentJob } from '../api/agentJobs';
import TypedConfirmationDialog from '../components/TypedConfirmationDialog';

interface Task {
  id: string;
  name: string;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'unknown';
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
  portalJobId?: string;
}

interface TasksResponse {
  ok?: boolean;
  tasks: Task[];
  error?: string;
  warning?: string;
}

type CancelJobTarget = Readonly<{
  jobId: string;
  taskId: string;
  taskName: string;
}>;

const JOB_KILL_REQUEST_TIMEOUT_MS = 15_000;
const JOB_INVENTORY_REQUEST_TIMEOUT_MS = 8_000;
const JOB_CANCELLATION_READBACK_TIMEOUT_MS = 20_000;
const JOB_CANCELLATION_READBACK_INTERVAL_MS = 500;

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(timeoutMessage)), Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function normalizeAgentJob(job: AgentJob): Task {
  const status: Task['status'] = job.status === 'completed'
    ? 'done'
    : job.status === 'killed'
      ? 'cancelled'
      : job.status === 'error'
      ? 'failed'
      : job.status === 'running'
        ? 'running'
        : 'unknown';
  const updatedAt = job.finishedAt || job.startedAt || job.createdAt;
  const started = toMillis(job.startedAt || job.createdAt);
  const finished = toMillis(job.finishedAt || updatedAt);

  return {
    id: `portal-job:${job.id}`,
    name: job.title || `${job.toolId} job`,
    status,
    model: job.toolId,
    kind: 'portal-job',
    createdAt: job.createdAt,
    updatedAt,
    duration: started && finished ? Math.max(finished - started, 0) : undefined,
    summary: job.status === 'running'
      ? 'Portal background job is running.'
      : job.status === 'killed'
        ? 'Portal background job was cancelled.'
      : job.exitCode === null || job.exitCode === undefined
        ? undefined
        : `Exited with code ${job.exitCode}`,
    detail: 'Portal maintenance, tool install, or long-running server operation.',
    portalJobId: job.id,
  };
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
  const [warning, setWarning] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  const fetchTasks = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const [gatewayResult, jobsResult] = await Promise.allSettled([
        client.get<TasksResponse>('/gateway/tasks'),
        agentJobsAPI.list(),
      ]);
      const nextTasks: Task[] = [];
      const errors: string[] = [];

      if (gatewayResult.status === 'fulfilled' && gatewayResult.value.data.ok) {
        nextTasks.push(...(Array.isArray(gatewayResult.value.data.tasks) ? gatewayResult.value.data.tasks : []));
        if (gatewayResult.value.data.warning) errors.push(gatewayResult.value.data.warning);
      } else if (gatewayResult.status === 'fulfilled') {
        errors.push(gatewayResult.value.data.warning || gatewayResult.value.data.error || 'OpenClaw task snapshot unavailable');
      } else {
        errors.push(gatewayResult.reason?.response?.data?.error || gatewayResult.reason?.message || 'OpenClaw task snapshot unavailable');
      }

      if (jobsResult.status === 'fulfilled') {
        nextTasks.push(...jobsResult.value.map(normalizeAgentJob));
      } else {
        errors.push(jobsResult.reason?.response?.data?.error || jobsResult.reason?.message || 'Portal background jobs unavailable');
      }

      if (!mountedRef.current || requestId !== requestRef.current) return;
      setTasks(nextTasks);
      setError(nextTasks.length === 0 && errors.length ? errors.join(' · ') : null);
      setWarning(nextTasks.length > 0 && errors.length ? errors.join(' · ') : null);
    } catch (err: any) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      console.error('Failed to fetch tasks:', err);
      setError(err.response?.data?.error || err.message || 'Failed to load tasks');
      setWarning(null);
    } finally {
      if (mountedRef.current && requestId === requestRef.current) {
        setLoading(false);
        setLastRefresh(Date.now());
      }
    }
  }, []);

  const applyPortalJobReadback = useCallback((jobId: string, job: AgentJob | null) => {
    // Invalidate an older all-source refresh so it cannot put a pre-cancel
    // running snapshot back after the authoritative retained-job readback.
    requestRef.current += 1;
    setTasks((current) => {
      const withoutTarget = current.filter((task) => task.portalJobId !== jobId);
      return job ? [...withoutTarget, normalizeAgentJob(job)] : withoutTarget;
    });
    setLoading(false);
    setLastRefresh(Date.now());
  }, []);

  const hasRunning = tasks.some((task) => task.status === 'running');
  const refreshMs = hasRunning ? 10000 : 30000;

  useEffect(() => {
    mountedRef.current = true;
    void fetchTasks();
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, [fetchTasks]);

  useEffect(() => {
    const interval = setInterval(fetchTasks, refreshMs);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void fetchTasks();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchTasks, refreshMs]);

  return { tasks, loading, error, warning, lastRefresh, fetchTasks, applyPortalJobReadback, refreshMs, hasRunning };
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="w-16 h-16 rounded-full bg-slate-800/50 flex items-center justify-center mb-4">
        <ListTodo size={28} className="text-slate-500" />
      </div>
      <h3 className="text-lg font-medium text-white mb-2">No Tasks Yet</h3>
      <p className="text-sm text-slate-400 max-w-md">
        Background jobs, maintenance operations, and subagents will appear here when they&apos;re running.
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

function TaskCard({
  task,
  cancelBlocked,
  onRequestCancel,
}: {
  task: Task;
  cancelBlocked: boolean;
  onRequestCancel: (task: Task) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [jobOutput, setJobOutput] = useState<string | null>(null);
  const [jobOutputError, setJobOutputError] = useState<string | null>(null);
  const [jobOutputLoading, setJobOutputLoading] = useState(false);
  const outputRequestRef = useRef(0);
  const outputLoadedRef = useRef(false);

  const loadJobOutput = useCallback(async () => {
    if (!task.portalJobId) return;
    const requestId = ++outputRequestRef.current;
    if (!outputLoadedRef.current) setJobOutputLoading(true);
    setJobOutputError(null);
    try {
      const transcript = await agentJobsAPI.transcript(task.portalJobId, 200);
      if (requestId !== outputRequestRef.current) return;
      setJobOutput(transcript.map((entry) => {
        const channel = entry.stream || entry.type;
        return `[${channel}] ${entry.text}`;
      }).join('\n') || 'No transcript output was retained for this job.');
      outputLoadedRef.current = true;
    } catch (error: any) {
      if (requestId !== outputRequestRef.current) return;
      setJobOutputError(error?.response?.data?.error || error?.message || 'Failed to load job output');
    } finally {
      if (requestId === outputRequestRef.current) setJobOutputLoading(false);
    }
  }, [task.portalJobId]);

  useEffect(() => {
    outputRequestRef.current += 1;
    outputLoadedRef.current = false;
    setJobOutput(null);
    setJobOutputError(null);
  }, [task.portalJobId]);

  useEffect(() => {
    if (!expanded || !task.portalJobId) return undefined;
    void loadJobOutput();
    if (task.status !== 'running') return undefined;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadJobOutput();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [expanded, loadJobOutput, task.portalJobId, task.status]);

  useEffect(() => () => { outputRequestRef.current += 1; }, []);

  const statusIcon = {
    running: <Loader2 size={16} className="animate-spin text-blue-400" />,
    done: <CheckCircle2 size={16} className="text-emerald-400" />,
    failed: <XCircle size={16} className="text-red-400" />,
    cancelled: <XCircle size={16} className="text-amber-400" />,
    unknown: <AlertCircle size={16} className="text-slate-400" />,
  }[task.status];

  const statusBg = {
    running: 'bg-blue-500/10 border-blue-500/20 shadow-blue-950/20',
    done: 'bg-emerald-500/10 border-emerald-500/20 shadow-emerald-950/20',
    failed: 'bg-red-500/10 border-red-500/20 shadow-red-950/20',
    cancelled: 'bg-amber-500/10 border-amber-500/20 shadow-amber-950/20',
    unknown: 'bg-slate-500/10 border-slate-500/20 shadow-slate-950/20',
  }[task.status];

  const createdAt = toMillis(task.createdAt);
  const updatedAt = toMillis(task.updatedAt);
  const duration = task.duration ?? (createdAt && updatedAt ? Math.max(updatedAt - createdAt, 0) : undefined);
  const prompt = task.prompt && task.prompt !== task.name ? task.prompt : null;
  const summary = task.summary && task.summary !== prompt ? task.summary : null;
  const detail = task.detail && task.detail !== summary ? task.detail : null;
  const canExpand = Boolean(prompt || detail || task.error || task.parentSession || task.portalJobId || (summary && summary.length > 180));

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-2xl border p-4 backdrop-blur-sm shadow-lg ${statusBg}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-start gap-2">
            <div className="mt-0.5 flex-shrink-0">{statusIcon}</div>
            <div className="min-w-0 flex-1">
              <h3 className="break-words text-sm font-medium leading-5 text-white">{task.name}</h3>
              {prompt ? <p className="mt-1 line-clamp-2 text-xs text-slate-400">{prompt}</p> : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="rounded-md bg-slate-700/50 px-2 py-0.5">{task.model}</span>
            {task.kind ? <span className="rounded-md bg-slate-800/70 px-2 py-0.5 uppercase tracking-wide">{task.kind}</span> : null}
            {duration !== undefined ? (
              <span className="flex items-center gap-1"><Clock size={12} />{formatDuration(duration)}</span>
            ) : null}
            {updatedAt || createdAt ? <span>updated {formatTime(updatedAt || createdAt)}</span> : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:justify-end sm:pl-2">
          <span className={`rounded-full border px-2 py-1 text-xs ${
            task.status === 'running' ? 'border-blue-400/20 bg-blue-500/15 text-blue-200' :
            task.status === 'done' ? 'border-emerald-400/20 bg-emerald-500/15 text-emerald-200' :
            task.status === 'failed' ? 'border-red-400/20 bg-red-500/15 text-red-200' :
            task.status === 'cancelled' ? 'border-amber-400/20 bg-amber-500/15 text-amber-200' :
            'border-slate-400/20 bg-slate-500/15 text-slate-200'
          }`}>{task.status}</span>
          {canExpand ? (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className="inline-flex min-h-[40px] items-center gap-1 rounded-lg border border-white/8 bg-white/5 px-2 py-1 text-[11px] text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {expanded ? 'Less' : 'Details'}
            </button>
          ) : null}
          {task.status === 'running' && task.portalJobId ? (
            <button
              type="button"
              onClick={() => onRequestCancel(task)}
              disabled={cancelBlocked}
              className="inline-flex min-h-[40px] items-center rounded-lg border border-red-500/20 bg-red-500/10 px-2 py-1 text-[11px] text-red-200 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>

      {summary ? (
        <div className="mt-3 rounded-xl border border-white/5 bg-black/15 px-3 py-2.5">
          <div className="mb-1.5 text-[10px] uppercase tracking-[0.18em] text-slate-500">Latest update</div>
          <div className={`whitespace-pre-wrap break-words text-xs leading-5 text-slate-300 ${expanded ? 'max-h-40 overflow-y-auto overscroll-contain' : 'line-clamp-3'}`}>{summary}</div>
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-3 space-y-3">
          <DetailBlock label="Task" value={prompt} tone="blue" />
          <DetailBlock label="Details" value={detail} />
          <DetailBlock label="Error" value={task.error} tone="red" />
          {jobOutputLoading ? (
            <div className="flex items-center gap-2 rounded-xl border border-white/5 bg-black/15 px-3 py-2.5 text-xs text-slate-400">
              <Loader2 size={13} className="animate-spin" /> Loading bounded job output…
            </div>
          ) : null}
          <DetailBlock label="Job output (latest 200 entries)" value={jobOutput} />
          <DetailBlock label="Job output error" value={jobOutputError} tone="red" />

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-white/5 bg-black/15 px-3 py-2.5 text-xs text-slate-300">
              <div className="mb-1.5 text-[10px] uppercase tracking-[0.18em] text-slate-500">Task session</div>
              <div className="break-all font-mono text-[11px] text-slate-400">{task.id}</div>
            </div>
            {task.parentSession ? (
              <div className="rounded-xl border border-white/5 bg-black/15 px-3 py-2.5 text-xs text-slate-300">
                <div className="mb-1.5 text-[10px] uppercase tracking-[0.18em] text-slate-500">Parent session</div>
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
  cancelBlocked,
  onRequestCancel,
}: {
  title: string;
  icon?: ReactNode;
  tasks: Task[];
  cancelBlocked: boolean;
  onRequestCancel: (task: Task) => void;
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
          <TaskCard
            key={task.id}
            task={task}
            cancelBlocked={cancelBlocked}
            onRequestCancel={onRequestCancel}
          />
        ))}
      </div>
    </section>
  );
}

function TasksBody({
  tasks,
  loading,
  error,
  warning,
  fetchTasks,
  applyPortalJobReadback,
  lastRefresh,
  refreshMs,
}: {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  warning: string | null;
  fetchTasks: () => Promise<void>;
  applyPortalJobReadback: (jobId: string, job: AgentJob | null) => void;
  lastRefresh: number;
  refreshMs: number;
}) {
  const navigationContext = useContext(UNSAFE_NavigationContext);
  const routerNavigator = navigationContext?.navigator;
  const [cancelTarget, setCancelTarget] = useState<CancelJobTarget | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelAcknowledgedJob, setCancelAcknowledgedJob] = useState<string | null>(null);
  const cancelTargetRef = useRef<CancelJobTarget | null>(null);
  const cancelLeaseRef = useRef<CancelJobTarget | null>(null);
  const cancelAcknowledgedJobRef = useRef<string | null>(null);
  const releaseNavigationLockRef = useRef<(() => void) | null>(null);
  const cancellationHistoryRef = useRef<{
    url: string;
    state: unknown;
    historyIndex: number | null;
  } | null>(null);

  const releaseNavigationLock = useCallback(() => {
    releaseNavigationLockRef.current?.();
    releaseNavigationLockRef.current = null;
    cancellationHistoryRef.current = null;
  }, []);

  const acquireNavigationLock = useCallback(() => {
    if (releaseNavigationLockRef.current) return;
    const browserHistoryIndex = window.history.state?.idx;
    cancellationHistoryRef.current = {
      url: window.location.href,
      state: window.history.state,
      historyIndex: typeof browserHistoryIndex === 'number' ? browserHistoryIndex : null,
    };

    if (!routerNavigator) {
      releaseNavigationLockRef.current = () => undefined;
      return;
    }
    const originalPush = routerNavigator.push;
    const originalReplace = routerNavigator.replace;
    const originalGo = routerNavigator.go;
    const blockedPush: typeof routerNavigator.push = () => undefined;
    const blockedReplace: typeof routerNavigator.replace = () => undefined;
    const blockedGo: typeof routerNavigator.go = () => undefined;
    routerNavigator.push = blockedPush;
    routerNavigator.replace = blockedReplace;
    routerNavigator.go = blockedGo;
    releaseNavigationLockRef.current = () => {
      if (routerNavigator.push === blockedPush) routerNavigator.push = originalPush;
      if (routerNavigator.replace === blockedReplace) routerNavigator.replace = originalReplace;
      if (routerNavigator.go === blockedGo) routerNavigator.go = originalGo;
    };
  }, [routerNavigator]);

  useEffect(() => {
    const preventUnload = (event: BeforeUnloadEvent) => {
      if (!cancelLeaseRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const preventLinkNavigation = (event: MouseEvent) => {
      if (!cancelLeaseRef.current) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || anchor.hasAttribute('download') || anchor.target === '_blank') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const preventHistoryTraversal = (event: PopStateEvent) => {
      if (!cancelLeaseRef.current) return;
      const guard = cancellationHistoryRef.current;
      if (!guard) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const nextIndex = window.history.state?.idx;
      if (guard.historyIndex !== null && typeof nextIndex === 'number') {
        const distanceToOwner = guard.historyIndex - nextIndex;
        if (distanceToOwner !== 0) window.history.go(distanceToOwner);
        return;
      }
      window.history.pushState(guard.state, '', guard.url);
    };

    window.addEventListener('beforeunload', preventUnload);
    window.addEventListener('popstate', preventHistoryTraversal, true);
    document.addEventListener('click', preventLinkNavigation, true);
    return () => {
      window.removeEventListener('beforeunload', preventUnload);
      window.removeEventListener('popstate', preventHistoryTraversal, true);
      document.removeEventListener('click', preventLinkNavigation, true);
    };
  }, []);

  useEffect(() => releaseNavigationLock, [releaseNavigationLock]);

  const requestCancel = useCallback((task: Task) => {
    if (!task.portalJobId || cancelTargetRef.current || cancelLeaseRef.current) return;
    const target = Object.freeze({
      jobId: task.portalJobId,
      taskId: task.id,
      taskName: task.name,
    });
    cancelTargetRef.current = target;
    cancelAcknowledgedJobRef.current = null;
    setCancelAcknowledgedJob(null);
    setCancelError(null);
    setCancelTarget(target);
  }, []);

  const dismissCancel = useCallback(() => {
    if (cancelLeaseRef.current) return;
    cancelTargetRef.current = null;
    cancelAcknowledgedJobRef.current = null;
    setCancelAcknowledgedJob(null);
    setCancelError(null);
    setCancelTarget(null);
  }, []);

  const verifyCancellationReadback = useCallback(async (jobId: string): Promise<AgentJob | null> => {
    const deadline = Date.now() + JOB_CANCELLATION_READBACK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      const requestTimeoutMs = Math.max(1, Math.min(JOB_INVENTORY_REQUEST_TIMEOUT_MS, remainingMs));
      let jobs: AgentJob[];
      try {
        jobs = await withDeadline(
          agentJobsAPI.list({ timeoutMs: requestTimeoutMs }),
          requestTimeoutMs,
          'the inventory request timed out',
        );
      } catch (inventoryFailure) {
        const reason = inventoryFailure instanceof Error ? inventoryFailure.message : 'the inventory request failed';
        throw new Error(`Cancellation was acknowledged, but retained-job inventory did not answer for ${jobId}: ${reason}. The dialog remains open; retry verification or inspect Tasks before sending another cancellation.`);
      }
      if (!Array.isArray(jobs)) {
        throw new Error(`Cancellation was acknowledged, but Portal returned malformed retained-job inventory for ${jobId}. Retry verification before sending another cancellation.`);
      }
      const job = jobs.find((candidate) => candidate.id === jobId) || null;
      if (!job || job.status === 'completed' || job.status === 'error' || job.status === 'killed') return job;

      const delayMs = Math.min(JOB_CANCELLATION_READBACK_INTERVAL_MS, Math.max(0, deadline - Date.now()));
      if (delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }
    throw new Error(`Cancellation was acknowledged, but retained job ${jobId} still reports running after 20 seconds. Retry verification or inspect Tasks; do not send another cancellation yet.`);
  }, []);

  const confirmCancel = useCallback(async () => {
    const target = cancelTargetRef.current;
    if (!target || cancelLeaseRef.current) return;
    const lease = Object.freeze({ ...target });
    cancelLeaseRef.current = lease;
    acquireNavigationLock();
    setCancelBusy(true);
    setCancelError(null);
    try {
      if (cancelAcknowledgedJobRef.current !== lease.jobId) {
        await withDeadline(
          agentJobsAPI.kill(lease.jobId, { timeoutMs: JOB_KILL_REQUEST_TIMEOUT_MS }),
          JOB_KILL_REQUEST_TIMEOUT_MS,
          `Portal did not acknowledge cancellation for ${lease.jobId} within 15 seconds. The dialog remains open; inspect Tasks before retrying.`,
        );
        cancelAcknowledgedJobRef.current = lease.jobId;
        setCancelAcknowledgedJob(lease.jobId);
      }
      if (cancelLeaseRef.current !== lease) return;
      const verifiedJob = await verifyCancellationReadback(lease.jobId);
      if (cancelLeaseRef.current !== lease) return;
      applyPortalJobReadback(lease.jobId, verifiedJob);
      cancelAcknowledgedJobRef.current = null;
      setCancelAcknowledgedJob(null);
      cancelTargetRef.current = null;
      setCancelTarget(null);
    } catch (cancelFailure: any) {
      if (cancelLeaseRef.current === lease) {
        setCancelError(
          cancelFailure?.response?.data?.error
          || cancelFailure?.message
          || `Failed to cancel background job ${lease.jobId}`,
        );
      }
    } finally {
      if (cancelLeaseRef.current === lease) {
        cancelLeaseRef.current = null;
        releaseNavigationLock();
        setCancelBusy(false);
      }
    }
  }, [acquireNavigationLock, applyPortalJobReadback, releaseNavigationLock, verifyCancellationReadback]);

  const runningTasks = useMemo(() => sortTasks(tasks.filter((task) => task.status === 'running')), [tasks]);
  const completedTasks = useMemo(() => sortTasks(tasks.filter((task) => task.status === 'done')), [tasks]);
  const failedTasks = useMemo(() => sortTasks(tasks.filter((task) => task.status === 'failed')), [tasks]);
  const cancelledTasks = useMemo(() => sortTasks(tasks.filter((task) => task.status === 'cancelled')), [tasks]);
  const otherTasks = useMemo(() => sortTasks(tasks.filter((task) => !['running', 'done', 'failed', 'cancelled'].includes(task.status))), [tasks]);

  const cancellationDialog = (
    <TypedConfirmationDialog
      open={Boolean(cancelTarget)}
      title={`Cancel ${cancelTarget?.taskName || 'background job'}`}
      description="This sends a termination request to the retained Portal background job and its descendant process tree. Output remains available here."
      confirmationPhrase={cancelTarget ? `CANCEL JOB ${cancelTarget.jobId}` : null}
      confirmLabel={cancelAcknowledgedJob === cancelTarget?.jobId ? 'Retry verification' : 'Cancel job'}
      busyLabel={cancelAcknowledgedJob === cancelTarget?.jobId ? 'Verifying cancellation…' : 'Cancelling job…'}
      tone="danger"
      busy={cancelBusy}
      details={cancelTarget ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-300">
            Job: <code className="break-all font-mono text-white">{cancelTarget.jobId}</code>
          </div>
          {cancelAcknowledgedJob === cancelTarget.jobId ? (
            <div role="status" className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
              Portal accepted the cancellation. Retrying verifies the same retained job; it does not send another termination request.
            </div>
          ) : null}
          {cancelError ? (
            <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {cancelError}
            </div>
          ) : null}
        </div>
      ) : null}
      onCancel={dismissCancel}
      onConfirm={() => { void confirmCancel(); }}
    />
  );

  if (loading && tasks.length === 0) {
    return (
      <>
        <div className="flex items-center justify-center py-16">
          <Loader2 size={32} className="animate-spin text-blue-400" />
        </div>
        {cancellationDialog}
      </>
    );
  }

  if (error) {
    return (
      <>
        <div role="alert" className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
          <p className="text-red-400">{error}</p>
          <button type="button" onClick={() => { void fetchTasks(); }} className="mt-2 min-h-[44px] text-sm text-slate-400 hover:text-white">
            Try again
          </button>
        </div>
        {cancellationDialog}
      </>
    );
  }

  if (tasks.length === 0) {
    return <><EmptyState />{cancellationDialog}</>;
  }

  return (
    <>
      {warning ? (
        <div role="status" className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Some task sources are unavailable: {warning}
        </div>
      ) : null}
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
        <TaskSection title="Running" icon={<Loader2 size={14} className="animate-spin" />} tasks={runningTasks} cancelBlocked={Boolean(cancelTarget)} onRequestCancel={requestCancel} />
        <TaskSection title="Failed" icon={<XCircle size={14} className="text-red-400" />} tasks={failedTasks} cancelBlocked={Boolean(cancelTarget)} onRequestCancel={requestCancel} />
        <TaskSection title="Cancelled" icon={<XCircle size={14} className="text-amber-400" />} tasks={cancelledTasks} cancelBlocked={Boolean(cancelTarget)} onRequestCancel={requestCancel} />
        <TaskSection title="Completed" icon={<CheckCircle2 size={14} className="text-emerald-400" />} tasks={completedTasks} cancelBlocked={Boolean(cancelTarget)} onRequestCancel={requestCancel} />
        <TaskSection title="Other" tasks={otherTasks} cancelBlocked={Boolean(cancelTarget)} onRequestCancel={requestCancel} />
      </div>

      <p className="mt-6 text-center text-xs text-slate-500">
        Last refreshed: {new Date(lastRefresh).toLocaleTimeString()}
      </p>

      {cancellationDialog}
    </>
  );
}

export default function TasksPage() {
  const { tasks, loading, error, warning, lastRefresh, fetchTasks, applyPortalJobReadback, refreshMs } = useTasksData();

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain bg-theme-bg">
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
              type="button"
              onClick={() => { void fetchTasks(); }}
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
          warning={warning}
          fetchTasks={fetchTasks}
          applyPortalJobReadback={applyPortalJobReadback}
          lastRefresh={lastRefresh}
          refreshMs={refreshMs}
        />
      </div>
    </div>
  );
}

export function TasksContent({ agentId: _agentId, showHeader = false }: { agentId?: string; showHeader?: boolean }) {
  const { tasks, loading, error, warning, lastRefresh, fetchTasks, applyPortalJobReadback, refreshMs } = useTasksData();

  return (
    <div className="min-h-0 h-full overflow-y-auto pr-1 space-y-6">
      {showHeader ? (
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Background Tasks</h2>
            <p className="text-xs text-slate-400">Auto refresh every {Math.round(refreshMs / 1000)}s</p>
          </div>
          <button
            type="button"
            onClick={() => { void fetchTasks(); }}
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
        warning={warning}
        fetchTasks={fetchTasks}
        applyPortalJobReadback={applyPortalJobReadback}
        lastRefresh={lastRefresh}
        refreshMs={refreshMs}
      />
    </div>
  );
}
