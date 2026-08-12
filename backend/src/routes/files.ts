import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { authenticateToken } from '../middleware/auth';
import { requireApproved } from '../middleware/requireApproved';
import { scanFile } from '../services/virusScan';
import { prisma } from '../config/database';
import { config } from '../config/env';
import { getWorkspaceOwnerId } from '../utils/workspaceScope';
import { canAccessPortal } from '../utils/authz';
import {
  ContainedPathError,
  ensureContainedDirectory,
  isPathContained,
  resolveContainedPath,
  safeRelativePath,
} from '../services/containedPath';
import {
  assignProjectRuntimeOwnership,
  ensureProjectRuntimeOwnedDirectory,
  ProjectRuntimeOwnershipError,
} from '../services/projectRuntimeOwnership';
import { withProjectDeletionLock } from '../services/projectDeletionLock';
import { generateBoundedThumbnail, ThumbnailError } from '../services/fileThumbnail';
import { issueFileCapabilityToken, verifyFileCapabilityToken } from '../services/fileCapabilityToken';
import { ensureRuntimeDirectory } from '../utils/runtimeDirectory';
import {
  FILE_LIBRARY_MAX_BATCH_DELETE,
  FILE_LIBRARY_MAX_SYNC_ENTRIES,
  FILE_LIBRARY_PAGE_SIZE,
  normalizeFileRename,
} from '../services/fileLibraryPolicy';
import { normalizeOwnedFileDeepLinkPath } from '../services/fileDeepLinkSelector';
import {
  admitWorkspaceAuthorizationRequest,
  settleWorkspaceAuthorizationRequestIfResponseEnded,
} from '../services/workspaceAuthorizationBarrier';

const router = Router();

// New storage path structure
const BASE_UPLOAD_DIR = path.resolve(process.env.PORTAL_FILES_ROOT || '/var/portal-files');

function getUserUploadDir(userId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new ContainedPathError('Invalid upload owner');
  initializeFileStorage();
  const directory = ensureContainedDirectory(BASE_UPLOAD_DIR, `user-${userId}/uploads`);
  fs.chmodSync(directory, 0o700);
  return directory;
}

function resolveOpenClawMediaMirrorBase(): string {
  const candidates = [
    process.env.OPENCLAW_STATE_DIR?.trim(),
    path.join(os.homedir(), '.openclaw'),
    '/root/.openclaw',
  ].filter((value): value is string => Boolean(value && value.trim()));

  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (fs.existsSync(normalized)) {
      return path.join(normalized, 'media', 'portal-files');
    }
  }

  return path.join(path.join(os.homedir(), '.openclaw'), 'media', 'portal-files');
}

export const OPENCLAW_MEDIA_MIRROR_BASE = path.resolve(
  process.env.PORTAL_OPENCLAW_MEDIA_MIRROR_ROOT || resolveOpenClawMediaMirrorBase(),
);

export interface FileStorageOptions {
  baseUploadDir?: string;
  mediaMirrorDir?: string;
}

export function initializeFileStorage(options: FileStorageOptions = {}): { baseUploadDir: string; mediaMirrorDir: string } {
  const baseUploadDir = path.resolve(options.baseUploadDir || BASE_UPLOAD_DIR);
  const mediaMirrorDir = path.resolve(options.mediaMirrorDir || OPENCLAW_MEDIA_MIRROR_BASE);
  ensureRuntimeDirectory(baseUploadDir, { mode: 0o700, enforceMode: true });
  ensureRuntimeDirectory(mediaMirrorDir, { mode: 0o700, enforceMode: true });
  return { baseUploadDir, mediaMirrorDir };
}

