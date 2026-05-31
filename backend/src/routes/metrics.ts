import { Router, Request, Response } from 'express';
import si from 'systeminformation';
import os from 'os';
import fs from 'fs';
import { authenticateToken } from '../middleware/auth';
import { prisma } from '../config/database';

const router = Router();

function collectLightweightHostMetrics() {
  const loadAvg = os.loadavg(); // [1min, 5min, 15min]
  const cpuCores = Math.max(os.cpus().length || 1, 1);
  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const memoryUsed = Math.max(memoryTotal - memoryFree, 0);

  let processCount = 0;
  try {
    processCount = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).length;
  } catch { /* /proc may be unavailable in some installs */ }

  let diskTotal = 0;
  let diskUsed = 0;
  try {
    const statfs = (fs as any).statfsSync('/');
    const blockSize = Number(statfs.bsize || statfs.frsize || 0);
    diskTotal = Number(statfs.blocks || 0) * blockSize;
    const diskAvailable = Number(statfs.bavail ?? statfs.bfree ?? 0) * blockSize;
    diskUsed = Math.max(diskTotal - diskAvailable, 0);
  } catch { /* non-fatal */ }

  return {
    cpuUsage: Math.min(100, Math.max(0, (loadAvg[0] / cpuCores) * 100)),
    memoryUsage: memoryTotal > 0 ? (memoryUsed / memoryTotal) * 100 : 0,
    memoryTotal,
    memoryUsed,
    memoryFree,
    diskUsage: diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0,
    diskTotal,
    diskUsed,
    networkIn: 0,
    networkOut: 0,
    processCount,
    loadAvg,
    cpuCores,
  };
}

export async function collectMetrics() {
  try {
    // Emergency CPU containment: avoid systeminformation.processes(), which shells
    // out into a giant `/proc/*/stat` scan on this host. During throttling that can
    // wedge the portal event loop and make even /health time out.
    const host = collectLightweightHostMetrics();

    const metrics = await prisma.metrics.create({
      data: {
        cpuUsage: host.cpuUsage,
        memoryUsage: host.memoryUsage,
        memoryTotal: BigInt(host.memoryTotal),
        diskUsage: host.diskUsage,
        diskTotal: BigInt(host.diskTotal),
        networkIn: BigInt(host.networkIn),
        networkOut: BigInt(host.networkOut),
        processCount: host.processCount,
        loadAverage: host.loadAvg,
        metadata: {
          memoryUsedBytes: host.memoryUsed,
          memoryFreeBytes: host.memoryFree,
          diskUsedBytes: host.diskUsed,
          uptimeSeconds: os.uptime(),
          cpuCores: host.cpuCores,
          hostname: os.hostname(),
          platform: os.platform(),
          lightweightCollector: true,
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
