import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Loader2, PlugZap, RefreshCw, Wrench } from 'lucide-react';
import client from '../../api/client';
import { useAuthStore } from '../../contexts/AuthContext';
import { isOwner } from '../../utils/authz';
import TypedConfirmationDialog from '../TypedConfirmationDialog';
import { useSettingsMutationCoordinator } from './SettingsMutationContext';

type ReadinessStatus = 'ready' | 'partial' | 'missing' | 'not_configured';

type ReadinessCheck = {
  id: string;
  label: string;
  type: 'command' | 'path' | 'http' | 'config';
  required: boolean;
  ok: boolean;
  message: string;
  remediation: string;
};

type RemediationAction = {
  id: string;
  label: string;
  endpoint: string;
  method: 'POST';
  ownerOnly: true;
  confirmationPhrase: string;
  impact: string;
};

type FeatureReadiness = {
  id: string;
  label: string;
  status: ReadinessStatus;
  applicable: boolean;
  note?: string;
  checks: ReadinessCheck[];
  remediationAction?: RemediationAction;
};

type ReadinessResponse = {
  ready?: boolean;
  checkedAt?: string | null;
  cached?: boolean;
  refreshing?: boolean;
  settingsChanged?: boolean;
  refreshError?: string | null;
  overall: ReadinessStatus;
  features: FeatureReadiness[];
  suggestedNextActions: string[];
};

type AutoSetupResult = {
  featureId: string;
  ok: boolean;
  steps: Array<{ step: string; ok: boolean; message: string }>;
  message: string;
};

type CommittedAutoSetup = Readonly<{
  featureId: string;
  result: AutoSetupResult;
}>;

const featureDestination: Record<string, string> = {
  agentTools: '/agent-tools',
  remoteDesktop: '/desktop',
  terminal: '/terminal',
  fileManager: '/files',
  ollamaLocal: '/settings?tab=ai-providers',
  ollamaRemote: '/settings?tab=ai-providers',
  core: '/admin?tab=maintenance',
};

const FORCED_READINESS_POLL_MS = 250;
const FORCED_READINESS_REQUEST_TIMEOUT_MS = 2_500;
const FORCED_READINESS_DEADLINE_MS = 10_000;

function statusTone(status: ReadinessStatus): string {
  if (status === 'ready') return 'border-emerald-500/20 bg-emerald-500/15 text-emerald-300';
  if (status === 'partial') return 'border-amber-500/20 bg-amber-500/15 text-amber-200';
  if (status === 'not_configured') return 'border-slate-500/20 bg-slate-500/10 text-slate-300';
  return 'border-red-500/20 bg-red-500/15 text-red-300';
}

function statusLabel(status: ReadinessStatus): string {
  if (status === 'not_configured') return 'Optional · not configured';
  return status.replace('_', ' ');
}

function freshReadinessFailure(snapshot: ReadinessResponse, featureId: string): string | null {
  if (snapshot.ready === false || snapshot.refreshing) {
    return 'the forced readiness response is still refreshing';
  }
  if (snapshot.settingsChanged) return 'the forced readiness response predates the latest settings';
  if (!snapshot.checkedAt) return 'the forced readiness response has no freshness timestamp';
  const target = snapshot.features.find((feature) => feature.id === featureId);
  if (!target) return 'the forced readiness response omitted the target feature';
  if (target.status !== 'ready') {
    return `the target feature still reports ${statusLabel(target.status)}`;
  }
  return null;
}

