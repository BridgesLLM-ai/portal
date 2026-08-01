const THINKING_SUBJECT_MAX_CHARS = 96;

const NON_WHITESPACE_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const WHITESPACE_CONTROL_RE = /[\t\n\r]/g;
const BIDI_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const REPLY_TAG_RE = /(?:<\s*\/?\s*(?:openclaw[-_:]?)?reply\b[^>]*>|\[\[\s*reply(?:_to)?\b[^\]]*\]\])/gi;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;
const CREDENTIAL_HEADER_RE = /\b(?:(?:proxy-)?authorization|cookie|set-cookie|[a-z0-9][a-z0-9_-]*(?:api[-_]?key|auth(?:orization)?|token|secret|credential|password)[a-z0-9_-]*)\s*:\s*[^\r\n]+/gi;
const AUTHORIZATION_ASSIGNMENT_RE = /\b(?:proxy[-_]?authorization|authorization)\s*=\s*(?:[a-z][a-z0-9._-]*\s+)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi;
const AUTH_SCHEME_CREDENTIAL_RE = /\b(?:authorization\s*:\s*)?(?:b\s*e\s*a\s*r\s*e\s*r|b\s*a\s*s\s*i\s*c)\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi;
const SECRET_TOKEN_RE = /\b(?:sk-[a-z0-9_-]{16,}|gh[opusr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,}|AKIA[0-9A-Z]{16}|eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,})\b/gi;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i;
const SECRET_LABELS = [
  'authorization code',
  'session token',
  'refresh token',
  'client secret',
  'private key',
  'access token',
  'authorization',
  'credential',
  'credentials',
  'api key',
  'password',
  'passwd',
  'bearer',
  'cookie',
  'secret',
  'token',
  'code',
] as const;

function obfuscatedLabelPattern(label: string): string {
  return label
    .split('')
    .map((character) => {
      if (/[a-z0-9]/i.test(character)) return `${character}\\s*`;
      return '[-_\\s]*';
    })
    .join('');
}

const OBFUSCATED_SECRET_ASSIGNMENT_RE = new RegExp(
  `\\b(?:[a-z0-9]+(?:[._-][a-z0-9]+)*[._-])*(?:${SECRET_LABELS.map(obfuscatedLabelPattern).join('|')})(?:[._-][a-z0-9]+)*["']?\\s*[:=]\\s*(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;}\\]]+)`,
  'gi',
);

/**
 * Normalize provider-exposed progress text for a compact, plain-text thinking
 * subject. Hidden/encrypted reasoning never enters this function.
 */
export function sanitizeThinkingSubject(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Delete invisible obfuscators before credential matching. A bidi mark in
  // `to\u202eken=...` must not split the protected label.
  let normalized = value
    .replace(BIDI_RE, '')
    .replace(NON_WHITESPACE_CONTROL_RE, '')
    .replace(WHITESPACE_CONTROL_RE, ' ')
    .replace(REPLY_TAG_RE, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Markup may occur in the middle of a credential label. Collapse it before
    // applying the security matchers rather than turning `to<b>ken` into two
    // harmless-looking words.
    .replace(/<[^>]+>/g, '')
    // Preserve underscores until after assignment redaction: they are both a
    // markdown marker and a real namespace separator in DATABASE_PASSWORD.
    .replace(/[`*~|]+/g, '');

  if (PRIVATE_KEY_RE.test(normalized)) return '';

  normalized = normalized
    .replace(URL_RE, '[redacted]')
    .replace(AUTHORIZATION_ASSIGNMENT_RE, '[redacted]')
    .replace(AUTH_SCHEME_CREDENTIAL_RE, '[redacted]')
    .replace(CREDENTIAL_HEADER_RE, '[redacted]')
    .replace(OBFUSCATED_SECRET_ASSIGNMENT_RE, '[redacted]')
    .replace(SECRET_TOKEN_RE, '[redacted]')
    .replace(/_+/g, ' ')
    .replace(/^[\s>*#\-\d.)]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return '';
  return normalized.slice(0, THINKING_SUBJECT_MAX_CHARS).trim();
}

export const __thinkingSubjectTest = {
  maxChars: THINKING_SUBJECT_MAX_CHARS,
};
