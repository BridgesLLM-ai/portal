import crypto from 'crypto';
import path from 'path';
import { prisma } from '../config/database';
import type { AdminUserRetirementManagedPath } from './adminUserRetirementManagedPath';

export const ADMIN_USER_RETIREMENT_CONTRACT_VERSION = 1 as const;
export const ADMIN_USER_RETIREMENT_CODE = 'ADMIN_USER_RETIREMENT_DURABLE';
export const ADMIN_USER_RETIREMENT_MESSAGE =
  'Admin user deletion uses a crash-resumable, identity-aware retirement transaction.';

export const ADMIN_USER_RETIREMENT_PHASES = Object.freeze([
  'MANIFESTED',
  'ADMISSION_CLOSED',
  'OWNED_PROJECTS_RETIRED',
  'SHARED_ACTOR_STATE_RETIRED',
  'EXTERNAL_STATE_RETIRED',
  'EXTERNAL_ABSENCE_VERIFIED',
  'DATABASE_COMMITTED',
  'COMPLETE',
] as const);

export type AdminUserRetirementPhase = typeof ADMIN_USER_RETIREMENT_PHASES[number];
export type AdminUserRetirementStatus = 'PENDING' | 'RUNNING' | 'BLOCKED' | 'COMPLETE';

export type AdminUserRetirementAdmissionEvidence = {
  transitionId: string;
  closedAuthorizationVersion: number;
  evidenceDigest: string;
};

export type ManifestProject = {
  id: string;
  projectName: string;
  canonicalRoot: string;
  generation: number;
  lifecycleStatus: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  rootPresent: boolean;
};

export type ManifestApp = {
  id: string;
  name: string;
  projectIdentityId: string | null;
  deployType: string;
  processStatus: string;
  port: number | null;
  sourcePath: string;
  deployPath: string;
  shareLinkIds: string[];
  shareTokenDigests: string[];
};

export type ManifestFile = {
  id: string;
  path: string;
  cloudinaryId: string | null;
};

export type ManifestAgentJob = {
  id: string;
  status: string;
  transcriptPath: string | null;
  metadataDigest: string;
};

export type ManifestAgentSession = {
  id: string;
  provider: string;
  externalId: string;
  localAgentId: string | null;
  localSessionId: string | null;
  localIdentityDigest: string | null;
};

export type ManifestNativeSession = {
  provider: string;
  sessionId: string;
  identityDigest: string;
  executionScope: string;
  projectIdentityId: string | null;
};

export type ManifestProjectRuntimeCleanupActor = {
  projectIdentityId: string;
  provider: string;
  actorUserId: string;
  sessionId: string;
};

export type AdminUserRetirementManifestV1 = {
  version: typeof ADMIN_USER_RETIREMENT_CONTRACT_VERSION;
  target: {
    id: string;
    role: string;
    authorizationVersion: number;
    emailDigest: string;
    username: string;
    avatarBasename: string | null;
  };
  requestedByUserId: string;
  ownedProjects: ManifestProject[];
  actorRuntimeState: {
    projectIdentityIds: string[];
    legacyProjectIds: string[];
    chatStateIds: string[];
    turnIds: string[];
    resetJournalIds: string[];
    providerBindingIds: string[];
    providerSessionRowIds: string[];
    providerSessionIds: string[];
    gatewaySessionKeys: string[];
    messageIds: string[];
    legacyImportIds: string[];
    legacyQuarantineIds: string[];
    legacyClearTombstoneIds: string[];
  };
  dependencyEvidence: {
    completeRepairReceiptIds: string[];
    cleanupActors: ManifestProjectRuntimeCleanupActor[];
  };
  apps: ManifestApp[];
  files: ManifestFile[];
  agentJobs: ManifestAgentJob[];
  agentSessions: ManifestAgentSession[];
  authState: {
    sessionIds: string[];
    emailVerificationCodeIds: string[];
    twoFactorChallengeIds: string[];
    passwordResetTokenIds: string[];
  };
  mailboxes: {
    usernames: string[];
  };
  providerAttributions: {
    ollamaBindingIds: string[];
    nativeOllamaBindingIds: string[];
  };
  localTargets: {
    managedPaths: AdminUserRetirementManagedPath[];
    nativeSessions: ManifestNativeSession[];
  };
};

export type AdminUserRetirementRecord = {
  id: string;
  targetUserId: string;
  requestedByUserId: string;
  manifestVersion: number;
  manifest: AdminUserRetirementManifestV1;
  manifestDigest: string;
  targetAuthorizationVersion: number;
  phase: AdminUserRetirementPhase;
  status: AdminUserRetirementStatus;
  attempts: number;
  leaseTokenHash: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  authorizationTransitionId: string | null;
  closedAuthorizationVersion: number | null;
  admissionEvidenceDigest: string | null;
  externalAbsenceDigest: string | null;
  lastErrorCode: string | null;
  lastErrorDetail: string | null;
};

export type ClaimedAdminUserRetirement = {
  record: AdminUserRetirementRecord;
  leaseToken: string;
  leaseTokenHash: string;
};

export interface AdminUserRetirementStore {
  create(
    manifest: AdminUserRetirementManifestV1,
    manifestDigest: string,
  ): Promise<AdminUserRetirementRecord>;
  readByTargetUserId(targetUserId: string): Promise<AdminUserRetirementRecord | null>;
  listUnfinished(): Promise<AdminUserRetirementRecord[]>;
  claim(
    targetUserId: string,
    leaseOwner: string,
    leaseDurationMs: number,
  ): Promise<ClaimedAdminUserRetirement>;
  renew(
    recordId: string,
    leaseTokenHash: string,
    leaseDurationMs: number,
  ): Promise<void>;
  advance(
    recordId: string,
    leaseTokenHash: string,
    expectedPhase: AdminUserRetirementPhase,
    nextPhase: AdminUserRetirementPhase,
    evidence?: {
      admission?: AdminUserRetirementAdmissionEvidence;
      externalAbsenceDigest?: string;
    },
  ): Promise<AdminUserRetirementRecord>;
  block(
    recordId: string,
    leaseTokenHash: string,
    errorCode: string,
    errorDetail: string,
  ): Promise<void>;
}

export interface AdminUserRetirementRunner {
  closeAdmission(
    manifest: AdminUserRetirementManifestV1,
    context: AdminUserRetirementRunnerContext,
  ): Promise<AdminUserRetirementAdmissionEvidence>;
  retireOwnedProjects(
    manifest: AdminUserRetirementManifestV1,
    context: AdminUserRetirementRunnerContext,
  ): Promise<void>;
  retireSharedActorState(
    manifest: AdminUserRetirementManifestV1,
    context: AdminUserRetirementRunnerContext,
  ): Promise<void>;
  retireExternalState(
    manifest: AdminUserRetirementManifestV1,
    context: AdminUserRetirementRunnerContext,
  ): Promise<void>;
  verifyExternalAbsence(
    manifest: AdminUserRetirementManifestV1,
    context: AdminUserRetirementRunnerContext,
  ): Promise<{ evidenceDigest: string }>;
  commitDatabaseDeletion(
    manifest: AdminUserRetirementManifestV1,
    context: AdminUserRetirementRunnerContext,
  ): Promise<void>;
  verifyDatabaseAbsence(
    manifest: AdminUserRetirementManifestV1,
    context: AdminUserRetirementRunnerContext,
  ): Promise<void>;
}

