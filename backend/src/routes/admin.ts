import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../config/database';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin, requireOwner } from '../middleware/requireAdmin';
import { hashPassword } from '../utils/password';
import { AppError } from '../middleware/errorHandler';
import { sendEmail } from '../services/mailService';
import { sendPasswordResetEmail } from '../services/notificationService';
import { provisionUserMailbox, deleteUserMailbox, getProvisionedMailboxes } from '../services/userMailService';
import { cleanupUserBeforeDelete } from '../services/adminUserDeletion.service';
import path from 'path';
import {
  AVATARS_DIR,
  BRANDING_DIR,
  createImageUpload,
  parseCropParams,
  processImageToTarget,
  cleanupBasenameVariants,
  cleanupBasenamePrefixVariants,
  cleanupFile,
} from '../services/imageAssets';
import { ACTIVE_STATUS, canAccessPortal, isOwnerRole } from '../utils/authz';
import { buildPortalUrl } from '../utils/portalUrl';
import { configureDomainAndHttps, getCodingToolsStatus, getPublicIp, installCodingTool, updateEnvFile } from '../utils/serverSetup';
import { isReservedSystemMailboxUsername } from '../utils/reservedMailboxUsernames';
import dns from 'dns/promises';
import fs from 'fs';
import { getUpdateStatus } from '../services/telemetryService';
import { execSync, spawn } from 'child_process';

const router = Router();

// All admin routes require authentication + admin role
router.use(authenticateToken);
router.use(requireAdmin);

async function getSandboxDefaultEnabled(): Promise<boolean> {
  const raw = await prisma.systemSetting.findUnique({ where: { key: 'security.sandboxDefaultEnabled' } });
  return raw?.value === undefined ? true : raw.value === 'true';
}

async function isNotificationEnabled(key: string): Promise<boolean> {
  const raw = await prisma.systemSetting.findUnique({ where: { key } });
  return raw?.value !== 'false';
}

async function createUniqueUsername(baseName: string, email: string): Promise<string> {
  const fromName = baseName.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  const fromEmail = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  const base = fromName || fromEmail || 'user';

  let candidate = base;
  let suffix = 1;
  while (true) {
    if (!isReservedSystemMailboxUsername(candidate)) {
      const existing = await prisma.user.findUnique({ where: { username: candidate } });
      if (!existing) return candidate;
    }
    suffix += 1;
    candidate = `${base}${suffix}`.slice(0, 30);
  }
}

async function waitForStalwartJmap(timeoutMs = 45000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:8580/.well-known/jmap', { signal: AbortSignal.timeout(5000) });
      if (r.ok) return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return false;
}

async function checkStalwartHealth(): Promise<boolean> {
  try {
    const r = await fetch('http://127.0.0.1:8580/.well-known/jmap', { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

function teardownStalwart(mailDir: string): void {
  console.warn('[admin/install-mail] Stalwart health check failed; tearing down and recreating container');
  execSync('cd /opt/bridgesllm/stalwart && docker compose down -v 2>/dev/null; docker rm -f stalwart-mail 2>/dev/null; rm -rf /opt/bridgesllm/stalwart/data', { timeout: 120000, shell: '/bin/bash' });
  fs.mkdirSync(path.join(mailDir, 'data'), { recursive: true });
}

/**
 * Register a domain in Stalwart's internal directory.
 * Must be called before creating any accounts for that domain.
 */
async function ensureStalwartDomain(domain: string, adminPass: string): Promise<{ ok: boolean; error?: string }> {
  const authHeader = `Basic ${Buffer.from(`admin:${adminPass}`).toString('base64')}`;

  // Check if domain already exists
  try {
    const check = await fetch(`http://127.0.0.1:8580/api/principal/${encodeURIComponent(domain)}`, {
      headers: { 'Authorization': authHeader },
      signal: AbortSignal.timeout(5000),
    });
    if (check.ok) {
      const data: any = await check.json().catch(() => null);
      if (data?.data?.type === 'domain') return { ok: true };
    }
  } catch {}

  // Create the domain principal
  try {
    const response = await fetch('http://127.0.0.1:8580/api/principal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
      body: JSON.stringify({ type: 'domain', name: domain, description: 'BridgesLLM Portal' }),
      signal: AbortSignal.timeout(10000),
    });
    const raw = await response.text();
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }

    if (!response.ok && response.status !== 409) {
      return { ok: false, error: `Failed to create domain: ${body?.error || raw || response.status}` };
    }
    if (body && typeof body === 'object' && body.error && body.error !== 'alreadyExists') {
      return { ok: false, error: `Domain creation error: ${body.error}` };
    }
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: `Domain creation request failed: ${error?.message}` };
  }
}

async function createStalwartAccount(domain: string, adminPass: string, name: string, pass: string): Promise<{ ok: boolean; error?: string; body?: any }> {
  try {
    const response = await fetch('http://127.0.0.1:8580/api/principal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`admin:${adminPass}`).toString('base64')}`,
      },
      body: JSON.stringify({ type: 'individual', name, secrets: [pass], emails: [`${name}@${domain}`], roles: ['user'], description: name === 'noreply' ? 'System Alerts' : name === 'support' ? 'Support' : name, quota: 1024 * 1024 * 1024 }),
      signal: AbortSignal.timeout(10000),
    });
    const raw = await response.text();
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }

    if (!response.ok) {
      return { ok: false, error: typeof body === 'object' && body?.error ? String(body.error) : raw || `HTTP ${response.status}`, body };
    }
    if (body && typeof body === 'object' && 'error' in body && body.error) {
      return { ok: false, error: String(body.error) + (body.item ? `: ${body.item}` : ''), body };
    }
    return { ok: true, body };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'Request failed' };
  }
}

