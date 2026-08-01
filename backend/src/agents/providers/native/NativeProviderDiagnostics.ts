import { createHash, randomUUID } from 'crypto';

export const NATIVE_DIAGNOSTIC_MAX_BYTES = 32 * 1024;
export const NATIVE_EVENT_TEXT_MAX_BYTES = 64 * 1024;

const ANSI_RE = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export type NativeProviderErrorCode =
  | 'AUTH_REQUIRED'
  | 'MODEL_REJECTED'
  | 'RATE_LIMITED'
  | 'TIMED_OUT'
  | 'PERMISSION_DENIED'
  | 'RUNTIME_UNAVAILABLE'
  | 'PROVIDER_FAILED';

export class NativeProviderDiagnosticError extends Error {
  readonly code: NativeProviderErrorCode;
  readonly diagnosticId: string;

  constructor(code: NativeProviderErrorCode, safeMessage: string, diagnosticId: string = randomUUID()) {
    super(safeMessage);
    this.name = 'NativeProviderDiagnosticError';
    this.code = code;
    this.diagnosticId = diagnosticId;
  }
}

function capUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const buffer = Buffer.from(value, 'utf8');
  return buffer.subarray(buffer.length - maxBytes).toString('utf8');
}

/**
 * Retains a bounded diagnostic tail. Joining happens before redaction so a
 * credential split across stderr chunks cannot evade the redactor.
 */
export function appendBoundedNativeDiagnostic(current: string, chunk: string): string {
  return capUtf8(`${current || ''}${chunk || ''}`, NATIVE_DIAGNOSTIC_MAX_BYTES);
}

export function stripNativeControlCharacters(value: string): string {
  return String(value || '').replace(ANSI_RE, '').replace(CONTROL_RE, '');
}

function redactUrl(match: string): string {
  try {
    const url = new URL(match);
    return `${url.protocol}//${url.host}/[path/query redacted]`;
  } catch {
    return '[url redacted]';
  }
}

export function redactNativeProviderText(value: string, maxBytes = NATIVE_EVENT_TEXT_MAX_BYTES): string {
  // Redact before truncation. Truncating first can cut off a credential label
  // while retaining the secret value that followed it, defeating labeled
  // secret patterns at exactly the size boundary.
  let text = stripNativeControlCharacters(value);

  // Redact complete URLs before generic credential patterns. Userinfo, query
  // strings, fragments, paths, and OAuth callback codes are never client-visible.
  text = text.replace(/https?:\/\/[^\s<>'"`]+/gi, redactUrl);
  text = text
    .replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/gi, '[private key redacted]')
    .replace(/\b(authorization|proxy-authorization)\s*:\s*[^\r\n]+/gi, '$1: [redacted]')
    .replace(/\b(set-cookie|cookie)\s*:\s*[^\r\n]+/gi, '$1: [redacted]')
    .replace(/\b(x-api-key|api[-_ ]?key|password|passwd|passphrase|secret|client[-_ ]?secret|auth[-_ ]?token|bearer[-_ ]?token|gateway[-_ ]?token|device[-_ ]?token|session[-_ ]?token|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|oauth[-_ ]?code|private[-_ ]?key|jwt)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,"';]+)/gi, '$1=[redacted]')
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[authorization redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g, '[jwt redacted]')
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|ya29|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, '[credential redacted]')
    .replace(/(?:\/root|\/home\/[^/\s]+)\/\.(?:claude|codex|gemini|config)\/[^\s:'"]+/gi, '[credential path redacted]');

  return capUtf8(text, maxBytes).trim();
}

function isSensitiveNativeProviderKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!normalized) return false;
  if (
    normalized.includes('authorization')
    || normalized.includes('cookie')
    || normalized.includes('password')
    || normalized.includes('passwd')
    || normalized.includes('passphrase')
    || normalized.includes('apikey')
    || normalized.includes('privatekey')
    || normalized.includes('credential')
    || normalized.includes('secret')
  ) return true;
  return normalized === 'jwt'
    || normalized === 'token'
    || normalized.endsWith('token')
    || normalized.endsWith('oauthcode');
}

export function sanitizeNativeProviderEvent<T>(value: T, depth = 0): T {
  if (depth > 8) return '[truncated]' as T;
  if (typeof value === 'string') return redactNativeProviderText(value) as T;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((entry) => sanitizeNativeProviderEvent(entry, depth + 1)) as T;
  }
  if (!value || typeof value !== 'object') return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
    if (isSensitiveNativeProviderKey(key)) {
      sanitized[key] = '[redacted]';
      continue;
    }
    sanitized[key] = sanitizeNativeProviderEvent(entry, depth + 1);
  }
  return sanitized as T;
}

