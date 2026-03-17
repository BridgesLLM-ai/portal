import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authenticateToken } from '../middleware/auth';
import { requireApproved } from '../middleware/requireApproved';
import { scanFile } from '../services/virusScan';
import { prisma } from '../config/database';
import { getWorkspaceOwnerId } from '../utils/workspaceScope';

const router = Router();

// New storage path structure
const BASE_UPLOAD_DIR = '/var/portal-files';

function getUserUploadDir(userId: string): string {
  return path.join(BASE_UPLOAD_DIR, `user-${userId}`, 'uploads');
}

// Ensure base directory exists
fs.mkdirSync(BASE_UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = getUserUploadDir(req.user!.userId);
    fs.mkdirSync(userDir, { recursive: true });
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `${base}-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

function preventTraversal(filePath: string, baseDir: string): boolean {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(path.resolve(baseDir));
}

async function logActivity(userId: string, action: string, resource: string, resourceId?: string, req?: Request) {
  await prisma.activityLog.create({
    data: {
      userId,
      action,
      resource,
      resourceId,
      severity: 'INFO',
      ipAddress: req?.ip,
      userAgent: req?.headers['user-agent'],
    },
  });
}

// Helper to resolve file on disk (checks both new and legacy paths)
function resolveFilePath(userId: string, filePath: string): string | null {
  // New path
  const newPath = path.join(getUserUploadDir(userId), filePath);
  if (fs.existsSync(newPath)) return newPath;
  // Legacy path
  const legacyPath = path.join('/portal/files', userId, filePath);
  if (fs.existsSync(legacyPath)) return legacyPath;
  return null;
}

async function getScopedOwnerId(req: Request): Promise<string> {
  return getWorkspaceOwnerId(req.user!);
}

// GET /api/files - list user files
router.get('/', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;
    const search = (req.query.search as string) || '';
    const mimeFilter = (req.query.mime as string) || '';

    const where: any = { userId: ownerId };
    if (search) {
      where.OR = [
        { path: { contains: search, mode: 'insensitive' } },
        { originalName: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (mimeFilter) {
      where.mimeType = { startsWith: mimeFilter };
    }

    const [files, total] = await Promise.all([
      prisma.file.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.file.count({ where }),
    ]);

    const serialized = files.map(f => ({
      ...f,
      size: f.size.toString(),
    }));

    res.json({ files: serialized, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('List files error:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// POST /api/files - upload file
router.post('/', authenticateToken, requireApproved, upload.single('file'), async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const requestUserDir = getUserUploadDir(req.user!.userId);
    if (!preventTraversal(req.file.path, requestUserDir)) {
      fs.unlinkSync(req.file.path);
      res.status(400).json({ error: 'Invalid file path' });
      return;
    }

    if (ownerId !== req.user!.userId) {
      const ownerDir = getUserUploadDir(ownerId);
      fs.mkdirSync(ownerDir, { recursive: true });
      const movedPath = path.join(ownerDir, path.basename(req.file.path));
      fs.renameSync(req.file.path, movedPath);
      req.file.path = movedPath;
    }

    // Virus scan uploaded file
    const scanResult = await scanFile(req.file.path);
    if (!scanResult.clean) {
      fs.unlinkSync(req.file.path);
      await prisma.activityLog.create({
        data: {
          userId: req.user!.userId,
          action: 'MALWARE_BLOCKED',
          resource: 'file',
          severity: 'CRITICAL',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          translatedMessage: `🦠 Malware blocked in upload: "${req.file.originalname}" — ${scanResult.threat}`,
          metadata: { filename: req.file.originalname, threat: scanResult.threat },
        },
      }).catch(() => {});
      res.status(400).json({ error: `File rejected: malware detected (${scanResult.threat})` });
      return;
    }

    const file = await prisma.file.create({
      data: {
        userId: ownerId,
        path: req.file.filename,
        originalName: req.file.originalname,
        size: BigInt(req.file.size),
        mimeType: req.file.mimetype,
      },
    });

    await logActivity(req.user!.userId, 'FILE_UPLOAD', 'file', file.id, req);

    // Ensure symlink exists for user
    ensureUserSymlink(ownerId);

    // Include full disk path so agent chat can reference the file
    const diskPath = path.join(getUserUploadDir(ownerId), req.file.filename);
    res.status(201).json({ ...file, size: file.size.toString(), diskPath });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// GET /api/files/:id/content - AI-accessible file content (inline, no download header)
router.get('/:id/content', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const file = await prisma.file.findFirst({
      where: { id: req.params.id, userId: ownerId },
    });

    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const filePath = resolveFilePath(ownerId, file.path);
    if (!filePath) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }

    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${file.originalName || path.basename(file.path)}"`);
    
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Length', stat.size);
    
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (error) {
    console.error('Content error:', error);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// GET /api/files/:id/download
router.get('/:id/download', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const file = await prisma.file.findFirst({
      where: { id: req.params.id, userId: ownerId },
    });

    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const filePath = resolveFilePath(ownerId, file.path);
    if (!filePath) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }

    await logActivity(req.user!.userId, 'FILE_DOWNLOAD', 'file', file.id, req);

    const displayName = file.originalName || path.basename(file.path);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${displayName}"`);
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// GET /api/files/:id/thumbnail - Generate/serve thumbnail for images
router.get('/:id/thumbnail', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const file = await prisma.file.findFirst({
      where: { id: req.params.id, userId: ownerId },
    });

    if (!file || !file.mimeType?.startsWith('image/')) {
      res.status(404).json({ error: 'Image not found' });
      return;
    }

    const filePath = resolveFilePath(ownerId, file.path);
    if (!filePath) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }

    // Serve full image (could add sharp resizing later)
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (error) {
    console.error('Thumbnail error:', error);
    res.status(500).json({ error: 'Failed to generate thumbnail' });
  }
});

