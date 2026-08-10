import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';
import { getProjectNativeRunSnapshot } from './projectNativeRunBroker';
import {
  PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED,
  PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX,
  projectChatTurnDispatchStage,
  recoverExpiredProjectChatOperationAfterNativeQuiescence,
  recoverExpiredProjectChatTurnAfterProviderTerminal,
  type ProjectChatPersistedProvider,
} from './projectChatTurnLease';
import {
  nativeProjectRestartRecoveryTargetProvider,
  quiesceNativeProjectOperationAfterRestart,
  type NativeProjectRestartQuiescenceEvidence,
} from './projectChatNativeRestartQuiescence';

const OPENCLAW_RESTART_RECOVERY_INITIAL_DELAY_MS = 5_000;
const OPENCLAW_RESTART_RECOVERY_RETRY_MS = 15_000;
const OPENCLAW_RESTART_RECOVERY_LIMIT = 4;
const OPENCLAW_RESTART_RECOVERY_RPC_TIMEOUT_MS = 2_000;
const TERMINAL_OPENCLAW_SESSION_STATUSES = new Set([
  'done',
  'failed',
  'killed',
  'timeout',
]);

export interface ProjectChatRestartRecoveryCandidate {
  id: string;
  actorUserId: string;
  projectIdentityId: string;
  provider: ProjectChatPersistedProvider;
  runtime: string;
  requestId: string;
  leaseOwner: string;
  providerSessionId: string | null;
  startedAt: Date;
  leaseExpiresAt: Date;
  resultMetadata: Prisma.JsonValue | null;
  activeTurnId: string | null;
  selectedProvider: string;
}

export interface OpenClawRestartRecoveryEvidence {
  providerStatus: string;
  providerStartedAt: Date;
  providerEndedAt: Date;
}

export interface OpenClawRestartRecoveryAttestation {
  terminal: boolean;
  reason: string;
  evidence?: OpenClawRestartRecoveryEvidence;
}

function finiteEpochMs(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1_000_000_000_000 ? number : null;
}

/**
 * Attest that chat.history describes the exact bound session and proves that
 * it is terminal with no active provider run. OpenClaw does not expose the
 * original run ID here, so this is deliberately session-level quiescence
 * evidence rather than a claim that the latest result belongs to this turn.
 */
export function attestOpenClawRestartRecoveryEvidence(input: {
  candidate: ProjectChatRestartRecoveryCandidate;
  historyPayload: unknown;
  now: Date;
}): OpenClawRestartRecoveryAttestation {
  const payload = input.historyPayload && typeof input.historyPayload === 'object'
    && !Array.isArray(input.historyPayload)
    ? input.historyPayload as Record<string, unknown>
    : null;
  const sessionInfo = payload?.sessionInfo && typeof payload.sessionInfo === 'object'
    && !Array.isArray(payload.sessionInfo)
    ? payload.sessionInfo as Record<string, unknown>
    : null;
  if (!payload || !sessionInfo) {
    return { terminal: false, reason: 'gateway-session-info-unavailable' };
  }
  const expectedSessionKey = String(input.candidate.providerSessionId || '').trim();
  if (
    !expectedSessionKey
    || String(payload.sessionKey || '').trim() !== expectedSessionKey
    || String(sessionInfo.key || '').trim() !== expectedSessionKey
  ) {
    return { terminal: false, reason: 'gateway-session-identity-mismatch' };
  }
  const providerStatus = String(sessionInfo.status || '').trim().toLowerCase();
  if (!TERMINAL_OPENCLAW_SESSION_STATUSES.has(providerStatus)) {
    return { terminal: false, reason: 'gateway-session-not-terminal' };
  }
  if (
    sessionInfo.hasActiveRun !== false
    || !Array.isArray(sessionInfo.activeRunIds)
    || sessionInfo.activeRunIds.length !== 0
  ) {
    return { terminal: false, reason: 'gateway-active-run-not-disproven' };
  }
  const providerStartedAtMs = finiteEpochMs(sessionInfo.startedAt);
  const providerEndedAtMs = finiteEpochMs(sessionInfo.endedAt);
  if (providerStartedAtMs == null || providerEndedAtMs == null) {
    return { terminal: false, reason: 'gateway-terminal-interval-unavailable' };
  }
  const turnStartedAtMs = input.candidate.startedAt.getTime();
  const leaseExpiresAtMs = input.candidate.leaseExpiresAt.getTime();
  if (
    providerStartedAtMs < turnStartedAtMs
    || providerStartedAtMs > leaseExpiresAtMs
    || providerEndedAtMs < providerStartedAtMs
    || providerEndedAtMs > input.now.getTime()
  ) {
    return { terminal: false, reason: 'gateway-terminal-interval-outside-turn' };
  }
  return {
    terminal: true,
    reason: 'bound-provider-session-terminal-and-quiescent',
    evidence: {
      providerStatus,
      providerStartedAt: new Date(providerStartedAtMs),
      providerEndedAt: new Date(providerEndedAtMs),
    },
  };
}

