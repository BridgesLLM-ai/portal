import {
  isPortalUpdateOperationId,
  parsePortalSelfUpdateProgress,
  type PortalSelfUpdateProgress,
} from './portalUpdateProgress';

export const PORTAL_UPDATE_OPERATION_SESSION_KEY = 'dashboard-self-update-operation-id';
export const PORTAL_UPDATE_CHECKPOINT_SESSION_KEY = 'dashboard-self-update-progress-checkpoint';

const MAX_CHECKPOINT_BYTES = 16 * 1024;

function browserSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function rememberedPortalUpdateOperation(storage: Storage | null = browserSessionStorage()): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(PORTAL_UPDATE_OPERATION_SESSION_KEY) || '';
    return isPortalUpdateOperationId(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberPortalUpdateCheckpoint(
  progress: PortalSelfUpdateProgress,
  storage: Storage | null = browserSessionStorage(),
): void {
  if (!storage || !isPortalUpdateOperationId(progress.operationId)) return;
  try {
    const serialized = JSON.stringify(progress);
    if (serialized.length > MAX_CHECKPOINT_BYTES) return;
    storage.setItem(PORTAL_UPDATE_CHECKPOINT_SESSION_KEY, serialized);
  } catch {
    // The durable server receipt remains authoritative when browser storage is unavailable.
  }
}

export function rememberedPortalUpdateCheckpoint(
  operationId: string,
  storage: Storage | null = browserSessionStorage(),
): PortalSelfUpdateProgress | null {
  if (!storage || !isPortalUpdateOperationId(operationId)) return null;
  try {
    const raw = storage.getItem(PORTAL_UPDATE_CHECKPOINT_SESSION_KEY);
    if (!raw || raw.length > MAX_CHECKPOINT_BYTES) return null;
    const parsed = parsePortalSelfUpdateProgress(JSON.parse(raw));
    return parsed?.operationId === operationId ? parsed : null;
  } catch {
    return null;
  }
}

export function forgetPortalUpdateCheckpoint(storage: Storage | null = browserSessionStorage()): void {
  try {
    storage?.removeItem(PORTAL_UPDATE_CHECKPOINT_SESSION_KEY);
  } catch {
    // Best effort only; the checkpoint cannot authorize or start an update.
  }
}
