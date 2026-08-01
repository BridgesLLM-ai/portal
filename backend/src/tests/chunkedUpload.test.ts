import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import {
  ChunkedUploadError,
  ChunkedUploadManager,
} from '../services/chunkedUpload.service';

describe('ChunkedUploadManager', () => {
  let tempRoot: string;
  let chunksDir: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-chunks-'));
    chunksDir = path.join(tempRoot, 'chunks');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function manager(options: Partial<ConstructorParameters<typeof ChunkedUploadManager>[0]> = {}) {
    return new ChunkedUploadManager({
      chunksDir,
      chunkSize: 4,
      maxFileSize: 12,
      ...options,
    });
  }

  test('requires declared size and chunk count to agree', () => {
    const uploads = manager();
    expect(() => uploads.create('user-1', { fileName: 'file.bin', fileSize: 9, totalChunks: 2 }))
      .toThrow(/totalChunks must equal 3/);
    expect(() => uploads.create('user-1', { fileName: 'file.bin', fileSize: 13, totalChunks: 4 }))
      .toThrow(/fileSize/);
    const session = uploads.create('user-1', { fileName: '../file.bin', fileSize: 4, totalChunks: 1 });
    expect(session.fileName).toBe('file.bin');
  });

  test('streams exact bounded chunks to disk and rejects duplicates', async () => {
    const uploads = manager();
    const session = uploads.create('user-1', { fileName: 'file.bin', fileSize: 6, totalChunks: 2 });

    await uploads.receiveChunk(session.uploadId, 'user-1', 0, Readable.from(Buffer.from('abcd')), 4);
    await uploads.receiveChunk(session.uploadId, 'user-1', 1, Readable.from(Buffer.from('ef')), 2);
    await expect(uploads.receiveChunk(session.uploadId, 'user-1', 1, Readable.from(Buffer.from('ef')), 2))
      .rejects.toMatchObject({ statusCode: 409 });

    const { assembledPath } = await uploads.assemble(session.uploadId, 'user-1');
    expect(fs.readFileSync(assembledPath, 'utf8')).toBe('abcdef');
    uploads.finish(session.uploadId, 'user-1');
    expect(fs.existsSync(path.dirname(assembledPath))).toBe(false);
  });

  test('rejects oversized and undersized chunk bodies without retaining partial files', async () => {
    const uploads = manager();
    const session = uploads.create('user-1', { fileName: 'file.bin', fileSize: 4, totalChunks: 1 });

    await expect(uploads.receiveChunk(session.uploadId, 'user-1', 0, Readable.from(Buffer.from('abcde'))))
      .rejects.toMatchObject({ statusCode: 413 });
    expect(session.receivedChunks.size).toBe(0);
    expect(fs.readdirSync(path.join(chunksDir, session.uploadId)).filter((name) => name.startsWith('chunk-'))).toHaveLength(0);

    await expect(uploads.receiveChunk(session.uploadId, 'user-1', 0, Readable.from(Buffer.from('abc'))))
      .rejects.toThrow(/expected 4/);
    expect(session.receivedChunks.size).toBe(0);
  });

  test('enforces ownership, index, pause, and active-session bounds', async () => {
    const uploads = manager({ maxActiveSessionsPerUser: 1 });
    const session = uploads.create('user-1', { fileName: 'file.bin', fileSize: 4, totalChunks: 1 });
    expect(() => uploads.get(session.uploadId, 'user-2')).toThrow(/not found/);
    expect(() => uploads.create('user-1', { fileName: 'other.bin', fileSize: 4, totalChunks: 1 }))
      .toThrow(/Too many active uploads/);
    uploads.setPaused(session.uploadId, 'user-1', true);
    await expect(uploads.receiveChunk(session.uploadId, 'user-1', 0, Readable.from(Buffer.from('abcd'))))
      .rejects.toMatchObject({ statusCode: 409 });
    uploads.setPaused(session.uploadId, 'user-1', false);
    await expect(uploads.receiveChunk(session.uploadId, 'user-1', 1, Readable.from(Buffer.from('abcd'))))
      .rejects.toThrow(/outside the declared range/);
  });

  test('recovers valid sessions and removes malformed or expired orphan directories', async () => {
    let now = 10_000;
    const uploads = manager({ now: () => now, sessionTtlMs: 1_000 });
    const session = uploads.create('user-1', { fileName: 'file.bin', fileSize: 4, totalChunks: 1 });
    await uploads.receiveChunk(session.uploadId, 'user-1', 0, Readable.from(Buffer.from('abcd')));

    const orphan = path.join(chunksDir, 'a'.repeat(32));
    fs.mkdirSync(orphan);
    fs.writeFileSync(path.join(orphan, 'garbage'), 'x');

    const recovered = manager({ now: () => now, sessionTtlMs: 1_000 });
    expect(recovered.get(session.uploadId, 'user-1').receivedChunks.has(0)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);

    now += 1_001;
    const afterExpiry = manager({ now: () => now, sessionTtlMs: 1_000 });
    expect(() => afterExpiry.get(session.uploadId, 'user-1')).toThrow(ChunkedUploadError);
    expect(fs.existsSync(path.join(chunksDir, session.uploadId))).toBe(false);
  });
});
