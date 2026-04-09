/**
 * PersistentGatewayWs — Singleton persistent WebSocket connection to OpenClaw gateway.
 * 
 * This is the SOLE WebSocket connection to the OpenClaw gateway. All chat messages
 * are sent through this connection, and all streaming events are received here
 * and routed through StreamEventBus. This eliminates the race conditions that
 * arose from having two parallel WS connections (per-message + persistent).
 * 
 * Responsibilities:
 *   1. Maintain a persistent, auto-reconnecting WS to the gateway
 *   2. Send chat.send RPCs and return runIds
 *   3. Receive all agent/chat/compaction events and publish to StreamEventBus
 *   4. Handle exec.approval events
 */
// @ts-ignore - ws doesn't have type declarations in this project
import WebSocket from 'ws';
import { buildSignedDevice, getOrCreateDeviceKeys } from '../../utils/deviceIdentity';
import { getOpenClawWsUrl } from '../../config/openclaw';
import { streamEventBus } from '../../services/StreamEventBus';
import { sanitizeAssistantText, isControlOnlyAssistantText } from '../../utils/chatText';
import { getGatewayToken } from '../../utils/gatewayToken';

const DEBUG_GATEWAY_WS = process.env.DEBUG_GATEWAY_WS === '1';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_GATEWAY_WS) console.log('[PersistentGatewayWs]', ...args);
};

const GATEWAY_WS_URL = getOpenClawWsUrl();
const PROTOCOL_VERSION = 3;

let GATEWAY_TOKEN = getGatewayToken();
const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';
const GATEWAY_ROLE = 'operator';
const GATEWAY_SCOPES = ['operator.admin', 'operator.approvals'];

