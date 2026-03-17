import jwt from 'jsonwebtoken';
import { config } from '../config/env';

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  accountStatus?: string;
  sandboxEnabled?: boolean;
}

export function generateAccessToken(payload: JwtPayload): string {
  const options: any = { expiresIn: config.jwtExpiration as any };
  return jwt.sign(payload, config.jwtSecret, options);
}

export function generateRefreshToken(payload: { userId: string }): string {
  const options: any = { expiresIn: config.jwtRefreshExpiration as any };
  return jwt.sign(payload, config.jwtRefreshSecret, options);
}

export function verifyAccessToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as JwtPayload;
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): { userId: string } | null {
  try {
    return jwt.verify(token, config.jwtRefreshSecret) as { userId: string };
  } catch {
    return null;
  }
}
