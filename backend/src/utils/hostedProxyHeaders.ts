import type { IncomingHttpHeaders } from 'node:http';

// Strip Portal credentials before the transport snapshots request headers.
// A proxyReq callback is too late (and is skipped for Expect: 100-continue).
export function stripHostedPortalCookies(headers: IncomingHttpHeaders, hostedCookieName: string): void {
  const portalCookieNames = new Set([hostedCookieName, 'accessToken', 'refreshToken']);
  const filteredCookie = String(headers.cookie || '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => {
      if (!value) return false;
      const separator = value.indexOf('=');
      const name = separator >= 0 ? value.slice(0, separator).trim() : value;
      return !portalCookieNames.has(name) && !name.startsWith('share_password_') && !name.startsWith('share_visit_');
    })
    .join('; ');
  if (filteredCookie) headers.cookie = filteredCookie;
  else delete headers.cookie;
}
