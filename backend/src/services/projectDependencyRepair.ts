import crypto from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import type { JwtPayload } from '../utils/jwt';
import type { ProjectDeletionLockLease } from './projectDeletionLock';
import {
  acquireProjectDeletionLockWithoutGuard,
  assertHeldProjectDeletionLockLease,
  projectDeletionLockKey,
} from './projectDeletionLock';
import {
  attestProjectDependencyForceForwardMovePlanBeforeGoBit,
  attestProjectDependencyRepairCleanupBeforeGoBit,
  buildProjectDependencyForceForwardMovePlan,
  cleanupProjectDependencyRepairDisplacement,
  cleanupForceForwardedProjectDependencyPromotion,
  forceForwardQuarantinedProjectDependencyPromotion,
  projectDependencyRepairCleanupPlanDigest,
  verifyProjectDependencyPromotionManifestAllNew,
  type ProjectDependencyRepairCheckpoint,
  type ProjectDependencyRepairMovePlan,
  type ProjectDependencyPromotionStartupTarget,
} from './project-lifecycle.service';
import {
  deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup,
  findProjectDependencyPromotionDecisionByDestination,
  markProjectDependencyPromotionApplied,
  resolveProjectDependencyPromotionDecision,
  type ProjectDependencyPromotionDecisionDatabase,
  type ProjectDependencyPromotionDecisionRecord,
} from './projectDependencyPromotionDecision';
import { resolveProjectStoragePaths } from './projectStoragePaths';
import {
  acquireBackupMutationLock,
  assertBackupMutationLockLease,
  expectedBackupOwnerIdentity,
  getConfiguredBackupRoot,
  listBackupFiles,
  readRepairOwnedBackupLockMarker,
  removeExactRepairOwnedBackupLockMarker,
  type BackupMutationLockLease,
} from './backup.service';

export const PROJECT_DEPENDENCY_REPAIR_ACTION = 'FORCE_FORWARD_STAGED' as const;
export const PROJECT_DEPENDENCY_REPAIR_PHASES = Object.freeze([
  'GO_BIT', 'ALL_NEW', 'APPLIED', 'EVIDENCE_CLEAN', 'COMPLETE',
] as const);
export type ProjectDependencyRepairPhase = typeof PROJECT_DEPENDENCY_REPAIR_PHASES[number];
export type ProjectDependencyRepairStatus = 'PROMOTING' | 'APPLIED';

export interface ProjectDependencyRepairBackupFingerprint {
  path: string;
  filename: string;
  device: string;
  inode: string;
  size: string;
  mtimeNs: string;
  receiptDigest: string;
  fingerprintDigest: string;
}

export interface ProjectDependencyRepairBackupLock {
  markerCanonicalPath: string;
  markerDigest: string;
  owned: boolean;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  workspaceOwnerId: string;
  projectName: string;
  promotionOperationId: string;
  manifestDigest: string;
}

export interface ProjectDependencyRepairRecord {
  repairId: string;
  action: typeof PROJECT_DEPENDENCY_REPAIR_ACTION;
  promotionOperationId: string;
  manifestDigest: string;
  actorUserId: string;
  sessionId: string;
  authorizationVersion: number;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  workspaceOwnerId: string;
  projectName: string;
  quarantinedAt: Date;
  repairJournalCanonicalPath: string;
  displacementCanonicalRoot: string;
  repairBindingDigest: string;
  backup: ProjectDependencyRepairBackupFingerprint;
  backupLock: NonNullable<RepairJournal['backupLock']>;
  movePlanDigest: string;
  cleanupPlanDigest: string | null;
  status: ProjectDependencyRepairStatus;
  phase: ProjectDependencyRepairPhase;
  startedAt: Date;
  allNewAt: Date | null;
  appliedAt: Date | null;
  evidenceCleanedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ProjectDependencyRepairErrorCode =
  | 'INVALID_INPUT'
  | 'AUTHORIZATION_CHANGED'
  | 'PROJECT_DEPENDENCY_REPAIR_STALE'
  | 'PROJECT_DEPENDENCY_REPAIR_BUSY'
  | 'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED'
  | 'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE'
  | 'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT';

export class ProjectDependencyRepairError extends Error {
  constructor(
    public readonly code: ProjectDependencyRepairErrorCode,
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'ProjectDependencyRepairError';
  }
}

interface SqlClient {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

export type ProjectDependencyRepairDatabase = ProjectDependencyPromotionDecisionDatabase;

export interface ProjectDependencyRepairJournal {
  schemaVersion: 1;
  repairId: string;
  action: typeof PROJECT_DEPENDENCY_REPAIR_ACTION;
  promotionOperationId: string;
  manifestDigest: string;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  workspaceOwnerId: string;
  projectName: string;
  quarantinedAt: string;
  repairBindingDigest: string;
  repairJournalCanonicalPath: string;
  displacementCanonicalRoot: string;
  displacementIdentity: {
    device: string;
    inode: string;
    birthtimeNs: string;
  };
  backup: ProjectDependencyRepairBackupFingerprint;
  backupLock: ProjectDependencyRepairBackupLock | null;
  movePlan: ProjectDependencyRepairMovePlan;
  phase: 'PREPARED' | ProjectDependencyRepairPhase;
  createdAt: string;
  updatedAt: string;
}

type RepairJournal = ProjectDependencyRepairJournal;

export interface ProjectDependencyRepairStartupOperation {
  repairId: string;
  promotionOperationId: string;
  manifestDigest: string;
  status: ProjectDependencyRepairStatus;
  phase: ProjectDependencyRepairPhase;
  journalPhase: 'PREPARED' | ProjectDependencyRepairPhase;
  repairBindingDigest: string;
  journalSha256: string;
  displacementTopologySha256: string;
  temporaryEvidenceSha256: string[];
  temporaryEvidencePaths: string[];
  backupFingerprintDigest: string;
  target: ProjectDependencyPromotionStartupTarget;
}

export interface ProjectDependencyRepairStartupUnboundEvidence {
  repairId: string | null;
  workspaceOwnerId: string;
  kind: 'journal' | 'displacement' | 'journal_temporary' | 'unknown';
  canonicalPath: string;
  contentSha256: string;
  safeCleanupCandidate: boolean;
}

export interface ProjectDependencyRepairStartupInspection {
  schemaVersion: 1;
  snapshotSha256: string;
  hasEvidence: boolean;
  operationIds: string[];
  operations: ProjectDependencyRepairStartupOperation[];
  targets: ProjectDependencyPromotionStartupTarget[];
  unboundEvidence: ProjectDependencyRepairStartupUnboundEvidence[];
}

const defaultDatabase = prisma as unknown as ProjectDependencyRepairDatabase;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_JOURNAL_BYTES = 64 * 1024;
const REPAIR_BASENAME = /^\.bridgesllm-project-repair-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const REPAIR_JOURNAL_BASENAME = /^\.bridgesllm-project-repair-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.journal\.json$/;
const REPAIR_TEMP_BASENAME = /^\.bridgesllm-project-repair-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.journal\.json\.([1-9][0-9]{0,9})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;

function requiredString(value: unknown, label: string, max = 4096): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ProjectDependencyRepairError('INVALID_INPUT', `Invalid ${label}`, 400);
  }
  return normalized;
}

function uuid(value: unknown, label: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_V4.test(normalized)) {
    throw new ProjectDependencyRepairError('INVALID_INPUT', `Invalid ${label}`, 400);
  }
  return normalized;
}

function digest(value: unknown, label: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SHA256.test(normalized)) {
    throw new ProjectDependencyRepairError('INVALID_INPUT', `Invalid ${label}`, 400);
  }
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ProjectDependencyRepairError('INVALID_INPUT', `Invalid ${label}`, 400);
  }
  return parsed;
}

function durableSessionId(actor: JwtPayload): string {
  if (!actor.sessionId) {
    throw new ProjectDependencyRepairError(
      'AUTHORIZATION_CHANGED',
      'A live durable Owner session is required for dependency repair.',
      401,
    );
  }
  return requiredString(actor.sessionId, 'durable Session ID', 255);
}

function stableFingerprint(input: Omit<ProjectDependencyRepairBackupFingerprint, 'fingerprintDigest'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
}

