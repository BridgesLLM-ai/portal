import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import rateLimit from 'express-rate-limit';
import { prisma } from '../config/database';
import { hashPassword, comparePassword, validatePasswordStrength } from '../utils/password';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { authenticateToken } from '../middleware/auth';
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
import { getAuthCookieOptions, setAuthCookies } from '../utils/authCookies';
import { generateSecret as otpGenerateSecret, generateURI as otpGenerateURI, verify as otpVerify, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib';
import * as QRCode from 'qrcode';

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
  skip: (req) => process.env.NODE_ENV === 'development',
});

// Stricter rate limiting for forgot-password (3 attempts per 15 minutes per IP)
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: 'Too many password reset requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV === 'development',
});

// Stricter rate limiting for 2FA validate (5 attempts per 15 min per IP)
const twoFactorValidateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many two-factor authentication attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV === 'development',
});

// Rate limiting for 2FA email send (3 per 15 min per IP)
const twoFactorEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: 'Too many verification code requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV === 'development',
});

/**
 * Generate a 6-digit email verification code, store hashed, send to user.
 * Cleans up old codes for the user first.
 */
async function generateAndSendEmailCode(userId: string, userEmail: string): Promise<void> {
  // Clean up old codes for this user (older than 1 hour or already used)
  await prisma.emailVerificationCode.deleteMany({
    where: {
      userId,
      OR: [
        { createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
        { usedAt: { not: null } },
      ],
    },
  });

  // Generate 6-digit code
  const code = crypto.randomInt(100000, 999999).toString();

  // Hash with bcrypt and store
  const codeHash = await hashPassword(code);
  await prisma.emailVerificationCode.create({
    data: {
      userId,
      code: codeHash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    },
  });

  // Send email
  await sendTwoFactorCodeEmail({ email: userEmail }, code);
}

// TOTP window: ±1 step (30 second tolerance) — passed to each verify call

/**
 * Generate a short-lived 2FA pending token (5 min expiry).
 * Encodes the userId so the /2fa/validate endpoint can identify the user
 * without exposing raw userId (prevents enumeration).
 */
function generate2FAPendingToken(userId: string): string {
  return jwt.sign({ userId, purpose: '2fa_pending' }, config.jwtSecret, { expiresIn: '5m' });
}

function verify2FAPendingToken(token: string): { userId: string } | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as any;
    if (payload.purpose !== '2fa_pending') return null;
    return { userId: payload.userId };
  } catch {
    return null;
  }
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

// Validation schemas
const signupSchema = z.object({
  email: z.string().email('Invalid email'),
  username: z.string().min(3, 'Username must be at least 3 characters').max(50),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string(),
});

const refreshSchema = z.object({
  refreshToken: z.string().optional(),
});

async function applyAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  const maxAge = (await getSessionDurationHours()) * 60 * 60 * 1000;
  setAuthCookies(res, accessToken, refreshToken, maxAge);
}


async function getSettingValue(key: string): Promise<string | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