async function resolveSelfUpdateDomain(): Promise<string> {
  const envPath = path.join(process.env.PORTAL_ROOT || '/opt/bridgesllm/portal', 'backend', '.env.production');
  try {
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const match = envContent.match(/^DOMAIN=(.+)$/m);
      if (match?.[1]?.trim()) return match[1].trim();
    }
  } catch {}

  const domainSetting = await prisma.systemSetting.findFirst({
    where: { OR: [{ key: 'domain' }, { key: 'portal.domain' }, { key: 'site.domain' }] },
    orderBy: { updatedAt: 'desc' },
  }).catch(() => null);

  const domain = String(domainSetting?.value || process.env.DOMAIN || '').trim();
  if (domain) return domain;

  // Last resort: extract domain from CORS_ORIGIN (e.g. "https://example.com,https://www.example.com")
  const corsOrigin = process.env.CORS_ORIGIN || '';
  const corsMatch = corsOrigin.match(/https?:\/\/(?:www\.)?([a-z0-9][\w.-]+\.[a-z]{2,})/i);
  if (corsMatch?.[1]) return corsMatch[1];

  return '';
}


// ── Users ─────────────────────────────────────────────────────────

/**
 * GET /api/admin/users
 * List all users (paginated)
 */
router.get('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));
    const skip = (page - 1) * limit;
    const search = (req.query.search as string) || '';

    const where = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' as const } },
            { username: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          username: true,
          firstName: true,
          lastName: true,
          role: true,
          accountStatus: true,
          isActive: true,
          sandboxEnabled: true,
          lastLoginAt: true,
          approvedAt: true,
          approvedBy: true,
          createdAt: true,
          avatarPath: true,
        },
      } as any),
      prisma.user.count({ where }),
    ]);

    res.json({
      users,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/users/:id
 * Get user details
 */
router.get('/users/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        role: true,
        accountStatus: true,
        isActive: true,
        sandboxEnabled: true,
        lastLoginAt: true,
        approvedAt: true,
        approvedBy: true,
        createdAt: true,
        updatedAt: true,
        avatarPath: true,
        metadata: true,
      },
    } as any);

    if (!user) throw new AppError(404, 'User not found');
    res.json(user);
  } catch (error) {
    next(error);
  }
});

const updateUserSchema = z.object({
  role: z.enum(['SUB_ADMIN', 'USER', 'VIEWER']).optional(),
  accountStatus: z.enum(['ACTIVE', 'PENDING', 'DISABLED', 'BANNED']).optional(),
  sandboxEnabled: z.boolean().optional(),
  isActive: z.boolean().optional(),
  username: z.string().min(2).max(100).optional(),
  firstName: z.string().max(100).optional().nullable(),
  lastName: z.string().max(100).optional().nullable(),
}).strict();

/**
 * PATCH /api/admin/users/:id
 * Update user (role, sandboxEnabled, etc.)
 */
router.patch('/users/:id', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const data = updateUserSchema.parse(req.body);

    if (data.username && isReservedSystemMailboxUsername(data.username)) {
      throw new AppError(400, `Username '${data.username}' is reserved for system use. Choose a different username.`);
    }

    // Check user exists
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'User not found');

    if (id === req.user!.userId && data.role) {
      throw new AppError(400, 'Cannot change your own owner role directly');
    }

    if (isOwnerRole(existing.role) && (data.role || data.accountStatus || data.isActive === false)) {
      throw new AppError(400, 'Cannot demote/disable owner from this endpoint');
    }

    const normalizedData: Record<string, unknown> = { ...data };
    if (data.isActive !== undefined && data.accountStatus === undefined) {
      normalizedData.accountStatus = data.isActive ? 'ACTIVE' : 'DISABLED';
    }
    if (data.accountStatus !== undefined) {
      normalizedData.isActive = data.accountStatus === ACTIVE_STATUS;
    }

    const user = await prisma.user.update({
      where: { id },
      data: normalizedData as any,
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        role: true,
        accountStatus: true,
        isActive: true,
        sandboxEnabled: true,
        lastLoginAt: true,
        createdAt: true,
        avatarPath: true,
      },
    } as any);

    // Provision mailbox if username changed, but keep prior mailboxes accessible
    if (normalizedData.username && normalizedData.username !== existing.username) {
      try {
        await provisionUserMailbox(String(normalizedData.username), id, { makePrimary: true });
        console.log(`[admin] Provisioned mailbox for user ${String(normalizedData.username)}`);
      } catch (err) {
        console.error('[admin] Mailbox provisioning failed (non-fatal):', err);
      }
    }

    // Log the change
    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'USER_UPDATED',
        resource: 'admin',
        resourceId: id,
        severity: 'INFO',
        translatedMessage: `Owner updated user ${existing.email}: ${JSON.stringify(normalizedData)}`,
        metadata: { targetUser: id, changes: normalizedData } as any,
      },
    }).catch(() => {});

    res.json(user);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/admin/users/:id
 * Delete a user (cannot delete self)
 */
