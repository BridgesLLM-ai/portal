import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';

const MAX_CONCURRENT_VISITORS = 10_000;
const MAX_REQUESTS_PER_VISITOR = 32;
const LEASE_TTL_MS = 5 * 60 * 1000;
const LEASE_RENEWAL_INTERVAL_MS = 60 * 1000;
const HASH_RE = /^[0-9a-f]{64}$/;
const LEASE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

interface LockedShareRow {
  id: string;
  isActive: boolean;
  expiresAt: Date | null;
  maxConcurrentVisitors: number | null;
  userId: string;
  appIsActive: boolean;
  appUserId: string;
}

interface ActiveLeaseAggregate {
  activeVisitors: number;
  visitorRequests: number;
  nextExpiry: Date | null;
}

export type ShareConcurrentUseClaim =
  | { status: 'unlimited' }
  | { status: 'acquired'; leaseToken: string; leaseExpiresAt: Date }
  | { status: 'limited'; retryAfterSeconds: number }
  | { status: 'unavailable'; reason: 'config_drift' | 'contention' | 'store_error' };

export type ShareConcurrentUseRelease =
  | { status: 'released' | 'already_released' }
  | { status: 'unavailable'; reason: 'invalid_lease' | 'store_error' };

export type ShareConcurrentUseRenewal =
  | { status: 'renewed'; leaseExpiresAt: Date }
  | { status: 'unlimited' }
  | { status: 'lost'; reason: 'inactive_share' | 'missing_lease' }
  | { status: 'unavailable'; reason: 'invalid_lease' | 'contention' | 'store_error' };

function validNow(nowMs: number): boolean {
  return Number.isFinite(nowMs) && nowMs >= 0;
}

function validLockedShare(row: LockedShareRow, nowMs: number): boolean {
  return typeof row.id === 'string'
    && row.id.length > 0
    && row.isActive === true
    && row.appIsActive === true
    && row.userId === row.appUserId
    && (row.expiresAt === null
      || (row.expiresAt instanceof Date
        && Number.isFinite(row.expiresAt.getTime())
        && row.expiresAt.getTime() > nowMs))
    && (row.maxConcurrentVisitors === null
      || (Number.isSafeInteger(row.maxConcurrentVisitors)
        && row.maxConcurrentVisitors >= 1
        && row.maxConcurrentVisitors <= MAX_CONCURRENT_VISITORS));
}

function validAggregate(value: ActiveLeaseAggregate): boolean {
  return Number.isSafeInteger(value.activeVisitors)
    && value.activeVisitors >= 0
    && Number.isSafeInteger(value.visitorRequests)
    && value.visitorRequests >= 0
    && (value.nextExpiry === null
      || (value.nextExpiry instanceof Date && Number.isFinite(value.nextExpiry.getTime())));
}

function retryAfterSeconds(nextExpiry: Date | null, nowMs: number): number {
  if (!(nextExpiry instanceof Date) || !Number.isFinite(nextExpiry.getTime())) return 1;
  return Math.max(1, Math.ceil((nextExpiry.getTime() - nowMs) / 1000));
}

function leaseTokenHash(leaseToken: string): string {
  return crypto.createHash('sha256').update(leaseToken).digest('hex');
}

/**
 * Atomically acquire one in-flight request lease for a public share visitor.
 *
 * Every contender locks the same AppShareLink row before it reclaims expired
 * rows, counts distinct signed visitor identities, and inserts. That row lock
 * is the authority across Node processes and Portal workers; no in-memory
 * counter participates in admission. A caller may retry an ambiguous acquire
 * with the same leaseToken and receives the already-owned row idempotently.
 */