function getToolMirrorPath(userId: string, fileName: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new Error('Invalid mirror owner');
  initializeFileStorage();
  const mirrorRoot = fs.realpathSync(OPENCLAW_MEDIA_MIRROR_BASE);
  const uploadsDir = path.join(mirrorRoot, `user-${userId}`, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  const uploadsStat = fs.lstatSync(uploadsDir);
  if (uploadsStat.isSymbolicLink() || !uploadsStat.isDirectory()) throw new Error('Tool mirror directory is unsafe');
  const canonicalUploads = fs.realpathSync(uploadsDir);
  if (!isPathContained(mirrorRoot, canonicalUploads)) throw new Error('Tool mirror directory escaped its root');
  return path.join(canonicalUploads, path.basename(fileName));
}

function ensureToolMirror(userId: string, sourcePath: string, fileName?: string): string {
  const sourceStat = fs.lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new Error('Tool mirror source must be a regular file');
  const mirrorPath = getToolMirrorPath(userId, fileName || path.basename(sourcePath));
  if (fs.existsSync(mirrorPath)) {
    const existing = fs.lstatSync(mirrorPath);
    if (existing.isDirectory()) throw new Error('Tool mirror destination is a directory');
  }

  const temp = path.join(path.dirname(mirrorPath), `.${path.basename(mirrorPath)}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    try {
      fs.linkSync(sourcePath, temp);
    } catch (error: any) {
      if (!['EXDEV', 'EPERM', 'EMLINK'].includes(error?.code || '')) {
        throw error;
      }
      fs.copyFileSync(sourcePath, temp, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(temp, 0o600);
    }
    fs.renameSync(temp, mirrorPath);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }

  return mirrorPath;
}

function removeToolMirror(userId: string, fileName: string) {
  const mirrorPath = getToolMirrorPath(userId, fileName);
  try {
    if (fs.existsSync(mirrorPath) && !fs.lstatSync(mirrorPath).isDirectory()) fs.unlinkSync(mirrorPath);
  } catch {}
}

interface QuarantinedFilePath {
  original: string;
  quarantine: string;
}

function quarantineRegularFile(original: string, label: string): QuarantinedFilePath | null {
  if (!fs.existsSync(original)) return null;
  const stat = fs.lstatSync(original);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a regular file`);
  const quarantine = path.join(
    path.dirname(original),
    `.portal-delete-${crypto.randomBytes(12).toString('hex')}.part`,
  );
  fs.renameSync(original, quarantine);
  return { original, quarantine };
}

function quarantineToolMirror(userId: string, fileName: string): QuarantinedFilePath | null {
  return quarantineRegularFile(getToolMirrorPath(userId, fileName), 'Tool mirror');
}

function restoreQuarantinedFiles(entries: QuarantinedFilePath[]): void {
  for (const entry of [...entries].reverse()) {
    try {
      if (fs.existsSync(entry.quarantine) && !fs.existsSync(entry.original)) {
        fs.renameSync(entry.quarantine, entry.original);
      }
    } catch (error) {
      console.error('Failed to restore quarantined Portal file:', error);
    }
  }
}

function purgeQuarantinedFiles(entries: QuarantinedFilePath[]): void {
  for (const entry of entries) {
    try { fs.unlinkSync(entry.quarantine); } catch (error: any) {
      if (error?.code !== 'ENOENT') console.error('Failed to purge quarantined Portal file:', error);
    }
  }
}

function renameToolMirror(userId: string, oldFileName: string, newFileName: string, sourcePathForFallback?: string) {
  const oldMirrorPath = getToolMirrorPath(userId, oldFileName);
  const newMirrorPath = getToolMirrorPath(userId, newFileName);
  fs.mkdirSync(path.dirname(newMirrorPath), { recursive: true });

  if (fs.existsSync(oldMirrorPath)) {
    if (fs.lstatSync(oldMirrorPath).isDirectory()) throw new Error('Tool mirror source is a directory');
    if (fs.existsSync(newMirrorPath)) {
      if (fs.lstatSync(newMirrorPath).isDirectory()) throw new Error('Tool mirror destination is a directory');
    }
    fs.renameSync(oldMirrorPath, newMirrorPath);
    return newMirrorPath;
  }

  if (sourcePathForFallback && fs.existsSync(sourcePathForFallback)) {
    return ensureToolMirror(userId, sourcePathForFallback, newFileName);
  }

  return newMirrorPath;
}

function normalizeOrigin(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function getConfiguredPortalOrigins(): string[] {
  return Array.from(new Set(
    (config.corsOrigin || [])
      .map(origin => normalizeOrigin(String(origin || '').trim()))
      .filter((origin): origin is string => Boolean(origin))
  ));
}

function getTrustedRequestOrigin(req?: Request): string | null {
  if (!req) return null;
  const host = String(req.get('host') || '').trim();
  if (!host) return null;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0]?.trim();
  const proto = forwardedProto || req.protocol || 'http';
  const candidate = normalizeOrigin(`${proto}://${host}`);
  if (!candidate) return null;
  const configuredOrigins = getConfiguredPortalOrigins();
  return configuredOrigins.includes(candidate) ? candidate : null;
}

function buildDirectFileUrl(fileId: string, req: Request): string {
  const token = issueFileCapabilityToken(
    fileId,
    req.user!.userId,
    Number(req.user!.authorizationVersion ?? 1),
    config.jwtSecret,
  );
  const relativePath = `/api/files/${encodeURIComponent(fileId)}/direct-content?token=${encodeURIComponent(token)}`;
  const trustedOrigin = getTrustedRequestOrigin(req);
  const fallbackOrigin = getConfiguredPortalOrigins()[0] || '';
  return `${trustedOrigin || fallbackOrigin}${relativePath}`;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      cb(null, getUserUploadDir(req.user!.userId));
    } catch (error: any) {
      cb(error, BASE_UPLOAD_DIR);
    }
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 24);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 180) || 'file';
    cb(null, `${base}-${uniqueSuffix}${ext}`);
  },
});

