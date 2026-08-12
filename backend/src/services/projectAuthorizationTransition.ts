import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import {
  publishAuthorizationChanged,
  type AuthorizationChangeReason,
} from './authorizationChangeBus';
import { publishAllSessionsRevoked } from './sessionRevocationBus';
import {
  quiesceAgentJobsForAuthorizationTransition,
  type AgentJobAuthorizationQuiescence,
} from './agentJobs';
import {
  quiesceHostAgentRunsForAuthorizationTransition,
  type HostAgentRunQuiescence,
} from './hostAgentRunJournal';
import {
  quiesceOpenClawHostRunsForAuthorizationTransition,
  type OpenClawHostRunQuiescence,
} from './openClawHostRunJournal';
import {
  assertProjectIdentityRoot,
  type ProjectIdentityRecord,
} from './projectIdentity';
import {
  cleanupProjectRuntime,
  type ProjectRuntimeCleanupResult,
} from './projectRuntimeCleanup';
import { createDefaultProjectRuntimeCleanupAdapters } from './projectRuntimeCleanupAdapters';
import { createProjectAuthorizationEgressCleanupAdapter } from './projectEgressCleanupAdapter';
import {
  openClawGatewayAuthorizationFence,
  type OpenClawGatewayStopProof,
  type OpenClawGatewayUnitSnapshot,
} from './openClawGatewayAuthorizationFence';
import {
  closeGlobalWorkspaceAuthorizationAdmission,
  type WorkspaceAuthorizationFenceController,
} from './workspaceAuthorizationBarrier';
import {
  PRIVILEGED_CONFIRMATION,
  confirmationForOwnershipTransfer,
  isTypedConfirmationMatch,
} from '../utils/privilegedConfirmation';
import {
  ACTIVE_STATUS,
  canAccessPortal,
  isOwnerRole,
  isSubAdminRole,
} from '../utils/authz';

const TRANSITION_SCHEMA_VERSION = 1;
const TRANSITION_SINGLETON_KEY = 'GLOBAL';
const TRANSITION_LEASE_MS = 45_000;
const TRANSITION_RENEW_MS = 10_000;
const AUTHORIZATION_CHANGE_REASONS = new Set<AuthorizationChangeReason>([
  'role',
  'account_status',
  'active_status',
  'workspace_scope',
  'credential_recovery',
]);
const AUTHORIZATION_USER_ROLES = new Set(['OWNER', 'SUB_ADMIN', 'USER', 'VIEWER']);
const AUTHORIZATION_ACCOUNT_STATUSES = new Set([
  'ACTIVE',
  'PENDING',
  'DISABLED',
  'BANNED',
]);
const USER_UPDATE_KEYS = [
  'role',
  'accountStatus',
  'sandboxEnabled',
  'isActive',
  'username',
  'firstName',
  'lastName',
] as const;

export const PROJECT_AUTHORIZATION_TRANSITION_ACTIVE_CODE =
  'PROJECT_AUTHORIZATION_TRANSITION_ACTIVE';
export const PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE =
  'PROJECT_AUTHORIZATION_TRANSITION_DRIFT';

export type ProjectAuthorizationTransitionKind =
  | 'USER_AUTHORIZATION_UPDATE'
  | 'CREDENTIAL_RECOVERY'
  | 'OWNERSHIP_TRANSFER';

export type ProjectAuthorizationTransitionPhase =
  | 'PREPARED'
  | 'QUIESCING'
  | 'PROVIDER_FENCED'
  | 'COMMITTED'
  | 'COMPLETE';

export interface ProjectAuthorizationUserUpdate {
  role?: 'SUB_ADMIN' | 'USER' | 'VIEWER';
  accountStatus?: 'ACTIVE' | 'PENDING' | 'DISABLED' | 'BANNED';
  sandboxEnabled?: boolean;
  isActive?: boolean;
  username?: string;
  firstName?: string | null;
  lastName?: string | null;
}

interface AuthorizationUserSnapshot {
  id: string;
  email: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  accountStatus: string;
  isActive: boolean;
  sandboxEnabled: boolean;
  authorizationVersion: number;
}

interface TransitionPayloadBase {
  schemaVersion: typeof TRANSITION_SCHEMA_VERSION;
  requestFingerprint: string;
  candidateActorIds: string[];
}

interface UserAuthorizationTransitionPayload extends TransitionPayloadBase {
  kind: 'USER_AUTHORIZATION_UPDATE';
  expectedTarget: AuthorizationUserSnapshot;
  update: ProjectAuthorizationUserUpdate;
  authorizationReasons: AuthorizationChangeReason[];
}

interface CredentialRecoveryIntent {
  schemaVersion: 1;
  challengeId: string;
  challengeTokenHash: string;
  passwordHashDigest: string;
  backupCodesDigest: string;
  requestedAt: string;
  ipAddress: string;
  userAgent: string | null;
}

interface CredentialRecoveryTransitionPayload extends TransitionPayloadBase {
  kind: 'CREDENTIAL_RECOVERY';
  expectedTarget: AuthorizationUserSnapshot;
  intent: CredentialRecoveryIntent;
}

interface OwnershipTransferTransitionPayload extends TransitionPayloadBase {
  kind: 'OWNERSHIP_TRANSFER';
  expectedOwner: AuthorizationUserSnapshot;
  expectedTarget: AuthorizationUserSnapshot;
}

type TransitionPayload =
  | UserAuthorizationTransitionPayload
  | CredentialRecoveryTransitionPayload
  | OwnershipTransferTransitionPayload;

interface TransitionProjectRow {
  transitionId: string;
  projectIdentityId: string;
  workspaceOwnerId: string;
  projectName: string;
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  projectGeneration: number;
  status: 'PENDING' | 'QUIESCED';
  quiescenceEvidence: unknown;
  quiescedAt: Date | null;
}

interface TransitionRow {
  id: string;
  singletonKey: string;
  kind: ProjectAuthorizationTransitionKind;
  phase: ProjectAuthorizationTransitionPhase;
  initiatedByUserId: string;
  targetUserId: string | null;
  sourceOwnerUserId: string | null;
  payload: unknown;
  result: unknown;
  gatewayWasActive: boolean | null;
  gatewayFenceProof: unknown;
  hostRuntimeQuiescenceProof: unknown;
  leaseOwner: string | null;
  leaseTokenHash: string | null;
  leaseExpiresAt: Date | null;
  projects?: TransitionProjectRow[];
}

export interface ProjectAuthorizationUserUpdateResult {
  user: AuthorizationUserSnapshot & {
    lastLoginAt?: Date | string | null;
    createdAt?: Date | string;
    avatarPath?: string | null;
  };
  existing: AuthorizationUserSnapshot;
  authorizationReasons: AuthorizationChangeReason[];
}

export interface ProjectOwnershipTransferResult {
  changedAuthorizations: Array<{ id: string; authorizationVersion: number }>;
  targetEmail: string;
}

export type ProjectCredentialRecoveryResult = ProjectAuthorizationUserUpdateResult;

export class ProjectAuthorizationTransitionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 503,
    public readonly retryable = true,
  ) {
    super(message);
    this.name = 'ProjectAuthorizationTransitionError';
  }
}

export async function assertNoProjectAuthorizationTransitionActive(
  transaction: any,
): Promise<void> {
  const unresolved = await transaction.projectAuthorizationTransition.findFirst({
    where: { singletonKey: TRANSITION_SINGLETON_KEY, phase: { not: 'COMPLETE' } },
    select: { id: true },
  });
  if (unresolved) {
    throw new ProjectAuthorizationTransitionError(
      PROJECT_AUTHORIZATION_TRANSITION_ACTIVE_CODE,
      'Account activation is paused while an authorization transition is in progress',
      409,
      true,
    );
  }
}

