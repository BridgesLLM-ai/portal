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
import { createHash } from 'crypto';
import { buildSignedDevice, getOrCreateDeviceKeys } from '../../utils/deviceIdentity';
import { getOpenClawWsUrl } from '../../config/openclaw';
import { streamEventBus, type StreamEvent } from '../../services/StreamEventBus';
import { sanitizeAssistantChunk, sanitizeAssistantText, isControlOnlyAssistantText } from '../../utils/chatText';
import { getGatewayToken } from '../../utils/gatewayToken';
import { redactNativeProviderText } from './native/NativeProviderDiagnostics';
import { sanitizeThinkingSubject } from '../../utils/thinkingSubject';
import { portalClientMessageIdFromIdempotencyKey } from './PortalMessageIdentity';

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
type PreambleProgressState = {
  runId?: string;
  order: string[];
  textByItem: Map<string, string>;
  textChars: number;
};

const MAX_PREAMBLE_PROGRESS_ITEMS = 64;
const MAX_PREAMBLE_PROGRESS_CHARS = 48 * 1024;
const PREAMBLE_PROGRESS_TRUNCATION_MARKER = '[Earlier progress truncated]\n';

/**
 * OpenClaw item.preamble frames are cumulative progress snapshots, not a stream
 * of thinking titles. Keep one growing text block per item identity. Treating
 * every appended tail as a new title turns tokenized Codex progress into
 * hundreds of durable thought cards and can crowd the real answer out of the
 * history window.
 */
const preambleProgressBySession: Map<string, PreambleProgressState> = new Map();

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
  sequence: number;
};

type PendingRunReservation = {
  reservationRunId: string;
  userIdempotencyKey?: string;
  frames: PendingRunFrame[];
  bytes: number;
};

const MAX_PENDING_RUN_FRAMES = 512;
const MAX_PENDING_RUN_BYTES = 2 * 1024 * 1024;
const pendingRunReservationsBySession = new Map<string, PendingRunReservation>();
const failedRunReservationsBySession = new Set<string>();
const failedRunReservationDetailsBySession = new Map<string, {
  reservationRunId: string;
  userIdempotencyKey: string;
}>();

type ReconnectRunRecovery = {
  predecessorRunId: string;
  originUserIdempotencyKey: string | null;
  disconnectedAt: number;
  probeWindowStartedAt: number;
  deadlineAt: number;
  probeAttempt: number;
  lastLiveRunIds: string[] | null;
  lastProbeAt: number;
  inactiveHistoryAttempts: number;
  probeInFlight: boolean;
  probeTimer: ReturnType<typeof setTimeout> | null;
};

const RECONNECT_RUN_RECOVERY_WINDOW_MS = 120_000;
const RECONNECT_RUN_PROBE_DELAYS_MS = [500, 1_500, 3_000, 5_000, 10_000, 15_000, 30_000];
const RECONNECT_RUN_LIVE_EVIDENCE_MAX_AGE_MS = 45_000;
const RECONNECT_INACTIVE_HISTORY_LIMIT = 1_000;
const RECONNECT_INACTIVE_HISTORY_MAX_ATTEMPTS = 3;
const RECONNECT_INACTIVE_HISTORY_RETRY_MS = 2_000;
const reconnectRunRecoveryBySession = new Map<string, ReconnectRunRecovery>();
const runOriginUserBySession = new Map<string, { runId: string; idempotencyKey: string }>();
const ambiguousRunReservationsBySession = new Map<string, string>();
type AmbiguousRunDispatch = {
  reservationRunId: string;
  expectedUserIdempotencyKey: string;
  correlatedRunId: string | null;
  settling: boolean;
  accept(upstreamRunId: string): Promise<void>;
  reject(error: Error): void;
};
const ambiguousRunDispatchesBySession = new Map<string, AmbiguousRunDispatch>();

type QuarantinedRunFrame = {
  kind: 'agent' | 'chat';
  payload: Record<string, unknown>;
  bytes: number;
  sequence: number;
};

type RunFrameQuarantine = {
  runId: string;
  createdAt: number;
  expiresAt: number;
  frames: QuarantinedRunFrame[];
  bytes: number;
  expiryTimer: ReturnType<typeof setTimeout>;
};

// Run-only frames cannot be attributed until OpenClaw supplies an exact
// run->session mapping. Keep a deliberately small, short-lived quarantine so
// restart recovery can replay early R2 reasoning/tool frames without ever
// guessing which subscribed session owns them.
const RUN_FRAME_QUARANTINE_TTL_MS = 30_000;
const MAX_QUARANTINED_RUNS = 16;
const MAX_QUARANTINED_FRAMES_PER_RUN = 256;
const MAX_QUARANTINED_BYTES_PER_RUN = 1024 * 1024;
const MAX_QUARANTINED_FRAMES_TOTAL = 512;
const MAX_QUARANTINED_BYTES_TOTAL = 2 * 1024 * 1024;
const quarantinedRunFramesByRunId = new Map<string, RunFrameQuarantine>();
let bufferedRunFrameSequence = 0;

// Adjacent live event lanes can expose the same delivery mirror more than once.
// Bound the dedupe cache so cross-channel prompts are forwarded once without
// turning a long-lived Portal process into an unbounded message ledger.
const seenUserMessageIdsBySession = new Map<string, Map<string, number>>();
const MAX_SEEN_USER_MESSAGE_IDS = 256;
const SEEN_USER_MESSAGE_TTL_MS = 6 * 60 * 60_000;
const lastHistoryChangedAtBySession = new Map<string, number>();
const HISTORY_CHANGED_MIN_INTERVAL_MS = 1_000;

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
  preambleProgressBySession.delete(sessionKey);
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
  dropQuarantinedRunFrames(normalizedRunId);
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

function dropQuarantinedRunFrames(runId: string): void {
  const quarantine = quarantinedRunFramesByRunId.get(runId);
  if (!quarantine) return;
  clearTimeout(quarantine.expiryTimer);
  quarantinedRunFramesByRunId.delete(runId);
}

function pruneQuarantinedRunFrames(now = Date.now()): void {
  for (const [runId, quarantine] of quarantinedRunFramesByRunId) {
    if (quarantine.expiresAt <= now) dropQuarantinedRunFrames(runId);
  }
}

function isRunTombstonedInAnyTrackedSession(runId: string): boolean {
  for (const sessionKey of runTombstonesBySession.keys()) {
    if (isRunTombstoned(sessionKey, runId)) return true;
  }
  return false;
}

function hasUnresolvedRunMappingWindow(): boolean {
  return reconnectRunRecoveryBySession.size > 0
    || pendingRunReservationsBySession.size > 0
    || failedRunReservationsBySession.size > 0
    || ambiguousRunDispatchesBySession.size > 0
    || desiredSessionMessageSubscriptions.size > 0
    || activeSessionMessageSubscriptions.size > 0;
}

function quarantineUnresolvedRunFrame(
  kind: QuarantinedRunFrame['kind'],
  runIdValue: unknown,
  payload: Record<string, unknown>,
): boolean {
  const runId = normalizedRunId(runIdValue);
  if (!runId) return false;
  if (isRunTombstonedInAnyTrackedSession(runId)) {
    debugLog(`Dropping run-only ${kind} frame for tombstoned runId=${runId}`);
    return true;
  }
  if (!hasUnresolvedRunMappingWindow()) return false;

  const now = Date.now();
  pruneQuarantinedRunFrames(now);

  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    debugLog(`Dropping unserializable run-only ${kind} frame for runId=${runId}`);
    return true;
  }
  if (bytes > MAX_QUARANTINED_BYTES_PER_RUN || bytes > MAX_QUARANTINED_BYTES_TOTAL) {
    debugLog(`Dropping oversized run-only ${kind} frame for runId=${runId}`);
    return true;
  }

  let quarantine = quarantinedRunFramesByRunId.get(runId);
  if (!quarantine) {
    if (quarantinedRunFramesByRunId.size >= MAX_QUARANTINED_RUNS) {
      debugLog(`Dropping run-only ${kind} frame outside run quarantine count bound for runId=${runId}`);
      return true;
    }
    const expiresAt = now + RUN_FRAME_QUARANTINE_TTL_MS;
    const expiryTimer = setTimeout(() => {
      const current = quarantinedRunFramesByRunId.get(runId);
      if (current?.expiresAt === expiresAt) quarantinedRunFramesByRunId.delete(runId);
    }, RUN_FRAME_QUARANTINE_TTL_MS);
    expiryTimer.unref?.();
    quarantine = {
      runId,
      createdAt: now,
      expiresAt,
      frames: [],
      bytes: 0,
      expiryTimer,
    };
    quarantinedRunFramesByRunId.set(runId, quarantine);
  }

  let totalFrames = 0;
  let totalBytes = 0;
  for (const queued of quarantinedRunFramesByRunId.values()) {
    totalFrames += queued.frames.length;
    totalBytes += queued.bytes;
  }
  if (quarantine.frames.length >= MAX_QUARANTINED_FRAMES_PER_RUN
    || quarantine.bytes + bytes > MAX_QUARANTINED_BYTES_PER_RUN
    || totalFrames >= MAX_QUARANTINED_FRAMES_TOTAL
    || totalBytes + bytes > MAX_QUARANTINED_BYTES_TOTAL) {
    debugLog(`Dropping run-only ${kind} frame outside run quarantine bounds for runId=${runId}`);
    if (quarantine.frames.length === 0) dropQuarantinedRunFrames(runId);
    return true;
  }

  quarantine.frames.push({
    kind,
    payload,
    bytes,
    sequence: ++bufferedRunFrameSequence,
  });
  quarantine.bytes += bytes;
  return true;
}