const DIRECT_UPLOAD_MAX_BYTES = 500 * 1024 * 1024;

const upload = multer({
  storage,
  limits: { fileSize: DIRECT_UPLOAD_MAX_BYTES },
});

function parseFileUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (error: any) => {
    if (!error) {
      next();
      return;
    }
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: 'File exceeds the 500 MB direct-upload limit. Use the chunked uploader for files up to 2 GB.',
        });
        return;
      }
      if (error.code === 'LIMIT_UNEXPECTED_FILE') {
        res.status(400).json({ error: 'Upload must contain exactly one file field named "file"' });
        return;
      }
      res.status(413).json({ error: 'Upload exceeds the allowed multipart request limits' });
      return;
    }
    next(error);
  });
}

function getContainedProjectPath(ownerId: string, projectName: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(ownerId)) throw new ContainedPathError('Invalid project owner');
  const projectsRoot = path.resolve(
    process.env.PORTAL_PROJECTS_ROOT
      || path.join(process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || '/portal', 'projects'),
  );
  if (!projectName || path.basename(projectName) !== projectName || projectName.includes('\\')) {
    throw new ContainedPathError('Invalid project name');
  }
  const ownerRoot = resolveContainedPath(projectsRoot, ownerId, { mustExist: true, kind: 'directory' });
  return resolveContainedPath(ownerRoot, projectName, { mustExist: true, kind: 'directory' });
}

function getContainedProjectDestination(projectDir: string, destinationPath: unknown, fileName: string): string {
  const safeFileName = path.basename(fileName);
  const relativeDestination = typeof destinationPath === 'string' ? destinationPath : '';
  const requested = [relativeDestination.replace(/\/$/, ''), safeFileName].filter(Boolean).join('/');
  return resolveContainedPath(projectDir, requested, { mustExist: false });
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
  try {
    return resolveContainedPath(getUserUploadDir(userId), filePath, { mustExist: true, kind: 'file' });
  } catch {}

  const legacyRoot = '/portal/files';
  if (fs.existsSync(legacyRoot)) {
    try {
      const legacyOwnerDir = resolveContainedPath(legacyRoot, userId, { mustExist: true, kind: 'directory' });
      return resolveContainedPath(legacyOwnerDir, filePath, { mustExist: true, kind: 'file' });
    } catch {}
  }
  return null;
}