function extractGatewayMessageModel(payload: any): string | null {
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
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
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

export interface ExecApprovalResolved {
  id: string;
  decision: 'allow-once' | 'deny' | 'allow-always';
}

// Event callbacks
type ApprovalRequestCallback = (approval: ExecApprovalRequest) => void;
type ApprovalResolvedCallback = (resolved: ExecApprovalResolved) => void;

// Singleton state
let singletonWs: WebSocket | null = null;
let isConnecting = false;
let isAuthenticated = false;
let messageCounter = 0;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastSeq = 0;
let stateVersion: string | number | null = null;

// Pending RPC responses
const pendingResponses: Map<string, { resolve: (value: any) => void; reject: (err: Error) => void }> = new Map();

// Separate text accumulator for assistant stream events (resets per segment after tool calls).
const assistantLastSeenTextMap: Map<string, string> = new Map();

// Track which sessions have active runs (to filter stale replayed events)
const activeRunIds: Map<string, string> = new Map();

type ToolPhaseState = {
  runId?: string;
  toolName: string;
  phase: 'start' | 'result';
};

// Deduplicate repeated gateway tool snapshots for the same session/run/tool phase.
const lastToolPhaseBySession: Map<string, ToolPhaseState> = new Map();

// Event listeners
const approvalRequestListeners: Set<ApprovalRequestCallback> = new Set();
const approvalResolvedListeners: Set<ApprovalResolvedCallback> = new Set();

function nextId(): string {
  return `rpc-${Date.now()}-${++messageCounter}`;
}

function getReconnectDelay(): number {
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  return delay;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = getReconnectDelay();
  reconnectAttempts++;
  debugLog(`Scheduling reconnect in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // Re-resolve token on every reconnect — picks up changes from `openclaw onboard`
    GATEWAY_TOKEN = getGatewayToken();
    if (!GATEWAY_TOKEN) {
      debugLog('No gateway token available, will retry later');
      scheduleReconnect();
      return;
    }
    connect();
  }, delay);
}

/* ─── Agent/Chat event handlers for StreamEventBus ──────────────────── */

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return sanitizeAssistantText(content);
  if (Array.isArray(content)) {
    const joined = (content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text || '')
      .join('\n');
    return sanitizeAssistantText(joined);
  }
  return '';
}

function sanitizeAssistantDelta(text: string): string {
  if (!text) return '';
  const sanitized = sanitizeAssistantText(text);
  return isControlOnlyAssistantText(sanitized) ? '' : sanitized;
}

function getToolIcon(name: string): string {
  const icons: Record<string, string> = {
    Read: '📖', read: '📖', Write: '✏️', write: '✏️', Edit: '✏️', edit: '✏️',
    exec: '⚙️', Exec: '⚙️', web_search: '🔍', web_fetch: '🌐',
    browser: '🌐', image: '🖼️', message: '💬', tts: '🔊',
  };
  return icons[name] || '🔧';
}

/**
 * Handle `agent` events from the gateway.
 * Shape: { runId, sessionKey, stream: 'assistant'|'tool'|'lifecycle'|'compaction', seq, data }
 */
function handleAgentEvent(payload: Record<string, unknown> | undefined): void {
  if (!payload) return;

  const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : '';
  if (!sessionKey) return;

  const stream = typeof payload.stream === 'string' ? payload.stream : '';
  const data = (payload.data && typeof payload.data === 'object' ? payload.data : {}) as Record<string, unknown>;
  const runId = typeof payload.runId === 'string' ? payload.runId : undefined;

  // Compaction events are session-level — always process them
  if (stream === 'compaction') {
    const compPhase = String(
      typeof data.phase === 'string'
        ? data.phase
        : (typeof data.status === 'string' ? data.status : ''),
    ).toLowerCase();
    debugLog(`COMPACTION event: sessionKey="${sessionKey}" phase="${compPhase}"`);
    if (compPhase === 'start' || compPhase === 'started' || compPhase === 'compacting') {
      streamEventBus.publish(sessionKey, { type: 'compaction_start', content: 'Compacting context…' });
    } else if (compPhase === 'end' || compPhase === 'completed' || compPhase === 'compacted') {
      streamEventBus.publish(sessionKey, { type: 'compaction_end', content: 'Context compacted' });
    }
    return;
  }

  // Only process other events for sessions that have active subscribers
  if (!streamEventBus.hasSubscribers(sessionKey)) return;

  // Filter by runId: if we have an active run for this session, ignore events from other runs.
  // This prevents replayed/stale events from interfering.
  const expectedRunId = activeRunIds.get(sessionKey);
  if (expectedRunId && runId && runId !== expectedRunId) {
    debugLog(`Ignoring agent event for stale runId=${runId} (expected ${expectedRunId})`);
    return;
  }

  // If no active runId is set but the event has one, adopt it (new run segment after yield)
  if (!expectedRunId && runId) {
    activeRunIds.set(sessionKey, runId);
    debugLog(`Adopted new runId=${runId} for session ${sessionKey} (resumed after yield)`);
    // Reset text accumulators for the new run
    assistantLastSeenTextMap.delete(sessionKey);
    lastToolPhaseBySession.delete(sessionKey);
    streamEventBus.setLastSeenText(sessionKey, '');
    streamEventBus.setLatestText(sessionKey, '');
    // Signal the frontend that a new run segment has started
    streamEventBus.publish(sessionKey, { type: 'run_resumed', content: '' });
  }

  // Ensure the stream is tracked
  streamEventBus.startStream(sessionKey, runId);

  if (stream === 'assistant') {
    const text = typeof data.text === 'string' ? sanitizeAssistantDelta(data.text) : undefined;
    const delta = typeof data.delta === 'string' ? sanitizeAssistantDelta(data.delta) : undefined;

    const assistantLastSeen = assistantLastSeenTextMap.get(sessionKey) || '';

    if (text) {
      if (text.length < assistantLastSeen.length) {
        // Text reset — new segment after tool call
        debugLog(`ASSISTANT RESET: prev=${assistantLastSeen.length} new=${text.length}`);
        assistantLastSeenTextMap.set(sessionKey, text);
        streamEventBus.setLastSeenText(sessionKey, text);
        if (text) {
          streamEventBus.updateStreamPhase(sessionKey, { phase: 'streaming' });
          streamEventBus.publish(sessionKey, { type: 'text', content: text, replace: true });
        }
      } else if (text.length > assistantLastSeen.length) {
        const newPart = text.substring(assistantLastSeen.length);
        streamEventBus.updateStreamPhase(sessionKey, { phase: 'streaming' });
        streamEventBus.publish(sessionKey, { type: 'text', content: newPart });
        assistantLastSeenTextMap.set(sessionKey, text);
        streamEventBus.setLastSeenText(sessionKey, text);
      }
    } else if (delta) {
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'streaming' });
      streamEventBus.publish(sessionKey, { type: 'text', content: delta });
      const nextSeen = assistantLastSeen + delta;
      assistantLastSeenTextMap.set(sessionKey, nextSeen);
      streamEventBus.setLastSeenText(sessionKey, nextSeen);
    }
    return;
  }

  if (stream === 'thinking') {
    const thinkingText = typeof data.text === 'string'
      ? data.text
      : (typeof data.delta === 'string' ? data.delta : (typeof data.content === 'string' ? data.content : ''));
    if (thinkingText) {
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking' });
      streamEventBus.publish(sessionKey, { type: 'thinking', content: thinkingText });
    }
    return;
  }

  if (stream === 'tool') {
    const phase = typeof data.phase === 'string' ? data.phase : '';
    const toolName = typeof data.name === 'string' ? data.name : 'tool';
    const lastToolPhase = lastToolPhaseBySession.get(sessionKey);
    const isDuplicateToolPhase = (
      lastToolPhase
      && lastToolPhase.phase === phase
      && lastToolPhase.toolName === toolName
      && (lastToolPhase.runId || '') === (runId || '')
    );

    if (isDuplicateToolPhase) {
      debugLog(`Ignoring duplicate tool.${phase} for ${sessionKey} runId=${runId || 'none'} tool=${toolName}`);
      return;
    }

    console.log(`[PersistentGatewayWs] TOOL EVENT: phase=${phase} name=${toolName} session=${sessionKey}`);

    if (phase === 'start') {
      lastToolPhaseBySession.set(sessionKey, { runId, toolName, phase: 'start' });
      const lastSeen = streamEventBus.getLastSeenText(sessionKey);
      if (lastSeen.length > 0) {
        streamEventBus.publish(sessionKey, { type: 'segment_break', content: '' });
        streamEventBus.setLastSeenText(sessionKey, '');
      }
      const icon = getToolIcon(toolName);
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'tool', toolName });
      streamEventBus.publish(sessionKey, {
        type: 'tool_start',
        content: `${icon} Using tool: ${toolName}`,
        toolName,
        toolArgs: data.input || data.args,
      });
    } else if (phase === 'result') {
      lastToolPhaseBySession.set(sessionKey, { runId, toolName, phase: 'result' });
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'streaming', toolName: undefined });
      const output = typeof data.output === 'string' ? data.output.substring(0, 500) : undefined;
      streamEventBus.publish(sessionKey, {
        type: 'tool_end',
        content: `✅ Tool completed: ${toolName}`,
        toolName,
        toolResult: output,
      });
    }
    return;
  }

  if (stream === 'lifecycle') {
    const phase = typeof data.phase === 'string' ? data.phase : '';

    if (phase === 'end') {
      // lifecycle.end fires at the END of each agent run segment — including after tool calls.
      // The real end is signaled by chat.state === 'final'.
      debugLog(`lifecycle.end for ${sessionKey} — ignoring (waiting for chat.final)`);
    } else if (phase === 'error') {
      const errMsg = typeof data.error === 'string'
        ? data.error
        : (typeof data.errorMessage === 'string' ? data.errorMessage : 'Agent error');
      streamEventBus.publish(sessionKey, { type: 'error', content: errMsg });
      streamEventBus.clearStream(sessionKey);
      activeRunIds.delete(sessionKey);
      assistantLastSeenTextMap.delete(sessionKey);
      lastToolPhaseBySession.delete(sessionKey);
    } else if (phase === 'started' || phase === 'running') {
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking' });
      streamEventBus.publish(sessionKey, { type: 'thinking', content: '🧠 Agent is thinking…' });
      streamEventBus.publish(sessionKey, { type: 'status', content: '🧠 Agent is thinking…' });
    }
    return;
  }
}

/**
 * Handle `chat` events from the gateway.
 * Shape: { runId, sessionKey, seq, state: 'delta'|'final'|'error', message?, errorMessage? }
 */
function handleChatEvent(payload: Record<string, unknown> | undefined): void {
  if (!payload) return;

  const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey : '';
  if (!sessionKey) return;

  const state = typeof payload.state === 'string' ? payload.state : '';

  // Compaction can also arrive via chat events (state: 'compacting' or similar).
  // Process these regardless of subscribers.
  if (state === 'compacting' || state === 'compaction_start' || state === 'compaction_started') {
    debugLog(`COMPACTION via chat event: sessionKey="${sessionKey}" state="${state}"`);
    streamEventBus.publish(sessionKey, { type: 'compaction_start', content: 'Compacting context…' });
    return;
  }
  if (state === 'compacted' || state === 'compaction_end' || state === 'compaction_completed') {
    debugLog(`COMPACTION END via chat event: sessionKey="${sessionKey}" state="${state}"`);
    streamEventBus.publish(sessionKey, { type: 'compaction_end', content: 'Context compacted' });
    return;
  }

  // Only process other events for sessions that have active subscribers
  if (!streamEventBus.hasSubscribers(sessionKey)) return;

  const runId = typeof payload.runId === 'string' ? payload.runId : undefined;

  // Filter by runId
  const expectedRunId = activeRunIds.get(sessionKey);
  if (expectedRunId && runId && runId !== expectedRunId) {
    debugLog(`Ignoring chat event state=${state} for stale runId=${runId} (expected ${expectedRunId})`);
    return;
  }

  // If no active runId is set but the event has one, adopt it (new run segment)
  if (!expectedRunId && runId) {
    const wasRecent = streamEventBus.wasRecentlyDone(sessionKey);
    activeRunIds.set(sessionKey, runId);
    debugLog(`Adopted new runId=${runId} for session ${sessionKey} via chat event (wasRecentlyDone=${wasRecent})`);
    // Reset text accumulators for the new run
    assistantLastSeenTextMap.delete(sessionKey);
    lastToolPhaseBySession.delete(sessionKey);
    streamEventBus.setLastSeenText(sessionKey, '');
    streamEventBus.setLatestText(sessionKey, '');
    // If the session was recently done, signal resumption
    if (wasRecent) {
      streamEventBus.publish(sessionKey, { type: 'run_resumed', content: '' });
    }
  }

  // Ensure the stream is tracked
  streamEventBus.startStream(sessionKey, runId);

  if (state === 'delta') {
    // Chat deltas carry accumulated text across the ENTIRE response (never resets).
    // The assistant stream is the primary text source (faster, per-token).
    // Chat deltas only serve as position tracking — no text emission here.
    return;
  }

  if (state === 'final') {
    const message = payload.message as Record<string, unknown> | undefined;
    const finalText = message ? extractTextFromContent(message.content) : '';
    const finalModel = extractGatewayMessageModel(payload);

    // Reconcile final text against what was already streamed.
    // IMPORTANT: After tool calls, the gateway's final message.content contains ALL
    // text segments concatenated (pre-tool + post-tool), but our latestText only has
    // the post-tool segment (reset by segment_break/replace). We must NOT replace the
    // clean post-tool text with the full concatenated text, because the frontend has
    // already rendered the text correctly in segments. Only reconcile if:
    // (a) nothing was streamed at all, or
    // (b) the final text is a direct continuation of what was streamed.
    // If the streamed text is a substring of the final (multi-segment concat), skip.
    if (finalText && !isControlOnlyAssistantText(finalText)) {
      const streamedText = streamEventBus.getLatestText(sessionKey);
      if (!streamedText) {
        // Nothing was streamed — deliver the full final text
        streamEventBus.publish(sessionKey, { type: 'text', content: finalText, replace: true });
      } else if (finalText === streamedText) {
        // Exact match — nothing to do
      } else if (finalText.startsWith(streamedText) && finalText.length > streamedText.length) {
        // Final is a continuation of what we have — append the tail
        streamEventBus.publish(sessionKey, { type: 'text', content: finalText.substring(streamedText.length) });
      } else if (finalText.includes(streamedText)) {
        // Our streamed text is a substring of the final (multi-segment).
        // The stream already showed the correct latest segment — don't replace
        // with the full concatenated text as that would show old pre-tool content.
        debugLog(`Skipping final text reconciliation: streamedText is a segment of finalText (streamed=${streamedText.length}, final=${finalText.length})`);
      } else if (finalText.length > streamedText.length * 2) {
        // Final is much larger — likely multi-segment concat. Skip to avoid duplication.
        debugLog(`Skipping oversized final text: final=${finalText.length} vs streamed=${streamedText.length}`);
      } else {
        // Genuinely different — replace (covers edge cases like compaction rewrites)
        streamEventBus.publish(sessionKey, { type: 'text', content: finalText, replace: true });
      }
    }

    streamEventBus.publish(sessionKey, {
      type: 'done',
      content: isControlOnlyAssistantText(finalText) ? '' : finalText,
      model: finalModel,
    });

    // Use soft-clear instead of hard-clear: the agent may resume after a sub-agent
    // completes (sessions_yield → sub-agent → result injected → new run starts).
    // Soft-clear resets text accumulators but preserves subscribers so the next run's
    // events are still forwarded to the browser.
    streamEventBus.softClearStream(sessionKey);
    activeRunIds.delete(sessionKey);
    assistantLastSeenTextMap.delete(sessionKey);
    lastToolPhaseBySession.delete(sessionKey);
    return;
  }

  if (state === 'error') {
    const errMsg = typeof payload.errorMessage === 'string'
      ? payload.errorMessage
      : (typeof payload.error === 'string' ? payload.error : 'Chat error');
    streamEventBus.publish(sessionKey, { type: 'error', content: errMsg });
    streamEventBus.clearStream(sessionKey);
    activeRunIds.delete(sessionKey);
    assistantLastSeenTextMap.delete(sessionKey);
    lastToolPhaseBySession.delete(sessionKey);
    return;
  }

  if (state === 'aborted') {
    const latestText = streamEventBus.getLatestText(sessionKey);
    const abortedText = typeof payload.text === 'string' && payload.text.length > 0
      ? payload.text
      : latestText;
    streamEventBus.publish(sessionKey, { type: 'done', content: abortedText, model: extractGatewayMessageModel(payload) });
    streamEventBus.clearStream(sessionKey);
    activeRunIds.delete(sessionKey);
    assistantLastSeenTextMap.delete(sessionKey);
    lastToolPhaseBySession.delete(sessionKey);
    return;
  }
}

function connect(): void {
  if (singletonWs && singletonWs.readyState === WebSocket.OPEN) {
    debugLog('Already connected');
    return;
  }

  if (isConnecting) {
    debugLog('Connection already in progress');
    return;
  }

  isConnecting = true;
  isAuthenticated = false;

  const keys = getOrCreateDeviceKeys();
  let connectId: string | undefined;

  const sendConnect = (nonce?: string) => {
    connectId = nextId();
    const params: Record<string, unknown> = {
        auth: { token: GATEWAY_TOKEN },
        client: {
          id: CLIENT_ID,
          mode: CLIENT_MODE,
          version: '1.0.0',
          displayName: 'Portal Backend RPC',
          platform: 'linux',
          instanceId: 'portal-persistent-rpc',
        },
        device: buildSignedDevice({
          keys,
          clientId: CLIENT_ID,
          clientMode: CLIENT_MODE,
          role: GATEWAY_ROLE,
          scopes: GATEWAY_SCOPES,
          token: GATEWAY_TOKEN,
          nonce,
        }),
        role: GATEWAY_ROLE,
        scopes: GATEWAY_SCOPES,
        caps: ['tool-events'],
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      };

    // NOTE: Do NOT send lastSeq, stateVersion, or any resume hints here.
    // OpenClaw 2026.3.x has strict connect param validation and rejects
    // ANY unknown top-level property, causing permanent connect failures.
    // Session resume is not supported by the gateway — omit entirely.

    const msg = {
      type: 'req',
      id: connectId,
      method: 'connect',
      params,
    };
    ws.send(JSON.stringify(msg));
  };

  debugLog(`Connecting to ${GATEWAY_WS_URL}`);

  let ws: WebSocket;
  try {
    ws = new WebSocket(GATEWAY_WS_URL);
  } catch (err: any) {
    console.error(`[PersistentGatewayWs] WebSocket creation failed: ${err.message}`);
    isConnecting = false;
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    debugLog('WebSocket opened, waiting for connect.challenge');
  });

  ws.on('message', (raw: Buffer | string) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Connect challenge
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      const nonce = msg.payload?.nonce;
      sendConnect(nonce);
      return;
    }

    // RPC responses
    if (msg.type === 'res') {
      // Connect response
      if (msg.id === connectId) {
        if (!msg.ok) {
          console.error(`[PersistentGatewayWs] Connect failed: ${msg.error?.message || 'Unknown error'}`);
          ws.close();
          return;
        }
        isAuthenticated = true;
        isConnecting = false;
        reconnectAttempts = 0;
        if (msg.stateVersion !== undefined && msg.stateVersion !== null) {
          stateVersion = msg.stateVersion;
        } else if (msg.payload?.stateVersion !== undefined && msg.payload?.stateVersion !== null) {
          stateVersion = msg.payload.stateVersion;
        }
        debugLog('Authenticated and listening for events');

        // On reconnect, restore active session tracking and notify StreamEventBus
        // that sessions may need to be re-subscribed.
        const snapshot = (globalThis as any).__persistentWsActiveSessionsSnapshot as Map<string, string> | undefined;
        if (snapshot && snapshot.size > 0) {
          debugLog(`Reconnected with ${snapshot.size} previously active sessions`);
          // Re-register the active runs so events are accepted
          for (const [sessionKey, runId] of snapshot) {
            activeRunIds.set(sessionKey, runId);
            // Mark the session as potentially resuming in StreamEventBus
            streamEventBus.startStream(sessionKey, runId);
          }
          // Clear the snapshot
          delete (globalThis as any).__persistentWsActiveSessionsSnapshot;
        }
        return;
      }

      // Other RPC responses (chat.send, exec.approval.resolve, etc.)
      const pending = pendingResponses.get(msg.id);
      if (pending) {
        pendingResponses.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg.payload || msg.result);
        } else {
          pending.reject(new Error(msg.error?.message || 'RPC failed'));
        }
      }
      return;
    }

    // Events
    if (msg.type !== 'event') return;
    if (typeof msg.seq === 'number' && Number.isFinite(msg.seq)) {
      lastSeq = Math.max(lastSeq, msg.seq);
    }
    if (!isAuthenticated) return;

    // Exec approval requested
    if (msg.event === 'exec.approval.requested') {
      const payload = msg.payload;
      if (!payload?.id) return;

      debugLog(`exec.approval.requested: id=${payload.id} command="${payload.request?.command?.substring(0, 50)}..."`);

      const approval: ExecApprovalRequest = {
        id: payload.id,
        request: payload.request || {},
        createdAtMs: payload.createdAtMs || Date.now(),
        expiresAtMs: payload.expiresAtMs || Date.now() + 30000,
      };

      for (const listener of approvalRequestListeners) {
        try {
          listener(approval);
        } catch (err: any) {
          console.error('[PersistentGatewayWs] Approval request listener error:', err.message);
        }
      }

      // Also publish to StreamEventBus so the browser gets it via the active stream subscription
      if (approval.request?.sessionKey && streamEventBus.hasSubscribers(approval.request.sessionKey)) {
        streamEventBus.publish(approval.request.sessionKey, {
          type: 'status',
          content: '⏳ Waiting for command approval…',
          approval,
        } as any);
      }
      return;
    }

    // Exec approval resolved
    if (msg.event === 'exec.approval.resolved') {
      const payload = msg.payload;
      if (!payload?.id) return;

      debugLog(`exec.approval.resolved: id=${payload.id} decision=${payload.decision}`);

      const resolved: ExecApprovalResolved = {
        id: payload.id,
        decision: payload.decision,
      };

      for (const listener of approvalResolvedListeners) {
        try {
          listener(resolved);
        } catch (err: any) {
          console.error('[PersistentGatewayWs] Approval resolved listener error:', err.message);
        }
      }
      return;
    }

    // Agent stream events
    if (msg.event === 'agent') {
      handleAgentEvent(msg.payload);
      return;
    }

    // Chat stream events
    if (msg.event === 'chat') {
      handleChatEvent(msg.payload);
      return;
    }

    // Log unhandled events for debugging (helps discover new event types like compaction)
    if (msg.event) {
      debugLog(`UNHANDLED event type: "${msg.event}" payload keys: ${Object.keys(msg.payload || {}).join(',')}`);
    }
  });

  ws.on('error', (err: any) => {
    console.error(`[PersistentGatewayWs] WebSocket error: ${err.message}`);
  });

  ws.on('close', (code: number, reason: Buffer) => {
    const reasonStr = reason?.toString() || '';
    debugLog(`WebSocket closed: code=${code} ${reasonStr}`);

    // Preserve activeRunIds before clearing state — we'll use these on reconnect
    // to re-seed StreamEventBus if the gateway still has active sessions.
    const activeSessionsSnapshot = new Map(activeRunIds);

    singletonWs = null;
    isConnecting = false;
    isAuthenticated = false;

    // Reject any pending RPC calls
    for (const [id, pending] of pendingResponses) {
      pending.reject(new Error('WebSocket connection closed'));
      pendingResponses.delete(id);
    }

    // Store the snapshot for use on reconnect
    (globalThis as any).__persistentWsActiveSessionsSnapshot = activeSessionsSnapshot;

    scheduleReconnect();
  });

  singletonWs = ws;
}

/* ─── Public API ────────────────────────────────────────────────────── */

/**
 * Initialize the persistent WebSocket connection.
 * Call this on server startup.
 */
export function initPersistentGatewayWs(): void {
  lastSeq = 0;
  stateVersion = null;
  // Re-resolve token at init time (picks up openclaw.json changes since module load)
  GATEWAY_TOKEN = getGatewayToken();
  if (!GATEWAY_TOKEN) {
    console.warn('[PersistentGatewayWs] No gateway token found (env or openclaw.json), skipping persistent WS');
    return;
  }
  connect();
}

/**
 * Shutdown the persistent WebSocket connection.
 */
export function shutdownPersistentGatewayWs(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (singletonWs) {
    try { singletonWs.close(); } catch {}
    singletonWs = null;
  }
  isConnecting = false;
  isAuthenticated = false;
}

/**
 * Register a listener for exec approval requests.
 */
export function onApprovalRequest(callback: ApprovalRequestCallback): () => void {
  approvalRequestListeners.add(callback);
  return () => approvalRequestListeners.delete(callback);
}

/**
 * Register a listener for exec approval resolved events.
 */
export function onApprovalResolved(callback: ApprovalResolvedCallback): () => void {
  approvalResolvedListeners.add(callback);
  return () => approvalResolvedListeners.delete(callback);
}

/**
 * Send a chat message via the persistent WebSocket.
 * Returns the runId on success.
 * 
 * This replaces the per-message WS in OpenClawProvider — all chat messages
 * now go through the single persistent connection. Events for this session
 * will be received by the same connection and published to StreamEventBus.
 */
export async function sendChatMessage(
  sessionKey: string,
  message: string,
  idempotencyKey: string,
): Promise<{ runId: string }> {
  if (!singletonWs || singletonWs.readyState !== WebSocket.OPEN) {
    throw new Error('Persistent WebSocket not connected');
  }
  if (!isAuthenticated) {
    throw new Error('Persistent WebSocket not authenticated');
  }

  const requestId = nextId();

  // Register this session's run expectation BEFORE sending (prevents race with
  // stale replayed events that arrive between send and response).
  // We'll set the real runId when the response arrives.

  return new Promise((resolve, reject) => {
    const timeoutTimer = setTimeout(() => {
      pendingResponses.delete(requestId);
      reject(new Error('chat.send RPC timeout'));
    }, 30000);

    pendingResponses.set(requestId, {
      resolve: (payload: any) => {
        clearTimeout(timeoutTimer);
        const runId = payload?.runId || '';
        if (runId) {
          activeRunIds.set(sessionKey, runId);
          debugLog(`chat.send accepted: sessionKey=${sessionKey} runId=${runId}`);
        }
        resolve({ runId });
      },
      reject: (err: Error) => {
        clearTimeout(timeoutTimer);
        reject(err);
      },
    });

    try {
      singletonWs!.send(JSON.stringify({
        type: 'req',
        id: requestId,
        method: 'chat.send',
        params: {
          sessionKey,
          message,
          idempotencyKey,
          deliver: false,
        },
      }));
    } catch (err: any) {
      clearTimeout(timeoutTimer);
      pendingResponses.delete(requestId);
      reject(new Error(`Failed to send chat.send: ${err.message}`));
    }
  });
}


export async function injectChatMessage(sessionKey: string, text: string): Promise<void> {
  if (!singletonWs || singletonWs.readyState !== WebSocket.OPEN) {
    throw new Error('Persistent WebSocket not connected');
  }
  if (!isAuthenticated) {
    throw new Error('Persistent WebSocket not authenticated');
  }

  const requestId = nextId();

  return new Promise((resolve, reject) => {
    const timeoutTimer = setTimeout(() => {
      pendingResponses.delete(requestId);
      reject(new Error('chat.inject RPC timeout'));
    }, 30000);

    pendingResponses.set(requestId, {
      resolve: () => {
        clearTimeout(timeoutTimer);
        resolve();
      },
      reject: (err: Error) => {
        clearTimeout(timeoutTimer);
        reject(err);
      },
    });

    try {
      singletonWs!.send(JSON.stringify({
        type: 'req',
        id: requestId,
        method: 'chat.inject',
        params: {
          sessionKey,
          text,
          role: 'assistant',
        },
      }));
    } catch (err: any) {
      clearTimeout(timeoutTimer);
      pendingResponses.delete(requestId);
      reject(new Error(`Failed to send chat.inject: ${err.message}`));
    }
  });
}

/**
 * Send an exec approval decision via the persistent WebSocket.
 */
export async function sendApprovalDecision(
  approvalId: string,
  decision: 'allow-once' | 'deny' | 'allow-always',
): Promise<{ ok: boolean; error?: string }> {
  if (!singletonWs || singletonWs.readyState !== WebSocket.OPEN) {
    return { ok: false, error: 'Persistent WebSocket not connected' };
  }
  if (!isAuthenticated) {
    return { ok: false, error: 'Persistent WebSocket not authenticated' };
  }

  const requestId = nextId();
  const request = {
    type: 'req',
    id: requestId,
    method: 'exec.approval.resolve',
    params: {
      id: approvalId,
      decision,
    },
  };

  return new Promise((resolve) => {
    const timeoutTimer = setTimeout(() => {
      pendingResponses.delete(requestId);
      resolve({ ok: false, error: 'RPC timeout' });
    }, 10000);

    pendingResponses.set(requestId, {
      resolve: () => {
        clearTimeout(timeoutTimer);
        resolve({ ok: true });
      },
      reject: (err: Error) => {
        clearTimeout(timeoutTimer);
        resolve({ ok: false, error: err.message });
      },
    });

    try {
      debugLog(`Sending exec.approval.resolve: id=${approvalId} decision=${decision}`);
      singletonWs!.send(JSON.stringify(request));
    } catch (err: any) {
      clearTimeout(timeoutTimer);
      pendingResponses.delete(requestId);
      resolve({ ok: false, error: err.message });
    }
  });
}

/**
 * Check if the persistent WebSocket is connected and authenticated.
 */
export function isConnected(): boolean {
  return singletonWs !== null && singletonWs.readyState === WebSocket.OPEN && isAuthenticated;
}

/**
 * Force an immediate reconnect attempt if not currently connected.
 */
export function reconnectNow(): void {
  if (isConnected() || isConnecting) return;
  // Re-resolve token on each reconnect attempt (picks up config changes)
  GATEWAY_TOKEN = getGatewayToken();
  if (!GATEWAY_TOKEN) return;
  connect();
}

/**
 * Register a run for a session — used when we need to track a runId
 * that was obtained externally (e.g. via REST RPC fallback).
 */
export function registerRun(sessionKey: string, runId: string): void {
  activeRunIds.set(sessionKey, runId);
}

/**
 * Clear the active run for a session.
 */
export function clearRun(sessionKey: string): void {
  activeRunIds.delete(sessionKey);
  assistantLastSeenTextMap.delete(sessionKey);
  lastToolPhaseBySession.delete(sessionKey);
}
