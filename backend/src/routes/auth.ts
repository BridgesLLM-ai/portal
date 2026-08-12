import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import rateLimit from 'express-rate-limit';
import { prisma } from '../config/database';
import { hashPassword, comparePassword, validatePasswordStrength } from '../utils/password';
import { normalizeRegistrationMode } from '../utils/registrationMode';
import { buildPasswordResetPath } from '../utils/passwordResetLink';
import { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken } from '../utils/jwt';
import { authenticateToken, AUTH_SESSION_REVOKED_CODE } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { ACTIVE_STATUS, canAccessPortal, describeBlockedAccountStatus } from '../utils/authz';
import { sendNewUserAlert } from '../services/email';
import {
  sendWelcomeEmail,
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
  sendLoginAlertEmail,
  sendTwoFactorEnabledEmail,
  sendTwoFactorDisabledEmail,
  sendTwoFactorCodeEmail,
} from '../services/notificationService';
import { provisionUserMailbox } from '../services/userMailService';
import {
  extractTrackingMetadata,
  formatLoginMessage,
  formatHoneypotMessage,
  recordFailedAttempt,
  clearFailedAttempts,
  isRateLimited,
  blockedIPs,
} from '../utils/auth-tracking';
import { buildPortalUrl } from '../utils/portalUrl';
import { clearAuthCookies, setAuthCookies } from '../utils/authCookies';
import { isReservedSystemMailboxUsername } from '../utils/reservedMailboxUsernames';
import { generateSecret as otpGenerateSecret, generateURI as otpGenerateURI, verify as otpVerify, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib';
import * as QRCode from 'qrcode';
import { decryptSecret, digestAuthToken, encryptSecret } from '../utils/authSecrets';
import { canonicalEmail, canonicalUsername } from '../utils/identity';
import {
  assertPortalFeatureAvailable,
  getPortalFeatureCapabilities,
  PortalFeatureUnavailableError,
  portalFeatureUnavailableResponse,
  privateRecoveryOriginIsAllowed,
} from '../utils/portalFeatureCapabilities';
import {
  assertNoProjectAuthorizationTransitionActive,
  projectAuthorizationTransitionCoordinator,
} from '../services/projectAuthorizationTransition';
import { effectiveRequestOrigin } from '../utils/appContentSecurity';
import { publishAuthorizationChanged } from '../services/authorizationChangeBus';
import {
  publishAllSessionsRevoked,
  publishSessionRevoked,
} from '../services/sessionRevocationBus';

// Shared plugins for TOTP operations (otplib v13 functional API)
const otpCrypto = new NobleCryptoPlugin();
const otpBase32 = new ScureBase32Plugin();

const router = Router();

// Aggressive rate limiting for auth endpoints (5 attempts per 15 minutes per IP)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // 15 requests per window
  message: 'Too many authentication attempts from this IP, please try again after 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limiting in development to avoid friction during testing
  skip: (_req) => process.env.NODE_ENV === 'development',
});

// Stricter rate limiting for forgot-password (3 attempts per 15 minutes per IP)
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: 'Too many password reset requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (_req) => process.env.NODE_ENV === 'development',
});

// Stricter rate limiting for 2FA validate (5 attempts per 15 min per IP)
const twoFactorValidateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many two-factor authentication attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (_req) => process.env.NODE_ENV === 'development',
});

// Rate limiting for 2FA email send (3 per 15 min per IP)
const twoFactorEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: 'Too many verification code requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (_req) => process.env.NODE_ENV === 'development',
});

// A separate limiter protects authenticated backup-code attempts. Keeping it
// distinct from email delivery means a mail outage cannot consume the resend
// budget while an owner is trying to migrate away from legacy Email Code 2FA.
const twoFactorDisableLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many two-factor disable attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (_req) => process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
});

// Emergency recovery is deliberately narrower and more aggressively bounded
// than ordinary 2FA validation. The IP budget prevents random-token database
// floods; the challenge budget follows a stolen bearer across distributed IPs.
// Recovery never creates a session.
const twoFactorEmailRecoveryIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many Email Code recovery attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (_req) => process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
});

const twoFactorEmailRecoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: 'Too many Email Code recovery attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const pendingToken = typeof req.body?.pendingToken === 'string'
      ? req.body.pendingToken
      : '';
    return /^[A-Za-z0-9_-]{43}$/.test(pendingToken)
      ? `challenge:${digestAuthToken('2fa-recovery-rate-limit', pendingToken)}`
      : `ip:${req.ip || 'unknown'}`;
  },
  skip: (_req) => process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
});

const EMAIL_2FA_RECOVERY_CONFIRMATION = 'DISABLE EMAIL 2FA';
const AUTHORIZATION_ARTIFACT_CONFLICT_CODE = 'AUTHORIZATION_ARTIFACT_ADMISSION_CONFLICT';

function respondWithUnavailableMail(res: Response): boolean {
  const unavailable = portalFeatureUnavailableResponse('mail');
  if (!unavailable) return false;
  res.status(409).json(unavailable);
  return true;
}

function rejectUnavailableMailRequest(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!respondWithUnavailableMail(res)) next();
}

function rejectUnavailableEmailMethodRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.body?.method === 'email' && respondWithUnavailableMail(res)) return;
  next();
}

function parseBackupCodeHashes(serialized: string | null): string[] | null {
  if (serialized === null) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function hasStoredBackupCodes(serialized: string | null): boolean {
  const parsed = parseBackupCodeHashes(serialized);
  // Malformed legacy state fails closed: recovery must not become a bypass
  // merely because the stored backup-code record cannot be interpreted.
  return parsed === null || parsed.length > 0;
}

async function matchesBackupCode(token: string, serialized: string | null): Promise<boolean> {
  if (!/^[A-Za-z0-9]{8}$/.test(token)) return false;
  const hashes = parseBackupCodeHashes(serialized);
  if (!hashes?.length) return false;
  for (const hash of hashes) {
    if (await comparePassword(token, hash)) return true;
  }
  return false;
}

function privateRecoveryRequestMatchesConfiguredOrigin(req: Request): boolean {
  return privateRecoveryOriginIsAllowed(effectiveRequestOrigin(req));
}

async function mapAuthorizationArtifactAdmissionConflicts<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      !isAuthorizationTransitionActiveError(error)
      && !isSerializableTransactionConflict(error)
    ) {
      throw error;
    }
    const code = isAuthorizationTransitionActiveError(error)
      ? 'PROJECT_AUTHORIZATION_TRANSITION_ACTIVE'
      : AUTHORIZATION_ARTIFACT_CONFLICT_CODE;
    throw Object.assign(
      new AppError(409, 'Authentication is temporarily paused while account access is being updated. Please try again.'),
      { code },
    );
  }
}

async function withAuthorizationArtifactAdmission<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return mapAuthorizationArtifactAdmissionConflicts(() => (
    prisma.$transaction(async (tx) => {
      await assertNoProjectAuthorizationTransitionActive(tx);
      return operation(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  ));
}

async function revokeAllSessionsForLegacyLogout(userId: string): Promise<number> {
  return withAuthorizationArtifactAdmission(async (tx) => {
    // Keep the durable-access lock order User -> Session. Final filesystem
    // mutations re-attest under the same order, so legacy logout cannot form a
    // row-lock cycle while waiting for an in-flight mutation to settle.
    const updated = await tx.user.update({
      where: { id: userId },
      data: { authorizationVersion: { increment: 1 } },
      select: { authorizationVersion: true },
    });
    await tx.session.deleteMany({ where: { userId } });
    return Number(updated.authorizationVersion ?? 1);
  });
}

function isAuthorizationTransitionActiveError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'PROJECT_AUTHORIZATION_TRANSITION_ACTIVE';
}

function isSerializableTransactionConflict(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'P2034';
}

function isAuthorizationArtifactAdmissionConflict(error: unknown): boolean {
  return isAuthorizationTransitionActiveError(error)
    || (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === AUTHORIZATION_ARTIFACT_CONFLICT_CODE
    );
}

function respondAuthorizationArtifactAdmissionConflict(
  res: Response,
  error: unknown,
): boolean {
  if (!isAuthorizationArtifactAdmissionConflict(error)) return false;
  const conflict = error as AppError & { code: string };
  res.status(409).json({
    error: conflict.message,
    code: conflict.code,
    retryable: true,
  });
  return true;
}

function authorizationUserSnapshotCas(user: any): Prisma.UserWhereInput {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    role: user.role,
    accountStatus: user.accountStatus,
    isActive: user.isActive,
    sandboxEnabled: user.sandboxEnabled,
    authorizationVersion: Number(user.authorizationVersion ?? 1),
  };
}

function authorizationCredentialSnapshotCas(user: any): Prisma.UserWhereInput {
  return {
    ...authorizationUserSnapshotCas(user),
    passwordHash: user.passwordHash,
    twoFactorEnabled: user.twoFactorEnabled,
    twoFactorMethod: user.twoFactorMethod,
    twoFactorSecret: user.twoFactorSecret,
    twoFactorBackupCodes: user.twoFactorBackupCodes,
    twoFactorLastUsedStep: user.twoFactorLastUsedStep,
  };
}

async function assertAuthorizationCredentialSnapshotCurrent(
  tx: Prisma.TransactionClient,
  user: any,
  expectedAuthorizationVersion = Number(user.authorizationVersion ?? 1),
): Promise<void> {
  const current = await tx.user.findFirst({
    where: {
      ...authorizationCredentialSnapshotCas(user),
      authorizationVersion: expectedAuthorizationVersion,
    },
    select: { id: true },
  });
  if (!current) {
    throw new AppError(409, 'Account or credential state changed. Authenticate again.');
  }
}

/**
 * Generate a 6-digit email verification code, store hashed, send to user.
 * Cleans up old codes for the user first.
 */
