/**
 * OpenClawGatewayClient — Direct browser-to-gateway WebSocket client
 *
 * This is a simplified browser client that speaks the OpenClaw gateway's
 * native JSON-RPC WebSocket protocol. It connects through the portal's
 * WebSocket proxy at /api/gateway/direct, which handles authentication
 * and token injection.
 *
 * Protocol overview:
 * - Requests: { type: "req", id: number, method: string, params?: object }
 * - Responses: { type: "res", id: number, ok: boolean, payload?: any, error?: string }
 * - Events: { type: "event", event: string, payload: any }
 *
 * The proxy intercepts 'connect' requests and injects the gateway token,
 * so the browser never needs to handle the raw auth token.
 */

import { clientRandomId } from './clientId';

export interface GatewayEventPayload {
  runId?: string;
  sessionKey?: string;
  state?: 'delta' | 'final' | 'aborted' | 'error' | 'compacting' | 'compacted' | 'compaction_start' | 'compaction_end';
  message?: {
    role: string;
    content: Array<{ type: string; text?: string; [key: string]: any }>;
    text?: string;
  };
  errorMessage?: string;
  // Agent events (tool calls, etc.)
  seq?: number;
  stream?: 'assistant' | 'tool' | 'item' | 'thinking' | 'compaction' | 'lifecycle';
  ts?: number;
  data?: {
    phase?: 'start' | 'update' | 'result' | 'end';
    status?: 'start' | 'started' | 'end' | 'completed' | 'compacted';
    toolCallId?: string;
    name?: string;
    toolName?: string;
    args?: unknown;
    result?: unknown;
    partialResult?: unknown;
    completed?: boolean;
    willRetry?: boolean;
    statusText?: string;
  };
}

export interface GatewayEvent {
  type: 'event';
  event: 'chat' | 'agent' | 'chat.side_result' | 'session.message' | 'sessions.changed' | 'connect.challenge';
  payload: GatewayEventPayload;
}

export interface GatewayChatMessage {
  id?: string;
  messageId?: string;
  __openclaw?: {
    kind?: string;
    id?: string;
    [key: string]: any;
  };
  role: string;
  content: Array<{ type: string; text?: string; [key: string]: any }> | string;
  timestamp?: number;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments?: unknown;
  }>;
}

export interface GatewayHistoryResponse {
  messages: GatewayChatMessage[];
  sessionId?: string;
  thinkingLevel?: string;
}

export interface OpenClawGatewayClientOptions {
  /** WebSocket URL (e.g., ws://localhost:3001/api/gateway/direct) */
  url: string;
  /** Called when a gateway event is received */
  onEvent: (evt: GatewayEvent) => void;
  /** Called when the connection is established and authenticated */
  onConnected: () => void;
  /** Called when the connection is lost */
  onDisconnected: () => void;
  /** Called when a reconnect attempt is scheduled */
  onReconnecting?: (attempt: number, delayMs: number) => void;
  /** Called when the direct gateway reports an auth failure before giving up */
  onAuthFailure?: () => Promise<boolean>;
  /** Called on connection error */
  onError?: (error: Error) => void;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30000;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

const DEBUG_GATEWAY_CLIENT = import.meta.env.DEV;
const debugGatewayClient = (...args: unknown[]) => {
  if (DEBUG_GATEWAY_CLIENT) console.debug('[OpenClawGatewayClient]', ...args);
};


export class OpenClawGatewayClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private connected = false;
  private authenticated = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private challengeNonce: string | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnecting = false;
  private currentSessionKey: string | null = null;
  private activeRunSessionKey: string | null = null;
  private sessionIdsByKey = new Map<string, string>();
  private subscribedSessionMessageKeys = new Set<string>();

  private readonly url: string;
  private readonly onEvent: (evt: GatewayEvent) => void;
  private readonly onConnected: () => void;
  private readonly onDisconnected: () => void;
  private readonly onReconnecting?: (attempt: number, delayMs: number) => void;
  private readonly onAuthFailure?: () => Promise<boolean>;
  private readonly onError?: (error: Error) => void;