export default function FeatureReadinessPanel() {
  const settingsMutation = useSettingsMutationCoordinator();
  const settingsClaim = settingsMutation?.claim;
  const settingsRelease = settingsMutation?.release;
  const { user } = useAuthStore();
  const owner = isOwner(user);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ReadinessResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<{ feature: FeatureReadiness; action: RemediationAction } | null>(null);
  const [autoSetupRunning, setAutoSetupRunning] = useState(false);
  const [autoSetupResult, setAutoSetupResult] = useState<AutoSetupResult | null>(null);
  const [autoSetupError, setAutoSetupError] = useState<string | null>(null);
  const [committedAutoSetup, setCommittedAutoSetup] = useState<CommittedAutoSetup | null>(null);
  const autoSetupAdmissionRef = useRef(false);
  const settingsMutationOwnerRef = useRef<string | null>(null);
  const committedAutoSetupRef = useRef<CommittedAutoSetup | null>(null);
  const latestReadinessRef = useRef<ReadinessResponse | null>(null);

  const load = useCallback(async (force = false, failClosed = false): Promise<ReadinessResponse | null> => {
    setLoading(true);
    try {
      const previousCheckedAt = latestReadinessRef.current?.checkedAt || null;
      const deadlineAt = Date.now() + FORCED_READINESS_DEADLINE_MS;
      const requestWithinDeadline = (refresh: boolean) => {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          throw new Error('Fresh readiness refresh did not converge before the verification deadline.');
        }
        return client.get<ReadinessResponse>('/system/readiness', {
          ...(refresh ? { params: { refresh: true } } : {}),
          timeout: Math.max(1, Math.min(FORCED_READINESS_REQUEST_TIMEOUT_MS, remainingMs)),
        });
      };
      let response = force
        ? await requestWithinDeadline(true)
        : await client.get<ReadinessResponse>('/system/readiness');
      let snapshot = response.data;
      if (force) {
        while (true) {
          const settled = snapshot.ready !== false
            && snapshot.refreshing !== true
            && snapshot.settingsChanged !== true;
          const advanced = Boolean(snapshot.checkedAt)
            && (!previousCheckedAt || snapshot.checkedAt !== previousCheckedAt);
          if (settled && advanced) break;
          const remainingMs = deadlineAt - Date.now();
          if (remainingMs <= 0) {
            throw new Error('Fresh readiness refresh did not converge before the verification deadline.');
          }
          await new Promise<void>((resolve) => window.setTimeout(
            resolve,
            Math.min(FORCED_READINESS_POLL_MS, remainingMs),
          ));
          response = await requestWithinDeadline(false);
          snapshot = response.data;
        }
      }
      latestReadinessRef.current = snapshot;
      setData((current) => snapshot.ready === false && current?.features.length ? {
        ...current,
        refreshing: true,
        refreshError: snapshot.refreshError,
      } : snapshot);
      setError(null);
      return snapshot;
    } catch (requestError: any) {
      setError(requestError?.response?.data?.error || requestError?.message || 'Failed to load readiness status');
      if (failClosed) throw requestError;
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (data?.ready !== false && !data?.refreshing) return;
    const timer = window.setTimeout(() => { void load(); }, 1800);
    return () => window.clearTimeout(timer);
  }, [data?.ready, data?.refreshing, load]);

  const runAutoSetup = useCallback(async (confirmation: string) => {
    if (!pendingAction || !owner || autoSetupAdmissionRef.current) return;
    const retainedBeforeAdmission = committedAutoSetupRef.current;
    if (retainedBeforeAdmission && retainedBeforeAdmission.featureId !== pendingAction.feature.id) {
      setAutoSetupError('Another accepted setup request is still awaiting verification. Verify that feature before starting another host mutation.');
      return;
    }
    const snapshot = Object.freeze({
      featureId: pendingAction.feature.id,
      actionId: pendingAction.action.id,
      endpoint: pendingAction.action.endpoint,
      confirmation,
    });
    const settingsOwner = `settings:readiness:${snapshot.actionId}`;
    if (settingsClaim && !settingsClaim(settingsOwner)) return;
    settingsMutationOwnerRef.current = settingsOwner;
    autoSetupAdmissionRef.current = true;
    setAutoSetupRunning(true);
    setAutoSetupResult(retainedBeforeAdmission?.result || null);
    setAutoSetupError(null);
    try {
      let committed = committedAutoSetupRef.current;
      if (!committed) {
        const response = await client.post<Omit<AutoSetupResult, 'featureId'>>(snapshot.endpoint, { confirmation: snapshot.confirmation });
        const result: AutoSetupResult = {
          featureId: snapshot.featureId,
          ok: response.data?.ok === true,
          steps: Array.isArray(response.data?.steps) ? response.data.steps : [],
          message: typeof response.data?.message === 'string' && response.data.message.trim()
            ? response.data.message
            : response.data?.ok === true
              ? 'Setup request accepted.'
              : 'Setup request was accepted without a successful result.',
        };
        committed = Object.freeze({ featureId: snapshot.featureId, result });
        committedAutoSetupRef.current = committed;
        setCommittedAutoSetup(committed);
        setAutoSetupResult(result);
      }

      let fresh: ReadinessResponse;
      try {
        const response = await load(true, true);
        if (!response) throw new Error('Fresh readiness response was empty.');
        fresh = response;
      } catch {
        throw new Error('The setup request was accepted, but Portal could not obtain a fresh readiness response. Retry verification will not rerun setup.');
      }

      if (!committed.result.ok) {
        throw new Error(`The setup request was accepted, but reported that it did not complete successfully: ${committed.result.message} Portal retained the result and will not rerun setup; retry verification only checks readiness.`);
      }
      const verificationFailure = freshReadinessFailure(fresh, snapshot.featureId);
      if (verificationFailure) {
        throw new Error(`The setup request was accepted, but ${verificationFailure}. Retry verification will not rerun setup.`);
      }

      committedAutoSetupRef.current = null;
      setCommittedAutoSetup(null);
      setAutoSetupError(null);
      setPendingAction(null);
    } catch (requestError: any) {
      const payload = requestError?.response?.data || {};
      const retained = committedAutoSetupRef.current?.featureId === snapshot.featureId;
      if (!retained) {
        setAutoSetupResult({
          featureId: snapshot.featureId,
          ok: false,
          steps: Array.isArray(payload.steps) ? payload.steps : [],
          message: payload.message || payload.error || requestError?.message || 'Auto-setup request failed',
        });
      }
      setAutoSetupError(retained
        ? requestError?.message || 'The setup request was accepted, but fresh readiness verification failed. Retry verification will not rerun setup.'
        : payload.message || payload.error || requestError?.message || 'Auto-setup request failed');
    } finally {
      autoSetupAdmissionRef.current = false;
      setAutoSetupRunning(false);
      if (settingsMutationOwnerRef.current === settingsOwner) {
        settingsMutationOwnerRef.current = null;
        settingsRelease?.(settingsOwner);
      }
    }
  }, [load, owner, pendingAction, settingsClaim, settingsRelease]);

  useEffect(() => () => {
    const settingsOwner = settingsMutationOwnerRef.current;
    if (settingsOwner) settingsRelease?.(settingsOwner);
    settingsMutationOwnerRef.current = null;
  }, [settingsRelease]);

  if (!data || (data.ready === false && data.features.length === 0)) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5 text-sm text-slate-300" aria-live="polite">
        {error ? <span className="text-red-200">{error}</span> : <><Loader2 size={17} className="mr-2 inline animate-spin" />Feature checks are running in the background. This page will update automatically.</>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200" role="alert">{error}</div>}
      {data?.refreshError && <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100" role="status">Last background refresh failed: {data.refreshError}</div>}

      {data && (
        <section className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-white">Feature Readiness</h2>
                <span className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold uppercase ${statusTone(data.overall)}`}>{statusLabel(data.overall)}</span>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-400">
                Required checks determine readiness. Missing optional tools are shown as recommendations, not failures.
                {data.checkedAt ? ` Last checked ${new Date(data.checkedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}.` : ''}
                {data.refreshing ? ' Refreshing in the background.' : data.cached ? ' Showing cached results.' : ''}
              </p>
              {data.settingsChanged && <p className="mt-1 text-xs text-amber-200">Settings changed since this snapshot; a fresh check is already running.</p>}
            </div>
            <button type="button" onClick={() => { void load(true); }} disabled={loading} className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10 disabled:opacity-50">
              <RefreshCw size={15} className={loading || data.refreshing ? 'animate-spin' : ''} />
              Refresh checks
            </button>
          </div>
        </section>
      )}

      {data && (
        <section className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5">
          <div className="space-y-3">
            {data.features.map((feature) => {
              const open = expanded.has(feature.id);
              const requiredChecks = feature.checks.filter((check) => check.required);
              const optionalMissing = feature.checks.filter((check) => !check.required && !check.ok).length;
              const destination = featureDestination[feature.id] || '/settings';
              const retainedForFeature = committedAutoSetup?.featureId === feature.id;
              const blockedByRetainedFeature = Boolean(committedAutoSetup && !retainedForFeature);
              return (
                <div key={feature.id} className="rounded-xl border border-white/[0.08] bg-black/10">
                  <div className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center">
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={`readiness-${feature.id}`}
                      onClick={() => setExpanded((previous) => {
                        const next = new Set(previous);
                        if (next.has(feature.id)) next.delete(feature.id); else next.add(feature.id);
                        return next;
                      })}
                      className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 rounded-lg px-1 text-left transition hover:bg-white/[0.03]"
                    >
                      {open ? <ChevronDown size={17} className="shrink-0 text-slate-400" /> : <ChevronRight size={17} className="shrink-0 text-slate-400" />}
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-white">{feature.label}</div>
                        <div className="text-xs text-slate-500">
                          {feature.applicable
                            ? `${requiredChecks.filter((check) => check.ok).length}/${requiredChecks.length} required checks passing${optionalMissing ? ` · ${optionalMissing} optional unavailable` : ''}`
                            : feature.note || 'Optional feature is not configured'}
                        </div>
                      </div>
                    </button>

                    <div className="flex flex-wrap items-center gap-2 pl-8 sm:pl-0">
                      <span className={`rounded-lg border px-2 py-1 text-[11px] font-semibold uppercase ${statusTone(feature.status)}`}>{statusLabel(feature.status)}</span>
                      {feature.remediationAction && (feature.status !== 'ready' || retainedForFeature) && (
                        <button
                          type="button"
                          onClick={() => {
                            if (autoSetupAdmissionRef.current) return;
                            const retained = committedAutoSetupRef.current;
                            if (retained && retained.featureId !== feature.id) return;
                            setAutoSetupResult(retained?.result || null);
                            setAutoSetupError(retained
                              ? 'This setup request was already accepted. Retry verification checks only a fresh readiness snapshot and will not rerun setup.'
                              : null);
                            setPendingAction({ feature, action: feature.remediationAction! });
                          }}
                          disabled={!owner || autoSetupRunning || blockedByRetainedFeature}
                          title={owner ? feature.remediationAction.impact : 'Owner-only host setup'}
                          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-200 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          {autoSetupRunning && pendingAction?.feature.id === feature.id ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />}
                          {owner ? retainedForFeature ? `Verify ${feature.label}` : feature.remediationAction.label : 'Owner setup required'}
                        </button>
                      )}
                      <Link
                        to={destination}
                        aria-disabled={autoSetupRunning}
                        onClick={(event) => { if (autoSetupAdmissionRef.current) event.preventDefault(); }}
                        className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-blue-300 transition hover:bg-blue-500/10 hover:text-blue-200 ${autoSetupRunning ? 'pointer-events-none opacity-50' : ''}`}
                      >
                        <PlugZap size={13} /> Open
                      </Link>
                    </div>
                  </div>

                  {open && (
                    <div id={`readiness-${feature.id}`} className="space-y-2 border-t border-white/[0.06] px-4 py-4">
                      {feature.checks.map((check) => (
                        <div key={check.id} className="rounded-lg border border-white/5 bg-black/20 p-3 text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            {check.ok ? <CheckCircle2 size={14} className="text-emerald-400" /> : feature.applicable ? <AlertCircle size={14} className={check.required ? 'text-red-400' : 'text-amber-300'} /> : <span className="h-3.5 w-3.5 rounded-full border border-slate-500" />}
                            <span className="font-medium text-slate-200">{check.label}</span>
                            <span className={`rounded border px-1.5 py-0.5 text-[10px] ${check.required ? 'border-red-500/20 bg-red-500/10 text-red-300' : 'border-slate-500/20 bg-slate-500/10 text-slate-300'}`}>{check.required ? 'Required' : 'Optional'}</span>
                          </div>
                          <p className="mt-1 break-words text-slate-400">{check.message}</p>
                          {feature.applicable && !check.ok && <p className="mt-1 text-slate-500">Action: {check.remediation}</p>}
                        </div>
                      ))}

                      {autoSetupResult?.featureId === feature.id && (
                        <div className={`rounded-lg border p-3 ${autoSetupResult.ok && !retainedForFeature ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-amber-500/20 bg-amber-500/5'}`} role="status">
                          <p className={`text-xs font-semibold ${autoSetupResult.ok && !retainedForFeature ? 'text-emerald-300' : 'text-amber-200'}`}>
                            {retainedForFeature ? `Verification pending — ${autoSetupResult.message}` : autoSetupResult.message}
                          </p>
                          <div className="mt-2 space-y-1">
                            {autoSetupResult.steps.map((step) => (
                              <div key={step.step} className="flex items-start gap-2 text-[11px] text-slate-300">
                                {step.ok ? <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-400" /> : <AlertCircle size={12} className="mt-0.5 shrink-0 text-red-400" />}
                                <span>{step.step}: {step.message}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {!!data?.suggestedNextActions.length && (
        <section className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5">
          <h2 className="text-sm font-semibold text-white">Required next actions</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-300">
            {data.suggestedNextActions.map((action) => <li key={action}>{action}</li>)}
          </ul>
        </section>
      )}

      <TypedConfirmationDialog
        open={!!pendingAction}
        title={pendingAction?.action.label || 'Confirm host setup'}
        description={pendingAction?.action.impact || ''}
        confirmationPhrase={pendingAction?.action.confirmationPhrase}
        confirmLabel={committedAutoSetup?.featureId === pendingAction?.feature.id ? 'Retry verification' : 'Run owner setup'}
        busyLabel={committedAutoSetup?.featureId === pendingAction?.feature.id ? 'Verifying readiness…' : 'Running owner setup…'}
        busy={autoSetupRunning}
        details={autoSetupError ? <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">{autoSetupError}</div> : undefined}
        onCancel={() => {
          if (autoSetupAdmissionRef.current) return;
          setAutoSetupError(null);
          setPendingAction(null);
        }}
        onConfirm={(confirmation) => { void runAutoSetup(confirmation); }}
      />
    </div>
  );
}
