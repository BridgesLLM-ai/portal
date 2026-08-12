import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { canAccessPortal } from '../utils/authz';
import type { JwtPayload } from '../utils/jwt';
import {
  subscribeToAuthorizationChanges,
  type AuthorizationChangedEvent,
} from './authorizationChangeBus';
import {
  subscribeToSessionRevocations,
  type SessionRevocationEvent,
} from './sessionRevocationBus';
import { subscribeToGlobalWorkspaceAuthorizationFence } from './workspaceAuthorizationBarrier';

export interface AuthorizedAccessIdentity extends JwtPayload {
  /** Durable expiry used only by the server to retire long-lived transports. */
  sessionExpiresAt?: Date;
}

export type AccessPayloadAuthorizationResult =
  | { ok: true; identity: AuthorizedAccessIdentity }
  | {
    ok: false;
    reason: 'account_denied' | 'session_revoked' | 'authorization_changed';
  };

export interface AccessPayloadAuthorizationDatabase {
  user: {
    findUnique(args: unknown): Promise<any>;
  };
}

function durableSessionId(payload: JwtPayload): string | null {
  return typeof payload.sessionId === 'string' && payload.sessionId.trim().length > 0
    ? payload.sessionId.trim()
    : null;
}

/**
 * Authorize an already-verified access-token payload in exactly one user query.
 * Session-bound tokens fold their live Session row into that same query; legacy
 * tokens deliberately retain the pre-migration authorization-version contract.
 */
export async function authorizeAccessTokenPayload(
  payload: JwtPayload,
  options: {
    database?: AccessPayloadAuthorizationDatabase;
    now?: Date;
  } = {},
): Promise<AccessPayloadAuthorizationResult> {
  const database = options.database || prisma;
  const now = options.now || new Date();
  const sessionId = durableSessionId(payload);
  const user = await database.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      email: true,
      role: true,
      accountStatus: true,
      isActive: true,
      sandboxEnabled: true,
      authorizationVersion: true,
      ...(sessionId ? {
        sessions: {
          where: {
            id: sessionId,
            expiresAt: { gt: now },
          },
          select: { id: true, expiresAt: true },
          take: 1,
        },
      } : {}),
    },
  } as any);

  if (!user || !canAccessPortal((user as any).accountStatus, user.isActive)) {
    return { ok: false, reason: 'account_denied' };
  }

  const session = sessionId && Array.isArray((user as any).sessions)
    ? (user as any).sessions[0]
    : null;
  if (sessionId && (!session || session.id !== sessionId || !(session.expiresAt instanceof Date))) {
    return { ok: false, reason: 'session_revoked' };
  }

  const authorizationVersion = Number((user as any).authorizationVersion ?? 1);
  if ((payload.authorizationVersion ?? 1) !== authorizationVersion) {
    return { ok: false, reason: 'authorization_changed' };
  }

  return {
    ok: true,
    identity: {
      userId: user.id,
      ...(sessionId ? { sessionId, sessionExpiresAt: session.expiresAt as Date } : {}),
      email: user.email,
      role: user.role,
      accountStatus: (user as any).accountStatus,
      sandboxEnabled: !!user.sandboxEnabled,
      authorizationVersion,
      ...(Number.isFinite(payload.exp) ? { exp: Number(payload.exp) } : {}),
      ...(Number.isFinite(payload.iat) ? { iat: Number(payload.iat) } : {}),
    },
  };
}

export type LongLivedAccessRevocationReason =
  | 'session_revoked'
  | 'session_expired'
  | 'authorization_changed'
  | 'workspace_fenced';

export interface LongLivedAccessAuthorizationDependencies {
  database?: AccessPayloadAuthorizationDatabase;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  subscribeAuthorization?: typeof subscribeToAuthorizationChanges;
  subscribeSession?: typeof subscribeToSessionRevocations;
  subscribeGlobalFence?: typeof subscribeToGlobalWorkspaceAuthorizationFence;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

type LongLivedAccessFailureReason =
  | 'account_denied'
  | 'session_revoked'
  | 'authorization_changed'
  | 'workspace_fenced';

export type EstablishedLongLivedAccessResult =
  | { ok: true; identity: AuthorizedAccessIdentity; dispose(): void }
  | { ok: false; reason: LongLivedAccessFailureReason };

export type DurableAccessAuthorizationCommitResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: Exclude<LongLivedAccessFailureReason, 'workspace_fenced'> };

interface LockedAccessUserRow {
  id: string;
  email: string;
  role: string;
  accountStatus: string;
  isActive: boolean;
  sandboxEnabled: boolean;
  authorizationVersion: number;
  databaseNow: Date;
}

