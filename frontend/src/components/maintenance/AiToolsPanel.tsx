import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Loader2, RefreshCw } from 'lucide-react';
import {
  maintenanceToolsAPI,
  type ToolStatusItem,
  type ToolsRunBody,
  type ToolsStatus,
} from '../../api/maintenanceTools';
import TypedConfirmationDialog from '../TypedConfirmationDialog';
import AiToolCard, { type ToolCardRequest } from './AiToolCard';
import AiToolsRunProgress from './AiToolsRunProgress';
import AiToolsHistory from './AiToolsHistory';
import OpenClawUpdateConsent from './OpenClawUpdateConsent';
import type { ToolNextAction } from './AiToolRunResult';
import { TOOL_TONE_CLASSES, formatAge, openClawPreflightFresh, toolConfirmNotice, type ToolTone } from './toolsPresentation';

export const OPENCLAW_UPDATE_PHRASE = 'UPDATE OPENCLAW';
/** While a run is active its progress comes from cheap status files; poll often. */
export const ACTIVE_RUN_POLL_MS = 3_000;

const SUMMARY_TONE: Record<ToolsStatus['summary']['status'], ToolTone> = {
  ok: 'good',
  attention: 'attention',
  blocked: 'bad',
  'recovery-required': 'bad',
};

const BUTTON = 'inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-theme-border-strong bg-theme-surface-strong px-3 py-2 text-xs font-medium text-theme-text transition hover:bg-theme-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current disabled:cursor-not-allowed disabled:opacity-50';

/** newestAccepted: the owner's per-run opt-in to a release this Portal has not tested (DESIGN i.3). */
type PendingUpdate = {
  tool: ToolStatusItem; target: 'recommended' | 'newest'; nodeRuntime: boolean; newestAccepted: boolean;
  /** Install a missing tool (its recommended version) instead of updating it. */
  install?: boolean;
};

const NEWEST_ASSURANCE = 'Update to newest installs a release this Portal has not tested. Assurance moves from “this Portal tested these bytes” to “the official publisher produced them”: the download is checked only against what the publisher provides.';

function errorText(error: any, fallback: string): string {
  const message = error?.response?.data?.error || error?.message;
  return typeof message === 'string' && message.trim() ? message.trim().slice(0, 600) : fallback;
}

