export function resolveSafePortalRedirect(rawRedirect: string | null, origin: string): string | null {
  if (!rawRedirect || !rawRedirect.startsWith('/') || rawRedirect.startsWith('//')) return null;
  if (/\\|%5c|[\u0000-\u001f\u007f]/i.test(rawRedirect)) return null;

  try {
    const candidate = new URL(rawRedirect, origin);
    if (candidate.origin !== origin) return null;
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return null;
  }
}
