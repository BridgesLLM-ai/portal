import crypto from 'crypto';
import { prisma } from '../config/database';
import {
  gatewayRpcCall,
  getSessionInfo,
} from '../utils/openclawGatewayRpc';

const UNRESOLVED_STATUSES = [
  'PREPARED',
  'DISPATCHED',
  'VISIBLE_DONE',
  'QUARANTINED',
] as const;
const HOST_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const SESSION_KEY_PATTERN = /^agent:[A-Za-z0-9_-]+:[^\u0000-\u001f\u007f]{1,1980}$/;
const UPSTREAM_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/;
const RESET_TIMEOUT_MS = 45_000;

type UnresolvedStatus = typeof UNRESOLVED_STATUSES[number];
type GatewayRpcResult = {
  ok: boolean;
  data?: any;
  error?: unknown;
};
type SessionInfoResult = {
  ok: boolean;
  data?: any;
  error?: string;
};

export interface OpenClawHostRunHandle {
  id: string;
  actorUserId: string;
  actorAuthorizationVersion: number;
  provider: 'OPENCLAW';
  executionScope: 'HOST_OPERATOR';
  sessionKey: string;
}

interface OpenClawHostRunRow extends OpenClawHostRunHandle {
  portalInstanceId: string;
  status: string;
  upstreamRunId: string | null;
  visibleSettledAt: Date | null;
  quiescedAt: Date | null;
  terminalReason: string | null;
  evidence: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenClawSessionResetProof {
  schemaVersion: 1;
  sessionKey: string;
  beforeSessionId: string | null;
  resetSessionId: string;
  readbackSessionId: string;
  reattestedSessionId: string;
  rowCount: number;
  rowIdentitySha256: string;
  resetAt: string;
}

export interface OpenClawHostRunQuiescence {
  schemaVersion: 1;
  actorUserIds: string[];
  rowCount: number;
  sessionCount: number;
  sessions: OpenClawSessionResetProof[];
}

export class OpenClawHostRunJournalError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'OpenClawHostRunJournalError';
  }
}

interface OpenClawHostRunJournalDependencies {
  database: any;
  portalInstanceId: string;
  now(): Date;
  getSessionInfo(sessionKey: string): Promise<SessionInfoResult>;
  gatewayRpcCall(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<GatewayRpcResult>;
}

const defaultDependencies: OpenClawHostRunJournalDependencies = {
  database: prisma,
  portalInstanceId: `${process.pid}-${crypto.randomUUID()}`,
  now: () => new Date(),
  getSessionInfo,
  gatewayRpcCall,
};

function exactIdentifier(value: unknown, label: string, maxLength = 512): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (
    !normalized
    || normalized.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new OpenClawHostRunJournalError(
      `Invalid ${label}`,
      400,
      'OPENCLAW_HOST_RUN_INVALID',
    );
  }
  return normalized;
}

function canonicalActorIds(values: readonly string[]): string[] {
  const actorIds = values.map((value) => exactIdentifier(value, 'actor identity', 255));
  const canonical = [...new Set(actorIds)].sort();
  if (canonical.length === 0) {
    throw new OpenClawHostRunJournalError(
      'At least one actor identity is required',
      400,
      'OPENCLAW_HOST_RUN_INVALID',
    );
  }
  return canonical;
}

function validateHandle(input: OpenClawHostRunHandle): void {
  if (!HOST_RUN_ID_PATTERN.test(input.id)) {
    throw new OpenClawHostRunJournalError(
      'OpenClaw host run identity is invalid',
      400,
      'OPENCLAW_HOST_RUN_INVALID',
    );
  }
  exactIdentifier(input.actorUserId, 'actor identity', 255);
  if (
    !Number.isSafeInteger(input.actorAuthorizationVersion)
    || input.actorAuthorizationVersion < 1
  ) {
    throw new OpenClawHostRunJournalError(
      'OpenClaw host run authorization generation is invalid',
      400,
      'OPENCLAW_HOST_RUN_INVALID',
    );
  }
  if (input.provider !== 'OPENCLAW' || input.executionScope !== 'HOST_OPERATOR') {
    throw new OpenClawHostRunJournalError(
      'OpenClaw host run execution authority is invalid',
      400,
      'OPENCLAW_HOST_RUN_INVALID',
    );
  }
  if (!SESSION_KEY_PATTERN.test(input.sessionKey)) {
    throw new OpenClawHostRunJournalError(
      'OpenClaw host run session identity is invalid',
      400,
      'OPENCLAW_HOST_RUN_INVALID',
    );
  }
}

