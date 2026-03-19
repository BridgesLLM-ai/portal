import { Router, Request, Response } from 'express';
import { exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Server as SocketIOServer } from 'socket.io';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { prisma } from '../config/database';
import { getToolAdapter, isInstallCommandAllowed, TOOL_ADAPTERS } from '../config/toolAdapters';

type DetectionStatus = {
  installed: boolean;
  version: string | null;
  missing: boolean;
  checkedAt: string;
};

type DetectionCacheEntry = {
  expiresAt: number;
  status: DetectionStatus;
};

const DETECTION_TIMEOUT_MS = 3000;
const DETECTION_CACHE_MS = 60_000;
const detectionCache = new Map<string, DetectionCacheEntry>();

const JOBS_DIR = path.join(process.env.PORTAL_ROOT || '/root/bridgesllm-product', '.data/jobs');
fs.mkdirSync(JOBS_DIR, { recursive: true });

const router = Router();
router.use(authenticateToken);

function parseVersion(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const semver = trimmed.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/);
  if (semver) return semver[0];
  return trimmed.split(/\r?\n/)[0]?.trim() || null;
}

function runDetect(command: string): Promise<DetectionStatus> {
  return new Promise((resolve) => {
    exec(command, { timeout: DETECTION_TIMEOUT_MS, shell: '/bin/bash' }, (error, stdout, stderr) => {
      const checkedAt = new Date().toISOString();
      if (error) {
        const missing = /not found|is not recognized|command not found/i.test(String(stderr || error.message));
        resolve({ installed: false, version: null, missing, checkedAt });
        return;
      }
      const out = `${stdout || ''}\n${stderr || ''}`;
      const version = parseVersion(out);
      resolve({ installed: true, version, missing: false, checkedAt });
    });
  });
}

async function detectWithCache(toolId: string, detectCommand?: string): Promise<DetectionStatus> {
  if (!detectCommand) {
    return { installed: true, version: null, missing: false, checkedAt: new Date().toISOString() };
  }

  const cached = detectionCache.get(toolId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.status;
  }

  const status = await runDetect(detectCommand);
  detectionCache.set(toolId, { status, expiresAt: Date.now() + DETECTION_CACHE_MS });
  return status;
}

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const tools = await Promise.all(
      TOOL_ADAPTERS.map(async (adapter) => {
        const status = await detectWithCache(adapter.id, adapter.detect?.command);
        return {
          ...adapter,
          status,
        };
      }),
    );

    res.json({ tools, cachedForMs: DETECTION_CACHE_MS });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to load agent tools' });
  }
});

router.post('/:toolId/install', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { toolId } = req.params;
  const adapter = getToolAdapter(toolId);

  if (!adapter) {
    res.status(404).json({ error: 'Tool adapter not found' });
    return;
  }

  if (!adapter.install.length) {
    res.status(400).json({ error: 'This adapter does not support install steps' });
    return;
  }

  const unallowed = adapter.install.find((step) => !isInstallCommandAllowed(step.command));
  if (unallowed) {
    res.status(400).json({ error: `Unsafe install step blocked: ${unallowed.label}` });
    return;
  }

  const transcriptPath = path.join(JOBS_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jsonl`);
  const job = await prisma.agentJob.create({
    data: {
      userId: req.user!.userId,
      toolId: '_install',
      title: `Install ${adapter.name}`,
      status: 'running',
      startedAt: new Date(),
      transcriptPath,
      metadata: {
        targetToolId: adapter.id,
        steps: adapter.install,
      },
    },
  });

  const io = req.app.get('io') as SocketIOServer | undefined;
  const room = `tool-install-${adapter.id}`;

  const append = async (entry: { type: 'input' | 'output' | 'system'; text: string; stream?: 'stdout' | 'stderr' }) => {
    const row = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    fs.appendFileSync(transcriptPath, `${JSON.stringify(row)}\n`, 'utf-8');
    io?.of('/ws/agent-jobs').to(room).emit('output', { toolId: adapter.id, entry: row, jobId: job.id });
    io?.of('/ws/agent-jobs').to(`job:${job.id}`).emit('output', { jobId: job.id, entry: row });
  };

  const runStep = (step: { label: string; command: string }) => new Promise<void>((resolve, reject) => {
    append({ type: 'system', text: `▶ ${step.label}` }).catch(() => {});
    append({ type: 'input', text: `${step.command}\n` }).catch(() => {});

    const child = spawn('/bin/bash', ['-lc', step.command], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: 'pipe',
    });

    child.stdout.on('data', (chunk) => {
      append({ type: 'output', stream: 'stdout', text: chunk.toString('utf-8') }).catch(() => {});
    });

    child.stderr.on('data', (chunk) => {
      append({ type: 'output', stream: 'stderr', text: chunk.toString('utf-8') }).catch(() => {});
    });

    child.on('error', (error) => reject(error));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Step failed with exit code ${code ?? -1}: ${step.label}`));
    });
  });

  (async () => {
    try {
      for (const step of adapter.install) {
        await runStep(step);
      }

      await append({ type: 'system', text: `✅ Install finished for ${adapter.name}` });
      await prisma.agentJob.update({
        where: { id: job.id },
        data: {
          status: 'completed',
          finishedAt: new Date(),
          exitCode: 0,
        },
      });
      detectionCache.delete(adapter.id);
    } catch (error: any) {
      await append({ type: 'system', text: `❌ Install failed: ${error?.message || 'Unknown error'}` });
      await prisma.agentJob.update({
        where: { id: job.id },
        data: {
          status: 'error',
          finishedAt: new Date(),
          exitCode: 1,
        },
      });
    }
  })().catch(() => {});

  res.status(202).json({
    jobId: job.id,
    room,
    toolId: adapter.id,
    message: `Install started for ${adapter.name}`,
  });
});

export default router;
