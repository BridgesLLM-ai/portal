import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Circle,
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  KeyRound,
  RefreshCw,
  ServerCog,
  ShieldAlert,
  Wrench,
  X,
} from 'lucide-react';
import {
  agentRuntimeAPI,
  type AgentZeroOAuthStatus,
  type AgentZeroSetupStatus,
  type AgentZeroSetupSurface,
} from '../../api/agentRuntime';
import { useAuthStore } from '../../contexts/AuthContext';
import { isOwner } from '../../utils/authz';
import { invalidateAgentChatProviderModelsCache } from '../../utils/agentChatProviderModelsCache';
import TypedConfirmationDialog from '../TypedConfirmationDialog';
import ViewportModal from '../ViewportModal';
import {
  agentZeroSurfaceLabel,
  completedAgentZeroSetupSteps,
  nextAgentZeroSetupAction,
} from './agentZeroSetupContract';
import AgentZeroOAuthPanel from './AgentZeroOAuthPanel';
import { useSettingsMutationCoordinator } from './SettingsMutationContext';

type PendingAction = 'credentials' | 'runtime' | null;

type Props = {
  view?: 'runtime' | 'providers';
  compact?: boolean;
  onOpenProviderSettings?: () => void;
  onOpenRuntimeSettings?: () => void;
  onProviderConnectionsChanged?: () => void;
};

function responseStatus(error: any): AgentZeroSetupStatus | null {
  const direct = error?.response?.data;
  if (direct?.mainAgentChat && direct?.projectSandbox) return direct;
  if (direct?.status?.mainAgentChat && direct?.status?.projectSandbox) return direct.status;
  return null;
}

function errorMessage(error: any, fallback: string): string {
  return error?.response?.data?.error || error?.response?.data?.message || error?.message || fallback;
}

