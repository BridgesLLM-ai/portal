import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardPaste, ExternalLink, Loader2, LogIn, X } from 'lucide-react';
import client from '../../api/client';
import type { AgentTool } from '../../api/agentTools';
import MissingCliInstallPanel from './MissingCliInstallPanel';
import ViewportModal from '../ViewportModal';
import type { SelectableModel } from './ModelSelector';
import type { ProviderUIConfig } from './providerConfig';
import type { ProviderStatus } from './ProviderCard';
import { canonicalizePortalModelId } from '../../utils/modelId';
import { getModelFamilyKey, mergeModelCatalog, pickPreferredModel } from './modelCatalog';
import { cancelOAuthSession } from './oauthCancellation';
import {
  getOAuthStartRecoveryDisposition,
  readClaudeAuthorizationUrl,
  readStructuredOAuthFlowState,
  readStructuredOAuthStartFailure,
  type StructuredOAuthStartFailure,
} from './oauthFlowContract';
import { useAuthStore } from '../../contexts/AuthContext';
import {
  isAuthoritativeCredentialWriteRejection,
  loadOrCreateCredentialOperation,
  retireCredentialOperation,
  verifyCredentialOperation,
  type DurableCredentialOperation,
} from './credentialOperationStorage';

interface SetupTokenFlowProps {
  harnessTool?: { id: string; tool: AgentTool | null } | null;
  onToolInventory?: (tools: AgentTool[]) => void;
  provider: ProviderUIConfig;
  status?: ProviderStatus | null;
  apiBase: string;
  onComplete: () => void;
  onCancel: () => void;
  onNativeCliLogin?: () => void;
}

async function withSetupDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Step = 'prereqs' | 'starting' | 'waiting' | 'paste-code' | 'completing' | 'model' | 'manual-paste' | 'done' | 'error';

function isStuckLifecycleRejection(err: any): boolean {
  const status = err?.response?.status;
  const code = err?.response?.data?.code;
  const msg = String(err?.response?.data?.error || err?.message || '');
  return status === 409
    && (code === 'PROVIDER_CREDENTIAL_LIFECYCLE_CONFLICT'
      || code === 'PROVIDER_CREDENTIAL_LIFECYCLE_RECOVERY_REQUIRED'
      || code === 'PROVIDER_CREDENTIAL_OPERATION_RETAINED_ENVELOPE_MISMATCH'
      || /currently owns this credential domain|retained provider-removal lifecycle|Reset stuck sign-in|remains locked for review|already owns this provider credential|recovered an unfinished authorization lifecycle/i.test(msg));
}

