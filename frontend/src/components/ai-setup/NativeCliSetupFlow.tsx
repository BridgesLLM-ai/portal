import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardPaste, Copy, ExternalLink, Loader2, X } from 'lucide-react';
import client from '../../api/client';
import { normalizeAgentChatModelId } from '../../utils/agentChatModelSelection';
import { setAgentChatProviderModelsCache } from '../../utils/agentChatProviderModelsCache';
import ViewportModal from '../ViewportModal';
import ModelSelector, { type SelectableModel } from './ModelSelector';
import { cancelOAuthSession } from './oauthCancellation';
import { getOAuthStartRecoveryDisposition, readStructuredOAuthStartFailure } from './oauthFlowContract';

interface NativeCliSetupFlowProps {
  provider: 'claude-code' | 'codex' | 'gemini' | 'grok';
  apiBase: string;
  onComplete: () => void;
  onCancel: () => void;
  onModelSelected?: (provider: 'GEMINI', model: string) => Promise<boolean | void> | boolean | void;
}

async function withNativeDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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

type Step = 'start' | 'waiting' | 'paste' | 'device' | 'catalog' | 'model' | 'done' | 'error';

const PROVIDER_LABELS: Record<string, { name: string; color: string }> = {
  'claude-code': { name: 'Claude Code', color: 'emerald' },
  codex: { name: 'Codex', color: 'blue' },
  gemini: { name: 'Antigravity', color: 'purple' },
  grok: { name: 'Grok Build', color: 'orange' },
};

function antigravityTier(model: { id: string; name: string }): SelectableModel['tier'] {
  const value = `${model.id} ${model.name}`.toLowerCase();
  if (/\b(?:low|lite)\b/.test(value)) return 'fast';
  if (/\b(?:pro|high)\b/.test(value)) return 'frontier';
  return 'balanced';
}

function toAntigravityModel(raw: any): SelectableModel | null {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw?.name === 'string' ? raw.name.trim() : id;
  if (!id.startsWith('google-antigravity/') || !name) return null;
  return {
    id,
    name,
    tier: antigravityTier({ id, name }),
    description: `Exact model reported by the authenticated Antigravity CLI (${normalizeAgentChatModelId('GEMINI', id)}).`,
  };
}

