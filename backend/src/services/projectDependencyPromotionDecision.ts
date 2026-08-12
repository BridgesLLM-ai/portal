import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import type { JwtPayload } from '../utils/jwt';
import { canUseInteractivePortal } from '../utils/authz';
import { resolveProjectStoragePaths } from './projectStoragePaths';
import {
  assertHeldProjectDeletionLockLease,
  projectDeletionLockKey,
  type ProjectDeletionLockLease,
} from './projectDeletionLock';
import {
  buildProjectDependencyPromotionManifest,
  type ProjectDependencyPromotionManifest,
} from './projectDependencyPromotionManifest';

export type ProjectDependencyPromotionDecisionStatus = 'AUTHORIZED' | 'APPLIED';
export type ProjectDependencyPromotionLifecycleStatus =
  | 'DEPENDENCY_PROMOTING'
  | 'DEPENDENCY_QUARANTINED';

export interface ProjectDependencyPromotionDecisionSnapshot {
  operationId: string;
  actorUserId: string;
  sessionId: string;
  authorizationVersion: number;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  workspaceOwnerId: string;
  projectName: string;
  operationParentCanonicalRoot: string;
  operationParentDevice: string;
  operationParentInode: string;
  operationParentBirthtimeNs: string;
  operationParentMode: number;
  operationParentUid: number;
  operationParentGid: number;
  destinationCanonicalRoot: string;
  destinationRootDevice: string;
  destinationRootInode: string;
  destinationRootBirthtimeNs: string;
  manifestDigest: string;
  manifest: ProjectDependencyPromotionManifest;
}

export interface ProjectDependencyPromotionDecisionRecord
  extends ProjectDependencyPromotionDecisionSnapshot {
  status: ProjectDependencyPromotionDecisionStatus;
  authorizedAt: Date;
  appliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectDependencyPromotionLifecycleRecord {
  id: string;
  workspaceOwnerId: string;
  projectName: string;
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  generation: number;
  lifecycleStatus: ProjectDependencyPromotionLifecycleStatus;
  dependencyQuarantinedAt: Date | null;
}

export type ProjectDependencyPromotionFenceReleaseState =
  | 'PREDECISION_CLEAN'
  | 'ACTIVE'
  | 'DEPENDENCY_QUARANTINED';

interface PromotionDecisionSqlClient {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

export interface ProjectDependencyPromotionDecisionDatabase extends PromotionDecisionSqlClient {
  $transaction<T>(
    callback: (transaction: PromotionDecisionSqlClient) => Promise<T>,
    options?: {
      isolationLevel?: Prisma.TransactionIsolationLevel;
      maxWait?: number;
      timeout?: number;
    },
  ): Promise<T>;
}

export type ProjectDependencyPromotionDecisionErrorCode =
  | 'INVALID_INPUT'
  | 'AUTHORIZATION_CHANGED'
  | 'PROJECT_IDENTITY_CHANGED'
  | 'PROJECT_BUSY'
  | 'DECISION_CONFLICT'
  | 'DECISION_NOT_FOUND'
  | 'DECISION_STATE_CONFLICT'
  | 'DECISION_UNKNOWN'
  | 'EVIDENCE_NOT_CLEAN';

export class ProjectDependencyPromotionDecisionError extends Error {
  constructor(
    public readonly code: ProjectDependencyPromotionDecisionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectDependencyPromotionDecisionError';
  }
}

export class ProjectDependencyPromotionDecisionIndeterminateError
  extends ProjectDependencyPromotionDecisionError {
  constructor(message: string) {
    super('DECISION_UNKNOWN', message);
    this.name = 'ProjectDependencyPromotionDecisionIndeterminateError';
  }
}

export type ProjectDependencyPromotionAuthorizationOutcome =
  | { kind: 'authorized'; record: ProjectDependencyPromotionDecisionRecord }
  | {
    kind: 'denied';
    reason: Extract<
      ProjectDependencyPromotionDecisionErrorCode,
      | 'INVALID_INPUT'
      | 'AUTHORIZATION_CHANGED'
      | 'PROJECT_IDENTITY_CHANGED'
      | 'PROJECT_BUSY'
      | 'DECISION_CONFLICT'
    >;
  };

function isKnownPrecommitRejection(error: unknown): boolean {
  return error instanceof ProjectDependencyPromotionDecisionError
    && [
      'INVALID_INPUT',
      'AUTHORIZATION_CHANGED',
      'PROJECT_IDENTITY_CHANGED',
      'PROJECT_BUSY',
      'DECISION_CONFLICT',
    ].includes(error.code);
}

async function retryExactDecisionResolution(input: {
  operationId: string;
  manifestDigest: string;
  expectedSnapshot: ProjectDependencyPromotionDecisionSnapshot;
  database: ProjectDependencyPromotionDecisionDatabase;
  absentIsResolved?: boolean;
}): Promise<ProjectDependencyPromotionDecisionRecord | null> {
  let lastFailure: unknown;
  let successfulLookup = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const resolved = await resolveProjectDependencyPromotionDecision(input);
      if (resolved) {
        const identities = await input.database.$queryRaw<LockedProjectIdentityRow[]>(Prisma.sql`
          SELECT
            "id", "workspaceOwnerId", "projectName", "canonicalRoot",
      "rootDevice", "rootInode", "rootBirthtimeNs", "generation",
      "lifecycleStatus", "dependencyQuarantinedAt"
          FROM "ProjectIdentity"
          WHERE "id" = ${input.expectedSnapshot.projectIdentityId}
        `);
        assertProjectIdentity(
          identities[0],
          input.expectedSnapshot,
          ['DEPENDENCY_PROMOTING'],
        );
        return resolved;
      }
      successfulLookup = true;
      lastFailure = undefined;
    } catch (error) {
      if (error instanceof ProjectDependencyPromotionDecisionError) throw error;
      lastFailure = error;
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
  }
  if (input.absentIsResolved && successfulLookup && !lastFailure) return null;
  throw new ProjectDependencyPromotionDecisionIndeterminateError(
    lastFailure
      ? 'The promotion decision commit could not be resolved because the database is unavailable; preserve all journal evidence'
      : 'The promotion decision outcome is indeterminate; preserve all journal evidence for startup reconciliation',
  );
}

interface LockedActorRow {
  id: string;
  authorizationVersion: number;
  accountStatus: string;
  isActive: boolean;
  role: string;
  sandboxEnabled: boolean;
  createdAt: Date;
  databaseNow: Date;
}

interface LockedWorkspaceOwnerRow {
  id: string;
}

interface LockedSessionRow {
  id: string;
  expiresAt: Date;
}

interface LockedProjectIdentityRow {
  id: string;
  workspaceOwnerId: string;
  projectName: string;
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  generation: number;
  lifecycleStatus: string;
}

interface ActiveProjectChatTurnRow {
  id: string;
}

const defaultDatabase = prisma as unknown as ProjectDependencyPromotionDecisionDatabase;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PROMOTION_EVIDENCE_PREFIX = '.bridgesllm-project-promotion-';
const PROMOTION_JOURNAL_SUFFIX = '.journal.json';
const MAX_DURABLE_MANIFEST_BYTES = 128 * 1024;

function requiredIdentifier(value: unknown, label: string, maxLength = 255): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\u0000')) {
    throw new ProjectDependencyPromotionDecisionError('INVALID_INPUT', `Invalid ${label}`);
  }
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ProjectDependencyPromotionDecisionError('INVALID_INPUT', `Invalid ${label}`);
  }
  return parsed;
}

function operationId(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_V4.test(normalized)) {
    throw new ProjectDependencyPromotionDecisionError('INVALID_INPUT', 'Invalid promotion operation ID');
  }
  return normalized;
}

function manifestDigest(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SHA256.test(normalized)) {
    throw new ProjectDependencyPromotionDecisionError('INVALID_INPUT', 'Invalid dependency manifest digest');
  }
  return normalized;
}

