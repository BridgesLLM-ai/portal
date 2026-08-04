import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, ClipboardPaste, Copy, ExternalLink, Loader2, X } from 'lucide-react';
import client from '../../api/client';
import ViewportModal from '../ViewportModal';
import ModelSelector, { type SelectableModel } from './ModelSelector';
import type { ProviderUIConfig } from './providerConfig';
import { getModelFamilyKey, mergeModelCatalog, pickPreferredModel } from './modelCatalog';
import { getOAuthProviderPresentation, getOAuthStartRecoveryDisposition, isOAuthFlowCancelled, isOAuthFlowExpired, isOAuthFlowReadyForModel, readStructuredOAuthFlowState, readStructuredOAuthStartFailure } from './oauthFlowContract';
import { cancelOAuthSession } from './oauthCancellation';

interface OAuthSetupFlowProps {
  provider: ProviderUIConfig;
  apiBase: string;
  onComplete: () => void;
  onCancel: () => void;
}

type Step = 'prereqs' | 'start' | 'waiting' | 'device' | 'paste' | 'finalizing' | 'model' | 'done' | 'error';
type FlowKind = 'oauth' | 'native-cli';

function nativeCliBridgeNote(providerId: string): { title: string; body: string; command?: string } | null {
  switch (providerId) {
    case 'openai-codex':
      return {
        title: 'Codex login powers both paths',
        body: 'This signs in the server Codex CLI, then links OpenClaw to that same credential store for Agent Chat.',
        command: 'codex login',
      };
    case 'google-gemini-cli':
      return {
        title: 'Native Antigravity login is separate',
        body: 'This flow links OpenClaw only. The native Google adapter used by Agent Chat now runs Antigravity, so it still needs its own server-side Google login.',
        command: 'agy',
      };
    default:
      return null;
  }
}

