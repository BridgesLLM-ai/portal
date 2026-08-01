import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { prisma } from '../config/database';
import {
  attestProjectRoot,
  type ProjectIdentityRecord,
} from './projectIdentity';

type ManifestEntry = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
  mode: number;
  // Regular files omit kind so version-1 file-only journals retain their
  // original serialization and digest.
  kind?: 'directory' | 'symlink';
  // A symlink is inert Project data in the parked snapshot. Its target bytes are
  // never resolved, traversed, opened, or included in the snapshot contract:
  // absolute, escaping, dangling, and cyclic targets are all preserved as
  // exact base64, including non-UTF-8 targets. Regular-file entries omit this so
  // journals written before symlink support keep their original digest.
  linkTargetBase64?: string;
}>;

export type ProjectLegacyAdoptionManifest = Readonly<{
  fileCount: number;
  totalBytes: number;
  sha256: string;
  entries: readonly ManifestEntry[];
  rootMode?: number;
  entryCount?: number;
  directoryCount?: number;
  symlinkCount?: number;
}>;

type AdoptionJournal = Readonly<{
  version: 1 | 2;
  identityId: string;
  workspaceOwnerId: string;
  projectName: string;
  generationBefore: number;
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  stage: 'COPYING' | 'VERIFIED' | 'COMMITTED';
  manifest: ProjectLegacyAdoptionManifest;
  parkedRoot: string;
  startedAt: string;
  updatedAt: string;
  committedAt?: string;
  generationAfter?: number;
}>;

type AdoptionLimits = Readonly<{
  maxEntries: number;
  maxBytes: number;
  minimumFreeBytesAfterCopy: number;
}>;

const DEFAULT_ADOPTION_LIMITS: AdoptionLimits = Object.freeze({
  maxEntries: 500_000,
  maxBytes: 64 * 1024 * 1024 * 1024,
  minimumFreeBytesAfterCopy: 1024 * 1024 * 1024,
});

interface AdoptionDatabase {
  projectIdentity: {
    findUnique(args: unknown): Promise<ProjectIdentityRecord | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

export class ProjectLegacyAdoptionError extends Error {
  readonly code: 'MIGRATION_BUSY' | 'MIGRATION_INTEGRITY_FAILED' | 'MIGRATION_NOT_ALLOWED';
  readonly retryable: boolean;

  constructor(
    message: string,
    code: ProjectLegacyAdoptionError['code'],
    retryable = false,
  ) {
    super(message);
    this.name = 'ProjectLegacyAdoptionError';
    this.code = code;
    this.retryable = retryable;
  }
}

function adoptionRoot(): string {
  return path.resolve(
    process.env.PORTAL_PROJECT_LEGACY_ADOPTION_ROOT
      || (process.env.NODE_ENV === 'production'
        ? '/var/lib/bridgesllm/project-legacy-adoption'
        : path.join(process.env.PORTAL_ROOT || '/opt/bridgesllm/portal', '.data', 'project-legacy-adoption')),
  );
}

function requirePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stat = fs.lstatSync(directory);
  const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || stat.uid !== uid
    || (stat.mode & 0o077) !== 0
    || fs.realpathSync(directory) !== directory
  ) {
    throw new ProjectLegacyAdoptionError(
      'Portal could not prepare a private migration workspace.',
      'MIGRATION_NOT_ALLOWED',
    );
  }
}

function identityDirectory(identityId: string): string {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(identityId)) {
    throw new ProjectLegacyAdoptionError(
      'This project identity cannot be migrated safely.',
      'MIGRATION_NOT_ALLOWED',
    );
  }
  const root = adoptionRoot();
  requirePrivateDirectory(root);
  const directory = path.join(root, identityId);
  requirePrivateDirectory(directory);
  return directory;
}

function atomicWriteJson(file: string, value: unknown): void {
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
  const directoryHandle = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(directoryHandle);
  } finally {
    fs.closeSync(directoryHandle);
  }
}

