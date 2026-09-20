import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

export class ProjectDownloadSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectDownloadSnapshotError';
  }
}

/** The project does not fit the snapshot budget. Nothing about it is unsafe. */
export class ProjectDownloadSnapshotLimitError extends ProjectDownloadSnapshotError {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectDownloadSnapshotLimitError';
  }
}

/** Too many snapshots are being prepared at once; the caller should retry. */
export class ProjectDownloadSnapshotBusyError extends ProjectDownloadSnapshotError {
  constructor() {
    super('Other project downloads are being prepared. Try again in a moment.');
    this.name = 'ProjectDownloadSnapshotBusyError';
  }
}

export interface ProjectDownloadSnapshotLimits {
  maxBytes: number;
  maxEntries: number;
  maxDepth: number;
  maxConcurrent: number;
  maxConcurrentPerOwner: number;
  freeSpaceReserveBytes: number;
  freeSpaceRecheckBytes: number;
  allocationBlockBytes: number;
}

export const PROJECT_DOWNLOAD_SNAPSHOT_LIMITS: Readonly<ProjectDownloadSnapshotLimits> = Object.freeze({
  // The snapshot is a second copy of the project on the Portal's own disk, so
  // it is bounded by what it may hold, how many entries and levels it may
  // walk, how many may be prepared at once, and how much disk must stay free.
  maxBytes: 8 * 1024 * 1024 * 1024,
  maxEntries: 250_000,
  maxDepth: 64,
  maxConcurrent: 3,
  maxConcurrentPerOwner: 1,
  freeSpaceReserveBytes: 1024 * 1024 * 1024,
  // Disk is charged the way a filesystem spends it, not by logical size: every
  // entry costs its data rounded up to whole blocks plus one block for its
  // inode and directory entry. A tree of one-byte files is charged what it
  // really occupies, not the handful of bytes it contains.
  allocationBlockBytes: 4096,
  // Free space is re-read before the charge since the last reading would
  // reach this much — which is also before any single file this large.
  freeSpaceRecheckBytes: 16 * 1024 * 1024,
});

/**
 * One project export, from the first copied byte until its snapshot has been
 * removed. It holds a concurrency slot and the disk space promised to a copy in
 * progress, and gives both back exactly once.
 */
export interface ProjectDownloadPermit {
  readonly released: boolean;
  release(): void;
}

type PermitState = { owner: string; pendingBytes: number; released: boolean };
const activePermits = new Set<PermitState>();
const permitStates = new WeakMap<ProjectDownloadPermit, PermitState>();
// Bytes promised to copies in progress that free-space readings cannot show
// yet. Every reservation is judged against free space minus this, so exports
// that start together cannot each count the same free disk.
let pendingUnwrittenBytes = 0;

export function acquireProjectDownloadPermit(owner: string): ProjectDownloadPermit {
  if (activePermits.size >= PROJECT_DOWNLOAD_SNAPSHOT_LIMITS.maxConcurrent) {
    throw new ProjectDownloadSnapshotBusyError();
  }
  let sameOwner = 0;
  for (const active of activePermits) if (active.owner === owner) sameOwner += 1;
  if (sameOwner >= PROJECT_DOWNLOAD_SNAPSHOT_LIMITS.maxConcurrentPerOwner) {
    throw new ProjectDownloadSnapshotBusyError();
  }
  const state: PermitState = { owner, pendingBytes: 0, released: false };
  activePermits.add(state);
  const permit: ProjectDownloadPermit = {
    get released() { return state.released; },
    release() {
      if (state.released) return;
      state.released = true;
      activePermits.delete(state);
      pendingUnwrittenBytes = Math.max(0, pendingUnwrittenBytes - state.pendingBytes);
      state.pendingBytes = 0;
    },
  };
  permitStates.set(permit, state);
  return permit;
}

export const __projectDownloadSnapshotTest = Object.freeze({
  activePermitCount: () => activePermits.size,
  pendingUnwrittenBytes: () => pendingUnwrittenBytes,
});

export interface ProjectDownloadSnapshotResult {
  files: number;
  directories: number;
  skipped: number;
  bytes: number;
}