export interface ProjectChatRestartRecoveryDependencies {
  now(): Date;
  listCandidates(now: Date): Promise<ProjectChatRestartRecoveryCandidate[]>;
  leaseOwnerIsInactive(leaseOwner: string): boolean;
  shouldStop(): boolean;
  hasActiveProcessLocalRun(candidate: ProjectChatRestartRecoveryCandidate): boolean;
  readOpenClawHistory(sessionKey: string): Promise<unknown | null>;
  quiesceNativeOperation(
    candidate: ProjectChatRestartRecoveryCandidate,
  ): Promise<NativeProjectRestartQuiescenceEvidence | null>;
  recover(
    candidate: ProjectChatRestartRecoveryCandidate,
    evidence: OpenClawRestartRecoveryEvidence,
    now: Date,
  ): Promise<void>;
  recoverNative(
    candidate: ProjectChatRestartRecoveryCandidate,
    evidence: NativeProjectRestartQuiescenceEvidence,
    now: Date,
  ): Promise<void>;
}

interface ProjectChatRestartRecoveryCursor {
  leaseExpiresAt: Date;
  id: string;
}

let recoveryCursor: ProjectChatRestartRecoveryCursor | null = null;
let recoveryTimer: NodeJS.Timeout | null = null;
let recoveryInFlight: Promise<void> | null = null;
let recoveryStopped = true;

function leaseOwnerBelongsToDeadLocalPortalProcess(leaseOwnerInput: string): boolean {
  const leaseOwner = String(leaseOwnerInput || '').trim();
  const segments = leaseOwner.split(':');
  if (segments.length < 3) return false;
  const processId = Number(segments.at(-2));
  const host = segments.slice(0, -2).join(':');
  const localHost = process.env.HOSTNAME || 'portal';
  if (
    host !== localHost
    || !Number.isSafeInteger(processId)
    || processId < 2
    || processId === process.pid
  ) {
    return false;
  }
  try {
    process.kill(processId, 0);
    return false;
  } catch (error: any) {
    return error?.code === 'ESRCH';
  }
}

