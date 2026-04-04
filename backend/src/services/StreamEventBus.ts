/**
 * StreamEventBus — Single pub/sub channel for session-scoped stream events.
 * 
 * Key improvements:
 * - Subscriber deduplication (one sub per browser-WS per session)
 * - Event replay buffer for late-joining clients (last N events)
 * - Proper state transitions (no softClearStream hacks)
 * - Clean ref-counting without duplicates
 */

export interface StreamEvent {
  type: 'text' | 'thinking' | 'tool_start' | 'tool_end' | 'tool_used' | 'status' | 'done' | 'error' | 'segment_break' | 'compaction_start' | 'compaction_end' | 'run_resumed'
  content?: string
  toolName?: string
  toolArgs?: unknown
  toolResult?: string
  provenance?: string
  runId?: string
  sessionKey?: string
  [key: string]: unknown
}

export interface StreamInfo {
  active: boolean  // ← if false, this stream is "softly cleared" (dormant)
  phase: 'thinking' | 'tool' | 'streaming'
  toolName?: string
  startedAt: number
  runId?: string  // latest run identifier
  latestText: string  // assembled text so far
  thinkingContent?: string  // latest thinking snapshot for reconnect hydration
  statusText?: string  // latest status/rail text for reconnect hydration
  lastEventAt: number
  lastDoneAt?: number  // timestamp of last 'done' (for resumption detection)
}

type StreamCallback = (event: StreamEvent) => void
type GlobalCallback = (sessionKey: string, event: StreamEvent) => void

/** Lightweight ID for ref-count uniqueness checks */
type SubscriberId = string

class StreamEventBus {
  /** sessionKey → Map<subscriberId, callback> for perfect deduplication */
  private subscribers = new Map<string, Map<SubscriberId, StreamCallback>>()
  private counter = 0  // subscriberId generator

  /** Global listeners (any-session scope) */
  private globalListeners = new Set<GlobalCallback>()

  /** sessionKey → current active stream entry */
  private streams = new Map<string, StreamInfo>()

  /** sessionKey → full text accumulator (for reconnect recovery) */
  private completeText = new Map<string, string>()

  /** size-limited replay buffer per session for late-joiners */
  private replayBufs = new Map<string, StreamEvent[]>()
  private readonly REPLAY_BUF_MAX = 100  // last 100 events per session

  constructor() {
    const ONE_HOUR = 60 * 60 * 1000
    setInterval(() => {
      const now = Date.now()
      for (const [sessionKey, info] of this.streams) {
        const subMap = this.subscribers.get(sessionKey)
        const hasNoSubs = !subMap || subMap.size === 0
        if (info.lastDoneAt && (now - info.lastDoneAt) > ONE_HOUR && hasNoSubs) {
          this.clearStream(sessionKey)  // hard clear now (safe to delete)
        }
      }
    }, 15 * 60 * 1000)  // every 15 m
  }

  /* ---- Subscription helpers ---- */

  /**
   * Subscribe to events for a session.
   * Returns an unsubscribe function (backward compatible).
   */
  subscribe(
    sessionKey: string,
    callback: StreamCallback
  ): () => void {
    const id = `${++this.counter}-${Date.now()}`  // unique subscriber id

    let map = this.subscribers.get(sessionKey)
    if (!map) {
      map = new Map()
      this.subscribers.set(sessionKey, map)
    } else {
      // Deduplicate: prevent registering the exact same callback twice
      for (const [existingId, exCb] of map.entries()) {
        if (exCb === callback) {
          // Already subscribed — return the real unsubscribe for the existing subscription
          return () => this.unsubscribe(sessionKey, existingId)
        }
      }
    }

    map.set(id, callback)
    return () => this.unsubscribe(sessionKey, id)
  }

