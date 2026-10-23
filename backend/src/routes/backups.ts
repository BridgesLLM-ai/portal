import { Router, Request as ExpressRequest, Response } from 'express';
// These routes use scalar :parameters; named wildcard handlers declare arrays explicitly.
type Request = ExpressRequest<Record<string, string>>;

import fs from 'fs';
import { authenticateToken } from '../middleware/auth';
import { requireOwner } from '../middleware/requireAdmin';
import { prisma } from '../config/database';
import {
  BACKUP_TYPES,
  BackupFile,
  BackupType,
  deleteBackupFile,
  expectedBackupOwnerIdentity,
  findBackupFile,
  getConfiguredBackupRoot,
  isBackupReferencedByLiveDependencyRepair,
  isRepairOwnedBackupLockMarker,
  listBackupFiles,
  readBackupStatus,
  readLegacyBackupCron,
  assertBackupMutationLockLease,
  startBackupUnit,
  withBackupMutationLock,
} from '../services/backup.service';
import {
  BackupManagementError,
  previewBackupCleanup,
  readBackupPolicy,
  runBackupCleanup,
  saveBackupPolicy,
} from '../services/backupManagement.service';
import {
  BackupScheduleError,
  readBackupScheduleSettings,
  updateBackupSchedule,
} from '../services/backupSchedule.service';

const router = Router();
const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_CHUNK_INDEX = 1_000_000;
const activeBackupMutations = new Set<string>();
const activeManagementChanges = new Set<string>();

router.use(authenticateToken, requireOwner);

function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i += 1; }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function publicBackup(file: BackupFile) {
  return {
    filename: file.filename,
    format: /-data-[a-f0-9]{8}\.tar\.gz$/.test(file.filename) ? 'portal-data' : 'legacy',
    size: file.size,
    sizeHuman: humanSize(file.size),
    created: new Date(file.mtimeMs).toISOString(),
    type: file.type,
    locked: file.locked,
    completeness: file.completeness,
    degradedComponents: file.degradedComponents,
    classificationAuthenticated: file.classificationAuthenticated,
  };
}