async function getRegistrationMode(): Promise<'open' | 'approval' | 'closed'> {
  const scoped = await getSettingValue('security.registrationMode');
  const legacy = await getSettingValue('registrationMode');
  const mode = (scoped || legacy || 'closed').toLowerCase();
  if (mode === 'open' || mode === 'approval' || mode === 'closed') return mode;
  return 'closed';
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
    const { email, username, password } = signupSchema.parse(req.body);
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
      const pendingToken = generate2FAPendingToken(user.id);

      // If email 2FA, auto-send the code so the user doesn't have to click separately
      if (user.twoFactorMethod === 'email') {
        try {
          await generateAndSendEmailCode(user.id, user.email);
        } catch (err) {
          console.error('[auth] Failed to auto-send 2FA email code:', err);
        }
      }

      res.json({ requiresTwoFactor: true, pendingToken, method: user.twoFactorMethod || 'totp' });
      return;
    }

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Generate tokens
    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      accountStatus: (user as any).accountStatus,
    });
    const refreshToken = generateRefreshToken({ userId: user.id });
    const refreshTokenHash = await hashPassword(refreshToken);

    // Store session with tracking data
    await prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash,
        ipAddress: meta.ip,
        userAgent: meta.rawUserAgent,
        expiresAt: new Date(Date.now() + (await getSessionDurationHours()) * 60 * 60 * 1000),
      },
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

    await applyAuthCookies(res, accessToken, refreshToken);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        accountStatus: (user as any).accountStatus,
        sandboxEnabled: user.sandboxEnabled,
      },
    });
  } catch (error) {
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
    if (!refreshToken) throw new AppError(401, 'Refresh token required');
    const payload = verifyRefreshToken(refreshToken);
    if (!payload) throw new AppError(401, 'Invalid refresh token');

    const sessions = await prisma.session.findMany({
      where: { userId: payload.userId },
      orderBy: { createdAt: 'desc' },
    });
    if (!sessions.length) throw new AppError(401, 'Session not found');

    let session: any = null;
    for (const candidate of sessions) {
      const tokenMatch = await comparePassword(refreshToken, candidate.refreshTokenHash);
      if (tokenMatch) {
        session = candidate;
        break;
      }
    }

    if (!session) throw new AppError(401, 'Invalid refresh token');
    if (session.expiresAt < new Date()) throw new AppError(401, 'Refresh token expired');

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) throw new AppError(401, 'User not found');
    if (!canAccessPortal((user as any).accountStatus, user.isActive)) {
      throw new AppError(403, describeBlockedAccountStatus((user as any).accountStatus));
    }

    const newAccessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      accountStatus: (user as any).accountStatus,
    });

    await applyAuthCookies(res, newAccessToken, refreshToken);

    res.json({ accessToken: newAccessToken });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new AppError(401, 'User not authenticated');

    const meta = extractTrackingMetadata(req);

    await prisma.activityLog.create({
      data: {
        userId: req.user.userId,
        action: 'LOGOUT',
        resource: 'auth',
        severity: 'INFO',
        ipAddress: meta.ip,
        userAgent: meta.rawUserAgent,
        translatedMessage: 'Signed out of the portal',
        metadata: { ip: meta.ip, geo: meta.geo, device: meta.device },
      },
    }).catch(() => {});

    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      const sessions = await prisma.session.findMany({ where: { userId: req.user.userId } });
      let matchedSessionId: string | null = null;
      for (const session of sessions) {
        const tokenMatch = await comparePassword(refreshToken, session.refreshTokenHash);
        if (tokenMatch) {
          matchedSessionId = session.id;
          break;
        }
      }

      if (matchedSessionId) {
        await prisma.session.delete({ where: { id: matchedSessionId } });
      } else {
        await prisma.session.deleteMany({ where: { userId: req.user.userId } });
      }
    } else {
      await prisma.session.deleteMany({ where: { userId: req.user.userId } });
    }

    const clearCookieOptions = getAuthCookieOptions();
    res.clearCookie('accessToken', clearCookieOptions);
    res.clearCookie('refreshToken', clearCookieOptions);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    next(error);
  }
});


// ── Forgot Password ─────────────────────────────────────────────────────

const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email'),
});

/**
 * POST /api/auth/forgot-password
 * Request a password reset email. Always returns success (don't leak email existence).
 */
router.post('/forgot-password', forgotPasswordLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
    const meta = extractTrackingMetadata(req);

    // Always respond with the same message regardless of whether user exists
    const successMessage = 'If an account exists with that email, you will receive a password reset link.';

    const user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      // Delete any existing unused tokens for this user
      await prisma.passwordResetToken.deleteMany({
        where: { userId: user.id, usedAt: null },
      });

      // Generate raw token and hash it for storage
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = await hashPassword(rawToken);

      // Store hashed token
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          token: tokenHash,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
        },
      });

      // Send reset email via Stalwart JMAP
      const resetUrl = buildPortalUrl(`/reset-password?token=${encodeURIComponent(rawToken)}`, req);
      await sendPasswordResetEmail({ email: user.email }, resetUrl);

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

    // Find all non-expired, unused tokens and compare hashes
    const candidates = await prisma.passwordResetToken.findMany({
      where: {
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });

    let matchedToken: typeof candidates[0] | null = null;
    for (const candidate of candidates) {
      const isMatch = await comparePassword(token, candidate.token);
      if (isMatch) {
        matchedToken = candidate;
        break;
      }
    }

    if (!matchedToken) {
      throw new AppError(400, 'Invalid or expired reset link. Please request a new password reset.');
    }

    // Update user's password
    const newHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: matchedToken.userId },
      data: { passwordHash: newHash },
    });

    // Mark token as used
    await prisma.passwordResetToken.update({
      where: { id: matchedToken.id },
      data: { usedAt: new Date() },
    });

    // Invalidate all existing sessions for this user
    await prisma.session.deleteMany({
      where: { userId: matchedToken.userId },
    });

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
    next(error);
  }
});

