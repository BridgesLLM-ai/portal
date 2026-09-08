import { Router, type Application, type Request, type RequestHandler, type Response } from 'express';
import { exec } from 'child_process';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin, requireOwner } from '../middleware/requireAdmin';
import { requireApproved } from '../middleware/requireApproved';
import {
  getToolAdapter,
  HOST_NATIVE_AGENT_TOOL_IDS,
  HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE,
  isInstallCommandAllowed,
  TOOL_ADAPTERS,
} from '../config/toolAdapters';
import { AgentJobRequestError, startAgentJob } from '../services/agentJobs';
import { confirmationForToolInstall, isTypedConfirmationMatch } from '../utils/privilegedConfirmation';
import {
  getNativeHostCliStatus,
  type NativeHostCliStatusState,
  type NativeHostCliStatusTool,
} from '../services/nativeHostCliStatus';
import {
  isUnqualifiedNativeBinaryToolId,
  NATIVE_BINARY_QUALIFICATION_CODE,
} from '../config/unqualifiedNativeBinaryLane';

type DetectionStatus = {
  installed: boolean;
  version: string | null;
  missing: boolean;
  checkedAt: string;
  state?: NativeHostCliStatusState;
  installAvailable?: boolean;
  installUnavailableCode?: string;
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

export function sendHostNativeRuntimeMutationUnavailable(_req: Request, res: Response): void {
  res.status(HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE.status).json({
    code: HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE.code,
    error: HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE.error,
    retryable: HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE.retryable,
    remediation: HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE.remediation,
  });
}

type SetupMutationGuards = Readonly<{
  requireSetupComplete: RequestHandler;
  requireSetupPending: RequestHandler;
  requireSetupToken: RequestHandler;
}>;

/**
 * Mount disabled native-runtime acquisition endpoints before request-body
 * parsing. Agent Zero's combined container/volume/host-bridge reconcile is
 * disabled as one unit because Portal cannot transact only its host bridge.
 */
export function mountHostNativeRuntimeMutationFence(
  app: Application,
  setupGuards: SetupMutationGuards,
): void {
  app.post(
    '/api/setup/install-coding-tool',
    setupGuards.requireSetupPending,
    setupGuards.requireSetupToken,
    sendHostNativeRuntimeMutationUnavailable,
  );

  app.post(
    '/api/admin/install-coding-tool',
    setupGuards.requireSetupComplete,
    authenticateToken,
    requireAdmin,
    requireOwner,
    sendHostNativeRuntimeMutationUnavailable,
  );

  app.post(
    '/api/agent-runtime/agent-zero/runtime/reconcile',
    setupGuards.requireSetupComplete,
    authenticateToken,
    requireOwner,
    sendHostNativeRuntimeMutationUnavailable,
  );

  for (const toolId of HOST_NATIVE_AGENT_TOOL_IDS) {
    app.post(
      `/api/agent-tools/${toolId}/install`,
      setupGuards.requireSetupComplete,
      authenticateToken,
      requireApproved,
      requireAdmin,
      sendHostNativeRuntimeMutationUnavailable,
    );
  }
}

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

function runDetect(command: string, installAvailable: boolean): Promise<DetectionStatus> {
  return new Promise((resolve) => {
    exec(command, { timeout: DETECTION_TIMEOUT_MS, shell: '/bin/bash' }, (error, stdout, stderr) => {
      const checkedAt = new Date().toISOString();
      if (error) {
        const missing = /not found|is not recognized|command not found/i.test(String(stderr || error.message));
        resolve({ installed: false, version: null, missing, checkedAt, installAvailable });
        return;
      }
      const out = `${stdout || ''}\n${stderr || ''}`;
      const version = parseVersion(out);
      resolve({ installed: true, version, missing: false, checkedAt, installAvailable });
    });
  });
}

async function detectWithCache(
  toolId: string,
  detectCommand: string | undefined,
  installAvailable: boolean,
  force = false,
): Promise<DetectionStatus> {
  if (!detectCommand) {
    return {
      installed: true,
      version: null,
      missing: false,
      checkedAt: new Date().toISOString(),
      installAvailable,
    };
  }

  const cached = detectionCache.get(toolId);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.status;
  }

  const status = await runDetect(detectCommand, installAvailable);
  detectionCache.set(toolId, { status, expiresAt: Date.now() + DETECTION_CACHE_MS });
  return status;
}

async function admittedHostDetectionStatus(
  toolId: NativeHostCliStatusTool,
  force: boolean,
): Promise<DetectionStatus> {
  const status = await getNativeHostCliStatus(toolId, { force });
  return {
    installed: status.installed === true,
    version: status.observedVersion,
    missing: status.state === 'absent',
    checkedAt: status.checkedAt,
    state: status.state,
    installAvailable: false,
    installUnavailableCode: HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE.code,
  };
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const force = req.query.refresh === '1';
    const tools = await Promise.all(
      TOOL_ADAPTERS.map(async (adapter) => {
        const detectedStatus = adapter.id === 'codex' || adapter.id === 'claude-code'
          ? await admittedHostDetectionStatus(adapter.id, force)
          : await detectWithCache(adapter.id, adapter.detect?.command, adapter.install.length > 0, force);
        const status = isUnqualifiedNativeBinaryToolId(adapter.id)
          ? {
            ...detectedStatus,
            installAvailable: false,
            installUnavailableCode: NATIVE_BINARY_QUALIFICATION_CODE,
          }
          : detectedStatus;
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

  if (HOST_NATIVE_AGENT_TOOL_IDS.has(toolId)) {
    sendHostNativeRuntimeMutationUnavailable(req, res);
    return;
  }

  const body = z.object({ confirmation: z.string().max(200) }).strict().safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'A strict typed-confirmation body is required.', code: 'INVALID_INSTALL_REQUEST' });
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
  if (!isTypedConfirmationMatch(confirmationPhrase, body.data.confirmation)) {
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
