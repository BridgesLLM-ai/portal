import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { crc32 } from 'zlib';
import * as yauzl from 'yauzl';
import { isPathContained } from './containedPath';

const ZIP_IFMT = 0o170000;
const ZIP_IFREG = 0o100000;
const ZIP_IFDIR = 0o040000;
const ZIP_IFLNK = 0o120000;
const ZIP_DOS_DIRECTORY = 0x10;

export interface SafeZipLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
  maxMetadataBytes: number;
  maxCompressionRatio: number;
  maxPathDepth: number;
  maxPathBytes: number;
}

export const PROJECT_ZIP_LIMITS: SafeZipLimits = {
  maxArchiveBytes: 200 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 128 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxMetadataBytes: 32 * 1024 * 1024,
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
  compressionMethod?: number;
  fileNameLength?: number;
  extraFieldLength?: number;
  fileCommentLength?: number;
}

export interface ZipValidationState {
  entries: number;
  expandedBytes: number;
  metadataBytes: number;
  paths: Set<string>;
}

interface ZipPathKinds {
  filePaths: Set<string>;
  directoryPaths: Set<string>;
}

const zipPathKinds = new WeakMap<ZipValidationState, ZipPathKinds>();

export function createZipValidationState(): ZipValidationState {
  const state = {
    entries: 0,
    expandedBytes: 0,
    metadataBytes: 0,
    paths: new Set<string>(),
  };
  zipPathKinds.set(state, {
    filePaths: new Set(),
    directoryPaths: new Set(),
  });
  return state;
}

function getZipPathKinds(state: ZipValidationState): ZipPathKinds {
  let kinds = zipPathKinds.get(state);
  if (!kinds) {
    // Preserve compatibility for callers that constructed the original public
    // validation-state shape themselves. Treat preexisting paths as files,
    // which is the conservative collision policy when their kinds are unknown.
    kinds = { filePaths: new Set(state.paths), directoryPaths: new Set() };
    zipPathKinds.set(state, kinds);
  }
  return kinds;
}

