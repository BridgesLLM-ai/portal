import { useEffect, useState } from 'react';
import { PORTAL_MODULE_UPDATE_EVENT } from '../utils/moduleRecovery';

/**
 * Shown when this tab asked for a view that only exists in the newer Portal
 * release now running on the server. Nothing reloads until the user says so.
 */
export default function ModuleUpdateNotice() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = () => setVisible(true);
    window.addEventListener(PORTAL_MODULE_UPDATE_EVENT, show);
    return () => window.removeEventListener(PORTAL_MODULE_UPDATE_EVENT, show);
  }, []);
  if (!visible) return null;
  return (
    <section role="alert" aria-label="Portal update available"
      className="fixed bottom-4 left-4 right-4 z-[10000] mx-auto max-w-xl rounded-xl border border-theme-border bg-theme-surface p-5 text-theme-text shadow-2xl">
      <h2 className="font-semibold">Portal was updated</h2>
      <p className="mt-2 text-sm">
        This tab needs the new version to open that view. Your drafts stay here until you reload; save or copy
        anything unsaved first.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" onClick={() => window.location.reload()}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-light)]">
          Reload
        </button>
        <button type="button" onClick={() => setVisible(false)}
          className="rounded-lg border border-theme-border px-4 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-light)]">
          Keep working
        </button>
      </div>
    </section>
  );
}
