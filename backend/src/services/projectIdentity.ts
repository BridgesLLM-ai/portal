import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { prisma } from '../config/database';

export interface ProjectIdentityRecord {
  id: string;
  workspaceOwnerId: string;
  projectName: string;
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  generation: number;
  lifecycleStatus?: string;
  legacyOpenClawMigrationStatus?: string;
  deletionStartedAt?: Date | null;
  renameTargetName?: string | null;
  renameLeaseTokenHash?: string | null;
  renameLeaseExpiresAt?: Date | null;
  renameStartedAt?: Date | null;
  renameCleanupStartedAt?: Date | null;
  renameRuntimeCleanedAt?: Date | null;
  renameDeployPresent?: boolean | null;
  renameDeployDevice?: string | null;
  renameDeployInode?: string | null;
  renameDeployBirthtimeNs?: string | null;
  lastRenameSourceName?: string | null;
  lastRenameCompletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Exact column set backing ProjectIdentityRecord.
 *
 * Reads that can run against a database which has not yet applied this
 * release's migrations must select these columns explicitly. An unqualified
 * `findUnique`/`findFirst` asks Prisma for every scalar in the *candidate*
 * schema, so a column introduced by this release makes the query fail with
 * `The column (not available) does not exist in the current database` on every
 * host still running the previous version. That is exactly how the 4.0.17
 * rebootability preflight rejected its own upgrade: it queried ProjectIdentity
 * before `20260812_project_dependency_repair_force_forward` had added
 * `dependencyQuarantinedAt`.
 *
 * Keep this list in sync with ProjectIdentityRecord above, and deliberately do
 * NOT add columns here that the record does not declare — the point is that a
 * pre-migration read asks only for what the outgoing schema already has.
 */
export const PROJECT_IDENTITY_RECORD_SELECT = Object.freeze({
  id: true,
  workspaceOwnerId: true,
  projectName: true,
  canonicalRoot: true,
  rootDevice: true,
  rootInode: true,
  rootBirthtimeNs: true,
  generation: true,
  lifecycleStatus: true,
  legacyOpenClawMigrationStatus: true,
  deletionStartedAt: true,
  renameTargetName: true,
  renameLeaseTokenHash: true,
  renameLeaseExpiresAt: true,
  renameStartedAt: true,
  renameCleanupStartedAt: true,
  renameRuntimeCleanedAt: true,
  renameDeployPresent: true,
  renameDeployDevice: true,
  renameDeployInode: true,
  renameDeployBirthtimeNs: true,
  lastRenameSourceName: true,
  lastRenameCompletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const);

interface ProjectIdentityDelegate {
  findUnique(args: unknown): Promise<ProjectIdentityRecord | null>;
  findFirst(args: unknown): Promise<ProjectIdentityRecord | null>;
  create(args: unknown): Promise<ProjectIdentityRecord>;
  update(args: unknown): Promise<ProjectIdentityRecord>;
  updateMany(args: unknown): Promise<{ count: number }>;
  delete(args: unknown): Promise<ProjectIdentityRecord>;
  deleteMany(args: unknown): Promise<{ count: number }>;
}

export interface ProjectIdentityDatabase {
  projectIdentity: ProjectIdentityDelegate;
}

const defaultDatabase = prisma as unknown as ProjectIdentityDatabase;
const PROJECT_IDENTITY_RENAMING = 'RENAMING';
// A crashed rename must become claimable inside the ledger's one-minute
// recovery budget. The live route renews this lease every 30 seconds while it
// owns the operation, so a 45-second default leaves enough jitter for a
// healthy process while bounding crash residue.
const DEFAULT_RENAME_LEASE_MS = 45_000;
const MIN_RENAME_LEASE_MS = 15_000;
const MAX_RENAME_LEASE_MS = 10 * 60_000;

export class ProjectIdentityMismatchError extends Error {
  readonly code = 'PROJECT_IDENTITY_MISMATCH';

  constructor(message: string) {
    super(message);
    this.name = 'ProjectIdentityMismatchError';
  }
}

export class ProjectIdentityLifecycleError extends Error {
  readonly code = 'PROJECT_IDENTITY_LIFECYCLE';

  constructor(message = 'Project deletion is already in progress') {
    super(message);
    this.name = 'ProjectIdentityLifecycleError';
  }
}

export interface AttestedProjectRoot {
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
}

export type AttestedDirectoryIdentity = Pick<
  AttestedProjectRoot,
  'rootDevice' | 'rootInode' | 'rootBirthtimeNs'
>;

export function readProjectIdentityRenameDeployIdentity(
  identity: ProjectIdentityRecord,
): AttestedDirectoryIdentity | null {
  const values = [
    identity.renameDeployDevice,
    identity.renameDeployInode,
    identity.renameDeployBirthtimeNs,
  ];
  if (identity.renameDeployPresent === false) {
    if (values.some((value) => value != null)) {
      throw new ProjectIdentityLifecycleError('Project rename deployment journal is malformed');
    }
    return null;
  }
  if (
    identity.renameDeployPresent !== true
    || values.some((value) => typeof value !== 'string' || value.length === 0)
  ) {
    throw new ProjectIdentityLifecycleError('Project rename deployment journal is incomplete');
  }
  return Object.freeze({
    rootDevice: identity.renameDeployDevice!,
    rootInode: identity.renameDeployInode!,
    rootBirthtimeNs: identity.renameDeployBirthtimeNs!,
  });
}

function requireWorkspaceOwnerId(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.includes('\0') || path.basename(normalized) !== normalized || normalized.includes('\\')) {
    throw new Error('Invalid project workspace owner');
  }
  return normalized;
}

/**
 * Dot-prefixed names are the Portal's reserved internal namespace inside a
 * projects root (the lifecycle quarantine staging directory today, future
 * markers tomorrow). They are never projects: lazy identity adoption once
 * registered `.bridgesllm-lifecycle-quarantine` as a permanent, undeletable
 * ghost project on every box after its first delete.
 */
export function isInternalProjectDirectoryName(value: string): boolean {
  return String(value || '').trim().startsWith('.');
}

function requireProjectName(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '.' || normalized === '..' || normalized.includes('\0') || path.basename(normalized) !== normalized || normalized.includes('\\')) {
    throw new Error('Invalid project name');
  }
  if (isInternalProjectDirectoryName(normalized)) {
    throw new Error('Invalid project name');
  }
  return normalized;
}

/**
 * Remove identity rows registered for internal directory names. Idempotent;
 * runs at Portal start so boxes that already adopted the quarantine ghost
 * converge without a schema migration.
 */
export async function retireInternalProjectIdentityDebris(
  database: ProjectIdentityDatabase = defaultDatabase,
): Promise<number> {
  const { count } = await database.projectIdentity.deleteMany({
    where: { projectName: { startsWith: '.' } },
  });
  if (count > 0) {
    console.warn(
      `[project-identity] removed ${count} internal-directory identity row(s); `
        + 'internal names (lifecycle quarantine) are never projects',
    );
  }
  return count;
}

