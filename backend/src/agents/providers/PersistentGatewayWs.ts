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
import WebSocket from 'ws';
import { buildSignedDevice, getOrCreateDeviceKeys } from '../../utils/deviceIdentity';
import { getOpenClawWsUrl } from '../../config/openclaw';
import { streamEventBus } from '../../services/StreamEventBus';
import { sanitizeAssistantChunk, sanitizeAssistantText, isControlOnlyAssistantText } from '../../utils/chatText';
import { getGatewayToken } from '../../utils/gatewayToken';
import { redactNativeProviderText } from './native/NativeProviderDiagnostics';
import { sanitizeThinkingSubject } from '../../utils/thinkingSubject';

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

// Pending RPC responses
const pendingResponses: Map<string, { resolve: (value: any) => void; reject: (err: Error) => void }> = new Map();

// Separate text accumulator for assistant stream events (resets per segment after tool calls).
const assistantLastSeenTextMap: Map<string, string> = new Map();

// Thinking/reasoning events carry cumulative snapshot text on OpenClaw 2026.7.1
// (claude-cli thinking lane and the embedded runtime both send { text: full,
// delta: suffix }). Track the last snapshot so only new text is published.
const thinkingLastSeenTextMap: Map<string, string> = new Map();
/** Raw cumulative thinking snapshot at the most recent subject boundary. */
const thinkingSubjectBaselineMap: Map<string, string> = new Map();
/** Thinking body already emitted under the current provider subject. */
const thinkingSubjectSegmentTextMap: Map<string, string> = new Map();
const thinkingSubjectMap: Map<string, string> = new Map();
/**
 * Cumulative preamble progress text already consumed as a subject.
 *
 * Codex emits preamble progress as a growing snapshot: each event repeats every
 * earlier title and appends the new one, with no separator between them. Taking
 * the whole blob as the subject therefore smears several titles into one, and
 * makes every event look like a subject change, which graduates a title-only
 * thinking segment before its body has arrived. Diff against the last snapshot
 * so only the newly appended title becomes the current subject -- the same
 * technique the thinking snapshot lane already uses.
 */
const preambleLastSeenTextMap: Map<string, string> = new Map();

// Chat events carry cumulative assistant text on newer OpenClaw builds. Use them
// as the fallback live-text source when assistant stream events are metadata-only.
const chatLastSeenTextMap: Map<string, string> = new Map();

const ASSISTANT_TEXT_LANE_GRACE_MS = 2_000;

type TextArbitrationState = {
  runId?: string;
  segment: number;
  segmentText: string;
  completedText: string;
  completedSegments: string[];
  assistantBaseline: string;
  chatBaseline: string;
  assistantTextSegment: number;
  assistantLastTextAt: number;
};

// OpenClaw can expose the same answer through two independently-shaped lanes:
// agent.stream=assistant and cumulative chat.delta snapshots. Keep arbitration
// per run and per tool-delimited segment so one lane winning early in a long
// turn never disables the other lane permanently.
const textArbitrationBySession: Map<string, TextArbitrationState> = new Map();

// Track which sessions have active runs (to filter stale replayed events)
const activeRunIds: Map<string, string> = new Map();

type PendingRunFrame = {
  kind: 'agent' | 'chat' | 'session_message';
  runId: string;
  payload: Record<string, unknown>;
  bytes: number;
};

type PendingRunReservation = {
  reservationRunId: string;
  frames: PendingRunFrame[];
  bytes: number;
};

const MAX_PENDING_RUN_FRAMES = 512;
const MAX_PENDING_RUN_BYTES = 2 * 1024 * 1024;
const pendingRunReservationsBySession = new Map<string, PendingRunReservation>();
const failedRunReservationsBySession = new Set<string>();

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

// Deduplicate gateway tool snapshots per run and per tool identity. A single
// session-level "last phase" loses as soon as parallel tools interleave: A
// start, B start, duplicate A start would otherwise render A twice.
const seenToolPhaseKeysBySession: Map<string, Set<string>> = new Map();

function createTextArbitrationState(runId?: string): TextArbitrationState {
  return {
    runId,
    segment: 0,
    segmentText: '',
    completedText: '',
    completedSegments: [],
    assistantBaseline: '',
    chatBaseline: '',
    assistantTextSegment: -1,
    assistantLastTextAt: 0,
  };
}

function getTextArbitrationState(sessionKey: string, runId?: string): TextArbitrationState {
  const existing = textArbitrationBySession.get(sessionKey);
  if (existing && (!runId || !existing.runId || existing.runId === runId)) {
    if (runId && !existing.runId) existing.runId = runId;
    return existing;
  }

  const next = createTextArbitrationState(runId);
  textArbitrationBySession.set(sessionKey, next);
  return next;
}

function clearTextArbitration(sessionKey: string): void {
  assistantLastSeenTextMap.delete(sessionKey);
  thinkingLastSeenTextMap.delete(sessionKey);
  thinkingSubjectBaselineMap.delete(sessionKey);
  thinkingSubjectSegmentTextMap.delete(sessionKey);
  thinkingSubjectMap.delete(sessionKey);
  preambleLastSeenTextMap.delete(sessionKey);
  chatLastSeenTextMap.delete(sessionKey);
  textArbitrationBySession.delete(sessionKey);
  seenToolPhaseKeysBySession.delete(sessionKey);
}

function beginTextSegment(sessionKey: string, runId?: string): void {
  const state = getTextArbitrationState(sessionKey, runId);
  if (state.segmentText) {
    state.completedText += state.segmentText;
    state.completedSegments.push(state.segmentText);
  }
  state.segment += 1;
  state.segmentText = '';
  state.assistantBaseline = assistantLastSeenTextMap.get(sessionKey) || '';
  state.chatBaseline = chatLastSeenTextMap.get(sessionKey) || '';
  state.assistantTextSegment = -1;
  state.assistantLastTextAt = 0;
}

function reconcileCumulativeFinalTail(
  graduatedText: readonly string[],
  rawFinalContent: string,
): string {
  const finalContent = String(rawFinalContent || '');
  const represented = graduatedText.filter((value) => String(value || '').trim());
  if (!finalContent || represented.length === 0) return finalContent;

  let cursor = 0;
  let matched = 0;
  for (const value of represented) {
    const text = String(value || '');
    const index = finalContent.indexOf(text, cursor);
    if (index < 0 || finalContent.slice(cursor, index).trim()) {
      matched = 0;
      break;
    }
    cursor = index + text.length;
    matched += 1;
  }
  if (matched === represented.length) {
    return finalContent.slice(cursor).replace(/^\s+/, '');
  }

  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const representedComparable = normalize(represented.join(''));
  const finalComparable = normalize(finalContent);
  if (!representedComparable) return finalContent;
  if (finalComparable === representedComparable) return '';
  if (finalComparable.startsWith(`${representedComparable} `)) {
    return finalComparable.slice(representedComparable.length).trimStart();
  }
  return finalContent;
}

function segmentSnapshotForLane(
  state: TextArbitrationState,
  lane: 'assistant' | 'chat',
  incomingSnapshot: string,
): string {
  const baselineKey = lane === 'assistant' ? 'assistantBaseline' : 'chatBaseline';
  const baseline = state[baselineKey];
  if (baseline) {
    if (incomingSnapshot.startsWith(baseline)) {
      return incomingSnapshot.slice(baseline.length);
    }
    // The provider reset or rewrote its cumulative snapshot. Treat the new
    // value as the complete current segment rather than slicing by old length.
    state[baselineKey] = '';
    return incomingSnapshot;
  }

  // A lane may first appear after a tool boundary. If it sends the full turn
  // snapshot, strip text already emitted in completed segments.
  if (state.segment > 0 && state.completedText && incomingSnapshot.startsWith(state.completedText)) {
    return incomingSnapshot.slice(state.completedText.length);
  }
  return incomingSnapshot;
}

function publishArbitratedTextSnapshot(
  sessionKey: string,
  runId: string,
  lane: 'assistant' | 'chat',
  incomingSnapshot: string,
): boolean {
  if (!incomingSnapshot) return false;
  const state = getTextArbitrationState(sessionKey, runId);
  const nextSegmentText = segmentSnapshotForLane(state, lane, incomingSnapshot);
  const currentSegmentText = state.segmentText;
  if (nextSegmentText === currentSegmentText) return false;

  let content = nextSegmentText;
  let replace = true;
  if (nextSegmentText.startsWith(currentSegmentText)) {
    content = nextSegmentText.slice(currentSegmentText.length);
    // The first text after a tool boundary replaces StreamEventBus's previous
    // segment snapshot while the browser has already graduated that segment.
    replace = currentSegmentText.length === 0 && state.segment > 0;
  }
  if (!content && !replace) return false;

  if (!streamEventBus.updateStreamPhase(sessionKey, { phase: 'streaming', runId })) return false;
  state.segmentText = nextSegmentText;
  streamEventBus.setLastSeenText(sessionKey, nextSegmentText);
  streamEventBus.publish(sessionKey, {
    type: 'text',
    content,
    runId,
    ...(replace ? { replace: true } : {}),
  });
  return true;
}

function markAssistantTextLane(sessionKey: string, runId?: string): void {
  const state = getTextArbitrationState(sessionKey, runId);
  state.assistantTextSegment = state.segment;
  state.assistantLastTextAt = Date.now();
}

function assistantTextLaneOwnsCurrentSegment(sessionKey: string, runId?: string): boolean {
  const state = getTextArbitrationState(sessionKey, runId);
  return state.assistantTextSegment === state.segment
    && Date.now() - state.assistantLastTextAt <= ASSISTANT_TEXT_LANE_GRACE_MS;
}

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

type PendingToolRunState = {
  runId?: string;
  unresolved: Map<string, GatewayToolCallDescriptor>;
  settled: Map<string, GatewayToolCallDescriptor>;
  deferredFinal?: Record<string, unknown>;
};

// A tool-requesting assistant message is not a turn boundary. Keep the
// requested tool identities until their results arrive so an out-of-order
// delivery mirror or chat.final cannot close the provider waiter early.
const pendingToolRunsBySession: Map<string, PendingToolRunState> = new Map();

const messageToolReplyBySession: Map<string, {
  text: string;
  ts: number;
}> = new Map();

const RUN_TOMBSTONE_TTL_MS = 5 * 60 * 1000;
const MAX_RUN_TOMBSTONES_PER_SESSION = 8;
const runTombstonesBySession: Map<string, Map<string, number>> = new Map();

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

