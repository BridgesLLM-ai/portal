import { Router, Request, Response } from 'express';
import os from 'os';
import fs from 'fs';
import { authenticateToken, requireAdmin } from '../middleware/auth';
import { calculateCpuUsage, parseCpuStat } from '../utils/cpuStat';

const router = Router();

// Require admin role for system stats — exposes server infrastructure details
router.use(authenticateToken, requireAdmin);

// Use host proc if mounted, otherwise container proc
const PROC = fs.existsSync('/host/proc/meminfo') ? '/host/proc' : '/proc';

function readProc(file: string): string {
  try {
    return fs.readFileSync(`${PROC}/${file}`, 'utf-8');
  } catch {
    return '';
  }
}

async function getCpuUsage(): Promise<{ overall: number; perCore: { core: number; usage: number }[] }> {
  const previous = parseCpuStat(readProc('stat'));
  await new Promise((resolve) => setTimeout(resolve, 125));
  return calculateCpuUsage(previous, parseCpuStat(readProc('stat')));
}

function getMemory() {
  const meminfo = readProc('meminfo');
  const parse = (key: string): number => {
    const match = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`));
    return match ? parseInt(match[1]) * 1024 : 0; // kB to bytes
  };

  const total = parse('MemTotal');
  const free = parse('MemFree');
  const available = parse('MemAvailable');
  const buffers = parse('Buffers');
  const cached = parse('Cached');
  const used = Math.max(0, total - (available || free + buffers + cached));

  return {
    total,
    used,
    free,
    available,
    buffers,
    cached,
    buffCache: buffers + cached,
    usagePercent: total > 0 ? Math.round((used / total) * 100 * 10) / 10 : 0,
  };
}

function getLoadAverages() {
  // Read from host proc for accurate load
  const loadavgStr = readProc('loadavg');
  const parts = loadavgStr.split(/\s+/);
  const [min1, min5, min15] = parts.length >= 3 
    ? [parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2])]
    : os.loadavg();
  return {
    '1min': Math.round(min1 * 100) / 100,
    '5min': Math.round(min5 * 100) / 100,
    '15min': Math.round(min15 * 100) / 100,
  };
}

function getDisk() {
  try {
    const stats = (fs as any).statfsSync('/');
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    const total = Number(stats.blocks || 0) * blockSize;
    const free = Number(stats.bfree || 0) * blockSize;
    const available = Number(stats.bavail ?? stats.bfree ?? 0) * blockSize;
    const used = Math.max(0, total - free);
    return [{
      mount: '/',
      total,
      used,
      available,
      usagePercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    }];
  } catch {
    return [];
  }
}

function getProcessCount(): number {
  try {
    return fs.readdirSync(PROC).filter((entry) => /^\d+$/.test(entry)).length;
  } catch {
    return 0;
  }
}

import http from 'http';

const MAX_DOCKER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DOCKER_CONTAINERS = 500;

function dockerApiGet(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: '/var/run/docker.sock', path }, (res) => {
      let settled = false;
      let received = 0;
      const chunks: Buffer[] = [];
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        fail(new Error(`Docker API returned HTTP ${res.statusCode || 0}`));
        return;
      }
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_DOCKER_RESPONSE_BYTES) {
          res.destroy();
          fail(new Error('Docker API response exceeded the safe size limit'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      res.on('end', () => {
        if (settled) return;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          settled = true;
          resolve(parsed);
        } catch {
          settled = true;
          reject(new Error('Invalid JSON'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getDockerStats(): Promise<{ available: boolean; containers: any[] }> {
  try {
    const containers = await dockerApiGet('/containers/json');
    if (!Array.isArray(containers)) return { available: false, containers: [] };

    const result = containers.slice(0, MAX_DOCKER_CONTAINERS).map((c: any) => ({
      id: c.Id?.substring(0, 12),
      name: String(c.Names?.[0] || '').replace(/^\//, '').slice(0, 256),
      image: String(c.Image || '').slice(0, 512),
      status: String(c.Status || '').slice(0, 512),
      state: String(c.State || '').slice(0, 100),
    }));

    return { available: true, containers: result };
  } catch {
    return { available: false, containers: [] };
  }
}

// Retired: raw peer/IP discovery was never an authorization boundary. The
// owner-only identity-bound Ollama Tailnet API replaces this endpoint.
router.get('/tailscale-peers', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(410).json({
    error: 'Raw Tailscale peer discovery is retired. Use the owner-only identity-bound Ollama setup flow.',
    code: 'TAILSCALE_PEER_PICKER_RETIRED',
  });
});

// GET /api/system/stats - real-time system metrics (no DB dependency)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const [cpu, memory, docker] = await Promise.all([
      getCpuUsage(),
      Promise.resolve(getMemory()),
      Promise.resolve(getDockerStats()),
    ]);

    // Read host uptime from /proc/uptime
    const uptimeStr = readProc('uptime');
    const hostUptime = uptimeStr ? parseFloat(uptimeStr.split(/\s+/)[0]) : os.uptime();
    const hostHostname = readProc('sys/kernel/hostname').trim() || os.hostname();

    res.json({
      timestamp: new Date().toISOString(),
      hostname: hostHostname,
      platform: os.platform(),
      arch: os.arch(),
      uptime: hostUptime,
      cpu,
      memory,
      loadAverage: getLoadAverages(),
      disk: getDisk(),
      processes: getProcessCount(),
      docker,
    });
  } catch (error: any) {
    console.error('System stats error:', error);
    res.status(500).json({ error: 'Failed to collect system stats' });
  }
});

export default router;
