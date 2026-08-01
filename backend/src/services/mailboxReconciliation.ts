import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { decryptSecret } from '../utils/authSecrets';
import { readBoundedResponseBody, ResponseTooLargeError } from '../utils/boundedHttp';
import { isReservedSystemMailboxUsername, normalizeMailboxUsername } from '../utils/reservedMailboxUsernames';
import {
  assertPortalFeatureAvailable,
  getPortalFeatureCapabilities,
} from '../utils/portalFeatureCapabilities';

const STALWART_ADMIN_USER = 'admin';
const STALWART_REQUEST_TIMEOUT_MS = 10_000;
const MAX_STALWART_RESPONSE_BYTES = 16 * 1024;
const MAX_RECONCILIATION_ATTEMPTS = 8;
const RECONCILIATION_LEASE_MS = 45_000;
const RECONCILIATION_INTERVAL_MS = 30_000;
const STARTUP_MAX_TASKS = 10;
const STARTUP_TIME_BUDGET_MS = 25_000;
const PERIODIC_MAX_TASKS = 10;
const PERIODIC_TIME_BUDGET_MS = 20_000;
const READINESS_CACHE_MS = 5_000;

type ReconciliationStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'BLOCKED';
type ReconciliationAction = 'PROVISION' | 'DELETE';

type ClaimedTask = {
  username: string;
  generation: number;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MailboxReconciliationOutcome = {
  username: string;
  action: ReconciliationAction | null;
  state: 'succeeded' | 'retry_scheduled' | 'blocked' | 'superseded' | 'not_due';
  ready: boolean;
  attempts: number;
  errorCode?: string;
};

export type MailboxReconciliationReadiness = {
  ready: boolean;
  state: 'ready' | 'reconciling' | 'blocked' | 'unavailable' | 'unconfigured';
  pending: number;
  processing: number;
  blocked: number;
  oldestUnresolvedAt: string | null;
  lastRunAt: string | null;
};

class SafeReconciliationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SafeReconciliationError';
  }
}

export class MailboxReconciliationPendingError extends Error {
  constructor(
    readonly username: string,
    readonly state: MailboxReconciliationOutcome['state'],
    readonly errorCode?: string,
  ) {
    super(state === 'blocked'
      ? `Mailbox '${username}' reconciliation is blocked and requires operator attention`
      : `Mailbox '${username}' reconciliation is queued for retry`);
    this.name = 'MailboxReconciliationPendingError';
  }
}

let reconciliationInterval: NodeJS.Timeout | null = null;
let periodicDrain: Promise<MailboxReconciliationOutcome[]> | null = null;
let shuttingDown = false;
let lastRunAt: Date | null = null;
let readinessCache: { at: number; value: MailboxReconciliationReadiness } | null = null;
const activeExecutions = new Set<Promise<MailboxReconciliationOutcome>>();

function getStalwartUrl(): string {
  return (process.env.STALWART_URL || 'http://127.0.0.1:8580').replace(/\/+$/, '');
}

function getStalwartAdminPass(): string {
  return process.env.STALWART_ADMIN_PASS || '';
}

function getMailDomain(): string {
  return process.env.MAIL_DOMAIN || 'localhost';
}

function adminAuthHeader(): string {
  return 'Basic ' + Buffer.from(`${STALWART_ADMIN_USER}:${getStalwartAdminPass()}`).toString('base64');
}

function invalidateReadinessCache(): void {
  readinessCache = null;
}

async function requestStalwart(
  path: string,
  action: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number }> {
  assertPortalFeatureAvailable('mail');

  let response: Response;
  try {
    response = await fetch(`${getStalwartUrl()}${path}`, {
      ...init,
      redirect: 'error',
      headers: {
        'Authorization': adminAuthHeader(),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(STALWART_REQUEST_TIMEOUT_MS),
    });
    await readBoundedResponseBody(response, MAX_STALWART_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof SafeReconciliationError) throw error;
    if (error instanceof ResponseTooLargeError) {
      throw new SafeReconciliationError('stalwart_response_too_large', `Mail server returned an oversized response while attempting to ${action}`);
    }
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new SafeReconciliationError('stalwart_timeout', `Mail server timed out while attempting to ${action}`);
    }
    throw new SafeReconciliationError('stalwart_network_error', `Mail server was unavailable while attempting to ${action}`);
  }
  return { ok: response.ok, status: response.status };
}

