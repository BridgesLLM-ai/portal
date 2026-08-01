import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Download,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Wrench,
  XCircle,
} from 'lucide-react';
import {
  agentToolsAPI,
  toolInstallConfirmationPhrase,
  waitForToolInstallJob,
  type AgentTool,
} from '../api/agentTools';
import TypedConfirmationDialog from '../components/TypedConfirmationDialog';
import ViewportModal from '../components/ViewportModal';

const TOOL_START_REQUEST_TIMEOUT_MS = 15_000;
const TOOL_STATUS_REQUEST_TIMEOUT_MS = 10_000;
const TOOL_INVENTORY_REQUEST_TIMEOUT_MS = 10_000;
const TOOL_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const INDETERMINATE_INSTALL_SESSION_KEY = 'bridgesllm.agentTools.indeterminateInstall.v1';

type InstallPhase = 'starting' | 'waiting' | 'verifying';

type InstallProof = Readonly<{
  toolId: string;
  jobId: string;
  baselineCheckedAt: string;
}>;

type IndeterminateInstallStart = Readonly<{
  toolId: string;
  toolName: string;
  message: string;
}>;

function readIndeterminateInstallStart(): IndeterminateInstallStart | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(INDETERMINATE_INSTALL_SESSION_KEY) || 'null');
    if (
      typeof parsed?.toolId === 'string'
      && typeof parsed?.toolName === 'string'
      && typeof parsed?.message === 'string'
    ) {
      return { toolId: parsed.toolId, toolName: parsed.toolName, message: parsed.message };
    }
  } catch {
    // Invalid browser state is ignored; no host mutation is inferred from it.
  }
  return null;
}

function retainIndeterminateInstallStart(value: IndeterminateInstallStart): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(INDETERMINATE_INSTALL_SESSION_KEY, JSON.stringify(value));
  } catch {
    // React state still keeps this page fail-closed when browser storage is unavailable.
  }
}

class IndeterminateInstallStartError extends Error {
  readonly code = 'TOOL_INSTALL_START_INDETERMINATE';
}