router.delete('/users/:id', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    if (id === req.user!.userId) {
      throw new AppError(400, 'Cannot delete your own account');
    }

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'User not found');
    if (isOwnerRole(existing.role)) throw new AppError(400, 'Cannot delete owner account');

    const cleanup = await cleanupUserBeforeDelete(id);

    // Delete sessions first, then user row. Other dependent rows are expected to
    // be gone via cleanup or DB cascade, but we keep this transactional tail small.
    await prisma.$transaction(async (tx) => {
      await tx.session.deleteMany({ where: { userId: id } });
      await tx.user.delete({ where: { id } });
    });

    // Log deletion
    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'USER_DELETED',
        resource: 'admin',
        severity: 'WARNING',
        translatedMessage: `Admin deleted user: ${existing.email}`,
        metadata: {
          deletedUserId: id,
          deletedEmail: existing.email,
          cleanupSummary: cleanup.summary,
          cleanupFailures: cleanup.failures,
        },
      },
    }).catch(() => {});

    res.json({ success: true, cleanup });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/users/:id/transfer-ownership
 * Transfer OWNER role to another active user.
 */
router.post('/users/:id/transfer-ownership', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetId = req.params.id;
    if (targetId === req.user!.userId) throw new AppError(400, 'You already own this account');

    const target = await prisma.user.findUnique({ where: { id: targetId } } as any);
    if (!target) throw new AppError(404, 'Target user not found');
    if (!canAccessPortal((target as any).accountStatus, target.isActive)) {
      throw new AppError(400, 'Target user must be active to become owner');
    }
    if (isOwnerRole(target.role)) throw new AppError(400, 'Target user is already owner');

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: req.user!.userId }, data: { role: 'SUB_ADMIN' as any } });
      await tx.user.update({
        where: { id: targetId },
        data: { role: 'OWNER' as any, accountStatus: 'ACTIVE', isActive: true } as any,
      } as any);
    });

    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'OWNER_TRANSFERRED',
        resource: 'admin',
        resourceId: targetId,
        severity: 'WARNING',
        translatedMessage: `Ownership transferred to ${target.email}`,
        metadata: { fromUserId: req.user!.userId, toUserId: targetId, toEmail: target.email },
      },
    }).catch(() => {});

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});


router.get('/update-status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getUpdateStatus());
  } catch (error) {
    next(error);
  }
});

router.post('/check-updates', requireOwner, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { checkForUpdates } = await import('../services/telemetryService');
    res.json(await checkForUpdates());
  } catch (error) {
    next(error);
  }
});

router.post('/self-update', requireOwner, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const domain = await resolveSelfUpdateDomain();
    if (!domain) throw new AppError(400, 'No domain configured for self-update.');

    // SECURITY: Validate domain format to prevent shell injection (CRIT-1 from audit)
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)+$/;
    if (!domainRegex.test(domain)) {
      throw new AppError(400, 'Invalid domain format — cannot run self-update.');
    }

    const logsDir = '/opt/bridgesllm/logs';
    fs.mkdirSync(logsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logsDir, `self-update-${timestamp}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.write(`[${new Date().toISOString()}] Starting self-update for ${domain}\n`);

    // The installer runs `systemctl stop bridgesllm-product` which kills
    // everything in the service's cgroup — setsid/nohup/detached don't escape it.
    // systemd-run launches in its own transient scope, completely outside our cgroup.
    logStream.end(); // close our handle — the shell will append directly
    const escapedDomain = domain.replace(/'/g, "'\\''");
    const child = spawn('systemd-run', [
      '--scope', '--quiet',
      '/bin/bash', '-c',
      `curl -fsSL https://bridgesllm.ai/install.sh | bash -s -- --update --domain '${escapedDomain}' >> ${logFile} 2>&1`,
    ], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    res.json({ ok: true, logFile });
  } catch (error) {
    next(error);
  }
});

router.get('/self-update/log', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const file = String(req.query.file || '').trim();
    if (!file) throw new AppError(400, 'Missing log file path');
    const normalized = path.resolve(file);
    if (!normalized.startsWith('/opt/bridgesllm/logs/self-update-')) {
      throw new AppError(400, 'Invalid log file path');
    }
    if (!fs.existsSync(normalized)) {
      throw new AppError(404, 'Log file not found');
    }
    const content = fs.readFileSync(normalized, 'utf8');
    const lines = content.split(/\r?\n/);
    res.json({ ok: true, file: normalized, content: lines.slice(-200).join('\n') });
  } catch (error) {
    next(error);
  }
});

// ── Registration Requests ─────────────────────────────────────────

/**
 * GET /api/admin/registration-requests
 * List registration requests (filter by status)
 */
