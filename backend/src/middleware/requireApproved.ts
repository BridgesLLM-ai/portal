import { Request, Response, NextFunction } from 'express';
import { canUseInteractivePortal } from '../utils/authz';

/**
 * Middleware: require user to be in an active/usable account state.
 * Rejects pending/disabled/banned users and VIEWER role.
 * Must be applied after authenticateToken (req.user must exist).
 */
export function requireApproved(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (canUseInteractivePortal(req.user.role, req.user.accountStatus, true)) {
    return next();
  }

  if (req.user.accountStatus !== 'ACTIVE') {
    res.status(403).json({ error: 'Account pending approval' });
    return;
  }

  res.status(403).json({ error: 'Account is not permitted for this action' });
}
