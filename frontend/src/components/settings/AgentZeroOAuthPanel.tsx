import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Unplug,
  X,
} from 'lucide-react';
import {
  agentRuntimeAPI,
  type AgentZeroOAuthLoginStart,
  type AgentZeroOAuthModel,
  type AgentZeroOAuthProviderId,
  type AgentZeroOAuthProviderStatus,
  type AgentZeroOAuthStatus,
} from '../../api/agentRuntime';
import TypedConfirmationDialog from '../TypedConfirmationDialog';
import { invalidateAgentChatProviderModelsCache } from '../../utils/agentChatProviderModelsCache';
import { useSettingsMutationCoordinator } from './SettingsMutationContext';

type Props = {
  owner: boolean;
  ready: boolean;
  onConnectionsChanged?: () => void;
  onBusyChange?: (busy: boolean) => void;
  onStatusChange?: (status: AgentZeroOAuthStatus) => void;
};

type DeviceAttempt = AgentZeroOAuthLoginStart & {
  flow: 'device_code';
  pollCount: number;
  pollError?: string;
};

type BrowserAttempt = AgentZeroOAuthLoginStart & {
  flow: 'browser_pkce';
  startedAt: number;
  generation: number;
};

type ActiveAttempt = DeviceAttempt | BrowserAttempt;

const PROVIDER_ORDER: AgentZeroOAuthProviderId[] = [
  'codex_oauth',
  'github_copilot_oauth',
  'gemini_api_oauth',
  'xai_grok_oauth',
];

// Agent Zero issues browser attempts with a ten-minute expiry — a live xAI
// start returned expires_at 600s out. The old two-minute ceiling here was not
// a matching bound but a truncation: it gave up on a still-valid attempt
// while the person was mid sign-in and reported it as expired.
//
// The deadline remains the *earlier* of this ceiling and the upstream expiry,
// so upstream stays authoritative and a lost callback still cannot leave
// Settings or Agent Chat permanently inert.
const BROWSER_ATTEMPT_MAX_WAIT_MS = 600_000;
const BROWSER_STATUS_POLL_MS = 2_500;

function errorMessage(error: any, fallback: string): string {
  return error?.response?.data?.error || error?.response?.data?.message || error?.message || fallback;
}

function expiryLabel(value: number): string {
  if (!value) return '';
  const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}

function providerTone(provider: AgentZeroOAuthProviderStatus): string {
  return provider.reconnectRequired
    ? 'border-amber-500/25 bg-amber-500/[0.05]'
    : provider.connected
    ? 'border-emerald-500/20 bg-emerald-500/[0.04]'
    : 'border-theme-border bg-theme-surface';
}

function disconnectedLabel(provider: AgentZeroOAuthProviderStatus): string {
  if (provider.connectionState === 'expired') return 'OAuth expired · reconnect required';
  if (provider.connectionState === 'revoked') return 'OAuth revoked · reconnect required';
  if (provider.connectionState === 'error') return 'OAuth account error · reconnect';
  return provider.authFlow === 'device_code' ? 'Device authorization' : 'Browser PKCE authorization';
}