export function attestProjectRoot(projectRoot: string): AttestedProjectRoot {
  const requestedRoot = path.resolve(String(projectRoot || ''));
  const entry = fs.lstatSync(requestedRoot);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new ProjectIdentityMismatchError('Project root must be a real directory');
  }
  const canonicalRoot = fs.realpathSync.native(requestedRoot);
  const canonicalEntry = fs.lstatSync(canonicalRoot, { bigint: true });
  if (canonicalEntry.isSymbolicLink() || !canonicalEntry.isDirectory()) {
    throw new ProjectIdentityMismatchError('Canonical project root must be a real directory');
  }
  return {
    canonicalRoot,
    rootDevice: canonicalEntry.dev.toString(),
    rootInode: canonicalEntry.ino.toString(),
    rootBirthtimeNs: canonicalEntry.birthtimeNs.toString(),
  };
}

function assertIdentityMatchesRoot(identity: ProjectIdentityRecord, root: AttestedProjectRoot): void {
  if (
    identity.canonicalRoot !== root.canonicalRoot
    || identity.rootDevice !== root.rootDevice
    || identity.rootInode !== root.rootInode
    || identity.rootBirthtimeNs !== root.rootBirthtimeNs
  ) {
    throw new ProjectIdentityMismatchError(
      'The project directory no longer matches its server-owned identity. Project Chat is disabled until the project is re-enrolled.',
    );
  }
}

/** One honest sentence per blocked lifecycle state; never names the wrong operation. */
export function projectLifecycleBlockedMessage(identity: Pick<
  ProjectIdentityRecord,
  'lifecycleStatus' | 'renameLeaseExpiresAt'
>): string {
  const status = identity.lifecycleStatus || 'ACTIVE';
  if (status === 'RENAMING') {
    const expiry = identity.renameLeaseExpiresAt;
    const live = expiry instanceof Date && expiry.getTime() > Date.now();
    return live
      ? 'A rename of this project is in progress. Try again when it finishes.'
      : 'An interrupted rename of this project is being restored automatically. Try again in a moment.';
  }
  if (status === 'DELETING') return 'Project deletion is already in progress';
  if (status === 'CREATING') return 'This project is still being created. Try again in a moment.';
  if (status === 'DEPENDENCY_PROMOTING') {
    return 'This Project is finishing an interrupted dependency update. Try again after recovery completes.';
  }
  if (status === 'DEPENDENCY_QUARANTINED') {
    return 'This Project is quarantined after an interrupted dependency update and requires authenticated recovery.';
  }
  return `Project lifecycle state ${status} is blocking this operation`;
}

function assertIdentityActive(identity: ProjectIdentityRecord): void {
  if ((identity.lifecycleStatus || 'ACTIVE') !== 'ACTIVE') {
    throw new ProjectIdentityLifecycleError(projectLifecycleBlockedMessage(identity));
  }
}

function isUniqueConflict(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002';
}

function renameLeaseDuration(value: unknown): number {
  const parsed = typeof value === 'number' ? value : DEFAULT_RENAME_LEASE_MS;
  if (!Number.isFinite(parsed)) return DEFAULT_RENAME_LEASE_MS;
  return Math.max(MIN_RENAME_LEASE_MS, Math.min(MAX_RENAME_LEASE_MS, Math.floor(parsed)));
}

function renameLeaseDigest(token: string): string {
  const normalized = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(normalized)) {
    throw new ProjectIdentityLifecycleError('Project rename lease identity is invalid');
  }
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function expectedRenameTargetRoot(identity: ProjectIdentityRecord, targetName: string): string {
  const target = path.resolve(path.dirname(identity.canonicalRoot), requireProjectName(targetName));
  if (path.dirname(target) !== path.dirname(identity.canonicalRoot)) {
    throw new ProjectIdentityMismatchError('Renamed project root escaped its workspace');
  }
  return target;
}

function assertSameRootIdentity(identity: ProjectIdentityRecord, root: AttestedProjectRoot): void {
  if (
    identity.rootDevice !== root.rootDevice
    || identity.rootInode !== root.rootInode
    || identity.rootBirthtimeNs !== root.rootBirthtimeNs
  ) {
    throw new ProjectIdentityMismatchError('Renamed project root does not match the original project identity');
  }
}

function assertSameFilesystemIdentity(
  expected: Pick<AttestedProjectRoot, 'rootDevice' | 'rootInode' | 'rootBirthtimeNs'>,
  actual: AttestedProjectRoot,
  message: string,
): void {
  if (
    expected.rootDevice !== actual.rootDevice
    || expected.rootInode !== actual.rootInode
    || expected.rootBirthtimeNs !== actual.rootBirthtimeNs
  ) {
    throw new ProjectIdentityMismatchError(message);
  }
}

function pathExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Move one real directory without replacing a target that appears after the
 * caller's preflight. GNU mv's no-clobber path uses the platform no-replace
 * primitive when available; the source-presence and post-move inode proof make
 * a silent no-op or source swap fail closed before any recursive removal or DB
 * commit can follow.
 */
export function moveAttestedDirectoryNoReplace(input: {
  sourceRoot: string;
  targetRoot: string;
  expectedIdentity?: Pick<AttestedProjectRoot, 'rootDevice' | 'rootInode' | 'rootBirthtimeNs'>;
}): AttestedProjectRoot {
  const sourceRoot = path.resolve(String(input.sourceRoot || ''));
  const targetRoot = path.resolve(String(input.targetRoot || ''));
  if (sourceRoot === targetRoot) {
    throw new ProjectIdentityMismatchError('Attested directory move target must differ from its source');
  }
  const source = attestProjectRoot(sourceRoot);
  const targetParent = attestProjectRoot(path.dirname(targetRoot));
  if (
    targetParent.canonicalRoot !== path.dirname(targetRoot)
    || targetParent.rootDevice !== source.rootDevice
  ) {
    throw new ProjectIdentityMismatchError('Attested directory move must remain on one real managed filesystem');
  }
  if (input.expectedIdentity) {
    assertSameFilesystemIdentity(
      input.expectedIdentity,
      source,
      'Managed directory changed before its attested move',
    );
  }
  if (pathExists(targetRoot)) {
    throw new ProjectIdentityLifecycleError('Managed directory move target already exists');
  }
  try {
    execFileSync('mv', ['--no-clobber', '--no-target-directory', '--', sourceRoot, targetRoot], {
      timeout: 30_000,
      stdio: 'ignore',
    });
  } catch (error) {
    // execFileSync can report a timeout or relay failure after mv committed.
    // Reconcile that one unambiguous outcome by the inode, otherwise leave the
    // durable lifecycle barrier closed for recovery.
    if (!pathExists(sourceRoot) && pathExists(targetRoot)) {
      const moved = attestProjectRoot(targetRoot);
      assertSameFilesystemIdentity(
        source,
        moved,
        'Managed directory identity changed during its uncertain move',
      );
      if (input.expectedIdentity) {
        assertSameFilesystemIdentity(
          input.expectedIdentity,
          moved,
          'Managed directory no longer matches its durable identity after the uncertain move',
        );
      }
      return moved;
    }
    const moveError = new ProjectIdentityLifecycleError('Managed directory could not be moved without replacement');
    (moveError as Error & { cause?: unknown }).cause = error;
    throw moveError;
  }
  if (pathExists(sourceRoot) || !pathExists(targetRoot)) {
    throw new ProjectIdentityLifecycleError(
      'Managed directory no-replace move did not claim the target',
    );
  }
  const moved = attestProjectRoot(targetRoot);
  assertSameFilesystemIdentity(
    source,
    moved,
    'Managed directory identity changed during its move',
  );
  if (input.expectedIdentity) {
    assertSameFilesystemIdentity(
      input.expectedIdentity,
      moved,
      'Managed directory no longer matches its durable identity after the move',
    );
  }
  return moved;
}