router.get('/registration-requests', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));
    const skip = (page - 1) * limit;

    const where = status ? { status: status as any } : {};

    const [requests, total] = await Promise.all([
      prisma.registrationRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { requestedAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          message: true,
          status: true,
          requestedAt: true,
          reviewedAt: true,
          reviewedBy: true,
        },
      }),
      prisma.registrationRequest.count({ where }),
    ]);

    res.json({
      requests,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/registration-requests/:id/approve
 * Approve a registration request → create a User account
 */
router.post('/registration-requests/:id/approve', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const request = await prisma.registrationRequest.findUnique({ where: { id } });
    if (!request) throw new AppError(404, 'Registration request not found');
    if (request.status !== 'PENDING') {
      throw new AppError(400, `Request already ${request.status.toLowerCase()}`);
    }

    const approvedAt = new Date();
    let approvedUserId: string;
    let approvedUsername: string;

    // Check if a user with this email already exists
    const existingUser = await prisma.user.findUnique({ where: { email: request.email } });
    if (existingUser) {
      if ((existingUser as any).accountStatus !== 'PENDING') {
        throw new AppError(409, 'A non-pending user with this email already exists');
      }

      const updatedUser = await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          role: 'USER',
          accountStatus: 'ACTIVE',
          isActive: true,
          approvedAt,
          approvedBy: req.user!.userId,
          sandboxEnabled: await getSandboxDefaultEnabled(),
        },
      } as any);
      approvedUserId = updatedUser.id;
      approvedUsername = updatedUser.username;
    } else {
      const approvedUsernameCandidate = await createUniqueUsername(request.name, request.email);
      const createdUser = await prisma.user.create({
        data: {
          email: request.email,
          username: approvedUsernameCandidate,
          passwordHash: request.passwordHash || await hashPassword(crypto.randomUUID()),
          role: 'USER',
          accountStatus: 'ACTIVE',
          isActive: true,
          approvedAt,
          approvedBy: req.user!.userId,
          sandboxEnabled: await getSandboxDefaultEnabled(),
        },
      } as any);
      approvedUserId = createdUser.id;
      approvedUsername = createdUser.username;
    }

    try {
      await provisionUserMailbox(approvedUsername, approvedUserId, { makePrimary: true });
    } catch (err) {
      console.error('[admin] Failed to auto-provision mailbox on registration approval:', err);
    }

    // Update request status
    await prisma.registrationRequest.update({
      where: { id },
      data: {
        status: 'APPROVED',
        reviewedAt: new Date(),
        reviewedBy: req.user!.userId,
      },
    });

    if (await isNotificationEnabled('notifications.userApproved')) {
      try {
        await prisma.passwordResetToken.deleteMany({
          where: { userId: approvedUserId, usedAt: null },
        });

        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = await hashPassword(rawToken);
        await prisma.passwordResetToken.create({
          data: {
            userId: approvedUserId,
            token: tokenHash,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });

        const resetUrl = buildPortalUrl(`/reset-password?token=${encodeURIComponent(rawToken)}`, req);
        await sendPasswordResetEmail({ email: request.email }, resetUrl);
      } catch (err) {
        console.error('[admin] Failed to send approval email:', err);
      }
    }

    // Log approval
    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'REGISTRATION_APPROVED',
        resource: 'admin',
        severity: 'INFO',
        translatedMessage: `Approved registration request from ${request.email}`,
        metadata: { requestId: id, email: request.email, approvedUserId, approvedUsername },
      },
    }).catch(() => {});

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/registration-requests/:id/deny
 * Deny a registration request
 */
router.post('/registration-requests/:id/deny', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    const request = await prisma.registrationRequest.findUnique({ where: { id } });
    if (!request) throw new AppError(404, 'Registration request not found');
    if (request.status !== 'PENDING') {
      throw new AppError(400, `Request already ${request.status.toLowerCase()}`);
    }

    await prisma.registrationRequest.update({
      where: { id },
      data: {
        status: 'DENIED',
        reviewedAt: new Date(),
        reviewedBy: req.user!.userId,
      },
    });

    // Log denial
    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'REGISTRATION_DENIED',
        resource: 'admin',
        severity: 'INFO',
        translatedMessage: `Denied registration request from ${request.email}${reason ? ': ' + reason : ''}`,
        metadata: { requestId: id, email: request.email, reason },
      },
    }).catch(() => {});

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ── System Settings ───────────────────────────────────────────────

/**
 * GET /api/admin/settings
 * Get all SystemSettings as a key-value object
 */
router.get('/settings', requireOwner, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await prisma.systemSetting.findMany();
    const result: Record<string, string> = {};
    for (const s of settings) {
      result[s.key] = s.value;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

const settingsSchema = z.record(z.string(), z.string());
const searchVisibilitySchema = z.object({
  visibility: z.enum(['visible', 'hidden']),
});

/**
 * PUT /api/admin/settings
 * Bulk upsert SystemSettings
 */
router.put('/settings', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = settingsSchema.parse(req.body);
    const normalizedData = { ...data };

    if (normalizedData['security.registrationMode']) {
      normalizedData['registrationMode'] = normalizedData['security.registrationMode'];
    } else if (normalizedData['registrationMode']) {
      normalizedData['security.registrationMode'] = normalizedData['registrationMode'];
    }

    // Upsert each setting
    await Promise.all(
      Object.entries(normalizedData).map(([key, value]) =>
        prisma.systemSetting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        })
      )
    );

    // Log settings change
    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'SETTINGS_UPDATED',
        resource: 'admin',
        severity: 'INFO',
        translatedMessage: `Admin updated system settings: ${Object.keys(normalizedData).join(', ')}`,
        metadata: { keys: Object.keys(normalizedData) },
      },
    }).catch(() => {});

    // Return updated settings
    const settings = await prisma.systemSetting.findMany();
    const result: Record<string, string> = {};
    for (const s of settings) {
      result[s.key] = s.value;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/search-visibility', requireOwner, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: 'system.searchEngineVisibility' } });
    const visibility = row?.value === 'visible' ? 'visible' : 'hidden';
    res.json({ visibility });
  } catch (error) {
    next(error);
  }
});

router.put('/search-visibility', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { visibility } = searchVisibilitySchema.parse(req.body);
    await prisma.systemSetting.upsert({
      where: { key: 'system.searchEngineVisibility' },
      update: { value: visibility },
      create: { key: 'system.searchEngineVisibility', value: visibility },
    });

    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'SETTINGS_UPDATED',
        resource: 'admin',
        severity: 'INFO',
        translatedMessage: `Admin updated search engine visibility to ${visibility}`,
        metadata: { key: 'system.searchEngineVisibility', visibility },
      },
    }).catch(() => {});

    res.json({ visibility });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/settings/test-email
 * Sends a test email to the requesting admin using configured SMTP settings
 */
