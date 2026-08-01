import { lstatSync, readFileSync, type Stats } from 'fs';
import {
  AGENT_ZERO_CONNECTOR_PATH,
  AGENT_ZERO_DEFAULT_BASE_URL,
  normalizeAgentZeroBaseUrl,
  validateAgentZeroCapabilities,
} from './AgentZeroConnectorContract';

const DEFAULT_AUTH_FILE = '/etc/bridgesllm/agent-zero.env';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_VERIFY_TTL_MS = 30_000;
const DEFAULT_PROTOCOL_TTL_MS = 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

type FetchImplementation = typeof globalThis.fetch;

export type AgentZeroAuthReadinessState =
  | 'unchecked'
  | 'authenticated'
  | 'needs_login'
  | 'unconfigured'
  | 'error';

export interface AgentZeroAuthReadiness {
  state: AgentZeroAuthReadinessState;
  authenticated: boolean;
  checkedAt?: string;
  reason: string;
}

export interface AgentZeroCredentials {
  username: string;
  password: string;
}

export interface AgentZeroSessionProvider {
  getSessionCookie(forceRefresh?: boolean, signal?: AbortSignal): Promise<string>;
  invalidateSession(): void;
}

export interface AgentZeroAuthSessionOptions {
  baseUrl?: string;
  allowRemote?: boolean;
  authFilePath?: string;
  fetchImpl?: FetchImplementation;
  readAuthFile?: (path: string) => string;
  statAuthFile?: (path: string) => Stats;
  now?: () => number;
  requestTimeoutMs?: number;
  verifyTtlMs?: number;
  protocolTtlMs?: number;
}

export class AgentZeroAuthSessionError extends Error {
  constructor(
    message: string,
    readonly state: Exclude<AgentZeroAuthReadinessState, 'unchecked' | 'authenticated'>,
  ) {
    super(message);
    this.name = 'AgentZeroAuthSessionError';
  }
}

function parseBoolean(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value!)));
}

