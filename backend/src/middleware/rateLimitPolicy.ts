import type { Express } from 'express';
import rateLimit from 'express-rate-limit';

export const GLOBAL_API_RATE_LIMIT = {
  windowMs: 60 * 1000,
  max: 600,
} as const;

type GlobalApiRateLimitOptions = {
  windowMs?: number;
  max?: number;
};

/**
 * Mount the broad API abuse guard.
 *
 * Authentication attempts have their own stricter, endpoint-specific limits
 * in routes/auth.ts. A strict limiter must not be mounted on `/api/auth/*` as
 * a whole because that namespace also contains normal session reads such as
 * `/auth/me`, plus refresh, logout, profile, and 2FA status operations.
 */
export function mountGlobalApiRateLimit(
  app: Express,
  options: GlobalApiRateLimitOptions = {},
): void {
  const limiter = rateLimit({
    windowMs: options.windowMs ?? GLOBAL_API_RATE_LIMIT.windowMs,
    max: options.max ?? GLOBAL_API_RATE_LIMIT.max,
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use('/api/', limiter);
}
