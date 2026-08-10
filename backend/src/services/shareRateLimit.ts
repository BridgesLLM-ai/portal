import { prisma } from '../config/database';

const ALLOWED_RATE_LIMIT_WINDOWS = new Set([60, 300, 3600]);
const MAX_RATE_LIMIT_REQUESTS = 1_000_000;

export interface ShareRateLimitPolicy {
  id: string;
  isActive: boolean;
  expiresAt: Date | null;
  rateLimitMaxRequests: number | null;
  rateLimitWindowSeconds: number | null;
  rateLimitRequestCount: number;
  rateLimitWindowStartedAt: Date | null;
}

export type ShareRateLimitClaim =
  | { status: 'allowed' }
  | { status: 'limited'; retryAfterSeconds: number }
  | { status: 'unavailable'; reason: 'config_drift' | 'contention' | 'store_error' };

type ConfiguredRateState =
  | { kind: 'absent'; count: 0; startedAt: null }
  | { kind: 'expired'; count: number; startedAt: Date }
  | { kind: 'live'; count: number; startedAt: Date }
  | { kind: 'exhausted'; count: number; startedAt: Date; retryAfterSeconds: number }
  | { kind: 'invalid' };

type ClaimableRateState = Exclude<ConfiguredRateState, { kind: 'invalid' | 'exhausted' }>;

function validConfiguredPolicy(maxRequests: number | null, windowSeconds: number | null): boolean {
  return Number.isSafeInteger(maxRequests)
    && maxRequests! >= 1
    && maxRequests! <= MAX_RATE_LIMIT_REQUESTS
    && Number.isSafeInteger(windowSeconds)
    && ALLOWED_RATE_LIMIT_WINDOWS.has(windowSeconds!);
}

function validActiveSnapshot(
  link: Pick<ShareRateLimitPolicy, 'isActive' | 'expiresAt'>,
  nowMs: number,
): boolean {
  if (!link.isActive) return false;
  if (link.expiresAt === null) return true;
  return link.expiresAt instanceof Date
    && Number.isFinite(link.expiresAt.getTime())
    && link.expiresAt.getTime() > nowMs;
}

function sameExpiry(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left instanceof Date
    && right instanceof Date
    && Number.isFinite(left.getTime())
    && Number.isFinite(right.getTime())
    && left.getTime() === right.getTime();
}

function classifyConfiguredState(
  snapshot: Pick<ShareRateLimitPolicy, 'rateLimitRequestCount' | 'rateLimitWindowStartedAt'>,
  maxRequests: number,
  windowSeconds: number,
  nowMs: number,
): ConfiguredRateState {
  const count = snapshot.rateLimitRequestCount;
  if (!Number.isSafeInteger(count) || count < 0) return { kind: 'invalid' };

  const startedAt = snapshot.rateLimitWindowStartedAt;
  if (startedAt === null) {
    return count === 0
      ? { kind: 'absent', count: 0, startedAt: null }
      : { kind: 'invalid' };
  }
  if (!(startedAt instanceof Date)) return { kind: 'invalid' };

  const startedAtMs = startedAt.getTime();
  if (!Number.isFinite(startedAtMs) || startedAtMs > nowMs) return { kind: 'invalid' };

  // A non-null window is created at one and only ever increments to the exact
  // cap. Zero or over-cap therefore proves state drift, even after it expires.
  if (count === 0 || count > maxRequests) return { kind: 'invalid' };
  const resetAtMs = startedAtMs + windowSeconds * 1000;
  if (resetAtMs <= nowMs) return { kind: 'expired', count, startedAt };
  if (count === maxRequests) {
    return {
      kind: 'exhausted',
      count,
      startedAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
    };
  }
  return { kind: 'live', count, startedAt };
}

