import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { prisma } from '../config/database';
import { ingestAlert } from '../utils/logWatcher';

const router = Router();

// GET /api/alerts - Get system alerts (activity logs with SYSTEM_ALERT action)
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = parseInt(req.query.offset as string) || 0;
    const severity = req.query.severity as string | undefined;
    const since = req.query.since as string | undefined; // ISO timestamp for polling

    const where: any = { action: 'SYSTEM_ALERT' };
    if (severity) where.severity = severity;
    if (since) where.createdAt = { gt: new Date(since) };

    const [alerts, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.activityLog.count({ where }),
    ]);

    res.json({ alerts, total });
  } catch (error) {
    console.error('Alerts fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// POST /api/alerts - Manually ingest an alert
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { severity, component, message, metadata } = req.body;
    if (!severity || !component || !message) {
      res.status(400).json({ error: 'severity, component, and message required' });
      return;
    }

    const record = await ingestAlert(severity, component, message, metadata);
    if (!record) {
      res.json({ deduplicated: true, message: 'Alert deduplicated (same error within 5min)' });
      return;
    }
    res.json({ alert: record });
  } catch (error) {
    console.error('Alert ingest error:', error);
    res.status(500).json({ error: 'Failed to ingest alert' });
  }
});

// POST /api/alerts/:id/dismiss - Dismiss an alert
router.post('/:id/dismiss', authenticateToken, async (req: Request, res: Response) => {
  try {
    const alert = await prisma.activityLog.update({
      where: { id: req.params.id },
      data: {
        metadata: {
          ...(await prisma.activityLog.findUnique({ where: { id: req.params.id } }).then(a => (a?.metadata as any) || {})),
          dismissedAt: new Date().toISOString(),
          dismissedBy: req.user?.userId,
        },
      },
    });
    res.json({ alert });
  } catch (error) {
    res.status(500).json({ error: 'Failed to dismiss alert' });
  }
});

export default router;
