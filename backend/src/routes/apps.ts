import { Router, Request, Response } from 'express';
import { captureBoundedMultipartBody } from '../utils/proxyMultipartBody';
import {
  APP_API_ID_HEADER,
  addConfiguredAppApiSecret,
  buildAppApiTargetUrl,
  configuredAppApiTargetBinding,
  invalidAppApiTargetResponse,
} from '../utils/appApiProxyAuth';
import { createAppApiAbortContext, serializeAppApiRequestBody, streamAppApiResponse } from '../utils/appApiProxy';
import multer from 'multer';
import path from 'path';
import { getAppTarget } from '../services/app-process.service';
import fs from 'fs';
import { nanoid } from 'nanoid';
import bcrypt from 'bcrypt';
import { authenticateToken } from '../middleware/auth';
import { requireApproved } from '../middleware/requireApproved';
import { scanFile } from '../services/virusScan';
import { prisma } from '../config/database';
import { config } from '../config/env';
import {
  escapeHtml,
  isBlockedAppStaticPath,
  isPathWithin,
  resolveExistingAppDirectory,
  resolveExistingPathWithin,
} from '../utils/appFileSecurity';
import {
  SharePasswordAttemptLimiter,
  isValidShareToken,
  issueShareGrant,
  parseShareLinkOptions,
  shareCredentialStateIsValid,
  shareGrantTtlMs,
  shareGrantCookieName,
  sharePasswordBinding,
  validateSharePassword,
  verifyShareGrant,
} from '../utils/shareAccessSecurity';
import { claimShareRateLimit } from '../services/shareRateLimit';
import { APP_ZIP_LIMITS, safeExtractZipToNewDirectory } from '../services/safeZipExtraction';
import { ensureRuntimeDirectory } from '../utils/runtimeDirectory';
import { portalFeatureUnavailableResponse } from '../utils/portalFeatureCapabilities';
import {
  ProjectExternalRuntimeLifecycleError,
  ProjectInvalidRuntimeBindingError,
  projectExternalRuntimeConflict,
  projectInvalidRuntimeBindingConflict,
  projectRuntimeManagement,
} from '../services/projectRuntimeManagement';

const router = Router();

export interface AppsStorageOptions {
  appsDir?: string;
  zipsDir?: string;
  portalRoot?: string;
}

export function resolveAppsStoragePaths(options: AppsStorageOptions = {}) {
  const portalRoot = path.resolve(options.portalRoot || process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || '/portal');
  return {
    appsDir: path.resolve(options.appsDir || process.env.PORTAL_APPS_ROOT || path.join(portalRoot, 'apps')),
    zipsDir: path.resolve(options.zipsDir || process.env.PORTAL_APP_ZIPS_ROOT || path.join(portalRoot, 'app-zips')),
  };
}

const appsStoragePaths = resolveAppsStoragePaths();
export const APPS_DIR = appsStoragePaths.appsDir;
export const ZIPS_DIR = appsStoragePaths.zipsDir;
const HOSTED_APPS_DIR = process.env.APPS_ROOT || '/var/www/bridgesllm-apps';
const MAX_APP_DESCRIPTION_LENGTH = 4_000;
const MAX_SHARE_HTML_BYTES = 5 * 1024 * 1024;
const MAX_APPS_PER_USER = 500;
const MAX_SHARE_LINKS_PER_APP = 1_000;
const MAX_RETURNED_SHARE_LINKS_PER_APP = 100;

function redactShareLink<T extends { passwordHash?: string | null }>(shareLink: T): Omit<T, 'passwordHash'> {
  const { passwordHash: _passwordHash, ...safeShareLink } = shareLink;
  return safeShareLink;
}

export function initializeAppsStorage(options: AppsStorageOptions = {}): ReturnType<typeof resolveAppsStoragePaths> {
  const paths = Object.keys(options).length > 0 ? resolveAppsStoragePaths(options) : appsStoragePaths;
  ensureRuntimeDirectory(paths.appsDir, { mode: 0o755 });
  ensureRuntimeDirectory(paths.zipsDir, { mode: 0o700, enforceMode: true });
  return paths;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      initializeAppsStorage();
      cb(null, ZIPS_DIR);
    } catch (error: any) {
      cb(error, ZIPS_DIR);
    }
  },
  filename: (_req, _file, cb) => {
    cb(null, `${nanoid(24)}.zip`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.originalname.toLowerCase().endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  },
});

