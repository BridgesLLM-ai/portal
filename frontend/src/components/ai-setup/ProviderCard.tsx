import { AlertTriangle, CheckCircle2, ChevronRight, Cpu, ExternalLink, Globe, Network, Rocket, Server, Sparkles, Wind, Zap } from 'lucide-react';
import type { ProviderUIConfig } from './providerConfig';

export interface ProviderStatus {
  id: string;
  status: 'configured' | 'unconfigured' | 'error' | 'expired' | 'cooldown';
  authType: string | null;
  profileId: string | null;
  currentModel: string | null;
  isDefault: boolean;
  error: string | null;
  cooldownUntil: number | null;
  lastUsed: number | null;
  expiresAt: number | null;
  warning?: string | null;
  nativeProvider?: string | null;
  nativeCliAuthStatus?: 'not_applicable' | 'authenticated' | 'needs_login' | 'unknown' | null;
  nativeCliAuthMessage?: string | null;
  nativeCliLoginCommand?: string | null;
  requiresSeparateNativeLogin?: boolean;
}

interface ProviderCardProps {
  provider: ProviderUIConfig;
  status?: ProviderStatus | null;
  onConfigure: (providerId: string) => void;
  onRemove?: (providerId: string) => void;
  onNativeCliLogin?: (nativeProvider: string) => void;
  /** Compact layout for narrow containers */
  compact?: boolean;
}

const iconMap = {
  sparkles: Sparkles,
  cpu: Cpu,
  globe: Globe,
  network: Network,
  zap: Zap,
  wind: Wind,
  rocket: Rocket,
  boxes: Server,
  brain: Cpu,
  code: Cpu,
  server: Server,
  cloud: Globe,
  bot: Cpu,
  moon: Sparkles,
  shield: AlertTriangle,
  activity: Cpu,
  waypoints: Network,
  'cloud-lightning': Zap,
  package: Server,
  'package-2': Server,
  settings: Cpu,
  wand: Sparkles,
} as const;

