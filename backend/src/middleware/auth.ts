import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JwtPayload } from '../utils/jwt';
import { prisma } from '../config/database';
import { blockedIPs, extractIP } from '../utils/auth-tracking';
import { canAccessPortal, isElevatedRole } from '../utils/authz';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

const AUTH_LOG_DEDUPE_WINDOW_MS = 60_000;
const authFailureLogState = new Map<string, { lastLoggedAt: number; suppressedCount: number }>();

function logAuthFailure(kind: 'Missing token' | 'Invalid token', req: Request) {
  const ip = extractIP(req);
  const key = `${kind}:${ip}:${req.method}:${req.path}`;
  const now = Date.now();
  const current = authFailureLogState.get(key);

  if (!current || now - current.lastLoggedAt >= AUTH_LOG_DEDUPE_WINDOW_MS) {
    const suppressedSuffix = current?.suppressedCount
      ? ` (suppressed ${current.suppressedCount} duplicate${current.suppressedCount === 1 ? '' : 's'} in the last ${Math.round(AUTH_LOG_DEDUPE_WINDOW_MS / 1000)}s)`
      : '';
    console.warn(`[Auth] ${kind}: ${req.method} ${req.path} [ip=${ip}]${suppressedSuffix}`);
    authFailureLogState.set(key, { lastLoggedAt: now, suppressedCount: 0 });
    return;
  }

  current.suppressedCount += 1;
  authFailureLogState.set(key, current);
}

function getTokenFromRequest(req: Request): string | undefined {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];
  if (!token && req.cookies?.accessToken) {
    token = req.cookies.accessToken;
  }
  return token;
}

async function loadAuthorizedUser(payload: JwtPayload) {
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, role: true, accountStatus: true, isActive: true, sandboxEnabled: true },
  } as any);

  if (!user || !canAccessPortal((user as any).accountStatus, user.isActive)) {
    return null;
  }

  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    accountStatus: (user as any).accountStatus,
    sandboxEnabled: user.sandboxEnabled,
  } satisfies JwtPayload;
}

/**
 * Middleware to verify JWT token from Authorization header or cookie
 * Note: Query parameter auth removed for security (prevents token leakage in logs/history)
 */
export async function authenticateToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (blockedIPs.has(extractIP(req))) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  const token = getTokenFromRequest(req);

  if (!token) {
    logAuthFailure('Missing token', req);
    res.status(401).json({ error: 'Access token required' });
    return;
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    logAuthFailure('Invalid token', req);
    res.status(403).json({ error: 'Invalid or expired token' });
    return;
  }

  const authorizedUser = await loadAuthorizedUser(payload);
  if (!authorizedUser) {
    res.status(403).json({ error: 'Account is no longer authorized' });
    return;
  }

  req.user = authorizedUser;
  next();
}

/**
 * Middleware for browser-navigable routes (raw files, hosted apps).
 * If unauthenticated browser GET → 302 to login with redirect param.
 * If unauthenticated API call → 401 JSON as usual.
 */
export async function browserAuthRedirect(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'];
  const token = getTokenFromRequest(req);

  if (token) {
    const payload = verifyAccessToken(token);
    if (payload) {
      const authorizedUser = await loadAuthorizedUser(payload);
      if (authorizedUser) {
        req.user = authorizedUser;
        return next();
      }
    }
  }

  // Not authenticated — decide: redirect or 401
  const acceptsHtml = req.headers['accept']?.includes('text/html');
  const isGetOrHead = req.method === 'GET' || req.method === 'HEAD';
  const isBrowserRequest = isGetOrHead && (acceptsHtml || !authHeader);

  if (isBrowserRequest) {
    const originalUrl = req.originalUrl;
    const redirectParam = encodeURIComponent(originalUrl);
    res.redirect(302, `/login?redirect=${redirectParam}`);
    return;
  }

  res.status(401).json({ error: 'Access token required' });
}

/**
 * Middleware for browser-loaded subresources (JS/CSS/images/fonts/etc).
 * Requires portal auth but never redirects to HTML, preventing MIME/type breakage
 * while keeping hosted assets private.
 */
export async function browserAssetAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = getTokenFromRequest(req);

  if (!token) {
    res.status(401).send('Unauthorized');
    return;
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    res.status(403).send('Forbidden');
    return;
  }

  const authorizedUser = await loadAuthorizedUser(payload);
  if (!authorizedUser) {
    res.status(403).send('Forbidden');
    return;
  }

  req.user = authorizedUser;
  next();
}

/**
 * Middleware to verify admin role
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !isElevatedRole(req.user.role)) {
    res.status(403).json({ error: 'Admin role required' });
    return;
  }
  next();
}

/**
 * Optional authentication (doesn't fail if token is invalid)
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    const payload = verifyAccessToken(token);
    if (payload) {
      req.user = payload;
    }
  }

  next();
}
