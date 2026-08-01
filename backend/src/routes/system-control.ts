import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin, requireOwner } from '../middleware/requireAdmin';
import { prisma } from '../config/database';
import { isOwnerRole } from '../utils/authz';
import {
  PRIVILEGED_CONFIRMATION,
  isTypedConfirmationMatch,
} from '../utils/privilegedConfirmation';
import {
  getLocalOllamaRestartCapability,
  getOllamaRuntimeStatus,
  OllamaSystemControlError,
  restartLocalOllamaService,
  unloadAllOllamaModels,
} from '../services/ollamaSystemControl';
import {
  OllamaAuthorityBarrierBusyError,
  withOllamaAuthorityMutationFence,
} from '../services/ollamaAuthorityBarrier';

const router = Router();

router.use(authenticateToken, requireAdmin);

let activeControlAction: 'unload' | 'restart' | null = null;

async function recordActivity(input: {
  userId: string;
  action: 'OLLAMA_UNLOAD' | 'OLLAMA_RESTART';
  message: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
  metadata: Prisma.InputJsonObject;
}): Promise<void> {
  await prisma.activityLog.create({
    data: {
      userId: input.userId,
      action: input.action,
      resource: 'system',
      metadata: input.metadata,
      translatedMessage: input.message,
      severity: input.severity,
    },
  }).catch((error) => console.error('[ollama-control] Activity log write failed:', error));
}

function controlErrorResponse(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof OllamaSystemControlError) {
    return { status: error.statusCode, code: error.code, message: error.message };
  }
  if (error instanceof OllamaAuthorityBarrierBusyError) {
    return { status: error.statusCode, code: error.code, message: error.message };
  }
  return {
    status: 500,
    code: 'OLLAMA_CONTROL_FAILED',
    message: 'Portal could not complete the Ollama control action. Check the server service log and retry.',
  };
}

async function runExclusiveControlAction<T>(
  action: 'unload' | 'restart',
  operation: () => Promise<T>,
): Promise<T> {
  if (activeControlAction) {
    throw new OllamaSystemControlError(
      'OLLAMA_REJECTED',
      `An Ollama ${activeControlAction} action is already running. Wait for it to finish and retry.`,
      409,
    );
  }
  activeControlAction = action;
  try {
    return await withOllamaAuthorityMutationFence(operation);
  } finally {
    activeControlAction = null;
  }
}

function requireControlConfirmation(
  received: unknown,
  expected: string,
  description: string,
): { error: string; confirmationPhrase: string } | null {
  if (isTypedConfirmationMatch(expected, received)) return null;
  return {
    error: `Type ${expected} to ${description}.`,
    confirmationPhrase: expected,
  };
}

/**
 * Owner-only host controls. The unload action uses Ollama's supported API and
 * the restart action invokes the installer-managed local systemd unit. This
 * removes the legacy control-sidecar/shared-secret dependency.
 */
