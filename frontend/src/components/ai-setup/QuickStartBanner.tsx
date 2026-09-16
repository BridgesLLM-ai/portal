import { AlertTriangle, CheckCircle2, ChevronRight, Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ProviderStatus } from './ProviderCard';

type QuickStartNativeProvider = 'claude-code' | 'codex' | 'gemini' | 'grok' | 'hermes' | 'opencode';

interface QuickStartBannerProps {
  onChoose: (providerId: string) => void;
  onNativeCliLogin?: (nativeProvider: QuickStartNativeProvider) => void;
  statusMap?: Map<string, ProviderStatus>;
  compact?: boolean;
  additionalCards?: ReactNode;
  showBuiltInCards?: boolean;
  showHarnessNativeCards?: boolean;
}

interface QuickStartCard {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  color: string;
  isNativeCli: boolean;
  nativeCliProvider?: QuickStartNativeProvider;
  /** OpenClaw provider whose runtime registration this card should report. */
  openclawProvider?: string;
  /** Portal-native harness whose login state this card should report. */
  harnessLabel?: string;
}

const cards: QuickStartCard[] = [
  {
    id: 'openclaw',
    title: 'OpenClaw',
    subtitle: 'All providers via OpenClaw',
    description: 'Configure every subscription, OAuth, and API-key provider the installed OpenClaw runtime supports, and choose its default model.',
    color: 'bg-emerald-500',
    isNativeCli: false,
  },
  {
    id: 'native-claude-code',
    title: 'Claude Code',
    subtitle: 'Browser sign-in, shared with OpenClaw',
    description: 'Sign in with your Claude account. OpenClaw\'s Claude CLI runtime and Portal Claude Code sessions on this server use this login. Portal never launches Claude Code to sign in.',
    color: 'bg-amber-500',
    isNativeCli: true,
    nativeCliProvider: 'claude-code',
    openclawProvider: 'anthropic',
  },
  {
    id: 'openai-codex',
    title: 'ChatGPT / Codex',
    subtitle: 'ChatGPT subscription via OpenClaw',
    description: 'Sign in with your ChatGPT account through OpenClaw\'s own sign-in wizard for OpenAI models and the Codex harness. Availability follows the installed OpenClaw.',
    color: 'bg-sky-500',
    isNativeCli: false,
    openclawProvider: 'openai-codex',
    harnessLabel: 'Codex harness',
  },
  {
    id: 'native-grok',
    title: 'Grok Build',
    subtitle: 'Native xAI coding agent',
    description: 'Sign in with a Grok subscription for a native full-server Agent Chat option. Server API keys remain supported separately.',
    color: 'bg-orange-500',
    isNativeCli: true,
    nativeCliProvider: 'grok',
    openclawProvider: 'xai',
  },
  {
    id: 'native-gemini',
    title: 'Antigravity',
    subtitle: 'Native CLI agent',
    description: 'Sign in with Google to use Antigravity as a native agent in Agent Chat.',
    color: 'bg-violet-500',
    isNativeCli: true,
    nativeCliProvider: 'gemini',
  },
  {
    id: 'native-hermes',
    title: 'Hermes',
    subtitle: 'Native ACP harness',
    description: 'Run the fixed Hermes provider/model wizard in the dedicated Portal profile, then discover the models that Hermes exposes for that account.',
    color: 'bg-emerald-500',
    isNativeCli: true,
    nativeCliProvider: 'hermes',
  },
  {
    id: 'native-opencode',
    title: 'OpenCode',
    subtitle: 'Native ACP harness',
    description: 'Run OpenCode’s own provider login wizard in the dedicated Portal profile, then discover its account-specific model catalog.',
    color: 'bg-cyan-500',
    isNativeCli: true,
    nativeCliProvider: 'opencode',
  },
];

// Map native CLI card IDs to the OpenClaw provider that tracks their auth status
const NATIVE_CLI_PROVIDER_MAP: Record<string, string> = {
  'native-claude-code': 'anthropic',
  'native-grok': 'xai',
  'native-gemini': 'google-antigravity',
  'native-hermes': 'portal-hermes',
  'native-opencode': 'portal-opencode',
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

/**
 * Secondary facts a card must not blur into its headline state: whether
 * OpenClaw has registered a runtime profile for the login, and (for the
 * ChatGPT card) whether the separate Codex harness login exists.
 */
function getRuntimeNotes(statusMap: Map<string, ProviderStatus> | undefined, card: QuickStartCard): string[] {
  if (!statusMap) return [];
  const notes: string[] = [];
  if (card.openclawProvider) {
    const status = statusMap.get(card.openclawProvider);
    if (status) {
      notes.push(status.status === 'configured'
        ? `OpenClaw: registered${status.currentModel ? ` · ${status.currentModel}` : ''}`
        : status.status === 'unconfigured'
          ? 'OpenClaw: not registered'
          : `OpenClaw: ${status.status}`);
    }
  }
  if (card.harnessLabel && card.openclawProvider) {
    const native = statusMap.get(card.openclawProvider)?.nativeCliAuthStatus;
    if (native === 'authenticated') notes.push(`${card.harnessLabel}: signed in`);
    else if (native === 'needs_login') notes.push(`${card.harnessLabel}: needs login`);
    else if (native === 'unknown') notes.push(`${card.harnessLabel}: login not verified`);
  }
  return notes;
}

export default function QuickStartBanner({
  onChoose,
  onNativeCliLogin,
  statusMap,
  compact = false,
  additionalCards,
  showBuiltInCards = true,
  showHarnessNativeCards = true,
}: QuickStartBannerProps) {
  const visibleCards = showHarnessNativeCards
    ? cards
    : cards.filter((card) => card.id !== 'native-hermes' && card.id !== 'native-opencode');
  const activate = (card: QuickStartCard) => {
    if (card.isNativeCli && card.nativeCliProvider && onNativeCliLogin) {
      onNativeCliLogin(card.nativeCliProvider);
      return;
    }
    onChoose(card.id);
  };

  if (compact) {
    return (
      <div className="space-y-1.5">
        {showBuiltInCards ? visibleCards.map((card) => {
          const configured = isConfigured(statusMap, card.id);
          const expiry = getExpiryInfo(statusMap, card.id);
          const notes = getRuntimeNotes(statusMap, card);
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => activate(card)}
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
                {notes.length ? (
                  <div className="text-[10px] text-slate-500">{notes.join(' · ')}</div>
                ) : null}
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
          Pick how you want to get started. Each option walks you through sign-in, then verifies it with OpenClaw and lets you choose a model.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {showBuiltInCards ? visibleCards.map((card) => {
          const configured = isConfigured(statusMap, card.id);
          const expiry = getExpiryInfo(statusMap, card.id);
          const notes = getRuntimeNotes(statusMap, card);
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => activate(card)}
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
              {notes.length ? (
                <p className="mt-2 text-xs text-slate-500">{notes.join(' · ')}</p>
              ) : null}
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