function backupRepairMarkerPayload(input: {
  repairId: string;
  backup: ProjectDependencyRepairBackupFingerprint;
  lock: Omit<ProjectDependencyRepairBackupLock, 'markerCanonicalPath' | 'markerDigest' | 'owned'>;
}): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    kind: 'bridgesllm.project-dependency-repair-backup-pin',
    repairId: input.repairId,
    backupFingerprintDigest: input.backup.fingerprintDigest,
    ...input.lock,
  })}\n`;
}

function fsyncParent(directory: string): void {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
  );
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

export function createOrAttestProjectDependencyRepairBackupLock(input: {
  repairId: string;
  backup: ProjectDependencyRepairBackupFingerprint;
  binding: Omit<ProjectDependencyRepairBackupLock, 'markerCanonicalPath' | 'markerDigest' | 'owned'>;
  lease: BackupMutationLockLease;
}): NonNullable<RepairJournal['backupLock']> {
  assertBackupMutationLockLease(input.lease);
  const repairId = uuid(input.repairId, 'repair ID');
  const backup = normalizeProjectDependencyRepairBackup(input.backup);
  if (!attestProjectDependencyRepairBackupFingerprint(backup)) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
      'The recovery backup changed before its repair pin was created.',
    );
  }
  const markerCanonicalPath = `${backup.path}.locked`;
  const binding = Object.freeze({
    projectIdentityId: requiredString(input.binding.projectIdentityId, 'Project identity ID', 255),
    projectIdentityGeneration: positiveInteger(
      input.binding.projectIdentityGeneration,
      'Project identity generation',
    ),
    workspaceOwnerId: requiredString(input.binding.workspaceOwnerId, 'workspace owner ID', 255),
    projectName: requiredString(input.binding.projectName, 'Project name', 255),
    promotionOperationId: uuid(input.binding.promotionOperationId, 'promotion operation ID'),
    manifestDigest: digest(input.binding.manifestDigest, 'manifest digest'),
  });
  const payload = backupRepairMarkerPayload({ repairId, backup, lock: binding });
  let markerDigest = crypto.createHash('sha256').update(payload).digest('hex');
  const expectedOwner = expectedBackupOwnerIdentity();
  let owned = false;
  try {
    const descriptor = fs.openSync(
      markerCanonicalPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, payload, 'utf8');
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fsyncParent(path.dirname(markerCanonicalPath));
    owned = true;
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(markerCanonicalPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
      || stat.uid !== BigInt(expectedOwner.uid) || stat.gid !== BigInt(expectedOwner.gid)
      || (stat.mode & 0o777n) !== 0o600n || stat.size <= 0n || stat.size > 16_384n) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
        'The recovery backup lock marker has unsafe filesystem shape.',
      );
    }
    const existing = fs.readFileSync(markerCanonicalPath);
    const after = fs.lstatSync(markerCanonicalPath, { bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
      || after.mtimeNs !== stat.mtimeNs || after.nlink !== 1n) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
        'The recovery backup lock marker changed while it was being adopted.',
      );
    }
    const repairPayloadDigest = markerDigest;
    markerDigest = crypto.createHash('sha256').update(existing).digest('hex');
    owned = markerDigest === repairPayloadDigest;
  }
  const lock = Object.freeze({ markerCanonicalPath, markerDigest, owned, ...binding });
  if (!attestProjectDependencyRepairBackupLock({ repairId, backup, lock })) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
      'The recovery backup pin could not be durably attested.',
    );
  }
  return lock;
}

export function attestProjectDependencyRepairBackupLock(input: {
  repairId: string;
  backup: ProjectDependencyRepairBackupFingerprint;
  lock: NonNullable<RepairJournal['backupLock']>;
}): boolean {
  try {
    const expectedOwner = expectedBackupOwnerIdentity();
    if (input.lock.markerCanonicalPath !== `${input.backup.path}.locked`
      || !SHA256.test(input.lock.markerDigest)) return false;
    const stat = fs.lstatSync(input.lock.markerCanonicalPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
      || stat.uid !== BigInt(expectedOwner.uid) || stat.gid !== BigInt(expectedOwner.gid)
      || (stat.mode & 0o777n) !== 0o600n || stat.size <= 0n || stat.size > 16_384n) return false;
    const bytes = fs.readFileSync(input.lock.markerCanonicalPath);
    const after = fs.lstatSync(input.lock.markerCanonicalPath, { bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
      || after.mtimeNs !== stat.mtimeNs || after.nlink !== 1n) return false;
    const actualDigest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (input.lock.owned) {
      return actualDigest === input.lock.markerDigest
        && bytes.equals(Buffer.from(backupRepairMarkerPayload({
          repairId: uuid(input.repairId, 'repair ID'),
          backup: normalizeProjectDependencyRepairBackup(input.backup),
          lock: {
            projectIdentityId: requiredString(input.lock.projectIdentityId, 'Project identity ID', 255),
            projectIdentityGeneration: positiveInteger(
              input.lock.projectIdentityGeneration,
              'Project identity generation',
            ),
            workspaceOwnerId: requiredString(input.lock.workspaceOwnerId, 'workspace owner ID', 255),
            projectName: requiredString(input.lock.projectName, 'Project name', 255),
            promotionOperationId: uuid(input.lock.promotionOperationId, 'promotion operation ID'),
            manifestDigest: digest(input.lock.manifestDigest, 'manifest digest'),
          },
        }), 'utf8'));
    }
    return actualDigest === input.lock.markerDigest;
  } catch { return false; }
}

export function releaseProjectDependencyRepairBackupLock(input: {
  record: ProjectDependencyRepairRecord;
  lease: BackupMutationLockLease;
}): void {
  releaseProjectDependencyRepairBackupLockSnapshot({
    repairId: input.record.repairId,
    backup: input.record.backup,
    backupLock: input.record.backupLock,
    lease: input.lease,
  });
}

export function releaseProjectDependencyRepairBackupLockSnapshot(input: {
  repairId: string;
  backup: ProjectDependencyRepairBackupFingerprint;
  backupLock: NonNullable<RepairJournal['backupLock']>;
  lease: BackupMutationLockLease;
}): void {
  assertBackupMutationLockLease(input.lease);
  if (!input.backupLock.owned) return;
  try {
    fs.lstatSync(input.backupLock.markerCanonicalPath);
  } catch (error: any) {
    // Marker retirement is deliberately idempotent. Backup mutation routes
    // cannot remove a repair-owned marker, so absence means an earlier exact
    // repair cleanup already converged this pin.
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!attestProjectDependencyRepairBackupLock({
    repairId: input.repairId,
    backup: input.backup,
    lock: input.backupLock,
  })) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'The repair-owned backup pin changed before release.',
      503,
    );
  }
  assertBackupMutationLockLease(input.lease);
  fs.unlinkSync(input.backupLock.markerCanonicalPath);
  fsyncParent(path.dirname(input.backupLock.markerCanonicalPath));
}

export function normalizeProjectDependencyRepairBackup(
  input: ProjectDependencyRepairBackupFingerprint,
): ProjectDependencyRepairBackupFingerprint {
  const normalized = {
    path: path.resolve(requiredString(input.path, 'backup path')),
    filename: requiredString(input.filename, 'backup filename', 255),
    device: requiredString(input.device, 'backup device', 128),
    inode: requiredString(input.inode, 'backup inode', 128),
    size: requiredString(input.size, 'backup size', 32),
    mtimeNs: requiredString(input.mtimeNs, 'backup modification time', 32),
    receiptDigest: digest(input.receiptDigest, 'backup receipt digest'),
  };
  if (!/^\d+$/.test(normalized.device)
    || !/^\d+$/.test(normalized.inode)
    || !/^\d+$/.test(normalized.size)
    || BigInt(normalized.size) <= 0n
    || !/^\d+$/.test(normalized.mtimeNs)
    || path.basename(normalized.path) !== normalized.filename) {
    throw new ProjectDependencyRepairError('INVALID_INPUT', 'Invalid backup fingerprint', 400);
  }
  const fingerprintDigest = stableFingerprint(normalized);
  if (digest(input.fingerprintDigest, 'backup fingerprint digest') !== fingerprintDigest) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
      'The verified backup fingerprint changed before repair admission.',
    );
  }
  return Object.freeze({ ...normalized, fingerprintDigest });
}

export function attestProjectDependencyRepairBackupFingerprint(
  expected: ProjectDependencyRepairBackupFingerprint,
): boolean {
  try {
    const normalized = normalizeProjectDependencyRepairBackup(expected);
    const stat = fs.lstatSync(normalized.path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()
      || stat.uid !== BigInt(typeof process.getuid === 'function' ? process.getuid() : 0)
      || stat.gid !== BigInt(typeof process.getgid === 'function' ? process.getgid() : 0)
      || stat.nlink !== 1n
      || (stat.mode & 0o022n) !== 0n
      || stat.dev.toString() !== normalized.device
      || stat.ino.toString() !== normalized.inode
      || stat.size.toString() !== normalized.size
      || stat.mtimeNs.toString() !== normalized.mtimeNs) return false;
    const receiptPath = `${normalized.path}.receipt.json`;
    const before = fs.lstatSync(receiptPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()
      || before.uid !== BigInt(typeof process.getuid === 'function' ? process.getuid() : 0)
      || before.gid !== BigInt(typeof process.getgid === 'function' ? process.getgid() : 0)
      || before.nlink !== 1n
      || (before.mode & 0o777n) !== 0o600n
      || before.size <= 0n || before.size > 16_384n) return false;
    const receipt = fs.readFileSync(receiptPath);
    const after = fs.lstatSync(receiptPath, { bigint: true });
    return before.dev === after.dev
      && before.ino === after.ino
      && before.size === after.size
      && before.mtimeNs === after.mtimeNs
      && after.uid === before.uid
      && after.gid === before.gid
      && after.nlink === 1n
      && (after.mode & 0o777n) === 0o600n
      && crypto.createHash('sha256').update(receipt).digest('hex') === normalized.receiptDigest;
  } catch {
    return false;
  }
}

/** Strict restore verifier used before startup resumes a repair-owned go-bit. */
export async function verifyProjectDependencyRepairBackupArchive(
  record: Pick<ProjectDependencyRepairRecord, 'backup'>,
  dependencies: {
    restoreScriptPath?: string;
    timeoutMs?: number;
    execFileImpl?: typeof execFile;
  } = {},
): Promise<boolean> {
  if (!attestProjectDependencyRepairBackupFingerprint(record.backup)) return false;
  const restoreScript = dependencies.restoreScriptPath
    || process.env.RESTORE_SCRIPT_PATH
    || path.join(process.env.PORTAL_ROOT || '/opt/bridgesllm/portal', 'restore-full.sh');
  const timeoutMs = Number.isFinite(dependencies.timeoutMs)
    ? Math.max(1, Math.min(15 * 60_000, Math.trunc(dependencies.timeoutMs!)))
    : 15 * 60_000;
  return new Promise((resolve) => {
    (dependencies.execFileImpl || execFile)(
      '/bin/bash',
      [restoreScript, '--verify-archive', record.backup.path],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error) => resolve(!error && attestProjectDependencyRepairBackupFingerprint(record.backup)),
    );
  });
}

function repairPaths(
  decision: ProjectDependencyPromotionDecisionRecord,
  repairId: string,
): { journal: string; displacement: string } {
  const ownerRoot = decision.operationParentCanonicalRoot;
  const basename = `.bridgesllm-project-repair-${repairId}`;
  return {
    journal: path.join(ownerRoot, `${basename}.journal.json`),
    displacement: path.join(ownerRoot, basename),
  };
}

function repairBinding(input: {
  repairId: string;
  decision: ProjectDependencyPromotionDecisionRecord;
  quarantinedAt: Date;
  journalPath: string;
  displacementRoot: string;
  backup: ProjectDependencyRepairBackupFingerprint;
  backupLock: NonNullable<RepairJournal['backupLock']>;
  movePlan: ProjectDependencyRepairMovePlan;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    repairId: input.repairId,
    action: PROJECT_DEPENDENCY_REPAIR_ACTION,
    promotionOperationId: input.decision.operationId,
    manifestDigest: input.decision.manifestDigest,
    projectIdentityId: input.decision.projectIdentityId,
    projectIdentityGeneration: input.decision.projectIdentityGeneration,
    workspaceOwnerId: input.decision.workspaceOwnerId,
    projectName: input.decision.projectName,
    quarantinedAt: input.quarantinedAt.toISOString(),
    repairJournalCanonicalPath: input.journalPath,
    displacementCanonicalRoot: input.displacementRoot,
    backup: input.backup,
    backupLock: input.backupLock,
    movePlanDigest: input.movePlan.planDigest,
  };
}

function repairBindingDigest(binding: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(binding), 'utf8').digest('hex');
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function writeRepairJournal(file: string, journal: RepairJournal, createOnly = false): void {
  const updated: RepairJournal = { ...journal, updatedAt: new Date().toISOString() };
  const serialized = `${JSON.stringify(updated)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JOURNAL_BYTES) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'Dependency repair journal exceeds its durable bound.',
      503,
    );
  }
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, serialized, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    if (createOnly) {
      try {
        // link(2) provides the missing no-replace primitive: exactly one
        // contender can publish this inode at the durable journal path.
        fs.linkSync(temporary, file);
        fs.unlinkSync(temporary);
      } catch (error: any) {
        if (error?.code === 'EEXIST') {
          throw new ProjectDependencyRepairError(
            'PROJECT_DEPENDENCY_REPAIR_BUSY',
            'A repair journal already owns this request identity.',
          );
        }
        throw error;
      }
    } else {
      fs.renameSync(temporary, file);
    }
    fsyncDirectory(path.dirname(file));
    Object.assign(journal, updated);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function readRepairJournal(file: string): RepairJournal {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0),
    );
  } catch {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'The durable dependency repair journal is unavailable.',
      503,
    );
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
      || stat.size <= 0 || stat.size > MAX_JOURNAL_BYTES) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
        'The durable dependency repair journal is unsafe.',
        503,
      );
    }
    const buffer = Buffer.alloc(stat.size);
    if (fs.readSync(descriptor, buffer, 0, buffer.length, 0) !== buffer.length) {
      throw new Error('short read');
    }
    return JSON.parse(buffer.toString('utf8')) as RepairJournal;
  } catch (error) {
    if (error instanceof ProjectDependencyRepairError) throw error;
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'The durable dependency repair journal is malformed.',
      503,
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

function readRepairJournalAllowPublishedHardlinkPair(file: string): RepairJournal {
  try {
    return readRepairJournal(file);
  } catch (error) {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 2n
      || Number(stat.mode & 0o777n) !== 0o600
      || stat.size <= 0n || stat.size > BigInt(MAX_JOURNAL_BYTES)) throw error;
    const ownerRoot = path.dirname(file);
    const base = path.basename(file);
    const match = base.match(REPAIR_JOURNAL_BASENAME);
    if (!match) throw error;
    const twins = fs.readdirSync(ownerRoot)
      .filter((name) => name.match(REPAIR_TEMP_BASENAME)?.[1] === match[1])
      .map((name) => path.join(ownerRoot, name))
      .filter((candidate) => {
        const candidateStat = fs.lstatSync(candidate, { bigint: true });
        return candidateStat.isFile() && !candidateStat.isSymbolicLink()
          && candidateStat.dev === stat.dev && candidateStat.ino === stat.ino
          && candidateStat.nlink === 2n
          && candidateStat.uid === stat.uid && candidateStat.gid === stat.gid
          && candidateStat.mode === stat.mode && candidateStat.size === stat.size;
      });
    if (twins.length !== 1) throw error;
    const descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0),
    );
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!sameRepairStat(stat, opened)) throw error;
      const buffer = Buffer.alloc(Number(stat.size));
      if (fs.readSync(descriptor, buffer, 0, buffer.length, 0) !== buffer.length) throw error;
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (!sameRepairStat(opened, after)) throw error;
      return JSON.parse(buffer.toString('utf8')) as RepairJournal;
    } finally {
      fs.closeSync(descriptor);
    }
  }
}

function stableRepairStat(stat: fs.BigIntStats): Record<string, string | boolean> {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: stat.mode.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    size: stat.size.toString(),
    nlink: stat.nlink.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    directory: stat.isDirectory(),
    file: stat.isFile(),
    symlink: stat.isSymbolicLink(),
  };
}

function sameRepairStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return JSON.stringify(stableRepairStat(left)) === JSON.stringify(stableRepairStat(right));
}

function repairEvidenceMountBoundaries(root: string): string[] {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    const fields = line.split(' ');
    if (fields.length < 6) throw new Error('malformed mount inventory');
    const mountPoint = path.resolve(fields[4].replace(
      /\\([0-7]{3})/g,
      (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)),
    ));
    return mountPoint === root || mountPoint.startsWith(prefix) ? [mountPoint] : [];
  }).sort();
}