router.post('/settings/test-email', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mailDomain = process.env.MAIL_DOMAIN || 'localhost';
    const noreplyEmail = `noreply@${mailDomain}`;
    const adminUser = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { email: true },
    });

    if (!adminUser?.email) {
      throw new AppError(400, 'Admin email not found');
    }

    const now = new Date().toISOString();
    await sendEmail({
      from: noreplyEmail,
      to: [{ email: adminUser.email }],
      subject: 'Bridges Portal — Test Email',
      textBody: `Test email successful.\n\nSent at: ${now}\nFrom: ${noreplyEmail}\nTo: ${adminUser.email}`,
      htmlBody: `<div style="font-family:sans-serif;padding:24px;background:#111827;color:#e2e8f0;border-radius:8px;">
        <h2 style="color:#10b981;margin:0 0 16px;">✓ Test Email Successful</h2>
        <p style="margin:0 0 8px;">Your Bridges Portal email system is working correctly.</p>
        <p style="margin:0;font-size:12px;color:#64748b;">Sent at: ${now}</p>
      </div>`,
    });

    res.json({ success: true, message: `Test email sent to ${adminUser.email}` });
  } catch (error: any) {
    if (error instanceof AppError) return next(error);
    return res.status(400).json({
      success: false,
      error: error?.message || 'Failed to send test email',
    });
  }
});


const uploadImage = createImageUpload('image');
const AGENT_PROVIDERS = ['OPENCLAW', 'CLAUDE_CODE', 'CODEX', 'AGENT_ZERO', 'GEMINI', 'OLLAMA'] as const;

router.post('/appearance/logo', requireOwner, uploadImage, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const cropParams = parseCropParams(req.body);
    const basename = `portal-logo-${Date.now()}`;
    const { ext } = await processImageToTarget(req.file.path, req.file.mimetype, path.join(BRANDING_DIR, basename), cropParams, { staticSize: 512, gifSize: 256 });
    cleanupBasenamePrefixVariants(BRANDING_DIR, 'portal-logo', `${basename}${ext}`);
    cleanupFile(req.file.path);

    const logoUrl = `/static-assets/branding/${basename}${ext}`;
    await prisma.systemSetting.upsert({
      where: { key: 'appearance.logoUrl' },
      update: { value: logoUrl },
      create: { key: 'appearance.logoUrl', value: logoUrl },
    });

    return res.json({ success: true, logoUrl });
  } catch (error) {
    return next(error);
  }
});

router.delete('/appearance/logo', requireOwner, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    cleanupBasenamePrefixVariants(BRANDING_DIR, 'portal-logo');
    await prisma.systemSetting.upsert({
      where: { key: 'appearance.logoUrl' },
      update: { value: '' },
      create: { key: 'appearance.logoUrl', value: '' },
    });
    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/appearance/agent-avatar/:provider', requireOwner, uploadImage, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const provider = String(req.params.provider || '').toUpperCase();
    if (!AGENT_PROVIDERS.includes(provider as any)) {
      cleanupFile(req.file.path);
      return res.status(400).json({ error: 'Unsupported provider' });
    }

    const cropParams = parseCropParams(req.body);
    const basename = `agent-${provider}-${Date.now()}`;
    const { ext } = await processImageToTarget(req.file.path, req.file.mimetype, path.join(AVATARS_DIR, basename), cropParams, { staticSize: 256, gifSize: 256 });
    cleanupBasenamePrefixVariants(AVATARS_DIR, `agent-${provider}`, `${basename}${ext}`);
    cleanupFile(req.file.path);

    const avatarUrl = `/static-assets/avatars/${basename}${ext}`;
    const key = `appearance.agentAvatar.${provider}`;
    await prisma.systemSetting.upsert({
      where: { key },
      update: { value: avatarUrl },
      create: { key, value: avatarUrl },
    });

    return res.json({ success: true, avatarUrl, provider });
  } catch (error) {
    return next(error);
  }
});

router.delete('/appearance/agent-avatar/:provider', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = String(req.params.provider || '').toUpperCase();
    if (!AGENT_PROVIDERS.includes(provider as any)) return res.status(400).json({ error: 'Unsupported provider' });

    cleanupBasenameVariants(AVATARS_DIR, `agent-${provider.toLowerCase()}`);
    const key = `appearance.agentAvatar.${provider}`;
    await prisma.systemSetting.upsert({ where: { key }, update: { value: '' }, create: { key, value: '' } });

    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

/* ─── Sub-agent avatar upload / delete ──────────────────────────────────── */

router.post('/appearance/sub-agent-avatar/:agentId', requireOwner, uploadImage, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const agentId = String(req.params.agentId || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!agentId) {
      cleanupFile(req.file.path);
      return res.status(400).json({ error: 'Invalid agent id' });
    }

    const cropParams = parseCropParams(req.body);
    const basename = `subagent-${agentId}-${Date.now()}`;
    const { ext } = await processImageToTarget(req.file.path, req.file.mimetype, path.join(AVATARS_DIR, basename), cropParams, { staticSize: 256, gifSize: 256 });
    cleanupBasenamePrefixVariants(AVATARS_DIR, `subagent-${agentId}`, `${basename}${ext}`);
    cleanupFile(req.file.path);

    const avatarUrl = `/static-assets/avatars/${basename}${ext}`;
    const key = `appearance.subAgentAvatar.${agentId}`;
    await prisma.systemSetting.upsert({
      where: { key },
      update: { value: avatarUrl },
      create: { key, value: avatarUrl },
    });

    return res.json({ success: true, avatarUrl, agentId });
  } catch (error) {
    return next(error);
  }
});