async function withToolRequestDeadline<T>(request: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function checkedAfterBaseline(checkedAt: string, baselineCheckedAt: string): boolean {
  if (!checkedAt || checkedAt === baselineCheckedAt) return false;
  const checkedMs = Date.parse(checkedAt);
  const baselineMs = Date.parse(baselineCheckedAt);
  if (Number.isFinite(checkedMs) && Number.isFinite(baselineMs)) return checkedMs > baselineMs;
  return true;
}

function attestInstalledTool(inventory: AgentTool[], proof: InstallProof): AgentTool {
  const target = inventory.find((tool) => tool.id === proof.toolId);
  if (!target) throw new Error('The refreshed host inventory no longer contains this tool. Verification was not completed.');
  if (!checkedAfterBaseline(target.status.checkedAt, proof.baselineCheckedAt)) {
    throw new Error('The host returned a stale tool inventory. Retry verification without starting another installation job.');
  }
  if (!target.status.installed || target.status.missing) {
    throw new Error('The installation job finished, but the refreshed host inventory does not attest that the tool is installed.');
  }
  return target;
}

function isTerminalInstallJobError(error: any): boolean {
  return error?.code === 'TOOL_INSTALL_JOB_TERMINAL'
    && (error?.terminalStatus === 'error' || error?.terminalStatus === 'killed');
}

function isIndeterminateInstallStart(error: any): boolean {
  return error?.code === 'TOOL_INSTALL_START_INDETERMINATE' || !error?.response;
}

function statusCopy(tool: AgentTool): { label: string; className: string; icon: typeof CheckCircle2 } {
  if (tool.status.installed) {
    return { label: tool.status.version ? `Ready · ${tool.status.version}` : 'Ready', className: 'text-emerald-300', icon: CheckCircle2 };
  }
  if (tool.status.missing) {
    return { label: 'Not installed', className: 'text-amber-300', icon: XCircle };
  }
  return { label: 'Verification failed', className: 'text-red-300', icon: AlertCircle };
}

export function ToolsContent({ showHeader = false }: { showHeader?: boolean }) {
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const [pendingTool, setPendingTool] = useState<AgentTool | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const installAdmissionRef = useRef<{ toolId: string; phase: InstallPhase } | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installPhase, setInstallPhase] = useState<InstallPhase | null>(null);
  const [installProof, setInstallProof] = useState<InstallProof | null>(null);
  const [indeterminateStart, setIndeterminateStart] = useState<IndeterminateInstallStart | null>(readIndeterminateInstallStart);
  const [reviewIndeterminateStart, setReviewIndeterminateStart] = useState(false);
  const indeterminateTitleId = useId();
  const indeterminateCloseRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);

  const loadTools = useCallback(async (refresh = false) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await agentToolsAPI.list(refresh);
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setTools(Array.isArray(data.tools) ? data.tools : []);
    } catch (loadError: any) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(loadError?.response?.data?.error || loadError?.message || 'Failed to inspect host tools');
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadTools();
    return () => { mountedRef.current = false; };
  }, [loadTools]);

  const installTool = async (confirmation: string) => {
    const tool = pendingTool;
    if (!tool || installAdmissionRef.current) return;
    const admission = { toolId: tool.id, phase: 'starting' as InstallPhase };
    installAdmissionRef.current = admission;
    setInstallingId(tool.id);
    setActivity(null);
    setInstallError(null);
    let proof = installProof?.toolId === tool.id ? installProof : null;
    try {
      if (!proof) {
        admission.phase = 'starting';
        setInstallPhase('starting');
        const started = await withToolRequestDeadline(
          agentToolsAPI.install(tool.id, confirmation, { timeoutMs: TOOL_START_REQUEST_TIMEOUT_MS }),
          TOOL_START_REQUEST_TIMEOUT_MS,
          'Timed out while starting the retained installation job. Check Tasks before trying again.',
        );
        if (!started?.jobId) {
          throw new IndeterminateInstallStartError('The installation request did not return a retained job identifier.');
        }
        proof = {
          toolId: tool.id,
          jobId: started.jobId,
          baselineCheckedAt: tool.status.checkedAt,
        };
        setInstallProof(proof);
      }

      admission.phase = 'waiting';
      setInstallPhase('waiting');
      await waitForToolInstallJob(proof.jobId, {
        timeoutMs: TOOL_JOB_TIMEOUT_MS,
        requestTimeoutMs: TOOL_STATUS_REQUEST_TIMEOUT_MS,
      });
      if (!mountedRef.current) return;

      admission.phase = 'verifying';
      setInstallPhase('verifying');
      const inventory = await withToolRequestDeadline(
        agentToolsAPI.list(true, { timeoutMs: TOOL_INVENTORY_REQUEST_TIMEOUT_MS }),
        TOOL_INVENTORY_REQUEST_TIMEOUT_MS,
        'Timed out while refreshing the host tool inventory. Retry verification without starting another installation job.',
      );
      const nextTools = Array.isArray(inventory.tools) ? inventory.tools : [];
      const attested = attestInstalledTool(nextTools, proof);
      if (!mountedRef.current) return;
      setTools(nextTools);
      setError(null);
      setActivity(`${tool.name} is installed${attested.status.version ? ` (${attested.status.version})` : ''} and was verified in a fresh host inventory.`);
      setInstallProof(null);
      setInstallError(null);
      setPendingTool(null);
    } catch (installError: any) {
      if (!mountedRef.current) return;
      const message = installError?.response?.data?.error || installError?.message || `${tool.name} failed. Inspect Tasks for retained output.`;
      setInstallError(message);
      if (proof && isTerminalInstallJobError(installError)) {
        proof = null;
        setInstallProof(null);
      } else if (proof) {
        setInstallProof(proof);
      } else if (isIndeterminateInstallStart(installError)) {
        const ambiguity = {
          toolId: tool.id,
          toolName: tool.name,
          message: `${message} Portal cannot prove whether the host admitted the request, so it will not submit another installation from this page. Inspect the retained Tasks inventory before taking further action.`,
        };
        retainIndeterminateInstallStart(ambiguity);
        setIndeterminateStart(ambiguity);
        setPendingTool(null);
        setReviewIndeterminateStart(true);
      }
      setActivity(message);
    } finally {
      if (installAdmissionRef.current === admission) installAdmissionRef.current = null;
      if (mountedRef.current) {
        setInstallingId(null);
        setInstallPhase(null);
      }
    }
  };

  const unresolvedToolId = installProof?.toolId || indeterminateStart?.toolId || null;
  const pendingHasProof = Boolean(pendingTool && installProof?.toolId === pendingTool.id);
  const busyLabel = installPhase === 'waiting'
    ? 'Waiting for host job…'
    : installPhase === 'verifying'
      ? 'Verifying fresh inventory…'
      : pendingTool?.status.installed
        ? 'Starting update…'
        : 'Starting install…';

  return (
    <div className="h-full min-h-0 overflow-y-auto pr-1">
      <div className="space-y-5 pb-8">
        {showHeader ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-xl font-bold text-white">Host Agent Tools</h1>
              <p className="mt-1 text-sm text-slate-400">Verified command-line runtimes used by host-operator Agent Chats.</p>
            </div>
            <button
              type="button"
              onClick={() => { void loadTools(true); }}
              disabled={loading || Boolean(installingId)}
              className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-sm text-slate-300 hover:bg-white/[0.08] hover:text-white disabled:opacity-50"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Recheck tools
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-end">
            <button
              type="button"
              aria-label="Recheck host agent tools"
              onClick={() => { void loadTools(true); }}
              disabled={loading || Boolean(installingId)}
              className="inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Recheck
            </button>
          </div>
        )}

        <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-sm leading-6 text-blue-100">
          <div className="flex items-start gap-2">
            <ShieldCheck size={17} className="mt-1 shrink-0 text-blue-300" />
            <p>
              This is a shared host inventory for the Owner and Sub Admins. Installation runs only reviewed Portal recipes as serialized, bounded jobs; arbitrary command execution belongs in Agent Chat or Terminal.
            </p>
          </div>
        </div>

        {activity ? <div role="status" className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-sm text-slate-300">{activity}</div> : null}

        {loading && tools.length === 0 ? (
          <div className="flex items-center justify-center py-20"><Loader2 size={30} className="animate-spin text-emerald-400" /></div>
        ) : error ? (
          <div role="alert" className="rounded-2xl border border-red-500/20 bg-red-500/10 p-6 text-center text-red-300">
            <AlertCircle size={28} className="mx-auto mb-2" />
            <p>{error}</p>
            <button type="button" onClick={() => { void loadTools(true); }} className="mt-4 min-h-[44px] rounded-xl bg-red-500/15 px-4 py-2 text-sm hover:bg-red-500/25">Try again</button>
          </div>
        ) : tools.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/[0.08] p-10 text-center text-slate-400">
            <Wrench size={36} className="mx-auto mb-3 text-slate-600" /> No host tools were reported.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {tools.map((tool) => {
              const status = statusCopy(tool);
              const StatusIcon = status.icon;
              const modalOwnsInstall = pendingTool?.id === tool.id;
              const installing = installingId === tool.id && !modalOwnsInstall;
              const requiresVerification = installProof?.toolId === tool.id;
              const requiresAdmissionReview = indeterminateStart?.toolId === tool.id;
              return (
                <article key={tool.id} className="flex min-w-0 flex-col rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-semibold text-white">{tool.name}</h2>
                      <div className={`mt-1 flex items-center gap-1.5 text-xs ${status.className}`}>
                        <StatusIcon size={13} /> {status.label}
                      </div>
                    </div>
                    <span className="rounded-full border border-white/[0.08] bg-black/20 px-2 py-1 text-[10px] uppercase tracking-wider text-slate-500">Tier {tool.tier}</span>
                  </div>
                  <p className="mt-3 flex-1 text-sm leading-6 text-slate-400">{tool.description}</p>
                  {tool.authRequired ? (
                    <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/15 bg-amber-500/8 px-3 py-2 text-xs leading-5 text-amber-100/80">
                      <KeyRound size={13} className="mt-1 shrink-0" /> {tool.authHint || 'Provider authentication is required before use.'}
                    </div>
                  ) : null}
                  <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
                    <span className="flex items-center gap-1 text-[11px] text-slate-500">
                      <Clock3 size={12} /> checked {new Date(tool.status.checkedAt).toLocaleTimeString()}
                    </span>
                    {tool.install.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (installAdmissionRef.current) return;
                          if (requiresAdmissionReview) {
                            setReviewIndeterminateStart(true);
                            return;
                          }
                          setInstallError(null);
                          setPendingTool(tool);
                        }}
                        disabled={Boolean(installingId) || Boolean(unresolvedToolId && !requiresVerification && !requiresAdmissionReview)}
                        aria-busy={installing}
                        className="inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                      >
                        {installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                        {installing
                          ? (installPhase === 'verifying' ? 'Verifying…' : tool.status.installed ? 'Updating…' : 'Installing…')
                          : requiresVerification
                            ? 'Verify install'
                            : requiresAdmissionReview
                              ? 'Review admission'
                            : tool.status.installed ? 'Update' : 'Install'}
                      </button>
                    ) : (
                      <span className="text-right text-[11px] text-slate-500">Managed by its dedicated setup or updater</span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <TypedConfirmationDialog
        open={pendingTool !== null}
        title={`${pendingTool?.status.installed ? 'Update' : 'Install'} ${pendingTool?.name || 'tool'}`}
        description="This changes a host-wide command-line runtime. Portal serializes the operation, limits it to 30 minutes, and retains the transcript under Tasks."
        confirmationPhrase={pendingTool ? toolInstallConfirmationPhrase(pendingTool.id) : null}
        confirmLabel={pendingHasProof ? 'Retry verification' : pendingTool?.status.installed ? 'Start update' : 'Start install'}
        busyLabel={busyLabel}
        busy={Boolean(pendingTool && installingId === pendingTool.id)}
        onCancel={() => {
          if (installAdmissionRef.current) return;
          setInstallError(null);
          setPendingTool(null);
        }}
        onConfirm={(confirmation) => { void installTool(confirmation); }}
        details={installError ? (
          <div role="alert" className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {installError}
          </div>
        ) : null}
      />
      <ViewportModal
        open={Boolean(indeterminateStart && reviewIndeterminateStart)}
        onDismiss={() => setReviewIndeterminateStart(false)}
        initialFocusRef={indeterminateCloseRef}
        className="bg-black/75 px-4 py-6 backdrop-blur-sm"
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={indeterminateTitleId}
          className="w-full max-w-xl rounded-2xl border border-amber-500/25 bg-theme-surface p-5 text-theme-text shadow-2xl shadow-black/50"
        >
          <div className="flex items-start gap-3">
            <AlertCircle size={20} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <h2 id={indeterminateTitleId} className="text-base font-semibold">
                {indeterminateStart?.toolName || 'Tool'} install admission is unresolved
              </h2>
              <p role="alert" className="mt-2 text-sm leading-6 text-theme-text-muted">
                {indeterminateStart?.message}
              </p>
            </div>
          </div>
          <div className="mt-5 flex justify-end">
            <button
              ref={indeterminateCloseRef}
              type="button"
              onClick={() => setReviewIndeterminateStart(false)}
              className="min-h-[44px] rounded-xl border border-theme-border bg-theme-bg px-4 py-2 text-sm font-medium text-theme-text transition hover:bg-theme-surface-hover"
            >
              Close
            </button>
          </div>
        </div>
      </ViewportModal>
    </div>
  );
}

export default function ToolsPage() {
  return <ToolsContent showHeader />;
}
