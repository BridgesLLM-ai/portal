import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { authenticateToken } from '../middleware/auth';
import { prisma } from '../config/database';
import { getUserUploadDir } from './files';

const router = Router();
const CHUNKS_DIR = '/var/portal-files/.chunks';

fs.mkdirSync(CHUNKS_DIR, { recursive: true });

interface ChunkSession {
  fileName: string;
  fileSize: number;
  totalChunks: number;
  receivedChunks: Set<number>;
  uploadId: string;
  userId: string;
  createdAt: number;
  paused: boolean;
}

const sessions = new Map<string, ChunkSession>();

// Clean stale sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > 3600000) {
      const chunkDir = path.join(CHUNKS_DIR, id);
      if (fs.existsSync(chunkDir)) fs.rmSync(chunkDir, { recursive: true, force: true });
      sessions.delete(id);
    }
  }
}, 1800000);

// POST /api/upload/init
router.post('/init', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { fileName, fileSize, totalChunks } = req.body;
    if (!fileName || !fileSize || !totalChunks) {
      res.status(400).json({ error: 'fileName, fileSize, totalChunks required' });
      return;
    }

    const uploadId = crypto.randomBytes(16).toString('hex');
    const chunkDir = path.join(CHUNKS_DIR, uploadId);
    fs.mkdirSync(chunkDir, { recursive: true });

    sessions.set(uploadId, {
      fileName,
      fileSize,
      totalChunks,
      receivedChunks: new Set(),
      uploadId,
      userId: req.user!.userId,
      createdAt: Date.now(),
      paused: false,
    });

    res.json({ uploadId, chunkSize: 5 * 1024 * 1024 });
  } catch (error) {
    console.error('Init upload error:', error);
    res.status(500).json({ error: 'Failed to initialize upload' });
  }
});

// POST /api/upload/chunk
router.post('/chunk', authenticateToken, async (req: Request, res: Response) => {
  try {
    const uploadId = req.headers['x-upload-id'] as string;
    const chunkIndex = parseInt(req.headers['x-chunk-index'] as string);

    if (!uploadId || isNaN(chunkIndex)) {
      res.status(400).json({ error: 'x-upload-id and x-chunk-index headers required' });
      return;
    }

    const session = sessions.get(uploadId);
    if (!session || session.userId !== req.user!.userId) {
      res.status(404).json({ error: 'Upload session not found' });
      return;
    }

    if (session.paused) {
      res.status(409).json({ error: 'Upload is paused' });
      return;
    }

    const chunkPath = path.join(CHUNKS_DIR, uploadId, `chunk-${chunkIndex}`);

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      fs.writeFileSync(chunkPath, buffer);
      session.receivedChunks.add(chunkIndex);

      res.json({
        received: chunkIndex,
        total: session.totalChunks,
        receivedCount: session.receivedChunks.size,
        progress: Math.round((session.receivedChunks.size / session.totalChunks) * 100),
      });
    });
  } catch (error) {
    console.error('Chunk upload error:', error);
    res.status(500).json({ error: 'Failed to upload chunk' });
  }
});

// POST /api/upload/pause
router.post('/pause', authenticateToken, async (req: Request, res: Response) => {
  const { uploadId } = req.body;
  const session = sessions.get(uploadId);
  if (!session || session.userId !== req.user!.userId) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  session.paused = true;
  res.json({ paused: true, receivedChunks: session.receivedChunks.size });
});

// POST /api/upload/resume
router.post('/resume', authenticateToken, async (req: Request, res: Response) => {
  const { uploadId } = req.body;
  const session = sessions.get(uploadId);
  if (!session || session.userId !== req.user!.userId) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  session.paused = false;
  const missing: number[] = [];
  for (let i = 0; i < session.totalChunks; i++) {
    if (!session.receivedChunks.has(i)) missing.push(i);
  }
  res.json({ paused: false, receivedChunks: session.receivedChunks.size, missingChunks: missing });
});

// POST /api/upload/complete
router.post('/complete', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { uploadId } = req.body;
    const session = sessions.get(uploadId);
    if (!session || session.userId !== req.user!.userId) {
      res.status(404).json({ error: 'Upload session not found' });
      return;
    }

    if (session.receivedChunks.size !== session.totalChunks) {
      res.status(400).json({
        error: 'Not all chunks received',
        received: session.receivedChunks.size,
        expected: session.totalChunks,
      });
      return;
    }

    const userDir = getUserUploadDir(session.userId);
    fs.mkdirSync(userDir, { recursive: true });

    const ext = path.extname(session.fileName);
    const base = path.basename(session.fileName, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const finalName = `${base}-${Date.now()}${ext}`;
    const finalPath = path.join(userDir, finalName);

    const writeStream = fs.createWriteStream(finalPath);
    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(CHUNKS_DIR, uploadId, `chunk-${i}`);
      const chunkData = fs.readFileSync(chunkPath);
      writeStream.write(chunkData);
    }
    writeStream.end();

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    const stat = fs.statSync(finalPath);

    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
      '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
      '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
      '.tar': 'application/x-tar', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar',
      '.js': 'application/javascript', '.ts': 'text/typescript', '.json': 'application/json',
      '.html': 'text/html', '.css': 'text/css', '.txt': 'text/plain', '.md': 'text/markdown',
      '.py': 'text/x-python', '.sh': 'text/x-shellscript',
      '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    const mimeType = mimeMap[ext.toLowerCase()] || 'application/octet-stream';

    const file = await prisma.file.create({
      data: {
        userId: session.userId,
        path: finalName,
        originalName: session.fileName,
        size: BigInt(stat.size),
        mimeType,
      },
    });

    // Cleanup chunks
    const chunkDir = path.join(CHUNKS_DIR, uploadId);
    fs.rmSync(chunkDir, { recursive: true, force: true });
    sessions.delete(uploadId);

    await prisma.activityLog.create({
      data: {
        userId: session.userId,
        action: 'FILE_UPLOAD_CHUNKED',
        resource: 'file',
        resourceId: file.id,
        severity: 'INFO',
      },
    });

    res.json({ ...file, size: file.size.toString(), filePath: finalName });
  } catch (error) {
    console.error('Complete upload error:', error);
    res.status(500).json({ error: 'Failed to complete upload' });
  }
});

// GET /api/upload/status/:uploadId
router.get('/status/:uploadId', authenticateToken, async (req: Request, res: Response) => {
  const session = sessions.get(req.params.uploadId);
  if (!session || session.userId !== req.user!.userId) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const missing: number[] = [];
  for (let i = 0; i < session.totalChunks; i++) {
    if (!session.receivedChunks.has(i)) missing.push(i);
  }
  res.json({
    uploadId: session.uploadId,
    fileName: session.fileName,
    fileSize: session.fileSize,
    totalChunks: session.totalChunks,
    receivedChunks: session.receivedChunks.size,
    missingChunks: missing,
    progress: Math.round((session.receivedChunks.size / session.totalChunks) * 100),
    paused: session.paused,
  });
});

// DELETE /api/upload/:uploadId - Cancel upload
router.delete('/:uploadId', authenticateToken, async (req: Request, res: Response) => {
  const session = sessions.get(req.params.uploadId);
  if (!session || session.userId !== req.user!.userId) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const chunkDir = path.join(CHUNKS_DIR, session.uploadId);
  if (fs.existsSync(chunkDir)) fs.rmSync(chunkDir, { recursive: true, force: true });
  sessions.delete(session.uploadId);
  res.json({ cancelled: true });
});

export default router;