function takeQuarantinedRunFrames(
  sessionKey: string,
  runIdValue: unknown,
): QuarantinedRunFrame[] {
  const runId = normalizedRunId(runIdValue);
  if (!runId) return [];
  pruneQuarantinedRunFrames();
  const quarantine = quarantinedRunFramesByRunId.get(runId);
  if (!quarantine) return [];
  if (activeRunIds.get(sessionKey) !== runId || isRunTombstoned(sessionKey, runId)) return [];

  // Delete before returning. Re-entrant event handling and repeated
  // authoritative probes can therefore never publish the same frame twice.
  clearTimeout(quarantine.expiryTimer);
  quarantinedRunFramesByRunId.delete(runId);
  return [...quarantine.frames].sort((left, right) => left.sequence - right.sequence);
}

function replayQuarantinedRunFrames(sessionKey: string, runIdValue: unknown): boolean {
  const frames = takeQuarantinedRunFrames(sessionKey, runIdValue);
  if (frames.length === 0) return false;
  for (const frame of frames) {
    if (frame.kind === 'agent') handleAgentEvent(frame.payload);
    else handleChatEvent(frame.payload);
  }
  return true;
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

function clearReconnectRunRecovery(sessionKey: string): void {
  const recovery = reconnectRunRecoveryBySession.get(sessionKey);
  if (recovery?.probeTimer) clearTimeout(recovery.probeTimer);
  reconnectRunRecoveryBySession.delete(sessionKey);
}

function beginReconnectRunRecovery(sessionKey: string, predecessorRunId: string): void {
  const existing = reconnectRunRecoveryBySession.get(sessionKey);
  if (existing?.predecessorRunId === predecessorRunId && existing.deadlineAt > Date.now()) return;
  clearReconnectRunRecovery(sessionKey);
  reconnectRunRecoveryBySession.set(sessionKey, {
    predecessorRunId,
    originUserIdempotencyKey: runOriginUserBySession.get(sessionKey)?.runId === predecessorRunId
      ? runOriginUserBySession.get(sessionKey)!.idempotencyKey
      : null,
    disconnectedAt: Date.now(),
    probeWindowStartedAt: 0,
    deadlineAt: Date.now() + RECONNECT_RUN_RECOVERY_WINDOW_MS,
    probeAttempt: 0,
    lastLiveRunIds: null,
    lastProbeAt: 0,
    inactiveHistoryAttempts: 0,
    probeInFlight: false,
    probeTimer: null,
  });
}

function armReconnectRunRecoveryAfterAuthentication(sessionKey: string): void {
  const recovery = reconnectRunRecoveryBySession.get(sessionKey);
  if (!recovery) return;
  const now = Date.now();
  recovery.probeWindowStartedAt = now;
  recovery.deadlineAt = now + RECONNECT_RUN_RECOVERY_WINDOW_MS;
  recovery.probeAttempt = 0;
  recovery.lastLiveRunIds = null;
  recovery.lastProbeAt = 0;
  recovery.inactiveHistoryAttempts = 0;
}

function adoptReconnectReplacementRun(
  sessionKey: string,
  predecessorRunId: string,
  replacementRunId: string,
  replayQuarantine = true,
): boolean {
  const recovery = reconnectRunRecoveryBySession.get(sessionKey);
  if (!recovery
    || ambiguousRunDispatchesBySession.has(sessionKey)
    || recovery.predecessorRunId !== predecessorRunId
    || recovery.deadlineAt <= Date.now()
    || activeRunIds.get(sessionKey) !== predecessorRunId) {
    return false;
  }
  if (!adoptActiveRun(sessionKey, predecessorRunId, replacementRunId, true)) return false;
  clearReconnectRunRecovery(sessionKey);
  if (replayQuarantine) replayQuarantinedRunFrames(sessionKey, replacementRunId);
  debugLog(`Adopted gateway-restart replacement run for ${sessionKey}: ${predecessorRunId} -> ${replacementRunId}`);
  return true;
}

function tryAdoptReconnectRunFromTrustedEvent(
  sessionKey: string,
  expectedRunId: string,
  eventRunId: string,
  replayQuarantine = true,
): boolean {
  if (!eventRunId || eventRunId === expectedRunId || isRunTombstoned(sessionKey, eventRunId)) return false;
  return adoptReconnectReplacementRun(
    sessionKey,
    expectedRunId,
    eventRunId,
    replayQuarantine,
  );
}

function exactSessionRowsFromListPayload(payload: any, agentId: string): any[] {
  if (Array.isArray(payload?.sessions)) return payload.sessions;
  const requested = payload?.agents?.[agentId]?.sessions;
  if (Array.isArray(requested)) return requested;
  if (!payload?.agents || typeof payload.agents !== 'object') return [];
  return Object.values(payload.agents).flatMap((agent: any) => (
    Array.isArray(agent?.sessions) ? agent.sessions : []
  ));
}

function liveRunIdsFromSessionList(payload: any, sessionKey: string): string[] | null {
  const agentId = sessionKey.startsWith('agent:') ? sessionKey.split(':')[1] : 'portal';
  const rows = exactSessionRowsFromListPayload(payload, agentId)
    .filter((candidate: any) => candidate?.key === sessionKey);
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (Array.isArray(row.activeRunIds)) {
    const runIds = [...new Set(row.activeRunIds.map(normalizedRunId).filter(Boolean))] as string[];
    if (row.hasActiveRun === false) return runIds.length === 0 ? [] : null;
    return row.hasActiveRun === true && runIds.length > 0 ? runIds : null;
  }
  if (row.hasActiveRun === false) return [];
  // `hasActiveRun: true` without identities cannot safely authorize a CAS.
  return null;
}

function reconcileAuthoritativeLiveRun(sessionKey: string, liveRunId: string): boolean {
  const exactRunId = normalizedRunId(liveRunId);
  if (!exactRunId
    || ambiguousRunDispatchesBySession.has(sessionKey)
    || isRunTombstoned(sessionKey, exactRunId)) return false;

  if (failedRunReservationsBySession.has(sessionKey)) {
    const failed = failedRunReservationDetailsBySession.get(sessionKey);
    if (exactRunId === failed?.reservationRunId) return false;
    // sessions.list supplied one exact live identity after resubscription. It
    // may be a Discord/Web UI turn whose user mirror was missed during the
    // outage. Admit it as an independent run without correlating it to, or
    // resurrecting, the failed Portal dispatch.
    failedRunReservationsBySession.delete(sessionKey);
    failedRunReservationDetailsBySession.delete(sessionKey);
  }

  const tracked = streamEventBus.getTrackedStream(sessionKey);
  const trackedRunId = normalizedRunId(tracked?.runId) || null;
  const currentRunId = activeRunIds.get(sessionKey) || trackedRunId;
  const ambiguousReservation = ambiguousRunReservationsBySession.get(sessionKey) || null;
  let accepted = false;
  let resumeAlreadyPublished = false;

  if (currentRunId === exactRunId) {
    accepted = registerRun(sessionKey, exactRunId);
  } else if (currentRunId) {
    const recovery = reconnectRunRecoveryBySession.get(sessionKey);
    if (recovery?.predecessorRunId === currentRunId) {
      accepted = adoptReconnectReplacementRun(sessionKey, currentRunId, exactRunId);
      resumeAlreadyPublished = accepted;
    } else if (ambiguousReservation === currentRunId || tracked?.active === false) {
      accepted = registerRun(sessionKey, exactRunId, currentRunId);
    }
  } else {
    accepted = registerRun(sessionKey, exactRunId);
  }
  if (!accepted) return false;

  clearPendingRunReservation(sessionKey);
  if (ambiguousReservation) {
    ambiguousRunReservationsBySession.delete(sessionKey);
    clearReconnectRunRecovery(sessionKey);
  }
  if (!resumeAlreadyPublished && (currentRunId !== exactRunId || ambiguousReservation)) {
    streamEventBus.publish(sessionKey, { type: 'run_resumed', content: '', runId: exactRunId });
  }
  replayQuarantinedRunFrames(sessionKey, exactRunId);
  return true;
}

async function reconcileSubscribedSessionLiveRun(sessionKey: string): Promise<void> {
  try {
    const agentId = sessionKey.startsWith('agent:') ? sessionKey.split(':')[1] : 'portal';
    const payload = await callGatewayRpc('sessions.list', {
      agentId,
      search: sessionKey,
      limit: 50,
    }, 10_000);
    const liveRunIds = liveRunIdsFromSessionList(payload, sessionKey);
    if (liveRunIds?.length === 1) {
      if (ambiguousRunDispatchesBySession.has(sessionKey)) {
        await tryFinalizeAmbiguousActiveRun(sessionKey, liveRunIds[0]);
      } else {
        reconcileAuthoritativeLiveRun(sessionKey, liveRunIds[0]);
      }
    }
  } catch (error: any) {
    debugLog(`Post-subscribe live-run reconciliation failed for ${sessionKey}: ${error?.message || error}`);
  }
}

function scheduleReconnectRunProbe(sessionKey: string, delayMs?: number): void {
  const recovery = reconnectRunRecoveryBySession.get(sessionKey);
  if (!recovery || recovery.probeInFlight || recovery.probeTimer) return;
  const delay = delayMs ?? RECONNECT_RUN_PROBE_DELAYS_MS[
    Math.min(recovery.probeAttempt, RECONNECT_RUN_PROBE_DELAYS_MS.length - 1)
  ];
  recovery.probeTimer = setTimeout(() => {
    recovery.probeTimer = null;
    void probeReconnectRun(sessionKey);
  }, delay);
  recovery.probeTimer.unref?.();
}

function reconcileReconnectRunProbeResult(
  sessionKey: string,
  liveRunIds: string[] | null,
): boolean {
  const recovery = reconnectRunRecoveryBySession.get(sessionKey);
  if (!recovery) return false;
  recovery.lastLiveRunIds = liveRunIds;
  recovery.lastProbeAt = Date.now();
  if (liveRunIds?.length !== 0) recovery.inactiveHistoryAttempts = 0;

  if (liveRunIds?.length === 1) {
    const [liveRunId] = liveRunIds;
    if (liveRunId !== recovery.predecessorRunId) {
      return adoptReconnectReplacementRun(sessionKey, recovery.predecessorRunId, liveRunId);
    }
    // Seeing the predecessor again does not prove restart recovery is over.
    // OpenClaw can expose R1 immediately after reconnect and create R2 several
    // seconds later. Keep the exact CAS fence for the full bounded window so
    // that delayed replacement remains admissible.
    return false;
  }
  if (liveRunIds && liveRunIds.length > 1) {
    streamEventBus.publish(sessionKey, {
      type: 'status',
      content: 'OpenClaw reconnected, but multiple active runs need to settle before the Portal can safely reattach.',
      runId: recovery.predecessorRunId,
    });
  }
  return false;
}

function findHistoryOriginUserIndex(messages: any[], expectedKey: string): number {
  if (!expectedKey) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = typeof messages[index]?.role === 'string' ? messages[index].role.trim().toLowerCase() : '';
    if (role === 'user'
      && normalizedUserIdempotencyKey(messages[index]?.idempotencyKey) === expectedKey) {
      return index;
    }
  }
  return -1;
}

