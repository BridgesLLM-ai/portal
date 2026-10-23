/**
 * Display-safety helpers for tool cards.
 *
 * Every string a tool card shows passes through `displayText`/`displayBlock`
 * here: secrets are masked, control characters stripped and length bounded.
 * Cards render the results as React text nodes only, so markup in tool names,
 * arguments or results stays inert text.
 */

export const REDACTED = '••••••';

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

type Replacement = string | ((match: string, ...groups: string[]) => string);

const SECRET_TEXT_PATTERNS: ReadonlyArray<[RegExp, Replacement]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[private key hidden]'],
  // Authorization headers keep their scheme; the credential is hidden whatever its length.
  [
    /(\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(Bearer|Basic|Token|Digest|Negotiate)\s+)?[^\s"'&;,]+/gi,
    (_match: string, prefix: string, scheme?: string) => `${prefix}${scheme ? `${scheme} ` : ''}${REDACTED}`,
  ],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // NAME=value / NAME: value / "NAME": value where NAME ends in a secret word (not *_TOKENS).
  [
    /\b([A-Za-z0-9_.-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key|credentials?|cookie))(["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'&;,]+)/gi,
    `$1$2${REDACTED}`,
  ],
  // CLI flags: --password hunter2, --api-key "x" (not --max-tokens 5 or --token-file p).
  [
    /(--?[A-Za-z0-9-]*(?:password|passwd|passphrase|secret|token|api-?key|access-?key)\s+)("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s"']*)/gi,
    `$1${REDACTED}`,
  ],
  // Credentials in URLs: userinfo and secret-bearing query parameters.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  [
    /([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|sig|signature|password|secret|client_secret|code|auth)=)[^&#\s]+/gi,
    `$1${REDACTED}`,
  ],
];

/** Mask well-known secret shapes inside free text. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) {
    out = typeof replacement === 'string'
      ? out.replace(pattern, replacement)
      : out.replace(pattern, replacement as (substring: string, ...args: any[]) => string);
  }
  return out;
}

const SECRET_KEY_SUFFIXES = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'apikey',
  'accesskey',
  'privatekey',
  'clientsecret',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'bearer',
  'signature',
  'token',
  'otp',
];

/**
 * True for argument keys whose values must never be shown. `token` matches as a
 * suffix (accessToken, refresh_token) but `maxTokens`/`tokenBudget` do not.
 */
export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return false;
  if (normalized === 'auth' || normalized === 'pin' || normalized === 'sessionsecret') return true;
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export interface ClippedText {
  text: string;
  truncated: boolean;
}

/**
 * Slice, then drop a token cut in half so a partial secret never survives
 * redaction. The look-back is bounded: a long unbroken run (minified JSON,
 * base64) keeps its hard cut rather than losing everything before it.
 */
function cutAtBoundary(text: string, length: number): string {
  const sliced = text.slice(0, length);
  if (!/\S$/.test(sliced) || !/\S/.test(text.charAt(length))) return sliced;
  const partial = /[\s,;"'<>=]([^\s,;"'<>=]*)$/.exec(sliced.slice(-256));
  return partial ? sliced.slice(0, sliced.length - partial[1].length) : sliced;
}

function stripControl(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

/** One display line: redacted, control-free, whitespace collapsed, bounded. */
export function displayText(value: unknown, maxChars = 160): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  if (!raw) return '';
  const bounded = raw.length > maxChars * 8 ? cutAtBoundary(raw, maxChars * 8) : raw;
  const cleaned = redactSecrets(stripControl(bounded))
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, Math.max(1, maxChars - 1))}…` : cleaned;
}

/** A multi-line block: redacted, bounded by characters and lines. */
export function displayBlock(value: unknown, maxChars = 4000, maxLines = 60): ClippedText {
  if (value === null || value === undefined) return { text: '', truncated: false };
  const raw = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  if (!raw) return { text: '', truncated: false };
  let truncated = false;
  // Bound before regex work so oversized payloads stay cheap to redact.
  let text = raw;
  if (text.length > maxChars * 2) {
    text = cutAtBoundary(text, maxChars * 2);
    truncated = true;
  }
  text = redactSecrets(stripControl(text.replace(/\r\n?/g, '\n')));
  const lines = text.split('\n');
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join('\n');
    truncated = true;
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { text: text.replace(/\s+$/, ''), truncated };
}

export interface SafeLink {
  /** Only http(s) URLs without embedded credentials or secret query values. */
  href: string | null;
  /** Redacted display form; always safe to show as text. */
  label: string;
  host: string | null;
}

/** Classify a URL-ish value for display. Never returns a non-http(s) href. */
export function safeLink(value: unknown): SafeLink | null {
  if (typeof value !== 'string') return null;
  const trimmed = stripControl(value).trim();
  if (!trimmed) return null;
  const label = displayText(trimmed, 200);
  if (trimmed.length > 2048) return { href: null, label, host: null };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { href: null, label, host: null };
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { href: null, label, host: null };
  }
  const host = parsed.hostname || null;
  const hasCredentials = Boolean(parsed.username || parsed.password);
  const redactedHref = redactSecrets(parsed.href);
  const href = hasCredentials || redactedHref !== parsed.href ? null : parsed.href;
  return { href, label, host };
}

/** Last two path segments, bounded, for compact titles. */
export function shortPath(value: unknown, maxChars = 60): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const short = parts.length > 2 ? parts.slice(-2).join('/') : trimmed;
  return displayText(short, maxChars) || null;
}

/**
 * Compact one-line description of an arbitrary argument value. Never
 * stringifies objects (cycles, depth and size stay irrelevant).
 */
export function summarizeValue(value: unknown, maxChars = 300): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'string') return displayText(value, maxChars);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.length <= 4 && value.every((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')) {
      return displayText(value.map((item) => String(item)).join(', '), maxChars);
    }
    return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
  }
  if (typeof value === 'object') {
    let count = 0;
    try {
      count = Object.keys(value as object).length;
    } catch {
      return '{…}';
    }
    return count === 0 ? '{}' : `{${count} field${count === 1 ? '' : 's'}}`;
  }
  return '';
}

/** Byte length of a string as UTF-8 without allocating for huge inputs. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
