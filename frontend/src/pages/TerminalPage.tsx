import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Terminal as TermIcon, Maximize2, Minimize2, RotateCcw, Copy, Send, X,
  Search, Command, AlertTriangle, Play, Loader2, Sparkles,
  ShieldAlert, Zap, ToggleLeft, ToggleRight, Trash2, Plus, XCircle
} from 'lucide-react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { io, Socket } from 'socket.io-client';
import { terminalAPI, gatewayAPI } from '../api/endpoints';
import { captureError } from '../utils/errorHandler';
import { getShortModelLabel } from '../utils/modelId';
import sounds from '../utils/sounds';
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  appendLooseTerminalPaste,
  consumeBracketedPasteChunk,
  createBracketedPasteState,
  decideTerminalPaste,
  flushLooseTerminalPaste,
} from '../utils/terminalInput';
import {
  buildTerminalCatalog,
  rankTerminalCatalog,
  type TerminalActionRisk,
  type TerminalCapabilities,
  type TerminalSuggestion as AutocompleteSuggestion,
} from '../utils/terminalCapabilities';
import AnchoredPopover from '../components/AnchoredPopover';
import ViewportModal from '../components/ViewportModal';
import { useIsMobile } from '../hooks/useIsMobile';
import 'xterm/css/xterm.css';

const API_URL = import.meta.env.VITE_API_URL || '';
const TERMINAL_STATE_STORAGE_KEY = 'portal:terminal-state:v1';

// ─── Types ───────────────────────────────────────────────────────
interface LookupCommand {
  command: string;
  explanation: string;
  warning: string | null;
  risk?: TerminalActionRisk;
  confirmation?: 'none' | 'explicit' | 'typed';
}

// TabDescriptor moved to main component section below

// ─── Category colors ─────────────────────────────────────────────
const CATEGORY_COLORS: Record<string, string> = {
  openclaw: 'text-emerald-400 bg-emerald-500/10',
  tailscale: 'text-blue-400 bg-blue-500/10',
  ollama: 'text-purple-400 bg-purple-500/10',
  docker: 'text-cyan-400 bg-cyan-500/10',
  git: 'text-orange-400 bg-orange-500/10',
  npm: 'text-red-400 bg-red-500/10',
  yarn: 'text-sky-400 bg-sky-500/10',
  caddy: 'text-lime-400 bg-lime-500/10',
  system: 'text-slate-400 bg-slate-500/10',
  files: 'text-green-400 bg-green-500/10',
  network: 'text-indigo-400 bg-indigo-500/10',
  apt: 'text-teal-400 bg-teal-500/10',
  nginx: 'text-lime-400 bg-lime-500/10',
  ssh: 'text-fuchsia-400 bg-fuchsia-500/10',
  process: 'text-rose-400 bg-rose-500/10',
  security: 'text-amber-400 bg-amber-500/10',
  agents: 'text-violet-400 bg-violet-500/10',
  database: 'text-pink-400 bg-pink-500/10',
  ssl: 'text-yellow-400 bg-yellow-500/10',
  disk: 'text-orange-400 bg-orange-500/10',
  monitoring: 'text-cyan-400 bg-cyan-500/10',
  text: 'text-slate-400 bg-slate-500/10',
  python: 'text-yellow-400 bg-yellow-500/10',
};


interface CommandWarning {
  risk: Exclude<TerminalActionRisk, 'read_only'>;
  confirmation: 'explicit' | 'typed';
  message: string;
}

async function classifyCommandForUi(command: string): Promise<CommandWarning | null> {
  try {
    const classification = await terminalAPI.classify(command);
    if (classification?.risk === 'destructive' || classification?.risk === 'service_change') {
      return {
        risk: classification.risk,
        confirmation: classification.confirmation === 'typed' ? 'typed' : 'explicit',
        message: classification.message || 'This command changes host state.',
      };
    }
    return null;
  } catch {
    // Classification is an accident-prevention layer, not an authorization
    // boundary. If its server-side policy is unavailable, fail closed instead
    // of relying on a duplicated client regex catalog that wrappers could evade.
    return {
      risk: 'destructive',
      confirmation: 'typed',
      message: 'Portal could not verify this command against the host mutation policy. Review it carefully before running it.',
    };
  }
}

// ─── Danger Warning Modal ────────────────────────────────────────
export function DangerWarningModal({ command, message, confirmation, onConfirm, onCancel }: {
  command: string;
  message: string;
  confirmation: 'explicit' | 'typed';
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);
  const typedInputRef = useRef<HTMLInputElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const requiresTyping = confirmation === 'typed';
  const confirmOnce = useCallback(async () => {
    if (
      submittedRef.current ||
      submitting ||
      (requiresTyping && typedConfirmation !== 'RUN')
    ) {
      return;
    }
    submittedRef.current = true;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  }, [onConfirm, requiresTyping, submitting, typedConfirmation]);

  useEffect(() => {
    submittedRef.current = false;
    setSubmitting(false);
    setTypedConfirmation('');
  }, [command, confirmation, message]);

  return (
    <ViewportModal
      open
      onDismiss={onCancel}
      dismissible={!submitting}
      initialFocusRef={requiresTyping ? typedInputRef : cancelButtonRef}
      className="bg-black/70 px-4 py-6 backdrop-blur-sm"
    >
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
        className="bg-[#1A0A0A] border-2 border-red-500/40 rounded-2xl p-6 max-w-md w-full mx-4 shadow-[0_0_60px_rgba(239,68,68,0.15)]"
        role="alertdialog" aria-modal="true" aria-labelledby="terminal-confirm-title" aria-describedby="terminal-confirm-description"
        aria-busy={submitting}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-xl bg-red-500/15 border border-red-500/30 flex items-center justify-center">
            <ShieldAlert size={24} className="text-red-400" />
          </div>
          <div>
            <h3 id="terminal-confirm-title" className="text-lg font-bold text-red-400">Confirm host command</h3>
            <p className="text-xs text-red-300/60">This Terminal has full server access</p>
          </div>
        </div>
        <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-3 mb-4">
          <code className="text-sm font-mono text-red-300 break-all">{command}</code>
        </div>
        <p id="terminal-confirm-description" className="text-sm text-slate-300 mb-4">{message}</p>
        {requiresTyping && (
          <label className="block mb-4 text-xs text-red-200/80">
            Type <strong>RUN</strong> to confirm this destructive command
            <input ref={typedInputRef} value={typedConfirmation} onChange={(event) => setTypedConfirmation(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && typedConfirmation === 'RUN') void confirmOnce(); }}
              disabled={submitting}
              className="mt-2 w-full rounded-lg border border-red-500/30 bg-black/30 px-3 py-2 font-mono text-sm text-white outline-none focus:border-red-400"
              aria-label="Type RUN to confirm" />
          </label>
        )}
        <div className="flex gap-3">
          <button ref={cancelButtonRef} type="button" onClick={onCancel} disabled={submitting}
            className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-slate-300 text-sm font-medium hover:bg-white/10 transition-colors disabled:cursor-not-allowed disabled:opacity-40">Cancel</button>
          <button type="button" onClick={() => { void confirmOnce(); }}
            disabled={submitting || (requiresTyping && typedConfirmation !== 'RUN')}
            className="flex-1 py-2.5 rounded-xl bg-red-500/20 border border-red-500/40 text-red-400 text-sm font-medium hover:bg-red-500/30 transition-colors disabled:cursor-not-allowed disabled:opacity-30">
            {submitting ? 'Running…' : 'Run command'}
          </button>
        </div>
      </motion.div>
    </ViewportModal>
  );
}

// ─── Local Lookup Search (no Ollama) ─────────────────────────────
function extractKeywordsFromBuffer(buffer: string): string[] {
  const words = buffer.toLowerCase().replace(/\x1b\[[0-9;]*m/g, '').split(/[\s\/\-_.,:;|]+/).filter(w => w.length > 2);
  const freq: Record<string, number> = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([w]) => w);
}

