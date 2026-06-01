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
const MIN_PROTOCOL_VERSION = 3;
const MAX_PROTOCOL_VERSION = 4;

let GATEWAY_TOKEN = getGatewayToken();
const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';
const GATEWAY_ROLE = 'operator';
const GATEWAY_SCOPES = ['operator.admin', 'operator.read', 'operator.approvals'];

function isExpectedGatewayReconnectError(error: unknown): boolean {
  const message = String((error as any)?.message || error || '').trim();
  return /ECONNREFUSED|connect ECONNREFUSED|socket hang up|ETIMEDOUT|ECONNRESET/i.test(message);
}

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
const LIFECYCLE_FLUSH_DONE_RE = /\b(memory flush complete(?:d)?|durable memor(?:y|ies) (?:stored|written)|context refreshed|context maintenance complete(?:d)?|heartbeat check complete(?:d)?|heartbeat_ok)\b/i;
const LIFECYCLE_COMPACTING_RE = /\b(compacting context|auto-compaction|context compaction|compaction in progress)\b/i;
const LIFECYCLE_COMPACTED_RE = /\b(context compacted|compaction complete(?:d)?)\b/i;

type LifecycleMaintenanceSignal = 'idle' | 'maintenance' | 'maintenance_done' | 'compacting' | 'compacted';

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

function extractToolResultText(value: any): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== 'object') return undefined;

  const directCandidates = [
    value.output,
    value.stdout,
    value.stderr,
    value.text,
    value.message,
    value.error,
    value.result,
  ];
  const directParts = directCandidates
    .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    .map((candidate) => candidate.trim());
  if (directParts.length > 0) return directParts.join('\n');

  if (Array.isArray(value.content)) {
    const contentParts = value.content
      .map((block: any) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          if (typeof block.text === 'string') return block.text;
          if (typeof block.content?.text === 'string') return block.content.text;
          if (typeof block.content === 'string') return block.content;
        }
        return '';
      })
      .filter((part: string) => part.trim().length > 0)
      .map((part: string) => part.trim());
    if (contentParts.length > 0) return contentParts.join('\n');
  }

  return undefined;
}

