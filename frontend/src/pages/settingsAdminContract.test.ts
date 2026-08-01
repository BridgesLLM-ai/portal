import { describe, expect, it } from 'vitest';
import {
  adminTabIdsForRole,
  isActiveMaintenanceJob,
  maintenanceActionNeedsOwner,
  maintenancePollDelayMs,
  maintenanceRetryDelayLabel,
  nextTabIndex,
  resolveAdminTab,
  resolveSettingsTab,
  settingsTabIdsForRole,
  shouldPollMaintenance,
} from './settingsAdminContract';

describe('Settings and Admin surface contract', () => {
  it('keeps Portal configuration owner-only while exposing useful read-only and personal tabs', () => {
    expect(settingsTabIdsForRole('OWNER')).toEqual([
      'general', 'email', 'security', 'agents', 'system', 'ai-providers', 'readiness', 'backups', 'profile',
    ]);
    expect(settingsTabIdsForRole('SUB_ADMIN')).toEqual(['readiness', 'profile']);
    expect(settingsTabIdsForRole('USER')).toEqual(['profile']);
  });

  it('resolves deep links against the hydrated role instead of exposing hidden tabs', () => {
    expect(resolveSettingsTab('OWNER', 'backups')).toBe('backups');
    expect(resolveSettingsTab('SUB_ADMIN', 'backups')).toBe('readiness');
    expect(resolveSettingsTab('USER', 'readiness')).toBe('profile');
    expect(resolveAdminTab('SUB_ADMIN', 'pending')).toBe('users');
    expect(adminTabIdsForRole('SUB_ADMIN')).toEqual(['users', 'maintenance']);
  });

  it('treats every server-changing action as owner-only even if metadata drifts', () => {
    expect(maintenanceActionNeedsOwner({ requiresOwner: false, changesSystem: true })).toBe(true);
    expect(maintenanceActionNeedsOwner({ requiresOwner: true, changesSystem: false })).toBe(true);
    expect(maintenanceActionNeedsOwner({ requiresOwner: false, changesSystem: false })).toBe(false);
  });

  it('polls only for visible in-progress work and respects bounded retry delays', () => {
    expect(isActiveMaintenanceJob('running')).toBe(true);
    expect(isActiveMaintenanceJob('completed')).toBe(false);
    expect(shouldPollMaintenance({ pageVisible: true, ready: true, refreshing: false, hasActiveJob: false })).toBe(false);
    expect(shouldPollMaintenance({ pageVisible: true, ready: true, refreshing: false, hasActiveJob: true })).toBe(true);
    expect(shouldPollMaintenance({ pageVisible: false, ready: false, refreshing: true, hasActiveJob: true })).toBe(false);
    expect(maintenancePollDelayMs({ retryAfterMs: 47_250, hasActiveJob: false })).toBe(47_250);
    expect(maintenancePollDelayMs({ retryAfterMs: 99_000, hasActiveJob: false })).toBe(60_000);
    expect(maintenanceRetryDelayLabel(4_200)).toBe('5 seconds');
    expect(maintenanceRetryDelayLabel(60_000)).toBe('1 minute');
    expect(maintenanceRetryDelayLabel(null)).toBeNull();
  });

  it('supports horizontal and vertical arrow, Home, and End keyboard tab navigation', () => {
    expect(nextTabIndex(0, 3, 'ArrowLeft')).toBe(2);
    expect(nextTabIndex(2, 3, 'ArrowRight')).toBe(0);
    expect(nextTabIndex(0, 3, 'ArrowUp')).toBe(2);
    expect(nextTabIndex(2, 3, 'ArrowDown')).toBe(0);
    expect(nextTabIndex(1, 3, 'Home')).toBe(0);
    expect(nextTabIndex(1, 3, 'End')).toBe(2);
    expect(nextTabIndex(1, 3, 'Enter')).toBeNull();
  });
});
