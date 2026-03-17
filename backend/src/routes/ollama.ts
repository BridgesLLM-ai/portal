import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import type { Server as SocketIOServer } from 'socket.io';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { prisma } from '../config/database';
import os from 'os';

const router = Router();
router.use(authenticateToken);

const DEFAULT_LOCAL_HOST = 'http://localhost:11434';

type OllamaModel = {
  name: string;
  size?: number;
  modified_at?: string;
  digest?: string;
  details?: Record<string, any>;
};

function normalizeBaseUrl(input?: string | null): string {
  const raw = (input || '').trim();
  if (!raw) return DEFAULT_LOCAL_HOST;
  return raw.replace(/\/+$/, '');
}

async function getSettings(keys: string[]): Promise<Record<string, string>> {
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: keys } } });
  return rows.reduce<Record<string, string>>((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

function getRecommendationsByRam(totalBytes: number) {
  const gb = totalBytes / (1024 ** 3);
  if (gb < 4) {
    return {
      ramTier: '<4GB',
      warning: 'Low-memory VPS detected. Stick to tiny models.',
      recommendedModels: ['phi3:mini', 'tinyllama'],
    };
  }
  if (gb < 8) {
    return {
      ramTier: '4-8GB',
      warning: null,
      recommendedModels: ['llama3.2:3b', 'mistral:7b'],
    };
  }
  if (gb < 16) {
    return {
      ramTier: '8-16GB',
      warning: null,
      recommendedModels: ['llama3.1:8b', 'mistral:7b', 'codellama:7b'],
    };
  }
  return {
    ramTier: '16GB+',
    warning: null,
    recommendedModels: ['llama3.1:70b', 'deepseek-coder:33b'],
  };
}

async function listModelsFromHost(baseUrl: string): Promise<OllamaModel[]> {
  const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as any;
  return Array.isArray(data?.models) ? data.models : [];
}

router.get('/models', async (_req: Request, res: Response) => {
  try {
    const settings = await getSettings(['ollama.host', 'ollama.remoteHost', 'ollama.localEnabled']);
    const localEnabled = settings['ollama.localEnabled'] !== 'false';
    const localHost = normalizeBaseUrl(settings['ollama.host']);
    const remoteHost = (settings['ollama.remoteHost'] || '').trim();

    const candidates: Array<{ source: 'local' | 'remote'; url: string }> = [];
    if (localEnabled) candidates.push({ source: 'local', url: localHost });
    if (remoteHost) candidates.push({ source: 'remote', url: normalizeBaseUrl(remoteHost) });
    if (!candidates.length) candidates.push({ source: 'local', url: DEFAULT_LOCAL_HOST });

    for (const candidate of candidates) {
      try {
        const models = await listModelsFromHost(candidate.url);
        res.json({
          source: candidate.source,
          endpoint: candidate.url,
          models: models.map((m) => ({
            name: m.name,
            size: m.size,
            modifiedAt: m.modified_at,
            digest: m.digest,
            details: m.details || {},
          })),
        });
        return;
      } catch {}
    }

    res.json({ source: 'unavailable', endpoint: null, models: [] });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to list Ollama models' });
  }
});

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const settings = await getSettings(['ollama.host', 'ollama.remoteHost', 'ollama.localEnabled']);
    const localEnabled = settings['ollama.localEnabled'] !== 'false';
    const localHost = normalizeBaseUrl(settings['ollama.host']);
    const remoteHost = (settings['ollama.remoteHost'] || '').trim();

    const checks: any[] = [];

    if (localEnabled) {
      try {
        const r = await fetch(`${localHost}/api/tags`, { signal: AbortSignal.timeout(3000) });
        checks.push({ source: 'local', endpoint: localHost, reachable: r.ok, status: r.status });
      } catch (error: any) {
        checks.push({ source: 'local', endpoint: localHost, reachable: false, error: error?.message || 'unreachable' });
      }
    }

    if (remoteHost) {
      const remote = normalizeBaseUrl(remoteHost);
      try {
        const r = await fetch(`${remote}/api/tags`, { signal: AbortSignal.timeout(3000) });
        checks.push({ source: 'remote', endpoint: remote, reachable: r.ok, status: r.status });
      } catch (error: any) {
        checks.push({ source: 'remote', endpoint: remote, reachable: false, error: error?.message || 'unreachable' });
      }
    }

    const active = checks.find((c) => c.reachable) || null;

    res.json({
      running: Boolean(active),
      activeSource: active?.source || null,
      activeEndpoint: active?.endpoint || null,
      checks,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to read Ollama status' });
  }
});

router.post('/pull', requireAdmin, async (req: Request, res: Response) => {
  const modelName = String(req.body?.model || '').trim();
  if (!modelName) {
    res.status(400).json({ error: 'model is required' });
    return;
  }

  const safeModel = modelName.replace(/[^a-zA-Z0-9:._-]/g, '_');
  const room = `ollama-pull-${safeModel}`;
  const io = req.app.get('io') as SocketIOServer | undefined;
  const ns = io?.of('/ws/agent-jobs');

  const emit = (payload: Record<string, any>) => {
    ns?.to(room).emit('output', {
      toolId: 'ollama',
      room,
      model: modelName,
      entry: {
        type: 'output',
        text: payload.text || '',
        stream: payload.stream || 'stdout',
        timestamp: new Date().toISOString(),
      },
      ...payload,
    });
  };

  const child = spawn('/bin/bash', ['-lc', `ollama pull ${JSON.stringify(modelName)}`], {
    stdio: 'pipe',
    env: { ...process.env },
  });

  child.stdout.on('data', (chunk) => emit({ stream: 'stdout', text: chunk.toString('utf-8') }));
  child.stderr.on('data', (chunk) => emit({ stream: 'stderr', text: chunk.toString('utf-8') }));

  child.on('close', (code) => {
    emit({
      stream: 'stdout',
      text: code === 0 ? `✅ Pull complete: ${modelName}` : `❌ Pull failed for ${modelName} (exit ${code ?? -1})`,
      done: true,
      exitCode: code ?? -1,
    });
  });

  child.on('error', (error: any) => {
    emit({ stream: 'stderr', text: `❌ Pull process error: ${error?.message || 'unknown error'}`, done: true, exitCode: -1 });
  });

  res.status(202).json({ accepted: true, model: modelName, room, message: `Started pull for ${modelName}` });
});

router.get('/recommendations', async (_req: Request, res: Response) => {
  try {
    const totalBytes = os.totalmem();
    const rec = getRecommendationsByRam(totalBytes);
    res.json({
      ramBytes: totalBytes,
      ramGb: Math.round((totalBytes / (1024 ** 3)) * 10) / 10,
      ...rec,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to compute recommendations' });
  }
});

export default router;