function registerPendingToolFinal(
  sessionKey: string,
  runId: string | undefined,
  message: unknown,
): PendingToolRunState {
  const calls = extractGatewayToolCalls(message);
  const existing = pendingToolRunsBySession.get(sessionKey);
  const state = existing || {
    runId,
    unresolved: new Map<string, GatewayToolCallDescriptor>(),
    settled: new Map<string, GatewayToolCallDescriptor>(),
  };
  if (runId) state.runId = runId;

  // A gateway mirror can omit tool-call ids even though the later tool event
  // includes them (or arrive in the opposite order). Reconcile those two
  // representations instead of registering one logical call twice and then
  // waiting forever for a result that already arrived.
  for (const descriptor of calls.filter((entry) => Boolean(entry.id))) {
    const key = `id:${descriptor.id}`;
    if (state.unresolved.has(key) || state.settled.has(key)) continue;
    const idlessMatch = Array.from(state.unresolved.entries()).find(([, pending]) => (
      !pending.id && (pending.name || 'tool') === (descriptor.name || 'tool')
    ));
    if (idlessMatch) state.unresolved.delete(idlessMatch[0]);
    state.unresolved.set(key, descriptor);
  }

  const desiredByName = new Map<string, { count: number; descriptor: GatewayToolCallDescriptor }>();
  for (const descriptor of calls) {
    const name = descriptor.name || 'tool';
    const desired = desiredByName.get(name) || { count: 0, descriptor };
    desired.count += 1;
    if (!desired.descriptor.id && descriptor.id) desired.descriptor = descriptor;
    desiredByName.set(name, desired);
  }
  for (const [name, desired] of desiredByName) {
    const currentCount = [
      ...state.unresolved.values(),
      ...state.settled.values(),
    ]
      .filter((descriptor) => (descriptor.name || 'tool') === name)
      .length;
    for (let index = currentCount; index < desired.count; index += 1) {
      let key = `name:${name}:${index}`;
      let suffix = index;
      while (state.unresolved.has(key)) {
        suffix += 1;
        key = `name:${name}:${suffix}`;
      }
      state.unresolved.set(key, {
        ...(desired.descriptor.name ? { name: desired.descriptor.name } : {}),
      });
    }
  }
  pendingToolRunsBySession.set(sessionKey, state);
  return state;
}

function hasPendingToolRun(sessionKey: string): boolean {
  return (pendingToolRunsBySession.get(sessionKey)?.unresolved.size || 0) > 0;
}

function deferTerminalUntilToolsSettle(
  sessionKey: string,
  payload: Record<string, unknown>,
): boolean {
  const pending = pendingToolRunsBySession.get(sessionKey);
  if (!pending || pending.unresolved.size === 0) return false;
  pending.deferredFinal = payload;
  return true;
}

function settlePendingTool(
  sessionKey: string,
  data: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> | null {
  const pending = pendingToolRunsBySession.get(sessionKey);
  if (!pending) return null;
  const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId.trim() : '';
  let matchedKey = toolCallId && pending.unresolved.has(`id:${toolCallId}`)
    ? `id:${toolCallId}`
    : '';
  if (!matchedKey) {
    for (const [key, descriptor] of pending.unresolved) {
      if (!descriptor.name || descriptor.name === toolName) {
        matchedKey = key;
        break;
      }
    }
  }
  if (matchedKey) {
    const descriptor = pending.unresolved.get(matchedKey) || { name: toolName };
    pending.unresolved.delete(matchedKey);
    const settledKey = toolCallId ? `id:${toolCallId}` : matchedKey;
    pending.settled.set(settledKey, {
      ...descriptor,
      ...(toolCallId ? { id: toolCallId } : {}),
      ...(descriptor.name ? {} : { name: toolName }),
    });
  }
  if (pending.unresolved.size > 0) return null;
  const deferredFinal = pending.deferredFinal || null;
  pending.deferredFinal = undefined;
  // Keep the settled identities until the real terminal assistant frame. The
  // gateway can replay the original tool-bearing final after one or every tool
  // result; forgetting settled calls here would re-open the run indefinitely.
  return deferredFinal;
}

function pruneRunTombstones(sessionKey: string, now = Date.now()): Map<string, number> | null {
  const tombstones = runTombstonesBySession.get(sessionKey);
  if (!tombstones) return null;
  for (const [runId, ts] of tombstones) {
    if (now - ts > RUN_TOMBSTONE_TTL_MS) tombstones.delete(runId);
  }
  if (tombstones.size === 0) {
    runTombstonesBySession.delete(sessionKey);
    return null;
  }
  return tombstones;
}

function tombstoneRun(sessionKey: string, runId?: string): void {
  const normalizedRunId = typeof runId === 'string' ? runId.trim() : '';
  if (!normalizedRunId) return;
  const now = Date.now();
  const tombstones = pruneRunTombstones(sessionKey, now) || new Map<string, number>();
  tombstones.delete(normalizedRunId);
  tombstones.set(normalizedRunId, now);
  while (tombstones.size > MAX_RUN_TOMBSTONES_PER_SESSION) {
    const oldest = tombstones.keys().next().value;
    if (typeof oldest !== 'string') break;
    tombstones.delete(oldest);
  }
  runTombstonesBySession.set(sessionKey, tombstones);
}

function isRunTombstoned(sessionKey: string, runId?: string): boolean {
  const normalizedRunId = typeof runId === 'string' ? runId.trim() : '';
  if (!normalizedRunId) return false;
  return Boolean(pruneRunTombstones(sessionKey)?.has(normalizedRunId));
}

function resetRunStreamState(sessionKey: string): void {
  clearTextArbitration(sessionKey);
  messageToolReplyBySession.delete(sessionKey);
  streamEventBus.setLastSeenText(sessionKey, '');
  streamEventBus.setLatestText(sessionKey, '');
}

function normalizedRunId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function queuePendingRunFrame(
  sessionKey: string,
  kind: PendingRunFrame['kind'],
  runId: string,
  payload: Record<string, unknown>,
): boolean {
  const pending = pendingRunReservationsBySession.get(sessionKey);
  if (!pending
    || activeRunIds.get(sessionKey) !== pending.reservationRunId) {
    return false;
  }

  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    return true;
  }
  if (pending.frames.length >= MAX_PENDING_RUN_FRAMES
    || bytes > MAX_PENDING_RUN_BYTES
    || pending.bytes + bytes > MAX_PENDING_RUN_BYTES) {
    debugLog(`Dropping pre-ack ${kind} frame outside pending buffer bounds for ${sessionKey}`);
    return true;
  }

  pending.frames.push({ kind, runId, payload, bytes });
  pending.bytes += bytes;
  return true;
}

function clearPendingRunReservation(sessionKey: string, reservationRunId?: string): void {
  const pending = pendingRunReservationsBySession.get(sessionKey);
  if (!pending) return;
  if (reservationRunId && pending.reservationRunId !== reservationRunId) return;
  pendingRunReservationsBySession.delete(sessionKey);
}

export function failPendingRunReservation(sessionKey: string, reservationRunId: string): void {
  const pending = pendingRunReservationsBySession.get(sessionKey);
  if (!pending || pending.reservationRunId !== reservationRunId) return;
  pendingRunReservationsBySession.delete(sessionKey);
  failedRunReservationsBySession.add(sessionKey);
  if (activeRunIds.get(sessionKey) === reservationRunId) activeRunIds.delete(sessionKey);
  streamEventBus.clearStream(sessionKey, reservationRunId);
}

function adoptActiveRun(
  sessionKey: string,
  expectedRunId: string | null,
  runId: string,
  publishResume: boolean,
): boolean {
  const nextRunId = normalizedRunId(runId);
  if (!nextRunId) return false;

  const trackedStream = streamEventBus.getTrackedStream(sessionKey);
  const trackedRunId = normalizedRunId(trackedStream?.runId) || null;
  const previousRunId = activeRunIds.get(sessionKey) || trackedRunId;
  if (previousRunId !== expectedRunId) return false;

  if (previousRunId === nextRunId) {
    return streamEventBus.startStream(sessionKey, nextRunId);
  }

  // The bus is the authoritative compare-and-swap boundary. Do not mutate the
  // provider's mirrors, tombstones, or pending state until it accepts the exact
  // predecessor transition.
  if (!streamEventBus.adoptStreamRun(sessionKey, expectedRunId, nextRunId)) return false;
  // Adoption preserves whether the prior record was active or dormant. Every
  // provider adoption represents live work, so explicitly reactivate the new
  // identity before publishing or mutating the provider mirror.
  const activated = trackedStream?.active === false
    ? streamEventBus.resumeStream(sessionKey, nextRunId)
    : streamEventBus.startStream(sessionKey, nextRunId);
  if (!activated) return false;

  if (previousRunId) tombstoneRun(sessionKey, previousRunId);
  clearPendingEmptyFinal(sessionKey);
  clearPendingCodexIdleTimeout(sessionKey);
  resetRunStreamState(sessionKey);
  activeRunIds.set(sessionKey, nextRunId);
  const pendingToolRun = pendingToolRunsBySession.get(sessionKey);
  if (pendingToolRun) pendingToolRun.runId = nextRunId;
  if (publishResume) {
    streamEventBus.publish(sessionKey, { type: 'run_resumed', content: '', runId: nextRunId });
  }
  return true;
}

function cleanupCompletedRun(sessionKey: string, runId?: string): void {
  // Use soft-clear instead of hard-clear: the agent may resume after a sub-agent
  // completes (sessions_yield → sub-agent → result injected → new run starts).
  // Soft-clear resets text accumulators but preserves subscribers so the next run's
  // events are still forwarded to the browser.
  const completedRunId = normalizedRunId(runId) || activeRunIds.get(sessionKey);
  if (!completedRunId || activeRunIds.get(sessionKey) !== completedRunId) return;
  if (!streamEventBus.softClearStream(sessionKey, completedRunId)) return;
  tombstoneRun(sessionKey, completedRunId);
  if (activeRunIds.get(sessionKey) === completedRunId) activeRunIds.delete(sessionKey);
  pendingToolRunsBySession.delete(sessionKey);
  resetRunStreamState(sessionKey);
}