// ─── Assistant Side Panel ────────────────────────────────────────
function AssistantAIPanel({ isOpen, onClose, onInsert, getFullBuffer, contextEnabled, setContextEnabled, catalog, contextKey, isMobile, onBusyChange }: {
  isOpen: boolean; onClose: () => void; onInsert: (cmd: string) => void; getFullBuffer: () => string;
  contextEnabled: boolean; setContextEnabled: (v: boolean) => void; catalog: AutocompleteSuggestion[];
  contextKey: string; isMobile: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const [activeTab, setActiveTab] = useState<'lookup' | 'aidebug'>('lookup');
  const [query, setQuery] = useState('');
  const [lookupResults, setLookupResults] = useState<AutocompleteSuggestion[]>([]);
  const includeContext = contextEnabled;
  const setIncludeContext = (v: boolean | ((prev: boolean) => boolean)) => {
    if (typeof v === 'function') setContextEnabled(v(contextEnabled));
    else setContextEnabled(v);
  };
  // AI Debug state
  const [aiDebugModel, setAiDebugModel] = useState<string>('');
  const [aiDebugTier, setAiDebugTier] = useState<string>('smart');
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugResults, setDebugResults] = useState<LookupCommand[]>([]);
  const [debugSummary, setDebugSummary] = useState('');
  const [debugError, setDebugError] = useState('');
  const [debugQuery, setDebugQuery] = useState('');
  const [debugIncludeContext, setDebugIncludeContext] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const debugInputRef = useRef<HTMLInputElement>(null);
  const debugAttemptRef = useRef<Readonly<{
    contextKey: string;
    query: string;
    context?: string;
    model?: string;
    tier?: string;
  }> | null>(null);
  const currentContextKeyRef = useRef(contextKey);
  const mountedRef = useRef(true);
  const onBusyChangeRef = useRef(onBusyChange);
  currentContextKeyRef.current = contextKey;
  onBusyChangeRef.current = onBusyChange;

  useEffect(() => () => {
    mountedRef.current = false;
    if (debugAttemptRef.current) {
      debugAttemptRef.current = null;
      onBusyChangeRef.current(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const focusTimer = setTimeout(() => {
      if (activeTab === 'lookup') inputRef.current?.focus();
      else debugInputRef.current?.focus();
    }, 100);
    return () => clearTimeout(focusTimer);
  }, [isOpen, activeTab]);

  // Live local search for Lookup tab
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const contextKeywords = includeContext ? extractKeywordsFromBuffer(getFullBuffer()) : [];
      let runtimeMatches: AutocompleteSuggestion[] = [];
      if (query.trim()) {
        try {
          const data = await terminalAPI.autocomplete(query, 30);
          runtimeMatches = Array.isArray(data?.suggestions) ? data.suggestions : [];
        } catch {
          // The cached runtime catalog remains available below.
        }
      }
      if (cancelled) return;
      const merged = [...runtimeMatches, ...catalog.filter((entry) => !runtimeMatches.some((match) => match.command === entry.command))];
      setLookupResults(rankTerminalCatalog(query, contextKeywords, merged));
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, includeContext, catalog, getFullBuffer]);

  // AI Debug: calls Ollama via backend
  const doAIDebug = async () => {
    const querySnapshot = debugQuery.trim();
    if (!querySnapshot || debugAttemptRef.current) return;
    const snapshot = Object.freeze({
      contextKey,
      query: querySnapshot,
      context: debugIncludeContext ? getFullBuffer() : undefined,
      model: aiDebugModel || undefined,
      tier: aiDebugTier || undefined,
    });
    debugAttemptRef.current = snapshot;
    onBusyChange(true);
    setDebugLoading(true);
    setDebugError('');
    setDebugResults([]);
    setDebugSummary('');
    try {
      const data = await terminalAPI.lookup(snapshot.query, snapshot.context, snapshot.model, snapshot.tier);
      if (
        debugAttemptRef.current !== snapshot
        || currentContextKeyRef.current !== snapshot.contextKey
        || !mountedRef.current
      ) return;
      if (data.commands?.length > 0) { setDebugResults(data.commands); setDebugSummary(data.summary || ''); }
      else setDebugError(data.summary || 'No commands found. Try rephrasing.');
    } catch {
      if (
        debugAttemptRef.current === snapshot
        && currentContextKeyRef.current === snapshot.contextKey
        && mountedRef.current
      ) setDebugError(
        'Failed to reach the configured Ollama backend. Check Settings → AI Providers and retry.',
      );
    } finally {
      if (debugAttemptRef.current === snapshot) {
        debugAttemptRef.current = null;
        onBusyChange(false);
        if (mountedRef.current) setDebugLoading(false);
      }
    }
  };

  if (!isOpen) return null;

  const requestClose = () => {
    if (!debugAttemptRef.current) onClose();
  };

  const panel = (
    <motion.div
      initial={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
      animate={isMobile ? { opacity: 1, x: 0 } : { width: 360, opacity: 1 }}
      exit={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
      transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      role={isMobile ? 'dialog' : 'complementary'}
      aria-modal={isMobile ? 'true' : undefined}
      aria-label="Terminal assistant"
      aria-busy={debugLoading}
      className={isMobile
        ? 'flex h-full w-full flex-col bg-[#0D1130]/98 backdrop-blur-xl'
        : 'z-[60] flex w-[360px] flex-shrink-0 flex-col overflow-hidden border-l border-white/5 bg-[#0D1130]/95 backdrop-blur-xl'}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-emerald-400" />
          <span className="text-sm font-semibold text-white">Assistant</span>
        </div>
        <button aria-label="Close terminal assistant" onClick={requestClose} disabled={debugLoading} className="p-1 rounded-lg hover:bg-white/5 text-slate-500 hover:text-white transition-colors disabled:cursor-wait disabled:opacity-40">
          <X size={16} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-white/5">
        <button onClick={() => setActiveTab('lookup')} disabled={debugLoading}
          className={`flex-1 py-2 text-xs font-medium transition-all ${activeTab === 'lookup' ? 'accent-active border-b-2' : 'text-slate-500 hover:text-slate-300'}`}>
          <Search size={12} className="inline mr-1.5" />Lookup
        </button>
        <button onClick={() => setActiveTab('aidebug')} disabled={debugLoading}
          className={`flex-1 py-2 text-xs font-medium transition-all ${activeTab === 'aidebug' ? 'accent-active border-b-2' : 'text-slate-500 hover:text-slate-300'}`}>
          <AlertTriangle size={12} className="inline mr-1.5" />AI Debug
        </button>
      </div>

      {/* Lookup Tab — LOCAL search only, no Ollama */}
      {activeTab === 'lookup' && (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Search input */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
            <Search size={12} className="text-slate-500 flex-shrink-0" />
            <input ref={inputRef} aria-label="Search terminal commands" value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Search commands (e.g. docker, disk, nginx)..."
              className="flex-1 bg-transparent text-xs text-white placeholder-slate-500 outline-none" />
            {query && <button aria-label="Clear command search" onClick={() => setQuery('')} className="text-slate-500 hover:text-white"><XCircle size={12} /></button>}
          </div>

          {/* Context toggle */}
          <div className="px-3 py-1.5 border-b border-white/5 flex items-center justify-between">
            <button type="button" aria-pressed={includeContext} className="flex items-center gap-1.5 cursor-pointer select-none" onClick={() => { const next = !includeContext; if (next) sounds.toggleOn(); else sounds.toggleOff(); setIncludeContext(next); }}>
              {includeContext ? <ToggleRight size={14} className="text-emerald-400" /> : <ToggleLeft size={14} className="text-slate-500" />}
              <span className="text-[10px] font-medium text-slate-400">📋 Context boost</span>
            </button>
            <span className="text-[9px] text-slate-600">{includeContext ? '✅ Biased by terminal (+ chat box)' : '⚡ All commands'}</span>
          </div>

          {/* Results */}
          <div className="flex-1 overflow-auto">
            {!query && lookupResults.length === 0 && (
              <div className="px-3 py-6 text-center">
                <Command size={24} className="mx-auto mb-2 text-slate-600" />
                <p className="text-[11px] text-slate-500 mb-1">Runtime Command Search</p>
                <p className="text-[10px] text-slate-600 mb-3">{catalog.length} current actions and discoveries · No AI call</p>
                <p className="text-[10px] text-slate-500 mb-2">{includeContext ? '💡 Enable context boost & run some commands to see ranked suggestions here' : '💡 Turn on Context boost to see ranked suggestions'}</p>
                <div className="flex flex-wrap gap-1.5 justify-center">
                  {[...new Set(catalog.map((entry) => entry.category))].slice(0, 6).map(ex => (
                    <button key={ex} onClick={() => setQuery(ex)}
                      className="px-2 py-0.5 rounded-lg bg-white/5 text-[10px] text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors">{ex}</button>
                  ))}
                </div>
              </div>
            )}
            {!query && lookupResults.length > 0 && (
              <div className="px-3 pt-2 pb-1 text-[10px] text-emerald-400/70">
                <Sparkles size={10} className="inline mr-1" />Suggested based on terminal activity
              </div>
            )}
            {query && lookupResults.length === 0 && (
              <div className="px-3 py-4 text-center text-[11px] text-slate-500">No matching commands. Try different keywords.</div>
            )}
            {lookupResults.length > 0 && (
              <div>
                <div className="px-3 pt-2 pb-1 text-[10px] text-slate-500">{lookupResults.length} result{lookupResults.length !== 1 ? 's' : ''}</div>
                {lookupResults.map((r, i) => {
                  const catColor = CATEGORY_COLORS[r.category] || 'text-slate-400 bg-slate-500/10';
                  return (
                    <div key={i} className="px-3 py-2 border-b border-white/5 last:border-0 hover:bg-white/[0.02] group">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 flex-1 min-w-0">
                          <span className={`px-1.5 py-0.5 rounded text-[8px] font-medium uppercase ${catColor}`}>{r.category}</span>
                          <code className="text-[11px] font-mono text-emerald-400 truncate">{r.command}</code>
                        </div>
                        <button onClick={() => onInsert(r.command)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-[10px] font-medium hover:bg-emerald-500/20 transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0">
                          <Play size={8} /> Run
                        </button>
                      </div>
                      <p className="text-[10px] text-slate-500 mt-0.5">{r.description}</p>
                      {r.dangerous && (
                        <div className="flex items-center gap-1 mt-1 text-[10px] text-amber-400">
                          <AlertTriangle size={10} />⚠️ Potentially dangerous
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Quick commands */}
          <div className="px-3 py-2 border-t border-white/5">
            <span className="text-[9px] text-slate-600 uppercase tracking-wider">Quick</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {catalog.filter((entry) => entry.source === 'action' && entry.risk === 'read_only').slice(0, 5).map(entry => (
                <button key={entry.command} onClick={() => onInsert(entry.command)} title={entry.description}
                  className="px-1.5 py-0.5 rounded bg-white/5 text-[9px] text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors font-mono">{entry.category}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* AI Debug Tab — Ollama-powered troubleshooting */}
      {activeTab === 'aidebug' && (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Search input */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
            <input ref={debugInputRef} aria-label="Describe a terminal problem" value={debugQuery} disabled={debugLoading} onChange={e => setDebugQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void doAIDebug(); } }}
              placeholder="Describe your problem or what you want to do..."
              className="flex-1 bg-transparent text-xs text-white placeholder-slate-500 outline-none" />
            <button
              type="button"
              aria-busy={debugLoading}
              aria-label={debugLoading ? 'Debugging terminal context' : 'Debug terminal context'}
              onClick={() => { void doAIDebug(); }}
              disabled={debugLoading || !debugQuery.trim()}
              className="inline-flex min-w-[84px] items-center justify-center gap-1.5 rounded-lg bg-purple-500/20 px-2.5 py-1 text-[10px] font-medium text-purple-300 transition-colors hover:bg-purple-500/30 disabled:cursor-wait disabled:opacity-40"
            >
              {debugLoading && <Loader2 size={12} className="animate-spin" />}
              {debugLoading ? 'Debugging…' : 'Debug'}
            </button>
          </div>

          {/* Model tier toggle: Snappy / Smart / Best */}
          <div className="px-3 py-1.5 border-b border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5">
              <button onClick={() => { setAiDebugTier('snappy'); setAiDebugModel(''); }} disabled={debugLoading}
                className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-all ${aiDebugTier === 'snappy' ? 'bg-emerald-500/20 text-emerald-400 shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}
                title="Snappy — fastest responses">⚡ Snappy</button>
              <button onClick={() => { setAiDebugTier('smart'); setAiDebugModel(''); }} disabled={debugLoading}
                className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-all ${aiDebugTier === 'smart' ? 'bg-cyan-500/20 text-cyan-400 shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}
                title="Smart — balanced speed and quality">🧠 Smart</button>
              <button onClick={() => { setAiDebugTier('best'); setAiDebugModel(''); }} disabled={debugLoading}
                className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-all ${aiDebugTier === 'best' ? 'bg-violet-500/20 text-violet-400 shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}
                title="Best — highest quality analysis">🏆 Best</button>
            </div>
            <span className="text-[9px] text-slate-600">{aiDebugTier === 'snappy' ? 'Snappy' : aiDebugTier === 'best' ? 'Best' : 'Smart'}</span>
          </div>

          {/* Context toggle */}
          <div className="px-3 py-1.5 border-b border-white/5 flex items-center justify-between">
            <button type="button" aria-pressed={debugIncludeContext} disabled={debugLoading} className="flex items-center gap-1.5 cursor-pointer select-none disabled:cursor-wait disabled:opacity-40" onClick={() => { const next = !debugIncludeContext; if (next) sounds.toggleOn(); else sounds.toggleOff(); setDebugIncludeContext(next); }}>
              {debugIncludeContext ? <ToggleRight size={14} className="text-purple-400" /> : <ToggleLeft size={14} className="text-slate-500" />}
              <span className="text-[10px] font-medium text-slate-400">📋 Include terminal buffer</span>
            </button>
            <span className="text-[9px] text-slate-600">{debugIncludeContext ? '✅ Context-aware' : '⚡ Fast'}</span>
          </div>

          {/* Results */}
          <div className="flex-1 overflow-auto">
            {!debugResults.length && !debugError && !debugLoading && (
              <div className="px-3 py-6 text-center">
                <AlertTriangle size={24} className="mx-auto mb-2 text-purple-400/50" />
                <p className="text-[11px] text-slate-500 mb-1">AI Debug · Powered by Ollama</p>
                <p className="text-[10px] text-slate-600 mb-3">Describe errors, ask how to fix things, or get troubleshooting help.</p>
                <div className="flex flex-wrap gap-1.5 justify-center">
                  {['why is nginx 502', 'command failed help', 'disk is full', 'port already in use'].map(ex => (
                    <button key={ex} onClick={() => setDebugQuery(ex)}
                      className="px-2 py-0.5 rounded-lg bg-white/5 text-[10px] text-slate-400 hover:text-purple-400 hover:bg-purple-500/10 transition-colors">{ex}</button>
                  ))}
                </div>
              </div>
            )}
            {debugLoading && (
              <div className="px-3 py-8 text-center">
                <Loader2 size={20} className="mx-auto mb-2 text-purple-400 animate-spin" />
                <p className="text-[10px] text-slate-500">AI is thinking...</p>
              </div>
            )}
            {debugError && <div className="px-3 py-4 text-center text-[11px] text-red-400">{debugError}</div>}
            {debugResults.length > 0 && (
              <div>
                {debugSummary && <div className="px-3 pt-2 pb-1 text-[10px] text-slate-400">{debugSummary}</div>}
                {debugResults.map((r, i) => {
                  const requiresConfirmation = r.risk === 'destructive' || r.risk === 'service_change';
                  return (
                    <div key={i} className="px-3 py-2 border-b border-white/5 last:border-0 hover:bg-white/[0.02] group">
                      <div className="flex items-center justify-between gap-2">
                        <code className="text-[11px] font-mono text-purple-400 flex-1 break-all">{r.command}</code>
                        <button onClick={() => onInsert(r.command)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-purple-500/10 text-purple-400 text-[10px] font-medium hover:bg-purple-500/20 transition-colors opacity-0 group-hover:opacity-100">
                          <Play size={8} /> Run
                        </button>
                      </div>
                      <p className="text-[10px] text-slate-500 mt-0.5">{r.explanation}</p>
                      {(r.warning || requiresConfirmation) && (
                        <div className="flex items-center gap-1 mt-1 text-[10px] text-amber-400">
                          <AlertTriangle size={10} />{r.warning || 'Portal will ask for confirmation before this host-changing command runs.'}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );

  if (!isMobile) return panel;

  return (
    <ViewportModal
      open={isOpen}
      onDismiss={requestClose}
      dismissible={!debugLoading}
      initialFocusRef={activeTab === 'lookup' ? inputRef : debugInputRef}
      className="items-stretch justify-stretch bg-[#0D1130]/98 backdrop-blur-xl"
    >
      {panel}
    </ViewportModal>
  );
}

// ─── Chat Box Input with Autocomplete ────────────────────────────
function ChatBoxInput({ onSubmit, onInputChange, connected, running, externalClear, inputMode, onFocusChatBox, contextEnabled, getFullBuffer, catalog }: {
  onSubmit: (cmd: string) => void; onInputChange: (value: string) => void; connected: boolean; running: boolean; externalClear?: number;
  inputMode: 'chat' | 'terminal'; onFocusChatBox: () => void; contextEnabled: boolean; getFullBuffer: () => string;
  catalog: AutocompleteSuggestion[];
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const lastClearRef = useRef(0);
  const [chatAcResults, setChatAcResults] = useState<AutocompleteSuggestion[]>([]);
  const [chatAcIndex, setChatAcIndex] = useState(0);
  const [chatAcVisible, setChatAcVisible] = useState(false);
  const [sentFlash, setSentFlash] = useState(false);
  const sentFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (sentFlashTimerRef.current) clearTimeout(sentFlashTimerRef.current);
    if (refocusTimerRef.current) clearTimeout(refocusTimerRef.current);
  }, []);

  const flashAndRefocus = () => {
    setSentFlash(true);
    if (sentFlashTimerRef.current) clearTimeout(sentFlashTimerRef.current);
    if (refocusTimerRef.current) clearTimeout(refocusTimerRef.current);
    sentFlashTimerRef.current = setTimeout(() => setSentFlash(false), 800);
    refocusTimerRef.current = setTimeout(() => inputRef.current?.focus(), 50);
  };

  useEffect(() => {
    if (externalClear && externalClear !== lastClearRef.current) {
      lastClearRef.current = externalClear;
      setValue(''); onInputChange(''); setChatAcVisible(false);
    }
  }, [externalClear, onInputChange]);

  // Update autocomplete as user types
  useEffect(() => {
    if (value.length < 1) { setChatAcVisible(false); return; }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const contextKeywords = contextEnabled ? extractKeywordsFromBuffer(getFullBuffer()) : [];
      let runtimeMatches: AutocompleteSuggestion[] = [];
      try {
        const data = await terminalAPI.autocomplete(value, 12);
        runtimeMatches = Array.isArray(data?.suggestions) ? data.suggestions : [];
      } catch {
        // The cached capability catalog is the offline fallback.
      }
      if (cancelled) return;
      const merged = [...runtimeMatches, ...catalog.filter((entry) => !runtimeMatches.some((match) => match.command === entry.command))];
      const results = rankTerminalCatalog(value, contextKeywords, merged, 8);
      setChatAcResults(results);
      setChatAcIndex(0);
      setChatAcVisible(results.length > 0);
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value, contextEnabled, getFullBuffer, catalog]);

  const handleSubmit = () => {
    if (!value.trim()) return;
    onSubmit(value); setValue(''); onInputChange(''); setChatAcVisible(false);
    flashAndRefocus();
  };

  const selectSuggestion = (cmd: string) => {
    onSubmit(cmd); setValue(''); onInputChange(''); setChatAcVisible(false);
    flashAndRefocus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (chatAcVisible) {
      if (e.key === 'ArrowUp') { e.preventDefault(); setChatAcIndex(prev => Math.max(0, prev - 1)); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setChatAcIndex(prev => Math.min(chatAcResults.length - 1, prev + 1)); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (chatAcResults.length > 0) {
          const cmd = chatAcResults[chatAcIndex]?.command || '';
          setValue(cmd); onInputChange(cmd);
          // Keep autocomplete open for further refinement
        }
        return;
      }
      if (e.key === 'Escape') { setChatAcVisible(false); return; }
    }
    if (e.key === 'Escape') {
      // Handled by parent to switch to terminal mode
      return;
    }
    if (e.key === 'Enter') {
      if (chatAcVisible && chatAcResults.length > 0) {
        selectSuggestion(chatAcResults[chatAcIndex].command);
      } else {
        handleSubmit();
      }
    }
  };

  const isFocused = inputMode === 'chat';

  return (
    <div className="relative flex-shrink-0">
      {/* Autocomplete panel floating above */}
      <AnimatePresence>
        {chatAcVisible && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.12 }}
            className="absolute bottom-full left-0 right-0 mb-1 z-[200] max-h-[300px] overflow-auto">
            <div className="mx-2 bg-[#0D1130]/95 border border-white/10 rounded-xl shadow-2xl backdrop-blur-2xl overflow-hidden">
              <div className="px-3 py-1.5 border-b border-white/5 flex items-center gap-2">
                <Zap size={10} className="text-emerald-400" />
                <span className="text-[9px] text-slate-500 uppercase tracking-wider">Suggestions</span>
                {contextEnabled && <span className="text-[8px] text-emerald-500/60 ml-auto">context-aware</span>}
              </div>
              {chatAcResults.map((s, i) => {
                const catColor = CATEGORY_COLORS[s.category] || 'text-slate-400 bg-slate-500/10';
                return (
                  <button key={s.command} onClick={() => selectSuggestion(s.command)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-all ${
                      i === chatAcIndex ? 'accent-active border-l-2' : 'hover:bg-white/[0.03] border-l-2 border-transparent'
                    }`}>
                    <span className={`px-1 py-0.5 rounded text-[7px] font-medium uppercase ${catColor} flex-shrink-0`}>{s.category}</span>
                    <code className={`text-[11px] font-mono flex-1 truncate ${i === chatAcIndex ? 'accent-text' : 'text-slate-300'}`}>{s.command}</code>
                    {s.dangerous && <AlertTriangle size={10} className="text-red-400 flex-shrink-0" />}
                    <span className="text-[9px] text-slate-600 truncate max-w-[120px]">{s.description}</span>
                  </button>
                );
              })}
              <div className="px-3 py-1 border-t border-white/5 text-[8px] text-slate-600 flex gap-3">
                <span>↑↓ navigate</span><span>Tab fill</span><span>Enter run</span><span>Esc dismiss</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chat box input */}
      <div className={`flex items-center gap-2 px-4 py-3 bg-[#080B20]/95 backdrop-blur-xl border-t transition-all duration-300 z-[100] ${
        sentFlash ? 'border-emerald-400/60 shadow-[0_-2px_30px_rgba(16,185,129,0.15)]'
          : running ? 'border-emerald-500/40 shadow-[0_-2px_20px_rgba(16,185,129,0.08)]'
          : isFocused ? 'border-emerald-500/30 shadow-[0_-2px_20px_rgba(16,185,129,0.05)]'
          : 'border-white/[0.06]'
      }`}
        style={running ? { animation: 'pulse-border 2s ease-in-out infinite' } : undefined}>
        <span className={`font-mono text-sm select-none flex-shrink-0 transition-colors ${sentFlash ? 'text-emerald-300' : isFocused ? 'text-emerald-400' : 'text-slate-600'}`}>
          {sentFlash ? '✓' : '$'}
        </span>
        <input ref={inputRef} value={value}
          onChange={e => { setValue(e.target.value); onInputChange(e.target.value); }}
          onKeyDown={handleKeyDown}
          onFocus={onFocusChatBox}
          aria-label="Terminal command"
          placeholder={connected ? (running ? 'Command running… (click terminal for interactive)' : 'Type a command… or click terminal for direct input') : 'Disconnected...'}
          disabled={!connected}
          className={`flex-1 bg-transparent text-white font-mono placeholder-slate-600 outline-none caret-emerald-400 transition-opacity ${running ? 'opacity-50' : ''}`}
          style={{ fontSize: '16px' }}
        />
        {value && !running && (
          <button onClick={() => { setValue(''); onInputChange(''); setTimeout(() => inputRef.current?.focus(), 50); }}
            className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/5 transition-colors flex-shrink-0"
            title="Clear">
            <X size={14} />
          </button>
        )}
        {running ? (
          <div className="p-2 rounded-lg bg-emerald-500/15 border border-emerald-500/10">
            <Loader2 size={14} className="text-emerald-400 animate-spin" />
          </div>
        ) : (
          <button onClick={handleSubmit} disabled={!connected || !value.trim()}
            className="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-all disabled:opacity-20 disabled:cursor-not-allowed border border-emerald-500/10 text-xs font-medium min-w-[44px] min-h-[44px] flex items-center justify-center"
            style={{ minWidth: '44px', minHeight: '44px' }}>
            Run
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Prompt detection for running indicator ──────────────────────
const PROMPT_PATTERN = /(\$|#|❯|>)\s*$/;

// ─── Terminal theme constant ─────────────────────────────────────
const XTERM_THEME = {
  background: '#0A0E27', foreground: '#F0F4F8', cursor: '#10B981', cursorAccent: '#0A0E27',
  selectionBackground: 'rgba(16, 185, 129, 0.3)',
  black: '#1A1F3A', red: '#EF4444', green: '#10B981', yellow: '#F59E0B',
  blue: '#3B82F6', magenta: '#8B5CF6', cyan: '#06B6D4', white: '#F0F4F8',
  brightBlack: '#475569', brightRed: '#F87171', brightGreen: '#34D399', brightYellow: '#FBBF24',
  brightBlue: '#60A5FA', brightMagenta: '#A78BFA', brightCyan: '#22D3EE', brightWhite: '#FFFFFF',
};

// ─── Per-tab session state (lives outside React to avoid re-renders) ─
interface TabSession {
  terminal: Terminal;
  fitAddon: FitAddon;
  socket: Socket;
  connected: boolean;
  running: boolean;
  outputLines: string[];
  inputBuffer: string;
}

interface PersistedTerminalState {
  tabs: TabDescriptor[];
  activeTabId: string;
}

function buildDefaultTerminalState(): PersistedTerminalState {
  const tabId = `tab-${Date.now()}`;
  return {
    tabs: [{ id: tabId, label: 'bash', type: 'shell' }],
    activeTabId: tabId,
  };
}

function readPersistedTerminalState(): PersistedTerminalState {
  try {
    const raw = sessionStorage.getItem(TERMINAL_STATE_STORAGE_KEY);
    if (!raw) return buildDefaultTerminalState();
    const parsed = JSON.parse(raw) as PersistedTerminalState;
    if (!Array.isArray(parsed?.tabs) || parsed.tabs.length === 0) return buildDefaultTerminalState();
    const normalizedTabs = parsed.tabs.filter((tab) => (
      tab?.id && (tab.type === 'shell' || tab.type === 'chat' || tab.type === 'openclaw-tui')
    ));
    if (normalizedTabs.length === 0) return buildDefaultTerminalState();
    const activeTabExists = normalizedTabs.some((tab) => tab.id === parsed.activeTabId);
    return {
      tabs: normalizedTabs,
      activeTabId: activeTabExists ? parsed.activeTabId : normalizedTabs[0].id,
    };
  } catch {
    return buildDefaultTerminalState();
  }
}

// ─── Independent Shell Tab Component ─────────────────────────────
// Each instance creates its own PTY socket + xterm terminal.
// The div persists; parent shows/hides via CSS.
function ShellTabSession({ tabId, isActive, onConnectionChange, onRunningChange, onDanger, onShowAssistant, acActiveRef, acSelectedIndexRef, setAcSuggestions, setAcSelectedIndex, setAcVisible, setAcInput, catalog }: {
  tabId: string;
  isActive: boolean;
  onConnectionChange: (tabId: string, connected: boolean) => void;
  onRunningChange: (tabId: string, running: boolean) => void;
  onDanger: (cmd: string, message: string, confirmation?: 'explicit' | 'typed', targetTabId?: string) => void;
  onShowAssistant: (tab?: 'lookup' | 'chat') => void;
  acActiveRef: React.MutableRefObject<boolean>;
  acSelectedIndexRef: React.MutableRefObject<number>;
  setAcSuggestions: (s: AutocompleteSuggestion[]) => void;
  setAcSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  setAcVisible: (v: boolean) => void;
  setAcInput: (v: string) => void;
  catalog: AutocompleteSuggestion[];
}) {
  const termRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<TabSession | null>(null);
  const catalogRef = useRef(catalog);
  useEffect(() => { catalogRef.current = catalog; }, [catalog]);

  // Register the session in the shared map so tab-level controls address the
  // exact terminal and socket pair owned by this pane.
  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      theme: XTERM_THEME,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
      fontSize: 14, lineHeight: 1.4, cursorBlink: true, cursorStyle: 'bar',
      allowProposedApi: true, scrollback: 3000, convertEol: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);
    const initialFitTimer = setTimeout(() => { try { fit.fit(); } catch {} }, 100);

    const wsUrl = API_URL.replace(/\/api$/, '');
    const socket = io(`${wsUrl}/terminal`, {
      transports: ['polling', 'websocket'],
      reconnection: false,
      withCredentials: true,
    });

    const session: TabSession = {
      terminal: term, fitAddon: fit, socket, connected: false, running: false, outputLines: [], inputBuffer: '',
    };
    sessionRef.current = session;
    // Register in global map so parent can access
    tabSessionMap.set(tabId, session);
    let autocompleteTimer: ReturnType<typeof setTimeout> | null = null;
    let autocompleteGeneration = 0;
    let latestSuggestions: AutocompleteSuggestion[] = [];
    let disposed = false;
    let classificationPending = false;
    let bracketedPasteState = createBracketedPasteState();
    let bracketedMarkerTimer: ReturnType<typeof setTimeout> | null = null;
    let loosePasteBuffer = '';
    let loosePasteTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleAutocomplete = () => {
      if (autocompleteTimer) clearTimeout(autocompleteTimer);
      const input = session.inputBuffer.trim();
      if (!input) {
        latestSuggestions = [];
        setAcSuggestions([]);
        setAcVisible(false);
        acActiveRef.current = false;
        return;
      }
      const generation = ++autocompleteGeneration;
      autocompleteTimer = setTimeout(async () => {
        let suggestions: AutocompleteSuggestion[] = [];
        try {
          const data = await terminalAPI.autocomplete(input, 10);
          suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
        } catch {
          suggestions = rankTerminalCatalog(input, [], catalogRef.current, 10);
        }
        if (disposed || generation !== autocompleteGeneration) return;
        latestSuggestions = suggestions;
        setAcSuggestions(suggestions);
        setAcSelectedIndex(0);
        setAcInput(input);
        setAcVisible(suggestions.length > 0);
        acActiveRef.current = suggestions.length > 0;
      }, 140);
    };

    socket.on('connect', () => {
      const resumedAfterDisconnect = reconnectAttempt > 0;
      session.connected = true;
      session.running = false;
      session.inputBuffer = '';
      reconnectAttempt = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      onConnectionChange(tabId, true);
      onRunningChange(tabId, false);
      term.writeln('\r\n\x1b[38;5;240m────────────────────────────────────────\x1b[0m');
      if (resumedAfterDisconnect) {
        term.writeln('\x1b[33m ↻ Connected to a fresh shell\x1b[0m');
        term.writeln('\x1b[38;5;240m   The previous shell could not be resumed after the disconnect.\x1b[0m');
      } else {
        term.writeln('\x1b[32m ✓ Connected to Terminal\x1b[0m');
        term.writeln('\x1b[38;5;240m   Ctrl+K → AI Lookup  ·  Ctrl+T → New Tab\x1b[0m');
        term.writeln('\x1b[38;5;240m   HOST OPERATOR  ·  Mutation prompts reduce accidents; this shell is not sandboxed\x1b[0m');
      }
      term.writeln('\x1b[38;5;240m────────────────────────────────────────\x1b[0m\r\n');
    });

    // PTY reconnection with exponential backoff
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    socket.on('disconnect', (reason) => {
      session.connected = false;
      session.running = false;
      session.inputBuffer = '';
      onConnectionChange(tabId, false);
      onRunningChange(tabId, false);
      // Don't attempt reconnect if intentionally closed
      if (reason === 'io client disconnect') {
        term.writeln('\r\n\x1b[31m ✗ Disconnected from terminal\x1b[0m');
        term.writeln('\x1b[38;5;240m   Open a new tab or reset the terminal to start a fresh shell.\x1b[0m\r\n');
        return;
      }
      term.writeln('\r\n\x1b[33m ⟳ Connection lost — retrying with a fresh shell...\x1b[0m');
      reconnectAttempt = 0;
      const tryReconnect = () => {
        if (session.connected) return;
        reconnectAttempt++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 30000);
        term.writeln(`\x1b[38;5;240m   Attempt ${reconnectAttempt} in ${(delay/1000).toFixed(0)}s...\x1b[0m`);
        reconnectTimer = setTimeout(() => {
          if (!session.connected) socket.connect();
        }, delay);
      };
      tryReconnect();
    });

    socket.on('connect_error', (err: any) => {
      // Continue backoff on connect errors during reconnection.
      // Treat these as transient until we've truly failed repeated recovery.
      if (reconnectAttempt === 0) {
        reconnectAttempt = 1;
        term.writeln('\r\n\x1b[33m ⟳ Terminal connection failed — retrying a fresh shell...\x1b[0m');
      }
      if (reconnectAttempt < 10) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 30000);
        term.writeln(`\x1b[38;5;240m   Attempt ${reconnectAttempt} in ${(delay/1000).toFixed(0)}s...\x1b[0m`);
        reconnectTimer = setTimeout(() => {
          if (!session.connected) socket.connect();
        }, delay);
        reconnectAttempt++;
      } else {
        captureError(err || new Error('Terminal socket connect_error'), 'system', 'terminal websocket connect_error');
        term.writeln('\r\n\x1b[31m ✗ Could not start a fresh shell after 10 attempts\x1b[0m\r\n');
      }
    });

    socket.on('output', (data: string) => {
      term.write(data);
      if (PROMPT_PATTERN.test(data.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())) {
        session.running = false;
        onRunningChange(tabId, false);
      }
      const lines = data.split('\n').filter(l => l.trim().length > 0);
      session.outputLines.push(...lines);
      if (session.outputLines.length > 50) session.outputLines = session.outputLines.slice(-50);
    });

    // connect_error handled above in reconnection logic

    const hideAutocomplete = () => {
      latestSuggestions = [];
      setAcVisible(false);
      acActiveRef.current = false;
    };

    const recordTerminalInput = (data: string) => {
      if (data === '\x7f' || data === '\b') session.inputBuffer = session.inputBuffer.slice(0, -1);
      else if (data === '\x15' || data === '\x03') {
        session.inputBuffer = '';
        hideAutocomplete();
      } else {
        const bufferText = data.length > 1 ? data.replace(/\t/g, ' ') : data;
        if (bufferText && !bufferText.includes('\x1b') && [...bufferText].every((character) => character.charCodeAt(0) >= 32)) {
          session.inputBuffer += bufferText;
        }
      }
      scheduleAutocomplete();
    };

    const applyPasteConfirmation = (paste: string) => {
      const decision = decideTerminalPaste(session.inputBuffer, paste);
      if (decision.kind !== 'confirm') return false;
      // A prefix may already be in Bash's line editor. Remove it so confirming
      // the reviewed block executes exactly once.
      socket.emit('input', '\x15');
      session.inputBuffer = '';
      hideAutocomplete();
      onDanger(
        decision.value,
        'Pasted content contains one or more command terminators. Review the entire block before it runs on the host.',
        'typed',
        tabId,
      );
      return true;
    };

    const flushLoosePaste = () => {
      if (loosePasteTimer) {
        clearTimeout(loosePasteTimer);
        loosePasteTimer = null;
      }
      const flushed = flushLooseTerminalPaste(loosePasteBuffer, session.inputBuffer);
      loosePasteBuffer = flushed.remaining;
      const { raw } = flushed;
      if (!raw) return;
      if (flushed.decision.kind === 'confirm' && applyPasteConfirmation(raw)) return;
      socket.emit('input', raw);
      recordTerminalInput(raw);
    };

    const queueLoosePaste = (data: string) => {
      loosePasteBuffer = appendLooseTerminalPaste(loosePasteBuffer, data);
      if (loosePasteTimer) clearTimeout(loosePasteTimer);
      // Browsers that omit bracketed-paste markers may split one paste over
      // several onData calls. A short coalescing window prevents duplicate
      // confirmations while preserving the original byte order.
      loosePasteTimer = setTimeout(flushLoosePaste, 35);
    };

    const handleCompletedBracketedPaste = (paste: string) => {
      const decision = decideTerminalPaste(session.inputBuffer, paste);
      if (decision.kind === 'confirm') {
        applyPasteConfirmation(paste);
        return;
      }
      if (decision.kind === 'ignore') return;
      const framedPaste = `${BRACKETED_PASTE_START}${decision.value}${BRACKETED_PASTE_END}`;
      socket.emit('input', framedPaste);
      recordTerminalInput(decision.value);
    };

    const handleOrdinaryInput = async (data: string) => {
      if (!data) return;
      if (loosePasteBuffer || data.length > 1) {
        queueLoosePaste(data);
        return;
      }
      if (data === '\r' || data === '\n') {
        const cmd = session.inputBuffer.trim();
        classificationPending = true;
        const warning = cmd.length > 0 ? await classifyCommandForUi(cmd) : null;
        classificationPending = false;
        if (disposed) return;
        if (warning && cmd.length > 0) {
          // Characters were already sent one at a time. Remove the pending line
          // before opening confirmation so it cannot execute a second time.
          socket.emit('input', '\x15');
          onDanger(cmd, warning.message, warning.confirmation, tabId);
          session.inputBuffer = '';
          hideAutocomplete();
          return;
        }
        socket.emit('input', data);
        if (cmd) { session.running = true; onRunningChange(tabId, true); }
        session.inputBuffer = '';
        hideAutocomplete();
        return;
      }
      socket.emit('input', data);
      recordTerminalInput(data);
    };

    // Direct typing in xterm. The parser is stateful because browsers and
    // xterm may split both bracketed-paste markers and payloads across events.
    term.onData(async (data) => {
      if (classificationPending) return;
      if (bracketedMarkerTimer) {
        clearTimeout(bracketedMarkerTimer);
        bracketedMarkerTimer = null;
      }
      const parsed = consumeBracketedPasteChunk(bracketedPasteState, data);
      bracketedPasteState = parsed.state;
      for (const event of parsed.events) {
        if (event.type === 'paste') {
          // Preserve ordering when ordinary bytes preceded the paste marker.
          flushLoosePaste();
          handleCompletedBracketedPaste(event.data);
        } else {
          await handleOrdinaryInput(event.data);
        }
      }
      if (bracketedPasteState.pendingMarker) {
        bracketedMarkerTimer = setTimeout(() => {
          const pending = bracketedPasteState.pendingMarker;
          if (!pending) return;
          if (bracketedPasteState.active) {
            bracketedPasteState = {
              ...bracketedPasteState,
              buffer: bracketedPasteState.buffer + pending,
              pendingMarker: '',
            };
          } else {
            bracketedPasteState = { ...bracketedPasteState, pendingMarker: '' };
            socket.emit('input', pending);
            recordTerminalInput(pending);
          }
          bracketedMarkerTimer = null;
        }, 35);
      }
    });

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (acActiveRef.current) {
        if (e.key === 'ArrowUp' && e.type === 'keydown') { e.preventDefault(); setAcSelectedIndex(prev => Math.max(0, prev - 1)); return false; }
        if (e.key === 'ArrowDown' && e.type === 'keydown') {
          e.preventDefault();
          setAcSelectedIndex(prev => {
            return Math.min(Math.max(0, latestSuggestions.length - 1), prev + 1);
          });
          return false;
        }
        if (e.key === 'Tab' && e.type === 'keydown') {
          e.preventDefault();
          if (latestSuggestions.length > 0) {
            const cmd = latestSuggestions[Math.min(acSelectedIndexRef.current, latestSuggestions.length - 1)]?.command || '';
            socket.emit('input', '\x15' + cmd);
            session.inputBuffer = cmd;
            setAcVisible(false); acActiveRef.current = false;
          }
          return false;
        }
        if (e.key === 'Escape' && e.type === 'keydown') { setAcVisible(false); acActiveRef.current = false; return true; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k' && e.type === 'keydown') { e.preventDefault(); onShowAssistant('lookup'); return false; }
      if ((e.ctrlKey || e.metaKey) && e.key === '`' && e.type === 'keydown') { e.preventDefault(); onShowAssistant(); return false; }
      return true;
    });

    term.onResize(({ cols, rows }) => { socket.emit('resize', { cols, rows }); });

    let resizeTimeout: ReturnType<typeof setTimeout>;
    const resizeObs = new ResizeObserver(() => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => { try { fit.fit(); } catch {} }, 50);
    });
    resizeObs.observe(termRef.current);

    return () => {
      disposed = true;
      autocompleteGeneration++;
      if (autocompleteTimer) clearTimeout(autocompleteTimer);
      if (loosePasteTimer) clearTimeout(loosePasteTimer);
      if (bracketedMarkerTimer) clearTimeout(bracketedMarkerTimer);
      loosePasteBuffer = '';
      bracketedPasteState = createBracketedPasteState();
      clearTimeout(initialFitTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearTimeout(resizeTimeout);
      resizeObs.disconnect();
      socket.disconnect();
      term.dispose();
      tabSessionMap.delete(tabId);
    };
  }, [acActiveRef, acSelectedIndexRef, tabId, onConnectionChange, onDanger, onRunningChange, onShowAssistant, setAcInput, setAcSelectedIndex, setAcSuggestions, setAcVisible]);

  // Re-fit when becoming active or layout changes
  useEffect(() => {
    if (isActive) {
      const fitTimer = setTimeout(() => { try { sessionRef.current?.fitAddon.fit(); } catch {} }, 50);
      // Focus the terminal
      sessionRef.current?.terminal.focus();
      return () => clearTimeout(fitTimer);
    }
    return undefined;
  }, [isActive]);

  return (
    <div ref={termRef} className="absolute inset-0 p-1"
      style={{ display: isActive ? 'block' : 'none' }} />
  );
}

// Global session map — lets parent access any tab's terminal/socket without React state
const tabSessionMap = new Map<string, TabSession>();

// ─── Simple tab descriptor (no heavy objects in React state) ─────
interface TabDescriptor {
  id: string;
  label: string;
  type: 'shell' | 'chat' | 'openclaw-tui';
}

// ─── OpenClaw TUI Tab (native xterm.js rendering) ────────────────
// The `openclaw tui` command is a full Ink-based TUI that does its own rendering.
// We render it in xterm.js directly and let it handle its own UI.

// ─── OpenClaw Chat Tab (React-based chat UI) ────────────────────
// Replaces xterm-based TUI with proper chat bubbles, system message filtering, and copy support.

interface GatewayMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

// Detect system/status messages that should be rendered as faint gray text
function isSystemLine(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return true;
  // Gateway status
  if (cleaned.includes('gateway connected')) return true;
  if (cleaned.includes('gateway reconnected')) return true;
  if (/\|\s*idle/.test(cleaned)) return true;
  if (/agent\s+\w+\s*\|\s*session/.test(cleaned)) return true;
  if (/anthropic\/|openai\/|google\/|meta\//.test(cleaned)) return true;
  if (/tokens?\s+\d+[kmb]?\//i.test(cleaned)) return true;
  if (/\|\s*think\s/.test(cleaned)) return true;
  // Horizontal rules
  if (/^[─\-═]{10,}$/.test(cleaned)) return true;
  // Lines with 2+ pipe separators (status bars)
  if ((cleaned.match(/\|/g) || []).length >= 2 && cleaned.length < 200) return true;
  // Session info
  if (/^session\s+\S+/.test(cleaned)) return true;
  // Connection status
  if (/^(connected|disconnected|connecting|reconnecting)/i.test(cleaned)) return true;
  // Model info  
  if (/^model\s+(set|changed|list)/i.test(cleaned)) return true;
  if (/^thinking\s+set/i.test(cleaned)) return true;
  // Command outputs
  if (/^(history|status|usage)\s*(failed|:)/i.test(cleaned)) return true;
  return false;
}

// Strip webchat metadata from user messages (e.g. "[Sat 2026-02-07 20:07 EST]", "[message_id: ...]")
function cleanUserMessage(text: string): string {
  // Remove timestamp prefix
  let cleaned = text.replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/m, '');
  // Remove [message_id: ...] lines
  cleaned = cleaned.replace(/\[message_id:\s*[^\]]+\]/g, '').trim();
  return cleaned;
}

// Parse assistant message content into visual sections
function parseMessageSections(content: string): { type: 'text' | 'tool' | 'thinking'; content: string }[] {
  const sections: { type: 'text' | 'tool' | 'thinking'; content: string }[] = [];
  // Split on tool call patterns and thinking blocks
  const lines = content.split('\n');
  let currentType: 'text' | 'tool' | 'thinking' = 'text';
  let currentLines: string[] = [];

  const flush = () => {
    const text = currentLines.join('\n').trim();
    if (text) sections.push({ type: currentType, content: text });
    currentLines = [];
  };

  for (const line of lines) {
    if (/^(🔧|Tool|Running|Executing|tool_call|<tool)/i.test(line.trim())) {
      flush();
      currentType = 'tool';
      currentLines.push(line);
    } else if (/^(🧠|Thinking|<thinking)/i.test(line.trim())) {
      flush();
      currentType = 'thinking';
      currentLines.push(line);
    } else if (currentType !== 'text' && line.trim() === '') {
      flush();
      currentType = 'text';
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return sections.length ? sections : [{ type: 'text', content }];
}

// Truncatable message content
function TruncatableContent({ content, maxHeight = 300 }: { content: string; maxHeight?: number }) {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [needsTruncation, setNeedsTruncation] = useState(false);

  useEffect(() => {
    if (contentRef.current && contentRef.current.scrollHeight > maxHeight) {
      setNeedsTruncation(true);
    }
  }, [content, maxHeight]);

  const sections = parseMessageSections(content);

  return (
    <div>
      <div
        ref={contentRef}
        className={!expanded && needsTruncation ? 'overflow-hidden' : ''}
        style={!expanded && needsTruncation ? { maxHeight: `${maxHeight}px` } : undefined}
      >
        {sections.map((section, i) => (
          <div key={i}>
            {sections.length > 1 && i > 0 && (
              <div className="border-t border-white/5 my-1.5" />
            )}
            {section.type === 'tool' && (
              <div className="text-[10px] text-amber-400/60 font-medium mb-0.5">🔧 Tool</div>
            )}
            {section.type === 'thinking' && (
              <div className="text-[10px] text-purple-400/60 font-medium mb-0.5">🧠 Thinking</div>
            )}
            <div className={`text-sm whitespace-pre-wrap break-words leading-relaxed ${
              section.type === 'tool' ? 'text-amber-200/80 font-mono text-xs pl-2 border-l border-amber-500/20' :
              section.type === 'thinking' ? 'text-purple-200/70 italic text-xs pl-2 border-l border-purple-500/20' :
              ''
            }`}>
              {section.content}
            </div>
          </div>
        ))}
      </div>
      {needsTruncation && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-emerald-400 hover:text-emerald-300 mt-1"
        >
          {expanded ? '▲ Show less' : '▼ Show more...'}
        </button>
      )}
    </div>
  );
}

function OpenClawTUITab({ tabId, isActive, onConnectionChange }: {
  tabId: string; isActive: boolean; onConnectionChange: (tabId: string, connected: boolean) => void;
}) {
  const [messages, setMessages] = useState<GatewayMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [selectedSession, setSelectedSession] = useState('agent:main:main');
  const [availableSessions, setAvailableSessions] = useState<Array<{ sessionId?: string; key?: string; title?: string; lastActivityAt?: string; updatedAt?: number; label?: string; agentId?: string }>>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const streamControllerRef = useRef<AbortController | null>(null);
  const statusSocketRef = useRef<Socket | null>(null);
  const selectedSessionRef = useRef('agent:main:main');
  const loadSessionsRef = useRef<() => Promise<Array<{ key: string; updatedAt?: number; label?: string; agentId?: string }>>>(async () => []);
  const loadHistoryRef = useRef<(sessionKey?: string) => Promise<void>>(async () => undefined);
  const pollMessagesRef = useRef<(sessionKey?: string) => Promise<void>>(async () => undefined);

  const createFreshSessionKey = useCallback(() => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const random = Math.random().toString(36).slice(2, 8);
    return `agent:main:portal-${stamp}-${random}`;
  }, []);

  // Load history on mount + connect status socket
  useEffect(() => {
    void loadSessionsRef.current();
    void loadHistoryRef.current(selectedSessionRef.current);
    // Poll for new messages every 3 seconds
    pollRef.current = setInterval(() => {
      void pollMessagesRef.current(selectedSessionRef.current);
    }, 3000);

    // Connect to OpenClaw status socket
    const statusSocket = io('/openclaw-status', { transports: ['websocket'] });
    statusSocketRef.current = statusSocket;
    statusSocket.on('status', (data: any) => {
      if (data.session !== 'main') return;
      if (data.type === 'thinking') {
        const shortModel = getShortModelLabel(data.model);
        setStatusText(`🧠 Thinking${shortModel ? ` (${shortModel})` : ''}...`);
      } else if (data.type === 'tool_start') {
        setStatusText(`🔧 Running ${data.tool}...`);
      } else if (data.type === 'tool_end') {
        setStatusText('🧠 Thinking...');
      } else if (data.type === 'streaming') {
        setStatusText('✍️ Writing...');
      } else if (data.type === 'done') {
        setStatusText('');
      }
    });

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      statusSocket.disconnect();
      streamControllerRef.current?.abort();
    };
  }, []);

  // Auto-scroll on new messages (with rAF to ensure DOM is updated)
  useEffect(() => {
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    });
  }, [messages, streamingText]);

  // Focus input when tab becomes active
  useEffect(() => {
    if (isActive) setTimeout(() => inputRef.current?.focus(), 100);
  }, [isActive]);

  // `/gateway/sessions` returns AgentSessionSummary, which names the key
  // `sessionId` and the title `title`. Reading `key`/`label` matched nothing,
  // so every session was filtered out and this list was always empty.
  const sessionKeyOf = (session: any): string =>
    String(session?.sessionId || session?.key || session?.id || '').trim();

  const humanizeSession = (session: { sessionId?: string; key?: string; title?: string; label?: string }) => {
    const title = String(session.title || session.label || '').trim();
    if (title) return title;
    const key = sessionKeyOf(session);
    if (key === 'agent:main:main') return 'Main session';
    return key.split(':').slice(2).join(':') || key;
  };

  const loadSessions = async () => {
    try {
      const data = await gatewayAPI.sessions();
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      const activityTime = (s: any): number => {
        const parsed = Date.parse(String(s?.lastActivityAt ?? s?.updatedAt ?? ''));
        return Number.isNaN(parsed) ? 0 : parsed;
      };
      const filtered = sessions
        .filter((s: any) => sessionKeyOf(s).startsWith('agent:'))
        .filter((s: any) => !sessionKeyOf(s).includes(':run:'))
        .sort((a: any, b: any) => activityTime(b) - activityTime(a));
      setAvailableSessions(filtered);
      if (!filtered.some((s: any) => sessionKeyOf(s) === selectedSessionRef.current)) {
        const fallback = sessionKeyOf(filtered[0]) || 'agent:main:main';
        selectedSessionRef.current = fallback;
        setSelectedSession(fallback);
      }
      return filtered;
    } catch {
      return [];
    }
  };

  const loadHistory = async (sessionKey = selectedSessionRef.current) => {
    try {
      const data = await gatewayAPI.history(sessionKey);
      if (data.messages?.length) {
        const processed = processMessages(data.messages);
        setMessages(processed);
        lastMessageIdRef.current = data.messages[data.messages.length - 1]?.id || null;
      } else {
        setMessages([]);
        lastMessageIdRef.current = null;
      }
      setConnected(true);
      onConnectionChange(tabId, true);
      setError('');
    } catch {
      setError('Failed to connect to gateway');
      setConnected(false);
      onConnectionChange(tabId, false);
    }
  };

  const pollMessages = async (sessionKey = selectedSessionRef.current) => {
    try {
      const data = await gatewayAPI.history(sessionKey, lastMessageIdRef.current || undefined);
      if (data.messages?.length) {
        const processed = processMessages(data.messages);
        setMessages(prev => {
          const next = [...prev];
          for (const msg of processed) {
            if (!next.some(existing => existing.id === msg.id)) next.push(msg);
          }
          return next;
        });
        lastMessageIdRef.current = data.messages[data.messages.length - 1]?.id || null;
      }
      if (!connected) {
        setConnected(true);
        onConnectionChange(tabId, true);
      }
    } catch {
      // Silently fail on poll errors
    }
  };

  const processMessages = (msgs: any[]): GatewayMessage[] => {
    return msgs.map(m => {
      const content = m.content || '';
      // Check if it's a system message
      const lines = content.split('\n');
      const allSystem = lines.every((l: string) => isSystemLine(l));
      
      return {
        id: m.id,
        role: allSystem ? 'system' : m.role,
        content: m.role === 'user' ? cleanUserMessage(content) : content,
        timestamp: m.timestamp,
      };
    });
  };

  loadSessionsRef.current = loadSessions;
  loadHistoryRef.current = loadHistory;
  pollMessagesRef.current = pollMessages;

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const msg = input.trim();
    setInput('');
    
    // Add user message immediately
    const userMsg: GatewayMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: msg,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);
    setStreamingText('');
    setStatusText('🧠 Thinking...');

    const controller = gatewayAPI.sendStream(msg, 'main', {
      onStatus: (content) => setStatusText(content),
      onText: (chunk) => {
        setStreamingText(prev => prev + chunk);
        setStatusText('✍️ Writing...');
      },
      onDone: (fullText) => {
        setStreamingText('');
        setStatusText('');
        setLoading(false);
        const assistantMsg: GatewayMessage = {
          id: `resp-${Date.now()}`,
          role: 'assistant',
          content: fullText,
          timestamp: new Date().toISOString(),
        };
        setMessages(prev => [...prev, assistantMsg]);
      },
      onError: (error) => {
        setStreamingText('');
        setStatusText('');
        setLoading(false);
        setMessages(prev => [...prev, {
          id: `error-${Date.now()}`,
          role: 'system',
          content: `Failed: ${error}`,
          timestamp: new Date().toISOString(),
        }]);
      },
    });
    streamControllerRef.current = controller;
  };

  const handleNewSession = async () => {
    const freshSession = createFreshSessionKey();
    selectedSessionRef.current = freshSession;
    setSelectedSession(freshSession);
    setAvailableSessions(prev => [{ key: freshSession, updatedAt: Date.now() }, ...prev.filter(s => s.key !== freshSession)]);
    setMessages([]);
    setError('');
    setLoading(true);
    setStreamingText('');
    setStatusText('Starting fresh session...');
    lastMessageIdRef.current = null;

    const streamController = new AbortController();
    streamControllerRef.current = streamController;

    try {
      await gatewayAPI.sendStream('/new', freshSession, {
        onStatus: (status) => setStatusText(status),
        onText: () => setStatusText('✍️ Writing...'),
        onDone: async () => {
          setLoading(false);
          setStreamingText('');
          setStatusText('');
          streamControllerRef.current = null;
          await loadSessions();
          await loadHistory(freshSession);
        },
        onError: (error) => {
          setLoading(false);
          setStreamingText('');
          setStatusText('');
          setError(error || 'Failed to start a fresh session');
          streamControllerRef.current = null;
        },
      });
    } catch (err: any) {
      setLoading(false);
      setStatusText('');
      setError(err?.message || 'Failed to start a fresh session');
      streamControllerRef.current = null;
    }
  };

  const handleCopy = async () => {
    const text = messages
      .filter(m => m.role !== 'system')
      .map(m => {
        const role = m.role === 'assistant' ? 'Assistant' : 'You';
        return `${role}: ${m.content}`;
      })
      .join('\n\n');
    
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  if (!isActive) return null;

  return (
    <div className="flex flex-col h-full bg-[#0A0E27]">
      {/* Chat header with copy button */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
          <span className="text-xs text-slate-400">
            {connected ? 'Connected to Assistant' : 'Connecting...'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedSession}
            onChange={(e) => {
              const next = e.target.value;
              selectedSessionRef.current = next;
              setSelectedSession(next);
              setMessages([]);
              setError('');
              setStreamingText('');
              setStatusText('');
              lastMessageIdRef.current = null;
              loadHistory(next);
            }}
            className="max-w-[220px] text-xs px-2 py-1 rounded-lg bg-white/5 text-slate-300 border border-white/10 hover:border-white/20 focus:outline-none"
            title="Switch session"
          >
            {availableSessions.map((session) => {
              const key = sessionKeyOf(session);
              return <option key={key} value={key}>{humanizeSession(session as any)}</option>;
            })}
          </select>
          <button
            onClick={handleNewSession}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 border border-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Sparkles size={12} />
            New Session
          </button>
          <button
            onClick={handleCopy}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              copied
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 border border-white/10'
            }`}
          >
            <Copy size={12} />
            {copied ? 'Copied!' : 'Copy Chat'}
          </button>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-auto px-4 py-4 space-y-3">
        {error && (
          <div className="text-center text-red-400 text-sm py-4">{error}</div>
        )}
        
        {messages.length === 0 && !error && (
          <div className="text-center text-slate-500 text-sm py-8">
            <Sparkles size={24} className="mx-auto mb-2 text-emerald-400/40" />
            <p>Chat with Assistant</p>
            <p className="text-xs text-slate-600 mt-1">Messages from your current session will appear here</p>
          </div>
        )}

        {messages.map((msg) => {
          if (msg.role === 'system') {
            return (
              <div key={msg.id} className="text-center text-slate-500 text-xs my-1 opacity-50 italic select-none">
                {msg.content}
              </div>
            );
          }

          const isUser = msg.role === 'user';
          return (
            <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
                isUser
                  ? 'bg-emerald-500/20 text-emerald-50 border border-emerald-500/20'
                  : 'bg-white/[0.06] text-slate-200 border border-white/[0.06]'
              }`}>
                <div className="text-[10px] font-medium mb-1 opacity-50">
                  {isUser ? 'You' : 'Assistant'}
                </div>
                {isUser ? (
                  <div className="text-sm whitespace-pre-wrap break-words leading-relaxed">{msg.content}</div>
                ) : (
                  <TruncatableContent content={msg.content} />
                )}
                <div className="text-[9px] opacity-30 mt-1 text-right">
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          );
        })}

        {loading && streamingText && (
          <div className="flex justify-start">
            <div className="bg-white/[0.06] rounded-2xl px-4 py-3 border border-white/[0.06] max-w-[80%]">
              <div className="text-[10px] font-medium mb-1 opacity-50">Assistant</div>
              <TruncatableContent content={streamingText} maxHeight={400} />
              <span className="inline-block w-1.5 h-4 bg-emerald-400 animate-pulse ml-0.5 align-text-bottom" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Status indicator - fixed position above input */}
      {loading && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-t border-white/5 bg-[#0A0E27]/95 flex-shrink-0">
          <Loader2 size={12} className="text-emerald-400 animate-spin" />
          <span className="text-[11px] text-slate-400">{statusText || '🧠 Thinking...'}</span>
        </div>
      )}

      {/* Input */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-white/5 bg-[#080B20]/95 flex-shrink-0">
        <input
          aria-label="Message terminal assistant"
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSend(); }}
          placeholder={connected ? 'Type a message...' : 'Connecting...'}
          disabled={!connected || loading}
          className="flex-1 bg-transparent text-white placeholder-slate-600 outline-none text-sm"
          style={{ fontSize: '16px' }}
        />
        <button
          aria-label="Send message to terminal assistant"
          onClick={handleSend}
          disabled={!connected || !input.trim() || loading}
          className="p-2.5 rounded-xl bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-all disabled:opacity-20 border border-emerald-500/20"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}

// ─── Main Terminal Page ──────────────────────────────────────────
export default function TerminalPage() {
  const isMobile = useIsMobile();
  const [fullscreen, setFullscreen] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const assistantBusyRef = useRef(false);
  const [inputMode, setInputMode] = useState<'chat' | 'terminal'>('chat');
  // Shared context toggle for both Lookup and chat box autocomplete
  const [sharedContextEnabled, setSharedContextEnabled] = useState(true);
  const [capabilities, setCapabilities] = useState<TerminalCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState('');
  const [capabilityLoading, setCapabilityLoading] = useState(true);

  const loadCapabilities = useCallback(async (refresh = false) => {
    setCapabilityLoading(true);
    try {
      const data = await terminalAPI.capabilities(refresh);
      setCapabilities(data as TerminalCapabilities);
      setCapabilityError('');
    } catch {
      setCapabilityError('Runtime discovery unavailable; shell access still works.');
    } finally {
      setCapabilityLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    terminalAPI.capabilities(false).then((data) => {
      if (!mounted) return;
      setCapabilities(data as TerminalCapabilities);
      setCapabilityError('');
    }).catch(() => {
      if (mounted) setCapabilityError('Runtime discovery unavailable; shell access still works.');
    }).finally(() => {
      if (mounted) setCapabilityLoading(false);
    });
    return () => { mounted = false; };
  }, []);

  const runtimeCatalog = useMemo<AutocompleteSuggestion[]>(() => buildTerminalCatalog(capabilities), [capabilities]);

  // Tabs — lightweight descriptors only, heavy state in tabSessionMap
  const initialState = useMemo(readPersistedTerminalState, []);
  const [tabs, setTabs] = useState<TabDescriptor[]>(initialState.tabs);
  const [activeTabId, setActiveTabId] = useState(initialState.activeTabId);

  // Per-tab connection/running state (kept in React for UI)
  const [tabStates, setTabStates] = useState<Record<string, { connected: boolean; running: boolean }>>({});

  // Autocomplete state (shared — only active tab drives it)
  const [acSuggestions, setAcSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const [acSelectedIndex, setAcSelectedIndex] = useState(0);
  const [acVisible, setAcVisible] = useState(false);
  const [acInput, setAcInput] = useState('');
  const acActiveRef = useRef(false);
  const acSelectedIndexRef = useRef(0);
  useEffect(() => { acSelectedIndexRef.current = acSelectedIndex; }, [acSelectedIndex]);

  // Danger warning
  const [dangerWarning, setDangerWarning] = useState<{
    command: string;
    message: string;
    tabId: string;
    confirmation: 'explicit' | 'typed';
  } | null>(null);
  const [clearTrigger, setClearTrigger] = useState(0);

  const activeState = tabStates[activeTabId] || { connected: false, running: false };

  const [showNewTabMenu, setShowNewTabMenu] = useState(false);
  const newTabButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const snapshot: PersistedTerminalState = {
      tabs,
      activeTabId,
    };
    sessionStorage.setItem(TERMINAL_STATE_STORAGE_KEY, JSON.stringify(snapshot));
  }, [tabs, activeTabId]);

  // Create tab
  const createTab = useCallback((type: 'shell' | 'chat' | 'openclaw-tui' = 'shell') => {
    if (assistantBusyRef.current || tabs.length >= 5) return;
    const id = `tab-${Date.now()}`;
    let label: string;
    if (type === 'shell') { const shellCount = tabs.filter(t => t.type === 'shell').length; label = `bash ${shellCount + 1}`; }
    else if (type === 'openclaw-tui') { label = '💬 OpenClaw'; }
    else { label = '💬 Assistant'; }
    setTabs(prev => [...prev, { id, label, type }]);
    setActiveTabId(id);
    setShowNewTabMenu(false);
  }, [tabs]);

  // Close tab
  const closeTab = useCallback((tabId: string) => {
    if (assistantBusyRef.current || tabs.length <= 1) return;
    // Session cleanup happens in ShellTabSession's useEffect return
    setTabs(prev => prev.filter(t => t.id !== tabId));
    if (activeTabId === tabId) {
      setActiveTabId(() => {
        const remaining = tabs.filter(t => t.id !== tabId);
        return remaining[remaining.length - 1]?.id || remaining[0]?.id || '';
      });
    }
  }, [tabs, activeTabId]);

  // Callbacks from child sessions
  const handleConnectionChange = useCallback((tabId: string, connected: boolean) => {
    setTabStates(prev => ({ ...prev, [tabId]: { ...prev[tabId], connected, running: prev[tabId]?.running || false } }));
  }, []);

  const handleRunningChange = useCallback((tabId: string, running: boolean) => {
    setTabStates(prev => ({ ...prev, [tabId]: { ...prev[tabId], connected: prev[tabId]?.connected || false, running } }));
  }, []);

  const handleDanger = useCallback((cmd: string, message: string, confirmation: 'explicit' | 'typed' = 'typed', targetTabId = activeTabId) => {
    setDangerWarning({ command: cmd, message, tabId: targetTabId, confirmation });
  }, [activeTabId]);

  const handleShowAssistant = useCallback((tab?: 'lookup' | 'chat') => {
    if (assistantBusyRef.current) return;
    setShowAssistant(prev => tab ? true : !prev);
  }, []);

  const handleAssistantBusyChange = useCallback((busy: boolean) => {
    assistantBusyRef.current = busy;
    setAssistantBusy(busy);
  }, []);

  // Execute command on active tab's socket
  const executeCommand = useCallback(async (cmd: string) => {
    const warning = await classifyCommandForUi(cmd);
    if (warning) {
      setDangerWarning({ command: cmd, message: warning.message, tabId: activeTabId, confirmation: warning.confirmation });
      return;
    }
    const session = tabSessionMap.get(activeTabId);
    if (session) {
      sounds.click();
      session.socket.emit('input', cmd + '\n');
      session.running = true;
      handleRunningChange(activeTabId, true);
    }
  }, [activeTabId, handleRunningChange]);

  const insertCommand = useCallback((cmd: string) => {
    executeCommand(cmd);
    setClearTrigger(prev => prev + 1);
  }, [executeCommand]);

  const forceExecuteCommand = useCallback(() => {
    if (dangerWarning) {
      const session = tabSessionMap.get(dangerWarning.tabId);
      if (!session?.connected) {
        setDangerWarning({
          ...dangerWarning,
          message: 'This Terminal disconnected before confirmation. Reconnect, review the command again, then confirm it.',
        });
        return;
      }
      if (session) {
        session.socket.emit('input', dangerWarning.command + '\n');
        session.running = true;
        handleRunningChange(dangerWarning.tabId, true);
      }
    }
    setDangerWarning(null);
  }, [dangerWarning, handleRunningChange]);

  const cancelDangerCommand = useCallback(() => { setDangerWarning(null); }, []);

  const handleInputBarSubmit = useCallback((cmd: string) => { executeCommand(cmd); }, [executeCommand]);

  const handleInputBarChange = useCallback((_value: string) => {
    // ChatBoxInput owns its debounced runtime suggestions. Hide direct-PTY completions.
    setAcVisible(false);
    acActiveRef.current = false;
  }, []);

  const handleAcSelect = useCallback((cmd: string) => {
    const session = tabSessionMap.get(activeTabId);
    if (session) {
      session.socket.emit('input', '\x15' + cmd);
      session.inputBuffer = cmd;
      session.terminal.focus();
    }
    setAcVisible(false); acActiveRef.current = false;
  }, [activeTabId]);

  const getFullBuffer = useCallback(() => {
    const session = tabSessionMap.get(activeTabId);
    if (!session) return '';
    const buf = session.terminal.buffer.active;
    const lines: string[] = [];
    // Only inspect recent rows. Walking the entire scrollback on every lookup
    // keystroke was a noticeable main-thread tax on low-spec clients.
    for (let i = Math.max(0, buf.length - 240); i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n').trimEnd().slice(-8000);
  }, [activeTabId]);

  const activeTabType = tabs.find(t => t.id === activeTabId)?.type || 'shell';

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const shortcutKey = e.key.toLowerCase();
      const modifierPressed = e.ctrlKey || e.metaKey;
      if (
        assistantBusyRef.current
        && (
          e.key === 'Escape'
          || (modifierPressed && (
            shortcutKey === 'k'
            || shortcutKey === '`'
            || shortcutKey === 't'
            || shortcutKey === 'w'
            || (shortcutKey >= '1' && shortcutKey <= '5')
          ))
        )
      ) {
        e.preventDefault();
        return;
      }
      if (document.querySelector('[data-viewport-modal-layer="true"]')) {
        if (
          e.key === 'Escape' ||
          (modifierPressed && (
            shortcutKey === 'k' ||
            shortcutKey === '`' ||
            shortcutKey === 't' ||
            shortcutKey === 'w' ||
            (shortcutKey >= '1' && shortcutKey <= '5')
          ))
        ) {
          e.preventDefault();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setShowAssistant(true); }
      if ((e.ctrlKey || e.metaKey) && e.key === '`') { e.preventDefault(); setShowAssistant(prev => !prev); }
      if ((e.ctrlKey || e.metaKey) && e.key === 't') { e.preventDefault(); createTab('shell'); }
      if (e.key === 'Escape' && inputMode === 'chat') {
        setInputMode('terminal');
        const session = tabSessionMap.get(activeTabId);
        if (session) session.terminal.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') { e.preventDefault(); closeTab(activeTabId); }
      if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '5') {
        const idx = parseInt(e.key) - 1;
        if (idx < tabs.length) { e.preventDefault(); setActiveTabId(tabs[idx].id); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tabs, activeTabId, createTab, closeTab, inputMode]);

  // Re-fit active terminal on layout changes
  useEffect(() => {
    // Fit after a short delay and again after animations settle
    const t1 = setTimeout(() => {
      const session = tabSessionMap.get(activeTabId);
      try { session?.fitAddon.fit(); } catch {}
    }, 100);
    const t2 = setTimeout(() => {
      const session = tabSessionMap.get(activeTabId);
      try { session?.fitAddon.fit(); } catch {}
    }, 400);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [fullscreen, showAssistant, activeTabId]);

  // Global window resize handler — fit all visible terminals
  useEffect(() => {
    let resizeTimer: ReturnType<typeof setTimeout>;
    let orientationTimer: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        tabSessionMap.forEach((session) => {
          try { session.fitAddon.fit(); } catch {}
        });
      }, 150);
    };
    const handleOrientationChange = () => {
      clearTimeout(orientationTimer);
      orientationTimer = setTimeout(handleResize, 300);
    };
    window.addEventListener('resize', handleResize);
    // Also handle orientation change for tablets
    window.addEventListener('orientationchange', handleOrientationChange);
    return () => {
      clearTimeout(resizeTimer);
      clearTimeout(orientationTimer);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleOrientationChange);
    };
  }, []);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className={`flex flex-col ${fullscreen ? 'fixed inset-0 z-50 bg-[#0A0E27]' : 'h-full min-h-0 overflow-hidden'}`}>

      {/* Danger Warning Modal */}
      <AnimatePresence>
        {dangerWarning && <DangerWarningModal command={dangerWarning.command} message={dangerWarning.message}
          confirmation={dangerWarning.confirmation} onConfirm={forceExecuteCommand} onCancel={cancelDangerCommand} />}
      </AnimatePresence>

      {/* Toolbar */}
      <div className="flex items-center justify-between px-2 sm:px-4 py-2 sm:py-2.5 border-b border-white/5 bg-[#0D1130]/80 backdrop-blur-xl flex-shrink-0" style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0.5rem))' }}>
        <div className="flex items-center gap-1.5 sm:gap-3 min-w-0">
          <TermIcon size={16} className="text-emerald-400 flex-shrink-0" />
          <span className="font-medium text-sm hidden sm:inline">Terminal</span>
          <span className={`inline-flex items-center gap-1 px-1.5 sm:px-2 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0 ${activeState.connected ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${activeState.connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
            <span className="hidden sm:inline">{activeState.connected ? 'Connected' : 'Disconnected'}</span>
          </span>
          <span className="hidden md:inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300" title="Owner and Sub-Admin Terminal sessions run directly on the host">
            <ShieldAlert size={10} /> Host operator
          </span>
        </div>
        <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
          <button onClick={() => setShowAssistant(true)}
            className="flex items-center gap-1 px-2 sm:px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors text-xs font-medium border border-emerald-500/20 mr-0.5 sm:mr-1 min-w-[44px] min-h-[44px] justify-center"
            title="Assistant (Ctrl+` to toggle)" aria-label="Open Terminal assistant">
            <Sparkles size={13} />
            <span className="hidden md:inline">Assistant</span>
          </button>
          {activeTabType === 'shell' && (
            <>
              <button onClick={() => {
                  const s = tabSessionMap.get(activeTabId);
                  s?.terminal.clear();
                }}
                className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center" title="Clear" aria-label="Clear terminal display"><Trash2 size={15} /></button>
              <button onClick={() => {
                  const s = tabSessionMap.get(activeTabId);
                  if (s) { s.terminal.reset(); s.socket.emit('input', '\x03'); }
                }}
                className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center hidden sm:flex" title="Reset" aria-label="Interrupt and reset terminal"><RotateCcw size={15} /></button>
              <button onClick={async () => {
                  const s = tabSessionMap.get(activeTabId);
                  const sel = s?.terminal.getSelection();
                  if (sel) { try { await navigator.clipboard.writeText(sel); } catch {} }
                }}
                className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center hidden sm:flex" title="Copy" aria-label="Copy terminal selection"><Copy size={15} /></button>
            </>
          )}
          <button onClick={() => setFullscreen(!fullscreen)} className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center" title="Fullscreen" aria-label={fullscreen ? 'Exit fullscreen Terminal' : 'Open fullscreen Terminal'}>
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
      </div>

      {/* Tab Bar */}
      <div className="flex items-center bg-[#080B20] border-b border-white/5 px-2 overflow-x-auto overflow-y-visible flex-shrink-0 scrollbar-none relative" role="tablist" aria-label="Terminal sessions">
        {tabs.map(tab => {
          const state = tabStates[tab.id];
          return (
            <div key={tab.id} className="group flex items-center whitespace-nowrap">
              <button type="button" role="tab" aria-selected={tab.id === activeTabId} disabled={assistantBusy} onClick={() => { if (!assistantBusyRef.current) setActiveTabId(tab.id); }}
                className={`flex items-center gap-1.5 border-b-2 py-1.5 pl-3 text-xs font-medium transition-all ${tabs.length > 1 ? 'pr-1' : 'pr-3'} ${
                  tab.id === activeTabId
                    ? 'accent-active'
                    : 'border-transparent text-slate-500 hover:text-slate-300 hover:bg-white/[0.02]'
                }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${state?.connected ? 'bg-emerald-400' : 'bg-slate-500'}`} />
                {tab.label}
                {state?.running && <Loader2 size={10} className="text-emerald-400 animate-spin" />}
              </button>
              {tabs.length > 1 && (
                <button type="button" onClick={() => closeTab(tab.id)} disabled={assistantBusy} aria-label={`Close ${tab.label} terminal`}
                  className="mr-1 rounded p-1 text-slate-600 opacity-60 transition-all hover:bg-white/10 hover:text-red-400 focus:opacity-100 group-hover:opacity-100">
                  <X size={10} />
                </button>
              )}
            </div>
          );
        })}
        <div className="relative">
          <button ref={newTabButtonRef} onClick={() => { if (!assistantBusyRef.current) setShowNewTabMenu(prev => !prev); }} disabled={assistantBusy || tabs.length >= 5}
            className="flex items-center gap-1 px-2 py-1.5 text-slate-600 hover:text-emerald-400 transition-colors disabled:opacity-20 cursor-pointer disabled:cursor-not-allowed"
            title="New tab (Ctrl+T)" aria-label="Create terminal tab" aria-haspopup="menu" aria-expanded={showNewTabMenu}>
            <Plus size={14} />
          </button>
          <AnchoredPopover
            open={showNewTabMenu}
            anchorRef={newTabButtonRef}
            onDismiss={() => setShowNewTabMenu(false)}
            width={192}
            align="start"
            gap={4}
            ariaLabel="Create terminal tab"
            className="rounded-xl border border-white/10 bg-[#0D1130]/95 shadow-2xl backdrop-blur-xl"
          >
            <div role="menu" aria-label="Create terminal tab" className="overflow-hidden rounded-xl">
              <button type="button" role="menuitem" onClick={() => { createTab('shell'); setShowNewTabMenu(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-emerald-500/10 hover:text-emerald-400 transition-colors">
                <span>🟢</span> New Terminal
              </button>
            </div>
          </AnchoredPopover>
        </div>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* All terminal sessions — each has own div, shown/hidden */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0 relative">
          <div
            className="flex-1 min-h-0 min-w-0 overflow-hidden relative"
            role="textbox"
            aria-multiline="true"
            tabIndex={0}
            aria-label="Terminal session area"
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              if (activeTabType === 'shell') {
                event.preventDefault();
                setInputMode('terminal');
                tabSessionMap.get(activeTabId)?.terminal.focus();
              }
            }}
            onClick={() => {
            if (activeTabType === 'shell') {
              setInputMode('terminal');
              const session = tabSessionMap.get(activeTabId);
              if (session) session.terminal.focus();
            }
          }}>
            {tabs.filter(t => t.type === 'shell').map(tab => (
              <ShellTabSession
                key={tab.id}
                tabId={tab.id}
                isActive={tab.id === activeTabId}
                onConnectionChange={handleConnectionChange}
                onRunningChange={handleRunningChange}
                onDanger={handleDanger}
                onShowAssistant={handleShowAssistant}
                acActiveRef={acActiveRef}
                acSelectedIndexRef={acSelectedIndexRef}
                setAcSuggestions={setAcSuggestions}
                setAcSelectedIndex={setAcSelectedIndex}
                setAcVisible={setAcVisible}
                setAcInput={setAcInput}
                catalog={runtimeCatalog}
              />
            ))}
            {tabs.filter(t => t.type === 'openclaw-tui').map(tab => (
              <OpenClawTUITab
                key={tab.id}
                tabId={tab.id}
                isActive={tab.id === activeTabId}
                onConnectionChange={handleConnectionChange}
              />
            ))}
            {activeTabType === 'shell' && acVisible && acSuggestions.length > 0 && (
              <div className="absolute bottom-2 left-2 right-2 z-40 max-h-64 overflow-auto rounded-xl border border-white/10 bg-[#0D1130]/95 shadow-2xl backdrop-blur-xl" role="listbox" aria-label={`Runtime completions for ${acInput}`}>
                <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5 text-[9px] uppercase tracking-wider text-slate-500">
                  <span>Runtime completions</span>
                  <span>Tab inserts · Enter runs</span>
                </div>
                {acSuggestions.map((suggestion, index) => (
                  <button key={`${suggestion.source || 'runtime'}:${suggestion.command}`} type="button" role="option" aria-selected={index === acSelectedIndex}
                    onMouseDown={(event) => event.preventDefault()} onClick={() => handleAcSelect(suggestion.command)}
                    className={`flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left ${index === acSelectedIndex ? 'accent-active' : 'border-transparent hover:bg-white/[0.03]'}`}>
                    <span className="rounded bg-white/5 px-1 py-0.5 text-[8px] uppercase text-slate-500">{suggestion.source || 'runtime'}</span>
                    <code className={`min-w-0 flex-1 truncate text-[11px] ${index === acSelectedIndex ? 'accent-text' : 'text-slate-300'}`}>{suggestion.command}</code>
                    {suggestion.dangerous && <AlertTriangle size={10} className="shrink-0 text-amber-400" />}
                    <span className="max-w-[35%] truncate text-[9px] text-slate-500">{suggestion.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {activeTabType === 'shell' && (
            <>
              {/* Runtime-backed operator actions and installed-tool inventory */}
              <div className="border-t border-white/5 bg-[#080B20]/85 px-3 py-2">
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <div className="min-w-0" title={capabilities?.notice}>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Operator actions</span>
                    <span className="ml-2 text-[9px] text-amber-300/80">Full server access · raw shell unrestricted</span>
                    <span className="ml-2 hidden text-[9px] text-slate-600 sm:inline">Live capabilities + reviewed templates, not a command encyclopedia</span>
                  </div>
                  <button type="button" onClick={() => loadCapabilities(true)} disabled={capabilityLoading}
                    className="flex min-h-[32px] items-center gap-1 rounded-md px-2 text-[9px] text-slate-500 hover:bg-white/5 hover:text-emerald-300 disabled:opacity-40" aria-label="Refresh installed terminal tools">
                    <RotateCcw size={10} className={capabilityLoading ? 'animate-spin' : ''} /> Refresh
                  </button>
                </div>
                {capabilityError && <p className="mb-1 text-[10px] text-amber-300" role="status">{capabilityError}</p>}
                <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                  {(capabilities?.actions || []).map((action) => {
                    const unavailable = action.available === false;
                    const requirements = unavailable && action.unmetRequirements?.length
                      ? `Unavailable: missing ${action.unmetRequirements.join(', ')}`
                      : `Requirements: ${action.requirements.join(', ')}`;
                    return (
                    <button key={action.id} type="button" onClick={() => executeCommand(action.command)} disabled={unavailable}
                      title={`${action.description} ${requirements}`}
                      className={`shrink-0 rounded-lg border px-2 py-1 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${action.risk === 'read_only' ? 'border-white/5 bg-white/[0.03] hover:border-emerald-500/30 hover:bg-emerald-500/10' : 'border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/15'}`}>
                      <span className={`flex items-center gap-1 text-[10px] font-medium ${unavailable ? 'text-slate-500' : action.risk === 'read_only' ? 'text-slate-300' : 'text-amber-300'}`}>
                        {action.title}
                        <span className="text-[7px] uppercase opacity-60">{unavailable ? 'unavailable' : action.risk === 'read_only' ? 'read only' : 'confirm'}</span>
                      </span>
                      <span className="block max-w-[180px] truncate font-mono text-[8px] text-slate-600">{action.command}</span>
                    </button>
                  )})}
                  {capabilityLoading && !capabilities && <span className="px-2 py-2 text-[10px] text-slate-500">Discovering installed tools…</span>}
                </div>
                {capabilities && (
                  <>
                    <div className="mt-1 flex gap-1.5 overflow-x-auto scrollbar-none" aria-label="Detected host services">
                      {(capabilities.services || []).filter((service) => service.installed).map((service) => (
                        <span key={service.id} title={`${service.unit} · ${service.activeState || 'unknown'}/${service.subState || 'unknown'}`}
                          className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[8px] ${service.status === 'active' ? 'bg-emerald-500/5 text-emerald-400/70' : service.status === 'failed' ? 'bg-red-500/10 text-red-300' : 'bg-amber-500/5 text-amber-300/70'}`}>
                          <span className={`h-1 w-1 rounded-full ${service.status === 'active' ? 'bg-emerald-400' : service.status === 'failed' ? 'bg-red-400' : 'bg-amber-400'}`} />
                          {service.label} · {service.status}
                        </span>
                      ))}
                    </div>
                    <div className="mt-1 flex gap-1.5 overflow-x-auto scrollbar-none" aria-label="Installed command-line tools">
                      {capabilities.tools.filter((tool) => tool.installed).map((tool) => (
                        <a key={tool.id} href={tool.sourceUrl} target="_blank" rel="noreferrer" title={`${tool.version || 'Installed'} · ${tool.helpCommand} · ${tool.executable || ''}`}
                          className="inline-block max-w-[280px] shrink-0 truncate rounded-md bg-white/[0.025] px-1.5 py-0.5 text-[8px] text-slate-500 hover:text-slate-300">
                          {tool.label}<span className="ml-1 text-slate-600">{tool.version || 'installed'}</span>
                        </a>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <ChatBoxInput onSubmit={handleInputBarSubmit} onInputChange={handleInputBarChange}
                connected={activeState.connected} running={activeState.running} externalClear={clearTrigger}
                inputMode={inputMode} onFocusChatBox={() => setInputMode('chat')}
                contextEnabled={sharedContextEnabled} getFullBuffer={getFullBuffer} catalog={runtimeCatalog} />
            </>
          )}
        </div>

        {/* Assistant Panel */}
        <AnimatePresence>
          {showAssistant && (
            <AssistantAIPanel key={`terminal-assistant:${activeTabId}`} isOpen={showAssistant} onClose={() => { if (!assistantBusyRef.current) setShowAssistant(false); }}
              onInsert={insertCommand} getFullBuffer={getFullBuffer}
              contextEnabled={sharedContextEnabled} setContextEnabled={setSharedContextEnabled} catalog={runtimeCatalog}
              contextKey={activeTabId} isMobile={isMobile} onBusyChange={handleAssistantBusyChange} />
          )}
        </AnimatePresence>
      </div>

      {/* CSS for pulse animation and responsive fixes */}
      <style>{`
        @keyframes pulse-border {
          0%, 100% { border-color: rgba(16, 185, 129, 0.2); }
          50% { border-color: rgba(16, 185, 129, 0.5); }
        }
        .scrollbar-none::-webkit-scrollbar { display: none; }
        .scrollbar-none { -ms-overflow-style: none; scrollbar-width: none; }
        /* Ensure xterm fills container */
        .xterm { height: 100% !important; }
        .xterm-viewport { overflow-y: auto !important; }
        .xterm-screen { height: 100% !important; }
        /* Tablet: Assistant panel overlays instead of pushing */
        @media (max-width: 1024px) {
          .assistant-panel-container {
            position: absolute !important;
            right: 0;
            top: 0;
            bottom: 0;
            z-index: 60;
          }
        }
      `}</style>
    </motion.div>
  );
}
