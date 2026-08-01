import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { NativeOllamaBackendBindingState, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin, requireOwner } from '../middleware/requireAdmin';
import { hashPassword } from '../utils/password';
import { AppError } from '../middleware/errorHandler';
import { sendEmail } from '../services/mailService';
import { sendPasswordResetEmail } from '../services/notificationService';
import { provisionUserMailbox, deleteUserMailbox, deleteUserMailboxByUserId, getProvisionedMailboxes } from '../services/userMailService';
import { enqueueMailboxReconciliation, drainMailboxReconciliation } from '../services/mailboxReconciliation';
import {
  ADMIN_USER_DELETION_RETIREMENT_CODE,
  ADMIN_USER_DELETION_RETIREMENT_MESSAGE,
} from '../services/adminUserDeletion.service';
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
  classifyImageUploadFailure,
} from '../services/imageAssets';
import { ACTIVE_STATUS, isOwnerRole } from '../utils/authz';
import { buildPortalUrl } from '../utils/portalUrl';
import { configureDomainAndHttps, getCodingToolsStatus, getPublicIp, installCodingTool, updateEnvFile } from '../utils/serverSetup';
import { isReservedSystemMailboxUsername } from '../utils/reservedMailboxUsernames';
import dns from 'dns/promises';
import fs from 'fs';
import { getUpdateStatus } from '../services/telemetryService';
import { execSync } from 'child_process';
import { recycleStalwartContainerPreservingData } from '../services/stalwartRecovery';
import { ensureBackupLayout, getConfiguredBackupRoot, writeBackupConfiguration } from '../services/backup.service';
import {
  confirmationForMailboxDeletion,
  confirmationForToolInstall,
  isTypedConfirmationMatch,
} from '../utils/privilegedConfirmation';
import {
  getStalwartDkimSigningConfig,
  provisionStalwartDkim,
} from '../services/stalwartDkim';
import {
  ADMIN_SETTINGS_SECRET_KEYS,
  isAdminEditableSettingKey,
  parseAdminSettingsPatch,
} from '../config/systemSettingsRegistry';
import { digestAuthToken, encryptPlaintextSecret } from '../utils/authSecrets';
import { canonicalEmail, canonicalUsername } from '../utils/identity';
import { buildPasswordResetPath } from '../utils/passwordResetLink';
import {
  admitPortalUpdate,
  admitPortalUpdateRelease,
  getPortalUpdatePreparation,
  launchPortalSelfUpdate,
  PortalSelfUpdateLaunchError,
} from '../services/updatePreparation';
import { PROJECT_RUNTIME_AUTHORIZATION_POLICY } from '../services/projectRuntimeAuthorizationPolicy';
import {
  assertNoProjectAuthorizationTransitionActive,
  projectAuthorizationTransitionCoordinator,
  ProjectAuthorizationTransitionError,
  type ProjectAuthorizationUserUpdate,
} from '../services/projectAuthorizationTransition';
import { publishAuthorizationChanged } from '../services/authorizationChangeBus';
import {
  OllamaAuthorityBarrierBusyError,
  withOllamaAuthorityMutationFence,
} from '../services/ollamaAuthorityBarrier';
import {
  configuredPortalOriginMode,
  getPortalFeatureCapabilities,
  portalFeatureUnavailableResponse,
} from '../utils/portalFeatureCapabilities';

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

type RegistrationApprovalNotification = {
  state: 'sent' | 'disabled' | 'failed' | 'manual_required';
  delivered: boolean;
  manualNotificationRequired: boolean;
  reason: string | null;
};

const REGISTRATION_PRIVATE_PASSWORD_REQUIRED_MESSAGE =
  'This registration request does not contain a sign-in password. Deny it and ask the applicant to submit a new request before approving it in private mode.';

class RegistrationPrivatePasswordRequiredError extends Error {
  constructor() {
    super(REGISTRATION_PRIVATE_PASSWORD_REQUIRED_MESSAGE);
    this.name = 'RegistrationPrivatePasswordRequiredError';
  }
}

