import fs from 'fs';
import {
  ContainedPathError,
  resolveContainedPath,
  writeContainedFileAtomic,
} from './containedPath';

export const PROJECT_METADATA_MAX_BYTES = 1024 * 1024;
export const PROJECT_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;

export class ProjectFilePolicyError extends Error {
  readonly code: 'INVALID_PATH' | 'NOT_REGULAR' | 'TOO_LARGE';

  constructor(code: ProjectFilePolicyError['code'], message: string) {
    super(message);
    this.name = 'ProjectFilePolicyError';
    this.code = code;
  }
}

export interface ReadProjectTextOptions {
  optional?: boolean;
  maxBytes?: number;
}

export function statProjectRegularFile(
  projectRoot: string,
  relativePath: string,
  options: ReadProjectTextOptions = {},
): fs.Stats | null {
  let candidate: string;
  try {
    candidate = resolveContainedPath(projectRoot, relativePath, { mustExist: false });
  } catch (error) {
    if (error instanceof ContainedPathError) {
      throw new ProjectFilePolicyError('INVALID_PATH', error.message);
    }
    throw error;
  }

  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(candidate);
  } catch (error: any) {
    if (error?.code === 'ENOENT' && options.optional) return null;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new ProjectFilePolicyError('NOT_REGULAR', `${relativePath} must be a regular project file`);
  }
  if (options.maxBytes !== undefined && entry.size > options.maxBytes) {
    throw new ProjectFilePolicyError('TOO_LARGE', `${relativePath} exceeds the ${options.maxBytes}-byte metadata limit`);
  }
  // Revalidate containment after the stat so a link swap cannot be consumed by
  // the caller as a trusted project file.
  try {
    resolveContainedPath(projectRoot, relativePath, { mustExist: true, kind: 'file' });
  } catch (error) {
    if (error instanceof ContainedPathError) {
      throw new ProjectFilePolicyError('INVALID_PATH', error.message);
    }
    throw error;
  }
  return entry;
}

/**
 * Read a small project-owned metadata file without following repository-created
 * links. Project repositories are untrusted input, so even seemingly harmless
 * reads such as package.json or requirements.txt must remain inside the exact
 * canonical project root.
 */
export function readProjectTextFile(
  projectRoot: string,
  relativePath: string,
  options: ReadProjectTextOptions = {},
): string | null {
  const maxBytes = options.maxBytes ?? PROJECT_METADATA_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new ProjectFilePolicyError('TOO_LARGE', `${relativePath} has an invalid metadata limit`);
  }
  const entry = statProjectRegularFile(projectRoot, relativePath, { ...options, maxBytes });
  if (!entry) return null;

  let resolved: string;
  try {
    resolved = resolveContainedPath(projectRoot, relativePath, { mustExist: true, kind: 'file' });
  } catch (error) {
    if (error instanceof ContainedPathError) {
      throw new ProjectFilePolicyError('INVALID_PATH', error.message);
    }
    throw error;
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd: number | undefined;
  try {
    fd = fs.openSync(resolved, flags);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) {
      throw new ProjectFilePolicyError('NOT_REGULAR', `${relativePath} changed while it was being opened`);
    }
    if (opened.size > maxBytes) {
      throw new ProjectFilePolicyError('TOO_LARGE', `${relativePath} exceeds the ${maxBytes}-byte metadata limit`);
    }

    // Bound the read itself as well as the preflight stat. A repository process
    // may still append to a regular file after it has been opened.
    const buffer = Buffer.alloc(Math.min(opened.size, maxBytes) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new ProjectFilePolicyError('TOO_LARGE', `${relativePath} exceeds the ${maxBytes}-byte metadata limit`);
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function writeProjectTextFile(
  projectRoot: string,
  relativePath: string,
  content: string,
  maxBytes = PROJECT_DOCUMENT_MAX_BYTES,
): string {
  try {
    return writeContainedFileAtomic(projectRoot, relativePath, content, { maxBytes });
  } catch (error) {
    if (error instanceof ContainedPathError) {
      const code = /exceeds the configured limit/i.test(error.message) ? 'TOO_LARGE' : 'INVALID_PATH';
      throw new ProjectFilePolicyError(code, error.message);
    }
    throw error;
  }
}

export interface ProjectByteRange {
  start: number;
  end: number;
}

export class ProjectRangeError extends Error {
  constructor(message = 'Requested byte range is not satisfiable') {
    super(message);
    this.name = 'ProjectRangeError';
  }
}

/** Parse one RFC 7233 byte range. Multipart ranges are intentionally rejected. */
export function parseProjectByteRange(rangeHeader: unknown, size: number): ProjectByteRange | null {
  if (rangeHeader === undefined || rangeHeader === null || rangeHeader === '') return null;
  if (typeof rangeHeader !== 'string' || !Number.isSafeInteger(size) || size < 0) {
    throw new ProjectRangeError();
  }
  if (size === 0 || rangeHeader.includes(',')) throw new ProjectRangeError();
  const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) throw new ProjectRangeError();

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new ProjectRangeError();
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || requestedEnd < start
    || start >= size
  ) {
    throw new ProjectRangeError();
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export function safeProjectDownloadName(projectName: string, mode: string): string {
  const base = `${projectName}-${mode}`
    .replace(/[\u0000-\u001f\u007f"\\/]/g, '_')
    .slice(0, 180)
    || 'project';
  return `${base}.zip`;
}