export default function OAuthSetupFlow({ provider, apiBase, onComplete, onCancel }: OAuthSetupFlowProps) {
  const [step, setStep] = useState<Step>('prereqs');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [flowKind, setFlowKind] = useState<FlowKind>('oauth');
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [existingDefault, setExistingDefault] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<SelectableModel[]>(provider.defaultModels);
  const [loadingModels, setLoadingModels] = useState(false);
  const [googleProjectId, setGoogleProjectId] = useState('');
  const [credentialProfileId, setCredentialProfileId] = useState<string | null>(null);
  const [sessionOwned, setSessionOwned] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancellationError, setCancellationError] = useState<string | null>(null);
  const [recoverySession, setRecoverySession] = useState(false);
  const [reviewState, setReviewState] = useState<'committed' | 'review_required' | null>(null);
  // A stuck credential lifecycle from a prior failed sign-in makes every retry
  // return 409; offer a one-click reset that clears the bookkeeping and retries.
  const [lifecycleConflict, setLifecycleConflict] = useState(false);
  const [resettingLifecycle, setResettingLifecycle] = useState(false);
  // Non-fatal finalization notice (e.g. an inconclusive live model probe); the
  // sign-in still completes and the user can pick a default model.
  const [finalizationWarning, setFinalizationWarning] = useState<string | null>(null);
  const operationRef = React.useRef<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const pollGenerationRef = React.useRef(0);
  const mutationGenerationRef = React.useRef(0);

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

  // Check if a default model is already configured; only auto-select if not
  React.useEffect(() => {
    setAvailableModels(provider.defaultModels);
    client.get(`${apiBase}/status`).then(({ data }) => {
      const current = data?.defaultModel || null;
      setExistingDefault(current);
      if (!current) {
        setSelectedModel(pickPreferredModel(provider.defaultModels));
      }
      // Otherwise leave selectedModel as null so the user has to explicitly choose
    }).catch(() => {
      setSelectedModel((current) => current || pickPreferredModel(provider.defaultModels));
    });
  }, [apiBase, provider]);

  React.useEffect(() => {
    if (step !== 'model') return;

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
        if (currentMatch) return currentMatch.id;
        if (existingDefault) return current;
        return pickPreferredModel(nextModels);
      });
    }).catch(() => {
      if (cancelled) return;
      setAvailableModels(provider.defaultModels);
      setSelectedModel((current) => {
        if (current) return current;
        if (existingDefault) return current;
        return pickPreferredModel(provider.defaultModels);
      });
    }).finally(() => {
      if (!cancelled) setLoadingModels(false);
    });

    return () => {
      cancelled = true;
    };
  }, [apiBase, existingDefault, provider.defaultModels, provider.id, step]);

  const isOpenAI = provider.id === 'openai-codex';
  const isGoogle = provider.id === 'google-gemini-cli';
  const isXai = provider.id === 'xai';
  const presentation = getOAuthProviderPresentation(provider.id, provider.name);
  const providerLabel = presentation.label;
  const callbackPathExample = presentation.callbackExample || 'localhost:8085/oauth2callback?...';
  const nativeCliNote = nativeCliBridgeNote(provider.id);

  React.useEffect(() => {
    if (step !== 'device' || !expiresAt) {
      setSecondsRemaining(null);
      return;
    }

    const updateRemaining = () => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setSecondsRemaining(remaining);
    };

    updateRemaining();
    const timer = window.setInterval(updateRemaining, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, step]);

  // Poll for auto-completion (local callback server may catch the redirect directly on VPS)
  const pollRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if ((step === 'waiting' || step === 'device' || step === 'paste' || step === 'finalizing' || (step === 'error' && sessionOwned)) && sessionId) {
      let stopped = false;
      const generation = ++pollGenerationRef.current;
      const stopPolling = () => {
        stopped = true;
        if (pollRef.current) {
          clearTimeout(pollRef.current);
          pollRef.current = null;
        }
      };
      const scheduleNext = () => {
        if (!stopped && generation === pollGenerationRef.current) pollRef.current = setTimeout(() => { void pollOnce(); }, 2000);
      };
      const pollOnce = async () => {
        if (operationRef.current) {
          scheduleNext();
          return;
        }
        const mutationGeneration = mutationGenerationRef.current;
        try {
          const statusPath = flowKind === 'native-cli'
            ? `${apiBase}/native-cli/status/${sessionId}`
            : `${apiBase}/oauth/status/${sessionId}`;
          const { data } = await client.get(statusPath, { timeout: 10_000 });
          if (stopped || generation !== pollGenerationRef.current || operationRef.current || mutationGeneration !== mutationGenerationRef.current) return;
          const structured = readStructuredOAuthFlowState(data);
          setError(null);
          if (structured.verificationUrl) setVerificationUrl(structured.verificationUrl);
          if (structured.userCode) setDeviceCode(structured.userCode);
          if (structured.expiresAt) setExpiresAt(structured.expiresAt);

          if (recoverySession) {
            if (structured.status === 'complete') {
              setFatalError('The interrupted provider sign-in may have committed a credential. Cancel it to run the required server re-attestation before leaving this dialog.');
            } else if (isOAuthFlowExpired(structured) || isOAuthFlowCancelled(structured) || structured.status === 'error') {
              const detail = structured.error ? `${structured.error} ` : '';
              setFatalError(`${detail}The interrupted provider sign-in reached a terminal state, but Portal must still re-attest it through cancellation.`);
            } else if (structured.cleanupPending) {
              setFatalError(structured.error || 'Portal is still stopping and reconciling this provider sign-in.');
            }
            return;
          }

          if (structured.cleanupPending && (isOAuthFlowExpired(structured) || isOAuthFlowCancelled(structured) || structured.status === 'error')) {
            setFatalError(structured.error || 'Portal is still stopping and reconciling this provider sign-in.');
            return;
          }

          const requiresFinalization = flowKind === 'oauth' || isOpenAI;
          const completionReady = isOAuthFlowReadyForModel(structured, requiresFinalization);
          if (completionReady) {
            if (isXai && !structured.createdProfileId) {
              stopPolling();
              setFatalError('xAI sign-in finished, but Portal could not bind the exact saved credential. Disconnect xAI before retrying.');
              setStep('error');
              return;
            }
            if (structured.createdProfileId) setCredentialProfileId(structured.createdProfileId);
            setFinalizationWarning(structured.finalizationWarning);
            setSessionOwned(false);
            stopPolling();
            setStep('model');
          } else if (structured.status === 'complete' && requiresFinalization) {
            // Native Codex authentication has committed. Do not offer
            // cancellation while Portal finishes setup in the background.
            if (isOpenAI) {
              setSessionOwned(false);
              setStep('finalizing');
            }
          } else if ((structured.createdProfileId || structured.credentialState === 'committed')
            && (isOAuthFlowExpired(structured) || isOAuthFlowCancelled(structured) || structured.status === 'error')) {
            setSessionOwned(false);
            setSessionId(null);
            setReviewState('committed');
            stopPolling();
            setFatalError(structured.error || 'A provider credential was committed, but final setup failed. Review the provider before starting another sign-in.');
            setStep('error');
          } else if (isOAuthFlowExpired(structured)) {
            setSessionOwned(false);
            stopPolling();
            setFatalError('This device code expired. Start a fresh sign-in to get a new code.');
            setStep('error');
          } else if (isOAuthFlowCancelled(structured)) {
            setSessionOwned(false);
            stopPolling();
            setFatalError('This sign-in was cancelled. Start again when you are ready.');
            setStep('error');
          } else if (structured.status === 'error') {
            setSessionOwned(false);
            stopPolling();
            setFatalError(structured.error || 'Provider sign-in failed. Start a fresh sign-in and try again.');
            setStep('error');
          }
        } catch (err: any) {
          if (stopped || generation !== pollGenerationRef.current || operationRef.current || mutationGeneration !== mutationGenerationRef.current) return;
          const structuredError = readStructuredOAuthFlowState(err?.response?.data);
          if ((flowKind === 'oauth' || isOpenAI) && structuredError.status === 'complete' && structuredError.finalized !== true) {
            if (isOpenAI) {
              setSessionOwned(false);
              setStep('finalizing');
            }
            setError(structuredError.error || `${provider.name} sign-in succeeded. Portal is retrying final setup…`);
            return;
          }
          if (step === 'error' && sessionOwned) {
            setFatalError(structuredError.error || err?.message || 'Portal is still reconciling this provider sign-in.');
            return;
          }
          const httpStatus = Number(err?.response?.status || 0);
          const transientNativeCodexPoll = flowKind === 'native-cli'
            && isOpenAI
            && (!err?.response || (httpStatus >= 500 && !structuredError.error));
          if (transientNativeCodexPoll) {
            setError('Portal temporarily lost the Codex status connection. Retrying…');
            return;
          }
          if (flowKind === 'native-cli' || (isXai && structuredError.error)) {
            stopPolling();
            setFatalError(structuredError.error || err?.message || 'Provider login completed, but final setup failed.');
            setStep('error');
          }
        } finally {
          scheduleNext();
        }
      };
      void pollOnce();
      return stopPolling;
    }
    return () => {
      if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    };
  }, [step, sessionId, sessionOwned, recoverySession, apiBase, flowKind, isOpenAI, isXai, provider.name]);

  const startFlow = async (forceReauth = false) => {
    if (sessionOwned || reviewState || !claimOperation('start')) return;
    setLoading(true);
    setError(null);
    setLifecycleConflict(false);
    setCancellationError(null);
    setCredentialProfileId(null);
    setRecoverySession(false);
    try {
      if (isOpenAI) {
        setFlowKind('native-cli');
        const { data } = await client.post(`${apiBase}/native-cli/start`, {
          provider: 'codex',
          ...(forceReauth ? { forceReauth: true } : {}),
        });
        if (data.success === false) {
          const startFailure = readStructuredOAuthStartFailure(data);
          if (startFailure.code === 'CODEX_REAUTHENTICATION_REQUIRED') {
            setError(startFailure.error || 'Portal stopped before replacing the existing Codex sign-in.');
            setStep('start');
            return;
          }
          const disposition = getOAuthStartRecoveryDisposition(startFailure);
          if (disposition === 'cleanup_required' && startFailure.sessionId) {
            setSessionId(startFailure.sessionId);
            setSessionOwned(true);
            setRecoverySession(true);
          } else if (disposition === 'committed' || disposition === 'review_required') {
            setSessionId(null);
            setSessionOwned(false);
            setReviewState(disposition);
          }
          setFatalError(startFailure.error || 'Failed to start Codex login.');
          setStep('error');
          return;
        }
        const nextSessionId = typeof data?.sessionId === 'string' ? data.sessionId.trim() : '';
        if (!nextSessionId) {
          setSessionOwned(false);
          setReviewState('review_required');
          setFatalError('Portal received an incomplete Codex start response and cannot prove whether authentication began. Review Codex before starting another login.');
          setStep('error');
          return;
        }
        setFlowKind('native-cli');
        setSessionId(nextSessionId);
        setSessionOwned(data.status !== 'complete');
        if (data.status === 'complete') {
          const structured = readStructuredOAuthFlowState(data);
          setStep(structured.finalized === true ? 'model' : 'finalizing');
          return;
        }
        const url = data.verificationUrl || 'https://auth.openai.com/codex/device';
        setVerificationUrl(url);
        setDeviceCode(data.deviceCode || null);
        setAuthUrl(url);
        if (url) {
          try {
            const win = window.open(url, '_blank', 'noopener,noreferrer');
            if (!win) setPopupBlocked(true);
          } catch {
            setPopupBlocked(true);
          }
        }
        setStep('device');
        return;
      }

      const body: Record<string, string> = { provider: provider.id };
      setFlowKind('oauth');
      if (isGoogle && googleProjectId.trim()) body.googleProjectId = googleProjectId.trim();
      const { data } = await client.post(`${apiBase}/oauth/start`, body);
      if (data?.success === false) {
        const startFailure = readStructuredOAuthStartFailure(data);
        const disposition = getOAuthStartRecoveryDisposition(startFailure);
        if (disposition === 'cleanup_required' && startFailure.sessionId) {
          setSessionId(startFailure.sessionId);
          setSessionOwned(true);
          setRecoverySession(true);
        } else if (disposition === 'committed' || disposition === 'review_required') {
          setSessionId(null);
          setSessionOwned(false);
          setReviewState(disposition);
        }
        setFatalError(startFailure.error || 'Failed to start provider sign-in.');
        setStep('error');
        return;
      }
      setFlowKind('oauth');
      const structured = readStructuredOAuthFlowState(data);
      const nextSessionId = structured.sessionId;
      if (!nextSessionId) {
        setReviewState('review_required');
        setFatalError('Portal received an incomplete OAuth start response and cannot prove whether a credential was committed. Review the provider before starting another sign-in.');
        setStep('error');
        return;
      }
      if (isOAuthFlowReadyForModel(structured, true)) {
        if (isXai && !structured.createdProfileId) {
          setSessionId(nextSessionId);
          setSessionOwned(true);
          setFatalError('xAI sign-in finished, but Portal could not bind the exact saved credential. Cancel this session and review xAI before retrying.');
          setStep('error');
          return;
        }
        setSessionId(nextSessionId);
        setSessionOwned(false);
        if (structured.createdProfileId) setCredentialProfileId(structured.createdProfileId);
        setFinalizationWarning(structured.finalizationWarning);
        setStep('model');
        return;
      }
      setSessionId(nextSessionId);
      setSessionOwned(true);
      setVerificationUrl(structured.verificationUrl);
      setDeviceCode(structured.userCode);
      setExpiresAt(structured.expiresAt);
      const url = structured.verificationUrl;
      setAuthUrl(url);
      if (url) {
        try {
          const win = window.open(url, '_blank', 'noopener,noreferrer');
          if (!win) setPopupBlocked(true);
        } catch {
          setPopupBlocked(true);
        }
      }
      setStep(presentation.completionMode === 'device_code' ? 'device' : 'waiting');
    } catch (err: any) {
      const startFailure = readStructuredOAuthStartFailure(err?.response?.data);
      const msg = startFailure.error || err?.message || 'Failed to start sign-in';
      // A stuck-lifecycle 409 carries only {error, code} — no credentialState —
      // so the disposition helper would route it to the terminal error step and
      // the reset action would never render. Detect it before any disposition
      // early-return; the ledger conflict never owns a live session, so this
      // cannot shadow a cleanup path.
      const conflictCode = err?.response?.data?.code;
      if (isOpenAI && startFailure.code === 'CODEX_REAUTHENTICATION_REQUIRED') {
        setError(msg);
        setStep('start');
        return;
      }
      const isLifecycleConflict = err?.response?.status === 409
        && !startFailure.sessionId
        && startFailure.credentialState !== 'committed'
        && (conflictCode === 'PROVIDER_CREDENTIAL_LIFECYCLE_CONFLICT'
          || /recovering the previous authorization lifecycle|already owns this provider credential/i.test(String(msg)));
      if (isLifecycleConflict) {
        setLifecycleConflict(true);
        setError(msg);
        return;
      }
      // A busy operation gate (e.g. a just-cancelled sign-in still reconciling)
      // resolves by itself in seconds; keep it a retryable inline notice.
      if (err?.response?.status === 409 && !startFailure.sessionId && /already running/i.test(String(msg))) {
        setError(msg);
        return;
      }
      const disposition = getOAuthStartRecoveryDisposition(startFailure);
      if (disposition === 'cleanup_required' && startFailure.sessionId) {
        setSessionId(startFailure.sessionId);
        setSessionOwned(true);
        setRecoverySession(true);
        setFatalError(msg);
        setStep('error');
        return;
      }
      if (disposition === 'committed' || disposition === 'review_required') {
        setSessionId(null);
        setSessionOwned(false);
        setRecoverySession(false);
        setReviewState(disposition);
        setFatalError(msg);
        setStep('error');
        return;
      }
      if (typeof msg === 'string' && (msg.includes('exited with code') || msg.includes('process'))) {
        setFatalError(msg);
        setStep('error');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
      releaseOperation('start');
    }
  };

  const resetLifecycleAndRetry = async () => {
    if (resettingLifecycle || operationRef.current) return;
    setResettingLifecycle(true);
    setError(null);
    try {
      await client.post(`${apiBase}/oauth/reset-lifecycle`, { provider: provider.id });
      setLifecycleConflict(false);
      await startFlow();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not reset the previous sign-in. Try again in a moment.');
    } finally {
      setResettingLifecycle(false);
    }
  };

  const cancelActiveSession = async (): Promise<'cancelled' | 'blocked' | 'review'> => {
    if (operationRef.current || reviewState) return 'blocked';
    if (!sessionId || !sessionOwned) return 'cancelled';
    if (!claimOperation('cancel')) return 'blocked';
    setCancelling(true);
    setCancellationError(null);
    const result = await cancelOAuthSession(apiBase, sessionId);
    setCancelling(false);
    if (result.outcome === 'committed' || result.outcome === 'review_required') {
      setSessionOwned(false);
      setSessionId(null);
      setRecoverySession(false);
      setReviewState(result.outcome);
      setFatalError(result.error || 'Review the provider before starting another sign-in.');
      setStep('error');
      releaseOperation('cancel');
      return 'review';
    }
    if (result.outcome !== 'cancelled') {
      setCancellationError(result.error || 'Cancellation could not be verified. Keep this dialog open and retry cancellation.');
      releaseOperation('cancel');
      return 'blocked';
    }
    setSessionOwned(false);
    setSessionId(null);
    setRecoverySession(false);
    releaseOperation('cancel');
    return 'cancelled';
  };

  const cancelActiveFlow = async () => {
    if (reviewState || operationRef.current) return;
    const result = await cancelActiveSession();
    if (result !== 'cancelled') return;
    onCancel();
  };

  const retryFlow = async () => {
    if (reviewState || operationRef.current) return;
    const result = await cancelActiveSession();
    if (result !== 'cancelled') return;
    setSessionId(null);
    setAuthUrl(null);
    setVerificationUrl(null);
    setDeviceCode(null);
    setExpiresAt(null);
    setSecondsRemaining(null);
    setPopupBlocked(false);
    setError(null);
    setFatalError(null);
    setCancellationError(null);
    setCredentialProfileId(null);
    setStep('prereqs');
  };

  const acknowledgeReview = () => {
    if (operationRef.current) return;
    onCancel();
  };

  const submitCallback = async () => {
    if (!sessionId || !callbackUrl.trim() || !claimOperation('callback')) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await client.post(`${apiBase}/oauth/callback`, { sessionId, callbackUrl });
      if (data.success === false) {
        setError(data.error || 'Sign-in failed. Try starting over.');
        return;
      }
      const structured = readStructuredOAuthFlowState(data);
      if (isOAuthFlowReadyForModel(structured, true)) {
        if (structured.createdProfileId) setCredentialProfileId(structured.createdProfileId);
        setFinalizationWarning(structured.finalizationWarning);
        setSessionOwned(false);
        setStep('model');
        return;
      }
      setError('Authorization was accepted. Portal is verifying the saved credential before loading models.');
      setStep('finalizing');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to complete sign-in');
    } finally {
      setLoading(false);
      releaseOperation('callback');
    }
  };

  const finish = async () => {
    if (!claimOperation('model')) return;
    setLoading(true);
    setError(null);
    try {
      if (selectedModel) {
        const { data } = await client.post(`${apiBase}/set-default-model`, {
          model: selectedModel,
          provider: provider.id,
          ...(isXai ? { profileId: credentialProfileId } : {}),
        });
        if (typeof data?.warning === 'string' && data.warning.trim()) {
          setFinalizationWarning(data.warning.trim());
        }
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

  // ── Shell ──
  return (
    <ViewportModal
      open
      onDismiss={() => { void cancelActiveFlow(); }}
      dismissible={!loading && !cancelling && !sessionOwned && !reviewState && !operation}
      className="bg-black/70 p-4 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="oauth-provider-setup-title"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-theme-border bg-theme-surface text-theme-text shadow-2xl"
      >

        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h2 id="oauth-provider-setup-title" className="text-base font-semibold text-white">
            {step === 'done' ? '✓ Done' : `Set up ${provider.name}`}
          </h2>
          <button type="button" onClick={() => { void cancelActiveFlow(); }} disabled={loading || cancelling || Boolean(operation) || Boolean(reviewState)} aria-busy={cancelling} aria-label="Close provider setup" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white disabled:cursor-wait disabled:opacity-50">
            {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
          </button>
        </div>

        <div className="px-5 py-5">

          {cancellationError ? (
            <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200" role="alert">
              <AlertTriangle className="mb-1 inline h-4 w-4" /> {cancellationError}
            </div>
          ) : null}

          {/* ── Step: Prerequisites ── */}
          {step === 'prereqs' ? (
            <div className="space-y-5">
              {isOpenAI ? (
                <>
                  <p className="text-sm leading-relaxed text-slate-300">
                    You'll sign in with your <strong className="text-white">ChatGPT account</strong>.
                    You need an active paid subscription (Plus, Pro, or Team).
                  </p>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                    <div className="text-sm font-medium text-white">Before you start:</div>
                    <ul className="mt-3 space-y-2.5 text-sm text-slate-300">
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                        <span>Make sure you have a <strong className="text-white">paid ChatGPT subscription</strong> (Plus, Pro, or Team). Free accounts won't work.</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                        <span>
                          Enable <strong className="text-white">device code login</strong> in your personal ChatGPT Security settings, or ask your workspace admin to enable it in Permissions.{' '}
                          <a href="https://developers.openai.com/codex/auth#login-on-headless-devices" target="_blank" rel="noreferrer" className="font-medium text-sky-400 underline decoration-sky-400/30 hover:text-sky-300">
                            OpenAI instructions
                          </a>
                        </span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                        <span>
                          Don't have one?{' '}
                          <a href="https://chatgpt.com/#pricing" target="_blank" rel="noreferrer" className="font-medium text-sky-400 underline decoration-sky-400/30 hover:text-sky-300">
                            Sign up for ChatGPT Plus
                          </a>
                        </span>
                      </li>
                    </ul>
                  </div>
                </>
              ) : null}

              {isGoogle ? (
                <>
                  <p className="text-sm leading-relaxed text-slate-300">
                    You'll sign in with your <strong className="text-white">Google account</strong> to connect Gemini.
                  </p>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                    <div className="text-sm font-medium text-white">Before you start:</div>
                    <ul className="mt-3 space-y-2.5 text-sm text-slate-300">
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />
                        <span>
                          Make sure Gemini is enabled for your Google account.{' '}
                          <a href="https://gemini.google.com/" target="_blank" rel="noreferrer" className="font-medium text-violet-400 underline decoration-violet-400/30 hover:text-violet-300">
                            Open Gemini
                          </a>{' '}
                          — if you can use it there, you're good.
                        </span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />
                        <span>
                          If you're on Google Workspace, your admin may need to enable Gemini.{' '}
                          <a href="https://support.google.com/a/answer/13623888" target="_blank" rel="noreferrer" className="font-medium text-violet-400 underline decoration-violet-400/30 hover:text-violet-300">
                            Workspace admin guide
                          </a>
                        </span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />
                        <span>
                          You'll also need a Google Cloud project (one is usually created automatically).{' '}
                          <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer" className="font-medium text-violet-400 underline decoration-violet-400/30 hover:text-violet-300">
                            Create a project
                          </a>{' '}
                          if you don't have one.
                        </span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />
                        <span>
                          Go to the{' '}
                          <a href="https://console.cloud.google.com/apis/credentials/consent" target="_blank" rel="noreferrer" className="font-medium text-violet-400 underline decoration-violet-400/30 hover:text-violet-300">
                            OAuth consent screen
                          </a>{' '}
                          and click the blue <strong className="text-white">Enable</strong> button. Without this, sign-in will fail with an access error.
                        </span>
                      </li>
                    </ul>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                    <label htmlFor="gcp-project" className="text-sm font-medium text-white">Google Cloud Project ID</label>
                    <p className="mt-1 text-xs text-slate-400">
                      Required for paid Google accounts. Find it at{' '}
                      <a href="https://console.cloud.google.com/welcome" target="_blank" rel="noreferrer" className="text-violet-400 underline hover:text-violet-300">
                        console.cloud.google.com
                      </a>{' '}
                      — it's the ID shown near the top of the dashboard (e.g. <code className="rounded bg-slate-800 px-1 text-xs text-emerald-300">my-project-123456</code>).
                    </p>
                    <input
                      id="gcp-project"
                      type="text"
                      value={googleProjectId}
                      onChange={(e) => setGoogleProjectId(e.target.value)}
                      placeholder="my-project-123456"
                      className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-white placeholder-slate-600 outline-none transition focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                    />
                    <p className="mt-1.5 text-xs text-slate-500">
                      Leave blank if you're on a free Google account — a project will be created automatically.
                    </p>
                  </div>

                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                    <strong>Note:</strong> This uses an unofficial Google integration. Use a non-critical Google account if you're concerned about account restrictions.
                  </div>
                </>
              ) : null}

              {isXai ? (
                <>
                  <p className="text-sm leading-relaxed text-slate-300">
                    You'll sign in with your <strong className="text-white">Grok account</strong> using OpenClaw's device authorization flow.
                    No API key or localhost callback is required.
                  </p>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                    <div className="text-sm font-medium text-white">Before you start:</div>
                    <ul className="mt-3 space-y-2.5 text-sm text-slate-300">
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                        <span>Use the xAI account whose Grok subscription you want this server to use. xAI decides subscription eligibility.</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                        <span>Keep this window open. The portal will show a short code and finish automatically after authorization.</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                        <span>Subscription usage is separate from xAI developer API-key billing.</span>
                      </li>
                    </ul>
                  </div>
                </>
              ) : null}

              {nativeCliNote ? (
                <div className="rounded-lg border border-slate-700/50 bg-slate-800/30 px-4 py-3 text-sm text-slate-300">
                  {provider.id === 'openai-codex'
                    ? 'This signs in Codex on the server and links that credential to OpenClaw.'
                    : 'This connects Gemini through OpenClaw. To use it as a native agent, set it up from its own card in the AI Providers page.'}
                </div>
              ) : null}

              {error ? (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
              ) : null}

              <button
                type="button"
                onClick={() => { if (!operationRef.current) setStep('start'); }}
                disabled={Boolean(operation)}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100 active:bg-slate-200"
              >
                I'm ready — next step
                <ChevronRight className="h-4 w-4" />
              </button>

              <button type="button" onClick={() => { void cancelActiveFlow(); }} disabled={cancelling || Boolean(operation)} aria-busy={cancelling} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition disabled:cursor-wait disabled:opacity-50">
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            </div>
          ) : null}

          {/* ── Step: Start OAuth ── */}
          {step === 'start' ? (
            <div className="space-y-5">
              <p className="text-sm text-slate-300">
                {isXai
                  ? 'Start sign-in to generate a short xAI device code.'
                  : `Click the button below to open ${providerLabel} sign-in in a new tab.`}
              </p>

              {error ? (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
              ) : null}

              {lifecycleConflict ? (
                <button
                  type="button"
                  onClick={() => { void resetLifecycleAndRetry(); }}
                  disabled={resettingLifecycle || loading}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-400/30 bg-amber-500/15 px-5 py-3 text-sm font-semibold text-amber-100 transition hover:bg-amber-500/25 disabled:cursor-wait disabled:opacity-50"
                >
                  {resettingLifecycle ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />}
                  {resettingLifecycle ? 'Resetting…' : 'Reset the previous sign-in and try again'}
                </button>
              ) : null}

              <button
                type="button"
                onClick={() => { void startFlow(); }}
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100 active:bg-slate-200 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                Sign in with {providerLabel}
              </button>

              {isOpenAI ? (
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  <p>
                    Portal will reuse a verified existing Codex sign-in. Replacing it is destructive: Codex clears the current server credential before device authorization, so a cancelled or failed replacement can leave Codex signed out.
                  </p>
                  <button
                    type="button"
                    onClick={() => { void startFlow(true); }}
                    disabled={loading}
                    className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-500/15 px-3 py-2 text-xs font-semibold text-amber-100 transition hover:bg-amber-500/25 disabled:cursor-wait disabled:opacity-50"
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Replace existing Codex sign-in
                  </button>
                </div>
              ) : null}

              <button type="button" onClick={() => { if (!operationRef.current) setStep('prereqs'); }} disabled={Boolean(operation)} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition disabled:cursor-wait disabled:opacity-50">
                ← Back
              </button>
            </div>
          ) : null}

          {/* ── Step: Waiting for login ── */}
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
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Open {providerLabel} Sign-In
                  </a>
                </>
              ) : (
                <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                  <strong>A new tab opened.</strong> Sign in there, then come back.
                </div>
              )}

              {!popupBlocked && authUrl ? (
                <p className="text-sm text-slate-400">
                  Didn't open?{' '}
                  <a href={authUrl} target="_blank" rel="noreferrer" className="text-emerald-400 underline hover:text-emerald-300">
                    Click here
                  </a>
                </p>
              ) : null}

              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-sm font-medium text-white">After you sign in:</div>
                <ol className="mt-3 space-y-3 text-sm text-slate-300">
                  <li className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-white">1</span>
                    <span>Your browser will land on a page that says <strong className="text-white">"This site can't be reached"</strong> — that's completely normal.</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-white">2</span>
                    <span>Click the <strong className="text-white">address bar</strong> at the top of your browser.</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-white">3</span>
                    <span>Select all the text (<strong className="text-white">Ctrl+A</strong> or <strong className="text-white">⌘A</strong>) and copy it (<strong className="text-white">Ctrl+C</strong> or <strong className="text-white">⌘C</strong>).</span>
                  </li>
                </ol>
              </div>

              <button
                type="button"
                onClick={() => { if (!operationRef.current) setStep('paste'); }}
                disabled={Boolean(operation)}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100 active:bg-slate-200"
              >
                <ClipboardPaste className="h-4 w-4" />
                I copied the URL — paste it now
              </button>

              <button type="button" onClick={() => { void cancelActiveFlow(); }} disabled={cancelling || Boolean(operation)} aria-busy={cancelling} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition disabled:cursor-wait disabled:opacity-50">
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            </div>
          ) : null}

          {/* ── Step: Device Code ── */}
          {step === 'device' ? (
            <div className="space-y-5">
              {popupBlocked && verificationUrl ? (
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  Your browser blocked the popup. Use the link below to open sign-in.
                </div>
              ) : (
                <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                  {verificationUrl
                    ? <><strong>A new tab opened.</strong> Enter the code there, then come back.</>
                    : <><strong>Preparing device authorization.</strong> The verification link and code will appear here.</>}
                </div>
              )}

              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-5 text-center">
                <p className="text-sm text-slate-400">Go to</p>
                {verificationUrl ? (
                  <a
                    href={verificationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block break-all text-base font-semibold text-sky-300 underline"
                  >
                    {verificationUrl}
                  </a>
                ) : (
                  <div className="mt-2 inline-flex items-center gap-2 text-sm text-slate-300">
                    <Loader2 className="h-4 w-4 animate-spin" /> Waiting for the secure verification link…
                  </div>
                )}
                <div className="mt-5 text-xs font-semibold uppercase tracking-wide text-slate-500">Enter this code</div>
                <div className="mt-3 inline-flex items-center gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 px-5 py-4">
                  <span className="text-2xl font-semibold tracking-widest text-white">{deviceCode || 'Waiting...'}</span>
                  {deviceCode ? (
                    <button
                      type="button"
                      aria-label="Copy device code"
                      onClick={() => navigator.clipboard.writeText(deviceCode)}
                      className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300 transition hover:border-slate-600 hover:bg-slate-800"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
                <p className="mt-4 text-sm text-slate-400">
                  {secondsRemaining !== null
                    ? (secondsRemaining > 0
                      ? `Waiting for authorization… Code expires in ${Math.floor(secondsRemaining / 60)}:${String(secondsRemaining % 60).padStart(2, '0')}.`
                      : 'Checking the final authorization state with OpenClaw…')
                    : 'Waiting for authorization…'}
                </p>
              </div>

              <button type="button" onClick={() => { void cancelActiveFlow(); }} disabled={cancelling || Boolean(operation)} aria-busy={cancelling} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition disabled:cursor-wait disabled:opacity-50">
                {cancelling ? 'Cancelling…' : 'Cancel sign-in'}
              </button>
            </div>
          ) : null}

          {/* ── Step: Paste ── */}
          {step === 'paste' ? (
            <div className="space-y-4">
              <p className="text-sm text-slate-300">
                Paste what you copied from the address bar. It starts with <code className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-emerald-300">{callbackPathExample}</code>
              </p>

              <textarea
                aria-label="OAuth callback URL"
                value={callbackUrl}
                onChange={(e) => setCallbackUrl(e.target.value)}
                rows={4}
                autoFocus
                placeholder={`${callbackPathExample.replace('?...', '?code=...&state=...')}`}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 font-mono text-sm text-white placeholder-slate-600 outline-none transition focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
              />

              {error ? (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  <AlertTriangle className="mb-1 inline h-4 w-4" /> {error}
                </div>
              ) : null}

              <button
                type="button"
                onClick={submitCallback}
                disabled={!callbackUrl.trim() || loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100 active:bg-slate-200 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Complete Sign-In
              </button>

              <button type="button" onClick={() => { if (!operationRef.current) setStep('waiting'); }} disabled={Boolean(operation)} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition disabled:cursor-wait disabled:opacity-50">
                ← Back
              </button>
            </div>
          ) : null}

          {/* ── Step: Model ── */}
          {step === 'finalizing' ? (
            <div className="space-y-4 py-8 text-center" role="status">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-emerald-400" />
              <p className="text-sm text-slate-300">Verifying the saved {providerLabel} credential before loading models…</p>
              {error ? <p className="text-xs text-slate-500">{error}</p> : null}
            </div>
          ) : null}

          {step === 'model' ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-emerald-400">
                <CheckCircle2 className="h-5 w-5" />
                <span className="text-sm font-semibold">Signed in successfully!</span>
              </div>

              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                {isXai
                  ? 'These are OpenClaw-compatible xAI chat models. Portal will live-test the exact signed-in credential and selected model before saving it as the default.'
                  : 'Models discovered for this connection have been registered. When live discovery is unavailable, the portal shows tested compatibility defaults instead.'}
              </div>

              {finalizationWarning ? (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" />
                    <span>{finalizationWarning}</span>
                  </div>
                </div>
              ) : null}

              <p className="text-sm text-slate-300">
                Optionally, choose a default model. You can change this anytime in Settings.
              </p>
              {loadingModels ? (
                <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
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
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {selectedModel ? 'Save and Finish' : 'Finish without setting a default'}
              </button>
            </div>
          ) : null}

          {/* ── Fatal error ── */}
          {step === 'error' ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-4 text-sm text-red-200">
                <div className="font-medium">Setup failed</div>
                <p className="mt-1 text-red-200/80">{fatalError}</p>
              </div>
              {isGoogle ? (
                <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
                  <div className="font-medium text-white">This can happen if:</div>
                  <ul className="mt-2 space-y-1.5">
                    <li className="flex items-start gap-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-500" />
                      <span>
                        Gemini isn't enabled for your Google account.{' '}
                        <a href="https://gemini.google.com/" target="_blank" rel="noreferrer" className="text-violet-400 underline hover:text-violet-300">Try Gemini here</a> to check.
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-500" />
                      <span>
                        The OAuth consent screen isn't enabled.{' '}
                        <a href="https://console.cloud.google.com/apis/credentials/consent" target="_blank" rel="noreferrer" className="text-violet-400 underline hover:text-violet-300">Enable it here</a>{' '}
                        (click the blue Enable button).
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-500" />
                      <span>
                        You need a Google Cloud project.{' '}
                        <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer" className="text-violet-400 underline hover:text-violet-300">Create one here</a>.
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-500" />
                      <span>
                        The Generative Language API may need to be enabled.{' '}
                        <a href="https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com" target="_blank" rel="noreferrer" className="text-violet-400 underline hover:text-violet-300">Enable it here</a>.
                      </span>
                    </li>
                  </ul>
                </div>
              ) : null}
              {isOpenAI ? (
                <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
                  <div className="font-medium text-white">This can happen if:</div>
                  <ul className="mt-2 space-y-1.5">
                    <li className="flex items-start gap-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-500" />
                      <span>You don't have a paid ChatGPT subscription (Plus, Pro, or Team).</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-500" />
                      <span>Device code login is disabled in your ChatGPT Security settings or by your workspace admin.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-500" />
                      <span>
                        <a href="https://chatgpt.com/#pricing" target="_blank" rel="noreferrer" className="text-sky-400 underline hover:text-sky-300">Check ChatGPT pricing</a>
                      </span>
                    </li>
                  </ul>
                </div>
              ) : null}
              {isXai ? (
                <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
                  <div className="font-medium text-white">Common causes:</div>
                  <ul className="mt-2 space-y-1.5">
                    <li>• The short code expired or authorization was denied.</li>
                    <li>• The signed-in xAI account is not eligible for subscription OAuth.</li>
                    <li>• OpenClaw's bundled xAI plugin is unavailable on this server.</li>
                  </ul>
                </div>
              ) : null}

              {reviewState ? (
                <button type="button" onClick={acknowledgeReview} className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100">
                  Close and review provider status
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => { void retryFlow(); }}
                    disabled={cancelling || Boolean(operation)}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100 disabled:cursor-wait disabled:opacity-50"
                  >
                    Try Again
                  </button>
                  <button type="button" onClick={() => { void cancelActiveFlow(); }} disabled={cancelling || Boolean(operation)} aria-busy={cancelling} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition disabled:cursor-wait disabled:opacity-50">
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
              <h3 className="text-lg font-semibold text-white">{provider.name} connected</h3>
              <p className="text-sm text-slate-400">You're ready to use AI in the portal.</p>
              {finalizationWarning ? (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-left text-sm text-amber-100">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" />
                    <span>{finalizationWarning}</span>
                  </div>
                </div>
              ) : null}
              <button type="button" onClick={() => { void cancelActiveFlow(); }} className="rounded-xl bg-slate-800 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700">
                Close
              </button>
            </div>
          ) : null}

        </div>
      </div>
    </ViewportModal>
  );
}
