import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, ClipboardPaste, ExternalLink, Loader2, X } from 'lucide-react';
import client from '../../api/client';
import ModelSelector from './ModelSelector';
import type { ProviderUIConfig } from './providerConfig';

interface OAuthSetupFlowProps {
  provider: ProviderUIConfig;
  apiBase: string;
  onComplete: () => void;
  onCancel: () => void;
}

type Step = 'prereqs' | 'start' | 'waiting' | 'paste' | 'model' | 'done' | 'error';

function nativeCliBridgeNote(providerId: string): { title: string; body: string; command?: string } | null {
  switch (providerId) {
    case 'openai-codex':
      return {
        title: 'Native Codex login is separate',
        body: 'This portal flow links OpenClaw only. The native Codex adapter used by Agent Chat still needs its own server-side auth; those tokens are not copied into the Codex CLI automatically.',
        command: 'codex auth',
      };
    case 'google-gemini-cli':
      return {
        title: 'Native Gemini login is separate',
        body: 'This flow links OpenClaw only. The native Gemini adapter still needs its own login or API-key environment on the server; OpenClaw credentials are not copied into the Gemini CLI automatically.',
        command: 'gemini',
      };
    default:
      return null;
  }
}

export default function OAuthSetupFlow({ provider, apiBase, onComplete, onCancel }: OAuthSetupFlowProps) {
  const [step, setStep] = useState<Step>('prereqs');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [existingDefault, setExistingDefault] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [googleProjectId, setGoogleProjectId] = useState('');

  // Check if a default model is already configured; only auto-select if not
  React.useEffect(() => {
    client.get(`${apiBase}/status`).then(({ data }) => {
      const current = data?.defaultModel || null;
      setExistingDefault(current);
      if (!current) {
        // No default set yet — auto-select balanced tier for convenience
        setSelectedModel(
          provider.defaultModels.find((m) => m.tier === 'balanced')?.id || provider.defaultModels[0]?.id || null,
        );
      }
      // Otherwise leave selectedModel as null so the user has to explicitly choose
    }).catch(() => {});
  }, [apiBase, provider]);

  const isOpenAI = provider.id === 'openai-codex';
  const isGoogle = provider.id === 'google-gemini-cli';
  const providerLabel = isOpenAI ? 'OpenAI' : 'Google';
  const callbackPort = isOpenAI ? '1455' : '8085';
  const nativeCliNote = nativeCliBridgeNote(provider.id);

  // Poll for auto-completion (local callback server may catch the redirect directly on VPS)
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  React.useEffect(() => {
    if ((step === 'waiting' || step === 'paste') && sessionId) {
      pollRef.current = setInterval(async () => {
        try {
          const { data } = await client.get(`${apiBase}/oauth/status/${sessionId}`);
          if (data?.status === 'complete') {
            if (pollRef.current) clearInterval(pollRef.current);
            setStep('model');
          }
        } catch {
          // ignore poll errors
        }
      }, 2000);
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [step, sessionId, apiBase]);

  const startFlow = async () => {
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, string> = { provider: provider.id };
      if (isGoogle && googleProjectId.trim()) body.googleProjectId = googleProjectId.trim();
      const { data } = await client.post(`${apiBase}/oauth/start`, body);
      if (data.success === false && data.error) {
        setFatalError(data.error);
        setStep('error');
        return;
      }
      setSessionId(data.sessionId);
      const url = data.authUrl || null;
      setAuthUrl(url);
      if (url) {
        try {
          const win = window.open(url, '_blank', 'noopener,noreferrer');
          if (!win) setPopupBlocked(true);
        } catch {
          setPopupBlocked(true);
        }
      }
      setStep('waiting');
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Failed to start sign-in';
      if (typeof msg === 'string' && (msg.includes('exited with code') || msg.includes('process'))) {
        setFatalError(msg);
        setStep('error');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const submitCallback = async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await client.post(`${apiBase}/oauth/callback`, { sessionId, callbackUrl });
      if (data.success === false) {
        setError(data.error || 'Sign-in failed. Try starting over.');
        return;
      }
      setStep('model');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to complete sign-in');
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

  // ── Shell ──
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl" style={{ maxHeight: '92vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h2 className="text-base font-semibold text-white">
            {step === 'done' ? '✓ Done' : `Set up ${provider.name}`}
          </h2>
          <button type="button" onClick={onCancel} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-5">

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

              {nativeCliNote ? (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                  <div className="font-medium text-amber-50">{nativeCliNote.title}</div>
                  <div className="mt-1 text-amber-100/90">{nativeCliNote.body}</div>
                  {nativeCliNote.command ? (
                    <div className="mt-2 text-xs text-amber-100/80">Server command: <code className="rounded bg-slate-950 px-1.5 py-0.5 text-amber-100">{nativeCliNote.command}</code></div>
                  ) : null}
                </div>
              ) : null}

              {error ? (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
              ) : null}

              <button
                type="button"
                onClick={() => { setStep('start'); }}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100 active:bg-slate-200"
              >
                I'm ready — next step
                <ChevronRight className="h-4 w-4" />
              </button>

              <button type="button" onClick={onCancel} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition">
                Cancel
              </button>
            </div>
          ) : null}

          {/* ── Step: Start OAuth ── */}
          {step === 'start' ? (
            <div className="space-y-5">
              <p className="text-sm text-slate-300">
                Click the button below to open {providerLabel} sign-in in a new tab.
              </p>

              {error ? (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
              ) : null}

              <button
                type="button"
                onClick={startFlow}
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100 active:bg-slate-200 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                Sign in with {providerLabel}
              </button>

              <button type="button" onClick={() => setStep('prereqs')} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition">
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
                onClick={() => setStep('paste')}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100 active:bg-slate-200"
              >
                <ClipboardPaste className="h-4 w-4" />
                I copied the URL — paste it now
              </button>

              <button type="button" onClick={onCancel} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition">
                Cancel
              </button>
            </div>
          ) : null}

          {/* ── Step: Paste ── */}
          {step === 'paste' ? (
            <div className="space-y-4">
              <p className="text-sm text-slate-300">
                Paste what you copied from the address bar. It starts with <code className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-emerald-300">localhost:{callbackPort}/</code>
              </p>

              <textarea
                value={callbackUrl}
                onChange={(e) => setCallbackUrl(e.target.value)}
                rows={4}
                autoFocus
                placeholder={`localhost:${callbackPort}/...?code=...&state=...`}
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

              <button type="button" onClick={() => setStep('waiting')} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition">
                ← Back
              </button>
            </div>
          ) : null}

          {/* ── Step: Model ── */}
          {step === 'model' ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-emerald-400">
                <CheckCircle2 className="h-5 w-5" />
                <span className="text-sm font-semibold">Signed in successfully!</span>
              </div>

              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                All available {provider.name} models have been added automatically. You can use any of them in the portal.
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
                      <span>
                        <a href="https://chatgpt.com/#pricing" target="_blank" rel="noreferrer" className="text-sky-400 underline hover:text-sky-300">Check ChatGPT pricing</a>
                      </span>
                    </li>
                  </ul>
                </div>
              ) : null}

              <button
                type="button"
                onClick={() => { setError(null); setFatalError(null); setStep('prereqs'); }}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow transition hover:bg-slate-100"
              >
                Try Again
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
              <h3 className="text-lg font-semibold text-white">{provider.name} connected</h3>
              <p className="text-sm text-slate-400">You're ready to use AI in the portal.</p>
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