function nextDistinctHistoryTurnOriginIndex(
  messages: any[],
  userIndex: number,
  expectedKey: string,
  runId?: string,
): number {
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    const role = typeof message?.role === 'string' ? message.role.trim().toLowerCase() : '';
    if (role !== 'user') continue;
    const observedKey = normalizedUserIdempotencyKey(message?.idempotencyKey);
    if (observedKey && observedKey === expectedKey) continue;
    // Steering/injection can add another user-shaped row inside the same run.
    // Explicit same-run metadata keeps it inside the correlated turn; a
    // different or missing durable origin key without that proof starts the
    // next turn. Treating an unkeyed cross-channel prompt as part of the
    // Portal-originated turn can misattribute its assistant reply and settle
    // the wrong dispatch.
    if (runId && explicitGatewayMessageRunId(message) === runId) continue;
    return index;
  }
  return messages.length;
}

function durableAssistantTextAfter(
  messages: any[],
  userIndex: number,
  runId?: string,
  expectedOriginKey = '',
): string {
  const upperBound = expectedOriginKey
    ? nextDistinctHistoryTurnOriginIndex(messages, userIndex, expectedOriginKey, runId)
    : messages.length;
  for (let index = upperBound - 1; index > userIndex; index -= 1) {
    const message = messages[index];
    const role = typeof message?.role === 'string' ? message.role.trim().toLowerCase() : '';
    if (role !== 'assistant' || isReasoningMirrorMessage(message)) continue;
    const explicitRunId = explicitGatewayMessageRunId(message);
    if (runId && explicitRunId && explicitRunId !== runId) continue;
    const text = extractTextFromContent(message?.content ?? message?.text ?? '').trim();
    if (!text || isControlOnlyAssistantText(text) || messageContainsToolCall(message)) continue;
    return text;
  }
  return '';
}

function correlateRecoveryHistory(
  messages: any[],
  recovery: ReconnectRunRecovery,
): { matched: boolean; userIndex: number; finalText: string } {
  const expectedKey = normalizedUserIdempotencyKey(recovery.originUserIdempotencyKey);
  const originUserIndex = findHistoryOriginUserIndex(messages, expectedKey);
  if (originUserIndex >= 0) {
    return {
      matched: true,
      userIndex: originUserIndex,
      finalText: durableAssistantTextAfter(
        messages,
        originUserIndex,
        recovery.predecessorRunId,
        expectedKey,
      ),
    };
  }

  // Compatibility fallback for an already-active run that predates origin-key
  // tracking: accept only an assistant row carrying the exact run identity,
  // never a nearby untagged response from a later turn.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = typeof message?.role === 'string' ? message.role.trim().toLowerCase() : '';
    if (role !== 'assistant'
      || explicitGatewayMessageRunId(message) !== recovery.predecessorRunId
      || isReasoningMirrorMessage(message)
      || messageContainsToolCall(message)) continue;
    const text = extractTextFromContent(message?.content ?? message?.text ?? '').trim();
    if (!text || isControlOnlyAssistantText(text)) continue;
    return { matched: true, userIndex: Math.max(-1, index - 1), finalText: text };
  }
  return { matched: false, userIndex: -1, finalText: '' };
}

async function reconcileInactiveReconnectHistory(
  sessionKey: string,
  recovery: ReconnectRunRecovery,
  payload: any,
): Promise<boolean> {
  if (reconnectRunRecoveryBySession.get(sessionKey) !== recovery) return false;
  const messages = Array.isArray(payload?.messages)
    ? payload.messages
    : Array.isArray(payload?.history?.messages)
      ? payload.history.messages
      : null;
  if (!messages) return false;
  let settledRunId = recovery.predecessorRunId;
  let durableFinal = '';
  const ambiguousDispatch = ambiguousRunDispatchesBySession.get(sessionKey);
  if (ambiguousDispatch) {
    const correlation = correlateAmbiguousDispatchFromHistory(sessionKey, payload);
    if (!correlation.matched) return false;
    durableFinal = durableAssistantTextAfter(
      messages,
      correlation.userIndex,
      correlation.runId || undefined,
      normalizedUserIdempotencyKey(ambiguousDispatch.expectedUserIdempotencyKey),
    );
    if (!correlation.runId) {
      rejectAmbiguousRunDispatch(
        sessionKey,
        new Error('The interrupted dispatch was recorded, but OpenClaw did not preserve its run identity.'),
      );
      publishFatalRunError(
        sessionKey,
        'OpenClaw recorded the interrupted request without a verifiable run identity. The transcript was refreshed; retry the message if needed.',
        recovery.predecessorRunId,
      );
      return true;
    }
    if (!await finalizeAmbiguousRunDispatch(sessionKey, correlation.runId)) return false;
    settledRunId = correlation.runId;
  } else {
    const correlation = correlateRecoveryHistory(messages, recovery);
    if (!correlation.matched) return false;
    durableFinal = correlation.finalText;
  }

  streamEventBus.publish(sessionKey, {
    type: 'history_changed',
    content: '',
    reason: 'reconnect-inactive-history-reconciled',
  });
  if (durableFinal) {
    publishTextIfNew(sessionKey, durableFinal, settledRunId);
    streamEventBus.publish(sessionKey, {
      type: 'done',
      content: durableFinal,
      runId: settledRunId,
    });
    cleanupCompletedRun(sessionKey, settledRunId);
  } else {
    publishFatalRunError(
      sessionKey,
      'OpenClaw confirmed the interrupted turn is no longer running, but no final response was recorded. The transcript was refreshed and you can try again.',
      settledRunId,
    );
  }
  return true;
}

