/**
 * StreamManager — Single class managing stream state for ALL sessions.
 *
 * This replaces the per-component WebSocket management in both ChatStateProvider
 * and ProjectChatPanel. Sessions can be subscribed/unsubscribed independently,
 * and reconnection is handled gracefully.
 *
 * Key features:
 * - Single WebSocket connection shared across all sessions
 * - Proper subscriber deduplication (one sub per component per session)
 * - Reconnection recovery with state query and event replay
 * - React-friendly hooks: useSessionStream(sessionKey)
 */

import {
  extractThinkingChunk,
  mergeAssistantStream,
  mergeThinkingStream,
  sanitizeAssistantContent,
  sanitizeAssistantChunk,
} from '../utils/chatStream';

/* ═══ Types ═══ */

export type StreamPhase = 'idle' | 'thinking' | 'streaming' | 'tool' | 'done';

export interface StreamEvent {
  type: string;
  content?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: string;
  provenance?: string;
  sessionKey?: string;
  replace?: boolean;
  phase?: StreamPhase;
  runId?: string;
  [key: string]: unknown;
}

export interface SessionStreamState {
  phase: StreamPhase;
  toolName: string | null;
  latestText: string;
  thinkingContent: string;
  statusText: string | null;
  runId: string | null;
  lastEventAt: number;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments?: unknown;
  startedAt: number;
  endedAt?: number;
  result?: string;
  status: 'running' | 'done' | 'error';
}

type StreamEventCallback = (event: StreamEvent) => void;

type StateChangeCallback = (state: SessionStreamState) => void;

interface SessionSubscription {
  id: string;
  eventCallback: StreamEventCallback;
  stateCallback?: StateChangeCallback;
}

/* ═══ WebSocket Manager ═══ */

type WsEventHandler = (data: StreamEvent) => void;

interface WsManager {
  send: (data: unknown) => boolean;
  addHandler: (handler: WsEventHandler) => void;
  removeHandler: (handler: WsEventHandler) => void;
  isConnected: () => boolean;
  onReconnect: (cb: () => void) => () => void;
  onDisconnect: (cb: () => void) => () => void;
  reconnect: () => void;
  close: () => void;
}

function createWsManager(url: string): WsManager {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let intentionallyClosed = false;
  let wasConnectedBefore = false;
  const handlers = new Set<WsEventHandler>();
  const disconnectCallbacks = new Set<() => void>();
  const reconnectCallbacks = new Set<() => void>();

  function connect() {
    if (intentionallyClosed) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      const isReconnect = wasConnectedBefore;
      wasConnectedBefore = true;
      reconnectAttempts = 0;
      if (isReconnect) {
        for (const cb of reconnectCallbacks) {
          try { cb(); } catch (e) { console.error('[StreamManager] reconnect callback error:', e); }
        }
      }
    };

    ws.onmessage = (event) => {
      let data: StreamEvent;
      try { data = JSON.parse(event.data); } catch { return; }
      for (const handler of handlers) {
        try { handler(data); } catch (err) { console.error('[StreamManager] Handler error:', err); }
      }
    };

    ws.onclose = () => {
      ws = null;
      if (!intentionallyClosed) {
        for (const cb of disconnectCallbacks) {
          try { cb(); } catch (e) { console.error('[StreamManager] disconnect callback error:', e); }
        }
        scheduleReconnect();
      }
    };

    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    if (reconnectTimer || intentionallyClosed) return;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  connect();

  return {
    send(data: unknown): boolean {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      try { ws.send(JSON.stringify(data)); return true; } catch { return false; }
    },
    addHandler(handler: WsEventHandler) { handlers.add(handler); },
    removeHandler(handler: WsEventHandler) { handlers.delete(handler); },
    isConnected() { return ws !== null && ws.readyState === WebSocket.OPEN; },
    onReconnect(cb: () => void) {
      reconnectCallbacks.add(cb);
      return () => { reconnectCallbacks.delete(cb); };
    },
    onDisconnect(cb: () => void) {
      disconnectCallbacks.add(cb);
      return () => { disconnectCallbacks.delete(cb); };
    },
    reconnect() {
      intentionallyClosed = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { try { ws.close(); } catch {} ws = null; }
      connect();
    },
    close() {
      intentionallyClosed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { try { ws.close(); } catch {} ws = null; }
      handlers.clear();
      disconnectCallbacks.clear();
      reconnectCallbacks.clear();
    },
  };
}

