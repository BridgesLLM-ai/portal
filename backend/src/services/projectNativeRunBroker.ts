import crypto from 'crypto';
import type {
  AgentProviderName,
  SenderIdentity,
} from '../agents/AgentProvider.interface';
import { AgentAbortError } from '../agents/AgentProvider.interface';
import { streamEventBus, type StreamEvent } from './StreamEventBus';
import {
  getProjectChatProviderAdapter,
  projectChatProviderDisplayName,
  type DurableProjectProvider,
} from './projectChatProviderRegistry';
import { sanitizeThinkingSubject } from '../utils/thinkingSubject';

const MAX_EVENT_TEXT = 80_000;
const MAX_EVENT_STRUCTURED_STRING = 20_000;
const MAX_EVENT_STRUCTURED_DEPTH = 6;
const MAX_EVENT_STRUCTURED_ENTRIES = 100;
const MAX_EVENTS = 1_000;
const TERMINAL_RETENTION_MS = 60 * 60_000;
const SETTLEMENT_WAIT_POLL_MS = 25;
export const PROJECT_NATIVE_MAX_RUN_TEXT = 4 * 1024 * 1024;
export const PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE =
  'Project Chat could not finalize durable turn state. Refresh before retrying.';

const SAFE_EVENT_TYPES = new Set<StreamEvent['type']>([
  'text',
  'thinking',
  'tool_start',
  'tool_update',
  'tool_end',
  'tool_used',
  'status',
  'done',
  'error',
  'segment_break',
  'compaction_start',
  'compaction_end',
  'run_resumed',
]);

function isSensitiveEventKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized === 'jwt'
    || normalized === 'token'
    || normalized.endsWith('token')
    || normalized.includes('apikey')
    || normalized.includes('authorization')
    || normalized.includes('cookie')
    || normalized.includes('password')
    || normalized.includes('passwd')
    || normalized.includes('passphrase')
    || normalized.includes('privatekey')
    || normalized.includes('credential')
    || normalized.includes('secret');
}

export interface ProjectNativeRunEvent extends StreamEvent {
  seq: number;
  ts: number;
}

export interface ProjectNativeRunSnapshot {
  runId: string | null;
  provider: AgentProviderName;
  runtime: string;
  sessionId: string | null;
  active: boolean;
  complete: boolean;
  status: 'idle' | 'running' | 'completed' | 'error' | 'aborted';
  text: string;
  error: string | null;
  startedAt: number | null;
  updatedAt: number;
  events: ProjectNativeRunEvent[];
  lastSeq: number;
}

interface ProjectNativeRunState extends ProjectNativeRunSnapshot {
  key: string;
  initialSessionId: string;
  textTruncated: boolean;
}

export interface StartProjectNativeRunInput {
  userId: string;
  projectId: string;
  provider: DurableProjectProvider;
  runtime: string;
  sessionId: string;
  message: string;
  sender?: SenderIdentity;
  model?: string | null;
  /** Durable Portal turn ID. Supplying it prevents a retained broker snapshot
   * from ever being mistaken for another database turn during replay. */
  runId?: string;
  onSessionResolved?: (sessionId: string) => Promise<void> | void;
  onEvent?: (event: ProjectNativeRunEvent) => Promise<void> | void;
  onComplete?: (result: {
    runId: string;
    sessionId: string;
    fullText: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void> | void;
  onError?: (error: Error) => Promise<void> | void;
  onSettled?: (result: {
    runId: string;
    sessionId: string;
    status: 'completed' | 'error' | 'aborted';
    error?: string | null;
    fullText: string;
  }) => Promise<void> | void;
}

const states = new Map<string, ProjectNativeRunState>();

function brokerKey(userId: string, projectId: string, provider: AgentProviderName): string {
  return `${userId}\u0000${projectId}\u0000${provider}`;
}

function boundedText(value: unknown): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text.length > MAX_EVENT_TEXT ? text.slice(0, MAX_EVENT_TEXT) : text;
}

function boundedStructuredValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_EVENT_STRUCTURED_STRING
      ? `${value.slice(0, MAX_EVENT_STRUCTURED_STRING)}…[truncated]`
      : value;
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return String(value).slice(0, MAX_EVENT_STRUCTURED_STRING);
  if (depth >= MAX_EVENT_STRUCTURED_DEPTH) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_EVENT_STRUCTURED_ENTRIES)
      .map((item) => boundedStructuredValue(item, depth + 1, seen));
  }

  const output: Record<string, unknown> = Object.create(null);
  let entries: Array<[string, unknown]> = [];
  try {
    entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_EVENT_STRUCTURED_ENTRIES);
  } catch {
    return '[unavailable]';
  }
  for (const [key, item] of entries) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    output[key] = isSensitiveEventKey(key)
      ? '[redacted]'
      : boundedStructuredValue(item, depth + 1, seen);
  }
  return output;
}

