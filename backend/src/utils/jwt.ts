import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config/env';

export interface JwtPayload {
  userId: string;
  /** Stable durable Session identity. Present on tokens issued by 4.0.17+. */
  sessionId?: string;
  email: string;
  role: string;
  accountStatus?: string;
  sandboxEnabled?: boolean;
  authorizationVersion?: number;
  /** Standard JWT expiry, in seconds since the Unix epoch. */
  exp?: number;
  /** Standard JWT issuance time, in seconds since the Unix epoch. */
  iat?: number;
}

export interface RefreshTokenPayload {
  userId: string;
  /** Stable across refresh-token rotation for one durable browser session. */
  sessionId?: string;
}

export function generateAccessToken(payload: JwtPayload): string {
  const options: any = { expiresIn: config.jwtExpiration as any };
  return jwt.sign(payload, config.jwtSecret, options);
}

export function generateRefreshToken(payload: RefreshTokenPayload): string {
  const options: any = {
    expiresIn: config.jwtRefreshExpiration as any,
    jwtid: crypto.randomUUID(),
  };
  return jwt.sign(payload, config.jwtRefreshSecret, options);
}

export function verifyAccessToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as JwtPayload;
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload | null {
  try {
    return jwt.verify(token, config.jwtRefreshSecret) as RefreshTokenPayload;
  } catch {
    return null;
  }
}
