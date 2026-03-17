import { Router, Request, Response } from 'express';
import si from 'systeminformation';
import os from 'os';
import { authenticateToken } from '../middleware/auth';
import { prisma } from '../config/database';

const router = Router();

export async function collectMetrics() {
  try {
    const [cpu, mem, disk, net, procs] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats(),
      si.processes(),
    ]);

    const diskMain = disk[0] || { use: 0, size: 0 };
    const netTotal = net.reduce(
      (acc, n) => ({
        rx: acc.rx + (n.rx_sec || 0),
        tx: acc.tx + (n.tx_sec || 0),
      }),
      { rx: 0, tx: 0 }
    );

    const loadAvg = os.loadavg(); // [1min, 5min, 15min]

    const metrics = await prisma.metrics.create({
      data: {
        cpuUsage: cpu.currentLoad || 0,
        memoryUsage: mem.total > 0 ? ((mem.total - mem.available) / mem.total) * 100 : 0,
        memoryTotal: BigInt(mem.total),
        diskUsage: diskMain.use || 0,
        diskTotal: BigInt(diskMain.size || 0),
        networkIn: BigInt(Math.round(netTotal.rx)),
        networkOut: BigInt(Math.round(netTotal.tx)),
        processCount: procs.all || 0,
        loadAverage: loadAvg,
        metadata: {
          memoryUsedBytes: mem.used,
          memoryFreeBytes: mem.available,
          diskUsedBytes: diskMain.used || 0,
          uptimeSeconds: os.uptime(),
          cpuCores: os.cpus().length,
          hostname: os.hostname(),
          platform: os.platform(),
        },
      },
    });

    return metrics;
  } catch (error) {
    console.error('Metrics collection error:', error);
    return null;
  }
}

function serializeMetrics(m: any) {
  return {
    ...m,
    memoryTotal: m.memoryTotal.toString(),
    diskTotal: m.diskTotal.toString(),
    networkIn: m.networkIn.toString(),
    networkOut: m.networkOut.toString(),
  };
}

// GET /api/metrics - latest
router.get('/', authenticateToken, async (_req: Request, res: Response) => {
  try {
    const latest = await prisma.metrics.findFirst({
      orderBy: { timestamp: 'desc' },
    });
    if (!latest) { res.json({ metrics: null }); return; }
    res.json({ metrics: serializeMetrics(latest) });
  } catch (error) {
    console.error('Get metrics error:', error);
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

// GET /api/metrics/latest - alias
router.get('/latest', authenticateToken, async (_req: Request, res: Response) => {
  try {
    const latest = await prisma.metrics.findFirst({
      orderBy: { timestamp: 'desc' },
    });
    if (!latest) { res.json(null); return; }
    res.json(serializeMetrics(latest));
  } catch (error) {
    console.error('Get metrics error:', error);
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

// GET /api/metrics/history - last N hours (default 6)
router.get('/history', authenticateToken, async (req: Request, res: Response) => {
  try {
    const hours = parseInt(req.query.hours as string) || 6;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const history = await prisma.metrics.findMany({
      where: { timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
    });

    res.json(history.map(serializeMetrics));
  } catch (error) {
    console.error('Get metrics history error:', error);
    res.status(500).json({ error: 'Failed to get metrics history' });
  }
});

// Cleanup old metrics (keep 7 days)
async function cleanupOldMetrics() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await prisma.metrics.deleteMany({ where: { timestamp: { lt: sevenDaysAgo } } });
  } catch (e) {
    console.error('Metrics cleanup error:', e);
  }
}

// Run cleanup every 6 hours
setInterval(cleanupOldMetrics, 6 * 60 * 60 * 1000);

export default router;