const defaultDependencies: ProjectChatRestartRecoveryDependencies = {
  now: () => new Date(),
  async listCandidates(now) {
    const turns = await prisma.projectChatTurn.findMany({
      where: {
        status: { in: ['RUNNING', 'ABORTING'] },
        leaseExpiresAt: { lte: now },
        ...(recoveryCursor
          ? {
              OR: [
                { leaseExpiresAt: { gt: recoveryCursor.leaseExpiresAt } },
                {
                  leaseExpiresAt: recoveryCursor.leaseExpiresAt,
                  id: { gt: recoveryCursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [
        { leaseExpiresAt: 'asc' },
        { id: 'asc' },
      ],
      take: OPENCLAW_RESTART_RECOVERY_LIMIT,
      include: {
        state: { select: { activeTurnId: true, selectedProvider: true } },
      },
    });
    const last = turns.at(-1);
    recoveryCursor = turns.length === OPENCLAW_RESTART_RECOVERY_LIMIT && last
      ? { leaseExpiresAt: last.leaseExpiresAt, id: last.id }
      : null;
    return turns.map((turn) => ({
      id: turn.id,
      actorUserId: turn.actorUserId,
      projectIdentityId: turn.projectIdentityId,
      provider: turn.provider as ProjectChatPersistedProvider,
      runtime: turn.runtime,
      requestId: turn.requestId,
      leaseOwner: turn.leaseOwner,
      providerSessionId: turn.providerSessionId,
      startedAt: turn.startedAt,
      leaseExpiresAt: turn.leaseExpiresAt,
      resultMetadata: turn.resultMetadata,
      activeTurnId: turn.state.activeTurnId,
      selectedProvider: turn.state.selectedProvider,
    }));
  },
  leaseOwnerIsInactive: leaseOwnerBelongsToDeadLocalPortalProcess,
  shouldStop: () => recoveryStopped,
  hasActiveProcessLocalRun(candidate) {
    const provider = nativeProjectRestartRecoveryTargetProvider(candidate.runtime)
      || (candidate.provider === 'OPENCLAW' ? 'OPENCLAW' : null);
    if (!provider) return false;
    return Boolean(getProjectNativeRunSnapshot({
      userId: candidate.actorUserId,
      projectId: candidate.projectIdentityId,
      provider,
    })?.active);
  },
  async readOpenClawHistory(sessionKey) {
    const result = await gatewayRpcCall('chat.history', {
      sessionKey,
      limit: 1,
    }, OPENCLAW_RESTART_RECOVERY_RPC_TIMEOUT_MS);
    return result.ok ? result.data || null : null;
  },
  quiesceNativeOperation: quiesceNativeProjectOperationAfterRestart,
  async recover(candidate, evidence, now) {
    await recoverExpiredProjectChatTurnAfterProviderTerminal({
      actorUserId: candidate.actorUserId,
      projectIdentityId: candidate.projectIdentityId,
      turnId: candidate.id,
      expectedProvider: 'OPENCLAW',
      expectedRuntime: candidate.runtime,
      expectedLeaseOwner: candidate.leaseOwner,
      providerSessionId: candidate.providerSessionId!,
      providerStatus: evidence.providerStatus,
      providerStartedAt: evidence.providerStartedAt,
      providerEndedAt: evidence.providerEndedAt,
      now,
    });
  },
  async recoverNative(candidate, evidence, now) {
    await recoverExpiredProjectChatOperationAfterNativeQuiescence({
      actorUserId: candidate.actorUserId,
      projectIdentityId: candidate.projectIdentityId,
      turnId: candidate.id,
      expectedSelectedProvider: candidate.provider,
      expectedRuntime: candidate.runtime,
      expectedLeaseOwner: candidate.leaseOwner,
      quiescedProvider: evidence.provider,
      quiescenceBoundary: evidence.boundary,
      quiescenceEvidence: evidence.evidence,
      providerSessionId: candidate.providerSessionId,
      now,
    });
  },
};

export async function reconcileExpiredProjectChatTurnsAfterRestart(
  dependencies: ProjectChatRestartRecoveryDependencies = defaultDependencies,
): Promise<{ inspected: number; recovered: number; quarantined: number }> {
  const now = dependencies.now();
  const candidates = await dependencies.listCandidates(now);
  let inspected = 0;
  let recovered = 0;
  let quarantined = 0;
  for (const candidate of candidates) {
    if (dependencies.shouldStop()) break;
    const runtimeAdmission = candidate.requestId.startsWith(
      PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX,
    );
    const nativeTargetProvider = nativeProjectRestartRecoveryTargetProvider(candidate.runtime);
    if (
      candidate.activeTurnId !== candidate.id
      || candidate.selectedProvider !== candidate.provider
      || !dependencies.leaseOwnerIsInactive(candidate.leaseOwner)
      || dependencies.hasActiveProcessLocalRun(candidate)
    ) {
      quarantined += 1;
      continue;
    }
    if (nativeTargetProvider) {
      if (!runtimeAdmission && (
        candidate.provider !== nativeTargetProvider
        || !candidate.providerSessionId
      )) {
        quarantined += 1;
        continue;
      }
      inspected += 1;
      try {
        const evidence = await dependencies.quiesceNativeOperation(candidate);
        if (dependencies.shouldStop()) break;
        if (!evidence || evidence.provider !== nativeTargetProvider) {
          quarantined += 1;
          continue;
        }
        await dependencies.recoverNative(candidate, evidence, now);
        recovered += 1;
      } catch {
        quarantined += 1;
      }
      continue;
    }
    if (
      runtimeAdmission
      || candidate.provider !== 'OPENCLAW'
      || !candidate.providerSessionId
      || projectChatTurnDispatchStage(candidate) !== PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED
    ) {
      quarantined += 1;
      continue;
    }
    inspected += 1;
    try {
      const historyPayload = await dependencies.readOpenClawHistory(candidate.providerSessionId);
      if (dependencies.shouldStop()) break;
      const attestation = attestOpenClawRestartRecoveryEvidence({
        candidate,
        historyPayload,
        now,
      });
      if (!attestation.terminal || !attestation.evidence) {
        quarantined += 1;
        continue;
      }
      await dependencies.recover(candidate, attestation.evidence, now);
      recovered += 1;
    } catch {
      // One stale/racing candidate must not starve every later expired turn.
      quarantined += 1;
    }
  }
  return { inspected, recovered, quarantined };
}

function scheduleRestartRecovery(delayMs: number): void {
  if (recoveryStopped || recoveryTimer) return;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    if (recoveryStopped) return;
    recoveryInFlight = reconcileExpiredProjectChatTurnsAfterRestart()
      .then((result) => {
        if (result.recovered > 0) {
          console.warn(
            `[Project Chat] Expired ${result.recovered} interrupted operation(s) after exact provider-runtime quiescence.`,
          );
        }
      })
      .catch((error) => {
        console.warn(
          '[Project Chat] Restart recovery pass could not complete:',
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        recoveryInFlight = null;
        scheduleRestartRecovery(OPENCLAW_RESTART_RECOVERY_RETRY_MS);
      });
  }, delayMs);
  recoveryTimer.unref?.();
}

export function initializeProjectChatRestartRecoveryRuntime(): void {
  if (!recoveryStopped) return;
  recoveryStopped = false;
  scheduleRestartRecovery(OPENCLAW_RESTART_RECOVERY_INITIAL_DELAY_MS);
}

export async function shutdownProjectChatRestartRecoveryRuntime(): Promise<void> {
  recoveryStopped = true;
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = null;
  await recoveryInFlight;
}
