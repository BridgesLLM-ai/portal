/**
 * ProjectChatPanel — Self-contained chat panel for project agents.
 * 
 * Has its OWN WebSocket connection (not shared with ChatStateProvider singleton).
 * Manages its own message state, streaming, tool calls, compaction.
 * Replicates the quality of ChatInterface: markdown, tool pills, status bar, file upload.
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Bot, X, Trash2, Send, Loader2, ChevronRight, ChevronDown,
  Wrench, Sparkles, StopCircle, Paperclip, Copy, Check, Code2, Radio,
  Mic, MicOff, XCircle, CheckCircle2, RotateCcw
} from 'lucide-react';
import MarkdownRenderer from './MarkdownRenderer';
import SlashCommandMenu from './SlashCommandMenu';
import { ExecApprovalModal } from './ExecApprovalModal';
import client from '../../api/client';
import { authAPI } from '../../api/auth';
import { gatewayAPI, projectsAPI } from '../../api/endpoints';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  extractThinkingChunk,
  isControlOnlyAssistantContent,
  mergeAssistantStream,
  mergeThinkingStream,
  sanitizeAssistantContent,
  sanitizeAssistantChunk,
  stripOpenClawReplyTags,
} from '../../utils/chatStream';
import {
  canonicalizePortalModelId,
  getModelDisplayName,
  getModelIdBadge,
  getModelProviderLabel,
  getModelRuntimeLabel,
  normalizeModelId,
} from '../../utils/modelId';
import { matchSlashCommands, parseSlashCommand, type SlashCommand } from '../../utils/slashCommands';
import ComposerStatusBadge from './ComposerStatusBadge';
import CompactionNoticeBlock from './CompactionNoticeBlock';
import ToolGlyph from './ToolGlyph';
import { getToolPresentation, getToolStatusText, getToolSummary, isCompactionNotice, resolveToolName } from '../../utils/toolPresentation';
import {
  pruneExpiredExecApprovals,
  removeExecApproval,
  upsertExecApproval,
} from '../../utils/execApprovalQueue';

import type { ToolCall, ChatMessage, StreamingPhase, ExecApprovalRequest } from '../../contexts/ChatStateProvider';

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
  fileId?: string;
  serverPath?: string;
  toolUrl?: string;
  uploadStatus?: 'uploading' | 'done' | 'error';
  uploadError?: string;
}

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive';

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive'];
const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
  adaptive: 'Adaptive',
};

const OPENCLAW_FAST_MODE_MODELS = new Set([
  'openai/gpt-5.4',
  'openai-codex/gpt-5.4',
]);

function supportsOpenClawFastModeModel(model?: string | null): boolean {
  const normalized = String(model || '').trim().toLowerCase();
  return OPENCLAW_FAST_MODE_MODELS.has(normalized);
}

/* ═══ WS Manager (local, not shared) ═══ */

type WsEventHandler = (data: any) => void;

interface LocalWsManager {
  send: (data: any) => boolean;
  addHandler: (handler: WsEventHandler) => void;
  removeHandler: (handler: WsEventHandler) => void;
  onDisconnect: (cb: () => void) => (() => void);
  onReconnect: (cb: () => void) => (() => void);
  isConnected: () => boolean;
  reconnect: () => void;
  close: () => void;
}

function createLocalWsManager(url: string): LocalWsManager {
  let ws: WebSocket | null = null;
  let intentionallyClosed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let wasConnectedBefore = false;
  const handlers = new Set<WsEventHandler>();
  const disconnectCallbacks = new Set<() => void>();
  const reconnectCallbacks = new Set<() => void>();

  function connect() {
    if (intentionallyClosed) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      const isReconnect = wasConnectedBefore;
      wasConnectedBefore = true;
      reconnectAttempts = 0;
      if (isReconnect) {
        for (const cb of reconnectCallbacks) {
          try { cb(); } catch (err) { console.error('[project-ws] reconnect callback error:', err); }
        }
      }
    };

    ws.onmessage = (event) => {
      let data: any;
      try { data = JSON.parse(event.data); } catch { return; }
      for (const handler of handlers) {
        try { handler(data); } catch (err) { console.error('[project-ws] Handler error:', err); }
      }
    };

    ws.onclose = (event) => {
      ws = null;

      const isAuthFailure = event.code === 4001 || event.code === 4003 ||
        event.reason?.toLowerCase().includes('unauthorized') ||
        event.reason?.toLowerCase().includes('forbidden') ||
        event.reason?.toLowerCase().includes('expired');

      if (isAuthFailure && !intentionallyClosed) {
        authAPI.refresh()
          .then(() => {
            reconnectAttempts = 0;
            scheduleReconnect();
          })
          .catch((err) => {
            console.warn('[project-ws] token refresh failed, stopping reconnect:', err);
            intentionallyClosed = true;
            for (const cb of disconnectCallbacks) {
              try { cb(); } catch (callbackErr) { console.error('[project-ws] disconnect callback error:', callbackErr); }
            }
          });
        return;
      }

      if (!intentionallyClosed) {
        for (const cb of disconnectCallbacks) {
          try { cb(); } catch (err) { console.error('[project-ws] disconnect callback error:', err); }
        }
        scheduleReconnect();
      }
    };

    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    if (reconnectTimer || intentionallyClosed) return;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  connect();

  return {
    send(data: any): boolean {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      try { ws.send(JSON.stringify(data)); return true; } catch { return false; }
    },
    addHandler(handler: WsEventHandler) { handlers.add(handler); },
    removeHandler(handler: WsEventHandler) { handlers.delete(handler); },
    onDisconnect(cb: () => void) {
      disconnectCallbacks.add(cb);
      return () => { disconnectCallbacks.delete(cb); };
    },
    onReconnect(cb: () => void) {
      reconnectCallbacks.add(cb);
      return () => { reconnectCallbacks.delete(cb); };
    },
    isConnected() { return ws !== null && ws.readyState === WebSocket.OPEN; },
    reconnect() {
      intentionallyClosed = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) {
        try { ws.close(); } catch {}
        ws = null;
      }
      connect();
    },
    close() {
      intentionallyClosed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { try { ws.close(); } catch {} ws = null; }
      handlers.clear();
      disconnectCallbacks.clear();
      reconnectCallbacks.clear();
    },
  };
}

function getWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const apiUrl = import.meta.env.VITE_API_URL || '';
  if (apiUrl) {
    if (apiUrl.startsWith('http')) {
      return apiUrl.replace(/^http/, 'ws') + '/gateway/ws';
    }
    return protocol + '//' + window.location.host + apiUrl + '/gateway/ws';
  }
  return protocol + '//' + window.location.host + '/api/gateway/ws';
}

/* ═══ Helpers ═══ */

let msgCounter = 0;
const CHAT_HISTORY_OMITTED_PLACEHOLDER = '[chat.history omitted: message too large]';
const HISTORY_ENVELOPE_TIMESTAMP_RE = /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+[A-Z]{2,4}\]\s*/;

function nextId() {
  return 'pmsg-' + Date.now() + '-' + (++msgCounter);
}

function stripHistoryEnvelope(text: string): string {
  if (!text) return text;
  const match = text.match(HISTORY_ENVELOPE_TIMESTAMP_RE);
  if (match && match.index !== undefined) {
    const beforeTimestamp = text.substring(0, match.index);
    if (
      beforeTimestamp.includes('Conversation info (untrusted metadata)')
      || beforeTimestamp.includes('Sender (untrusted metadata)')
    ) {
      return text.substring(match.index + match[0].length).trim();
    }
  }
  return text;
}

function sanitizeHistoryMessageText(text: string): string {
  return stripOpenClawReplyTags(stripHistoryEnvelope(text || ''))
    .replace(/\r\n/g, '\n')
    .trim();
}

function isHiddenHistoryArtifactText(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;

  return [
    /^System \(untrusted\):/i,
    /^An async command you ran earlier has completed\./i,
    /^Read HEARTBEAT\.md if it exists/i,
    /^HEARTBEAT_OK$/i,
    /<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>/i,
    /Handle the result internally\./i,
    /Sender \(untrusted metadata\):/i,
    /Conversation info \(untrusted metadata\):/i,
  ].some((pattern) => pattern.test(normalized));
}

function summarizeHiddenHistoryArtifactText(text: string): string | null {
  const normalized = String(text || '').trim();
  if (!normalized) return null;

  if (/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>/i.test(normalized) && /\[Internal task completion event\]/i.test(normalized)) {
    const sourceMatch = normalized.match(/^source:\s*(.+)$/im);
    const source = sourceMatch?.[1]?.trim().toLowerCase() || '';
    if (source === 'subagent') return 'Delegated task completed';
    if (source) return 'Background task completed';
    return 'Background work completed';
  }

  if (/^An async command you ran earlier has completed\./i.test(normalized)) {
    return 'Earlier async command completed';
  }

  return null;
}

function getLastRunningToolCall(toolCalls: ToolCall[] | undefined): ToolCall | null {
  if (!Array.isArray(toolCalls)) return null;
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    if (toolCalls[i]?.status === 'running') return toolCalls[i];
  }
  return null;
}