export function buildBackupListResponse(root: string, files: BackupFile[]) {
  const backups = files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(publicBackup);
  const totalSize = backups.reduce((sum, backup) => sum + backup.size, 0);
  const completeBackups = backups.filter((backup) => backup.completeness === 'complete');
  const degradedBackups = backups.filter((backup) => backup.completeness === 'degraded');
  const unknownBackups = backups.filter((backup) => backup.completeness === 'unknown');

  return {
    backups,
    root,
    summary: {
      total: backups.length,
      totalSize,
      totalSizeHuman: humanSize(totalSize),
      oldest: backups.length ? backups[backups.length - 1].created : null,
      newest: backups.length ? backups[0].created : null,
      complete: completeBackups.length,
      degraded: degradedBackups.length,
      unknown: unknownBackups.length,
      newestComplete: completeBackups.length ? completeBackups[0].created : null,
    },
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
    && left.mtimeNs === right.mtimeNs;
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

  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(file.fullPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor, { bigint: true });
    const expectedOwner = expectedBackupOwnerIdentity();
    if (!stat.isFile() || stat.isSymbolicLink()
      || stat.dev.toString() !== file.dev
      || stat.ino.toString() !== file.ino
      || stat.size !== BigInt(file.size)
      || stat.mtimeNs.toString() !== file.mtimeNs
      || stat.uid !== BigInt(expectedOwner.uid)
      || stat.gid !== BigInt(expectedOwner.gid)
      || stat.nlink !== 1n
      || (stat.mode & 0o022n) !== 0n) {
      fs.closeSync(descriptor);
      descriptor = null;
      res.status(409).json({ error: 'Backup changed before download' });
      return;
    }
  } catch {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
      descriptor = null;
    }
    res.status(409).json({ error: 'Backup changed before download' });
    return;
  }

  res.status(statusCode);
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Content-Length', String(end - start + 1));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const stream = fs.createReadStream(file.fullPath, { fd: descriptor, autoClose: true, start, end });
  descriptor = null; // createReadStream owns and closes the descriptor now.
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
    res.json(buildBackupListResponse(root, listBackupFiles(root)));
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
    await withBackupMutationLock(async (lease) => {
      const found = await resolveBackup(req.params.filename);
      if (!found) {
        res.status(404).json({ error: 'Backup not found' });
        return;
      }
      if (isRepairOwnedBackupLockMarker(found)
        || await isBackupReferencedByLiveDependencyRepair(found)) {
        res.status(409).json({
          error: 'This backup is pinned by an active Project dependency repair and cannot be unlocked.',
          code: 'BACKUP_PINNED_BY_DEPENDENCY_REPAIR',
        });
        return;
      }
      const lockPath = `${found.fullPath}.locked`;
      if (found.locked) {
        const stat = fs.lstatSync(lockPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          res.status(409).json({
            error: 'This backup is held by an unexpected lock entry, so it stays locked. '
              + 'Remove the lock on the server to unlock it.',
            code: 'BACKUP_LOCK_UNEXPECTED',
          });
          return;
        }
        assertBackupMutationLockLease(lease);
        fs.unlinkSync(lockPath);
      } else {
        assertBackupMutationLockLease(lease);
        fs.writeFileSync(lockPath, `${new Date().toISOString()}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      }
      res.json({ filename: found.filename, locked: !found.locked });
    });
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
    await withBackupMutationLock(async (lease) => {
      const root = await getConfiguredBackupRoot();
      const found = findBackupFile(root, req.params.filename);
      if (!found) {
        res.status(404).json({ error: 'Backup not found' });
        return;
      }
      if (await isBackupReferencedByLiveDependencyRepair(found)) {
        res.status(409).json({
          error: 'This backup is pinned by an active Project dependency repair and cannot be deleted.',
          code: 'BACKUP_PINNED_BY_DEPENDENCY_REPAIR',
        });
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
      assertBackupMutationLockLease(lease);
      deleteBackupFile(found, lease);

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
    });
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
    const [settings, legacy] = await Promise.all([readBackupScheduleSettings(), readLegacyBackupCron()]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      hostTimezone: settings.hostTimezone,
      schedules: settings.schedules,
      active: legacy.active,
      disabled: legacy.disabled,
      legacyCron: legacy,
    });
  } catch (error) {
    console.error('Backup schedule error:', error);
    res.status(500).json({ error: 'Failed to read installed backup schedules' });
  }
});

function sendManagementError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof BackupManagementError || error instanceof BackupScheduleError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  console.error(`${fallback}:`, error);
  res.status(500).json({ error: fallback });
}

// One owner-level change at a time per kind; backup-data.py also takes the
// installer and backup locks before it deletes anything.
async function exclusively(key: string, res: Response, work: () => Promise<void>): Promise<void> {
  if (activeManagementChanges.has(key)) {
    res.status(409).json({ error: 'Another change to backup settings is still running', code: 'BUSY' });
    return;
  }
  activeManagementChanges.add(key);
  try {
    await work();
  } finally {
    activeManagementChanges.delete(key);
  }
}

router.get('/settings', async (_req: Request, res: Response) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await readBackupPolicy());
  } catch (error) {
    sendManagementError(res, error, 'Backup settings could not be read');
  }
});

// Saving settings only records them. Nothing is deleted or started here; the
// limits apply after the next backup or through the reviewed cleanup below.
router.put('/settings', async (req: Request, res: Response) => {
  await exclusively('settings', res, async () => {
    try {
      const saved = await saveBackupPolicy(req.body);
      await prisma.activityLog.create({
        data: {
          userId: req.user!.userId,
          action: 'BACKUP_SETTINGS_UPDATED',
          resource: 'backup',
          severity: 'INFO',
          metadata: { policy: saved.policy },
        },
      }).catch((error) => console.error('Failed to record backup settings activity:', error));
      res.json(saved);
    } catch (error) {
      sendManagementError(res, error, 'Backup settings could not be saved');
    }
  });
});

router.get('/cleanup/preview', async (_req: Request, res: Response) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await previewBackupCleanup());
  } catch (error) {
    sendManagementError(res, error, 'Backup cleanup could not be previewed');
  }
});

router.post('/cleanup', async (req: Request, res: Response) => {
  if (req.body?.confirm !== true || typeof req.body?.planToken !== 'string') {
    res.status(400).json({ error: 'Review the cleanup and confirm it before deleting backups', code: 'STALE' });
    return;
  }
  await exclusively('cleanup', res, async () => {
    try {
      const result = await runBackupCleanup(req.body.planToken);
      await prisma.activityLog.create({
        data: {
          userId: req.user!.userId,
          action: 'BACKUP_CLEANUP',
          resource: 'backup',
          severity: 'INFO',
          metadata: {
            deleted: Array.isArray(result?.deleted) ? result.deleted.slice(0, 200) : [],
            deletedBytes: result?.deletedBytes ?? null,
            freedBytes: result?.freedBytes ?? null,
          },
        },
      }).catch((error) => console.error('Failed to record backup cleanup activity:', error));
      res.json(result);
    } catch (error) {
      sendManagementError(res, error, 'Backup cleanup failed');
    }
  });
});

router.put('/schedules/:type', async (req: Request, res: Response) => {
  await exclusively(`schedule:${req.params.type}`, res, async () => {
    try {
      const schedule = await updateBackupSchedule(req.params.type, req.body);
      await prisma.activityLog.create({
        data: {
          userId: req.user!.userId,
          action: 'BACKUP_SCHEDULE_UPDATED',
          resource: 'backup',
          resourceId: schedule.type,
          severity: 'INFO',
          metadata: {
            type: schedule.type,
            enabled: schedule.enabled,
            time: schedule.time,
            weekday: schedule.weekday,
            dayOfMonth: schedule.dayOfMonth,
          },
        },
      }).catch((error) => console.error('Failed to record backup schedule activity:', error));
      res.json({ schedule });
    } catch (error) {
      sendManagementError(res, error, 'Backup schedule could not be changed');
    }
  });
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
      completeness: found.completeness,
      degradedComponents: found.degradedComponents,
      classificationAuthenticated: found.classificationAuthenticated,
    });
  } catch (error) {
    console.error('Download info error:', error);
    res.status(500).json({ error: 'Failed to get download info' });
  }
});

export default router;