function extendUnresolvedReconnectRecovery(sessionKey: string, recovery: ReconnectRunRecovery): void {
  if (reconnectRunRecoveryBySession.get(sessionKey) !== recovery) return;
  recovery.deadlineAt = Date.now() + RECONNECT_RUN_RECOVERY_WINDOW_MS;
  recovery.probeAttempt = 0;
  streamEventBus.publish(sessionKey, {
    type: 'status',
    content: 'The Portal is still verifying the interrupted turn; new messages remain safely queued.',
    runId: recovery.predecessorRunId,
  });
  scheduleReconnectRunProbe(sessionKey, 5_000);
}

function retryExactInactiveHistoryRecovery(sessionKey: string, recovery: ReconnectRunRecovery): void {
  if (reconnectRunRecoveryBySession.get(sessionKey) !== recovery) return;
  recovery.deadlineAt = Date.now() + RECONNECT_INACTIVE_HISTORY_RETRY_MS;
  recovery.probeAttempt = 0;
  streamEventBus.publish(sessionKey, {
    type: 'status',
    content: 'OpenClaw reports the interrupted turn has stopped; the Portal is refreshing its final history before releasing the chat.',
    runId: recovery.predecessorRunId,
  });
  scheduleReconnectRunProbe(sessionKey, RECONNECT_INACTIVE_HISTORY_RETRY_MS);
}

function terminateExactInactiveRecovery(sessionKey: string, recovery: ReconnectRunRecovery): void {
  if (reconnectRunRecoveryBySession.get(sessionKey) !== recovery) return;
  streamEventBus.publish(sessionKey, {
    type: 'history_changed',
    content: '',
    reason: 'reconnect-inactive-history-exhausted',
  });
  const terminalError = new Error(
    'OpenClaw confirmed the interrupted dispatch is no longer active, but its origin could not be verified in durable history.',
  );
  try {
    rejectAmbiguousRunDispatch(sessionKey, terminalError);
  } catch (error: any) {
    debugLog(`Reconnect inactive dispatch rejection callback failed for ${sessionKey}: ${error?.message || error}`);
  }
  publishFatalRunError(
    sessionKey,
    'OpenClaw confirmed the interrupted turn is no longer running, but the Portal could not verify its final response after repeated history refreshes. The transcript was refreshed and you can try again.',
    recovery.predecessorRunId,
  );
}

type ReconnectHistoryReader = (sessionKey: string, limit: number) => Promise<any>;

const readReconnectHistory: ReconnectHistoryReader = (sessionKey, limit) => callGatewayRpc(
  'chat.history',
  { sessionKey, limit },
  10_000,
);

async function settleExpiredReconnectRunRecovery(
  sessionKey: string,
  recovery: ReconnectRunRecovery,
  historyReader: ReconnectHistoryReader = readReconnectHistory,
): Promise<void> {
  if (reconnectRunRecoveryBySession.get(sessionKey) !== recovery) return;
  const predecessorRunId = recovery.predecessorRunId;
  if (activeRunIds.get(sessionKey) !== predecessorRunId) {
    clearReconnectRunRecovery(sessionKey);
    return;
  }
  // An exact, authoritative sessions.list observation that R1 itself remains
  // live means no identity adoption is needed. At the end of the bounded
  // window, stop accepting replacements but leave that still-live run intact.
  if (recovery.lastLiveRunIds?.length === 1
    && recovery.lastLiveRunIds[0] === predecessorRunId
    && recovery.lastProbeAt > 0
    && Date.now() - recovery.lastProbeAt <= RECONNECT_RUN_LIVE_EVIDENCE_MAX_AGE_MS) {
    clearReconnectRunRecovery(sessionKey);
    streamEventBus.publish(sessionKey, {
      type: 'status',
      content: 'Reconnected to the active turn.',
      runId: predecessorRunId,
    });
    return;
  }
  const hasRecentExactInactive = recovery.lastLiveRunIds?.length === 0
    && recovery.lastProbeAt > 0
    && Date.now() - recovery.lastProbeAt <= RECONNECT_RUN_LIVE_EVIDENCE_MAX_AGE_MS;
  if (hasRecentExactInactive) {
    recovery.inactiveHistoryAttempts += 1;
    try {
      const history = await historyReader(sessionKey, RECONNECT_INACTIVE_HISTORY_LIMIT);
      if (await reconcileInactiveReconnectHistory(sessionKey, recovery, history)) return;
    } catch (error: any) {
      debugLog(`Reconnect history reconciliation failed for ${sessionKey}: ${error?.message || error}`);
    }
    if (reconnectRunRecoveryBySession.get(sessionKey) !== recovery) return;
    if (recovery.inactiveHistoryAttempts >= RECONNECT_INACTIVE_HISTORY_MAX_ATTEMPTS) {
      terminateExactInactiveRecovery(sessionKey, recovery);
      return;
    }
    retryExactInactiveHistoryRecovery(sessionKey, recovery);
    return;
  }
  // Missing identities, multiple identities, RPC failures, and stale probes are
  // uncertainty—not proof of a terminal. Keep the lane fail-closed and retry.
  extendUnresolvedReconnectRecovery(sessionKey, recovery);
}

async function probeReconnectRun(sessionKey: string): Promise<void> {
  const recovery = reconnectRunRecoveryBySession.get(sessionKey);
  if (!recovery || recovery.probeInFlight) return;
  if (recovery.deadlineAt <= Date.now()) {
    await settleExpiredReconnectRunRecovery(sessionKey, recovery);
    return;
  }

  recovery.probeInFlight = true;
  recovery.probeAttempt += 1;
  try {
    const agentId = sessionKey.startsWith('agent:') ? sessionKey.split(':')[1] : 'portal';
    const payload = await callGatewayRpc('sessions.list', {
      agentId,
      search: sessionKey,
      limit: 50,
    }, 10_000);
    const current = reconnectRunRecoveryBySession.get(sessionKey);
    if (current !== recovery) return;
    const liveRunIds = liveRunIdsFromSessionList(payload, sessionKey);
    if (liveRunIds?.length === 1 && ambiguousRunDispatchesBySession.has(sessionKey)) {
      await tryFinalizeAmbiguousActiveRun(sessionKey, liveRunIds[0]);
    } else {
      reconcileReconnectRunProbeResult(sessionKey, liveRunIds);
    }
  } catch (error: any) {
    debugLog(`Reconnect run probe failed for ${sessionKey}: ${error?.message || error}`);
  } finally {
    const current = reconnectRunRecoveryBySession.get(sessionKey);
    if (current === recovery) {
      recovery.probeInFlight = false;
      scheduleReconnectRunProbe(sessionKey);
    }
  }
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

  pending.frames.push({
    kind,
    runId,
    payload,
    bytes,
    sequence: ++bufferedRunFrameSequence,
  });
  pending.bytes += bytes;
  return true;
}

function clearPendingRunReservation(sessionKey: string, reservationRunId?: string): void {
  const pending = pendingRunReservationsBySession.get(sessionKey);
  if (!pending) return;
  if (reservationRunId && pending.reservationRunId !== reservationRunId) return;
  pendingRunReservationsBySession.delete(sessionKey);
}

function setPendingRunUserIdempotency(
  sessionKey: string,
  reservationRunId: string,
  idempotencyKey: unknown,
): void {
  const pending = pendingRunReservationsBySession.get(sessionKey);
  const normalized = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
  if (!pending || pending.reservationRunId !== reservationRunId || !normalized) return;
  pending.userIdempotencyKey = normalized;
}

function rememberRunOriginUser(
  sessionKey: string,
  runId: string,
  idempotencyKey: unknown,
): void {
  const normalizedKey = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
  if (!normalizedKey) return;
  runOriginUserBySession.set(sessionKey, { runId, idempotencyKey: normalizedKey });
}

export function failPendingRunReservation(sessionKey: string, reservationRunId: string): void {
  const pending = pendingRunReservationsBySession.get(sessionKey);
  if (!pending || pending.reservationRunId !== reservationRunId) return;
  pendingRunReservationsBySession.delete(sessionKey);
  ambiguousRunDispatchesBySession.delete(sessionKey);
  ambiguousRunReservationsBySession.delete(sessionKey);
  failedRunReservationsBySession.add(sessionKey);
  failedRunReservationDetailsBySession.set(sessionKey, {
    reservationRunId,
    userIdempotencyKey: normalizedUserIdempotencyKey(pending.userIdempotencyKey),
  });
  tombstoneRun(sessionKey, reservationRunId);
  if (activeRunIds.get(sessionKey) === reservationRunId) activeRunIds.delete(sessionKey);
  streamEventBus.clearStream(sessionKey, reservationRunId);
}