function digestMatches(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === 32
    && rightBuffer.length === 32
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function canonicalRoot(value: unknown): string {
  const normalized = requiredIdentifier(value, 'promotion destination root', 4096);
  if (!path.isAbsolute(normalized) || path.normalize(normalized) !== normalized) {
    throw new ProjectDependencyPromotionDecisionError('INVALID_INPUT', 'Invalid promotion destination root');
  }
  return normalized;
}

function openProjectDependencyPromotionEvidenceAbsenceProof(
  record: ProjectDependencyPromotionDecisionRecord,
): { close(): void } {
  const destination = canonicalRoot(record.destinationCanonicalRoot);
  const parent = path.dirname(destination);
  const projectsRoot = path.resolve(resolveProjectStoragePaths().projectsDir);
  const ownerRoot = path.join(projectsRoot, record.workspaceOwnerId);
  if (
    path.basename(record.workspaceOwnerId) !== record.workspaceOwnerId
    || record.workspaceOwnerId === '.'
    || record.workspaceOwnerId === '..'
    || parent !== ownerRoot
    || path.dirname(ownerRoot) !== projectsRoot
    || path.basename(destination) !== record.projectName
    || path.join(ownerRoot, record.projectName) !== destination
    || record.operationParentCanonicalRoot !== ownerRoot
  ) {
    throw new ProjectDependencyPromotionDecisionError(
      'EVIDENCE_NOT_CLEAN',
      'The applied promotion receipt does not bind a safe owner/Project evidence path',
    );
  }
  let projectsDescriptor: number | null = null;
  let ownerDescriptor: number | null = null;
  try {
    if (fs.realpathSync.native(projectsRoot) !== projectsRoot) {
      throw new ProjectDependencyPromotionDecisionError(
        'EVIDENCE_NOT_CLEAN',
        'The Project storage root is not canonical',
      );
    }
    projectsDescriptor = fs.openSync(
      projectsRoot,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
    );
    const projectsDescriptorPath = `/proc/self/fd/${projectsDescriptor}`;
    if (fs.realpathSync.native(projectsDescriptorPath) !== projectsRoot) {
      throw new ProjectDependencyPromotionDecisionError(
        'EVIDENCE_NOT_CLEAN',
        'The Project storage descriptor changed identity',
      );
    }
    ownerDescriptor = fs.openSync(
      path.join(projectsDescriptorPath, record.workspaceOwnerId),
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
    );
    const projectsStat = fs.fstatSync(projectsDescriptor, { bigint: true });
    const ownerStat = fs.fstatSync(ownerDescriptor, { bigint: true });
    if (!projectsStat.isDirectory() || !ownerStat.isDirectory()) {
      throw new ProjectDependencyPromotionDecisionError(
        'EVIDENCE_NOT_CLEAN',
        'The applied promotion receipt parent could not be attested',
      );
    }
    if (
      ownerStat.dev.toString() !== record.operationParentDevice
      || ownerStat.ino.toString() !== record.operationParentInode
      || ownerStat.birthtimeNs.toString() !== record.operationParentBirthtimeNs
      || Number(ownerStat.mode & 0o777n) !== record.operationParentMode
      || Number(ownerStat.uid) !== record.operationParentUid
      || Number(ownerStat.gid) !== record.operationParentGid
    ) throw new ProjectDependencyPromotionDecisionError(
      'EVIDENCE_NOT_CLEAN',
      'The applied promotion receipt parent changed identity',
    );
    const ownerDescriptorPath = `/proc/self/fd/${ownerDescriptor}`;
    if (fs.realpathSync.native(ownerDescriptorPath) !== ownerRoot) {
      throw new ProjectDependencyPromotionDecisionError(
        'EVIDENCE_NOT_CLEAN',
        'The applied promotion receipt parent is not canonical',
      );
    }
    const stagingBasename = `${PROMOTION_EVIDENCE_PREFIX}${record.operationId}`;
    const evidenceBasenames = [stagingBasename, `${stagingBasename}${PROMOTION_JOURNAL_SUFFIX}`];
    for (const basename of evidenceBasenames) {
      try {
        fs.lstatSync(path.join(ownerDescriptorPath, basename));
        throw new ProjectDependencyPromotionDecisionError(
          'EVIDENCE_NOT_CLEAN',
          'Filesystem promotion evidence still exists; keep the applied receipt',
        );
      } catch (error: any) {
        if (error instanceof ProjectDependencyPromotionDecisionError) throw error;
        if (error?.code !== 'ENOENT') {
          throw new ProjectDependencyPromotionDecisionError(
            'EVIDENCE_NOT_CLEAN',
            'Filesystem promotion evidence absence could not be proven',
          );
        }
      }
    }
    const journalBasename = `${stagingBasename}${PROMOTION_JOURNAL_SUFFIX}`;
    for (const basename of fs.readdirSync(ownerDescriptorPath)) {
      if (!basename.startsWith(`.${journalBasename}.`) || !basename.endsWith('.tmp')) continue;
      const middle = basename.slice(`.${journalBasename}.`.length, -'.tmp'.length);
      if (!/^\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(middle)) {
        throw new ProjectDependencyPromotionDecisionError(
          'EVIDENCE_NOT_CLEAN',
          'Filesystem promotion evidence contains an unsafe operation-scoped temporary',
        );
      }
      throw new ProjectDependencyPromotionDecisionError(
        'EVIDENCE_NOT_CLEAN',
        'Filesystem promotion journal cleanup is incomplete; keep the applied receipt',
      );
    }
    let closed = false;
    return { close: () => {
      if (closed) return;
      closed = true;
      fs.closeSync(ownerDescriptor!);
      ownerDescriptor = null;
      fs.closeSync(projectsDescriptor!);
      projectsDescriptor = null;
    } };
  } catch (error) {
    if (ownerDescriptor !== null) fs.closeSync(ownerDescriptor);
    if (projectsDescriptor !== null) fs.closeSync(projectsDescriptor);
    if (error instanceof ProjectDependencyPromotionDecisionError) throw error;
    throw new ProjectDependencyPromotionDecisionError(
      'EVIDENCE_NOT_CLEAN',
      'Filesystem promotion evidence absence could not be proven',
    );
  }
}

function durableSessionId(payload: JwtPayload): string {
  if (typeof payload.sessionId !== 'string' || !payload.sessionId.trim()) {
    throw new ProjectDependencyPromotionDecisionError(
      'AUTHORIZATION_CHANGED',
      'A durable Session is required for dependency installation; sign in again',
    );
  }
  return requiredIdentifier(payload.sessionId, 'durable Session ID');
}

function normalizeSnapshot(input: {
  operationId: string;
  actor: JwtPayload;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  workspaceOwnerId: string;
  projectName: string;
  destinationCanonicalRoot: string;
  destinationRootDevice: string;
  destinationRootInode: string;
  destinationRootBirthtimeNs: string;
  manifest: ProjectDependencyPromotionManifest;
}): ProjectDependencyPromotionDecisionSnapshot {
  const actorUserId = requiredIdentifier(input.actor.userId, 'actor user ID');
  const workspaceOwnerId = requiredIdentifier(input.workspaceOwnerId, 'workspace owner ID');
  const normalizedOperationId = operationId(input.operationId);
  const projectIdentityId = requiredIdentifier(input.projectIdentityId, 'Project identity ID');
  const projectIdentityGeneration = positiveInteger(
    input.projectIdentityGeneration,
    'Project identity generation',
  );
  const projectName = requiredIdentifier(input.projectName, 'Project name');
  const destinationCanonicalRoot = canonicalRoot(input.destinationCanonicalRoot);
  const destinationRootDevice = requiredIdentifier(input.destinationRootDevice, 'destination device', 128);
  const destinationRootInode = requiredIdentifier(input.destinationRootInode, 'destination inode', 128);
  const destinationRootBirthtimeNs = requiredIdentifier(
    input.destinationRootBirthtimeNs,
    'destination birthtime',
    128,
  );
  const manifest = canonicalProjectLifecyclePromotionManifest(input.manifest, {
    operationId: normalizedOperationId,
    projectIdentityId,
    projectIdentityGeneration,
    workspaceOwnerId,
    projectName,
    destinationCanonicalRoot,
    destinationRootDevice,
    destinationRootInode,
    destinationRootBirthtimeNs,
  });
  return Object.freeze({
    operationId: normalizedOperationId,
    actorUserId,
    sessionId: durableSessionId(input.actor),
    authorizationVersion: positiveInteger(input.actor.authorizationVersion ?? 1, 'authorization version'),
    projectIdentityId,
    projectIdentityGeneration,
    workspaceOwnerId,
    projectName,
    operationParentCanonicalRoot: canonicalRoot(input.manifest.operationParentCanonicalRoot),
    operationParentDevice: requiredIdentifier(input.manifest.operationParentIdentity.device, 'operation parent device', 128),
    operationParentInode: requiredIdentifier(input.manifest.operationParentIdentity.inode, 'operation parent inode', 128),
    operationParentBirthtimeNs: requiredIdentifier(
      input.manifest.operationParentIdentity.birthtimeNs,
      'operation parent birthtime',
      128,
    ),
    operationParentMode: Number(input.manifest.operationParentIdentity.mode),
    operationParentUid: Number(input.manifest.operationParentIdentity.uid),
    operationParentGid: Number(input.manifest.operationParentIdentity.gid),
    destinationCanonicalRoot,
    destinationRootDevice,
    destinationRootInode,
    destinationRootBirthtimeNs,
    manifestDigest: manifest.manifestDigest,
    manifest,
  });
}

function canonicalProjectLifecyclePromotionManifest(
  manifest: ProjectDependencyPromotionManifest,
  expected: {
  operationId: string;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  workspaceOwnerId: string;
  projectName: string;
  destinationCanonicalRoot: string;
  destinationRootDevice: string;
  destinationRootInode: string;
  destinationRootBirthtimeNs: string;
  },
): ProjectDependencyPromotionManifest {
  const recomputed = buildProjectDependencyPromotionManifest({
    schemaVersion: 1,
    operationId: manifest.operationId,
    workspaceOwnerId: manifest.workspaceOwnerId,
    projectName: manifest.projectName,
    projectIdentityId: manifest.projectIdentityId,
    projectIdentityGeneration: manifest.projectIdentityGeneration,
    projectRootBirthtimeNs: manifest.projectRootBirthtimeNs,
    operationParentCanonicalRoot: manifest.operationParentCanonicalRoot,
    operationParentIdentity: manifest.operationParentIdentity,
    destinationCanonicalRoot: manifest.destinationCanonicalRoot,
    destinationIdentity: manifest.destinationIdentity,
    stagingCanonicalRoot: manifest.stagingCanonicalRoot,
    stagingIdentity: manifest.stagingIdentity,
    entries: manifest.entries,
  });
  if (
    manifest.schemaVersion !== 1
    || operationId(manifest.operationId) !== expected.operationId
    || manifest.projectIdentityId !== expected.projectIdentityId
    || manifest.projectIdentityGeneration !== expected.projectIdentityGeneration
    || manifest.workspaceOwnerId !== expected.workspaceOwnerId
    || manifest.projectName !== expected.projectName
    || canonicalRoot(manifest.destinationCanonicalRoot) !== expected.destinationCanonicalRoot
    || manifest.destinationIdentity.kind !== 'directory'
    || manifest.destinationIdentity.device !== expected.destinationRootDevice
    || manifest.destinationIdentity.inode !== expected.destinationRootInode
    || manifest.destinationIdentity.birthtimeNs !== expected.destinationRootBirthtimeNs
    || manifest.projectRootBirthtimeNs !== expected.destinationRootBirthtimeNs
    || !digestMatches(recomputed.manifestDigest, manifest.manifestDigest)
    || !SHA256.test(manifest.manifestDigest)
    || Buffer.byteLength(JSON.stringify(recomputed), 'utf8') > MAX_DURABLE_MANIFEST_BYTES
  ) {
    throw new ProjectDependencyPromotionDecisionError(
      'INVALID_INPUT',
      'The server-owned promotion manifest does not match the exact Project decision snapshot',
    );
  }
  return recomputed;
}

function normalizedPersistedManifest(value: unknown): ProjectDependencyPromotionManifest {
  if (!value || typeof value !== 'object') {
    throw new ProjectDependencyPromotionDecisionError(
      'DECISION_CONFLICT',
      'The durable dependency promotion manifest is missing or malformed',
    );
  }
  const candidate = value as ProjectDependencyPromotionManifest;
  let normalized: ProjectDependencyPromotionManifest;
  try {
    normalized = buildProjectDependencyPromotionManifest({
      schemaVersion: candidate.schemaVersion,
      operationId: candidate.operationId,
      workspaceOwnerId: candidate.workspaceOwnerId,
      projectName: candidate.projectName,
      projectIdentityId: candidate.projectIdentityId,
      projectIdentityGeneration: candidate.projectIdentityGeneration,
      projectRootBirthtimeNs: candidate.projectRootBirthtimeNs,
      operationParentCanonicalRoot: candidate.operationParentCanonicalRoot,
      operationParentIdentity: candidate.operationParentIdentity,
      destinationCanonicalRoot: candidate.destinationCanonicalRoot,
      destinationIdentity: candidate.destinationIdentity,
      stagingCanonicalRoot: candidate.stagingCanonicalRoot,
      stagingIdentity: candidate.stagingIdentity,
      entries: candidate.entries,
    });
  } catch {
    throw new ProjectDependencyPromotionDecisionError(
      'DECISION_CONFLICT',
      'The durable dependency promotion manifest is missing or malformed',
    );
  }
  if (
    !SHA256.test(String(candidate.manifestDigest || ''))
    || !digestMatches(normalized.manifestDigest, candidate.manifestDigest)
    || Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_DURABLE_MANIFEST_BYTES
  ) {
    throw new ProjectDependencyPromotionDecisionError(
      'DECISION_CONFLICT',
      'The durable dependency promotion manifest failed canonical validation',
    );
  }
  return normalized;
}

function normalizedRecord(row: any): ProjectDependencyPromotionDecisionRecord {
  const manifest = normalizedPersistedManifest(row.manifest);
  const record = {
    operationId: String(row.operationId).toLowerCase(),
    actorUserId: String(row.actorUserId),
    sessionId: requiredIdentifier(row.sessionId, 'persisted durable Session ID'),
    authorizationVersion: Number(row.authorizationVersion),
    projectIdentityId: String(row.projectIdentityId),
    projectIdentityGeneration: Number(row.projectIdentityGeneration),
    workspaceOwnerId: String(row.workspaceOwnerId),
    projectName: String(row.projectName),
    operationParentCanonicalRoot: String(row.operationParentCanonicalRoot),
    operationParentDevice: String(row.operationParentDevice),
    operationParentInode: String(row.operationParentInode),
    operationParentBirthtimeNs: String(row.operationParentBirthtimeNs),
    operationParentMode: Number(row.operationParentMode),
    operationParentUid: Number(row.operationParentUid),
    operationParentGid: Number(row.operationParentGid),
    destinationCanonicalRoot: String(row.destinationCanonicalRoot),
    destinationRootDevice: String(row.destinationRootDevice),
    destinationRootInode: String(row.destinationRootInode),
    destinationRootBirthtimeNs: String(row.destinationRootBirthtimeNs),
    manifestDigest: String(row.manifestDigest),
    manifest,
    status: String(row.status) as ProjectDependencyPromotionDecisionStatus,
    authorizedAt: new Date(row.authorizedAt),
    appliedAt: row.appliedAt == null ? null : new Date(row.appliedAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
  if (
    !digestMatches(record.manifestDigest, manifest.manifestDigest)
    || record.operationId !== manifest.operationId
    || record.projectIdentityId !== manifest.projectIdentityId
    || record.projectIdentityGeneration !== manifest.projectIdentityGeneration
    || record.workspaceOwnerId !== manifest.workspaceOwnerId
    || record.projectName !== manifest.projectName
    || record.operationParentCanonicalRoot !== manifest.operationParentCanonicalRoot
    || record.operationParentDevice !== manifest.operationParentIdentity.device
    || record.operationParentInode !== manifest.operationParentIdentity.inode
    || record.operationParentBirthtimeNs !== manifest.operationParentIdentity.birthtimeNs
    || record.operationParentMode !== manifest.operationParentIdentity.mode
    || record.operationParentUid !== manifest.operationParentIdentity.uid
    || record.operationParentGid !== manifest.operationParentIdentity.gid
    || record.destinationCanonicalRoot !== manifest.destinationCanonicalRoot
    || record.destinationRootDevice !== manifest.destinationIdentity.device
    || record.destinationRootInode !== manifest.destinationIdentity.inode
    || record.destinationRootBirthtimeNs !== manifest.destinationIdentity.birthtimeNs
    || record.destinationRootBirthtimeNs !== manifest.projectRootBirthtimeNs
  ) {
    throw new ProjectDependencyPromotionDecisionError(
      'DECISION_CONFLICT',
      'The durable dependency promotion manifest conflicts with its immutable receipt snapshot',
    );
  }
  return Object.freeze(record);
}

function normalizedLifecycleRecord(row: any): ProjectDependencyPromotionLifecycleRecord {
  return Object.freeze({
    id: String(row.id),
    workspaceOwnerId: String(row.workspaceOwnerId),
    projectName: String(row.projectName),
    canonicalRoot: String(row.canonicalRoot),
    rootDevice: String(row.rootDevice),
    rootInode: String(row.rootInode),
    rootBirthtimeNs: String(row.rootBirthtimeNs),
    generation: Number(row.generation),
    lifecycleStatus: String(row.lifecycleStatus) as ProjectDependencyPromotionLifecycleStatus,
    dependencyQuarantinedAt: row.dependencyQuarantinedAt == null
      ? null
      : new Date(row.dependencyQuarantinedAt),
  });
}

function decisionSnapshot(record: ProjectDependencyPromotionDecisionRecord): ProjectDependencyPromotionDecisionSnapshot {
  const {
    status: _status,
    authorizedAt: _authorizedAt,
    appliedAt: _appliedAt,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...snapshot
  } = record;
  return snapshot;
}

async function queryByOperation(
  database: PromotionDecisionSqlClient,
  requestedOperationId: string,
): Promise<ProjectDependencyPromotionDecisionRecord | null> {
  const rows = await database.$queryRaw<any[]>(Prisma.sql`
    SELECT *
    FROM "ProjectDependencyPromotionDecision"
    WHERE "operationId" = ${requestedOperationId}::uuid
  `);
  return rows[0] ? normalizedRecord(rows[0]) : null;
}

function assertSnapshotMatches(
  record: ProjectDependencyPromotionDecisionRecord,
  expected: ProjectDependencyPromotionDecisionSnapshot,
): void {
  const keys: Array<keyof ProjectDependencyPromotionDecisionSnapshot> = [
    'operationId',
    'actorUserId',
    'sessionId',
    'authorizationVersion',
    'projectIdentityId',
    'projectIdentityGeneration',
    'workspaceOwnerId',
    'projectName',
    'operationParentCanonicalRoot',
    'operationParentDevice',
    'operationParentInode',
    'operationParentBirthtimeNs',
    'operationParentMode',
    'operationParentUid',
    'operationParentGid',
    'destinationCanonicalRoot',
    'destinationRootDevice',
    'destinationRootInode',
    'destinationRootBirthtimeNs',
    'manifestDigest',
  ];
  if (
    keys.some((key) => record[key] !== expected[key])
    || JSON.stringify(record.manifest) !== JSON.stringify(expected.manifest)
  ) {
    throw new ProjectDependencyPromotionDecisionError(
      'DECISION_CONFLICT',
      'The promotion operation ID is already bound to a different immutable snapshot',
    );
  }
}

function projectIdentityMatchesSnapshot(
  identity: LockedProjectIdentityRow | undefined,
  expected: ProjectDependencyPromotionDecisionSnapshot,
): identity is LockedProjectIdentityRow {
  return Boolean(
    identity
    && identity.workspaceOwnerId === expected.workspaceOwnerId
    && identity.projectName === expected.projectName
    && identity.canonicalRoot === expected.destinationCanonicalRoot
    && identity.rootDevice === expected.destinationRootDevice
    && identity.rootInode === expected.destinationRootInode
    && identity.rootBirthtimeNs === expected.destinationRootBirthtimeNs
    && Number(identity.generation) === expected.projectIdentityGeneration
  );
}

function assertProjectIdentity(
  identity: LockedProjectIdentityRow | undefined,
  expected: ProjectDependencyPromotionDecisionSnapshot,
  allowedStatuses: readonly string[] = ['ACTIVE'],
): asserts identity is LockedProjectIdentityRow {
  if (!projectIdentityMatchesSnapshot(identity, expected)
    || !allowedStatuses.includes(identity.lifecycleStatus)) {
    throw new ProjectDependencyPromotionDecisionError(
      'PROJECT_IDENTITY_CHANGED',
      'The Project identity changed before dependency promotion authorization committed',
    );
  }
}

function isUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return candidate.code === '23505'
    || candidate.code === 'P2002'
    || candidate.meta?.code === '23505';
}

export async function resolveProjectDependencyPromotionDecision(input: {
  operationId: string;
  manifestDigest: string;
  expectedSnapshot?: ProjectDependencyPromotionDecisionSnapshot;
  database?: ProjectDependencyPromotionDecisionDatabase;
}): Promise<ProjectDependencyPromotionDecisionRecord | null> {
  const requestedOperationId = operationId(input.operationId);
  const requestedDigest = manifestDigest(input.manifestDigest);
  const record = await queryByOperation(input.database || defaultDatabase, requestedOperationId);
  if (!record) return null;
  if (!digestMatches(record.manifestDigest, requestedDigest)) {
    throw new ProjectDependencyPromotionDecisionError(
      'DECISION_CONFLICT',
      'The promotion operation ID is bound to a different dependency manifest',
    );
  }
  if (input.expectedSnapshot) assertSnapshotMatches(record, input.expectedSnapshot);
  return record;
}

export async function findProjectDependencyPromotionDecisionByDestination(input: {
  destinationCanonicalRoot: string;
  database?: ProjectDependencyPromotionDecisionDatabase;
}): Promise<ProjectDependencyPromotionDecisionRecord | null> {
  const destination = canonicalRoot(input.destinationCanonicalRoot);
  const rows = await (input.database || defaultDatabase).$queryRaw<any[]>(Prisma.sql`
    SELECT *
    FROM "ProjectDependencyPromotionDecision"
    WHERE "destinationCanonicalRoot" = ${destination}
  `);
  return rows[0] ? normalizedRecord(rows[0]) : null;
}

/** Deterministic bounded scan used by startup to reconcile DB rows union FS evidence. */
export async function listProjectDependencyPromotionDecisions(input: {
  afterOperationId?: string;
  limit?: number;
  status?: ProjectDependencyPromotionDecisionStatus;
  database?: ProjectDependencyPromotionDecisionDatabase;
} = {}): Promise<ProjectDependencyPromotionDecisionRecord[]> {
  const limit = input.limit == null ? 100 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new ProjectDependencyPromotionDecisionError('INVALID_INPUT', 'Invalid promotion decision scan limit');
  }
  if (input.status && input.status !== 'AUTHORIZED' && input.status !== 'APPLIED') {
    throw new ProjectDependencyPromotionDecisionError('INVALID_INPUT', 'Invalid promotion decision status');
  }
  const cursor = input.afterOperationId ? operationId(input.afterOperationId) : null;
  const rows = await (input.database || defaultDatabase).$queryRaw<any[]>(Prisma.sql`
    SELECT *
    FROM "ProjectDependencyPromotionDecision"
    WHERE (${cursor}::uuid IS NULL OR "operationId" > ${cursor}::uuid)
      AND (${input.status || null}::text IS NULL OR "status" = ${input.status || null})
    ORDER BY "operationId" ASC
    LIMIT ${limit}
  `);
  return rows.map(normalizedRecord);
}

/** Deterministic startup-side scan of exact Project identities held by promotion containment. */
export async function listProjectDependencyPromotionLifecycleRecords(input: {
  afterId?: string;
  limit?: number;
  database?: ProjectDependencyPromotionDecisionDatabase;
} = {}): Promise<ProjectDependencyPromotionLifecycleRecord[]> {
  const limit = input.limit == null ? 100 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new ProjectDependencyPromotionDecisionError('INVALID_INPUT', 'Invalid promotion lifecycle scan limit');
  }
  const afterId = input.afterId ? requiredIdentifier(input.afterId, 'Project identity scan cursor') : null;
  const rows = await (input.database || defaultDatabase).$queryRaw<any[]>(Prisma.sql`
    SELECT
      "id", "workspaceOwnerId", "projectName", "canonicalRoot",
      "rootDevice", "rootInode", "rootBirthtimeNs", "generation",
      "lifecycleStatus", "dependencyQuarantinedAt"
    FROM "ProjectIdentity"
    WHERE "lifecycleStatus" IN ('DEPENDENCY_PROMOTING', 'DEPENDENCY_QUARANTINED')
      AND (${afterId}::text IS NULL OR "id" > ${afterId})
    ORDER BY "id" ASC
    LIMIT ${limit}
  `);
  return rows.map(normalizedLifecycleRecord);
}

