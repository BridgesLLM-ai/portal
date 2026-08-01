import {
  getDefaultAgentZeroAuthSessionManager,
  type AgentZeroSessionProvider,
} from './AgentZeroAuthSession';
import {
  AGENT_ZERO_DEFAULT_BASE_URL,
  normalizeAgentZeroBaseUrl,
} from './AgentZeroConnectorContract';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 120_000;
const MIN_RESPONSE_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const AGENT_ZERO_OAUTH_DISCONNECT_CONFIRMATION = 'DISCONNECT AGENT ZERO OAUTH';

export const AGENT_ZERO_OAUTH_PROVIDER_IDS = [
  'codex_oauth',
  'github_copilot_oauth',
  'gemini_api_oauth',
  'xai_grok_oauth',
] as const;

export type AgentZeroOAuthProviderId = typeof AGENT_ZERO_OAUTH_PROVIDER_IDS[number];
export type AgentZeroOAuthConnectionState =
  | 'connected'
  | 'disconnected'
  | 'expired'
  | 'revoked'
  | 'error';

export interface AgentZeroOAuthProviderStatus {
  providerId: AgentZeroOAuthProviderId;
  displayName: string;
  shortName: string;
  authFlow: 'device_code' | 'browser_pkce';
  connected: boolean;
  connectionState: AgentZeroOAuthConnectionState;
  reconnectRequired: boolean;
  accountLabel: string;
  warning: string;
  note: string;
  supportsManualCallback: boolean;
  supportsEnterpriseDomain: boolean;
  supportsOAuthClientConfig: boolean;
  supportsQuotaProject: boolean;
  defaultModel: string;
  defaultModels: string[];
  usageWindows: Array<{
    key: string;
    title: string;
    label: string;
    remainingPercent: number;
    resetAt: number;
  }>;
}

export interface AgentZeroOAuthStatus {
  available: boolean;
  routesInstalled: boolean;
  connectedCount: number;
  availableCount: number;
  providers: AgentZeroOAuthProviderStatus[];
  checkedAt: string;
}

export interface AgentZeroOAuthLoginStart {
  ok: true;
  providerId: AgentZeroOAuthProviderId;
  flow: 'device_code' | 'browser_pkce';
  attemptId: string;
  verificationUrl: string;
  userCode: string;
  authUrl: string;
  redirectUri: string;
  interval: number;
  expiresAt: number;
  message: string;
}

export interface AgentZeroOAuthLoginPoll {
  ok: true;
  providerId: AgentZeroOAuthProviderId;
  completed: boolean;
  expired: boolean;
  accountLabel: string;
  interval: number;
  expiresAt: number;
  warning: string;
}

export interface AgentZeroOAuthModel {
  id: string;
  displayName: string;
  description: string;
}

export interface AgentZeroOAuthModels {
  providerId: AgentZeroOAuthProviderId;
  models: AgentZeroOAuthModel[];
}

export interface AgentZeroOAuthModelCatalog {
  available: true;
  providers: Array<{
    providerId: AgentZeroOAuthProviderId;
    displayName: string;
    accountLabel: string;
    connectionState: AgentZeroOAuthConnectionState;
    models: AgentZeroOAuthModel[];
  }>;
  checkedAt: string;
}

export interface AgentZeroOAuthClientOptions {
  baseUrl?: string;
  allowRemote?: boolean;
  sessionProvider?: AgentZeroSessionProvider;
  fetchImpl?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
}

export class AgentZeroOAuthError extends Error {
  constructor(
    message: string,
    readonly code: 'UNAVAILABLE' | 'AUTHENTICATION' | 'INVALID_REQUEST' | 'UPSTREAM_REJECTED',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AgentZeroOAuthError';
  }
}

type UnknownRecord = Record<string, unknown>;

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

