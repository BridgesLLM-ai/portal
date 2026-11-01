import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Globe, Loader2, Maximize2, Minimize2, MonitorPlay, MousePointer2, RefreshCw } from 'lucide-react';
import client from '../../../api/client';
import type { BrowserActivity } from './artifacts';

type Tab = { targetId: string; title: string; url: string };
type Live = { status: 'idle' | 'connecting' | 'live' | 'ended'; url?: string; title?: string; message?: string };
type FrameHeader = { url: string; cssWidth: number; cssHeight: number };
const REMOTE_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const SHORTCUTS = new Set(['Control+A', 'Control+Z', 'Control+Shift+Z', 'Control+Y', 'Control+ArrowLeft', 'Control+ArrowRight', 'Control+Backspace', 'Control+Delete']);

export function workspaceBrowserWsUrl(session: string, target: string, profile?: string): string {
  const apiBase = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
  const url = new URL(`${apiBase}/agent-workspace/browser/stream`, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = new URLSearchParams({ session, target, ...(profile ? { profile } : {}) }).toString();
  return url.toString();
}

/** Native dimensions are CSS pixels, not JPEG pixels. Never resize the remote viewport. */
export function decodeScreencastFrame(buffer: ArrayBuffer): { header: FrameHeader; jpeg: Blob } | null {
  if (buffer.byteLength < 8) return null;
  const length = new DataView(buffer).getUint32(0);
  if (length < 2 || length > 16384 || 4 + length >= buffer.byteLength) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length)));
    if (typeof header?.url !== 'string' || !Number.isFinite(header.cssWidth) || header.cssWidth <= 0 || header.cssWidth > 16384
      || !Number.isFinite(header.cssHeight) || header.cssHeight <= 0 || header.cssHeight > 16384) return null;
    return { header, jpeg: new Blob([new Uint8Array(buffer, 4 + length)], { type: 'image/jpeg' }) };
  } catch { return null; }
}

/**
 * Close codes from the Portal relay (agentWorkspaceBrowserRelay) plus the two
 * native codes it passes through: what happened, in plain words, and what to do.
 */
export const LIVE_VIEW_CLOSE = { blocked: 4003, tabClosed: 4004, invalidInput: 4400, sessionEnded: 4410, tooManyInputs: 4429, unavailable: 4503 } as const;

export function liveViewEndedMessage(code: number): string {
  switch (code) {
    case LIVE_VIEW_CLOSE.tabClosed: return 'That tab was closed.';
    case LIVE_VIEW_CLOSE.blocked: return 'This page is blocked by the browser policy.';
    case LIVE_VIEW_CLOSE.tooManyInputs: return 'The live view stopped because it got too many inputs at once. Select Reconnect, then click or type a little more slowly.';
    case LIVE_VIEW_CLOSE.invalidInput: return 'The live view stopped because it got an input it couldn\'t use. Select Reconnect to continue.';
    case LIVE_VIEW_CLOSE.unavailable: return 'The agent\'s browser tab closed or is unavailable. Pick a tab or select Reconnect; if it keeps stopping, ask the agent to open the page again.';
    case LIVE_VIEW_CLOSE.sessionEnded: return 'The browser session behind this live view ended. Select Reconnect to start a new one.';
    case 1006: return 'The connection to the live view was lost. Select Reconnect when the Portal is reachable again.';
    default: return 'The live view stopped. Select Reconnect to try again.';
  }
}

export function browserPoint(rect: { left: number; top: number; width: number; height: number }, x: number, y: number) {
  if (!rect.width || !rect.height || x < rect.left || y < rect.top || x > rect.left + rect.width || y > rect.top + rect.height) return null;
  return { x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height };
}

/**
 * Live picture of the OpenClaw-managed browser this chat's agent drives: local
 * zoom/Fit and panning, and human page input only after an explicit opt-in.
 * The remote viewport is never resized; agent automation is never paused.
 */
