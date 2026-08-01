import { AlertTriangle, CheckCircle2, ChevronRight, Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ProviderStatus } from './ProviderCard';

interface QuickStartBannerProps {
  onChoose: (providerId: string) => void;
  onNativeCliLogin?: (nativeProvider: 'claude-code' | 'codex' | 'gemini' | 'grok') => void;
  statusMap?: Map<string, ProviderStatus>;
  compact?: boolean;
  additionalCards?: ReactNode;
  showBuiltInCards?: boolean;
}

const cards = [
  {
    id: 'openclaw',
    title: 'OpenClaw',
    subtitle: 'Supported providers via OpenClaw',
    description: 'Configure the API-key and OAuth providers exposed by the installed OpenClaw runtime.',
    color: 'bg-emerald-500',
    isNativeCli: false,
  },
  {
    id: 'native-claude-code',
    title: 'Claude Code',
    subtitle: 'Native CLI agent',
    description: 'Log in the Claude Code CLI directly for use as a native agent in Agent Chat.',
    color: 'bg-amber-500',
    isNativeCli: true,
    nativeCliProvider: 'claude-code' as const,
  },
  {
    id: 'native-codex',
    title: 'Codex',
    subtitle: 'Native CLI agent',
    description: 'Log in the Codex CLI directly for use as a native agent in Agent Chat.',
    color: 'bg-sky-500',
    isNativeCli: true,
    nativeCliProvider: 'codex' as const,
  },
  {
    id: 'native-grok',
    title: 'Grok Build',
    subtitle: 'Native xAI coding agent',
    description: 'Sign in with a Grok subscription for a native full-server Agent Chat option. Server API keys remain supported separately.',
    color: 'bg-orange-500',
    isNativeCli: true,
    nativeCliProvider: 'grok' as const,
  },
  {
    id: 'native-gemini',
    title: 'Antigravity',
    subtitle: 'Native CLI agent',
    description: 'Sign in with Google to use Antigravity as a native agent in Agent Chat.',
    color: 'bg-violet-500',
    isNativeCli: true,
    nativeCliProvider: 'gemini' as const,
  },
];

// Map native CLI card IDs to the OpenClaw provider that tracks their auth status
const NATIVE_CLI_PROVIDER_MAP: Record<string, string> = {
  'native-claude-code': 'anthropic',
  'native-codex': 'openai-codex',
  'native-grok': 'xai',
  'native-gemini': 'google-antigravity',
};

function isConfigured(statusMap: Map<string, ProviderStatus> | undefined, id: string): boolean {
  if (!statusMap) return false;
  if (id === 'openclaw') return false;
  // For native CLI cards, check the underlying provider's native auth status
  const providerId = NATIVE_CLI_PROVIDER_MAP[id];
  if (providerId) {
    return statusMap.get(providerId)?.nativeCliAuthStatus === 'authenticated';
  }
  return statusMap.get(id)?.status === 'configured';
}

