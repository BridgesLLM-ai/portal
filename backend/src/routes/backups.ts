import { Router, Request, Response } from 'express';
import fs from 'fs';
import { authenticateToken } from '../middleware/auth';
import { requireOwner } from '../middleware/requireAdmin';
import { prisma } from '../config/database';
import {
  BACKUP_TYPES,
  BackupFile,
  BackupType,
  findBackupFile,
  getConfiguredBackupRoot,
  listBackupFiles,
  readBackupSchedules,
  readBackupStatus,
  readLegacyBackupCron,
  startBackupUnit,
} from '../services/backup.service';

const router = Router();
const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_CHUNK_INDEX = 1_000_000;
const activeBackupMutations = new Set<string>();

router.use(authenticateToken, requireOwner);

function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i += 1; }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function publicBackup(file: BackupFile) {
  return {
    filename: file.filename,
    size: file.size,
    sizeHuman: humanSize(file.size),
    created: new Date(file.mtimeMs).toISOString(),
    type: file.type,
    locked: file.locked,
  };
}

async function resolveBackup(filename: string): Promise<BackupFile | null> {
  const root = await getConfiguredBackupRoot();
  return findBackupFile(root, filename);
}

function sameFile(left: BackupFile, right: BackupFile): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && Math.trunc(left.mtimeMs) === Math.trunc(right.mtimeMs);
}

function streamFile(req: Request, res: Response, file: BackupFile): void {
  let start = 0;
  let end = file.size - 1;
  let statusCode = 200;
  const range = req.headers.range;

  if (range) {
    const match = range.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) {
      res.status(416).setHeader('Content-Range', `bytes */${file.size}`);
      res.end();
      return;
    }
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= file.size) {
      res.status(416).setHeader('Content-Range', `bytes */${file.size}`);
      res.end();
      return;
    }
    end = Math.min(end, file.size - 1);
    statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
  }

  res.status(statusCode);
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Content-Length', String(end - start + 1));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const stream = fs.createReadStream(file.fullPath, { start, end });
  const close = () => stream.destroy();
  req.once('aborted', close);
  res.once('close', close);
  stream.once('error', (error) => {
    console.error('Backup stream error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to stream backup' });
    else res.destroy(error);
  });
  stream.pipe(res);
}

router.get('/list', async (_req: Request, res: Response) => {
  try {
    const root = await getConfiguredBackupRoot();
    const backups = listBackupFiles(root)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map(publicBackup);
    const totalSize = backups.reduce((sum, backup) => sum + backup.size, 0);

    res.json({
      backups,
      root,
      summary: {
        total: backups.length,
        totalSize,
        totalSizeHuman: humanSize(totalSize),
        oldest: backups.length ? backups[backups.length - 1].created : null,
        newest: backups.length ? backups[0].created : null,
      },
    });
  } catch (error) {
    console.error('Backup list error:', error);
    res.status(500).json({ error: 'Backup storage is unavailable or insecurely configured' });
  }
});

router.get('/download/:filename', async (req: Request, res: Response) => {
  try {
    const found = await resolveBackup(req.params.filename);
    if (!found) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }
    streamFile(req, res, found);
  } catch (error) {
    console.error('Backup download error:', error);
    res.status(500).json({ error: 'Failed to download backup' });
  }
});

