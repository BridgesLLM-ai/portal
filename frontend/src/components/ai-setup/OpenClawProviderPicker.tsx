import { CheckCircle2, ChevronRight, ExternalLink, Trash2, X } from 'lucide-react';
import ViewportModal from '../ViewportModal';
import ProviderCoverageChips from './ProviderCoverageChips';
import type { ProviderStatus } from './ProviderCard';
import type { ProviderUIConfig } from './providerConfig';
import { isSubscriptionProvider, type ProviderCoverage } from './providerCoverage';
import type { OAuthProviderSupport } from './openclawAuthWizardContract';
import { canRemoveProviderStatus, providerStatusCanShowRemoval } from './providerRemovalContract';

interface OpenClawProviderPickerProps {
  providers: ProviderUIConfig[];
  statusMap: Map<string, ProviderStatus>;
  /** Derived login / OpenClaw runtime / harness state per provider. */
  coverageMap?: Map<string, ProviderCoverage>;
  /** Server-reported OAuth sign-in support; authoritative over the static catalog when present. */
  oauthSupport?: Map<string, OAuthProviderSupport>;
  onSelect: (provider: ProviderUIConfig) => void;
  onRemove: (provider: ProviderUIConfig) => void;
  onClose: () => void;
}

export interface ProviderGuidance {
  guided: boolean;
  reason: string | null;
  action: { url: string; label: string } | null;
}

/**
 * Whether Portal can run this provider's sign-in right now. The installed
 * OpenClaw's own answer (`/oauth/providers`) wins over the static catalog; the
 * catalog is the fallback for servers that do not report support.
 */
export function getProviderGuidance(
  provider: ProviderUIConfig,
  oauthSupport?: Map<string, OAuthProviderSupport>,
): ProviderGuidance {
  const support = oauthSupport?.get(provider.id);
  const catalogManual = provider.guidedSetup.status === 'manual' ? provider.guidedSetup : null;
  // Lack of subscription OAuth must not hide an otherwise supported API-key path.
  const hasApiKey = provider.guidedSetup.status === 'available'
    && provider.guidedSetup.authTypes.includes('api_key');
  if (support && (!hasApiKey || support.supported)) {
    return {
      guided: support.supported,
      reason: support.supported ? null : (support.reason || catalogManual?.reason || 'The installed OpenClaw does not offer this sign-in.'),
      action: support.documentationUrl
        ? { url: support.documentationUrl, label: catalogManual?.action.label || 'Open provider documentation' }
        : (catalogManual?.action || null),
    };
  }
  return {
    guided: provider.guidedSetup.status === 'available',
    reason: catalogManual?.reason || null,
    action: catalogManual?.action || null,
  };
}

function authLabel(provider: ProviderUIConfig) {
  if (provider.authOptions?.length) {
    return provider.authOptions.map((option) => option.type === 'api_key' ? 'API key' : 'Subscription sign-in').join(' or ');
  }
  switch (provider.primaryAuthType) {
    case 'oauth':
      return 'Subscription sign-in';
    case 'setup_token':
      return 'Subscription sign-in or setup token';
    case 'device_code':
      return 'Device code sign-in';
    case 'native_cli':
      return 'Native CLI sign-in';
    case 'aws_sdk':
      return 'AWS credentials (manual)';
    default:
      return 'API key';
  }
}

// Group: every subscription-style provider first (including ones this server
// cannot sign in yet, with the reason visible), then API key providers, then
// advanced/manual.
export function groupProviders(providers: ProviderUIConfig[], oauthSupport?: Map<string, OAuthProviderSupport>) {
  // Antigravity is a Portal-native Agent Chat harness. Keep it on the native
  // Quick Start card and never imply that it is an OpenClaw OAuth provider.
  const openClawProviders = providers.filter((p) => p.id !== 'google-antigravity');
  const subscription = openClawProviders.filter(isSubscriptionProvider);
  const remaining = openClawProviders.filter((p) => !isSubscriptionProvider(p));
  const apiKey = remaining.filter((p) => getProviderGuidance(p, oauthSupport).guided && p.primaryAuthType === 'api_key' && p.tier <= 2);
  const advanced = remaining.filter((p) => !apiKey.includes(p));
  return { subscription, apiKey, advanced };
}

