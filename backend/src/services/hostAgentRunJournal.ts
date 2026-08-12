import crypto from 'crypto';
import path from 'path';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { prisma } from '../config/database';
import {
  createHostAgentRunActivationGate,
  HOST_AGENT_RUN_ACTIVATION_WRAPPER_SOURCE,
  HOST_AGENT_RUN_RUNTIME_ROOT,
  initializeHostAgentRunGateStorage,
  removePersistedHostAgentRunGate,
  type HostAgentRunActivationGate,
} from './hostAgentRunActivationGate';
import {
  SystemdHostRunBoundaryError,
  systemdHostRunBoundary,
  type SystemdHostRunScopeReservation,
  type SystemdHostRunStopProof,
} from './systemdHostRunBoundary';

const ACTIVE_HOST_RUN_STATUSES = ['PREPARED', 'SPAWNED', 'DISPATCHED', 'QUARANTINED'] as const;
const HOST_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const PROVIDER_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SCOPE_UNIT_PATTERN = /^bridgesllm-host-agent-([0-9a-f]{32})\.scope$/;
const SCOPE_TAG_PATTERN = /^[0-9a-f]{64}$/;
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVOCATION_ID_PATTERN = /^[0-9a-f]{32}$/;
const DESCRIPTION_PREFIX = 'BridgesLLM host agent run tag=';

type ActiveHostRunStatus = typeof ACTIVE_HOST_RUN_STATUSES[number];
export type HostAgentRunTerminalStatus = 'COMPLETED' | 'ABORTED' | 'ERROR' | 'RECOVERED';

export interface HostAgentRunHandle {
  id: string;
  actorUserId: string;
  actorAuthorizationVersion: number;
  provider: string;
  sessionId: string;
}

export type BeginHostAgentRunInput = HostAgentRunHandle;

interface PersistedHostAgentRunReservation extends SystemdHostRunScopeReservation {
  gatePath: string;
}

interface PersistedHostAgentRunIdentity extends PersistedHostAgentRunReservation {
  invocationId: string;
}

interface HostAgentRunRow extends HostAgentRunHandle {
  portalInstanceId: string;
  status: string;
  attempt: number;
  scopeUnit: string | null;
  scopeTag: string | null;
  bootId: string | null;
  controlGroup: string | null;
  gatePath: string | null;
  scopeInvocationId: string | null;
  launcherPid: number | null;
  dispatchActivatedAt: Date | null;
  settledAt: Date | null;
  terminalReason: string | null;
  evidence: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReservedHostAgentRunAttempt extends PersistedHostAgentRunReservation {
  attempt: number;
}

export interface GatedHostAgentRunAttempt {
  child: ChildProcess;
  identity: PersistedHostAgentRunIdentity;
  attempt: number;
}

export interface SpawnGatedHostAgentRunAttemptInput {
  handle: HostAgentRunHandle;
  reservation: ReservedHostAgentRunAttempt;
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

export interface HostAgentRunQuiescence {
  runCount: number;
  inMemoryAbortCount: number;
  persistedRuntimeSignalCount: number;
  recoveredCount: number;
}

export class HostAgentRunJournalError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'HostAgentRunJournalError';
  }
}

const portalInstanceId = `${process.pid}-${crypto.randomUUID()}`;
const runtimeRoot = HOST_AGENT_RUN_RUNTIME_ROOT;
const inMemoryAborters = new Map<string, () => Promise<boolean>>();
const activeGates = new Map<string, HostAgentRunActivationGate>();
const activeOperations = new Set<Promise<unknown>>();
let startupPromise: Promise<{ recovered: number; quarantined: number; signaled: number }> | null = null;
let shuttingDown = false;

function trackOperation<T>(operation: Promise<T>): Promise<T> {
  activeOperations.add(operation);
  operation.then(
    () => activeOperations.delete(operation),
    () => activeOperations.delete(operation),
  );
  return operation;
}

function gateKey(runId: string, attempt: number): string {
  return `${runId}\0${attempt}`;
}

function validateHandle(input: HostAgentRunHandle): void {
  if (!HOST_RUN_ID_PATTERN.test(input.id)) {
    throw new HostAgentRunJournalError('Host agent run identity is invalid', 400, 'HOST_RUN_ID_INVALID');
  }
  if (!input.actorUserId.trim() || input.actorUserId.length > 255) {
    throw new HostAgentRunJournalError('Host agent actor identity is invalid', 400, 'HOST_RUN_ACTOR_INVALID');
  }
  if (
    !Number.isSafeInteger(input.actorAuthorizationVersion)
    || input.actorAuthorizationVersion < 1
  ) {
    throw new HostAgentRunJournalError(
      'Host agent authorization generation is invalid',
      400,
      'AUTHORIZATION_VERSION_INVALID',
    );
  }
  if (!PROVIDER_PATTERN.test(input.provider)) {
    throw new HostAgentRunJournalError('Host agent provider identity is invalid', 400, 'HOST_RUN_PROVIDER_INVALID');
  }
  if (!input.sessionId.trim() || input.sessionId.length > 2_048 || input.sessionId.includes('\0')) {
    throw new HostAgentRunJournalError('Host agent session identity is invalid', 400, 'HOST_RUN_SESSION_INVALID');
  }
}

function sameHandle(row: HostAgentRunRow, handle: HostAgentRunHandle): boolean {
  return row.id === handle.id
    && row.actorUserId === handle.actorUserId
    && row.actorAuthorizationVersion === handle.actorAuthorizationVersion
    && row.provider === handle.provider
    && row.sessionId === handle.sessionId;
}

