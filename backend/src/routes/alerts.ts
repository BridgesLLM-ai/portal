import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { prisma } from '../config/database';
import { ingestAlert } from '../utils/logWatcher';
import { requireAdmin } from '../middleware/requireAdmin';

const router = Router();
router.use(authenticateToken, requireAdmin);

// GET /api/alerts - Get system alerts (activity logs with SYSTEM_ALERT action)
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
    const severity = req.query.severity as string | undefined;
    const since = req.query.since as string | undefined; // ISO timestamp for polling

    const where: any = { action: 'SYSTEM_ALERT' };
    if (severity && ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].includes(severity)) where.severity = severity;
    if (since) {
      const sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) {
        res.status(400).json({ error: 'Invalid since timestamp' });
        return;
      }
      where.createdAt = { gt: sinceDate };
    }

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
router.post('/', async (req: Request, res: Response) => {
  try {
    const { severity, component, message, metadata } = req.body;
    if (
      !['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].includes(severity)
      || typeof component !== 'string'
      || component.length < 1
      || component.length > 120
      || typeof message !== 'string'
      || message.length < 1
      || message.length > 4000
    ) {
      res.status(400).json({ error: 'Valid severity, component, and message are required' });
      return;
    }
    if (metadata !== undefined && Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 16 * 1024) {
      res.status(400).json({ error: 'Alert metadata is too large' });
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
router.post('/:id/dismiss', async (req: Request, res: Response) => {
  try {
    if (!req.params.id || req.params.id.length > 100) {
      res.status(400).json({ error: 'Invalid alert ID' });
      return;
    }
    const existing = await prisma.activityLog.findFirst({
      where: { id: req.params.id, action: 'SYSTEM_ALERT' },
      select: { id: true, metadata: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }
    const alert = await prisma.activityLog.update({
      where: { id: existing.id },
      data: {
        metadata: {
          ...((existing.metadata as any) || {}),
          dismissedAt: new Date().toISOString(),
          dismissedBy: req.user?.userId,
        },
      },
    });
    res.json({ alert });
  } catch {
    res.status(500).json({ error: 'Failed to dismiss alert' });
  }
});

export default router;
