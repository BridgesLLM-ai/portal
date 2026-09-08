import fs from 'fs';
import {
  ContainedPathError,
  openContainedRegularFile,
  writeContainedFileAtomic,
} from './containedPath';
import { writeProjectRuntimeOwnedFileAtomic } from './projectRuntimeOwnership';

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
  const opened = openProjectRegularFile(projectRoot, relativePath, options);
  if (!opened) return null;
  try { return opened.stat; } finally { fs.closeSync(opened.fd); }
}

/** The caller owns the returned descriptor and must never reopen its pathname. */
export function openProjectRegularFile(
  projectRoot: string,
  relativePath: string,
  options: ReadProjectTextOptions = {},
): { fd: number; stat: fs.Stats } | null {
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)) {
    throw new ProjectFilePolicyError('TOO_LARGE', `${relativePath} has an invalid metadata limit`);
  }
  let opened: { fd: number; stat: fs.Stats };
  try {
    opened = openContainedRegularFile(projectRoot, relativePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT' && options.optional) return null;
    if (error instanceof ContainedPathError || error?.code === 'ELOOP' || error?.code === 'ENOTDIR') {
      throw new ProjectFilePolicyError('INVALID_PATH', 'A regular, contained project file is required');
    }
    throw error;
  }
  if (options.maxBytes !== undefined && opened.stat.size > options.maxBytes) {
    fs.closeSync(opened.fd);
    throw new ProjectFilePolicyError('TOO_LARGE', `${relativePath} exceeds the ${options.maxBytes}-byte metadata limit`);
  }
  return opened;
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
  const entry = openProjectRegularFile(projectRoot, relativePath, { ...options, maxBytes });
  if (!entry) return null;
  const { fd, stat: opened } = entry;
  try {
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
    fs.closeSync(fd);
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

/** Write Portal-managed Project content for the confined provider identity. */
export function writeProjectRuntimeTextFile(
  projectRoot: string,
  relativePath: string,
  content: string,
  maxBytes = PROJECT_DOCUMENT_MAX_BYTES,
): string {
  try {
    return writeProjectRuntimeOwnedFileAtomic(projectRoot, relativePath, content, { maxBytes });
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
