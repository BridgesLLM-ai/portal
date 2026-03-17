import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';

const ALLOWED_PREFIXES = [
  '/api/setup',
  '/api/settings/public',
  '/health',
];

export async function requireSetupComplete(req: Request, res: Response, next: NextFunction): Promise<void> {
  const requestPath = req.originalUrl || req.path;

  if (ALLOWED_PREFIXES.some((prefix) => requestPath.startsWith(prefix))) {
    return next();
  }

  try {
    const ownerCount = await prisma.user.count({ where: { role: 'OWNER' as any } });
    if (ownerCount === 0) {
      res.status(503).json({
        needsSetup: true,
        error: 'Initial setup is required before this endpoint can be used.',
      });
      return;
    }

    next();
  } catch (error) {
    console.error('[requireSetupComplete] DB check failed:', error);
    next();
  }
}
