import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { requireApproved } from '../middleware/requireApproved';
import { getToolAdapter, isInstallCommandAllowed, TOOL_ADAPTERS } from '../config/toolAdapters';
import { AgentJobRequestError, startAgentJob } from '../services/agentJobs';
import { confirmationForToolInstall, isTypedConfirmationMatch } from '../utils/privilegedConfirmation';

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

const router = Router();
router.use(authenticateToken, requireApproved, requireAdmin);

function parseVersion(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const semver = trimmed.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/);
  if (semver) return semver[0];
  return trimmed.split(/\r?\n/)[0]?.trim() || null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildInstallCommand(steps: Array<{ label: string; command: string }>): string {
  return [
    'set -euo pipefail',
    ...steps.flatMap((step) => [
      `printf '%s\\n' ${shellQuote(`▶ ${step.label}`)}`,
      step.command,
    ]),
  ].join('\n');
}

function buildSerializedInstallCommand(steps: Array<{ label: string; command: string }>): string {
  return [
    'flock',
    '--nonblock',
    '/run/bridgesllm-agent-mutation.lock',
    // No `--` here: util-linux flock takes the command directly after the
    // lock path and would try to execute a literal `--` (exit 69), which
    // broke every UI-triggered tool install.
    'timeout',
    '--foreground',
    '--kill-after=30s',
    '30m',
    '/bin/bash',
    '-lc',
    buildInstallCommand(steps),
  ].map(shellQuote).join(' ');
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

async function detectWithCache(toolId: string, detectCommand?: string, force = false): Promise<DetectionStatus> {
  if (!detectCommand) {
    return { installed: true, version: null, missing: false, checkedAt: new Date().toISOString() };
  }

  const cached = detectionCache.get(toolId);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.status;
  }

  const status = await runDetect(detectCommand);
  detectionCache.set(toolId, { status, expiresAt: Date.now() + DETECTION_CACHE_MS });
  return status;
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const force = req.query.refresh === '1';
    const tools = await Promise.all(
      TOOL_ADAPTERS.map(async (adapter) => {
        const status = await detectWithCache(adapter.id, adapter.detect?.command, force);
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

router.post('/:toolId/install', async (req: Request, res: Response): Promise<void> => {
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

  const confirmationPhrase = confirmationForToolInstall(adapter.id);
  if (!isTypedConfirmationMatch(confirmationPhrase, req.body?.confirmation)) {
    res.status(400).json({
      error: `Type ${confirmationPhrase} to confirm this host-wide tool installation or update.`,
      confirmationPhrase,
    });
    return;
  }

  try {
    const job = await startAgentJob({
      userId: req.user!.userId,
      actorAuthorizationVersion: Number(req.user!.authorizationVersion ?? 1),
      toolId: `_install:${adapter.id}`,
      title: `Install ${adapter.name}`,
      command: buildSerializedInstallCommand(adapter.install),
      cwd: process.cwd(),
    });
    detectionCache.delete(adapter.id);

    res.status(202).json({
      jobId: job.id,
      room: `job:${job.id}`,
      toolId: adapter.id,
      message: `Install started for ${adapter.name}`,
    });
  } catch (error) {
    const status = error instanceof AgentJobRequestError ? error.statusCode : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : 'Failed to start tool installation' });
  }
});

export default router;
