export const OWNER_ROLE = 'OWNER' as const;
export const SUB_ADMIN_ROLE = 'SUB_ADMIN' as const;

export const ACTIVE_STATUS = 'ACTIVE' as const;
export const PENDING_STATUS = 'PENDING' as const;
export const DISABLED_STATUS = 'DISABLED' as const;
export const BANNED_STATUS = 'BANNED' as const;

export function isOwnerRole(role?: string | null): boolean {
  return role === OWNER_ROLE;
}

export function isSubAdminRole(role?: string | null): boolean {
  return role === SUB_ADMIN_ROLE;
}

export function isElevatedRole(role?: string | null): boolean {
  return isOwnerRole(role) || isSubAdminRole(role);
}

export function canAccessPortal(accountStatus?: string | null, isActive?: boolean | null): boolean {
  if (isActive === false) return false;
  return accountStatus === ACTIVE_STATUS;
}

export function canUseInteractivePortal(role?: string | null, accountStatus?: string | null, isActive?: boolean | null): boolean {
  if (!canAccessPortal(accountStatus, isActive)) return false;
  return role === OWNER_ROLE || role === SUB_ADMIN_ROLE || role === 'USER';
}

/**
 * The direct gateway proxy carries OpenClaw operator credentials and receives
 * gateway-wide events. It is therefore an elevated transport, unlike the
 * Portal WebSocket whose handlers enforce per-user session isolation.
 */
export function canUseDirectGateway(role?: string | null, accountStatus?: string | null, isActive?: boolean | null): boolean {
  return canAccessPortal(accountStatus, isActive) && isElevatedRole(role);
}

/**
 * Runtime deployments launch arbitrary project code inside the shared Remote
 * Desktop host session. Unlike static/full-stack deployments, this is an
 * intentional host-operator surface and must never be available to ordinary
 * approved users.
 */
export function canUseDesktopRuntimeDeployment(
  role?: string | null,
  accountStatus?: string | null,
  isActive?: boolean | null,
): boolean {
  return canAccessPortal(accountStatus, isActive) && isElevatedRole(role);
}

export function describeBlockedAccountStatus(accountStatus?: string | null): string {
  if (accountStatus === PENDING_STATUS) return 'Account pending approval. Contact an administrator.';
  if (accountStatus === BANNED_STATUS) return 'Account banned. Contact an administrator.';
  if (accountStatus === DISABLED_STATUS) return 'Account disabled. Contact an administrator.';
  return 'Account is no longer authorized';
}
