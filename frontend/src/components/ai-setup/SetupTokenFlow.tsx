import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardPaste, ExternalLink, Loader2, X } from 'lucide-react';
import client from '../../api/client';
import ViewportModal from '../ViewportModal';
import ModelSelector, { type SelectableModel } from './ModelSelector';
import type { ProviderUIConfig } from './providerConfig';
import type { ProviderStatus } from './ProviderCard';
import { canonicalizePortalModelId } from '../../utils/modelId';
import { getModelFamilyKey, mergeModelCatalog, pickPreferredModel } from './modelCatalog';
import { cancelOAuthSession } from './oauthCancellation';
import { getOAuthStartRecoveryDisposition, readStructuredOAuthStartFailure } from './oauthFlowContract';
import { useAuthStore } from '../../contexts/AuthContext';
import {
  isAuthoritativeCredentialWriteRejection,
  loadOrCreateCredentialOperation,
  retireCredentialOperation,
  verifyCredentialOperation,
  type DurableCredentialOperation,
} from './credentialOperationStorage';

interface SetupTokenFlowProps {
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

export default function SetupTokenFlow({ provider, status, apiBase, onComplete, onCancel, onNativeCliLogin: _onNativeCliLogin }: SetupTokenFlowProps) {
  const actorScope = useAuthStore((state) => state.user?.id ? `user:${state.user.id}` : 'setup:pending');
  const [step, setStep] = useState<Step>('prereqs');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteCode, setPasteCode] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<SelectableModel[]>(provider.defaultModels);
  const [loadingModels, setLoadingModels] = useState(false);
  const [statusOutput, setStatusOutput] = useState<string | null>(null);
  const [completingStartedAt, setCompletingStartedAt] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancellationError, setCancellationError] = useState<string | null>(null);
  const [recoverySession, setRecoverySession] = useState(false);
  const [reviewState, setReviewState] = useState<'committed' | 'review_required' | null>(null);
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

  const mapSelectorModelToRuntime = React.useCallback((modelId: string | null | undefined) => {
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

  const finalizeClaudeSetup = React.useCallback(async () => {
    if (!sessionId || !claimOperation('finalize')) return;
    setLoading(true);
    try {
      const { data } = await withSetupDeadline(
        client.post(`${apiBase}/claude/complete`, { sessionId }),
        20_000,
        'Timed out while Portal verified the Claude credential. Keep this dialog open and retry verification.',
      );
      if (data.success) {
        setStep('model');
        setCompletingStartedAt(null);
      } else {
        setError(data.error || 'Failed to capture setup token');
        setStep('error');
        setCompletingStartedAt(null);
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to complete Claude setup');
      setStep('error');
      setCompletingStartedAt(null);
    } finally {
      setLoading(false);
      releaseOperation('finalize');
    }
  }, [apiBase, claimOperation, releaseOperation, sessionId]);

  // Poll Claude setup status so the UI does not look frozen while the CLI finishes.
  const pollRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalizeInFlightRef = React.useRef(false);
  const finalizationAttemptedSessionRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!sessionId || (step !== 'waiting' && step !== 'completing' && step !== 'error')) return;

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
        const { data } = await client.get(`${apiBase}/oauth/status/${sessionId}`, { timeout: 10_000 });
        if (stopped || generation !== pollGenerationRef.current || operationRef.current || mutationGeneration !== mutationGenerationRef.current) return;
        const output = typeof data?.output === 'string' ? data.output.trim() : '';
        setStatusOutput(output || null);

        if (recoverySession) {
          if (data?.status === 'complete') {
            setError('The interrupted Claude setup may have committed a credential. Cancel it to run the required server re-attestation before leaving this dialog.');
          } else if (data?.status === 'error' || data?.status === 'cancelled' || data?.status === 'expired') {
            const detail = typeof data?.error === 'string' && data.error.trim() ? `${data.error.trim()} ` : '';
            setError(`${detail}The interrupted Claude setup reached a terminal state, but Portal must still re-attest it through cancellation.`);
          } else if (data?.cleanupPending === true) {
            setError(data?.error || 'Portal is still stopping and reconciling the Claude setup process.');
          }
          return;
        }

        if ((data?.status === 'error' || data?.status === 'cancelled' || data?.status === 'expired') && data?.cleanupPending === true) {
          setError(data?.error || 'Portal is still stopping and reconciling the Claude setup process.');
          return;
        }

        if (data?.status === 'error' || data?.status === 'cancelled' || data?.status === 'expired') {
          setSessionId(null);
          setError(data?.error || 'Claude setup failed');
          setStep('error');
          setCompletingStartedAt(null);
          return;
        }

        if (
          (step === 'waiting' || step === 'error')
          && data?.status === 'complete'
          && !finalizeInFlightRef.current
          && finalizationAttemptedSessionRef.current !== sessionId
        ) {
          finalizeInFlightRef.current = true;
          finalizationAttemptedSessionRef.current = sessionId;
          await finalizeClaudeSetup();
          finalizeInFlightRef.current = false;
          return;
        }

        if (step === 'completing' && completingStartedAt && Date.now() - completingStartedAt > 180000) {
          setError('Timed out waiting for Claude Code to return the setup token after the pasted code. Try the code once more, or use manual token paste.');
          setStep('error');
          setCompletingStartedAt(null);
        }
      } catch {
        if (stopped || generation !== pollGenerationRef.current || operationRef.current || mutationGeneration !== mutationGenerationRef.current) return;
      } finally {
        schedule();
      }
    };

    void pollOnce();
    return () => {
      stopped = true;
      if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
      finalizeInFlightRef.current = false;
    };
  }, [apiBase, completingStartedAt, finalizeClaudeSetup, recoverySession, sessionId, step]);

  React.useEffect(() => {
    if (
      step !== 'completing'
      || !sessionId
      || finalizeInFlightRef.current
      || finalizationAttemptedSessionRef.current === sessionId
    ) return;
    finalizeInFlightRef.current = true;
    finalizationAttemptedSessionRef.current = sessionId;
    void finalizeClaudeSetup().finally(() => {
      finalizeInFlightRef.current = false;
    });
  }, [finalizeClaudeSetup, sessionId, step]);

  const startAutomated = async () => {
    if (activeSession || reviewState || !claimOperation('start')) return;
    finalizationAttemptedSessionRef.current = null;
    setLoading(true);
    setError(null);
    setCancellationError(null);
    setPopupBlocked(false);
    setRecoverySession(false);
    setStep('starting');
    try {
      const { data } = await client.post(`${apiBase}/claude/start`);
      if (!data.success) {
        const startFailure = readStructuredOAuthStartFailure(data);
        const disposition = getOAuthStartRecoveryDisposition(startFailure);
        if (disposition === 'cleanup_required' && startFailure.sessionId) {
          setSessionId(startFailure.sessionId);
          setRecoverySession(true);
        } else if (disposition === 'committed' || disposition === 'review_required') {
          setSessionId(null);
          setRecoverySession(false);
          setReviewState(disposition);
        }
        setError(startFailure.error || 'Failed to start automated Claude setup');
        setStep('error');
        return;
      }
      if (data.instantComplete) {
        setStatusOutput(data.method === 'cli-reuse' ? 'Claude CLI auth detected on the server. Reused it for OpenClaw automatically.' : null);
        setCompletingStartedAt(null);
        setStep('model');
        return;
      }
      const nextSessionId = typeof data?.sessionId === 'string' ? data.sessionId.trim() : '';
      if (!nextSessionId) {
        setReviewState('review_required');
        setError('Portal received an incomplete Claude start response and cannot prove whether authentication began. Review Claude before starting another setup.');
        setStep('error');
        return;
      }
      setSessionId(nextSessionId);
      setAuthUrl(data.authUrl || null);
      setStatusOutput(null);
      setCompletingStartedAt(null);
      if (data.authUrl) {
        try {
          const win = window.open(data.authUrl, '_blank', 'noopener,noreferrer');
          if (!win) setPopupBlocked(true);
        } catch {
          setPopupBlocked(true);
        }
      }
      setStep('waiting');
    } catch (err: any) {
      const startFailure = readStructuredOAuthStartFailure(err?.response?.data);
      const msg = startFailure.error || err?.message || 'Failed to start Claude setup';
      const disposition = getOAuthStartRecoveryDisposition(startFailure);
      if (disposition === 'cleanup_required' && startFailure.sessionId) {
        setSessionId(startFailure.sessionId);
        setRecoverySession(true);
      } else if (disposition === 'committed' || disposition === 'review_required') {
        setSessionId(null);
        setRecoverySession(false);
        setReviewState(disposition);
      }
      if (msg.includes('Is Claude Code installed') || msg.includes('not found') || msg.includes('ENOENT')) {
        // Claude Code not on server — show manual fallback
        setError('Claude Code is not installed on the server. You can paste a setup-token manually instead.');
        setStep('error');
      } else {
        setError(msg);
        setStep('error');
      }
    } finally {
      setLoading(false);
      releaseOperation('start');
    }
  };

  const submitCode = async () => {
    if (!sessionId || !pasteCode.trim() || !claimOperation('submit-code')) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await client.post(`${apiBase}/claude/paste-code`, { sessionId, code: pasteCode.trim() });
      if (data.success) {
        setCompletingStartedAt(Date.now());
        setStep('completing');
      } else {
        setError(data.error || 'Failed to complete sign-in');
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to submit code');
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
      await client.post(`${apiBase}/save-setup-token`, {
        provider: provider.id,
        token: manualToken,
        setDefault: Boolean(selectedModel),
        model: selectedModel,
        operationId: operation.operationId,
      });
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
      setError(err?.response?.data?.error || err?.message || 'Failed to save token');
    } finally {
      setLoading(false);
      releaseOperation('save-token');
    }
  };

  const finish = async () => {
    if (!claimOperation('model')) return;
    setLoading(true);
    setError(null);
    try {
      const runtimeModel = mapSelectorModelToRuntime(selectedModel);
      if (runtimeModel) {
        await client.post(`${apiBase}/set-default-model`, { model: runtimeModel, provider: provider.id });
      }
      setStep('done');
      onComplete();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Signed in, but failed to set default model');
    } finally {
      setLoading(false);
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
    setCompletingStartedAt(null);
    setRecoverySession(false);
    finalizationAttemptedSessionRef.current = null;
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

  const primaryButtonLabel = status?.status === 'configured' ? 'Reconnect Claude' : 'Connect Claude';
  const stepAnnouncement: Record<Step, string> = {
    prereqs: 'Claude setup is ready to begin.',
    starting: 'Starting Claude sign-in.',
    waiting: 'Claude sign-in is waiting for browser authorization.',
    'paste-code': 'Paste the Claude authorization code.',
    completing: 'Claude sign-in was detected. Finishing setup.',
    model: 'Claude is connected. Choose an optional default model.',
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

              <p className="text-sm leading-relaxed text-theme-text-subtle">
                OpenClaw first checks for an authenticated <strong className="text-theme-text">Claude CLI login on this server</strong> and reuses it automatically. If none is available, the portal opens the setup-token fallback.
              </p>

              <div className="rounded-xl border border-theme-border bg-theme-surface-raised p-4">
                <div className="text-sm font-medium text-theme-text">How the connection works</div>
                <ul className="mt-3 space-y-2.5 text-sm text-theme-text-subtle">
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                    <span>
                      Sign in to Claude Code on this server. The portal can reuse that authenticated session without requiring a separate API key.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                    <span>
                      Click Connect Claude. The portal will import reusable CLI credentials before attempting any setup-token flow.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                    <span>Fable 5 is supported through the Claude CLI path and appears in the model picker alongside the other supported Claude models.</span>
                  </li>
                </ul>
              </div>

              <div className="rounded-lg border border-theme-border bg-theme-surface-raised px-4 py-3 text-sm text-theme-text-subtle">
                Setup-token remains available as a fallback if the server does not already have a reusable Claude CLI login.
              </div>

              {error ? (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
              ) : null}

              <button
                ref={initialFocusRef}
                type="button"
                onClick={startAutomated}
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-theme-text px-5 py-3 text-sm font-semibold text-theme-surface shadow transition hover:opacity-90 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {primaryButtonLabel}
              </button>

              <button
                type="button"
                onClick={() => { void cancelAndMove('manual-paste'); }}
                disabled={Boolean(operation)}
                className="w-full rounded-xl border border-theme-border-strong bg-theme-surface-raised px-5 py-3 text-sm font-medium text-theme-text transition hover:bg-theme-surface-hover"
              >
                Paste a setup-token manually
              </button>

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
              {popupBlocked && authUrl ? (
                <>
                  <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                    Your browser blocked the popup. Tap the button to open sign-in.
                  </div>
                  <a
                    href={authUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-theme-text px-5 py-3 text-sm font-semibold text-theme-surface shadow transition hover:opacity-90"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Open Claude Sign-In
                  </a>
                </>
              ) : (
                <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                  <strong>A new tab opened.</strong> Sign in with your Anthropic account there.
                </div>
              )}

              {!popupBlocked && authUrl ? (
                <p className="text-sm text-theme-text-muted">
                  Didn't open?{' '}
                  <a href={authUrl} target="_blank" rel="noreferrer" className="text-orange-400 underline hover:text-orange-300">
                    Click here
                  </a>
                </p>
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

          {/* ── Completing (saving token) ── */}
          {step === 'completing' ? (
            <div className="space-y-5 py-8 text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-emerald-400" />
              <div className="space-y-2">
                <p className="text-sm text-theme-text-subtle">Sign-in detected — finishing the Claude setup-token handshake…</p>
                <p className="text-xs text-theme-text-muted">This can take a bit after you paste the authorization code. The screen should not stay silent forever now.</p>
              </div>
              {statusOutput ? (
                <div className="rounded-xl border border-theme-border bg-theme-surface-raised p-4 text-left">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-theme-text-muted">Claude status</div>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-theme-text-subtle">{statusOutput}</pre>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ── Model selection ── */}
          {step === 'model' ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-emerald-400">
                <CheckCircle2 className="h-5 w-5" />
                <span className="text-sm font-semibold">Claude connected successfully!</span>
              </div>

              {dangerNote}

              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                Claude models discovered for this connection have been registered. When live discovery is unavailable, the portal shows tested compatibility defaults instead.
              </div>

              <p className="text-sm text-theme-text-subtle">
                Optionally, choose a default model. You can change this anytime in Settings.
              </p>
              {loadingModels ? (
                <div className="flex items-center gap-2 rounded-lg border border-theme-border bg-theme-surface-raised px-4 py-3 text-sm text-theme-text-subtle">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading available models…
                </div>
              ) : null}
              <ModelSelector models={availableModels.length ? availableModels : provider.defaultModels} selectedModel={selectedModel} onSelect={setSelectedModel} />

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
                {selectedModel ? 'Save and Finish' : 'Finish without setting a default'}
              </button>
            </div>
          ) : null}

          {/* ── Manual paste fallback ── */}
          {step === 'manual-paste' ? (
            <div className="space-y-5">
              {dangerNote}

              <p className="text-sm text-theme-text-subtle">
                If you already have a Claude <code className="rounded bg-theme-surface-strong px-1.5 py-0.5 text-xs text-theme-text">setup-token</code>, paste it below. This is the fallback path when automatic Claude CLI credential reuse is unavailable.
              </p>

              <div className="rounded-xl border border-theme-border bg-theme-surface-raised px-4 py-4">
                <div className="text-sm font-semibold text-theme-text">How to generate a setup-token:</div>
                <ol className="mt-2 list-inside space-y-1.5 text-sm text-theme-text-subtle">
                  <li>Open a terminal (the portal's Terminal page works too)</li>
                  <li>Run: <code className="rounded bg-theme-surface-strong px-1.5 py-0.5 text-emerald-300">claude setup-token</code></li>
                  <li>Complete the browser sign-in</li>
                  <li>Copy the token that's printed</li>
                </ol>
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
                Claude models discovered for this connection will be registered after the credential is saved; tested compatibility defaults are used when discovery is unavailable.
              </div>

              <div className="text-sm font-medium text-theme-text">Optionally choose a default Claude model:</div>
              {loadingModels ? (
                <div className="flex items-center gap-2 rounded-lg border border-theme-border bg-theme-surface-raised px-4 py-3 text-sm text-theme-text-subtle">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading available models…
                </div>
              ) : null}
              <ModelSelector models={availableModels.length ? availableModels : provider.defaultModels} selectedModel={selectedModel} onSelect={setSelectedModel} />

              <button
                type="button"
                onClick={saveManualToken}
                disabled={!manualToken.trim() || loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-theme-text px-5 py-3.5 text-sm font-semibold text-theme-surface shadow transition hover:opacity-90 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {selectedModel ? 'Save Token' : 'Save Token without default'}
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
              <h3 className="text-lg font-semibold text-theme-text">Claude connected</h3>
              {dangerNote}
              <p className="text-sm text-theme-text-subtle">You're ready to use Claude in the portal. Choose any supported model available to the connected account, including Fable 5.</p>
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
