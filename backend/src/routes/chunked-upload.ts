import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { authenticateToken } from '../middleware/auth';
import { requireApproved } from '../middleware/requireApproved';
import { prisma } from '../config/database';
import {
  buildDirectFileUrl,
  ensureToolMirror,
  getUserUploadDir,
  removeToolMirror,
} from './files';
import {
  ChunkedUploadError,
  ChunkedUploadManager,
  PORTAL_UPLOAD_CHUNK_SIZE,
  PORTAL_UPLOAD_MAX_FILE_SIZE,
} from '../services/chunkedUpload.service';
import { scanFile } from '../services/virusScan';
import { getWorkspaceOwnerId } from '../utils/workspaceScope';
import { startUploadOrphanCleanup, stopUploadOrphanCleanup } from '../services/uploadOrphanCleanup';
import { resolveContainedPath } from '../services/containedPath';

const router = Router();
export const CHUNKS_DIR = path.resolve(
  process.env.PORTAL_UPLOAD_CHUNKS_ROOT
    || path.join(process.env.PORTAL_FILES_ROOT || '/var/portal-files', '.chunks'),
);
let uploadManager: ChunkedUploadManager | undefined;
let cleanupTimer: NodeJS.Timeout | undefined;

function getUploadManager(): ChunkedUploadManager {
  if (!uploadManager) uploadManager = new ChunkedUploadManager({ chunksDir: CHUNKS_DIR });
  return uploadManager;
}

export function initializeChunkedUploadRuntime(): void {
  getUploadManager();
  startUploadOrphanCleanup();
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => getUploadManager().cleanupExpiredSessions(), 30 * 60 * 1000);
  cleanupTimer.unref();
}

export function shutdownChunkedUploadRuntime(): void {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = undefined;
  stopUploadOrphanCleanup();
}

function sendUploadError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof ChunkedUploadError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  console.error(fallback, error);
  res.status(500).json({ error: fallback });
}

function parseChunkIndex(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new ChunkedUploadError('x-chunk-index must be a non-negative integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ChunkedUploadError('x-chunk-index is too large');
  return parsed;
}

function parseContentLength(raw: unknown): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new ChunkedUploadError('Content-Length is invalid');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ChunkedUploadError('Content-Length is too large', 413);
  return parsed;
}

function serializeSession(session: ReturnType<ChunkedUploadManager['get']>) {
  const missingChunks = getUploadManager().missingChunks(session);
  return {
    uploadId: session.uploadId,
    fileName: session.fileName,
    fileSize: session.fileSize,
    totalChunks: session.totalChunks,
    receivedChunks: session.receivedChunks.size,
    missingChunks,
    progress: Math.round((session.receivedChunks.size / session.totalChunks) * 100),
    paused: session.paused,
  };
}

// POST /api/upload/init
router.post('/init', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const session = getUploadManager().create(req.user!.userId, req.body || {});
    res.json({
      uploadId: session.uploadId,
      chunkSize: getUploadManager().chunkSize,
      maxFileSize: getUploadManager().maxFileSize,
      expiresInMs: 60 * 60 * 1000,
    });
  } catch (error) {
    sendUploadError(res, error, 'Failed to initialize upload');
  }
});

// POST /api/upload/chunk
router.post('/chunk', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const uploadId = String(req.headers['x-upload-id'] || '');
    if (!uploadId) throw new ChunkedUploadError('x-upload-id header is required');
    const chunkIndex = parseChunkIndex(req.headers['x-chunk-index']);
    const contentLength = parseContentLength(req.headers['content-length']);
    const session = await getUploadManager().receiveChunk(
      uploadId,
      req.user!.userId,
      chunkIndex,
      req,
      contentLength,
    );
    res.json({
      received: chunkIndex,
      total: session.totalChunks,
      receivedCount: session.receivedChunks.size,
      progress: Math.round((session.receivedChunks.size / session.totalChunks) * 100),
    });
  } catch (error) {
    sendUploadError(res, error, 'Failed to upload chunk');
  }
});

router.post('/pause', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const session = getUploadManager().setPaused(String(req.body?.uploadId || ''), req.user!.userId, true);
    res.json({ paused: true, receivedChunks: session.receivedChunks.size });
  } catch (error) {
    sendUploadError(res, error, 'Failed to pause upload');
  }
});

router.post('/resume', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const session = getUploadManager().setPaused(String(req.body?.uploadId || ''), req.user!.userId, false);
    res.json(serializeSession(session));
  } catch (error) {
    sendUploadError(res, error, 'Failed to resume upload');
  }
});

