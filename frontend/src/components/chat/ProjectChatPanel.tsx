/**
 * ProjectChatPanel — Self-contained chat panel for project agents.
 * 
 * Uses shared StreamManager singleton for WebSocket — no per-panel WS connections.
 * Manages its own message state, streaming, tool calls, compaction.
 * Replicates the quality of ChatInterface: markdown, tool pills, status bar, file upload.
 */
import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Bot, X, Trash2, Send, Loader2, ChevronRight, ChevronDown,
  Wrench, Sparkles, StopCircle, Paperclip, Copy, Check, Code2,
  Clock, Mic, MicOff, XCircle, CheckCircle2, RotateCcw
} from 'lucide-react';
import MarkdownRenderer from './MarkdownRenderer';
import client from '../../api/client';
import { gatewayAPI } from '../../api/endpoints';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  extractThinkingChunk,
  mergeAssistantStream,
  mergeThinkingStream,
  sanitizeAssistantContent,
  sanitizeAssistantChunk,
} from '../../utils/chatStream';

import type { ToolCall, ChatMessage, StreamingPhase } from '../../contexts/ChatStateProvider';
import { streamManager } from '../../services/StreamManager';

/* ═══ Types ═══ */

interface ProjectChatPanelProps {
  projectName: string;
  onClose: () => void;
}

interface PendingAttachment {
  id: string;
  file: File;
  name: string;
  size: number;
  type: 'image' | 'text' | 'other';
  previewUrl?: string;
  textContent?: string;
  serverPath?: string;
  uploadStatus?: 'uploading' | 'done' | 'error';
  uploadError?: string;
}

/* ═══ Helpers ═══ */

let msgCounter = 0;
function nextId() {
  return 'pmsg-' + Date.now() + '-' + (++msgCounter);
}

function normalizeHistoricalToolCall(tc: any, fallbackTs: number): ToolCall {
  const startedAt = typeof tc?.startedAt === 'number' ? tc.startedAt : fallbackTs;
  const endedAt = typeof tc?.endedAt === 'number' ? tc.endedAt : undefined;
  const status = tc?.status === 'running' || tc?.status === 'error' ? tc.status : 'done';
  const timingKnown = typeof tc?.startedAt === 'number' && (typeof tc?.endedAt === 'number' || status === 'running');

  return {
    id: tc?.id || nextId(),
    name: tc?.name || 'tool',
    arguments: tc?.arguments,
    startedAt,
    endedAt,
    status,
    timingKnown,
  };
}

function parseHistoryMessage(m: any): ChatMessage {
  const createdAt = new Date(m.timestamp || Date.now());
  const msg: ChatMessage = {
    id: m.id || nextId(),
    role: m.role,
    content: m.role === 'assistant'
      ? sanitizeAssistantContent(m.content || '')
      : (m.content || ''),
    createdAt,
    provenance: m.provenance,
  };
  if (m.toolCalls) {
    msg.toolCalls = m.toolCalls.map((tc: any) => normalizeHistoricalToolCall(tc, createdAt.getTime()));
  }
  if (m.role === 'toolResult') {
    msg.toolCallId = m.toolCallId;
    msg.toolName = m.toolName;
  }
  return msg;
}

function cleanProjectHistory(messages: ChatMessage[]): ChatMessage[] {
  const seenIds = new Set<string>();
  const cleaned: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.id && seenIds.has(msg.id)) continue;
    if (msg.id) seenIds.add(msg.id);

    const content = typeof msg.content === 'string' ? msg.content.trim() : '';
    const hasToolCalls = Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0;
    const hasThinking = typeof msg.thinkingContent === 'string' && msg.thinkingContent.trim().length > 0;

    // Drop pure empty assistant placeholders from history — they add noise but no value.
    if (msg.role === 'assistant' && !content && !hasToolCalls && !hasThinking) {
      continue;
    }

    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.role === 'user' && msg.role === 'user') {
      const prevContent = typeof prev.content === 'string' ? prev.content.trim() : '';
      const samePrompt = prevContent.length > 0 && prevContent === content;
      if (samePrompt) {
        continue;
      }
    }

    cleaned.push(msg);
  }

  return cleaned;
}

/* ═══ Tool Summary ═══ */

function getToolSummary(tool: ToolCall): string {
  const args = tool.arguments;
  if (!args) return tool.name;
  const name = tool.name.toLowerCase();

  if (name === 'read' || name === 'read_file') {
    const p = args.path || args.file_path || args.filePath;
    if (p) return `Read ${String(p).split('/').slice(-2).join('/')}`;
  }
  if (name === 'write' || name === 'write_file') {
    const p = args.path || args.file_path || args.filePath;
    if (p) return `Write ${String(p).split('/').slice(-2).join('/')}`;
  }
  if (name === 'edit' || name === 'edit_file') {
    const p = args.path || args.file_path || args.filePath;
    if (p) return `Edit ${String(p).split('/').slice(-2).join('/')}`;
  }
  if (name === 'exec' || name === 'execute' || name === 'bash' || name === 'shell') {
    const cmd = args.command || args.cmd;
    if (cmd) {
      const short = String(cmd).length > 50 ? String(cmd).substring(0, 47) + '…' : String(cmd);
      return `Run \`${short}\``;
    }
  }
  if (name === 'process') {
    const action = String(args.action || '').toLowerCase();
    if (action === 'poll') return 'Wait for command';
    if (action === 'log') return 'Read command output';
    if (action === 'kill') return 'Stop command';
    if (action === 'list') return 'List commands';
  }
  if (name === 'web_search' || name === 'search') {
    const q = args.query;
    if (q) return `Search "${String(q).substring(0, 40)}"`;
  }
  if (name === 'web_fetch' || name === 'fetch') {
    const u = args.url;
    if (u) { try { return `Fetch ${new URL(String(u)).hostname}`; } catch { return 'Fetch URL'; } }
  }
  if (name === 'image') return 'Analyze image';
  return tool.name;
}

function formatToolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '<1s';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function filterVisibleToolCalls(toolCalls?: ToolCall[]): ToolCall[] {
  return (toolCalls || []).filter((tool) => {
    const action = typeof tool.arguments?.action === 'string' ? tool.arguments.action.toLowerCase() : '';
    return !(tool.name.toLowerCase() === 'process' && action === 'poll' && tool.status !== 'running');
  });
}

/* ═══ Sub-components ═══ */