function parseHistoryMessage(m: any): ChatMessage | null {
  const rawContent = typeof m.content === 'string' ? m.content : '';
  const sanitizedHistoryText = sanitizeHistoryMessageText(rawContent);
  const rawThinkingContent = typeof m.thinkingContent === 'string' ? sanitizeAssistantContent(m.thinkingContent) : '';
  const isTruncationPlaceholder = m.role === 'assistant' && rawContent === CHAT_HISTORY_OMITTED_PLACEHOLDER;
  if (m.role === 'assistant' && !isTruncationPlaceholder && isControlOnlyAssistantContent(rawContent) && !rawThinkingContent && !(Array.isArray(m.toolCalls) && m.toolCalls.length > 0)) {
    return null;
  }
  if (m.role === 'assistant' && !isTruncationPlaceholder && isHiddenHistoryArtifactText(sanitizedHistoryText) && !rawThinkingContent && !(Array.isArray(m.toolCalls) && m.toolCalls.length > 0)) {
    return null;
  }
  if ((m.role === 'user' || m.role === 'system') && isHiddenHistoryArtifactText(sanitizedHistoryText)) {
    const summary = summarizeHiddenHistoryArtifactText(sanitizedHistoryText);
    if (!summary) return null;
    return {
      id: m.id || nextId(),
      role: 'system',
      content: summary,
      createdAt: new Date(m.timestamp || Date.now()),
      provenance: 'hidden-history-artifact',
    };
  }

  const msg: ChatMessage = {
    id: m.id || nextId(),
    role: isTruncationPlaceholder ? 'system' : m.role,
    content: isTruncationPlaceholder
      ? 'Earlier assistant output was omitted from history because the message was too large.'
      : (m.role === 'assistant' ? sanitizeAssistantContent(rawContent) : sanitizedHistoryText),
    createdAt: new Date(m.timestamp || Date.now()),
    provenance: m.provenance || ((m.__openclaw?.kind === 'compaction' || isCompactionNotice(sanitizedHistoryText)) ? 'compaction' : undefined),
    model: typeof m.model === 'string' ? m.model : undefined,
    thinkingContent: rawThinkingContent || undefined,
  };
  if (m.toolCalls) {
    msg.toolCalls = m.toolCalls.map((tc: any) => ({
      id: tc.id || nextId(),
      name: tc.name,
      arguments: tc.arguments,
      startedAt: Date.now(),
      endedAt: Date.now(),
      status: 'done' as const,
    }));
  }
  if (Array.isArray(m.segments)) {
    msg.segments = m.segments;
  }
  if (m.role === 'toolResult') {
    msg.toolCallId = m.toolCallId;
    msg.toolName = m.toolName;
  }
  return msg;
}

const HISTORY_REPLAY_DUPLICATE_WINDOW_MS = 5_000;

function normalizeHistoryReplayContent(content: string): string {
  return (content || '').replace(/\r\n/g, '\n').trim();
}

function isEquivalentCompactionNotice(previous: ChatMessage | undefined, next: ChatMessage): boolean {
  if (!previous || previous.role !== 'system' || next.role !== 'system') return false;
  if (!(previous.provenance === 'compaction' || next.provenance === 'compaction')) return false;
  if (!isCompactionNotice(previous.content) || !isCompactionNotice(next.content)) return false;

  const previousContent = normalizeHistoryReplayContent(previous.content);
  const nextContent = normalizeHistoryReplayContent(next.content);
  if (!previousContent || previousContent !== nextContent) return false;

  const previousTs = previous.createdAt instanceof Date ? previous.createdAt.getTime() : NaN;
  const nextTs = next.createdAt instanceof Date ? next.createdAt.getTime() : NaN;
  return Number.isFinite(previousTs) && Number.isFinite(nextTs) && Math.abs(nextTs - previousTs) <= 30_000;
}

function dedupeHistoryMessages(messages: ChatMessage[]): ChatMessage[] {
  const deduped: ChatMessage[] = [];
  for (const msg of messages) {
    const previous = deduped[deduped.length - 1];
    if (!previous || previous.role !== 'user' || msg.role !== 'user') {
      if (isEquivalentCompactionNotice(previous, msg)) continue;
      deduped.push(msg);
      continue;
    }

    const previousContent = normalizeHistoryReplayContent(previous.content);
    const nextContent = normalizeHistoryReplayContent(msg.content);
    const previousTs = previous.createdAt instanceof Date ? previous.createdAt.getTime() : NaN;
    const nextTs = msg.createdAt instanceof Date ? msg.createdAt.getTime() : NaN;

    const isReplayDuplicate = Boolean(previousContent)
      && previousContent === nextContent
      && Number.isFinite(previousTs)
      && Number.isFinite(nextTs)
      && nextTs >= previousTs
      && (nextTs - previousTs) <= HISTORY_REPLAY_DUPLICATE_WINDOW_MS;

    if (!isReplayDuplicate) deduped.push(msg);
  }
  return deduped;
}

/* ═══ Sub-components ═══ */

