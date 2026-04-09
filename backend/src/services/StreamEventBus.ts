/**
 * StreamEventBus — Singleton pub/sub for session-scoped stream events.
 *
 * Tracks active streams and distributes events from PersistentGatewayWs
 * to browser WS clients. Replaces the per-handler `activeStreams` Map
 * in gateway.ts so that stream status survives handler lifecycle.
 */

export interface StreamEvent {
  type: 'text' | 'thinking' | 'tool_start' | 'tool_end' | 'tool_used' | 'status' | 'done' | 'error' | 'segment_break' | 'compaction_start' | 'compaction_end' | 'run_resumed';
  content?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: string;
  provenance?: string;
  [key: string]: unknown;
}

export interface StreamInfo {
  active: boolean;
  phase: 'thinking' | 'tool' | 'streaming';
  toolName?: string;
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

class StreamEventBus {
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

  /** Backwards-compatible alias for activeStreams */
  private get activeStreams(): Map<string, StreamInfo> {
    return this.streams;
  }

  constructor() {
    // Prune dormant entries older than 1 hour every 15 minutes
    const ONE_HOUR = 60 * 60 * 1000;
    setInterval(() => {
      const now = Date.now();
      for (const [sessionKey, info] of this.streams) {
        const subs = this.listeners.get(sessionKey);
        const hasNoSubscribers = !subs || subs.size === 0;
        if (info.lastDoneAt && (now - info.lastDoneAt) > ONE_HOUR && hasNoSubscribers) {
          this.streams.delete(sessionKey);
          this.lastSeenText.delete(sessionKey);
          this.latestText.delete(sessionKey);
        }
      }
    }, 15 * 60 * 1000);
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
    const now = Date.now();
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
        info.statusText = typeof event.content === 'string' && event.content.trim() ? event.content.trim() : 'Thinking…';
      } else if (event.type === 'status') {
        info.statusText = typeof event.content === 'string' && event.content.trim() ? event.content.trim() : info.statusText;
      } else if (event.type === 'tool_start') {
        info.toolName = typeof event.toolName === 'string' && event.toolName.trim() ? event.toolName.trim() : info.toolName;
        info.statusText = info.toolName ? `Using ${info.toolName}…` : info.statusText;
      } else if (event.type === 'tool_end') {
        info.statusText = undefined;
      } else if (event.type === 'compaction_start') {
        info.compactionPhase = 'compacting';
        info.statusText = typeof event.content === 'string' && event.content.trim() ? event.content.trim() : 'Compacting context…';
      } else if (event.type === 'compaction_end') {
        info.compactionPhase = 'compacted';
        info.statusText = typeof event.content === 'string' && event.content.trim() ? event.content.trim() : 'Context compacted';
      } else if (event.type === 'run_resumed') {
        info.statusText = 'Resuming stream…';
      }
    }

