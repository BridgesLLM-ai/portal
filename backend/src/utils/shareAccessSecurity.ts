import crypto from 'crypto';

const SHARE_PASSWORD_GRANT_TTL_MS = 60 * 60 * 1000;
const SHARE_VISIT_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COMBINED_ATTEMPT_LIMIT = 5;
const COMBINED_WINDOW_MS = 60 * 1000;
const TOKEN_ATTEMPT_LIMIT = 25;
const TOKEN_WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPT_BUCKETS = 10_000;

export type ShareGrantKind = 'password' | 'visit';

interface ShareGrantPayload {
  v: 1;
  kind: ShareGrantKind;
  token: string;
  linkId: string;
  binding?: string;
  expiresAt: number;
}

interface AttemptBucket {
  count: number;
  resetAt: number;
  touchedAt: number;
}

export interface ShareLinkOptions {
  expiresAt: Date | null;
  maxUses: number | null;
  rateLimitMaxRequests: number | null;
  rateLimitWindowSeconds: number | null;
}

export type ShareLinkAvailability = 'active' | 'disabled' | 'expired' | 'exhausted';

/**
 * A share link has exactly one coherent credential mode. Treat every other
 * persisted shape as unavailable: a public link must not retain a credential,
 * while a private link must always have a usable (non-empty) password hash.
 */
export function shareCredentialStateIsValid(
  link: { isPublic: boolean; passwordHash?: string | null },
): boolean {
  return link.isPublic
    ? link.passwordHash === null
    : typeof link.passwordHash === 'string' && link.passwordHash.length > 0;
}

export function shareLinkAvailability(
  link: { isActive: boolean; expiresAt?: Date | string | null; maxUses?: number | null; currentUses?: number },
  now = Date.now(),
): ShareLinkAvailability {
  if (!link.isActive) return 'disabled';
  if (link.expiresAt) {
    const expiresAt = link.expiresAt instanceof Date ? link.expiresAt.getTime() : new Date(link.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return 'expired';
  }
  if (link.maxUses !== null && link.maxUses !== undefined && (link.currentUses || 0) >= link.maxUses) {
    return 'exhausted';
  }
  return 'active';
}

export function isValidShareToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(token);
}

export function parseShareLinkOptions(
  input: {
    expiresAt?: unknown;
    maxUses?: unknown;
    rateLimitMaxRequests?: unknown;
    rateLimitWindowSeconds?: unknown;
  },
  now = Date.now(),
): ShareLinkOptions {
  let expiresAt: Date | null = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== '') {
    const parsed = new Date(String(input.expiresAt));
    if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= now) {
      throw new Error('Expiration must be a valid future date');
    }
    expiresAt = parsed;
  }

  let maxUses: number | null = null;
  if (input.maxUses !== undefined && input.maxUses !== null && input.maxUses !== '') {
    const parsed = typeof input.maxUses === 'number' ? input.maxUses : Number(input.maxUses);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000_000) {
      throw new Error('Max uses must be a whole number between 1 and 1000000');
    }
    maxUses = parsed;
  }

  const hasRateLimitMaxRequests = input.rateLimitMaxRequests !== undefined
    && input.rateLimitMaxRequests !== null
    && input.rateLimitMaxRequests !== '';
  const hasRateLimitWindowSeconds = input.rateLimitWindowSeconds !== undefined
    && input.rateLimitWindowSeconds !== null
    && input.rateLimitWindowSeconds !== '';

  if (!hasRateLimitMaxRequests && hasRateLimitWindowSeconds) {
    throw new Error('Rate limit request count is required when a rate limit window is set');
  }

  let rateLimitMaxRequests: number | null = null;
  let rateLimitWindowSeconds: number | null = null;
  if (hasRateLimitMaxRequests) {
    const parsedMax = typeof input.rateLimitMaxRequests === 'number'
      ? input.rateLimitMaxRequests
      : Number(input.rateLimitMaxRequests);
    if (!Number.isSafeInteger(parsedMax) || parsedMax < 1 || parsedMax > 1_000_000) {
      throw new Error('Rate limit requests must be a whole number between 1 and 1000000');
    }

    const parsedWindow = hasRateLimitWindowSeconds
      ? (typeof input.rateLimitWindowSeconds === 'number'
        ? input.rateLimitWindowSeconds
        : Number(input.rateLimitWindowSeconds))
      : 60;
    if (!Number.isSafeInteger(parsedWindow) || ![60, 300, 3600].includes(parsedWindow)) {
      throw new Error('Rate limit window must be 60, 300, or 3600 seconds');
    }

    rateLimitMaxRequests = parsedMax;
    rateLimitWindowSeconds = parsedWindow;
  }

  return { expiresAt, maxUses, rateLimitMaxRequests, rateLimitWindowSeconds };
}

export function validateSharePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Password must be at least 8 characters and at most 72 UTF-8 bytes');
  }
  return password;
}

function signPayload(encoded: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
}