function inferLifecycleMaintenanceSignal(phase: string, statusText: string | null): LifecycleMaintenanceSignal {
  const normalizedPhase = String(phase || '').trim().toLowerCase();
  const normalizedStatus = String(statusText || '').trim();

  if (normalizedPhase === 'compacted' || normalizedPhase === 'compaction_end' || normalizedPhase === 'compaction_completed') {
    return 'compacted';
  }
  if (normalizedPhase === 'compacting' || normalizedPhase === 'compaction_start' || normalizedPhase === 'compaction_started') {
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

// Chat events carry cumulative assistant text on newer OpenClaw builds. Use them
// as the fallback live-text source when assistant stream events are metadata-only.
const chatLastSeenTextMap: Map<string, string> = new Map();
const sessionsWithAssistantTextStream: Set<string> = new Set();

// Track which sessions have active runs (to filter stale replayed events)
const activeRunIds: Map<string, string> = new Map();

// Track session-message subscriptions on the singleton backend gateway socket.
// OpenClaw's Control UI subscribes to live session events and handles runtime
// events directly; history is only the durable record. The portal mirrors that
// model here so context maintenance can update the rail even when no transcript
// reload happens.
const desiredSessionMessageSubscriptions: Set<string> = new Set();
const activeSessionMessageSubscriptions: Set<string> = new Set();
const latestCompactionCheckpointBySession: Map<string, string> = new Map();

function resolveSessionKeyForGatewayPayload(payload: Record<string, unknown> | undefined): string {
  const direct = typeof payload?.sessionKey === 'string' ? payload.sessionKey.trim() : '';
  if (direct) return direct;

  // Some OpenClaw runtime events, especially compaction events, are emitted
  // run-scoped without a sessionKey. Control UI accepts those when the runId
  // matches the active chat. Do the same instead of dropping them.
  const runId = typeof payload?.runId === 'string' ? payload.runId.trim() : '';
  if (!runId) return '';
  for (const [sessionKey, activeRunId] of activeRunIds) {
    if (activeRunId === runId) return sessionKey;
  }
  return '';
}

function compactionCheckpointSignature(payload: any): string | null {
  const row = payload?.session && typeof payload.session === 'object' ? payload.session : payload;
  const checkpoint = row?.latestCompactionCheckpoint;
  const count = typeof row?.compactionCheckpointCount === 'number' && Number.isFinite(row.compactionCheckpointCount)
    ? row.compactionCheckpointCount
    : null;
  if (!checkpoint && count == null) return null;
  const checkpointId = typeof checkpoint?.checkpointId === 'string' && checkpoint.checkpointId.trim()
    ? checkpoint.checkpointId.trim()
    : (typeof checkpoint?.id === 'string' && checkpoint.id.trim() ? checkpoint.id.trim() : '');
  const createdAt = typeof checkpoint?.createdAt === 'number' && Number.isFinite(checkpoint.createdAt)
    ? checkpoint.createdAt
    : '';
  return `${count ?? ''}:${checkpointId}:${createdAt}`;
}

type ToolPhaseState = {
  runId?: string;
  toolName: string;
  phase: 'start' | 'result';
};

// Deduplicate repeated gateway tool snapshots for the same session/run/tool phase.
const lastToolPhaseBySession: Map<string, ToolPhaseState> = new Map();

// OpenClaw 2026.5.x Codex/app-server sessions can finish the chat run before
// the visible assistant delivery mirror is emitted on `session.message`.
// If we immediately publish `done` for an empty `chat.final`, the browser closes
// the live bubble and the actual answer only appears after a history reload. Hold
// those empty finals briefly and complete the stream when the assistant message
// arrives. If no mirror arrives, release the empty done so the UI does not hang.
const pendingEmptyFinalBySession: Map<string, {
  runId?: string;
  model?: string | null;
  timer: ReturnType<typeof setTimeout>;
}> = new Map();

const messageToolReplyBySession: Map<string, {
  text: string;
  ts: number;
}> = new Map();

const recentlyCompletedRunBySession: Map<string, {
  runId: string;
  ts: number;
}> = new Map();

const recentlyCompletedDeliveryBySession: Map<string, {
  text: string;
  ts: number;
}> = new Map();

const pendingCodexIdleTimeoutBySession: Map<string, {
  runId?: string;
  errorText: string;
  timer: ReturnType<typeof setTimeout>;
}> = new Map();

// Event listeners
const approvalRequestListeners: Set<ApprovalRequestCallback> = new Set();
const approvalResolvedListeners: Set<ApprovalResolvedCallback> = new Set();

function nextId(): string {
  return `rpc-${Date.now()}-${++messageCounter}`;
}

function clearPendingEmptyFinal(sessionKey: string): { runId?: string; model?: string | null } | null {
  const pending = pendingEmptyFinalBySession.get(sessionKey);
  if (!pending) return null;
  clearTimeout(pending.timer);
  pendingEmptyFinalBySession.delete(sessionKey);
  return { runId: pending.runId, model: pending.model };
}

function cleanupCompletedRun(sessionKey: string, runId?: string): void {
  // Use soft-clear instead of hard-clear: the agent may resume after a sub-agent
  // completes (sessions_yield → sub-agent → result injected → new run starts).
  // Soft-clear resets text accumulators but preserves subscribers so the next run's
  // events are still forwarded to the browser.
  if (runId) {
    recentlyCompletedRunBySession.set(sessionKey, { runId, ts: Date.now() });
  }
  streamEventBus.softClearStream(sessionKey);
  activeRunIds.delete(sessionKey);
  assistantLastSeenTextMap.delete(sessionKey);
  chatLastSeenTextMap.delete(sessionKey);
  sessionsWithAssistantTextStream.delete(sessionKey);
  lastToolPhaseBySession.delete(sessionKey);
  messageToolReplyBySession.delete(sessionKey);
}

function isRecentlyCompletedRun(sessionKey: string, runId?: string, withinMs = 30000): boolean {
  if (!runId) return false;
  const recent = recentlyCompletedRunBySession.get(sessionKey);
  if (!recent) return false;
  if (Date.now() - recent.ts > withinMs) {
    recentlyCompletedRunBySession.delete(sessionKey);
    return false;
  }
  return recent.runId === runId;
}

function markCompletedDelivery(sessionKey: string, text: string): void {
  const finalText = sanitizeAssistantDelta(text).trim();
  if (!finalText) return;
  recentlyCompletedDeliveryBySession.set(sessionKey, { text: finalText, ts: Date.now() });
}

function isRecentlyCompletedDeliveryText(sessionKey: string, text: string, withinMs = 10000): boolean {
  const finalText = sanitizeAssistantDelta(text).trim();
  if (!finalText) return false;
  const recent = recentlyCompletedDeliveryBySession.get(sessionKey);
  if (!recent) return false;
  if (Date.now() - recent.ts > withinMs) {
    recentlyCompletedDeliveryBySession.delete(sessionKey);
    return false;
  }
  return recent.text === finalText;
}

function publishTextIfNew(sessionKey: string, text: string): void {
  const finalText = sanitizeAssistantDelta(text);
  if (!finalText) return;

  const streamedText = streamEventBus.getLatestText(sessionKey);
  if (!streamedText) {
    streamEventBus.publish(sessionKey, { type: 'text', content: finalText, replace: true });
  } else if (finalText === streamedText) {
    // Already visible.
  } else if (finalText.startsWith(streamedText) && finalText.length > streamedText.length) {
    streamEventBus.publish(sessionKey, { type: 'text', content: finalText.substring(streamedText.length) });
  } else if (!streamedText.includes(finalText)) {
    streamEventBus.publish(sessionKey, { type: 'text', content: finalText, replace: true });
  }

  chatLastSeenTextMap.set(sessionKey, finalText);
}

function takeRecentMessageToolReply(sessionKey: string, withinMs = 30000): string {
  const cached = messageToolReplyBySession.get(sessionKey);
  if (!cached) return '';
  if (Date.now() - cached.ts > withinMs) {
    messageToolReplyBySession.delete(sessionKey);
    return '';
  }
  messageToolReplyBySession.delete(sessionKey);
  return cached.text;
}

function isCodexTurnCompletionUnconfirmedError(text: unknown): boolean {
  const normalized = String(text || '');
  return /\bcodex app-server turn idle timed out waiting for turn\/completed\b/i.test(normalized)
    || /\bCodex stopped before confirming the turn was complete\b/i.test(normalized)
    || /\bcodex app-server run completed without .*terminal event\b/i.test(normalized);
}

function latestVisibleAssistantText(sessionKey: string): string {
  return sanitizeAssistantDelta(
    streamEventBus.getLatestText(sessionKey)
      || chatLastSeenTextMap.get(sessionKey)
      || assistantLastSeenTextMap.get(sessionKey)
      || '',
  ).trim();
}

function completeIdleTimedOutTurnIfVisible(sessionKey: string, runId: string | undefined, errorText: string): boolean {
  if (!isCodexTurnCompletionUnconfirmedError(errorText)) return false;
  if (hasRunningToolCall(sessionKey)) return false;

  const finalText = latestVisibleAssistantText(sessionKey);
  if (!finalText) return false;

  debugLog(`Treating Codex turn/completed idle timeout as completed after visible assistant output for ${sessionKey}`);
  publishTextIfNew(sessionKey, finalText);
  markCompletedDelivery(sessionKey, finalText);
  streamEventBus.publish(sessionKey, {
    type: 'done',
    content: finalText,
    runId,
  });
  cleanupCompletedRun(sessionKey, runId);
  return true;
}

function clearPendingCodexIdleTimeout(sessionKey: string): void {
  const pending = pendingCodexIdleTimeoutBySession.get(sessionKey);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingCodexIdleTimeoutBySession.delete(sessionKey);
}

function publishFatalRunError(sessionKey: string, content: string): void {
  clearPendingCodexIdleTimeout(sessionKey);
  streamEventBus.publish(sessionKey, { type: 'error', content });
  streamEventBus.clearStream(sessionKey);
  activeRunIds.delete(sessionKey);
  assistantLastSeenTextMap.delete(sessionKey);
  chatLastSeenTextMap.delete(sessionKey);
  sessionsWithAssistantTextStream.delete(sessionKey);
  lastToolPhaseBySession.delete(sessionKey);
}

function deferCodexIdleTimeoutError(sessionKey: string, runId: string | undefined, errorText: string): boolean {
  if (!isCodexTurnCompletionUnconfirmedError(errorText)) return false;
  if (completeIdleTimedOutTurnIfVisible(sessionKey, runId, errorText)) return true;

  clearPendingCodexIdleTimeout(sessionKey);
  streamEventBus.publish(sessionKey, {
    type: 'status',
    content: 'Codex turn completion is delayed; waiting for the final response…',
    runId,
  });

  const timer = setTimeout(() => {
    pendingCodexIdleTimeoutBySession.delete(sessionKey);
    if (completeIdleTimedOutTurnIfVisible(sessionKey, runId, errorText)) return;
    publishFatalRunError(sessionKey, errorText);
  }, 15000);
  timer.unref?.();
  pendingCodexIdleTimeoutBySession.set(sessionKey, { runId, errorText, timer });
  return true;
}

function scheduleEmptyFinal(sessionKey: string, runId?: string, model?: string | null): void {
  clearPendingEmptyFinal(sessionKey);
  const timer = setTimeout(() => {
    pendingEmptyFinalBySession.delete(sessionKey);
    streamEventBus.publish(sessionKey, { type: 'done', content: '', model: model || null });
    cleanupCompletedRun(sessionKey, runId);
  }, 2500);
  timer.unref?.();
  pendingEmptyFinalBySession.set(sessionKey, { runId, model, timer });
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

function stripReasoningMirrorPrefix(text: string): string {
  return sanitizeAssistantText(text || '')
    .replace(/^\s*(?:Codex|OpenClaw) reasoning:\s*/i, '')
    .trim();
}

function isReasoningMirrorMessage(message: any): boolean {
  if (!message || typeof message !== 'object') return false;
  const meta = (message.__openclaw && typeof message.__openclaw === 'object' ? message.__openclaw : null)
    || (message.metadata?.__openclaw && typeof message.metadata.__openclaw === 'object' ? message.metadata.__openclaw : null);
  const mirrorIdentity = typeof meta?.mirrorIdentity === 'string' ? meta.mirrorIdentity : '';
  if (/:reasoning$/i.test(mirrorIdentity)) return true;
  const idempotencyKey = typeof message.idempotencyKey === 'string' ? message.idempotencyKey : '';
  if (/:reasoning(?:$|:)/i.test(idempotencyKey)) return true;

  const text = extractTextFromContent(message.content ?? message.text ?? '');
  return /^\s*(?:Codex|OpenClaw) reasoning:\s*/i.test(text);
}

function extractReasoningMirrorText(message: any): string {
  if (!isReasoningMirrorMessage(message)) return '';
  return stripReasoningMirrorPrefix(extractTextFromContent(message.content ?? message.text ?? ''));
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

function isMessageToolName(name: unknown): boolean {
  return String(name || '').trim().toLowerCase() === 'message';
}

function isGenericAnalysisMetadataText(text: string): boolean {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
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

function extractVisibleAnalysisThinkingText(data: Record<string, unknown>): string {
  // `item.analysis` is lifecycle metadata in current OpenClaw. Actual streamed
  // thought text is emitted on stream='thinking'; do not turn titles like
  // "Reasoning" into visible thought bubbles.
  const candidates = [data.delta, data.text, data.content, data.message, data.statusText];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed || isGenericAnalysisMetadataText(trimmed)) continue;
    return trimmed;
  }
  return '';
}

function extractPreambleProgressText(data: Record<string, unknown>): string {
  const candidate = typeof data.progressText === 'string'
    ? data.progressText
    : (typeof data.text === 'string'
        ? data.text
        : (typeof data.content === 'string' ? data.content : ''));
  return sanitizeAssistantDelta(candidate);
}

function extractMessageToolReplyText(message: any): string {
  const role = String(message?.role || message?.type || '').trim().toLowerCase();
  const toolName = message?.toolName ?? message?.name ?? message?.tool_name;
  if (role !== 'toolresult' || !isMessageToolName(toolName)) return '';

  const rawCandidates: string[] = [];
  const content = message?.content;
  if (typeof content === 'string') {
    rawCandidates.push(content);
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item?.content === 'string') rawCandidates.push(item.content);
      if (typeof item?.text === 'string') rawCandidates.push(item.text);
    }
  }

  for (const raw of rawCandidates) {
    try {
      const parsed = JSON.parse(raw);
      const text = parsed?.sourceReply?.text ?? parsed?.message;
      if (typeof text === 'string' && text.trim()) return sanitizeAssistantDelta(text);
    } catch {}
  }
  return '';
}

/**
 * Handle `agent` events from the gateway.
 * Shape: { runId, sessionKey, stream: 'assistant'|'tool'|'lifecycle'|'compaction', seq, data }
 */
function hasRunningToolCall(sessionKey: string): boolean {
  const tracked = streamEventBus.getTrackedStream(sessionKey);
  return Boolean(tracked?.toolCalls?.some((toolCall) => toolCall?.status === 'running'));
}

function shouldProcessTrackedSessionEvent(sessionKey: string): boolean {
  return streamEventBus.hasSubscribers(sessionKey)
    || Boolean(streamEventBus.getTrackedStream(sessionKey))
    || activeRunIds.has(sessionKey);
}

function handleAgentEvent(payload: Record<string, unknown> | undefined): void {
  if (!payload) return;

  const sessionKey = resolveSessionKeyForGatewayPayload(payload);
  if (!sessionKey) {
    debugLog(`Ignoring agent event without resolvable sessionKey: stream=${String(payload.stream || '')} runId=${String(payload.runId || '')}`);
    return;
  }

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
      streamEventBus.publish(sessionKey, {
        type: 'compaction_start',
        content: 'Compacting context…',
        maintenanceKind: 'compaction',
      });
    } else if (compPhase === 'end' || compPhase === 'completed' || compPhase === 'compacted') {
      const completed = data.completed === true || compPhase === 'completed' || compPhase === 'compacted';
      const willRetry = data.willRetry === true;
      streamEventBus.publish(sessionKey, {
        type: willRetry && completed ? 'compaction_start' : 'compaction_end',
        content: willRetry && completed
          ? 'Compaction retrying…'
          : (completed ? 'Context compacted' : 'Context maintenance finished.'),
        completed,
        willRetry,
        maintenanceKind: completed ? 'compaction' : 'maintenance',
      });
    }
    return;
  }

  // Process session events while a run is actively being tracked, even if the
  // last browser subscriber dropped. Otherwise queued async follow-up completions
  // can miss their terminal chat.final and leave stream-status stuck active.
  if (!shouldProcessTrackedSessionEvent(sessionKey)) return;

  // Filter by runId: if we have an active run for this session, ignore events from other runs.
  // This prevents replayed/stale events from interfering.
  const expectedRunId = activeRunIds.get(sessionKey);
  if (expectedRunId && runId && runId !== expectedRunId) {
    debugLog(`Ignoring agent event for stale runId=${runId} (expected ${expectedRunId})`);
    return;
  }

  const isLateTerminalError = streamEventBus.wasRecentlyDone(sessionKey, 10000)
    && (stream === 'lifecycle' && String(data.phase || '').toLowerCase() === 'error');
  if (!expectedRunId && runId && isLateTerminalError) {
    debugLog(`Ignoring late lifecycle.error after completed run for session=${sessionKey} runId=${runId}`);
    return;
  }
  if (!expectedRunId && runId && isRecentlyCompletedRun(sessionKey, runId)) {
    debugLog(`Ignoring late agent event for completed run session=${sessionKey} runId=${runId}`);
    return;
  }

  // If no active runId is set but the event has one, adopt it (new run segment after yield)
  if (!expectedRunId && runId) {
    activeRunIds.set(sessionKey, runId);
    debugLog(`Adopted new runId=${runId} for session ${sessionKey} (resumed after yield)`);
    // Reset text accumulators for the new run
    assistantLastSeenTextMap.delete(sessionKey);
    chatLastSeenTextMap.delete(sessionKey);
    sessionsWithAssistantTextStream.delete(sessionKey);
    lastToolPhaseBySession.delete(sessionKey);
    streamEventBus.setLastSeenText(sessionKey, '');
    streamEventBus.setLatestText(sessionKey, '');
    // Signal the frontend that a new run segment has started
    streamEventBus.publish(sessionKey, { type: 'run_resumed', content: '' });
  }

  // Ensure the stream is tracked
  streamEventBus.startStream(sessionKey, runId);
  if (!(stream === 'lifecycle' && String(data.phase || '').toLowerCase() === 'error')) {
    clearPendingCodexIdleTimeout(sessionKey);
  }

  if (stream === 'item' && data.kind === 'preamble') {
    const content = extractPreambleProgressText(data);
    if (content) {
      if (!hasRunningToolCall(sessionKey)) {
        streamEventBus.updateStreamPhase(sessionKey, {
          phase: 'thinking',
          runId,
          statusText: content,
        });
      }
      streamEventBus.publish(sessionKey, { type: 'thinking', content, runId, replace: true });
    }
    return;
  }

  if (stream === 'item' && data.kind === 'analysis') {
    const content = extractVisibleAnalysisThinkingText(data);
    streamEventBus.updateStreamPhase(sessionKey, {
      phase: 'thinking',
      runId,
      ...(content ? { statusText: content } : {}),
    });
    if (content) streamEventBus.publish(sessionKey, { type: 'thinking', content, runId });
    return;
  }

  if (stream === 'assistant') {
    const text = typeof data.text === 'string' ? sanitizeAssistantDelta(data.text) : undefined;
    const delta = typeof data.delta === 'string' ? sanitizeAssistantDelta(data.delta) : undefined;
    debugLog(`assistant event: session=${sessionKey} runId=${runId || '-'} keys=${Object.keys(data).join(',')} textLen=${text?.length || 0} deltaLen=${delta?.length || 0}`);

    const assistantLastSeen = assistantLastSeenTextMap.get(sessionKey) || '';

    if (text) {
      if (text.length < assistantLastSeen.length) {
        // Text reset — new segment after tool call
        debugLog(`ASSISTANT RESET: prev=${assistantLastSeen.length} new=${text.length}`);
        assistantLastSeenTextMap.set(sessionKey, text);
        streamEventBus.setLastSeenText(sessionKey, text);
        if (text) {
          sessionsWithAssistantTextStream.add(sessionKey);
          streamEventBus.updateStreamPhase(sessionKey, { phase: 'streaming' });
          streamEventBus.publish(sessionKey, { type: 'text', content: text, replace: true });
        }
      } else if (text.length > assistantLastSeen.length) {
        const newPart = text.substring(assistantLastSeen.length);
        sessionsWithAssistantTextStream.add(sessionKey);
        streamEventBus.updateStreamPhase(sessionKey, { phase: 'streaming' });
        streamEventBus.publish(sessionKey, { type: 'text', content: newPart });
        assistantLastSeenTextMap.set(sessionKey, text);
        streamEventBus.setLastSeenText(sessionKey, text);
      } else if (text === assistantLastSeen) {
        // A chat.delta fallback may have already emitted this exact cumulative
        // text before the assistant stream arrived. Mark assistant stream as
        // available without re-emitting duplicate content.
        sessionsWithAssistantTextStream.add(sessionKey);
      }
    } else if (delta) {
      sessionsWithAssistantTextStream.add(sessionKey);
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
      // Thought deltas can arrive while a tool card is still active. Do not
      // discard them; just avoid overwriting the visible tool phase/status.
      if (!hasRunningToolCall(sessionKey)) {
        streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking' });
      }
      streamEventBus.publish(sessionKey, { type: 'thinking', content: thinkingText, runId });
    }
    return;
  }

  if (stream === 'tool') {
    const phase = typeof data.phase === 'string' ? data.phase : '';
    const toolName = typeof data.name === 'string' ? data.name : 'tool';
    if (isMessageToolName(toolName)) return;
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

    debugLog(`TOOL EVENT: phase=${phase} name=${toolName} session=${sessionKey}`);

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
    } else if (phase === 'update') {
      const partialOutput = extractToolResultText(data.partialResult ?? data.output ?? data.result)?.substring(0, 1000);
      if (partialOutput) {
        streamEventBus.updateStreamPhase(sessionKey, { phase: 'tool', toolName });
        streamEventBus.publish(sessionKey, {
          type: 'tool_update',
          content: partialOutput,
          toolName,
          toolCallId: data.toolCallId,
          toolResult: partialOutput,
        });
      }
    } else if (phase === 'result') {
      lastToolPhaseBySession.set(sessionKey, { runId, toolName, phase: 'result' });
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'streaming', toolName: undefined });
      const output = extractToolResultText(data.output ?? data.result)?.substring(0, 1000);
      const resultStatus = String((data.result as any)?.status || data.status || '').toLowerCase();
      const isError = data.isError === true || resultStatus === 'failed' || resultStatus === 'error';
      streamEventBus.publish(sessionKey, {
        type: 'tool_end',
        content: isError ? `❌ Tool failed: ${toolName}` : `✅ Tool completed: ${toolName}`,
        toolName,
        toolCallId: data.toolCallId,
        toolResult: output,
        ...(isError ? { status: 'error' } : {}),
      });
    }
    return;
  }

  if (stream === 'lifecycle') {
    const phase = typeof data.phase === 'string' ? data.phase : '';
    const lifecycleStatusText = extractLifecycleStatusText(data);
    const lifecycleSignal = inferLifecycleMaintenanceSignal(phase, lifecycleStatusText);

    if (phase === 'end') {
      // lifecycle.end fires at the END of each agent run segment — including after tool calls.
      // The real end is signaled by chat.state === 'final'.
      debugLog(`lifecycle.end for ${sessionKey} — ignoring (waiting for chat.final)`);
    } else if (phase === 'error') {
      const errMsg = typeof data.error === 'string'
        ? data.error
        : (typeof data.errorMessage === 'string' ? data.errorMessage : 'Agent error');
      if (deferCodexIdleTimeoutError(sessionKey, runId, errMsg)) return;
      publishFatalRunError(sessionKey, errMsg);
    } else if (lifecycleSignal === 'compacting') {
      const status = lifecycleStatusText || 'Compacting context…';
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking', statusText: status, compactionPhase: 'compacting' });
      streamEventBus.publish(sessionKey, { type: 'compaction_start', content: status, maintenanceKind: 'compaction' });
    } else if (lifecycleSignal === 'compacted') {
      const status = lifecycleStatusText || 'Context compacted';
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking', statusText: status, compactionPhase: 'compacted' });
      streamEventBus.publish(sessionKey, { type: 'compaction_end', content: status, completed: true, maintenanceKind: 'compaction' });
    } else if (lifecycleSignal === 'maintenance') {
      const status = lifecycleStatusText || 'Preparing context maintenance…';
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking', statusText: status, compactionPhase: 'compacting' });
      streamEventBus.publish(sessionKey, { type: 'status', content: status, maintenanceKind: 'maintenance' });
    } else if (lifecycleSignal === 'maintenance_done') {
      const status = lifecycleStatusText || 'Context maintenance finished.';
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking', statusText: status, compactionPhase: 'idle' });
      streamEventBus.publish(sessionKey, { type: 'status', content: status, maintenanceKind: 'maintenance' });
    } else if (phase === 'started' || phase === 'running' || phase === 'start') {
      if (hasRunningToolCall(sessionKey)) {
        debugLog(`Ignoring lifecycle.${phase} while tool is active for ${sessionKey}`);
        return;
      }
      if (lifecycleStatusText) {
        streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking', statusText: lifecycleStatusText });
        streamEventBus.publish(sessionKey, { type: 'status', content: lifecycleStatusText });
      } else {
        streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking' });
      }
    }
    return;
  }
}

