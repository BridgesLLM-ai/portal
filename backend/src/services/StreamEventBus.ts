/**
 * StreamEventBus — Singleton pub/sub for session-scoped stream events.
 *
 * Tracks active streams and distributes events from PersistentGatewayWs
 * to browser WS clients. Replaces the per-handler `activeStreams` Map
 * in gateway.ts so that stream status survives handler lifecycle.
 */

import { normalizeRuntimeTurnEvent, type RuntimeTurnEvent } from './RuntimeTurnEvents';
import { recordRuntimeTurnEvent } from './RuntimeTurnEventHistory';
import { sanitizeThinkingSubject } from '../utils/thinkingSubject';

export interface StreamEvent {
  type: 'text' | 'thinking' | 'tool_start' | 'tool_update' | 'tool_end' | 'tool_used' | 'status' | 'done' | 'error' | 'exec_approval' | 'segment_break' | 'compaction_start' | 'compaction_end' | 'run_resumed' | 'user_message' | 'history_changed';
  /**
   * Set on events the project run broker republishes for browser relays.
   * Provider subscribers must ignore these: consuming a broker envelope
   * re-records it, which republishes it, which recurses without bound.
   */
  brokerEnvelope?: boolean;
  content?: string;
  /** Safe provider-exposed preamble/title for a reasoning bubble. */
  subject?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: string;
  provenance?: string;
  completed?: boolean;
  willRetry?: boolean;
  maintenanceKind?: 'compaction' | 'maintenance';
  /** Live-only rail status that must not become durable transcript content. */
  transient?: boolean;
  /** Stable BridgesLLM turn-event contract used by Agent Chat. */
  turnEvent?: RuntimeTurnEvent;
  [key: string]: unknown;
}

export interface StreamToolCall {
  id: string;
  name: string;
  arguments?: unknown;
  result?: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'done' | 'error';
}

export interface StreamInfo {
  active: boolean;
  phase: 'thinking' | 'tool' | 'streaming';
  toolName?: string;
  toolCalls?: StreamToolCall[];
  statusText?: string;
  provenance?: string;
  model?: string;
  compactionPhase?: 'idle' | 'compacting' | 'compacted';
  startedAt: number;
  runId?: string;
  latestText: string;
  lastEventAt: number;
  /** Timestamp of last 'done' event — helps detect run resumption */
  lastDoneAt?: number;
}

type StreamCallback = (event: StreamEvent) => void;

type GlobalCallback = (sessionKey: string, event: StreamEvent) => void;

function getLastRunningToolCall(toolCalls?: StreamToolCall[]): StreamToolCall | null {
  if (!Array.isArray(toolCalls)) return null;
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    if (toolCalls[i]?.status === 'running') {
      return toolCalls[i];
    }
  }
  return null;
}

function normalizedToolCallId(event: StreamEvent): string | null {
  const id = typeof event.toolCallId === 'string' ? event.toolCallId.trim() : '';
  return id || null;
}

function findToolCallIndex(toolCalls: StreamToolCall[], toolCallId: string | null): number {
  if (toolCallId) {
    return toolCalls.findIndex((call) => call.id === toolCallId);
  }
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    if (toolCalls[i]?.status === 'running') return i;
  }
  return -1;
}

function toolEventFailed(event: StreamEvent): boolean {
  if (event.isError === true) return true;
  if (typeof event.exitCode === 'number' && Number.isFinite(event.exitCode) && event.exitCode !== 0) return true;
  const status = typeof event.status === 'string' ? event.status.trim().toLowerCase() : '';
  return ['error', 'failed', 'failure', 'cancelled', 'canceled', 'aborted', 'denied'].includes(status);
}

function normalizedRunId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function isSessionLevelEvent(event: StreamEvent): boolean {
  return event.type === 'user_message'
    || event.type === 'history_changed'
    || event.type === 'compaction_start'
    || event.type === 'compaction_end'
    || (event.type === 'status' && event.maintenanceKind === 'maintenance');
}