export async function readProjectDependencyPromotionLifecycle(input: {
  projectIdentityId: string;
  database?: ProjectDependencyPromotionDecisionDatabase;
}): Promise<ProjectDependencyPromotionLifecycleRecord | null> {
  const id = requiredIdentifier(input.projectIdentityId, 'Project identity ID');
  const rows = await (input.database || defaultDatabase).$queryRaw<any[]>(Prisma.sql`
    SELECT
      "id", "workspaceOwnerId", "projectName", "canonicalRoot",
      "rootDevice", "rootInode", "rootBirthtimeNs", "generation",
      "lifecycleStatus", "dependencyQuarantinedAt"
    FROM "ProjectIdentity"
    WHERE "id" = ${id}
  `);
  if (!rows[0]) return null;
  const status = String(rows[0].lifecycleStatus);
  if (status !== 'DEPENDENCY_PROMOTING' && status !== 'DEPENDENCY_QUARANTINED') return null;
  return normalizedLifecycleRecord(rows[0]);
}

/** Exact owner/name containment lookup used by the central lifecycle lock guard. */
export async function readProjectDependencyPromotionLifecycleByProject(input: {
  workspaceOwnerId: string;
  projectName: string;
  database?: ProjectDependencyPromotionDecisionDatabase;
}): Promise<ProjectDependencyPromotionLifecycleRecord | null> {
  const workspaceOwnerId = requiredIdentifier(input.workspaceOwnerId, 'workspace owner ID');
  const projectName = requiredIdentifier(input.projectName, 'Project name');
  const rows = await (input.database || defaultDatabase).$queryRaw<any[]>(Prisma.sql`
    SELECT
      "id", "workspaceOwnerId", "projectName", "canonicalRoot",
      "rootDevice", "rootInode", "rootBirthtimeNs", "generation",
      "lifecycleStatus", "dependencyQuarantinedAt"
    FROM "ProjectIdentity"
    WHERE "workspaceOwnerId" = ${workspaceOwnerId}
      AND "projectName" = ${projectName}
      AND "lifecycleStatus" IN ('DEPENDENCY_PROMOTING', 'DEPENDENCY_QUARANTINED')
  `);
  if (rows.length > 1) {
    throw new ProjectDependencyPromotionDecisionError(
      'DECISION_CONFLICT',
      'Multiple Project identities claim the same dependency containment key',
    );
  }
  return rows[0] ? normalizedLifecycleRecord(rows[0]) : null;
}