  constructor(options: OpenClawGatewayClientOptions) {
    this.url = options.url;
    this.onEvent = options.onEvent;
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    this.onReconnecting = options.onReconnecting;
    this.onAuthFailure = options.onAuthFailure;
    this.onError = options.onError;
  }

  get isConnected(): boolean {
    return this.connected && this.authenticated;
  }

  get isReconnecting(): boolean {
    return this.reconnecting;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.intentionallyClosed = false;
    this.reconnecting = this.reconnectAttempt > 0;
    this.createConnection();
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    this.cleanup();
  }

  private createConnection(): void {
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      console.error('[OpenClawGatewayClient] Failed to create WebSocket:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      debugGatewayClient('WebSocket connected, waiting for challenge...');
      this.connected = true;
      this.startPing();
      this.sendReconnectFrame();
    };

    this.ws.onmessage = async (event) => {
      let text: string;
      if (typeof event.data === 'string') {
        text = event.data;
      } else if (event.data instanceof Blob) {
        text = await event.data.text();
      } else if (event.data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(event.data);
      } else {
        console.warn('[OpenClawGatewayClient] Unknown message type:', typeof event.data);
        return;
      }
      this.handleMessage(text);
    };

    this.ws.onclose = (event) => {
      debugGatewayClient('WebSocket closed:', event.code, event.reason);
      const wasAuthenticated = this.authenticated;
      this.cleanup();

      const reason = event.reason?.toLowerCase() || '';
      const isAuthFailure = event.code === 4001 || event.code === 4003 ||
        reason.includes('unauthorized') ||
        reason.includes('forbidden') ||
        reason.includes('expired');

      if (isAuthFailure && !this.intentionallyClosed) {
        if (wasAuthenticated) {
          this.onDisconnected();
        }
        const recoverAuth = this.onAuthFailure;
        if (!recoverAuth) {
          console.warn('[OpenClawGatewayClient] Auth failure, not reconnecting');
          this.intentionallyClosed = true;
          return;
        }

        console.warn('[OpenClawGatewayClient] Auth failure, attempting session refresh before reconnect');
        void recoverAuth()
          .then((recovered) => {
            if (!recovered || this.intentionallyClosed) {
              this.intentionallyClosed = true;
              return;
            }
            this.reconnectAttempt = 0;
            this.reconnecting = true;
            this.scheduleReconnect();
          })
          .catch((err) => {
            console.warn('[OpenClawGatewayClient] Auth refresh failed, not reconnecting:', err);
            this.intentionallyClosed = true;
          });
        return;
      }

      if (wasAuthenticated) {
        this.onDisconnected();
      }

      if (!this.intentionallyClosed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event) => {
      console.error('[OpenClawGatewayClient] WebSocket error:', event);
      this.onError?.(new Error('WebSocket connection error'));
    };
  }

  private handleMessage(data: string): void {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      console.warn('[OpenClawGatewayClient] Failed to parse message:', data);
      return;
    }

    // Handle JSON-RPC responses
    if (msg.type === 'res') {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg.payload);
        } else {
          const errorMsg = typeof msg.error === 'string' ? msg.error 
            : msg.error?.message || msg.error?.error || JSON.stringify(msg.error) || 'Request failed';
          pending.reject(new Error(errorMsg));
        }
      }
      return;
    }

    // Handle events
    debugGatewayClient('message', { type: msg.type, event: msg.event, state: msg.payload?.state });
    if (msg.type === 'event') {
      if (msg.event === 'connect.challenge') {
        // Gateway sends a challenge nonce — we need to send 'connect' with it
        this.challengeNonce = msg.payload?.nonce;
        this.sendConnectRequest();
        return;
      }

      // Forward all other events to the handler
      this.onEvent(msg as GatewayEvent);
      return;
    }

    // Handle 'connected' confirmation from the proxy
    if (msg.type === 'connected') {
      // Proxy connected — now we wait for gateway challenge
      return;
    }
  }

  private sendConnectRequest(): void {
    const connectParams: any = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'bridgesllm-portal',
        version: 'portal-direct',
        platform: 'web',
        mode: 'webchat',
      },
      role: 'operator',
      scopes: ['operator.admin', 'operator.approvals'],
      caps: ['tool-events'],
    };

    if (this.challengeNonce) {
      connectParams.nonce = this.challengeNonce;
    }

    // The proxy will intercept this and inject the auth token
    this.request<{ protocol: number }>('connect', connectParams)
      .then((result) => {
        debugGatewayClient('Connected with protocol:', result.protocol);
        this.authenticated = true;
        void this.subscribeSessions().catch((error) => {
          debugGatewayClient('sessions.subscribe failed:', error);
        });
        if (this.currentSessionKey) {
          void this.subscribeSession(this.currentSessionKey).catch((error) => {
            debugGatewayClient('Failed to subscribe current session:', error);
          });
        }
        this.sendReconnectFrame();
        if (this.reconnecting && this.activeRunSessionKey) {
          void this.subscribeSession(this.activeRunSessionKey).catch((error) => {
            debugGatewayClient('Failed to re-subscribe after reconnect:', error);
          });
        }
        this.reconnectAttempt = 0;
        this.reconnecting = false;
        this.onConnected();
      })
      .catch((err) => {
        console.error('[OpenClawGatewayClient] Connect failed:', err);
        this.onError?.(err);
        this.ws?.close(4001, 'Connect failed');
      });
  }

  private cleanup(): void {
    this.connected = false;
    this.authenticated = false;
    this.challengeNonce = null;
    this.subscribedSessionMessageKeys.clear();

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Connection closed'));
      this.pendingRequests.delete(id);
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed || this.reconnectTimer) return;

    this.reconnecting = true;

    const hasActiveStream = Boolean(this.activeRunSessionKey);
    const maxReconnectAttempts = hasActiveStream ? Number.POSITIVE_INFINITY : 10;
    if (Number.isFinite(maxReconnectAttempts) && this.reconnectAttempt >= maxReconnectAttempts) {
      console.warn(`[OpenClawGatewayClient] Max reconnect attempts (${maxReconnectAttempts}) reached, giving up`);
      this.intentionallyClosed = true;
      return;
    }

    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt++;

    const attemptLabel = Number.isFinite(maxReconnectAttempts)
      ? `${this.reconnectAttempt}/${maxReconnectAttempts}`
      : `${this.reconnectAttempt}/∞`;
    debugGatewayClient(`Reconnecting in ${delay}ms (attempt ${attemptLabel})`);
    this.onReconnecting?.(this.reconnectAttempt, delay);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.createConnection();
    }, delay);
  }

  private startPing(): void {
    // Keep connection alive with periodic pings
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Send a lightweight request to keep the connection alive
        // The proxy will forward this to the gateway
        try {
          this.ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        } catch {}
      }
    }, 25000);
  }


  private sendReconnectFrame(): void {
    // Intentionally a no-op for the direct gateway proxy.
    // /api/gateway/direct only forwards JSON-RPC request frames to the gateway,
    // so custom browser-side reconnect frames are ignored there.
    // Active stream recovery is handled by the React layer via
    // gateway-native history + /gateway/stream-status reconciliation.
  }

  requestStreamResume(sessionKey?: string | null): void {
    if (typeof sessionKey === 'string' && sessionKey.trim()) {
      const key = sessionKey.trim();
      this.activeRunSessionKey = key;
      void this.subscribeSession(key).catch((error) => {
        debugGatewayClient('Failed to subscribe resumed session:', error);
      });
    }
  }

  setCurrentSession(sessionKey: string | null): void {
    const key = typeof sessionKey === 'string' && sessionKey.trim() ? sessionKey.trim() : null;
    this.currentSessionKey = key;
    if (!key && this.activeRunSessionKey) {
      this.activeRunSessionKey = null;
      return;
    }
    if (key) {
      void this.subscribeSession(key).catch((error) => {
        debugGatewayClient('Failed to subscribe current session:', error);
      });
    }
  }

  setActiveStreamSession(sessionKey: string | null): void {
    const key = typeof sessionKey === 'string' && sessionKey.trim() ? sessionKey.trim() : null;
    this.activeRunSessionKey = key;
    if (key) {
      void this.subscribeSession(key).catch((error) => {
        debugGatewayClient('Failed to subscribe active stream session:', error);
      });
    }
  }

  /**
   * Send a JSON-RPC request to the gateway.
   */
  async request<T = any>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }

    const id = ++this.requestId;
    const frame = {
      type: 'req',
      id,
      method,
      params: params || {},
    };

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeoutId });

      try {
        this.ws!.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Send a chat message to the gateway.
   * Returns the real gateway runId from the `chat.send` acknowledgement when available.
   */
  async sendMessage(sessionKey: string, message: string): Promise<string | null> {
    this.currentSessionKey = sessionKey;
    this.activeRunSessionKey = sessionKey;
    await this.subscribeSession(sessionKey);
    const idempotencyKey = clientRandomId();
    const sessionId = this.sessionIdsByKey.get(sessionKey);

    const result = await this.request<{ runId?: string; status?: string }>('chat.send', {
      sessionKey,
      ...(sessionId ? { sessionId } : {}),
      message,
      deliver: false,
      idempotencyKey,
    });

    return typeof result?.runId === 'string' && result.runId.trim()
      ? result.runId.trim()
      : null;
  }


  /**
   * Inject an assistant-side transcript note without starting a new turn.
   * This does NOT steer the running agent.
   */
  async injectMessage(sessionKey: string, text: string): Promise<void> {
    this.currentSessionKey = sessionKey;
    await this.request('chat.inject', {
      sessionKey,
      message: {
        role: 'assistant',
        content: [{ type: 'input_text', text }],
      },
    });
  }

  /**
   * Load message history for a session.
   */
  async loadHistory(sessionKey: string, limit = 200): Promise<GatewayHistoryResponse> {
    this.currentSessionKey = sessionKey;
    void this.subscribeSession(sessionKey).catch((error) => {
      debugGatewayClient('Failed to subscribe history session:', error);
    });
    const result = await this.request<{ messages: GatewayChatMessage[]; sessionId?: string; thinkingLevel?: string }>('chat.history', {
      sessionKey,
      limit,
    });

    if (typeof result.sessionId === 'string' && result.sessionId.trim()) {
      this.sessionIdsByKey.set(sessionKey, result.sessionId.trim());
    }

    return {
      messages: result.messages || [],
      sessionId: result.sessionId,
      thinkingLevel: result.thinkingLevel,
    };
  }

  /**
   * Abort an active run.
   */
  async abortRun(sessionKey: string, runId?: string): Promise<boolean> {
    this.currentSessionKey = sessionKey;
    const params: any = { sessionKey };
    if (runId) params.runId = runId;

    const result = await this.request<{ aborted: boolean }>('chat.abort', params);
    return result.aborted;
  }

  /**
   * Subscribe to a session's events (for reconnecting to active streams).
   * Note: The gateway automatically streams events to all connected clients —
   * no explicit subscribe RPC is needed. This just tracks the active session.
   */
  async subscribeSession(sessionKey: string): Promise<void> {
    const key = String(sessionKey || '').trim();
    if (!key) return;
    this.currentSessionKey = key;
    if (!this.isConnected || this.subscribedSessionMessageKeys.has(key)) return;
    try {
      const result = await this.request<{ key?: string }>('sessions.messages.subscribe', { key });
      const canonicalKey = typeof result?.key === 'string' && result.key.trim() ? result.key.trim() : key;
      this.subscribedSessionMessageKeys.add(key);
      this.subscribedSessionMessageKeys.add(canonicalKey);
    } catch (error) {
      // Older gateways may not expose per-session message subscriptions. The
      // broad sessions.subscribe channel still gives us session/change events.
      debugGatewayClient('sessions.messages.subscribe failed:', error);
    }
  }

  async subscribeSessions(): Promise<void> {
    if (!this.isConnected) return;
    await this.request('sessions.subscribe', {});
  }
}

/**
 * Create a gateway client URL from the current window location.
 */
export function createGatewayDirectUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const apiUrl = import.meta.env.VITE_API_URL || '';

  if (apiUrl) {
    if (apiUrl.startsWith('http')) {
      return apiUrl.replace(/^http/, 'ws') + '/gateway/direct';
    }
    return protocol + '//' + window.location.host + apiUrl + '/gateway/direct';
  }

  return protocol + '//' + window.location.host + '/api/gateway/direct';
}
