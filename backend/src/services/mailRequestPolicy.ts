export const MAX_MAIL_LIST_POSITION = 10_000_000;
export const MAX_MAIL_LIST_LIMIT = 100;
export const MAX_MAIL_SIGNATURE_CHARS = 100_000;
export const MAX_MAIL_SEARCH_CHARS = 500;

export interface MailListRequest {
  position: number;
  limit: number;
  sort: 'date-asc' | 'date-desc';
}

function parseBoundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = Array.isArray(value) ? value[0] : value;
  if (typeof normalized !== 'string' || !/^\d+$/.test(normalized)) {
    throw new Error('Mail pagination values must be non-negative integers');
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('Mail pagination value is outside the supported range');
  }
  return parsed;
}

export function normalizeMailListRequest(query: Record<string, unknown>): MailListRequest {
  return {
    position: parseBoundedInteger(query.position, 0, 0, MAX_MAIL_LIST_POSITION),
    limit: parseBoundedInteger(query.limit, 50, 1, MAX_MAIL_LIST_LIMIT),
    sort: query.sort === 'date-asc' ? 'date-asc' : 'date-desc',
  };
}

export function normalizeMailSearchQuery(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('Mail search query must be text');
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > MAX_MAIL_SEARCH_CHARS) {
    throw new Error(`Mail search query exceeds ${MAX_MAIL_SEARCH_CHARS} characters`);
  }
  return normalized;
}

export function validateMailSignaturePayload(signature: unknown, signatureHtml: unknown): string | null {
  if (signature !== undefined && signature !== null && typeof signature !== 'string') {
    return 'Signature must be text';
  }
  if (signatureHtml !== undefined && signatureHtml !== null && typeof signatureHtml !== 'string') {
    return 'HTML signature must be text';
  }
  if (typeof signature === 'string' && signature.length > MAX_MAIL_SIGNATURE_CHARS) {
    return `Signature exceeds the ${MAX_MAIL_SIGNATURE_CHARS}-character limit`;
  }
  if (typeof signatureHtml === 'string' && signatureHtml.length > MAX_MAIL_SIGNATURE_CHARS) {
    return `HTML signature exceeds the ${MAX_MAIL_SIGNATURE_CHARS}-character limit`;
  }
  return null;
}