export interface AdminUserRetirementRunnerContext {
  readonly retirementId: string;
  readonly manifestDigest: string;
  assertHeld(): Promise<void>;
  renewLease(): Promise<void>;
  readAdmissionEvidence(): AdminUserRetirementAdmissionEvidence;
}

export class AdminUserRetirementBusyError extends Error {
  readonly code = 'ADMIN_USER_RETIREMENT_BUSY';

  constructor(message = 'User retirement is already claimed by another worker') {
    super(message);
    this.name = 'AdminUserRetirementBusyError';
  }
}

export class AdminUserRetirementIntegrityError extends Error {
  readonly code = 'ADMIN_USER_RETIREMENT_INTEGRITY';

  constructor(message: string) {
    super(message);
    this.name = 'AdminUserRetirementIntegrityError';
  }
}

export class AdminUserRetirementRecoveryRequiredError extends Error {
  readonly code = 'ADMIN_USER_RETIREMENT_RECOVERY_REQUIRED';

  constructor(readonly pendingCount: number) {
    super(
      `Portal admission is blocked by ${pendingCount} unfinished admin user retirement`
      + `${pendingCount === 1 ? '' : 's'}`,
    );
    this.name = 'AdminUserRetirementRecoveryRequiredError';
  }
}

export const ADMIN_USER_RETIREMENT_READINESS = Object.freeze({
  ready: true,
  code: ADMIN_USER_RETIREMENT_CODE,
  message: ADMIN_USER_RETIREMENT_MESSAGE,
  contractVersion: ADMIN_USER_RETIREMENT_CONTRACT_VERSION,
  retryable: false,
  durableJournal: true,
  immutableManifest: true,
  restartStateMachine: true,
  externalAbsenceBeforeUserDelete: true,
  productionAdapters: Object.freeze({
    admissionClosure: true,
    ownedProjectLifecycle: true,
    sharedActorRuntimeRetirement: true,
    dependencyEvidenceRetirement: true,
    appFileJobMailProviderRetirement: true,
    externalAbsenceVerification: true,
  }),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new AdminUserRetirementIntegrityError('Manifest nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new AdminUserRetirementIntegrityError('Manifest numbers must be safe integers');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item, depth + 1));
  if (!isPlainObject(value)) {
    throw new AdminUserRetirementIntegrityError('Manifest contains a non-JSON value');
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child === undefined) {
      throw new AdminUserRetirementIntegrityError(`Manifest property ${key} is undefined`);
    }
    result[key] = canonicalJsonValue(child, depth + 1);
  }
  return result;
}

export function canonicalizeAdminUserRetirementManifest(
  manifest: AdminUserRetirementManifestV1,
): string {
  const serialized = JSON.stringify(canonicalJsonValue(manifest));
  if (Buffer.byteLength(serialized, 'utf8') > 4 * 1024 * 1024) {
    throw new AdminUserRetirementIntegrityError('User retirement manifest exceeds 4 MiB');
  }
  return serialized;
}

export function digestAdminUserRetirementManifest(
  manifest: AdminUserRetirementManifestV1,
): string {
  return crypto
    .createHash('sha256')
    .update(canonicalizeAdminUserRetirementManifest(manifest))
    .digest('hex');
}

function assertNonEmpty(value: unknown, label: string, maximum = 1024): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AdminUserRetirementIntegrityError(`Manifest ${label} is invalid`);
  }
  return normalized;
}

function assertExactBoundedString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string'
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
    || (!allowEmpty && value.trim().length === 0)
  ) {
    throw new AdminUserRetirementIntegrityError(`Manifest ${label} is invalid`);
  }
  return value;
}

function assertDigest(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new AdminUserRetirementIntegrityError(`Manifest ${label} is not a SHA-256 digest`);
  }
  return normalized;
}

function validateAdmissionEvidence(
  value: AdminUserRetirementAdmissionEvidence,
  manifestAuthorizationVersion: number,
): AdminUserRetirementAdmissionEvidence {
  if (!isPlainObject(value)) {
    throw new AdminUserRetirementIntegrityError('Admission closure evidence is missing');
  }
  assertExactKeys(
    value,
    ['transitionId', 'closedAuthorizationVersion', 'evidenceDigest'],
    'admissionEvidence',
  );
  const transitionId = assertNonEmpty(value.transitionId, 'admissionEvidence.transitionId', 200);
  if (
    !Number.isSafeInteger(value.closedAuthorizationVersion)
    || value.closedAuthorizationVersion <= manifestAuthorizationVersion
  ) {
    throw new AdminUserRetirementIntegrityError(
      'Admission closure authorization generation is invalid',
    );
  }
  const evidenceDigest = assertDigest(
    value.evidenceDigest,
    'admissionEvidence.evidenceDigest',
  );
  return Object.freeze({
    transitionId,
    closedAuthorizationVersion: value.closedAuthorizationVersion,
    evidenceDigest,
  });
}

function assertAbsoluteNormalizedPath(value: unknown, label: string): string {
  const normalized = assertNonEmpty(value, label, 4096);
  if (!path.isAbsolute(normalized) || path.resolve(normalized) !== normalized) {
    throw new AdminUserRetirementIntegrityError(`Manifest ${label} is not an absolute normalized path`);
  }
  return normalized;
}

function assertUniqueStrings(values: unknown, label: string): string[] {
  if (!Array.isArray(values)) {
    throw new AdminUserRetirementIntegrityError(`Manifest ${label} must be an array`);
  }
  const normalized = values.map((value, index) => assertNonEmpty(value, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new AdminUserRetirementIntegrityError(`Manifest ${label} contains duplicates`);
  }
  return normalized;
}

function assertArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new AdminUserRetirementIntegrityError(`Manifest ${label} must be an array`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AdminUserRetirementIntegrityError(`Manifest ${label} has an unknown or missing property`);
  }
}

/**
 * Validate the closed manifest shape before it becomes immutable authority.
 * The journal never stores passwords, access/refresh tokens, message content,
 * credential payloads, or transcript bodies.
 */
