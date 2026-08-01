import { io, type Socket } from 'socket.io-client';
import type { AgentZeroSessionProvider } from './AgentZeroAuthSession';
import {
  AGENT_ZERO_CONNECTOR_PROTOCOL,
  AGENT_ZERO_VERSION,
  AGENT_ZERO_WEBSOCKET_HANDLER,
  AGENT_ZERO_WEBSOCKET_NAMESPACE,
  normalizeAgentZeroVersion,
  type AgentZeroConnectorCapabilities,
} from './AgentZeroConnectorContract';
import { safeAgentZeroErrorMessage } from './AgentZeroDiagnostics';

const SOCKET_IO_PATH = '/socket.io';
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_STREAM_TIMEOUT_MS = 12 * 60 * 60_000;
const DEFAULT_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const DEFAULT_COMPLETION_GRACE_MS = 1_000;
const DEFAULT_MAX_STREAM_EVENTS = 50_000;
const DEFAULT_MAX_STREAM_BYTES = 16 * 1024 * 1024;

const MIN_TIMEOUT_MS = 250;
const MAX_CONNECT_TIMEOUT_MS = 120_000;
const MAX_STREAM_TIMEOUT_MS = 24 * 60 * 60_000;
const MAX_RECONNECT_ATTEMPTS = 20;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_COMPLETION_GRACE_MS = 10_000;
const MIN_STREAM_EVENTS = 100;
const MAX_STREAM_EVENTS = 250_000;
const MIN_STREAM_BYTES = 64 * 1024;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

const OFFICIAL_CONTEXT_EVENTS = new Set([
  'user_message',
  'assistant_delta',
  'assistant_message',
  'tool_start',
  'tool_output',
  'tool_end',
  'code_start',
  'code_output',
  'warning',
  'error',
  'info',
  'status',
  'util_message',
  'message_complete',
  'context_updated',
]);

type UnknownRecord = Record<string, unknown>;

export interface AgentZeroSocketLike {
  readonly connected: boolean;
  on(event: string, listener: (...args: any[]) => void): AgentZeroSocketLike;
  off(event: string, listener?: (...args: any[]) => void): AgentZeroSocketLike;
  emit(event: string, ...args: any[]): AgentZeroSocketLike;
  connect(): AgentZeroSocketLike;
  disconnect(): AgentZeroSocketLike;
  removeAllListeners?(): AgentZeroSocketLike;
}

export interface AgentZeroSocketFactoryOptions {
  path: typeof SOCKET_IO_PATH;
  namespace: typeof AGENT_ZERO_WEBSOCKET_NAMESPACE;
  cookie: string;
  origin: string;
  connectTimeoutMs: number;
  handler: typeof AGENT_ZERO_WEBSOCKET_HANDLER;
}

export type AgentZeroSocketFactory = (
  baseUrl: string,
  options: AgentZeroSocketFactoryOptions,
) => AgentZeroSocketLike;

export interface AgentZeroConnectorEvent {
  contextId: string;
  sequence: number;
  event: string;
  timestamp: string;
  data: {
    text?: string;
    heading?: string;
    meta?: UnknownRecord;
  };
}

export interface AgentZeroStreamMessageRequest {
  contextId: string;
  message: string;
  fromSequence: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentZeroConnectorEvent) => void;
  onTransportStatus?: (status: 'connected' | 'reconnecting' | 'replayed') => void;
}

export interface AgentZeroStreamMessageResult {
  contextId: string;
  status: string;
  response?: unknown;
  lastSequence: number;
  reconnects: number;
  eventsProcessed: number;
}

export interface AgentZeroConnectorStreamOptions {
  baseUrl: string;
  sessionProvider: AgentZeroSessionProvider;
  getCapabilities: () => Promise<AgentZeroConnectorCapabilities>;
  socketFactory?: AgentZeroSocketFactory;
  connectTimeoutMs?: number;
  ackTimeoutMs?: number;
  streamTimeoutMs?: number;
  reconnectAttempts?: number;
  reconnectDelayMs?: number;
  completionGraceMs?: number;
  maxStreamEvents?: number;
  maxStreamBytes?: number;
}

export class AgentZeroConnectorStreamError extends Error {
  constructor(message: string, readonly operation = 'stream') {
    super(message);
    this.name = 'AgentZeroConnectorStreamError';
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value!)));
}

function safeDetail(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  return safeAgentZeroErrorMessage(value);
}

