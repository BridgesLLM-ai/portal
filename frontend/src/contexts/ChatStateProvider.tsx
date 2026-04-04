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
import { streamManager } from '../services/StreamManager';

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
  timingKnown?: boolean;
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
  steer?: boolean;
  provenance?: string;
  toolCalls?: ToolCall[];
  thinkingContent?: string;
  toolCallId?: string;
  toolName?: string;
  /** Text segments with their position relative to tool calls (for history reconstruction) */
  segments?: TextSegment[];
  /** Per-turn metadata from native provider (cost, usage, model, session ID) */
  turnMetadata?: {
    totalCostUsd?: number | null;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null;
    model?: string | null;
    modelUsage?: Record<string, { input_tokens?: number; output_tokens?: number; cost_usd?: number }> | null;
    nativeSessionId?: string | null;
  };
}

export interface MessageQueueItem {
  id: string;
  text: string;
  createdAt: number;
}

export type StreamingPhase = 'idle' | 'thinking' | 'tool' | 'streaming';

/* ═══ WS Manager Types (kept for export compatibility) ═══ */

/** @deprecated Use streamManager from StreamManager.ts instead */
export interface WsManager {
  ws: WebSocket | null;
  send: (data: any) => boolean;
  addHandler: (handler: (data: any) => void) => void;
  removeHandler: (handler: (data: any) => void) => void;
  onDisconnect: (cb: () => void) => (() => void);
  onReconnect: (cb: () => void) => (() => void);
  isConnected: () => boolean;
  reconnect: () => void;
  close: () => void;
}

// NOTE: WS connection is now managed by StreamManager singleton.
// ChatStateProvider uses streamManager.addGlobalHandler() to receive all events.

/* ═══ Helpers ═══ */