export interface ProjectDownloadSnapshotOptions {
  /** Relative, `/`-separated path of an entry that must stay out of the snapshot. */
  isExcluded?: (relativePath: string) => boolean;
  /** Aborts the copy: the client went away, or the caller's deadline passed. */
  signal?: AbortSignal;
  /**
   * The export this copy belongs to. The caller keeps it until the snapshot has
   * been removed. Without one the copy takes, and returns, its own.
   */
  permit?: ProjectDownloadPermit;
  /** Overrides for `PROJECT_DOWNLOAD_SNAPSHOT_LIMITS` (tests, smaller hosts). */
  limits?: Partial<Pick<ProjectDownloadSnapshotLimits,
    'maxBytes' | 'maxEntries' | 'maxDepth' | 'freeSpaceReserveBytes' | 'freeSpaceRecheckBytes' | 'allocationBlockBytes'>>;
  /** Test seam: free bytes on the snapshot filesystem. */
  readFreeBytes?: () => Promise<number>;
  /**
   * Test seam: runs after a directory has been listed and before the named
   * entry is pinned, which is exactly where a concurrent project workload would
   * have to win a race.
   */
  beforeEntryPinned?: (relativePath: string) => void | Promise<void>;
}

// Node does not expose O_PATH. This is the Linux UAPI value (see
// containedPath.ts). An O_PATH descriptor pins an inode without opening it, so
// a FIFO or device is never touched and a symlink is never followed.
const O_PATH = 0x200000;

function procPath(handle: fs.promises.FileHandle, name?: string): string {
  return name === undefined ? `/proc/self/fd/${handle.fd}` : `/proc/self/fd/${handle.fd}/${name}`;
}

function isSafeEntryName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0');
}

/**
 * Copy a project tree into a private snapshot without ever resolving a
 * workload-controlled pathname.
 *
 * A project workload can rewrite its workspace while the owner downloads it.
 * A pathname-based copy (`fs.cp`, sync or async) checks an entry with `lstat`
 * and then opens it by name, and a swap between the two turns a host file into
 * an ordinary file inside the snapshot, where no later symlink check can see
 * it. Here every directory is pinned by descriptor and every entry is reached
 * only through its pinned parent (`/proc/self/fd/<parent>/<name>`, the
 * openat-equivalent this codebase already uses), pinned with
 * `O_PATH | O_NOFOLLOW`, classified from that descriptor, and read from that
 * same inode. Renaming a directory, or replacing any name with a link, cannot
 * redirect the copy: links, FIFOs, sockets and devices are skipped.
 *
 * A pinned inode is not a frozen one. A file that is being written while it is
 * copied is captured up to the size it had when it was opened for reading, and
 * no further.
 * The copy is bounded: it refuses a project that exceeds its byte, entry or
 * depth budget before copying the entry that would cross it (a sparse file is
 * charged its apparent size, which is what it would occupy here, and every
 * entry is charged whole blocks plus its inode), keeps free space in reserve
 * against everything promised to exports in progress, stops when the caller
 * aborts, and is limited in how many may run at once.
 */
