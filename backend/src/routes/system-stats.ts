import { Router, Request, Response } from 'express';
import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';
import { authenticateToken, requireAdmin } from '../middleware/auth';

const router = Router();

// Require admin role for system stats — exposes server infrastructure details
router.use(authenticateToken, requireAdmin);

// Use host proc if mounted, otherwise container proc
const PROC = fs.existsSync('/host/proc/meminfo') ? '/host/proc' : '/proc';

function safeExec(cmd: string): string {
  try {
    return execSync(cmd, { timeout: 5000, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function readProc(file: string): string {
  try {
    return fs.readFileSync(`${PROC}/${file}`, 'utf-8');
  } catch {
    return '';
  }
}

function getCpuUsage(): { overall: number; perCore: { core: number; usage: number }[] } {
  const stat = readProc('stat');
  const lines = stat.split('\n').filter(l => l.startsWith('cpu'));

  const parseLine = (line: string) => {
    const parts = line.split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  };

  let overall = 0;
  const perCore: { core: number; usage: number }[] = [];

  for (const line of lines) {
    const { idle, total } = parseLine(line);
    const usage = total > 0 ? Math.round(((total - idle) / total) * 100 * 10) / 10 : 0;
    if (line.startsWith('cpu ')) {
      overall = usage;
    } else {
      const coreNum = parseInt(line.replace('cpu', ''));
      perCore.push({ core: coreNum, usage });
    }
  }

  return { overall, perCore };
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
  const slab = parse('Slab');
  const used = total - free - buffers - cached - slab;

  return {
    total,
    used,
    free,
    available,
    buffers,
    cached,
    buffCache: buffers + cached,
    usagePercent: Math.round((used / total) * 100 * 10) / 10,
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
  const dfOutput = safeExec('df -B1 --output=target,size,used,avail,pcent 2>/dev/null || df -k');
  const lines = dfOutput.split('\n').slice(1).filter(l => l.trim());
  
  return lines
    .filter(l => l.startsWith('/') && !l.includes('/proc') && !l.includes('/sys'))
    .map(line => {
      const parts = line.split(/\s+/);
      return {
        mount: parts[0],
        total: parseInt(parts[1]) || 0,
        used: parseInt(parts[2]) || 0,
        available: parseInt(parts[3]) || 0,
        usagePercent: parseFloat((parts[4] || '0').replace('%', '')),
      };
    });
}

function getProcessCount(): number {
  const raw = safeExec(`ls -1d ${PROC}/[0-9]* 2>/dev/null | wc -l`);
  return parseInt(raw) || 0;
}

import http from 'http';

function dockerApiGet(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: '/var/run/docker.sock', path }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
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

    const result = containers.map((c: any) => ({
      id: c.Id?.substring(0, 12),
      name: (c.Names?.[0] || '').replace(/^\//, ''),
      image: c.Image,
      status: c.Status,
      state: c.State,
    }));

    return { available: true, containers: result };
  } catch {
    return { available: false, containers: [] };
  }
}

// GET /api/system/stats/tailscale-peers - Tailscale network peers for Ollama setup
router.get('/tailscale-peers', async (_req: Request, res: Response) => {
  try {
    const { execSync } = await import('child_process');
    let status = '';
    let available = false;
    try {
      status = execSync('tailscale status --json 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
      available = true;
    } catch {
      res.json({ available: false, peers: [], self: null });
      return;
    }
    const data = JSON.parse(status);
    const self = data.Self ? {
      hostname: data.Self.HostName || data.Self.DNSName?.split('.')[0] || '',
      ip: data.Self.TailscaleIPs?.[0] || '',
      os: data.Self.OS || '',
      online: data.Self.Online ?? true,
    } : null;
    const peers = Object.values(data.Peer || {}).map((p: any) => ({
      hostname: p.HostName || p.DNSName?.split('.')[0] || '',
      ip: p.TailscaleIPs?.[0] || '',
      os: p.OS || '',
      online: p.Online ?? false,
      lastSeen: p.LastSeen || null,
    }));
    res.json({ available, self, peers });
  } catch (error: any) {
    res.json({ available: false, peers: [], self: null, error: error.message });
  }
});

// GET /api/system/stats - real-time system metrics (no DB dependency)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const [cpu, memory, docker] = await Promise.all([
      Promise.resolve(getCpuUsage()),
      Promise.resolve(getMemory()),
      Promise.resolve(getDockerStats()),
    ]);

    // Read host uptime from /proc/uptime
    const uptimeStr = readProc('uptime');
    const hostUptime = uptimeStr ? parseFloat(uptimeStr.split(/\s+/)[0]) : os.uptime();
    const hostHostname = safeExec(`cat ${PROC}/sys/kernel/hostname 2>/dev/null`).trim() || os.hostname();

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
    res.status(500).json({ error: 'Failed to collect system stats', message: error.message });
  }
});

export default router;