async function generateAndSendEmailCode(
  user: any,
  purpose: string,
  expectedAuthorizationVersion = Number(user.authorizationVersion ?? 1),
): Promise<void> {
  assertPortalFeatureAvailable('mail');

  // Generate 6-digit code
  const code = crypto.randomInt(100000, 999999).toString();

  // Hash with bcrypt and store
  const codeHash = await hashPassword(code);
  const verification = await withAuthorizationArtifactAdmission(async (tx) => {
    await assertAuthorizationCredentialSnapshotCurrent(
      tx,
      user,
      expectedAuthorizationVersion,
    );
    // Retire stale proofs only after the same admitted snapshot that creates
    // the replacement has been re-attested.
    await tx.emailVerificationCode.deleteMany({
      where: {
        userId: user.id,
        purpose,
        OR: [
          { createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
          { usedAt: { not: null } },
        ],
      },
    });
    return tx.emailVerificationCode.create({
      data: {
        userId: user.id,
        code: codeHash,
        purpose,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      },
    });
  });

  try {
    await sendTwoFactorCodeEmail({ email: user.email }, code);
  } catch (error) {
    // Remove exactly the proof whose delivery failed. Do not consume or delete
    // a previously delivered code that the user may still be entering.
    await prisma.emailVerificationCode.deleteMany({ where: { id: verification.id } });
    throw error;
  }

  // The successfully delivered code supersedes only older codes for the same
  // purpose. Never delete a concurrently-created newer code: doing so could
  // leave both senders deleting each other's rows and no usable proof.
  await prisma.emailVerificationCode.deleteMany({
    where: {
      userId: user.id,
      purpose,
      OR: [
        { createdAt: { lt: verification.createdAt } },
        { createdAt: verification.createdAt, id: { lt: verification.id } },
      ],
    },
  });
}

// TOTP window: ±1 step (30 second tolerance) — passed to each verify call

/**
 * Generate a short-lived, database-backed 2FA challenge. Its keyed digest is
 * indexed and the raw token is returned only to the browser.
 */
async function generate2FAPendingToken(user: any): Promise<{ id: string; token: string }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = digestAuthToken('2fa-challenge', token);
  const challenge = await withAuthorizationArtifactAdmission(async (tx) => {
    await assertAuthorizationCredentialSnapshotCurrent(tx, user);
    return tx.twoFactorChallenge.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
      select: { id: true },
    });
  });
  void prisma.twoFactorChallenge.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  }).catch(() => {});
  return { id: challenge.id, token };
}

async function verify2FAPendingToken(token: string) {
  return prisma.twoFactorChallenge.findUnique({
    where: { tokenHash: digestAuthToken('2fa-challenge', token) },
    include: { user: true },
  }).then((challenge) => (
    challenge && !challenge.consumedAt && challenge.expiresAt > new Date()
      ? challenge
      : null
  ));
}

async function findVerifiedEmailCode(userId: string, purpose: string, token: string) {
  const code = await prisma.emailVerificationCode.findFirst({
    where: {
      userId,
      purpose,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (!code || !await comparePassword(token, code.code)) return null;
  return code;
}

async function verifyTotpStep(user: {
  twoFactorSecret: string | null;
  twoFactorLastUsedStep: number | null;
}, token: string): Promise<number | null> {
  if (!user.twoFactorSecret) return null;
  const result = await otpVerify({
    token,
    secret: decryptSecret(user.twoFactorSecret),
    crypto: otpCrypto,
    base32: otpBase32,
    epochTolerance: 30,
    afterTimeStep: user.twoFactorLastUsedStep ?? undefined,
  });
  return result.valid && 'timeStep' in result ? result.timeStep : null;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Generate random backup codes (8 codes, 8 chars alphanumeric each)
 */
function generateBackupCodes(count = 8, length = 8): string[] {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let code = '';
    const bytes = crypto.randomBytes(length);
    for (let j = 0; j < length; j++) {
      code += chars[bytes[j] % chars.length];
    }
    codes.push(code);
  }
  return codes;
}

function normalizeEmail(email: string): string {
  return canonicalEmail(email);
}

// Validation schemas
const signupSchema = z.object({
  email: z.string().transform(normalizeEmail).pipe(z.string().email('Invalid email')),
  username: z.string().transform(canonicalUsername).pipe(
    z.string().min(3, 'Username must be at least 3 characters').max(50),
  ),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const loginSchema = z.object({
  email: z.string().transform(normalizeEmail).pipe(z.string().email('Invalid email')),
  password: z.string(),
});

const refreshSchema = z.object({
  refreshToken: z.string().optional(),
});

async function applyAuthCookies(req: Request, res: Response, accessToken: string, refreshToken: string) {
  const maxAge = (await getSessionDurationHours()) * 60 * 60 * 1000;
  setAuthCookies(req, res, accessToken, refreshToken, maxAge);
}

function respondRefreshRotationConflict(res: Response): void {
  // A winning rotation may still be committing or its response may still be
  // installing cookies in another browser tab. Give that winner enough time
  // to publish its browser-wide generation before a loser retries.
  res.setHeader('Retry-After', '5');
  res.status(409).json({
    error: 'Another request refreshed this session first. Retry with the current cookies.',
    code: 'AUTH_REFRESH_ROTATION_CONFLICT',
    retryable: true,
  });
}

function respondRefreshSessionGone(
  req: Request,
  res: Response,
  presentedRefreshToken: string,
): void {
  // A body-carried stale token may be tested while the browser holds an
  // unrelated current cookie. Only delete the browser jar when this failed
  // credential is the cookie the browser actually presented.
  if (
    typeof req.cookies?.refreshToken === 'string'
    && req.cookies.refreshToken === presentedRefreshToken
  ) {
    clearAuthCookies(req, res);
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(401).json({
    error: 'This sign-in session is no longer active. Sign in again.',
    code: 'AUTH_REFRESH_SESSION_GONE',
  });
}


async function getSettingValue(key: string): Promise<string | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

async function getRegistrationMode(): Promise<'open' | 'approval' | 'closed'> {
  const scoped = await getSettingValue('security.registrationMode');
  const legacy = await getSettingValue('registrationMode');
  return normalizeRegistrationMode(scoped || legacy);
}

async function getSessionDurationHours(): Promise<number> {
  const raw = await getSettingValue('security.sessionDurationHours');
  const hours = Number.parseInt(raw || '24', 10);
  return Number.isFinite(hours) && hours > 0 ? hours : 24;
}

async function getMaxLoginAttempts(): Promise<number> {
  const raw = await getSettingValue('security.maxLoginAttempts');
  const attempts = Number.parseInt(raw || '10', 10);
  return Number.isFinite(attempts) && attempts > 0 ? attempts : 10;
}

async function getSandboxDefaultEnabled(): Promise<boolean> {
  const raw = await getSettingValue('security.sandboxDefaultEnabled');
  return raw === null ? true : raw === 'true';
}


/**
 * POST /api/auth/signup
 * 🍯 HONEYPOT - Never creates users. Logs attempt and blocks IP.
 */
router.post('/signup', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, username, password: _password } = signupSchema.parse(req.body);
    const meta = extractTrackingMetadata(req);

    // Block the IP
    blockedIPs.add(meta.ip);

    // Log the honeypot trigger
    await prisma.activityLog.create({
      data: {
        action: 'IP_BLOCKED',
        resource: 'honeypot',
        severity: 'WARNING',
        ipAddress: meta.ip,
        userAgent: meta.rawUserAgent,
        translatedMessage: formatHoneypotMessage(email, meta),
        metadata: {
          attemptedEmail: email,
          attemptedUsername: username,
          ip: meta.ip,
          geo: meta.geo,
          device: meta.device,
          reason: 'signup_honeypot',
          unblocked: false,
          blockedAt: new Date().toISOString(),
        },
      },
    });

    // Fake delay to simulate processing
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));

    // Return a convincing error (don't reveal it's a honeypot)
    throw new AppError(403, 'Access restricted. Contact administrator for access.');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/login
 * Login with rich metadata tracking
 */
router.post('/login', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const meta = extractTrackingMetadata(req);

    // Check rate limiting
    const maxLoginAttempts = await getMaxLoginAttempts();
    if (isRateLimited(meta.ip, maxLoginAttempts)) {
      await prisma.activityLog.create({
        data: {
          action: 'LOGIN_FAILED',
          resource: 'auth',
          severity: 'WARNING',
          ipAddress: meta.ip,
          userAgent: meta.rawUserAgent,
          translatedMessage: formatLoginMessage(email, meta, false, 'Rate limited'),
          metadata: { email, ip: meta.ip, geo: meta.geo, device: meta.device, reason: 'rate_limited' },
        },
      }).catch(() => {});
      throw new AppError(429, 'Too many failed attempts. Please try again later.');
    }

    // Find user
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      const { blocked } = recordFailedAttempt(meta.ip, maxLoginAttempts);
      await prisma.activityLog.create({
        data: {
          action: 'LOGIN_FAILED',
          resource: 'auth',
          severity: 'WARNING',
          ipAddress: meta.ip,
          userAgent: meta.rawUserAgent,
          translatedMessage: formatLoginMessage(email, meta, false, 'Unknown email'),
          metadata: { email, ip: meta.ip, geo: meta.geo, device: meta.device, reason: 'unknown_email' },
        },
      }).catch(() => {});
      if (blocked) {
        blockedIPs.add(meta.ip);
        await prisma.activityLog.create({
          data: {
            action: 'IP_BLOCKED',
            resource: 'auth',
            severity: 'ERROR',
            ipAddress: meta.ip,
            userAgent: meta.rawUserAgent,
            translatedMessage: `⛔ IP Auto-Blocked: ${meta.ip} (${meta.geo.summary}) - Too many failed login attempts`,
            metadata: { ip: meta.ip, geo: meta.geo, device: meta.device, reason: 'brute_force', unblocked: false, blockedAt: new Date().toISOString() },
          },
        }).catch(() => {});
      }
      throw new AppError(401, 'Invalid email or password');
    }

    if (!canAccessPortal((user as any).accountStatus, user.isActive)) {
      throw new AppError(403, describeBlockedAccountStatus((user as any).accountStatus));
    }

    // Verify password
    const passwordMatch = await comparePassword(password, user.passwordHash);
    if (!passwordMatch) {
      const { blocked } = recordFailedAttempt(meta.ip, maxLoginAttempts);
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'LOGIN_FAILED',
          resource: 'auth',
          severity: 'WARNING',
          ipAddress: meta.ip,
          userAgent: meta.rawUserAgent,
          translatedMessage: formatLoginMessage(email, meta, false, 'Wrong password'),
          metadata: { email, ip: meta.ip, geo: meta.geo, device: meta.device, reason: 'wrong_password' },
        },
      }).catch(() => {});
      if (blocked) {
        blockedIPs.add(meta.ip);
        await prisma.activityLog.create({
          data: {
            action: 'IP_BLOCKED',
            resource: 'auth',
            severity: 'ERROR',
            ipAddress: meta.ip,
            userAgent: meta.rawUserAgent,
            translatedMessage: `⛔ IP Auto-Blocked: ${meta.ip} (${meta.geo.summary}) - Too many failed login attempts`,
            metadata: { ip: meta.ip, geo: meta.geo, device: meta.device, reason: 'brute_force', unblocked: false, blockedAt: new Date().toISOString() },
          },
        }).catch(() => {});
      }
      throw new AppError(401, 'Invalid email or password');
    }

    // Success — clear failed attempts
    clearFailedAttempts(meta.ip);

    // Check if 2FA is enabled — if so, don't issue tokens yet
    if (user.twoFactorEnabled) {
      // Log pending 2FA attempt
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'LOGIN_2FA_PENDING',
          resource: 'auth',
          severity: 'INFO',
          ipAddress: meta.ip,
          userAgent: meta.rawUserAgent,
          translatedMessage: formatLoginMessage(email, meta, true, 'Pending 2FA verification'),
          metadata: { email, ip: meta.ip, geo: meta.geo, device: meta.device, reason: '2fa_pending' },
        },
      }).catch(() => {});

      // Return a short-lived pending token instead of raw userId
      const pending = await generate2FAPendingToken(user);

      // If email 2FA, auto-send the code so the user doesn't have to click separately
      let emailDelivery: {
        state: 'sent' | 'unavailable' | 'failed';
        message: string;
        recoveryAvailable?: boolean;
      } | undefined;
      if (user.twoFactorMethod === 'email') {
        const unavailable = portalFeatureUnavailableResponse('mail');
        if (unavailable) {
          emailDelivery = {
            state: 'unavailable',
            message: unavailable.error,
            recoveryAvailable: !hasStoredBackupCodes(user.twoFactorBackupCodes),
          };
        } else {
          try {
            await generateAndSendEmailCode(user, `login:${pending.id}`);
            emailDelivery = {
              state: 'sent',
              message: 'A verification code was sent to your email address.',
            };
          } catch (error) {
            if (isAuthorizationArtifactAdmissionConflict(error)) throw error;
            const becameUnavailable = error instanceof PortalFeatureUnavailableError
              ? portalFeatureUnavailableResponse('mail')
              : null;
            if (becameUnavailable) {
              emailDelivery = {
                state: 'unavailable',
                message: becameUnavailable.error,
                recoveryAvailable: !hasStoredBackupCodes(user.twoFactorBackupCodes),
              };
            } else {
              // Do not return SMTP/JMAP exceptions, hostnames, credentials, or
              // provider details to an unauthenticated browser.
              console.error('[auth] Failed to auto-send a 2FA email code');
              emailDelivery = {
                state: 'failed',
                message: 'The verification email could not be delivered. Try again or use a backup code.',
              };
            }
          }
        }
      }

      // Clear stale browser credentials only after every admitted artifact
      // required for this response has committed. A transition conflict must
      // leave the caller's existing cookies untouched so it can retry.
      clearAuthCookies(req, res);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        requiresTwoFactor: true,
        pendingToken: pending.token,
        method: user.twoFactorMethod || 'totp',
        ...(emailDelivery ? { emailDelivery } : {}),
      });
      return;
    }

    // Bind both tokens to the durable Session row. The stable identity survives
    // refresh rotation and makes a deleted row distinguishable from a stale
    // digest that another tab just rotated.
    const sessionId = crypto.randomUUID();
    const accessToken = generateAccessToken({
      userId: user.id,
      sessionId,
      email: user.email,
      role: user.role,
      accountStatus: (user as any).accountStatus,
      authorizationVersion: Number((user as any).authorizationVersion ?? 1),
    });
    const refreshToken = generateRefreshToken({ userId: user.id, sessionId });
    const refreshTokenHash = digestAuthToken('refresh', refreshToken);
    const sessionExpiresAt = new Date(Date.now() + (await getSessionDurationHours()) * 60 * 60 * 1000);

    // Last-login state and the corresponding session are one DB commit.
    await withAuthorizationArtifactAdmission(async (tx) => {
      const current = await tx.user.updateMany({
        where: authorizationCredentialSnapshotCas(user),
        data: { lastLoginAt: new Date() },
      });
      if (current.count !== 1) {
        throw new AppError(409, 'Account or credential state changed. Sign in again.');
      }
      await tx.session.create({
        data: {
          id: sessionId,
          userId: user.id,
          refreshTokenHash,
          ipAddress: meta.ip,
          userAgent: meta.rawUserAgent,
          expiresAt: sessionExpiresAt,
        },
      });
    });

    // Log success
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: 'LOGIN',
        resource: 'auth',
        severity: 'INFO',
        ipAddress: meta.ip,
        userAgent: meta.rawUserAgent,
        translatedMessage: formatLoginMessage(email, meta, true),
        metadata: { email, ip: meta.ip, geo: meta.geo, device: meta.device },
      },
    }).catch(() => {});

    // Send login alert if this is a new IP (check last 5 sessions for same IP)
    try {
      const recentSessions = await prisma.session.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { ipAddress: true },
      });
      const knownIPs = recentSessions.map(s => s.ipAddress).filter(Boolean);
      // The current session was just created, so exclude it from the "seen" check
      // by checking if we've seen this IP in prior sessions (more than just this one)
      const priorSessions = knownIPs.filter(ip => ip === meta.ip);
      if (priorSessions.length <= 1) {
        // New IP — send alert (non-blocking)
        sendLoginAlertEmail(
          { email: user.email, username: user.username },
          { ip: meta.ip, geo: meta.geo?.summary || '', device: meta.device?.summary || '', timestamp: new Date() }
        ).catch(() => {});
      }
    } catch {} // Non-critical

    await applyAuthCookies(req, res, accessToken, refreshToken);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        accountStatus: (user as any).accountStatus,
        sandboxEnabled: user.sandboxEnabled,
        authorizationVersion: Number((user as any).authorizationVersion ?? 1),
      },
    });
  } catch (error) {
    if (respondAuthorizationArtifactAdmissionConflict(res, error)) return;
    next(error);
  }
});

