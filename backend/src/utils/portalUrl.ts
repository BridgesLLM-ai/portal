import type { Request } from 'express';

function firstNonEmptyCsvValue(raw?: string): string | null {
  if (!raw) return null;
  const first = raw.split(',').map((v) => v.trim()).find(Boolean);
  return first || null;
}

function parseUrlOrNull(value?: string | null): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function getPortalBaseUrl(req?: Request): string {
  const fromCors = parseUrlOrNull(firstNonEmptyCsvValue(process.env.CORS_ORIGIN));
  if (fromCors) return fromCors.origin;

  const fromPortalDomain = parseUrlOrNull(process.env.PORTAL_DOMAIN);
  if (fromPortalDomain) return fromPortalDomain.origin;

  if (req?.get('host')) {
    return `${req.protocol}://${req.get('host')}`;
  }

  return 'http://localhost:3001';
}

export function buildPortalUrl(pathname: string, req?: Request): string {
  const base = getPortalBaseUrl(req);
  return new URL(pathname, `${base}/`).toString();
}