// POST /api/upload/complete
router.post('/complete', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  const uploadId = String(req.body?.uploadId || '');
  let assembledPath: string | undefined;
  let finalPath: string | undefined;
  let finalName: string | undefined;
  let ownerId: string | undefined;
  let createdFileId: string | undefined;
  try {
    const assembled = await getUploadManager().assemble(uploadId, req.user!.userId);
    assembledPath = assembled.assembledPath;
    const session = assembled.session;

    const scanResult = await scanFile(assembledPath);
    if (!scanResult.clean) {
      getUploadManager().releaseCompletion(uploadId, req.user!.userId, assembledPath);
      assembledPath = undefined;
      if (scanResult.scannerAvailable) getUploadManager().cancel(uploadId, req.user!.userId);
      await prisma.activityLog.create({
        data: {
          userId: req.user!.userId,
          action: scanResult.scannerAvailable ? 'MALWARE_BLOCKED' : 'UPLOAD_SCAN_UNAVAILABLE',
          resource: 'file',
          severity: scanResult.scannerAvailable ? 'CRITICAL' : 'WARNING',
          metadata: { filename: session.fileName, reason: scanResult.scannerAvailable ? scanResult.threat : 'scanner-unavailable' },
        },
      }).catch(() => {});
      res.status(scanResult.scannerAvailable ? 400 : 503).json({
        error: scanResult.scannerAvailable
          ? `File rejected: malware detected (${scanResult.threat})`
          : 'Upload completion is temporarily unavailable because malware scanning could not complete',
      });
      return;
    }

    ownerId = await getWorkspaceOwnerId(req.user!);
    const userDir = getUserUploadDir(ownerId);

    const ext = path.extname(session.fileName).slice(0, 32);
    const base = path.basename(session.fileName, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160) || 'file';
    finalName = `${base}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    finalPath = resolveContainedPath(userDir, finalName, { mustExist: false });
    try {
      fs.linkSync(assembledPath, finalPath);
    } catch (error: any) {
      if (!['EXDEV', 'EPERM', 'EMLINK'].includes(error?.code || '')) throw error;
      fs.copyFileSync(assembledPath, finalPath, fs.constants.COPYFILE_EXCL);
    }
    fs.chmodSync(finalPath, 0o600);

    const file = await prisma.file.create({
      data: {
        userId: ownerId,
        path: finalName,
        originalName: session.fileName,
        size: BigInt(session.fileSize),
        mimeType: mime.lookup(session.fileName) || 'application/octet-stream',
      },
    });
    createdFileId = file.id;
    const diskPath = ensureToolMirror(ownerId, finalPath, finalName);
    const toolUrl = buildDirectFileUrl(file.id, req);
    getUploadManager().finish(uploadId, req.user!.userId);

    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'FILE_UPLOAD_CHUNKED',
        resource: 'file',
        resourceId: file.id,
        severity: 'INFO',
      },
    }).catch(() => {});

    res.json({
      ...file,
      size: file.size.toString(),
      filePath: finalName,
      diskPath,
      originalDiskPath: finalPath,
      toolUrl,
    });
  } catch (error) {
    if (createdFileId) {
      try { await prisma.file.delete({ where: { id: createdFileId } }); } catch {}
    }
    if (ownerId && finalName) removeToolMirror(ownerId, finalName);
    if (finalPath) {
      try { fs.unlinkSync(finalPath); } catch {}
    }
    if (uploadId) {
      try { getUploadManager().releaseCompletion(uploadId, req.user!.userId, assembledPath); } catch {}
    }
    sendUploadError(res, error, 'Failed to complete upload');
  }
});

router.get('/status/:uploadId', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    res.json(serializeSession(getUploadManager().get(req.params.uploadId, req.user!.userId)));
  } catch (error) {
    sendUploadError(res, error, 'Failed to read upload status');
  }
});

router.delete('/:uploadId', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    getUploadManager().cancel(req.params.uploadId, req.user!.userId);
    res.json({ cancelled: true });
  } catch (error) {
    sendUploadError(res, error, 'Failed to cancel upload');
  }
});

export const CHUNKED_UPLOAD_CONTRACT = {
  chunkSize: PORTAL_UPLOAD_CHUNK_SIZE,
  maxFileSize: PORTAL_UPLOAD_MAX_FILE_SIZE,
};

export default router;