/**
 * POST /api/auth/refresh
 */
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken: bodyRefreshToken } = refreshSchema.parse(req.body || {});
    const refreshToken = bodyRefreshToken || req.cookies?.refreshToken;
    if (!refreshToken) {
      // Never emit deletion cookies from a refresh failure. A delayed failure
      // response can arrive after a newer login/rotation and would erase the
      // newer shared browser credentials. The 401 is the local sign-out signal.
      throw new AppError(401, 'Refresh token required');
    }

    const payload = verifyRefreshToken(refreshToken);
    if (!payload) {
      throw new AppError(401, 'Invalid refresh token');
    }

    const refreshTokenHash = digestAuthToken('refresh', refreshToken);
    const outcome = await withAuthorizationArtifactAdmission(async (tx) => {
      const now = new Date();
      const session = await tx.session.findUnique({
        where: { refreshTokenHash },
        include: { user: true },
      });
      if (!session || session.userId !== payload.userId) {
        // New tokens carry a stable Session id, so an old digest can be
        // classified without weakening the exact-digest CAS. If the row still
        // exists, another tab rotated it; if the row is gone, it was revoked.
        if (payload.sessionId) {
          const currentSession = await tx.session.findUnique({
            where: { id: payload.sessionId },
            select: { id: true, userId: true, expiresAt: true },
          });
          if (!currentSession || currentSession.userId !== payload.userId) {
            return { state: 'revoked', sessionId: payload.sessionId } as const;
          }
          if (currentSession.expiresAt < now) {
            await tx.session.deleteMany({
              where: { id: currentSession.id, userId: payload.userId },
            });
            return { state: 'expired', sessionId: currentSession.id } as const;
          }
          return { state: 'raced' } as const;
        }
        // Legacy tokens have no stable id. Preserve the pre-4.0.17
        // cookie-safe convergence behavior; /auth/me separately verifies their
        // current refresh digest so a deleted legacy row cannot restore.
        return { state: 'missingLegacy' } as const;
      }

      if (payload.sessionId && payload.sessionId !== session.id) {
        return { state: 'revoked', sessionId: payload.sessionId } as const;
      }
      if (session.expiresAt < now) {
        await tx.session.deleteMany({
          where: { id: session.id, refreshTokenHash },
        });
        return { state: 'expired', sessionId: session.id } as const;
      }

      const user = session.user;
      if (!canAccessPortal((user as any).accountStatus, user.isActive)) {
        await tx.session.deleteMany({
          where: { id: session.id, refreshTokenHash },
        });
        return {
          state: 'blocked',
          sessionId: session.id,
          accountStatus: (user as any).accountStatus,
        } as const;
      }

      // Claim the exact old digest before minting a replacement. The temporary
      // digest is never committed independently: any later error rolls this
      // whole admitted transaction back to the still-usable old token.
      const rotationClaimHash = digestAuthToken(
        'refresh',
        crypto.randomBytes(32).toString('base64url'),
      );
      const claimed = await tx.session.updateMany({
        where: {
          id: session.id,
          refreshTokenHash,
          expiresAt: { gt: now },
        },
        data: { refreshTokenHash: rotationClaimHash },
      });
      if (claimed.count !== 1) {
        return { state: 'raced' } as const;
      }

      const newRefreshToken = generateRefreshToken({
        userId: user.id,
        sessionId: session.id,
      });
      const newRefreshTokenHash = digestAuthToken('refresh', newRefreshToken);
      const finalized = await tx.session.updateMany({
        where: {
          id: session.id,
          refreshTokenHash: rotationClaimHash,
          expiresAt: { gt: now },
        },
        data: { refreshTokenHash: newRefreshTokenHash },
      });
      if (finalized.count !== 1) {
        throw new AppError(503, 'Refresh token rotation could not be finalized');
      }

      return {
        state: 'rotated',
        newRefreshToken,
        user: {
          id: user.id,
          sessionId: session.id,
          email: user.email,
          role: user.role,
          accountStatus: (user as any).accountStatus,
          authorizationVersion: Number((user as any).authorizationVersion ?? 1),
        },
      } as const;
    });

    if (outcome.state === 'missingLegacy') {
      // The JWT is valid but its old digest is no longer current. This can be a
      // replay, revocation, or a second tab whose request reached PostgreSQL
      // after the winner committed. Reject admission in every case, but never
      // emit deletion cookies that can clobber a newer shared browser jar.
      respondRefreshRotationConflict(res);
      return;
    }
    if (outcome.state === 'revoked') {
      if (outcome.sessionId) {
        // The verified token carries a stable authority even if its digest was
        // rebound or corrupted. Retire that exact in-process authority only
        // after the admission transaction has settled.
        publishSessionRevoked({
          userId: payload.userId,
          sessionId: outcome.sessionId,
          reason: 'logout',
        });
      }
      respondRefreshSessionGone(req, res, refreshToken);
      return;
    }
    if (outcome.state === 'expired') {
      publishSessionRevoked({
        userId: payload.userId,
        sessionId: outcome.sessionId,
        reason: 'expired',
      });
      throw new AppError(401, 'Refresh token expired');
    }
    if (outcome.state === 'blocked') {
      publishSessionRevoked({
        userId: payload.userId,
        sessionId: outcome.sessionId,
        reason: 'account_blocked',
      });
      throw new AppError(403, describeBlockedAccountStatus(outcome.accountStatus));
    }
    if (outcome.state === 'raced') {
      // Another request won the exact old-token CAS. Reject this replay without
      // mutating cookies: two tabs share one browser jar, so a late deletion
      // response would otherwise erase the winner's newly rotated credentials.
      // No token is minted here and the old digest remains unusable.
      respondRefreshRotationConflict(res);
      return;
    }

    const newAccessToken = generateAccessToken({
      userId: outcome.user.id,
      sessionId: outcome.user.sessionId,
      email: outcome.user.email,
      role: outcome.user.role,
      accountStatus: outcome.user.accountStatus,
      authorizationVersion: outcome.user.authorizationVersion,
    });

    await applyAuthCookies(req, res, newAccessToken, outcome.newRefreshToken);

    res.json({ accessToken: newAccessToken });
  } catch (error) {
    if (respondAuthorizationArtifactAdmissionConflict(res, error)) return;
    next(error);
  }
});

