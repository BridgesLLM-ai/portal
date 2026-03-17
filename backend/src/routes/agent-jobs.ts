import { Router, Request, Response } from 'express';
import { prisma } from '../config/database';
import { authenticateToken } from '../middleware/auth';
import { requireApproved } from '../middleware/requireApproved';
import { requireAdmin } from '../middleware/requireAdmin';
import { killAgentJob, readTranscript, startAgentJob, writeToAgentJob } from '../services/agentJobs';
import { isElevatedRole } from '../utils/authz';

const router = Router();

router.use(authenticateToken);

function canAccessAll(req: Request): boolean {
  return isElevatedRole(req.user?.role);
}

// POST /api/agent-jobs
router.post('/', requireApproved, requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { toolId, title, command, cwd, env } = req.body || {};

    if (!toolId || !command || typeof toolId !== 'string' || typeof command !== 'string') {
      res.status(400).json({ error: 'toolId and command are required' });
      return;
    }

    const safeEnv = env && typeof env === 'object'
      ? Object.fromEntries(Object.entries(env).filter(([k, v]) => typeof k === 'string' && typeof v === 'string')) as Record<string, string>
      : undefined;

    const job = await startAgentJob({
      userId: req.user!.userId,
      toolId,
      title: typeof title === 'string' ? title : undefined,
      command,
      cwd: typeof cwd === 'string' ? cwd : undefined,
      env: safeEnv,
    });

    res.status(201).json(job);
  } catch (error: any) {
    console.error('[agent-jobs] start failed', error);
    res.status(500).json({ error: error?.message || 'Failed to start job' });
  }
});

// GET /api/agent-jobs
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const where = canAccessAll(req) ? {} : { userId: req.user!.userId };

    const jobs = await prisma.agentJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        userId: true,
        toolId: true,
        title: true,
        status: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        exitCode: true,
      },
    });

    res.json(jobs);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to list jobs' });
  }
});

// GET /api/agent-jobs/:id
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const job = await prisma.agentJob.findUnique({ where: { id: req.params.id } });
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    if (!canAccessAll(req) && job.userId !== req.user!.userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const transcript = await readTranscript(job.id);
    res.json({ ...job, transcript });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch job' });
  }
});

// POST /api/agent-jobs/:id/input
router.post('/:id/input', async (req: Request, res: Response): Promise<void> => {
  try {
    const { input } = req.body || {};
    if (typeof input !== 'string' || !input.length) {
      res.status(400).json({ error: 'input is required' });
      return;
    }

    const job = await prisma.agentJob.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (!canAccessAll(req) && job.userId !== req.user!.userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    await writeToAgentJob(req.params.id, job.userId, input);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to send input' });
  }
});

// POST /api/agent-jobs/:id/kill
router.post('/:id/kill', async (req: Request, res: Response): Promise<void> => {
  try {
    const job = await prisma.agentJob.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    if (!canAccessAll(req) && job.userId !== req.user!.userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    await killAgentJob(req.params.id, job.userId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to kill job' });
  }
});

export default router;
