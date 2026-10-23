/**
 * One saved goal operation per (user, conversation), kept in this browser tab.
 *
 * The identity is minted once per user action and stored before sending, so a lost
 * response can be checked by re-sending exactly the same request. Nothing here retries
 * on its own. Records are retired on a definitive answer and expire with the upstream
 * 24 hour receipt window. `clearWorkspaceClientState` removes the prefix on sign-out.
 */
import type { GoalControlAction, GoalControlBody, GoalStartBody } from './agentWorkApi';

export const GOAL_OPERATION_STORAGE_PREFIX = 'agent-work-goal-op:v1:';
/** Upstream receipts last 24 h from issuedAtMs; stop offering a check a minute early. */
export const GOAL_OPERATION_TTL_MS = 24 * 60 * 60_000 - 60_000;

export type GoalOperationAction = GoalControlAction | 'start';

export interface SavedGoalOperation {
  v: 1;
  sessionKey: string;
  action: GoalOperationAction;
  /** Absent only for start. */
  goalId: string | null;
  /** operationId for controls, idempotencyKey for start. */
  identity: string;
  issuedAtMs: number;
  objective?: string;
  note?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS: ReadonlySet<string> = new Set(['start', 'edit', 'pause', 'resume', 'block', 'complete', 'clear']);

export function newOperationIdentity(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function storageKey(userId: string, sessionKey: string): string {
  return `${GOAL_OPERATION_STORAGE_PREFIX}${JSON.stringify([userId, sessionKey])}`;
}

function storage(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

function valid(value: unknown, sessionKey: string): value is SavedGoalOperation {
  const op = value as SavedGoalOperation;
  if (!op || typeof op !== 'object' || op.v !== 1 || op.sessionKey !== sessionKey) return false;
  if (!ACTIONS.has(op.action) || typeof op.identity !== 'string' || !UUID.test(op.identity)) return false;
  if (!Number.isSafeInteger(op.issuedAtMs) || op.issuedAtMs < 0) return false;
  if (op.action === 'start' ? op.goalId !== null : typeof op.goalId !== 'string' || !op.goalId) return false;
  if ((op.action === 'start' || op.action === 'edit') && (typeof op.objective !== 'string' || !op.objective.trim())) return false;
  if (op.note !== undefined && typeof op.note !== 'string') return false;
  return true;
}

export function loadGoalOperation(userId: string, sessionKey: string): SavedGoalOperation | null {
  const store = storage();
  if (!store || !userId || !sessionKey) return null;
  const key = storageKey(userId, sessionKey);
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (valid(parsed, sessionKey)) return parsed;
  } catch { /* fall through and drop the unreadable record */ }
  try { store.removeItem(key); } catch { /* best effort */ }
  return null;
}

/** Persist before sending: an unsaved request could never be checked. */
export function saveGoalOperation(userId: string, operation: SavedGoalOperation): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(storageKey(userId, operation.sessionKey), JSON.stringify(operation));
    return true;
  } catch {
    return false;
  }
}

/** Remove the record only if it is still this operation; a newer one is left alone. */
export function retireGoalOperation(userId: string, operation: Pick<SavedGoalOperation, 'sessionKey' | 'identity'>): void {
  const store = storage();
  if (!store) return;
  const current = loadGoalOperation(userId, operation.sessionKey);
  if (current && current.identity !== operation.identity) return;
  try { store.removeItem(storageKey(userId, operation.sessionKey)); } catch { /* best effort */ }
}

export function goalOperationExpired(operation: Pick<SavedGoalOperation, 'issuedAtMs'>, now = Date.now()): boolean {
  return now - operation.issuedAtMs >= GOAL_OPERATION_TTL_MS;
}

export function sameGoalRequest(
  operation: SavedGoalOperation,
  request: { action: GoalOperationAction; goalId: string | null; objective?: string; note?: string },
): boolean {
  return operation.action === request.action
    && operation.goalId === request.goalId
    && (operation.objective ?? '') === (request.objective ?? '')
    && (operation.note ?? '') === (request.note ?? '');
}

export function goalControlBody(operation: SavedGoalOperation): GoalControlBody | null {
  if (operation.action === 'start' || !operation.goalId) return null;
  const identity = { goalId: operation.goalId, operationId: operation.identity, issuedAtMs: operation.issuedAtMs };
  if (operation.action === 'edit') return { ...identity, action: 'edit', objective: operation.objective ?? '' };
  if (operation.action === 'clear') return { ...identity, action: 'clear' };
  return { ...identity, action: operation.action, ...(operation.note ? { note: operation.note } : {}) };
}

export function goalStartBody(operation: SavedGoalOperation): GoalStartBody | null {
  if (operation.action !== 'start' || !operation.objective) return null;
  return { objective: operation.objective, idempotencyKey: operation.identity, issuedAtMs: operation.issuedAtMs };
}