function sendPrivateRegistrationPasswordRequired(res: Response): void {
  res.status(409).json({
    error: REGISTRATION_PRIVATE_PASSWORD_REQUIRED_MESSAGE,
    code: 'REGISTRATION_PRIVATE_PASSWORD_REQUIRED',
    retryable: false,
    action: 'deny_and_resubmit',
  });
}

async function createUniqueUsername(
  baseName: string,
  email: string,
  db: Pick<Prisma.TransactionClient, 'user'> | Pick<typeof prisma, 'user'> = prisma,
): Promise<string> {
  const fromName = baseName.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  const fromEmail = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  const base = fromName || fromEmail || 'user';

  let candidate = base;
  let suffix = 1;
  while (true) {
    if (!isReservedSystemMailboxUsername(candidate)) {
      const existing = await db.user.findUnique({ where: { username: candidate } });
      if (!existing) return candidate;
    }
    suffix += 1;
    candidate = `${base}${suffix}`.slice(0, 30);
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isTransactionConflictError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
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

function recycleStalwartForRecovery(mailDir: string): void {
  console.warn('[admin/install-mail] Recycling the Stalwart container while preserving stored mail');
  recycleStalwartContainerPreservingData(mailDir);
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
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${Buffer.from(`admin:${adminPass}`).toString('base64')}`,
  };
  try {
    const response = await fetch('http://127.0.0.1:8580/api/principal', {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'individual', name, secrets: [pass], emails: [`${name}@${domain}`], roles: ['user'], description: name === 'noreply' ? 'System Alerts' : name === 'support' ? 'Support' : name, quota: 1024 * 1024 * 1024 }),
      signal: AbortSignal.timeout(10000),
    });
    const raw = await response.text();
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }

    const alreadyExists = response.status === 409
      || (body && typeof body === 'object' && body.error === 'fieldAlreadyExists');
    if (alreadyExists) {
      // Setup must be idempotent: a pre-existing account (from an earlier
      // install or interrupted setup) is converged to the new credentials
      // and address instead of failing the whole mail installation.
      const patch = await fetch(`http://127.0.0.1:8580/api/principal/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify([
          { action: 'set', field: 'secrets', value: [pass] },
          { action: 'set', field: 'emails', value: [`${name}@${domain}`] },
        ]),
        signal: AbortSignal.timeout(10000),
      });
      const patchRaw = await patch.text();
      let patchBody: any = null;
      try { patchBody = patchRaw ? JSON.parse(patchRaw) : null; } catch { patchBody = patchRaw; }
      if (!patch.ok || (patchBody && typeof patchBody === 'object' && patchBody.error)) {
        return { ok: false, error: `existing account update failed: ${patchBody && typeof patchBody === 'object' && patchBody.error ? String(patchBody.error) : `HTTP ${patch.status}`}`, body: patchBody };
      }
      return { ok: true, body: patchBody };
    }

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
      authorizationSafety: PROJECT_RUNTIME_AUTHORIZATION_POLICY,
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
  username: z.string().transform(canonicalUsername).pipe(z.string().min(2).max(100)).optional(),
  firstName: z.string().max(100).optional().nullable(),
  lastName: z.string().max(100).optional().nullable(),
  confirmation: z.string().max(200).optional(),
}).strict();

/**
 * PATCH /api/admin/users/:id
 * Update user (role, sandboxEnabled, etc.)
 */