function readJournal(file: string): AdoptionJournal | null {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error('unsafe journal');
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as AdoptionJournal;
    if (
      ![1, 2].includes(parsed.version)
      || !parsed.identityId
      || !parsed.canonicalRoot
      || !parsed.parkedRoot
      || !['COPYING', 'VERIFIED', 'COMMITTED'].includes(parsed.stage)
      || !parsed.manifest
    ) {
      throw new Error('incomplete journal');
    }
    return parsed;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw new ProjectLegacyAdoptionError(
      'Portal found an incomplete migration record. The original project remains unchanged.',
      'MIGRATION_INTEGRITY_FAILED',
      true,
    );
  }
}

function sameStableEntry(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function migrationIntegrityFailure(message: string): ProjectLegacyAdoptionError {
  return new ProjectLegacyAdoptionError(
    message,
    'MIGRATION_INTEGRITY_FAILED',
    true,
  );
}

function stableSymlinkTarget(file: string): { target: Buffer; stat: fs.BigIntStats } {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isSymbolicLink()) {
    throw migrationIntegrityFailure('A project link changed type while Portal was preparing it.');
  }
  const target = fs.readlinkSync(file, { encoding: 'buffer' });
  const after = fs.lstatSync(file, { bigint: true });
  const targetAfter = fs.readlinkSync(file, { encoding: 'buffer' });
  if (!after.isSymbolicLink() || !sameStableEntry(before, after) || !targetAfter.equals(target)) {
    throw migrationIntegrityFailure('A project link changed while Portal was preparing it.');
  }
  return { target, stat: before };
}

function digestFile(file: string): { bytes: number; sha256: string; mode: number } {
  const pathBefore = fs.lstatSync(file, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw migrationIntegrityFailure('A project file changed type while Portal was preparing it.');
  }
  const digest = crypto.createHash('sha256');
  const handle = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    const opened = fs.fstatSync(handle, { bigint: true });
    if (!opened.isFile() || !sameStableEntry(pathBefore, opened)) {
      throw migrationIntegrityFailure('A project file changed before Portal could read it safely.');
    }
    while (true) {
      const count = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      digest.update(buffer.subarray(0, count));
    }
    const openedAfter = fs.fstatSync(handle, { bigint: true });
    if (!sameStableEntry(opened, openedAfter)) {
      throw migrationIntegrityFailure('A project file changed while Portal was reading it.');
    }
  } finally {
    fs.closeSync(handle);
  }
  const pathAfter = fs.lstatSync(file, { bigint: true });
  if (!sameStableEntry(pathBefore, pathAfter)) {
    throw migrationIntegrityFailure('A project file was replaced while Portal was preparing it.');
  }
  return {
    bytes,
    sha256: digest.digest('hex'),
    mode: Number(pathBefore.mode & BigInt(0o777)),
  };
}

function normalizeAdoptionLimits(overrides: Partial<AdoptionLimits> = {}): AdoptionLimits {
  const limits = { ...DEFAULT_ADOPTION_LIMITS, ...overrides };
  if (
    !Number.isSafeInteger(limits.maxEntries)
    || limits.maxEntries < 1
    || !Number.isSafeInteger(limits.maxBytes)
    || limits.maxBytes < 1
    || !Number.isSafeInteger(limits.minimumFreeBytesAfterCopy)
    || limits.minimumFreeBytesAfterCopy < 0
  ) {
    throw migrationIntegrityFailure('The project migration safety limits were invalid.');
  }
  return Object.freeze(limits);
}