router.delete('/appearance/sub-agent-avatar/:agentId', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agentId = String(req.params.agentId || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!agentId) return res.status(400).json({ error: 'Invalid agent id' });

    cleanupBasenamePrefixVariants(AVATARS_DIR, `subagent-${agentId}`);
    const key = `appearance.subAgentAvatar.${agentId}`;
    await prisma.systemSetting.upsert({ where: { key }, update: { value: '' }, create: { key, value: '' } });

    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /api/admin/email-status
 * Check Stalwart JMAP email system connectivity and return status info
 */
router.get('/email-status', requireOwner, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stalwartUrl = process.env.STALWART_URL || 'http://127.0.0.1:8580';
    const stalwartUser = process.env.STALWART_NOREPLY_USER || 'noreply';
    const stalwartPass = process.env.STALWART_NOREPLY_PASS || '';

    let connected = false;
    let error: string | null = null;

    try {
      // Try JMAP session endpoint to check connectivity
      const authHeader = 'Basic ' + Buffer.from(`${stalwartUser}:${stalwartPass}`).toString('base64');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${stalwartUrl}/.well-known/jmap`, {
        headers: { Authorization: authHeader },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      connected = response.ok;
      if (!response.ok) {
        error = `JMAP responded with status ${response.status}`;
      }
    } catch (err: any) {
      connected = false;
      error = err?.code === 'ABORT_ERR' ? 'Connection timed out' : (err?.message || 'Connection failed');
    }

    res.json({
      connected,
      server: 'Stalwart Mail Server',
      protocol: 'JMAP',
      sender: `noreply@${process.env.MAIL_DOMAIN || 'localhost'}`,
      url: stalwartUrl,
      error,
    });
  } catch (error) {
    next(error);
  }
});

// ── Mailbox Management ────────────────────────────────────────────

/**
 * GET /api/admin/mailboxes
 * List all users with provisioned Stalwart mailboxes
 */
router.get('/mailboxes', requireOwner, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const mailboxes = await getProvisionedMailboxes();
    res.json({ mailboxes });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/admin/mailboxes/:username
 * Delete a user's Stalwart mailbox (admin only)
 */
router.delete('/mailboxes/:username', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username } = req.params;
    if (!username) throw new AppError(400, 'Username required');

    await deleteUserMailbox(username);

    // Log the action
    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'MAILBOX_DELETED',
        resource: 'admin',
        severity: 'WARNING',
        translatedMessage: `Admin deleted mailbox for user: ${username}`,
        metadata: { username },
      },
    }).catch(() => {});

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});


router.get('/coding-tools-status', requireOwner, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getCodingToolsStatus());
  } catch (error) {
    next(error);
  }
});

router.post('/install-coding-tool', requireOwner, async (req: Request, res: Response) => {
  try {
    const toolId = z.object({ toolId: z.string().min(1) }).parse(req.body).toolId;
    installCodingTool(toolId);
    res.json({ success: true, toolId });
  } catch (err: any) {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err?.message ? `Failed to install: ${String(err.message).substring(0, 200)}` : 'Installation failed' });
  }
});

router.get('/domain-status', requireOwner, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let currentDomain = '';
    try {
      const caddyfile = fs.readFileSync('/etc/caddy/Caddyfile', 'utf8');
      const domainMatch = caddyfile.match(/^([a-zA-Z0-9][-a-zA-Z0-9.]+\.[a-zA-Z]{2,})[,\s]/m);
      if (domainMatch) currentDomain = domainMatch[1];
    } catch {}

    const publicIp = getPublicIp();
    const httpsActive = Boolean(currentDomain);

    res.json({ currentDomain, publicIp, httpsActive });
  } catch (error) {
    next(error);
  }
});

router.post('/check-domain-dns', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { domain } = z.object({
      domain: z.string().min(3).max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, 'Invalid domain format'),
    }).parse(req.body);
    const publicIp = getPublicIp();

    let resolvedIps: string[] = [];
    let resolves = false;
    let pointsToUs = false;

    try {
      resolvedIps = await dns.resolve4(domain);
      resolves = resolvedIps.length > 0;
      pointsToUs = resolvedIps.includes(publicIp);
    } catch {}

    res.json({
      domain,
      resolves,
      pointsToUs,
      resolvedIps,
      expectedIp: publicIp,
      message: !resolves
        ? `${domain} doesn't resolve yet. Add an A record pointing to ${publicIp}.`
        : pointsToUs
          ? `${domain} is pointed at this server. Ready for HTTPS!`
          : `${domain} resolves to ${resolvedIps.join(', ')} but this server is ${publicIp}.`,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/configure-domain', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { domain } = z.object({
      domain: z.string().min(3).max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, 'Invalid domain format'),
    }).parse(req.body);
    const result = await configureDomainAndHttps(domain);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ── Admin Install Mail ────────────────────────────────────────────

/**
 * POST /api/admin/install-mail
 * Install (or reinstall) the Stalwart mail server via Docker.
 * Same logic as setup-v3 install-mail, but uses admin auth instead of setup token.
 * Reads domain from MAIL_DOMAIN env var or the configured domain setting.
 */