function zipEntryMode(entry: ZipEntryLike): number {
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

function zipEntryIsDirectory(entry: ZipEntryLike): boolean {
  const unixType = zipEntryMode(entry) & ZIP_IFMT;
  return entry.fileName.endsWith('/')
    || unixType === ZIP_IFDIR
    || (entry.externalFileAttributes & ZIP_DOS_DIRECTORY) !== 0;
}

function normalizedZipEntryPath(fileName: string): string {
  return fileName.endsWith('/') ? fileName.slice(0, -1) : fileName;
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
  const metadataLengths = [
    entry.fileNameLength ?? Buffer.byteLength(entry.fileName, 'utf8'),
    entry.extraFieldLength ?? 0,
    entry.fileCommentLength ?? 0,
  ];
  if (metadataLengths.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new UnsafeZipError('ZIP entry metadata sizes are invalid');
  }
  state.metadataBytes += metadataLengths.reduce((sum, value) => sum + value, 0);
  if (state.metadataBytes > limits.maxMetadataBytes) {
    throw new UnsafeZipError('ZIP central-directory metadata exceeds its limit');
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

  const mode = zipEntryMode(entry);
  const unixType = mode & ZIP_IFMT;
  if (unixType === ZIP_IFLNK) {
    throw new UnsafeZipError('ZIP symbolic links are not allowed');
  }
  if (unixType !== 0 && unixType !== ZIP_IFREG && unixType !== ZIP_IFDIR) {
    throw new UnsafeZipError('ZIP special filesystem entries are not allowed');
  }
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new UnsafeZipError('Encrypted ZIP entries are not supported');
  }
  if (entry.compressionMethod !== undefined
      && entry.compressionMethod !== 0
      && entry.compressionMethod !== 8) {
    throw new UnsafeZipError('ZIP entry uses an unsupported compression method');
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

  const isDirectory = zipEntryIsDirectory(entry);
  const pathKinds = getZipPathKinds(state);
  const ancestors = parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'));
  if (ancestors.some((ancestor) => pathKinds.filePaths.has(ancestor))) {
    throw new UnsafeZipError(`ZIP contains a file/directory collision: ${normalized}`);
  }
  if (isDirectory) {
    if (pathKinds.filePaths.has(normalized)) {
      throw new UnsafeZipError(`ZIP contains a file/directory collision: ${normalized}`);
    }
    pathKinds.directoryPaths.add(normalized);
  } else {
    if (pathKinds.directoryPaths.has(normalized)) {
      throw new UnsafeZipError(`ZIP contains a file/directory collision: ${normalized}`);
    }
    pathKinds.filePaths.add(normalized);
  }
  for (const ancestor of ancestors) pathKinds.directoryPaths.add(ancestor);
  state.paths.add(normalized);

  state.entries += 1;
  state.expandedBytes += entry.uncompressedSize;
  if (state.entries > limits.maxEntries) throw new UnsafeZipError('ZIP contains too many entries');
  if (state.expandedBytes > limits.maxExpandedBytes) throw new UnsafeZipError('ZIP exceeds the expanded-size limit');
}

function isMacOsMetadataPath(relativePath: string): boolean {
  return relativePath === '__MACOSX' || relativePath.startsWith('__MACOSX/');
}

async function extractValidatedZip(
  zipPath: string,
  stagingDir: string,
  validation: ZipValidationState,
  limits: SafeZipLimits,
): Promise<void> {
  const zipOptions: yauzl.Options = {
    autoClose: false,
    strictFileNames: true,
    validateEntrySizes: true,
  };
  const validationZip = await yauzl.openPromise(zipPath, zipOptions);
  let extractableEntries = 0;
  try {
    // Do not create any archive-controlled path until every central-directory
    // entry has passed validation. This closes duplicate/symlink ordering bugs
    // where an earlier entry changes the meaning of a later destination path.
    for await (const entry of validationZip.eachEntry()) {
      validateZipEntry(entry, validation, limits);
      const relativePath = normalizedZipEntryPath(entry.fileName);
      if (isMacOsMetadataPath(relativePath)) continue;
      extractableEntries += 1;
    }
  } finally {
    validationZip.close();
  }

  if (extractableEntries === 0) throw new UnsafeZipError('ZIP archive is empty');

  // Reopen for a bounded second pass. Holding only the validation sets avoids
  // retaining attacker-controlled Entry buffers for a 200 MiB archive. The
  // caller re-attests the source inode and timestamps before publication, and
  // the private staging root contains any second-pass drift failure.
  const extractionZip = await yauzl.openPromise(zipPath, zipOptions);
  const extractionValidation = createZipValidationState();
  let observedExtractableEntries = 0;
  try {
    let observedExpandedBytes = 0;
    for await (const entry of extractionZip.eachEntry()) {
      validateZipEntry(entry, extractionValidation, limits);
      const relativePath = normalizedZipEntryPath(entry.fileName);
      if (isMacOsMetadataPath(relativePath)) continue;
      observedExtractableEntries += 1;

      const destination = path.resolve(stagingDir, relativePath);
      if (!isPathContained(stagingDir, destination)) {
        throw new UnsafeZipError('ZIP entry escaped its staging root');
      }

      if (zipEntryIsDirectory(entry)) {
        fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
        continue;
      }

      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
      const readStream = await extractionZip.openReadStreamPromise(entry);
      let observedEntryBytes = 0;
      let observedEntryCrc32 = 0;
      const byteLimiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          observedEntryBytes += chunk.length;
          observedExpandedBytes += chunk.length;
          observedEntryCrc32 = crc32(chunk, observedEntryCrc32);
          if (observedEntryBytes > limits.maxEntryBytes
              || observedExpandedBytes > limits.maxExpandedBytes) {
            callback(new UnsafeZipError('ZIP exceeds its observed expanded-size limit'));
            return;
          }
          callback(null, chunk);
        },
      });
      const executable = (zipEntryMode(entry) & 0o111) !== 0;
      const flags = fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW;
      let outputFd: number | null = null;
      try {
        const fileMode = executable ? 0o755 : 0o644;
        outputFd = fs.openSync(destination, flags, fileMode);
        fs.fchmodSync(outputFd, fileMode);
        const writeStream = fs.createWriteStream(destination, { fd: outputFd, autoClose: true });
        outputFd = null;
        await pipeline(readStream, byteLimiter, writeStream);
      } catch (error) {
        readStream.destroy();
        throw error;
      } finally {
        if (outputFd !== null) fs.closeSync(outputFd);
      }
      if (observedEntryBytes !== entry.uncompressedSize) {
        throw new UnsafeZipError('ZIP entry expanded size did not match its central-directory metadata');
      }
      if ((observedEntryCrc32 >>> 0) !== (entry.crc32 >>> 0)) {
        throw new UnsafeZipError('ZIP entry CRC-32 did not match its central-directory metadata');
      }
    }
  } finally {
    extractionZip.close();
  }

  const samePaths = validation.paths.size === extractionValidation.paths.size
    && [...validation.paths].every((entryPath) => extractionValidation.paths.has(entryPath));
  if (
    observedExtractableEntries !== extractableEntries
    || validation.entries !== extractionValidation.entries
    || validation.expandedBytes !== extractionValidation.expandedBytes
    || validation.metadataBytes !== extractionValidation.metadataBytes
    || !samePaths
  ) {
    throw new UnsafeZipError('ZIP central directory changed between validation and extraction');
  }
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
  const zipStat = fs.lstatSync(zipPath, { bigint: true });
  if (zipStat.isSymbolicLink() || !zipStat.isFile()) throw new UnsafeZipError('ZIP source must be a regular file');
  if (zipStat.size <= 0n || zipStat.size > BigInt(limits.maxArchiveBytes)) throw new UnsafeZipError('ZIP archive size is outside the allowed range');

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
    await extractValidatedZip(zipPath, stagingDir, validation, limits);
    const settledZipStat = fs.lstatSync(zipPath, { bigint: true });
    if (
      settledZipStat.isSymbolicLink()
      || !settledZipStat.isFile()
      || settledZipStat.dev !== zipStat.dev
      || settledZipStat.ino !== zipStat.ino
      || settledZipStat.size !== zipStat.size
      || settledZipStat.mtimeNs !== zipStat.mtimeNs
      || settledZipStat.ctimeNs !== zipStat.ctimeNs
    ) {
      throw new UnsafeZipError('ZIP source changed during extraction');
    }
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
