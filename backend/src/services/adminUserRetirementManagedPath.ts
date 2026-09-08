import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { AdminUserRetirementIntegrityError } from './adminUserRetirementLedger';

export type AdminUserRetirementManagedPathKind =
  | 'FILE'
  | 'DIRECTORY'
  | 'CONTAINER_DIRECTORY';

export type AdminUserRetirementFilesystemIdentity = {
  device: string;
  inode: string;
  birthtimeNs: string;
  uid: number;
  gid: number;
  mode: number;
};

export type AdminUserRetirementManagedPath = {
  targetUserId: string;
  root: string;
  rootIdentity: AdminUserRetirementFilesystemIdentity;
  path: string;
  quarantinePath: string;
  kind: AdminUserRetirementManagedPathKind;
  present: boolean;
  identity: AdminUserRetirementFilesystemIdentity | null;
  size: string | null;
  sha256: string | null;
};

type ManagedPathMutationHooks = {
  afterRename?(): void | Promise<void>;
};

const QUARANTINE_DIRECTORY = '.portal-admin-user-retirement-quarantine';
const SHA256_RE = /^[a-f0-9]{64}$/;

function retirementIntegrity(message: string): never {
  throw new AdminUserRetirementIntegrityError(message);
}

function lstatOptional(filePath: string): fs.BigIntStats | null {
  try {
    return fs.lstatSync(filePath, { bigint: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function filesystemIdentity(stat: fs.BigIntStats): AdminUserRetirementFilesystemIdentity {
  return Object.freeze({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode & 0o7777n),
  });
}

function identitiesMatch(
  left: AdminUserRetirementFilesystemIdentity,
  right: AdminUserRetirementFilesystemIdentity,
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.birthtimeNs === right.birthtimeNs
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode;
}

function validateFilesystemIdentity(
  value: AdminUserRetirementFilesystemIdentity,
  label: string,
): void {
  if (!value || typeof value !== 'object') retirementIntegrity(`${label} identity is missing`);
  for (const key of ['device', 'inode', 'birthtimeNs'] as const) {
    if (!/^[0-9]+$/.test(String(value[key] || ''))) {
      retirementIntegrity(`${label} ${key} is invalid`);
    }
  }
  for (const key of ['uid', 'gid', 'mode'] as const) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      retirementIntegrity(`${label} ${key} is invalid`);
    }
  }
}

function absoluteNormalized(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (
    !normalized
    || normalized.length > 4096
    || !path.isAbsolute(normalized)
    || path.resolve(normalized) !== normalized
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    retirementIntegrity(`${label} must be an absolute normalized path`);
  }
  return normalized;
}

function strictDescendant(root: string, target: string, label: string): string {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    retirementIntegrity(`${label} escapes or equals its managed root`);
  }
  return relative;
}

function assertSecureRoot(
  root: string,
  expectedIdentity?: AdminUserRetirementFilesystemIdentity,
): fs.BigIntStats {
  const stat = lstatOptional(root);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    retirementIntegrity('Managed retirement root is missing, non-directory, or symlinked');
  }
  const real = fs.realpathSync(root);
  if (real !== root) retirementIntegrity('Managed retirement root is not canonical');
  if (expectedIdentity && !identitiesMatch(filesystemIdentity(stat), expectedIdentity)) {
    retirementIntegrity('Managed retirement root identity changed');
  }
  return stat;
}

function assertNoSymlinkComponents(root: string, target: string): void {
  const relative = strictDescendant(root, target, 'Managed retirement target');
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const stat = lstatOptional(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      retirementIntegrity('Managed retirement target contains a symlinked path component');
    }
  }
}

function sha256File(filePath: string): string {
  const statBefore = fs.lstatSync(filePath, { bigint: true });
  if (!statBefore.isFile() || statBefore.isSymbolicLink() || statBefore.nlink !== 1n) {
    retirementIntegrity('Managed retirement file is not a private regular file');
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const digest = hash.digest('hex');
  const statAfter = fs.lstatSync(filePath, { bigint: true });
  if (
    statBefore.dev !== statAfter.dev
    || statBefore.ino !== statAfter.ino
    || statBefore.size !== statAfter.size
    || statBefore.mtimeNs !== statAfter.mtimeNs
    || statBefore.ctimeNs !== statAfter.ctimeNs
    || statBefore.birthtimeNs !== statAfter.birthtimeNs
    || statAfter.nlink !== 1n
  ) {
    retirementIntegrity('Managed retirement file changed while it was attested');
  }
  return digest;
}

function updateTreeDigestIdentity(
  hash: crypto.Hash,
  relativePath: string,
  kind: 'FILE' | 'DIRECTORY',
  stat: fs.BigIntStats,
  contentDigest: string | null,
): void {
  hash.update(JSON.stringify({
    relativePath,
    kind,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode & 0o7777n),
    size: stat.size.toString(),
    contentDigest,
  }));
  hash.update('\n');
}