export async function claimShareConcurrentUse(
  input: { shareLinkId: string; visitorIdHash: string; leaseToken?: string },
  nowMs = Date.now(),
): Promise<ShareConcurrentUseClaim> {
  const leaseToken = input.leaseToken || crypto.randomBytes(32).toString('base64url');
  if (typeof input.shareLinkId !== 'string'
    || input.shareLinkId.length < 1
    || input.shareLinkId.length > 255
    || !HASH_RE.test(input.visitorIdHash)
    || !LEASE_TOKEN_RE.test(leaseToken)
    || !validNow(nowMs)) {
    return { status: 'unavailable', reason: 'config_drift' };
  }

  const tokenHash = leaseTokenHash(leaseToken);
  const now = new Date(nowMs);
  const leaseExpiresAt = new Date(nowMs + LEASE_TTL_MS);

  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<LockedShareRow[]>(Prisma.sql`
        SELECT
          share_link."id",
          share_link."isActive",
          share_link."expiresAt",
          share_link."maxConcurrentVisitors",
          share_link."userId",
          app."isActive" AS "appIsActive",
          app."userId" AS "appUserId"
        FROM "AppShareLink" AS share_link
        INNER JOIN "App" AS app ON app."id" = share_link."appId"
        WHERE share_link."id" = ${input.shareLinkId}
        FOR UPDATE OF share_link
      `);
      if (locked.length !== 1 || !validLockedShare(locked[0], nowMs)) {
        return { status: 'unavailable', reason: 'config_drift' } as const;
      }

      // Crash recovery and normal cleanup share the same serialization point.
      // An old worker can never delete a live row because expiry is DB data.
      await tx.appShareRequestLease.deleteMany({
        where: {
          shareLinkId: input.shareLinkId,
          leaseExpiresAt: { lte: now },
        },
      });

      const configuredLimit = locked[0].maxConcurrentVisitors;
      if (configuredLimit === null) {
        // Policy was cleared while old requests were active. They no longer
        // carry authority and can be removed immediately.
        await tx.appShareRequestLease.deleteMany({ where: { shareLinkId: input.shareLinkId } });
        return { status: 'unlimited' } as const;
      }

      const duplicate = await tx.appShareRequestLease.findUnique({
        where: { leaseTokenHash: tokenHash },
        select: {
          shareLinkId: true,
          visitorIdHash: true,
          leaseExpiresAt: true,
        },
      });
      if (duplicate) {
        if (duplicate.shareLinkId !== input.shareLinkId
          || duplicate.visitorIdHash !== input.visitorIdHash
          || duplicate.leaseExpiresAt.getTime() <= nowMs) {
          return { status: 'unavailable', reason: 'config_drift' } as const;
        }
        return {
          status: 'acquired',
          leaseToken,
          leaseExpiresAt: duplicate.leaseExpiresAt,
        } as const;
      }

      const aggregates = await tx.$queryRaw<ActiveLeaseAggregate[]>(Prisma.sql`
        SELECT
          COUNT(DISTINCT "visitorIdHash")::INTEGER AS "activeVisitors",
          COUNT(*) FILTER (
            WHERE "visitorIdHash" = ${input.visitorIdHash}
          )::INTEGER AS "visitorRequests",
          MIN("leaseExpiresAt") AS "nextExpiry"
        FROM "AppShareRequestLease"
        WHERE "shareLinkId" = ${input.shareLinkId}
          AND "leaseExpiresAt" > ${now}
      `);
      if (aggregates.length !== 1 || !validAggregate(aggregates[0])) {
        return { status: 'unavailable', reason: 'config_drift' } as const;
      }

      const aggregate = aggregates[0];
      if (aggregate.visitorRequests >= MAX_REQUESTS_PER_VISITOR) {
        return {
          status: 'limited',
          retryAfterSeconds: retryAfterSeconds(aggregate.nextExpiry, nowMs),
        } as const;
      }
      if (aggregate.visitorRequests === 0 && aggregate.activeVisitors >= configuredLimit) {
        return {
          status: 'limited',
          retryAfterSeconds: retryAfterSeconds(aggregate.nextExpiry, nowMs),
        } as const;
      }

      await tx.appShareRequestLease.create({
        data: {
          leaseTokenHash: tokenHash,
          shareLinkId: input.shareLinkId,
          visitorIdHash: input.visitorIdHash,
          leaseExpiresAt,
          createdAt: now,
        },
      });
      return { status: 'acquired', leaseToken, leaseExpiresAt } as const;
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 10_000,
    });
  } catch (error: any) {
    if (error?.code === 'P2002' || error?.code === 'P2034') {
      return { status: 'unavailable', reason: 'contention' };
    }
    return { status: 'unavailable', reason: 'store_error' };
  }
}

/**
 * Extend one exact in-flight request lease. Renewal uses the same share-row lock
 * as admission so policy changes, expiry, and concurrent claims have one durable
 * authority across Portal workers. `createdAt` is advanced with the expiry to
 * preserve the database's bounded-expiry invariant after any number of renewals.
 */