function parseBoolean(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  const abort = () => target.abort();
  if (source.aborted) abort();
  else source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

function safeText(value: unknown, maximum = 300): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/([?&](?:access_token|refresh_token|id_token|token|code|state)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|cookie|code)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]{8,})?\b/g, '[redacted token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function safeRedactedText(value: unknown, redactions: string[], maximum = 300): string {
  if (typeof value !== 'string') return '';
  let redacted = value;
  for (const secret of redactions) {
    if (secret.length >= 3) redacted = redacted.split(secret).join('[redacted]');
  }
  return safeText(redacted, maximum);
}

function safeBoundedInput(value: unknown, label: string, maximum: number, allowEmpty = true): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new AgentZeroOAuthError(`${label} is invalid.`, 'INVALID_REQUEST');
  }
  const normalized = value.trim();
  if ((!allowEmpty && !normalized)
    || normalized.length > maximum
    || /[\u0000-\u001F\u007F]/.test(normalized)) {
    throw new AgentZeroOAuthError(`${label} is invalid.`, 'INVALID_REQUEST');
  }
  return normalized;
}

function providerId(value: unknown): AgentZeroOAuthProviderId {
  const normalized = safeBoundedInput(value, 'OAuth provider', 64, false);
  if (!AGENT_ZERO_OAUTH_PROVIDER_IDS.includes(normalized as AgentZeroOAuthProviderId)) {
    throw new AgentZeroOAuthError('The requested Agent Zero OAuth provider is unavailable.', 'INVALID_REQUEST');
  }
  return normalized as AgentZeroOAuthProviderId;
}

function safeNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeUrl(value: unknown, kind: 'external' | 'redirect'): string {
  if (typeof value !== 'string' || !value || value.length > 8192) return '';
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return '';
    if (kind === 'external') return parsed.protocol === 'https:' ? parsed.toString() : '';
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
    return (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))
      ? parsed.toString()
      : '';
  } catch {
    return '';
  }
}

function normalizedGitHubHost(value: unknown): string {
  const input = safeBoundedInput(value, 'GitHub Enterprise domain', 253);
  if (!input) return 'github.com';
  try {
    const parsed = new URL(input.includes('://') ? input : `https://${input}`);
    if (parsed.username || parsed.password || parsed.port) return '';
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function assertOfficialAuthorizationUrl(
  provider: AgentZeroOAuthProviderId,
  value: string,
  enterpriseDomain: unknown,
): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AgentZeroOAuthError('Agent Zero returned an invalid authorization URL.', 'UPSTREAM_REJECTED');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  // xAI publishes its endpoints through OIDC discovery rather than fixed
  // paths, and the same check runs against the device verification URI as
  // against the browser authorization URL. Those endpoints can differ and
  // change, so a single fixed path would reject valid discovered URLs.
  //
  // So trust the x.ai host family over TLS, which is exactly the boundary
  // OpenClaw's own xAI OAuth applies (`requireTrustedXaiOAuthEndpoint`) to the
  // discovered token endpoint — a strictly more sensitive target than a URL we
  // only send the user to visit.
  if (provider === 'xai_grok_oauth') {
    if (parsed.protocol !== 'https:' || (host !== 'x.ai' && !host.endsWith('.x.ai'))) {
      throw new AgentZeroOAuthError(
        'Agent Zero returned an authorization URL outside the official provider endpoint.',
        'UPSTREAM_REJECTED',
      );
    }
    return;
  }
  const expected = provider === 'codex_oauth'
    ? { host: 'auth.openai.com', path: '/codex/device' }
    : provider === 'github_copilot_oauth'
      ? { host: normalizedGitHubHost(enterpriseDomain), path: '/login/device' }
      : { host: 'accounts.google.com', path: '/o/oauth2/v2/auth' };
  if (!expected.host || host !== expected.host || parsed.pathname !== expected.path) {
    throw new AgentZeroOAuthError(
      'Agent Zero returned an authorization URL outside the official provider endpoint.',
      'UPSTREAM_REJECTED',
    );
  }
}

/**
 * Agent Zero reports `expires_at` as a fractional Unix timestamp in *seconds*,
 * while everything downstream compares against `Date.now()` in milliseconds.
 * Mixing the two silently broke every comparison: the OAuth review window
 * collapsed to its floor, and the disconnect expiry gate read as always
 * elapsed because a seconds value is always less than a millisecond clock.
 * Normalize once, here at the boundary.
 */
function expiryMs(value: unknown): number {
  const parsed = Math.max(0, safeNumber(value, 0));
  if (!parsed) return 0;
  return parsed < 1_000_000_000_000 ? Math.round(parsed * 1000) : Math.round(parsed);
}

function stringArray(value: unknown, maximumItems = 100, maximumLength = 200): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, maximumItems)) {
    const normalized = safeText(entry, maximumLength);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      output.push(normalized);
    }
  }
  return output;
}

