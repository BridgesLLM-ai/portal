import {
  getDefaultAgentZeroAuthSessionManager,
  type AgentZeroSessionProvider,
} from './AgentZeroAuthSession';
import {
  AGENT_ZERO_CONNECTOR_PATH,
  AGENT_ZERO_DEFAULT_BASE_URL,
  normalizeAgentZeroBaseUrl,
  validateAgentZeroCapabilities,
  type AgentZeroConnectorCapabilities,
} from './AgentZeroConnectorContract';
import {
  AgentZeroConnectorStreamClient,
  type AgentZeroSocketFactory,
  type AgentZeroStreamMessageRequest,
  type AgentZeroStreamMessageResult,
} from './AgentZeroConnectorStream';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SEND_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const MIN_TIMEOUT_MS = 250;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_SEND_TIMEOUT_MS = 30 * 60_000;
const MIN_RESPONSE_BYTES = 1_024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type FetchImplementation = typeof globalThis.fetch;

export type AgentZeroCapabilities = AgentZeroConnectorCapabilities;

export interface AgentZeroConnectorClientOptions {
  baseUrl?: string;
  sessionCookie?: string;
  sessionProvider?: AgentZeroSessionProvider;
  allowRemote?: boolean;
  requestTimeoutMs?: number;
  sendTimeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: FetchImplementation;
  socketFactory?: AgentZeroSocketFactory;
  streamConnectTimeoutMs?: number;
  streamAckTimeoutMs?: number;
  streamTimeoutMs?: number;
  streamReconnectAttempts?: number;
  streamReconnectDelayMs?: number;
  streamCompletionGraceMs?: number;
  maxStreamEvents?: number;
  maxStreamBytes?: number;
}

export class AgentZeroConnectorError extends Error {
  constructor(
    message: string,
    readonly operation?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AgentZeroConnectorError';
  }
}

