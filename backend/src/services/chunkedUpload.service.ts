import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { once } from 'events';
import { Transform, type Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { ensureRuntimeDirectory } from '../utils/runtimeDirectory';

export const PORTAL_UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024;
export const PORTAL_UPLOAD_MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
export const PORTAL_UPLOAD_MAX_CHUNKS = Math.ceil(PORTAL_UPLOAD_MAX_FILE_SIZE / PORTAL_UPLOAD_CHUNK_SIZE);
export const PORTAL_UPLOAD_SESSION_TTL_MS = 60 * 60 * 1000;

const SESSION_FILE = 'session.json';
const UPLOAD_ID_PATTERN = /^[a-f0-9]{32}$/;
const CHUNK_FILE_PATTERN = /^chunk-(\d+)$/;

export class ChunkedUploadError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'ChunkedUploadError';
  }
}

export interface ChunkedUploadSession {
  version: 1;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  receivedChunks: Set<number>;
  uploadId: string;
  userId: string;
  createdAt: number;
  updatedAt: number;
  paused: boolean;
  completing: boolean;
}

type PersistedChunkedUploadSession = Omit<ChunkedUploadSession, 'receivedChunks' | 'completing'>;

export interface ChunkedUploadManagerOptions {
  chunksDir: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  sessionTtlMs?: number;
  maxFileSize?: number;
  chunkSize?: number;
  maxActiveSessions?: number;
  maxActiveSessionsPerUser?: number;
}

function normalizeFileName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) {
    throw new ChunkedUploadError('A valid fileName is required');
  }
  const normalized = raw.normalize('NFC').replace(/\\/g, '/');
  const base = path.posix.basename(normalized).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!base || base === '.' || base === '..' || Buffer.byteLength(base, 'utf8') > 255) {
    throw new ChunkedUploadError('fileName is invalid or too long');
  }
  return base;
}

function assertPositiveSafeInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new ChunkedUploadError(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

export class ChunkedUploadManager {
  private readonly sessions = new Map<string, ChunkedUploadSession>();
  private readonly chunksDir: string;
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly sessionTtlMs: number;
  readonly maxFileSize: number;
  readonly chunkSize: number;
  readonly maxChunks: number;
  private readonly maxActiveSessions: number;
  private readonly maxActiveSessionsPerUser: number;

  constructor(options: ChunkedUploadManagerOptions) {
    this.chunksDir = path.resolve(options.chunksDir);
    this.now = options.now || Date.now;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.sessionTtlMs = options.sessionTtlMs || PORTAL_UPLOAD_SESSION_TTL_MS;
    this.maxFileSize = options.maxFileSize || PORTAL_UPLOAD_MAX_FILE_SIZE;
    this.chunkSize = options.chunkSize || PORTAL_UPLOAD_CHUNK_SIZE;
    this.maxChunks = Math.ceil(this.maxFileSize / this.chunkSize);
    this.maxActiveSessions = options.maxActiveSessions || 100;
    this.maxActiveSessionsPerUser = options.maxActiveSessionsPerUser || 5;

    if (!Number.isSafeInteger(this.maxFileSize) || this.maxFileSize <= 0 || !Number.isSafeInteger(this.chunkSize) || this.chunkSize <= 0) {
      throw new Error('Invalid chunked upload manager limits');
    }
    ensureRuntimeDirectory(this.chunksDir, { mode: 0o700, enforceMode: true });
    this.recoverSessions();
  }

  private sessionDir(uploadId: string): string {
    if (!UPLOAD_ID_PATTERN.test(uploadId)) throw new ChunkedUploadError('Invalid uploadId');
    return path.join(this.chunksDir, uploadId);
  }

  private chunkPath(session: ChunkedUploadSession, index: number): string {
    return path.join(this.sessionDir(session.uploadId), `chunk-${index}`);
  }

  private expectedChunkSize(session: ChunkedUploadSession, index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
      throw new ChunkedUploadError('chunk index is outside the declared range');
    }
    const start = index * this.chunkSize;
    return Math.min(this.chunkSize, session.fileSize - start);
  }

  private serializeSession(session: ChunkedUploadSession): PersistedChunkedUploadSession {
    return {
      version: 1,
      fileName: session.fileName,
      fileSize: session.fileSize,
      totalChunks: session.totalChunks,
      uploadId: session.uploadId,
      userId: session.userId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      paused: session.paused,
    };
  }

  private persistSession(session: ChunkedUploadSession): void {
    const dir = this.sessionDir(session.uploadId);
    const target = path.join(dir, SESSION_FILE);
    const temp = path.join(dir, `.session-${process.pid}-${this.randomBytes(6).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temp, JSON.stringify(this.serializeSession(session)), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, target);
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
  }

  private readReceivedChunks(session: ChunkedUploadSession): Set<number> {
    const received = new Set<number>();
    const dir = this.sessionDir(session.uploadId);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const match = CHUNK_FILE_PATTERN.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      const index = Number(match[1]);
      if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) continue;
      const chunkPath = path.join(dir, entry.name);
      const stat = fs.lstatSync(chunkPath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== this.expectedChunkSize(session, index)) {
        try { fs.unlinkSync(chunkPath); } catch {}
        continue;
      }
      received.add(index);
    }
    return received;
  }

  private recoverSessions(): void {
    const now = this.now();
    for (const entry of fs.readdirSync(this.chunksDir, { withFileTypes: true })) {
      const dir = path.join(this.chunksDir, entry.name);
      if (!entry.isDirectory() || !UPLOAD_ID_PATTERN.test(entry.name)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        continue;
      }
      try {
        const dirStat = fs.lstatSync(dir);
        if (dirStat.isSymbolicLink()) throw new Error('symlink session');
        const metadataPath = path.join(dir, SESSION_FILE);
        const metadataStat = fs.lstatSync(metadataPath);
        if (metadataStat.isSymbolicLink() || !metadataStat.isFile() || metadataStat.size > 16 * 1024) {
          throw new Error('invalid metadata');
        }
        const raw = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as PersistedChunkedUploadSession;
        const fileName = normalizeFileName(raw.fileName);
        const fileSize = assertPositiveSafeInteger(raw.fileSize, 'fileSize', this.maxFileSize);
        const totalChunks = assertPositiveSafeInteger(raw.totalChunks, 'totalChunks', this.maxChunks);
        if (totalChunks !== Math.ceil(fileSize / this.chunkSize) || raw.uploadId !== entry.name || typeof raw.userId !== 'string' || !raw.userId) {
          throw new Error('inconsistent metadata');
        }
        if (!Number.isSafeInteger(raw.createdAt) || !Number.isSafeInteger(raw.updatedAt) || now - raw.updatedAt > this.sessionTtlMs) {
          throw new Error('expired metadata');
        }
        const session: ChunkedUploadSession = {
          ...raw,
          fileName,
          fileSize,
          totalChunks,
          receivedChunks: new Set(),
          completing: false,
        };
        session.receivedChunks = this.readReceivedChunks(session);
        this.sessions.set(session.uploadId, session);
      } catch {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  cleanupExpiredSessions(): number {
    const now = this.now();
    let removed = 0;
    for (const session of this.sessions.values()) {
      if (session.completing || now - session.updatedAt <= this.sessionTtlMs) continue;
      this.cancel(session.uploadId, session.userId);
      removed++;
    }
    return removed;
  }

  create(userId: string, input: { fileName: unknown; fileSize: unknown; totalChunks: unknown }): ChunkedUploadSession {
    if (typeof userId !== 'string' || !userId) throw new ChunkedUploadError('Authenticated user is required', 401);
    this.cleanupExpiredSessions();
    if (this.sessions.size >= this.maxActiveSessions) {
      throw new ChunkedUploadError('The server has reached its active upload limit', 429);
    }
    const activeForUser = Array.from(this.sessions.values()).filter((session) => session.userId === userId).length;
    if (activeForUser >= this.maxActiveSessionsPerUser) {
      throw new ChunkedUploadError('Too many active uploads for this user', 429);
    }

    const fileName = normalizeFileName(input.fileName);
    const fileSize = assertPositiveSafeInteger(input.fileSize, 'fileSize', this.maxFileSize);
    const totalChunks = assertPositiveSafeInteger(input.totalChunks, 'totalChunks', this.maxChunks);
    const expectedChunks = Math.ceil(fileSize / this.chunkSize);
    if (totalChunks !== expectedChunks) {
      throw new ChunkedUploadError(`totalChunks must equal ${expectedChunks} for the declared fileSize`);
    }

    let uploadId = '';
    do uploadId = this.randomBytes(16).toString('hex'); while (this.sessions.has(uploadId));
    const dir = this.sessionDir(uploadId);
    fs.mkdirSync(dir, { mode: 0o700 });
    const now = this.now();
    const session: ChunkedUploadSession = {
      version: 1,
      fileName,
      fileSize,
      totalChunks,
      receivedChunks: new Set(),
      uploadId,
      userId,
      createdAt: now,
      updatedAt: now,
      paused: false,
      completing: false,
    };
    this.persistSession(session);
    this.sessions.set(uploadId, session);
    return session;
  }

  get(uploadId: string, userId: string): ChunkedUploadSession {
    const session = this.sessions.get(uploadId);
    if (!session || session.userId !== userId) {
      throw new ChunkedUploadError('Upload session not found', 404);
    }
    return session;
  }

  setPaused(uploadId: string, userId: string, paused: boolean): ChunkedUploadSession {
    const session = this.get(uploadId, userId);
    if (session.completing) throw new ChunkedUploadError('Upload is completing', 409);
    session.paused = paused;
    session.updatedAt = this.now();
    this.persistSession(session);
    return session;
  }

  async receiveChunk(
    uploadId: string,
    userId: string,
    index: number,
    source: Readable,
    declaredContentLength?: number,
  ): Promise<ChunkedUploadSession> {
    const session = this.get(uploadId, userId);
    if (session.paused) throw new ChunkedUploadError('Upload is paused', 409);
    if (session.completing) throw new ChunkedUploadError('Upload is completing', 409);
    const expectedSize = this.expectedChunkSize(session, index);
    if (declaredContentLength !== undefined && declaredContentLength !== expectedSize) {
      throw new ChunkedUploadError(`Chunk ${index} must contain exactly ${expectedSize} bytes`, 413);
    }
    if (session.receivedChunks.has(index) || fs.existsSync(this.chunkPath(session, index))) {
      throw new ChunkedUploadError(`Chunk ${index} was already received`, 409);
    }

    const dir = this.sessionDir(uploadId);
    const temp = path.join(dir, `.chunk-${index}-${this.randomBytes(6).toString('hex')}.part`);
    let receivedBytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > expectedSize) {
          callback(new ChunkedUploadError(`Chunk ${index} exceeds ${expectedSize} bytes`, 413));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(source, limiter, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      if (receivedBytes !== expectedSize) {
        throw new ChunkedUploadError(`Chunk ${index} contains ${receivedBytes} bytes; expected ${expectedSize}`, 400);
      }
      const finalPath = this.chunkPath(session, index);
      try {
        fs.linkSync(temp, finalPath);
      } catch (error: any) {
        if (error?.code === 'EEXIST') throw new ChunkedUploadError(`Chunk ${index} was already received`, 409);
        throw error;
      }
      fs.unlinkSync(temp);
      session.receivedChunks.add(index);
      session.updatedAt = this.now();
      this.persistSession(session);
      return session;
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
  }

  async assemble(uploadId: string, userId: string): Promise<{ session: ChunkedUploadSession; assembledPath: string }> {
    const session = this.get(uploadId, userId);
    if (session.paused) throw new ChunkedUploadError('Upload is paused', 409);
    if (session.completing) throw new ChunkedUploadError('Upload is already completing', 409);
    if (session.receivedChunks.size !== session.totalChunks) {
      throw new ChunkedUploadError('Not all chunks have been received');
    }

    for (let index = 0; index < session.totalChunks; index++) {
      const chunkPath = this.chunkPath(session, index);
      const stat = fs.lstatSync(chunkPath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== this.expectedChunkSize(session, index)) {
        throw new ChunkedUploadError(`Chunk ${index} failed integrity validation`);
      }
    }

    session.completing = true;
    session.updatedAt = this.now();
    this.persistSession(session);
    const assembledPath = path.join(this.sessionDir(uploadId), `assembled-${this.randomBytes(8).toString('hex')}.part`);
    const output = fs.createWriteStream(assembledPath, { flags: 'wx', mode: 0o600 });
    let total = 0;
    try {
      for (let index = 0; index < session.totalChunks; index++) {
        const input = fs.createReadStream(this.chunkPath(session, index));
        for await (const data of input) {
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
          total += chunk.length;
          if (total > session.fileSize) throw new ChunkedUploadError('Assembled upload exceeds its declared size');
          if (!output.write(chunk)) await once(output, 'drain');
        }
      }
      output.end();
      await once(output, 'finish');
      if (total !== session.fileSize) {
        throw new ChunkedUploadError(`Assembled upload contains ${total} bytes; expected ${session.fileSize}`);
      }
      return { session, assembledPath };
    } catch (error) {
      output.destroy();
      try { fs.unlinkSync(assembledPath); } catch {}
      session.completing = false;
      session.updatedAt = this.now();
      this.persistSession(session);
      throw error;
    }
  }

  releaseCompletion(uploadId: string, userId: string, assembledPath?: string): void {
    const session = this.get(uploadId, userId);
    if (assembledPath) {
      try { fs.unlinkSync(assembledPath); } catch {}
    }
    session.completing = false;
    session.updatedAt = this.now();
    this.persistSession(session);
  }

  finish(uploadId: string, userId: string): void {
    const session = this.get(uploadId, userId);
    fs.rmSync(this.sessionDir(session.uploadId), { recursive: true, force: true });
    this.sessions.delete(session.uploadId);
  }

  cancel(uploadId: string, userId: string): void {
    const session = this.get(uploadId, userId);
    if (session.completing) throw new ChunkedUploadError('Upload is completing and cannot be cancelled', 409);
    fs.rmSync(this.sessionDir(session.uploadId), { recursive: true, force: true });
    this.sessions.delete(session.uploadId);
  }

  missingChunks(session: ChunkedUploadSession): number[] {
    const missing: number[] = [];
    for (let index = 0; index < session.totalChunks; index++) {
      if (!session.receivedChunks.has(index)) missing.push(index);
    }
    return missing;
  }
}