function descriptionForTag(scopeTag: string): string {
  return `${DESCRIPTION_PREFIX}${scopeTag}`;
}

function reservationFromRow(row: HostAgentRunRow): PersistedHostAgentRunReservation | null {
  const scopeUnitMatch = typeof row.scopeUnit === 'string'
    ? row.scopeUnit.match(SCOPE_UNIT_PATTERN)
    : null;
  if (
    !Number.isSafeInteger(row.attempt)
    || row.attempt < 1
    || !scopeUnitMatch
    || typeof row.scopeTag !== 'string'
    || !SCOPE_TAG_PATTERN.test(row.scopeTag)
    || typeof row.bootId !== 'string'
    || !BOOT_ID_PATTERN.test(row.bootId)
    || typeof row.controlGroup !== 'string'
    || row.controlGroup !== `/system.slice/${row.scopeUnit}`
    || typeof row.gatePath !== 'string'
  ) {
    return null;
  }
  const expectedGatePath = `${HOST_AGENT_RUN_RUNTIME_ROOT}/gate-${scopeUnitMatch[1]}.sock`;
  if (row.gatePath !== expectedGatePath) return null;
  return {
    scopeUnit: scopeUnitMatch[0],
    scopeTag: row.scopeTag,
    description: descriptionForTag(row.scopeTag),
    bootId: row.bootId,
    controlGroup: row.controlGroup,
    gatePath: row.gatePath,
  };
}

function identityFromRow(row: HostAgentRunRow): PersistedHostAgentRunIdentity | null {
  const reservation = reservationFromRow(row);
  if (
    !reservation
    || typeof row.scopeInvocationId !== 'string'
    || !INVOCATION_ID_PATTERN.test(row.scopeInvocationId)
  ) {
    return null;
  }
  return {
    ...reservation,
    invocationId: row.scopeInvocationId,
  };
}

function rowMatchesReservation(
  row: HostAgentRunRow,
  reservation: ReservedHostAgentRunAttempt,
): boolean {
  return row.attempt === reservation.attempt
    && row.scopeUnit === reservation.scopeUnit
    && row.scopeTag === reservation.scopeTag
    && row.bootId === reservation.bootId
    && row.controlGroup === reservation.controlGroup
    && row.gatePath === reservation.gatePath;
}

function stopEvidence(
  proof: SystemdHostRunStopProof | null,
  bootChanged: boolean,
): Record<string, unknown> {
  if (bootChanged) {
    return {
      bootChanged: true,
      exactCleanupConfirmed: true,
      stopRequested: false,
    };
  }
  return {
    bootChanged: false,
    exactCleanupConfirmed: proof?.cgroupEmpty === true,
    stopRequested: proof?.stopRequested === true,
    scopeUnit: proof?.scopeUnit || null,
    invocationId: proof?.invocationId || null,
    bootId: proof?.bootId || null,
    finalLoadState: proof?.finalLoadState || null,
    finalActiveState: proof?.finalActiveState || null,
    finalSubState: proof?.finalSubState || null,
  };
}

async function abortGateForRow(row: HostAgentRunRow): Promise<void> {
  if (row.attempt < 1) return;
  const reservation = reservationFromRow(row);
  if (!reservation) {
    throw new HostAgentRunJournalError(
      'Host agent activation gate identity is malformed',
      503,
      'HOST_RUN_SCOPE_IDENTITY_INVALID',
    );
  }
  const key = gateKey(row.id, row.attempt);
  const gate = activeGates.get(key);
  if (gate) {
    activeGates.delete(key);
    await gate.abort();
  }
  removePersistedHostAgentRunGate(
    reservation.gatePath,
    reservation.scopeUnit,
    reservation.scopeTag,
  );
}

async function stopPersistedBoundary(row: HostAgentRunRow): Promise<{
  clean: true;
  signaled: boolean;
  bootChanged: boolean;
  proof: SystemdHostRunStopProof | null;
}> {
  if (row.attempt === 0) {
    if (
      row.scopeUnit !== null
      || row.scopeTag !== null
      || row.bootId !== null
      || row.controlGroup !== null
      || row.gatePath !== null
      || row.scopeInvocationId !== null
    ) {
      throw new HostAgentRunJournalError(
        'Host agent unlaunched reservation identity is malformed',
        503,
        'HOST_RUN_SCOPE_IDENTITY_INVALID',
      );
    }
    return { clean: true, signaled: false, bootChanged: false, proof: null };
  }

  const reservation = reservationFromRow(row);
  if (!reservation) {
    throw new HostAgentRunJournalError(
      'Host agent systemd scope reservation is malformed',
      503,
      'HOST_RUN_SCOPE_IDENTITY_INVALID',
    );
  }

  const sameBoot = await systemdHostRunBoundary.sameBoot(reservation.bootId);
  if (!sameBoot) {
    // Reboot is complete process-settlement proof. A stale socket inode is not
    // execution authority and must not cause us to inspect or signal a unit
    // name that may now be reusable on the new boot.
    try {
      await abortGateForRow(row);
    } catch {}
    return { clean: true, signaled: false, bootChanged: true, proof: null };
  }
  await abortGateForRow(row);

  try {
    let identity = identityFromRow(row);
    if (!identity) {
      if (row.scopeInvocationId !== null) {
        throw new HostAgentRunJournalError(
          'Host agent systemd scope invocation identity is malformed',
          503,
          'HOST_RUN_SCOPE_IDENTITY_INVALID',
        );
      }
      const snapshot = await systemdHostRunBoundary.inspect(reservation.scopeUnit);
      if (snapshot.installed) {
        if (
          snapshot.loadState !== 'loaded'
          || snapshot.description !== reservation.description
          || snapshot.controlGroup !== reservation.controlGroup
          || snapshot.killMode !== 'control-group'
          || !snapshot.invocationId
          || !INVOCATION_ID_PATTERN.test(snapshot.invocationId)
        ) {
          throw new HostAgentRunJournalError(
            'Host agent systemd scope reservation no longer matches',
            503,
            'HOST_RUN_SCOPE_IDENTITY_MISMATCH',
          );
        }
        identity = { ...reservation, invocationId: snapshot.invocationId };
      } else {
        // The invocation is irrelevant while the unit is absent. stop() still
        // proves the exact derived cgroup absent/empty and will refuse to
        // signal if a unit appears or is reused between this read and control.
        identity = { ...reservation, invocationId: '0'.repeat(32) };
      }
    }
    const proof = await systemdHostRunBoundary.stop(identity);
    return {
      clean: true,
      signaled: proof.stopRequested,
      bootChanged: false,
      proof,
    };
  } catch (error) {
    // A reboot between the first boot read and systemd/cgroup inspection is a
    // complete proof that the old local process no longer exists.
    if (!(await systemdHostRunBoundary.sameBoot(reservation.bootId))) {
      return { clean: true, signaled: false, bootChanged: true, proof: null };
    }
    throw error;
  }
}