// POST /api/apps - upload and extract
router.post('/', authenticateToken, requireApproved, upload.single('file'), async (req: Request, res: Response) => {
  let appDir: string | undefined;
  let createdAppId: string | undefined;
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No zip file provided' });
      return;
    }

    // Virus scan the uploaded zip
    const scanResult = await scanFile(req.file.path);
    if (!scanResult.clean) {
      res.status(scanResult.scannerAvailable ? 400 : 503).json({
        error: scanResult.scannerAvailable
          ? `File rejected: malware detected (${scanResult.threat})`
          : 'App upload is temporarily unavailable because malware scanning could not complete',
      });
      return;
    }

    const name = String(req.body.name || path.basename(req.file.originalname, '.zip'))
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 120) || 'app';
    const description = req.body.description === undefined ? '' : req.body.description;
    if (typeof description !== 'string' || description.length > MAX_APP_DESCRIPTION_LENGTH) {
      res.status(400).json({ error: 'Description must not exceed 4000 characters' });
      return;
    }
    appDir = path.join(APPS_DIR, `${req.user!.userId}-${name}-${Date.now()}-${nanoid(8)}`);

    await safeExtractZipToNewDirectory(req.file.path, appDir, {
      limits: APP_ZIP_LIMITS,
      collapseSingleRoot: false,
    });


    // Auto-detect project type
    let detectedType = 'unknown';
    let suggestedCommand = '';
    const checkDir = fs.readdirSync(appDir);
    // If there's a single subdirectory, look inside it
    let projectRoot = appDir;
    if (checkDir.length === 1 && fs.statSync(path.join(appDir, checkDir[0])).isDirectory()) {
      projectRoot = path.join(appDir, checkDir[0]);
    }
    const files = fs.readdirSync(projectRoot);
    if (files.includes('package.json')) {
      detectedType = 'node';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
        suggestedCommand = pkg.scripts?.start ? 'npm start' : pkg.scripts?.dev ? 'npm run dev' : 'node index.js';
      } catch { suggestedCommand = 'npm start'; }
    } else if (files.includes('requirements.txt')) {
      detectedType = 'python';
      suggestedCommand = files.includes('app.py') ? 'python app.py' : files.includes('main.py') ? 'python main.py' : 'python -m flask run';
    } else if (files.includes('Cargo.toml')) {
      detectedType = 'rust';
      suggestedCommand = 'cargo run';
    } else if (files.includes('Makefile') || files.includes('makefile')) {
      detectedType = 'make';
      suggestedCommand = 'make';
    } else if (files.includes('Dockerfile') || files.includes('docker-compose.yml')) {
      detectedType = 'docker';
      suggestedCommand = files.includes('docker-compose.yml') ? 'docker compose up -d' : 'docker build -t app . && docker run -d app';
    } else if (files.includes('index.html')) {
      detectedType = 'static';
      suggestedCommand = 'npx serve .';
    } else if (files.includes('go.mod')) {
      detectedType = 'go';
      suggestedCommand = 'go run .';
    }

    const app = await prisma.app.create({
      data: {
        userId: req.user!.userId,
        name,
        description: description || `${detectedType} project`,
        zipPath: appDir,
      },
    });
    createdAppId = app.id;

    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'APP_UPLOAD',
        resource: 'app',
        resourceId: app.id,
        severity: 'INFO',
      },
    }).catch(() => {});

    createdAppId = undefined;
    appDir = undefined;
    res.status(201).json({ ...app, detectedType, suggestedCommand });
  } catch (error) {
    console.error('App upload error:', error);
    if (createdAppId) {
      try { await prisma.app.delete({ where: { id: createdAppId } }); } catch {}
    }
    if (appDir) {
      try { fs.rmSync(appDir, { recursive: true, force: true }); } catch {}
    }
    res.status(500).json({ error: 'Failed to upload app' });
  } finally {
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
  }
});

// GET /api/apps - list
router.get('/', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const apps = await prisma.app.findMany({
      where: { userId: req.user!.userId },
      include: {
        shareLinks: {
          orderBy: { createdAt: 'desc' },
          take: MAX_RETURNED_SHARE_LINKS_PER_APP,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_APPS_PER_USER,
    });

    const safeApps = apps.map(({ shareLinks, ...app }) => ({
      ...app,
      shareLinks: shareLinks.map((shareLink) => redactShareLink(shareLink)),
    }));

    res.json({ apps: safeApps });
  } catch (error) {
    console.error('List apps error:', error);
    res.status(500).json({ error: 'Failed to list apps' });
  }
});

// DELETE /api/apps/:id
router.delete('/:id', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const app = await prisma.app.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });

    if (!app) {
      res.status(404).json({ error: 'App not found' });
      return;
    }

    const runtimeManagement = projectRuntimeManagement(app);
    if (runtimeManagement === 'invalid-external-binding') {
      res.status(503).json(projectInvalidRuntimeBindingConflict(
        new ProjectInvalidRuntimeBindingError('delete-app'),
      ));
      return;
    }
    if (runtimeManagement === 'external-loopback') {
      res.status(409).json(projectExternalRuntimeConflict(
        new ProjectExternalRuntimeLifecycleError('delete-app'),
      ));
      return;
    }
    if (app.projectIdentityId) {
      res.status(409).json({
        code: 'PROJECT_APP_MANAGED_BY_PROJECT',
        error: 'This App belongs to a Project deployment and must be removed from Projects.',
        detail: 'Open the Project deployment panel and use Remove deployment so Portal can stop its runtime and verify cleanup before deleting the App record.',
        recoveryAction: 'OPEN_PROJECT_DEPLOYMENT',
        retryable: false,
      });
      return;
    }

    // Delete only a real app directory inside one of the managed roots. A
    // database path or symlink must never turn this endpoint into recursive
    // deletion elsewhere on the host.
    if (fs.existsSync(app.zipPath)) {
      const managedPath = resolveExistingAppDirectory(app.zipPath, [APPS_DIR]);
      if (!managedPath) {
        res.status(409).json({ error: 'Deployed project apps must be removed from Projects so their runtime can be stopped safely' });
        return;
      }
      fs.rmSync(managedPath, { recursive: true, force: true });
    }

    await prisma.app.delete({ where: { id: app.id } });

    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'APP_DELETE',
        resource: 'app',
        resourceId: app.id,
        severity: 'INFO',
      },
    });

    res.json({ message: 'App deleted' });
  } catch (error) {
    console.error('Delete app error:', error);
    res.status(500).json({ error: 'Failed to delete app' });
  }
});

