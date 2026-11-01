import ToolGlyph from '../ToolGlyph';
import { useWidgetPresentation } from './WidgetPresentationContext';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2, PanelRight, PictureInPicture2, RefreshCw } from 'lucide-react';
import { useAgentWorkspaceTarget } from '../workspace/AgentWorkspaceContext';
import { useAgentWorkspaceStore, useFloatingWidgetsStore } from '../../../stores/agentWorkspaceStore';
import client from '../../../api/client';
import { useAuthStore } from '../../../contexts/AuthContext';
import { useChatState, type ToolCall } from '../../../contexts/ChatStateProvider';
import { clientCryptographicRandomId } from '../../../utils/clientId';
import { WORKSPACE_AUTHORIZATION_CHANGED_EVENT } from '../../../utils/workspaceAuthorization';
import { acceptWidgetMessage, MAX_WIDGET_HTML_BYTES, parseWidgetReference, widgetDocumentPath, WIDGET_CHANNEL } from './widgetModel';

/** No HTML enters the Portal DOM; only the fixed, credential-free opaque shell is framed. */
export function ChatWidgetCard({ tool }: { tool: ToolCall }) {
  const { session, provider } = useChatState();
  const actor = useAuthStore(state => state.user);
  // Every harness: OpenClaw widgets come from its canvas, native harness widgets
  // from the Portal Chat Bridge store. Both routes enforce owner and binding.
  return <ScopedChatWidgetCard key={`${actor?.id}:${actor?.authorizationVersion}:${provider}:${session}:${tool.id}`}
    tool={tool} session={session} provider={provider} enabled={Boolean(actor?.id)} />;
}
export function ScopedChatWidgetCard({ tool, session, provider = 'OPENCLAW', enabled }: {
  tool: ToolCall;
  session: string;
  provider?: string;
  enabled: boolean;
}) {
  const reference = useMemo(() => parseWidgetReference(tool.name, tool.id, tool.result), [tool.name, tool.id, tool.result]);
  const documentPath = useMemo(() => widgetDocumentPath(session, tool.id, provider), [session, tool.id, provider]);
  const [retry, setRetry] = useState(0);
  const [document, setDocument] = useState<{ html: string; scope: string } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [revoked, setRevoked] = useState(false);
  const presentationHeight = useWidgetPresentation().heights.get(tool.id);
  const [height, setHeight] = useState(320);
  const [expanded, setExpanded] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const card = useRef<HTMLElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const canRender = enabled && !revoked && reference?.mode === 'inline' && tool.status === 'done' && documentPath !== null;
  const scope = `${session}:${tool.id}:${retry}`;
  const [instance, setInstance] = useState('');

  useEffect(() => {
    const revoke = () => { setRevoked(true); setDocument(null); setExpanded(false); setStatus('error'); setError('Sign-in permissions changed. Reload the chat.'); };
    window.addEventListener(WORKSPACE_AUTHORIZATION_CHANGED_EVENT, revoke);
    return () => window.removeEventListener(WORKSPACE_AUTHORIZATION_CHANGED_EVENT, revoke);
  }, []);

  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setDocument(null); setStatus('loading'); setError(''); setHeight(320);
    if (!canRender || !documentPath) return () => controller.abort();
    try { setInstance(clientCryptographicRandomId('widget-')); }
    catch { setStatus('error'); setError('This browser cannot create an isolated widget channel.'); return; }
    void client.get(documentPath, { signal: controller.signal, timeout: 30000,
      _silent: true, _skipNetworkRetry: true } as any).then(({ data }) => {
      if (!active || controller.signal.aborted) return;
      const ref = parseWidgetReference('show_widget', tool.id, JSON.stringify(data?.reference));
      if (data?.v !== 1 || ref?.mode !== 'inline' || typeof data.html !== 'string'
        || new TextEncoder().encode(data.html).length > MAX_WIDGET_HTML_BYTES) throw new Error('Invalid document');
      setDocument({ html: data.html, scope });
    }).catch(() => {
      if (!active || controller.signal.aborted) return;
      setStatus('error'); setError('Widget unavailable. Retry or ask the agent to recreate it.');
    });
    return () => { active = false; controller.abort(); };
  }, [canRender, documentPath, session, tool.id, scope]);

  // Install the bridge during commit: a cached shell can announce ready before
  // a passive effect runs. Missing that one-shot message leaves an empty card.
  useLayoutEffect(() => {
    if (!canRender || document?.scope !== scope || !instance) return;
    let delivered = false; let rendered = false; let lastSize = 0;
    const post = (data: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ channel: WIDGET_CHANNEL, instance, ...data }, '*');
    const sendTheme = () => {
      const root = window.document.documentElement;
      const css = getComputedStyle(root);
      const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
      const light = root.dataset.theme === 'light';
      post({ type: 'theme', mode: light ? 'light' : 'dark', tokens: {
        surface: 'transparent', card: get('--color-surface', light ? '#ffffff' : '#151a30'),
        elevated: get('--color-surface-raised', light ? '#f1f5f9' : '#202640'),
        text: get('--color-text', light ? '#172033' : '#e2e8f0'),
        'text-strong': get('--color-text', light ? '#172033' : '#f8fafc'),
        muted: get('--color-text-subtle', light ? '#475569' : '#94a3b8'),
        border: get('--color-border', light ? '#cbd5e1' : '#334155'),
        accent: get('--color-accent', '#6366f1'), 'accent-fill': get('--color-accent', '#6366f1'),
        'accent-fg': '#ffffff', radius: '12px', 'font-body': 'system-ui, sans-serif', 'font-mono': 'ui-monospace, monospace',
      } });
    };
    const timer = window.setTimeout(() => {
      if (!rendered) { setStatus('error'); setError('Widget did not finish loading. Retry to reload it.'); }
    }, 10000);
    const onMessage = (event: MessageEvent) => {
      const message = acceptWidgetMessage(event, frame.current?.contentWindow || null, instance);
      if (!message) return;
      for (const port of event.ports || []) port.close();
      if (message.type === 'ready' && !delivered) { delivered = true; post({ type: 'document', html: document.html }); }
      else if (message.type === 'rendered' && delivered && !rendered) {
        rendered = true; window.clearTimeout(timer); setStatus('ready'); sendTheme();
      } else if (message.type === 'size' && delivered && Date.now() - lastSize >= 50) {
        lastSize = Date.now(); setHeight(message.height!);
      } else if (message.type === 'error') {
        setStatus('error'); setError('Widget reported a rendering error. Retry or ask the agent to correct it.');
      }
    };
    window.addEventListener('message', onMessage);
    const observer = new MutationObserver(sendTheme);
    observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    return () => { window.clearTimeout(timer); observer.disconnect(); window.removeEventListener('message', onMessage); };
  }, [canRender, document, instance, scope]);

  useEffect(() => {
    if (!expanded) return;
    const previous = window.document.activeElement as HTMLElement | null;
    expandButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setExpanded(false); }
      if (event.key === 'Tab') {
        const controls = card.current?.querySelectorAll<HTMLElement>('button:not([disabled]),iframe');
        if (!controls?.length) return;
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [expanded]);

  const title = reference?.title || (typeof tool.arguments?.title === 'string' ? tool.arguments.title.slice(0, 160) : 'Widget');
  const explanatory = tool.status === 'running' ? 'Preparing widget…' : tool.status === 'error' ? 'The widget tool failed.'
    : reference?.mode === 'dashboard' ? (reference.boardName
      ? 'Live widget updated on the session dashboard. The Widgets tab in the side panel shows its newest version.'
      : 'Saved to the session dashboard. This result has no inline preview; dashboard management is separate.')
    : !enabled ? 'Sign in again to show this widget.'
    : !documentPath ? 'This widget belongs to a conversation that is not saved yet. Reload the chat to show it.'
    : !reference || reference.mode === 'unsupported' ? 'This output has no supported inline Canvas document. It has not been rendered.' : '';
  const displayDocument = canRender && document?.scope === scope && instance;
  // Beside-the-chat and floating copies re-read the same owner-checked document.
  const workspace = useAgentWorkspaceTarget();
  const [popNotice, setPopNotice] = useState('');
  const canPop = Boolean(workspace) && canRender && workspace?.session === session;
  const popOut = () => {
    const widget = useFloatingWidgetsStore.getState().popOut({ provider, session, toolCallId: tool.id, title });
    setPopNotice(widget ? 'Floating over every page. Drag its bar to move it.' : useFloatingWidgetsStore.getState().error);
  };
  return <section id={`chat-widget-${tool.id}`} ref={card} aria-label={title} role={expanded ? 'dialog' : undefined} aria-modal={expanded || undefined}
    className={expanded ? 'fixed inset-3 z-[100] flex flex-col overflow-hidden rounded-xl border border-slate-500/40 bg-slate-950 shadow-2xl sm:inset-10' : 'my-3 min-w-0 overflow-hidden rounded-xl border border-slate-500/30 bg-slate-500/5'}>
    <header className="flex min-w-0 items-center gap-2 border-b border-slate-500/20 px-3 py-2">
      <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-violet-400/20 bg-violet-400/10 text-violet-300"><ToolGlyph toolName="show_widget" size={15} /></span>
      <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold text-slate-200">{title}</h3><p className="text-[10px] text-slate-400">Interactive result</p></div>
      {canPop && !expanded && <button type="button" aria-label="Open widget in side panel" title="Open beside the chat"
        className="rounded-md p-2 hover:bg-slate-500/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
        onClick={() => useAgentWorkspaceStore.getState().openPreview({ kind: 'widget', title, provider: provider.toUpperCase(), session, toolCallId: tool.id, ...(reference?.boardName ? { boardName: reference.boardName } : {}) })}><PanelRight size={16} /></button>}
      {canPop && !expanded && <button type="button" aria-label="Pop out widget" title="Pop out — keep it on screen over any page"
        className="rounded-md p-2 hover:bg-slate-500/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
        onClick={popOut}><PictureInPicture2 size={16} /></button>}
      {displayDocument && <button type="button" ref={expandButton} aria-label={expanded ? 'Collapse widget' : 'Expand widget'}
        className="rounded-md p-2 hover:bg-slate-500/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
        onClick={() => { setExpanded(value => !value); }}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>}
    </header>
    {explanatory ? <p className="px-3 py-4 text-sm text-slate-400">{explanatory}</p> : <>
      {status === 'loading' && <p role="status" className="px-3 py-2 text-sm text-slate-400">Loading interactive widget…</p>}
      {status === 'error' && <div role="alert" className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm text-amber-500">
        <span className="flex-1">{error}</span>{!revoked && <button type="button" className="inline-flex items-center gap-1 rounded-md border border-current px-2 py-1" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />Retry</button>}
      </div>}
      {displayDocument && <iframe key={`${scope}:${instance}`} ref={frame} title={`${title} — isolated interactive content`}
        src={`/api/chat-widgets/sandbox#${instance}`} sandbox="allow-scripts" referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'"
        className={expanded ? 'min-h-0 w-full flex-1 border-0' : 'w-full max-w-full border-0'}
        style={expanded ? undefined : { height: presentationHeight ?? height }} onError={() => { setStatus('error'); setError('Widget sandbox unavailable. Retry to reload it.'); }} />}
      <p className="border-t border-slate-500/20 px-3 py-2 text-xs text-slate-400">{popNotice || (reference?.boardName
        ? 'Live widget: this card is the version from this turn; the side panel shows the newest. Local interaction only.'
        : 'Local interaction only. Chat prompts and dashboard data/actions are disabled.')}</p>
    </>}
  </section>;
}