function rejectAmbiguousRunDispatch(sessionKey: string, error: Error): void {
  const dispatch = ambiguousRunDispatchesBySession.get(sessionKey);
  if (!dispatch) return;
  ambiguousRunDispatchesBySession.delete(sessionKey);
  ambiguousRunReservationsBySession.delete(sessionKey);
  clearPendingRunReservation(sessionKey, dispatch.reservationRunId);
  dispatch.reject(error);
}

function markAmbiguousRunReservation(sessionKey: string, reservationRunId: string): void {
  failedRunReservationsBySession.delete(sessionKey);
  failedRunReservationDetailsBySession.delete(sessionKey);
  ambiguousRunReservationsBySession.set(sessionKey, reservationRunId);
  // Preserve the reservation as a CAS predecessor. The request may have
  // reached OpenClaw even though its acknowledgement was lost with the socket.
  beginReconnectRunRecovery(sessionKey, reservationRunId);
  if (isConnected()) scheduleReconnectRunProbe(sessionKey, 250);
}

function parkAmbiguousRunDispatch(
  sessionKey: string,
  reservationRunId: string,
  dispatch: Omit<AmbiguousRunDispatch, 'reservationRunId' | 'correlatedRunId' | 'settling'>,
): void {
  markAmbiguousRunReservation(sessionKey, reservationRunId);
  setPendingRunUserIdempotency(sessionKey, reservationRunId, dispatch.expectedUserIdempotencyKey);
  const existing = ambiguousRunDispatchesBySession.get(sessionKey);
  if (existing?.reservationRunId === reservationRunId) return;
  ambiguousRunDispatchesBySession.set(sessionKey, {
    reservationRunId,
    correlatedRunId: null,
    settling: false,
    ...dispatch,
  });
}

/**
 * Preserve a chat.send reservation whose frame may have reached OpenClaw but
 * whose acknowledgement was lost on another transport (for example the
 * browser direct-proxy socket). The singleton gateway lane remains the
 * recovery authority and will adopt only a run correlated to this exact
 * idempotency key.
 */
export function parkUnconfirmedRunReservation(
  sessionKey: string,
  reservationRunId: string,
  expectedUserIdempotencyKey: string,
): boolean {
  const pending = pendingRunReservationsBySession.get(sessionKey);
  if (!pending || pending.reservationRunId !== reservationRunId) return false;
  parkAmbiguousRunDispatch(sessionKey, reservationRunId, {
    expectedUserIdempotencyKey,
    accept: async (runId: string) => {
      if (!acknowledgeRunReservation(sessionKey, reservationRunId, runId)) {
        throw new Error(`Stale recovered chat.send response ignored for ${sessionKey}`);
      }
    },
    // Terminal reconciliation publishes the user-facing error/history signal.
    // A detached direct-proxy request has no response promise left to reject.
    reject: (error: Error) => {
      debugLog(`Detached direct chat.send recovery settled for ${sessionKey}: ${error.message}`);
    },
  });
  return true;
}

function normalizedUserIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.endsWith(':user') ? normalized.slice(0, -':user'.length) : normalized;
}

function explicitGatewayMessageRunId(message: any): string | undefined {
  return [
    message?.runId,
    message?.__openclaw?.runId,
    message?.metadata?.runId,
    message?.metadata?.__openclaw?.runId,
  ].map(normalizedRunId).find(Boolean);
}

function correlateAmbiguousDispatchFromUserMessage(
  sessionKey: string,
  message: any,
  exactActiveRunId?: string,
): boolean {
  const dispatch = ambiguousRunDispatchesBySession.get(sessionKey);
  if (!dispatch) return false;
  const expectedKey = normalizedUserIdempotencyKey(dispatch.expectedUserIdempotencyKey);
  const observedKey = normalizedUserIdempotencyKey(message?.idempotencyKey);
  if (!expectedKey || observedKey !== expectedKey) return false;
  const correlatedRunId = normalizedRunId(exactActiveRunId) || explicitGatewayMessageRunId(message);
  if (!correlatedRunId || isRunTombstoned(sessionKey, correlatedRunId)) return false;
  dispatch.correlatedRunId = correlatedRunId;
  return true;
}

function correlateAmbiguousDispatchFromHistory(
  sessionKey: string,
  payload: any,
  exactActiveRunId?: string,
): { matched: boolean; userIndex: number; runId: string | null; messages: any[] | null } {
  const dispatch = ambiguousRunDispatchesBySession.get(sessionKey);
  const messages = Array.isArray(payload?.messages)
    ? payload.messages
    : Array.isArray(payload?.history?.messages)
      ? payload.history.messages
      : null;
  if (!dispatch || !messages) return { matched: false, userIndex: -1, runId: null, messages };
  const expectedKey = normalizedUserIdempotencyKey(dispatch.expectedUserIdempotencyKey);
  const originUserIndex = findHistoryOriginUserIndex(messages, expectedKey);
  if (originUserIndex < 0) return { matched: false, userIndex: -1, runId: null, messages };
  const userMessage = messages[originUserIndex];

  let correlatedRunId = explicitGatewayMessageRunId(userMessage) || dispatch.correlatedRunId;
  const boundary = nextDistinctHistoryTurnOriginIndex(
    messages,
    originUserIndex,
    expectedKey,
    correlatedRunId || normalizedRunId(exactActiveRunId),
  );
  for (let index = originUserIndex + 1; index < boundary && !correlatedRunId; index += 1) {
    correlatedRunId = explicitGatewayMessageRunId(messages[index]) || null;
  }
  if (!correlatedRunId) correlatedRunId = normalizedRunId(exactActiveRunId) || null;
  if (correlatedRunId && !isRunTombstoned(sessionKey, correlatedRunId)) {
    dispatch.correlatedRunId = correlatedRunId;
  }
  return { matched: true, userIndex: originUserIndex, runId: correlatedRunId, messages };
}

async function tryFinalizeAmbiguousActiveRun(sessionKey: string, liveRunId: string): Promise<boolean> {
  const dispatch = ambiguousRunDispatchesBySession.get(sessionKey);
  if (!dispatch) return false;
  if (dispatch.correlatedRunId === liveRunId) {
    return finalizeAmbiguousRunDispatch(sessionKey, liveRunId);
  }
  try {
    const history = await callGatewayRpc(
      'chat.history',
      { sessionKey, limit: RECONNECT_INACTIVE_HISTORY_LIMIT },
      10_000,
    );
    const correlation = correlateAmbiguousDispatchFromHistory(sessionKey, history, liveRunId);
    if (!correlation.matched || correlation.runId !== liveRunId) return false;
    return finalizeAmbiguousRunDispatch(sessionKey, liveRunId);
  } catch (error: any) {
    debugLog(`Ambiguous dispatch correlation failed for ${sessionKey}: ${error?.message || error}`);
    return false;
  }
}