router.patch('/users/:id', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const parsed = updateUserSchema.parse(req.body);
    const { confirmation, ...data } = parsed;

    if (data.username && isReservedSystemMailboxUsername(data.username)) {
      throw new AppError(400, `Username '${data.username}' is reserved for system use. Choose a different username.`);
    }

    if (id === req.user!.userId && data.role) {
      throw new AppError(400, 'Cannot change your own owner role directly');
    }

    const normalizedData: Record<string, unknown> = { ...data };
    if (data.isActive !== undefined && data.accountStatus === undefined) {
      normalizedData.accountStatus = data.isActive ? 'ACTIVE' : 'DISABLED';
    }
    if (data.accountStatus !== undefined) {
      normalizedData.isActive = data.accountStatus === ACTIVE_STATUS;
    }

    const committed = await projectAuthorizationTransitionCoordinator.updateUserAuthorization({
      initiatedByUserId: req.user!.userId,
      targetUserId: id,
      update: normalizedData as ProjectAuthorizationUserUpdate,
      confirmation,
    });
    const { user, existing } = committed;

    // Provision mailbox if username changed, but keep prior mailboxes accessible
    if (
      normalizedData.username
      && normalizedData.username !== existing.username
      && getPortalFeatureCapabilities().mail.available
    ) {
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
    if (error instanceof ProjectAuthorizationTransitionError) {
      res.status(error.statusCode).json({
        error: error.message,
        code: error.code,
        retryable: error.retryable,
      });
      return;
    }
    next(
      isUniqueConstraintError(error)
        ? new AppError(409, 'Username already in use')
        : isTransactionConflictError(error)
          ? new AppError(409, 'User authorization changed concurrently. Retry the update.')
          : error,
    );
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

    // Portal 4 project state is keyed by both workspace owner and actor. Until
    // identity-aware retirement can remove every UUID-derived local/external
    // artifact, cascading a User is unsafe even when they own no Project.
    // The ProjectIdentity ownership FK is also RESTRICTed as defense in depth.
    res.status(409).json({
      error: ADMIN_USER_DELETION_RETIREMENT_MESSAGE,
      code: ADMIN_USER_DELETION_RETIREMENT_CODE,
      retryable: false,
    });
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
    const transfer = await projectAuthorizationTransitionCoordinator.transferOwnership({
      sourceOwnerUserId: req.user!.userId,
      targetUserId: targetId,
      confirmation: req.body?.confirmation,
    });

    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'OWNER_TRANSFERRED',
        resource: 'admin',
        resourceId: targetId,
        severity: 'WARNING',
        translatedMessage: `Ownership transferred to ${transfer.targetEmail}`,
        metadata: { fromUserId: req.user!.userId, toUserId: targetId, toEmail: transfer.targetEmail },
      },
    }).catch(() => {});

    res.json({ success: true });
  } catch (error) {
    if (error instanceof ProjectAuthorizationTransitionError) {
      res.status(error.statusCode).json({
        error: error.message,
        code: error.code,
        retryable: error.retryable,
      });
      return;
    }
    next(
      isTransactionConflictError(error)
        ? new AppError(409, 'Portal ownership changed concurrently. Reload and retry.')
        : error,
    );
  }
});


router.get('/update-status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [status, preparation] = await Promise.all([
      getUpdateStatus(),
      getPortalUpdatePreparation(),
    ]);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ...status, preparation });
  } catch (error) {
    next(error);
  }
});

router.post('/check-updates', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { checkForUpdatesWithCooldown } = await import('../services/telemetryService');
    const force = req.body?.force === true;
    const [status, preparation] = await Promise.all([
      checkForUpdatesWithCooldown(force),
      getPortalUpdatePreparation(),
    ]);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ...status, preparation });
  } catch (error) {
    next(error);
  }
});