// ── Registration ────────────────────────────────────────────────────────

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  email: z.string().email('Invalid email'),
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

    // Get registration mode from settings
    const mode = await getRegistrationMode();

    if (mode === 'closed') {
      // Check if we should silently block the IP
      const blockOnClosed = await getSettingValue('security.blockClosedRegistration');
      const shouldBlock = blockOnClosed === null ? true : blockOnClosed === 'true';

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
      const user = await prisma.user.create({
        data: {
          email,
          username: name.toLowerCase().replace(/[^a-z0-9_-]/g, '') || email.split('@')[0],
          passwordHash,
          role: 'USER',
          accountStatus: ACTIVE_STATUS,
          isActive: true,
          sandboxEnabled: await getSandboxDefaultEnabled(),
        },
      } as any);

      const accessToken = generateAccessToken({
        userId: user.id,
        email: user.email,
        role: user.role,
        accountStatus: (user as any).accountStatus,
      });
      const refreshToken = generateRefreshToken({ userId: user.id });
      const refreshTokenHash = await hashPassword(refreshToken);

      await prisma.session.create({
        data: {
          userId: user.id,
          refreshTokenHash,
          ipAddress: req.ip || 'unknown',
          userAgent: req.headers['user-agent'] || 'unknown',
          expiresAt: new Date(Date.now() + (await getSessionDurationHours()) * 60 * 60 * 1000),
        },
      });

      // Provision personal mailbox (non-blocking, but immediate if possible)
      provisionUserMailbox(user.username, user.id, { makePrimary: true }).catch((err) => {
        console.error('[auth] Failed to auto-provision mailbox on open registration:', err);
      });

      // Send welcome email via Stalwart (non-blocking)
      sendWelcomeEmail({ email: user.email, username: user.username }).catch(() => {});

      await applyAuthCookies(res, accessToken, refreshToken);

      res.json({
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          role: user.role,
          accountStatus: (user as any).accountStatus,
          sandboxEnabled: user.sandboxEnabled,
        },
      });
    } else if (mode === 'approval') {
      // Create registration request
      await prisma.registrationRequest.create({
        data: {
          email,
          name,
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
    next(error);
  }
});

// ── Profile ─────────────────────────────────────────────────────────────

/**
 * GET /api/auth/me
 * Get current user profile (includes role and sandboxEnabled)
 */
router.get('/me', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
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
});

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
  username: z.string().min(2).max(100).optional(),
  email: z.string().email().optional(),
});

/**
 * PUT /api/auth/me
 * Update current user profile (username, email)
 */
router.put('/me', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new AppError(401, 'Not authenticated');
    const data = updateProfileSchema.parse(req.body);

    // Check email uniqueness if changing
    if (data.email) {
      const existing = await prisma.user.findUnique({ where: { email: data.email } });
      if (existing && existing.id !== req.user.userId) {
        throw new AppError(409, 'Email already in use');
      }
    }

    // Get current user data before update (for mailbox provisioning)
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { username: true, mailPassword: true },
    });

    const user = await prisma.user.update({
      where: { id: req.user.userId },
      data,
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        accountStatus: true,
        sandboxEnabled: true,
      },
    } as any);

    // Provision mailbox if username changed, but keep prior mailboxes accessible
    if (data.username && currentUser && data.username !== currentUser.username) {
      try {
        await provisionUserMailbox(data.username, req.user.userId, { makePrimary: true });
        console.log(`[auth] Provisioned mailbox for user ${data.username}`);
      } catch (err) {
        // Mailbox provisioning failure should NOT fail the profile update
        console.error('[auth] Mailbox provisioning failed (non-fatal):', err);
      }
    }

    res.json(user);
  } catch (error) {
    next(error);
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
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) throw new AppError(404, 'Invalid request');

    const valid = await comparePassword(currentPassword, user.passwordHash);
    if (!valid) throw new AppError(401, 'Current password is incorrect');

    const newHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: req.user.userId },
      data: { passwordHash: newHash },
    });

    // Send password changed confirmation email (non-blocking)
    sendPasswordChangedEmail({ email: user.email, username: user.username }).catch(() => {});

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
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
    const { pendingToken } = z.object({ pendingToken: z.string() }).parse(req.body);

    const pending = verify2FAPendingToken(pendingToken);
    if (!pending) {
      throw new AppError(401, 'Invalid or expired verification session. Please log in again.');
    }

    const user = await prisma.user.findUnique({ where: { id: pending.userId } });
    if (!user || !user.twoFactorEnabled) {
      throw new AppError(401, 'Invalid verification session');
    }

    await generateAndSendEmailCode(user.id, user.email);

    res.json({ message: 'Verification code sent' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/2fa/setup
 * Generate TOTP secret and QR code for setup, or initiate email 2FA setup.
 * Authenticated only.
 */
router.post('/2fa/setup', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new AppError(401, 'Not authenticated');

    const { method } = z.object({ method: z.enum(['totp', 'email']).default('totp') }).parse(req.body || {});

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) throw new AppError(404, 'Invalid request');

    if (user.twoFactorEnabled) {
      throw new AppError(400, 'Two-factor authentication is already enabled');
    }

    if (method === 'email') {
      // Email-based 2FA setup: send a verification code to confirm
      await generateAndSendEmailCode(user.id, user.email);

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
    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorSecret: secret },
    });

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
    next(error);
  }
});