function unwrapEnvelope(value: unknown): UnknownRecord {
  if (!isRecord(value)) return {};
  return isRecord(value.data) ? value.data : value;
}

function payloadBytes(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new AgentZeroConnectorStreamError('Agent Zero returned a non-serializable stream payload.');
  }
  return Buffer.byteLength(serialized || '', 'utf8');
}

function stableFingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableFingerprint).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableFingerprint(value[key])}`).join(',')}}`;
}

function normalizeContextEvent(value: unknown, expectedContextId: string): AgentZeroConnectorEvent {
  const direct = isRecord(value) ? value : {};
  // Official connector_context_event payloads contain their event body in a
  // top-level `data` property. Only unwrap Socket.IO's optional outer envelope
  // when the value is not already an official context event.
  const data = direct.context_id !== undefined
    && direct.sequence !== undefined
    && direct.event !== undefined
    ? direct
    : unwrapEnvelope(value);
  const contextId = String(data.context_id || '').trim();
  if (contextId !== expectedContextId) {
    throw new AgentZeroConnectorStreamError('Agent Zero streamed an event for a different context.');
  }
  const sequence = Number(data.sequence);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new AgentZeroConnectorStreamError('Agent Zero streamed an invalid event cursor.');
  }
  const event = String(data.event || '').trim();
  if (!OFFICIAL_CONTEXT_EVENTS.has(event)) {
    throw new AgentZeroConnectorStreamError(`Agent Zero streamed unsupported event '${event || 'unknown'}'.`);
  }
  const rawData = isRecord(data.data) ? data.data : {};
  const text = typeof rawData.text === 'string' ? rawData.text : undefined;
  const heading = typeof rawData.heading === 'string' ? rawData.heading : undefined;
  if ((text && Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024)
    || (heading && Buffer.byteLength(heading, 'utf8') > 64 * 1024)) {
    throw new AgentZeroConnectorStreamError('Agent Zero streamed an oversized event field.');
  }
  return {
    contextId,
    sequence,
    event,
    timestamp: typeof data.timestamp === 'string' ? data.timestamp.slice(0, 128) : '',
    data: {
      ...(text !== undefined ? { text } : {}),
      ...(heading !== undefined ? { heading } : {}),
      ...(isRecord(rawData.meta) ? { meta: rawData.meta } : {}),
    },
  };
}

function defaultSocketFactory(baseUrl: string, options: AgentZeroSocketFactoryOptions): AgentZeroSocketLike {
  // Socket.IO namespaces are selected through the connection URI. A
  // `namespace` option is not part of the JavaScript client contract and would
  // silently connect Portal to `/` instead of Agent Zero's required `/ws`.
  return io(`${baseUrl}${options.namespace}`, {
    path: options.path,
    transports: ['websocket'],
    upgrade: false,
    reconnection: false,
    forceNew: true,
    autoConnect: false,
    timeout: options.connectTimeoutMs,
    auth: { handlers: [options.handler] },
    extraHeaders: {
      Origin: options.origin,
      Referer: `${options.origin}/`,
      Cookie: options.cookie,
    },
  }) as Socket as AgentZeroSocketLike;
}