function buildManifest(
  root: string,
  version: 1 | 2,
  limits: AdoptionLimits,
): ProjectLegacyAdoptionManifest {
  const canonicalRoot = fs.realpathSync.native(path.resolve(root));
  const rootStat = fs.lstatSync(canonicalRoot, { bigint: true });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw migrationIntegrityFailure('The project migration root was not a real directory.');
  }
  const rootMode = Number(rootStat.mode & BigInt(0o777));
  const entries: ManifestEntry[] = [];
  let totalBytes = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let symlinkCount = 0;
  const pushEntry = (entry: ManifestEntry): void => {
    if (entries.length >= limits.maxEntries) {
      throw migrationIntegrityFailure('The project migration inventory exceeded its entry limit.');
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw migrationIntegrityFailure('The project migration inventory contained an invalid size.');
    }
    if (totalBytes > limits.maxBytes - entry.bytes) {
      throw migrationIntegrityFailure('The project migration inventory exceeded its byte limit.');
    }
    entries.push(Object.freeze(entry));
    totalBytes += entry.bytes;
  };
  const visit = (directory: string, relativeDirectory: string): void => {
    const directoryBefore = fs.lstatSync(directory, { bigint: true });
    if (
      directoryBefore.isSymbolicLink()
      || !directoryBefore.isDirectory()
      || fs.realpathSync.native(directory) !== directory
    ) {
      throw migrationIntegrityFailure('A project directory changed while Portal was preparing it.');
    }
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = relativeDirectory
        ? path.posix.join(relativeDirectory, child.name)
        : child.name;
      const stat = fs.lstatSync(absolute, { bigint: true });
      if (stat.isSymbolicLink()) {
        if (version === 1) {
          throw migrationIntegrityFailure(
            `Migration paused because “${relative}” is not a regular project file.`,
          );
        }
        const { target, stat: stableStat } = stableSymlinkTarget(absolute);
        pushEntry({
          path: relative,
          bytes: target.length,
          sha256: crypto.createHash('sha256').update(target).digest('hex'),
          mode: Number(stableStat.mode & BigInt(0o777)),
          kind: 'symlink',
          linkTargetBase64: target.toString('base64'),
        });
        symlinkCount += 1;
        continue;
      }
      if (!stat.isDirectory() && !stat.isFile()) {
        throw new ProjectLegacyAdoptionError(
          `Migration paused because “${relative}” is not a regular project file.`,
          'MIGRATION_INTEGRITY_FAILED',
          true,
        );
      }
      if (stat.isDirectory()) {
        if (version === 2) {
          pushEntry({
            path: relative,
            bytes: 0,
            sha256: crypto.createHash('sha256').update('directory').digest('hex'),
            mode: Number(stat.mode & BigInt(0o777)),
            kind: 'directory',
          });
          directoryCount += 1;
        }
        visit(absolute, relative);
        continue;
      }
      if (stat.size > BigInt(limits.maxBytes - totalBytes)) {
        throw migrationIntegrityFailure('The project migration inventory exceeded its byte limit.');
      }
      const file = digestFile(absolute);
      pushEntry({
        path: relative,
        ...file,
      });
      fileCount += 1;
    }
    const directoryAfter = fs.lstatSync(directory, { bigint: true });
    if (!sameStableEntry(directoryBefore, directoryAfter)) {
      throw migrationIntegrityFailure('A project directory changed while Portal was preparing it.');
    }
  };
  visit(canonicalRoot, '');
  const sha256 = crypto.createHash('sha256')
    .update(version === 1
      ? JSON.stringify(entries)
      : JSON.stringify({ rootMode, entries }))
    .digest('hex');
  return Object.freeze(version === 1
    ? {
        fileCount,
        totalBytes,
        sha256,
        entries: Object.freeze(entries),
      }
    : {
        fileCount,
        totalBytes,
        sha256,
        entries: Object.freeze(entries),
        rootMode,
        entryCount: entries.length,
        directoryCount,
        symlinkCount,
      });
}

export function buildProjectLegacyAdoptionManifest(
  root: string,
  options: { limits?: Partial<AdoptionLimits> } = {},
): ProjectLegacyAdoptionManifest {
  return buildManifest(root, 2, normalizeAdoptionLimits(options.limits));
}

function manifestsMatch(
  left: ProjectLegacyAdoptionManifest,
  right: ProjectLegacyAdoptionManifest,
): boolean {
  return left.fileCount === right.fileCount
    && left.totalBytes === right.totalBytes
    && left.sha256 === right.sha256
    && left.rootMode === right.rootMode
    && left.entryCount === right.entryCount
    && left.directoryCount === right.directoryCount
    && left.symlinkCount === right.symlinkCount;
}

function manifestPathSegments(relative: string): string[] {
  if (
    !relative
    || relative.includes('\0')
    || path.posix.isAbsolute(relative)
    || path.posix.normalize(relative) !== relative
  ) {
    throw migrationIntegrityFailure('The project migration manifest contained an unsafe path.');
  }
  const segments = relative.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw migrationIntegrityFailure('The project migration manifest contained an unsafe path.');
  }
  return segments;
}