function SurfaceChecklist({ surface }: { surface: AgentZeroSetupSurface }) {
  return (
    <div className="space-y-2">
      {surface.steps.map((step) => (
        <div key={step.code} className="flex items-start gap-2 rounded-lg border border-white/[0.06] bg-black/10 px-3 py-2.5">
          {step.complete
            ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden="true" />
            : <Circle size={16} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />}
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-200">{step.label}</div>
            <div className="mt-0.5 text-xs leading-5 text-slate-500">{step.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AgentZeroSetupPanel({
  view = 'runtime',
  compact = false,
  onOpenProviderSettings,
  onOpenRuntimeSettings,
  onProviderConnectionsChanged,
}: Props) {
  const settingsMutation = useSettingsMutationCoordinator();
  const settingsClaim = settingsMutation?.claim;
  const settingsRelease = settingsMutation?.release;
  const user = useAuthStore((state) => state.user);
  const owner = isOwner(user);
  const [status, setStatus] = useState<AgentZeroSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [providerAccountsOpen, setProviderAccountsOpen] = useState(false);
  const [providerAccountsBusy, setProviderAccountsBusy] = useState(false);
  const [providerAccountStatus, setProviderAccountStatus] = useState<AgentZeroOAuthStatus | null>(null);
  const [providerAccountStatusLoading, setProviderAccountStatusLoading] = useState(view === 'providers');
  const providerDialogTitleId = useId();
  const providerDialogCloseRef = useRef<HTMLButtonElement>(null);
  const runtimeMutationRef = useRef<{ settingsOwner: string } | null>(null);

  const beginRuntimeMutation = useCallback((settingsOwner: string) => {
    if (runtimeMutationRef.current) return false;
    if (settingsClaim && !settingsClaim(settingsOwner)) return false;
    runtimeMutationRef.current = { settingsOwner };
    return true;
  }, [settingsClaim]);

  const finishRuntimeMutation = useCallback((settingsOwner: string) => {
    if (runtimeMutationRef.current?.settingsOwner !== settingsOwner) return;
    runtimeMutationRef.current = null;
    settingsRelease?.(settingsOwner);
  }, [settingsRelease]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await agentRuntimeAPI.agentZeroStatus());
      setError(null);
    } catch (requestError: any) {
      setError(errorMessage(requestError, 'Agent Zero setup status could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const oauthReady = Boolean(status?.runtime.protocolReady && status.authentication.authenticated);

  useEffect(() => {
    let cancelled = false;
    if (view !== 'providers' || !owner || !oauthReady) {
      setProviderAccountStatus(null);
      setProviderAccountStatusLoading(false);
      return () => { cancelled = true; };
    }
    setProviderAccountStatusLoading(true);
    void agentRuntimeAPI.agentZeroOAuthStatus()
      .then((next) => {
        if (cancelled) return;
        invalidateAgentChatProviderModelsCache('AGENT_ZERO');
        setProviderAccountStatus(next);
      })
      .catch(() => {
        if (!cancelled) setProviderAccountStatus(null);
      })
      .finally(() => {
        if (!cancelled) setProviderAccountStatusLoading(false);
      });
    return () => { cancelled = true; };
  }, [oauthReady, owner, view]);

  const verifyAuthentication = useCallback(async () => {
    const settingsOwner = 'settings:agent-zero:verify-authentication';
    if (!owner || !beginRuntimeMutation(settingsOwner)) return;
    setBusy(true);
    setNotice(null);
    try {
      const next = await agentRuntimeAPI.verifyAgentZeroAuthentication();
      setStatus(next);
      setError(null);
      setNotice(next.mainAgentChat.providerEnabled
        ? 'Protected Agent Zero authentication verified. Host Agent Chat is ready.'
        : 'Protected Agent Zero authentication verified. Remaining setup gates are still closed.');
    } catch (requestError: any) {
      const next = responseStatus(requestError);
      if (next) setStatus(next);
      setError(errorMessage(requestError, 'Agent Zero authentication verification failed.'));
    } finally {
      setBusy(false);
      finishRuntimeMutation(settingsOwner);
    }
  }, [beginRuntimeMutation, finishRuntimeMutation, owner]);

  const confirmAction = useCallback(async (confirmation: string) => {
    if (!owner || !pendingAction) return;
    const snapshot = Object.freeze({
      action: pendingAction,
      username,
      password,
      confirmation,
    });
    const settingsOwner = `settings:agent-zero:${snapshot.action}`;
    if (!beginRuntimeMutation(settingsOwner)) return;
    setBusy(true);
    setNotice(null);
    try {
      if (snapshot.action === 'credentials') {
        const result = await agentRuntimeAPI.provisionAgentZeroCredentials({
          username: snapshot.username,
          password: snapshot.password,
          confirmation: snapshot.confirmation,
        });
        setStatus(result.status);
        setUsername('');
        setPassword('');
        setShowPassword(false);
        setNotice(result.verified
          ? 'Credentials saved in the protected server file and authentication verified.'
          : 'Credentials saved. Reconcile the managed runtime before authentication can be verified.');
      } else {
        const result = await agentRuntimeAPI.reconcileAgentZeroRuntime(snapshot.confirmation);
        setStatus(result.status);
        setNotice(result.message);
      }
      setError(null);
      setPendingAction(null);
    } catch (requestError: any) {
      const next = responseStatus(requestError);
      if (next) setStatus(next);
      setError(errorMessage(requestError, `Agent Zero ${snapshot.action === 'credentials' ? 'credential save' : 'runtime setup'} failed.`));
    } finally {
      setBusy(false);
      finishRuntimeMutation(settingsOwner);
    }
  }, [beginRuntimeMutation, finishRuntimeMutation, owner, password, pendingAction, username]);

  useEffect(() => () => {
    const settingsOwner = runtimeMutationRef.current?.settingsOwner;
    if (settingsOwner) settingsRelease?.(settingsOwner);
    runtimeMutationRef.current = null;
  }, [settingsRelease]);

  const progress = useMemo(() => status ? completedAgentZeroSetupSteps(status) : null, [status]);
  const nextAction = status ? nextAgentZeroSetupAction(status) : null;
  const credentialsValid = username.length > 0 && password.length >= 12;

  if (loading && !status) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] p-5 text-sm text-slate-400">
        <Loader2 size={17} className="animate-spin" /> {view === 'providers' ? 'Loading Agent Zero model accounts…' : 'Inspecting Agent Zero setup gates…'}
      </div>
    );
  }

  if (!status) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-200" role="alert">
        {error || 'Agent Zero setup status is unavailable.'}
        <button type="button" onClick={() => { void load(); }} className="ml-3 underline underline-offset-2">Retry</button>
      </div>
    );
  }

  if (view === 'providers') {
    const connectedAccountCount = providerAccountStatus?.connectedCount || 0;
    const hasConnectedAccounts = oauthReady
      && providerAccountStatus?.available === true
      && connectedAccountCount > 0;
    const accountStateLabel = !owner
      ? 'Owner access required'
      : !oauthReady
        // peers say whether they are connected, not what internal
        // component is missing. "Runtime setup required" was the last piece of
        // our vocabulary left on this card.
        ? 'Not connected'
        : providerAccountStatusLoading
          ? 'Checking accounts…'
          : !providerAccountStatus?.available
            ? 'Account status unavailable'
            : connectedAccountCount > 0
              ? `${connectedAccountCount} account${connectedAccountCount === 1 ? '' : 's'} connected`
              : 'No accounts connected';
    const accountBadgeTone = hasConnectedAccounts
      ? 'bg-emerald-500/15 text-emerald-300'
      : oauthReady && !providerAccountStatusLoading
        ? 'bg-amber-500/15 text-amber-300'
        : 'bg-slate-700/50 text-slate-300';

    return (
      <>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={providerAccountsOpen}
          onClick={() => setProviderAccountsOpen(true)}
          className={compact
            ? 'group flex w-full items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2.5 text-left transition hover:border-slate-600 hover:bg-slate-800/60 active:bg-slate-800'
            : 'group relative flex flex-col rounded-xl border border-slate-800 bg-slate-950/60 p-5 text-left transition hover:border-slate-600 hover:bg-slate-900/80 active:bg-slate-900'}
        >
          {compact ? (
            <>
              <span className={`h-2 w-2 shrink-0 rounded-full ${hasConnectedAccounts ? 'bg-emerald-400' : 'bg-violet-500/50'}`} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white">Agent Zero</span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${accountBadgeTone}`}>
                    {accountStateLabel}
                  </span>
                </span>
                <span className="block text-[11px] text-slate-400">
                  Self-hosted alternative to OpenClaw · {oauthReady ? 'Ready' : 'Needs setup'}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-600 transition group-hover:text-slate-400" aria-hidden="true" />
            </>
          ) : (
            <>
              <span className="flex items-center gap-3">
                <span className={`h-3 w-3 shrink-0 rounded-full ${hasConnectedAccounts ? 'bg-emerald-400' : 'bg-violet-500/50'}`} aria-hidden="true" />
                <span className="text-base font-semibold text-white">Agent Zero</span>
                {hasConnectedAccounts
                  ? <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                  : oauthReady
                    ? <Circle className="h-4 w-4 text-violet-300" aria-hidden="true" />
                    : <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden="true" />}
              </span>
              <span className={`mt-2 inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${accountBadgeTone}`}>
                <KeyRound size={12} aria-hidden="true" /> {accountStateLabel}
              </span>
              <span className="mt-3 text-sm font-medium text-slate-300">Self-hosted alternative to OpenClaw</span>
              <span className="mt-1 text-sm leading-relaxed text-slate-500">
                Runs on this server and connects your Codex, GitHub Copilot, Google Gemini, or Grok
                account for use in Agent Chat, the same as any other provider.
              </span>
              {error && <span className="mt-3 text-xs text-red-300" role="alert">{error}</span>}
              <span className="mt-4 flex items-center gap-1 text-sm font-medium text-emerald-400 transition group-hover:text-emerald-300">
                {hasConnectedAccounts ? 'Reconfigure' : 'Set up'} <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </span>
            </>
          )}
        </button>

        <ViewportModal
          open={providerAccountsOpen}
          onDismiss={() => setProviderAccountsOpen(false)}
          dismissible={!providerAccountsBusy}
          initialFocusRef={providerDialogCloseRef}
          className="bg-black/70 p-3 backdrop-blur-sm sm:p-5"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={providerDialogTitleId}
            className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface text-theme-text shadow-2xl shadow-black/50"
          >
            <div className="flex shrink-0 items-start gap-3 border-b border-theme-border px-4 py-4 sm:px-5">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-violet-500/20 bg-violet-500/10 text-violet-300">
                <KeyRound size={18} aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 id={providerDialogTitleId} className="text-base font-semibold text-theme-text">Agent Zero model accounts</h2>
                <p className="mt-1 text-xs leading-5 text-theme-text-muted">Connect and inspect the official OAuth accounts used by Agent Zero. Tokens remain inside its private data volume.</p>
              </div>
              <button
                ref={providerDialogCloseRef}
                type="button"
                aria-label="Close Agent Zero model accounts"
                disabled={providerAccountsBusy}
                onClick={() => setProviderAccountsOpen(false)}
                className="grid min-h-[40px] min-w-[40px] place-items-center rounded-lg text-theme-text-muted transition hover:bg-theme-surface-hover hover:text-theme-text disabled:cursor-wait disabled:opacity-45"
              >
                <X size={17} />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-5">
              {!oauthReady && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs leading-5 text-amber-100">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                  Finish the protected Agent Zero runtime and authentication checks under Agents before connecting a model account.
                </div>
              )}
              <AgentZeroOAuthPanel
                owner={owner}
                ready={oauthReady}
                onBusyChange={setProviderAccountsBusy}
                onStatusChange={setProviderAccountStatus}
                onConnectionsChanged={onProviderConnectionsChanged}
              />
            </div>

            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-theme-border bg-theme-bg px-4 py-3 sm:px-5">
              <span className="text-[11px] text-theme-text-muted">Runtime controls stay under Agents.</span>
              {onOpenRuntimeSettings ? (
                <button
                  type="button"
                  disabled={providerAccountsBusy}
                  onClick={() => {
                    setProviderAccountsOpen(false);
                    onOpenRuntimeSettings();
                  }}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-medium text-theme-text transition hover:bg-theme-surface-hover disabled:cursor-wait disabled:opacity-45"
                >
                  <ServerCog size={14} /> Runtime setup
                </button>
              ) : (
                <a
                  href="/settings?tab=agents"
                  aria-disabled={providerAccountsBusy || undefined}
                  tabIndex={providerAccountsBusy ? -1 : undefined}
                  onClick={(event) => {
                    if (providerAccountsBusy) event.preventDefault();
                  }}
                  className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-medium text-theme-text transition ${providerAccountsBusy ? 'pointer-events-none cursor-wait opacity-45' : 'hover:bg-theme-surface-hover'}`}
                >
                  <ServerCog size={14} /> Runtime setup
                </a>
              )}
            </div>
          </div>
        </ViewportModal>
      </>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-5" aria-labelledby="agent-zero-setup-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="agent-zero-setup-title" className="text-sm font-semibold text-white">Agent Zero 2.5</h3>
            <span className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold uppercase text-amber-200">
              {agentZeroSurfaceLabel(status)}
            </span>
          </div>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-slate-400">
            Portal manages the pinned Agent Zero {status.testedVersions.agentZero} runtime, connector {status.testedVersions.connector}, and official A0 {status.testedVersions.hostBridge} bridge. Host availability is derived from live protected component checks, never a blind enable flag.
          </p>
        </div>
        <button type="button" onClick={() => { void load(); }} disabled={loading || busy} className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/10 disabled:opacity-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200" role="status">{notice}</div>}

      <div className="rounded-lg border border-sky-500/25 bg-sky-500/[0.06] px-3 py-2 text-[11px] leading-5 text-sky-100">
        <span className="font-semibold">Where to use Agent Zero.</span> Agent Zero runs inside Agent Chat (and qualified Project Chat), authenticated per Portal user. Its full web UI is also available from the Remote Desktop: the &ldquo;Agent Zero (Web UI)&rdquo; icon opens it already signed in through a click-time backend session exchange, so no Agent Zero credential is ever stored on the desktop.
      </div>

      <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-5 text-amber-100">
        <span className="font-semibold">Models in the Agent Zero web UI.</span> The web UI keeps its own model configuration and ships with an OpenRouter default, so it shows a &ldquo;Missing API Key for model presets&rdquo; notice until you give it a model. Connecting Codex or another provider under <span className="font-medium">AI Providers</span> powers <span className="font-medium">Agent Chat and qualified Project Chat</span> — that is where a Portal-connected model runs, and it intentionally does not change the standalone web UI&rsquo;s own presets. To use the web UI directly, open its Settings and point the Default/Main preset at a provider you hold a key for (for example an OpenRouter or OpenAI key).
      </div>

      <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] p-4">
        <div className="flex items-start gap-3">
          <ShieldAlert size={19} className="mt-0.5 shrink-0 text-red-300" aria-hidden="true" />
          <div>
            <div className="text-sm font-semibold text-red-100">Main Agent Chat is intentional full-host access</div>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              When released, Owner and Sub Admin Agent Chats can read, write, and execute across the server so they can repair OpenClaw and the host. This is not the Project sandbox.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-xl border border-white/[0.08] bg-black/10 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-white"><ServerCog size={16} className="text-amber-300" /> Main Agent Chat</div>
              <div className="mt-1 text-xs text-slate-500">HOST_OPERATOR · {progress?.complete}/{progress?.total} gates complete</div>
            </div>
            <span className={`rounded-lg border px-2 py-1 text-[11px] font-semibold ${status.mainAgentChat.providerEnabled ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200' : 'border-amber-500/20 bg-amber-500/10 text-amber-200'}`}>
              {status.mainAgentChat.providerEnabled ? 'Selectable' : 'Not selectable'}
            </span>
          </div>
          <p className="mb-3 text-xs leading-5 text-slate-400">{status.mainAgentChat.reason}</p>
          <SurfaceChecklist surface={status.mainAgentChat} />
        </div>

        <div className="rounded-xl border border-cyan-500/15 bg-cyan-500/[0.03] p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-white"><LockKeyhole size={16} className="text-cyan-300" /> Project Chat</div>
              <div className="mt-1 text-xs text-slate-500">PROJECT_SANDBOX · separate adapter</div>
            </div>
            <span className={`rounded-lg border px-2 py-1 text-[11px] font-semibold ${status.projectSandbox.providerEnabled ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200' : 'border-slate-500/20 bg-slate-500/10 text-slate-300'}`}>
              {status.projectSandbox.providerEnabled ? 'Selectable' : 'Unavailable'}
            </span>
          </div>
          <p className="mb-3 text-xs leading-5 text-slate-400">{status.projectSandbox.reason}</p>
          <SurfaceChecklist surface={status.projectSandbox} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="rounded-xl border border-white/[0.08] bg-black/10 p-4">
          <div className="text-sm font-semibold text-white">Protected server login</div>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Credentials are written to a root-only file and used only to create a protected server-side session. Existing values are never displayed or returned by the API.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="agent-zero-username" className="text-xs font-medium text-slate-300">Agent Zero username</label>
              <input id="agent-zero-username" value={username} onChange={(event) => setUsername(event.target.value)} disabled={!owner || busy} autoComplete="off" className="mt-1 min-h-[44px] w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-amber-400/40 disabled:opacity-50" />
            </div>
            <div>
              <label htmlFor="agent-zero-password" className="text-xs font-medium text-slate-300">Agent Zero password</label>
              <div className="relative mt-1">
                <input id="agent-zero-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} disabled={!owner || busy} autoComplete="new-password" className="min-h-[44px] w-full rounded-lg border border-white/10 bg-black/20 px-3 pr-11 text-sm text-white outline-none focus:border-amber-400/40 disabled:opacity-50" />
                <button type="button" onClick={() => setShowPassword((value) => !value)} disabled={!owner || busy} className="absolute inset-y-0 right-0 min-w-[44px] text-slate-400 hover:text-white" aria-label={showPassword ? 'Hide Agent Zero password' : 'Show Agent Zero password'}>
                  {showPassword ? <EyeOff size={16} className="mx-auto" /> : <Eye size={16} className="mx-auto" />}
                </button>
              </div>
            </div>
          </div>
          <button type="button" onClick={() => setPendingAction('credentials')} disabled={!owner || busy || !credentialsValid} className="mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-100 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-45">
            {busy && pendingAction === 'credentials' ? <Loader2 size={15} className="animate-spin" /> : <LockKeyhole size={15} />}
            Save protected credentials
          </button>
          {!owner && <p className="mt-2 text-xs text-amber-200">Only the Portal Owner can change Agent Zero credentials or host components.</p>}
        </div>

        <div className="flex min-w-[15rem] flex-col gap-2 rounded-xl border border-white/[0.08] bg-black/10 p-4">
          <div className="text-sm font-semibold text-white">Next safe action</div>
          <div className="text-xs leading-5 text-slate-500">
            {nextAction === 'credentials' && 'Save protected credentials first.'}
            {nextAction === 'reconcile' && 'Install or repair the exact managed runtime and host bridge.'}
            {nextAction === 'verify' && 'Verify the protected connector session.'}
            {nextAction === 'unavailable' && `Host Agent Chat is unavailable: ${status.mainAgentChat.reason}`}
            {nextAction === 'ready' && 'Host Agent Chat is ready. OAuth model accounts can now be connected under AI Providers.'}
          </div>
          <button type="button" onClick={() => setPendingAction('runtime')} disabled={!owner || busy || !status.credentials.configured} className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-blue-500/25 bg-blue-500/10 px-4 py-2 text-sm font-medium text-blue-100 transition hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-45">
            <Wrench size={15} /> Reconcile runtime
          </button>
          <button type="button" onClick={() => { void verifyAuthentication(); }} disabled={!owner || busy || !status.actions.verifyAuthentication.available} className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-45">
            {busy && !pendingAction ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
            Verify authentication
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-violet-500/20 bg-violet-500/[0.035] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-violet-100">Agent Zero model accounts</div>
          <p className="mt-1 text-xs leading-5 text-slate-400">OAuth connections and model discovery live in the canonical AI Providers settings.</p>
        </div>
        {onOpenProviderSettings ? (
          <button type="button" onClick={onOpenProviderSettings} className="inline-flex min-h-[40px] shrink-0 items-center justify-center gap-2 rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 py-2 text-xs font-medium text-violet-100 transition hover:bg-violet-500/20">
            Open AI Providers
          </button>
        ) : (
          <a href="/settings?tab=ai-providers" className="inline-flex min-h-[40px] shrink-0 items-center justify-center gap-2 rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 py-2 text-xs font-medium text-violet-100 transition hover:bg-violet-500/20">
            Open AI Providers
          </a>
        )}
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs leading-5 text-amber-100">
        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
        There is deliberately no blind Enable button. Host availability follows live protected component checks; Project Chat stays unavailable until its separate model-egress, isolation, replay, abort, and provider-switch qualification passes.
      </div>

      <TypedConfirmationDialog
        open={pendingAction === 'credentials'}
        title="Replace protected Agent Zero credentials?"
        description="This replaces the root-only login file and reloads the managed Agent Zero container when it is installed. A failed verification restores the previous file."
        confirmationPhrase={status.actions.provisionCredentials.confirmationPhrase}
        confirmLabel="Save and verify"
        busy={busy}
        onCancel={() => { if (!busy) setPendingAction(null); }}
        onConfirm={(confirmation) => { void confirmAction(confirmation); }}
      />
      <TypedConfirmationDialog
        open={pendingAction === 'runtime'}
        title="Install or repair Agent Zero?"
        description="Portal will converge the pinned Agent Zero 2.5 container, connector, persistent volume, and official A0 2.5 host bridge. The provider stays disabled afterward."
        confirmationPhrase={status.actions.reconcileRuntime.confirmationPhrase}
        confirmLabel="Reconcile runtime"
        busy={busy}
        onCancel={() => { if (!busy) setPendingAction(null); }}
        onConfirm={(confirmation) => { void confirmAction(confirmation); }}
      />
    </section>
  );
}