/**
 * POST /api/auth/logout
 * Best-effort logout: clears browser cookies even if the access token is already dead.
 */
router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const meta = extractTrackingMetadata(req);
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    const accessToken = bearerToken || req.cookies?.accessToken;
    const refreshToken = req.cookies?.refreshToken;

    const accessPayload = accessToken ? verifyAccessToken(accessToken) : null;
    const refreshPayload = refreshToken ? verifyRefreshToken(refreshToken) : null;
    const userId = accessPayload?.userId || refreshPayload?.userId || null;

    let revokedSessionId: string | null = null;
    let revokedAllSessions = false;
    let logoutAuthorizationVersion: number | null = null;
    if (userId) {
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'LOGOUT',
          resource: 'auth',
          severity: 'INFO',
          ipAddress: meta.ip,
          userAgent: meta.rawUserAgent,
          translatedMessage: 'Signed out of the portal',
          metadata: { ip: meta.ip, geo: meta.geo, device: meta.device },
        },
      }).catch(() => {});

      if (accessPayload?.sessionId) {
        // A stable access-token claim is authoritative even when a shared cookie
        // jar still carries a stale, rotated, or cross-identity refresh token.
        revokedSessionId = accessPayload.sessionId;
        await prisma.session.deleteMany({
          where: { id: accessPayload.sessionId, userId: accessPayload.userId },
        });
      } else if (
        accessPayload
        && !accessPayload.sessionId
      ) {
        // A legacy access token cannot bind one live transport to one durable
        // Session. Preserve the migration fallback as an explicit all-session
        // logout and advance the generation so that old JWT cannot reconnect.
        // The selected access identity remains authoritative even when a shared
        // cookie jar carries an invalid or cross-identity refresh token.
        logoutAuthorizationVersion = await revokeAllSessionsForLegacyLogout(accessPayload.userId);
        revokedAllSessions = true;
      } else if (
        refreshToken
        && refreshPayload
        && refreshPayload.userId === userId
      ) {
        if (!refreshPayload.sessionId) {
          logoutAuthorizationVersion = await revokeAllSessionsForLegacyLogout(userId);
          revokedAllSessions = true;
        } else {
          // A verified stable refresh claim names the durable authority even if
          // its row was already removed or its digest rotated in another tab.
          revokedSessionId = refreshPayload.sessionId;
          await prisma.session.deleteMany({
            where: {
              userId,
              id: refreshPayload.sessionId,
            },
          });
        }
      }
    }

    if (userId && logoutAuthorizationVersion !== null) {
      publishAuthorizationChanged({
        type: 'authorization_changed',
        userId,
        authorizationVersion: logoutAuthorizationVersion,
        reasons: ['credential_recovery'],
      });
    }
    if (userId && revokedSessionId && !revokedAllSessions) {
      publishSessionRevoked({ userId, sessionId: revokedSessionId, reason: 'logout' });
    } else if (userId && revokedAllSessions) {
      publishAllSessionsRevoked({ userId, reason: 'logout' });
    }

    clearAuthCookies(req, res);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    next(error);
  }
});


// ── Forgot Password ─────────────────────────────────────────────────────

const forgotPasswordSchema = z.object({
  email: z.string().transform(normalizeEmail).pipe(z.string().email('Invalid email')),
});

/**
 * POST /api/auth/forgot-password
 * Request a password reset email. Always returns success (don't leak email existence).
 */
router.post('/forgot-password', forgotPasswordLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Always respond with the same message regardless of whether user exists
    const successMessage = 'If an account exists with that email, you will receive a password reset link.';

    // Private-origin profiles cannot deliver recovery mail. Return the same
    // enumeration-resistant response before parsing identity data or touching
    // users/tokens, while keeping already-issued reset tokens usable through
    // the separate reset-password route.
    if (!getPortalFeatureCapabilities().mail.available) {
      res.json({ message: successMessage });
      return;
    }

    const { email } = forgotPasswordSchema.parse(req.body);
    const meta = extractTrackingMetadata(req);

    const user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      // Generate raw token and hash it for storage
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = digestAuthToken('password-reset', rawToken);

      let resetToken: { id: string } | null;
      try {
        resetToken = await withAuthorizationArtifactAdmission(async (tx) => {
          const current = await tx.user.findFirst({
            where: authorizationCredentialSnapshotCas(user),
            select: { id: true },
          });
          if (!current) return null;
          return tx.passwordResetToken.create({
            data: {
              userId: user.id,
              token: tokenHash,
              expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
            },
            select: { id: true },
          });
        });
      } catch (error) {
        if (isAuthorizationArtifactAdmissionConflict(error)) {
          res.json({ message: successMessage });
          return;
        }
        throw error;
      }
      if (!resetToken) {
        res.json({ message: successMessage });
        return;
      }

      let delivered = false;
      try {
        // Send reset email via Stalwart JMAP
        // URL fragments are not sent in the HTTP request or Referer header, so
        // reset bearer secrets stay out of proxy/server access logs.
        const resetUrl = buildPortalUrl(buildPasswordResetPath(rawToken), req);
        await sendPasswordResetEmail({ email: user.email }, resetUrl);
        delivered = true;
      } catch (mailError) {
        await prisma.passwordResetToken.delete({ where: { id: resetToken.id } }).catch(() => {});
        console.error('[auth] Failed to send password reset email:', mailError);
      }

      if (delivered) {
        // The recipient now holds this exact bearer. Keep it valid even if
        // best-effort retirement of older links fails; deleting the delivered
        // candidate here would turn a successful email into a dead link.
        await prisma.passwordResetToken.deleteMany({
          where: {
            userId: user.id,
            usedAt: null,
            id: { not: resetToken.id },
          },
        }).catch((cleanupError) => {
          console.error('[auth] Failed to retire older password reset tokens:', cleanupError);
        });
      }

      // Log to activity log
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'PASSWORD_RESET_REQUESTED',
          resource: 'auth',
          severity: 'INFO',
          ipAddress: meta.ip,
          userAgent: meta.rawUserAgent,
          translatedMessage: `Password reset requested for ${email}`,
          metadata: { email, ip: meta.ip, geo: meta.geo },
        },
      }).catch(() => {});
    }

    res.json({ message: successMessage });
  } catch (error) {
    next(error);
  }
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

/**
 * POST /api/auth/reset-password
 * Reset password using a valid token.
 */
router.post('/reset-password', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, newPassword } = resetPasswordSchema.parse(req.body);
    const meta = extractTrackingMetadata(req);

    // Validate password strength
    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) {
      throw new AppError(400, strength.errors.join('. '));
    }

    const tokenHash = digestAuthToken('password-reset', token);
    const matchedToken = await prisma.passwordResetToken.findUnique({
      where: { token: tokenHash },
      include: { user: true },
    });
    if (!matchedToken || matchedToken.usedAt || matchedToken.expiresAt <= new Date()) {
      throw new AppError(400, 'Invalid or expired reset link. Please request a new password reset.');
    }

    const newHash = await hashPassword(newPassword);
    const resetAuthorizationVersion = await withAuthorizationArtifactAdmission(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: {
          id: matchedToken.id,
          token: tokenHash,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) {
        throw new AppError(400, 'Invalid or expired reset link. Please request a new password reset.');
      }

      const updated = await tx.user.updateMany({
        where: {
          ...authorizationUserSnapshotCas(matchedToken.user),
          passwordHash: matchedToken.user.passwordHash,
        },
        data: {
          passwordHash: newHash,
          authorizationVersion: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new AppError(409, 'Account or credential state changed. Request a new password reset.');
      }
      await tx.session.deleteMany({ where: { userId: matchedToken.userId } });
      await tx.twoFactorChallenge.deleteMany({ where: { userId: matchedToken.userId } });
      await tx.emailVerificationCode.deleteMany({ where: { userId: matchedToken.userId } });
      await tx.passwordResetToken.updateMany({
        where: { userId: matchedToken.userId, usedAt: null },
        data: { usedAt: new Date() },
      });
      return Number(matchedToken.user.authorizationVersion ?? 1) + 1;
    });

    publishAuthorizationChanged({
      type: 'authorization_changed',
      userId: matchedToken.userId,
      authorizationVersion: resetAuthorizationVersion,
      reasons: ['credential_recovery'],
    });
    publishAllSessionsRevoked({
      userId: matchedToken.userId,
      reason: 'credential_recovery',
    });

    // If the reset link is opened in a browser that still carries old auth
    // cookies, clear them now so the client lands on a clean sign-in state
    // instead of briefly looking authenticated until the next refresh fails.
    clearAuthCookies(req, res);

    // Send confirmation email
    await sendPasswordChangedEmail({
      email: matchedToken.user.email,
      username: matchedToken.user.username,
    });

    // Log to activity log
    await prisma.activityLog.create({
      data: {
        userId: matchedToken.userId,
        action: 'PASSWORD_RESET_COMPLETED',
        resource: 'auth',
        severity: 'INFO',
        ipAddress: meta.ip,
        userAgent: meta.rawUserAgent,
        translatedMessage: `Password reset completed for ${matchedToken.user.email}`,
        metadata: { email: matchedToken.user.email, ip: meta.ip, geo: meta.geo },
      },
    }).catch(() => {});

    res.json({ success: true, message: 'Password has been reset successfully. You can now sign in with your new password.' });
  } catch (error) {
    if (respondAuthorizationArtifactAdmissionConflict(res, error)) return;
    next(error);
  }
});

