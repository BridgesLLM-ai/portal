import { config } from '../config/env';

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/$/, '').toLowerCase();
}

function getAllowedOrigins(): string[] {
  return (config.corsOrigin || [])
    .map((value) => normalizeOrigin(String(value)))
    .filter(Boolean);
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

export function isAllowedWebSocketOrigin(originHeader?: string | null, hostHeader?: string | null): boolean {
  if (!originHeader) return false;
  const origin = normalizeOrigin(originHeader);
  const allowedOrigins = getAllowedOrigins();
  if (allowedOrigins.includes(origin)) return true;

  if (!hostHeader) return false;
  try {
    const originUrl = new URL(origin);
    return normalizeHost(originUrl.host) === normalizeHost(hostHeader);
  } catch {
    return false;
  }
}