async function markRecovered(
  row: HostAgentRunRow,
  evidence: Record<string, unknown>,
): Promise<boolean> {
  const settledAt = new Date();
  const result = await (prisma as any).hostAgentRun.updateMany({
    where: {
      id: row.id,
      status: { in: [...ACTIVE_HOST_RUN_STATUSES] },
      attempt: row.attempt,
    },
    data: {
      status: 'RECOVERED',
      settledAt,
      terminalReason: 'Portal recovered an unfinished host-native run.',
      evidence,
    },
  });
  return result.count === 1;
}

async function markQuarantined(
  row: HostAgentRunRow,
  evidence: Record<string, unknown>,
): Promise<void> {
  try {
    await abortGateForRow(row);
  } catch {
    // Preserve the original proof failure below. A drifted gate is itself a
    // reason the row must remain quarantined.
  }
  await (prisma as any).hostAgentRun.updateMany({
    where: {
      id: row.id,
      status: { in: [...ACTIVE_HOST_RUN_STATUSES] },
      attempt: row.attempt,
    },
    data: {
      status: 'QUARANTINED',
      settledAt: null,
      terminalReason: 'Exact host-native systemd scope cleanup could not be proven.',
      evidence,
    },
  });
}

async function recoverRow(
  row: HostAgentRunRow,
  reason: 'startup' | 'authorization_transition' | 'project_dependency_promotion' | 'shutdown',
): Promise<{ recovered: boolean; quarantined: boolean; signaled: boolean }> {
  try {
    const termination = await stopPersistedBoundary(row);
    const recovered = await markRecovered(row, {
      reason,
      priorStatus: row.status,
      priorAttempt: row.attempt,
      ...stopEvidence(termination.proof, termination.bootChanged),
      recoveredAt: new Date().toISOString(),
      portalInstanceId,
    });
    return {
      recovered,
      quarantined: false,
      signaled: termination.signaled,
    };
  } catch (error) {
    await markQuarantined(row, {
      reason,
      priorStatus: row.status,
      priorAttempt: row.attempt,
      exactCleanupConfirmed: false,
      boundaryErrorCode: error instanceof SystemdHostRunBoundaryError
        ? error.code
        : error instanceof HostAgentRunJournalError
          ? error.code
          : 'HOST_RUN_SCOPE_SETTLEMENT_UNPROVEN',
      attemptedAt: new Date().toISOString(),
      portalInstanceId,
    });
    return { recovered: false, quarantined: true, signaled: false };
  }
}

export function initializeHostAgentRunStorage(): string {
  return initializeHostAgentRunGateStorage();
}

