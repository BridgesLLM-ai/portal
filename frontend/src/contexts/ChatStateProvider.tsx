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
import { authAPI } from '../api/auth';
import { useAuthStore } from './AuthContext';
import { isOwner } from '../utils/authz';
import {
  extractThinkingChunk,
  isControlOnlyAssistantContent,
  mergeAssistantStream,
  mergeThinkingStream,
  sanitizeAssistantContent,
  sanitizeAssistantChunk,
} from '../utils/chatStream';
import {
  OpenClawGatewayClient,
  createGatewayDirectUrl,
  type GatewayEvent,
  type GatewayChatMessage,
} from '../utils/openclawGatewayClient';
import { canonicalizePortalModelId } from '../utils/modelId';
import { usePublicSettings } from '../hooks/usePublicSettings';

const DEBUG_CHAT_STATE = import.meta.env.DEV;
const BUILD_TIME_USE_DIRECT_GATEWAY = import.meta.env.VITE_USE_DIRECT_GATEWAY === 'true';
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
  position: 'before' | 'after' | 'between';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'toolResult';
  content: string;
  createdAt: Date;
  queued?: boolean;
  provenance?: string;
  model?: string;
  toolCalls?: ToolCall[];
  thinkingContent?: string;
  toolCallId?: string;
  toolName?: string;
  /** Text segments with their position relative to tool calls (for history reconstruction) */
  segments?: TextSegment[];
}

export interface MessageQueueItem {
  id: string;
  text: string;
  createdAt: number;
}

