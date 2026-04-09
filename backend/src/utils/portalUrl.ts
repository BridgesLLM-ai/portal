import type { Request } from 'express';

function csvValues(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(',').map((v) => v.trim()).filter(Boolean);
}

function firstNonEmptyCsvValue(raw?: string): string | null {
  return csvValues(raw)[0] || null;
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
  const requestOrigin = req?.get('host') ? `${req.protocol}://${req.get('host')}` : null;
  const allowedCorsOrigins = csvValues(process.env.CORS_ORIGIN)
    .map((value) => parseUrlOrNull(value)?.origin || null)
    .filter((value): value is string => Boolean(value));

  if (requestOrigin && allowedCorsOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  const fromCors = parseUrlOrNull(firstNonEmptyCsvValue(process.env.CORS_ORIGIN));
  if (fromCors) return fromCors.origin;

  const fromPortalDomain = parseUrlOrNull(process.env.PORTAL_DOMAIN);
  if (fromPortalDomain) return fromPortalDomain.origin;

  if (requestOrigin) {
    return requestOrigin;
  }

  return 'http://localhost:3001';
}

export function buildPortalUrl(pathname: string, req?: Request): string {
  const base = getPortalBaseUrl(req);
  return new URL(pathname, `${base}/`).toString();
}
