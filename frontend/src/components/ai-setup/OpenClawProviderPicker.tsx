import { CheckCircle2, ChevronRight, ExternalLink, X } from 'lucide-react';
import type { ProviderStatus } from './ProviderCard';
import { PROVIDERS, type ProviderUIConfig } from './providerConfig';

interface OpenClawProviderPickerProps {
  statusMap: Map<string, ProviderStatus>;
  onSelect: (provider: ProviderUIConfig) => void;
  onDeviceFlow: () => void;
  onClose: () => void;
}

function authLabel(provider: ProviderUIConfig) {
  switch (provider.primaryAuthType) {
    case 'oauth':
      return 'Browser sign-in';
    case 'setup_token':
      return 'Setup token';
    case 'device_code':
      return 'Device code';
    default:
      return 'API key';
  }
}

// Group: subscription-style first, then API key providers, then advanced
function groupProviders() {
  const subscription = PROVIDERS.filter((p) => p.primaryAuthType === 'oauth' || p.primaryAuthType === 'setup_token' || p.primaryAuthType === 'device_code');
  const apiKey = PROVIDERS.filter((p) => p.primaryAuthType === 'api_key' && p.tier <= 2);
  const advanced = PROVIDERS.filter((p) => p.primaryAuthType === 'api_key' && p.tier > 2);
  return { subscription, apiKey, advanced };
}

export default function OpenClawProviderPicker({ statusMap, onSelect, onDeviceFlow, onClose }: OpenClawProviderPickerProps) {
  const { subscription, apiKey, advanced } = groupProviders();

  const handleClick = (provider: ProviderUIConfig) => {
    if (provider.id === 'github-copilot') {
      onDeviceFlow();
    } else {
      onSelect(provider);
    }
  };

  const renderRow = (provider: ProviderUIConfig) => {
    const status = statusMap.get(provider.id);
    const configured = status?.status === 'configured';

    return (
      <div
        key={provider.id}
        className="rounded-xl border border-slate-800 bg-slate-950/60 transition hover:border-slate-700 hover:bg-slate-900/80"
      >
        <button
          type="button"
          onClick={() => handleClick(provider)}
          className="group flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
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
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-slate-600 transition group-hover:text-slate-400" />
        </button>
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
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">All Providers</h2>
            <p className="mt-0.5 text-sm text-slate-400">Choose a provider to set up.</p>
          </div>
          <button
            type="button"
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
    </div>
  );
}