// POST /api/apps/:id/share - create share link
router.post('/:id/share', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const unavailable = portalFeatureUnavailableResponse('appHosting');
    if (unavailable) {
      res.status(409).json(unavailable);
      return;
    }
    const app = await prisma.app.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });

    if (!app) {
      res.status(404).json({ error: 'App not found' });
      return;
    }

    const existingShareCount = await prisma.appShareLink.count({ where: { appId: app.id, userId: req.user!.userId } });
    if (existingShareCount >= MAX_SHARE_LINKS_PER_APP) {
      res.status(409).json({ error: 'This app reached the retained share-link limit; delete an old link before creating another' });
      return;
    }

    const token = nanoid(21);
    let options;
    try {
      options = parseShareLinkOptions(req.body || {});
    } catch (error: any) {
      res.status(400).json({ error: error.message });
      return;
    }
    // App share links are public by default, and the Apps library only offers
    // expiry and use limits. But this route silently dropped `isPublic` and
    // `password` if a caller sent them, creating a public link while the
    // caller believed it was protected. Every read path here already gates on
    // `!isPublic && passwordHash`, so honour both rather than downgrade in
    // silence. This matches the Project share contract on the same table.
    const requestedPublic = req.body?.isPublic;
    const isPublic = requestedPublic === undefined ? true : requestedPublic !== false;
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    let passwordHash: string | null = null;
    if (!isPublic) {
      if (!password) {
        res.status(400).json({ error: 'Password required for password-protected links' });
        return;
      }
      try {
        validateSharePassword(password);
      } catch (error: any) {
        res.status(400).json({ error: error.message });
        return;
      }
      passwordHash = await bcrypt.hash(password, 12);
    } else if (password) {
      // A password with a public link is a contradiction. Refusing is the only
      // honest answer: quietly ignoring it hands back a link that protects
      // nothing while the caller thinks otherwise.
      res.status(400).json({
        error: 'A share password requires a private link. Send isPublic: false with the password.',
        code: 'SHARE_PASSWORD_REQUIRES_PRIVATE_LINK',
      });
      return;
    }

    const shareLink = await prisma.appShareLink.create({
      data: {
        appId: app.id,
        userId: req.user!.userId,
        token,
        expiresAt: options.expiresAt,
        maxUses: options.maxUses,
        rateLimitMaxRequests: options.rateLimitMaxRequests,
        rateLimitWindowSeconds: options.rateLimitWindowSeconds,
        isPublic,
        passwordHash,
      },
    });

    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'APP_SHARE_CREATE',
        resource: 'app',
        resourceId: app.id,
        severity: 'INFO',
        metadata: {
          shareLinkId: shareLink.id,
          expiresAt: options.expiresAt,
          maxUses: options.maxUses,
          rateLimitMaxRequests: options.rateLimitMaxRequests,
          rateLimitWindowSeconds: options.rateLimitWindowSeconds,
        },
      },
    }).catch(() => {});

    res.status(201).json({ shareLink: redactShareLink(shareLink), url: `/share/${token}` });
  } catch (error) {
    console.error('Create share link error:', error);
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

// GET /api/apps/:id/share - bounded owner-scoped share history
router.get('/:id/share', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const app = await prisma.app.findFirst({ where: { id: req.params.id, userId: req.user!.userId }, select: { id: true } });
    if (!app) { res.status(404).json({ error: 'App not found' }); return; }
    const shareLinks = await prisma.appShareLink.findMany({
      where: { appId: app.id, userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
      take: MAX_RETURNED_SHARE_LINKS_PER_APP,
    });
    res.json({ shareLinks: shareLinks.map((link) => redactShareLink(link)) });
  } catch (error) {
    console.error('List app share links error:', error);
    res.status(500).json({ error: 'Failed to list share links' });
  }
});