function validateUpstreamRunId(value: unknown): string {
  const runId = exactIdentifier(value, 'upstream run identity', 512);
  if (!UPSTREAM_RUN_ID_PATTERN.test(runId)) {
    throw new OpenClawHostRunJournalError(
      'OpenClaw upstream run identity is invalid',
      502,
      'OPENCLAW_UPSTREAM_RUN_INVALID',
    );
  }
  return runId;
}

function sameHandle(row: OpenClawHostRunRow, handle: OpenClawHostRunHandle): boolean {
  return row.id === handle.id
    && row.actorUserId === handle.actorUserId
    && Number(row.actorAuthorizationVersion) === handle.actorAuthorizationVersion
    && row.provider === handle.provider
    && row.executionScope === handle.executionScope
    && row.sessionKey === handle.sessionKey;
}

function isUnresolvedStatus(value: unknown): value is UnresolvedStatus {
  return (UNRESOLVED_STATUSES as readonly string[]).includes(String(value || ''));
}

function errorSummary(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || 'Unknown error');
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 1_024)
    || 'Unknown error';
}

function sessionIdFromInfo(
  result: SessionInfoResult,
  sessionKey: string,
  allowMissing: boolean,
): string | null {
  if (!result.ok) {
    if (allowMissing && /^session not found$/i.test(String(result.error || '').trim())) {
      return null;
    }
    throw new OpenClawHostRunJournalError(
      `OpenClaw session ${sessionKey} could not be authoritatively read`,
      503,
      'OPENCLAW_SESSION_READ_FAILED',
    );
  }
  if (!result.data || result.data.stale === true) {
    throw new OpenClawHostRunJournalError(
      `OpenClaw session ${sessionKey} returned stale metadata`,
      503,
      'OPENCLAW_SESSION_READ_FAILED',
    );
  }
  const returnedKey = typeof result.data.key === 'string' ? result.data.key : '';
  if (returnedKey !== sessionKey) {
    throw new OpenClawHostRunJournalError(
      'OpenClaw session readback changed identity',
      503,
      'OPENCLAW_SESSION_IDENTITY_DRIFT',
    );
  }
  return exactIdentifier(result.data.sessionId, 'OpenClaw session generation', 255);
}

function resetProofDigest(rows: readonly OpenClawHostRunRow[]): string {
  const identities = rows
    .map((row) => [
      row.id,
      row.actorUserId,
      String(row.actorAuthorizationVersion),
      row.sessionKey,
      row.status,
      row.upstreamRunId || '',
    ].join('\0'))
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(identities).digest('hex');
}

function assertRowShape(row: OpenClawHostRunRow): void {
  validateHandle(row);
  exactIdentifier(row.portalInstanceId, 'Portal instance identity', 255);
  if (!isUnresolvedStatus(row.status) && row.status !== 'QUIESCED') {
    throw new OpenClawHostRunJournalError(
      'OpenClaw host run journal contains an unsupported status',
      503,
      'OPENCLAW_HOST_RUN_JOURNAL_INVALID',
    );
  }
  if (
    (row.status === 'DISPATCHED' || row.status === 'VISIBLE_DONE')
    && !row.upstreamRunId
  ) {
    throw new OpenClawHostRunJournalError(
      'OpenClaw host run journal lost its upstream run identity',
      503,
      'OPENCLAW_HOST_RUN_JOURNAL_INVALID',
    );
  }
  if (row.upstreamRunId) validateUpstreamRunId(row.upstreamRunId);
}

