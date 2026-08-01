import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronRight, Cpu, Loader2, RefreshCw, Trash2, X } from 'lucide-react';
import client from '../../api/client';
import ViewportModal from '../ViewportModal';
import ApiKeySetupFlow from './ApiKeySetupFlow';
import AwsSdkSetupFlow from './AwsSdkSetupFlow';
import DeviceCodeFlow from './DeviceCodeFlow';
import NativeCliSetupFlow from './NativeCliSetupFlow';
import OAuthSetupFlow from './OAuthSetupFlow';
import OpenClawProviderPicker from './OpenClawProviderPicker';
import ProviderAuthChoice from './ProviderAuthChoice';
import type { ProviderStatus } from './ProviderCard';
import QuickStartBanner from './QuickStartBanner';
import SetupTokenFlow from './SetupTokenFlow';
import { getProviderConfig, parseProviderCatalog, type ProviderAuthType, type ProviderUIConfig } from './providerConfig';
import { getProviderRemovalConfirmation } from './providerRemovalContract';
import { useSettingsMutationCoordinator } from '../settings/SettingsMutationContext';

interface AiSetupStatusResponse {
  openclawInstalled: boolean;
  openclawVersion: string | null;
  gatewayRunning: boolean;
  providers: ProviderStatus[];
  defaultModel: string | null;
  fallbackModels: string[];
  configuredProfileCount: number;
  activeProfiles: string[];
}

interface AiProviderSetupProps {
  mode: 'wizard' | 'settings';
  apiBase: string;
  onComplete?: () => void;
  compact?: boolean;
  onNativeModelSelected?: (provider: 'GEMINI', model: string) => Promise<boolean | void> | boolean | void;
  additionalProviderCards?: ReactNode;
}

