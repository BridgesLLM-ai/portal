import type { Request, Response } from 'express';

function requestIsSecure(req?: Request): boolean {
  if (!req) return false;
  if ((req as any).secure) return true;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  return forwardedProto.includes('https');
}

export function getAuthCookieOptions(req?: Request, maxAge?: number) {
  // Derive Secure from the actual request/proxy chain, not a static env var.
  // This keeps cookies correct for domain HTTPS, reverse proxies, and plain-IP HTTP installs.
  const secure = requestIsSecure(req);
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    ...(typeof maxAge === 'number' ? { maxAge } : {}),
  };
}

export function setAuthCookies(
  req: Request,
  res: Response,
  accessToken: string,
  refreshToken: string,
  accessMaxAge: number,
  refreshMaxAge: number = accessMaxAge,
) {
  res.cookie('accessToken', accessToken, getAuthCookieOptions(req, accessMaxAge));
  res.cookie('refreshToken', refreshToken, getAuthCookieOptions(req, refreshMaxAge));
}