async function persistRecoveredRename(
  identity: ProjectIdentityRecord,
  mode: 'cancel' | 'complete',
  database: ProjectIdentityDatabase,
): Promise<ProjectIdentityRecord> {
  const targetName = requireProjectName(identity.renameTargetName || '');
  const targetRoot = expectedRenameTargetRoot(identity, targetName);
  const root = attestProjectRoot(mode === 'complete' ? targetRoot : identity.canonicalRoot);
  assertSameRootIdentity(identity, root);
  const updated = await database.projectIdentity.updateMany({
    where: {
      id: identity.id,
      lifecycleStatus: PROJECT_IDENTITY_RENAMING,
      renameLeaseTokenHash: identity.renameLeaseTokenHash,
    },
    data: mode === 'complete'
      ? {
          projectName: targetName,
          canonicalRoot: root.canonicalRoot,
          rootDevice: root.rootDevice,
          rootInode: root.rootInode,
          rootBirthtimeNs: root.rootBirthtimeNs,
          generation: identity.generation + 1,
          lifecycleStatus: 'ACTIVE',
          renameTargetName: null,
          renameLeaseTokenHash: null,
          renameLeaseExpiresAt: null,
          renameStartedAt: null,
          renameCleanupStartedAt: null,
          renameRuntimeCleanedAt: null,
          renameDeployPresent: null,
          renameDeployDevice: null,
          renameDeployInode: null,
          renameDeployBirthtimeNs: null,
          lastRenameSourceName: identity.projectName,
          lastRenameCompletedAt: new Date(),
        }
      : {
          lifecycleStatus: 'ACTIVE',
          renameTargetName: null,
          renameLeaseTokenHash: null,
          renameLeaseExpiresAt: null,
          renameStartedAt: null,
          renameCleanupStartedAt: null,
          renameRuntimeCleanedAt: null,
          renameDeployPresent: null,
          renameDeployDevice: null,
          renameDeployInode: null,
          renameDeployBirthtimeNs: null,
        },
  });
  if (updated.count !== 1) {
    throw new ProjectIdentityLifecycleError('Interrupted Project rename changed before recovery');
  }
  const recovered = await database.projectIdentity.findUnique({ where: { id: identity.id } });
  if (!recovered || recovered.lifecycleStatus !== 'ACTIVE') {
    throw new ProjectIdentityLifecycleError('Interrupted Project rename recovery could not be verified');
  }
  assertIdentityMatchesRoot(recovered, root);
  return recovered;
}

/**
 * Finishes or cancels only an expired, server-owned rename journal. A live
 * lease remains an admission barrier; ordinary GET/clear/delete requests can
 * never cancel a rename that is still cleaning provider state.
 */