/** Stable, no-follow recursive inode/content digest for startup comparison. */
function repairEvidenceTreeDigest(candidate: string): string {
  const root = path.resolve(candidate);
  if (root !== candidate) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'Dependency repair evidence path is not canonical.',
      503,
    );
  }
  const rootStat = fs.lstatSync(root, { bigint: true });
  const mountBoundariesBefore = repairEvidenceMountBoundaries(root);
  if (mountBoundariesBefore.length > 0) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'Dependency repair evidence crosses a mount or bind-mount boundary.',
      503,
    );
  }
  const hash = crypto.createHash('sha256');
  const visit = (entryPath: string, relative: string): void => {
    const before = fs.lstatSync(entryPath, { bigint: true });
    if (before.dev !== rootStat.dev) throw new Error('repair evidence crossed a filesystem boundary');
    hash.update(JSON.stringify([relative, stableRepairStat(before)]));
    hash.update('\0');
    if (before.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(entryPath);
      const after = fs.lstatSync(entryPath, { bigint: true });
      if (!after.isSymbolicLink() || !sameRepairStat(before, after)) {
        throw new Error('repair symlink changed');
      }
      hash.update(linkTarget);
      hash.update('\0');
      return;
    }
    if (!before.isDirectory() && !before.isFile()) {
      throw new Error('unsupported repair evidence entry');
    }
    const descriptor = fs.openSync(
      entryPath,
      fs.constants.O_RDONLY
        | (before.isDirectory() ? (fs.constants.O_DIRECTORY || 0) : 0)
        | (fs.constants.O_NOFOLLOW || 0)
        | (fs.constants.O_NONBLOCK || 0),
    );
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!sameRepairStat(before, opened)) throw new Error('repair evidence changed');
      if (opened.isDirectory()) {
        const descriptorPath = `/proc/self/fd/${descriptor}`;
        const names = fs.readdirSync(descriptorPath).sort();
        for (const name of names) {
          if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
            throw new Error('unsafe repair evidence name');
          }
          visit(path.join(descriptorPath, name), relative ? `${relative}/${name}` : name);
        }
        const namesAfter = fs.readdirSync(descriptorPath).sort();
        if (JSON.stringify(namesAfter) !== JSON.stringify(names)) {
          throw new Error('repair evidence directory changed');
        }
      } else {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        for (;;) {
          const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, position);
          if (bytes === 0) break;
          hash.update(buffer.subarray(0, bytes));
          position += bytes;
        }
      }
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (!sameRepairStat(opened, after)) throw new Error('repair evidence changed');
    } finally {
      fs.closeSync(descriptor);
    }
  };
  try {
    visit(root, '');
    if (JSON.stringify(repairEvidenceMountBoundaries(root)) !== JSON.stringify(mountBoundariesBefore)) {
      throw new Error('repair evidence mount topology changed');
    }
    return hash.digest('hex');
  } catch (error) {
    if (error instanceof ProjectDependencyRepairError) throw error;
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'Dependency repair evidence changed during startup inspection.',
      503,
    );
  }
}

interface RepairNamespaceEvidence {
  workspaceOwnerId: string;
  repairId: string | null;
  kind: ProjectDependencyRepairStartupUnboundEvidence['kind'];
  canonicalPath: string;
  contentSha256: string;
  safeShape: boolean;
  device: string | null;
  inode: string | null;
  nlink: string | null;
  uid: string | null;
  gid: string | null;
  mode: string | null;
  size: string | null;
}

function inspectRepairNamespace(projectsRootInput?: string): RepairNamespaceEvidence[] {
  const projectsRoot = path.resolve(
    projectsRootInput || resolveProjectStoragePaths().projectsDir,
  );
  if (!fs.existsSync(projectsRoot)
    || fs.realpathSync.native(projectsRoot) !== projectsRoot
    || !fs.lstatSync(projectsRoot).isDirectory()) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'Project storage root cannot be attested for dependency repair inventory.',
      503,
    );
  }
  const evidence: RepairNamespaceEvidence[] = [];
  for (const workspaceOwnerId of fs.readdirSync(projectsRoot).sort()) {
    const ownerRoot = path.join(projectsRoot, workspaceOwnerId);
    const ownerStat = fs.lstatSync(ownerRoot);
    if (ownerStat.isSymbolicLink() || !ownerStat.isDirectory()) continue;
    for (const name of fs.readdirSync(ownerRoot).sort()) {
      if (!name.startsWith('.bridgesllm-project-repair-')) continue;
      const directoryMatch = name.match(REPAIR_BASENAME);
      const journalMatch = name.match(REPAIR_JOURNAL_BASENAME);
      const temporaryMatch = name.match(REPAIR_TEMP_BASENAME);
      const match = directoryMatch || journalMatch || temporaryMatch;
      const kind: ProjectDependencyRepairStartupUnboundEvidence['kind'] = directoryMatch
        ? 'displacement'
        : journalMatch
          ? 'journal'
          : temporaryMatch
            ? 'journal_temporary'
            : 'unknown';
      const canonicalPath = path.join(ownerRoot, name);
      let contentSha256: string;
      let safeShape = false;
      let device: string | null = null;
      let inode: string | null = null;
      let nlink: string | null = null;
      let uid: string | null = null;
      let gid: string | null = null;
      let mode: string | null = null;
      let size: string | null = null;
      try {
        const stat = fs.lstatSync(canonicalPath, { bigint: true });
        device = stat.dev.toString();
        inode = stat.ino.toString();
        nlink = stat.nlink.toString();
        uid = stat.uid.toString();
        gid = stat.gid.toString();
        mode = stat.mode.toString();
        size = stat.size.toString();
        contentSha256 = repairEvidenceTreeDigest(canonicalPath);
        safeShape = kind === 'displacement'
          ? stat.isDirectory() && !stat.isSymbolicLink() && Number(stat.mode & 0o777n) === 0o700
          : (kind === 'journal' || kind === 'journal_temporary')
            ? stat.isFile() && !stat.isSymbolicLink() && (stat.nlink === 1n || stat.nlink === 2n)
              && Number(stat.mode & 0o777n) === 0o600
              && stat.size > 0n && stat.size <= BigInt(MAX_JOURNAL_BYTES)
            : false;
      } catch {
        contentSha256 = crypto.createHash('sha256')
          .update(JSON.stringify([canonicalPath, 'unattested']))
          .digest('hex');
      }
      evidence.push({
        workspaceOwnerId,
        repairId: match ? match[1] : null,
        kind,
        canonicalPath,
        contentSha256,
        safeShape,
        device,
        inode,
        nlink,
        uid,
        gid,
        mode,
        size,
      });
    }
  }
  return evidence;
}

function isExactPublishedJournalHardlinkPair(
  journal: RepairNamespaceEvidence | null,
  temporaries: RepairNamespaceEvidence[],
): boolean {
  if (!journal || !journal.safeShape || journal.nlink !== '2' || temporaries.length !== 1) {
    return false;
  }
  const temporary = temporaries[0];
  return temporary.safeShape
    && temporary.nlink === '2'
    && temporary.device === journal.device
    && temporary.inode === journal.inode
    && temporary.uid === journal.uid
    && temporary.gid === journal.gid
    && temporary.mode === journal.mode
    && temporary.size === journal.size;
}

function normalizedRecord(row: any): ProjectDependencyRepairRecord {
  const backup = normalizeProjectDependencyRepairBackup({
    path: String(row.backupPath),
    filename: String(row.backupFilename),
    device: String(row.backupDevice),
    inode: String(row.backupInode),
    size: String(row.backupSize),
    mtimeNs: String(row.backupMtimeNs),
    receiptDigest: String(row.backupReceiptDigest),
    fingerprintDigest: String(row.backupFingerprintDigest),
  });
  return Object.freeze({
    repairId: String(row.repairId).toLowerCase(),
    action: String(row.action) as typeof PROJECT_DEPENDENCY_REPAIR_ACTION,
    promotionOperationId: String(row.promotionOperationId).toLowerCase(),
    manifestDigest: String(row.manifestDigest),
    actorUserId: String(row.actorUserId),
    sessionId: String(row.sessionId),
    authorizationVersion: Number(row.authorizationVersion),
    projectIdentityId: String(row.projectIdentityId),
    projectIdentityGeneration: Number(row.projectIdentityGeneration),
    workspaceOwnerId: String(row.workspaceOwnerId),
    projectName: String(row.projectName),
    quarantinedAt: new Date(row.quarantinedAt),
    repairJournalCanonicalPath: String(row.repairJournalCanonicalPath),
    displacementCanonicalRoot: String(row.displacementCanonicalRoot),
    repairBindingDigest: String(row.repairBindingDigest),
    backup,
    backupLock: Object.freeze({
      markerCanonicalPath: String(row.backupLockMarkerPath),
      markerDigest: String(row.backupLockMarkerDigest),
      owned: Boolean(row.backupLockOwned),
      projectIdentityId: String(row.projectIdentityId),
      projectIdentityGeneration: Number(row.projectIdentityGeneration),
      workspaceOwnerId: String(row.workspaceOwnerId),
      projectName: String(row.projectName),
      promotionOperationId: String(row.promotionOperationId),
      manifestDigest: String(row.manifestDigest),
    }),
    movePlanDigest: String(row.movePlanDigest),
    cleanupPlanDigest: row.cleanupPlanDigest ? String(row.cleanupPlanDigest) : null,
    status: String(row.status) as ProjectDependencyRepairStatus,
    phase: String(row.phase) as ProjectDependencyRepairPhase,
    startedAt: new Date(row.startedAt),
    allNewAt: row.allNewAt ? new Date(row.allNewAt) : null,
    appliedAt: row.appliedAt ? new Date(row.appliedAt) : null,
    evidenceCleanedAt: row.evidenceCleanedAt ? new Date(row.evidenceCleanedAt) : null,
    completedAt: row.completedAt ? new Date(row.completedAt) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  });
}

async function queryRepair(
  database: SqlClient,
  repairId: string,
): Promise<ProjectDependencyRepairRecord | null> {
  const rows = await database.$queryRaw<any[]>(Prisma.sql`
    SELECT * FROM "ProjectDependencyRepairOperation"
    WHERE "repairId" = ${repairId}::uuid
  `);
  return rows[0] ? normalizedRecord(rows[0]) : null;
}

export async function findProjectDependencyRepairByProject(input: {
  workspaceOwnerId: string;
  projectName: string;
  database?: ProjectDependencyRepairDatabase;
}): Promise<ProjectDependencyRepairRecord | null> {
  const rows = await (input.database || defaultDatabase).$queryRaw<any[]>(Prisma.sql`
    SELECT * FROM "ProjectDependencyRepairOperation"
    WHERE "workspaceOwnerId" = ${requiredString(input.workspaceOwnerId, 'workspace owner ID', 255)}
      AND "projectName" = ${requiredString(input.projectName, 'Project name', 255)}
    ORDER BY "createdAt" DESC, "repairId" DESC
    LIMIT 1
  `);
  return rows[0] ? normalizedRecord(rows[0]) : null;
}

export async function resolveProjectDependencyRepair(input: {
  repairId: string;
  database?: ProjectDependencyRepairDatabase;
}): Promise<ProjectDependencyRepairRecord | null> {
  return queryRepair(input.database || defaultDatabase, uuid(input.repairId, 'repair ID'));
}

async function listProjectDependencyRepairs(input: {
  includeComplete?: boolean;
  database?: ProjectDependencyRepairDatabase;
} = {}): Promise<ProjectDependencyRepairRecord[]> {
  const rows = await (input.database || defaultDatabase).$queryRaw<any[]>(Prisma.sql`
    SELECT * FROM "ProjectDependencyRepairOperation"
    WHERE (${Boolean(input.includeComplete)} OR "status" <> 'APPLIED' OR "phase" <> 'COMPLETE')
    ORDER BY "repairId" ASC
  `);
  return rows.map(normalizedRecord);
}

/** Bounded Owner-scoped discovery used to reattach the UI after a reload. */
export async function listActiveProjectDependencyRepairsForOwner(input: {
  workspaceOwnerId: string;
  limit?: number;
  database?: ProjectDependencyRepairDatabase;
}): Promise<ProjectDependencyRepairRecord[]> {
  const workspaceOwnerId = requiredString(input.workspaceOwnerId, 'workspace owner ID', 255);
  const limit = input.limit == null ? 20 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new ProjectDependencyRepairError('INVALID_INPUT', 'Invalid active repair limit', 400);
  }
  const rows = await (input.database || defaultDatabase).$queryRaw<any[]>(Prisma.sql`
    SELECT * FROM "ProjectDependencyRepairOperation"
    WHERE "workspaceOwnerId" = ${workspaceOwnerId}
      AND ("status" <> 'APPLIED' OR "phase" <> 'COMPLETE')
    ORDER BY "startedAt" ASC, "repairId" ASC
    LIMIT ${limit + 1}
  `);
  if (rows.length > limit) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE',
      'Too many active dependency repairs require startup reconciliation.',
      503,
    );
  }
  return rows.map(normalizedRecord);
}