function advertisedFeatureForOperation(operation: string): string {
  if (operation === 'launcher_gateway_status' || operation === 'launcher_gateway_control') {
    return 'launcher_gateway';
  }
  return operation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseBoolean(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function boundedInteger(
  value: number | string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function normalizeSessionCookie(value: string | undefined): string {
  const cookie = String(value || '').trim();
  if (!cookie) {
    throw new AgentZeroConnectorError(
      'Agent Zero protected server-side session authentication is unavailable.',
    );
  }
  if (cookie.length > 4096 || /[\u0000-\u001F\u007F]/.test(cookie) || !cookie.includes('=')) {
    throw new AgentZeroConnectorError('Agent Zero session authentication is malformed.');
  }
  return cookie;
}

function safeErrorDetail(value: unknown, sessionCookie?: string): string {
  let detail = '';
  if (typeof value === 'string') {
    detail = value;
  } else if (isRecord(value)) {
    for (const key of ['error', 'message', 'detail']) {
      if (typeof value[key] === 'string') {
        detail = String(value[key]);
        break;
      }
    }
  }

  detail = detail.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (sessionCookie) detail = detail.split(sessionCookie).join('[redacted]');
  detail = detail
    .replace(/\b(api[_-]?key|token|secret|password|cookie)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
  return detail.slice(0, 300);
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function isLoginRedirect(response: Response): boolean {
  if (!isRedirectStatus(response.status)) return false;
  const location = response.headers.get('location')?.trim();
  if (!location) return false;
  try {
    const path = new URL(location, 'http://agent-zero.invalid').pathname;
    return path === '/login' || path.endsWith('/login');
  } catch {
    return false;
  }
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
  controller: AbortController,
): Promise<string> {
  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    controller.abort();
    throw new AgentZeroConnectorError('Agent Zero returned a response larger than the configured limit.');
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maximumBytes) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw new AgentZeroConnectorError('Agent Zero returned a response larger than the configured limit.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export class AgentZeroConnectorClient {
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  readonly sendTimeoutMs: number;

  private readonly fetchImpl: FetchImplementation;
  private readonly maxResponseBytes: number;
  private readonly sessionProvider: AgentZeroSessionProvider;
  private readonly streamClient: AgentZeroConnectorStreamClient;
  private capabilitiesPromise: Promise<AgentZeroCapabilities> | null = null;

  constructor(options: AgentZeroConnectorClientOptions = {}) {
    const allowRemote = options.allowRemote ?? parseBoolean(process.env.AGENT_ZERO_ALLOW_REMOTE);
    this.baseUrl = normalizeAgentZeroBaseUrl(
      options.baseUrl || process.env.AGENT_ZERO_BASE_URL || AGENT_ZERO_DEFAULT_BASE_URL,
      allowRemote,
    );
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs ?? process.env.AGENT_ZERO_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
    );
    this.sendTimeoutMs = boundedInteger(
      options.sendTimeoutMs ?? process.env.AGENT_ZERO_SEND_TIMEOUT_MS,
      DEFAULT_SEND_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_SEND_TIMEOUT_MS,
    );
    this.maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? process.env.AGENT_ZERO_MAX_RESPONSE_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
      MIN_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
    );
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new AgentZeroConnectorError('The server runtime does not provide HTTP fetch support.');
    }
    if (options.sessionProvider) {
      this.sessionProvider = options.sessionProvider;
    } else if (options.sessionCookie !== undefined) {
      const fixedCookie = options.sessionCookie;
      this.sessionProvider = {
        getSessionCookie: async () => normalizeSessionCookie(fixedCookie),
        invalidateSession: () => undefined,
      };
    } else {
      this.sessionProvider = getDefaultAgentZeroAuthSessionManager();
    }
    this.streamClient = new AgentZeroConnectorStreamClient({
      baseUrl: this.baseUrl,
      sessionProvider: this.sessionProvider,
      getCapabilities: () => this.getCapabilities(),
      socketFactory: options.socketFactory,
      connectTimeoutMs: options.streamConnectTimeoutMs,
      ackTimeoutMs: options.streamAckTimeoutMs,
      streamTimeoutMs: options.streamTimeoutMs,
      reconnectAttempts: options.streamReconnectAttempts,
      reconnectDelayMs: options.streamReconnectDelayMs,
      completionGraceMs: options.streamCompletionGraceMs,
      maxStreamEvents: options.maxStreamEvents,
      maxStreamBytes: options.maxStreamBytes,
    });
  }

  async getCapabilities(forceRefresh = false): Promise<AgentZeroCapabilities> {
    if (forceRefresh) this.capabilitiesPromise = null;
    if (!this.capabilitiesPromise) {
      const pending = this.discoverCapabilities();
      this.capabilitiesPromise = pending;
      pending.catch(() => {
        if (this.capabilitiesPromise === pending) this.capabilitiesPromise = null;
      });
    }
    return this.capabilitiesPromise;
  }

  async supports(feature: string): Promise<boolean> {
    return (await this.getCapabilities()).features.includes(feature);
  }

  async streamMessage(request: AgentZeroStreamMessageRequest): Promise<AgentZeroStreamMessageResult> {
    return this.streamClient.streamMessage(request);
  }

  async call<T = Record<string, unknown>>(
    feature: string,
    payload: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(feature)) {
      throw new AgentZeroConnectorError('Invalid Agent Zero connector operation.');
    }

    const capabilities = await this.getCapabilities();
    const advertisedFeature = advertisedFeatureForOperation(feature);
    if (!capabilities.features.includes(advertisedFeature)) {
      throw new AgentZeroConnectorError(
        `Agent Zero connector does not advertise the required '${advertisedFeature}' capability.`,
        feature,
      );
    }
    if (!capabilities.authRequired || !capabilities.auth.includes('session')) {
      throw new AgentZeroConnectorError(
        'Agent Zero must require session authentication before Portal can use protected connector operations.',
        feature,
      );
    }

    return this.requestJson<T>(feature, payload, true, timeoutMs);
  }

  private async discoverCapabilities(): Promise<AgentZeroCapabilities> {
    const raw = await this.requestJson<unknown>(
      'capabilities',
      {},
      false,
      this.requestTimeoutMs,
    );
    try {
      return validateAgentZeroCapabilities(raw, { requireAuthentication: true });
    } catch (error) {
      throw new AgentZeroConnectorError(
        error instanceof Error ? error.message : 'Agent Zero returned an invalid capabilities response.',
      );
    }
  }

  private async requestJson<T>(
    operation: string,
    payload: Record<string, unknown>,
    protectedOperation: boolean,
    timeoutMs: number,
  ): Promise<T> {
    const boundedTimeout = boundedInteger(
      timeoutMs,
      this.requestTimeoutMs,
      MIN_TIMEOUT_MS,
      operation === 'message_send' ? MAX_SEND_TIMEOUT_MS : MAX_REQUEST_TIMEOUT_MS,
    );
    const attempts = protectedOperation ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), boundedTimeout);
      let sessionCookie: string | undefined;

      try {
        const headers: Record<string, string> = {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        };
        if (protectedOperation) {
          sessionCookie = normalizeSessionCookie(await this.sessionProvider.getSessionCookie(attempt > 0));
          headers.Cookie = sessionCookie;
        }

        let response: Response;
        try {
          response = await this.fetchImpl(`${this.baseUrl}${AGENT_ZERO_CONNECTOR_PATH}/${operation}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch {
          if (controller.signal.aborted) {
            throw new AgentZeroConnectorError(
              `Agent Zero '${operation}' request timed out after ${boundedTimeout}ms.`,
              operation,
            );
          }
          throw new AgentZeroConnectorError(`Agent Zero '${operation}' request failed.`, operation);
        }

        const authenticationRejected = protectedOperation
          && (response.status === 401 || response.status === 403 || isLoginRedirect(response));
        if (authenticationRejected && attempt === 0) {
          this.sessionProvider.invalidateSession();
          await response.body?.cancel().catch(() => undefined);
          continue;
        }
        if (authenticationRejected) {
          throw new AgentZeroConnectorError(
            'Agent Zero rejected the protected server-side session authentication.',
            operation,
            response.status,
          );
        }
        if (isRedirectStatus(response.status)) {
          throw new AgentZeroConnectorError(
            `Agent Zero '${operation}' returned an unexpected redirect.`,
            operation,
            response.status,
          );
        }

        let bodyText: string;
        try {
          bodyText = await readBoundedText(response, this.maxResponseBytes, controller);
        } catch (error) {
          if (error instanceof AgentZeroConnectorError) throw error;
          if (controller.signal.aborted) {
            throw new AgentZeroConnectorError(
              `Agent Zero '${operation}' request timed out after ${boundedTimeout}ms.`,
              operation,
            );
          }
          throw new AgentZeroConnectorError(`Agent Zero '${operation}' response could not be read.`, operation);
        }
        let body: unknown = {};
        if (bodyText.trim()) {
          try {
            body = JSON.parse(bodyText);
          } catch {
            if (response.ok) {
              throw new AgentZeroConnectorError(
                `Agent Zero '${operation}' returned invalid JSON.`,
                operation,
                response.status,
              );
            }
            body = bodyText;
          }
        }

        if (!response.ok) {
          const detail = safeErrorDetail(body, sessionCookie);
          throw new AgentZeroConnectorError(
            `Agent Zero '${operation}' failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}.`,
            operation,
            response.status,
          );
        }

        return body as T;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new AgentZeroConnectorError(
      'Agent Zero protected server-side session authentication is unavailable.',
      operation,
    );
  }
}