/**
 * Serializable readback used immediately before reopening the process-global
 * writer gate. Filesystem all-old/all-new/evidence-absence proof remains the
 * caller's responsibility while it owns the exact Project lifecycle lock.
 */
export async function attestProjectDependencyPromotionFenceReleaseState(input: {
  operationId: string;
  manifestDigest: string;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  workspaceOwnerId: string;
  projectName: string;
  destinationCanonicalRoot: string;
  destinationRootDevice: string;
  destinationRootInode: string;
  destinationRootBirthtimeNs: string;
  expectedState: ProjectDependencyPromotionFenceReleaseState;
  database?: ProjectDependencyPromotionDecisionDatabase;
}): Promise<void> {
  const database = input.database || defaultDatabase;
  const requestedOperationId = operationId(input.operationId);
  const requestedDigest = manifestDigest(input.manifestDigest);
  const expected = {
    projectIdentityId: requiredIdentifier(input.projectIdentityId, 'Project identity ID'),
    projectIdentityGeneration: positiveInteger(
      input.projectIdentityGeneration,
      'Project identity generation',
    ),
    workspaceOwnerId: requiredIdentifier(input.workspaceOwnerId, 'workspace owner ID'),
    projectName: requiredIdentifier(input.projectName, 'Project name'),
    destinationCanonicalRoot: canonicalRoot(input.destinationCanonicalRoot),
    destinationRootDevice: requiredIdentifier(input.destinationRootDevice, 'destination device'),
    destinationRootInode: requiredIdentifier(input.destinationRootInode, 'destination inode'),
    destinationRootBirthtimeNs: requiredIdentifier(
      input.destinationRootBirthtimeNs,
      'destination birth time',
    ),
  };
  if (!['PREDECISION_CLEAN', 'ACTIVE', 'DEPENDENCY_QUARANTINED'].includes(input.expectedState)) {
    throw new ProjectDependencyPromotionDecisionError('INVALID_INPUT', 'Invalid fence release state');
  }

  await database.$transaction(async (transaction) => {
    const [decision, destinationDecisions, identities] = await Promise.all([
      queryByOperation(transaction, requestedOperationId),
      transaction.$queryRaw<any[]>(Prisma.sql`
        SELECT *
        FROM "ProjectDependencyPromotionDecision"
        WHERE "destinationCanonicalRoot" = ${expected.destinationCanonicalRoot}
        FOR SHARE
      `),
      transaction.$queryRaw<LockedProjectIdentityRow[]>(Prisma.sql`
        SELECT
          "id", "workspaceOwnerId", "projectName", "canonicalRoot",
      "rootDevice", "rootInode", "rootBirthtimeNs", "generation",
      "lifecycleStatus", "dependencyQuarantinedAt"
        FROM "ProjectIdentity"
        WHERE "workspaceOwnerId" = ${expected.workspaceOwnerId}
          AND "projectName" = ${expected.projectName}
        FOR SHARE
      `),
    ]);
    const exactIdentity = identities.find((identity) => identity.id === expected.projectIdentityId);
    const exactIdentityMatches = Boolean(
      exactIdentity
      && exactIdentity.canonicalRoot === expected.destinationCanonicalRoot
      && exactIdentity.rootDevice === expected.destinationRootDevice
      && exactIdentity.rootInode === expected.destinationRootInode
      && exactIdentity.rootBirthtimeNs === expected.destinationRootBirthtimeNs
      && Number(exactIdentity.generation) === expected.projectIdentityGeneration,
    );

    if (input.expectedState === 'PREDECISION_CLEAN') {
      if (
        decision
        || destinationDecisions.length !== 0
        || identities.some((identity) => (
          identity.lifecycleStatus === 'DEPENDENCY_PROMOTING'
          || identity.lifecycleStatus === 'DEPENDENCY_QUARANTINED'
        ))
      ) {
        throw new ProjectDependencyPromotionDecisionError(
          'DECISION_STATE_CONFLICT',
          'The staged dependency promotion is not cleanly pre-decision',
        );
      }
      return;
    }

    if (input.expectedState === 'ACTIVE') {
      if (
        decision
        || destinationDecisions.length !== 0
        || !exactIdentityMatches
        || exactIdentity?.lifecycleStatus !== 'ACTIVE'
      ) {
        throw new ProjectDependencyPromotionDecisionError(
          'DECISION_STATE_CONFLICT',
          'The exact Project did not return to ACTIVE after dependency promotion',
        );
      }
      return;
    }

    if (
      !decision
      || !digestMatches(decision.manifestDigest, requestedDigest)
      || destinationDecisions.length !== 1
      || String(destinationDecisions[0]?.operationId) !== requestedOperationId
      || !exactIdentityMatches
      || exactIdentity?.lifecycleStatus !== 'DEPENDENCY_QUARANTINED'
    ) {
      throw new ProjectDependencyPromotionDecisionError(
        'DECISION_STATE_CONFLICT',
        'The exact dependency promotion is not durably quarantined',
      );
    }
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 10_000,
  });
}