/**
 * POST /api/auth/2fa/verify-setup
 * Verify TOTP or email code during setup, enable 2FA, return backup codes.
 */
router.post('/2fa/verify-setup', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new AppError(401, 'Not authenticated');
    const { token, method } = z.object({
      token: z.string().min(6).max(6),
      method: z.enum(['totp', 'email']).default('totp'),
    }).parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) throw new AppError(404, 'Invalid request');
    if (user.twoFactorEnabled) throw new AppError(400, 'Two-factor authentication is already enabled');

    if (method === 'email') {
      // Validate email verification code
      const recentCode = await prisma.emailVerificationCode.findFirst({
        where: {
          userId: user.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!recentCode) {
        throw new AppError(400, 'No valid verification code found. Please request a new one.');
      }

      const codeMatch = await comparePassword(token, recentCode.code);
      if (!codeMatch) {
        throw new AppError(400, 'Invalid verification code. Please try again.');
      }

      // Mark code as used
      await prisma.emailVerificationCode.update({
        where: { id: recentCode.id },
        data: { usedAt: new Date() },
      });
    } else {
      // TOTP validation (existing flow)
      if (!user.twoFactorSecret) throw new AppError(400, 'No 2FA setup in progress. Call /2fa/setup first.');

      const otpResult = await otpVerify({ token, secret: user.twoFactorSecret, crypto: otpCrypto, base32: otpBase32, epochTolerance: 30 });
      const isValid = otpResult.valid;
      if (!isValid) {
        throw new AppError(400, 'Invalid verification code. Please try again.');
      }
    }

    // Generate backup codes
    const plainBackupCodes = generateBackupCodes();
    const hashedCodes = await Promise.all(plainBackupCodes.map(code => hashPassword(code)));

    // Enable 2FA with the chosen method
    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: true,
        twoFactorMethod: method,
        twoFactorBackupCodes: JSON.stringify(hashedCodes),
      },
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
    next(error);
  }
});

/**
 * POST /api/auth/2fa/send-email-authenticated
 * Send an email verification code for authenticated users (e.g., for disabling 2FA).
 * Rate-limited: 3 per 15 min per IP.
 */