    const subs = this.listeners.get(sessionKey);
    if (subs && subs.size > 2 && event.type === 'text') {
      // Two subscribers is normal during portal streaming: one OpenClawProvider waiter
      // plus one browser forwarder. Warn only when we exceed that expected baseline.
      const now = Date.now();
      const lastWarnKey = `__lastDupWarn_${sessionKey}`;
      const lastWarn = (this as any)[lastWarnKey] || 0;
      if (now - lastWarn > 10000) {
        (this as any)[lastWarnKey] = now;
        console.warn(`[StreamEventBus] ⚠️ EXTRA SUBS: ${subs.size} subscribers for ${sessionKey} on text event (expected <= 2). Check registerWsStreamCleanup / reconnect lifecycle.`);
      }
    }
    if (subs && subs.size > 0) {
      for (const cb of subs) {
        try {
          cb(event);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[StreamEventBus] Subscriber error for ${sessionKey}: ${msg}`);
        }
      }
    }

    // Notify global listeners when:
    // 1. No per-session subscribers exist (the global listener is the only path
    //    to forward events — covers post-restart, compaction, etc.)
    // 2. Always for compaction events (they need to reach the browser even when
    //    per-session subscribers exist, though the gateway handler deduplicates)
    const noPerSessionSubs = !subs || subs.size === 0;
    const isCompaction = event.type === 'compaction_start' || event.type === 'compaction_end';
    if (noPerSessionSubs || isCompaction) {
      for (const cb of this.globalListeners) {
        try {
          cb(sessionKey, event);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[StreamEventBus] Global listener error: ${msg}`);
        }
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
  updateStreamPhase(sessionKey: string, info: Partial<StreamInfo> & { phase: StreamInfo['phase'] }): void {
    const existing = this.activeStreams.get(sessionKey);
    if (existing) {
      const wasDormant = existing.active === false;
      existing.active = true;
      existing.phase = info.phase;
      if ('toolName' in info) existing.toolName = info.toolName;
      if ('runId' in info) existing.runId = info.runId;
      if ('statusText' in info) existing.statusText = info.statusText;
      if ('provenance' in info) existing.provenance = info.provenance;
      if ('model' in info) existing.model = info.model;
      if ('compactionPhase' in info) existing.compactionPhase = info.compactionPhase;
      if (wasDormant) {
        existing.startedAt = info.startedAt || Date.now();
        existing.latestText = this.latestText.get(sessionKey) || '';
        delete existing.lastDoneAt;
      }
      existing.lastEventAt = Date.now();
    } else {
      this.activeStreams.set(sessionKey, {
        active: true,
        phase: info.phase,
        toolName: info.toolName,
        statusText: info.statusText,
        provenance: info.provenance,
        model: info.model,
        compactionPhase: info.compactionPhase,
        startedAt: info.startedAt || Date.now(),
        runId: info.runId,
        latestText: this.latestText.get(sessionKey) || '',
        lastEventAt: Date.now(),
      });
    }
  }

  /**
   * Mark a stream as started (called when PersistentGatewayWs sees first event).
   */
  startStream(sessionKey: string, runId?: string, info?: Partial<StreamInfo>): void {
    if (!this.activeStreams.has(sessionKey)) {
      this.activeStreams.set(sessionKey, {
        active: true,
        phase: 'thinking',
        statusText: info?.statusText || 'Thinking…',
        provenance: info?.provenance,
        model: info?.model,
        compactionPhase: info?.compactionPhase || 'idle',
        startedAt: Date.now(),
        runId,
        latestText: this.latestText.get(sessionKey) || '',
        lastEventAt: Date.now(),
      });
    } else {
      const current = this.activeStreams.get(sessionKey)!;
      const wasDormant = current.active === false;
      current.active = true;
      if (wasDormant) {
        current.phase = 'thinking';
        current.startedAt = Date.now();
        current.toolName = undefined;
        current.statusText = info?.statusText || 'Thinking…';
        current.compactionPhase = info?.compactionPhase || 'idle';
        current.latestText = this.latestText.get(sessionKey) || '';
        delete current.lastDoneAt;
      }
      if (runId) current.runId = runId;
      if (info?.provenance) current.provenance = info.provenance;
      if (info?.model) current.model = info.model;
      current.lastEventAt = Date.now();
      current.latestText = this.latestText.get(sessionKey) || current.latestText || '';
    }
  }

  /**
   * Clear stream state for a session (stream completed or errored).
   */
  clearStream(sessionKey: string): void {
    this.activeStreams.delete(sessionKey);
    this.lastSeenText.delete(sessionKey);
    this.latestText.delete(sessionKey);
  }

  /**
   * Soft-clear stream state for a session (run segment completed, but new run may follow).
   * Preserves subscribers and listener registration. Resets text tracking so the next
   * run segment starts with a fresh accumulator. Records lastDoneAt for resumption detection.
   */
  softClearStream(sessionKey: string): void {
    const info = this.activeStreams.get(sessionKey);
    const lastDoneAt = Date.now();
    // Preserve lastDoneAt in a minimal "dormant" entry so we can detect resumption
    this.activeStreams.set(sessionKey, {
      active: false,
      phase: 'thinking',
      toolName: info?.toolName,
      statusText: info?.statusText,
      provenance: info?.provenance,
      model: info?.model,
      compactionPhase: info?.compactionPhase,
      startedAt: info?.startedAt || lastDoneAt,
      latestText: '',
      lastEventAt: lastDoneAt,
      lastDoneAt,
    });
    this.lastSeenText.delete(sessionKey);
    this.latestText.delete(sessionKey);
    // NOTE: listeners are NOT removed — they stay alive for the next run segment
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