// DELETE /api/files/:id
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const file = await prisma.file.findFirst({
      where: { id: req.params.id, userId: ownerId },
    });

    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    // Try both paths
    const filePath = resolveFilePath(ownerId, file.path);
    if (filePath) {
      fs.unlinkSync(filePath);
    }

    await prisma.file.delete({ where: { id: file.id } });
    await logActivity(req.user!.userId, 'FILE_DELETE', 'file', file.id, req);

    res.json({ message: 'File deleted' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Batch delete
router.post('/batch-delete', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'ids array required' });
      return;
    }

    const files = await prisma.file.findMany({
      where: { id: { in: ids }, userId: ownerId },
    });

    for (const file of files) {
      const filePath = resolveFilePath(ownerId, file.path);
      if (filePath) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }

    await prisma.file.deleteMany({
      where: { id: { in: files.map(f => f.id) }, userId: ownerId },
    });

    res.json({ deleted: files.length });
  } catch (error) {
    console.error('Batch delete error:', error);
    res.status(500).json({ error: 'Failed to batch delete' });
  }
});

// PATCH /:id/rename - Rename a file
router.patch('/:id/rename', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { id } = req.params;
    const { newName } = req.body;

    if (!newName || typeof newName !== 'string' || newName.trim().length === 0) {
      res.status(400).json({ error: 'newName required' });
      return;
    }

    const file = await prisma.file.findFirst({
      where: { id, userId: ownerId },
    });

    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const oldPath = resolveFilePath(ownerId, file.path);
    if (!oldPath || !fs.existsSync(oldPath)) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }

    // Generate new path with sanitized name
    const ext = path.extname(file.path);
    const sanitized = newName.trim().replace(/[^a-zA-Z0-9_\-. ]/g, '_');
    const newPath = path.join(path.dirname(file.path), `${sanitized}${ext}`);
    
    // Construct new full path directly (don't use resolveFilePath since new file doesn't exist yet)
    const newFullPath = path.join(getUserUploadDir(ownerId), newPath);

    // Validate the new path is within user's directory (prevent path traversal)
    const userDir = getUserUploadDir(ownerId);
    if (!newFullPath.startsWith(userDir)) {
      res.status(400).json({ error: 'Invalid file path' });
      return;
    }

    if (fs.existsSync(newFullPath)) {
      res.status(409).json({ error: 'A file with that name already exists' });
      return;
    }

    // Rename on filesystem
    fs.renameSync(oldPath, newFullPath);

    // Update database
    const updated = await prisma.file.update({
      where: { id },
      data: {
        path: newPath,
        originalName: sanitized,
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('Rename error:', error);
    res.status(500).json({ error: 'Failed to rename file' });
  }
});