export async function copyProjectDownloadSnapshot(
  sourceRoot: string,
  destinationRoot: string,
  options: ProjectDownloadSnapshotOptions = {},
): Promise<ProjectDownloadSnapshotResult> {
  if (process.platform !== 'linux' || !fs.constants.O_DIRECTORY || !fs.constants.O_NOFOLLOW) {
    throw new ProjectDownloadSnapshotError('Project download snapshots require Linux');
  }
  const directoryFlags = O_PATH | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const result: ProjectDownloadSnapshotResult = { files: 0, directories: 0, skipped: 0, bytes: 0 };
  const isExcluded = options.isExcluded || (() => false);
  const limits = { ...PROJECT_DOWNLOAD_SNAPSHOT_LIMITS, ...(options.limits || {}) };
  const signal = options.signal;
  const ownsPermit = options.permit === undefined;
  // Each self-acquired permit is its own owner: the per-owner limit belongs to
  // the caller that knows who is exporting.
  const permit = options.permit || acquireProjectDownloadPermit(`snapshot:${Math.random().toString(36).slice(2)}:${Date.now()}`);
  const permitState = permitStates.get(permit);
  if (!permitState || permitState.released) {
    throw new ProjectDownloadSnapshotError('Project download permit is not active');
  }
  let entries = 0;
  let charged = 0;
  let chargedSinceSpaceCheck = Number.POSITIVE_INFINITY;
  const allocationFor = (logicalBytes: number): number => (
    Math.ceil(Math.max(0, logicalBytes) / limits.allocationBlockBytes) * limits.allocationBlockBytes
    + limits.allocationBlockBytes
  );

  const throwIfAborted = (): void => {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new ProjectDownloadSnapshotError('Project download was cancelled');
    }
  };
  const readFreeBytes = options.readFreeBytes || (async () => {
    const space = await fs.promises.statfs(path.dirname(destinationRoot));
    return space.bavail * space.bsize;
  });
  /** Charge one entry (a directory is an entry of zero bytes). Returns the charge. */
  const reserveFor = async (logicalBytes: number): Promise<number> => {
    const charge = allocationFor(logicalBytes);
    if (charged + charge > limits.maxBytes) {
      throw new ProjectDownloadSnapshotLimitError(
        'This project is too large to download as one archive.',
      );
    }
    if (chargedSinceSpaceCheck + charge >= limits.freeSpaceRecheckBytes) {
      const freeBytes = await readFreeBytes();
      // Nothing is awaited between this comparison and the ledger update, so
      // two exports cannot both be granted the same free space.
      if (freeBytes - pendingUnwrittenBytes < charge + limits.freeSpaceReserveBytes) {
        throw new ProjectDownloadSnapshotLimitError(
          'The server does not have enough free space to prepare this download.',
        );
      }
      chargedSinceSpaceCheck = 0;
    }
    chargedSinceSpaceCheck += charge;
    charged += charge;
    permitState.pendingBytes += charge;
    pendingUnwrittenBytes += charge;
    return charge;
  };
  const settleReservation = (charge: number): void => {
    // The entry is on disk now and shows up in free-space readings itself.
    const settled = Math.min(charge, permitState.pendingBytes);
    permitState.pendingBytes -= settled;
    pendingUnwrittenBytes = Math.max(0, pendingUnwrittenBytes - settled);
  };

  const copyFile = async (
    pinned: fs.promises.FileHandle,
    pinnedStat: fs.Stats,
    destinationPath: string,
  ): Promise<void> => {
    const source = await fs.promises.open(procPath(pinned), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      const opened = await source.stat();
      if (!opened.isFile() || opened.dev !== pinnedStat.dev || opened.ino !== pinnedStat.ino) {
        throw new ProjectDownloadSnapshotError('Project changed while the download snapshot was being created');
      }
      const charge = await reserveFor(opened.size);
      const destination = await fs.promises.open(
        destinationPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        (opened.mode & 0o777) | 0o600,
      );
      try {
        if (opened.size > 0) {
          // The streams own and close their handles. With `autoClose: false` a
          // FileHandle's close() never settles while a stream still references
          // it; the explicit closes below are for the paths that never stream.
          // Reading stops at the pinned size, so a file that keeps growing
          // cannot outrun the budget it was charged.
          const writer = destination.createWriteStream();
          await pipeline(source.createReadStream({ start: 0, end: opened.size - 1 }), writer, { signal });
          result.bytes += writer.bytesWritten;
        }
        settleReservation(charge);
      } finally {
        await destination.close().catch(() => undefined);
      }
      result.files += 1;
    } finally {
      await source.close().catch(() => undefined);
    }
  };

  const copyDirectory = async (
    directory: fs.promises.FileHandle,
    relativeDirectory: string,
    destinationDirectory: string,
    depth: number,
  ): Promise<void> => {
    // One descriptor stays pinned per level, so depth is also the fd budget.
    if (depth > limits.maxDepth) {
      throw new ProjectDownloadSnapshotLimitError('This project is nested too deeply to download as one archive.');
    }
    throwIfAborted();
    const directoryCharge = await reserveFor(0);
    await fs.promises.mkdir(destinationDirectory, { mode: 0o700 });
    settleReservation(directoryCharge);
    result.directories += 1;
    const names = await fs.promises.readdir(procPath(directory));
    for (const name of names) {
      throwIfAborted();
      entries += 1;
      if (entries > limits.maxEntries) {
        throw new ProjectDownloadSnapshotLimitError('This project has too many files to download as one archive.');
      }
      if (!isSafeEntryName(name)) {
        result.skipped += 1;
        continue;
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (isExcluded(relativePath)) continue;
      if (options.beforeEntryPinned) await options.beforeEntryPinned(relativePath);

      let pinned: fs.promises.FileHandle;
      try {
        pinned = await fs.promises.open(procPath(directory, name), O_PATH | fs.constants.O_NOFOLLOW);
      } catch (error: any) {
        // Removed since the listing: a project that is being worked on.
        if (error?.code === 'ENOENT') {
          result.skipped += 1;
          continue;
        }
        throw error;
      }
      try {
        const pinnedStat = await pinned.stat();
        if (pinnedStat.isDirectory()) {
          await copyDirectory(pinned, relativePath, path.join(destinationDirectory, name), depth + 1);
        } else if (pinnedStat.isFile()) {
          await copyFile(pinned, pinnedStat, path.join(destinationDirectory, name));
        } else {
          result.skipped += 1;
        }
      } finally {
        await pinned.close();
      }
    }
  };

  const pinnedParents: fs.promises.FileHandle[] = [];
  try {
    throwIfAborted();
    // The project root's own parents belong to the Portal, not to a workload,
    // so they are canonicalized once. From there down, nothing is followed.
    const canonicalRoot = await fs.promises.realpath(sourceRoot);
    let parent = await fs.promises.open('/', directoryFlags);
    pinnedParents.push(parent);
    for (const part of canonicalRoot.split('/').filter(Boolean)) {
      parent = await fs.promises.open(procPath(parent, part), directoryFlags);
      pinnedParents.push(parent);
    }
    await copyDirectory(parent, '', destinationRoot, 0);
  } catch (error: any) {
    // A stream interrupted by the signal rejects with a generic AbortError;
    // the caller gets the reason it aborted with.
    if (signal?.aborted) throwIfAborted();
    if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR') {
      throw new ProjectDownloadSnapshotError('Project changed while the download snapshot was being created');
    }
    throw error;
  } finally {
    if (ownsPermit) permit.release();
    for (const handle of pinnedParents.reverse()) await handle.close().catch(() => undefined);
  }
  return result;
}

