import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CornerUpLeft, GripHorizontal, Loader2, Minus, RefreshCw, Square, X } from 'lucide-react';
import { useAuthStore } from '../../contexts/AuthContext';
import { useFloatingWidgetsStore, type FloatingWidget } from '../../stores/agentWorkspaceStore';
import { useOwnedWidgetDocument, WidgetFrame } from '../chat/richContent/WidgetFrame';

const BAR = 36;

/** In-app navigation state only: a link elsewhere cannot select a conversation. */
export interface WorkspaceFocusRequest { provider: string; session: string; toolCallId: string }
export const WORKSPACE_FOCUS_STATE_KEY = 'agentWorkspaceFocus';

/** Keep at least a grabbable piece of the bar on screen whatever the window size. */
export function clampToViewport(widget: Pick<FloatingWidget, 'x' | 'y' | 'width'>, viewport = { width: window.innerWidth, height: window.innerHeight }) {
  return {
    x: Math.round(Math.min(Math.max(widget.x, 80 - widget.width), viewport.width - 80)),
    y: Math.round(Math.min(Math.max(widget.y, 0), viewport.height - BAR)),
  };
}

function FloatingWindow({ widget, top }: { widget: FloatingWidget; top: boolean }) {
  const { patch, close, focus } = useFloatingWidgetsStore();
  const navigate = useNavigate();
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [frameError, setFrameError] = useState('');
  const origin = useRef<{ x: number; y: number; width: number; height: number; mode: 'move' | 'resize' } | null>(null);
  const position = clampToViewport(widget);
  const doc = useOwnedWidgetDocument(widget.provider, widget.session, widget.toolCallId, !widget.minimized);
  const width = size?.width ?? widget.width;
  const height = size?.height ?? widget.height;

  const begin = (mode: 'move' | 'resize') => (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    focus(widget.id);
    origin.current = { x: event.clientX, y: event.clientY, width, height, mode };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };
  const move = (event: React.PointerEvent) => {
    const start = origin.current;
    if (!start) return;
    if (start.mode === 'move') setDrag({ dx: event.clientX - start.x, dy: event.clientY - start.y });
    else setSize({ width: Math.max(220, Math.min(1600, start.width + event.clientX - start.x)), height: Math.max(140, Math.min(1400, start.height + event.clientY - start.y)) });
  };
  const end = () => {
    const start = origin.current;
    origin.current = null;
    if (!start) return;
    if (start.mode === 'move' && drag) patch(widget.id, clampToViewport({ x: position.x + drag.dx, y: position.y + drag.dy, width }));
    else if (start.mode === 'resize' && size) patch(widget.id, { width: Math.round(size.width), height: Math.round(size.height) });
    setDrag(null); setSize(null);
  };
  const backToChat = () => {
    const request: WorkspaceFocusRequest = { provider: widget.provider, session: widget.session, toolCallId: widget.toolCallId };
    navigate('/agent-chats', { state: { [WORKSPACE_FOCUS_STATE_KEY]: request } });
  };
  const control = 'grid h-7 w-7 place-items-center rounded-md text-slate-300 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400';
  const error = frameError || (doc.status === 'error' ? doc.message : '');
  return <section role="dialog" aria-label={`Floating widget: ${widget.title}`} onPointerDown={() => focus(widget.id)}
    className={`pointer-events-auto fixed flex flex-col overflow-hidden rounded-xl border bg-[var(--color-surface)] shadow-2xl ${top ? 'border-sky-400/30' : 'border-white/10'}`}
    style={{ left: position.x + (drag?.dx ?? 0), top: position.y + (drag?.dy ?? 0), width, height: widget.minimized ? BAR : height, zIndex: 1000 + Math.min(widget.z, 100_000) }}>
    <header className="flex h-9 shrink-0 cursor-grab touch-none select-none items-center gap-1 border-b border-white/10 bg-white/[0.04] pl-2 pr-1 active:cursor-grabbing"
      onPointerDown={begin('move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest('button')) patch(widget.id, { minimized: !widget.minimized }); }}>
      <GripHorizontal size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
      <h2 className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-200" title={widget.title}>{widget.title}</h2>
      <button type="button" className={control} aria-label="Back to the chat that made this widget" title="Back to chat" onClick={backToChat}><CornerUpLeft size={14} /></button>
      <button type="button" className={control} aria-label={widget.minimized ? 'Restore widget' : 'Minimize widget'} title={widget.minimized ? 'Restore' : 'Minimize'}
        onClick={() => patch(widget.id, { minimized: !widget.minimized })}>{widget.minimized ? <Square size={12} /> : <Minus size={14} />}</button>
      <button type="button" className={control} aria-label="Close floating widget" title="Close" onClick={() => close(widget.id)}><X size={14} /></button>
    </header>
    {!widget.minimized && <div className="relative min-h-0 flex-1 overflow-auto">
      {error ? <div role="alert" className="flex items-start gap-2 p-3 text-xs text-amber-300"><span className="flex-1">{error}</span>
          <button type="button" className={control} aria-label="Retry widget" title="Retry" onClick={() => { setFrameError(''); doc.retry(); }}><RefreshCw size={13} /></button></div>
        : doc.html ? <WidgetFrame html={doc.html} title={widget.title} fill onState={(next, message) => { if (next === 'error') setFrameError(message || 'Widget unavailable.'); }} />
        : <p role="status" className="flex items-center gap-2 p-3 text-xs text-slate-400"><Loader2 size={13} className="animate-spin" />Loading widget…</p>}
      {(drag || size) && <div className="absolute inset-0" aria-hidden="true" />}
      <div aria-hidden="true" onPointerDown={begin('resize')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none bg-[linear-gradient(135deg,transparent_50%,rgba(148,163,184,0.5)_50%)]" />
    </div>}
  </section>;
}

/** Widgets popped out of Agent Chat stay on top of every Portal page for this user in this browser. */
export default function FloatingWidgetLayer() {
  const userId = useAuthStore((state) => state.user?.id || '');
  const { widgets, bindUser } = useFloatingWidgetsStore();
  const [, rerender] = useState(0);
  useEffect(() => { bindUser(userId); }, [userId, bindUser]);
  useEffect(() => {
    const onResize = () => rerender((value) => value + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  if (!userId || !widgets.length) return null;
  const top = widgets.reduce((best, item) => item.z > best.z ? item : best, widgets[0]);
  return <div className="pointer-events-none fixed inset-0 z-[90]" aria-label="Floating widgets">
    {widgets.map((widget) => <FloatingWindow key={widget.id} widget={widget} top={widget.id === top.id} />)}
  </div>;
}