export default function OpenClawProviderPicker({ providers, statusMap, coverageMap, oauthSupport, onSelect, onRemove, onClose }: OpenClawProviderPickerProps) {
  const { subscription, apiKey, advanced } = groupProviders(providers, oauthSupport);

  const handleClick = (provider: ProviderUIConfig) => {
    if (!getProviderGuidance(provider, oauthSupport).guided) return;
    onSelect(provider);
  };

  const renderRow = (provider: ProviderUIConfig) => {
    const guidance = getProviderGuidance(provider, oauthSupport);
    const status = statusMap.get(provider.id);
    const coverage = coverageMap?.get(provider.id);
    const configured = status?.status === 'configured';
    const showRemoval = providerStatusCanShowRemoval(status?.status);
    const canRemove = canRemoveProviderStatus(status?.status, status?.removal);
    const readiness = status?.readiness;
    const readinessClass = readiness?.state === 'ready'
      ? 'text-emerald-300'
      : readiness?.state === 'needs_setup'
        ? 'text-amber-300'
        : 'text-red-300';

    return (
      <div
        key={provider.id}
        data-testid={`provider-row-${provider.id}`}
        className={`rounded-xl border border-slate-800 bg-slate-950/60 ${
          guidance.guided ? 'transition hover:border-slate-700 hover:bg-slate-900/80' : 'opacity-90'
        }`}
      >
        <button
          type="button"
          onClick={() => handleClick(provider)}
          disabled={!guidance.guided}
          aria-describedby={!guidance.guided ? `provider-${provider.id}-manual-reason` : undefined}
          className="group flex w-full items-center justify-between gap-3 px-4 py-3 text-left disabled:cursor-not-allowed"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-white">{provider.name}</span>
              {configured ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : null}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
              <span>{authLabel(provider)}</span>
              {provider.freeTier ? (
                <>
                  <span className="text-slate-700">·</span>
                  <span className="text-emerald-400">{provider.freeTier}</span>
                </>
              ) : null}
            </div>
            {coverage ? (
              <div className="mt-1.5">
                <ProviderCoverageChips coverage={coverage} compact />
              </div>
            ) : null}
            {provider.dangerNote ? (
              <div className="mt-1 text-[11px] leading-relaxed text-red-300">{provider.dangerNote.compactDetail || provider.dangerNote.title}</div>
            ) : null}
            {readiness ? (
              <div className={`mt-1 text-[11px] leading-relaxed ${readinessClass}`}>
                {readiness.message}
              </div>
            ) : null}
            {!guidance.guided ? (
              <div
                id={`provider-${provider.id}-manual-reason`}
                className="mt-1 text-[11px] leading-relaxed text-amber-200"
              >
                {guidance.reason || 'Sign-in is not available from Portal on this server.'}
              </div>
            ) : null}
          </div>
          {guidance.guided ? (
            <ChevronRight className="h-4 w-4 shrink-0 text-slate-600 transition group-hover:text-slate-400" />
          ) : null}
        </button>
        {!guidance.guided && guidance.action ? (
          <div className="px-4 pb-3 pt-0">
            <a
              href={guidance.action.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-300 underline decoration-sky-400/40 hover:text-sky-200"
            >
              {guidance.action.label}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        ) : null}
        {provider.dangerNote?.link ? (
          <div className="px-4 pb-3 pt-0">
            <a
              href={provider.dangerNote.link.url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-300 underline decoration-sky-400/40 hover:text-sky-200"
            >
              {provider.dangerNote.link.label}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        ) : null}
        {showRemoval ? (
          <div className="border-t border-slate-800/80 px-4 py-3">
            {canRemove ? (
              <button
                type="button"
                onClick={() => onRemove(provider)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-200 transition hover:bg-red-500/15"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Disconnect
              </button>
            ) : (
              <div className="text-[11px] leading-relaxed text-slate-500">
                <span className="font-medium text-slate-400">Disconnect unavailable.</span>{' '}
                {status?.removal?.reason || 'This provider does not expose an exact server-authorized removal transaction.'}
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <ViewportModal open onDismiss={onClose} className="bg-black/50 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="openclaw-provider-picker-title"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-theme-border bg-theme-surface text-theme-text shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <h2 id="openclaw-provider-picker-title" className="text-lg font-semibold text-white">All Providers</h2>
            <p className="mt-0.5 text-sm text-slate-400">Choose a provider to set up. Each row shows the login, OpenClaw runtime, and harness state the server reports.</p>
          </div>
          <button
            type="button"
            aria-label="Close provider picker"
            onClick={onClose}
            className="rounded-lg border border-slate-800 bg-slate-950/70 p-2 text-slate-400 transition hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          {subscription.length > 0 ? (
            <div data-testid="provider-group-subscription">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Subscription / Sign-in</div>
              <div className="space-y-2">
                {subscription.map(renderRow)}
              </div>
            </div>
          ) : null}

          {apiKey.length > 0 ? (
            <div data-testid="provider-group-api-key">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">API Key</div>
              <div className="space-y-2">
                {apiKey.map(renderRow)}
              </div>
            </div>
          ) : null}

          {advanced.length > 0 ? (
            <details className="group" data-testid="provider-group-advanced">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-slate-600 hover:text-slate-400">
                Advanced / Other
              </summary>
              <div className="mt-2 space-y-2">
                {advanced.map(renderRow)}
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </ViewportModal>
  );
}