/* ═══ StreamManager ═══ */

class StreamManager {
  private ws: WsManager | null = null;
  private wsUrl: string = '';
  
  /** sessionKey → Map<subscriberId, subscription> */
  private subscriptions = new Map<string, Map<string, SessionSubscription>>();
  
  /** sessionKey → current stream state */
  private sessionStates = new Map<string, SessionStreamState>();
  
  /** Counter for generating unique subscription IDs */
  private subIdCounter = 0;
  
  /** Track connected state for React hooks */
  private connected = false;
  
  /** Callbacks for connection state changes */
  private connectionCallbacks = new Set<(connected: boolean) => void>();
  
  /** Global handlers that receive ALL events (unfiltered by session) */
  private globalHandlers = new Set<(event: StreamEvent) => void>();
  
  /** Disconnect/reconnect callbacks */
  private disconnectCallbacks = new Set<() => void>();
  private reconnectCallbacks = new Set<() => void>();
  
  constructor() {
    // Determine WebSocket URL
    if (typeof window !== 'undefined') {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const apiUrl = (window as any).VITE_API_URL || '';
      if (apiUrl) {
        if (apiUrl.startsWith('http')) {
          this.wsUrl = apiUrl.replace(/^http/, 'ws') + '/gateway/ws';
        } else {
          this.wsUrl = protocol + '//' + window.location.host + apiUrl + '/gateway/ws';
        }
      } else {
        this.wsUrl = protocol + '//' + window.location.host + '/api/gateway/ws';
      }
    }
  }
  
  /**
   * Initialize the WebSocket connection.
   * Call this once on app startup.
   */
  init(): void {
    if (this.ws) return;
    
    this.ws = createWsManager(this.wsUrl);
    
    // Handle incoming events
    this.ws.addHandler((event) => this.handleEvent(event));
    
    // Handle reconnection
    this.ws.onReconnect(() => {
      this.connected = true;
      this.notifyConnectionChange(true);
      for (const cb of this.reconnectCallbacks) {
        try { cb(); } catch (err) { console.error('[StreamManager] reconnect callback error:', err); }
      }
      // Resubscribe to active sessions
      this.resubscribeActiveSessions();
    });
    
    this.ws.onDisconnect(() => {
      this.connected = false;
      this.notifyConnectionChange(false);
      for (const cb of this.disconnectCallbacks) {
        try { cb(); } catch (err) { console.error('[StreamManager] disconnect callback error:', err); }
      }
    });
    
    // Initial connection
    if (this.ws.isConnected()) {
      this.connected = true;
    }
  }
  
  /**
   * Clean up the WebSocket connection.
   * Call this on app unmount.
   */
  destroy(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscriptions.clear();
    this.sessionStates.clear();
    this.connectionCallbacks.clear();
    this.globalHandlers.clear();
    this.disconnectCallbacks.clear();
    this.reconnectCallbacks.clear();
    this.connected = false;
  }
  
  /**
   * Subscribe to stream events for a session.
   * Returns subscription ID and unsubscribe function.
   */
  subscribe(
    sessionKey: string,
    eventCallback: StreamEventCallback,
    stateCallback?: StateChangeCallback
  ): { id: string; unsubscribe: () => void } {
    const id = `stream-sub-${++this.subIdCounter}-${Date.now()}`;
    
    let subs = this.subscriptions.get(sessionKey);
    if (!subs) {
      subs = new Map();
      this.subscriptions.set(sessionKey, subs);
    }
    
    subs.set(id, { id, eventCallback, stateCallback });
    
    // Send current state to new subscriber
    const state = this.sessionStates.get(sessionKey);
    if (state && stateCallback) {
      stateCallback(state);
    }
    
    return {
      id,
      unsubscribe: () => this.unsubscribe(sessionKey, id),
    };
  }
  