export async function recoverInterruptedProjectIdentityRename(input: {
  workspaceOwnerId: string;
  projectName: string;
  projectRoot: string;
  now?: Date;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord | null> {
  const workspaceOwnerId = requireWorkspaceOwnerId(input.workspaceOwnerId);
  const projectName = requireProjectName(input.projectName);
  const requestedRoot = path.resolve(String(input.projectRoot || ''));
  const exact = await database.projectIdentity.findUnique({
    where: { workspaceOwnerId_projectName: { workspaceOwnerId, projectName } },
  });
  const identity = exact?.lifecycleStatus === PROJECT_IDENTITY_RENAMING
    ? exact
    : await database.projectIdentity.findFirst({
        where: {
          workspaceOwnerId,
          lifecycleStatus: PROJECT_IDENTITY_RENAMING,
          renameTargetName: projectName,
        },
      });
  // Recovery is an explicit journal operation, not an alternate read path.
  // Returning an unrelated ACTIVE identity for an already-occupied target
  // would let a stale rename request mistake that Project for its own
  // completed move.
  if (!identity || identity.lifecycleStatus !== PROJECT_IDENTITY_RENAMING) return null;
  readProjectIdentityRenameDeployIdentity(identity);
  const expiry = identity.renameLeaseExpiresAt;
  const now = input.now || new Date();
  if (!(expiry instanceof Date) || !Number.isFinite(expiry.getTime())) {
    throw new ProjectIdentityLifecycleError('Project rename journal has an invalid lease');
  }
  if (expiry.getTime() > now.getTime()) {
    throw new ProjectIdentityLifecycleError('Project rename is still in progress');
  }
  const targetName = requireProjectName(identity.renameTargetName || '');
  const oldRoot = path.resolve(identity.canonicalRoot);
  const targetRoot = expectedRenameTargetRoot(identity, targetName);
  const oldExists = pathExists(oldRoot);
  const targetExists = pathExists(targetRoot);
  if (oldExists === targetExists) {
    throw new ProjectIdentityLifecycleError(
      'Interrupted Project rename has ambiguous filesystem state and requires operator recovery',
    );
  }
  if (oldExists) {
    if (requestedRoot !== oldRoot || projectName !== identity.projectName) {
      throw new ProjectIdentityLifecycleError('Interrupted Project rename has not moved to this path');
    }
    if (!(identity.renameRuntimeCleanedAt instanceof Date)) {
      throw new ProjectIdentityLifecycleError(
        'Interrupted Project rename must finish provider cleanup before it can be cancelled',
      );
    }
    return persistRecoveredRename(identity, 'cancel', database);
  }
  if (requestedRoot !== targetRoot || projectName !== targetName) {
    throw new ProjectIdentityLifecycleError('Interrupted Project rename completed at a different path');
  }
  if (!(identity.renameRuntimeCleanedAt instanceof Date)) {
    throw new ProjectIdentityLifecycleError(
      'Interrupted Project rename moved its root before runtime cleanup was durably recorded',
    );
  }
  return persistRecoveredRename(identity, 'complete', database);
}

/**
 * Inspect a rename journal without changing it. Destructive routes use this to
 * decide whether they must finish provider cleanup before reopening admission.
 * Ordinary Project Chat reads deliberately do not call this helper.
 */
export async function readProjectIdentityRenameJournal(input: {
  workspaceOwnerId: string;
  projectName: string;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord | null> {
  const workspaceOwnerId = requireWorkspaceOwnerId(input.workspaceOwnerId);
  const projectName = requireProjectName(input.projectName);
  const exact = await database.projectIdentity.findUnique({
    where: { workspaceOwnerId_projectName: { workspaceOwnerId, projectName } },
  });
  const identity = exact?.lifecycleStatus === PROJECT_IDENTITY_RENAMING
    ? exact
    : await database.projectIdentity.findFirst({
        where: {
          workspaceOwnerId,
          lifecycleStatus: PROJECT_IDENTITY_RENAMING,
          renameTargetName: projectName,
        },
      });
  if (!identity || identity.lifecycleStatus !== PROJECT_IDENTITY_RENAMING) return null;
  requireProjectName(identity.renameTargetName || '');
  readProjectIdentityRenameDeployIdentity(identity);
  const expiry = identity.renameLeaseExpiresAt;
  if (
    !identity.renameLeaseTokenHash
    || !(expiry instanceof Date)
    || !Number.isFinite(expiry.getTime())
  ) {
    throw new ProjectIdentityLifecycleError('Project rename journal is malformed');
  }
  return identity;
}

/** Verify a successful old->new replay without treating an unrelated ACTIVE
 * target as success. The receipt records only the immediately preceding name;
 * root attestation still binds the response to the immutable Project inode. */
export async function readCompletedProjectIdentityRename(input: {
  workspaceOwnerId: string;
  oldProjectName: string;
  newProjectName: string;
  newProjectRoot: string;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord | null> {
  const workspaceOwnerId = requireWorkspaceOwnerId(input.workspaceOwnerId);
  const oldProjectName = requireProjectName(input.oldProjectName);
  const newProjectName = requireProjectName(input.newProjectName);
  const identity = await database.projectIdentity.findUnique({
    where: { workspaceOwnerId_projectName: { workspaceOwnerId, projectName: newProjectName } },
  });
  if (
    !identity
    || (identity.lifecycleStatus || 'ACTIVE') !== 'ACTIVE'
    || identity.lastRenameSourceName !== oldProjectName
    || !(identity.lastRenameCompletedAt instanceof Date)
  ) {
    return null;
  }
  const root = attestProjectRoot(input.newProjectRoot);
  assertIdentityMatchesRoot(identity, root);
  return identity;
}

/**
 * Refuse to enroll a new project under a name reserved by an in-flight rename.
 * The process-local name lock closes the check/create race; this database
 * check preserves the reservation across backend restarts.
 */
export async function assertProjectIdentityNameAvailable(input: {
  workspaceOwnerId: string;
  projectName: string;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<void> {
  const workspaceOwnerId = requireWorkspaceOwnerId(input.workspaceOwnerId);
  const projectName = requireProjectName(input.projectName);
  const conflict = await database.projectIdentity.findFirst({
    where: {
      workspaceOwnerId,
      OR: [
        { projectName },
        { lifecycleStatus: PROJECT_IDENTITY_RENAMING, renameTargetName: projectName },
      ],
    },
  });
  if (conflict) {
    throw new ProjectIdentityLifecycleError('Project name is already owned or reserved');
  }
}

export async function ensureProjectIdentity(input: {
  workspaceOwnerId: string;
  projectName: string;
  projectRoot: string;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord> {
  const workspaceOwnerId = requireWorkspaceOwnerId(input.workspaceOwnerId);
  const projectName = requireProjectName(input.projectName);
  const root = attestProjectRoot(input.projectRoot);
  const where = { workspaceOwnerId_projectName: { workspaceOwnerId, projectName } };
  const existing = await database.projectIdentity.findUnique({ where });
  if (existing) {
    assertIdentityMatchesRoot(existing, root);
    assertIdentityActive(existing);
    return existing;
  }

  const renameReservation = await database.projectIdentity.findFirst({
    where: {
      workspaceOwnerId,
      lifecycleStatus: PROJECT_IDENTITY_RENAMING,
      renameTargetName: projectName,
    },
  });
  if (renameReservation) {
    throw new ProjectIdentityLifecycleError('Project name is reserved by a rename in progress');
  }

  try {
    return await database.projectIdentity.create({
      data: {
        id: crypto.randomUUID(),
        workspaceOwnerId,
        projectName,
        canonicalRoot: root.canonicalRoot,
        rootDevice: root.rootDevice,
        rootInode: root.rootInode,
        rootBirthtimeNs: root.rootBirthtimeNs,
        generation: 1,
      },
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const raced = await database.projectIdentity.findUnique({ where });
    if (!raced) throw error;
    assertIdentityMatchesRoot(raced, root);
    assertIdentityActive(raced);
    return raced;
  }
}

/**
 * Reserve a hidden staging root that this request authoritatively created.
 * Unlike lazy enrollment, this insert records that the immutable Project
 * instance was born in the current Portal namespace and therefore has no
 * legacy OpenClaw history to reconcile. CREATING is a durable admission fence:
 * no ordinary Project route may observe the staged root as ACTIVE.
 *
 * This function is deliberately insert-only. A concurrent or pre-existing
 * identity remains unchanged and the caller must fail closed; in particular,
 * an identity lazily enrolled as NONE must never be promoted to CURRENT.
 */
export async function createCurrentProjectIdentity(input: {
  workspaceOwnerId: string;
  projectName: string;
  projectRoot: string;
  projectIdentityId?: string;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord> {
  const workspaceOwnerId = requireWorkspaceOwnerId(input.workspaceOwnerId);
  const projectName = requireProjectName(input.projectName);
  const root = attestProjectRoot(input.projectRoot);
  const projectIdentityId = input.projectIdentityId === undefined
    ? crypto.randomUUID()
    : String(input.projectIdentityId);
  const isOperationId = /^[a-f0-9]{32}$/i.test(projectIdentityId);
  const isUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
    .test(projectIdentityId);
  if (!isOperationId && !isUuid) {
    throw new ProjectIdentityLifecycleError('Current Project creation identity is invalid');
  }

  try {
    return await database.projectIdentity.create({
      data: {
        id: projectIdentityId,
        workspaceOwnerId,
        projectName,
        canonicalRoot: root.canonicalRoot,
        rootDevice: root.rootDevice,
        rootInode: root.rootInode,
        rootBirthtimeNs: root.rootBirthtimeNs,
        generation: 1,
        lifecycleStatus: 'CREATING',
        legacyOpenClawMigrationStatus: 'CURRENT',
      },
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    throw new ProjectIdentityLifecycleError(
      'Project identity already exists or became reserved during current-project enrollment',
    );
  }
}

/**
 * Publish a completely constructed CURRENT Project after its hidden staging
 * inode has been moved without replacement to the final path. The physical
 * directory identity must remain unchanged across that move; the guarded CAS
 * is the only transition from CREATING to ACTIVE.
 */
export async function finalizeCurrentProjectIdentityCreation(input: {
  projectIdentityId: string;
  projectRoot: string;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord> {
  const projectIdentityId = String(input.projectIdentityId || '').trim();
  if (!projectIdentityId || projectIdentityId.includes('\0')) {
    throw new ProjectIdentityLifecycleError('Current Project creation identity is invalid');
  }
  const existing = await database.projectIdentity.findUnique({ where: { id: projectIdentityId } });
  if (
    !existing
    || existing.lifecycleStatus !== 'CREATING'
    || existing.legacyOpenClawMigrationStatus !== 'CURRENT'
  ) {
    throw new ProjectIdentityLifecycleError('Current Project creation is not awaiting publication');
  }
  const publishedRoot = attestProjectRoot(input.projectRoot);
  assertSameFilesystemIdentity(
    existing,
    publishedRoot,
    'Current Project staging identity changed before publication',
  );
  const updated = await database.projectIdentity.updateMany({
    where: {
      id: existing.id,
      lifecycleStatus: 'CREATING',
      legacyOpenClawMigrationStatus: 'CURRENT',
      canonicalRoot: existing.canonicalRoot,
      rootDevice: existing.rootDevice,
      rootInode: existing.rootInode,
      rootBirthtimeNs: existing.rootBirthtimeNs,
    },
    data: {
      canonicalRoot: publishedRoot.canonicalRoot,
      lifecycleStatus: 'ACTIVE',
    },
  });
  if (updated.count !== 1) {
    throw new ProjectIdentityLifecycleError('Current Project creation changed before publication');
  }
  const active = await database.projectIdentity.findUnique({ where: { id: existing.id } });
  if (!active) {
    throw new ProjectIdentityLifecycleError('Published Current Project identity disappeared');
  }
  assertIdentityMatchesRoot(active, publishedRoot);
  assertIdentityActive(active);
  if (active.legacyOpenClawMigrationStatus !== 'CURRENT') {
    throw new ProjectIdentityLifecycleError('Published Project lost its CURRENT provenance');
  }
  return active;
}

/**
 * Read and attest an existing immutable Project identity without enrolling or
 * migrating anything. Poll/status/history routes use this so an HTTP GET can
 * never create Project Chat state as a side effect.
 */
export async function readProjectIdentity(input: {
  workspaceOwnerId: string;
  projectName: string;
  projectRoot: string;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord | null> {
  const workspaceOwnerId = requireWorkspaceOwnerId(input.workspaceOwnerId);
  const projectName = requireProjectName(input.projectName);
  const root = attestProjectRoot(input.projectRoot);
  const identity = await database.projectIdentity.findUnique({
    where: { workspaceOwnerId_projectName: { workspaceOwnerId, projectName } },
  });
  if (!identity) return null;
  assertIdentityMatchesRoot(identity, root);
  assertIdentityActive(identity);
  return identity;
}

export async function beginProjectIdentityDeletion(input: {
  workspaceOwnerId: string;
  projectName: string;
  projectRoot: string;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord> {
  const workspaceOwnerId = requireWorkspaceOwnerId(input.workspaceOwnerId);
  const projectName = requireProjectName(input.projectName);
  const root = attestProjectRoot(input.projectRoot);
  const where = { workspaceOwnerId_projectName: { workspaceOwnerId, projectName } };
  let identity = await database.projectIdentity.findUnique({ where });
  if (!identity) {
    identity = await database.projectIdentity.create({
      data: {
        id: crypto.randomUUID(),
        workspaceOwnerId,
        projectName,
        canonicalRoot: root.canonicalRoot,
        rootDevice: root.rootDevice,
        rootInode: root.rootInode,
        rootBirthtimeNs: root.rootBirthtimeNs,
        generation: 1,
        lifecycleStatus: 'ACTIVE',
      },
    });
  }
  assertIdentityMatchesRoot(identity, root);
  const status = identity.lifecycleStatus || 'ACTIVE';
  if (status === 'DELETING') return identity;
  if (status !== 'ACTIVE') {
    throw new ProjectIdentityLifecycleError(`Project lifecycle state ${status} cannot enter deletion`);
  }
  if (identity.legacyOpenClawMigrationStatus === 'PENDING') {
    throw new ProjectIdentityLifecycleError('Project deletion is blocked by legacy history reconciliation');
  }
  const updated = await database.projectIdentity.updateMany({
    where: {
      id: identity.id,
      lifecycleStatus: 'ACTIVE',
      legacyOpenClawMigrationStatus: { not: 'PENDING' },
    },
    data: { lifecycleStatus: 'DELETING', deletionStartedAt: new Date() },
  });
  if (updated.count !== 1) {
    const raced = await database.projectIdentity.findUnique({ where });
    if (!raced || raced.lifecycleStatus !== 'DELETING') {
      throw new ProjectIdentityLifecycleError('Project lifecycle changed before deletion admission could close');
    }
    assertIdentityMatchesRoot(raced, root);
    return raced;
  }
  const deleting = await database.projectIdentity.findUnique({ where });
  if (!deleting || deleting.lifecycleStatus !== 'DELETING') {
    throw new ProjectIdentityLifecycleError('Project deletion admission barrier could not be verified');
  }
  assertIdentityMatchesRoot(deleting, root);
  return deleting;
}

export async function loadDeletingProjectIdentity(input: {
  workspaceOwnerId: string;
  projectName: string;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord | null> {
  const workspaceOwnerId = requireWorkspaceOwnerId(input.workspaceOwnerId);
  const projectName = requireProjectName(input.projectName);
  const identity = await database.projectIdentity.findUnique({
    where: { workspaceOwnerId_projectName: { workspaceOwnerId, projectName } },
  });
  if (!identity) return null;
  if (identity.lifecycleStatus !== 'DELETING') {
    throw new ProjectIdentityLifecycleError('Project identity is not in the deletion lifecycle');
  }
  return identity;
}

/**
 * Deletion entry for a project whose directory is already gone. An ACTIVE
 * identity without its root is definitionally orphaned — its root can never
 * attest again — so it may transition straight into the deletion lifecycle.
 */
export async function beginOrphanedProjectIdentityDeletion(input: {
  workspaceOwnerId: string;
  projectName: string;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord | null> {
  const workspaceOwnerId = requireWorkspaceOwnerId(input.workspaceOwnerId);
  const projectName = requireProjectName(input.projectName);
  const identity = await database.projectIdentity.findUnique({
    where: { workspaceOwnerId_projectName: { workspaceOwnerId, projectName } },
  });
  if (!identity) return null;
  if (identity.lifecycleStatus === 'DELETING') return identity;
  if (identity.lifecycleStatus !== 'ACTIVE' || identity.legacyOpenClawMigrationStatus === 'PENDING') {
    throw new ProjectIdentityLifecycleError('Project deletion admission is not currently available');
  }
  if (fs.existsSync(identity.canonicalRoot)) {
    throw new ProjectIdentityLifecycleError(
      'Project root still exists; use the attested deletion path',
    );
  }
  const updated = await database.projectIdentity.updateMany({
    where: {
      id: identity.id,
      lifecycleStatus: 'ACTIVE',
      legacyOpenClawMigrationStatus: { not: 'PENDING' },
    },
    data: { lifecycleStatus: 'DELETING', deletionStartedAt: new Date() },
  });
  if (updated.count !== 1) {
    throw new ProjectIdentityLifecycleError('Project lifecycle changed before orphan deletion admission could close');
  }
  const deleting = await database.projectIdentity.findUnique({ where: { id: identity.id } });
  if (!deleting || deleting.lifecycleStatus !== 'DELETING') {
    throw new ProjectIdentityLifecycleError('Orphaned Project deletion admission barrier could not be verified');
  }
  return deleting;
}

export interface ProjectIdentityRenameGrant {
  identity: ProjectIdentityRecord;
  leaseToken: string;
  /** True only when claiming an expired journal from an earlier process. */
  resumed: boolean;
}

export async function beginProjectIdentityRename(input: {
  workspaceOwnerId: string;
  oldProjectName: string;
  newProjectName: string;
  oldProjectRoot: string;
  newProjectRoot: string;
  deployRootIdentity?: AttestedDirectoryIdentity | null;
  leaseDurationMs?: number;
  now?: Date;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRenameGrant> {
  const workspaceOwnerId = requireWorkspaceOwnerId(input.workspaceOwnerId);
  const oldProjectName = requireProjectName(input.oldProjectName);
  const newProjectName = requireProjectName(input.newProjectName);
  if (oldProjectName === newProjectName) {
    throw new ProjectIdentityLifecycleError('Project rename target must differ from its current name');
  }
  const oldRoot = attestProjectRoot(input.oldProjectRoot);
  let existing = await database.projectIdentity.findUnique({
    where: { workspaceOwnerId_projectName: { workspaceOwnerId, projectName: oldProjectName } },
  });
  if (!existing) {
    try {
      existing = await database.projectIdentity.create({
        data: {
          id: crypto.randomUUID(),
          workspaceOwnerId,
          projectName: oldProjectName,
          canonicalRoot: oldRoot.canonicalRoot,
          rootDevice: oldRoot.rootDevice,
          rootInode: oldRoot.rootInode,
          rootBirthtimeNs: oldRoot.rootBirthtimeNs,
          generation: 1,
          lifecycleStatus: 'ACTIVE',
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      existing = await database.projectIdentity.findUnique({
        where: { workspaceOwnerId_projectName: { workspaceOwnerId, projectName: oldProjectName } },
      });
    }
  }
  if (existing?.lifecycleStatus === PROJECT_IDENTITY_RENAMING) {
    assertIdentityMatchesRoot(existing, oldRoot);
    readProjectIdentityRenameDeployIdentity(existing);
    if (existing.renameTargetName !== newProjectName) {
      throw new ProjectIdentityLifecycleError('A different Project rename is already pending');
    }
    const now = input.now || new Date();
    if (!(existing.renameLeaseExpiresAt instanceof Date)
      || existing.renameLeaseExpiresAt.getTime() > now.getTime()) {
      throw new ProjectIdentityLifecycleError('Project rename is still in progress');
    }
    const expectedTarget = expectedRenameTargetRoot(existing, newProjectName);
    if (path.resolve(input.newProjectRoot) !== expectedTarget || pathExists(expectedTarget)) {
      throw new ProjectIdentityLifecycleError('Interrupted Project rename target is no longer available');
    }
    const leaseToken = crypto.randomBytes(32).toString('base64url');
    const previousLeaseTokenHash = existing.renameLeaseTokenHash;
    const leaseTokenHash = renameLeaseDigest(leaseToken);
    const resumed = await database.projectIdentity.updateMany({
      where: {
        id: existing.id,
        lifecycleStatus: PROJECT_IDENTITY_RENAMING,
        renameLeaseTokenHash: previousLeaseTokenHash,
        renameLeaseExpiresAt: { lte: now },
      },
      data: {
        renameLeaseTokenHash: leaseTokenHash,
        renameLeaseExpiresAt: new Date(now.getTime() + renameLeaseDuration(input.leaseDurationMs)),
      },
    });
    if (resumed.count !== 1) {
      throw new ProjectIdentityLifecycleError('Interrupted Project rename was claimed by another request');
    }
    const identity = await database.projectIdentity.findUnique({ where: { id: existing.id } });
    if (!identity || identity.renameLeaseTokenHash !== leaseTokenHash) {
      throw new ProjectIdentityLifecycleError('Interrupted Project rename lease could not be verified');
    }
    return { identity, leaseToken, resumed: true };
  }
  if (!existing) throw new ProjectIdentityMismatchError('Server-owned project identity is missing during rename');
  assertIdentityMatchesRoot(existing, oldRoot);
  assertIdentityActive(existing);
  if (existing.legacyOpenClawMigrationStatus === 'PENDING') {
    throw new ProjectIdentityLifecycleError('Project rename is blocked by legacy history reconciliation');
  }
  const expectedTarget = expectedRenameTargetRoot(existing, newProjectName);
  if (path.resolve(input.newProjectRoot) !== expectedTarget) {
    throw new ProjectIdentityMismatchError('Renamed project target escaped its workspace');
  }
  if (pathExists(expectedTarget)) {
    throw new ProjectIdentityLifecycleError('Project rename target already exists');
  }
  const conflicting = await database.projectIdentity.findUnique({
    where: { workspaceOwnerId_projectName: { workspaceOwnerId, projectName: newProjectName } },
  });
  if (conflicting && conflicting.id !== existing.id) {
    throw new ProjectIdentityLifecycleError('Project rename target already has a server-owned identity');
  }
  const now = input.now || new Date();
  const leaseToken = crypto.randomBytes(32).toString('base64url');
  const leaseTokenHash = renameLeaseDigest(leaseToken);
  const updated = await database.projectIdentity.updateMany({
    where: {
      id: existing.id,
      lifecycleStatus: 'ACTIVE',
      legacyOpenClawMigrationStatus: { not: 'PENDING' },
    },
    data: {
      lifecycleStatus: PROJECT_IDENTITY_RENAMING,
      renameTargetName: newProjectName,
      renameLeaseTokenHash: leaseTokenHash,
      renameLeaseExpiresAt: new Date(now.getTime() + renameLeaseDuration(input.leaseDurationMs)),
      renameStartedAt: now,
      renameCleanupStartedAt: null,
      renameRuntimeCleanedAt: null,
      renameDeployPresent: input.deployRootIdentity != null,
      renameDeployDevice: input.deployRootIdentity?.rootDevice || null,
      renameDeployInode: input.deployRootIdentity?.rootInode || null,
      renameDeployBirthtimeNs: input.deployRootIdentity?.rootBirthtimeNs || null,
    },
  });
  if (updated.count !== 1) {
    throw new ProjectIdentityLifecycleError('Project lifecycle changed before rename admission could close');
  }
  const renaming = await database.projectIdentity.findUnique({ where: { id: existing.id } });
  if (
    !renaming
    || renaming.lifecycleStatus !== PROJECT_IDENTITY_RENAMING
    || renaming.renameTargetName !== newProjectName
    || renaming.renameLeaseTokenHash !== leaseTokenHash
  ) {
    throw new ProjectIdentityLifecycleError('Project rename admission barrier could not be verified');
  }
  assertIdentityMatchesRoot(renaming, oldRoot);
  return { identity: renaming, leaseToken, resumed: false };
}

/**
 * Reopens admission only for a rename barrier created by this request before
 * any provider, Portal workload, deployment, or filesystem mutation began.
 * An expired/resumed journal can represent a crash after an external cleanup
 * side effect but before its marker, so callers must never use this helper for
 * a resumed grant.
 */
export async function abandonProjectIdentityRenameBeforeCleanup(input: {
  projectIdentityId: string;
  leaseToken: string;
  oldProjectRoot: string;
  now?: Date;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord> {
  const id = String(input.projectIdentityId || '').trim();
  if (!id) throw new ProjectIdentityLifecycleError('Project rename identity is required');
  const now = input.now || new Date();
  const leaseTokenHash = renameLeaseDigest(input.leaseToken);
  const existing = await database.projectIdentity.findUnique({ where: { id } });
  if (
    !existing
    || existing.lifecycleStatus !== PROJECT_IDENTITY_RENAMING
    || existing.renameLeaseTokenHash !== leaseTokenHash
    || !(existing.renameLeaseExpiresAt instanceof Date)
    || existing.renameLeaseExpiresAt.getTime() <= now.getTime()
    || existing.renameCleanupStartedAt != null
    || existing.renameRuntimeCleanedAt != null
  ) {
    throw new ProjectIdentityLifecycleError(
      'Project rename admission cannot be reopened after cleanup may have started',
    );
  }
  const oldRoot = attestProjectRoot(input.oldProjectRoot);
  assertIdentityMatchesRoot(existing, oldRoot);
  const targetRoot = expectedRenameTargetRoot(existing, requireProjectName(existing.renameTargetName || ''));
  if (pathExists(targetRoot)) {
    throw new ProjectIdentityLifecycleError('Project rename target exists; admission cannot be reopened');
  }
  const updated = await database.projectIdentity.updateMany({
    where: {
      id,
      lifecycleStatus: PROJECT_IDENTITY_RENAMING,
      renameLeaseTokenHash: leaseTokenHash,
      renameLeaseExpiresAt: { gt: now },
      renameCleanupStartedAt: null,
      renameRuntimeCleanedAt: null,
    },
    data: {
      lifecycleStatus: 'ACTIVE',
      renameTargetName: null,
      renameLeaseTokenHash: null,
      renameLeaseExpiresAt: null,
      renameStartedAt: null,
      renameCleanupStartedAt: null,
      renameRuntimeCleanedAt: null,
      renameDeployPresent: null,
      renameDeployDevice: null,
      renameDeployInode: null,
      renameDeployBirthtimeNs: null,
    },
  });
  if (updated.count !== 1) {
    throw new ProjectIdentityLifecycleError('Project rename cleanup started before admission could reopen');
  }
  const active = await database.projectIdentity.findUnique({ where: { id } });
  if (!active || active.lifecycleStatus !== 'ACTIVE') {
    throw new ProjectIdentityLifecycleError('Project rename admission could not be reopened');
  }
  assertIdentityMatchesRoot(active, oldRoot);
  return active;
}

/** Records the point after which external provider/workload mutation may occur. */
export async function markProjectIdentityRenameCleanupStarted(input: {
  projectIdentityId: string;
  leaseToken: string;
  startedAt?: Date;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord> {
  const id = String(input.projectIdentityId || '').trim();
  if (!id) throw new ProjectIdentityLifecycleError('Project rename identity is required');
  const startedAt = input.startedAt || new Date();
  const leaseTokenHash = renameLeaseDigest(input.leaseToken);
  const updated = await database.projectIdentity.updateMany({
    where: {
      id,
      lifecycleStatus: PROJECT_IDENTITY_RENAMING,
      renameLeaseTokenHash: leaseTokenHash,
      renameLeaseExpiresAt: { gt: startedAt },
      renameCleanupStartedAt: null,
    },
    data: { renameCleanupStartedAt: startedAt },
  });
  if (updated.count !== 1) {
    const current = await database.projectIdentity.findUnique({ where: { id } });
    if (
      !current
      || current.lifecycleStatus !== PROJECT_IDENTITY_RENAMING
      || current.renameLeaseTokenHash !== leaseTokenHash
      || !(current.renameLeaseExpiresAt instanceof Date)
      || current.renameLeaseExpiresAt.getTime() <= startedAt.getTime()
      || !(current.renameCleanupStartedAt instanceof Date)
    ) {
      throw new ProjectIdentityLifecycleError('Project rename cleanup start could not be recorded');
    }
    return current;
  }
  const marked = await database.projectIdentity.findUnique({ where: { id } });
  if (
    !marked
    || marked.lifecycleStatus !== PROJECT_IDENTITY_RENAMING
    || marked.renameLeaseTokenHash !== leaseTokenHash
    || !(marked.renameCleanupStartedAt instanceof Date)
  ) {
    throw new ProjectIdentityLifecycleError('Project rename cleanup start could not be verified');
  }
  return marked;
}

export async function markProjectIdentityRenameRuntimeCleaned(input: {
  projectIdentityId: string;
  leaseToken: string;
  cleanedAt?: Date;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord> {
  const id = String(input.projectIdentityId || '').trim();
  if (!id) throw new ProjectIdentityLifecycleError('Project rename identity is required');
  const leaseTokenHash = renameLeaseDigest(input.leaseToken);
  const cleanedAt = input.cleanedAt || new Date();
  const current = await database.projectIdentity.findUnique({ where: { id } });
  if (
    !current
    || current.lifecycleStatus !== PROJECT_IDENTITY_RENAMING
    || current.renameLeaseTokenHash !== leaseTokenHash
    || !(current.renameLeaseExpiresAt instanceof Date)
    || current.renameLeaseExpiresAt.getTime() <= cleanedAt.getTime()
    || !(current.renameCleanupStartedAt instanceof Date)
  ) {
    throw new ProjectIdentityLifecycleError(
      'Project rename runtime cleanup cannot finish before its start is durably recorded',
    );
  }
  const updated = await database.projectIdentity.updateMany({
    where: {
      id,
      lifecycleStatus: PROJECT_IDENTITY_RENAMING,
      renameLeaseTokenHash: leaseTokenHash,
      renameLeaseExpiresAt: { gt: cleanedAt },
      renameCleanupStartedAt: current.renameCleanupStartedAt,
    },
    data: { renameRuntimeCleanedAt: cleanedAt },
  });
  if (updated.count !== 1) {
    throw new ProjectIdentityLifecycleError('Project rename runtime cleanup marker changed concurrently');
  }
  const marked = await database.projectIdentity.findUnique({ where: { id } });
  if (
    !marked
    || marked.lifecycleStatus !== PROJECT_IDENTITY_RENAMING
    || marked.renameLeaseTokenHash !== leaseTokenHash
    || !(marked.renameLeaseExpiresAt instanceof Date)
    || marked.renameLeaseExpiresAt.getTime() <= cleanedAt.getTime()
    || !(marked.renameRuntimeCleanedAt instanceof Date)
  ) {
    throw new ProjectIdentityLifecycleError('Project rename runtime cleanup marker could not be verified');
  }
  return marked;
}

export async function renewProjectIdentityRenameLease(input: {
  projectIdentityId: string;
  leaseToken: string;
  leaseDurationMs?: number;
  now?: Date;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord> {
  const id = String(input.projectIdentityId || '').trim();
  if (!id) throw new ProjectIdentityLifecycleError('Project rename identity is required');
  const now = input.now || new Date();
  const leaseTokenHash = renameLeaseDigest(input.leaseToken);
  const updated = await database.projectIdentity.updateMany({
    where: {
      id,
      lifecycleStatus: PROJECT_IDENTITY_RENAMING,
      renameLeaseTokenHash: leaseTokenHash,
      renameLeaseExpiresAt: { gt: now },
    },
    data: {
      renameLeaseExpiresAt: new Date(now.getTime() + renameLeaseDuration(input.leaseDurationMs)),
    },
  });
  if (updated.count !== 1) {
    throw new ProjectIdentityLifecycleError('Project rename lease expired or changed');
  }
  const renewed = await database.projectIdentity.findUnique({ where: { id } });
  if (!renewed || renewed.lifecycleStatus !== PROJECT_IDENTITY_RENAMING) {
    throw new ProjectIdentityLifecycleError('Project rename lease renewal could not be verified');
  }
  return renewed;
}

export async function renameProjectIdentity(input: {
  workspaceOwnerId: string;
  oldProjectName: string;
  newProjectName: string;
  newProjectRoot: string;
  leaseToken: string;
  now?: Date;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord> {
  const workspaceOwnerId = requireWorkspaceOwnerId(input.workspaceOwnerId);
  const oldProjectName = requireProjectName(input.oldProjectName);
  const newProjectName = requireProjectName(input.newProjectName);
  const now = input.now || new Date();
  const root = attestProjectRoot(input.newProjectRoot);
  const existing = await database.projectIdentity.findUnique({
    where: { workspaceOwnerId_projectName: { workspaceOwnerId, projectName: oldProjectName } },
  });
  if (!existing) throw new ProjectIdentityMismatchError('Server-owned project identity is missing during rename');
  readProjectIdentityRenameDeployIdentity(existing);
  if (
    existing.lifecycleStatus !== PROJECT_IDENTITY_RENAMING
    || existing.renameTargetName !== newProjectName
    || existing.renameLeaseTokenHash !== renameLeaseDigest(input.leaseToken)
    || !(existing.renameRuntimeCleanedAt instanceof Date)
    || !(existing.renameLeaseExpiresAt instanceof Date)
    || existing.renameLeaseExpiresAt.getTime() <= now.getTime()
  ) {
    throw new ProjectIdentityLifecycleError(
      'Project rename cleanup marker and live lease must match its durable admission barrier',
    );
  }
  if (root.canonicalRoot !== expectedRenameTargetRoot(existing, newProjectName)) {
    throw new ProjectIdentityMismatchError('Renamed project root does not match its admitted target');
  }
  assertSameRootIdentity(existing, root);
  const updated = await database.projectIdentity.updateMany({
    where: {
      id: existing.id,
      lifecycleStatus: PROJECT_IDENTITY_RENAMING,
      renameLeaseTokenHash: existing.renameLeaseTokenHash,
      renameRuntimeCleanedAt: existing.renameRuntimeCleanedAt,
      renameLeaseExpiresAt: { gt: now },
    },
    data: {
      projectName: newProjectName,
      canonicalRoot: root.canonicalRoot,
      rootDevice: root.rootDevice,
      rootInode: root.rootInode,
      rootBirthtimeNs: root.rootBirthtimeNs,
      generation: existing.generation + 1,
      lifecycleStatus: 'ACTIVE',
      renameTargetName: null,
      renameLeaseTokenHash: null,
      renameLeaseExpiresAt: null,
      renameStartedAt: null,
      renameCleanupStartedAt: null,
      renameRuntimeCleanedAt: null,
      renameDeployPresent: null,
      renameDeployDevice: null,
      renameDeployInode: null,
      renameDeployBirthtimeNs: null,
      lastRenameSourceName: oldProjectName,
      lastRenameCompletedAt: now,
    },
  });
  if (updated.count !== 1) throw new ProjectIdentityLifecycleError('Project rename changed before commit');
  const renamed = await database.projectIdentity.findUnique({ where: { id: existing.id } });
  if (!renamed || renamed.lifecycleStatus !== 'ACTIVE' || renamed.projectName !== newProjectName) {
    throw new ProjectIdentityLifecycleError('Project rename commit could not be verified');
  }
  assertIdentityMatchesRoot(renamed, root);
  return renamed;
}

export async function cancelProjectIdentityRename(input: {
  projectIdentityId: string;
  leaseToken: string;
  oldProjectRoot: string;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord> {
  const id = String(input.projectIdentityId || '').trim();
  const existing = await database.projectIdentity.findUnique({ where: { id } });
  if (!existing) throw new ProjectIdentityMismatchError('Server-owned project identity is missing during rename rollback');
  readProjectIdentityRenameDeployIdentity(existing);
  if (
    existing.lifecycleStatus !== PROJECT_IDENTITY_RENAMING
    || existing.renameLeaseTokenHash !== renameLeaseDigest(input.leaseToken)
    || !(existing.renameRuntimeCleanedAt instanceof Date)
  ) {
    throw new ProjectIdentityLifecycleError('Project rename rollback cleanup marker and lease no longer match');
  }
  const oldRoot = attestProjectRoot(input.oldProjectRoot);
  assertIdentityMatchesRoot(existing, oldRoot);
  const targetRoot = expectedRenameTargetRoot(existing, requireProjectName(existing.renameTargetName || ''));
  if (pathExists(targetRoot)) {
    throw new ProjectIdentityLifecycleError('Project rename target still exists; rollback is not safe');
  }
  return persistRecoveredRename(existing, 'cancel', database);
}

export async function deleteProjectIdentity(input: {
  workspaceOwnerId: string;
  projectName: string;
}, database: ProjectIdentityDatabase = defaultDatabase): Promise<ProjectIdentityRecord | null> {
  const workspaceOwnerId = requireWorkspaceOwnerId(input.workspaceOwnerId);
  const projectName = requireProjectName(input.projectName);
  const existing = await database.projectIdentity.findUnique({
    where: { workspaceOwnerId_projectName: { workspaceOwnerId, projectName } },
  });
  if (!existing) return null;
  if ((existing.lifecycleStatus || 'ACTIVE') !== 'DELETING') {
    throw new ProjectIdentityLifecycleError('Project identity can only be removed after runtime cleanup begins');
  }
  return database.projectIdentity.delete({ where: { id: existing.id } });
}

export function assertProjectIdentityRoot(identity: ProjectIdentityRecord, projectRoot: string): AttestedProjectRoot {
  const root = attestProjectRoot(projectRoot);
  assertIdentityMatchesRoot(identity, root);
  return root;
}