/**
 * Persist the authorization decision after staging, while row-locking the
 * exact durable access authority and Project identity. The transaction does
 * only locked reads plus an idempotent INSERT; it never mutates an existing
 * receipt. A lost commit response is resolved by operation ID + digest.
 */
async function authorizeProjectDependencyPromotionRecord(input: {
  operationId: string;
  actor: JwtPayload;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  workspaceOwnerId: string;
  projectName: string;
  destinationCanonicalRoot: string;
  destinationRootDevice: string;
  destinationRootInode: string;
  destinationRootBirthtimeNs: string;
  manifest: ProjectDependencyPromotionManifest;
  database?: ProjectDependencyPromotionDecisionDatabase;
}): Promise<ProjectDependencyPromotionDecisionRecord> {
  const database = input.database || defaultDatabase;
  const expected = normalizeSnapshot(input);
  try {
    return await database.$transaction(async (transaction) => {
      const actors = await transaction.$queryRaw<LockedActorRow[]>(Prisma.sql`
        SELECT
          "id",
          "authorizationVersion",
          "accountStatus"::text AS "accountStatus",
          "isActive",
          "role"::text AS "role",
          "sandboxEnabled",
          "createdAt",
          clock_timestamp() AS "databaseNow"
        FROM "User"
        WHERE "id" = ${expected.actorUserId}
        FOR SHARE
      `);
      const actor = actors[0];
      if (
        !actor
        || !canUseInteractivePortal(actor.role, actor.accountStatus, actor.isActive)
        || Number(actor.authorizationVersion) !== expected.authorizationVersion
        || (
          Number.isFinite(input.actor.exp)
          && Number(input.actor.exp) * 1000 <= new Date(actor.databaseNow).getTime()
        )
      ) {
        throw new ProjectDependencyPromotionDecisionError(
          'AUTHORIZATION_CHANGED',
          'The dependency promotion authorization changed before admission',
        );
      }

      if (expected.actorUserId !== expected.workspaceOwnerId) {
        if (!['OWNER', 'SUB_ADMIN'].includes(actor.role) || actor.sandboxEnabled !== false) {
          throw new ProjectDependencyPromotionDecisionError(
            'AUTHORIZATION_CHANGED',
            'The dependency promotion actor is not authorized for another workspace',
          );
        }
        const owners = await transaction.$queryRaw<LockedWorkspaceOwnerRow[]>(Prisma.sql`
          SELECT "id"
          FROM "User"
          WHERE "role" = 'OWNER'::"UserRole"
            AND "accountStatus" = 'ACTIVE'::"AccountStatus"
            AND "isActive" = TRUE
          ORDER BY "createdAt" ASC, "id" ASC
          LIMIT 1
          FOR SHARE
        `);
        if (owners[0]?.id !== expected.workspaceOwnerId) {
          throw new ProjectDependencyPromotionDecisionError(
            'AUTHORIZATION_CHANGED',
            'The Project workspace owner is not the current primary owner',
          );
        }
      }

      const sessions = await transaction.$queryRaw<LockedSessionRow[]>(Prisma.sql`
        SELECT "id", "expiresAt"
        FROM "Session"
        WHERE "id" = ${expected.sessionId}
          AND "userId" = ${expected.actorUserId}
          AND "expiresAt" > clock_timestamp()
        FOR SHARE
      `);
      if (!sessions[0]) {
        throw new ProjectDependencyPromotionDecisionError(
          'AUTHORIZATION_CHANGED',
          'The durable Session was revoked before dependency promotion admission; sign in again',
        );
      }

      const identities = await transaction.$queryRaw<LockedProjectIdentityRow[]>(Prisma.sql`
        SELECT
          "id", "workspaceOwnerId", "projectName", "canonicalRoot",
          "rootDevice", "rootInode", "rootBirthtimeNs", "generation",
          "lifecycleStatus"
        FROM "ProjectIdentity"
        WHERE "id" = ${expected.projectIdentityId}
        FOR UPDATE
      `);
      const existing = await queryByOperation(transaction, expected.operationId);
      if (existing) {
        assertSnapshotMatches(existing, expected);
        assertProjectIdentity(
          identities[0],
          expected,
          ['DEPENDENCY_PROMOTING'],
        );
        return existing;
      }
      assertProjectIdentity(identities[0], expected);

      const activeTurns = await transaction.$queryRaw<ActiveProjectChatTurnRow[]>(Prisma.sql`
        SELECT "id"
        FROM "ProjectChatTurn"
        WHERE "projectIdentityId" = ${expected.projectIdentityId}
          AND "status" IN (
            'RUNNING'::"ProjectChatTurnStatus",
            'ABORTING'::"ProjectChatTurnStatus"
          )
        LIMIT 1
        FOR SHARE
      `);
      if (activeTurns[0]) {
        throw new ProjectDependencyPromotionDecisionError(
          'PROJECT_BUSY',
          'Finish or stop the active Project Chat turn before installing dependencies',
        );
      }

      const fenced = await transaction.$queryRaw<LockedProjectIdentityRow[]>(Prisma.sql`
        UPDATE "ProjectIdentity"
        SET "lifecycleStatus" = 'DEPENDENCY_PROMOTING',
            "dependencyQuarantinedAt" = NULL,
            "updatedAt" = clock_timestamp()
        WHERE "id" = ${expected.projectIdentityId}
          AND "workspaceOwnerId" = ${expected.workspaceOwnerId}
          AND "projectName" = ${expected.projectName}
          AND "canonicalRoot" = ${expected.destinationCanonicalRoot}
          AND "rootDevice" = ${expected.destinationRootDevice}
          AND "rootInode" = ${expected.destinationRootInode}
          AND "rootBirthtimeNs" = ${expected.destinationRootBirthtimeNs}
          AND "generation" = ${expected.projectIdentityGeneration}
          AND "lifecycleStatus" = 'ACTIVE'
        RETURNING
          "id", "workspaceOwnerId", "projectName", "canonicalRoot",
          "rootDevice", "rootInode", "rootBirthtimeNs", "generation",
          "lifecycleStatus"
      `);
      assertProjectIdentity(fenced[0], expected, ['DEPENDENCY_PROMOTING']);

      const inserted = await transaction.$queryRaw<any[]>(Prisma.sql`
        INSERT INTO "ProjectDependencyPromotionDecision" (
          "operationId", "actorUserId", "sessionId", "authorizationVersion",
          "projectIdentityId", "projectIdentityGeneration", "workspaceOwnerId",
          "projectName", "operationParentCanonicalRoot", "operationParentDevice",
          "operationParentInode", "operationParentBirthtimeNs",
          "operationParentMode", "operationParentUid", "operationParentGid",
          "destinationCanonicalRoot", "destinationRootDevice",
          "destinationRootInode", "destinationRootBirthtimeNs", "manifestDigest",
          "manifest"
        ) VALUES (
          ${expected.operationId}::uuid, ${expected.actorUserId}, ${expected.sessionId},
          ${expected.authorizationVersion}, ${expected.projectIdentityId},
          ${expected.projectIdentityGeneration}, ${expected.workspaceOwnerId},
          ${expected.projectName}, ${expected.operationParentCanonicalRoot},
          ${expected.operationParentDevice}, ${expected.operationParentInode},
          ${expected.operationParentBirthtimeNs}, ${expected.operationParentMode},
          ${expected.operationParentUid}, ${expected.operationParentGid},
          ${expected.destinationCanonicalRoot},
          ${expected.destinationRootDevice}, ${expected.destinationRootInode},
          ${expected.destinationRootBirthtimeNs}, ${expected.manifestDigest},
          ${JSON.stringify(expected.manifest)}::jsonb
        )
        RETURNING *
      `);
      if (!inserted[0]) {
        throw new ProjectDependencyPromotionDecisionError(
          'DECISION_CONFLICT',
          'The dependency promotion decision did not commit',
        );
      }
      return normalizedRecord(inserted[0]);
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 10_000,
    });
  } catch (error) {
    if (isKnownPrecommitRejection(error)) throw error;
    // PostgreSQL/Prisma cannot distinguish every lost-response commit from an
    // aborted transaction. Resolve only the exact immutable operation+digest;
    // a conflicting snapshot always fails closed.
    const resolved = await retryExactDecisionResolution({
      operationId: expected.operationId,
      manifestDigest: expected.manifestDigest,
      expectedSnapshot: expected,
      database,
      absentIsResolved: isUniqueConflict(error),
    });
    if (resolved) return resolved;
    if (isUniqueConflict(error)) {
      throw new ProjectDependencyPromotionDecisionError(
        'DECISION_CONFLICT',
        'Another unresolved dependency promotion already owns this destination',
      );
    }
    throw new ProjectDependencyPromotionDecisionIndeterminateError(
      'The promotion decision outcome is indeterminate; preserve all journal evidence for startup reconciliation',
    );
  }
}