function decodeEnvValue(raw: string): string {
  const value = raw.trim();
  if (['"', "'"].includes(value[0] || '')) {
    if (value.length < 2 || value[value.length - 1] !== value[0]) {
      throw new Error('unbalanced quote');
    }
    const inner = value.slice(1, -1);
    if (value[0] === "'") return inner.replace(/\\([\\'])/g, '$1');
    return inner.replace(/\\([\\"])/g, '$1');
  }
  return value;
}

export function readProtectedAgentZeroCredentials(
  authFilePath: string,
  readAuthFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
  statAuthFile: (path: string) => Stats = lstatSync,
): AgentZeroCredentials {
  try {
    if (!authFilePath.startsWith('/') || authFilePath.includes('\u0000')) throw new Error('invalid path');
    const stat = statAuthFile(authFilePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0) {
      throw new Error('unsafe file');
    }

    const values = new Map<string, string>();
    for (const rawLine of readAuthFile(authFilePath).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (!match || !['AUTH_LOGIN', 'AUTH_PASSWORD'].includes(match[1])) {
        throw new Error('unexpected credential setting');
      }
      if (values.has(match[1])) throw new Error('duplicate credential');
      values.set(match[1], decodeEnvValue(match[2]));
    }

    const username = values.get('AUTH_LOGIN') || '';
    const password = values.get('AUTH_PASSWORD') || '';
    if (!username || !password || username.length > 256 || password.length > 1024) throw new Error('invalid credential');
    if (/[\u0000-\u001F\u007F]/.test(username) || /[\u0000-\u001F\u007F]/.test(password)) {
      throw new Error('control character');
    }
    return { username, password };
  } catch {
    throw new AgentZeroAuthSessionError(
      'Protected Agent Zero credentials are not configured correctly on the server.',
      'unconfigured',
    );
  }
}

function splitSetCookieHeader(combined: string): string[] {
  return combined.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/g).map((value) => value.trim()).filter(Boolean);
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const discrete = withGetSetCookie.getSetCookie?.();
  if (discrete?.length) return discrete;
  const combined = headers.get('set-cookie');
  return combined ? splitSetCookieHeader(combined) : [];
}

function cookieHeaderFromResponse(response: Response, now: number): string {
  const cookies = new Map<string, string>();
  for (const header of getSetCookieHeaders(response.headers)) {
    const parts = header.split(';').map((part) => part.trim());
    const separator = parts[0]?.indexOf('=') ?? -1;
    if (separator <= 0) continue;
    const name = parts[0].slice(0, separator).trim();
    const value = parts[0].slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) continue;
    if (!value || value.length > 2048 || /[\u0000-\u001F\u007F;,]/.test(value)) continue;

    let expired = false;
    for (const attribute of parts.slice(1)) {
      const [rawName, ...rawValue] = attribute.split('=');
      const attributeName = rawName.trim().toLowerCase();
      const attributeValue = rawValue.join('=').trim();
      if (attributeName === 'max-age' && Number.parseInt(attributeValue, 10) <= 0) expired = true;
      if (attributeName === 'expires') {
        const expiresAt = Date.parse(attributeValue);
        if (Number.isFinite(expiresAt) && expiresAt <= now) expired = true;
      }
    }
    if (!expired) cookies.set(name, value);
  }

  const cookieHeader = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  if (!cookieHeader || cookieHeader.length > 4096) {
    throw new AgentZeroAuthSessionError(
      'Agent Zero did not create a valid protected web session.',
      'needs_login',
    );
  }
  return cookieHeader;
}

function isLoginRedirect(response: Response): boolean {
  if (![301, 302, 303, 307, 308].includes(response.status)) return false;
  const location = response.headers.get('location')?.trim();
  if (!location) return false;
  try {
    const path = new URL(location, 'http://agent-zero.invalid').pathname;
    return path === '/login' || path.endsWith('/login');
  } catch {
    return false;
  }
}

function abortedAuthenticationError(): AgentZeroAuthSessionError {
  return new AgentZeroAuthSessionError(
    'Agent Zero authentication was interrupted before it could be verified.',
    'error',
  );
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortedAuthenticationError();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortedAuthenticationError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  const abort = () => target.abort();
  if (source.aborted) abort();
  else source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

async function readBoundedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const declaredLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new AgentZeroAuthSessionError('Agent Zero returned an oversized authentication response.', 'error');
  }

  if (!response.body) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          void reader.cancel().catch(() => undefined);
          reject(abortedAuthenticationError());
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      })
    : null;
  try {
    while (true) {
      const read = reader.read();
      const { done, value } = await (aborted ? Promise.race([read, aborted]) : read);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AgentZeroAuthSessionError('Agent Zero returned an oversized authentication response.', 'error');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Aborted body readers may still be unwinding. They are already detached
      // from every cache/write path by the owning authentication generation.
    }
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AgentZeroAuthSessionError('Agent Zero returned malformed authentication JSON.', 'error');
  }
}

export class AgentZeroAuthSessionManager implements AgentZeroSessionProvider {
  readonly baseUrl: string;

  private readonly authFilePath: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly readAuthFile: (path: string) => string;
  private readonly statAuthFile: (path: string) => Stats;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly verifyTtlMs: number;
  private readonly protocolTtlMs: number;
  private sessionCookie: string | null = null;
  private verifiedAt = 0;
  private protocolCheckedAt = 0;
  private authenticationGeneration = 0;
  private authenticationAttempt: {
    generation: number;
    controller: AbortController;
    promise: Promise<string>;
  } | null = null;
  private readiness: AgentZeroAuthReadiness = {
    state: 'unchecked',
    authenticated: false,
    reason: 'Agent Zero authentication has not been checked yet.',
  };

  constructor(options: AgentZeroAuthSessionOptions = {}) {
    const allowRemote = options.allowRemote ?? parseBoolean(process.env.AGENT_ZERO_ALLOW_REMOTE);
    this.baseUrl = normalizeAgentZeroBaseUrl(
      options.baseUrl || process.env.AGENT_ZERO_BASE_URL || AGENT_ZERO_DEFAULT_BASE_URL,
      allowRemote,
    );
    this.authFilePath = options.authFilePath || process.env.AGENT_ZERO_AUTH_FILE || DEFAULT_AUTH_FILE;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new AgentZeroAuthSessionError('The server runtime does not provide HTTP fetch support.', 'error');
    }
    this.readAuthFile = options.readAuthFile || ((path) => readFileSync(path, 'utf8'));
    this.statAuthFile = options.statAuthFile || lstatSync;
    this.now = options.now || Date.now;
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs, DEFAULT_TIMEOUT_MS, 250, 120_000);
    this.verifyTtlMs = boundedInteger(options.verifyTtlMs, DEFAULT_VERIFY_TTL_MS, 0, 5 * 60_000);
    this.protocolTtlMs = boundedInteger(options.protocolTtlMs, DEFAULT_PROTOCOL_TTL_MS, 0, 5 * 60_000);
  }

  snapshot(): AgentZeroAuthReadiness {
    return { ...this.readiness };
  }

  invalidateSession(): void {
    this.retireAuthenticationAttempt();
    this.sessionCookie = null;
    this.verifiedAt = 0;
  }

  async resetReadiness(): Promise<void> {
    const retiring = this.authenticationAttempt;
    this.retireAuthenticationAttempt();
    if (retiring) await retiring.promise.catch(() => undefined);
    this.sessionCookie = null;
    this.verifiedAt = 0;
    this.protocolCheckedAt = 0;
    this.readiness = {
      state: 'unchecked',
      authenticated: false,
      reason: 'Agent Zero authentication has not been checked since its protected configuration changed.',
    };
  }

  async probe(forceRefresh = false, signal?: AbortSignal): Promise<AgentZeroAuthReadiness> {
    try {
      await this.getSessionCookie(forceRefresh, signal);
    } catch {
      // The sanitized readiness state is the API contract; credentials and
      // cookies are never returned or logged here.
    }
    return this.snapshot();
  }

  async getSessionCookie(forceRefresh = false, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw abortedAuthenticationError();

    const retiring = forceRefresh ? this.authenticationAttempt : null;
    if (forceRefresh) {
      this.sessionCookie = null;
      this.verifiedAt = 0;
      if (retiring) {
        this.retireAuthenticationAttempt(retiring);
        // A forced recovery never accumulates work. The next generation starts
        // only after the aborted predecessor has actually settled.
        await awaitWithAbort(retiring.promise.catch(() => undefined), signal);
      }
    }

    const joined = this.authenticationAttempt;
    if (joined && joined !== retiring) return awaitWithAbort(joined.promise, signal);

    const generation = ++this.authenticationGeneration;
    const controller = new AbortController();
    const unlink = linkAbortSignal(signal, controller);
    const attempt = {
      generation,
      controller,
      promise: Promise.resolve(''),
    };
    const pending = this.authenticate(generation, controller.signal);
    attempt.promise = pending;
    this.authenticationAttempt = attempt;
    void pending.finally(() => {
      unlink();
      if (this.authenticationAttempt === attempt) this.authenticationAttempt = null;
    }).catch(() => undefined);
    return awaitWithAbort(pending, signal);
  }

  private setReadiness(
    generation: number,
    state: AgentZeroAuthReadinessState,
    reason: string,
  ): void {
    if (!this.isCurrentGeneration(generation)) return;
    this.readiness = {
      state,
      authenticated: state === 'authenticated',
      checkedAt: new Date(this.now()).toISOString(),
      reason,
    };
  }

  private async authenticate(generation: number, signal: AbortSignal): Promise<string> {
    try {
      this.assertCurrentGeneration(generation, signal);
      await this.ensureProtocolReady(generation, signal);
      this.assertCurrentGeneration(generation, signal);

      if (this.sessionCookie) {
        if (this.now() - this.verifiedAt <= this.verifyTtlMs
          || await this.verifySession(this.sessionCookie, signal)) {
          this.assertCurrentGeneration(generation, signal);
          this.verifiedAt = this.now();
          this.setReadiness(generation, 'authenticated', 'Agent Zero protected session authentication is ready.');
          return this.sessionCookie;
        }
        this.assertCurrentGeneration(generation, signal);
        this.sessionCookie = null;
        this.verifiedAt = 0;
      }

      const credentials = readProtectedAgentZeroCredentials(
        this.authFilePath,
        this.readAuthFile,
        this.statAuthFile,
      );
      const cookie = await this.login(credentials, signal);
      if (!await this.verifySession(cookie, signal)) {
        throw new AgentZeroAuthSessionError(
          'Agent Zero rejected the protected server-side credentials.',
          'needs_login',
        );
      }

      this.assertCurrentGeneration(generation, signal);
      this.sessionCookie = cookie;
      this.verifiedAt = this.now();
      this.setReadiness(generation, 'authenticated', 'Agent Zero protected session authentication is ready.');
      return cookie;
    } catch (error) {
      const safe = error instanceof AgentZeroAuthSessionError
        ? error
        : new AgentZeroAuthSessionError('Agent Zero authentication could not be verified.', 'error');
      if (this.isCurrentGeneration(generation)) {
        this.sessionCookie = null;
        this.verifiedAt = 0;
        this.setReadiness(generation, safe.state, safe.message);
      }
      throw safe;
    }
  }

  private async ensureProtocolReady(generation: number, signal: AbortSignal): Promise<void> {
    if (this.protocolCheckedAt && this.now() - this.protocolCheckedAt <= this.protocolTtlMs) return;
    const request = await this.fetch(`${this.baseUrl}${AGENT_ZERO_CONNECTOR_PATH}/capabilities`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}',
    }, signal);
    try {
      const { response } = request;
      this.rejectRedirect(response, 'capabilities');
      if (!response.ok) {
        throw new AgentZeroAuthSessionError('Agent Zero connector protocol readiness failed.', 'error');
      }
      validateAgentZeroCapabilities(await readBoundedJson(response, signal), { requireAuthentication: true });
      this.assertCurrentGeneration(generation, signal);
      this.protocolCheckedAt = this.now();
    } finally {
      request.release();
    }
  }

  private async login(credentials: AgentZeroCredentials, signal: AbortSignal): Promise<string> {
    const body = new URLSearchParams({
      username: credentials.username,
      password: credentials.password,
    }).toString();
    const request = await this.fetch(`${this.baseUrl}/login`, {
      method: 'POST',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    }, signal);
    try {
      const { response } = request;
      if (response.status === 401 || response.status === 403 || isLoginRedirect(response)) {
        throw new AgentZeroAuthSessionError('Agent Zero rejected the protected server-side credentials.', 'needs_login');
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location') || '';
        let target: URL;
        try {
          target = new URL(location, this.baseUrl);
        } catch {
          throw new AgentZeroAuthSessionError('Agent Zero login returned an invalid redirect.', 'error');
        }
        if (target.origin !== this.baseUrl) {
          throw new AgentZeroAuthSessionError('Agent Zero login attempted an unsafe cross-origin redirect.', 'error');
        }
      } else if (!response.ok) {
        throw new AgentZeroAuthSessionError('Agent Zero login failed.', 'error');
      }

      return cookieHeaderFromResponse(response, this.now());
    } finally {
      request.release();
    }
  }

  private async verifySession(cookie: string, signal: AbortSignal): Promise<boolean> {
    const request = await this.fetch(`${this.baseUrl}${AGENT_ZERO_CONNECTOR_PATH}/chats_list`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: '{}',
    }, signal);
    try {
      const { response } = request;
      if (response.status === 401 || response.status === 403 || isLoginRedirect(response)) return false;
      this.rejectRedirect(response, 'session verification');
      if (!response.ok) {
        throw new AgentZeroAuthSessionError('Agent Zero session verification failed.', 'error');
      }
      const body = await readBoundedJson(response, signal);
      if (!body || typeof body !== 'object' || !Array.isArray((body as Record<string, unknown>).contexts)) {
        throw new AgentZeroAuthSessionError('Agent Zero returned malformed session verification data.', 'error');
      }
      return true;
    } finally {
      request.release();
    }
  }

  private rejectRedirect(response: Response, operation: string): void {
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      throw new AgentZeroAuthSessionError(`Agent Zero ${operation} returned an unexpected redirect.`, 'error');
    }
  }

  private async fetch(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<{ response: Response; release: () => void }> {
    const controller = new AbortController();
    const unlink = linkAbortSignal(signal, controller);
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });
      let released = false;
      return {
        response,
        release: () => {
          if (released) return;
          released = true;
          clearTimeout(timer);
          unlink();
        },
      };
    } catch {
      clearTimeout(timer);
      unlink();
      throw new AgentZeroAuthSessionError('Agent Zero authentication request failed.', 'error');
    }
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.authenticationGeneration;
  }

  private assertCurrentGeneration(generation: number, signal?: AbortSignal): void {
    if (signal?.aborted || !this.isCurrentGeneration(generation)) throw abortedAuthenticationError();
  }

  private retireAuthenticationAttempt(
    expected: AgentZeroAuthSessionManager['authenticationAttempt'] = this.authenticationAttempt,
  ): void {
    if (!expected || this.authenticationAttempt !== expected) return;
    this.authenticationGeneration += 1;
    expected.controller.abort();
  }
}

let defaultManager: AgentZeroAuthSessionManager | null = null;

export function getDefaultAgentZeroAuthSessionManager(): AgentZeroAuthSessionManager {
  if (!defaultManager) defaultManager = new AgentZeroAuthSessionManager();
  return defaultManager;
}

export function getAgentZeroAuthReadinessSnapshot(): AgentZeroAuthReadiness {
  return getDefaultAgentZeroAuthSessionManager().snapshot();
}

export async function refreshAgentZeroAuthReadiness(
  forceRefresh = false,
  signal?: AbortSignal,
): Promise<AgentZeroAuthReadiness> {
  return getDefaultAgentZeroAuthSessionManager().probe(forceRefresh, signal);
}

export function clearDefaultAgentZeroAuthSessionForTests(): void {
  defaultManager = null;
}
