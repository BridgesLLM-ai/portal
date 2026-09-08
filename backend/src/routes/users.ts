import { Router, Request, Response } from 'express';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { authenticateToken } from '../middleware/auth';
import { prisma } from '../config/database';
import { isElevatedRole } from '../utils/authz';
import type { AgentProviderName } from '../agents/AgentProvider.interface';
import { getHarnessDefinition } from '../agents/harnessCatalog';
import {
  getOpenClawExecutionAdmission,
  type OpenClawExecutionAdmission,
} from '../services/openClawExecutionAdmission';
import {
  AVATARS_DIR,
  createImageUpload,
  parseCropParams,
  processImageToTarget,
  cleanupBasenameVariants,
  cleanupFile,
  classifyImageUploadFailure,
} from '../services/imageAssets';

const router = Router();
const uploadAvatar = createImageUpload('avatar');

const defaultAgentHarnessSchema = z.object({
  harnessId: z.string().trim().min(1).max(64).transform((value) => value.toUpperCase()),
}).strict();

export function registeredImplementedDefaultHarness(value: unknown): AgentProviderName | null {
  const definition = getHarnessDefinition(value);
  if (!definition
    || definition.compatibilityProviderId !== definition.id
    || !definition.implemented
    || !definition.selectable) {
    return null;
  }
  return definition.compatibilityProviderId;
}

export async function defaultHarnessCanBeNewSelection(
  value: AgentProviderName,
  readOpenClawAdmission: () => Promise<OpenClawExecutionAdmission> = getOpenClawExecutionAdmission,
): Promise<boolean> {
  // Existing saved values remain readable so upgrades never rewrite user
  // preference state. A new OpenClaw selection is admitted from the same
  // durable marker/WAL/readiness contract used by Agent Chat execution.
  if (value !== 'OPENCLAW') return true;
  return (await readOpenClawAdmission()).ready;
}

function defaultHarnessResponse(
  defaultHarness: AgentProviderName,
  revision: number,
) {
  return { defaultHarness, revision };
}

// GET /api/users/me/agent-harness-preference
router.get('/me/agent-harness-preference', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { defaultAgentHarness: true, defaultAgentHarnessRevision: true },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const defaultHarness = registeredImplementedDefaultHarness(user.defaultAgentHarness);
    if (!defaultHarness) {
      res.status(409).json({
        error: 'The saved default harness is no longer supported. Choose a supported harness in Settings.',
        code: 'DEFAULT_AGENT_HARNESS_INVALID',
      });
      return;
    }
    res.json(defaultHarnessResponse(defaultHarness, user.defaultAgentHarnessRevision));
  } catch (error) {
    console.error('Default agent harness fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch the default harness' });
  }
});

// PATCH /api/users/me/agent-harness-preference
router.patch('/me/agent-harness-preference', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  const parsed = defaultAgentHarnessSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'A valid harnessId is required' });
    return;
  }
  const defaultHarness = registeredImplementedDefaultHarness(parsed.data.harnessId);
  if (!defaultHarness) {
    res.status(400).json({
      error: 'That harness is not a registered, implemented Agent Chat harness',
      code: 'DEFAULT_AGENT_HARNESS_UNSUPPORTED',
    });
    return;
  }
  if (!(await defaultHarnessCanBeNewSelection(defaultHarness))) {
    res.status(409).json({
      error: 'OpenClaw is not ready for Agent Chat execution on this host. Recover any retained maintenance state and verify the tested runtime before selecting it.',
      code: 'DEFAULT_AGENT_HARNESS_RUNTIME_UNAVAILABLE',
    });
    return;
  }

  try {
    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: {
        defaultAgentHarness: defaultHarness,
        defaultAgentHarnessRevision: { increment: 1 },
      },
      select: { defaultAgentHarness: true, defaultAgentHarnessRevision: true },
    });
    res.json(defaultHarnessResponse(
      registeredImplementedDefaultHarness(user.defaultAgentHarness)!,
      user.defaultAgentHarnessRevision,
    ));
  } catch (error) {
    console.error('Default agent harness update error:', error);
    res.status(500).json({ error: 'Failed to update the default harness' });
  }
});