let msgCounter = 0;
function nextId() {
  return 'msg-' + Date.now() + '-' + (++msgCounter);
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

const MODEL_STORAGE_PREFIX = 'agentChats.lastModel.';
const CHAT_HISTORY_OMITTED_PLACEHOLDER = '[chat.history omitted: message too large]';

function normalizeProviderModel(provider: string, rawModel: string): string {
  const model = String(rawModel || '').trim();
  if (!model) return '';
  if (!model || typeof model !== 'string') return model || '';
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

function stripInternalOpenClawContext(raw: string): string {
  if (!raw) return raw;
  if (raw.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>')) return '';
  if (/Sender \(untrusted metadata\):/.test(raw) && /```json/.test(raw)) return '';
  if (/Conversation info \(untrusted metadata\):/.test(raw) && /```json/.test(raw)) return '';
  return raw
    .replace(/^\[[^\]]+\]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


function sanitizeRenderableContent(role: string, raw: string): string {
  const stripped = stripInternalOpenClawContext(raw || '');
  return role === 'assistant' ? sanitizeAssistantContent(stripped) : stripped;
}

function parseHistoryMessage(m: any): ChatMessage | null {
  const rawContent = m.content || '';
  const isTruncationPlaceholder = m.role === 'assistant' && rawContent === CHAT_HISTORY_OMITTED_PLACEHOLDER;
  const createdAt = new Date(m.timestamp || Date.now());
  const content = isTruncationPlaceholder
    ? 'Earlier assistant output was omitted from history because the message was too large.'
    : sanitizeRenderableContent(m.role, rawContent);

  // Drop empty/internal-only messages from history so portal users don't see raw OpenClaw internal context.
  if (!content && !m.toolCalls?.length && !m.segments?.length) return null;

  const msg: ChatMessage = {
    id: m.id || nextId(),
    role: isTruncationPlaceholder ? 'system' : m.role,
    content,
    createdAt,
    provenance: m.provenance,
  };
  if (m.toolCalls) {
    msg.toolCalls = m.toolCalls.map((tc: any) => normalizeHistoricalToolCall(tc, createdAt.getTime()));
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
function extractToolCallsFromGatewayMessage(msg: GatewayChatMessage, fallbackTs: number): ToolCall[] | undefined {
  if (!Array.isArray(msg.content)) return undefined;

  const toolCalls = msg.content
    .filter((block) => block.type === 'toolCall' && block.name)
    .map((block) => normalizeHistoricalToolCall(block, fallbackTs));

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
  const createdAt = new Date(msg.timestamp || Date.now());
  const toolCalls = extractToolCallsFromGatewayMessage(msg, createdAt.getTime()) || [];
  const thinking = extractThinkingFromGatewayMessage(msg);
  const isTruncationPlaceholder = msg.role === 'assistant' && text === CHAT_HISTORY_OMITTED_PLACEHOLDER;
  const content = isTruncationPlaceholder
    ? 'Earlier assistant output was omitted from history because the message was too large.'
    : sanitizeRenderableContent(msg.role, text);

  if (!content && !toolCalls.length && !thinking) return null;

  return {
    id: msg.id || msg.messageId || `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: isTruncationPlaceholder ? 'system' : (msg.role as 'user' | 'assistant' | 'system' | 'toolResult'),
    content,
    createdAt,
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
  // Session controls (OpenClaw session thinking + portal model override)
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive';
  setThinkingLevel: (level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive') => Promise<void>;
  fastModeEnabled: boolean;
  fastModeModel: string;
  setFastModeModel: (model: string) => Promise<void>;
  toggleFastMode: () => Promise<void>;
  compactionModelOverride: string;
  setCompactionModelOverride: (model: string) => Promise<void>;
  compactionModelLoading: boolean;
  compactionModelError: string | null;
  sessionControlsSupported: boolean;
}

const ChatStateContext = createContext<ChatStateContextValue | null>(null);

export function useChatState(): ChatStateContextValue {
  const ctx = useContext(ChatStateContext);
  if (!ctx) throw new Error('useChatState must be used within ChatStateProvider');
  return ctx;
}

/* ═══ Provider Component ═══ */

export function ChatStateProvider({ children }: { children: React.ReactNode }) {
  type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive';
  const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive'];
  const FAST_MODEL_STORAGE_KEY = 'agent-chat-fast-model';

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
  const [messageQueue, setMessageQueue] = useState<MessageQueueItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isSwitchingSession, setIsSwitchingSession] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [lastProvenance, setLastProvenance] = useState<string | null>(null);
  const [streamingPhase, setStreamingPhase] = useState<StreamingPhase>('idle');
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  const [thinkingContent, setThinkingContent] = useState<string>('');
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
  const [fastModeModel, setFastModeModelState] = useState(() => localStorage.getItem(FAST_MODEL_STORAGE_KEY) || 'anthropic/claude-haiku-4-5-20250514');
  const [baseModel, setBaseModel] = useState<string | null>(null); // Store original model when fast mode is active
  const [compactionModelOverride, setCompactionModelOverrideState] = useState<string>('');
  const [compactionModelLoading, setCompactionModelLoading] = useState(false);
  const [compactionModelError, setCompactionModelError] = useState<string | null>(null);

  // Refs
  const streamWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const STREAM_TIMEOUT_MS = 90_000;
  const compactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCatchUpTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const toolCounterRef = useRef(0);
  const hasRealToolEventsRef = useRef(false);
  // NOTE: WS connection now managed by streamManager singleton (StreamManager.ts)
  // Direct gateway client for OPENCLAW provider (bypasses portal WS middleman)
  const directClientRef = useRef<OpenClawGatewayClient | null>(null);
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

  useEffect(() => {
    let cancelled = false;

    const syncSelectedSessionModel = async () => {
      if (provider !== 'OPENCLAW' || !session || !session.startsWith('agent:')) return;
      try {
        // Use silent mode — 404 is expected for expired/stale sessions and
        // should not trigger error sounds or the ErrorPanel.
        const data = await gatewayAPI.sessionInfo(session, { silent: true, soft: true });
        const actualModel = deriveSessionModel(data?.session);
        if (!cancelled && actualModel) {
          setSelectedModelRaw((prev) => (prev === actualModel ? prev : actualModel));
        }
        const sessionThinking = String(
          data?.session?.thinkingLevel
          || data?.session?.thinking
          || data?.session?.settings?.thinking
          || '',
        ).toLowerCase();
        if (!cancelled && THINKING_LEVELS.includes(sessionThinking as ThinkingLevel)) {
          setThinkingLevelState(sessionThinking as ThinkingLevel);
        } else if (!cancelled) {
          // No explicit thinking level set — infer default from model.
          // Anthropic Claude 4.6+ models default to adaptive thinking.
          const modelStr = String(actualModel || '').toLowerCase();
          const isAdaptiveDefault = /claude-(opus|sonnet)-4[._-](5|6|7|8|9)|claude-(opus|sonnet)-[5-9]/.test(modelStr);
          setThinkingLevelState(isAdaptiveDefault ? 'adaptive' : 'off');
        }
        if (!cancelled) {
          setFastModeEnabled(Boolean(
            data?.session?.fastMode
            ?? data?.session?.settings?.fastMode
            ?? false,
          ));
        }
      } catch {
        // Keep the locally selected model if the session lookup fails.
      }
    };

    syncSelectedSessionModel();
    return () => { cancelled = true; };
  }, [provider, session, deriveSessionModel]);

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
      console.warn('[ChatState] Stream watchdog: no activity for 90s — verifying stream status');

      try {
        const currentSession = sessionRef.current || 'main';
        const currentProvider = providerRef.current;
        const params: Record<string, string> = { session: currentSession };
        if (currentProvider) params.provider = currentProvider;
        const { data } = await client.get('/gateway/stream-status', { params, _silent: true } as any);
        if (data?.active) {
          setIsRunning(true);
          setStreamingPhase(data.phase === 'tool' ? 'tool' : data.phase === 'streaming' ? 'streaming' : 'thinking');
          setActiveToolName(data.toolName || null);
          setStatusText(data.toolName ? `Using ${data.toolName}…` : 'Still working…');
          if (typeof data.content === 'string' && data.content.length > 0) {
            const safeText = sanitizeAssistantContent(data.content);
            assembledRef.current = safeText;
            const assistantId = streamingAssistantIdRef.current;
            if (assistantId) {
              setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: safeText } : m));
            }
          }
          if (USE_DIRECT_GATEWAY && currentProvider === 'OPENCLAW') {
            directClientRef.current?.connect();
          } else if (!streamManager.isConnected()) {
            streamManager.reconnect();
          }
          resetStreamWatchdog();
          return;
        }
      } catch (err) {
        console.warn('[ChatState] Stream watchdog verification failed:', err);
      }

      isStreamActiveRef.current = false;
      setIsRunning(false);
      setStreamingPhase('idle');
      setStatusText(null);
      setCompactionPhase('idle');
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

  const resolveOpenClawSessionKey = useCallback((rawSession?: string | null): string => {
    const sessionKey = typeof rawSession === 'string' ? rawSession.trim() : '';
    if (providerRef.current !== 'OPENCLAW') return sessionKey;
    if (sessionKey.startsWith('agent:')) return sessionKey;
    if (isOwner(user) && (!sessionKey || sessionKey === 'main')) {
      return 'agent:main:main';
    }
    return sessionKey;
  }, [user]);

  const applyCompactionState = useCallback((phase: 'start' | 'end') => {
    if (providerRef.current !== 'OPENCLAW') return;
    if (phase === 'start') {
      if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
      compactionPhaseRef.current = 'compacting';
      setCompactionPhase('compacting');
      setThinkingContent('');
      return;
    }
    compactionPhaseRef.current = 'compacted';
    setCompactionPhase('compacted');
    if (compactionTimerRef.current) clearTimeout(compactionTimerRef.current);
    compactionTimerRef.current = setTimeout(() => {
      compactionPhaseRef.current = 'idle';
      setCompactionPhase('idle');
      compactionTimerRef.current = null;
    }, 3000);
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
      return data.messages
        ? data.messages.map(parseHistoryMessage).filter(Boolean) as ChatMessage[]
        : [];
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

      // Try direct gateway for OPENCLAW when enabled
      const directClient = directClientRef.current;
      console.log('[ChatState] loadHistoryInternal: USE_DIRECT=', USE_DIRECT_GATEWAY, 'prov=', prov, 'directConnected=', directClient?.isConnected, 'session=', sessionKey, 'force=', options?.force);
      if (USE_DIRECT_GATEWAY && prov === 'OPENCLAW' && directClient?.isConnected) {
        try {
          console.log('[ChatState] 📜 Loading history via DIRECT gateway');
          loaded = await loadViaDirect();
        } catch (err) {
          console.warn('[ChatState] Direct gateway history failed; falling back to HTTP', err);
          loaded = await loadViaHttp();
        }
      } else {
        // Use HTTP path (StreamManager doesn't support one-shot handlers for history)
        loaded = await loadViaHttp();
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
  }, [resolveOpenClawSessionKey]);

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
        if (data.toolName) setActiveToolName(data.toolName);
        setStatusText(data.statusText || (data.toolName ? `Using ${data.toolName}…` : data.phase === 'streaming' ? 'Responding…' : 'Thinking…'));
        if (typeof data.thinkingContent === 'string') {
          setThinkingContent(data.thinkingContent);
          const aid = streamingAssistantIdRef.current;
          if (aid) setMessages(prev => prev.map(m => m.id === aid ? { ...m, thinkingContent: data.thinkingContent } : m));
        }
        if (typeof data.content === 'string' && data.content.length > 0) {
          const safeText = sanitizeAssistantContent(data.content);
          mergeStreamText(safeText, { replace: true });
          upsertStreamingAssistant(safeText);
        }
        streamManager.send({ type: 'reconnect', session: currentSession });

        // B19 fix: Stale stream watchdog — if no stream events arrive within 8s,
        // re-check stream-status and reset if the stream has ended. Prevents
        // indefinite "thinking" state when stream-status was stale.
        const staleSession = currentSession;
        const staleProvider = currentProvider;
        setTimeout(async () => {
          if (!isStreamActiveRef.current) return; // already resolved
          try {
            const staleParams: Record<string, string> = { session: staleSession };
            if (staleProvider) staleParams.provider = staleProvider;
            const { data: recheck } = await client.get('/gateway/stream-status', { params: staleParams, _silent: true } as any);
            if (!recheck.active && isStreamActiveRef.current) {
              debugLog('[ChatState] Stale stream detected — resetting to idle');
              isStreamActiveRef.current = false;
              setIsRunning(false);
              setStreamingPhase('idle');
              setStatusText(null);
              setActiveToolName(null);
            }
          } catch { /* best-effort */ }
        }, 8000);
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
    let cancelled = false;
    const expectedSession = session;
    const expectedProvider = provider;

    if (session && !isStreamActiveRef.current) {
      setIsLoadingHistory(true); // show spinner immediately, before async fetch
      loadHistoryInternal(session, provider).then(() => {
        if (cancelled) return;
        if (sessionRef.current !== expectedSession || providerRef.current !== expectedProvider) return;

        // After loading history, check if there's an active stream to reconnect to.
        // This covers page refresh mid-stream — without this, there's a gap between
        // history load and the first WS event where the UI shows no streaming indicator.
        if (!isStreamActiveRef.current && expectedSession?.startsWith('agent:')) {
          const params: Record<string, string> = { session: expectedSession };
          if (expectedProvider) params.provider = expectedProvider;
          client.get('/gateway/stream-status', { params, _silent: true } as any).then(({ data }) => {
            if (cancelled) return;
            if (sessionRef.current !== expectedSession || providerRef.current !== expectedProvider) return;
            if (data.active && !isStreamActiveRef.current) {
              debugLog('[ChatState] Active stream detected on initial load — showing streaming UI');
              isStreamActiveRef.current = true;
              setIsRunning(true);
              setStreamingPhase(data.phase === 'tool' ? 'tool' : data.phase === 'streaming' ? 'streaming' : 'thinking');
              if (data.toolName) setActiveToolName(data.toolName);
              setStatusText(data.statusText || (data.toolName ? `Using ${data.toolName}…` : data.phase === 'streaming' ? 'Responding…' : 'Thinking…'));
              const resumeId = streamingAssistantIdRef.current || ('stream-resume-' + Date.now());
              streamingAssistantIdRef.current = resumeId;
              if (typeof data.content === 'string' && data.content.length > 0) {
                const safeText = sanitizeAssistantContent(data.content);
                assembledRef.current = safeText;
                upsertStreamingAssistant(safeText);
              } else {
                // Create empty streaming bubble so events have somewhere to land
                setMessages(prev => prev.some(m => m.id === resumeId) ? prev : [...prev, {
                  id: resumeId,
                  role: 'assistant' as const,
                  content: '',
                  createdAt: new Date(),
                  toolCalls: [],
                }]);
              }
              if (typeof data.thinkingContent === 'string') {
                setThinkingContent(data.thinkingContent);
                setMessages(prev => prev.map(m => m.id === resumeId ? { ...m, thinkingContent: data.thinkingContent } : m));
              }
            }
          }).catch(() => { /* stream-status check is best-effort */ });
        }
      });
    }

    return () => {
      cancelled = true;
    };
  }, [session, provider, loadHistoryInternal]);

  // WS event handler — processes events even when chat page is unmounted
  const handleWsEvent = useCallback((data: any) => {
    // When the direct gateway client is connected, it handles all streaming events
    // (chat, agent) directly. The Socket.IO/WS path should NOT also process them,
    // otherwise the browser receives the same text twice causing stutter/cascade.
    if (directClientRef.current?.isConnected) {
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
    // Some event types are allowed without an assistant bubble (session metadata, approvals, etc.).
    // 'run_resumed' signals the agent resumed after a sub-agent — we need to create a new bubble.
    // Stream events (text, tool_*, thinking) after a done also need a new bubble (agent resumed).
    const passthrough = ['session', 'exec_approval', 'exec_approval_resolved', 'connected', 'keepalive', 'compaction_start', 'compaction_end', 'stream_resume', 'stream_ended', 'run_resumed'];
    const streamTypes = ['text', 'thinking', 'tool_start', 'tool_end', 'tool_used', 'status', 'segment_break', 'done'];
    if (!streamingAssistantIdRef.current && !passthrough.includes(data.type)) {
      if (streamTypes.includes(data.type)) {
        // Agent resumed after a sub-agent, reconnect, or reload race — create a new assistant bubble
        // even for a final `done` so the completion text has somewhere to land.
        console.log(`[ChatState] Agent resumed (${data.type}) — creating new assistant bubble`);
        const resumeId = 'resume-' + Date.now();
        streamingAssistantIdRef.current = resumeId;
        assembledRef.current = '';
        lastSegmentStartRef.current = 0;
        lastRawTextLenRef.current = 0;
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
        if (data.type !== 'done') {
          isStreamActiveRef.current = true;
          setIsRunning(true);
          resetStreamWatchdog();
        }
        // Don't return — fall through to process this event with the new assistantId
      } else {
        console.warn(`[ChatState] DROPPED event: type=${data.type} (no assistantId)`);
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
            ? { ...m, toolCalls: [...(m.toolCalls || []), { id: toolId, name: toolName, arguments: toolArgs, startedAt: Date.now(), timingKnown: true, status: 'running' as const }] }
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
        setActiveToolName(null);
        setThinkingContent('');
        setLastProvenance(prov);
        setIsRunning(false);
        if (compactionPhaseRef.current === 'compacting') {
          compactionPhaseRef.current = 'idle';
          setCompactionPhase('idle');
          if (compactionTimerRef.current) { clearTimeout(compactionTimerRef.current); compactionTimerRef.current = null; }
        }
        // Keep graduated segments — they show the agent's thought process leading to the final response.
        // They'll be cleared on next message send or session switch.
        // Mark stream as inactive but DON'T null out streamingAssistantIdRef yet.
        // The agent may resume after a sub-agent completes (sessions_yield flow).
        // The guard at the top of handleWsEvent will create a new bubble when
        // stream events arrive without an active assistantId.
        isStreamActiveRef.current = false;
        streamingAssistantIdRef.current = null;
        currentRunIdRef.current = null;
        // Reset text accumulator so the next run segment starts fresh
        assembledRef.current = '';
        lastSegmentStartRef.current = 0;
        lastRawTextLenRef.current = 0;
        // Persist graduated stream segments into the message so the interleaved
        // timeline survives after streaming ends (when streamSegments state is cleared
        // or the message is no longer the last one). Convert live segments to the same
        // TextSegment format the backend returns for history messages.
        const graduatedSegments: TextSegment[] = [];
        const currentStreamSegs = [...streamSegmentsRef.current];
        if (currentStreamSegs.length > 0 || (cid && hasRealToolEventsRef.current)) {
          for (const seg of currentStreamSegs) {
            graduatedSegments.push({ text: seg.text, position: 'before' });
          }
          // The final content is the "after" segment (text after the last tool call)
          if (finalContent && finalContent.trim()) {
            graduatedSegments.push({ text: finalContent, position: 'after' });
          }
        }

        setMessages(prev => prev.flatMap(m => {
          if (m.id !== cid) return [m];
          const turnMeta = data.metadata && (data.metadata.totalCostUsd || data.metadata.usage) ? {
            totalCostUsd: data.metadata.totalCostUsd ?? null,
            usage: data.metadata.usage ?? null,
            model: data.metadata.model ?? null,
            modelUsage: data.metadata.modelUsage ?? null,
            nativeSessionId: data.metadata.nativeSessionId ?? null,
          } : undefined;
          const update: Partial<ChatMessage> = { content: finalContent, provenance: prov || undefined, turnMetadata: turnMeta };
          if (graduatedSegments.length > 0) {
            update.segments = graduatedSegments;
          }
          const merged = { ...m, ...update };
          const keep = Boolean(
            (finalContent || '').trim() ||
            graduatedSegments.length > 0 ||
            (merged.toolCalls && merged.toolCalls.length > 0) ||
            (merged.thinkingContent && merged.thinkingContent.trim())
          );
          return keep ? [merged] : [];
        }));
        
        // The streaming state is already accurate at this point — the graduated segments
        // were promoted during the run, tool calls have their results from tool_end events,
        // and the final message content was set above. A history reload here would DESTROY
        // the clean streaming state by replacing it with the server's JSONL which strips
        // pre-tool-call text (thoughts/narration) and causes a jarring visual flash.
        // Only reload on manual refresh or session switch.
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
        setStatusText(data.statusText || (data.toolName ? `Using ${data.toolName}…` : data.phase === 'streaming' ? 'Responding…' : 'Reconnecting to stream…'));
        if (typeof data.thinkingContent === 'string') {
          setThinkingContent(data.thinkingContent);
          const aid = streamingAssistantIdRef.current;
          if (aid) setMessages(prev => prev.map(m => m.id === aid ? { ...m, thinkingContent: data.thinkingContent } : m));
        }
        if (typeof data.content === 'string') {
          const nextText = mergeStreamText(sanitizeAssistantContent(data.content), { replace: true });
          upsertStreamingAssistant(nextText);
        }
        resetStreamWatchdog();
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
        // Backend says no active stream — clear any stale local running state.
        clearStreamWatchdog();
        if (isStreamActiveRef.current || isRunning) {
          isStreamActiveRef.current = false;
          streamingAssistantIdRef.current = null;
          currentRunIdRef.current = null;
          setIsRunning(false);
          setStreamingPhase('idle');
          setStatusText(null);
          setActiveToolName(null);
          setThinkingContent('');
        }
        break;
      case 'connected':
      case 'keepalive':
        break;
    }
  }, [normalizeAgentError, resetStreamWatchdog, clearStreamWatchdog, appendThinkingChunk, applyCompactionState, mergeStreamText, upsertStreamingAssistant]);

  // Keep handleWsEvent in a ref so the WS handler always calls the latest version
  const handleWsEventRef = useRef(handleWsEvent);
  useEffect(() => { handleWsEventRef.current = handleWsEvent; }, [handleWsEvent]);

  /**
   * Handle events from the direct gateway client.
   * Maps native gateway events to our internal event format.
   */
  const handleDirectGatewayEvent = useCallback((evt: GatewayEvent) => {
    console.log('[ChatState] 🔔 Direct gateway event:', evt.event, 'state:', evt.payload?.state, 'runId:', evt.payload?.runId);

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
      }

      switch (state) {
        case 'delta': {
          const contentBlocks = Array.isArray(payload.message?.content)
            ? payload.message.content
            : [];

          // Ensure assistant bubble exists — create one if missing.
          // This can happen with OpenAI-style providers that send deltas
          // without a separate 'start' event, or on reconnect/resume.
          let assistantId = streamingAssistantIdRef.current;
          if (!assistantId) {
            assistantId = 'direct-' + Date.now();
            streamingAssistantIdRef.current = assistantId;
            isStreamActiveRef.current = true;
            setIsRunning(true);
            setMessages(prev => [...prev, {
              id: assistantId!,
              role: 'assistant' as const,
              content: '',
              createdAt: new Date(),
              toolCalls: [],
            }]);
            debugLog('[ChatState] Direct gateway: created assistant bubble on first delta');
          }

          // Extract thinking content from thinking blocks
          const thinkingText = contentBlocks
            .filter((b: any) => b.type === 'thinking')
            .map((b: any) => b.text || '')
            .join('');

          if (thinkingText) {
            appendThinkingChunk(
              assistantId,
              extractThinkingChunk('thinking', thinkingText, assembledRef.current.length > 0),
            );
            if (!assembledRef.current) setStreamingPhase('thinking');
          }

          // Extract text content — use content blocks, NOT payload.message.text
          // (which may be a pre-concatenated string including thinking content)
          const text = contentBlocks
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text || '')
            .join('');

          // DIAG: detect thinking content leaking into text blocks
          if (thinkingText && text && text.includes(thinkingText.slice(0, 50))) {
            console.warn('[CASCADE-DIAG] ⚠️ THINKING LEAK: thinking text found inside text blocks!', {
              thinkingLen: thinkingText.length,
              textLen: text.length,
              blockTypes: contentBlocks.map((b: any) => b.type),
            });
          }

          if (text) {
            const safeChunk = sanitizeAssistantChunk(text);
            // Gateway sends FULL accumulated turn text in every delta (replace mode).
            // After tool calls, this includes pre-tool text that's already graduated
            // to segments. Slice off the graduated portion so only new text shows
            // in the main bubble.
            const fullText = safeChunk;

            // Track raw text length for accurate graduation offset calculation.
            // lastSegmentStartRef tracks how much of the gateway's accumulated text
            // has been graduated into segments. We use the raw fullText length
            // (post-sanitize but pre-slice) so the offset stays aligned with what
            // the gateway actually sends.
            lastRawTextLenRef.current = fullText.length;

            const sliced = lastSegmentStartRef.current > 0
              ? fullText.slice(lastSegmentStartRef.current)
              : fullText;

            // DIAG: cascade debugging — log slice math on every delta
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

            // Use replace: assembledRef gets the post-graduation text only
            assembledRef.current = sliced;
            const nextText = sliced;
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

          // Extract ONLY text blocks — never use payload.message.text which may
          // include thinking content concatenated with response text
          const finalTextBlocks = Array.isArray(payload.message?.content)
            ? payload.message.content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text || '')
                .join('')
            : '';
          // Gateway final contains FULL turn text. Slice off graduated portion
          // so the main bubble only shows post-tool content (segments hold the rest).
          let finalText = finalTextBlocks || assembledRef.current;
          if (lastSegmentStartRef.current > 0 && finalText.length > lastSegmentStartRef.current) {
            finalText = finalText.slice(lastSegmentStartRef.current);
          }

          const finalContent = sanitizeAssistantContent(finalText);
          assembledRef.current = finalContent;

          const cid = streamingAssistantIdRef.current;
          const hadToolEvents = hasRealToolEventsRef.current;

          setStatusText(null);
          setStreamingPhase('idle');
          setActiveToolName(null);
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
          // Keep graduated segments — they show the thought process.
          // Cleared on next message send or session switch.

          isStreamActiveRef.current = false;
          streamingAssistantIdRef.current = null;
          currentRunIdRef.current = null;
          assembledRef.current = '';
          lastSegmentStartRef.current = 0;
          lastRawTextLenRef.current = 0;

          // Persist graduated stream segments into the message (same as WS path)
          if (cid) {
            const graduatedSegments: TextSegment[] = [];
            const currentStreamSegs = [...streamSegmentsRef.current];
            if (currentStreamSegs.length > 0 || hadToolEvents) {
              for (const seg of currentStreamSegs) {
                graduatedSegments.push({ text: seg.text, position: 'before' });
              }
              if (finalContent && finalContent.trim()) {
                graduatedSegments.push({ text: finalContent, position: 'after' });
              }
            }
            setMessages(prev => prev.map(m => {
              if (m.id !== cid) return m;
              const update: Partial<ChatMessage> = { content: finalContent };
              if (graduatedSegments.length > 0) {
                update.segments = graduatedSegments;
              }
              return { ...m, ...update };
            }));
          }

          // Don't reload history on done — streaming state is already accurate.
          // History reload strips pre-tool text (thoughts) and causes a visual flash.
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
          streamingAssistantIdRef.current = null;
          currentRunIdRef.current = null;
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
        const assistantId = streamingAssistantIdRef.current;

        switch (data.phase) {
          case 'start': {
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
  }, [normalizeAgentError, resetStreamWatchdog, clearStreamWatchdog, mergeStreamText, upsertStreamingAssistant, appendThinkingChunk, applyCompactionState]);

  // WS setup — uses shared StreamManager singleton instead of per-provider WS.
  // This eliminates duplicate WebSocket connections when both Agent Chat and
  // Project Chat are active simultaneously.
  useEffect(() => {
    streamManager.init(); // Idempotent — safe to call multiple times

    // Register global handler to receive ALL events (ChatStateProvider handles its own session filtering)
    const removeGlobalHandler = streamManager.addGlobalHandler((data: any) => {
      handleWsEventRef.current(data);
      // Also handle connected event for wsConnected state
      if (data.type === 'connected') setWsConnected(true);
    });

    // Seed connection state immediately
    if (streamManager.isConnected()) {
      setWsConnected(true);
    }

    const unsubDisconnect = streamManager.onDisconnect(() => {
      setWsConnected(false);
      if (isStreamActiveRef.current) {
        console.warn('[ChatState] WS disconnected during active stream');
        setIsRunning(true);
        setStreamingPhase(prev => prev === 'idle' ? 'thinking' : prev);
        setStatusText('Reconnecting to stream…');
      }
    });

    // On reconnect: check stream status & reload history delta
    const unsubReconnect = streamManager.onReconnect(async () => {
      setWsConnected(true);
      debugLog('[ChatState] WS reconnected — checking stream status');
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
          streamManager.send({ type: 'reconnect', session: sessionRef.current });
          const reconnectSession = sessionRef.current;
          const reconnectProvider = providerRef.current;
          setTimeout(async () => {
            if (!isStreamActiveRef.current) return;
            try {
              const staleParams: Record<string, string> = { session: reconnectSession };
              if (reconnectProvider) staleParams.provider = reconnectProvider;
              const { data: recheck } = await client.get('/gateway/stream-status', { params: staleParams, _silent: true } as any);
              if (!recheck.active && isStreamActiveRef.current) {
                console.log('[ChatState] Reconnect stream-status was stale — resetting to idle');
                isStreamActiveRef.current = false;
                streamingAssistantIdRef.current = null;
                currentRunIdRef.current = null;
                setIsRunning(false);
                setStreamingPhase('idle');
                setStatusText(null);
                setActiveToolName(null);
                setThinkingContent('');
                loadHistoryInternal(reconnectSession, reconnectProvider, { force: true }).catch(() => {});
              }
            } catch {}
          }, 8000);
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
      removeGlobalHandler();
      unsubDisconnect();
      unsubReconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Direct gateway client setup for OPENCLAW provider
  // When USE_DIRECT_GATEWAY is enabled and provider is OPENCLAW, use the direct
  // gateway connection instead of the portal WS middleman.
  // Gate on gateway health check first to avoid reconnect loops on fresh installs.
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
          console.log('[ChatState] 🔌 Direct gateway RECONNECTED (onConnected fired)');
          console.log('[ChatState] sessionRef.current =', sessionRef.current);
          setWsConnected(true);
          // Subscribe to current session and check for active streams
          const currentSession = resolveOpenClawSessionKey(sessionRef.current);
          console.log('[ChatState] resolved session =', currentSession);
          const currentProvider = providerRef.current;
          if (currentSession && currentSession !== sessionRef.current) {
            sessionRef.current = currentSession;
            setSessionRaw(currentSession);
            localStorage.setItem('agent-chat-session', currentSession);
          }
          if (currentSession && currentSession.startsWith('agent:')) {
            directClient.subscribeSession(currentSession).catch((err) => {
              console.warn('[ChatState] Failed to subscribe to session:', err);
            });
            // Check for active stream immediately after reconnect
            const params: Record<string, string> = { session: currentSession };
            if (currentProvider) params.provider = currentProvider;
            console.log('[ChatState] 📡 Checking stream-status for', currentSession);
            client.get('/gateway/stream-status', { params, _silent: true } as any).then(({ data }: any) => {
              console.log('[ChatState] 📡 stream-status response:', JSON.stringify(data));
              if (data.active) {
                console.log('[ChatState] ✅ Active stream detected — resuming');
                if (!streamingAssistantIdRef.current) {
                  const resumeId = 'stream-resume-' + Date.now();
                  streamingAssistantIdRef.current = resumeId;
                  setMessages(prev => [...prev, {
                    id: resumeId,
                    role: 'assistant' as const,
                    content: '',
                    thinkingContent: typeof data.thinkingContent === 'string' ? data.thinkingContent : undefined,
                    createdAt: new Date(),
                    toolCalls: [],
                  }]);
                }
                isStreamActiveRef.current = true;
                setIsRunning(true);
                setStreamingPhase(data.phase === 'tool' ? 'tool' : data.phase === 'streaming' ? 'streaming' : 'thinking');
                setActiveToolName(data.toolName || null);
                setStatusText(data.statusText || (data.toolName ? `Using ${data.toolName}…` : data.phase === 'streaming' ? 'Responding…' : 'Reconnecting to stream…'));
                if (typeof data.thinkingContent === 'string') {
                  setThinkingContent(data.thinkingContent);
                  const aid = streamingAssistantIdRef.current;
                  if (aid) setMessages(prev => prev.map(m => m.id === aid ? { ...m, thinkingContent: data.thinkingContent } : m));
                }
                if (typeof data.content === 'string' && data.content.length > 0) {
                  const safeText = sanitizeAssistantContent(data.content);
                  assembledRef.current = safeText;
                  upsertStreamingAssistant(safeText);
                }
                const reconnectSession = currentSession;
                const reconnectProvider = currentProvider;
                setTimeout(async () => {
                  if (!isStreamActiveRef.current) return;
                  try {
                    const staleParams: Record<string, string> = { session: reconnectSession };
                    if (reconnectProvider) staleParams.provider = reconnectProvider;
                    const { data: recheck } = await client.get('/gateway/stream-status', { params: staleParams, _silent: true } as any);
                    if (!recheck.active && isStreamActiveRef.current) {
                      console.log('[ChatState] Direct reconnect stream-status was stale — resetting to idle');
                      isStreamActiveRef.current = false;
                      streamingAssistantIdRef.current = null;
                      currentRunIdRef.current = null;
                      setIsRunning(false);
                      setStreamingPhase('idle');
                      setStatusText(null);
                      setActiveToolName(null);
                      setThinkingContent('');
                      loadHistoryInternal(reconnectSession, reconnectProvider, { force: true }).catch(() => {});
                    }
                  } catch {}
                }, 8000);
                resetStreamWatchdog();
              } else {
                // Stream finished during disconnect — reload history to pick up
                // any messages we missed (e.g. final assistant response after a
                // service restart killed the WS mid-turn).
                const wasStreaming = isStreamActiveRef.current;
                console.log('[ChatState] 📥 No active stream — RELOADING HISTORY (wasStreaming:', wasStreaming, ')');
                if (isStreamActiveRef.current) {
                  isStreamActiveRef.current = false;
                  setIsRunning(false);
                  setStreamingPhase('idle');
                  setStatusText(null);
                }
                loadHistoryInternal(currentSession, currentProvider, { force: true }).catch(() => {});

                // If the stream was interrupted by disconnect, the gateway may not
                // have committed the final assistant message yet. Schedule follow-up
                // reloads to catch late commits.
                if (wasStreaming) {
                  const catchUpDelays = [3000, 8000, 15000];
                  reconnectCatchUpTimersRef.current.forEach(t => clearTimeout(t));
                  reconnectCatchUpTimersRef.current = [];
                  const scheduleCatchUp = (idx: number) => {
                    if (idx >= catchUpDelays.length) return;
                    const timer = setTimeout(async () => {
                      if (isStreamActiveRef.current || !directClientRef.current?.isConnected) return;
                      console.log(`[ChatState] 🔄 Catch-up reload ${idx + 1}/${catchUpDelays.length}`);
                      try {
                        await loadHistoryInternal(currentSession, currentProvider, { force: true });
                      } catch {}
                      scheduleCatchUp(idx + 1);
                    }, catchUpDelays[idx]);
                    reconnectCatchUpTimersRef.current.push(timer);
                  };
                  scheduleCatchUp(0);
                }
              }
            }).catch(() => {
              // stream-status failed — still try to reload history as fallback
              console.log('[ChatState] ❌ stream-status FAILED on reconnect — reloading history as fallback');
              loadHistoryInternal(currentSession, currentProvider, { force: true }).catch(() => {});
            });
          }
        },
        onDisconnected: () => {
          console.log('[ChatState] ⚡ Direct gateway DISCONNECTED');
          console.log('[ChatState] isStreamActiveRef =', isStreamActiveRef.current);
          // Cancel any pending catch-up reloads
          reconnectCatchUpTimersRef.current.forEach(t => clearTimeout(t));
          reconnectCatchUpTimersRef.current = [];
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
  }, [provider, handleDirectGatewayEvent]);

  // Visibility change handler: when tab becomes visible again, check stream status
  // and resubscribe if needed. Mobile browsers are aggressive about backgrounding
  // WebSockets, so this helps recover lost streams.
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;

      const directClient = directClientRef.current;
      const currentSession = resolveOpenClawSessionKey(sessionRef.current);
      const currentProvider = providerRef.current;

      if (!currentSession) return;

      debugLog('[ChatState] Tab became visible — checking stream status');

      const usingDirectGateway = USE_DIRECT_GATEWAY && currentProvider === 'OPENCLAW';
      const transportConnected = usingDirectGateway
        ? Boolean(directClient?.isConnected)
        : streamManager.isConnected();

      if (!transportConnected) {
        debugLog('[ChatState] Transport disconnected on visibility — nudging reconnect');
        if (usingDirectGateway) {
          directClient?.connect();
        } else {
          streamManager.reconnect();
        }
      }

      if (isStreamActiveRef.current) {
        if (usingDirectGateway) {
          resetStreamWatchdog();
        } else {
          streamManager.send({ type: 'reconnect', session: currentSession, provider: currentProvider });
          resetStreamWatchdog();
        }
        return;
      }

      try {
        const params: Record<string, string> = { session: currentSession };
        if (currentProvider) params.provider = currentProvider;
        const { data } = await client.get('/gateway/stream-status', { params, _silent: true } as any);

        if (data.active) {
          debugLog('[ChatState] Discovered active stream on visibility — reconnecting');
          if (usingDirectGateway) {
            setIsRunning(true);
            setStreamingPhase(data.phase === 'tool' ? 'tool' : data.phase === 'streaming' ? 'streaming' : 'thinking');
            setActiveToolName(data.toolName || null);
            setStatusText(data.toolName ? `Using ${data.toolName}…` : 'Reconnecting to stream…');
            if (typeof data.content === 'string' && data.content.length > 0) {
              const safeText = sanitizeAssistantContent(data.content);
              assembledRef.current = safeText;
              upsertStreamingAssistant(safeText);
            }
            resetStreamWatchdog();
          } else {
            streamManager.send({ type: 'reconnect', session: currentSession, provider: currentProvider });
          }
        } else {
          debugLog('[ChatState] No active stream on visibility — reloading history for missed messages');
          loadHistoryInternal(currentSession, currentProvider);
        }
      } catch (err) {
        console.warn('[ChatState] Visibility check failed:', err);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadHistoryInternal, resetStreamWatchdog, resolveOpenClawSessionKey, upsertStreamingAssistant]);

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

    let authoritativeBusy = false;
    if (providerRef.current === 'OPENCLAW' && !isStreamActiveRef.current) {
      try {
        const targetSession = resolveOpenClawSessionKey(sessionRef.current || 'main');
        const { data } = await client.get('/gateway/stream-status', { params: { session: targetSession, provider: 'OPENCLAW' }, _silent: true } as any);
        if (data?.active) {
          authoritativeBusy = true;
          if (!streamingAssistantIdRef.current) {
            const resumeId = 'stream-resume-' + Date.now();
            streamingAssistantIdRef.current = resumeId;
            setMessages(prev => [...prev, {
              id: resumeId,
              role: 'assistant' as const,
              content: typeof data.content === 'string' ? sanitizeAssistantContent(data.content) : '',
              thinkingContent: typeof data.thinkingContent === 'string' ? data.thinkingContent : undefined,
              createdAt: new Date(),
              toolCalls: [],
            }]);
          }
          isStreamActiveRef.current = true;
          setIsRunning(true);
          setStreamingPhase(data.phase === 'tool' ? 'tool' : data.phase === 'streaming' ? 'streaming' : 'thinking');
          setActiveToolName(data.toolName || null);
          setStatusText(data.statusText || (data.toolName ? `Using ${data.toolName}…` : data.phase === 'streaming' ? 'Responding…' : 'Thinking…'));
          if (typeof data.thinkingContent === 'string') {
            setThinkingContent(data.thinkingContent);
            const aid = streamingAssistantIdRef.current;
            if (aid) setMessages(prev => prev.map(m => m.id === aid ? { ...m, thinkingContent: data.thinkingContent } : m));
          }
          if (typeof data.content === 'string' && data.content.length > 0) {
            const safeText = sanitizeAssistantContent(data.content);
            assembledRef.current = safeText;
            mergeStreamText(safeText, { replace: true });
            upsertStreamingAssistant(safeText);
          }
          resetStreamWatchdog();
        }
      } catch {
        // best-effort authoritative busy check
      }
    }

    const shouldInjectIntoActiveTurn = providerRef.current === 'OPENCLAW' && isStreamActiveRef.current && !authoritativeBusy;
    if (shouldInjectIntoActiveTurn) {
      try {
        const targetSession = resolveOpenClawSessionKey(sessionRef.current || 'main');
        const directClient = directClientRef.current;
        if (USE_DIRECT_GATEWAY && directClient?.isConnected) {
          await directClient.injectMessage(targetSession, normalized);
        } else {
          if (streamManager.isConnected()) {
            const sent = streamManager.send({ type: 'inject', session: targetSession, text: normalized });
            if (!sent) {
              await client.post('/gateway/chat/inject', { session: targetSession, text: normalized });
            }
          } else {
            await client.post('/gateway/chat/inject', { session: targetSession, text: normalized });
          }
        }

        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'user',
          content: normalized,
          createdAt: new Date(),
          steer: true,
          provenance: 'live-steer',
        }]);
        setStatusText('Steer sent');
        setTimeout(() => setStatusText((curr) => curr === 'Steer sent' ? null : curr), 1500);
      } catch (err: any) {
        console.error('[ChatState] Failed to inject note into active OpenClaw turn:', err);
        setStatusText(`⚠️ ${normalizeAgentError(err, 'Live steer failed')}`);
        setTimeout(() => setStatusText(null), 4000);
      }
      return;
    }

    const shouldQueue = authoritativeBusy || isStreamActiveRef.current || (!isQueueDrainActiveRef.current && messageQueueRef.current.length > 0);
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
    if (USE_DIRECT_GATEWAY && providerRef.current === 'OPENCLAW' && directClient?.isConnected) {
      try {
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
        streamingAssistantIdRef.current = null;
      }
      return;
    }

    // Send via WS (portal middleman path for non-OPENCLAW or when direct gateway unavailable)
    if (streamManager.isConnected()) {
      const payload: Record<string, unknown> = {
        type: 'send',
        message: normalized,
        session: resolveOpenClawSessionKey(sessionRef.current || 'main') || 'main',
      };
      if (providerRef.current) payload.provider = providerRef.current;
      if (modelRef.current) payload.model = modelRef.current;
      if (agentIdRef.current) payload.agentId = agentIdRef.current;
      const sent = streamManager.send(payload);
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
          streamingAssistantIdRef.current = null;
        }
      }
    } else {
      // SSE fallback
      try {
        await sendViaSSE(normalized, assistantId);
      } catch (err: any) {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: '⚠️ ' + normalizeAgentError(err, 'Send failed') } : m
        ));
        setIsRunning(false);
        setStreamingPhase('idle');
        isStreamActiveRef.current = false;
        streamingAssistantIdRef.current = null;
      }
    }
  }, [normalizeAgentError, resetStreamWatchdog, resolveOpenClawSessionKey]);

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
            setMessages(prev => prev.flatMap(m => {
              if (m.id !== assistantId) return [m];
              const merged = { ...m, content: finalContent, provenance: prov || undefined };
              const keep = Boolean(
                (finalContent || '').trim() ||
                (merged.toolCalls && merged.toolCalls.length > 0) ||
                (merged.segments && merged.segments.length > 0) ||
                (merged.thinkingContent && merged.thinkingContent.trim())
              );
              return keep ? [merged] : [];
            }));
            setStreamingPhase('idle');
            setIsRunning(false);
            setLastProvenance(prov);
            isStreamActiveRef.current = false;
            streamingAssistantIdRef.current = null;
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
    if (USE_DIRECT_GATEWAY && providerRef.current === 'OPENCLAW' && directClient?.isConnected) {
      await directClient.injectMessage(targetSession, note);
      return;
    }

    if (streamManager.isConnected()) {
      const sent = streamManager.send({ type: 'inject', session: targetSession, text: note });
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
        if (streamManager.isConnected()) {
          streamManager.send({ type: 'abort', session: sessionRef.current, provider: providerRef.current });
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
  }, [clearStreamWatchdog]);

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
    if (USE_DIRECT_GATEWAY && providerRef.current === 'OPENCLAW' && directClientRef.current) {
      directClientRef.current.disconnect();
      directClientRef.current.connect();
      return;
    }
    streamManager.reconnect();
  }, []);

  const setFastModeModel = useCallback(async (nextModel: string) => {
    const normalized = String(nextModel || '').trim();
    if (!normalized) return;
    localStorage.setItem(FAST_MODEL_STORAGE_KEY, normalized);
    setFastModeModelState(normalized);
    if (!sessionControlsSupported || !fastModeEnabled) return;
    try {
      await gatewayAPI.patchSessionModel(session, normalized, provider);
      setSelectedModelRaw(normalized);
    } catch (err) {
      console.error('[ChatState] Failed to switch active fast model:', err);
    }
  }, [sessionControlsSupported, fastModeEnabled, session, provider]);

  // Toggle portal fast mode (model override to a cheaper/faster model; not a native OpenClaw fast-session flag)
  const toggleFastMode = useCallback(async () => {
    if (!sessionControlsSupported) return;
    try {
      if (!fastModeEnabled) {
        // Store current model and switch to fast model
        setBaseModel(selectedModel);
        await gatewayAPI.patchSessionModel(session, fastModeModel, provider);
        setSelectedModelRaw(fastModeModel);
        setFastModeEnabled(true);
      } else {
        // Restore original model
        const restoreModel = baseModel || 'anthropic/claude-sonnet-4-20250514';
        await gatewayAPI.patchSessionModel(session, restoreModel, provider);
        setSelectedModelRaw(restoreModel);
        setBaseModel(null);
        setFastModeEnabled(false);
      }
    } catch (err) {
      console.error('[ChatState] Failed to toggle fast mode:', err);
    }
  }, [sessionControlsSupported, fastModeEnabled, selectedModel, baseModel, fastModeModel, session, provider]);

  const setCompactionModelOverride = useCallback(async (model: string) => {
    setCompactionModelLoading(true);
    try {
      const normalized = String(model || '').trim();
      const patchResult = await gatewayAPI.patchConfigPath('agents.defaults.compaction.model', normalized || null);
      const patchedValue = typeof patchResult?.value === 'string' ? patchResult.value.trim() : '';
      setCompactionModelOverrideState(patchedValue);
      const fresh = await gatewayAPI.getConfigPath('agents.defaults.compaction.model', { silent: true, soft: true });
      const freshValue = typeof fresh?.value === 'string' ? fresh.value.trim() : '';
      setCompactionModelOverrideState(freshValue);
    } catch (err) {
      console.error('[ChatState] Failed to patch compaction model override:', err);
    } finally {
      setCompactionModelLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    gatewayAPI.getConfigPath('agents.defaults.compaction.model', { silent: true, soft: true })
      .then((data) => {
        if (cancelled) return;
        const value = typeof data?.value === 'string' ? data.value.trim() : '';
        setCompactionModelOverrideState(value);
      })
      .catch(() => {
        if (!cancelled) setCompactionModelOverrideState('');
      });
    return () => {
      cancelled = true;
    };
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
    wsManager: null, // Deprecated: use streamManager from StreamManager.ts
    reconnectSocket,
    // Session controls
    thinkingLevel,
    setThinkingLevel,
    fastModeEnabled,
    fastModeModel,
    setFastModeModel,
    toggleFastMode,
    compactionModelOverride,
    setCompactionModelOverride,
    compactionModelLoading,
    compactionModelError,
    sessionControlsSupported,
  };

  return (
    <ChatStateContext.Provider value={contextValue}>
      {children}
    </ChatStateContext.Provider>
  );
}