router.post('/self-update', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const request = req.body || {};
    let preparation = await getPortalUpdatePreparation();
    let admission = admitPortalUpdate(preparation, request);
    if (!admission.ok) {
      res.status(admission.status).json({
        error: admission.error,
        code: admission.code,
        preparation,
      });
      return;
    }

    const updateStatus = await getUpdateStatus();
    const releaseAdmission = admitPortalUpdateRelease(updateStatus, request);
    if (!releaseAdmission.ok) {
      res.status(releaseAdmission.status).json({
        error: releaseAdmission.error,
        code: releaseAdmission.code,
        preparation,
      });
      return;
    }

    if (admission.backupDecision === 'use-current') {
      // Metadata age alone is not recovery proof. Re-run the same bounded
      // recovery-contract verifier used by host maintenance immediately before
      // admitting the update, then re-read active backup state after it ends.
      preparation = await getPortalUpdatePreparation(Date.now(), { verifyFreshArchive: true });
      admission = admitPortalUpdate(preparation, request);
      if (!admission.ok) {
        res.status(admission.status).json({
          error: admission.error,
          code: admission.code,
          preparation,
        });
        return;
      }
    }

    // Domain-origin installs relaunch the updater with their attested domain.
    // Tailnet/local origins launch plain --update: the installer reloads the
    // attested installed-origin state and must never be forced into domain
    // mode by the Dashboard.
    const originMode = configuredPortalOriginMode(process.env);
    let domain = '';
    if (originMode === 'domain') {
      domain = await resolveSelfUpdateDomain();
      if (!domain) throw new AppError(400, 'No domain configured for self-update.');

      // SECURITY: Validate domain format to prevent shell injection (CRIT-1 from audit)
      const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)+$/;
      if (!domainRegex.test(domain)) {
        throw new AppError(400, 'Invalid domain format — cannot run self-update.');
      }
    }

    const logsDir = '/opt/bridgesllm/logs';
    fs.mkdirSync(logsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logsDir, `self-update-${timestamp}.log`);
    fs.appendFileSync(logFile, [
      `[${new Date().toISOString()}] Starting self-update (${originMode} origin)${domain ? ` for ${domain}` : ''} at reviewed release ${releaseAdmission.expectedVersion}`,
      `[${new Date().toISOString()}] Backup decision: ${admission.backupDecision}; readiness: ${preparation.backup.state}`,
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o600, flag: 'a' });

    // The updater stops this service, so register it as a fixed-name transient
    // service in a separate cgroup. The fixed unit name is also the durable
    // host-side single-flight gate for concurrent tabs and request retries.
    await launchPortalSelfUpdate({
      originMode,
      domain,
      logFile,
      expectedVersion: releaseAdmission.expectedVersion,
    });

    res.json({ ok: true, logFile });
  } catch (error) {
    if (error instanceof PortalSelfUpdateLaunchError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
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
    const approvedAt = new Date();
    const mailCapability = getPortalFeatureCapabilities().mail;

    if (!mailCapability.available) {
      const privateModeRequest = await prisma.registrationRequest.findUnique({
        where: { id },
        select: { passwordHash: true },
      });
      if (!privateModeRequest) {
        throw new AppError(404, 'Registration request not found');
      }
      if (!privateModeRequest.passwordHash) {
        sendPrivateRegistrationPasswordRequired(res);
        return;
      }
    }

    const sandboxEnabled = await getSandboxDefaultEnabled();
    const fallbackPasswordHash = await hashPassword(crypto.randomUUID());
    // Resolve settings before the irreversible approval transaction. A
    // post-commit settings failure must never look like an approval failure
    // that the owner should retry.
    const approvalNotificationEnabled = mailCapability.available
      ? await isNotificationEnabled('notifications.userApproved')
      : false;

    const approved = await prisma.$transaction(async (tx) => {
      await assertNoProjectAuthorizationTransitionActive(tx);
      const request = await tx.registrationRequest.findUnique({ where: { id } });
      if (!request) throw new AppError(404, 'Registration request not found');
      // Re-attest the private-mode credential invariant inside the approval
      // transaction so a raced or externally changed request can never fall
      // through to an unknown random password.
      if (!mailCapability.available && !request.passwordHash) {
        throw new RegistrationPrivatePasswordRequiredError();
      }

      const claimed = await tx.registrationRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: 'APPROVED',
          reviewedAt: approvedAt,
          reviewedBy: req.user!.userId,
        },
      });
      if (claimed.count !== 1) {
        throw new AppError(409, 'Registration request was already reviewed');
      }

      const email = canonicalEmail(request.email);
      const existingUser = await tx.user.findUnique({ where: { email } });
      if (existingUser) {
        if ((existingUser as any).accountStatus !== 'PENDING') {
          throw new AppError(409, 'A non-pending user with this email already exists');
        }
        const updatedUser = await tx.user.update({
          where: { id: existingUser.id },
          data: {
            role: 'USER',
            accountStatus: 'ACTIVE',
            isActive: true,
            approvedAt,
            approvedBy: req.user!.userId,
            sandboxEnabled,
            authorizationVersion: { increment: 1 },
          },
        } as any);
        // A supported PENDING transition preserves dormant authentication
        // artifacts. Reactivation must not make an old refresh session,
        // challenge, verification code, or reset link authoritative again.
        await tx.session.deleteMany({ where: { userId: updatedUser.id } });
        await tx.twoFactorChallenge.deleteMany({ where: { userId: updatedUser.id } });
        await tx.emailVerificationCode.deleteMany({ where: { userId: updatedUser.id } });
        await tx.passwordResetToken.updateMany({
          where: { userId: updatedUser.id, usedAt: null },
          data: { usedAt: approvedAt },
        });
        return {
          request,
          userId: updatedUser.id,
          username: updatedUser.username,
          email,
          reactivatedAuthorizationVersion: Number(updatedUser.authorizationVersion),
        };
      }

      const username = await createUniqueUsername(request.name, email, tx);
      const createdUser = await tx.user.create({
        data: {
          email,
          username,
          passwordHash: request.passwordHash || fallbackPasswordHash,
          role: 'USER',
          accountStatus: 'ACTIVE',
          isActive: true,
          approvedAt,
          approvedBy: req.user!.userId,
          sandboxEnabled,
        },
      } as any);
      return {
        request,
        userId: createdUser.id,
        username: createdUser.username,
        email,
        reactivatedAuthorizationVersion: null,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    const {
      request,
      userId: approvedUserId,
      username: approvedUsername,
      reactivatedAuthorizationVersion,
    } = approved;

    if (reactivatedAuthorizationVersion !== null) {
      publishAuthorizationChanged({
        type: 'authorization_changed',
        userId: approvedUserId,
        authorizationVersion: reactivatedAuthorizationVersion,
        reasons: ['account_status', 'active_status'],
      });
    }

    if (mailCapability.available) {
      try {
        await provisionUserMailbox(approvedUsername, approvedUserId, { makePrimary: true });
      } catch (err) {
        console.error('[admin] Failed to auto-provision mailbox on registration approval:', err);
      }
    }

    let notification: RegistrationApprovalNotification = mailCapability.available
      ? {
          state: 'disabled',
          delivered: false,
          manualNotificationRequired: false,
          reason: null,
        }
      : {
          state: 'manual_required',
          delivered: false,
          manualNotificationRequired: true,
          reason: mailCapability.reason,
        };

    // A private-origin Portal cannot deliver approval mail. Do not create a
    // bearer reset token that nobody can receive; report the manual handoff
    // requirement explicitly so the frontend can guide the owner.
    if (mailCapability.available && approvalNotificationEnabled) {
      let resetToken: { id: string } | null = null;
      try {
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = digestAuthToken('password-reset', rawToken);
        resetToken = await prisma.$transaction(async (tx) => {
          await assertNoProjectAuthorizationTransitionActive(tx);
          return tx.passwordResetToken.create({
            data: {
              userId: approvedUserId,
              token: tokenHash,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        const resetUrl = buildPortalUrl(buildPasswordResetPath(rawToken), req);
        await sendPasswordResetEmail({ email: request.email }, resetUrl);

        // Preserve any previously issued link until delivery of the replacement
        // has succeeded. After that, converge to exactly the delivered token.
        await prisma.passwordResetToken.deleteMany({
          where: {
            userId: approvedUserId,
            usedAt: null,
            id: { not: resetToken.id },
          },
        }).catch((err) => {
          console.error('[admin] Failed to retire older approval reset tokens:', err);
        });

        notification = {
          state: 'sent',
          delivered: true,
          manualNotificationRequired: false,
          reason: null,
        };
      } catch (err) {
        if (resetToken) {
          let cleanupVerified = true;
          try {
            // Delivery failed: remove only the newly undelivered bearer. Older
            // reset links remain intact because they were not retired yet.
            await prisma.passwordResetToken.delete({ where: { id: resetToken.id } });
          } catch (cleanupError) {
            cleanupVerified = false;
            console.error('[admin] Failed to remove undelivered approval reset token:', cleanupError);
          }
          notification = {
            state: 'failed',
            delivered: false,
            manualNotificationRequired: true,
            reason: cleanupVerified
              ? 'The approval email could not be delivered. Notify the user directly.'
              : 'The approval email could not be delivered, and reset-link cleanup could not be verified. Notify the user directly and review server logs.',
          };
        } else {
          notification = {
            state: 'failed',
            delivered: false,
            manualNotificationRequired: true,
            reason: 'The approval email could not be prepared. Notify the user directly.',
          };
        }
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
        metadata: {
          requestId: id,
          email: request.email,
          approvedUserId,
          approvedUsername,
          notificationState: notification.state,
          manualNotificationRequired: notification.manualNotificationRequired,
        },
      },
    }).catch(() => {});

    res.json({ success: true, notification });
  } catch (error) {
    if (error instanceof RegistrationPrivatePasswordRequiredError) {
      sendPrivateRegistrationPasswordRequired(res);
      return;
    }
    next(isUniqueConstraintError(error) || isTransactionConflictError(error)
      ? new AppError(409, 'Registration approval conflicted with another identity or review operation')
      : error);
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

    const denied = await prisma.registrationRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'DENIED',
        reviewedAt: new Date(),
        reviewedBy: req.user!.userId,
      },
    });
    if (denied.count !== 1) throw new AppError(409, 'Registration request was already reviewed');

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
      if (isAdminEditableSettingKey(s.key) && !ADMIN_SETTINGS_SECRET_KEYS.has(s.key)) {
        result[s.key] = s.value;
      }
      if (s.key === 'registrationMode' && !result['security.registrationMode']) {
        result['security.registrationMode'] = s.value;
      }
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

const searchVisibilitySchema = z.object({
  visibility: z.enum(['visible', 'hidden']),
});

/**
 * PUT /api/admin/settings
 * Bulk upsert SystemSettings
 */
router.put('/settings', requireOwner, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const normalizedData = parseAdminSettingsPatch(req.body);
    let preparedBackupRoot: string | null = null;
    let previousBackupRoot: string | null = null;

    if (Object.prototype.hasOwnProperty.call(normalizedData, 'system.backupPath')) {
      try {
        previousBackupRoot = await getConfiguredBackupRoot({ syncFile: true });
        preparedBackupRoot = ensureBackupLayout(normalizedData['system.backupPath']);
      } catch (error: any) {
        throw new AppError(400, error?.message || 'Backup path is invalid');
      }
      normalizedData['system.backupPath'] = preparedBackupRoot;
    }

    if (Object.prototype.hasOwnProperty.call(normalizedData, 'smtp.password')) {
      normalizedData['smtp.password'] = encryptPlaintextSecret(normalizedData['smtp.password']);
    }

    const commitSettingsPatch = async () => {
      // Keep the database patch atomic. The backup runner reads its storage
      // root from a root-owned file, so update that file inside the transaction
      // and compensate it if the transaction or commit fails.
      try {
        await prisma.$transaction(async (transaction) => {
          for (const [key, value] of Object.entries(normalizedData)) {
            await transaction.systemSetting.upsert({
              where: { key },
              update: { value },
              create: { key, value },
            });
          }
          if (preparedBackupRoot) writeBackupConfiguration(preparedBackupRoot);
        });
      } catch (error) {
        if (preparedBackupRoot && previousBackupRoot) {
          try {
            writeBackupConfiguration(previousBackupRoot);
          } catch (rollbackError) {
            console.error('Failed to restore the prior backup path after a settings transaction failure:', rollbackError);
          }
        }
        throw error;
      }
    };
    if (Object.prototype.hasOwnProperty.call(normalizedData, 'ollama.localEnabled')) {
      let nativeAuthorityOwnsLocalPolicyFence = false;
      await withOllamaAuthorityMutationFence(async () => {
        const nativeAuthority = await prisma.nativeOllamaBackendBinding.findFirst({
          where: {
            purposeId: 'PRIMARY',
            state: {
              in: [
                NativeOllamaBackendBindingState.ACTIVE,
                NativeOllamaBackendBindingState.DISCONNECTED,
              ],
            },
          },
          select: { id: true },
        });
        if (nativeAuthority) {
          nativeAuthorityOwnsLocalPolicyFence = true;
          return;
        }
        await commitSettingsPatch();
      });
      if (nativeAuthorityOwnsLocalPolicyFence) {
        res.status(409).json({
          code: 'NATIVE_OLLAMA_LOCAL_POLICY_LOCKED',
          error:
            'Local Ollama policy cannot change while a native Remote GPU authority exists. Remove the Remote GPU first.',
        });
        return;
      }
    } else {
      await commitSettingsPatch();
    }

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
      if (isAdminEditableSettingKey(s.key) && !ADMIN_SETTINGS_SECRET_KEYS.has(s.key)) {
        result[s.key] = s.value;
      }
      if (s.key === 'registrationMode' && !result['security.registrationMode']) {
        result['security.registrationMode'] = s.value;
      }
    }
    res.json(result);
  } catch (error) {
    if (error instanceof OllamaAuthorityBarrierBusyError) {
      res.status(error.statusCode).json({
        code: error.code,
        error: error.message,
      });
      return;
    }
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
    const unavailable = portalFeatureUnavailableResponse('mail');
    if (unavailable) {
      res.status(409).json(unavailable);
      return;
    }
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
const AGENT_PROVIDERS = ['OPENCLAW', 'CLAUDE_CODE', 'CODEX', 'GROK', 'AGENT_ZERO', 'GEMINI', 'OLLAMA'] as const;

function sendImageUploadFailure(res: Response, error: unknown): boolean {
  const failure = classifyImageUploadFailure(error);
  if (!failure) return false;
  res.status(failure.statusCode).json(failure);
  return true;
}

router.post('/appearance/logo', requireOwner, uploadImage, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const cropParams = parseCropParams(req.body);
    const basename = `portal-logo-${Date.now()}`;
    const { ext } = await processImageToTarget(req.file.path, req.file.mimetype, path.join(BRANDING_DIR, basename), cropParams, { staticSize: 512, gifSize: 256 });
    cleanupBasenamePrefixVariants(BRANDING_DIR, 'portal-logo', `${basename}${ext}`);

    const logoUrl = `/static-assets/branding/${basename}${ext}`;
    await prisma.systemSetting.upsert({
      where: { key: 'appearance.logoUrl' },
      update: { value: logoUrl },
      create: { key: 'appearance.logoUrl', value: logoUrl },
    });

    return res.json({ success: true, logoUrl });
  } catch (error) {
    if (sendImageUploadFailure(res, error)) return;
    return next(error);
  } finally {
    cleanupFile(req.file?.path);
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

    const avatarUrl = `/static-assets/avatars/${basename}${ext}`;
    const key = `appearance.agentAvatar.${provider}`;
    await prisma.systemSetting.upsert({
      where: { key },
      update: { value: avatarUrl },
      create: { key, value: avatarUrl },
    });

    return res.json({ success: true, avatarUrl, provider });
  } catch (error) {
    if (sendImageUploadFailure(res, error)) return;
    return next(error);
  } finally {
    cleanupFile(req.file?.path);
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

    const avatarUrl = `/static-assets/avatars/${basename}${ext}`;
    const key = `appearance.subAgentAvatar.${agentId}`;
    await prisma.systemSetting.upsert({
      where: { key },
      update: { value: avatarUrl },
      create: { key, value: avatarUrl },
    });

    return res.json({ success: true, avatarUrl, agentId });
  } catch (error) {
    if (sendImageUploadFailure(res, error)) return;
    return next(error);
  } finally {
    cleanupFile(req.file?.path);
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
    const unavailable = portalFeatureUnavailableResponse('mail');
    if (unavailable) {
      res.status(409).json(unavailable);
      return;
    }
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
    const unavailable = portalFeatureUnavailableResponse('mail');
    if (unavailable) {
      res.status(409).json(unavailable);
      return;
    }
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
    const unavailable = portalFeatureUnavailableResponse('mail');
    if (unavailable) {
      res.status(409).json(unavailable);
      return;
    }
    const { username } = req.params;
    if (!username) throw new AppError(400, 'Username required');

    const confirmationPhrase = confirmationForMailboxDeletion(username);
    if (!isTypedConfirmationMatch(confirmationPhrase, req.body?.confirmation)) {
      throw new AppError(400, `Type ${confirmationPhrase} to permanently remove this mailbox.`);
    }

    const mailbox = await prisma.mailboxAccount.findUnique({
      where: { username },
      select: { userId: true },
    });
    if (mailbox) await deleteUserMailboxByUserId(username, mailbox.userId);
    else await deleteUserMailbox(username);

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
    const { toolId, confirmation } = z.object({
      toolId: z.string().min(1),
      confirmation: z.string().max(200).optional(),
    }).parse(req.body);
    const confirmationPhrase = confirmationForToolInstall(toolId);
    if (!isTypedConfirmationMatch(confirmationPhrase, confirmation)) {
      throw new AppError(400, `Type ${confirmationPhrase} to install this host-level coding tool.`);
    }
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
    const unavailable = portalFeatureUnavailableResponse('mail');
    if (unavailable) {
      return res.status(409).json(unavailable);
    }
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
      // Pin Stalwart: v0.16 removed the legacy admin API endpoints this installer uses
      // for domain/account provisioning. Do not use `latest` here.
      const composeContent = `version: '3.8'
services:
  stalwart:
    image: stalwartlabs/stalwart:v0.15.5
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

${getStalwartDkimSigningConfig()}

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
        recycleStalwartForRecovery(mailDir);
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
        console.warn('[admin/install-mail] Domain creation failed; retrying with a data-preserving container recycle:', domainResult.error);
        recycleStalwartForRecovery(mailDir);
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
      console.warn('[admin/install-mail] Account creation failed; retrying with a data-preserving container recycle', supportResult, noreplyResult);
      recycleStalwartForRecovery(mailDir);
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

    const dkimRecords = await provisionStalwartDkim({
      domain,
      adminPass,
      mailDir,
      baseUrl: 'http://127.0.0.1:8580',
    });

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

    let reprovisionedMailboxes = 0;
    const reprovisionErrors: Array<{ username: string; error: string }> = [];
    try {
      const users = await prisma.user.findMany({
        where: { isActive: true, username: { not: '' } },
        select: { id: true, username: true },
      });
      for (const user of users) {
        try {
          const existing = await prisma.mailboxAccount.findFirst({
            where: { userId: user.id },
            select: { username: true },
          });
          if (existing) {
            // The mailbox record already exists; a fresh provision would hit
            // the username lock. Re-enqueue reconciliation instead — this
            // also resets tasks that BLOCKED while mail was unconfigured,
            // now that valid admin credentials exist.
            await enqueueMailboxReconciliation(existing.username);
          } else {
            await provisionUserMailbox(user.username, user.id, { makePrimary: true });
          }
          reprovisionedMailboxes += 1;
        } catch (err: any) {
          reprovisionErrors.push({ username: user.username, error: err?.message || String(err) });
        }
      }
      if (reprovisionErrors.length > 0) {
        console.warn('[admin/install-mail] Existing mailbox reprovisioning had non-fatal failures:', reprovisionErrors);
      }
      // Converge re-enqueued mailboxes immediately rather than waiting for
      // the next periodic drain.
      await drainMailboxReconciliation({ maxTasks: 50, timeBudgetMs: 30_000 });
    } catch (err: any) {
      console.warn('[admin/install-mail] Existing mailbox reprovisioning skipped:', err?.message || err);
    }

    try {
      execSync('ufw allow 25/tcp 2>/dev/null; ufw allow 587/tcp 2>/dev/null; ufw allow 993/tcp 2>/dev/null', { timeout: 5000, shell: '/bin/bash' });
    } catch {}

    const publicIp = getPublicIp();
    const dnsRecords = [
      { type: 'A', name: 'mail', value: publicIp, description: 'Mail server hostname' },
      { type: 'MX', name: '@', value: `mail.${domain}`, priority: 10, description: 'Incoming mail routing' },
      { type: 'TXT', name: '@', value: `v=spf1 mx a ip4:${publicIp} ~all`, description: 'SPF — authorize this server to send email for your domain' },
      ...dkimRecords.map(record => ({
        type: 'TXT',
        name: record.name,
        value: record.value,
        description: `${record.algorithm.toUpperCase()} DKIM cryptographic signature`,
      })),
      { type: 'TXT', name: '_dmarc', value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, description: 'DMARC policy' },
    ];

    res.json({
      success: true,
      domain,
      dnsRecords,
      message: `Mail server installed for ${domain}! Add the DNS records below to complete setup.`,
      alreadyRunning: stalwartAlreadyRunning,
      recreated,
      reprovisionedMailboxes,
      reprovisionErrors: reprovisionErrors.slice(0, 5),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