// ── Registration ────────────────────────────────────────────────────────

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  email: z.string().transform(normalizeEmail).pipe(z.string().email('Invalid email')),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  message: z.string().max(1000).optional(),
});

/**
 * POST /api/auth/register
 * Register a new account. Behavior depends on SystemSetting 'registrationMode':
 *   - 'open': create User immediately (role=USER, accountStatus=ACTIVE)
 *   - 'approval': create RegistrationRequest
 *   - 'closed' (default): return 403
 */
router.post('/register', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, password, message } = registerSchema.parse(req.body);
    const requestedUsername = canonicalUsername(name.replace(/[^a-z0-9_-]/gi, '') || email.split('@')[0]);

    if (isReservedSystemMailboxUsername(requestedUsername)) {
      throw new AppError(400, `Username '${requestedUsername}' is reserved for system use. Choose a different username.`);
    }

    // Get registration mode from settings
    const mode = await getRegistrationMode();

    if (mode === 'closed') {
      // Log the attempt but do NOT auto-block the IP — legitimate users may try to register
      // on a closed portal without malicious intent. IP blocking is reserved for honeypot
      // endpoints (/signup) and repeated brute-force attempts.
      const blockOnClosed = await getSettingValue('security.blockClosedRegistration');
      const shouldBlock = blockOnClosed === 'true'; // Only block if explicitly opted in (default: no block)

      if (shouldBlock) {
        const meta = extractTrackingMetadata(req);

        // Block the IP
        blockedIPs.add(meta.ip);

        // Log the blocked registration attempt
        await prisma.activityLog.create({
          data: {
            action: 'REGISTRATION_BLOCKED',
            resource: 'auth',
            severity: 'WARNING',
            ipAddress: meta.ip,
            userAgent: meta.rawUserAgent,
            translatedMessage: `Registration attempt blocked (closed mode) from ${meta.ip} — email: ${email}`,
            metadata: {
              attemptedEmail: email,
              attemptedName: name,
              ip: meta.ip,
              geo: meta.geo,
              device: meta.device,
              reason: 'closed_registration',
              blockedAt: new Date().toISOString(),
            },
          },
        }).catch(() => {});

        // Fake delay to simulate processing
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));

        // Return a vague 404 — don't confirm registration is closed
        res.status(404).json({ error: 'Not found' });
        return;
      }

      throw new AppError(403, 'Registration is closed. Contact an administrator for access.');
    }

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      throw new AppError(400, strength.errors.join('. '));
    }

    // Check if email already in use
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new AppError(409, 'An account with this email already exists');
    }

    const existingRequest = await prisma.registrationRequest.findFirst({
      where: {
        email,
        status: 'PENDING',
      },
      orderBy: { requestedAt: 'desc' },
    });
    if (existingRequest) {
      throw new AppError(409, 'A registration request for this email is already pending review');
    }

    if (mode === 'open') {
      // Create user immediately with USER role
      const passwordHash = await hashPassword(password);
      const userId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const accessToken = generateAccessToken({
        userId,
        sessionId,
        email,
        role: 'USER',
        accountStatus: ACTIVE_STATUS,
        authorizationVersion: 1,
      });
      const refreshToken = generateRefreshToken({ userId, sessionId });
      const refreshTokenHash = digestAuthToken('refresh', refreshToken);
      const sandboxEnabled = await getSandboxDefaultEnabled();
      const expiresAt = new Date(Date.now() + (await getSessionDurationHours()) * 60 * 60 * 1000);

      const user = await mapAuthorizationArtifactAdmissionConflicts(() => (
        prisma.$transaction(async (tx) => {
          await assertNoProjectAuthorizationTransitionActive(tx);
          const created = await tx.user.create({
            data: {
              id: userId,
              email,
              username: requestedUsername,
              passwordHash,
              role: 'USER',
              accountStatus: ACTIVE_STATUS,
              isActive: true,
              sandboxEnabled,
            },
          } as any);
          await tx.session.create({
            data: {
              id: sessionId,
              userId: created.id,
              refreshTokenHash,
              ipAddress: req.ip || 'unknown',
              userAgent: req.headers['user-agent'] || 'unknown',
              expiresAt,
            },
          });
          return created;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      ));

      if (getPortalFeatureCapabilities().mail.available) {
        // Provision personal mailbox (non-blocking, but immediate if possible)
        provisionUserMailbox(user.username, user.id, { makePrimary: true }).catch((err) => {
          console.error('[auth] Failed to auto-provision mailbox on open registration:', err);
        });

        // Send welcome email via Stalwart (non-blocking)
        sendWelcomeEmail({ email: user.email, username: user.username }).catch(() => {});
      }

      await applyAuthCookies(req, res, accessToken, refreshToken);

      res.json({
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          role: user.role,
          accountStatus: (user as any).accountStatus,
          sandboxEnabled: user.sandboxEnabled,
          authorizationVersion: Number((user as any).authorizationVersion ?? 1),
        },
      });
    } else if (mode === 'approval') {
      const passwordHash = await hashPassword(password);

      // Create registration request
      await prisma.registrationRequest.create({
        data: {
          email,
          name,
          passwordHash,
          message: message || null,
        },
      });

      await sendNewUserAlert(email, name).catch((err) => {
        console.error('[auth] Failed to send new registration alert:', err);
      });

      res.json({
        pending: true,
        message: 'Your registration request has been submitted. An administrator will review it.',
      });
    } else {
      throw new AppError(403, 'Registration is closed');
    }
  } catch (error) {
    if (respondAuthorizationArtifactAdmissionConflict(res, error)) return;
    next(isUniqueConstraintError(error)
      ? new AppError(409, 'That email or username is already registered or pending review')
      : error);
  }
});

// ── Profile ─────────────────────────────────────────────────────────────

function rejectLegacySessionRestore(req: Request, res: Response): void {
  // The normal Portal client authenticates /auth/me with the httpOnly access
  // cookie. Do not let an unrelated bearer probe erase a newer browser jar.
  if (!req.headers.authorization && typeof req.cookies?.accessToken === 'string') {
    clearAuthCookies(req, res);
  }
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.status(401).json({
    error: 'This sign-in session is no longer active. Sign in again.',
    code: AUTH_SESSION_REVOKED_CODE,
  });
}

/**
 * Access tokens issued before the stable Session claim cannot be checked by
 * authenticateToken's existing user query. Restrict this compatibility lookup
 * to the restore probe: a legacy browser remains signed in only while its exact
 * refresh digest still names a live durable Session.
 */
async function requireDurableLegacySessionForRestore(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.user?.sessionId) {
    next();
    return;
  }

  const refreshToken = req.cookies?.refreshToken;
  const refreshPayload = typeof refreshToken === 'string'
    ? verifyRefreshToken(refreshToken)
    : null;
  if (!refreshPayload || refreshPayload.userId !== req.user?.userId) {
    rejectLegacySessionRestore(req, res);
    return;
  }

  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: digestAuthToken('refresh', refreshToken) },
    select: { id: true, userId: true, expiresAt: true },
  });
  if (
    !session
    || session.userId !== req.user.userId
    || session.expiresAt <= new Date()
    || (refreshPayload.sessionId && refreshPayload.sessionId !== session.id)
  ) {
    rejectLegacySessionRestore(req, res);
    return;
  }

  next();
}

/**
 * GET /api/auth/me
 * Get current user profile (includes role and sandboxEnabled)
 */
router.get(
  '/me',
  authenticateToken,
  requireDurableLegacySessionForRestore,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new AppError(401, 'Not authenticated');

      const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: {
          id: true,
          email: true,
          username: true,
          firstName: true,
          lastName: true,
          role: true,
          accountStatus: true,
          sandboxEnabled: true,
          authorizationVersion: true,
          avatarPath: true,
          createdAt: true,
          lastLoginAt: true,
        },
      } as any);

      if (!user) throw new AppError(404, 'Invalid request');

      res.json(user);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/auth/registration-mode
 * Public endpoint — tells the frontend what registration options to show
 */
router.get('/registration-mode', async (_req: Request, res: Response) => {
  const mode = await getRegistrationMode();
  res.json({ mode });
});


// ── Profile Update ──────────────────────────────────────────────────────

const updateProfileSchema = z.object({
  username: z.string().transform(canonicalUsername).pipe(z.string().min(2).max(100)).optional(),
  email: z.string().transform(normalizeEmail).pipe(z.string().email()).optional(),
  currentPassword: z.string().min(1, 'Current password is required'),
  twoFactorToken: z.string().min(6).max(8).optional(),
}).strict().refine((value) => value.username !== undefined || value.email !== undefined, {
  message: 'Username or email is required',
});

/**
 * PUT /api/auth/me
 * Update current user profile (username, email)
 */