function splitSetCookieHeader(combined: string): string[] {
  return combined
    .split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/g)
    .map((value) => value.trim())
    .filter(Boolean);
}

function setCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const discrete = extended.getSetCookie?.();
  if (discrete?.length) return discrete;
  const combined = headers.get('set-cookie');
  return combined ? splitSetCookieHeader(combined) : [];
}

function mergeCookieHeader(current: string, response: Response, now: number): string {
  const cookies = new Map<string, string>();
  const ingestPair = (pair: string) => {
    const separator = pair.indexOf('=');
    if (separator <= 0) return;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)
      || !value
      || value.length > 2048
      || /[\u0000-\u001F\u007F;,]/.test(value)) return;
    cookies.set(name, value);
  };
  for (const part of current.split(/;\s*/)) ingestPair(part);
  for (const header of setCookieHeaders(response.headers)) {
    const parts = header.split(';').map((part) => part.trim());
    const pair = parts.shift() || '';
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    let expired = false;
    for (const attribute of parts) {
      const [rawName, ...rawValue] = attribute.split('=');
      const attributeName = rawName.trim().toLowerCase();
      const attributeValue = rawValue.join('=').trim();
      if (attributeName === 'max-age' && Number.parseInt(attributeValue, 10) <= 0) expired = true;
      if (attributeName === 'expires') {
        const expiresAt = Date.parse(attributeValue);
        if (Number.isFinite(expiresAt) && expiresAt <= now) expired = true;
      }
    }
    if (expired) cookies.delete(name);
    else ingestPair(pair);
  }
  const merged = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  if (!merged || merged.length > 4096) {
    throw new AgentZeroOAuthError('Agent Zero protected session authentication is unavailable.', 'AUTHENTICATION');
  }
  return merged;
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function isLoginRedirect(response: Response): boolean {
  if (!isRedirect(response.status)) return false;
  const location = response.headers.get('location') || '';
  try {
    const pathname = new URL(location, 'http://agent-zero.invalid').pathname;
    return pathname === '/login' || pathname.endsWith('/login');
  } catch {
    return false;
  }
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
  controller: AbortController,
): Promise<unknown> {
  const declared = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    controller.abort();
    throw new AgentZeroOAuthError('Agent Zero returned an oversized OAuth response.', 'UPSTREAM_REJECTED');
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  const signal = controller.signal;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      void reader.cancel().catch(() => undefined);
      reject(new AgentZeroOAuthError(
        'Agent Zero OAuth request was interrupted before its response completed.',
        'UNAVAILABLE',
      ));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw new AgentZeroOAuthError('Agent Zero returned an oversized OAuth response.', 'UPSTREAM_REJECTED');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may still be unwinding the reader; the owning request
      // generation already prevents this body from publishing any state.
    }
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AgentZeroOAuthError('Agent Zero returned malformed OAuth data.', 'UPSTREAM_REJECTED');
  }
}

