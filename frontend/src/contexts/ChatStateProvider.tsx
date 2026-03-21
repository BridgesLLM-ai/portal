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
import {
  extractThinkingChunk,
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

const DEBUG_CHAT_STATE = import.meta.env.DEV;
// Feature flag: Use direct gateway connection for OPENCLAW provider
// Set to true to bypass the portal WS middleman
const USE_DIRECT_GATEWAY = import.meta.env.VITE_USE_DIRECT_GATEWAY === 'true';
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

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'toolResult';
  content: string;
  createdAt: Date;
  provenance?: string;
  toolCalls?: ToolCall[];
  thinkingContent?: string;
  toolCallId?: string;
  toolName?: string;
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

function normalizeProviderModel(provider: string, rawModel: string): string {
  const model = String(rawModel || '').trim();
  if (!model) return '';
  if (provider === 'OPENCLAW' || provider === 'OLLAMA' || provider === 'GEMINI') return model;

  const lower = model.toLowerCase();
  if (provider === 'CLAUDE_CODE' && (lower.startsWith('anthropic/') || lower.startsWith('claude/'))) {
    return model.split('/').slice(1).join('/') || model;
  }
  if (provider === 'CODEX' && (lower.startsWith('openai-codex/') || lower.startsWith('openai/'))) {
    return model.split('/').slice(1).join('/') || model;
  }
  return model;
}

function parseHistoryMessage(m: any): ChatMessage {
  const msg: ChatMessage = {
    id: m.id || nextId(),
    role: m.role,
    content: m.role === 'assistant'
      ? sanitizeAssistantContent(m.content || '')
      : (m.content || ''),
    createdAt: new Date(m.timestamp || Date.now()),
    provenance: m.provenance,
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
function mapGatewayMessage(msg: GatewayChatMessage): ChatMessage {
  const text = extractTextFromGatewayMessage(msg);
  const toolCalls = extractToolCallsFromGatewayMessage(msg);
  const thinking = extractThinkingFromGatewayMessage(msg);

  return {
    id: msg.id || msg.messageId || `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: msg.role as 'user' | 'assistant' | 'system' | 'toolResult',
    content: msg.role === 'assistant' ? sanitizeAssistantContent(text) : text,
    createdAt: new Date(msg.timestamp || Date.now()),
    toolCalls,
    thinkingContent: thinking,
  };
}

function dedupeHistoryMessages(messages: ChatMessage[]): ChatMessage[] {
  const seenIds = new Set<string>();
  const seenSignatures = new Set<string>();
  const deduped: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.id && seenIds.has(msg.id)) continue;
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
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  clearMessages: () => void;
  isRunning: boolean;
  isLoadingHistory: boolean;
  isSwitchingSession: boolean;
  streamingPhase: StreamingPhase;
  activeToolName: string | null;
  statusText: string | null;
  lastProvenance: string | null;
  thinkingContent: string;
  isCompacting: boolean;
  wsConnected: boolean;
  pendingApproval: ExecApprovalRequest | null;
  resolveApproval: (approvalId: string, decision: 'approve' | 'deny' | 'always') => Promise<void>;
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
}

const ChatStateContext = createContext<ChatStateContextValue | null>(null);

export function useChatState(): ChatStateContextValue {
  const ctx = useContext(ChatStateContext);
  if (!ctx) throw new Error('useChatState must be used within ChatStateProvider');
  return ctx;
}

/* ═══ Provider Component ═══ */

export function ChatStateProvider({ children }: { children: React.ReactNode }) {
  // Persisted selection state
  const [provider, setProviderRaw] = useState(
    () => localStorage.getItem('agent-chat-provider') || 'OPENCLAW',
  );
  const [session, setSessionRaw] = useState(
    () => localStorage.getItem('agent-chat-session') || 'main',
  );
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
    localStorage.setItem('agent-chat-session', s);
    setSessionRaw(s);
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
  const [isRunning, setIsRunning] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isSwitchingSession, setIsSwitchingSession] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [lastProvenance, setLastProvenance] = useState<string | null>(null);
  const [streamingPhase, setStreamingPhase] = useState<StreamingPhase>('idle');
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  const [thinkingContent, setThinkingContent] = useState<string>('');
  const [pendingApproval, setPendingApproval] = useState<ExecApprovalRequest | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);

  // Refs
  const streamWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const STREAM_TIMEOUT_MS = 60_000;
  const compactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolCounterRef = useRef(0);
  const hasRealToolEventsRef = useRef(false);
  const wsManagerRef = useRef<WsManager | null>(null);
  // Direct gateway client for OPENCLAW provider (bypasses portal WS middleman)
  const directClientRef = useRef<OpenClawGatewayClient | null>(null);
  const directClientConnectedRef = useRef(false);
  const currentRunIdRef = useRef<string | null>(null);
  const streamingAssistantIdRef = useRef<string | null>(null);
  const assembledRef = useRef('');
  const lastSegmentStartRef = useRef(0);
  const isStreamActiveRef = useRef(false);
  const sessionRef = useRef(session);
  const providerRef = useRef(provider);
  const agentIdRef = useRef(agentId);
  const modelRef = useRef(selectedModel);
  // Monotonically-incrementing generation counter — incremented on every session
  // switch or clearMessages. Any async history load that started in a previous
  // generation simply discards its result, eliminating race conditions.
  const historyGenRef = useRef(0);
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

  useEffect(() => {
    let cancelled = false;

    const syncSelectedSessionModel = async () => {
      if (provider !== 'OPENCLAW' || !session || !session.startsWith('agent:')) return;
      try {
        // Use silent mode — 404 is expected for expired/stale sessions and
        // should not trigger error sounds or the ErrorPanel.
        const data = await gatewayAPI.sessionInfo(session, { silent: true });
        const actualModel = deriveSessionModel(data?.session);
        if (!cancelled && actualModel) {
          setSelectedModelRaw((prev) => (prev === actualModel ? prev : actualModel));
        }
      } catch {
        // Keep the locally selected model if the session lookup fails.
      }
    };

    syncSelectedSessionModel();
    return () => { cancelled = true; };
  }, [provider, session, deriveSessionModel]);

  // Stream watchdog
  const resetStreamWatchdog = useCallback(() => {
    if (streamWatchdogRef.current) clearTimeout(streamWatchdogRef.current);
    if (!isStreamActiveRef.current) return;
    streamWatchdogRef.current = setTimeout(() => {
      if (!isStreamActiveRef.current) return;
      console.warn('[ChatState] Stream watchdog: no activity for 60s');
      isStreamActiveRef.current = false;
      setIsRunning(false);
      setStreamingPhase('idle');
      setStatusText(null);
      setIsCompacting(false);
      if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
      const cid = streamingAssistantIdRef.current;
      if (cid) {
        const ft = assembledRef.current;
        if (ft) {
          setMessages(prev => prev.map(m =>
            m.id === cid ? { ...m, content: ft + '\n\n*(stream interrupted)*' } : m
          ));
        }
        streamingAssistantIdRef.current = null;
      }
    }, STREAM_TIMEOUT_MS);
  }, []);
  const clearStreamWatchdog = useCallback(() => {
    if (streamWatchdogRef.current) { clearTimeout(streamWatchdogRef.current); streamWatchdogRef.current = null; }
  }, []);

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

  // History loader
  const loadHistoryInternal = useCallback(async (sessionKey: string, prov?: string, options?: { force?: boolean }): Promise<void> => {
    if (!sessionKey || (isStreamActiveRef.current && !options?.force)) return;
    // Snapshot the current generation — if it changes while we await, discard results.
    const myGen = ++historyGenRef.current;
    setIsLoadingHistory(true);

    const loadViaHttp = async (): Promise<ChatMessage[]> => {
      const params: Record<string, string> = { session: sessionKey, enhanced: '1' };
      if (prov) params.provider = prov;
      const { data } = await client.get('/gateway/history', { params });
      return data.messages ? data.messages.map(parseHistoryMessage) : [];
    };

    // Load via direct gateway client for OPENCLAW
    const loadViaDirect = async (): Promise<ChatMessage[]> => {
      const directClient = directClientRef.current;
      if (!directClient?.isConnected) {
        throw new Error('Direct gateway not connected');
      }
      const result = await directClient.loadHistory(sessionKey);
      return result.messages.map(mapGatewayMessage);
    };

    try {
      let loaded: ChatMessage[];

      // Try direct gateway for OPENCLAW when enabled
      const directClient = directClientRef.current;
      if (USE_DIRECT_GATEWAY && prov === 'OPENCLAW' && directClient?.isConnected) {
        try {
          debugLog('[ChatState] Loading history via direct gateway');
          loaded = await loadViaDirect();
        } catch (err) {
          console.warn('[ChatState] Direct gateway history failed; falling back to HTTP', err);
          loaded = await loadViaHttp();
        }
      } else {
        // Use existing portal WS or HTTP path
        const manager = wsManagerRef.current;
        if (manager && manager.isConnected()) {
          try {
            loaded = await new Promise<ChatMessage[]>((resolve, reject) => {
              const requestId = 'hist-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
              const handler = (data: any) => {
                if (data.type === 'history' && data.requestId === requestId) {
                  clearTimeout(timeout);
                  manager.removeHandler(handler);
                  resolve((data.messages || []).map(parseHistoryMessage));
                } else if (data.type === 'error' && data.requestId === requestId) {
                  clearTimeout(timeout);
                  manager.removeHandler(handler);
                  reject(new Error(data.content || 'History request failed'));
                }
              };
              const timeout = setTimeout(() => {
                manager.removeHandler(handler);
                reject(new Error('History timeout'));
              }, 5000);
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
      if (historyGenRef.current === myGen) setMessages(mergeToolResultsIntoToolCalls(dedupeHistoryMessages(loaded)));
    } catch (err) {
      console.error('[ChatState] History load failed:', err);
      if (historyGenRef.current === myGen) setMessages([]);
    } finally {
      if (historyGenRef.current === myGen) {
        setIsLoadingHistory(false);
        setIsSwitchingSession(false);
      }
    }
  }, []);

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
    setIsCompacting(false);
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
    debugLog('[ChatState] Manual refresh — reloading history + checking stream');
    try {
      // 1. Always reload committed history first (applies server-side text filtering
      //    and merges tool results into pills — live streaming accumulates text that
      //    includes pre-tool narration, which the JSONL parser strips out).
      await loadHistoryInternal(currentSession, currentProvider, { force: true });

      // 2. Then check if there's an active stream we should reconnect to
      const params: Record<string, string> = { session: currentSession };
      if (currentProvider) params.provider = currentProvider;
      const { data } = await client.get('/gateway/stream-status', { params });
      if (data.active) {
        debugLog('[ChatState] Active stream found on refresh — resubscribing');
        isStreamActiveRef.current = true;
        setIsRunning(true);
        setStreamingPhase(data.phase === 'tool' ? 'tool' : data.phase === 'streaming' ? 'streaming' : 'thinking');
        if (data.toolName) setActiveToolName(data.toolName);
        if (typeof data.content === 'string' && data.content.length > 0) {
          const safeText = sanitizeAssistantContent(data.content);
          mergeStreamText(safeText, { replace: true });
          upsertStreamingAssistant(safeText);
        }
        wsManagerRef.current?.send({ type: 'reconnect', session: currentSession });
      } else if (isStreamActiveRef.current) {
        // Stream ended — clean up
        isStreamActiveRef.current = false;
        setIsRunning(false);
        setStreamingPhase('idle');
        setStatusText(null);
      }
    } catch (err) {
      console.error('[ChatState] Refresh error:', err);
      // Still try to reload history even if stream-status fails
      try { await loadHistoryInternal(currentSession, currentProvider); } catch {}
    }
  }, [loadHistoryInternal]);

  // Load history when session/provider changes.
  // We intentionally do NOT call clearMessages here — the caller (handleSelectSession,
  // handleSelectAgent, etc.) already clears before setting the new session, so the
  // messages array is already empty by the time this effect fires.
  useEffect(() => {
    if (session && !isStreamActiveRef.current) {
      setIsLoadingHistory(true); // show spinner immediately, before async fetch
      loadHistoryInternal(session, provider);
    }
  }, [session, provider, loadHistoryInternal]);

  // WS event handler — processes events even when chat page is unmounted
  const handleWsEvent = useCallback((data: any) => {
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
    // Some event types are allowed without an assistant bubble (session metadata, approvals, etc.).
    // 'run_resumed' signals the agent resumed after a sub-agent — we need to create a new bubble.
    // Stream events (text, tool_*, thinking) after a done also need a new bubble (agent resumed).
    const passthrough = ['session', 'exec_approval', 'exec_approval_resolved', 'connected', 'keepalive', 'compaction_start', 'compaction_end', 'stream_resume', 'stream_ended', 'run_resumed'];
    const streamTypes = ['text', 'thinking', 'tool_start', 'tool_end', 'tool_used', 'status', 'segment_break', 'done'];
    if (!streamingAssistantIdRef.current && !passthrough.includes(data.type)) {
      if (streamTypes.includes(data.type) && data.type !== 'done') {
        // Agent resumed after a sub-agent or multi-run — create a new assistant bubble
        console.log(`[ChatState] Agent resumed (${data.type}) — creating new assistant bubble`);
        const resumeId = 'resume-' + Date.now();
        streamingAssistantIdRef.current = resumeId;
        assembledRef.current = '';
        lastSegmentStartRef.current = 0;
        toolCounterRef.current = 0;
        hasRealToolEventsRef.current = false;
        setThinkingContent('');
        setMessages(prev => [...prev, {
          id: resumeId,
          role: 'assistant' as const,
          content: '',
          createdAt: new Date(),
          toolCalls: [],
        }]);
        isStreamActiveRef.current = true;
        setIsRunning(true);
        resetStreamWatchdog();
        // Don't return — fall through to process this event with the new assistantId
      } else {
        if (data.type !== 'done') {
          console.warn(`[ChatState] DROPPED event: type=${data.type} (no assistantId)`);
        }
        return;
      }
    }
    // Read assistantId AFTER potential bubble creation so it picks up the new ref
    const assistantId = streamingAssistantIdRef.current;
    resetStreamWatchdog();

    switch (data.type) {
      case 'session': {
        if (data.sessionId) {
          setSessionRaw(data.sessionId);
          localStorage.setItem('agent-chat-session', data.sessionId);
        }
        if (data.provenance) setLastProvenance(data.provenance);
        break;
      }
      case 'status': {
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
        appendThinkingChunk(assistantId, extractThinkingChunk('thinking', data.content, assembledRef.current.length > 0));
        if (!assembledRef.current) setStreamingPhase('thinking');
        break;
      }
      case 'compaction_start': {
        if (providerRef.current !== 'OPENCLAW') break;
        setIsCompacting(true);
        // Clear thinking content — old thoughts are being compacted away anyway
        setThinkingContent('');
        setStatusText('Compacting context… stream may pause briefly');
        // Use 'system' role so it renders as a centered notification pill, not an assistant bubble
        setMessages(prev => {
          const marker = '⚙️ Context compaction in progress. Stream may pause briefly while the session is compressed.';
          const last = prev[prev.length - 1];
          if (last?.role === 'system' && last.content === marker) return prev;
          return [...prev, {
            id: 'compaction-start-' + Date.now(),
            role: 'system' as const,
            content: marker,
            createdAt: new Date(),
          }];
        });
        if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
        break;
      }
      case 'compaction_end': {
        if (providerRef.current !== 'OPENCLAW') break;
        compactionTimerRef.current = setTimeout(() => { setIsCompacting(false); compactionTimerRef.current = null; }, 3000);
        setStatusText('Context compacted. Reconnecting stream…');
        // Use 'system' role so it renders as a centered notification pill, not an assistant bubble
        setMessages(prev => {
          const marker = '✅ Context compaction finished. Reconnecting to the live stream now.';
          const last = prev[prev.length - 1];
          if (last?.role === 'system' && last.content === marker) return prev;
          return [...prev, {
            id: 'compaction-end-' + Date.now(),
            role: 'system' as const,
            content: marker,
            createdAt: new Date(),
          }];
        });
        window.setTimeout(() => {
          setStatusText(curr => curr === 'Context compacted. Reconnecting stream…' ? null : curr);
        }, 4000);
        break;
      }
      case 'tool_start': {
        hasRealToolEventsRef.current = true;
        const toolName = (data.toolName || data.content || 'tool').replace(/^Using tool:\s*/i, '').replace(/^[^\s]+\s+Using tool:\s*/i, '').trim();
        setStatusText(data.content || 'Using tool\u2026');
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
        const safeChunk = typeof data.content === 'string'
          ? (data.replace === true ? sanitizeAssistantContent(data.content) : sanitizeAssistantChunk(data.content))
          : data.content;
        const nextText = mergeStreamText(safeChunk, { replace: data.replace === true });
        setStatusText(null);
        setStreamingPhase('streaming');
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
        // Flush any pending throttled text update immediately
        if (textThrottleTimerRef.current) {
          clearTimeout(textThrottleTimerRef.current);
          textThrottleTimerRef.current = null;
        }
        pendingTextUpdateRef.current = null;
        const hasFinal = typeof data.content === 'string' && data.content.length > 0;
        const finalContent = hasFinal ? sanitizeAssistantContent(data.content) : assembledRef.current;
        assembledRef.current = finalContent;
        const prov = data.provenance || null;
        const cid = streamingAssistantIdRef.current;
        
        // Check if tools were used during this streaming session — we'll reload
        // history to get the clean server-side formatted tool results.
        const hadToolEvents = hasRealToolEventsRef.current;
        
        setStatusText(null);
        setStreamingPhase('idle');
        setLastProvenance(prov);
        setIsRunning(false);
        setIsCompacting(false);
        if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
        // Mark stream as inactive but DON'T null out streamingAssistantIdRef yet.
        // The agent may resume after a sub-agent completes (sessions_yield flow).
        // The guard at the top of handleWsEvent will create a new bubble when
        // stream events arrive without an active assistantId.
        isStreamActiveRef.current = false;
        streamingAssistantIdRef.current = null;
        // Reset text accumulator so the next run segment starts fresh
        assembledRef.current = '';
        lastSegmentStartRef.current = 0;
        setMessages(prev => prev.map(m =>
          m.id === cid ? { ...m, content: finalContent, provenance: prov || undefined } : m
        ));
        
        // Pattern from OpenClaw web UI v2: reload history when tools were used
        // so the persisted tool results replace the streaming artifacts.
        // This ensures tool results are properly nested in their pills.
        if (hadToolEvents) {
          debugLog('[ChatState] Tools were used — scheduling history reload');
          setTimeout(() => {
            // Double-check we're still on the same session before reloading
            const currentSession = sessionRef.current;
            const currentProvider = providerRef.current;
            if (currentSession) {
              loadHistoryInternal(currentSession, currentProvider, { force: true });
            }
          }, 200); // Brief delay to let server commit the JSONL
        }
        break;
      }
      case 'error': {
        if (assistantId) {
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, content: '\u26a0\ufe0f ' + (data.content || 'Unknown error') } : m
          ));
        }
        setStatusText(null);
        setStreamingPhase('idle');
        setIsRunning(false);
        isStreamActiveRef.current = false;
        streamingAssistantIdRef.current = null;
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
        // Backend detected an active stream on reconnect — preserve the current bubble if it exists.
        if (!streamingAssistantIdRef.current) {
          const resumeId = 'stream-resume-' + Date.now();
          streamingAssistantIdRef.current = resumeId;
          setMessages(prev => [...prev, {
            id: resumeId,
            role: 'assistant' as const,
            content: '',
            createdAt: new Date(),
            toolCalls: [],
          }]);
        }
        isStreamActiveRef.current = true;
        setIsRunning(true);
        setStreamingPhase(data.phase === 'tool' ? 'tool' : data.phase === 'streaming' ? 'streaming' : 'thinking');
        setActiveToolName(data.toolName || null);
        if (data.toolName) setStatusText(`Using ${data.toolName}…`);
        if (typeof data.content === 'string') {
          const nextText = mergeStreamText(sanitizeAssistantContent(data.content), { replace: true });
          upsertStreamingAssistant(nextText);
        }
        break;
      }
      case 'run_resumed': {
        // Agent resumed after a sub-agent completed — the bubble creation
        // already happened in the guard above. Just ensure we're in the right state.
        console.log('[ChatState] run_resumed — agent continuing after sub-agent');
        isStreamActiveRef.current = true;
        setIsRunning(true);
        setStreamingPhase('thinking');
        setStatusText('🧠 Agent is thinking…');
        resetStreamWatchdog();
        break;
      }
      case 'stream_ended':
        // Backend says no active stream — nothing to do
        break;
      case 'connected':
      case 'keepalive':
        break;
    }
  }, [resetStreamWatchdog, clearStreamWatchdog, appendThinkingChunk]);

  // Keep handleWsEvent in a ref so the WS handler always calls the latest version
  const handleWsEventRef = useRef(handleWsEvent);
  useEffect(() => { handleWsEventRef.current = handleWsEvent; }, [handleWsEvent]);

  /**
   * Handle events from the direct gateway client.
   * Maps native gateway events to our internal event format.
   */
  const handleDirectGatewayEvent = useCallback((evt: GatewayEvent) => {
    debugLog('[ChatState] Direct gateway event:', evt.event, evt.payload);

    if (evt.event === 'chat') {
      const payload = evt.payload;
      const state = payload.state;

      // Track current run for abort functionality
      if (payload.runId) {
        currentRunIdRef.current = payload.runId;
      }

      switch (state) {
        case 'delta': {
          // Extract text from the delta message
          const text = payload.message?.text ||
            (Array.isArray(payload.message?.content)
              ? payload.message.content
                  .filter((b: any) => b.type === 'text')
                  .map((b: any) => b.text || '')
                  .join('')
              : '');

          if (text) {
            const safeChunk = sanitizeAssistantChunk(text);
            const nextText = mergeStreamText(safeChunk);
            setStatusText(null);
            setStreamingPhase('streaming');
            setActiveToolName(null);

            // Throttle UI updates
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
          }
          resetStreamWatchdog();
          break;
        }
        case 'final': {
          clearStreamWatchdog();
          // Flush any pending throttled text update
          if (textThrottleTimerRef.current) {
            clearTimeout(textThrottleTimerRef.current);
            textThrottleTimerRef.current = null;
          }
          pendingTextUpdateRef.current = null;

          const finalText = payload.message?.text ||
            (Array.isArray(payload.message?.content)
              ? payload.message.content
                  .filter((b: any) => b.type === 'text')
                  .map((b: any) => b.text || '')
                  .join('')
              : assembledRef.current);

          const finalContent = sanitizeAssistantContent(finalText);
          assembledRef.current = finalContent;

          const cid = streamingAssistantIdRef.current;
          const hadToolEvents = hasRealToolEventsRef.current;

          setStatusText(null);
          setStreamingPhase('idle');
          setIsRunning(false);
          setIsCompacting(false);
          if (compactionTimerRef.current) {
            clearTimeout(compactionTimerRef.current);
            compactionTimerRef.current = null;
          }

          isStreamActiveRef.current = false;
          streamingAssistantIdRef.current = null;
          currentRunIdRef.current = null;
          assembledRef.current = '';
          lastSegmentStartRef.current = 0;

          if (cid) {
            setMessages(prev => prev.map(m =>
              m.id === cid ? { ...m, content: finalContent } : m
            ));
          }

          // Reload history when tools were used to get proper tool results
          if (hadToolEvents) {
            debugLog('[ChatState] Direct: Tools were used — scheduling history reload');
            setTimeout(() => {
              const currentSession = sessionRef.current;
              const currentProvider = providerRef.current;
              if (currentSession) {
                loadHistoryInternal(currentSession, currentProvider, { force: true });
              }
            }, 200);
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
          isStreamActiveRef.current = false;
          streamingAssistantIdRef.current = null;
          currentRunIdRef.current = null;

          if (cid && currentText) {
            setMessages(prev => prev.map(m =>
              m.id === cid ? { ...m, content: currentText + '\n\n*(cancelled)*' } : m
            ));
          }
          break;
        }
        case 'error': {
          clearStreamWatchdog();
          const errorMsg = payload.errorMessage || 'Unknown error';
          const cid = streamingAssistantIdRef.current;

          setStatusText(null);
          setStreamingPhase('idle');
          setIsRunning(false);
          isStreamActiveRef.current = false;
          streamingAssistantIdRef.current = null;
          currentRunIdRef.current = null;

          if (cid) {
            setMessages(prev => prev.map(m =>
              m.id === cid ? { ...m, content: '\u26a0\ufe0f ' + errorMsg } : m
            ));
          }
          break;
        }
      }
    } else if (evt.event === 'agent') {
      const payload = evt.payload;

      if (payload.stream === 'tool' && payload.data) {
        const data = payload.data;
        const assistantId = streamingAssistantIdRef.current;

        switch (data.phase) {
          case 'start': {
            hasRealToolEventsRef.current = true;
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
        // Handle compaction events
        const data = payload.data as any;
        if (data?.status === 'started') {
          setIsCompacting(true);
          setThinkingContent('');
          setStatusText('Compacting context… stream may pause briefly');
        } else if (data?.status === 'completed') {
          if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
          compactionTimerRef.current = setTimeout(() => {
            setIsCompacting(false);
            compactionTimerRef.current = null;
          }, 3000);
          setStatusText('Context compacted. Reconnecting stream…');
        }
      }
    }
  }, [resetStreamWatchdog, clearStreamWatchdog, loadHistoryInternal, mergeStreamText, upsertStreamingAssistant]);

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
      if (data.type === 'connected') setWsConnected(true);
    };
    manager.addHandler(statusHandler);

    const unsubDisconnect = manager.onDisconnect(() => {
      setWsConnected(false);
      if (isStreamActiveRef.current) {
        console.warn('[ChatState] WS disconnected during active stream');
        setIsRunning(true);
        setStreamingPhase(prev => prev === 'idle' ? 'thinking' : prev);
        setStatusText('Reconnecting to stream…');
      }
    });

    // On reconnect: check stream status & reload history delta
    const unsubReconnect = manager.onReconnect(async () => {
      setWsConnected(true);
      debugLog('[ChatState] WS reconnected \u2014 checking stream status');
      try {
        const params: Record<string, string> = { session: sessionRef.current };
        if (providerRef.current) params.provider = providerRef.current;
        const { data } = await client.get('/gateway/stream-status', { params });
        if (data.active) {
          debugLog('[ChatState] Stream still active after reconnect — subscribing via WS');
          isStreamActiveRef.current = true;
          setIsRunning(true);
          setStreamingPhase(data.phase === 'tool' ? 'tool' : data.phase === 'streaming' ? 'streaming' : 'thinking');
          setActiveToolName(data.toolName || null);
          if (typeof data.content === 'string' && data.content.length > 0) {
            const nextText = mergeStreamText(sanitizeAssistantContent(data.content), { replace: true });
            upsertStreamingAssistant(nextText);
          }
          // Send reconnect message to subscribe to StreamEventBus via WS
          wsManagerRef.current?.send({ type: 'reconnect', session: sessionRef.current });
          resetStreamWatchdog();
          return;
        } else if (isStreamActiveRef.current) {
          debugLog('[ChatState] Stream ended during disconnect');
          isStreamActiveRef.current = false;
          setIsRunning(false);
          setStreamingPhase('idle');
          setStatusText(null);
        }
        // Only reload committed history when no active stream remains.
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
  // When USE_DIRECT_GATEWAY is enabled and provider is OPENCLAW, use the direct
  // gateway connection instead of the portal WS middleman.
  useEffect(() => {
    // Only create direct client when:
    // 1. Feature flag is enabled
    // 2. Provider is OPENCLAW
    if (!USE_DIRECT_GATEWAY || provider !== 'OPENCLAW') {
      // Disconnect existing direct client if switching away from OPENCLAW
      if (directClientRef.current) {
        debugLog('[ChatState] Disconnecting direct gateway client (provider changed)');
        directClientRef.current.disconnect();
        directClientRef.current = null;
        directClientConnectedRef.current = false;
      }
      return;
    }

    // Already have a connected client
    if (directClientRef.current) {
      return;
    }

    debugLog('[ChatState] Creating direct gateway client');
    const directClient = new OpenClawGatewayClient({
      url: createGatewayDirectUrl(),
      onEvent: handleDirectGatewayEvent,
      onConnected: () => {
        debugLog('[ChatState] Direct gateway connected');
        directClientConnectedRef.current = true;
        setWsConnected(true);
        // Subscribe to current session if any
        const currentSession = sessionRef.current;
        if (currentSession && currentSession.startsWith('agent:')) {
          directClient.subscribeSession(currentSession).catch((err) => {
            console.warn('[ChatState] Failed to subscribe to session:', err);
          });
        }
      },
      onDisconnected: () => {
        debugLog('[ChatState] Direct gateway disconnected');
        directClientConnectedRef.current = false;
        setWsConnected(false);
        if (isStreamActiveRef.current) {
          console.warn('[ChatState] Direct gateway disconnected during active stream');
          setStatusText('Reconnecting to stream…');
        }
      },
      onError: (err) => {
        console.error('[ChatState] Direct gateway error:', err);
      },
    });

    directClientRef.current = directClient;
    directClient.connect();

    return () => {
      debugLog('[ChatState] Cleaning up direct gateway client');
      directClient.disconnect();
      directClientRef.current = null;
      directClientConnectedRef.current = false;
    };
  }, [provider, handleDirectGatewayEvent]);

  // Visibility change handler: when tab becomes visible again, check stream status
  // and resubscribe if needed. Mobile browsers are aggressive about backgrounding
  // WebSockets, so this helps recover lost streams.
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;

      const manager = wsManagerRef.current;
      const currentSession = sessionRef.current;
      const currentProvider = providerRef.current;

      if (!currentSession) return;

      debugLog('[ChatState] Tab became visible — checking stream status');

      // 1. Check if WS is still connected
      if (!manager || !manager.isConnected()) {
        debugLog('[ChatState] WS disconnected on visibility — waiting for auto-reconnect');
        return; // WsManager's built-in reconnect will handle this
      }

      // 2. If we think we have an active stream, verify it's still running
      if (isStreamActiveRef.current) {
        // Stream was active — send a reconnect message to resubscribe
        manager.send({ type: 'reconnect', session: currentSession });
        resetStreamWatchdog();
        return;
      }

      // 3. No active stream — check if one started while we were backgrounded
      try {
        const params: Record<string, string> = { session: currentSession };
        if (currentProvider) params.provider = currentProvider;
        const { data } = await client.get('/gateway/stream-status', { params });

        if (data.active) {
          debugLog('[ChatState] Discovered active stream on visibility — subscribing');
          // A stream started while we were backgrounded — subscribe to it
          manager.send({ type: 'reconnect', session: currentSession });
        }
      } catch (err) {
        console.warn('[ChatState] Visibility check failed:', err);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [resetStreamWatchdog]);

  // Clear messages helper — also invalidates any in-flight history load and
  // resets transient stream UI so switching sessions always starts clean.
  const clearMessages = useCallback(() => {
    historyGenRef.current++; // invalidate any in-flight loadHistoryInternal
    setMessages([]);
    setIsLoadingHistory(false);
    setStatusText(null);
    setLastProvenance(null);
    setStreamingPhase('idle');
    setActiveToolName(null);
    setThinkingContent('');
    setIsCompacting(false);
    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    toolCounterRef.current = 0;
    hasRealToolEventsRef.current = false;
    streamingAssistantIdRef.current = null;
    isStreamActiveRef.current = false;
    if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
    if (streamWatchdogRef.current) { clearTimeout(streamWatchdogRef.current); streamWatchdogRef.current = null; }
    setIsRunning(false);
  }, []);

  // Resolve exec approval
  const resolveApproval = useCallback(async (
    approvalId: string,
    decision: 'approve' | 'deny' | 'always',
  ) => {
    try {
      const manager = wsManagerRef.current;
      if (manager && manager.isConnected()) {
        manager.send({ type: 'exec_approval_resolve', approvalId, decision });
        setPendingApproval(null);
        setStatusText(decision === 'deny' ? '\u274c Command denied' : '\u2705 Command approved');
        setTimeout(() => setStatusText(null), 2000);
      } else {
        const response = await client.post('/gateway/exec-approval/resolve', { approvalId, decision });
        if (response.data?.ok) {
          setPendingApproval(null);
          setStatusText(decision === 'deny' ? '\u274c Command denied' : '\u2705 Command approved');
          setTimeout(() => setStatusText(null), 2000);
        }
      }
    } catch (err) {
      console.error('[ChatState] Failed to resolve approval:', err);
      setPendingApproval(null);
    }
  }, []);

  const dismissApproval = useCallback(() => { setPendingApproval(null); }, []);

  // Send message via WS (with SSE fallback)
  const sendMessage = useCallback(async (text: string) => {
    if (isStreamActiveRef.current) return; // Lockout while streaming

    // Add user message to UI
    const userMsg: ChatMessage = {
      id: nextId(),
      role: 'user',
      content: text,
      createdAt: new Date(),
    };
    setMessages(prev => [...prev, userMsg]);

    // Reset streaming state
    assembledRef.current = '';
    lastSegmentStartRef.current = 0;
    toolCounterRef.current = 0;
    hasRealToolEventsRef.current = false;
    setThinkingContent('');
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
    if (USE_DIRECT_GATEWAY && providerRef.current === 'OPENCLAW' && directClient?.isConnected) {
      try {
        const currentSession = sessionRef.current || 'main';
        debugLog('[ChatState] Sending via direct gateway to session:', currentSession);
        const runId = await directClient.sendMessage(currentSession, text);
        currentRunIdRef.current = runId;
        debugLog('[ChatState] Direct send initiated, runId:', runId);
        // Events will come through handleDirectGatewayEvent
      } catch (err: any) {
        console.error('[ChatState] Direct gateway send failed:', err);
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: '\u26a0\ufe0f ' + (err.message || 'Send failed') } : m
        ));
        setIsRunning(false);
        setStreamingPhase('idle');
        isStreamActiveRef.current = false;
        streamingAssistantIdRef.current = null;
      }
      return;
    }

    // Send via WS (portal middleman path for non-OPENCLAW or when direct gateway unavailable)
    const manager = wsManagerRef.current;
    if (manager && manager.isConnected()) {
      const payload: Record<string, unknown> = {
        type: 'send',
        message: text,
        session: sessionRef.current || 'main',
      };
      if (providerRef.current) payload.provider = providerRef.current;
      if (modelRef.current) payload.model = modelRef.current;
      if (agentIdRef.current) payload.agentId = agentIdRef.current;
      const sent = manager.send(payload);
      if (!sent) {
        try {
          await sendViaSSE(text, assistantId);
        } catch (err: any) {
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, content: '\u26a0\ufe0f ' + (err.message || 'Send failed') } : m
          ));
          setIsRunning(false);
          setStreamingPhase('idle');
          isStreamActiveRef.current = false;
          streamingAssistantIdRef.current = null;
        }
      }
    } else {
      // SSE fallback
      try {
        await sendViaSSE(text, assistantId);
      } catch (err: any) {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: '\u26a0\ufe0f ' + (err.message || 'Send failed') } : m
        ));
        setIsRunning(false);
        setStreamingPhase('idle');
        isStreamActiveRef.current = false;
        streamingAssistantIdRef.current = null;
      }
    }
  }, [resetStreamWatchdog]);

  // SSE fallback sender
  const sendViaSSE = useCallback(async (text: string, initialAssistantId: string) => {
    let assembled = '';
    let assistantId = initialAssistantId;

    const apiUrl = import.meta.env.VITE_API_URL || '';
    const body: Record<string, unknown> = {
      message: text,
      session: sessionRef.current || 'main',
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
    if (!response.ok) throw new Error('Gateway error: ' + response.status);
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
            const hasFinal = typeof evt.content === 'string' && evt.content.length > 0;
            const finalContent = hasFinal ? sanitizeAssistantContent(evt.content) : (assembled || '');
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
          } else if (evt.type === 'error') {
            setMessages(prev => prev.map(m =>
              m.id === assistantId ? { ...m, content: '\u26a0\ufe0f ' + (evt.content || 'Error') } : m
            ));
            setStreamingPhase('idle');
            setIsRunning(false);
            isStreamActiveRef.current = false;
            streamingAssistantIdRef.current = null;
          } else if (evt.type === 'exec_approval') {
            if (evt.approval?.id) { setPendingApproval(evt.approval); setStatusText('\u23f3 Waiting for command approval\u2026'); }
          }
        } catch { /* ignore parse errors */ }
      }
      if (done) break;
    }
  }, []);


  const injectNote = useCallback(async (text: string, sessionKey?: string) => {
    const note = String(text || '').trim();
    if (!note) return;

    const targetSession = sessionKey || sessionRef.current;
    const manager = wsManagerRef.current;
    if (manager && manager.isConnected()) {
      const sent = manager.send({ type: 'inject', session: targetSession, text: note });
      if (sent) return;
    }

    await client.post('/gateway/chat/inject', { session: targetSession, text: note });
  }, []);

  // Cancel stream
  const cancelStream = useCallback(async () => {
    try {
      // For OPENCLAW with direct gateway, use the direct client for abort
      const directClient = directClientRef.current;
      if (USE_DIRECT_GATEWAY && providerRef.current === 'OPENCLAW' && directClient?.isConnected) {
        const currentSession = sessionRef.current;
        const runId = currentRunIdRef.current;
        debugLog('[ChatState] Aborting via direct gateway, session:', currentSession, 'runId:', runId);
        await directClient.abortRun(currentSession, runId || undefined);
      } else {
        const manager = wsManagerRef.current;
        if (manager && manager.isConnected()) {
          manager.send({ type: 'abort', session: sessionRef.current });
        } else {
          await client.post('/gateway/chat/abort', { session: sessionRef.current });
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
      setIsCompacting(false);
      currentRunIdRef.current = null;
      if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
      const cid = streamingAssistantIdRef.current;
      if (cid) {
        const ft = assembledRef.current;
        if (ft) setMessages(prev => prev.map(m => m.id === cid ? { ...m, content: ft + '\n\n*(cancelled)*' } : m));
        streamingAssistantIdRef.current = null;
      }
    }
  }, [clearStreamWatchdog]);

  // Build context value
  const contextValue: ChatStateContextValue = {
    messages,
    setMessages,
    clearMessages,
    isRunning,
    isLoadingHistory,
    isSwitchingSession,
    streamingPhase,
    activeToolName,
    statusText,
    lastProvenance,
    thinkingContent,
    isCompacting,
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
  };

  return (
    <ChatStateContext.Provider value={contextValue}>
      {children}
    </ChatStateContext.Provider>
  );
}