interface TransitionLease {
  owner: string;
  tokenHash: string;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

interface TransitionDependencies {
  database: any;
  closeAdmission(): WorkspaceAuthorizationFenceController;
  quiesceAgentJobs(userIds: readonly string[]): Promise<AgentJobAuthorizationQuiescence>;
  quiesceHostRuns(userIds: readonly string[]): Promise<HostAgentRunQuiescence>;
  quiesceOpenClawHostRuns(
    userIds: readonly string[],
  ): Promise<OpenClawHostRunQuiescence>;
  cleanupProject(input: {
    authenticatedActorId: string;
    workspaceOwnerId: string;
    projectIdentity: ProjectIdentityRecord;
    candidateActorIds: readonly string[];
    lifecycleReason: 'authorization_change';
  }): Promise<ProjectRuntimeCleanupResult>;
  assertProjectRoot(identity: ProjectIdentityRecord, canonicalRoot: string): unknown;
  gateway: {
    inspect(): Promise<OpenClawGatewayUnitSnapshot>;
    stop(): Promise<OpenClawGatewayStopProof>;
    release(restart: boolean): Promise<OpenClawGatewayUnitSnapshot>;
  };
  publish(event: {
    type: 'authorization_changed';
    userId: string;
    authorizationVersion: number;
    reasons: AuthorizationChangeReason[];
  }): void;
  publishSessions(input: {
    userId: string;
    reason: 'credential_recovery' | 'authorization_transition';
  }): void;
  now(): Date;
  randomUUID(): string;
  randomBytes(size: number): Buffer;
}

const defaultDependencies: TransitionDependencies = {
  database: prisma,
  closeAdmission: closeGlobalWorkspaceAuthorizationAdmission,
  quiesceAgentJobs: quiesceAgentJobsForAuthorizationTransition,
  quiesceHostRuns: quiesceHostAgentRunsForAuthorizationTransition,
  quiesceOpenClawHostRuns: quiesceOpenClawHostRunsForAuthorizationTransition,
  cleanupProject: (input) => cleanupProjectRuntime(input, {
    adapters: createDefaultProjectRuntimeCleanupAdapters(),
    egressAdapter: createProjectAuthorizationEgressCleanupAdapter(),
  }),
  assertProjectRoot: assertProjectIdentityRoot,
  gateway: openClawGatewayAuthorizationFence,
  publish: publishAuthorizationChanged,
  publishSessions: publishAllSessionsRevoked,
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID(),
  randomBytes: (size) => crypto.randomBytes(size),
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  )).join(',')}}`;
}

function requestFingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function credentialStateDigest(label: string, value: string | null): string {
  return crypto
    .createHash('sha256')
    .update(`${label}\0${value === null ? 'null' : `string\0${value}`}`, 'utf8')
    .digest('hex');
}

function exactString(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ProjectAuthorizationTransitionError(
      'PROJECT_AUTHORIZATION_TRANSITION_INVALID',
      `Invalid ${label}`,
      400,
      false,
    );
  }
  return normalized;
}

function exactInteger(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new ProjectAuthorizationTransitionError(
      'PROJECT_AUTHORIZATION_TRANSITION_INVALID',
      `Invalid ${label}`,
      503,
      false,
    );
  }
  return normalized;
}

function userSnapshot(row: any): AuthorizationUserSnapshot {
  if (
    typeof row?.isActive !== 'boolean'
    || typeof row?.sandboxEnabled !== 'boolean'
    || !AUTHORIZATION_USER_ROLES.has(String(row?.role || ''))
    || !AUTHORIZATION_ACCOUNT_STATUSES.has(String(row?.accountStatus || ''))
    || (
      row?.firstName !== null
      && row?.firstName !== undefined
      && (
        typeof row.firstName !== 'string'
        || row.firstName.length > 100
        || /[\u0000-\u001f\u007f]/.test(row.firstName)
      )
    )
    || (
      row?.lastName !== null
      && row?.lastName !== undefined
      && (
        typeof row.lastName !== 'string'
        || row.lastName.length > 100
        || /[\u0000-\u001f\u007f]/.test(row.lastName)
      )
    )
  ) {
    throw new ProjectAuthorizationTransitionError(
      'PROJECT_AUTHORIZATION_TRANSITION_INVALID',
      'Invalid durable user authorization snapshot',
      503,
      false,
    );
  }
  return Object.freeze({
    id: exactString(row?.id, 'user identity'),
    email: exactString(row?.email, 'user email'),
    username: exactString(row?.username, 'username'),
    firstName: row?.firstName == null ? null : String(row.firstName),
    lastName: row?.lastName == null ? null : String(row.lastName),
    role: exactString(row?.role, 'user role'),
    accountStatus: exactString(row?.accountStatus, 'account status'),
    isActive: row?.isActive === true,
    sandboxEnabled: row?.sandboxEnabled === true,
    authorizationVersion: exactInteger(
      row?.authorizationVersion ?? 1,
      'authorization generation',
    ),
  });
}

function sameAuthorizationSnapshot(
  row: any,
  expected: AuthorizationUserSnapshot,
  includeProfile: boolean,
): boolean {
  if (
    String(row?.id || '') !== expected.id
    || String(row?.role || '') !== expected.role
    || String(row?.accountStatus || '') !== expected.accountStatus
    || Boolean(row?.isActive) !== expected.isActive
    || Boolean(row?.sandboxEnabled) !== expected.sandboxEnabled
    || Number(row?.authorizationVersion ?? 1) !== expected.authorizationVersion
  ) {
    return false;
  }
  if (!includeProfile) return true;
  return (
    String(row?.email || '') === expected.email
    && String(row?.username || '') === expected.username
    && (row?.firstName == null ? null : String(row.firstName)) === expected.firstName
    && (row?.lastName == null ? null : String(row.lastName)) === expected.lastName
  );
}

function compactUserUpdate(input: ProjectAuthorizationUserUpdate): ProjectAuthorizationUserUpdate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProjectAuthorizationTransitionError(
      'PROJECT_AUTHORIZATION_TRANSITION_INVALID',
      'Invalid authorization update',
      400,
      false,
    );
  }
  const unknownKeys = Object.keys(input).filter(
    (key) => !(USER_UPDATE_KEYS as readonly string[]).includes(key),
  );
  if (
    unknownKeys.length > 0
    || (input.role !== undefined && !['SUB_ADMIN', 'USER', 'VIEWER'].includes(input.role))
    || (
      input.accountStatus !== undefined
      && !AUTHORIZATION_ACCOUNT_STATUSES.has(input.accountStatus)
    )
    || (
      input.sandboxEnabled !== undefined
      && typeof input.sandboxEnabled !== 'boolean'
    )
    || (input.isActive !== undefined && typeof input.isActive !== 'boolean')
    || (
      input.username !== undefined
      && (
        typeof input.username !== 'string'
        || input.username !== input.username.trim()
        || input.username.length < 2
        || input.username.length > 100
        || /[\u0000-\u001f\u007f]/.test(input.username)
      )
    )
    || (
      input.firstName !== undefined
      && input.firstName !== null
      && (
        typeof input.firstName !== 'string'
        || input.firstName.length > 100
        || /[\u0000-\u001f\u007f]/.test(input.firstName)
      )
    )
    || (
      input.lastName !== undefined
      && input.lastName !== null
      && (
        typeof input.lastName !== 'string'
        || input.lastName.length > 100
        || /[\u0000-\u001f\u007f]/.test(input.lastName)
      )
    )
    || (
      input.accountStatus !== undefined
      && input.isActive !== (input.accountStatus === ACTIVE_STATUS)
    )
    || (input.isActive !== undefined && input.accountStatus === undefined)
  ) {
    throw new ProjectAuthorizationTransitionError(
      'PROJECT_AUTHORIZATION_TRANSITION_INVALID',
      'Invalid authorization update fields',
      400,
      false,
    );
  }
  const result: ProjectAuthorizationUserUpdate = {};
  for (const key of USER_UPDATE_KEYS) {
    if (input[key] !== undefined) (result as any)[key] = input[key];
  }
  return Object.freeze(result);
}

function authorizationReasons(
  existing: AuthorizationUserSnapshot,
  update: ProjectAuthorizationUserUpdate,
): AuthorizationChangeReason[] {
  const reasons: AuthorizationChangeReason[] = [];
  if (update.role !== undefined && update.role !== existing.role) reasons.push('role');
  if (
    update.accountStatus !== undefined
    && update.accountStatus !== existing.accountStatus
  ) {
    reasons.push('account_status');
  }
  if (update.isActive !== undefined && update.isActive !== existing.isActive) {
    reasons.push('active_status');
  }
  if (
    update.sandboxEnabled !== undefined
    && update.sandboxEnabled !== existing.sandboxEnabled
  ) {
    reasons.push('workspace_scope');
  }
  return reasons;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function journalInvalid(message: string): ProjectAuthorizationTransitionError {
  return new ProjectAuthorizationTransitionError(
    'PROJECT_AUTHORIZATION_TRANSITION_JOURNAL_INVALID',
    message,
    503,
    false,
  );
}

function parseCredentialRecoveryIntent(value: unknown): CredentialRecoveryIntent {
  const raw = asObject(value);
  if (
    !sameStringArray(
      Object.keys(raw).sort(),
      [
        'backupCodesDigest',
        'challengeId',
        'challengeTokenHash',
        'ipAddress',
        'passwordHashDigest',
        'requestedAt',
        'schemaVersion',
        'userAgent',
      ],
    )
    || raw.schemaVersion !== 1
    || typeof raw.passwordHashDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.passwordHashDigest)
    || typeof raw.backupCodesDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.backupCodesDigest)
    || typeof raw.requestedAt !== 'string'
    || !Number.isFinite(new Date(raw.requestedAt).getTime())
    || typeof raw.ipAddress !== 'string'
    || raw.ipAddress.length < 1
    || raw.ipAddress.length > 256
    || /[\u0000-\u001f\u007f]/.test(raw.ipAddress)
    || (
      raw.userAgent !== null
      && (
        typeof raw.userAgent !== 'string'
        || raw.userAgent.length > 2_048
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw.userAgent)
      )
    )
  ) {
    throw journalInvalid('Credential-recovery intent is malformed');
  }
  let challengeId: string;
  let challengeTokenHash: string;
  try {
    challengeId = exactString(raw.challengeId, 'credential-recovery challenge');
    challengeTokenHash = exactString(
      raw.challengeTokenHash,
      'credential-recovery challenge digest',
    );
  } catch {
    throw journalInvalid('Credential-recovery challenge identity is malformed');
  }
  return Object.freeze({
    schemaVersion: 1,
    challengeId,
    challengeTokenHash,
    passwordHashDigest: raw.passwordHashDigest,
    backupCodesDigest: raw.backupCodesDigest,
    requestedAt: raw.requestedAt,
    ipAddress: raw.ipAddress,
    userAgent: raw.userAgent as string | null,
  });
}

function parsePayload(row: TransitionRow): TransitionPayload {
  const raw = asObject(row.payload);
  if (
    raw.schemaVersion !== TRANSITION_SCHEMA_VERSION
    || typeof raw.requestFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.requestFingerprint)
    || !Array.isArray(raw.candidateActorIds)
    || raw.candidateActorIds.some((value) => typeof value !== 'string' || !value)
    || raw.kind !== row.kind
  ) {
    throw journalInvalid('Authorization transition journal is malformed');
  }
  let candidateActorIds: string[];
  try {
    candidateActorIds = raw.candidateActorIds.map((value) => exactString(
      value,
      'candidate actor identity',
    ));
  } catch {
    throw journalInvalid('Authorization transition actor identities are malformed');
  }
  const canonicalActorIds = [...new Set(candidateActorIds)].sort();
  if (
    candidateActorIds.length === 0
    || !sameStringArray(candidateActorIds, canonicalActorIds)
  ) {
    throw journalInvalid('Authorization transition actor identities are not canonical');
  }
  if (row.kind === 'USER_AUTHORIZATION_UPDATE') {
    const allowedKeys = [
      'schemaVersion',
      'kind',
      'requestFingerprint',
      'candidateActorIds',
      'expectedTarget',
      'update',
      'authorizationReasons',
    ].sort();
    if (!sameStringArray(Object.keys(raw).sort(), allowedKeys)) {
      throw journalInvalid('Authorization transition user payload fields are malformed');
    }
    let expectedTarget: AuthorizationUserSnapshot;
    let update: ProjectAuthorizationUserUpdate;
    try {
      expectedTarget = userSnapshot(raw.expectedTarget);
      update = compactUserUpdate(asObject(raw.update) as ProjectAuthorizationUserUpdate);
    } catch {
      throw journalInvalid('Authorization transition user payload is malformed');
    }
    if (!Array.isArray(raw.authorizationReasons)) {
      throw journalInvalid('Authorization transition reasons are malformed');
    }
    let suppliedReasons: AuthorizationChangeReason[];
    try {
      suppliedReasons = raw.authorizationReasons.map((value) => {
        const reason = exactString(value, 'authorization reason') as AuthorizationChangeReason;
        if (!AUTHORIZATION_CHANGE_REASONS.has(reason)) {
          throw journalInvalid('Authorization transition reason is unsupported');
        }
        return reason;
      });
    } catch {
      throw journalInvalid('Authorization transition reasons are malformed');
    }
    const reasons = authorizationReasons(expectedTarget, update);
    const targetUserId = typeof row.targetUserId === 'string' ? row.targetUserId : '';
    const initiatedByUserId = typeof row.initiatedByUserId === 'string'
      ? row.initiatedByUserId
      : '';
    if (
      reasons.length === 0
      || !sameStringArray(suppliedReasons, reasons)
      || expectedTarget.id !== targetUserId
      || row.sourceOwnerUserId !== null
      || !candidateActorIds.includes(expectedTarget.id)
      || !candidateActorIds.includes(initiatedByUserId)
      || raw.requestFingerprint !== requestFingerprint({
        kind: 'USER_AUTHORIZATION_UPDATE',
        initiatedByUserId,
        targetUserId,
        update,
      })
    ) {
      throw journalInvalid('Authorization transition user payload is not bound to its request');
    }
    return Object.freeze({
      schemaVersion: TRANSITION_SCHEMA_VERSION,
      kind: row.kind,
      requestFingerprint: raw.requestFingerprint,
      candidateActorIds: Object.freeze(candidateActorIds) as string[],
      expectedTarget,
      update,
      authorizationReasons: Object.freeze(reasons) as AuthorizationChangeReason[],
    });
  }

  if (row.kind === 'CREDENTIAL_RECOVERY') {
    const allowedKeys = [
      'schemaVersion',
      'kind',
      'requestFingerprint',
      'candidateActorIds',
      'expectedTarget',
      'intent',
    ].sort();
    if (!sameStringArray(Object.keys(raw).sort(), allowedKeys)) {
      throw journalInvalid('Credential-recovery payload fields are malformed');
    }
    let expectedTarget: AuthorizationUserSnapshot;
    let intent: CredentialRecoveryIntent;
    try {
      expectedTarget = userSnapshot(raw.expectedTarget);
      intent = parseCredentialRecoveryIntent(raw.intent);
    } catch {
      throw journalInvalid('Credential-recovery payload is malformed');
    }
    const targetUserId = typeof row.targetUserId === 'string' ? row.targetUserId : '';
    if (
      expectedTarget.id !== targetUserId
      || row.initiatedByUserId !== targetUserId
      || row.sourceOwnerUserId !== null
      || !candidateActorIds.includes(targetUserId)
      || raw.requestFingerprint !== requestFingerprint({
        kind: 'CREDENTIAL_RECOVERY',
        targetUserId,
        challengeId: intent.challengeId,
        challengeTokenHash: intent.challengeTokenHash,
        passwordHashDigest: intent.passwordHashDigest,
        backupCodesDigest: intent.backupCodesDigest,
      })
    ) {
      throw journalInvalid('Credential-recovery payload is not bound to its request');
    }
    return Object.freeze({
      schemaVersion: TRANSITION_SCHEMA_VERSION,
      kind: row.kind,
      requestFingerprint: raw.requestFingerprint,
      candidateActorIds: Object.freeze(candidateActorIds) as string[],
      expectedTarget,
      intent,
    });
  }

  const allowedKeys = [
    'schemaVersion',
    'kind',
    'requestFingerprint',
    'candidateActorIds',
    'expectedOwner',
    'expectedTarget',
  ].sort();
  if (!sameStringArray(Object.keys(raw).sort(), allowedKeys)) {
    throw journalInvalid('Ownership transition payload fields are malformed');
  }
  let expectedOwner: AuthorizationUserSnapshot;
  let expectedTarget: AuthorizationUserSnapshot;
  try {
    expectedOwner = userSnapshot(raw.expectedOwner);
    expectedTarget = userSnapshot(raw.expectedTarget);
  } catch {
    throw journalInvalid('Ownership transition participants are malformed');
  }
  const sourceOwnerUserId = typeof row.sourceOwnerUserId === 'string'
    ? row.sourceOwnerUserId
    : '';
  const targetUserId = typeof row.targetUserId === 'string' ? row.targetUserId : '';
  if (
    row.initiatedByUserId !== sourceOwnerUserId
    || expectedOwner.id !== sourceOwnerUserId
    || expectedTarget.id !== targetUserId
    || expectedOwner.id === expectedTarget.id
    || !isOwnerRole(expectedOwner.role)
    || isOwnerRole(expectedTarget.role)
    || !canAccessPortal(expectedTarget.accountStatus, expectedTarget.isActive)
    || !candidateActorIds.includes(expectedOwner.id)
    || !candidateActorIds.includes(expectedTarget.id)
    || raw.requestFingerprint !== requestFingerprint({
      kind: 'OWNERSHIP_TRANSFER',
      sourceOwnerUserId,
      targetUserId,
    })
  ) {
    throw journalInvalid('Ownership transition payload is not bound to its request');
  }
  return Object.freeze({
    schemaVersion: TRANSITION_SCHEMA_VERSION,
    kind: row.kind,
    requestFingerprint: raw.requestFingerprint,
    candidateActorIds: Object.freeze(candidateActorIds) as string[],
    expectedOwner,
    expectedTarget,
  });
}

interface HostRuntimeQuiescenceAttempt {
  recordedAt: string;
  agentJobs: AgentJobAuthorizationQuiescence;
  nativeHostRuns: HostAgentRunQuiescence;
  openClawHostRuns: OpenClawHostRunQuiescence;
}

interface HostRuntimeQuiescenceProof {
  schemaVersion: 1;
  affectedActorIds: string[];
  attempts: HostRuntimeQuiescenceAttempt[];
}

const MAX_HOST_RUNTIME_QUIESCENCE_ATTEMPTS = 64;
const MAX_HOST_RUNTIME_QUIESCENCE_COUNT = 10_000_000;
const MAX_OPENCLAW_QUIESCENCE_SESSIONS = 10_000;
const OPENCLAW_SESSION_KEY_PATTERN =
  /^agent:[A-Za-z0-9_-]+:[^\u0000-\u001f\u007f]{1,1980}$/;

function affectedActorIdsForPayload(payload: TransitionPayload): string[] {
  return payload.kind === 'USER_AUTHORIZATION_UPDATE'
    || payload.kind === 'CREDENTIAL_RECOVERY'
    ? [payload.expectedTarget.id]
    // Ownership transfer advances every extant user's authorization
    // generation because the shared-workspace authority root changes.
    : [...payload.candidateActorIds];
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  return sameStringArray(
    Object.keys(value).sort(),
    [...expectedKeys].sort(),
  );
}

function parseQuiescenceCount(value: unknown, label: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > MAX_HOST_RUNTIME_QUIESCENCE_COUNT
  ) {
    throw journalInvalid(`Host runtime ${label} is malformed`);
  }
  return value;
}

function parseQuiescenceTimestamp(
  value: unknown,
  label: string,
): { value: string; epochMs: number } {
  if (typeof value !== 'string') {
    throw journalInvalid(`Host runtime ${label} is malformed`);
  }
  const parsed = new Date(value);
  const epochMs = parsed.getTime();
  if (!Number.isFinite(epochMs) || parsed.toISOString() !== value) {
    throw journalInvalid(`Host runtime ${label} is malformed`);
  }
  return { value, epochMs };
}

function parseExactQuiescenceString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw journalInvalid(`Host runtime ${label} is malformed`);
  }
  return value;
}

function parseAgentJobQuiescence(
  value: unknown,
): AgentJobAuthorizationQuiescence {
  const raw = asObject(value);
  if (!hasExactKeys(raw, [
    'jobCount',
    'liveRuntimeCount',
    'persistedRuntimeSignalCount',
  ])) {
    throw journalInvalid('Agent job quiescence proof is malformed');
  }
  const jobCount = parseQuiescenceCount(raw.jobCount, 'agent job count');
  const liveRuntimeCount = parseQuiescenceCount(
    raw.liveRuntimeCount,
    'live agent job runtime count',
  );
  const persistedRuntimeSignalCount = parseQuiescenceCount(
    raw.persistedRuntimeSignalCount,
    'persisted agent job runtime signal count',
  );
  if (
    liveRuntimeCount > jobCount
    || persistedRuntimeSignalCount > jobCount
    || liveRuntimeCount + persistedRuntimeSignalCount > jobCount
  ) {
    throw journalInvalid('Agent job quiescence counts are inconsistent');
  }
  return {
    jobCount,
    liveRuntimeCount,
    persistedRuntimeSignalCount,
  };
}

function parseNativeHostRunQuiescence(
  value: unknown,
): HostAgentRunQuiescence {
  const raw = asObject(value);
  if (!hasExactKeys(raw, [
    'inMemoryAbortCount',
    'persistedRuntimeSignalCount',
    'recoveredCount',
    'runCount',
  ])) {
    throw journalInvalid('Native host-run quiescence proof is malformed');
  }
  const runCount = parseQuiescenceCount(raw.runCount, 'native host-run count');
  const inMemoryAbortCount = parseQuiescenceCount(
    raw.inMemoryAbortCount,
    'in-memory host-run abort count',
  );
  const persistedRuntimeSignalCount = parseQuiescenceCount(
    raw.persistedRuntimeSignalCount,
    'persisted host-run signal count',
  );
  const recoveredCount = parseQuiescenceCount(
    raw.recoveredCount,
    'recovered host-run count',
  );
  if (
    inMemoryAbortCount > runCount
    || persistedRuntimeSignalCount > runCount
    || recoveredCount > runCount
  ) {
    throw journalInvalid('Native host-run quiescence counts are inconsistent');
  }
  return {
    runCount,
    inMemoryAbortCount,
    persistedRuntimeSignalCount,
    recoveredCount,
  };
}

function parseOpenClawSessionResetProof(
  value: unknown,
): OpenClawHostRunQuiescence['sessions'][number] {
  const raw = asObject(value);
  if (!hasExactKeys(raw, [
    'beforeSessionId',
    'readbackSessionId',
    'reattestedSessionId',
    'resetAt',
    'resetSessionId',
    'rowCount',
    'rowIdentitySha256',
    'schemaVersion',
    'sessionKey',
  ]) || raw.schemaVersion !== 1) {
    throw journalInvalid('OpenClaw session-reset proof is malformed');
  }
  const sessionKey = parseExactQuiescenceString(
    raw.sessionKey,
    'OpenClaw session key',
    2_048,
  );
  if (!OPENCLAW_SESSION_KEY_PATTERN.test(sessionKey)) {
    throw journalInvalid('OpenClaw session-reset identity is malformed');
  }
  const beforeSessionId = raw.beforeSessionId === null
    ? null
    : parseExactQuiescenceString(
      raw.beforeSessionId,
      'OpenClaw prior session generation',
      255,
    );
  const resetSessionId = parseExactQuiescenceString(
    raw.resetSessionId,
    'OpenClaw reset session generation',
    255,
  );
  const readbackSessionId = parseExactQuiescenceString(
    raw.readbackSessionId,
    'OpenClaw readback session generation',
    255,
  );
  const reattestedSessionId = parseExactQuiescenceString(
    raw.reattestedSessionId,
    'OpenClaw reattested session generation',
    255,
  );
  const rowCount = parseQuiescenceCount(
    raw.rowCount,
    'OpenClaw session row count',
  );
  if (
    resetSessionId !== readbackSessionId
    || resetSessionId !== reattestedSessionId
    || (beforeSessionId !== null && beforeSessionId === resetSessionId)
    || typeof raw.rowIdentitySha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.rowIdentitySha256)
  ) {
    throw journalInvalid('OpenClaw session-reset evidence is inconsistent');
  }
  const resetAt = parseQuiescenceTimestamp(
    raw.resetAt,
    'OpenClaw session-reset timestamp',
  );
  return {
    schemaVersion: 1,
    sessionKey,
    beforeSessionId,
    resetSessionId,
    readbackSessionId,
    reattestedSessionId,
    rowCount,
    rowIdentitySha256: raw.rowIdentitySha256,
    resetAt: resetAt.value,
  };
}

function parseOpenClawHostRunQuiescence(
  value: unknown,
  affectedActorIds: readonly string[],
): OpenClawHostRunQuiescence {
  const raw = asObject(value);
  if (
    !hasExactKeys(raw, [
      'actorUserIds',
      'rowCount',
      'schemaVersion',
      'sessionCount',
      'sessions',
    ])
    || raw.schemaVersion !== 1
    || !Array.isArray(raw.actorUserIds)
    || raw.actorUserIds.some((entry) => typeof entry !== 'string')
    || !sameStringArray(raw.actorUserIds as string[], affectedActorIds)
    || !Array.isArray(raw.sessions)
    || raw.sessions.length > MAX_OPENCLAW_QUIESCENCE_SESSIONS
  ) {
    throw journalInvalid('OpenClaw host-run quiescence proof is malformed');
  }
  const rowCount = parseQuiescenceCount(
    raw.rowCount,
    'OpenClaw host-run row count',
  );
  const sessionCount = parseQuiescenceCount(
    raw.sessionCount,
    'OpenClaw host-run session count',
  );
  if (sessionCount !== raw.sessions.length) {
    throw journalInvalid('OpenClaw host-run session count is inconsistent');
  }

  const sessions: OpenClawHostRunQuiescence['sessions'] = [];
  const sessionKeys = new Set<string>();
  let observedRowCount = 0;
  for (const session of raw.sessions) {
    const parsed = parseOpenClawSessionResetProof(session);
    if (sessionKeys.has(parsed.sessionKey)) {
      throw journalInvalid('OpenClaw session-reset identities are not unique');
    }
    sessionKeys.add(parsed.sessionKey);
    observedRowCount += parsed.rowCount;
    if (
      !Number.isSafeInteger(observedRowCount)
      || observedRowCount > MAX_HOST_RUNTIME_QUIESCENCE_COUNT
    ) {
      throw journalInvalid('OpenClaw host-run row count is malformed');
    }
    sessions.push(parsed);
  }
  if (rowCount !== observedRowCount) {
    throw journalInvalid('OpenClaw host-run row count is inconsistent');
  }
  return {
    schemaVersion: 1,
    actorUserIds: [...affectedActorIds],
    rowCount,
    sessionCount,
    sessions,
  };
}

function parseHostRuntimeQuiescenceProof(
  value: unknown,
  payload: TransitionPayload,
): HostRuntimeQuiescenceProof | null {
  if (value === null || value === undefined) return null;
  const raw = asObject(value);
  const affectedActorIds = affectedActorIdsForPayload(payload);
  let encoded: string;
  try {
    encoded = JSON.stringify(raw);
  } catch {
    throw journalInvalid('Host runtime quiescence proof is not valid JSON');
  }
  if (
    raw.schemaVersion !== 1
    || !hasExactKeys(raw, ['affectedActorIds', 'attempts', 'schemaVersion'])
    || !Array.isArray(raw.affectedActorIds)
    || raw.affectedActorIds.some((entry) => typeof entry !== 'string')
    || !sameStringArray(raw.affectedActorIds as string[], affectedActorIds)
    || !Array.isArray(raw.attempts)
    || raw.attempts.length < 2
    || raw.attempts.length > MAX_HOST_RUNTIME_QUIESCENCE_ATTEMPTS
    || Buffer.byteLength(encoded, 'utf8') > 256 * 1024
  ) {
    throw journalInvalid('Host runtime quiescence proof is malformed');
  }
  const attempts: HostRuntimeQuiescenceAttempt[] = [];
  let previousRecordedAt = Number.NEGATIVE_INFINITY;
  for (const attempt of raw.attempts) {
    const entry = asObject(attempt);
    if (
      !hasExactKeys(entry, [
        'agentJobs',
        'nativeHostRuns',
        'openClawHostRuns',
        'recordedAt',
      ])
    ) {
      throw journalInvalid('Host runtime quiescence attempt is malformed');
    }
    const recordedAt = parseQuiescenceTimestamp(
      entry.recordedAt,
      'quiescence-attempt timestamp',
    );
    if (recordedAt.epochMs < previousRecordedAt) {
      throw journalInvalid('Host runtime quiescence timestamps are not monotonic');
    }
    previousRecordedAt = recordedAt.epochMs;
    attempts.push({
      recordedAt: recordedAt.value,
      agentJobs: parseAgentJobQuiescence(entry.agentJobs),
      nativeHostRuns: parseNativeHostRunQuiescence(entry.nativeHostRuns),
      openClawHostRuns: parseOpenClawHostRunQuiescence(
        entry.openClawHostRuns,
        affectedActorIds,
      ),
    });
  }
  return {
    schemaVersion: 1,
    affectedActorIds,
    attempts,
  };
}

function requireHostRuntimeQuiescenceProof(
  value: unknown,
  payload: TransitionPayload,
): HostRuntimeQuiescenceProof {
  const proof = parseHostRuntimeQuiescenceProof(value, payload);
  if (!proof) {
    throw journalInvalid('Host runtime quiescence proof is missing');
  }
  return proof;
}

function optionalTemporal(value: unknown, label: string): Date | string | null | undefined {
  if (value === undefined || value === null) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'string' && Number.isFinite(new Date(value).getTime())) return value;
  throw journalInvalid(`Committed authorization ${label} is malformed`);
}

function parseCommittedResult(
  row: TransitionRow,
  payload: TransitionPayload,
): ProjectAuthorizationUserUpdateResult | ProjectOwnershipTransferResult {
  const raw = asObject(row.result);
  if (
    payload.kind === 'USER_AUTHORIZATION_UPDATE'
    || payload.kind === 'CREDENTIAL_RECOVERY'
  ) {
    if (!sameStringArray(
      Object.keys(raw).sort(),
      ['authorizationReasons', 'existing', 'user'],
    )) {
      throw journalInvalid('Committed user authorization result fields are malformed');
    }
    let existing: AuthorizationUserSnapshot;
    let user: AuthorizationUserSnapshot;
    const rawUser = asObject(raw.user);
    try {
      existing = userSnapshot(raw.existing);
      user = userSnapshot(rawUser);
    } catch {
      throw journalInvalid('Committed user authorization result is malformed');
    }
    if (!Array.isArray(raw.authorizationReasons)) {
      throw journalInvalid('Committed user authorization reasons are malformed');
    }
    const reasons = raw.authorizationReasons.map((value) => (
      exactString(value, 'committed authorization reason') as AuthorizationChangeReason
    ));
    const expectedUser: AuthorizationUserSnapshot = payload.kind === 'USER_AUTHORIZATION_UPDATE'
      ? {
        ...payload.expectedTarget,
        ...payload.update,
        authorizationVersion: payload.expectedTarget.authorizationVersion + 1,
      }
      : {
        ...payload.expectedTarget,
        authorizationVersion: payload.expectedTarget.authorizationVersion + 1,
      };
    const expectedReasons: AuthorizationChangeReason[] =
      payload.kind === 'USER_AUTHORIZATION_UPDATE'
        ? payload.authorizationReasons
        : ['credential_recovery'];
    if (
      !sameAuthorizationSnapshot(existing, payload.expectedTarget, true)
      || !sameAuthorizationSnapshot(user, expectedUser, true)
      || !sameStringArray(reasons, expectedReasons)
    ) {
      throw journalInvalid('Committed user authorization result drifted from its request');
    }
    const avatarPath = rawUser.avatarPath;
    if (avatarPath !== undefined && avatarPath !== null && typeof avatarPath !== 'string') {
      throw journalInvalid('Committed user avatar path is malformed');
    }
    return Object.freeze({
      user: Object.freeze({
        ...user,
        lastLoginAt: optionalTemporal(rawUser.lastLoginAt, 'last login time'),
        createdAt: optionalTemporal(rawUser.createdAt, 'creation time') as Date | string | undefined,
        avatarPath: avatarPath as string | null | undefined,
      }),
      existing,
      authorizationReasons: Object.freeze([...reasons]) as AuthorizationChangeReason[],
    });
  }

  if (!sameStringArray(
    Object.keys(raw).sort(),
    ['changedAuthorizations', 'targetEmail'],
  )) {
    throw journalInvalid('Committed ownership result fields are malformed');
  }
  if (!Array.isArray(raw.changedAuthorizations)) {
    throw journalInvalid('Committed ownership generations are malformed');
  }
  const changedAuthorizations = raw.changedAuthorizations.map((value) => {
    const entry = asObject(value);
    if (!sameStringArray(Object.keys(entry).sort(), ['authorizationVersion', 'id'])) {
      throw journalInvalid('Committed ownership generation entry is malformed');
    }
    return Object.freeze({
      id: exactString(entry.id, 'committed user identity'),
      authorizationVersion: exactInteger(
        entry.authorizationVersion,
        'committed authorization generation',
      ),
    });
  });
  const canonicalIds = [...new Set(changedAuthorizations.map((entry) => entry.id))].sort();
  if (
    !sameStringArray(changedAuthorizations.map((entry) => entry.id), canonicalIds)
    || raw.targetEmail !== payload.expectedTarget.email
    || changedAuthorizations.find((entry) => entry.id === payload.expectedOwner.id)
      ?.authorizationVersion !== payload.expectedOwner.authorizationVersion + 1
    || changedAuthorizations.find((entry) => entry.id === payload.expectedTarget.id)
      ?.authorizationVersion !== payload.expectedTarget.authorizationVersion + 1
  ) {
    throw journalInvalid('Committed ownership result drifted from its request');
  }
  return Object.freeze({
    changedAuthorizations: Object.freeze(changedAuthorizations) as Array<{
      id: string;
      authorizationVersion: number;
    }>,
    targetEmail: payload.expectedTarget.email,
  });
}

function assertProjectManifest(
  manifest: TransitionProjectRow,
  identity: any,
  dependencies: TransitionDependencies,
): ProjectIdentityRecord {
  if (
    !identity
    || identity.id !== manifest.projectIdentityId
    || identity.workspaceOwnerId !== manifest.workspaceOwnerId
    || identity.projectName !== manifest.projectName
    || identity.canonicalRoot !== manifest.canonicalRoot
    || identity.rootDevice !== manifest.rootDevice
    || identity.rootInode !== manifest.rootInode
    || identity.rootBirthtimeNs !== manifest.rootBirthtimeNs
    || Number(identity.generation) !== manifest.projectGeneration
    || (identity.lifecycleStatus || 'ACTIVE') !== 'ACTIVE'
    || identity.legacyOpenClawMigrationStatus === 'PENDING'
  ) {
    throw new ProjectAuthorizationTransitionError(
      PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
      `Project ${manifest.projectIdentityId} changed during authorization cleanup`,
      503,
      false,
    );
  }
  dependencies.assertProjectRoot(identity as ProjectIdentityRecord, manifest.canonicalRoot);
  return identity as ProjectIdentityRecord;
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as any).code === 'P2002',
  );
}

function normalizeResult<T>(value: unknown): T {
  return value as T;
}

export function createProjectAuthorizationTransitionCoordinator(
  overrides: Partial<TransitionDependencies> = {},
) {
  const dependencies: TransitionDependencies = { ...defaultDependencies, ...overrides };
  const portalInstanceId = `portal-auth-transition:${process.pid}:${dependencies.randomUUID()}`;
  const inFlight = new Map<string, Promise<unknown>>();
  const retainedAdmissions = new Map<string, WorkspaceAuthorizationFenceController>();

  const loadTransition = async (id: string): Promise<TransitionRow> => {
    const row = await dependencies.database.projectAuthorizationTransition.findUnique({
      where: { id },
      include: { projects: { orderBy: { projectIdentityId: 'asc' } } },
    }) as TransitionRow | null;
    if (!row || row.singletonKey !== TRANSITION_SINGLETON_KEY) {
      throw new ProjectAuthorizationTransitionError(
        'PROJECT_AUTHORIZATION_TRANSITION_NOT_FOUND',
        'Authorization transition journal disappeared',
        503,
        false,
      );
    }
    parsePayload(row);
    return row;
  };

  const acquireLease = async (id: string): Promise<TransitionLease> => {
    const tokenHash = crypto.createHash('sha256')
      .update(dependencies.randomBytes(32))
      .digest('hex');
    const now = dependencies.now();
    const leaseExpiresAt = new Date(now.getTime() + TRANSITION_LEASE_MS);
    const claimed = await dependencies.database.projectAuthorizationTransition.updateMany({
      where: {
        id,
        phase: { not: 'COMPLETE' },
        OR: [
          { leaseOwner: null, leaseTokenHash: null, leaseExpiresAt: null },
          { leaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        leaseOwner: portalInstanceId,
        leaseTokenHash: tokenHash,
        leaseExpiresAt,
      },
    });
    if (claimed.count !== 1) {
      throw new ProjectAuthorizationTransitionError(
        PROJECT_AUTHORIZATION_TRANSITION_ACTIVE_CODE,
        'Another Portal process owns the authorization transition lease',
        409,
        true,
      );
    }

    let leaseLost = false;
    let renewalRunning = false;
    const renew = async (): Promise<void> => {
      if (leaseLost || renewalRunning) return;
      renewalRunning = true;
      try {
        const renewalNow = dependencies.now();
        const renewed = await dependencies.database.projectAuthorizationTransition.updateMany({
          where: {
            id,
            phase: { not: 'COMPLETE' },
            leaseOwner: portalInstanceId,
            leaseTokenHash: tokenHash,
            leaseExpiresAt: { gt: renewalNow },
          },
          data: {
            leaseExpiresAt: new Date(renewalNow.getTime() + TRANSITION_LEASE_MS),
          },
        });
        if (renewed.count !== 1) leaseLost = true;
      } catch {
        leaseLost = true;
      } finally {
        renewalRunning = false;
      }
    };
    const interval = setInterval(() => {
      void renew();
    }, TRANSITION_RENEW_MS);
    interval.unref();

    return {
      owner: portalInstanceId,
      tokenHash,
      async assertHeld() {
        if (leaseLost) {
          throw new ProjectAuthorizationTransitionError(
            'PROJECT_AUTHORIZATION_TRANSITION_LEASE_LOST',
            'Authorization transition lease was lost',
            503,
            true,
          );
        }
        const current = await dependencies.database.projectAuthorizationTransition.findFirst({
          where: {
            id,
            phase: { not: 'COMPLETE' },
            leaseOwner: portalInstanceId,
            leaseTokenHash: tokenHash,
            leaseExpiresAt: { gt: dependencies.now() },
          },
          select: { id: true },
        });
        if (!current) {
          leaseLost = true;
          throw new ProjectAuthorizationTransitionError(
            'PROJECT_AUTHORIZATION_TRANSITION_LEASE_LOST',
            'Authorization transition lease was lost',
            503,
            true,
          );
        }
      },
      async release() {
        clearInterval(interval);
        await dependencies.database.projectAuthorizationTransition.updateMany({
          where: {
            id,
            phase: { not: 'COMPLETE' },
            leaseOwner: portalInstanceId,
            leaseTokenHash: tokenHash,
          },
          data: {
            leaseOwner: null,
            leaseTokenHash: null,
            leaseExpiresAt: null,
          },
        }).catch(() => {});
      },
    };
  };

  const advanceToQuiescing = async (row: TransitionRow, lease: TransitionLease): Promise<void> => {
    await lease.assertHeld();
    const advanced = await dependencies.database.projectAuthorizationTransition.updateMany({
      where: {
        id: row.id,
        phase: 'PREPARED',
        leaseOwner: lease.owner,
        leaseTokenHash: lease.tokenHash,
      },
      data: {
        phase: 'QUIESCING',
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    if (advanced.count !== 1) {
      throw new ProjectAuthorizationTransitionError(
        PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
        'Authorization transition phase changed concurrently',
        503,
        false,
      );
    }
  };

  const verifyAllManifests = async (
    row: TransitionRow,
    requireQuiesced: boolean,
  ): Promise<void> => {
    const projects = row.projects || [];
    const identities = await dependencies.database.projectIdentity.findMany({
      orderBy: { id: 'asc' },
    });
    const manifestIds = projects.map((entry) => entry.projectIdentityId);
    const identityIds = identities.map((entry: any) => String(entry?.id || ''));
    if (
      manifestIds.length !== identityIds.length
      || manifestIds.some((id, index) => id !== identityIds[index])
    ) {
      throw new ProjectAuthorizationTransitionError(
        PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
        'The Project identity set changed during authorization cleanup',
        503,
        false,
      );
    }
    for (const [index, manifest] of projects.entries()) {
      if (requireQuiesced && manifest.status !== 'QUIESCED') {
        throw new ProjectAuthorizationTransitionError(
          'PROJECT_AUTHORIZATION_TRANSITION_QUIESCENCE_UNPROVEN',
          `Project ${manifest.projectIdentityId} lacks quiescence proof`,
          503,
          false,
        );
      }
      assertProjectManifest(manifest, identities[index], dependencies);
    }
  };

  const quiesce = async (
    row: TransitionRow,
    payload: TransitionPayload,
    lease: TransitionLease,
    admission: WorkspaceAuthorizationFenceController,
  ): Promise<void> => {
    await lease.assertHeld();
    const affectedActorIds = affectedActorIdsForPayload(payload);
    const quiesceHostRuntime = async (): Promise<HostRuntimeQuiescenceAttempt> => {
      const agentJobs = await dependencies.quiesceAgentJobs(affectedActorIds);
      await lease.assertHeld();
      const nativeHostRuns = await dependencies.quiesceHostRuns(affectedActorIds);
      await lease.assertHeld();
      const openClawHostRuns = await dependencies.quiesceOpenClawHostRuns(
        affectedActorIds,
      );
      await lease.assertHeld();
      return {
        recordedAt: dependencies.now().toISOString(),
        agentJobs,
        nativeHostRuns,
        openClawHostRuns,
      };
    };

    // First signal/reset every runtime already visible behind the closed
    // admission gate. Waiting for mutation leases before issuing these signals
    // can deadlock forever on the exact long-running provider turn being
    // revoked.
    const preDrainAttempt = await quiesceHostRuntime();

    // A request admitted just before the fence can reach its durable journal
    // after the first inventory. Let all such requests cross their settlement
    // boundary, then run a second authoritative inventory/reset so none can
    // escape between the first snapshot and the authorization commit.
    await admission.waitForMutationDrain();
    await lease.assertHeld();
    const postDrainAttempt = await quiesceHostRuntime();

    const previousHostProof = parseHostRuntimeQuiescenceProof(
      row.hostRuntimeQuiescenceProof,
      payload,
    );
    const hostRuntimeQuiescenceProof: HostRuntimeQuiescenceProof = {
      schemaVersion: 1,
      affectedActorIds,
      attempts: [
        ...(previousHostProof?.attempts || []),
        preDrainAttempt,
        postDrainAttempt,
      ],
    };
    if (
      hostRuntimeQuiescenceProof.attempts.length
      > MAX_HOST_RUNTIME_QUIESCENCE_ATTEMPTS
    ) {
      throw new ProjectAuthorizationTransitionError(
        'PROJECT_AUTHORIZATION_TRANSITION_QUIESCENCE_UNPROVEN',
        'Host runtime quiescence exceeded the bounded recovery history',
        503,
        false,
      );
    }
    const hostProofCommitted = await dependencies.database.projectAuthorizationTransition.updateMany({
      where: {
        id: row.id,
        phase: 'QUIESCING',
        leaseOwner: lease.owner,
        leaseTokenHash: lease.tokenHash,
      },
      data: {
        hostRuntimeQuiescenceProof,
      },
    });
    if (hostProofCommitted.count !== 1) {
      throw new ProjectAuthorizationTransitionError(
        'PROJECT_AUTHORIZATION_TRANSITION_QUIESCENCE_UNPROVEN',
        'Host runtime quiescence proof could not be committed',
        503,
        false,
      );
    }

    for (const manifest of row.projects || []) {
      if (manifest.status === 'QUIESCED') {
        const identity = await dependencies.database.projectIdentity.findUnique({
          where: { id: manifest.projectIdentityId },
        });
        assertProjectManifest(manifest, identity, dependencies);
        continue;
      }
      await lease.assertHeld();
      const identity = await dependencies.database.projectIdentity.findUnique({
        where: { id: manifest.projectIdentityId },
      });
      const attestedIdentity = assertProjectManifest(manifest, identity, dependencies);
      const projectCleanup = await dependencies.cleanupProject({
        authenticatedActorId: row.initiatedByUserId,
        workspaceOwnerId: manifest.workspaceOwnerId,
        projectIdentity: attestedIdentity,
        candidateActorIds: payload.candidateActorIds,
        lifecycleReason: 'authorization_change',
      });
      await lease.assertHeld();
      const afterIdentity = await dependencies.database.projectIdentity.findUnique({
        where: { id: manifest.projectIdentityId },
      });
      assertProjectManifest(manifest, afterIdentity, dependencies);
      const marked = await dependencies.database.projectAuthorizationTransitionProject.updateMany({
        where: {
          transitionId: row.id,
          projectIdentityId: manifest.projectIdentityId,
          status: 'PENDING',
        },
        data: {
          status: 'QUIESCED',
          quiescedAt: dependencies.now(),
          quiescenceEvidence: {
            schemaVersion: 1,
            projectCleanup,
          },
        },
      });
      if (marked.count !== 1) {
        const current = await dependencies.database.projectAuthorizationTransitionProject.findUnique({
          where: {
            transitionId_projectIdentityId: {
              transitionId: row.id,
              projectIdentityId: manifest.projectIdentityId,
            },
          },
        });
        if (!current || current.status !== 'QUIESCED' || !current.quiescenceEvidence) {
          throw new ProjectAuthorizationTransitionError(
            'PROJECT_AUTHORIZATION_TRANSITION_QUIESCENCE_UNPROVEN',
            `Project ${manifest.projectIdentityId} quiescence proof could not be committed`,
            503,
            false,
          );
        }
      }
    }

    await lease.assertHeld();
    const refreshed = await loadTransition(row.id);
    requireHostRuntimeQuiescenceProof(
      refreshed.hostRuntimeQuiescenceProof,
      payload,
    );
    await verifyAllManifests(refreshed, true);

    const gatewayBefore = await dependencies.gateway.inspect();
    const gatewayWasActive = row.gatewayWasActive === true || gatewayBefore.active;
    const recorded = await dependencies.database.projectAuthorizationTransition.updateMany({
      where: {
        id: row.id,
        phase: 'QUIESCING',
        leaseOwner: lease.owner,
        leaseTokenHash: lease.tokenHash,
      },
      data: {
        gatewayWasActive,
      },
    });
    if (recorded.count !== 1) {
      throw new ProjectAuthorizationTransitionError(
        PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
        'Gateway stop intent could not be committed',
        503,
        false,
      );
    }
    await lease.assertHeld();
    const proof = await dependencies.gateway.stop();
    await lease.assertHeld();
    const fenced = await dependencies.database.projectAuthorizationTransition.updateMany({
      where: {
        id: row.id,
        phase: 'QUIESCING',
        leaseOwner: lease.owner,
        leaseTokenHash: lease.tokenHash,
      },
      data: {
        phase: 'PROVIDER_FENCED',
        gatewayWasActive: gatewayWasActive || proof.priorActive,
        gatewayFenceProof: proof,
      },
    });
    if (fenced.count !== 1) {
      throw new ProjectAuthorizationTransitionError(
        PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
        'Gateway fence proof could not be committed',
        503,
        false,
      );
    }
  };

  const commitUserUpdate = async (
    row: TransitionRow,
    payload: UserAuthorizationTransitionPayload,
    lease: TransitionLease,
  ): Promise<ProjectAuthorizationUserUpdateResult> => {
    await lease.assertHeld();
    return dependencies.database.$transaction(async (transaction: any) => {
      const currentTransition = await transaction.projectAuthorizationTransition.findFirst({
        where: {
          id: row.id,
          phase: 'PROVIDER_FENCED',
          leaseOwner: lease.owner,
          leaseTokenHash: lease.tokenHash,
        },
      });
      if (!currentTransition) {
        throw new ProjectAuthorizationTransitionError(
          PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
          'Authorization transition commit authority changed',
          503,
          false,
        );
      }
      const existingRow = await transaction.user.findUnique({
        where: { id: payload.expectedTarget.id },
      });
      if (!sameAuthorizationSnapshot(existingRow, payload.expectedTarget, true)) {
        throw new ProjectAuthorizationTransitionError(
          PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
          'Target user changed before authorization commit',
          409,
          false,
        );
      }
      const changed = await transaction.user.updateMany({
        where: {
          id: payload.expectedTarget.id,
          authorizationVersion: payload.expectedTarget.authorizationVersion,
        },
        data: {
          ...payload.update,
          ...(payload.authorizationReasons.length > 0
            ? { authorizationVersion: { increment: 1 } }
            : {}),
        },
      });
      if (changed.count !== 1) {
        throw new ProjectAuthorizationTransitionError(
          PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
          'Target authorization generation changed before commit',
          409,
          false,
        );
      }
      const userRow = await transaction.user.findUnique({
        where: { id: payload.expectedTarget.id },
        select: {
          id: true,
          email: true,
          username: true,
          firstName: true,
          lastName: true,
          role: true,
          accountStatus: true,
          isActive: true,
          sandboxEnabled: true,
          authorizationVersion: true,
          lastLoginAt: true,
          createdAt: true,
          avatarPath: true,
        },
      });
      const committedAt = dependencies.now();
      const restoredPortalAccess =
        !canAccessPortal(
          payload.expectedTarget.accountStatus,
          payload.expectedTarget.isActive,
        )
        && canAccessPortal(userRow.accountStatus, userRow.isActive);
      if (restoredPortalAccess) {
        await transaction.session.deleteMany({
          where: { userId: payload.expectedTarget.id },
        });
        await transaction.twoFactorChallenge.deleteMany({
          where: { userId: payload.expectedTarget.id },
        });
        await transaction.emailVerificationCode.deleteMany({
          where: { userId: payload.expectedTarget.id },
        });
        await transaction.passwordResetToken.updateMany({
          where: {
            userId: payload.expectedTarget.id,
            usedAt: null,
          },
          data: { usedAt: committedAt },
        });
      }
      const result: ProjectAuthorizationUserUpdateResult = {
        user: {
          ...userSnapshot(userRow),
          lastLoginAt: userRow.lastLoginAt,
          createdAt: userRow.createdAt,
          avatarPath: userRow.avatarPath,
        },
        existing: payload.expectedTarget,
        authorizationReasons: [...payload.authorizationReasons],
      };
      await transaction.projectAuthorizationTransition.update({
        where: { id: row.id },
        data: {
          phase: 'COMMITTED',
          committedAt,
          result,
        },
      });
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  };

  const commitCredentialRecovery = async (
    row: TransitionRow,
    payload: CredentialRecoveryTransitionPayload,
    lease: TransitionLease,
  ): Promise<ProjectCredentialRecoveryResult> => {
    await lease.assertHeld();
    return dependencies.database.$transaction(async (transaction: any) => {
      const currentTransition = await transaction.projectAuthorizationTransition.findFirst({
        where: {
          id: row.id,
          phase: 'PROVIDER_FENCED',
          leaseOwner: lease.owner,
          leaseTokenHash: lease.tokenHash,
        },
      });
      if (!currentTransition) {
        throw new ProjectAuthorizationTransitionError(
          PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
          'Credential-recovery commit authority changed',
          503,
          false,
        );
      }
      const existingRow = await transaction.user.findUnique({
        where: { id: payload.expectedTarget.id },
      });
      const storedBackupCodes = existingRow?.twoFactorBackupCodes == null
        ? null
        : String(existingRow.twoFactorBackupCodes);
      if (
        !sameAuthorizationSnapshot(existingRow, payload.expectedTarget, true)
        || existingRow?.twoFactorEnabled !== true
        || existingRow?.twoFactorMethod !== 'email'
        || credentialStateDigest(
          'passwordHash',
          typeof existingRow?.passwordHash === 'string' ? existingRow.passwordHash : null,
        ) !== payload.intent.passwordHashDigest
        || credentialStateDigest('backupCodes', storedBackupCodes)
          !== payload.intent.backupCodesDigest
      ) {
        throw new ProjectAuthorizationTransitionError(
          PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
          'Credential-recovery account state changed before commit',
          409,
          false,
        );
      }
      const challenge = await transaction.twoFactorChallenge.findUnique({
        where: { id: payload.intent.challengeId },
      });
      if (
        !challenge
        || challenge.userId !== payload.expectedTarget.id
        || challenge.tokenHash !== payload.intent.challengeTokenHash
        || !(challenge.consumedAt instanceof Date)
      ) {
        throw new ProjectAuthorizationTransitionError(
          PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
          'Credential-recovery challenge proof changed before commit',
          409,
          false,
        );
      }

      const disabled = await transaction.user.updateMany({
        where: {
          id: payload.expectedTarget.id,
          authorizationVersion: payload.expectedTarget.authorizationVersion,
          twoFactorEnabled: true,
          twoFactorMethod: 'email',
        },
        data: {
          twoFactorEnabled: false,
          twoFactorSecret: null,
          twoFactorBackupCodes: null,
          twoFactorMethod: null,
          twoFactorLastUsedStep: null,
          authorizationVersion: { increment: 1 },
        },
      });
      if (disabled.count !== 1) {
        throw new ProjectAuthorizationTransitionError(
          PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
          'Credential-recovery authorization generation changed before commit',
          409,
          false,
        );
      }

      await transaction.emailVerificationCode.deleteMany({
        where: { userId: payload.expectedTarget.id },
      });
      await transaction.twoFactorChallenge.deleteMany({
        where: { userId: payload.expectedTarget.id },
      });
      await transaction.session.deleteMany({
        where: { userId: payload.expectedTarget.id },
      });
      await transaction.passwordResetToken.updateMany({
        where: { userId: payload.expectedTarget.id, usedAt: null },
        data: { usedAt: dependencies.now() },
      });
      await transaction.activityLog.create({
        data: {
          userId: payload.expectedTarget.id,
          action: 'EMAIL_2FA_EMERGENCY_RECOVERY',
          resource: 'auth',
          severity: 'ERROR',
          ipAddress: payload.intent.ipAddress,
          userAgent: payload.intent.userAgent,
          translatedMessage:
            'Email Code 2FA disabled through unavailable-mail recovery; all sessions invalidated',
          metadata: {
            method: 'email',
            reason: 'mail_unavailable_no_backup_codes',
            sessionsInvalidated: true,
            requiresFreshLogin: true,
            durableAuthorizationTransitionId: row.id,
          },
        },
      });

      const userRow = await transaction.user.findUnique({
        where: { id: payload.expectedTarget.id },
        select: {
          id: true,
          email: true,
          username: true,
          firstName: true,
          lastName: true,
          role: true,
          accountStatus: true,
          isActive: true,
          sandboxEnabled: true,
          authorizationVersion: true,
          lastLoginAt: true,
          createdAt: true,
          avatarPath: true,
        },
      });
      const result: ProjectCredentialRecoveryResult = {
        user: {
          ...userSnapshot(userRow),
          lastLoginAt: userRow.lastLoginAt,
          createdAt: userRow.createdAt,
          avatarPath: userRow.avatarPath,
        },
        existing: payload.expectedTarget,
        authorizationReasons: ['credential_recovery'],
      };
      await transaction.projectAuthorizationTransition.update({
        where: { id: row.id },
        data: {
          phase: 'COMMITTED',
          committedAt: dependencies.now(),
          result,
        },
      });
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  };

  const commitOwnershipTransfer = async (
    row: TransitionRow,
    payload: OwnershipTransferTransitionPayload,
    lease: TransitionLease,
  ): Promise<ProjectOwnershipTransferResult> => {
    await lease.assertHeld();
    return dependencies.database.$transaction(async (transaction: any) => {
      const currentTransition = await transaction.projectAuthorizationTransition.findFirst({
        where: {
          id: row.id,
          phase: 'PROVIDER_FENCED',
          leaseOwner: lease.owner,
          leaseTokenHash: lease.tokenHash,
        },
      });
      if (!currentTransition) {
        throw new ProjectAuthorizationTransitionError(
          PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
          'Ownership transition commit authority changed',
          503,
          false,
        );
      }
      const [ownerRow, targetRow] = await Promise.all([
        transaction.user.findUnique({ where: { id: payload.expectedOwner.id } }),
        transaction.user.findUnique({ where: { id: payload.expectedTarget.id } }),
      ]);
      if (
        !sameAuthorizationSnapshot(ownerRow, payload.expectedOwner, false)
        || !sameAuthorizationSnapshot(targetRow, payload.expectedTarget, false)
      ) {
        throw new ProjectAuthorizationTransitionError(
          PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
          'Ownership participants changed before commit',
          409,
          false,
        );
      }
      const demoted = await transaction.user.updateMany({
        where: {
          id: payload.expectedOwner.id,
          role: payload.expectedOwner.role,
          authorizationVersion: payload.expectedOwner.authorizationVersion,
        },
        data: { role: 'SUB_ADMIN' },
      });
      const promoted = await transaction.user.updateMany({
        where: {
          id: payload.expectedTarget.id,
          role: payload.expectedTarget.role,
          authorizationVersion: payload.expectedTarget.authorizationVersion,
        },
        data: { role: 'OWNER', accountStatus: ACTIVE_STATUS, isActive: true },
      });
      if (demoted.count !== 1 || promoted.count !== 1) {
        throw new ProjectAuthorizationTransitionError(
          PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
          'Ownership participants changed during commit',
          409,
          false,
        );
      }
      await transaction.user.updateMany({
        data: { authorizationVersion: { increment: 1 } },
      });
      const changedRows = await transaction.user.findMany({
        select: { id: true, authorizationVersion: true },
        orderBy: { id: 'asc' },
      });
      const result: ProjectOwnershipTransferResult = {
        changedAuthorizations: changedRows.map((entry: any) => ({
          id: exactString(entry.id, 'changed user identity'),
          authorizationVersion: exactInteger(
            entry.authorizationVersion,
            'changed authorization generation',
          ),
        })),
        targetEmail: payload.expectedTarget.email,
      };
      await transaction.projectAuthorizationTransition.update({
        where: { id: row.id },
        data: {
          phase: 'COMMITTED',
          committedAt: dependencies.now(),
          result,
        },
      });
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  };

  const verifyCommittedState = async (
    payload: TransitionPayload,
    result: ProjectAuthorizationUserUpdateResult | ProjectOwnershipTransferResult,
  ): Promise<void> => {
    if (
      payload.kind === 'USER_AUTHORIZATION_UPDATE'
      || payload.kind === 'CREDENTIAL_RECOVERY'
    ) {
      const current = await dependencies.database.user.findUnique({
        where: { id: payload.expectedTarget.id },
      });
      if (
        !sameAuthorizationSnapshot(
          current,
          (result as ProjectAuthorizationUserUpdateResult).user,
          true,
        )
      ) {
        throw new ProjectAuthorizationTransitionError(
          PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
          'Committed user authorization state could not be re-attested',
          503,
          false,
        );
      }
      const userResult = result as ProjectAuthorizationUserUpdateResult;
      const requiresArtifactRevocation =
        payload.kind === 'CREDENTIAL_RECOVERY'
        || (
          payload.kind === 'USER_AUTHORIZATION_UPDATE'
          && !canAccessPortal(
            payload.expectedTarget.accountStatus,
            payload.expectedTarget.isActive,
          )
          && canAccessPortal(
            userResult.user.accountStatus,
            userResult.user.isActive,
          )
        );
      if (requiresArtifactRevocation) {
        const [sessions, challenges, emailCodes, unusedPasswordResets] =
          await Promise.all([
            dependencies.database.session.count({
              where: { userId: payload.expectedTarget.id },
            }),
            dependencies.database.twoFactorChallenge.count({
              where: { userId: payload.expectedTarget.id },
            }),
            dependencies.database.emailVerificationCode.count({
              where: { userId: payload.expectedTarget.id },
            }),
            dependencies.database.passwordResetToken.count({
              where: { userId: payload.expectedTarget.id, usedAt: null },
            }),
          ]);
        if (
          sessions !== 0
          || challenges !== 0
          || emailCodes !== 0
          || unusedPasswordResets !== 0
        ) {
          throw new ProjectAuthorizationTransitionError(
            PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
            'Committed authentication-artifact revocation could not be re-attested',
            503,
            false,
          );
        }
      }
      if (
        payload.kind === 'CREDENTIAL_RECOVERY'
        && (
          current?.twoFactorEnabled !== false
          || current?.twoFactorSecret !== null
          || current?.twoFactorBackupCodes !== null
          || current?.twoFactorMethod !== null
          || current?.twoFactorLastUsedStep !== null
        )
      ) {
        throw new ProjectAuthorizationTransitionError(
          PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
          'Committed credential revocation could not be re-attested',
          503,
          false,
        );
      }
      return;
    }

    const ownership = result as ProjectOwnershipTransferResult;
    const users = await dependencies.database.user.findMany({
      select: {
        id: true,
        role: true,
        accountStatus: true,
        isActive: true,
        authorizationVersion: true,
      },
      orderBy: { id: 'asc' },
    });
    const expectedIds = ownership.changedAuthorizations.map((entry) => entry.id);
    const actualIds = users.map((entry: any) => String(entry?.id || ''));
    const expectedVersions = ownership.changedAuthorizations.map(
      (entry) => entry.authorizationVersion,
    );
    const actualVersions = users.map((entry: any) => Number(entry?.authorizationVersion));
    const owner = users.find((entry: any) => entry.id === payload.expectedOwner.id);
    const target = users.find((entry: any) => entry.id === payload.expectedTarget.id);
    if (
      !sameStringArray(actualIds, expectedIds)
      || actualVersions.some((version, index) => version !== expectedVersions[index])
      || owner?.role !== 'SUB_ADMIN'
      || target?.role !== 'OWNER'
      || target?.accountStatus !== ACTIVE_STATUS
      || target?.isActive !== true
    ) {
      throw new ProjectAuthorizationTransitionError(
        PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
        'Committed ownership state could not be re-attested',
        503,
        false,
      );
    }
  };

  const complete = async (
    row: TransitionRow,
    payload: TransitionPayload,
    lease: TransitionLease,
  ): Promise<unknown> => {
    await lease.assertHeld();
    requireHostRuntimeQuiescenceProof(row.hostRuntimeQuiescenceProof, payload);
    const result = parseCommittedResult(row, payload);
    await verifyCommittedState(payload, result);
    await lease.assertHeld();

    // Publication is an idempotent revocation signal: recovery may emit the
    // same committed generation again, but can never emit a newer or invented
    // generation. Publish before the fallible provider release so every old
    // interactive authority is already disconnected even when restart fails.
    if (
      payload.kind === 'USER_AUTHORIZATION_UPDATE'
      || payload.kind === 'CREDENTIAL_RECOVERY'
    ) {
      const userResult = result as ProjectAuthorizationUserUpdateResult;
      if (userResult.authorizationReasons.length > 0) {
        dependencies.publish({
          type: 'authorization_changed',
          userId: userResult.user.id,
          authorizationVersion: userResult.user.authorizationVersion,
          reasons: userResult.authorizationReasons,
        });
        const sessionsWereDeleted = userResult.authorizationReasons.includes('credential_recovery')
          || (
            !canAccessPortal(
              userResult.existing.accountStatus,
              userResult.existing.isActive,
            )
            && canAccessPortal(
              userResult.user.accountStatus,
              userResult.user.isActive,
            )
          );
        if (sessionsWereDeleted) {
          dependencies.publishSessions({
            userId: userResult.user.id,
            reason: userResult.authorizationReasons.includes('credential_recovery')
              ? 'credential_recovery'
              : 'authorization_transition',
          });
        }
      }
    } else {
      const ownershipResult = result as ProjectOwnershipTransferResult;
      for (const changed of ownershipResult.changedAuthorizations) {
        dependencies.publish({
          type: 'authorization_changed',
          userId: changed.id,
          authorizationVersion: changed.authorizationVersion,
          reasons: ['role', 'workspace_scope'],
        });
      }
    }

    await lease.assertHeld();
    await dependencies.gateway.release(row.gatewayWasActive === true);
    await lease.assertHeld();

    const completed = await dependencies.database.projectAuthorizationTransition.updateMany({
      where: {
        id: row.id,
        phase: 'COMMITTED',
        leaseOwner: lease.owner,
        leaseTokenHash: lease.tokenHash,
      },
      data: {
        phase: 'COMPLETE',
        completedAt: dependencies.now(),
        leaseOwner: null,
        leaseTokenHash: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    if (completed.count !== 1) {
      throw new ProjectAuthorizationTransitionError(
        PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
        'Authorization transition completion could not be committed',
        503,
        false,
      );
    }
    return result;
  };

  const runTransition = async (id: string): Promise<unknown> => {
    const existing = inFlight.get(id);
    if (existing) return existing;
    const operation = (async () => {
      const lease = await acquireLease(id);
      let admission = retainedAdmissions.get(id) || null;
      let transitionCompleted = false;
      try {
        if (!admission) {
          admission = dependencies.closeAdmission();
          retainedAdmissions.set(id, admission);
        }
        for (;;) {
          const row = await loadTransition(id);
          const payload = parsePayload(row);
          if (row.phase === 'COMPLETE') {
            transitionCompleted = true;
            return row.result;
          }
          if (row.phase === 'PREPARED') {
            await advanceToQuiescing(row, lease);
            continue;
          }
          if (row.phase === 'QUIESCING') {
            await quiesce(row, payload, lease, admission);
            continue;
          }
          if (row.phase === 'PROVIDER_FENCED') {
            await lease.assertHeld();
            const proof = await dependencies.gateway.stop();
            await lease.assertHeld();
            const reproved = await dependencies.database.projectAuthorizationTransition.updateMany({
              where: {
                id: row.id,
                phase: 'PROVIDER_FENCED',
                leaseOwner: lease.owner,
                leaseTokenHash: lease.tokenHash,
              },
              data: {
                gatewayWasActive: row.gatewayWasActive === true || proof.priorActive,
                gatewayFenceProof: proof,
              },
            });
            if (reproved.count !== 1) {
              throw new ProjectAuthorizationTransitionError(
                PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
                'Gateway fence could not be re-proved before authorization commit',
                503,
                false,
              );
            }
            const reprovedRow = await loadTransition(row.id);
            requireHostRuntimeQuiescenceProof(
              reprovedRow.hostRuntimeQuiescenceProof,
              payload,
            );
            await verifyAllManifests(reprovedRow, true);
            if (payload.kind === 'USER_AUTHORIZATION_UPDATE') {
              await commitUserUpdate(reprovedRow, payload, lease);
            } else if (payload.kind === 'CREDENTIAL_RECOVERY') {
              await commitCredentialRecovery(reprovedRow, payload, lease);
            } else {
              await commitOwnershipTransfer(reprovedRow, payload, lease);
            }
            continue;
          }
          if (row.phase === 'COMMITTED') {
            const result = await complete(row, payload, lease);
            transitionCompleted = true;
            return result;
          }
          throw new ProjectAuthorizationTransitionError(
            'PROJECT_AUTHORIZATION_TRANSITION_JOURNAL_INVALID',
            'Authorization transition phase is unsupported',
            503,
            false,
          );
        }
      } catch (error) {
        const reportedCode = error && typeof error === 'object'
          ? String((error as any).code || '')
          : '';
        const code = error instanceof ProjectAuthorizationTransitionError
          ? error.code
          : (
            /^[A-Z][A-Z0-9_]{2,127}$/.test(reportedCode)
              ? reportedCode
              : 'PROJECT_AUTHORIZATION_TRANSITION_FAILED'
          );
        const message = error instanceof Error
          ? error.message.slice(0, 2_000)
          : 'Authorization transition failed';
        await dependencies.database.projectAuthorizationTransition.updateMany({
          where: {
            id,
            phase: { not: 'COMPLETE' },
            leaseOwner: lease.owner,
            leaseTokenHash: lease.tokenHash,
          },
          data: {
            lastErrorCode: code,
            lastErrorMessage: message,
          },
        }).catch(() => {});
        if (error instanceof ProjectAuthorizationTransitionError) throw error;
        throw new ProjectAuthorizationTransitionError(
          code,
          'Authorization transition could not prove every runtime stopped. Retry after reviewing the Portal logs.',
          503,
          true,
        );
      } finally {
        if (transitionCompleted && admission) {
          admission.release();
          if (retainedAdmissions.get(id) === admission) {
            retainedAdmissions.delete(id);
          }
        }
        await lease.release();
      }
    })();
    inFlight.set(id, operation);
    try {
      return await operation;
    } finally {
      if (inFlight.get(id) === operation) inFlight.delete(id);
    }
  };

  const snapshotProjects = async (transaction: any, transitionId: string): Promise<void> => {
    const projects = await transaction.projectIdentity.findMany({
      orderBy: { id: 'asc' },
    });
    for (const identity of projects) {
      if (
        (identity.lifecycleStatus || 'ACTIVE') !== 'ACTIVE'
        || identity.legacyOpenClawMigrationStatus === 'PENDING'
      ) {
        throw new ProjectAuthorizationTransitionError(
          'PROJECT_AUTHORIZATION_TRANSITION_PROJECT_BUSY',
          'A Project lifecycle operation must finish before authorization can change',
          409,
          true,
        );
      }
      dependencies.assertProjectRoot(identity, identity.canonicalRoot);
    }
    if (projects.length > 0) {
      await transaction.projectAuthorizationTransitionProject.createMany({
        data: projects.map((identity: any) => ({
          transitionId,
          projectIdentityId: identity.id,
          workspaceOwnerId: identity.workspaceOwnerId,
          projectName: identity.projectName,
          canonicalRoot: identity.canonicalRoot,
          rootDevice: identity.rootDevice,
          rootInode: identity.rootInode,
          rootBirthtimeNs: identity.rootBirthtimeNs,
          projectGeneration: identity.generation,
          status: 'PENDING',
        })),
      });
    }
  };

  const findMatchingUnresolved = async (
    fingerprint: string,
  ): Promise<TransitionRow | null> => {
    const unresolved = await dependencies.database.projectAuthorizationTransition.findFirst({
      where: { singletonKey: TRANSITION_SINGLETON_KEY, phase: { not: 'COMPLETE' } },
      orderBy: { createdAt: 'asc' },
    }) as TransitionRow | null;
    if (!unresolved) return null;
    const payload = parsePayload(unresolved);
    if (payload.requestFingerprint !== fingerprint) {
      throw new ProjectAuthorizationTransitionError(
        PROJECT_AUTHORIZATION_TRANSITION_ACTIVE_CODE,
        'A different authorization transition is already in progress',
        409,
        true,
      );
    }
    return unresolved;
  };

  const prepareCredentialRecovery = async (input: {
    targetUserId: string;
    challengeId: string;
    challengeTokenHash: string;
    expectedPasswordHash: string;
    expectedBackupCodes: string | null;
    ipAddress: string;
    userAgent: string | null;
  }): Promise<string> => {
    const targetUserId = exactString(input.targetUserId, 'credential-recovery user');
    const challengeId = exactString(input.challengeId, 'credential-recovery challenge');
    const challengeTokenHash = exactString(
      input.challengeTokenHash,
      'credential-recovery challenge digest',
    );
    const expectedPasswordHash = exactString(
      input.expectedPasswordHash,
      'credential-recovery password state',
    );
    const expectedBackupCodes = input.expectedBackupCodes;
    let parsedBackupCodes: unknown = null;
    if (expectedBackupCodes !== null) {
      try {
        parsedBackupCodes = JSON.parse(expectedBackupCodes);
      } catch {
        parsedBackupCodes = null;
      }
      if (!Array.isArray(parsedBackupCodes) || parsedBackupCodes.length !== 0) {
        throw new ProjectAuthorizationTransitionError(
          'PROJECT_AUTHORIZATION_TRANSITION_INVALID',
          'Credential recovery requires an account with no remaining backup codes',
          409,
          false,
        );
      }
    }
    const ipAddress = exactString(input.ipAddress, 'credential-recovery IP address');
    if (ipAddress.length > 256) {
      throw new ProjectAuthorizationTransitionError(
        'PROJECT_AUTHORIZATION_TRANSITION_INVALID',
        'Credential-recovery IP address is oversized',
        400,
        false,
      );
    }
    const userAgent = input.userAgent === null ? null : String(input.userAgent);
    if (
      userAgent !== null
      && (
        userAgent.length > 2_048
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(userAgent)
      )
    ) {
      throw new ProjectAuthorizationTransitionError(
        'PROJECT_AUTHORIZATION_TRANSITION_INVALID',
        'Credential-recovery user agent is invalid',
        400,
        false,
      );
    }
    const passwordHashDigest = credentialStateDigest('passwordHash', expectedPasswordHash);
    const backupCodesDigest = credentialStateDigest('backupCodes', expectedBackupCodes);
    const fingerprint = requestFingerprint({
      kind: 'CREDENTIAL_RECOVERY',
      targetUserId,
      challengeId,
      challengeTokenHash,
      passwordHashDigest,
      backupCodesDigest,
    });
    const matching = await findMatchingUnresolved(fingerprint);
    if (matching) return matching.id;

    try {
      return await dependencies.database.$transaction(async (transaction: any) => {
        const unresolved = await transaction.projectAuthorizationTransition.findFirst({
          where: { singletonKey: TRANSITION_SINGLETON_KEY, phase: { not: 'COMPLETE' } },
        });
        if (unresolved) {
          const payload = parsePayload(unresolved);
          if (payload.requestFingerprint === fingerprint) return unresolved.id;
          throw new ProjectAuthorizationTransitionError(
            PROJECT_AUTHORIZATION_TRANSITION_ACTIVE_CODE,
            'A different authorization transition is already in progress',
            409,
            true,
          );
        }
        const existingRow = await transaction.user.findUnique({
          where: { id: targetUserId },
        });
        const storedBackupCodes = existingRow?.twoFactorBackupCodes == null
          ? null
          : String(existingRow.twoFactorBackupCodes);
        if (
          !existingRow
          || existingRow.passwordHash !== expectedPasswordHash
          || existingRow.twoFactorEnabled !== true
          || existingRow.twoFactorMethod !== 'email'
          || storedBackupCodes !== expectedBackupCodes
          || !canAccessPortal(existingRow.accountStatus, existingRow.isActive)
        ) {
          throw new ProjectAuthorizationTransitionError(
            PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
            'Credential-recovery account state changed before durable preparation',
            409,
            false,
          );
        }
        const claimed = await transaction.twoFactorChallenge.updateMany({
          where: {
            id: challengeId,
            userId: targetUserId,
            tokenHash: challengeTokenHash,
            consumedAt: null,
            expiresAt: { gt: dependencies.now() },
          },
          data: { consumedAt: dependencies.now() },
        });
        if (claimed.count !== 1) {
          throw new ProjectAuthorizationTransitionError(
            PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
            'Credential-recovery challenge changed before durable preparation',
            409,
            false,
          );
        }
        const candidateActorIds = (await transaction.user.findMany({
          select: { id: true },
          orderBy: { id: 'asc' },
        })).map((entry: any) => exactString(entry.id, 'candidate actor'));
        const transitionId = dependencies.randomUUID();
        const payload: CredentialRecoveryTransitionPayload = {
          schemaVersion: TRANSITION_SCHEMA_VERSION,
          kind: 'CREDENTIAL_RECOVERY',
          requestFingerprint: fingerprint,
          candidateActorIds,
          expectedTarget: userSnapshot(existingRow),
          intent: {
            schemaVersion: 1,
            challengeId,
            challengeTokenHash,
            passwordHashDigest,
            backupCodesDigest,
            requestedAt: dependencies.now().toISOString(),
            ipAddress,
            userAgent,
          },
        };
        await transaction.projectAuthorizationTransition.create({
          data: {
            id: transitionId,
            singletonKey: TRANSITION_SINGLETON_KEY,
            kind: payload.kind,
            phase: 'PREPARED',
            initiatedByUserId: targetUserId,
            targetUserId,
            payload,
          },
        });
        await snapshotProjects(transaction, transitionId);
        return transitionId;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await findMatchingUnresolved(fingerprint);
      if (!raced) throw error;
      return raced.id;
    }
  };

  const prepareUserUpdate = async (input: {
    initiatedByUserId: string;
    targetUserId: string;
    update: ProjectAuthorizationUserUpdate;
    confirmation?: string;
  }): Promise<{ transitionId: string | null; direct: ProjectAuthorizationUserUpdateResult | null }> => {
    const initiatedByUserId = exactString(input.initiatedByUserId, 'initiating user');
    const targetUserId = exactString(input.targetUserId, 'target user');
    const update = compactUserUpdate(input.update);
    const fingerprint = requestFingerprint({
      kind: 'USER_AUTHORIZATION_UPDATE',
      initiatedByUserId,
      targetUserId,
      update,
    });
    const matching = await findMatchingUnresolved(fingerprint);
    if (matching) return { transitionId: matching.id, direct: null };

    try {
      return await dependencies.database.$transaction(async (transaction: any) => {
        const unresolved = await transaction.projectAuthorizationTransition.findFirst({
          where: { singletonKey: TRANSITION_SINGLETON_KEY, phase: { not: 'COMPLETE' } },
        });
        if (unresolved) {
          const payload = parsePayload(unresolved);
          if (payload.requestFingerprint === fingerprint) {
            return { transitionId: unresolved.id, direct: null };
          }
          throw new ProjectAuthorizationTransitionError(
            PROJECT_AUTHORIZATION_TRANSITION_ACTIVE_CODE,
            'A different authorization transition is already in progress',
            409,
            true,
          );
        }
        const existingRow = await transaction.user.findUnique({ where: { id: targetUserId } });
        if (!existingRow) throw new AppError(404, 'User not found');
        const existing = userSnapshot(existingRow);
        if (
          isOwnerRole(existing.role)
          && (
            update.role !== undefined
            || update.accountStatus !== undefined
            || update.isActive === false
          )
        ) {
          throw new AppError(400, 'Cannot demote/disable owner from this endpoint');
        }
        if (
          update.role === 'SUB_ADMIN'
          && !isSubAdminRole(existing.role)
          && !isTypedConfirmationMatch(
            PRIVILEGED_CONFIRMATION.grantServerAccess,
            input.confirmation,
          )
        ) {
          throw new AppError(
            400,
            `Type ${PRIVILEGED_CONFIRMATION.grantServerAccess} to grant full-server Agent Chat and Terminal access.`,
          );
        }
        const reasons = authorizationReasons(existing, update);
        if (reasons.length === 0) {
          const userRow = await transaction.user.update({
            where: { id: targetUserId },
            data: update,
            select: {
              id: true,
              email: true,
              username: true,
              firstName: true,
              lastName: true,
              role: true,
              accountStatus: true,
              isActive: true,
              sandboxEnabled: true,
              authorizationVersion: true,
              lastLoginAt: true,
              createdAt: true,
              avatarPath: true,
            },
          });
          return {
            transitionId: null,
            direct: {
              user: {
                ...userSnapshot(userRow),
                lastLoginAt: userRow.lastLoginAt,
                createdAt: userRow.createdAt,
                avatarPath: userRow.avatarPath,
              },
              existing,
              authorizationReasons: [],
            },
          };
        }

        const candidateActorIds = (await transaction.user.findMany({
          select: { id: true },
          orderBy: { id: 'asc' },
        })).map((entry: any) => exactString(entry.id, 'candidate actor'));
        const transitionId = dependencies.randomUUID();
        const payload: UserAuthorizationTransitionPayload = {
          schemaVersion: TRANSITION_SCHEMA_VERSION,
          kind: 'USER_AUTHORIZATION_UPDATE',
          requestFingerprint: fingerprint,
          candidateActorIds,
          expectedTarget: existing,
          update,
          authorizationReasons: reasons,
        };
        await transaction.projectAuthorizationTransition.create({
          data: {
            id: transitionId,
            singletonKey: TRANSITION_SINGLETON_KEY,
            kind: payload.kind,
            phase: 'PREPARED',
            initiatedByUserId,
            targetUserId,
            payload,
          },
        });
        await snapshotProjects(transaction, transitionId);
        return { transitionId, direct: null };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await findMatchingUnresolved(fingerprint);
      if (!raced) throw error;
      return { transitionId: raced.id, direct: null };
    }
  };

  return Object.freeze({
    async recoverEmailTwoFactor(input: {
      targetUserId: string;
      challengeId: string;
      challengeTokenHash: string;
      expectedPasswordHash: string;
      expectedBackupCodes: string | null;
      ipAddress: string;
      userAgent: string | null;
    }): Promise<ProjectCredentialRecoveryResult> {
      const transitionId = await prepareCredentialRecovery(input);
      return normalizeResult<ProjectCredentialRecoveryResult>(
        await runTransition(transitionId),
      );
    },

    async updateUserAuthorization(input: {
      initiatedByUserId: string;
      targetUserId: string;
      update: ProjectAuthorizationUserUpdate;
      confirmation?: string;
    }): Promise<ProjectAuthorizationUserUpdateResult> {
      const prepared = await prepareUserUpdate(input);
      if (prepared.direct) return prepared.direct;
      return normalizeResult<ProjectAuthorizationUserUpdateResult>(
        await runTransition(prepared.transitionId!),
      );
    },

    async transferOwnership(input: {
      sourceOwnerUserId: string;
      targetUserId: string;
      confirmation?: string;
    }): Promise<ProjectOwnershipTransferResult> {
      const sourceOwnerUserId = exactString(input.sourceOwnerUserId, 'source owner');
      const targetUserId = exactString(input.targetUserId, 'target owner');
      if (sourceOwnerUserId === targetUserId) {
        throw new AppError(400, 'You already own this account');
      }
      const fingerprint = requestFingerprint({
        kind: 'OWNERSHIP_TRANSFER',
        sourceOwnerUserId,
        targetUserId,
      });
      let transition = await findMatchingUnresolved(fingerprint);
      if (!transition) {
        try {
          transition = await dependencies.database.$transaction(async (transaction: any) => {
            const unresolved = await transaction.projectAuthorizationTransition.findFirst({
              where: { singletonKey: TRANSITION_SINGLETON_KEY, phase: { not: 'COMPLETE' } },
            });
            if (unresolved) {
              const payload = parsePayload(unresolved);
              if (payload.requestFingerprint === fingerprint) return unresolved;
              throw new ProjectAuthorizationTransitionError(
                PROJECT_AUTHORIZATION_TRANSITION_ACTIVE_CODE,
                'A different authorization transition is already in progress',
                409,
                true,
              );
            }
            const [ownerRow, targetRow] = await Promise.all([
              transaction.user.findUnique({ where: { id: sourceOwnerUserId } }),
              transaction.user.findUnique({ where: { id: targetUserId } }),
            ]);
            if (!ownerRow || !isOwnerRole(ownerRow.role)) {
              throw new AppError(409, 'Portal ownership changed concurrently. Reload and retry.');
            }
            if (!targetRow) throw new AppError(404, 'Target user not found');
            if (!canAccessPortal(targetRow.accountStatus, targetRow.isActive)) {
              throw new AppError(400, 'Target user must be active to become owner');
            }
            if (isOwnerRole(targetRow.role)) {
              throw new AppError(400, 'Target user is already owner');
            }
            const phrase = confirmationForOwnershipTransfer(targetRow.email);
            if (!isTypedConfirmationMatch(phrase, input.confirmation)) {
              throw new AppError(400, `Type ${phrase} to transfer Portal ownership.`);
            }
            const candidateActorIds = (await transaction.user.findMany({
              select: { id: true },
              orderBy: { id: 'asc' },
            })).map((entry: any) => exactString(entry.id, 'candidate actor'));
            const transitionId = dependencies.randomUUID();
            const payload: OwnershipTransferTransitionPayload = {
              schemaVersion: TRANSITION_SCHEMA_VERSION,
              kind: 'OWNERSHIP_TRANSFER',
              requestFingerprint: fingerprint,
              candidateActorIds,
              expectedOwner: userSnapshot(ownerRow),
              expectedTarget: userSnapshot(targetRow),
            };
            const created = await transaction.projectAuthorizationTransition.create({
              data: {
                id: transitionId,
                singletonKey: TRANSITION_SINGLETON_KEY,
                kind: payload.kind,
                phase: 'PREPARED',
                initiatedByUserId: sourceOwnerUserId,
                sourceOwnerUserId,
                targetUserId,
                payload,
              },
            });
            await snapshotProjects(transaction, transitionId);
            return created;
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        } catch (error) {
          if (!isUniqueConstraintError(error)) throw error;
          const raced = await findMatchingUnresolved(fingerprint);
          if (!raced) throw error;
          transition = raced;
        }
      }
      if (!transition) {
        throw new ProjectAuthorizationTransitionError(
          'PROJECT_AUTHORIZATION_TRANSITION_NOT_FOUND',
          'Ownership transition journal could not be created',
          503,
          false,
        );
      }
      return normalizeResult<ProjectOwnershipTransferResult>(
        await runTransition(transition.id),
      );
    },

    async recoverUnfinished(): Promise<{ recovered: boolean; transitionId: string | null }> {
      const unresolved = await dependencies.database.projectAuthorizationTransition.findFirst({
        where: { singletonKey: TRANSITION_SINGLETON_KEY, phase: { not: 'COMPLETE' } },
        orderBy: { createdAt: 'asc' },
      }) as TransitionRow | null;
      if (!unresolved) return { recovered: false, transitionId: null };
      await runTransition(unresolved.id);
      return { recovered: true, transitionId: unresolved.id };
    },
  });
}

export const projectAuthorizationTransitionCoordinator =
  createProjectAuthorizationTransitionCoordinator();

export async function initializeProjectAuthorizationTransitionRuntime(): Promise<{
  recovered: boolean;
  transitionId: string | null;
}> {
  return projectAuthorizationTransitionCoordinator.recoverUnfinished();
}

export const __projectAuthorizationTransitionTest = {
  TRANSITION_SCHEMA_VERSION,
  TRANSITION_SINGLETON_KEY,
  TRANSITION_LEASE_MS,
  canonicalJson,
  requestFingerprint,
  userSnapshot,
  sameAuthorizationSnapshot,
  authorizationReasons,
  parsePayload,
};