function handleSessionMessageEvent(payload: Record<string, unknown> | undefined): void {
  if (!payload) return;
  const sessionKey = resolveSessionKeyForGatewayPayload(payload);
  if (!sessionKey) return;

  const message = payload.message && typeof payload.message === 'object' ? payload.message as any : null;
  if (!message) return;

  const meta = (message.__openclaw && typeof message.__openclaw === 'object' ? message.__openclaw : null)
    || (message.metadata?.__openclaw && typeof message.metadata.__openclaw === 'object' ? message.metadata.__openclaw : null);
  const text = extractTextFromContent(message.content ?? message.text ?? '');
  const role = typeof message.role === 'string' ? message.role : (typeof message.type === 'string' ? message.type : '');
  debugLog(`session.message event: session=${sessionKey} role=${role || '-'} textLen=${text.length} keys=${Object.keys(message).join(',')}`);

  const normalizedRole = role.trim().toLowerCase();
  const reasoningMirrorText = normalizedRole === 'assistant' ? extractReasoningMirrorText(message) : '';
  if (reasoningMirrorText && !isControlOnlyAssistantText(reasoningMirrorText)) {
    // Codex/app-server stores visible reasoning as a delivery-mirror assistant
    // message (`mirrorIdentity: ...:reasoning`) instead of a normal assistant
    // answer. Keep it on the thinking channel and do not close the turn as done.
    if (activeRunIds.has(sessionKey) || pendingEmptyFinalBySession.has(sessionKey) || streamEventBus.getTrackedStream(sessionKey)) {
      streamEventBus.startStream(sessionKey, activeRunIds.get(sessionKey));
      streamEventBus.publish(sessionKey, { type: 'thinking', content: reasoningMirrorText });
    }
    return;
  }

  const messageToolReplyText = extractMessageToolReplyText(message);
  if (messageToolReplyText && !isControlOnlyAssistantText(messageToolReplyText)) {
    const pending = clearPendingEmptyFinal(sessionKey);
    if (pending) {
      if (pending.runId) streamEventBus.startStream(sessionKey, pending.runId);
      publishTextIfNew(sessionKey, messageToolReplyText);
      markCompletedDelivery(sessionKey, messageToolReplyText);
      streamEventBus.publish(sessionKey, {
        type: 'done',
        content: messageToolReplyText,
        model: extractGatewayMessageModel(payload) || pending.model || null,
      });
      cleanupCompletedRun(sessionKey, pending.runId);
      return;
    }
    messageToolReplyBySession.set(sessionKey, { text: messageToolReplyText, ts: Date.now() });
  }

  if (normalizedRole === 'assistant' && text && !isControlOnlyAssistantText(text)) {
    const pending = clearPendingEmptyFinal(sessionKey);
    const activeRunId = activeRunIds.get(sessionKey) || streamEventBus.getTrackedStream(sessionKey)?.runId;
    const deliveryRunId = pending?.runId || activeRunId;
    const shouldMirrorDelivery = Boolean(pending)
      || activeRunIds.has(sessionKey)
      || streamEventBus.wasRecentlyDone(sessionKey, 5000);
    if (shouldMirrorDelivery) {
      if (!pending && !activeRunId && isRecentlyCompletedDeliveryText(sessionKey, text)) {
        return;
      }
      if (deliveryRunId) streamEventBus.startStream(sessionKey, deliveryRunId);
      publishTextIfNew(sessionKey, text);
      markCompletedDelivery(sessionKey, text);
      streamEventBus.publish(sessionKey, {
        type: 'done',
        content: text,
        model: extractGatewayMessageModel(payload) || pending?.model || null,
        runId: deliveryRunId,
      });
      cleanupCompletedRun(sessionKey, deliveryRunId);
      return;
    }
  }

  const kind = typeof meta?.kind === 'string' ? meta.kind.toLowerCase() : '';
  const phase = typeof meta?.phase === 'string' ? meta.phase.toLowerCase() : '';
  const isCompactionMeta = kind === 'compaction';
  const signal = isCompactionMeta
    ? inferLifecycleMaintenanceSignal(phase, text || null)
    : inferLifecycleMaintenanceSignal('', text || null);

  if (!isCompactionMeta && signal === 'idle') return;

  if (signal === 'compacting') {
    streamEventBus.publish(sessionKey, {
      type: 'compaction_start',
      content: text || 'Compacting context…',
      maintenanceKind: 'compaction',
    });
    return;
  }

  if (signal === 'compacted') {
    streamEventBus.publish(sessionKey, {
      type: 'compaction_end',
      content: text || 'Context compacted',
      completed: true,
      maintenanceKind: 'compaction',
    });
    return;
  }

  if (signal === 'maintenance') {
    streamEventBus.publish(sessionKey, {
      type: 'status',
      content: text || 'Context maintenance in progress…',
      maintenanceKind: 'maintenance',
    });
    return;
  }

  if (signal === 'maintenance_done') {
    streamEventBus.publish(sessionKey, {
      type: 'status',
      content: text || 'Context maintenance finished.',
      maintenanceKind: 'maintenance',
    });
  }
}

