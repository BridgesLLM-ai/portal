import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { requireApproved } from '../middleware/requireApproved';
import type { JwtPayload } from '../utils/jwt';
import { gatewayRpcCall } from '../utils/openclawGatewayRpc';
import { getOpenClawCapabilities } from '../services/openClawCompatibility';
import { describeSessionWork, listSessionWorkRows, projectSessionWorkRow, readSessionWork, sessionRowKey, validWorkSessionKey, publishSessionWorkChanged, type WorkRpc } from '../services/openClawSessionWork';
import { goalControlSchema, goalControlTimeError, goalControlParams, mapGoalControlFailure } from '../services/openClawGoalControl';
import { isOwnerRole } from '../utils/authz';
import { classifyOpenClawSessionLane } from '../agents/openclawSessionOwnership';
import { acquireWorkspaceAuthorizationMutationLease } from '../services/workspaceAuthorizationBarrier';
import {
  NativeWorkError,
  controlNativeGoal,
  isNativeWorkSessionKey,
  readNativeSessionWork,
  startNativeGoal,
} from '../services/nativeSessionWork';
export interface AgentWorkDependencies {
  authorize(key: string, user: JwtPayload): Promise<void>;
  /**
   * Generic host-history contract without native lineage. Used only to answer
   * a direct chat the gateway has not stored yet; omit to keep the plain 404.
   */
  authorizeUnstarted?(key: string, user: JwtPayload): Promise<void>;
  /** Existing Portal execution admission wrapper, not an unrestricted proxy. */
  mutate(key: string, user: JwtPayload, method: string, params: Record<string, any>): ReturnType<WorkRpc>;
  rpc?: WorkRpc;
}
export function createAgentWorkRouter(dependencies: AgentWorkDependencies): Router {
  const router = Router();
  const rpc = dependencies.rpc || gatewayRpcCall;
  router.use(authenticateToken, requireApproved, requireAdmin);
  router.use((req, res, next) => {
    try {
      const release = acquireWorkspaceAuthorizationMutationLease(req.user!.userId);
      let released = false;
      const finish = () => { if (!released) { released = true; release(); } };
      res.once('finish', finish); res.once('close', finish);
      next();
    } catch { res.status(409).json({ v: 1, code: 'AUTHORIZATION_CHANGED' }); }
  });
  const keyFor = async (req: Request, res: Response): Promise<string | null> => {
    const key = req.params.key;
    if (!validWorkSessionKey(key)) { res.status(404).json({ v: 1, code: 'SESSION_NOT_FOUND' }); return null; }
    try { await dependencies.authorize(key, req.user!); return key; }
    catch { res.status(404).json({ v: 1, code: 'SESSION_NOT_FOUND' }); return null; }
  };
  const fail = (res: Response, error: any) => res.status(error?.statusCode || 502).json({ v: 1, code: error?.code || 'WORK_UNAVAILABLE', error: 'Session work unavailable' });
  // Native (non-OpenClaw) harness sessions: Portal-managed work and goals.
  const nativeKey = (req: Request): string | null => {
    const key = req.params.key;
    return typeof key === 'string' && isNativeWorkSessionKey(key, req.user!.userId) ? key : null;
  };
  const nativeFail = (res: Response, error: any) => {
    if (error instanceof NativeWorkError) { res.status(error.status).json({ v: 1, code: error.code }); return; }
    res.status(502).json({ v: 1, code: 'WORK_UNAVAILABLE', error: 'Session work unavailable' });
  };
  // A fresh main session, or a new chat before its first turn lands, has no
  // gateway row yet: there is no work and no native lineage to attest. Answer
  // it as "not started" instead of a 404 every time chat opens.
  const unstarted = (res: Response, key: string) => {
    const caps = getOpenClawCapabilities();
    res.set('Cache-Control', 'private, no-store').json({ v: 1, sessionKey: key, fetchedAt: new Date().toISOString(),
      caps: { goals: caps.goals, progress: caps.progress }, started: false, session: null, goal: null, progress: null, children: [] });
  };
  // Lineage refuses a key it cannot describe. Only a direct chat the gateway
  // does not know yet falls back to the generic contract, checked before any
  // native read so a foreign key stays indistinguishable from a missing one.
  const unstartedVisible = async (key: string, user: JwtPayload): Promise<boolean> => {
    if (!dependencies.authorizeUnstarted || classifyOpenClawSessionLane(key) !== 'direct') return false;
    try { await dependencies.authorizeUnstarted(key, user); } catch { return false; }
    return (await describeSessionWork(key, rpc)) === null;
  };
  router.get('/sessions/:key/work', async (req, res) => {
    const native = nativeKey(req);
    if (native) {
      try { res.set('Cache-Control', 'private, no-store').json(readNativeSessionWork(native, req.user!.userId)); }
      catch (error) { nativeFail(res, error); }
      return;
    }
    const key = req.params.key;
    if (!validWorkSessionKey(key)) { res.status(404).json({ v: 1, code: 'SESSION_NOT_FOUND' }); return; }
    try { await dependencies.authorize(key, req.user!); } catch {
      let visible = false;
      try { visible = await unstartedVisible(key, req.user!); } catch { /* Gateway unreadable: keep the plain 404. */ }
      if (visible) unstarted(res, key); else res.status(404).json({ v: 1, code: 'SESSION_NOT_FOUND' });
      return;
    }
    try {
      const work = await readSessionWork(key, target => dependencies.authorize(target, req.user!), rpc);
      await dependencies.authorize(key, req.user!);
      if (!work) {
        if (classifyOpenClawSessionLane(key) === 'direct') unstarted(res, key);
        else res.status(404).json({ v: 1, code: 'SESSION_NOT_FOUND' });
        return;
      }
      res.set('Cache-Control', 'private, no-store').json(work);
    } catch (error) { fail(res, error); }
  });
  router.get('/activity', async (req, res) => {
    try {
      const items: any[] = []; const automation: any[] = [];
      for (const row of await listSessionWorkRows(rpc)) {
        try { await dependencies.authorize(sessionRowKey(row), req.user!); } catch { continue; }
        if (sessionRowKey(row).includes(':cron:')) {
          if (isOwnerRole(req.user!.role)) automation.push(projectSessionWorkRow(row));
        } else items.push(projectSessionWorkRow(row));
      }
      res.set('Cache-Control', 'private, no-store').json({ v: 1, fetchedAt: new Date().toISOString(), items, ...(isOwnerRole(req.user!.role) ? { automation } : {}) });
    } catch (error) { fail(res, error); }
  });
  router.post('/sessions/:key/goal', async (req, res) => {
    const native = nativeKey(req);
    const key = native || await keyFor(req, res); if (!key) return;
    const parsed = goalControlSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ v: 1, code: 'GOAL_INVALID' }); return; }
    const timeError = goalControlTimeError(parsed.data.issuedAtMs);
    if (timeError) { res.status(409).json({ v: 1, code: timeError }); return; }
    if (native) {
      try {
        const body = parsed.data as any;
        const goal = await controlNativeGoal({ key: native, actorUserId: req.user!.userId, action: body.action,
          goalId: body.goalId, objective: body.objective, note: body.note });
        res.json({ v: 1, result: { ok: true }, goal });
      } catch (error) { nativeFail(res, error); }
      return;
    }
    if (!getOpenClawCapabilities().goals) { res.status(409).json({ v: 1, code: 'GOAL_UNSUPPORTED' }); return; }
    try {
      const operation = await goalControlParams(key, parsed.data, rpc);
      if (!operation) { res.status(409).json({ v: 1, code: 'SESSION_CHANGED' }); return; }
      const result = await dependencies.mutate(key, req.user!, operation.method, operation.params);
      // Receipt replay is not current state. Read back even on stale/error receipts.
      const row = await describeSessionWork(key, rpc).catch(() => null);
      if (!result.ok) {
        const mapped = mapGoalControlFailure(result);
        res.status(mapped.status).json({ v: 1, ...mapped, goal: row?.goal || null }); return;
      }
      if (!row) { res.status(202).json({ v: 1, outcome: 'unconfirmed', result: result.data }); return; }
      publishSessionWorkChanged(key, ['goal', 'status']);
      res.json({ v: 1, result: result.data, goal: row.goal || null });
    } catch (error) { fail(res, error); }
  });
  const goalStartSchema = z.object({ objective: z.string().min(1).max(16000).refine(value => value.trim().length > 0),
    idempotencyKey: z.string().uuid(), issuedAtMs: z.number().int().nonnegative() }).strict();
  router.post('/sessions/:key/goal/start', async (req, res) => {
    const native = nativeKey(req);
    const key = native || await keyFor(req, res); if (!key) return;
    const parsed = goalStartSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ v: 1, code: 'GOAL_INVALID' }); return; }
    const timeError = goalControlTimeError(parsed.data.issuedAtMs);
    if (timeError) { res.status(409).json({ v: 1, code: timeError }); return; }
    if (native) {
      try {
        const goal = await startNativeGoal({ key: native, actorUserId: req.user!.userId, objective: parsed.data.objective });
        res.json({ v: 1, result: { ok: true }, goal });
      } catch (error) { nativeFail(res, error); }
      return;
    }
    const caps = getOpenClawCapabilities();
    if (!caps.goals || !caps.methods.includes('chat.send')) { res.status(409).json({ v: 1, code: 'GOAL_UNSUPPORTED' }); return; }
    try {
      const result = await dependencies.mutate(key, req.user!, 'chat.send', {
        sessionKey: key, message: parsed.data.objective, idempotencyKey: parsed.data.idempotencyKey,
        intent: { kind: 'session-goal-start', version: 1, issuedAtMs: parsed.data.issuedAtMs },
      });
      const row = await describeSessionWork(key, rpc).catch(() => null);
      if (!result.ok) {
        const mapped = mapGoalControlFailure(result);
        res.status(mapped.status).json({ v: 1, ...mapped, goal: row?.goal || null }); return;
      }
      publishSessionWorkChanged(key, ['goal', 'status']);
      res.status(row ? 200 : 202).json({ v: 1, result: result.data, goal: row?.goal || null, ...(!row ? { outcome: 'unconfirmed' } : {}) });
    } catch (error) { fail(res, error); }
  });
  const refreshSchema = z.object({ idempotencyKey: z.string().uuid() }).strict();
  router.post('/sessions/:key/progress/refresh', async (req, res) => {
    if (nativeKey(req)) { res.status(409).json({ v: 1, code: 'PROGRESS_UNSUPPORTED' }); return; }
    const key = await keyFor(req, res); if (!key) return;
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ v: 1, code: 'PROGRESS_INVALID' }); return; }
    const caps = getOpenClawCapabilities();
    if (!caps.progress || !caps.methods.includes('progressCard.refresh')) { res.status(409).json({ v: 1, code: 'PROGRESS_UNSUPPORTED' }); return; }
    try {
      const row = await describeSessionWork(key, rpc);
      if (!row?.agentId) { res.status(404).json({ v: 1, code: 'SESSION_NOT_FOUND' }); return; }
      const result = await dependencies.mutate(key, req.user!, 'progressCard.refresh', { sessionKey: key, agentId: row.agentId, ...parsed.data });
      if (!result.ok) {
        res.status(/timeout|closed|socket|WebSocket/i.test(result.errorMessage || '') ? 202 : 409).json({ v: 1, outcome: 'unconfirmed', code: 'PROGRESS_UNCONFIRMED' }); return;
      }
      res.json({ v: 1, result: result.data });
    } catch (error) { fail(res, error); }
  });
  return router;
}
