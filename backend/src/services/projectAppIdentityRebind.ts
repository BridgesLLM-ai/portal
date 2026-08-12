import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { prisma } from '../config/database';
import {
  withStoppedProjectAppRuntimeLocks,
} from './app-process.service';
import {
  fingerprintFullstackDeploymentTree,
  prepareFullstackDeploymentTree,
} from './project-lifecycle.service';
import {
  attestProjectRoot,
  moveAttestedDirectoryNoReplace,
  type ProjectIdentityRecord,
} from './projectIdentity';
import { projectRuntimeManagement } from './projectRuntimeManagement';

type RebindApp = Readonly<{
  id: string;
  userId: string;
  projectIdentityId: string | null;
  name: string;
  zipPath: string;
  deployType: string;
  processStatus: string;
  updatedAt: Date;
}>;

interface ProjectAppRebindStore {
  projectIdentity: {
    findUnique(args: unknown): Promise<ProjectIdentityRecord | null>;
  };
  app: {
    findMany(args: unknown): Promise<RebindApp[]>;
    findUnique(args: unknown): Promise<RebindApp | null>;
    count(args: unknown): Promise<number>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  appShareLink: {
    findMany(args: unknown): Promise<Array<{ id: string; token: string }>>;
  };
}

interface ProjectAppRebindDatabase extends ProjectAppRebindStore {
  $transaction<T>(
    callback: (transaction: ProjectAppRebindStore) => Promise<T>,
    options?: { isolationLevel?: 'Serializable'; maxWait?: number; timeout?: number },
  ): Promise<T>;
}

export type ProjectAppRebindManifest = Readonly<{
  fileCount: number;
  totalBytes: number;
  sha256: string;
}>;

const JOURNAL_VERSION = 1;
const JOURNAL_MAX_BYTES = 64 * 1024;
const JOURNAL_STAGES = [
  'TARGET_RESERVED',
  'TARGET_PROJECT_READY',
  'DEPLOYMENT_COPYING',
  'DEPLOYMENT_PREPARED',
  'DEPLOYMENT_PROMOTE_PENDING',
  'DEPLOYMENT_PROMOTED',
  'APP_COMMIT_PENDING',
  'APP_COMMITTED',
  'COMPLETED',
] as const;
type ProjectAppRebindStage = typeof JOURNAL_STAGES[number];

export type ProjectAppRebindOperation = Readonly<{
  version: 1;
  operationId: string;
  operationKind: 'PROJECT_COPY' | 'PROJECT_APP_REBIND';
  stage: ProjectAppRebindStage;
  workspaceOwnerId: string;
  appId: string | null;
  sourceProjectIdentityId: string;
  sourceProjectName: string;
  sourceAppName: string;
  sourceProjectRoot: string;
  sourceDeployPath: string;
  targetProjectIdentityId: string | null;
  targetProjectName: string;
  targetProjectRoot: string;
  targetDeployPath: string;
  projectManifest: ProjectAppRebindManifest | null;
  sourceDigest: string | null;
  stagingIdentity: Readonly<{
    rootDevice: string;
    rootInode: string;
    rootBirthtimeNs: string;
  }> | null;
  shareLinksPreserved: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}>;

export type ProjectAppRebindOperationInput = Readonly<{
  workspaceOwnerId: string;
  appId: string;
  sourceProjectIdentityId: string;
  sourceProjectName: string;
  sourceAppName: string;
  sourceProjectRoot: string;
  sourceDeployPath: string;
  targetProjectIdentityId?: string | null;
  targetProjectName: string;
  targetProjectRoot: string;
  targetDeployPath: string;
}>;

export class ProjectAppIdentityRebindError extends Error {
  readonly code = 'PROJECT_APP_REBIND_REJECTED';
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'ProjectAppIdentityRebindError';
  }
}

function fail(message: string): never {
  throw new ProjectAppIdentityRebindError(message);
}

function expectedOwnerUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

function expectedOwnerGid(): number {
  return typeof process.getgid === 'function' ? process.getgid() : 0;
}

function journalRoot(explicit?: string): string {
  const configured = explicit
    || process.env.PORTAL_PROJECT_APP_REBIND_ROOT
    // This journal is recovery-critical state and must travel with the
    // Portal .data component in comprehensive backups/restores.
    || path.join(process.env.PORTAL_ROOT || '/opt/bridgesllm/portal', '.data', 'project-app-rebind');
  const normalized = path.resolve(configured);
  if (!path.isAbsolute(configured) || normalized !== configured || normalized === path.parse(normalized).root) {
    fail('The Project App rebind journal root is unsafe.');
  }
  fs.mkdirSync(normalized, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(normalized);
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || stat.uid !== expectedOwnerUid()
    || stat.gid !== expectedOwnerGid()
    || (stat.mode & 0o077) !== 0
    || fs.realpathSync.native(normalized) !== normalized
  ) fail('The Project App rebind journal root is unsafe.');
  return normalized;
}

