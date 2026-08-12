export type UpdateBackupState =
  | 'candidate'
  | 'fresh'
  | 'stale'
  | 'missing'
  | 'running'
  | 'unavailable';

export type UpdateBackupReadiness = {
  state: UpdateBackupState;
  maxAgeHours: number;
  newestCreatedAt: string | null;
  ageHours: number | null;
  activeStatus: 'queued' | 'running' | null;
};

export type PortalUpdatePreparation = {
  confirmationPhrase: string;
  backup: UpdateBackupReadiness;
};

type BackupRunStatus = {
  status?: 'idle' | 'queued' | 'running' | 'completed' | 'degraded' | 'failed';
  error?: string;
};

type FreshBackupApi = {
  startComprehensiveBackup: () => Promise<{ status?: string }>;
  getBackupStatus: () => Promise<BackupRunStatus>;
  getBackupReadiness: () => Promise<UpdateBackupReadiness | null>;
};

type FreshBackupOptions = {
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  maxAttempts?: number;
  onProgress?: (message: string) => void;
};

type PortalVersionWaitOptions = {
  probe?: () => Promise<unknown>;
  delay?: (milliseconds: number) => Promise<void>;
  initialDelayMs?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
};

function errorResponse(error: unknown): { status?: number; data?: any } {
  if (!error || typeof error !== 'object') return {};
  return (error as any).response || {};
}

function isActiveBackupConflict(error: unknown): boolean {
  const response = errorResponse(error);
  return response.status === 409
    && ['queued', 'running'].includes(String(response.data?.status || ''));
}

function freshBackupWasCreatedSince(readiness: UpdateBackupReadiness | null, requestedAt: number): boolean {
  if (!['candidate', 'fresh'].includes(readiness?.state || '') || !readiness?.newestCreatedAt) return false;
  const createdAt = Date.parse(readiness.newestCreatedAt);
  return Number.isFinite(createdAt) && createdAt >= requestedAt - 60_000;
}

export async function createFreshBackupForUpdate(
  api: FreshBackupApi,
  options: FreshBackupOptions = {},
): Promise<UpdateBackupReadiness> {
  const now = options.now || Date.now;
  const delay = options.delay || ((milliseconds: number) => new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  }));
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const maxAttempts = options.maxAttempts ?? 450;
  const requestedAt = now();

  options.onProgress?.('Starting a comprehensive recovery backup…');
  try {
    const started = await api.startComprehensiveBackup();
    if (started.status === 'failed') throw new Error('The backup service failed during startup.');
  } catch (error) {
    if (!isActiveBackupConflict(error)) throw error;
    options.onProgress?.('A backup is already running. Waiting for it to finish…');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await delay(pollIntervalMs);
    let run: BackupRunStatus;
    try {
      run = await api.getBackupStatus();
    } catch {
      // Comprehensive backups intentionally stop the Portal while the recovery
      // fence is held. Treat a bounded connection loss as expected downtime,
      // then require the authenticated readiness endpoint after it returns.
      options.onProgress?.('Portal is paused while the recovery backup is captured…');
      continue;
    }
    if (run.status === 'degraded' || run.status === 'failed') {
      throw new Error(run.error || 'The fresh backup failed. The update was not started.');
    }

    if (run.status === 'queued') options.onProgress?.('Comprehensive backup queued…');
    if (run.status === 'running') options.onProgress?.('Creating and verifying the comprehensive recovery backup…');

    if (run.status === 'completed') {
      let readiness: UpdateBackupReadiness | null;
      try {
        readiness = await api.getBackupReadiness();
      } catch {
        options.onProgress?.('Backup finished. Waiting for Portal readiness verification…');
        continue;
      }
      if (freshBackupWasCreatedSince(readiness, requestedAt)) return readiness!;
      options.onProgress?.('Backup finished. Confirming the new archive…');
    }
  }

  throw new Error('The comprehensive backup did not finish within 15 minutes. The update was not started.');
}

function portalHealthVersion(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const version = String((value as Record<string, unknown>).version || '').trim();
  return version || null;
}

export async function waitForExpectedPortalVersion(
  expectedVersion: string,
  options: PortalVersionWaitOptions = {},
): Promise<boolean> {
  const expected = String(expectedVersion || '').trim();
  if (!expected) return false;

  const delay = options.delay || ((milliseconds: number) => new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  }));
  const probe = options.probe || (async () => {
    const response = await fetch('/health', { cache: 'no-store' });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  });
  const maxAttempts = options.maxAttempts ?? 300;

  await delay(options.initialDelayMs ?? 5_000);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      if (portalHealthVersion(await probe()) === expected) return true;
    } catch {
      // A temporary connection failure is expected while the updater restarts
      // the Portal. It is not proof that the requested version was installed.
    }
    if (attempt < maxAttempts - 1) await delay(options.pollIntervalMs ?? 2_000);
  }
  return false;
}

function formatAge(ageHours: number | null): string {
  if (ageHours === null || !Number.isFinite(ageHours)) return 'an unknown age';
  if (ageHours < 1) return 'less than an hour old';
  if (ageHours < 48) return `${Math.round(ageHours)} hour${Math.round(ageHours) === 1 ? '' : 's'} old`;
  const days = Math.round((ageHours / 24) * 10) / 10;
  return `${days} day${days === 1 ? '' : 's'} old`;
}

export function describeUpdateBackup(readiness: UpdateBackupReadiness | null | undefined): {
  tone: 'good' | 'warning' | 'info';
  label: string;
  detail: string;
} {
  if (!readiness || readiness.state === 'unavailable') {
    return {
      tone: 'warning',
      label: 'Backup status unavailable',
      detail: 'Portal could not identify an authenticated comprehensive backup candidate. Create one before updating.',
    };
  }
  if (readiness.state === 'running') {
    return {
      tone: 'info',
      label: 'Backup in progress',
      detail: 'Wait for the active backup to finish before installing the update.',
    };
  }
  if (readiness.state === 'missing') {
    return {
      tone: 'warning',
      label: 'No backup found',
      detail: 'Create a comprehensive recovery backup before installing the update.',
    };
  }
  if (readiness.state === 'stale') {
    return {
      tone: 'warning',
      label: 'Backup is stale',
      detail: `The newest authenticated comprehensive backup candidate is ${formatAge(readiness.ageHours)}. The update safety window is ${readiness.maxAgeHours} hours.`,
    };
  }
  if (readiness.state === 'candidate') {
    return {
      tone: 'info',
      label: 'Backup candidate found',
      detail: `The newest authenticated comprehensive backup candidate is ${formatAge(readiness.ageHours)}. Strict restore verification will run before the update is admitted.`,
    };
  }
  return {
    tone: 'good',
    label: 'Recovery backup strictly verified',
    detail: `Strict restore verification succeeded for the comprehensive backup ${formatAge(readiness.ageHours)}.`,
  };
}