function publishTextIfNew(sessionKey: string, text: string, runId: string): void {
  const finalText = sanitizeAssistantDelta(text);
  if (!finalText) return;

  const streamedText = streamEventBus.getLatestText(sessionKey);
  if (!streamedText) {
    streamEventBus.publish(sessionKey, { type: 'text', content: finalText, replace: true, runId });
  } else if (finalText === streamedText) {
    // Already visible.
  } else if (finalText.startsWith(streamedText) && finalText.length > streamedText.length) {
    streamEventBus.publish(sessionKey, { type: 'text', content: finalText.substring(streamedText.length), runId });
  } else if (!streamedText.includes(finalText)) {
    streamEventBus.publish(sessionKey, { type: 'text', content: finalText, replace: true, runId });
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
  if (hasRunningToolCall(sessionKey) || hasPendingToolRun(sessionKey)) return false;

  const effectiveRunId = normalizedRunId(runId) || activeRunIds.get(sessionKey);
  if (!effectiveRunId || activeRunIds.get(sessionKey) !== effectiveRunId) return false;

  const finalText = latestVisibleAssistantText(sessionKey);
  if (!finalText) return false;

  debugLog(`Treating Codex turn/completed idle timeout as completed after visible assistant output for ${sessionKey}`);
  publishTextIfNew(sessionKey, finalText, effectiveRunId);
  streamEventBus.publish(sessionKey, {
    type: 'done',
    content: finalText,
    runId: effectiveRunId,
  });
  cleanupCompletedRun(sessionKey, effectiveRunId);
  return true;
}

function clearPendingCodexIdleTimeout(sessionKey: string): void {
  const pending = pendingCodexIdleTimeoutBySession.get(sessionKey);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingCodexIdleTimeoutBySession.delete(sessionKey);
}

function publishFatalRunError(sessionKey: string, content: string, runId?: string): void {
  const failedRunId = normalizedRunId(runId) || activeRunIds.get(sessionKey);
  if (!failedRunId || activeRunIds.get(sessionKey) !== failedRunId) return;
  clearPendingCodexIdleTimeout(sessionKey);
  const safeContent = redactNativeProviderText(content) || 'Agent error';
  streamEventBus.publish(sessionKey, { type: 'error', content: safeContent, terminal: true, runId: failedRunId });
  if (!streamEventBus.clearStream(sessionKey, failedRunId)) return;
  tombstoneRun(sessionKey, failedRunId);
  if (activeRunIds.get(sessionKey) === failedRunId) activeRunIds.delete(sessionKey);
  pendingToolRunsBySession.delete(sessionKey);
  resetRunStreamState(sessionKey);
}

function deferCodexIdleTimeoutError(sessionKey: string, runId: string | undefined, errorText: string): boolean {
  if (!isCodexTurnCompletionUnconfirmedError(errorText)) return false;
  const delayedRunId = normalizedRunId(runId) || activeRunIds.get(sessionKey);
  if (!delayedRunId || activeRunIds.get(sessionKey) !== delayedRunId) return false;
  if (completeIdleTimedOutTurnIfVisible(sessionKey, delayedRunId, errorText)) return true;

  clearPendingCodexIdleTimeout(sessionKey);
  streamEventBus.publish(sessionKey, {
    type: 'status',
    content: 'Codex turn completion is delayed; waiting for the final response…',
    runId: delayedRunId,
  });

  const timer = setTimeout(() => {
    const pending = pendingCodexIdleTimeoutBySession.get(sessionKey);
    if (!pending || pending.runId !== delayedRunId) return;
    pendingCodexIdleTimeoutBySession.delete(sessionKey);
    if (completeIdleTimedOutTurnIfVisible(sessionKey, delayedRunId, errorText)) return;
    publishFatalRunError(sessionKey, errorText, delayedRunId);
  }, 15000);
  timer.unref?.();
  pendingCodexIdleTimeoutBySession.set(sessionKey, { runId: delayedRunId, errorText, timer });
  return true;
}

function scheduleEmptyFinal(sessionKey: string, runId?: string, model?: string | null): void {
  clearPendingEmptyFinal(sessionKey);
  const pendingRunId = normalizedRunId(runId) || activeRunIds.get(sessionKey);
  if (!pendingRunId) return;
  const timer = setTimeout(() => {
    const pending = pendingEmptyFinalBySession.get(sessionKey);
    if (!pending || pending.runId !== pendingRunId) return;
    pendingEmptyFinalBySession.delete(sessionKey);
    if (activeRunIds.get(sessionKey) !== pendingRunId) return;
    streamEventBus.publish(sessionKey, {
      type: 'done',
      content: '',
      model: model || null,
      runId: pendingRunId,
    });
    cleanupCompletedRun(sessionKey, pendingRunId);
  }, 2500);
  timer.unref?.();
  pendingEmptyFinalBySession.set(sessionKey, { runId: pendingRunId, model, timer });
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

type GatewayToolCallDescriptor = { id?: string; name?: string };

function gatewayToolCallDescriptor(value: unknown): GatewayToolCallDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const type = String(candidate.type || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, '');
  if (type && type !== 'toolcall' && type !== 'tooluse' && type !== 'functioncall') return null;
  const id = [candidate.id, candidate.toolCallId, candidate.callId]
    .find((entry) => typeof entry === 'string' && entry.trim()) as string | undefined;
  const name = [candidate.name, candidate.toolName, (candidate.function as any)?.name]
    .find((entry) => typeof entry === 'string' && entry.trim()) as string | undefined;
  if (!type && !id && !name) return null;
  return {
    ...(id ? { id: id.trim() } : {}),
    ...(name ? { name: name.trim() } : {}),
  };
}

function extractGatewayToolCalls(message: unknown): GatewayToolCallDescriptor[] {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return [];
  const candidate = message as Record<string, unknown>;
  const values = [
    ...(Array.isArray(candidate.toolCalls) ? candidate.toolCalls : []),
    ...(Array.isArray(candidate.content) ? candidate.content : []),
  ];
  return values.flatMap((value) => {
    const descriptor = gatewayToolCallDescriptor(value);
    return descriptor ? [descriptor] : [];
  });
}

function messageContainsToolCall(message: unknown): boolean {
  return extractGatewayToolCalls(message).length > 0;
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

function sanitizeAssistantDeltaChunk(text: string): string {
  if (!text) return '';
  const sanitized = sanitizeAssistantChunk(text);
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
  const key = String(sessionKey || '').trim();
  if (!key) return false;
  return streamEventBus.hasSubscribers(key)
    || Boolean(streamEventBus.getTrackedStream(key))
    || activeRunIds.has(key)
    || desiredSessionMessageSubscriptions.has(key)
    || activeSessionMessageSubscriptions.has(key);
}

function handleAgentEvent(payload: Record<string, unknown> | undefined): void {
  if (!payload) return;

  const sessionKey = resolveSessionKeyForGatewayPayload(payload);
  if (!sessionKey) {
    debugLog(`Ignoring agent event without resolvable sessionKey: stream=${String(payload.stream || '')} runId=${String(payload.runId || '')}`);
    return;
  }
  if (failedRunReservationsBySession.has(sessionKey)) {
    debugLog(`Ignoring agent event after ambiguous dispatch failure for ${sessionKey}`);
    return;
  }

  const stream = typeof payload.stream === 'string' ? payload.stream : '';
  const data = (payload.data && typeof payload.data === 'object' ? payload.data : {}) as Record<string, unknown>;
  const runId = normalizedRunId(payload.runId);

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

  let expectedRunId = activeRunIds.get(sessionKey);
  if (!runId) {
    debugLog(`Ignoring run-scoped agent event without runId for session=${sessionKey} stream=${stream}`);
    return;
  }
  if (runId && isRunTombstoned(sessionKey, runId)) {
    debugLog(`Ignoring agent event for tombstoned runId=${runId}`);
    return;
  }
  // The RPC response is only a provider ACK. A Portal host run may still need
  // to persist that exact upstream identity before any frame is browser-visible.
  // Queue even when the Gateway happens to reuse our reservation id.
  if (queuePendingRunFrame(sessionKey, 'agent', runId, payload)) return;
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
  if (!expectedRunId && runId && isRunTombstoned(sessionKey, runId)) {
    debugLog(`Ignoring late agent event for completed run session=${sessionKey} runId=${runId}`);
    return;
  }

  // If no active runId is set but the event has one, adopt it (new run segment after yield)
  if (!expectedRunId && runId) {
    debugLog(`Adopted new runId=${runId} for session ${sessionKey} (resumed after yield)`);
    const tracked = streamEventBus.getTrackedStream(sessionKey);
    const predecessorRunId = normalizedRunId(tracked?.runId) || null;
    if (tracked?.active && predecessorRunId && predecessorRunId !== runId) {
      debugLog(`Ignoring unreserved agent runId=${runId} while ${predecessorRunId} is active for ${sessionKey}`);
      return;
    }
    if (!registerRun(sessionKey, runId, predecessorRunId)) return;
    streamEventBus.publish(sessionKey, { type: 'run_resumed', content: '', runId });
    expectedRunId = runId;
  }

  // Ensure the stream is tracked
  const effectiveRunId = runId;
  if (!effectiveRunId || !streamEventBus.startStream(sessionKey, effectiveRunId)) return;
  if (!(stream === 'lifecycle' && String(data.phase || '').toLowerCase() === 'error')) {
    clearPendingCodexIdleTimeout(sessionKey);
  }

  if (stream === 'item' && data.kind === 'preamble') {
    const rawPreamble = extractPreambleProgressText(data);
    // Codex repeats every prior title on each preamble event, concatenated
    // without a separator. Emit only the newly appended tail; a snapshot that
    // does not extend the previous one means the provider restarted the lane
    // and is authoritative as-is.
    const lastSeenPreamble = preambleLastSeenTextMap.get(sessionKey) || '';
    let currentPreamble = rawPreamble;
    if (lastSeenPreamble && rawPreamble.startsWith(lastSeenPreamble)) {
      currentPreamble = rawPreamble.slice(lastSeenPreamble.length);
    }
    if (rawPreamble) preambleLastSeenTextMap.set(sessionKey, rawPreamble);
    const subject = sanitizeThinkingSubject(currentPreamble);
    if (subject) {
      const previousSubject = thinkingSubjectMap.get(sessionKey) || '';
      if (subject !== previousSubject) {
        // OpenClaw thinking snapshots are cumulative across provider preambles.
        // Freeze the raw body already represented by subject A so the first
        // snapshot under subject B can publish only B's body.
        thinkingSubjectBaselineMap.set(
          sessionKey,
          thinkingLastSeenTextMap.get(sessionKey) || '',
        );
        thinkingSubjectSegmentTextMap.set(sessionKey, '');
        thinkingSubjectMap.set(sessionKey, subject);
      }
      if (!hasRunningToolCall(sessionKey)) {
        streamEventBus.updateStreamPhase(sessionKey, {
          phase: 'thinking',
          runId: effectiveRunId,
          statusText: subject,
        });
      }
      streamEventBus.publish(sessionKey, {
        type: 'thinking',
        subject,
        content: '',
        runId: effectiveRunId,
      });
    }
    return;
  }

  if (stream === 'item' && data.kind === 'analysis') {
    const content = extractVisibleAnalysisThinkingText(data);
    streamEventBus.updateStreamPhase(sessionKey, {
      phase: 'thinking',
      runId: effectiveRunId,
      ...(content ? { statusText: content } : {}),
    });
    if (content) streamEventBus.publish(sessionKey, { type: 'thinking', content, runId: effectiveRunId });
    return;
  }

  if (stream === 'assistant') {
    const text = typeof data.text === 'string' ? sanitizeAssistantDelta(data.text) : undefined;
    const delta = typeof data.delta === 'string' ? sanitizeAssistantDeltaChunk(data.delta) : undefined;
    debugLog(`assistant event: session=${sessionKey} runId=${runId || '-'} keys=${Object.keys(data).join(',')} textLen=${text?.length || 0} deltaLen=${delta?.length || 0}`);

    const assistantLastSeen = assistantLastSeenTextMap.get(sessionKey) || '';
    if (text) {
      if (assistantLastSeen && !text.startsWith(assistantLastSeen)) {
        debugLog(`ASSISTANT SNAPSHOT RESET: prev=${assistantLastSeen.length} new=${text.length}`);
      }
      assistantLastSeenTextMap.set(sessionKey, text);
      if (publishArbitratedTextSnapshot(sessionKey, effectiveRunId, 'assistant', text)) {
        markAssistantTextLane(sessionKey, effectiveRunId);
      }
    } else if (delta) {
      const nextSeen = assistantLastSeen + delta;
      assistantLastSeenTextMap.set(sessionKey, nextSeen);
      if (publishArbitratedTextSnapshot(sessionKey, effectiveRunId, 'assistant', nextSeen)) {
        markAssistantTextLane(sessionKey, effectiveRunId);
      }
    }
    return;
  }

  if (stream === 'thinking') {
    // OpenClaw 2026.7.1 sends { text: <cumulative snapshot>, delta: <suffix> }
    // for both the claude-cli thinking lane (isReasoningSnapshot) and the
    // embedded runtime. Publishing the snapshot as an append chunk duplicates
    // the whole thought on every event, so diff against the last snapshot and
    // emit only new text. Events with only progressTokens carry no text.
    const snapshotText = typeof data.text === 'string' ? data.text : '';
    const chunkText = typeof data.delta === 'string'
      ? data.delta
      : (typeof data.content === 'string' ? data.content : '');
    let thinkingContent = '';
    let thinkingReplace = false;
    if (snapshotText) {
      const lastSeenRawThinking = thinkingLastSeenTextMap.get(sessionKey) || '';
      if (snapshotText === lastSeenRawThinking) return;
      const baseline = thinkingSubjectBaselineMap.get(sessionKey) || '';
      let currentSubjectSnapshot = snapshotText;
      if (baseline) {
        if (snapshotText.startsWith(baseline)) {
          currentSubjectSnapshot = snapshotText.slice(baseline.length);
        } else {
          // Provider rewrote the cumulative lane at this boundary. The new
          // snapshot is authoritative for the current subject.
          thinkingSubjectBaselineMap.set(sessionKey, '');
        }
      }
      const previousSubjectSnapshot = thinkingSubjectSegmentTextMap.get(sessionKey) || '';
      if (currentSubjectSnapshot === previousSubjectSnapshot) {
        thinkingLastSeenTextMap.set(sessionKey, snapshotText);
        return;
      }
      thinkingContent = currentSubjectSnapshot;
      // A snapshot that extends the previous one is the same thought growing:
      // replace the current thinking segment in place. A snapshot that does
      // not extend it is a new thinking phase (new assistant message), which
      // must start a fresh segment instead of overwriting the prior thought.
      thinkingReplace = Boolean(previousSubjectSnapshot)
        && currentSubjectSnapshot.startsWith(previousSubjectSnapshot);
      thinkingLastSeenTextMap.set(sessionKey, snapshotText);
      thinkingSubjectSegmentTextMap.set(sessionKey, currentSubjectSnapshot);
    } else if (chunkText) {
      thinkingLastSeenTextMap.set(sessionKey, (thinkingLastSeenTextMap.get(sessionKey) || '') + chunkText);
      thinkingSubjectSegmentTextMap.set(
        sessionKey,
        (thinkingSubjectSegmentTextMap.get(sessionKey) || '') + chunkText,
      );
      thinkingContent = chunkText;
    }
    if (thinkingContent) {
      // Thought deltas can arrive while a tool card is still active. Do not
      // discard them; just avoid overwriting the visible tool phase/status.
      if (!hasRunningToolCall(sessionKey)) {
        streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking', runId: effectiveRunId });
      }
      streamEventBus.publish(sessionKey, {
        type: 'thinking',
        content: thinkingContent,
        runId: effectiveRunId,
        ...(thinkingReplace ? { replace: true } : {}),
      });
    }
    return;
  }

  if (stream === 'tool') {
    const phase = typeof data.phase === 'string' ? data.phase : '';
    const toolName = typeof data.name === 'string' ? data.name : 'tool';
    const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
    if (isMessageToolName(toolName)) return;
    const updateFingerprint = phase === 'update'
      ? extractToolResultText(data.partialResult ?? data.output ?? data.result)?.substring(0, 1000) || ''
      : '';
    const toolIdentity = toolCallId ? `id:${toolCallId}` : `name:${toolName}`;
    const phaseKey = `${runId || ''}\u0000${toolIdentity}\u0000${phase}\u0000${updateFingerprint}`;
    const seenToolPhases = seenToolPhaseKeysBySession.get(sessionKey) || new Set<string>();
    if (seenToolPhases.has(phaseKey)) {
      debugLog(`Ignoring duplicate tool.${phase} for ${sessionKey} runId=${runId || 'none'} tool=${toolName}`);
      return;
    }
    seenToolPhases.add(phaseKey);
    seenToolPhaseKeysBySession.set(sessionKey, seenToolPhases);

    debugLog(`TOOL EVENT: phase=${phase} name=${toolName} session=${sessionKey}`);

    if (phase === 'start') {
      clearPendingEmptyFinal(sessionKey);
      registerPendingToolFinal(sessionKey, effectiveRunId, {
        toolCalls: [{
          type: 'toolCall',
          ...(typeof data.toolCallId === 'string' ? { id: data.toolCallId } : {}),
          name: toolName,
        }],
      });
      const lastSeen = streamEventBus.getLastSeenText(sessionKey);
      if (lastSeen.length > 0) {
        streamEventBus.publish(sessionKey, { type: 'segment_break', content: '', runId: effectiveRunId });
        streamEventBus.setLastSeenText(sessionKey, '');
      }
      beginTextSegment(sessionKey, effectiveRunId);
      const icon = getToolIcon(toolName);
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'tool', toolName, runId: effectiveRunId });
      streamEventBus.publish(sessionKey, {
        type: 'tool_start',
        content: `${icon} Using tool: ${toolName}`,
        toolName,
        toolCallId: data.toolCallId,
        toolArgs: data.input || data.args,
        runId: effectiveRunId,
      });
    } else if (phase === 'update') {
      const partialOutput = extractToolResultText(data.partialResult ?? data.output ?? data.result)?.substring(0, 1000);
      if (partialOutput) {
        streamEventBus.updateStreamPhase(sessionKey, { phase: 'tool', toolName, runId: effectiveRunId });
        streamEventBus.publish(sessionKey, {
          type: 'tool_update',
          content: partialOutput,
          toolName,
          toolCallId: data.toolCallId,
          toolResult: partialOutput,
          runId: effectiveRunId,
        });
      }
    } else if (phase === 'result') {
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'streaming', toolName: undefined, runId: effectiveRunId });
      const output = extractToolResultText(data.output ?? data.result)?.substring(0, 1000);
      const resultStatus = String((data.result as any)?.status || data.status || '').toLowerCase();
      const isError = data.isError === true
        || resultStatus === 'failed'
        || resultStatus === 'error'
        || (typeof data.exitCode === 'number' && Number.isFinite(data.exitCode) && data.exitCode !== 0);
      streamEventBus.publish(sessionKey, {
        type: 'tool_end',
        content: isError ? `❌ Tool failed: ${toolName}` : `✅ Tool completed: ${toolName}`,
        toolName,
        toolCallId: data.toolCallId,
        toolResult: output,
        runId: effectiveRunId,
        ...(typeof data.exitCode === 'number' && Number.isFinite(data.exitCode)
          ? { exitCode: data.exitCode }
          : {}),
        ...(isError ? { status: 'error' } : {}),
      });
      const deferredFinal = settlePendingTool(sessionKey, data, toolName);
      if (deferredFinal) handleChatEvent(deferredFinal);
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
      if (deferCodexIdleTimeoutError(sessionKey, effectiveRunId, errMsg)) return;
      publishFatalRunError(sessionKey, errMsg, effectiveRunId);
    } else if (lifecycleSignal === 'compacting') {
      const status = lifecycleStatusText || 'Compacting context…';
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking', statusText: status, compactionPhase: 'compacting', runId: effectiveRunId });
      streamEventBus.publish(sessionKey, { type: 'compaction_start', content: status, maintenanceKind: 'compaction' });
    } else if (lifecycleSignal === 'compacted') {
      const status = lifecycleStatusText || 'Context compacted';
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking', statusText: status, compactionPhase: 'compacted', runId: effectiveRunId });
      streamEventBus.publish(sessionKey, { type: 'compaction_end', content: status, completed: true, maintenanceKind: 'compaction' });
    } else if (lifecycleSignal === 'maintenance') {
      const status = lifecycleStatusText || 'Preparing context maintenance…';
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking', statusText: status, compactionPhase: 'compacting', runId: effectiveRunId });
      streamEventBus.publish(sessionKey, { type: 'status', content: status, maintenanceKind: 'maintenance' });
    } else if (lifecycleSignal === 'maintenance_done') {
      const status = lifecycleStatusText || 'Context maintenance finished.';
      streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking', statusText: status, compactionPhase: 'idle', runId: effectiveRunId });
      streamEventBus.publish(sessionKey, { type: 'status', content: status, maintenanceKind: 'maintenance' });
    } else if (phase === 'started' || phase === 'running' || phase === 'start') {
      if (hasRunningToolCall(sessionKey)) {
        debugLog(`Ignoring lifecycle.${phase} while tool is active for ${sessionKey}`);
        return;
      }
      if (lifecycleStatusText) {
        streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking', statusText: lifecycleStatusText, runId: effectiveRunId });
        streamEventBus.publish(sessionKey, { type: 'status', content: lifecycleStatusText, runId: effectiveRunId });
      } else {
        streamEventBus.updateStreamPhase(sessionKey, { phase: 'thinking', runId: effectiveRunId });
      }
    }
    return;
  }
}