export default function AiProviderSetup({ mode, apiBase, onComplete, compact = false, onNativeModelSelected, additionalProviderCards }: AiProviderSetupProps) {
  const settingsMutation = useSettingsMutationCoordinator();
  const settingsClaim = settingsMutation?.claim;
  const settingsRelease = settingsMutation?.release;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AiSetupStatusResponse | null>(null);
  const [providers, setProviders] = useState<ProviderUIConfig[]>([]);
  const [activeSetup, setActiveSetup] = useState<ProviderUIConfig | null>(null);
  const [activeAuthType, setActiveAuthType] = useState<ProviderAuthType | null>(null);
  const [activeDeviceFlow, setActiveDeviceFlow] = useState(false);
  const [activeNativeCliFlow, setActiveNativeCliFlow] = useState<'claude-code' | 'codex' | 'gemini' | 'grok' | null>(null);
  const [showProviderPicker, setShowProviderPicker] = useState(false);
  const [removalTarget, setRemovalTarget] = useState<{
    provider: ProviderUIConfig;
    operationId: string;
  } | null>(null);
  const [removalConfirmation, setRemovalConfirmation] = useState('');
  const [removingProvider, setRemovingProvider] = useState(false);
  const [removalError, setRemovalError] = useState<string | null>(null);
  const settingsFlowOwnerRef = useRef<string | null>(null);

  const claimSettingsFlow = useCallback((settingsOwner: string) => {
    if (settingsFlowOwnerRef.current) return false;
    if (settingsClaim && !settingsClaim(settingsOwner)) return false;
    settingsFlowOwnerRef.current = settingsOwner;
    return true;
  }, [settingsClaim]);

  const releaseSettingsFlow = useCallback(() => {
    const settingsOwner = settingsFlowOwnerRef.current;
    if (!settingsOwner) return;
    settingsFlowOwnerRef.current = null;
    settingsRelease?.(settingsOwner);
  }, [settingsRelease]);

  const loadStatus = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const [statusResponse, catalogResponse] = await Promise.all([
        client.get<AiSetupStatusResponse>(`${apiBase}/status`, {
          params: silent ? { refreshProviderReadiness: '1' } : undefined,
        }),
        client.get<unknown>(`${apiBase}/catalog`),
      ]);
      setStatus(statusResponse.data);
      setProviders(parseProviderCatalog(catalogResponse.data));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load AI provider status');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const statusMap = useMemo(
    () => new Map((status?.providers || []).map((p) => [p.id, p])),
    [status?.providers],
  );

  const beginProviderSetup = (provider: ProviderUIConfig | null) => {
    setActiveSetup(provider);
    setActiveAuthType(provider?.authOptions?.length ? null : (provider?.primaryAuthType || null));
  };

  const beginOwnedProviderSetup = (provider: ProviderUIConfig) => {
    if (provider.guidedSetup.status !== 'available') return false;
    if (!claimSettingsFlow(`settings:ai-provider:${provider.id}`)) return false;
    beginProviderSetup(provider);
    return true;
  };

  const closeProviderSetup = () => {
    setActiveSetup(null);
    setActiveAuthType(null);
    releaseSettingsFlow();
  };

  const closeDeviceFlow = () => {
    setActiveDeviceFlow(false);
    releaseSettingsFlow();
  };

  const closeNativeCliFlow = () => {
    setActiveNativeCliFlow(null);
    releaseSettingsFlow();
  };

  const handleCardChoose = (id: string) => {
    if (id === 'openclaw') {
      setShowProviderPicker(true);
      return;
    }
    if (id === 'github-copilot') {
      if (!claimSettingsFlow('settings:ai-provider:github-copilot')) return;
      setActiveDeviceFlow(true);
      return;
    }
    const provider = getProviderConfig(providers, id);
    if (provider) beginOwnedProviderSetup(provider);
  };

  const handleComplete = async () => {
    await loadStatus(true);
    onComplete?.();
    // Don't auto-advance the wizard — let user add more providers first
  };

  const handleNativeCliLogin = (nativeProvider: string) => {
    const providerMap: Record<string, 'claude-code' | 'codex' | 'gemini' | 'grok'> = {
      'CLAUDE_CODE': 'claude-code',
      'CODEX': 'codex',
      'GEMINI': 'gemini',
      'GROK': 'grok',
      'claude-code': 'claude-code',
      'codex': 'codex',
      'gemini': 'gemini',
      'grok': 'grok',
    };
    const mapped = providerMap[nativeProvider];
    if (mapped && claimSettingsFlow(`settings:ai-provider:native:${mapped}`)) {
      setActiveNativeCliFlow(mapped);
    }
  };

  const beginProviderRemoval = (provider: ProviderUIConfig) => {
    if (!claimSettingsFlow(`settings:ai-provider:remove:${provider.id}`)) return;
    setShowProviderPicker(false);
    setRemovalTarget({ provider, operationId: globalThis.crypto.randomUUID() });
    setRemovalConfirmation('');
    setRemovalError(null);
  };

  const closeProviderRemoval = () => {
    if (removingProvider) return;
    setRemovalTarget(null);
    setRemovalConfirmation('');
    setRemovalError(null);
    releaseSettingsFlow();
  };

  const submitProviderRemoval = async () => {
    if (!removalTarget || removalConfirmation !== removalTarget.provider.id || removingProvider) return;
    setRemovingProvider(true);
    setRemovalError(null);
    try {
      await client.delete(`${apiBase}/provider/${encodeURIComponent(removalTarget.provider.id)}`, {
        data: {
          operationId: removalTarget.operationId,
          confirmationProvider: removalTarget.provider.id,
        },
      });
      await loadStatus(true);
      setRemovalTarget(null);
      setRemovalConfirmation('');
      releaseSettingsFlow();
    } catch (err: any) {
      if (err?.response?.data?.operationDisposition === 'not_admitted') {
        setRemovalTarget((current) => current
          ? { ...current, operationId: globalThis.crypto.randomUUID() }
          : current);
      }
      setRemovalError(err?.response?.data?.error || err?.message || 'Provider disconnect could not complete safely.');
    } finally {
      setRemovingProvider(false);
    }
  };

  const providerRemovalDialog = removalTarget ? (
    <ViewportModal
      open
      onDismiss={closeProviderRemoval}
      className="bg-black/60 p-4 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-removal-title"
        className="w-full max-w-lg rounded-2xl border border-red-500/20 bg-slate-950 text-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-4">
          <div>
            <h2 id="provider-removal-title" className="text-lg font-semibold">
              Disconnect {removalTarget.provider.name}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Portal will remove only the exact Portal-owned API-key profile and its model-routing references.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close provider disconnect"
            onClick={closeProviderRemoval}
            disabled={removingProvider}
            className="rounded-lg border border-slate-800 p-2 text-slate-400 transition hover:text-white disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 px-5 py-5">
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            {getProviderRemovalConfirmation(removalTarget.provider.id)}
          </div>
          <label className="block text-sm text-slate-300">
            Provider id
            <input
              value={removalConfirmation}
              onChange={(event) => setRemovalConfirmation(event.target.value)}
              disabled={removingProvider}
              autoComplete="off"
              spellCheck={false}
              className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-white outline-none focus:border-red-400 disabled:opacity-60"
              placeholder={removalTarget.provider.id}
            />
          </label>
          {removalError ? (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              {removalError}
            </div>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={closeProviderRemoval}
              disabled={removingProvider}
              className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-900 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submitProviderRemoval()}
              disabled={removingProvider || removalConfirmation !== removalTarget.provider.id}
              className="inline-flex items-center gap-2 rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {removingProvider ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {removingProvider ? 'Disconnecting…' : 'Disconnect provider'}
            </button>
          </div>
        </div>
      </div>
    </ViewportModal>
  ) : null;

  useEffect(() => () => releaseSettingsFlow(), [releaseSettingsFlow]);

  // ── Compact layout (sidebar drawer) ──────────────────────────────
  if (compact) {
    return (
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">AI Providers</span>
          <button
            type="button"
            onClick={() => loadStatus(true)}
            disabled={refreshing}
            className="rounded p-1 text-slate-500 transition-colors hover:text-slate-300"
            title="Refresh"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Status */}
        {loading ? (
          <div className="rounded-lg border border-sky-400/15 bg-sky-500/10 px-3 py-3 text-sky-100">
            <div className="flex items-center gap-2 text-xs font-medium">
              <Loader2 className="h-4 w-4 animate-spin text-sky-300" />
              Loading provider status…
            </div>
            <div className="mt-1 text-[10px] text-sky-100/70">
              Checking installed providers, auth state, default model, and gateway health.
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</div>
        ) : null}

        {!loading && status ? (
          <div className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
            <div className="text-[10px] text-slate-500">Default model</div>
            <div className="mt-0.5 truncate text-xs font-medium text-white">{status.defaultModel || 'Not configured'}</div>
            <div className="mt-1 text-[10px] text-slate-600">
              {status.configuredProfileCount || 0} provider{(status.configuredProfileCount || 0) !== 1 ? 's' : ''} connected
            </div>
          </div>
        ) : null}

        {/* Provider buttons */}
        {!loading || additionalProviderCards ? (
          <QuickStartBanner
            onChoose={handleCardChoose}
            onNativeCliLogin={handleNativeCliLogin}
            statusMap={statusMap}
            compact
            additionalCards={additionalProviderCards}
            showBuiltInCards={!loading}
          />
        ) : null}

        {/* Modals */}
        {showProviderPicker ? (
          <OpenClawProviderPicker
            providers={providers}
            statusMap={statusMap}
            onSelect={(provider) => {
              if (!beginOwnedProviderSetup(provider)) return;
              setShowProviderPicker(false);
            }}
            onRemove={beginProviderRemoval}
            onDeviceFlow={() => {
              if (!claimSettingsFlow('settings:ai-provider:github-copilot')) return;
              setShowProviderPicker(false);
              setActiveDeviceFlow(true);
            }}
            onClose={() => setShowProviderPicker(false)}
          />
        ) : null}
        {providerRemovalDialog}
        {activeSetup && !activeAuthType && activeSetup.authOptions?.length ? (
          <ProviderAuthChoice provider={activeSetup} onSelect={setActiveAuthType} onCancel={closeProviderSetup} />
        ) : null}
        {activeSetup && activeAuthType === 'api_key' ? (
          <ApiKeySetupFlow provider={activeSetup} apiBase={apiBase} onComplete={handleComplete} onCancel={closeProviderSetup} />
        ) : null}
        {activeSetup && activeAuthType === 'oauth' ? (
          <OAuthSetupFlow provider={activeSetup} apiBase={apiBase} onComplete={handleComplete} onCancel={closeProviderSetup} />
        ) : null}
        {activeSetup && activeAuthType === 'aws_sdk' ? (
          <AwsSdkSetupFlow
            provider={activeSetup}
            status={statusMap.get(activeSetup.id) || null}
            refreshing={refreshing}
            onRefresh={() => loadStatus(true)}
            onCancel={closeProviderSetup}
          />
        ) : null}
        {activeSetup && activeAuthType === 'setup_token' ? (
          <SetupTokenFlow
            provider={activeSetup}
            status={statusMap.get(activeSetup.id) || null}
            apiBase={apiBase}
            onComplete={handleComplete}
            onCancel={closeProviderSetup}
            onNativeCliLogin={() => {
              setActiveSetup(null);
              setActiveAuthType(null);
              setActiveNativeCliFlow('claude-code');
            }}
          />
        ) : null}
        {activeDeviceFlow ? (
          <DeviceCodeFlow apiBase={apiBase} onComplete={async () => { await handleComplete(); closeDeviceFlow(); }} onCancel={closeDeviceFlow} />
        ) : null}
        {activeNativeCliFlow ? (
          <NativeCliSetupFlow provider={activeNativeCliFlow} apiBase={apiBase} onComplete={async () => { await handleComplete(); closeNativeCliFlow(); }} onCancel={closeNativeCliFlow} onModelSelected={onNativeModelSelected} />
        ) : null}
      </div>
    );
  }

  // ── Full layout ──────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-white">
            <Cpu className="h-5 w-5 text-emerald-300" />
            <h3 className="text-lg font-semibold">AI Providers</h3>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Connect a provider to unlock chat, agents, and coding tools.
          </p>
        </div>
        <button
          type="button"
          onClick={() => loadStatus(true)}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-300 transition hover:border-slate-600 hover:bg-slate-800 disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Loading */}
      {loading ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-10 text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-emerald-400" />
          <p className="mt-3 text-sm text-slate-400">Loading provider status…</p>
        </div>
      ) : null}

      {/* Error */}
      {error ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-100">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <div className="font-medium">AI setup is not available right now</div>
            <div className="mt-1 text-red-100/80">{error}</div>
          </div>
        </div>
      ) : null}

      {/* Status bar */}
      {!loading && status ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current default model</div>
              <div className="mt-1 text-base font-medium text-white">{status.defaultModel || 'No default model configured yet'}</div>
              <div className="mt-2 text-sm text-slate-400">
                Gateway: {status.gatewayRunning ? 'Running' : 'Unavailable'} · OpenClaw: {status.openclawInstalled ? (status.openclawVersion || 'Installed') : 'Not installed'}
              </div>
            </div>
            <div className="max-w-xl text-sm text-slate-400">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Fallback models</div>
              <div className="mt-1">
                {status.fallbackModels.length ? status.fallbackModels.join(', ') : 'No fallback models configured.'}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Four cards ── */}
      {!loading || additionalProviderCards ? (
        <QuickStartBanner
          onChoose={handleCardChoose}
          onNativeCliLogin={handleNativeCliLogin}
          statusMap={statusMap}
          additionalCards={additionalProviderCards}
          showBuiltInCards={!loading}
        />
      ) : null}

      {/* ── Modals ── */}
      {showProviderPicker ? (
        <OpenClawProviderPicker
          providers={providers}
          statusMap={statusMap}
          onSelect={(provider) => {
            if (!beginOwnedProviderSetup(provider)) return;
            setShowProviderPicker(false);
          }}
          onRemove={beginProviderRemoval}
          onDeviceFlow={() => {
            if (!claimSettingsFlow('settings:ai-provider:github-copilot')) return;
            setShowProviderPicker(false);
            setActiveDeviceFlow(true);
          }}
          onClose={() => setShowProviderPicker(false)}
        />
      ) : null}
      {providerRemovalDialog}

      {activeSetup && !activeAuthType && activeSetup.authOptions?.length ? (
        <ProviderAuthChoice provider={activeSetup} onSelect={setActiveAuthType} onCancel={closeProviderSetup} />
      ) : null}
      {activeSetup && activeAuthType === 'api_key' ? (
        <ApiKeySetupFlow provider={activeSetup} apiBase={apiBase} onComplete={handleComplete} onCancel={closeProviderSetup} />
      ) : null}
      {activeSetup && activeAuthType === 'oauth' ? (
        <OAuthSetupFlow provider={activeSetup} apiBase={apiBase} onComplete={handleComplete} onCancel={closeProviderSetup} />
      ) : null}
      {activeSetup && activeAuthType === 'aws_sdk' ? (
        <AwsSdkSetupFlow
          provider={activeSetup}
          status={statusMap.get(activeSetup.id) || null}
          refreshing={refreshing}
          onRefresh={() => loadStatus(true)}
          onCancel={closeProviderSetup}
        />
      ) : null}
      {activeSetup && activeAuthType === 'setup_token' ? (
        <SetupTokenFlow
          provider={activeSetup}
          status={statusMap.get(activeSetup.id) || null}
          apiBase={apiBase}
          onComplete={handleComplete}
          onCancel={closeProviderSetup}
          onNativeCliLogin={() => {
            setActiveSetup(null);
            setActiveAuthType(null);
            setActiveNativeCliFlow('claude-code');
          }}
        />
      ) : null}
      {activeDeviceFlow ? (
        <DeviceCodeFlow
          apiBase={apiBase}
          onComplete={async () => { await handleComplete(); closeDeviceFlow(); }}
          onCancel={closeDeviceFlow}
        />
      ) : null}
      {activeNativeCliFlow ? (
        <NativeCliSetupFlow
          provider={activeNativeCliFlow}
          apiBase={apiBase}
          onComplete={async () => { await handleComplete(); closeNativeCliFlow(); }}
          onCancel={closeNativeCliFlow}
          onModelSelected={onNativeModelSelected}
        />
      ) : null}

      {/* Wizard: manual continue button */}
      {mode === 'wizard' && !loading ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <p className="text-sm text-slate-400">
            {(status?.configuredProfileCount || 0) > 0
              ? 'You can add more providers anytime from Settings. Continue when ready.'
              : 'Connect at least one AI provider above, or skip this step and add one later from Settings.'}
          </p>
          <button
            type="button"
            onClick={() => onComplete?.()}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow transition hover:bg-emerald-500"
          >
            {(status?.configuredProfileCount || 0) > 0 ? 'Continue' : 'Skip for now'}
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
