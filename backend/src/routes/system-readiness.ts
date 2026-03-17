import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { prisma } from '../config/database';
import { buildFeatureReadinessReport } from '../config/featureReadiness';

const router = Router();

router.use(authenticateToken);
router.use(requireAdmin);

router.get('/', async (_req: Request, res: Response) => {
  try {
    const settingsRows = await prisma.systemSetting.findMany({
      where: { key: { in: ['remoteDesktop.url', 'remoteDesktop.allowedPathPrefixes', 'ollama.remoteHost'] } },
    });

    const settings = settingsRows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    const report = await buildFeatureReadinessReport(settings);
    res.json(report);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to compute feature readiness' });
  }
});

export default router;