export function issueShareGrant(
  payload: Omit<ShareGrantPayload, 'v'>,
  secret: string,
  now = Date.now(),
): string {
  const maxTtlMs = shareGrantTtlMs(payload.kind);
  if (!isValidShareToken(payload.token)
    || !payload.linkId
    || payload.expiresAt <= now
    || payload.expiresAt - now > maxTtlMs) {
    throw new Error('Invalid share access grant');
  }
  const encoded = Buffer.from(JSON.stringify({ v: 1, ...payload } satisfies ShareGrantPayload)).toString('base64url');
  return `${encoded}.${signPayload(encoded, secret)}`;
}

export function verifyShareGrant(
  grant: unknown,
  expected: { kind: ShareGrantKind; token: string; linkId: string; binding?: string },
  secret: string,
  now = Date.now(),
): boolean {
  try {
    if (typeof grant !== 'string' || grant.length > 2048) return false;
    const [encoded, signature, extra] = grant.split('.');
    if (!encoded || !signature || extra) return false;
    const supplied = Buffer.from(signature, 'base64url');
    const wanted = Buffer.from(signPayload(encoded, secret), 'base64url');
    if (supplied.length !== wanted.length || !crypto.timingSafeEqual(supplied, wanted)) return false;

    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ShareGrantPayload;
    const maxTtlMs = shareGrantTtlMs(parsed.kind);
    return parsed.v === 1
      && parsed.kind === expected.kind
      && parsed.token === expected.token
      && parsed.linkId === expected.linkId
      && parsed.binding === expected.binding
      && Number.isFinite(parsed.expiresAt)
      && parsed.expiresAt > now
      && parsed.expiresAt - now <= maxTtlMs;
  } catch {
    return false;
  }
}

export function shareGrantTtlMs(kind: ShareGrantKind): number {
  return kind === 'visit' ? SHARE_VISIT_GRANT_TTL_MS : SHARE_PASSWORD_GRANT_TTL_MS;
}

export function sharePasswordBinding(passwordHash: string): string {
  return crypto.createHash('sha256').update(passwordHash).digest('base64url');
}

export function shareGrantCookieName(kind: ShareGrantKind, token: string): string {
  const digest = crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
  return `share_${kind}_${digest}`;
}

export class SharePasswordAttemptLimiter {
  private readonly buckets = new Map<string, AttemptBucket>();
  private lastPruneAt = 0;

  private prune(now: number): void {
    if (now - this.lastPruneAt < 30_000 && this.buckets.size < MAX_ATTEMPT_BUCKETS) return;
    this.lastPruneAt = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  private store(key: string, bucket: AttemptBucket): void {
    // Refresh insertion order for an O(1) bounded LRU eviction path.
    this.buckets.delete(key);
    while (this.buckets.size >= MAX_ATTEMPT_BUCKETS) {
      const oldestKey = this.buckets.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.buckets.delete(oldestKey);
    }
    this.buckets.set(key, bucket);
  }

  private reserve(key: string, limit: number, windowMs: number, now: number): { allowed: boolean; retryAfter: number } {
    const existing = this.buckets.get(key);
    const bucket = !existing || existing.resetAt <= now
      ? { count: 0, resetAt: now + windowMs, touchedAt: now }
      : existing;
    bucket.touchedAt = now;
    if (bucket.count >= limit) {
      this.store(key, bucket);
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    bucket.count += 1;
    this.store(key, bucket);
    return { allowed: true, retryAfter: 0 };
  }

  begin(ip: string, token: string, now = Date.now()): { allowed: boolean; retryAfter?: number } {
    this.prune(now);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
    const tokenResult = this.reserve(`token:${tokenHash}`, TOKEN_ATTEMPT_LIMIT, TOKEN_WINDOW_MS, now);
    if (!tokenResult.allowed) return { allowed: false, retryAfter: tokenResult.retryAfter };
    const combinedResult = this.reserve(`pair:${tokenHash}:${ipHash}`, COMBINED_ATTEMPT_LIMIT, COMBINED_WINDOW_MS, now);
    if (!combinedResult.allowed) return { allowed: false, retryAfter: combinedResult.retryAfter };
    return { allowed: true };
  }

  success(ip: string, token: string): void {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
    this.buckets.delete(`pair:${tokenHash}:${ipHash}`);
    const tokenBucket = this.buckets.get(`token:${tokenHash}`);
    if (tokenBucket) {
      tokenBucket.count = Math.max(0, tokenBucket.count - 1);
      tokenBucket.touchedAt = Date.now();
      this.store(`token:${tokenHash}`, tokenBucket);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

export const __shareAccessSecurityTest = {
  SHARE_PASSWORD_GRANT_TTL_MS,
  SHARE_VISIT_GRANT_TTL_MS,
  COMBINED_ATTEMPT_LIMIT,
  TOKEN_ATTEMPT_LIMIT,
  MAX_ATTEMPT_BUCKETS,
};