export function validateAdminUserRetirementManifest(
  candidate: AdminUserRetirementManifestV1,
): AdminUserRetirementManifestV1 {
  if (!isPlainObject(candidate) || candidate.version !== ADMIN_USER_RETIREMENT_CONTRACT_VERSION) {
    throw new AdminUserRetirementIntegrityError('Unsupported user retirement manifest version');
  }
  assertExactKeys(candidate, [
    'version',
    'target',
    'requestedByUserId',
    'ownedProjects',
    'actorRuntimeState',
    'dependencyEvidence',
    'apps',
    'files',
    'agentJobs',
    'agentSessions',
    'authState',
    'mailboxes',
    'providerAttributions',
    'localTargets',
  ], 'root');
  if (!isPlainObject(candidate.target)) {
    throw new AdminUserRetirementIntegrityError('Manifest target is missing');
  }
  assertExactKeys(candidate.target, [
    'id',
    'role',
    'authorizationVersion',
    'emailDigest',
    'username',
    'avatarBasename',
  ], 'target');
  assertNonEmpty(candidate.target.id, 'target.id', 200);
  assertNonEmpty(candidate.requestedByUserId, 'requestedByUserId', 200);
  if (candidate.target.id === candidate.requestedByUserId) {
    throw new AdminUserRetirementIntegrityError('An owner cannot retire their own account');
  }
  if (String(candidate.target.role).toUpperCase() === 'OWNER') {
    throw new AdminUserRetirementIntegrityError('Owner accounts cannot be retired');
  }
  if (!Number.isSafeInteger(candidate.target.authorizationVersion)
    || candidate.target.authorizationVersion < 1) {
    throw new AdminUserRetirementIntegrityError('Manifest authorization version is invalid');
  }
  assertDigest(candidate.target.emailDigest, 'target.emailDigest');
  assertNonEmpty(candidate.target.username, 'target.username', 320);
  if (
    candidate.target.avatarBasename !== null
    && path.basename(candidate.target.avatarBasename) !== candidate.target.avatarBasename
  ) {
    throw new AdminUserRetirementIntegrityError('Manifest avatar target is not a basename');
  }

  for (const [index, project] of assertArray(candidate.ownedProjects, 'ownedProjects').entries()) {
    if (!isPlainObject(project)) {
      throw new AdminUserRetirementIntegrityError(`Manifest ownedProjects[${index}] is invalid`);
    }
    assertExactKeys(project, [
      'id',
      'projectName',
      'canonicalRoot',
      'generation',
      'lifecycleStatus',
      'rootDevice',
      'rootInode',
      'rootBirthtimeNs',
      'rootPresent',
    ], `ownedProjects[${index}]`);
    assertNonEmpty(project.id, `ownedProjects[${index}].id`, 200);
    assertNonEmpty(project.projectName, `ownedProjects[${index}].projectName`, 320);
    assertAbsoluteNormalizedPath(project.canonicalRoot, `ownedProjects[${index}].canonicalRoot`);
    if (!Number.isSafeInteger(project.generation) || Number(project.generation) < 1) {
      throw new AdminUserRetirementIntegrityError(`Manifest ownedProjects[${index}].generation is invalid`);
    }
    assertNonEmpty(project.lifecycleStatus, `ownedProjects[${index}].lifecycleStatus`, 64);
    assertNonEmpty(project.rootDevice, `ownedProjects[${index}].rootDevice`, 100);
    assertNonEmpty(project.rootInode, `ownedProjects[${index}].rootInode`, 100);
    assertNonEmpty(project.rootBirthtimeNs, `ownedProjects[${index}].rootBirthtimeNs`, 100);
    if (typeof project.rootPresent !== 'boolean') {
      throw new AdminUserRetirementIntegrityError(
        `Manifest ownedProjects[${index}].rootPresent is invalid`,
      );
    }
  }

  if (!isPlainObject(candidate.actorRuntimeState)) {
    throw new AdminUserRetirementIntegrityError('Manifest actorRuntimeState is missing');
  }
  assertExactKeys(candidate.actorRuntimeState, [
    'projectIdentityIds',
    'legacyProjectIds',
    'chatStateIds',
    'turnIds',
    'resetJournalIds',
    'providerBindingIds',
    'providerSessionRowIds',
    'providerSessionIds',
    'gatewaySessionKeys',
    'messageIds',
    'legacyImportIds',
    'legacyQuarantineIds',
    'legacyClearTombstoneIds',
  ], 'actorRuntimeState');
  for (const key of [
    'projectIdentityIds',
    'legacyProjectIds',
    'chatStateIds',
    'turnIds',
    'resetJournalIds',
    'providerBindingIds',
    'providerSessionRowIds',
    'providerSessionIds',
    'gatewaySessionKeys',
    'messageIds',
    'legacyImportIds',
    'legacyQuarantineIds',
    'legacyClearTombstoneIds',
  ] as const) {
    assertUniqueStrings(candidate.actorRuntimeState[key], `actorRuntimeState.${key}`);
  }

  if (!isPlainObject(candidate.dependencyEvidence)) {
    throw new AdminUserRetirementIntegrityError('Manifest dependencyEvidence is missing');
  }
  assertExactKeys(candidate.dependencyEvidence, [
    'completeRepairReceiptIds',
    'cleanupActors',
  ], 'dependencyEvidence');
  const completeRepairReceiptIds = assertArray(
    candidate.dependencyEvidence.completeRepairReceiptIds,
    'dependencyEvidence.completeRepairReceiptIds',
  ).map((receiptId, index) => assertExactBoundedString(
    receiptId,
    `dependencyEvidence.completeRepairReceiptIds[${index}]`,
    200,
  ));
  if (completeRepairReceiptIds.length > 10_000) {
    throw new AdminUserRetirementIntegrityError(
      'Manifest dependencyEvidence.completeRepairReceiptIds exceeds its bound',
    );
  }
  if (new Set(completeRepairReceiptIds).size !== completeRepairReceiptIds.length) {
    throw new AdminUserRetirementIntegrityError(
      'Manifest dependencyEvidence.completeRepairReceiptIds contains duplicates',
    );
  }
  if (completeRepairReceiptIds.some((value, index) => (
    index > 0 && completeRepairReceiptIds[index - 1].localeCompare(value) >= 0
  ))) {
    throw new AdminUserRetirementIntegrityError(
      'Manifest dependencyEvidence.completeRepairReceiptIds is not strictly ordered',
    );
  }
  const cleanupActors = assertArray(
    candidate.dependencyEvidence.cleanupActors,
    'dependencyEvidence.cleanupActors',
  );
  if (cleanupActors.length > 10_000) {
    throw new AdminUserRetirementIntegrityError(
      'Manifest dependencyEvidence.cleanupActors exceeds its bound',
    );
  }
  let previousCleanupActorTuple: readonly string[] | null = null;
  for (const [index, actor] of cleanupActors.entries()) {
    const label = `dependencyEvidence.cleanupActors[${index}]`;
    if (!isPlainObject(actor)) {
      throw new AdminUserRetirementIntegrityError(`Manifest ${label} is invalid`);
    }
    assertExactKeys(actor, [
      'projectIdentityId',
      'provider',
      'actorUserId',
      'sessionId',
    ], label);
    const projectIdentityId = assertExactBoundedString(
      actor.projectIdentityId,
      `${label}.projectIdentityId`,
      200,
    );
    const provider = assertExactBoundedString(actor.provider, `${label}.provider`, 64);
    const actorUserId = assertExactBoundedString(actor.actorUserId, `${label}.actorUserId`, 200);
    const sessionId = assertExactBoundedString(actor.sessionId, `${label}.sessionId`, 256, true);
    if (actorUserId !== candidate.target.id) {
      throw new AdminUserRetirementIntegrityError(`Manifest ${label} belongs to another user`);
    }
    const compoundTuple = [
      projectIdentityId,
      provider,
      actorUserId,
      sessionId,
    ] as const;
    const order = previousCleanupActorTuple === null ? 1 : compoundTuple.reduce(
      (result, value, tupleIndex) => result || value.localeCompare(
        previousCleanupActorTuple![tupleIndex],
      ),
      0,
    );
    if (previousCleanupActorTuple !== null && order <= 0) {
      throw new AdminUserRetirementIntegrityError(
        'Manifest dependencyEvidence.cleanupActors is not strictly ordered',
      );
    }
    previousCleanupActorTuple = compoundTuple;
  }

  for (const [index, app] of assertArray(candidate.apps, 'apps').entries()) {
    if (!isPlainObject(app)) throw new AdminUserRetirementIntegrityError(`Manifest apps[${index}] is invalid`);
    assertExactKeys(app, [
      'id',
      'name',
      'projectIdentityId',
      'deployType',
      'processStatus',
      'port',
      'sourcePath',
      'deployPath',
      'shareLinkIds',
      'shareTokenDigests',
    ], `apps[${index}]`);
    assertNonEmpty(app.id, `apps[${index}].id`, 200);
    assertNonEmpty(app.name, `apps[${index}].name`, 320);
    if (app.projectIdentityId !== null) {
      assertNonEmpty(app.projectIdentityId, `apps[${index}].projectIdentityId`, 200);
    }
    assertNonEmpty(app.deployType, `apps[${index}].deployType`, 64);
    assertNonEmpty(app.processStatus, `apps[${index}].processStatus`, 64);
    if (app.port !== null && (!Number.isSafeInteger(app.port) || Number(app.port) < 1 || Number(app.port) > 65535)) {
      throw new AdminUserRetirementIntegrityError(`Manifest apps[${index}].port is invalid`);
    }
    assertAbsoluteNormalizedPath(app.sourcePath, `apps[${index}].sourcePath`);
    assertAbsoluteNormalizedPath(app.deployPath, `apps[${index}].deployPath`);
    assertUniqueStrings(app.shareLinkIds, `apps[${index}].shareLinkIds`);
    for (const digest of assertUniqueStrings(app.shareTokenDigests, `apps[${index}].shareTokenDigests`)) {
      assertDigest(digest, `apps[${index}].shareTokenDigests`);
    }
  }

  for (const [index, file] of assertArray(candidate.files, 'files').entries()) {
    if (!isPlainObject(file)) throw new AdminUserRetirementIntegrityError(`Manifest files[${index}] is invalid`);
    assertExactKeys(file, ['id', 'path', 'cloudinaryId'], `files[${index}]`);
    assertNonEmpty(file.id, `files[${index}].id`, 200);
    assertNonEmpty(file.path, `files[${index}].path`, 4096);
    if (file.cloudinaryId !== null) assertNonEmpty(file.cloudinaryId, `files[${index}].cloudinaryId`, 1024);
  }

  for (const [index, job] of assertArray(candidate.agentJobs, 'agentJobs').entries()) {
    if (!isPlainObject(job)) throw new AdminUserRetirementIntegrityError(`Manifest agentJobs[${index}] is invalid`);
    assertExactKeys(job, ['id', 'status', 'transcriptPath', 'metadataDigest'], `agentJobs[${index}]`);
    assertNonEmpty(job.id, `agentJobs[${index}].id`, 200);
    assertNonEmpty(job.status, `agentJobs[${index}].status`, 64);
    if (job.transcriptPath !== null) {
      assertAbsoluteNormalizedPath(job.transcriptPath, `agentJobs[${index}].transcriptPath`);
    }
    assertDigest(job.metadataDigest, `agentJobs[${index}].metadataDigest`);
  }

  for (const [index, session] of assertArray(candidate.agentSessions, 'agentSessions').entries()) {
    if (!isPlainObject(session)) {
      throw new AdminUserRetirementIntegrityError(`Manifest agentSessions[${index}] is invalid`);
    }
    assertExactKeys(session, [
      'id',
      'provider',
      'externalId',
      'localAgentId',
      'localSessionId',
      'localIdentityDigest',
    ], `agentSessions[${index}]`);
    assertNonEmpty(session.id, `agentSessions[${index}].id`, 200);
    assertNonEmpty(session.provider, `agentSessions[${index}].provider`, 64);
    assertNonEmpty(session.externalId, `agentSessions[${index}].externalId`, 2048);
    if (session.localAgentId !== null) {
      assertNonEmpty(session.localAgentId, `agentSessions[${index}].localAgentId`, 128);
    }
    if (session.localSessionId !== null) {
      assertNonEmpty(session.localSessionId, `agentSessions[${index}].localSessionId`, 256);
    }
    if (session.localIdentityDigest !== null) {
      assertDigest(session.localIdentityDigest, `agentSessions[${index}].localIdentityDigest`);
    }
    if (
      (session.localAgentId === null) !== (session.localIdentityDigest === null)
      || (session.localAgentId === null && session.localSessionId !== null)
    ) {
      throw new AdminUserRetirementIntegrityError(
        `Manifest agentSessions[${index}] local identity is inconsistent`,
      );
    }
  }

  if (!isPlainObject(candidate.authState)) {
    throw new AdminUserRetirementIntegrityError('Manifest authState is missing');
  }
  assertExactKeys(candidate.authState, [
    'sessionIds',
    'emailVerificationCodeIds',
    'twoFactorChallengeIds',
    'passwordResetTokenIds',
  ], 'authState');
  for (const key of [
    'sessionIds',
    'emailVerificationCodeIds',
    'twoFactorChallengeIds',
    'passwordResetTokenIds',
  ] as const) {
    assertUniqueStrings(candidate.authState[key], `authState.${key}`);
  }
  if (!isPlainObject(candidate.mailboxes)) {
    throw new AdminUserRetirementIntegrityError('Manifest mailboxes is missing');
  }
  assertExactKeys(candidate.mailboxes, ['usernames'], 'mailboxes');
  assertUniqueStrings(candidate.mailboxes.usernames, 'mailboxes.usernames');
  if (!isPlainObject(candidate.providerAttributions)) {
    throw new AdminUserRetirementIntegrityError('Manifest providerAttributions is missing');
  }
  assertExactKeys(
    candidate.providerAttributions,
    ['ollamaBindingIds', 'nativeOllamaBindingIds'],
    'providerAttributions',
  );
  assertUniqueStrings(candidate.providerAttributions.ollamaBindingIds, 'providerAttributions.ollamaBindingIds');
  assertUniqueStrings(
    candidate.providerAttributions.nativeOllamaBindingIds,
    'providerAttributions.nativeOllamaBindingIds',
  );
  if (!isPlainObject(candidate.localTargets)) {
    throw new AdminUserRetirementIntegrityError('Manifest localTargets is missing');
  }
  assertExactKeys(candidate.localTargets, ['managedPaths', 'nativeSessions'], 'localTargets');
  const managedPathKeys = [
    'targetUserId',
    'root',
    'rootIdentity',
    'path',
    'quarantinePath',
    'kind',
    'present',
    'identity',
    'size',
    'sha256',
  ] as const;
  const filesystemIdentityKeys = ['device', 'inode', 'birthtimeNs', 'uid', 'gid', 'mode'] as const;
  for (const [index, target] of assertArray(
    candidate.localTargets.managedPaths,
    'localTargets.managedPaths',
  ).entries()) {
    if (!isPlainObject(target)) {
      throw new AdminUserRetirementIntegrityError(
        `Manifest localTargets.managedPaths[${index}] is invalid`,
      );
    }
    const label = `localTargets.managedPaths[${index}]`;
    assertExactKeys(target, managedPathKeys, label);
    if (target.targetUserId !== candidate.target.id) {
      throw new AdminUserRetirementIntegrityError(`Manifest ${label} belongs to another user`);
    }
    const root = assertAbsoluteNormalizedPath(target.root, `${label}.root`);
    const targetPath = assertAbsoluteNormalizedPath(target.path, `${label}.path`);
    const quarantinePath = assertAbsoluteNormalizedPath(target.quarantinePath, `${label}.quarantinePath`);
    for (const [child, childLabel] of [
      [targetPath, 'path'],
      [quarantinePath, 'quarantinePath'],
    ] as const) {
      const relative = path.relative(root, child);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new AdminUserRetirementIntegrityError(`Manifest ${label}.${childLabel} escapes its root`);
      }
    }
    if (
      target.kind !== 'FILE'
      && target.kind !== 'DIRECTORY'
      && target.kind !== 'CONTAINER_DIRECTORY'
    ) {
      throw new AdminUserRetirementIntegrityError(`Manifest ${label}.kind is invalid`);
    }
    if (typeof target.present !== 'boolean') {
      throw new AdminUserRetirementIntegrityError(`Manifest ${label}.present is invalid`);
    }
    const validateIdentity = (identity: unknown, identityLabel: string) => {
      if (!isPlainObject(identity)) {
        throw new AdminUserRetirementIntegrityError(`Manifest ${identityLabel} is invalid`);
      }
      assertExactKeys(identity, filesystemIdentityKeys, identityLabel);
      for (const key of ['device', 'inode', 'birthtimeNs'] as const) {
        if (!/^[0-9]+$/.test(String(identity[key] || ''))) {
          throw new AdminUserRetirementIntegrityError(`Manifest ${identityLabel}.${key} is invalid`);
        }
      }
      for (const key of ['uid', 'gid', 'mode'] as const) {
        if (!Number.isSafeInteger(identity[key]) || Number(identity[key]) < 0) {
          throw new AdminUserRetirementIntegrityError(`Manifest ${identityLabel}.${key} is invalid`);
        }
      }
    };
    validateIdentity(target.rootIdentity, `${label}.rootIdentity`);
    if (target.present) {
      validateIdentity(target.identity, `${label}.identity`);
      if (!/^[0-9]+$/.test(String(target.size || ''))) {
        throw new AdminUserRetirementIntegrityError(`Manifest ${label}.size is invalid`);
      }
      if (target.kind === 'FILE' || target.kind === 'DIRECTORY') {
        assertDigest(target.sha256, `${label}.sha256`);
      } else if (target.kind === 'CONTAINER_DIRECTORY' && target.sha256 !== null) {
        throw new AdminUserRetirementIntegrityError(`Manifest ${label}.sha256 is invalid`);
      }
    } else if (target.identity !== null || target.size !== null || target.sha256 !== null) {
      throw new AdminUserRetirementIntegrityError(
        `Manifest ${label} absent target carries mutable identity`,
      );
    }
  }
  for (const [index, session] of assertArray(
    candidate.localTargets.nativeSessions,
    'localTargets.nativeSessions',
  ).entries()) {
    if (!isPlainObject(session)) {
      throw new AdminUserRetirementIntegrityError(
        `Manifest localTargets.nativeSessions[${index}] is invalid`,
      );
    }
    const label = `localTargets.nativeSessions[${index}]`;
    assertExactKeys(session, [
      'provider',
      'sessionId',
      'identityDigest',
      'executionScope',
      'projectIdentityId',
    ], label);
    assertNonEmpty(session.provider, `${label}.provider`, 64);
    assertNonEmpty(session.sessionId, `${label}.sessionId`, 256);
    assertDigest(session.identityDigest, `${label}.identityDigest`);
    assertNonEmpty(session.executionScope, `${label}.executionScope`, 64);
    if (session.projectIdentityId !== null) {
      assertNonEmpty(session.projectIdentityId, `${label}.projectIdentityId`, 200);
    }
  }

  canonicalizeAdminUserRetirementManifest(candidate);
  return candidate;
}

