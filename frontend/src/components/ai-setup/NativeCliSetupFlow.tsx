import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardPaste, Copy, ExternalLink, Loader2, X } from 'lucide-react';
import client from '../../api/client';

interface NativeCliSetupFlowProps {
  provider: 'claude-code' | 'codex' | 'gemini';
  apiBase: string;
  onComplete: () => void;
  onCancel: () => void;
}

type Step = 'start' | 'waiting' | 'paste' | 'device' | 'done' | 'error';

const PROVIDER_LABELS: Record<string, { name: string; color: string }> = {
  'claude-code': { name: 'Claude Code', color: 'emerald' },
  codex: { name: 'Codex', color: 'blue' },
  gemini: { name: 'Gemini', color: 'purple' },
};

export default function NativeCliSetupFlow({ provider, apiBase, onComplete, onCancel }: NativeCliSetupFlowProps) {
  const [step, setStep] = useState<Step>('start');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = PROVIDER_LABELS[provider];
  const isDeviceFlow = provider === 'codex';

  // Poll for auto-completion
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  React.useEffect(() => {
    if ((step === 'waiting' || step === 'device' || step === 'paste') && sessionId) {
      pollRef.current = setInterval(async () => {
        try {
          const { data } = await client.get(`${apiBase}/native-cli/status/${sessionId}`);
          if (data?.status === 'complete') {
            if (pollRef.current) clearInterval(pollRef.current);
            setStep('done');
            setTimeout(() => onComplete(), 1500);
          }
        } catch {
          // ignore poll errors
        }
      }, 2000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [step, sessionId, apiBase, onComplete]);

  const startFlow = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await client.post(`${apiBase}/native-cli/start`, { provider });
      if (!data.success) {
        setError(data.error || 'Failed to start native CLI flow');
        setStep('error');
        return;
      }

      setSessionId(data.sessionId);

      if (isDeviceFlow) {
        // Codex device code flow
        setDeviceCode(data.deviceCode || null);
        setVerificationUrl(data.verificationUrl || 'https://auth.openai.com/codex/device');
        setStep('device');
      } else {
        // Claude/Gemini OAuth flow
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
      const msg = err?.response?.data?.error || err?.message || 'Failed to start native CLI flow';
      setError(msg);
      setStep('error');
    } finally {
      setLoading(false);
    }
  };

  const submitCallback = async () => {
    if (!sessionId || !callbackUrl.trim()) return;
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

      setStep('done');
      setTimeout(() => onComplete(), 1500);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to submit callback URL');
    } finally {
      setLoading(false);
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
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={startFlow}
                disabled={loading}
                className={`inline-flex items-center gap-2 rounded-xl bg-${meta.color}-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-${meta.color}-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400`}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Start {meta.name} Login
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
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Authorization URL</div>
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
                <p className="text-sm text-slate-300">
                  After authorizing in your browser, the portal will detect completion automatically. Or paste the callback URL below if needed.
                </p>
                <button
                  type="button"
                  onClick={() => setStep('paste')}
                  className="text-sm text-slate-400 underline hover:text-slate-300"
                >
                  Paste callback URL manually
                </button>
              </>
            ) : (
              <div className="flex items-center gap-3 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Waiting for {meta.name} to provide auth URL...
              </div>
            )}
          </div>
        );

      case 'paste':
        return (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Callback URL</div>
              <p className="mt-2 text-sm text-slate-300">
                After authorizing, paste the full <code className="rounded bg-slate-900 px-1.5 py-0.5">http://localhost:...</code> or <code className="rounded bg-slate-900 px-1.5 py-0.5">http://127.0.0.1:...</code> URL from your browser's address bar.
              </p>
              <textarea
                value={callbackUrl}
                onChange={(e) => setCallbackUrl(e.target.value)}
                placeholder="http://localhost:8085/?code=..."
                rows={3}
                className="mt-3 w-full rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
              />
            </div>
            {error ? (
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                {error}
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setStep('waiting')}
                className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-700"
              >
                Back
              </button>
              <button
                type="button"
                onClick={submitCallback}
                disabled={loading || !callbackUrl.trim()}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardPaste className="h-4 w-4" />}
                Submit
              </button>
            </div>
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
                onClick={onCancel}
                className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-700"
              >
                Close
              </button>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-3xl border border-slate-800 bg-slate-900 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-6 py-5">
          <div>
            <div className={`text-xs font-semibold uppercase tracking-wider text-${meta.color}-300`}>
              Native CLI Login
            </div>
            <h2 className="mt-2 text-2xl font-semibold text-white">{meta.name}</h2>
            <p className="mt-2 text-sm text-slate-400">
              Authenticate the native {meta.name} CLI on the server
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-slate-800 bg-slate-950/70 p-2 text-slate-400 transition hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-6">{renderContent()}</div>
      </div>
    </div>
  );
}