function parseAck(value: unknown, event: string): UnknownRecord {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new AgentZeroConnectorStreamError(`Agent Zero '${event}' returned an invalid acknowledgement.`, event);
  }
  const results = value.results.filter(isRecord);
  if (results.length !== 1) {
    throw new AgentZeroConnectorStreamError(`Agent Zero '${event}' returned an ambiguous acknowledgement.`, event);
  }
  const result = results[0];
  if (result.ok !== true) {
    const error = isRecord(result.error) ? result.error : {};
    const code = String(error.code || 'ERROR').slice(0, 64);
    const detail = safeDetail(error.error || error.message || error.details);
    throw new AgentZeroConnectorStreamError(
      `Agent Zero '${event}' failed (${code})${detail ? `: ${detail}` : ''}.`,
      event,
    );
  }
  if (!isRecord(result.data)) {
    throw new AgentZeroConnectorStreamError(`Agent Zero '${event}' acknowledgement omitted data.`, event);
  }
  return result.data;
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class AgentZeroConnectorStreamClient {
  private readonly baseUrl: string;
  private readonly sessionProvider: AgentZeroSessionProvider;
  private readonly getCapabilities: () => Promise<AgentZeroConnectorCapabilities>;
  private readonly socketFactory: AgentZeroSocketFactory;
  private readonly connectTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  private readonly streamTimeoutMs: number;
  private readonly reconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private readonly completionGraceMs: number;
  private readonly maxStreamEvents: number;
  private readonly maxStreamBytes: number;

  constructor(options: AgentZeroConnectorStreamOptions) {
    this.baseUrl = options.baseUrl;
    this.sessionProvider = options.sessionProvider;
    this.getCapabilities = options.getCapabilities;
    this.socketFactory = options.socketFactory || defaultSocketFactory;
    this.connectTimeoutMs = boundedInteger(
      options.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_CONNECT_TIMEOUT_MS,
    );
    this.ackTimeoutMs = boundedInteger(
      options.ackTimeoutMs,
      DEFAULT_ACK_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_CONNECT_TIMEOUT_MS,
    );
    this.streamTimeoutMs = boundedInteger(
      options.streamTimeoutMs,
      DEFAULT_STREAM_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_STREAM_TIMEOUT_MS,
    );
    this.reconnectAttempts = boundedInteger(
      options.reconnectAttempts,
      DEFAULT_RECONNECT_ATTEMPTS,
      0,
      MAX_RECONNECT_ATTEMPTS,
    );
    this.reconnectDelayMs = boundedInteger(
      options.reconnectDelayMs,
      DEFAULT_RECONNECT_DELAY_MS,
      0,
      MAX_RECONNECT_DELAY_MS,
    );
    this.completionGraceMs = boundedInteger(
      options.completionGraceMs,
      DEFAULT_COMPLETION_GRACE_MS,
      0,
      MAX_COMPLETION_GRACE_MS,
    );
    this.maxStreamEvents = boundedInteger(
      options.maxStreamEvents,
      DEFAULT_MAX_STREAM_EVENTS,
      MIN_STREAM_EVENTS,
      MAX_STREAM_EVENTS,
    );
    this.maxStreamBytes = boundedInteger(
      options.maxStreamBytes,
      DEFAULT_MAX_STREAM_BYTES,
      MIN_STREAM_BYTES,
      MAX_STREAM_BYTES,
    );
  }

  async streamMessage(request: AgentZeroStreamMessageRequest): Promise<AgentZeroStreamMessageResult> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.authRequired || capabilities.auth[0] !== 'session') {
      throw new AgentZeroConnectorStreamError(
        'Agent Zero must require protected session authentication for streaming.',
      );
    }
    if (!capabilities.transports.includes('websocket')
      || capabilities.websocketNamespace !== AGENT_ZERO_WEBSOCKET_NAMESPACE
      || !capabilities.websocketHandlers.includes(AGENT_ZERO_WEBSOCKET_HANDLER)
      || !capabilities.features.includes('message_send')) {
      throw new AgentZeroConnectorStreamError('Agent Zero does not expose the tested streaming contract.');
    }

    return new AgentZeroStreamRun(this, request).run();
  }

  private async createConnectedSocket(forceAuthentication: boolean): Promise<AgentZeroSocketLike> {
    const cookie = await this.sessionProvider.getSessionCookie(forceAuthentication);
    const socket = this.socketFactory(this.baseUrl, {
      path: SOCKET_IO_PATH,
      namespace: AGENT_ZERO_WEBSOCKET_NAMESPACE,
      cookie,
      origin: this.baseUrl,
      connectTimeoutMs: this.connectTimeoutMs,
      handler: AGENT_ZERO_WEBSOCKET_HANDLER,
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('connect_error', onError);
        if (error) {
          socket.removeAllListeners?.();
          socket.disconnect();
          reject(new AgentZeroConnectorStreamError(
            `Agent Zero WebSocket authentication failed${safeDetail(error) ? `: ${safeDetail(error)}` : ''}.`,
            'connect',
          ));
        } else resolve();
      };
      const onConnect = () => finish();
      const onError = (error: unknown) => finish(error);
      const timer = setTimeout(() => finish(new Error('connection timed out')), this.connectTimeoutMs);
      socket.on('connect', onConnect);
      socket.on('connect_error', onError);
      socket.connect();
    });
    return socket;
  }

  private async call(socket: AgentZeroSocketLike, event: string, payload: UnknownRecord): Promise<UnknownRecord> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new AgentZeroConnectorStreamError(
          `Agent Zero '${event}' acknowledgement timed out after ${this.ackTimeoutMs}ms.`,
          event,
        ));
      }, this.ackTimeoutMs);
      try {
        socket.emit(event, payload, (acknowledgement: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            if (payloadBytes(acknowledgement) > this.maxStreamBytes) {
              throw new AgentZeroConnectorStreamError(`Agent Zero '${event}' acknowledgement was oversized.`, event);
            }
            resolve(parseAck(acknowledgement, event));
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new AgentZeroConnectorStreamError(
          `Agent Zero '${event}' could not be sent${safeDetail(error) ? `: ${safeDetail(error)}` : ''}.`,
          event,
        ));
      }
    });
  }

  private validateHello(value: UnknownRecord): void {
    if (String(value.protocol || '') !== AGENT_ZERO_CONNECTOR_PROTOCOL
      || normalizeAgentZeroVersion(value.agent_zero_version) !== AGENT_ZERO_VERSION) {
      throw new AgentZeroConnectorStreamError('Agent Zero WebSocket protocol/version mismatch.', 'connector_hello');
    }
    const features = Array.isArray(value.features) ? value.features.map(String) : [];
    if (!features.includes('connector_subscribe_context') || !features.includes('connector_send_message')) {
      throw new AgentZeroConnectorStreamError('Agent Zero WebSocket is missing required stream features.', 'connector_hello');
    }
  }

  private get internals() {
    return {
      sessionProvider: this.sessionProvider,
      createConnectedSocket: this.createConnectedSocket.bind(this),
      call: this.call.bind(this),
      validateHello: this.validateHello.bind(this),
      streamTimeoutMs: this.streamTimeoutMs,
      reconnectAttempts: this.reconnectAttempts,
      reconnectDelayMs: this.reconnectDelayMs,
      completionGraceMs: this.completionGraceMs,
      maxStreamEvents: this.maxStreamEvents,
      maxStreamBytes: this.maxStreamBytes,
    };
  }

  /** Internal bridge used by the per-message state machine. */
  _internals() {
    return this.internals;
  }
}