export default function WorkspaceBrowserTab({ session, activity, visible }: { session: string; activity: BrowserActivity | null; visible: boolean }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [running, setRunning] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [follow, setFollow] = useState(true);
  const [target, setTarget] = useState('');
  const [live, setLive] = useState<Live>({ status: 'idle' });
  const [frame, setFrame] = useState('');
  const [metrics, setMetrics] = useState<FrameHeader | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [inputEnabled, setInputEnabled] = useState(false);
  const [inputMessage, setInputMessage] = useState('');
  const [zoom, setZoom] = useState('1');
  const [bounds, setBounds] = useState({ width: 1, height: 1 });
  const [expanded, setExpanded] = useState(false);
  const frameUrl = useRef('');
  const socketRef = useRef<WebSocket | null>(null);
  const metricsRef = useRef<FrameHeader | null>(null);
  const enabledRef = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const id = useRef(0);
  const inputQueue = useRef<Array<Record<string, any>>>([]);
  const pendingInput = useRef<number | null>(null);
  const profile = activity?.profile;

  const flushInput = useCallback(() => {
    const socket = socketRef.current;
    if (pendingInput.current !== null || !enabledRef.current || socket?.readyState !== WebSocket.OPEN) return;
    const next = inputQueue.current.shift();
    if (next) { pendingInput.current = next.id; socket.send(JSON.stringify(next)); }
  }, []);
  const send = useCallback((action: Record<string, unknown>) => {
    const socket = socketRef.current, current = metricsRef.current;
    if (!enabledRef.current || !current || socket?.readyState !== WebSocket.OPEN) return;
    const previous = inputQueue.current.at(-1);
    if (action.action === 'text' && previous?.action === 'text' && previous.url === current.url
      && String(previous.text).length + String(action.text).length <= 4096) previous.text += String(action.text);
    else if (inputQueue.current.length < 128) inputQueue.current.push({ type: 'input', id: ++id.current, url: current.url, ...action });
    else { setInputMessage('The browser is busy. Wait for pending input before typing more.'); return; }
    flushInput();
  }, [flushInput]);
  const control = (enabled: boolean) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (!enabled) { enabledRef.current = false; setInputEnabled(false); inputQueue.current = []; pendingInput.current = null; keyboard.current?.blur(); }
    socket.send(JSON.stringify({ type: 'control', enabled }));
  };
  const loadTabs = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.get(`/agent-workspace/sessions/${encodeURIComponent(session)}/browser/tabs`,
        { params: profile ? { profile } : {}, _silent: true, _skipNetworkRetry: true } as any);
      const list: Tab[] = Array.isArray(data?.tabs) ? data.tabs : [];
      setTabs(list); setRunning(data?.running !== false); setError('');
      setTarget((current) => {
        if (follow && !enabledRef.current && activity?.targetId && list.some((tab) => tab.targetId === activity.targetId)) return activity.targetId;
        if (current && list.some((tab) => tab.targetId === current)) return current;
        return list[0]?.targetId || '';
      });
    } catch (failure: any) {
      setTabs([]); setRunning(false); setTarget('');
      setError(failure?.response?.data?.error || 'The agent browser is unavailable.');
    } finally { setLoading(false); }
  }, [session, profile, follow, activity?.targetId]);
  const loadTabsRef = useRef(loadTabs);
  loadTabsRef.current = loadTabs;
  useEffect(() => { if (visible) void loadTabs(); }, [visible, loadTabs, activity?.toolCallId, activity?.running]);

  useEffect(() => {
    enabledRef.current = false; setInputEnabled(false); setInputMessage('');
    inputQueue.current = []; pendingInput.current = null;
    metricsRef.current = null; setMetrics(null); setFrame('');
    if (!visible || !target) { setLive({ status: 'idle' }); return; }
    const socket = new WebSocket(workspaceBrowserWsUrl(session, target, profile));
    socketRef.current = socket;
    socket.binaryType = 'arraybuffer';
    let closed = false;
    setLive({ status: 'connecting' });
    socket.onmessage = (event) => {
      if (closed) return;
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data);
          if (message?.type === 'ready' || message?.type === 'meta') setLive({ status: 'live', url: String(message.url || ''), title: String(message.title || '') });
          if (message?.type === 'control') {
            enabledRef.current = message.enabled === true; setInputEnabled(enabledRef.current);
            if (enabledRef.current) { setFollow(false); setInputMessage(''); }
            else { inputQueue.current = []; pendingInput.current = null; }
            if (message.message) setInputMessage(message.message);
          }
          if (message?.type === 'input' && message.id === pendingInput.current) {
            pendingInput.current = null;
            if (!message.ok) { inputQueue.current = []; setInputMessage(message.message || 'Input was not accepted.'); }
            else flushInput();
          }
        } catch { /* ignore malformed metadata */ }
        return;
      }
      const decoded = decodeScreencastFrame(event.data as ArrayBuffer);
      if (!decoded) return;
      const next = URL.createObjectURL(decoded.jpeg);
      if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
      frameUrl.current = next; setFrame(next);
      metricsRef.current = decoded.header; setMetrics(decoded.header);
      setLive((current) => ({ ...current, status: 'live', url: decoded.header.url }));
    };
    socket.onclose = (event) => {
      if (closed) return;
      enabledRef.current = false; setInputEnabled(false);
      inputQueue.current = []; pendingInput.current = null;
      setLive({ status: 'ended', message: liveViewEndedMessage(event.code) });
      // The tab may be gone: refresh the list so a closed tab is not offered again.
      if (event.code === LIVE_VIEW_CLOSE.tabClosed || event.code === LIVE_VIEW_CLOSE.unavailable) void loadTabsRef.current();
    };
    return () => { closed = true; enabledRef.current = false; inputQueue.current = []; pendingInput.current = null; socketRef.current = null; socket.close(); };
  }, [visible, target, session, profile, attempt, flushInput]);

  useEffect(() => () => { if (frameUrl.current) URL.revokeObjectURL(frameUrl.current); }, []);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setBounds({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const change = () => setExpanded(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    let wheel: { x: number; y: number; deltaX: number; deltaY: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (event: WheelEvent) => {
      // Alt+wheel always pans the local enlarged picture; ordinary wheel scrolls the remote page in input mode.
      if (!enabledRef.current || event.altKey || event.ctrlKey || event.metaKey) return;
      const rect = picture.current?.getBoundingClientRect();
      const point = rect && browserPoint(rect, event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 600 : 1;
      wheel = { ...point, deltaX: Math.max(-2000, Math.min(2000, (wheel?.deltaX || 0) + event.deltaX * multiplier)),
        deltaY: Math.max(-2000, Math.min(2000, (wheel?.deltaY || 0) + event.deltaY * multiplier)) };
      timer ??= setTimeout(() => { if (wheel) send({ action: 'scroll', ...wheel }); wheel = null; timer = undefined; }, 100);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => { node.removeEventListener('wheel', onWheel); clearTimeout(timer); };
  }, [send, target, session, visible]);

  const click = (event: React.MouseEvent<HTMLImageElement>, button: 'left' | 'right' = 'left') => {
    if (!enabledRef.current) return;
    event.preventDefault();
    const point = browserPoint(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
    if (!point) return;
    keyboard.current?.focus({ preventScroll: true });
    send({ action: 'click', ...point, button });
  };
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || composing.current || !enabledRef.current) return;
    if (event.key === 'Escape' && event.shiftKey) { event.preventDefault(); control(false); return; }
    if (event.altKey) return;
    const modified = event.ctrlKey || event.metaKey;
    const key = `${modified ? 'Control+' : ''}${event.shiftKey ? 'Shift+' : ''}${modified && event.key.length === 1 ? event.key.toUpperCase() : event.key}`;
    if (SHORTCUTS.has(key) || (!modified && REMOTE_KEYS.has(event.key) && (!event.shiftKey || event.key === 'Tab' || event.key.startsWith('Arrow')))) {
      event.preventDefault(); send({ action: 'key', key });
    }
    // Text, mobile keyboards, IME and paste flow through the textarea, not key codes.
  };
  const current = tabs.find((tab) => tab.targetId === target);
  const scale = metrics ? (zoom === 'fit' ? Math.min(bounds.width / metrics.cssWidth, bounds.height / metrics.cssHeight, 1) : Number(zoom)) : 1;
  const buttonClass = 'inline-flex items-center gap-1 rounded-md border border-white/15 px-2 py-1.5 text-xs text-slate-200 hover:bg-white/5 disabled:opacity-40';
  return <div ref={root} className="relative flex h-full min-h-0 flex-col bg-[#0B1028]">
    <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-2">
      <Globe size={14} className="shrink-0 text-sky-300" aria-hidden="true" />
      <select aria-label="Browser tab" value={target} disabled={!tabs.length} onChange={(event) => { setFollow(false); setTarget(event.target.value); }}
        className="min-w-0 flex-1 truncate rounded-md border border-white/10 bg-slate-900 px-2 py-1 text-xs text-slate-200">
        {!tabs.length && <option value="">No open tabs</option>}
        {tabs.map((tab) => <option key={tab.targetId} value={tab.targetId}>{tab.title || tab.url}</option>)}
      </select>
      <label className="flex items-center gap-1 text-[11px] text-slate-400" title="Show the tab the agent is using">
        <input type="checkbox" checked={follow} onChange={(event) => { if (event.target.checked) control(false); setFollow(event.target.checked); }} />Follow agent
      </label>
      <button type="button" aria-label="Refresh browser tabs" onClick={() => { void loadTabs(); setAttempt(value => value + 1); }} className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-white">
        {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
      </button>
    </div>
    <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-1.5 text-[11px] text-slate-400">
      <span className="min-w-0 flex-1 truncate" title={live.url || current?.url}>{live.url || current?.url || (running === false ? 'Browser not running' : '—')}</span>
      {live.status === 'live' && <span className="text-emerald-300">● Live</span>}
    </div>
    <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-2">
      <label className="flex items-center gap-1.5 text-xs text-slate-400">View
        <select aria-label="Browser zoom" value={zoom} onChange={event => setZoom(event.target.value)} className="rounded-md border border-white/15 bg-slate-900 px-2 py-1.5 text-slate-200">
          <option value="fit">Fit</option>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value * 100}%</option>)}
        </select>
      </label>
      <button type="button" aria-label={expanded ? 'Exit expanded browser' : 'Expand browser'} className={buttonClass}
        onClick={() => { const result = document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen(); result?.catch(() => setInputMessage('Expanded view is unavailable in this browser. You can widen the side panel.')); }}>
        {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}<span>{expanded ? 'Restore' : 'Expand'}</span>
      </button>
      <button type="button" aria-pressed={inputEnabled} disabled={live.status !== 'live' || !metrics} className={`${buttonClass} ml-auto ${inputEnabled ? 'border-sky-400/50 bg-sky-400/15 text-sky-200' : ''}`}
        onClick={() => control(!inputEnabled)}><MousePointer2 size={14} />{inputEnabled ? 'Input on' : 'Enable input'}</button>
    </div>
    <div ref={viewport} className="relative min-h-0 flex-1 overflow-auto bg-black/40" aria-label="Shared browser view">
      {frame && metrics && live.status !== 'idle'
        // eslint-disable-next-line jsx-a11y-x/click-events-have-key-events, jsx-a11y-x/no-noninteractive-element-interactions -- the live picture is a pointer surface only while input is explicitly on; keyboard input goes through the labelled text field below
        ? <img ref={picture} src={frame} alt={`Live view of ${live.title || current?.title || 'the agent browser'}`} onClick={event => click(event)} onContextMenu={event => click(event, 'right')}
          style={{ width: metrics.cssWidth * scale, height: metrics.cssHeight * scale, maxWidth: 'none', cursor: inputEnabled ? 'default' : 'auto' }}
          className="block select-none" draggable={false} />
        : <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-slate-400">
          {live.status === 'connecting' ? <><Loader2 size={18} className="animate-spin" />Connecting to the agent browser…</>
            : error || running === false ? <><MonitorPlay size={22} className="text-slate-500" />{error || 'The agent browser is not running. It opens here when the agent uses it.'}</>
            : !tabs.length ? <><MonitorPlay size={22} className="text-slate-500" />No browser tabs are open yet. Ask the agent to open a page and it appears here.</>
            : <>Select a tab to watch.</>}
        </div>}
    </div>
    <textarea ref={keyboard} aria-label="Type in the shared browser" autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
      tabIndex={inputEnabled ? 0 : -1} className="absolute h-px w-px overflow-hidden opacity-0" style={{ fontSize: 16 }}
      onKeyDown={keyDown} onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={event => { composing.current = false; if (event.data) send({ action: 'text', text: event.data }); event.currentTarget.value = ''; }}
      onInput={event => { if (!composing.current && event.currentTarget.value) { send({ action: 'text', text: event.currentTarget.value.slice(0, 4096) }); event.currentTarget.value = ''; } }}
      onPaste={event => { event.preventDefault(); const text = event.clipboardData.getData('text/plain'); if (text) send({ action: 'text', text: text.slice(0, 4096) }); }} />
    {live.status === 'ended' && <div role="status" className="flex items-center justify-between gap-2 bg-slate-950/90 px-3 py-2 text-xs text-slate-300">
      <span>{live.message}</span><button type="button" className={buttonClass} onClick={() => setAttempt(value => value + 1)}>Reconnect</button>
    </div>}
    {inputMessage && <div role="status" className="px-3 py-2 text-xs text-amber-200">{inputMessage}</div>}
    <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-3 py-2 text-[11px] text-slate-400">
      <span>{inputEnabled ? 'Click then type. Alt+wheel pans the view. Shift+Esc turns input off. Agent automation is not paused.' : '100% keeps text readable; scroll to pan, or choose Fit. Desktop resolution stays unchanged.'}</span>
      <a href="/desktop" target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/15 px-2 py-1 text-slate-200 hover:bg-white/5">Desktop<ExternalLink size={12} /></a>
    </div>
  </div>;
}