router.put('/me', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new AppError(401, 'Not authenticated');
    const requestAuthorizationVersion = Number(req.user.authorizationVersion ?? 1);
    const { currentPassword, twoFactorToken, ...data } = updateProfileSchema.parse(req.body);

    if (data.username && isReservedSystemMailboxUsername(data.username)) {
      throw new AppError(400, `Username '${data.username}' is reserved for system use. Choose a different username.`);
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: req.user.userId },
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
        authorizationVersion: true,
        passwordHash: true,
        twoFactorEnabled: true,
        twoFactorMethod: true,
        twoFactorSecret: true,
        twoFactorBackupCodes: true,
        twoFactorLastUsedStep: true,
      },
    });
    if (!currentUser) throw new AppError(404, 'Invalid request');
    if (!await comparePassword(currentPassword, currentUser.passwordHash)) {
      throw new AppError(401, 'Current password is incorrect');
    }

    let totpStep: number | null = null;
    let emailCodeId: string | null = null;
    if (currentUser.twoFactorEnabled) {
      if (!twoFactorToken) {
        throw new AppError(401, 'A current two-factor code is required to change account identity');
      }
      if (currentUser.twoFactorMethod === 'email') {
        const code = await findVerifiedEmailCode(currentUser.id, 'reauth', twoFactorToken);
        if (!code) throw new AppError(401, 'Invalid or expired verification code');
        emailCodeId = code.id;
      } else {
        totpStep = await verifyTotpStep(currentUser, twoFactorToken);
        if (totpStep === null) throw new AppError(401, 'Invalid or already-used verification code');
      }
    }

    const user = await withAuthorizationArtifactAdmission(async (tx) => {
      if (emailCodeId) {
        const consumed = await tx.emailVerificationCode.updateMany({
          where: { id: emailCodeId, userId: currentUser.id, purpose: 'reauth', usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
        if (consumed.count !== 1) throw new AppError(401, 'Verification code was already used');
      }

      const updated = await tx.user.updateMany({
        where: {
          ...authorizationUserSnapshotCas(currentUser),
          authorizationVersion: requestAuthorizationVersion,
          passwordHash: currentUser.passwordHash,
          twoFactorEnabled: currentUser.twoFactorEnabled,
          twoFactorMethod: currentUser.twoFactorMethod,
          twoFactorSecret: currentUser.twoFactorSecret,
          twoFactorBackupCodes: currentUser.twoFactorBackupCodes,
          ...(totpStep === null
            ? { twoFactorLastUsedStep: currentUser.twoFactorLastUsedStep }
            : {}),
          ...(totpStep === null ? {} : {
            OR: [
              { twoFactorLastUsedStep: null },
              { twoFactorLastUsedStep: { lt: totpStep } },
            ],
          }),
        },
        data: {
          ...data,
          ...(totpStep === null ? {} : { twoFactorLastUsedStep: totpStep }),
          authorizationVersion: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new AppError(409, 'Credentials or two-factor state changed; authenticate again');
      }

      await tx.session.deleteMany({ where: { userId: currentUser.id } });
      return tx.user.findUniqueOrThrow({
        where: { id: currentUser.id },
        select: {
          id: true,
          email: true,
          username: true,
          role: true,
          accountStatus: true,
          sandboxEnabled: true,
          authorizationVersion: true,
        },
      } as any);
    });

    const profileAuthorizationVersion = Number((user as any).authorizationVersion ?? requestAuthorizationVersion + 1);
    publishAuthorizationChanged({
      type: 'authorization_changed',
      userId: currentUser.id,
      authorizationVersion: profileAuthorizationVersion,
      reasons: ['credential_recovery'],
    });
    publishAllSessionsRevoked({
      userId: currentUser.id,
      reason: 'credential_change',
    });

    // Provision mailbox if username changed, but keep prior mailboxes accessible
    if (
      data.username
      && data.username !== currentUser.username
      && getPortalFeatureCapabilities().mail.available
    ) {
      try {
        await provisionUserMailbox(data.username, req.user.userId, { makePrimary: true });
        console.log(`[auth] Provisioned mailbox for user ${data.username}`);
      } catch (err) {
        // Mailbox provisioning failure should NOT fail the profile update
        console.error('[auth] Mailbox provisioning failed (non-fatal):', err);
      }
    }

    clearAuthCookies(req, res);
    res.json(user);
  } catch (error) {
    if (respondAuthorizationArtifactAdmissionConflict(res, error)) return;
    next(isUniqueConstraintError(error) ? new AppError(409, 'Email or username already in use') : error);
  }
});

// ── Change Password ─────────────────────────────────────────────────────

const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

/**
 * POST /api/auth/change-password
 * Change current user's password (requires current password)
 */
router.post('/change-password', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new AppError(401, 'Not authenticated');
    const requestAuthorizationVersion = Number(req.user.authorizationVersion ?? 1);
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) throw new AppError(404, 'Invalid request');

    const valid = await comparePassword(currentPassword, user.passwordHash);
    if (!valid) throw new AppError(401, 'Current password is incorrect');

    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) {
      throw new AppError(400, strength.errors.join('. '));
    }

    const newHash = await hashPassword(newPassword);
    const changedAuthorizationVersion = await withAuthorizationArtifactAdmission(async (tx) => {
      const updated = await tx.user.updateMany({
        where: {
          ...authorizationUserSnapshotCas(user),
          authorizationVersion: requestAuthorizationVersion,
          passwordHash: user.passwordHash,
        },
        data: {
          passwordHash: newHash,
          authorizationVersion: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new AppError(409, 'Password changed in another session; authenticate again');
      }
      await tx.session.deleteMany({ where: { userId: req.user!.userId } });
      await tx.twoFactorChallenge.deleteMany({ where: { userId: req.user!.userId } });
      await tx.emailVerificationCode.deleteMany({ where: { userId: req.user!.userId } });
      await tx.passwordResetToken.updateMany({
        where: { userId: req.user!.userId, usedAt: null },
        data: { usedAt: new Date() },
      });
      return requestAuthorizationVersion + 1;
    });
    publishAuthorizationChanged({
      type: 'authorization_changed',
      userId: req.user.userId,
      authorizationVersion: changedAuthorizationVersion,
      reasons: ['credential_recovery'],
    });
    publishAllSessionsRevoked({
      userId: req.user.userId,
      reason: 'credential_change',
    });
    clearAuthCookies(req, res);

    // Send password changed confirmation email (non-blocking)
    sendPasswordChangedEmail({ email: user.email, username: user.username }).catch(() => {});

    res.json({ success: true, message: 'Password changed successfully. Please sign in again.' });
  } catch (error) {
    if (respondAuthorizationArtifactAdmissionConflict(res, error)) return;
    next(error);
  }
});

// ── Two-Factor Authentication ───────────────────────────────────────────

/**
 * POST /api/auth/2fa/send-email
 * Send (or resend) an email verification code during the login 2FA flow.
 * Rate-limited: 3 per 15 min per IP.
 */
router.post('/2fa/send-email', twoFactorEmailLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (respondWithUnavailableMail(res)) return;

    const { pendingToken } = z.object({ pendingToken: z.string() }).parse(req.body);

    const pending = await verify2FAPendingToken(pendingToken);
    if (!pending) {
      throw new AppError(401, 'Invalid or expired verification session. Please log in again.');
    }

    const user = pending.user;
    if (!user.twoFactorEnabled || user.twoFactorMethod !== 'email') {
      throw new AppError(401, 'Invalid verification session');
    }

    await generateAndSendEmailCode(user, `login:${pending.id}`);

    res.json({ message: 'Verification code sent' });
  } catch (error) {
    if (respondAuthorizationArtifactAdmissionConflict(res, error)) return;
    next(error);
  }
});

/**
 * POST /api/auth/2fa/setup
 * Generate TOTP secret and QR code for setup, or initiate email 2FA setup.
 * Authenticated only.
 */
router.post('/2fa/setup', rejectUnavailableEmailMethodRequest, authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { method } = z.object({ method: z.enum(['totp', 'email']).default('totp') }).parse(req.body || {});
    if (method === 'email' && respondWithUnavailableMail(res)) return;

    if (!req.user) throw new AppError(401, 'Not authenticated');
    const requestAuthorizationVersion = Number(req.user.authorizationVersion ?? 1);

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) throw new AppError(404, 'Invalid request');

    if (user.twoFactorEnabled) {
      throw new AppError(400, 'Two-factor authentication is already enabled');
    }

    if (method === 'email') {
      // Email-based 2FA setup: send a verification code to confirm
      await generateAndSendEmailCode(user, 'setup', requestAuthorizationVersion);

      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: '2FA_SETUP_INITIATED',
          resource: 'auth',
          severity: 'INFO',
          translatedMessage: '2FA setup initiated (email method)',
        },
      }).catch(() => {});

      res.json({ method: 'email', message: 'Verification code sent to your email' });
      return;
    }

    // TOTP-based 2FA setup (existing flow)
    const secret = otpGenerateSecret({ crypto: otpCrypto, base32: otpBase32 });

    // Store the secret temporarily (2FA not enabled yet)
    const stored = await withAuthorizationArtifactAdmission((tx) => tx.user.updateMany({
      where: {
        ...authorizationUserSnapshotCas(user),
        authorizationVersion: requestAuthorizationVersion,
        passwordHash: user.passwordHash,
        twoFactorEnabled: false,
        twoFactorMethod: user.twoFactorMethod,
        twoFactorSecret: user.twoFactorSecret,
        twoFactorBackupCodes: user.twoFactorBackupCodes,
        twoFactorLastUsedStep: user.twoFactorLastUsedStep,
      },
      data: { twoFactorSecret: encryptSecret(secret), twoFactorLastUsedStep: null },
    }));
    if (stored.count !== 1) {
      throw new AppError(409, 'Account or two-factor state changed. Start setup again.');
    }

    // Generate otpauth URL and QR code
    const otpauthUrl = otpGenerateURI({ secret, label: user.email, issuer: 'BridgesLLM' });
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: '2FA_SETUP_INITIATED',
        resource: 'auth',
        severity: 'INFO',
        translatedMessage: '2FA setup initiated (TOTP method)',
      },
    }).catch(() => {});

    res.json({ method: 'totp', secret, qrCodeDataUrl, otpauthUrl });
  } catch (error) {
    if (respondAuthorizationArtifactAdmissionConflict(res, error)) return;
    next(error);
  }
});

