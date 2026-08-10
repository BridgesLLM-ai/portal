import fs from 'fs';
import path from 'path';
import {
  ContainedPathError,
  ensureContainedDirectory,
  resolveContainedPath,
  writeContainedFileAtomic,
} from './containedPath';
import {
  PROJECT_RUNTIME_GID,
  PROJECT_RUNTIME_UID,
} from './projectRuntimeIdentity';

const PROJECT_RUNTIME_OWNERSHIP = Object.freeze({
  uid: PROJECT_RUNTIME_UID,
  gid: PROJECT_RUNTIME_GID,
});

export class ProjectRuntimeOwnershipError extends Error {
  readonly code = 'PROJECT_RUNTIME_OWNERSHIP_FAILED';
  readonly retryable = true;

  constructor(message = 'Project file ownership could not be assigned safely.') {
    super(message);
    this.name = 'ProjectRuntimeOwnershipError';
  }
}

function relativeProjectPath(projectRoot: string, candidate: string): string {
  const root = path.resolve(projectRoot);
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ProjectRuntimeOwnershipError();
  }
  return relative.split(path.sep).join('/');
}

function translateOwnershipError(error: unknown): never {
  if (error instanceof ProjectRuntimeOwnershipError) throw error;
  const translated = new ProjectRuntimeOwnershipError();
  (translated as Error & { cause?: unknown }).cause = error;
  throw translated;
}

/**
 * Create/revalidate a directory chain beneath the exact canonical Project root
 * and assign every traversed component to the confined provider identity.
 * Descriptor-based chown plus O_NOFOLLOW prevents a repository-controlled
 * symlink swap from redirecting root ownership changes outside the Project.
 */
export function ensureProjectRuntimeOwnedDirectory(
  projectRoot: string,
  relativePath: string,
): string {
  try {
    return ensureContainedDirectory(projectRoot, relativePath, {
      ownership: PROJECT_RUNTIME_OWNERSHIP,
    });
  } catch (error) {
    return translateOwnershipError(error);
  }
}

/** Assign only one already-existing Project entry, never a recursive tree. */
export function assignProjectRuntimeOwnership(
  projectRoot: string,
  candidate: string,
  kind: 'file' | 'directory' = 'file',
): string {
  try {
    const relative = path.isAbsolute(candidate)
      ? relativeProjectPath(projectRoot, candidate)
      : candidate;
    const parent = path.posix.dirname(relative.replace(/\\/g, '/'));
    if (parent !== '.') ensureProjectRuntimeOwnedDirectory(projectRoot, parent);
    const target = resolveContainedPath(projectRoot, relative, { mustExist: true, kind });
    const expected = fs.lstatSync(target);
    if (expected.isSymbolicLink() || (kind === 'file' ? !expected.isFile() : !expected.isDirectory())) {
      throw new ContainedPathError('Project ownership target has an invalid type');
    }
    const flags = fs.constants.O_RDONLY
      | (kind === 'directory' ? (fs.constants.O_DIRECTORY || 0) : 0)
      | (fs.constants.O_NOFOLLOW || 0);
    const descriptor = fs.openSync(target, flags);
    try {
      const opened = fs.fstatSync(descriptor);
      if (
        opened.dev !== expected.dev
        || opened.ino !== expected.ino
        || (kind === 'file' ? !opened.isFile() : !opened.isDirectory())
      ) {
        throw new ContainedPathError('Project ownership target changed while it was being opened');
      }
      fs.fchownSync(descriptor, PROJECT_RUNTIME_UID, PROJECT_RUNTIME_GID);
    } finally {
      fs.closeSync(descriptor);
    }
    return target;
  } catch (error) {
    return translateOwnershipError(error);
  }
}

/**
 * Atomic Project file creation/replacement with ownership applied to the
 * unopened temporary inode before it becomes visible at the final path.
 */
export function writeProjectRuntimeOwnedFileAtomic(
  projectRoot: string,
  relativePath: string,
  content: string | Buffer,
  options: { encoding?: BufferEncoding; exclusive?: boolean; maxBytes?: number } = {},
): string {
  try {
    return writeContainedFileAtomic(projectRoot, relativePath, content, {
      ...options,
      ownership: PROJECT_RUNTIME_OWNERSHIP,
    });
  } catch (error) {
    if (error instanceof ContainedPathError) throw error;
    return translateOwnershipError(error);
  }
}

export const __projectRuntimeOwnershipTest = {
  ownership: PROJECT_RUNTIME_OWNERSHIP,
};