export async function authorizeProjectDependencyPromotion(input: {
  operationId: string;
  actor: JwtPayload;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  workspaceOwnerId: string;
  projectName: string;
  destinationCanonicalRoot: string;
  destinationRootDevice: string;
  destinationRootInode: string;
  destinationRootBirthtimeNs: string;
  manifest: ProjectDependencyPromotionManifest;
  database?: ProjectDependencyPromotionDecisionDatabase;
}): Promise<ProjectDependencyPromotionAuthorizationOutcome> {
  try {
    return {
      kind: 'authorized',
      record: await authorizeProjectDependencyPromotionRecord(input),
    };
  } catch (error) {
    if (error instanceof ProjectDependencyPromotionDecisionError && isKnownPrecommitRejection(error)) {
      return { kind: 'denied', reason: error.code as Extract<
        ProjectDependencyPromotionDecisionErrorCode,
        | 'INVALID_INPUT'
        | 'AUTHORIZATION_CHANGED'
        | 'PROJECT_IDENTITY_CHANGED'
        | 'PROJECT_BUSY'
        | 'DECISION_CONFLICT'
      > };
    }
    throw error;
  }
}

export async function markProjectDependencyPromotionApplied(input: {
  operationId: string;
  manifestDigest: string;
  database?: ProjectDependencyPromotionDecisionDatabase;
}): Promise<ProjectDependencyPromotionDecisionRecord> {
  const database = input.database || defaultDatabase;
  const requestedOperationId = operationId(input.operationId);
  const requestedDigest = manifestDigest(input.manifestDigest);
  let rows: any[];
  try {
    rows = await database.$queryRaw<any[]>(Prisma.sql`
      UPDATE "ProjectDependencyPromotionDecision"
      SET "status" = 'APPLIED',
          "appliedAt" = clock_timestamp(),
          "updatedAt" = clock_timestamp()
      WHERE "operationId" = ${requestedOperationId}::uuid
        AND "manifestDigest" = ${requestedDigest}
        AND "status" = 'AUTHORIZED'
      RETURNING *
    `);
  } catch {
    try {
      const resolved = await resolveProjectDependencyPromotionDecision({
        operationId: requestedOperationId,
        manifestDigest: requestedDigest,
        database,
      });
      if (resolved?.status === 'APPLIED') return resolved;
      if (resolved) {
        throw new ProjectDependencyPromotionDecisionError(
          'DECISION_STATE_CONFLICT',
          'The dependency promotion decision remains authorized',
        );
      }
    } catch (resolutionError) {
      if (resolutionError instanceof ProjectDependencyPromotionDecisionError) throw resolutionError;
      throw new ProjectDependencyPromotionDecisionIndeterminateError(
        'The applied decision outcome is unknown; preserve committed filesystem evidence',
      );
    }
    throw new ProjectDependencyPromotionDecisionIndeterminateError(
      'The applied decision outcome is unknown; preserve committed filesystem evidence',
    );
  }
  if (rows[0]) return normalizedRecord(rows[0]);
  const existing = await resolveProjectDependencyPromotionDecision({
    operationId: requestedOperationId,
    manifestDigest: requestedDigest,
    database,
  });
  if (existing?.status === 'APPLIED') return existing;
  throw new ProjectDependencyPromotionDecisionError(
    existing ? 'DECISION_STATE_CONFLICT' : 'DECISION_NOT_FOUND',
    existing
      ? 'The dependency promotion decision is not eligible to become applied'
      : 'The dependency promotion decision does not exist',
  );
}

