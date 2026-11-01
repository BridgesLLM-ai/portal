import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import client from '../../../api/client';
import { clientCryptographicRandomId } from '../../../utils/clientId';
import { WORKSPACE_AUTHORIZATION_CHANGED_EVENT } from '../../../utils/workspaceAuthorization';
import { acceptWidgetMessage, liveWidgetDocumentPath, MAX_WIDGET_HTML_BYTES, parseWidgetReference, widgetDocumentPath, WIDGET_CHANNEL } from './widgetModel';

export type OwnedWidgetDocument = { status: 'loading' | 'ready' | 'error'; html?: string; message?: string };

/**
 * Read one widget document through the same owner-checked route the inline
 * card uses (OpenClaw canvas or the Portal chat bridge store). The reference
 * must still describe an inline document for this exact tool call. A live
 * widget (boardName) reads its newest version first; when the Gateway refuses
 * that, it shows the version this chat last saw.
 */
export function useOwnedWidgetDocument(provider: string, session: string, toolCallId: string, active = true, boardName?: string): OwnedWidgetDocument & { retry: () => void } {
  const [state, setState] = useState<OwnedWidgetDocument>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [revoked, setRevoked] = useState(false);
  useEffect(() => {
    const revoke = () => { setRevoked(true); setState({ status: 'error', message: 'Sign-in permissions changed. Reload the page.' }); };
    window.addEventListener(WORKSPACE_AUTHORIZATION_CHANGED_EVENT, revoke);
    return () => window.removeEventListener(WORKSPACE_AUTHORIZATION_CHANGED_EVENT, revoke);
  }, []);
  useEffect(() => {
    if (!active || revoked) return;
    const path = widgetDocumentPath(session, toolCallId, provider);
    const livePath = boardName ? liveWidgetDocumentPath(session, boardName, provider) : null;
    if (!path && !livePath) { setState({ status: 'error', message: 'This widget belongs to a conversation that is not saved yet.' }); return; }
    const controller = new AbortController();
    const options = { signal: controller.signal, timeout: 30000, _silent: true, _skipNetworkRetry: true } as any;
    const documentHtml = (data: any, expectedToolCallId: string, expectedBoard?: string): string => {
      const reference = parseWidgetReference('show_widget', expectedToolCallId, JSON.stringify(data?.reference));
      if (data?.v !== 1 || reference?.mode !== 'inline' || (expectedBoard !== undefined && reference.boardName !== expectedBoard)
        || typeof data.html !== 'string' || new TextEncoder().encode(data.html).length > MAX_WIDGET_HTML_BYTES) throw new Error('invalid');
      return data.html;
    };
    const read = async (): Promise<string> => {
      if (livePath) {
        try {
          const { data } = await client.get(livePath, options);
          const newest = typeof data?.reference?.toolCallId === 'string' ? data.reference.toolCallId : '';
          return documentHtml(data, newest, boardName);
        } catch (error) {
          if (controller.signal.aborted || !path) throw error;
        }
      }
      const { data } = await client.get(path!, options);
      return documentHtml(data, toolCallId);
    };
    setState({ status: 'loading' });
    void read().then((html) => {
      if (!controller.signal.aborted) setState({ status: 'ready', html });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: 'error', message: 'Widget unavailable. Open the chat or ask the agent to recreate it.' });
    });
    return () => controller.abort();
  }, [provider, session, toolCallId, active, attempt, revoked, boardName]);
  return { ...state, retry: () => { if (!revoked) setAttempt((value) => value + 1); } };
}

/**
 * The same credential-free opaque shell as inline chat widgets, for surfaces
 * outside the transcript (side panel, floating windows). No widget HTML enters
 * the Portal DOM; the document is posted into the sandbox once.
 */
export function WidgetFrame({ html, title, fill = false, onState }: {
  html: string; title: string; fill?: boolean;
  onState?: (state: 'ready' | 'error', message?: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [instance, setInstance] = useState('');
  const [height, setHeight] = useState(240);
  const report = useRef(onState);
  report.current = onState;

  useEffect(() => {
    try { setInstance(clientCryptographicRandomId('widget-')); }
    catch { report.current?.('error', 'This browser cannot create an isolated widget channel.'); }
  }, [html]);

  // Install the bridge during commit: a cached shell can announce ready before a passive effect runs.
  useLayoutEffect(() => {
    if (!instance) return;
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
    const timer = window.setTimeout(() => { if (!rendered) report.current?.('error', 'Widget did not finish loading.'); }, 10000);
    const onMessage = (event: MessageEvent) => {
      const message = acceptWidgetMessage(event, frame.current?.contentWindow || null, instance);
      if (!message) return;
      for (const port of event.ports || []) port.close();
      if (message.type === 'ready' && !delivered) { delivered = true; post({ type: 'document', html }); }
      else if (message.type === 'rendered' && delivered && !rendered) { rendered = true; window.clearTimeout(timer); sendTheme(); report.current?.('ready'); }
      else if (message.type === 'size' && delivered && Date.now() - lastSize >= 50) { lastSize = Date.now(); setHeight(message.height!); }
      else if (message.type === 'error') report.current?.('error', 'Widget reported a rendering error.');
    };
    window.addEventListener('message', onMessage);
    const observer = new MutationObserver(sendTheme);
    observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    return () => { window.clearTimeout(timer); observer.disconnect(); window.removeEventListener('message', onMessage); };
  }, [html, instance]);

  if (!instance) return null;
  return <iframe key={instance} ref={frame} title={`${title} — isolated interactive content`}
    src={`/api/chat-widgets/sandbox#${instance}`} sandbox="allow-scripts" referrerPolicy="no-referrer"
    allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'"
    className={fill ? 'h-full min-h-0 w-full border-0' : 'w-full max-w-full border-0'}
    style={fill ? undefined : { height }} />;
}