interface LockedAccessSessionRow {
  id: string;
  expiresAt: Date;
}

/**
 * Re-attest a durable access authority while holding PostgreSQL row locks
 * through one synchronous external commit. Exact Session deletion, refresh
 * rotation, credential changes, and User deletion must wait for these locks;
 * if any of them won first, the locked read fails closed before `commit` runs.
 *
 * This is intentionally a very narrow primitive. Callers must stage expensive
 * work before entering it and keep `commit` synchronous and bounded.
 */
export async function commitUnderDurableAccessAuthorization<T>(input: {
  payload: JwtPayload;
  authorize(identity: AuthorizedAccessIdentity): boolean;
  commit(): T;
  database?: Pick<typeof prisma, '$transaction'>;
}): Promise<DurableAccessAuthorizationCommitResult<T>> {
  const database = input.database || prisma;
  return database.$transaction(async (tx: any) => {
    const users = await tx.$queryRaw(Prisma.sql`
      SELECT
        "id",
        "email",
        "role"::text AS "role",
        "accountStatus"::text AS "accountStatus",
        "isActive",
        "sandboxEnabled",
        "authorizationVersion",
        clock_timestamp() AS "databaseNow"
      FROM "User"
      WHERE "id" = ${input.payload.userId}
      FOR SHARE
    `) as LockedAccessUserRow[];
    const user = users[0];
    if (!user || !canAccessPortal(user.accountStatus, user.isActive)) {
      return { ok: false, reason: 'account_denied' } as const;
    }
    if (Number(input.payload.authorizationVersion ?? 1) !== Number(user.authorizationVersion ?? 1)) {
      return { ok: false, reason: 'authorization_changed' } as const;
    }
    if (
      Number.isFinite(input.payload.exp)
      && Number(input.payload.exp) * 1000 <= user.databaseNow.getTime()
    ) {
      return { ok: false, reason: 'session_revoked' } as const;
    }

    const sessionId = durableSessionId(input.payload);
    let lockedSession: LockedAccessSessionRow | null = null;
    if (sessionId) {
      const sessions = await tx.$queryRaw(Prisma.sql`
        SELECT "id", "expiresAt"
        FROM "Session"
        WHERE
          "id" = ${sessionId}
          AND "userId" = ${input.payload.userId}
          AND "expiresAt" > clock_timestamp()
        FOR SHARE
      `) as LockedAccessSessionRow[];
      lockedSession = sessions[0] || null;
      if (!lockedSession) {
        return { ok: false, reason: 'session_revoked' } as const;
      }
    } else {
      // A legacy JWT has no exact Session identity and is retired by any exact
      // logout for the user. Lock every currently durable sibling so no such
      // delete can commit concurrently with the external mutation.
      await tx.$queryRaw(Prisma.sql`
        SELECT "id", "expiresAt"
        FROM "Session"
        WHERE "userId" = ${input.payload.userId}
        ORDER BY "id"
        FOR SHARE
      `) as LockedAccessSessionRow[];
    }

    const identity: AuthorizedAccessIdentity = {
      userId: user.id,
      ...(sessionId && lockedSession
        ? { sessionId, sessionExpiresAt: lockedSession.expiresAt }
        : {}),
      email: user.email,
      role: user.role,
      accountStatus: user.accountStatus,
      sandboxEnabled: !!user.sandboxEnabled,
      authorizationVersion: Number(user.authorizationVersion ?? 1),
      ...(Number.isFinite(input.payload.exp) ? { exp: Number(input.payload.exp) } : {}),
      ...(Number.isFinite(input.payload.iat) ? { iat: Number(input.payload.iat) } : {}),
    };
    if (!input.authorize(identity)) {
      return { ok: false, reason: 'account_denied' } as const;
    }

    return { ok: true, value: input.commit() } as const;
  }, {
    // The external commit is restricted to at most three same-filesystem
    // swaps (six forward renames, plus bounded rollback on failure). Keep an
    // explicit transaction budget so a future refactor cannot unknowingly
    // inherit Prisma's shorter implicit interactive timeout.
    maxWait: 5_000,
    timeout: 15_000,
  });
}

/**
 * Bind one long-lived transport to authorization generation, durable Session,
 * and Session expiry. Every subscription is installed before the database read,
 * closing the commit-to-subscribe gap for logout and credential recovery.
 */