function sanitizeEvent(event: StreamEvent): StreamEvent {
  const type = SAFE_EVENT_TYPES.has(event.type) ? event.type : 'status';
  const sanitized: StreamEvent = { type };
  if (event.content != null) sanitized.content = boundedText(event.content);
  const subject = sanitizeThinkingSubject(event.subject);
  if (subject) sanitized.subject = subject;
  if (typeof event.toolName === 'string') sanitized.toolName = boundedText(event.toolName).slice(0, 512);
  if (event.toolArgs !== undefined) sanitized.toolArgs = boundedStructuredValue(event.toolArgs);
  if (event.toolResult != null) sanitized.toolResult = boundedText(event.toolResult);
  if (typeof event.provenance === 'string') sanitized.provenance = boundedText(event.provenance).slice(0, 512);
  if (typeof event.model === 'string') sanitized.model = boundedText(event.model).slice(0, 384);
  if (typeof event.status === 'string') sanitized.status = boundedText(event.status).slice(0, 128);
  if (typeof event.isError === 'boolean') sanitized.isError = event.isError;
  if (typeof event.toolCallId === 'string') sanitized.toolCallId = boundedText(event.toolCallId).slice(0, 256);
  if (typeof event.completed === 'boolean') sanitized.completed = event.completed;
  if (typeof event.terminal === 'boolean') sanitized.terminal = event.terminal;
  if (typeof event.willRetry === 'boolean') sanitized.willRetry = event.willRetry;
  if (event.maintenanceKind === 'compaction' || event.maintenanceKind === 'maintenance') {
    sanitized.maintenanceKind = event.maintenanceKind;
  }
  if (typeof event.replace === 'boolean') sanitized.replace = event.replace;
  if (typeof event.exitCode === 'number' && Number.isFinite(event.exitCode)) sanitized.exitCode = event.exitCode;
  return sanitized;
}

function setBoundedRunText(state: ProjectNativeRunState, value: unknown): void {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (text.length <= PROJECT_NATIVE_MAX_RUN_TEXT) {
    state.text = text;
    return;
  }
  state.text = text.slice(0, PROJECT_NATIVE_MAX_RUN_TEXT);
  if (!state.textTruncated) {
    state.textTruncated = true;
    appendEvent(state, {
      type: 'status',
      content: 'Response exceeded the Project Chat safety limit; the retained transcript was truncated.',
    });
  }
}

function appendBoundedRunText(state: ProjectNativeRunState, chunk: string): void {
  if (state.text.length >= PROJECT_NATIVE_MAX_RUN_TEXT) {
    setBoundedRunText(state, `${state.text}${chunk}`);
    return;
  }
  setBoundedRunText(state, `${state.text}${chunk}`);
}

function appendEvent(state: ProjectNativeRunState, event: StreamEvent): ProjectNativeRunEvent {
  const next: ProjectNativeRunEvent = {
    ...sanitizeEvent(event),
    seq: state.lastSeq + 1,
    ts: Date.now(),
    runId: state.runId || undefined,
  };
  state.lastSeq = next.seq;
  state.updatedAt = next.ts;
  state.events.push(next);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  streamEventBus.publish(state.sessionId || state.initialSessionId, { ...next, brokerEnvelope: true });
  return next;
}

function publicSnapshot(state: ProjectNativeRunState | undefined, afterSeq = 0): ProjectNativeRunSnapshot | null {
  if (!state) return null;
  return {
    runId: state.runId,
    provider: state.provider,
    runtime: state.runtime,
    sessionId: state.sessionId,
    active: state.active,
    complete: state.complete,
    status: state.status,
    text: state.text,
    error: state.error,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    events: state.events.filter((event) => event.seq > Math.max(0, afterSeq)),
    lastSeq: state.lastSeq,
  };
}

function pruneTerminalStates(): void {
  const threshold = Date.now() - TERMINAL_RETENTION_MS;
  for (const [key, state] of states) {
    if (!state.active && state.updatedAt < threshold) states.delete(key);
  }
}

