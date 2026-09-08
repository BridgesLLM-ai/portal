import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import {
  readPendingUserInput,
  type PendingUserInputSnapshot,
} from '../agents/providers/PersistentGatewayWs';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';
import {
  getProjectNativeRunSnapshot,
  PROJECT_NATIVE_MAX_RUN_TEXT,
} from './projectNativeRunBroker';
import {
  PROJECT_CHAT_ACTIVE_RUN_LEASE_MS,
  PROJECT_CHAT_ACTIVE_RUN_RENEW_INTERVAL_MS,
  PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED,
  PROJECT_CHAT_RUNTIME_ADMISSION_REQUEST_PREFIX,
  createProjectChatProcessLeaseOwner,
  finishProjectChatTurn,
  projectChatTurnDispatchStage,
  reattachExpiredOpenClawProjectChatTurnAfterRestart,
  renewProjectChatTurnLease,
  recoverExpiredProjectChatOperationAfterNativeQuiescence,
  recoverExpiredProjectChatTurnAfterProviderTerminal,
  type ProjectChatOpenClawRestartLeaseGrant,
  type ProjectChatOpenClawRestartRuntimeEvidence,
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
const OPENCLAW_REATTACHED_RUN_POLL_MS = 5_000;
const OPENCLAW_REATTACHED_RUN_WAIT_MS = 25;
const OPENCLAW_RESTART_REPLY_FALLBACK =
  'OpenClaw finished after Portal restarted, but Portal could not recover a trustworthy visible reply. Retry the turn to continue.';
const TERMINAL_OPENCLAW_SESSION_STATUSES = new Set([
  'done',
  'failed',
  'killed',
  'timeout',
]);

export interface ProjectChatRestartRecoveryCandidate {
  id: string;
  actorUserId: string;
  actorAuthorizationVersion: number;
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

export interface OpenClawRestartRunTerminalEvidence {
  source: 'agent-wait' | 'session-terminal';
  providerStatus: 'ok' | 'error' | 'timeout' | 'session-terminal';
  providerStartedAt: Date;
  providerEndedAt: Date;
  terminalReply:
    | { disposition: 'visible'; text: string }
    | { disposition: 'silent' | 'empty'; code?: string }
    | null;
  error: string | null;
  stopReason: string | null;
}

export type OpenClawRestartRunAttestation =
  | { state: 'active'; evidence: ProjectChatOpenClawRestartRuntimeEvidence }
  | { state: 'terminal'; evidence: OpenClawRestartRunTerminalEvidence }
  | { state: 'indeterminate'; reason: string };

export interface OpenClawAgentWaitObservation {
  // OpenClaw 2026.9.1 does not echo runId in AgentWaitResult. Preserve the
  // exact locally requested identity at the RPC boundary instead of pretending
  // an unrelated response field exists.
  requestedRunId: string;
  payload: unknown;
}

function finiteEpochMs(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1_000_000_000_000 ? number : null;
}

function boundedRuntimeIdentifier(value: unknown, maxLength = 128): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized
    && normalized.length <= maxLength
    && !/[\u0000-\u001F\u007F]/.test(normalized)
    ? normalized
    : null;
}

export function attestOpenClawPendingQuestionRestartEvidence(input: {
  candidate: ProjectChatRestartRecoveryCandidate;
  snapshot: PendingUserInputSnapshot;
  now: Date;
}): ProjectChatOpenClawRestartRuntimeEvidence | null {
  if (!input.snapshot.pending) return null;
  const expectedRunId = `portal-${input.candidate.id}`;
  if (
    input.snapshot.runId !== expectedRunId
    || !boundedRuntimeIdentifier(input.snapshot.requestId, 256)
  ) return null;
  if (
    input.snapshot.createdAt !== undefined
    && (
      !Number.isFinite(input.snapshot.createdAt)
      || input.snapshot.createdAt < input.candidate.startedAt.getTime()
      || input.snapshot.createdAt > input.now.getTime()
    )
  ) return null;
  if (
    input.snapshot.expiresAt !== undefined
    && (
      !Number.isFinite(input.snapshot.expiresAt)
      || input.snapshot.expiresAt <= input.now.getTime()
    )
  ) return null;
  return {
    kind: 'pending-question',
    runId: expectedRunId,
    requestId: input.snapshot.requestId,
  };
}

function terminalReplyEvidence(value: unknown): OpenClawRestartRunTerminalEvidence['terminalReply'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const reply = value as Record<string, unknown>;
  if (reply.disposition === 'silent') return { disposition: 'silent' };
  if (reply.disposition === 'empty') {
    return reply.code === 'message-tool-not-called'
      ? { disposition: 'empty', code: 'message-tool-not-called' }
      : { disposition: 'empty' };
  }
  if (reply.disposition !== 'visible' || typeof reply.text !== 'string') return null;
  const text = reply.text.trim();
  if (!text || text.length > PROJECT_NATIVE_MAX_RUN_TEXT || text.includes('\u0000')) return null;
  return { disposition: 'visible', text };
}

/**
 * Bind agent.wait evidence to the exact upstream Project run. An active result
 * is sufficient only to keep a rotated lease alive; terminal materialization
 * additionally requires a bounded run interval that began inside the original
 * lease and ended before this recovery observation.
 */
export function attestOpenClawRestartRunEvidence(input: {
  candidate: ProjectChatRestartRecoveryCandidate;
  observation: OpenClawAgentWaitObservation | null;
  now: Date;
}): OpenClawRestartRunAttestation {
  const payload = input.observation?.payload && typeof input.observation.payload === 'object'
    && !Array.isArray(input.observation.payload)
    ? input.observation.payload as Record<string, unknown>
    : null;
  const expectedRunId = `portal-${input.candidate.id}`;
  if (
    !payload
    || input.observation?.requestedRunId !== expectedRunId
    || (payload.runId !== undefined && payload.runId !== expectedRunId)
  ) {
    return { state: 'indeterminate', reason: 'gateway-run-identity-mismatch' };
  }
  const status = String(payload.status || '').trim().toLowerCase();
  const endedAtMs = finiteEpochMs(payload.endedAt);
  if (
    status === 'pending'
    || (
      status === 'timeout'
      && endedAtMs == null
      && payload.providerStarted !== false
      && String(payload.timeoutPhase || '') !== 'preflight'
    )
  ) {
    return {
      state: 'active',
      evidence: { kind: 'active-run', runId: expectedRunId },
    };
  }
  if (!['ok', 'error', 'timeout'].includes(status) || endedAtMs == null) {
    return { state: 'indeterminate', reason: 'gateway-run-not-authoritatively-terminal' };
  }
  const startedAtMs = finiteEpochMs(payload.startedAt);
  if (
    startedAtMs == null
    || startedAtMs < input.candidate.startedAt.getTime()
    || startedAtMs > input.candidate.leaseExpiresAt.getTime()
    || endedAtMs < startedAtMs
    || endedAtMs > input.now.getTime()
  ) {
    return { state: 'indeterminate', reason: 'gateway-run-terminal-interval-mismatch' };
  }
  const providerStatus = status as OpenClawRestartRunTerminalEvidence['providerStatus'];
  return {
    state: 'terminal',
    evidence: {
      source: 'agent-wait',
      providerStatus,
      providerStartedAt: new Date(startedAtMs),
      providerEndedAt: new Date(endedAtMs),
      terminalReply: terminalReplyEvidence(payload.terminalReply),
      error: typeof payload.error === 'string' && payload.error.trim()
        ? 'OpenClaw reported a terminal provider error.'
        : null,
      stopReason: boundedRuntimeIdentifier(payload.stopReason, 64),
    },
  };
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
  readOpenClawPendingInput(
    sessionKey: string,
    runId: string,
  ): Promise<PendingUserInputSnapshot>;
  readOpenClawRun(runId: string): Promise<OpenClawAgentWaitObservation | null>;
  readOpenClawHistory(sessionKey: string): Promise<unknown | null>;
  reattachOpenClawRun(
    candidate: ProjectChatRestartRecoveryCandidate,
    evidence: ProjectChatOpenClawRestartRuntimeEvidence,
    now: Date,
  ): Promise<ProjectChatOpenClawRestartLeaseGrant>;
  settleReattachedOpenClawRun(
    candidate: ProjectChatRestartRecoveryCandidate,
    grant: ProjectChatOpenClawRestartLeaseGrant,
    evidence: OpenClawRestartRunTerminalEvidence,
    now: Date,
  ): Promise<void>;
  trackReattachedOpenClawRun(
    candidate: ProjectChatRestartRecoveryCandidate,
    grant: ProjectChatOpenClawRestartLeaseGrant,
  ): void;
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

export interface ReattachedOpenClawRunMonitorDependencies {
  now(): Date;
  readPendingInput(sessionKey: string, runId: string): Promise<PendingUserInputSnapshot>;
  readRun(runId: string): Promise<OpenClawAgentWaitObservation | null>;
  readHistory(sessionKey: string): Promise<unknown | null>;
  reattach(
    candidate: ProjectChatRestartRecoveryCandidate,
    grant: ProjectChatOpenClawRestartLeaseGrant,
    evidence: ProjectChatOpenClawRestartRuntimeEvidence,
    now: Date,
  ): Promise<ProjectChatOpenClawRestartLeaseGrant>;
  renew(
    candidate: ProjectChatRestartRecoveryCandidate,
    grant: ProjectChatOpenClawRestartLeaseGrant,
    now: Date,
  ): Promise<void>;
  settle(
    candidate: ProjectChatRestartRecoveryCandidate,
    grant: ProjectChatOpenClawRestartLeaseGrant,
    evidence: OpenClawRestartRunTerminalEvidence,
    now: Date,
  ): Promise<void>;
}

interface ReattachedOpenClawRunMonitor {
  candidate: ProjectChatRestartRecoveryCandidate;
  grant: ProjectChatOpenClawRestartLeaseGrant;
  nextRenewAt: number;
  timer: NodeJS.Timeout;
  inFlight: Promise<void> | null;
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

export function attestOpenClawActiveRunFromHistory(input: {
  candidate: ProjectChatRestartRecoveryCandidate;
  historyPayload: unknown;
}): ProjectChatOpenClawRestartRuntimeEvidence | null {
  const payload = input.historyPayload && typeof input.historyPayload === 'object'
    && !Array.isArray(input.historyPayload)
    ? input.historyPayload as Record<string, unknown>
    : null;
  const sessionInfo = payload?.sessionInfo && typeof payload.sessionInfo === 'object'
    && !Array.isArray(payload.sessionInfo)
    ? payload.sessionInfo as Record<string, unknown>
    : null;
  const expectedSessionKey = String(input.candidate.providerSessionId || '').trim();
  const expectedRunId = `portal-${input.candidate.id}`;
  const runIds = Array.isArray(sessionInfo?.activeRunIds)
    ? sessionInfo.activeRunIds.filter((value): value is string => typeof value === 'string')
    : [];
  if (
    !payload
    || !sessionInfo
    || !expectedSessionKey
    || payload.sessionKey !== expectedSessionKey
    || sessionInfo.key !== expectedSessionKey
    || sessionInfo.hasActiveRun !== true
    || runIds.length !== 1
    || runIds[0] !== expectedRunId
  ) return null;
  return { kind: 'active-run', runId: expectedRunId };
}

async function readOpenClawRunSnapshot(runId: string): Promise<OpenClawAgentWaitObservation | null> {
  const result = await gatewayRpcCall('agent.wait', {
    runId,
    timeoutMs: OPENCLAW_REATTACHED_RUN_WAIT_MS,
  }, OPENCLAW_RESTART_RECOVERY_RPC_TIMEOUT_MS);
  return result.ok ? { requestedRunId: runId, payload: result.data || null } : null;
}

async function settleReattachedOpenClawRun(
  candidate: ProjectChatRestartRecoveryCandidate,
  grant: ProjectChatOpenClawRestartLeaseGrant,
  evidence: OpenClawRestartRunTerminalEvidence,
  now: Date,
): Promise<void> {
  const reply = evidence.terminalReply;
  const completed = evidence.source === 'agent-wait'
    && evidence.providerStatus === 'ok'
    && reply !== null;
  const content = completed && reply?.disposition === 'visible'
    ? reply.text
    : completed && reply?.disposition === 'silent'
      ? 'OpenClaw completed this recovered turn without a visible reply.'
      : completed && reply?.disposition === 'empty'
        ? 'OpenClaw completed this recovered turn, but returned no visible reply.'
        : OPENCLAW_RESTART_REPLY_FALLBACK;
  await finishProjectChatTurn({
    actorUserId: candidate.actorUserId,
    projectIdentityId: candidate.projectIdentityId,
    turnId: candidate.id,
    leaseToken: grant.leaseToken,
    status: completed ? 'COMPLETED' : 'ERROR',
    providerSessionId: candidate.providerSessionId,
    assistantProjection: {
      sessionKey: candidate.providerSessionId!,
      messageId: `project-turn:${candidate.id}`,
      content,
    },
    resultMetadata: {
      restartRunRecoveryVersion: 1,
      restartRunRecoverySource: evidence.source,
      restartRunId: `portal-${candidate.id}`,
      restartRunProviderStatus: evidence.providerStatus,
      restartRunProviderStartedAt: evidence.providerStartedAt.toISOString(),
      restartRunProviderEndedAt: evidence.providerEndedAt.toISOString(),
      restartRunTerminalReplyDisposition: reply?.disposition || 'unavailable',
      restartRunStopReason: evidence.stopReason,
      durableEventCount: grant.turn.lastEventSeq,
      providerDispatchStage: PROJECT_CHAT_DISPATCH_STAGE_ACCEPTED,
      presentationMaterialized: true,
    } as Prisma.InputJsonValue,
    errorCode: completed ? null : 'PORTAL_RESTART_OPENCLAW_REPLY_UNAVAILABLE',
    errorMessage: completed ? null : OPENCLAW_RESTART_REPLY_FALLBACK,
    handoff: {
      provider: 'OPENCLAW',
      expectedCursor: grant.expectedHandoffCursor,
      expectedHandoffVersion: grant.expectedHandoffVersion,
    },
    now,
  });
}

async function renewReattachedOpenClawRun(
  candidate: ProjectChatRestartRecoveryCandidate,
  grant: ProjectChatOpenClawRestartLeaseGrant,
  now: Date,
): Promise<void> {
  grant.turn = await renewProjectChatTurnLease({
    actorUserId: candidate.actorUserId,
    projectIdentityId: candidate.projectIdentityId,
    turnId: candidate.id,
    leaseToken: grant.leaseToken,
    leaseDurationMs: PROJECT_CHAT_ACTIVE_RUN_LEASE_MS,
    providerSessionId: candidate.providerSessionId,
    now,
  });
}

async function reattachOpenClawRunLease(
  candidate: ProjectChatRestartRecoveryCandidate,
  expectedLeaseOwner: string,
  evidence: ProjectChatOpenClawRestartRuntimeEvidence,
  now: Date,
): Promise<ProjectChatOpenClawRestartLeaseGrant> {
  return reattachExpiredOpenClawProjectChatTurnAfterRestart({
    actorUserId: candidate.actorUserId,
    actorAuthorizationVersion: candidate.actorAuthorizationVersion,
    projectIdentityId: candidate.projectIdentityId,
    turnId: candidate.id,
    expectedRuntime: candidate.runtime,
    expectedLeaseOwner,
    newLeaseOwner: createProjectChatProcessLeaseOwner(),
    providerSessionId: candidate.providerSessionId!,
    runtimeEvidence: evidence,
    leaseDurationMs: PROJECT_CHAT_ACTIVE_RUN_LEASE_MS,
    now,
  });
}

const defaultMonitorDependencies: ReattachedOpenClawRunMonitorDependencies = {
  now: () => new Date(),
  readPendingInput: readPendingUserInput,
  readRun: readOpenClawRunSnapshot,
  async readHistory(sessionKey) {
    const result = await gatewayRpcCall('chat.history', {
      sessionKey,
      limit: 1,
    }, OPENCLAW_RESTART_RECOVERY_RPC_TIMEOUT_MS);
    return result.ok ? result.data || null : null;
  },
  async reattach(candidate, grant, evidence, now) {
    return reattachOpenClawRunLease(
      candidate,
      grant.turn.leaseOwner,
      evidence,
      now,
    );
  },
  renew: renewReattachedOpenClawRun,
  settle: settleReattachedOpenClawRun,
};

export async function inspectReattachedOpenClawProjectRun(
  monitor: Pick<ReattachedOpenClawRunMonitor, 'candidate' | 'grant' | 'nextRenewAt'>,
  dependencies: ReattachedOpenClawRunMonitorDependencies = defaultMonitorDependencies,
): Promise<'active' | 'settled' | 'indeterminate'> {
  const now = dependencies.now();
  const runId = `portal-${monitor.candidate.id}`;
  const preserveExactActiveRun = async (
    evidence: ProjectChatOpenClawRestartRuntimeEvidence,
  ): Promise<void> => {
    if (monitor.grant.turn.leaseExpiresAt.getTime() <= now.getTime()) {
      monitor.grant = await dependencies.reattach(
        monitor.candidate,
        monitor.grant,
        evidence,
        now,
      );
      monitor.nextRenewAt = now.getTime() + PROJECT_CHAT_ACTIVE_RUN_RENEW_INTERVAL_MS;
      return;
    }
    if (now.getTime() >= monitor.nextRenewAt) {
      await dependencies.renew(monitor.candidate, monitor.grant, now);
      monitor.nextRenewAt = now.getTime() + PROJECT_CHAT_ACTIVE_RUN_RENEW_INTERVAL_MS;
    }
  };
  const preserveTerminalSettlement = async (
    evidence: ProjectChatOpenClawRestartRuntimeEvidence,
  ): Promise<void> => {
    if (monitor.grant.turn.leaseExpiresAt.getTime() > now.getTime()) return;
    monitor.grant = await dependencies.reattach(
      monitor.candidate,
      monitor.grant,
      evidence,
      now,
    );
    monitor.nextRenewAt = now.getTime() + PROJECT_CHAT_ACTIVE_RUN_RENEW_INTERVAL_MS;
  };
  let pendingSnapshot: PendingUserInputSnapshot | null = null;
  try {
    pendingSnapshot = await dependencies.readPendingInput(
      monitor.candidate.providerSessionId!,
      runId,
    );
  } catch {
    pendingSnapshot = null;
  }
  const pendingEvidence = pendingSnapshot
    ? attestOpenClawPendingQuestionRestartEvidence({
        candidate: monitor.candidate,
        snapshot: pendingSnapshot,
        now,
      })
    : null;
  if (pendingEvidence) {
    await preserveExactActiveRun(pendingEvidence);
    return 'active';
  }

  let runObservation: OpenClawAgentWaitObservation | null = null;
  try {
    runObservation = await dependencies.readRun(runId);
  } catch {
    runObservation = null;
  }
  const runAttestation = attestOpenClawRestartRunEvidence({
    candidate: monitor.candidate,
    observation: runObservation,
    now,
  });
  if (runAttestation.state === 'terminal') {
    await preserveTerminalSettlement({
      kind: 'terminal-run',
      runId,
      providerStatus: runAttestation.evidence.providerStatus,
      providerStartedAt: runAttestation.evidence.providerStartedAt,
      providerEndedAt: runAttestation.evidence.providerEndedAt,
    });
    await dependencies.settle(monitor.candidate, monitor.grant, runAttestation.evidence, now);
    return 'settled';
  }
  if (runAttestation.state === 'active') {
    await preserveExactActiveRun(runAttestation.evidence);
    return 'active';
  }

  let historyPayload: unknown | null = null;
  try {
    historyPayload = await dependencies.readHistory(monitor.candidate.providerSessionId!);
  } catch {
    historyPayload = null;
  }
  const activeHistoryEvidence = attestOpenClawActiveRunFromHistory({
    candidate: monitor.candidate,
    historyPayload,
  });
  if (activeHistoryEvidence) {
    await preserveExactActiveRun(activeHistoryEvidence);
    return 'active';
  }
  const terminalHistory = attestOpenClawRestartRecoveryEvidence({
    candidate: monitor.candidate,
    historyPayload,
    now,
  });
  if (terminalHistory.terminal && terminalHistory.evidence) {
    await preserveTerminalSettlement({
      kind: 'terminal-session',
      runId,
      providerStatus: terminalHistory.evidence.providerStatus,
      providerStartedAt: terminalHistory.evidence.providerStartedAt,
      providerEndedAt: terminalHistory.evidence.providerEndedAt,
    });
    await dependencies.settle(monitor.candidate, monitor.grant, {
      source: 'session-terminal',
      providerStatus: 'session-terminal',
      providerStartedAt: terminalHistory.evidence.providerStartedAt,
      providerEndedAt: terminalHistory.evidence.providerEndedAt,
      terminalReply: null,
      error: null,
      stopReason: null,
    }, now);
    return 'settled';
  }
  return 'indeterminate';
}

const reattachedOpenClawRuns = new Map<string, ReattachedOpenClawRunMonitor>();

function stopReattachedOpenClawRunMonitor(turnId: string): Promise<void> | null {
  const monitor = reattachedOpenClawRuns.get(turnId);
  if (!monitor) return null;
  reattachedOpenClawRuns.delete(turnId);
  clearInterval(monitor.timer);
  return monitor.inFlight;
}

function trackReattachedOpenClawRun(
  candidate: ProjectChatRestartRecoveryCandidate,
  grant: ProjectChatOpenClawRestartLeaseGrant,
): void {
  void stopReattachedOpenClawRunMonitor(candidate.id);
  const monitor: ReattachedOpenClawRunMonitor = {
    candidate,
    grant,
    nextRenewAt: Date.now() + PROJECT_CHAT_ACTIVE_RUN_RENEW_INTERVAL_MS,
    timer: null as unknown as NodeJS.Timeout,
    inFlight: null,
  };
  monitor.timer = setInterval(() => {
    if (monitor.inFlight || recoveryStopped) return;
    monitor.inFlight = inspectReattachedOpenClawProjectRun(monitor)
      .then((state) => {
        if (state === 'settled') void stopReattachedOpenClawRunMonitor(candidate.id);
      })
      .catch((error) => {
        console.warn(
          `[Project Chat] Reattached OpenClaw run ${candidate.id} could not be inspected:`,
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        monitor.inFlight = null;
      });
  }, OPENCLAW_REATTACHED_RUN_POLL_MS);
  monitor.timer.unref?.();
  reattachedOpenClawRuns.set(candidate.id, monitor);
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
      actorAuthorizationVersion: turn.actorAuthorizationVersion,
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
  readOpenClawPendingInput: readPendingUserInput,
  readOpenClawRun: readOpenClawRunSnapshot,
  async readOpenClawHistory(sessionKey) {
    const result = await gatewayRpcCall('chat.history', {
      sessionKey,
      limit: 1,
    }, OPENCLAW_RESTART_RECOVERY_RPC_TIMEOUT_MS);
    return result.ok ? result.data || null : null;
  },
  async reattachOpenClawRun(candidate, evidence, now) {
    return reattachOpenClawRunLease(candidate, candidate.leaseOwner, evidence, now);
  },
  settleReattachedOpenClawRun,
  trackReattachedOpenClawRun,
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
): Promise<{ inspected: number; recovered: number; reattached: number; quarantined: number }> {
  const now = dependencies.now();
  const candidates = await dependencies.listCandidates(now);
  let inspected = 0;
  let recovered = 0;
  let reattached = 0;
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
      const runId = `portal-${candidate.id}`;
      let pendingSnapshot: PendingUserInputSnapshot | null = null;
      try {
        pendingSnapshot = await dependencies.readOpenClawPendingInput(
          candidate.providerSessionId,
          runId,
        );
      } catch {
        pendingSnapshot = null;
      }
      if (dependencies.shouldStop()) break;
      const pendingEvidence = pendingSnapshot
        ? attestOpenClawPendingQuestionRestartEvidence({ candidate, snapshot: pendingSnapshot, now })
        : null;
      if (pendingEvidence) {
        const grant = await dependencies.reattachOpenClawRun(candidate, pendingEvidence, now);
        dependencies.trackReattachedOpenClawRun(candidate, grant);
        reattached += 1;
        continue;
      }

      let runObservation: OpenClawAgentWaitObservation | null = null;
      try {
        runObservation = await dependencies.readOpenClawRun(runId);
      } catch {
        runObservation = null;
      }
      if (dependencies.shouldStop()) break;
      const runAttestation = attestOpenClawRestartRunEvidence({
        candidate,
        observation: runObservation,
        now,
      });
      if (runAttestation.state === 'active') {
        const grant = await dependencies.reattachOpenClawRun(
          candidate,
          runAttestation.evidence,
          now,
        );
        dependencies.trackReattachedOpenClawRun(candidate, grant);
        reattached += 1;
        continue;
      }
      if (runAttestation.state === 'terminal') {
        const grant = await dependencies.reattachOpenClawRun(candidate, {
          kind: 'terminal-run',
          runId,
          providerStatus: runAttestation.evidence.providerStatus,
          providerStartedAt: runAttestation.evidence.providerStartedAt,
          providerEndedAt: runAttestation.evidence.providerEndedAt,
        }, now);
        await dependencies.settleReattachedOpenClawRun(
          candidate,
          grant,
          runAttestation.evidence,
          now,
        );
        recovered += 1;
        continue;
      }

      const historyPayload = await dependencies.readOpenClawHistory(candidate.providerSessionId);
      if (dependencies.shouldStop()) break;
      const activeHistoryEvidence = attestOpenClawActiveRunFromHistory({
        candidate,
        historyPayload,
      });
      if (activeHistoryEvidence) {
        const grant = await dependencies.reattachOpenClawRun(
          candidate,
          activeHistoryEvidence,
          now,
        );
        dependencies.trackReattachedOpenClawRun(candidate, grant);
        reattached += 1;
        continue;
      }
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
  return { inspected, recovered, reattached, quarantined };
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
        if (result.reattached > 0) {
          console.warn(
            `[Project Chat] Reattached ${result.reattached} exact OpenClaw run(s) after Portal restart.`,
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
  const monitorWork = [...reattachedOpenClawRuns.keys()]
    .map((turnId) => stopReattachedOpenClawRunMonitor(turnId))
    .filter((work): work is Promise<void> => Boolean(work));
  await Promise.allSettled([
    ...(recoveryInFlight ? [recoveryInFlight] : []),
    ...monitorWork,
  ]);
}