  /**
   * Unsubscribe from a session.
   */
  unsubscribe(sessionKey: string, subscriptionId: string): void {
    const subs = this.subscriptions.get(sessionKey);
    if (!subs) return;
    
    subs.delete(subscriptionId);
    
    if (subs.size === 0) {
      this.subscriptions.delete(sessionKey);
    }
  }
  
  /**
   * Get current stream state for a session.
   */
  getSessionState(sessionKey: string): SessionStreamState | null {
    return this.sessionStates.get(sessionKey) || null;
  }
  
  /**
   * Check if we have any subscribers for a session.
   */
  hasSubscribers(sessionKey: string): boolean {
    const subs = this.subscriptions.get(sessionKey);
    return !!subs && subs.size > 0;
  }
  
  /**
   * Check if WebSocket is connected.
   */
  isConnected(): boolean {
    return this.ws?.isConnected() ?? false;
  }
  
  /**
   * Subscribe to connection state changes.
   */
  onConnectionChange(callback: (connected: boolean) => void): () => void {
    this.connectionCallbacks.add(callback);
    // Immediately call with current state
    callback(this.connected);
    return () => this.connectionCallbacks.delete(callback);
  }
  
  /**
   * Send a message through the WebSocket.
   */
  send(data: unknown): boolean {
    const sent = this.ws?.send(data) ?? false;
    if (!sent) {
      console.warn("[StreamManager] send() failed — WS not connected. Data:", typeof data === "object" ? (data as any)?.type : "unknown");
    }
    return sent;
  }
  
  /**
   * Request history for a session.
   */
  requestHistory(sessionKey: string, provider: string = 'OPENCLAW', requestId?: string): void {
    this.send({
      type: 'history',
      session: sessionKey,
      provider,
      requestId: requestId || `hist-${Date.now()}`,
    });
  }
  
  /**
   * Send a chat message.
   */
  sendMessage(params: {
    sessionKey: string;
    message: string;
    provider?: string;
    agentId?: string;
    model?: string;
  }): void {
    this.send({
      type: 'send',
      message: params.message,
      session: params.sessionKey,
      provider: params.provider || 'OPENCLAW',
      agentId: params.agentId,
      model: params.model,
    });
  }
  
  /**
   * Abort an active stream.
   */
  abort(sessionKey: string): void {
    this.send({ type: 'abort', session: sessionKey });
    // Clean up local state
    const state = this.sessionStates.get(sessionKey);
    if (state) {
      state.phase = 'idle';
      state.toolName = null;
      state.lastEventAt = Date.now();
      this.notifyStateChange(sessionKey, state);
    }
  }
  
  /**
   * Request reconnection to an active stream.
   */
  reconnectToSession(sessionKey: string): void {
    this.send({ type: 'reconnect', session: sessionKey });
  }
  
  /**
   * Start tracking a new stream for a session.
   */
  startStream(sessionKey: string, runId?: string): void {
    const state: SessionStreamState = {
      phase: 'thinking',
      toolName: null,
      latestText: '',
      thinkingContent: '',
      statusText: null,
      runId: runId || null,
      lastEventAt: Date.now(),
    };
    this.sessionStates.set(sessionKey, state);
    this.notifyStateChange(sessionKey, state);
  }
  
  /**
   * Clear stream state for a session.
   */
  clearStream(sessionKey: string): void {
    this.sessionStates.delete(sessionKey);
  }
  