/**
 * POST /api/auth/2fa/verify-setup
 * Verify TOTP or email code during setup, enable 2FA, return backup codes.
 */
router.post('/2fa/verify-setup', rejectUnavailableEmailMethodRequest, authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, method } = z.object({
      token: z.string().min(6).max(6),
      method: z.enum(['totp', 'email']).default('totp'),
    }).parse(req.body);
    if (method === 'email' && respondWithUnavailableMail(res)) return;

    if (!req.user) throw new AppError(401, 'Not authenticated');
    const requestAuthorizationVersion = Number(req.user.authorizationVersion ?? 1);

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) throw new AppError(404, 'Invalid request');
    if (user.twoFactorEnabled) throw new AppError(400, 'Two-factor authentication is already enabled');

    const verifiedCode = method === 'email'
      ? await findVerifiedEmailCode(user.id, 'setup', token)
      : null;
    const totpStep = method === 'totp' ? await verifyTotpStep(user, token) : null;
    if (method === 'email' && !verifiedCode) {
      throw new AppError(400, 'Invalid or expired verification code. Please request a new one.');
    }
    if (method === 'totp' && totpStep === null) {
      throw new AppError(400, 'Invalid or already-used verification code. Please try again.');
    }

    // Generate backup codes
    const plainBackupCodes = generateBackupCodes();
    const hashedCodes = await Promise.all(plainBackupCodes.map(code => hashPassword(code)));

    // Consume the setup proof and enable 2FA in one transaction.
    await withAuthorizationArtifactAdmission(async (tx) => {
      if (verifiedCode) {
        const consumed = await tx.emailVerificationCode.updateMany({
          where: { id: verifiedCode.id, userId: user.id, purpose: 'setup', usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
        if (consumed.count !== 1) throw new AppError(409, 'Verification code was already used');
      }

      const enabled = await tx.user.updateMany({
        where: {
          ...authorizationUserSnapshotCas(user),
          authorizationVersion: requestAuthorizationVersion,
          passwordHash: user.passwordHash,
          twoFactorEnabled: false,
          twoFactorMethod: user.twoFactorMethod,
          twoFactorSecret: user.twoFactorSecret,
          twoFactorBackupCodes: user.twoFactorBackupCodes,
          ...(method === 'email'
            ? { twoFactorLastUsedStep: user.twoFactorLastUsedStep }
            : {}),
          ...(method === 'totp' ? {
            OR: [
              { twoFactorLastUsedStep: null },
              { twoFactorLastUsedStep: { lt: totpStep! } },
            ],
          } : {}),
        },
        data: {
          twoFactorEnabled: true,
          twoFactorMethod: method,
          twoFactorBackupCodes: JSON.stringify(hashedCodes),
          twoFactorSecret: method === 'email' ? null : user.twoFactorSecret,
          twoFactorLastUsedStep: method === 'totp' ? totpStep : null,
        },
      });
      if (enabled.count !== 1) throw new AppError(409, 'Two-factor setup changed or was already completed');
    });

    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: '2FA_ENABLED',
        resource: 'auth',
        severity: 'INFO',
        translatedMessage: `Two-factor authentication enabled (${method})`,
      },
    }).catch(() => {});

    // Send 2FA enabled confirmation email (non-blocking)
    sendTwoFactorEnabledEmail({ email: user.email, username: user.username }, method).catch(() => {});

    res.json({ backupCodes: plainBackupCodes });
  } catch (error) {
    if (respondAuthorizationArtifactAdmissionConflict(res, error)) return;
    next(error);
  }
});

/**
 * POST /api/auth/2fa/send-email-authenticated
 * Send an email verification code for authenticated users (e.g., for disabling 2FA).
 * Rate-limited: 3 per 15 min per IP.
 */
router.post('/2fa/send-email-authenticated', rejectUnavailableMailRequest, authenticateToken, twoFactorEmailLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (respondWithUnavailableMail(res)) return;

    if (!req.user) throw new AppError(401, 'Not authenticated');

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user || !user.twoFactorEnabled || user.twoFactorMethod !== 'email') {
      throw new AppError(400, 'Email 2FA is not enabled');
    }

    await generateAndSendEmailCode(
      user,
      'reauth',
      Number(req.user.authorizationVersion ?? 1),
    );
    res.json({ message: 'Verification code sent' });
  } catch (error) {
    if (respondAuthorizationArtifactAdmissionConflict(res, error)) return;
    next(error);
  }
});

/**
 * POST /api/auth/2fa/disable
 * Disable 2FA. Requires current TOTP or email verification code.
 */
router.post('/2fa/disable', authenticateToken, twoFactorDisableLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new AppError(401, 'Not authenticated');
    const { token } = z.object({ token: z.string().min(6).max(8) }).parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) throw new AppError(404, 'Invalid request');
    if (!user.twoFactorEnabled) throw new AppError(400, 'Two-factor authentication is not enabled');
    const requestAuthorizationVersion = Number(req.user.authorizationVersion ?? 1);

    const mailUnavailable = Boolean(portalFeatureUnavailableResponse('mail'));
    const useBackupCode = user.twoFactorMethod === 'email' && mailUnavailable;
    const verifiedCode = user.twoFactorMethod === 'email' && !useBackupCode
      ? await findVerifiedEmailCode(user.id, 'reauth', token)
      : null;
    const totpStep = user.twoFactorMethod === 'email' ? null : await verifyTotpStep(user, token);
    const backupCodeValid = useBackupCode
      ? await matchesBackupCode(token, user.twoFactorBackupCodes)
      : false;
    if (useBackupCode && !backupCodeValid) {
      throw new AppError(400, 'Invalid backup code');
    }
    if (user.twoFactorMethod === 'email' && !useBackupCode && !verifiedCode) {
      throw new AppError(400, 'Invalid or expired verification code');
    }
    if (user.twoFactorMethod !== 'email' && totpStep === null) {
      throw new AppError(400, 'Invalid or already-used verification code');
    }

    await withAuthorizationArtifactAdmission(async (tx) => {
      if (verifiedCode) {
        const consumed = await tx.emailVerificationCode.updateMany({
          where: { id: verifiedCode.id, userId: user.id, purpose: 'reauth', usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
        if (consumed.count !== 1) throw new AppError(409, 'Verification code was already used');
      }

      const disabled = await tx.user.updateMany({
        where: {
          ...authorizationUserSnapshotCas(user),
          authorizationVersion: requestAuthorizationVersion,
          passwordHash: user.passwordHash,
          twoFactorEnabled: true,
          twoFactorMethod: user.twoFactorMethod,
          twoFactorSecret: user.twoFactorSecret,
          twoFactorBackupCodes: user.twoFactorBackupCodes,
          ...(totpStep === null
            ? { twoFactorLastUsedStep: user.twoFactorLastUsedStep }
            : {}),
          ...(totpStep === null ? {} : {
            OR: [
              { twoFactorLastUsedStep: null },
              { twoFactorLastUsedStep: { lt: totpStep } },
            ],
          }),
        },
        data: {
          twoFactorEnabled: false,
          twoFactorSecret: null,
          twoFactorBackupCodes: null,
          twoFactorMethod: null,
          twoFactorLastUsedStep: null,
        },
      });
      if (disabled.count !== 1) throw new AppError(409, 'Two-factor state changed; authenticate again');
      await tx.emailVerificationCode.deleteMany({ where: { userId: user.id } });
      if (useBackupCode) {
        await tx.twoFactorChallenge.deleteMany({ where: { userId: user.id } });
      }
    });

    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: '2FA_DISABLED',
        resource: 'auth',
        severity: 'WARNING',
        translatedMessage: 'Two-factor authentication disabled',
        metadata: {
          verifiedVia: useBackupCode
            ? 'backup_code'
            : user.twoFactorMethod === 'email'
              ? 'email_code'
              : 'totp',
        },
      },
    }).catch(() => {});

    // Send 2FA disabled warning email (non-blocking)
    sendTwoFactorDisabledEmail({ email: user.email, username: user.username }).catch(() => {});

    res.json({ success: true, message: 'Two-factor authentication has been disabled' });
  } catch (error) {
    if (respondAuthorizationArtifactAdmissionConflict(res, error)) return;
    next(error);
  }
});

/**
 * POST /api/auth/2fa/recover-email
 *
 * Last-resort migration for an account holder who has legacy Email Code 2FA,
 * no backup codes, and a private Portal origin where mail cannot operate. This is intentionally
 * a last-resort password-only downgrade: the pending challenge, repeated
 * password, and typed phrase provide bounded intent/replay friction, not an
 * independent authentication factor.
 *
 * This endpoint invalidates every existing session and issues no replacement.
 */