const RAIL_SAFE_STATUS_RE = /^(?:thinking[.…]*(?:\s+\(~[0-9][0-9,]*\s+tokens\))?|connecting directly to openclaw[.…]*|reconnecting to stream[.…]*|resuming stream[.…]*|still responding[.…]*|still working[.…]*|starting codex runtime[.…]*|codex session ready\.?|starting codex turn[.…]*|codex accepted the turn\.?|codex is writing[.…]*|codex is working[.…]*|codex turn completion is delayed; waiting for the final response[.…]*|running tool[.…]*|preparing execution hooks[.…]*|execution hooks ready\.?|waiting for command approval[.…]*|command denied|command approved|approval did not complete|approval failed(?::.*)?|compacting context[.…]*|context compacted\.?|context maintenance (?:in progress|finished|complete(?:d)?)[.…]*|preparing context maintenance[.…]*|memory flush (?:about to start|starting|started|queued|pending|complete(?:d)?)[.…]*|heartbeat check (?:started|starting|running|queued|pending|complete(?:d)?)[.…]*|heartbeat_ok)$/i;
const RAIL_SAFE_MAINTENANCE_RE = /\b(preparing (?:for )?(?:a )?memory flush|preparing context maintenance|preparing compaction|pre-compaction|memory flush(?:ing)?|flush in progress|flushing memory|storing durable memor(?:y|ies)|writing durable memor(?:y|ies)|context maintenance|refreshing (?:context|memory)|summariz(?:ing|ation) (?:context|conversation|history)|trimming context|durable memor(?:y|ies) (?:stored|written)|context refreshed)\b/i;

function normalizeRailStatusText(text?: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const normalized = text.replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+/u, '').trim();
  if (!normalized) return undefined;
  if (RAIL_SAFE_STATUS_RE.test(normalized) || RAIL_SAFE_MAINTENANCE_RE.test(normalized)) {
    return normalized;
  }
  return undefined;
}

export class StreamEventBus {
  /** sessionKey → set of subscriber callbacks */
  private listeners = new Map<string, Set<StreamCallback>>();

  /** Global listeners (receive ALL events for ANY session — used for compaction forwarding) */
  private globalListeners = new Set<GlobalCallback>();

  /** sessionKey → current stream status */
  private streams = new Map<string, StreamInfo>();

  /** sessionKey → last accumulated text (for delta diffing from chat events) */
  private lastSeenText = new Map<string, string>();

  /** sessionKey → latest fully-assembled text snapshot for reconnect recovery */
  private latestText = new Map<string, string>();

  /** sessionKey → monotonic turn-event sequence. Stable across transport event shapes. */
  private turnEventSeq = new Map<string, number>();

  /** sessionKey → recent normalized turn events for reconnect/parity diagnostics. */
  private recentTurnEvents = new Map<string, RuntimeTurnEvent[]>();

  /** Backwards-compatible alias for activeStreams */
  private get activeStreams(): Map<string, StreamInfo> {
    return this.streams;
  }