export function getProjectNativeRunSnapshot(input: {
  userId: string;
  projectId: string;
  provider: AgentProviderName;
  afterSeq?: number;
}): ProjectNativeRunSnapshot | null {
  pruneTerminalStates();
  return publicSnapshot(states.get(brokerKey(input.userId, input.projectId, input.provider)), input.afterSeq);
}

export function startProjectNativeRun(input: StartProjectNativeRunInput): ProjectNativeRunSnapshot {
  const key = brokerKey(input.userId, input.projectId, input.provider);
  const existing = states.get(key);
  if (existing?.active) throw new Error(`${input.provider} already has an active turn for this project`);

  const now = Date.now();
  const state: ProjectNativeRunState = {
    key,
    runId: String(input.runId || '').trim() || crypto.randomUUID(),
    provider: input.provider,
    runtime: input.runtime,
    sessionId: input.sessionId,
    initialSessionId: input.sessionId,
    active: true,
    complete: false,
    status: 'running',
    text: '',
    error: null,
    startedAt: now,
    updatedAt: now,
    events: [],
    lastSeq: 0,
    textTruncated: false,
  };
  states.set(key, state);
  const recordEvent = (
    event: StreamEvent,
    options: { persistDurably?: boolean } = {},
  ): ProjectNativeRunEvent => {
    const persisted = appendEvent(state, event);
    if (options.persistDurably !== false) {
      void Promise.resolve(input.onEvent?.(persisted)).catch((error) => {
        console.error('[Project Native Run] Durable event callback failed:', error);
      });
    }
    return persisted;
  };
  let sessionResolutionFailure: unknown = null;
  let sessionResolutionChain: Promise<void> = Promise.resolve();
  const attestAndAdoptSession = (candidate: string): Promise<void> => {
    const sessionId = String(candidate || '').trim();
    sessionResolutionChain = sessionResolutionChain.then(async () => {
      if (sessionResolutionFailure || !sessionId || sessionId === state.sessionId) return;
      try {
        // A provider-reported session is untrusted until the route binds it to
        // the exact durable actor/project session. In particular, do not let a
        // rejected rekey poison abort/reset settlement with another session ID.
        await input.onSessionResolved?.(sessionId);
        state.sessionId = sessionId;
        state.updatedAt = Date.now();
      } catch (error) {
        sessionResolutionFailure = error;
        console.error('[Project Native Run] Session binding callback failed:', error);
      }
    });
    return sessionResolutionChain;
  };
  const requireAttestedSession = async (candidate: string): Promise<string> => {
    await sessionResolutionChain;
    if (!sessionResolutionFailure) await attestAndAdoptSession(candidate);
    if (sessionResolutionFailure) {
      throw new Error('Project session binding persistence failed');
    }
    return state.sessionId || state.initialSessionId;
  };
  const providerLabel = projectChatProviderDisplayName(input.provider);
  const existingBusRun = streamEventBus.getTrackedStream(input.sessionId);
  const existingBusRunId = typeof existingBusRun?.runId === 'string' && existingBusRun.runId.trim()
    ? existingBusRun.runId.trim()
    : null;
  const nextBusRunId = state.runId || '';
  const startedBusRun = existingBusRun && !existingBusRun.active && existingBusRunId && existingBusRunId !== nextBusRunId
    ? streamEventBus.adoptStreamRun(input.sessionId, existingBusRunId, nextBusRunId, {
        provenance: `${providerLabel} • ${input.runtime}`,
        model: input.model || undefined,
      }) && streamEventBus.resumeStream(input.sessionId, nextBusRunId, {
        provenance: `${providerLabel} • ${input.runtime}`,
        model: input.model || undefined,
      })
    : streamEventBus.startStream(input.sessionId, nextBusRunId, {
        provenance: `${providerLabel} • ${input.runtime}`,
        model: input.model || undefined,
      });
  if (!startedBusRun) {
    states.delete(key);
    throw new Error(`${input.provider} already has an active turn for this project session`);
  }
  recordEvent({ type: 'status', content: `${providerLabel} is working…` });

  const provider = getProjectChatProviderAdapter(input.provider);
  void provider.sendMessage(
    input.sessionId,
    input.message,
    (chunk) => {
      if (!state.active) return;
      appendBoundedRunText(state, chunk);
      streamEventBus.updateStreamPhase(state.sessionId || state.initialSessionId, {
        phase: 'streaming',
        runId: state.runId || undefined,
      });
      recordEvent({ type: 'text', content: chunk });
    },
    (event) => {
      if (!state.active) return;
      if (event?.type === 'session' && typeof event.sessionId === 'string' && event.sessionId.trim()) {
        void attestAndAdoptSession(event.sessionId);
        return;
      }
      const eventType = String(event?.type || 'status') as StreamEvent['type'];
      if (eventType === 'tool_start' || eventType === 'tool_update') {
        streamEventBus.updateStreamPhase(state.sessionId || state.initialSessionId, {
          phase: 'tool',
          toolName: typeof event.toolName === 'string' ? event.toolName : undefined,
          runId: state.runId || undefined,
        });
      } else if (eventType === 'tool_end' || eventType === 'thinking' || eventType === 'status') {
        streamEventBus.updateStreamPhase(state.sessionId || state.initialSessionId, {
          phase: 'thinking',
          runId: state.runId || undefined,
        });
      }
      recordEvent({
        ...event,
        type: eventType,
        ...(typeof event?.content === 'string' ? { content: event.content } : {}),
      });
    },
    () => {
      recordEvent({
        type: 'error',
        content: 'Project Sandbox refused an interactive privilege escalation request.',
      });
    },
    input.sender,
  ).then(async (result) => {
    const providerResolvedSessionId = typeof result.metadata?.resolvedSessionId === 'string' && result.metadata.resolvedSessionId.trim()
      ? result.metadata.resolvedSessionId.trim()
      : state.sessionId || state.initialSessionId;
    const resolvedSessionId = await requireAttestedSession(providerResolvedSessionId);
    if (result.fullText) setBoundedRunText(state, result.fullText);
    await Promise.resolve(input.onComplete?.({
      runId: state.runId || '',
      sessionId: resolvedSessionId,
      fullText: state.text,
      metadata: result.metadata,
    })).catch((error) => {
      console.error('[Project Native Run] Completion persistence callback failed:', error);
      throw new Error('Project transcript persistence failed');
    });
    state.complete = true;
    state.status = 'completed';
    state.updatedAt = Date.now();
    try {
      await Promise.resolve(input.onSettled?.({
        runId: state.runId || '',
        sessionId: resolvedSessionId,
        status: 'completed',
        error: null,
        fullText: state.text,
      }));
    } catch (error) {
      console.error('[Project Native Run] Settlement callback failed:', error);
      // Provider execution and transcript persistence succeeded, but the
      // durable lease/handoff did not. Publishing `done` here would strand the
      // browser on success while the database rejects the next turn until the
      // abandoned lease expires. Surface one fixed, credential-safe terminal
      // error and keep reset's semantic settlement boundary truthful.
      state.status = 'error';
      state.error = PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE;
      state.updatedAt = Date.now();
      recordEvent({
        type: 'error',
        content: PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE,
        terminal: true,
      }, { persistDurably: false });
      state.active = false;
      state.updatedAt = Date.now();
      streamEventBus.clearStream(resolvedSessionId, state.runId || null);
      return;
    }
    // onSettled is the durable terminal boundary: it atomically projects the
    // assistant message, finalizes the turn, and detaches the active lease.
    // This post-settlement event is only the live broker notification. Calling
    // onEvent here would necessarily attempt to append to an inactive turn.
    recordEvent({
      type: 'done',
      content: state.text,
      model: typeof result.metadata?.model === 'string' ? result.metadata.model : input.model || undefined,
    }, { persistDurably: false });
    // Keep the broker active until every persistence/settlement callback has
    // returned. Destructive reset waits on this semantic boundary before it
    // can claim the durable runtime-admission slot.
    state.active = false;
    state.updatedAt = Date.now();
    streamEventBus.softClearStream(resolvedSessionId, state.runId || null);
  }).catch(async (providerError: any) => {
    await sessionResolutionChain;
    const error = sessionResolutionFailure
      ? new Error('Project session binding persistence failed')
      : providerError;
    const aborted = error instanceof AgentAbortError || error?.name === 'AgentAbortError';
    state.error = aborted
      ? 'Turn cancelled'
      : boundedText(error?.message || error || `${providerLabel} Project turn failed`);
    await Promise.resolve(input.onError?.(error instanceof Error ? error : new Error(state.error))).catch((callbackError) => {
      console.error('[Project Native Run] Error persistence callback failed:', callbackError);
    });
    state.complete = true;
    state.status = aborted ? 'aborted' : 'error';
    state.updatedAt = Date.now();
    try {
      await Promise.resolve(input.onSettled?.({
        runId: state.runId || '',
        sessionId: state.sessionId || state.initialSessionId,
        status: aborted ? 'aborted' : 'error',
        error: state.error,
        fullText: state.text,
      }));
    } catch (callbackError) {
      console.error('[Project Native Run] Settlement callback failed:', callbackError);
      state.status = 'error';
      state.error = PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE;
      state.updatedAt = Date.now();
      recordEvent({
        type: 'error',
        content: PROJECT_NATIVE_SETTLEMENT_FAILURE_MESSAGE,
        terminal: true,
      }, { persistDurably: false });
      state.active = false;
      state.updatedAt = Date.now();
      streamEventBus.clearStream(state.sessionId || state.initialSessionId, state.runId || null);
      return;
    }
    // The durable error/abort outcome was committed by onSettled above. Keep
    // the broker notification local rather than writing after lease teardown.
    recordEvent({
      type: aborted ? 'done' : 'error',
      content: state.error,
      ...(!aborted ? { terminal: true } : {}),
    }, { persistDurably: false });
    state.active = false;
    state.updatedAt = Date.now();
    streamEventBus.clearStream(state.sessionId || state.initialSessionId, state.runId || null);
  });

  return publicSnapshot(state)!;
}