async function applyConditionalClaim(
  link: ShareRateLimitPolicy,
  state: ClaimableRateState,
  maxRequests: number,
  windowSeconds: number,
  now: Date,
): Promise<number> {
  const exactActivePolicy = {
    id: link.id,
    isActive: true,
    expiresAt: link.expiresAt,
    rateLimitMaxRequests: maxRequests,
    rateLimitWindowSeconds: windowSeconds,
  } as const;

  if (state.kind === 'live') {
    const result = await prisma.appShareLink.updateMany({
      where: {
        ...exactActivePolicy,
        rateLimitWindowStartedAt: state.startedAt,
        rateLimitRequestCount: { gte: 0, lt: maxRequests },
      },
      data: { rateLimitRequestCount: { increment: 1 } },
    });
    return result.count;
  }

  const result = await prisma.appShareLink.updateMany({
    where: {
      ...exactActivePolicy,
      rateLimitWindowStartedAt: state.startedAt,
      rateLimitRequestCount: state.count,
    },
    data: {
      rateLimitWindowStartedAt: now,
      rateLimitRequestCount: 1,
    },
  });
  return result.count;
}

/**
 * Claim one request from a share link's durable fixed window.
 *
 * The token lookup already returned an authoritative counter snapshot. Normal
 * traffic therefore needs one conditional write: increment a live window, or
 * reset an absent/expired one. A coherent exhausted snapshot needs no second
 * database query at all. Only a failed conditional write triggers one bounded
 * re-read and, when that row still has capacity, one bounded fallback write.
 */
export async function claimShareRateLimit(
  link: ShareRateLimitPolicy,
  nowMs = Date.now(),
): Promise<ShareRateLimitClaim> {
  const maxRequests = link.rateLimitMaxRequests;
  const windowSeconds = link.rateLimitWindowSeconds;

  // Null/null is the persisted backwards-compatible unlimited policy. Its
  // dormant counter fields are intentionally irrelevant.
  if (maxRequests === null && windowSeconds === null) return { status: 'allowed' };
  if (!Number.isFinite(nowMs)
    || !validConfiguredPolicy(maxRequests, windowSeconds)
    || !validActiveSnapshot(link, nowMs)) {
    return { status: 'unavailable', reason: 'config_drift' };
  }

  const configuredMax = maxRequests as number;
  const configuredWindow = windowSeconds as number;
  const initialState = classifyConfiguredState(link, configuredMax, configuredWindow, nowMs);
  if (initialState.kind === 'invalid') return { status: 'unavailable', reason: 'config_drift' };
  if (initialState.kind === 'exhausted') {
    return { status: 'limited', retryAfterSeconds: initialState.retryAfterSeconds };
  }

  const now = new Date(nowMs);
  try {
    const primaryCount = await applyConditionalClaim(
      link,
      initialState,
      configuredMax,
      configuredWindow,
      now,
    );
    if (primaryCount === 1) return { status: 'allowed' };
    if (primaryCount !== 0) return { status: 'unavailable', reason: 'contention' };

    const current = await prisma.appShareLink.findUnique({
      where: { id: link.id },
      select: {
        isActive: true,
        expiresAt: true,
        rateLimitMaxRequests: true,
        rateLimitWindowSeconds: true,
        rateLimitRequestCount: true,
        rateLimitWindowStartedAt: true,
      },
    });
    if (!current
      || !validActiveSnapshot(current, nowMs)
      || !sameExpiry(current.expiresAt, link.expiresAt)
      || current.rateLimitMaxRequests !== configuredMax
      || current.rateLimitWindowSeconds !== configuredWindow) {
      return { status: 'unavailable', reason: 'config_drift' };
    }

    const currentState = classifyConfiguredState(current, configuredMax, configuredWindow, nowMs);
    if (currentState.kind === 'invalid') return { status: 'unavailable', reason: 'config_drift' };
    if (currentState.kind === 'exhausted') {
      return { status: 'limited', retryAfterSeconds: currentState.retryAfterSeconds };
    }

    const fallbackLink: ShareRateLimitPolicy = {
      ...link,
      rateLimitRequestCount: current.rateLimitRequestCount,
      rateLimitWindowStartedAt: current.rateLimitWindowStartedAt,
    };
    const fallbackCount = await applyConditionalClaim(
      fallbackLink,
      currentState,
      configuredMax,
      configuredWindow,
      now,
    );
    return fallbackCount === 1
      ? { status: 'allowed' }
      : { status: 'unavailable', reason: 'contention' };
  } catch {
    return { status: 'unavailable', reason: 'store_error' };
  }
}

export const __shareRateLimitTest = {
  ALLOWED_RATE_LIMIT_WINDOWS,
  MAX_RATE_LIMIT_REQUESTS,
};