export async function renewShareConcurrentUse(
  input: { shareLinkId: string; visitorIdHash: string; leaseToken: string },
  nowMs = Date.now(),
): Promise<ShareConcurrentUseRenewal> {
  if (typeof input.shareLinkId !== 'string'
    || input.shareLinkId.length < 1
    || input.shareLinkId.length > 255
    || !HASH_RE.test(input.visitorIdHash)
    || !LEASE_TOKEN_RE.test(input.leaseToken)
    || !validNow(nowMs)) {
    return { status: 'unavailable', reason: 'invalid_lease' };
  }

  const tokenHash = leaseTokenHash(input.leaseToken);
  const now = new Date(nowMs);
  const leaseExpiresAt = new Date(nowMs + LEASE_TTL_MS);

  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<LockedShareRow[]>(Prisma.sql`
        SELECT
          share_link."id",
          share_link."isActive",
          share_link."expiresAt",
          share_link."maxConcurrentVisitors",
          share_link."userId",
          app."isActive" AS "appIsActive",
          app."userId" AS "appUserId"
        FROM "AppShareLink" AS share_link
        INNER JOIN "App" AS app ON app."id" = share_link."appId"
        WHERE share_link."id" = ${input.shareLinkId}
        FOR UPDATE OF share_link
      `);

      if (locked.length !== 1 || !validLockedShare(locked[0], nowMs)) {
        await tx.appShareRequestLease.deleteMany({
          where: {
            leaseTokenHash: tokenHash,
            shareLinkId: input.shareLinkId,
            visitorIdHash: input.visitorIdHash,
          },
        });
        return { status: 'lost', reason: 'inactive_share' } as const;
      }

      if (locked[0].maxConcurrentVisitors === null) {
        await tx.appShareRequestLease.deleteMany({
          where: {
            leaseTokenHash: tokenHash,
            shareLinkId: input.shareLinkId,
            visitorIdHash: input.visitorIdHash,
          },
        });
        return { status: 'unlimited' } as const;
      }

      const updated = await tx.appShareRequestLease.updateMany({
        where: {
          leaseTokenHash: tokenHash,
          shareLinkId: input.shareLinkId,
          visitorIdHash: input.visitorIdHash,
          leaseExpiresAt: { gt: now },
        },
        data: {
          createdAt: now,
          leaseExpiresAt,
        },
      });
      if (updated.count === 1) return { status: 'renewed', leaseExpiresAt } as const;
      if (updated.count === 0) return { status: 'lost', reason: 'missing_lease' } as const;
      return { status: 'unavailable', reason: 'store_error' } as const;
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 10_000,
    });
  } catch (error: any) {
    if (error?.code === 'P2034') return { status: 'unavailable', reason: 'contention' };
    return { status: 'unavailable', reason: 'store_error' };
  }
}

/**
 * Maintain one lease while its response is open. Renewal calls are serialized;
 * any unverifiable or lost authority stops the heartbeat and invokes the
 * caller's fail-closed transport action. Clearing the policy to unlimited is a
 * normal terminal state and does not interrupt the response.
 */
export function startShareConcurrentUseHeartbeat(
  input: { shareLinkId: string; visitorIdHash: string; leaseToken: string },
  onAuthorityLost: (result: Exclude<ShareConcurrentUseRenewal, { status: 'renewed' | 'unlimited' }>) => void,
  options: {
    intervalMs?: number;
    renew?: typeof renewShareConcurrentUse;
  } = {},
): { stop: () => void; renewNow: () => Promise<void> } {
  const intervalMs = options.intervalMs ?? LEASE_RENEWAL_INTERVAL_MS;
  const renew = options.renew ?? renewShareConcurrentUse;
  let stopped = false;
  let renewing = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  const renewNow = async () => {
    if (stopped || renewing) return;
    renewing = true;
    try {
      const result = await renew(input);
      if (stopped) return;
      if (result.status === 'renewed') return;
      stop();
      if (result.status !== 'unlimited') onAuthorityLost(result);
    } finally {
      renewing = false;
    }
  };

  const timer = setInterval(() => { void renewNow(); }, intervalMs);
  timer.unref?.();
  return { stop, renewNow };
}

/** Release only the exact request lease owned by this link and visitor. */
export async function releaseShareConcurrentUse(input: {
  shareLinkId: string;
  visitorIdHash: string;
  leaseToken: string;
}): Promise<ShareConcurrentUseRelease> {
  if (typeof input.shareLinkId !== 'string'
    || input.shareLinkId.length < 1
    || input.shareLinkId.length > 255
    || !HASH_RE.test(input.visitorIdHash)
    || !LEASE_TOKEN_RE.test(input.leaseToken)) {
    return { status: 'unavailable', reason: 'invalid_lease' };
  }
  try {
    const deleted = await prisma.appShareRequestLease.deleteMany({
      where: {
        leaseTokenHash: leaseTokenHash(input.leaseToken),
        shareLinkId: input.shareLinkId,
        visitorIdHash: input.visitorIdHash,
      },
    });
    if (deleted.count === 1) return { status: 'released' };
    if (deleted.count === 0) return { status: 'already_released' };
    return { status: 'unavailable', reason: 'store_error' };
  } catch {
    return { status: 'unavailable', reason: 'store_error' };
  }
}

export const __shareConcurrentUseTest = {
  MAX_CONCURRENT_VISITORS,
  MAX_REQUESTS_PER_VISITOR,
  LEASE_TTL_MS,
  LEASE_RENEWAL_INTERVAL_MS,
};