function repairStartupTarget(
  record: ProjectDependencyRepairRecord,
  decision: ProjectDependencyPromotionDecisionRecord | null,
  lifecycle: any,
): ProjectDependencyPromotionStartupTarget {
  if (record.status === 'APPLIED' && record.phase === 'COMPLETE') {
    if (decision
      || !lifecycle
      || String(lifecycle.id) !== record.projectIdentityId
      || Number(lifecycle.generation) !== record.projectIdentityGeneration
      || String(lifecycle.workspaceOwnerId) !== record.workspaceOwnerId
      || String(lifecycle.projectName) !== record.projectName
      || String(lifecycle.lifecycleStatus) !== 'ACTIVE') {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
        'A completed repair lost its exact active Project receipt state.',
        503,
      );
    }
    return {
      projectIdentityId: record.projectIdentityId,
      projectIdentityGeneration: record.projectIdentityGeneration,
      workspaceOwnerId: record.workspaceOwnerId,
      projectName: record.projectName,
      canonicalRoot: String(lifecycle.canonicalRoot),
      rootDevice: String(lifecycle.rootDevice),
      rootInode: String(lifecycle.rootInode),
      rootBirthtimeNs: String(lifecycle.rootBirthtimeNs),
      lifecycleStatus: null,
      decisionStatus: null,
      operationIds: [record.promotionOperationId],
      sources: [{
        kind: 'lifecycle',
        operationId: record.promotionOperationId,
        state: 'COMPLETE',
        canonicalPath: record.repairJournalCanonicalPath,
        contentSha256: record.repairBindingDigest,
      }],
    };
  }
  if (!decision
    || decision.operationId !== record.promotionOperationId
    || decision.manifestDigest !== record.manifestDigest
    || decision.projectIdentityId !== record.projectIdentityId
    || decision.projectIdentityGeneration !== record.projectIdentityGeneration
    || decision.workspaceOwnerId !== record.workspaceOwnerId
    || decision.projectName !== record.projectName
    || !lifecycle
    || String(lifecycle.id) !== record.projectIdentityId
    || Number(lifecycle.generation) !== record.projectIdentityGeneration
    || String(lifecycle.workspaceOwnerId) !== record.workspaceOwnerId
    || String(lifecycle.projectName) !== record.projectName
    || String(lifecycle.canonicalRoot) !== decision.destinationCanonicalRoot
    || String(lifecycle.rootDevice) !== decision.destinationRootDevice
    || String(lifecycle.rootInode) !== decision.destinationRootInode
    || String(lifecycle.rootBirthtimeNs) !== decision.destinationRootBirthtimeNs
    || String(lifecycle.lifecycleStatus) !== 'DEPENDENCY_PROMOTING') {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'A durable repair lost its exact promotion decision or Project identity.',
      503,
    );
  }
  return {
    projectIdentityId: record.projectIdentityId,
    projectIdentityGeneration: record.projectIdentityGeneration,
    workspaceOwnerId: record.workspaceOwnerId,
    projectName: record.projectName,
    canonicalRoot: decision.destinationCanonicalRoot,
    rootDevice: decision.destinationRootDevice,
    rootInode: decision.destinationRootInode,
    rootBirthtimeNs: decision.destinationRootBirthtimeNs,
    lifecycleStatus: 'DEPENDENCY_PROMOTING',
    decisionStatus: decision.status,
    operationIds: [record.promotionOperationId],
    sources: [{
      kind: 'decision',
      operationId: record.promotionOperationId,
      state: decision.status,
      canonicalPath: record.repairJournalCanonicalPath,
      contentSha256: record.manifestDigest,
    }],
  };
}

/**
 * Read-only startup inventory for every non-complete repair. It binds the DB
 * receipt to the exact decision/lifecycle, journal bytes and the recursive
 * private displacement topology so the coordinator can detect post-drain
 * changes before executing recovery.
 */
export async function inspectProjectDependencyRepairStartupEvidence(input: {
  projectsRoot?: string;
  database?: ProjectDependencyRepairDatabase;
} = {}): Promise<ProjectDependencyRepairStartupInspection> {
  const database = input.database || defaultDatabase;
  const projectsRoot = path.resolve(input.projectsRoot || resolveProjectStoragePaths().projectsDir);
  const namespace = inspectRepairNamespace(projectsRoot);
  const records = (await listProjectDependencyRepairs({ database, includeComplete: true }))
    .filter((record) => record.status !== 'APPLIED'
      || record.phase !== 'COMPLETE'
      || fs.existsSync(record.repairJournalCanonicalPath)
      || fs.existsSync(record.displacementCanonicalRoot));
  const operations: ProjectDependencyRepairStartupOperation[] = [];
  const claimedPaths = new Set<string>();
  for (const record of records) {
    const [decision, lifecycleRows] = await Promise.all([
      resolveProjectDependencyPromotionDecision({
        operationId: record.promotionOperationId,
        manifestDigest: record.manifestDigest,
        database,
      }),
      database.$queryRaw<any[]>(Prisma.sql`
        SELECT * FROM "ProjectIdentity" WHERE "id" = ${record.projectIdentityId}
      `),
    ]);
    const target = repairStartupTarget(record, decision, lifecycleRows[0]);
    const expectedOwnerRoot = path.join(projectsRoot, record.workspaceOwnerId);
    let ownerRootAttested = false;
    try {
      const ownerStat = fs.lstatSync(expectedOwnerRoot);
      ownerRootAttested = path.dirname(expectedOwnerRoot) === projectsRoot
        && path.basename(expectedOwnerRoot) === record.workspaceOwnerId
        && ownerStat.isDirectory() && !ownerStat.isSymbolicLink()
        && fs.realpathSync.native(expectedOwnerRoot) === expectedOwnerRoot;
    } catch {}
    const expectedPaths = decision
      ? repairPaths(decision, record.repairId)
      : {
        journal: path.join(expectedOwnerRoot, `.bridgesllm-project-repair-${record.repairId}.journal.json`),
        displacement: path.join(expectedOwnerRoot, `.bridgesllm-project-repair-${record.repairId}`),
      };
    if (!ownerRootAttested
      || (decision && decision.operationParentCanonicalRoot !== expectedOwnerRoot)
      || record.repairJournalCanonicalPath !== expectedPaths.journal
      || record.displacementCanonicalRoot !== expectedPaths.displacement) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
        'A repair receipt points outside its exact private evidence namespace.',
        503,
      );
    }
    claimedPaths.add(record.repairJournalCanonicalPath);
    claimedPaths.add(record.displacementCanonicalRoot);
    const temporaries = namespace.filter((entry) => (
      entry.repairId === record.repairId && entry.kind === 'journal_temporary'
    ));
    const journalEvidence = namespace.find((entry) => (
      entry.canonicalPath === record.repairJournalCanonicalPath && entry.kind === 'journal'
    )) || null;
    if (!journalEvidence?.safeShape) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
        'The durable dependency repair journal has unsafe filesystem shape.',
        503,
      );
    }
    const publishedHardlinkPair = isExactPublishedJournalHardlinkPair(journalEvidence, temporaries);
    if (journalEvidence.nlink !== '1' && !publishedHardlinkPair) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
        'Published dependency repair hardlink evidence is not one exact crash pair.',
        503,
      );
    }
    for (const temporary of temporaries) {
      if (!temporary.safeShape || (!publishedHardlinkPair && temporary.nlink !== '1')) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
          'A repair phase temporary has unsafe filesystem shape.',
          503,
        );
      }
      if (!publishedHardlinkPair) {
        const temporaryJournal = readRepairJournal(temporary.canonicalPath);
        assertJournalForRecord(temporaryJournal, record);
      }
      claimedPaths.add(temporary.canonicalPath);
    }
    const journal = publishedHardlinkPair
      ? readRepairJournalAllowPublishedHardlinkPair(record.repairJournalCanonicalPath)
      : readRepairJournal(record.repairJournalCanonicalPath);
    assertJournalForRecord(journal, record);
    const journalSha256 = repairEvidenceTreeDigest(record.repairJournalCanonicalPath);
    const displacementTopologySha256 = fs.existsSync(record.displacementCanonicalRoot)
      ? repairEvidenceTreeDigest(record.displacementCanonicalRoot)
      : (record.status === 'APPLIED' && record.phase === 'COMPLETE')
          || (record.status === 'PROMOTING' && record.phase === 'EVIDENCE_CLEAN')
        ? crypto.createHash('sha256').update('absent').digest('hex')
        : (() => {
          throw new ProjectDependencyRepairError(
            'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
            'A live dependency repair lost its private displacement root.',
            503,
          );
        })();
    operations.push({
      repairId: record.repairId,
      promotionOperationId: record.promotionOperationId,
      manifestDigest: record.manifestDigest,
      status: record.status,
      phase: record.phase,
      journalPhase: journal.phase,
      repairBindingDigest: record.repairBindingDigest,
      journalSha256,
      displacementTopologySha256,
      temporaryEvidenceSha256: temporaries.map((entry) => entry.contentSha256).sort(),
      temporaryEvidencePaths: temporaries.map((entry) => entry.canonicalPath).sort(),
      backupFingerprintDigest: record.backup.fingerprintDigest,
      target,
    });
  }
  operations.sort((left, right) => left.repairId.localeCompare(right.repairId));
  const targets = operations.map((operation) => operation.target);
  const unboundEvidence: ProjectDependencyRepairStartupUnboundEvidence[] = namespace
    .filter((entry) => !claimedPaths.has(entry.canonicalPath))
    .map((entry) => ({
      repairId: entry.repairId,
      workspaceOwnerId: entry.workspaceOwnerId,
      kind: entry.kind,
      canonicalPath: entry.canonicalPath,
      contentSha256: entry.contentSha256,
      safeCleanupCandidate: false,
    }));

  const unboundByRepair = new Map<string, ProjectDependencyRepairStartupUnboundEvidence[]>();
  for (const evidence of unboundEvidence) {
    if (!evidence.repairId) continue;
    const bucket = unboundByRepair.get(evidence.repairId) || [];
    bucket.push(evidence);
    unboundByRepair.set(evidence.repairId, bucket);
  }
  for (const [repairId, evidence] of unboundByRepair) {
    const journalEvidence = evidence.find((entry) => entry.kind === 'journal') || null;
    const displacement = evidence.find((entry) => entry.kind === 'displacement') || null;
    const temporaries = evidence.filter((entry) => entry.kind === 'journal_temporary');
    const unknown = evidence.some((entry) => entry.kind === 'unknown');
    if (unknown || !displacement) continue;
    let displacementEmpty = false;
    try {
      const stat = fs.lstatSync(displacement.canonicalPath, { bigint: true });
      displacementEmpty = stat.isDirectory() && !stat.isSymbolicLink()
        && Number(stat.mode & 0o777n) === 0o700
        && fs.readdirSync(displacement.canonicalPath).length === 0;
    } catch {}
    if (!displacementEmpty) continue;
    if (!journalEvidence && temporaries.length === 0) {
      displacement.safeCleanupCandidate = true;
      continue;
    }
    const rawJournal = journalEvidence
      ? namespace.find((entry) => entry.canonicalPath === journalEvidence.canonicalPath) || null
      : null;
    const rawTemporaries = temporaries.map((temporary) => (
      namespace.find((entry) => entry.canonicalPath === temporary.canonicalPath)!
    ));
    const publishedHardlinkPair = isExactPublishedJournalHardlinkPair(rawJournal, rawTemporaries);
    if (rawJournal && rawJournal.nlink !== '1' && !publishedHardlinkPair) continue;
    if (!publishedHardlinkPair
      && rawTemporaries.some((temporary) => !temporary.safeShape || temporary.nlink !== '1')) continue;
    const authorityPath = journalEvidence?.canonicalPath || temporaries[0]?.canonicalPath;
    if (!authorityPath) continue;
    try {
      const journal = publishedHardlinkPair
        ? readRepairJournalAllowPublishedHardlinkPair(journalEvidence!.canonicalPath)
        : readRepairJournal(authorityPath);
      if (journal.phase !== 'PREPARED'
        || journal.repairId !== repairId
        || journal.workspaceOwnerId !== evidence[0].workspaceOwnerId
        || journal.displacementCanonicalRoot !== displacement.canonicalPath
        || journal.repairJournalCanonicalPath !== path.join(
          path.dirname(displacement.canonicalPath),
          `.bridgesllm-project-repair-${repairId}.journal.json`,
        )) continue;
      const decision = await resolveProjectDependencyPromotionDecision({
        operationId: journal.promotionOperationId,
        manifestDigest: journal.manifestDigest,
        database,
      });
      if (!decision) continue;
      const lifecycleRows = await database.$queryRaw<any[]>(Prisma.sql`
        SELECT * FROM "ProjectIdentity" WHERE "id" = ${journal.projectIdentityId}
      `);
      const lifecycle = lifecycleRows[0];
      if (!lifecycle || lifecycle.lifecycleStatus !== 'DEPENDENCY_QUARANTINED'
        || String(lifecycle.workspaceOwnerId) !== journal.workspaceOwnerId
        || String(lifecycle.projectName) !== journal.projectName
        || Number(lifecycle.generation) !== journal.projectIdentityGeneration
        || new Date(lifecycle.dependencyQuarantinedAt).toISOString() !== journal.quarantinedAt) continue;
      const expectedBinding = repairBinding({
        repairId,
        decision,
        quarantinedAt: new Date(journal.quarantinedAt),
        journalPath: journal.repairJournalCanonicalPath,
        displacementRoot: journal.displacementCanonicalRoot,
        backup: journal.backup,
        backupLock: journal.backupLock!,
        movePlan: journal.movePlan,
      });
      if (!journal.backupLock
        || !attestProjectDependencyRepairBackupLock({
          repairId,
          backup: journal.backup,
          lock: journal.backupLock,
        })) continue;
      assertRepairJournalMatches(journal, expectedBinding, repairBindingDigest(expectedBinding));
      for (const temporary of temporaries) {
        if (publishedHardlinkPair) continue;
        const parsed = readRepairJournal(temporary.canonicalPath);
        assertRepairJournalMatches(parsed, expectedBinding, repairBindingDigest(expectedBinding));
        if (parsed.phase !== 'PREPARED') throw new Error('uncommitted repair temporary advanced phase');
      }
      for (const entry of evidence) entry.safeCleanupCandidate = true;
    } catch {}
  }
  unboundEvidence.sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
  const snapshot = { schemaVersion: 1 as const, operations, unboundEvidence };
  return {
    schemaVersion: 1,
    snapshotSha256: crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    hasEvidence: operations.length > 0 || unboundEvidence.length > 0,
    operationIds: operations.map((operation) => operation.promotionOperationId),
    operations,
    targets,
    unboundEvidence,
  };
}

