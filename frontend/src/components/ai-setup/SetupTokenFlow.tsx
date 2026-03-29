import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardPaste, ExternalLink, Loader2, Terminal, X } from 'lucide-react';
import client from '../../api/client';
import ModelSelector from './ModelSelector';
import type { ProviderUIConfig } from './providerConfig';

interface SetupTokenFlowProps {
  provider: ProviderUIConfig;
  apiBase: string;
  onComplete: () => void;
  onCancel: () => void;
}

type Step = 'prereqs' | 'starting' | 'waiting' | 'paste-code' | 'completing' | 'model' | 'manual-paste' | 'done' | 'error';

export default function SetupTokenFlow({ provider, apiBase, onComplete, onCancel }: SetupTokenFlowProps) {
  const [step, setStep] = useState<Step>('prereqs');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteCode, setPasteCode] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  // Only auto-select a default model if no default is already configured
  React.useEffect(() => {
    client.get(`${apiBase}/status`).then(({ data }: { data: any }) => {
      const current = data?.defaultModel || null;
      if (!current) {
        setSelectedModel(
          provider.defaultModels.find((m) => m.tier === 'balanced')?.id || provider.defaultModels[0]?.id || null,
        );
      }
    }).catch(() => {});
  }, [apiBase, provider]);

  // Poll for auto-completion
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  React.useEffect(() => {
    if (step === 'waiting' && sessionId) {
      pollRef.current = setInterval(async () => {
        try {
          const { data } = await client.get(`${apiBase}/oauth/status/${sessionId}`);
          if (data?.status === 'complete') {
            if (pollRef.current) clearInterval(pollRef.current);
            completeFlow();
          }
        } catch {
          // ignore poll errors
        }
      }, 3000);
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [step, sessionId]);

  const startAutomated = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await client.post(`${apiBase}/claude/start`);
      if (!data.success) {
        // Claude Code not installed — fall back to manual
        setError(data.error || 'Failed to start automated Claude setup');
        setStep('error');
        return;
      }
      setSessionId(data.sessionId);
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
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Failed to start Claude setup';
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
    }
  };

  const submitCode = async () => {
    if (!sessionId || !pasteCode.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await client.post(`${apiBase}/claude/paste-code`, { sessionId, code: pasteCode.trim() });
      if (data.success) {
        setStep('model');
      } else {
        setError(data.error || 'Failed to complete sign-in');
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to submit code');
    } finally {
      setLoading(false);
    }
  };

  const completeFlow = async () => {
    if (!sessionId) return;
    setStep('completing');
    try {
      const { data } = await client.post(`${apiBase}/claude/complete`, { sessionId });
      if (data.success) {
        setStep('model');
      } else {
        setError(data.error || 'Failed to capture setup token');
        setStep('error');
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to complete Claude setup');
      setStep('error');
    }
  };

  const saveManualToken = async () => {
    setLoading(true);
    setError(null);
    try {
      await client.post(`${apiBase}/save-setup-token`, {
        provider: provider.id,
        token: manualToken,
        setDefault: Boolean(selectedModel),
        model: selectedModel,
      });
      setStep('done');
      onComplete();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to save token');
    } finally {
      setLoading(false);
    }
  };

  const finish = async () => {
    setLoading(true);
    setError(null);
    try {
      if (selectedModel) {
        await client.post(`${apiBase}/set-default-model`, { model: selectedModel });
      }
      setStep('done');
      onComplete();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Signed in, but failed to set default model');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl" style={{ maxHeight: '90vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h2 className="text-lg font-semibold text-white">
            {step === 'done' ? 'Done!' : 'Set up Claude'}
          </h2>
          <button type="button" onClick={onCancel} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-5">

          {/* ── Prerequisites ── */}
          {step === 'prereqs' ? (
            <div className="space-y-5">
              <p className="text-sm leading-relaxed text-slate-300">
                You'll sign in with your <strong className="text-white">Claude / Anthropic account</strong>.
                This requires an active Claude subscription (Pro, Team, or Enterprise).
              </p>

              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-sm font-medium text-white">Before you start:</div>
                <ul className="mt-3 space-y-2.5 text-sm text-slate-300">
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400" />
                    <span>
                      Make sure you have an active <strong className="text-white">Claude subscription</strong>.{' '}
                      <a href="https://claude.ai/settings/billing" target="_blank" rel="noreferrer" className="font-medium text-orange-400 underline decoration-orange-400/30 hover:text-orange-300">
                        Check your plan
                      </a>
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400" />
                    <span>The portal will handle the sign-in automatically — just complete the browser authorization when it opens.</span>
                  </li>
                </ul>
              </div>

              {error ? (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
              ) : null}

              <button
                type="button"
                onClick={startAutomated}
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                Sign in with Claude
              </button>

              <button
                type="button"
                onClick={() => setStep('manual-paste')}
                className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition"
              >
                I already have a setup-token — paste it manually
              </button>
            </div>
          ) : null}

          {/* ── Starting ── */}
          {step === 'starting' ? (
            <div className="space-y-5 py-8 text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-orange-400" />
              <p className="text-sm text-slate-400">Starting Claude sign-in…</p>
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
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100"
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
                <p className="text-sm text-slate-400">
                  Didn't open?{' '}
                  <a href={authUrl} target="_blank" rel="noreferrer" className="text-orange-400 underline hover:text-orange-300">
                    Click here
                  </a>
                </p>
              ) : null}

              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-sm font-medium text-white">After you sign in:</div>
                <ol className="mt-3 space-y-3 text-sm text-slate-300">
                  <li className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-white">1</span>
                    <span>Anthropic will show you an <strong className="text-white">authorization code</strong>.</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-white">2</span>
                    <span>Copy that code and come back here to paste it.</span>
                  </li>
                </ol>
              </div>

              <button
                type="button"
                onClick={() => setStep('paste-code')}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100 active:bg-slate-200"
              >
                <ClipboardPaste className="h-4 w-4" />
                I have the code — paste it now
              </button>

              <button type="button" onClick={onCancel} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition">
                Cancel
              </button>
            </div>
          ) : null}

          {/* ── Paste authorization code ── */}
          {step === 'paste-code' ? (
            <div className="space-y-4">
              <p className="text-sm text-slate-300">
                Paste the authorization code that Anthropic gave you after signing in.
              </p>

              <textarea
                value={pasteCode}
                onChange={(e) => setPasteCode(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Paste the code here..."
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 font-mono text-sm text-white placeholder-slate-600 outline-none transition focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
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
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100 active:bg-slate-200 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Complete Sign-In
              </button>

              <button type="button" onClick={() => setStep('waiting')} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition">
                ← Back
              </button>
            </div>
          ) : null}

          {/* ── Completing (saving token) ── */}
          {step === 'completing' ? (
            <div className="space-y-5 py-8 text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-emerald-400" />
              <p className="text-sm text-slate-400">Sign-in detected — saving credentials…</p>
            </div>
          ) : null}

          {/* ── Model selection ── */}
          {step === 'model' ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-emerald-400">
                <CheckCircle2 className="h-5 w-5" />
                <span className="text-sm font-semibold">Claude connected successfully!</span>
              </div>

              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                All available Claude models have been added automatically. You can use any of them in the portal.
              </div>

              <p className="text-sm text-slate-300">
                Optionally, choose a default model. You can change this anytime in Settings.
              </p>
              <ModelSelector models={provider.defaultModels} selectedModel={selectedModel} onSelect={setSelectedModel} />

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

          {/* ── Manual paste fallback ── */}
          {step === 'manual-paste' ? (
            <div className="space-y-5">
              <p className="text-sm text-slate-300">
                If you've already generated a setup-token, paste it below.
              </p>

              <div className="rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-4">
                <div className="text-sm font-semibold text-white">How to generate a setup-token:</div>
                <ol className="mt-2 list-inside space-y-1.5 text-sm text-slate-400">
                  <li>Open a terminal (the portal's Terminal page works too)</li>
                  <li>Run: <code className="rounded bg-slate-800 px-1.5 py-0.5 text-emerald-300">claude setup-token</code></li>
                  <li>Complete the browser sign-in</li>
                  <li>Copy the token that's printed</li>
                </ol>
              </div>

              <textarea
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
                rows={5}
                autoFocus
                placeholder="Paste the full setup-token here..."
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 font-mono text-sm text-white placeholder-slate-600 outline-none transition focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
              />

              {error ? (
                <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              ) : null}

              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                All available Claude models will be added automatically once saved.
              </div>

              <div className="text-sm font-medium text-white">Optionally choose a default Claude model:</div>
              <ModelSelector models={provider.defaultModels} selectedModel={selectedModel} onSelect={setSelectedModel} />

              <button
                type="button"
                onClick={saveManualToken}
                disabled={!manualToken.trim() || loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3.5 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {selectedModel ? 'Save Token' : 'Save Token without default'}
              </button>

              <button type="button" onClick={() => { setError(null); setStep('prereqs'); }} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition">
                ← Back
              </button>
            </div>
          ) : null}

          {/* ── Error ── */}
          {step === 'error' ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-4 text-sm text-red-200">
                <div className="font-medium">Setup failed</div>
                <p className="mt-1 text-red-200/80">{error}</p>
              </div>

              <button
                type="button"
                onClick={() => { setError(null); setStep('prereqs'); }}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100"
              >
                Try Again
              </button>
              <button
                type="button"
                onClick={() => { setError(null); setStep('manual-paste'); }}
                className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition"
              >
                Paste a token manually instead
              </button>
              <button type="button" onClick={onCancel} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition">
                Cancel
              </button>
            </div>
          ) : null}

          {/* ── Done ── */}
          {step === 'done' ? (
            <div className="space-y-4 py-4 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-400" />
              <h3 className="text-lg font-semibold text-white">Claude connected</h3>
              <p className="text-sm text-slate-400">You're ready to use Claude in the portal.</p>
              <button type="button" onClick={onCancel} className="rounded-xl bg-slate-800 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700">
                Close
              </button>
            </div>
          ) : null}

        </div>
      </div>
    </div>
  );
}
