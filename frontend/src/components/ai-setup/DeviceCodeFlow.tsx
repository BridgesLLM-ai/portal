import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, Loader2, X } from 'lucide-react';
import client from '../../api/client';

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

  const start = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await client.post(`${apiBase}/oauth/device/start`);
      setSessionId(data.sessionId);
      setVerificationUrl(data.verificationUrl || 'https://github.com/login/device');
      setDeviceCode(data.deviceCode || '');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to start device flow');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!sessionId || complete) return;
    const timer = window.setInterval(async () => {
      try {
        const { data } = await client.get(`${apiBase}/oauth/status/${sessionId}`);
        if (data.status === 'complete') {
          setComplete(true);
          window.clearInterval(timer);
          onComplete();
        }
        if (data.error) {
          setError(data.error);
        }
      } catch {
        // ignore transient polling failures
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [apiBase, complete, onComplete, sessionId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-3xl border border-slate-800 bg-slate-900 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-6 py-5">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">Device Code Login</div>
            <h2 className="mt-2 text-2xl font-semibold text-white">GitHub Copilot</h2>
            <p className="mt-2 text-sm text-slate-400">Open the GitHub device page, enter the code, approve access, and the portal will detect completion automatically.</p>
          </div>
          <button type="button" onClick={onCancel} className="rounded-xl border border-slate-800 bg-slate-950/70 p-2 text-slate-400 transition hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 px-6 py-6">
          {!sessionId ? (
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

          {sessionId ? (
            <div className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5 text-center">
              <p className="text-sm text-slate-400">Go to</p>
              <a href={verificationUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-base font-semibold text-emerald-300 underline">
                {verificationUrl}
              </a>
              <div className="mt-5 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Enter this code</div>
              <div className="mt-3 inline-flex items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-5 py-4">
                <span className="text-2xl font-semibold tracking-[0.3em] text-white">{deviceCode || 'Waiting...'}</span>
                <button type="button" onClick={() => navigator.clipboard.writeText(deviceCode)} className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300 transition hover:border-slate-600 hover:bg-slate-800">
                  <Copy className="h-4 w-4" />
                </button>
              </div>
              {!complete ? <p className="mt-4 text-sm text-slate-400">Waiting for authorization...</p> : null}
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
        </div>
      </div>
    </div>
  );
}