router.post('/ollama/kill', requireOwner, async (req, res) => {
  const confirmationError = requireControlConfirmation(
    req.body?.confirmation,
    PRIVILEGED_CONFIRMATION.ollamaUnload,
    'unload every running Ollama model',
  );
  if (confirmationError) {
    res.status(400).json(confirmationError);
    return;
  }

  const userId = req.user!.userId;
  try {
    const result = await runExclusiveControlAction('unload', () => unloadAllOllamaModels());
    const message = result.alreadyIdle
      ? 'Ollama already had no running models.'
      : `Unloaded ${result.unloadedModels.length} Ollama model${result.unloadedModels.length === 1 ? '' : 's'} from memory.`;
    await recordActivity({
      userId,
      action: 'OLLAMA_UNLOAD',
      message,
      severity: 'WARNING',
      metadata: {
        alreadyIdle: result.alreadyIdle,
        unloadedCount: result.unloadedModels.length,
      },
    });
    res.json({
      success: true,
      message,
      ...result,
      verified: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[ollama-control] Model unload failed:', error);
    const response = controlErrorResponse(error);
    await recordActivity({
      userId,
      action: 'OLLAMA_UNLOAD',
      message: 'Ollama model unload failed. Check the server service log.',
      severity: 'ERROR',
      metadata: { code: response.code },
    });
    res.status(response.status).json({ success: false, error: response.message, code: response.code });
  }
});

router.post('/ollama/restart', requireOwner, async (req, res) => {
  const confirmationError = requireControlConfirmation(
    req.body?.confirmation,
    PRIVILEGED_CONFIRMATION.ollamaRestart,
    'restart the local Ollama service',
  );
  if (confirmationError) {
    res.status(400).json(confirmationError);
    return;
  }

  const userId = req.user!.userId;
  try {
    const result = await runExclusiveControlAction('restart', async () => {
      const capability = await getLocalOllamaRestartCapability();
      if (!capability.available) {
        throw new OllamaSystemControlError(
          capability.code,
          capability.message,
          capability.statusCode,
        );
      }
      // Re-check inside the service immediately before invoking systemd. The
      // route guard makes the direct POST fail closed; the service guard
      // protects non-HTTP callers and closes the check/use race.
      return restartLocalOllamaService();
    });
    const message = 'Local Ollama service restarted and is active.';
    await recordActivity({
      userId,
      action: 'OLLAMA_RESTART',
      message,
      severity: 'INFO',
      metadata: { active: result.active, version: result.version },
    });
    res.json({
      success: true,
      message,
      active: result.active,
      version: result.version,
      verified: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[ollama-control] Service restart failed:', error);
    const response = controlErrorResponse(error);
    await recordActivity({
      userId,
      action: 'OLLAMA_RESTART',
      message: 'Ollama service restart failed. Check the server service log.',
      severity: 'ERROR',
      metadata: { code: response.code },
    });
    res.status(response.status).json({ success: false, error: response.message, code: response.code });
  }
});

router.get('/ollama/status', requireOwner, async (_req, res) => {
  const status = await getOllamaRuntimeStatus();
  res.json({
    success: true,
    active: status.available,
    runnerCount: status.runningModels.length,
    stuckRunners: [],
    load: 0,
    loadWarning: false,
    loadCritical: false,
    unavailable: !status.available,
    timestamp: new Date().toISOString(),
  });
});

router.get('/ollama/model-status', requireOwner, async (req, res) => {
  const status = await getOllamaRuntimeStatus();
  const targetModel = String(req.query.model || '').trim() || null;
  res.json({
    success: true,
    runningModels: status.runningModels,
    targetModel,
    modelLoaded: targetModel ? status.runningModels.includes(targetModel) : false,
    isLoading: false,
    totalRunning: status.runningModels.length,
    unavailable: !status.available,
    timestamp: new Date().toISOString(),
  });
});

// Smart proxy-aware status: reports exact catalog tags and the actions the
// current account may request. Local restart remains available while the
// local backend is offline, but never while an active or disconnected native
// Remote GPU binding reserves Ollama authority.
router.get('/ollama/proxy-status', requireOwner, async (req, res) => {
  const [status, restartCapability] = await Promise.all([
    getOllamaRuntimeStatus(),
    getLocalOllamaRestartCapability(),
  ]);
  const owner = isOwnerRole(req.user?.role);
  res.json({
    ...status,
    controls: {
      unload: {
        ownerOnly: true,
        allowed: owner,
        available: status.available && status.runningModels.length > 0,
        confirmationPhrase: owner ? PRIVILEGED_CONFIRMATION.ollamaUnload : null,
      },
      restart: {
        ownerOnly: true,
        allowed: owner,
        available: restartCapability.available,
        confirmationPhrase: owner ? PRIVILEGED_CONFIRMATION.ollamaRestart : null,
      },
    },
    timestamp: new Date().toISOString(),
  });
});

export default router;
