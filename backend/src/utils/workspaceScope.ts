import { prisma } from '../config/database';
import type { JwtPayload } from './jwt';
import { isElevatedRole, isOwnerRole } from './authz';

async function getPrimaryAdminId(): Promise<string> {
  // Ownership can move while the process stays up. This lookup is reached
  // only for an unsandboxed elevated delegate, so prefer a current indexed
  // read over a process-lifetime cache that could route requests into the
  // former owner's workspace after a transfer.
  const admin = await prisma.user.findFirst({
    where: { role: 'OWNER' as any, isActive: true, accountStatus: 'ACTIVE' } as any,
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!admin) {
    throw new Error('No active owner user found');
  }
  return admin.id;
}

export async function getWorkspaceOwnerId(user: JwtPayload): Promise<string> {
  if (isOwnerRole(user.role)) return user.userId;

  // Customer/user accounts must never fall through into the owner's workspace.
  // Shared workspace access is an explicit elevated-role capability only.
  if (!isElevatedRole(user.role)) return user.userId;

  if (user.sandboxEnabled) return user.userId;
  return getPrimaryAdminId();
}

export function shouldIsolateUser(user: JwtPayload): boolean {
  return !isElevatedRole(user.role) || !!user.sandboxEnabled;
}