export function createOpenClawHostRunJournal(
  overrides: Partial<OpenClawHostRunJournalDependencies> = {},
) {
  const dependencies: OpenClawHostRunJournalDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  const readExact = async (handle: OpenClawHostRunHandle): Promise<OpenClawHostRunRow> => {
    validateHandle(handle);
    const row = await dependencies.database.openClawHostRun.findUnique({
      where: { id: handle.id },
    }) as OpenClawHostRunRow | null;
    if (!row || !sameHandle(row, handle)) {
      throw new OpenClawHostRunJournalError(
        'OpenClaw host run journal identity changed',
        409,
        'OPENCLAW_HOST_RUN_IDENTITY_DRIFT',
      );
    }
    assertRowShape(row);
    return row;
  };

  const begin = async (
    input: OpenClawHostRunHandle,
  ): Promise<OpenClawHostRunHandle> => {
    validateHandle(input);
    try {
      await dependencies.database.$transaction(async (transaction: any) => {
        const [actor, transition, ownedSession] = await Promise.all([
          transaction.user.findUnique({
            where: { id: input.actorUserId },
            select: {
              authorizationVersion: true,
              accountStatus: true,
              isActive: true,
            },
          }),
          transaction.projectAuthorizationTransition.findFirst({
            where: { phase: { not: 'COMPLETE' } },
            select: { id: true },
          }),
          transaction.agentSession.findFirst({
            where: {
              userId: input.actorUserId,
              provider: 'OPENCLAW',
              externalId: input.sessionKey,
            },
            select: { id: true },
          }),
        ]);
        if (transition) {
          throw new OpenClawHostRunJournalError(
            'OpenClaw host-run admission is closed during an authorization transition',
            503,
            'AUTHORIZATION_TRANSITION_ACTIVE',
          );
        }
        if (
          !actor
          || actor.accountStatus !== 'ACTIVE'
          || actor.isActive !== true
          || Number(actor.authorizationVersion) !== input.actorAuthorizationVersion
        ) {
          throw new OpenClawHostRunJournalError(
            'OpenClaw host-run authorization changed before provider admission',
            409,
            'AUTHORIZATION_CHANGED',
          );
        }
        if (!ownedSession) {
          throw new OpenClawHostRunJournalError(
            'OpenClaw host session is not durably owned by this actor',
            409,
            'OPENCLAW_SESSION_OWNERSHIP_CONFLICT',
          );
        }
        await transaction.openClawHostRun.create({
          data: {
            ...input,
            portalInstanceId: dependencies.portalInstanceId,
            status: 'PREPARED',
          },
        });
      }, { isolationLevel: 'Serializable' });
    } catch (error: any) {
      if (error instanceof OpenClawHostRunJournalError) throw error;
      if (error?.code === 'P2002') {
        const existing = await dependencies.database.openClawHostRun.findUnique({
          where: { id: input.id },
        }) as OpenClawHostRunRow | null;
        if (existing && sameHandle(existing, input) && isUnresolvedStatus(existing.status)) {
          assertRowShape(existing);
          return Object.freeze({ ...input });
        }
        throw new OpenClawHostRunJournalError(
          'OpenClaw host run identity was already used',
          409,
          'OPENCLAW_HOST_RUN_ALREADY_EXISTS',
        );
      }
      throw error;
    }
    return Object.freeze({ ...input });
  };

  const markDispatchAccepted = async (
    handle: OpenClawHostRunHandle,
    rawUpstreamRunId: string,
  ): Promise<void> => {
    const upstreamRunId = validateUpstreamRunId(rawUpstreamRunId);
    const updated = await dependencies.database.openClawHostRun.updateMany({
      where: {
        id: handle.id,
        actorUserId: handle.actorUserId,
        actorAuthorizationVersion: handle.actorAuthorizationVersion,
        provider: handle.provider,
        executionScope: handle.executionScope,
        sessionKey: handle.sessionKey,
        status: 'PREPARED',
        upstreamRunId: null,
      },
      data: {
        status: 'DISPATCHED',
        upstreamRunId,
        evidence: {
          schemaVersion: 1,
          dispatchAcceptedAt: dependencies.now().toISOString(),
        },
      },
    });
    if (updated.count === 1) return;
    const row = await readExact(handle);
    if (row.status === 'QUIESCED') return;
    if (
      row.upstreamRunId === upstreamRunId
      && ['DISPATCHED', 'VISIBLE_DONE', 'QUARANTINED'].includes(row.status)
    ) {
      return;
    }
    throw new OpenClawHostRunJournalError(
      'OpenClaw dispatch acceptance could not be committed',
      503,
      'OPENCLAW_DISPATCH_JOURNAL_FAILED',
    );
  };

  const markVisibleSettled = async (
    handle: OpenClawHostRunHandle,
    outcome: 'completed' | 'error',
  ): Promise<void> => {
    const settledAt = dependencies.now();
    const updated = await dependencies.database.openClawHostRun.updateMany({
      where: {
        id: handle.id,
        actorUserId: handle.actorUserId,
        actorAuthorizationVersion: handle.actorAuthorizationVersion,
        provider: handle.provider,
        executionScope: handle.executionScope,
        sessionKey: handle.sessionKey,
        status: 'DISPATCHED',
        upstreamRunId: { not: null },
      },
      data: {
        status: 'VISIBLE_DONE',
        visibleSettledAt: settledAt,
        terminalReason: outcome,
        evidence: {
          schemaVersion: 1,
          visibleOutcome: outcome,
          visibleSettledAt: settledAt.toISOString(),
          providerQuiescent: false,
        },
      },
    });
    if (updated.count === 1) return;
    const row = await readExact(handle);
    if (row.status === 'QUIESCED') return;
    if (row.status === 'VISIBLE_DONE' && row.terminalReason === outcome) return;
    throw new OpenClawHostRunJournalError(
      'OpenClaw visible settlement could not be committed',
      503,
      'OPENCLAW_VISIBLE_SETTLEMENT_FAILED',
    );
  };

  const quarantine = async (
    handle: OpenClawHostRunHandle,
    reason: unknown,
  ): Promise<void> => {
    validateHandle(handle);
    const quarantinedAt = dependencies.now();
    const updated = await dependencies.database.openClawHostRun.updateMany({
      where: {
        id: handle.id,
        actorUserId: handle.actorUserId,
        actorAuthorizationVersion: handle.actorAuthorizationVersion,
        provider: handle.provider,
        executionScope: handle.executionScope,
        sessionKey: handle.sessionKey,
        status: { in: [...UNRESOLVED_STATUSES] },
      },
      data: {
        status: 'QUARANTINED',
        terminalReason: 'provider_outcome_ambiguous',
        evidence: {
          schemaVersion: 1,
          quarantinedAt: quarantinedAt.toISOString(),
          reason: errorSummary(reason),
          providerQuiescent: false,
        },
      },
    });
    if (updated.count === 1) return;
    const row = await readExact(handle);
    if (row.status === 'QUIESCED') return;
    if (row.status === 'QUARANTINED') return;
    throw new OpenClawHostRunJournalError(
      'OpenClaw host run could not be quarantined',
      503,
      'OPENCLAW_HOST_RUN_QUARANTINE_FAILED',
    );
  };

  const resetSession = async (
    sessionKey: string,
    rows: readonly OpenClawHostRunRow[],
  ): Promise<OpenClawSessionResetProof> => {
    const before = sessionIdFromInfo(
      await dependencies.getSessionInfo(sessionKey),
      sessionKey,
      true,
    );
    const reset = await dependencies.gatewayRpcCall(
      'sessions.reset',
      { key: sessionKey, reason: 'reset' },
      RESET_TIMEOUT_MS,
    );
    if (!reset.ok || reset.data?.ok !== true) {
      throw new OpenClawHostRunJournalError(
        `OpenClaw session ${sessionKey} did not reset authoritatively`,
        503,
        'OPENCLAW_SESSION_RESET_FAILED',
      );
    }
    const resetKey = exactIdentifier(reset.data?.key, 'reset session key', 2_048);
    const resetSessionId = exactIdentifier(
      reset.data?.entry?.sessionId,
      'reset session generation',
      255,
    );
    if (resetKey !== sessionKey || (before && resetSessionId === before)) {
      throw new OpenClawHostRunJournalError(
        'OpenClaw session reset did not rotate the exact session identity',
        503,
        'OPENCLAW_SESSION_IDENTITY_DRIFT',
      );
    }
    const readbackSessionId = sessionIdFromInfo(
      await dependencies.getSessionInfo(sessionKey),
      sessionKey,
      false,
    );
    const reattestedSessionId = sessionIdFromInfo(
      await dependencies.getSessionInfo(sessionKey),
      sessionKey,
      false,
    );
    if (
      readbackSessionId !== resetSessionId
      || reattestedSessionId !== resetSessionId
    ) {
      throw new OpenClawHostRunJournalError(
        'OpenClaw session generation changed after reset',
        503,
        'OPENCLAW_SESSION_IDENTITY_DRIFT',
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      sessionKey,
      beforeSessionId: before,
      resetSessionId,
      readbackSessionId,
      reattestedSessionId,
      rowCount: rows.length,
      rowIdentitySha256: resetProofDigest(rows),
      resetAt: dependencies.now().toISOString(),
    });
  };

  const quiesce = async (
    rawActorUserIds: readonly string[],
    reason: 'authorization_transition' | 'project_dependency_promotion' =
      'authorization_transition',
  ): Promise<OpenClawHostRunQuiescence> => {
    const actorUserIds = canonicalActorIds(rawActorUserIds);
    const [rows, ownedSessions] = await Promise.all([
      dependencies.database.openClawHostRun.findMany({
        where: {
          actorUserId: { in: actorUserIds },
          status: { in: [...UNRESOLVED_STATUSES] },
        },
        orderBy: [{ sessionKey: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }),
      dependencies.database.agentSession.findMany({
        where: {
          userId: { in: actorUserIds },
          provider: 'OPENCLAW',
        },
        select: {
          id: true,
          userId: true,
          externalId: true,
        },
        orderBy: [{ externalId: 'asc' }, { id: 'asc' }],
      }),
    ]) as [OpenClawHostRunRow[], Array<{
      id: string;
      userId: string;
      externalId: string;
    }>];
    rows.forEach(assertRowShape);

    const grouped = new Map<string, OpenClawHostRunRow[]>();
    for (const session of ownedSessions) {
      const sessionKey = exactIdentifier(
        session.externalId,
        'owned OpenClaw session identity',
        2_048,
      );
      if (
        !SESSION_KEY_PATTERN.test(sessionKey)
        || !actorUserIds.includes(exactIdentifier(session.userId, 'session owner', 255))
        || grouped.has(sessionKey)
      ) {
        throw new OpenClawHostRunJournalError(
          'OpenClaw session ownership inventory is ambiguous',
          503,
          'OPENCLAW_SESSION_OWNERSHIP_CONFLICT',
        );
      }
      grouped.set(sessionKey, []);
    }
    for (const row of rows) {
      const sessionRows = grouped.get(row.sessionKey);
      if (!sessionRows) {
        throw new OpenClawHostRunJournalError(
          'OpenClaw host-run journal has no durable session owner',
          503,
          'OPENCLAW_SESSION_OWNERSHIP_CONFLICT',
        );
      }
      sessionRows.push(row);
    }

    const proofs: OpenClawSessionResetProof[] = [];
    for (const [sessionKey, sessionRows] of grouped) {
      const everyUnresolvedSessionRow = await dependencies.database.openClawHostRun.findMany({
        where: {
          sessionKey,
          status: { in: [...UNRESOLVED_STATUSES] },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }) as OpenClawHostRunRow[];
      const everySessionOwner = await dependencies.database.agentSession.findMany({
        where: {
          provider: 'OPENCLAW',
          externalId: sessionKey,
        },
        select: { id: true, userId: true, externalId: true },
      }) as Array<{ id: string; userId: string; externalId: string }>;
      everyUnresolvedSessionRow.forEach(assertRowShape);
      if (
        everySessionOwner.length !== 1
        || !actorUserIds.includes(String(everySessionOwner[0]?.userId || ''))
        || everyUnresolvedSessionRow.some((row) => !actorUserIds.includes(row.actorUserId))
      ) {
        throw new OpenClawHostRunJournalError(
          'An OpenClaw host session is shared across authorization boundaries',
          503,
          'OPENCLAW_SESSION_OWNERSHIP_CONFLICT',
        );
      }
      if (
        everyUnresolvedSessionRow.length !== sessionRows.length
        || resetProofDigest(everyUnresolvedSessionRow) !== resetProofDigest(sessionRows)
      ) {
        throw new OpenClawHostRunJournalError(
          'OpenClaw host-run journal changed before provider reset',
          503,
          'OPENCLAW_HOST_RUN_IDENTITY_DRIFT',
        );
      }

      const resetProof = await resetSession(sessionKey, sessionRows);
      const proof = await dependencies.database.$transaction(async (transaction: any) => {
        const current = await transaction.openClawHostRun.findMany({
          where: {
            sessionKey,
            status: { in: [...UNRESOLVED_STATUSES] },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }) as OpenClawHostRunRow[];
        current.forEach(assertRowShape);
        const currentDigest = resetProofDigest(current);
        if (
          resetProof.rowCount !== current.length
          || current.length !== sessionRows.length
          || currentDigest !== resetProof.rowIdentitySha256
        ) {
          throw new OpenClawHostRunJournalError(
            'OpenClaw host-run journal changed during provider reset',
            503,
            'OPENCLAW_HOST_RUN_IDENTITY_DRIFT',
          );
        }
        const committedProof: OpenClawSessionResetProof = Object.freeze({
          ...resetProof,
          rowCount: current.length,
          rowIdentitySha256: currentDigest,
        });
        let updatedCount = 0;
        for (const row of current) {
          const updated = await transaction.openClawHostRun.updateMany({
            where: {
              id: row.id,
              actorUserId: row.actorUserId,
              actorAuthorizationVersion: row.actorAuthorizationVersion,
              provider: row.provider,
              executionScope: row.executionScope,
              sessionKey: row.sessionKey,
              status: row.status,
              upstreamRunId: row.upstreamRunId,
            },
            data: {
              status: 'QUIESCED',
              quiescedAt: dependencies.now(),
              terminalReason: `${reason}_session_reset`,
              evidence: committedProof,
            },
          });
          updatedCount += updated.count;
        }
        if (updatedCount !== current.length) {
          throw new OpenClawHostRunJournalError(
            'OpenClaw session reset proof could not be committed',
            503,
            'OPENCLAW_SESSION_RESET_PROOF_FAILED',
          );
        }
        return committedProof;
      }, { isolationLevel: 'Serializable' });
      proofs.push(proof);
    }

    const remaining = await dependencies.database.openClawHostRun.count({
      where: {
        actorUserId: { in: actorUserIds },
        status: { in: [...UNRESOLVED_STATUSES] },
      },
    });
    if (remaining !== 0) {
      throw new OpenClawHostRunJournalError(
        reason === 'authorization_transition'
          ? 'OpenClaw host runs remain after authorization quiescence'
          : 'OpenClaw host runs remain before dependency promotion',
        503,
        'OPENCLAW_HOST_RUN_QUIESCENCE_UNPROVEN',
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      actorUserIds,
      rowCount: rows.length,
      sessionCount: proofs.length,
      sessions: Object.freeze(proofs) as OpenClawSessionResetProof[],
    });
  };

  const quiesceForAuthorizationTransition = (
    actorUserIds: readonly string[],
  ): Promise<OpenClawHostRunQuiescence> => (
    quiesce(actorUserIds, 'authorization_transition')
  );

  const initialize = async (): Promise<{ unresolved: number }> => {
    const rows = await dependencies.database.openClawHostRun.findMany({
      where: { status: { in: [...UNRESOLVED_STATUSES] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }) as OpenClawHostRunRow[];
    rows.forEach(assertRowShape);
    const actorIds = [...new Set(rows.map((row) => row.actorUserId))].sort();
    if (actorIds.length === 0) return { unresolved: 0 };
    const [actors, transition, ownedSessions] = await Promise.all([
      dependencies.database.user.findMany({
        where: { id: { in: actorIds } },
        select: {
          id: true,
          authorizationVersion: true,
          accountStatus: true,
          isActive: true,
        },
      }),
      dependencies.database.projectAuthorizationTransition.findFirst({
        where: { phase: { not: 'COMPLETE' } },
        select: { id: true },
      }),
      dependencies.database.agentSession.findMany({
        where: {
          userId: { in: actorIds },
          provider: 'OPENCLAW',
        },
        select: { userId: true, externalId: true },
      }),
    ]);
    if (transition) {
      throw new OpenClawHostRunJournalError(
        'OpenClaw host-run journal started before transition recovery completed',
        503,
        'AUTHORIZATION_TRANSITION_ACTIVE',
      );
    }
    const actorById = new Map<string, any>(
      actors.map((actor: any): [string, any] => [String(actor.id), actor]),
    );
    const sessionOwners = new Map<string, string>();
    for (const session of ownedSessions as Array<{ userId: string; externalId: string }>) {
      const sessionKey = exactIdentifier(
        session.externalId,
        'owned OpenClaw session identity',
        2_048,
      );
      if (sessionOwners.has(sessionKey)) {
        throw new OpenClawHostRunJournalError(
          'OpenClaw session ownership inventory is ambiguous',
          503,
          'OPENCLAW_SESSION_OWNERSHIP_CONFLICT',
        );
      }
      sessionOwners.set(sessionKey, String(session.userId || ''));
    }
    for (const row of rows) {
      const actor = actorById.get(row.actorUserId);
      if (
        !actor
        || actor.accountStatus !== 'ACTIVE'
        || actor.isActive !== true
        || Number(actor.authorizationVersion) !== row.actorAuthorizationVersion
      ) {
        throw new OpenClawHostRunJournalError(
          'OpenClaw host-run authorization drift requires provider quiescence',
          503,
          'OPENCLAW_HOST_RUN_AUTHORIZATION_DRIFT',
        );
      }
      if (sessionOwners.get(row.sessionKey) !== row.actorUserId) {
        throw new OpenClawHostRunJournalError(
          'OpenClaw host-run journal has no exact session owner',
          503,
          'OPENCLAW_SESSION_OWNERSHIP_CONFLICT',
        );
      }
    }
    return { unresolved: rows.length };
  };

  const quiesceForProjectDependencyPromotion = async (
  ): Promise<OpenClawHostRunQuiescence> => {
    const rows = await dependencies.database.openClawHostRun.findMany({
      where: { status: { in: [...UNRESOLVED_STATUSES] } },
      select: { actorUserId: true },
    }) as Array<{ actorUserId: string }>;
    const actorUserIds = [...new Set(rows.map((row) => (
      exactIdentifier(row.actorUserId, 'actor identity', 255)
    )))].sort();
    if (actorUserIds.length === 0) {
      return Object.freeze({
        schemaVersion: 1,
        actorUserIds: [],
        rowCount: 0,
        sessionCount: 0,
        sessions: [] as OpenClawSessionResetProof[],
      });
    }
    return quiesce(actorUserIds, 'project_dependency_promotion');
  };

  return Object.freeze({
    begin,
    markDispatchAccepted,
    markVisibleSettled,
    quarantine,
    quiesceForAuthorizationTransition,
    quiesceForProjectDependencyPromotion,
    initialize,
  });
}

export const openClawHostRunJournal = createOpenClawHostRunJournal();

export const beginOpenClawHostRun = openClawHostRunJournal.begin;
export const markOpenClawHostRunDispatchAccepted =
  openClawHostRunJournal.markDispatchAccepted;
export const markOpenClawHostRunVisibleSettled =
  openClawHostRunJournal.markVisibleSettled;
export const quarantineOpenClawHostRun = openClawHostRunJournal.quarantine;
export const quiesceOpenClawHostRunsForAuthorizationTransition =
  openClawHostRunJournal.quiesceForAuthorizationTransition;
export const quiesceOpenClawHostRunsForProjectDependencyPromotion =
  openClawHostRunJournal.quiesceForProjectDependencyPromotion;
export const initializeOpenClawHostRunJournal = openClawHostRunJournal.initialize;

export const __openClawHostRunJournalTest = {
  UNRESOLVED_STATUSES,
  RESET_TIMEOUT_MS,
  resetProofDigest,
  sessionIdFromInfo,
};