router.post('/install-mail', requireOwner, async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    let domain = (process.env.MAIL_DOMAIN || '').trim();
    if (!domain && req.body?.domain) {
      domain = String(req.body.domain).trim();
    }
    if (!domain) {
      try {
        const caddyfile = fs.readFileSync('/etc/caddy/Caddyfile', 'utf8');
        const m = caddyfile.match(/^([a-zA-Z0-9][-a-zA-Z0-9.]+\.[a-zA-Z]{2,})[,\s]/m);
        if (m) domain = m[1];
      } catch {}
    }
    if (!domain) {
      return res.status(400).json({ error: 'No domain configured. Set MAIL_DOMAIN or configure domain first.' });
    }

    try {
      execSync('docker info', { timeout: 5000, stdio: 'ignore' });
    } catch {
      return res.status(500).json({ error: 'Docker is not running. Email requires Docker for the mail server.' });
    }

    let stalwartAlreadyRunning = false;
    try {
      const containers = execSync('docker ps --filter name=stalwart-mail --format "{{.Names}}"', { timeout: 5000 }).toString().trim();
      if (containers.includes('stalwart-mail')) stalwartAlreadyRunning = true;
    } catch {}

    if (!stalwartAlreadyRunning) {
      const portCheck = (port: number): boolean => {
        try {
          execSync(`ss -tlnp sport = :${port} 2>/dev/null | grep -q ':${port}'`, { timeout: 3000, shell: '/bin/bash' });
          return true;
        } catch { return false; }
      };
      const busyPorts = [25, 587, 993].filter(portCheck);
      if (busyPorts.length > 0) {
        return res.status(409).json({ error: `Mail ports ${busyPorts.join(', ')} are already in use. Stop the existing service first.` });
      }
    }

    const PORTAL_ROOT = process.env.PORTAL_ROOT || '/opt/bridgesllm/portal';
    const INSTALL_ROOT = path.dirname(PORTAL_ROOT);
    const mailDir = path.join(INSTALL_ROOT, 'stalwart');
    fs.mkdirSync(path.join(mailDir, 'data'), { recursive: true });

    const randPass = (len: number) => crypto.randomBytes(len).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, len);

    let adminPass = randPass(16);
    let supportPass = randPass(24);
    let noreplyPass = randPass(24);
    const envProdPath = path.join(PORTAL_ROOT, 'backend', '.env.production');
    if (fs.existsSync(envProdPath)) {
      const envContent = fs.readFileSync(envProdPath, 'utf-8');
      const ea = envContent.match(/STALWART_ADMIN_PASS=(.+)/)?.[1]?.trim();
      const es = envContent.match(/STALWART_SUPPORT_PASS=(.+)/)?.[1]?.trim();
      const en = envContent.match(/STALWART_NOREPLY_PASS=(.+)/)?.[1]?.trim();
      if (ea) adminPass = ea;
      if (es) supportPass = es;
      if (en) noreplyPass = en;
    }

    const writeStalwartConfig = () => {
      const composeContent = `version: '3.8'
services:
  stalwart:
    image: stalwartlabs/stalwart:latest
    container_name: stalwart-mail
    restart: unless-stopped
    ports:
      - "25:25"
      - "587:587"
      - "993:993"
      - "127.0.0.1:8580:8080"
    volumes:
      - ./data:/opt/stalwart
`;
      fs.writeFileSync(path.join(mailDir, 'docker-compose.yml'), composeContent);

      const dataDir = path.join(mailDir, 'data');
      const etcDir = path.join(dataDir, 'etc');
      fs.mkdirSync(etcDir, { recursive: true });
      const configToml = `# Stalwart Mail Server — BridgesLLM Portal
[lookup.default]
hostname = "mail.${domain}"

[server.listener.smtp]
bind = "[::]:25"
protocol = "smtp"

[server.listener.submission]
bind = "[::]:587"
protocol = "smtp"
tls.implicit = false

[server.listener.imaptls]
bind = "[::]:993"
protocol = "imap"
tls.implicit = true

[server.listener.http]
protocol = "http"
bind = "[::]:8080"

[storage]
data = "rocksdb"
fts = "rocksdb"
blob = "rocksdb"
lookup = "rocksdb"
directory = "internal"

[store.rocksdb]
type = "rocksdb"
path = "/opt/stalwart/data"
compression = "lz4"

[directory.internal]
type = "internal"
store = "rocksdb"

[tracer.log]
type = "log"
level = "info"
path = "/opt/stalwart/logs"
prefix = "stalwart.log"
rotate = "daily"
ansi = false
enable = true

[auth.dkim.sign]
"0.if" = "is_local_domain(sender_domain)"
"0.then" = '["rsa-" + sender_domain, "ed25519-" + sender_domain]'
"1.else" = "false"

[authentication.fallback-admin]
user = "admin"
secret = "${adminPass}"
`;
      fs.writeFileSync(path.join(etcDir, 'config.toml'), configToml);
    };

    const startFreshStalwart = async () => {
      writeStalwartConfig();
      try {
        execSync('docker compose pull', { cwd: mailDir, timeout: 180000, stdio: 'pipe' });
      } catch (err: any) {
        const stderr = err.stderr?.toString()?.slice(-200) || '';
        throw new AppError(500, `Failed to pull mail server image. ${stderr}`.trim());
      }
      try {
        execSync('docker compose up -d', { cwd: mailDir, timeout: 120000, stdio: 'pipe' });
      } catch (err: any) {
        const stderr = err.stderr?.toString()?.slice(-200) || '';
        throw new AppError(500, `Failed to start mail server container. ${stderr}`.trim());
      }
      const ready = await waitForStalwartJmap();
      if (!ready) {
        throw new AppError(500, "Mail server started but didn't respond within 45 seconds.");
      }
    };

    let recreated = false;
    if (stalwartAlreadyRunning) {
      const healthy = await checkStalwartHealth();
      if (!healthy) {
        teardownStalwart(mailDir);
        stalwartAlreadyRunning = false;
        recreated = true;
      }
    }

    if (!stalwartAlreadyRunning) {
      await startFreshStalwart();
    }

    // Register the domain in Stalwart BEFORE creating accounts.
    // Without this, account creation returns "notFound: <domain>".
    const domainResult = await ensureStalwartDomain(domain, adminPass);
    if (!domainResult.ok) {
      if (!recreated) {
        console.warn('[admin/install-mail] Domain creation failed; tearing down Stalwart:', domainResult.error);
        teardownStalwart(mailDir);
        await startFreshStalwart();
        recreated = true;
        const retryDomain = await ensureStalwartDomain(domain, adminPass);
        if (!retryDomain.ok) {
          return res.status(500).json({ error: `Failed to register domain in mail server: ${retryDomain.error}` });
        }
      } else {
        return res.status(500).json({ error: `Failed to register domain in mail server: ${domainResult.error}` });
      }
    }

    let supportResult = await createStalwartAccount(domain, adminPass, 'support', supportPass);
    let noreplyResult = await createStalwartAccount(domain, adminPass, 'noreply', noreplyPass);

    if ((!supportResult.ok || !noreplyResult.ok) && !recreated) {
      console.warn('[admin/install-mail] Account creation failed; tearing down and recreating Stalwart', supportResult, noreplyResult);
      teardownStalwart(mailDir);
      await startFreshStalwart();
      recreated = true;
      const retryDomain2 = await ensureStalwartDomain(domain, adminPass);
      if (!retryDomain2.ok) {
        return res.status(500).json({ error: `Failed to register domain after recreating mail server: ${retryDomain2.error}` });
      }
      supportResult = await createStalwartAccount(domain, adminPass, 'support', supportPass);
      noreplyResult = await createStalwartAccount(domain, adminPass, 'noreply', noreplyPass);
    }

    if (!supportResult.ok || !noreplyResult.ok) {
      const detail = supportResult.ok ? noreplyResult.error : supportResult.error;
      return res.status(500).json({ error: `Failed to create Stalwart accounts: ${detail || 'unknown error'}`, supportResult, noreplyResult });
    }

    const keyPath = path.join(mailDir, 'dkim.key');
    let dkimRecord = 'v=DKIM1; k=rsa; p=YOUR_DKIM_PUBLIC_KEY';
    try {
      execSync(`openssl genrsa -out "${keyPath}" 2048 2>/dev/null`, { timeout: 10000 });
      const pubkey = execSync(`openssl rsa -in "${keyPath}" -pubout -outform DER 2>/dev/null | base64 -w0`, { timeout: 5000, encoding: 'utf-8' }).trim();
      dkimRecord = `v=DKIM1; k=rsa; p=${pubkey}`;
      fs.writeFileSync(path.join(mailDir, 'dkim-dns-record.txt'), dkimRecord);
    } catch {}

    updateEnvFile({
      STALWART_URL: 'http://127.0.0.1:8580',
      STALWART_ADMIN_PASS: adminPass,
      STALWART_SUPPORT_USER: 'support',
      STALWART_SUPPORT_PASS: supportPass,
      STALWART_NOREPLY_USER: 'noreply',
      STALWART_NOREPLY_PASS: noreplyPass,
      MAIL_DOMAIN: domain,
    });
    process.env.STALWART_URL = 'http://127.0.0.1:8580';
    process.env.STALWART_ADMIN_PASS = adminPass;
    process.env.STALWART_SUPPORT_USER = 'support';
    process.env.STALWART_SUPPORT_PASS = supportPass;
    process.env.STALWART_NOREPLY_USER = 'noreply';
    process.env.STALWART_NOREPLY_PASS = noreplyPass;
    process.env.MAIL_DOMAIN = domain;

    try {
      execSync('ufw allow 25/tcp 2>/dev/null; ufw allow 587/tcp 2>/dev/null; ufw allow 993/tcp 2>/dev/null', { timeout: 5000, shell: '/bin/bash' });
    } catch {}

    const publicIp = getPublicIp();
    const dnsRecords = [
      { type: 'A', name: 'mail', value: publicIp, description: 'Mail server hostname' },
      { type: 'MX', name: '@', value: `mail.${domain}`, priority: 10, description: 'Incoming mail routing' },
      { type: 'TXT', name: '@', value: `v=spf1 mx a ip4:${publicIp} ~all`, description: 'SPF — authorize this server to send email for your domain' },
      { type: 'TXT', name: 'default._domainkey', value: dkimRecord, description: 'DKIM cryptographic signature' },
      { type: 'TXT', name: '_dmarc', value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, description: 'DMARC policy' },
    ];

    res.json({
      success: true,
      domain,
      dnsRecords,
      message: `Mail server installed for ${domain}! Add the DNS records below to complete setup.`,
      alreadyRunning: stalwartAlreadyRunning,
      recreated,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