// POST /api/users/me/avatar
router.post('/me/avatar', authenticateToken, uploadAvatar, async (req: Request, res: Response): Promise<void> => {
  let uncommittedOutputPath: string | null = null;
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }

    const cropParams = parseCropParams(req.body);
    const basename = `user-${req.user!.userId}`;

    const { ext, outputPath } = await processImageToTarget(
      req.file.path,
      req.file.mimetype,
      path.join(AVATARS_DIR, basename),
      cropParams,
    );
    uncommittedOutputPath = outputPath;
    cleanupBasenameVariants(AVATARS_DIR, basename, ext);

    const outputFilename = `${basename}${ext}`;
    await prisma.user.update({ where: { id: req.user!.userId }, data: { avatarPath: outputFilename } });
    uncommittedOutputPath = null;
    res.json({ success: true, avatarUrl: `/static-assets/avatars/${outputFilename}` });
  } catch (error) {
    cleanupFile(uncommittedOutputPath);
    console.error('Avatar upload error:', error);
    const failure = classifyImageUploadFailure(error);
    if (failure) {
      res.status(failure.statusCode).json(failure);
      return;
    }
    res.status(500).json({ error: 'Failed to upload avatar' });
  } finally {
    cleanupFile(req.file?.path);
  }
});

// GET /api/users/me/avatar
router.get('/me/avatar', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { avatarPath: true } });
    if (!user?.avatarPath) {
      res.json({ avatarUrl: null });
      return;
    }

    const filePath = path.join(AVATARS_DIR, user.avatarPath);
    if (!fs.existsSync(filePath)) {
      await prisma.user.update({ where: { id: req.user!.userId }, data: { avatarPath: null } }).catch(() => {});
      res.json({ avatarUrl: null });
      return;
    }

    res.json({ avatarUrl: `/static-assets/avatars/${user.avatarPath}` });
  } catch (error) {
    console.error('Avatar fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch avatar' });
  }
});

// DELETE /api/users/me/avatar
router.delete('/me/avatar', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { avatarPath: true } });
    if (user?.avatarPath) {
      cleanupFile(path.join(AVATARS_DIR, user.avatarPath));
      await prisma.user.update({ where: { id: req.user!.userId }, data: { avatarPath: null } });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Avatar delete error:', error);
    res.status(500).json({ error: 'Failed to delete avatar' });
  }
});

// POST /api/users/assistant-avatar (admin only — update Assistant avatar)
router.post('/assistant-avatar', authenticateToken, uploadAvatar, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { role: true } });
    if (!isElevatedRole(user?.role)) { res.status(403).json({ error: 'Admin only' }); return; }

    const cropParams = parseCropParams(req.body);
    const basename = 'assistant-custom';
    const { ext } = await processImageToTarget(req.file.path, req.file.mimetype, path.join(AVATARS_DIR, basename), cropParams, { gifSize: 512 });
    cleanupBasenameVariants(AVATARS_DIR, basename, ext);

    res.json({ success: true, avatarUrl: `/static-assets/avatars/${basename}${ext}` });
  } catch (error) {
    console.error('Assistant avatar upload error:', error);
    const failure = classifyImageUploadFailure(error);
    if (failure) {
      res.status(failure.statusCode).json(failure);
      return;
    }
    res.status(500).json({ error: 'Failed to upload avatar' });
  } finally {
    cleanupFile(req.file?.path);
  }
});

// GET /api/users/assistant-avatar
router.get('/assistant-avatar', authenticateToken, async (_req: Request, res: Response): Promise<void> => {
  try {
    const exts = ['.gif', '.png', '.jpeg', '.jpg', '.webp'];
    for (const ext of exts) {
      const fp = path.join(AVATARS_DIR, `assistant-custom${ext}`);
      if (fs.existsSync(fp)) {
        res.json({ avatarUrl: `/static-assets/avatars/assistant-custom${ext}` });
        return;
      }
    }
    // No custom assistant avatar — return null so the frontend uses its built-in fallback
    res.json({ avatarUrl: null });
  } catch {
    res.status(500).json({ error: 'Failed to fetch assistant avatar' });
  }
});

export default router;
