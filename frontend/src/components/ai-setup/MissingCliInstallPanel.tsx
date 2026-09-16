import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { agentJobsAPI } from '../../api/agentJobs';
import {
  agentToolsAPI,
  toolInstallConfirmationPhrase,
  waitForToolInstallJob,
  type AgentTool,
} from '../../api/agentTools';
import {
  clearRetainedCliInstall,
  describeCliInstallAvailability,
  readRetainedCliInstall,
  retainCliInstall,
} from './cliInstallContract';

interface MissingCliInstallPanelProps {
  toolId: string;
  /** Inventory row from `GET /api/agent-tools`; `null` when the inventory has no such tool. */
  tool: AgentTool | null;
  /** Called with the refreshed inventory after the install was verified, or after a status refresh. */
  onInventory?: (tools: AgentTool[]) => void;
  /** Short sentence saying why this sign-in needs the CLI. */
  purpose?: string;
  /** Disable the action while the parent is busy with something else. */
  disabled?: boolean;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; jobId: string; startedAt: string }
  | { kind: 'verifying'; jobId: string }
  | { kind: 'installed'; version: string | null }
  | { kind: 'failed'; message: string; jobId: string | null; retryable: boolean }
  | { kind: 'lost'; message: string };

const START_TIMEOUT_MS = 15_000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const STATUS_TIMEOUT_MS = 10_000;
const TASKS_URL = '/agent-tools?tab=tasks';

function formatElapsed(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return '';
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function serverMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: unknown; code?: unknown } } })?.response?.data;
  const text = typeof data?.error === 'string' && data.error.trim() ? data.error.trim() : null;
  const code = typeof data?.code === 'string' && data.code.trim() ? ` (${data.code.trim()})` : '';
  if (text) return `${text}${code}`;
  const message = (error as { message?: unknown })?.message;
  return typeof message === 'string' && message.trim() ? message.trim() : fallback;
}

/**
 * Offers a first-time install of a missing host CLI from inside a sign-in
 * dialog: one click starts the server's retained install job, progress stays
 * visible here (and under Agent Tools → Tasks), the inventory is refreshed
 * when the job ends, and only a fresh inventory that reports the CLI as
 * installed is called success. Nothing here touches logins, models, or the
 * default model, and no request is ever re-sent automatically.
 */