function assertRepairJournalMatches(
  journal: RepairJournal,
  binding: Record<string, unknown>,
  expectedDigest: string,
): void {
  const expected = binding as any;
  if (
    journal.schemaVersion !== 1
    || journal.repairId !== expected.repairId
    || journal.action !== PROJECT_DEPENDENCY_REPAIR_ACTION
    || journal.promotionOperationId !== expected.promotionOperationId
    || journal.manifestDigest !== expected.manifestDigest
    || journal.projectIdentityId !== expected.projectIdentityId
    || journal.projectIdentityGeneration !== expected.projectIdentityGeneration
    || journal.workspaceOwnerId !== expected.workspaceOwnerId
    || journal.projectName !== expected.projectName
    || journal.quarantinedAt !== expected.quarantinedAt
    || journal.repairBindingDigest !== expectedDigest
    || journal.repairJournalCanonicalPath !== expected.repairJournalCanonicalPath
    || journal.displacementCanonicalRoot !== expected.displacementCanonicalRoot
    || JSON.stringify(journal.backup) !== JSON.stringify(expected.backup)
    || JSON.stringify(journal.backupLock) !== JSON.stringify(expected.backupLock)
    || journal.movePlan?.planDigest !== expected.movePlanDigest
  ) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'The repair journal conflicts with the exact authorized generation.',
      503,
    );
  }
}

export function prepareProjectDependencyRepairEvidence(input: {
  repairId: string;
  decision: ProjectDependencyPromotionDecisionRecord;
  quarantinedAt: Date;
  backup: ProjectDependencyRepairBackupFingerprint;
  backupLock: NonNullable<RepairJournal['backupLock']>;
}): { journal: RepairJournal; repairBindingDigest: string } {
  const repairId = uuid(input.repairId, 'repair ID');
  if (!(input.quarantinedAt instanceof Date) || !Number.isFinite(input.quarantinedAt.getTime())) {
    throw new ProjectDependencyRepairError('PROJECT_DEPENDENCY_REPAIR_STALE', 'Quarantine time is unavailable.');
  }
  const backup = normalizeProjectDependencyRepairBackup(input.backup);
  if (BigInt(backup.mtimeNs) <= BigInt(input.quarantinedAt.getTime()) * 1_000_000n) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
      'The verified comprehensive backup must be created strictly after quarantine.',
    );
  }
  const paths = repairPaths(input.decision, repairId);
  const backupLock = Object.freeze({ ...input.backupLock });
  if (!attestProjectDependencyRepairBackupLock({ repairId, backup, lock: backupLock })) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
      'The exact recovery backup pin is unavailable.',
    );
  }
  if (fs.existsSync(paths.journal) || fs.existsSync(paths.displacement)) {
    if (!fs.existsSync(paths.journal) || !fs.existsSync(paths.displacement)) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
        'Dependency repair private evidence is only partially present.',
        503,
      );
    }
    const existing = readRepairJournal(paths.journal);
    const binding = repairBinding({
      repairId,
      decision: input.decision,
      quarantinedAt: input.quarantinedAt,
      journalPath: paths.journal,
      displacementRoot: paths.displacement,
      backup,
      backupLock,
      movePlan: existing.movePlan,
    });
    const bindingDigest = repairBindingDigest(binding);
    assertRepairJournalMatches(existing, binding, bindingDigest);
    const stat = fs.lstatSync(paths.displacement, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || Number(stat.mode & 0o777n) !== 0o700
      || stat.dev.toString() !== existing.displacementIdentity.device
      || stat.ino.toString() !== existing.displacementIdentity.inode
      || stat.birthtimeNs.toString() !== existing.displacementIdentity.birthtimeNs) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
        'Dependency repair displacement evidence changed identity.',
        503,
      );
    }
    return { journal: existing, repairBindingDigest: bindingDigest };
  }

  fs.mkdirSync(paths.displacement, { mode: 0o700 });
  fs.chmodSync(paths.displacement, 0o700);
  try {
    const stat = fs.lstatSync(paths.displacement, { bigint: true });
    const parent = fs.lstatSync(input.decision.operationParentCanonicalRoot, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev !== parent.dev
      || stat.dev.toString() !== input.decision.operationParentDevice
      || Number(stat.mode & 0o777n) !== 0o700) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
        'Dependency repair displacement storage is not private and same-filesystem.',
        503,
      );
    }
    const now = new Date().toISOString();
    const movePlan = buildProjectDependencyForceForwardMovePlan({
      manifest: input.decision.manifest,
      displacementRoot: paths.displacement,
    });
    const binding = repairBinding({
      repairId,
      decision: input.decision,
      quarantinedAt: input.quarantinedAt,
      journalPath: paths.journal,
      displacementRoot: paths.displacement,
      backup,
      backupLock,
      movePlan,
    });
    const bindingDigest = repairBindingDigest(binding);
    const journal: RepairJournal = {
      ...(binding as Omit<RepairJournal, 'repairBindingDigest' | 'displacementIdentity' | 'phase' | 'createdAt' | 'updatedAt'>),
      repairBindingDigest: bindingDigest,
      displacementIdentity: {
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
        birthtimeNs: stat.birthtimeNs.toString(),
      },
      backupLock,
      movePlan,
      phase: 'PREPARED',
      createdAt: now,
      updatedAt: now,
    };
    writeRepairJournal(paths.journal, journal, true);
    return { journal, repairBindingDigest: bindingDigest };
  } catch (error) {
    // Once a journal pathname exists, its publication outcome is durable or
    // indeterminate. Preserve the paired directory and force startup/manual
    // reconciliation instead of manufacturing partial evidence by cleanup.
    if (fs.existsSync(paths.journal)) {
      throw error instanceof ProjectDependencyRepairError
        ? error
        : new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
          'Dependency repair evidence publication is indeterminate.',
          503,
        );
    }
    try {
      fs.rmdirSync(paths.displacement);
    } catch {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
        'Prepared dependency repair evidence could not be removed safely.',
        503,
      );
    }
    throw error;
  }
}

/** Remove only a pre-go-bit journal and an empty private displacement root. */
export function discardPreparedProjectDependencyRepairEvidence(journal: RepairJournal): void {
  if (journal.phase !== 'PREPARED') {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'A committed dependency repair journal cannot be discarded.',
      503,
    );
  }
  const current = readRepairJournal(journal.repairJournalCanonicalPath);
  if (current.repairBindingDigest !== journal.repairBindingDigest || current.phase !== 'PREPARED') {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'The prepared dependency repair journal changed before cleanup.',
      503,
    );
  }
  const stat = fs.lstatSync(journal.displacementCanonicalRoot, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || stat.dev.toString() !== journal.displacementIdentity.device
    || stat.ino.toString() !== journal.displacementIdentity.inode
    || stat.birthtimeNs.toString() !== journal.displacementIdentity.birthtimeNs
    || fs.readdirSync(journal.displacementCanonicalRoot).length !== 0) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'Prepared dependency repair evidence is not empty and exact.',
      503,
    );
  }
  fs.unlinkSync(journal.repairJournalCanonicalPath);
  fs.rmdirSync(journal.displacementCanonicalRoot);
  fsyncDirectory(path.dirname(journal.repairJournalCanonicalPath));
}

function recordMatchesAuthorization(input: {
  record: ProjectDependencyRepairRecord;
  repairId: string;
  actor: JwtPayload;
  decision: ProjectDependencyPromotionDecisionRecord;
  quarantinedAt: Date;
  repairBindingDigest: string;
  backup: ProjectDependencyRepairBackupFingerprint;
  backupLock: NonNullable<RepairJournal['backupLock']>;
  movePlanDigest: string;
}): boolean {
  const paths = repairPaths(input.decision, input.repairId);
  return input.record.repairId === input.repairId
    && input.record.action === PROJECT_DEPENDENCY_REPAIR_ACTION
    && input.record.promotionOperationId === input.decision.operationId
    && input.record.manifestDigest === input.decision.manifestDigest
    && input.record.actorUserId === input.actor.userId
    && input.record.sessionId === input.actor.sessionId
    && input.record.authorizationVersion === input.actor.authorizationVersion
    && input.record.projectIdentityId === input.decision.projectIdentityId
    && input.record.projectIdentityGeneration === input.decision.projectIdentityGeneration
    && input.record.workspaceOwnerId === input.decision.workspaceOwnerId
    && input.record.projectName === input.decision.projectName
    && input.record.quarantinedAt.getTime() === input.quarantinedAt.getTime()
    && input.record.repairJournalCanonicalPath === paths.journal
    && input.record.displacementCanonicalRoot === paths.displacement
    && input.record.repairBindingDigest === input.repairBindingDigest
    && JSON.stringify(input.record.backup) === JSON.stringify(input.backup)
    && JSON.stringify(input.record.backupLock) === JSON.stringify(input.backupLock)
    && input.record.movePlanDigest === input.movePlanDigest;
}