class AgentZeroStreamRun {
  private readonly contextId: string;
  private readonly message: string;
  private readonly onEvent?: (event: AgentZeroConnectorEvent) => void;
  private readonly onTransportStatus?: (status: 'connected' | 'reconnecting' | 'replayed') => void;
  private readonly signal?: AbortSignal;
  private readonly config: ReturnType<AgentZeroConnectorStreamClient['_internals']>;
  private socket: AgentZeroSocketLike | null = null;
  private lastSequence: number;
  private reconnects = 0;
  private bytesProcessed = 0;
  private eventsProcessed = 0;
  private authRenewed = false;
  private sendAccepted = false;
  private recovering = false;
  private settled = false;
  private completion: UnknownRecord | null = null;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly fingerprints = new Set<string>();
  private resolve!: (result: AgentZeroStreamMessageResult) => void;
  private reject!: (error: Error) => void;

  constructor(client: AgentZeroConnectorStreamClient, request: AgentZeroStreamMessageRequest) {
    this.config = client._internals();
    this.contextId = request.contextId;
    this.message = request.message;
    this.lastSequence = Math.max(0, Math.floor(request.fromSequence || 0));
    this.signal = request.signal;
    this.onEvent = request.onEvent;
    this.onTransportStatus = request.onTransportStatus;
  }

  async run(): Promise<AgentZeroStreamMessageResult> {
    if (this.signal?.aborted) {
      throw new AgentZeroConnectorStreamError('Agent Zero stream was cancelled by Portal.', 'abort');
    }
    const result = new Promise<AgentZeroStreamMessageResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.signal?.addEventListener('abort', this.onAbort, { once: true });
    this.streamTimer = setTimeout(() => {
      this.fail(new AgentZeroConnectorStreamError(
        `Agent Zero stream exceeded the ${this.config.streamTimeoutMs}ms safety limit.`,
      ));
    }, this.config.streamTimeoutMs);

    void this.start().catch((error) => this.fail(error));
    return result;
  }