function getExpiryInfo(statusMap: Map<string, ProviderStatus> | undefined, id: string): { label: string; urgency: 'ok' | 'warning' | 'danger' | 'expired' } | null {
  if (!statusMap || id === 'openclaw') return null;
  const nativeProviderId = NATIVE_CLI_PROVIDER_MAP[id];
  const providerId = nativeProviderId || id;
  const status = statusMap.get(providerId);
  // `expiresAt` belongs to the OpenClaw provider profile. A native CLI card
  // represents a separate credential store, so showing that timestamp here can
  // claim a healthy Grok/Codex CLI is expired. Use only the native auth probe.
  if (nativeProviderId) {
    if (status?.nativeCliAuthStatus === 'needs_login') {
      return { label: 'Needs login', urgency: 'expired' };
    }
    if (status?.nativeCliAuthStatus === 'unknown') {
      return { label: 'Check login', urgency: 'warning' };
    }
    return null;
  }
  if (!status?.expiresAt) return null;

  const now = Date.now();
  const diff = status.expiresAt - now;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (diff <= 0) return { label: 'Expired', urgency: 'expired' };
  if (days <= 3) return { label: `Expires in ${days < 1 ? 'less than a day' : `${days}d`}`, urgency: 'danger' };
  if (days <= 14) return { label: `Expires in ${days}d`, urgency: 'warning' };
  if (days <= 30) return { label: `Expires in ${days}d`, urgency: 'ok' };
  return { label: `Expires ${new Date(status.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, urgency: 'ok' };
}

export default function QuickStartBanner({
  onChoose,
  onNativeCliLogin,
  statusMap,
  compact = false,
  additionalCards,
  showBuiltInCards = true,
}: QuickStartBannerProps) {
  if (compact) {
    return (
      <div className="space-y-1.5">
        {showBuiltInCards ? cards.map((card) => {
          const configured = isConfigured(statusMap, card.id);
          const expiry = getExpiryInfo(statusMap, card.id);
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => card.isNativeCli && card.nativeCliProvider && onNativeCliLogin ? onNativeCliLogin(card.nativeCliProvider) : onChoose(card.id)}
              className="group flex w-full items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2.5 text-left transition hover:border-slate-600 hover:bg-slate-800/60 active:bg-slate-800"
            >
              <div className={`h-2 w-2 shrink-0 rounded-full ${configured ? 'bg-emerald-400' : card.color + '/40'}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white">{card.title}</span>
                  {expiry ? (
                    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                      expiry.urgency === 'expired' ? 'bg-red-500/15 text-red-300' :
                      expiry.urgency === 'danger' ? 'bg-red-500/15 text-red-300' :
                      expiry.urgency === 'warning' ? 'bg-amber-500/15 text-amber-300' :
                      'bg-slate-700/50 text-slate-400'
                    }`}>
                      {expiry.urgency === 'expired' || expiry.urgency === 'danger' ? <AlertTriangle className="h-2.5 w-2.5" /> : <Clock className="h-2.5 w-2.5" />}
                      {expiry.label}
                    </span>
                  ) : null}
                </div>
                <div className="text-[11px] text-slate-400">{card.subtitle}</div>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-600 transition group-hover:text-slate-400" />
            </button>
          );
        }) : null}
        {additionalCards}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-white">Connect an AI provider</h2>
        <p className="mt-1 text-sm text-slate-400">
          Pick how you want to get started. Each option walks you through setup step by step.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {showBuiltInCards ? cards.map((card) => {
          const configured = isConfigured(statusMap, card.id);
          const expiry = getExpiryInfo(statusMap, card.id);
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => card.isNativeCli && card.nativeCliProvider && onNativeCliLogin ? onNativeCliLogin(card.nativeCliProvider) : onChoose(card.id)}
              className={`group relative flex flex-col rounded-xl border bg-slate-950/60 p-5 text-left transition hover:bg-slate-900/80 active:bg-slate-900 ${
                expiry?.urgency === 'expired' || expiry?.urgency === 'danger'
                  ? 'border-red-500/30 hover:border-red-500/50'
                  : expiry?.urgency === 'warning'
                    ? 'border-amber-500/30 hover:border-amber-500/50'
                    : 'border-slate-800 hover:border-slate-600'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`h-3 w-3 shrink-0 rounded-full ${
                  expiry?.urgency === 'expired' ? 'bg-red-400' :
                  configured ? 'bg-emerald-400' : card.color + '/50'
                }`} />
                <div className="text-base font-semibold text-white">{card.title}</div>
                {configured && !expiry ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : null}
                {expiry?.urgency === 'expired' ? <AlertTriangle className="h-4 w-4 text-red-400" /> : null}
              </div>

              {expiry ? (
                <div className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                  expiry.urgency === 'expired' ? 'bg-red-500/15 text-red-300' :
                  expiry.urgency === 'danger' ? 'bg-red-500/15 text-red-300' :
                  expiry.urgency === 'warning' ? 'bg-amber-500/15 text-amber-300' :
                  'bg-slate-800 text-slate-400'
                }`}>
                  {expiry.urgency === 'expired' || expiry.urgency === 'danger' ? <AlertTriangle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                  {expiry.label}
                  {expiry.urgency === 'expired' ? ' — re-authenticate to restore access' : ''}
                </div>
              ) : null}

              <p className="mt-2 text-sm leading-relaxed text-slate-400">{card.description}</p>
              <div className="mt-3 flex items-center gap-1 text-sm font-medium text-slate-300 group-hover:text-white transition-colors">
                <span>{expiry?.urgency === 'expired' ? 'Re-authenticate' : configured ? 'Reconfigure' : 'Set up'}</span>
                <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </div>
            </button>
          );
        }) : null}
        {additionalCards}
      </div>
    </div>
  );
}
