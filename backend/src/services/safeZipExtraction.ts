import fs from 'fs';
import path from 'path';
import extract from 'extract-zip';
import { isPathContained } from './containedPath';

const ZIP_IFMT = 0o170000;
const ZIP_IFLNK = 0o120000;

export interface SafeZipLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
  maxCompressionRatio: number;
  maxPathDepth: number;
  maxPathBytes: number;
}

export const PROJECT_ZIP_LIMITS: SafeZipLimits = {
  maxArchiveBytes: 200 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 128 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxPathDepth: 32,
  maxPathBytes: 1024,
};

export const APP_ZIP_LIMITS: SafeZipLimits = {
  ...PROJECT_ZIP_LIMITS,
};

export class UnsafeZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeZipError';
  }
}

interface ZipEntryLike {
  fileName: string;
  compressedSize: number;
  uncompressedSize: number;
  externalFileAttributes: number;
  generalPurposeBitFlag: number;
}

export interface ZipValidationState {
  entries: number;
  expandedBytes: number;
  paths: Set<string>;
}

export function createZipValidationState(): ZipValidationState {
  return { entries: 0, expandedBytes: 0, paths: new Set() };
}

export function validateZipEntry(
  entry: ZipEntryLike,
  state: ZipValidationState,
  limits: SafeZipLimits,
): void {
  if (!entry || typeof entry.fileName !== 'string' || entry.fileName.includes('\0') || entry.fileName.includes('\\')) {
    throw new UnsafeZipError('ZIP contains an invalid entry name');
  }
  if (Buffer.byteLength(entry.fileName, 'utf8') > limits.maxPathBytes) {
    throw new UnsafeZipError('ZIP entry path is too long');
  }
  if (entry.fileName.startsWith('/') || /^[a-zA-Z]:\//.test(entry.fileName)) {
    throw new UnsafeZipError('ZIP contains an absolute path');
  }
  const trimmed = entry.fileName.endsWith('/') ? entry.fileName.slice(0, -1) : entry.fileName;
  const parts = trimmed.split('/');
  if (!trimmed || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new UnsafeZipError('ZIP contains a traversal or ambiguous path');
  }
  if (parts.length > limits.maxPathDepth) {
    throw new UnsafeZipError('ZIP entry path is too deeply nested');
  }

  const normalized = parts.join('/');
  if (state.paths.has(normalized)) {
    throw new UnsafeZipError(`ZIP contains a duplicate entry: ${normalized}`);
  }
  state.paths.add(normalized);

  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if ((mode & ZIP_IFMT) === ZIP_IFLNK) {
    throw new UnsafeZipError('ZIP symbolic links are not allowed');
  }
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new UnsafeZipError('Encrypted ZIP entries are not supported');
  }
  if (!Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0
      || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
    throw new UnsafeZipError('ZIP entry sizes are invalid');
  }
  if (entry.uncompressedSize > limits.maxEntryBytes) {
    throw new UnsafeZipError('ZIP entry exceeds the expanded-size limit');
  }
  const ratio = entry.compressedSize === 0
    ? (entry.uncompressedSize === 0 ? 1 : Number.POSITIVE_INFINITY)
    : entry.uncompressedSize / entry.compressedSize;
  if (ratio > limits.maxCompressionRatio) {
    throw new UnsafeZipError('ZIP entry exceeds the compression-ratio limit');
  }

  state.entries += 1;
  state.expandedBytes += entry.uncompressedSize;
  if (state.entries > limits.maxEntries) throw new UnsafeZipError('ZIP contains too many entries');
  if (state.expandedBytes > limits.maxExpandedBytes) throw new UnsafeZipError('ZIP exceeds the expanded-size limit');
}

function auditExtractedTree(root: string, limits: SafeZipLimits): void {
  const canonicalRoot = fs.realpathSync(root);
  let entries = 0;
  let bytes = 0;

  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new UnsafeZipError('Extracted ZIP contains a symbolic link');
      const canonical = fs.realpathSync(fullPath);
      if (!isPathContained(canonicalRoot, canonical)) throw new UnsafeZipError('Extracted path escaped its staging root');
      entries += 1;
      if (entries > limits.maxEntries) throw new UnsafeZipError('Extracted ZIP contains too many entries');
      if (stat.isDirectory()) {
        fs.chmodSync(canonical, 0o755);
        walk(canonical);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (stat.size > limits.maxEntryBytes || bytes > limits.maxExpandedBytes) {
          throw new UnsafeZipError('Extracted ZIP exceeds its size limit');
        }
        fs.chmodSync(canonical, (stat.mode & 0o111) !== 0 ? 0o755 : 0o644);
      } else {
        throw new UnsafeZipError('Extracted ZIP contains a special filesystem entry');
      }
    }
  };
  walk(canonicalRoot);
}

function collapseSingleRootDirectory(stagingDir: string): void {
  const entries = fs.readdirSync(stagingDir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) return;
  const nested = path.join(stagingDir, entries[0].name);
  const nestedStat = fs.lstatSync(nested);
  if (nestedStat.isSymbolicLink()) throw new UnsafeZipError('ZIP root cannot be a symbolic link');
  for (const child of fs.readdirSync(nested)) {
    fs.renameSync(path.join(nested, child), path.join(stagingDir, child));
  }
  fs.rmdirSync(nested);
}

