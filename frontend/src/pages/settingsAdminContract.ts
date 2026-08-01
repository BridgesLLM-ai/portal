export type PortalSurfaceRole = 'OWNER' | 'SUB_ADMIN' | 'USER' | 'VIEWER' | string | null | undefined;

export type SettingsTabId =
  | 'general'
  | 'email'
  | 'security'
  | 'agents'
  | 'system'
  | 'ai-providers'
  | 'readiness'
  | 'backups'
  | 'profile';

export type AdminTabId = 'users' | 'maintenance' | 'pending';

export const SETTINGS_TAB_ACCESS: Record<SettingsTabId, 'all' | 'elevated' | 'owner'> = {
  general: 'owner',
  email: 'owner',
  security: 'owner',
  agents: 'owner',
  system: 'owner',
  'ai-providers': 'owner',
  readiness: 'elevated',
  backups: 'owner',
  profile: 'all',
};

export function settingsTabIdsForRole(role: PortalSurfaceRole): SettingsTabId[] {
  const owner = role === 'OWNER';
  const elevated = owner || role === 'SUB_ADMIN';
  return (Object.keys(SETTINGS_TAB_ACCESS) as SettingsTabId[]).filter((tab) => {
    const access = SETTINGS_TAB_ACCESS[tab];
    return access === 'all' || (access === 'elevated' && elevated) || (access === 'owner' && owner);
  });
}

export function resolveSettingsTab(role: PortalSurfaceRole, requested: string | null | undefined): SettingsTabId {
  const allowed = settingsTabIdsForRole(role);
  if (requested && allowed.includes(requested as SettingsTabId)) return requested as SettingsTabId;
  return role === 'OWNER' ? 'general' : role === 'SUB_ADMIN' ? 'readiness' : 'profile';
}

export function adminTabIdsForRole(role: PortalSurfaceRole): AdminTabId[] {
  return role === 'OWNER' ? ['users', 'maintenance', 'pending'] : ['users', 'maintenance'];
}

export function resolveAdminTab(role: PortalSurfaceRole, requested: string | null | undefined): AdminTabId {
  const allowed = adminTabIdsForRole(role);
  return requested && allowed.includes(requested as AdminTabId) ? requested as AdminTabId : 'users';
}

export function maintenanceActionNeedsOwner(action: { requiresOwner: boolean; changesSystem: boolean }): boolean {
  return action.requiresOwner || action.changesSystem;
}

export function isActiveMaintenanceJob(status: string | null | undefined): boolean {
  return status === 'running' || status === 'waiting';
}

export function shouldPollMaintenance(input: {
  pageVisible: boolean;
  ready?: boolean;
  refreshing?: boolean;
  retryAfterMs?: number | null;
  hasActiveJob: boolean;
}): boolean {
  if (!input.pageVisible) return false;
  return input.ready === false
    || input.refreshing === true
    || (input.retryAfterMs || 0) > 0
    || input.hasActiveJob;
}

export function maintenancePollDelayMs(input: {
  retryAfterMs?: number | null;
  hasActiveJob: boolean;
}): number {
  if ((input.retryAfterMs || 0) > 0) return Math.max(1_000, Math.min(60_000, input.retryAfterMs || 0));
  return input.hasActiveJob ? 2_500 : 3_000;
}

export function maintenanceRetryDelayLabel(retryAfterMs: number | null | undefined): string | null {
  if (!Number.isFinite(retryAfterMs) || (retryAfterMs || 0) <= 0) return null;
  const seconds = Math.max(1, Math.ceil((retryAfterMs || 0) / 1_000));
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

export function nextTabIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return null;
  const delta = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
  return (current + delta + count) % count;
}
