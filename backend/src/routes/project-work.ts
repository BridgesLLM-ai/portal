import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { prisma } from '../config/database';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { requireApproved } from '../middleware/requireApproved';
import { assertProjectIdentityRoot } from '../services/projectIdentity';
import { withProjectWorkScope } from '../services/projectWorkScope';
import { ACTIVE_WORK_STATUSES, attestProjectWork, claimProjectWork, failUndispatchedProjectWork,
  projectWorkPrompt, readProjectWorkReplay, withProjectWorkHost } from '../services/projectWorkHost';
import { syncAskUserQuestionsForActor } from '../services/nativeAskUserQuestionChannel';
import { listPendingNativeCliApprovals } from '../agents/nativeCliApprovals';
import { readPendingAskUserQuestionForActor } from '../services/askUserQuestionBroker';

const workers = new Set(['CODEX', 'CLAUDE_CODE', 'OPENCLAW', 'GROK', 'GEMINI', 'HERMES', 'OPENCODE', 'OLLAMA']);
function value(input: unknown, max: number): string {
  if (typeof input !== 'string' || !input.trim() || input.length > max || input.includes('\0')) {
    throw Object.assign(new Error('Invalid project work request.'), { status: 400 });
  }
  return input.trim();
}
const guarded = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => (
  req: Request, res: Response, next: NextFunction,
) => { void fn(req, res, next).catch((error) => {
  if (res.headersSent) return next(error);
  res.status(error.status || 503).json({
    error: error.status ? error.message : 'Project work is temporarily unavailable.',
    code: error.code || 'PROJECT_WORK_UNAVAILABLE',
  });
}); };

