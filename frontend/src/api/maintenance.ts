import client from './client';
import type { AgentJob } from './agentJobs';

export type MaintenanceSeverity = 'healthy' | 'info' | 'warning' | 'critical';

export type MaintenanceAction = {
  id: string;
  label: string;
  description: string;
  risk: 'safe' | 'scheduled' | 'manual';
  downtimeExpected: boolean;
  requiresOwner: boolean;
  changesSystem: boolean;
  destructive: boolean;
  requiresBackup: boolean;
  requiresMaintenanceWindow: boolean;
  automationLevel: 'read-only' | 'safe' | 'guarded' | 'manual';
  impact: string;
  recovery: string;
  confirmationPhrase: string | null;
};

export type MaintenanceIssue = {
  id: string;
  title: string;
  detail: string;
  severity: Exclude<MaintenanceSeverity, 'healthy'>;
  category: 'security' | 'updates' | 'services' | 'disk' | 'backups' | 'system';
  recommendation: string;
  actionId?: string;
  downtimeExpected?: boolean;
  automationSafe: boolean;
};

export type MaintenanceCompatibilityComponent = {
  id: string;
  label: string;
  installedVersion: string | null;
  supportedVersion: string;
  policy: 'self-update-only' | 'known-compatible' | 'manual-review' | 'blocked-until-confirmed';
  status: 'ok' | 'review' | 'blocked' | 'unknown';
  note: string;
};

export type MaintenanceStatus = {
  ready?: boolean;
  cached?: boolean;
  refreshing?: boolean;
  cacheAgeMs?: number;
  retryAfterMs?: number | null;
  refreshError?: string | null;
  checkedAt: string | null;
  status: MaintenanceSeverity;
  summary: string;
  host?: { hostname: string; os: string; kernel: string; uptimeSeconds: number };
  issues: MaintenanceIssue[];
  actions: MaintenanceAction[];
  compatibility?: {
    policy: 'guarded';
    summary: string;
    components: MaintenanceCompatibilityComponent[];
  };
  backup?: { path: string; createdAt: string; ageHours: number } | null;
  reboot?: { required: boolean; packages: string[] };
};

type MaintenanceStatusRequestOptions = {
  silent?: boolean;
};

export const maintenanceAPI = {
  getStatus: async (force = false, options: MaintenanceStatusRequestOptions = {}): Promise<MaintenanceStatus> => {
    const { data } = await client.get<MaintenanceStatus>('/system/maintenance', {
      params: force ? { refresh: true } : undefined,
      ...(options.silent ? { _silent: true } : {}),
    } as any);
    return data;
  },

  startAction: async (
    actionId: string,
    confirmation: string,
    maintenanceWindowAcknowledged = false,
  ): Promise<{ job?: AgentJob }> => {
    const { data } = await client.post(`/system/maintenance/actions/${encodeURIComponent(actionId)}`, {
      confirmation,
      maintenanceWindowAcknowledged,
    });
    return data;
  },
};