function copyRegularManifestEntry(source: string, destination: string, entry: ManifestEntry): void {
  const sourceBefore = fs.lstatSync(source, { bigint: true });
  if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink()) {
    throw migrationIntegrityFailure('A project file changed type before it could be copied.');
  }
  const sourceHandle = fs.openSync(
    source,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  let destinationHandle: number | null = null;
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    const opened = fs.fstatSync(sourceHandle, { bigint: true });
    if (!opened.isFile() || !sameStableEntry(sourceBefore, opened)) {
      throw migrationIntegrityFailure('A project file changed before it could be copied safely.');
    }
    destinationHandle = fs.openSync(
      destination,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      entry.mode,
    );
    while (true) {
      const count = fs.readSync(sourceHandle, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      digest.update(buffer.subarray(0, count));
      let offset = 0;
      while (offset < count) {
        const written = fs.writeSync(destinationHandle, buffer, offset, count - offset);
        if (written <= 0) {
          throw migrationIntegrityFailure('A project snapshot write made no progress.');
        }
        offset += written;
      }
    }
    fs.fchmodSync(destinationHandle, entry.mode);
    fs.fsyncSync(destinationHandle);
    const openedAfter = fs.fstatSync(sourceHandle, { bigint: true });
    if (!sameStableEntry(opened, openedAfter)) {
      throw migrationIntegrityFailure('A project file changed while it was copied.');
    }
  } finally {
    if (destinationHandle !== null) fs.closeSync(destinationHandle);
    fs.closeSync(sourceHandle);
  }
  const sourceAfter = fs.lstatSync(source, { bigint: true });
  if (!sameStableEntry(sourceBefore, sourceAfter)) {
    throw migrationIntegrityFailure('A project file was replaced while it was copied.');
  }
  if (bytes !== entry.bytes || digest.digest('hex') !== entry.sha256) {
    throw migrationIntegrityFailure('A project file did not match its migration manifest.');
  }
}

function copySymlinkManifestEntry(source: string, destination: string, entry: ManifestEntry): void {
  if (entry.kind !== 'symlink' || entry.linkTargetBase64 === undefined) {
    throw migrationIntegrityFailure('A project link was missing from its migration manifest.');
  }
  const expectedTarget = Buffer.from(entry.linkTargetBase64, 'base64');
  if (expectedTarget.toString('base64') !== entry.linkTargetBase64) {
    throw migrationIntegrityFailure('A project link target was malformed in its migration manifest.');
  }
  const before = stableSymlinkTarget(source);
  if (
    !before.target.equals(expectedTarget)
    || before.target.length !== entry.bytes
    || crypto.createHash('sha256').update(before.target).digest('hex') !== entry.sha256
  ) {
    throw migrationIntegrityFailure('A project link did not match its migration manifest.');
  }
  fs.symlinkSync(expectedTarget, destination);
  const copied = stableSymlinkTarget(destination);
  const sourceAfter = stableSymlinkTarget(source);
  if (
    !copied.target.equals(expectedTarget)
    || !sourceAfter.target.equals(expectedTarget)
    || !sameStableEntry(before.stat, sourceAfter.stat)
  ) {
    throw migrationIntegrityFailure('A project link changed while it was copied.');
  }
}

function copyDirectoryManifestEntry(source: string, destination: string, entry: ManifestEntry): void {
  if (entry.kind !== 'directory' || entry.bytes !== 0) {
    throw migrationIntegrityFailure('A project directory was malformed in its migration manifest.');
  }
  const before = fs.lstatSync(source, { bigint: true });
  if (
    before.isSymbolicLink()
    || !before.isDirectory()
    || Number(before.mode & BigInt(0o777)) !== entry.mode
    || crypto.createHash('sha256').update('directory').digest('hex') !== entry.sha256
  ) {
    throw migrationIntegrityFailure('A project directory did not match its migration manifest.');
  }
  fs.mkdirSync(destination, { mode: entry.mode });
  fs.chmodSync(destination, entry.mode);
  const copied = fs.lstatSync(destination, { bigint: true });
  const after = fs.lstatSync(source, { bigint: true });
  if (
    copied.isSymbolicLink()
    || !copied.isDirectory()
    || Number(copied.mode & BigInt(0o777)) !== entry.mode
    || !sameStableEntry(before, after)
  ) {
    throw migrationIntegrityFailure('A project directory changed while it was copied.');
  }
}

