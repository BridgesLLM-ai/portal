import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy, Loader2, X } from 'lucide-react';
import client from '../../api/client';
import ViewportModal from '../ViewportModal';
import { cancelOAuthSession } from './oauthCancellation';
import {
  getOAuthStartRecoveryDisposition,
  isOAuthFlowCancelled,
  isOAuthFlowExpired,
  isOAuthFlowReadyForModel,
  readStructuredOAuthFlowState,
  readStructuredOAuthStartFailure,
} from './oauthFlowContract';

interface DeviceCodeFlowProps {
  apiBase: string;
  onComplete: () => void;
  onCancel: () => void;
}

export default function DeviceCodeFlow({ apiBase, onComplete, onCancel }: DeviceCodeFlowProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState('');
  const [deviceCode, setDeviceCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [recoverySession, setRecoverySession] = useState(false);
  const [reviewState, setReviewState] = useState<'committed' | 'review_required' | null>(null);
  const operationRef = useRef<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const pollGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const activeSession = Boolean((sessionId && !complete) || reviewState || operation);

  const claimOperation = (name: string) => {
    if (operationRef.current) return false;
    operationRef.current = name;
    mutationGenerationRef.current += 1;
    setOperation(name);
    return true;
  };

  const releaseOperation = (name: string) => {
    if (operationRef.current !== name) return;
    operationRef.current = null;
    setOperation(null);
  };

  const start = async () => {
    if (activeSession || reviewState || !claimOperation('start')) return;
    setLoading(true);
    setError(null);
    setRecoverySession(false);
    try {
      const { data } = await client.post(`${apiBase}/oauth/device/start`);
      if (data?.success === false) {
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
        setError(startFailure.error || 'Failed to start device flow');
        return;
      }
      const nextSessionId = typeof data?.sessionId === 'string' ? data.sessionId.trim() : '';
      if (!nextSessionId) {
        setReviewState('review_required');
        setError('Portal received an incomplete start response and cannot prove whether GitHub authorization began. Review the provider before starting another sign-in.');
        return;
      }
      setSessionId(nextSessionId);
      setVerificationUrl(data.verificationUrl || 'https://github.com/login/device');
      setDeviceCode(data.deviceCode || '');
    } catch (err: any) {
      const startFailure = readStructuredOAuthStartFailure(err?.response?.data);
      const disposition = getOAuthStartRecoveryDisposition(startFailure);
      if (disposition === 'cleanup_required' && startFailure.sessionId) {
        setSessionId(startFailure.sessionId);
        setRecoverySession(true);
      } else if (disposition === 'committed' || disposition === 'review_required') {
        setSessionId(null);
        setRecoverySession(false);
        setReviewState(disposition);
      }
      setError(startFailure.error || err?.message || 'Failed to start device flow');
    } finally {
      setLoading(false);
      releaseOperation('start');
    }
  };

  useEffect(() => {
    if (!sessionId || complete) return;
    let stopped = false;
    let timer: number | null = null;
    const generation = ++pollGenerationRef.current;
    const schedule = () => {
      if (!stopped && generation === pollGenerationRef.current) {
        timer = window.setTimeout(() => { void poll(); }, 3000);
      }
    };
    const poll = async () => {
      if (operationRef.current) {
        schedule();
        return;
      }
      const mutationGeneration = mutationGenerationRef.current;
      try {
        const { data } = await client.get(`${apiBase}/oauth/status/${sessionId}`, { timeout: 10_000 });
        if (stopped || generation !== pollGenerationRef.current || operationRef.current || mutationGeneration !== mutationGenerationRef.current) return;
        if (recoverySession) {
          if (data.status === 'complete') {
            setError('The interrupted sign-in may have committed a credential. Cancel it to run the required server re-attestation before leaving this dialog.');
          } else if (data.status === 'error' || data.status === 'cancelled' || data.status === 'expired') {
            const detail = typeof data?.error === 'string' && data.error.trim() ? `${data.error.trim()} ` : '';
            setError(`${detail}The interrupted sign-in reached a terminal state, but Portal must still re-attest it through cancellation.`);
          } else if (data.cleanupPending === true) {
            setError(data.error || 'Portal is still stopping and reconciling the GitHub Copilot sign-in process.');
          }
          return;
        }
        const structured = readStructuredOAuthFlowState(data);
        if (isOAuthFlowReadyForModel(structured, true)) {
          setComplete(true);
          stopped = true;
          onComplete();
          return;
        }
        if (structured.status === 'complete') {
          setError(structured.error || 'Authorization was accepted. Portal is verifying the saved credential before marking GitHub Copilot connected.');
          return;
        }
        if (structured.createdProfileId && (structured.status === 'error' || isOAuthFlowCancelled(structured) || isOAuthFlowExpired(structured))) {
          stopped = true;
          setSessionId(null);
          setRecoverySession(false);
          setReviewState('committed');
          setError(structured.error || 'A provider credential was committed, but final setup failed. Review GitHub Copilot before starting another sign-in.');
          return;
        }
        if ((structured.status === 'error' || isOAuthFlowCancelled(structured) || isOAuthFlowExpired(structured)) && !structured.cleanupPending) {
          setSessionId(null);
          setError(structured.error || `GitHub Copilot sign-in ${structured.status}.`);
        } else if (structured.cleanupPending) {
          setError(structured.error || 'Portal is still stopping and reconciling the GitHub Copilot sign-in process.');
        }
        if (structured.error) {
          setError(structured.error);
        }
      } catch (pollError: any) {
        if (stopped || generation !== pollGenerationRef.current || operationRef.current || mutationGeneration !== mutationGenerationRef.current) return;
        if (pollError?.response?.status === 404) {
          setError('Portal no longer has the sign-in session record. Cancel this flow to re-attest its state before leaving or starting another sign-in.');
        }
      } finally {
        schedule();
      }
    };
    timer = window.setTimeout(() => { void poll(); }, 3000);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [apiBase, complete, onComplete, recoverySession, sessionId]);

  const cancelAndClose = async () => {
    if (operationRef.current || reviewState) return;
    if (sessionId && activeSession) {
      if (!claimOperation('cancel')) return;
      setCancelling(true);
      setError(null);
      const result = await cancelOAuthSession(apiBase, sessionId);
      setCancelling(false);
      if (result.outcome === 'committed' || result.outcome === 'review_required') {
        setSessionId(null);
        setRecoverySession(false);
        setReviewState(result.outcome);
        setError(result.error || 'Review the provider before starting another sign-in.');
        releaseOperation('cancel');
        return;
      }
      if (result.outcome !== 'cancelled') {
        setError(result.error || 'Cancellation could not be verified. Keep this dialog open and retry cancellation.');
        releaseOperation('cancel');
        return;
      }
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

  return (
    <ViewportModal
      open
      onDismiss={() => { void cancelAndClose(); }}
      dismissible={!loading && !cancelling && !activeSession}
      className="bg-black/50 p-4 backdrop-blur-sm"
    >
      <div
        className="max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto rounded-3xl border border-theme-border bg-theme-surface text-theme-text shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="device-code-login-title"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-6 py-5">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">Device Code Login</div>
            <h2 id="device-code-login-title" className="mt-2 text-2xl font-semibold text-white">GitHub Copilot</h2>
            <p className="mt-2 text-sm text-slate-400">Open the GitHub device page, enter the code, approve access, and the portal will detect completion automatically.</p>
          </div>
          <button type="button" onClick={() => { void cancelAndClose(); }} disabled={loading || cancelling || Boolean(operation) || Boolean(reviewState)} aria-busy={cancelling} className="rounded-xl border border-slate-800 bg-slate-950/70 p-2 text-slate-400 transition hover:text-white disabled:cursor-wait disabled:opacity-50" aria-label="Close GitHub Copilot login">
            {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
          </button>
        </div>

        <div className="space-y-5 px-6 py-6">
          {!sessionId && !reviewState ? (
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={start}
                disabled={loading}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Start Sign-In
              </button>
            </div>
          ) : null}

          {sessionId && deviceCode ? (
            <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5 text-center">
              <p className="text-sm text-slate-400">Go to</p>
              <a href={verificationUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-base font-semibold text-emerald-300 underline">
                {verificationUrl}
              </a>
              <div className="mt-5 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Enter this code</div>
              <div className="mt-3 inline-flex items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-5 py-4">
                <span className="text-2xl font-semibold tracking-[0.3em] text-white">{deviceCode || 'Waiting...'}</span>
                <button type="button" onClick={() => navigator.clipboard.writeText(deviceCode)} className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300 transition hover:border-slate-600 hover:bg-slate-800" aria-label="Copy GitHub device code">
                  <Copy className="h-4 w-4" />
                </button>
              </div>
              {!complete ? <p className="mt-4 text-sm text-slate-400">Waiting for authorization...</p> : null}
            </div>
          ) : null}

          {sessionId && !deviceCode ? (
            <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100" role="status">
              Portal is retaining this interrupted sign-in until the provider process is safely stopped or reconciled.
            </div>
          ) : null}

          {complete ? (
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
              <div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> GitHub Copilot is connected.</div>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              {error}
            </div>
          ) : null}

          {reviewState ? (
            <div className="space-y-3 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-4 text-sm text-amber-100" role="alert">
              <p>
                {reviewState === 'committed'
                  ? 'A credential may already be saved. Starting another sign-in is blocked until you review the GitHub Copilot provider status.'
                  : 'Portal lost authoritative ownership of this sign-in. Starting another sign-in is blocked until you review the provider status.'}
              </p>
              <button type="button" onClick={acknowledgeReview} className="rounded-xl border border-amber-300/30 bg-amber-100/10 px-4 py-2 font-medium text-amber-50 hover:bg-amber-100/15">
                Close and review provider status
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </ViewportModal>
  );
}