  private async start(): Promise<void> {
    try {
      await this.connect(false);
    } catch (error) {
      if (this.authRenewed) throw error;
      this.authRenewed = true;
      this.config.sessionProvider.invalidateSession();
      await this.connect(true);
    }
    if (this.settled) return;

    try {
      const accepted = await this.config.call(this.socket!, 'connector_send_message', {
        context_id: this.contextId,
        message: this.message,
        client_message_id: `portal-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`,
      });
      if (String(accepted.context_id || '') !== this.contextId || accepted.status !== 'accepted') {
        throw new AgentZeroConnectorStreamError(
          'Agent Zero did not accept the streamed message for the expected context.',
          'connector_send_message',
        );
      }
      this.sendAccepted = true;
      if (this.completion) this.scheduleCompletion();
    } catch (error) {
      // Once the send frame leaves Portal, a transport failure is ambiguous: the
      // remote run may be active. Never resend and risk duplicate execution.
      if (!this.socket?.connected && !this.settled) {
        await this.recover();
        return;
      }
      throw error;
    }
  }

  private async connect(forceAuthentication: boolean): Promise<void> {
    const socket = await this.config.createConnectedSocket(forceAuthentication);
    if (this.settled) {
      socket.disconnect();
      return;
    }
    this.socket = socket;
    this.attachListeners(socket);
    try {
      const hello = await this.config.call(socket, 'connector_hello', {
        protocol: AGENT_ZERO_CONNECTOR_PROTOCOL,
        client: 'bridgesllm-portal',
        client_version: '4.0',
      });
      this.config.validateHello(hello);
      const requestedCursor = this.lastSequence;
      const subscribed = await this.config.call(socket, 'connector_subscribe_context', {
        context_id: this.contextId,
        from: requestedCursor,
      });
      if (String(subscribed.context_id || '') !== this.contextId || subscribed.subscribed !== true) {
        throw new AgentZeroConnectorStreamError(
          'Agent Zero did not subscribe Portal to the expected context.',
          'connector_subscribe_context',
        );
      }
      const cursor = Number(subscribed.last_sequence);
      if (!Number.isSafeInteger(cursor) || cursor < requestedCursor) {
        throw new AgentZeroConnectorStreamError(
          'Agent Zero returned an invalid replay cursor.',
          'connector_subscribe_context',
        );
      }
      if (cursor > this.lastSequence) {
        this.lastSequence = cursor;
        this.onTransportStatus?.('replayed');
      }
      if (!this.settled) this.onTransportStatus?.('connected');
    } catch (error) {
      if (this.socket === socket) this.socket = null;
      socket.removeAllListeners?.();
      socket.disconnect();
      throw error;
    }
  }

  private attachListeners(socket: AgentZeroSocketLike): void {
    socket.on('connector_context_snapshot', (payload: unknown) => {
      if (this.socket !== socket || this.settled) return;
      this.guard(() => this.handleSnapshot(payload));
    });
    socket.on('connector_context_event', (payload: unknown) => {
      if (this.socket !== socket || this.settled) return;
      this.guard(() => this.handleEvent(payload));
    });
    socket.on('connector_context_complete', (payload: unknown) => {
      if (this.socket !== socket || this.settled) return;
      this.guard(() => this.handleComplete(payload));
    });
    socket.on('connector_error', (payload: unknown) => {
      if (this.socket !== socket || this.settled) return;
      const data = unwrapEnvelope(payload);
      if (data.context_id && String(data.context_id) !== this.contextId) return;
      const detail = safeDetail(data.message || data.error);
      this.fail(new AgentZeroConnectorStreamError(
        `Agent Zero stream failed${detail ? `: ${detail}` : ''}.`,
      ));
    });
    socket.on('disconnect', () => {
      if (this.socket !== socket || this.settled) return;
      this.socket = null;
      void this.recover().catch((error) => this.fail(error));
    });
  }