  /**
   * Subscribe to events for a session with replay buffer.
   * Returns both an unsubscribe function and the replay events.
   */
  subscribeWithReplay(
    sessionKey: string,
    callback: StreamCallback
  ): { unsubscribe: () => void; replay: StreamEvent[] } {
    const id = `${++this.counter}-${Date.now()}`  // unique subscriber id

    let map = this.subscribers.get(sessionKey)
    if (!map) {
      map = new Map()
      this.subscribers.set(sessionKey, map)
    } else {
      // Deduplicate: prevent registering the exact same callback twice
      for (const [existingId, exCb] of map.entries()) {
        if (exCb === callback) {
          // Already subscribed — return the real unsubscribe + replay for the existing subscription
          return {
            unsubscribe: () => this.unsubscribe(sessionKey, existingId),
            replay: this.replayBufs.get(sessionKey) || [],
          }
        }
      }
    }

    map.set(id, callback)

    return {
      unsubscribe: () => this.unsubscribe(sessionKey, id),
      replay: this.replayBufs.get(sessionKey) || [],
    }
  }

  /**
   * Unregister a subscriber by id only (safe re-entrant).
   */
  private unsubscribe(sessionKey: string, id: SubscriberId): void {
    const map = this.subscribers.get(sessionKey)
    if (!map) return
    map.delete(id)
    if (map.size === 0) {
      this.subscribers.delete(sessionKey)
    }
  }

  hasSubscribers(sessionKey: string): boolean {
    return (this.subscribers.get(sessionKey)?.size || 0) > 0
  }

  /**
   * Subscribe to ALL events (any session, for compaction/sys forwarding).
   */
  subscribeGlobal(callback: GlobalCallback): () => void {
    this.globalListeners.add(callback)
    return () => this.globalListeners.delete(callback)
  }

  /* ---- Stream tracking helpers ---- */

  /**
   * Get current live stream for a session (null if inactive).
   */
  getStreamStatus(sessionKey: string): StreamInfo | null {
    return this.streams.get(sessionKey) || null
  }

  /**
   * Start or update a stream entry.
   * Caller attaches runId.
   */
  startStream(sessionKey: string, runId?: string): void {
    if (!this.streams.get(sessionKey)) {
      this.streams.set(sessionKey, {
        active: true,
        phase: 'thinking',
        startedAt: Date.now(),
        latestText: this.completeText.get(sessionKey) || '',
        thinkingContent: '',
        statusText: '',
        lastEventAt: Date.now(),
        runId: runId || undefined,
      })
    } else {
      const s = this.streams.get(sessionKey)!
      s.active = true
      s.phase = 'thinking'
      s.lastEventAt = Date.now()
      if (runId) s.runId = runId
      s.latestText = this.completeText.get(sessionKey) || s.latestText || ''
      s.thinkingContent = ''
      s.statusText = ''
    }
  }

  /**
   * End current stream cleanly (sets active=false, keeps provenance).
   * Next subscribe() to this session will be offered a fresh run.
   */
  endStream(sessionKey: string): void {
    const s = this.streams.get(sessionKey)
    if (s) {
      s.active = false
      s.lastEventAt = Date.now()
      s.lastDoneAt = Date.now()
    }
    
    // Keep global listeners alive for future runs (cleanup handled in interval)
  }

  /**
   * Update the phase of an active stream (backward compatibility).
   */
  updateStreamPhase(sessionKey: string, info: Partial<Pick<StreamInfo, 'phase' | 'toolName'>>): void {
    const s = this.streams.get(sessionKey)
    if (s) {
      if (info.phase !== undefined) s.phase = info.phase
      if (info.toolName !== undefined) s.toolName = info.toolName
      s.lastEventAt = Date.now()
    }
  }

  /**
   * Check if a stream was recently done (for resumption detection).
   */
  wasRecentlyDone(sessionKey: string, withinMs = 30000): boolean {
    const s = this.streams.get(sessionKey)
    if (!s || !s.lastDoneAt) return false
    return (Date.now() - s.lastDoneAt) < withinMs
  }