export async function authorizeProjectDependencyForceForward(input: {
  repairId: string;
  actor: JwtPayload;
  decision: ProjectDependencyPromotionDecisionRecord;
  quarantinedAt: Date;
  backup: ProjectDependencyRepairBackupFingerprint;
  repairBindingDigest: string;
  database?: ProjectDependencyRepairDatabase;
}): Promise<{ record: ProjectDependencyRepairRecord; created: boolean }> {
  const database = input.database || defaultDatabase;
  const repairId = uuid(input.repairId, 'repair ID');
  const actorUserId = requiredString(input.actor.userId, 'actor user ID', 255);
  const sessionId = durableSessionId(input.actor);
  const authorizationVersion = positiveInteger(
    input.actor.authorizationVersion,
    'authorization version',
  );
  const backup = normalizeProjectDependencyRepairBackup(input.backup);
  const bindingDigest = digest(input.repairBindingDigest, 'repair binding digest');
  const paths = repairPaths(input.decision, repairId);
  const expectedJournal = readRepairJournal(paths.journal);
  const expectedBinding = repairBinding({
    repairId,
    decision: input.decision,
    quarantinedAt: input.quarantinedAt,
    journalPath: paths.journal,
    displacementRoot: paths.displacement,
    backup,
    backupLock: expectedJournal.backupLock!,
    movePlan: expectedJournal.movePlan,
  });
  if (!expectedJournal.backupLock
    || !attestProjectDependencyRepairBackupLock({
      repairId,
      backup,
      lock: expectedJournal.backupLock,
    })
    || !expectedJournal.movePlan?.planDigest) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
      'The exact recovery backup pin or move plan is unavailable.',
    );
  }
  const expectedBackupLock = expectedJournal.backupLock;
  attestProjectDependencyForceForwardMovePlanBeforeGoBit({
    manifest: input.decision.manifest,
    plan: expectedJournal.movePlan,
  });
  assertRepairJournalMatches(expectedJournal, expectedBinding, bindingDigest);

  try {
    const outcome = await database.$transaction(async (transaction) => {
      // Re-attest immediately inside the serializable go-bit callback. The
      // caller still holds host backup/operation locks, global writer fence and
      // exact Project lock, so any drift here is external and must fail closed.
      attestProjectDependencyForceForwardMovePlanBeforeGoBit({
        manifest: input.decision.manifest,
        plan: expectedJournal.movePlan,
      });
      const existing = await queryRepair(transaction, repairId);
      if (existing) {
        if (!recordMatchesAuthorization({
          record: existing,
          repairId,
          actor: input.actor,
          decision: input.decision,
          quarantinedAt: input.quarantinedAt,
          repairBindingDigest: bindingDigest,
          backup,
          backupLock: expectedBackupLock,
          movePlanDigest: expectedJournal.movePlan.planDigest,
        })) {
          throw new ProjectDependencyRepairError(
            'PROJECT_DEPENDENCY_REPAIR_STALE',
            'The repair request ID is bound to another immutable repair.',
          );
        }
        return { record: existing, created: false };
      }
      const conflicts = await transaction.$queryRaw<any[]>(Prisma.sql`
        SELECT * FROM "ProjectDependencyRepairOperation"
        WHERE "promotionOperationId" = ${input.decision.operationId}::uuid
        FOR UPDATE
      `);
      if (conflicts[0]) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_BUSY',
          'Another repair request already owns this promotion generation.',
        );
      }
      const actors = await transaction.$queryRaw<any[]>(Prisma.sql`
        SELECT "id", "authorizationVersion", "role"::text AS "role",
               "accountStatus"::text AS "accountStatus", "isActive"
        FROM "User" WHERE "id" = ${actorUserId} FOR SHARE
      `);
      const actor = actors[0];
      if (!actor || actor.role !== 'OWNER' || actor.accountStatus !== 'ACTIVE'
        || actor.isActive !== true || Number(actor.authorizationVersion) !== authorizationVersion) {
        throw new ProjectDependencyRepairError(
          'AUTHORIZATION_CHANGED',
          'Owner authorization changed before dependency repair admission.',
          401,
        );
      }
      const sessions = await transaction.$queryRaw<any[]>(Prisma.sql`
        SELECT "id" FROM "Session"
        WHERE "id" = ${sessionId} AND "userId" = ${actorUserId}
          AND "expiresAt" > clock_timestamp()
        FOR SHARE
      `);
      if (!sessions[0]) {
        throw new ProjectDependencyRepairError(
          'AUTHORIZATION_CHANGED',
          'The Owner session was revoked before dependency repair admission.',
          401,
        );
      }
      const decisions = await transaction.$queryRaw<any[]>(Prisma.sql`
        SELECT * FROM "ProjectDependencyPromotionDecision"
        WHERE "operationId" = ${input.decision.operationId}::uuid
          AND "manifestDigest" = ${input.decision.manifestDigest}
        FOR SHARE
      `);
      if (!decisions[0]
        || String(decisions[0].projectIdentityId) !== input.decision.projectIdentityId
        || Number(decisions[0].projectIdentityGeneration) !== input.decision.projectIdentityGeneration
        || String(decisions[0].workspaceOwnerId) !== input.decision.workspaceOwnerId
        || String(decisions[0].projectName) !== input.decision.projectName) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_STALE',
          'The original dependency promotion decision changed.',
        );
      }
      const identities = await transaction.$queryRaw<any[]>(Prisma.sql`
        SELECT * FROM "ProjectIdentity"
        WHERE "id" = ${input.decision.projectIdentityId}
        FOR UPDATE
      `);
      const identity = identities[0];
      if (!identity
        || identity.lifecycleStatus !== 'DEPENDENCY_QUARANTINED'
        || String(identity.workspaceOwnerId) !== input.decision.workspaceOwnerId
        || String(identity.projectName) !== input.decision.projectName
        || String(identity.canonicalRoot) !== input.decision.destinationCanonicalRoot
        || String(identity.rootDevice) !== input.decision.destinationRootDevice
        || String(identity.rootInode) !== input.decision.destinationRootInode
        || String(identity.rootBirthtimeNs) !== input.decision.destinationRootBirthtimeNs
        || Number(identity.generation) !== input.decision.projectIdentityGeneration
        || !identity.dependencyQuarantinedAt
        || new Date(identity.dependencyQuarantinedAt).getTime() !== input.quarantinedAt.getTime()) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_STALE',
          'The exact quarantined Project identity changed.',
        );
      }
      if (BigInt(backup.mtimeNs) <= BigInt(input.quarantinedAt.getTime()) * 1_000_000n) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
          'The pinned backup is not newer than quarantine.',
        );
      }
      const promoted = await transaction.$queryRaw<any[]>(Prisma.sql`
        UPDATE "ProjectIdentity"
        SET "lifecycleStatus" = 'DEPENDENCY_PROMOTING', "updatedAt" = clock_timestamp()
        WHERE "id" = ${input.decision.projectIdentityId}
          AND "generation" = ${input.decision.projectIdentityGeneration}
          AND "lifecycleStatus" = 'DEPENDENCY_QUARANTINED'
          AND "dependencyQuarantinedAt" = ${input.quarantinedAt}
        RETURNING "id"
      `);
      if (!promoted[0]) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_BUSY',
          'The Project repair go-bit was claimed concurrently.',
        );
      }
      const rows = await transaction.$queryRaw<any[]>(Prisma.sql`
        INSERT INTO "ProjectDependencyRepairOperation" (
          "repairId", "promotionOperationId", "manifestDigest", "actorUserId",
          "sessionId", "authorizationVersion", "projectIdentityId",
          "projectIdentityGeneration", "workspaceOwnerId", "projectName",
          "quarantinedAt", "repairJournalCanonicalPath", "displacementCanonicalRoot",
          "repairBindingDigest", "backupPath", "backupFilename", "backupDevice",
          "backupInode", "backupSize", "backupMtimeNs", "backupReceiptDigest",
          "backupFingerprintDigest", "backupLockMarkerPath", "backupLockMarkerDigest",
          "backupLockOwned", "movePlanDigest"
        ) VALUES (
          ${repairId}::uuid, ${input.decision.operationId}::uuid,
          ${input.decision.manifestDigest}, ${actorUserId}, ${sessionId},
          ${authorizationVersion}, ${input.decision.projectIdentityId},
          ${input.decision.projectIdentityGeneration}, ${input.decision.workspaceOwnerId},
          ${input.decision.projectName}, ${input.quarantinedAt}, ${paths.journal},
          ${paths.displacement}, ${bindingDigest}, ${backup.path}, ${backup.filename},
          ${backup.device}, ${backup.inode}, ${BigInt(backup.size)}, ${backup.mtimeNs},
          ${backup.receiptDigest}, ${backup.fingerprintDigest},
          ${expectedBackupLock.markerCanonicalPath},
          ${expectedBackupLock.markerDigest}, ${expectedBackupLock.owned},
          ${expectedJournal.movePlan.planDigest}
        ) RETURNING *
      `);
      if (!rows[0]) throw new Error('repair insert returned no row');
      return { record: normalizedRecord(rows[0]), created: true };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 15_000,
    });
    try {
      writeRepairPhase(expectedJournal, 'GO_BIT');
    } catch {
      // The serializable transaction is already authoritative. Preserve the
      // exact PREPARED evidence; the live executor and startup both reconcile
      // this permitted DB GO_BIT / journal PREPARED seam.
    }
    return outcome;
  } catch (error) {
    if (error instanceof ProjectDependencyRepairError) throw error;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const resolved = await queryRepair(database, repairId);
        if (resolved) {
          if (!recordMatchesAuthorization({
            record: resolved,
            repairId,
            actor: input.actor,
            decision: input.decision,
            quarantinedAt: input.quarantinedAt,
            repairBindingDigest: bindingDigest,
            backup,
            backupLock: expectedBackupLock,
            movePlanDigest: expectedJournal.movePlan.planDigest,
          })) {
            throw new ProjectDependencyRepairError(
              'PROJECT_DEPENDENCY_REPAIR_STALE',
              'The repair request resolved to another immutable operation.',
            );
          }
          if (expectedJournal.phase === 'PREPARED') {
            try { writeRepairPhase(expectedJournal, 'GO_BIT'); } catch {}
          }
          return { record: resolved, created: false };
        }
      } catch (resolutionError) {
        if (resolutionError instanceof ProjectDependencyRepairError) throw resolutionError;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE',
      'The repair go-bit outcome is indeterminate; preserve the global writer fence.',
      503,
    );
  }
}

function assertJournalForRecord(journal: RepairJournal, record: ProjectDependencyRepairRecord): void {
  if (
    journal.repairId !== record.repairId
    || journal.action !== record.action
    || journal.promotionOperationId !== record.promotionOperationId
    || journal.manifestDigest !== record.manifestDigest
    || journal.projectIdentityId !== record.projectIdentityId
    || journal.projectIdentityGeneration !== record.projectIdentityGeneration
    || journal.workspaceOwnerId !== record.workspaceOwnerId
    || journal.projectName !== record.projectName
    || journal.quarantinedAt !== record.quarantinedAt.toISOString()
    || journal.repairBindingDigest !== record.repairBindingDigest
    || journal.repairJournalCanonicalPath !== record.repairJournalCanonicalPath
    || journal.displacementCanonicalRoot !== record.displacementCanonicalRoot
    || JSON.stringify(journal.backup) !== JSON.stringify(record.backup)
    || JSON.stringify(journal.backupLock) !== JSON.stringify(record.backupLock)
    || journal.movePlan?.planDigest !== record.movePlanDigest
  ) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'The filesystem repair journal and database repair record disagree.',
      503,
    );
  }
}

async function advanceRepairPhase(input: {
  record: ProjectDependencyRepairRecord;
  from: ProjectDependencyRepairPhase;
  to: Exclude<ProjectDependencyRepairPhase, 'COMPLETE'>;
  cleanupPlanDigest?: string;
  database: ProjectDependencyRepairDatabase;
}): Promise<ProjectDependencyRepairRecord> {
  const cleanupDigest = input.to === 'EVIDENCE_CLEAN'
    ? digest(input.cleanupPlanDigest, 'cleanup plan digest')
    : null;
  const timestampColumn = input.to === 'ALL_NEW'
    ? Prisma.sql`"allNewAt" = COALESCE("allNewAt", clock_timestamp()),`
    : input.to === 'APPLIED'
      ? Prisma.sql`"appliedAt" = COALESCE("appliedAt", clock_timestamp()),`
      : input.to === 'EVIDENCE_CLEAN'
        ? Prisma.sql`"evidenceCleanedAt" = COALESCE("evidenceCleanedAt", clock_timestamp()),`
        : Prisma.empty;
  const rows = await input.database.$queryRaw<any[]>(Prisma.sql`
    UPDATE "ProjectDependencyRepairOperation"
    SET "phase" = ${input.to},
        ${timestampColumn}
        "cleanupPlanDigest" = CASE
          WHEN ${input.to} = 'EVIDENCE_CLEAN' THEN ${cleanupDigest}
          ELSE "cleanupPlanDigest"
        END,
        "updatedAt" = clock_timestamp()
    WHERE "repairId" = ${input.record.repairId}::uuid
      AND "repairBindingDigest" = ${input.record.repairBindingDigest}
      AND "status" = 'PROMOTING'
      AND "phase" = ${input.from}
    RETURNING *
  `);
  if (rows[0]) return normalizedRecord(rows[0]);
  const resolved = await queryRepair(input.database, input.record.repairId);
  if (resolved && resolved.repairBindingDigest === input.record.repairBindingDigest
    && PROJECT_DEPENDENCY_REPAIR_PHASES.indexOf(resolved.phase)
      >= PROJECT_DEPENDENCY_REPAIR_PHASES.indexOf(input.to)) return resolved;
  throw new ProjectDependencyRepairError(
    'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE',
    'The dependency repair phase transition could not be resolved.',
    503,
  );
}

function writeRepairPhase(journal: RepairJournal, phase: ProjectDependencyRepairPhase): void {
  const currentIndex = journal.phase === 'PREPARED'
    ? -1
    : PROJECT_DEPENDENCY_REPAIR_PHASES.indexOf(journal.phase);
  const nextIndex = PROJECT_DEPENDENCY_REPAIR_PHASES.indexOf(phase);
  if (currentIndex > nextIndex) return;
  if (currentIndex < nextIndex - 1) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'The dependency repair journal skipped a durable phase.',
      503,
    );
  }
  if (journal.phase === phase) return;
  journal.phase = phase;
  writeRepairJournal(journal.repairJournalCanonicalPath, journal);
}

function assertAndRemoveDisplacement(
  record: ProjectDependencyRepairRecord,
  journal: RepairJournal,
  decision: ProjectDependencyPromotionDecisionRecord,
): void {
  if (!fs.existsSync(record.displacementCanonicalRoot)) return;
  const stat = fs.lstatSync(record.displacementCanonicalRoot, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || Number(stat.mode & 0o777n) !== 0o700
    || stat.dev.toString() !== journal.displacementIdentity.device
    || stat.ino.toString() !== journal.displacementIdentity.inode
    || stat.birthtimeNs.toString() !== journal.displacementIdentity.birthtimeNs) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'Dependency repair displacement storage changed identity.',
      503,
    );
  }
  cleanupProjectDependencyRepairDisplacement({
    manifest: decision.manifest,
    displacementRoot: record.displacementCanonicalRoot,
    movePlan: journal.movePlan,
    persistMovePlan: (movePlan) => {
      journal.movePlan = movePlan;
      writeRepairJournal(journal.repairJournalCanonicalPath, journal);
    },
  });
}

function assertRecoverableRepairPhasePair(
  record: ProjectDependencyRepairRecord,
  journal: RepairJournal,
): void {
  const allowed: Record<ProjectDependencyRepairPhase, readonly RepairJournal['phase'][]> = {
    GO_BIT: ['PREPARED', 'GO_BIT', 'ALL_NEW'],
    ALL_NEW: ['ALL_NEW', 'APPLIED'],
    APPLIED: ['APPLIED'],
    EVIDENCE_CLEAN: ['APPLIED', 'EVIDENCE_CLEAN'],
    COMPLETE: ['EVIDENCE_CLEAN', 'COMPLETE'],
  };
  if (!allowed[record.phase].includes(journal.phase)) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      `Dependency repair DB/journal phases conflict (${record.phase}/${journal.phase}).`,
      503,
    );
  }
}