function assertStableDirectoryTraversal(
  before: fs.BigIntStats,
  after: fs.BigIntStats,
): void {
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
    || before.birthtimeNs !== after.birthtimeNs
  ) {
    retirementIntegrity('Managed retirement directory changed while it was attested');
  }
}

function sha256DirectoryTree(directoryPath: string): string {
  const hash = crypto.createHash('sha256');
  const visit = (currentPath: string, relativePath: string): void => {
    const before = fs.lstatSync(currentPath, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      retirementIntegrity('Managed retirement directory tree contains a non-directory root');
    }
    updateTreeDigestIdentity(hash, relativePath, 'DIRECTORY', before, null);
    const entries = fs.readdirSync(currentPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        !entry.name
        || entry.name === '.'
        || entry.name === '..'
        || entry.name.includes(path.sep)
        || /[\u0000-\u001f\u007f]/.test(entry.name)
      ) {
        retirementIntegrity('Managed retirement directory contains an unsafe entry name');
      }
      const childPath = path.join(currentPath, entry.name);
      const childRelativePath = relativePath
        ? path.join(relativePath, entry.name)
        : entry.name;
      const stat = fs.lstatSync(childPath, { bigint: true });
      if (stat.isSymbolicLink()) {
        retirementIntegrity('Managed retirement directory tree contains a symbolic link');
      }
      if (stat.isDirectory()) {
        visit(childPath, childRelativePath);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1n) {
          retirementIntegrity('Managed retirement directory tree contains a linked file');
        }
        const contentDigest = sha256File(childPath);
        const stable = fs.lstatSync(childPath, { bigint: true });
        updateTreeDigestIdentity(hash, childRelativePath, 'FILE', stable, contentDigest);
      } else {
        retirementIntegrity('Managed retirement directory tree contains a special file');
      }
    }
    const after = fs.lstatSync(currentPath, { bigint: true });
    assertStableDirectoryTraversal(before, after);
  };
  visit(directoryPath, '');
  return hash.digest('hex');
}

function deterministicQuarantinePath(
  root: string,
  targetUserId: string,
  target: string,
  kind: AdminUserRetirementManagedPathKind,
): string {
  const userId = String(targetUserId || '').trim();
  if (!userId || userId.length > 200 || /[\u0000-\u001f\u007f]/.test(userId)) {
    retirementIntegrity('Retirement target user identity is invalid');
  }
  const digest = crypto.createHash('sha256')
    .update(`admin-user-retirement-v1\0${userId}\0${kind}\0${target}`)
    .digest('hex');
  return path.join(root, QUARANTINE_DIRECTORY, digest);
}

export function captureAdminUserRetirementManagedPath(input: {
  targetUserId: string;
  managedRoot: string;
  targetPath: string;
  kind: AdminUserRetirementManagedPathKind;
}): AdminUserRetirementManagedPath {
  const root = absoluteNormalized(input.managedRoot, 'Managed retirement root');
  const target = absoluteNormalized(input.targetPath, 'Managed retirement target');
  if (
    input.kind !== 'FILE'
    && input.kind !== 'DIRECTORY'
    && input.kind !== 'CONTAINER_DIRECTORY'
  ) {
    retirementIntegrity('Managed retirement target kind is invalid');
  }
  strictDescendant(root, target, 'Managed retirement target');
  const rootStat = assertSecureRoot(root);
  assertNoSymlinkComponents(root, target);
  const quarantinePath = deterministicQuarantinePath(root, input.targetUserId, target, input.kind);
  strictDescendant(root, quarantinePath, 'Managed retirement quarantine');
  if (target.startsWith(`${path.join(root, QUARANTINE_DIRECTORY)}${path.sep}`)) {
    retirementIntegrity('Managed retirement target cannot be inside the quarantine authority');
  }

  const stat = lstatOptional(target);
  if (!stat) {
    return Object.freeze({
      root,
      targetUserId: String(input.targetUserId).trim(),
      rootIdentity: filesystemIdentity(rootStat),
      path: target,
      quarantinePath,
      kind: input.kind,
      present: false,
      identity: null,
      size: null,
      sha256: null,
    });
  }
  if (stat.isSymbolicLink()) retirementIntegrity('Managed retirement target is symlinked');
  if (
    (input.kind === 'FILE' && (!stat.isFile() || stat.nlink !== 1n))
    || (input.kind !== 'FILE' && !stat.isDirectory())
  ) {
    retirementIntegrity('Managed retirement target kind changed');
  }
  const real = fs.realpathSync(target);
  strictDescendant(root, real, 'Managed retirement target realpath');
  const digest = input.kind === 'FILE'
    ? sha256File(target)
    : input.kind === 'DIRECTORY'
      ? sha256DirectoryTree(target)
      : null;
  return Object.freeze({
    root,
    targetUserId: String(input.targetUserId).trim(),
    rootIdentity: filesystemIdentity(rootStat),
    path: target,
    quarantinePath,
    kind: input.kind,
    present: true,
    identity: filesystemIdentity(stat),
    size: stat.size.toString(),
    sha256: digest,
  });
}

