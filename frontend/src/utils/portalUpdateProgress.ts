export type PortalSelfUpdateProgressStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'recovering'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'
  | 'updated_with_errors'
  | 'recovery_required';

export type PortalSelfUpdateProgressEvent = {
  status: 'running' | 'recovering' | 'rolled_back' | 'updated_with_errors' | 'recovery_required';
  phase: string;
  percent: number;
  label: string;
  detail: string;
  at: string;
};

export type PortalSelfUpdateProgress = {
  schema: 1;
  operationId: string | null;
  previousVersion: string | null;
  expectedVersion: string | null;
  status: PortalSelfUpdateProgressStatus;
  phase: string;
  percent: number;
  label: string;
  detail: string;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  events: PortalSelfUpdateProgressEvent[];
  logAvailable: boolean;
  isCurrent: boolean;
  admissionBlocked: boolean;
};

type ProgressMonitorApi = {
  readProgress: (operationId?: string) => Promise<unknown>;
  readPortalVersion: () => Promise<unknown>;
};

type ProgressMonitorOptions = {
  delay?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  maxAttempts?: number;
  /** Finite admission ambiguity budget; ignored once an operation ID pins. */
  maxUnattachedAttempts?: number;
  onProgress?: (progress: PortalSelfUpdateProgress) => void;
  onConnectionChange?: (state: 'connected' | 'reconnecting') => void;
};

export type PortalSelfUpdateMonitorResult =
  | { outcome: 'succeeded'; progress: PortalSelfUpdateProgress | null }
  | { outcome: 'failed'; progress: PortalSelfUpdateProgress; error: string }
  | { outcome: 'timeout'; progress: PortalSelfUpdateProgress | null };

const OPERATION_ID_PATTERN = /^[a-f0-9]{32}$/;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const PHASE_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const STATUSES = new Set<PortalSelfUpdateProgressStatus>([
  'idle',
  'starting',
  'running',
  'recovering',
  'succeeded',
  'failed',
  'rolled_back',
  'updated_with_errors',
  'recovery_required',
]);
const TERMINAL_STATUSES = new Set<PortalSelfUpdateProgressStatus>([
  'succeeded',
  'failed',
  'rolled_back',
  'updated_with_errors',
  'recovery_required',
]);