function handleSessionsChangedEvent(payload: Record<string, unknown> | undefined): void {
  if (!payload) return;
  const sessionKey = resolveSessionKeyForGatewayPayload(payload);
  if (!sessionKey) return;

  const signature = compactionCheckpointSignature(payload);
  if (!signature) return;
  const previous = latestCompactionCheckpointBySession.get(sessionKey);
  latestCompactionCheckpointBySession.set(sessionKey, signature);
  if (!previous || previous === signature) return;

  streamEventBus.publish(sessionKey, {
    type: 'compaction_end',
    content: 'Context compacted',
    completed: true,
    maintenanceKind: 'compaction',
  });
}

/**
 * Handle `chat` events from the gateway.
 * Shape: { runId, sessionKey, seq, state: 'delta'|'final'|'error', message?, errorMessage? }
 */
function handleChatEvent(payload: Record<string, unknown> | undefined): void {
  if (!payload) return;

  const sessionKey = resolveSessionKeyForGatewayPayload(payload);
  if (!sessionKey) {
    debugLog(`Ignoring chat event without resolvable sessionKey: state=${String(payload.state || '')} runId=${String(payload.runId || '')}`);
    return;
  }

  const state = typeof payload.state === 'string' ? payload.state : '';

  // Compaction can also arrive via chat events (state: 'compacting' or similar).
  // Process these regardless of subscribers.
  if (state === 'compacting' || state === 'compaction_start' || state === 'compaction_started') {
    debugLog(`COMPACTION via chat event: sessionKey="${sessionKey}" state="${state}"`);
    streamEventBus.publish(sessionKey, { type: 'compaction_start', content: 'Compacting context…', maintenanceKind: 'compaction' });
    return;
  }
  if (state === 'compacted' || state === 'compaction_end' || state === 'compaction_completed') {
    debugLog(`COMPACTION END via chat event: sessionKey="${sessionKey}" state="${state}"`);
    streamEventBus.publish(sessionKey, { type: 'compaction_end', content: 'Context compacted', completed: true, maintenanceKind: 'compaction' });
    return;
  }

  // Process session events while a run is actively being tracked, even if the
  // last browser subscriber dropped. Otherwise queued async follow-up completions
  // can miss their terminal chat.final and leave stream-status stuck active.
  if (!shouldProcessTrackedSessionEvent(sessionKey)) return;

  const runId = typeof payload.runId === 'string' ? payload.runId : undefined;

  // Filter by runId
  const expectedRunId = activeRunIds.get(sessionKey);
  if (expectedRunId && runId && runId !== expectedRunId) {
    debugLog(`Ignoring chat event state=${state} for stale runId=${runId} (expected ${expectedRunId})`);
    return;
  }

  if (!expectedRunId && runId && state === 'error' && streamEventBus.wasRecentlyDone(sessionKey, 10000)) {
    debugLog(`Ignoring late chat.error after completed run for session=${sessionKey} runId=${runId}`);
    return;
  }
  if (!expectedRunId && runId && isRecentlyCompletedRun(sessionKey, runId)) {
    debugLog(`Ignoring late chat.${state || 'event'} for completed run session=${sessionKey} runId=${runId}`);
    return;
  }

  // If no active runId is set but the event has one, adopt it (new run segment)
  if (!expectedRunId && runId) {
    const wasRecent = streamEventBus.wasRecentlyDone(sessionKey);
    activeRunIds.set(sessionKey, runId);
    debugLog(`Adopted new runId=${runId} for session ${sessionKey} via chat event (wasRecentlyDone=${wasRecent})`);
    // Reset text accumulators for the new run
    assistantLastSeenTextMap.delete(sessionKey);
    chatLastSeenTextMap.delete(sessionKey);
    sessionsWithAssistantTextStream.delete(sessionKey);
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
  if (state !== 'error') {
    clearPendingCodexIdleTimeout(sessionKey);
  }

  if (state === 'delta') {
    // Newer OpenClaw builds may emit assistant text only through chat.delta,
    // while agent stream='assistant' can be metadata-only. Treat chat.delta as a
    // cumulative fallback text stream unless assistant stream text already won.
    const message = payload.message as Record<string, unknown> | undefined;
    const reasoningMirrorText = extractReasoningMirrorText(message);
    if (reasoningMirrorText && !isControlOnlyAssistantText(reasoningMirrorText)) {
      streamEventBus.publish(sessionKey, { type: 'thinking', content: reasoningMirrorText, runId });
      return;
    }

    const deltaText = extractTextFromContent(
      message?.content ?? payload.text ?? payload.delta ?? payload.content ?? '',
    );

    debugLog(`chat.delta event: session=${sessionKey} runId=${runId || '-'} textLen=${deltaText.length} payloadKeys=${Object.keys(payload).join(',')}`);
    if (!deltaText || isControlOnlyAssistantText(deltaText)) return;

    if (sessionsWithAssistantTextStream.has(sessionKey)) {
      chatLastSeenTextMap.set(sessionKey, deltaText);
      return;
    }

    // Keep assistant-stream diffing aligned if chat.delta wins the race. If a
    // real assistant stream event arrives later with the same cumulative text,
    // it will be recognized as already emitted rather than duplicated.
    assistantLastSeenTextMap.set(sessionKey, deltaText);

    const lastSeen = chatLastSeenTextMap.get(sessionKey) || '';
    if (deltaText.length < lastSeen.length || (lastSeen && !deltaText.startsWith(lastSeen))) {
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'streaming' });
      streamEventBus.publish(sessionKey, { type: 'text', content: deltaText, replace: true });
    } else if (deltaText.length > lastSeen.length) {
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'streaming' });
      streamEventBus.publish(sessionKey, { type: 'text', content: deltaText.substring(lastSeen.length) });
    }
    chatLastSeenTextMap.set(sessionKey, deltaText);
    streamEventBus.setLastSeenText(sessionKey, deltaText);
    return;
  }

  if (state === 'final') {
    const message = payload.message as Record<string, unknown> | undefined;
    const finalReasoningMirrorText = extractReasoningMirrorText(message);
    if (finalReasoningMirrorText && !isControlOnlyAssistantText(finalReasoningMirrorText)) {
      streamEventBus.publish(sessionKey, { type: 'thinking', content: finalReasoningMirrorText, runId });
      scheduleEmptyFinal(sessionKey, runId, extractGatewayMessageModel(payload));
      return;
    }

    const finalText = message ? extractTextFromContent(message.content) : '';
    const finalModel = extractGatewayMessageModel(payload);
    debugLog(`chat.final event: session=${sessionKey} runId=${runId || '-'} finalLen=${finalText.length} payloadKeys=${Object.keys(payload).join(',')}`);

    if (!finalText || isControlOnlyAssistantText(finalText)) {
      // Codex/app-server may emit the visible assistant text as either a
      // message-tool sourceReply or a delivery-mirror `session.message` around
      // an empty chat.final. Prefer that real visible delivery over closing the
      // live bubble empty.
      const messageToolReplyText = takeRecentMessageToolReply(sessionKey);
      if (messageToolReplyText) {
        publishTextIfNew(sessionKey, messageToolReplyText);
        markCompletedDelivery(sessionKey, messageToolReplyText);
        streamEventBus.publish(sessionKey, {
          type: 'done',
          content: messageToolReplyText,
          model: finalModel,
        });
        cleanupCompletedRun(sessionKey, runId);
        return;
      }
      scheduleEmptyFinal(sessionKey, runId, finalModel);
      return;
    }

    clearPendingEmptyFinal(sessionKey);

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
        chatLastSeenTextMap.set(sessionKey, finalText);
      } else if (finalText === streamedText) {
        // Exact match — nothing to do
      } else if (finalText.startsWith(streamedText) && finalText.length > streamedText.length) {
        // Final is a continuation of what we have — append the tail
        streamEventBus.publish(sessionKey, { type: 'text', content: finalText.substring(streamedText.length) });
        chatLastSeenTextMap.set(sessionKey, finalText);
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
        chatLastSeenTextMap.set(sessionKey, finalText);
      }
    }

    markCompletedDelivery(sessionKey, finalText);
    streamEventBus.publish(sessionKey, {
      type: 'done',
      content: finalText,
      model: finalModel,
    });

    cleanupCompletedRun(sessionKey, runId);
    return;
  }

  if (state === 'error') {
    const errMsg = typeof payload.errorMessage === 'string'
      ? payload.errorMessage
      : (typeof payload.error === 'string' ? payload.error : 'Chat error');
    if (deferCodexIdleTimeoutError(sessionKey, runId, errMsg)) return;
    publishFatalRunError(sessionKey, errMsg);
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
    chatLastSeenTextMap.delete(sessionKey);
    sessionsWithAssistantTextStream.delete(sessionKey);
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
        minProtocol: MIN_PROTOCOL_VERSION,
        maxProtocol: MAX_PROTOCOL_VERSION,
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

        void callGatewayRpc('sessions.subscribe', {}, 10000)
          .then(() => debugLog('Subscribed to OpenClaw session events'))
          .catch((err: Error) => debugLog(`sessions.subscribe failed: ${err.message}`));
        for (const key of desiredSessionMessageSubscriptions) {
          void subscribeGatewaySessionMessageNow(key);
        }

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
    if (msg.event === 'agent' || msg.event === 'session.tool') {
      handleAgentEvent(msg.payload);
      return;
    }

    // Chat stream events
    if (msg.event === 'chat') {
      handleChatEvent(msg.payload);
      return;
    }

    if (msg.event === 'session.message') {
      handleSessionMessageEvent(msg.payload);
      return;
    }

    if (msg.event === 'sessions.changed') {
      handleSessionsChangedEvent(msg.payload);
      return;
    }

    // Log unhandled events for debugging (helps discover new event types like compaction)
    if (msg.event) {
      debugLog(`UNHANDLED event type: "${msg.event}" payload keys: ${Object.keys(msg.payload || {}).join(',')}`);
    }
  });

  ws.on('error', (err: any) => {
    if (isExpectedGatewayReconnectError(err)) {
      console.warn(`[PersistentGatewayWs] Gateway unavailable during connect/reconnect: ${err.message}`);
      return;
    }
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
    activeSessionMessageSubscriptions.clear();

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

async function subscribeGatewaySessionMessageNow(sessionKey: string): Promise<void> {
  const key = sessionKey.trim();
  if (!key || activeSessionMessageSubscriptions.has(key)) return;
  try {
    const payload = await callGatewayRpc('sessions.messages.subscribe', { key }, 10000);
    const canonicalKey = typeof payload?.key === 'string' && payload.key.trim() ? payload.key.trim() : key;
    activeSessionMessageSubscriptions.add(canonicalKey);
    if (canonicalKey !== key) activeSessionMessageSubscriptions.add(key);
    debugLog(`Subscribed to OpenClaw session messages: ${canonicalKey}`);
  } catch (err: any) {
    debugLog(`sessions.messages.subscribe failed for ${key}: ${err?.message || err}`);
  }
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
 * Subscribe the backend singleton socket to live transcript messages for a
 * session. This mirrors OpenClaw Control UI's session-message path and is used
 * only as a live signal source; history remains the durable record.
 */
export async function subscribeGatewaySessionMessages(sessionKey: string): Promise<void> {
  const key = sessionKey.trim();
  if (!key) return;
  desiredSessionMessageSubscriptions.add(key);
  if (!isConnected()) return;
  await subscribeGatewaySessionMessageNow(key);
}

/**
 * Send a chat message via the persistent WebSocket.
 * Returns the runId on success.
 * 
 * This replaces the per-message WS in OpenClawProvider — all chat messages
 * now go through the single persistent connection. Events for this session
 * will be received by the same connection and published to StreamEventBus.
 */
export async function callGatewayRpc(method: string, params: Record<string, any> = {}, timeoutMs = 10000): Promise<any> {
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
      reject(new Error(`${method} RPC timeout`));
    }, timeoutMs);

    pendingResponses.set(requestId, {
      resolve: (payload: any) => {
        clearTimeout(timeoutTimer);
        const sessionKey = typeof params.sessionKey === 'string' ? params.sessionKey : '';
        const runId = typeof payload?.runId === 'string' ? payload.runId : '';
        if (method === 'chat.send' && sessionKey && runId) {
          activeRunIds.set(sessionKey, runId);
          streamEventBus.startStream(sessionKey, runId);
          debugLog(`chat.send accepted via generic RPC: sessionKey=${sessionKey} runId=${runId}`);
        }
        resolve(payload);
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
        method,
        params,
      }));
    } catch (err: any) {
      clearTimeout(timeoutTimer);
      pendingResponses.delete(requestId);
      reject(new Error(`Failed to send ${method}: ${err.message}`));
    }
  });
}

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