function ToolCallPill({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const duration = tool.endedAt ? ((tool.endedAt - tool.startedAt) / 1000).toFixed(1) : null;
  const hasDetails = !!(tool.result || tool.arguments);
  const summary = getToolSummary(tool);
  const presentation = getToolPresentation(tool.name);

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
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border transition-colors text-[10px] text-slate-400 ${presentation.surfaceClass}`}
        >
          <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full border ${presentation.iconBadgeClass}`}>
            <ToolGlyph toolName={tool.name} size={10} className={presentation.iconClass} />
          </span>
          <span className="text-slate-200">{summary}</span>
          {tool.status === 'running' ? (
            <Loader2 size={9} className={`animate-spin ${presentation.iconClass}`} />
          ) : null}
          {duration && <span className="text-slate-500">· {duration}s</span>}
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
                <div className="mt-1 px-2.5 py-1.5 rounded-lg bg-slate-800/40 border border-white/[0.04] text-[10px] text-slate-400 font-mono leading-relaxed whitespace-pre-wrap max-h-[100px] overflow-y-auto text-left">
                  <span className="text-slate-500 text-[9px] block mb-0.5">Args:</span>
                  {typeof tool.arguments === 'string' ? tool.arguments : JSON.stringify(tool.arguments, null, 2)}
                </div>
              )}
              {tool.result && (
                <div className="mt-1 px-2.5 py-1.5 rounded-lg bg-black/20 border border-white/[0.04] text-[10px] text-slate-400 font-mono leading-relaxed whitespace-pre-wrap max-h-[100px] overflow-y-auto text-left">
                  <span className="text-slate-500 text-[9px] block mb-0.5">Result:</span>
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
  return getModelDisplayName(modelId, 'Default model');
}

function ModelMeta({ modelId, compact = false }: { modelId: string; compact?: boolean }) {
  const provider = getModelProviderLabel(modelId);
  const runtime = getModelRuntimeLabel(modelId);
  const canonicalId = getModelIdBadge(modelId);

  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={`${compact ? 'text-[11px]' : 'text-xs'} font-medium text-left truncate`}>{modelDisplayName(modelId)}</span>
        {!compact && provider ? <span className="px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-300 text-[9px] uppercase tracking-wide">{provider}</span> : null}
        {!compact && runtime ? <span className="px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-300 text-[9px] uppercase tracking-wide">{runtime}</span> : null}
      </div>
      {!compact && canonicalId ? <div className="mt-0.5 text-[10px] text-slate-500 font-mono truncate">{canonicalId}</div> : null}
    </div>
  );
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
        <div className="hidden sm:flex items-center gap-1.5 min-w-0 max-w-[220px]">
          {value ? <ModelMeta modelId={value} compact /> : <span className="truncate max-w-[140px]">Default model</span>}
        </div>
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
              <ModelMeta modelId={m} />
              {value === m && <Check size={12} className="text-violet-400 flex-shrink-0" />}
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
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    canonicalizePortalModelId(localStorage.getItem(`agent-model-${projectName}`) || '')
  );
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [streamingPhase, setStreamingPhase] = useState<StreamingPhase>('idle');
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [thinkingContent, setThinkingContent] = useState<string>('');
  const thinkingContentRef = useRef('');
  useEffect(() => { thinkingContentRef.current = thinkingContent; }, [thinkingContent]);
  const [pendingApprovals, setPendingApprovals] = useState<ExecApprovalRequest[]>([]);
  const pendingApproval = pendingApprovals[0] || null;
  const [compactionPhase, setCompactionPhase] = useState<'idle' | 'compacting' | 'compacted'>('idle');
  const compactionPhaseRef = useRef<'idle' | 'compacting' | 'compacted'>('idle');
  const [wsConnected, setWsConnected] = useState(false);

  // Input state
  const [input, setInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [showSessionControls, setShowSessionControls] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('high');
  const [fastModeEnabled, setFastModeEnabled] = useState(false);
  const [thinkingPending, setThinkingPending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Refs
  const wsRef = useRef<LocalWsManager | null>(null);
  const streamingAssistantIdRef = useRef<string | null>(null);
  const assembledRef = useRef('');
  const lastSegmentStartRef = useRef(0);
  const lastRawTextLenRef = useRef(0); // Track raw gateway text length for accurate graduation
  const resumeSeededContentRef = useRef(false);
  const suppressLiveBubbleContentRef = useRef(false);
  const isStreamActiveRef = useRef(false);
  const toolCounterRef = useRef(0);
  const hasRealToolEventsRef = useRef(false);
  const compactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionKeyRef = useRef<string | null>(null);
  const historyGenRef = useRef(0);
  const modelRef = useRef(selectedModel);
  const pendingAutoCommitRef = useRef(false);

  useEffect(() => {
    const activeAssistantId = streamingAssistantIdRef.current;
    if (!activeAssistantId || streamingPhase !== 'tool') return;
    const activeMessage = messages.find((message) => message.id === activeAssistantId);
    const runningToolCall = getLastRunningToolCall(activeMessage?.toolCalls);
    if (runningToolCall?.name) {
      const runningToolName = resolveToolName(runningToolCall.name);
      if (runningToolName && runningToolName !== activeToolName) {
        setActiveToolName(runningToolName);
      }
    }
  }, [messages, streamingPhase, activeToolName]);

  const appendSystemNotice = useCallback((content: string, provenance?: string) => {
    const now = Date.now();
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last?.role === 'system' && last.content === content && now - last.createdAt.getTime() < 4000) {
        return prev;
      }
      return [...prev, { id: nextId(), role: 'system', content, createdAt: new Date(now), provenance }];
    });
  }, []);

  const requestAutoCommit = useCallback((runModel?: string | null) => {
    if (!pendingAutoCommitRef.current) return;
    pendingAutoCommitRef.current = false;
    const normalizedModel = canonicalizePortalModelId(String(runModel || modelRef.current || '')) || undefined;
    void projectsAPI.autoCommit(projectName, normalizedModel ? { model: normalizedModel } : {})
      .then((result) => {
        const commit = result?.commit;
        if (result?.committed && commit?.hash) {
          appendSystemNotice(`Committed ${commit.hash}: ${commit.message || 'Assistant update'}`);
        }
      })
      .catch((err) => {
        console.warn('[ProjectChatPanel] Auto-commit failed:', err);
      });
  }, [appendSystemNotice, projectName]);

  const applyCompactionSnapshotState = useCallback((phase?: unknown) => {
    if (phase !== 'idle' && phase !== 'compacting' && phase !== 'compacted') return;
    if (compactionTimerRef.current) {
      clearTimeout(compactionTimerRef.current);
      compactionTimerRef.current = null;
    }
    compactionPhaseRef.current = phase;
    setCompactionPhase(phase);
    if (phase === 'compacting') {
      setStatusText('Compacting context…');
    }
    if (phase === 'compacted') {
      const noticeText = 'Context compacted';
      setStatusText(noticeText);
      compactionTimerRef.current = setTimeout(() => {
        compactionPhaseRef.current = 'idle';
        setCompactionPhase('idle');
        setStatusText((prev) => (prev === noticeText ? null : prev));
        compactionTimerRef.current = null;
      }, 3000);
    }
  }, []);

  // Scroll
  const scrollRef = useRef<HTMLDivElement>(null);
  const isScrolledUp = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  useEffect(() => { sessionKeyRef.current = sessionKey; }, [sessionKey]);
  useEffect(() => { modelRef.current = selectedModel; }, [selectedModel]);

  useEffect(() => {
    let cancelled = false;
    if (!sessionKey) {
      setThinkingLevel('high');
      setFastModeEnabled(false);
      return;
    }

    gatewayAPI.sessionInfo(sessionKey, { silent: true })
      .then((data) => {
        if (cancelled) return;
        const actualModel = normalizeModelId(
          {
            provider: data?.session?.modelProvider || data?.session?.currentModel?.provider,
            model: data?.session?.model || data?.session?.currentModel?.model,
          }
        ) || canonicalizePortalModelId(String(
          data?.resolved?.model
          || modelRef.current
          || ''
        ));
        const rawThinking = String(
          data?.session?.thinkingLevel
          || data?.session?.thinking
          || data?.session?.settings?.thinking
          || ''
        ).toLowerCase();
        if (actualModel) {
          setSelectedModel((prev) => prev === actualModel ? prev : actualModel);
        }
        if (THINKING_LEVELS.includes(rawThinking as ThinkingLevel)) {
          setThinkingLevel(rawThinking as ThinkingLevel);
        } else {
          const modelStr = String(actualModel || '').toLowerCase();
          const adaptiveDefault = /claude-(opus|sonnet)-4[._-](5|6|7|8|9)|claude-(opus|sonnet)-[5-9]/.test(modelStr);
          setThinkingLevel(adaptiveDefault ? 'adaptive' : 'high');
        }
        setFastModeEnabled(Boolean(
          data?.session?.fastMode
          ?? data?.session?.settings?.fastMode
          ?? false,
        ));
      })
      .catch(() => {
        if (!cancelled) {
          setThinkingLevel('high');
          setFastModeEnabled(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  // Persist model selection
  useEffect(() => {
    localStorage.setItem(`agent-model-${projectName}`, canonicalizePortalModelId(selectedModel));
  }, [selectedModel, projectName]);

  const loadAvailableModels = useCallback(async () => {
    const data = await gatewayAPI.models();
    const models = Array.isArray(data?.models)
      ? Array.from(new Set(data.models.map((m: any) => canonicalizePortalModelId(String(m?.id || '').trim())).filter(Boolean)))
      : [];
    setAvailableModels(models);
    // If no model selected or selected model isn't available, pick the first discovered option
    setSelectedModel(prev => {
      if (prev && models.includes(prev)) return prev;
      return prev || models[0] || '';
    });
    return models;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      loadAvailableModels().catch((err) => {
        if (!cancelled) {
          console.error('[ProjectChatPanel] Failed to load models:', err);
        }
      });
    }, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadAvailableModels]);

  // Mark session as active for auto-restore
  useEffect(() => {
    localStorage.setItem(`agent-active-${projectName}`, 'true');
    return () => {}; // Don't clear on unmount — closeAgentChat handles that
  }, [projectName]);

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
      const cid = streamingAssistantIdRef.current;
      const ft = assembledRef.current.substring(lastSegmentStartRef.current);
      const shouldHideTurn = !ft.trim() && !hasRealToolEventsRef.current && !thinkingContentRef.current.trim();
      isStreamActiveRef.current = false;
      setIsRunning(false);
      setStreamingPhase('idle');
      setStatusText(null);
      setThinkingContent('');
      setActiveToolName(null);
      compactionPhaseRef.current = 'idle';
      setCompactionPhase('idle');
      if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
      if (cid) {
        if (shouldHideTurn) {
          setMessages(prev => prev.filter(m => m.id !== cid));
        } else if (ft) {
          setMessages(prev => prev.map(m => m.id === cid ? { ...m, content: ft + '\n\n*(stream interrupted)*' } : m));
        }
        streamingAssistantIdRef.current = null;
      }
      resumeSeededContentRef.current = false;
      suppressLiveBubbleContentRef.current = false;
    }, STREAM_TIMEOUT_MS);
  }, []);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
  }, []);

  const ensureStreamingAssistant = useCallback((content?: string) => {
    const currentId = streamingAssistantIdRef.current ?? ('stream-resume-' + Date.now());
    streamingAssistantIdRef.current = currentId;
    setMessages(prev => {
      const exists = prev.some(m => m.id === currentId);
      if (!exists) {
        return [...prev, {
          id: currentId,
          role: 'assistant' as const,
          content: typeof content === 'string' ? content : '',
          createdAt: new Date(),
          toolCalls: [],
        }];
      }
      if (typeof content !== 'string') return prev;
      return prev.map(m => m.id === currentId ? { ...m, content } : m);
    });
    return currentId;
  }, []);

  const isStaleSessionLoad = useCallback((expectedSession: string, expectedGen: number) => {
    return sessionKeyRef.current !== expectedSession || historyGenRef.current !== expectedGen;
  }, []);

  const applyActiveStreamSnapshot = useCallback((
    snapshot: any,
    expectedSession: string,
    expectedGen: number,
    manager?: LocalWsManager | null,
  ) => {
    if (!snapshot?.active || isStaleSessionLoad(expectedSession, expectedGen)) return false;

    const resumePhase = snapshot.phase === 'tool' ? 'tool' : snapshot.phase === 'streaming' ? 'streaming' : 'thinking';
    const snapshotContent = typeof snapshot.content === 'string' && !isControlOnlyAssistantContent(snapshot.content)
      ? sanitizeAssistantContent(snapshot.content)
      : '';
    const snapshotToolCalls: ToolCall[] = Array.isArray(snapshot.toolCalls)
      ? snapshot.toolCalls.map((toolCall: any) => ({
          id: toolCall.id || nextId(),
          name: toolCall.name,
          arguments: toolCall.arguments,
          startedAt: typeof toolCall.startedAt === 'number' ? toolCall.startedAt : Date.now(),
          endedAt: typeof toolCall.endedAt === 'number' ? toolCall.endedAt : undefined,
          status: toolCall.status === 'running' || toolCall.status === 'error' ? toolCall.status : 'done',
        }))
      : [];
    const runningToolCall = getLastRunningToolCall(snapshotToolCalls);
    const snapshotToolNameCandidate = snapshot.toolName || snapshot.name || runningToolCall?.name || null;
    const snapshotToolName = snapshotToolNameCandidate ? resolveToolName(snapshotToolNameCandidate) : null;
    const rawStatusText = typeof snapshot.statusText === 'string' ? snapshot.statusText.trim() : '';
    const hasStatusSignal = Boolean(rawStatusText)
      || snapshot.compactionPhase === 'compacting'
      || snapshot.compactionPhase === 'compacted';
    const shouldHydrateLiveState = Boolean(snapshotContent)
      || Boolean(snapshotToolName)
      || hasStatusSignal
      || Boolean(streamingAssistantIdRef.current);
    if (!shouldHydrateLiveState) {
      return false;
    }
    const shouldMaterializeBubble = Boolean(snapshotContent) || Boolean(snapshotToolName) || Boolean(streamingAssistantIdRef.current);

    isStreamActiveRef.current = true;
    suppressLiveBubbleContentRef.current = true;
    setIsRunning(true);
    setStreamingPhase(resumePhase);
    setActiveToolName(snapshotToolName || null);
    const compactionStatusText = snapshot.compactionPhase === 'compacting'
      ? (rawStatusText || 'Compacting context…')
      : snapshot.compactionPhase === 'compacted'
        ? (rawStatusText || 'Context compacted')
        : '';
    setStatusText(snapshotToolName
      ? getToolStatusText(snapshotToolName, rawStatusText || compactionStatusText || null)
      : (compactionStatusText || rawStatusText || 'Reconnecting to stream…'));
    setConnectionNotice(null);

    applyCompactionSnapshotState(snapshot.compactionPhase);

    const assistantId = shouldMaterializeBubble ? ensureStreamingAssistant(snapshotContent || undefined) : null;
    resumeSeededContentRef.current = shouldMaterializeBubble && resumePhase === 'streaming' && snapshotContent.length > 0;
    assembledRef.current = snapshotContent;
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = snapshotContent.length;

    if (assistantId && (snapshot.model || snapshot.provenance || snapshotToolCalls.length > 0)) {
      const normalizedModel = canonicalizePortalModelId(String(snapshot.model || ''));
      const normalizedProvenance = typeof snapshot.provenance === 'string' ? snapshot.provenance : undefined;
      setMessages(prev => prev.map(m => (
        m.id === assistantId
          ? {
              ...m,
              model: normalizedModel || m.model,
              provenance: normalizedProvenance || m.provenance,
              toolCalls: snapshotToolCalls.length > 0 ? snapshotToolCalls : (m.toolCalls || []),
            }
          : m
      )));
    }

    manager?.send({ type: 'reconnect', session: expectedSession, provider: 'OPENCLAW' });
    resetWatchdog();
    return true;
  }, [applyCompactionSnapshotState, ensureStreamingAssistant, isStaleSessionLoad, resetWatchdog]);

  const loadHistorySnapshot = useCallback(async (
    session: string,
    options: { expectedGen?: number; manager?: LocalWsManager | null; hydrateActiveStream?: boolean } = {},
  ) => {
    const expectedGen = options.expectedGen ?? historyGenRef.current;
    const { data } = await client.get('/gateway/history', {
      params: { session, provider: 'OPENCLAW', enhanced: '1' },
      _silent: true,
    } as any);

    if (isStaleSessionLoad(session, expectedGen)) return null;

    const loaded = data?.messages ? data.messages.map(parseHistoryMessage).filter(Boolean) as ChatMessage[] : [];
    setMessages(dedupeHistoryMessages(loaded));
    setSessionError(null);

    if (options.hydrateActiveStream !== false && data?.activeStream?.active) {
      applyActiveStreamSnapshot(data.activeStream, session, expectedGen, options.manager || null);
    }

    return { messages: loaded, activeStream: data?.activeStream || null };
  }, [applyActiveStreamSnapshot, isStaleSessionLoad]);

  const clearResumeSeededContent = useCallback((assistantId?: string | null) => {
    if (!resumeSeededContentRef.current) return;
    resumeSeededContentRef.current = false;
    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = 0;
    const cid = assistantId || streamingAssistantIdRef.current;
    if (cid) {
      setMessages(prev => prev.map(m => m.id === cid ? { ...m, content: '' } : m));
    }
  }, []);

  const finalizeStreamingAssistant = useCallback(() => {
    const cid = streamingAssistantIdRef.current;
    const finalContent = assembledRef.current.substring(lastSegmentStartRef.current) || assembledRef.current || '';
    if (cid) {
      if (finalContent) {
        setMessages(prev => prev.map(m => m.id === cid ? { ...m, content: finalContent } : m));
      } else {
        setMessages(prev => prev.filter(m => m.id !== cid));
      }
    }
    setStatusText(null);
    setStreamingPhase('idle');
    setActiveToolName(null);
    setIsRunning(false);
    if (compactionPhaseRef.current === 'compacting') {
      compactionPhaseRef.current = 'idle';
      setCompactionPhase('idle');
      if (compactionTimerRef.current) {
        clearTimeout(compactionTimerRef.current);
        compactionTimerRef.current = null;
      }
    }
    isStreamActiveRef.current = false;
    resumeSeededContentRef.current = false;
    suppressLiveBubbleContentRef.current = false;
    streamingAssistantIdRef.current = null;
  }, []);

  const syncStreamState = useCallback(async (
    manager: LocalWsManager | null,
    options: { reloadHistoryIfIdle?: boolean } = {},
    context: { expectedSession?: string; expectedGen?: number } = {},
  ) => {
    const currentSession = context.expectedSession || sessionKeyRef.current;
    const expectedGen = context.expectedGen ?? historyGenRef.current;
    if (!currentSession) return false;

    const { data } = await client.get('/gateway/stream-status', {
      params: { session: currentSession, provider: 'OPENCLAW' },
      _silent: true,
    } as any);

    if (isStaleSessionLoad(currentSession, expectedGen)) return false;

    if (data.active) {
      return applyActiveStreamSnapshot(data, currentSession, expectedGen, manager);
    }

    clearWatchdog();
    if (isStreamActiveRef.current) {
      isStreamActiveRef.current = false;
      suppressLiveBubbleContentRef.current = false;
      setIsRunning(false);
      setStreamingPhase('idle');
      setStatusText(null);
      setActiveToolName(null);
      applyCompactionSnapshotState('idle');
      streamingAssistantIdRef.current = null;
    }

    if (options.reloadHistoryIfIdle) {
      setIsLoadingHistory(true);
      try {
        await loadHistorySnapshot(currentSession, {
          expectedGen,
          manager,
          hydrateActiveStream: false,
        });
      } finally {
        if (!isStaleSessionLoad(currentSession, expectedGen)) {
          setIsLoadingHistory(false);
        }
      }
    }

    return false;
  }, [applyActiveStreamSnapshot, applyCompactionSnapshotState, clearWatchdog, isStaleSessionLoad, loadHistorySnapshot]);

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

  const resolveApproval = useCallback(async (
    approvalId: string,
    decision: 'allow-once' | 'deny' | 'allow-always',
  ) => {
    try {
      const response = await client.post('/gateway/exec-approval/resolve', { approvalId, decision });
      if (response.data?.ok) {
        setPendingApprovals((prev) => removeExecApproval(prev, approvalId));
        setStatusText(decision === 'deny' ? '❌ Command denied' : '✅ Command approved');
        setTimeout(() => setStatusText(null), 2000);
        return;
      }
      setStatusText('⚠️ Approval did not complete');
      setTimeout(() => setStatusText(null), 3000);
      throw new Error('Approval did not complete');
    } catch (err: any) {
      console.error('[ProjectChatPanel] Failed to resolve approval:', err);
      setStatusText(`⚠️ Approval failed${err?.response?.data?.error ? `: ${err.response.data.error}` : ''}`);
      setTimeout(() => setStatusText(null), 4000);
      throw err;
    }
  }, []);

  const dismissApproval = useCallback((approvalId?: string) => {
    setPendingApprovals((prev) => {
      if (!prev.length) return prev;
      return approvalId ? removeExecApproval(prev, approvalId) : prev.slice(1);
    });
  }, []);

  useEffect(() => {
    if (!pendingApprovals.length) return;

    const pruneExpired = () => {
      setPendingApprovals((prev) => pruneExpiredExecApprovals(prev));
    };

    pruneExpired();
    const interval = setInterval(pruneExpired, 500);
    return () => clearInterval(interval);
  }, [pendingApprovals.length]);

  // ── WS Event Handler ──
  const handleWsEvent = useCallback((data: any) => {
    const passthrough = ['connected', 'keepalive', 'compaction_start', 'compaction_end', 'stream_resume', 'stream_ended', 'run_resumed', 'exec_approval', 'exec_approval_resolved'];
    const autoCreateBubbleTypes = ['text', 'thinking', 'tool_start', 'tool_end', 'tool_used', 'toolCall', 'toolResult', 'segment_break'];
    const waitForVisibleStreamTypes = ['status', 'thinking', 'done', 'error'];
    if (!streamingAssistantIdRef.current && data.type === 'text' && typeof data.content === 'string' && isControlOnlyAssistantContent(data.content)) {
      return;
    }
    if (!streamingAssistantIdRef.current && !passthrough.includes(data.type)) {
      if (autoCreateBubbleTypes.includes(data.type)) {
        ensureStreamingAssistant();
        isStreamActiveRef.current = true;
        setIsRunning(true);
      } else if (!waitForVisibleStreamTypes.includes(data.type)) {
        return;
      }
    }
    const assistantId = streamingAssistantIdRef.current;
    if (assistantId || isStreamActiveRef.current) resetWatchdog();

    switch (data.type) {
      case 'session': {
        const normalizedModel = canonicalizePortalModelId(String(data.model || ''));
        const normalizedProvenance = typeof data.provenance === 'string' ? data.provenance : undefined;
        if (normalizedModel) {
          setSelectedModel(prev => prev === normalizedModel ? prev : normalizedModel);
        }
        if (assistantId && (normalizedModel || normalizedProvenance)) {
          setMessages(prev => prev.map(m => (
            m.id === assistantId
              ? {
                  ...m,
                  model: normalizedModel || m.model,
                  provenance: normalizedProvenance || m.provenance,
                }
              : m
          )));
        }
        break;
      }
      case 'status': {
        if (!assistantId && !isStreamActiveRef.current) break;
        clearResumeSeededContent(assistantId);
        setStatusText(data.content || null);
        if (!assembledRef.current) setStreamingPhase('thinking');
        break;
      }
      case 'thinking': {
        if (!assistantId && !isStreamActiveRef.current) break;
        clearResumeSeededContent(assistantId);
        appendThinkingChunk(
          assistantId,
          extractThinkingChunk('thinking', data.content, assembledRef.current.length > 0),
        );
        if (!assembledRef.current) setStreamingPhase('thinking');
        break;
      }
      case 'compaction_start': {
        const noticeText = typeof data.content === 'string' && data.content.trim() ? data.content : 'Compacting context…';
        compactionPhaseRef.current = 'compacting';
        setCompactionPhase('compacting');
        setStatusText(noticeText);
        if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
        break;
      }
      case 'compaction_end': {
        const completed = data.completed !== false;
        const noticeText = typeof data.content === 'string' && data.content.trim()
          ? data.content
          : (completed ? 'Context compacted' : 'Context maintenance finished.');
        if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
        if (completed) {
          compactionPhaseRef.current = 'compacted';
          setCompactionPhase('compacted');
          if (!data.content) appendSystemNotice(noticeText, 'compaction');
        } else {
          compactionPhaseRef.current = 'idle';
          setCompactionPhase('idle');
        }
        setStatusText(noticeText);
        compactionTimerRef.current = setTimeout(() => {
          compactionPhaseRef.current = 'idle';
          setCompactionPhase('idle');
          setStatusText((prev) => (prev === noticeText ? null : prev));
          compactionTimerRef.current = null;
        }, 3000);
        break;
      }
      case 'tool_start': {
        clearResumeSeededContent(assistantId);
        hasRealToolEventsRef.current = true;
        const toolName = resolveToolName(data.toolName, data.name, data.content, 'tool');
        if (assembledRef.current && assembledRef.current.trim().length > 0) {
          lastSegmentStartRef.current = lastRawTextLenRef.current;
        }
        setStatusText(getToolStatusText(toolName, data.content));
        setStreamingPhase('tool');
        setActiveToolName(toolName);
        const toolId = 'tool-' + (++toolCounterRef.current);
        const toolArgs = data.toolArgs || undefined;
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, toolCalls: [...(m.toolCalls || []), { id: toolId, name: toolName, arguments: toolArgs, startedAt: Date.now(), status: 'running' as const }] }
            : m
        ));
        break;
      }
      case 'tool_end': {
        lastSegmentStartRef.current = lastRawTextLenRef.current;
        const toolResult = data.toolResult || data.content || 'Completed';
        let nextRunningToolName: string | null = null;
        setMessages(prev => prev.map(m => {
          if (m.id !== assistantId) return m;
          const calls = [...(m.toolCalls || [])];
          for (let i = calls.length - 1; i >= 0; i--) {
            if (calls[i].status === 'running') {
              calls[i] = { ...calls[i], endedAt: Date.now(), result: toolResult, status: 'done' };
              break;
            }
          }
          const nextRunningTool = getLastRunningToolCall(calls);
          nextRunningToolName = nextRunningTool ? resolveToolName(nextRunningTool.name) : null;
          return { ...m, toolCalls: calls };
        }));
        if (nextRunningToolName) {
          setStreamingPhase('tool');
          setActiveToolName(nextRunningToolName);
          setStatusText(getToolStatusText(nextRunningToolName));
        } else {
          setStreamingPhase(assembledRef.current ? 'streaming' : 'thinking');
          setStatusText(null);
          setActiveToolName(null);
        }
        break;
      }
      case 'tool_used': {
        if (hasRealToolEventsRef.current) break;
        const tn = resolveToolName(data.toolName, data.name, data.content, 'tool');
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
            ? { ...m, toolCalls: [...(m.toolCalls || []), { id: tid, name: tn, startedAt: now - 1000, endedAt: now, status: 'done' as const }] }
            : m
          );
        });
        setStreamingPhase('tool');
        setActiveToolName(tn);
        setStatusText(getToolStatusText(tn));
        break;
      }
      case 'toolCall': {
        clearResumeSeededContent(assistantId);
        const tid = 'tool-' + (++toolCounterRef.current);
        setStreamingPhase('tool');
        const toolName = resolveToolName(data.toolName, data.name, 'tool');
        setActiveToolName(toolName);
        setStatusText(getToolStatusText(toolName));
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, toolCalls: [...(m.toolCalls || []), { id: data.id || tid, name: toolName, arguments: data.arguments, startedAt: Date.now(), status: 'running' as const }] }
            : m
        ));
        break;
      }
      case 'toolResult': {
        lastSegmentStartRef.current = lastRawTextLenRef.current;
        const resolvedToolName = resolveToolName(data.toolName, data.name, data.content, 'tool');
        let nextRunningToolName: string | null = null;
        setMessages(prev => prev.map(m => {
          if (m.id !== assistantId) return m;
          const calls = [...(m.toolCalls || [])];
          const idx = calls.findIndex(c => c.id === data.toolCallId || c.name === resolvedToolName);
          if (idx >= 0) calls[idx] = { ...calls[idx], endedAt: Date.now(), result: data.content, status: 'done' };
          const nextRunningTool = getLastRunningToolCall(calls);
          nextRunningToolName = nextRunningTool ? resolveToolName(nextRunningTool.name) : null;
          return { ...m, toolCalls: calls };
        }));
        if (nextRunningToolName) {
          setStreamingPhase('tool');
          setActiveToolName(nextRunningToolName);
          setStatusText(getToolStatusText(nextRunningToolName));
        } else {
          setStreamingPhase(assembledRef.current ? 'streaming' : 'thinking');
          setStatusText(null);
          setActiveToolName(null);
        }
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
        const rawChunk = typeof data.content === 'string' ? data.content : '';
        if (rawChunk && isControlOnlyAssistantContent(rawChunk)) {
          break;
        }
        const safeChunk = typeof data.content === 'string'
          ? (data.replace === true ? sanitizeAssistantContent(data.content) : sanitizeAssistantChunk(data.content))
          : '';
        const fullText = mergeAssistantStream(assembledRef.current, safeChunk, { replace: data.replace === true });
        lastRawTextLenRef.current = fullText.length;
        const st = fullText.substring(lastSegmentStartRef.current);

        resumeSeededContentRef.current = false;
        suppressLiveBubbleContentRef.current = false;
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
        const rawFinal = typeof data.content === 'string' ? data.content : '';
        const hasFinal = rawFinal.length > 0 && !isControlOnlyAssistantContent(rawFinal);
        const finalText = hasFinal ? sanitizeAssistantContent(rawFinal) : fst;
        const fc = finalText || '';
        const prov = data.provenance || null;
        const model = canonicalizePortalModelId(
          typeof data?.metadata?.model === 'string'
            ? data.metadata.model
            : (typeof data?.model === 'string' ? data.model : '')
        );
        const cid = streamingAssistantIdRef.current;
        const shouldHideTurn = !fc.trim() && !hasRealToolEventsRef.current && !thinkingContentRef.current.trim();
        setStatusText(null);
        setStreamingPhase('idle');
        setIsRunning(false);
        setThinkingContent('');
        setPendingApprovals([]);
        if (compactionPhaseRef.current === 'compacting') {
          compactionPhaseRef.current = 'idle';
          setCompactionPhase('idle');
          if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
        }
        isStreamActiveRef.current = false;
        streamingAssistantIdRef.current = null;
        resumeSeededContentRef.current = false;
        suppressLiveBubbleContentRef.current = false;
        if (cid) {
          if (shouldHideTurn) {
            setMessages(prev => prev.filter(m => m.id !== cid));
          } else {
            setMessages(prev => prev.map(m =>
              m.id === cid ? { ...m, content: fc, provenance: prov || undefined, model: model || m.model } : m
            ));
          }
        }
        requestAutoCommit(model || modelRef.current);
        break;
      }
      case 'error': {
        if (assistantId) {
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, content: '⚠️ ' + (data.content || 'Unknown error') } : m
          ));
        }
        pendingAutoCommitRef.current = false;
        setStatusText(null);
        setStreamingPhase('idle');
        setThinkingContent('');
        setIsRunning(false);
        setPendingApprovals([]);
        isStreamActiveRef.current = false;
        streamingAssistantIdRef.current = null;
        resumeSeededContentRef.current = false;
        suppressLiveBubbleContentRef.current = false;
        break;
      }
      case 'exec_approval': {
        const approval = data.approval as ExecApprovalRequest;
        if (approval?.id) {
          setPendingApprovals((prev) => upsertExecApproval(prev, approval));
          setStatusText('⏳ Waiting for command approval…');
        }
        break;
      }
      case 'exec_approval_resolved': {
        const resolved = data.resolved;
        if (resolved?.id) {
          setPendingApprovals((prev) => removeExecApproval(prev, resolved.id));
        }
        break;
      }
      case 'stream_resume': {
        suppressLiveBubbleContentRef.current = true;
        const resumePhase = data.phase === 'tool' ? 'tool' : data.phase === 'streaming' ? 'streaming' : 'thinking';
        const resumeContent = typeof data.content === 'string' && !isControlOnlyAssistantContent(data.content)
          ? sanitizeAssistantContent(data.content)
          : '';
        const resumeToolName = resolveToolName(data.toolName, data.name, data.content);
        const shouldMaterializeBubble = Boolean(streamingAssistantIdRef.current) || Boolean(resumeToolName) || Boolean(resumeContent);
        if (!shouldMaterializeBubble) {
          break;
        }
        if (!streamingAssistantIdRef.current) {
          const resumeId = 'stream-resume-' + Date.now();
          streamingAssistantIdRef.current = resumeId;
          assembledRef.current = '';
          setMessages(prev => [...prev, { id: resumeId, role: 'assistant' as const, content: '', createdAt: new Date(), toolCalls: [] }]);
        }
        isStreamActiveRef.current = true;
        setIsRunning(true);
        setStreamingPhase(resumePhase);
        setActiveToolName(resumeToolName || null);
        setStatusText(resumeToolName ? getToolStatusText(resumeToolName) : null);
        if (resumePhase === 'streaming' && typeof data.content === 'string' && !isControlOnlyAssistantContent(data.content)) {
          resumeSeededContentRef.current = true;
          const safeChunk = sanitizeAssistantContent(data.content);
          const fullText = mergeAssistantStream(assembledRef.current, safeChunk, { replace: true });
          lastRawTextLenRef.current = fullText.length;
          const st = fullText.substring(lastSegmentStartRef.current);
          assembledRef.current = fullText;
          const cid = streamingAssistantIdRef.current;
          setMessages(prev => prev.map(m => m.id === cid ? { ...m, content: st } : m));
        } else {
          resumeSeededContentRef.current = false;
        }
        break;
      }
      case 'connected':
        setWsConnected(true);
        setConnectionNotice(null);
        break;
      case 'run_resumed': {
        if (!streamingAssistantIdRef.current) {
          break;
        }
        isStreamActiveRef.current = true;
        setIsRunning(true);
        setStreamingPhase(activeToolName ? 'tool' : 'thinking');
        setStatusText(activeToolName ? getToolStatusText(activeToolName) : '🧠 Agent is thinking…');
        resetWatchdog();
        break;
      }
      case 'stream_ended':
        setIsRunning(false);
        setStreamingPhase('idle');
        setStatusText(null);
        setThinkingContent('');
        setPendingApprovals([]);
        setActiveToolName(null);
        clearWatchdog();
        finalizeStreamingAssistant();
        requestAutoCommit(modelRef.current);
        break;
      case 'keepalive':
        break;
    }
  }, [activeToolName, clearResumeSeededContent, resetWatchdog, clearWatchdog, appendThinkingChunk, thinkingContent, finalizeStreamingAssistant, requestAutoCommit]);

  const handleWsEventRef = useRef(handleWsEvent);
  useEffect(() => { handleWsEventRef.current = handleWsEvent; }, [handleWsEvent]);

  // ── Ensure session + WS setup on mount ──
  useEffect(() => {
    let cancelled = false;
    let cleanupTransport: (() => void) | null = null;
    const myGen = ++historyGenRef.current;

    async function init() {
      try {
        setIsLoadingHistory(true);
        setSessionReady(false);
        setSessionError(null);
        setWsConnected(false);
        setConnectionNotice('Connecting to project agent…');

        const preferredModel = canonicalizePortalModelId(modelRef.current || '');

        const { data } = await client.post(
          `/projects/${projectName}/assistant/ensure-session`,
          preferredModel ? { model: preferredModel } : {}
        );
        if (cancelled || historyGenRef.current !== myGen) return;

        const { sessionKey: sk, agentId: aid, model: m } = data;
        sessionKeyRef.current = sk;
        setSessionKey(sk);
        setAgentId(aid);
        if (m) setSelectedModel(canonicalizePortalModelId(m));

        const manager = createLocalWsManager(getWsUrl());
        wsRef.current = manager;

        const stableHandler = (d: any) => {
          if (cancelled || historyGenRef.current !== myGen || sessionKeyRef.current !== sk) return;
          handleWsEventRef.current(d);
        };

        const unsubDisconnect = manager.onDisconnect(() => {
          if (cancelled || historyGenRef.current !== myGen || sessionKeyRef.current !== sk) return;
          setWsConnected(false);
          setConnectionNotice(
            isStreamActiveRef.current
              ? 'Connection lost — reconnecting to the live stream…'
              : 'Connection lost — reconnecting…'
          );
          if (isStreamActiveRef.current) {
            setIsRunning(true);
            setStreamingPhase(prev => prev === 'idle' ? 'thinking' : prev);
            setStatusText('Reconnecting to stream…');
          }
        });

        const unsubReconnect = manager.onReconnect(async () => {
          if (cancelled || historyGenRef.current !== myGen || sessionKeyRef.current !== sk) return;
          setWsConnected(true);
          setConnectionNotice(null);
          try {
            await syncStreamState(manager, { reloadHistoryIfIdle: true }, { expectedSession: sk, expectedGen: myGen });
          } catch (err) {
            console.warn('[ProjectChat] Reconnect sync failed:', err);
          }
        });

        cleanupTransport = () => {
          manager.removeHandler(stableHandler);
          unsubDisconnect();
          unsubReconnect();
        };

        const waitForInitialConnect = new Promise<void>((resolve) => {
          if (manager.isConnected()) { resolve(); return; }
          const check = setInterval(() => {
            if (manager.isConnected() || cancelled || historyGenRef.current !== myGen) {
              clearInterval(check);
              resolve();
            }
          }, 100);
          setTimeout(() => {
            clearInterval(check);
            resolve();
          }, 3000);
        });

        const historyResult = await loadHistorySnapshot(sk, {
          expectedGen: myGen,
          hydrateActiveStream: true,
        });

        if (cancelled || historyGenRef.current !== myGen || sessionKeyRef.current !== sk) {
          cleanupTransport?.();
          manager.close();
          return;
        }

        manager.addHandler(stableHandler);
        await waitForInitialConnect;

        if (cancelled || historyGenRef.current !== myGen || sessionKeyRef.current !== sk) {
          cleanupTransport?.();
          manager.close();
          return;
        }

        setWsConnected(manager.isConnected());
        setSessionReady(true);

        if (manager.isConnected()) {
          setConnectionNotice(null);
          if (historyResult?.activeStream?.active) {
            manager.send({ type: 'reconnect', session: sk, provider: 'OPENCLAW' });
          } else {
            await syncStreamState(manager, { reloadHistoryIfIdle: false }, { expectedSession: sk, expectedGen: myGen });
          }
        } else if (!historyResult?.activeStream?.active) {
          setConnectionNotice('Live chat socket is still reconnecting…');
        }

        if (!cancelled && historyGenRef.current === myGen) {
          setIsLoadingHistory(false);
        }
      } catch (err: any) {
        if (!cancelled && historyGenRef.current === myGen) {
          setSessionError(err?.message || 'Failed to initialize session');
          setIsLoadingHistory(false);
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      cleanupTransport?.();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
    };
  }, [projectName, loadHistorySnapshot, syncStreamState]);

  // ── Send message ──
  const sendMessage = useCallback((text: string) => {
    const sk = sessionKeyRef.current;
    if (!sk || isStreamActiveRef.current) return false;

    const manager = wsRef.current;
    if (!manager || !manager.isConnected()) {
      setWsConnected(false);
      setConnectionNotice('Connection lost — reconnecting. Your draft is still in the composer.');
      manager?.reconnect();
      return false;
    }

    const sent = manager.send({
      type: 'send',
      message: text,
      session: sk,
      provider: 'OPENCLAW',
      agentId: agentId,
      model: modelRef.current,
    });

    if (!sent) {
      setWsConnected(false);
      setConnectionNotice('Couldn’t reach the live chat socket. Reconnecting now — your draft is still in the composer.');
      manager.reconnect();
      return false;
    }

    const userMsg: ChatMessage = { id: nextId(), role: 'user', content: text, createdAt: new Date() };
    setMessages(prev => [...prev, userMsg]);

    pendingAutoCommitRef.current = true;
    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = 0;
    toolCounterRef.current = 0;
    hasRealToolEventsRef.current = false;
    resumeSeededContentRef.current = false;
    suppressLiveBubbleContentRef.current = false;
    setThinkingContent('');
    setStatusText(null);
    setStreamingPhase('thinking');
    setActiveToolName(null);

    const assistantMsgId = nextId();
    streamingAssistantIdRef.current = assistantMsgId;
    setMessages(prev => [...prev, { id: assistantMsgId, role: 'assistant' as const, content: '', createdAt: new Date() }]);
    setIsRunning(true);
    isStreamActiveRef.current = true;
    resetWatchdog();
    setConnectionNotice(null);
    return true;
  }, [agentId, resetWatchdog]);

  // ── Cancel stream ──
  const cancelStream = useCallback(() => {
    const manager = wsRef.current;
    const sk = sessionKeyRef.current;
    if (manager && manager.isConnected() && sk) {
      manager.send({ type: 'abort', session: sk });
    }
    clearWatchdog();
    pendingAutoCommitRef.current = false;
    isStreamActiveRef.current = false;
    setIsRunning(false);
    setStreamingPhase('idle');
    setStatusText(null);
    setPendingApprovals([]);
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

      pendingAutoCommitRef.current = false;
      await client.post(`/projects/${projectName}/assistant/reset`);
      setMessages([]);
      setStatusText(null);
      setThinkingContent('');
      setStreamingPhase('idle');
      setIsRunning(false);
      setPendingApprovals([]);
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
  const uploadFile = useCallback(async (file: File, attachId: string) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const resp = await fetch('/api/files/', { method: 'POST', credentials: 'include', body: formData });
      if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
      const data = await resp.json();
      const fileId = typeof data?.id === 'string' ? data.id : undefined;
      const serverPath = typeof data?.diskPath === 'string' ? data.diskPath : undefined;
      const toolUrl = typeof data?.toolUrl === 'string' ? data.toolUrl : undefined;
      setPendingAttachments(prev => prev.map(a => a.id === attachId ? { ...a, fileId, serverPath, toolUrl, uploadStatus: 'done' as const } : a));
    } catch (err: any) {
      setPendingAttachments(prev => prev.map(a => a.id === attachId ? { ...a, uploadStatus: 'error' as const, uploadError: err.message } : a));
    }
  }, []);

  const handleFileSelect = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
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
    setPendingAttachments(prev => [...prev, ...newAttachments]);
    for (const att of newAttachments) {
      if (att.uploadStatus === 'uploading') uploadFile(att.file, att.id);
    }
  }, [uploadFile]);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments(prev => {
      const removed = prev.find(a => a.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter(a => a.id !== id);
    });
  }, []);

  // Build attachment text
  const buildAttachmentText = useCallback(() => {
    if (pendingAttachments.length === 0) return '';
    const parts: string[] = [];
    for (const att of pendingAttachments) {
      const fileHref = att.fileId
        ? `/files?file=${encodeURIComponent(att.fileId)}`
        : att.serverPath
          ? `/files?path=${encodeURIComponent(att.serverPath)}`
          : '';
      const portalUrl = fileHref ? `${window.location.origin}${fileHref}` : '';
      const diskPathLine = att.serverPath ? `- server_path: ${att.serverPath}` : null;
      const toolUrlLine = att.toolUrl ? `- tool_url: ${att.toolUrl}` : null;
      const portalLine = portalUrl ? `- portal_url: ${portalUrl}` : null;
      if (att.type === 'text' && att.textContent) {
        parts.push([
          `Attached text file: ${att.name}`,
          diskPathLine,
          portalLine,
          'The file content is inlined below.',
          `\`\`\`${att.name}\n${att.textContent}\n\`\`\``,
        ].filter(Boolean).join('\n'));
        continue;
      }
      const typeHint = att.type === 'image'
        ? [
            'This is an image attachment.',
            'IMPORTANT: prefer tool_url when present because the gateway host may differ from the portal host.',
            att.toolUrl
              ? `Use the image tool with image="${att.toolUrl}".`
              : att.serverPath
                ? `Use the image tool with image="${att.serverPath}".`
                : 'Use the image tool on tool_url or server_path.',
            'Do not say you cannot access the image unless the tool itself returns an error.',
          ].join(' ')
        : /\.pdf$/i.test(att.name)
          ? [
              'This is a PDF attachment.',
              'IMPORTANT: prefer tool_url when present because the gateway host may differ from the portal host.',
              att.toolUrl
                ? `Use the pdf tool with pdf="${att.toolUrl}".`
                : att.serverPath
                  ? `Use the pdf tool with pdf="${att.serverPath}".`
                  : 'Use the pdf tool on tool_url or server_path.',
              'Do not say you cannot access the PDF unless the tool itself returns an error.',
            ].join(' ')
          : 'This file is attached on disk. Use tool_url or server_path to inspect it if needed.';
      parts.push([
        `Attached file: ${att.name}`,
        `- kind: ${att.type}`,
        `- size: ${att.size} bytes`,
        diskPathLine,
        toolUrlLine,
        portalLine,
        typeHint,
      ].filter(Boolean).join('\n'));
    }
    return parts.join('\n\n') + '\n\n';
  }, [pendingAttachments]);

  // ── Form submit ──
  const appendSystemMessage = useCallback((content: string) => {
    setMessages(prev => ([...prev, {
      id: nextId(),
      role: 'system',
      content,
      createdAt: new Date(),
    }]));
  }, []);

  const refreshSlashAutocomplete = useCallback((value: string, caret = value.length) => {
    const activeText = value.slice(0, caret);
    const tokenMatch = activeText.match(/(?:^|\s)(\/[^\s]*)$/);
    if (!tokenMatch) {
      setShowSlashMenu(false);
      setSlashCommands([]);
      setSelectedSlashIndex(0);
      return;
    }
    const matches = matchSlashCommands(tokenMatch[1]);
    setSlashCommands(matches);
    setSelectedSlashIndex(0);
    setShowSlashMenu(matches.length > 0);
  }, []);

  const insertSlashCommand = useCallback((command: SlashCommand) => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const nextValue = `${command.command}${command.argsHint ? ' ' : ''}`;
    setInput(nextValue);
    setShowSlashMenu(false);
    setSlashCommands([]);
    setSelectedSlashIndex(0);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = nextValue.length;
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
    });
  }, []);

  const exportChatMarkdown = useCallback(() => {
    const lines = messages.map((msg) => {
      const heading = msg.role === 'user'
        ? '## User'
        : msg.role === 'assistant'
          ? '## Assistant'
          : msg.role === 'system'
            ? '## System'
            : '## Tool';
      return `${heading}\n\n${msg.content || ''}`;
    });
    const blob = new Blob([`# ${projectName} Project Chat\n\n${lines.join('\n\n---\n\n')}\n`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${projectName}-project-chat.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    appendSystemMessage('Exported chat as markdown.');
  }, [appendSystemMessage, messages, projectName]);

  const showSessionStatus = useCallback(async () => {
    try {
      const [statusRes, modelRes] = await Promise.allSettled([
        client.get(`/projects/${encodeURIComponent(projectName)}/chat/session-status`),
        client.get(`/projects/${encodeURIComponent(projectName)}/assistant/active-model`),
      ]);
      const statusData = statusRes.status === 'fulfilled' ? statusRes.value.data : null;
      const modelData = modelRes.status === 'fulfilled' ? modelRes.value.data : null;
      const lines = [
        `Project: ${projectName}`,
        `Gateway session: ${statusData?.active ? 'active' : 'inactive'}`,
        `WebSocket: ${wsConnected ? 'connected' : 'disconnected'}`,
        `Session key: ${sessionKeyRef.current || 'not ready'}`,
        `Configured model: ${selectedModel || 'not set'}`,
        `Active model: ${modelData?.activeModel || statusData?.model || 'unknown'}`,
      ];
      if (statusData?.dbStatus) lines.push(`DB status: ${statusData.dbStatus}`);
      appendSystemMessage(lines.join('\n'));
    } catch (err: any) {
      appendSystemMessage(`Failed to load session status: ${err?.response?.data?.error || err?.message || 'Unknown error'}`);
    }
  }, [appendSystemMessage, projectName, selectedModel, wsConnected]);

  const maybeExecuteSlashCommand = useCallback(async () => {
    const parsed = parseSlashCommand(input);
    if (!parsed) return false;

    const rawArg = parsed.args?.trim() || '';
    switch (parsed.command.command) {
      case '/help':
        appendSystemMessage('Available project chat commands: /new, /stop, /models, /model <id>, /status, /clear, /export, /help');
        setShowSessionControls(true);
        return true;
      case '/new':
      case '/clear':
        await clearChat();
        return true;
      case '/stop':
        if (isRunning) {
          cancelStream();
          appendSystemMessage('Stopping current response…');
        } else {
          appendSystemMessage('No active response to stop.');
        }
        return true;
      case '/models': {
        const models = availableModels.length > 0 ? availableModels : await loadAvailableModels();
        const list = models.length > 0 ? models.join('\n') : 'No models available';
        appendSystemMessage(`Available models:\n${list}`);
        return true;
      }
      case '/model': {
        if (!rawArg) {
          appendSystemMessage('Usage: /model <model-id>');
          return true;
        }
        const nextModel = canonicalizePortalModelId(rawArg);
        try {
          setSelectedModel(nextModel);
          modelRef.current = nextModel;
          localStorage.setItem(`agent-model-${projectName}`, nextModel);
          await client.post(`/projects/${encodeURIComponent(projectName)}/assistant/ensure-session`, { model: nextModel });
          appendSystemMessage(`Model switched to ${nextModel}`);
        } catch (err: any) {
          appendSystemMessage(`Failed to switch model to ${nextModel}: ${err?.response?.data?.error || err?.message || 'Unknown error'}`);
        }
        return true;
      }
      case '/status':
        await showSessionStatus();
        return true;
      case '/export':
        exportChatMarkdown();
        return true;
      default:
        return false;
    }
  }, [appendSystemMessage, availableModels, cancelStream, clearChat, exportChatMarkdown, input, isRunning, loadAvailableModels, projectName, showSessionStatus]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isRunning || !sessionReady) return;
    const stillUploading = pendingAttachments.some(a => a.uploadStatus === 'uploading');
    if (stillUploading) return;
    if (await maybeExecuteSlashCommand()) {
      setInput('');
      setShowSlashMenu(false);
      setSlashCommands([]);
      setSelectedSlashIndex(0);
      return;
    }
    const attachText = buildAttachmentText();
    const fullMessage = attachText + input.trim();
    const sent = sendMessage(fullMessage);
    if (sent) {
      setInput('');
      setPendingAttachments([]);
      setShowSlashMenu(false);
      setSlashCommands([]);
      setSelectedSlashIndex(0);
    }
  }, [input, isRunning, sessionReady, pendingAttachments, maybeExecuteSlashCommand, buildAttachmentText, sendMessage]);

  // ── Model change ──
  const handleModelChange = useCallback(async (newModel: string) => {
    const normalizedModel = canonicalizePortalModelId(newModel);
    setSelectedModel(normalizedModel);
    // Patch the session model
    if (sessionKeyRef.current) {
      try {
        await client.post(`/projects/${projectName}/assistant/ensure-session`, { model: normalizedModel });
      } catch {}
    }
  }, [projectName]);

  const handleThinkingLevelChange = useCallback(async (nextLevel: ThinkingLevel) => {
    const sk = sessionKeyRef.current;
    if (!sk) return;
    setThinkingLevel(nextLevel);
    setThinkingPending(true);
    try {
      await gatewayAPI.patchSession(sk, { thinking: nextLevel }, 'OPENCLAW');
    } catch (err) {
      console.error('[ProjectChatPanel] Failed to patch thinking level:', err);
    } finally {
      setThinkingPending(false);
    }
  }, []);

  const handleFastModeToggle = useCallback(async () => {
    const sk = sessionKeyRef.current;
    if (!sk) return;
    try {
      await gatewayAPI.patchSession(sk, { fastMode: !fastModeEnabled }, 'OPENCLAW');
      setFastModeEnabled((prev) => !prev);
    } catch (err) {
      console.error('[ProjectChatPanel] Failed to patch fast mode:', err);
      appendSystemNotice('Failed to update fast mode.');
    }
  }, [appendSystemNotice, fastModeEnabled]);

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
        setInput(transcript);
      };
      recognition.onerror = () => setIsListening(false);
      recognition.onend = () => setIsListening(false);
      recognition.start();
      recognitionRef.current = recognition;
      setIsListening(true);
    }
  }, [SpeechRecognition, isListening]);

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
        <div className="flex items-center gap-1 flex-shrink-0 relative">
          {/* Model selector */}
          <ProjectModelPicker
            value={selectedModel}
            onChange={handleModelChange}
            models={availableModels}
          />
          <button
            onClick={() => setShowSessionControls(v => !v)}
            className={`p-1 rounded transition-colors ${showSessionControls ? 'bg-cyan-500/15 text-cyan-300' : 'hover:bg-white/5 text-slate-500 hover:text-cyan-300'}`}
            title="Session Controls"
          >
            <Wrench size={12} />
          </button>
          {showSessionControls && (
            <div className="absolute right-0 top-full mt-2 w-72 rounded-xl border border-white/10 bg-[#0B0F22]/98 backdrop-blur-xl shadow-2xl p-3 z-30">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="text-xs font-medium text-white">Session Controls</div>
                  <div className="text-[10px] text-slate-500">Control this OpenClaw project agent directly.</div>
                </div>
                <button onClick={() => setShowSessionControls(false)} className="p-1 rounded hover:bg-white/5 text-slate-500 hover:text-white">
                  <X size={12} />
                </button>
              </div>
              <div className="space-y-1.5 text-[11px] text-slate-300 mb-3">
                <div><span className="text-slate-500">Session:</span> <span className="text-slate-200 break-all">{sessionKey || 'starting…'}</span></div>
                <div><span className="text-slate-500">Model:</span> <span className="text-slate-200">{selectedModel || 'not set'}</span></div>
                <div><span className="text-slate-500">Connection:</span> <span className={wsConnected ? 'text-emerald-300' : 'text-amber-300'}>{wsConnected ? 'connected' : 'disconnected'}</span></div>
              </div>
              <div className="mb-3 rounded-lg border border-white/6 bg-black/20 px-2 py-2">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles size={12} className={thinkingLevel !== 'off' ? 'text-violet-300' : 'text-slate-500'} />
                  <div>
                    <div className="text-[11px] font-medium text-white">Thinking Level</div>
                    <div className="text-[10px] text-slate-500">Controls reasoning depth for this project agent session.</div>
                  </div>
                </div>
                <input
                  type="range"
                  min={0}
                  max={THINKING_LEVELS.length - 1}
                  step={1}
                  value={Math.max(0, THINKING_LEVELS.indexOf(thinkingLevel))}
                  disabled={!sessionKey || thinkingPending}
                  onChange={(e) => {
                    const next = THINKING_LEVELS[Number(e.target.value)] || 'off';
                    void handleThinkingLevelChange(next);
                  }}
                  className="w-full accent-violet-400"
                />
                <div className="mt-1 text-[10px] text-slate-400">
                  Current: <span className={`font-semibold uppercase ${thinkingLevel === 'adaptive' ? 'text-cyan-300' : 'text-violet-300'}`}>{THINKING_LEVEL_LABELS[thinkingLevel]}</span>
                  {thinkingPending && <span className="ml-2 text-slate-500">Saving…</span>}
                </div>
              </div>
              {(supportsOpenClawFastModeModel(selectedModel) || fastModeEnabled) && (
                <div className="mb-3 rounded-lg border border-white/6 bg-black/20 px-2 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Radio size={12} className={fastModeEnabled ? 'text-amber-300' : 'text-slate-500'} />
                      <div>
                        <div className="text-[11px] font-medium text-white">Codex Fast Mode</div>
                        <div className="text-[10px] text-slate-500">Native OpenClaw fast mode for GPT-5.4 and Codex project sessions.</div>
                      </div>
                    </div>
                    <button
                      onClick={() => { void handleFastModeToggle(); }}
                      disabled={!sessionKey}
                      className={`relative h-5 w-10 rounded-full transition-colors ${fastModeEnabled ? 'bg-amber-500' : 'bg-white/10'} disabled:opacity-50`}
                    >
                      <span
                        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${fastModeEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                      />
                    </button>
                  </div>
                  <div className="mt-2 text-[10px] text-slate-400">
                    Current: <span className="text-slate-200">{fastModeEnabled ? 'enabled' : 'disabled'}</span> for <span className="font-mono text-slate-300">{selectedModel || 'default'}</span>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 mb-3">
                <button onClick={() => { void showSessionStatus(); setShowSessionControls(false); }} className="px-2 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-slate-200">Status</button>
                <button onClick={() => { exportChatMarkdown(); setShowSessionControls(false); }} className="px-2 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-slate-200">Export</button>
                <button onClick={() => { if (isRunning) cancelStream(); setShowSessionControls(false); }} className="px-2 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-slate-200 disabled:opacity-50" disabled={!isRunning}>Stop</button>
                <button onClick={() => { void clearChat(); setShowSessionControls(false); }} className="px-2 py-2 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-xs text-amber-200">New Session</button>
              </div>
              <div className="rounded-lg border border-white/6 bg-black/20 px-2 py-2 text-[10px] text-slate-400 leading-relaxed">
                Slash commands: <span className="text-slate-200">/new</span>, <span className="text-slate-200">/stop</span>, <span className="text-slate-200">/status</span>, <span className="text-slate-200">/models</span>, <span className="text-slate-200">/model &lt;id&gt;</span>, <span className="text-slate-200">/clear</span>, <span className="text-slate-200">/export</span>
              </div>
            </div>
          )}
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

      {connectionNotice && !sessionError && (
        <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 text-[11px] text-amber-300 flex items-center gap-2">
          <RotateCcw size={12} className={!wsConnected ? 'animate-spin' : ''} />
          <span className="flex-1 min-w-0">{connectionNotice}</span>
          {!wsConnected && (
            <button
              onClick={() => wsRef.current?.reconnect()}
              className="px-2 py-0.5 rounded-md border border-amber-500/20 hover:bg-amber-500/10 transition-colors text-[10px] font-medium"
            >
              Retry now
            </button>
          )}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-auto" onScroll={handleScroll}>
        {isLoadingHistory && messages.length > 0 && (
          <div className="sticky top-0 z-[5] flex justify-center pt-2 px-3 pointer-events-none">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.06] border border-white/[0.08] text-[10px] text-slate-400 backdrop-blur-sm">
              <Loader2 size={10} className="animate-spin" />
              <span>Refreshing chat…</span>
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

              if (msg.role === 'system') {
                return isCompactionNotice(msg.content) ? (
                  <CompactionNoticeBlock key={msg.id} content={msg.content} size="compact" />
                ) : (
                  <div key={msg.id} className="px-3 py-1.5">
                    <div className="mx-auto max-w-[90%] rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-center text-[10px] tracking-wide text-slate-400">
                      {msg.content}
                    </div>
                  </div>
                );
              }

              if (msg.role === 'toolResult') {
                return <ToolResultPill key={msg.id} message={msg} />;
              }

              if (msg.role === 'assistant') {
                const toolCalls = msg.toolCalls || [];
                const hasRunningTool = toolCalls.some(tc => tc.status === 'running');
                const suppressCurrentBubbleText = isCurrentlyStreaming && (
                  streamingPhase !== 'streaming'
                  || suppressLiveBubbleContentRef.current
                  || hasRunningTool
                  || !!activeToolName
                  || !!statusText
                );
                const visibleContent = suppressCurrentBubbleText ? '' : msg.content;
                const visibleThinkingContent = (isCurrentlyStreaming && thinkingContent.trim())
                  ? thinkingContent
                  : (msg.thinkingContent || '');
                const hasThinkingContent = !!visibleThinkingContent.trim();
                const hasContent = !!visibleContent;
                const modelLabel = msg.model ? modelDisplayName(msg.model) : '';
                const timeLabel = msg.createdAt ? msg.createdAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
                const showMessageBubble = hasContent || (isCurrentlyStreaming && !hasThinkingContent);
                const showMeta = hasThinkingContent || hasContent || toolCalls.length > 0;

                return (
                  <div key={msg.id} className="px-3 py-1.5 group">

                    {/* Tool call pills */}
                    {toolCalls.length > 0 && (
                      <div className="mb-1">
                        {toolCalls.map(tc => <ToolCallPill key={tc.id} tool={tc} />)}
                      </div>
                    )}

                    {(hasThinkingContent || showMessageBubble) && (
                      <div className="flex gap-2 items-start">
                        <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5 text-[8px] font-bold text-emerald-400">
                          AI
                        </div>
                        <div className="flex-1 min-w-0 max-w-[90%]">
                          {hasThinkingContent && (
                            <div className="mb-1.5 rounded-2xl rounded-bl-sm border border-violet-400/15 bg-violet-500/[0.08] px-3 py-2 shadow-lg shadow-black/10">
                              <div className="mb-1 flex items-center gap-1.5 text-[9px] font-medium uppercase tracking-wide text-violet-200/75">
                                <Sparkles size={10} className="text-violet-300/75" />
                                <span>thinking</span>
                                {isCurrentlyStreaming && !hasContent ? <span className="h-1 w-1 rounded-full bg-violet-300/70 animate-pulse" /> : null}
                              </div>
                              <div className={`text-[11px] leading-relaxed ${isCurrentlyStreaming && !hasContent ? 'streaming-cursor' : ''}`}>
                                <MarkdownRenderer content={visibleThinkingContent} isStreaming={isCurrentlyStreaming && !hasContent} />
                              </div>
                            </div>
                          )}

                          {showMessageBubble && (
                            <div
                              className={`rounded-2xl rounded-bl-sm px-3 py-2 transition-all duration-500 ${
                                hasContent && visibleContent.startsWith('⚠️')
                                  ? 'bg-red-500/10 border border-red-500/20'
                                  : isCurrentlyStreaming
                                    ? 'border border-dashed bg-[var(--accent-bg-subtle)]'
                                    : 'bg-white/[0.06] border border-solid border-white/[0.08]'
                              }`}
                              style={isCurrentlyStreaming && !(hasContent && visibleContent.startsWith('⚠️'))
                                ? { borderColor: 'var(--accent-border-hover)', boxShadow: '0 0 12px var(--accent-shadow), inset 0 0 0 1px var(--accent-bg)' }
                                : undefined
                              }
                            >
                              {hasContent && visibleContent.startsWith('⚠️') ? (
                                <div className="flex items-start gap-1.5">
                                  <XCircle size={12} className="text-red-400 flex-shrink-0 mt-0.5" />
                                  <div className="text-[11px] text-red-300">{visibleContent.replace(/^⚠️\s*/, '')}</div>
                                </div>
                              ) : (
                                <div className={`text-[11px] leading-relaxed ${isCurrentlyStreaming ? 'streaming-cursor' : ''}`}>
                                  <MarkdownRenderer content={visibleContent} isStreaming={isCurrentlyStreaming} />
                                </div>
                              )}
                            </div>
                          )}

                          {showMeta && (
                            <div className="flex items-center gap-2 mt-1 ml-1 min-h-[16px]">
                              {msg.provenance ? <span className="text-[10px] text-slate-500 italic truncate">{msg.provenance}</span> : null}
                              {modelLabel ? <span className="text-[10px] text-slate-500 truncate">• {modelLabel}</span> : null}
                              {timeLabel ? <span className="text-[10px] text-slate-600 truncate">• {timeLabel}</span> : null}
                              <div className="flex items-center gap-1 ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
                                {hasContent && <CopyButton text={msg.content} />}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
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

      {/* Stream status rail */}
      <AnimatePresence>
        {(isRunning || compactionPhase !== 'idle' || (!wsConnected && Boolean(connectionNotice))) && (
          <ComposerStatusBadge
            phase={isRunning ? streamingPhase : 'idle'}
            toolName={activeToolName}
            statusText={statusText}
            showConnectionLost={!wsConnected && Boolean(connectionNotice)}
            compactionPhase={compactionPhase}
          />
        )}
      </AnimatePresence>

      {/* Composer */}
      {pendingApproval && (
        <ExecApprovalModal
          approval={pendingApproval}
          queueCount={pendingApprovals.length}
          onResolve={resolveApproval}
          onDismiss={dismissApproval}
        />
      )}

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
            <div className="relative flex-1">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => {
                  setInput(e.target.value);
                  refreshSlashAutocomplete(e.target.value, e.target.selectionStart ?? e.target.value.length);
                }}
                onKeyDown={e => {
                  if (showSlashMenu && slashCommands.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setSelectedSlashIndex(prev => (prev + 1) % slashCommands.length);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setSelectedSlashIndex(prev => (prev - 1 + slashCommands.length) % slashCommands.length);
                      return;
                    }
                    if (e.key === 'Tab' || e.key === 'Enter') {
                      e.preventDefault();
                      insertSlashCommand(slashCommands[selectedSlashIndex] || slashCommands[0]);
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setShowSlashMenu(false);
                      return;
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSubmit(e as any);
                  }
                }}
                placeholder={isRunning ? 'Agent is responding…' : `Message Agent…`}
                disabled={isRunning || !sessionReady}
                className={`w-full resize-none rounded-xl px-3 py-2 text-[11px] placeholder-slate-600 focus:outline-none transition-all min-h-[36px] max-h-[120px] overflow-y-auto ${
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
              {showSlashMenu && slashCommands.length > 0 && !isRunning && (
                <SlashCommandMenu
                  commands={slashCommands}
                  selectedIndex={selectedSlashIndex}
                  onSelect={insertSlashCommand}
                />
              )}
            </div>

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