export function validateAdminUserRetirementManagedPath(
  value: AdminUserRetirementManagedPath,
): AdminUserRetirementManagedPath {
  if (!value || typeof value !== 'object') retirementIntegrity('Managed retirement target is invalid');
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    'root',
    'targetUserId',
    'rootIdentity',
    'path',
    'quarantinePath',
    'kind',
    'present',
    'identity',
    'size',
    'sha256',
  ].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    retirementIntegrity('Managed retirement target has an unknown or missing property');
  }
  const root = absoluteNormalized(value.root, 'Managed retirement root');
  const target = absoluteNormalized(value.path, 'Managed retirement target');
  const quarantine = absoluteNormalized(value.quarantinePath, 'Managed retirement quarantine');
  const targetUserId = String(value.targetUserId || '').trim();
  if (
    !targetUserId
    || targetUserId.length > 200
    || /[\u0000-\u001f\u007f]/.test(targetUserId)
  ) {
    retirementIntegrity('Managed retirement target user identity is invalid');
  }
  strictDescendant(root, target, 'Managed retirement target');
  strictDescendant(root, quarantine, 'Managed retirement quarantine');
  if (
    value.kind !== 'FILE'
    && value.kind !== 'DIRECTORY'
    && value.kind !== 'CONTAINER_DIRECTORY'
  ) {
    retirementIntegrity('Managed retirement target kind is invalid');
  }
  if (quarantine !== deterministicQuarantinePath(root, targetUserId, target, value.kind)) {
    retirementIntegrity('Managed retirement quarantine path is not deterministic');
  }
  validateFilesystemIdentity(value.rootIdentity, 'Managed retirement root');
  if (typeof value.present !== 'boolean') retirementIntegrity('Managed retirement presence is invalid');
  if (value.present) {
    if (!value.identity) retirementIntegrity('Present managed retirement target lacks identity');
    validateFilesystemIdentity(value.identity, 'Managed retirement target');
    if (!/^[0-9]+$/.test(String(value.size || ''))) {
      retirementIntegrity('Managed retirement target size is invalid');
    }
    if (
      (value.kind === 'FILE' || value.kind === 'DIRECTORY')
      && !SHA256_RE.test(String(value.sha256 || ''))
    ) {
      retirementIntegrity('Managed retirement content digest is invalid');
    }
    if (value.kind === 'CONTAINER_DIRECTORY' && value.sha256 !== null) {
      retirementIntegrity('Managed retirement container cannot carry a tree digest');
    }
  } else if (value.identity !== null || value.size !== null || value.sha256 !== null) {
    retirementIntegrity('Absent managed retirement target carries mutable identity');
  }
  return value;
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensureQuarantineDirectory(attestation: AdminUserRetirementManagedPath): string {
  const quarantineRoot = path.dirname(attestation.quarantinePath);
  const existing = lstatOptional(quarantineRoot);
  if (!existing) {
    fs.mkdirSync(quarantineRoot, { mode: 0o700 });
    fsyncDirectory(attestation.root);
  }
  const stat = fs.lstatSync(quarantineRoot, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077n) !== 0n) {
    retirementIntegrity('Managed retirement quarantine root is unsafe');
  }
  const real = fs.realpathSync(quarantineRoot);
  strictDescendant(attestation.root, real, 'Managed retirement quarantine root');
  return quarantineRoot;
}

