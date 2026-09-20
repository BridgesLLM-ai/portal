import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  __projectDownloadSnapshotTest,
  acquireProjectDownloadPermit,
  closeProjectDownloadSource,
  copyProjectDownloadSnapshot,
  projectDownloadArchiveEntryName,
  whenProjectDownloadSourceCloses,
  ProjectDownloadSnapshotBusyError,
  ProjectDownloadSnapshotLimitError,
  PROJECT_DOWNLOAD_SNAPSHOT_LIMITS,
} from '../services/projectDownloadSnapshot';

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('project download snapshot', () => {
  let sandbox: string;
  let project: string;
  let outside: string;
  let snapshot: string;

  const write = (filePath: string, content: string, mode = 0o644) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, { mode });
  };
  const listSnapshot = (): string[] => {
    const found: string[] = [];
    const walk = (directory: string, relative: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(directory, entry.name), child);
        else found.push(child);
      }
    };
    walk(snapshot, '');
    return found.sort();
  };
  const snapshotText = (): string => listSnapshot()
    .map((relative) => fs.readFileSync(path.join(snapshot, relative), 'utf8'))
    .join('\n');

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-snapshot-test-'));
    project = path.join(sandbox, 'project');
    outside = path.join(sandbox, 'host');
    snapshot = path.join(sandbox, 'out', 'project');
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    write(path.join(project, 'index.js'), 'console.log(1);\n');
    write(path.join(project, 'bin', 'run.sh'), '#!/bin/sh\n', 0o755);
    write(path.join(project, 'src', 'deep', 'a.txt'), 'A');
    write(path.join(project, 'node_modules', 'pkg', 'index.js'), 'skip me');
    write(path.join(outside, 'secret.txt'), 'HOST-SECRET');
    write(path.join(outside, 'dir', 'more.txt'), 'HOST-SECRET-2');
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('copies regular files and directories, keeps modes, honors exclusions', async () => {
    const result = await copyProjectDownloadSnapshot(project, snapshot, {
      isExcluded: (relative) => relative === 'node_modules' || relative.startsWith('node_modules/'),
    });
    expect(listSnapshot()).toEqual(['bin/run.sh', 'index.js', 'src/deep/a.txt']);
    expect(fs.readFileSync(path.join(snapshot, 'src/deep/a.txt'), 'utf8')).toBe('A');
    expect(fs.statSync(path.join(snapshot, 'bin/run.sh')).mode & 0o111).not.toBe(0);
    expect(result).toMatchObject({ files: 3, skipped: 0 });
  });

  test('never copies links or special files', async () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(project, 'link-to-file'));
    fs.symlinkSync(path.join(outside, 'dir'), path.join(project, 'link-to-dir'));
    fs.symlinkSync('index.js', path.join(project, 'inner-link'));
    execFileSync('mkfifo', [path.join(project, 'pipe')]);

    const result = await copyProjectDownloadSnapshot(project, snapshot);
    expect(listSnapshot()).toEqual(['bin/run.sh', 'index.js', 'node_modules/pkg/index.js', 'src/deep/a.txt']);
    expect(snapshotText()).not.toContain('HOST-SECRET');
    expect(result.skipped).toBe(4);
  });

  test('a file swapped for a host link after the listing is not followed', async () => {
    let swapped = false;
    await copyProjectDownloadSnapshot(project, snapshot, {
      beforeEntryPinned: (relative) => {
        if (relative !== 'index.js' || swapped) return;
        swapped = true;
        fs.rmSync(path.join(project, 'index.js'));
        fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(project, 'index.js'));
      },
    });
    expect(swapped).toBe(true);
    expect(listSnapshot()).not.toContain('index.js');
    expect(snapshotText()).not.toContain('HOST-SECRET');
  });

  test('a directory swapped for a host link cannot redirect the copy', async () => {
    // Before `src` is pinned: the name now leads to the host directory.
    let swappedBeforePin = false;
    await copyProjectDownloadSnapshot(project, snapshot, {
      beforeEntryPinned: (relative) => {
        if (relative !== 'src' || swappedBeforePin) return;
        swappedBeforePin = true;
        fs.renameSync(path.join(project, 'src'), path.join(sandbox, 'src-moved'));
        fs.symlinkSync(path.join(outside, 'dir'), path.join(project, 'src'));
      },
    });
    expect(swappedBeforePin).toBe(true);
    expect(snapshotText()).not.toContain('HOST-SECRET');
    expect(listSnapshot().some((relative) => relative.startsWith('src/'))).toBe(false);
  });

  test('a parent renamed after it was pinned still yields only its own files', async () => {
    let swappedAfterPin = false;
    await copyProjectDownloadSnapshot(project, snapshot, {
      beforeEntryPinned: (relative) => {
        // `src` is already pinned and listed; its child is about to be opened.
        if (relative !== 'src/deep' || swappedAfterPin) return;
        swappedAfterPin = true;
        fs.renameSync(path.join(project, 'src'), path.join(sandbox, 'src-moved'));
        fs.symlinkSync(path.join(outside, 'dir'), path.join(project, 'src'));
      },
    });
    expect(swappedAfterPin).toBe(true);
    expect(snapshotText()).not.toContain('HOST-SECRET');
    // The pinned directory, not the name, was copied.
    expect(fs.readFileSync(path.join(snapshot, 'src/deep/a.txt'), 'utf8')).toBe('A');
  });

  test('refuses a project root that is itself a link', async () => {
    const linkedRoot = path.join(sandbox, 'linked-project');
    fs.symlinkSync(outside, linkedRoot);
    // realpath canonicalizes Portal-owned parents; the result is the host dir
    // itself, which is copied as a plain tree — it is the caller that must not
    // pass a workload-writable root location. A root swapped mid-walk fails:
    const racingRoot = path.join(sandbox, 'racing');
    fs.mkdirSync(racingRoot);
    const realpath = fs.promises.realpath;
    const spy = jest.spyOn(fs.promises, 'realpath').mockImplementation(async (target: any, ...rest: any[]) => {
      const resolved = await (realpath as any)(target, ...rest);
      if (target === racingRoot) {
        fs.rmdirSync(racingRoot);
        fs.symlinkSync(outside, racingRoot);
      }
      return resolved;
    });
    try {
      await expect(copyProjectDownloadSnapshot(racingRoot, snapshot)).rejects.toThrow(/Project changed/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(snapshot)).toBe(false);
  });

  test('refuses a huge sparse file before materializing a byte of it', async () => {
    const sparse = path.join(project, 'sparse.bin');
    const handle = fs.openSync(sparse, 'w');
    fs.ftruncateSync(handle, 64 * 1024 * 1024 * 1024); // 64 GiB of holes, a few bytes on disk
    fs.closeSync(handle);

    await expect(copyProjectDownloadSnapshot(project, snapshot, {
      isExcluded: (relative) => relative.startsWith('node_modules'),
    })).rejects.toBeInstanceOf(ProjectDownloadSnapshotLimitError);
    expect(fs.existsSync(path.join(snapshot, 'sparse.bin'))).toBe(false);
  });

  test('charges every file against one aggregate budget', async () => {
    write(path.join(project, 'big-1.bin'), 'x'.repeat(700));
    write(path.join(project, 'big-2.bin'), 'y'.repeat(700));
    await expect(copyProjectDownloadSnapshot(project, snapshot, { limits: { maxBytes: 1_000 } }))
      .rejects.toThrow(/too large/);
  });

  test('copies a growing file only up to the size it had when it was opened', async () => {
    const log = path.join(project, 'growing.log');
    write(log, 'first-line\n');
    await copyProjectDownloadSnapshot(project, snapshot, {
      beforeEntryPinned: () => undefined,
      isExcluded: (relative) => relative !== 'growing.log',
    });
    expect(fs.readFileSync(path.join(snapshot, 'growing.log'), 'utf8')).toBe('first-line\n');

    // Same, but the writer appends between the pin and the read.
    fs.rmSync(path.dirname(snapshot), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    const realOpen = fs.promises.open;
    const spy = jest.spyOn(fs.promises, 'open').mockImplementation(async (target: any, flags?: any, mode?: any) => {
      const opened = await realOpen(target, flags, mode);
      // The destination is created after the source was opened and measured.
      if (typeof flags === 'number' && (flags & fs.constants.O_CREAT)) fs.appendFileSync(log, 'appended-after-pin\n');
      return opened;
    });
    try {
      await copyProjectDownloadSnapshot(project, snapshot, { isExcluded: (relative) => relative !== 'growing.log' });
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(log, 'utf8')).toContain('appended-after-pin');
    expect(fs.readFileSync(path.join(snapshot, 'growing.log'), 'utf8')).toBe('first-line\n');
  });

  test('stops when the client goes away', async () => {
    const controller = new AbortController();
    const copied: string[] = [];
    await expect(copyProjectDownloadSnapshot(project, snapshot, {
      signal: controller.signal,
      beforeEntryPinned: (relative) => {
        copied.push(relative);
        if (copied.length === 2) controller.abort(new Error('Project download was cancelled'));
      },
    })).rejects.toThrow('Project download was cancelled');
    // It did not walk the rest of the tree after the abort.
    expect(copied.length).toBeLessThanOrEqual(3);
  });

  test('bounds depth and entry count', async () => {
    let deep = project;
    for (let level = 0; level < 6; level += 1) deep = path.join(deep, `d${level}`);
    write(path.join(deep, 'leaf.txt'), 'leaf');
    await expect(copyProjectDownloadSnapshot(project, snapshot, { limits: { maxDepth: 3 } }))
      .rejects.toThrow(/nested too deeply/);

    fs.rmSync(path.dirname(snapshot), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    await expect(copyProjectDownloadSnapshot(project, snapshot, { limits: { maxEntries: 2 } }))
      .rejects.toThrow(/too many files/);
  });

  test('limits how many snapshots are prepared at once, and frees the slot afterwards', async () => {
    const gates: Array<() => void> = [];
    const running = Array.from({ length: PROJECT_DOWNLOAD_SNAPSHOT_LIMITS.maxConcurrent }, (_unused, index) => {
      let released = false;
      return copyProjectDownloadSnapshot(project, path.join(sandbox, 'out', `concurrent-${index}`), {
        beforeEntryPinned: () => (released ? undefined : new Promise<void>((resolve) => {
          gates.push(() => { released = true; resolve(); });
        })),
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(copyProjectDownloadSnapshot(project, path.join(sandbox, 'out', 'one-too-many')))
      .rejects.toBeInstanceOf(ProjectDownloadSnapshotBusyError);

    for (const release of gates) release();
    await Promise.all(running);
    await expect(copyProjectDownloadSnapshot(project, path.join(sandbox, 'out', 'after'))).resolves.toBeDefined();
    expect(__projectDownloadSnapshotTest.activePermitCount()).toBe(0);
  });

  test('an export permit outlives the copy, is per owner, and is given back exactly once', async () => {
    const permit = acquireProjectDownloadPermit('owner:alice');
    await copyProjectDownloadSnapshot(project, snapshot, { permit });
    // The snapshot is still on disk while the archive streams: the slot is too.
    expect(permit.released).toBe(false);
    expect(__projectDownloadSnapshotTest.activePermitCount()).toBe(1);
    expect(() => acquireProjectDownloadPermit('owner:alice')).toThrow(ProjectDownloadSnapshotBusyError);

    const other = acquireProjectDownloadPermit('owner:bob');
    other.release();
    permit.release();
    permit.release();
    expect(__projectDownloadSnapshotTest.activePermitCount()).toBe(0);
    await expect(copyProjectDownloadSnapshot(project, path.join(sandbox, 'out', 'late'), { permit }))
      .rejects.toThrow(/permit is not active/);
    acquireProjectDownloadPermit('owner:alice').release();
  });

  test('exports that start together cannot both be granted the same free space', async () => {
    write(path.join(project, 'big.bin'), 'x'.repeat(600));
    const only = (relative: string) => relative !== 'big.bin';
    let written = 0;
    const readFreeBytes = async () => 1_000 - written;
    // A one-byte block and a probe on every reservation make the arithmetic
    // exact: a 600-byte file is charged 601, a directory 1.
    const limits = { freeSpaceReserveBytes: 100, allocationBlockBytes: 1, freeSpaceRecheckBytes: 1 };

    // The first export reserves its 600 bytes, then stalls before writing any.
    let releaseFirst!: () => void;
    const stalled = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const realOpen = fs.promises.open;
    let stallNext = true;
    const spy = jest.spyOn(fs.promises, 'open').mockImplementation(async (target: any, flags?: any, mode?: any) => {
      if (stallNext && typeof flags === 'number' && (flags & fs.constants.O_CREAT)) {
        stallNext = false;
        await stalled;
      }
      return realOpen(target, flags, mode);
    });
    try {
      const first = copyProjectDownloadSnapshot(project, path.join(sandbox, 'out', 'first'), {
        isExcluded: only, readFreeBytes, limits,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(__projectDownloadSnapshotTest.pendingUnwrittenBytes()).toBe(601);

      // Free space still reads 1000, but 601 of it is already spoken for.
      await expect(copyProjectDownloadSnapshot(project, path.join(sandbox, 'out', 'second'), {
        isExcluded: only, readFreeBytes, limits,
      })).rejects.toThrow(/not have enough free space/);

      releaseFirst();
      await first;
      written = 600;
    } finally {
      spy.mockRestore();
    }
    // Written bytes show up in free space themselves; nothing stays promised.
    expect(__projectDownloadSnapshotTest.pendingUnwrittenBytes()).toBe(0);
    await expect(copyProjectDownloadSnapshot(project, path.join(sandbox, 'out', 'third'), {
      isExcluded: only, readFreeBytes, limits,
    })).rejects.toThrow(/not have enough free space/);
  });

  test('a failed copy gives its reservation back with its permit', async () => {
    write(path.join(project, 'big.bin'), 'x'.repeat(600));
    const permit = acquireProjectDownloadPermit('owner:carol');
    const realOpen = fs.promises.open;
    const spy = jest.spyOn(fs.promises, 'open').mockImplementation(async (target: any, flags?: any, mode?: any) => {
      if (typeof flags === 'number' && (flags & fs.constants.O_CREAT)) throw Object.assign(new Error('disk error'), { code: 'EIO' });
      return realOpen(target, flags, mode);
    });
    try {
      await expect(copyProjectDownloadSnapshot(project, snapshot, {
        permit, isExcluded: (relative) => relative !== 'big.bin', limits: { allocationBlockBytes: 1 },
      })).rejects.toThrow('disk error');
    } finally {
      spy.mockRestore();
    }
    expect(__projectDownloadSnapshotTest.pendingUnwrittenBytes()).toBe(601);
    permit.release();
    expect(__projectDownloadSnapshotTest.pendingUnwrittenBytes()).toBe(0);
    expect(__projectDownloadSnapshotTest.activePermitCount()).toBe(0);
  });

  test('charges tiny files what they occupy, so concurrent exports cannot eat the reserve', async () => {
    const BLOCK = PROJECT_DOWNLOAD_SNAPSHOT_LIMITS.allocationBlockBytes;
    const tiny = path.join(sandbox, 'tiny');
    for (let index = 0; index < 300; index += 1) write(path.join(tiny, `f${index}.txt`), 'x');
    // A one-byte file really costs a data block plus its inode. The fake disk
    // charges exactly that for everything the exports have created so far.
    const outputs = [0, 1, 2].map((index) => path.join(sandbox, 'out', `tiny-${index}`));
    const occupied = () => outputs.reduce((total, directory) => {
      if (!fs.existsSync(directory)) return total;
      return total + (fs.readdirSync(directory).length + 1) * 2 * BLOCK;
    }, 0);
    const reserve = 64 * BLOCK;
    const oneExport = 301 * 2 * BLOCK;
    const disk = reserve + Math.floor(oneExport * 1.5);
    let lowestFree = disk;
    const readFreeBytes = async () => {
      const free = disk - occupied();
      lowestFree = Math.min(lowestFree, free);
      return free;
    };
    const recheck = 20 * 2 * BLOCK; // re-read free space every 20 files
    const limits = { freeSpaceReserveBytes: reserve, freeSpaceRecheckBytes: recheck };

    const settled = await Promise.allSettled(outputs.map((directory) => (
      copyProjectDownloadSnapshot(tiny, directory, { readFreeBytes, limits })
    )));
    const refused = settled.filter((outcome) => outcome.status === 'rejected');
    // 900 logical bytes in all; by logical size every export would have passed.
    expect(refused.length).toBeGreaterThanOrEqual(1);
    for (const outcome of refused) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(ProjectDownloadSnapshotLimitError);
    }
    // The reserve holds, give or take what each export may write between readings.
    expect(disk - occupied()).toBeGreaterThanOrEqual(reserve - outputs.length * recheck);
    expect(__projectDownloadSnapshotTest.pendingUnwrittenBytes()).toBe(0);
    expect(__projectDownloadSnapshotTest.activePermitCount()).toBe(0);
  });

  test('closes an archive source that a stalled reader left open, and says when it is closed', async () => {
    const big = path.join(sandbox, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(4 * 1024 * 1024));
    const source = fs.createReadStream(big);
    await new Promise<void>((resolve) => source.once('open', () => resolve()));
    // Nobody reads it: exactly what a disconnected, backpressured export leaves.
    expect(source.closed).toBe(false);
    await expect(closeProjectDownloadSource(source)).resolves.toBe('closed');
    expect(source.closed).toBe(true);

    // Already closed, or nothing to close: returns at once.
    await expect(closeProjectDownloadSource(source)).resolves.toBe('closed');
    await expect(closeProjectDownloadSource(null)).resolves.toBe('closed');
  });

  test('never reports a descriptor closed that has not closed, and gives back only when it has', async () => {
    // Stalled filesystem I/O: destroy() has been asked for, close has not come.
    const listeners: Array<() => void> = [];
    const stuck = {
      closed: false,
      destroy: jest.fn(),
      once: jest.fn((_event: 'close', listener: () => void) => { listeners.push(listener); }),
    };
    const started = Date.now();
    await expect(closeProjectDownloadSource(stuck, 50)).resolves.toBe('pending');
    expect(stuck.destroy).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2_000);

    // The request may end; the snapshot and the permit stay owned.
    const permit = acquireProjectDownloadPermit('owner:dave');
    const giveBack = jest.fn(() => permit.release());
    whenProjectDownloadSourceCloses(stuck, giveBack);
    expect(giveBack).not.toHaveBeenCalled();
    expect(() => acquireProjectDownloadPermit('owner:dave')).toThrow(ProjectDownloadSnapshotBusyError);

    // The descriptor finally closes, however many times it says so.
    stuck.closed = true;
    for (const listener of listeners) listener();
    for (const listener of listeners) listener();
    expect(giveBack).toHaveBeenCalledTimes(1);
    acquireProjectDownloadPermit('owner:dave').release();

    // Closed in the gap between the wait expiring and the listener: still runs.
    const alreadyClosed = { closed: true, destroy: jest.fn(), once: jest.fn() };
    const late = jest.fn();
    whenProjectDownloadSourceCloses(alreadyClosed, late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  test('leaves out an entry whose name a ZIP archive cannot hold, before opening it', () => {
    // Legal on Linux; archiver strips the drive-like prefix and rejects what is left.
    expect(projectDownloadArchiveEntryName('C:')).toBeNull();
    // It would be silently renamed onto another entry's name.
    expect(projectDownloadArchiveEntryName('C:notes.txt')).toBeNull();
    expect(projectDownloadArchiveEntryName('/etc/passwd')).toBeNull();
    expect(projectDownloadArchiveEntryName('../up.txt')).toBeNull();
    expect(projectDownloadArchiveEntryName('')).toBeNull();
    // Ordinary names are unchanged, including a colon below the top level.
    for (const name of ['index.js', 'src/deep/a.txt', 'docs/10:30 notes.md', '.env.example', 'a b/c d.txt']) {
      expect(projectDownloadArchiveEntryName(name)).toBe(name);
    }
  });
});