async function ensureStalwartPrincipal(username: string, encryptedPassword: string): Promise<void> {
  let password: string;
  try {
    password = decryptSecret(encryptedPassword);
  } catch {
    throw new SafeReconciliationError('stored_secret_unavailable', 'Stored mailbox secret could not be authenticated');
  }

  const email = `${username}@${getMailDomain()}`;
  const createResponse = await requestStalwart('/api/principal', 'create the mailbox account', {
    method: 'POST',
    body: JSON.stringify({
      type: 'individual',
      name: username,
      secrets: [password],
      emails: [email],
      roles: ['user'],
      quota: 1073741824,
    }),
  });

  if (createResponse.status === 409) {
    const patchResponse = await requestStalwart(
      `/api/principal/${encodeURIComponent(username)}`,
      'update the mailbox account',
      {
        method: 'PATCH',
        body: JSON.stringify([
          { action: 'set', field: 'secrets', value: [password] },
        ]),
      },
    );
    if (!patchResponse.ok) {
      throw new SafeReconciliationError(
        `stalwart_http_${patchResponse.status}`,
        `Mail server could not update the mailbox account (HTTP ${patchResponse.status})`,
      );
    }
    return;
  }

  if (!createResponse.ok) {
    throw new SafeReconciliationError(
      `stalwart_http_${createResponse.status}`,
      `Mail server could not create the mailbox account (HTTP ${createResponse.status})`,
    );
  }
}

async function deleteStalwartPrincipal(username: string): Promise<void> {
  const response = await requestStalwart(
    `/api/principal/${encodeURIComponent(username)}`,
    'delete the mailbox account',
    { method: 'DELETE' },
  );
  if (!response.ok && response.status !== 404) {
    throw new SafeReconciliationError(
      `stalwart_http_${response.status}`,
      `Mail server could not delete the mailbox account (HTTP ${response.status})`,
    );
  }
}

function backoffMs(attempts: number): number {
  return Math.min(15 * 60_000, 5_000 * (2 ** Math.max(0, attempts - 1)));
}

function safeFailure(error: unknown): SafeReconciliationError {
  if (error instanceof SafeReconciliationError) return error;
  return new SafeReconciliationError('internal_reconciliation_error', 'Mailbox reconciliation failed safely');
}

function isPermanentFailure(error: SafeReconciliationError): boolean {
  return error.code === 'reserved_mailbox_username'
    || error.code === 'invalid_mailbox_username'
    || error.code === 'stored_secret_unavailable';
}

async function markExhaustedLeases(tx: Prisma.TransactionClient, now: Date): Promise<void> {
  await tx.mailboxReconciliationTask.updateMany({
    where: {
      status: 'PROCESSING',
      attempts: { gte: MAX_RECONCILIATION_ATTEMPTS },
      leaseExpiresAt: { lte: now },
    },
    data: {
      status: 'BLOCKED',
      leaseId: null,
      leaseExpiresAt: null,
      lastErrorCode: 'lease_expired',
      lastErrorAt: now,
      completedAt: null,
    },
  });
}

