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

/** Plain-text, bounded title derived only from provider-exposed progress. */
export function sanitizeThinkingSubject(value: unknown): string {
  if (typeof value !== 'string') return '';

  // Strip invisible direction/control characters and presentation markup
  // before credential matching. Replacing those characters with spaces (or
  // redacting before markup removal) lets labels such as `to\u202eken` and
  // `pa**ss**word` evade the assignment matcher.
  let normalized = value
    .replace(BIDI_RE, '')
    .replace(NON_WHITESPACE_CONTROL_RE, '')
    .replace(WHITESPACE_CONTROL_RE, ' ')
    .replace(REPLY_TAG_RE, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
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

export type ActivityTitleUpdate =
  | { kind: 'ignore' }
  | { kind: 'set'; subject: string; runId: string }
  | { kind: 'clear' };

export function classifyActivityTitleEvent(input: {
  type: unknown;
  subject?: unknown;
  runId?: unknown;
  trackedRunId?: unknown;
}): ActivityTitleUpdate {
  const type = typeof input.type === 'string' ? input.type.trim() : '';
  const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
  const trackedRunId = typeof input.trackedRunId === 'string'
    ? input.trackedRunId.trim()
    : '';
  const subject = type === 'thinking'
    ? sanitizeThinkingSubject(input.subject)
    : '';

  if (subject) {
    // A verified run-resumed event clears the predecessor first. Any subject
    // that disagrees with the still-tracked run is therefore stale.
    if (runId && trackedRunId && runId !== trackedRunId) return { kind: 'ignore' };
    return { kind: 'set', subject, runId: runId || trackedRunId };
  }

  if (
    type === 'run_resumed'
    && runId
    && trackedRunId
    && runId !== trackedRunId
  ) {
    return { kind: 'clear' };
  }

  if (type !== 'done' && type !== 'error' && type !== 'stream_ended') {
    return { kind: 'ignore' };
  }
  if (runId && trackedRunId && runId !== trackedRunId) {
    return { kind: 'ignore' };
  }
  return { kind: 'clear' };
}

export const __thinkingSubjectTest = {
  maxChars: THINKING_SUBJECT_MAX_CHARS,
};