/** Destroy an archive source and wait until its descriptor is really closed. */
export type ProjectDownloadSourceLike = {
  closed?: boolean;
  destroy(): unknown;
  once(event: 'close', listener: () => void): unknown;
};

/**
 * `closed` means the descriptor is known to be closed. `pending` means the wait
 * ran out first: the stream has been told to close and has not yet. That is
 * not evidence that its disk has been given back, so the caller must go on
 * owning the snapshot and the permit until `whenProjectDownloadSourceCloses`.
 */
export function closeProjectDownloadSource(
  source: ProjectDownloadSourceLike | null,
  timeoutMs = 10_000,
): Promise<'closed' | 'pending'> {
  if (!source || source.closed) return Promise.resolve('closed');
  return new Promise<'closed' | 'pending'>((resolve) => {
    // The wait is bounded so a request can return; the ownership is not.
    const timer = setTimeout(() => resolve(source.closed ? 'closed' : 'pending'), timeoutMs);
    source.once('close', () => {
      clearTimeout(timer);
      resolve('closed');
    });
    source.destroy();
  });
}

/** Run `cleanup` exactly once, when the source's descriptor is really closed. */
export function whenProjectDownloadSourceCloses(source: ProjectDownloadSourceLike, cleanup: () => void): void {
  let ran = false;
  const once = () => {
    if (ran) return;
    ran = true;
    cleanup();
  };
  source.once('close', once);
  // It may have closed between the caller's wait expiring and this listener.
  if (source.closed) once();
}

/**
 * The name archiver will actually write for an entry, or null when it cannot
 * write one. archiver strips a leading `word:` (a drive prefix) and leading
 * `../` or `/`; a name it would change or empty is left out of the archive
 * rather than renamed onto another entry or failed after its source is open.
 */
export function projectDownloadArchiveEntryName(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\w+:/, '').replace(/^(\.\.?\/|\/)+/, '');
  return normalized && normalized === relativePath ? normalized : null;
}

export interface ProjectDownloadArchiveEntry {
  fullPath: string;
  relPath: string;
  mode: number;
  mtime: Date;
  /** Read as text and passed through `transformText` instead of streamed. */
  strip: boolean;
  /** Store without compression (already-compressed media and archives). */
  store: boolean;
}

