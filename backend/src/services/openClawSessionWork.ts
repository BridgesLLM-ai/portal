import { gatewayRpcCall } from '../utils/openclawGatewayRpc';
import { getOpenClawCapabilities } from './openClawCompatibility';

export type SessionRow = Record<string, any>;
export const sessionRowKey = (row: SessionRow): string => String(row?.key || row?.sessionKey || '').trim();
export const sessionParentKey = (row: SessionRow): string | null => {
  const value = row?.parentSessionKey ?? row?.spawnedBy;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};
export function validWorkSessionKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u0020\u007f]/.test(value);
}
export type WorkRpc = typeof gatewayRpcCall;
let rowCache: { at: number; rows: SessionRow[] } | null = null;
let inflight: Promise<SessionRow[]> | null = null;
export function invalidateSessionWorkRows(): void { rowCache = null; }
export async function listSessionWorkRows(rpc: WorkRpc = gatewayRpcCall): Promise<SessionRow[]> {
  if (rpc !== gatewayRpcCall) return loadRows(rpc);
  if (rowCache && Date.now() - rowCache.at < 5000) return rowCache.rows;
  if (!inflight) inflight = loadRows(rpc).then(rows => {
    rowCache = { at: Date.now(), rows }; return rows;
  }).finally(() => { inflight = null; });
  return inflight;
}
async function loadRows(rpc: WorkRpc): Promise<SessionRow[]> {
  const result = await rpc('sessions.list', {}, 30000);
  if (!result.ok || !Array.isArray(result.data?.sessions)) throw new Error('Session activity unavailable');
  return result.data.sessions.filter((row: any) => validWorkSessionKey(sessionRowKey(row)));
}
export async function describeSessionWork(key: string, rpc: WorkRpc = gatewayRpcCall): Promise<SessionRow | null> {
  const result = await rpc('sessions.describe', { key });
  if (!result.ok) throw new Error('Session description unavailable');
  return result.data?.session || null;
}

/** Bounded read-time lineage. Never treat labels/origin.from or client input as ownership. */
export async function resolveSessionOwnershipRoot(key: string, dependencies: {
  hasOwner(key: string): Promise<boolean>;
  describe(key: string): Promise<SessionRow | null>;
}): Promise<{ root: string; inherited: boolean } | null> {
  const seen = new Set<string>();
  let current = key;
  for (let depth = 0; depth <= 8; depth++) {
    if (!validWorkSessionKey(current) || seen.has(current)) return null;
    seen.add(current);
    if (await dependencies.hasOwner(current)) return { root: current, inherited: current !== key };
    const row = await dependencies.describe(current);
    if (!row) return null;
    const parent = sessionParentKey(row);
    if (!parent) return { root: current, inherited: current !== key };
    current = parent;
  }
  return null;
}
export type WorkPart = 'goal' | 'status' | 'children' | 'progress';
type WorkSignal = { type: 'work.changed'; v: 1; sessionKey: string; parts: WorkPart[] };
const listeners = new Set<(signal: WorkSignal) => void>();
export function subscribeSessionWorkChanges(listener: (signal: WorkSignal) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function publishSessionWorkChanged(key: unknown, parts: WorkPart[]): void {
  if (!validWorkSessionKey(key)) return;
  invalidateSessionWorkRows();
  const signal: WorkSignal = { type: 'work.changed', v: 1, sessionKey: key, parts };
  for (const listener of listeners) listener(signal);
}
export function projectSessionWorkRow(row: SessionRow) {
  const parentKey = sessionParentKey(row);
  return { kind: parentKey ? 'subagent' : 'session', key: sessionRowKey(row), parentKey,
    label: row.label || row.displayName || sessionRowKey(row), status: row.status ?? null,
    sessionId: row.sessionId, lastRunId: row.lastRunId, lastRunError: row.lastRunError,
    updatedAt: row.updatedAt, subagentRole: row.subagentRole, spawnDepth: row.spawnDepth,
    activity: row.activitySummary?.state === 'current' ? row.activitySummary : undefined,
    activityText: row.activitySummary?.state === 'current' ? row.activitySummary.text : undefined };
}
export async function readSessionWork(key: string, authorize: (key: string) => Promise<void>, rpc: WorkRpc = gatewayRpcCall) {
  await authorize(key);
  const caps = getOpenClawCapabilities();
  const row = await describeSessionWork(key, rpc);
  if (!row) return null;
  const rows = await listSessionWorkRows(rpc);
  const children: SessionRow[] = [];
  for (const child of rows.filter(row => sessionParentKey(row) === key).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))) {
    try { await authorize(sessionRowKey(child)); children.push(projectSessionWorkRow(child)); } catch { /* Do not expose foreign children. */ }
    if (children.length === 20) break;
  }
  const progress = caps.progress ? await rpc('progressCard.get', { sessionKey: key }) : null;
  if (progress && !progress.ok) throw new Error('Progress card unavailable');
  return { v: 1, sessionKey: key, fetchedAt: new Date().toISOString(), caps: { goals: caps.goals, progress: caps.progress },
    session: projectSessionWorkRow(row), goal: row.goal || null, progress: progress?.data?.card || null, children, swarm: row.swarm };
}