function normalizeRecord(value: any): AdminUserRetirementRecord {
  if (!value || typeof value !== 'object') {
    throw new AdminUserRetirementIntegrityError('User retirement journal row is missing');
  }
  if (!ADMIN_USER_RETIREMENT_PHASES.includes(value.phase)) {
    throw new AdminUserRetirementIntegrityError('User retirement journal phase is invalid');
  }
  if (!['PENDING', 'RUNNING', 'BLOCKED', 'COMPLETE'].includes(value.status)) {
    throw new AdminUserRetirementIntegrityError('User retirement journal status is invalid');
  }
  const lastErrorCode = value.lastErrorCode === null
    ? null
    : assertNonEmpty(value.lastErrorCode, 'lastErrorCode', 120);
  const lastErrorDetail = value.lastErrorDetail === null
    ? null
    : assertNonEmpty(value.lastErrorDetail, 'lastErrorDetail', 500);
  if (
    (value.status === 'BLOCKED') !== (lastErrorCode !== null && lastErrorDetail !== null)
    || (lastErrorCode !== null && !/^[A-Za-z0-9_.-]+$/.test(lastErrorCode))
  ) {
    throw new AdminUserRetirementIntegrityError('User retirement journal failure state is invalid');
  }
  const manifest = validateAdminUserRetirementManifest(
    value.manifest as AdminUserRetirementManifestV1,
  );
  const digest = digestAdminUserRetirementManifest(manifest);
  if (digest !== value.manifestDigest) {
    throw new AdminUserRetirementIntegrityError('User retirement manifest digest changed');
  }
  if (
    manifest.target.id !== value.targetUserId
    || manifest.requestedByUserId !== value.requestedByUserId
    || manifest.target.authorizationVersion !== value.targetAuthorizationVersion
    || value.manifestVersion !== ADMIN_USER_RETIREMENT_CONTRACT_VERSION
  ) {
    throw new AdminUserRetirementIntegrityError('User retirement journal identity changed');
  }
  const phaseIndex = ADMIN_USER_RETIREMENT_PHASES.indexOf(value.phase);
  const hasAdmissionEvidence = value.authorizationTransitionId !== null
    || value.closedAuthorizationVersion !== null
    || value.admissionEvidenceDigest !== null;
  if (phaseIndex >= ADMIN_USER_RETIREMENT_PHASES.indexOf('ADMISSION_CLOSED')) {
    validateAdmissionEvidence({
      transitionId: value.authorizationTransitionId,
      closedAuthorizationVersion: value.closedAuthorizationVersion,
      evidenceDigest: value.admissionEvidenceDigest,
    }, manifest.target.authorizationVersion);
  } else if (hasAdmissionEvidence) {
    throw new AdminUserRetirementIntegrityError(
      'User retirement admission evidence exists before admission closed',
    );
  }
  return {
    ...value,
    manifest,
    phase: value.phase,
    status: value.status,
    lastErrorCode,
    lastErrorDetail,
  } as AdminUserRetirementRecord;
}

