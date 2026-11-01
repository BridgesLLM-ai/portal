import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config/env';

const DOMAIN = 'portal-response-context-v1';
const MAX_BYTES = 4 * 1024 * 1024;
const HEADER = /^\[Portal response context v1; authoredBytes=(\d{1,8}); proof=([a-f0-9]{64})\]\n/;
// OpenClaw echoes the user turn under the send idempotency key plus ":user".
const keyFor = (key: string) => key.replace(/:user$/, '');

function proof(key: string, bytes: number, content: string): string {
  return createHmac('sha256', config.jwtSecret).update(DOMAIN).update('\0').update(keyFor(key))
    .update('\0').update(String(bytes)).update('\0').update(content).digest('hex');
}

/**
 * Display-only attestation, never an authorization grant. OpenClaw stores the
 * complete model context (preference + authored text). Only the exact echo
 * correlated with this Portal request may project the authored suffix back;
 * quoted, forged, changed or replayed user text is shown as sent.
 */
export function signPortalResponseContext(authored: string, contextual: string, idempotencyKey: string): string {
  if (authored === contextual) return authored;
  if (!contextual.endsWith(authored) || !idempotencyKey.startsWith('portal-')) throw new Error('Invalid Portal response context');
  const bytes = Buffer.byteLength(authored, 'utf8');
  if (bytes < 1) throw new Error('Invalid Portal response context');
  if (Buffer.byteLength(contextual, 'utf8') > MAX_BYTES) throw new Error('Portal response context is too large');
  return `[Portal response context v1; authoredBytes=${bytes}; proof=${proof(idempotencyKey, bytes, contextual)}]\n${contextual}`;
}

export function projectPortalAuthoredText(text: string, idempotencyKey: unknown): string {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.startsWith('portal-') || Buffer.byteLength(text, 'utf8') > MAX_BYTES + 200) return text;
  const header = HEADER.exec(text);
  if (!header) return text;
  const content = text.slice(header[0].length);
  const bytes = Number(header[1]);
  const payload = Buffer.from(content, 'utf8');
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > payload.length) return text;
  const expected = Buffer.from(proof(idempotencyKey, bytes, content), 'hex');
  const supplied = Buffer.from(header[2], 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return text;
  const authored = payload.subarray(payload.length - bytes).toString('utf8');
  return Buffer.byteLength(authored, 'utf8') === bytes ? authored : text;
}

/** Verify before any display trimming/sanitization can change the signed bytes. */
export function projectPortalAuthoredContent(content: unknown, idempotencyKey: unknown): string | null {
  const raw = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n') : '';
  const projected = projectPortalAuthoredText(raw, idempotencyKey);
  return projected === raw ? null : projected;
}