function ToolCallPill({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const hasDetails = !!(tool.result || tool.arguments);
  const summary = getToolSummary(tool);
  const durationMs = tool.timingKnown === false
    ? null
    : tool.endedAt
      ? Math.max(0, tool.endedAt - tool.startedAt)
      : tool.status === 'running'
        ? Math.max(0, now - tool.startedAt)
        : null;
  const duration = durationMs !== null ? formatToolDuration(durationMs) : null;

  useEffect(() => {
    if (tool.status !== 'running' || tool.timingKnown === false) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [tool.status, tool.startedAt, tool.timingKnown]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
      className="flex justify-center px-2 py-0.5"
    >
      <div className="flex flex-col items-center max-w-sm w-full">
        <button
          onClick={() => hasDetails && setExpanded(!expanded)}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.07] hover:bg-white/[0.07] transition-colors text-[10px] text-slate-400"
        >
          {tool.status === 'running' ? (
            <Loader2 size={10} className="text-amber-400 animate-spin" />
          ) : (
            <Wrench size={10} className="text-emerald-400" />
          )}
          <span className="text-slate-300">{summary}</span>
          {duration && <span className="text-slate-600">· {duration}</span>}
          {hasDetails && (
            <ChevronRight size={9} className={`text-slate-600 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          )}
        </button>
        <AnimatePresence>
          {expanded && hasDetails && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden w-full"
            >
              {tool.arguments && (
                <div className="mt-1 px-2.5 py-2 rounded-xl bg-slate-800/40 border border-white/[0.04] text-[10px] text-slate-400 font-mono leading-relaxed whitespace-pre-wrap max-h-[100px] overflow-y-auto text-left">
                  <span className="text-slate-500 text-[9px] block mb-1">Arguments:</span>
                  {typeof tool.arguments === 'string' ? tool.arguments : JSON.stringify(tool.arguments, null, 2)}
                </div>
              )}
              {tool.result && (
                <div className="mt-1 px-2.5 py-2 rounded-xl bg-black/20 border border-white/[0.04] text-[10px] text-slate-400 font-mono leading-relaxed whitespace-pre-wrap max-h-[100px] overflow-y-auto text-left">
                  <span className="text-slate-500 text-[9px] block mb-1">Result:</span>
                  {tool.result}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function ToolResultPill({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = message.toolName || 'unknown';
  const content = message.content || '';

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
      className="flex justify-center px-2 py-0.5"
    >
      <div className="flex flex-col items-center max-w-sm w-full">
        <button
          onClick={() => content && setExpanded(!expanded)}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/[0.06] border border-emerald-500/[0.10] hover:bg-emerald-500/[0.10] transition-colors text-[10px] text-slate-400"
        >
          <CheckCircle2 size={10} className="text-emerald-400" />
          <span className="text-slate-300">Result: <span className="font-mono">{toolName}</span></span>
          {content && <ChevronRight size={9} className={`text-slate-600 transition-transform ${expanded ? 'rotate-90' : ''}`} />}
        </button>
        <AnimatePresence>
          {expanded && content && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden w-full"
            >
              <div className="mt-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/[0.04] border border-emerald-500/[0.06] text-[10px] text-slate-400 font-mono leading-relaxed whitespace-pre-wrap max-h-[150px] overflow-y-auto text-left">
                {content}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function ThinkingBlock({ content, isActive }: { content?: string; isActive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (isActive) {
      startRef.current = Date.now();
      setElapsed(0);
      const iv = setInterval(() => {
        if (startRef.current) setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }, 1000);
      return () => clearInterval(iv);
    }
    startRef.current = null;
  }, [isActive]);

  if (!isActive && !content) return null;

  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="mb-2">
      <button
        onClick={() => content && !isActive && setExpanded(!expanded)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-violet-500/[0.08] border border-violet-500/[0.15] hover:bg-violet-500/[0.12] transition-colors w-full text-left"
      >
        <div className={isActive ? 'animate-thinking-pulse' : ''}><Sparkles size={12} className="text-violet-400" /></div>
        <span className="text-[10px] text-violet-300 font-medium flex-1">{isActive ? 'Thinking…' : 'Thought process'}</span>
        {isActive && (
          <>
            <span className="text-[10px] text-violet-400/60 font-mono tabular-nums">{elapsed}s</span>
            <span className="flex gap-0.5 ml-1">
              <span className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          </>
        )}
        {content && !isActive && <ChevronRight size={10} className={`text-violet-400 transition-transform ${expanded ? 'rotate-90' : ''}`} />}
      </button>
      <AnimatePresence>
        {expanded && content && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.15 }} className="overflow-hidden">
            <div className="mt-1 px-2.5 py-2 rounded-lg bg-violet-500/[0.04] border border-violet-500/[0.08] text-[10px] text-slate-400 font-mono leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word] max-w-full min-w-0 max-h-[150px] overflow-auto">
              {content}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [text]);

  return (
    <button onClick={handleCopy} className={`p-0.5 rounded transition-all ${copied ? 'text-emerald-400' : 'text-slate-500 hover:text-slate-300'}`} title={copied ? 'Copied!' : 'Copy'}>
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

function AttachmentChip({ attachment, onRemove }: { attachment: PendingAttachment; onRemove: () => void }) {
  const isUploading = attachment.uploadStatus === 'uploading';
  const hasError = attachment.uploadStatus === 'error';
  return (
    <div className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] ${
      hasError ? 'bg-red-500/10 border border-red-500/20 text-red-300' :
      isUploading ? 'bg-amber-500/[0.06] border border-amber-500/15 text-slate-300' :
      'bg-white/[0.06] border border-white/[0.08] text-slate-300'
    }`}>
      {isUploading ? <Loader2 size={10} className="animate-spin text-amber-400" /> : <Paperclip size={10} className="text-slate-400" />}
      <span className="max-w-[80px] truncate">{attachment.name}</span>
      {isUploading ? <span className="text-amber-400/60 text-[8px]">…</span> : null}
      <button onClick={onRemove} className="ml-0.5 text-slate-500 hover:text-slate-200"><X size={9} /></button>
    </div>
  );
}

/* ═══ Model options ═══ */

function modelDisplayName(modelId: string): string {
  const parts = String(modelId || '').split('/');
  if (parts.length >= 3) return parts.slice(1).join('/');
  if (parts.length === 2) return parts[1];
  return modelId || 'Default model';
}

function ModelPickerDropdown({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  if (!open) return null;

  if (isMobile) {
    return createPortal(
      <>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/60 z-[9998]" onClick={onClose} />
        <motion.div initial={{ opacity: 0, y: 100 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 100 }} transition={{ type: 'spring', damping: 25, stiffness: 300 }} className="fixed inset-x-0 bottom-0 z-[9999] px-3 pb-3">
          <div className="rounded-xl bg-[#1A1F3A] border border-white/[0.08] shadow-2xl shadow-black/50 overflow-hidden max-h-[70vh]">
            <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5 border-b border-white/[0.06]">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Select Model</span>
              <button onClick={onClose} className="p-1 rounded-lg text-slate-500 hover:text-slate-300">
                <X size={14} />
              </button>
            </div>
            <div className="overflow-y-auto max-h-[60vh] overscroll-contain">{children}</div>
          </div>
        </motion.div>
      </>,
      document.body,
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }} className="absolute top-full right-0 mt-1 w-64 rounded-xl bg-[#1A1F3A] border border-white/[0.08] shadow-xl shadow-black/40 z-[100]">
      {children}
    </motion.div>
  );
}

function ProjectModelPicker({ value, onChange, models }: { value: string; onChange: (model: string) => void; models: string[] }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 639px)').matches;
    if (isMobile) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  if (models.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] text-[11px] text-slate-400 hover:text-slate-200 transition-colors" title={value || 'Default model'}>
        <Code2 size={13} className="sm:hidden flex-shrink-0" />
        <span className="hidden sm:inline truncate max-w-[140px]">{value ? modelDisplayName(value) : 'Default model'}</span>
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''} hidden sm:block`} />
      </button>
      <ModelPickerDropdown open={open} onClose={() => { setOpen(false); setCustom(false); }}>
        <div className="p-1 max-h-80 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
          <button onClick={() => { onChange(''); setCustom(false); setOpen(false); }} className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs transition-colors ${!value ? 'bg-violet-500/10 text-violet-300' : 'text-slate-300 hover:bg-white/[0.04]'}`}>
            <span className="flex-1 text-left">Default</span>
            {!value && <Check size={12} className="text-violet-400" />}
          </button>
          {models.map((m) => (
            <button key={m} onClick={() => { onChange(m); setCustom(false); setOpen(false); }} className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs transition-colors ${value === m ? 'bg-violet-500/10 text-violet-300' : 'text-slate-300 hover:bg-white/[0.04]'}`}>
              <span className="flex-1 text-left font-mono">{modelDisplayName(m)}</span>
              {value === m && <Check size={12} className="text-violet-400" />}
            </button>
          ))}
          <div className="border-t border-white/[0.06] mt-1 pt-1">
            {custom ? (
              <div className="px-2 py-1">
                <input autoFocus className="w-full bg-black/30 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500/40" placeholder="Custom model name" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(false); }} />
              </div>
            ) : (
              <button onClick={() => setCustom(true)} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-400 hover:bg-white/[0.04] hover:text-slate-200">
                Custom model…
              </button>
            )}
          </div>
        </div>
      </ModelPickerDropdown>
    </div>
  );
}

/* ═══ Main Component ═══ */

export default function ProjectChatPanel({ projectName, onClose }: ProjectChatPanelProps) {
  const isMobile = useIsMobile();

  // Session state
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [streamingPhase, setStreamingPhase] = useState<StreamingPhase>('idle');
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [thinkingContent, setThinkingContent] = useState<string>('');
  const [compactionPhase, setCompactionPhase] = useState<'idle' | 'compacting' | 'compacted'>('idle');
  const compactionPhaseRef = useRef<'idle' | 'compacting' | 'compacted'>('idle');
  const [wsConnected, setWsConnected] = useState(false);

  // Input state
  const [input, setInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftCacheRef = useRef<Map<string, string>>(new Map());
  const attachmentCacheRef = useRef<Map<string, PendingAttachment[]>>(new Map());
  const lastDraftScopeRef = useRef(projectName);

  // Refs
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const connectionUnsubscribeRef = useRef<(() => void) | null>(null);
  const reconnectUnsubscribeRef = useRef<(() => void) | null>(null);
  const streamingAssistantIdRef = useRef<string | null>(null);
  const assembledRef = useRef('');
  const lastSegmentStartRef = useRef(0);
  const lastRawTextLenRef = useRef(0); // Track raw gateway text length for accurate graduation
  const isStreamActiveRef = useRef(false);
  const toolCounterRef = useRef(0);
  const hasRealToolEventsRef = useRef(false);
  const compactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionKeyRef = useRef<string | null>(null);
  const initGenerationRef = useRef(0);
  const modelRef = useRef(selectedModel);
  const [hydratedModelProject, setHydratedModelProject] = useState(projectName);

  // Scroll
  const scrollRef = useRef<HTMLDivElement>(null);
  const isScrolledUp = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  useEffect(() => { sessionKeyRef.current = sessionKey; }, [sessionKey]);
  useEffect(() => { modelRef.current = selectedModel; }, [selectedModel]);

  const resizeComposer = useCallback(() => {
    requestAnimationFrame(() => {
      const t = inputRef.current;
      if (!t) return;
      t.style.height = 'auto';
      t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
    });
  }, []);

  const setProjectDraft = useCallback((value: string, scopeKey: string = projectName) => {
    draftCacheRef.current.set(scopeKey, value);
    setInput(value);
    if (scopeKey === projectName) resizeComposer();
  }, [projectName, resizeComposer]);

  const setProjectAttachments = useCallback((next: PendingAttachment[] | ((prev: PendingAttachment[]) => PendingAttachment[]), scopeKey: string = projectName) => {
    const base = scopeKey === projectName
      ? pendingAttachments
      : (attachmentCacheRef.current.get(scopeKey) || []);
    const resolved = typeof next === 'function'
      ? (next as (prev: PendingAttachment[]) => PendingAttachment[])(base)
      : next;
    attachmentCacheRef.current.set(scopeKey, resolved);
    if (scopeKey === projectName) setPendingAttachments(resolved);
  }, [pendingAttachments, projectName]);

  useEffect(() => {
    const prevScope = lastDraftScopeRef.current;
    if (prevScope === projectName) return;
    draftCacheRef.current.set(prevScope, input);
    attachmentCacheRef.current.set(prevScope, pendingAttachments);
    lastDraftScopeRef.current = projectName;
    setInput(draftCacheRef.current.get(projectName) || '');
    setPendingAttachments(attachmentCacheRef.current.get(projectName) || []);
    resizeComposer();
  }, [input, pendingAttachments, projectName, resizeComposer]);

  // Hydrate per-project model selection before passive init effects run.
  useLayoutEffect(() => {
    setSelectedModel(localStorage.getItem(`agent-model-${projectName}`) || '');
    setHydratedModelProject(projectName);
  }, [projectName]);

  useEffect(() => {
    if (hydratedModelProject !== projectName) return;
    localStorage.setItem(`agent-model-${projectName}`, selectedModel);
  }, [hydratedModelProject, projectName, selectedModel]);

  const loadAvailableModels = useCallback(async () => {
    const data = await gatewayAPI.models();
    const models = Array.isArray(data?.models)
      ? data.models.map((m: any) => String(m?.id || '').trim()).filter(Boolean)
      : [];
    setAvailableModels(models);
    // If no model selected or selected model isn't available, pick the first one
    setSelectedModel(prev => {
      if (prev && models.includes(prev)) return prev;
      return models[0] || prev || '';
    });
    return models;
  }, []);

  useEffect(() => {
    loadAvailableModels().catch((err) => {
      console.error('[ProjectChatPanel] Failed to load models:', err);
    });
  }, [loadAvailableModels]);

  // Only mark the project chat as active when a stream is actually running.
  // This keeps idle chats from auto-reopening and prevents stale "active" state.
  useEffect(() => {
    if (isRunning) {
      localStorage.setItem(`agent-active-${projectName}`, 'true');
    } else {
      localStorage.removeItem(`agent-active-${projectName}`);
    }
  }, [isRunning, projectName]);

  // ── Scroll helpers ──
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const up = dist > 80;
    setShowScrollBtn(up);
    isScrolledUp.current = up;
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    if (!isScrolledUp.current) {
      requestAnimationFrame(() => scrollToBottom(true));
    }
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (isRunning && !isScrolledUp.current) {
      requestAnimationFrame(() => scrollToBottom(false));
    }
  }, [isRunning, scrollToBottom]);

  // ── Watchdog ──
  const STREAM_TIMEOUT_MS = 60_000;

  const resetWatchdog = useCallback(() => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    if (!isStreamActiveRef.current) return;
    watchdogRef.current = setTimeout(() => {
      if (!isStreamActiveRef.current) return;
      console.warn('[ProjectChat] Stream watchdog: no activity for 60s');
      isStreamActiveRef.current = false;
      setIsRunning(false);
      setStreamingPhase('idle');
      setStatusText(null);
      compactionPhaseRef.current = 'idle';
      setCompactionPhase('idle');
      if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
      const cid = streamingAssistantIdRef.current;
      if (cid) {
        const ft = assembledRef.current.substring(lastSegmentStartRef.current);
        if (ft) setMessages(prev => prev.map(m => m.id === cid ? { ...m, content: ft + '\n\n*(stream interrupted)*' } : m));
        streamingAssistantIdRef.current = null;
      }
    }, STREAM_TIMEOUT_MS);
  }, []);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
  }, []);

  const resetChatRuntimeState = useCallback((options?: { clearMessages?: boolean; clearComposer?: boolean }) => {
    clearWatchdog();
    if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
    streamingAssistantIdRef.current = null;
    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = 0;
    isStreamActiveRef.current = false;
    toolCounterRef.current = 0;
    hasRealToolEventsRef.current = false;
    compactionPhaseRef.current = 'idle';
    setIsRunning(false);
    setStreamingPhase('idle');
    setActiveToolName(null);
    setStatusText(null);
    setThinkingContent('');
    setCompactionPhase('idle');
    if (options?.clearMessages !== false) {
      setMessages([]);
    }
    if (options?.clearComposer !== false) {
      draftCacheRef.current.set(projectName, '');
      attachmentCacheRef.current.set(projectName, []);
      setInput('');
      setPendingAttachments([]);
    }
  }, [clearWatchdog, projectName]);

  const applySessionStreamState = useCallback((state: { phase?: string; toolName?: string | null; statusText?: string | null; thinkingContent?: string } | null) => {
    const phase = state?.phase;
    const active = phase === 'thinking' || phase === 'streaming' || phase === 'tool';

    isStreamActiveRef.current = active;
    setIsRunning(active);

    if (!active) {
      setStreamingPhase('idle');
      setActiveToolName(null);
      setStatusText(null);
      return;
    }

    setStreamingPhase(phase === 'tool' ? 'tool' : phase === 'streaming' ? 'streaming' : 'thinking');
    setActiveToolName(state?.toolName || null);
    setStatusText(state?.statusText || (phase === 'tool' && state?.toolName ? `Using ${state.toolName}…` : phase === 'streaming' ? 'Responding…' : 'Thinking…'));
    if (typeof state?.thinkingContent === 'string') {
      setThinkingContent(state.thinkingContent);
    }
  }, []);

  const syncAuthoritativeStreamState = useCallback(async (session: string, options?: { reconnect?: boolean }) => {
    try {
      const { data } = await client.get('/gateway/stream-status', {
        params: { session },
        _silent: true,
      } as any);

      if (!data?.active) {
        resetChatRuntimeState({ clearMessages: false, clearComposer: false });
        return;
      }

      isStreamActiveRef.current = true;
      setIsRunning(true);
      setStreamingPhase(data.phase === 'tool' ? 'tool' : data.phase === 'streaming' ? 'streaming' : 'thinking');
      setActiveToolName(data.toolName || null);
      setStatusText(data.statusText || (data.toolName && data.phase === 'tool' ? `Using ${data.toolName}…` : data.phase === 'streaming' ? 'Responding…' : 'Thinking…'));

      if (typeof data.thinkingContent === 'string') {
        setThinkingContent(data.thinkingContent);
        const thinkingId = streamingAssistantIdRef.current || nextId();
        streamingAssistantIdRef.current = thinkingId;
        setMessages(prev => {
          const idx = prev.findIndex(msg => msg.id === thinkingId);
          if (idx === -1) {
            return [...prev, {
              id: thinkingId,
              role: 'assistant' as const,
              content: '',
              thinkingContent: data.thinkingContent,
              createdAt: new Date(),
              toolCalls: [],
            }];
          }
          const next = [...prev];
          next[idx] = { ...next[idx], thinkingContent: data.thinkingContent };
          return next;
        });
      }

      if (typeof data.content === 'string' && data.content.length > 0) {
        const safeText = sanitizeAssistantContent(data.content);
        assembledRef.current = safeText;
        lastRawTextLenRef.current = safeText.length;

        const assistantId = streamingAssistantIdRef.current || nextId();
        streamingAssistantIdRef.current = assistantId;
        setMessages(prev => {
          const idx = prev.findIndex(msg => msg.id === assistantId);
          if (idx === -1) {
            return [...prev, {
              id: assistantId,
              role: 'assistant' as const,
              content: safeText,
              createdAt: new Date(),
              toolCalls: [],
            }];
          }
          const next = [...prev];
          next[idx] = { ...next[idx], content: safeText };
          return next;
        });
      }

      if (options?.reconnect !== false) {
        streamManager.send({ type: 'reconnect', session, provider: 'OPENCLAW' });
      }

      const staleSession = session;
      setTimeout(async () => {
        if (sessionKeyRef.current !== staleSession || !isStreamActiveRef.current) return;
        try {
          const { data: recheck } = await client.get('/gateway/stream-status', {
            params: { session: staleSession },
            _silent: true,
          } as any);
          if (!recheck?.active && sessionKeyRef.current === staleSession) {
            resetChatRuntimeState({ clearMessages: false, clearComposer: false });
          }
        } catch {
          // Best-effort stale stream cleanup
        }
      }, 8000);
    } catch {
      // Best-effort authoritative check
    }
  }, [resetChatRuntimeState]);

  const appendThinkingChunk = useCallback((assistantId: string | null, chunk: string) => {
    if (!chunk) return;
    setThinkingContent(prev => mergeThinkingStream(prev, chunk));
    if (!assistantId) return;
    setMessages(prev => prev.map(m =>
      m.id === assistantId
        ? { ...m, thinkingContent: mergeThinkingStream(m.thinkingContent || '', chunk) }
        : m
    ));
  }, []);

  // ── WS Event Handler ──
  const handleWsEvent = useCallback((data: any) => {
    const assistantId = streamingAssistantIdRef.current;
    if (!assistantId && !['connected', 'keepalive', 'compaction_start', 'compaction_end', 'stream_resume', 'stream_ended', 'thinking'].includes(data.type)) return;
    resetWatchdog();

    switch (data.type) {
      case 'session': {
        if (data.provenance) {
          // No-op for project chat — we already know the session
        }
        break;
      }
      case 'status': {
        setStatusText(data.content || null);
        // OpenClaw streams thinking separately; keep status out of thought text.
        if (!assembledRef.current) setStreamingPhase('thinking');
        break;
      }
      case 'thinking': {
        appendThinkingChunk(
          assistantId,
          extractThinkingChunk('thinking', data.content, assembledRef.current.length > 0),
        );
        if (!assembledRef.current) setStreamingPhase('thinking');
        break;
      }
      case 'compaction_start': {
        compactionPhaseRef.current = 'compacting';
        setCompactionPhase('compacting');
        setStatusText('Compacting context…');
        if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
        break;
      }
      case 'compaction_end': {
        compactionPhaseRef.current = 'compacted';
        setCompactionPhase('compacted');
        if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
        compactionTimerRef.current = setTimeout(() => { compactionPhaseRef.current = 'idle'; setCompactionPhase('idle'); compactionTimerRef.current = null; }, 3000);
        setStatusText(null);
        break;
      }
      case 'tool_start': {
        hasRealToolEventsRef.current = true;
        const toolName = (data.toolName || data.content || 'tool').replace(/^Using tool:\s*/i, '').replace(/^[^\s]+\s+Using tool:\s*/i, '').trim();
        if (assembledRef.current && assembledRef.current.trim().length > 0) {
          console.log('[CASCADE-DIAG] tool_start graduation:', {
            oldSegStartRef: lastSegmentStartRef.current,
            assembledLen: assembledRef.current.length,
            rawTextLen: lastRawTextLenRef.current,
            newSegStartRef: lastRawTextLenRef.current,
          });
          lastSegmentStartRef.current = lastRawTextLenRef.current;
        }
        setStatusText(data.content || 'Using tool…');
        setStreamingPhase('tool');
        setActiveToolName(toolName);
        const toolId = 'tool-' + (++toolCounterRef.current);
        const toolArgs = data.toolArgs || undefined;
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, toolCalls: [...(m.toolCalls || []), { id: toolId, name: toolName, arguments: toolArgs, startedAt: Date.now(), timingKnown: true, status: 'running' as const }] }
            : m
        ));
        break;
      }
      case 'tool_end': {
        lastSegmentStartRef.current = lastRawTextLenRef.current;
        setStatusText(null);
        setActiveToolName(null);
        const toolResult = data.toolResult || data.content || 'Completed';
        setMessages(prev => prev.map(m => {
          if (m.id !== assistantId) return m;
          const calls = [...(m.toolCalls || [])];
          for (let i = calls.length - 1; i >= 0; i--) {
            if (calls[i].status === 'running') {
              calls[i] = { ...calls[i], endedAt: Date.now(), result: toolResult, status: 'done' };
              break;
            }
          }
          return { ...m, toolCalls: calls };
        }));
        break;
      }
      case 'tool_used': {
        if (hasRealToolEventsRef.current) break;
        const tn = data.content || 'tool';
        setMessages(prev => {
          const exists = prev.some(m =>
            m.role === 'assistant' && (m.toolCalls || []).some(
              tc => tc.status === 'done' && tc.name === tn && tc.endedAt && (Date.now() - tc.endedAt < 5000)
            )
          );
          if (exists) return prev;
          const tid = 'tool-' + (++toolCounterRef.current);
          const now = Date.now();
          return prev.map(m => m.id === assistantId
            ? { ...m, toolCalls: [...(m.toolCalls || []), { id: tid, name: tn, startedAt: now - 1000, endedAt: now, timingKnown: true, status: 'done' as const }] }
            : m
          );
        });
        break;
      }
      case 'toolCall': {
        const tid = 'tool-' + (++toolCounterRef.current);
        setStreamingPhase('tool');
        setActiveToolName(data.name);
        setStatusText('Using tool: ' + data.name);
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, toolCalls: [...(m.toolCalls || []), { id: data.id || tid, name: data.name, arguments: data.arguments, startedAt: Date.now(), timingKnown: true, status: 'running' as const }] }
            : m
        ));
        break;
      }
      case 'toolResult': {
        lastSegmentStartRef.current = lastRawTextLenRef.current;
        setStatusText(null);
        setActiveToolName(null);
        setMessages(prev => prev.map(m => {
          if (m.id !== assistantId) return m;
          const calls = [...(m.toolCalls || [])];
          const idx = calls.findIndex(c => c.id === data.toolCallId || c.name === data.toolName);
          if (idx >= 0) calls[idx] = { ...calls[idx], endedAt: Date.now(), result: data.content, status: 'done' };
          return { ...m, toolCalls: calls };
        }));
        break;
      }
      case 'segment_break': {
        const ct = assembledRef.current.substring(lastSegmentStartRef.current);
        if (ct.trim()) {
          setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: ct } : m));
        }
        const newId = nextId();
        streamingAssistantIdRef.current = newId;
        lastSegmentStartRef.current = lastRawTextLenRef.current;
        setMessages(prev => [...prev, { id: newId, role: 'assistant' as const, content: '', createdAt: new Date() }]);
        break;
      }
      case 'text': {
        const safeChunk = typeof data.content === 'string'
          ? (data.replace === true ? sanitizeAssistantContent(data.content) : sanitizeAssistantChunk(data.content))
          : '';
        const fullText = mergeAssistantStream(assembledRef.current, safeChunk, { replace: data.replace === true });
        lastRawTextLenRef.current = fullText.length;
        const st = fullText.substring(lastSegmentStartRef.current);

        if (thinkingContent && st && st.includes(thinkingContent.slice(0, 50))) {
          console.warn('[CASCADE-DIAG] ⚠️ THINKING LEAK: thinking text found inside text blocks!', {
            thinkingLen: thinkingContent.length,
            textLen: st.length,
            rawTextLen: fullText.length,
          });
        }

        if (lastSegmentStartRef.current > 0 || fullText.length > 500) {
          console.log('[CASCADE-DIAG] delta:', {
            segStartRef: lastSegmentStartRef.current,
            fullTextLen: fullText.length,
            slicedLen: st.length,
            rawTextLen: fullText.length,
            sanitizedLen: safeChunk.length,
            replace: data.replace === true,
          });
        }

        assembledRef.current = fullText;
        setStatusText(null);
        setStreamingPhase('streaming');
        setActiveToolName(null);
        const cid = streamingAssistantIdRef.current;
        setMessages(prev => prev.map(m => m.id === cid ? { ...m, content: st } : m));
        break;
      }
      case 'done': {
        clearWatchdog();
        const fst = assembledRef.current.substring(lastSegmentStartRef.current);
        const hasFinal = typeof data.content === 'string' && data.content.length > 0;
        const finalText = hasFinal ? sanitizeAssistantContent(data.content) : fst;
        const fc = finalText || '';
        const prov = data.provenance || null;
        const cid = streamingAssistantIdRef.current;
        setStatusText(null);
        setStreamingPhase('idle');
        setIsRunning(false);
        if (compactionPhaseRef.current === 'compacting') {
          compactionPhaseRef.current = 'idle';
          setCompactionPhase('idle');
          if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
        }
        isStreamActiveRef.current = false;
        streamingAssistantIdRef.current = null;
        setMessages(prev => prev.map(m =>
          m.id === cid ? { ...m, content: fc, provenance: prov || undefined } : m
        ));
        break;
      }
      case 'error': {
        if (assistantId) {
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, content: '⚠️ ' + (data.content || 'Unknown error') } : m
          ));
        }
        setStatusText(null);
        setStreamingPhase('idle');
        setIsRunning(false);
        isStreamActiveRef.current = false;
        streamingAssistantIdRef.current = null;
        break;
      }
      case 'stream_resume': {
        if (!streamingAssistantIdRef.current) {
          const resumeId = 'stream-resume-' + Date.now();
          streamingAssistantIdRef.current = resumeId;
          assembledRef.current = '';
          isStreamActiveRef.current = true;
          setIsRunning(true);
          setStreamingPhase(data.phase === 'tool' ? 'tool' : data.phase === 'streaming' ? 'streaming' : 'thinking');
          setStatusText(data.statusText || (data.toolName && data.phase === 'tool' ? `Using ${data.toolName}…` : data.phase === 'streaming' ? 'Responding…' : 'Thinking…'));
          setMessages(prev => [...prev, { id: resumeId, role: 'assistant' as const, content: '', thinkingContent: typeof data.thinkingContent === 'string' ? data.thinkingContent : undefined, createdAt: new Date(), toolCalls: [] }]);
        }
        if (typeof data.thinkingContent === 'string') {
          setThinkingContent(data.thinkingContent);
          const cid = streamingAssistantIdRef.current;
          setMessages(prev => prev.map(m => m.id === cid ? { ...m, thinkingContent: data.thinkingContent } : m));
        }
        if (typeof data.content === 'string') {
          const safeChunk = sanitizeAssistantContent(data.content);
          const fullText = mergeAssistantStream(assembledRef.current, safeChunk, { replace: true });
          lastRawTextLenRef.current = fullText.length;
          const st = fullText.substring(lastSegmentStartRef.current);
          if (lastSegmentStartRef.current > 0 || fullText.length > 500) {
            console.log('[CASCADE-DIAG] delta:', {
              segStartRef: lastSegmentStartRef.current,
              fullTextLen: fullText.length,
              slicedLen: st.length,
              rawTextLen: fullText.length,
              sanitizedLen: safeChunk.length,
              replace: true,
            });
          }
          assembledRef.current = fullText;
          const cid = streamingAssistantIdRef.current;
          setMessages(prev => prev.map(m => m.id === cid ? { ...m, content: st } : m));
        }
        break;
      }
      case 'connected':
        setWsConnected(true);
        break;
      case 'stream_ended': {
        clearWatchdog();
        isStreamActiveRef.current = false;
        setIsRunning(false);
        setStreamingPhase('idle');
        setStatusText(null);
        setActiveToolName(null);
        compactionPhaseRef.current = 'idle';
        setCompactionPhase('idle');
        if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
        streamingAssistantIdRef.current = null;
        break;
      }
      case 'keepalive':
        break;
    }
  }, [resetWatchdog, clearWatchdog, appendThinkingChunk, thinkingContent]);

  const handleWsEventRef = useRef(handleWsEvent);
  useEffect(() => { handleWsEventRef.current = handleWsEvent; }, [handleWsEvent]);

  // ── Ensure session + WS setup on mount ──
  useEffect(() => {
    let cancelled = false;
    const initGeneration = ++initGenerationRef.current;

    async function init() {
      try {
        if (hydratedModelProject !== projectName) return;
        resetChatRuntimeState({ clearMessages: false, clearComposer: false });
        setSessionReady(false);
        setSessionError(null);
        setSessionKey(null);
        setAgentId(null);
        sessionKeyRef.current = null;
        setIsLoadingHistory(true);

        // Initialize shared StreamManager and connection tracking before session work
        streamManager.init();
        connectionUnsubscribeRef.current?.();
        connectionUnsubscribeRef.current = streamManager.onConnectionChange((connected) => {
          if (initGenerationRef.current !== initGeneration) return;
          setWsConnected(connected);
        });
        setWsConnected(streamManager.isConnected());

        reconnectUnsubscribeRef.current?.();
        reconnectUnsubscribeRef.current = streamManager.onReconnect(() => {
          if (initGenerationRef.current !== initGeneration) return;
          const liveSession = sessionKeyRef.current;
          if (!liveSession) return;
          void syncAuthoritativeStreamState(liveSession);
        });

        // Ensure session exists
        const { data } = await client.post(`/projects/${projectName}/assistant/ensure-session`, {
          model: selectedModel || undefined,
        });
        if (cancelled || initGenerationRef.current !== initGeneration) return;

        const { sessionKey: sk, agentId: aid, model: m, initialized } = data;
        setSessionKey(sk);
        setAgentId(aid);
        if (m) setSelectedModel(m);

        if (initialized === false) {
          sessionKeyRef.current = sk;
          setSessionReady(true);
          setWsConnected(streamManager.isConnected());

          unsubscribeRef.current?.();
          const { unsubscribe } = streamManager.subscribe(
            sk,
            (event) => handleWsEventRef.current(event),
            (state) => applySessionStreamState(state)
          );
          unsubscribeRef.current = unsubscribe;

          if (cancelled || initGenerationRef.current !== initGeneration) return;
          resetChatRuntimeState({ clearMessages: true, clearComposer: false });
          setSessionError(null);
          setIsLoadingHistory(false);
          return;
        }

        let connected = streamManager.isConnected();
        if (!connected) {
          connected = await new Promise<boolean>((resolve) => {
            const unsub = streamManager.onConnectionChange((nextConnected) => {
              if (nextConnected) {
                unsub();
                resolve(true);
              }
            });
            // Timeout safety — don't wait forever
            setTimeout(() => {
              unsub();
              resolve(streamManager.isConnected());
            }, 5000);
          });
        }

        if (cancelled || initGenerationRef.current !== initGeneration) return;
        setWsConnected(connected);
        if (!connected) {
          throw new Error('Chat connection unavailable');
        }

        setSessionReady(true);
        sessionKeyRef.current = sk;

        unsubscribeRef.current?.();
        const { unsubscribe } = streamManager.subscribe(
          sk,
          (event) => handleWsEventRef.current(event),
          (state) => applySessionStreamState(state)
        );
        unsubscribeRef.current = unsubscribe;

        // Load history via WS after the long-lived subscriber is attached.
        // Empty/new sessions skip this entirely so first-open lands immediately.
        const loaded = await new Promise<ChatMessage[]>((resolve, reject) => {
          const timeout = setTimeout(() => { unsubHist(); reject(new Error('History timeout')); }, 10000);
          const requestId = 'phist-' + Date.now();

          const { unsubscribe: unsubHist } = streamManager.subscribe(
            sk,
            (d) => {
              if (d.type === 'history' && d.requestId === requestId) {
                clearTimeout(timeout);
                unsubHist();
                resolve(((d.messages as any[]) || []).map(parseHistoryMessage));
              } else if (d.type === 'error' && d.requestId === requestId) {
                clearTimeout(timeout);
                unsubHist();
                reject(new Error(d.content as string));
              }
            }
          );

          const sent = streamManager.send({ type: 'history', session: sk, provider: 'OPENCLAW', requestId });
          if (!sent) {
            clearTimeout(timeout);
            unsubHist();
            reject(new Error('Chat connection unavailable'));
          }
        });

        if (cancelled || initGenerationRef.current !== initGeneration) return;
        setMessages(cleanProjectHistory(loaded));

        await syncAuthoritativeStreamState(sk);
        if (cancelled || initGenerationRef.current !== initGeneration) return;
        setSessionError(null);
        setIsLoadingHistory(false);
      } catch (err: any) {
        if (!cancelled && initGenerationRef.current === initGeneration) {
          setSessionError(err.message || 'Failed to initialize session');
          setIsLoadingHistory(false);
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      connectionUnsubscribeRef.current?.();
      connectionUnsubscribeRef.current = null;
      reconnectUnsubscribeRef.current?.();
      reconnectUnsubscribeRef.current = null;
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
    };
  }, [hydratedModelProject, projectName, applySessionStreamState, resetChatRuntimeState, syncAuthoritativeStreamState]);

  // ── Send message ──
  const sendMessage = useCallback(async (text: string): Promise<boolean> => {
    const sk = sessionKeyRef.current;
    if (!sk) return false;

    if (!isStreamActiveRef.current) {
      try {
        const { data } = await client.get('/gateway/stream-status', { params: { session: sk }, _silent: true } as any);
        if (data?.active) {
          isStreamActiveRef.current = true;
          setIsRunning(true);
          setStreamingPhase(data.phase === 'tool' ? 'tool' : data.phase === 'streaming' ? 'streaming' : 'thinking');
          setActiveToolName(data.toolName || null);
          setStatusText(data.statusText || (data.toolName && data.phase === 'tool' ? `Using ${data.toolName}…` : data.phase === 'streaming' ? 'Responding…' : 'Thinking…'));
          if (typeof data.thinkingContent === 'string') setThinkingContent(data.thinkingContent);
          return false;
        }
      } catch {
        // best effort authoritative busy check
      }
    }

    if (isStreamActiveRef.current) return false;

    if (!streamManager.isConnected()) {
      setWsConnected(false);
      setSessionError('Chat connection unavailable. Reconnecting…');
      streamManager.reconnect();
      return false;
    }

    setSessionError(null);

    const userMsg: ChatMessage = { id: nextId(), role: 'user', content: text, createdAt: new Date() };
    const assistantMsgId = nextId();
    const assistantMsg: ChatMessage = { id: assistantMsgId, role: 'assistant' as const, content: '', createdAt: new Date() };
    setMessages(prev => [...prev, userMsg, assistantMsg]);

    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = 0;
    toolCounterRef.current = 0;
    hasRealToolEventsRef.current = false;
    setThinkingContent('');
    setStatusText(null);
    setStreamingPhase('thinking');
    setActiveToolName(null);

    streamingAssistantIdRef.current = assistantMsgId;
    setIsRunning(true);
    isStreamActiveRef.current = true;
    resetWatchdog();

    const sent = streamManager.send({
      type: 'send',
      message: text,
      session: sk,
      provider: 'OPENCLAW',
      agentId: agentId,
      model: modelRef.current,
    });

    if (!sent) {
      clearWatchdog();
      isStreamActiveRef.current = false;
      streamingAssistantIdRef.current = null;
      setIsRunning(false);
      setStreamingPhase('idle');
      setActiveToolName(null);
      setStatusText(null);
      setWsConnected(false);
      setSessionError('Chat connection unavailable. Reconnecting…');
      setMessages(prev => prev.filter(m => m.id !== userMsg.id && m.id !== assistantMsgId));
      streamManager.reconnect();
      return false;
    }

    return true;
  }, [agentId, clearWatchdog, resetWatchdog]);

  // ── Cancel stream ──
  const cancelStream = useCallback(() => {
    const sk = sessionKeyRef.current;
    if (streamManager.isConnected() && sk) {
      streamManager.abort(sk);
    }
    clearWatchdog();
    isStreamActiveRef.current = false;
    setIsRunning(false);
    setStreamingPhase('idle');
    setStatusText(null);
    compactionPhaseRef.current = 'idle';
    setCompactionPhase('idle');
    if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
    const cid = streamingAssistantIdRef.current;
    if (cid) {
      const ft = assembledRef.current.substring(lastSegmentStartRef.current);
      if (ft) setMessages(prev => prev.map(m => m.id === cid ? { ...m, content: ft + '\n\n*(cancelled)*' } : m));
      streamingAssistantIdRef.current = null;
    }
  }, [clearWatchdog]);

  // ── Clear chat ──
  const clearChat = useCallback(async () => {
    try {
      // Close current WS (kill the stream if active)
      if (isStreamActiveRef.current) cancelStream();

      await client.post(`/projects/${projectName}/assistant/reset`);
      setMessages([]);
      setStatusText(null);
      setThinkingContent('');
      setStreamingPhase('idle');
      setIsRunning(false);
      isStreamActiveRef.current = false;
      streamingAssistantIdRef.current = null;
      assembledRef.current = '';
      lastSegmentStartRef.current = 0;
      lastRawTextLenRef.current = 0;

      // Re-ensure session (gets fresh sessionKey after reset)
      const { data } = await client.post(`/projects/${projectName}/assistant/ensure-session`, { model: modelRef.current });
      setSessionKey(data.sessionKey);
      setAgentId(data.agentId);
      sessionKeyRef.current = data.sessionKey;
    } catch (err) {
      console.error('[ProjectChat] Clear error:', err);
    }
  }, [projectName, cancelStream]);

  // ── File upload ──
  const uploadFile = useCallback(async (file: File, attachId: string, scopeKey: string) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const resp = await fetch('/api/files/', { method: 'POST', credentials: 'include', body: formData });
      if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
      const data = await resp.json();
      const serverPath = data.diskPath || `/var/portal-files/uploads/${data.path}`;
      setProjectAttachments(prev => prev.map(a => a.id === attachId ? { ...a, serverPath, uploadStatus: 'done' as const } : a), scopeKey);
    } catch (err: any) {
      setProjectAttachments(prev => prev.map(a => a.id === attachId ? { ...a, uploadStatus: 'error' as const, uploadError: err.message } : a), scopeKey);
    }
  }, [setProjectAttachments]);

  const handleFileSelect = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const scopeKey = projectName;
    const newAttachments: PendingAttachment[] = [];
    for (const file of Array.from(files)) {
      const id = `pattach-${Date.now()}-${Math.random()}`;
      const isImage = file.type.startsWith('image/');
      const isText = file.type.startsWith('text/') || /\.(js|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|css|html|json|yaml|yml|md|sh|bash|toml|ini|env)$/i.test(file.name);
      const att: PendingAttachment = { id, file, name: file.name, size: file.size, type: isImage ? 'image' : isText ? 'text' : 'other' };
      if (isImage) { att.previewUrl = URL.createObjectURL(file); att.uploadStatus = 'uploading'; }
      if (isText && file.size < 100 * 1024) { try { att.textContent = await file.text(); } catch {} }
      else if (!isText) { att.uploadStatus = 'uploading'; }
      newAttachments.push(att);
    }
    setProjectAttachments(prev => [...prev, ...newAttachments], scopeKey);
    for (const att of newAttachments) {
      if (att.uploadStatus === 'uploading') uploadFile(att.file, att.id, scopeKey);
    }
  }, [projectName, setProjectAttachments, uploadFile]);

  const removeAttachment = useCallback((id: string) => {
    setProjectAttachments(prev => {
      const removed = prev.find(a => a.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter(a => a.id !== id);
    });
  }, [setProjectAttachments]);

  // Build attachment text
  const buildAttachmentText = useCallback(() => {
    if (pendingAttachments.length === 0) return '';
    const parts: string[] = [];
    for (const att of pendingAttachments) {
      if (att.type === 'image' && att.serverPath) parts.push(`[Image attached: ${att.name} (server path: ${att.serverPath})]`);
      else if (att.type === 'text' && att.textContent) parts.push(`\`\`\`${att.name}\n${att.textContent}\n\`\`\``);
      else if (att.serverPath) parts.push(`[File attached: ${att.name} (server path: ${att.serverPath})]`);
      else parts.push(`[File attached: ${att.name}]`);
    }
    return parts.join('\n\n') + '\n\n';
  }, [pendingAttachments]);

  // ── Form submit ──
  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isRunning || !sessionReady) return;
    const stillUploading = pendingAttachments.some(a => a.uploadStatus === 'uploading');
    if (stillUploading) return;
    const attachText = buildAttachmentText();
    const fullMessage = attachText + input.trim();
    const sent = await sendMessage(fullMessage);
    if (sent) {
      setProjectDraft('');
      setProjectAttachments([]);
    }
  }, [input, isRunning, sessionReady, pendingAttachments, buildAttachmentText, sendMessage, setProjectAttachments, setProjectDraft]);

  // ── Model change ──
  const handleModelChange = useCallback(async (newModel: string) => {
    setSelectedModel(newModel);
    // Patch the session model
    if (sessionKeyRef.current) {
      try {
        await client.post(`/projects/${projectName}/assistant/ensure-session`, { model: newModel });
      } catch {}
    }
  }, [projectName]);

  // ── Speech recognition ──
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const SpeechRecognition = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
  const speechSupported = !!SpeechRecognition;

  const toggleMic = useCallback(() => {
    if (!SpeechRecognition) return;
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    } else {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event: any) => {
        const transcript = Array.from(event.results).map((r: any) => r[0].transcript).join('');
        setProjectDraft(transcript);
      };
      recognition.onerror = () => setIsListening(false);
      recognition.onend = () => setIsListening(false);
      recognition.start();
      recognitionRef.current = recognition;
      setIsListening(true);
    }
  }, [SpeechRecognition, isListening, setProjectDraft]);

  // Cleanup recognition on unmount
  useEffect(() => {
    return () => { recognitionRef.current?.stop(); };
  }, []);

  // ── Drag & drop ──
  const [dragOver, setDragOver] = useState(false);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFileSelect(e.dataTransfer.files);
  }, [handleFileSelect]);

  // ── Render ──
  return (
    <motion.div
      initial={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
      animate={isMobile ? { opacity: 1, x: 0 } : { width: 448, opacity: 1 }}
      exit={isMobile ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
      transition={{ duration: 0.15 }}
      className={isMobile
        ? 'fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#080B20]/98 backdrop-blur-sm'
        : 'border-l border-white/5 flex flex-col overflow-hidden flex-shrink-0 bg-[#080B20]/95 backdrop-blur-sm'}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 flex-shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Bot size={14} className="text-emerald-400 flex-shrink-0" />
          <span className="text-xs font-medium text-white flex-shrink-0">Agent</span>
          <span className="text-[10px] text-slate-500 truncate" title={projectName}>{projectName}</span>
          <span className={`text-[8px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${wsConnected ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}>
            {wsConnected ? '●' : '○'}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Model selector */}
          <ProjectModelPicker
            value={selectedModel}
            onChange={handleModelChange}
            models={availableModels}
          />
          {/* Clear chat */}
          {messages.length > 0 && (
            <button onClick={clearChat} className="p-1 rounded hover:bg-white/5 text-slate-600 hover:text-amber-400 transition-colors" title="Clear chat">
              <Trash2 size={11} />
            </button>
          )}
          {/* Close */}
          <button onClick={onClose} className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-white transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Drag overlay */}
      <AnimatePresence>
        {dragOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-violet-500/10 backdrop-blur-sm border-2 border-dashed border-violet-500/40 rounded-lg"
          >
            <div className="text-sm text-violet-300 font-medium">Drop files here</div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Session error */}
      {sessionError && (
        <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/20 text-[11px] text-red-400 flex items-center gap-2">
          <XCircle size={12} />
          <span>{sessionError}</span>
        </div>
      )}

      {/* Compaction indicator */}
      <AnimatePresence>
        {compactionPhase !== 'idle' && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="flex justify-center py-1 border-b border-blue-500/10"
          >
            {compactionPhase === 'compacting' ? (
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/[0.08] border border-blue-500/20 text-blue-300 text-[10px] font-medium">
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                Compacting context…
              </div>
            ) : (
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/[0.08] border border-emerald-500/20 text-emerald-300 text-[10px] font-medium">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Context compaction successful
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-auto relative" onScroll={handleScroll}>
        {isLoadingHistory && messages.length > 0 && (
          <div className="absolute top-3 inset-x-0 z-10 flex justify-center pointer-events-none px-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-slate-950/85 backdrop-blur px-3 py-1 text-[10px] text-slate-300 shadow-lg shadow-black/20">
              <Loader2 size={10} className="animate-spin text-emerald-400" />
              <span>Loading <span className="font-medium text-slate-200">{projectName}</span> chat… keeping previous context visible</span>
            </div>
          </div>
        )}
        {isLoadingHistory && messages.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={18} className="animate-spin text-slate-500" />
            <span className="ml-2 text-xs text-slate-500">Loading history…</span>
          </div>
        ) : messages.length === 0 && !isRunning ? (
          <div className="text-center py-12 px-4">
            <Bot size={28} className="mx-auto mb-2 text-emerald-400/30" />
            <p className="text-xs text-slate-500 mb-1">Ask Agent about <strong className="text-slate-400">{projectName}</strong></p>
            <p className="text-[10px] text-slate-600">WebSocket streaming • Tool calls • File uploads</p>
          </div>
        ) : (
          <div className="py-2 space-y-0.5">
            {messages.map((msg, idx) => {
              const isLast = idx === messages.length - 1;
              const isCurrentlyStreaming = isLast && isRunning && msg.role === 'assistant';

              if (msg.role === 'user') {
                return (
                  <div key={msg.id} className="flex justify-end px-3 py-1.5 group">
                    <div className="max-w-[85%]">
                      <div className="rounded-2xl rounded-br-sm bg-blue-600/90 px-3 py-2 shadow-lg shadow-blue-600/10">
                        <p className="text-[11px] text-white leading-relaxed whitespace-pre-wrap break-words">{msg.content}</p>
                      </div>
                    </div>
                  </div>
                );
              }

              if (msg.role === 'toolResult') {
                return <ToolResultPill key={msg.id} message={msg} />;
              }

              if (msg.role === 'assistant') {
                const toolCalls = filterVisibleToolCalls(msg.toolCalls);
                const hasContent = !!msg.content;
                const thinkingContent = msg.thinkingContent;

                return (
                  <div key={msg.id} className="px-3 py-1.5">
                    {/* Thinking block — keep visible during active runs so reconnects/device switches still feel alive. */}
                    <AnimatePresence>
                      {thinkingContent && (
                        <ThinkingBlock content={thinkingContent} isActive={isCurrentlyStreaming} />
                      )}
                    </AnimatePresence>

                    {/* Tool call pills */}
                    {toolCalls.length > 0 && (
                      <div className="mb-1">
                        {toolCalls.map(tc => <ToolCallPill key={tc.id} tool={tc} />)}
                      </div>
                    )}

                    {/* Message content */}
                    {(hasContent || isCurrentlyStreaming) && (
                      <div className="flex gap-2 items-start">
                        <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5 text-[8px] font-bold text-emerald-400">
                          AI
                        </div>
                        <div className="flex-1 min-w-0 max-w-[90%]">
                          <div
                            className={`rounded-2xl rounded-bl-sm px-3 py-2 transition-all duration-500 ${
                              hasContent && msg.content.startsWith('⚠️')
                                ? 'bg-red-500/10 border border-red-500/20'
                                : isCurrentlyStreaming
                                  ? 'border border-dashed bg-[var(--accent-bg-subtle)]'
                                  : 'bg-white/[0.06] border border-solid border-white/[0.08]'
                            }`}
                            style={isCurrentlyStreaming && !(hasContent && msg.content.startsWith('⚠️'))
                              ? { borderColor: 'var(--accent-border-hover)', boxShadow: '0 0 12px var(--accent-shadow), inset 0 0 0 1px var(--accent-bg)' }
                              : undefined
                            }
                          >
                            {hasContent && msg.content.startsWith('⚠️') ? (
                              <div className="flex items-start gap-1.5">
                                <XCircle size={12} className="text-red-400 flex-shrink-0 mt-0.5" />
                                <div className="text-[11px] text-red-300">{msg.content.replace(/^⚠️\s*/, '')}</div>
                              </div>
                            ) : (
                              <>
                                <div
                                  className={`flex items-center gap-1.5 mb-1 transition-all duration-300 overflow-hidden ${
                                    isCurrentlyStreaming ? 'max-h-5 opacity-100' : 'max-h-0 opacity-0 pointer-events-none'
                                  }`}
                                  aria-hidden={!isCurrentlyStreaming}
                                >
                                  <span className="text-[9px] font-medium tracking-wide uppercase" style={{ color: 'var(--accent-light)', opacity: 0.7 }}>thinking</span>
                                  <span className="w-1 h-1 rounded-full animate-pulse" style={{ backgroundColor: 'var(--accent-light)', opacity: 0.5 }} />
                                </div>
                                <div className={`text-[11px] leading-relaxed ${isCurrentlyStreaming ? 'streaming-cursor' : ''}`}>
                                  <MarkdownRenderer content={msg.content} isStreaming={isCurrentlyStreaming} />
                                </div>
                              </>
                            )}
                          </div>
                          {/* Actions */}
                          <div className="flex items-center gap-1 mt-0.5 ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {hasContent && <CopyButton text={msg.content} />}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Loading indicator removed — the unified bubble above now handles empty streaming state via the "thinking" label */}
                  </div>
                );
              }

              return null;
            })}
            <div className="h-2" />
          </div>
        )}
      </div>

      {/* Scroll to bottom */}
      <AnimatePresence>
        {showScrollBtn && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            className="absolute bottom-[80px] left-1/2 -translate-x-1/2 z-10"
          >
            <button
              onClick={() => { isScrolledUp.current = false; scrollToBottom(true); }}
              className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-[#1A1F3A] border border-white/[0.10] text-[10px] text-slate-300 hover:text-white hover:bg-[#252B4A] transition-colors shadow-lg"
            >
              <ChevronDown size={12} />
              <span>Scroll down</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Pinned status bar */}
      <AnimatePresence>
        {isRunning && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex items-center justify-center gap-2 px-3 py-1.5 bg-violet-500/[0.06] border-t border-violet-500/[0.12]">
              <div className="flex gap-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="text-[10px] text-violet-300/80 font-medium">
                {statusText || (streamingPhase === 'tool' ? `Using ${activeToolName || 'tool'}…` : streamingPhase === 'streaming' ? 'Responding…' : 'Thinking…')}
              </span>
              <button
                onClick={cancelStream}
                className="ml-2 p-1 rounded hover:bg-red-500/20 text-red-400/60 hover:text-red-400 transition-colors"
                title="Stop generation"
              >
                <StopCircle size={12} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Composer */}
      <div className={`border-t transition-colors duration-300 flex-shrink-0 ${
        isRunning ? 'border-amber-500/20 bg-[#0a0a14]/50' : 'border-white/5 bg-[#0a0a14]/30'
      }`}>
        <div className="px-3 pt-2 pb-3">
          {/* Attachment chips */}
          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {pendingAttachments.map(att => (
                <AttachmentChip key={att.id} attachment={att} onRemove={() => removeAttachment(att.id)} />
              ))}
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex items-end gap-1.5">
            {/* Attach button */}
            {!isRunning && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex-shrink-0 p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] transition-colors"
                title="Attach file"
              >
                <Paperclip size={14} />
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={e => handleFileSelect(e.target.files)}
            />

            {/* Text input */}
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setProjectDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e as any);
                }
              }}
              placeholder={isRunning ? 'Agent is responding…' : `Message Agent…`}
              disabled={isRunning || !sessionReady}
              className={`flex-1 resize-none rounded-xl px-3 py-2 text-[11px] placeholder-slate-600 focus:outline-none transition-all min-h-[36px] max-h-[120px] overflow-y-auto ${
                isRunning
                  ? 'bg-amber-500/[0.04] border border-amber-500/15 text-slate-500 cursor-not-allowed'
                  : 'bg-white/[0.06] border border-white/[0.08] text-white focus:ring-1 focus:ring-emerald-500/30'
              }`}
              rows={1}
              onInput={e => {
                const t = e.currentTarget;
                t.style.height = 'auto';
                t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
              }}
            />

            {/* Mic button */}
            {speechSupported && (
              <button
                type="button"
                onClick={toggleMic}
                className={`flex-shrink-0 p-2 rounded-lg transition-all ${
                  isListening ? 'bg-red-500/20 text-red-400 animate-pulse' : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.06]'
                }`}
                title={isListening ? 'Stop recording' : 'Dictate'}
              >
                {isListening ? <MicOff size={13} /> : <Mic size={13} />}
              </button>
            )}

            {/* Send / Stop button */}
            {isRunning ? (
              <button
                type="button"
                onClick={cancelStream}
                className="flex-shrink-0 p-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors border border-red-500/20"
              >
                <StopCircle size={14} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() || !sessionReady || pendingAttachments.some(a => a.uploadStatus === 'uploading')}
                className="flex-shrink-0 p-2 rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <Send size={14} />
              </button>
            )}
          </form>
        </div>
      </div>
    </motion.div>
  );
}