export async function establishLongLivedAccessAuthorization(input: {
  payload: JwtPayload;
  authorize(identity: AuthorizedAccessIdentity): boolean;
  onRevoke(reason: LongLivedAccessRevocationReason): void;
  onAuthorizationChanged?: (event: AuthorizationChangedEvent) => void;
  subscribeGlobalFence?: boolean;
  dependencies?: LongLivedAccessAuthorizationDependencies;
}): Promise<EstablishedLongLivedAccessResult> {
  const dependencies = input.dependencies || {};
  const now = dependencies.now || (() => new Date());
  const setTimer = dependencies.setTimer || ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = dependencies.clearTimer || ((timer) => clearTimeout(timer));
  const subscribeAuthorization = dependencies.subscribeAuthorization || subscribeToAuthorizationChanges;
  const subscribeSession = dependencies.subscribeSession || subscribeToSessionRevocations;
  const subscribeGlobalFence = dependencies.subscribeGlobalFence || subscribeToGlobalWorkspaceAuthorizationFence;
  const sessionId = durableSessionId(input.payload);

  let revoked = false;
  let revocationFailureReason: LongLivedAccessFailureReason = 'session_revoked';
  let disposed = false;
  let expiryTimer: NodeJS.Timeout | null = null;
  let unsubscribeAuthorization = () => {};
  let unsubscribeSession = () => {};
  let unsubscribeGlobal = () => {};

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (expiryTimer) {
      clearTimer(expiryTimer);
      expiryTimer = null;
    }
    unsubscribeAuthorization();
    unsubscribeSession();
    unsubscribeGlobal();
  };

  const revoke = (
    reason: LongLivedAccessRevocationReason,
    notify: () => void = () => input.onRevoke(reason),
  ) => {
    if (revoked) return;
    revoked = true;
    revocationFailureReason = reason === 'workspace_fenced'
      ? 'workspace_fenced'
      : reason === 'authorization_changed'
        ? 'authorization_changed'
        : 'session_revoked';
    dispose();
    notify();
  };

  if (input.subscribeGlobalFence !== false) {
    const unsubscribe = subscribeGlobalFence(() => revoke('workspace_fenced'));
    unsubscribeGlobal = unsubscribe;
    if (disposed) unsubscribe();
  }
  if (revoked) return { ok: false, reason: revocationFailureReason };
  const unsubscribeAuthorizationSubscription = subscribeAuthorization(input.payload.userId, (event) => {
    revoke('authorization_changed', () => {
      if (input.onAuthorizationChanged) input.onAuthorizationChanged(event);
      else input.onRevoke('authorization_changed');
    });
  });
  unsubscribeAuthorization = unsubscribeAuthorizationSubscription;
  if (disposed) unsubscribeAuthorizationSubscription();
  if (revoked) return { ok: false, reason: revocationFailureReason };
  const unsubscribeSessionSubscription = subscribeSession(
    input.payload.userId,
    sessionId,
    (_event: SessionRevocationEvent) => revoke('session_revoked'),
  );
  unsubscribeSession = unsubscribeSessionSubscription;
  if (disposed) unsubscribeSessionSubscription();

  if (revoked) return { ok: false, reason: revocationFailureReason };

  let authorized: AccessPayloadAuthorizationResult;
  try {
    authorized = await authorizeAccessTokenPayload(input.payload, {
      database: dependencies.database,
      now: now(),
    });
  } catch (error) {
    dispose();
    throw error;
  }
  if (revoked) return { ok: false, reason: revocationFailureReason };
  if (!authorized.ok) {
    dispose();
    return authorized;
  }
  if (!input.authorize(authorized.identity)) {
    dispose();
    return { ok: false, reason: 'account_denied' };
  }

  const jwtExpiresAtMs = Number.isFinite(input.payload.exp)
    ? Number(input.payload.exp) * 1000
    : null;
  const sessionExpiresAtMs = authorized.identity.sessionExpiresAt?.getTime() ?? null;
  const authorityExpiresAtMs = jwtExpiresAtMs === null
    ? sessionExpiresAtMs
    : sessionExpiresAtMs === null
      ? jwtExpiresAtMs
      : Math.min(jwtExpiresAtMs, sessionExpiresAtMs);
  const expiresAt = authorityExpiresAtMs === null ? null : new Date(authorityExpiresAtMs);
  if (expiresAt) {
    const scheduleExpiryCheck = (): boolean => {
      const remainingMs = expiresAt.getTime() - now().getTime();
      if (remainingMs <= 0) {
        revoke('session_expired');
        return false;
      }
      expiryTimer = setTimer(() => {
        expiryTimer = null;
        scheduleExpiryCheck();
      }, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
      expiryTimer.unref?.();
      return true;
    };
    if (!scheduleExpiryCheck()) return { ok: false, reason: 'session_revoked' };
  }

  if (revoked) return { ok: false, reason: revocationFailureReason };
  return { ok: true, identity: authorized.identity, dispose };
}