type ProjectDownloadArchive = {
  append(source: fs.ReadStream | string, data: { name: string; mode?: number; date?: Date; store?: boolean }): unknown;
  once(event: 'entry' | 'error', listener: (...args: any[]) => void): unknown;
  off(event: 'entry' | 'error', listener: (...args: any[]) => void): unknown;
};

/**
 * Feed an archive one owned source at a time.
 *
 * archiver's own `file()` queue opens sources itself, and its `abort()` leaves
 * the entry it is reading alone: a reader that stalls and disconnects left that
 * descriptor open, and an unlinked file that is still open keeps its disk
 * blocks. Here exactly one descriptor is ever open, the caller is told about it
 * (`onSourceOpened` / `onSourceClosed`), and every outcome of an entry —
 * appended, rejected by the archive, failed to open, cancelled — goes through
 * the same `finally`: the source is destroyed and seen to close before it is
 * let go of and before another is opened. If it does not close within the
 * wait, feeding stops and `openSource` hands the still-open source back, so the
 * caller keeps the snapshot and the permit until it really closes.
 */
export async function feedProjectDownloadArchive(input: {
  archive: ProjectDownloadArchive;
  plan: readonly ProjectDownloadArchiveEntry[];
  signal: AbortSignal;
  isResponseGone?: () => boolean;
  transformText?: (entry: ProjectDownloadArchiveEntry, content: string) => string;
  onSourceOpened?: (source: fs.ReadStream) => void;
  onSourceClosed?: () => void;
  onSourceError?: (error: Error) => void;
  closeTimeoutMs?: number;
}): Promise<{ appended: number; skipped: number; failed: boolean; openSource: fs.ReadStream | null }> {
  const { archive, signal } = input;
  let appended = 0;
  let skipped = 0;
  let failed = false;
  const onArchiveError = () => { failed = true; };
  archive.once('error', onArchiveError);
  try {
    for (const planned of input.plan) {
      if (signal.aborted || failed || input.isResponseGone?.()) break;
      // Decided before anything is opened: archiver rejects or rewrites a few
      // names that are legal on Linux (`C:`), and it does so after it has been
      // handed the source.
      const entryName = projectDownloadArchiveEntryName(planned.relPath);
      if (!entryName) {
        skipped += 1;
        continue;
      }
      let settle: () => void = () => undefined;
      const processed = new Promise<void>((resolve) => {
        settle = () => {
          archive.off('entry', settle);
          archive.off('error', settle);
          signal.removeEventListener('abort', settle);
          resolve();
        };
        archive.once('entry', settle);
        archive.once('error', settle);
        signal.addEventListener('abort', settle, { once: true });
      });

      let text: string | null = null;
      if (planned.strip && input.transformText) {
        try {
          text = input.transformText(planned, await fs.promises.readFile(planned.fullPath, 'utf-8'));
        } catch {
          // If the UTF-8 read fails, the file is added as it is.
          text = null;
        }
        if (signal.aborted) {
          settle();
          break;
        }
      }
      if (text !== null) {
        archive.append(text, { name: entryName });
        await processed;
        if (!failed && !signal.aborted) appended += 1;
        continue;
      }

      const source = fs.createReadStream(planned.fullPath);
      let sourceError: Error | null = null;
      // Never unhandled: a snapshot file that cannot be opened fails the
      // export instead of the process.
      source.on('error', (error) => {
        sourceError = error;
        settle();
      });
      input.onSourceOpened?.(source);
      let closure: 'closed' | 'pending' = 'pending';
      try {
        archive.append(source, { name: entryName, mode: planned.mode, date: planned.mtime, store: planned.store });
        await processed;
      } finally {
        closure = await closeProjectDownloadSource(source, input.closeTimeoutMs);
        if (closure === 'closed') input.onSourceClosed?.();
      }
      if (closure === 'pending') return { appended, skipped, failed: true, openSource: source };
      if (sourceError) {
        failed = true;
        input.onSourceError?.(sourceError);
        break;
      }
      if (!failed && !signal.aborted) appended += 1;
    }
    return { appended, skipped, failed, openSource: null };
  } finally {
    archive.off('error', onArchiveError);
  }
}