async function finishCompletedRepairJournalCleanup(input: {
  record: ProjectDependencyRepairRecord;
  lifecycleLock: ProjectDeletionLockLease;
  assertExclusiveLease(): void;
  database: ProjectDependencyRepairDatabase;
}): Promise<void> {
  input.assertExclusiveLease();
  assertHeldProjectDeletionLockLease(
    input.lifecycleLock,
    projectDeletionLockKey(input.record.workspaceOwnerId, input.record.projectName),
  );
  if (fs.existsSync(input.record.displacementCanonicalRoot)) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'A completed repair still has displacement evidence.',
      503,
    );
  }
  const decision = await resolveProjectDependencyPromotionDecision({
    operationId: input.record.promotionOperationId,
    manifestDigest: input.record.manifestDigest,
    database: input.database,
  });
  const lifecycle = await input.database.$queryRaw<any[]>(Prisma.sql`
    SELECT * FROM "ProjectIdentity" WHERE "id" = ${input.record.projectIdentityId}
  `);
  if (decision
    || !lifecycle[0]
    || lifecycle[0].lifecycleStatus !== 'ACTIVE'
    || String(lifecycle[0].workspaceOwnerId) !== input.record.workspaceOwnerId
    || String(lifecycle[0].projectName) !== input.record.projectName
    || Number(lifecycle[0].generation) !== input.record.projectIdentityGeneration) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'Completed dependency repair receipt is not bound to one exact active Project.',
      503,
    );
  }
  if (!fs.existsSync(input.record.repairJournalCanonicalPath)) return;
  const journal = readRepairJournal(input.record.repairJournalCanonicalPath);
  assertJournalForRecord(journal, input.record);
  assertRecoverableRepairPhasePair(input.record, journal);
  if (journal.phase === 'EVIDENCE_CLEAN') writeRepairPhase(journal, 'COMPLETE');
  input.assertExclusiveLease();
  fs.unlinkSync(input.record.repairJournalCanonicalPath);
  fsyncDirectory(path.dirname(input.record.repairJournalCanonicalPath));
}

export interface RecoverProjectDependencyRepairsResult {
  resumed: number;
  completed: number;
  held: number;
}

/**
 * Resume repair-owned operations while startup still owns the one global
 * writer fence. The caller must have completed shared-writer and exact-target
 * quiescence; this function additionally owns each branded Project lock.
 */
export async function recoverInterruptedProjectDependencyRepairs(input: {
  reverifyBackup(record: ProjectDependencyRepairRecord): Promise<boolean>;
  assertExclusiveLease(): void;
  acquireLifecycleLock?: typeof acquireProjectDeletionLockWithoutGuard;
  expectedInspection?: ProjectDependencyRepairStartupInspection;
  database?: ProjectDependencyRepairDatabase;
}): Promise<RecoverProjectDependencyRepairsResult> {
  const database = input.database || defaultDatabase;
  input.assertExclusiveLease();
  if (input.expectedInspection) {
    const immediate = await inspectProjectDependencyRepairStartupEvidence({ database });
    if (immediate.schemaVersion !== input.expectedInspection.schemaVersion
      || immediate.snapshotSha256 !== input.expectedInspection.snapshotSha256) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
        'Dependency repair evidence changed after startup quiescence.',
        503,
      );
    }
  }
  const unboundEvidence = input.expectedInspection?.unboundEvidence || [];
  if (unboundEvidence.some((evidence) => !evidence.safeCleanupCandidate)) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
      'Unbound dependency repair evidence cannot be retired safely.',
      503,
    );
  }
  const retiredUnbound = new Set<string>();
  const unboundGroups = new Map<string, ProjectDependencyRepairStartupUnboundEvidence[]>();
  for (const evidence of unboundEvidence) {
    if (!evidence.repairId) continue;
    const bucket = unboundGroups.get(evidence.repairId) || [];
    bucket.push(evidence);
    unboundGroups.set(evidence.repairId, bucket);
  }
  for (const evidence of unboundGroups.values()) {
    const journal = evidence.find((entry) => entry.kind === 'journal');
    const temporaries = evidence.filter((entry) => entry.kind === 'journal_temporary');
    if (!journal || temporaries.length !== 1) continue;
    const journalStat = fs.lstatSync(journal.canonicalPath, { bigint: true });
    const temporaryStat = fs.lstatSync(temporaries[0].canonicalPath, { bigint: true });
    if (journalStat.nlink !== 2n || temporaryStat.nlink !== 2n
      || journalStat.dev !== temporaryStat.dev || journalStat.ino !== temporaryStat.ino) continue;
    if (repairEvidenceTreeDigest(journal.canonicalPath) !== journal.contentSha256
      || repairEvidenceTreeDigest(temporaries[0].canonicalPath) !== temporaries[0].contentSha256) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
        'Prepared repair hardlink evidence changed before atomic cleanup.',
        503,
      );
    }
    input.assertExclusiveLease();
    fs.unlinkSync(temporaries[0].canonicalPath);
    input.assertExclusiveLease();
    fs.unlinkSync(journal.canonicalPath);
    fsyncDirectory(path.dirname(journal.canonicalPath));
    retiredUnbound.add(temporaries[0].canonicalPath);
    retiredUnbound.add(journal.canonicalPath);
  }
  for (const evidence of [...unboundEvidence].sort((left, right) => {
    const priority = { journal_temporary: 0, journal: 1, displacement: 2, unknown: 3 };
    return priority[left.kind] - priority[right.kind]
      || left.canonicalPath.localeCompare(right.canonicalPath);
  })) {
    if (retiredUnbound.has(evidence.canonicalPath)) continue;
    const beforeDigest = repairEvidenceTreeDigest(evidence.canonicalPath);
    if (beforeDigest !== evidence.contentSha256) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
        'Prepared dependency repair evidence changed before cleanup.',
        503,
      );
    }
    input.assertExclusiveLease();
    if (evidence.kind === 'displacement') fs.rmdirSync(evidence.canonicalPath);
    else fs.unlinkSync(evidence.canonicalPath);
    fsyncDirectory(path.dirname(evidence.canonicalPath));
  }
  const acquireLifecycleLock = input.acquireLifecycleLock
    || acquireProjectDeletionLockWithoutGuard;
  const records = (await listProjectDependencyRepairs({ database, includeComplete: true }))
    .filter((record) => record.status !== 'APPLIED'
      || record.phase !== 'COMPLETE'
      || fs.existsSync(record.repairJournalCanonicalPath)
      || fs.existsSync(record.displacementCanonicalRoot));
  let resumed = 0;
  let completed = 0;
  for (const initial of records) {
    input.assertExclusiveLease();
    const lifecycleLock = await acquireLifecycleLock(projectDeletionLockKey(
      initial.workspaceOwnerId,
      initial.projectName,
    ));
    try {
      const record = await resolveProjectDependencyRepair({ repairId: initial.repairId, database });
      if (!record || record.repairBindingDigest !== initial.repairBindingDigest) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
          'Dependency repair receipt changed before startup recovery.',
          503,
        );
      }
      if (record.status === 'APPLIED' && record.phase === 'COMPLETE') {
        for (const temporary of input.expectedInspection?.operations
          .find((operation) => operation.repairId === record.repairId)?.temporaryEvidencePaths || []) {
          input.assertExclusiveLease();
          fs.unlinkSync(temporary);
        }
        await finishCompletedRepairJournalCleanup({
          record,
          lifecycleLock,
          assertExclusiveLease: input.assertExclusiveLease,
          database,
        });
        completed += 1;
        continue;
      }
      if (!attestProjectDependencyRepairBackupFingerprint(record.backup)
        || !await input.reverifyBackup(record)) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
          'The pinned comprehensive backup failed startup re-verification.',
          503,
        );
      }
      const temporaryPaths = input.expectedInspection?.operations
        .find((operation) => operation.repairId === record.repairId)?.temporaryEvidencePaths || [];
      let journal = temporaryPaths.length === 1
        ? readRepairJournalAllowPublishedHardlinkPair(record.repairJournalCanonicalPath)
        : readRepairJournal(record.repairJournalCanonicalPath);
      assertJournalForRecord(journal, record);
      assertRecoverableRepairPhasePair(record, journal);
      for (const temporary of temporaryPaths) {
        input.assertExclusiveLease();
        fs.unlinkSync(temporary);
      }
      if (temporaryPaths.length > 0) {
        fsyncDirectory(path.dirname(record.repairJournalCanonicalPath));
        journal = readRepairJournal(record.repairJournalCanonicalPath);
        assertJournalForRecord(journal, record);
      }
      // Crash seam: the serializable DB go-bit committed, then the process died
      // before publishing its matching filesystem phase.
      if (record.phase === 'GO_BIT' && journal.phase === 'PREPARED') {
        input.assertExclusiveLease();
        writeRepairPhase(journal, 'GO_BIT');
      }
      const result = await executeProjectDependencyForceForward({
        repairId: record.repairId,
        lifecycleLock,
        reverifyBackup: input.reverifyBackup,
        assertExclusiveLease: input.assertExclusiveLease,
        database,
      });
      resumed += 1;
      if (result.status === 'APPLIED' && result.phase === 'COMPLETE') completed += 1;
    } finally {
      lifecycleLock();
    }
  }
  return { resumed, completed, held: 0 };
}

export async function executeProjectDependencyForceForward(input: {
  repairId: string;
  lifecycleLock: ProjectDeletionLockLease;
  reverifyBackup(record: ProjectDependencyRepairRecord): Promise<boolean>;
  /** Re-attest the host-operation and backup flocks before every mutation seam. */
  assertExclusiveLease?: () => void;
  checkpoint?: (checkpoint: ProjectDependencyRepairCheckpoint | `after-phase:${ProjectDependencyRepairPhase}`) => void;
  database?: ProjectDependencyRepairDatabase;
}): Promise<ProjectDependencyRepairRecord> {
  const database = input.database || defaultDatabase;
  input.assertExclusiveLease?.();
  let record = await resolveProjectDependencyRepair({ repairId: input.repairId, database });
  input.assertExclusiveLease?.();
  if (!record) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_STALE',
      'The durable dependency repair operation does not exist.',
    );
  }
  if (record.status === 'APPLIED' && record.phase === 'COMPLETE') return record;
  assertHeldProjectDeletionLockLease(
    input.lifecycleLock,
    projectDeletionLockKey(record.workspaceOwnerId, record.projectName),
  );
  let journal = readRepairJournal(record.repairJournalCanonicalPath);
  input.assertExclusiveLease?.();
  assertJournalForRecord(journal, record);
  assertRecoverableRepairPhasePair(record, journal);
  if (record.phase === 'GO_BIT' && journal.phase === 'PREPARED') {
    writeRepairPhase(journal, 'GO_BIT');
  }
  const decision = await resolveProjectDependencyPromotionDecision({
    operationId: record.promotionOperationId,
    manifestDigest: record.manifestDigest,
    database,
  });
  input.assertExclusiveLease?.();
  if (!decision) {
    throw new ProjectDependencyRepairError(
      'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE',
      'The original promotion decision disappeared before repair completed.',
      503,
    );
  }

  if (record.phase === 'GO_BIT') {
    input.assertExclusiveLease?.();
    forceForwardQuarantinedProjectDependencyPromotion({
      manifest: decision.manifest,
      displacementRoot: record.displacementCanonicalRoot,
      movePlan: journal.movePlan,
      persistMovePlan: (movePlan) => {
        input.assertExclusiveLease?.();
        journal.movePlan = movePlan;
        writeRepairJournal(journal.repairJournalCanonicalPath, journal);
      },
      checkpoint: input.checkpoint,
    });
    writeRepairPhase(journal, 'ALL_NEW');
    input.assertExclusiveLease?.();
    record = await advanceRepairPhase({ record, from: 'GO_BIT', to: 'ALL_NEW', database });
    input.assertExclusiveLease?.();
    input.checkpoint?.('after-phase:ALL_NEW');
  }

  if (record.phase === 'ALL_NEW') {
    input.assertExclusiveLease?.();
    verifyProjectDependencyPromotionManifestAllNew(decision.manifest);
    await markProjectDependencyPromotionApplied({
      operationId: decision.operationId,
      manifestDigest: decision.manifestDigest,
      database,
    });
    input.assertExclusiveLease?.();
    writeRepairPhase(journal, 'APPLIED');
    record = await advanceRepairPhase({ record, from: 'ALL_NEW', to: 'APPLIED', database });
    input.assertExclusiveLease?.();
    input.checkpoint?.('after-phase:APPLIED');
  }

  if (record.phase === 'APPLIED') {
    input.assertExclusiveLease?.();
    if (!attestProjectDependencyRepairBackupFingerprint(record.backup)
      || !await input.reverifyBackup(record)) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
        'The pinned comprehensive backup failed re-verification before evidence cleanup.',
      );
    }
    input.assertExclusiveLease?.();
    await cleanupForceForwardedProjectDependencyPromotion({
      manifest: decision.manifest,
      checkpoint: input.checkpoint,
    });
    input.assertExclusiveLease?.();
    const cleanupPlanDigest = attestProjectDependencyRepairCleanupBeforeGoBit({
      manifest: decision.manifest,
      displacementRoot: record.displacementCanonicalRoot,
      movePlan: journal.movePlan,
    });
    record = await advanceRepairPhase({
      record,
      from: 'APPLIED',
      to: 'EVIDENCE_CLEAN',
      cleanupPlanDigest,
      database,
    });
    writeRepairPhase(journal, 'EVIDENCE_CLEAN');
    input.assertExclusiveLease?.();
    input.checkpoint?.('after-phase:EVIDENCE_CLEAN');
  }

  if (record.phase === 'EVIDENCE_CLEAN') {
    input.assertExclusiveLease?.();
    const cleanupPlanDigest = projectDependencyRepairCleanupPlanDigest(journal.movePlan);
    if (!record.cleanupPlanDigest || record.cleanupPlanDigest !== cleanupPlanDigest) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
        'The durable cleanup go-bit does not match the exact displacement plan.',
        503,
      );
    }
    if (journal.phase === 'APPLIED') writeRepairPhase(journal, 'EVIDENCE_CLEAN');
    for (const step of journal.movePlan.steps) {
      if (step.kind === 'PROMOTE_STAGED') {
        if (step.phase !== 'MOVED') throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
          'A promotion move changed after all-new convergence.',
          503,
        );
        continue;
      }
      if (!['MOVED', 'CLEANUP_INTENT', 'CLEANED'].includes(step.phase)) {
        throw new ProjectDependencyRepairError(
          'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
          'A cleanup move has an invalid durable phase.',
          503,
        );
      }
      // Before the SQL cleanup go-bit, a journal cannot truthfully contain a
      // cleanup phase. Afterwards, SQL's authenticated cleanupPlanDigest is
      // the authority that permits restartable partial deletion.
    }
    if (!attestProjectDependencyRepairBackupFingerprint(record.backup)
      || !await input.reverifyBackup(record)) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
        'The pinned comprehensive backup failed final verification; displaced evidence was retained.',
      );
    }
    input.assertExclusiveLease?.();
    assertAndRemoveDisplacement(record, journal, decision);
    input.assertExclusiveLease?.();
    await deleteAppliedProjectDependencyPromotionDecisionAfterEvidenceCleanup({
      operationId: decision.operationId,
      manifestDigest: decision.manifestDigest,
      lifecycleLock: input.lifecycleLock,
      verifyAppliedGeneration: verifyProjectDependencyPromotionManifestAllNew,
      finalizeRepair: {
        repairId: record.repairId,
        repairBindingDigest: record.repairBindingDigest,
      },
      database,
    });
    input.assertExclusiveLease?.();
    record = (await resolveProjectDependencyRepair({ repairId: record.repairId, database }))!;
    if (record.status !== 'APPLIED' || record.phase !== 'COMPLETE') {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE',
        'The completed dependency repair could not be re-read.',
        503,
      );
    }
    writeRepairPhase(journal, 'COMPLETE');
    input.checkpoint?.('after-phase:COMPLETE');
    try {
      fs.unlinkSync(record.repairJournalCanonicalPath);
      fsyncDirectory(path.dirname(record.repairJournalCanonicalPath));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return record;
}