export async function abortProjectNativeRun(input: {
  userId: string;
  projectId: string;
  provider: DurableProjectProvider;
}): Promise<boolean> {
  const state = states.get(brokerKey(input.userId, input.projectId, input.provider));
  if (!state?.active) return false;
  const provider = getProjectChatProviderAdapter(input.provider);
  const candidates = Array.from(new Set([state.sessionId, state.initialSessionId].filter(Boolean))) as string[];
  for (const sessionId of candidates) {
    if (await provider.abortActiveRun?.(sessionId, state.runId || undefined)) return true;
  }
  return false;
}

/**
 * Confirms that the exact broker run has finished every terminal callback.
 * Provider cancellation alone is not enough for destructive reset: an old
 * onSettled callback could otherwise publish after the reset response.
 */
export async function waitForProjectNativeRunSettlement(input: {
  userId: string;
  projectId: string;
  provider: DurableProjectProvider;
  runId: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const key = brokerKey(input.userId, input.projectId, input.provider);
  const timeoutMs = Math.min(30_000, Math.max(100, Number(input.timeoutMs) || 15_000));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = states.get(key);
    if (!state || state.runId !== input.runId) return false;
    if (!state.active) return state.complete;
    await new Promise((resolve) => setTimeout(resolve, SETTLEMENT_WAIT_POLL_MS));
  }
  return false;
}

