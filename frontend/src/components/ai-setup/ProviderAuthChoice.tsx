import { Check, ChevronRight, KeyRound, LogIn, X } from 'lucide-react';
import ViewportModal from '../ViewportModal';
import type { ProviderAuthType, ProviderUIConfig } from './providerConfig';

interface ProviderAuthChoiceProps {
  provider: ProviderUIConfig;
  onSelect: (authType: ProviderAuthType) => void;
  onCancel: () => void;
}

export default function ProviderAuthChoice({ provider, onSelect, onCancel }: ProviderAuthChoiceProps) {
  const options = provider.authOptions || [];

  return (
    <ViewportModal open onDismiss={onCancel} className="bg-black/50 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-auth-choice-title"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-theme-border bg-theme-surface text-theme-text shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4">
          <div>
            <h2 id="provider-auth-choice-title" className="text-lg font-semibold text-white">Connect {provider.name}</h2>
            <p className="mt-1 text-sm text-slate-400">Choose how this server should authenticate.</p>
          </div>
          <button type="button" onClick={onCancel} aria-label="Close" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-5">
          {options.map((option) => {
            const Icon = option.type === 'api_key' ? KeyRound : LogIn;
            return (
              <button
                key={option.type}
                type="button"
                onClick={() => onSelect(option.type)}
                className="group flex w-full items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-left transition hover:border-emerald-500/40 hover:bg-slate-950"
              >
                <span className="rounded-xl border border-slate-800 bg-slate-900 p-2 text-emerald-300">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-white">{option.label}</span>
                    {option.recommended ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                        <Check className="h-3 w-3" /> Recommended
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 block text-sm leading-relaxed text-slate-400">{option.description}</span>
                </span>
                <ChevronRight className="mt-2 h-4 w-4 shrink-0 text-slate-600 transition group-hover:text-emerald-300" />
              </button>
            );
          })}
        </div>
      </div>
    </ViewportModal>
  );
}
