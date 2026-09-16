import { ExternalLink, X } from 'lucide-react';
import ViewportModal from '../ViewportModal';
import ProviderCoverageChips from './ProviderCoverageChips';
import { getSharedLoginNote, type ProviderCoverage } from './providerCoverage';
import type { ProviderUIConfig } from './providerConfig';

interface ProviderManualNoticeProps {
  provider: ProviderUIConfig;
  coverage: ProviderCoverage;
  /** Server-reported reason from the OAuth support probe, when it adds detail. */
  serverReason?: string | null;
  onClose: () => void;
}

/**
 * Shown when a subscription provider is visible but Portal cannot run its
 * sign-in on this server build. It says exactly why, links the provider's own
 * instructions, and reports the current login/runtime state instead of
 * silently ignoring the click.
 */
export default function ProviderManualNotice({ provider, coverage, serverReason = null, onClose }: ProviderManualNoticeProps) {
  const manual = provider.guidedSetup.status === 'manual' ? provider.guidedSetup : null;
  const reason = serverReason || manual?.reason || 'Portal cannot start this sign-in on this server build.';
  const sharedNote = getSharedLoginNote(provider.id);

  return (
    <ViewportModal open onDismiss={onClose} className="bg-black/50 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-manual-notice-title"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-theme-border bg-theme-surface text-theme-text shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4">
          <div>
            <h2 id="provider-manual-notice-title" className="text-lg font-semibold text-white">{provider.name}</h2>
            <p className="mt-1 text-sm text-slate-400">Sign-in is not available from Portal on this server right now.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close provider notice" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100" role="status">
            {reason}
          </div>

          <ProviderCoverageChips coverage={coverage} showDetails />

          {sharedNote ? (
            <p className="text-xs leading-relaxed text-slate-400">{sharedNote}</p>
          ) : null}

          <p className="text-sm text-slate-300">{provider.description}</p>

          {manual ? (
            <a
              href={manual.action.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-sky-300 underline decoration-sky-400/40 hover:text-sky-200"
            >
              {manual.action.label}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}

          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-800">
              Close
            </button>
          </div>
        </div>
      </div>
    </ViewportModal>
  );
}