export function isPortalUpdateOperationId(value: unknown): value is string {
  return typeof value === 'string' && OPERATION_ID_PATTERN.test(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, limit: number, allowEmpty = true): string | null {
  if (typeof value !== 'string'
    || value.length > limit
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    || (!allowEmpty && value.length === 0)) {
    return null;
  }
  return value;
}

function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function parseEvent(value: unknown): PortalSelfUpdateProgressEvent | null {
  const item = record(value);
  if (!item) return null;
  const status = item.status;
  const phase = boundedString(item.phase, 48, false);
  const percent = item.percent;
  const label = boundedString(item.label, 160, false);
  const detail = boundedString(item.detail, 800);
  const at = timestamp(item.at);
  if (!['running', 'recovering', 'rolled_back', 'updated_with_errors', 'recovery_required'].includes(String(status))
    || !phase
    || !PHASE_PATTERN.test(phase)
    || !Number.isInteger(percent)
    || (percent as number) < 0
    || (percent as number) > 99
    || label === null
    || detail === null
    || at === null) {
    return null;
  }
  return {
    status: status as PortalSelfUpdateProgressEvent['status'],
    phase,
    percent: percent as number,
    label,
    detail,
    at,
  };
}

export function parsePortalSelfUpdateProgress(value: unknown): PortalSelfUpdateProgress | null {
  const item = record(value);
  if (!item || item.schema !== 1 || !STATUSES.has(item.status as PortalSelfUpdateProgressStatus)) return null;
  const status = item.status as PortalSelfUpdateProgressStatus;
  const operationId = item.operationId === null ? null : boundedString(item.operationId, 32, false);
  const previousVersion = item.previousVersion === null ? null : boundedString(item.previousVersion, 32, false);
  const expectedVersion = item.expectedVersion === null ? null : boundedString(item.expectedVersion, 32, false);
  const phase = boundedString(item.phase, 48, false);
  const percent = item.percent;
  const label = boundedString(item.label, 160, false);
  const detail = boundedString(item.detail, 800);
  const startedAt = timestamp(item.startedAt);
  const updatedAt = timestamp(item.updatedAt);
  const finishedAt = timestamp(item.finishedAt);
  const eventsInput = Array.isArray(item.events) ? item.events : null;
  if ((operationId !== null && !isPortalUpdateOperationId(operationId))
    || (previousVersion !== null && !VERSION_PATTERN.test(previousVersion))
    || (expectedVersion !== null && !VERSION_PATTERN.test(expectedVersion))
    || !phase
    || !PHASE_PATTERN.test(phase)
    || !Number.isInteger(percent)
    || (percent as number) < 0
    || (percent as number) > 100
    || label === null
    || detail === null
    || eventsInput === null
    || eventsInput.length > 12) {
    return null;
  }
  if (status === 'idle' && (operationId !== null || previousVersion !== null || expectedVersion !== null)) return null;
  if (status !== 'idle' && (!operationId || !previousVersion || !expectedVersion || !startedAt || !updatedAt)) return null;
  if (TERMINAL_STATUSES.has(status) !== Boolean(finishedAt)) return null;
  const events = eventsInput.map(parseEvent);
  if (events.some((event) => event === null)) return null;
  const isCurrent = typeof item.isCurrent === 'boolean'
    ? item.isCurrent
    : status !== 'idle';
  const admissionBlocked = typeof item.admissionBlocked === 'boolean'
    ? item.admissionBlocked
    : ['starting', 'running', 'recovering', 'updated_with_errors', 'recovery_required']
      .includes(status);
  return {
    schema: 1,
    operationId,
    previousVersion,
    expectedVersion,
    status,
    phase,
    percent: percent as number,
    label,
    detail,
    startedAt,
    updatedAt,
    finishedAt,
    events: events as PortalSelfUpdateProgressEvent[],
    logAvailable: item.logAvailable === true,
    isCurrent,
    admissionBlocked,
  };
}

function readyPortalVersion(value: unknown): string | null {
  const item = record(value);
  if (!item || item.status !== 'ok') return null;
  const version = item && typeof item.version === 'string' ? item.version.trim() : '';
  return VERSION_PATTERN.test(version) ? version : null;
}

export async function monitorPortalSelfUpdate(
  expectedVersion: string,
  operationId: string | undefined,
  api: ProgressMonitorApi,
  options: ProgressMonitorOptions = {},
): Promise<PortalSelfUpdateMonitorResult> {
  if (!VERSION_PATTERN.test(expectedVersion) || (operationId && !isPortalUpdateOperationId(operationId))) {
    throw new Error('Portal update monitor received an invalid release identity.');
  }
  const delay = options.delay || ((milliseconds: number) => new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  }));
  const pollIntervalMs = options.pollIntervalMs ?? 1_250;
  // The installer legitimately waits up to 30 minutes for package-manager
  // recovery. Production tracking therefore has no client-side terminal
  // deadline; tests may inject a finite ceiling. Lack of fresh feedback is a
  // visible connection/staleness state, never permission to start a second job.
  const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
  // A real updater may legitimately run for hours, but a lost POST that never
  // reached the server must not leave the browser in an eternal admission
  // state. This ceiling applies only before a durable operation ID is pinned.
  const maxUnattachedAttempts = options.maxUnattachedAttempts ?? 96;
  if (!Number.isInteger(maxUnattachedAttempts) || maxUnattachedAttempts < 1) {
    throw new Error('Portal update monitor received an invalid unattached admission budget.');
  }
  let latest: PortalSelfUpdateProgress | null = null;
  let pinnedOperationId = operationId;
  let unattachedAttempts = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let connected = false;
    try {
      const parsed = parsePortalSelfUpdateProgress(await api.readProgress(pinnedOperationId));
      if (parsed && parsed.status !== 'idle' && parsed.expectedVersion === expectedVersion
        && (!pinnedOperationId || parsed.operationId === pinnedOperationId)) {
        pinnedOperationId ||= parsed.operationId || undefined;
        if (latest && parsed.operationId === latest.operationId && parsed.percent < latest.percent) {
          if (attempt < maxAttempts - 1) await delay(pollIntervalMs);
          continue;
        }
        latest = parsed;
        connected = true;
        options.onConnectionChange?.('connected');
        if (parsed.status !== 'succeeded' && TERMINAL_STATUSES.has(parsed.status)) {
          options.onProgress?.(parsed);
          return { outcome: 'failed', progress: parsed, error: parsed.detail };
        }
        if (parsed.status === 'succeeded') {
          try {
            if (readyPortalVersion(await api.readPortalVersion()) === expectedVersion) {
              // Do not let the UI present a terminal success receipt before
              // the restarted Portal itself corroborates exact ready health.
              options.onProgress?.(parsed);
              return { outcome: 'succeeded', progress: parsed };
            }
          } catch {
            options.onConnectionChange?.('reconnecting');
          }
        } else {
          options.onProgress?.(parsed);
        }
      }
    } catch {
      options.onConnectionChange?.('reconnecting');
    }

    if (!connected) {
      try {
        // Health is only a connectivity signal here. During restart the
        // startup status server advertises the target version before the
        // updater has completed postflight work, so it can never prove a
        // terminal result by itself.
        await api.readPortalVersion();
      } catch {
        options.onConnectionChange?.('reconnecting');
      }
    }
    if (!pinnedOperationId) {
      unattachedAttempts += 1;
      if (unattachedAttempts >= maxUnattachedAttempts) {
        return { outcome: 'timeout', progress: latest };
      }
    }
    if (attempt < maxAttempts - 1) await delay(pollIntervalMs);
  }
  return { outcome: 'timeout', progress: latest };
}