function sanitizeProvider(raw: unknown): AgentZeroOAuthProviderStatus | null {
  if (!isRecord(raw)) return null;
  let id: AgentZeroOAuthProviderId;
  try {
    id = providerId(raw.provider_id);
  } catch {
    return null;
  }
  const flow = raw.auth_flow === 'browser_pkce'
    ? 'browser_pkce'
    : raw.auth_flow === 'device_code'
      ? 'device_code'
      : null;
  if (!flow) return null;
  const usageWindows = Array.isArray(raw.usage_windows)
    ? raw.usage_windows.slice(0, 4).flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const remainingPercent = Math.max(0, Math.min(100, safeNumber(entry.remaining_percent, 0)));
        return [{
          key: safeText(entry.key, 32),
          title: safeText(entry.title, 80),
          label: safeText(entry.label, 120),
          remainingPercent,
          resetAt: Math.max(0, safeNumber(entry.reset_at, 0)),
        }];
      })
    : [];
  const connected = raw.connected === true;
  const rawConnectionState = safeText(
    raw.connection_state || raw.connection_status || raw.auth_status,
    64,
  ).toLowerCase();
  const connectionDiagnostic = safeText(
    raw.warning || raw.models_warning || raw.error || raw.message,
    500,
  ).toLowerCase();
  const connectionState: AgentZeroOAuthConnectionState = connected
    ? 'connected'
    : /revok/.test(rawConnectionState) || /revok/.test(connectionDiagnostic)
      ? 'revoked'
      : /expir/.test(rawConnectionState) || /expir/.test(connectionDiagnostic)
        ? 'expired'
        : /error|failed|invalid/.test(rawConnectionState)
          ? 'error'
          : 'disconnected';
  return {
    providerId: id,
    displayName: safeText(raw.display_name, 80) || id,
    shortName: safeText(raw.short_name, 80) || safeText(raw.display_name, 80) || id,
    authFlow: flow,
    connected,
    connectionState,
    reconnectRequired: connectionState === 'expired' || connectionState === 'revoked',
    accountLabel: safeText(raw.account_label, 160),
    warning: safeText(raw.warning || raw.models_warning || raw.error || raw.message, 500),
    note: safeText(raw.note, 500),
    supportsManualCallback: raw.supports_manual_callback === true,
    supportsEnterpriseDomain: raw.supports_enterprise_domain === true,
    supportsOAuthClientConfig: raw.supports_oauth_client_config === true,
    supportsQuotaProject: raw.supports_quota_project === true,
    defaultModel: safeText(raw.default_model, 160),
    defaultModels: stringArray(raw.default_models, 100, 160),
    usageWindows,
  };
}