function copyManifest(sourceRoot: string, destinationRoot: string, manifest: ProjectLegacyAdoptionManifest): void {
  const rootMode = manifest.rootMode ?? 0o700;
  fs.mkdirSync(destinationRoot, { mode: rootMode });
  fs.chmodSync(destinationRoot, rootMode);
  for (const entry of manifest.entries) {
    const segments = manifestPathSegments(entry.path);
    const source = path.join(sourceRoot, ...segments);
    const destination = path.join(destinationRoot, ...segments);
    if (entry.kind === 'directory') {
      copyDirectoryManifestEntry(source, destination, entry);
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (entry.kind === 'symlink') {
      copySymlinkManifestEntry(source, destination, entry);
    } else if (entry.kind === undefined && entry.linkTargetBase64 === undefined) {
      copyRegularManifestEntry(source, destination, entry);
    } else {
      throw migrationIntegrityFailure('The project migration manifest contained an unknown object type.');
    }
  }
}

function availableDiskBytes(directory: string): bigint {
  const filesystem = fs.statfsSync(directory, { bigint: true });
  return filesystem.bavail * filesystem.bsize;
}

function assertSnapshotDiskCapacity(
  directory: string,
  manifest: ProjectLegacyAdoptionManifest,
  limits: AdoptionLimits,
  readAvailableBytes: (directory: string) => bigint,
): void {
  const entryCount = manifest.entryCount ?? manifest.entries.length;
  const metadataAllowance = BigInt(entryCount) * BigInt(4096);
  const required = BigInt(manifest.totalBytes)
    + BigInt(limits.minimumFreeBytesAfterCopy)
    + metadataAllowance;
  let available: bigint;
  try {
    available = readAvailableBytes(directory);
  } catch {
    throw migrationIntegrityFailure('Portal could not verify free space for the project snapshot.');
  }
  if (available < required) {
    throw migrationIntegrityFailure(
      'Portal does not have enough verified free space to snapshot this project safely.',
    );
  }
}

function acquireMigrationLock(directory: string): () => void {
  const lockDirectory = path.join(directory, 'lock');
  const ownerFile = path.join(lockDirectory, 'owner.json');
  const claim = (): boolean => {
    try {
      fs.mkdirSync(lockDirectory, { mode: 0o700 });
      atomicWriteJson(ownerFile, { pid: process.pid, startedAt: new Date().toISOString() });
      return true;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      return false;
    }
  };
  if (!claim()) {
    let ownerPid: number | null = null;
    try {
      const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as { pid?: unknown };
      ownerPid = Number.isSafeInteger(owner.pid) ? Number(owner.pid) : null;
    } catch {
      // A process killed between mkdir and owner persistence leaves a stale lock.
    }
    let ownerAlive = false;
    if (ownerPid && ownerPid > 0) {
      try {
        process.kill(ownerPid, 0);
        ownerAlive = true;
      } catch (error: any) {
        ownerAlive = error?.code === 'EPERM';
      }
    }
    if (ownerAlive) {
      throw new ProjectLegacyAdoptionError(
        'This project is already being prepared. Try again in a moment.',
        'MIGRATION_BUSY',
        true,
      );
    }
    fs.rmSync(lockDirectory, { recursive: true, force: true });
    if (!claim()) {
      throw new ProjectLegacyAdoptionError(
        'This project is already being prepared. Try again in a moment.',
        'MIGRATION_BUSY',
        true,
      );
    }
  }
  return () => {
    try {
      const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as { pid?: unknown };
      if (owner.pid === process.pid) fs.rmSync(lockDirectory, { recursive: true, force: true });
    } catch {
      // A missing lock after a successful migration needs no recovery.
    }
  };
}

function removeInterruptedStagingDirectories(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.startsWith('staging-')) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ProjectLegacyAdoptionError(
        'Portal found an unsafe interrupted migration copy. The original project remains unchanged.',
        'MIGRATION_INTEGRITY_FAILED',
        true,
      );
    }
    fs.rmSync(candidate, { recursive: true, force: false });
  }
}