function handleSessionMessageEvent(payload: Record<string, unknown> | undefined): void {
  if (!payload) return;
  const sessionKey = resolveSessionKeyForGatewayPayload(payload);
  if (!sessionKey) return;
  if (failedRunReservationsBySession.has(sessionKey)) return;

  const message = payload.message && typeof payload.message === 'object' ? payload.message as any : null;
  if (!message) return;

  const messageRunId = [
    payload.runId,
    message.runId,
    message.__openclaw?.runId,
    message.metadata?.runId,
    message.metadata?.__openclaw?.runId,
  ].find((value) => typeof value === 'string' && value.trim()) as string | undefined;
  const normalizedMessageRunId = messageRunId?.trim();
  const activeRunId = activeRunIds.get(sessionKey);
  if (normalizedMessageRunId) {
    if (queuePendingRunFrame(
      sessionKey,
      'session_message',
      normalizedMessageRunId,
      payload,
    )) return;
  } else {
    const pending = pendingRunReservationsBySession.get(sessionKey);
    if (pending && activeRunId === pending.reservationRunId) {
      // An unbound delivery mirror cannot be attributed to the ACKed run. Drop
      // it while dispatch persistence is pending; run-scoped agent/chat frames
      // remain the authoritative replay source after acceptance.
      return;
    }
  }
  if (
    normalizedMessageRunId
    && (
      isRunTombstoned(sessionKey, normalizedMessageRunId)
      || (activeRunId && normalizedMessageRunId !== activeRunId)
    )
  ) {
    debugLog(`Ignoring stale session.message for ${sessionKey} runId=${normalizedMessageRunId} expected=${activeRunId || '-'}`);
    return;
  }

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
    const reasoningRunId = normalizedMessageRunId || activeRunId;
    if (reasoningRunId && streamEventBus.startStream(sessionKey, reasoningRunId)) {
      streamEventBus.publish(sessionKey, {
        type: 'thinking',
        content: reasoningMirrorText,
        runId: reasoningRunId,
      });
    }
    return;
  }

  const messageToolReplyText = extractMessageToolReplyText(message);
  if (messageToolReplyText && !isControlOnlyAssistantText(messageToolReplyText)) {
    if (hasPendingToolRun(sessionKey) || hasRunningToolCall(sessionKey)) {
      messageToolReplyBySession.set(sessionKey, { text: messageToolReplyText, ts: Date.now() });
      return;
    }
    const pending = pendingEmptyFinalBySession.get(sessionKey);
    if (pending) {
      const pendingRunId = normalizedRunId(pending.runId);
      if (
        !pendingRunId
        || activeRunIds.get(sessionKey) !== pendingRunId
        || !streamEventBus.startStream(sessionKey, pendingRunId)
      ) return;
      clearPendingEmptyFinal(sessionKey);
      publishTextIfNew(sessionKey, messageToolReplyText, pendingRunId);
      streamEventBus.publish(sessionKey, {
        type: 'done',
        content: messageToolReplyText,
        model: extractGatewayMessageModel(payload) || pending.model || null,
        runId: pendingRunId,
      });
      cleanupCompletedRun(sessionKey, pendingRunId);
      return;
    }
    messageToolReplyBySession.set(sessionKey, { text: messageToolReplyText, ts: Date.now() });
  }

  if (
    normalizedRole === 'assistant'
    && text
    && !isControlOnlyAssistantText(text)
    && !messageContainsToolCall(message)
  ) {
    if (hasPendingToolRun(sessionKey) || hasRunningToolCall(sessionKey)) {
      // This may be the gateway's pre-tool assistant mirror. The run-scoped
      // chat.final remains authoritative while any tool is unresolved.
      return;
    }
    const pending = pendingEmptyFinalBySession.get(sessionKey);
    const trackedRunId = activeRunIds.get(sessionKey) || streamEventBus.getTrackedStream(sessionKey)?.runId;
    const deliveryRunId = pending?.runId || trackedRunId;
    // A subscribed session.message is only authoritative as the delivery
    // mirror for an explicitly pending empty chat.final. Treating arbitrary
    // text-only mirrors as terminal lets reordered pre-tool prose close this
    // turn—or a late prior-turn mirror close the next one. Normal turns finish
    // exclusively through their run-scoped chat.final.
    if (pending) {
      if (
        !deliveryRunId
        || activeRunIds.get(sessionKey) !== deliveryRunId
        || !streamEventBus.startStream(sessionKey, deliveryRunId)
      ) return;
      clearPendingEmptyFinal(sessionKey);
      publishTextIfNew(sessionKey, text, deliveryRunId);
      streamEventBus.publish(sessionKey, {
        type: 'done',
        content: text,
        model: extractGatewayMessageModel(payload) || pending?.model || null,
        runId: deliveryRunId,
      });
      cleanupCompletedRun(sessionKey, deliveryRunId);
      return;
    }
    const toolState = pendingToolRunsBySession.get(sessionKey);
    if (toolState && toolState.unresolved.size === 0 && toolState.settled.size > 0) {
      // After every tool settles, Codex may publish the post-tool answer here
      // just before an empty chat.final. Cache only in that proven phase.
      messageToolReplyBySession.set(sessionKey, { text, ts: Date.now() });
    }
    // Other ordinary assistant mirrors are informational duplicates. Do not
    // retain them as a possible terminal delivery.
    return;
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
  if (failedRunReservationsBySession.has(sessionKey)) {
    debugLog(`Ignoring chat event after ambiguous dispatch failure for ${sessionKey}`);
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

  const runId = normalizedRunId(payload.runId);

  let expectedRunId = activeRunIds.get(sessionKey);
  if (!runId) {
    debugLog(`Ignoring run-scoped chat event without runId for session=${sessionKey} state=${state}`);
    return;
  }
  if (runId && isRunTombstoned(sessionKey, runId)) {
    debugLog(`Ignoring chat event state=${state} for tombstoned runId=${runId}`);
    return;
  }
  // Keep every run-scoped frame behind the reservation until the caller has
  // durably accepted the provider dispatch. This also covers a Gateway that
  // chooses the reservation id itself as the upstream run id.
  if (queuePendingRunFrame(sessionKey, 'chat', runId, payload)) return;
  if (expectedRunId && runId && runId !== expectedRunId) {
    debugLog(`Ignoring chat event state=${state} for stale runId=${runId} (expected ${expectedRunId})`);
    return;
  }

  if (!expectedRunId && runId && state === 'error' && streamEventBus.wasRecentlyDone(sessionKey, 10000)) {
    debugLog(`Ignoring late chat.error after completed run for session=${sessionKey} runId=${runId}`);
    return;
  }
  if (!expectedRunId && runId && isRunTombstoned(sessionKey, runId)) {
    debugLog(`Ignoring late chat.${state || 'event'} for completed run session=${sessionKey} runId=${runId}`);
    return;
  }

  // If no active runId is set but the event has one, adopt it (new run segment)
  if (!expectedRunId && runId) {
    const wasRecent = streamEventBus.wasRecentlyDone(sessionKey);
    debugLog(`Adopted new runId=${runId} for session ${sessionKey} via chat event (wasRecentlyDone=${wasRecent})`);
    const tracked = streamEventBus.getTrackedStream(sessionKey);
    const predecessorRunId = normalizedRunId(tracked?.runId) || null;
    if (tracked?.active && predecessorRunId && predecessorRunId !== runId) {
      debugLog(`Ignoring unreserved chat runId=${runId} while ${predecessorRunId} is active for ${sessionKey}`);
      return;
    }
    if (!registerRun(sessionKey, runId, predecessorRunId)) return;
    if (predecessorRunId !== runId) {
      streamEventBus.publish(sessionKey, { type: 'run_resumed', content: '', runId });
    }
    expectedRunId = runId;
  }

  // Ensure the stream is tracked
  const effectiveRunId = runId;
  if (!effectiveRunId || !streamEventBus.startStream(sessionKey, effectiveRunId)) return;
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
      streamEventBus.publish(sessionKey, { type: 'thinking', content: reasoningMirrorText, runId: effectiveRunId });
      return;
    }

    const deltaText = extractTextFromContent(
      message?.content ?? payload.text ?? payload.delta ?? payload.content ?? '',
    );

    debugLog(`chat.delta event: session=${sessionKey} runId=${runId || '-'} textLen=${deltaText.length} payloadKeys=${Object.keys(payload).join(',')}`);
    if (!deltaText || isControlOnlyAssistantText(deltaText)) return;

    chatLastSeenTextMap.set(sessionKey, deltaText);
    // Prefer a currently-growing assistant lane, but only within this segment
    // and for a short grace period. A tool boundary or lane silence immediately
    // re-enables the cumulative chat.delta fallback.
    if (assistantTextLaneOwnsCurrentSegment(sessionKey, effectiveRunId)) return;
    publishArbitratedTextSnapshot(sessionKey, effectiveRunId, 'chat', deltaText);
    return;
  }

  if (state === 'final') {
    const message = payload.message as Record<string, unknown> | undefined;
    const finalText = message ? extractTextFromContent(message.content) : '';
    const finalModel = extractGatewayMessageModel(payload);
    debugLog(`chat.final event: session=${sessionKey} runId=${runId || '-'} finalLen=${finalText.length} payloadKeys=${Object.keys(payload).join(',')}`);

    // OpenClaw emits an assistant message that requests a tool as chat.final,
    // then continues the same run with tool events and a later, tool-free final
    // response. Treating the tool-bearing frame as terminal closes the provider
    // waiter and browser rail before the tool result or real answer can arrive.
    // Preserve any pre-tool prose as the current text segment, but keep the run
    // active until every requested tool has settled.
    if (messageContainsToolCall(message)) {
      clearPendingEmptyFinal(sessionKey);
      registerPendingToolFinal(sessionKey, effectiveRunId, message);
      if (finalText && !isControlOnlyAssistantText(finalText)) {
        chatLastSeenTextMap.set(sessionKey, finalText);
        publishArbitratedTextSnapshot(sessionKey, effectiveRunId, 'chat', finalText);
      }
      debugLog(`Deferring tool-bearing chat.final for ${sessionKey} runId=${runId || '-'} until all tools settle`);
      return;
    }

    if (deferTerminalUntilToolsSettle(sessionKey, payload) || hasRunningToolCall(sessionKey)) {
      const pending = pendingToolRunsBySession.get(sessionKey);
      if (pending && !pending.deferredFinal) pending.deferredFinal = payload;
      debugLog(`Deferring chat.final for ${sessionKey} runId=${runId || '-'} while tools remain active`);
      return;
    }

    const finalReasoningMirrorText = extractReasoningMirrorText(message);
    if (finalReasoningMirrorText && !isControlOnlyAssistantText(finalReasoningMirrorText)) {
      streamEventBus.publish(sessionKey, { type: 'thinking', content: finalReasoningMirrorText, runId: effectiveRunId });
      scheduleEmptyFinal(sessionKey, effectiveRunId, extractGatewayMessageModel(payload));
      return;
    }

    if (!finalText || isControlOnlyAssistantText(finalText)) {
      // Codex/app-server may emit the visible assistant text as either a
      // message-tool sourceReply or a delivery-mirror `session.message` around
      // an empty chat.final. Prefer that real visible delivery over closing the
      // live bubble empty.
      const messageToolReplyText = takeRecentMessageToolReply(sessionKey);
      if (messageToolReplyText) {
        publishTextIfNew(sessionKey, messageToolReplyText, effectiveRunId);
        streamEventBus.publish(sessionKey, {
          type: 'done',
          content: messageToolReplyText,
          model: finalModel,
          runId: effectiveRunId,
        });
        cleanupCompletedRun(sessionKey, effectiveRunId);
        return;
      }
      scheduleEmptyFinal(sessionKey, effectiveRunId, finalModel);
      return;
    }

    clearPendingEmptyFinal(sessionKey);

    // After tools, OpenClaw's terminal message can concatenate every prior text
    // segment. Those completed segments have already been graduated around tool
    // cards. Publish only the residual terminal tail while retaining the raw
    // aggregate as server-side result metadata.
    const arbitrationState = getTextArbitrationState(sessionKey, effectiveRunId);
    const terminalText = reconcileCumulativeFinalTail(
      arbitrationState.completedSegments,
      finalText,
    );

    // Reconcile the residual final against the currently-live post-tool text.
    if (terminalText && !isControlOnlyAssistantText(terminalText)) {
      const streamedText = streamEventBus.getLatestText(sessionKey);
      if (!streamedText) {
        // Nothing was streamed in the current segment — deliver the tail.
        streamEventBus.publish(sessionKey, { type: 'text', content: terminalText, replace: true, runId: effectiveRunId });
        chatLastSeenTextMap.set(sessionKey, finalText);
      } else if (terminalText === streamedText) {
        // Exact match — nothing to do
      } else if (terminalText.startsWith(streamedText) && terminalText.length > streamedText.length) {
        // Final is a continuation of what we have — append the tail
        streamEventBus.publish(sessionKey, { type: 'text', content: terminalText.substring(streamedText.length), runId: effectiveRunId });
        chatLastSeenTextMap.set(sessionKey, finalText);
      } else if (terminalText.includes(streamedText)) {
        debugLog(`Skipping final text reconciliation: streamedText is a segment of terminalText (streamed=${streamedText.length}, terminal=${terminalText.length})`);
      } else if (terminalText.length > streamedText.length * 2) {
        debugLog(`Skipping oversized terminal text: terminal=${terminalText.length} vs streamed=${streamedText.length}`);
      } else {
        // Genuinely different — replace (covers edge cases like compaction rewrites)
        streamEventBus.publish(sessionKey, { type: 'text', content: terminalText, replace: true, runId: effectiveRunId });
        chatLastSeenTextMap.set(sessionKey, finalText);
      }
    }

    streamEventBus.publish(sessionKey, {
      type: 'done',
      content: terminalText,
      ...(terminalText !== finalText ? { aggregateContent: finalText } : {}),
      model: finalModel,
      runId: effectiveRunId,
    });

    cleanupCompletedRun(sessionKey, effectiveRunId);
    return;
  }

  if (state === 'error') {
    const errMsg = typeof payload.errorMessage === 'string'
      ? payload.errorMessage
      : (typeof payload.error === 'string' ? payload.error : 'Chat error');
    if (deferCodexIdleTimeoutError(sessionKey, effectiveRunId, errMsg)) return;
    publishFatalRunError(sessionKey, errMsg, effectiveRunId);
    return;
  }

  if (state === 'aborted') {
    const latestText = streamEventBus.getLatestText(sessionKey);
    const abortedText = typeof payload.text === 'string' && payload.text.length > 0
      ? payload.text
      : latestText;
    streamEventBus.publish(sessionKey, {
      type: 'done',
      content: abortedText,
      model: extractGatewayMessageModel(payload),
      runId: effectiveRunId,
      metadata: { aborted: true },
    });
    if (!streamEventBus.clearStream(sessionKey, effectiveRunId)) return;
    tombstoneRun(sessionKey, effectiveRunId);
    if (activeRunIds.get(sessionKey) === effectiveRunId) activeRunIds.delete(sessionKey);
    pendingToolRunsBySession.delete(sessionKey);
    clearPendingEmptyFinal(sessionKey);
    resetRunStreamState(sessionKey);
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
            // Mark the session as potentially resuming in StreamEventBus
            if (!streamEventBus.startStream(sessionKey, runId)) {
              if (activeRunIds.get(sessionKey) === runId) activeRunIds.delete(sessionKey);
              debugLog(`Skipped stale reconnect snapshot for ${sessionKey} runId=${runId}`);
            } else {
              activeRunIds.set(sessionKey, runId);
            }
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
      const approvalRunId = approval.request?.sessionKey
        ? activeRunIds.get(approval.request.sessionKey)
        : undefined;
      if (approval.request?.sessionKey && approvalRunId && streamEventBus.hasSubscribers(approval.request.sessionKey)) {
        streamEventBus.publish(approval.request.sessionKey, {
          type: 'status',
          content: '⏳ Waiting for command approval…',
          approval,
          runId: approvalRunId,
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

export function reserveLogicalRun(sessionKey: string, reservationRunId: string): boolean {
  const key = String(sessionKey || '').trim();
  const reservation = normalizedRunId(reservationRunId);
  if (!key || !reservation) return false;

  const tracked = streamEventBus.getTrackedStream(key);
  const trackedRunId = normalizedRunId(tracked?.runId) || null;
  const currentRunId = activeRunIds.get(key) || trackedRunId;
  let accepted = false;
  if (currentRunId === reservation) {
    accepted = registerRun(key, reservation);
  } else if (tracked?.active && currentRunId) {
    // A live different run is a true concurrency conflict. A dormant
    // predecessor is the exact state a new logical turn may replace via CAS.
    accepted = false;
  } else if (currentRunId) {
    accepted = registerRun(key, reservation, currentRunId);
  } else if (tracked) {
    accepted = registerRun(key, reservation, null);
  } else {
    accepted = registerRun(key, reservation);
  }
  if (!accepted) return false;

  failedRunReservationsBySession.delete(key);
  const existing = pendingRunReservationsBySession.get(key);
  if (!existing || existing.reservationRunId !== reservation) {
    pendingRunReservationsBySession.set(key, {
      reservationRunId: reservation,
      frames: [],
      bytes: 0,
    });
  }
  return true;
}

export function acknowledgeRunReservation(
  sessionKey: string,
  reservationRunId: string,
  upstreamRunId: string,
): boolean {
  const pending = pendingRunReservationsBySession.get(sessionKey);
  if (!pending || pending.reservationRunId !== reservationRunId) return false;
  if (!registerRun(sessionKey, upstreamRunId, reservationRunId)) {
    failPendingRunReservation(sessionKey, reservationRunId);
    return false;
  }

  pendingRunReservationsBySession.delete(sessionKey);
  if (upstreamRunId !== reservationRunId) {
    streamEventBus.publish(sessionKey, { type: 'run_resumed', content: '', runId: upstreamRunId });
  }
  for (const frame of pending.frames) {
    if (frame.runId !== upstreamRunId) continue;
    if (frame.kind === 'agent') handleAgentEvent(frame.payload);
    else if (frame.kind === 'chat') handleChatEvent(frame.payload);
    else handleSessionMessageEvent(frame.payload);
  }
  return true;
}

async function persistDispatchThenAcknowledgeRunReservation(
  sessionKey: string,
  reservationRunId: string,
  upstreamRunId: string,
  onProviderDispatchAccepted?: (upstreamRunId: string) => Promise<void>,
): Promise<void> {
  try {
    await onProviderDispatchAccepted?.(upstreamRunId);
  } catch (error) {
    // The provider may already be running, but none of its buffered output may
    // become visible when the durable dispatch journal rejected the ACK.
    failPendingRunReservation(sessionKey, reservationRunId);
    tombstoneRun(sessionKey, upstreamRunId);
    throw error;
  }
  if (acknowledgeRunReservation(sessionKey, reservationRunId, upstreamRunId)) return;
  failPendingRunReservation(sessionKey, reservationRunId);
  tombstoneRun(sessionKey, upstreamRunId);
  throw new Error(`Stale chat.send response ignored for ${sessionKey}`);
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
  const rpcSessionKey = typeof params.sessionKey === 'string' ? params.sessionKey.trim() : '';
  const runReservation = method === 'chat.send' && rpcSessionKey ? requestId : '';
  if (runReservation && !reserveLogicalRun(rpcSessionKey, runReservation)) {
    throw new Error(`A different run is already active for ${rpcSessionKey}`);
  }

  return new Promise((resolve, reject) => {
    const timeoutTimer = setTimeout(() => {
      pendingResponses.delete(requestId);
      if (runReservation) failPendingRunReservation(rpcSessionKey, runReservation);
      reject(new Error(`${method} RPC timeout`));
    }, timeoutMs);

    pendingResponses.set(requestId, {
      resolve: (payload: any) => {
        clearTimeout(timeoutTimer);
        const runId = normalizedRunId(payload?.runId) || runReservation;
        if (method === 'chat.send' && rpcSessionKey) {
          if (!acknowledgeRunReservation(rpcSessionKey, runReservation, runId)) {
            reject(new Error(`Stale chat.send response ignored for ${rpcSessionKey}`));
            return;
          }
          debugLog(`chat.send accepted via generic RPC: sessionKey=${rpcSessionKey} runId=${runId}`);
        }
        resolve(payload);
      },
      reject: (err: Error) => {
        clearTimeout(timeoutTimer);
        if (runReservation) failPendingRunReservation(rpcSessionKey, runReservation);
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
      if (runReservation) failPendingRunReservation(rpcSessionKey, runReservation);
      reject(new Error(`Failed to send ${method}: ${err.message}`));
    }
  });
}

export const PENDING_USER_INPUT_READ_GATEWAY_METHOD = 'bridgesllm.ask_user.pending';
export const PENDING_USER_INPUT_GATEWAY_METHOD = 'bridgesllm.ask_user.answer';
export const PENDING_USER_INPUT_DISMISS_GATEWAY_METHOD = 'bridgesllm.ask_user.dismiss';
export const ACTIVE_RUN_STEER_GATEWAY_METHOD = 'bridgesllm.ask_user.steer';

export interface PendingUserInputQuestion {
  id: string;
  question: string;
  header?: string;
  /** Pinned Codex/OpenClaw native schema accepts one answer per question. */
  multiSelect: false;
  isOther?: boolean;
  isSecret?: boolean;
  options: Array<{ label: string; description?: string }>;
}

export type PendingUserInputSnapshot =
  | { pending: false }
  | {
    pending: true;
    requestId: string;
    runId: string;
    questions: PendingUserInputQuestion[];
    createdAt?: number;
    expiresAt?: number;
  };

export interface PendingUserInputAnswerResult {
  accepted: true;
  replayed: boolean;
  idempotentReplay: boolean;
  requestId: string;
  runId: string;
}

export class PendingUserInputAnswerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'PendingUserInputAnswerError';
  }
}

type PendingUserInputRpc = (
  method: string,
  params: Record<string, any>,
  timeoutMs?: number,
) => Promise<any>;

const PENDING_INPUT_IDENTIFIER_CONTROLS = /[\u0000-\u001F\u007F]/;
const PENDING_INPUT_TEXT_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function pendingInputIdentifier(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (
    !normalized
    || normalized.length > maxLength
    || PENDING_INPUT_IDENTIFIER_CONTROLS.test(normalized)
  ) {
    throw new PendingUserInputAnswerError(
      'INVALID_REQUEST',
      `${label} must be a valid bounded string.`,
      400,
    );
  }
  return normalized;
}

function pendingInputDisplayText(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (
    !normalized
    || normalized.length > maxLength
    || PENDING_INPUT_TEXT_CONTROLS.test(normalized)
  ) {
    throw new PendingUserInputAnswerError(
      'INVALID_GATEWAY_RESPONSE',
      `OpenClaw returned an invalid ${label}.`,
      502,
    );
  }
  return normalized;
}

function pendingInputResponseIdentifier(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (
    !normalized
    || normalized.length > maxLength
    || PENDING_INPUT_IDENTIFIER_CONTROLS.test(normalized)
  ) {
    throw new PendingUserInputAnswerError(
      'INVALID_GATEWAY_RESPONSE',
      `OpenClaw returned an invalid ${label}.`,
      502,
    );
  }
  return normalized;
}

function pendingInputText(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (
    !normalized
    || normalized.length > 32_768
    || PENDING_INPUT_TEXT_CONTROLS.test(normalized)
  ) {
    throw new PendingUserInputAnswerError(
      'INVALID_REQUEST',
      'text must be a valid bounded string.',
      400,
    );
  }
  return normalized;
}

function pendingInputTimestamp(value: unknown, label: string): number | undefined {
  if (value == null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new PendingUserInputAnswerError(
      'INVALID_GATEWAY_RESPONSE',
      `OpenClaw returned an invalid ${label}.`,
      502,
    );
  }
  return Number(value);
}

function pendingInputQuestions(value: unknown): PendingUserInputQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new PendingUserInputAnswerError(
      'INVALID_GATEWAY_RESPONSE',
      'OpenClaw returned an invalid pending-input question list.',
      502,
    );
  }
  const questions = value.map((entry): PendingUserInputQuestion => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PendingUserInputAnswerError(
        'INVALID_GATEWAY_RESPONSE',
        'OpenClaw returned an invalid pending-input question.',
        502,
      );
    }
    const candidate = entry as Record<string, unknown>;
    // OpenClaw 2026.7.1's native `readQuestion` schema has no multi-select
    // field and `buildAgentHarnessUserInputAnswers` emits one answer per
    // question. The generic streamed AskQuestionCard owns multi-select; never
    // invent comma-delimited semantics for this native channel.
    if (candidate.multiSelect !== undefined && candidate.multiSelect !== false) {
      throw new PendingUserInputAnswerError(
        'INVALID_GATEWAY_RESPONSE',
        'OpenClaw returned unsupported native multi-select input.',
        502,
      );
    }
    const id = pendingInputResponseIdentifier(candidate.id, 'question id', 256);
    const question = pendingInputDisplayText(candidate.question, 'question text', 2_000);
    const header = candidate.header == null
      ? undefined
      : pendingInputDisplayText(candidate.header, 'question header', 64);
    const rawOptions = candidate.options == null ? [] : candidate.options;
    if (!Array.isArray(rawOptions) || rawOptions.length > 8) {
      throw new PendingUserInputAnswerError(
        'INVALID_GATEWAY_RESPONSE',
        'OpenClaw returned invalid pending-input options.',
        502,
      );
    }
    const options = rawOptions.map((option) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) {
        throw new PendingUserInputAnswerError(
          'INVALID_GATEWAY_RESPONSE',
          'OpenClaw returned an invalid pending-input option.',
          502,
        );
      }
      const item = option as Record<string, unknown>;
      const label = pendingInputDisplayText(item.label, 'option label', 200);
      const description = item.description == null || item.description === ''
        ? undefined
        : pendingInputDisplayText(item.description, 'option description', 500);
      return description ? { label, description } : { label };
    });
    return {
      id,
      question,
      ...(header ? { header } : {}),
      multiSelect: false,
      ...(candidate.isOther === true ? { isOther: true } : {}),
      ...(candidate.isSecret === true ? { isSecret: true } : {}),
      options,
    };
  });
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw new PendingUserInputAnswerError(
      'INVALID_GATEWAY_RESPONSE',
      'OpenClaw returned duplicate pending-input question identities.',
      502,
    );
  }
  return questions;
}

