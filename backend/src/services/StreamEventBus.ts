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
    if (event.type === 'text') {
      const isReplace = event.replace === true;
      const nextText = isReplace
        ? (typeof event.content === 'string' ? event.content : '')
        : (this.latestText.get(sessionKey) || '') + (typeof event.content === 'string' ? event.content : '');
      this.latestText.set(sessionKey, nextText);
      const info = this.activeStreams.get(sessionKey);
      if (info) {
        info.latestText = nextText;
        info.lastEventAt = Date.now();
      }
    } else if (event.type === 'done') {
      const finalText = typeof event.content === 'string' && event.content.length > 0
        ? event.content
        : (this.latestText.get(sessionKey) || '');
      this.latestText.set(sessionKey, finalText);
      const info = this.activeStreams.get(sessionKey);
      if (info) {
        info.latestText = finalText;
        info.lastEventAt = Date.now();
      }
    } else {
      const info = this.activeStreams.get(sessionKey);
      if (info) info.lastEventAt = Date.now();
    }

    const subs = this.listeners.get(sessionKey);
    if (subs && subs.size > 1 && event.type === 'text') {
      // Only log once per 10 seconds to avoid log spam
      const now = Date.now();
      const lastWarnKey = `__lastDupWarn_${sessionKey}`;
      const lastWarn = (this as any)[lastWarnKey] || 0;
      if (now - lastWarn > 10000) {
        (this as any)[lastWarnKey] = now;
        console.warn(`[StreamEventBus] ⚠️ DUPLICATE SUBS: ${subs.size} subscribers for ${sessionKey} on text event (len=${(event.content||'').length}). Consider checking registerWsStreamCleanup lifecycle.`);
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
    return this.activeStreams.get(sessionKey) || null;
  }

  /**
   * Update the stream phase for a session. Creates the entry if needed.
   */
  updateStreamPhase(sessionKey: string, info: Partial<StreamInfo> & { phase: StreamInfo['phase'] }): void {
    const existing = this.activeStreams.get(sessionKey);
    if (existing) {
      existing.phase = info.phase;
      if (info.toolName !== undefined) existing.toolName = info.toolName;
      if (info.runId !== undefined) existing.runId = info.runId;
    } else {
      this.activeStreams.set(sessionKey, {
        active: true,
        phase: info.phase,
        toolName: info.toolName,
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
  startStream(sessionKey: string, runId?: string): void {
    if (!this.activeStreams.has(sessionKey)) {
      this.activeStreams.set(sessionKey, {
        active: true,
        phase: 'thinking',
        startedAt: Date.now(),
        runId,
        latestText: this.latestText.get(sessionKey) || '',
        lastEventAt: Date.now(),
      });
    } else {
      const info = this.activeStreams.get(sessionKey)!;
      if (runId) info.runId = runId;
      info.lastEventAt = Date.now();
      info.latestText = this.latestText.get(sessionKey) || info.latestText || '';
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