async function finalizeAmbiguousRunDispatch(
  sessionKey: string,
  upstreamRunId: string,
): Promise<boolean> {
  const dispatch = ambiguousRunDispatchesBySession.get(sessionKey);
  const exactRunId = normalizedRunId(upstreamRunId);
  if (!dispatch || dispatch.settling || !exactRunId || isRunTombstoned(sessionKey, exactRunId)) {
    return false;
  }
  if (dispatch.correlatedRunId !== exactRunId) return false;
  const pending = pendingRunReservationsBySession.get(sessionKey);
  if (!pending || pending.reservationRunId !== dispatch.reservationRunId) return false;

  dispatch.settling = true;
  try {
    await dispatch.accept(exactRunId);
    ambiguousRunDispatchesBySession.delete(sessionKey);
    ambiguousRunReservationsBySession.delete(sessionKey);
    clearReconnectRunRecovery(sessionKey);
    return true;
  } catch (error: any) {
    ambiguousRunDispatchesBySession.delete(sessionKey);
    ambiguousRunReservationsBySession.delete(sessionKey);
    dispatch.reject(error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

function adoptActiveRun(
  sessionKey: string,
  expectedRunId: string | null,
  runId: string,
  publishResume: boolean,
): boolean {
  const nextRunId = normalizedRunId(runId);
  // Every run-identity transition funnels through this CAS boundary. A stale
  // sessions.list row must not be able to resurrect a run that already
  // reached a terminal state, even when the adoption came from a reconnect
  // probe instead of a live event.
  if (!nextRunId || isRunTombstoned(sessionKey, nextRunId)) return false;

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
  const priorOrigin = runOriginUserBySession.get(sessionKey);
  if (priorOrigin?.runId === previousRunId) {
    runOriginUserBySession.set(sessionKey, { ...priorOrigin, runId: nextRunId });
  }
  if (ambiguousRunReservationsBySession.get(sessionKey) === previousRunId) {
    ambiguousRunReservationsBySession.delete(sessionKey);
  }
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
  clearReconnectRunRecovery(sessionKey);
  ambiguousRunReservationsBySession.delete(sessionKey);
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
  clearReconnectRunRecovery(sessionKey);
  ambiguousRunReservationsBySession.delete(sessionKey);
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

function buildApprovalWaitStatusEvent(runId: string): StreamEvent {
  // Approval request bodies can contain host commands. They travel only on
  // the separately role-gated approval channel; the ordinary session stream
  // receives a body-free status rail update.
  return {
    type: 'status',
    content: '⏳ Waiting for command approval…',
    runId,
  };
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
  return sanitizeAssistantDelta(redactNativeProviderText(candidate));
}

function mergePreambleProgress(
  sessionKey: string,
  runId: string,
  data: Record<string, unknown>,
): string {
  const progressText = extractPreambleProgressText(data);
  if (!progressText) return '';

  let state = preambleProgressBySession.get(sessionKey);
  if (!state || (state.runId && state.runId !== runId)) {
    state = { runId, order: [], textByItem: new Map(), textChars: 0 };
    preambleProgressBySession.set(sessionKey, state);
  } else if (!state.runId) {
    state.runId = runId;
  }

  const rawItemId = data.itemId ?? data.item_id ?? data.id;
  const itemId = typeof rawItemId === 'string' && rawItemId.trim()
    ? rawItemId.trim()
    : '__current__';
  if (!state.textByItem.has(itemId)) state.order.push(itemId);
  state.textChars -= state.textByItem.get(itemId)?.length || 0;
  state.textByItem.set(itemId, progressText);
  state.textChars += progressText.length;

  const evictOldestItem = (): boolean => {
    const oldestId = state!.order.shift();
    if (!oldestId) return false;
    const oldestText = state!.textByItem.get(oldestId) || '';
    state!.textByItem.delete(oldestId);
    state!.textChars -= oldestText.length;
    return true;
  };
  const joinedLength = (): number => (
    state!.textChars + Math.max(0, state!.order.length - 1) * 2
  );

  while (state.order.length > MAX_PREAMBLE_PROGRESS_ITEMS) evictOldestItem();
  while (state.order.length > 1 && joinedLength() > MAX_PREAMBLE_PROGRESS_CHARS) {
    evictOldestItem();
  }
  if (state.order.length === 1 && joinedLength() > MAX_PREAMBLE_PROGRESS_CHARS) {
    const remainingId = state.order[0];
    const remainingText = state.textByItem.get(remainingId) || '';
    const suffixLength = Math.max(
      0,
      MAX_PREAMBLE_PROGRESS_CHARS - PREAMBLE_PROGRESS_TRUNCATION_MARKER.length,
    );
    const boundedText = `${PREAMBLE_PROGRESS_TRUNCATION_MARKER}${remainingText.slice(-suffixLength)}`;
    state.textByItem.set(remainingId, boundedText);
    state.textChars = boundedText.length;
  }

  return state.order
    .map((id) => state!.textByItem.get(id) || '')
    .filter(Boolean)
    .join('\n\n');
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
    if (quarantineUnresolvedRunFrame('agent', payload.runId, payload)) return;
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
    if (tryAdoptReconnectRunFromTrustedEvent(sessionKey, expectedRunId, runId)) {
      expectedRunId = runId;
    } else {
      debugLog(`Ignoring agent event for stale runId=${runId} (expected ${expectedRunId})`);
      return;
    }
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
    const cumulativeProgress = mergePreambleProgress(sessionKey, effectiveRunId, data);
    if (!cumulativeProgress) return;
    // The provider's thinking lane can remain cumulative across progress-item
    // boundaries. Freeze the raw reasoning represented before this preamble so
    // the next thinking snapshot emits only its new tail.
    thinkingSubjectBaselineMap.set(
      sessionKey,
      thinkingLastSeenTextMap.get(sessionKey) || '',
    );
    thinkingSubjectSegmentTextMap.set(sessionKey, '');
    const statusText = sanitizeThinkingSubject(extractPreambleProgressText(data));
    if (!hasRunningToolCall(sessionKey)) {
      streamEventBus.updateStreamPhase(sessionKey, {
        phase: 'thinking',
        runId: effectiveRunId,
        ...(statusText ? { statusText } : {}),
      });
    }
    streamEventBus.publish(sessionKey, {
      type: 'status',
      content: cumulativeProgress,
      replace: true,
      preambleProgress: true,
      runId: effectiveRunId,
    });
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
    // emit only new text. Claude CLI can keep private reasoning encrypted and
    // expose only a cumulative progress-token count; publish that count as an
    // honest replaceable status instead of making the live turn look dead.
    const snapshotText = typeof data.text === 'string' ? data.text : '';
    const chunkText = typeof data.delta === 'string'
      ? data.delta
      : (typeof data.content === 'string' ? data.content : '');
    const progressTokens = typeof data.progressTokens === 'number'
      && Number.isFinite(data.progressTokens)
      && data.progressTokens > 0
      ? Math.floor(data.progressTokens)
      : null;
    if (!snapshotText && !chunkText && progressTokens !== null) {
      const progressStatus = `Thinking… (~${progressTokens.toLocaleString('en-US')} tokens)`;
      if (!hasRunningToolCall(sessionKey)) {
        streamEventBus.updateStreamPhase(sessionKey, {
          phase: 'thinking',
          runId: effectiveRunId,
          statusText: progressStatus,
        });
        streamEventBus.publish(sessionKey, {
          type: 'status',
          content: progressStatus,
          runId: effectiveRunId,
          replace: true,
          transient: true,
        });
      }
      return;
    }
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

function sessionUserMessageIdentity(payload: Record<string, unknown>, message: any, text: string): string {
  const portalClientMessageId = portalClientMessageIdFromIdempotencyKey(message?.idempotencyKey);
  if (portalClientMessageId) return portalClientMessageId;
  const candidates = [
    message?.id,
    message?.messageId,
    payload.messageId,
    payload.id,
    message?.idempotencyKey,
    message?.__openclaw?.mirrorIdentity,
    message?.metadata?.__openclaw?.mirrorIdentity,
  ];
  const stable = candidates.find((value) => typeof value === 'string' && value.trim());
  if (typeof stable === 'string') {
    let normalized = stable.trim();
    if (normalized.endsWith(':user')) normalized = normalized.slice(0, -':user'.length);
    return normalized.slice(0, 512);
  }
  const timestamp = Number(message?.timestamp ?? payload.timestamp ?? payload.ts);
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 24);
  return `fallback:${Number.isFinite(timestamp) ? timestamp : Date.now()}:${digest}`;
}

function markUserMessageSeen(sessionKey: string, messageId: string): boolean {
  const now = Date.now();
  const seen = seenUserMessageIdsBySession.get(sessionKey) || new Map<string, number>();
  for (const [id, seenAt] of seen) {
    if (now - seenAt > SEEN_USER_MESSAGE_TTL_MS) seen.delete(id);
  }
  if (seen.has(messageId)) return false;
  seen.set(messageId, now);
  while (seen.size > MAX_SEEN_USER_MESSAGE_IDS) {
    const oldest = seen.keys().next().value;
    if (typeof oldest !== 'string') break;
    seen.delete(oldest);
  }
  seenUserMessageIdsBySession.set(sessionKey, seen);
  return true;
}

function publishSessionUserMessage(
  sessionKey: string,
  payload: Record<string, unknown>,
  message: any,
  text: string,
  currentRunId?: string,
  sourceRunId?: string,
): void {
  const messageId = sessionUserMessageIdentity(payload, message, text);
  if (!markUserMessageSeen(sessionKey, messageId)) return;
  const rawTimestamp = Number(message?.timestamp ?? payload.timestamp ?? payload.ts);
  const sourceChannel = typeof message?.sourceChannel === 'string' && message.sourceChannel.trim()
    ? message.sourceChannel.trim().slice(0, 64)
    : undefined;
  streamEventBus.publish(sessionKey, {
    type: 'user_message',
    content: text.slice(0, 100_000),
    messageId,
    messageTimestamp: Number.isFinite(rawTimestamp) && rawTimestamp > 0 ? rawTimestamp : Date.now(),
    ...(sourceChannel ? { sourceChannel } : {}),
    ...(currentRunId ? { runId: currentRunId } : {}),
    ...(sourceRunId && sourceRunId !== currentRunId ? { sourceRunId } : {}),
  });
}

function handleSessionMessageEvent(payload: Record<string, unknown> | undefined): void {
  if (!payload) return;
  const sessionKey = resolveSessionKeyForGatewayPayload(payload);
  if (!sessionKey) return;
  const message = payload.message && typeof payload.message === 'object' ? payload.message as any : null;
  if (!message) return;

  const snapshotActiveRunIds = Array.isArray(payload.activeRunIds)
    ? [...new Set(payload.activeRunIds.map(normalizedRunId).filter(Boolean))] as string[]
    : Array.isArray((payload.session as any)?.activeRunIds)
      ? [...new Set((payload.session as any).activeRunIds.map(normalizedRunId).filter(Boolean))] as string[]
      : null;
  const snapshotRunId = snapshotActiveRunIds?.length === 1 ? snapshotActiveRunIds[0] : undefined;
  const messageRunId = [
    payload.runId,
    message.runId,
    message.__openclaw?.runId,
    message.metadata?.runId,
    message.metadata?.__openclaw?.runId,
    snapshotRunId,
  ].find((value) => typeof value === 'string' && value.trim()) as string | undefined;
  const normalizedMessageRunId = messageRunId?.trim();
  const correlationRole = typeof message.role === 'string'
    ? message.role.trim().toLowerCase()
    : (typeof message.type === 'string' ? message.type.trim().toLowerCase() : '');
  if (correlationRole === 'user' && normalizedMessageRunId) {
    rememberRunOriginUser(sessionKey, normalizedMessageRunId, message.idempotencyKey);
    correlateAmbiguousDispatchFromUserMessage(sessionKey, message, normalizedMessageRunId);
  }
  let activeRunId = activeRunIds.get(sessionKey);
  const meta = (message.__openclaw && typeof message.__openclaw === 'object' ? message.__openclaw : null)
    || (message.metadata?.__openclaw && typeof message.metadata.__openclaw === 'object' ? message.metadata.__openclaw : null);
  const text = extractTextFromContent(message.content ?? message.text ?? '');
  const role = typeof message.role === 'string' ? message.role : (typeof message.type === 'string' ? message.type : '');
  const normalizedRole = role.trim().toLowerCase();
  const willPublishTrustedUserOrigin = normalizedRole === 'user'
    && Boolean(text)
    && !isControlOnlyAssistantText(text);
  if (failedRunReservationsBySession.has(sessionKey)) {
    const failed = failedRunReservationDetailsBySession.get(sessionKey);
    const observedKey = normalizedUserIdempotencyKey(message.idempotencyKey);
    const isNewTrustedUserOrigin = normalizedRole === 'user'
      && Boolean(normalizedMessageRunId)
      && normalizedMessageRunId !== failed?.reservationRunId
      && (!failed?.userIdempotencyKey || observedKey !== failed.userIdempotencyKey)
      && Boolean(text)
      && !isControlOnlyAssistantText(text);
    if (!isNewTrustedUserOrigin) return;

    // A definitive failed Portal reservation fences only its own late frames.
    // An exact newer user origin from OpenClaw (Discord/Web UI/etc.) starts a
    // different run and is allowed to heal the session-wide live lane.
    failedRunReservationsBySession.delete(sessionKey);
    failedRunReservationDetailsBySession.delete(sessionKey);
  }
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
  if (normalizedMessageRunId && isRunTombstoned(sessionKey, normalizedMessageRunId)) return;
  if (normalizedRole === 'user' && normalizedMessageRunId && !activeRunId) {
    const tracked = streamEventBus.getTrackedStream(sessionKey);
    const predecessorRunId = normalizedRunId(tracked?.runId) || null;
    const registered = tracked
      ? registerRun(sessionKey, normalizedMessageRunId, predecessorRunId)
      : registerRun(sessionKey, normalizedMessageRunId);
    if (registered) {
      activeRunId = normalizedMessageRunId;
      streamEventBus.publish(sessionKey, {
        type: 'run_resumed',
        content: '',
        runId: normalizedMessageRunId,
      });
    }
  }
  if (normalizedMessageRunId && activeRunId && normalizedMessageRunId !== activeRunId) {
    if (tryAdoptReconnectRunFromTrustedEvent(
      sessionKey,
      activeRunId,
      normalizedMessageRunId,
      !willPublishTrustedUserOrigin,
    )) {
      activeRunId = normalizedMessageRunId;
    } else {
      debugLog(`Ignoring stale session.message for ${sessionKey} runId=${normalizedMessageRunId} expected=${activeRunId || '-'}`);
      if (normalizedRole === 'user' && text && !isControlOnlyAssistantText(text)) {
        publishSessionUserMessage(sessionKey, payload, message, text, activeRunId, normalizedMessageRunId);
      }
      return;
    }
  }

  debugLog(`session.message event: session=${sessionKey} role=${role || '-'} textLen=${text.length} keys=${Object.keys(message).join(',')}`);

  if (willPublishTrustedUserOrigin) {
    publishSessionUserMessage(
      sessionKey,
      payload,
      message,
      text,
      activeRunId === normalizedMessageRunId ? activeRunId : undefined,
      normalizedMessageRunId,
    );
    if (normalizedMessageRunId && activeRunId === normalizedMessageRunId) {
      replayQuarantinedRunFrames(sessionKey, normalizedMessageRunId);
    }
    return;
  }

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
    if (quarantineUnresolvedRunFrame('chat', payload.runId, payload)) return;
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
    if (tryAdoptReconnectRunFromTrustedEvent(sessionKey, expectedRunId, runId)) {
      expectedRunId = runId;
    } else {
      debugLog(`Ignoring chat event state=${state} for stale runId=${runId} (expected ${expectedRunId})`);
      return;
    }
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
              armReconnectRunRecoveryAfterAuthentication(sessionKey);
              scheduleReconnectRunProbe(sessionKey);
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
          const errorMessage = msg.error?.message || 'RPC failed';
          const rpcError = new Error(errorMessage) as Error & {
            errorCode?: string;
            errorMessage?: string;
          };
          if (typeof msg.error?.code === 'string') rpcError.errorCode = msg.error.code;
          rpcError.errorMessage = errorMessage;
          pending.reject(rpcError);
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
        streamEventBus.publish(
          approval.request.sessionKey,
          buildApprovalWaitStatusEvent(approvalRunId),
        );
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

    for (const [sessionKey, runId] of activeSessionsSnapshot) {
      beginReconnectRunRecovery(sessionKey, runId);
      streamEventBus.publish(sessionKey, {
        type: 'status',
        content: 'Reconnecting to stream…',
        runId,
      });
    }

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
    await reconcileSubscribedSessionLiveRun(canonicalKey);
    // The subscription is live-only. A prompt sent through Discord or another
    // client while this upstream socket was down cannot be replayed here, so
    // tell the browser to perform one durable history merge after every
    // successful subscription/resubscription.
    const now = Date.now();
    const lastChangedAt = lastHistoryChangedAtBySession.get(canonicalKey) || 0;
    if (now - lastChangedAt >= HISTORY_CHANGED_MIN_INTERVAL_MS) {
      lastHistoryChangedAtBySession.set(canonicalKey, now);
      streamEventBus.publish(canonicalKey, {
        type: 'history_changed',
        content: '',
        reason: 'gateway-session-resubscribed',
      });
    }
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
  failedRunReservationDetailsBySession.delete(key);
  ambiguousRunReservationsBySession.delete(key);
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

  rememberRunOriginUser(sessionKey, upstreamRunId, pending.userIdempotencyKey);
  pendingRunReservationsBySession.delete(sessionKey);
  ambiguousRunReservationsBySession.delete(sessionKey);
  if (upstreamRunId !== reservationRunId) {
    streamEventBus.publish(sessionKey, { type: 'run_resumed', content: '', runId: upstreamRunId });
  }
  const replayFrames: Array<PendingRunFrame | QuarantinedRunFrame> = [
    ...pending.frames.filter((frame) => frame.runId === upstreamRunId),
    ...takeQuarantinedRunFrames(sessionKey, upstreamRunId),
  ].sort((left, right) => left.sequence - right.sequence);
  for (const frame of replayFrames) {
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
  if (runReservation) setPendingRunUserIdempotency(rpcSessionKey, runReservation, params.idempotencyKey);

  return new Promise((resolve, reject) => {
    const timeoutTimer = setTimeout(() => {
      pendingResponses.delete(requestId);
      if (runReservation) {
        parkAmbiguousRunDispatch(rpcSessionKey, runReservation, {
          expectedUserIdempotencyKey: typeof params.idempotencyKey === 'string' ? params.idempotencyKey : '',
          accept: async (runId: string) => {
            if (!acknowledgeRunReservation(rpcSessionKey, runReservation, runId)) {
              throw new Error(`Stale recovered chat.send response ignored for ${rpcSessionKey}`);
            }
            resolve({ runId, recoveredAfterDisconnect: true });
          },
          reject,
        });
      } else {
        reject(new Error(`${method} RPC timeout`));
      }
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
        if (runReservation) {
          if (/WebSocket connection closed|RPC timeout/i.test(err.message)) {
            parkAmbiguousRunDispatch(rpcSessionKey, runReservation, {
              expectedUserIdempotencyKey: typeof params.idempotencyKey === 'string' ? params.idempotencyKey : '',
              accept: async (runId: string) => {
                if (!acknowledgeRunReservation(rpcSessionKey, runReservation, runId)) {
                  throw new Error(`Stale recovered chat.send response ignored for ${rpcSessionKey}`);
                }
                resolve({ runId, recoveredAfterDisconnect: true });
              },
              reject,
            });
            return;
          } else {
            failPendingRunReservation(rpcSessionKey, runReservation);
          }
        }
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
// The pinned OpenClaw adapter cancels an uncommitted steer after 10 seconds.
// Keep the Portal transport deadline above that cancellation/response window so
// ordinary delivery failure is observed instead of becoming an ambiguous RPC.
export const ACTIVE_RUN_STEER_RPC_TIMEOUT_MS = 15_000;

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
  }, ACTIVE_RUN_STEER_RPC_TIMEOUT_MS);
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
  setPendingRunUserIdempotency(sessionKey, reservationRunId, idempotencyKey);

  // Register this session's run expectation BEFORE sending (prevents race with
  // stale replayed events that arrive between send and response).
  // We'll set the real runId when the response arrives.

  return new Promise((resolve, reject) => {
    const timeoutTimer = setTimeout(() => {
      pendingResponses.delete(requestId);
      parkAmbiguousRunDispatch(sessionKey, reservationRunId, {
        expectedUserIdempotencyKey: idempotencyKey,
        accept: async (runId: string) => {
          await persistDispatchThenAcknowledgeRunReservation(
            sessionKey,
            reservationRunId,
            runId,
            onProviderDispatchAccepted,
          );
          resolve({ runId });
        },
        reject,
      });
    }, 30000);

    pendingResponses.set(requestId, {
      resolve: (payload: any) => {
        clearTimeout(timeoutTimer);
        const runId = normalizedRunId(payload?.runId);
        if (!runId) {
          parkAmbiguousRunDispatch(sessionKey, reservationRunId, {
            expectedUserIdempotencyKey: idempotencyKey,
            accept: async (recoveredRunId: string) => {
              await persistDispatchThenAcknowledgeRunReservation(
                sessionKey,
                reservationRunId,
                recoveredRunId,
                onProviderDispatchAccepted,
              );
              resolve({ runId: recoveredRunId });
            },
            reject,
          });
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
        if (/WebSocket connection closed|RPC timeout/i.test(err.message)) {
          parkAmbiguousRunDispatch(sessionKey, reservationRunId, {
            expectedUserIdempotencyKey: idempotencyKey,
            accept: async (runId: string) => {
              await persistDispatchThenAcknowledgeRunReservation(
                sessionKey,
                reservationRunId,
                runId,
                onProviderDispatchAccepted,
              );
              resolve({ runId });
            },
            reject,
          });
          return;
        } else {
          failPendingRunReservation(sessionKey, reservationRunId);
        }
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
  expectedRunId: unknown,
  text: string,
  requestId = `legacy-steer-${nextId()}`,
): Promise<{ interruptedActiveRun: false; replayed: boolean; requestId: string; runId: string }> {
  // The browser observed this run before issuing the request. Never replace
  // that identity with whichever run happens to be active when HTTP/RPC
  // processing reaches this point: a delayed R1 request must not steer R2.
  // The exact-run gateway method also uses this identity for safe receipt
  // replay after R1 has settled.
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
    runId: result.runId,
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
  // A terminal run ID is never valid authority for a new live lane. Keep this
  // guard at the registration boundary so delayed sessions.list responses,
  // stale RPC acknowledgements, and route-level recovery helpers cannot
  // accidentally resurrect a completed run.
  if (nextRunId && isRunTombstoned(key, nextRunId)) return false;
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
  rejectAmbiguousRunDispatch(
    sessionKey,
    new Error('OpenClaw confirmed the ambiguous chat dispatch is not active.'),
  );
  clearPendingRunReservation(sessionKey);
  tombstoneRun(sessionKey, activeRunIds.get(sessionKey));
  activeRunIds.delete(sessionKey);
  clearReconnectRunRecovery(sessionKey);
  ambiguousRunReservationsBySession.delete(sessionKey);
  runOriginUserBySession.delete(sessionKey);
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
  beginReconnectRunRecovery,
  liveRunIdsFromSessionList,
  reconcileAuthoritativeLiveRun,
  armReconnectRunRecoveryAfterAuthentication,
  rememberRunOriginUser,
  markAmbiguousRunReservation,
  parkAmbiguousRunDispatch,
  finalizeAmbiguousRunDispatch,
  async reconcileInactiveReconnectHistoryPayload(sessionKey: string, payload: any): Promise<boolean> {
    const recovery = reconnectRunRecoveryBySession.get(sessionKey);
    return recovery ? await reconcileInactiveReconnectHistory(sessionKey, recovery, payload) : false;
  },
  async settleReconnectRunRecovery(
    sessionKey: string,
    historyReader?: ReconnectHistoryReader,
  ): Promise<void> {
    const recovery = reconnectRunRecoveryBySession.get(sessionKey);
    if (recovery) await settleExpiredReconnectRunRecovery(sessionKey, recovery, historyReader);
  },
  reconnectInactiveHistoryLimit: RECONNECT_INACTIVE_HISTORY_LIMIT,
  reconnectInactiveHistoryMaxAttempts: RECONNECT_INACTIVE_HISTORY_MAX_ATTEMPTS,
  runFrameQuarantineLimits: {
    ttlMs: RUN_FRAME_QUARANTINE_TTL_MS,
    maxFramesPerRun: MAX_QUARANTINED_FRAMES_PER_RUN,
    maxBytesPerRun: MAX_QUARANTINED_BYTES_PER_RUN,
    maxRuns: MAX_QUARANTINED_RUNS,
    maxFramesTotal: MAX_QUARANTINED_FRAMES_TOTAL,
    maxBytesTotal: MAX_QUARANTINED_BYTES_TOTAL,
  },
  quarantinedRunFrameCount(runId: string): number {
    pruneQuarantinedRunFrames();
    return quarantinedRunFramesByRunId.get(runId)?.frames.length || 0;
  },
  preambleProgressLimits: {
    maxItems: MAX_PREAMBLE_PROGRESS_ITEMS,
    maxChars: MAX_PREAMBLE_PROGRESS_CHARS,
    truncationMarker: PREAMBLE_PROGRESS_TRUNCATION_MARKER,
  },
  buildApprovalWaitStatusEvent,
  reconcileReconnectRunProbeResult,
  reserveLogicalRun,
  setPendingRunUserIdempotency,
  acknowledgeRunReservation,
  failPendingRunReservation,
  persistDispatchThenAcknowledgeRunReservation,
  registerRun,
  shouldProcessTrackedSessionEvent,
  resetSession(sessionKey: string): void {
    clearPendingRunReservation(sessionKey);
    failedRunReservationsBySession.delete(sessionKey);
    failedRunReservationDetailsBySession.delete(sessionKey);
    clearPendingEmptyFinal(sessionKey);
    clearPendingCodexIdleTimeout(sessionKey);
    pendingToolRunsBySession.delete(sessionKey);
    streamEventBus.clearStream(sessionKey);
    activeRunIds.delete(sessionKey);
    clearReconnectRunRecovery(sessionKey);
    ambiguousRunReservationsBySession.delete(sessionKey);
    ambiguousRunDispatchesBySession.delete(sessionKey);
    runOriginUserBySession.delete(sessionKey);
    desiredSessionMessageSubscriptions.delete(sessionKey);
    activeSessionMessageSubscriptions.delete(sessionKey);
    clearTextArbitration(sessionKey);
    messageToolReplyBySession.delete(sessionKey);
    runTombstonesBySession.delete(sessionKey);
    seenUserMessageIdsBySession.delete(sessionKey);
    lastHistoryChangedAtBySession.delete(sessionKey);
    for (const runId of [...quarantinedRunFramesByRunId.keys()]) {
      dropQuarantinedRunFrames(runId);
    }
    bufferedRunFrameSequence = 0;
  },
};