export async function safeExtractZipToNewDirectory(
  zipPath: string,
  destinationDir: string,
  options: {
    limits?: SafeZipLimits;
    collapseSingleRoot?: boolean;
    existingEmptyDirectory?: boolean;
  } = {},
): Promise<void> {
  const limits = options.limits || PROJECT_ZIP_LIMITS;
  const zipStat = fs.lstatSync(zipPath);
  if (zipStat.isSymbolicLink() || !zipStat.isFile()) throw new UnsafeZipError('ZIP source must be a regular file');
  if (zipStat.size <= 0 || zipStat.size > limits.maxArchiveBytes) throw new UnsafeZipError('ZIP archive size is outside the allowed range');

  const destination = path.resolve(destinationDir);
  const parent = path.dirname(destination);
  const parentStat = fs.lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new UnsafeZipError('ZIP destination parent must be a real directory');
  }
  const canonicalParent = fs.realpathSync(parent);
  if (!isPathContained(canonicalParent, destination)) throw new UnsafeZipError('ZIP destination escaped its parent');
  const existingDestination = fs.existsSync(destination);
  if (existingDestination && !options.existingEmptyDirectory) {
    throw new UnsafeZipError('ZIP destination already exists');
  }
  let destinationIdentity: { dev: bigint; ino: bigint; birthtimeNs: bigint } | null = null;
  let canonicalDestination: string | null = null;
  if (existingDestination) {
    const destinationStat = fs.lstatSync(destination, { bigint: true });
    if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
      throw new UnsafeZipError('Existing ZIP destination must be a real directory');
    }
    if (fs.readdirSync(destination).length !== 0) {
      throw new UnsafeZipError('Existing ZIP destination must be empty');
    }
    destinationIdentity = {
      dev: destinationStat.dev,
      ino: destinationStat.ino,
      birthtimeNs: destinationStat.birthtimeNs,
    };
    canonicalDestination = fs.realpathSync(destination);
  }

  // Existing destinations are durable, attested Project creation roots. Keep
  // their extraction scratch inside that root so a process-kill cannot leave
  // an unclaimed nonempty sibling that blocks startup recovery. Destinations
  // that do not exist still use sibling staging for atomic rename publication.
  const stagingDir = destinationIdentity
    ? fs.mkdtempSync(path.join(destination, '.portal-zip-extract-'))
    : fs.mkdtempSync(path.join(canonicalParent, `.${path.basename(destination)}.extract-`));
  fs.chmodSync(stagingDir, 0o700);
  const validation = createZipValidationState();
  try {
    if (destinationIdentity) {
      const current = fs.lstatSync(destination, { bigint: true });
      const stagingName = path.basename(stagingDir);
      const destinationEntries = fs.readdirSync(destination);
      if (
        current.isSymbolicLink()
        || !current.isDirectory()
        || current.dev !== destinationIdentity.dev
        || current.ino !== destinationIdentity.ino
        || current.birthtimeNs !== destinationIdentity.birthtimeNs
        || destinationEntries.length !== 1
        || destinationEntries[0] !== stagingName
        || path.dirname(fs.realpathSync(stagingDir)) !== canonicalDestination
      ) {
        throw new UnsafeZipError('Existing ZIP destination changed before extraction');
      }
    }
    await extract(zipPath, {
      dir: stagingDir,
      onEntry: (entry: ZipEntryLike) => validateZipEntry(entry, validation, limits),
      defaultDirMode: 0o755,
      defaultFileMode: 0o644,
    });
    if (validation.entries === 0) throw new UnsafeZipError('ZIP archive is empty');
    auditExtractedTree(stagingDir, limits);
    if (options.collapseSingleRoot) collapseSingleRootDirectory(stagingDir);
    auditExtractedTree(stagingDir, limits);
    // Preserve the existing Project/App runtime contract after the private
    // staging phase: containerized project tools and the app server must be
    // able to traverse the promoted root.
    fs.chmodSync(stagingDir, 0o755);
    if (destinationIdentity) {
      const current = fs.lstatSync(destination, { bigint: true });
      const stagingName = path.basename(stagingDir);
      const destinationEntries = fs.readdirSync(destination);
      if (
        current.isSymbolicLink()
        || !current.isDirectory()
        || current.dev !== destinationIdentity.dev
        || current.ino !== destinationIdentity.ino
        || current.birthtimeNs !== destinationIdentity.birthtimeNs
        || destinationEntries.length !== 1
        || destinationEntries[0] !== stagingName
        || path.dirname(fs.realpathSync(stagingDir)) !== canonicalDestination
      ) {
        throw new UnsafeZipError('Existing ZIP destination changed during extraction');
      }
      for (const child of fs.readdirSync(stagingDir)) {
        const target = path.join(destination, child);
        if (fs.existsSync(target)) {
          throw new UnsafeZipError('Existing ZIP destination changed during promotion');
        }
        fs.renameSync(path.join(stagingDir, child), target);
      }
      fs.chmodSync(destination, 0o755);
      fs.rmdirSync(stagingDir);
    } else {
      fs.renameSync(stagingDir, destination);
    }
  } catch (error) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    throw error;
  }
}