type RetirementDelegate = {
  create(args: any): Promise<any>;
  findUnique(args: any): Promise<any>;
  findMany(args: any): Promise<any[]>;
  updateMany(args: any): Promise<{ count: number }>;
};

function retirementDelegate(database: unknown): RetirementDelegate {
  const delegate = (database as any)?.adminUserRetirement;
  if (
    !delegate
    || typeof delegate.create !== 'function'
    || typeof delegate.findUnique !== 'function'
    || typeof delegate.findMany !== 'function'
    || typeof delegate.updateMany !== 'function'
  ) {
    throw new AdminUserRetirementIntegrityError('AdminUserRetirement database delegate is unavailable');
  }
  return delegate;
}

export class PrismaAdminUserRetirementStore implements AdminUserRetirementStore {
  constructor(
    private readonly database: unknown = prisma,
    private readonly now: () => Date = () => new Date(),
    private readonly randomToken: () => string = () => crypto.randomBytes(32).toString('hex'),
  ) {}

  async create(
    manifest: AdminUserRetirementManifestV1,
    manifestDigest: string,
  ): Promise<AdminUserRetirementRecord> {
    validateAdminUserRetirementManifest(manifest);
    if (digestAdminUserRetirementManifest(manifest) !== manifestDigest) {
      throw new AdminUserRetirementIntegrityError('Refusing mismatched manifest digest');
    }
    const created = await retirementDelegate(this.database).create({
      data: {
        targetUserId: manifest.target.id,
        requestedByUserId: manifest.requestedByUserId,
        manifestVersion: manifest.version,
        manifest,
        manifestDigest,
        targetAuthorizationVersion: manifest.target.authorizationVersion,
      },
    });
    return normalizeRecord(created);
  }

