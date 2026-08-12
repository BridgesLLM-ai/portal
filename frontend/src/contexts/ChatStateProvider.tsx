/**
 * ChatStateProvider — React Context Provider that holds all chat state,
 * processes WS events, and survives route navigation.
 *
 * Lifted from useAgentRuntime.ts. The WS event handler stays registered
 * regardless of which page is active, buffering stream events.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import client from '../api/client';
import { gatewayAPI } from '../api/endpoints';
import type { GatewayPendingQuestion } from '../api/endpoints';
import { authAPI } from '../api/auth';
import { useAuthStore } from './AuthContext';
import {
  createGraduatedThinkingSnapshotTracker,
  extractThinkingChunk,
  isControlOnlyAssistantContent,
  markThinkingSnapshotGraduated,
  mergeAssistantStream,
  mergeThinkingStream,
  projectThinkingChunkAfterGraduation,
  reconcileCumulativeFinalTail,
  resetGraduatedThinkingSnapshotTracker,
  sanitizeAssistantContent,
  sanitizeAssistantChunk,
  seedGraduatedThinkingSnapshot,
  stripOpenClawReplyTags,
} from '../utils/chatStream';
import {
  OpenClawGatewayClient,
  clientMessageIdFromDirectGatewayIdempotencyKey,
  createGatewayDirectUrl,
  gatewayActiveTurnConflictFromError,
  gatewayUnconfirmedSendFromError,
  type GatewayEvent,
  type GatewayChatMessage,
} from '../utils/openclawGatewayClient';
import { normalizeAgentChatModelId } from '../utils/agentChatModelSelection';
import { applyAgentChatSessionModel } from '../utils/agentChatModelSwitch';
import {
  appendCompletedToolCallIfMissing,
  appendToolCallToMessage,
  buildCompletedToolCall,
  buildRunningToolCall,
  finishMatchingToolCallInMessage,
  getLastRunningToolCall,
  updateRunningToolCallInMessage,
} from '../utils/liveTurnProjector';
import { normalizePortalStreamEventFromTurnEvent } from '../utils/runtimeTurnEvents';
import { latestTurnSequence, observeTurnSequence } from '../utils/streamContinuity';
import {
  EMPTY_CUMULATIVE_SNAPSHOT_CURSOR,
  appendCumulativeSnapshotDelta,
  beginCumulativeSnapshotSegment,
  createLatestCallbackDispatcher,
  getVisibleSilenceStatus,
  reconcileCumulativeSnapshot,
  reconcileRunEpoch,
  recordStreamActivity,
  scheduleLatestCallback,
  type CumulativeSnapshotCursor,
  type RetiredRunEpoch,
} from '../utils/streamRuntime';
import { usePublicSettings } from '../hooks/usePublicSettings';
import {
  pruneExpiredExecApprovals,
  removeExecApproval,
  upsertExecApproval,
} from '../utils/execApprovalQueue';
import { getToolStatusText, resolveToolName, isCompactionNotice } from '../utils/toolPresentation';
import { providerUsesPortalStreamBus } from '../utils/agentChatTransport';
import {
  collapseGatewayInjectedAbortMirrors,
  isAbortedDoneEvent,
  resolveToolCompletionStatus,
  selectSnapshotReasoningEvents,
  settleCancelledAssistantMessage,
} from '../utils/agentChatRunLifecycle';
import { getRailSafeStatusText, resolveMaintenanceRailStatus } from '../components/chat/maintenanceRailLifecycle';
import { workspaceAuthorizedFetch } from '../utils/workspaceAuthorizedFetch';
import {
  classifyActivityTitleEvent,
  sanitizeThinkingSubject,
} from '../utils/thinkingSubject';
import {
  createPreambleProgressAccumulator,
  mergePreambleProgressSnapshot,
} from '../utils/preambleProgress';
import { isAskUserQuestionNoLongerOpenError } from '../utils/askUserQuestionError';

const DEBUG_CHAT_STATE = import.meta.env.DEV;
const BUILD_TIME_USE_DIRECT_GATEWAY = import.meta.env.VITE_USE_DIRECT_GATEWAY === 'true';
// Direct gateway writes bypass the Portal's authorization/run-settlement
// broker. Keep the optional transport disabled until those writes can retain
// an exact actor-generation lease through authoritative upstream quiescence.
const DIRECT_GATEWAY_AUTHORIZATION_BROKER_READY = false;
const INITIAL_CHAT_HISTORY_PAGE_SIZE = 80;
const ACTIVITY_TITLE_EXPIRY_MS = 2 * 60_000;
const debugLog = (...args: unknown[]) => {
  if (DEBUG_CHAT_STATE) console.debug('[ChatState]', ...args);
};

/* ═══ Types ═══ */

export interface ToolCall {
  id: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  result?: string;
  status: 'running' | 'done' | 'error';
  arguments?: any;
  order?: number;
}

export interface ExecApprovalRequest {
  id: string;
  request: {
    command: string;
    cwd?: string;
    host?: string;
    security?: string;
    ask?: string;
    agentId?: string;
    sessionKey?: string;
    resolvedPath?: string;
  };
  createdAtMs: number;
  expiresAtMs: number;
}

export interface TextSegment {
  text: string;
  subject?: string;
  position: 'before' | 'after' | 'between';
  kind?: 'text' | 'thinking';
  ts?: number;
  order?: number;
  source?: 'status' | 'reasoning' | 'preamble' | 'text';
}

interface StreamSegment {
  text: string;
  subject?: string;
  ts: number;
  kind: 'text' | 'thinking';
  order: number;
  lane?: 'raw' | 'preamble' | 'status';
}

type ChatStreamTransport = 'portal' | 'direct' | 'sse';

interface ActiveSseTransport {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
  readonly streamClientId: string;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  sessionResolved: boolean;
  handoffRequested: boolean;
  handoffPromise: Promise<boolean> | null;
  stopReason: 'handoff' | 'cancel' | null;
  stopPromise: Promise<void> | null;
}

interface PendingWsAbortResult {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (ok: boolean) => void;
}

interface OutstandingChatDispatch {
  readonly clientMessageId: string;
  readonly assistantId: string;
  readonly sessionKey: string;
}

const STEERING_INTERRUPTED_MARKER = '*(interrupted by steering message)*';
const LIVE_VIEW_DETACHED_MARKER = '*(live view detached — the agent may still be working; latest history reloaded)*';
const STREAM_RECOVERY_GRACE_MS = 45_000;
const VISIBLE_STREAM_SILENCE_MS = 90_000;
const WS_ABORT_RESULT_TIMEOUT_MS = 8_000;
const SSE_LIVE_EVENT_TYPES = new Set([
  'text', 'thinking', 'status', 'tool_start', 'tool_update', 'tool_end',
  'tool_used', 'stream_resume', 'run_resumed', 'compaction_start', 'compaction_end',
]);

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'toolResult';
  content: string;
  createdAt: Date;
  queued?: boolean;
  pendingAck?: boolean;
  provenance?: string;
  model?: string;
  toolCalls?: ToolCall[];
  thinkingContent?: string;
  thinkingSubject?: string;
  toolCallId?: string;
  toolName?: string;
  /** Text segments with their position relative to tool calls (for history reconstruction) */
  segments?: TextSegment[];
  /** Server presentation caps omitted older activity from this single turn. */
  presentationTruncated?: boolean;
  /** Exact active run carried only by Portal runtime-history overlays. */
  runtimeRunId?: string;
  /** Highest normalized runtime event already represented by this overlay. */
  runtimeLastEventSeq?: number;
  /** Provider cumulative cursors represented by the graduated overlay. */
  runtimeThinkingCursors?: Partial<Record<'raw' | 'preamble' | 'status', string>>;
}

export interface MessageQueueItem {
  id: string;
  text: string;
  createdAt: number;
}

export type StreamingPhase = 'idle' | 'thinking' | 'tool' | 'streaming';
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive' | 'max' | 'ultra';
type ReasoningVisibility = 'off' | 'on' | 'stream';
export type SessionControlMutationKind = 'thinking' | 'reasoning' | 'fastMode' | 'compactionModel';

type SessionControlValue = ThinkingLevel | ReasoningVisibility | boolean;

type SessionControlMutationSnapshot = Readonly<{
  generation: number;
  kind: Exclude<SessionControlMutationKind, 'compactionModel'>;
  provider: string;
  session: string;
  previous: SessionControlValue;
  requested: SessionControlValue;
}>;

function readSessionControlValue(payload: any, kind: SessionControlMutationSnapshot['kind']): SessionControlValue | undefined {
  const session = payload?.session && typeof payload.session === 'object' ? payload.session : payload;
  if (!session || typeof session !== 'object') return undefined;

  if (kind === 'fastMode') {
    const candidate = session.fastMode ?? session.settings?.fastMode;
    return typeof candidate === 'boolean' ? candidate : undefined;
  }

  const candidate = kind === 'thinking'
    ? (session.thinkingLevel ?? session.thinking ?? session.settings?.thinking)
    : (session.reasoningLevel ?? session.reasoning ?? session.settings?.reasoning);
  const normalized = typeof candidate === 'string' ? candidate.trim().toLowerCase() : '';
  if (kind === 'thinking') {
    return THINKING_LEVELS.includes(normalized as ThinkingLevel)
      ? normalized as ThinkingLevel
      : undefined;
  }
  return REASONING_VISIBILITY_LEVELS.includes(normalized as ReasoningVisibility)
    ? normalized as ReasoningVisibility
    : undefined;
}

function sessionControlErrorMessage(error: any, fallback: string): string {
  return String(
    error?.response?.data?.detail
    || error?.response?.data?.error
    || error?.message
    || fallback,
  );
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'adaptive', 'high', 'xhigh', 'max', 'ultra'];
const REASONING_VISIBILITY_LEVELS: readonly ReasoningVisibility[] = ['off', 'on', 'stream'];

/* ═══ WS Manager (singleton — identical to original) ═══ */

type WsEventHandler = (data: any) => void;

export interface WsManager {
  ws: WebSocket | null;
  send: (data: any) => boolean;
  addHandler: (handler: WsEventHandler) => void;
  removeHandler: (handler: WsEventHandler) => void;
  onDisconnect: (cb: () => void) => (() => void);
  onReconnect: (cb: () => void) => (() => void);
  isConnected: () => boolean;
  reconnect: () => void;
  close: () => void;
}

function createWsManager(url: string): WsManager {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let intentionallyClosed = false;
  let wasConnectedBefore = false;
  const handlers = new Set<WsEventHandler>();
  const disconnectCallbacks = new Set<() => void>();
  const reconnectCallbacks = new Set<() => void>();

  function connect() {
    if (intentionallyClosed) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
      ws = socket;
    } catch {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      if (ws !== socket) return;
      debugLog('[ws-manager] Connected');
      const isReconnect = wasConnectedBefore;
      wasConnectedBefore = true;
      reconnectAttempts = 0;
      if (isReconnect) {
        for (const cb of reconnectCallbacks) {
          try { cb(); } catch (e) { console.error('[ws-manager] reconnect callback error:', e); }
        }
      }
    };

    socket.onmessage = (event) => {
      if (ws !== socket) return;
      let data: any;
      try { data = JSON.parse(event.data); } catch { return; }
      for (const handler of handlers) {
        try { handler(data); } catch (err) { console.error('[ws-manager] Handler error:', err); }
      }
    };

    socket.onclose = (event) => {
      // Explicit reconnect replaces the socket before the old close event can
      // arrive. Never let that stale callback erase or reschedule its successor.
      if (ws !== socket) return;
      debugLog('[ws-manager] Closed: code=' + event.code + ' reason=' + event.reason + ' intentionallyClosed=' + intentionallyClosed);
      ws = null;

      // Check for auth failure close codes (4001 = unauthorized, or HTTP-style 401/403 in reason)
      // These indicate the token may be expired — try refreshing before giving up
      const isAuthFailure = event.code === 4001 || event.code === 4003 ||
        event.reason?.toLowerCase().includes('unauthorized') ||
        event.reason?.toLowerCase().includes('forbidden') ||
        event.reason?.toLowerCase().includes('expired');

      if (isAuthFailure && !intentionallyClosed) {
        debugLog('[ws-manager] Auth failure detected, attempting token refresh before reconnect');
        // Attempt to refresh the token before reconnecting
        authAPI.refresh()
          .then(() => {
            debugLog('[ws-manager] Token refresh succeeded, scheduling reconnect');
            reconnectAttempts = 0; // Reset backoff after successful refresh
            scheduleReconnect();
          })
          .catch((err) => {
            console.warn('[ws-manager] Token refresh failed, stopping reconnect:', err);
            const status = Number(err?.response?.status || 0);
            if (status === 401 || status === 403) {
              useAuthStore.getState().silentLogout();
            }
            intentionallyClosed = true; // Give up — user will need to re-login
            for (const cb of disconnectCallbacks) {
              try { cb(); } catch (e) { console.error('[ws-manager] disconnect callback error:', e); }
            }
          });
        return;
      }

      if (!intentionallyClosed) {
        for (const cb of disconnectCallbacks) {
          try { cb(); } catch (e) { console.error('[ws-manager] disconnect callback error:', e); }
        }
        scheduleReconnect();
      }
    };

    socket.onerror = () => {};
  }

  function scheduleReconnect() {
    if (reconnectTimer || intentionallyClosed) return;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    debugLog('[ws-manager] Reconnecting in ' + delay + 'ms (attempt ' + reconnectAttempts + ')');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  connect();

  return {
    get ws() { return ws; },
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
      const replacedSocket = ws;
      ws = null;
      if (replacedSocket) {
        try { replacedSocket.close(); } catch {}
      }
      connect();
    },
    close() {
      intentionallyClosed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      const closingSocket = ws;
      ws = null;
      if (closingSocket) { try { closingSocket.close(); } catch {} }
      handlers.clear();
      disconnectCallbacks.clear();
      reconnectCallbacks.clear();
    },
  };
}

// Singleton WS manager — shared across the app lifetime
let sharedWsManager: WsManager | null = null;
let wsManagerRefCount = 0;

function getWsManager(): WsManager {
  if (!sharedWsManager) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const apiUrl = import.meta.env.VITE_API_URL || '';
    let wsUrl: string;
    if (apiUrl) {
      if (apiUrl.startsWith('http')) {
        wsUrl = apiUrl.replace(/^http/, 'ws') + '/gateway/ws';
      } else {
        wsUrl = protocol + '//' + window.location.host + apiUrl + '/gateway/ws';
      }
    } else {
      wsUrl = protocol + '//' + window.location.host + '/api/gateway/ws';
    }
    sharedWsManager = createWsManager(wsUrl);
  }
  wsManagerRefCount++;
  return sharedWsManager;
}

function releaseWsManager() {
  wsManagerRefCount--;
  if (wsManagerRefCount <= 0 && sharedWsManager) {
    sharedWsManager.close();
    sharedWsManager = null;
    wsManagerRefCount = 0;
  }
}

/* ═══ Helpers ═══ */

let msgCounter = 0;
let pageStreamClientId: string | null = null;
function nextId() {
  return 'msg-' + Date.now() + '-' + (++msgCounter);
}

function nextAbortRequestId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId ? `abort-${randomId}` : `abort-${Date.now()}-${++msgCounter}`;
}

function getOrCreateStreamClientId(): string {
  if (pageStreamClientId) return pageStreamClientId;

  const randomId = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  pageStreamClientId = `agent-chat-${randomId}`;
  return pageStreamClientId;
}

const HISTORY_ENVELOPE_TIMESTAMP_RE = /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+[A-Z]{2,4}\]\s*/;

function stripHistoryEnvelope(text: string): string {
  if (!text) return text;
  const match = text.match(HISTORY_ENVELOPE_TIMESTAMP_RE);
  if (match && match.index !== undefined) {
    const beforeTimestamp = text.substring(0, match.index);
    if (
      match.index === 0
      || beforeTimestamp.includes('Conversation info (untrusted metadata)')
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
    // Configured heartbeat prompts are conventionally one bracketed line
    // containing "heartbeat" (e.g. "[OpenClaw heartbeat poll]"); rendering
    // them as user bubbles presented machine polling as conversation.
    /^\[[^\]\n]*heartbeat[^\]\n]*\]$/i,
    /^HEARTBEAT_OK$/i,
    /^Heartbeat check complete(?:d)?\.?$/i,
    /^Pre-compaction memory flush\./i,
    /^Memory flush complete(?:d)?\.?$/i,
    /^\[System\]\s+Your previous turn was interrupted by a gateway restart/i,
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

  if (/^\[System\]\s+Your previous turn was interrupted by a gateway restart/i.test(normalized)) {
    return 'Previous turn interrupted by gateway restart';
  }

  if (/^Read HEARTBEAT\.md if it exists/i.test(normalized)) {
    return 'Heartbeat check started';
  }

  if (/^HEARTBEAT_OK$/i.test(normalized) || /^Heartbeat check complete(?:d)?\.?$/i.test(normalized)) {
    return 'Heartbeat check completed';
  }

  if (/^Pre-compaction memory flush\./i.test(normalized)) {
    return 'Memory flush started';
  }

  if (/^Memory flush complete(?:d)?\.?$/i.test(normalized)) {
    return 'Memory flush completed';
  }

  return null;
}

const MODEL_STORAGE_PREFIX = 'agentChats.lastModel.';
const CHAT_HISTORY_OMITTED_PLACEHOLDER = '[chat.history omitted: message too large]';

function normalizeStoredAgentId(rawAgentId: string | null | undefined): string | undefined {
  const value = String(rawAgentId || '').trim();
  return value && value !== 'main' ? value : undefined;
}

function readStoredAgentId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const storedAgentId = localStorage.getItem('agent-chat-agentId');
  const normalizedAgentId = normalizeStoredAgentId(storedAgentId);
  if (!normalizedAgentId && storedAgentId !== null) {
    localStorage.removeItem('agent-chat-agentId');
  }
  return normalizedAgentId;
}

function normalizeProviderModel(provider: string, rawModel: string): string {
  return normalizeAgentChatModelId(provider, rawModel);
}

function normalizeToolCalls(toolCalls: any, defaultStatus: ToolCall['status'] = 'done'): ToolCall[] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;

  return toolCalls
    .filter((tc) => tc && typeof tc === 'object' && typeof tc.name === 'string' && tc.name.trim())
    .map((tc) => {
      const startedAt = typeof tc.startedAt === 'number' && Number.isFinite(tc.startedAt)
        ? tc.startedAt
        : Date.now();
      const endedAt = typeof tc.endedAt === 'number' && Number.isFinite(tc.endedAt)
        ? tc.endedAt
        : (tc.status === 'running' ? undefined : Date.now());
      return {
        id: typeof tc.id === 'string' && tc.id.trim() ? tc.id : nextId(),
        name: tc.name,
        arguments: tc.arguments,
        startedAt,
        endedAt,
        result: typeof tc.result === 'string' ? tc.result : undefined,
        status: tc.status === 'running' || tc.status === 'error' || tc.status === 'done'
          ? tc.status
          : defaultStatus,
        order: typeof tc.order === 'number' && Number.isFinite(tc.order) ? tc.order : undefined,
      };
    });
}

function defaultCompactionNoticeText(meta?: Record<string, any> | null): string {
  const signal = String(meta?.phase || meta?.status || '').trim().toLowerCase();
  if (signal === 'start' || signal === 'started' || signal === 'compacting' || signal === 'compaction_start') {
    return 'Compacting context…';
  }
  if (meta?.completed === false || signal === 'incomplete' || signal === 'did_not_complete') {
    return 'Context maintenance finished.';
  }
  return 'Context compacted';
}

function resolveCompactionNoticeText(text: string, meta?: Record<string, any> | null): string {
  const normalized = sanitizeHistoryMessageText(text);
  return normalized || defaultCompactionNoticeText(meta);
}

function isHeartbeatPollMarkerText(text: string): boolean {
  return /^\[[^\]\n]*heartbeat[^\]\n]*\]$/i.test(String(text || '').trim());
}

/**
 * History mapping with heartbeat-turn pairing: an assistant reply inside a
 * machine-initiated heartbeat turn whose text is maintenance noise
 * (HEARTBEAT_OK and friends) is dropped even when it carried tool calls —
 * otherwise every scheduled poll leaves an orphan tool row in the visible
 * transcript. A non-OK heartbeat reply is an alert and stays fully visible.
 */
export function parseHistoryMessages(rawMessages: any[]): ChatMessage[] {
  const parsed: ChatMessage[] = [];
  let inHeartbeatTurn = false;
  for (const raw of rawMessages) {
    const role = raw?.role;
    const text = sanitizeHistoryMessageText(typeof raw?.content === 'string' ? raw.content : '');
    if (role === 'user' || role === 'system') {
      inHeartbeatTurn = role === 'user' && isHeartbeatPollMarkerText(text);
    }
    if (inHeartbeatTurn && role === 'assistant' && isHiddenHistoryArtifactText(text)) {
      continue;
    }
    const message = parseHistoryMessage(raw);
    if (message) parsed.push(message);
  }
  return parsed;
}

function parseHistoryMessage(m: any): ChatMessage | null {
  if (m?.__openclaw?.kind === 'compaction') {
    return {
      id: m.id || `compaction-${m.__openclaw.id || Date.now()}`,
      role: 'system',
      content: resolveCompactionNoticeText(typeof m.content === 'string' ? m.content : '', m.__openclaw),
      createdAt: new Date(m.timestamp || Date.now()),
      provenance: 'compaction',
    };
  }

  const rawContent = typeof m.content === 'string' ? m.content : '';
  const sanitizedHistoryText = sanitizeHistoryMessageText(rawContent);
  const rawThinkingContent = typeof m.thinkingContent === 'string' ? sanitizeAssistantContent(m.thinkingContent) : '';
  const rawThinkingSubject = sanitizeThinkingSubject(m.thinkingSubject);
  const isTruncationPlaceholder = m.role === 'assistant' && rawContent === CHAT_HISTORY_OMITTED_PLACEHOLDER;
  if (!isTruncationPlaceholder && isAssistantMaintenanceNoticeMessage({ ...m, content: sanitizedHistoryText, thinkingContent: rawThinkingContent })) {
    return null;
  }
  if (m.role === 'assistant' && !isTruncationPlaceholder && isControlOrMaintenanceAssistantContent(rawContent) && !rawThinkingContent && !(Array.isArray(m.toolCalls) && m.toolCalls.length > 0)) {
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
    provenance: m.provenance || (m.__openclaw?.kind === 'compaction' ? 'compaction' : undefined),
    model: typeof m.model === 'string' ? m.model : undefined,
    thinkingContent: rawThinkingContent || undefined,
    thinkingSubject: rawThinkingSubject || undefined,
    runtimeRunId: m?.__portal?.kind === 'runtime-turn-event-history'
      ? normalizeRunId(m?.__portal?.runId) || undefined
      : undefined,
    runtimeLastEventSeq: m?.__portal?.kind === 'runtime-turn-event-history'
      && Number.isSafeInteger(m?.__portal?.lastEventSeq)
      ? m.__portal.lastEventSeq
      : undefined,
    runtimeThinkingCursors: m?.__portal?.kind === 'runtime-turn-event-history'
      && m?.__portal?.thinkingCursors
      && typeof m.__portal.thinkingCursors === 'object'
      ? {
          ...(typeof m.__portal.thinkingCursors.raw === 'string'
            ? { raw: sanitizeAssistantContent(m.__portal.thinkingCursors.raw) }
            : {}),
          ...(typeof m.__portal.thinkingCursors.status === 'string'
            ? { status: sanitizeAssistantContent(m.__portal.thinkingCursors.status) }
            : {}),
          ...(typeof m.__portal.thinkingCursors.preamble === 'string'
            ? { preamble: sanitizeAssistantContent(m.__portal.thinkingCursors.preamble) }
            : {}),
        }
      : undefined,
  };
  if (m.toolCalls) {
    msg.toolCalls = normalizeToolCalls(m.toolCalls, 'done');
  }
  // Preserve segments for graduated timeline reconstruction
  if (m.segments && Array.isArray(m.segments)) {
    msg.segments = m.segments.flatMap((segment: any) => {
      const kind = segment?.kind === 'thinking' ? 'thinking' as const : 'text' as const;
      const text = typeof segment?.text === 'string' ? sanitizeAssistantContent(segment.text) : '';
      const subject = kind === 'thinking' ? sanitizeThinkingSubject(segment?.subject) : '';
      const source = ['status', 'reasoning', 'preamble', 'text'].includes(String(segment?.source || ''))
        ? segment.source as TextSegment['source']
        : undefined;
      if (!text.trim() && !subject) return [];
      return [{
        text,
        ...(subject ? { subject } : {}),
        position: segment?.position === 'after' || segment?.position === 'between'
          ? segment.position
          : 'before' as const,
        kind,
        ts: typeof segment?.ts === 'number' && Number.isFinite(segment.ts) ? segment.ts : undefined,
        order: Number.isSafeInteger(segment?.order) ? segment.order : undefined,
        ...(source ? { source } : {}),
      }];
    });
  }
  if (m.role === 'toolResult') {
    msg.toolCallId = m.toolCallId;
    msg.toolName = m.toolName;
  }
  return msg;
}

function isGatewayTextBlock(block: any): boolean {
  return Boolean(
    block
    && typeof block === 'object'
    && (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text')
    && typeof block.text === 'string'
  );
}

function gatewayTextFromBlocks(blocks: any[]): string {
  return blocks
    .filter(isGatewayTextBlock)
    .map((block) => block.text as string)
    .join('\n');
}

function gatewayThinkingFromBlocks(blocks: any[]): string {
  return blocks
    .filter((block) => block?.type === 'thinking' && (typeof block.thinking === 'string' || typeof block.text === 'string'))
    .map((block) => (typeof block.thinking === 'string' ? block.thinking : block.text) as string)
    .join('');
}

function gatewayTextFromLiveChatPayload(payload: any): string {
  const content = payload?.message?.content;
  const fromMessageContent = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? gatewayTextFromBlocks(content)
      : '';
  if (fromMessageContent) return fromMessageContent;

  if (typeof payload?.message?.text === 'string') return payload.message.text;
  if (typeof payload?.deltaText === 'string') return payload.deltaText;
  if (typeof payload?.text === 'string') return payload.text;
  if (typeof payload?.content === 'string') return payload.content;
  return '';
}

function gatewayThinkingFromLiveChatPayload(payload: any): string {
  const content = payload?.message?.content;
  const fromBlocks = Array.isArray(content) ? gatewayThinkingFromBlocks(content) : '';
  if (fromBlocks) return fromBlocks;
  if (typeof payload?.thinking === 'string') return payload.thinking;
  if (typeof payload?.thinkingText === 'string') return payload.thinkingText;
  return '';
}

function gatewayModelFromPayload(payload: any): string {
  const message = payload?.message;
  const candidates = [
    message?.model,
    message?.modelId,
    message?.model_id,
    message?.actualModel,
    message?.executedModel,
    message?.metadata?.model,
    payload?.model,
    payload?.modelId,
    payload?.model_id,
    payload?.actualModel,
    payload?.executedModel,
    payload?.metadata?.model,
    payload?.session?.resolved?.model && payload?.session?.resolved?.modelProvider
      ? `${payload.session.resolved.modelProvider}/${payload.session.resolved.model}`
      : '',
    payload?.session?.modelProvider && payload?.session?.model
      ? `${payload.session.modelProvider}/${payload.session.model}`
      : '',
    payload?.session?.model,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

/**
 * Extract text content from a gateway message.
 * Gateway/WebChat history can contain OpenAI-style `input_text`/`output_text`
 * blocks as well as generic `text` blocks. Match Control UI by treating all
 * three as visible transcript text.
 */
function extractTextFromGatewayMessage(msg: GatewayChatMessage): string {
  const rawText = typeof msg.content === 'string'
    ? msg.content
    : Array.isArray(msg.content)
      ? gatewayTextFromBlocks(msg.content)
      : '';

  return sanitizeHistoryMessageText(rawText);
}

/**
 * Extract tool calls from a gateway message.
 */
function extractToolCallsFromGatewayMessage(msg: GatewayChatMessage): ToolCall[] | undefined {
  const blockCalls = Array.isArray(msg.content)
    ? msg.content
        .filter((block) => block.type === 'toolCall' && block.name)
        .map((block) => ({
          id: block.id || nextId(),
          name: block.name as string,
          arguments: block.arguments,
          startedAt: Date.now(),
          endedAt: Date.now(),
          status: 'done' as const,
        }))
    : [];

  const explicitCalls = Array.isArray(msg.toolCalls)
    ? msg.toolCalls.map((toolCall) => ({
        id: toolCall.id || nextId(),
        name: toolCall.name,
        arguments: toolCall.arguments,
        startedAt: Date.now(),
        endedAt: Date.now(),
        status: 'done' as const,
      }))
    : [];

  const mergedCalls = [...explicitCalls, ...blockCalls];
  if (mergedCalls.length === 0) return undefined;

  const deduped = mergedCalls.filter((toolCall, index, allCalls) => {
    const callId = typeof toolCall.id === 'string' ? toolCall.id.trim() : '';
    const key = callId || `${toolCall.name}:${index}`;
    return allCalls.findIndex((candidate, candidateIndex) => {
      const candidateId = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const candidateKey = candidateId || `${candidate.name}:${candidateIndex}`;
      return candidateKey === key;
    }) === index;
  });

  return normalizeToolCalls(deduped, 'done');
}

/**
 * Extract thinking content from a gateway message.
 */
function extractThinkingFromGatewayMessage(msg: GatewayChatMessage): string | undefined {
  if (!Array.isArray(msg.content)) return undefined;

  const thinking = sanitizeAssistantContent(msg.content
    .filter((block) => block.type === 'thinking' && (typeof block.thinking === 'string' || typeof block.text === 'string'))
    .map((block) => (typeof block.thinking === 'string' ? block.thinking : block.text) as string)
    .join('\n'));

  return thinking || undefined;
}

function normalizePortalNewSessionAlias(rawSession: string): string {
  const sessionKey = String(rawSession || '').trim();
  if (!sessionKey) return '';
  if (sessionKey.startsWith('portal-new-')) return sessionKey.replace(/^portal-/, '');
  if (!sessionKey.startsWith('agent:')) return sessionKey;

  const parts = sessionKey.split(':');
  if (parts.length < 3) return sessionKey;

  const agentId = parts[1]?.trim() || 'main';
  const sessionName = parts.slice(2).join(':').trim();
  if (!sessionName.startsWith('portal-new-')) return sessionKey;
  return `agent:${agentId}:${sessionName.replace(/^portal-/, '')}`;
}

function toConcreteOpenClawSessionKey(rawSession: string, rawAgentId?: string | null): string {
  const sessionKey = normalizePortalNewSessionAlias(String(rawSession || '').trim());
  if (!sessionKey) return 'agent:main:main';
  if (sessionKey.startsWith('agent:')) return sessionKey;

  const agentKey = String(rawAgentId || '').trim() || 'main';
  if (sessionKey === 'main') return `agent:${agentKey}:main`;
  if (sessionKey.startsWith('new-')) return `agent:${agentKey}:${sessionKey}`;
  return sessionKey;
}

function normalizeRunId(rawRunId: unknown): string | null {
  const runId = typeof rawRunId === 'string' ? rawRunId.trim() : '';
  return runId || null;
}

function resolveCompatibilityToolReplayIdentity(
  payload: any,
  fallbackSessionKey?: string | null,
): string {
  const explicitId = typeof payload?.toolCallId === 'string' && payload.toolCallId.trim()
    ? payload.toolCallId.trim()
    : typeof payload?.id === 'string' && payload.id.trim()
      ? payload.id.trim()
      : typeof payload?.turnEvent?.tool?.id === 'string' && payload.turnEvent.tool.id.trim()
        ? payload.turnEvent.tool.id.trim()
        : '';
  if (explicitId) return explicitId;

  const runId = normalizeRunId(payload?.runId || payload?.turnEvent?.runId);
  const rawSequence = payload?.seq ?? payload?.turnEvent?.seq;
  const sequence = typeof rawSequence === 'number'
    ? rawSequence
    : typeof rawSequence === 'string' && rawSequence.trim()
      ? Number(rawSequence)
      : Number.NaN;
  if (!runId || !Number.isSafeInteger(sequence) || sequence < 0) return '';

  const sessionKey = String(
    payload?.sessionKey
    || payload?.turnEvent?.sessionKey
    || fallbackSessionKey
    || 'unknown-session',
  ).trim() || 'unknown-session';
  return `compat-tool:${encodeURIComponent(sessionKey)}:${encodeURIComponent(runId)}:${sequence}`;
}

function normalizeThinkingProgressTokens(rawProgressTokens: unknown): number | null {
  if (
    typeof rawProgressTokens !== 'number'
    || !Number.isFinite(rawProgressTokens)
    || rawProgressTokens <= 0
  ) return null;
  return Math.floor(rawProgressTokens);
}

function formatThinkingProgressStatus(rawProgressTokens: unknown): string | null {
  const progressTokens = normalizeThinkingProgressTokens(rawProgressTokens);
  return progressTokens === null
    ? null
    : `Thinking… (~${progressTokens.toLocaleString('en-US')} tokens)`;
}

function isVerifiedDirectContinuationFrame(evt: GatewayEvent): boolean {
  const payload = evt.payload as any;
  if (evt.event === 'chat') {
    if (payload?.state !== 'delta') return false;
    return Boolean(
      gatewayTextFromLiveChatPayload(payload).trim()
      || gatewayThinkingFromLiveChatPayload(payload).trim(),
    );
  }
  if (evt.event !== 'agent') return false;

  const stream = String(payload?.stream || '').toLowerCase();
  const data = payload?.data || {};
  const phase = String(data.phase || data.status || '').toLowerCase();
  const hasContent = [data.text, data.delta, data.content, data.progressText]
    .some((value) => typeof value === 'string' && value.trim());

  if (stream === 'assistant') return hasContent;
  if (stream === 'thinking') {
    return hasContent || normalizeThinkingProgressTokens(data.progressTokens) !== null;
  }
  if (stream === 'lifecycle') return phase === 'start' || phase === 'started' || phase === 'running';
  if (stream === 'tool') return phase === 'start';
  if (stream === 'item') {
    const kind = String(data.kind || '').toLowerCase();
    if (kind === 'preamble' || kind === 'analysis') return hasContent;
  }
  return false;
}

/**
 * Map a gateway message to our ChatMessage format.
 */
function mapGatewayMessage(msg: GatewayChatMessage): ChatMessage | null {
  if (msg.__openclaw?.kind === 'compaction') {
    return {
      id: msg.id || msg.messageId || `compaction-${msg.__openclaw.id || Date.now()}`,
      role: 'system',
      content: resolveCompactionNoticeText(extractTextFromGatewayMessage(msg), msg.__openclaw),
      createdAt: new Date(msg.timestamp || Date.now()),
      provenance: 'compaction',
    };
  }

  const text = extractTextFromGatewayMessage(msg);
  const toolCalls = extractToolCallsFromGatewayMessage(msg);
  const thinking = extractThinkingFromGatewayMessage(msg);
  const isTruncationPlaceholder = msg.role === 'assistant' && text === CHAT_HISTORY_OMITTED_PLACEHOLDER;
  if (!isTruncationPlaceholder && isAssistantMaintenanceNoticeMessage({ role: msg.role, content: text, thinkingContent: thinking, toolCalls })) {
    return null;
  }
  if (msg.role === 'assistant' && !isTruncationPlaceholder && isControlOrMaintenanceAssistantContent(text) && !thinking && !toolCalls?.length) {
    return null;
  }
  if (msg.role === 'assistant' && !isTruncationPlaceholder && isHiddenHistoryArtifactText(text) && !thinking && !toolCalls?.length) {
    return null;
  }
  if ((msg.role === 'user' || msg.role === 'system') && isHiddenHistoryArtifactText(text)) {
    const summary = summarizeHiddenHistoryArtifactText(text);
    if (!summary) return null;
    return {
      id: msg.id || msg.messageId || `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      content: summary,
      createdAt: new Date(msg.timestamp || Date.now()),
      provenance: 'hidden-history-artifact',
    };
  }
  if (!text && msg.role !== 'assistant' && msg.role !== 'toolResult') {
    return null;
  }

  return {
    id: msg.id || msg.messageId || `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: isTruncationPlaceholder ? 'system' : (msg.role as 'user' | 'assistant' | 'system' | 'toolResult'),
    content: isTruncationPlaceholder
      ? 'Earlier assistant output was omitted from history because the message was too large.'
      : (msg.role === 'assistant' ? sanitizeAssistantContent(text) : text),
    createdAt: new Date(msg.timestamp || Date.now()),
    provenance: typeof (msg as any).provenance === 'string' ? (msg as any).provenance : undefined,
    model: typeof (msg as any).model === 'string' ? (msg as any).model : undefined,
    toolCalls,
    thinkingContent: thinking,
    runtimeRunId: (msg as any)?.__portal?.kind === 'runtime-turn-event-history'
      ? normalizeRunId((msg as any)?.__portal?.runId) || undefined
      : undefined,
    runtimeLastEventSeq: (msg as any)?.__portal?.kind === 'runtime-turn-event-history'
      && Number.isSafeInteger((msg as any)?.__portal?.lastEventSeq)
      ? (msg as any).__portal.lastEventSeq
      : undefined,
    runtimeThinkingCursors: (msg as any)?.__portal?.kind === 'runtime-turn-event-history'
      && (msg as any)?.__portal?.thinkingCursors
      && typeof (msg as any).__portal.thinkingCursors === 'object'
      ? {
          ...(typeof (msg as any).__portal.thinkingCursors.raw === 'string'
            ? { raw: sanitizeAssistantContent((msg as any).__portal.thinkingCursors.raw) }
            : {}),
          ...(typeof (msg as any).__portal.thinkingCursors.status === 'string'
            ? { status: sanitizeAssistantContent((msg as any).__portal.thinkingCursors.status) }
            : {}),
          ...(typeof (msg as any).__portal.thinkingCursors.preamble === 'string'
            ? { preamble: sanitizeAssistantContent((msg as any).__portal.thinkingCursors.preamble) }
            : {}),
        }
      : undefined,
  };
}

const HISTORY_REPLAY_DUPLICATE_WINDOW_MS = 5_000;
const LOCAL_PENDING_ACK_WINDOW_MS = 120_000;
const ACTIVE_ASSISTANT_USER_BOUNDARY_TOLERANCE_MS = 10_000;
const LOCAL_OPTIMISTIC_ASSISTANT_TAIL_WINDOW_MS = 30_000;

function normalizeHistoryReplayContent(content: string): string {
  return (content || '').replace(/\r\n/g, '\n').trim();
}

function isMessageToolName(name: unknown): boolean {
  return String(name || '').trim().toLowerCase() === 'message';
}

function isGenericAnalysisMetadataText(text: string): boolean {
  const normalized = normalizeHistoryReplayContent(text).replace(/\s+/g, ' ').toLowerCase();
  return [
    'reasoning',
    'analysis',
    'start',
    'started',
    'running',
    'end',
    'ended',
    'complete',
    'completed',
    'analyzing…',
    'analyzing...',
    'analysis complete.',
    'analysis complete',
  ].includes(normalized);
}

function extractVisibleAnalysisThinkingText(data: Record<string, any> | null | undefined): string {
  if (!data || typeof data !== 'object') return '';
  // OpenClaw item.analysis events are usually lifecycle metadata. The actual
  // visible reasoning stream arrives on stream='thinking'. Never promote titles
  // like "Reasoning" into thought text.
  const candidates = [data.delta, data.text, data.content, data.message, data.statusText];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed || isGenericAnalysisMetadataText(trimmed)) continue;
    return trimmed;
  }
  return '';
}

function collectGatewayContentStrings(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const values: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, any>;
    if (typeof entry.content === 'string') values.push(entry.content);
    if (typeof entry.text === 'string') values.push(entry.text);
  }
  return values;
}

function extractMessageToolSourceReplyTextFromGatewayPayload(payload: any): string {
  const message = payload?.message ?? payload;
  if (!message || typeof message !== 'object') return '';

  const role = typeof message.role === 'string'
    ? message.role.trim().toLowerCase()
    : (typeof message.type === 'string' ? message.type.trim().toLowerCase() : '');
  if (role !== 'toolresult' && role !== 'tool_result' && role !== 'tool') return '';

  const toolName = message.toolName ?? message.name ?? message.tool_name ?? payload?.toolName ?? payload?.name ?? payload?.tool_name;
  const payloadCandidates: Record<string, any>[] = [];
  for (const candidate of [payload, message]) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) payloadCandidates.push(candidate);
  }
  for (const raw of collectGatewayContentStrings(message.content ?? message.text ?? '')) {
    const parsed = parseToolResultPayload(raw);
    if (parsed) payloadCandidates.push(parsed);
  }

  for (const candidate of payloadCandidates) {
    const mode = typeof candidate.sourceReplyDeliveryMode === 'string'
      ? candidate.sourceReplyDeliveryMode.trim().toLowerCase()
      : '';
    const text = typeof candidate.sourceReply?.text === 'string'
      ? candidate.sourceReply.text
      : (typeof candidate.message === 'string' ? candidate.message : '');
    if (!text.trim()) continue;
    if (mode === 'message_tool_only' || (isMessageToolName(toolName) && candidate.sourceReply)) {
      return normalizeHistoryReplayContent(sanitizeAssistantContent(text));
    }
  }
  return '';
}

function isStandaloneMaintenanceNoticeContent(text: string): boolean {
  const normalized = sanitizeHistoryMessageText(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || !isCompactionNotice(normalized)) return false;

  const marker = normalized.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return [
    /^context compacted\.?$/i,
    /^context maintenance (?:in progress|finished|complete(?:d)?)\.?$/i,
    /^compacting context[.…]*$/i,
    /^preparing (?:context maintenance|compaction)[.…]*$/i,
    /^memory flush(?: started| complete(?:d)?| in progress)?[.…]*$/i,
    /^heartbeat check (?:started|complete(?:d)?)[.…]*$/i,
    /^compacted\s*\([^)]{1,80}\)(?:\s*[•-]\s*context\b.*)?$/i,
    /^compaction (?:complete(?:d)?|finished|in progress|started|incomplete|did not complete)\.?$/i,
    /^compaction skipped(?::.*)?$/i,
  ].some((pattern) => pattern.test(marker));
}

function isAssistantMaintenanceNoticeMessage(message: {
  role?: unknown;
  content?: unknown;
  thinkingContent?: unknown;
  toolCalls?: unknown;
}): boolean {
  if (message?.role !== 'assistant') return false;
  const content = typeof message.content === 'string' ? sanitizeHistoryMessageText(message.content) : '';
  if (!content || !isStandaloneMaintenanceNoticeContent(content)) return false;
  if (typeof message.thinkingContent === 'string' && message.thinkingContent.trim()) return false;
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) return false;
  return true;
}

function isControlOrMaintenanceAssistantContent(text: string): boolean {
  return isControlOnlyAssistantContent(text || '') || isStandaloneMaintenanceNoticeContent(text || '');
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

function isLikelyHistoryReplayDuplicate(previous: ChatMessage | undefined, next: ChatMessage): boolean {
  if (!previous || previous.role !== next.role || next.role !== 'user') return false;
  // Distinct upstream IDs are distinct user actions, even when the user sends
  // identical text twice inside the replay window. Heuristic content/time
  // matching is reserved for rows where at least one side lacks identity.
  if (previous.id && next.id && previous.id !== next.id) return false;

  const previousContent = normalizeHistoryReplayContent(previous.content);
  const nextContent = normalizeHistoryReplayContent(next.content);
  if (!previousContent || previousContent !== nextContent) return false;

  const previousTs = previous.createdAt instanceof Date ? previous.createdAt.getTime() : NaN;
  const nextTs = next.createdAt instanceof Date ? next.createdAt.getTime() : NaN;
  if (!Number.isFinite(previousTs) || !Number.isFinite(nextTs) || nextTs < previousTs) return false;

  return (nextTs - previousTs) <= HISTORY_REPLAY_DUPLICATE_WINDOW_MS;
}

function isTrajectoryRecoveryMessage(message: ChatMessage): boolean {
  return message.provenance === 'trajectory-recovery'
    || (typeof message.id === 'string' && message.id.startsWith('trajectory-'));
}

function isLikelyTrajectoryRecoveryDuplicate(existing: ChatMessage, next: ChatMessage): boolean {
  if (!isTrajectoryRecoveryMessage(existing) && !isTrajectoryRecoveryMessage(next)) return false;
  if (existing.role !== next.role || (next.role !== 'user' && next.role !== 'assistant')) return false;

  const existingContent = normalizeHistoryReplayContent(existing.content);
  const nextContent = normalizeHistoryReplayContent(next.content);
  if (!existingContent || existingContent !== nextContent) return false;

  const existingTs = existing.createdAt instanceof Date ? existing.createdAt.getTime() : NaN;
  const nextTs = next.createdAt instanceof Date ? next.createdAt.getTime() : NaN;
  if (!Number.isFinite(existingTs) || !Number.isFinite(nextTs)) return false;

  return Math.abs(nextTs - existingTs) <= LOCAL_PENDING_ACK_WINDOW_MS;
}

function extractMessageToolVisibleText(toolCall: ToolCall | undefined): string {
  if (!toolCall) return '';
  const toolName = String(toolCall.name || '').trim().toLowerCase();
  if (toolName !== 'message') return '';

  const args = toolCall.arguments;
  let candidate = '';
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return '';
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        candidate = typeof parsed.message === 'string'
          ? parsed.message
          : (typeof parsed.text === 'string'
              ? parsed.text
              : (typeof parsed.content === 'string' ? parsed.content : ''));
      } else {
        candidate = trimmed;
      }
    } catch {
      candidate = trimmed;
    }
  } else if (args && typeof args === 'object') {
    candidate = typeof args.message === 'string'
      ? args.message
      : (typeof args.text === 'string'
          ? args.text
          : (typeof args.content === 'string'
              ? args.content
              : (typeof args.body === 'string' ? args.body : '')));
  }

  return sanitizeAssistantContent(candidate).trim();
}

function findMatchingMessageToolCall(message: ChatMessage, visibleText: string): ToolCall | undefined {
  const normalizedVisibleText = normalizeHistoryReplayContent(visibleText);
  if (!normalizedVisibleText || !Array.isArray(message.toolCalls)) return undefined;
  const exact = message.toolCalls.find((toolCall) => normalizeHistoryReplayContent(extractMessageToolVisibleText(toolCall)) === normalizedVisibleText);
  if (exact) return exact;

  const messageTools = message.toolCalls.filter((toolCall) => String(toolCall?.name || '').trim().toLowerCase() === 'message');
  if (messageTools.length === 1 && !normalizeHistoryReplayContent(extractMessageToolVisibleText(messageTools[0]))) {
    return messageTools[0];
  }
  return undefined;
}

function addMessageToolDeliverySegment(target: ChatMessage, deliveryText: string, toolCall: ToolCall): ChatMessage {
  const normalizedDeliveryText = normalizeHistoryReplayContent(deliveryText);
  if (!normalizedDeliveryText) return target;
  const existingSegments = Array.isArray(target.segments) ? target.segments : [];
  if (existingSegments.some((segment) => normalizeHistoryReplayContent(segment.text) === normalizedDeliveryText)) {
    return target;
  }

  const targetTs = target.createdAt instanceof Date ? target.createdAt.getTime() : Date.now();
  const toolTs = typeof toolCall.endedAt === 'number' && Number.isFinite(toolCall.endedAt)
    ? toolCall.endedAt
    : (typeof toolCall.startedAt === 'number' && Number.isFinite(toolCall.startedAt) ? toolCall.startedAt : targetTs);

  return {
    ...target,
    segments: [
      ...existingSegments,
      {
        text: normalizedDeliveryText,
        position: 'between',
        kind: 'text',
        ts: toolTs + 1,
        order: existingSegments.length,
      },
    ],
  };
}

function isMessageToolOnlyAssistant(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false;
  const content = normalizeHistoryReplayContent(message.content).toLowerCase();
  if (content && content !== 'message') return false;
  const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  return content === 'message' || (calls.length > 0 && calls.every((tool) => tool?.name === 'message'));
}

function parseToolResultPayload(content: string): Record<string, any> | null {
  const normalized = String(content || '').trim();
  if (!normalized.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function extractMessageToolSourceReplyText(message: ChatMessage): string {
  if (message.role !== 'toolResult') return '';
  const payload = parseToolResultPayload(message.content);
  if (!payload) return '';
  if (payload.sourceReplyDeliveryMode !== 'message_tool_only') return '';
  const sourceText = typeof payload.sourceReply?.text === 'string'
    ? payload.sourceReply.text
    : (typeof payload.message === 'string' ? payload.message : '');
  return normalizeHistoryReplayContent(sourceText);
}

function isDeliveryStatusText(text: string): boolean {
  const normalized = normalizeHistoryReplayContent(text);
  if (!normalized) return false;
  return [
    /^sent (?:the |a |an )?.{1,160}(?:recommendations|recipe|recipes|code|answer|response|reply|message|summary|details|instructions|analysis|report|results|update)s?\.?$/i,
    /^sent\b.{0,260}\.?$/i,
    /^sent message to (?:web ?chat|current(?: chat| run)?|the user)\.?$/i,
    /^message sent(?: to (?:web ?chat|current(?: chat| run)?|the user))?\.?$/i,
    /^answered in (?:the )?web ?chat(?:.*)?\.?$/i,
    /^reported .{1,180} in (?:the )?web ?chat\.?$/i,
    /^elaborated in (?:the )?web ?chat(?:.*)?\.?$/i,
  ].some((pattern) => pattern.test(normalized));
}

function isMessageToolDeliveryStatusArtifact(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (message.thinkingContent || (Array.isArray(message.segments) && message.segments.length > 0)) return false;
  const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  const nonMessageCalls = calls.filter((tool) => String(tool?.name || '').trim().toLowerCase() !== 'message');
  if (nonMessageCalls.length > 0) return false;
  return isDeliveryStatusText(message.content);
}

function stripMessageDeliveryToolArtifacts(messages: ChatMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant') return [message];
    const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    if (calls.length === 0) return isMessageToolDeliveryStatusArtifact(message) ? [] : [message];

    const nonMessageCalls = calls.filter((tool) => String(tool?.name || '').trim().toLowerCase() !== 'message');
    const messageCalls = calls.length - nonMessageCalls.length;

    if (messageCalls === 0) return [message];
    if (nonMessageCalls.length === 0) {
      const content = normalizeHistoryReplayContent(message.content);
      // A lone message tool is delivery plumbing. If it carried real user-visible
      // text, OpenClaw also persists that text as a normal assistant message or
      // sourceReply payload; keep this history path focused on the transcript.
      if (!content || isDeliveryStatusText(content) || content.toLowerCase() === 'message') return [];
      return [{ ...message, toolCalls: undefined }];
    }

    return [{ ...message, toolCalls: nonMessageCalls }];
  });
}

function normalizeOutOfTurnMessageDeliveryMirrors(messages: ChatMessage[]): ChatMessage[] {
  const skip = new Set<number>();
  const insertAt = new Map<number, ChatMessage[]>();

  const queueInsert = (index: number, message: ChatMessage) => {
    const existing = insertAt.get(index) || [];
    if (!existing.some((candidate) => normalizeHistoryReplayContent(candidate.content) === normalizeHistoryReplayContent(message.content))) {
      existing.push(message);
    }
    insertAt.set(index, existing);
  };

  for (let i = 0; i < messages.length - 1; i++) {
    if (!isMessageToolOnlyAssistant(messages[i])) continue;
    const resultMessage = messages[i + 1];
    const sourceReplyText = extractMessageToolSourceReplyText(resultMessage);
    if (!sourceReplyText) continue;

    skip.add(i);
    skip.add(i + 1);

    // OpenClaw 2026.5.x direct-webchat sessions persist a bookkeeping assistant
    // message after the internal message tool, e.g. "Sent the tic-tac-toe game
    // code." or "Sent message to Web chat". That is delivery state, not chat
    // content. Hide any such summaries immediately following the tool result.
    for (let j = i + 2; j < messages.length && j <= i + 5; j++) {
      const candidate = messages[j];
      if (!candidate || candidate.role === 'user') break;
      if (isMessageToolDeliveryStatusArtifact(candidate)) {
        skip.add(j);
        continue;
      }
      break;
    }

    // If the real visible reply is already persisted after the tool result,
    // leave that full assistant message in place. Otherwise synthesize a visible
    // assistant bubble at the tool's chronological position from sourceReply.text.
    const mirrorIndex = messages.findIndex((candidate, index) => (
      index > i + 1
      && candidate.role === 'assistant'
      && normalizeHistoryReplayContent(candidate.content) === sourceReplyText
    ));

    if (mirrorIndex < 0) {
      const toolTs = messages[i].createdAt instanceof Date ? messages[i].createdAt.getTime() : Date.now();
      queueInsert(i, {
        id: `${messages[i].id || resultMessage.id || `message-tool-${i}`}:source-reply`,
        role: 'assistant',
        content: sourceReplyText,
        createdAt: new Date(toolTs + 1),
        provenance: 'message-tool-source-reply',
      });
    }
  }

  const normalized: ChatMessage[] = [];
  messages.forEach((message, index) => {
    const inserted = insertAt.get(index);
    if (inserted?.length) normalized.push(...inserted);
    if (!skip.has(index)) normalized.push(message);
  });
  return normalized;
}

function weaveMessageToolDeliveryMirrors(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const content = normalizeHistoryReplayContent(msg.content);
      if (content) {
        let attachedToMessageTool = false;
        for (let i = result.length - 1; i >= 0 && i >= result.length - 16; i--) {
          const candidate = result[i];
          if (candidate.role === 'user') break;
          if (candidate.role !== 'assistant' || !candidate.toolCalls?.length) continue;
          const matchingTool = findMatchingMessageToolCall(candidate, content);
          if (!matchingTool) continue;
          result[i] = addMessageToolDeliverySegment(candidate, content, matchingTool);
          attachedToMessageTool = true;
          break;
        }
        // OpenClaw's delivery mirror records the visible text after the final event,
        // but it semantically belongs to the earlier message tool call. Keep it in
        // that turn's timeline and suppress the late duplicate bubble.
        if (attachedToMessageTool) continue;
      }
    }
    result.push(msg);
  }
  return result;
}

function orderMessageToolVisibleMirrorsBeforeFinal(messages: ChatMessage[]): ChatMessage[] {
  const moved = new Set<number>();
  const ordered: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (moved.has(i)) continue;

    const current = messages[i];
    const currentText = current?.role === 'assistant' ? normalizeHistoryReplayContent(current.content) : '';
    const currentHasMessageTool = current?.role === 'assistant'
      && Array.isArray(current.toolCalls)
      && current.toolCalls.some((tool) => String(tool?.name || '').trim().toLowerCase() === 'message');

    if (currentHasMessageTool && currentText) {
      let visibleMirrorIndex = -1;
      for (let j = i + 1; j < messages.length && j <= i + 12; j++) {
        const candidate = messages[j];
        if (candidate.role === 'user') break;
        if (candidate.role !== 'assistant') continue;
        const candidateText = normalizeHistoryReplayContent(candidate.content)
          || normalizeHistoryReplayContent((candidate.segments || []).map((segment) => segment.text).join('\n'));
        const candidateHasTools = Array.isArray(candidate.toolCalls) && candidate.toolCalls.length > 0;
        if (candidateText && candidateText !== currentText && (!candidateHasTools || isMessageToolOnlyAssistant(candidate))) {
          visibleMirrorIndex = j;
          break;
        }
      }

      if (visibleMirrorIndex >= 0) {
        // Some enhanced/direct history payloads merge the message tool into the
        // final assistant message, leaving the visible delivery mirror after it
        // and sometimes separated by hidden artifacts. Display chronology should
        // still be user → visible delivery → final answer.
        ordered.push(messages[visibleMirrorIndex], current);
        moved.add(visibleMirrorIndex);
        continue;
      }
    }

    ordered.push(current);
  }

  return ordered;
}

function dedupeHistoryMessages(messages: ChatMessage[]): ChatMessage[] {
  const seenIds = new Set<string>();
  const seenSignatures = new Set<string>();
  const deduped: ChatMessage[] = [];
  for (const msg of collapseGatewayInjectedAbortMirrors(messages)) {
    if (msg.id && seenIds.has(msg.id)) continue;
    const previous = deduped[deduped.length - 1];
    if (isLikelyHistoryReplayDuplicate(previous, msg)) continue;
    if (isEquivalentCompactionNotice(previous, msg)) continue;

    const trajectoryDuplicateIndex = deduped.findIndex((existing) => isLikelyTrajectoryRecoveryDuplicate(existing, msg));
    if (trajectoryDuplicateIndex >= 0) {
      if (isTrajectoryRecoveryMessage(deduped[trajectoryDuplicateIndex]) && !isTrajectoryRecoveryMessage(msg)) {
        const previous = deduped[trajectoryDuplicateIndex];
        const previousId = previous.id;
        if (previousId) seenIds.delete(previousId);
        const previousTs = previous.createdAt instanceof Date ? previous.createdAt.getTime() : Date.now();
        seenSignatures.delete(`${previous.role}|${Number.isFinite(previousTs) ? previousTs : 0}|${previous.content}`);
        // Do not replace in-place. Trajectory recovery can be slightly out of
        // order; keep the canonical persisted message at its real position.
        deduped.splice(trajectoryDuplicateIndex, 1);
      } else {
        continue;
      }
    }

    const ts = msg.createdAt instanceof Date ? msg.createdAt.getTime() : Date.now();
    const signature = `${msg.role}|${Number.isFinite(ts) ? ts : 0}|${msg.content}`;
    if (msg.role === 'assistant' && seenSignatures.has(signature)) continue;
    if (msg.id) seenIds.add(msg.id);
    seenSignatures.add(signature);
    deduped.push(msg);
  }
  return deduped;
}

function isLikelyCommittedPendingUser(localMessage: ChatMessage, committedMessage: ChatMessage): boolean {
  if (localMessage.role !== 'user' || committedMessage.role !== 'user') return false;

  const localContent = normalizeHistoryReplayContent(localMessage.content);
  const committedContent = normalizeHistoryReplayContent(committedMessage.content);
  if (!localContent || localContent !== committedContent) return false;

  const localTs = localMessage.createdAt instanceof Date ? localMessage.createdAt.getTime() : NaN;
  const committedTs = committedMessage.createdAt instanceof Date ? committedMessage.createdAt.getTime() : NaN;
  if (!Number.isFinite(localTs) || !Number.isFinite(committedTs)) return false;

  // A matching upstream echo gives local Agent Chat rows a server timestamp.
  // Use that narrow authority so an older identical prompt cannot consume the
  // newly accepted row while its own durable projection is still lagging.
  if (localMessage.provenance === 'live-local-user') {
    return committedTs >= localTs && committedTs <= localTs + 10_000;
  }

  const earliestExpectedCommitTs = localTs - 10_000;
  const latestExpectedCommitTs = localTs + LOCAL_PENDING_ACK_WINDOW_MS;
  return committedTs >= earliestExpectedCommitTs && committedTs <= latestExpectedCommitTs;
}

function enrichAssistantHistoryFromLocalProjection(historyMessage: ChatMessage, localMessage: ChatMessage): void {
  if (historyMessage.role !== 'assistant' || localMessage.role !== 'assistant') return;

  const localSegments = Array.isArray(localMessage.segments)
    ? localMessage.segments.filter((segment) => segment?.text?.trim() || segment?.subject)
    : [];
  const historySegments = Array.isArray(historyMessage.segments)
    ? historyMessage.segments.filter((segment) => segment?.text?.trim() || segment?.subject)
    : [];
  if (localSegments.length > historySegments.length) {
    historyMessage.segments = localSegments;
  }

  if (!historyMessage.thinkingContent?.trim() && localMessage.thinkingContent?.trim()) {
    historyMessage.thinkingContent = localMessage.thinkingContent;
  }
  if (!historyMessage.thinkingSubject && localMessage.thinkingSubject) {
    historyMessage.thinkingSubject = localMessage.thinkingSubject;
  }

  const localToolCalls = Array.isArray(localMessage.toolCalls) ? localMessage.toolCalls : [];
  const historyToolCalls = Array.isArray(historyMessage.toolCalls) ? historyMessage.toolCalls : [];
  if (localToolCalls.length === 0) return;
  if (historyToolCalls.length === 0) {
    historyMessage.toolCalls = localToolCalls;
    return;
  }

  historyMessage.toolCalls = historyToolCalls.map((historyTool, index) => {
    const localTool = localToolCalls.find((candidate) => (
      candidate.id && historyTool.id && candidate.id === historyTool.id
    )) || localToolCalls[index];
    if (!localTool) return historyTool;
    return {
      ...historyTool,
      arguments: historyTool.arguments ?? localTool.arguments,
      startedAt: typeof historyTool.startedAt === 'number' ? historyTool.startedAt : localTool.startedAt,
      endedAt: typeof historyTool.endedAt === 'number' ? historyTool.endedAt : localTool.endedAt,
      result: historyTool.result ?? localTool.result,
      status: historyTool.status === 'done' ? historyTool.status : localTool.status ?? historyTool.status,
      order: typeof historyTool.order === 'number' && Number.isFinite(historyTool.order)
        ? historyTool.order
        : localTool.order,
    };
  });
}

function mergeToolCallSnapshots(existing: ToolCall[] | undefined, incoming: ToolCall[]): ToolCall[] | undefined {
  if ((!existing || existing.length === 0) && incoming.length === 0) return existing;

  const merged: ToolCall[] = [];
  const indexes = new Map<string, number>();
  const add = (tool: ToolCall | undefined) => {
    if (!tool) return;
    const key = tool.id || `${resolveToolName(tool.name)}:${tool.startedAt}`;
    const existingIndex = key ? indexes.get(key) : undefined;
    if (existingIndex !== undefined) {
      const current = merged[existingIndex];
      merged[existingIndex] = {
        ...current,
        arguments: current.arguments ?? tool.arguments,
        result: current.result ?? tool.result,
        endedAt: current.endedAt ?? tool.endedAt,
        order: current.order ?? tool.order,
        status: current.status === 'done' || current.status === 'error'
          ? current.status
          : tool.status,
      };
      return;
    }
    if (key) indexes.set(key, merged.length);
    merged.push(tool);
  };

  for (const tool of existing || []) add(tool);
  for (const tool of incoming) add(tool);
  return merged.length > 0 ? merged : undefined;
}

function appendTurnMarker(content: string, marker: string): string {
  const current = String(content || '').trim();
  if (!current) return marker;
  // Never stack markers: a snapshot already labeled (by either path) stays as-is.
  if (current.includes(STEERING_INTERRUPTED_MARKER) || current.includes(LIVE_VIEW_DETACHED_MARKER)) {
    return String(content || '');
  }
  return `${String(content || '').trimEnd()}\n\n${marker}`;
}

function historyStreamSnapshotIsAuthoritative(
  snapshot: any,
  fence: { localTurnEpoch: number; runId: string | null; wasActive: boolean } | undefined,
  current: { localTurnEpoch: number; runId: string | null; active: boolean },
): boolean {
  if (!fence) return true;
  const snapshotRunId = normalizeRunId(snapshot?.runId);
  const authorityChanged = current.localTurnEpoch !== fence.localTurnEpoch
    || current.runId !== fence.runId
    || current.active !== fence.wasActive;
  if (!authorityChanged) return true;
  return snapshot?.active === true
    && Boolean(snapshotRunId)
    && Boolean(current.runId)
    && snapshotRunId === current.runId;
}

function preserveInterruptedLiveTurnSnapshot(
  message: ChatMessage,
  snapshot: {
    text: string;
    thinking: string;
    thinkingSubject: string;
    segments: StreamSegment[];
    toolCalls: ToolCall[];
  },
  // Only the real steer path may claim a steering interruption; recovery
  // paths detach the live VIEW while the agent keeps working, and labeling
  // that "interrupted by steering" reads as a false interruption.
  marker: string | null = STEERING_INTERRUPTED_MARKER,
): ChatMessage {
  const segments: TextSegment[] = [];
  const seenSegments = new Set<string>();
  const addSegment = (
    text: string,
    kind: 'text' | 'thinking',
    ts?: number,
    position: TextSegment['position'] = 'before',
    subject?: string,
    order?: number,
  ) => {
    const value = String(text || '').trim();
    const safeSubject = kind === 'thinking' ? sanitizeThinkingSubject(subject) : '';
    if (!value && !safeSubject) return;
    const key = `${kind}|${safeSubject}|${normalizeHistoryReplayContent(value)}`;
    if (seenSegments.has(key)) return;
    seenSegments.add(key);
    segments.push({
      text: value,
      ...(safeSubject ? { subject: safeSubject } : {}),
      position,
      kind,
      ...(typeof ts === 'number' && Number.isFinite(ts) ? { ts } : {}),
      ...(typeof order === 'number' && Number.isFinite(order) ? { order } : {}),
    });
  };

  for (const segment of message.segments || []) {
    addSegment(
      segment.text,
      segment.kind === 'thinking' ? 'thinking' : 'text',
      segment.ts,
      segment.position || 'before',
      segment.subject,
      segment.order,
    );
  }
  if (message.thinkingContent || message.thinkingSubject) {
    addSegment(
      message.thinkingContent || '',
      'thinking',
      message.createdAt.getTime(),
      'before',
      message.thinkingSubject,
    );
  }
  for (const segment of snapshot.segments) {
    addSegment(segment.text, segment.kind, segment.ts, 'before', segment.subject, segment.order);
  }
  if (snapshot.thinking || snapshot.thinkingSubject) {
    addSegment(snapshot.thinking, 'thinking', Date.now(), 'before', snapshot.thinkingSubject);
  }

  const visibleContent = snapshot.text.trim() ? snapshot.text : message.content;
  const nextContent = marker ? appendTurnMarker(visibleContent, marker) : visibleContent;

  return {
    ...message,
    content: nextContent,
    segments: segments.length > 0 ? segments : message.segments,
    toolCalls: mergeToolCallSnapshots(message.toolCalls, snapshot.toolCalls),
  };
}

function assistantToolSignature(message: ChatMessage): string {
  const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  return calls.map((tool) => resolveToolName(tool.name)).filter(Boolean).join('|');
}

function assistantRowsCanShareActiveSplitProjection(
  messages: ChatMessage[],
  toolOnly: ChatMessage,
  visible: ChatMessage,
  activeRunId: string | null,
  initiatingUserBoundaryTs: number,
): boolean {
  const toolOnlyIndex = messages.indexOf(toolOnly);
  const visibleIndex = messages.indexOf(visible);
  if (toolOnlyIndex < 0 || visibleIndex <= toolOnlyIndex) return false;

  const toolRunId = normalizeRunId(toolOnly.runtimeRunId);
  const visibleRunId = normalizeRunId(visible.runtimeRunId);
  if (
    (toolRunId && toolRunId !== activeRunId)
    || (visibleRunId && visibleRunId !== activeRunId)
  ) {
    return false;
  }
  if (
    activeRunId
    && toolRunId === activeRunId
    && visibleRunId === activeRunId
  ) {
    return true;
  }
  if (messages.slice(toolOnlyIndex + 1, visibleIndex).some((message) => message.role === 'user')) {
    return false;
  }

  if (Number.isFinite(initiatingUserBoundaryTs)) {
    const toolTs = toolOnly.createdAt instanceof Date ? toolOnly.createdAt.getTime() : NaN;
    const visibleTs = visible.createdAt instanceof Date ? visible.createdAt.getTime() : NaN;
    if (!Number.isFinite(toolTs) || !Number.isFinite(visibleTs)) return false;
    const earliestCurrentTurnTs = initiatingUserBoundaryTs - ACTIVE_ASSISTANT_USER_BOUNDARY_TOLERANCE_MS;
    return toolTs >= earliestCurrentTurnTs && visibleTs >= earliestCurrentTurnTs;
  }
  return true;
}

function removeDuplicateToolOnlyAssistantProjection(
  messages: ChatMessage[],
  localMessage: ChatMessage,
  keepIndex: number,
  runtimeAuthority?: { activeRunId: string | null; initiatingUserBoundaryTs: number },
): void {
  const localToolSig = assistantToolSignature(localMessage);
  if (!localToolSig) return;
  const keepMessage = messages[keepIndex];
  if (!keepMessage) return;
  const localToolIds = new Set((localMessage.toolCalls || [])
    .map((tool) => String(tool.id || '').trim())
    .filter(Boolean));

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (index === keepIndex) continue;
    const candidate = messages[index];
    if (candidate?.role !== 'assistant') continue;
    const candidateRuntimeRunId = normalizeRunId(candidate.runtimeRunId);
    if (
      runtimeAuthority
      && candidateRuntimeRunId
      && candidateRuntimeRunId !== runtimeAuthority.activeRunId
    ) {
      continue;
    }
    if (
      runtimeAuthority
      && !(candidate.toolCalls || []).some((tool) => {
        const toolId = String(tool.id || '').trim();
        return Boolean(toolId && localToolIds.has(toolId));
      })
    ) {
      continue;
    }
    if (
      runtimeAuthority
      && !assistantRowsCanShareActiveSplitProjection(
        messages,
        candidate,
        keepMessage,
        runtimeAuthority.activeRunId,
        runtimeAuthority.initiatingUserBoundaryTs,
      )
    ) {
      continue;
    }
    if (normalizeHistoryReplayContent(candidate.content)) continue;
    if (assistantToolSignature(candidate) !== localToolSig) continue;
    messages.splice(index, 1);
  }
}

function mergeLoadedHistoryWithLocalMessages(
  loadedMessages: ChatMessage[],
  currentMessages: ChatMessage[],
  options?: {
    activeAssistantId?: string | null;
    activeRunId?: string | null;
    preserveActiveAssistant?: boolean;
  },
): ChatMessage[] {
  if (!currentMessages.length) return loadedMessages;

  const activeAssistantId = typeof options?.activeAssistantId === 'string' && options.activeAssistantId.trim()
    ? options.activeAssistantId.trim()
    : null;
  const preserveActiveAssistant = Boolean(options?.preserveActiveAssistant && activeAssistantId);
  const activeRunId = preserveActiveAssistant ? normalizeRunId(options?.activeRunId) : null;
  const merged = [...loadedMessages];
  const consumedCommittedUserMatches = new Set<ChatMessage>();
  const now = Date.now();
  const latestLoadedTs = loadedMessages.reduce((latest, message) => {
    const ts = message.createdAt instanceof Date ? message.createdAt.getTime() : NaN;
    return Number.isFinite(ts) ? Math.max(latest, ts) : latest;
  }, 0);
  const activeLocalAssistant = preserveActiveAssistant
    ? currentMessages.find((message) => (
        message.role === 'assistant' && message.id === activeAssistantId
      ))
    : undefined;
  const activeLocalAssistantTs = activeLocalAssistant?.createdAt instanceof Date
    ? activeLocalAssistant.createdAt.getTime()
    : NaN;
  const initiatingUserBoundaryTs = Number.isFinite(activeLocalAssistantTs)
    ? currentMessages.reduce((latest, message) => {
        if (message.role !== 'user' || !(message.createdAt instanceof Date)) return latest;
        const messageTs = message.createdAt.getTime();
        if (!Number.isFinite(messageTs) || messageTs > activeLocalAssistantTs) return latest;
        return Math.max(latest, messageTs);
      }, Number.NEGATIVE_INFINITY)
    : Number.NEGATIVE_INFINITY;

  const isRecentOptimisticAssistant = (message: ChatMessage): boolean => {
    if (message.role !== 'assistant') return false;
    if (preserveActiveAssistant && message.id === activeAssistantId) return true;
    const ts = message.createdAt instanceof Date ? message.createdAt.getTime() : NaN;
    if (!Number.isFinite(ts)) return false;
    if (now - ts > LOCAL_OPTIMISTIC_ASSISTANT_TAIL_WINDOW_MS) return false;
    if (latestLoadedTs && ts < latestLoadedTs - HISTORY_REPLAY_DUPLICATE_WINDOW_MS) return false;
    return Boolean(
      normalizeHistoryReplayContent(message.content)
      || message.thinkingContent
      || (Array.isArray(message.segments) && message.segments.length > 0)
      || (Array.isArray(message.toolCalls) && message.toolCalls.length > 0)
    );
  };

  const shouldKeepLocalMessage = (message: ChatMessage): boolean => {
    if (message.queued) return true;
    if (message.role === 'system' && message.provenance === 'live-steer') return true;
    if (message.role === 'user' && message.pendingAck) return true;
    if (
      message.role === 'user'
      && (message.provenance === 'live-foreign-user' || message.provenance === 'live-local-user')
    ) return true;
    if (preserveActiveAssistant && message.id === activeAssistantId) return true;
    if (isRecentOptimisticAssistant(message)) return true;
    return false;
  };

  const preserveMatchedActiveAssistantIdentity = (
    existing: ChatMessage,
    candidate: ChatMessage,
  ) => {
    const existingRuntimeRunId = normalizeRunId(existing.runtimeRunId);
    if (
      !preserveActiveAssistant
      || candidate.role !== 'assistant'
      || candidate.id !== activeAssistantId
      || existing.role !== 'assistant'
      || (existingRuntimeRunId && existingRuntimeRunId !== activeRunId)
    ) {
      return;
    }
    const currentIndex = merged.indexOf(existing);
    if (currentIndex < 0) return;
    // A reconnect history read can commit the visible R1 projection while the
    // replacement run is still recovering. Keep the live identity on that
    // durable row; otherwise streamingAssistantIdRef points at a removed local
    // row and the following stream_resume recreates the same R1 bubble.
    merged[currentIndex] = {
      ...existing,
      id: candidate.id,
    };
  };

  const preferredActiveAssistantMatch = (candidate: ChatMessage): ChatMessage | null => {
    if (
      !preserveActiveAssistant
      || candidate.role !== 'assistant'
      || candidate.id !== activeAssistantId
    ) {
      return null;
    }
    const candidateContent = normalizeHistoryReplayContent(candidate.content);
    const candidateTs = candidate.createdAt instanceof Date ? candidate.createdAt.getTime() : NaN;
    const candidateToolSig = assistantToolSignature(candidate);
    const candidateToolIds = new Set((candidate.toolCalls || [])
      .map((tool) => String(tool.id || '').trim())
      .filter(Boolean));
    const hasActiveRuntimeAuthority = (message: ChatMessage) => {
      const runtimeRunId = normalizeRunId(message.runtimeRunId);
      return !runtimeRunId || runtimeRunId === activeRunId;
    };
    let preferred: { message: ChatMessage; rank: number[] } | null = null;
    const outranks = (rank: number[], current: number[]) => {
      for (let index = 0; index < rank.length; index += 1) {
        if (rank[index] === current[index]) continue;
        return rank[index] > current[index];
      }
      return false;
    };
    for (let index = 0; index < merged.length; index += 1) {
      const message = merged[index];
      if (message.role !== 'assistant') continue;
      const runtimeRunId = normalizeRunId(message.runtimeRunId);
      // A runtime projection from another run remains valid transcript history,
      // but it can never consume or inherit the current live assistant identity.
      if (!hasActiveRuntimeAuthority(message)) continue;

      const messageContent = normalizeHistoryReplayContent(message.content);
      const messageTs = message.createdAt instanceof Date ? message.createdAt.getTime() : NaN;
      const delta = Number.isFinite(candidateTs) && Number.isFinite(messageTs)
        ? Math.abs(candidateTs - messageTs)
        : Number.POSITIVE_INFINITY;
      const sameRun = Boolean(activeRunId && runtimeRunId === activeRunId);
      const sameMessageId = Boolean(candidate.id && message.id && candidate.id === message.id);
      const sharesToolCallId = (message.toolCalls || []).some((tool) => {
        const toolId = String(tool.id || '').trim();
        return Boolean(toolId && candidateToolIds.has(toolId));
      });
      const exactContent = Boolean(candidateContent && candidateContent === messageContent);
      const prefixContent = Boolean(
        candidateContent
        && messageContent
        && (candidateContent.includes(messageContent) || messageContent.includes(candidateContent))
      );
      const matchingToolNames = Boolean(
        candidateToolSig
        && candidateToolSig === assistantToolSignature(message)
      );

      // Enhanced history can split one assistant into a tool-only row followed
      // by its visible text row. Prefer the visible row even when the earlier
      // projection shares the exact tool-call ID; it will absorb the live tools
      // and the redundant tool-only projection will then be removed.
      const hasMatchingVisibleAssistant = Boolean(candidateContent && !messageContent) && merged.some((other, otherIndex) => (
        otherIndex !== index
        && other.role === 'assistant'
        && hasActiveRuntimeAuthority(other)
        && Boolean(normalizeHistoryReplayContent(other.content))
        && (
          candidateContent.includes(normalizeHistoryReplayContent(other.content))
          || normalizeHistoryReplayContent(other.content).includes(candidateContent)
        )
        && assistantRowsCanShareActiveSplitProjection(
          merged,
          message,
          other,
          activeRunId,
          initiatingUserBoundaryTs,
        )
      ));
      if (hasMatchingVisibleAssistant) continue;

      const inheritsSplitToolCallId = prefixContent && merged.some((other, otherIndex) => {
        if (
          otherIndex === index
          || other.role !== 'assistant'
          || normalizeHistoryReplayContent(other.content)
        ) {
          return false;
        }
        if (!hasActiveRuntimeAuthority(other)) return false;
        if (!assistantRowsCanShareActiveSplitProjection(
          merged,
          other,
          message,
          activeRunId,
          initiatingUserBoundaryTs,
        )) return false;
        return (other.toolCalls || []).some((tool) => {
          const toolId = String(tool.id || '').trim();
          return Boolean(toolId && candidateToolIds.has(toolId));
        });
      });
      const sharesExactId = sameMessageId || sharesToolCallId || inheritsSplitToolCallId;

      const weakMatchIsTimely = (exactContent || prefixContent || matchingToolNames)
        && delta <= LOCAL_PENDING_ACK_WINDOW_MS
        && Number.isFinite(initiatingUserBoundaryTs)
        && Number.isFinite(messageTs)
        && messageTs >= initiatingUserBoundaryTs - ACTIVE_ASSISTANT_USER_BOUNDARY_TOLERANCE_MS;
      if (!sameRun && !sharesExactId && !weakMatchIsTimely) continue;

      const rank = [
        sameRun ? 1 : 0,
        sharesExactId ? 1 : 0,
        index,
        Number.isFinite(delta) ? -delta : Number.NEGATIVE_INFINITY,
      ];
      const isBetter = !preferred || outranks(rank, preferred.rank);
      if (isBetter) preferred = { message, rank };
    }
    return preferred ? preferred.message : null;
  };

  const alreadyRepresented = (candidate: ChatMessage): boolean => {
    const isActiveAssistantCandidate = preserveActiveAssistant
      && candidate.role === 'assistant'
      && candidate.id === activeAssistantId;
    const preferredActiveMatch = isActiveAssistantCandidate
      ? preferredActiveAssistantMatch(candidate)
      : null;
    return merged.some((existing, existingIndex) => {
      if (isActiveAssistantCandidate && existing.role === 'assistant') {
        if (existing !== preferredActiveMatch) return false;
        enrichAssistantHistoryFromLocalProjection(existing, candidate);
        const existingContent = normalizeHistoryReplayContent(existing.content);
        const candidateContent = normalizeHistoryReplayContent(candidate.content);
        if (candidateContent && (!existingContent || candidateContent.startsWith(existingContent))) {
          existing.content = candidate.content;
        }
        removeDuplicateToolOnlyAssistantProjection(merged, candidate, existingIndex, {
          activeRunId,
          initiatingUserBoundaryTs,
        });
        preserveMatchedActiveAssistantIdentity(existing, candidate);
        return true;
      }
      if (existing.id && candidate.id && existing.id === candidate.id) {
        if (
          candidate.role === 'user'
          && (
            candidate.pendingAck
            || candidate.provenance === 'live-foreign-user'
            || candidate.provenance === 'live-local-user'
          )
        ) {
          consumedCommittedUserMatches.add(existing);
        }
        return true;
      }
      if (
        candidate.role === 'user'
        && (
          candidate.pendingAck
          || candidate.provenance === 'live-foreign-user'
          || candidate.provenance === 'live-local-user'
        )
      ) {
        if (consumedCommittedUserMatches.has(existing)) return false;
        if (isLikelyCommittedPendingUser(candidate, existing)) {
          consumedCommittedUserMatches.add(existing);
          return true;
        }
        return false;
      }
      if (candidate.role === 'assistant' && existing.role === 'assistant') {
        const candidateContent = normalizeHistoryReplayContent(candidate.content);
        const existingContent = normalizeHistoryReplayContent(existing.content);
        const candidateTs = candidate.createdAt instanceof Date ? candidate.createdAt.getTime() : NaN;
        const existingTs = existing.createdAt instanceof Date ? existing.createdAt.getTime() : NaN;
        if (candidateContent && candidateContent === existingContent) {
          enrichAssistantHistoryFromLocalProjection(existing, candidate);
          removeDuplicateToolOnlyAssistantProjection(merged, candidate, existingIndex);
          return true;
        }
        if (
          candidateContent
          && existingContent
          && Number.isFinite(candidateTs)
          && Number.isFinite(existingTs)
          && Math.abs(candidateTs - existingTs) <= LOCAL_PENDING_ACK_WINDOW_MS
          && (candidateContent.includes(existingContent) || existingContent.includes(candidateContent))
        ) {
          enrichAssistantHistoryFromLocalProjection(existing, candidate);
          removeDuplicateToolOnlyAssistantProjection(merged, candidate, existingIndex);
          return true;
        }

        const candidateTools = Array.isArray(candidate.toolCalls) ? candidate.toolCalls : [];
        const existingTools = Array.isArray(existing.toolCalls) ? existing.toolCalls : [];
        if (candidateTools.length > 0 && existingTools.length > 0 && Number.isFinite(candidateTs) && Number.isFinite(existingTs)) {
          const candidateToolSig = candidateTools.map(tool => resolveToolName(tool.name)).join('|');
          const existingToolSig = existingTools.map(tool => resolveToolName(tool.name)).join('|');
          const hasMatchingFinalAssistant = Boolean(candidateContent) && merged.some((message, messageIndex) => (
            messageIndex !== existingIndex
            && message.role === 'assistant'
            && normalizeHistoryReplayContent(message.content) === candidateContent
          ));
          if (hasMatchingFinalAssistant && !existingContent) return false;
          if (
            candidateToolSig
            && candidateToolSig === existingToolSig
            && Math.abs(candidateTs - existingTs) <= LOCAL_PENDING_ACK_WINDOW_MS
          ) {
            enrichAssistantHistoryFromLocalProjection(existing, candidate);
            return true;
          }
        }
      }
      if (isEquivalentCompactionNotice(existing, candidate)) return true;
      return false;
    });
  };

  const localTail = currentMessages
    .filter(shouldKeepLocalMessage)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const insertLocalChronologically = (localMessage: ChatMessage) => {
    const localTs = localMessage.createdAt instanceof Date ? localMessage.createdAt.getTime() : NaN;
    if (!Number.isFinite(localTs)) {
      merged.push(localMessage);
      return;
    }
    const insertAt = merged.findIndex((candidate) => {
      const candidateTs = candidate.createdAt instanceof Date ? candidate.createdAt.getTime() : NaN;
      return Number.isFinite(candidateTs) && candidateTs > localTs;
    });
    if (insertAt >= 0) {
      merged.splice(insertAt, 0, localMessage);
    } else {
      merged.push(localMessage);
    }
  };

  for (const localMessage of localTail) {
    if (alreadyRepresented(localMessage)) continue;

    const delegatedArtifactIndex = localMessage.role === 'user' && localMessage.pendingAck
      ? merged.findIndex((candidate) => {
          if (candidate.role !== 'system' || candidate.provenance !== 'hidden-history-artifact') return false;
          return candidate.createdAt.getTime() >= localMessage.createdAt.getTime();
        })
      : -1;

    if (delegatedArtifactIndex >= 0) {
      merged.splice(delegatedArtifactIndex, 0, {
        ...localMessage,
        pendingAck: false,
      });
      continue;
    }

    if (localMessage.queued) {
      merged.push(localMessage);
    } else {
      insertLocalChronologically(localMessage);
    }
  }

  return dedupeHistoryMessages(merged);
}

/**
 * Merge toolResult messages back into the preceding assistant message's toolCalls.
 * The JSONL stores assistant messages (with toolCall blocks) and separate toolResult
 * messages. During live streaming, tool_end events set .result on the call directly.
 * For history, we need to do this post-hoc so the tool pills have their results.
 * Also removes the standalone toolResult messages since they render as null.
 *
 * Fix: More resilient matching — if toolCallId doesn't match, try by toolName,
 * then fall back to positional matching (the most recent running/unresolved tool call).
 */
function mergeToolResultsIntoToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let lastAssistant: ChatMessage | null = null;
  let lastAssistantIdx = -1;

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      lastAssistant = msg;
      lastAssistantIdx = result.length;
      result.push(msg);
    } else if (msg.role === 'toolResult' && lastAssistant && lastAssistant.toolCalls) {
      // Try to match by toolCallId first, then by toolName, then by position
      const calls = [...lastAssistant.toolCalls];
      let matched = false;
      
      // 1. Try exact toolCallId match
      if (msg.toolCallId) {
        for (let i = 0; i < calls.length; i++) {
          if (calls[i].id === msg.toolCallId) {
            calls[i] = { ...calls[i], result: msg.content, status: 'done' as const };
            matched = true;
            break;
          }
        }
      }
      
      // 2. Try toolName match on an unresolved call
      if (!matched && msg.toolName) {
        for (let i = 0; i < calls.length; i++) {
          if (calls[i].name === msg.toolName && !calls[i].result) {
            calls[i] = { ...calls[i], result: msg.content, status: 'done' as const };
            matched = true;
            break;
          }
        }
      }
      
      // 3. Fallback: positional match — assign to the first unresolved tool call
      if (!matched) {
        for (let i = 0; i < calls.length; i++) {
          if (!calls[i].result && (calls[i].status === 'running' || calls[i].status === 'done')) {
            calls[i] = { ...calls[i], result: msg.content, status: 'done' as const };
            matched = true;
            break;
          }
        }
      }
      
      // Update the assistant message in the result array
      if (matched && lastAssistantIdx >= 0) {
        result[lastAssistantIdx] = { ...lastAssistant, toolCalls: calls };
        // Update lastAssistant reference so subsequent toolResults use the updated calls
        lastAssistant = result[lastAssistantIdx];
      }
      // Don't add toolResult to result — it renders as null anyway
    } else {
      result.push(msg);
    }
  }
  return result;
}

function normalizeLoadedHistoryMessages(loaded: ChatMessage[]): ChatMessage[] {
  const deduped = dedupeHistoryMessages(loaded);
  const cleaned = normalizeOutOfTurnMessageDeliveryMirrors(deduped);
  return orderMessageToolVisibleMirrorsBeforeFinal(
    weaveMessageToolDeliveryMirrors(stripMessageDeliveryToolArtifacts(mergeToolResultsIntoToolCalls(cleaned))),
  );
}

/* ═══ Context shape ═══ */

export interface ChatStateContextValue {
  messages: ChatMessage[];
  messageQueue: MessageQueueItem[];
  queueCount: number;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  clearMessages: () => void;
  clearQueue: () => void;
  removeQueuedMessage: (id: string) => void;
  isRunning: boolean;
  isLoadingHistory: boolean;
  historyError: string | null;
  hasOlderHistory: boolean;
  isLoadingOlderHistory: boolean;
  olderHistoryError: string | null;
  isSwitchingSession: boolean;
  streamingPhase: StreamingPhase;
  activeToolName: string | null;
  statusText: string | null;
  lastProvenance: string | null;
  thinkingContent: string;
  thinkingSubject: string;
  streamingAssistantId: string | null;
  streamSegments: Array<{text: string; subject?: string; ts: number; kind: 'text' | 'thinking'; order: number}>;
  activityTitles: Readonly<Record<string, string>>;
  compactionPhase: 'idle' | 'compacting' | 'compacted';
  wsConnected: boolean;
  pendingApproval: ExecApprovalRequest | null;
  pendingApprovals: ExecApprovalRequest[];
  pendingApprovalCount: number;
  pendingUserQuestions: GatewayPendingQuestion[];
  settlePendingUserQuestion: (id: string) => void;
  refreshPendingUserQuestions: () => Promise<void>;
  resolveApproval: (approvalId: string, decision: 'allow-once' | 'deny' | 'allow-always') => Promise<void>;
  dismissApproval: (approvalId?: string) => void;
  provider: string;
  setProvider: (p: string) => void;
  selectProviderAgent: (provider: string, agentId?: string) => void;
  session: string;
  setSession: (s: string) => void;
  agentId: string | undefined;
  setAgentId: (a: string | undefined) => void;
  selectedModel: string;
  setSelectedModel: (m: string) => void;
  switchModel: (m: string) => Promise<{ deferred: boolean }>;
  sendMessage: (text: string) => Promise<void>;
  injectNote: (text: string, sessionKey?: string) => Promise<void>;
  cancelStream: () => Promise<void>;
  loadHistory: (sessionKey: string, providerName?: string) => Promise<void>;
  loadOlderHistory: () => Promise<number>;
  getCompleteHistory: () => Promise<ChatMessage[]>;
  selectSession: (sessionKey: string) => Promise<void>;
  refreshChat: () => Promise<void>;
  wsManager: WsManager | null;
  reconnectSocket: () => void;
  // Session controls (OpenClaw session thinking + fast mode)
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive' | 'max' | 'ultra';
  sessionThinkingOptions: string[];
  setThinkingLevel: (level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive' | 'max' | 'ultra') => Promise<void>;
  reasoningVisibility: 'off' | 'on' | 'stream';
  setReasoningVisibility: (level: 'off' | 'on' | 'stream') => Promise<void>;
  fastModeEnabled: boolean;
  toggleFastMode: () => Promise<void>;
  compactionModelOverride: string;
  setCompactionModelOverride: (model: string) => Promise<void>;
  compactionModelLoading: boolean;
  compactionModelError: string | null;
  sessionControlMutation: SessionControlMutationKind | null;
  isSessionControlMutationActive: () => boolean;
  sessionControlsError: string | null;
  sessionControlsSupported: boolean;
  ensureSessionControlsMetadataLoaded: (options?: { force?: boolean }) => Promise<void>;
  sessionTelemetry: OpenClawSessionTelemetry | null;
  sessionAvailability: 'unknown' | 'present' | 'missing';
}

const ChatStateContext = createContext<ChatStateContextValue | null>(null);

export function useChatState(): ChatStateContextValue {
  const ctx = useContext(ChatStateContext);
  if (!ctx) throw new Error('useChatState must be used within ChatStateProvider');
  return ctx;
}

/* ═══ Provider Component ═══ */

const LEGACY_SESSION_STORAGE_KEY = 'agent-chat-session';
const SESSION_STORAGE_PREFIX = 'agent-chat-session:';

function getProviderSessionStorageKey(provider: string): string {
  return `${SESSION_STORAGE_PREFIX}${String(provider || 'OPENCLAW').trim().toUpperCase() || 'OPENCLAW'}`;
}

function openClawAgentStorageId(agentId?: string | null): string {
  return normalizeStoredAgentId(agentId) || 'main';
}

function getOpenClawAgentSessionStorageKey(agentId?: string | null): string {
  return `${getProviderSessionStorageKey('OPENCLAW')}:${openClawAgentStorageId(agentId)}`;
}

function openClawSessionAgentId(session: string): string | null {
  const match = String(session || '').trim().match(/^agent:([^:]+):/);
  return match?.[1]?.trim() || null;
}

function normalizeInitialSession(provider: string, session: string, agentId?: string | null): string {
  const p = String(provider || '').trim().toUpperCase();
  const aliased = normalizePortalNewSessionAlias(String(session || '').trim() || 'main');
  const s = aliased || 'main';
  const agentKey = normalizeStoredAgentId(agentId) || 'main';
  if (p === 'OPENCLAW' && s === 'main') return `agent:${agentKey}:main`;
  if (p === 'OPENCLAW' && s === 'agent:main:main' && agentKey !== 'main') return `agent:${agentKey}:main`;
  if (p === 'OPENCLAW' && s.startsWith('new-')) return `agent:${agentKey}:${s}`;
  if (p !== 'OPENCLAW' && s.startsWith('agent:')) return 'main';
  return s;
}

function readStoredSession(provider: string, agentId?: string | null): string {
  if (typeof window === 'undefined') return normalizeInitialSession(provider, 'main', agentId);
  const normalizedProvider = String(provider || 'OPENCLAW').trim().toUpperCase() || 'OPENCLAW';
  if (normalizedProvider === 'OPENCLAW') {
    const targetAgentId = openClawAgentStorageId(agentId);
    const agentScopedKey = getOpenClawAgentSessionStorageKey(targetAgentId);
    const candidates = [
      localStorage.getItem(agentScopedKey),
      localStorage.getItem(getProviderSessionStorageKey(normalizedProvider)),
      localStorage.getItem(LEGACY_SESSION_STORAGE_KEY),
    ];
    for (const candidate of candidates) {
      if (!candidate?.trim()) continue;
      const normalized = normalizeInitialSession(normalizedProvider, candidate, targetAgentId);
      if (openClawSessionAgentId(normalized) !== targetAgentId) continue;
      localStorage.setItem(agentScopedKey, normalized);
      return normalized;
    }
    return `agent:${targetAgentId}:main`;
  }
  const providerScoped = localStorage.getItem(getProviderSessionStorageKey(provider));
  if (providerScoped && providerScoped.trim()) {
    return normalizeInitialSession(provider, providerScoped, agentId);
  }
  const legacy = localStorage.getItem(LEGACY_SESSION_STORAGE_KEY) || 'main';
  return normalizeInitialSession(provider, legacy, agentId);
}

function persistStoredSession(provider: string, session: string, agentId?: string | null): string {
  const normalized = normalizeInitialSession(provider, session, agentId);
  if (typeof window !== 'undefined') {
    localStorage.setItem(getProviderSessionStorageKey(provider), normalized);
    if (String(provider || '').trim().toUpperCase() === 'OPENCLAW') {
      const sessionAgentId = openClawSessionAgentId(normalized) || openClawAgentStorageId(agentId);
      localStorage.setItem(getOpenClawAgentSessionStorageKey(sessionAgentId), normalized);
    }
    localStorage.setItem(LEGACY_SESSION_STORAGE_KEY, normalized);
  }
  return normalized;
}

const LIFECYCLE_CONTROL_TOKENS = new Set([
  'start',
  'started',
  'running',
  'end',
  'ended',
  'complete',
  'completed',
  'error',
  'failed',
  'idle',
  'compacting',
  'compacted',
]);

const LIFECYCLE_FLUSH_PREPARING_RE = /\b(memory flush (?:about to start|starting|started|queued|pending)|preparing (?:for )?(?:a )?memory flush|preparing context maintenance|preparing compaction|preparing to store durable memor(?:y|ies)|about to compact|pre-compaction|heartbeat check (?:started|starting|running|queued|pending)|checking heartbeat|reading heartbeat\.md|read heartbeat\.md)\b/i;
const LIFECYCLE_FLUSH_RUNNING_RE = /\b(memory flush(?:ing)?|flush in progress|flushing memory|storing durable memor(?:y|ies)|writing durable memor(?:y|ies)|context maintenance|refreshing (?:context|memory)|summariz(?:ing|ation) (?:context|conversation|history)|trimming context)\b/i;
const LIFECYCLE_FLUSH_DONE_RE = /\b(memory flush complete(?:d)?|durable memor(?:y|ies) (?:stored|written)|context refreshed|context maintenance (?:finished|complete(?:d)?)|compaction (?:incomplete|did not complete)|heartbeat check complete(?:d)?|heartbeat_ok)\b/i;
const LIFECYCLE_COMPACTING_RE = /^(?:compacting context[.…]*|auto-compaction(?: started| in progress)?[.…]*|context compaction(?: started| in progress)?[.…]*|compaction (?:in progress|started)\.?)$/i;
const LIFECYCLE_COMPACTED_RE = /^(?:context compacted\.?|auto-compaction complete(?:d)?\.?|context compaction complete(?:d)?\.?|compaction (?:complete(?:d)?|finished)\.?)$/i;

function normalizeLifecycleMarker(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

type LifecycleMaintenanceSignal = 'idle' | 'maintenance' | 'maintenance_done' | 'compacting' | 'compacted';

export interface OpenClawSessionTelemetry {
  contextTokens: number | null;
  totalTokens: number | null;
  pressureRatio: number | null;
  compactionCount: number | null;
  model: string | null;
  updatedAt: number;
}

function firstFiniteNumber(...candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return null;
}

function extractOpenClawSessionTelemetry(sessionInfo: any, modelHint?: string): OpenClawSessionTelemetry | null {
  if (!sessionInfo || typeof sessionInfo !== 'object') return null;

  const contextTokens = firstFiniteNumber(
    sessionInfo.contextTokens,
    sessionInfo.contextWindowTokens,
    sessionInfo.contextWindow,
    sessionInfo.modelContextTokens,
    sessionInfo.modelContextWindow,
    sessionInfo.currentModel?.contextTokens,
    sessionInfo.currentModel?.contextWindow,
    sessionInfo.usage?.contextTokens,
    sessionInfo.meta?.contextTokens,
  );

  const totalTokens = firstFiniteNumber(
    sessionInfo.totalTokens,
    sessionInfo.usage?.totalTokens,
    sessionInfo.lastRun?.totalTokens,
    sessionInfo.lastRun?.usage?.totalTokens,
    sessionInfo.lastCallUsage?.totalTokens,
    sessionInfo.meta?.totalTokens,
  );

  const compactionCount = firstFiniteNumber(
    sessionInfo.compactionCount,
    sessionInfo.agentMeta?.compactionCount,
    sessionInfo.lastRun?.compactionCount,
    sessionInfo.lastRunStatus?.compactionCount,
    sessionInfo.meta?.compactionCount,
  );

  const model = typeof modelHint === 'string' && modelHint.trim() ? modelHint.trim() : null;
  if (contextTokens == null && totalTokens == null && compactionCount == null && !model) return null;

  return {
    contextTokens,
    totalTokens,
    pressureRatio: contextTokens && totalTokens != null ? Math.max(0, Math.min(1, totalTokens / contextTokens)) : null,
    compactionCount,
    model,
    updatedAt: Date.now(),
  };
}

function extractLifecycleStatusText(data: any): string | null {
  const candidates = [
    data?.statusText,
    data?.message,
    data?.text,
    data?.content,
    data?.detail,
    data?.description,
    data?.status,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const next = candidate.trim();
    if (!next) continue;
    if (LIFECYCLE_CONTROL_TOKENS.has(next.toLowerCase())) continue;
    return next;
  }

  return null;
}

function inferLifecycleMaintenanceSignal(phase: string, statusText: string | null): LifecycleMaintenanceSignal {
  const normalizedPhase = String(phase || '').trim().toLowerCase();
  const normalizedStatus = normalizeLifecycleMarker(String(statusText || ''));

  const phaseClaimsCompaction = normalizedPhase === 'compacted'
    || normalizedPhase === 'compaction_end'
    || normalizedPhase === 'compaction_completed'
    || normalizedPhase === 'compacting'
    || normalizedPhase === 'compaction_start'
    || normalizedPhase === 'compaction_started';
  const statusContradictsCompaction = Boolean(normalizedStatus && phaseClaimsCompaction && !isCompactionNotice(normalizedStatus));
  if (!statusContradictsCompaction && (normalizedPhase === 'compacted' || normalizedPhase === 'compaction_end' || normalizedPhase === 'compaction_completed')) {
    return 'compacted';
  }
  if (!statusContradictsCompaction && (normalizedPhase === 'compacting' || normalizedPhase === 'compaction_start' || normalizedPhase === 'compaction_started')) {
    return 'compacting';
  }
  if (!normalizedStatus) {
    return 'idle';
  }
  if (LIFECYCLE_COMPACTED_RE.test(normalizedStatus)) {
    return 'compacted';
  }
  if (LIFECYCLE_COMPACTING_RE.test(normalizedStatus)) {
    return 'compacting';
  }
  if (LIFECYCLE_FLUSH_DONE_RE.test(normalizedStatus)) {
    return 'maintenance_done';
  }
  if (LIFECYCLE_FLUSH_PREPARING_RE.test(normalizedStatus) || LIFECYCLE_FLUSH_RUNNING_RE.test(normalizedStatus)) {
    return 'maintenance';
  }
  return 'idle';
}

function defaultLifecycleStatusText(signal: LifecycleMaintenanceSignal): string {
  if (signal === 'compacting') return 'Compacting context…';
  if (signal === 'compacted') return 'Context compacted';
  if (signal === 'maintenance') return 'Preparing context maintenance…';
  if (signal === 'maintenance_done') return 'Context maintenance finished.';
  return 'Agent is thinking…';
}

function getCodexAppServerProgressStatus(stream: unknown, data: any): string | null {
  const streamName = typeof stream === 'string' ? stream.trim().toLowerCase() : '';
  if (!streamName.startsWith('codex_app_server.')) return null;

  const phase = String(data?.phase || data?.status || '').trim().toLowerCase();
  const explicit = extractLifecycleStatusText(data);
  if (explicit) return explicit;

  if (streamName === 'codex_app_server.lifecycle') {
    if (phase === 'startup') return 'Starting Codex runtime…';
    if (phase === 'thread_ready') return 'Codex session ready.';
    if (phase === 'turn_starting') return 'Starting Codex turn…';
    if (phase === 'turn_accepted') return 'Codex accepted the turn.';
    if (phase === 'assistant_output_started') return 'Codex is writing…';
    if (phase === 'tool_execution_started') return 'Running tool…';
    if (phase === 'error') return 'Codex reported an error.';
    return null;
  }

  if (streamName === 'codex_app_server.hook') {
    if (phase === 'started') return 'Preparing execution hooks…';
    if (phase === 'completed') return 'Execution hooks ready.';
    return null;
  }

  if (streamName === 'codex_app_server.item') {
    if (phase === 'started') return 'Codex is working…';
    return null;
  }

  return null;
}

export function ChatStateProvider({ children }: { children: React.ReactNode }) {
  const publicSettings = usePublicSettings();
  const configuredDirectGateway = publicSettings?.useDirectGateway ?? BUILD_TIME_USE_DIRECT_GATEWAY;
  const useDirectGateway = configuredDirectGateway && DIRECT_GATEWAY_AUTHORIZATION_BROKER_READY;

  // Persisted selection state
  const [provider, setProviderRaw] = useState(
    () => localStorage.getItem('agent-chat-provider') || 'OPENCLAW',
  );
  const [session, setSessionRaw] = useState(() => {
    const storedProvider = localStorage.getItem('agent-chat-provider') || 'OPENCLAW';
    const storedAgentId = readStoredAgentId();
    return readStoredSession(storedProvider, storedAgentId);
  });
  const [agentId, setAgentIdRaw] = useState<string | undefined>(() => readStoredAgentId());
  const [selectedModel, setSelectedModelRaw] = useState(() => {
    const p = localStorage.getItem('agent-chat-provider') || 'OPENCLAW';
    const stored = normalizeProviderModel(p, localStorage.getItem(MODEL_STORAGE_PREFIX + p) || '');
    // Agent Zero's persisted preference is only a candidate. Keep it out of
    // active UI/runtime state until the current authenticated catalog proves
    // that exact model is still selectable.
    if (p === 'AGENT_ZERO') return '';
    // Only OpenClaw models require provider prefixes. Native providers use bare IDs.
    if (stored && p === 'OPENCLAW' && !stored.includes('/')) {
      localStorage.removeItem(MODEL_STORAGE_PREFIX + p);
      return '';
    }
    return stored;
  });
  // Selection setters are called back-to-back when the user changes provider,
  // agent, and session. Keep their imperative view synchronous so a later
  // setter in the same event cannot persist state under the previous provider.
  const sessionRef = useRef(session);
  const providerRef = useRef(provider);
  const agentIdRef = useRef(agentId);
  const modelRef = useRef(selectedModel);

  // Wrapped setters with localStorage persistence
  const setProvider = useCallback((p: string) => {
    providerRef.current = p;
    localStorage.setItem('agent-chat-provider', p);
    setProviderRaw(p);
    const nextSession = readStoredSession(p, agentIdRef.current);
    sessionRef.current = nextSession;
    setSessionRaw(nextSession);
    const stored = normalizeProviderModel(p, localStorage.getItem(MODEL_STORAGE_PREFIX + p) || '');
    if (p === 'AGENT_ZERO') {
      modelRef.current = '';
      setSelectedModelRaw('');
      return;
    }
    // Same guard, but only for OpenClaw. Native providers legitimately use bare IDs.
    if (stored && p === 'OPENCLAW' && !stored.includes('/')) {
      localStorage.removeItem(MODEL_STORAGE_PREFIX + p);
      modelRef.current = '';
      setSelectedModelRaw('');
    } else {
      modelRef.current = stored;
      setSelectedModelRaw(stored);
    }
  }, []);
  const setSession = useCallback((s: string) => {
    const normalized = persistStoredSession(providerRef.current, s, agentIdRef.current);
    sessionRef.current = normalized;
    setSessionRaw(normalized);
  }, []);
  const setAgentId = useCallback((a: string | undefined) => {
    const normalized = normalizeStoredAgentId(a);
    if (normalized) localStorage.setItem('agent-chat-agentId', normalized);
    else localStorage.removeItem('agent-chat-agentId');
    agentIdRef.current = normalized;
    setAgentIdRaw(normalized);
  }, []);
  const selectProviderAgent = useCallback((nextProvider: string, nextAgentId?: string) => {
    const normalizedProvider = String(nextProvider || 'OPENCLAW').trim().toUpperCase() || 'OPENCLAW';
    const normalizedAgentId = normalizedProvider === 'OPENCLAW'
      ? normalizeStoredAgentId(nextAgentId)
      : undefined;
    // setAgentId updates its imperative ref synchronously; setProvider can then
    // restore the exact provider+agent session in the same browser event.
    setAgentId(normalizedAgentId);
    setProvider(normalizedProvider);
  }, [setAgentId, setProvider]);
  const setSelectedModel = useCallback((m: string) => {
    const currentProvider = providerRef.current;
    const normalized = normalizeProviderModel(currentProvider, m);
    modelRef.current = normalized;
    setSelectedModelRaw(normalized);
    if (normalized) localStorage.setItem(MODEL_STORAGE_PREFIX + currentProvider, normalized);
    else localStorage.removeItem(MODEL_STORAGE_PREFIX + currentProvider);
  }, []);

  useEffect(() => {
    const normalized = normalizeInitialSession(provider, session, agentId);
    if (normalized !== session) {
      persistStoredSession(provider, normalized, agentId);
      sessionRef.current = normalized;
      setSessionRaw(normalized);
      return;
    }
    persistStoredSession(provider, session, agentId);
  }, [provider, session, agentId]);

  const deriveSessionModel = useCallback((sessionInfo: any): string => {
    const joinModel = (providerName: string, modelName: string): string => {
      const providerKey = providerName.trim();
      const modelKey = modelName.trim();
      if (!providerKey || !modelKey) return '';
      return providerRef.current === 'OPENCLAW' && !modelKey.includes('/')
        ? `${providerKey}/${modelKey}`
        : modelKey;
    };

    const resolvedProvider = typeof sessionInfo?.resolved?.modelProvider === 'string' ? sessionInfo.resolved.modelProvider.trim() : '';
    const resolvedModel = typeof sessionInfo?.resolved?.model === 'string' ? sessionInfo.resolved.model.trim() : '';
    if (resolvedProvider && resolvedModel) return joinModel(resolvedProvider, resolvedModel);

    const providerName = typeof sessionInfo?.modelProvider === 'string' ? sessionInfo.modelProvider.trim() : '';
    const modelName = typeof sessionInfo?.model === 'string' ? sessionInfo.model.trim() : '';
    if (providerName && modelName) return joinModel(providerName, modelName);
    if (modelName && modelName.includes('/')) return modelName;

    const nestedProvider = typeof sessionInfo?.currentModel?.provider === 'string' ? sessionInfo.currentModel.provider.trim() : '';
    const nestedModel = typeof sessionInfo?.currentModel?.model === 'string' ? sessionInfo.currentModel.model.trim() : '';
    if (nestedProvider && nestedModel) return joinModel(nestedProvider, nestedModel);
    if (nestedModel && nestedModel.includes('/')) return nestedModel;

    const overrideProvider = typeof sessionInfo?.providerOverride === 'string' ? sessionInfo.providerOverride.trim() : '';
    const overrideModel = typeof sessionInfo?.modelOverride === 'string' ? sessionInfo.modelOverride.trim() : '';
    if (overrideProvider && overrideModel) return joinModel(overrideProvider, overrideModel);
    if (overrideModel && overrideModel.includes('/')) return overrideModel;

    return '';
  }, []);

  const switchModel = useCallback(async (m: string) => {
    setSelectedModel(m);

    const currentProvider = providerRef.current;
    const currentSession = sessionRef.current;

    // The session-model response includes the refreshed session row, whose
    // thinkingOptions/thinkingLevel reflect the newly resolved model profile
    // (e.g. ultra appears when switching to GPT-5.6 Sol). Apply it so the
    // Session Controls slider updates without reopening the panel.
    const applyPatchedSessionProfile = (patchResponse: any) => {
      const patchedSession = patchResponse?.session;
      if (!patchedSession || typeof patchedSession !== 'object') return;
      const options = Array.isArray(patchedSession.thinkingOptions)
        ? (patchedSession.thinkingOptions as unknown[])
            .map((entry) => String(entry || '').trim().toLowerCase())
            .filter((entry) => THINKING_LEVELS.includes(entry as ThinkingLevel))
        : [];
      setSessionThinkingOptions(options);
      const patchedThinking = String(patchedSession.thinkingLevel || '').trim().toLowerCase();
      if (patchedThinking && THINKING_LEVELS.includes(patchedThinking as ThinkingLevel)) {
        setThinkingLevelState(patchedThinking as ThinkingLevel);
      }
    };

    const result = await applyAgentChatSessionModel({
      provider: currentProvider,
      session: currentSession,
      model: m,
      patchSessionModel: gatewayAPI.patchSessionModel,
      createSession: gatewayAPI.createSession,
    });
    if (result.patchResponse) applyPatchedSessionProfile(result.patchResponse);
    return { deferred: result.deferred };
  }, [setSelectedModel]);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const [pendingUserQuestions, setPendingUserQuestions] = useState<GatewayPendingQuestion[]>([]);
  const pendingUserQuestionsRef = useRef<GatewayPendingQuestion[]>([]);
  const pendingUserQuestionsReadyRef = useRef(false);
  const pendingQuestionPollGenerationRef = useRef(0);
  const pendingQuestionComposerAnswerRef = useRef<{
    id: string;
    text: string;
    inFlight: boolean;
  } | null>(null);
  const pendingActiveSteerRef = useRef<{
    requestId: string;
    sessionKey: string;
    expectedRunId: string;
    text: string;
    inFlight: boolean;
  } | null>(null);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const appendLocalMessage = useCallback((message: ChatMessage) => {
    messagesRef.current = messagesRef.current.some(existing => existing.id === message.id)
      ? messagesRef.current
      : [...messagesRef.current, message];
    setMessages(prev => {
      if (prev.some(existing => existing.id === message.id)) {
        messagesRef.current = prev;
        return prev;
      }
      const next = [...prev, message];
      messagesRef.current = next;
      return next;
    });
  }, []);
  const appendLiveUserMessage = useCallback((data: any) => {
    const content = typeof data?.content === 'string' ? data.content : '';
    if (!content.trim()) return;
    const rawId = typeof data?.messageId === 'string' && data.messageId.trim()
      ? data.messageId.trim()
      : `live-user-${String(data?.messageTimestamp || Date.now())}-${content.slice(0, 64)}`;
    const rawTimestamp = Number(data?.messageTimestamp);
    const timestampMs = Number.isFinite(rawTimestamp) && rawTimestamp > 0
      ? (rawTimestamp < 10_000_000_000 ? rawTimestamp * 1000 : rawTimestamp)
      : Date.now();
    const matchingLocal = messagesRef.current.find((message) => (
      message.id === rawId && message.role === 'user'
    ));
    if (matchingLocal) {
      if (outstandingChatDispatchRef.current?.clientMessageId === rawId) {
        outstandingChatDispatchRef.current = null;
      }
      if (matchingLocal.pendingAck) {
        setMessages((previous) => {
          const next = previous.map((message) => message.id === rawId
            ? {
                ...message,
                pendingAck: false,
                createdAt: new Date(timestampMs),
                // The upstream echo proves acceptance, not immediate history
                // durability. Preserve this exact optimistic row across a
                // forced history read until the committed transcript catches up.
                provenance: 'live-local-user',
              }
            : message);
          messagesRef.current = next;
          return next;
        });
      }
      return;
    }
    appendLocalMessage({
      id: rawId,
      role: 'user',
      content,
      createdAt: new Date(timestampMs),
      // Durable history can lag live cross-channel events during a long turn.
      // Preserve this row across forced history merges until an exact/content
      // match proves the transcript has caught up.
      provenance: 'live-foreign-user',
    });
  }, [appendLocalMessage]);
  const removeLocalMessageById = useCallback((messageId: string) => {
    messagesRef.current = messagesRef.current.filter(message => message.id !== messageId);
    setMessages(prev => {
      const next = prev.filter(message => message.id !== messageId);
      messagesRef.current = next;
      return next;
    });
  }, []);
  const [messageQueue, setMessageQueue] = useState<MessageQueueItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [hasOlderHistory, setHasOlderHistory] = useState(false);
  const [isLoadingOlderHistory, setIsLoadingOlderHistory] = useState(false);
  const [olderHistoryError, setOlderHistoryError] = useState<string | null>(null);
  const [isSwitchingSession, setIsSwitchingSession] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [lastProvenance, setLastProvenance] = useState<string | null>(null);
  const [streamingPhase, setStreamingPhase] = useState<StreamingPhase>('idle');
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  const [thinkingContent, setThinkingContent] = useState<string>('');
  const thinkingContentRef = useRef('');
  const reasoningLaneRef = useRef<'raw' | 'preamble' | 'status' | null>(null);
  const thinkingSnapshotTrackerRef = useRef(createGraduatedThinkingSnapshotTracker());
  useEffect(() => { thinkingContentRef.current = thinkingContent; }, [thinkingContent]);
  const [thinkingSubject, setThinkingSubject] = useState<string>('');
  const thinkingSubjectRef = useRef('');
  useEffect(() => { thinkingSubjectRef.current = thinkingSubject; }, [thinkingSubject]);
  useEffect(() => {
    if (!thinkingContent && !thinkingSubject) reasoningLaneRef.current = null;
  }, [thinkingContent, thinkingSubject]);
  const [activityTitles, setActivityTitles] = useState<Record<string, string>>({});
  const activityTitleRunsRef = useRef(new Map<string, string>());
  const activityTitleTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [startupReady, setStartupReady] = useState(false);
  const [directGatewayBootstrapReady, setDirectGatewayBootstrapReady] = useState(false);
  const [directGatewayDemanded, setDirectGatewayDemanded] = useState(false);
  const directPendingEmptyFinalRef = useRef<{
    runId: string | null;
    model: string | null;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const directPreambleProgressRef = useRef(createPreambleProgressAccumulator());
  // Graduated streaming segments — when a tool call starts, current accumulated text
  // gets "graduated" into a segment so it renders as a finalized bubble. This matches
  // the OpenClaw web UI v2 pattern where thoughts don't disappear on tool transitions.
  const [streamSegments, setStreamSegments] = useState<StreamSegment[]>([]);
  const streamSegmentsRef = useRef<StreamSegment[]>([]);
  useEffect(() => { streamSegmentsRef.current = streamSegments; }, [streamSegments]);
  const [pendingApprovals, setPendingApprovals] = useState<ExecApprovalRequest[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [compactionPhase, setCompactionPhase] = useState<'idle' | 'compacting' | 'compacted'>('idle');
  const [sessionTelemetry, setSessionTelemetry] = useState<OpenClawSessionTelemetry | null>(null);
  const [sessionAvailability, setSessionAvailability] = useState<'unknown' | 'present' | 'missing'>('unknown');
  const compactionPhaseRef = useRef<'idle' | 'compacting' | 'compacted'>('idle');

  // Session controls state (thinking/fast mode)
  const [thinkingLevel, setThinkingLevelState] = useState<ThinkingLevel>('high');
  // Per-model thinking profile from the gateway session row (OpenClaw 2026.7.1
  // exposes thinkingOptions/thinkingDefault per resolved model, e.g. ultra on
  // GPT-5.6 Sol/Terra and adaptive on Claude models).
  const [sessionThinkingOptions, setSessionThinkingOptions] = useState<string[]>([]);
  const [reasoningVisibility, setReasoningVisibilityState] = useState<ReasoningVisibility>('stream');
  const [fastModeEnabled, setFastModeEnabled] = useState(false);
  const [compactionModelOverride, setCompactionModelOverrideState] = useState<string>('');
  const [compactionModelLoading, setCompactionModelLoading] = useState(false);
  const [compactionModelError, setCompactionModelError] = useState<string | null>(null);
  const [sessionControlMutation, setSessionControlMutation] = useState<SessionControlMutationKind | null>(null);
  const [sessionControlsError, setSessionControlsError] = useState<string | null>(null);
  const [sessionControlsMetadataLoaded, setSessionControlsMetadataLoaded] = useState(false);
  const thinkingLevelRef = useRef<ThinkingLevel>(thinkingLevel);
  const reasoningVisibilityRef = useRef<ReasoningVisibility>(reasoningVisibility);
  const fastModeEnabledRef = useRef(fastModeEnabled);
  const compactionModelOverrideRef = useRef(compactionModelOverride);
  const sessionControlMutationRef = useRef<SessionControlMutationSnapshot | Readonly<{
    generation: number;
    kind: 'compactionModel';
    provider: string;
    session: string;
    previous: string;
    requested: string;
  }> | null>(null);
  const sessionControlGenerationRef = useRef(0);

  thinkingLevelRef.current = thinkingLevel;
  reasoningVisibilityRef.current = reasoningVisibility;
  fastModeEnabledRef.current = fastModeEnabled;
  compactionModelOverrideRef.current = compactionModelOverride;

  // Refs
  const streamWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleStreamWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAnyStreamEventAtRef = useRef(0);
  const lastVisibleTextEventAtRef = useRef(0);
  const visibleSilenceNotifiedRef = useRef(false);
  const streamRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamRecoveryStartedAtRef = useRef<number | null>(null);
  const compactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionTelemetryRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const postTurnHistorySyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamContinuityRepairTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolCounterRef = useRef(0);
  const streamActivityOrderRef = useRef(0);
  const hasRealToolEventsRef = useRef(false);
  const sessionControlsMetadataPromiseRef = useRef<Promise<void> | null>(null);
  const wsManagerRef = useRef<WsManager | null>(null);
  // Direct gateway client for OPENCLAW provider (bypasses portal WS middleman)
  const directClientRef = useRef<OpenClawGatewayClient | null>(null);
  const streamTransportRef = useRef<ChatStreamTransport | null>(null);
  const activeSseTransportRef = useRef<ActiveSseTransport | null>(null);
  const stopActiveSseTransportRef = useRef<(reason: 'handoff' | 'cancel') => Promise<boolean>>(async () => false);
  const handoffActiveSseToPortalRef = useRef<(manager: WsManager | null) => Promise<boolean>>(async () => false);
  const streamClientIdRef = useRef('');
  if (!streamClientIdRef.current) streamClientIdRef.current = getOrCreateStreamClientId();
  const pendingWsAbortResultsRef = useRef<Map<string, PendingWsAbortResult>>(new Map());
  const cancelStreamPromiseRef = useRef<Promise<void> | null>(null);
  const currentRunIdRef = useRef<string | null>(null);
  const outstandingChatDispatchRef = useRef<OutstandingChatDispatch | null>(null);
  const prepareVerifiedContinuationAdoptionRef = useRef<() => void>(() => {});
  const lastTerminalRunIdRef = useRef<string | null>(null);
  const retiredRunIdsRef = useRef<RetiredRunEpoch[]>([]);
  const streamingAssistantIdRef = useRef<string | null>(null);
  const activeStreamToolCallsRef = useRef<ToolCall[]>([]);
  const compatibilityToolReplayIdsRef = useRef<Set<string>>(new Set());
  const activeToolNameRef = useRef<string | null>(null);
  const assembledRef = useRef('');
  const lastSegmentStartRef = useRef(0);
  const lastRawTextLenRef = useRef(0); // Track raw gateway text length for accurate graduation
  const directSnapshotCursorRef = useRef<CumulativeSnapshotCursor>({ ...EMPTY_CUMULATIVE_SNAPSHOT_CURSOR });
  const isStreamActiveRef = useRef(false);
  const isQueueDrainActiveRef = useRef(false);
  const messageQueueRef = useRef<MessageQueueItem[]>([]);
  // Monotonically-incrementing generation counter — incremented on every session
  // switch or clearMessages. Any async history load that started in a previous
  // generation simply discards its result, eliminating race conditions.
  const historyGenRef = useRef(0);
  const localTurnEpochRef = useRef(0);
  const historyBeforeCursorRef = useRef<string | null>(null);
  const historyHasMoreBeforeRef = useRef(false);
  const historyLoadedScopeRef = useRef<string | null>(null);
  const historyOlderPagesLoadedRef = useRef(false);
  const olderHistoryLoadInFlightRef = useRef(false);
  const loadHistoryInternalRef = useRef<((sessionKey: string, prov?: string, options?: { force?: boolean; refreshActiveSnapshot?: boolean; preserveLocalMessages?: boolean }) => Promise<boolean>) | null>(null);
  const resolveOpenClawSessionKeyRef = useRef<(rawSession?: string | null) => string>((rawSession) => String(rawSession || '').trim());
  const resetStreamWatchdogRef = useRef<(options?: { visible?: boolean }) => void>(() => {});
  const applyCompactionSnapshotStateRef = useRef<(phase?: unknown) => void>(() => {});
  const applyOpenClawActiveStreamSnapshotRef = useRef<(
    snapshot: any,
    options?: { statusTextWhenNoTool?: string | null; source?: ChatStreamTransport },
  ) => boolean>(() => false);
  const sendViaSSERef = useRef<(text: string, assistantId: string) => Promise<void>>(async () => {
    throw new Error('Streaming sender is not ready');
  });
  const drainNextQueuedMessageRef = useRef<() => void>(() => {});
  const portalTurnSequenceRef = useRef<number | null>(null);
  const portalTurnSequenceScopeRef = useRef<string | null>(null);
  const reasoningSequenceRef = useRef<{ runId: string | null; seq: number | null }>({
    runId: null,
    seq: null,
  });
  const runtimeReplaySequenceRef = useRef<{ runId: string | null; seq: number | null }>({
    runId: null,
    seq: null,
  });
  const runtimeOverlayOrderOffsetRef = useRef<{ runId: string; offset: number } | null>(null);

  // React state setters are asynchronous. Recovery frames can arrive
  // back-to-back in one socket task, so every live-lane reset must clear the
  // matching refs synchronously before an R2 event is allowed to hydrate.
  const resetLiveThinkingTimeline = useCallback(() => {
    thinkingContentRef.current = '';
    thinkingSubjectRef.current = '';
    reasoningLaneRef.current = null;
    resetGraduatedThinkingSnapshotTracker(thinkingSnapshotTrackerRef.current);
    streamSegmentsRef.current = [];
    runtimeOverlayOrderOffsetRef.current = null;
    compatibilityToolReplayIdsRef.current.clear();
    setThinkingContent('');
    setThinkingSubject('');
    setStreamSegments([]);
  }, []);
  const lastForegroundReconcileAtRef = useRef(0);
  // Throttle refs for streaming text updates — batch text deltas to reduce re-renders
  const textThrottleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTextUpdateRef = useRef<string | null>(null);
  const TEXT_THROTTLE_MS = 50; // 20fps is plenty smooth for text streaming

  const clearStreamRecoveryTimer = useCallback(() => {
    if (streamRecoveryTimerRef.current) {
      clearTimeout(streamRecoveryTimerRef.current);
      streamRecoveryTimerRef.current = null;
    }
    streamRecoveryStartedAtRef.current = null;
  }, []);

  // Self-reference so the grace-timer callback can re-arm the recovery window
  // after the backend confirms a quiet run is still live.
  const markStreamRecoveryRef = useRef<((status?: string) => void) | null>(null);

  const markStreamRecovery = useCallback((status = 'Reconnecting to stream…') => {
    if (!streamRecoveryStartedAtRef.current) {
      streamRecoveryStartedAtRef.current = Date.now();
    }
    setStatusText(status);
    if (streamRecoveryTimerRef.current) return;

    streamRecoveryTimerRef.current = setTimeout(async () => {
      streamRecoveryTimerRef.current = null;
      if (!isStreamActiveRef.current) {
        streamRecoveryStartedAtRef.current = null;
        return;
      }

      const sessionKey = sessionRef.current || 'main';
      const providerName = providerRef.current;

      // Anthropic turns routinely go silent for minutes (long reasoning, no
      // surfaced thinking deltas). Before declaring the turn dead, ask the
      // backend — while it confirms the run is live, keep waiting instead of
      // wiping the view of a working agent.
      if (providerName === 'OPENCLAW') {
        try {
          const probeSession = resolveOpenClawSessionKeyRef.current(sessionKey) || sessionKey;
          const { data } = await client.get('/gateway/stream-status', {
            params: { session: probeSession, provider: providerName },
            timeout: 8000,
            _silent: true,
          } as any);
          if (data?.active && isStreamActiveRef.current) {
            debugLog('[ChatState] Recovery grace expired but backend confirms the run is live — extending');
            if (streamRecoveryTimerRef.current === null && streamRecoveryStartedAtRef.current) {
              streamRecoveryStartedAtRef.current = Date.now();
              markStreamRecoveryRef.current?.('Agent is still working…');
            }
            return;
          }
        } catch {
          // Probe unavailable — fall through to the existing give-up path so a
          // genuinely dead stream cannot spin forever.
        }
        if (!isStreamActiveRef.current) {
          streamRecoveryStartedAtRef.current = null;
          return;
        }
      }

      const assistantId = streamingAssistantIdRef.current;
      const recoveredText = assembledRef.current.trim();
      const recoveredThinking = thinkingContentRef.current.trim();
      const recoveredThinkingSubject = thinkingSubjectRef.current;
      const recoveredSegments = streamSegmentsRef.current;
      const recoveredToolCalls = activeStreamToolCallsRef.current;

      console.warn('[ChatState] Stream recovery grace period expired — clearing stale live state and reloading history');
      streamRecoveryStartedAtRef.current = null;
      isStreamActiveRef.current = false;
      streamTransportRef.current = null;
      currentRunIdRef.current = null;
      streamingAssistantIdRef.current = null;
      assembledRef.current = '';
      lastSegmentStartRef.current = 0;
      lastRawTextLenRef.current = 0;
      directSnapshotCursorRef.current = { ...EMPTY_CUMULATIVE_SNAPSHOT_CURSOR };
      directClientRef.current?.setActiveStreamSession(null);
      setIsRunning(false);
      setStreamingPhase('idle');
      setStatusText(null);
      resetLiveThinkingTimeline();
      setActiveToolName(null);
      activeStreamToolCallsRef.current = [];
      streamActivityOrderRef.current = 0;
      compactionPhaseRef.current = 'idle';
      setCompactionPhase('idle');

      if (assistantId) {
        setMessages(prev => prev.map(message => {
          if (message.id !== assistantId) return message;
          const fallbackContent = message.content || 'Live stream connection interrupted; history reloaded.';
          const nextContent = recoveredText
            ? `${recoveredText}\n\n*(live stream connection interrupted; history reloaded)*`
            : appendTurnMarker(fallbackContent, LIVE_VIEW_DETACHED_MARKER);
          return {
            ...message,
            content: nextContent,
            thinkingContent: recoveredThinking || message.thinkingContent,
            thinkingSubject: recoveredThinkingSubject || message.thinkingSubject,
            segments: recoveredSegments.length > 0
              ? recoveredSegments.map((segment) => ({
                  text: segment.text,
                  ...(segment.subject ? { subject: segment.subject } : {}),
                  position: 'before' as const,
                  kind: segment.kind,
                  ts: segment.ts,
                  order: segment.order,
                  ...(segment.kind === 'thinking'
                    ? {
                        source: segment.lane === 'preamble'
                          ? 'preamble' as const
                          : segment.lane === 'status'
                            ? 'status' as const
                            : 'reasoning' as const,
                      }
                    : { source: 'text' as const }),
                }))
              : message.segments,
            toolCalls: mergeToolCallSnapshots(message.toolCalls, recoveredToolCalls),
          };
        }));
      }

      setMessages(prev => {
        const content = 'Live stream connection interrupted; reloaded latest history.';
        const last = prev[prev.length - 1];
        if (last?.role === 'system' && last.content === content) return prev;
        return [...prev, { id: nextId(), role: 'system', content, createdAt: new Date(), provenance: 'stream-recovery-timeout' }];
      });
      void loadHistoryInternalRef.current?.(sessionKey, providerName, { force: true, refreshActiveSnapshot: true });
    }, STREAM_RECOVERY_GRACE_MS);
  }, [resetLiveThinkingTimeline]);
  useEffect(() => { markStreamRecoveryRef.current = markStreamRecovery; }, [markStreamRecovery]);

  // Sync refs immediately when state changes. Note: the refs are ALSO updated
  // synchronously in the event handlers (see case 'session' below) to avoid races.
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => {
    portalTurnSequenceRef.current = null;
    portalTurnSequenceScopeRef.current = `${provider}:${session || 'main'}`;
    if (streamContinuityRepairTimerRef.current) {
      clearTimeout(streamContinuityRepairTimerRef.current);
      streamContinuityRepairTimerRef.current = null;
    }
  }, [provider, session]);
  useEffect(() => { providerRef.current = provider; }, [provider]);
  useEffect(() => { agentIdRef.current = agentId; }, [agentId]);
  useEffect(() => { modelRef.current = selectedModel; }, [selectedModel]);
  useEffect(() => { activeToolNameRef.current = activeToolName; }, [activeToolName]);
  useEffect(() => { messageQueueRef.current = messageQueue; }, [messageQueue]);
  useEffect(() => {
    const activeAssistantId = streamingAssistantIdRef.current;
    if (!activeAssistantId) return;
    const activeMessage = messages.find((message) => message.id === activeAssistantId);
    const normalizedToolCalls = normalizeToolCalls(activeMessage?.toolCalls, 'running') || [];
    if (normalizedToolCalls.length) {
      activeStreamToolCallsRef.current = normalizedToolCalls;
    }
    const runningToolCall = getLastRunningToolCall(normalizedToolCalls);
    if (streamingPhase === 'tool' && runningToolCall) {
      const runningToolName = resolveToolName(runningToolCall.name);
      if (runningToolName && runningToolName !== activeToolNameRef.current) {
        activeToolNameRef.current = runningToolName;
        setActiveToolName(runningToolName);
      }
    }
  }, [messages, streamingPhase]);

  const getRunningToolName = useCallback((): string | null => {
    const runningToolCall = getLastRunningToolCall(activeStreamToolCallsRef.current);
    if (runningToolCall?.name) return resolveToolName(runningToolCall.name);
    return activeToolNameRef.current ? resolveToolName(activeToolNameRef.current) : null;
  }, []);

  const getCurrentToolStatusText = useCallback((toolName: string, providerStatus?: string | null) => (
    visibleSilenceNotifiedRef.current
      ? getVisibleSilenceStatus(
          resolveToolName(toolName),
          Date.now() - lastAnyStreamEventAtRef.current <= 30_000,
        )
      : getToolStatusText(toolName, providerStatus)
  ), []);

  const setLiveRunPhase = useCallback((preferredPhase: 'thinking' | 'streaming', nextStatusText?: string | null) => {
    const runningToolName = getRunningToolName();
    const railStatusText = getRailSafeStatusText(nextStatusText);

    if (runningToolName) {
      setStreamingPhase('tool');
      setActiveToolName(runningToolName);
      setStatusText(getCurrentToolStatusText(runningToolName));
      return;
    }

    setStreamingPhase(preferredPhase);
    setActiveToolName(null);
    setStatusText(railStatusText);
  }, [getCurrentToolStatusText, getRunningToolName]);

  const getStreamWatchdogTimeoutMs = useCallback(() => {
    if (getRunningToolName()) return 15 * 60_000;
    if (compactionPhaseRef.current !== 'idle') return 10 * 60_000;
    if (providerRef.current !== 'OPENCLAW') return 2 * 60_000;
    // Assembled text does not mean the turn is nearly done: Claude CLI runtimes
    // routinely go quiet for minutes between a text delta and the next tool or
    // reasoning burst. A short window here fires the fuse mid-healthy-turn.
    return 10 * 60_000;
  }, [getRunningToolName]);

  useEffect(() => {
    if (provider !== 'OPENCLAW') {
      setSessionAvailability('present');
      return;
    }
    if (!session || !session.startsWith('agent:')) {
      setSessionAvailability('unknown');
      return;
    }
    setSessionAvailability('unknown');
  }, [provider, session]);

  const applySessionTelemetry = useCallback((sessionInfo: any) => {
    const actualModel = deriveSessionModel(sessionInfo);
    const next = extractOpenClawSessionTelemetry(sessionInfo, actualModel);
    if (actualModel) {
      setSelectedModelRaw((prev) => (prev === actualModel ? prev : actualModel));
    }
    setSessionTelemetry((prev) => {
      if (!prev && !next) return prev;
      if (!prev || !next) return next;
      if (
        prev.contextTokens === next.contextTokens
        && prev.totalTokens === next.totalTokens
        && prev.pressureRatio === next.pressureRatio
        && prev.compactionCount === next.compactionCount
        && prev.model === next.model
      ) {
        return prev;
      }
      return next;
    });
  }, [deriveSessionModel]);

  const refreshSessionTelemetry = useCallback(async (sessionKey?: string) => {
    const targetSession = typeof sessionKey === 'string' && sessionKey.trim() ? sessionKey.trim() : sessionRef.current;
    if (!startupReady || providerRef.current !== 'OPENCLAW' || !targetSession || !targetSession.startsWith('agent:')) {
      setSessionTelemetry(null);
      return;
    }

    try {
      const data = await gatewayAPI.sessionInfo(targetSession, { silent: true });
      setSessionAvailability('present');
      applySessionTelemetry(data?.session);
    } catch (err: any) {
      if (err?.response?.status === 404) {
        setSessionAvailability('missing');
        setSessionTelemetry(null);
        return;
      }
      console.warn('[ChatState] Failed to refresh session telemetry:', err);
    }
  }, [applySessionTelemetry, startupReady]);

  const scheduleSessionTelemetryRefresh = useCallback((delayMs = 0, sessionKey?: string) => {
    if (sessionTelemetryRefreshTimerRef.current) {
      clearTimeout(sessionTelemetryRefreshTimerRef.current);
      sessionTelemetryRefreshTimerRef.current = null;
    }
    sessionTelemetryRefreshTimerRef.current = setTimeout(() => {
      sessionTelemetryRefreshTimerRef.current = null;
      void refreshSessionTelemetry(sessionKey);
    }, Math.max(0, delayMs));
  }, [refreshSessionTelemetry]);

  const clearPostTurnHistorySync = useCallback(() => {
    if (postTurnHistorySyncTimerRef.current) {
      clearTimeout(postTurnHistorySyncTimerRef.current);
      postTurnHistorySyncTimerRef.current = null;
    }
  }, []);

  const schedulePostTurnHistorySync = useCallback((delayMs = 1200, followUpDelayMs = 3500) => {
    clearPostTurnHistorySync();
    const targetSession = sessionRef.current || 'main';
    const targetProvider = providerRef.current;
    postTurnHistorySyncTimerRef.current = setTimeout(() => {
      postTurnHistorySyncTimerRef.current = null;
      if (isStreamActiveRef.current) return;
      if (providerRef.current !== targetProvider) return;
      if ((sessionRef.current || 'main') !== targetSession) return;
      if (providerUsesPortalStreamBus(targetProvider)) {
        void loadHistoryInternalRef.current?.(targetSession, targetProvider, { force: true, refreshActiveSnapshot: false })
          ?.finally(() => {
            if (followUpDelayMs <= 0) return;
            if (isStreamActiveRef.current) return;
            if (providerRef.current !== targetProvider) return;
            if ((sessionRef.current || 'main') !== targetSession) return;
            postTurnHistorySyncTimerRef.current = setTimeout(() => {
              postTurnHistorySyncTimerRef.current = null;
              if (isStreamActiveRef.current) return;
              if (providerRef.current !== targetProvider) return;
              if ((sessionRef.current || 'main') !== targetSession) return;
              void loadHistoryInternalRef.current?.(targetSession, targetProvider, { force: true, refreshActiveSnapshot: false });
            }, Math.max(0, followUpDelayMs));
          });
      }
    }, Math.max(0, delayMs));
  }, [clearPostTurnHistorySync]);

  // The provider can unmount with a delayed terminal reconciliation still
  // pending (route change, test teardown, logout). Do not let that stale
  // closure reload another chat after ownership has moved elsewhere.
  useEffect(() => () => {
    clearPostTurnHistorySync();
  }, [clearPostTurnHistorySync]);

  const ensureSessionControlsMetadataLoaded = useCallback(async (options?: { force?: boolean }) => {
    if (!startupReady || provider !== 'OPENCLAW' || !session || !session.startsWith('agent:')) return;
    if (providerRef.current !== provider || sessionRef.current !== session) return;
    // Session Controls opens force a refresh: session-info is cheap (~40ms)
    // and the per-model thinking profile must reflect the current model even
    // if an earlier load raced the session-key normalization reset.
    if (sessionControlsMetadataLoaded && !options?.force) return;
    if (sessionControlsMetadataPromiseRef.current) {
      await sessionControlsMetadataPromiseRef.current;
      return;
    }

    const targetProvider = provider;
    const targetSession = session;
    const targetGeneration = sessionControlGenerationRef.current;
    const isCurrentLoad = () => (
      providerRef.current === targetProvider
      && sessionRef.current === targetSession
      && sessionControlGenerationRef.current === targetGeneration
      && sessionControlMutationRef.current === null
    );

    const loadPromise = (async () => {
      setCompactionModelError(null);
      const [sessionInfoResult, compactionResult] = await Promise.allSettled([
        gatewayAPI.sessionInfo(targetSession, { silent: true }),
        gatewayAPI.getConfigPath('agents.defaults.compaction.model'),
      ]);
      if (!isCurrentLoad()) return;

      if (sessionInfoResult.status === 'fulfilled') {
        const data = sessionInfoResult.value;
        setSessionAvailability('present');
        applySessionTelemetry(data?.session);
        const actualModel = deriveSessionModel(data?.session);
        if (actualModel) {
          setSelectedModelRaw((prev) => (prev === actualModel ? prev : actualModel));
        }
        let sessionThinking = String(
          data?.session?.thinkingLevel
          || data?.session?.thinking
          || data?.session?.settings?.thinking
          || '',
        ).toLowerCase();
        let sessionReasoning = String(
          data?.session?.reasoningLevel
          || data?.session?.reasoning
          || data?.session?.settings?.reasoning
          || '',
        ).toLowerCase();

        // Per-model thinking profile: the gateway declares the exact level set
        // for the resolved model. Drive pickers from this instead of guessing.
        const hasProfileOptions = Array.isArray(data?.session?.thinkingOptions);
        const profileOptions = hasProfileOptions
          ? (data.session.thinkingOptions as unknown[])
              .map((entry) => String(entry || '').trim().toLowerCase())
              .filter((entry) => THINKING_LEVELS.includes(entry as ThinkingLevel))
          : [];
        // Stale local-registry fallbacks (gateway busy) omit thinkingOptions
        // entirely; keep the previously loaded profile instead of clobbering
        // it — session switches already reset it to [].
        if (hasProfileOptions) setSessionThinkingOptions(profileOptions);
        const profileDefault = String(data?.session?.thinkingDefault || '').trim().toLowerCase();

        const supportsLevel = (level: string) => profileOptions.length === 0 || profileOptions.includes(level);
        const preferredDefaultThinking = profileDefault && supportsLevel(profileDefault)
          ? profileDefault
          : (supportsLevel('high') ? 'high' : profileOptions.find((level) => level !== 'off') || '');

        if (THINKING_LEVELS.includes(sessionThinking as ThinkingLevel)) {
          const nextThinking = sessionThinking as ThinkingLevel;
          thinkingLevelRef.current = nextThinking;
          setThinkingLevelState(nextThinking);
        } else if (preferredDefaultThinking && THINKING_LEVELS.includes(preferredDefaultThinking as ThinkingLevel)) {
          const nextThinking = preferredDefaultThinking as ThinkingLevel;
          thinkingLevelRef.current = nextThinking;
          setThinkingLevelState(nextThinking);
        } else {
          const modelStr = String(actualModel || '').toLowerCase();
          const isAdaptiveDefault = /claude-(opus|sonnet)-4[._-](5|6|7|8|9)|claude-(opus|sonnet)-[5-9]/.test(modelStr);
          const nextThinking = isAdaptiveDefault ? 'adaptive' : 'high';
          thinkingLevelRef.current = nextThinking;
          setThinkingLevelState(nextThinking);
        }
        const nextReasoning = sessionReasoning === 'on'
          ? 'stream'
          : (REASONING_VISIBILITY_LEVELS.includes(sessionReasoning as ReasoningVisibility)
              ? sessionReasoning as ReasoningVisibility
              : 'stream');
        reasoningVisibilityRef.current = nextReasoning;
        setReasoningVisibilityState(nextReasoning);
        const nextFastMode = Boolean(
          data?.session?.fastMode
          ?? data?.session?.settings?.fastMode
          ?? false,
        );
        fastModeEnabledRef.current = nextFastMode;
        setFastModeEnabled(nextFastMode);
      }

      if (sessionInfoResult.status === 'rejected' && (sessionInfoResult.reason as any)?.response?.status === 404) {
        setSessionAvailability('missing');
        setSessionTelemetry(null);
      }

      if (compactionResult.status === 'fulfilled') {
        const value = typeof compactionResult.value?.value === 'string' ? compactionResult.value.value.trim() : '';
        compactionModelOverrideRef.current = value;
        setCompactionModelOverrideState(value);
      } else {
        compactionModelOverrideRef.current = '';
        setCompactionModelOverrideState('');
      }

      setSessionControlsMetadataLoaded(true);
    })();

    sessionControlsMetadataPromiseRef.current = loadPromise;
    try {
      await loadPromise;
    } finally {
      if (sessionControlsMetadataPromiseRef.current === loadPromise) {
        sessionControlsMetadataPromiseRef.current = null;
      }
    }
  }, [startupReady, provider, session, sessionControlsMetadataLoaded, deriveSessionModel, applySessionTelemetry]);

  useEffect(() => {
    sessionControlGenerationRef.current += 1;
    sessionControlMutationRef.current = null;
    setSessionControlMutation(null);
    setSessionControlsError(null);
    setCompactionModelLoading(false);
    setSessionControlsMetadataLoaded(false);
    sessionControlsMetadataPromiseRef.current = null;
    setThinkingLevelState('high');
    thinkingLevelRef.current = 'high';
    setSessionThinkingOptions([]);
    setReasoningVisibilityState('stream');
    reasoningVisibilityRef.current = 'stream';
    setFastModeEnabled(false);
    fastModeEnabledRef.current = false;
    setCompactionModelOverrideState('');
    compactionModelOverrideRef.current = '';
    setCompactionModelError(null);
    if (provider !== 'OPENCLAW' || !session || !session.startsWith('agent:') || !startupReady) {
      setSessionTelemetry(null);
      if (sessionTelemetryRefreshTimerRef.current) {
        clearTimeout(sessionTelemetryRefreshTimerRef.current);
        sessionTelemetryRefreshTimerRef.current = null;
      }
      return;
    }
    scheduleSessionTelemetryRefresh(0, session);
  }, [provider, session, scheduleSessionTelemetryRefresh, startupReady]);

  useEffect(() => () => {
    if (sessionTelemetryRefreshTimerRef.current) {
      clearTimeout(sessionTelemetryRefreshTimerRef.current);
      sessionTelemetryRefreshTimerRef.current = null;
    }
  }, []);

  const normalizeAgentError = useCallback((err: unknown, fallback = 'Agent request failed') => {
    const raw = err instanceof Error ? err.message : String(err || '').trim();
    if (!raw) return fallback;
    if (/not logged in|please run \/login/i.test(raw)) return 'This provider is installed but not logged in on the server yet.';
    if (/GEMINI_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_GENAI_USE_GCA|Auth method|Antigravity.*not signed in|please sign in/i.test(raw)) return 'Antigravity is installed but not authenticated on the server yet.';
    if (/ECONNREFUSED|Cannot connect to OpenClaw gateway|gateway.*not connected/i.test(raw)) return 'OpenClaw is reconnecting right now. Give it a few seconds and retry.';
    return raw;
  }, []);

  const isAbortTerminalError = useCallback((payload: any) => {
    if (!payload || payload.aborted !== true) return false;
    const raw = String(payload.errorMessage || payload.error || '').trim();
    return !raw || /Agent couldn't generate a response|Agent couldn.t generate a response|aborted|cancelled|canceled/i.test(raw);
  }, []);

  // Stream watchdogs deliberately track two different facts. Any transport
  // event proves the run is alive; only real assistant/reasoning content proves
  // the visible text lane is advancing. Tool traffic must never masquerade as
  // assistant thought just to keep the UI looking busy.
  const resetStreamWatchdog = useCallback((options?: { visible?: boolean }) => {
    const now = Date.now();
    const nextClock = recordStreamActivity({
      lastAnyEventAt: lastAnyStreamEventAtRef.current,
      lastVisibleTextAt: lastVisibleTextEventAtRef.current,
    }, now, options?.visible === true);
    lastAnyStreamEventAtRef.current = nextClock.lastAnyEventAt;
    lastVisibleTextEventAtRef.current = nextClock.lastVisibleTextAt;
    if (options?.visible) visibleSilenceNotifiedRef.current = false;

    if (options?.visible && visibleStreamWatchdogRef.current) {
      clearTimeout(visibleStreamWatchdogRef.current);
      visibleStreamWatchdogRef.current = null;
    }
    if (isStreamActiveRef.current && !visibleSilenceNotifiedRef.current && !visibleStreamWatchdogRef.current) {
      const visibleBaseline = nextClock.lastVisibleTextAt || nextClock.lastAnyEventAt;
      const visibleDelay = Math.max(0, VISIBLE_STREAM_SILENCE_MS - (now - visibleBaseline));
      visibleStreamWatchdogRef.current = setTimeout(() => {
        visibleStreamWatchdogRef.current = null;
        if (!isStreamActiveRef.current || visibleSilenceNotifiedRef.current) return;
        visibleSilenceNotifiedRef.current = true;
        // Compaction already has a truthful dedicated rail; do not overwrite it.
        if (compactionPhaseRef.current !== 'idle') return;
        const runningToolName = getRunningToolName();
        setStatusText(getVisibleSilenceStatus(
          runningToolName,
          Date.now() - lastAnyStreamEventAtRef.current <= 30_000,
        ));
        if (runningToolName) {
          setStreamingPhase('tool');
          setActiveToolName(runningToolName);
        }
      }, visibleDelay);
    }

    if (streamWatchdogRef.current) clearTimeout(streamWatchdogRef.current);
    if (!isStreamActiveRef.current) return;
    const timeoutMs = getStreamWatchdogTimeoutMs();
    streamWatchdogRef.current = setTimeout(async () => {
      if (!isStreamActiveRef.current) return;
      console.warn(`[ChatState] Stream watchdog: no activity for ${Math.round(timeoutMs / 1000)}s — verifying stream status`);

      const currentSession = sessionRef.current || 'main';
      const currentProvider = providerRef.current;
      const usingDirectOpenClaw = useDirectGateway && currentProvider === 'OPENCLAW';
      const directClient = directClientRef.current;

      if (usingDirectOpenClaw && !directClient?.isConnected) {
        directClient?.connect();
        setIsRunning(true);
        setStreamingPhase(prev => prev === 'idle' ? (activeToolName ? 'tool' : 'thinking') : prev);
        markStreamRecovery(activeToolName ? getToolStatusText(activeToolName) : 'Reconnecting to stream…');
      } else if (!usingDirectOpenClaw && wsManagerRef.current && !wsManagerRef.current.isConnected()) {
        wsManagerRef.current.reconnect();
        markStreamRecovery('Reconnecting to stream…');
      }

      try {
        const params: Record<string, string> = { session: currentSession };
        if (currentProvider) params.provider = currentProvider;
        const { data } = await client.get('/gateway/stream-status', { params, _silent: true } as any);
        if (data?.active) {
          const phase = data.phase === 'tool' ? 'tool' : data.phase === 'streaming' ? 'streaming' : 'thinking';
          const snapshotToolName = resolveToolName(data.toolName, data.name, data.content, 'tool');
          const fallbackStatus = snapshotToolName
            ? `Using ${snapshotToolName}…`
            : phase === 'streaming'
              ? 'Still responding…'
              : 'Still working…';
          const hydrated = applyOpenClawActiveStreamSnapshotRef.current(data, {
            statusTextWhenNoTool: fallbackStatus,
            source: usingDirectOpenClaw ? 'direct' : 'portal',
          });
          if (!hydrated) {
            directClientRef.current?.setActiveStreamSession(currentSession);
            setIsRunning(true);
            setStreamingPhase(phase);
            setActiveToolName(snapshotToolName || null);
            setStatusText(
              snapshotToolName
                ? getToolStatusText(snapshotToolName, typeof data.statusText === 'string' ? data.statusText : null)
                : (typeof data.statusText === 'string' && data.statusText.trim() ? data.statusText.trim() : fallbackStatus)
            );
            applyCompactionSnapshotStateRef.current(data.compactionPhase);
            resetStreamWatchdog();
          }
          return;
        }
      } catch (err) {
        console.warn('[ChatState] Stream watchdog verification failed:', err);
        if (usingDirectOpenClaw && (currentRunIdRef.current || activeToolName || hasRealToolEventsRef.current)) {
          setIsRunning(true);
          setStreamingPhase(prev => prev === 'idle' ? (activeToolName ? 'tool' : 'thinking') : prev);
          markStreamRecovery(activeToolName ? getToolStatusText(activeToolName) : 'Reconnecting to stream…');
          resetStreamWatchdog();
          return;
        }
      }

      const ft = assembledRef.current;
      const shouldReloadHistoryIfIdle = Boolean(streamingAssistantIdRef.current)
        || Boolean(ft.trim())
        || streamSegmentsRef.current.length > 0
        || hasRealToolEventsRef.current;

      clearStreamRecoveryTimer();
      isStreamActiveRef.current = false;
      streamTransportRef.current = null;
      setIsRunning(false);
      setStreamingPhase('idle');
      setStatusText(null);
      setThinkingContent('');
      setThinkingSubject('');
      thinkingSubjectRef.current = '';
      setActiveToolName(null);
      setCompactionPhase('idle');
      if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
      const cid = streamingAssistantIdRef.current;
      streamingAssistantIdRef.current = null;
      currentRunIdRef.current = null;
      directClientRef.current?.setActiveStreamSession(null);
      assembledRef.current = '';
      lastSegmentStartRef.current = 0;
      lastRawTextLenRef.current = 0;
      directSnapshotCursorRef.current = { ...EMPTY_CUMULATIVE_SNAPSHOT_CURSOR };

      if (shouldReloadHistoryIfIdle) {
        void loadHistoryInternalRef.current?.(currentSession, currentProvider, { force: true, refreshActiveSnapshot: true });
        return;
      }

      if (cid && ft) {
        setMessages(prev => prev.map(m =>
          m.id === cid ? { ...m, content: ft + '\n\n*(stream interrupted)*' } : m
        ));
      }
    }, timeoutMs);
  }, [activeToolName, clearStreamRecoveryTimer, getRunningToolName, getStreamWatchdogTimeoutMs, markStreamRecovery, useDirectGateway]);
  resetStreamWatchdogRef.current = resetStreamWatchdog;
  const clearStreamWatchdog = useCallback(() => {
    if (streamWatchdogRef.current) { clearTimeout(streamWatchdogRef.current); streamWatchdogRef.current = null; }
    if (visibleStreamWatchdogRef.current) { clearTimeout(visibleStreamWatchdogRef.current); visibleStreamWatchdogRef.current = null; }
    lastAnyStreamEventAtRef.current = 0;
    lastVisibleTextEventAtRef.current = 0;
    visibleSilenceNotifiedRef.current = false;
  }, []);

  const resolveOpenClawSessionKey = useCallback((rawSession?: string | null): string => {
    const sessionKey = typeof rawSession === 'string' ? rawSession.trim() : '';
    if (providerRef.current !== 'OPENCLAW') return sessionKey;
    if (sessionKey.startsWith('agent:')) return sessionKey;
    if (!sessionKey || sessionKey === 'main') {
      return toConcreteOpenClawSessionKey('main', agentIdRef.current);
    }
    if (sessionKey.startsWith('new-')) {
      return toConcreteOpenClawSessionKey(sessionKey, agentIdRef.current);
    }
    return sessionKey;
  }, []);
  resolveOpenClawSessionKeyRef.current = resolveOpenClawSessionKey;

  const replacePendingUserQuestions = useCallback((questions: GatewayPendingQuestion[]) => {
    pendingUserQuestionsRef.current = questions;
    const pendingAnswer = pendingQuestionComposerAnswerRef.current;
    if (pendingAnswer && !questions.some((entry) => entry.id === pendingAnswer.id)) {
      pendingQuestionComposerAnswerRef.current = null;
    }
    setPendingUserQuestions(questions);
  }, []);

  const settlePendingUserQuestion = useCallback((id: string) => {
    replacePendingUserQuestions(
      pendingUserQuestionsRef.current.filter((entry) => entry.id !== id),
    );
  }, [replacePendingUserQuestions]);

  const refreshPendingUserQuestions = useCallback(async () => {
    if (providerRef.current !== 'OPENCLAW') return;
    const requestedSession = resolveOpenClawSessionKey(sessionRef.current);
    if (!requestedSession) return;
    const generation = pendingQuestionPollGenerationRef.current;
    const data = await gatewayAPI.pendingQuestions(requestedSession);
    if (
      generation !== pendingQuestionPollGenerationRef.current
      || providerRef.current !== 'OPENCLAW'
      || resolveOpenClawSessionKey(sessionRef.current) !== requestedSession
    ) return;
    const now = Date.now();
    const questions = (Array.isArray(data?.questions) ? data.questions : []).filter((entry) => (
      entry?.sessionKey === requestedSession
      && entry.state === 'pending'
      && entry.expiresAt > now
      && entry.surface === 'agent-chat'
    ));
    pendingUserQuestionsReadyRef.current = true;
    replacePendingUserQuestions(questions);
  }, [replacePendingUserQuestions, resolveOpenClawSessionKey]);

  useEffect(() => {
    pendingQuestionPollGenerationRef.current += 1;
    pendingQuestionComposerAnswerRef.current = null;
    pendingActiveSteerRef.current = null;
    pendingUserQuestionsReadyRef.current = false;
    replacePendingUserQuestions([]);
    if (provider !== 'OPENCLAW' || !session) return undefined;

    let cancelled = false;
    let timer: number | null = null;
    let consecutiveFailures = 0;
    const schedule = (delayMs: number) => {
      if (cancelled) return;
      timer = window.setTimeout(() => { void poll(); }, delayMs);
    };
    const poll = async () => {
      try {
        await refreshPendingUserQuestions();
        consecutiveFailures = 0;
      } catch {
        // Keep the last confirmed card mounted and back off while the gateway
        // is restarting. A fixed two-second poll turned a short outage into a
        // wall of identical 503 activity records.
        consecutiveFailures += 1;
      } finally {
        const delay = consecutiveFailures === 0
          ? 2_000
          : Math.min(30_000, 2_000 * (2 ** Math.min(consecutiveFailures, 4)));
        schedule(delay);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      pendingQuestionPollGenerationRef.current += 1;
    };
  }, [provider, refreshPendingUserQuestions, replacePendingUserQuestions, session]);

  const clearSessionActivityTitle = useCallback((sessionKey: string) => {
    const timer = activityTitleTimersRef.current.get(sessionKey);
    if (timer) clearTimeout(timer);
    activityTitleTimersRef.current.delete(sessionKey);
    activityTitleRunsRef.current.delete(sessionKey);
    setActivityTitles((current) => {
      if (!(sessionKey in current)) return current;
      const next = { ...current };
      delete next[sessionKey];
      return next;
    });
  }, []);

  const clearAllActivityTitles = useCallback(() => {
    for (const timer of activityTitleTimersRef.current.values()) clearTimeout(timer);
    activityTitleTimersRef.current.clear();
    activityTitleRunsRef.current.clear();
    setActivityTitles((current) => (
      Object.keys(current).length === 0 ? current : {}
    ));
  }, []);
  const clearAllActivityTitlesRef = useRef(clearAllActivityTitles);
  clearAllActivityTitlesRef.current = clearAllActivityTitles;

  const observeSessionActivityTitle = useCallback((data: any) => {
    if (data?.type !== 'activity_title' || data?.activityScope !== 'agent-chat') return;
    const sessionKey = resolveOpenClawSessionKey(
      typeof data?.sessionKey === 'string' ? data.sessionKey : '',
    );
    if (!sessionKey) return;

    const runId = normalizeRunId(data?.runId) || '';
    const trackedRunId = activityTitleRunsRef.current.get(sessionKey) || '';
    const update = classifyActivityTitleEvent({
      type: data?.activityType,
      subject: data?.subject,
      runId,
      trackedRunId,
    });
    if (update.kind === 'ignore') return;

    if (update.kind === 'set') {
      if (update.runId) activityTitleRunsRef.current.set(sessionKey, update.runId);
      const previousTimer = activityTitleTimersRef.current.get(sessionKey);
      if (previousTimer) clearTimeout(previousTimer);
      const expectedRunId = update.runId;
      activityTitleTimersRef.current.set(sessionKey, setTimeout(() => {
        const currentRunId = activityTitleRunsRef.current.get(sessionKey) || '';
        if (expectedRunId && currentRunId && currentRunId !== expectedRunId) return;
        activityTitleTimersRef.current.delete(sessionKey);
        activityTitleRunsRef.current.delete(sessionKey);
        setActivityTitles((current) => {
          if (!(sessionKey in current)) return current;
          const next = { ...current };
          delete next[sessionKey];
          return next;
        });
      }, ACTIVITY_TITLE_EXPIRY_MS));
      setActivityTitles((current) => (
        current[sessionKey] === update.subject
          ? current
          : { ...current, [sessionKey]: update.subject }
      ));
      return;
    }

    clearSessionActivityTitle(sessionKey);
  }, [clearSessionActivityTitle, resolveOpenClawSessionKey]);

  useEffect(() => {
    if (!wsConnected) clearAllActivityTitles();
  }, [clearAllActivityTitles, wsConnected]);

  useEffect(() => () => {
    for (const timer of activityTitleTimersRef.current.values()) clearTimeout(timer);
    activityTitleTimersRef.current.clear();
  }, []);

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

  const reconcileIncomingRunEpoch = useCallback((
    incomingRunId: string | null,
    options?: { continuationVerified?: boolean },
  ) => {
    const previousRunId = currentRunIdRef.current;
    const result = reconcileRunEpoch({
      currentRunId: currentRunIdRef.current,
      retiredRunIds: retiredRunIdsRef.current,
    }, {
      incomingRunId,
      streamActive: isStreamActiveRef.current,
      continuationVerified: options?.continuationVerified === true,
    });
    currentRunIdRef.current = result.state.currentRunId;
    retiredRunIdsRef.current = result.state.retiredRunIds;
    if (result.decision === 'adopt' && options?.continuationVerified === true) {
      // Every transport (Portal WS, direct gateway, SSE, and history snapshot)
      // must freeze the visible predecessor before a replacement run starts
      // sending cumulative/replace frames.
      prepareVerifiedContinuationAdoptionRef.current();
    }
    if (result.state.currentRunId !== previousRunId) {
      compatibilityToolReplayIdsRef.current.clear();
      pendingQuestionPollGenerationRef.current += 1;
      pendingUserQuestionsReadyRef.current = false;
      pendingQuestionComposerAnswerRef.current = null;
      pendingActiveSteerRef.current = null;
      replacePendingUserQuestions([]);
    }
    return result.decision;
  }, [replacePendingUserQuestions]);

  const recordReasoningTurnSequence = useCallback((payload: any) => {
    const turnEvent = payload?.turnEvent;
    const isVisibleReasoningStatus = turnEvent?.type === 'assistant_status'
      && turnEvent?.visible === true
      && turnEvent?.source?.eventType === 'status';
    if (turnEvent?.type !== 'assistant_reasoning' && !isVisibleReasoningStatus) return;
    const runId = normalizeRunId(turnEvent.runId || payload?.runId);
    const seq = Number(turnEvent.seq);
    if (!runId || !Number.isFinite(seq) || seq < 0) return;
    const current = reasoningSequenceRef.current;
    reasoningSequenceRef.current = {
      runId,
      seq: current.runId === runId && current.seq !== null
        ? Math.max(current.seq, seq)
        : seq,
    };
  }, []);

  const recordRuntimeReplaySequence = useCallback((payload: any) => {
    const turnEvent = payload?.turnEvent;
    const runId = normalizeRunId(turnEvent?.runId || payload?.runId);
    const seq = Number(turnEvent?.seq);
    if (!runId || !Number.isFinite(seq) || seq < 0) return;
    const current = runtimeReplaySequenceRef.current;
    runtimeReplaySequenceRef.current = {
      runId,
      seq: current.runId === runId && current.seq !== null
        ? Math.max(current.seq, seq)
        : seq,
    };
  }, []);

  const resetDirectSnapshotCursor = useCallback(() => {
    directSnapshotCursorRef.current = { ...EMPTY_CUMULATIVE_SNAPSHOT_CURSOR };
    directPreambleProgressRef.current = createPreambleProgressAccumulator();
  }, []);

  const applyCompactionState = useCallback((update: {
    phase: 'start' | 'end';
    content?: string | null;
    completed?: boolean;
    maintenanceKind?: 'compaction' | 'maintenance';
  } | 'start' | 'end') => {
    if (providerRef.current !== 'OPENCLAW') return;

    const phase = typeof update === 'string' ? update : update.phase;
    const content = typeof update === 'string' ? '' : String(update.content || '').trim();
    const completed = typeof update === 'string' ? phase === 'end' : update.completed !== false;
    const maintenanceKind = typeof update === 'string' ? 'compaction' : (update.maintenanceKind || 'compaction');

    if (phase === 'start') {
      const noticeText = content || (maintenanceKind === 'maintenance' ? 'Context maintenance in progress…' : 'Compacting context…');
      if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
      compactionPhaseRef.current = 'compacting';
      setCompactionPhase('compacting');
      setStatusText(noticeText);
      setThinkingContent('');
      setThinkingSubject('');
      thinkingSubjectRef.current = '';
      return;
    }

    if (completed && maintenanceKind === 'compaction') {
      const noticeText = content || 'Context compacted';
      compactionPhaseRef.current = 'compacted';
      setCompactionPhase('compacted');
      setStatusText(noticeText);
      appendSystemNotice(noticeText, 'compaction');
      if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
      compactionTimerRef.current = setTimeout(() => {
        compactionPhaseRef.current = 'idle';
        setCompactionPhase('idle');
        setStatusText((prev) => (prev === noticeText ? null : prev));
        compactionTimerRef.current = null;
      }, 3000);
      return;
    }

    const noticeText = content || 'Context maintenance finished.';
    compactionPhaseRef.current = 'idle';
    setCompactionPhase('idle');
    setStatusText(noticeText);
    appendSystemNotice(noticeText, 'hidden-history-artifact');
    if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
    compactionTimerRef.current = setTimeout(() => {
      setStatusText((prev) => (prev === noticeText ? null : prev));
      compactionTimerRef.current = null;
    }, 3000);
  }, [appendSystemNotice]);

  const applyCompactionSnapshotState = useCallback((phase?: unknown) => {
    if (phase !== 'idle' && phase !== 'compacting' && phase !== 'compacted') return;
    // Snapshot hydration is replay/reconnect state, not a live lifecycle event.
    // Replaying a completed compaction marker on every refresh creates a fake rail.
    // Live compaction_end events still use applyCompactionState('end') and render once.
    const effectivePhase = phase === 'compacted' ? 'idle' : phase;
    if (compactionTimerRef.current) {
      clearTimeout(compactionTimerRef.current);
      compactionTimerRef.current = null;
    }
    compactionPhaseRef.current = effectivePhase;
    setCompactionPhase(effectivePhase);
    if (effectivePhase === 'compacting') {
      setStatusText('Compacting context…');
    } else {
      setStatusText(prev => (prev === 'Compacting context…' || prev === 'Context compacted' ? null : prev));
    }
  }, []);
  applyCompactionSnapshotStateRef.current = applyCompactionSnapshotState;

  const mergeStreamText = useCallback((incoming?: string, opts?: { replace?: boolean }) => {
    const chunk = typeof incoming === 'string' ? incoming : '';
    if (!chunk) return assembledRef.current;
    assembledRef.current = mergeAssistantStream(assembledRef.current, chunk, opts);
    return assembledRef.current;
  }, []);

  const upsertStreamingAssistant = useCallback((text: string) => {
    const cid = streamingAssistantIdRef.current;
    if (!cid) return;
    setMessages(prev => prev.map(m => m.id === cid ? { ...m, content: text } : m));
  }, []);

  const clearPendingTextRender = useCallback(() => {
    if (textThrottleTimerRef.current) {
      clearTimeout(textThrottleTimerRef.current);
      textThrottleTimerRef.current = null;
    }
    pendingTextUpdateRef.current = null;
  }, []);

  const schedulePendingTextRender = useCallback((text: string) => {
    pendingTextUpdateRef.current = text;
    if (textThrottleTimerRef.current) return;
    textThrottleTimerRef.current = setTimeout(() => {
      textThrottleTimerRef.current = null;
      if (pendingTextUpdateRef.current !== null) {
        upsertStreamingAssistant(pendingTextUpdateRef.current);
        pendingTextUpdateRef.current = null;
      }
    }, TEXT_THROTTLE_MS);
  }, [upsertStreamingAssistant]);

  const ensureStreamingAssistantBubble = useCallback((params?: {
    idPrefix?: string;
    content?: string;
    resetIfCreated?: boolean;
  }) => {
    const prefix = params?.idPrefix || 'stream';
    let assistantId = streamingAssistantIdRef.current;
    let created = false;
    if (!assistantId) {
      assistantId = `${prefix}-${Date.now()}`;
      streamingAssistantIdRef.current = assistantId;
      created = true;
      if (params?.resetIfCreated) {
        assembledRef.current = '';
        lastSegmentStartRef.current = 0;
        lastRawTextLenRef.current = 0;
        resetDirectSnapshotCursor();
        toolCounterRef.current = 0;
        streamActivityOrderRef.current = 0;
        hasRealToolEventsRef.current = false;
        resetLiveThinkingTimeline();
      }
    }

    const maybeContent = typeof params?.content === 'string' ? params.content : null;
    setMessages(prev => {
      const index = prev.findIndex(m => m.id === assistantId);
      if (index >= 0) {
        if (maybeContent === null) return prev;
        const next = [...prev];
        next[index] = { ...next[index], content: maybeContent };
        return next;
      }
      const streamModel = normalizeProviderModel(providerRef.current, modelRef.current || '');
      return [...prev, {
        id: assistantId!,
        role: 'assistant' as const,
        content: maybeContent ?? '',
        createdAt: new Date(),
        model: streamModel || undefined,
        toolCalls: [],
      }];
    });
    return { assistantId, created };
  }, [resetDirectSnapshotCursor, resetLiveThinkingTimeline]);

  const appendStreamSegment = useCallback((
    kind: StreamSegment['kind'],
    text: string,
    subject?: string,
    lane?: StreamSegment['lane'],
  ) => {
    const value = typeof text === 'string' ? text : '';
    const safeSubject = kind === 'thinking' ? sanitizeThinkingSubject(subject) : '';
    if (!value.trim() && !safeSubject) return false;
    const nextSegments = [
      ...streamSegmentsRef.current,
      {
        text: value,
        ...(safeSubject ? { subject: safeSubject } : {}),
        ts: Date.now(),
        kind,
        order: streamActivityOrderRef.current++,
        ...(kind === 'thinking' && lane ? { lane } : {}),
      },
    ];
    streamSegmentsRef.current = nextSegments;
    setStreamSegments(nextSegments);
    return true;
  }, []);

  const graduateLiveTextSegment = useCallback((assistantId?: string | null) => {
    const currentText = assembledRef.current;
    if (!currentText.trim()) return false;
    clearPendingTextRender();
    appendStreamSegment('text', currentText);
    assembledRef.current = '';
    if (assistantId) {
      setMessages(prev => prev.map(m => (
        m.id === assistantId ? { ...m, content: '' } : m
      )));
    }
    return true;
  }, [appendStreamSegment, clearPendingTextRender]);

  const graduateDirectLiveTextSegment = useCallback((assistantId?: string | null) => {
    if (!assembledRef.current.trim()) return false;
    directSnapshotCursorRef.current = beginCumulativeSnapshotSegment(directSnapshotCursorRef.current);
    lastSegmentStartRef.current = directSnapshotCursorRef.current.segmentBaseline.length;
    return graduateLiveTextSegment(assistantId);
  }, [graduateLiveTextSegment]);

  const graduateLiveThinkingSegment = useCallback(() => {
    const currentThinking = thinkingContentRef.current;
    const currentSubject = thinkingSubjectRef.current;
    if (!currentThinking.trim() && !currentSubject) return false;
    markThinkingSnapshotGraduated(
      thinkingSnapshotTrackerRef.current,
      reasoningLaneRef.current,
    );
    appendStreamSegment(
      'thinking',
      currentThinking,
      currentSubject,
      reasoningLaneRef.current || undefined,
    );
    thinkingContentRef.current = '';
    reasoningLaneRef.current = null;
    setThinkingContent('');
    thinkingSubjectRef.current = '';
    setThinkingSubject('');
    return true;
  }, [appendStreamSegment]);

  const prepareVerifiedContinuationAdoption = useCallback(() => {
    const continuingAssistantId = streamingAssistantIdRef.current;
    if (!continuingAssistantId) return;
    graduateLiveThinkingSegment();
    if (assembledRef.current.trim()) graduateLiveTextSegment(continuingAssistantId);
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = 0;
    resetDirectSnapshotCursor();
  }, [graduateLiveTextSegment, graduateLiveThinkingSegment, resetDirectSnapshotCursor]);
  prepareVerifiedContinuationAdoptionRef.current = prepareVerifiedContinuationAdoption;

  const buildGraduatedSegments = useCallback((segments: StreamSegment[], finalContent: string): TextSegment[] => {
    const graduatedSegments: TextSegment[] = [];
    for (const seg of segments) {
      graduatedSegments.push({
        text: seg.text,
        ...(seg.subject ? { subject: seg.subject } : {}),
        position: 'before',
        kind: seg.kind,
        ts: seg.ts,
        order: seg.order,
        ...(seg.kind === 'thinking'
          ? {
              source: seg.lane === 'preamble'
                ? 'preamble' as const
                : seg.lane === 'status'
                  ? 'status' as const
                  : 'reasoning' as const,
            }
          : { source: 'text' as const }),
      });
    }
    const finalTail = reconcileCumulativeFinalTail(
      segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text),
      finalContent,
    );
    if (finalTail && finalTail.trim()) {
      graduatedSegments.push({
        text: finalTail,
        position: 'after',
        kind: 'text',
        ts: Date.now(),
        order: streamActivityOrderRef.current++,
      });
    }
    return graduatedSegments;
  }, []);

  const appendThinkingChunk = useCallback((
    _assistantId: string | null,
    chunk: string,
    opts?: { replace?: boolean; lane?: 'raw' | 'preamble' | 'status' },
  ) => {
    if (!chunk) return;
    const nextLane = opts?.lane || 'raw';
    if (
      reasoningLaneRef.current
      && reasoningLaneRef.current !== nextLane
      && (thinkingContentRef.current.trim() || thinkingSubjectRef.current)
    ) {
      graduateLiveThinkingSegment();
    }
    reasoningLaneRef.current = nextLane;
    const projectedChunk = projectThinkingChunkAfterGraduation(
      thinkingSnapshotTrackerRef.current,
      nextLane,
      chunk,
      opts?.replace === true,
    );
    // A delayed cumulative snapshot can equal the prefix already graduated at
    // a tool boundary. It carries no new visible reasoning and must not clear
    // a newer append-style delta already on screen.
    if (!projectedChunk) return;
    const nextThinking = mergeThinkingStream(
      thinkingContentRef.current,
      projectedChunk,
      opts,
    );
    thinkingContentRef.current = nextThinking;
    setThinkingContent(nextThinking);
  }, [graduateLiveThinkingSegment]);

  const applyThinkingSubject = useCallback((assistantId: string | null, rawSubject: unknown) => {
    const subject = sanitizeThinkingSubject(rawSubject);
    if (!subject) return '';
    if (
      subject !== thinkingSubjectRef.current
      && (thinkingContentRef.current.trim() || thinkingSubjectRef.current)
    ) {
      graduateLiveThinkingSegment();
    }
    thinkingSubjectRef.current = subject;
    setThinkingSubject(subject);
    if (assistantId) {
      setMessages((previous) => previous.map((message) => (
        message.id === assistantId
          ? { ...message, thinkingSubject: subject }
          : message
      )));
    }
    return subject;
  }, [graduateLiveThinkingSegment]);

  const clearActiveStreamState = useCallback(() => {
    const pendingDirectFinal = directPendingEmptyFinalRef.current;
    if (pendingDirectFinal) {
      clearTimeout(pendingDirectFinal.timer);
      directPendingEmptyFinalRef.current = null;
    }
    clearStreamWatchdog();
    clearStreamRecoveryTimer();
    clearPendingTextRender();
    isStreamActiveRef.current = false;
    streamTransportRef.current = null;
    currentRunIdRef.current = null;
    streamingAssistantIdRef.current = null;
    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = 0;
    resetDirectSnapshotCursor();
    directClientRef.current?.setActiveStreamSession(null);
    setIsRunning(false);
    setStreamingPhase('idle');
    setStatusText(null);
    resetLiveThinkingTimeline();
    setActiveToolName(null);
    activeStreamToolCallsRef.current = [];
    streamActivityOrderRef.current = 0;
    applyCompactionSnapshotState('idle');
  }, [applyCompactionSnapshotState, clearPendingTextRender, clearStreamRecoveryTimer, clearStreamWatchdog, resetDirectSnapshotCursor, resetLiveThinkingTimeline]);

  // Clear live stream UI without discarding visible turn output. Recovery paths
  // (stream_status safeToClear, idle active-stream snapshots) can fire while the
  // bubble still holds un-graduated thinking/text/tool state; dropping it makes
  // thought bubbles vanish until a manual refresh reloads durable history.
  const preserveLiveTurnThenClear = useCallback((options?: { terminal?: boolean }) => {
    const interruptedAssistantId = streamingAssistantIdRef.current;
    const interruptedSnapshot = {
      text: assembledRef.current,
      thinking: thinkingContentRef.current,
      thinkingSubject: thinkingSubjectRef.current,
      segments: [...streamSegmentsRef.current],
      toolCalls: [...activeStreamToolCallsRef.current],
    };
    clearActiveStreamState();
    const hasVisibleLiveState = Boolean(
      interruptedSnapshot.text.trim()
      || interruptedSnapshot.thinking.trim()
      || interruptedSnapshot.thinkingSubject
      || interruptedSnapshot.segments.length > 0
      || interruptedSnapshot.toolCalls.length > 0,
    );
    if (interruptedAssistantId && hasVisibleLiveState) {
      setMessages(prev => prev.map((message) => {
        if (message.id !== interruptedAssistantId) return message;
        return preserveInterruptedLiveTurnSnapshot(
          message,
          interruptedSnapshot,
          options?.terminal ? null : LIVE_VIEW_DETACHED_MARKER,
        );
      }));
    }
  }, [clearActiveStreamState]);

  const settleCancelledTurn = useCallback((
    rawRunId?: string | null,
    rawSessionKey?: string | null,
  ) => {
    const pendingDirectFinal = directPendingEmptyFinalRef.current;
    if (pendingDirectFinal) {
      clearTimeout(pendingDirectFinal.timer);
      directPendingEmptyFinalRef.current = null;
    }
    clearStreamWatchdog();
    clearStreamRecoveryTimer();
    clearPendingTextRender();

    const assistantId = streamingAssistantIdRef.current;
    const assembledText = assembledRef.current;
    const liveThinking = thinkingContentRef.current;
    const liveThinkingSubject = thinkingSubjectRef.current;
    const liveSegments = [...streamSegmentsRef.current];
    const liveToolCalls = [...activeStreamToolCallsRef.current];
    lastTerminalRunIdRef.current = normalizeRunId(rawRunId) || currentRunIdRef.current;
    const cancelledSession = resolveOpenClawSessionKey(rawSessionKey || sessionRef.current);
    if (cancelledSession) clearSessionActivityTitle(cancelledSession);

    if (assistantId) {
      setMessages((previous) => {
        const withTransientState = previous.map((message) => {
          if (message.id !== assistantId) return message;
          return {
            ...message,
            thinkingContent: liveThinking || message.thinkingContent,
            thinkingSubject: liveThinkingSubject || message.thinkingSubject,
            segments: liveSegments.length > 0
              ? liveSegments.map((segment) => ({
                  text: segment.text,
                  ...(segment.subject ? { subject: segment.subject } : {}),
                  position: 'before' as const,
                  kind: segment.kind,
                  ts: segment.ts,
                  order: segment.order,
                  ...(segment.kind === 'thinking'
                    ? {
                        source: segment.lane === 'preamble'
                          ? 'preamble' as const
                          : segment.lane === 'status'
                            ? 'status' as const
                            : 'reasoning' as const,
                      }
                    : { source: 'text' as const }),
                }))
              : message.segments,
            toolCalls: liveToolCalls.length > 0 ? liveToolCalls : message.toolCalls,
          };
        });
        return settleCancelledAssistantMessage(withTransientState, assistantId, assembledText);
      });
    }

    setStatusText(null);
    setStreamingPhase('idle');
    setActiveToolName(null);
    setIsRunning(false);
    setThinkingContent('');
    thinkingContentRef.current = '';
    reasoningLaneRef.current = null;
    setThinkingSubject('');
    thinkingSubjectRef.current = '';
    setStreamSegments([]);
    streamSegmentsRef.current = [];
    isStreamActiveRef.current = false;
    streamTransportRef.current = null;
    streamingAssistantIdRef.current = null;
    activeStreamToolCallsRef.current = [];
    streamActivityOrderRef.current = 0;
    hasRealToolEventsRef.current = false;
    currentRunIdRef.current = null;
    directClientRef.current?.setActiveStreamSession(null);
    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = 0;
    resetDirectSnapshotCursor();
    compactionPhaseRef.current = 'idle';
    setCompactionPhase('idle');
    if (compactionTimerRef.current) {
      clearTimeout(compactionTimerRef.current);
      compactionTimerRef.current = null;
    }
  }, [
    clearPendingTextRender,
    clearSessionActivityTitle,
    clearStreamRecoveryTimer,
    clearStreamWatchdog,
    resetDirectSnapshotCursor,
    resolveOpenClawSessionKey,
  ]);

  const requestPortalWsAbort = useCallback((
    manager: WsManager,
    payload: Record<string, unknown>,
  ): Promise<boolean> => {
    const requestId = nextAbortRequestId();
    return new Promise<boolean>((resolve) => {
      const finish = (ok: boolean) => {
        const pending = pendingWsAbortResultsRef.current.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingWsAbortResultsRef.current.delete(requestId);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), WS_ABORT_RESULT_TIMEOUT_MS);
      pendingWsAbortResultsRef.current.set(requestId, { timer, resolve: finish });
      const sent = manager.send({ ...payload, requestId });
      if (!sent) finish(false);
    });
  }, []);

  const applyOpenClawActiveStreamSnapshot = useCallback((snapshot: any, options?: {
    statusTextWhenNoTool?: string | null;
    source?: ChatStreamTransport;
  }) => {
    if (!snapshot?.active) return false;
    const snapshotContent = typeof snapshot.content === 'string' && !isControlOrMaintenanceAssistantContent(snapshot.content)
      ? sanitizeAssistantContent(snapshot.content)
      : '';
    const snapshotToolCalls = normalizeToolCalls(snapshot.toolCalls, 'running') || [];
    const preservedToolCalls = activeStreamToolCallsRef.current;
    let effectiveToolCalls = snapshotToolCalls.length > 0
      ? (mergeToolCallSnapshots(preservedToolCalls, snapshotToolCalls) || [])
      : preservedToolCalls;
    let runningToolCall = effectiveToolCalls.find((toolCall) => toolCall.status === 'running');
    let toolNameCandidate = snapshot.toolName || snapshot.name || runningToolCall?.name || activeToolNameRef.current;
    let snapshotToolName = typeof toolNameCandidate === 'string' && toolNameCandidate.trim()
      ? resolveToolName(toolNameCandidate)
      : null;
    const rawStatusText = getRailSafeStatusText(typeof snapshot.statusText === 'string' ? snapshot.statusText.trim() : '');
    const isMaintenanceStatusOnly = Boolean(rawStatusText && isControlOrMaintenanceAssistantContent(rawStatusText));
    let assistantId = streamingAssistantIdRef.current;
    const hasStatusSignal = Boolean(rawStatusText && !isMaintenanceStatusOnly);
    const hasMaintenanceSignal = isMaintenanceStatusOnly
      || snapshot.compactionPhase === 'compacting';
    const hasStructuralActiveSignal = snapshot.active === true && (
      Boolean(snapshot.runId)
      || typeof snapshot.lastEventAt === 'number'
      || typeof snapshot.startedAt === 'number'
      || snapshot.phase === 'thinking'
      || snapshot.phase === 'tool'
      || snapshot.phase === 'streaming'
    );
    const hasLiveSnapshotSignal = Boolean(snapshotContent)
      || Boolean(snapshotToolName)
      || effectiveToolCalls.length > 0
      || hasStatusSignal
      || hasStructuralActiveSignal;
    if (!hasLiveSnapshotSignal && hasMaintenanceSignal) {
      applyCompactionSnapshotState(snapshot.compactionPhase);
      return true;
    }
    const hasMeaningfulSnapshotSignal = hasLiveSnapshotSignal;
    const shouldHydrateLiveState = hasMeaningfulSnapshotSignal || Boolean(assistantId);
    if (!shouldHydrateLiveState) {
      return false;
    }
    let shouldMaterializeBubble = Boolean(snapshotContent)
      || Boolean(snapshotToolName)
      || effectiveToolCalls.length > 0
      || Boolean(assistantId);

    isStreamActiveRef.current = true;
    streamTransportRef.current = options?.source || 'portal';
    const snapshotRunId = normalizeRunId(snapshot.runId);
    let snapshotEpochDecision: ReturnType<typeof reconcileIncomingRunEpoch> | null = null;
    if (snapshotRunId) {
      snapshotEpochDecision = reconcileIncomingRunEpoch(snapshotRunId, { continuationVerified: true });
      if (snapshotEpochDecision === 'reject') return false;
      if (snapshotEpochDecision === 'adopt') {
        resetGraduatedThinkingSnapshotTracker(thinkingSnapshotTrackerRef.current);
      }
    }
    if (providerRef.current === 'OPENCLAW') {
      directClientRef.current?.setActiveStreamSession(sessionRef.current || null);
    }

    // Resume snapshots carry a bounded normalized event tail. Durable runtime
    // overlays attest the exact sequence they already represent; seed provider
    // cumulative cursors from that prefix, then replay only the newer tail in
    // event order. This prevents both failure modes seen after a long hidden
    // tab: dropping genuinely new thoughts and replaying the whole run as one
    // enormous cumulative bubble.
    const snapshotTurnEvents: any[] = Array.isArray(snapshot.turnEvents) ? snapshot.turnEvents : [];
    const hasLocalThinking = Boolean(thinkingContentRef.current.trim())
      || Boolean(thinkingSubjectRef.current)
      || streamSegmentsRef.current.some((segment) => (
        segment.kind === 'thinking'
        && (Boolean(segment.text.trim()) || Boolean(segment.subject))
      ));
    if (snapshotTurnEvents.length > 0) {
      const knownReplaySequence = runtimeReplaySequenceRef.current.runId === snapshotRunId
        ? runtimeReplaySequenceRef.current.seq
        : reasoningSequenceRef.current.runId === snapshotRunId
          ? reasoningSequenceRef.current.seq
          : null;
      const sortedSnapshotEvents = [...snapshotTurnEvents]
        .filter((event) => !snapshotRunId || !normalizeRunId(event?.runId) || normalizeRunId(event?.runId) === snapshotRunId)
        .sort((left, right) => (Number(left?.seq) || 0) - (Number(right?.seq) || 0));
      const allReasoningEvents = selectSnapshotReasoningEvents(snapshotTurnEvents, snapshotRunId);
      const shouldReplayWholeSnapshot = snapshotEpochDecision === 'adopt'
        || (!hasLocalThinking && knownReplaySequence === null);
      const replayAfterSequence = shouldReplayWholeSnapshot
        ? Number.NEGATIVE_INFINITY
        : (knownReplaySequence ?? Number.POSITIVE_INFINITY);

      // Legacy/local recovery can have thought bubbles but no durable cursor.
      // In that unknowable case preserve the visible timeline and only seed the
      // newest cumulative baseline. New builds always carry lastEventSeq.
      const representedReasoning = shouldReplayWholeSnapshot
        ? []
        : allReasoningEvents.filter((event) => Number(event?.seq) <= replayAfterSequence);
      const representedCursors: Partial<Record<'raw' | 'preamble' | 'status', string>> = {};
      for (const event of representedReasoning) {
        const lane = event?.source?.preambleProgress === true
          ? 'preamble'
          : event.type === 'assistant_status'
            ? 'status'
            : 'raw';
        const eventType = event.type === 'assistant_status' ? 'status' : 'thinking';
        const chunk = extractThinkingChunk(eventType, event.text, false);
        if (!chunk) continue;
        representedCursors[lane] = event.replace === true
          ? chunk
          : `${representedCursors[lane] || ''}${chunk}`;
      }
      for (const lane of ['raw', 'preamble', 'status'] as const) {
        const cursor = representedCursors[lane];
        if (cursor && !thinkingSnapshotTrackerRef.current.latest[lane]) {
          seedGraduatedThinkingSnapshot(thinkingSnapshotTrackerRef.current, lane, cursor);
        }
      }

      const replayReasoningSequences = new Set(allReasoningEvents
        .filter((event) => Number(event?.seq) > replayAfterSequence)
        .map((event) => Number(event?.seq)));
      const preservedToolIds = new Set(preservedToolCalls.map((tool) => tool.id));
      const replayedToolIds = new Set<string>();
      const findLastSnapshotToolIndex = (predicate: (tool: ToolCall) => boolean) => {
        for (let index = effectiveToolCalls.length - 1; index >= 0; index -= 1) {
          if (predicate(effectiveToolCalls[index])) return index;
        }
        return -1;
      };
      const upsertSnapshotToolEvent = (event: any) => {
        const rawName = typeof event?.tool?.name === 'string' ? event.tool.name.trim() : '';
        if (!rawName) return;
        const name = resolveToolName(rawName);
        if (!name || isMessageToolName(name)) return;
        const eventSeq = Number(event?.seq);
        const eventTs = Number(event?.ts);
        const id = typeof event?.tool?.id === 'string' && event.tool.id.trim()
          ? event.tool.id.trim()
          : `snapshot-tool-${snapshotRunId || 'run'}-${Number.isFinite(eventSeq) ? eventSeq : effectiveToolCalls.length}`;
        let index = effectiveToolCalls.findIndex((tool) => tool.id === id);
        if (index < 0 && event.type === 'tool_output') {
          index = findLastSnapshotToolIndex((tool) => (
            resolveToolName(tool.name) === name
            && (tool.status === 'running' || (!preservedToolIds.has(tool.id) && tool.order === undefined))
          ));
        }
        if (index < 0 && event.type === 'tool_started') {
          index = findLastSnapshotToolIndex((tool) => (
            resolveToolName(tool.name) === name
            && !preservedToolIds.has(tool.id)
            && !replayedToolIds.has(tool.id)
          ));
        }
        const existing = index >= 0 ? effectiveToolCalls[index] : null;
        const startedAt = existing?.startedAt
          ?? (Number.isFinite(eventTs) ? eventTs : Date.now());
        const isOutput = event.type === 'tool_output';
        const status: ToolCall['status'] = event?.tool?.status === 'error'
          ? 'error'
          : isOutput && event?.tool?.status !== 'running'
            ? 'done'
            : 'running';
        const needsTimelineOrder = !existing
          || (!preservedToolIds.has(existing.id) && !replayedToolIds.has(existing.id));
        const nextTool: ToolCall = {
          ...(existing || {} as ToolCall),
          id: existing?.id || id,
          name,
          arguments: existing?.arguments ?? event?.tool?.arguments,
          startedAt,
          ...(isOutput ? { endedAt: Number.isFinite(eventTs) ? eventTs : Date.now() } : {}),
          ...(typeof event?.tool?.result === 'string' ? { result: event.tool.result } : {}),
          status: existing?.status === 'error' || existing?.status === 'done'
            ? existing.status
            : status,
          order: needsTimelineOrder ? streamActivityOrderRef.current++ : existing?.order,
        };
        if (index >= 0) {
          effectiveToolCalls = effectiveToolCalls.map((tool, toolIndex) => toolIndex === index ? nextTool : tool);
        } else {
          effectiveToolCalls = [...effectiveToolCalls, nextTool];
        }
        replayedToolIds.add(nextTool.id);
      };

      for (const event of sortedSnapshotEvents) {
        const eventSeq = Number(event?.seq);
        if (!Number.isFinite(eventSeq) || eventSeq <= replayAfterSequence) continue;
        if (replayReasoningSequences.has(eventSeq)) {
          if (assembledRef.current.trim()) {
            graduateLiveTextSegment(streamingAssistantIdRef.current);
          }
          applyThinkingSubject(null, event.subject);
          const eventType = event.type === 'assistant_status' ? 'status' : 'thinking';
          appendThinkingChunk(
            null,
            extractThinkingChunk(eventType, event.text, false),
            {
              replace: event.replace === true,
              lane: event?.source?.preambleProgress === true
                ? 'preamble'
                : event.type === 'assistant_status'
                  ? 'status'
                  : 'raw',
            },
          );
          recordReasoningTurnSequence({ turnEvent: event, runId: snapshotRunId });
          continue;
        }
        if (event.type === 'assistant_delta' || event.type === 'source_reply') {
          graduateLiveThinkingSegment();
          const replayText = typeof event.text === 'string'
            ? (event.replace === true ? sanitizeAssistantContent(event.text) : sanitizeAssistantChunk(event.text))
            : '';
          if (replayText && !isControlOrMaintenanceAssistantContent(replayText)) {
            mergeStreamText(replayText, { replace: event.replace === true });
          }
          continue;
        }
        if (event.type === 'tool_started' || event.type === 'tool_output') {
          const rawToolName = typeof event?.tool?.name === 'string' ? event.tool.name.trim() : '';
          const visibleToolName = rawToolName ? resolveToolName(rawToolName) : '';
          if (visibleToolName && isMessageToolName(visibleToolName)) continue;
          graduateLiveThinkingSegment();
          if (visibleToolName && assembledRef.current.trim()) {
            graduateLiveTextSegment(streamingAssistantIdRef.current);
          }
          if (visibleToolName) upsertSnapshotToolEvent(event);
        }
      }
      const newestSnapshotSequence = sortedSnapshotEvents.reduce((latest, event) => {
        const seq = Number(event?.seq);
        return Number.isFinite(seq) ? Math.max(latest, seq) : latest;
      }, -1);
      if (snapshotRunId && newestSnapshotSequence >= 0) {
        recordRuntimeReplaySequence({
          runId: snapshotRunId,
          turnEvent: { runId: snapshotRunId, seq: newestSnapshotSequence },
        });
      }
    }
    runningToolCall = effectiveToolCalls.find((toolCall) => toolCall.status === 'running');
    toolNameCandidate = snapshot.toolName || snapshot.name || runningToolCall?.name || activeToolNameRef.current;
    snapshotToolName = typeof toolNameCandidate === 'string' && toolNameCandidate.trim()
      ? resolveToolName(toolNameCandidate)
      : null;
    // The active snapshot content can be cumulative across text already
    // graduated around replayed tools. Keep only the unrepresented tail.
    const snapshotTextTail = reconcileCumulativeFinalTail(
      streamSegmentsRef.current
        .filter((segment) => segment.kind === 'text')
        .map((segment) => segment.text),
      snapshotContent,
    );
    const currentStreamText = assembledRef.current;
    const normalizedSnapshotContent = normalizeHistoryReplayContent(snapshotTextTail);
    const snapshotDuplicatesGraduatedText = Boolean(normalizedSnapshotContent)
      && !currentStreamText.trim()
      && streamSegmentsRef.current.some((segment) => (
        segment.kind === 'text'
        && normalizeHistoryReplayContent(segment.text) === normalizedSnapshotContent
      ));
    const effectiveSnapshotContent = snapshotDuplicatesGraduatedText ? '' : snapshotTextTail;
    const shouldReplaceSnapshotText = Boolean(effectiveSnapshotContent)
      && (!currentStreamText || effectiveSnapshotContent.length >= currentStreamText.length || effectiveSnapshotContent.includes(currentStreamText));
    shouldMaterializeBubble = shouldMaterializeBubble
      || effectiveToolCalls.length > 0
      || Boolean(thinkingContentRef.current.trim())
      || Boolean(thinkingSubjectRef.current)
      || streamSegmentsRef.current.some((segment) => (
        segment.kind === 'thinking'
        && (Boolean(segment.text.trim()) || Boolean(segment.subject))
      ));
    const snapshotPhase = runningToolCall
      ? 'tool'
      : snapshot.phase === 'tool'
        ? 'tool'
        : snapshot.phase === 'streaming'
          ? 'streaming'
          : 'thinking';
    const liveStatusText = isMaintenanceStatusOnly ? '' : (rawStatusText || '');
    const compactionStatusText = hasLiveSnapshotSignal && snapshot.compactionPhase === 'compacting'
      ? (liveStatusText || 'Compacting context…')
      : hasLiveSnapshotSignal && snapshot.compactionPhase === 'compacted'
        ? (liveStatusText || 'Context compacted')
        : '';
    const fallbackStatusText = snapshotToolName
      ? getToolStatusText(snapshotToolName, liveStatusText || compactionStatusText || null)
      : liveStatusText || options?.statusTextWhenNoTool || (snapshotPhase === 'streaming' ? 'Still responding…' : 'Still working…');
    setIsRunning(true);
    setSessionAvailability('present');
    setStreamingPhase(snapshotPhase);
    setActiveToolName(snapshotToolName || null);
    setStatusText(fallbackStatusText);
    applyCompactionSnapshotState(snapshot.compactionPhase);
    if (snapshot.provenance) setLastProvenance(String(snapshot.provenance));
    if (shouldReplaceSnapshotText) {
      mergeStreamText(effectiveSnapshotContent, { replace: true });
    }
    if (effectiveToolCalls.length > 0) {
      hasRealToolEventsRef.current = true;
      toolCounterRef.current = Math.max(toolCounterRef.current, effectiveToolCalls.length);
      activeStreamToolCallsRef.current = effectiveToolCalls;
      const highestSnapshotOrder = effectiveToolCalls.reduce(
        (highest, tool) => (
          typeof tool.order === 'number' && Number.isFinite(tool.order)
            ? Math.max(highest, tool.order)
            : highest
        ),
        -1,
      );
      streamActivityOrderRef.current = Math.max(
        streamActivityOrderRef.current,
        highestSnapshotOrder + 1,
      );
    }
    if (shouldMaterializeBubble) {
      assistantId = ensureStreamingAssistantBubble({
        idPrefix: 'stream-resume',
        content: shouldReplaceSnapshotText ? effectiveSnapshotContent : (snapshotDuplicatesGraduatedText ? '' : (currentStreamText || '')),
      }).assistantId;
    }
    if (assistantId) {
      setMessages(prev => prev.map(m => {
        if (m.id !== assistantId) return m;
        return {
          ...m,
          content: shouldReplaceSnapshotText ? effectiveSnapshotContent : (snapshotDuplicatesGraduatedText ? '' : m.content),
          toolCalls: effectiveToolCalls.length > 0 ? effectiveToolCalls : (m.toolCalls || []),
          model: snapshot.model ? normalizeProviderModel(providerRef.current, String(snapshot.model)) : m.model,
        };
      }));
    }
    resetStreamWatchdog({ visible: Boolean(effectiveSnapshotContent) });
    return true;
  }, [appendThinkingChunk, applyCompactionSnapshotState, applyThinkingSubject, ensureStreamingAssistantBubble, graduateLiveTextSegment, graduateLiveThinkingSegment, mergeStreamText, reconcileIncomingRunEpoch, recordReasoningTurnSequence, recordRuntimeReplaySequence, resetStreamWatchdog]);
  applyOpenClawActiveStreamSnapshotRef.current = applyOpenClawActiveStreamSnapshot;

  const hydrateActiveStream = useCallback(async (
    sessionKey: string,
    prov?: string,
    snapshot?: any,
    options?: {
      clearIfInactive?: boolean;
      reconnect?: boolean;
      refreshIfActive?: boolean;
      historyFence?: { localTurnEpoch: number; runId: string | null; wasActive: boolean };
    },
  ) => {
    const streamProvider = String(prov || providerRef.current || 'OPENCLAW').trim().toUpperCase();
    if (!sessionKey || !providerUsesPortalStreamBus(streamProvider)) return false;
    const expectedSession = sessionKey;
    const expectedProvider = streamProvider;
    const expectedHistoryGen = historyGenRef.current;
    try {
      let data = snapshot;
      if (!data) {
        const params: Record<string, string> = { session: sessionKey };
        params.provider = streamProvider;
        const response = await client.get('/gateway/stream-status', { params, _silent: true } as any);
        data = response.data;
      }
      if (
        sessionRef.current !== expectedSession
        || providerRef.current !== expectedProvider
      ) {
        debugLog('[ChatState] Ignoring stale active-stream snapshot', {
          expectedSession,
          currentSession: sessionRef.current,
          expectedProvider,
          currentProvider: providerRef.current,
        });
        return false;
      }
      if (historyGenRef.current !== expectedHistoryGen && !data?.active) {
        debugLog('[ChatState] Ignoring stale inactive active-stream snapshot', {
          expectedHistoryGen,
          currentHistoryGen: historyGenRef.current,
        });
        return false;
      }
      if (options?.historyFence) {
        const fence = options.historyFence;
        const currentRunId = normalizeRunId(currentRunIdRef.current);
        const snapshotRunId = normalizeRunId(data?.runId);
        if (!historyStreamSnapshotIsAuthoritative(data, fence, {
          localTurnEpoch: localTurnEpochRef.current,
          runId: currentRunId,
          active: isStreamActiveRef.current,
        })) {
          debugLog('[ChatState] Ignoring history snapshot captured before a newer turn', {
            expectedTurnEpoch: fence.localTurnEpoch,
            currentTurnEpoch: localTurnEpochRef.current,
            expectedRunId: fence.runId,
            currentRunId,
            snapshotRunId,
            snapshotActive: data?.active === true,
          });
          return false;
        }
      }
      const manager = wsManagerRef.current;
      if (!data?.active) {
        if (options?.clearIfInactive && isStreamActiveRef.current) {
          const canSafelyClear = data?.safeToClear === true || data?.inactiveReason === 'terminal' || data?.inactiveReason === 'stale';
          const hasLocalLiveEvidence = Boolean(
            currentRunIdRef.current
            || streamingAssistantIdRef.current
            || activeToolNameRef.current
            || hasRealToolEventsRef.current
            || assembledRef.current.trim()
            || thinkingContentRef.current.trim()
            || thinkingSubjectRef.current
            || streamSegmentsRef.current.length > 0
          );
          if (!canSafelyClear && hasLocalLiveEvidence) {
            debugLog('[ChatState] Inactive stream snapshot is ambiguous — preserving local active stream state', {
              inactiveReason: data?.inactiveReason || 'unknown',
            });
            setIsRunning(true);
            setStreamingPhase(prev => prev === 'idle' ? (activeToolNameRef.current ? 'tool' : 'thinking') : prev);
            markStreamRecovery(activeToolNameRef.current ? getToolStatusText(activeToolNameRef.current) : 'Checking stream status…');
            resetStreamWatchdog();
            return true;
          }
          debugLog('[ChatState] Active-stream snapshot is idle — clearing stale stream UI');
          preserveLiveTurnThenClear({ terminal: data?.inactiveReason === 'terminal' });
        }
        return false;
      }
      const priorAcceptedRunId = normalizeRunId(currentRunIdRef.current);
      if (data.runId && !currentRunIdRef.current) {
        currentRunIdRef.current = String(data.runId);
      }
      if (streamProvider === 'OPENCLAW') {
        directClientRef.current?.setActiveStreamSession(sessionKey);
      }
      const shouldRefreshLiveState = options?.refreshIfActive || !isStreamActiveRef.current || !streamingAssistantIdRef.current;
      if (!shouldRefreshLiveState) {
        resetStreamWatchdog();
        return true;
      }
      debugLog('[ChatState] Active stream found during history load — hydrating');
      if (streamProvider === 'OPENCLAW') setDirectGatewayDemanded(true);
      const snapshotApplied = applyOpenClawActiveStreamSnapshot(data, {
        statusTextWhenNoTool: 'Reconnecting to stream…',
        source: streamProvider === 'OPENCLAW' && useDirectGateway ? 'direct' : 'portal',
      });
      const acceptedSnapshotRunId = normalizeRunId(data?.runId);
      if (snapshotApplied && acceptedSnapshotRunId && Array.isArray(data?.turnEvents)) {
        const acceptedSnapshotSequence = latestTurnSequence(data.turnEvents.filter((event: any) => (
          !normalizeRunId(event?.runId) || normalizeRunId(event?.runId) === acceptedSnapshotRunId
        )));
        if (acceptedSnapshotSequence !== null) {
          const acceptedSnapshotSession = resolveOpenClawSessionKey(sessionRef.current)
            || sessionRef.current
            || 'main';
          const acceptedSnapshotScope = `${providerRef.current}:${acceptedSnapshotSession}`;
          const currentAcceptedSequence = priorAcceptedRunId === acceptedSnapshotRunId
            && portalTurnSequenceScopeRef.current === acceptedSnapshotScope
            ? portalTurnSequenceRef.current
            : null;
          portalTurnSequenceScopeRef.current = acceptedSnapshotScope;
          portalTurnSequenceRef.current = currentAcceptedSequence === null
            ? acceptedSnapshotSequence
            : Math.max(currentAcceptedSequence, acceptedSnapshotSequence);
        }
      }
      if (options?.reconnect !== false && manager?.isConnected()) {
        manager.send({ type: 'reconnect', session: sessionKey, provider: streamProvider, streamClientId: streamClientIdRef.current });
      }
      return true;
    } catch {
      return false;
    }
  }, [applyOpenClawActiveStreamSnapshot, preserveLiveTurnThenClear, markStreamRecovery, resetStreamWatchdog, resolveOpenClawSessionKey, useDirectGateway]);

  // History loader
  const loadHistoryInternal = useCallback(async (sessionKey: string, prov?: string, options?: { force?: boolean; refreshActiveSnapshot?: boolean; preserveLocalMessages?: boolean }): Promise<boolean> => {
    if (!sessionKey || (isStreamActiveRef.current && !options?.force)) return false;
    // Snapshot the current generation — if it changes while we await, discard results.
    const myGen = ++historyGenRef.current;
    const historyFence = {
      localTurnEpoch: localTurnEpochRef.current,
      runId: normalizeRunId(currentRunIdRef.current),
      wasActive: isStreamActiveRef.current,
    };
    const effectiveProvider = prov || providerRef.current || 'OPENCLAW';
    const historyScope = `${effectiveProvider}:${sessionKey}`;
    if (historyLoadedScopeRef.current !== historyScope) {
      historyBeforeCursorRef.current = null;
      historyHasMoreBeforeRef.current = false;
      historyOlderPagesLoadedRef.current = false;
      setHasOlderHistory(false);
      setOlderHistoryError(null);
      setHistoryError(null);
    }
    olderHistoryLoadInFlightRef.current = false;
    setIsLoadingOlderHistory(false);
    setIsLoadingHistory(true);
    setHistoryError(null);

    let historyActiveStream: any = undefined;
    let historyPagination: { beforeCursor: string | null; hasMoreBefore: boolean } = {
      beforeCursor: null,
      hasMoreBefore: false,
    };
    const loadViaHttp = async (): Promise<ChatMessage[]> => {
      const params: Record<string, string> = {
        session: sessionKey,
        provider: effectiveProvider,
        enhanced: '1',
        limit: String(INITIAL_CHAT_HISTORY_PAGE_SIZE),
      };
      const { data } = await client.get('/gateway/history', { params });
      historyActiveStream = data?.activeStream;
      historyPagination = {
        beforeCursor: typeof data?.pagination?.beforeCursor === 'string'
          ? data.pagination.beforeCursor
          : null,
        hasMoreBefore: data?.pagination?.hasMoreBefore === true,
      };
      return data.messages ? parseHistoryMessages(data.messages) : [];
    };

    // Load via direct gateway client for OPENCLAW
    const loadViaDirect = async (): Promise<ChatMessage[]> => {
      const directClient = directClientRef.current;
      if (!directClient?.isConnected) {
        throw new Error('Direct gateway not connected');
      }
      const resolvedSessionKey = resolveOpenClawSessionKey(sessionKey);
      if (resolvedSessionKey && resolvedSessionKey !== sessionRef.current) {
        sessionRef.current = resolvedSessionKey;
        setSessionRaw(resolvedSessionKey);
        persistStoredSession(prov || providerRef.current, resolvedSessionKey, agentIdRef.current);
      }
      const targetSessionKey = resolvedSessionKey || sessionKey;
      const [result, streamStatusResult] = await Promise.all([
        directClient.loadHistory(targetSessionKey),
        client.get('/gateway/stream-status', {
          params: { session: targetSessionKey, provider: prov },
          _silent: true,
        } as any).catch(() => null),
      ]);
      historyActiveStream = streamStatusResult?.data?.active ? streamStatusResult.data : { active: false };
      return result.messages.map(mapGatewayMessage).filter(Boolean) as ChatMessage[];
    };

    try {
      let loaded: ChatMessage[];

      // Keep direct WebSocket for live OpenClaw sends/events, but load transcript
      // history through the portal's enhanced HTTP path. Gateway-native history can
      // timestamp tool artifacts before the matching user prompt in newer OpenClaw
      // builds, which makes reload/post-turn chronology look wrong in the UI.
      const directClient = directClientRef.current;
      const useDirectHistory = false;
      debugLog('loadHistoryInternal', {
        useDirectGateway,
        provider: prov,
        directConnected: Boolean(directClient?.isConnected),
        sessionKey,
        force: Boolean(options?.force),
      });
      if (useDirectHistory) {
        try {
          debugLog('loading history via direct gateway');
          loaded = await loadViaDirect();
          if (loaded.length === 0 && !(historyActiveStream?.active)) {
            debugLog('direct gateway history was empty; falling back to HTTP history');
            loaded = await loadViaHttp();
          }
        } catch (err) {
          console.warn('[ChatState] Direct gateway history failed; falling back to HTTP', err);
          loaded = await loadViaHttp();
        }
      } else {
        // Every provider uses the same actor/session-bound paging contract.
        // Live events remain on WebSocket; durable history comes from HTTP.
        loaded = await loadViaHttp();
      }

      // Only apply if still the current generation
      if (historyGenRef.current === myGen) {
        if (loaded.length > 0) {
          setSessionAvailability('present');
        }
        const normalizedLoadedHistory = normalizeLoadedHistoryMessages(loaded);
        const preserveOlderPages = options?.preserveLocalMessages !== false
          && historyLoadedScopeRef.current === historyScope
          && historyOlderPagesLoadedRef.current;
        const oldestLatestTs = normalizedLoadedHistory[0]?.createdAt?.getTime?.() ?? Number.POSITIVE_INFINITY;
        const latestDurableIds = new Set(normalizedLoadedHistory.map((message) => message.id));
        const firstLatestOverlapIndex = messagesRef.current.findIndex((message) => latestDurableIds.has(message.id));
        const priorOlderCandidates = firstLatestOverlapIndex >= 0
          ? messagesRef.current.slice(0, firstLatestOverlapIndex)
          : messagesRef.current.filter((message) => {
              const ts = message.createdAt instanceof Date ? message.createdAt.getTime() : Number.POSITIVE_INFINITY;
              return ts < oldestLatestTs;
            });
        const previouslyLoadedOlder = preserveOlderPages
          ? priorOlderCandidates.filter((message) => {
              if (message.pendingAck || message.queued) return false;
              return !latestDurableIds.has(message.id);
            })
          : [];
        const normalizedHistoryWindow = preserveOlderPages
          ? normalizeLoadedHistoryMessages([...previouslyLoadedOlder, ...normalizedLoadedHistory])
          : normalizedLoadedHistory;
        const reconciledHistory = options?.preserveLocalMessages === false
          ? normalizedHistoryWindow
          : orderMessageToolVisibleMirrorsBeforeFinal(
              weaveMessageToolDeliveryMirrors(stripMessageDeliveryToolArtifacts(mergeLoadedHistoryWithLocalMessages(
                normalizedHistoryWindow,
                messagesRef.current,
                {
                  activeAssistantId: streamingAssistantIdRef.current,
                  activeRunId: isStreamActiveRef.current ? normalizeRunId(currentRunIdRef.current) : null,
                  preserveActiveAssistant: isStreamActiveRef.current,
                },
              ))),
            );
        const historySnapshotAuthoritative = historyStreamSnapshotIsAuthoritative(
          historyActiveStream,
          historyFence,
          {
            localTurnEpoch: localTurnEpochRef.current,
            runId: normalizeRunId(currentRunIdRef.current),
            active: isStreamActiveRef.current,
          },
        );
        const currentAuthoritativeLiveRunId = isStreamActiveRef.current
          ? normalizeRunId(currentRunIdRef.current)
          : null;
        let historyToInstall = historySnapshotAuthoritative
          ? reconciledHistory
          : reconciledHistory.filter((message) => (
              !message.runtimeRunId
              || message.runtimeRunId === currentAuthoritativeLiveRunId
            ));
        const exactActiveRunId = historyActiveStream?.active === true
          && historySnapshotAuthoritative
          ? normalizeRunId(historyActiveStream?.runId)
          : null;
        const reconciledActiveRuntimeOverlays = exactActiveRunId
          ? reconciledHistory.filter((message) => (
              message.role === 'assistant' && message.runtimeRunId === exactActiveRunId
            ))
          : [];
        const loadedActiveRuntimeOverlays = exactActiveRunId
          ? normalizedHistoryWindow.filter((message) => (
              message.role === 'assistant' && message.runtimeRunId === exactActiveRunId
            ))
          : [];
        const activeRuntimeOverlays = loadedActiveRuntimeOverlays.length > 0
          ? loadedActiveRuntimeOverlays
          : reconciledActiveRuntimeOverlays;
        if (activeRuntimeOverlays.length > 0 && exactActiveRunId) {
          const overlay = activeRuntimeOverlays[activeRuntimeOverlays.length - 1];
          const priorLiveAssistantId = streamingAssistantIdRef.current;
          const epochDecision = reconcileIncomingRunEpoch(exactActiveRunId, {
            continuationVerified: true,
          });
          if (epochDecision === 'reject') {
            historyToInstall = reconciledHistory.filter((message) => (
              message.role !== 'assistant' || message.runtimeRunId !== exactActiveRunId
            ));
          } else {
            const overlayLastEventSeq = activeRuntimeOverlays.reduce((latest, message) => (
              Number.isSafeInteger(message.runtimeLastEventSeq)
                ? Math.max(latest, message.runtimeLastEventSeq as number)
                : latest
            ), -1);
            if (overlayLastEventSeq >= 0) {
              const currentReplayCursor = reasoningSequenceRef.current;
              reasoningSequenceRef.current = {
                runId: exactActiveRunId,
                seq: currentReplayCursor.runId === exactActiveRunId && currentReplayCursor.seq !== null
                  ? Math.max(currentReplayCursor.seq, overlayLastEventSeq)
                  : overlayLastEventSeq,
              };
              const currentRuntimeReplayCursor = runtimeReplaySequenceRef.current;
              runtimeReplaySequenceRef.current = {
                runId: exactActiveRunId,
                seq: currentRuntimeReplayCursor.runId === exactActiveRunId
                  && currentRuntimeReplayCursor.seq !== null
                  ? Math.max(currentRuntimeReplayCursor.seq, overlayLastEventSeq)
                  : overlayLastEventSeq,
              };
            }
            if (epochDecision === 'adopt') {
              resetGraduatedThinkingSnapshotTracker(thinkingSnapshotTrackerRef.current);
            }
            for (const lane of ['raw', 'preamble', 'status'] as const) {
              const cursor = [...activeRuntimeOverlays]
                .reverse()
                .map((message) => message.runtimeThinkingCursors?.[lane])
                .find((value): value is string => typeof value === 'string' && Boolean(value));
              if (cursor) {
                seedGraduatedThinkingSnapshot(thinkingSnapshotTrackerRef.current, lane, cursor);
              }
            }
            const rawOverlaySegments = activeRuntimeOverlays.flatMap((message) => message.segments || []);
            const rawOverlayToolCalls = activeRuntimeOverlays.reduce<ToolCall[]>((calls, message) => (
              mergeToolCallSnapshots(calls, message.toolCalls || []) || calls
            ), []);
            const preservedOrders = [
              ...streamSegmentsRef.current.map((segment) => segment.order),
              ...activeStreamToolCallsRef.current
                .map((tool) => tool.order)
                .filter((order): order is number => typeof order === 'number' && Number.isFinite(order)),
            ];
            const incomingOrders = [
              ...rawOverlaySegments
                .map((segment) => segment.order)
                .filter((order): order is number => typeof order === 'number' && Number.isFinite(order)),
              ...rawOverlayToolCalls
                .map((tool) => tool.order)
                .filter((order): order is number => typeof order === 'number' && Number.isFinite(order)),
            ];
            const maxPreservedOrder = preservedOrders.length > 0 ? Math.max(...preservedOrders) : -1;
            const minIncomingOrder = incomingOrders.length > 0 ? Math.min(...incomingOrders) : 0;
            const priorOverlayOffset = runtimeOverlayOrderOffsetRef.current?.runId === exactActiveRunId
              ? runtimeOverlayOrderOffsetRef.current.offset
              : null;
            const replacementOrderOffset = epochDecision === 'adopt'
              ? Math.max(0, maxPreservedOrder + 1 - minIncomingOrder)
              : (priorOverlayOffset ?? 0);
            runtimeOverlayOrderOffsetRef.current = {
              runId: exactActiveRunId,
              offset: replacementOrderOffset,
            };
            const overlaySegments: StreamSegment[] = rawOverlaySegments.map((segment) => ({
              text: segment.text,
              ...(segment.subject ? { subject: segment.subject } : {}),
              ts: typeof segment.ts === 'number' ? segment.ts : overlay.createdAt.getTime(),
              kind: segment.kind === 'thinking' ? 'thinking' : 'text',
              order: typeof segment.order === 'number'
                ? segment.order + replacementOrderOffset
                : streamActivityOrderRef.current++,
              ...(segment.kind === 'thinking' && segment.source === 'preamble'
                ? { lane: 'preamble' as const }
                : segment.kind === 'thinking' && segment.source === 'status'
                  ? { lane: 'status' as const }
                : segment.kind === 'thinking'
                    && segment.source === 'reasoning'
                  ? { lane: 'raw' as const }
                  : {}),
            }));
            const overlayToolCalls = rawOverlayToolCalls.map((tool) => ({
              ...tool,
              ...(typeof tool.order === 'number'
                ? { order: tool.order + replacementOrderOffset }
                : {}),
            }));
            const mergedSegments = [...streamSegmentsRef.current];
            const segmentReplayIdentity = (segment: StreamSegment) => (
              `${segment.order}|${segment.kind}|${segment.lane || ''}|${segment.subject || ''}|${normalizeHistoryReplayContent(segment.text)}`
            );
            const representedSegments = new Set(mergedSegments.map((segment) => (
              segmentReplayIdentity(segment)
            )));
            let lastOverlayThinkingIndex = -1;
            for (let index = overlaySegments.length - 1; index >= 0; index -= 1) {
              if (overlaySegments[index].kind === 'thinking') {
                lastOverlayThinkingIndex = index;
                break;
              }
            }
            const currentThinking = normalizeHistoryReplayContent(thinkingContentRef.current);
            const currentThinkingSubject = sanitizeThinkingSubject(thinkingSubjectRef.current);
            for (const [index, segment] of overlaySegments.entries()) {
              const segmentText = normalizeHistoryReplayContent(segment.text);
              const sameLiveThinkingLane = index === lastOverlayThinkingIndex
                && segment.kind === 'thinking'
                && Boolean(segment.lane)
                && segment.lane === reasoningLaneRef.current
                && sanitizeThinkingSubject(segment.subject) === currentThinkingSubject;
              if (sameLiveThinkingLane && currentThinking && segmentText) {
                if (currentThinking === segmentText || currentThinking.startsWith(segmentText)) {
                  continue;
                }
                if (epochDecision !== 'adopt' && segmentText.startsWith(currentThinking)) {
                  thinkingContentRef.current = segment.text;
                  setThinkingContent(segment.text);
                  continue;
                }
              }
              const key = segmentReplayIdentity(segment);
              if (representedSegments.has(key)) continue;
              representedSegments.add(key);
              mergedSegments.push(segment);
            }
            const targetAssistantId = priorLiveAssistantId || overlay.id;
            streamingAssistantIdRef.current = targetAssistantId;
            const latestOverlayContent = [...activeRuntimeOverlays]
              .reverse()
              .map((message) => message.content)
              .find((content) => Boolean(content?.trim())) || '';
            if (epochDecision === 'adopt' || !assembledRef.current.trim()) {
              assembledRef.current = latestOverlayContent;
            }
            streamSegmentsRef.current = mergedSegments;
            activeStreamToolCallsRef.current = mergeToolCallSnapshots(
              activeStreamToolCallsRef.current,
              overlayToolCalls,
            ) || [];
            hasRealToolEventsRef.current = activeStreamToolCallsRef.current.length > 0;
            const mergedOrders = [
              ...mergedSegments.map((segment) => segment.order),
              ...activeStreamToolCallsRef.current
                .map((tool) => tool.order)
                .filter((order): order is number => typeof order === 'number' && Number.isFinite(order)),
            ];
            if (mergedOrders.length > 0) {
              streamActivityOrderRef.current = Math.max(
                streamActivityOrderRef.current,
                Math.max(...mergedOrders) + 1,
              );
            }
            setStreamSegments(mergedSegments);
            let targetFound = false;
            historyToInstall = reconciledHistory.flatMap((message) => {
              if (message.id === targetAssistantId && !targetFound) {
                targetFound = true;
                return [{
                  ...message,
                  runtimeRunId: exactActiveRunId,
                  content: assembledRef.current,
                  segments: undefined,
                  toolCalls: activeStreamToolCallsRef.current,
                }];
              }
              if (message.role === 'assistant' && message.runtimeRunId === exactActiveRunId) return [];
              if (message.id === targetAssistantId) return [];
              return [message];
            });
            if (!targetFound) {
              historyToInstall.push({
                ...overlay,
                id: targetAssistantId,
                content: assembledRef.current,
                segments: undefined,
                toolCalls: activeStreamToolCallsRef.current,
              });
            }
          }
        }
        messagesRef.current = historyToInstall;
        setMessages(historyToInstall);
        historyLoadedScopeRef.current = historyScope;
        if (!preserveOlderPages) {
          historyBeforeCursorRef.current = historyPagination.beforeCursor;
          historyHasMoreBeforeRef.current = historyPagination.hasMoreBefore;
          historyOlderPagesLoadedRef.current = false;
          setHasOlderHistory(historyPagination.hasMoreBefore);
        }
        setOlderHistoryError(null);
        setHistoryError(null);
        if (providerUsesPortalStreamBus(effectiveProvider)) {
          return await hydrateActiveStream(sessionKey, effectiveProvider, historyActiveStream, {
            clearIfInactive: Boolean(options?.force),
            reconnect: effectiveProvider !== 'OPENCLAW' || !useDirectGateway,
            refreshIfActive: Boolean(options?.refreshActiveSnapshot) || Boolean(options?.force),
            historyFence,
          });
        }
      }
    } catch (err) {
      console.error('[ChatState] History load failed:', err);
      if (historyGenRef.current === myGen) {
        setHistoryError(effectiveProvider === 'AGENT_ZERO'
          ? 'Agent Zero chat history could not be loaded. Retry now; if it fails again, repair the managed runtime in Agent Settings.'
          : 'Chat history could not be loaded. Retry to restore this transcript.');
      }
      return false;
    } finally {
      if (historyGenRef.current === myGen) {
        setIsLoadingHistory(false);
        setIsSwitchingSession(false);
        setStartupReady(true);
      }
    }
    return false;
  }, [hydrateActiveStream, reconcileIncomingRunEpoch, resolveOpenClawSessionKey, useDirectGateway]);

  useEffect(() => {
    loadHistoryInternalRef.current = loadHistoryInternal;
  }, [loadHistoryInternal]);

  const scheduleStreamContinuityRepair = useCallback((gap: { from: number; to: number }) => {
    if (streamContinuityRepairTimerRef.current || !providerUsesPortalStreamBus(providerRef.current)) return;
    const targetSession = sessionRef.current || 'main';
    const targetProvider = providerRef.current;
    debugLog('[ChatState] Runtime event gap detected; scheduling durable reconciliation', {
      session: targetSession,
      from: gap.from,
      to: gap.to,
    });
    streamContinuityRepairTimerRef.current = setTimeout(() => {
      streamContinuityRepairTimerRef.current = null;
      if (providerRef.current !== targetProvider || (sessionRef.current || 'main') !== targetSession) return;
      void loadHistoryInternalRef.current?.(targetSession, targetProvider, {
        force: true,
        refreshActiveSnapshot: true,
        preserveLocalMessages: true,
      });
    }, 350);
  }, []);

  const loadHistory = useCallback(async (sessionKey: string, prov?: string) => {
    await loadHistoryInternal(sessionKey, prov);
  }, [loadHistoryInternal]);

  const loadOlderHistory = useCallback(async (): Promise<number> => {
    const sessionKey = sessionRef.current;
    const providerName = providerRef.current || 'OPENCLAW';
    const beforeCursor = historyBeforeCursorRef.current;
    const historyScope = `${providerName}:${sessionKey}`;
    if (
      !sessionKey
      || !beforeCursor
      || !historyHasMoreBeforeRef.current
      || olderHistoryLoadInFlightRef.current
      || historyLoadedScopeRef.current !== historyScope
    ) {
      return 0;
    }

    const expectedGeneration = historyGenRef.current;
    const previousCount = messagesRef.current.length;
    olderHistoryLoadInFlightRef.current = true;
    setIsLoadingOlderHistory(true);
    setOlderHistoryError(null);

    try {
      const { data } = await client.get('/gateway/history', {
        params: {
          session: sessionKey,
          provider: providerName,
          enhanced: '1',
          limit: String(INITIAL_CHAT_HISTORY_PAGE_SIZE),
          before: beforeCursor,
        },
      });

      if (
        historyGenRef.current !== expectedGeneration
        || sessionRef.current !== sessionKey
        || providerRef.current !== providerName
        || historyLoadedScopeRef.current !== historyScope
      ) {
        return 0;
      }

      const olderPage = normalizeLoadedHistoryMessages(
        Array.isArray(data?.messages)
          ? parseHistoryMessages(data.messages)
          : [],
      );
      const merged = normalizeLoadedHistoryMessages([...olderPage, ...messagesRef.current]);
      messagesRef.current = merged;
      setMessages(merged);

      const nextCursor = typeof data?.pagination?.beforeCursor === 'string'
        ? data.pagination.beforeCursor
        : null;
      const hasMore = data?.pagination?.hasMoreBefore === true;
      historyBeforeCursorRef.current = nextCursor;
      historyHasMoreBeforeRef.current = hasMore;
      historyOlderPagesLoadedRef.current = true;
      setHasOlderHistory(hasMore);
      return Math.max(0, merged.length - previousCount);
    } catch (err: any) {
      if (
        historyGenRef.current === expectedGeneration
        && sessionRef.current === sessionKey
        && providerRef.current === providerName
      ) {
        const message = String(
          err?.response?.data?.error
          || err?.response?.data?.detail
          || err?.message
          || 'Earlier messages could not be loaded.',
        );
        setOlderHistoryError(message);
      }
      return 0;
    } finally {
      if (
        historyGenRef.current === expectedGeneration
        && sessionRef.current === sessionKey
        && providerRef.current === providerName
      ) {
        olderHistoryLoadInFlightRef.current = false;
        setIsLoadingOlderHistory(false);
      }
    }
  }, []);

  // Materialize a full transcript only for an explicit operation such as
  // /export. Pages are accumulated in this local snapshot and never copied
  // into React state, so exporting a multi-day session does not make the chat
  // UI render or retain the whole transcript.
  const getCompleteHistory = useCallback(async (): Promise<ChatMessage[]> => {
    const sessionKey = sessionRef.current;
    const providerName = providerRef.current || 'OPENCLAW';
    const historyScope = `${providerName}:${sessionKey}`;
    if (!sessionKey || historyLoadedScopeRef.current !== historyScope) {
      throw new Error('Chat history is still loading. Try the export again in a moment.');
    }

    const expectedGeneration = historyGenRef.current;
    let beforeCursor = historyBeforeCursorRef.current;
    let hasMore = historyHasMoreBeforeRef.current;
    let complete = normalizeLoadedHistoryMessages([...messagesRef.current]);
    const seenCursors = new Set<string>();

    const assertSameChat = () => {
      if (
        historyGenRef.current !== expectedGeneration
        || sessionRef.current !== sessionKey
        || providerRef.current !== providerName
        || historyLoadedScopeRef.current !== historyScope
      ) {
        throw new Error('The chat changed while it was being exported. Try again on the current chat.');
      }
    };

    while (hasMore) {
      assertSameChat();
      if (!beforeCursor || seenCursors.has(beforeCursor)) {
        throw new Error('The server returned an invalid earlier-history cursor.');
      }
      seenCursors.add(beforeCursor);

      const { data } = await client.get('/gateway/history', {
        params: {
          session: sessionKey,
          provider: providerName,
          enhanced: '1',
          limit: '100',
          before: beforeCursor,
        },
      });
      assertSameChat();

      const olderPage = normalizeLoadedHistoryMessages(
        Array.isArray(data?.messages)
          ? parseHistoryMessages(data.messages)
          : [],
      );
      complete = normalizeLoadedHistoryMessages([...olderPage, ...complete]);
      beforeCursor = typeof data?.pagination?.beforeCursor === 'string'
        ? data.pagination.beforeCursor
        : null;
      hasMore = data?.pagination?.hasMoreBefore === true;
      if (hasMore && olderPage.length === 0) {
        throw new Error('The server returned an empty earlier-history page.');
      }
    }

    return complete;
  }, []);

  // Explicitly select a session from the sidebar. Navigation must detach the
  // browser from an SSE fallback before changing sessionRef: otherwise the old
  // response can keep writing events into the newly selected chat. "handoff"
  // stops only the browser transport; the server-owned run continues and is
  // recoverable from the Portal stream bus/history. It must never share the
  // explicit Stop button's chat.abort path.
  const selectSession = useCallback(async (sessionKey: string) => {
    if (!sessionKey) return;
    const activeSse = activeSseTransportRef.current;
    if (activeSse) {
      const manager = wsManagerRef.current;
      const handedOff = activeSse.sessionResolved && manager?.isConnected()
        ? await handoffActiveSseToPortalRef.current(manager)
        : false;
      if (!handedOff) {
        await stopActiveSseTransportRef.current('handoff');
      }
    }
    historyGenRef.current++;
    historyBeforeCursorRef.current = null;
    historyHasMoreBeforeRef.current = false;
    historyLoadedScopeRef.current = null;
    historyOlderPagesLoadedRef.current = false;
    olderHistoryLoadInFlightRef.current = false;
    setHasOlderHistory(false);
    setIsLoadingOlderHistory(false);
    setOlderHistoryError(null);
    setIsSwitchingSession(true);
    setIsLoadingHistory(true);
    clearActiveStreamState();
    setLastProvenance(null);
    compactionPhaseRef.current = 'idle';
    // Clear the previous thread immediately. Otherwise a pending user message from
    // the old session can be merged onto the newly selected session while history loads.
    messagesRef.current = [];
    messageQueueRef.current = [];
    setMessages([]);
    setMessageQueue([]);
    sessionRef.current = sessionKey;
    setSessionRaw(sessionKey);
    persistStoredSession(providerRef.current, sessionKey, agentIdRef.current);
    directClientRef.current?.setCurrentSession(sessionKey);
    // Force-load history bypassing the isStreamActive guard, but do not preserve
    // transient local messages from the previously selected session.
    await loadHistoryInternal(sessionKey, providerRef.current, { force: true, preserveLocalMessages: false });
  }, [clearActiveStreamState, loadHistoryInternal]);

  // Refresh: reload history + check for active stream and resubscribe
  const refreshChat = useCallback(async () => {
    const currentSession = sessionRef.current;
    const currentProvider = providerRef.current;
    if (!currentSession) return;
    debugLog('[ChatState] Manual refresh — reloading history');
    const usingDirectGateway = useDirectGateway && currentProvider === 'OPENCLAW';
    const directClient = directClientRef.current;
    const directOwnsTurn = usingDirectGateway
      && streamTransportRef.current === 'direct'
      && Boolean(directClient);
    if (directOwnsTurn && isStreamActiveRef.current && !directClient?.isConnected) {
      directClient?.connect();
      markStreamRecovery('Reconnecting to stream…');
    } else if (providerUsesPortalStreamBus(currentProvider) && !wsManagerRef.current?.isConnected()) {
      // Manual refresh is explicit recovery intent, not only a history read.
      // Cancel any exponential-backoff wait and reopen the shared Portal bus now.
      wsManagerRef.current?.reconnect();
      if (isStreamActiveRef.current) markStreamRecovery('Reconnecting to stream…');
    }
    try {
      await loadHistoryInternal(currentSession, currentProvider, { force: true, refreshActiveSnapshot: true });
    } catch (err) {
      console.error('[ChatState] Refresh error:', err);
      try { await loadHistoryInternal(currentSession, currentProvider); } catch {}
    }
  }, [loadHistoryInternal, markStreamRecovery, useDirectGateway]);

  // Load history when session/provider changes.
  // We intentionally do NOT call clearMessages here — the caller (handleSelectSession,
  // handleSelectAgent, etc.) already clears before setting the new session, so the
  // messages array is already empty by the time this effect fires.
  useEffect(() => {
    if (session && !isStreamActiveRef.current) {
      setStartupReady(false);
      setIsLoadingHistory(true); // show spinner immediately, before async fetch
      void loadHistoryInternal(session, provider);
    }
  }, [session, provider, loadHistoryInternal]);

  const handleActiveTurnConflict = useCallback((data: any) => {
    const clientMessageId = typeof data?.clientMessageId === 'string'
      ? data.clientMessageId.trim()
      : '';
    const outstanding = outstandingChatDispatchRef.current;
    const eventSession = resolveOpenClawSessionKey(
      typeof data?.sessionKey === 'string' ? data.sessionKey : sessionRef.current,
    );
    const currentSession = resolveOpenClawSessionKey(sessionRef.current);
    if (
      !clientMessageId
      || !outstanding
      || outstanding.clientMessageId !== clientMessageId
      || outstanding.assistantId !== streamingAssistantIdRef.current
      || outstanding.sessionKey !== eventSession
      || (currentSession && eventSession !== currentSession)
    ) {
      debugLog('[ChatState] Ignoring uncorrelated active-turn conflict', {
        clientMessageId: clientMessageId || null,
        outstandingClientMessageId: outstanding?.clientMessageId || null,
        eventSession: eventSession || null,
        currentSession: currentSession || null,
      });
      return false;
    }

    const attempted = messagesRef.current.find((message) => (
      message.id === clientMessageId && message.role === 'user'
    ));
    if (!attempted) return false;

    // Consume the correlation before changing any UI. Replayed/duplicate
    // conflict frames must never tear down the authoritative stream we attach
    // immediately afterward.
    outstandingChatDispatchRef.current = null;
    if (!messageQueueRef.current.some((item) => item.id === attempted.id)) {
      const queuedItem = {
        id: attempted.id,
        text: attempted.content,
        createdAt: attempted.createdAt.getTime(),
      };
      messageQueueRef.current = [...messageQueueRef.current, queuedItem];
      setMessageQueue((previous) => (
        previous.some((item) => item.id === queuedItem.id) ? previous : [...previous, queuedItem]
      ));
    }

    const optimisticAssistantId = outstanding.assistantId;
    setMessages((previous) => {
      const next = previous
        .filter((message) => message.id !== optimisticAssistantId)
        .map((message) => message.id === clientMessageId
          ? { ...message, pendingAck: false, queued: true }
          : message);
      messagesRef.current = next;
      return next;
    });
    clearPendingTextRender();
    streamingAssistantIdRef.current = null;
    currentRunIdRef.current = null;
    // Keep the queue fenced while the backend resolves the authoritative
    // active run. Marking this idle would immediately drain and resend the
    // same message, creating the exact conflict loop this path repairs.
    isStreamActiveRef.current = true;
    streamTransportRef.current = streamTransportRef.current === 'sse' ? 'sse' : 'portal';
    assembledRef.current = '';
    resetLiveThinkingTimeline();
    setActiveToolName(null);
    setStreamingPhase('thinking');
    setIsRunning(true);
    markStreamRecovery('Reconnecting to the active turn…');
    return true;
  }, [clearPendingTextRender, markStreamRecovery, resetLiveThinkingTimeline, resolveOpenClawSessionKey]);

  // WS event handler — processes events even when chat page is unmounted
  const handleWsEvent = useCallback((data: any) => {
    // Session events with a new sessionId should update our ref IMMEDIATELY,
    // before the React state update queues. This prevents subsequent events
    // (that arrive before the useEffect fires) from being dropped.
    if (data?.type === 'session' && data.sessionId) {
      sessionRef.current = data.sessionId;
    }

    if (data?.type === 'abort_result') {
      const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : '';
      const pending = requestId ? pendingWsAbortResultsRef.current.get(requestId) : null;
      if (pending) {
        pending.resolve(data.ok === true);
      } else {
        debugLog('[ChatState] Ignoring uncorrelated abort_result', { requestId: requestId || null });
      }
      return;
    }

    const rawPortalEventType = typeof data?.type === 'string' ? data.type : '';
    data = normalizePortalStreamEventFromTurnEvent(data);
    if (data?.type === 'activity_title') {
      // Only the backend's database-attested, body-free envelope may update a
      // parallel Agent Chat title. Raw global thinking frames are never used.
      observeSessionActivityTitle(data);
      return;
    }

    const incomingPortalRunId = normalizeRunId(data?.runId);
    const portalStreamTypes = ['text', 'thinking', 'tool_start', 'tool_update', 'tool_end', 'tool_used', 'status', 'stream_status', 'segment_break', 'done', 'error', 'stream_resume', 'stream_ended', 'run_resumed'];
    if (portalStreamTypes.includes(data?.type) && data?.type !== 'stream_status') {
      clearStreamRecoveryTimer();
    }

    // Filter events by session key. Allow events that match our current session,
    // OR events that don't have a sessionKey (global events like connected/keepalive).
    // Also allow compaction events through regardless of session key — they're important
    // system notifications that should display even if the sessionKey hasn't resolved yet.
    const alwaysPassthroughTypes = ['connected', 'keepalive'];
    const resolvedPortalSession = typeof data?.sessionKey === 'string' ? resolveOpenClawSessionKey(data.sessionKey) : '';
    const resolvedCurrentSession = resolveOpenClawSessionKey(sessionRef.current);
    const resolvedTurnSession = resolvedPortalSession || resolvedCurrentSession || 'main';
    const resolvedTurnScope = `${providerRef.current}:${resolvedTurnSession}`;
    if (resolvedPortalSession && resolvedCurrentSession && resolvedPortalSession !== resolvedCurrentSession && !alwaysPassthroughTypes.includes(data.type)) {
      return;
    }

    const isVerifiedPortalRunResume = rawPortalEventType === 'run_resumed'
      || data?.turnEvent?.source?.eventType === 'run_resumed';
    if (incomingPortalRunId && portalStreamTypes.includes(data?.type)) {
      const epochDecision = reconcileIncomingRunEpoch(incomingPortalRunId, {
        // `run_resumed` is emitted only after the backend has verified the
        // continuation epoch. The browser must adopt it before filtering any
        // direct-gateway frames from that new run.
        continuationVerified: isVerifiedPortalRunResume,
      });
      if (epochDecision === 'reject') {
        debugLog('[ChatState] Ignoring portal event outside the active run epoch', {
          type: data?.type,
          expectedRunId: currentRunIdRef.current,
          incomingRunId: incomingPortalRunId,
        });
        return;
      }
      if (epochDecision === 'adopt') {
        debugLog('[ChatState] Adopted backend-authoritative continuation run', {
          runId: incomingPortalRunId,
        });
        directClientRef.current?.setActiveStreamSession(resolvedPortalSession || resolvedCurrentSession || null);
      }
      if (isVerifiedPortalRunResume) {
        portalTurnSequenceRef.current = null;
        portalTurnSequenceScopeRef.current = resolvedTurnScope;
      }
    }

    // A new Portal WebSocket connection is an explicit runtime-sequence epoch.
    // Verified run_resumed events above are the other reset authority; treating
    // any arbitrary seq=1 as a restart replayed stale turn windows into the UI.
    if (data?.type === 'connected') {
      portalTurnSequenceRef.current = null;
      portalTurnSequenceScopeRef.current = resolvedTurnScope;
    }

    // When the direct gateway transport owns the active turn, it is the only live
    // authority allowed to mutate assistant/status/tool UI. Portal `run_resumed`
    // was intentionally reconciled above because it is the authoritative epoch
    // handoff; mirrored rendering frames remain fallback data.
    if (directClientRef.current?.isConnected && streamTransportRef.current === 'direct') {
      const isPortalTerminalEvent = data?.type === 'done' || data?.type === 'stream_ended';
      if (isPortalTerminalEvent && !isStreamActiveRef.current && !streamingAssistantIdRef.current) {
        if (!incomingPortalRunId || lastTerminalRunIdRef.current === incomingPortalRunId) {
          return;
        }
      }
      const directHandledTypes = ['status', 'text', 'thinking', 'tool_start', 'tool_update', 'tool_end', 'tool_used', 'segment_break', 'done', 'error', 'stream_resume', 'stream_ended', 'run_resumed'];
      if (directHandledTypes.includes(data?.type)) {
        return;
      }
    }
    // Sequence continuity only applies after transport, run, and session
    // authority checks. Mirrored direct-gateway frames and stale-session events
    // must not trigger a reconciliation for the chat the user is viewing.
    const turnEvent = data?.turnEvent;
    if (turnEvent && typeof turnEvent === 'object') {
      const turnSession = resolvedTurnSession;
      if (portalTurnSequenceScopeRef.current !== resolvedTurnScope) {
        portalTurnSequenceScopeRef.current = resolvedTurnScope;
        portalTurnSequenceRef.current = null;
      }
      const observation = observeTurnSequence(portalTurnSequenceRef.current, turnEvent.seq);
      portalTurnSequenceRef.current = observation.nextSequence;
      if (observation.disposition === 'gap') {
        debugLog('[ChatState] Quarantining runtime turn event behind a sequence gap', {
          session: turnSession,
          sequence: turnEvent.seq,
          latestSequence: observation.nextSequence,
          type: turnEvent.type,
          gap: observation.gap,
        });
        if (observation.gap) scheduleStreamContinuityRepair(observation.gap);
        return;
      }
      if (observation.disposition === 'drop') {
        debugLog('[ChatState] Dropping stale runtime turn event', {
          session: turnSession,
          sequence: turnEvent.seq,
          latestSequence: observation.nextSequence,
          type: turnEvent.type,
        });
        return;
      }
      recordRuntimeReplaySequence(data);
      recordReasoningTurnSequence(data);
    } else if (data?.type === 'stream_resume' && Array.isArray(data.turnEvents)) {
      const resumeSequence = latestTurnSequence(data.turnEvents);
      if (resumeSequence !== null) portalTurnSequenceRef.current = resumeSequence;
    }
    if (data?.type && ['text', 'thinking', 'tool_start', 'tool_update', 'tool_end', 'tool_used', 'status', 'segment_break', 'done', 'stream_resume', 'stream_ended', 'run_resumed', 'compaction_start', 'compaction_end', 'user_message', 'history_changed'].includes(data.type)) {
      setWsConnected(true);
    }
    // Temp debug: log tool-related events to diagnose missing tool cards
    if (data.type && (data.type.startsWith('tool') || data.type === 'text' || data.type === 'done')) {
      debugLog('ws event', {
        type: data.type,
        assistantId: streamingAssistantIdRef.current || null,
        toolName: data.toolName || null,
        contentLength: typeof data.content === 'string' ? data.content.length : 0,
      });
    }
    // Only process stream events if we have an active assistant message.
    // Some event types are allowed without a bubble so we can wait for visible
    // content before materializing a resumed turn.
    const passthrough = ['session', 'exec_approval', 'exec_approval_resolved', 'connected', 'keepalive', 'compaction_start', 'compaction_end', 'stream_resume', 'stream_status', 'stream_ended', 'run_resumed', 'user_message', 'history_changed', 'active_turn_conflict'];
    const autoCreateBubbleTypes = ['text', 'thinking', 'status', 'tool_start', 'tool_update', 'tool_end', 'tool_used', 'toolCall', 'toolResult', 'segment_break'];
    const waitForVisibleStreamTypes = ['thinking', 'done', 'error'];
    if (!streamingAssistantIdRef.current && data.type === 'text' && typeof data.content === 'string' && isControlOrMaintenanceAssistantContent(data.content)) {
      return;
    }
    if (!streamingAssistantIdRef.current && !passthrough.includes(data.type)) {
      if (autoCreateBubbleTypes.includes(data.type)) {
        ensureStreamingAssistantBubble({ idPrefix: 'resume', content: '', resetIfCreated: true });
        isStreamActiveRef.current = true;
        if (!streamTransportRef.current) streamTransportRef.current = 'portal';
        directClientRef.current?.setActiveStreamSession(sessionRef.current || null);
        setIsRunning(true);
      } else if (!waitForVisibleStreamTypes.includes(data.type)) {
        console.warn(`[ChatState] DROPPED event: type=${data.type} (no assistantId)`);
        return;
      }
    }
    // Read assistantId AFTER potential bubble creation so it picks up the new ref
    const assistantId = streamingAssistantIdRef.current;
    if (assistantId || isStreamActiveRef.current) {
      resetStreamWatchdog();
    }
    if (data.type === 'done' || data.type === 'error' || data.type === 'stream_ended') {
      outstandingChatDispatchRef.current = null;
    }

    switch (data.type) {
      case 'active_turn_conflict': {
        handleActiveTurnConflict(data);
        break;
      }
      case 'user_message': {
        appendLiveUserMessage(data);
        scheduleSessionTelemetryRefresh(200);
        break;
      }
      case 'history_changed': {
        const targetSession = resolvedPortalSession || resolvedCurrentSession;
        if (targetSession) {
          void loadHistoryInternalRef.current?.(targetSession, providerRef.current, {
            force: true,
            refreshActiveSnapshot: true,
            preserveLocalMessages: true,
          });
        }
        break;
      }
      case 'session': {
        if (data.sessionId) {
          setSessionAvailability('present');
          setSessionRaw(data.sessionId);
          persistStoredSession(providerRef.current, data.sessionId, agentIdRef.current);
        }
        if (data.provenance) setLastProvenance(data.provenance);
        if (data.model) {
          const normalizedModel = normalizeProviderModel(providerRef.current, String(data.model));
          if (normalizedModel) {
            modelRef.current = normalizedModel;
            setSelectedModelRaw(prev => (prev === normalizedModel ? prev : normalizedModel));
          }
          setMessages(prev => prev.map(m => (
            m.id === streamingAssistantIdRef.current
              ? { ...m, model: normalizedModel || m.model }
              : m
          )));
        }
        break;
      }
      case 'status': {
        const maintenanceRail = resolveMaintenanceRailStatus(data);
        if (maintenanceRail.update) applyCompactionState(maintenanceRail.update);
        if (!assistantId && !isStreamActiveRef.current) break;
        // Show OpenClaw's live thinking status immediately. Some provider/runtime
        // combinations do not expose private reasoning deltas, so the status event
        // is the only honest in-turn signal before tools begin.
        const runningToolName = getRunningToolName();
        if (data.transient === true && !maintenanceRail.isMaintenanceStatus) {
          setLiveRunPhase('thinking', typeof data.content === 'string' ? data.content : null);
          resetStreamWatchdog({ visible: true });
          break;
        }
        if (!maintenanceRail.isMaintenanceStatus && !runningToolName && data.preambleProgress !== true) {
          const statusThinkingChunk = extractThinkingChunk(
            'status',
            data.content,
            data?.turnEvent?.visible === true ? false : assembledRef.current.length > 0,
          );
          if (statusThinkingChunk && assembledRef.current.trim()) {
            graduateLiveTextSegment(assistantId);
          }
          appendThinkingChunk(assistantId, statusThinkingChunk, {
            replace: data.replace === true,
            lane: 'status',
          });
          if (statusThinkingChunk) resetStreamWatchdog({ visible: true });
        }
        if (data.preambleProgress === true && !runningToolName) {
          // OpenClaw marks provider-authored preamble progress explicitly. For
          // Opus turns whose private reasoning body is encrypted/empty, this is
          // the only readable thinking signal. Keep its cumulative snapshot in
          // the violet timeline so the following tool transition graduates it
          // instead of replacing it as transient rail text.
          const preambleThinking = extractThinkingChunk(
            'thinking',
            data.content,
            assembledRef.current.length > 0,
          );
          if (preambleThinking && assembledRef.current.trim()) {
            graduateLiveTextSegment(assistantId);
          }
          appendThinkingChunk(assistantId, preambleThinking, {
            replace: data.replace === true,
            lane: 'preamble',
          });
          if (preambleThinking) resetStreamWatchdog({ visible: true });
          setStatusText(sanitizeThinkingSubject(data.content) || null);
          setStreamingPhase('thinking');
        }
        if (!assembledRef.current || runningToolName) {
          setLiveRunPhase('thinking', maintenanceRail.displayStatusText);
        }
        break;
      }
      case 'thinking': {
        if (!assistantId && !isStreamActiveRef.current) break;
        applyThinkingSubject(assistantId, data.subject);
        const thinkingChunk = extractThinkingChunk('thinking', data.content, assembledRef.current.length > 0);
        const isPreambleThinking = data.preambleProgress === true
          || data?.turnEvent?.source?.preambleProgress === true;
        if (thinkingChunk && assembledRef.current.trim()) {
          graduateLiveTextSegment(assistantId);
        }
        appendThinkingChunk(assistantId, thinkingChunk, {
          replace: data.replace === true,
          lane: isPreambleThinking ? 'preamble' : 'raw',
        });
        if (thinkingChunk) resetStreamWatchdog({ visible: true });
        if (!assembledRef.current || getRunningToolName()) {
          setLiveRunPhase('thinking', null);
        }
        break;
      }
      case 'compaction_start': {
        applyCompactionState({
          phase: 'start',
          content: typeof data.content === 'string' ? data.content : null,
          maintenanceKind: data.maintenanceKind === 'maintenance' ? 'maintenance' : 'compaction',
        });
        break;
      }
      case 'compaction_end': {
        applyCompactionState({
          phase: 'end',
          content: typeof data.content === 'string' ? data.content : null,
          completed: data.completed !== false,
          maintenanceKind: data.maintenanceKind === 'maintenance' ? 'maintenance' : 'compaction',
        });
        scheduleSessionTelemetryRefresh(250);
        break;
      }
      case 'tool_start': {
        const toolName = resolveToolName(data.toolName, data.name, data.content, 'tool');
        if (isMessageToolName(toolName)) break;
        hasRealToolEventsRef.current = true;
        graduateLiveThinkingSegment();
        // Graduate current streaming text into a finalized segment before tool call.
        // This preserves the agent's thoughts as visible bubbles instead of wiping them.
        if (assembledRef.current && assembledRef.current.trim().length > 0) {
          graduateLiveTextSegment(assistantId);
        }
        setStatusText(getCurrentToolStatusText(toolName));
        setStreamingPhase('tool');
        setActiveToolName(toolName);
        const toolId = typeof data.toolCallId === 'string' && data.toolCallId.trim()
          ? data.toolCallId.trim()
          : `tool-${String(data.runId || currentRunIdRef.current || 'run')}-${String(data.seq || ++toolCounterRef.current)}`;
        const toolArgs = data.toolArgs || undefined;
        const toolOrder = streamActivityOrderRef.current++;
        setMessages(prev => {
          const projection = appendToolCallToMessage(prev, assistantId, {
            ...buildRunningToolCall({
              id: toolId,
              name: toolName,
              arguments: toolArgs,
            }),
            order: toolOrder,
          });
          activeStreamToolCallsRef.current = projection.toolCalls as ToolCall[];
          return projection.messages as ChatMessage[];
        });
        break;
      }
      case 'tool_update': {
        const updatedToolName = resolveToolName(data.toolName, data.name, data.content, 'tool');
        if (isMessageToolName(updatedToolName)) break;
        const toolResult = data.toolResult || data.content || '';
        hasRealToolEventsRef.current = true;
        setStreamingPhase('tool');
        setActiveToolName(updatedToolName);
        setStatusText(getCurrentToolStatusText(updatedToolName));
        setMessages(prev => {
          const projection = updateRunningToolCallInMessage(prev, assistantId, {
            toolCallId: data.toolCallId,
            toolName: updatedToolName,
            result: typeof toolResult === 'string' ? toolResult : String(toolResult),
          });
          if (projection.changed) activeStreamToolCallsRef.current = projection.toolCalls as ToolCall[];
          return projection.messages as ChatMessage[];
        });
        break;
      }
      case 'tool_end': {
        const endedToolName = resolveToolName(data.toolName, data.name, data.content, 'tool');
        if (isMessageToolName(endedToolName)) break;
        const toolResult = data.toolResult || data.content || 'Completed';
        let nextRunningToolName: string | null = null;
        setMessages(prev => {
          const projection = finishMatchingToolCallInMessage(prev, assistantId, {
            toolCallId: data.toolCallId,
            toolName: endedToolName,
            result: String(toolResult),
            status: data.status,
          });
          nextRunningToolName = projection.nextRunningToolName ? resolveToolName(projection.nextRunningToolName) : null;
          activeStreamToolCallsRef.current = projection.toolCalls as ToolCall[];
          return projection.messages as ChatMessage[];
        });
        if (nextRunningToolName) {
          setStreamingPhase('tool');
          setActiveToolName(nextRunningToolName);
          setStatusText(getCurrentToolStatusText(nextRunningToolName));
        } else {
          setStreamingPhase(assembledRef.current ? 'streaming' : 'thinking');
          setActiveToolName(null);
          setStatusText(null);
        }
        break;
      }
      case 'tool_used': {
        if (hasRealToolEventsRef.current) break;
        const tn = resolveToolName(data.toolName, data.name, data.content, 'tool');
        if (isMessageToolName(tn)) break;
        const stableToolCallId = resolveCompatibilityToolReplayIdentity(
          data,
          resolvedPortalSession || sessionRef.current,
        );
        if (
          stableToolCallId
          && (
            compatibilityToolReplayIdsRef.current.has(stableToolCallId)
            || activeStreamToolCallsRef.current.some((tool) => tool.id === stableToolCallId)
          )
        ) break;
        if (stableToolCallId) compatibilityToolReplayIdsRef.current.add(stableToolCallId);
        graduateLiveThinkingSegment();
        if (assembledRef.current && assembledRef.current.trim().length > 0) {
          graduateLiveTextSegment(assistantId);
        }
        const toolOrder = streamActivityOrderRef.current++;
        setMessages(prev => {
          const tid = stableToolCallId || 'tool-' + (++toolCounterRef.current);
          const now = Date.now();
          const projection = appendCompletedToolCallIfMissing(prev, assistantId, {
            ...buildCompletedToolCall({
              id: tid,
              name: tn,
              startedAt: now - 1000,
              endedAt: now,
            }),
            order: toolOrder,
          }, {
            now,
            ...(stableToolCallId ? { stableToolCallId } : {}),
          });
          if (projection.changed) activeStreamToolCallsRef.current = projection.toolCalls as ToolCall[];
          return projection.messages as ChatMessage[];
        });
        break;
      }
      case 'toolCall': {
        const tid = 'tool-' + (++toolCounterRef.current);
        const toolName = resolveToolName(data.toolName, data.name, 'tool');
        if (isMessageToolName(toolName)) break;
        graduateLiveThinkingSegment();
        if (assembledRef.current && assembledRef.current.trim().length > 0) {
          graduateLiveTextSegment(assistantId);
        }
        setStreamingPhase('tool');
        setActiveToolName(toolName);
        setStatusText(getCurrentToolStatusText(toolName));
        const toolOrder = streamActivityOrderRef.current++;
        setMessages(prev => {
          const projection = appendToolCallToMessage(prev, assistantId, {
            ...buildRunningToolCall({
              id: data.id || tid,
              name: toolName,
              arguments: data.arguments,
            }),
            order: toolOrder,
          });
          activeStreamToolCallsRef.current = projection.toolCalls as ToolCall[];
          return projection.messages as ChatMessage[];
        });
        break;
      }
      case 'toolResult': {
        const resolvedToolName = resolveToolName(data.toolName, data.name, data.content, 'tool');
        if (isMessageToolName(resolvedToolName)) break;
        let nextRunningToolName: string | null = null;
        setMessages(prev => {
          const projection = finishMatchingToolCallInMessage(prev, assistantId, {
            toolCallId: data.toolCallId,
            toolName: resolvedToolName,
            result: typeof data.content === 'string' ? data.content : undefined,
            status: data.status,
          });
          nextRunningToolName = projection.nextRunningToolName ? resolveToolName(projection.nextRunningToolName) : null;
          activeStreamToolCallsRef.current = projection.toolCalls as ToolCall[];
          return projection.messages as ChatMessage[];
        });
        if (nextRunningToolName) {
          setStreamingPhase('tool');
          setActiveToolName(nextRunningToolName);
          setStatusText(getCurrentToolStatusText(nextRunningToolName));
        } else {
          setStreamingPhase(assembledRef.current ? 'streaming' : 'thinking');
          setActiveToolName(null);
          setStatusText(null);
        }
        break;
      }
      case 'segment_break': {
        // Don't create a new bubble — keep all text in a single streaming message.
        // Just acknowledge that a new segment started (for tool call boundaries).
        break;
      }
      case 'text': {
        const rawChunk = typeof data.content === 'string' ? data.content : '';
        if (rawChunk && isControlOrMaintenanceAssistantContent(rawChunk)) {
          break;
        }
        const safeChunk = typeof data.content === 'string'
          ? (data.replace === true ? sanitizeAssistantContent(data.content) : sanitizeAssistantChunk(data.content))
          : data.content;
        graduateLiveThinkingSegment();
        const nextText = mergeStreamText(safeChunk, { replace: data.replace === true });
        setStatusText(null);
        setStreamingPhase('streaming');
        setActiveToolName(null);
        // Throttle UI updates to reduce re-renders during fast streaming.
        // Text is accumulated synchronously in assembledRef, but React state
        // updates are batched to TEXT_THROTTLE_MS intervals (default 50ms = 20fps).
        schedulePendingTextRender(nextText);
        if (typeof safeChunk === 'string' && safeChunk) resetStreamWatchdog({ visible: true });
        break;
      }
      case 'done': {
        if (isAbortedDoneEvent(data)) {
          settleCancelledTurn(incomingPortalRunId);
          break;
        }
        clearStreamWatchdog();
        clearPendingTextRender();
        lastTerminalRunIdRef.current = incomingPortalRunId || currentRunIdRef.current;

        const rawFinal = typeof data.content === 'string' ? data.content : '';
        const hasVisibleFinal = rawFinal.length > 0 && !isControlOrMaintenanceAssistantContent(rawFinal);
        const finalContent = hasVisibleFinal ? sanitizeAssistantContent(rawFinal) : assembledRef.current;
        assembledRef.current = finalContent;
        const prov = data.provenance || null;
        const model = normalizeProviderModel(providerRef.current, typeof data?.metadata?.model === 'string' ? data.metadata.model : (typeof data?.model === 'string' ? data.model : ''));
        const hadToolEvents = hasRealToolEventsRef.current;
        const currentStreamSegs = [...streamSegmentsRef.current];
        const finalStreamSegs = thinkingContentRef.current.trim() || thinkingSubjectRef.current
          ? [...currentStreamSegs, {
              text: thinkingContentRef.current,
              ...(thinkingSubjectRef.current ? { subject: thinkingSubjectRef.current } : {}),
              ts: Date.now(),
              kind: 'thinking' as const,
              order: streamActivityOrderRef.current++,
              ...(reasoningLaneRef.current ? { lane: reasoningLaneRef.current } : {}),
            }]
          : currentStreamSegs;
        const shouldHideTurn = !finalContent.trim() && finalStreamSegs.length === 0 && !hadToolEvents;
        let cid = streamingAssistantIdRef.current;
        if (!cid && !shouldHideTurn) {
          cid = ensureStreamingAssistantBubble({ idPrefix: 'resume-done', content: '', resetIfCreated: false }).assistantId;
        }

        setStatusText(null);
        setStreamingPhase('idle');
        resetLiveThinkingTimeline();
        setActiveToolName(null);
        setLastProvenance(prov);
        setIsRunning(false);
        if (compactionPhaseRef.current === 'compacting') {
          compactionPhaseRef.current = 'idle';
          setCompactionPhase('idle');
          if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
        }

        isStreamActiveRef.current = false;
        streamTransportRef.current = null;
        streamingAssistantIdRef.current = null;
        activeStreamToolCallsRef.current = [];
        currentRunIdRef.current = null;
        directClientRef.current?.setActiveStreamSession(null);
        assembledRef.current = '';
        lastSegmentStartRef.current = 0;
        lastRawTextLenRef.current = 0;

        const graduatedSegments = finalStreamSegs.length > 0 || (cid && hadToolEvents)
          ? buildGraduatedSegments(finalStreamSegs, finalContent)
          : [];

        if (cid) {
          if (shouldHideTurn) {
            setMessages(prev => prev.filter(m => m.id !== cid));
          } else {
            setMessages(prev => prev.map(m => {
              if (m.id !== cid) return m;
              const update: Partial<ChatMessage> = { content: finalContent, provenance: prov || undefined, model: model || m.model };
              if (graduatedSegments.length > 0) {
                update.segments = graduatedSegments;
              }
              return { ...m, ...update };
            }));
          }
        }
        scheduleSessionTelemetryRefresh(400);
        if (providerUsesPortalStreamBus(providerRef.current)) {
          // Durable history is the final authority after a bus-backed turn.
          // This restores provider-side deliveries that were not represented in
          // the live lane and heals any terminal frame lost during reconnect.
          schedulePostTurnHistorySync(450, 2500);
        }
        break;
      }
      case 'error': {
        clearStreamWatchdog();
        clearPendingTextRender();
        lastTerminalRunIdRef.current = incomingPortalRunId || currentRunIdRef.current;
        if (compactionTimerRef.current) {
          clearTimeout(compactionTimerRef.current);
          compactionTimerRef.current = null;
        }
        if (assistantId) {
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, content: '⚠️ ' + normalizeAgentError(data.content, 'Unknown error') } : m
          ));
        }
        setStatusText(null);
        setStreamingPhase('idle');
        setActiveToolName(null);
        activeStreamToolCallsRef.current = [];
        compactionPhaseRef.current = 'idle';
        setCompactionPhase('idle');
        setIsRunning(false);
        currentRunIdRef.current = null;
        isStreamActiveRef.current = false;
        streamTransportRef.current = null;
        streamingAssistantIdRef.current = null;
        directClientRef.current?.setActiveStreamSession(null);
        assembledRef.current = '';
        resetLiveThinkingTimeline();
        break;
      }
      case 'exec_approval': {
        const approval = data.approval as ExecApprovalRequest;
        if (approval?.id) {
          setPendingApprovals((prev) => upsertExecApproval(prev, approval));
          setStatusText('\u23f3 Waiting for command approval\u2026');
        }
        break;
      }
      case 'exec_approval_resolved': {
        const resolved = data.resolved;
        if (resolved?.id) setPendingApprovals((prev) => removeExecApproval(prev, resolved.id));
        break;
      }
      case 'stream_resume': {
        applyOpenClawActiveStreamSnapshot({ ...data, active: true }, { statusTextWhenNoTool: 'Reconnecting to stream…', source: 'portal' });
        break;
      }
      case 'stream_status': {
        if (data.active) {
          applyOpenClawActiveStreamSnapshot({ ...data, active: true }, { statusTextWhenNoTool: 'Reconnecting to stream…', source: 'portal' });
          break;
        }
        const canSafelyClear = data.safeToClear === true || data.inactiveReason === 'terminal' || data.inactiveReason === 'stale';
        if (providerRef.current === 'OPENCLAW' && isStreamActiveRef.current && !canSafelyClear) {
          setIsRunning(true);
          setStreamingPhase(prev => prev === 'idle' ? (activeToolNameRef.current ? 'tool' : 'thinking') : prev);
          markStreamRecovery(activeToolNameRef.current ? getToolStatusText(activeToolNameRef.current) : 'Reconnecting to stream…');
          resetStreamWatchdog();
          break;
        }
        if (canSafelyClear && isStreamActiveRef.current) {
          preserveLiveTurnThenClear({ terminal: data.inactiveReason === 'terminal' });
          schedulePostTurnHistorySync(900);
        }
        break;
      }
      case 'run_resumed': {
        debugLog(streamingAssistantIdRef.current ? 'run_resumed agent continuing after sub-agent' : 'run_resumed resumed without visible bubble');
        isStreamActiveRef.current = true;
        if (!streamTransportRef.current) streamTransportRef.current = 'portal';
        setIsRunning(true);
        setLiveRunPhase('thinking', null);
        resetStreamWatchdog();
        break;
      }
      case 'stream_ended': {
        lastTerminalRunIdRef.current = incomingPortalRunId || currentRunIdRef.current;
        // Authoritative inactive reconciliation can replace a terminal frame
        // that was missed during an outage. Preserve whatever the user could
        // already see before clearing live refs, or preamble/reasoning/tool
        // state disappears until the delayed durable-history merge.
        preserveLiveTurnThenClear({ terminal: true });
        clearPostTurnHistorySync();
        if (providerUsesPortalStreamBus(providerRef.current)) {
          schedulePostTurnHistorySync(900);
        }
        break;
      }
      case 'connected':
      case 'keepalive':
        break;
    }
  }, [appendLiveUserMessage, applyOpenClawActiveStreamSnapshot, preserveLiveTurnThenClear, clearPendingTextRender, clearPostTurnHistorySync, clearStreamRecoveryTimer, ensureStreamingAssistantBubble, getCurrentToolStatusText, handleActiveTurnConflict, markStreamRecovery, normalizeAgentError, observeSessionActivityTitle, reconcileIncomingRunEpoch, recordReasoningTurnSequence, recordRuntimeReplaySequence, resetLiveThinkingTimeline, resetStreamWatchdog, clearStreamWatchdog, appendThinkingChunk, applyThinkingSubject, applyCompactionState, buildGraduatedSegments, getRunningToolName, graduateLiveTextSegment, graduateLiveThinkingSegment, mergeStreamText, resolveOpenClawSessionKey, schedulePendingTextRender, schedulePostTurnHistorySync, scheduleSessionTelemetryRefresh, scheduleStreamContinuityRepair, setLiveRunPhase, settleCancelledTurn]);

  // Keep handleWsEvent in a ref so the WS handler always calls the latest version
  const handleWsEventRef = useRef(handleWsEvent);
  useEffect(() => { handleWsEventRef.current = handleWsEvent; }, [handleWsEvent]);

  const resolveCurrentStreamModel = useCallback((rawModel?: unknown): string => {
    const normalizedCandidate = typeof rawModel === 'string' && rawModel.trim()
      ? normalizeProviderModel(providerRef.current, rawModel.trim())
      : '';
    if (normalizedCandidate) {
      modelRef.current = normalizedCandidate;
      setSelectedModelRaw(prev => (prev === normalizedCandidate ? prev : normalizedCandidate));
      return normalizedCandidate;
    }
    return normalizeProviderModel(providerRef.current, modelRef.current || '');
  }, []);

  const clearDirectPendingEmptyFinal = useCallback(() => {
    const pending = directPendingEmptyFinalRef.current;
    if (!pending) return null;
    clearTimeout(pending.timer);
    directPendingEmptyFinalRef.current = null;
    return { runId: pending.runId, model: pending.model };
  }, []);

  const completeDirectAssistantTurn = useCallback((rawFinal: string, options?: {
    runId?: string | null;
    model?: string | null;
    provenance?: string | null;
  }) => {
    clearStreamWatchdog();
    clearPendingTextRender();
    clearDirectPendingEmptyFinal();

    const terminalRunId = options?.runId || currentRunIdRef.current || null;
    lastTerminalRunIdRef.current = terminalRunId || currentRunIdRef.current;

    const rawText = typeof rawFinal === 'string' ? rawFinal : '';
    const finalContent = rawText && !isControlOrMaintenanceAssistantContent(rawText)
      ? sanitizeAssistantContent(rawText)
      : assembledRef.current;
    assembledRef.current = finalContent;

    const model = resolveCurrentStreamModel(options?.model || undefined);
    const prov = options?.provenance || null;
    const hadToolEvents = hasRealToolEventsRef.current;
    const currentStreamSegs = [...streamSegmentsRef.current];
    const finalStreamSegs = thinkingContentRef.current.trim() || thinkingSubjectRef.current
      ? [...currentStreamSegs, {
          text: thinkingContentRef.current,
          ...(thinkingSubjectRef.current ? { subject: thinkingSubjectRef.current } : {}),
          ts: Date.now(),
          kind: 'thinking' as const,
          order: streamActivityOrderRef.current++,
          ...(reasoningLaneRef.current ? { lane: reasoningLaneRef.current } : {}),
        }]
      : currentStreamSegs;
    const shouldHideTurn = !finalContent.trim() && finalStreamSegs.length === 0 && !hadToolEvents;
    let cid = streamingAssistantIdRef.current;
    if (!cid && !shouldHideTurn) {
      cid = ensureStreamingAssistantBubble({ idPrefix: 'direct-final', content: '', resetIfCreated: false }).assistantId;
    }

    setStatusText(null);
    setStreamingPhase('idle');
    resetLiveThinkingTimeline();
    setActiveToolName(null);
    if (prov) setLastProvenance(prov);
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
    streamTransportRef.current = null;
    streamingAssistantIdRef.current = null;
    activeStreamToolCallsRef.current = [];
    currentRunIdRef.current = null;
    directClientRef.current?.setActiveStreamSession(null);
    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = 0;
    resetDirectSnapshotCursor();

    const graduatedSegments = finalStreamSegs.length > 0 || hadToolEvents
      ? buildGraduatedSegments(finalStreamSegs, finalContent)
      : [];

    if (cid) {
      if (shouldHideTurn) {
        setMessages(prev => prev.filter(m => m.id !== cid));
      } else {
        setMessages(prev => prev.map(m => {
          if (m.id !== cid) return m;
          const update: Partial<ChatMessage> = {
            content: finalContent,
            provenance: prov || m.provenance,
            model: model || m.model,
          };
          if (graduatedSegments.length > 0) {
            update.segments = graduatedSegments;
          }
          return { ...m, ...update };
        }));
      }
    }

    scheduleSessionTelemetryRefresh(400);
    if (providerRef.current === 'OPENCLAW') {
      schedulePostTurnHistorySync(450, 2500);
    }
  }, [buildGraduatedSegments, clearDirectPendingEmptyFinal, clearPendingTextRender, clearStreamWatchdog, ensureStreamingAssistantBubble, resetDirectSnapshotCursor, resetLiveThinkingTimeline, resolveCurrentStreamModel, schedulePostTurnHistorySync, scheduleSessionTelemetryRefresh]);

  /**
   * Handle events from the direct gateway client.
   * Maps native gateway events to our internal event format.
   */
  const handleDirectGatewayEvent = useCallback((evt: GatewayEvent) => {
    const isStreamEvent = evt.event === 'chat' || evt.event === 'agent';
    if (isStreamEvent) {
      clearStreamRecoveryTimer();
    }
    const payload = evt.payload;
    const currentSession = resolveOpenClawSessionKey(sessionRef.current);
    const payloadSession = typeof payload?.sessionKey === 'string'
      ? resolveOpenClawSessionKey(payload.sessionKey)
      : '';
    const incomingRunId = normalizeRunId(payload?.runId);
    const expectedRunId = currentRunIdRef.current;
    const isDirectTerminalEvent = evt.event === 'chat' && (payload?.state === 'final' || payload?.state === 'aborted' || payload?.state === 'error');
    const effectiveTerminalRunId = incomingRunId || expectedRunId;
    if (isDirectTerminalEvent) outstandingChatDispatchRef.current = null;

    if (isDirectTerminalEvent && !isStreamActiveRef.current && !streamingAssistantIdRef.current) {
      if (!effectiveTerminalRunId || lastTerminalRunIdRef.current === effectiveTerminalRunId) {
        debugLog('[ChatState] Ignoring duplicate direct terminal event', {
          event: evt.event,
          state: payload?.state,
          runId: effectiveTerminalRunId,
        });
        return;
      }
    }

    if (isStreamEvent) {
      setWsConnected(true);
      if (payloadSession && currentSession && payloadSession !== currentSession) {
        debugLog('[ChatState] Ignoring direct event for different session', {
          event: evt.event,
          payloadSession,
          currentSession,
        });
        return;
      }
      if (incomingRunId) {
        const epochDecision = reconcileIncomingRunEpoch(incomingRunId, {
          continuationVerified: expectedRunId !== incomingRunId && isVerifiedDirectContinuationFrame(evt),
        });
        if (epochDecision === 'reject') {
          debugLog('[ChatState] Ignoring direct event outside the active run epoch', {
            event: evt.event,
            expectedRunId,
            incomingRunId,
          });
          return;
        }
        if (epochDecision === 'adopt') {
          debugLog('[ChatState] Adopted verified direct continuation run', {
            event: evt.event,
            previousRunId: expectedRunId,
            incomingRunId,
          });
        }
        directClientRef.current?.setActiveStreamSession(payloadSession || currentSession || null);
      }
    }
    if ((streamTransportRef.current === 'portal' || streamTransportRef.current === 'sse') && isStreamActiveRef.current && isStreamEvent) {
      return;
    }

    if (evt.event === 'session.message') {
      setWsConnected(true);
      if (payloadSession && currentSession && payloadSession !== currentSession) {
        debugLog('[ChatState] Ignoring direct session.message for different session', {
          payloadSession,
          currentSession,
        });
        return;
      }

      const message = payload?.message as any;
      const role = typeof message?.role === 'string'
        ? message.role.trim().toLowerCase()
        : (typeof message?.type === 'string' ? message.type.trim().toLowerCase() : '');
      const visibleText = gatewayTextFromLiveChatPayload({ message }).trim();
      const messageToolSourceReplyText = extractMessageToolSourceReplyTextFromGatewayPayload(payload);
      const pendingEmptyFinal = directPendingEmptyFinalRef.current;
      const canCompleteFromSessionMessage = Boolean(pendingEmptyFinal) || isStreamActiveRef.current || Boolean(currentRunIdRef.current);

      if (role === 'user' && visibleText) {
        const rawIdempotencyKey = typeof message?.idempotencyKey === 'string'
          ? message.idempotencyKey.trim()
          : '';
        const echoedClientMessageId = clientMessageIdFromDirectGatewayIdempotencyKey(
          rawIdempotencyKey,
        );
        const matchesOptimisticLocal = echoedClientMessageId
          && messagesRef.current.some((candidate) => (
            candidate.id === echoedClientMessageId
            && candidate.role === 'user'
            && candidate.pendingAck
          ));
        appendLiveUserMessage({
          content: visibleText,
          messageId: matchesOptimisticLocal
            ? echoedClientMessageId
            : (message?.id || message?.messageId || message?.idempotencyKey),
          messageTimestamp: message?.timestamp || payload?.ts,
          sourceChannel: message?.sourceChannel,
        });
        if (incomingRunId && !currentRunIdRef.current) {
          reconcileIncomingRunEpoch(incomingRunId, { continuationVerified: true });
          directClientRef.current?.setActiveStreamSession(payloadSession || currentSession || null);
        }
        scheduleSessionTelemetryRefresh(200);
        return;
      }

      if (messageToolSourceReplyText && !isControlOrMaintenanceAssistantContent(messageToolSourceReplyText) && canCompleteFromSessionMessage) {
        const pending = clearDirectPendingEmptyFinal();
        completeDirectAssistantTurn(messageToolSourceReplyText, {
          runId: pending?.runId || incomingRunId || currentRunIdRef.current,
          model: gatewayModelFromPayload(payload) || pending?.model || null,
          provenance: 'via OpenClaw',
        });
        return;
      }

      const shouldMirrorAssistantDelivery = role === 'assistant'
        && visibleText
        && !isControlOrMaintenanceAssistantContent(visibleText)
        && canCompleteFromSessionMessage;

      if (shouldMirrorAssistantDelivery) {
        const pending = clearDirectPendingEmptyFinal();
        completeDirectAssistantTurn(visibleText, {
          runId: pending?.runId || incomingRunId || currentRunIdRef.current,
          model: gatewayModelFromPayload(payload) || pending?.model || null,
          provenance: 'via OpenClaw',
        });
        return;
      }

      if (providerRef.current === 'OPENCLAW') {
        scheduleSessionTelemetryRefresh(200);
        if (isStreamActiveRef.current || currentRunIdRef.current || pendingEmptyFinal) {
          schedulePostTurnHistorySync(900, 2500);
        } else {
          void loadHistoryInternalRef.current?.(currentSession || sessionRef.current || 'main', 'OPENCLAW', {
            force: true,
            refreshActiveSnapshot: false,
          });
        }
      }
      return;
    }

    if (evt.event === 'sessions.changed') {
      const changedSession = typeof payload?.sessionKey === 'string'
        ? resolveOpenClawSessionKey(payload.sessionKey)
        : '';
      if (!changedSession || changedSession === currentSession) {
        scheduleSessionTelemetryRefresh(250);
      }
      return;
    }

    if (evt.event === 'chat') {
      const state = payload.state;
      const visibleMessageText = gatewayTextFromLiveChatPayload(payload).trim();
      const hasVisibleNonMaintenanceText = Boolean(visibleMessageText && !isStandaloneMaintenanceNoticeContent(visibleMessageText));
      const stateIsCompactionStart = state === 'compacting' || state === 'compaction_start';
      const stateIsCompactionEnd = state === 'compacted' || state === 'compaction_end';
      const effectiveState = (stateIsCompactionStart || stateIsCompactionEnd) && hasVisibleNonMaintenanceText
        ? 'delta'
        : state;

      if (stateIsCompactionStart && effectiveState !== 'delta') {
        applyCompactionState('start');
        return;
      }
      if (stateIsCompactionEnd && effectiveState !== 'delta') {
        applyCompactionState('end');
        return;
      }

      // Track current run for abort functionality
      if (incomingRunId) {
        currentRunIdRef.current = incomingRunId;
        directClientRef.current?.setActiveStreamSession(payloadSession || currentSession || null);
      }
      streamTransportRef.current = 'direct';

      switch (effectiveState) {
        case 'delta': {
          let assistantId = streamingAssistantIdRef.current;

          const thinkingText = gatewayThinkingFromLiveChatPayload(payload);

          const text = gatewayTextFromLiveChatPayload(payload);

          if (text && isControlOrMaintenanceAssistantContent(text)) {
            if (assistantId || isStreamActiveRef.current) resetStreamWatchdog();
            break;
          }

          const safeChunk = text ? sanitizeAssistantChunk(text) : '';
          const hasVisibleText = Boolean(safeChunk);
          if (!assistantId && (hasVisibleText || thinkingText)) {
            assistantId = ensureStreamingAssistantBubble({ idPrefix: 'direct', content: '', resetIfCreated: true }).assistantId;
            isStreamActiveRef.current = true;
            streamTransportRef.current = 'direct';
            setIsRunning(true);
            directClientRef.current?.setActiveStreamSession(sessionRef.current || null);
          }

          if (thinkingText) {
            const thinkingChunk = extractThinkingChunk('thinking', thinkingText, assembledRef.current.length > 0);
            if (thinkingChunk && assembledRef.current.trim()) {
              graduateDirectLiveTextSegment(assistantId);
            }
            appendThinkingChunk(
              assistantId,
              thinkingChunk,
              { lane: 'raw' },
            );
            if (!assembledRef.current && assistantId) setStreamingPhase('thinking');
          }

          if (hasVisibleText) {
            graduateLiveThinkingSegment();
            const snapshot = reconcileCumulativeSnapshot(directSnapshotCursorRef.current, safeChunk);
            directSnapshotCursorRef.current = snapshot.cursor;
            lastRawTextLenRef.current = snapshot.cursor.rawSnapshot.length;
            lastSegmentStartRef.current = snapshot.cursor.segmentBaseline.length;
            assembledRef.current = snapshot.segmentText;
            setStatusText(null);
            setStreamingPhase('streaming');
            setActiveToolName(null);

            schedulePendingTextRender(snapshot.segmentText);
          }
          if (assistantId || isStreamActiveRef.current) {
            resetStreamWatchdog({ visible: hasVisibleText || Boolean(thinkingText) });
          }
          break;
        }
        case 'final': {
          const rawFinalText = gatewayTextFromLiveChatPayload(payload);
          let finalText = assembledRef.current;
          if (rawFinalText) {
            const finalSnapshot = reconcileCumulativeSnapshot(
              directSnapshotCursorRef.current,
              sanitizeAssistantContent(rawFinalText),
            );
            directSnapshotCursorRef.current = finalSnapshot.cursor;
            finalText = finalSnapshot.segmentText;
          }

          const hasVisibleFinal = Boolean(finalText.trim()) && !isControlOrMaintenanceAssistantContent(finalText);
          const hasAnyVisibleState = Boolean(assembledRef.current.trim())
            || Boolean(thinkingContentRef.current.trim())
            || hasRealToolEventsRef.current;

          if (!hasVisibleFinal && !hasAnyVisibleState) {
            clearStreamWatchdog();
            clearPendingTextRender();
            clearDirectPendingEmptyFinal();

            const pendingRunId = incomingRunId || currentRunIdRef.current || null;
            const pendingModel = resolveCurrentStreamModel(gatewayModelFromPayload(payload));
            const timer = setTimeout(() => {
              if (directPendingEmptyFinalRef.current?.runId !== pendingRunId) return;
              directPendingEmptyFinalRef.current = null;
              completeDirectAssistantTurn('', {
                runId: pendingRunId,
                model: pendingModel,
                provenance: 'via OpenClaw',
              });
            }, 2500);
            directPendingEmptyFinalRef.current = { runId: pendingRunId, model: pendingModel || null, timer };
            scheduleSessionTelemetryRefresh(400);
            schedulePostTurnHistorySync(900, 2500);
            break;
          }

          completeDirectAssistantTurn(finalText, {
            runId: incomingRunId || currentRunIdRef.current,
            model: gatewayModelFromPayload(payload),
            provenance: 'via OpenClaw',
          });
          break;
        }
        case 'aborted': {
          settleCancelledTurn(incomingRunId);
          break;
        }
        case 'error': {
          clearStreamWatchdog();
          clearPendingTextRender();
          clearDirectPendingEmptyFinal();
          lastTerminalRunIdRef.current = incomingRunId || currentRunIdRef.current;
          if (compactionTimerRef.current) {
            clearTimeout(compactionTimerRef.current);
            compactionTimerRef.current = null;
          }
          const errorMsg = normalizeAgentError(payload.errorMessage, 'Unknown error');
          const cid = streamingAssistantIdRef.current;
          const abortedTerminalError = isAbortTerminalError(payload);

          if (abortedTerminalError) {
            settleCancelledTurn(incomingRunId);
            break;
          }

          setStatusText(null);
          setStreamingPhase('idle');
          setActiveToolName(null);
          activeStreamToolCallsRef.current = [];
          compactionPhaseRef.current = 'idle';
          setCompactionPhase('idle');
          setIsRunning(false);
          isStreamActiveRef.current = false;
          streamTransportRef.current = null;
          streamingAssistantIdRef.current = null;
          currentRunIdRef.current = null;
          directClientRef.current?.setActiveStreamSession(null);
          assembledRef.current = '';
          resetLiveThinkingTimeline();

          if (cid) {
            setMessages(prev => prev.map(m =>
              m.id === cid ? { ...m, content: '⚠️ ' + errorMsg } : m
            ));
          }
          break;
        }
      }
    } else if (evt.event === 'agent') {
      const payload = evt.payload;
      const rawData = payload.data as any;
      const codexProgressStatus = getCodexAppServerProgressStatus(payload.stream, rawData);

      if (codexProgressStatus) {
        const runningToolName = getRunningToolName();
        let assistantId = streamingAssistantIdRef.current;
        if (!assistantId) {
          assistantId = ensureStreamingAssistantBubble({ idPrefix: 'direct-progress', content: '', resetIfCreated: true }).assistantId;
        }
        isStreamActiveRef.current = true;
        streamTransportRef.current = 'direct';
        setIsRunning(true);
        setSessionAvailability('present');
        directClientRef.current?.setActiveStreamSession(payloadSession || currentSession || null);
        if (!runningToolName) {
          const statusThinkingChunk = extractThinkingChunk('status', codexProgressStatus, false);
          if (statusThinkingChunk && assembledRef.current.trim()) {
            graduateDirectLiveTextSegment(assistantId);
          }
          appendThinkingChunk(
            assistantId,
            statusThinkingChunk,
            { lane: 'status' },
          );
        }
        setLiveRunPhase('thinking', codexProgressStatus);
        resetStreamWatchdog({ visible: !runningToolName });
        return;
      }

      if (payload.stream === 'assistant') {
        const snapshotText = typeof rawData?.text === 'string' ? sanitizeAssistantChunk(rawData.text) : '';
        const deltaText = typeof rawData?.delta === 'string' ? sanitizeAssistantChunk(rawData.delta) : '';
        const incomingText = snapshotText || deltaText;
        if (!incomingText || isControlOrMaintenanceAssistantContent(incomingText)) return;

        let assistantId = streamingAssistantIdRef.current;
        if (!assistantId) {
          assistantId = ensureStreamingAssistantBubble({ idPrefix: 'direct-assistant', content: '', resetIfCreated: true }).assistantId;
        }
        isStreamActiveRef.current = true;
        streamTransportRef.current = 'direct';
        setIsRunning(true);
        setSessionAvailability('present');
        directClientRef.current?.setActiveStreamSession(payloadSession || currentSession || null);

        graduateLiveThinkingSegment();

        let nextText: string;
        if (snapshotText) {
          const snapshot = reconcileCumulativeSnapshot(directSnapshotCursorRef.current, snapshotText);
          directSnapshotCursorRef.current = snapshot.cursor;
          lastRawTextLenRef.current = snapshot.cursor.rawSnapshot.length;
          lastSegmentStartRef.current = snapshot.cursor.segmentBaseline.length;
          nextText = snapshot.segmentText;
          assembledRef.current = nextText;
        } else {
          nextText = mergeStreamText(deltaText);
          directSnapshotCursorRef.current = appendCumulativeSnapshotDelta(directSnapshotCursorRef.current, deltaText);
          lastRawTextLenRef.current = directSnapshotCursorRef.current.rawSnapshot.length;
        }

        setStatusText(null);
        setStreamingPhase('streaming');
        setActiveToolName(null);
        schedulePendingTextRender(nextText);
        setLiveRunPhase('streaming', null);
        resetStreamWatchdog({ visible: true });
        return;
      }

      if (payload.stream === 'item' && rawData?.kind === 'preamble') {
        const preambleText = typeof rawData?.progressText === 'string'
          ? sanitizeAssistantChunk(rawData.progressText)
          : (typeof rawData?.text === 'string'
              ? sanitizeAssistantChunk(rawData.text)
              : (typeof rawData?.content === 'string' ? sanitizeAssistantChunk(rawData.content) : ''));
        const cumulativePreamble = mergePreambleProgressSnapshot(
          directPreambleProgressRef.current,
          {
            runId: incomingRunId,
            itemId: typeof rawData?.itemId === 'string'
              ? rawData.itemId
              : (typeof rawData?.item_id === 'string'
                  ? rawData.item_id
                  : (typeof rawData?.id === 'string' ? rawData.id : null)),
            text: preambleText,
          },
        );
        if (!cumulativePreamble) return;

        let assistantId = streamingAssistantIdRef.current;
        if (!assistantId) {
          assistantId = ensureStreamingAssistantBubble({ idPrefix: 'direct-preamble', content: '', resetIfCreated: true }).assistantId;
        }
        isStreamActiveRef.current = true;
        streamTransportRef.current = 'direct';
        setIsRunning(true);
        setSessionAvailability('present');
        directClientRef.current?.setActiveStreamSession(payloadSession || currentSession || null);
        const preambleThinking = extractThinkingChunk(
          'thinking',
          cumulativePreamble,
          assembledRef.current.length > 0,
        );
        if (preambleThinking && assembledRef.current.trim()) {
          graduateDirectLiveTextSegment(assistantId);
        }
        appendThinkingChunk(assistantId, preambleThinking, { replace: true, lane: 'preamble' });
        setStatusText(sanitizeThinkingSubject(cumulativePreamble) || null);
        setStreamingPhase('thinking');
        setLiveRunPhase('thinking', null);
        resetStreamWatchdog({ visible: true });
        return;
      }

      const normalizedToolData = payload.stream === 'tool' && rawData
        ? rawData
        : (payload.stream === 'item' && rawData?.kind === 'tool'
            ? {
                ...rawData,
                phase: rawData.phase === 'end' ? 'result' : rawData.phase,
                result: rawData.result ?? rawData.partialResult ?? rawData.statusText ?? rawData.meta,
              }
            : null);

      if (payload.stream === 'thinking') {
        const thinkingText = typeof rawData?.text === 'string' && rawData.text.trim()
          ? rawData.text
          : (typeof rawData?.delta === 'string' && rawData.delta.trim()
              ? rawData.delta
              : (typeof rawData?.content === 'string' ? rawData.content : ''));
        const thinkingChunk = extractThinkingChunk('thinking', thinkingText, assembledRef.current.length > 0);
        const progressStatus = formatThinkingProgressStatus(rawData?.progressTokens);
        if (!thinkingChunk && !progressStatus) return;

        let assistantId = streamingAssistantIdRef.current;
        if (!assistantId) {
          assistantId = ensureStreamingAssistantBubble({ idPrefix: 'direct-thinking', content: '', resetIfCreated: true }).assistantId;
        }
        isStreamActiveRef.current = true;
        streamTransportRef.current = 'direct';
        setIsRunning(true);
        setSessionAvailability('present');
        directClientRef.current?.setActiveStreamSession(payloadSession || currentSession || null);
        if (progressStatus && !thinkingChunk) {
          setLiveRunPhase('thinking', progressStatus);
          resetStreamWatchdog({ visible: true });
          return;
        }
        applyThinkingSubject(assistantId, rawData?.subject);
        if (thinkingChunk && assembledRef.current.trim()) {
          graduateDirectLiveTextSegment(assistantId);
        }
        appendThinkingChunk(assistantId, thinkingChunk, { lane: 'raw' });
        setLiveRunPhase('thinking', null);
        resetStreamWatchdog({ visible: true });
        return;
      }

      if (payload.stream === 'item' && rawData?.kind === 'analysis') {
        const thinkingText = extractVisibleAnalysisThinkingText(rawData);
        if (thinkingText) {
          let assistantId = streamingAssistantIdRef.current;
          if (!assistantId) {
            assistantId = ensureStreamingAssistantBubble({ idPrefix: 'direct-analysis', content: '', resetIfCreated: true }).assistantId;
          }
          isStreamActiveRef.current = true;
          streamTransportRef.current = 'direct';
          setIsRunning(true);
          setSessionAvailability('present');
          directClientRef.current?.setActiveStreamSession(payloadSession || currentSession || null);
          const thinkingChunk = extractThinkingChunk('thinking', thinkingText, assembledRef.current.length > 0);
          if (thinkingChunk && assembledRef.current.trim()) {
            graduateDirectLiveTextSegment(assistantId);
          }
          appendThinkingChunk(
            assistantId,
            thinkingChunk,
            { lane: 'raw' },
          );
          setLiveRunPhase('thinking', null);
          resetStreamWatchdog({ visible: true });
        }
        return;
      }

      if (normalizedToolData && isMessageToolName(normalizedToolData.name ?? normalizedToolData.toolName)) {
        // The OpenClaw `message` tool is webchat delivery plumbing. The visible
        // transcript arrives through chat/history; showing this as a tool call is
        // what leaks "sending to Web chat" artifacts into Agent Chats.
        if (incomingRunId) {
          currentRunIdRef.current = incomingRunId;
          directClientRef.current?.setActiveStreamSession(payloadSession || currentSession || null);
        }
        resetStreamWatchdog();
        return;
      }

      if (normalizedToolData) {
        const data = normalizedToolData;
        let assistantId = streamingAssistantIdRef.current;

        switch (data.phase) {
          case 'start': {
            if (!assistantId) {
              assistantId = ensureStreamingAssistantBubble({ idPrefix: 'direct-tool', content: '', resetIfCreated: true }).assistantId;
              isStreamActiveRef.current = true;
              streamTransportRef.current = 'direct';
              setIsRunning(true);
              directClientRef.current?.setActiveStreamSession(sessionRef.current || null);
            }
            hasRealToolEventsRef.current = true;
            graduateLiveThinkingSegment();
            // Graduate current streaming text into a finalized segment.
            if (assembledRef.current && assembledRef.current.trim().length > 0) {
              directSnapshotCursorRef.current = beginCumulativeSnapshotSegment(directSnapshotCursorRef.current);
              lastSegmentStartRef.current = directSnapshotCursorRef.current.segmentBaseline.length;
              graduateLiveTextSegment(assistantId);
            }
            const toolName = resolveToolName(data.toolName, data.name, 'tool');
            setStatusText(getCurrentToolStatusText(toolName));
            setStreamingPhase('tool');
            setActiveToolName(toolName);

            const toolId = data.toolCallId || 'tool-' + (++toolCounterRef.current);
            const toolOrder = streamActivityOrderRef.current++;
            if (assistantId) {
              setMessages(prev => prev.map(m => {
                if (m.id !== assistantId) return m;
                const nextToolCalls = [
                  ...(m.toolCalls || []),
                  {
                    id: toolId,
                    name: toolName,
                    arguments: data.args,
                    startedAt: Date.now(),
                    status: 'running' as const,
                    order: toolOrder,
                  },
                ];
                activeStreamToolCallsRef.current = nextToolCalls;
                return {
                  ...m,
                  toolCalls: nextToolCalls,
                };
              }));
            }
            break;
          }
          case 'update': {
            // Partial result update — could update the tool call if needed
            break;
          }
          case 'result': {
            const toolResult = typeof data.result === 'string'
              ? data.result
              : JSON.stringify(data.result);
            let nextRunningToolName: string | null = null;

            if (assistantId) {
              setMessages(prev => prev.map(m => {
                if (m.id !== assistantId) return m;
                const calls = [...(m.toolCalls || [])];
                // Find the matching tool call by ID or most recent running
                const idx = data.toolCallId
                  ? calls.findIndex(c => c.id === data.toolCallId)
                  : calls.findIndex(c => c.status === 'running');
                if (idx >= 0) {
                  calls[idx] = {
                    ...calls[idx],
                    endedAt: Date.now(),
                    result: toolResult,
                    status: 'done',
                  };
                }
                const nextRunningTool = getLastRunningToolCall(calls);
                nextRunningToolName = nextRunningTool ? resolveToolName(nextRunningTool.name) : null;
                activeStreamToolCallsRef.current = calls;
                return { ...m, toolCalls: calls };
              }));
            }
            if (nextRunningToolName) {
              setStreamingPhase('tool');
              setActiveToolName(nextRunningToolName);
              setStatusText(getCurrentToolStatusText(nextRunningToolName));
            } else {
              setStatusText(null);
              setActiveToolName(null);
              setStreamingPhase(assembledRef.current ? 'streaming' : 'thinking');
            }
            break;
          }
        }
        resetStreamWatchdog();
      } else if (payload.stream === 'compaction') {
        const data = payload.data as any;
        const compactionSignal = String(data?.phase || data?.status || '').toLowerCase();
        if (compactionSignal === 'start' || compactionSignal === 'started' || compactionSignal === 'compacting') {
          applyCompactionState({
            phase: 'start',
            content: typeof data?.statusText === 'string' ? data.statusText : 'Compacting context…',
            maintenanceKind: 'compaction',
          });
        } else if (compactionSignal === 'end' || compactionSignal === 'completed' || compactionSignal === 'compacted') {
          const compactionStatusText = typeof data?.statusText === 'string' && data.statusText.trim()
            ? data.statusText
            : (data?.completed === false ? 'Context maintenance finished.' : 'Context compacted');
          applyCompactionState({
            phase: 'end',
            content: compactionStatusText,
            completed: data?.completed !== false,
            maintenanceKind: data?.completed === false ? 'maintenance' : 'compaction',
          });
          scheduleSessionTelemetryRefresh(250);
        }
        resetStreamWatchdog();
      } else if (payload.stream === 'lifecycle') {
        const data = payload.data as any;
        const lifecyclePhase = String(data?.phase || data?.status || '').toLowerCase();
        const lifecycleStatusText = extractLifecycleStatusText(data);
        const lifecycleSignal = inferLifecycleMaintenanceSignal(lifecyclePhase, lifecycleStatusText);

        if (incomingRunId) {
          currentRunIdRef.current = incomingRunId;
          directClientRef.current?.setActiveStreamSession(payloadSession || currentSession || null);
        }

        if (lifecycleSignal === 'compacting') {
          applyCompactionState({
            phase: 'start',
            content: lifecycleStatusText || defaultLifecycleStatusText(lifecycleSignal),
            maintenanceKind: 'compaction',
          });
        } else if (lifecycleSignal === 'compacted') {
          applyCompactionState({
            phase: 'end',
            content: lifecycleStatusText || defaultLifecycleStatusText(lifecycleSignal),
            completed: true,
            maintenanceKind: 'compaction',
          });
          scheduleSessionTelemetryRefresh(250);
        } else if (lifecycleSignal === 'maintenance') {
          applyCompactionState({
            phase: 'start',
            content: lifecycleStatusText || defaultLifecycleStatusText(lifecycleSignal),
            maintenanceKind: 'maintenance',
          });
        } else if (lifecycleSignal === 'maintenance_done') {
          applyCompactionState({
            phase: 'end',
            content: lifecycleStatusText || defaultLifecycleStatusText(lifecycleSignal),
            completed: false,
            maintenanceKind: 'maintenance',
          });
          scheduleSessionTelemetryRefresh(250);
        }

        const lifecycleUiStatus = lifecycleSignal === 'idle'
          ? lifecycleStatusText
          : (lifecycleStatusText || defaultLifecycleStatusText(lifecycleSignal));

        const lifecycleBelongsToActiveRun = Boolean(incomingRunId)
          || isStreamActiveRef.current
          || Boolean(streamingAssistantIdRef.current)
          || Boolean(getRunningToolName());
        if (lifecycleBelongsToActiveRun && (lifecyclePhase === 'started' || lifecyclePhase === 'running' || lifecyclePhase === 'start' || lifecycleSignal !== 'idle')) {
          isStreamActiveRef.current = true;
          streamTransportRef.current = 'direct';
          setIsRunning(true);
          setSessionAvailability('present');
          setLiveRunPhase('thinking', lifecycleUiStatus || null);
          resetStreamWatchdog();
        }
      }
    }
  }, [appendLiveUserMessage, clearDirectPendingEmptyFinal, clearStreamRecoveryTimer, completeDirectAssistantTurn, ensureStreamingAssistantBubble, getCurrentToolStatusText, isAbortTerminalError, normalizeAgentError, reconcileIncomingRunEpoch, resetLiveThinkingTimeline, resetStreamWatchdog, clearStreamWatchdog, clearPendingTextRender, mergeStreamText, appendThinkingChunk, applyThinkingSubject, applyCompactionState, getRunningToolName, graduateDirectLiveTextSegment, graduateLiveTextSegment, graduateLiveThinkingSegment, resolveCurrentStreamModel, schedulePendingTextRender, schedulePostTurnHistorySync, scheduleSessionTelemetryRefresh, resolveOpenClawSessionKey, setLiveRunPhase, settleCancelledTurn]);

  // The direct gateway connection can remain open for hours. Keep the callback
  // identity passed to it stable, while dispatching each frame through the
  // freshest React closure. Otherwise tool/status state changes recreate this
  // handler and tear down the transport in the middle of a turn.
  const handleDirectGatewayEventRef = useRef(handleDirectGatewayEvent);
  handleDirectGatewayEventRef.current = handleDirectGatewayEvent;
  const stableDirectGatewayEventHandlerRef = useRef<((event: GatewayEvent) => void) | null>(null);
  if (!stableDirectGatewayEventHandlerRef.current) {
    stableDirectGatewayEventHandlerRef.current = createLatestCallbackDispatcher(handleDirectGatewayEventRef);
  }

  // WS setup — runs once on mount, survives entire app lifetime
  // Handler registration MUST happen in the same effect that creates the manager,
  // otherwise wsManagerRef.current is null when the handler effect runs.
  useEffect(() => {
    const manager = getWsManager();
    const pendingWsAbortResults = pendingWsAbortResultsRef.current;
    wsManagerRef.current = manager;

    // Register the main event handler via ref indirection so it always calls latest
    const stableHandler = (data: any) => handleWsEventRef.current(data);
    manager.addHandler(stableHandler);

    const statusHandler = (data: any) => {
      if (data.type === 'connected') {
        setWsConnected(true);
        if (isStreamActiveRef.current) {
          if (streamTransportRef.current === 'sse' && activeSseTransportRef.current) {
            const activeSse = activeSseTransportRef.current;
            activeSse.handoffRequested = true;
            debugLog(activeSse.sessionResolved
              ? '[ChatState] Portal WS connected during SSE — handing off transport before reconnect'
              : '[ChatState] Portal WS connected before SSE resolved its session — deferring handoff');
            void handoffActiveSseToPortalRef.current(manager);
            return;
          }
          debugLog('[ChatState] WS connected while stream active — sending reconnect');
          wsManagerRef.current?.send({ type: 'reconnect', session: sessionRef.current, provider: providerRef.current, streamClientId: streamClientIdRef.current });
          resetStreamWatchdogRef.current();
        }
      }
    };
    manager.addHandler(statusHandler);

    // Seed connection state immediately in case the singleton WS connected
    // before this component attached its handlers (fast-connect race).
    if (manager.isConnected()) {
      setWsConnected(true);
    }

    const unsubDisconnect = manager.onDisconnect(() => {
      clearAllActivityTitlesRef.current();
      setWsConnected(false);
      if (isStreamActiveRef.current && streamTransportRef.current !== 'sse') {
        console.warn('[ChatState] WS disconnected during active stream');
        setIsRunning(true);
        setStreamingPhase(prev => prev === 'idle' ? 'thinking' : prev);
        markStreamRecoveryRef.current?.('Reconnecting to stream…');
      }
    });
    // On reconnect: for OpenClaw, reconcile from HTTP history first so one request
    // can restore both committed messages and the active-stream snapshot.
    const unsubReconnect = manager.onReconnect(async () => {
      clearAllActivityTitlesRef.current();
      setWsConnected(true);
      if (isStreamActiveRef.current && streamTransportRef.current === 'sse') {
        debugLog('[ChatState] Portal WS reopened during SSE; connected event will perform ordered handoff');
        return;
      }
      debugLog('[ChatState] WS reconnected — reconciling session state');
      try {
        await loadHistoryInternalRef.current?.(sessionRef.current, providerRef.current, { force: true });
      } catch (err) {
        console.warn('[ChatState] Reconnect sync failed:', err);
      }
    });

    return () => {
      manager.removeHandler(stableHandler);
      manager.removeHandler(statusHandler);
      unsubDisconnect();
      unsubReconnect();
      for (const pending of pendingWsAbortResults.values()) {
        pending.resolve(false);
      }
      pendingWsAbortResults.clear();
      wsManagerRef.current = null;
      releaseWsManager();
    };
  }, []);

  // Only bootstrap the optional direct gateway transport after something has
  // actually asked for it, such as an active stream resume or a user-initiated run.
  // That keeps idle Agent Chat opens from spending a post-startup health probe and
  // direct WS setup before the page has delivered any user value.
  useEffect(() => {
    setDirectGatewayBootstrapReady(false);
    if (!useDirectGateway || provider !== 'OPENCLAW' || !startupReady || !directGatewayDemanded) {
      return;
    }
    const timer = window.setTimeout(() => {
      setDirectGatewayBootstrapReady(true);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [directGatewayDemanded, provider, startupReady, useDirectGateway]);

  // Direct gateway client setup for OPENCLAW provider
  // When useDirectGateway is enabled and provider is OPENCLAW, use the direct
  // gateway connection instead of the portal WS middleman.
  // Defer this until the initial history load finishes and the route has had a
  // moment to settle so direct transport metadata does not compete with first open.
  // Gate on gateway health check first to avoid reconnect loops on fresh installs.
  useEffect(() => {
    // Only create direct client when:
    // 1. Feature flag is enabled
    // 2. Provider is OPENCLAW
    // 3. Initial history bootstrap has completed
    // 4. Post-startup idle deferral has elapsed
    if (!useDirectGateway || provider !== 'OPENCLAW' || !startupReady || !directGatewayBootstrapReady) {
      // Disconnect existing direct client if switching away from OPENCLAW
      // or while a new session is still bootstrapping.
      if (directClientRef.current) {
        debugLog('[ChatState] Disconnecting direct gateway client (provider changed or startup deferred)');
        directClientRef.current.disconnect();
        directClientRef.current = null;
      }
      return;
    }

    // Already have a connected client
    if (directClientRef.current) {
      return;
    }

    let cancelled = false;

    // Check gateway health before attempting direct WS connection.
    // On fresh installs without a configured gateway, this prevents
    // a reconnect loop that spams console errors and wastes resources.
    async function initDirectClient() {
      try {
        const { data } = await client.get('/gateway/health', { _silent: true } as any);
        if (cancelled) return;
        if (!data?.wsConnected) {
          debugLog('[ChatState] Gateway not connected — skipping direct WS (falling back to portal WS)');
          return;
        }
      } catch {
        if (cancelled) return;
        debugLog('[ChatState] Gateway health check failed — skipping direct WS');
        return;
      }

      if (cancelled || directClientRef.current) return;

      debugLog('[ChatState] Creating direct gateway client');
      const directClient = new OpenClawGatewayClient({
        url: createGatewayDirectUrl(),
        onEvent: stableDirectGatewayEventHandlerRef.current!,
        onConnected: () => {
          clearAllActivityTitlesRef.current();
          setWsConnected(true);
          // Reconcile the current session from gateway history plus active-stream snapshot.
          const currentSession = resolveOpenClawSessionKeyRef.current(sessionRef.current);
          const currentProvider = providerRef.current;
          if (currentSession && currentSession !== sessionRef.current) {
            sessionRef.current = currentSession;
            setSessionRaw(currentSession);
            persistStoredSession(currentProvider, currentSession, agentIdRef.current);
          }
          if (currentSession) {
            directClient.setCurrentSession(currentSession);
            const historyLoad = loadHistoryInternalRef.current?.(currentSession, currentProvider, { force: true, refreshActiveSnapshot: true });
            historyLoad?.catch((err) => {
              console.warn('[ChatState] Direct reconnect history sync failed:', err);
            });
          }
        },
        onDisconnected: () => {
          clearAllActivityTitlesRef.current();
          setWsConnected(false);
          if (isStreamActiveRef.current) {
            console.warn('[ChatState] Direct gateway disconnected during active stream');
            setIsRunning(true);
            setStreamingPhase(prev => prev === 'idle' ? 'thinking' : prev);
            markStreamRecoveryRef.current?.('Reconnecting to stream…');
          }
        },
        onAuthFailure: async () => {
          try {
            await authAPI.refresh();
            return true;
          } catch (err) {
            console.warn('[ChatState] Direct gateway auth refresh failed:', err);
            const status = Number((err as any)?.response?.status || 0);
            if (status === 401 || status === 403) {
              useAuthStore.getState().silentLogout();
            }
            return false;
          }
        },
        onError: (err) => {
          console.error('[ChatState] Direct gateway error:', err);
        },
      });

      directClientRef.current = directClient;
      directClient.connect();
    }

    initDirectClient();

    return () => {
      cancelled = true;
      if (directClientRef.current) {
        debugLog('[ChatState] Cleaning up direct gateway client');
        directClientRef.current.disconnect();
        directClientRef.current = null;
      }
    };
  }, [directGatewayBootstrapReady, provider, startupReady, useDirectGateway]);

  // Fresh page loads can race transport/session setup. Give OpenClaw a short retry window
  // to detect an already-active stream so second-device reopen reliably attaches mid-turn.
  useEffect(() => {
    if (provider !== 'OPENCLAW' || useDirectGateway || isLoadingHistory) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const tick = async () => {
      if (cancelled || isStreamActiveRef.current) return;
      attempts += 1;
      await hydrateActiveStream(session, provider);
      if (!cancelled && !isStreamActiveRef.current && attempts < 5) {
        timer = setTimeout(tick, 3000);
      }
    };

    timer = setTimeout(tick, 1200);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [hydrateActiveStream, isLoadingHistory, provider, session, useDirectGateway]);

  // Visibility change handler: when the tab becomes visible again, reopen the live
  // stream if we already know it's active; otherwise reconcile from history so
  // OpenClaw uses one HTTP round trip instead of a status probe + reload pair.
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;

      const now = Date.now();
      if (now - lastForegroundReconcileAtRef.current < 1500) return;
      lastForegroundReconcileAtRef.current = now;

      const manager = wsManagerRef.current;
      const directClient = directClientRef.current;
      const currentSession = resolveOpenClawSessionKey(sessionRef.current);
      const currentProvider = providerRef.current;

      if (!currentSession) return;

      debugLog('[ChatState] Tab became visible — reconciling session state');

      const usingDirectGateway = useDirectGateway && currentProvider === 'OPENCLAW';
      const transportConnected = usingDirectGateway
        ? Boolean(directClient?.isConnected)
        : Boolean(manager && manager.isConnected());

      if (!transportConnected) {
        debugLog('[ChatState] Transport disconnected on visibility — nudging reconnect');
        if (usingDirectGateway) {
          directClient?.connect();
          if (isStreamActiveRef.current) {
            markStreamRecovery('Reconnecting to stream…');
          }
        } else {
          manager?.reconnect();
        }
      }

      if (isStreamActiveRef.current) {
        try {
          await loadHistoryInternal(currentSession, currentProvider, { force: true, refreshActiveSnapshot: true });
        } catch (err) {
          console.warn('[ChatState] Visibility active-stream sync failed:', err);
        }
        if (!usingDirectGateway) {
          manager?.send({ type: 'reconnect', session: currentSession, provider: currentProvider, streamClientId: streamClientIdRef.current });
        }
        resetStreamWatchdog();
        return;
      }
      try {
        if (currentProvider === 'OPENCLAW' && !usingDirectGateway) {
          await loadHistoryInternal(currentSession, currentProvider, { force: true, refreshActiveSnapshot: true });
          return;
        }
        debugLog('[ChatState] No active stream on visibility — reloading history for missed messages');
        await loadHistoryInternal(currentSession, currentProvider, { force: true, refreshActiveSnapshot: true });
      } catch (err) {
        console.warn('[ChatState] Visibility check failed:', err);
      }
    };

    window.addEventListener('focus', handleVisibilityChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', handleVisibilityChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadHistoryInternal, markStreamRecovery, resetStreamWatchdog, resolveOpenClawSessionKey, useDirectGateway]);

  // Clear messages helper — also invalidates any in-flight history load and
  // resets transient stream UI so switching sessions always starts clean.
  const clearMessages = useCallback(() => {
    const pendingDirectFinal = directPendingEmptyFinalRef.current;
    if (pendingDirectFinal) {
      clearTimeout(pendingDirectFinal.timer);
      directPendingEmptyFinalRef.current = null;
    }
    historyGenRef.current++; // invalidate any in-flight loadHistoryInternal
    historyBeforeCursorRef.current = null;
    historyHasMoreBeforeRef.current = false;
    historyLoadedScopeRef.current = null;
    historyOlderPagesLoadedRef.current = false;
    olderHistoryLoadInFlightRef.current = false;
    setMessages([]);
    setMessageQueue([]);
    setIsLoadingHistory(false);
    setHistoryError(null);
    setHasOlderHistory(false);
    setIsLoadingOlderHistory(false);
    setOlderHistoryError(null);
    setStatusText(null);
    setLastProvenance(null);
    setStreamingPhase('idle');
    setActiveToolName(null);
    resetLiveThinkingTimeline();
    compactionPhaseRef.current = 'idle';
    setCompactionPhase('idle');
    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = 0;
    resetDirectSnapshotCursor();
    toolCounterRef.current = 0;
    streamActivityOrderRef.current = 0;
    hasRealToolEventsRef.current = false;
    activeStreamToolCallsRef.current = [];
    streamingAssistantIdRef.current = null;
    currentRunIdRef.current = null;
    outstandingChatDispatchRef.current = null;
    isStreamActiveRef.current = false;
    streamTransportRef.current = null;
    directClientRef.current?.setActiveStreamSession(null);
    isQueueDrainActiveRef.current = false;
    if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
    clearStreamWatchdog();
    if (postTurnHistorySyncTimerRef.current) { clearTimeout(postTurnHistorySyncTimerRef.current); postTurnHistorySyncTimerRef.current = null; }
    setIsRunning(false);
  }, [clearStreamWatchdog, resetDirectSnapshotCursor, resetLiveThinkingTimeline]);

  // Resolve exec approval
  const resolveApproval = useCallback(async (
    approvalId: string,
    decision: 'allow-once' | 'deny' | 'allow-always',
  ) => {
    try {
      const response = await client.post('/gateway/exec-approval/resolve', { approvalId, decision });
      if (response.data?.ok) {
        setPendingApprovals((prev) => removeExecApproval(prev, approvalId));
        setStatusText(decision === 'deny' ? '\u274c Command denied' : '\u2705 Command approved');
        setTimeout(() => setStatusText(null), 2000);
        return;
      }
      setStatusText('\u26a0\ufe0f Approval did not complete');
      setTimeout(() => setStatusText(null), 3000);
      throw new Error('Approval did not complete');
    } catch (err: any) {
      console.error('[ChatState] Failed to resolve approval:', err);
      setStatusText(`\u26a0\ufe0f Approval failed${err?.response?.data?.error ? `: ${err.response.data.error}` : ''}`);
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

  const clearQueue = useCallback(() => {
    messageQueueRef.current = [];
    setMessageQueue([]);
    setMessages(prev => prev.filter(m => !m.queued));
  }, []);

  const removeQueuedMessage = useCallback((id: string) => {
    messageQueueRef.current = messageQueueRef.current.filter(item => item.id !== id);
    setMessageQueue(prev => {
      const next = prev.filter(item => item.id !== id);
      messageQueueRef.current = next;
      return next;
    });
    setMessages(prev => prev.filter(m => m.id !== id));
  }, []);

  const waitForDirectGatewayClient = useCallback(async (timeoutMs = 7000) => {
    const existing = directClientRef.current;
    if (existing?.isConnected) return existing;

    setDirectGatewayDemanded(true);
    const deadline = Date.now() + Math.max(timeoutMs, 0);
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const candidate = directClientRef.current;
      if (candidate?.isConnected) return candidate;
    }
    return directClientRef.current?.isConnected ? directClientRef.current : null;
  }, []);

  // Send message via WS (with SSE fallback)
  const sendMessage = useCallback(async (text: string) => {
    const normalized = String(text || '').trim();
    if (!normalized) return;

    let shouldAnswerPendingQuestion = providerRef.current === 'OPENCLAW' && isStreamActiveRef.current;
    let expectedActiveRunId = shouldAnswerPendingQuestion
      ? normalizeRunId(currentRunIdRef.current)
      : null;

    // Local stream recovery can briefly lag the server. Probe before a normal
    // send so text can never interrupt a run that is still waiting on input.
    if (
      providerRef.current === 'OPENCLAW'
      && (!shouldAnswerPendingQuestion || !expectedActiveRunId)
    ) {
      try {
        const probeSession = resolveOpenClawSessionKey(sessionRef.current || 'main') || 'main';
        const { data } = await client.get('/gateway/stream-status', {
          params: { session: probeSession, provider: 'OPENCLAW' },
          timeout: 4000,
          _silent: true,
        } as any);
        if (data?.active) {
          debugLog('[ChatState] Pre-send probe: session still has an active turn');
          shouldAnswerPendingQuestion = true;
          expectedActiveRunId = normalizeRunId(data?.runId);
        }
      } catch {
        // Best-effort probe; a normal send proceeds when it cannot answer.
      }
    }

    if (shouldAnswerPendingQuestion) {
      const currentSession = resolveOpenClawSessionKey(sessionRef.current || 'main') || 'main';
      if (!pendingUserQuestionsReadyRef.current) {
        try {
          await refreshPendingUserQuestions();
        } catch {
          setStatusText('Portal could not verify whether this turn is waiting on a question. Retry in a moment.');
          return;
        }
      }
      const pendingRequests = pendingUserQuestionsRef.current.filter((entry) => (
        entry.sessionKey === currentSession
        && entry.state === 'pending'
        && entry.expiresAt > Date.now()
      ));
      if (pendingRequests.length === 0) {
        let existingSteer = pendingActiveSteerRef.current;
        if (existingSteer && existingSteer.sessionKey !== currentSession) {
          pendingActiveSteerRef.current = null;
          existingSteer = null;
        }
        if (existingSteer?.inFlight) return;
        if (existingSteer && existingSteer.text !== normalized) {
          setStatusText('The previous steering message has an unknown outcome. Retry it unchanged.');
          return;
        }
        if (!existingSteer && !expectedActiveRunId) {
          setStatusText('Portal could not identify the exact active run. Retry in a moment.');
          return;
        }
        const steer = existingSteer || {
          requestId: nextId(),
          sessionKey: currentSession,
          expectedRunId: expectedActiveRunId!,
          text: normalized,
          inFlight: false,
        };
        steer.inFlight = true;
        pendingActiveSteerRef.current = steer;
        try {
          const { data } = await client.post('/gateway/session-steer', {
            session: currentSession,
            expectedRunId: steer.expectedRunId,
            message: normalized,
            requestId: steer.requestId,
          });
          if (
            data?.ok !== true
            || data?.sessionKey !== currentSession
            || data?.requestId !== steer.requestId
            || data?.runId !== steer.expectedRunId
            || data?.interruptedActiveRun !== false
          ) {
            throw new Error('Portal did not confirm steering for this exact active run.');
          }
          pendingActiveSteerRef.current = null;
          if (
            providerRef.current === 'OPENCLAW'
            && resolveOpenClawSessionKey(sessionRef.current || 'main') === currentSession
          ) {
            appendLocalMessage({
              id: `active-steer:${steer.requestId}`,
              role: 'user',
              content: normalized,
              createdAt: new Date(),
            });
            setStatusText(null);
          }
        } catch (error: any) {
          steer.inFlight = false;
          pendingActiveSteerRef.current = steer;
          setStatusText(
            error?.response?.data?.error
              || error?.message
              || 'Steering delivery is unconfirmed. Retry the same text.',
          );
          if ([400, 404, 409].includes(Number(error?.response?.status))) {
            pendingActiveSteerRef.current = null;
          }
        }
        return;
      }
      if (pendingRequests.length !== 1) {
        setStatusText('More than one question is waiting. Use the inline cards so each answer reaches the correct prompt.');
        return;
      }
      const request = pendingRequests[0];
      if (request.questions.length !== 1) {
        setStatusText('This prompt needs more than one answer. Use its inline card so every field is preserved.');
        return;
      }
      const question = request.questions[0];
      if (question.isSecret === true) {
        setStatusText('This prompt expects a secret. Use its protected inline field instead of the chat composer.');
        return;
      }
      if (question.options.length > 0 && question.isOther !== true) {
        setStatusText('This prompt accepts only its listed choices. Use the inline card to select one.');
        return;
      }
      let existing = pendingQuestionComposerAnswerRef.current;
      if (existing && existing.id !== request.id) {
        pendingQuestionComposerAnswerRef.current = null;
        existing = null;
      }
      if (existing?.inFlight) return;
      if (existing && existing.text !== normalized) {
        setStatusText(
          'The previous answer has an unknown outcome. Retry it unchanged or use the inline question card.',
        );
        return;
      }
      const pending = existing || {
        id: request.id,
        text: normalized,
        inFlight: false,
      };
      pending.inFlight = true;
      pendingQuestionComposerAnswerRef.current = pending;
      try {
        const answers = Object.create(null) as Record<string, string>;
        answers[question.id] = normalized;
        const receipt = await gatewayAPI.answerQuestion(request.id, answers);
        if (receipt?.ok !== true || receipt?.id !== request.id || receipt?.state !== 'answered') {
          throw new Error('Portal did not confirm this exact answer.');
        }
        if (
          providerRef.current !== 'OPENCLAW'
          || resolveOpenClawSessionKey(sessionRef.current || 'main') !== currentSession
          || !pendingUserQuestionsRef.current.some((entry) => entry.id === request.id)
        ) {
          throw new Error('The active question changed before the answer was confirmed.');
        }
        pendingQuestionComposerAnswerRef.current = null;
        settlePendingUserQuestion(request.id);
        appendLocalMessage({
          id: `ask-user-answer:${request.id}`,
          role: 'user',
          content: normalized,
          createdAt: new Date(),
        });
        setStatusText(null);
      } catch (error: any) {
        if (isAskUserQuestionNoLongerOpenError(error)) {
          pendingQuestionComposerAnswerRef.current = null;
          settlePendingUserQuestion(request.id);
          setStatusText(null);
          void refreshPendingUserQuestions().catch(() => undefined);
          return;
        }
        pending.inFlight = false;
        pendingQuestionComposerAnswerRef.current = pending;
        setStatusText(
          error?.response?.data?.error
            || error?.message
            || 'Answer delivery is unconfirmed. Retry the same text or use the inline card.',
        );
        if ([404, 409].includes(Number(error?.response?.status))) {
          pendingQuestionComposerAnswerRef.current = null;
          void refreshPendingUserQuestions().catch(() => undefined);
        }
      }
      return;
    }

    const shouldQueue = isStreamActiveRef.current || (!isQueueDrainActiveRef.current && messageQueueRef.current.length > 0);
    if (shouldQueue) {
      const queuedId = nextId();
      const queuedAt = Date.now();
      appendLocalMessage({
        id: queuedId,
        role: 'user',
        content: normalized,
        createdAt: new Date(queuedAt),
        queued: true,
      });
      const queuedItem = { id: queuedId, text: normalized, createdAt: queuedAt };
      messageQueueRef.current = [...messageQueueRef.current, queuedItem];
      setMessageQueue(prev => {
        const next = [...prev, queuedItem];
        messageQueueRef.current = next;
        return next;
      });
      return;
    }

    pendingQuestionComposerAnswerRef.current = null;
    pendingActiveSteerRef.current = null;
    pendingUserQuestionsReadyRef.current = false;
    replacePendingUserQuestions([]);

    // Fence every history/stream-status observation that began before this
    // accepted local turn. A delayed inactive R1 snapshot must never clear R2.
    localTurnEpochRef.current += 1;

    // Each accepted user turn starts a fresh backend runtime sequence. This is
    // required for native providers as well as OpenClaw: some continuations do
    // not publish a separate run_resumed control frame before seq=1 arrives.
    portalTurnSequenceRef.current = null;
    portalTurnSequenceScopeRef.current = `${providerRef.current}:${sessionRef.current || 'main'}`;
    reasoningSequenceRef.current = { runId: null, seq: null };
    runtimeReplaySequenceRef.current = { runId: null, seq: null };

    // Add user message to UI
    const userMsg: ChatMessage = {
      id: nextId(),
      role: 'user',
      content: normalized,
      createdAt: new Date(),
      pendingAck: true,
    };
    appendLocalMessage(userMsg);

    clearPostTurnHistorySync();
    clearPendingTextRender();

    // Reset streaming state
    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = 0;
    resetDirectSnapshotCursor();
    toolCounterRef.current = 0;
    streamActivityOrderRef.current = 0;
    hasRealToolEventsRef.current = false;
    activeStreamToolCallsRef.current = [];
    resetLiveThinkingTimeline();
    setStatusText(null);
    setStreamingPhase('thinking');
    setActiveToolName(null);

    // Add placeholder assistant message
    const assistantId = nextId();
    streamingAssistantIdRef.current = assistantId;
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: new Date(),
    };
    appendLocalMessage(assistantMsg);
    outstandingChatDispatchRef.current = {
      clientMessageId: userMsg.id,
      assistantId,
      sessionKey: resolveOpenClawSessionKey(sessionRef.current || 'main') || 'main',
    };
    setIsRunning(true);
    setSessionAvailability('present');
    isStreamActiveRef.current = true;
    resetStreamWatchdog();

    let directClient = directClientRef.current;
    if (useDirectGateway && providerRef.current === 'OPENCLAW') {
      setDirectGatewayDemanded(true);
      if (!directClient?.isConnected) {
        setStatusText('Connecting directly to OpenClaw…');
        directClient = await waitForDirectGatewayClient(7000);
      }
    }

    // For OPENCLAW with direct gateway enabled, use the direct client.
    // Wait briefly on the first user-initiated run so direct mode does not
    // silently route the initial message through the portal WS fallback.
    if (useDirectGateway && providerRef.current === 'OPENCLAW' && directClient?.isConnected) {
      const currentSession = resolveOpenClawSessionKey(sessionRef.current || 'main');
      try {
        streamTransportRef.current = 'direct';
        if (currentSession !== sessionRef.current) {
          sessionRef.current = currentSession;
          setSessionRaw(currentSession);
          persistStoredSession(providerRef.current, currentSession, agentIdRef.current);
        }
        debugLog('[ChatState] Sending via direct gateway to session:', currentSession);
        const runId = await directClient.sendMessage(currentSession, normalized, userMsg.id);
        currentRunIdRef.current = runId;
        if (outstandingChatDispatchRef.current?.clientMessageId === userMsg.id) {
          outstandingChatDispatchRef.current = null;
        }
        debugLog('[ChatState] Direct send initiated, runId:', runId || '(pending)');
        // Events will come through handleDirectGatewayEvent
      } catch (err: any) {
        console.error('[ChatState] Direct gateway send failed:', err);
        const unconfirmedSend = gatewayUnconfirmedSendFromError(err, {
          clientMessageId: userMsg.id,
          sessionKey: currentSession,
        });
        if (unconfirmedSend) {
          // The frame may already be running upstream; do not turn an absent
          // ACK into a false terminal error or queue a duplicate retry. The
          // backend keeps the exact idempotency reservation fenced while the
          // Portal bus discovers/adopts the correlated replacement run.
          directClient.setActiveStreamSession(currentSession);
          streamTransportRef.current = 'portal';
          isStreamActiveRef.current = true;
          setIsRunning(true);
          setStreamingPhase('thinking');
          markStreamRecovery('The send was accepted or interrupted; reconnecting to verify the active turn…');
          const manager = wsManagerRef.current;
          const reconnectSent = manager?.isConnected()
            ? manager.send({
                type: 'reconnect',
                session: currentSession,
                provider: 'OPENCLAW',
                streamClientId: streamClientIdRef.current,
              })
            : false;
          if (!reconnectSent) manager?.reconnect();
          void loadHistoryInternalRef.current?.(currentSession, 'OPENCLAW', {
            force: true,
            refreshActiveSnapshot: true,
            preserveLocalMessages: true,
          });
          return;
        }
        const directConflict = gatewayActiveTurnConflictFromError(err, {
          clientMessageId: userMsg.id,
          sessionKey: currentSession,
        });
        if (directConflict && handleActiveTurnConflict(directConflict)) {
          const activeStream = directConflict.activeStream;
          if (activeStream?.active === true) {
            applyOpenClawActiveStreamSnapshot(activeStream, {
              statusTextWhenNoTool: 'Reconnecting to stream…',
              source: 'portal',
            });
          } else if (
            activeStream?.safeToClear === true
            || activeStream?.inactiveReason === 'terminal'
            || activeStream?.inactiveReason === 'stale'
          ) {
            preserveLiveTurnThenClear({ terminal: true });
            schedulePostTurnHistorySync(250);
            return;
          } else {
            directClient.setActiveStreamSession(currentSession);
            markStreamRecovery('Reconnecting to the active turn…');
          }

          // TURN_ACTIVE means the direct write did not start this optimistic
          // turn. Hand ownership to the Portal's exact run-reconciliation path
          // and attach its bus lane instead of rendering a terminal send error.
          const manager = wsManagerRef.current;
          const reconnectSent = manager?.isConnected()
            ? manager.send({
                type: 'reconnect',
                session: currentSession,
                provider: 'OPENCLAW',
                streamClientId: streamClientIdRef.current,
              })
            : false;
          if (!reconnectSent) manager?.reconnect();
          void loadHistoryInternalRef.current?.(currentSession, 'OPENCLAW', {
            force: true,
            refreshActiveSnapshot: true,
            preserveLocalMessages: true,
          });
          return;
        }
        if (outstandingChatDispatchRef.current?.clientMessageId === userMsg.id) {
          outstandingChatDispatchRef.current = null;
        }
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: '⚠️ ' + normalizeAgentError(err, 'Send failed') } : m
        ));
        setIsRunning(false);
        setStreamingPhase('idle');
        isStreamActiveRef.current = false;
        streamTransportRef.current = null;
        streamingAssistantIdRef.current = null;
      }
      return;
    }

    // Send via WS (portal middleman path for non-OPENCLAW or when direct gateway unavailable)
    const manager = wsManagerRef.current;
    if (manager && manager.isConnected()) {
      streamTransportRef.current = 'portal';
      const payload: Record<string, unknown> = {
        type: 'send',
        message: normalized,
        clientMessageId: userMsg.id,
        session: resolveOpenClawSessionKey(sessionRef.current || 'main') || 'main',
      };
      if (providerRef.current) payload.provider = providerRef.current;
      if (modelRef.current) payload.model = modelRef.current;
      if (agentIdRef.current) payload.agentId = agentIdRef.current;
      const sent = manager.send(payload);
      if (!sent) {
        try {
          await sendViaSSERef.current(normalized, assistantId);
        } catch (err: any) {
          if (outstandingChatDispatchRef.current?.clientMessageId === userMsg.id) {
            outstandingChatDispatchRef.current = null;
          }
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, content: '⚠️ ' + normalizeAgentError(err, 'Send failed') } : m
          ));
          setIsRunning(false);
          setStreamingPhase('idle');
          isStreamActiveRef.current = false;
          streamTransportRef.current = null;
          streamingAssistantIdRef.current = null;
        }
      }
    } else {
      // SSE fallback
      try {
        streamTransportRef.current = 'portal';
        await sendViaSSERef.current(normalized, assistantId);
      } catch (err: any) {
        if (outstandingChatDispatchRef.current?.clientMessageId === userMsg.id) {
          outstandingChatDispatchRef.current = null;
        }
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: '⚠️ ' + normalizeAgentError(err, 'Send failed') } : m
        ));
        setIsRunning(false);
        setStreamingPhase('idle');
        isStreamActiveRef.current = false;
        streamTransportRef.current = null;
        streamingAssistantIdRef.current = null;
      }
    }
  }, [appendLocalMessage, applyOpenClawActiveStreamSnapshot, clearPendingTextRender, clearPostTurnHistorySync, handleActiveTurnConflict, markStreamRecovery, normalizeAgentError, preserveLiveTurnThenClear, refreshPendingUserQuestions, replacePendingUserQuestions, resetDirectSnapshotCursor, resetLiveThinkingTimeline, resetStreamWatchdog, resolveOpenClawSessionKey, schedulePostTurnHistorySync, settlePendingUserQuestion, useDirectGateway, waitForDirectGatewayClient]);

  const drainNextQueuedMessage = useCallback(() => {
    if (isStreamActiveRef.current || isQueueDrainActiveRef.current) return;
    const next = messageQueueRef.current[0];
    if (!next) return;

    isQueueDrainActiveRef.current = true;
    messageQueueRef.current = messageQueueRef.current.filter(item => item.id !== next.id);
    setMessageQueue(prev => {
      const remaining = prev.filter(item => item.id !== next.id);
      messageQueueRef.current = remaining;
      return remaining;
    });
    removeLocalMessageById(next.id);
    void sendMessage(next.text).finally(() => {
      isQueueDrainActiveRef.current = false;
      if (!isStreamActiveRef.current && messageQueueRef.current.length > 0) {
        scheduleLatestCallback(drainNextQueuedMessageRef);
      }
    });
  }, [removeLocalMessageById, sendMessage]);
  drainNextQueuedMessageRef.current = drainNextQueuedMessage;

  // SSE fallback sender
  const sendViaSSE = useCallback(async (text: string, initialAssistantId: string) => {
    let assembled = '';
    let assistantId = initialAssistantId;
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const activeSse: ActiveSseTransport = {
      controller: new AbortController(),
      settled,
      resolveSettled,
      streamClientId: streamClientIdRef.current,
      reader: null,
      sessionResolved: false,
      handoffRequested: false,
      handoffPromise: null,
      stopReason: null,
      stopPromise: null,
    };
    activeSseTransportRef.current = activeSse;
    streamTransportRef.current = 'sse';

    try {
      const apiUrl = import.meta.env.VITE_API_URL || '';
      const body: Record<string, unknown> = {
        message: text,
        session: resolveOpenClawSessionKey(sessionRef.current || 'main') || 'main',
        streamClientId: activeSse.streamClientId,
        clientMessageId: outstandingChatDispatchRef.current?.assistantId === assistantId
          ? outstandingChatDispatchRef.current.clientMessageId
          : undefined,
      };
      if (providerRef.current) body.provider = providerRef.current;
      if (modelRef.current) body.model = modelRef.current;
      if (agentIdRef.current) body.agentId = agentIdRef.current;

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      const response = await workspaceAuthorizedFetch(apiUrl + '/gateway/send?stream=1', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(body),
        signal: activeSse.controller.signal,
      });
      if (!response.ok) {
        let errorMessage = `Gateway error: ${response.status}`;
        try {
          const responseText = await response.text();
          if (responseText) {
            const parsed = JSON.parse(responseText);
            errorMessage = parsed?.error || parsed?.detail || errorMessage;
          }
        } catch {}
        throw new Error(errorMessage);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No stream body');
      activeSse.reader = reader;

      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        if (activeSse.stopReason) break;
        const { done, value } = await reader.read();
        if (activeSse.stopReason) break;
      if (!done) { buffer += decoder.decode(value, { stream: true }); }
      else { if (buffer.trim()) buffer += '\n'; }
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const evt = JSON.parse(payload);
          if (activeSse.stopReason) continue;
          streamTransportRef.current = 'sse';
          if (evt?.type === 'active_turn_conflict') {
            if (handleActiveTurnConflict(evt)) assistantId = '';
            continue;
          }
          if (streamingAssistantIdRef.current) {
            assistantId = streamingAssistantIdRef.current;
          }
          if (
            !assistantId
            && ['text', 'thinking', 'status', 'tool_start', 'tool_update', 'tool_end', 'tool_used'].includes(evt?.type)
          ) {
            assistantId = ensureStreamingAssistantBubble({
              idPrefix: 'sse-resume',
              content: '',
            }).assistantId;
          }
          const incomingSseRunId = normalizeRunId(evt?.runId);
          if (incomingSseRunId) {
            const epochDecision = reconcileIncomingRunEpoch(incomingSseRunId, {
              continuationVerified: evt?.type === 'run_resumed',
            });
            if (epochDecision === 'reject') continue;
          }
          recordRuntimeReplaySequence(evt);
          recordReasoningTurnSequence(evt);
          if (SSE_LIVE_EVENT_TYPES.has(evt.type)) {
            const visibleSseActivity = (
              evt.type === 'text'
              && typeof evt.content === 'string'
              && Boolean(sanitizeAssistantChunk(evt.content))
              && !isControlOrMaintenanceAssistantContent(evt.content)
            ) || (
              evt.type === 'thinking'
              && Boolean(extractThinkingChunk('thinking', evt.content, assembled.length > 0))
            );
            resetStreamWatchdog({ visible: visibleSseActivity });
          }
          if (evt.type === 'session') {
            if (evt.sessionId) {
              sessionRef.current = evt.sessionId;
              setSessionAvailability('present');
              setSessionRaw(evt.sessionId);
              persistStoredSession(providerRef.current, evt.sessionId, agentIdRef.current);
              activeSse.sessionResolved = true;
            }
            if (evt.provenance) setLastProvenance(evt.provenance);
            if (activeSse.sessionResolved && activeSse.handoffRequested) {
              void handoffActiveSseToPortalRef.current(wsManagerRef.current);
            }
          } else if (evt.type === 'text') {
            const rawChunk = typeof evt.content === 'string' ? evt.content : '';
            if (rawChunk && isControlOrMaintenanceAssistantContent(rawChunk)) {
              continue;
            }
            const chunk = typeof evt.content === 'string'
              ? (evt.replace === true ? sanitizeAssistantContent(evt.content) : sanitizeAssistantChunk(evt.content))
              : '';
            graduateLiveThinkingSegment();
            assembled = mergeAssistantStream(assembled, chunk, { replace: evt.replace === true });
            assembledRef.current = assembled;
            setStreamingPhase('streaming');
            setStatusText(null);
            setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: assembled } : m));
          } else if (evt.type === 'status') {
            const maintenanceRail = resolveMaintenanceRailStatus(evt);
            if (maintenanceRail.update) applyCompactionState(maintenanceRail.update);
            const runningToolName = getRunningToolName();
            if (evt.transient === true && !maintenanceRail.isMaintenanceStatus) {
              setLiveRunPhase('thinking', typeof evt.content === 'string' ? evt.content : null);
              resetStreamWatchdog({ visible: true });
            } else if (!maintenanceRail.isMaintenanceStatus && !runningToolName && evt.preambleProgress === true) {
              const preambleThinking = extractThinkingChunk('thinking', evt.content, assembled.length > 0);
              if (preambleThinking && assembledRef.current.trim()) {
                graduateLiveTextSegment(assistantId);
                assembled = '';
              }
              appendThinkingChunk(assistantId, preambleThinking, {
                replace: evt.replace === true,
                lane: 'preamble',
              });
              if (preambleThinking) resetStreamWatchdog({ visible: true });
              setStatusText(sanitizeThinkingSubject(evt.content) || null);
              setStreamingPhase('thinking');
            } else if (!maintenanceRail.isMaintenanceStatus && !runningToolName) {
              const thinkingChunk = extractThinkingChunk(
                'status',
                evt.content,
                evt?.turnEvent?.visible === true ? false : assembled.length > 0,
              );
              if (thinkingChunk && assembledRef.current.trim()) {
                graduateLiveTextSegment(assistantId);
                assembled = '';
              }
              appendThinkingChunk(assistantId, thinkingChunk, { replace: evt.replace === true, lane: 'status' });
              if (thinkingChunk) resetStreamWatchdog({ visible: true });
            }
            if (evt.transient !== true && (!assembled || runningToolName)) {
              setLiveRunPhase('thinking', maintenanceRail.displayStatusText);
            }
          } else if (evt.type === 'thinking') {
            applyThinkingSubject(assistantId, evt.subject);
            const thinkingChunk = extractThinkingChunk('thinking', evt.content, assembled.length > 0);
            if (thinkingChunk && assembledRef.current.trim()) {
              graduateLiveTextSegment(assistantId);
              assembled = '';
            }
            appendThinkingChunk(assistantId, thinkingChunk, { replace: evt.replace === true, lane: 'raw' });
            if (!assembled || getRunningToolName()) {
              setLiveRunPhase('thinking', null);
            }
          } else if (evt.type === 'compaction_start') {
            applyCompactionState({
              phase: 'start',
              content: typeof evt.content === 'string' ? evt.content : null,
              maintenanceKind: 'compaction',
            });
            if (!assembled) setStreamingPhase(prev => prev === 'idle' ? 'thinking' : prev);
          } else if (evt.type === 'compaction_end') {
            applyCompactionState({
              phase: 'end',
              content: typeof evt.content === 'string' ? evt.content : null,
              completed: evt.completed !== false,
              maintenanceKind: evt.completed === false ? 'maintenance' : 'compaction',
            });
          } else if (evt.type === 'stream_resume') {
            applyOpenClawActiveStreamSnapshot({ ...evt, active: true }, { statusTextWhenNoTool: 'Reconnecting to stream…', source: 'sse' });
            // The snapshot hydrator owns the authoritative cumulative text.
            // Keep this transport-local cursor in lockstep or the next append
            // delta will rebuild from the pre-reconnect value and erase the
            // resumed prefix.
            assembled = assembledRef.current;
            assistantId = streamingAssistantIdRef.current || assistantId;
          } else if (evt.type === 'run_resumed') {
            isStreamActiveRef.current = true;
            setIsRunning(true);
            setLiveRunPhase(assembled ? 'streaming' : 'thinking', null);
            resetStreamWatchdog();
          } else if (evt.type === 'tool_start') {
            hasRealToolEventsRef.current = true;
            graduateLiveThinkingSegment();
            if (assembled && assembled.trim().length > 0) {
              graduateLiveTextSegment(assistantId);
              assembled = '';
              assembledRef.current = '';
            }
            const toolName = resolveToolName(evt.toolName, evt.content, 'tool');
            const toolId = typeof evt.toolCallId === 'string' && evt.toolCallId.trim()
              ? evt.toolCallId.trim()
              : 'tool-' + (++toolCounterRef.current);
            const toolOrder = streamActivityOrderRef.current++;
            setStatusText(getCurrentToolStatusText(toolName));
            setStreamingPhase('tool');
            setActiveToolName(toolName);
            setMessages(prev => prev.map(m => {
              if (m.id !== assistantId) return m;
              const nextToolCalls = [
                ...(m.toolCalls || []),
                {
                  id: toolId,
                  name: toolName,
                  arguments: (evt as any).toolArgs,
                  startedAt: Date.now(),
                  status: 'running' as const,
                  order: toolOrder,
                },
              ];
              activeStreamToolCallsRef.current = nextToolCalls;
              return { ...m, toolCalls: nextToolCalls };
            }));
          } else if (evt.type === 'tool_used') {
            const toolName = resolveToolName(evt.toolName, evt.content, 'tool');
            if (!hasRealToolEventsRef.current && !isMessageToolName(toolName)) {
              const stableToolCallId = resolveCompatibilityToolReplayIdentity(
                evt,
                sessionRef.current,
              );
              if (
                stableToolCallId
                && (
                  compatibilityToolReplayIdsRef.current.has(stableToolCallId)
                  || activeStreamToolCallsRef.current.some((tool) => tool.id === stableToolCallId)
                )
              ) continue;
              if (stableToolCallId) compatibilityToolReplayIdsRef.current.add(stableToolCallId);
              graduateLiveThinkingSegment();
              if (assembled && assembled.trim().length > 0) {
                graduateLiveTextSegment(assistantId);
                assembled = '';
                assembledRef.current = '';
              }
              const now = Date.now();
              const toolOrder = streamActivityOrderRef.current++;
              setMessages(prev => {
                const toolId = stableToolCallId || 'tool-' + (++toolCounterRef.current);
                const projection = appendCompletedToolCallIfMissing(prev, assistantId, {
                  ...buildCompletedToolCall({
                    id: toolId,
                    name: toolName,
                    startedAt: now - 1000,
                    endedAt: now,
                  }),
                  order: toolOrder,
                }, {
                  now,
                  ...(stableToolCallId ? { stableToolCallId } : {}),
                });
                if (projection.changed) activeStreamToolCallsRef.current = projection.toolCalls as ToolCall[];
                return projection.messages as ChatMessage[];
              });
              setStreamingPhase(assembled ? 'streaming' : 'thinking');
              setActiveToolName(null);
              setStatusText(null);
            }
          } else if (evt.type === 'tool_update') {
            const toolResult = typeof (evt as any).toolResult === 'string'
              ? (evt as any).toolResult
              : (typeof evt.content === 'string' ? evt.content : '');
            const toolName = resolveToolName((evt as any).toolName, evt.content, 'tool');
            setStreamingPhase('tool');
            setActiveToolName(toolName);
            setStatusText(getCurrentToolStatusText(toolName));
            setMessages(prev => {
              const projection = updateRunningToolCallInMessage(prev, assistantId, {
                toolCallId: (evt as any).toolCallId,
                toolName,
                result: toolResult,
              });
              if (projection.changed) activeStreamToolCallsRef.current = projection.toolCalls as ToolCall[];
              return projection.messages as ChatMessage[];
            });
          } else if (evt.type === 'tool_end') {
            const toolResult = typeof (evt as any).toolResult === 'string'
              ? (evt as any).toolResult
              : (typeof evt.content === 'string' ? evt.content : 'Completed');
            const toolName = resolveToolName((evt as any).toolName, evt.content, 'tool');
            let nextRunningToolName: string | null = null;
            setMessages(prev => {
              const projection = finishMatchingToolCallInMessage(prev, assistantId, {
                toolCallId: typeof evt.toolCallId === 'string' ? evt.toolCallId : undefined,
                toolName,
                result: toolResult,
                status: resolveToolCompletionStatus(evt),
              });
              nextRunningToolName = projection.nextRunningToolName
                ? resolveToolName(projection.nextRunningToolName)
                : null;
              activeStreamToolCallsRef.current = projection.toolCalls as ToolCall[];
              return projection.messages as ChatMessage[];
            });
            if (nextRunningToolName) {
              setStreamingPhase('tool');
              setActiveToolName(nextRunningToolName);
              setStatusText(getCurrentToolStatusText(nextRunningToolName));
            } else {
              setStreamingPhase(assembled ? 'streaming' : 'thinking');
              setActiveToolName(null);
              setStatusText(null);
            }
          } else if (evt.type === 'segment_break') {
            // Don't create a new bubble — keep all text in a single streaming message.
          } else if (evt.type === 'stream_ended') {
            outstandingChatDispatchRef.current = null;
            lastTerminalRunIdRef.current = incomingSseRunId || currentRunIdRef.current;
            preserveLiveTurnThenClear({ terminal: true });
            assembled = '';
            if (providerRef.current === 'OPENCLAW') {
              void loadHistoryInternalRef.current?.(sessionRef.current || 'main', providerRef.current, { force: true, refreshActiveSnapshot: true });
            }
          } else if (evt.type === 'done') {
            outstandingChatDispatchRef.current = null;
            if (isAbortedDoneEvent(evt)) {
              assembled = '';
              settleCancelledTurn(incomingSseRunId);
              continue;
            }
            clearStreamWatchdog();
            clearPendingTextRender();
            lastTerminalRunIdRef.current = incomingSseRunId || currentRunIdRef.current;
            const rawFinal = typeof evt.content === 'string' ? evt.content : '';
            const hasFinal = rawFinal.length > 0 && !isControlOrMaintenanceAssistantContent(rawFinal);
            const finalContent = hasFinal ? sanitizeAssistantContent(rawFinal) : (assembled || '');
            assembled = finalContent;
            assembledRef.current = finalContent;
            const prov = evt.provenance || null;
            const currentStreamSegs = [...streamSegmentsRef.current];
            const finalStreamSegs = thinkingContentRef.current.trim() || thinkingSubjectRef.current
              ? [...currentStreamSegs, {
                  text: thinkingContentRef.current,
                  ...(thinkingSubjectRef.current ? { subject: thinkingSubjectRef.current } : {}),
                  ts: Date.now(),
                  kind: 'thinking' as const,
                  order: streamActivityOrderRef.current++,
                  ...(reasoningLaneRef.current ? { lane: reasoningLaneRef.current } : {}),
                }]
              : currentStreamSegs;
            const graduatedSegments = finalStreamSegs.length > 0 || hasRealToolEventsRef.current
              ? buildGraduatedSegments(finalStreamSegs, finalContent)
              : [];
            setMessages(prev => prev.map(m => {
              if (m.id !== assistantId) return m;
              const update: Partial<ChatMessage> = { content: finalContent, provenance: prov || undefined };
              if (graduatedSegments.length > 0) {
                update.segments = graduatedSegments;
              }
              return { ...m, ...update };
            }));
            setStreamingPhase('idle');
            setActiveToolName(null);
            setIsRunning(false);
            resetLiveThinkingTimeline();
            setLastProvenance(prov);
            isStreamActiveRef.current = false;
            streamTransportRef.current = null;
            streamingAssistantIdRef.current = null;
            activeStreamToolCallsRef.current = [];
            currentRunIdRef.current = null;
            directClientRef.current?.setActiveStreamSession(null);
            assembled = '';
            assembledRef.current = '';
            if (providerUsesPortalStreamBus(providerRef.current)) {
              schedulePostTurnHistorySync(450, 2500);
            }
          } else if (evt.type === 'error') {
            outstandingChatDispatchRef.current = null;
            clearStreamWatchdog();
            if (compactionTimerRef.current) {
              clearTimeout(compactionTimerRef.current);
              compactionTimerRef.current = null;
            }
            setMessages(prev => prev.map(m =>
              m.id === assistantId ? { ...m, content: '⚠️ ' + normalizeAgentError(evt.content, 'Error') } : m
            ));
            setStatusText(null);
            setStreamingPhase('idle');
            setActiveToolName(null);
            activeStreamToolCallsRef.current = [];
            compactionPhaseRef.current = 'idle';
            setCompactionPhase('idle');
            setIsRunning(false);
            currentRunIdRef.current = null;
            isStreamActiveRef.current = false;
            streamTransportRef.current = null;
            streamingAssistantIdRef.current = null;
            directClientRef.current?.setActiveStreamSession(null);
            assembled = '';
            assembledRef.current = '';
            resetLiveThinkingTimeline();
          } else if (evt.type === 'exec_approval') {
            if (evt.approval?.id) {
              setPendingApprovals((prev) => upsertExecApproval(prev, evt.approval));
              setStatusText('\u23f3 Waiting for command approval\u2026');
            }
          }
        } catch { /* ignore parse errors */ }
      }
      if (done) break;
      }
    } catch (error) {
      if (activeSse.controller.signal.aborted && activeSse.stopReason) {
        debugLog('[ChatState] SSE transport stopped intentionally', { reason: activeSse.stopReason });
        return;
      }
      throw error;
    } finally {
      activeSse.reader = null;
      if (activeSseTransportRef.current === activeSse) {
        activeSseTransportRef.current = null;
      }
      activeSse.resolveSettled();
    }
  }, [appendThinkingChunk, applyThinkingSubject, applyCompactionState, applyOpenClawActiveStreamSnapshot, buildGraduatedSegments, clearPendingTextRender, clearStreamWatchdog, ensureStreamingAssistantBubble, getCurrentToolStatusText, getRunningToolName, graduateLiveTextSegment, graduateLiveThinkingSegment, handleActiveTurnConflict, normalizeAgentError, preserveLiveTurnThenClear, reconcileIncomingRunEpoch, recordReasoningTurnSequence, recordRuntimeReplaySequence, resetLiveThinkingTimeline, resetStreamWatchdog, resolveOpenClawSessionKey, schedulePostTurnHistorySync, setLiveRunPhase, settleCancelledTurn]);
  sendViaSSERef.current = sendViaSSE;

  stopActiveSseTransportRef.current = async (reason) => {
    const activeSse = activeSseTransportRef.current;
    if (!activeSse) return false;
    if (!activeSse.stopReason) activeSse.stopReason = reason;
    if (!activeSse.stopPromise) {
      activeSse.stopPromise = (async () => {
        activeSse.controller.abort();
        const reader = activeSse.reader;
        if (reader) await reader.cancel().catch(() => undefined);
        await activeSse.settled;
      })();
    }
    await activeSse.stopPromise;
    return true;
  };

  handoffActiveSseToPortalRef.current = async (manager) => {
    const activeSse = activeSseTransportRef.current;
    if (!activeSse || !activeSse.handoffRequested || !activeSse.sessionResolved || !manager?.isConnected()) {
      return false;
    }
    if (activeSse.handoffPromise) return activeSse.handoffPromise;

    const resolvedSession = sessionRef.current;
    const currentProvider = providerRef.current;
    const streamClientId = activeSse.streamClientId;
    activeSse.handoffPromise = (async () => {
      const stopped = await stopActiveSseTransportRef.current('handoff');
      if (!stopped || !isStreamActiveRef.current) return false;

      streamTransportRef.current = 'portal';
      const reconnected = manager.send({
        type: 'reconnect',
        session: resolvedSession,
        provider: currentProvider,
        streamClientId,
      });
      if (!reconnected) {
        manager.reconnect();
        markStreamRecoveryRef.current?.('Reconnecting to stream…');
        return false;
      }
      resetStreamWatchdogRef.current();
      return true;
    })();
    return activeSse.handoffPromise;
  };

  // Drain queued FYI messages after the current stream ends.
  // isRunning is in the dep array so this re-evaluates when the stream completes
  // (isStreamActiveRef is a ref — mutations don't trigger effects on their own).
  useEffect(() => {
    if (isRunning) return;
    drainNextQueuedMessage();
  }, [drainNextQueuedMessage, isRunning, messageQueue]);


  const injectNote = useCallback(async (text: string, sessionKey?: string) => {
    const note = String(text || '').trim();
    if (!note) return;

    const targetSession = sessionKey || sessionRef.current;
    const directClient = directClientRef.current;
    if (useDirectGateway && providerRef.current === 'OPENCLAW' && directClient?.isConnected) {
      await directClient.injectMessage(targetSession, note);
      return;
    }

    const manager = wsManagerRef.current;
    if (manager && manager.isConnected()) {
      const sent = manager.send({ type: 'inject', session: targetSession, text: note });
      if (sent) return;
    }

    await client.post('/gateway/chat/inject', { session: targetSession, text: note });
  }, [useDirectGateway]);

  // Cancel stream
  const cancelStream = useCallback((): Promise<void> => {
    if (cancelStreamPromiseRef.current) return cancelStreamPromiseRef.current;

    const attempt = (async () => {
      const currentSession = sessionRef.current;
      const currentProvider = providerRef.current;
      const runId = currentRunIdRef.current;
      const transport = streamTransportRef.current;
      let confirmed = false;

      try {
        const directClient = directClientRef.current;
        if (transport === 'direct' && useDirectGateway && currentProvider === 'OPENCLAW' && directClient?.isConnected) {
          debugLog('[ChatState] Aborting via direct gateway, session:', currentSession, 'runId:', runId);
          confirmed = await directClient.abortRun(currentSession, runId || undefined);
        } else if (transport === 'sse') {
          const { data } = await client.post('/gateway/chat/abort', {
            session: currentSession,
            provider: currentProvider,
            ...(runId ? { runId } : {}),
          });
          confirmed = data?.ok === true;
        } else {
          const manager = wsManagerRef.current;
          if (manager?.isConnected()) {
            confirmed = await requestPortalWsAbort(manager, {
              type: 'abort',
              session: currentSession,
              provider: currentProvider,
              ...(runId ? { runId } : {}),
            });
          } else {
            const { data } = await client.post('/gateway/chat/abort', {
              session: currentSession,
              provider: currentProvider,
              ...(runId ? { runId } : {}),
            });
            confirmed = data?.ok === true;
          }
        }
      } catch (err) {
        console.error('[ChatState] Failed to cancel stream:', err);
      }

      if (!confirmed) {
        console.warn('[ChatState] Stop was not confirmed; preserving the active turn UI');
        if (isStreamActiveRef.current) {
          setStatusText('Stop was not confirmed; the agent may still be running.');
        }
        return;
      }

      if (transport === 'sse') {
        await stopActiveSseTransportRef.current('cancel');
      }
      settleCancelledTurn(runId, currentSession);
    })();

    const trackedAttempt = attempt.finally(() => {
      if (cancelStreamPromiseRef.current === trackedAttempt) {
        cancelStreamPromiseRef.current = null;
      }
    });
    cancelStreamPromiseRef.current = trackedAttempt;
    return trackedAttempt;
  }, [requestPortalWsAbort, settleCancelledTurn, useDirectGateway]);

  // Session controls: check if supported (OPENCLAW with concrete session)
  const sessionControlsSupported = provider === 'OPENCLAW' && session.startsWith('agent:');

  const beginSessionControlMutation = useCallback((
    kind: SessionControlMutationKind,
    requested: SessionControlValue | string,
    previous: SessionControlValue | string,
  ) => {
    const mutationProvider = providerRef.current;
    const mutationSession = sessionRef.current;
    if (mutationProvider !== 'OPENCLAW' || !mutationSession.startsWith('agent:')) return null;

    // A control mutation owns admission globally until its PATCH and canonical
    // readback settle. Never replace an older session's proof merely because a
    // caller changed context through another surface.
    const active = sessionControlMutationRef.current;
    if (active) return null;

    const generation = ++sessionControlGenerationRef.current;
    const snapshot = Object.freeze({
      generation,
      kind,
      provider: mutationProvider,
      session: mutationSession,
      previous,
      requested,
    }) as NonNullable<typeof sessionControlMutationRef.current>;
    sessionControlMutationRef.current = snapshot;
    setSessionControlMutation(kind);
    setSessionControlsError(null);
    setCompactionModelError(null);
    setCompactionModelLoading(kind === 'compactionModel');
    return snapshot;
  }, []);

  const isSessionControlMutationActive = useCallback(
    () => sessionControlMutationRef.current !== null,
    [],
  );

  const isCurrentSessionControlMutation = useCallback((
    snapshot: NonNullable<typeof sessionControlMutationRef.current>,
  ) => (
    sessionControlMutationRef.current === snapshot
    && sessionControlGenerationRef.current === snapshot.generation
    && providerRef.current === snapshot.provider
    && sessionRef.current === snapshot.session
  ), []);

  const finishSessionControlMutation = useCallback((
    snapshot: NonNullable<typeof sessionControlMutationRef.current>,
  ) => {
    if (sessionControlMutationRef.current !== snapshot) return;
    sessionControlMutationRef.current = null;
    setSessionControlMutation(null);
    setCompactionModelLoading(false);
  }, []);

  const applySessionControlValue = useCallback((
    kind: SessionControlMutationSnapshot['kind'],
    value: SessionControlValue,
  ) => {
    if (kind === 'thinking') {
      const next = value as ThinkingLevel;
      thinkingLevelRef.current = next;
      setThinkingLevelState(next);
      return;
    }
    if (kind === 'reasoning') {
      const next = value as ReasoningVisibility;
      reasoningVisibilityRef.current = next;
      setReasoningVisibilityState(next);
      return;
    }
    const next = Boolean(value);
    fastModeEnabledRef.current = next;
    setFastModeEnabled(next);
  }, []);

  const mutateSessionControl = useCallback(async (
    kind: SessionControlMutationSnapshot['kind'],
    requested: SessionControlValue,
    previous: SessionControlValue,
  ) => {
    const snapshot = beginSessionControlMutation(kind, requested, previous) as SessionControlMutationSnapshot | null;
    if (!snapshot) return;

    applySessionControlValue(kind, requested);
    const setting = kind === 'thinking'
      ? { thinking: requested }
      : kind === 'reasoning'
        ? { reasoning: requested }
        : { fastMode: requested };
    try {
      const patchResult = await gatewayAPI.patchSession(snapshot.session, setting, snapshot.provider);
      if (!isCurrentSessionControlMutation(snapshot)) return;
      let canonical = readSessionControlValue(patchResult, kind);
      if (canonical === undefined) {
        const fresh = await gatewayAPI.sessionInfo(snapshot.session, { silent: true });
        if (!isCurrentSessionControlMutation(snapshot)) return;
        canonical = readSessionControlValue(fresh, kind);
      }
      if (canonical === undefined) {
        throw new Error('The server did not confirm the updated session setting.');
      }
      applySessionControlValue(kind, canonical);
      setSessionControlsError(null);
    } catch (error) {
      if (!isCurrentSessionControlMutation(snapshot)) return;
      let canonical = snapshot.previous;
      try {
        const fresh = await gatewayAPI.sessionInfo(snapshot.session, { silent: true });
        if (!isCurrentSessionControlMutation(snapshot)) return;
        canonical = readSessionControlValue(fresh, kind) ?? snapshot.previous;
      } catch {
        // The optimistic value is unsafe after an ambiguous failure. Restore the
        // last confirmed value when a canonical readback is unavailable.
      }
      applySessionControlValue(kind, canonical);
      if (canonical === snapshot.requested) {
        setSessionControlsError(null);
      } else {
        const label = kind === 'thinking'
          ? 'thinking level'
          : kind === 'reasoning'
            ? 'reasoning visibility'
            : 'fast mode';
        setSessionControlsError(sessionControlErrorMessage(error, `Failed to update ${label}.`));
      }
      console.error(`[ChatState] Failed to patch ${kind}:`, error);
    } finally {
      finishSessionControlMutation(snapshot);
    }
  }, [applySessionControlValue, beginSessionControlMutation, finishSessionControlMutation, isCurrentSessionControlMutation]);

  const setThinkingLevel = useCallback(async (nextLevel: ThinkingLevel) => {
    await mutateSessionControl('thinking', nextLevel, thinkingLevelRef.current);
  }, [mutateSessionControl]);

  const setReasoningVisibility = useCallback(async (nextLevel: ReasoningVisibility) => {
    await mutateSessionControl('reasoning', nextLevel, reasoningVisibilityRef.current);
  }, [mutateSessionControl]);

  const reconnectSocket = useCallback(() => {
    if (useDirectGateway && providerRef.current === 'OPENCLAW' && directClientRef.current) {
      directClientRef.current.disconnect();
      directClientRef.current.connect();
      return;
    }
    wsManagerRef.current?.reconnect();
  }, [useDirectGateway]);

  const toggleFastMode = useCallback(async () => {
    const previous = fastModeEnabledRef.current;
    await mutateSessionControl('fastMode', !previous, previous);
  }, [mutateSessionControl]);

  const setCompactionModelOverride = useCallback(async (model: string) => {
    const normalized = String(model || '').trim();
    const snapshot = beginSessionControlMutation(
      'compactionModel',
      normalized,
      compactionModelOverrideRef.current,
    );
    if (!snapshot || snapshot.kind !== 'compactionModel') return;
    compactionModelOverrideRef.current = normalized;
    setCompactionModelOverrideState(normalized);
    try {
      await gatewayAPI.patchConfigPath('agents.defaults.compaction.model', snapshot.requested || null);
      if (!isCurrentSessionControlMutation(snapshot)) return;
      const fresh = await gatewayAPI.getConfigPath('agents.defaults.compaction.model');
      if (!isCurrentSessionControlMutation(snapshot)) return;
      const freshValue = typeof fresh?.value === 'string' ? fresh.value.trim() : '';
      compactionModelOverrideRef.current = freshValue;
      setCompactionModelOverrideState(freshValue);
      if (freshValue !== snapshot.requested) {
        setCompactionModelError('The server kept a different compaction model. Its confirmed value is shown.');
      }
    } catch (err) {
      console.error('[ChatState] Failed to patch compaction model override:', err);
      if (!isCurrentSessionControlMutation(snapshot)) return;
      let canonical = snapshot.previous;
      try {
        const fresh = await gatewayAPI.getConfigPath('agents.defaults.compaction.model');
        if (!isCurrentSessionControlMutation(snapshot)) return;
        canonical = typeof fresh?.value === 'string' ? fresh.value.trim() : '';
      } catch {
        // Fall back to the last confirmed local value when readback is unavailable.
      }
      compactionModelOverrideRef.current = canonical;
      setCompactionModelOverrideState(canonical);
      if (canonical !== snapshot.requested) {
        setCompactionModelError(sessionControlErrorMessage(err, 'Failed to update the compaction model.'));
      }
    } finally {
      finishSessionControlMutation(snapshot);
    }
  }, [beginSessionControlMutation, finishSessionControlMutation, isCurrentSessionControlMutation]);

  // Build context value
  const contextValue: ChatStateContextValue = {
    messages,
    messageQueue,
    queueCount: messageQueue.length,
    setMessages,
    clearMessages,
    clearQueue,
    removeQueuedMessage,
    isRunning,
    isLoadingHistory,
    historyError,
    hasOlderHistory,
    isLoadingOlderHistory,
    olderHistoryError,
    isSwitchingSession,
    streamingPhase,
    activeToolName,
    statusText,
    lastProvenance,
    thinkingContent,
    thinkingSubject,
    streamingAssistantId: streamingAssistantIdRef.current,
    streamSegments,
    activityTitles,
    compactionPhase,
    wsConnected,
    pendingApproval: pendingApprovals[0] || null,
    pendingApprovals,
    pendingApprovalCount: pendingApprovals.length,
    pendingUserQuestions,
    settlePendingUserQuestion,
    refreshPendingUserQuestions,
    resolveApproval,
    dismissApproval,
    provider,
    setProvider,
    selectProviderAgent,
    session,
    setSession,
    agentId,
    setAgentId,
    selectedModel,
    setSelectedModel,
    switchModel,
    sendMessage,
    injectNote,
    cancelStream,
    loadHistory,
    loadOlderHistory,
    getCompleteHistory,
    selectSession,
    refreshChat,
    wsManager: wsManagerRef.current,
    reconnectSocket,
    // Session controls
    thinkingLevel,
    sessionThinkingOptions,
    setThinkingLevel,
    reasoningVisibility,
    setReasoningVisibility,
    fastModeEnabled,
    toggleFastMode,
    compactionModelOverride,
    setCompactionModelOverride,
    compactionModelLoading,
    compactionModelError,
    sessionControlMutation,
    isSessionControlMutationActive,
    sessionControlsError,
    sessionControlsSupported,
    ensureSessionControlsMetadataLoaded,
    sessionTelemetry,
    sessionAvailability,
  };

  return (
    <ChatStateContext.Provider value={contextValue}>
      {children}
    </ChatStateContext.Provider>
  );
}