export default function AgentZeroOAuthPanel({
  owner,
  ready,
  onConnectionsChanged,
  onBusyChange,
  onStatusChange,
}: Props) {
  const settingsMutation = useSettingsMutationCoordinator();
  const settingsClaim = settingsMutation?.claim;
  const settingsRelease = settingsMutation?.release;
  const [status, setStatus] = useState<AgentZeroOAuthStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyProvider, setBusyProvider] = useState<AgentZeroOAuthProviderId | null>(null);
  const [callbackPending, setCallbackPending] = useState(false);
  const [modelsLoadingProvider, setModelsLoadingProvider] = useState<AgentZeroOAuthProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeAttempt, setActiveAttempt] = useState<ActiveAttempt | null>(null);
  const [enterpriseDomain, setEnterpriseDomain] = useState('');
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleClientSecret, setGoogleClientSecret] = useState('');
  const [showGoogleSecret, setShowGoogleSecret] = useState(false);
  const [googleQuotaProject, setGoogleQuotaProject] = useState('');
  const [manualCallbacks, setManualCallbacks] = useState<Partial<Record<AgentZeroOAuthProviderId, string>>>({});
  const [modelsByProvider, setModelsByProvider] = useState<Partial<Record<AgentZeroOAuthProviderId, AgentZeroOAuthModel[]>>>({});
  const [modelsOpen, setModelsOpen] = useState<AgentZeroOAuthProviderId | null>(null);
  const [disconnectProvider, setDisconnectProvider] = useState<AgentZeroOAuthProviderStatus | null>(null);
  const mutationLeaseRef = useRef<{ settingsOwner: string; kind: 'attempt' | 'finite' } | null>(null);
  const browserPollGenerationRef = useRef(0);
  const browserAttemptGenerationRef = useRef(0);
  const callbackLeaseRef = useRef<Readonly<{
    providerId: AgentZeroOAuthProviderId;
    attemptId: string;
    attemptGeneration: number;
    callback: string;
  }> | null>(null);

  const claimMutationLease = useCallback((settingsOwner: string, kind: 'attempt' | 'finite') => {
    if (mutationLeaseRef.current) return false;
    if (settingsClaim && !settingsClaim(settingsOwner)) return false;
    mutationLeaseRef.current = { settingsOwner, kind };
    return true;
  }, [settingsClaim]);

  const releaseMutationLease = useCallback((settingsOwner?: string) => {
    const lease = mutationLeaseRef.current;
    if (!lease || (settingsOwner && lease.settingsOwner !== settingsOwner)) return;
    mutationLeaseRef.current = null;
    settingsRelease?.(lease.settingsOwner);
  }, [settingsRelease]);

  useEffect(() => {
    onBusyChange?.(Boolean(busyProvider || activeAttempt));
  }, [activeAttempt, busyProvider, onBusyChange]);

  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  useEffect(() => {
    if (!activeAttempt && !callbackPending && mutationLeaseRef.current?.kind === 'attempt') releaseMutationLease();
  }, [activeAttempt, callbackPending, releaseMutationLease]);

  useEffect(() => () => releaseMutationLease(), [releaseMutationLease]);

  const stopBrowserAttempt = useCallback((reason: 'operator' | 'timeout') => {
    const attempt = activeAttempt?.flow === 'browser_pkce' ? activeAttempt : null;
    if (!attempt || busyProvider || callbackLeaseRef.current) return;
    browserPollGenerationRef.current += 1;
    setActiveAttempt(null);
    setManualCallbacks((current) => ({ ...current, [attempt.providerId]: '' }));
    releaseMutationLease();
    setError(null);
    setNotice(reason === 'timeout'
      ? 'The browser authorization window expired. No callback was submitted; start a new connection when ready.'
      : 'Portal stopped waiting for that browser authorization. No callback was submitted and no account was connected.');
  }, [activeAttempt, busyProvider, releaseMutationLease]);

  const applyStatus = useCallback((next: AgentZeroOAuthStatus) => {
    // This panel is mounted in both Settings and Agent Chat. Invalidate the
    // shared catalog on every authoritative status read so a connection,
    // disconnect, expiry, or revocation cannot survive page navigation as a
    // stale selectable model.
    invalidateAgentChatProviderModelsCache('AGENT_ZERO');
    setStatus(next);
    onStatusChange?.(next);
    const connected = new Set(next.providers.filter((provider) => provider.connected).map((provider) => provider.providerId));
    setModelsByProvider((current) => {
      const retained: Partial<Record<AgentZeroOAuthProviderId, AgentZeroOAuthModel[]>> = {};
      for (const providerId of connected) {
        if (current[providerId]) retained[providerId] = current[providerId];
      }
      return retained;
    });
    setModelsOpen((current) => current && connected.has(current) ? current : null);
    setActiveAttempt((current) => current && connected.has(current.providerId) ? null : current);
  }, [onStatusChange]);

  const load = useCallback(async () => {
    if (!owner || !ready) return;
    setLoading(true);
    try {
      applyStatus(await agentRuntimeAPI.agentZeroOAuthStatus());
      setError(null);
    } catch (requestError: any) {
      setError(errorMessage(requestError, 'Agent Zero OAuth connection status could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [applyStatus, owner, ready]);

  useEffect(() => {
    if (owner && ready) {
      void load();
      return;
    }
    setStatus(null);
    setActiveAttempt(null);
    setGoogleClientSecret('');
    setManualCallbacks({});
  }, [load, owner, ready]);

  const pollDeviceAttempt = useCallback(async (attempt: DeviceAttempt) => {
    setBusyProvider(attempt.providerId);
    try {
      const result = await agentRuntimeAPI.pollAgentZeroOAuth(attempt.providerId, attempt.attemptId);
      if (result.completed) {
        if (result.status) applyStatus(result.status);
        else applyStatus(await agentRuntimeAPI.agentZeroOAuthStatus());
        setActiveAttempt(null);
        setError(null);
        setNotice(`${result.accountLabel || 'OAuth account'} connected to Agent Zero.`);
        onConnectionsChanged?.();
        return;
      }
      if (result.expired) {
        setActiveAttempt(null);
        setError('The device authorization expired. Start a new connection.');
        return;
      }
      setActiveAttempt((current) => current?.flow === 'device_code'
        && current.providerId === attempt.providerId
        && current.attemptId === attempt.attemptId
        ? {
            ...current,
            interval: result.interval,
            expiresAt: result.expiresAt || current.expiresAt,
            pollCount: current.pollCount + 1,
            pollError: undefined,
          }
        : current);
      if (result.warning) setNotice(result.warning);
      setError(null);
    } catch (requestError: any) {
      const message = errorMessage(requestError, 'Device authorization status could not be checked.');
      setActiveAttempt((current) => current?.flow === 'device_code'
        && current.providerId === attempt.providerId
        && current.attemptId === attempt.attemptId
        ? { ...current, pollError: message }
        : current);
      setError(message);
    } finally {
      setBusyProvider(null);
    }
  }, [applyStatus, onConnectionsChanged]);

  useEffect(() => {
    if (activeAttempt?.flow !== 'device_code' || activeAttempt.pollError) return undefined;
    const delay = Math.max(1, Math.min(60, activeAttempt.interval || 5)) * 1000;
    const timer = window.setTimeout(() => {
      void pollDeviceAttempt(activeAttempt);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [activeAttempt, pollDeviceAttempt]);

  useEffect(() => {
    if (activeAttempt?.flow !== 'browser_pkce') return undefined;
    const attempt = activeAttempt;
    const generation = ++browserPollGenerationRef.current;
    const upstreamExpiry = attempt.expiresAt > 0
      ? (attempt.expiresAt < 1_000_000_000_000 ? attempt.expiresAt * 1000 : attempt.expiresAt)
      : Number.POSITIVE_INFINITY;
    const deadline = Math.min(attempt.startedAt + BROWSER_ATTEMPT_MAX_WAIT_MS, upstreamExpiry);
    let timer: number | null = null;
    let stopped = false;

    const schedule = () => {
      if (stopped || generation !== browserPollGenerationRef.current) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        stopBrowserAttempt('timeout');
        return;
      }
      timer = window.setTimeout(() => { void check(); }, Math.min(BROWSER_STATUS_POLL_MS, remaining));
    };

    const check = async () => {
      if (stopped || generation !== browserPollGenerationRef.current) return;
      if (Date.now() >= deadline) {
        stopBrowserAttempt('timeout');
        return;
      }
      try {
        const next = await agentRuntimeAPI.agentZeroOAuthStatus();
        if (stopped || generation !== browserPollGenerationRef.current) return;
        const connected = next.providers.find((provider) => provider.providerId === attempt.providerId)?.connected === true;
        applyStatus(next);
        if (connected) {
          // A submitted callback owns reconciliation. Let that exact lease
          // publish success and release the Settings mutation owner once.
          if (callbackLeaseRef.current?.attemptGeneration === attempt.generation) return;
          setManualCallbacks((current) => ({ ...current, [attempt.providerId]: '' }));
          releaseMutationLease();
          setError(null);
          setNotice(`${next.providers.find((provider) => provider.providerId === attempt.providerId)?.accountLabel || 'OAuth account'} connected to Agent Zero.`);
          onConnectionsChanged?.();
          return;
        }
      } catch {
        // A transient status failure does not abandon the attempt. The bounded
        // deadline below remains authoritative and gives the operator a manual
        // Stop waiting action in the meantime.
      }
      schedule();
    };

    schedule();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [activeAttempt, applyStatus, onConnectionsChanged, releaseMutationLease, stopBrowserAttempt]);

  const orderedProviders = useMemo(() => {
    const byId = new Map(status?.providers.map((provider) => [provider.providerId, provider]) || []);
    return PROVIDER_ORDER.flatMap((id) => {
      const provider = byId.get(id);
      return provider ? [provider] : [];
    });
  }, [status]);

  const startConnection = useCallback(async (provider: AgentZeroOAuthProviderStatus) => {
    if (!owner || !ready || loading || busyProvider || activeAttempt || modelsLoadingProvider) return;
    const settingsOwner = `settings:agent-zero:oauth:${provider.providerId}:connect`;
    if (!claimMutationLease(settingsOwner, 'attempt')) return;
    const snapshot = Object.freeze({
      providerId: provider.providerId,
      displayName: provider.displayName,
      enterpriseDomain,
      googleClientId,
      googleClientSecret,
      googleQuotaProject,
    });
    let retainedAttempt = false;
    setBusyProvider(provider.providerId);
    setError(null);
    setNotice(null);
    try {
      const result = await agentRuntimeAPI.startAgentZeroOAuth({
        providerId: snapshot.providerId,
        ...(snapshot.providerId === 'github_copilot_oauth' ? { enterpriseDomain: snapshot.enterpriseDomain } : {}),
        ...(snapshot.providerId === 'gemini_api_oauth' ? {
          clientId: snapshot.googleClientId,
          clientSecret: snapshot.googleClientSecret,
          quotaProjectId: snapshot.googleQuotaProject,
        } : {}),
      });
      retainedAttempt = true;
      if (result.flow === 'device_code') {
        setActiveAttempt({ ...result, flow: 'device_code', pollCount: 0 });
        setNotice('Device authorization started. Portal will wait for the provider at its requested interval.');
      } else {
        setActiveAttempt({
          ...result,
          flow: 'browser_pkce',
          startedAt: Date.now(),
          generation: ++browserAttemptGenerationRef.current,
        });
        setNotice('Authorization started. Open the provider page, then paste the final callback below.');
      }
    } catch (requestError: any) {
      setError(errorMessage(requestError, `Could not start ${snapshot.displayName} authorization.`));
    } finally {
      if (snapshot.providerId === 'gemini_api_oauth') {
        setGoogleClientSecret('');
        setShowGoogleSecret(false);
      }
      setBusyProvider(null);
      if (!retainedAttempt) releaseMutationLease(settingsOwner);
    }
  }, [
    activeAttempt,
    busyProvider,
    enterpriseDomain,
    googleClientId,
    googleClientSecret,
    googleQuotaProject,
    loading,
    modelsLoadingProvider,
    owner,
    ready,
    claimMutationLease,
    releaseMutationLease,
  ]);

  const submitManualCallback = useCallback(async (provider: AgentZeroOAuthProviderStatus) => {
    const callback = (manualCallbacks[provider.providerId] || '').trim();
    const attempt = activeAttempt?.flow === 'browser_pkce'
      && activeAttempt.providerId === provider.providerId
      ? activeAttempt
      : null;
    if (
      !callback
      || loading
      || busyProvider
      || callbackLeaseRef.current
      || modelsLoadingProvider
      || !attempt
    ) return;
    const snapshot = Object.freeze({
      providerId: provider.providerId,
      attemptId: attempt.attemptId,
      attemptGeneration: attempt.generation,
      callback,
    });
    callbackLeaseRef.current = snapshot;
    setCallbackPending(true);
    setBusyProvider(provider.providerId);
    setError(null);
    try {
      const result = await agentRuntimeAPI.completeAgentZeroOAuthCallback(snapshot.providerId, snapshot.callback);
      if (callbackLeaseRef.current !== snapshot) return;
      if (!result.completed) throw new Error('Agent Zero did not confirm the OAuth connection.');
      const reconciled = result.status || await agentRuntimeAPI.agentZeroOAuthStatus();
      if (callbackLeaseRef.current !== snapshot) return;
      const connected = reconciled.providers.find((entry) => entry.providerId === snapshot.providerId);
      if (!connected?.connected) {
        throw new Error('Agent Zero accepted the callback but did not confirm a connected account.');
      }
      applyStatus(reconciled);
      setActiveAttempt(null);
      releaseMutationLease();
      setNotice(`${result.accountLabel || connected.accountLabel || provider.displayName} connected to Agent Zero.`);
      onConnectionsChanged?.();
    } catch (requestError: any) {
      if (callbackLeaseRef.current !== snapshot) return;
      setError(errorMessage(requestError, `${provider.displayName} callback could not be completed.`));
    } finally {
      if (callbackLeaseRef.current === snapshot) {
        callbackLeaseRef.current = null;
        setCallbackPending(false);
        setManualCallbacks((current) => ({ ...current, [snapshot.providerId]: '' }));
        setBusyProvider(null);
      }
    }
  }, [activeAttempt, applyStatus, busyProvider, loading, manualCallbacks, modelsLoadingProvider, onConnectionsChanged, releaseMutationLease]);

  const loadModels = useCallback(async (provider: AgentZeroOAuthProviderStatus) => {
    if (loading || busyProvider || activeAttempt || modelsLoadingProvider) return;
    if (modelsOpen === provider.providerId) {
      setModelsOpen(null);
      return;
    }
    setModelsLoadingProvider(provider.providerId);
    setError(null);
    try {
      const result = await agentRuntimeAPI.agentZeroOAuthModels(provider.providerId);
      setModelsByProvider((current) => ({ ...current, [provider.providerId]: result.models }));
      setModelsOpen(provider.providerId);
    } catch (requestError: any) {
      setModelsByProvider((current) => ({ ...current, [provider.providerId]: undefined }));
      setModelsOpen(null);
      if (requestError?.response?.data?.code === 'AGENT_ZERO_OAUTH_AUTHENTICATION') {
        try {
          applyStatus(await agentRuntimeAPI.agentZeroOAuthStatus());
        } catch {
          // Keep the original, sanitized model-catalog failure visible.
        }
      }
      setError(errorMessage(requestError, `${provider.displayName} models could not be loaded.`));
    } finally {
      setModelsLoadingProvider(null);
    }
  }, [activeAttempt, applyStatus, busyProvider, loading, modelsLoadingProvider, modelsOpen]);

  const copyDeviceCode = useCallback(async (code: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(code);
      setNotice('Device authorization code copied.');
    } catch {
      setError('The browser could not copy the code. Select it and copy it manually.');
    }
  }, []);

  const disconnect = useCallback(async (confirmation: string) => {
    if (!disconnectProvider || loading || busyProvider || activeAttempt || modelsLoadingProvider) return;
    const snapshot = Object.freeze({
      providerId: disconnectProvider.providerId,
      displayName: disconnectProvider.displayName,
      confirmation,
    });
    const settingsOwner = `settings:agent-zero:oauth:${snapshot.providerId}:disconnect`;
    if (!claimMutationLease(settingsOwner, 'finite')) return;
    setBusyProvider(snapshot.providerId);
    setError(null);
    try {
      const result = await agentRuntimeAPI.disconnectAgentZeroOAuth(
        snapshot.providerId,
        snapshot.confirmation,
      );
      applyStatus(result.status);
      setModelsByProvider((current) => ({ ...current, [snapshot.providerId]: undefined }));
      if (modelsOpen === snapshot.providerId) setModelsOpen(null);
      setDisconnectProvider(null);
      setNotice(result.alreadyDisconnected
        ? `${snapshot.displayName} was already disconnected.`
        : `${snapshot.displayName} OAuth credentials were removed from Agent Zero.`);
      onConnectionsChanged?.();
    } catch (requestError: any) {
      setError(errorMessage(requestError, `${snapshot.displayName} could not be disconnected.`));
    } finally {
      setBusyProvider(null);
      releaseMutationLease(settingsOwner);
    }
  }, [activeAttempt, applyStatus, busyProvider, claimMutationLease, disconnectProvider, loading, modelsLoadingProvider, modelsOpen, onConnectionsChanged, releaseMutationLease]);

  if (!owner) {
    return (
      <section className="rounded-xl border border-theme-border bg-theme-surface-raised p-4" aria-labelledby="agent-zero-oauth-title">
        <h4 id="agent-zero-oauth-title" className="flex items-center gap-2 text-sm font-semibold text-theme-text">
          <KeyRound size={16} className="text-violet-300" /> Official model OAuth
        </h4>
        <p className="mt-2 text-xs leading-5 text-theme-text-subtle">
          Only the Portal Owner can connect or remove Agent Zero model accounts.
        </p>
      </section>
    );
  }

  if (!ready) {
    return (
      <section className="rounded-xl border border-theme-border bg-theme-surface-raised p-4" aria-labelledby="agent-zero-oauth-title">
        <h4 id="agent-zero-oauth-title" className="flex items-center gap-2 text-sm font-semibold text-theme-text">
          <KeyRound size={16} className="text-violet-300" /> Official model OAuth
        </h4>
        <p className="mt-2 text-xs leading-5 text-theme-text-subtle">
          Verify the protected Agent Zero session first. OAuth accounts remain inside Agent Zero and are never returned by Portal.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border border-theme-border bg-theme-surface-raised p-4" aria-labelledby="agent-zero-oauth-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h4 id="agent-zero-oauth-title" className="flex items-center gap-2 text-sm font-semibold text-theme-text">
            <KeyRound size={16} className="text-violet-300" /> Official Agent Zero model OAuth
          </h4>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-theme-text-subtle">
            Connect Codex/ChatGPT, GitHub Copilot, Google Cloud Gemini, or xAI Grok through Agent Zero 2.5’s official OAuth plugin. Portal forwards only fixed setup operations; OAuth tokens stay in Agent Zero’s private data volume.
          </p>
        </div>
        <button type="button" onClick={() => { void load(); }} disabled={loading || callbackPending || Boolean(busyProvider || activeAttempt || modelsLoadingProvider)} className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-theme-border-strong bg-theme-surface px-3 py-2 text-xs font-medium text-theme-text transition hover:bg-theme-surface-hover disabled:opacity-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh accounts
        </button>
      </div>

      {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200" role="status">{notice}</div>}

      {loading && !status && (
        <div className="flex items-center gap-2 text-xs text-theme-text-subtle" role="status">
          <Loader2 size={15} className="animate-spin" /> Loading official OAuth providers…
        </div>
      )}

      {status && !status.available && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs leading-5 text-amber-100" role="alert">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          Agent Zero did not advertise its complete official OAuth provider catalog. No account operation is enabled.
        </div>
      )}

      {status?.available && (
        <div className="grid gap-3 xl:grid-cols-2">
          {orderedProviders.map((provider) => {
            const providerBusy = busyProvider === provider.providerId
              || modelsLoadingProvider === provider.providerId;
            const operationsLocked = Boolean(loading || busyProvider || callbackPending || activeAttempt || modelsLoadingProvider);
            const activeDevice = activeAttempt?.flow === 'device_code'
              && activeAttempt.providerId === provider.providerId
              ? activeAttempt
              : null;
            const activeBrowser = activeAttempt?.flow === 'browser_pkce'
              && activeAttempt.providerId === provider.providerId
              ? activeAttempt
              : null;
            const providerModels = modelsByProvider[provider.providerId];
            const googleReady = provider.providerId !== 'gemini_api_oauth'
              || (googleClientId.trim().length > 0 && googleClientSecret.length > 0);
            return (
              <article key={provider.providerId} className={`rounded-xl border p-4 ${providerTone(provider)}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-theme-text">
                      {provider.connected
                        ? <CheckCircle2 size={16} className="text-emerald-400" aria-hidden="true" />
                        : <Circle size={16} className="text-theme-text-muted" aria-hidden="true" />}
                      {provider.displayName}
                    </div>
                    <div className="mt-1 text-xs text-theme-text-muted">
                      {provider.connected
                        ? `Connected${provider.accountLabel ? ` · ${provider.accountLabel}` : ''}`
                        : disconnectedLabel(provider)}
                    </div>
                  </div>
                  {provider.connected && (
                    <span className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold uppercase text-emerald-200">
                      Connected
                    </span>
                  )}
                  {!provider.connected && provider.reconnectRequired && (
                    <span className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold uppercase text-amber-100">
                      Reconnect required
                    </span>
                  )}
                </div>

                {provider.note && <p className="mt-3 text-xs leading-5 text-theme-text-subtle">{provider.note}</p>}
                {provider.warning && <p className="mt-2 text-xs leading-5 text-amber-200">{provider.warning}</p>}

                {provider.usageWindows.length > 0 && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {provider.usageWindows.map((window) => (
                      <div key={window.key} className="rounded-lg border border-theme-border bg-theme-surface-raised px-3 py-2 text-xs text-theme-text-subtle">
                        <div className="flex items-center justify-between gap-2"><span>{window.title}</span><span>{Math.round(window.remainingPercent)}% left</span></div>
                        {window.label && <div className="mt-1 text-[11px] text-theme-text-muted">{window.label}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {!provider.connected && provider.supportsEnterpriseDomain && (
                  <div className="mt-3">
                    <label htmlFor={`${provider.providerId}-enterprise`} className="text-xs font-medium text-theme-text-subtle">GitHub Enterprise domain (optional)</label>
                    <input id={`${provider.providerId}-enterprise`} value={enterpriseDomain} onChange={(event) => setEnterpriseDomain(event.target.value)} disabled={operationsLocked} autoComplete="off" placeholder="github.example.com" className="mt-1 min-h-[42px] w-full rounded-lg border border-theme-border-strong bg-theme-bg px-3 text-sm text-theme-text placeholder:text-theme-text-muted outline-none focus:border-violet-400/40 disabled:opacity-50" />
                  </div>
                )}

                {!provider.connected && provider.supportsOAuthClientConfig && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <label htmlFor={`${provider.providerId}-client-id`} className="text-xs font-medium text-theme-text-subtle">Google OAuth client ID</label>
                      <input id={`${provider.providerId}-client-id`} value={googleClientId} onChange={(event) => setGoogleClientId(event.target.value)} disabled={operationsLocked} autoComplete="off" className="mt-1 min-h-[42px] w-full rounded-lg border border-theme-border-strong bg-theme-bg px-3 text-sm text-theme-text outline-none focus:border-violet-400/40 disabled:opacity-50" />
                    </div>
                    <div>
                      <label htmlFor={`${provider.providerId}-client-secret`} className="text-xs font-medium text-theme-text-subtle">Google OAuth client secret</label>
                      <div className="relative mt-1">
                        <input id={`${provider.providerId}-client-secret`} type={showGoogleSecret ? 'text' : 'password'} value={googleClientSecret} onChange={(event) => setGoogleClientSecret(event.target.value)} disabled={operationsLocked} autoComplete="off" className="min-h-[42px] w-full rounded-lg border border-theme-border-strong bg-theme-bg px-3 pr-11 text-sm text-theme-text outline-none focus:border-violet-400/40 disabled:opacity-50" />
                        <button type="button" onClick={() => setShowGoogleSecret((value) => !value)} disabled={operationsLocked} className="absolute inset-y-0 right-0 min-w-[42px] text-theme-text-muted hover:text-theme-text" aria-label={showGoogleSecret ? 'Hide Google OAuth client secret' : 'Show Google OAuth client secret'}>
                          {showGoogleSecret ? <EyeOff size={15} className="mx-auto" /> : <Eye size={15} className="mx-auto" />}
                        </button>
                      </div>
                    </div>
                    <div>
                      <label htmlFor={`${provider.providerId}-quota-project`} className="text-xs font-medium text-theme-text-subtle">Google quota project (optional)</label>
                      <input id={`${provider.providerId}-quota-project`} value={googleQuotaProject} onChange={(event) => setGoogleQuotaProject(event.target.value)} disabled={operationsLocked} autoComplete="off" className="mt-1 min-h-[42px] w-full rounded-lg border border-theme-border-strong bg-theme-bg px-3 text-sm text-theme-text outline-none focus:border-violet-400/40 disabled:opacity-50" />
                    </div>
                  </div>
                )}

                {activeDevice && (
                  <div className="mt-3 rounded-lg border border-blue-500/20 bg-blue-500/[0.06] p-3">
                    <div className="text-xs font-semibold text-blue-100">Authorize this device</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <code className="select-all rounded-lg bg-theme-surface-strong px-3 py-2 font-mono text-sm tracking-wider text-theme-text">{activeDevice.userCode}</code>
                      <button type="button" onClick={() => { void copyDeviceCode(activeDevice.userCode); }} className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-theme-border-strong bg-theme-surface px-3 text-xs text-theme-text hover:bg-theme-surface-hover"><Copy size={14} /> Copy code</button>
                      <a href={activeDevice.verificationUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-blue-500/25 bg-blue-500/10 px-3 text-xs text-blue-100 hover:bg-blue-500/20">Open provider <ExternalLink size={14} /></a>
                    </div>
                    <p className="mt-2 text-[11px] leading-5 text-theme-text-muted">
                      Waiting every {activeDevice.interval} seconds{expiryLabel(activeDevice.expiresAt) ? ` · expires ${expiryLabel(activeDevice.expiresAt)}` : ''}.
                    </p>
                    {activeDevice.pollError && (
                      <button type="button" onClick={() => { void pollDeviceAttempt(activeDevice); }} disabled={providerBusy} className="mt-2 inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 text-xs text-amber-100 disabled:opacity-50">
                        {providerBusy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Retry authorization check
                      </button>
                    )}
                  </div>
                )}

                {activeBrowser && (
                  <div className="mt-3 rounded-lg border border-blue-500/20 bg-blue-500/[0.06] p-3">
                    <div className="text-xs font-semibold text-blue-100">Complete browser authorization</div>
                    <a href={activeBrowser.authUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-blue-500/25 bg-blue-500/10 px-3 text-xs text-blue-100 hover:bg-blue-500/20">Open authorization page <ExternalLink size={14} /></a>
                    <p className="mt-2 text-[11px] leading-5 text-theme-text-muted">
                      The provider may finish on a loopback page your browser cannot reach. Copy the final callback URL from the address bar and paste it once below. Portal does not save it.
                    </p>
                    <label htmlFor={`${provider.providerId}-callback`} className="mt-2 block text-xs font-medium text-theme-text-subtle">Final callback URL or value</label>
                    <textarea id={`${provider.providerId}-callback`} value={manualCallbacks[provider.providerId] || ''} onChange={(event) => setManualCallbacks((current) => ({ ...current, [provider.providerId]: event.target.value }))} disabled={providerBusy} maxLength={8192} autoComplete="off" spellCheck={false} rows={2} className="mt-1 w-full rounded-lg border border-theme-border-strong bg-theme-bg px-3 py-2 font-mono text-xs text-theme-text outline-none focus:border-violet-400/40 disabled:opacity-50" />
                    <button type="button" onClick={() => { void submitManualCallback(provider); }} disabled={providerBusy || callbackPending || !(manualCallbacks[provider.providerId] || '').trim()} aria-busy={callbackPending && busyProvider === provider.providerId} className="mt-2 inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-100 hover:bg-emerald-500/20 disabled:opacity-45">
                      {providerBusy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Complete connection
                    </button>
                    <button
                      type="button"
                      onClick={() => stopBrowserAttempt('operator')}
                      disabled={providerBusy}
                      className="mt-2 ml-2 inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-theme-border-strong bg-theme-surface px-3 text-xs font-medium text-theme-text-subtle hover:bg-theme-surface-hover hover:text-theme-text disabled:opacity-45"
                    >
                      <X size={14} /> Stop waiting
                    </button>
                    <p className="mt-2 text-[11px] leading-5 text-theme-text-muted">
                      Portal releases this attempt after two minutes if no callback arrives. Stopping only discards the unsubmitted callback; it never connects an account.
                    </p>
                  </div>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  {!provider.connected && !activeDevice && !activeBrowser && (
                    <button type="button" onClick={() => { void startConnection(provider); }} disabled={operationsLocked || !googleReady} className="inline-flex min-h-[42px] items-center gap-2 rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 text-xs font-medium text-violet-100 hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-45">
                      {providerBusy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Connect {provider.shortName}
                    </button>
                  )}
                  {provider.connected && (
                    <>
                      <button type="button" onClick={() => { void loadModels(provider); }} disabled={operationsLocked} className="inline-flex min-h-[42px] items-center gap-2 rounded-lg border border-theme-border-strong bg-theme-surface px-3 text-xs text-theme-text hover:bg-theme-surface-hover disabled:opacity-45">
                        {providerBusy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} {modelsOpen === provider.providerId ? 'Hide models' : 'View models'}
                      </button>
                      <button type="button" onClick={() => setDisconnectProvider(provider)} disabled={operationsLocked} className="inline-flex min-h-[42px] items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3 text-xs text-red-200 hover:bg-red-500/15 disabled:opacity-45">
                        <Unplug size={14} /> Disconnect
                      </button>
                    </>
                  )}
                </div>

                {modelsOpen === provider.providerId && providerModels && (
                  <div className="mt-3 rounded-lg border border-theme-border bg-theme-surface-raised p-3" role="region" aria-label={`${provider.displayName} models`}>
                    <div className="text-xs font-semibold text-theme-text">Available models</div>
                    {providerModels.length > 0 ? (
                      <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">
                        {providerModels.map((model) => (
                          <li key={model.id} className="rounded-lg border border-theme-border bg-theme-surface px-3 py-2">
                            <div className="text-xs font-medium text-theme-text">{model.displayName}</div>
                            <div className="mt-0.5 font-mono text-[11px] text-theme-text-muted">{model.id}</div>
                            {model.description && <div className="mt-1 text-[11px] leading-5 text-theme-text-muted">{model.description}</div>}
                          </li>
                        ))}
                      </ul>
                    ) : <p className="mt-2 text-xs text-theme-text-muted">Agent Zero returned no models for this account.</p>}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <div className="flex items-start gap-2 rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-xs leading-5 text-theme-text-subtle">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-violet-300" />
        OAuth account files are owned by Agent Zero. Portal never reads or returns access tokens, refresh tokens, or rotating auth files, and it exposes no arbitrary Agent Zero proxy path.
      </div>

      <TypedConfirmationDialog
        open={Boolean(disconnectProvider)}
        title={`Disconnect ${disconnectProvider?.displayName || 'OAuth account'}?`}
        description="This removes the account's OAuth credentials from Agent Zero. Any model slots using that account will stop working until it is connected again."
        confirmationPhrase={status?.actions.disconnect.confirmationPhrase}
        confirmLabel="Disconnect account"
        tone="danger"
        busy={Boolean(disconnectProvider && busyProvider === disconnectProvider.providerId)}
        onCancel={() => { if (!busyProvider && !activeAttempt && !modelsLoadingProvider) setDisconnectProvider(null); }}
        onConfirm={(confirmation) => { void disconnect(confirmation); }}
      />
    </section>
  );
}