  /**
   * Handle incoming WebSocket event.
   */
  private handleEvent(event: StreamEvent): void {
    // Invoke global handlers first — they receive ALL events unfiltered
    for (const handler of this.globalHandlers) {
      try { handler(event); } catch (err) { console.error('[StreamManager] Global handler error:', err); }
    }
    
    const sessionKey = event.sessionKey;
    
    // Handle global events (not session-specific)
    if (!sessionKey) {
      if (event.type === 'connected') {
        this.connected = true;
        this.notifyConnectionChange(true);
      }
      return;
    }
    
    // Update session state based on event
    this.updateStateFromEvent(sessionKey, event);
    
    // Forward event to all subscribers for this session
    const subs = this.subscriptions.get(sessionKey);
    if (subs && subs.size > 0) {
      for (const sub of subs.values()) {
        try {
          sub.eventCallback(event);
        } catch (err) {
          console.error('[StreamManager] Event callback error:', err);
        }
      }
    }
  }
  
  /**
   * Update session state based on event type.
   */
  private updateStateFromEvent(sessionKey: string, event: StreamEvent): void {
    let state = this.sessionStates.get(sessionKey);
    
    if (!state) {
      state = {
        phase: 'thinking',
        toolName: null,
        latestText: '',
        thinkingContent: '',
        statusText: null,
        runId: null,
        lastEventAt: Date.now(),
      };
      this.sessionStates.set(sessionKey, state);
    }
    
    state.lastEventAt = Date.now();
    
    switch (event.type) {
      case 'thinking':
        state.phase = state.latestText ? 'streaming' : 'thinking';
        if (typeof event.content === 'string') {
          state.thinkingContent = mergeThinkingStream(
            state.thinkingContent,
            extractThinkingChunk('thinking', event.content, state.latestText.length > 0)
          );
        }
        break;
        
      case 'status':
        state.statusText = typeof event.content === 'string' ? event.content : state.statusText;
        if (state.phase === 'idle' || state.phase === 'done') {
          state.phase = 'thinking';
        }
        break;
        
      case 'tool_start':
        state.phase = 'tool';
        state.toolName = event.toolName || null;
        state.statusText = typeof event.content === 'string' && event.content
          ? event.content
          : (event.toolName ? `Using ${event.toolName}…` : state.statusText);
        break;
        
      case 'tool_end':
      case 'tool_used':
        state.toolName = null;
        state.statusText = null;
        state.phase = state.latestText ? 'streaming' : 'thinking';
        break;
        
      case 'text':
        state.phase = 'streaming';
        state.toolName = null;
        state.statusText = null;
        if (typeof event.content === 'string') {
          const safeChunk = event.replace === true
            ? sanitizeAssistantContent(event.content)
            : sanitizeAssistantChunk(event.content);
          state.latestText = mergeAssistantStream(
            state.latestText,
            safeChunk,
            { replace: event.replace === true }
          );
        }
        break;
        
      case 'done':
        state.phase = 'done';
        state.statusText = null;
        if (typeof event.content === 'string' && event.content.length > 0) {
          state.latestText = sanitizeAssistantContent(event.content);
        }
        break;
        
      case 'error':
        state.phase = 'idle';
        state.statusText = typeof event.content === 'string' ? event.content : null;
        break;
        
      case 'stream_resume':
        // Reconnected to an active stream
        state.phase = (event.phase as StreamPhase) || 'thinking';
        state.toolName = event.toolName as string | null;
        state.runId = event.runId as string | null;
        state.statusText = typeof event.statusText === 'string' ? event.statusText : state.statusText;
        if (typeof event.thinkingContent === 'string') {
          state.thinkingContent = event.thinkingContent;
        }
        if (typeof event.content === 'string') {
          state.latestText = sanitizeAssistantContent(event.content);
        }
        break;
        
      case 'run_resumed':
        // Stream resumed after sub-agent
        state.phase = 'thinking';
        state.runId = (event.runId as string) || null;
        state.statusText = 'Agent resumed…';
        break;
    }
    
    this.notifyStateChange(sessionKey, state);
  }
  
