import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { authenticateToken } from '../middleware/auth';
import { prisma } from '../config/database';
import { isElevatedRole } from '../utils/authz';
import {
  AVATARS_DIR,
  createImageUpload,
  parseCropParams,
  processImageToTarget,
  cleanupBasenameVariants,
  cleanupFile,
} from '../services/imageAssets';

const router = Router();
const uploadAvatar = createImageUpload('avatar');

// POST /api/users/me/avatar
router.post('/me/avatar', authenticateToken, uploadAvatar, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }

    const cropParams = parseCropParams(req.body);
    const basename = `user-${req.user!.userId}`;

    const { ext } = await processImageToTarget(req.file.path, req.file.mimetype, path.join(AVATARS_DIR, basename), cropParams);
    cleanupBasenameVariants(AVATARS_DIR, basename, ext);
    cleanupFile(req.file.path);

    const outputFilename = `${basename}${ext}`;
    await prisma.user.update({ where: { id: req.user!.userId }, data: { avatarPath: outputFilename } });
    res.json({ success: true, avatarUrl: `/static-assets/avatars/${outputFilename}` });
  } catch (error) {
    console.error('Avatar upload error:', error);
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
});

// GET /api/users/me/avatar
router.get('/me/avatar', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { avatarPath: true } });
    if (!user?.avatarPath) { res.status(404).json({ error: 'No avatar set' }); return; }

    const filePath = path.join(AVATARS_DIR, user.avatarPath);
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'Avatar file missing' }); return; }

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
    cleanupFile(req.file.path);

    res.json({ success: true, avatarUrl: `/static-assets/avatars/${basename}${ext}` });
  } catch (error) {
    console.error('Assistant avatar upload error:', error);
    res.status(500).json({ error: 'Failed to upload avatar' });
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
    res.json({ avatarUrl: '/static-assets/avatars/assistant.gif' });
  } catch {
    res.status(500).json({ error: 'Failed to fetch assistant avatar' });
  }
});

export default router;
