import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import { io, type Socket } from 'socket.io-client';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

const API_URL = import.meta.env.VITE_API_URL || '';

interface HarnessNativeCliTerminalProps {
  provider: 'hermes' | 'opencode';
  sessionId: string;
}

const TERMINAL_THEME = {
  background: '#070a12',
  foreground: '#e2e8f0',
  cursor: '#34d399',
  cursorAccent: '#070a12',
  selectionBackground: '#334155aa',
  black: '#0f172a',
  red: '#f87171',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e2e8f0',
};

export default function HarnessNativeCliTerminal({
  provider,
  sessionId,
}: HarnessNativeCliTerminalProps) {
  const terminalElementRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const [connectionState, setConnectionState] = useState<'connecting' | 'ready' | 'disconnected'>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = terminalElementRef.current;
    if (!element) return undefined;

    const terminal = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 2_000,
      convertEol: false,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(element);
    try { fitAddon.fit(); } catch {}

    const wsUrl = API_URL.replace(/\/api\/?$/u, '');
    const socket = io(`${wsUrl}/harness-setup`, {
      // This wizard owns a session-specific handshake. A pooled status socket
      // retains its original query and would silently drop our sessionId.
      forceNew: true,
      transports: ['polling', 'websocket'],
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: 8,
      query: {
        sessionId,
        cols: terminal.cols,
        rows: terminal.rows,
      },
    });
    socketRef.current = socket;
    let disposed = false;

    const fitAndResize = () => {
      if (disposed) return;
      try {
        fitAddon.fit();
        socket.emit('resize', { cols: terminal.cols, rows: terminal.rows });
      } catch {}
    };
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(fitAndResize)
      : null;
    resizeObserver?.observe(element);
    window.addEventListener('resize', fitAndResize);
    const initialFit = window.setTimeout(fitAndResize, 50);

    const inputSubscription = terminal.onData((data) => {
      if (socket.connected) socket.emit('input', data);
    });
    socket.on('connect', () => {
      terminal.reset();
      setConnectionState('connecting');
      setError(null);
    });
    socket.on('terminal_ready', () => {
      setConnectionState('ready');
      fitAndResize();
      terminal.focus();
    });
    socket.on('output', (data: unknown) => {
      if (typeof data === 'string') terminal.write(data);
    });
    socket.on('terminal_exit', () => {
      setConnectionState('disconnected');
    });
    socket.on('setup_error', (payload: unknown) => {
      const message = payload && typeof payload === 'object' && typeof (payload as any).error === 'string'
        ? (payload as any).error
        : 'Harness setup terminal is unavailable.';
      setError(message);
    });
    socket.on('connect_error', (connectionError: Error) => {
      setConnectionState('disconnected');
      setError(connectionError.message || 'Could not connect to the harness setup terminal.');
    });
    socket.on('disconnect', (reason) => {
      if (!disposed && reason !== 'io client disconnect') setConnectionState('disconnected');
    });

    return () => {
      disposed = true;
      window.clearTimeout(initialFit);
      window.removeEventListener('resize', fitAndResize);
      resizeObserver?.disconnect();
      inputSubscription.dispose();
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      terminal.dispose();
    };
  }, [sessionId]);

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-xl border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs leading-relaxed text-sky-100">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          This fixed {provider === 'hermes' ? <code>hermes model</code> : <code>opencode auth login</code>} wizard
          writes only the Portal harness profile. Remote Desktop has a separate CLI account and is not changed here.
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-700 bg-[#070a12]">
        <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2 text-[11px] text-slate-400">
          <span>Portal server profile · interactive provider wizard</span>
          <span className="inline-flex items-center gap-1.5">
            {connectionState === 'connecting' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {connectionState === 'ready' ? 'Connected' : connectionState === 'connecting' ? 'Connecting…' : 'Finishing…'}
          </span>
        </div>
        <div
          ref={terminalElementRef}
          className="h-[360px] w-full p-2"
          role="application"
          aria-label={`${provider === 'hermes' ? 'Hermes' : 'OpenCode'} Portal-profile setup terminal`}
        />
      </div>
      {error ? (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