export default function AiToolsPanel({
  owner,
  currentUserId = null,
  backup,
  onCreateBackup,
}: {
  owner: boolean;
  currentUserId?: string | null;
  backup?: { createdAt: string; ageHours: number } | null;
  onCreateBackup?: () => void;
}) {
  const [status, setStatus] = useState<ToolsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [channel, setChannel] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingUpdate | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [maintenanceWindow, setMaintenanceWindow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ tone: ToolTone; text: string } | null>(null);
  const [repairPending, setRepairPending] = useState(false);
  const [stopPending, setStopPending] = useState<{ runId: string; label: string; noun: 'update' | 'installation' } | null>(null);
  const sequenceRef = useRef(0);

  const load = useCallback(async (force = false) => {
    const sequence = ++sequenceRef.current;
    try {
      const next = await maintenanceToolsAPI.getStatus(force);
      if (sequence !== sequenceRef.current) return;
      setStatus(next);
      setLoadError(null);
    } catch (error) {
      if (sequence === sequenceRef.current) setLoadError(errorText(error, 'AI tools status could not be read.'));
    } finally {
      if (sequence === sequenceRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const activeRunId = status?.activeRun?.runId || null;
  useEffect(() => {
    if (!activeRunId) return;
    const timer = window.setInterval(() => { void load(); }, ACTIVE_RUN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [activeRunId, load]);

  const start = useCallback(async (body: ToolsRunBody, startedText: string, inDialog = false): Promise<boolean> => {
    setSubmitting(true);
    setNotice(null);
    try {
      await maintenanceToolsAPI.startRun(body);
      setNotice({ tone: 'progress', text: startedText });
      await load(true);
      return true;
    } catch (error) {
      // The server's refusal is shown verbatim: it names the reason and what to do next. Once: in the open
      // dialog when one asked for the run, otherwise on the page, never both.
      const text = errorText(error, 'The run could not be started. Nothing was changed.');
      if (inDialog) setDialogError(text);
      else setNotice({ tone: 'bad', text });
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [load]);

  const onRequest = useCallback((request: ToolCardRequest) => {
    if (!owner) return;
    setDialogError(null);
    if (request.kind === 'requalify') {
      void start({ tool: request.tool.id, action: 'requalify' }, `Re-checking ${request.tool.label}. Nothing is installed.`);
      return;
    }
    if (request.kind === 'preflight') {
      void start({ tool: request.tool.id, action: 'preflight', channel }, `Checking whether ${request.tool.label} can update. Nothing is changed.`);
      return;
    }
    setMaintenanceWindow(false);
    if (request.kind === 'install') {
      setPending({ tool: request.tool, target: 'recommended', nodeRuntime: false, newestAccepted: false, install: true });
      return;
    }
    // N2: the review states whether chat stays up only from a fresh passing pre-flight; without one, run it first.
    if (request.tool.restartsGateway && !openClawPreflightFresh(request.tool)) {
      void start({ tool: request.tool.id, action: 'preflight', channel },
        `Checking whether ${request.tool.label} can update first, so the review can say whether chat stays up. `
        + 'Nothing is changed. When the check passes, choose the update again.');
      return;
    }
    setPending({ tool: request.tool, target: request.target, nodeRuntime: false, newestAccepted: false });
  }, [channel, owner, start]);

  const startReconcile = useCallback(async () => {
    setSubmitting(true);
    setNotice(null);
    try {
      await maintenanceToolsAPI.startReconcile();
      setNotice({ tone: 'progress', text: 'Checking the interrupted update. The result appears here when the check finishes.' });
      await load(true);
    } catch (error) {
      setNotice({ tone: 'bad', text: errorText(error, 'The check could not be started. Nothing was changed.') });
    } finally {
      setSubmitting(false);
    }
  }, [load]);

  const confirmStop = useCallback(async () => {
    if (!stopPending || submitting) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await maintenanceToolsAPI.stopRun(stopPending.runId);
      setStopPending(null);
      setNotice({ tone: 'progress', text: `Stop requested. The ${stopPending.label} ${stopPending.noun} stops at its next safe point; the result appears here.` });
      await load(true);
    } catch (error) {
      // The server's refusal says why (e.g. a step that must not be interrupted) and that nothing was stopped.
      const text = errorText(error, 'The stop request could not be sent. Nothing was stopped.');
      setNotice({ tone: 'bad', text });
      setDialogError(text);
    } finally {
      setSubmitting(false);
    }
  }, [load, stopPending, submitting]);

  const onNextAction = useCallback((tool: ToolStatusItem, action: ToolNextAction) => {
    if (!owner) return;
    setDialogError(null);
    if (action === 'retry-checks') {
      void start({ tool: tool.id, action: 'retry-checks' }, `Checking ${tool.label}'s Portal features again. Nothing is installed.`);
    } else if (action === 'recover-native') {
      setRepairPending(true);
    } else {
      setMaintenanceWindow(false);
      setPending({ tool, target: 'recommended', nodeRuntime: true, newestAccepted: false });
    }
  }, [owner, start]);

  const confirmUpdate = useCallback(async (confirmation: string) => {
    if (!pending || submitting) return;
    if (pending.install) {
      const installed = await start({ tool: pending.tool.id, action: 'install', target: 'recommended', confirmed: true },
        `${pending.tool.label} installation started. It continues on the server if you leave this page.`, true);
      if (installed) setPending(null);
      return;
    }
    const core = pending.tool.restartsGateway;
    if (pending.target === 'newest' && !pending.newestAccepted) {
      setDialogError('Tick the box to accept a release this Portal has not tested, or cancel.');
      return;
    }
    if (core && !maintenanceWindow) {
      setDialogError('Confirm that this is a good time for the OpenClaw restart before starting.');
      return;
    }
    const body: ToolsRunBody = core
      ? {
        tool: pending.tool.id, action: 'update', target: pending.target, channel, confirmation, maintenanceWindowAcknowledged: true,
        ...(pending.nodeRuntime ? { acknowledgements: { nodeRuntime: true } } : {}),
      }
      : { tool: pending.tool.id, action: 'update', target: pending.target, confirmed: true };
    const ok = await start(body, `${pending.tool.label} update started. It continues on the server if you leave this page.`, true);
    if (ok) setPending(null);
  }, [channel, maintenanceWindow, pending, start, submitting]);

  if (loading && !status) {
    return (
      <section aria-labelledby="ai-tools-heading" className="rounded-xl border border-theme-border bg-theme-surface p-4">
        <h2 id="ai-tools-heading" className="text-sm font-semibold text-theme-text">AI tools</h2>
        <p aria-live="polite" aria-busy="true" className="mt-2 flex items-center gap-2 text-sm text-theme-text-muted">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Checking AI tools…
        </p>
      </section>
    );
  }

  const tools = status?.tools || [];
  // A missing tool this Portal can install gets its card (Install, its result); the others are listed by name.
  const installedTools = tools.filter((tool) => tool.status !== 'not-installed' || Boolean(tool.installVersion));
  const missingTools = tools.filter((tool) => tool.status === 'not-installed' && !tool.installVersion);
  const recovery = status?.recovery || null;
  // The recovery's own action, when this page can start it for the Owner: a run the server offers for the
  // recovery's tool (OpenClaw repair, another tool's Re-check), or the check of a run whose runner is gone.
  const recoveryTool = recovery
    ? tools.find((tool) => tool.id === (recovery.tool || (recovery.action.id === 'recover-native' ? 'openclaw' : null)))
    : undefined;
  const reconcileOffered = recovery?.action.id === 'reconcile-tools-run' && Boolean(status?.runner.installed);
  const recoveryOffered = Boolean(recovery && owner && (reconcileOffered
    || recoveryTool?.runActions.some((action) => action === recovery.action.id)));
  const channels = status?.policy.channels || [];
  const selectedChannel = channel || status?.policy.defaultChannel || null;
  const busy = submitting || Boolean(status?.activeRun);
  const onRecoveryAction = () => {
    if (!recovery) return;
    setDialogError(null);
    if (reconcileOffered) void startReconcile();
    else if (recovery.action.id === 'recover-native') setRepairPending(true);
    else if (recoveryTool && recovery.action.id === 'requalify') onRequest({ kind: 'requalify', tool: recoveryTool });
    // OpenClaw is running again after a refused rollback: its checks are the one action.
    else if (recoveryTool && recovery.action.id === 'retry-checks') onNextAction(recoveryTool, 'retry-checks');
  };

  return (
    <section aria-labelledby="ai-tools-heading" className="space-y-3 rounded-xl border border-theme-border bg-theme-surface p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Bot size={17} aria-hidden="true" className="text-theme-text-muted" />
            <h2 id="ai-tools-heading" className="text-sm font-semibold text-theme-text">AI tools</h2>
          </div>
          {status && (
            <p aria-live="polite" data-testid="ai-tools-summary"
              className={`mt-2 rounded-lg border px-3 py-2 text-sm ${TOOL_TONE_CLASSES[SUMMARY_TONE[status.summary.status]]}`}>
              {status.summary.text}
            </p>
          )}
        </div>
        <button type="button" className={BUTTON} onClick={() => { void load(true); }} disabled={loading}>
          <RefreshCw size={14} aria-hidden="true" /> Check AI tools again
        </button>
      </div>

      {loadError && (
        <p role="alert" className={`rounded-lg border px-3 py-2 text-xs ${TOOL_TONE_CLASSES.bad}`}>
          {loadError}{status ? ' The last result stays visible.' : ''}
        </p>
      )}

      {recovery && (
        <div role="alert" className={`rounded-lg border px-3 py-3 text-xs leading-5 ${TOOL_TONE_CLASSES.bad}`}>
          <p className="text-sm font-semibold">{recovery.title}</p>
          <p className="mt-1">{recovery.detail}</p>
          <p className="mt-1">No update is offered until this is resolved.</p>
          {recoveryOffered ? (
            <button
              type="button"
              className={`${BUTTON} mt-2`}
              // The interrupted run is still listed as active (its runner is gone), so only a pending request disables its check.
              disabled={reconcileOffered ? submitting : busy}
              onClick={onRecoveryAction}
            >
              {recovery.action.label}
            </button>
          ) : (
            <p className="mt-2 text-theme-text-muted">
              Next step: {recovery.action.label}.{owner ? '' : ' Ask the Owner to do this.'}
            </p>
          )}
        </div>
      )}

      {status && !status.runner.installed && (
        <p className={`rounded-lg border px-3 py-2 text-xs leading-5 ${TOOL_TONE_CLASSES.neutral}`}>
          {status.runner.reason} On this server, AI tools are still updated together with Update Compatible AI Tools below; these cards are for reading only.
        </p>
      )}

      {status && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-theme-text-muted">
          <span>
            {backup
              ? `Latest maintenance backup: ${formatAge(backup.createdAt) || `${backup.ageHours} h`} old.`
              : 'No verified maintenance backup yet. The OpenClaw update needs one.'}
          </span>
          {owner && onCreateBackup && (
            <button type="button" className={BUTTON} onClick={onCreateBackup} disabled={busy}>Create backup</button>
          )}
          {owner && status.runner.installed && channels.length > 1 && (
            <label className="flex items-center gap-2">
              <span>OpenClaw channel</span>
              <select
                value={selectedChannel || ''}
                onChange={(event) => setChannel(event.target.value)}
                className="min-h-[40px] rounded-lg border border-theme-border bg-theme-surface-raised px-2 text-xs text-theme-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-current"
              >
                {channels.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          )}
        </div>
      )}

      {status?.activeRun && !status.activeRun.stale && (
        <AiToolsRunProgress
          run={status.activeRun}
          toolLabel={tools.find((tool) => tool.id === status.activeRun?.tool)?.label || status.activeRun.tool}
          owner={owner && status.runner.installed}
          busy={submitting}
          onStop={() => {
            const run = status.activeRun;
            if (!run || run.stopRefusal) return;
            setDialogError(null);
            setStopPending({
              runId: run.runId,
              label: tools.find((tool) => tool.id === run.tool)?.label || run.tool,
              noun: run.action === 'install' ? 'installation' : 'update',
            });
          }}
        />
      )}

      {notice && (
        <p role={notice.tone === 'bad' ? 'alert' : 'status'} className={`rounded-lg border px-3 py-2 text-xs ${TOOL_TONE_CLASSES[notice.tone]}`}>
          {notice.text}
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {installedTools.map((tool) => (
          <AiToolCard key={tool.id} tool={tool} owner={owner} busy={busy} recoveryOpen={Boolean(recovery)} onRequest={onRequest} onNextAction={onNextAction} />
        ))}
      </div>
      {missingTools.length > 0 && (
        <p className="text-[11px] text-theme-text-muted">Not installed on this server: {missingTools.map((tool) => tool.label).join(', ')}.</p>
      )}

      {status && (
        <AiToolsHistory
          history={status.history}
          toolLabels={Object.fromEntries(tools.map((tool) => [tool.id, tool.label]))}
          owner={owner}
          currentUserId={currentUserId}
        />
      )}

      <TypedConfirmationDialog
        open={Boolean(stopPending)}
        title={stopPending ? `Stop the ${stopPending.label} ${stopPending.noun}` : 'Stop the update'}
        description={`The ${stopPending?.noun || 'update'} stops at its next safe point. The result on this page then says what changed and what to do next.`}
        confirmLabel={`Stop this ${stopPending?.noun || 'update'}`}
        busyLabel="Stopping…"
        busy={submitting}
        tone="warning"
        onCancel={() => { if (!submitting) { setStopPending(null); setDialogError(null); } }}
        onConfirm={() => { void confirmStop(); }}
        details={dialogError ? <p role="alert" className={`rounded-lg border px-3 py-2 text-xs ${TOOL_TONE_CLASSES.bad}`}>{dialogError}</p> : null}
      />

      <TypedConfirmationDialog
        open={repairPending}
        title="Run OpenClaw repair"
        description="OpenClaw's own recovery finishes or safely undoes the interrupted update. No new version is installed."
        confirmLabel="Run OpenClaw repair"
        busyLabel="Starting…"
        busy={submitting}
        tone="warning"
        onCancel={() => { if (!submitting) { setRepairPending(false); setDialogError(null); } }}
        onConfirm={() => {
          void start({ tool: 'openclaw', action: 'recover-native', confirmed: true }, 'OpenClaw repair started. It continues on the server if you leave this page.', true)
            .then((ok) => { if (ok) setRepairPending(false); });
        }}
        details={(
          <div className="space-y-2 text-xs leading-5 text-theme-text">
            <p>The OpenClaw gateway is stopped for the whole repair, so chat is unavailable until it starts again at the end. The result and its report appear on this page.</p>
            {dialogError && <p role="alert" className={`rounded-lg border px-3 py-2 ${TOOL_TONE_CLASSES.bad}`}>{dialogError}</p>}
          </div>
        )}
      />

      <TypedConfirmationDialog
        open={Boolean(pending)}
        title={pending ? (pending.install ? `Install ${pending.tool.label}` : pending.tool.restartsGateway ? `Review the ${pending.tool.label} update` : `Update ${pending.tool.label}`) : 'Update'}
        description={pending
          ? (pending.install
            ? `${pending.tool.label} ${pending.tool.installVersion || pending.tool.recommended.version} will be installed on this server.`
            : `${pending.tool.label} will be updated to ${pending.target === 'recommended' ? pending.tool.recommended.version : 'the newest release (not yet tested by this Portal)'}.`)
          : ''}
        confirmationPhrase={pending?.tool.restartsGateway && !pending.install ? OPENCLAW_UPDATE_PHRASE : null}
        confirmLabel={pending ? `${pending.install ? 'Install' : 'Update'} ${pending.tool.label}` : 'Update'}
        confirmDisabled={Boolean(pending && pending.target === 'newest' && !pending.newestAccepted)}
        busyLabel="Starting…"
        busy={submitting}
        tone="warning"
        onCancel={() => { if (!submitting) { setPending(null); setDialogError(null); } }}
        onConfirm={(confirmation) => { void confirmUpdate(confirmation); }}
        details={pending ? (
          <div className="space-y-2 text-xs leading-5 text-theme-text">
            {pending.target === 'newest' && (
              <div data-testid="ai-tools-newest-opt-in" className={`space-y-2 rounded-lg border px-3 py-2 ${TOOL_TONE_CLASSES.attention}`}>
                <p>{NEWEST_ASSURANCE}</p>
                <label className="flex min-h-[44px] cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                    checked={pending.newestAccepted}
                    onChange={(event) => setPending((current) => (current ? { ...current, newestAccepted: event.target.checked } : current))}
                  />
                  <span>I want the newest release on the publisher&apos;s assurance, for this update only.</span>
                </label>
              </div>
            )}
            {pending.tool.restartsGateway && !pending.install ? (
              <OpenClawUpdateConsent
                tool={pending.tool}
                target={pending.target}
                channel={selectedChannel}
                backup={backup}
                nodeRuntime={pending.nodeRuntime}
                onNodeRuntimeChange={(value) => setPending((current) => (current ? { ...current, nodeRuntime: value } : current))}
                goodTime={maintenanceWindow}
                onGoodTimeChange={setMaintenanceWindow}
              />
            ) : (
              <p>{toolConfirmNotice(pending.tool, Boolean(pending.install))}</p>
            )}
            {dialogError && <p role="alert" className={`rounded-lg border px-3 py-2 ${TOOL_TONE_CLASSES.bad}`}>{dialogError}</p>}
          </div>
        ) : null}
      />
    </section>
  );
}