// PATCH /api/apps/:id/share/:linkId - enable/disable an owned retained link
router.patch('/:id/share/:linkId', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    if (typeof req.body?.isActive !== 'boolean') {
      res.status(400).json({ error: 'isActive boolean is required' });
      return;
    }
    if (req.body.isActive) {
      const unavailable = portalFeatureUnavailableResponse('appHosting');
      if (unavailable) {
        res.status(409).json(unavailable);
        return;
      }
    }
    const link = await prisma.appShareLink.findFirst({
      where: { id: req.params.linkId, appId: req.params.id, userId: req.user!.userId },
    });
    if (!link) { res.status(404).json({ error: 'Share link not found' }); return; }
    if (!shareCredentialStateIsValid(link)) {
      res.status(409).json({
        error: 'Share link credential state is invalid; delete it and create a new link',
        code: 'SHARE_CREDENTIAL_STATE_INVALID',
      });
      return;
    }

    if (req.body.isActive) {
      if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
        res.status(409).json({ error: 'Expired links cannot be reactivated; create a new link' });
        return;
      }
      if (link.maxUses !== null && link.currentUses >= link.maxUses) {
        res.status(409).json({ error: 'Links that reached their visit limit cannot be reactivated; create a new link' });
        return;
      }
    }

    const updated = await prisma.appShareLink.update({
      where: { id: link.id },
      data: { isActive: req.body.isActive },
    });
    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: req.body.isActive ? 'APP_SHARE_ENABLE' : 'APP_SHARE_DISABLE',
        resource: 'app',
        resourceId: req.params.id,
        severity: 'INFO',
        metadata: { shareLinkId: link.id },
      },
    }).catch(() => {});
    res.json({ shareLink: redactShareLink(updated) });
  } catch (error) {
    console.error('Update app share link error:', error);
    res.status(500).json({ error: 'Failed to update share link' });
  }
});

// DELETE /api/apps/:id/share/:linkId - permanently remove an owned link
router.delete('/:id/share/:linkId', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const deleted = await prisma.appShareLink.deleteMany({
      where: { id: req.params.linkId, appId: req.params.id, userId: req.user!.userId },
    });
    if (deleted.count !== 1) { res.status(404).json({ error: 'Share link not found' }); return; }
    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'APP_SHARE_DELETE',
        resource: 'app',
        resourceId: req.params.id,
        severity: 'INFO',
        metadata: { shareLinkId: req.params.linkId },
      },
    }).catch(() => {});
    res.json({ success: true });
  } catch (error) {
    console.error('Delete app share link error:', error);
    res.status(500).json({ error: 'Failed to delete share link' });
  }
});

// Shared app routes (NO AUTH) - mounted at /share
export const shareRouter = Router();

const passwordAttemptLimiter = new SharePasswordAttemptLimiter();

function requestIsSecure(req: Request): boolean {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').toLowerCase().includes('https');
}

function hasShareGrant(
  req: Request,
  link: { id: string; token: string; passwordHash?: string | null },
  kind: 'password' | 'visit',
): boolean {
  const cookie = req.cookies?.[shareGrantCookieName(kind, link.token)];
  const binding = kind === 'password' && link.passwordHash ? sharePasswordBinding(link.passwordHash) : undefined;
  return verifyShareGrant(cookie, { kind, token: link.token, linkId: link.id, binding }, config.jwtSecret);
}

function grantShareAccess(
  req: Request,
  res: Response,
  link: { id: string; token: string; passwordHash?: string | null },
  kind: 'password' | 'visit',
): void {
  const maxAge = shareGrantTtlMs(kind);
  const expiresAt = Date.now() + maxAge;
  const binding = kind === 'password' && link.passwordHash ? sharePasswordBinding(link.passwordHash) : undefined;
  const encoded = issueShareGrant({ kind, token: link.token, linkId: link.id, binding, expiresAt }, config.jwtSecret);
  res.cookie(shareGrantCookieName(kind, link.token), encoded, {
    httpOnly: true,
    secure: requestIsSecure(req),
    sameSite: 'strict',
    maxAge,
    path: `/share/${link.token}`,
  });
}

async function enforceShareRateLimit(
  link: {
    id: string;
    isActive: boolean;
    expiresAt: Date | null;
    rateLimitMaxRequests: number | null;
    rateLimitWindowSeconds: number | null;
    rateLimitRequestCount: number;
    rateLimitWindowStartedAt: Date | null;
  },
  res: Response,
): Promise<boolean> {
  const claim = await claimShareRateLimit(link);
  if (claim.status === 'allowed') return true;

  res.setHeader('Cache-Control', 'no-store');
  if (claim.status === 'limited') {
    res.setHeader('Retry-After', String(claim.retryAfterSeconds));
    res.status(429).json({
      error: 'Share link request rate limit reached. Try again later.',
      code: 'SHARE_RATE_LIMITED',
      retryAfterSeconds: claim.retryAfterSeconds,
    });
    return false;
  }

  console.warn('[Share Rate Limit] Admission could not be verified', {
    shareLinkId: link.id,
    reason: claim.reason,
  });
  res.status(503).json({
    error: 'Share link request rate limit could not be verified.',
    code: 'SHARE_RATE_LIMIT_UNAVAILABLE',
    retryable: true,
  });
  return false;
}