export async function inspectProjectDependencyRepairStatus(input: {
  workspaceOwnerId: string;
  projectName: string;
  database?: ProjectDependencyRepairDatabase;
}): Promise<{
  lifecycle: any | null;
  decision: ProjectDependencyPromotionDecisionRecord | null;
  repair: ProjectDependencyRepairRecord | null;
}> {
  const database = input.database || defaultDatabase;
  const workspaceOwnerId = requiredString(input.workspaceOwnerId, 'workspace owner ID', 255);
  const projectName = requiredString(input.projectName, 'Project name', 255);
  const rows = await database.$queryRaw<any[]>(Prisma.sql`
    SELECT * FROM "ProjectIdentity"
    WHERE "workspaceOwnerId" = ${workspaceOwnerId} AND "projectName" = ${projectName}
  `);
  const lifecycle = rows[0] || null;
  const decision = lifecycle ? await findProjectDependencyPromotionDecisionByDestination({
    destinationCanonicalRoot: String(lifecycle.canonicalRoot),
    database,
  }) : null;
  const latestRepair = await findProjectDependencyRepairByProject({
    workspaceOwnerId,
    projectName,
    database,
  });
  // A completed repair is retained as durable receipt evidence. Do not let that
  // receipt mask a later, independently quarantined promotion for the same
  // Project: while a decision exists, only its exact operation may own status.
  const repair = decision
    ? latestRepair?.promotionOperationId === decision.operationId
      && latestRepair.manifestDigest === decision.manifestDigest
      ? latestRepair
      : null
    : lifecycle?.lifecycleStatus === 'ACTIVE'
      && latestRepair?.status === 'APPLIED'
      && latestRepair.phase === 'COMPLETE'
      ? latestRepair
      : null;
  return { lifecycle, decision, repair };
}

export interface CompletedProjectDependencyRepairPinRetirementResult {
  retired: number;
  retained: number;
}

function hasRepairFilesystemEvidence(paths: { journal: string; displacement: string }): boolean {
  if (fs.existsSync(paths.journal) || fs.existsSync(paths.displacement)) return true;
  const parent = path.dirname(paths.journal);
  const temporaryPrefix = `${path.basename(paths.journal)}.`;
  try {
    return fs.readdirSync(parent).some((entry) => (
      entry.startsWith(temporaryPrefix) && entry.endsWith('.tmp')
    ));
  } catch {
    return true;
  }
}

/**
 * Post-listen cleanup for repair-owned backup pins left by process death. It
 * deliberately joins the installer operation flock only after the real
 * listener is healthy, so startup never deadlocks against the updater that
 * owns that flock through restart and health verification.
 */
export async function retireConvergedProjectDependencyRepairBackupPins(input: {
  database?: ProjectDependencyRepairDatabase;
} = {}): Promise<CompletedProjectDependencyRepairPinRetirementResult> {
  const database = input.database || defaultDatabase;
  const acquired = await acquireBackupMutationLock();
  let retired = 0;
  let retained = 0;
  try {
    const root = await getConfiguredBackupRoot();
    const files = listBackupFiles(root);
    if (files.length > 10_000) throw new Error('Dependency repair backup pin inventory is too large');
    for (const file of files) {
      const marker = readRepairOwnedBackupLockMarker(file);
      if (!marker) continue;
      try {
        const receiptPath = `${file.fullPath}.receipt.json`;
        const receiptBefore = fs.lstatSync(receiptPath, { bigint: true });
        if (!receiptBefore.isFile() || receiptBefore.isSymbolicLink()
          || receiptBefore.nlink !== 1n || receiptBefore.size <= 0n
          || receiptBefore.size > 16_384n) {
          retained += 1;
          continue;
        }
        const receiptBytes = fs.readFileSync(receiptPath);
        const receiptAfter = fs.lstatSync(receiptPath, { bigint: true });
        if (receiptAfter.dev !== receiptBefore.dev || receiptAfter.ino !== receiptBefore.ino
          || receiptAfter.size !== receiptBefore.size
          || receiptAfter.mtimeNs !== receiptBefore.mtimeNs) {
          retained += 1;
          continue;
        }
        const currentBackup = normalizeProjectDependencyRepairBackup({
          path: file.fullPath,
          filename: file.filename,
          device: file.dev,
          inode: file.ino,
          size: String(file.size),
          mtimeNs: file.mtimeNs,
          receiptDigest: crypto.createHash('sha256').update(receiptBytes).digest('hex'),
          fingerprintDigest: marker.backupFingerprintDigest,
        });
        if (!attestProjectDependencyRepairBackupFingerprint(currentBackup)) {
          retained += 1;
          continue;
        }
        const record = await queryRepair(database, marker.repairId);
        if (record) {
          if (record.status !== 'APPLIED' || record.phase !== 'COMPLETE'
            || !record.backupLock.owned
            || record.projectIdentityId !== marker.projectIdentityId
            || record.projectIdentityGeneration !== marker.projectIdentityGeneration
            || record.workspaceOwnerId !== marker.workspaceOwnerId
            || record.projectName !== marker.projectName
            || record.promotionOperationId !== marker.promotionOperationId
            || record.manifestDigest !== marker.manifestDigest
            || record.backup.path !== file.fullPath
            || record.backup.fingerprintDigest !== marker.backupFingerprintDigest
            || JSON.stringify(record.backup) !== JSON.stringify(currentBackup)
            || hasRepairFilesystemEvidence({
              journal: record.repairJournalCanonicalPath,
              displacement: record.displacementCanonicalRoot,
            })) {
            retained += 1;
            continue;
          }
          const [decision, identities] = await Promise.all([
            resolveProjectDependencyPromotionDecision({
              operationId: record.promotionOperationId,
              manifestDigest: record.manifestDigest,
              database,
            }),
            database.$queryRaw<any[]>(Prisma.sql`
              SELECT * FROM "ProjectIdentity" WHERE "id" = ${record.projectIdentityId}
            `),
          ]);
          const identity = identities[0];
          if (decision || !identity
            || identity.lifecycleStatus !== 'ACTIVE'
            || identity.dependencyQuarantinedAt !== null
            || String(identity.workspaceOwnerId) !== record.workspaceOwnerId
            || String(identity.projectName) !== record.projectName
            || Number(identity.generation) !== record.projectIdentityGeneration) {
            retained += 1;
            continue;
          }
          releaseProjectDependencyRepairBackupLock({
            record,
            lease: acquired.lease,
          });
          retired += 1;
          continue;
        }

        // A crash before the serializable go-bit can leave only the pin. Its
        // payload carries the exact promotion binding so it may be retired
        // only while that same decision remains quarantined and no repair
        // journal, displacement directory, temporary, or DB row exists.
        const decision = await resolveProjectDependencyPromotionDecision({
          operationId: marker.promotionOperationId,
          manifestDigest: marker.manifestDigest,
          database,
        });
        if (!decision
          || decision.projectIdentityId !== marker.projectIdentityId
          || decision.projectIdentityGeneration !== marker.projectIdentityGeneration
          || decision.workspaceOwnerId !== marker.workspaceOwnerId
          || decision.projectName !== marker.projectName
          || hasRepairFilesystemEvidence(repairPaths(decision, marker.repairId))) {
          retained += 1;
          continue;
        }
        const identities = await database.$queryRaw<any[]>(Prisma.sql`
          SELECT * FROM "ProjectIdentity" WHERE "id" = ${marker.projectIdentityId}
        `);
        const identity = identities[0];
        if (!identity
          || identity.lifecycleStatus !== 'DEPENDENCY_QUARANTINED'
          || String(identity.workspaceOwnerId) !== marker.workspaceOwnerId
          || String(identity.projectName) !== marker.projectName
          || Number(identity.generation) !== marker.projectIdentityGeneration) {
          retained += 1;
          continue;
        }
        if (!attestProjectDependencyRepairBackupFingerprint(currentBackup)) {
          retained += 1;
          continue;
        }
        removeExactRepairOwnedBackupLockMarker({
          file,
          expected: marker,
          lease: acquired.lease,
        });
        retired += 1;
      } catch {
        retained += 1;
      }
    }
    return { retired, retained };
  } finally {
    await acquired.release();
  }
}

/** Immediate startup fence-release proof for every repair observed initially. */
export async function attestCompletedProjectDependencyRepairReceipts(input: {
  expected: readonly Pick<ProjectDependencyRepairStartupOperation,
    'repairId' | 'repairBindingDigest' | 'promotionOperationId' | 'manifestDigest'>[];
  database?: ProjectDependencyRepairDatabase;
}): Promise<void> {
  const database = input.database || defaultDatabase;
  for (const expected of input.expected) {
    const record = await resolveProjectDependencyRepair({ repairId: expected.repairId, database });
    if (!record
      || record.status !== 'APPLIED'
      || record.phase !== 'COMPLETE'
      || record.repairBindingDigest !== expected.repairBindingDigest
      || record.promotionOperationId !== expected.promotionOperationId
      || record.manifestDigest !== expected.manifestDigest
      || fs.existsSync(record.repairJournalCanonicalPath)
      || fs.existsSync(record.displacementCanonicalRoot)) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
        'A repair receipt did not remain exact and complete before fence release.',
        503,
      );
    }
    const [decision, identities] = await Promise.all([
      resolveProjectDependencyPromotionDecision({
        operationId: record.promotionOperationId,
        manifestDigest: record.manifestDigest,
        database,
      }),
      database.$queryRaw<any[]>(Prisma.sql`
        SELECT * FROM "ProjectIdentity" WHERE "id" = ${record.projectIdentityId}
      `),
    ]);
    const identity = identities[0];
    if (decision
      || !identity
      || identity.lifecycleStatus !== 'ACTIVE'
      || identity.dependencyQuarantinedAt !== null
      || String(identity.workspaceOwnerId) !== record.workspaceOwnerId
      || String(identity.projectName) !== record.projectName
      || Number(identity.generation) !== record.projectIdentityGeneration) {
      throw new ProjectDependencyRepairError(
        'PROJECT_DEPENDENCY_REPAIR_EVIDENCE_CONFLICT',
        'A completed repair is not bound to one exact active Project.',
        503,
      );
    }
  }
}
