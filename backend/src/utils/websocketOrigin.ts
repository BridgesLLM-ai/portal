import { config } from '../config/env';

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/$/, '').toLowerCase();
}

function getAllowedOrigins(): string[] {
  return (config.corsOrigin || [])
    .map((value) => normalizeOrigin(String(value)))
    .filter(Boolean);
}

export function isAllowedWebSocketOrigin(originHeader?: string | null): boolean {
  if (!originHeader) return false;
  const origin = normalizeOrigin(originHeader);
  const allowedOrigins = getAllowedOrigins();
  return allowedOrigins.includes(origin);
}