function rejectedPendingInputResponse(payload: any): never {
  const code = typeof payload?.code === 'string' && payload.code.trim()
    ? payload.code.trim()
    : 'NOT_ACCEPTED';
  throw new PendingUserInputAnswerError(
    code,
    code === 'NO_ACTIVE_RUN' || code === 'REQUEST_NOT_FOUND'
      ? 'That OpenClaw run is no longer waiting for input.'
      : 'The active OpenClaw run did not accept the input.',
    code === 'NO_ACTIVE_RUN' || code === 'REQUEST_NOT_FOUND' ? 404 : 409,
  );
}

export async function readPendingUserInputWithRpc(
  rpc: PendingUserInputRpc,
  sessionKey: unknown,
  expectedRunId: unknown,
): Promise<PendingUserInputSnapshot> {
  const normalizedSessionKey = pendingInputIdentifier(sessionKey, 'sessionKey', 512);
  const normalizedRunId = pendingInputIdentifier(expectedRunId, 'expectedRunId', 512);
  const payload = await rpc(PENDING_USER_INPUT_READ_GATEWAY_METHOD, {
    sessionKey: normalizedSessionKey,
    expectedRunId: normalizedRunId,
  }, 10_000);
  if (typeof payload?.pending !== 'boolean') {
    throw new PendingUserInputAnswerError(
      'INVALID_GATEWAY_RESPONSE',
      'OpenClaw returned an invalid pending-input response.',
      502,
    );
  }
  if (payload.pending === false) {
    if (payload.runId != null && payload.runId !== normalizedRunId) {
      throw new PendingUserInputAnswerError(
        'INVALID_GATEWAY_RESPONSE',
        'OpenClaw returned a mismatched pending-input run.',
        502,
      );
    }
    const code = typeof payload.code === 'string' ? payload.code.trim() : '';
    if (code && code !== 'NO_PENDING_INPUT' && code !== 'NO_ACTIVE_RUN') {
      throw new PendingUserInputAnswerError(
        code,
        'OpenClaw could not inspect the active pending-input request.',
        code === 'HOTFIX_UNAVAILABLE' ? 503 : 502,
      );
    }
    return { pending: false };
  }
  const requestId = pendingInputResponseIdentifier(payload.requestId, 'requestId', 256);
  const runId = pendingInputResponseIdentifier(payload.runId, 'runId', 512);
  if (runId !== normalizedRunId) {
    throw new PendingUserInputAnswerError(
      'INVALID_GATEWAY_RESPONSE',
      'OpenClaw returned a mismatched pending-input run.',
      502,
    );
  }
  const questions = pendingInputQuestions(payload.questions);
  const createdAt = pendingInputTimestamp(payload.createdAt, 'createdAt');
  const expiresAt = pendingInputTimestamp(payload.expiresAt, 'expiresAt');
  if (createdAt !== undefined && expiresAt !== undefined && expiresAt <= createdAt) {
    throw new PendingUserInputAnswerError(
      'INVALID_GATEWAY_RESPONSE',
      'OpenClaw returned an invalid pending-input lifetime.',
      502,
    );
  }
  return {
    pending: true,
    requestId,
    runId,
    questions,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

export async function answerPendingUserInputWithRpc(
  rpc: PendingUserInputRpc,
  sessionKey: unknown,
  expectedRunId: unknown,
  requestId: unknown,
  text: unknown,
): Promise<PendingUserInputAnswerResult> {
  const normalizedSessionKey = pendingInputIdentifier(sessionKey, 'sessionKey', 512);
  const normalizedRunId = pendingInputIdentifier(expectedRunId, 'expectedRunId', 512);
  const normalizedRequestId = pendingInputIdentifier(requestId, 'requestId', 256);
  const normalizedText = pendingInputText(text);
  const payload = await rpc(PENDING_USER_INPUT_GATEWAY_METHOD, {
    sessionKey: normalizedSessionKey,
    expectedRunId: normalizedRunId,
    requestId: normalizedRequestId,
    text: normalizedText,
  }, 10_000);

  if (payload?.accepted !== true) rejectedPendingInputResponse(payload);
  if (
    payload.requestId !== normalizedRequestId
    || payload.runId !== normalizedRunId
    || typeof payload.replayed !== 'boolean'
  ) {
    throw new PendingUserInputAnswerError(
      'INVALID_GATEWAY_RESPONSE',
      'OpenClaw returned an invalid pending-input response.',
      502,
    );
  }
  return {
    accepted: true,
    replayed: payload.replayed,
    idempotentReplay: payload.replayed,
    requestId: normalizedRequestId,
    runId: normalizedRunId,
  };
}

export async function dismissPendingUserInputWithRpc(
  rpc: PendingUserInputRpc,
  sessionKey: unknown,
  expectedRunId: unknown,
  requestId: unknown,
): Promise<PendingUserInputAnswerResult> {
  const normalizedSessionKey = pendingInputIdentifier(sessionKey, 'sessionKey', 512);
  const normalizedRunId = pendingInputIdentifier(expectedRunId, 'expectedRunId', 512);
  const normalizedRequestId = pendingInputIdentifier(requestId, 'requestId', 256);
  const payload = await rpc(PENDING_USER_INPUT_DISMISS_GATEWAY_METHOD, {
    sessionKey: normalizedSessionKey,
    expectedRunId: normalizedRunId,
    requestId: normalizedRequestId,
  }, 10_000);
  if (payload?.accepted !== true) rejectedPendingInputResponse(payload);
  if (
    payload.requestId !== normalizedRequestId
    || payload.runId !== normalizedRunId
    || typeof payload.replayed !== 'boolean'
  ) {
    throw new PendingUserInputAnswerError(
      'INVALID_GATEWAY_RESPONSE',
      'OpenClaw returned an invalid pending-input dismissal response.',
      502,
    );
  }
  return {
    accepted: true,
    replayed: payload.replayed,
    idempotentReplay: payload.replayed,
    requestId: normalizedRequestId,
    runId: normalizedRunId,
  };
}

export async function steerActiveRunWithRpc(
  rpc: PendingUserInputRpc,
  sessionKey: unknown,
  expectedRunId: unknown,
  requestId: unknown,
  text: unknown,
): Promise<PendingUserInputAnswerResult> {
  const normalizedSessionKey = pendingInputIdentifier(sessionKey, 'sessionKey', 512);
  const normalizedRunId = pendingInputIdentifier(expectedRunId, 'expectedRunId', 512);
  const normalizedRequestId = pendingInputIdentifier(requestId, 'requestId', 256);
  const normalizedText = pendingInputText(text);
  const payload = await rpc(ACTIVE_RUN_STEER_GATEWAY_METHOD, {
    sessionKey: normalizedSessionKey,
    expectedRunId: normalizedRunId,
    requestId: normalizedRequestId,
    text: normalizedText,
  }, 10_000);
  if (payload?.accepted !== true) rejectedPendingInputResponse(payload);
  if (
    payload.requestId !== normalizedRequestId
    || payload.runId !== normalizedRunId
    || typeof payload.replayed !== 'boolean'
  ) {
    throw new PendingUserInputAnswerError(
      'INVALID_GATEWAY_RESPONSE',
      'OpenClaw returned an invalid active-run steering response.',
      502,
    );
  }
  return {
    accepted: true,
    replayed: payload.replayed,
    idempotentReplay: payload.replayed,
    requestId: normalizedRequestId,
    runId: normalizedRunId,
  };
}

/**
 * Answer a Codex `requestUserInput` prompt on the exact active embedded run.
 * Unlike `sessions.steer`, this never interrupts a run; unlike `chat.send`, it
 * can never create a new run after the target settles.
 */
export async function answerPendingUserInput(
  sessionKey: unknown,
  expectedRunId: unknown,
  requestId: unknown,
  text: unknown,
): Promise<PendingUserInputAnswerResult> {
  return answerPendingUserInputWithRpc(
    callGatewayRpc,
    sessionKey,
    expectedRunId,
    requestId,
    text,
  );
}

export async function readPendingUserInput(
  sessionKey: unknown,
  expectedRunId: unknown,
): Promise<PendingUserInputSnapshot> {
  return readPendingUserInputWithRpc(callGatewayRpc, sessionKey, expectedRunId);
}

export async function dismissPendingUserInput(
  sessionKey: unknown,
  expectedRunId: unknown,
  requestId: unknown,
): Promise<PendingUserInputAnswerResult> {
  return dismissPendingUserInputWithRpc(
    callGatewayRpc,
    sessionKey,
    expectedRunId,
    requestId,
  );
}

/**
 * Steer the exact active embedded run without answering a pending native
 * request, interrupting the run, or allowing a new turn to be created.
 */
export async function steerActiveRun(
  sessionKey: unknown,
  expectedRunId: unknown,
  requestId: unknown,
  text: unknown,
): Promise<PendingUserInputAnswerResult> {
  return steerActiveRunWithRpc(
    callGatewayRpc,
    sessionKey,
    expectedRunId,
    requestId,
    text,
  );
}

export async function sendChatMessage(
  sessionKey: string,
  message: string,
  idempotencyKey: string,
  routeReservationRunId?: string,
  onProviderDispatchAccepted?: (upstreamRunId: string) => Promise<void>,
): Promise<{ runId: string }> {
  if (!singletonWs || singletonWs.readyState !== WebSocket.OPEN) {
    throw new Error('Persistent WebSocket not connected');
  }
  if (!isAuthenticated) {
    throw new Error('Persistent WebSocket not authenticated');
  }

  const requestId = nextId();
  const reservationRunId = normalizedRunId(routeReservationRunId) || requestId;
  if (!reserveLogicalRun(sessionKey, reservationRunId)) {
    throw new Error(`A different run is already active for ${sessionKey}`);
  }

  // Register this session's run expectation BEFORE sending (prevents race with
  // stale replayed events that arrive between send and response).
  // We'll set the real runId when the response arrives.

  return new Promise((resolve, reject) => {
    const timeoutTimer = setTimeout(() => {
      pendingResponses.delete(requestId);
      failPendingRunReservation(sessionKey, reservationRunId);
      reject(new Error('chat.send RPC timeout'));
    }, 30000);

    pendingResponses.set(requestId, {
      resolve: (payload: any) => {
        clearTimeout(timeoutTimer);
        const runId = normalizedRunId(payload?.runId);
        if (!runId) {
          failPendingRunReservation(sessionKey, reservationRunId);
          reject(new Error(`chat.send response omitted its upstream run identity for ${sessionKey}`));
          return;
        }
        void persistDispatchThenAcknowledgeRunReservation(
          sessionKey,
          reservationRunId,
          runId,
          onProviderDispatchAccepted,
        ).then(() => {
          debugLog(`chat.send accepted: sessionKey=${sessionKey} runId=${runId}`);
          resolve({ runId });
        }, (error: unknown) => {
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      },
      reject: (err: Error) => {
        clearTimeout(timeoutTimer);
        failPendingRunReservation(sessionKey, reservationRunId);
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
      failPendingRunReservation(sessionKey, reservationRunId);
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

export async function steerSessionMessage(
  sessionKey: string,
  text: string,
  requestId = `legacy-steer-${nextId()}`,
): Promise<{ interruptedActiveRun: false; replayed: boolean; requestId: string }> {
  const expectedRunId = activeRunIds.get(sessionKey);
  if (!expectedRunId) {
    throw new PendingUserInputAnswerError(
      'NO_ACTIVE_RUN',
      'That OpenClaw run is no longer waiting for input.',
      404,
    );
  }
  const result = await steerActiveRun(
    sessionKey,
    expectedRunId,
    requestId,
    text,
  );
  return {
    interruptedActiveRun: false,
    replayed: result.replayed,
    requestId: result.requestId,
  };
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
export function registerRun(
  sessionKey: string,
  runId?: string,
  expectedRunId?: string | null,
): boolean {
  const key = String(sessionKey || '').trim();
  if (!key) return false;
  const nextRunId = normalizedRunId(runId);
  desiredSessionMessageSubscriptions.add(key);
  const trackedRunId = normalizedRunId(streamEventBus.getTrackedStream(key)?.runId) || null;
  const currentRunId = activeRunIds.get(key) || trackedRunId;
  let accepted = false;

  if (!nextRunId) {
    accepted = streamEventBus.startStream(key);
  } else if (currentRunId === nextRunId) {
    accepted = streamEventBus.startStream(key, nextRunId);
    if (accepted) activeRunIds.set(key, nextRunId);
  } else if (expectedRunId !== undefined) {
    const expected = expectedRunId === null ? null : normalizedRunId(expectedRunId);
    if (expected !== undefined && currentRunId === expected) {
      accepted = adoptActiveRun(key, expected, nextRunId, false);
    }
  } else if (currentRunId === null) {
    const tracked = streamEventBus.getTrackedStream(key);
    if (tracked) {
      accepted = adoptActiveRun(key, null, nextRunId, false);
    } else {
      accepted = streamEventBus.startStream(key, nextRunId);
      if (accepted) activeRunIds.set(key, nextRunId);
    }
  }

  if (accepted && isConnected()) {
    void subscribeGatewaySessionMessageNow(key);
  }
  return accepted;
}

/**
 * Clear the active run for a session.
 */
export function clearRun(sessionKey: string): void {
  clearPendingRunReservation(sessionKey);
  tombstoneRun(sessionKey, activeRunIds.get(sessionKey));
  activeRunIds.delete(sessionKey);
  pendingToolRunsBySession.delete(sessionKey);
  clearTextArbitration(sessionKey);
}

export const __persistentGatewayWsTest = {
  answerPendingUserInputWithRpc,
  dismissPendingUserInputWithRpc,
  readPendingUserInputWithRpc,
  steerActiveRunWithRpc,
  isCodexTurnCompletionUnconfirmedError,
  deferCodexIdleTimeoutError,
  completeIdleTimedOutTurnIfVisible,
  clearPendingCodexIdleTimeout,
  handleAgentEvent,
  handleChatEvent,
  handleSessionMessageEvent,
  reserveLogicalRun,
  acknowledgeRunReservation,
  persistDispatchThenAcknowledgeRunReservation,
  registerRun,
  shouldProcessTrackedSessionEvent,
  resetSession(sessionKey: string): void {
    clearPendingRunReservation(sessionKey);
    failedRunReservationsBySession.delete(sessionKey);
    clearPendingEmptyFinal(sessionKey);
    clearPendingCodexIdleTimeout(sessionKey);
    pendingToolRunsBySession.delete(sessionKey);
    streamEventBus.clearStream(sessionKey);
    activeRunIds.delete(sessionKey);
    desiredSessionMessageSubscriptions.delete(sessionKey);
    activeSessionMessageSubscriptions.delete(sessionKey);
    clearTextArbitration(sessionKey);
    messageToolReplyBySession.delete(sessionKey);
    runTombstonesBySession.delete(sessionKey);
  },
};