export async function reconcilePersistedHostAgentRuns(): Promise<{
  recovered: number;
  quarantined: number;
  signaled: number;
}> {
  const rows = await (prisma as any).hostAgentRun.findMany({
    where: { status: { in: [...ACTIVE_HOST_RUN_STATUSES] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  }) as HostAgentRunRow[];
  let recovered = 0;
  let quarantined = 0;
  let signaled = 0;
  for (const row of rows) {
    const result = await recoverRow(row, 'startup');
    if (result.recovered) recovered += 1;
    if (result.quarantined) quarantined += 1;
    if (result.signaled) signaled += 1;
  }
  if (quarantined > 0) {
    throw new HostAgentRunJournalError(
      `${quarantined} unfinished host-native run(s) could not be recovered safely`,
      503,
      'HOST_RUN_RECOVERY_UNPROVEN',
    );
  }
  return { recovered, quarantined, signaled };
}

export async function initializeHostAgentRunRuntime(): Promise<{
  recovered: number;
  quarantined: number;
  signaled: number;
}> {
  if (shuttingDown) {
    throw new HostAgentRunJournalError(
      'Host agent runtime is shutting down',
      503,
      'HOST_RUN_RUNTIME_SHUTTING_DOWN',
    );
  }
  initializeHostAgentRunStorage();
  if (!startupPromise) {
    startupPromise = reconcilePersistedHostAgentRuns().catch((error) => {
      startupPromise = null;
      throw error;
    });
  }
  return startupPromise;
}

async function assertActorAndTransition(
  transaction: any,
  handle: HostAgentRunHandle,
): Promise<void> {
  const [actor, transition] = await Promise.all([
    transaction.user.findUnique({
      where: { id: handle.actorUserId },
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
  ]);
  if (transition) {
    throw new HostAgentRunJournalError(
      'Host agent admission is closed during an authorization transition',
      503,
      'AUTHORIZATION_TRANSITION_ACTIVE',
    );
  }
  if (
    !actor
    || actor.accountStatus !== 'ACTIVE'
    || actor.isActive !== true
    || Number(actor.authorizationVersion) !== handle.actorAuthorizationVersion
  ) {
    throw new HostAgentRunJournalError(
      'Host agent authorization changed before runtime admission',
      409,
      'AUTHORIZATION_CHANGED',
    );
  }
}

async function beginHostAgentRunInternal(input: BeginHostAgentRunInput): Promise<HostAgentRunHandle> {
  validateHandle(input);
  await initializeHostAgentRunRuntime();
  if (shuttingDown) {
    throw new HostAgentRunJournalError(
      'Host agent runtime is shutting down',
      503,
      'HOST_RUN_RUNTIME_SHUTTING_DOWN',
    );
  }

  try {
    await (prisma as any).$transaction(async (transaction: any) => {
      await assertActorAndTransition(transaction, input);
      await transaction.hostAgentRun.create({
        data: {
          ...input,
          portalInstanceId,
          status: 'PREPARED',
          attempt: 0,
        },
      });
    }, { isolationLevel: 'Serializable' });
  } catch (error: any) {
    if (error instanceof HostAgentRunJournalError) throw error;
    if (error?.code === 'P2002') {
      throw new HostAgentRunJournalError(
        'This host agent session already has an unresolved durable run',
        409,
        'HOST_RUN_ALREADY_ACTIVE',
      );
    }
    throw error;
  }
  return { ...input };
}

export function beginHostAgentRun(input: BeginHostAgentRunInput): Promise<HostAgentRunHandle> {
  return trackOperation(beginHostAgentRunInternal(input));
}

export function reserveHostAgentRunAttempt(
  handle: HostAgentRunHandle,
): Promise<ReservedHostAgentRunAttempt> {
  validateHandle(handle);
  return trackOperation((async () => {
    const row = await (prisma as any).hostAgentRun.findUnique({ where: { id: handle.id } }) as
      | HostAgentRunRow
      | null;
    if (
      !row
      || !sameHandle(row, handle)
      || !(['PREPARED', 'DISPATCHED'] as ActiveHostRunStatus[]).includes(row.status as ActiveHostRunStatus)
      || (row.status === 'PREPARED' && row.attempt !== 0)
    ) {
      throw new HostAgentRunJournalError(
        'Host agent run cannot reserve another process attempt',
        409,
        'HOST_RUN_ATTEMPT_INVALID',
      );
    }

    let priorTermination: Awaited<ReturnType<typeof stopPersistedBoundary>> | null = null;
    if (row.status === 'DISPATCHED') {
      try {
        priorTermination = await stopPersistedBoundary(row);
      } catch (error) {
        await markQuarantined(row, {
          reason: 'retry_process_boundary_not_empty',
          priorAttempt: row.attempt,
          exactCleanupConfirmed: false,
          boundaryErrorCode: error instanceof SystemdHostRunBoundaryError
            ? error.code
            : 'HOST_RUN_SCOPE_SETTLEMENT_UNPROVEN',
          attemptedAt: new Date().toISOString(),
          portalInstanceId,
        });
        throw new HostAgentRunJournalError(
          'Host agent retry was blocked because the prior systemd scope could not be settled',
          503,
          'HOST_RUN_RETRY_BOUNDARY_UNPROVEN',
        );
      }
    }

    const boundaryReservation = await systemdHostRunBoundary.reserve();
    const gate = await createHostAgentRunActivationGate(
      boundaryReservation.scopeUnit,
      boundaryReservation.scopeTag,
    );
    const reservation: ReservedHostAgentRunAttempt = {
      ...boundaryReservation,
      gatePath: gate.socketPath,
      attempt: row.attempt + 1,
    };

    try {
      await (prisma as any).$transaction(async (transaction: any) => {
        await assertActorAndTransition(transaction, handle);
        const current = await transaction.hostAgentRun.findUnique({
          where: { id: handle.id },
        }) as HostAgentRunRow | null;
        if (
          !current
          || !sameHandle(current, handle)
          || current.status !== row.status
          || current.attempt !== row.attempt
        ) {
          throw new HostAgentRunJournalError(
            'Host agent run attempt changed concurrently',
            409,
            'HOST_RUN_ATTEMPT_RACE',
          );
        }
        const updated = await transaction.hostAgentRun.updateMany({
          where: {
            id: row.id,
            status: row.status,
            attempt: row.attempt,
          },
          data: {
            status: 'PREPARED',
            attempt: reservation.attempt,
            scopeUnit: reservation.scopeUnit,
            scopeTag: reservation.scopeTag,
            bootId: reservation.bootId,
            controlGroup: reservation.controlGroup,
            gatePath: reservation.gatePath,
            scopeInvocationId: null,
            launcherPid: null,
            dispatchActivatedAt: null,
            settledAt: null,
            terminalReason: null,
            evidence: row.status === 'DISPATCHED'
              ? {
                  previousAttempt: row.attempt,
                  previousAttemptClosedAt: new Date().toISOString(),
                  ...stopEvidence(
                    priorTermination?.proof || null,
                    priorTermination?.bootChanged === true,
                  ),
                }
              : undefined,
          },
        });
        if (updated.count !== 1) {
          throw new HostAgentRunJournalError(
            'Host agent run attempt changed concurrently',
            409,
            'HOST_RUN_ATTEMPT_RACE',
          );
        }
      }, { isolationLevel: 'Serializable' });
    } catch (error: any) {
      await gate.abort();
      if (error instanceof HostAgentRunJournalError) throw error;
      if (error?.code === 'P2002') {
        throw new HostAgentRunJournalError(
          'Host agent systemd scope identity collided with an existing reservation',
          503,
          'HOST_RUN_SCOPE_IDENTITY_COLLISION',
        );
      }
      throw error;
    }

    activeGates.set(gateKey(handle.id, reservation.attempt), gate);
    return Object.freeze(reservation);
  })());
}

function validateSpawnInput(input: SpawnGatedHostAgentRunAttemptInput): {
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  validateHandle(input.handle);
  if (
    !input.reservation
    || !Number.isSafeInteger(input.reservation.attempt)
    || input.reservation.attempt < 1
  ) {
    throw new HostAgentRunJournalError(
      'Host agent process attempt is invalid',
      400,
      'HOST_RUN_ATTEMPT_INVALID',
    );
  }
  if (
    typeof input.command !== 'string'
    || !input.command
    || input.command.includes('\0')
    || !Array.isArray(input.args)
    || input.args.some((argument) => (
      typeof argument !== 'string' || argument.includes('\0')
    ))
  ) {
    throw new HostAgentRunJournalError(
      'Host agent command contains an invalid argument',
      400,
      'HOST_RUN_COMMAND_INVALID',
    );
  }
  if (
    typeof input.options.cwd !== 'string'
    || !path.posix.isAbsolute(input.options.cwd)
    || path.posix.normalize(input.options.cwd) !== input.options.cwd
  ) {
    throw new HostAgentRunJournalError(
      'Host agent working directory is invalid',
      400,
      'HOST_RUN_CWD_INVALID',
    );
  }
  if (
    input.options.shell
    || input.options.uid !== undefined
    || input.options.gid !== undefined
  ) {
    throw new HostAgentRunJournalError(
      'Host agent spawn options cannot bypass the systemd scope wrapper',
      400,
      'HOST_RUN_SPAWN_OPTIONS_INVALID',
    );
  }
  if (!input.options.env || typeof input.options.env !== 'object') {
    throw new HostAgentRunJournalError(
      'Host agent target environment must be supplied explicitly',
      400,
      'HOST_RUN_ENV_REQUIRED',
    );
  }
  return {
    cwd: input.options.cwd,
    env: input.options.env,
  };
}

async function quarantineAfterBoundaryFailure(
  handle: HostAgentRunHandle,
  fallbackRow: HostAgentRunRow,
  reason: string,
  error: unknown,
): Promise<void> {
  const current = await (prisma as any).hostAgentRun.findUnique({
    where: { id: handle.id },
  }) as HostAgentRunRow | null;
  if (
    current
    && sameHandle(current, handle)
    && ACTIVE_HOST_RUN_STATUSES.includes(current.status as ActiveHostRunStatus)
  ) {
    await markQuarantined(current, {
      reason,
      exactCleanupConfirmed: false,
      boundaryErrorCode: error instanceof SystemdHostRunBoundaryError
        ? error.code
        : error instanceof HostAgentRunJournalError
          ? error.code
          : 'HOST_RUN_SCOPE_SETTLEMENT_UNPROVEN',
      attemptedAt: new Date().toISOString(),
      portalInstanceId,
    });
  } else {
    await markQuarantined(fallbackRow, {
      reason,
      exactCleanupConfirmed: false,
      boundaryErrorCode: 'HOST_RUN_SCOPE_SETTLEMENT_UNPROVEN',
      attemptedAt: new Date().toISOString(),
      portalInstanceId,
    });
  }
}

export function spawnGatedHostAgentRunAttempt(
  input: SpawnGatedHostAgentRunAttemptInput,
): Promise<GatedHostAgentRunAttempt> {
  return trackOperation((async () => {
    const { cwd, env } = validateSpawnInput(input);
    const row = await (prisma as any).hostAgentRun.findUnique({
      where: { id: input.handle.id },
    }) as HostAgentRunRow | null;
    if (
      !row
      || !sameHandle(row, input.handle)
      || row.status !== 'PREPARED'
      || !rowMatchesReservation(row, input.reservation)
      || row.scopeInvocationId !== null
    ) {
      throw new HostAgentRunJournalError(
        'Host agent process reservation was not durably persisted',
        409,
        'HOST_RUN_ATTEMPT_RACE',
      );
    }
    const gate = activeGates.get(gateKey(row.id, row.attempt));
    if (!gate || gate.socketPath !== input.reservation.gatePath) {
      throw new HostAgentRunJournalError(
        'Host agent activation gate is unavailable',
        503,
        'HOST_RUN_GATE_UNAVAILABLE',
      );
    }

    let launched: Awaited<ReturnType<typeof systemdHostRunBoundary.launch>> | null = null;
    try {
      // Loader/runtime variables from the requested CLI must never reach the
      // pre-scope systemd-run process or the wrapper bootstrap. The target
      // environment travels only over the authenticated root-only socket and
      // is acknowledged while the wrapper remains pre-exec blocked.
      gate.prepareTargetEnvironment(env);
      launched = await systemdHostRunBoundary.launch({
        reservation: input.reservation,
        wrapperCommand: process.execPath,
        wrapperArgs: [
          '-e',
          HOST_AGENT_RUN_ACTIVATION_WRAPPER_SOURCE,
          '--',
          input.reservation.gatePath,
          input.reservation.scopeTag,
          input.command,
          ...input.args,
        ],
        cwd,
      });
      // The caller installs its parser/error listeners immediately after this
      // function returns. Keep the transport from emitting an unhandled error
      // during the authenticated-handshake and SPAWNED persistence window.
      launched.child.on('error', () => undefined);
      await gate.ready;

      const persisted = await (prisma as any).hostAgentRun.updateMany({
        where: {
          id: input.handle.id,
          actorUserId: input.handle.actorUserId,
          actorAuthorizationVersion: input.handle.actorAuthorizationVersion,
          provider: input.handle.provider,
          sessionId: input.handle.sessionId,
          status: 'PREPARED',
          attempt: input.reservation.attempt,
          scopeUnit: input.reservation.scopeUnit,
          scopeTag: input.reservation.scopeTag,
          bootId: input.reservation.bootId,
          controlGroup: input.reservation.controlGroup,
          gatePath: input.reservation.gatePath,
          scopeInvocationId: null,
        },
        data: {
          status: 'SPAWNED',
          scopeInvocationId: launched.identity.invocationId,
          launcherPid: Number.isSafeInteger(launched.child.pid)
            ? launched.child.pid
            : null,
        },
      });
      if (persisted.count !== 1) {
        throw new HostAgentRunJournalError(
          'Host agent systemd scope identity could not be persisted',
          503,
          'HOST_RUN_IDENTITY_PERSIST_FAILED',
        );
      }
      return Object.freeze({
        child: launched.child,
        attempt: input.reservation.attempt,
        identity: Object.freeze({
          ...input.reservation,
          invocationId: launched.identity.invocationId,
        }),
      });
    } catch (error) {
      try {
        await gate.abort();
        activeGates.delete(gateKey(row.id, row.attempt));
        if (launched) {
          await systemdHostRunBoundary.stop(launched.identity);
        } else {
          await stopPersistedBoundary(row);
        }
      } catch (cleanupError) {
        await quarantineAfterBoundaryFailure(
          input.handle,
          row,
          'scope_launch_or_identity_persistence_failure',
          cleanupError,
        );
      }
      throw error;
    }
  })());
}

export function activateGatedHostAgentRunAttempt(
  handle: HostAgentRunHandle,
  launch: GatedHostAgentRunAttempt,
): Promise<void> {
  validateHandle(handle);
  return trackOperation((async () => {
    const gate = activeGates.get(gateKey(handle.id, launch.attempt));
    if (!gate || gate.socketPath !== launch.identity.gatePath) {
      try {
        await systemdHostRunBoundary.stop(launch.identity);
      } catch {}
      throw new HostAgentRunJournalError(
        'Host agent activation gate is unavailable',
        503,
        'HOST_RUN_GATE_UNAVAILABLE',
      );
    }

    try {
      await (prisma as any).$transaction(async (transaction: any) => {
        await assertActorAndTransition(transaction, handle);
        const activatedAt = new Date();
        const activated = await transaction.hostAgentRun.updateMany({
          where: {
            id: handle.id,
            actorUserId: handle.actorUserId,
            actorAuthorizationVersion: handle.actorAuthorizationVersion,
            provider: handle.provider,
            sessionId: handle.sessionId,
            status: 'SPAWNED',
            attempt: launch.attempt,
            scopeUnit: launch.identity.scopeUnit,
            scopeTag: launch.identity.scopeTag,
            bootId: launch.identity.bootId,
            controlGroup: launch.identity.controlGroup,
            gatePath: launch.identity.gatePath,
            scopeInvocationId: launch.identity.invocationId,
          },
          data: {
            status: 'DISPATCHED',
            dispatchActivatedAt: activatedAt,
            evidence: {
              dispatchActivatedAt: activatedAt.toISOString(),
              scopeUnit: launch.identity.scopeUnit,
              invocationId: launch.identity.invocationId,
              bootId: launch.identity.bootId,
              portalInstanceId,
            },
          },
        });
        if (activated.count !== 1) {
          throw new HostAgentRunJournalError(
            'Host agent dispatch activation could not be committed',
            503,
            'HOST_RUN_DISPATCH_COMMIT_FAILED',
          );
        }
      }, { isolationLevel: 'Serializable' });

      await gate.release();
      activeGates.delete(gateKey(handle.id, launch.attempt));
    } catch (error) {
      activeGates.delete(gateKey(handle.id, launch.attempt));
      try {
        await gate.abort();
        const proof = await systemdHostRunBoundary.stop(launch.identity);
        const row = await (prisma as any).hostAgentRun.findUnique({
          where: { id: handle.id },
        }) as HostAgentRunRow | null;
        if (
          row
          && sameHandle(row, handle)
          && ACTIVE_HOST_RUN_STATUSES.includes(row.status as ActiveHostRunStatus)
        ) {
          await markRecovered(row, {
            reason: 'dispatch_activation_failure',
            ...stopEvidence(proof, false),
            recoveredAt: new Date().toISOString(),
            portalInstanceId,
          });
        }
      } catch (cleanupError) {
        const row = await (prisma as any).hostAgentRun.findUnique({
          where: { id: handle.id },
        }) as HostAgentRunRow | null;
        if (row && sameHandle(row, handle)) {
          await quarantineAfterBoundaryFailure(
            handle,
            row,
            'dispatch_activation_failure',
            cleanupError,
          );
        }
      }
      throw error;
    }
  })());
}

export function terminateHostAgentRunAttempt(
  handle: HostAgentRunHandle,
): Promise<boolean> {
  validateHandle(handle);
  return trackOperation((async () => {
    const row = await (prisma as any).hostAgentRun.findUnique({
      where: { id: handle.id },
    }) as HostAgentRunRow | null;
    if (!row || !sameHandle(row, handle)) return false;
    if (!ACTIVE_HOST_RUN_STATUSES.includes(row.status as ActiveHostRunStatus)) {
      return true;
    }
    try {
      await stopPersistedBoundary(row);
      return true;
    } catch (error) {
      await markQuarantined(row, {
        reason: 'provider_requested_scope_termination',
        exactCleanupConfirmed: false,
        boundaryErrorCode: error instanceof SystemdHostRunBoundaryError
          ? error.code
          : error instanceof HostAgentRunJournalError
            ? error.code
            : 'HOST_RUN_SCOPE_SETTLEMENT_UNPROVEN',
        attemptedAt: new Date().toISOString(),
        portalInstanceId,
      });
      return false;
    }
  })());
}

export function settleHostAgentRun(
  handle: HostAgentRunHandle,
  status: Exclude<HostAgentRunTerminalStatus, 'RECOVERED'>,
  terminalReason?: string,
  evidence: Record<string, unknown> = {},
): Promise<void> {
  validateHandle(handle);
  return trackOperation((async () => {
    const current = await (prisma as any).hostAgentRun.findUnique({
      where: { id: handle.id },
    }) as HostAgentRunRow | null;
    if (!current || !sameHandle(current, handle)) {
      throw new HostAgentRunJournalError(
        'Host agent terminal state does not match the admitted run',
        503,
        'HOST_RUN_SETTLEMENT_UNPROVEN',
      );
    }
    if (
      current.status === status
      || current.status === 'RECOVERED'
    ) {
      return;
    }
    if (!(['PREPARED', 'SPAWNED', 'DISPATCHED'] as ActiveHostRunStatus[])
      .includes(current.status as ActiveHostRunStatus)) {
      throw new HostAgentRunJournalError(
        'Host agent terminal state could not be committed',
        503,
        'HOST_RUN_SETTLEMENT_UNPROVEN',
      );
    }

    let termination: Awaited<ReturnType<typeof stopPersistedBoundary>>;
    try {
      // Child close is only transport state. Always stop and prove the exact
      // scope empty so a daemonized descendant cannot survive settlement.
      termination = await stopPersistedBoundary(current);
    } catch (error) {
      await markQuarantined(current, {
        reason: 'terminal_systemd_scope_not_empty',
        exactCleanupConfirmed: false,
        boundaryErrorCode: error instanceof SystemdHostRunBoundaryError
          ? error.code
          : error instanceof HostAgentRunJournalError
            ? error.code
            : 'HOST_RUN_SCOPE_SETTLEMENT_UNPROVEN',
        attemptedAt: new Date().toISOString(),
        portalInstanceId,
      });
      throw new HostAgentRunJournalError(
        'Host agent systemd scope remained active or could not be attested at terminal settlement',
        503,
        'HOST_RUN_SETTLEMENT_BOUNDARY_UNPROVEN',
      );
    }

    const settledAt = new Date();
    const updated = await (prisma as any).hostAgentRun.updateMany({
      where: {
        id: handle.id,
        actorUserId: handle.actorUserId,
        actorAuthorizationVersion: handle.actorAuthorizationVersion,
        provider: handle.provider,
        sessionId: handle.sessionId,
        status: current.status,
        attempt: current.attempt,
      },
      data: {
        status,
        settledAt,
        terminalReason: terminalReason || null,
        evidence: {
          ...evidence,
          ...stopEvidence(termination.proof, termination.bootChanged),
          settledAt: settledAt.toISOString(),
          portalInstanceId,
        },
      },
    });
    if (updated.count !== 1) {
      const raced = await (prisma as any).hostAgentRun.findUnique({
        where: { id: handle.id },
      }) as HostAgentRunRow | null;
      if (
        raced
        && sameHandle(raced, handle)
        && (
          raced.status === status
          || raced.status === 'RECOVERED'
        )
      ) {
        return;
      }
      throw new HostAgentRunJournalError(
        'Host agent terminal state could not be committed',
        503,
        'HOST_RUN_SETTLEMENT_UNPROVEN',
      );
    }
  })());
}

export function quarantineHostAgentRun(
  handle: HostAgentRunHandle,
  terminalReason: string,
  evidence: Record<string, unknown> = {},
): Promise<void> {
  validateHandle(handle);
  return trackOperation((async () => {
    const row = await (prisma as any).hostAgentRun.findUnique({
      where: { id: handle.id },
    }) as HostAgentRunRow | null;
    if (row && sameHandle(row, handle)) {
      try {
        await abortGateForRow(row);
      } catch {}
    }
    const updated = await (prisma as any).hostAgentRun.updateMany({
      where: {
        id: handle.id,
        actorUserId: handle.actorUserId,
        actorAuthorizationVersion: handle.actorAuthorizationVersion,
        provider: handle.provider,
        sessionId: handle.sessionId,
        status: { in: [...ACTIVE_HOST_RUN_STATUSES] },
      },
      data: {
        status: 'QUARANTINED',
        settledAt: null,
        terminalReason,
        evidence: {
          ...evidence,
          quarantinedAt: new Date().toISOString(),
          portalInstanceId,
        },
      },
    });
    if (updated.count !== 1) {
      const current = await (prisma as any).hostAgentRun.findUnique({
        where: { id: handle.id },
      }) as HostAgentRunRow | null;
      if (current && sameHandle(current, handle) && current.status === 'RECOVERED') return;
      throw new HostAgentRunJournalError(
        'Host agent quarantine state could not be committed',
        503,
        'HOST_RUN_QUARANTINE_UNPROVEN',
      );
    }
  })());
}

export function registerHostAgentRunAbort(
  handle: HostAgentRunHandle,
  aborter: () => Promise<boolean>,
): () => void {
  validateHandle(handle);
  if (inMemoryAborters.has(handle.id)) {
    throw new HostAgentRunJournalError(
      'Host agent run already has an in-memory abort authority',
      409,
      'HOST_RUN_ABORT_AUTHORITY_DUPLICATE',
    );
  }
  inMemoryAborters.set(handle.id, aborter);
  return () => {
    if (inMemoryAborters.get(handle.id) === aborter) inMemoryAborters.delete(handle.id);
  };
}

async function quiesceRows(
  rows: HostAgentRunRow[],
  reason: 'authorization_transition' | 'project_dependency_promotion' | 'shutdown',
): Promise<HostAgentRunQuiescence> {
  let inMemoryAbortCount = 0;
  let persistedRuntimeSignalCount = 0;
  let recoveredCount = 0;
  for (const original of rows) {
    const aborter = inMemoryAborters.get(original.id);
    if (aborter) {
      inMemoryAbortCount += 1;
      try {
        await aborter();
      } catch {
        // The persisted exact systemd scope remains the recovery authority.
      }
    }
    const current = await (prisma as any).hostAgentRun.findUnique({
      where: { id: original.id },
    }) as HostAgentRunRow | null;
    if (!current || !ACTIVE_HOST_RUN_STATUSES.includes(current.status as ActiveHostRunStatus)) {
      continue;
    }
    const recovered = await recoverRow(current, reason);
    if (recovered.signaled) persistedRuntimeSignalCount += 1;
    if (recovered.recovered) recoveredCount += 1;
    if (recovered.quarantined) {
      throw new HostAgentRunJournalError(
        `Host-native run ${current.id} could not be quiesced exactly`,
        503,
        'HOST_RUN_QUIESCENCE_UNPROVEN',
      );
    }
  }
  return {
    runCount: rows.length,
    inMemoryAbortCount,
    persistedRuntimeSignalCount,
    recoveredCount,
  };
}

export async function quiesceHostAgentRunsForAuthorizationTransition(
  userIds: readonly string[],
): Promise<HostAgentRunQuiescence> {
  const selectedUserIds = Array.from(new Set(
    userIds.map((value) => String(value || '').trim()).filter(Boolean),
  )).sort();
  if (selectedUserIds.length === 0) {
    return {
      runCount: 0,
      inMemoryAbortCount: 0,
      persistedRuntimeSignalCount: 0,
      recoveredCount: 0,
    };
  }
  await initializeHostAgentRunRuntime();
  await Promise.allSettled([...activeOperations]);
  const rows = await (prisma as any).hostAgentRun.findMany({
    where: {
      actorUserId: { in: selectedUserIds },
      status: { in: [...ACTIVE_HOST_RUN_STATUSES] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  }) as HostAgentRunRow[];
  const result = await quiesceRows(rows, 'authorization_transition');
  const residual = await (prisma as any).hostAgentRun.findFirst({
    where: {
      actorUserId: { in: selectedUserIds },
      status: { in: [...ACTIVE_HOST_RUN_STATUSES] },
    },
    select: { id: true },
  });
  if (residual) {
    throw new HostAgentRunJournalError(
      'A host-native run remained unresolved after authorization cleanup',
      503,
      'HOST_RUN_QUIESCENCE_UNPROVEN',
    );
  }
  return result;
}

export async function quiesceHostAgentRunsForProjectDependencyPromotion(
): Promise<HostAgentRunQuiescence> {
  await initializeHostAgentRunRuntime();
  await Promise.allSettled([...activeOperations]);
  const rows = await (prisma as any).hostAgentRun.findMany({
    where: { status: { in: [...ACTIVE_HOST_RUN_STATUSES] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  }) as HostAgentRunRow[];
  const result = await quiesceRows(rows, 'project_dependency_promotion');
  const residual = await (prisma as any).hostAgentRun.findFirst({
    where: { status: { in: [...ACTIVE_HOST_RUN_STATUSES] } },
    select: { id: true },
  });
  if (residual) {
    throw new HostAgentRunJournalError(
      'A host-native run remained unresolved before dependency promotion',
      503,
      'HOST_RUN_QUIESCENCE_UNPROVEN',
    );
  }
  return result;
}

export async function shutdownHostAgentRunRuntime(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (startupPromise) await Promise.allSettled([startupPromise]);
  await Promise.allSettled([...activeOperations]);
  const rows = await (prisma as any).hostAgentRun.findMany({
    where: { status: { in: [...ACTIVE_HOST_RUN_STATUSES] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  }) as HostAgentRunRow[];
  await quiesceRows(rows, 'shutdown');
  inMemoryAborters.clear();
}

export const __hostAgentRunJournalTest = Object.freeze({
  ACTIVE_HOST_RUN_STATUSES,
  portalInstanceId,
  runtimeRoot,
  ACTIVATION_WRAPPER_SOURCE: HOST_AGENT_RUN_ACTIVATION_WRAPPER_SOURCE,
  reservationFromRow,
  identityFromRow,
  stopPersistedBoundary,
  resetRuntimeState(): void {
    for (const gate of activeGates.values()) {
      void gate.abort();
    }
    activeGates.clear();
    inMemoryAborters.clear();
    activeOperations.clear();
    startupPromise = null;
    shuttingDown = false;
  },
});