export type StreamingPhase = 'idle' | 'thinking' | 'tool' | 'streaming';

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

    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
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

    ws.onmessage = (event) => {
      let data: any;
      try { data = JSON.parse(event.data); } catch { return; }
      for (const handler of handlers) {
        try { handler(data); } catch (err) { console.error('[ws-manager] Handler error:', err); }
      }
    };

    ws.onclose = (event) => {
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

    ws.onerror = () => {};
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
function nextId() {
  return 'msg-' + Date.now() + '-' + (++msgCounter);
}

const MODEL_STORAGE_PREFIX = 'agentChats.lastModel.';
const CHAT_HISTORY_OMITTED_PLACEHOLDER = '[chat.history omitted: message too large]';

function normalizeProviderModel(provider: string, rawModel: string): string {
  const model = String(rawModel || '').trim();
  if (!model) return '';
  if (provider === 'OPENCLAW' || provider === 'OLLAMA' || provider === 'GEMINI') {
    return canonicalizePortalModelId(model);
  }

  const lower = model.toLowerCase();
  if (provider === 'CLAUDE_CODE' && (lower.startsWith('anthropic/') || lower.startsWith('claude/'))) {
    return model.split('/').slice(1).join('/') || model;
  }
  if (provider === 'CODEX' && (lower.startsWith('openai-codex/') || lower.startsWith('openai/'))) {
    return model.split('/').slice(1).join('/') || model;
  }
  return model;
}

function parseHistoryMessage(m: any): ChatMessage | null {
  const rawContent = m.content || '';
  const isTruncationPlaceholder = m.role === 'assistant' && rawContent === CHAT_HISTORY_OMITTED_PLACEHOLDER;
  if (m.role === 'assistant' && !isTruncationPlaceholder && isControlOnlyAssistantContent(rawContent)) {
    return null;
  }

  const msg: ChatMessage = {
    id: m.id || nextId(),
    role: isTruncationPlaceholder ? 'system' : m.role,
    content: isTruncationPlaceholder
      ? 'Earlier assistant output was omitted from history because the message was too large.'
      : (m.role === 'assistant' ? sanitizeAssistantContent(rawContent) : rawContent),
    createdAt: new Date(m.timestamp || Date.now()),
    provenance: m.provenance,
    model: typeof m.model === 'string' ? m.model : undefined,
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
  // Preserve segments for graduated timeline reconstruction
  if (m.segments && Array.isArray(m.segments)) {
    msg.segments = m.segments;
  }
  if (m.role === 'toolResult') {
    msg.toolCallId = m.toolCallId;
    msg.toolName = m.toolName;
  }
  return msg;
}

/**
 * Extract text content from a gateway message.
 * Gateway format: { role, content: [{type: "text", text: "..."}, ...] }
 */
function extractTextFromGatewayMessage(msg: GatewayChatMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';

  return msg.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!)
    .join('\n');
}

/**
 * Extract tool calls from a gateway message.
 */
function extractToolCallsFromGatewayMessage(msg: GatewayChatMessage): ToolCall[] | undefined {
  if (!Array.isArray(msg.content)) return undefined;

  const toolCalls = msg.content
    .filter((block) => block.type === 'toolCall' && block.name)
    .map((block) => ({
      id: block.id || nextId(),
      name: block.name as string,
      arguments: block.arguments,
      startedAt: Date.now(),
      endedAt: Date.now(),
      status: 'done' as const,
    }));

  return toolCalls.length > 0 ? toolCalls : undefined;
}

/**
 * Extract thinking content from a gateway message.
 */
function extractThinkingFromGatewayMessage(msg: GatewayChatMessage): string | undefined {
  if (!Array.isArray(msg.content)) return undefined;

  const thinking = msg.content
    .filter((block) => block.type === 'thinking' && typeof block.thinking === 'string')
    .map((block) => block.thinking as string)
    .join('\n');

  return thinking || undefined;
}

/**
 * Map a gateway message to our ChatMessage format.
 */
function mapGatewayMessage(msg: GatewayChatMessage): ChatMessage | null {
  const text = extractTextFromGatewayMessage(msg);
  const toolCalls = extractToolCallsFromGatewayMessage(msg);
  const thinking = extractThinkingFromGatewayMessage(msg);
  const isTruncationPlaceholder = msg.role === 'assistant' && text === CHAT_HISTORY_OMITTED_PLACEHOLDER;
  if (msg.role === 'assistant' && !isTruncationPlaceholder && isControlOnlyAssistantContent(text)) {
    return null;
  }

  return {
    id: msg.id || msg.messageId || `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: isTruncationPlaceholder ? 'system' : (msg.role as 'user' | 'assistant' | 'system' | 'toolResult'),
    content: isTruncationPlaceholder
      ? 'Earlier assistant output was omitted from history because the message was too large.'
      : (msg.role === 'assistant' ? sanitizeAssistantContent(text) : text),
    createdAt: new Date(msg.timestamp || Date.now()),
    model: typeof (msg as any).model === 'string' ? (msg as any).model : undefined,
    toolCalls,
    thinkingContent: thinking,
  };
}

const HISTORY_REPLAY_DUPLICATE_WINDOW_MS = 5_000;

function normalizeHistoryReplayContent(content: string): string {
  return (content || '').replace(/\r\n/g, '\n').trim();
}

function isLikelyHistoryReplayDuplicate(previous: ChatMessage | undefined, next: ChatMessage): boolean {
  if (!previous || previous.role !== next.role || next.role !== 'user') return false;

  const previousContent = normalizeHistoryReplayContent(previous.content);
  const nextContent = normalizeHistoryReplayContent(next.content);
  if (!previousContent || previousContent !== nextContent) return false;

  const previousTs = previous.createdAt instanceof Date ? previous.createdAt.getTime() : NaN;
  const nextTs = next.createdAt instanceof Date ? next.createdAt.getTime() : NaN;
  if (!Number.isFinite(previousTs) || !Number.isFinite(nextTs) || nextTs < previousTs) return false;

  return (nextTs - previousTs) <= HISTORY_REPLAY_DUPLICATE_WINDOW_MS;
}

function dedupeHistoryMessages(messages: ChatMessage[]): ChatMessage[] {
  const seenIds = new Set<string>();
  const seenSignatures = new Set<string>();
  const deduped: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.id && seenIds.has(msg.id)) continue;
    const previous = deduped[deduped.length - 1];
    if (isLikelyHistoryReplayDuplicate(previous, msg)) continue;
    const ts = msg.createdAt instanceof Date ? msg.createdAt.getTime() : Date.now();
    const signature = `${msg.role}|${Number.isFinite(ts) ? ts : 0}|${msg.content}`;
    if (msg.role === 'assistant' && seenSignatures.has(signature)) continue;
    if (msg.id) seenIds.add(msg.id);
    seenSignatures.add(signature);
    deduped.push(msg);
  }
  return deduped;
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
  isSwitchingSession: boolean;
  streamingPhase: StreamingPhase;
  activeToolName: string | null;
  statusText: string | null;
  lastProvenance: string | null;
  thinkingContent: string;
  streamSegments: Array<{text: string; ts: number}>;
  compactionPhase: 'idle' | 'compacting' | 'compacted';
  wsConnected: boolean;
  pendingApproval: ExecApprovalRequest | null;
  resolveApproval: (approvalId: string, decision: 'allow-once' | 'deny' | 'allow-always') => Promise<void>;
  dismissApproval: () => void;
  provider: string;
  setProvider: (p: string) => void;
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
  selectSession: (sessionKey: string) => Promise<void>;
  refreshChat: () => Promise<void>;
  wsManager: WsManager | null;
  reconnectSocket: () => void;
  // Session controls (OpenClaw session thinking + fast mode)
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive';
  setThinkingLevel: (level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive') => Promise<void>;
  fastModeEnabled: boolean;
  toggleFastMode: () => Promise<void>;
  compactionModelOverride: string;
  setCompactionModelOverride: (model: string) => Promise<void>;
  compactionModelLoading: boolean;
  compactionModelError: string | null;
  sessionControlsSupported: boolean;
  ensureSessionControlsMetadataLoaded: () => Promise<void>;
}

const ChatStateContext = createContext<ChatStateContextValue | null>(null);

export function useChatState(): ChatStateContextValue {
  const ctx = useContext(ChatStateContext);
  if (!ctx) throw new Error('useChatState must be used within ChatStateProvider');
  return ctx;
}

/* ═══ Provider Component ═══ */

function normalizeInitialSession(provider: string, session: string): string {
  const p = String(provider || '').trim().toUpperCase();
  const s = String(session || '').trim() || 'main';
  if (p === 'OPENCLAW' && s === 'main') return 'agent:main:main';
  return s;
}

export function ChatStateProvider({ children }: { children: React.ReactNode }) {
  type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive';
  const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive'];
  const publicSettings = usePublicSettings();
  const useDirectGateway = publicSettings?.useDirectGateway ?? BUILD_TIME_USE_DIRECT_GATEWAY;

  // Persisted selection state
  const [provider, setProviderRaw] = useState(
    () => localStorage.getItem('agent-chat-provider') || 'OPENCLAW',
  );
  const [session, setSessionRaw] = useState(() => {
    const storedProvider = localStorage.getItem('agent-chat-provider') || 'OPENCLAW';
    const storedSession = localStorage.getItem('agent-chat-session') || 'main';
    const normalized = normalizeInitialSession(storedProvider, storedSession);
    if (normalized !== storedSession) localStorage.setItem('agent-chat-session', normalized);
    return normalized;
  });
  const [agentId, setAgentIdRaw] = useState<string | undefined>(
    () => localStorage.getItem('agent-chat-agentId') || undefined,
  );
  const [selectedModel, setSelectedModelRaw] = useState(() => {
    const p = localStorage.getItem('agent-chat-provider') || 'OPENCLAW';
    const stored = normalizeProviderModel(p, localStorage.getItem(MODEL_STORAGE_PREFIX + p) || '');
    // Only OpenClaw models require provider prefixes. Native providers use bare IDs.
    if (stored && p === 'OPENCLAW' && !stored.includes('/')) {
      localStorage.removeItem(MODEL_STORAGE_PREFIX + p);
      return '';
    }
    return stored;
  });
  const user = useAuthStore((state) => state.user);

  // Wrapped setters with localStorage persistence
  const setProvider = useCallback((p: string) => {
    localStorage.setItem('agent-chat-provider', p);
    setProviderRaw(p);
    const stored = normalizeProviderModel(p, localStorage.getItem(MODEL_STORAGE_PREFIX + p) || '');
    // Same guard, but only for OpenClaw. Native providers legitimately use bare IDs.
    if (stored && p === 'OPENCLAW' && !stored.includes('/')) {
      localStorage.removeItem(MODEL_STORAGE_PREFIX + p);
      setSelectedModelRaw('');
    } else {
      setSelectedModelRaw(stored);
    }
  }, []);
  const setSession = useCallback((s: string) => {
    const normalized = normalizeInitialSession(providerRef.current, s);
    localStorage.setItem('agent-chat-session', normalized);
    setSessionRaw(normalized);
  }, []);
  const setAgentId = useCallback((a: string | undefined) => {
    if (a) localStorage.setItem('agent-chat-agentId', a);
    else localStorage.removeItem('agent-chat-agentId');
    setAgentIdRaw(a);
  }, []);
  const setSelectedModel = useCallback((m: string) => {
    const normalized = normalizeProviderModel(provider, m);
    setSelectedModelRaw(normalized);
    if (normalized) localStorage.setItem(MODEL_STORAGE_PREFIX + provider, normalized);
    else localStorage.removeItem(MODEL_STORAGE_PREFIX + provider);
  }, [provider]);

  useEffect(() => {
    const normalized = normalizeInitialSession(provider, session);
    if (normalized !== session) {
      localStorage.setItem('agent-chat-session', normalized);
      setSessionRaw(normalized);
    }
  }, [provider, session]);

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

    return '';
  }, []);

  const switchModel = useCallback(async (m: string) => {
    setSelectedModel(m);

    const currentProvider = providerRef.current;
    const currentSession = sessionRef.current;
    if (!m) return { deferred: false };

    const needsConcreteOpenClawSession = currentProvider === 'OPENCLAW';
    const hasConcreteSession = needsConcreteOpenClawSession
      ? Boolean(currentSession && currentSession.startsWith('agent:'))
      : Boolean(currentSession && currentSession !== 'main' && !currentSession.startsWith('new-'));

    if (!hasConcreteSession) {
      return { deferred: true };
    }

    await gatewayAPI.patchSessionModel(currentSession, m, currentProvider);
    return { deferred: false };
  }, [setSelectedModel]);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageQueue, setMessageQueue] = useState<MessageQueueItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isSwitchingSession, setIsSwitchingSession] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [lastProvenance, setLastProvenance] = useState<string | null>(null);
  const [streamingPhase, setStreamingPhase] = useState<StreamingPhase>('idle');
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  const [thinkingContent, setThinkingContent] = useState<string>('');
  const [startupReady, setStartupReady] = useState(false);
  // Graduated streaming segments — when a tool call starts, current accumulated text
  // gets "graduated" into a segment so it renders as a finalized bubble. This matches
  // the OpenClaw web UI v2 pattern where thoughts don't disappear on tool transitions.
  const [streamSegments, setStreamSegments] = useState<Array<{text: string; ts: number}>>([]);
  const streamSegmentsRef = useRef<Array<{text: string; ts: number}>>([]);
  useEffect(() => { streamSegmentsRef.current = streamSegments; }, [streamSegments]);
  const [pendingApproval, setPendingApproval] = useState<ExecApprovalRequest | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [compactionPhase, setCompactionPhase] = useState<'idle' | 'compacting' | 'compacted'>('idle');
  const compactionPhaseRef = useRef<'idle' | 'compacting' | 'compacted'>('idle');

  // Session controls state (thinking/fast mode)
  const [thinkingLevel, setThinkingLevelState] = useState<ThinkingLevel>('off');
  const [fastModeEnabled, setFastModeEnabled] = useState(false);
  const [compactionModelOverride, setCompactionModelOverrideState] = useState<string>('');
  const [compactionModelLoading, setCompactionModelLoading] = useState(false);
  const [compactionModelError, setCompactionModelError] = useState<string | null>(null);
  const [sessionControlsMetadataLoaded, setSessionControlsMetadataLoaded] = useState(false);

  // Refs
  const streamWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const STREAM_TIMEOUT_MS = 180_000;
  const compactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolCounterRef = useRef(0);
  const hasRealToolEventsRef = useRef(false);
  const sessionControlsMetadataPromiseRef = useRef<Promise<void> | null>(null);
  const wsManagerRef = useRef<WsManager | null>(null);
  // Direct gateway client for OPENCLAW provider (bypasses portal WS middleman)
  const directClientRef = useRef<OpenClawGatewayClient | null>(null);
  const streamTransportRef = useRef<'portal' | 'direct' | null>(null);
  const currentRunIdRef = useRef<string | null>(null);
  const streamingAssistantIdRef = useRef<string | null>(null);
  const assembledRef = useRef('');
  const lastSegmentStartRef = useRef(0);
  const lastRawTextLenRef = useRef(0); // Track raw gateway text length for accurate graduation
  const isStreamActiveRef = useRef(false);
  const isQueueDrainActiveRef = useRef(false);
  const sessionRef = useRef(session);
  const providerRef = useRef(provider);
  const agentIdRef = useRef(agentId);
  const modelRef = useRef(selectedModel);
  const messageQueueRef = useRef<MessageQueueItem[]>([]);
  // Monotonically-incrementing generation counter — incremented on every session
  // switch or clearMessages. Any async history load that started in a previous
  // generation simply discards its result, eliminating race conditions.
  const historyGenRef = useRef(0);
  const loadHistoryInternalRef = useRef<((sessionKey: string, prov?: string, options?: { force?: boolean }) => Promise<boolean>) | null>(null);
  // Throttle refs for streaming text updates — batch text deltas to reduce re-renders
  const textThrottleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTextUpdateRef = useRef<string | null>(null);
  const TEXT_THROTTLE_MS = 50; // 20fps is plenty smooth for text streaming

  // Sync refs immediately when state changes. Note: the refs are ALSO updated
  // synchronously in the event handlers (see case 'session' below) to avoid races.
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { providerRef.current = provider; }, [provider]);
  useEffect(() => { agentIdRef.current = agentId; }, [agentId]);
  useEffect(() => { modelRef.current = selectedModel; }, [selectedModel]);
  useEffect(() => { messageQueueRef.current = messageQueue; }, [messageQueue]);

  const ensureSessionControlsMetadataLoaded = useCallback(async () => {
    if (!startupReady || provider !== 'OPENCLAW' || !session || !session.startsWith('agent:')) return;
    if (sessionControlsMetadataLoaded) return;
    if (sessionControlsMetadataPromiseRef.current) {
      await sessionControlsMetadataPromiseRef.current;
      return;
    }

    const loadPromise = (async () => {
      setCompactionModelError(null);
      const [sessionInfoResult, compactionResult] = await Promise.allSettled([
        gatewayAPI.sessionInfo(session, { silent: true }),
        gatewayAPI.getConfigPath('agents.defaults.compaction.model'),
      ]);

      if (sessionInfoResult.status === 'fulfilled') {
        const data = sessionInfoResult.value;
        const actualModel = deriveSessionModel(data?.session);
        if (actualModel) {
          setSelectedModelRaw((prev) => (prev === actualModel ? prev : actualModel));
        }
        const sessionThinking = String(
          data?.session?.thinkingLevel
          || data?.session?.thinking
          || data?.session?.settings?.thinking
          || '',
        ).toLowerCase();
        if (THINKING_LEVELS.includes(sessionThinking as ThinkingLevel)) {
          setThinkingLevelState(sessionThinking as ThinkingLevel);
        } else {
          const modelStr = String(actualModel || '').toLowerCase();
          const isAdaptiveDefault = /claude-(opus|sonnet)-4[._-](5|6|7|8|9)|claude-(opus|sonnet)-[5-9]/.test(modelStr);
          setThinkingLevelState(isAdaptiveDefault ? 'adaptive' : 'off');
        }
        setFastModeEnabled(Boolean(
          data?.session?.fastMode
          ?? data?.session?.settings?.fastMode
          ?? false,
        ));
      }

      if (compactionResult.status === 'fulfilled') {
        const value = typeof compactionResult.value?.value === 'string' ? compactionResult.value.value.trim() : '';
        setCompactionModelOverrideState(value);
      } else {
        setCompactionModelOverrideState('');
      }

      setSessionControlsMetadataLoaded(true);
    })();

    sessionControlsMetadataPromiseRef.current = loadPromise;
    try {
      await loadPromise;
    } finally {
      sessionControlsMetadataPromiseRef.current = null;
    }
  }, [startupReady, provider, session, sessionControlsMetadataLoaded, deriveSessionModel]);

  useEffect(() => {
    setSessionControlsMetadataLoaded(false);
    sessionControlsMetadataPromiseRef.current = null;
    setThinkingLevelState('off');
    setFastModeEnabled(false);
    setCompactionModelOverrideState('');
    setCompactionModelError(null);
  }, [provider, session]);

  const normalizeAgentError = useCallback((err: unknown, fallback = 'Agent request failed') => {
    const raw = err instanceof Error ? err.message : String(err || '').trim();
    if (!raw) return fallback;
    if (/not logged in|please run \/login/i.test(raw)) return 'This provider is installed but not logged in on the server yet.';
    if (/GEMINI_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_GENAI_USE_GCA|Auth method/i.test(raw)) return 'Gemini is installed but not authenticated on the server yet.';
    if (/ECONNREFUSED|Cannot connect to OpenClaw gateway|gateway.*not connected/i.test(raw)) return 'OpenClaw is reconnecting right now. Give it a few seconds and retry.';
    return raw;
  }, []);

  // Stream watchdog
  const resetStreamWatchdog = useCallback(() => {
    if (streamWatchdogRef.current) clearTimeout(streamWatchdogRef.current);
    if (!isStreamActiveRef.current) return;
    streamWatchdogRef.current = setTimeout(async () => {
      if (!isStreamActiveRef.current) return;
      console.warn('[ChatState] Stream watchdog: no activity for 180s — verifying stream status');

      try {
        const currentSession = sessionRef.current || 'main';
        const currentProvider = providerRef.current;
        const params: Record<string, string> = { session: currentSession };
        if (currentProvider) params.provider = currentProvider;
        const { data } = await client.get('/gateway/stream-status', { params, _silent: true } as any);
        if (data?.active) {
          const hasVisibleSnapshotText = typeof data.content === 'string'
            && data.content.length > 0
            && !isControlOnlyAssistantContent(data.content);
          const shouldSurfaceStream = Boolean(data.toolName) || hasVisibleSnapshotText || Boolean(streamingAssistantIdRef.current);

          if (useDirectGateway && currentProvider === 'OPENCLAW') {
            directClientRef.current?.connect();
          } else if (wsManagerRef.current && !wsManagerRef.current.isConnected()) {
            wsManagerRef.current.reconnect();
          }

          if (!shouldSurfaceStream) {
            clearActiveStreamState();
            return;
          }

          directClientRef.current?.setActiveStreamSession(currentSession);
          setIsRunning(true);
          setStreamingPhase(data.phase === 'tool' ? 'tool' : data.phase === 'streaming' ? 'streaming' : 'thinking');
          setActiveToolName(data.toolName || null);
          setStatusText(data.toolName ? `Using ${data.toolName}…` : 'Still working…');
          if (hasVisibleSnapshotText) {
            const safeText = sanitizeAssistantContent(data.content);
            assembledRef.current = safeText;
            const assistantId = streamingAssistantIdRef.current;
            if (assistantId) {
              setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: safeText } : m));
            }
          }
          resetStreamWatchdog();
          return;
        }
      } catch (err) {
        console.warn('[ChatState] Stream watchdog verification failed:', err);
      }

      const ft = assembledRef.current;
      const currentSession = sessionRef.current || 'main';
      const currentProvider = providerRef.current;
      const shouldReloadHistoryIfIdle = currentProvider === 'OPENCLAW'
        && !ft.trim()
        && streamSegmentsRef.current.length === 0
        && !hasRealToolEventsRef.current;

      isStreamActiveRef.current = false;
      streamTransportRef.current = null;
      setIsRunning(false);
      setStreamingPhase('idle');
      setStatusText(null);
      setThinkingContent('');
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

      if (shouldReloadHistoryIfIdle) {
        void loadHistoryInternalRef.current?.(currentSession, currentProvider, { force: true });
        return;
      }

      if (cid && ft) {
        setMessages(prev => prev.map(m =>
          m.id === cid ? { ...m, content: ft + '\n\n*(stream interrupted)*' } : m
        ));
      }
    }, STREAM_TIMEOUT_MS);
  }, [useDirectGateway]);
  const clearStreamWatchdog = useCallback(() => {
    if (streamWatchdogRef.current) { clearTimeout(streamWatchdogRef.current); streamWatchdogRef.current = null; }
  }, []);

  const resolveOpenClawSessionKey = useCallback((rawSession?: string | null): string => {
    const sessionKey = typeof rawSession === 'string' ? rawSession.trim() : '';
    if (providerRef.current !== 'OPENCLAW') return sessionKey;
    if (sessionKey.startsWith('agent:')) return sessionKey;
    if (isOwner(user) && (!sessionKey || sessionKey === 'main' || sessionKey.startsWith('new-'))) {
      return 'agent:main:main';
    }
    return sessionKey;
  }, [user]);

  const appendSystemNotice = useCallback((content: string) => {
    const now = Date.now();
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last?.role === 'system' && last.content === content && now - last.createdAt.getTime() < 4000) {
        return prev;
      }
      return [...prev, { id: nextId(), role: 'system', content, createdAt: new Date(now) }];
    });
  }, []);

  const applyCompactionState = useCallback((phase: 'start' | 'end') => {
    if (providerRef.current !== 'OPENCLAW') return;
    if (phase === 'start') {
      if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
      compactionPhaseRef.current = 'compacting';
      setCompactionPhase('compacting');
      setThinkingContent('');
      appendSystemNotice('Context compaction started.');
      return;
    }
    compactionPhaseRef.current = 'compacted';
    setCompactionPhase('compacted');
    appendSystemNotice('Context compaction finished.');
    if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
    compactionTimerRef.current = setTimeout(() => {
      compactionPhaseRef.current = 'idle';
      setCompactionPhase('idle');
      compactionTimerRef.current = null;
    }, 3000);
  }, [appendSystemNotice]);

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
        toolCounterRef.current = 0;
        hasRealToolEventsRef.current = false;
        setThinkingContent('');
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
      return [...prev, {
        id: assistantId!,
        role: 'assistant' as const,
        content: maybeContent ?? '',
        createdAt: new Date(),
        toolCalls: [],
      }];
    });
    return { assistantId, created };
  }, []);

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

  const clearActiveStreamState = useCallback(() => {
    clearStreamWatchdog();
    isStreamActiveRef.current = false;
    streamTransportRef.current = null;
    currentRunIdRef.current = null;
    streamingAssistantIdRef.current = null;
    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = 0;
    pendingTextUpdateRef.current = null;
    directClientRef.current?.setActiveStreamSession(null);
    setIsRunning(false);
    setStreamingPhase('idle');
    setStatusText(null);
    setThinkingContent('');
    setActiveToolName(null);
  }, [clearStreamWatchdog]);

  const applyOpenClawActiveStreamSnapshot = useCallback((snapshot: any, options?: {
    statusTextWhenNoTool?: string | null;
    source?: 'portal' | 'direct';
  }) => {
    if (!snapshot?.active) return false;
    const snapshotContent = typeof snapshot.content === 'string' && !isControlOnlyAssistantContent(snapshot.content)
      ? sanitizeAssistantContent(snapshot.content)
      : '';
    let assistantId = streamingAssistantIdRef.current;
    const shouldMaterializeBubble = Boolean(snapshotContent) || Boolean(snapshot.toolName) || Boolean(assistantId);
    if (!shouldMaterializeBubble) {
      return false;
    }

    isStreamActiveRef.current = true;
    streamTransportRef.current = options?.source || 'portal';
    directClientRef.current?.setActiveStreamSession(sessionRef.current || null);
    setIsRunning(true);
    setStreamingPhase(snapshot.phase === 'tool' ? 'tool' : snapshot.phase === 'streaming' ? 'streaming' : 'thinking');
    setActiveToolName(snapshot.toolName || null);
    setStatusText(snapshot.toolName ? `Using ${snapshot.toolName}…` : ((snapshot.statusText || options?.statusTextWhenNoTool) ?? null));
    const snapshotCompaction = snapshot.compactionPhase;
    if (snapshotCompaction === 'compacting' || snapshotCompaction === 'compacted' || snapshotCompaction === 'idle') {
      compactionPhaseRef.current = snapshotCompaction;
      setCompactionPhase(snapshotCompaction);
    }
    if (snapshot.provenance) setLastProvenance(String(snapshot.provenance));
    if (snapshotContent) {
      mergeStreamText(snapshotContent, { replace: true });
    }
    assistantId = ensureStreamingAssistantBubble({
      idPrefix: 'stream-resume',
      content: snapshotContent || '',
    }).assistantId;
    if (snapshot.model && assistantId) {
      setMessages(prev => prev.map(m => (
        m.id === assistantId
          ? { ...m, model: normalizeProviderModel(providerRef.current, String(snapshot.model)) }
          : m
      )));
    }
    resetStreamWatchdog();
    return true;
  }, [ensureStreamingAssistantBubble, mergeStreamText, resetStreamWatchdog]);

  const hydrateActiveStream = useCallback(async (
    sessionKey: string,
    prov?: string,
    snapshot?: any,
    options?: { clearIfInactive?: boolean; reconnect?: boolean },
  ) => {
    if (!sessionKey || prov !== 'OPENCLAW') return false;
    const expectedSession = sessionKey;
    const expectedProvider = prov;
    const expectedHistoryGen = historyGenRef.current;
    try {
      let data = snapshot;
      if (!data) {
        const params: Record<string, string> = { session: sessionKey };
        if (prov) params.provider = prov;
        const response = await client.get('/gateway/stream-status', { params, _silent: true } as any);
        data = response.data;
      }
      if (
        sessionRef.current !== expectedSession
        || providerRef.current !== expectedProvider
        || historyGenRef.current !== expectedHistoryGen
      ) {
        debugLog('[ChatState] Ignoring stale active-stream snapshot', {
          expectedSession,
          currentSession: sessionRef.current,
          expectedProvider,
          currentProvider: providerRef.current,
          expectedHistoryGen,
          currentHistoryGen: historyGenRef.current,
        });
        return false;
      }
      const manager = wsManagerRef.current;
      if (!data?.active) {
        if (options?.reconnect !== false && manager?.isConnected()) {
          manager.send({ type: 'reconnect', session: sessionKey, provider: prov });
        }
        if (options?.clearIfInactive && isStreamActiveRef.current) {
          debugLog('[ChatState] Active-stream snapshot is idle — clearing stale stream UI');
          clearActiveStreamState();
        }
        return false;
      }
      if (isStreamActiveRef.current) return true;
      debugLog('[ChatState] Active stream found during history load — hydrating');
      applyOpenClawActiveStreamSnapshot(data, { statusTextWhenNoTool: 'Reconnecting to stream…' });
      if (options?.reconnect !== false && manager?.isConnected()) {
        manager.send({ type: 'reconnect', session: sessionKey, provider: prov });
      }
      return true;
    } catch {
      return false;
    }
  }, [applyOpenClawActiveStreamSnapshot, clearActiveStreamState]);

  // History loader
  const loadHistoryInternal = useCallback(async (sessionKey: string, prov?: string, options?: { force?: boolean }): Promise<boolean> => {
    if (!sessionKey || (isStreamActiveRef.current && !options?.force)) return false;
    // Snapshot the current generation — if it changes while we await, discard results.
    const myGen = ++historyGenRef.current;
    setIsLoadingHistory(true);

    let historyActiveStream: any = undefined;
    const loadViaHttp = async (): Promise<ChatMessage[]> => {
      const params: Record<string, string> = { session: sessionKey, enhanced: '1' };
      if (prov) params.provider = prov;
      const { data } = await client.get('/gateway/history', { params });
      historyActiveStream = data?.activeStream;
      return data.messages ? data.messages.map(parseHistoryMessage).filter(Boolean) as ChatMessage[] : [];
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
        localStorage.setItem('agent-chat-session', resolvedSessionKey);
      }
      const result = await directClient.loadHistory(resolvedSessionKey || sessionKey);
      return result.messages.map(mapGatewayMessage).filter(Boolean) as ChatMessage[];
    };

    try {
      let loaded: ChatMessage[];

      // For OPENCLAW, prefer HTTP history unless the direct gateway is already connected.
      // That keeps history + activeStream hydration in one request and avoids the portal WS
      // timeout tax on fresh reopen.
      const directClient = directClientRef.current;
      const useDirectHistory = useDirectGateway && prov === 'OPENCLAW' && directClient?.isConnected && !options?.force;
      console.log('[ChatState] loadHistoryInternal: USE_DIRECT=', useDirectGateway, 'prov=', prov, 'directConnected=', directClient?.isConnected, 'session=', sessionKey, 'force=', options?.force);
      if (useDirectHistory) {
        try {
          console.log('[ChatState] 📜 Loading history via DIRECT gateway');
          loaded = await loadViaDirect();
        } catch (err) {
          console.warn('[ChatState] Direct gateway history failed; falling back to HTTP', err);
          loaded = await loadViaHttp();
        }
      } else if (prov === 'OPENCLAW') {
        loaded = await loadViaHttp();
      } else {
        // Non-OpenClaw providers can still use the existing portal WS fast path.
        const manager = wsManagerRef.current;
        if (manager && manager.isConnected()) {
          try {
            loaded = await new Promise<ChatMessage[]>((resolve, reject) => {
              const requestId = 'hist-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
              const handler = (data: any) => {
                if (data.type === 'history' && data.requestId === requestId) {
                  clearTimeout(timeout);
                  manager.removeHandler(handler);
                  resolve((data.messages || []).map(parseHistoryMessage).filter(Boolean) as ChatMessage[]);
                } else if (data.type === 'error' && data.requestId === requestId) {
                  clearTimeout(timeout);
                  manager.removeHandler(handler);
                  reject(new Error(data.content || 'History request failed'));
                }
              };
              const timeout = setTimeout(() => {
                manager.removeHandler(handler);
                reject(new Error('History timeout'));
              }, 1500);
              manager.addHandler(handler);
              const sent = manager.send({ type: 'history', session: sessionKey, provider: prov, requestId });
              if (!sent) {
                clearTimeout(timeout);
                manager.removeHandler(handler);
                reject(new Error('History send failed'));
              }
            });
          } catch (err) {
            console.warn('[ChatState] WS history failed; falling back to HTTP', err);
            loaded = await loadViaHttp();
          }
        } else {
          loaded = await loadViaHttp();
        }
      }

      // Only apply if still the current generation
      if (historyGenRef.current === myGen) {
        setMessages(mergeToolResultsIntoToolCalls(dedupeHistoryMessages(loaded)));
        if (!useDirectHistory) {
          return await hydrateActiveStream(sessionKey, prov, historyActiveStream, {
            clearIfInactive: Boolean(options?.force),
          });
        }
      }
    } catch (err) {
      console.error('[ChatState] History load failed:', err);
      if (historyGenRef.current === myGen) setMessages([]);
      return false;
    } finally {
      if (historyGenRef.current === myGen) {
        setIsLoadingHistory(false);
        setIsSwitchingSession(false);
        setStartupReady(true);
      }
    }
    return false;
  }, [hydrateActiveStream, resolveOpenClawSessionKey, useDirectGateway]);

  useEffect(() => {
    loadHistoryInternalRef.current = loadHistoryInternal;
  }, [loadHistoryInternal]);

  const loadHistory = useCallback(async (sessionKey: string, prov?: string) => {
    await loadHistoryInternal(sessionKey, prov);
  }, [loadHistoryInternal]);

  // Explicitly select a session from the sidebar — resets any stale stream state
  // and force-loads history, bypassing the isStreamActive guard.
  const selectSession = useCallback(async (sessionKey: string) => {
    if (!sessionKey) return;
    // Reset stream state inline (clearMessages is defined later in the file)
    isStreamActiveRef.current = false;
    historyGenRef.current++;
    setIsSwitchingSession(true);
    setIsLoadingHistory(true);
    setIsRunning(false);
    setStreamingPhase('idle');
    setStatusText(null);
    setLastProvenance(null);
    setThinkingContent('');
    compactionPhaseRef.current = 'idle';
    setCompactionPhase('idle');
    setActiveToolName(null);
    // Keep current messages visible until the target session history resolves.
    setSessionRaw(sessionKey);
    localStorage.setItem('agent-chat-session', sessionKey);
    // Force-load history bypassing the isStreamActive guard
    await loadHistoryInternal(sessionKey, providerRef.current, { force: true });
  }, [loadHistoryInternal]);

  // Refresh: reload history + check for active stream and resubscribe
  const refreshChat = useCallback(async () => {
    const currentSession = sessionRef.current;
    const currentProvider = providerRef.current;
    if (!currentSession) return;
    debugLog('[ChatState] Manual refresh — reloading history');
    try {
      await loadHistoryInternal(currentSession, currentProvider, { force: true });
    } catch (err) {
      console.error('[ChatState] Refresh error:', err);
      try { await loadHistoryInternal(currentSession, currentProvider); } catch {}
    }
  }, [loadHistoryInternal]);

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

  // WS event handler — processes events even when chat page is unmounted
  const handleWsEvent = useCallback((data: any) => {
    // When the direct gateway client is connected, it handles all streaming events
    // (chat, agent) directly. The Socket.IO/WS path should NOT also process them,
    // otherwise the browser receives the same text twice causing stutter/cascade.
    if (directClientRef.current?.isConnected && streamTransportRef.current === 'direct') {
      // Still allow non-streaming events (session, exec_approval, connected, keepalive)
      const directHandledTypes = ['text', 'thinking', 'tool_start', 'tool_end', 'tool_used', 'status', 'segment_break', 'done', 'stream_resume', 'stream_ended', 'run_resumed'];
      if (directHandledTypes.includes(data?.type)) {
        return; // Direct gateway already handling this
      }
    }

    // Session events with a new sessionId should update our ref IMMEDIATELY,
    // before the React state update queues. This prevents subsequent events
    // (that arrive before the useEffect fires) from being dropped.
    if (data?.type === 'session' && data.sessionId) {
      sessionRef.current = data.sessionId;
    }

    // Filter events by session key. Allow events that match our current session,
    // OR events that don't have a sessionKey (global events like connected/keepalive).
    // Also allow compaction events through regardless of session key — they're important
    // system notifications that should display even if the sessionKey hasn't resolved yet.
    const alwaysPassthroughTypes = ['compaction_start', 'compaction_end', 'connected', 'keepalive'];
    if (data?.sessionKey && data.sessionKey !== sessionRef.current && !alwaysPassthroughTypes.includes(data.type)) {
      return;
    }
    // Temp debug: log tool-related events to diagnose missing tool cards
    if (data.type && (data.type.startsWith('tool') || data.type === 'text' || data.type === 'done')) {
      console.log(`[ChatState] WS event: type=${data.type} assistantId=${streamingAssistantIdRef.current || 'NULL'} toolName=${data.toolName || '-'} contentLen=${(data.content||'').length}`);
    }
    // Only process stream events if we have an active assistant message.
    // Some event types are allowed without a bubble so we can wait for visible
    // content before materializing a resumed turn.
    const passthrough = ['session', 'exec_approval', 'exec_approval_resolved', 'connected', 'keepalive', 'compaction_start', 'compaction_end', 'stream_resume', 'stream_ended', 'run_resumed'];
    const autoCreateBubbleTypes = ['text', 'tool_start', 'tool_end', 'tool_used', 'toolCall', 'toolResult', 'segment_break'];
    const waitForVisibleStreamTypes = ['status', 'thinking', 'done', 'error'];
    if (!streamingAssistantIdRef.current && data.type === 'text' && typeof data.content === 'string' && isControlOnlyAssistantContent(data.content)) {
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

    switch (data.type) {
      case 'session': {
        if (data.sessionId) {
          setSessionRaw(data.sessionId);
          localStorage.setItem('agent-chat-session', data.sessionId);
        }
        if (data.provenance) setLastProvenance(data.provenance);
        if (data.model) {
          setMessages(prev => prev.map(m => (
            m.id === streamingAssistantIdRef.current
              ? { ...m, model: normalizeProviderModel(providerRef.current, String(data.model)) }
              : m
          )));
        }
        break;
      }
      case 'status': {
        if (!assistantId && !isStreamActiveRef.current) break;
        setStatusText(data.content || null);
        // OpenClaw emits dedicated `thinking` events; avoid mixing generic
        // status text into the thought bubble (live-only divergence vs refresh).
        if (providerRef.current !== 'OPENCLAW') {
          appendThinkingChunk(
            assistantId,
            extractThinkingChunk('status', data.content, assembledRef.current.length > 0),
          );
        }
        if (!assembledRef.current) setStreamingPhase('thinking');
        break;
      }
      case 'thinking': {
        if (!assistantId && !isStreamActiveRef.current) break;
        appendThinkingChunk(assistantId, extractThinkingChunk('thinking', data.content, assembledRef.current.length > 0));
        if (!assembledRef.current) setStreamingPhase('thinking');
        break;
      }
      case 'compaction_start': {
        applyCompactionState('start');
        break;
      }
      case 'compaction_end': {
        applyCompactionState('end');
        break;
      }
      case 'tool_start': {
        hasRealToolEventsRef.current = true;
        // Graduate current streaming text into a finalized segment before tool call.
        // This preserves the agent's thoughts as visible bubbles instead of wiping them.
        if (assembledRef.current && assembledRef.current.trim().length > 0) {
          setStreamSegments(prev => [...prev, { text: assembledRef.current, ts: Date.now() }]);
          assembledRef.current = '';
          // Clear the streaming message content — new text will fill it after the tool
          if (assistantId) {
            setMessages(prev => prev.map(m =>
              m.id === assistantId ? { ...m, content: '' } : m
            ));
          }
        }
        const toolName = (data.toolName || data.content || 'tool').replace(/^Using tool:\s*/i, '').replace(/^[^\s]+\s+Using tool:\s*/i, '').trim();
        setStatusText(data.content || 'Using tool\u2026');
        setStreamingPhase('tool');
        setThinkingContent('');
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
            ? { ...m, toolCalls: [...(m.toolCalls || []), { id: tid, name: tn, startedAt: now - 1000, endedAt: now, status: 'done' as const }] }
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
            ? { ...m, toolCalls: [...(m.toolCalls || []), { id: data.id || tid, name: data.name, arguments: data.arguments, startedAt: Date.now(), status: 'running' as const }] }
            : m
        ));
        break;
      }
      case 'toolResult': {
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
        // Don't create a new bubble — keep all text in a single streaming message.
        // Just acknowledge that a new segment started (for tool call boundaries).
        break;
      }
      case 'text': {
        const rawChunk = typeof data.content === 'string' ? data.content : '';
        if (rawChunk && isControlOnlyAssistantContent(rawChunk)) {
          break;
        }
        const safeChunk = typeof data.content === 'string'
          ? (data.replace === true ? sanitizeAssistantContent(data.content) : sanitizeAssistantChunk(data.content))
          : data.content;
        const nextText = mergeStreamText(safeChunk, { replace: data.replace === true });
        setStatusText(null);
        setStreamingPhase('streaming');
        setThinkingContent('');
        setActiveToolName(null);
        // Throttle UI updates to reduce re-renders during fast streaming.
        // Text is accumulated synchronously in assembledRef, but React state
        // updates are batched to TEXT_THROTTLE_MS intervals (default 50ms = 20fps).
        pendingTextUpdateRef.current = nextText;
        if (!textThrottleTimerRef.current) {
          textThrottleTimerRef.current = setTimeout(() => {
            textThrottleTimerRef.current = null;
            if (pendingTextUpdateRef.current !== null) {
              upsertStreamingAssistant(pendingTextUpdateRef.current);
              pendingTextUpdateRef.current = null;
            }
          }, TEXT_THROTTLE_MS);
        }
        break;
      }
      case 'done': {
        clearStreamWatchdog();
        if (textThrottleTimerRef.current) {
          clearTimeout(textThrottleTimerRef.current);
          textThrottleTimerRef.current = null;
        }
        pendingTextUpdateRef.current = null;

        const rawFinal = typeof data.content === 'string' ? data.content : '';
        const hasVisibleFinal = rawFinal.length > 0 && !isControlOnlyAssistantContent(rawFinal);
        const finalContent = hasVisibleFinal ? sanitizeAssistantContent(rawFinal) : assembledRef.current;
        assembledRef.current = finalContent;
        const prov = data.provenance || null;
        const model = normalizeProviderModel(providerRef.current, typeof data?.metadata?.model === 'string' ? data.metadata.model : (typeof data?.model === 'string' ? data.model : ''));
        const hadToolEvents = hasRealToolEventsRef.current;
        const currentStreamSegs = [...streamSegmentsRef.current];
        const shouldHideTurn = !finalContent.trim() && currentStreamSegs.length === 0 && !hadToolEvents;
        let cid = streamingAssistantIdRef.current;
        if (!cid && !shouldHideTurn) {
          cid = ensureStreamingAssistantBubble({ idPrefix: 'resume-done', content: '', resetIfCreated: false }).assistantId;
        }

        setStatusText(null);
        setStreamingPhase('idle');
        setThinkingContent('');
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
        currentRunIdRef.current = null;
        directClientRef.current?.setActiveStreamSession(null);
        assembledRef.current = '';
        lastSegmentStartRef.current = 0;
        lastRawTextLenRef.current = 0;

        const graduatedSegments: TextSegment[] = [];
        if (currentStreamSegs.length > 0 || (cid && hadToolEvents)) {
          for (const seg of currentStreamSegs) {
            graduatedSegments.push({ text: seg.text, position: 'before' });
          }
          if (finalContent && finalContent.trim()) {
            graduatedSegments.push({ text: finalContent, position: 'after' });
          }
        }

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
        break;
      }
      case 'error': {
        clearStreamWatchdog();
        if (textThrottleTimerRef.current) {
          clearTimeout(textThrottleTimerRef.current);
          textThrottleTimerRef.current = null;
        }
        pendingTextUpdateRef.current = null;
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
        compactionPhaseRef.current = 'idle';
        setCompactionPhase('idle');
        setIsRunning(false);
        currentRunIdRef.current = null;
        isStreamActiveRef.current = false;
        streamingAssistantIdRef.current = null;
        directClientRef.current?.setActiveStreamSession(null);
        assembledRef.current = '';
        break;
      }
      case 'exec_approval': {
        const approval = data.approval as ExecApprovalRequest;
        if (approval?.id) { setPendingApproval(approval); setStatusText('\u23f3 Waiting for command approval\u2026'); }
        break;
      }
      case 'exec_approval_resolved': {
        const resolved = data.resolved;
        if (resolved?.id) setPendingApproval(prev => (prev?.id === resolved.id ? null : prev));
        break;
      }
      case 'stream_resume': {
        applyOpenClawActiveStreamSnapshot({ ...data, active: true }, { statusTextWhenNoTool: 'Reconnecting to stream…', source: 'portal' });
        break;
      }
      case 'run_resumed': {
        if (!streamingAssistantIdRef.current) {
          console.log('[ChatState] run_resumed — waiting for visible stream event');
          break;
        }
        console.log('[ChatState] run_resumed — agent continuing after sub-agent');
        isStreamActiveRef.current = true;
        setIsRunning(true);
        setStreamingPhase('thinking');
        setStatusText('🧠 Agent is thinking…');
        resetStreamWatchdog();
        break;
      }
      case 'stream_ended': {
        clearStreamWatchdog();
        if (textThrottleTimerRef.current) {
          clearTimeout(textThrottleTimerRef.current);
          textThrottleTimerRef.current = null;
        }
        pendingTextUpdateRef.current = null;
        setStatusText(null);
        setStreamingPhase('idle');
        setThinkingContent('');
        setIsRunning(false);
        isStreamActiveRef.current = false;
        streamingAssistantIdRef.current = null;
        currentRunIdRef.current = null;
        directClientRef.current?.setActiveStreamSession(null);
        break;
      }
      case 'connected':
      case 'keepalive':
        break;
    }
  }, [applyOpenClawActiveStreamSnapshot, ensureStreamingAssistantBubble, normalizeAgentError, resetStreamWatchdog, clearStreamWatchdog, appendThinkingChunk, applyCompactionState, mergeStreamText, upsertStreamingAssistant]);

  // Keep handleWsEvent in a ref so the WS handler always calls the latest version
  const handleWsEventRef = useRef(handleWsEvent);
  useEffect(() => { handleWsEventRef.current = handleWsEvent; }, [handleWsEvent]);

  /**
   * Handle events from the direct gateway client.
   * Maps native gateway events to our internal event format.
   */
  const handleDirectGatewayEvent = useCallback((evt: GatewayEvent) => {
    const isStreamEvent = evt.event === 'chat' || evt.event === 'agent';
    if (streamTransportRef.current === 'portal' && isStreamActiveRef.current && isStreamEvent) {
      return;
    }

    if (evt.event === 'chat') {
      const payload = evt.payload;
      const state = payload.state;

      if (state === 'compacting' || state === 'compaction_start') {
        applyCompactionState('start');
        return;
      }
      if (state === 'compacted' || state === 'compaction_end') {
        applyCompactionState('end');
        return;
      }

      // Track current run for abort functionality
      if (payload.runId) {
        currentRunIdRef.current = payload.runId;
        directClientRef.current?.setActiveStreamSession(sessionRef.current || null);
      }
      streamTransportRef.current = 'direct';

      switch (state) {
        case 'delta': {
          const contentBlocks = Array.isArray(payload.message?.content)
            ? payload.message.content
            : [];

          let assistantId = streamingAssistantIdRef.current;

          const thinkingText = contentBlocks
            .filter((b: any) => b.type === 'thinking')
            .map((b: any) => b.text || '')
            .join('');

          const text = contentBlocks
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text || '')
            .join('');

          if (thinkingText && text && text.includes(thinkingText.slice(0, 50))) {
            console.warn('[CASCADE-DIAG] ⚠️ THINKING LEAK: thinking text found inside text blocks!', {
              thinkingLen: thinkingText.length,
              textLen: text.length,
              blockTypes: contentBlocks.map((b: any) => b.type),
            });
          }

          if (text && isControlOnlyAssistantContent(text)) {
            if (assistantId || isStreamActiveRef.current) resetStreamWatchdog();
            break;
          }

          const safeChunk = text ? sanitizeAssistantChunk(text) : '';
          const hasVisibleText = Boolean(safeChunk);
          if (!assistantId && hasVisibleText) {
            assistantId = ensureStreamingAssistantBubble({ idPrefix: 'direct', content: '', resetIfCreated: true }).assistantId;
            isStreamActiveRef.current = true;
            streamTransportRef.current = 'direct';
            setIsRunning(true);
            directClientRef.current?.setActiveStreamSession(sessionRef.current || null);
          }

          if (thinkingText) {
            appendThinkingChunk(
              assistantId,
              extractThinkingChunk('thinking', thinkingText, assembledRef.current.length > 0),
            );
            if (!assembledRef.current && assistantId) setStreamingPhase('thinking');
          }

          if (hasVisibleText) {
            const fullText = safeChunk;
            lastRawTextLenRef.current = fullText.length;

            const sliced = lastSegmentStartRef.current > 0
              ? fullText.slice(lastSegmentStartRef.current)
              : fullText;

            if (lastSegmentStartRef.current > 0 || fullText.length > 500) {
              console.log('[CASCADE-DIAG] delta:', {
                segStartRef: lastSegmentStartRef.current,
                fullTextLen: fullText.length,
                slicedLen: sliced.length,
                rawTextLen: text.length,
                sanitizedLen: safeChunk.length,
                contentBlockTypes: contentBlocks.map((b: any) => b.type),
              });
            }

            assembledRef.current = sliced;
            setStatusText(null);
            setStreamingPhase('streaming');
            setThinkingContent('');
            setActiveToolName(null);

            pendingTextUpdateRef.current = sliced;
            if (!textThrottleTimerRef.current) {
              textThrottleTimerRef.current = setTimeout(() => {
                textThrottleTimerRef.current = null;
                if (pendingTextUpdateRef.current !== null) {
                  upsertStreamingAssistant(pendingTextUpdateRef.current);
                  pendingTextUpdateRef.current = null;
                }
              }, TEXT_THROTTLE_MS);
            }
          }
          if (assistantId || isStreamActiveRef.current) resetStreamWatchdog();
          break;
        }
        case 'final': {
          clearStreamWatchdog();
          if (textThrottleTimerRef.current) {
            clearTimeout(textThrottleTimerRef.current);
            textThrottleTimerRef.current = null;
          }
          pendingTextUpdateRef.current = null;

          const finalTextBlocks = Array.isArray(payload.message?.content)
            ? payload.message.content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text || '')
                .join('')
            : '';
          let finalText = finalTextBlocks || assembledRef.current;
          if (lastSegmentStartRef.current > 0 && finalText.length > lastSegmentStartRef.current) {
            finalText = finalText.slice(lastSegmentStartRef.current);
          }

          const finalContent = isControlOnlyAssistantContent(finalText)
            ? assembledRef.current
            : sanitizeAssistantContent(finalText);
          assembledRef.current = finalContent;

          const hadToolEvents = hasRealToolEventsRef.current;
          const currentStreamSegs = [...streamSegmentsRef.current];
          const shouldHideTurn = !finalContent.trim() && currentStreamSegs.length === 0 && !hadToolEvents;
          let cid = streamingAssistantIdRef.current;
          if (!cid && !shouldHideTurn) {
            cid = ensureStreamingAssistantBubble({ idPrefix: 'direct-final', content: '', resetIfCreated: false }).assistantId;
          }

          setStatusText(null);
          setStreamingPhase('idle');
          setThinkingContent('');
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
          currentRunIdRef.current = null;
          directClientRef.current?.setActiveStreamSession(null);
          assembledRef.current = '';
          lastSegmentStartRef.current = 0;
          lastRawTextLenRef.current = 0;

          const graduatedSegments: TextSegment[] = [];
          if (currentStreamSegs.length > 0 || hadToolEvents) {
            for (const seg of currentStreamSegs) {
              graduatedSegments.push({ text: seg.text, position: 'before' });
            }
            if (finalContent && finalContent.trim()) {
              graduatedSegments.push({ text: finalContent, position: 'after' });
            }
          }

          if (cid) {
            if (shouldHideTurn) {
              setMessages(prev => prev.filter(m => m.id !== cid));
            } else {
              setMessages(prev => prev.map(m => {
                if (m.id !== cid) return m;
                const update: Partial<ChatMessage> = { content: finalContent };
                if (graduatedSegments.length > 0) {
                  update.segments = graduatedSegments;
                }
                return { ...m, ...update };
              }));
            }
          }
          break;
        }
        case 'aborted': {
          clearStreamWatchdog();
          if (textThrottleTimerRef.current) {
            clearTimeout(textThrottleTimerRef.current);
            textThrottleTimerRef.current = null;
          }
          pendingTextUpdateRef.current = null;

          const cid = streamingAssistantIdRef.current;
          const currentText = assembledRef.current;

          setStatusText(null);
          setStreamingPhase('idle');
          setIsRunning(false);
          setStreamSegments([]);
          isStreamActiveRef.current = false;
          streamTransportRef.current = null;
          streamingAssistantIdRef.current = null;
          currentRunIdRef.current = null;
          directClientRef.current?.setActiveStreamSession(null);

          if (cid && currentText) {
            setMessages(prev => prev.map(m =>
              m.id === cid ? { ...m, content: currentText + '\n\n*(cancelled)*' } : m
            ));
          }
          break;
        }
        case 'error': {
          clearStreamWatchdog();
          if (textThrottleTimerRef.current) {
            clearTimeout(textThrottleTimerRef.current);
            textThrottleTimerRef.current = null;
          }
          pendingTextUpdateRef.current = null;
          if (compactionTimerRef.current) {
            clearTimeout(compactionTimerRef.current);
            compactionTimerRef.current = null;
          }
          const errorMsg = normalizeAgentError(payload.errorMessage, 'Unknown error');
          const cid = streamingAssistantIdRef.current;

          setStatusText(null);
          setStreamingPhase('idle');
          setActiveToolName(null);
          compactionPhaseRef.current = 'idle';
          setCompactionPhase('idle');
          setIsRunning(false);
          isStreamActiveRef.current = false;
          streamTransportRef.current = null;
          streamingAssistantIdRef.current = null;
          currentRunIdRef.current = null;
          directClientRef.current?.setActiveStreamSession(null);
          assembledRef.current = '';

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

      if (payload.stream === 'tool' && payload.data) {
        const data = payload.data;
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
            // Graduate current streaming text into a finalized segment.
            // Use lastRawTextLenRef (the full gateway text length seen so far)
            // as the graduation offset. This is the KEY fix for the cascade bug:
            // assembledRef holds sliced text, but lastSegmentStartRef must track
            // position in the gateway's full accumulated text stream.
            if (assembledRef.current && assembledRef.current.trim().length > 0) {
              // DIAG: cascade debugging — log graduation math
              console.log('[CASCADE-DIAG] tool_start graduation:', {
                oldSegStartRef: lastSegmentStartRef.current,
                assembledLen: assembledRef.current.length,
                rawTextLen: lastRawTextLenRef.current,
                newSegStartRef: lastRawTextLenRef.current,
              });
              // Set graduation offset to the full raw text length seen from gateway,
              // NOT accumulated sliced lengths which drift when sanitization strips chars
              lastSegmentStartRef.current = lastRawTextLenRef.current;
              setStreamSegments(prev => [...prev, { text: assembledRef.current, ts: Date.now() }]);
              assembledRef.current = '';
              if (assistantId) {
                setMessages(prev => prev.map(m =>
                  m.id === assistantId ? { ...m, content: '' } : m
                ));
              }
            }
            const toolName = data.name || 'tool';
            setStatusText(`Using ${toolName}…`);
            setStreamingPhase('tool');
            setActiveToolName(toolName);

            const toolId = data.toolCallId || 'tool-' + (++toolCounterRef.current);
            if (assistantId) {
              setMessages(prev => prev.map(m =>
                m.id === assistantId
                  ? {
                      ...m,
                      toolCalls: [
                        ...(m.toolCalls || []),
                        {
                          id: toolId,
                          name: toolName,
                          arguments: data.args,
                          startedAt: Date.now(),
                          status: 'running' as const,
                        },
                      ],
                    }
                  : m
              ));
            }
            break;
          }
          case 'update': {
            // Partial result update — could update the tool call if needed
            break;
          }
          case 'result': {
            setStatusText(null);
            setActiveToolName(null);
            setStreamingPhase(assembledRef.current ? 'streaming' : 'thinking');

            const toolResult = typeof data.result === 'string'
              ? data.result
              : JSON.stringify(data.result);

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
                return { ...m, toolCalls: calls };
              }));
            }
            break;
          }
        }
      } else if (payload.stream === 'compaction') {
        const data = payload.data as any;
        const compactionSignal = String(data?.phase || data?.status || '').toLowerCase();
        if (compactionSignal === 'start' || compactionSignal === 'started' || compactionSignal === 'compacting') {
          applyCompactionState('start');
        } else if (compactionSignal === 'end' || compactionSignal === 'completed' || compactionSignal === 'compacted') {
          applyCompactionState('end');
        }
      }
    }
  }, [ensureStreamingAssistantBubble, normalizeAgentError, resetStreamWatchdog, clearStreamWatchdog, mergeStreamText, upsertStreamingAssistant, appendThinkingChunk, applyCompactionState]);

  // WS setup — runs once on mount, survives entire app lifetime
  // Handler registration MUST happen in the same effect that creates the manager,
  // otherwise wsManagerRef.current is null when the handler effect runs.
  useEffect(() => {
    const manager = getWsManager();
    wsManagerRef.current = manager;

    // Register the main event handler via ref indirection so it always calls latest
    const stableHandler = (data: any) => handleWsEventRef.current(data);
    manager.addHandler(stableHandler);

    const statusHandler = (data: any) => {
      if (data.type === 'connected') {
        setWsConnected(true);
        if (isStreamActiveRef.current) {
          debugLog('[ChatState] WS connected while stream active — sending reconnect');
          wsManagerRef.current?.send({ type: 'reconnect', session: sessionRef.current, provider: providerRef.current });
          resetStreamWatchdog();
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
      setWsConnected(false);
      if (isStreamActiveRef.current) {
        console.warn('[ChatState] WS disconnected during active stream');
        setIsRunning(true);
        setStreamingPhase(prev => prev === 'idle' ? 'thinking' : prev);
        setStatusText('Reconnecting to stream…');
      }
    });
    // On reconnect: for OpenClaw, reconcile from HTTP history first so one request
    // can restore both committed messages and the active-stream snapshot.
    const unsubReconnect = manager.onReconnect(async () => {
      setWsConnected(true);
      debugLog('[ChatState] WS reconnected — reconciling session state');
      try {
        await loadHistoryInternal(sessionRef.current, providerRef.current, { force: true });
      } catch (err) {
        console.warn('[ChatState] Reconnect sync failed:', err);
      }
    });

    return () => {
      manager.removeHandler(stableHandler);
      manager.removeHandler(statusHandler);
      unsubDisconnect();
      unsubReconnect();
      wsManagerRef.current = null;
      releaseWsManager();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Direct gateway client setup for OPENCLAW provider
  // When useDirectGateway is enabled and provider is OPENCLAW, use the direct
  // gateway connection instead of the portal WS middleman.
  // Gate on gateway health check first to avoid reconnect loops on fresh installs.
  useEffect(() => {
    // Only create direct client when:
    // 1. Feature flag is enabled
    // 2. Provider is OPENCLAW
    if (!useDirectGateway || provider !== 'OPENCLAW') {
      // Disconnect existing direct client if switching away from OPENCLAW
      if (directClientRef.current) {
        debugLog('[ChatState] Disconnecting direct gateway client (provider changed)');
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
        onEvent: handleDirectGatewayEvent,
        onConnected: () => {
          setWsConnected(true);
          // Subscribe to current session and reconcile from history snapshot.
          const currentSession = resolveOpenClawSessionKey(sessionRef.current);
          const currentProvider = providerRef.current;
          if (currentSession && currentSession !== sessionRef.current) {
            sessionRef.current = currentSession;
            setSessionRaw(currentSession);
            localStorage.setItem('agent-chat-session', currentSession);
          }
          if (currentSession && currentSession.startsWith('agent:')) {
            directClient.setCurrentSession(currentSession);
            loadHistoryInternal(currentSession, currentProvider, { force: true }).catch((err) => {
              console.warn('[ChatState] Direct reconnect history sync failed:', err);
            });
          }
        },
        onDisconnected: () => {
          setWsConnected(false);
          if (isStreamActiveRef.current) {
            console.warn('[ChatState] Direct gateway disconnected during active stream');
            setIsRunning(true);
            setStreamingPhase(prev => prev === 'idle' ? 'thinking' : prev);
            setStatusText('Reconnecting to stream…');
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
  }, [provider, handleDirectGatewayEvent, useDirectGateway]);

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
        } else {
          manager?.reconnect();
        }
      }

      if (isStreamActiveRef.current) {
        if (usingDirectGateway) {
          resetStreamWatchdog();
        } else {
          manager?.send({ type: 'reconnect', session: currentSession, provider: currentProvider });
          resetStreamWatchdog();
        }
        return;
      }
      try {
        if (currentProvider === 'OPENCLAW' && !usingDirectGateway) {
          await loadHistoryInternal(currentSession, currentProvider, { force: true });
          return;
        }
        debugLog('[ChatState] No active stream on visibility — reloading history for missed messages');
        await loadHistoryInternal(currentSession, currentProvider, { force: true });
      } catch (err) {
        console.warn('[ChatState] Visibility check failed:', err);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadHistoryInternal, resetStreamWatchdog, resolveOpenClawSessionKey, useDirectGateway]);

  // Clear messages helper — also invalidates any in-flight history load and
  // resets transient stream UI so switching sessions always starts clean.
  const clearMessages = useCallback(() => {
    historyGenRef.current++; // invalidate any in-flight loadHistoryInternal
    setMessages([]);
    setMessageQueue([]);
    setIsLoadingHistory(false);
    setStatusText(null);
    setLastProvenance(null);
    setStreamingPhase('idle');
    setActiveToolName(null);
    setThinkingContent('');
    setStreamSegments([]);
    compactionPhaseRef.current = 'idle';
    setCompactionPhase('idle');
    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = 0;
    toolCounterRef.current = 0;
    hasRealToolEventsRef.current = false;
    streamingAssistantIdRef.current = null;
    isStreamActiveRef.current = false;
    streamTransportRef.current = null;
    isQueueDrainActiveRef.current = false;
    if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
    if (streamWatchdogRef.current) { clearTimeout(streamWatchdogRef.current); streamWatchdogRef.current = null; }
    setIsRunning(false);
  }, []);

  // Resolve exec approval
  const resolveApproval = useCallback(async (
    approvalId: string,
    decision: 'allow-once' | 'deny' | 'allow-always',
  ) => {
    try {
      const response = await client.post('/gateway/exec-approval/resolve', { approvalId, decision });
      if (response.data?.ok) {
        setPendingApproval(null);
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

  const dismissApproval = useCallback(() => { setPendingApproval(null); }, []);

  const clearQueue = useCallback(() => {
    setMessageQueue([]);
    setMessages(prev => prev.filter(m => !m.queued));
  }, []);

  const removeQueuedMessage = useCallback((id: string) => {
    setMessageQueue(prev => prev.filter(item => item.id !== id));
    setMessages(prev => prev.filter(m => m.id !== id));
  }, []);

  // Send message via WS (with SSE fallback)
  const sendMessage = useCallback(async (text: string) => {
    const normalized = String(text || '').trim();
    if (!normalized) return;

    const shouldInjectIntoActiveTurn = providerRef.current === 'OPENCLAW' && isStreamActiveRef.current;
    if (shouldInjectIntoActiveTurn) {
      try {
        const targetSession = resolveOpenClawSessionKey(sessionRef.current || 'main');
        const directClient = directClientRef.current;
        if (useDirectGateway && directClient?.isConnected) {
          await directClient.injectMessage(targetSession, normalized);
        } else {
          const manager = wsManagerRef.current;
          if (manager && manager.isConnected()) {
            const sent = manager.send({ type: 'inject', session: targetSession, text: normalized });
            if (!sent) {
              await client.post('/gateway/chat/inject', { session: targetSession, text: normalized });
            }
          } else {
            await client.post('/gateway/chat/inject', { session: targetSession, text: normalized });
          }
        }

        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: `Steer sent to running OpenClaw turn: ${normalized}`,
          createdAt: new Date(),
          provenance: 'live-steer',
        }]);
        setStatusText('Steer sent to running OpenClaw turn');
        setTimeout(() => setStatusText((curr) => curr === 'Steer sent to running OpenClaw turn' ? null : curr), 2200);
      } catch (err: any) {
        console.error('[ChatState] Failed to inject note into active OpenClaw turn:', err);
        setStatusText(`⚠️ ${normalizeAgentError(err, 'Live steer failed')}`);
        setTimeout(() => setStatusText(null), 4000);
      }
      return;
    }

    const shouldQueue = isStreamActiveRef.current || (!isQueueDrainActiveRef.current && messageQueueRef.current.length > 0);
    if (shouldQueue) {
      const queuedId = nextId();
      const queuedAt = Date.now();
      setMessages(prev => [...prev, {
        id: queuedId,
        role: 'user',
        content: normalized,
        createdAt: new Date(queuedAt),
        queued: true,
      }]);
      setMessageQueue(prev => [...prev, { id: queuedId, text: normalized, createdAt: queuedAt }]);
      return;
    }

    // Add user message to UI
    const userMsg: ChatMessage = {
      id: nextId(),
      role: 'user',
      content: normalized,
      createdAt: new Date(),
    };
    setMessages(prev => [...prev, userMsg]);

    // Reset streaming state
    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    lastRawTextLenRef.current = 0;
    toolCounterRef.current = 0;
    hasRealToolEventsRef.current = false;
    setThinkingContent('');
    setStreamSegments([]);
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
    setMessages(prev => [...prev, assistantMsg]);
    setIsRunning(true);
    isStreamActiveRef.current = true;
    resetStreamWatchdog();

    // For OPENCLAW with direct gateway enabled, use the direct client
    const directClient = directClientRef.current;
    if (useDirectGateway && providerRef.current === 'OPENCLAW' && directClient?.isConnected) {
      try {
        streamTransportRef.current = 'direct';
        const currentSession = resolveOpenClawSessionKey(sessionRef.current || 'main');
        if (currentSession !== sessionRef.current) {
          sessionRef.current = currentSession;
          setSessionRaw(currentSession);
          localStorage.setItem('agent-chat-session', currentSession);
        }
        debugLog('[ChatState] Sending via direct gateway to session:', currentSession);
        const runId = await directClient.sendMessage(currentSession, normalized);
        currentRunIdRef.current = runId;
        debugLog('[ChatState] Direct send initiated, runId:', runId);
        // Events will come through handleDirectGatewayEvent
      } catch (err: any) {
        console.error('[ChatState] Direct gateway send failed:', err);
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
        session: resolveOpenClawSessionKey(sessionRef.current || 'main') || 'main',
      };
      if (providerRef.current) payload.provider = providerRef.current;
      if (modelRef.current) payload.model = modelRef.current;
      if (agentIdRef.current) payload.agentId = agentIdRef.current;
      const sent = manager.send(payload);
      if (!sent) {
        try {
          await sendViaSSE(normalized, assistantId);
        } catch (err: any) {
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
        await sendViaSSE(normalized, assistantId);
      } catch (err: any) {
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
  }, [normalizeAgentError, resetStreamWatchdog, resolveOpenClawSessionKey, useDirectGateway]);

  const drainNextQueuedMessage = useCallback(() => {
    if (isStreamActiveRef.current || isQueueDrainActiveRef.current) return;
    const next = messageQueueRef.current[0];
    if (!next) return;

    isQueueDrainActiveRef.current = true;
    setMessageQueue(prev => prev.slice(1));
    setMessages(prev => prev.filter(m => m.id !== next.id));
    void sendMessage(next.text).finally(() => {
      isQueueDrainActiveRef.current = false;
    });
  }, [sendMessage]);

  // SSE fallback sender
  const sendViaSSE = useCallback(async (text: string, initialAssistantId: string) => {
    let assembled = '';
    let assistantId = initialAssistantId;
    streamTransportRef.current = 'portal';

    const apiUrl = import.meta.env.VITE_API_URL || '';
    const body: Record<string, unknown> = {
      message: text,
      session: resolveOpenClawSessionKey(sessionRef.current || 'main') || 'main',
    };
    if (providerRef.current) body.provider = providerRef.current;
    if (modelRef.current) body.model = modelRef.current;
    if (agentIdRef.current) body.agentId = agentIdRef.current;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const response = await fetch(apiUrl + '/gateway/send?stream=1', {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let errorMessage = `Gateway error: ${response.status}`;
      try {
        const text = await response.text();
        if (text) {
          const parsed = JSON.parse(text);
          errorMessage = parsed?.error || parsed?.detail || errorMessage;
        }
      } catch {}
      throw new Error(errorMessage);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No stream body');

    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
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
          if (evt.type === 'session') {
            if (evt.sessionId) { setSessionRaw(evt.sessionId); localStorage.setItem('agent-chat-session', evt.sessionId); }
            if (evt.provenance) setLastProvenance(evt.provenance);
          } else if (evt.type === 'text') {
            const rawChunk = typeof evt.content === 'string' ? evt.content : '';
            if (rawChunk && isControlOnlyAssistantContent(rawChunk)) {
              continue;
            }
            const chunk = typeof evt.content === 'string' ? sanitizeAssistantContent(evt.content) : '';
            assembled = mergeAssistantStream(assembled, chunk, { replace: evt.replace === true });
            setStreamingPhase('streaming');
            setStatusText(null);
            setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: assembled } : m));
          } else if (evt.type === 'status') {
            setStatusText(evt.content);
            if (providerRef.current !== 'OPENCLAW') {
              const thinkingChunk = extractThinkingChunk('status', evt.content, assembled.length > 0);
              appendThinkingChunk(assistantId, thinkingChunk);
            }
            if (!assembled) setStreamingPhase('thinking');
          } else if (evt.type === 'thinking') {
            const thinkingChunk = extractThinkingChunk('thinking', evt.content, assembled.length > 0);
            appendThinkingChunk(assistantId, thinkingChunk);
            if (!assembled) setStreamingPhase('thinking');
          } else if (evt.type === 'tool_start' || evt.type === 'tool_used') {
            const tn = (evt.toolName || evt.content || 'tool').replace(/^Using tool:\s*/i, '').trim();
            setStreamingPhase('tool');
            setActiveToolName(tn);
          } else if (evt.type === 'tool_end') {
            setStreamingPhase(assembled ? 'streaming' : 'thinking');
            setActiveToolName(null);
          } else if (evt.type === 'segment_break') {
            // Don't create a new bubble — keep all text in a single streaming message.
          } else if (evt.type === 'done') {
            const rawFinal = typeof evt.content === 'string' ? evt.content : '';
            const hasFinal = rawFinal.length > 0 && !isControlOnlyAssistantContent(rawFinal);
            const finalContent = hasFinal ? sanitizeAssistantContent(rawFinal) : (assembled || '');
            assembled = finalContent;
            const prov = evt.provenance || null;
            setMessages(prev => prev.map(m =>
              m.id === assistantId ? { ...m, content: finalContent, provenance: prov || undefined } : m
            ));
            setStreamingPhase('idle');
            setIsRunning(false);
            setLastProvenance(prov);
            isStreamActiveRef.current = false;
            streamingAssistantIdRef.current = null;
            directClientRef.current?.setActiveStreamSession(null);
            drainNextQueuedMessage();
          } else if (evt.type === 'error') {
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
            compactionPhaseRef.current = 'idle';
            setCompactionPhase('idle');
            setIsRunning(false);
            currentRunIdRef.current = null;
            isStreamActiveRef.current = false;
            streamingAssistantIdRef.current = null;
            directClientRef.current?.setActiveStreamSession(null);
          } else if (evt.type === 'exec_approval') {
            if (evt.approval?.id) { setPendingApproval(evt.approval); setStatusText('\u23f3 Waiting for command approval\u2026'); }
          }
        } catch { /* ignore parse errors */ }
      }
      if (done) break;
    }
  }, [appendThinkingChunk, clearStreamWatchdog, normalizeAgentError, resolveOpenClawSessionKey]);

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
  const cancelStream = useCallback(async () => {
    try {
      // For OPENCLAW with direct gateway, use the direct client for abort
      const directClient = directClientRef.current;
      if (useDirectGateway && providerRef.current === 'OPENCLAW' && directClient?.isConnected) {
        const currentSession = sessionRef.current;
        const runId = currentRunIdRef.current;
        debugLog('[ChatState] Aborting via direct gateway, session:', currentSession, 'runId:', runId);
        await directClient.abortRun(currentSession, runId || undefined);
      } else {
        const manager = wsManagerRef.current;
        if (manager && manager.isConnected()) {
          manager.send({ type: 'abort', session: sessionRef.current, provider: providerRef.current });
        } else {
          await client.post('/gateway/chat/abort', { session: sessionRef.current, provider: providerRef.current });
        }
      }
    } catch (err) {
      console.error('[ChatState] Failed to cancel stream:', err);
    } finally {
      clearStreamWatchdog();
      isStreamActiveRef.current = false;
      setIsRunning(false);
      setStreamingPhase('idle');
      setStatusText(null);
      compactionPhaseRef.current = 'idle';
      setCompactionPhase('idle');
      currentRunIdRef.current = null;
      if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
      const cid = streamingAssistantIdRef.current;
      if (cid) {
        const ft = assembledRef.current;
        if (ft) setMessages(prev => prev.map(m => m.id === cid ? { ...m, content: ft + '\n\n*(cancelled)*' } : m));
        streamingAssistantIdRef.current = null;
      }
    }
  }, [clearStreamWatchdog, useDirectGateway]);

  // Session controls: check if supported (OPENCLAW with concrete session)
  const sessionControlsSupported = provider === 'OPENCLAW' && session.startsWith('agent:');

  const setThinkingLevel = useCallback(async (nextLevel: ThinkingLevel) => {
    if (!sessionControlsSupported) return;
    try {
      await gatewayAPI.patchSession(session, { thinking: nextLevel }, provider);
      setThinkingLevelState(nextLevel);
    } catch (err) {
      console.error('[ChatState] Failed to patch thinking level:', err);
    }
  }, [sessionControlsSupported, session, provider]);

  const reconnectSocket = useCallback(() => {
    if (useDirectGateway && providerRef.current === 'OPENCLAW' && directClientRef.current) {
      directClientRef.current.disconnect();
      directClientRef.current.connect();
      return;
    }
    wsManagerRef.current?.reconnect();
  }, [useDirectGateway]);

  const toggleFastMode = useCallback(async () => {
    if (!sessionControlsSupported) return;
    try {
      await gatewayAPI.patchSession(session, { fastMode: !fastModeEnabled }, provider);
      setFastModeEnabled((prev) => !prev);
    } catch (err) {
      console.error('[ChatState] Failed to toggle fast mode:', err);
    }
  }, [sessionControlsSupported, fastModeEnabled, session, provider]);

  const setCompactionModelOverride = useCallback(async (model: string) => {
    setCompactionModelLoading(true);
    try {
      const normalized = String(model || '').trim();
      const patchResult = await gatewayAPI.patchConfigPath('agents.defaults.compaction.model', normalized || null);
      const patchedValue = typeof patchResult?.value === 'string' ? patchResult.value.trim() : '';
      setCompactionModelOverrideState(patchedValue);
      const fresh = await gatewayAPI.getConfigPath('agents.defaults.compaction.model');
      const freshValue = typeof fresh?.value === 'string' ? fresh.value.trim() : '';
      setCompactionModelOverrideState(freshValue);
    } catch (err) {
      console.error('[ChatState] Failed to patch compaction model override:', err);
    } finally {
      setCompactionModelLoading(false);
    }
  }, []);


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
    isSwitchingSession,
    streamingPhase,
    activeToolName,
    statusText,
    lastProvenance,
    thinkingContent,
    streamSegments,
    compactionPhase,
    wsConnected,
    pendingApproval,
    resolveApproval,
    dismissApproval,
    provider,
    setProvider,
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
    selectSession,
    refreshChat,
    wsManager: wsManagerRef.current,
    reconnectSocket,
    // Session controls
    thinkingLevel,
    setThinkingLevel,
    fastModeEnabled,
    toggleFastMode,
    compactionModelOverride,
    setCompactionModelOverride,
    compactionModelLoading,
    compactionModelError,
    sessionControlsSupported,
    ensureSessionControlsMetadataLoaded,
  };

  return (
    <ChatStateContext.Provider value={contextValue}>
      {children}
    </ChatStateContext.Provider>
  );
}