  /**
   * Notify all subscribers of state change.
   */
  private notifyStateChange(sessionKey: string, state: SessionStreamState): void {
    const subs = this.subscriptions.get(sessionKey);
    if (!subs) return;
    
    for (const sub of subs.values()) {
      if (sub.stateCallback) {
        try {
          sub.stateCallback(state);
        } catch (err) {
          console.error('[StreamManager] State callback error:', err);
        }
      }
    }
  }
  
  /**
   * Notify all connection listeners of state change.
   */
  private notifyConnectionChange(connected: boolean): void {
    for (const cb of this.connectionCallbacks) {
      try {
        cb(connected);
      } catch (err) {
        console.error('[StreamManager] Connection callback error:', err);
      }
    }
  }
  
  /**
   * Register a global handler that receives ALL events (unfiltered by session).
   * Returns an unsubscribe function.
   */
  addGlobalHandler(handler: (event: StreamEvent) => void): () => void {
    this.globalHandlers.add(handler);
    return () => { this.globalHandlers.delete(handler); };
  }
  
  /**
   * Register a callback for WebSocket disconnection.
   * Returns an unsubscribe function.
   */
  onDisconnect(cb: () => void): () => void {
    this.disconnectCallbacks.add(cb);
    return () => { this.disconnectCallbacks.delete(cb); };
  }
  
  /**
   * Register a callback for WebSocket reconnection.
   * Returns an unsubscribe function.
   */
  onReconnect(cb: () => void): () => void {
    this.reconnectCallbacks.add(cb);
    return () => { this.reconnectCallbacks.delete(cb); };
  }
  
  /**
   * Force reconnect the WebSocket connection.
   */
  reconnect(): void {
    this.ws?.reconnect();
  }
  
  /**
   * Resubscribe to active sessions after reconnection.
   */
  private resubscribeActiveSessions(): void {
    for (const [sessionKey, state] of this.sessionStates) {
      if (state.phase !== 'idle' && state.phase !== 'done') {
        // Send reconnect request for active streams
        this.reconnectToSession(sessionKey);
      }
    }
  }
}

/** Singleton instance */
export const streamManager = new StreamManager();

/* ═══ React Hooks ═══ */

import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hook to subscribe to stream events for a session.
 */
export function useSessionStream(sessionKey: string | null) {
  const [state, setState] = useState<SessionStreamState | null>(null);
  const [connected, setConnected] = useState(streamManager.isConnected());
  const eventCallbackRef = useRef<StreamEventCallback | null>(null);
  
  // Initialize stream manager if needed
  useEffect(() => {
    streamManager.init();
  }, []);
  
  // Subscribe to connection changes
  useEffect(() => {
    return streamManager.onConnectionChange(setConnected);
  }, []);
  
  // Subscribe to session stream
  useEffect(() => {
    if (!sessionKey) {
      setState(null);
      return;
    }
    
    const { unsubscribe } = streamManager.subscribe(
      sessionKey,
      (event) => {
        if (eventCallbackRef.current) {
          eventCallbackRef.current(event);
        }
      },
      setState
    );
    
    // Get initial state
    const initialState = streamManager.getSessionState(sessionKey);
    if (initialState) {
      setState(initialState);
    }
    
    return unsubscribe;
  }, [sessionKey]);
  
  const onEvent = useCallback((callback: StreamEventCallback) => {
    eventCallbackRef.current = callback;
  }, []);
  
  return {
    state,
    connected,
    onEvent,
    isActive: state?.phase === 'thinking' || state?.phase === 'streaming' || state?.phase === 'tool',
  };
}

/**
 * Hook to manage stream connection state.
 */
export function useStreamConnection() {
  const [connected, setConnected] = useState(streamManager.isConnected());
  
  useEffect(() => {
    streamManager.init();
    return streamManager.onConnectionChange(setConnected);
  }, []);
  
  return { connected };
}