router.post('/2fa/send-email-authenticated', authenticateToken, twoFactorEmailLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new AppError(401, 'Not authenticated');

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user || !user.twoFactorEnabled || user.twoFactorMethod !== 'email') {
      throw new AppError(400, 'Email 2FA is not enabled');
    }

    await generateAndSendEmailCode(user.id, user.email);
    res.json({ message: 'Verification code sent' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/2fa/disable
 * Disable 2FA. Requires current TOTP or email verification code.
 */
router.post('/2fa/disable', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw new AppError(401, 'Not authenticated');
    const { token } = z.object({ token: z.string().min(6).max(8) }).parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) throw new AppError(404, 'Invalid request');
    if (!user.twoFactorEnabled) throw new AppError(400, 'Two-factor authentication is not enabled');

    if (user.twoFactorMethod === 'email') {
      // Validate email verification code
      const recentCode = await prisma.emailVerificationCode.findFirst({
        where: {
          userId: user.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!recentCode) {
        throw new AppError(400, 'No valid verification code found. Please request a new one.');
      }

      const codeMatch = await comparePassword(token, recentCode.code);
      if (!codeMatch) {
        throw new AppError(400, 'Invalid verification code');
      }

      // Mark code as used
      await prisma.emailVerificationCode.update({
        where: { id: recentCode.id },
        data: { usedAt: new Date() },
      });
    } else {
      // TOTP validation
      if (!user.twoFactorSecret) throw new AppError(400, 'No 2FA secret found');

      const otpResult = await otpVerify({ token, secret: user.twoFactorSecret, crypto: otpCrypto, base32: otpBase32, epochTolerance: 30 });
      const isValid = otpResult.valid;
      if (!isValid) {
        throw new AppError(400, 'Invalid verification code');
      }
    }

    // Disable 2FA
    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorBackupCodes: null,
        twoFactorMethod: null,
      },
    });

    // Clean up any remaining email verification codes
    await prisma.emailVerificationCode.deleteMany({
      where: { userId: user.id },
    }).catch(() => {});

    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: '2FA_DISABLED',
        resource: 'auth',
        severity: 'WARNING',
        translatedMessage: 'Two-factor authentication disabled',
      },
    }).catch(() => {});

    // Send 2FA disabled warning email (non-blocking)
    sendTwoFactorDisabledEmail({ email: user.email, username: user.username }).catch(() => {});

    res.json({ success: true, message: 'Two-factor authentication has been disabled' });
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
    const pending = verify2FAPendingToken(pendingToken);
    if (!pending) {
      throw new AppError(401, 'Invalid or expired verification session. Please log in again.');
    }

    const user = await prisma.user.findUnique({ where: { id: pending.userId } });
    if (!user || !user.twoFactorEnabled) {
      throw new AppError(401, 'Invalid verification session');
    }

    let validatedViaBackupCode = false;
    let primaryValid = false;

    if (user.twoFactorMethod === 'email') {
      // Email 2FA: check the EmailVerificationCode table
      const recentCode = await prisma.emailVerificationCode.findFirst({
        where: {
          userId: user.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (recentCode) {
        const codeMatch = await comparePassword(token, recentCode.code);
        if (codeMatch) {
          primaryValid = true;
          // Mark code as used
          await prisma.emailVerificationCode.update({
            where: { id: recentCode.id },
            data: { usedAt: new Date() },
          });
        }
      }
    } else {
      // TOTP: existing flow
      if (!user.twoFactorSecret) {
        throw new AppError(401, 'Invalid verification session');
      }
      const otpResult = await otpVerify({ token, secret: user.twoFactorSecret, crypto: otpCrypto, base32: otpBase32, epochTolerance: 30 });
      primaryValid = otpResult.valid;
    }

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
          // Remove the used backup code (one-time use)
          hashedCodes.splice(matchIndex, 1);
          await prisma.user.update({
            where: { id: user.id },
            data: { twoFactorBackupCodes: JSON.stringify(hashedCodes) },
          });
        } else {
          throw new AppError(401, 'Invalid verification code');
        }
      } else {
        throw new AppError(401, 'Invalid verification code');
      }
    }

    // 2FA validated — complete login flow
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      accountStatus: (user as any).accountStatus,
    });
    const refreshToken = generateRefreshToken({ userId: user.id });
    const refreshTokenHash = await hashPassword(refreshToken);

    await prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash,
        ipAddress: meta.ip,
        userAgent: meta.rawUserAgent,
        expiresAt: new Date(Date.now() + (await getSessionDurationHours()) * 60 * 60 * 1000),
      },
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

    await applyAuthCookies(res, accessToken, refreshToken);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        accountStatus: (user as any).accountStatus,
        sandboxEnabled: user.sandboxEnabled,
      },
    });
  } catch (error) {
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
    const { token } = z.object({ token: z.string().min(6).max(6) }).parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) throw new AppError(404, 'Invalid request');
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new AppError(400, 'Two-factor authentication is not enabled');
    }

    const otpResult = await otpVerify({ token, secret: user.twoFactorSecret, crypto: otpCrypto, base32: otpBase32, epochTolerance: 30 });
    const isValid = otpResult.valid;
    if (!isValid) {
      throw new AppError(400, 'Invalid verification code');
    }

    const plainBackupCodes = generateBackupCodes();
    const hashedCodes = await Promise.all(plainBackupCodes.map(code => hashPassword(code)));

    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorBackupCodes: JSON.stringify(hashedCodes) },
    });

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
    next(error);
  }
});

export default router;