export default function SetupTokenFlow({ harnessTool = null, onToolInventory, provider, status, apiBase, onComplete, onCancel, onNativeCliLogin: _onNativeCliLogin }: SetupTokenFlowProps) {
  const actorScope = useAuthStore((state) => state.user?.id ? `user:${state.user.id}` : 'setup:pending');
  const [step, setStep] = useState<Step>('prereqs');
  // A Claude login already exists on this server when the native auth probe
  // reports it. Signing in again replaces the login OpenClaw and Portal Claude
  // Code use, so that case needs an explicit acknowledgement first.
  const replacesExistingLogin = status?.nativeCliAuthStatus === 'authenticated';
  const [replaceAcknowledged, setReplaceAcknowledged] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteCode, setPasteCode] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [, setSelectedModel] = useState<string | null>(null);
  const [, setAvailableModels] = useState<SelectableModel[]>(provider.defaultModels);
  const [loadingModels, setLoadingModels] = useState(false);
  const [credentialWarning, setCredentialWarning] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancellationError, setCancellationError] = useState<string | null>(null);
  const [recoverySession, setRecoverySession] = useState(false);
  const [reviewState, setReviewState] = useState<'committed' | 'review_required' | null>(null);
  const [lifecycleConflict, setLifecycleConflict] = useState(false);
  const [resettingLifecycle, setResettingLifecycle] = useState(false);
  const operationRef = React.useRef<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const pollGenerationRef = React.useRef(0);
  const mutationGenerationRef = React.useRef(0);
  const manualTokenOperationRef = React.useRef<DurableCredentialOperation | null>(null);
  const initialFocusRef = React.useRef<HTMLButtonElement>(null);
  const stepFocusRef = React.useRef<HTMLDivElement>(null);

  const claimOperation = React.useCallback((name: string) => {
    if (operationRef.current) return false;
    operationRef.current = name;
    mutationGenerationRef.current += 1;
    setOperation(name);
    return true;
  }, []);

  const releaseOperation = React.useCallback((name: string) => {
    if (operationRef.current !== name) return;
    operationRef.current = null;
    setOperation(null);
  }, []);

  const activeSession = Boolean(sessionId && !['model', 'manual-paste', 'done'].includes(step));

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (step === 'prereqs') initialFocusRef.current?.focus();
      else stepFocusRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [step]);

  const normalizeModelForSelector = React.useCallback((modelId: string | null | undefined) => {
    const normalized = canonicalizePortalModelId(modelId || '');
    return normalized || null;
  }, []);

  React.useEffect(() => {
    setAvailableModels(provider.defaultModels);
    client.get(`${apiBase}/status`).then(({ data }: { data: any }) => {
      const current = normalizeModelForSelector(data?.defaultModel || null);
      const supportedCurrent = current && provider.defaultModels.some((model) => getModelFamilyKey(model.id) === getModelFamilyKey(current)) ? current : null;
      setSelectedModel(supportedCurrent || pickPreferredModel(provider.defaultModels));
    }).catch(() => {
      setSelectedModel(pickPreferredModel(provider.defaultModels));
    });
  }, [apiBase, normalizeModelForSelector, provider]);

  React.useEffect(() => {
    if (step !== 'model' && step !== 'manual-paste') return;

    let cancelled = false;
    setLoadingModels(true);

    client.get(`${apiBase}/models`, { params: { provider: provider.id } }).then(({ data }) => {
      if (cancelled) return;
      const discovered = Array.isArray(data?.models)
        ? data.models.map((model: any) => ({
            id: String(model?.id || '').trim(),
            name: String(model?.name || model?.id || '').trim() || String(model?.id || '').trim(),
            description: typeof model?.description === 'string' ? model.description : undefined,
          })).filter((model: SelectableModel) => Boolean(model.id))
        : [];
      const merged = mergeModelCatalog(discovered, provider.defaultModels);
      const nextModels = merged.length ? merged : provider.defaultModels;
      setAvailableModels(nextModels);
      setSelectedModel((current) => {
        const currentFamily = getModelFamilyKey(current || '');
        const currentMatch = currentFamily
          ? nextModels.find((model) => getModelFamilyKey(model.id) === currentFamily)
          : null;
        return currentMatch?.id || current || pickPreferredModel(nextModels);
      });
    }).catch(() => {
      if (cancelled) return;
      setAvailableModels(provider.defaultModels);
      setSelectedModel((current) => current || pickPreferredModel(provider.defaultModels));
    }).finally(() => {
      if (!cancelled) setLoadingModels(false);
    });

    return () => {
      cancelled = true;
    };
  }, [apiBase, provider.defaultModels, provider.id, step]);

  const applyStartFailure = React.useCallback((failure: StructuredOAuthStartFailure, message: string) => {
    const disposition = getOAuthStartRecoveryDisposition(failure);
    if (disposition === 'cleanup_required' && failure.sessionId) {
      setSessionId(failure.sessionId);
      setRecoverySession(true);
    } else if (disposition === 'committed' || disposition === 'review_required') {
      setSessionId(null);
      setRecoverySession(false);
      setReviewState(disposition);
    }
    setError(message);
    setStep('error');
  }, []);

  // Browser sign-in uses the same process-free PKCE flow as Portal Claude
  // Code: Portal prepares the authorization URL, the person signs in and
  // pastes the code back, and the server exchanges it without launching
  // Claude Code on the host. The result is the native Claude Code login that
  // OpenClaw's Claude CLI runtime reads on this server.
  const startBrowserSignIn = async () => {
    if (reviewState || activeSession) return;
    if (replacesExistingLogin && !replaceAcknowledged) return;
    if (!claimOperation('start')) return;
    setLoading(true);
    setError(null);
    setCancellationError(null);
    setCredentialWarning(null);
    setRecoverySession(false);
    setLifecycleConflict(false);
    setStep('starting');
    try {
      const { data } = await withSetupDeadline(
        client.post(`${apiBase}/native-cli/start`, { provider: 'claude-code' }),
        30_000,
        'Timed out while Portal prepared the Claude sign-in. Try again.',
      );
      if (!data?.success) {
        const startFailure = readStructuredOAuthStartFailure(data);
        applyStartFailure(startFailure, startFailure.error || 'Failed to start Claude sign-in');
        return;
      }
      const nextSessionId = typeof data?.sessionId === 'string' ? data.sessionId.trim() : '';
      const nextAuthUrl = readClaudeAuthorizationUrl(data?.authUrl);
      if (!nextSessionId || !nextAuthUrl) {
        setSessionId(null);
        setRecoverySession(false);
        setReviewState('review_required');
        setError('Portal received an incomplete Claude sign-in start response and cannot prove whether a sign-in began. Review the provider before starting another sign-in.');
        setStep('error');
        return;
      }
      setSessionId(nextSessionId);
      setAuthUrl(nextAuthUrl);
      try {
        // `noopener` makes window.open return null by specification, so the
        // return value cannot tell a blocked popup from an opened tab. The
        // waiting step always shows the link as well.
        window.open(nextAuthUrl, '_blank', 'noopener,noreferrer');
      } catch {
        // The waiting step's link remains the fallback.
      }
      setStep('waiting');
    } catch (err: any) {
      if (isStuckLifecycleRejection(err)) {
        setLifecycleConflict(true);
        setError(err?.response?.data?.error || err?.message || 'A previous sign-in attempt still owns this provider.');
        setStep('error');
        return;
      }
      const startFailure = readStructuredOAuthStartFailure(err?.response?.data);
      applyStartFailure(
        startFailure,
        startFailure.error || err?.response?.data?.error || err?.message || 'Failed to start Claude sign-in',
      );
    } finally {
      setLoading(false);
      releaseOperation('start');
    }
  };

  // Watch the sign-in session so cancellation, expiry, or an interrupted
  // recovery session is reported instead of leaving the dialog silent.
  const pollRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if (!sessionId || (step !== 'waiting' && step !== 'paste-code' && step !== 'error')) return;

    let stopped = false;
    const generation = ++pollGenerationRef.current;
    const schedule = () => {
      if (!stopped && generation === pollGenerationRef.current) {
        pollRef.current = setTimeout(() => { void pollOnce(); }, 2000);
      }
    };
    const pollOnce = async () => {
      if (operationRef.current) {
        schedule();
        return;
      }
      const mutationGeneration = mutationGenerationRef.current;
      try {
        const { data } = await client.get(`${apiBase}/native-cli/status/${encodeURIComponent(sessionId)}`, { timeout: 10_000 });
        if (stopped || generation !== pollGenerationRef.current || operationRef.current || mutationGeneration !== mutationGenerationRef.current) return;
        const state = readStructuredOAuthFlowState(data);

        if (recoverySession) {
          if (state.status === 'complete') {
            setError('The interrupted Claude sign-in may have committed a credential. Cancel it to run the required server re-attestation before leaving this dialog.');
          } else if (state.status === 'error' || state.status === 'cancelled' || state.status === 'expired') {
            const detail = state.error ? `${state.error} ` : '';
            setError(`${detail}The interrupted Claude sign-in reached a terminal state, but Portal must still re-attest it through cancellation.`);
          } else if (state.cleanupPending) {
            setError(state.error || 'Portal is still stopping and reconciling the interrupted Claude sign-in.');
          }
          return;
        }

        if (state.status === 'error' || state.status === 'cancelled' || state.status === 'expired') {
          // A processless Claude sign-in that ended (rejected code, expiry by
          // the server reaper, or cancellation elsewhere) must surface on the
          // error step, never as a silent waiting screen. Keep the session id
          // whenever the server still needs to attest it (`cleanupPending`) or
          // it failed, so "Try Again" cancels first and releases the provider
          // credential lease; drop it only when the server already closed it.
          if (state.credentialState === 'committed') setReviewState('committed');
          if (!state.cleanupPending && state.status !== 'error') {
            setSessionId(null);
            setAuthUrl(null);
          }
          setError(state.error || (state.status === 'error'
            ? 'Claude sign-in failed. Start a fresh sign-in.'
            : `Claude sign-in ${state.status}. Start a fresh sign-in.`));
          setStep('error');
          return;
        }

        if (state.status === 'complete') {
          // Completion normally arrives in the callback response. If that
          // response was lost (network error or client deadline) the dialog is
          // already on the error step; the server's own finalized, committed
          // state is authoritative, so recover to the signed-in screen instead
          // of steering the person into a provider review for a login that
          // actually succeeded.
          if (state.finalized === false) return;
          if (step === 'error' && state.credentialState !== 'committed') return;
          setCredentialWarning(state.finalizationWarning);
          setPasteCode('');
          setError(null);
          setStep('model');
        }
      } catch {
        if (stopped || generation !== pollGenerationRef.current || operationRef.current || mutationGeneration !== mutationGenerationRef.current) return;
      } finally {
        schedule();
      }
    };

    pollRef.current = setTimeout(() => { void pollOnce(); }, 1000);
    return () => {
      stopped = true;
      if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    };
  }, [apiBase, recoverySession, sessionId, step]);

  const submitCode = async () => {
    if (!sessionId || !pasteCode.trim() || !claimOperation('submit-code')) return;
    setLoading(true);
    setError(null);
    setStep('completing');
    try {
      const { data } = await withSetupDeadline(
        client.post(`${apiBase}/native-cli/callback`, { sessionId, callbackUrl: pasteCode.trim() }),
        90_000,
        'Timed out while Portal exchanged the Claude authorization code. Check the provider status before pasting the code again.',
      );
      if (data?.success) {
        const warning = typeof data?.warning === 'string'
          ? data.warning
          : typeof data?.finalizationWarning === 'string'
            ? data.finalizationWarning
            : null;
        setCredentialWarning(warning);
        setPasteCode('');
        setStep('model');
        return;
      }
      // The server ends the session on a rejected code, so a fresh sign-in is
      // required. "Try Again" cancels this session first.
      setError(data?.error || 'Claude rejected the authorization code. Start a fresh sign-in and paste a new code.');
      setStep('error');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to submit the Claude authorization code');
      setStep('error');
    } finally {
      setLoading(false);
      releaseOperation('submit-code');
    }
  };

  const saveManualToken = async () => {
    if (!manualToken.trim() || !claimOperation('save-token')) return;
    setLoading(true);
    setError(null);
    try {
      const operation = loadOrCreateCredentialOperation(actorScope, 'setup-token', provider.id);
      manualTokenOperationRef.current = operation;
      verifyCredentialOperation(operation);
      const { data } = await client.post(`${apiBase}/save-setup-token`, {
        provider: provider.id,
        token: manualToken,
        setDefault: false,
        operationId: operation.operationId,
      });
      setCredentialWarning(typeof data?.warning === 'string' ? data.warning : null);
      retireCredentialOperation(operation);
      manualTokenOperationRef.current = null;
      setStep('done');
      onComplete();
    } catch (err: any) {
      const operation = manualTokenOperationRef.current;
      if (operation && isAuthoritativeCredentialWriteRejection(err)) {
        try {
          retireCredentialOperation(operation);
          manualTokenOperationRef.current = null;
        } catch (storageError: any) {
          setError(storageError?.message || 'Portal could not retire the rejected credential operation.');
          return;
        }
      }
      if (isStuckLifecycleRejection(err)) {
        setLifecycleConflict(true);
        setError(err?.response?.data?.error || err?.message || 'A previous sign-in attempt still owns this provider.');
        setStep('error');
        return;
      }
      setError(err?.response?.data?.error || err?.message || 'Failed to save token');
    } finally {
      setLoading(false);
      releaseOperation('save-token');
    }
  };

  const resetStuckLifecycle = async () => {
    if (resettingLifecycle || operationRef.current) return;
    setResettingLifecycle(true);
    setError(null);
    try {
      await client.post(`${apiBase}/oauth/reset-lifecycle`, { provider: provider.id });
      setLifecycleConflict(false);
      setReviewState(null);
      setRecoverySession(false);
      setSessionId(null);
      setAuthUrl(null);
      setStep('prereqs');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not reset the previous sign-in. Try again in a moment.');
    } finally {
      setResettingLifecycle(false);
    }
  };

  const finish = async () => {
    if (!claimOperation('model')) return;
    setError(null);
    try {
      setStep('done');
      onComplete();
      // Close the credential dialog so its parent can open model selection.
      // onComplete queues that handoff synchronously before refreshing status.
      onCancel();
    } finally {
      releaseOperation('model');
    }
  };

  const cancelActiveSession = async (): Promise<'cancelled' | 'blocked' | 'review'> => {
    if (operationRef.current || reviewState) return 'blocked';
    if (!sessionId || !activeSession) return 'cancelled';
    if (!claimOperation('cancel')) return 'blocked';
    setCancelling(true);
    setCancellationError(null);
    const result = await cancelOAuthSession(apiBase, sessionId);
    setCancelling(false);
    if (result.outcome === 'committed' || result.outcome === 'review_required') {
      setSessionId(null);
      setRecoverySession(false);
      setReviewState(result.outcome);
      setError(result.error || 'Review the provider before starting another sign-in.');
      setStep('error');
      releaseOperation('cancel');
      return 'review';
    }
    if (result.outcome !== 'cancelled') {
      setCancellationError(result.error || 'Cancellation could not be verified. Keep this dialog open and retry cancellation.');
      releaseOperation('cancel');
      return 'blocked';
    }
    setSessionId(null);
    setAuthUrl(null);
    setRecoverySession(false);
    releaseOperation('cancel');
    return 'cancelled';
  };

  const cancelAndClose = async () => {
    if (reviewState || operationRef.current) return;
    const result = await cancelActiveSession();
    if (result !== 'cancelled') return;
    onCancel();
  };

  const cancelAndMove = async (nextStep: Step) => {
    if (reviewState || operationRef.current) return;
    const result = await cancelActiveSession();
    if (result !== 'cancelled') return;
    setError(null);
    setCancellationError(null);
    setStep(nextStep);
  };

  const acknowledgeReview = () => {
    if (operationRef.current) return;
    onCancel();
  };

  const stepAnnouncement: Record<Step, string> = {
    prereqs: 'Claude setup is ready to begin.',
    starting: 'Starting Claude sign-in.',
    waiting: 'Claude sign-in is waiting for browser authorization.',
    'paste-code': 'Paste the Claude authorization code.',
    completing: 'Exchanging the Claude authorization code and saving the Claude Code login.',
    model: 'Claude is signed in on this server. Close this dialog to verify the login with OpenClaw and choose a model.',
    'manual-paste': 'Paste a Claude setup token manually.',
    done: 'Claude setup is complete.',
    error: 'Claude setup needs attention.',
  };
  const dangerNote = provider.dangerNote ? (
    <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="font-semibold text-red-100">{provider.dangerNote.title}</div>
          <div className="mt-1 leading-relaxed text-red-100 opacity-90">{provider.dangerNote.detail}</div>
          {provider.dangerNote.link ? (
            <a
              href={provider.dangerNote.link.url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 font-medium text-sky-300 underline decoration-sky-400/40 hover:text-sky-200"
            >
              {provider.dangerNote.link.label}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <ViewportModal
      open
      onDismiss={() => { void cancelAndClose(); }}
      dismissible={!loading && !cancelling && !activeSession && !reviewState && !operation}
      initialFocusRef={initialFocusRef}
      className="bg-black/50 p-4 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-token-flow-title"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto rounded-2xl border border-theme-border bg-theme-surface text-theme-text shadow-2xl"
      >

        {/* Header */}
        <div className="flex items-center justify-between border-b border-theme-border px-5 py-4">
          <h2 id="setup-token-flow-title" className="text-lg font-semibold text-theme-text">
            {step === 'done' ? 'Done!' : 'Set up Claude'}
          </h2>
          <button type="button" aria-label="Close Claude setup" aria-busy={cancelling} onClick={() => { void cancelAndClose(); }} disabled={loading || cancelling || Boolean(operation) || Boolean(reviewState) || step === 'starting'} className="rounded-lg p-1.5 text-theme-text-muted transition hover:bg-theme-surface-hover hover:text-theme-text disabled:cursor-wait disabled:opacity-50">
            {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
          </button>
        </div>

        <div
          ref={stepFocusRef}
          data-testid="claude-setup-step"
          tabIndex={-1}
          aria-describedby="claude-setup-step-status"
          aria-busy={step === 'starting' || step === 'completing' || loadingModels || loading || cancelling || Boolean(operation)}
          className="px-5 py-5 outline-none"
        >
          <div
            id="claude-setup-step-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {stepAnnouncement[step]}
          </div>
          <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
            {error || ''}
          </div>

          {cancellationError ? (
            <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200" role="alert">
              <AlertTriangle className="mb-1 inline h-4 w-4" /> {cancellationError}
            </div>
          ) : null}

          {/* ── Prerequisites ── */}
          {step === 'prereqs' ? (
            <div className="space-y-5">
              {dangerNote}
              {harnessTool ? <MissingCliInstallPanel toolId={harnessTool.id} tool={harnessTool.tool} onInventory={onToolInventory} disabled={loading || Boolean(operation)} purpose="Install Claude Code to use this login with OpenClaw and Agent Chat." /> : null}

              <p className="text-sm leading-relaxed text-theme-text-subtle">
                Sign in with your Claude account in the browser, then paste the authorization code back here. Portal completes the sign-in itself and never launches Claude Code on the host to do it.
              </p>

              <div className="rounded-xl border border-theme-border bg-theme-surface-raised p-4">
                <div className="text-sm font-medium text-theme-text">What this sign-in does</div>
                <ul className="mt-3 space-y-2.5 text-sm text-theme-text-subtle">
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                    <span>
                      Saves the Claude Code login on this server. OpenClaw&apos;s Claude CLI runtime and Portal Claude Code sessions share that login.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                    <span>
                      After sign-in, choose a model and optionally make it OpenClaw’s default. Your existing default stays unchanged until you choose.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                    <span>Usage limits follow the connected Claude account. Prefer an Anthropic API key for shared or metered automation.</span>
                  </li>
                </ul>
              </div>

              {replacesExistingLogin ? (
                <button
                  type="button"
                  onClick={() => { void finish(); }}
                  disabled={loading || Boolean(operation)}
                  className="w-full rounded-xl bg-theme-text px-5 py-3 text-sm font-semibold text-theme-surface disabled:opacity-50"
                >
                  Use existing login and choose a model
                </button>
              ) : null}

              {replacesExistingLogin ? (
                <label className="flex items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  <input
                    type="checkbox"
                    checked={replaceAcknowledged}
                    onChange={(event) => setReplaceAcknowledged(event.target.checked)}
                    disabled={loading || Boolean(operation)}
                    className="mt-1 h-4 w-4 shrink-0 accent-amber-400"
                  />
                  <span>
                    <strong>A Claude login already exists on this server.</strong> Signing in replaces the login that OpenClaw&apos;s Claude CLI runtime and Portal Claude Code sessions currently use. Check this box to replace it.
                  </span>
                </label>
              ) : null}

              {error ? (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
              ) : null}

              <button
                ref={initialFocusRef}
                type="button"
                onClick={() => { void startBrowserSignIn(); }}
                disabled={loading || Boolean(operation) || (replacesExistingLogin && !replaceAcknowledged)}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-theme-text px-5 py-3 text-sm font-semibold text-theme-surface shadow transition hover:opacity-90 active:opacity-80 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                {replacesExistingLogin ? 'Replace the Claude login on this server' : 'Sign in with your Claude account'}
              </button>

              <button
                type="button"
                onClick={() => { void cancelAndMove('manual-paste'); }}
                disabled={Boolean(operation)}
                className="w-full rounded-xl border border-theme-border-strong bg-theme-surface-raised px-5 py-3 text-sm font-medium text-theme-text transition hover:bg-theme-surface-hover"
              >
                Paste an existing setup-token
              </button>

              <div className="rounded-lg border border-theme-border bg-theme-surface-raised px-4 py-3 text-sm text-theme-text-subtle">
                You can also return and choose the Anthropic API-key option instead.
              </div>

            </div>
          ) : null}

          {/* ── Starting ── */}
          {step === 'starting' ? (
            <div className="space-y-5 py-8 text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-orange-400" />
              <p className="text-sm text-theme-text-muted">Starting Claude sign-in…</p>
            </div>
          ) : null}

          {/* ── Waiting for browser auth ── */}
          {step === 'waiting' ? (
            <div className="space-y-5">
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                <strong>Claude sign-in opened in a new tab.</strong> Sign in with your Claude account there.
              </div>

              {authUrl ? (
                <>
                  <a
                    href={authUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex w-full items-center justify-center gap-2 rounded-xl border border-theme-border-strong bg-theme-surface-raised px-5 py-3 text-sm font-medium text-theme-text transition hover:bg-theme-surface-hover"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Open Claude Sign-In
                  </a>
                  <p className="text-sm text-theme-text-muted">
                    If no tab opened (for example, a popup blocker), use the button above.
                  </p>
                </>
              ) : null}

              <div className="rounded-lg border border-theme-border bg-theme-surface-raised p-4">
                <div className="text-sm font-medium text-theme-text">After you sign in:</div>
                <ol className="mt-3 space-y-3 text-sm text-theme-text-subtle">
                  <li className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-theme-surface-strong text-xs font-bold text-theme-text">1</span>
                    <span>Anthropic will show you an <strong className="text-theme-text">authorization code</strong>.</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-theme-surface-strong text-xs font-bold text-theme-text">2</span>
                    <span>Copy that code and come back here to paste it.</span>
                  </li>
                </ol>
              </div>

              <button
                type="button"
                onClick={() => setStep('paste-code')}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-theme-text px-5 py-3 text-sm font-semibold text-theme-surface shadow transition hover:opacity-90 active:opacity-80"
              >
                <ClipboardPaste className="h-4 w-4" />
                I have the code — paste it now
              </button>

              <button type="button" aria-busy={cancelling} disabled={cancelling} onClick={() => { void cancelAndClose(); }} className="w-full text-center text-sm text-theme-text-muted transition hover:text-theme-text disabled:cursor-wait disabled:opacity-50">
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            </div>
          ) : null}

          {/* ── Paste authorization code ── */}
          {step === 'paste-code' ? (
            <div className="space-y-4">
              <p className="text-sm text-theme-text-subtle">
                Paste the authorization code that Anthropic gave you after signing in.
              </p>

              <textarea
                aria-label="Claude authorization code"
                value={pasteCode}
                onChange={(e) => setPasteCode(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Paste the code here..."
                className="w-full rounded-xl border border-theme-border-strong bg-theme-bg px-4 py-3 font-mono text-sm text-theme-text placeholder:text-theme-text-muted outline-none transition focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
              />

              {error ? (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  <AlertTriangle className="mb-1 inline h-4 w-4" /> {error}
                </div>
              ) : null}

              <button
                type="button"
                onClick={submitCode}
                disabled={!pasteCode.trim() || loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-theme-text px-5 py-3 text-sm font-semibold text-theme-surface shadow transition hover:opacity-90 active:opacity-80 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Complete Sign-In
              </button>

              <button type="button" onClick={() => { if (!operationRef.current) setStep('waiting'); }} disabled={Boolean(operation)} className="w-full text-center text-sm text-theme-text-muted transition hover:text-theme-text disabled:cursor-wait disabled:opacity-50">
                ← Back
              </button>
            </div>
          ) : null}

          {/* ── Completing (exchanging the code) ── */}
          {step === 'completing' ? (
            <div className="space-y-5 py-8 text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-emerald-400" />
              <div className="space-y-2">
                <p className="text-sm text-theme-text-subtle">Exchanging the authorization code with Anthropic and saving the Claude Code login…</p>
                <p className="text-xs text-theme-text-muted">Portal completes this on the server without launching Claude Code. It usually takes a few seconds.</p>
              </div>
            </div>
          ) : null}

          {/* ── Signed in ── */}
          {step === 'model' ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-emerald-400">
                <CheckCircle2 className="h-5 w-5" />
                <span className="text-sm font-semibold">Claude is signed in on this server</span>
              </div>

              {dangerNote}

              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                OpenClaw&apos;s Claude CLI runtime and Portal Claude Code sessions use this login. Portal did not register models, change the default route, restart the gateway, or launch a host model turn.
              </div>

              {credentialWarning ? (
                <p className="text-sm text-amber-200" role="status">{credentialWarning}</p>
              ) : null}

              <p className="text-sm text-theme-text-subtle">
                Continue to choose a Claude model and, if you want, make it OpenClaw&apos;s default. Portal will confirm what OpenClaw saved.
              </p>

              {error ? (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
              ) : null}

              <button
                type="button"
                onClick={finish}
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-theme-text px-5 py-3 text-sm font-semibold text-theme-surface shadow transition hover:opacity-90 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Choose a model
              </button>
            </div>
          ) : null}

          {/* ── Manual paste fallback ── */}
          {step === 'manual-paste' ? (
            <div className="space-y-5">
              {dangerNote}
              {harnessTool ? <MissingCliInstallPanel toolId={harnessTool.id} tool={harnessTool.tool} onInventory={onToolInventory} disabled={loading || Boolean(operation)} purpose="Install Claude Code to use this login with OpenClaw and Agent Chat." /> : null}

              <p className="text-sm text-theme-text-subtle">
                If you already have a Claude <code className="rounded bg-theme-surface-strong px-1.5 py-0.5 text-xs text-theme-text">setup-token</code>, paste it below. Portal will not run Claude Code to create or inspect one.
              </p>

              <div className="rounded-xl border border-theme-border bg-theme-surface-raised px-4 py-4">
                <div className="text-sm font-semibold text-theme-text">Existing token only</div>
                <p className="mt-2 text-sm text-theme-text-subtle">
                  Obtain the token outside this Portal host under your organization&apos;s credential procedure. This screen only validates and saves what you paste.
                </p>
              </div>

              <textarea
                aria-label="Claude setup token"
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
                rows={5}
                autoFocus
                placeholder="Paste the full setup-token here..."
                className="w-full rounded-xl border border-theme-border-strong bg-theme-bg px-4 py-3 font-mono text-sm text-theme-text placeholder:text-theme-text-muted outline-none transition focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
              />

              {error ? (
                <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              ) : null}

              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                Portal will save only the supplied credential. It will not register models, change the default route, restart the gateway, or probe a host model turn.
              </div>

              <button
                type="button"
                onClick={saveManualToken}
                disabled={!manualToken.trim() || loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-theme-text px-5 py-3.5 text-sm font-semibold text-theme-surface shadow transition hover:opacity-90 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Save Token
              </button>

              <button type="button" onClick={() => { void cancelAndMove('prereqs'); }} disabled={Boolean(operation)} className="w-full text-center text-sm text-theme-text-muted transition hover:text-theme-text disabled:cursor-wait disabled:opacity-50">
                ← Back
              </button>
            </div>
          ) : null}

          {/* ── Error ── */}
          {step === 'error' ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-4 text-sm text-red-200">
                <div className="font-medium">Setup failed</div>
                <p className="mt-1 text-red-200 opacity-80">{error}</p>
              </div>

              {reviewState ? (
                <button type="button" onClick={acknowledgeReview} className="flex w-full items-center justify-center rounded-xl bg-theme-text px-5 py-3 text-sm font-semibold text-theme-surface shadow transition hover:opacity-90">
                  Close and review provider status
                </button>
              ) : (
                <>
                  {lifecycleConflict ? (
                    <button
                      type="button"
                      onClick={() => { void resetStuckLifecycle(); }}
                      disabled={resettingLifecycle || Boolean(operation)}
                      className="flex w-full items-center justify-center gap-2 rounded-xl bg-theme-text px-5 py-3 text-sm font-semibold text-theme-surface shadow transition hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
                    >
                      {resettingLifecycle ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Reset stuck sign-in and start over
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => { void cancelAndMove('prereqs'); }}
                    disabled={cancelling || Boolean(operation)}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-theme-text px-5 py-3 text-sm font-semibold text-theme-surface shadow transition hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
                  >
                    Try Again
                  </button>
                  <button
                    type="button"
                    onClick={() => { void cancelAndMove('manual-paste'); }}
                    disabled={cancelling || Boolean(operation)}
                    className="w-full text-center text-sm text-theme-text-muted transition hover:text-theme-text disabled:cursor-wait disabled:opacity-50"
                  >
                    Paste a token manually instead
                  </button>
                  <button type="button" aria-busy={cancelling} disabled={cancelling || Boolean(operation)} onClick={() => { void cancelAndClose(); }} className="w-full text-center text-sm text-theme-text-muted transition hover:text-theme-text disabled:cursor-wait disabled:opacity-50">
                    {cancelling ? 'Cancelling…' : 'Cancel'}
                  </button>
                </>
              )}
            </div>
          ) : null}

          {/* ── Done ── */}
          {step === 'done' ? (
            <div className="space-y-4 py-4 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-400" />
              <h3 className="text-lg font-semibold text-theme-text">Claude credential saved</h3>
              {dangerNote}
              <p className="text-sm text-theme-text-subtle">OpenClaw's default model is unchanged. Close this dialog to verify the login with OpenClaw and choose a model.</p>
              {credentialWarning ? <p className="text-sm text-amber-200">{credentialWarning}</p> : null}
              <button type="button" onClick={() => { void cancelAndClose(); }} className="rounded-xl border border-theme-border-strong bg-theme-surface-raised px-5 py-2.5 text-sm font-medium text-theme-text transition hover:bg-theme-surface-hover">
                Close
              </button>
            </div>
          ) : null}

        </div>
      </div>
    </ViewportModal>
  );
}