export function isNativeProviderAuthFailure(raw: string): boolean {
  const normalized = stripNativeControlCharacters(raw);
  if (/\b(?:unauthori[sz]ed|forbidden|authentication[_ -]failed|failed to authenticate|authentication (?:is )?(?:required|failed|unavailable)|not signed in|please sign in|login required|invalid (?:api )?key|expired (?:access )?token|token (?:expired|revoked)|oauth[^\n]*(?:expired|revoked|invalid|could not be refreshed)|(?:access|refresh) token[^\n]*could not be refreshed)\b/i.test(normalized)) {
    return true;
  }
  // A bare HTTP status may come from a user tool and must not poison provider
  // readiness. Accept 401/403 only when the same diagnostic explicitly ties it
  // to the provider credential/authentication layer.
  return /\b(?:provider|account|credential|authentication|authorization|oauth|access token|refresh token)\b[^\n]{0,120}\b(?:401|403)\b|\b(?:401|403)\b[^\n]{0,120}\b(?:provider|account|credential|authentication|authorization|oauth|access token|refresh token)\b/i.test(normalized);
}

export function classifyNativeProviderError(
  providerDisplayName: string,
  raw: string,
  fallbackCode: NativeProviderErrorCode = 'PROVIDER_FAILED',
): NativeProviderDiagnosticError {
  const normalized = stripNativeControlCharacters(raw);
  let code = fallbackCode;
  let safeMessage = `${providerDisplayName} could not complete the request. Retry, or check AI Settings if the problem continues.`;

  if (isNativeProviderAuthFailure(normalized)) {
    code = 'AUTH_REQUIRED';
    safeMessage = `${providerDisplayName} authentication is unavailable. Reconnect it in AI Settings and retry.`;
  } else if (/\b(?:unknown|invalid|unsupported|unavailable) model\b|\bmodel\b[^\n]*(?:not found|entitlement|not available|rejected)/i.test(normalized)) {
    code = 'MODEL_REJECTED';
    safeMessage = `${providerDisplayName} rejected the selected model. Choose an available model and retry.`;
  } else if (/\b(?:429|rate limit|too many requests|quota exceeded|usage limit)\b/i.test(normalized)) {
    code = 'RATE_LIMITED';
    safeMessage = `${providerDisplayName} is temporarily rate limited. Wait for the provider quota window and retry.`;
  } else if (/\b(?:timed? out|timeout|deadline exceeded)\b/i.test(normalized)) {
    code = 'TIMED_OUT';
    safeMessage = `${providerDisplayName} did not respond before the timeout. Retry the turn.`;
  } else if (/\b(?:permission denied|operation not permitted|sandbox denied|outside (?:the )?workspace)\b/i.test(normalized)) {
    code = 'PERMISSION_DENIED';
    safeMessage = `${providerDisplayName} could not complete an operation within the approved execution scope.`;
  } else if (/\b(?:enoent|not found|failed to spawn|connection refused|service unavailable)\b/i.test(normalized)) {
    code = 'RUNTIME_UNAVAILABLE';
    safeMessage = `${providerDisplayName} is not available on this server right now.`;
  }

  // A stable short fingerprint helps operators correlate sanitized failures
  // without retaining the provider's secret-bearing diagnostic.
  const fingerprint = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return new NativeProviderDiagnosticError(code, safeMessage, `${randomUUID()}:${fingerprint}`);
}
