import { prisma } from '../config/database';
import type { JwtPayload } from './jwt';
import { isOwnerRole } from './authz';

let cachedAdminId: string | null = null;

async function getPrimaryAdminId(): Promise<string> {
  if (cachedAdminId) return cachedAdminId;
  const admin = await prisma.user.findFirst({
    where: { role: 'OWNER' as any, isActive: true, accountStatus: 'ACTIVE' } as any,
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!admin) {
    throw new Error('No active owner user found');
  }
  cachedAdminId = admin.id;
  return admin.id;
}

export async function getWorkspaceOwnerId(user: JwtPayload): Promise<string> {
  if (isOwnerRole(user.role)) return user.userId;
  if (user.sandboxEnabled) return user.userId;
  return getPrimaryAdminId();
}

export function shouldIsolateUser(user: JwtPayload): boolean {
  return !isOwnerRole(user.role) && !!user.sandboxEnabled;
}