  async readByTargetUserId(targetUserId: string): Promise<AdminUserRetirementRecord | null> {
    const value = await retirementDelegate(this.database).findUnique({
      where: { targetUserId },
    });
    return value ? normalizeRecord(value) : null;
  }

  async listUnfinished(): Promise<AdminUserRetirementRecord[]> {
    const rows = await retirementDelegate(this.database).findMany({
      where: { status: { not: 'COMPLETE' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(normalizeRecord);
  }

  async claim(
    targetUserId: string,
    leaseOwner: string,
    leaseDurationMs: number,
  ): Promise<ClaimedAdminUserRetirement> {
    const boundedOwner = assertNonEmpty(leaseOwner, 'leaseOwner', 200);
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000 || leaseDurationMs > 15 * 60_000) {
      throw new AdminUserRetirementIntegrityError('User retirement lease duration is invalid');
    }
    const leaseToken = this.randomToken();
    if (!/^[a-f0-9]{64}$/.test(leaseToken)) {
      throw new AdminUserRetirementIntegrityError('User retirement lease token generator is invalid');
    }
    const leaseTokenHash = crypto.createHash('sha256').update(leaseToken).digest('hex');
    const now = this.now();
    const updated = await retirementDelegate(this.database).updateMany({
      where: {
        targetUserId,
        status: { in: ['PENDING', 'RUNNING', 'BLOCKED'] },
        OR: [
          { leaseTokenHash: null },
          { leaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: 'RUNNING',
        attempts: { increment: 1 },
        leaseTokenHash,
        leaseOwner: boundedOwner,
        leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
        lastErrorCode: null,
        lastErrorDetail: null,
        startedAt: now,
      },
    });
    if (updated.count !== 1) throw new AdminUserRetirementBusyError();
    const record = await this.readByTargetUserId(targetUserId);
    if (!record || record.leaseTokenHash !== leaseTokenHash) {
      throw new AdminUserRetirementIntegrityError('Claimed user retirement journal could not be read back');
    }
    return { record, leaseToken, leaseTokenHash };
  }

  async renew(
    recordId: string,
    leaseTokenHash: string,
    leaseDurationMs: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000 || leaseDurationMs > 15 * 60_000) {
      throw new AdminUserRetirementIntegrityError('User retirement lease duration is invalid');
    }
    const now = this.now();
    const updated = await retirementDelegate(this.database).updateMany({
      where: {
        id: recordId,
        status: 'RUNNING',
        leaseTokenHash,
        leaseExpiresAt: { gt: now },
      },
      data: {
        leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
      },
    });
    if (updated.count !== 1) {
      throw new AdminUserRetirementBusyError('User retirement lease changed before renewal');
    }
  }

  async advance(
    recordId: string,
    leaseTokenHash: string,
    expectedPhase: AdminUserRetirementPhase,
    nextPhase: AdminUserRetirementPhase,
    evidence: {
      admission?: AdminUserRetirementAdmissionEvidence;
      externalAbsenceDigest?: string;
    } = {},
  ): Promise<AdminUserRetirementRecord> {
    const expectedIndex = ADMIN_USER_RETIREMENT_PHASES.indexOf(expectedPhase);
    const nextIndex = ADMIN_USER_RETIREMENT_PHASES.indexOf(nextPhase);
    if (expectedIndex < 0 || nextIndex !== expectedIndex + 1) {
      throw new AdminUserRetirementIntegrityError('User retirement phase transition is not monotonic');
    }
    const now = this.now();
    const externalAbsenceDigest = evidence.externalAbsenceDigest
      ? assertDigest(evidence.externalAbsenceDigest, 'externalAbsenceDigest')
      : undefined;
    const admissionEvidence = evidence.admission
      ? validateAdmissionEvidence(
          evidence.admission,
          (await retirementDelegate(this.database).findUnique({
            where: { id: recordId },
          }))?.targetAuthorizationVersion,
        )
      : undefined;
    if (nextPhase === 'ADMISSION_CLOSED' && !admissionEvidence) {
      throw new AdminUserRetirementIntegrityError('Admission closure evidence is required');
    }
    if (nextPhase !== 'ADMISSION_CLOSED' && admissionEvidence) {
      throw new AdminUserRetirementIntegrityError('Admission evidence belongs to one phase');
    }
    if (nextPhase === 'EXTERNAL_ABSENCE_VERIFIED' && !externalAbsenceDigest) {
      throw new AdminUserRetirementIntegrityError('External absence evidence is required');
    }
    if (nextPhase !== 'EXTERNAL_ABSENCE_VERIFIED' && externalAbsenceDigest) {
      throw new AdminUserRetirementIntegrityError('External absence evidence belongs to one phase');
    }
    const completion = nextPhase === 'COMPLETE';
    const updated = await retirementDelegate(this.database).updateMany({
      where: {
        id: recordId,
        phase: expectedPhase,
        status: 'RUNNING',
        leaseTokenHash,
        leaseExpiresAt: { gt: now },
      },
      data: {
        phase: nextPhase,
        status: completion ? 'COMPLETE' : 'RUNNING',
        ...(nextPhase === 'ADMISSION_CLOSED'
          ? {
              admissionClosedAt: now,
              authorizationTransitionId: admissionEvidence!.transitionId,
              closedAuthorizationVersion: admissionEvidence!.closedAuthorizationVersion,
              admissionEvidenceDigest: admissionEvidence!.evidenceDigest,
            }
          : {}),
        ...(nextPhase === 'EXTERNAL_ABSENCE_VERIFIED'
          ? { externalAbsenceVerifiedAt: now, externalAbsenceDigest }
          : {}),
        ...(nextPhase === 'DATABASE_COMMITTED' ? { databaseCommittedAt: now } : {}),
        ...(completion
          ? {
              completedAt: now,
              leaseTokenHash: null,
              leaseOwner: null,
              leaseExpiresAt: null,
            }
          : {}),
      },
    });
    if (updated.count !== 1) {
      throw new AdminUserRetirementBusyError('User retirement lease or phase changed before commit');
    }
    const delegate = retirementDelegate(this.database);
    const value = await delegate.findUnique({ where: { id: recordId } });
    return normalizeRecord(value);
  }

  async block(
    recordId: string,
    leaseTokenHash: string,
    errorCode: string,
    errorDetail: string,
  ): Promise<void> {
    const updated = await retirementDelegate(this.database).updateMany({
      where: { id: recordId, status: 'RUNNING', leaseTokenHash },
      data: {
        status: 'BLOCKED',
        leaseTokenHash: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: assertNonEmpty(errorCode, 'lastErrorCode', 120),
        lastErrorDetail: assertNonEmpty(errorDetail, 'lastErrorDetail', 500),
      },
    });
    if (updated.count !== 1) {
      throw new AdminUserRetirementBusyError('User retirement lease changed before failure was recorded');
    }
  }
}

function boundedFailure(error: unknown): { code: string; detail: string } {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = String(candidate?.code || candidate?.constructor?.name || 'RETIREMENT_STEP_FAILED')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 120) || 'RETIREMENT_STEP_FAILED';
  const detail = String(candidate?.message || 'User retirement step failed')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || 'User retirement step failed';
  return { code, detail };
}

type AdminUserRetirementFailureOutcome =
  | { kind: 'DURABLY_BLOCKED'; failure: { code: string; detail: string } }
  | { kind: 'BLOCK_RECORDING_FAILED'; error: unknown };

const retirementFailureOutcomes = new WeakMap<object, AdminUserRetirementFailureOutcome>();

class AdminUserRetirementLeaseGuard {
  private timer: NodeJS.Timeout | null = null;
  private renewal: Promise<void> | null = null;
  private lost: unknown = null;

  constructor(
    private readonly store: AdminUserRetirementStore,
    private readonly recordId: string,
    private readonly leaseTokenHash: string,
    private readonly leaseDurationMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = Math.max(10, Math.min(10_000, Math.floor(this.leaseDurationMs / 3)));
    this.timer = setInterval(() => {
      void this.renewAndAssert().catch(() => {
        // The first renewal failure permanently poisons this guard. The driver
        // and every adapter checkpoint observe it before any later phase CAS.
      });
    }, intervalMs);
    this.timer.unref();
  }

  private lostError(): Error {
    const source = this.lost as { message?: unknown };
    const error = new AdminUserRetirementBusyError(
      `User retirement lease was lost${source?.message ? `: ${String(source.message)}` : ''}`,
    );
    (error as Error & { cause?: unknown }).cause = this.lost;
    return error;
  }

  async renewAndAssert(): Promise<void> {
    if (this.lost) throw this.lostError();
    if (!this.renewal) {
      const renewal = (async () => {
        try {
          await this.store.renew(
            this.recordId,
            this.leaseTokenHash,
            this.leaseDurationMs,
          );
        } catch (error) {
          this.lost = error || new Error('Unknown retirement lease renewal failure');
          throw this.lostError();
        } finally {
          this.renewal = null;
        }
      })();
      this.renewal = renewal;
    }
    await this.renewal;
    if (this.lost) throw this.lostError();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.renewal?.catch(() => undefined);
  }
}

export async function createAdminUserRetirementJournal(
  manifest: AdminUserRetirementManifestV1,
  store: AdminUserRetirementStore = new PrismaAdminUserRetirementStore(),
): Promise<AdminUserRetirementRecord> {
  validateAdminUserRetirementManifest(manifest);
  return store.create(manifest, digestAdminUserRetirementManifest(manifest));
}

/**
 * Crash-resumable retirement driver. Each adapter step must be idempotent and
 * must fail on uncertainty. A crash after external mutation but before phase
 * persistence deliberately reruns that exact step; no later phase is inferred.
 */
export async function runAdminUserRetirement(
  targetUserId: string,
  runner: AdminUserRetirementRunner,
  options: {
    store?: AdminUserRetirementStore;
    leaseOwner?: string;
    leaseDurationMs?: number;
  } = {},
): Promise<AdminUserRetirementRecord> {
  const store = options.store || new PrismaAdminUserRetirementStore();
  const claim = await store.claim(
    targetUserId,
    options.leaseOwner || `portal:${process.pid}`,
    options.leaseDurationMs || 5 * 60_000,
  );
  let record = claim.record;
  const manifest = record.manifest;
  const leaseDurationMs = options.leaseDurationMs || 5 * 60_000;
  const leaseGuard = new AdminUserRetirementLeaseGuard(
    store,
    record.id,
    claim.leaseTokenHash,
    leaseDurationMs,
  );
  leaseGuard.start();
  const context: AdminUserRetirementRunnerContext = Object.freeze({
    retirementId: record.id,
    manifestDigest: record.manifestDigest,
    assertHeld: () => leaseGuard.renewAndAssert(),
    renewLease: () => leaseGuard.renewAndAssert(),
    readAdmissionEvidence: () => validateAdmissionEvidence({
      transitionId: record.authorizationTransitionId,
      closedAuthorizationVersion: record.closedAuthorizationVersion,
      evidenceDigest: record.admissionEvidenceDigest,
    } as unknown as AdminUserRetirementAdmissionEvidence, manifest.target.authorizationVersion),
  });
  const runGuarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    await context.assertHeld();
    const result = await operation();
    await context.assertHeld();
    return result;
  };
  const advance = async (
    expectedPhase: AdminUserRetirementPhase,
    nextPhase: AdminUserRetirementPhase,
    evidence: {
      admission?: AdminUserRetirementAdmissionEvidence;
      externalAbsenceDigest?: string;
    } = {},
  ): Promise<AdminUserRetirementRecord> => {
    await context.assertHeld();
    const advanced = await store.advance(
      record.id,
      claim.leaseTokenHash,
      expectedPhase,
      nextPhase,
      evidence,
    );
    if (nextPhase !== 'COMPLETE') await context.assertHeld();
    return advanced;
  };
  try {
    if (record.phase === 'MANIFESTED') {
      const admission = validateAdmissionEvidence(
        await runGuarded(() => runner.closeAdmission(manifest, context)),
        manifest.target.authorizationVersion,
      );
      record = await advance(
        record.phase,
        'ADMISSION_CLOSED',
        { admission },
      );
    }
    if (record.phase === 'ADMISSION_CLOSED') {
      await runGuarded(() => runner.retireOwnedProjects(manifest, context));
      record = await advance(record.phase, 'OWNED_PROJECTS_RETIRED');
    }
    if (record.phase === 'OWNED_PROJECTS_RETIRED') {
      await runGuarded(() => runner.retireSharedActorState(manifest, context));
      record = await advance(
        record.phase,
        'SHARED_ACTOR_STATE_RETIRED',
      );
    }
    if (record.phase === 'SHARED_ACTOR_STATE_RETIRED') {
      await runGuarded(() => runner.retireExternalState(manifest, context));
      record = await advance(record.phase, 'EXTERNAL_STATE_RETIRED');
    }
    if (record.phase === 'EXTERNAL_STATE_RETIRED') {
      const verification = await runGuarded(
        () => runner.verifyExternalAbsence(manifest, context),
      );
      const evidenceDigest = assertDigest(verification?.evidenceDigest, 'external absence evidence');
      record = await advance(
        record.phase,
        'EXTERNAL_ABSENCE_VERIFIED',
        { externalAbsenceDigest: evidenceDigest },
      );
    }
    if (record.phase === 'EXTERNAL_ABSENCE_VERIFIED') {
      await runGuarded(() => runner.commitDatabaseDeletion(manifest, context));
      await runGuarded(() => runner.verifyDatabaseAbsence(manifest, context));
      const postCommitAbsence = await runGuarded(
        () => runner.verifyExternalAbsence(manifest, context),
      );
      if (assertDigest(postCommitAbsence?.evidenceDigest, 'post-commit external absence evidence')
        !== record.externalAbsenceDigest) {
        throw new AdminUserRetirementIntegrityError(
          'External absence evidence changed across the final User deletion',
        );
      }
      record = await advance(record.phase, 'DATABASE_COMMITTED');
    }
    if (record.phase === 'DATABASE_COMMITTED') {
      await runGuarded(() => runner.verifyDatabaseAbsence(manifest, context));
      const finalAbsence = await runGuarded(
        () => runner.verifyExternalAbsence(manifest, context),
      );
      if (assertDigest(finalAbsence?.evidenceDigest, 'final external absence evidence')
        !== record.externalAbsenceDigest) {
        throw new AdminUserRetirementIntegrityError(
          'External absence evidence changed before retirement completion',
        );
      }
      await leaseGuard.stop();
      record = await advance(record.phase, 'COMPLETE');
    }
    return record;
  } catch (error) {
    await leaseGuard.stop();
    const surfacedError = error && (typeof error === 'object' || typeof error === 'function')
      ? error as object
      : new Error(String(error || 'User retirement step failed'));
    const failure = boundedFailure(surfacedError);
    try {
      await store.block(record.id, claim.leaseTokenHash, failure.code, failure.detail);
      retirementFailureOutcomes.set(surfacedError, { kind: 'DURABLY_BLOCKED', failure });
    } catch (blockError) {
      retirementFailureOutcomes.set(surfacedError, {
        kind: 'BLOCK_RECORDING_FAILED',
        error: blockError,
      });
    }
    throw surfacedError;
  } finally {
    await leaseGuard.stop();
  }
}

export type AdminUserRetirementRecoveryBlock = {
  retirementId: string;
  targetUserId: string;
  errorCode: string;
};

export async function recoverUnfinishedAdminUserRetirements(
  runner: AdminUserRetirementRunner,
  options: {
    store?: AdminUserRetirementStore;
    leaseOwner?: string;
    leaseDurationMs?: number;
  } = {},
): Promise<{
  recovered: string[];
  busy: string[];
  blocked: AdminUserRetirementRecoveryBlock[];
}> {
  const store = options.store || new PrismaAdminUserRetirementStore();
  const pending = await store.listUnfinished();
  const recovered: string[] = [];
  const busy: string[] = [];
  const blocked: AdminUserRetirementRecoveryBlock[] = [];
  for (const record of pending) {
    try {
      await runAdminUserRetirement(record.targetUserId, runner, { ...options, store });
      recovered.push(record.targetUserId);
    } catch (error) {
      const outcome = error && typeof error === 'object'
        ? retirementFailureOutcomes.get(error)
        : undefined;
      if (outcome?.kind === 'DURABLY_BLOCKED') {
        blocked.push({
          retirementId: record.id,
          targetUserId: record.targetUserId,
          errorCode: outcome.failure.code,
        });
        continue;
      }
      if (outcome?.kind === 'BLOCK_RECORDING_FAILED') {
        throw outcome.error;
      }
      if (error instanceof AdminUserRetirementBusyError) {
        busy.push(record.targetUserId);
        continue;
      }
      // Claim/read failures occur outside the phase driver's BLOCKED CAS. They
      // are database/ledger failures, not safe per-retirement failures.
      throw error;
    }
  }
  return { recovered, busy, blocked };
}

/**
 * Read-only diagnostic gate for callers that cannot perform recovery. The
 * Portal server uses the production recovery runner instead: COMPLETE records
 * are recovered, durably BLOCKED records remain fenced and retryable, and live
 * lease contention is reported separately as busy.
 */
export async function assertNoUnfinishedAdminUserRetirementsAtStartup(
  store: AdminUserRetirementStore = new PrismaAdminUserRetirementStore(),
): Promise<void> {
  const pending = await store.listUnfinished();
  if (pending.length > 0) throw new AdminUserRetirementRecoveryRequiredError(pending.length);
}