function journalFile(sourceProjectIdentityId: string, explicitRoot?: string): string {
  if (
    !sourceProjectIdentityId
    || sourceProjectIdentityId.length > 160
    || /[\u0000-\u001f\u007f]/.test(sourceProjectIdentityId)
  ) fail('The source Project identity is invalid for App rebind recovery.');
  const digest = crypto.createHash('sha256').update(sourceProjectIdentityId, 'utf8').digest('hex');
  return path.join(journalRoot(explicitRoot), `${digest}.json`);
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function atomicWriteJournal(file: string, journal: ProjectAppRebindOperation, createOnly = false): void {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY
      | fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(journal)}\n`, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    if (createOnly) {
      fs.linkSync(temporary, file);
      fsyncDirectory(directory);
      try {
        fs.unlinkSync(temporary);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
    } else {
      fs.renameSync(temporary, file);
    }
    fsyncDirectory(directory);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function recoverCreateOnlyJournalLink(
  file: string,
  before: fs.BigIntStats,
): fs.BigIntStats {
  if (before.nlink === 1n) return before;
  if (before.nlink !== 2n) fail('The Project App rebind journal is unsafe.');
  const directory = path.dirname(file);
  const prefix = `.${path.basename(file)}.`;
  const candidates = fs.readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
    .map((name) => {
      const candidate = path.join(directory, name);
      return { candidate, stat: fs.lstatSync(candidate, { bigint: true }) };
    });
  const linked = candidates.filter(({ stat }) => stat.dev === before.dev && stat.ino === before.ino);
  if (linked.length !== 1) fail('The Project App rebind journal publication is ambiguous.');
  const { candidate: temporary, stat: temporaryStat } = linked[0];
  if (
    temporaryStat.isSymbolicLink()
    || !temporaryStat.isFile()
    || temporaryStat.dev !== before.dev
    || temporaryStat.ino !== before.ino
    || temporaryStat.uid !== before.uid
    || temporaryStat.gid !== before.gid
    || temporaryStat.mode !== before.mode
    || temporaryStat.size !== before.size
    || temporaryStat.nlink !== 2n
  ) fail('The Project App rebind journal publication is unsafe.');
  fs.unlinkSync(temporary);
  fsyncDirectory(directory);
  const recovered = fs.lstatSync(file, { bigint: true });
  if (recovered.dev !== before.dev || recovered.ino !== before.ino || recovered.nlink !== 1n) {
    fail('The Project App rebind journal publication did not converge.');
  }
  return recovered;
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validAbsolutePath(value: unknown): value is string {
  return validText(value, 4096) && path.isAbsolute(value) && path.resolve(value) === value;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validManifest(value: unknown): value is ProjectAppRebindManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return Object.keys(manifest).sort().join(',') === 'fileCount,sha256,totalBytes'
    && Number.isSafeInteger(manifest.fileCount)
    && Number(manifest.fileCount) >= 0
    && Number.isSafeInteger(manifest.totalBytes)
    && Number(manifest.totalBytes) >= 0
    && typeof manifest.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(manifest.sha256);
}

function validStagingIdentity(value: unknown): value is NonNullable<ProjectAppRebindOperation['stagingIdentity']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return Object.keys(identity).sort().join(',') === 'rootBirthtimeNs,rootDevice,rootInode'
    && ['rootBirthtimeNs', 'rootDevice', 'rootInode'].every((key) => (
      typeof identity[key] === 'string' && /^\d{1,32}$/.test(identity[key] as string)
    ));
}

function validateJournal(value: unknown, expectedSourceProjectIdentityId: string): ProjectAppRebindOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('The Project App rebind journal is invalid.');
  const journal = value as Record<string, unknown>;
  const expectedKeys = [
    'appId', 'completedAt', 'createdAt', 'operationId', 'operationKind', 'projectManifest',
    'shareLinksPreserved', 'sourceAppName', 'sourceDeployPath', 'sourceDigest',
    'sourceProjectIdentityId', 'sourceProjectName', 'sourceProjectRoot', 'stage',
    'stagingIdentity', 'targetDeployPath', 'targetProjectIdentityId',
    'targetProjectName', 'targetProjectRoot', 'updatedAt', 'version', 'workspaceOwnerId',
  ].sort();
  if (
    Object.keys(journal).sort().join(',') !== expectedKeys.join(',')
    || journal.version !== JOURNAL_VERSION
    || !validText(journal.operationId, 128)
    || !/^[a-f0-9]{32}$/.test(journal.operationId as string)
    || !['PROJECT_COPY', 'PROJECT_APP_REBIND'].includes(String(journal.operationKind))
    || !JOURNAL_STAGES.includes(journal.stage as ProjectAppRebindStage)
    || !validText(journal.workspaceOwnerId, 160)
    || (journal.operationKind === 'PROJECT_APP_REBIND' && !validText(journal.appId, 160))
    || (journal.operationKind === 'PROJECT_COPY' && journal.appId !== null)
    || journal.sourceProjectIdentityId !== expectedSourceProjectIdentityId
    || !validText(journal.sourceProjectName, 160)
    || !validText(journal.sourceAppName, 160)
    || !validAbsolutePath(journal.sourceProjectRoot)
    || !validAbsolutePath(journal.sourceDeployPath)
    || (journal.targetProjectIdentityId !== null && !validText(journal.targetProjectIdentityId, 160))
    || !validText(journal.targetProjectName, 160)
    || !validAbsolutePath(journal.targetProjectRoot)
    || !validAbsolutePath(journal.targetDeployPath)
    || (journal.projectManifest !== null && !validManifest(journal.projectManifest))
    || (journal.sourceDigest !== null
      && (typeof journal.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(journal.sourceDigest)))
    || (journal.stagingIdentity !== null && !validStagingIdentity(journal.stagingIdentity))
    || (journal.shareLinksPreserved !== null
      && (!Number.isSafeInteger(journal.shareLinksPreserved)
        || Number(journal.shareLinksPreserved) < 0
        || Number(journal.shareLinksPreserved) > 10_000))
    || !validTimestamp(journal.createdAt)
    || !validTimestamp(journal.updatedAt)
    || (journal.completedAt !== null && !validTimestamp(journal.completedAt))
  ) fail('The Project App rebind journal is invalid.');
  if (
    (journal.stage === 'TARGET_RESERVED' && journal.targetProjectIdentityId !== null)
    || (JOURNAL_STAGES.indexOf(journal.stage as ProjectAppRebindStage) >= JOURNAL_STAGES.indexOf('TARGET_PROJECT_READY')
      && journal.targetProjectIdentityId === null)
    || (JOURNAL_STAGES.indexOf(journal.stage as ProjectAppRebindStage) >= JOURNAL_STAGES.indexOf('DEPLOYMENT_PREPARED')
      && (journal.sourceDigest === null || journal.stagingIdentity === null))
    || (journal.stage === 'COMPLETED'
      && (journal.completedAt === null || journal.shareLinksPreserved === null))
  ) fail('The Project App rebind journal stage is incomplete.');
  return Object.freeze(journal as unknown as ProjectAppRebindOperation);
}

function readJournal(sourceProjectIdentityId: string, explicitRoot?: string): ProjectAppRebindOperation | null {
  const file = journalFile(sourceProjectIdentityId, explicitRoot);
  let descriptor = -1;
  try {
    let before = fs.lstatSync(file, { bigint: true });
    before = recoverCreateOnlyJournalLink(file, before);
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || before.uid !== BigInt(expectedOwnerUid())
      || before.gid !== BigInt(expectedOwnerGid())
      || before.nlink !== 1n
      || (before.mode & 0o777n) !== 0o600n
      || before.size < 1n
      || before.size > BigInt(JOURNAL_MAX_BYTES)
    ) fail('The Project App rebind journal is unsafe.');
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      fail('The Project App rebind journal changed before it could be read.');
    }
    const raw = fs.readFileSync(descriptor, 'utf8');
    const after = fs.lstatSync(file, { bigint: true });
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
    ) fail('The Project App rebind journal changed while it was read.');
    return validateJournal(JSON.parse(raw), sourceProjectIdentityId);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof ProjectAppIdentityRebindError) throw error;
    return fail('The Project App rebind journal could not be authenticated.');
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function immutableOperationMatches(
  journal: ProjectAppRebindOperation,
  input: ProjectAppRebindOperationInput,
): boolean {
  return journal.operationKind === 'PROJECT_APP_REBIND'
    && journal.workspaceOwnerId === input.workspaceOwnerId
    && journal.appId === input.appId
    && journal.sourceProjectIdentityId === input.sourceProjectIdentityId
    && journal.sourceProjectName === input.sourceProjectName
    && journal.sourceAppName === input.sourceAppName
    && journal.sourceProjectRoot === input.sourceProjectRoot
    && journal.sourceDeployPath === input.sourceDeployPath
    && journal.targetProjectName === input.targetProjectName
    && journal.targetProjectRoot === input.targetProjectRoot
    && journal.targetDeployPath === input.targetDeployPath
    && (
      input.targetProjectIdentityId === undefined
      || input.targetProjectIdentityId === null
      || journal.targetProjectIdentityId === null
      || journal.targetProjectIdentityId === input.targetProjectIdentityId
    );
}

function updateJournal(
  journal: ProjectAppRebindOperation,
  patch: Partial<ProjectAppRebindOperation>,
  explicitRoot?: string,
): ProjectAppRebindOperation {
  const next = validateJournal({
    ...journal,
    ...patch,
    version: JOURNAL_VERSION,
    operationId: journal.operationId,
    sourceProjectIdentityId: journal.sourceProjectIdentityId,
    createdAt: journal.createdAt,
    updatedAt: new Date().toISOString(),
  }, journal.sourceProjectIdentityId);
  if (JOURNAL_STAGES.indexOf(next.stage) < JOURNAL_STAGES.indexOf(journal.stage)) {
    fail('The Project App rebind journal cannot move backwards.');
  }
  atomicWriteJournal(journalFile(journal.sourceProjectIdentityId, explicitRoot), next);
  return next;
}

export function readProjectAppRebindOperation(input: {
  workspaceOwnerId: string;
  sourceProjectIdentityId: string;
  sourceProjectName: string;
  sourceProjectRoot: string;
}, options: { journalRoot?: string } = {}): ProjectAppRebindOperation | null {
  const journal = readJournal(input.sourceProjectIdentityId, options.journalRoot);
  if (!journal) return null;
  if (
    journal.workspaceOwnerId !== input.workspaceOwnerId
    || journal.sourceProjectName !== input.sourceProjectName
    || journal.sourceProjectRoot !== input.sourceProjectRoot
  ) fail('A Project App rebind journal did not match this source Project.');
  return journal;
}

export function beginProjectAppRebindOperation(
  input: ProjectAppRebindOperationInput,
  options: { journalRoot?: string } = {},
): ProjectAppRebindOperation {
  const existing = readJournal(input.sourceProjectIdentityId, options.journalRoot);
  if (existing) {
    if (!immutableOperationMatches(existing, input)) {
      fail('Another durable App rebind operation already owns this source Project.');
    }
    if (
      input.targetProjectIdentityId
      && existing.targetProjectIdentityId === null
    ) {
      return updateJournal(existing, {
        targetProjectIdentityId: input.targetProjectIdentityId,
        stage: 'TARGET_PROJECT_READY',
      }, options.journalRoot);
    }
    return existing;
  }
  const now = new Date().toISOString();
  const journal = validateJournal({
    version: JOURNAL_VERSION,
    operationId: crypto.randomBytes(16).toString('hex'),
    operationKind: 'PROJECT_APP_REBIND',
    stage: input.targetProjectIdentityId ? 'TARGET_PROJECT_READY' : 'TARGET_RESERVED',
    workspaceOwnerId: input.workspaceOwnerId,
    appId: input.appId,
    sourceProjectIdentityId: input.sourceProjectIdentityId,
    sourceProjectName: input.sourceProjectName,
    sourceAppName: input.sourceAppName,
    sourceProjectRoot: input.sourceProjectRoot,
    sourceDeployPath: input.sourceDeployPath,
    targetProjectIdentityId: input.targetProjectIdentityId || null,
    targetProjectName: input.targetProjectName,
    targetProjectRoot: input.targetProjectRoot,
    targetDeployPath: input.targetDeployPath,
    projectManifest: null,
    sourceDigest: null,
    stagingIdentity: null,
    shareLinksPreserved: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  }, input.sourceProjectIdentityId);
  try {
    atomicWriteJournal(journalFile(input.sourceProjectIdentityId, options.journalRoot), journal, true);
    return journal;
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const raced = readJournal(input.sourceProjectIdentityId, options.journalRoot);
    if (!raced || !immutableOperationMatches(raced, input)) {
      fail('Another durable App rebind operation won admission for this source Project.');
    }
    return raced;
  }
}

export function beginProjectCopyOperation(input: Omit<
  ProjectAppRebindOperationInput,
  'appId' | 'sourceAppName' | 'targetProjectIdentityId'
>, options: { journalRoot?: string } = {}): ProjectAppRebindOperation {
  const existing = readJournal(input.sourceProjectIdentityId, options.journalRoot);
  if (existing) {
    const matches = existing.operationKind === 'PROJECT_COPY'
      && existing.workspaceOwnerId === input.workspaceOwnerId
      && existing.sourceProjectIdentityId === input.sourceProjectIdentityId
      && existing.sourceProjectName === input.sourceProjectName
      && existing.sourceProjectRoot === input.sourceProjectRoot
      && existing.sourceDeployPath === input.sourceDeployPath
      && existing.targetProjectName === input.targetProjectName
      && existing.targetProjectRoot === input.targetProjectRoot
      && existing.targetDeployPath === input.targetDeployPath;
    if (!matches) fail('Another durable Project migration operation already owns this source Project.');
    return existing;
  }
  const now = new Date().toISOString();
  const journal = validateJournal({
    version: JOURNAL_VERSION,
    operationId: crypto.randomBytes(16).toString('hex'),
    operationKind: 'PROJECT_COPY',
    stage: 'TARGET_RESERVED',
    workspaceOwnerId: input.workspaceOwnerId,
    appId: null,
    sourceProjectIdentityId: input.sourceProjectIdentityId,
    sourceProjectName: input.sourceProjectName,
    sourceAppName: input.sourceProjectName,
    sourceProjectRoot: input.sourceProjectRoot,
    sourceDeployPath: input.sourceDeployPath,
    targetProjectIdentityId: null,
    targetProjectName: input.targetProjectName,
    targetProjectRoot: input.targetProjectRoot,
    targetDeployPath: input.targetDeployPath,
    projectManifest: null,
    sourceDigest: null,
    stagingIdentity: null,
    shareLinksPreserved: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  }, input.sourceProjectIdentityId);
  try {
    atomicWriteJournal(journalFile(input.sourceProjectIdentityId, options.journalRoot), journal, true);
    return journal;
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const raced = readJournal(input.sourceProjectIdentityId, options.journalRoot);
    if (!raced || raced.operationKind !== 'PROJECT_COPY') {
      fail('Another durable Project migration operation won admission for this source Project.');
    }
    return beginProjectCopyOperation(input, options);
  }
}

export function recordProjectAppRebindManifest(input: {
  sourceProjectIdentityId: string;
  manifest: ProjectAppRebindManifest;
}, options: { journalRoot?: string } = {}): ProjectAppRebindOperation {
  if (!validManifest(input.manifest)) fail('The Project App rebind copy manifest is invalid.');
  const journal = readJournal(input.sourceProjectIdentityId, options.journalRoot);
  if (!journal) fail('The Project App rebind journal is unavailable.');
  if (journal.projectManifest && JSON.stringify(journal.projectManifest) !== JSON.stringify(input.manifest)) {
    fail('The Project App rebind copy manifest changed after admission.');
  }
  if (journal.projectManifest) return journal;
  return updateJournal(journal, { projectManifest: Object.freeze({ ...input.manifest }) }, options.journalRoot);
}

export function bindProjectAppRebindTarget(input: {
  sourceProjectIdentityId: string;
  targetProjectIdentityId: string;
}, options: { journalRoot?: string } = {}): ProjectAppRebindOperation {
  if (!validText(input.targetProjectIdentityId, 160)) fail('The target Project identity is invalid.');
  const journal = readJournal(input.sourceProjectIdentityId, options.journalRoot);
  if (!journal) fail('The Project App rebind journal is unavailable.');
  if (
    journal.targetProjectIdentityId !== null
    && journal.targetProjectIdentityId !== input.targetProjectIdentityId
  ) fail('The Project App rebind target identity changed after admission.');
  if (journal.targetProjectIdentityId === input.targetProjectIdentityId) return journal;
  return updateJournal(journal, {
    targetProjectIdentityId: input.targetProjectIdentityId,
    stage: 'TARGET_PROJECT_READY',
  }, options.journalRoot);
}

export function assertProjectMigrationTargetOwnedByOperation(
  journal: ProjectAppRebindOperation,
  targetIdentity: Pick<ProjectIdentityRecord, 'id' | 'workspaceOwnerId' | 'projectName'>,
): void {
  if (
    targetIdentity.id !== journal.operationId
    && targetIdentity.id !== journal.targetProjectIdentityId
  ) fail('Another Project claimed the durable migration target.');
  if (
    targetIdentity.workspaceOwnerId !== journal.workspaceOwnerId
    || targetIdentity.projectName !== journal.targetProjectName
  ) fail('The durable migration target identity changed.');
}

function assertIdentityRoot(identity: ProjectIdentityRecord, expectedRoot: string): void {
  const normalized = path.resolve(expectedRoot);
  if (normalized !== expectedRoot || identity.canonicalRoot !== normalized) {
    fail('A Project identity did not own the exact expected root.');
  }
  let actual;
  try {
    actual = attestProjectRoot(normalized);
  } catch {
    fail('A Project identity root was unavailable or unsafe.');
  }
  if (
    actual!.canonicalRoot !== identity.canonicalRoot
    || actual!.rootDevice !== identity.rootDevice
    || actual!.rootInode !== identity.rootInode
    || actual!.rootBirthtimeNs !== identity.rootBirthtimeNs
  ) fail('A Project identity root changed before App rebind.');
}

function assertRealDeployment(directory: string): void {
  try {
    const actual = attestProjectRoot(directory);
    if (actual.canonicalRoot !== directory) fail('An App deployment resolved through an unsafe path.');
  } catch (error) {
    if (error instanceof ProjectAppIdentityRebindError) throw error;
    fail('An App deployment was unavailable or unsafe.');
  }
}

function sameDirectoryIdentity(
  actual: ReturnType<typeof attestProjectRoot>,
  expected: NonNullable<ProjectAppRebindOperation['stagingIdentity']>,
): boolean {
  return actual.rootDevice === expected.rootDevice
    && actual.rootInode === expected.rootInode
    && actual.rootBirthtimeNs === expected.rootBirthtimeNs;
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

function removeInterruptedStaging(journal: ProjectAppRebindOperation, stagingRoot: string): void {
  if (!pathExists(stagingRoot)) return;
  const expected = path.join(
    path.dirname(journal.targetDeployPath),
    `.${path.basename(journal.targetDeployPath)}.deploy-${journal.operationId}`,
  );
  if (stagingRoot !== expected) fail('The interrupted App deployment staging path was unsafe.');
  const attested = attestProjectRoot(stagingRoot);
  if (
    attested.canonicalRoot !== stagingRoot
    || (journal.stagingIdentity && !sameDirectoryIdentity(attested, journal.stagingIdentity))
  ) fail('The interrupted App deployment staging identity changed.');
  fs.rmSync(stagingRoot, { recursive: true, force: false });
  fsyncDirectory(path.dirname(stagingRoot));
}

function verifyPromotedDeployment(journal: ProjectAppRebindOperation): void {
  if (!journal.sourceDigest || !journal.stagingIdentity) {
    fail('The App deployment promotion lost its durable integrity proof.');
  }
  const target = attestProjectRoot(journal.targetDeployPath);
  if (
    target.canonicalRoot !== journal.targetDeployPath
    || !sameDirectoryIdentity(target, journal.stagingIdentity)
    || fingerprintFullstackDeploymentTree(journal.targetDeployPath) !== journal.sourceDigest
  ) fail('The promoted App deployment changed before rebind recovery.');
}

function classifyApp(
  app: RebindApp | null,
  journal: ProjectAppRebindOperation,
): 'source' | 'target' {
  if (!app || app.id !== journal.appId || app.userId !== journal.workspaceOwnerId) {
    fail('The exact App disappeared during identity rebind.');
  }
  if (
    (app.projectIdentityId === journal.sourceProjectIdentityId || app.projectIdentityId === null)
    && app.zipPath === journal.sourceDeployPath
    && (app.name === journal.sourceAppName
      || app.name === journal.sourceProjectName
      || app.name === journal.targetProjectName)
  ) return 'source';
  if (
    app.projectIdentityId === journal.targetProjectIdentityId
    && app.name === journal.targetProjectName
    && app.zipPath === journal.targetDeployPath
  ) return 'target';
  fail('The App changed outside its durable identity rebind operation.');
}

async function commitAppRebind(
  database: ProjectAppRebindDatabase,
  journal: ProjectAppRebindOperation,
  environment: NodeJS.ProcessEnv,
): Promise<{ appId: string; shareLinksPreserved: number }> {
  return database.$transaction(async (transaction) => {
    const [sourceIdentity, targetIdentity, currentApp] = await Promise.all([
      transaction.projectIdentity.findUnique({ where: { id: journal.sourceProjectIdentityId } }),
      transaction.projectIdentity.findUnique({ where: { id: journal.targetProjectIdentityId } }),
      transaction.app.findUnique({ where: { id: journal.appId } }),
    ]);
    if (
      !sourceIdentity
      || sourceIdentity.workspaceOwnerId !== journal.workspaceOwnerId
      || sourceIdentity.projectName !== journal.sourceProjectName
      || sourceIdentity.lifecycleStatus !== 'ACTIVE'
      || sourceIdentity.legacyOpenClawMigrationStatus === 'CURRENT'
    ) fail('The source Project was not the exact active legacy identity.');
    if (
      !targetIdentity
      || targetIdentity.workspaceOwnerId !== journal.workspaceOwnerId
      || targetIdentity.projectName !== journal.targetProjectName
      || targetIdentity.lifecycleStatus !== 'ACTIVE'
      || targetIdentity.legacyOpenClawMigrationStatus !== 'CURRENT'
    ) fail('The target Project was not the exact active CURRENT identity.');
    assertIdentityRoot(sourceIdentity, journal.sourceProjectRoot);
    assertIdentityRoot(targetIdentity, journal.targetProjectRoot);
    verifyPromotedDeployment(journal);

    const state = classifyApp(currentApp, journal);
    const app = currentApp!;
    const management = projectRuntimeManagement(app, environment);
    if (management === 'invalid-external-binding' || management === 'desktop-session') {
      fail('The App runtime ownership was not eligible for identity rebind.');
    }
    if (
      management === 'portal-container'
      && !['stopped', 'error'].includes(app.processStatus)
    ) fail('Stop the Portal-managed App before migrating its Project identity.');
    if (await transaction.app.count({
      where: {
        id: { not: app.id },
        OR: [
          { projectIdentityId: journal.targetProjectIdentityId },
          { userId: journal.workspaceOwnerId, name: journal.targetProjectName },
        ],
      },
    }) > 0) fail('The target Project already had a conflicting App identity.');

    const sharesBefore = await transaction.appShareLink.findMany({
      where: { appId: app.id },
      select: { id: true, token: true },
      orderBy: { id: 'asc' },
      take: 10_001,
    });
    if (sharesBefore.length > 10_000) fail('The App share inventory exceeded its safety limit.');
    if (state === 'source') {
      const updated = await transaction.app.updateMany({
        where: {
          id: app.id,
          userId: app.userId,
          projectIdentityId: app.projectIdentityId,
          name: app.name,
          zipPath: app.zipPath,
          deployType: app.deployType,
          processStatus: app.processStatus,
          updatedAt: app.updatedAt,
        },
        data: {
          projectIdentityId: journal.targetProjectIdentityId,
          name: journal.targetProjectName,
          zipPath: journal.targetDeployPath,
        },
      });
      if (updated.count !== 1) fail('The App changed before its identity rebind could commit.');
    }
    const rebound = await transaction.app.findUnique({ where: { id: app.id } });
    if (
      !rebound
      || rebound.id !== app.id
      || rebound.userId !== journal.workspaceOwnerId
      || rebound.projectIdentityId !== journal.targetProjectIdentityId
      || rebound.name !== journal.targetProjectName
      || rebound.zipPath !== journal.targetDeployPath
      || rebound.deployType !== app.deployType
      || rebound.processStatus !== app.processStatus
    ) fail('The committed App identity rebind could not be reattested.');
    const sharesAfter = await transaction.appShareLink.findMany({
      where: { appId: app.id },
      select: { id: true, token: true },
      orderBy: { id: 'asc' },
      take: 10_001,
    });
    if (JSON.stringify(sharesAfter) !== JSON.stringify(sharesBefore)) {
      fail('The App share inventory changed during identity rebind.');
    }
    return Object.freeze({ appId: app.id, shareLinksPreserved: sharesAfter.length });
  }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 });
}

async function convergeDeployment(
  initial: ProjectAppRebindOperation,
  explicitRoot?: string,
  checkpoint?: (stage: 'DEPLOYMENT_PROMOTED' | 'APP_COMMITTED') => void,
): Promise<ProjectAppRebindOperation> {
  let journal = initial;
  const stagingRoot = path.join(
    path.dirname(journal.targetDeployPath),
    `.${path.basename(journal.targetDeployPath)}.deploy-${journal.operationId}`,
  );
  const preparedRank = JOURNAL_STAGES.indexOf('DEPLOYMENT_PREPARED');
  const promotedRank = JOURNAL_STAGES.indexOf('DEPLOYMENT_PROMOTED');
  if (JOURNAL_STAGES.indexOf(journal.stage) < preparedRank) {
    if (pathExists(journal.targetDeployPath)) {
      fail('An unjournaled target App deployment requires operator review.');
    }
    removeInterruptedStaging(journal, stagingRoot);
    journal = updateJournal(journal, { stage: 'DEPLOYMENT_COPYING' }, explicitRoot);
    const preparation = prepareFullstackDeploymentTree(
      journal.sourceDeployPath,
      journal.targetDeployPath,
      undefined,
      journal.operationId,
    );
    journal = updateJournal(journal, {
      stage: 'DEPLOYMENT_PREPARED',
      sourceDigest: preparation.sourceDigest,
      stagingIdentity: preparation.stagingIdentity,
    }, explicitRoot);
  }

  if (JOURNAL_STAGES.indexOf(journal.stage) < promotedRank) {
    if (pathExists(journal.targetDeployPath)) {
      if (pathExists(stagingRoot)) fail('Both staged and promoted App deployments exist.');
      verifyPromotedDeployment(journal);
    } else {
      assertRealDeployment(stagingRoot);
      const staging = attestProjectRoot(stagingRoot);
      if (
        !journal.stagingIdentity
        || !sameDirectoryIdentity(staging, journal.stagingIdentity)
        || !journal.sourceDigest
        || fingerprintFullstackDeploymentTree(stagingRoot) !== journal.sourceDigest
      ) fail('The staged App deployment changed before promotion.');
      const stagingIdentity = journal.stagingIdentity;
      if (!stagingIdentity) fail('The staged App deployment lost its durable identity.');
      journal = updateJournal(journal, { stage: 'DEPLOYMENT_PROMOTE_PENDING' }, explicitRoot);
      moveAttestedDirectoryNoReplace({
        sourceRoot: stagingRoot,
        targetRoot: journal.targetDeployPath,
        expectedIdentity: stagingIdentity,
      });
      fsyncDirectory(path.dirname(journal.targetDeployPath));
      verifyPromotedDeployment(journal);
      checkpoint?.('DEPLOYMENT_PROMOTED');
    }
    journal = updateJournal(journal, { stage: 'DEPLOYMENT_PROMOTED' }, explicitRoot);
  } else {
    verifyPromotedDeployment(journal);
  }
  return journal;
}

/**
 * Transfer one exact App row from an explicitly selected legacy Project to its
 * CURRENT copy. Filesystem promotion and the DB CAS are joined by a protected,
 * fsynced write-ahead journal; an exact retry classifies the durable state and
 * finishes the same operation after process death.
 */
export async function rebindLegacyProjectAppToCurrentCopy(input: {
  workspaceOwnerId: string;
  appId: string;
  sourceProjectIdentityId: string;
  sourceProjectName: string;
  sourceAppName: string;
  sourceProjectRoot: string;
  sourceDeployPath: string;
  targetProjectIdentityId: string;
  targetProjectName: string;
  targetProjectRoot: string;
  targetDeployPath: string;
}, options: {
  database?: ProjectAppRebindDatabase;
  environment?: NodeJS.ProcessEnv;
  journalRoot?: string;
  testCheckpoint?: (stage: 'DEPLOYMENT_PROMOTED' | 'APP_COMMITTED') => void;
  runtimeLock?: typeof withStoppedProjectAppRuntimeLocks;
} = {}): Promise<{ appId: string; shareLinksPreserved: number }> {
  const database = options.database || (prisma as unknown as ProjectAppRebindDatabase);
  const environment = options.environment || process.env;
  const ownerId = String(input.workspaceOwnerId || '');
  const sourceName = String(input.sourceProjectName || '');
  const sourceAppName = String(input.sourceAppName || '');
  const targetName = String(input.targetProjectName || '');
  const deployRoot = path.dirname(path.resolve(input.targetDeployPath));
  const exactSourcePath = path.join(deployRoot, `${ownerId}-${sourceName}`);
  const exactTargetPath = path.join(deployRoot, `${ownerId}-${targetName}`);
  if (
    !ownerId
    || !sourceName
    || !sourceAppName
    || !targetName
    || sourceName === targetName
    || path.resolve(input.sourceDeployPath) !== input.sourceDeployPath
    || path.resolve(input.targetDeployPath) !== input.targetDeployPath
    || input.sourceDeployPath !== exactSourcePath
    || input.targetDeployPath !== exactTargetPath
  ) fail('The App rebind paths did not match the exact source and target Projects.');
  assertRealDeployment(input.sourceDeployPath);

  let journal = beginProjectAppRebindOperation(input, { journalRoot: options.journalRoot });
  if (!journal.targetProjectIdentityId) {
    journal = bindProjectAppRebindTarget({
      sourceProjectIdentityId: input.sourceProjectIdentityId,
      targetProjectIdentityId: input.targetProjectIdentityId,
    }, { journalRoot: options.journalRoot });
  }
  const sourceDeployId = `${ownerId}-${sourceName}`;
  const targetDeployId = `${ownerId}-${targetName}`;
  const runtimeLock = options.runtimeLock || withStoppedProjectAppRuntimeLocks;
  return runtimeLock({
    appId: input.appId,
    bindings: [
      {
        deployId: sourceDeployId,
        deployPath: input.sourceDeployPath,
        actorId: ownerId,
        projectId: input.sourceProjectIdentityId,
      },
      {
        deployId: targetDeployId,
        deployPath: input.targetDeployPath,
        actorId: ownerId,
        projectId: input.targetProjectIdentityId,
      },
    ],
  }, async (lease) => {
    journal = readJournal(input.sourceProjectIdentityId, options.journalRoot)!;
    const app = await database.app.findUnique({ where: { id: journal.appId } });
    const appState = classifyApp(app, journal);
    if (appState === 'source') {
      journal = await convergeDeployment(journal, options.journalRoot, options.testCheckpoint);
      journal = updateJournal(journal, { stage: 'APP_COMMIT_PENDING' }, options.journalRoot);
    } else {
      verifyPromotedDeployment(journal);
    }
    // Retire the exact stopped source-bound recovery record before the App
    // association moves. A crash here leaves the journal replayable and the
    // App at source; a crash after DB commit cannot preserve split identity.
    await lease.retirePersistedState();
    const result = await commitAppRebind(database, journal, environment);
    options.testCheckpoint?.('APP_COMMITTED');
    if (journal.stage !== 'COMPLETED') {
      journal = updateJournal(journal, {
        stage: 'APP_COMMITTED',
        shareLinksPreserved: result.shareLinksPreserved,
      }, options.journalRoot);
      journal = updateJournal(journal, {
        stage: 'COMPLETED',
        shareLinksPreserved: result.shareLinksPreserved,
        completedAt: new Date().toISOString(),
      }, options.journalRoot);
    }
    return result;
  });
}