// Origin keys are navigation references, never provider-session credentials or
// execution authority. Every read is actor-scoped; only existing host-chat
// roles can create work. Existing host-chat admission authorizes execution.
export function createProjectWorkRouter(projectRoutes: Router, gatewayRoutes: Router): Router {
  const router = Router();
  router.use(authenticateToken, requireApproved, requireAdmin);
  const findCard = async (req: Request) => {
    const card = await prisma.projectWorkCard.findFirst({
      where: { id: req.params.id, actorUserId: req.user!.userId },
      include: { projectIdentity: true },
    });
    if (!card) throw Object.assign(new Error('Project work not found.'), { status: 404 });
    const project = card.projectIdentity;
    if (project.workspaceOwnerId !== req.user!.userId) {
      throw Object.assign(new Error('Project work not found.'), { status: 404 });
    }
    return card;
  };
  router.get('/', guarded(async (req, res) => {
    const actorUserId = req.user!.userId;
    const filter = req.query.projectIdentityId
      ? { projectIdentityId: value(req.query.projectIdentityId, 128) }
      : { originProvider: value(req.query.originProvider, 40), originSessionKey: value(req.query.originSessionKey, 512) };
    const cards = await prisma.projectWorkCard.findMany({
      where: { actorUserId, ...filter, projectIdentity: { workspaceOwnerId: actorUserId } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 80,
      select: { id: true, originProvider: true, originSessionKey: true, projectIdentityId: true,
        projectGeneration: true, projectName: true, provider: true, model: true, prompt: true,
        createdAt: true, parentCardId: true, requestId: true, status: true,
        projectIdentity: { select: { projectName: true, generation: true, lifecycleStatus: true } } },
    });
    const result = cards.map((card) => ({ ...card,
      turn: card.status === 'DRAFT' ? null : { id: card.requestId, status: card.status },
      scopeValid: card.projectIdentity.generation === card.projectGeneration
        && card.projectIdentity.projectName === card.projectName && card.projectIdentity.lifecycleStatus === 'ACTIVE',
    }));
    res.json({ cards: result.reverse() });
  }));
  router.post('/', guarded(async (req, res) => {
    const actorUserId = req.user!.userId;
    const provider = value(req.body.provider, 40);
    if (!workers.has(provider)) throw Object.assign(new Error('Choose a supported Agent Chat harness.'), { status: 400 });
    const id = value(req.body.id, 128);
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw Object.assign(new Error('Invalid work identity.'), { status: 400 });
    const data = {
      model: req.body.model ? value(req.body.model, 256) : null,
      id, actorUserId, actorAuthorizationVersion: Number(req.user!.authorizationVersion ?? 1), provider, originProvider: value(req.body.originProvider, 40),
      originSessionKey: value(req.body.originSessionKey, 512),
      projectIdentityId: value(req.body.projectIdentityId, 128),
      projectGeneration: req.body.projectGeneration,
      prompt: value(req.body.prompt, 24000), parentCardId: req.body.parentCardId ? value(req.body.parentCardId, 128) : null,
    };
    const existing = await prisma.projectWorkCard.findUnique({ where: { id } });
    if (existing) {
      if (Object.keys(data).some((key) => existing[key as keyof typeof existing] !== data[key as keyof typeof data])) {
        throw Object.assign(new Error('This request identity already belongs to different work.'), { status: 409 });
      }
      res.json(existing); return;
    }
    const project = await prisma.projectIdentity.findFirst({ where: {
      id: data.projectIdentityId, workspaceOwnerId: actorUserId, lifecycleStatus: 'ACTIVE',
    } });
    if (!project) throw Object.assign(new Error('Project not found.'), { status: 404 });
    if (project.generation !== data.projectGeneration) throw Object.assign(new Error('Project changed. Select it again.'), { status: 409 });
    assertProjectIdentityRoot(project, project.canonicalRoot);
    if (data.parentCardId) {
      const parent = await prisma.projectWorkCard.findFirst({ where: {
        id: data.parentCardId, actorUserId, originProvider: data.originProvider,
        originSessionKey: data.originSessionKey, projectIdentityId: project.id,
        projectGeneration: project.generation, provider, model: data.model,
      } });
      if (!parent) throw Object.assign(new Error('Follow-up belongs to another project or conversation.'), { status: 409 });
    }
    const card = await prisma.projectWorkCard.create({ data: { ...data, projectName: project.projectName, requestId: randomUUID() } });
    res.status(201).json(card);
  }));
  router.all('/:id/:action', guarded(async (req, res, next) => {
    const action = req.params.action;
    const allowed: Record<string, string> = { send: 'POST', poll: 'GET', stop: 'POST', files: 'GET', file: 'GET', raw: 'GET', 'git-status': 'GET', diff: 'GET', questions: 'GET', approvals: 'GET' };
    if (allowed[action] !== req.method) { res.sendStatus(404); return; }
    const card = await findCard(req);
    if (action === 'poll') { res.json(await readProjectWorkReplay(card)); return; }
    if (req.method !== 'GET' && card.actorAuthorizationVersion !== Number(req.user!.authorizationVersion ?? 1)) {
      throw Object.assign(new Error('Your access changed. Start new work with your current access.'), { status: 409 });
    }
    const project = await attestProjectWork(card);
    if (action === 'approvals') {
      const replay = await readProjectWorkReplay(card);
      const approvals = card.sessionId && (replay.active || replay.uncertain)
        ? listPendingNativeCliApprovals().filter((approval) => approval.request.sessionKey === card.sessionId
          && approval.createdAtMs >= (card.startedAt?.getTime() || Number.MAX_SAFE_INTEGER)) : [];
      res.json({ approvals }); return;
    }
    if (action === 'questions') {
      if (!card.sessionId || !['RUNNING', 'UNCERTAIN'].includes(card.status)) { res.json({ questions: [] }); return; }
      const pending = await syncAskUserQuestionsForActor({ actorUserId: card.actorUserId,
        actorAuthorizationVersion: Number(req.user!.authorizationVersion ?? 1), sessionKey: card.sessionId });
      res.json({ questions: pending.filter((question) => {
        try {
          const record = readPendingAskUserQuestionForActor(question.id, card.actorUserId);
          return record.surface === 'agent-chat' && record.authorityId === card.requestId && record.sessionKey === card.sessionId;
        } catch { return false; }
      }) }); return;
    }
    if (action === 'git-status' || action === 'diff') {
      req.body = action === 'diff' ? { action: 'diff', file: value(req.query.path, 4096) } : { action: 'status', details: true };
      req.query = {}; req.method = 'POST'; req.url = `/${encodeURIComponent(project.projectName)}/git`;
      withProjectWorkScope({ id: project.id, generation: card.projectGeneration, workspaceOwnerId: card.actorUserId,
        projectName: project.projectName }, () => projectRoutes(req, res, next)); return;
    }
    if (action === 'file' || action === 'files' || action === 'raw') {
      const filePath = typeof req.query.path === 'string' ? req.query.path : '';
      req.query = { path: filePath };
      req.url = `/${encodeURIComponent(project.projectName)}/${action === 'files' ? 'tree' : action}`;
      withProjectWorkScope({ id: project.id, generation: card.projectGeneration, workspaceOwnerId: card.actorUserId,
        projectName: project.projectName }, () => projectRoutes(req, res, next)); return;
    }
    if (action === 'stop') {
      if (!card.sessionId || !ACTIVE_WORK_STATUSES.includes(card.status)) { res.json({ ok: false }); return; }
      const openclawRun = card.provider === 'OPENCLAW' ? await prisma.openClawHostRun.findUnique({ where: { id: card.requestId } }) : null;
      req.body = { provider: card.provider, session: card.sessionId,
        runId: openclawRun?.upstreamRunId || card.requestId };
      req.query = {}; req.url = '/chat/abort';
      gatewayRoutes(req, res, next); return;
    }
    if (!await claimProjectWork(card)) { res.json({ accepted: false, alreadyDispatched: true }); return; }
    // Existing host routes own runtime admission, detached authorization leases,
    // provider journals, approval handling and exactly-scoped cancellation.
    // No client-supplied path/session/prompt reaches that dispatch.
    req.body = { provider: card.provider, session: card.sessionId || '', message: projectWorkPrompt(card), model: card.model || undefined };
    req.query = {}; req.url = '/send';
    delete req.headers.accept;
    const originalJson = res.json.bind(res);
    res.json = ((body: any) => {
      if (res.statusCode >= 400) {
        void failUndispatchedProjectWork(card.id, typeof body?.error === 'string' ? body.error : 'The worker could not start.')
          .then(() => originalJson(body)).catch(next);
        return res;
      }
      return originalJson(body);
    }) as typeof res.json;
    withProjectWorkHost(card, () => gatewayRoutes(req, res, next));
  }));
  return router;
}
