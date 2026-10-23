import { z } from 'zod';
import { describeSessionWork, type WorkRpc } from './openClawSessionWork';
const identity = {
  goalId: z.string().min(1).max(2048), operationId: z.string().uuid(), issuedAtMs: z.number().int().nonnegative(),
};
export const goalControlSchema = z.union([
  z.object({ ...identity, action: z.literal('edit'), objective: z.string().min(1).max(16000).refine(value => value.trim().length > 0) }).strict(),
  z.object({ ...identity, action: z.enum(['pause', 'resume', 'block', 'complete']), note: z.string().max(2000).optional() }).strict(),
  z.object({ ...identity, action: z.literal('clear') }).strict(),
]);
export type GoalControl = z.infer<typeof goalControlSchema>;
export function goalControlTimeError(issuedAtMs: number, now = Date.now()): string | null {
  if (issuedAtMs > now + 5 * 60_000) return 'GOAL_INVALID';
  if (issuedAtMs <= now - 24 * 60 * 60_000) return 'GOAL_EXPIRED';
  return null;
}
export async function goalControlParams(sessionKey: string, body: GoalControl, rpc: WorkRpc) {
  const row = await describeSessionWork(sessionKey, rpc);
  // Pins prevent a changed session generation from receiving a stale UI operation.
  if (!row?.sessionId || !row.agentId) return null;
  const { action, ...identityAndEdit } = body;
  return { method: action === 'clear' ? 'sessions.goal.clear' : 'sessions.goal.update',
    params: { ...identityAndEdit, ...(action === 'clear' ? {} : { action }), sessionKey, sessionId: row.sessionId, agentId: row.agentId } };
}
export function mapGoalControlFailure(result: { errorCode?: string; errorMessage?: string; errorDetails?: unknown }) {
  const details = result.errorDetails as any;
  const reason = typeof details?.reason === 'string' ? details.reason : undefined;
  if (details?.code === 'GOAL_OPERATION_REJECTED') {
    const code = ['goal-rebound', 'session-rebound'].includes(reason || '') ? 'GOAL_STALE'
      : reason === 'expired' ? 'GOAL_EXPIRED' : reason === 'operation-conflict' ? 'GOAL_OPERATION_CONFLICT' : 'GOAL_REJECTED';
    return { status: 409, code, reason };
  }
  if (result.errorMessage?.includes('Session changed before its Goal update')) return { status: 409, code: 'SESSION_CHANGED' };
  if (result.errorCode === 'UNAVAILABLE' || /timeout|connection closed|socket|WebSocket/i.test(result.errorMessage || '')) {
    return { status: 202, code: 'GOAL_UNCONFIRMED', outcome: 'unconfirmed' };
  }
  return { status: 409, code: 'GOAL_REJECTED' };
}