  constructor() {
    // Prune dormant entries older than 1 hour every 15 minutes.
    // unref() keeps tests and short-lived scripts from hanging on this housekeeping timer.
    const ONE_HOUR = 60 * 60 * 1000;
    const pruneTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionKey, info] of this.streams) {
        const subs = this.listeners.get(sessionKey);
        const hasNoSubscribers = !subs || subs.size === 0;
        if (info.lastDoneAt && (now - info.lastDoneAt) > ONE_HOUR && hasNoSubscribers) {
          this.streams.delete(sessionKey);
          this.lastSeenText.delete(sessionKey);
          this.latestText.delete(sessionKey);
          this.turnEventSeq.delete(sessionKey);
          this.recentTurnEvents.delete(sessionKey);
        }
      }
    }, 15 * 60 * 1000);
    pruneTimer.unref?.();
  }


  /**
   * Subscribe to stream events for a specific session.
   * Returns an unsubscribe function.
   */
  subscribe(sessionKey: string, callback: StreamCallback): () => void {
    let subs = this.listeners.get(sessionKey);
    if (!subs) {
      subs = new Set();
      this.listeners.set(sessionKey, subs);
    }
    subs.add(callback);

    return () => {
      const s = this.listeners.get(sessionKey);
      if (s) {
        s.delete(callback);
        if (s.size === 0) this.listeners.delete(sessionKey);
      }
    };
  }

  /**
   * Check whether any subscribers exist for a session.
   */
  hasSubscribers(sessionKey: string): boolean {
    const subs = this.listeners.get(sessionKey);
    return !!subs && subs.size > 0;
  }

  /**
   * Subscribe to ALL events globally (any session).
   * Used by portal WS connections to receive compaction events even when no
   * per-message stream is active. Returns an unsubscribe function.
   */
  subscribeGlobal(callback: GlobalCallback): () => void {
    this.globalListeners.add(callback);
    return () => { this.globalListeners.delete(callback); };
  }

  /**
   * Publish an event to all subscribers for a session.
   * Also notifies global listeners for session-level events (compaction).
   */
  publish(sessionKey: string, event: StreamEvent): void {
    const info = this.activeStreams.get(sessionKey);
    const trackedRunId = normalizedRunId(info?.runId);
    const eventRunId = normalizedRunId(event.runId);
    if (trackedRunId) {
      if (eventRunId && trackedRunId !== eventRunId) {
        // A delayed callback from a settled turn must not mutate the current
        // run's text/tool snapshot or reach any browser/global subscriber.
        return;
      }
      if (!eventRunId && !isSessionLevelEvent(event)) {
        // Once a logical turn owns the tracked session (active or dormant),
        // run-scoped events must prove that identity. Compaction and
        // maintenance status are deliberately session-level and remain valid
        // without a run ID.
        return;
      }
    }
    if (info?.active === false && !isSessionLevelEvent(event)) {
      // A terminal stream retains its identity only as a CAS predecessor.
      // Ordinary late callbacks must not resurrect or mutate that dormant run.
      return;
    }
    const now = Date.now();
    const runningToolCall = info ? getLastRunningToolCall(info.toolCalls) : null;
    let resolvedToolCallId: string | undefined;
    if (info) {
      info.lastEventAt = now;
      if (typeof event.provenance === 'string' && event.provenance.trim()) {
        info.provenance = event.provenance.trim();
      }
      if (typeof event.model === 'string' && event.model.trim()) {
        info.model = event.model.trim();
      }
    }

    if (event.type === 'text') {
      const isReplace = event.replace === true;
      const nextText = isReplace
        ? (typeof event.content === 'string' ? event.content : '')
        : (this.latestText.get(sessionKey) || '') + (typeof event.content === 'string' ? event.content : '');
      this.latestText.set(sessionKey, nextText);
      if (info) {
        info.latestText = nextText;
        info.statusText = undefined;
      }
    } else if (event.type === 'done') {
      const finalText = typeof event.content === 'string' && event.content.length > 0
        ? event.content
        : (this.latestText.get(sessionKey) || '');
      this.latestText.set(sessionKey, finalText);
      if (info) {
        info.latestText = finalText;
        info.statusText = undefined;
        info.compactionPhase = 'idle';
      }
    } else if (info) {
      if (event.type === 'thinking') {
        const railStatusText = normalizeRailStatusText(event.content);
        if (!runningToolCall && railStatusText) {
          info.statusText = railStatusText;
        }
      } else if (event.type === 'status') {
        if (!runningToolCall) {
          const railStatusText = normalizeRailStatusText(event.content);
          if (railStatusText) {
            info.statusText = railStatusText;
          } else if (event.maintenanceKind === 'maintenance' && !info.statusText) {
            info.statusText = 'Context maintenance in progress…';
          }
        }
      } else if (event.type === 'tool_start') {
        const suppliedId = normalizedToolCallId(event);
        const existingCalls = Array.isArray(info.toolCalls) ? [...info.toolCalls] : [];
        const existingIndex = suppliedId ? findToolCallIndex(existingCalls, suppliedId) : -1;
        const existingCall = existingIndex >= 0 ? existingCalls[existingIndex] : null;
        if (existingCall && existingCall.status !== 'running') {
          // A stable provider ID cannot start twice. Drop late replay after a
          // terminal snapshot instead of emitting a contradictory running event.
          return;
        } else {
          info.toolName = typeof event.toolName === 'string' && event.toolName.trim()
            ? event.toolName.trim()
            : (existingCall?.name || info.toolName);
          info.statusText = info.toolName ? `Using ${info.toolName}…` : info.statusText;
          const toolName = info.toolName || 'tool';
          const toolCall: StreamToolCall = {
            id: suppliedId || `tool-${now}-${existingCalls.length + 1}`,
            name: toolName,
            arguments: event.toolArgs,
            startedAt: existingCall?.startedAt || now,
            status: 'running',
          };
          resolvedToolCallId = toolCall.id;
          if (existingIndex >= 0) existingCalls[existingIndex] = { ...existingCall!, ...toolCall };
          else existingCalls.push(toolCall);
        }
        info.toolCalls = existingCalls;
      } else if (event.type === 'tool_update') {
        const suppliedId = normalizedToolCallId(event);
        const existingCalls = Array.isArray(info.toolCalls) ? [...info.toolCalls] : [];
        const existingIndex = findToolCallIndex(existingCalls, suppliedId);
        const existingCall = existingIndex >= 0 ? existingCalls[existingIndex] : null;
        const toolName = typeof event.toolName === 'string' && event.toolName.trim()
          ? event.toolName.trim()
          : (existingCall?.name || info.toolName || 'tool');
        info.toolName = toolName;
        info.statusText = `Using ${toolName}…`;
        if (existingCall && existingCall.status !== 'running') {
          // Do not resurrect a completed call in live or reconnect projections.
          return;
        } else if (existingIndex >= 0) {
          existingCalls[existingIndex] = {
            ...existingCall!,
            name: toolName,
            arguments: event.toolArgs !== undefined ? event.toolArgs : existingCall?.arguments,
            result: typeof event.toolResult === 'string' ? event.toolResult : existingCall?.result,
            status: 'running',
          };
          resolvedToolCallId = existingCalls[existingIndex].id;
        } else if (suppliedId) {
          existingCalls.push({
            id: suppliedId,
            name: toolName,
            arguments: event.toolArgs,
            result: typeof event.toolResult === 'string' ? event.toolResult : undefined,
            startedAt: now,
            status: 'running',
          });
          resolvedToolCallId = suppliedId;
        }
        info.toolCalls = existingCalls;
        const activeTool = getLastRunningToolCall(existingCalls);
        info.toolName = activeTool?.name;
        info.statusText = activeTool ? `Using ${activeTool.name}…` : undefined;
      } else if (event.type === 'tool_end') {
        const suppliedId = normalizedToolCallId(event);
        const existingCalls = Array.isArray(info.toolCalls) ? [...info.toolCalls] : [];
        const existingIndex = findToolCallIndex(existingCalls, suppliedId);
        const existingCall = existingIndex >= 0 ? existingCalls[existingIndex] : null;
        const completedStatus: StreamToolCall['status'] = toolEventFailed(event) ? 'error' : 'done';
        const toolName = typeof event.toolName === 'string' && event.toolName.trim()
          ? event.toolName.trim()
          : (existingCall?.name || info.toolName || 'tool');
        if (existingIndex >= 0) {
          existingCalls[existingIndex] = {
            ...existingCall!,
            name: toolName,
            endedAt: existingCall?.endedAt || now,
            result: typeof event.toolResult === 'string' ? event.toolResult : existingCall?.result,
            status: existingCall?.status === 'error' ? 'error' : completedStatus,
          };
          resolvedToolCallId = existingCalls[existingIndex].id;
        } else if (suppliedId) {
          existingCalls.push({
            id: suppliedId,
            name: toolName,
            startedAt: now,
            endedAt: now,
            result: typeof event.toolResult === 'string' ? event.toolResult : undefined,
            status: completedStatus,
          });
          resolvedToolCallId = suppliedId;
        }
        info.toolCalls = existingCalls;
        const remainingRunning = getLastRunningToolCall(existingCalls);
        info.toolName = remainingRunning?.name;
        info.statusText = remainingRunning ? `Using ${remainingRunning.name}…` : undefined;
      } else if (event.type === 'compaction_start') {
        info.compactionPhase = 'compacting';
        if (!runningToolCall) {
          info.statusText = typeof event.content === 'string' && event.content.trim() ? event.content.trim() : 'Compacting context…';
        }
      } else if (event.type === 'compaction_end') {
        const completed = event.completed !== false && event.maintenanceKind !== 'maintenance';
        info.compactionPhase = completed ? 'compacted' : 'idle';
        if (!runningToolCall) {
          info.statusText = typeof event.content === 'string' && event.content.trim()
            ? event.content.trim()
            : (completed ? 'Context compacted' : 'Context maintenance finished.');
        }
      } else if (event.type === 'run_resumed') {
        if (!runningToolCall) {
          info.statusText = 'Resuming stream…';
        }
      }
    }

    const subs = this.listeners.get(sessionKey);
    if (subs && subs.size > 3 && event.type === 'text') {
      // Three subscribers are normal during portal streaming: the provider
      // waiter, a route-owned terminal observer that survives browser handoff,
      // and the current browser forwarder. Warn above that baseline.
      const now = Date.now();
      const lastWarnKey = `__lastDupWarn_${sessionKey}`;
      const lastWarn = (this as any)[lastWarnKey] || 0;
      if (now - lastWarn > 10000) {
        (this as any)[lastWarnKey] = now;
        console.warn(`[StreamEventBus] ⚠️ EXTRA SUBS: ${subs.size} subscribers for ${sessionKey} on text event (expected <= 3). Check registerWsStreamCleanup / reconnect lifecycle.`);
      }
    }
    const toolNormalizedEvent = resolvedToolCallId && !normalizedToolCallId(event)
      ? { ...event, toolCallId: resolvedToolCallId }
      : event;
    const normalizedSubject = sanitizeThinkingSubject(toolNormalizedEvent.subject);
    const normalizedEvent = normalizedSubject
      ? { ...toolNormalizedEvent, subject: normalizedSubject }
      : Object.prototype.hasOwnProperty.call(toolNormalizedEvent, 'subject')
        ? (({ subject: _subject, ...rest }) => rest)(toolNormalizedEvent)
        : toolNormalizedEvent;
    const nextTurnSeq = (this.turnEventSeq.get(sessionKey) || 0) + 1;
    const turnEvent = normalizedEvent.turnEvent || normalizeRuntimeTurnEvent({
      sessionKey,
      event: normalizedEvent,
      info,
      seq: nextTurnSeq,
      now,
    });
    if (turnEvent) {
      this.turnEventSeq.set(sessionKey, nextTurnSeq);
      const recent = this.recentTurnEvents.get(sessionKey) || [];
      const previous = recent[recent.length - 1];
      const sameReasoningLane = Boolean(turnEvent.source?.preambleProgress)
        === Boolean(previous?.source?.preambleProgress);
      const replacesSameLiveThought = turnEvent.type === 'assistant_reasoning'
        && turnEvent.replace === true
        && previous?.type === 'assistant_reasoning'
        && sameReasoningLane
        && (previous.runId || '') === (turnEvent.runId || '');
      const replacesSameLiveStatus = turnEvent.type === 'assistant_status'
        && turnEvent.replace === true
        && previous?.type === 'assistant_status'
        && (previous.runId || '') === (turnEvent.runId || '');
      if (replacesSameLiveThought || replacesSameLiveStatus) {
        recent[recent.length - 1] = turnEvent;
      } else {
        recent.push(turnEvent);
      }
      this.recentTurnEvents.set(sessionKey, recent.slice(-500));
      recordRuntimeTurnEvent(sessionKey, turnEvent);
    }

    const outboundBase: StreamEvent = info
      && !(typeof normalizedEvent.model === 'string' && normalizedEvent.model.trim())
      && typeof info.model === 'string'
      && info.model.trim()
        ? { ...normalizedEvent, model: info.model.trim() }
        : normalizedEvent;
    const outboundEvent: StreamEvent = turnEvent
      ? { ...outboundBase, turnEvent }
      : outboundBase;

    if (subs && subs.size > 0) {
      for (const cb of subs) {
        try {
          cb(outboundEvent);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          // The first frames are the only way to locate a recursive
          // subscriber on a live host; messages alone are a dead end.
          const frames = err instanceof Error && err.stack
            ? `\n${err.stack.split('\n').slice(0, 14).join('\n')}`
            : '';
          console.error(`[StreamEventBus] Subscriber error for ${sessionKey}: ${msg}${frames}`);
        }
      }
    }

    // Always notify global listeners. The gateway decides per browser socket
    // whether that socket already has a direct session subscription. This
    // distinction matters because providers and route settlement code also use
    // per-session subscribers internally: an internal observer must not prevent
    // a reconnected browser from receiving the rest of a live turn.
    for (const cb of this.globalListeners) {
      try {
        cb(sessionKey, outboundEvent);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[StreamEventBus] Global listener error: ${msg}`);
      }
    }
  }

  /**
   * Get the current stream status for a session.
   */
  getStreamStatus(sessionKey: string): StreamInfo | null {
    const info = this.activeStreams.get(sessionKey);
    // Only return if actively streaming — softClearStream sets active=false
    // when a run segment completes but a new run might follow.
    if (info && info.active === false) return null;
    return info || null;
  }

  /**
   * Get the tracked stream entry for a session, including dormant post-done
   * entries kept alive for yield/resume handoff.
   */
  getTrackedStream(sessionKey: string): StreamInfo | null {
    return this.activeStreams.get(sessionKey) || null;
  }

  /**
   * Update the stream phase for a session. Creates the entry if needed.
   */
  updateStreamPhase(sessionKey: string, info: Partial<StreamInfo> & { phase: StreamInfo['phase'] }): boolean {
    const existing = this.activeStreams.get(sessionKey);
    const assertedRunId = normalizedRunId(info.runId);
    const existingRunId = normalizedRunId(existing?.runId);
    if (existing?.active === false) return false;
    if (existingRunId && (
      assertedRunId && existingRunId !== assertedRunId
    )) {
      return false;
    }
    const nextStatusText = 'statusText' in info ? normalizeRailStatusText(info.statusText) : undefined;
    if (existing) {
      const runningToolCall = getLastRunningToolCall(existing.toolCalls);
      const nextPhase = runningToolCall && info.phase !== 'tool' ? 'tool' : info.phase;
      const shouldPreserveToolStatus = Boolean(runningToolCall) && info.phase !== 'tool';
      existing.active = true;
      existing.phase = nextPhase;
      if ('toolName' in info) existing.toolName = info.toolName;
      if (!existing.toolName && runningToolCall?.name) {
        existing.toolName = runningToolCall.name;
      }
      if (!existingRunId && assertedRunId) existing.runId = assertedRunId;
      if ('statusText' in info && !shouldPreserveToolStatus) {
        if (nextStatusText) existing.statusText = nextStatusText;
        else if (info.statusText == null) existing.statusText = undefined;
      }
      if (shouldPreserveToolStatus && !existing.statusText && existing.toolName) {
        existing.statusText = `Using ${existing.toolName}…`;
      }
      if ('provenance' in info) existing.provenance = info.provenance;
      if ('model' in info) existing.model = info.model;
      if ('compactionPhase' in info) existing.compactionPhase = info.compactionPhase;
      existing.lastEventAt = Date.now();
    } else {
      const runningToolCall = getLastRunningToolCall(Array.isArray(info.toolCalls) ? info.toolCalls : []);
      this.activeStreams.set(sessionKey, {
        active: true,
        phase: runningToolCall && info.phase !== 'tool' ? 'tool' : info.phase,
        toolName: info.toolName,
        toolCalls: Array.isArray(info.toolCalls) ? [...info.toolCalls] : [],
        statusText: nextStatusText || (info.phase === 'thinking' ? 'Thinking…' : undefined),
        provenance: info.provenance,
        model: info.model,
        compactionPhase: info.compactionPhase,
        startedAt: info.startedAt || Date.now(),
        runId: assertedRunId || undefined,
        latestText: this.latestText.get(sessionKey) || '',
        lastEventAt: Date.now(),
      });
    }
    return true;
  }

  /**
   * Mark a stream as started (called when PersistentGatewayWs sees first event).
   */
  startStream(sessionKey: string, runId?: string, info?: Partial<StreamInfo>): boolean {
    const assertedRunId = normalizedRunId(runId);
    const existing = this.activeStreams.get(sessionKey);
    const existingRunId = normalizedRunId(existing?.runId);
    if (existing?.active === false) return false;
    if (existingRunId && assertedRunId !== existingRunId) {
      return false;
    }
    const statusText = normalizeRailStatusText(info?.statusText) || 'Thinking…';
    if (!existing) {
      this.activeStreams.set(sessionKey, {
        active: true,
        phase: 'thinking',
        toolCalls: [],
        statusText,
        provenance: info?.provenance,
        model: info?.model,
        compactionPhase: info?.compactionPhase || 'idle',
        startedAt: Date.now(),
        runId: assertedRunId || undefined,
        latestText: this.latestText.get(sessionKey) || '',
        lastEventAt: Date.now(),
      });
    } else {
      const current = existing;
      current.active = true;
      if (assertedRunId) current.runId = assertedRunId;
      if (info?.provenance) current.provenance = info.provenance;
      if (info?.model) current.model = info.model;
      current.lastEventAt = Date.now();
      current.latestText = this.latestText.get(sessionKey) || current.latestText || '';
    }
    return true;
  }

  /**
   * Explicitly activate a dormant stream after an exact predecessor CAS.
   * Ordinary start/phase/publish calls deliberately cannot cross a terminal
   * boundary, so a delayed callback cannot revive a completed run.
   */
  resumeStream(sessionKey: string, runId: string, info?: Partial<StreamInfo>): boolean {
    const assertedRunId = normalizedRunId(runId);
    const existing = this.activeStreams.get(sessionKey);
    if (!assertedRunId
      || !existing
      || existing.active !== false
      || normalizedRunId(existing.runId) !== assertedRunId) {
      return false;
    }

    this.turnEventSeq.delete(sessionKey);
    this.recentTurnEvents.delete(sessionKey);
    existing.active = true;
    existing.phase = 'thinking';
    existing.startedAt = Date.now();
    existing.toolName = undefined;
    existing.toolCalls = [];
    existing.statusText = normalizeRailStatusText(info?.statusText) || 'Thinking…';
    existing.compactionPhase = info?.compactionPhase || 'idle';
    existing.latestText = this.latestText.get(sessionKey) || '';
    if (info?.provenance) existing.provenance = info.provenance;
    if (info?.model) existing.model = info.model;
    existing.lastEventAt = Date.now();
    delete existing.lastDoneAt;
    return true;
  }

  /**
   * Atomically replace the identity of a tracked stream. This is the only API
   * that may move an identified stream from one run ID to another. Dormant
   * streams remain dormant until startStream touches the newly adopted ID.
   */
  adoptStreamRun(
    sessionKey: string,
    expectedRunId: string | null,
    nextRunId: string,
    info?: Partial<StreamInfo>,
  ): boolean {
    const existing = this.activeStreams.get(sessionKey);
    const expected = normalizedRunId(expectedRunId);
    const next = normalizedRunId(nextRunId);
    const currentRunId = normalizedRunId(existing?.runId);
    if (!existing || !next || currentRunId !== expected) {
      return false;
    }

    const adoptedDormantRun = existing.active === false && currentRunId !== next;
    if (adoptedDormantRun) {
      this.turnEventSeq.delete(sessionKey);
      this.recentTurnEvents.delete(sessionKey);
    }

    const runningToolCall = getLastRunningToolCall(existing.toolCalls);
    if (info?.phase) {
      existing.phase = runningToolCall && info.phase !== 'tool' ? 'tool' : info.phase;
    }
    if ('toolName' in (info || {})) existing.toolName = info?.toolName;
    if (!existing.toolName && runningToolCall?.name) existing.toolName = runningToolCall.name;
    if (Array.isArray(info?.toolCalls)) existing.toolCalls = [...info.toolCalls];
    if ('statusText' in (info || {})) {
      const statusText = normalizeRailStatusText(info?.statusText);
      if (statusText) existing.statusText = statusText;
      else if (info?.statusText == null) existing.statusText = undefined;
    }
    if ('provenance' in (info || {})) existing.provenance = info?.provenance;
    if ('model' in (info || {})) existing.model = info?.model;
    if ('compactionPhase' in (info || {})) existing.compactionPhase = info?.compactionPhase;
    if (typeof info?.startedAt === 'number' && Number.isFinite(info.startedAt)) {
      existing.startedAt = info.startedAt;
    }
    existing.runId = next;
    existing.lastEventAt = Date.now();
    return true;
  }

  /**
   * Clear stream state for a session (stream completed or errored).
   */
  clearStream(sessionKey: string, expectedRunId?: string | null): boolean {
    const existing = this.activeStreams.get(sessionKey);
    if (expectedRunId !== undefined) {
      if (!existing || normalizedRunId(existing.runId) !== normalizedRunId(expectedRunId)) {
        return false;
      }
    }
    this.activeStreams.delete(sessionKey);
    this.lastSeenText.delete(sessionKey);
    this.latestText.delete(sessionKey);
    this.turnEventSeq.delete(sessionKey);
    this.recentTurnEvents.delete(sessionKey);
    return true;
  }

  /**
   * Return recent normalized turn events for reconnect/debugging.
   * This is intentionally independent from provider-specific raw events.
   */
  getRecentTurnEvents(sessionKey: string, limit = 100): RuntimeTurnEvent[] {
    const events = this.recentTurnEvents.get(sessionKey) || [];
    return events.slice(-Math.max(0, limit));
  }

  /**
   * Soft-clear stream state for a session (run segment completed, but new run may follow).
   * Preserves subscribers and listener registration. Resets text tracking so the next
   * run segment starts with a fresh accumulator. Records lastDoneAt for resumption detection.
   */
  softClearStream(sessionKey: string, expectedRunId?: string | null): boolean {
    const info = this.activeStreams.get(sessionKey);
    if (expectedRunId !== undefined) {
      if (!info || normalizedRunId(info.runId) !== normalizedRunId(expectedRunId)) {
        return false;
      }
    }
    const lastDoneAt = Date.now();
    // Preserve lastDoneAt in a minimal "dormant" entry so we can detect resumption
    this.activeStreams.set(sessionKey, {
      active: false,
      phase: 'thinking',
      toolName: info?.toolName,
      toolCalls: [],
      statusText: info?.statusText,
      provenance: info?.provenance,
      model: info?.model,
      compactionPhase: info?.compactionPhase,
      startedAt: info?.startedAt || lastDoneAt,
      runId: info?.runId,
      latestText: '',
      lastEventAt: lastDoneAt,
      lastDoneAt,
    });
    this.lastSeenText.delete(sessionKey);
    this.latestText.delete(sessionKey);
    // NOTE: listeners are NOT removed — they stay alive for the next run segment
    return true;
  }

  /**
   * Check if a session had a recent 'done' and is now potentially resuming.
   */
  wasRecentlyDone(sessionKey: string, withinMs: number = 300000): boolean {
    const info = this.activeStreams.get(sessionKey);
    if (!info || !info.lastDoneAt) return false;
    return Date.now() - info.lastDoneAt < withinMs;
  }

  /**
   * Get the last seen accumulated text for a session (for delta diffing).
   */
  getLastSeenText(sessionKey: string): string {
    return this.lastSeenText.get(sessionKey) || '';
  }

  /**
   * Update the last seen accumulated text for a session.
   */
  setLastSeenText(sessionKey: string, text: string): void {
    this.lastSeenText.set(sessionKey, text);
  }

  /**
   * Get the latest fully-assembled text snapshot for a session.
   */
  getLatestText(sessionKey: string): string {
    return this.latestText.get(sessionKey) || '';
  }

  /**
   * Replace the latest fully-assembled text snapshot for a session.
   */
  setLatestText(sessionKey: string, text: string): void {
    this.latestText.set(sessionKey, text);
    const info = this.activeStreams.get(sessionKey);
    if (info) {
      info.latestText = text;
      info.lastEventAt = Date.now();
    }
  }
}

/** Singleton instance */
export const streamEventBus = new StreamEventBus();
