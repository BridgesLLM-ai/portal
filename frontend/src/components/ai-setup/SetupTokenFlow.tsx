import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardPaste, ExternalLink, Loader2, X } from 'lucide-react';
import client from '../../api/client';
import ModelSelector from './ModelSelector';
import type { ProviderUIConfig } from './providerConfig';
import type { ProviderStatus } from './ProviderCard';

interface SetupTokenFlowProps {
  provider: ProviderUIConfig;
  status?: ProviderStatus | null;
  apiBase: string;
  onComplete: () => void;
  onCancel: () => void;
  onNativeCliLogin?: () => void;
}

type Step = 'prereqs' | 'starting' | 'waiting' | 'paste-code' | 'completing' | 'activating-cli' | 'model' | 'manual-paste' | 'done' | 'error';

export default function SetupTokenFlow({ provider, status, apiBase, onComplete, onCancel, onNativeCliLogin }: SetupTokenFlowProps) {
  const [step, setStep] = useState<Step>('prereqs');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteCode, setPasteCode] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [connectedVia, setConnectedVia] = useState<'native-cli' | 'setup-token' | null>(status?.authType === 'cli' ? 'native-cli' : null);

  const normalizeModelForSelector = React.useCallback((modelId: string | null | undefined) => {
    if (!modelId) return null;
    if (modelId.startsWith('claude-cli/')) return modelId.replace(/^claude-cli\//, 'anthropic/');
    return modelId;
  }, []);

  const mapSelectorModelToRuntime = React.useCallback((modelId: string | null | undefined) => {
    if (!modelId) return null;
    if (connectedVia === 'native-cli' && modelId.startsWith('anthropic/')) return modelId.replace(/^anthropic\//, 'claude-cli/');
    return modelId;
  }, [connectedVia]);

  React.useEffect(() => {
    client.get(`${apiBase}/status`).then(({ data }: { data: any }) => {
      const current = normalizeModelForSelector(data?.defaultModel || null);
      const supportedCurrent = current && provider.defaultModels.some((model) => model.id === current) ? current : null;
      setSelectedModel(
        supportedCurrent
        || provider.defaultModels.find((m) => m.tier === 'balanced')?.id
        || provider.defaultModels[0]?.id
        || null,
      );
    }).catch(() => {
      setSelectedModel(
        provider.defaultModels.find((m) => m.tier === 'balanced')?.id || provider.defaultModels[0]?.id || null,
      );
    });
  }, [apiBase, normalizeModelForSelector, provider]);

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
        setConnectedVia('setup-token');
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
        setConnectedVia('setup-token');
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

  const activateNativeCli = async () => {
    setLoading(true);
    setError(null);
    setStep('activating-cli');
    try {
      const { data } = await client.post(`${apiBase}/claude/use-native-cli`, {
        model: selectedModel,
      });
      if (!data?.success) {
        throw new Error(data?.error || 'Failed to connect Claude CLI to OpenClaw');
      }
      setConnectedVia('native-cli');
      setStep('model');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to connect Claude CLI to OpenClaw');
      setStep('error');
    } finally {
      setLoading(false);
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
      const runtimeModel = mapSelectorModelToRuntime(selectedModel);
      if (runtimeModel) {
        await client.post(`${apiBase}/set-default-model`, { model: runtimeModel });
      }
      setStep('done');
      onComplete();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Signed in, but failed to set default model');
    } finally {
      setLoading(false);
    }
  };

  const nativeCliReady = provider.id === 'anthropic' && status?.nativeCliAuthStatus === 'authenticated';

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
                Recommended path: log into <strong className="text-white">Claude Code on this server</strong>, then let OpenClaw use the local Claude CLI runtime.
                That keeps Claude on your subscription path instead of pushing users toward API keys.
              </p>

              <div className={`rounded-lg border p-4 ${nativeCliReady ? 'border-emerald-500/25 bg-emerald-500/10' : 'border-amber-500/25 bg-amber-500/10'}`}>
                <div className={`text-sm font-medium ${nativeCliReady ? 'text-emerald-100' : 'text-amber-100'}`}>
                  {nativeCliReady ? 'Claude Code is already logged in on this server' : 'Claude Code is not logged in on this server yet'}
                </div>
                <ul className={`mt-3 space-y-2.5 text-sm ${nativeCliReady ? 'text-emerald-50/90' : 'text-amber-50/90'}`}>
                  <li className="flex items-start gap-2">
                    <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${nativeCliReady ? 'bg-emerald-300' : 'bg-amber-300'}`} />
                    <span>
                      You still need an active <strong className="text-white">Claude subscription</strong>.{' '}
                      <a href="https://claude.ai/settings/billing" target="_blank" rel="noreferrer" className="font-medium text-orange-300 underline decoration-orange-400/30 hover:text-orange-200">
                        Check your plan
                      </a>
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${nativeCliReady ? 'bg-emerald-300' : 'bg-amber-300'}`} />
                    <span>
                      OpenClaw will switch to <code className="rounded bg-slate-900/80 px-1.5 py-0.5 text-xs text-white">claude-cli/...</code> models under the hood.
                    </span>
                  </li>
                  {!nativeCliReady ? (
                    <li className="flex items-start gap-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300" />
                      <span>Use the Claude Code native login first, then come back here and connect it to OpenClaw.</span>
                    </li>
                  ) : null}
                </ul>
              </div>

              <div className="rounded-lg border border-slate-700/50 bg-slate-800/30 px-4 py-3 text-sm text-slate-300">
                Manual <code className="rounded bg-slate-900/80 px-1.5 py-0.5 text-xs text-slate-100">setup-token</code> is still available below, but it is now the fallback path.
              </div>

              {error ? (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
              ) : null}

              {nativeCliReady ? (
                <button
                  type="button"
                  onClick={activateNativeCli}
                  disabled={loading}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100 disabled:opacity-50"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  Use Claude subscription on this server
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onNativeCliLogin}
                  disabled={!onNativeCliLogin}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ExternalLink className="h-4 w-4" />
                  Log into Claude Code on this server
                </button>
              )}

              <button
                type="button"
                onClick={() => setStep('manual-paste')}
                className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition"
              >
                Use the fallback setup-token path instead
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

          {step === 'activating-cli' ? (
            <div className="space-y-5 py-8 text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-emerald-400" />
              <p className="text-sm text-slate-400">Connecting the server Claude CLI to OpenClaw…</p>
            </div>
          ) : null}

          {/* ── Model selection ── */}
          {step === 'model' ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-emerald-400">
                <CheckCircle2 className="h-5 w-5" />
                <span className="text-sm font-semibold">
                  {connectedVia === 'native-cli' ? 'Claude subscription connected through server Claude CLI!' : 'Claude connected successfully!'}
                </span>
              </div>

              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                {connectedVia === 'native-cli'
                  ? 'OpenClaw is now using claude-cli models on this server. Claude stays on the local Claude CLI subscription path instead of API-key billing.'
                  : 'All available Claude models have been added automatically. You can use any of them in the portal.'}
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
                If you need the fallback path, paste a Claude <code className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-100">setup-token</code> below.
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
              {provider.id === 'anthropic' && onNativeCliLogin ? (
                <button
                  type="button"
                  onClick={onNativeCliLogin}
                  className="w-full text-center text-sm text-slate-400 hover:text-slate-200 transition"
                >
                  Log into Claude Code on this server
                </button>
              ) : null}
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
