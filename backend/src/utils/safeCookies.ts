const MAX_COOKIE_HEADER_BYTES = 16 * 1024;
const MAX_COOKIE_PAIRS = 128;
const MAX_COOKIE_VALUE_CHARS = 4096;
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Parse cookies in raw WebSocket/upgrade handlers without allowing malformed
 * percent escapes to throw outside Express error handling.
 */
export function parseSafeCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null);
  if (!cookieHeader || Buffer.byteLength(cookieHeader, 'utf8') > MAX_COOKIE_HEADER_BYTES) return cookies;

  const pairs = cookieHeader.split(';', MAX_COOKIE_PAIRS + 1);
  if (pairs.length > MAX_COOKIE_PAIRS) return cookies;

  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const rawValue = pair.slice(idx + 1).trim();
    if (!COOKIE_NAME_RE.test(key) || rawValue.length > MAX_COOKIE_VALUE_CHARS) continue;
    try {
      const value = decodeURIComponent(rawValue);
      if (!/[\u0000-\u001f\u007f]/.test(value)) cookies[key] = value;
    } catch {
      // Ignore only the malformed pair; the upgrade handler remains alive.
    }
  }

  return cookies;
}
