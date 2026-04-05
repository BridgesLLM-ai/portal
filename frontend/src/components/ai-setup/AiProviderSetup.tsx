import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Cpu, Loader2, RefreshCw } from 'lucide-react';
import client from '../../api/client';
import ApiKeySetupFlow from './ApiKeySetupFlow';
import DeviceCodeFlow from './DeviceCodeFlow';
import NativeCliSetupFlow from './NativeCliSetupFlow';
import OAuthSetupFlow from './OAuthSetupFlow';
import OpenClawProviderPicker from './OpenClawProviderPicker';
import type { ProviderStatus } from './ProviderCard';
import ProviderCard from './ProviderCard';
import QuickStartBanner from './QuickStartBanner';
import SetupTokenFlow from './SetupTokenFlow';
import { PROVIDERS, getProviderConfig, type ProviderUIConfig } from './providerConfig';

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
}

export default function AiProviderSetup({ mode, apiBase, onComplete, compact = false }: AiProviderSetupProps) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AiSetupStatusResponse | null>(null);
  const [activeSetup, setActiveSetup] = useState<ProviderUIConfig | null>(null);
  const [activeDeviceFlow, setActiveDeviceFlow] = useState(false);
  const [activeNativeCliFlow, setActiveNativeCliFlow] = useState<'claude-code' | 'codex' | 'gemini' | null>(null);
  const [showProviderPicker, setShowProviderPicker] = useState(false);

  const loadStatus = async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const { data } = await client.get<AiSetupStatusResponse>(`${apiBase}/status`);
      setStatus(data);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load AI provider status');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, [apiBase]);

  const statusMap = useMemo(
    () => new Map((status?.providers || []).map((p) => [p.id, p])),
    [status?.providers],
  );

  const handleCardChoose = (id: string) => {
    if (id === 'openclaw') {
      setShowProviderPicker(true);
      return;
    }
    if (id === 'github-copilot') {
      setActiveDeviceFlow(true);
      return;
    }
    const provider = getProviderConfig(id);
    setActiveSetup(provider);
  };

  const handleRemove = async (providerId: string) => {
    if (!window.confirm(`Remove ${providerId} from the AI provider configuration?`)) return;
    try {
      await client.delete(`${apiBase}/provider/${providerId}`);
      await loadStatus(true);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || `Failed to remove ${providerId}`);
    }
  };

  const handleComplete = async () => {
    await loadStatus(true);
    // Don't auto-advance the wizard — let user add more providers first
  };

  const handleNativeCliLogin = (nativeProvider: string) => {
    const providerMap: Record<string, 'claude-code' | 'codex' | 'gemini'> = {
      'CLAUDE_CODE': 'claude-code',
      'CODEX': 'codex',
      'GEMINI': 'gemini',
      'claude-code': 'claude-code',
      'codex': 'codex',
      'gemini': 'gemini',
    };
    const mapped = providerMap[nativeProvider];
    if (mapped) {
      setActiveNativeCliFlow(mapped);
    }
  };

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
          <div className="py-3 text-center">
            <Loader2 className="mx-auto h-4 w-4 animate-spin text-slate-600" />
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
        {!loading ? (
          <QuickStartBanner onChoose={handleCardChoose} onNativeCliLogin={handleNativeCliLogin} statusMap={statusMap} compact />
        ) : null}

        {/* Modals */}
        {showProviderPicker ? (
          <OpenClawProviderPicker
            statusMap={statusMap}
            onSelect={(provider) => { setShowProviderPicker(false); setActiveSetup(provider); }}
            onDeviceFlow={() => { setShowProviderPicker(false); setActiveDeviceFlow(true); }}
            onClose={() => setShowProviderPicker(false)}
          />
        ) : null}
        {activeSetup?.primaryAuthType === 'api_key' ? (
          <ApiKeySetupFlow provider={activeSetup} apiBase={apiBase} onComplete={handleComplete} onCancel={() => setActiveSetup(null)} />
        ) : null}
        {activeSetup?.primaryAuthType === 'oauth' ? (
          <OAuthSetupFlow provider={activeSetup} apiBase={apiBase} onComplete={handleComplete} onCancel={() => setActiveSetup(null)} />
        ) : null}
        {activeSetup?.primaryAuthType === 'setup_token' ? (
          <SetupTokenFlow
            provider={activeSetup}
            status={statusMap.get(activeSetup.id) || null}
            apiBase={apiBase}
            onComplete={handleComplete}
            onCancel={() => setActiveSetup(null)}
            onNativeCliLogin={() => {
              setActiveSetup(null);
              setActiveNativeCliFlow('claude-code');
            }}
          />
        ) : null}
        {activeDeviceFlow ? (
          <DeviceCodeFlow apiBase={apiBase} onComplete={async () => { await handleComplete(); setActiveDeviceFlow(false); }} onCancel={() => setActiveDeviceFlow(false)} />
        ) : null}
        {activeNativeCliFlow ? (
          <NativeCliSetupFlow provider={activeNativeCliFlow} apiBase={apiBase} onComplete={async () => { await handleComplete(); setActiveNativeCliFlow(null); }} onCancel={() => setActiveNativeCliFlow(null)} />
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
      {!loading ? (
        <QuickStartBanner onChoose={handleCardChoose} onNativeCliLogin={handleNativeCliLogin} statusMap={statusMap} />
      ) : null}

      {/* ── Modals ── */}
      {showProviderPicker ? (
        <OpenClawProviderPicker
          statusMap={statusMap}
          onSelect={(provider) => {
            setShowProviderPicker(false);
            setActiveSetup(provider);
          }}
          onDeviceFlow={() => {
            setShowProviderPicker(false);
            setActiveDeviceFlow(true);
          }}
          onClose={() => setShowProviderPicker(false)}
        />
      ) : null}

      {activeSetup?.primaryAuthType === 'api_key' ? (
        <ApiKeySetupFlow provider={activeSetup} apiBase={apiBase} onComplete={handleComplete} onCancel={() => setActiveSetup(null)} />
      ) : null}
      {activeSetup?.primaryAuthType === 'oauth' ? (
        <OAuthSetupFlow provider={activeSetup} apiBase={apiBase} onComplete={handleComplete} onCancel={() => setActiveSetup(null)} />
      ) : null}
      {activeSetup?.primaryAuthType === 'setup_token' ? (
        <SetupTokenFlow
          provider={activeSetup}
          status={statusMap.get(activeSetup.id) || null}
          apiBase={apiBase}
          onComplete={handleComplete}
          onCancel={() => setActiveSetup(null)}
          onNativeCliLogin={() => {
            setActiveSetup(null);
            setActiveNativeCliFlow('claude-code');
          }}
        />
      ) : null}
      {activeDeviceFlow ? (
        <DeviceCodeFlow
          apiBase={apiBase}
          onComplete={async () => { await handleComplete(); setActiveDeviceFlow(false); }}
          onCancel={() => setActiveDeviceFlow(false)}
        />
      ) : null}
      {activeNativeCliFlow ? (
        <NativeCliSetupFlow
          provider={activeNativeCliFlow}
          apiBase={apiBase}
          onComplete={async () => { await handleComplete(); setActiveNativeCliFlow(null); }}
          onCancel={() => setActiveNativeCliFlow(null)}
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
