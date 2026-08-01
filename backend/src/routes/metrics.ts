import { Router, Request, Response } from 'express';
import os from 'os';
import fs from 'fs';
import { authenticateToken } from '../middleware/auth';
import { prisma } from '../config/database';
import {
  MAX_METRICS_HISTORY_POINTS,
  parseMetricsHistoryHours,
} from '../utils/metricsHistory';

const router = Router();

const PROC_NET_DEV_PATH = '/proc/net/dev';

// Loopback, container veth pairs, bridges, and tunnels are excluded so traffic
// is not double-counted when it also crosses the physical interface.
const NETWORK_INTERFACE_EXCLUDE = /^(lo$|veth|docker|br-|virbr|tun|tap|wg|tailscale)/;

export interface NetworkCounterSample {
  rxBytes: number;
  txBytes: number;
}

export interface NetworkRateSample {
  inBytesPerSecond: number;
  outBytesPerSecond: number;
  available: boolean;
}

export function parseProcNetDev(text: string): NetworkCounterSample | null {
  let rxBytes = 0;
  let txBytes = 0;
  let matched = false;
  for (const line of text.split('\n')) {
    const parts = line.match(/^\s*([^:\s]+):\s*(.+)$/);
    if (!parts) continue;
    const name = parts[1];
    if (NETWORK_INTERFACE_EXCLUDE.test(name)) continue;
    const fields = parts[2].trim().split(/\s+/);
    // /proc/net/dev row: rx bytes is field 0, tx bytes is field 8.
    const rx = Number(fields[0]);
    const tx = Number(fields[8]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    rxBytes += rx;
    txBytes += tx;
    matched = true;
  }
  return matched ? { rxBytes, txBytes } : null;
}

export function computeNetworkRates(
  previous: { atMs: number } & NetworkCounterSample,
  current: { atMs: number } & NetworkCounterSample,
): NetworkRateSample {
  const elapsedSeconds = (current.atMs - previous.atMs) / 1000;
  if (elapsedSeconds < 1) {
    return { inBytesPerSecond: 0, outBytesPerSecond: 0, available: false };
  }
  const rxDelta = current.rxBytes - previous.rxBytes;
  const txDelta = current.txBytes - previous.txBytes;
  if (rxDelta < 0 || txDelta < 0) {
    // Counter reset (interface bounce or wrap): re-baseline instead of
    // reporting a false spike or a false zero measurement.
    return { inBytesPerSecond: 0, outBytesPerSecond: 0, available: false };
  }
  return {
    inBytesPerSecond: rxDelta / elapsedSeconds,
    outBytesPerSecond: txDelta / elapsedSeconds,
    available: true,
  };
}

let previousNetworkSample: ({ atMs: number } & NetworkCounterSample) | null = null;

export function resetNetworkRateStateForTests() {
  previousNetworkSample = null;
}

async function collectNetworkRates(): Promise<NetworkRateSample> {
  let counters: NetworkCounterSample | null = null;
  try {
    counters = parseProcNetDev(await fs.promises.readFile(PROC_NET_DEV_PATH, 'utf8'));
  } catch { /* /proc may be unavailable in some installs */ }
  if (!counters) {
    previousNetworkSample = null;
    return { inBytesPerSecond: 0, outBytesPerSecond: 0, available: false };
  }
  const current = { atMs: Date.now(), ...counters };
  const previous = previousNetworkSample;
  previousNetworkSample = current;
  if (!previous) {
    return { inBytesPerSecond: 0, outBytesPerSecond: 0, available: false };
  }
  return computeNetworkRates(previous, current);
}

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
    const diskFree = Number(statfs.bfree ?? statfs.bavail ?? 0) * blockSize;
    diskUsed = Math.max(diskTotal - diskFree, 0);
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
    // Network rates come from one async /proc/net/dev read per sample; the
    // stored value is bytes/second (the dashboard renders MB/s).
    const network = await collectNetworkRates();

    const metrics = await prisma.metrics.create({
      data: {
        cpuUsage: host.cpuUsage,
        memoryUsage: host.memoryUsage,
        memoryTotal: BigInt(host.memoryTotal),
        diskUsage: host.diskUsage,
        diskTotal: BigInt(host.diskTotal),
        networkIn: BigInt(Math.max(0, Math.round(network.inBytesPerSecond))),
        networkOut: BigInt(Math.max(0, Math.round(network.outBytesPerSecond))),
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
          networkMetricsAvailable: network.available,
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
    const hours = parseMetricsHistoryHours(req.query.hours);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const history = await prisma.metrics.findMany({
      where: { timestamp: { gte: since } },
      orderBy: { timestamp: 'desc' },
      take: MAX_METRICS_HISTORY_POINTS,
    });

    res.json(history.reverse().map(serializeMetrics));
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
const cleanupTimer = setInterval(cleanupOldMetrics, 6 * 60 * 60 * 1000);
cleanupTimer.unref?.();

export default router;
