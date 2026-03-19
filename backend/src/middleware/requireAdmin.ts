import { Request, Response, NextFunction } from 'express';
import { isElevatedRole, isOwnerRole } from '../utils/authz';

/**
 * Middleware: require elevated admin role (OWNER or SUB_ADMIN).
 * Must be applied after authenticateToken (req.user must exist).
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !isElevatedRole(req.user.role)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

/**
 * Middleware: require top-level owner role.
 */
export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !isOwnerRole(req.user.role)) {
    res.status(403).json({ error: 'Owner access required' });
    return;
  }
  next();
}