// POST /:id/copy-to-project - Copy file to a project
router.post('/:id/copy-to-project', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { id } = req.params;
    const { projectName, destinationPath, moveFile } = req.body;

    if (!projectName || typeof projectName !== 'string') {
      res.status(400).json({ error: 'projectName required' });
      return;
    }

    const file = await prisma.file.findFirst({
      where: { id, userId: ownerId },
    });

    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const sourcePath = resolveFilePath(ownerId, file.path);
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }

    // Verify project exists and user owns it
    const projectDir = path.join(process.env.PORTAL_ROOT || '/portal', 'projects', ownerId, projectName);
    if (!fs.existsSync(projectDir)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Determine destination path in project
    const fileName = file.originalName || path.basename(file.path);
    const destPath = destinationPath 
      ? path.join(projectDir, destinationPath, fileName)
      : path.join(projectDir, fileName);

    // Ensure destination directory exists
    const destDir = path.dirname(destPath);
    fs.mkdirSync(destDir, { recursive: true });

    // Check if file already exists
    if (fs.existsSync(destPath)) {
      res.status(409).json({ error: 'File already exists in project' });
      return;
    }

    // Copy or move the file
    if (moveFile) {
      fs.renameSync(sourcePath, destPath);
      // Delete from database
      await prisma.file.delete({ where: { id } });
    } else {
      fs.copyFileSync(sourcePath, destPath);
    }

    res.json({ 
      success: true, 
      action: moveFile ? 'moved' : 'copied',
      destination: path.relative(projectDir, destPath),
    });
  } catch (error) {
    console.error('Copy to project error:', error);
    res.status(500).json({ error: 'Failed to copy file to project' });
  }
});

// Helper: ensure ~/portal-files symlink for user
function ensureUserSymlink(userId: string) {
  const userDir = getUserUploadDir(userId);
  const symlinkPath = path.join('/root', 'portal-files');
  try {
    if (!fs.existsSync(symlinkPath)) {
      fs.symlinkSync(BASE_UPLOAD_DIR, symlinkPath);
    }
  } catch {}
}

// GET /api/files/upload-config — returns upload limits based on whether Cloudflare is in front
router.get('/upload-config', authenticateToken, (req: Request, res: Response) => {
  // Cloudflare adds these headers when proxying
  const behindCloudflare = !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['cf-ipcountry']);
  
  // Cloudflare free/pro plan limit: ~100MB per request
  // Without Cloudflare: limited only by server memory/disk and Express body-parser (default 100mb multer)
  const singleUploadLimit = behindCloudflare ? 95 * 1024 * 1024 : 2 * 1024 * 1024 * 1024; // 95MB vs 2GB
  const chunkSize = behindCloudflare ? 5 * 1024 * 1024 : 50 * 1024 * 1024; // 5MB vs 50MB chunks
  
  res.json({
    behindCloudflare,
    singleUploadLimit,
    chunkSize,
    singleUploadLimitMB: Math.round(singleUploadLimit / (1024 * 1024)),
    chunkSizeMB: Math.round(chunkSize / (1024 * 1024)),
  });
});

export default router;
export { BASE_UPLOAD_DIR, getUserUploadDir };
