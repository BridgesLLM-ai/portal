const SAFE_PORTAL_MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const SAFE_PORTAL_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const CLIENT_MARKER = ':client:';

export function normalizePortalClientMessageId(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return SAFE_PORTAL_MESSAGE_ID.test(normalized) ? normalized : undefined;
}

export function buildPortalOpenClawIdempotencyKey(
  serverRequestId: string,
  clientMessageId?: unknown,
): string {
  const requestId = String(serverRequestId || '').trim();
  if (!SAFE_PORTAL_REQUEST_ID.test(requestId)) {
    throw new Error('Invalid Portal request identity');
  }
  const clientId = normalizePortalClientMessageId(clientMessageId);
  return clientId
    ? `portal-${requestId}${CLIENT_MARKER}${clientId}`
    : `portal-${requestId}`;
}

export function portalClientMessageIdFromIdempotencyKey(value: unknown): string | undefined {
  let normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return undefined;
  if (normalized.endsWith(':user')) normalized = normalized.slice(0, -':user'.length);
  if (!normalized.startsWith('portal-')) return undefined;
  const markerIndex = normalized.indexOf(CLIENT_MARKER);
  if (markerIndex <= 'portal-'.length) return undefined;
  const requestId = normalized.slice('portal-'.length, markerIndex);
  if (!SAFE_PORTAL_REQUEST_ID.test(requestId)) return undefined;
  return normalizePortalClientMessageId(normalized.slice(markerIndex + CLIENT_MARKER.length));
}
