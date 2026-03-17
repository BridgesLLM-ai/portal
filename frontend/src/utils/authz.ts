export type PortalRole = 'OWNER' | 'SUB_ADMIN' | 'USER' | 'VIEWER' | string | undefined | null;

export function isOwnerRole(role: PortalRole): boolean {
  return role === 'OWNER';
}

export function isElevatedRole(role: PortalRole): boolean {
  return role === 'OWNER' || role === 'SUB_ADMIN';
}

type RoleCarrier = { role?: PortalRole } | null | undefined;

export function isOwner(user?: RoleCarrier): boolean {
  return isOwnerRole(user?.role);
}

export function isElevated(user?: RoleCarrier): boolean {
  return isElevatedRole(user?.role);
}

export function isInteractiveRole(role: PortalRole): boolean {
  return role === 'OWNER' || role === 'SUB_ADMIN' || role === 'USER';
}

export function canUseInteractivePortal(user?: RoleCarrier): boolean {
  return isInteractiveRole(user?.role);
}