async function claimNextTask(username?: string): Promise<ClaimedTask | null> {
  if (shuttingDown) return null;
  const normalized = username === undefined ? undefined : normalizeMailboxUsername(username);
  const now = new Date();

  const claimed = await prisma.$transaction(async (tx) => {
    await markExhaustedLeases(tx, now);
    const usernameFilter = normalized === undefined
      ? Prisma.empty
      : Prisma.sql`AND "username" = ${normalized}`;
    const rows = await tx.$queryRaw<Array<{ username: string }>>(Prisma.sql`
      SELECT "username"
      FROM "MailboxReconciliationTask"
      WHERE "status" IN ('PENDING', 'PROCESSING')
        AND "attempts" < ${MAX_RECONCILIATION_ATTEMPTS}
        AND "nextAttemptAt" <= ${now}
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
        ${usernameFilter}
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC, "username" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    if (!rows[0]) return null;

    return tx.mailboxReconciliationTask.update({
      where: { username: rows[0].username },
      data: {
        status: 'PROCESSING',
        attempts: { increment: 1 },
        leaseId: crypto.randomUUID(),
        leaseExpiresAt: new Date(now.getTime() + RECONCILIATION_LEASE_MS),
      },
    });
  });
  invalidateReadinessCache();
  return claimed;
}

async function finishSuperseded(task: ClaimedTask): Promise<MailboxReconciliationOutcome> {
  if (task.leaseId) {
    await prisma.mailboxReconciliationTask.updateMany({
      where: { username: task.username, leaseId: task.leaseId },
      data: { leaseId: null, leaseExpiresAt: null },
    });
  }
  invalidateReadinessCache();
  return {
    username: task.username,
    action: null,
    state: 'superseded',
    ready: false,
    attempts: task.attempts,
  };
}

async function executeClaim(task: ClaimedTask): Promise<MailboxReconciliationOutcome> {
  let action: ReconciliationAction | null = null;
  try {
    const canonicalUsername = normalizeMailboxUsername(task.username);
    if (!canonicalUsername || canonicalUsername !== task.username) {
      throw new SafeReconciliationError('invalid_mailbox_username', 'Mailbox reconciliation task has an invalid username');
    }
    if (isReservedSystemMailboxUsername(canonicalUsername)) {
      throw new SafeReconciliationError('reserved_mailbox_username', 'Reserved system mailbox cannot be managed as a user mailbox');
    }

    const desired = await prisma.mailboxAccount.findUnique({
      where: { username: canonicalUsername },
      select: { mailPassword: true },
    });
    if (desired) {
      action = 'PROVISION';
      await ensureStalwartPrincipal(canonicalUsername, desired.mailPassword);
    } else {
      action = 'DELETE';
      await deleteStalwartPrincipal(canonicalUsername);
    }

    const completed = await prisma.mailboxReconciliationTask.updateMany({
      where: {
        username: task.username,
        generation: task.generation,
        leaseId: task.leaseId,
      },
      data: {
        status: 'SUCCEEDED',
        leaseId: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorAt: null,
        completedAt: new Date(),
      },
    });
    if (completed.count !== 1) return finishSuperseded(task);

    invalidateReadinessCache();
    return {
      username: task.username,
      action,
      state: 'succeeded',
      ready: true,
      attempts: task.attempts,
    };
  } catch (unknownError) {
    const error = safeFailure(unknownError);
    const blocked = isPermanentFailure(error) || task.attempts >= MAX_RECONCILIATION_ATTEMPTS;
    const failed = await prisma.mailboxReconciliationTask.updateMany({
      where: {
        username: task.username,
        generation: task.generation,
        leaseId: task.leaseId,
      },
      data: {
        status: blocked ? 'BLOCKED' : 'PENDING',
        nextAttemptAt: blocked ? new Date() : new Date(Date.now() + backoffMs(task.attempts)),
        leaseId: null,
        leaseExpiresAt: null,
        lastErrorCode: error.code,
        lastErrorAt: new Date(),
        completedAt: null,
      },
    });
    if (failed.count !== 1) return finishSuperseded(task);

    console.warn(`[mailbox-reconciliation] ${blocked ? 'blocked' : 'retry scheduled'} username=${task.username} action=${action || 'unknown'} attempt=${task.attempts} code=${error.code}`);
    invalidateReadinessCache();
    return {
      username: task.username,
      action,
      state: blocked ? 'blocked' : 'retry_scheduled',
      ready: false,
      attempts: task.attempts,
      errorCode: error.code,
    };
  }
}

function trackExecution(task: ClaimedTask): Promise<MailboxReconciliationOutcome> {
  const execution = executeClaim(task);
  activeExecutions.add(execution);
  void execution.then(
    () => activeExecutions.delete(execution),
    () => activeExecutions.delete(execution),
  );
  return execution;
}

export async function enqueueMailboxReconciliation(username: string): Promise<void> {
  const canonicalUsername = normalizeMailboxUsername(username);
  if (!canonicalUsername) throw new Error('Mailbox username is required');

  await prisma.mailboxReconciliationTask.upsert({
    where: { username: canonicalUsername },
    create: {
      username: canonicalUsername,
      generation: 1,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(),
    },
    update: {
      generation: { increment: 1 },
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(),
      lastErrorCode: null,
      lastErrorAt: null,
      completedAt: null,
    },
  });
  invalidateReadinessCache();
}

export async function reconcileMailboxUsernameNow(username: string): Promise<MailboxReconciliationOutcome> {
  const canonicalUsername = normalizeMailboxUsername(username);
  if (!getPortalFeatureCapabilities().mail.available) {
    return {
      username: canonicalUsername,
      action: null,
      state: 'not_due',
      ready: false,
      attempts: 0,
      errorCode: 'portal_feature_unavailable',
    };
  }

  const task = await claimNextTask(canonicalUsername);
  if (task) return trackExecution(task);

  const current = await prisma.mailboxReconciliationTask.findUnique({
    where: { username: canonicalUsername },
    select: { status: true, attempts: true, lastErrorCode: true },
  });
  if (current?.status === 'SUCCEEDED') {
    return { username: canonicalUsername, action: null, state: 'succeeded', ready: true, attempts: current.attempts };
  }
  return {
    username: canonicalUsername,
    action: null,
    state: current?.status === 'BLOCKED' ? 'blocked' : 'not_due',
    ready: false,
    attempts: current?.attempts || 0,
    ...(current?.lastErrorCode ? { errorCode: current.lastErrorCode } : {}),
  };
}

export async function requireMailboxReconciled(username: string): Promise<void> {
  const outcome = await reconcileMailboxUsernameNow(username);
  if (!outcome.ready) {
    throw new MailboxReconciliationPendingError(outcome.username, outcome.state, outcome.errorCode);
  }
}

export async function drainMailboxReconciliation(options: {
  maxTasks: number;
  timeBudgetMs: number;
}): Promise<MailboxReconciliationOutcome[]> {
  if (!getPortalFeatureCapabilities().mail.available) return [];

  const startedAt = Date.now();
  const outcomes: MailboxReconciliationOutcome[] = [];
  // Without an admin credential every Stalwart call fails by construction;
  // park the queue instead of burning retries against a 401.
  if (!getStalwartAdminPass()) {
    lastRunAt = new Date();
    invalidateReadinessCache();
    return outcomes;
  }
  while (!shuttingDown && outcomes.length < options.maxTasks && Date.now() - startedAt < options.timeBudgetMs) {
    const task = await claimNextTask();
    if (!task) break;
    outcomes.push(await trackExecution(task));
  }
  lastRunAt = new Date();
  invalidateReadinessCache();
  return outcomes;
}

function runPeriodicDrain(): Promise<MailboxReconciliationOutcome[]> {
  if (periodicDrain) return periodicDrain;
  periodicDrain = drainMailboxReconciliation({
    maxTasks: PERIODIC_MAX_TASKS,
    timeBudgetMs: PERIODIC_TIME_BUDGET_MS,
  }).finally(() => {
    periodicDrain = null;
  });
  return periodicDrain;
}

export async function initializeMailboxReconciliationRuntime(): Promise<void> {
  shuttingDown = false;
  if (reconciliationInterval) clearInterval(reconciliationInterval);
  reconciliationInterval = null;

  // Private/local origin modes deliberately do not run mail. Do not even
  // inspect the durable queue: a later domain-mode migration can reconcile it.
  if (!getPortalFeatureCapabilities().mail.available) return;

  const outcomes = await drainMailboxReconciliation({
    maxTasks: STARTUP_MAX_TASKS,
    timeBudgetMs: STARTUP_TIME_BUDGET_MS,
  });
  const unresolved = outcomes.filter((outcome) => !outcome.ready).length;
  if (outcomes.length > 0) {
    console.log(`[mailbox-reconciliation] startup pass processed=${outcomes.length} unresolved=${unresolved}`);
  }

  reconciliationInterval = setInterval(() => {
    void runPeriodicDrain().catch((error) => {
      console.error('[mailbox-reconciliation] periodic pass failed safely:', safeFailure(error).code);
    });
  }, RECONCILIATION_INTERVAL_MS);
  reconciliationInterval.unref();
}

export async function shutdownMailboxReconciliationRuntime(): Promise<void> {
  shuttingDown = true;
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
    reconciliationInterval = null;
  }

  const pending = [...activeExecutions];
  if (periodicDrain) pending.push(periodicDrain.then(() => ({
    username: '', action: null, state: 'succeeded', ready: true, attempts: 0,
  })));
  if (pending.length === 0) return;

  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>((resolve) => setTimeout(resolve, RECONCILIATION_LEASE_MS)),
  ]);
}

export async function getMailboxReconciliationReadiness(): Promise<MailboxReconciliationReadiness> {
  if (!getPortalFeatureCapabilities().mail.available) {
    return {
      ready: true,
      state: 'unconfigured',
      pending: 0,
      processing: 0,
      blocked: 0,
      oldestUnresolvedAt: null,
      lastRunAt: lastRunAt?.toISOString() || null,
    };
  }

  if (readinessCache && Date.now() - readinessCache.at < READINESS_CACHE_MS) {
    return readinessCache.value;
  }

  // Mail is an optional subsystem: when it was never configured there is no
  // admin credential to reconcile with, so unresolved tasks are parked state,
  // not deployment un-readiness. Without this, one stray mailbox row blocks
  // every future update's readiness gate forever.
  if (!getStalwartAdminPass()) {
    const value: MailboxReconciliationReadiness = {
      ready: true,
      state: 'unconfigured',
      pending: 0,
      processing: 0,
      blocked: 0,
      oldestUnresolvedAt: null,
      lastRunAt: lastRunAt?.toISOString() || null,
    };
    readinessCache = { at: Date.now(), value };
    return value;
  }

  try {
    const [groups, oldest] = await Promise.all([
      prisma.mailboxReconciliationTask.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.mailboxReconciliationTask.findFirst({
        where: { status: { in: ['PENDING', 'PROCESSING', 'BLOCKED'] } },
        orderBy: [{ createdAt: 'asc' }, { username: 'asc' }],
        select: { createdAt: true },
      }),
    ]);
    const counts = new Map(groups.map((group) => [group.status as ReconciliationStatus, group._count._all]));
    const pending = counts.get('PENDING') || 0;
    const processing = counts.get('PROCESSING') || 0;
    const blocked = counts.get('BLOCKED') || 0;
    const ready = pending === 0 && processing === 0 && blocked === 0;
    const value: MailboxReconciliationReadiness = {
      ready,
      state: blocked > 0 ? 'blocked' : ready ? 'ready' : 'reconciling',
      pending,
      processing,
      blocked,
      oldestUnresolvedAt: oldest?.createdAt.toISOString() || null,
      lastRunAt: lastRunAt?.toISOString() || null,
    };
    readinessCache = { at: Date.now(), value };
    return value;
  } catch {
    return {
      ready: false,
      state: 'unavailable',
      pending: 0,
      processing: 0,
      blocked: 0,
      oldestUnresolvedAt: null,
      lastRunAt: lastRunAt?.toISOString() || null,
    };
  }
}

export const mailboxReconciliationPolicy = Object.freeze({
  maxAttempts: MAX_RECONCILIATION_ATTEMPTS,
  leaseMs: RECONCILIATION_LEASE_MS,
  requestTimeoutMs: STALWART_REQUEST_TIMEOUT_MS,
  maxResponseBytes: MAX_STALWART_RESPONSE_BYTES,
});

export const __mailboxReconciliationTest = Object.freeze({
  ensureStalwartPrincipal,
  invalidateReadinessCache,
  hasRuntimeInterval: () => reconciliationInterval !== null,
});