function assertIdentityStillOwnsRoot(identity: ProjectIdentityRecord, projectRoot: string): void {
  const root = attestProjectRoot(projectRoot);
  if (
    root.canonicalRoot !== identity.canonicalRoot
    || root.rootDevice !== identity.rootDevice
    || root.rootInode !== identity.rootInode
    || root.rootBirthtimeNs !== identity.rootBirthtimeNs
  ) {
    throw new ProjectLegacyAdoptionError(
      'The project changed while Portal was preparing it. The original project remains unchanged.',
      'MIGRATION_INTEGRITY_FAILED',
      true,
    );
  }
}

export async function adoptLegacyProjectInPlace(input: {
  projectIdentity: ProjectIdentityRecord;
  projectRoot: string;
}, options: {
  database?: AdoptionDatabase;
  faultAfter?: 'COPY' | 'PARK' | 'COMMIT';
  limits?: Partial<AdoptionLimits>;
  readAvailableDiskBytes?: (directory: string) => bigint;
} = {}): Promise<{
  projectIdentityId: string;
  generation: number;
  alreadyCurrent: boolean;
  manifest: ProjectLegacyAdoptionManifest;
  parkedRoot: string;
}> {
  const database = options.database || (prisma as unknown as AdoptionDatabase);
  const limits = normalizeAdoptionLimits(options.limits);
  const readAvailableBytes = options.readAvailableDiskBytes || availableDiskBytes;
  const initial = input.projectIdentity;
  if (initial.lifecycleStatus !== 'ACTIVE') {
    throw new ProjectLegacyAdoptionError(
      'Finish the current project operation before preparing Project Chat.',
      'MIGRATION_NOT_ALLOWED',
      true,
    );
  }
  assertIdentityStillOwnsRoot(initial, input.projectRoot);
  const directory = identityDirectory(initial.id);
  const release = acquireMigrationLock(directory);
  try {
    // A hard kill can leave a private, unparked staging tree. Once the new
    // process owns the identity lock, that tree has no authoritative role and
    // is safely discarded before journal replay. The verified parked snapshot
    // is never touched here.
    removeInterruptedStagingDirectories(directory);
    const latest = await database.projectIdentity.findUnique({ where: { id: initial.id } });
    if (!latest) {
      throw new ProjectLegacyAdoptionError(
        'This project identity is no longer available.',
        'MIGRATION_NOT_ALLOWED',
      );
    }
    assertIdentityStillOwnsRoot(latest, input.projectRoot);
    const journalFile = path.join(directory, 'journal.json');
    const parkedRoot = path.join(directory, 'source-snapshot');
    const existingJournal = readJournal(journalFile);
    if (latest.legacyOpenClawMigrationStatus === 'CURRENT') {
      const manifest = existingJournal?.manifest
        || buildManifest(input.projectRoot, 2, limits);
      return {
        projectIdentityId: latest.id,
        generation: latest.generation,
        alreadyCurrent: true,
        manifest,
        parkedRoot: existingJournal?.parkedRoot || parkedRoot,
      };
    }

    let manifest: ProjectLegacyAdoptionManifest;
    const manifestVersion: 1 | 2 = existingJournal?.version || 2;
    if (fs.existsSync(parkedRoot)) {
      if (!existingJournal) {
        throw new ProjectLegacyAdoptionError(
          'Portal found a parked copy without its integrity record. The original project remains unchanged.',
          'MIGRATION_INTEGRITY_FAILED',
          true,
        );
      }
      manifest = buildManifest(parkedRoot, manifestVersion, limits);
      if (!manifestsMatch(existingJournal.manifest, manifest)) {
        throw new ProjectLegacyAdoptionError(
          'The parked project copy did not pass its integrity check. The original project remains unchanged.',
          'MIGRATION_INTEGRITY_FAILED',
          true,
        );
      }
    } else {
      const stagingRoot = path.join(directory, `staging-${crypto.randomUUID()}`);
      manifest = buildManifest(input.projectRoot, manifestVersion, limits);
      if (existingJournal && !manifestsMatch(existingJournal.manifest, manifest)) {
        throw new ProjectLegacyAdoptionError(
          'The project changed after an interrupted migration. The original project remains unchanged.',
          'MIGRATION_INTEGRITY_FAILED',
          true,
        );
      }
      assertSnapshotDiskCapacity(directory, manifest, limits, readAvailableBytes);
      atomicWriteJson(journalFile, {
        version: manifestVersion,
        identityId: latest.id,
        workspaceOwnerId: latest.workspaceOwnerId,
        projectName: latest.projectName,
        generationBefore: latest.generation,
        canonicalRoot: latest.canonicalRoot,
        rootDevice: latest.rootDevice,
        rootInode: latest.rootInode,
        rootBirthtimeNs: latest.rootBirthtimeNs,
        stage: 'COPYING',
        manifest,
        parkedRoot,
        startedAt: existingJournal?.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } satisfies AdoptionJournal);
      try {
        copyManifest(input.projectRoot, stagingRoot, manifest);
        if (options.faultAfter === 'COPY') throw new Error('fault injection after copy');
        const copied = buildManifest(stagingRoot, manifestVersion, limits);
        const sourceAfterCopy = buildManifest(input.projectRoot, manifestVersion, limits);
        if (!manifestsMatch(manifest, copied) || !manifestsMatch(manifest, sourceAfterCopy)) {
          throw new ProjectLegacyAdoptionError(
            'Project files changed during migration. Nothing was switched; try again.',
            'MIGRATION_INTEGRITY_FAILED',
            true,
          );
        }
        fs.renameSync(stagingRoot, parkedRoot);
      } catch (error) {
        if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true });
        throw error;
      }
    }

    const verifiedSource = buildManifest(input.projectRoot, manifestVersion, limits);
    const verifiedParked = buildManifest(parkedRoot, manifestVersion, limits);
    if (!manifestsMatch(manifest, verifiedSource) || !manifestsMatch(manifest, verifiedParked)) {
      throw new ProjectLegacyAdoptionError(
        'Project files did not pass the final integrity check. The original project remains unchanged.',
        'MIGRATION_INTEGRITY_FAILED',
        true,
      );
    }
    const verifiedJournal: AdoptionJournal = {
      version: manifestVersion,
      identityId: latest.id,
      workspaceOwnerId: latest.workspaceOwnerId,
      projectName: latest.projectName,
      generationBefore: latest.generation,
      canonicalRoot: latest.canonicalRoot,
      rootDevice: latest.rootDevice,
      rootInode: latest.rootInode,
      rootBirthtimeNs: latest.rootBirthtimeNs,
      stage: 'VERIFIED',
      manifest,
      parkedRoot,
      startedAt: existingJournal?.startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    atomicWriteJson(journalFile, verifiedJournal);
    if (options.faultAfter === 'PARK') throw new Error('fault injection after park');

    const committed = await database.projectIdentity.updateMany({
      where: {
        id: latest.id,
        generation: latest.generation,
        lifecycleStatus: 'ACTIVE',
        legacyOpenClawMigrationStatus: { not: 'CURRENT' },
        canonicalRoot: latest.canonicalRoot,
        rootDevice: latest.rootDevice,
        rootInode: latest.rootInode,
        rootBirthtimeNs: latest.rootBirthtimeNs,
      },
      data: {
        legacyOpenClawMigrationStatus: 'CURRENT',
        generation: { increment: 1 },
      },
    });
    if (committed.count !== 1) {
      const raced = await database.projectIdentity.findUnique({ where: { id: latest.id } });
      if (!raced || raced.legacyOpenClawMigrationStatus !== 'CURRENT') {
        throw new ProjectLegacyAdoptionError(
          'The project changed before migration could finish. Its files remain unchanged.',
          'MIGRATION_INTEGRITY_FAILED',
          true,
        );
      }
    }
    if (options.faultAfter === 'COMMIT') throw new Error('fault injection after commit');
    const current = await database.projectIdentity.findUnique({ where: { id: latest.id } });
    if (!current || current.legacyOpenClawMigrationStatus !== 'CURRENT') {
      throw new ProjectLegacyAdoptionError(
        'Portal could not confirm the completed migration.',
        'MIGRATION_INTEGRITY_FAILED',
        true,
      );
    }
    atomicWriteJson(journalFile, {
      ...verifiedJournal,
      stage: 'COMMITTED',
      updatedAt: new Date().toISOString(),
      committedAt: new Date().toISOString(),
      generationAfter: current.generation,
    } satisfies AdoptionJournal);
    return {
      projectIdentityId: current.id,
      generation: current.generation,
      alreadyCurrent: false,
      manifest,
      parkedRoot,
    };
  } finally {
    release();
  }
}