/**
 * Contain an exact post-authorization ambiguity without widening the outage.
 * The immutable AUTHORIZED decision or APPLIED receipt and all remaining
 * filesystem evidence stay durable; only the bound Project identity changes
 * from PROMOTING to QUARANTINED.
 */
export async function quarantineProjectDependencyPromotion(input: {
  operationId: string;
  manifestDigest: string;
  lifecycleLock: ProjectDeletionLockLease;
  database?: ProjectDependencyPromotionDecisionDatabase;
}): Promise<ProjectDependencyPromotionLifecycleRecord> {
  const database = input.database || defaultDatabase;
  const requestedOperationId = operationId(input.operationId);
  const requestedDigest = manifestDigest(input.manifestDigest);
  const existing = await resolveProjectDependencyPromotionDecision({
    operationId: requestedOperationId,
    manifestDigest: requestedDigest,
    database,
  });
  if (!existing) {
    throw new ProjectDependencyPromotionDecisionError(
      'DECISION_NOT_FOUND',
      'The dependency promotion decision required for containment does not exist',
    );
  }
  if (existing.status !== 'AUTHORIZED' && existing.status !== 'APPLIED') {
    throw new ProjectDependencyPromotionDecisionError(
      'DECISION_STATE_CONFLICT',
      'Only an unresolved dependency promotion can enter scoped quarantine',
    );
  }
  assertHeldProjectDeletionLockLease(
    input.lifecycleLock,
    projectDeletionLockKey(existing.workspaceOwnerId, existing.projectName),
  );
  return database.$transaction(async (transaction) => {
    const lockedDecision = await queryByOperation(transaction, requestedOperationId);
    if (!lockedDecision
      || lockedDecision.manifestDigest !== requestedDigest
      || lockedDecision.status !== existing.status) {
      throw new ProjectDependencyPromotionDecisionError(
        'DECISION_STATE_CONFLICT',
        'The dependency promotion decision changed before containment',
      );
    }
    assertSnapshotMatches(lockedDecision, decisionSnapshot(existing));
    const identities = await transaction.$queryRaw<LockedProjectIdentityRow[]>(Prisma.sql`
      SELECT
        "id", "workspaceOwnerId", "projectName", "canonicalRoot",
        "rootDevice", "rootInode", "rootBirthtimeNs", "generation",
        "lifecycleStatus", "dependencyQuarantinedAt"
      FROM "ProjectIdentity"
      WHERE "id" = ${existing.projectIdentityId}
      FOR UPDATE
    `);
    assertProjectIdentity(
      identities[0],
      decisionSnapshot(existing),
      ['DEPENDENCY_PROMOTING', 'DEPENDENCY_QUARANTINED'],
    );
    if (identities[0].lifecycleStatus === 'DEPENDENCY_QUARANTINED') {
      return normalizedLifecycleRecord(identities[0]);
    }
    const quarantined = await transaction.$queryRaw<any[]>(Prisma.sql`
      UPDATE "ProjectIdentity"
      SET "lifecycleStatus" = 'DEPENDENCY_QUARANTINED',
          "dependencyQuarantinedAt" = COALESCE("dependencyQuarantinedAt", clock_timestamp()),
          "updatedAt" = clock_timestamp()
      WHERE "id" = ${existing.projectIdentityId}
        AND "workspaceOwnerId" = ${existing.workspaceOwnerId}
        AND "projectName" = ${existing.projectName}
        AND "canonicalRoot" = ${existing.destinationCanonicalRoot}
        AND "rootDevice" = ${existing.destinationRootDevice}
        AND "rootInode" = ${existing.destinationRootInode}
        AND "rootBirthtimeNs" = ${existing.destinationRootBirthtimeNs}
        AND "generation" = ${existing.projectIdentityGeneration}
        AND "lifecycleStatus" = 'DEPENDENCY_PROMOTING'
      RETURNING
        "id", "workspaceOwnerId", "projectName", "canonicalRoot",
        "rootDevice", "rootInode", "rootBirthtimeNs", "generation",
        "lifecycleStatus", "dependencyQuarantinedAt"
    `);
    if (!quarantined[0]) {
      throw new ProjectDependencyPromotionDecisionError(
        'PROJECT_IDENTITY_CHANGED',
        'The exact Project identity changed before dependency containment committed',
      );
    }
    return normalizedLifecycleRecord(quarantined[0]);
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 5_000,
    timeout: 10_000,
  });
}

