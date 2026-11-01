import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, X, Paperclip, BookOpen, Sparkles, GitBranch, PanelTop, Code2, Download, Check, ChevronRight, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import AnchoredPopover from '../AnchoredPopover';
import client from '../../api/client';
import { useAuthStore } from '../../contexts/AuthContext';
import { useChatState } from '../../contexts/ChatStateProvider';
import type { ChatResponseFormat } from '../../utils/chatResponseFormat';

type Format = { id: ChatResponseFormat; label: string; available: boolean; description: string; reason?: string | null };
type Catalog = { schema: string; provider: string; formats: Format[] };
const FORMAT_ICONS: Record<ChatResponseFormat, typeof Sparkles> = { auto: Sparkles, mermaid: GitBranch, widget: PanelTop, code: Code2, file: Download };
const FORMAT_IDS = new Set<string>(Object.keys(FORMAT_ICONS));

function validCatalog(data: unknown, provider: string): data is Catalog {
  const catalog = data as Catalog | null;
  return Boolean(catalog && catalog.schema === 'portal-response-tools-v1' && catalog.provider === provider
    && Array.isArray(catalog.formats) && catalog.formats.every((format) => format && FORMAT_IDS.has(format.id)
      && typeof format.label === 'string' && typeof format.available === 'boolean' && typeof format.description === 'string'));
}

/**
 * Optional next-response preference plus attachments. The server reports what
 * this harness and chat can actually deliver; selecting a format never enables
 * a tool, grants a permission or changes the agent's tool policy.
 */
export default function ResponseToolsDrawer({ onAttach }: { onAttach: () => void }) {
  const { provider, session, agentId, selectedModel, isRunning, responseFormat, setResponseFormat } = useChatState();
  const actor = useAuthStore((state) => `${state.user?.id || ''}:${state.user?.role || ''}:${state.user?.authorizationVersion ?? 1}`);
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const scope = `${actor}:${provider}:${agentId || ''}:${session}:${selectedModel}`;
  const [catalogScope, setCatalogScope] = useState('');
  const current = catalogScope === scope ? catalog : null;
  useEffect(() => {
    let active = true;
    setCatalog(null); setError(''); setCatalogScope('');
    if (!open) return;
    client.get('/gateway/response-capabilities', { params: { provider, session, agentId }, timeout: 10_000 })
      .then(({ data }) => {
        if (!active) return;
        if (!validCatalog(data, provider)) throw new Error('Invalid response tools');
        setCatalog(data); setCatalogScope(scope);
      }).catch(() => { if (active) setError('Could not check response tools. Retry when the chat is connected.'); });
    return () => { active = false; };
  }, [open, scope, retry, provider, session, agentId]);
  useEffect(() => { setOpen(false); }, [scope]);
  const close = useCallback(() => { setOpen(false); button.current?.focus(); }, []);
  return <div className="relative flex-shrink-0 mb-0.5">
    <button ref={button} type="button" aria-label="Response tools and attachments" aria-expanded={open} aria-controls="response-tools-drawer"
      onClick={() => setOpen((value) => !value)} className="p-2 sm:p-2.5 rounded-xl text-slate-300 transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-light)] touch-target" title="Response tools and attachments">
      <Plus size={18} className="sm:w-[18px] sm:h-[18px] w-4 h-4" />
    </button>
    <AnchoredPopover open={open} anchorRef={button} onDismiss={close} width={368} align="start" ariaLabel="Response tools"
      className="overflow-hidden rounded-2xl border border-white/10 bg-[var(--color-surface-raised)] shadow-2xl shadow-black/30">
      <section id="response-tools-drawer" aria-label="Response tools" className="min-h-0 overflow-y-auto overscroll-contain p-2">
        <div className="flex items-center gap-2.5 px-2 pb-1 pt-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5" aria-hidden="true"><img src="/favicon-192.png" alt="" width={26} height={26} /></span>
          <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-slate-100">Response tools</h3><p className="mt-0.5 text-[11px] text-slate-400">A preference for your next reply</p></div>
          <button type="button" aria-label="Close response tools" onClick={close} className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-light)]"><X size={16} /></button>
        </div>
        <p className="px-2 pb-3 pt-2 text-xs leading-relaxed text-slate-400">The agent chooses formats naturally. Pick one only when you have one in mind; it does not turn tools on or off.</p>
        {isRunning && <p role="status" className="mx-1 mb-2 rounded-lg border border-amber-400/15 bg-amber-400/5 p-2.5 text-xs text-amber-200">Response tools apply to a new turn. Wait for this response to finish.</p>}
        {!current && !error && <p role="status" className="flex items-center gap-2 p-3 text-xs text-slate-400"><Loader2 size={14} className="motion-safe:animate-spin" />Checking this chat’s capabilities…</p>}
        {error && <div role="alert" className="p-2 text-xs text-amber-200">{error}<button type="button" onClick={() => setRetry((value) => value + 1)} className="ml-2 underline">Retry</button></div>}
        <div className="space-y-1">{current?.formats.map((format) => {
          const Icon = FORMAT_ICONS[format.id] || Sparkles;
          const selected = responseFormat === format.id;
          return <button key={format.id} type="button" disabled={isRunning || !format.available}
            aria-pressed={selected} onClick={() => { setResponseFormat(format.id); close(); }}
            className={`group flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-light)] disabled:cursor-not-allowed disabled:opacity-50 ${selected ? 'border-[var(--accent-border)] bg-[var(--accent-bg)]' : 'border-transparent hover:border-white/5 hover:bg-white/5'}`}
            title={format.reason || format.description}>
            <span aria-hidden="true" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${selected ? 'bg-[var(--accent-bg)] text-[var(--accent-light)]' : 'bg-white/5 text-slate-400 group-hover:text-slate-200'}`}><Icon size={17} /></span>
            <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-slate-100">{format.label}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-slate-400">{format.reason || format.description}</span></span>
            {selected && <Check size={15} aria-hidden="true" className="shrink-0 text-[var(--accent-light)]" />}
          </button>;
        })}</div>
        <div className="mt-2 border-t border-white/10 px-1 pt-2">
          <button type="button" disabled={isRunning} onClick={() => { setOpen(false); onAttach(); }} className="flex w-full items-center gap-2.5 rounded-lg p-2.5 text-sm text-slate-200 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-light)] disabled:opacity-50"><Paperclip size={16} aria-hidden="true" />Attach files</button>
          <Link to="/agent-tools?tab=skills" className="flex items-center gap-2.5 rounded-lg p-2.5 text-sm text-slate-200 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-light)]"><BookOpen size={16} aria-hidden="true" /><span className="flex-1">Skills &amp; guides</span><ChevronRight size={14} aria-hidden="true" className="text-slate-500" /></Link>
        </div>
      </section>
    </AnchoredPopover>
  </div>;
}