export class AgentZeroOAuthClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sessionProvider: AgentZeroSessionProvider;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly now: () => number;

  constructor(options: AgentZeroOAuthClientOptions = {}) {
    const allowRemote = options.allowRemote ?? parseBoolean(process.env.AGENT_ZERO_ALLOW_REMOTE);
    this.baseUrl = normalizeAgentZeroBaseUrl(
      options.baseUrl || process.env.AGENT_ZERO_BASE_URL || AGENT_ZERO_DEFAULT_BASE_URL,
      allowRemote,
    );
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new AgentZeroOAuthError('The server runtime does not provide OAuth HTTP support.', 'UNAVAILABLE');
    }
    this.sessionProvider = options.sessionProvider || getDefaultAgentZeroAuthSessionManager();
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );
    this.maxResponseBytes = boundedInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      MIN_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
    );
    this.now = options.now || Date.now;
  }

  async status(signal?: AbortSignal): Promise<AgentZeroOAuthStatus> {
    const raw = await this.post('/api/plugins/_oauth/status', {}, [], signal);
    this.assertUpstreamSuccess(raw, 'Agent Zero could not load OAuth connection status.');
    const providers = Array.isArray(raw.providers)
      ? raw.providers.map(sanitizeProvider).filter((value): value is AgentZeroOAuthProviderStatus => Boolean(value))
      : [];
    const ordered = AGENT_ZERO_OAUTH_PROVIDER_IDS.flatMap((id) => {
      const match = providers.find((provider) => provider.providerId === id);
      return match ? [match] : [];
    });
    return {
      available: raw.ok === true
        && raw.routes_installed === true
        && ordered.length === AGENT_ZERO_OAUTH_PROVIDER_IDS.length,
      routesInstalled: raw.routes_installed === true,
      connectedCount: ordered.filter((entry) => entry.connected).length,
      availableCount: ordered.filter((entry) => !entry.connected).length,
      providers: ordered,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  async startLogin(input: {
    providerId: unknown;
    enterpriseDomain?: unknown;
    clientId?: unknown;
    clientSecret?: unknown;
    quotaProjectId?: unknown;
  }, signal?: AbortSignal): Promise<AgentZeroOAuthLoginStart> {
    const selected = providerId(input.providerId);
    const payload: UnknownRecord = { provider_id: selected };
    if (selected === 'github_copilot_oauth') {
      payload.enterprise_domain = safeBoundedInput(input.enterpriseDomain, 'GitHub Enterprise domain', 253);
    } else if (selected === 'gemini_api_oauth') {
      payload.client_id = safeBoundedInput(input.clientId, 'Google OAuth client ID', 512, false);
      payload.client_secret = safeBoundedInput(input.clientSecret, 'Google OAuth client secret', 2048, false);
      payload.quota_project_id = safeBoundedInput(input.quotaProjectId, 'Google quota project ID', 253);
    }
    const redactions = typeof payload.client_secret === 'string' ? [payload.client_secret] : [];
    const raw = await this.post('/api/plugins/_oauth/start_login', payload, redactions, signal);
    this.assertUpstreamSuccess(raw, 'Agent Zero could not start the OAuth connection.', redactions);
    const returnedProvider = providerId(raw.provider_id);
    if (returnedProvider !== selected) {
      throw new AgentZeroOAuthError('Agent Zero returned an OAuth provider mismatch.', 'UPSTREAM_REJECTED');
    }
    const flow = raw.flow === 'browser_pkce' ? 'browser_pkce' : raw.flow === 'device_code' ? 'device_code' : null;
    if (!flow) throw new AgentZeroOAuthError('Agent Zero returned an unsupported OAuth flow.', 'UPSTREAM_REJECTED');
    const attemptId = safeText(raw.attempt_id, 256);
    const verificationUrl = safeUrl(raw.verification_url, 'external');
    const userCode = safeText(raw.user_code, 128);
    const authUrl = safeUrl(raw.auth_url, 'external');
    const redirectUri = safeUrl(raw.redirect_uri, 'redirect');
    if (flow === 'device_code' && (!attemptId || !verificationUrl || !userCode)) {
      throw new AgentZeroOAuthError('Agent Zero returned an incomplete device authorization.', 'UPSTREAM_REJECTED');
    }
    if (flow === 'browser_pkce' && !authUrl) {
      throw new AgentZeroOAuthError('Agent Zero returned an incomplete browser authorization.', 'UPSTREAM_REJECTED');
    }
    if (flow === 'browser_pkce' && !redirectUri) {
      throw new AgentZeroOAuthError('Agent Zero returned an invalid OAuth callback destination.', 'UPSTREAM_REJECTED');
    }
    assertOfficialAuthorizationUrl(
      selected,
      flow === 'device_code' ? verificationUrl : authUrl,
      input.enterpriseDomain,
    );
    return {
      ok: true,
      providerId: returnedProvider,
      flow,
      attemptId,
      verificationUrl,
      userCode,
      authUrl,
      redirectUri,
      interval: Math.max(1, Math.min(60, Math.floor(safeNumber(raw.interval, 5)))),
      expiresAt: expiryMs(raw.expires_at),
      message: safeText(raw.message, 300),
    };
  }

  async pollLogin(
    input: { providerId: unknown; attemptId: unknown },
    signal?: AbortSignal,
  ): Promise<AgentZeroOAuthLoginPoll> {
    const selected = providerId(input.providerId);
    if (!['codex_oauth', 'github_copilot_oauth'].includes(selected)) {
      throw new AgentZeroOAuthError('This OAuth provider does not use device authorization.', 'INVALID_REQUEST');
    }
    const attemptId = safeBoundedInput(input.attemptId, 'OAuth attempt', 256, false);
    const raw = await this.post('/api/plugins/_oauth/poll_device_login', {
      provider_id: selected,
      attempt_id: attemptId,
    }, [attemptId], signal);
    if (raw.expired !== true) {
      this.assertUpstreamSuccess(raw, 'Agent Zero could not poll the OAuth connection.', [attemptId]);
    }
    const returnedProvider = providerId(raw.provider_id);
    if (returnedProvider !== selected) {
      throw new AgentZeroOAuthError('Agent Zero returned an OAuth provider mismatch.', 'UPSTREAM_REJECTED');
    }
    return {
      ok: true,
      providerId: returnedProvider,
      completed: raw.completed === true,
      expired: raw.expired === true,
      accountLabel: safeText(raw.account_label, 160),
      interval: Math.max(1, Math.min(60, Math.floor(safeNumber(raw.interval, 5)))),
      expiresAt: expiryMs(raw.expires_at),
      warning: safeText(raw.warning, 500),
    };
  }

  async completeManualCallback(input: {
    providerId: unknown;
    callback: unknown;
  }, signal?: AbortSignal): Promise<AgentZeroOAuthLoginPoll> {
    const selected = providerId(input.providerId);
    if (!['gemini_api_oauth', 'xai_grok_oauth'].includes(selected)) {
      throw new AgentZeroOAuthError('This OAuth provider does not support a manual callback.', 'INVALID_REQUEST');
    }
    const callback = safeBoundedInput(input.callback, 'OAuth callback', 8192, false);
    const raw = await this.post('/api/plugins/_oauth/manual_callback', {
      provider_id: selected,
      callback,
    }, [callback], signal);
    if (raw.expired !== true) {
      this.assertUpstreamSuccess(raw, 'Agent Zero could not complete the OAuth callback.', [callback]);
    }
    const returnedProvider = providerId(raw.provider_id);
    if (returnedProvider !== selected) {
      throw new AgentZeroOAuthError('Agent Zero returned an OAuth provider mismatch.', 'UPSTREAM_REJECTED');
    }
    return {
      ok: true,
      providerId: returnedProvider,
      completed: raw.completed === true || Boolean(raw.account_label),
      expired: raw.expired === true,
      accountLabel: safeText(raw.account_label, 160),
      interval: Math.max(1, Math.min(60, Math.floor(safeNumber(raw.interval, 5)))),
      expiresAt: expiryMs(raw.expires_at),
      warning: safeText(raw.warning, 500),
    };
  }

  async models(
    value: unknown,
    knownStatus?: AgentZeroOAuthStatus,
    signal?: AbortSignal,
  ): Promise<AgentZeroOAuthModels> {
    const selected = providerId(value);
    const status = knownStatus || await this.status(signal);
    if (!status.available) {
      throw new AgentZeroOAuthError(
        'Agent Zero did not advertise its complete official OAuth provider catalog.',
        'UNAVAILABLE',
      );
    }
    const provider = status.providers.find((entry) => entry.providerId === selected);
    if (!provider || !provider.connected || provider.connectionState !== 'connected') {
      const state = provider?.connectionState;
      const detail = state === 'expired'
        ? 'expired'
        : state === 'revoked'
          ? 'revoked'
          : 'disconnected';
      throw new AgentZeroOAuthError(
        `${provider?.displayName || selected} OAuth is ${detail}. Reconnect the account before selecting a model.`,
        'AUTHENTICATION',
      );
    }
    return this.loadModels(selected, signal);
  }

  async modelCatalog(signal?: AbortSignal): Promise<AgentZeroOAuthModelCatalog> {
    const status = await this.status(signal);
    if (!status.available) {
      throw new AgentZeroOAuthError(
        'Agent Zero did not advertise its complete official OAuth provider catalog.',
        'UNAVAILABLE',
      );
    }
    const providers: AgentZeroOAuthModelCatalog['providers'] = [];
    for (const provider of status.providers) {
      const models = provider.connected && provider.connectionState === 'connected'
        ? (await this.loadModels(provider.providerId, signal)).models
        : [];
      providers.push({
        providerId: provider.providerId,
        displayName: provider.displayName,
        accountLabel: provider.accountLabel,
        connectionState: provider.connectionState,
        models,
      });
    }
    return {
      available: true,
      providers,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  private async loadModels(
    selected: AgentZeroOAuthProviderId,
    signal?: AbortSignal,
  ): Promise<AgentZeroOAuthModels> {
    const raw = await this.post('/api/plugins/_oauth/models', { provider_id: selected }, [], signal);
    this.assertUpstreamSuccess(raw, 'Agent Zero could not load the OAuth model catalog.');
    const returnedProvider = providerId(raw.provider_id);
    if (returnedProvider !== selected) {
      throw new AgentZeroOAuthError('Agent Zero returned an OAuth provider mismatch.', 'UPSTREAM_REJECTED');
    }
    const metadata = Array.isArray(raw.model_metadata) ? raw.model_metadata : [];
    const byId = new Map<string, AgentZeroOAuthModel>();
    for (const entry of metadata.slice(0, 200)) {
      if (!isRecord(entry)) continue;
      const id = safeText(entry.slug || entry.id, 160);
      if (!id) continue;
      byId.set(id, {
        id,
        displayName: safeText(entry.display_name || entry.name, 160) || id,
        description: safeText(entry.description, 500),
      });
    }
    for (const id of stringArray(raw.models, 200, 160)) {
      if (byId.size >= 200) break;
      if (!byId.has(id)) byId.set(id, { id, displayName: id, description: '' });
    }
    const models = [...byId.values()].slice(0, 200);
    if (!models.length) {
      throw new AgentZeroOAuthError(
        'The connected Agent Zero OAuth account returned no selectable models. Reconnect it or verify its provider entitlement.',
        'UPSTREAM_REJECTED',
      );
    }
    return { providerId: returnedProvider, models };
  }

  async disconnect(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<{ providerId: AgentZeroOAuthProviderId; disconnected: boolean }> {
    const selected = providerId(value);
    const raw = await this.post('/api/plugins/_oauth/disconnect', { provider_id: selected }, [], signal);
    this.assertUpstreamSuccess(raw, 'Agent Zero could not disconnect the OAuth account.');
    const returnedProvider = providerId(raw.provider_id);
    if (returnedProvider !== selected || typeof raw.disconnected !== 'boolean') {
      throw new AgentZeroOAuthError('Agent Zero returned an invalid OAuth disconnection result.', 'UPSTREAM_REJECTED');
    }
    return { providerId: returnedProvider, disconnected: raw.disconnected };
  }

  private assertUpstreamSuccess(raw: UnknownRecord, fallback: string, redactions: string[] = []): void {
    if (raw.ok === true) return;
    const detail = safeRedactedText(raw.error || raw.message, redactions, 300);
    throw new AgentZeroOAuthError(detail || fallback, 'UPSTREAM_REJECTED');
  }

  private async post(
    relativePath: string,
    payload: UnknownRecord,
    redactions: string[] = [],
    signal?: AbortSignal,
  ): Promise<UnknownRecord> {
    const allowedPaths = new Set([
      '/api/plugins/_oauth/status',
      '/api/plugins/_oauth/start_login',
      '/api/plugins/_oauth/poll_device_login',
      '/api/plugins/_oauth/manual_callback',
      '/api/plugins/_oauth/models',
      '/api/plugins/_oauth/disconnect',
    ]);
    if (!allowedPaths.has(relativePath)) {
      throw new AgentZeroOAuthError('The requested Agent Zero OAuth operation is unavailable.', 'INVALID_REQUEST');
    }
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded, 'utf8') > 16 * 1024) {
      throw new AgentZeroOAuthError('The Agent Zero OAuth request is too large.', 'INVALID_REQUEST');
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const unlink = linkAbortSignal(signal, controller);
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      let cookie = '';
      try {
        cookie = await this.sessionProvider.getSessionCookie(attempt > 0, controller.signal);
        const csrfResponse = await this.fetchImpl(`${this.baseUrl}/api/csrf_token`, {
          method: 'GET',
          headers: { Accept: 'application/json', Cookie: cookie, Origin: this.baseUrl },
          redirect: 'manual',
          signal: controller.signal,
        });
        const csrfRejected = csrfResponse.status === 401
          || csrfResponse.status === 403
          || isLoginRedirect(csrfResponse);
        if (csrfRejected && attempt === 0) {
          this.sessionProvider.invalidateSession();
          await csrfResponse.body?.cancel().catch(() => undefined);
          continue;
        }
        if (csrfRejected) {
          throw new AgentZeroOAuthError('Agent Zero rejected the protected OAuth session.', 'AUTHENTICATION', csrfResponse.status);
        }
        if (!csrfResponse.ok || isRedirect(csrfResponse.status)) {
          await csrfResponse.body?.cancel().catch(() => undefined);
          throw new AgentZeroOAuthError('Agent Zero OAuth CSRF verification failed.', 'UNAVAILABLE', csrfResponse.status);
        }
        const csrfBody = await readBoundedJson(csrfResponse, this.maxResponseBytes, controller);
        if (!isRecord(csrfBody)) {
          throw new AgentZeroOAuthError('Agent Zero returned malformed OAuth CSRF data.', 'UPSTREAM_REJECTED');
        }
        const csrfToken = safeBoundedInput(
          csrfBody.csrf_token || csrfBody.csrfToken || csrfBody.token,
          'Agent Zero OAuth CSRF token',
          4096,
          false,
        );
        cookie = mergeCookieHeader(cookie, csrfResponse, this.now());

        const response = await this.fetchImpl(`${this.baseUrl}${relativePath}`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Cookie: cookie,
            Origin: this.baseUrl,
            'X-CSRF-Token': csrfToken,
          },
          body: encoded,
          redirect: 'manual',
          signal: controller.signal,
        });
        const authenticationRejected = response.status === 401
          || response.status === 403
          || isLoginRedirect(response);
        if (authenticationRejected && attempt === 0) {
          this.sessionProvider.invalidateSession();
          await response.body?.cancel().catch(() => undefined);
          continue;
        }
        if (authenticationRejected) {
          throw new AgentZeroOAuthError('Agent Zero rejected the protected OAuth session.', 'AUTHENTICATION', response.status);
        }
        if (isRedirect(response.status)) {
          throw new AgentZeroOAuthError('Agent Zero OAuth returned an unexpected redirect.', 'UPSTREAM_REJECTED', response.status);
        }
        const body = await readBoundedJson(response, this.maxResponseBytes, controller);
        if (!response.ok) {
          const detail = isRecord(body)
            ? safeRedactedText(body.error || body.message, redactions, 300)
            : '';
          throw new AgentZeroOAuthError(detail || 'Agent Zero OAuth request failed.', 'UPSTREAM_REJECTED', response.status);
        }
        if (!isRecord(body)) {
          throw new AgentZeroOAuthError('Agent Zero returned malformed OAuth data.', 'UPSTREAM_REJECTED');
        }
        return body;
      } catch (error) {
        if (error instanceof AgentZeroOAuthError) throw error;
        if (controller.signal.aborted) {
          throw new AgentZeroOAuthError('Agent Zero OAuth request timed out.', 'UNAVAILABLE');
        }
        throw new AgentZeroOAuthError('Agent Zero OAuth request failed.', 'UNAVAILABLE');
      } finally {
        clearTimeout(timer);
        unlink();
      }
    }
    throw new AgentZeroOAuthError('Agent Zero protected OAuth session is unavailable.', 'AUTHENTICATION');
  }
}

let defaultClient: AgentZeroOAuthClient | null = null;

export function getDefaultAgentZeroOAuthClient(): AgentZeroOAuthClient {
  if (!defaultClient) defaultClient = new AgentZeroOAuthClient();
  return defaultClient;
}

export function clearDefaultAgentZeroOAuthClientForTests(): void {
  defaultClient = null;
}

export function __setDefaultAgentZeroOAuthClientForTests(client: AgentZeroOAuthClient | null): void {
  defaultClient = client;
}
