import { CheckCircle2, ChevronRight, ExternalLink, Trash2, X } from 'lucide-react';
import ViewportModal from '../ViewportModal';
import type { ProviderStatus } from './ProviderCard';
import type { ProviderUIConfig } from './providerConfig';
import { canRemoveProviderStatus, providerStatusCanShowRemoval } from './providerRemovalContract';

interface OpenClawProviderPickerProps {
  providers: ProviderUIConfig[];
  statusMap: Map<string, ProviderStatus>;
  onSelect: (provider: ProviderUIConfig) => void;
  onRemove: (provider: ProviderUIConfig) => void;
  onDeviceFlow: () => void;
  onClose: () => void;
}

function authLabel(provider: ProviderUIConfig) {
  if (provider.guidedSetup.status === 'manual') {
    return 'Manual configuration only';
  }
  if (provider.authOptions?.length) {
    return provider.authOptions.map((option) => option.type === 'api_key' ? 'API key' : 'Subscription sign-in').join(' or ');
  }
  switch (provider.primaryAuthType) {
    case 'oauth':
      return 'Browser sign-in';
    case 'setup_token':
      return 'Setup token';
    case 'device_code':
      return 'Device code';
    case 'native_cli':
      return 'Native CLI';
    case 'aws_sdk':
      return 'AWS credentials (manual)';
    default:
      return 'API key';
  }
}

// Group: subscription-style first, then API key providers, then advanced
function groupProviders(providers: ProviderUIConfig[]) {
  // Antigravity is a Portal-native Agent Chat harness. Keep it on the native
  // Quick Start card and never imply that it is an OpenClaw OAuth provider.
  const openClawProviders = providers.filter((p) => p.id !== 'google-antigravity');
  const guidedProviders = openClawProviders.filter((p) => p.guidedSetup.status === 'available');
  const subscription = guidedProviders.filter((p) => p.primaryAuthType === 'oauth' || p.primaryAuthType === 'setup_token' || p.primaryAuthType === 'device_code' || p.primaryAuthType === 'native_cli');
  const apiKey = guidedProviders.filter((p) => p.primaryAuthType === 'api_key' && p.tier <= 2);
  const advanced = openClawProviders.filter((p) => (
    p.guidedSetup.status === 'manual'
    || (p.guidedSetup.status === 'available' && (
      (p.primaryAuthType === 'api_key' && p.tier > 2)
      || p.primaryAuthType === 'aws_sdk'
    ))
  ));
  return { subscription, apiKey, advanced };
}

export default function OpenClawProviderPicker({ providers, statusMap, onSelect, onRemove, onDeviceFlow, onClose }: OpenClawProviderPickerProps) {
  const { subscription, apiKey, advanced } = groupProviders(providers);

  const handleClick = (provider: ProviderUIConfig) => {
    if (provider.guidedSetup.status !== 'available') return;
    if (provider.id === 'github-copilot') {
      onDeviceFlow();
    } else {
      onSelect(provider);
    }
  };

  const renderRow = (provider: ProviderUIConfig) => {
    const guidedSetupAvailable = provider.guidedSetup.status === 'available';
    const status = statusMap.get(provider.id);
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
        className={`rounded-xl border border-slate-800 bg-slate-950/60 ${
          guidedSetupAvailable ? 'transition hover:border-slate-700 hover:bg-slate-900/80' : 'opacity-80'
        }`}
      >
        <button
          type="button"
          onClick={() => handleClick(provider)}
          disabled={!guidedSetupAvailable}
          aria-describedby={!guidedSetupAvailable ? `provider-${provider.id}-manual-reason` : undefined}
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
            {provider.dangerNote ? (
              <div className="mt-1 text-[11px] leading-relaxed text-red-300">{provider.dangerNote.compactDetail || provider.dangerNote.title}</div>
            ) : null}
            {readiness ? (
              <div className={`mt-1 text-[11px] leading-relaxed ${readinessClass}`}>
                {readiness.message}
              </div>
            ) : null}
            {provider.guidedSetup.status === 'manual' ? (
              <div
                id={`provider-${provider.id}-manual-reason`}
                className="mt-1 text-[11px] leading-relaxed text-amber-200"
              >
                {provider.guidedSetup.reason}
              </div>
            ) : null}
          </div>
          {guidedSetupAvailable ? (
            <ChevronRight className="h-4 w-4 shrink-0 text-slate-600 transition group-hover:text-slate-400" />
          ) : null}
        </button>
        {provider.guidedSetup.status === 'manual' ? (
          <div className="px-4 pb-3 pt-0">
            <a
              href={provider.guidedSetup.action.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-300 underline decoration-sky-400/40 hover:text-sky-200"
            >
              {provider.guidedSetup.action.label}
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
            <p className="mt-0.5 text-sm text-slate-400">Choose a provider to set up.</p>
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
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Subscription / Sign-in</div>
              <div className="space-y-2">
                {subscription.map(renderRow)}
              </div>
            </div>
          ) : null}

          {apiKey.length > 0 ? (
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">API Key</div>
              <div className="space-y-2">
                {apiKey.map(renderRow)}
              </div>
            </div>
          ) : null}

          {advanced.length > 0 ? (
            <details className="group">
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