export default function NativeCliSetupFlow({ provider, apiBase, onComplete, onCancel, onModelSelected }: NativeCliSetupFlowProps) {
  const [step, setStep] = useState<Step>('start');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [availableModels, setAvailableModels] = useState<SelectableModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [alreadyAuthenticated, setAlreadyAuthenticated] = useState(false);
  const [reauthSupported, setReauthSupported] = useState<boolean | null>(null);

  const [loading, setLoading] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionOwned, setSessionOwned] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancellationError, setCancellationError] = useState<string | null>(null);
  const [recoverySession, setRecoverySession] = useState(false);
  const [reviewState, setReviewState] = useState<'committed' | 'review_required' | null>(null);
  const operationRef = React.useRef<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const pollGenerationRef = React.useRef(0);
  const mutationGenerationRef = React.useRef(0);
  const completionTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const meta = PROVIDER_LABELS[provider];
  const isDeviceFlow = provider === 'codex' || provider === 'grok';

  const loadAntigravityCatalog = React.useCallback(async () => {
    setStep('catalog');
    setLoading(true);
    setError(null);
    try {
      const { data } = await withNativeDeadline(
        client.get(`${apiBase}/models`, { params: { provider: 'google-antigravity', exact: '1' } }),
        10_000,
        'Timed out while Portal verified the Antigravity model catalog. Retry the connection.',
      );
      const models: SelectableModel[] = (Array.isArray(data?.models) ? data.models as any[] : [])
        .map(toAntigravityModel)
        .filter((model: SelectableModel | null): model is SelectableModel => Boolean(model));
      if (data?.source !== 'native-cli' || data?.exact !== true || data?.readiness?.state !== 'live_verified' || !models.length) {
        throw new Error('Antigravity authenticated, but Portal could not verify an exact live model catalog. Retry the connection before choosing a model.');
      }

      const runtimeModels = models.map((model) => normalizeAgentChatModelId('GEMINI', model.id)).filter(Boolean);
      setAgentChatProviderModelsCache('GEMINI', {
        models: runtimeModels,
        capabilities: {
          supportsModelSelection: true,
          modelSelectionMode: 'launch_bound',
          supportsCustomModelInput: false,
          canEnumerateModels: true,
          modelCatalogKind: 'live',
        },
      });
      setAvailableModels(models);

      const stored = typeof window !== 'undefined'
        ? normalizeAgentChatModelId('GEMINI', window.localStorage.getItem('agentChats.lastModel.GEMINI'))
        : '';
      const storedModel = models.find((model) => normalizeAgentChatModelId('GEMINI', model.id) === stored);
      const preferred = storedModel || models.find((model) => model.tier === 'balanced') || models[0];
      setSelectedModel(preferred?.id || null);
      setStep('model');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load Antigravity models');
      setStep('error');
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  const cancelScheduledCompletion = React.useCallback(() => {
    if (!completionTimerRef.current) return;
    clearTimeout(completionTimerRef.current);
    completionTimerRef.current = null;
  }, []);

  const scheduleCompletion = React.useCallback(() => {
    if (completionTimerRef.current) return;
    completionTimerRef.current = setTimeout(() => {
      completionTimerRef.current = null;
      onComplete();
    }, 1500);
  }, [onComplete]);

  React.useEffect(() => cancelScheduledCompletion, [cancelScheduledCompletion]);

  // Poll for auto-completion
  const pollRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    let disposed = false;
    if ((step === 'waiting' || step === 'device' || step === 'paste' || (step === 'error' && sessionOwned)) && sessionId) {
      const generation = ++pollGenerationRef.current;
      const schedule = () => {
        if (!disposed && generation === pollGenerationRef.current) {
          pollRef.current = setTimeout(() => void poll(), 2000);
        }
      };
      const poll = async () => {
        if (operationRef.current) {
          schedule();
          return;
        }
        const mutationGeneration = mutationGenerationRef.current;
        try {
          const { data } = await client.get(`${apiBase}/native-cli/status/${sessionId}`, { timeout: 10_000 });
          if (disposed || generation !== pollGenerationRef.current || operationRef.current || mutationGeneration !== mutationGenerationRef.current) return;
          if (recoverySession) {
            if (data?.status === 'complete') {
              setError(`The interrupted ${meta.name} login may have committed a credential. Cancel it to run the required server re-attestation before leaving this dialog.`);
            } else if (data?.status === 'error' || data?.status === 'cancelled' || data?.status === 'expired') {
              const detail = typeof data?.error === 'string' && data.error.trim() ? `${data.error.trim()} ` : '';
              setError(`${detail}The interrupted ${meta.name} login reached a terminal state, but Portal must still re-attest it through cancellation.`);
            } else if (data?.cleanupPending === true) {
              setError(data?.error || `Portal is still stopping and reconciling the ${meta.name} login process.`);
            }
            return;
          }
          if (data?.status === 'complete') {
            setSessionOwned(false);
            if (pollRef.current) clearTimeout(pollRef.current);
            if (provider === 'gemini') {
              setAlreadyAuthenticated(Boolean(data?.alreadyAuthenticated));
              setReauthSupported(typeof data?.reauthSupported === 'boolean' ? data.reauthSupported : null);
              await loadAntigravityCatalog();
              disposed = true;
              return;
            }
            setStep('done');
            scheduleCompletion();
            disposed = true;
            return;
          }
          if ((data?.status === 'error' || data?.status === 'cancelled' || data?.status === 'expired') && data?.cleanupPending === true) {
            setError(data?.error || `Portal is still stopping and reconciling the ${meta.name} login process.`);
          } else if (data?.status === 'error' || data?.status === 'cancelled' || data?.status === 'expired') {
            setSessionOwned(false);
            setError(data?.error || `${meta.name} login ${data.status}.`);
            setStep('error');
            disposed = true;
            return;
          }
        } catch {
          if (disposed || generation !== pollGenerationRef.current || operationRef.current || mutationGeneration !== mutationGenerationRef.current) return;
        } finally {
          schedule();
        }
      };
      pollRef.current = setTimeout(() => void poll(), 1000);
    }
    return () => {
      disposed = true;
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [step, sessionId, sessionOwned, recoverySession, apiBase, meta.name, provider, loadAntigravityCatalog, scheduleCompletion]);

  const cancelAndClose = async () => {
    if (operationRef.current || reviewState) return;
    cancelScheduledCompletion();
    if (sessionId && sessionOwned) {
      if (!claimOperation('cancel')) return;
      setCancelling(true);
      setCancellationError(null);
      const result = await cancelOAuthSession(apiBase, sessionId);
      setCancelling(false);
      if (result.outcome === 'committed' || result.outcome === 'review_required') {
        setSessionOwned(false);
        setSessionId(null);
        setRecoverySession(false);
        setReviewState(result.outcome);
        setError(result.error || 'Review the provider before starting another sign-in.');
        setStep('error');
        releaseOperation('cancel');
        return;
      }
      if (result.outcome !== 'cancelled') {
        setCancellationError(result.error || 'Cancellation could not be verified. Keep this dialog open and retry cancellation.');
        releaseOperation('cancel');
        return;
      }
      setSessionOwned(false);
      setSessionId(null);
      setRecoverySession(false);
      releaseOperation('cancel');
    }
    onCancel();
  };

  const acknowledgeReview = () => {
    if (operationRef.current) return;
    onCancel();
  };

  const startFlow = async () => {
    if (sessionOwned || reviewState || !claimOperation('start')) return;
    setLoading(true);
    setError(null);
    setCancellationError(null);
    setRecoverySession(false);
    try {
      const { data } = await client.post(`${apiBase}/native-cli/start`, {
        provider,
        ...(provider === 'gemini' ? { forceReauth: true } : {}),
      });
      if (!data.success) {
        const startFailure = readStructuredOAuthStartFailure(data);
        const disposition = getOAuthStartRecoveryDisposition(startFailure);
        if (disposition === 'cleanup_required' && startFailure.sessionId) {
          setSessionId(startFailure.sessionId);
          setSessionOwned(true);
          setRecoverySession(true);
        } else if (disposition === 'committed' || disposition === 'review_required') {
          setSessionId(null);
          setSessionOwned(false);
          setRecoverySession(false);
          setReviewState(disposition);
        }
        setError(startFailure.error || 'Failed to start native CLI flow');
        setStep('error');
        return;
      }

      const nextSessionId = typeof data?.sessionId === 'string' ? data.sessionId.trim() : '';
      if (!nextSessionId) {
        setSessionOwned(false);
        setReviewState('review_required');
        setError(`Portal received an incomplete ${meta.name} start response and cannot prove whether authentication began. Review the provider before starting another login.`);
        setStep('error');
        return;
      }
      setSessionId(nextSessionId);
      setSessionOwned(data.status !== 'complete');
      setAlreadyAuthenticated(Boolean(data.alreadyAuthenticated));
      setReauthSupported(typeof data.reauthSupported === 'boolean' ? data.reauthSupported : null);

      if (data.status === 'complete') {
        if (provider === 'gemini') {
          await loadAntigravityCatalog();
          return;
        }
        setStep('done');
        scheduleCompletion();
        return;
      }

      if (isDeviceFlow) {
        // Codex device code flow
        setDeviceCode(data.deviceCode || null);
        setVerificationUrl(data.verificationUrl || (provider === 'grok' ? 'https://accounts.x.ai/oauth2/device' : 'https://auth.openai.com/codex/device'));
        setStep('device');
      } else {
        // Claude OAuth flow
        setAuthUrl(data.authUrl || null);
        if (data.authUrl) {
          try {
            const win = window.open(data.authUrl, '_blank', 'noopener,noreferrer');
            if (!win) setPopupBlocked(true);
          } catch {
            setPopupBlocked(true);
          }
        }
        setStep('waiting');
      }
    } catch (err: any) {
      const startFailure = readStructuredOAuthStartFailure(err?.response?.data);
      const msg = startFailure.error || err?.message || 'Failed to start native CLI flow';
      const disposition = getOAuthStartRecoveryDisposition(startFailure);
      if (disposition === 'cleanup_required' && startFailure.sessionId) {
        setSessionId(startFailure.sessionId);
        setSessionOwned(true);
        setRecoverySession(true);
      } else if (disposition === 'committed' || disposition === 'review_required') {
        setSessionId(null);
        setSessionOwned(false);
        setRecoverySession(false);
        setReviewState(disposition);
      }
      setError(msg);
      setStep('error');
    } finally {
      setLoading(false);
      releaseOperation('start');
    }
  };

  const submitCallback = async () => {
    if (!sessionId || !callbackUrl.trim() || !claimOperation('callback')) return;
    setLoading(true);
    setError(null);

    try {
      const { data } = await client.post(`${apiBase}/native-cli/callback`, {
        sessionId,
        callbackUrl: callbackUrl.trim(),
      });

      if (!data.success) {
        setError(data.error || 'Failed to complete native CLI login');
        return;
      }

      setSessionOwned(false);

      if (provider === 'gemini') {
        await loadAntigravityCatalog();
        return;
      }
      setStep('done');
      scheduleCompletion();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to submit callback URL');
    } finally {
      setLoading(false);
      releaseOperation('callback');
    }
  };

  const applyAntigravityModel = async () => {
    if (!selectedModel) return;
    const runtimeModel = normalizeAgentChatModelId('GEMINI', selectedModel);
    if (!runtimeModel || !claimOperation('model')) return;
    setLoading(true);
    setError(null);
    try {
      const accepted = await onModelSelected?.('GEMINI', runtimeModel);
      if (accepted === false) {
        throw new Error('Agent Chat could not apply that Antigravity model. The previous model remains selected.');
      }
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('agentChats.lastModel.GEMINI', runtimeModel);
      }
      onComplete();
    } catch (err: any) {
      setError(err?.message || 'Failed to select the Antigravity Agent Chat model');
    } finally {
      setLoading(false);
      releaseOperation('model');
    }
  };

  const renderContent = () => {
    switch (step) {
      case 'start':
        return (
          <div className="space-y-4">
            <p className="text-sm text-slate-300">
              This will authenticate the <strong>{meta.name}</strong> CLI on the server for use with Agent Chat and other portal features.
            </p>
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-100">
              <strong>Note:</strong> This is separate from OpenClaw auth. The native CLI has its own credential store.
              {provider === 'claude-code' ? ' This login is for the portal\'s native Claude Code features, not the OpenClaw Claude provider setup.' : ''}
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={startFlow}
                disabled={loading}
                className={`inline-flex items-center gap-2 rounded-xl bg-${meta.color}-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-${meta.color}-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400`}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {provider === 'gemini' ? 'Connect or Re-authenticate Antigravity' : `Start ${meta.name} Login`}
              </button>
            </div>
          </div>
        );

      case 'waiting':
        return (
          <div className="space-y-4">
            {authUrl ? (
              <>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Step 1 — Authorize</div>
                  <a
                    href={authUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={`mt-2 inline-flex items-center gap-2 text-sm font-medium text-${meta.color}-300 underline`}
                  >
                    Open {meta.name} login
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  {popupBlocked ? (
                    <div className="mt-2 text-xs text-amber-300">
                      Popup blocked — click the link above to open manually
                    </div>
                  ) : null}
                </div>
                {(provider === 'claude-code' || provider === 'gemini') ? (
                  <>
                    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Step 2 — Paste Authorization Code</div>
                      <p className="mt-2 text-sm text-slate-300">
                        After authorizing, {provider === 'claude-code' ? 'Anthropic' : 'Google'} will show you an <strong>authorization code</strong>. Copy and paste it below.
                      </p>
                      <textarea
                        aria-label="Authorization code"
                        value={callbackUrl}
                        onChange={(e) => setCallbackUrl(e.target.value)}
                        placeholder="Paste the authorization code here..."
                        rows={2}
                        className="mt-3 w-full rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-white font-mono placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                      />
                    </div>
                    {error ? (
                      <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                        {error}
                      </div>
                    ) : null}
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={submitCallback}
                        disabled={loading || !callbackUrl.trim()}
                        className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                      >
                        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardPaste className="h-4 w-4" />}
                        Submit Code
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-slate-300">
                    After authorizing in your browser, the portal will detect completion automatically.
                  </p>
                )}
              </>
            ) : (
              <div className="flex items-center gap-3 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Waiting for {meta.name} to provide auth URL...
              </div>
            )}
          </div>
        );

      case 'device':
        return (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-5 text-center">
              <p className="text-sm text-slate-400">Go to</p>
              <a
                href={verificationUrl || ''}
                target="_blank"
                rel="noreferrer"
                className={`mt-1 inline-block text-base font-semibold text-${meta.color}-300 underline`}
              >
                {verificationUrl}
              </a>
              <div className="mt-5 text-xs font-semibold uppercase tracking-wide text-slate-500">Enter this code</div>
              <div className="mt-3 inline-flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-5 py-4">
                <span className="text-2xl font-semibold tracking-widest text-white">{deviceCode || 'Waiting...'}</span>
                {deviceCode ? (
                  <button
                    type="button"
                    aria-label="Copy device authorization code"
                    onClick={() => navigator.clipboard.writeText(deviceCode)}
                    className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300 transition hover:border-slate-600 hover:bg-slate-800"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
              <p className="mt-4 text-sm text-slate-400">Waiting for authorization...</p>
            </div>
          </div>
        );

      case 'catalog':
        return (
          <div role="status" className="flex items-center gap-3 rounded-xl border border-purple-500/20 bg-purple-500/10 px-4 py-4 text-sm text-purple-100">
            <Loader2 className="h-5 w-5 animate-spin" />
            Verifying Antigravity and loading the exact models available to this Google account…
          </div>
        );

      case 'model':
        return (
          <div className="space-y-4">
            {alreadyAuthenticated && reauthSupported === false ? (
              <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
                Antigravity is already authenticated. This installed <code>agy</code> version does not expose a supported re-authentication command, so Portal kept the verified login and loaded its exact live model catalog.
              </div>
            ) : null}
            <div>
              <h3 className="text-base font-semibold text-white">Choose the native Agent Chat model</h3>
              <p className="mt-1 text-sm text-slate-400">
                These are only the models reported by the authenticated Antigravity CLI. Your choice is saved for the native Gemini Agent Chat harness.
              </p>
            </div>
            <ModelSelector
              models={availableModels}
              selectedModel={selectedModel}
              onSelect={(modelId) => setSelectedModel(modelId || null)}
            />
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs leading-relaxed text-amber-100">
              Antigravity is separate from OpenClaw. This selection does not register an OpenClaw provider or change OpenClaw's default model. Use <strong>Google Gemini CLI (OpenClaw)</strong> for that separate OAuth path.
            </div>
            {error ? (
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">{error}</div>
            ) : null}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void applyAntigravityModel()}
                disabled={loading || !selectedModel}
                className="inline-flex items-center gap-2 rounded-xl bg-purple-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-purple-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Use selected model in Agent Chat
              </button>
            </div>
          </div>
        );

      case 'done':
        return (
          <div className="space-y-4">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" />
                {meta.name} CLI is now authenticated!
              </div>
            </div>
          </div>
        );

      case 'error':
        return (
          <div className="space-y-4">
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>{error || 'An error occurred'}</div>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={reviewState ? acknowledgeReview : () => void cancelAndClose()}
                className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-700"
              >
                {reviewState ? 'Close and review provider status' : 'Close'}
              </button>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <ViewportModal
      open
      onDismiss={() => { void cancelAndClose(); }}
      dismissible={!loading && !cancelling && !sessionOwned && !reviewState && !operation}
      className="bg-black/50 p-4 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="native-cli-setup-title"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto rounded-3xl border border-theme-border bg-theme-surface text-theme-text shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-6 py-5">
          <div>
            <div className={`text-xs font-semibold uppercase tracking-wider text-${meta.color}-300`}>
              Native CLI Login
            </div>
            <h2 id="native-cli-setup-title" className="mt-2 text-2xl font-semibold text-white">{meta.name}</h2>
            <p className="mt-2 text-sm text-slate-400">
              Authenticate the native {meta.name} CLI on the server
            </p>
          </div>
          <button
            type="button"
            onClick={() => void cancelAndClose()}
            disabled={loading || cancelling || Boolean(operation) || Boolean(reviewState)}
            aria-busy={cancelling}
            aria-label={`Close ${meta.name} login`}
            className="rounded-xl border border-slate-800 bg-slate-950/70 p-2 text-slate-400 transition hover:text-white disabled:cursor-wait disabled:opacity-50"
          >
            {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
          </button>
        </div>

        <div className="px-6 py-6">
          {cancellationError ? (
            <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100" role="alert">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{cancellationError}</span>
              </div>
            </div>
          ) : null}
          {renderContent()}
        </div>
      </div>
    </ViewportModal>
  );
}
