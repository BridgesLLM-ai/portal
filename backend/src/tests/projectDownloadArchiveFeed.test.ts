import fs from 'fs';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import {
  feedProjectDownloadArchive,
  type ProjectDownloadArchiveEntry,
} from '../services/projectDownloadSnapshot';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const archiver = require('archiver');

describe('project download archive feed', () => {
  let sandbox: string;
  const entry = (relPath: string, overrides: Partial<ProjectDownloadArchiveEntry> = {}): ProjectDownloadArchiveEntry => ({
    fullPath: path.join(sandbox, relPath.replace(/[:/]/g, '_')),
    relPath,
    mode: 0o100644,
    mtime: new Date('2026-09-20T00:00:00Z'),
    strip: false,
    store: false,
    ...overrides,
  });
  const put = (planned: ProjectDownloadArchiveEntry, content: string | Buffer) => fs.writeFileSync(planned.fullPath, content);
  const collect = () => {
    const chunks: Buffer[] = [];
    const sink = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    return { sink, bytes: () => Buffer.concat(chunks) };
  };

  beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-archive-feed-')); });
  afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

  test('writes a complete archive, one open source at a time', async () => {
    const plan = [entry('a.txt'), entry('media/img.png', { store: true }), entry('bin/run.sh', { mode: 0o100755 })];
    put(plan[0], 'hello\n'.repeat(500));
    put(plan[1], Buffer.alloc(100_000, 7));
    put(plan[2], '#!/bin/sh\n');
    const archive = archiver('zip', { zlib: { level: 6 } });
    const names: string[] = [];
    archive.on('entry', (data: { name: string }) => names.push(data.name));
    const { sink, bytes } = collect();
    archive.pipe(sink);

    let open = 0;
    let mostOpen = 0;
    const fed = await feedProjectDownloadArchive({
      archive,
      plan,
      signal: new AbortController().signal,
      onSourceOpened: () => { open += 1; mostOpen = Math.max(mostOpen, open); },
      onSourceClosed: () => { open -= 1; },
    });
    await new Promise<void>((resolve) => { sink.once('finish', () => resolve()); archive.finalize(); });

    expect(fed).toEqual({ appended: 3, skipped: 0, failed: false, openSource: null });
    expect(names).toEqual(['a.txt', 'media/img.png', 'bin/run.sh']);
    expect(mostOpen).toBe(1);
    expect(open).toBe(0);
    // End-of-central-directory record with three entries: a finished ZIP.
    const zip = bytes();
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(eocd).toBeGreaterThan(0);
    expect(zip.readUInt16LE(eocd + 10)).toBe(3);
  });

  test('leaves out a name the archive would reject, without ever opening its file', async () => {
    const plan = [entry('ok.txt'), entry('C:'), entry('after.txt')];
    for (const planned of plan) put(planned, 'x');
    const archive = archiver('zip');
    const errors: unknown[] = [];
    archive.on('error', (error: unknown) => errors.push(error));
    const { sink } = collect();
    archive.pipe(sink);
    const opened: string[] = [];

    const fed = await feedProjectDownloadArchive({
      archive, plan, signal: new AbortController().signal,
      onSourceOpened: (source) => opened.push(String(source.path)),
    });
    await new Promise<void>((resolve) => { sink.once('finish', () => resolve()); archive.finalize(); });

    expect(fed).toEqual({ appended: 2, skipped: 1, failed: false, openSource: null });
    expect(errors).toEqual([]);
    expect(opened).toEqual([plan[0].fullPath, plan[2].fullPath]);
  });

  test('a source that cannot be opened fails the export, not the process, and is closed', async () => {
    const plan = [entry('ok.txt'), entry('vanished.txt'), entry('never.txt')];
    put(plan[0], 'x');
    put(plan[2], 'x');
    const archive = archiver('zip');
    archive.on('error', () => undefined);
    const { sink } = collect();
    archive.pipe(sink);
    const sourceErrors: Error[] = [];
    let open = 0;

    const fed = await feedProjectDownloadArchive({
      archive, plan, signal: new AbortController().signal,
      onSourceOpened: () => { open += 1; },
      onSourceClosed: () => { open -= 1; },
      onSourceError: (error) => sourceErrors.push(error),
    });

    expect(fed.failed).toBe(true);
    expect(fed.openSource).toBeNull();
    expect(fed.appended).toBe(1);
    expect(sourceErrors).toHaveLength(1);
    expect((sourceErrors[0] as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(open).toBe(0);
    archive.abort();
  });

  test('a reader that stalls and leaves does not keep the source open', async () => {
    const plan = [entry('big.bin', { store: true }), entry('next.txt')];
    put(plan[0], Buffer.alloc(24 * 1024 * 1024));
    put(plan[1], 'x');
    const archive = archiver('zip');
    archive.on('error', () => undefined);
    // Accepts a little, then never calls back again: backpressure, for good.
    let taken = 0;
    const stalled = new Writable({
      highWaterMark: 1024,
      write(chunk, _encoding, callback) { taken += chunk.length; if (taken < 65_536) callback(); },
    });
    archive.pipe(stalled);
    const lifecycle = new AbortController();
    lifecycle.signal.addEventListener('abort', () => archive.abort(), { once: true });
    let current: fs.ReadStream | null = null;

    const feeding = feedProjectDownloadArchive({
      archive, plan, signal: lifecycle.signal,
      onSourceOpened: (source) => { current = source; },
      onSourceClosed: () => { current = null; },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stalledSource = current as fs.ReadStream | null;
    expect(stalledSource).not.toBeNull();
    expect(stalledSource!.closed).toBe(false);
    expect(stalledSource!.bytesRead).toBeLessThan(24 * 1024 * 1024);

    lifecycle.abort(new Error('Project download was cancelled'));
    const fed = await feeding;
    expect(fed.openSource).toBeNull();
    expect(stalledSource!.closed).toBe(true);
    expect(current).toBeNull();
    // The entry after the cancelled one was never opened.
    expect(fed.appended).toBe(0);
  });

  test('hands back a source that would not close, so its snapshot stays owned', async () => {
    const plan = [entry('slow.bin')];
    put(plan[0], Buffer.alloc(1024));
    const archive = archiver('zip');
    archive.on('error', () => undefined);
    const { sink } = collect();
    archive.pipe(sink);
    // Stalled filesystem I/O: the descriptor never reports closing.
    const realDestroy = fs.ReadStream.prototype.destroy;
    const spy = jest.spyOn(fs.ReadStream.prototype, 'destroy').mockImplementation(function noop(this: fs.ReadStream) { return this; });
    const closedStates: boolean[] = [];
    let fed;
    try {
      const lifecycle = new AbortController();
      lifecycle.abort(new Error('cancelled before the first read'));
      // Aborted before the loop: nothing is opened at all.
      expect(await feedProjectDownloadArchive({ archive, plan, signal: lifecycle.signal })).toMatchObject({ openSource: null, appended: 0 });

      const live = new AbortController();
      const pending = feedProjectDownloadArchive({
        archive, plan, signal: live.signal, closeTimeoutMs: 40,
        onSourceOpened: (source) => {
          // Keep it from ending on its own, then cancel mid-entry.
          source.pause();
          Object.defineProperty(source, 'closed', { get: () => { closedStates.push(false); return false; } });
          setTimeout(() => live.abort(new Error('cancelled')), 20);
        },
      });
      fed = await pending;
    } finally {
      spy.mockRestore();
    }
    expect(fed.failed).toBe(true);
    expect(fed.openSource).not.toBeNull();
    realDestroy.call(fed.openSource);
    archive.abort();
  });
});