router.post('/2fa/recover-email', twoFactorEmailRecoveryIpLimiter, twoFactorEmailRecoveryLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const capabilities = getPortalFeatureCapabilities();
    if (
      capabilities.mail.available
      || (capabilities.originMode !== 'tailnet' && capabilities.originMode !== 'local')
    ) {
      res.status(409).json({
        error: 'Email Code recovery is only available when Portal mail is unavailable.',
        code: 'EMAIL_2FA_RECOVERY_NOT_AVAILABLE',
        retryable: false,
      });
      return;
    }
    if (!privateRecoveryRequestMatchesConfiguredOrigin(req)) {
      throw new AppError(403, 'Recovery must be completed through this Portal private origin.');
    }

    const { pendingToken, currentPassword } = z.object({
      pendingToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid verification session'),
      currentPassword: z.string().min(1).max(1024),
      confirmation: z.literal(EMAIL_2FA_RECOVERY_CONFIRMATION),
    }).strict().parse(req.body);

    const pending = await verify2FAPendingToken(pendingToken);
    if (!pending) {
      throw new AppError(401, 'Invalid or expired verification session. Please sign in again.');
    }

    const user = pending.user;
    if (
      !user.twoFactorEnabled
      || user.twoFactorMethod !== 'email'
      || !canAccessPortal((user as any).accountStatus, user.isActive)
    ) {
      throw new AppError(401, 'Recovery is unavailable or the verification session is invalid');
    }
    if (!await comparePassword(currentPassword, user.passwordHash)) {
      throw new AppError(401, 'Recovery is unavailable or the verification session is invalid');
    }
    if (hasStoredBackupCodes(user.twoFactorBackupCodes)) {
      throw new AppError(409, 'A backup code is still available. Use it to finish signing in.');
    }

    const tracking = extractTrackingMetadata(req);
    await projectAuthorizationTransitionCoordinator.recoverEmailTwoFactor({
      targetUserId: user.id,
      challengeId: pending.id,
      challengeTokenHash: pending.tokenHash,
      expectedPasswordHash: user.passwordHash,
      expectedBackupCodes: user.twoFactorBackupCodes,
      ipAddress: tracking.ip,
      userAgent: req.get('user-agent') || null,
    });
    clearAuthCookies(req, res);

    res.json({
      success: true,
      code: 'EMAIL_2FA_RECOVERED',
      requiresFreshLogin: true,
      message: 'Email Code 2FA was disabled and all sessions were signed out. Sign in again, then enable Authenticator App 2FA.',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/2fa/validate
 * Validate 2FA code during login flow. Accepts pendingToken + TOTP or backup code.
 * Unauthenticated but rate-limited.
 */
router.post('/2fa/validate', twoFactorValidateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { pendingToken, token } = z.object({
      pendingToken: z.string(),
      token: z.string().min(6).max(8),
    }).parse(req.body);

    const meta = extractTrackingMetadata(req);

    // Verify the pending token
    const pending = await verify2FAPendingToken(pendingToken);
    if (!pending) {
      throw new AppError(401, 'Invalid or expired verification session. Please log in again.');
    }

    const user = pending.user;
    if (!user.twoFactorEnabled || !canAccessPortal((user as any).accountStatus, user.isActive)) {
      throw new AppError(401, 'Invalid verification session');
    }

    let validatedViaBackupCode = false;
    const verifiedEmailCode = user.twoFactorMethod === 'email'
      ? await findVerifiedEmailCode(user.id, `login:${pending.id}`, token)
      : null;
    const totpStep = user.twoFactorMethod === 'email' ? null : await verifyTotpStep(user, token);
    const primaryValid = Boolean(verifiedEmailCode) || totpStep !== null;
    let backupCodesAfter: string | null = null;

    if (!primaryValid) {
      // Try backup codes as fallback (works for both methods)
      if (user.twoFactorBackupCodes) {
        const hashedCodes: string[] = JSON.parse(user.twoFactorBackupCodes);
        let matchIndex = -1;

        for (let i = 0; i < hashedCodes.length; i++) {
          const isMatch = await comparePassword(token, hashedCodes[i]);
          if (isMatch) {
            matchIndex = i;
            break;
          }
        }

        if (matchIndex >= 0) {
          validatedViaBackupCode = true;
          hashedCodes.splice(matchIndex, 1);
          backupCodesAfter = JSON.stringify(hashedCodes);
        } else {
          throw new AppError(401, 'Invalid verification code');
        }
      } else {
        throw new AppError(401, 'Invalid verification code');
      }
    }

    const sessionId = crypto.randomUUID();
    const accessToken = generateAccessToken({
      userId: user.id,
      sessionId,
      email: user.email,
      role: user.role,
      accountStatus: (user as any).accountStatus,
      authorizationVersion: Number((user as any).authorizationVersion ?? 1),
    });
    const refreshToken = generateRefreshToken({ userId: user.id, sessionId });
    const refreshTokenHash = digestAuthToken('refresh', refreshToken);
    const sessionExpiresAt = new Date(Date.now() + (await getSessionDurationHours()) * 60 * 60 * 1000);

    // The challenge, second-factor proof, replay state, and new session commit
    // together. Any racing replay loses a compare-and-swap and rolls back.
    await withAuthorizationArtifactAdmission(async (tx) => {
      const challengeConsumed = await tx.twoFactorChallenge.updateMany({
        where: {
          id: pending.id,
          tokenHash: pending.tokenHash,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (challengeConsumed.count !== 1) throw new AppError(401, 'Verification session was already used');

      if (verifiedEmailCode) {
        const codeConsumed = await tx.emailVerificationCode.updateMany({
          where: {
            id: verifiedEmailCode.id,
            userId: user.id,
            purpose: `login:${pending.id}`,
            usedAt: null,
            expiresAt: { gt: new Date() },
          },
          data: { usedAt: new Date() },
        });
        if (codeConsumed.count !== 1) throw new AppError(401, 'Verification code was already used');
      }

      const userUpdated = await tx.user.updateMany({
        where: {
          ...authorizationUserSnapshotCas(user),
          passwordHash: user.passwordHash,
          twoFactorEnabled: true,
          twoFactorMethod: user.twoFactorMethod,
          twoFactorSecret: user.twoFactorSecret,
          twoFactorBackupCodes: user.twoFactorBackupCodes,
          ...(totpStep === null
            ? { twoFactorLastUsedStep: user.twoFactorLastUsedStep }
            : {}),
          ...(totpStep === null ? {} : {
            OR: [
              { twoFactorLastUsedStep: null },
              { twoFactorLastUsedStep: { lt: totpStep } },
            ],
          }),
        },
        data: {
          lastLoginAt: new Date(),
          ...(totpStep === null ? {} : { twoFactorLastUsedStep: totpStep }),
          ...(backupCodesAfter === null ? {} : { twoFactorBackupCodes: backupCodesAfter }),
        },
      });
      if (userUpdated.count !== 1) throw new AppError(401, 'Verification code was already used');

      await tx.session.create({
        data: {
          id: sessionId,
          userId: user.id,
          refreshTokenHash,
          ipAddress: meta.ip,
          userAgent: meta.rawUserAgent,
          expiresAt: sessionExpiresAt,
        },
      });
    });

    // Log success
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: 'LOGIN',
        resource: 'auth',
        severity: 'INFO',
        ipAddress: meta.ip,
        userAgent: meta.rawUserAgent,
        translatedMessage: formatLoginMessage(user.email, meta, true, validatedViaBackupCode ? '2FA via backup code' : '2FA verified'),
        metadata: {
          email: user.email, ip: meta.ip, geo: meta.geo, device: meta.device,
          twoFactor: true, backupCodeUsed: validatedViaBackupCode,
        },
      },
    }).catch(() => {});

    // Send login alert if new IP
    try {
      const recentSessions = await prisma.session.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { ipAddress: true },
      });
      const knownIPs = recentSessions.map(s => s.ipAddress).filter(Boolean);
      const priorSessions = knownIPs.filter(ip => ip === meta.ip);
      if (priorSessions.length <= 1) {
        sendLoginAlertEmail(
          { email: user.email, username: user.username },
          { ip: meta.ip, geo: meta.geo?.summary || '', device: meta.device?.summary || '', timestamp: new Date() }
        ).catch(() => {});
      }
    } catch {}

    await applyAuthCookies(req, res, accessToken, refreshToken);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        accountStatus: (user as any).accountStatus,
        sandboxEnabled: user.sandboxEnabled,
        authorizationVersion: Number((user as any).authorizationVersion ?? 1),
      },
    });
  } catch (error) {
    if (respondAuthorizationArtifactAdmissionConflict(res, error)) return;
    next(error);
  }
});

/**
 * GET /api/auth/2fa/status
 * Get current 2FA status for the authenticated user.
 */
router.get('/2fa/status', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new AppError(401, 'Not authenticated');

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { twoFactorEnabled: true, twoFactorBackupCodes: true, twoFactorMethod: true },
    });
    if (!user) throw new AppError(404, 'Invalid request');

    let backupCodesRemaining = 0;
    if (user.twoFactorBackupCodes) {
      try {
        backupCodesRemaining = JSON.parse(user.twoFactorBackupCodes).length;
      } catch {}
    }

    res.json({
      enabled: user.twoFactorEnabled,
      method: user.twoFactorMethod || null,
      backupCodesRemaining,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/2fa/regenerate-backup-codes
 * Regenerate backup codes. Requires current TOTP code.
 */
router.post('/2fa/regenerate-backup-codes', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new AppError(401, 'Not authenticated');
    const requestAuthorizationVersion = Number(req.user.authorizationVersion ?? 1);
    const { token } = z.object({ token: z.string().min(6).max(6) }).parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) throw new AppError(404, 'Invalid request');
    if (!user.twoFactorEnabled) {
      throw new AppError(400, 'Two-factor authentication is not enabled');
    }
    if (user.twoFactorMethod === 'email') {
      throw new AppError(
        400,
        'Backup codes can only be regenerated with Authenticator App 2FA. Switch from Email Code to Authenticator App first.',
      );
    }
    if (!user.twoFactorSecret) throw new AppError(400, 'Authenticator App 2FA is not configured');

    const totpStep = await verifyTotpStep(user, token);
    if (totpStep === null) throw new AppError(400, 'Invalid or already-used verification code');

    const plainBackupCodes = generateBackupCodes();
    const hashedCodes = await Promise.all(plainBackupCodes.map(code => hashPassword(code)));

    const updated = await withAuthorizationArtifactAdmission((tx) => (
      tx.user.updateMany({
        where: {
          ...authorizationUserSnapshotCas(user),
          authorizationVersion: requestAuthorizationVersion,
          passwordHash: user.passwordHash,
          twoFactorEnabled: true,
          twoFactorMethod: user.twoFactorMethod,
          twoFactorSecret: user.twoFactorSecret,
          twoFactorBackupCodes: user.twoFactorBackupCodes,
          OR: [
            { twoFactorLastUsedStep: null },
            { twoFactorLastUsedStep: { lt: totpStep } },
          ],
        },
        data: {
          twoFactorBackupCodes: JSON.stringify(hashedCodes),
          twoFactorLastUsedStep: totpStep,
        },
      })
    ));
    if (updated.count !== 1) throw new AppError(409, 'Verification code was already used');

    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: '2FA_BACKUP_CODES_REGENERATED',
        resource: 'auth',
        severity: 'INFO',
        translatedMessage: 'Two-factor backup codes regenerated',
      },
    }).catch(() => {});

    res.json({ backupCodes: plainBackupCodes });
  } catch (error) {
    if (respondAuthorizationArtifactAdmissionConflict(res, error)) return;
    next(error);
  }
});

export default router;