  /**
   * Soft clear a stream (backward compatibility - delegates to endStream).
   */
  softClearStream(sessionKey: string): void {
    this.endStream(sessionKey)
  }

  /**
   * Hard clear (stream error / explicit reset).
   */
  clearStream(sessionKey: string): void {
    this.streams.delete(sessionKey)
    this.completeText.delete(sessionKey)
    this.replayBufs.delete(sessionKey)
  }

  /**
   * Text helpers (kept for callers who cache deltas).
   */
  getLatestText(sessionKey: string): string {
    return this.completeText.get(sessionKey) || ''
  }

  setLatestText(sessionKey: string, text: string): void {
    this.completeText.set(sessionKey, text)
  }

  getLastSeenText(sessionKey: string): string {
    return this.seenText.get(sessionKey) || ''
  }

  setLastSeenText(sessionKey: string, text: string): void {
    this.seenText.set(sessionKey, text)
  }

  private seenText = new Map<string, string>()

  /* ---- Publishing helpers ---- */

  /**
   * Publish an event to a session.
   * Keeps replay buffer up-to-date and forwards to global listeners as needed.
   */
  publish(sessionKey: string, event: StreamEvent): void {

    const stream = this.streams.get(sessionKey)
    if (stream) {
      if (event.type === 'thinking') {
        stream.thinkingContent = typeof event.content === 'string' ? event.content : (stream.thinkingContent || '')
      } else if (event.type === 'status') {
        stream.statusText = typeof event.content === 'string' ? event.content : ''
      } else if (event.type === 'tool_start') {
        stream.statusText = typeof event.content === 'string' && event.content
          ? event.content
          : (event.toolName ? `Using ${event.toolName}…` : '')
      } else if (event.type === 'tool_end' || event.type === 'tool_used') {
        stream.statusText = ''
      } else if (event.type === 'done') {
        stream.statusText = ''
      } else if (event.type === 'error') {
        stream.statusText = typeof event.content === 'string' ? event.content : ''
      }
    }

    // build or update text cache
    if (event.type === 'text') {
      const prev = this.completeText.get(sessionKey) || ''
      const next = (event.replace === true)
        ? (typeof event.content === 'string' ? event.content : '')
        : prev + (typeof event.content === 'string' && event.content)
      this.completeText.set(sessionKey, next)
    } else if (event.type === 'done') {
      const final = (typeof event.content === 'string' && event.content)
        ? event.content
        : (this.completeText.get(sessionKey) || '')
      this.completeText.set(sessionKey, final)
    }

    // push into replay buffer (tailing list)
    let buf = this.replayBufs.get(sessionKey)
    if (!buf) {
      buf = []
      this.replayBufs.set(sessionKey, buf)
    }
    buf.push(event)
    if (buf.length > this.REPLAY_BUF_MAX) {  // keep fixed size
      buf = buf.slice(-this.REPLAY_BUF_MAX)
      this.replayBufs.set(sessionKey, buf)
    }

    // forward to local subscribers for THIS session
    const subs = this.subscribers.get(sessionKey)
    if (subs?.size) {
      for (const cb of subs.values()) {
        try { cb(event) }
        catch (err) {
          console.error(`[StreamEventBus] Subscriber error:`, err)
        }
      }
    }

    // Forward to global listeners for compaction or when no subscribers.
    const isCompaction = event.type === 'compaction_start' || event.type === 'compaction_end'
    const noLocalSubs = !subs || subs.size === 0
    if (isCompaction || noLocalSubs) {
      for (const cb of this.globalListeners) {
        try { cb(sessionKey, event)}
        catch (err) {
          console.error(`[StreamEventBus] GlobalListener error:`, err)
        }
      }
    }
  }

}

/**
 * Centralized bus instance used by the codebase.
 */
export const streamEventBus = new StreamEventBus()

export default streamEventBus