export default function MissingCliInstallPanel({ toolId, tool, onInventory, purpose, disabled = false }: MissingCliInstallPanelProps) {
  const availability = describeCliInstallAvailability(tool);
  const name = tool?.name || toolId;
  const [phase, setPhase] = useState<Phase>(() => {
    const retained = readRetainedCliInstall(toolId);
    return retained ? { kind: 'waiting', jobId: retained.jobId, startedAt: retained.startedAt } : { kind: 'idle' };
  });
  const [now, setNow] = useState(() => Date.now());
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (phase.kind !== 'waiting') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [phase.kind]);

  const verify = useCallback(async (jobId: string) => {
    setPhase({ kind: 'verifying', jobId });
    const inventory = await agentToolsAPI.list(true, { timeoutMs: STATUS_TIMEOUT_MS });
    const tools = Array.isArray(inventory.tools) ? inventory.tools : [];
    if (!mountedRef.current) return;
    onInventory?.(tools);
    const refreshed = tools.find((entry) => entry.id === toolId);
    if (refreshed?.status.installed) {
      clearRetainedCliInstall(toolId);
      setPhase({ kind: 'installed', version: refreshed.status.version });
      return;
    }
    clearRetainedCliInstall(toolId);
    setPhase({
      kind: 'failed',
      message: `The installation finished, but the refreshed server inventory still does not show ${name} as installed.`,
      jobId,
      retryable: true,
    });
  }, [name, onInventory, toolId]);

  const watch = useCallback(async (jobId: string) => {
    try {
      await waitForToolInstallJob(jobId, { timeoutMs: JOB_TIMEOUT_MS, requestTimeoutMs: STATUS_TIMEOUT_MS });
      if (!mountedRef.current) return;
      await verify(jobId);
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      const terminal = (error as { code?: string; terminalStatus?: string });
      if (terminal?.code === 'TOOL_INSTALL_JOB_TERMINAL') {
        clearRetainedCliInstall(toolId);
        setPhase({
          kind: 'failed',
          message: terminal.terminalStatus === 'killed'
            ? `The ${name} installation was stopped before it finished. Check its status before retrying.`
            : `The ${name} installation did not complete. Open the log to see what the installer reported.`,
          jobId,
          retryable: true,
        });
        return;
      }
      setPhase({
        kind: 'lost',
        message: serverMessage(error, `Portal lost contact while the ${name} installation was running. It may still be running on the server.`),
      });
    } finally {
      busyRef.current = false;
    }
  }, [name, toolId, verify]);

  // Resume watching a job retained across a reload instead of starting another.
  useEffect(() => {
    if (phase.kind !== 'waiting' || busyRef.current) return;
    busyRef.current = true;
    void watch(phase.jobId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = async () => {
    if (busyRef.current || disabled) return;
    busyRef.current = true;
    setPhase({ kind: 'starting' });
    let started: { jobId: string } | null = null;
    try {
      started = await agentToolsAPI.install(toolId, toolInstallConfirmationPhrase(toolId), { timeoutMs: START_TIMEOUT_MS });
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      busyRef.current = false;
      const response = (error as { response?: { status?: number } })?.response;
      if (!response) {
        // No HTTP answer: the server may or may not have started the job.
        // Never send the request again; check the retained job list instead.
        setPhase({
          kind: 'lost',
          message: `Portal did not get a reply after asking the server to install ${name}. The installation may have started anyway.`,
        });
        return;
      }
      setPhase({ kind: 'failed', message: serverMessage(error, `The server did not start the ${name} installation.`), jobId: null, retryable: response.status !== 409 });
      return;
    }
    if (!mountedRef.current) return;
    if (!started?.jobId) {
      busyRef.current = false;
      setPhase({ kind: 'lost', message: `The server accepted the ${name} installation but did not return a job to watch. Check Tasks before trying again.` });
      return;
    }
    const startedAt = new Date().toISOString();
    retainCliInstall({ toolId, jobId: started.jobId, startedAt });
    setPhase({ kind: 'waiting', jobId: started.jobId, startedAt });
    await watch(started.jobId);
  };

  /** After a lost response: find the retained job for this tool, or refresh the inventory. No new install request. */
  const checkStatus = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const jobs = await agentJobsAPI.list({ timeoutMs: STATUS_TIMEOUT_MS });
      const retained = jobs
        .filter((job) => job.toolId === `_install:${toolId}`)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      if (!mountedRef.current) return;
      if (retained && (retained.status === 'running' || retained.status === 'completed')) {
        const startedAt = retained.startedAt || retained.createdAt;
        retainCliInstall({ toolId, jobId: retained.id, startedAt });
        setPhase({ kind: 'waiting', jobId: retained.id, startedAt });
        await watch(retained.id);
        return;
      }
      busyRef.current = false;
      await verify(retained?.id || '');
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      busyRef.current = false;
      setPhase({ kind: 'lost', message: serverMessage(error, `Portal could not check the ${name} installation status. Try again in a moment.`) });
    }
  };

  const refresh = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const inventory = await agentToolsAPI.list(true, { timeoutMs: STATUS_TIMEOUT_MS });
      if (!mountedRef.current) return;
      const tools = Array.isArray(inventory.tools) ? inventory.tools : [];
      onInventory?.(tools);
      const refreshed = tools.find((entry) => entry.id === toolId);
      setPhase(refreshed?.status.installed ? { kind: 'installed', version: refreshed.status.version } : { kind: 'idle' });
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      setPhase({ kind: 'failed', message: serverMessage(error, 'Portal could not refresh the server tool inventory.'), jobId: null, retryable: false });
    } finally {
      busyRef.current = false;
    }
  };

  if (phase.kind === 'installed') {
    return (
      <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100" data-testid={`cli-install-${toolId}`}>
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{name} is installed{phase.version ? ` (${phase.version})` : ''}. Continue to sign in below.</span>
      </div>
    );
  }

  if (availability.kind === 'installed' && phase.kind === 'idle') return null;

  const running = phase.kind === 'starting' || phase.kind === 'waiting' || phase.kind === 'verifying';

  return (
    <div className="space-y-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-50" data-testid={`cli-install-${toolId}`}>
      <div>
        <div className="font-medium">{availability.kind === 'missing' ? `${name} is not installed on this server yet.` : `Check ${name} installation`}</div>
        <p className="mt-1 text-amber-100/80">
          {purpose || `Sign-in needs ${name} on the server.`} Installing it here changes nothing about your logins, models, or the default model.
        </p>
      </div>

      {availability.kind === 'missing' && !availability.installable && !running && phase.kind === 'idle' ? (
        <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-100">{availability.reason}</div>
      ) : null}
      {availability.kind === 'unverified' && !running && phase.kind === 'idle' ? (
        <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-100">{availability.reason}</div>
      ) : null}

      {phase.kind === 'starting' ? (
        <div role="status" className="flex items-center gap-2 text-amber-100">
          <Loader2 className="h-4 w-4 animate-spin" />
          Asking the server to install {name}…
        </div>
      ) : null}
      {phase.kind === 'waiting' ? (
        <div role="status" className="flex flex-wrap items-center gap-2 text-amber-100">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Installing {name}… {formatElapsed(phase.startedAt, now)}</span>
          <a href={TASKS_URL} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-sky-200 underline decoration-sky-400/40">
            View progress <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      ) : null}
      {phase.kind === 'verifying' ? (
        <div role="status" className="flex items-center gap-2 text-amber-100">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking that {name} is installed…
        </div>
      ) : null}

      {phase.kind === 'failed' ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-red-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {phase.message}
            {phase.jobId ? (
              <>
                {' '}
                <a href={TASKS_URL} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-sky-200 underline decoration-sky-400/40">
                  Open the log <ExternalLink className="h-3 w-3" />
                </a>
              </>
            ) : null}
          </span>
        </div>
      ) : null}
      {phase.kind === 'lost' ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-red-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{phase.message} Portal will not send the request again by itself; check the status first.</span>
        </div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        {phase.kind === 'lost' ? (
          <button
            type="button"
            onClick={() => void checkStatus()}
            className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-3 py-2 text-sm font-medium text-slate-950 transition hover:bg-amber-400"
          >
            <RefreshCw className="h-4 w-4" />
            Check status
          </button>
        ) : null}
        {(phase.kind === 'idle' && (availability.kind !== 'missing' || !availability.installable)) || (phase.kind === 'failed' && !phase.retryable) ? (
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center gap-2 rounded-xl border border-amber-400/40 bg-transparent px-3 py-2 text-sm text-amber-100 transition hover:bg-amber-500/10"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        ) : null}
        {(phase.kind === 'idle' && availability.kind === 'missing' && availability.installable) || (phase.kind === 'failed' && phase.retryable) ? (
          <button
            type="button"
            onClick={() => void install()}
            disabled={disabled}
            className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-3 py-2 text-sm font-medium text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            {phase.kind === 'failed' ? `Try installing ${name} again` : `Install ${name}`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