function assertCurrentTargetIdentity(
  attestation: AdminUserRetirementManagedPath,
  targetPath: string,
): fs.BigIntStats {
  assertNoSymlinkComponents(attestation.root, targetPath);
  const stat = lstatOptional(targetPath);
  if (!stat || !attestation.identity) retirementIntegrity('Managed retirement target disappeared unexpectedly');
  if (stat.isSymbolicLink()) retirementIntegrity('Managed retirement target became a symlink');
  if (
    (attestation.kind === 'FILE' && (!stat.isFile() || stat.nlink !== 1n))
    || (attestation.kind !== 'FILE' && !stat.isDirectory())
    || !identitiesMatch(filesystemIdentity(stat), attestation.identity)
    || (attestation.kind === 'FILE' && stat.size.toString() !== attestation.size)
  ) {
    retirementIntegrity('Managed retirement target identity changed');
  }
  if (attestation.kind === 'FILE' && sha256File(targetPath) !== attestation.sha256) {
    retirementIntegrity('Managed retirement file content changed');
  }
  if (
    attestation.kind === 'DIRECTORY'
    && sha256DirectoryTree(targetPath) !== attestation.sha256
  ) {
    retirementIntegrity('Managed retirement directory content changed');
  }
  if (
    attestation.kind === 'CONTAINER_DIRECTORY'
    && fs.readdirSync(targetPath).length !== 0
  ) {
    retirementIntegrity('Managed retirement container is not empty');
  }
  return stat;
}

/**
 * Idempotent two-boundary removal. The exact target is first renamed onto the
 * same filesystem under a deterministic private authority, then removed. A
 * crash before or after either boundary resumes from source/quarantine state;
 * source plus quarantine is treated as ambiguity and never guessed through.
 */
export async function retireAdminUserManagedPath(
  candidate: AdminUserRetirementManagedPath,
  hooks: ManagedPathMutationHooks = {},
): Promise<void> {
  const attestation = validateAdminUserRetirementManagedPath(candidate);
  assertSecureRoot(attestation.root, attestation.rootIdentity);
  const sourceStat = lstatOptional(attestation.path);
  const quarantineStat = lstatOptional(attestation.quarantinePath);

  if (!attestation.present) {
    if (sourceStat || quarantineStat) {
      retirementIntegrity('State appeared at a previously absent managed retirement target');
    }
    return;
  }
  if (sourceStat && quarantineStat) {
    retirementIntegrity('Managed retirement source and quarantine both exist');
  }

  let currentQuarantineStat = quarantineStat;
  if (sourceStat) {
    assertCurrentTargetIdentity(attestation, attestation.path);
    const quarantineRoot = ensureQuarantineDirectory(attestation);
    if (lstatOptional(attestation.quarantinePath)) {
      retirementIntegrity('Managed retirement quarantine appeared before rename');
    }
    fs.renameSync(attestation.path, attestation.quarantinePath);
    fsyncDirectory(path.dirname(attestation.path));
    if (quarantineRoot !== path.dirname(attestation.path)) fsyncDirectory(quarantineRoot);
    currentQuarantineStat = lstatOptional(attestation.quarantinePath);
    await hooks.afterRename?.();
  }

  if (currentQuarantineStat) {
    assertCurrentTargetIdentity(attestation, attestation.quarantinePath);
    if (attestation.kind === 'DIRECTORY') {
      fs.rmSync(attestation.quarantinePath, {
        recursive: true,
        force: false,
        maxRetries: 2,
        retryDelay: 50,
      });
    } else if (attestation.kind === 'CONTAINER_DIRECTORY') {
      fs.rmdirSync(attestation.quarantinePath);
    } else {
      fs.unlinkSync(attestation.quarantinePath);
    }
    fsyncDirectory(path.dirname(attestation.quarantinePath));
  }
  await assertAdminUserManagedPathAbsent(attestation);
}

export async function assertAdminUserManagedPathAbsent(
  candidate: AdminUserRetirementManagedPath,
): Promise<void> {
  const attestation = validateAdminUserRetirementManagedPath(candidate);
  assertSecureRoot(attestation.root, attestation.rootIdentity);
  if (lstatOptional(attestation.path) || lstatOptional(attestation.quarantinePath)) {
    retirementIntegrity('Managed retirement target or quarantine is still present');
  }
}

export function digestAdminUserRetirementManagedPathAbsence(
  targets: readonly AdminUserRetirementManagedPath[],
): string {
  const normalized = targets
    .map((target) => validateAdminUserRetirementManagedPath(target))
    .map((target) => ({
      root: target.root,
      targetUserId: target.targetUserId,
      rootIdentity: target.rootIdentity,
      path: target.path,
      quarantinePath: target.quarantinePath,
      kind: target.kind,
      absent: true,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export const adminUserRetirementManagedPathPolicy = Object.freeze({
  quarantineDirectory: QUARANTINE_DIRECTORY,
});