function statusStyles(status: ProviderStatus['status'] | undefined) {
  switch (status) {
    case 'configured':
      return { label: 'Configured', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300', icon: CheckCircle2 };
    case 'error':
      return { label: 'Needs attention', className: 'border-red-500/30 bg-red-500/10 text-red-300', icon: AlertTriangle };
    case 'expired':
      return { label: 'Expired', className: 'border-amber-500/30 bg-amber-500/10 text-amber-300', icon: AlertTriangle };
    case 'cooldown':
      return { label: 'Cooldown', className: 'border-amber-500/30 bg-amber-500/10 text-amber-300', icon: AlertTriangle };
    default:
      return { label: 'Not set up', className: 'border-slate-700 bg-slate-800/70 text-slate-300', icon: ChevronRight };
  }
}

function authLabel(provider: ProviderUIConfig, status?: ProviderStatus | null) {
  if (status?.authType === 'cli') return provider.id === 'anthropic' ? 'Claude CLI OAuth' : 'CLI';
  if (status?.authType === 'oauth') return 'OAuth';
  if (status?.authType === 'token') return provider.id === 'anthropic' ? 'Setup Token' : 'Token';
  if (status?.authType === 'api_key') return provider.id === 'ollama' ? 'Local' : 'API Key';

  switch (provider.primaryAuthType) {
    case 'oauth':
      return 'OAuth';
    case 'setup_token':
      return 'Setup Token';
    case 'device_code':
      return 'Device Code';
    default:
      return provider.id === 'ollama' ? 'Local' : 'API Key';
  }
}

function nativeCliLabel(status: ProviderStatus | null | undefined) {
  switch (status?.nativeCliAuthStatus) {
    case 'authenticated':
      return 'Ready';
    case 'needs_login':
      return 'Needs CLI login';
    case 'unknown':
      return 'Unknown';
    case 'not_applicable':
      return 'Not needed';
    default:
      return status?.nativeProvider ? 'Separate auth' : 'Not used';
  }
}

export default function ProviderCard({ provider, status, onConfigure, onRemove, onNativeCliLogin, compact = false }: ProviderCardProps) {
  const Icon = iconMap[provider.icon as keyof typeof iconMap] || Cpu;
  const tone = statusStyles(status?.status);
  const isConfigured = status?.status === 'configured';

  if (compact) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 transition hover:bg-white/[0.04]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Icon className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
            <span className="text-xs font-medium text-white truncate">{provider.name}</span>
            {provider.freeTier ? (
              <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-300 shrink-0">
                Free
              </span>
            ) : null}
          </div>
          <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium shrink-0 ${tone.className}`}>
            <tone.icon className="h-2.5 w-2.5" />
            {tone.label}
          </span>
        </div>

        {provider.dangerNote ? (
          <div className="mt-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-red-200">
            <div className="font-semibold text-red-100">{provider.dangerNote.title}</div>
            <div className="mt-0.5">{provider.dangerNote.compactDetail || provider.dangerNote.detail}</div>
            {provider.dangerNote.link ? (
              <a
                href={provider.dangerNote.link.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 font-medium text-sky-300 underline decoration-sky-400/40 hover:text-sky-200"
              >
                {provider.dangerNote.link.label}
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            ) : null}
          </div>
        ) : null}

        {status?.error ? (
          <div className="mt-1.5 text-[10px] text-red-300 truncate">{status.error}</div>
        ) : null}

        {status?.warning ? (
          <div className="mt-1.5 text-[10px] text-amber-300 truncate">{status.warning}</div>
        ) : null}

        <div className="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onConfigure(provider.id)}
            className="inline-flex items-center gap-1 rounded-lg bg-emerald-400 px-2.5 py-1 text-[10px] font-semibold text-slate-950 shadow-sm transition hover:bg-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
          >
            {isConfigured ? 'Reconfigure' : 'Set Up'}
            <ChevronRight className="h-3 w-3" />
          </button>
          {isConfigured && onRemove ? (
            <button
              type="button"
              onClick={() => onRemove(provider.id)}
              className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] font-medium text-red-200 transition hover:bg-red-500/15"
            >
              Remove
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 transition hover:border-slate-700 hover:bg-slate-900">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-3 text-emerald-300">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-semibold text-white">{provider.name}</h3>
              {provider.freeTier ? (
                <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                  Free tier
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-slate-400">{provider.description}</p>
          </div>
        </div>

        <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${tone.className}`}>
          <tone.icon className="h-3.5 w-3.5" />
          {tone.label}
        </span>
      </div>

      {provider.dangerNote ? (
        <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          <div className="font-semibold text-red-50">{provider.dangerNote.title}</div>
          <div className="mt-1 leading-relaxed text-red-100/90">{provider.dangerNote.detail}</div>
          {provider.dangerNote.link ? (
            <a
              href={provider.dangerNote.link.url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 font-medium text-sky-300 underline decoration-sky-400/40 hover:text-sky-200"
            >
              {provider.dangerNote.link.label}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">Auth</div>
          <div className="mt-1 text-sm text-slate-200">{authLabel(provider, status)}</div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">Model</div>
          <div className="mt-1 text-sm text-slate-200">{status?.currentModel || 'No default model set'}</div>
        </div>
      </div>

      {status?.nativeProvider && provider.id !== 'anthropic' ? (
        <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-slate-500">Portal native CLI</div>
              <div className="mt-1 text-sm text-slate-200">{status.nativeProvider}</div>
            </div>
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${status.nativeCliAuthStatus === 'authenticated' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : status.nativeCliAuthStatus === 'needs_login' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-slate-700 bg-slate-800/70 text-slate-300'}`}>
              {nativeCliLabel(status)}
            </span>
          </div>
          {status.nativeCliAuthMessage ? (
            <div className="mt-2 text-sm text-slate-300">{status.nativeCliAuthMessage}</div>
          ) : null}
          {status.nativeCliAuthStatus === 'needs_login' && onNativeCliLogin ? (
            <button
              type="button"
              onClick={() => onNativeCliLogin(status.nativeProvider!)}
              className="mt-2 inline-flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/15"
            >
              <ChevronRight className="h-3.5 w-3.5" />
              Login to {status.nativeProvider} CLI
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
        <div className="text-[11px] uppercase tracking-wide text-slate-500">Pricing</div>
        <div className="mt-1 text-sm text-slate-300">{provider.pricingNote}</div>
      </div>

      {status?.error ? (
        <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-200">
          {status.error}
        </div>
      ) : null}

      {status?.warning ? (
        <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-amber-100">
          {status.warning}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onConfigure(provider.id)}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 shadow-sm transition hover:bg-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
        >
          {isConfigured ? 'Reconfigure' : 'Configure'}
          <ChevronRight className="h-4 w-4" />
        </button>

        {isConfigured && onRemove ? (
          <button
            type="button"
            onClick={() => onRemove(provider.id)}
            className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-200 transition hover:bg-red-500/15"
          >
            Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}
