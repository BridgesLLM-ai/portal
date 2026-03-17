import type { Response } from 'express';
import { config } from '../config/env';

export function getAuthCookieOptions(maxAge?: number) {
  // Only set Secure flag when actually serving over HTTPS.
  // On plain HTTP (fresh install before domain/TLS setup), Secure cookies
  // are silently rejected by browsers → auth loop.
  const corsOrigin = process.env.CORS_ORIGIN || '';
  const secure = corsOrigin.startsWith('https');
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    ...(typeof maxAge === 'number' ? { maxAge } : {}),
  };
}

export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
  accessMaxAge: number,
  refreshMaxAge: number = accessMaxAge,
) {
  res.cookie('accessToken', accessToken, getAuthCookieOptions(accessMaxAge));
  res.cookie('refreshToken', refreshToken, getAuthCookieOptions(refreshMaxAge));
}