/**
 * Quiesces one exact in-memory run before destructive reset is allowed to
 * advance the durable provider generation. This is intentionally independent
 * of ProjectChatState.activeTurnId: a crashed/expired lease may already be
 * detached while its provider promise is still inside onComplete/onError or
 * onSettled and therefore still capable of publishing derived state.
 */
export async function quiesceProjectNativeRunForDestructiveReset(input: {
  userId: string;
  projectId: string;
  provider: DurableProjectProvider;
  timeoutMs?: number;
}): Promise<{ quiescent: boolean; runId: string | null }> {
  const initial = getProjectNativeRunSnapshot(input);
  if (!initial?.active) return { quiescent: true, runId: initial?.runId || null };
  const runId = String(initial.runId || '').trim();
  if (!runId) return { quiescent: false, runId: null };

  if (!initial.complete) {
    let abortConfirmed = await abortProjectNativeRun(input);
    if (!abortConfirmed) {
      const sessionId = String(initial.sessionId || '').trim();
      abortConfirmed = Boolean(
        sessionId
        && await getProjectChatProviderAdapter(input.provider).abortActiveRun?.(sessionId, runId),
      );
    }
    const afterAbort = getProjectNativeRunSnapshot(input);
    if (!abortConfirmed && afterAbort?.runId === runId && afterAbort.active && !afterAbort.complete) {
      return { quiescent: false, runId };
    }
  }

  const settled = await waitForProjectNativeRunSettlement({
    ...input,
    runId,
  });
  const final = getProjectNativeRunSnapshot(input);
  return {
    quiescent: Boolean(
      settled
      && final
      && final.runId === runId
      && final.complete
      && !final.active
    ),
    runId,
  };
}

export function clearProjectNativeRun(input: {
  userId: string;
  projectId: string;
  provider: DurableProjectProvider;
}): void {
  states.delete(brokerKey(input.userId, input.projectId, input.provider));
}

export function clearProjectNativeRunBrokerForTests(): void {
  states.clear();
}