  private guard(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.fail(error);
    }
  }

  private consumePayload(value: unknown): void {
    this.bytesProcessed += payloadBytes(value);
    if (this.bytesProcessed > this.config.maxStreamBytes) {
      throw new AgentZeroConnectorStreamError('Agent Zero stream exceeded the configured byte limit.');
    }
  }

  private handleSnapshot(payload: unknown): void {
    this.consumePayload(payload);
    const data = unwrapEnvelope(payload);
    if (String(data.context_id || '') !== this.contextId || !Array.isArray(data.events)) {
      throw new AgentZeroConnectorStreamError('Agent Zero returned an invalid context snapshot.');
    }
    if (data.events.length > 1_000) {
      throw new AgentZeroConnectorStreamError('Agent Zero returned an oversized context snapshot.');
    }
    for (const event of data.events) this.processEvent(event);
    const cursor = Number(data.last_sequence);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new AgentZeroConnectorStreamError('Agent Zero returned an invalid snapshot cursor.');
    }
    this.lastSequence = Math.max(this.lastSequence, cursor);
  }

  private handleEvent(payload: unknown): void {
    this.consumePayload(payload);
    this.processEvent(payload);
  }

  private processEvent(payload: unknown): void {
    const event = normalizeContextEvent(payload, this.contextId);
    const key = `${event.contextId}:${event.sequence}:${event.event}`;
    const fingerprint = stableFingerprint(event);
    const exactEvent = `${key}:${fingerprint}`;
    if (this.fingerprints.has(exactEvent)) return;
    this.fingerprints.add(exactEvent);
    this.eventsProcessed += 1;
    if (this.eventsProcessed > this.config.maxStreamEvents) {
      throw new AgentZeroConnectorStreamError('Agent Zero stream exceeded the configured event limit.');
    }
    this.lastSequence = Math.max(this.lastSequence, event.sequence);
    this.onEvent?.(event);
  }

  private handleComplete(payload: unknown): void {
    this.consumePayload(payload);
    const data = unwrapEnvelope(payload);
    if (String(data.context_id || '') !== this.contextId) return;
    const status = String(data.status || '').trim().slice(0, 64);
    const hasError = data.error !== undefined && data.error !== null && data.error !== '';
    if (status.toLowerCase() !== 'completed' || hasError) {
      const detail = safeDetail(
        data.error ?? data.message ?? data.response ?? status,
      ).replace(/[.\s]+$/g, '');
      throw new AgentZeroConnectorStreamError(
        `Agent Zero run failed${detail ? `: ${detail}` : ''}.`,
      );
    }
    this.completion = data;
    if (this.sendAccepted) this.scheduleCompletion();
  }

  private scheduleCompletion(): void {
    if (!this.completion || this.settled) return;
    if (this.completion.response !== undefined || this.config.completionGraceMs === 0) {
      this.finish();
      return;
    }
    if (this.completionTimer) return;
    this.completionTimer = setTimeout(() => this.finish(), this.config.completionGraceMs);
  }

  private finish(): void {
    if (this.settled || !this.completion) return;
    const completion = this.completion;
    this.settled = true;
    this.cleanup();
    this.resolve({
      contextId: this.contextId,
      status: String(completion.status || 'completed').slice(0, 64),
      ...(completion.response !== undefined ? { response: completion.response } : {}),
      lastSequence: this.lastSequence,
      reconnects: this.reconnects,
      eventsProcessed: this.eventsProcessed,
    });
  }

  private async recover(): Promise<void> {
    if (this.recovering || this.settled) return;
    this.recovering = true;
    this.onTransportStatus?.('reconnecting');
    let lastError: unknown;
    try {
      for (let attempt = 0; attempt < this.config.reconnectAttempts && !this.settled; attempt += 1) {
        if (attempt > 0) {
          await delay(Math.min(this.config.reconnectDelayMs * (2 ** (attempt - 1)), MAX_RECONNECT_DELAY_MS));
        }
        try {
          // Count the recovery before subscribing: the server may replay a
          // terminal event synchronously with the subscribe acknowledgement.
          this.reconnects += 1;
          await this.connect(false);
          return;
        } catch (error) {
          this.reconnects = Math.max(0, this.reconnects - 1);
          lastError = error;
          if (!this.authRenewed) {
            this.authRenewed = true;
            this.config.sessionProvider.invalidateSession();
            try {
              this.reconnects += 1;
              await this.connect(true);
              return;
            } catch (renewalError) {
              this.reconnects = Math.max(0, this.reconnects - 1);
              lastError = renewalError;
            }
          }
        }
      }
    } finally {
      this.recovering = false;
    }
    throw new AgentZeroConnectorStreamError(
      `Agent Zero stream could not reconnect${safeDetail(lastError) ? `: ${safeDetail(lastError)}` : ''}.`,
    );
  }

  private fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.reject(error instanceof Error
      ? error
      : new AgentZeroConnectorStreamError('Agent Zero stream failed.'));
  }

  private readonly onAbort = (): void => {
    this.fail(new AgentZeroConnectorStreamError('Agent Zero stream was cancelled by Portal.', 'abort'));
  };

  private cleanup(): void {
    this.signal?.removeEventListener('abort', this.onAbort);
    if (this.streamTimer) clearTimeout(this.streamTimer);
    if (this.completionTimer) clearTimeout(this.completionTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners?.();
      socket.disconnect();
    }
  }
}