router.post('/lock/:filename', async (req: Request, res: Response) => {
  const mutationKey = req.params.filename;
  if (activeBackupMutations.has(mutationKey)) {
    res.status(409).json({ error: 'Another operation is already changing this backup' });
    return;
  }
  activeBackupMutations.add(mutationKey);
  try {
    const found = await resolveBackup(req.params.filename);
    if (!found) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }

    const lockPath = `${found.fullPath}.locked`;
    if (found.locked) {
      const stat = fs.lstatSync(lockPath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Invalid backup lock file');
      fs.unlinkSync(lockPath);
    } else {
      fs.writeFileSync(lockPath, `${new Date().toISOString()}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    res.json({ filename: found.filename, locked: !found.locked });
  } catch (error) {
    console.error('Backup lock error:', error);
    res.status(500).json({ error: 'Failed to toggle backup lock' });
  } finally {
    activeBackupMutations.delete(mutationKey);
  }
});

router.delete('/:filename', async (req: Request, res: Response) => {
  const mutationKey = req.params.filename;
  if (activeBackupMutations.has(mutationKey)) {
    res.status(409).json({ error: 'Another operation is already changing this backup' });
    return;
  }
  activeBackupMutations.add(mutationKey);
  try {
    const root = await getConfiguredBackupRoot();
    const found = findBackupFile(root, req.params.filename);
    if (!found) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }
    if (found.locked) {
      res.status(400).json({ error: 'Cannot delete locked backup. Unlock it first.' });
      return;
    }

    const revalidated = findBackupFile(root, found.filename);
    if (!revalidated || !sameFile(found, revalidated)) {
      res.status(409).json({ error: 'Backup changed while the delete was being prepared' });
      return;
    }
    fs.unlinkSync(found.fullPath);

    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'BACKUP_DELETE',
        resource: 'backup',
        resourceId: found.filename,
        severity: 'INFO',
        metadata: { type: found.type, filename: found.filename },
      },
    }).catch((error) => console.error('Failed to record backup deletion activity:', error));
    res.json({ success: true, filename: found.filename });
  } catch (error) {
    console.error('Backup delete error:', error);
    res.status(500).json({ error: 'Failed to delete backup' });
  } finally {
    activeBackupMutations.delete(mutationKey);
  }
});

router.post('/create', async (req: Request, res: Response) => {
  const backupType = String(req.body?.type || 'daily') as BackupType;
  if (!BACKUP_TYPES.includes(backupType)) {
    res.status(400).json({ error: 'Invalid backup type' });
    return;
  }

  try {
    const status = await startBackupUnit(backupType);
    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'BACKUP_REQUESTED',
        resource: 'backup',
        severity: 'INFO',
        metadata: { type: backupType, backupId: status?.id || null },
      },
    }).catch((error) => console.error('Failed to record backup request activity:', error));

    res.status(202).json({
      status: status?.status || 'queued',
      id: status?.id || null,
      type: backupType,
      message: status?.status === 'failed'
        ? 'The backup service failed during startup'
        : 'Backup request accepted by the system service',
      error: status?.status === 'failed'
        ? (status.failureDetail || status.error || 'The backup service failed during startup')
        : undefined,
    });
  } catch (error: any) {
    if (error?.code === 'EBUSY') {
      const status = readBackupStatus();
      res.status(409).json({ error: 'A backup is already in progress', status: status?.status, id: status?.id });
      return;
    }
    console.error('Backup create error:', error);
    res.status(500).json({ error: 'Failed to start the installed backup service' });
  }
});

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = readBackupStatus();
    res.setHeader('Cache-Control', 'no-store');
    if (!status) {
      res.json({ status: 'idle', message: 'No backup has run yet' });
      return;
    }
    res.json(status);
  } catch (error) {
    console.error('Backup status error:', error);
    res.status(500).json({ error: 'Failed to read persistent backup status' });
  }
});

router.get('/cron-info', async (_req: Request, res: Response) => {
  try {
    const [schedules, legacy] = await Promise.all([readBackupSchedules(), readLegacyBackupCron()]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      schedules,
      active: legacy.active,
      disabled: legacy.disabled,
      legacyCron: legacy,
    });
  } catch (error) {
    console.error('Backup schedule error:', error);
    res.status(500).json({ error: 'Failed to read installed backup schedules' });
  }
});

router.get('/chunk/:filename', async (req: Request, res: Response) => {
  try {
    const rawChunk = typeof req.query.chunk === 'string' ? req.query.chunk : '';
    if (!/^(?:0|[1-9]\d{0,6})$/.test(rawChunk)) {
      res.status(400).json({ error: 'Chunk index must be a non-negative integer' });
      return;
    }
    const chunkIndex = Number(rawChunk);
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex > MAX_CHUNK_INDEX) {
      res.status(400).json({ error: 'Chunk index is too large' });
      return;
    }

    const found = await resolveBackup(req.params.filename);
    if (!found) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }
    const totalChunks = Math.ceil(found.size / CHUNK_SIZE);
    if (chunkIndex >= totalChunks) {
      res.status(416).json({ error: 'Chunk out of range' });
      return;
    }
    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, found.size) - 1;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(end - start + 1));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Total-Size', String(found.size));
    res.setHeader('X-Total-Chunks', String(totalChunks));
    res.setHeader('X-Chunk-Index', String(chunkIndex));
    const stream = fs.createReadStream(found.fullPath, { start, end });
    req.once('aborted', () => stream.destroy());
    stream.once('error', (error) => res.destroy(error));
    stream.pipe(res);
  } catch (error) {
    console.error('Chunk download error:', error);
    res.status(500).json({ error: 'Failed to download chunk' });
  }
});

router.get('/download-info/:filename', async (req: Request, res: Response) => {
  try {
    const found = await resolveBackup(req.params.filename);
    if (!found) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }
    res.json({
      filename: found.filename,
      size: found.size,
      sizeHuman: humanSize(found.size),
      chunkSize: CHUNK_SIZE,
      totalChunks: Math.ceil(found.size / CHUNK_SIZE),
    });
  } catch (error) {
    console.error('Download info error:', error);
    res.status(500).json({ error: 'Failed to get download info' });
  }
});

export default router;
