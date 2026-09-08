import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useChatState } from '../../contexts/ChatStateProvider';
import { useAuthStore } from '../../contexts/AuthContext';
import { loadAndApplyDefaultAgentHarness } from '../../api/agentHarnessPreference';
import { openClawTaskConversation } from '../../utils/taskConversation';

/** Explicit read/navigation, never a prompt, model call, or default preference write. */
export default function TaskConversationNavigation() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('openclawSession');
  const target = openClawTaskConversation(requested);
  const userId = useAuthStore((state) => state.user?.id);
  const { selectProviderAgent, selectSession } = useChatState();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const scope = `${userId}:${requested}`;
  const scopeRef = useRef<string | null>(scope);
  scopeRef.current = scope;
  useEffect(() => () => { scopeRef.current = null; }, []);
  useEffect(() => { setPending(false); setError(false); }, [scope]);
  if (!requested) return null;
  const dismiss = () => { const next = new URLSearchParams(params); next.delete('openclawSession'); setParams(next, { replace: true }); };
  return <section aria-label="Task conversation" className="flex flex-wrap items-center justify-between gap-3 border-b border-sky-400/15 bg-sky-400/10 px-4 py-3 text-sm text-slate-200">
    <div className="min-w-0">
      <p>{target ? `Open this task conversation with OpenClaw · ${target.agentId}` : 'This task has no valid OpenClaw conversation link.'}</p>
      {target && <p className="mt-1 text-xs text-slate-400">Your saved default stays unchanged. Running work continues.</p>}
      {error && <p role="alert" className="mt-1 text-xs text-amber-200">The conversation could not be opened. Try again.</p>}
    </div>
    <div className="flex gap-2">
      {target && <button type="button" disabled={pending || !userId} className="min-h-[40px] rounded-lg bg-sky-400 px-3 font-medium text-slate-950 disabled:opacity-50" onClick={async () => {
        if (pending || !userId) return;
        setPending(true); setError(false);
        try {
          // Finish initial saved-preference hydration before this explicit choice,
          // so a late initial GET cannot retarget the conversation afterward.
          await loadAndApplyDefaultAgentHarness(userId);
          if (scopeRef.current !== scope) return;
          selectProviderAgent('OPENCLAW', target.agentId);
          await selectSession(target.session);
          if (scopeRef.current === scope) dismiss();
        } catch { if (scopeRef.current === scope) setError(true); }
        finally { if (scopeRef.current === scope) setPending(false); }
      }}>{pending ? 'Opening…' : 'Open conversation'}</button>}
      <button type="button" onClick={dismiss} className="min-h-[40px] rounded-lg border border-white/10 px-3 text-slate-300">Dismiss</button>
    </div>
  </section>;
}
