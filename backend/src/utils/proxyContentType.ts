/**
 * Response types that must never pass through Response.text().
 *
 * Share-app API responses preserve the upstream Content-Type. Treating these
 * bodies as UTF-8 would silently replace arbitrary bytes and return corrupt
 * files with an otherwise successful HTTP status.
 */
export function isBinaryProxyContentType(contentType: string | null | undefined): boolean {
  const normalized = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  return normalized.startsWith('image/')
    || normalized === 'application/pdf'
    || normalized === 'application/octet-stream';
}