export async function steerSessionMessage(sessionKey: string, text: string): Promise<{ runId?: string; interruptedActiveRun?: boolean }> {
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
      reject(new Error('sessions.steer RPC timeout'));
    }, 30000);

    pendingResponses.set(requestId, {
      resolve: (payload: any) => {
        clearTimeout(timeoutTimer);
        resolve(payload && typeof payload === 'object' ? payload : {});
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
        method: 'sessions.steer',
        params: {
          key: sessionKey,
          message: text,
        },
      }));
    } catch (err: any) {
      clearTimeout(timeoutTimer);
      pendingResponses.delete(requestId);
      reject(new Error(`Failed to send sessions.steer: ${err.message}`));
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
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
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

export const __persistentGatewayWsTest = {
  isCodexTurnCompletionUnconfirmedError,
  deferCodexIdleTimeoutError,
  completeIdleTimedOutTurnIfVisible,
  clearPendingCodexIdleTimeout,
  resetSession(sessionKey: string): void {
    clearPendingCodexIdleTimeout(sessionKey);
    streamEventBus.clearStream(sessionKey);
    activeRunIds.delete(sessionKey);
    assistantLastSeenTextMap.delete(sessionKey);
    chatLastSeenTextMap.delete(sessionKey);
    sessionsWithAssistantTextStream.delete(sessionKey);
    lastToolPhaseBySession.delete(sessionKey);
  },
};