async function findShareLink(token: string) {
  if (!isValidShareToken(token)) return null;
  const link = await prisma.appShareLink.findFirst({
    where: {
      token,
      isActive: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    include: { app: true },
  });
  return link && shareCredentialStateIsValid(link) ? link : null;
}

async function enforceShareAccessWindow(
  link: { userId: string; app: { userId: string; isActive: boolean } },
  res: Response,
): Promise<boolean> {
  if (!link.app.isActive || link.userId !== link.app.userId) {
    res.status(404).send('App not found or link expired');
    return false;
  }
  return true;
}

async function claimShareVisit(
  req: Request,
  res: Response,
  link: { id: string; token: string; maxUses: number | null },
): Promise<boolean> {
  if (hasShareGrant(req, link, 'visit')) return true;

  const activeWindow = {
    id: link.id,
    isActive: true,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  };
  let claimed;
  if (link.maxUses !== null) {
    claimed = await prisma.appShareLink.updateMany({
      where: { ...activeWindow, currentUses: { lt: link.maxUses } },
      data: { currentUses: { increment: 1 } },
    });
  } else {
    claimed = await prisma.appShareLink.updateMany({
      where: activeWindow,
      data: { currentUses: { increment: 1 } },
    });
  }
  if (claimed.count !== 1) {
    res.status(404).send('Link expired or max uses reached');
    return false;
  }

  grantShareAccess(req, res, link, 'visit');
  return true;
}

function preflightShareVisit(
  req: Request,
  res: Response,
  link: { id: string; token: string; maxUses: number | null; currentUses: number },
): boolean {
  if (hasShareGrant(req, link, 'visit')) return true;
  if (link.maxUses !== null && link.currentUses >= link.maxUses) {
    // The request-rate window resets in at most one hour; a visitor slot lasts
    // 30 days. Reject a known-exhausted new browser before charging the shorter
    // budget, while keeping the actual slot mutation after rate admission so a
    // 429 can never consume a durable visitor slot.
    res.status(404).send('Link expired or max uses reached');
    return false;
  }
  return true;
}

function renderPasswordLandingPage(token: string, projectName?: string): string {
  const name = escapeHtml(projectName || 'Shared Project');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Password Required - ${name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0A0E27;
      color: #f0f4f8;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }
    .card {
      width: 100%;
      max-width: 420px;
      background: rgba(255,255,255,0.03);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 1.25rem;
      padding: 2.5rem;
      box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
    }
    .lock-icon {
      width: 48px; height: 48px; margin: 0 auto 1rem;
      display: flex; align-items: center; justify-content: center;
      background: rgba(16,185,129,0.1);
      border-radius: 50%;
    }
    .lock-icon svg { width: 24px; height: 24px; color: #10b981; }
    h1 { font-size: 1.5rem; font-weight: 700; text-align: center; margin-bottom: 0.5rem; }
    .subtitle { color: #94a3b8; text-align: center; margin-bottom: 1.5rem; font-size: 0.9rem; }
    .project-name { color: #818cf8; font-weight: 600; }
    input[type="password"] {
      width: 100%; padding: 0.85rem 1rem; border-radius: 0.75rem;
      background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
      color: white; font-size: 0.95rem; outline: none;
      transition: border-color 0.2s;
    }
    input[type="password"]:focus { border-color: rgba(16,185,129,0.5); }
    input[type="password"]::placeholder { color: #475569; }
    .btn {
      width: 100%; padding: 0.85rem; border-radius: 0.75rem;
      background: #10b981; color: white; border: none;
      font-size: 0.95rem; font-weight: 600; cursor: pointer;
      margin-top: 1rem; transition: background 0.2s, opacity 0.2s;
    }
    .btn:hover { background: #059669; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .error {
      background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.15);
      border-radius: 0.5rem; padding: 0.75rem; margin-top: 0.75rem;
      color: #f87171; font-size: 0.85rem; display: none; text-align: center;
    }
    .error.show { display: block; }
    .spinner { display: none; animation: spin 0.8s linear infinite; }
    .btn.loading .spinner { display: inline-block; }
    .btn.loading .btn-text { display: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="lock-icon">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
      </svg>
    </div>
    <h1>Password Required</h1>
    <p class="subtitle">Access <span class="project-name">${name}</span></p>
    <form id="authForm">
      <input type="password" id="password" placeholder="Enter password" autofocus autocomplete="off" />
      <div class="error" id="error"></div>
      <button type="submit" class="btn" id="submitBtn">
        <span class="btn-text">Access Project</span>
        <span class="spinner">⟳</span>
      </button>
    </form>
  </div>
  <script>
    const form = document.getElementById('authForm');
    const pw = document.getElementById('password');
    const err = document.getElementById('error');
    const btn = document.getElementById('submitBtn');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pw.value) return;
      btn.classList.add('loading');
      btn.disabled = true;
      err.classList.remove('show');
      try {
        const res = await fetch('/share/${token}/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw.value })
        });
        if (res.ok) {
          window.location.reload();
        } else {
          const data = await res.json();
          err.textContent = data.error || 'Authentication failed';
          err.classList.add('show');
          pw.value = '';
          pw.focus();
        }
      } catch {
        err.textContent = 'Connection error. Please try again.';
        err.classList.add('show');
      } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

async function serveAppFile(app: { zipPath: string }, requestedPath: string, res: Response, token?: string): Promise<boolean> {
  try {
    const appDir = app.zipPath;
    const resolvedAppDir = resolveExistingAppDirectory(appDir, [APPS_DIR, HOSTED_APPS_DIR]);

    if (!resolvedAppDir) {
      console.error('[Share] App directory is missing or outside the managed roots');
      res.status(404).send('Not found');
      return true;
    }

    if (!fs.existsSync(resolvedAppDir)) {
      console.error('[Share] App directory not found');
      return false;
    }

    // Prefer built artifacts when app root contains source + dist/ output.
    // Some shared apps are stored as full project folders (root index.html points to /src/main.tsx),
    // which white-screens when served by the portal runtime.
    const distDir = resolveExistingPathWithin(resolvedAppDir, path.join(resolvedAppDir, 'dist'));
    const distIndex = distDir ? resolveExistingPathWithin(distDir, path.join(distDir, 'index.html')) : null;
    const contentRoot = distDir && distIndex && fs.statSync(distIndex).isFile() ? distDir : resolvedAppDir;

    if (contentRoot !== resolvedAppDir) {
      console.log(`[Share] Using dist content root: ${contentRoot} (from ${resolvedAppDir})`);
    } else {
      // Guard: if no dist/ and root index.html contains Vite dev markers, refuse to serve it
      const guardIndex = resolveExistingPathWithin(resolvedAppDir, path.join(resolvedAppDir, 'index.html'));
      if (guardIndex) {
        if (fs.statSync(guardIndex).size > MAX_SHARE_HTML_BYTES) {
          res.status(413).send('App HTML is too large to serve safely');
          return true;
        }
        const guardHtml = fs.readFileSync(guardIndex, 'utf-8');
        if (guardHtml.includes('/src/main.tsx') || guardHtml.includes('/src/main.ts') || guardHtml.includes('/src/main.jsx')) {
          console.error(`[Share] BLOCKED: ${resolvedAppDir}/index.html contains Vite dev entry. Build artifacts (dist/) missing.`);
          res.status(500).send('<html><body style="font-family:sans-serif;padding:2rem;background:#0A0E27;color:#f0f4f8;"><h1>App Not Built</h1><p>This shared app has not been built for production. Please contact the app owner.</p></body></html>');
          return true;
        }
      }
    }

    // Determine file to serve
    const filePath = requestedPath || 'index.html';
    if (isBlockedAppStaticPath(filePath)) {
      console.warn(`[Share] Blocked private app artifact request: ${filePath}`);
      res.status(404).send('Not found');
      return true;
    }

    const fullPath = path.resolve(path.join(contentRoot, filePath));

    // Directory traversal protection
    if (!isPathWithin(contentRoot, fullPath)) {
      console.error('[Share] Directory traversal attempt');
      res.status(403).send('Forbidden');
      return true;
    }

    // Serve file if it exists and is not a directory
    if (fs.existsSync(fullPath)) {
      const resolvedPath = resolveExistingPathWithin(contentRoot, fullPath);
      if (!resolvedPath) {
        res.status(404).send('Not found');
        return true;
      }
      const stats = fs.statSync(resolvedPath);

      if (!stats.isDirectory()) {
        // Special handling for HTML files - inject <base> tag so relative assets resolve correctly
        if (token && resolvedPath.endsWith('.html')) {
          if (stats.size > MAX_SHARE_HTML_BYTES) {
            res.status(413).send('App HTML is too large to serve safely');
            return true;
          }
          const html = fs.readFileSync(resolvedPath, 'utf-8');
          const baseTag = `<base href="/share/${token}/">`;
          let modifiedHtml;
          if (html.includes('<head>')) {
            modifiedHtml = html.replace('<head>', `<head>\n    ${baseTag}`);
          } else if (html.includes('<HEAD>')) {
            modifiedHtml = html.replace('<HEAD>', `<HEAD>\n    ${baseTag}`);
          } else {
            modifiedHtml = baseTag + '\n' + html;
          }
          console.log(`[Share] Serving HTML with <base> tag: ${resolvedPath} (token: ${token})`);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.send(modifiedHtml);
        } else {
          console.log(`[Share] Serving file: ${resolvedPath}`);
          res.sendFile(resolvedPath);
        }
        return true;
      } else {
        // If it's a directory, try serving index.html from it
        const indexPath = resolveExistingPathWithin(contentRoot, path.join(resolvedPath, 'index.html'));
        if (indexPath && fs.statSync(indexPath).isFile()) {
          return serveAppFile(app, path.join(requestedPath || '', 'index.html'), res, token);
        }
      }
    }

    // SPA fallback - serve root index.html for client-side routing (non-file paths)
    const rootIndex = resolveExistingPathWithin(contentRoot, path.join(contentRoot, 'index.html'));
    if (rootIndex && fs.statSync(rootIndex).isFile() && requestedPath && !requestedPath.includes('.')) {
      console.log(`[Share] SPA fallback: ${rootIndex}`);
      return serveAppFile(app, '', res, token);
    }

    console.error('[Share] File not found');
    return false;
  } catch (error) {
    console.error('[Share] serveAppFile error:', error);
    res.status(500).send('Server error');
    return true;
  }
}

// Share-scoped API proxy.
// Supports apps that call relative "api/..." under /share/:token/.
// Uses streaming proxy semantics (no redirect) so methods/bodies/query are preserved.
shareRouter.all('/:token/api/*', async (req: Request, res: Response) => {
  const { token } = req.params;
  const proxiedPath = req.params[0] || '';
  const qsIndex = req.originalUrl.indexOf('?');
  const query = qsIndex >= 0 ? req.originalUrl.slice(qsIndex) : '';
  let proxyTimedOut = false;

  try {
    const link = await findShareLink(token);
    if (!link) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    if (!(await enforceShareAccessWindow(link, res))) {
      return;
    }

    // If password-protected, require established share session.
    if (!link.isPublic && link.passwordHash) {
      if (!hasShareGrant(req, link, 'password')) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    if (!preflightShareVisit(req, res, link)) return;
    if (!(await enforceShareRateLimit(link, res))) return;
    if (!(await claimShareVisit(req, res, link))) return;

    // Do not read a potentially large request body until the share token,
    // access window, and optional password session have all been validated.
    if (!(await captureBoundedMultipartBody(req, res))) {
      return;
    }

    // Target and secret selection are bound to the selected App row, never to
    // the caller-controlled first path segment. Managed targets are attested
    // internal-container addresses; explicit overrides must be loopback
    // targets keyed by the App id (APP_API_TARGET_<APP_ID>). There is no
    // Portal self-proxy fallback.
    const deployId = `${link.userId}-${link.app.name}`;
    const configuredBinding = configuredAppApiTargetBinding(link.app.id);
    if (configuredBinding.status === 'invalid') {
      res.status(503).json(invalidAppApiTargetResponse());
      return;
    }
    const registeredTarget = configuredBinding.status === 'absent'
      ? getAppTarget(deployId)
      : null;
    const baseTarget = configuredBinding.status === 'configured'
      ? configuredBinding.target
      : registeredTarget || undefined;
    const targetUrl = baseTarget ? buildAppApiTargetUrl(baseTarget, proxiedPath, query) : undefined;
    if (!targetUrl) {
      res.status(502).json({ error: 'App API backend is not configured' });
      return;
    }

    const incomingHeaders = req.headers as Record<string, string | string[] | undefined>;
    const upstreamHeaderAllowlist = new Set([
      'accept',
      'accept-language',
      'authorization',
      'content-type',
      'if-match',
      'if-none-match',
      'if-modified-since',
      'if-unmodified-since',
      'range',
      'x-requested-with',
    ]);
    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(incomingHeaders)) {
      if (!v) continue;
      const key = k.toLowerCase();
      if (!upstreamHeaderAllowlist.has(key)) continue;
      forwardHeaders[key] = Array.isArray(v) ? v.join(', ') : v;
    }

    // Always pass share token context; downstream can choose to honor it.
    forwardHeaders['x-share-token'] = token;
    forwardHeaders['x-portal-proxy'] = 'share-app-api';
    forwardHeaders[APP_API_ID_HEADER] = link.app.id;
    addConfiguredAppApiSecret(forwardHeaders, link.app.id);

    const method = req.method.toUpperCase();
    const shouldSendBody = !['GET', 'HEAD'].includes(method);
    // For multipart/form-data uploads, use the raw body buffer captured before
    // express.json() consumed the stream. For JSON, serialize as before.
    let body: any = undefined;
    if (shouldSendBody) {
      const incomingCt = String((req as any).headers['content-type'] || '');
      body = serializeAppApiRequestBody(incomingCt, req.body, (req as any).rawBody);
    }

    const abortContext = createAppApiAbortContext(req, res);
    try {
      const upstream = await fetch(targetUrl, {
        method,
        headers: forwardHeaders,
        body,
        redirect: 'manual',
        signal: abortContext.signal,
      });
      await streamAppApiResponse(upstream, res, { locationBasePath: `/share/${token}` });
      console.log(`[ShareAPI] ${method} app=${link.app.id} path=/api/${proxiedPath} status=${upstream.status}`);
    } finally {
      proxyTimedOut = abortContext.didTimeout();
      abortContext.cleanup();
    }
  } catch (error) {
    console.error('[ShareAPI] proxy error:', error);
    if (!res.headersSent) {
      res.status(proxyTimedOut ? 504 : 502).json({ error: proxyTimedOut ? 'Share API backend timeout' : 'Share API proxy error' });
    }
    else if (!res.writableEnded) res.end();
  }
});

// GET /share/:token/progress - Load saved progress
shareRouter.get('/:token/progress', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const link = await findShareLink(token);
    if (!link) { res.status(404).json({ error: 'Not found' }); return; }
    if (!(await enforceShareAccessWindow(link, res))) { return; }

    // Check password session if protected
    if (!link.isPublic && link.passwordHash) {
      if (!hasShareGrant(req, link, 'password')) {
        res.status(401).json({ error: 'Unauthorized' }); return;
      }
    }
    if (!preflightShareVisit(req, res, link)) return;
    if (!(await enforceShareRateLimit(link, res))) return;
    if (!(await claimShareVisit(req, res, link))) return;

    res.json({ data: link.progressData || null });
  } catch (error) {
    console.error('Load progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /share/:token/progress - Save progress
shareRouter.put('/:token/progress', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const link = await findShareLink(token);
    if (!link) { res.status(404).json({ error: 'Not found' }); return; }
    if (!(await enforceShareAccessWindow(link, res))) { return; }

    // Check password session if protected
    if (!link.isPublic && link.passwordHash) {
      if (!hasShareGrant(req, link, 'password')) {
        res.status(401).json({ error: 'Unauthorized' }); return;
      }
    }
    if (!preflightShareVisit(req, res, link)) return;
    if (!(await enforceShareRateLimit(link, res))) return;
    if (!(await claimShareVisit(req, res, link))) return;

    // Validate payload size (max 1MB)
    const body = JSON.stringify(req.body);
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 1048576) {
      res.status(413).json({ error: 'Progress data too large' }); return;
    }

    const updated = await prisma.appShareLink.updateMany({
      where: {
        id: link.id,
        isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      data: { progressData: req.body as any },
    });
    if (updated.count !== 1) {
      res.status(404).json({ error: 'Link is no longer active' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Save progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /share/:token/auth - Validate password
shareRouter.post('/:token/auth', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { password } = req.body;
    const ip = String(req.ip || req.socket.remoteAddress || 'unknown').slice(0, 128);

    if (!isValidShareToken(token)) {
      res.status(404).json({ error: 'Link not found' });
      return;
    }

    const link = await findShareLink(token);
    if (!link || !link.passwordHash) {
      res.status(404).json({ error: 'Link not found' });
      return;
    }
    if (!(await enforceShareAccessWindow(link, res))) return;

    if (typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 72) {
      res.status(400).json({ error: 'Password required' });
      return;
    }

    const rl = passwordAttemptLimiter.begin(ip, token);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfter || 60));
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }

    const valid = await bcrypt.compare(password, link.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Authentication failed' });
      return;
    }

    passwordAttemptLimiter.success(ip, token);
    if (!(await claimShareVisit(req, res, link))) return;
    grantShareAccess(req, res, link, 'password');
    res.json({ success: true });
  } catch (error) {
    console.error('Share auth error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

shareRouter.get('/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const shareLink = await findShareLink(token);

    if (!shareLink) {
      res.status(404).send('App not found or link expired');
      return;
    }

    if (!(await enforceShareAccessWindow(shareLink, res))) {
      return;
    }

    // If password-protected, check session access
    if (!shareLink.isPublic && shareLink.passwordHash) {
      if (!hasShareGrant(req, shareLink, 'password')) {
        res.setHeader('Content-Type', 'text/html');
        res.send(renderPasswordLandingPage(token, shareLink.app.name));
        return;
      }
    }

    if (!(await claimShareVisit(req, res, shareLink))) return;

    // Serve index.html
    if (await serveAppFile(shareLink.app, 'index.html', res, token)) return;
    res.status(404).send('No index.html found');
  } catch (error) {
    console.error('Serve shared app error:', error);
    res.status(500).send('Server error');
  }
});

shareRouter.get('/:token/*', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const shareLink = await findShareLink(token);

    if (!shareLink) {
      res.status(404).send('Not found');
      return;
    }

    if (!(await enforceShareAccessWindow(shareLink, res))) {
      return;
    }

    const requestedPath = req.params[0];
    if (isBlockedAppStaticPath(requestedPath)) {
      res.status(404).send('Not found');
      return;
    }

    // If password-protected, check session access
    if (!shareLink.isPublic && shareLink.passwordHash) {
      if (!hasShareGrant(req, shareLink, 'password')) {
        // For non-HTML asset requests, return 401 instead of the landing page
        // This prevents browsers from caching HTML as CSS/JS
        if (requestedPath && /\.(css|js|mjs|jsx|ts|tsx|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|json|webp|avif|mp4|webm|ogg|mp3|wav)$/i.test(requestedPath)) {
          res.status(401).send('Unauthorized');
          return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.send(renderPasswordLandingPage(token, shareLink.app.name));
        return;
      }
    }

    if (!(await claimShareVisit(req, res, shareLink))) return;
    console.log(`[Share] Wildcard route: link=${shareLink.id}, path=${requestedPath}`);
    if (await serveAppFile(shareLink.app, requestedPath, res, token)) return;
    res.status(404).send('Not found');
  } catch (error) {
    console.error('Serve shared asset error:', error);
    res.status(500).send('Server error');
  }
});

export default router;