export async function deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup(input: {
  operationId: string;
  manifestDigest: string;
  lifecycleLock: ProjectDeletionLockLease;
  /** Re-attest the complete durable all-new manifest after evidence removal. */
  verifyAppliedGeneration(manifest: ProjectDependencyPromotionManifest): void;
  /** Optional Owner-repair receipt finalized atomically with ACTIVE reopen. */
  finalizeRepair?: { repairId: string; repairBindingDigest: string };
  database?: ProjectDependencyPromotionDecisionDatabase;
}): Promise<boolean> {
  const database = input.database || defaultDatabase;
  const requestedOperationId = operationId(input.operationId);
  const requestedDigest = manifestDigest(input.manifestDigest);
  const existing = await resolveProjectDependencyPromotionDecision({
    operationId: requestedOperationId,
    manifestDigest: requestedDigest,
    database,
  });
  if (!existing) return false;
  if (existing.status !== 'APPLIED') {
    throw new ProjectDependencyPromotionDecisionError(
      'DECISION_STATE_CONFLICT',
      'An authorized promotion receipt cannot be deleted before it is applied',
    );
  }
  assertHeldProjectDeletionLockLease(
    input.lifecycleLock,
    projectDeletionLockKey(existing.workspaceOwnerId, existing.projectName),
  );
  // The caller holds the branded exact Project lifecycle lease. This service
  // must not reacquire that non-reentrant lock; it owns the final evidence
  // absence proof, re-attests every durable target, and immediately performs
  // the conditional DELETE + lifecycle reopen.
  const evidenceProof = openProjectDependencyPromotionEvidenceAbsenceProof(existing);
  let rows: Array<{ operationId: string }>;
  try {
    input.verifyAppliedGeneration(existing.manifest);
    rows = await database.$transaction(async (transaction) => {
      const lockedDecision = await queryByOperation(transaction, requestedOperationId);
      if (!lockedDecision) return [];
      if (lockedDecision.manifestDigest !== requestedDigest || lockedDecision.status !== 'APPLIED') {
        throw new ProjectDependencyPromotionDecisionError(
          'DECISION_STATE_CONFLICT',
          'The dependency promotion receipt changed before final cleanup',
        );
      }
      const identities = await transaction.$queryRaw<LockedProjectIdentityRow[]>(Prisma.sql`
        SELECT
          "id", "workspaceOwnerId", "projectName", "canonicalRoot",
          "rootDevice", "rootInode", "rootBirthtimeNs", "generation",
          "lifecycleStatus"
        FROM "ProjectIdentity"
        WHERE "id" = ${lockedDecision.projectIdentityId}
        FOR UPDATE
      `);
      assertProjectIdentity(
        identities[0],
        decisionSnapshot(lockedDecision),
        ['DEPENDENCY_PROMOTING'],
      );
      const deleted = await transaction.$queryRaw<Array<{ operationId: string }>>(Prisma.sql`
        DELETE FROM "ProjectDependencyPromotionDecision"
        WHERE "operationId" = ${requestedOperationId}::uuid
          AND "manifestDigest" = ${requestedDigest}
          AND "status" = 'APPLIED'
        RETURNING "operationId"
      `);
      if (!deleted[0]) {
        throw new ProjectDependencyPromotionDecisionError(
          'DECISION_STATE_CONFLICT',
          'The applied promotion receipt could not be retired',
        );
      }
      if (input.finalizeRepair) {
        const finalizedRepair = await transaction.$queryRaw<Array<{ repairId: string }>>(Prisma.sql`
          UPDATE "ProjectDependencyRepairOperation"
          SET "status" = 'APPLIED',
              "phase" = 'COMPLETE',
              "completedAt" = clock_timestamp(),
              "updatedAt" = clock_timestamp()
          WHERE "repairId" = ${input.finalizeRepair.repairId}::uuid
            AND "repairBindingDigest" = ${input.finalizeRepair.repairBindingDigest}
            AND "promotionOperationId" = ${requestedOperationId}::uuid
            AND "manifestDigest" = ${requestedDigest}
            AND "projectIdentityId" = ${lockedDecision.projectIdentityId}
            AND "projectIdentityGeneration" = ${lockedDecision.projectIdentityGeneration}
            AND "status" = 'PROMOTING'
            AND "phase" = 'EVIDENCE_CLEAN'
          RETURNING "repairId"
        `);
        if (!finalizedRepair[0]) {
          throw new ProjectDependencyPromotionDecisionError(
            'DECISION_STATE_CONFLICT',
            'The exact dependency repair receipt could not finalize with Project reopen',
          );
        }
      }
      const reopened = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "ProjectIdentity"
        SET "lifecycleStatus" = 'ACTIVE',
            "dependencyQuarantinedAt" = NULL,
            "updatedAt" = clock_timestamp()
        WHERE "id" = ${lockedDecision.projectIdentityId}
          AND "workspaceOwnerId" = ${lockedDecision.workspaceOwnerId}
          AND "projectName" = ${lockedDecision.projectName}
          AND "canonicalRoot" = ${lockedDecision.destinationCanonicalRoot}
          AND "rootDevice" = ${lockedDecision.destinationRootDevice}
          AND "rootInode" = ${lockedDecision.destinationRootInode}
          AND "rootBirthtimeNs" = ${lockedDecision.destinationRootBirthtimeNs}
          AND "generation" = ${lockedDecision.projectIdentityGeneration}
          AND "lifecycleStatus" = 'DEPENDENCY_PROMOTING'
        RETURNING "id"
      `);
      if (!reopened[0]) {
        throw new ProjectDependencyPromotionDecisionError(
          'PROJECT_IDENTITY_CHANGED',
          'The exact Project identity could not reopen after dependency promotion cleanup',
        );
      }
      return deleted;
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 10_000,
    });
  } finally {
    // Both the Project-root and exact owner-directory descriptors stay open
    // from the fd-relative absence proof through the database DELETE.
    evidenceProof.close();
  }
  if (rows[0]) return true;
  const afterDelete = await resolveProjectDependencyPromotionDecision({
    operationId: requestedOperationId,
    manifestDigest: requestedDigest,
    database,
  });
  if (!afterDelete) return false; // Idempotent lost-response or repeated cleanup.
  throw new ProjectDependencyPromotionDecisionError(
    'DECISION_STATE_CONFLICT',
    'An authorized promotion receipt cannot be deleted before it is applied',
  );
}

/**
 * Recovery-only bounded pruning. Each row is checked by the same central
 * same-filesystem absence proof while its branded lifecycle lease is held;
 * AUTHORIZED rows are never selected or deleted.
 */
export async function pruneAppliedProjectDependencyPromotionDecisionsWithoutEvidence(input: {
  appliedBefore: Date;
  acquireLifecycleLock(
    record: ProjectDependencyPromotionDecisionRecord,
  ): Promise<ProjectDeletionLockLease>;
  verifyAppliedGeneration(manifest: ProjectDependencyPromotionManifest): void;
  limit?: number;
  database?: ProjectDependencyPromotionDecisionDatabase;
}): Promise<{ examined: number; deleted: number }> {
  if (!(input.appliedBefore instanceof Date) || !Number.isFinite(input.appliedBefore.getTime())) {
    throw new ProjectDependencyPromotionDecisionError('INVALID_INPUT', 'Invalid applied decision cutoff');
  }
  const limit = input.limit == null ? 100 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new ProjectDependencyPromotionDecisionError('INVALID_INPUT', 'Invalid applied decision prune limit');
  }
  const database = input.database || defaultDatabase;
  const rows = await database.$queryRaw<any[]>(Prisma.sql`
    SELECT *
    FROM "ProjectDependencyPromotionDecision"
    WHERE "status" = 'APPLIED'
      AND "appliedAt" < ${input.appliedBefore}
    ORDER BY "appliedAt", "operationId"
    LIMIT ${limit}
  `);
  let deleted = 0;
  for (const row of rows) {
    const record = normalizedRecord(row);
    const lifecycleLock = await input.acquireLifecycleLock(record);
    try {
      if (await deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup({
        operationId: record.operationId,
        manifestDigest: record.manifestDigest,
        lifecycleLock,
        verifyAppliedGeneration: input.verifyAppliedGeneration,
        database,
      })) deleted += 1;
    } catch (error) {
      if (error instanceof ProjectDependencyPromotionDecisionError && error.code === 'EVIDENCE_NOT_CLEAN') {
        continue;
      }
      throw error;
    } finally {
      lifecycleLock();
    }
  }
  return { examined: rows.length, deleted };
}
