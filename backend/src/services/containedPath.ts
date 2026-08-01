import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export class ContainedPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainedPathError';
  }
}

export type ContainedPathKind = 'file' | 'directory' | 'any';

export interface ResolveContainedPathOptions {
  mustExist?: boolean;
  allowRoot?: boolean;
  kind?: ContainedPathKind;
}

function assertSafeRelativePath(requestedPath: unknown): string {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    throw new ContainedPathError('A relative path is required');
  }
  if (requestedPath.includes('\0') || requestedPath.includes('\\')) {
    throw new ContainedPathError('Invalid path encoding');
  }
  if (path.isAbsolute(requestedPath)) {
    throw new ContainedPathError('Absolute paths are not allowed');
  }

  const parts = requestedPath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new ContainedPathError('Invalid path segment');
  }
  return parts.join(path.sep);
}

export function isPathContained(baseDir: string, candidatePath: string): boolean {
  const base = path.resolve(baseDir);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertEntryKind(entryPath: string, kind: ContainedPathKind): void {
  if (kind === 'any') return;
  const stat = fs.lstatSync(entryPath);
  if (kind === 'file' && !stat.isFile()) {
    throw new ContainedPathError('Path is not a regular file');
  }
  if (kind === 'directory' && !stat.isDirectory()) {
    throw new ContainedPathError('Path is not a directory');
  }
}

/**
 * Resolve a user-controlled relative path beneath an existing root.
 *
 * Every existing component is checked with lstat and realpath. Symbolic links
 * are rejected rather than followed, including a symlink at the final path.
 * Missing tails are allowed only when mustExist is false, and are anchored to
 * the last canonical, existing directory.
 */
export function resolveContainedPath(
  baseDir: string,
  requestedPath: unknown,
  options: ResolveContainedPathOptions = {},
): string {
  const base = path.resolve(baseDir);
  const baseStat = fs.lstatSync(base);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    throw new ContainedPathError('Containment root must be a real directory');
  }
  const canonicalBase = fs.realpathSync(base);
  const relativePath = assertSafeRelativePath(requestedPath);
  const parts = relativePath.split(path.sep);
  let current = canonicalBase;
  let missing = false;

  for (const part of parts) {
    const next = path.join(current, part);
    if (!isPathContained(canonicalBase, next)) {
      throw new ContainedPathError('Path escapes containment root');
    }

    let stat: fs.Stats | undefined;
    if (!missing) {
      try {
        stat = fs.lstatSync(next);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }

    if (stat) {
      if (stat.isSymbolicLink()) {
        throw new ContainedPathError('Symbolic links are not allowed');
      }
      const canonical = fs.realpathSync(next);
      if (!isPathContained(canonicalBase, canonical)) {
        throw new ContainedPathError('Canonical path escapes containment root');
      }
      current = canonical;
    } else {
      missing = true;
      current = next;
    }
  }

  if (options.mustExist && missing) {
    throw new ContainedPathError('Path does not exist');
  }
  if (!options.allowRoot && path.resolve(current) === canonicalBase) {
    throw new ContainedPathError('Containment root cannot be selected');
  }
  if (!missing) {
    assertEntryKind(current, options.kind || 'any');
  }
  return current;
}

/** Create missing directories one component at a time and reject link swaps. */
export function ensureContainedDirectory(baseDir: string, requestedPath: string): string {
  const base = path.resolve(baseDir);
  const baseStat = fs.lstatSync(base);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    throw new ContainedPathError('Containment root must be a real directory');
  }
  const canonicalBase = fs.realpathSync(base);
  const relative = assertSafeRelativePath(requestedPath);
  let current = canonicalBase;

  for (const part of relative.split(path.sep)) {
    const next = path.join(current, part);
    if (!isPathContained(canonicalBase, next)) {
      throw new ContainedPathError('Path escapes containment root');
    }
    try {
      fs.mkdirSync(next, { mode: 0o700 });
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(next);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ContainedPathError('Directory path contains a non-directory or symbolic link');
    }
    current = fs.realpathSync(next);
    if (!isPathContained(canonicalBase, current)) {
      throw new ContainedPathError('Canonical directory escapes containment root');
    }
  }
  return current;
}

/**
 * Atomically replace/create a regular file without ever opening the requested
 * final path for writing. This prevents a final-component symlink from being
 * followed and leaves either the old file or the complete new file visible.
 */
export function writeContainedFileAtomic(
  baseDir: string,
  requestedPath: string,
  content: string | Buffer,
  options: { encoding?: BufferEncoding; exclusive?: boolean; maxBytes?: number } = {},
): string {
  const relative = assertSafeRelativePath(requestedPath);
  const parentRelative = path.dirname(relative);
  const parent = parentRelative === '.'
    ? fs.realpathSync(path.resolve(baseDir))
    : ensureContainedDirectory(baseDir, parentRelative.split(path.sep).join('/'));
  const fileName = path.basename(relative);
  const finalPath = resolveContainedPath(baseDir, relative.split(path.sep).join('/'), { mustExist: false });

  let finalStat: fs.Stats | undefined;
  try {
    finalStat = fs.lstatSync(finalPath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (finalStat) {
    if (finalStat.isSymbolicLink() || !finalStat.isFile()) {
      throw new ContainedPathError('Destination is not a regular file');
    }
    if (options.exclusive) throw new ContainedPathError('Destination already exists');
  }

  const byteLength = Buffer.isBuffer(content)
    ? content.length
    : Buffer.byteLength(content, options.encoding || 'utf8');
  if (options.maxBytes !== undefined && byteLength > options.maxBytes) {
    throw new ContainedPathError('File content exceeds the configured limit');
  }

  const tempPath = path.join(parent, `.${fileName}.portal-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW || 0);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, flags, 0o600);
    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(fd, content);
    } else {
      fs.writeFileSync(fd, content, { encoding: options.encoding || 'utf8' });
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    // Revalidate the parent immediately before the atomic rename.
    const canonicalParent = fs.realpathSync(parent);
    if (!isPathContained(fs.realpathSync(path.resolve(baseDir)), canonicalParent)) {
      throw new ContainedPathError('Destination parent escaped containment root');
    }
    fs.renameSync(tempPath, finalPath);
    return finalPath;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

export function safeRelativePath(baseDir: string, candidatePath: string): string {
  if (!isPathContained(baseDir, candidatePath)) {
    throw new ContainedPathError('Path escapes containment root');
  }
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidatePath));
  return relative.split(path.sep).join('/');
}