function setSafeFileResponseHeaders(res: Response, mimeType: string | null, displayName: string, disposition: 'inline' | 'attachment') {
  const safeName = String(displayName || 'file').replace(/[\r\n]/g, '').replace(/["\\]/g, '_').slice(0, 255) || 'file';
  const encodedName = encodeURIComponent(safeName).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const activeContent = /^(text\/(html|css|javascript|xml)|image\/svg\+xml|application\/(javascript|xhtml\+xml|xml))/i.test(mimeType || '');
  res.setHeader('Content-Type', activeContent ? 'application/octet-stream' : (mimeType || 'application/octet-stream'));
  res.setHeader('Content-Disposition', `${activeContent ? 'attachment' : disposition}; filename="${safeName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
}

function streamFileResponse(req: Request, res: Response, filePath: string, label: string): void {
  const stream = fs.createReadStream(filePath);
  const close = () => stream.destroy();
  req.once('aborted', close);
  res.once('close', close);
  stream.once('error', (error) => {
    console.error(`${label} stream error:`, error);
    if (!res.headersSent) res.status(500).json({ error: `Failed to stream ${label}` });
    else res.destroy(error);
  });
  stream.pipe(res);
}

async function getScopedOwnerId(req: Request): Promise<string> {
  return getWorkspaceOwnerId(req.user!);
}

// GET /api/files - list user files
router.get('/', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const requestedPage = Number(req.query.page || 1);
    const requestedLimit = Number(req.query.limit || 50);
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 && requestedPage <= 1_000_000
      ? requestedPage
      : 1;
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(FILE_LIBRARY_PAGE_SIZE, requestedLimit)
      : 50;
    const skip = (page - 1) * limit;
    const search = String(req.query.search || '').trim();
    const mimeFilter = String(req.query.mime || '').trim();
    if (search.length > 200 || mimeFilter.length > 100) {
      res.status(400).json({ error: 'File filter is too long' });
      return;
    }

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

    const [files, total, sizeAggregate] = await Promise.all([
      prisma.file.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.file.count({ where }),
      prisma.file.aggregate({ where, _sum: { size: true } }),
    ]);

    const serialized = files.map(f => ({
      ...f,
      size: f.size.toString(),
    }));

    res.json({
      files: serialized,
      total,
      totalSize: (sizeAggregate._sum.size || BigInt(0)).toString(),
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('List files error:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// GET /api/files/resolve - resolve one file by id or path for deep-linking
router.get('/resolve', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const id = String(req.query.id || '').trim();
    const rawPath = String(req.query.path || '').trim();
    if (!id && !rawPath) {
      res.status(400).json({ error: 'id or path required' });
      return;
    }
    if (id.length > 512 || rawPath.length > 2048 || /[\u0000-\u001f\u007f]/.test(id + rawPath)) {
      res.status(400).json({ error: 'File selector is invalid or too long' });
      return;
    }

    const normalizedPath = !id && rawPath
      ? normalizeOwnedFileDeepLinkPath(rawPath, {
          canonicalUploadsRoot: path.join(BASE_UPLOAD_DIR, `user-${ownerId}`, 'uploads'),
          mediaMirrorUploadsRoot: path.join(OPENCLAW_MEDIA_MIRROR_BASE, `user-${ownerId}`, 'uploads'),
          legacyOwnerRoot: path.join('/portal/files', ownerId),
        })
      : null;
    if (!id && rawPath && !normalizedPath) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const file = await prisma.file.findFirst({
      where: {
        userId: ownerId,
        ...(id
          ? { id }
          : { path: normalizedPath! }),
      },
    });

    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    res.json({ ...file, size: file.size.toString() });
  } catch (error) {
    console.error('Resolve file error:', error);
    res.status(500).json({ error: 'Failed to resolve file' });
  }
});

// POST /api/files - upload file
router.post('/', authenticateToken, requireApproved, parseFileUpload, async (req: Request, res: Response) => {
  let retainedPath: string | undefined = req.file?.path;
  let createdFileId: string | undefined;
  let createdMirror: { ownerId: string; fileName: string } | undefined;
  try {
    const ownerId = await getScopedOwnerId(req);
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const requestUserDir = getUserUploadDir(req.user!.userId);
    let requestUploadPath: string;
    try {
      requestUploadPath = resolveContainedPath(
        requestUserDir,
        safeRelativePath(requestUserDir, req.file.path),
        { mustExist: true, kind: 'file' },
      );
    } catch {
      try { fs.unlinkSync(req.file.path); } catch {}
      retainedPath = undefined;
      res.status(400).json({ error: 'Invalid file path' });
      return;
    }
    req.file.path = requestUploadPath;

    if (ownerId !== req.user!.userId) {
      const ownerDir = getUserUploadDir(ownerId);
      const movedPath = resolveContainedPath(ownerDir, path.basename(req.file.path), { mustExist: false });
      if (fs.existsSync(movedPath)) throw new Error('Upload destination collision');
      fs.renameSync(req.file.path, movedPath);
      req.file.path = movedPath;
      retainedPath = movedPath;
    }

    // Virus scan uploaded file
    const scanResult = await scanFile(req.file.path);
    if (!scanResult.clean) {
      try { fs.unlinkSync(req.file.path); } catch {}
      retainedPath = undefined;
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
      res.status(scanResult.scannerAvailable ? 400 : 503).json({
        error: scanResult.scannerAvailable
          ? `File rejected: malware detected (${scanResult.threat})`
          : 'File upload is temporarily unavailable because malware scanning could not complete',
      });
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
    createdFileId = file.id;

    // Mirror uploads into an OpenClaw-readable media root so image/pdf tools
    // can access them directly even though the canonical upload storage lives
    // outside the default allowed local media directories.
    const originalDiskPath = req.file.path;
    const diskPath = ensureToolMirror(ownerId, originalDiskPath, req.file.filename);
    createdMirror = { ownerId, fileName: req.file.filename };
    await logActivity(req.user!.userId, 'FILE_UPLOAD', 'file', file.id, req).catch(() => {});

    const toolUrl = buildDirectFileUrl(file.id, req);
    retainedPath = undefined;
    createdFileId = undefined;
    createdMirror = undefined;
    res.status(201).json({ ...file, size: file.size.toString(), diskPath, originalDiskPath, toolUrl });
  } catch (error) {
    console.error('Upload error:', error);
    if (createdFileId) {
      try { await prisma.file.delete({ where: { id: createdFileId } }); } catch {}
    }
    if (createdMirror) removeToolMirror(createdMirror.ownerId, createdMirror.fileName);
    if (retainedPath) {
      try { fs.unlinkSync(retainedPath); } catch {}
    }
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// GET /api/files/:id/direct-content - signed direct file content for tool access across hosts
router.get('/:id/direct-content', async (req: Request, res: Response) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token || token.length > 4096) {
      res.status(401).json({ error: 'Token required' });
      return;
    }

    const capability = verifyFileCapabilityToken(token, req.params.id, config.jwtSecret);
    if (!capability) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    if (!admitWorkspaceAuthorizationRequest(req, res, capability.actorUserId)) return;
    const actor = await prisma.user.findUnique({
      where: { id: capability.actorUserId },
      select: {
        id: true,
        email: true,
        role: true,
        accountStatus: true,
        isActive: true,
        sandboxEnabled: true,
        authorizationVersion: true,
      },
    });
    if (!actor
      || !canAccessPortal(actor.accountStatus, actor.isActive)
      || Number((actor as any).authorizationVersion ?? 1) !== capability.authorizationVersion) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    if (settleWorkspaceAuthorizationRequestIfResponseEnded(req, res)) return;
    const currentOwnerId = await getWorkspaceOwnerId({
      userId: actor.id,
      email: actor.email,
      role: actor.role,
      accountStatus: actor.accountStatus,
      sandboxEnabled: actor.sandboxEnabled,
      authorizationVersion: Number((actor as any).authorizationVersion ?? 1),
    });
    const file = await prisma.file.findFirst({
      where: { id: req.params.id, userId: currentOwnerId },
    });

    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const filePath = resolveFilePath(file.userId, file.path);
    if (!filePath) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }

    setSafeFileResponseHeaders(res, file.mimeType, file.originalName || path.basename(file.path), 'inline');
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');

    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }
    res.setHeader('Content-Length', stat.size.toString());

    streamFileResponse(req, res, filePath, 'file');
  } catch (error) {
    console.error('Direct content error:', error);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// GET /api/files/:id/content - AI-accessible file content (inline, no download header)
router.get('/:id/content', authenticateToken, requireApproved, async (req: Request, res: Response) => {
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

    setSafeFileResponseHeaders(res, file.mimeType, file.originalName || path.basename(file.path), 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }
    res.setHeader('Content-Length', stat.size.toString());
    streamFileResponse(req, res, filePath, 'file');
  } catch (error) {
    console.error('Content error:', error);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// GET /api/files/:id/download
router.get('/:id/download', authenticateToken, requireApproved, async (req: Request, res: Response) => {
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
    setSafeFileResponseHeaders(res, file.mimeType, displayName, 'attachment');
    res.setHeader('Cache-Control', 'private, no-store');
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }
    res.setHeader('Content-Length', stat.size.toString());
    streamFileResponse(req, res, filePath, 'file');
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// GET /api/files/:id/thumbnail - Generate/serve thumbnail for images
router.get('/:id/thumbnail', authenticateToken, requireApproved, async (req: Request, res: Response) => {
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

    const thumbnailPath = await generateBoundedThumbnail(
      filePath,
      path.join(getUserUploadDir(ownerId), '.thumbnails'),
    );
    const thumbnailStat = fs.lstatSync(thumbnailPath);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Length', thumbnailStat.size.toString());
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    streamFileResponse(req, res, thumbnailPath, 'thumbnail');
  } catch (error) {
    console.error('Thumbnail error:', error);
    res.status(error instanceof ThumbnailError ? error.statusCode : 500).json({ error: 'Failed to generate thumbnail' });
  }
});

// DELETE /api/files/:id
router.delete('/:id', authenticateToken, requireApproved, async (req: Request, res: Response) => {
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
    const quarantined: QuarantinedFilePath[] = [];
    try {
      const canonical = filePath ? quarantineRegularFile(filePath, 'Canonical file') : null;
      if (canonical) quarantined.push(canonical);
      const mirror = quarantineToolMirror(ownerId, file.path);
      if (mirror) quarantined.push(mirror);
    } catch (error) {
      restoreQuarantinedFiles(quarantined);
      throw error;
    }
    try {
      await prisma.file.delete({ where: { id: file.id } });
    } catch (error) {
      restoreQuarantinedFiles(quarantined);
      throw error;
    }
    purgeQuarantinedFiles(quarantined);
    await logActivity(req.user!.userId, 'FILE_DELETE', 'file', file.id, req).catch(() => {});

    res.json({ message: 'File deleted' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Batch delete
router.post('/batch-delete', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'ids array required' });
      return;
    }
    const uniqueIds = Array.from(new Set(ids.filter((id): id is string => (
      typeof id === 'string'
      && id.length > 0
      && id.length <= 512
      && !/[\u0000-\u001f\u007f]/.test(id)
    ))));
    if (uniqueIds.length !== ids.length || uniqueIds.length > FILE_LIBRARY_MAX_BATCH_DELETE) {
      res.status(400).json({ error: `ids must contain 1-${FILE_LIBRARY_MAX_BATCH_DELETE} unique file IDs` });
      return;
    }

    const files = await prisma.file.findMany({
      where: { id: { in: uniqueIds }, userId: ownerId },
    });

    const quarantined: QuarantinedFilePath[] = [];
    try {
      for (const file of files) {
        const filePath = resolveFilePath(ownerId, file.path);
        const canonical = filePath ? quarantineRegularFile(filePath, 'Canonical file') : null;
        if (canonical) quarantined.push(canonical);
        const mirror = quarantineToolMirror(ownerId, file.path);
        if (mirror) quarantined.push(mirror);
      }
    } catch (error) {
      restoreQuarantinedFiles(quarantined);
      throw error;
    }

    try {
      await prisma.file.deleteMany({
        where: { id: { in: files.map(f => f.id) }, userId: ownerId },
      });
    } catch (error) {
      restoreQuarantinedFiles(quarantined);
      throw error;
    }
    purgeQuarantinedFiles(quarantined);

    res.json({ deleted: files.length });
  } catch (error) {
    console.error('Batch delete error:', error);
    res.status(500).json({ error: 'Failed to batch delete' });
  }
});

// PATCH /:id/rename - Rename a file
router.patch('/:id/rename', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { id } = req.params;
    const { newName } = req.body;

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

    let normalizedRename;
    try {
      normalizedRename = normalizeFileRename(file.path, newName);
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Invalid file name' });
      return;
    }
    const newPath = normalizedRename.storedPath;
    
    // Construct new full path directly (don't use resolveFilePath since new file doesn't exist yet)
    const userDir = getUserUploadDir(ownerId);
    let newFullPath: string;
    try {
      newFullPath = resolveContainedPath(userDir, newPath.split(path.sep).join('/'), { mustExist: false });
    } catch {
      res.status(400).json({ error: 'Invalid file path' });
      return;
    }

    if (fs.existsSync(newFullPath)) {
      res.status(409).json({ error: 'A file with that name already exists' });
      return;
    }

    // Rename on filesystem
    fs.renameSync(oldPath, newFullPath);
    let updated;
    try {
      updated = await prisma.file.update({
        where: { id },
        data: {
          path: newPath,
          originalName: normalizedRename.displayName,
        },
      });
      renameToolMirror(ownerId, file.path, newPath, newFullPath);
    } catch (error) {
      try { fs.renameSync(newFullPath, oldPath); } catch {}
      try {
        await prisma.file.update({ where: { id }, data: { path: file.path, originalName: file.originalName } });
      } catch {}
      try { ensureToolMirror(ownerId, oldPath, file.path); } catch {}
      throw error;
    }

    res.json(updated);
  } catch (error) {
    console.error('Rename error:', error);
    res.status(500).json({ error: 'Failed to rename file' });
  }
});

// POST /:id/copy-to-project - Copy file to a project
router.post('/:id/copy-to-project', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { id } = req.params;
    const { projectName, destinationPath, moveFile } = req.body;

    if (
      !projectName
      || typeof projectName !== 'string'
      || projectName.length > 255
      || /[\u0000-\u001f\u007f]/.test(projectName)
    ) {
      res.status(400).json({ error: 'projectName required' });
      return;
    }
    if (
      (destinationPath !== undefined && (
        typeof destinationPath !== 'string'
        || destinationPath.length > 2048
        || /[\u0000-\u001f\u007f]/.test(destinationPath)
      ))
      || (moveFile !== undefined && typeof moveFile !== 'boolean')
    ) {
      res.status(400).json({ error: 'Copy destination or move option is invalid' });
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

    await withProjectDeletionLock({
      workspaceOwnerId: ownerId,
      projectName,
    }, async () => {
      // Resolve the live owner/name only after the same lifecycle lock used by
      // dependency installation, Project rename, and deletion is held.
      let projectDir: string;
      try {
        projectDir = getContainedProjectPath(ownerId, projectName);
      } catch {
        res.status(403).json({ error: 'Path traversal detected' });
        return;
      }

      // Verify project exists and user owns it
      if (!fs.existsSync(projectDir)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      // Determine destination path in project
      const fileName = path.basename(file.originalName || file.path);
      let destPath: string;
      try {
        destPath = getContainedProjectDestination(projectDir, destinationPath, fileName);
      } catch {
        res.status(403).json({ error: 'Path traversal detected' });
        return;
      }

      // Ensure destination directory exists
      const destDir = path.dirname(destPath);
      const relativeDestDir = path.relative(projectDir, destDir).split(path.sep).join('/');
      if (relativeDestDir) ensureProjectRuntimeOwnedDirectory(projectDir, relativeDestDir);

      // Check if file already exists
      if (fs.existsSync(destPath)) {
        res.status(409).json({ error: 'File already exists in project' });
        return;
      }

      let copiedProjectDestination: string | null = null;
      try {
        fs.copyFileSync(sourcePath, destPath, fs.constants.COPYFILE_EXCL);
        copiedProjectDestination = destPath;
        assignProjectRuntimeOwnership(projectDir, destPath, 'file');

        if (moveFile) {
          const quarantined: QuarantinedFilePath[] = [];
          try {
            const canonical = quarantineRegularFile(sourcePath, 'Canonical file');
            if (canonical) quarantined.push(canonical);
            const mirror = quarantineToolMirror(ownerId, file.path);
            if (mirror) quarantined.push(mirror);
          } catch (error) {
            restoreQuarantinedFiles(quarantined);
            throw error;
          }
          try {
            await prisma.file.delete({ where: { id } });
          } catch (error) {
            restoreQuarantinedFiles(quarantined);
            throw error;
          }
          purgeQuarantinedFiles(quarantined);
        }

        res.json({
          success: true,
          action: moveFile ? 'moved' : 'copied',
          destination: path.relative(projectDir, destPath),
        });
        copiedProjectDestination = null;
      } finally {
        if (copiedProjectDestination) {
          try { fs.unlinkSync(copiedProjectDestination); } catch {}
        }
      }
    });
  } catch (error) {
    console.error('Copy to project error:', error);
    if (
      error
      && typeof error === 'object'
      && (error as { code?: unknown }).code === 'PROJECT_DEPENDENCY_PROMOTION_QUARANTINED'
      && (error as { scope?: unknown }).scope === 'project'
    ) {
      res.status(409).json({
        error: error instanceof Error ? error.message : 'Project lifecycle mutation is contained',
        code: 'PROJECT_DEPENDENCY_PROMOTION_QUARANTINED',
        retryable: Boolean((error as { retryable?: unknown }).retryable),
      });
      return;
    }
    if (error instanceof ProjectRuntimeOwnershipError) {
      res.status(503).json({
        error: 'Project storage is temporarily unavailable. Try again.',
        code: error.code,
        retryable: error.retryable,
      });
      return;
    }
    res.status(500).json({ error: 'Failed to copy file to project' });
  }
});

// POST /api/files/sync — reconcile filesystem with database (auto-register untracked files, flag missing)
router.post('/sync', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const userDir = getUserUploadDir(ownerId);

    if (!fs.existsSync(userDir)) {
      res.json({ added: 0, removed: 0, skipped: 0 });
      return;
    }

    // Get all files currently on disk
    const diskFiles = new Set<string>();
    const entries = fs.readdirSync(userDir, { withFileTypes: true });
    if (entries.length > FILE_LIBRARY_MAX_SYNC_ENTRIES) {
      res.status(413).json({
        error: `File reconciliation is limited to ${FILE_LIBRARY_MAX_SYNC_ENTRIES} directory entries per run`,
      });
      return;
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        diskFiles.add(entry.name);
      }
    }

    // Get all files currently registered in DB for this user
    const dbFiles = await prisma.file.findMany({
      where: { userId: ownerId },
      select: { id: true, path: true },
      take: FILE_LIBRARY_MAX_SYNC_ENTRIES + 1,
    });
    if (dbFiles.length > FILE_LIBRARY_MAX_SYNC_ENTRIES) {
      res.status(413).json({
        error: `File reconciliation is limited to ${FILE_LIBRARY_MAX_SYNC_ENTRIES} database entries per run`,
      });
      return;
    }
    const dbPaths = new Set(dbFiles.map(f => f.path));

    // Find untracked files on disk (on disk but not in DB)
    let added = 0;
    let skipped = 0;
    const mimeMap: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      '.pdf': 'application/pdf', '.zip': 'application/zip',
      '.json': 'application/json', '.csv': 'text/csv',
      '.txt': 'text/plain', '.md': 'text/markdown',
      '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };

    for (const filename of diskFiles) {
      if (dbPaths.has(filename)) continue; // Already registered

      // Skip temp/partial files
      if (filename.startsWith('.') || filename.endsWith('.tmp') || filename.endsWith('.part')) {
        skipped++;
        continue;
      }

      try {
        const fullPath = resolveContainedPath(userDir, filename, { mustExist: true, kind: 'file' });
        const stat = fs.lstatSync(fullPath);
        const scanResult = await scanFile(fullPath);
        if (!scanResult.clean) {
          skipped++;
          await prisma.activityLog.create({
            data: {
              userId: req.user!.userId,
              action: 'FILE_SYNC_BLOCKED',
              resource: 'file',
              severity: scanResult.scannerAvailable ? 'CRITICAL' : 'WARNING',
              metadata: { filename, reason: scanResult.scannerAvailable ? scanResult.threat : 'scanner-unavailable' },
            },
          }).catch(() => {});
          continue;
        }
        const ext = path.extname(filename).toLowerCase();
        const mime = mimeMap[ext] || 'application/octet-stream';

        const created = await prisma.file.create({
          data: {
            userId: ownerId,
            path: filename,
            originalName: filename,
            size: BigInt(stat.size),
            mimeType: mime,
          },
        });
        try {
          ensureToolMirror(ownerId, fullPath, filename);
        } catch (error) {
          await prisma.file.delete({ where: { id: created.id } }).catch(() => {});
          throw error;
        }
        added++;
      } catch (err: any) {
        // Unique constraint = race condition, skip
        if (err?.code === 'P2002') continue;
        skipped++;
      }
    }

    // Find ghost records (in DB but missing from disk — also check legacy path)
    let removed = 0;
    for (const dbFile of dbFiles) {
      if (!diskFiles.has(dbFile.path)) {
        // Check legacy path too before flagging
        if (!resolveFilePath(ownerId, dbFile.path)) {
          const quarantined: QuarantinedFilePath[] = [];
          try {
            const mirror = quarantineToolMirror(ownerId, dbFile.path);
            if (mirror) quarantined.push(mirror);
            await prisma.file.delete({ where: { id: dbFile.id } });
          } catch (error) {
            restoreQuarantinedFiles(quarantined);
            throw error;
          }
          purgeQuarantinedFiles(quarantined);
          removed++;
        }
      }
    }

    res.json({ added, removed, skipped });
  } catch (error) {
    console.error('File sync error:', error);
    res.status(500).json({ error: 'Failed to sync files' });
  }
});

// GET /api/files/upload-config — returns upload limits based on whether Cloudflare is in front
router.get('/upload-config', authenticateToken, requireApproved, (req: Request, res: Response) => {
  // Cloudflare adds these headers when proxying
  const behindCloudflare = !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['cf-ipcountry']);
  
  // Cloudflare free/pro plan limit: ~100MB per request
  // Direct uploads are capped by Multer at 500MB. Chunked uploads use one
  // server-enforced 5MB contract on every network path and allow up to 2GB.
  const singleUploadLimit = behindCloudflare ? 95 * 1024 * 1024 : DIRECT_UPLOAD_MAX_BYTES;
  const chunkSize = 5 * 1024 * 1024;
  const maxChunkedUploadSize = 2 * 1024 * 1024 * 1024;
  
  res.json({
    behindCloudflare,
    singleUploadLimit,
    chunkSize,
    maxChunkedUploadSize,
    singleUploadLimitMB: Math.round(singleUploadLimit / (1024 * 1024)),
    chunkSizeMB: Math.round(chunkSize / (1024 * 1024)),
  });
});

export default router;
export {
  BASE_UPLOAD_DIR,
  buildDirectFileUrl,
  ensureToolMirror,
  getUserUploadDir,
  removeToolMirror,
  resolveFilePath,
};
