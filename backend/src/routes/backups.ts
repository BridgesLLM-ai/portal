import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import jwt from 'jsonwebtoken';
import { authenticateToken, requireAdmin } from '../middleware/auth';
import { prisma } from '../config/database';
import { config } from '../config/env';

const router = Router();

router.use(authenticateToken, requireAdmin);

const BACKUP_DIRS: Record<string, string> = {
  daily: '/root/backups/daily',
  weekly: '/root/backups/weekly',
  monthly: '/root/backups/monthly',
  comprehensive: '/root/backups/comprehensive',
};

// In-memory backup status tracking
interface BackupStatus {
  id: string;
  type: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
}

let currentBackup: BackupStatus | null = null;

function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}


function validateFilename(filename: string): boolean {
  return !filename.includes('..') && !filename.includes('/') && !filename.includes('\\') && filename.length > 0;
}

function findBackupFile(filename: string): { fullPath: string; type: string } | null {
  for (const [type, dir] of Object.entries(BACKUP_DIRS)) {
    const fullPath = path.join(dir, filename);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return { fullPath, type };
    }
  }
  return null;
}

// GET /api/backups/list - List all backups across all directories
router.get('/list', async (req: Request, res: Response) => {
  try {

    const backups: any[] = [];

    for (const [type, dir] of Object.entries(BACKUP_DIRS)) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir);
      for (const filename of files) {
        if (filename.endsWith('.locked') || !filename.includes('.tar.gz')) continue;
        const fullPath = path.join(dir, filename);
        try {
          const stats = fs.statSync(fullPath);
          if (!stats.isFile()) continue;
          const locked = fs.existsSync(fullPath + '.locked');
          backups.push({
            filename,
            fullPath,
            size: stats.size,
            sizeHuman: humanSize(stats.size),
            created: stats.mtime.toISOString(),
            type,
            locked,
          });
        } catch {}
      }
    }

    // Sort newest first
    backups.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

    const totalSize = backups.reduce((sum, b) => sum + b.size, 0);

    res.json({
      backups,
      summary: {
        total: backups.length,
        totalSize,
        totalSizeHuman: humanSize(totalSize),
        oldest: backups.length ? backups[backups.length - 1].created : null,
        newest: backups.length ? backups[0].created : null,
      },
    });
  } catch (error: any) {
    console.error('Backup list error:', error);
    res.status(500).json({ error: 'Failed to list backups' });
  }
});

// GET /api/backups/download/:filename - Download a backup file
router.get('/download/:filename', async (req: Request, res: Response) => {
  try {

    const { filename } = req.params;
    if (!validateFilename(filename)) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const found = findBackupFile(filename);
    if (!found) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }

    const stats = fs.statSync(found.fullPath);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stats.size.toString());

    const stream = fs.createReadStream(found.fullPath);
    stream.pipe(res);
  } catch (error: any) {
    console.error('Backup download error:', error);
    res.status(500).json({ error: 'Failed to download backup' });
  }
});

// POST /api/backups/lock/:filename - Toggle lock status
router.post('/lock/:filename', async (req: Request, res: Response) => {
  try {

    const { filename } = req.params;
    if (!validateFilename(filename)) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const found = findBackupFile(filename);
    if (!found) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }

    const lockPath = found.fullPath + '.locked';
    const isLocked = fs.existsSync(lockPath);

    if (isLocked) {
      fs.unlinkSync(lockPath);
    } else {
      fs.writeFileSync(lockPath, new Date().toISOString());
    }

    res.json({ filename, locked: !isLocked });
  } catch (error: any) {
    console.error('Backup lock error:', error);
    res.status(500).json({ error: 'Failed to toggle lock' });
  }
});

// DELETE /api/backups/:filename - Delete a backup
router.delete('/:filename', async (req: Request, res: Response) => {
  try {

    const { filename } = req.params;
    if (!validateFilename(filename)) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const found = findBackupFile(filename);
    if (!found) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }

    // Check if locked
    const lockPath = found.fullPath + '.locked';
    if (fs.existsSync(lockPath)) {
      res.status(400).json({ error: 'Cannot delete locked backup. Unlock first.' });
      return;
    }

    fs.unlinkSync(found.fullPath);
    
    // Log activity
    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'BACKUP_DELETE',
        resource: 'backup',
        resourceId: filename,
        severity: 'INFO',
        metadata: { type: found.type, filename },
      },
    });
    
    res.json({ success: true, filename });
  } catch (error: any) {
    console.error('Backup delete error:', error);
    res.status(500).json({ error: 'Failed to delete backup' });
  }
});

// POST /api/backups/create - Trigger a manual backup (async)
router.post('/create', async (req: Request, res: Response) => {
  try {

    // Check if backup already running
    if (currentBackup && currentBackup.status === 'running') {
      res.status(409).json({ 
        error: 'A backup is already in progress',
        status: currentBackup.status,
        id: currentBackup.id,
      });
      return;
    }

    const backupType = req.body?.type || 'daily';
    if (!['daily', 'weekly', 'monthly', 'comprehensive'].includes(backupType)) {
      res.status(400).json({ error: 'Invalid backup type' });
      return;
    }

    // Create backup ID
    const backupId = Date.now().toString();
    const userId = req.user!.userId;

    // Initialize status
    currentBackup = {
      id: backupId,
      type: backupType,
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    // Return immediately with running status
    res.json({ 
      status: 'running', 
      id: backupId,
      type: backupType,
      message: 'Backup started in background',
    });

    // Choose script based on backup type (executed on HOST via SSH)
    let command: string;
    
    // All backup types use the same canonical script
    // Map 'comprehensive' → 'weekly' (full backup including node_modules)
    const scriptType = backupType === 'comprehensive' ? 'weekly' : backupType;
    command = `bash ${process.env.PORTAL_ROOT || '/root/bridgesllm-product'}/backup-full.sh ${scriptType}`;

    // Execute directly on host (portal runs as systemd service, not Docker)
    const child = spawn('bash', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', async (code: number | null) => {
      if (code === 0) {
        currentBackup = {
          ...currentBackup!,
          status: 'completed',
          completedAt: new Date().toISOString(),
          output: stdout.slice(-500),
        };
        
        // Log activity
        try {
          await prisma.activityLog.create({
            data: {
              userId,
              action: 'BACKUP_CREATE',
              resource: 'backup',
              severity: 'INFO',
              metadata: { type: backupType, backupId },
            },
          });
        } catch (e) {
          console.error('Failed to log backup activity:', e);
        }
      } else {
        currentBackup = {
          ...currentBackup!,
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: (stderr || stdout).slice(-500),
        };
      }
    });

    child.on('error', (err: Error) => {
      currentBackup = {
        ...currentBackup!,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: err.message,
      };
    });
  } catch (error: any) {
    console.error('Backup create error:', error);
    
    // Update status if we have one
    if (currentBackup) {
      currentBackup = {
        ...currentBackup,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: error.message || 'Unknown error',
      };
    }
    
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

// GET /api/backups/status - Get current backup status
router.get('/status', async (req: Request, res: Response) => {
  try {

    if (!currentBackup) {
      res.json({ status: 'idle', message: 'No backup in progress' });
      return;
    }

    res.json(currentBackup);
  } catch (error: any) {
    console.error('Backup status error:', error);
    res.status(500).json({ error: 'Failed to get backup status' });
  }
});

// GET /api/backups/cron-info - Get current cron schedule info
router.get('/cron-info', async (req: Request, res: Response) => {
  try {

    // Read crontab directly (portal runs on host as systemd service)
    const { execSync } = require('child_process');
    let crontab = '';
    try {
      crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
    } catch (e: any) {
      console.error('Cron read error:', e.message);
      crontab = '';
    }

    const backupLines = crontab.split('\n').filter((l: string) => l.includes('backup') && !l.startsWith('#') && l.trim().length > 0);
    const commentedLines = crontab.split('\n').filter((l: string) => l.includes('backup') && l.startsWith('#'));

    res.json({
      active: backupLines,
      disabled: commentedLines,
      raw: crontab,
    });
  } catch (error: any) {
    console.error('Cron info error:', error);
    res.status(500).json({ error: 'Failed to read cron info' });
  }
});

// POST /api/backups/download-token/:filename - Generate a signed download token
router.post('/download-token/:filename', async (req: Request, res: Response) => {
  try {

    const { filename } = req.params;
    if (!validateFilename(filename)) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const found = findBackupFile(filename);
    if (!found) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }

    const stats = fs.statSync(found.fullPath);
    const secret = config.jwtSecret;
    const token = jwt.sign({ filename, purpose: 'backup-download' }, secret, { expiresIn: '1h' });

    res.json({ token, size: stats.size, sizeHuman: humanSize(stats.size) });
  } catch (error: any) {
    console.error('Download token error:', error);
    res.status(500).json({ error: 'Failed to generate download token' });
  }
});

// GET /api/backups/direct/:filename - Direct download with signed token (no auth header needed)
router.get('/direct/:filename', async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const { token } = req.query;

    if (!token || typeof token !== 'string') {
      res.status(401).json({ error: 'Token required' });
      return;
    }

    if (!validateFilename(filename)) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const secret = config.jwtSecret;
    let payload: any;
    try {
      payload = jwt.verify(token, secret);
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    if (payload.filename !== filename || payload.purpose !== 'backup-download') {
      res.status(403).json({ error: 'Token mismatch' });
      return;
    }

    const found = findBackupFile(filename);
    if (!found) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }

    const stats = fs.statSync(found.fullPath);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stats.size.toString());

    const stream = fs.createReadStream(found.fullPath);
    stream.pipe(res);
  } catch (error: any) {
    console.error('Direct download error:', error);
    res.status(500).json({ error: 'Failed to download backup' });
  }
});

// GET /api/backups/chunk/:filename - Download a chunk of a backup file
router.get('/chunk/:filename', async (req: Request, res: Response) => {
  try {

    const { filename } = req.params;
    const chunkIndex = parseInt(req.query.chunk as string) || 0;
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB

    if (!validateFilename(filename)) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const found = findBackupFile(filename);
    if (!found) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }

    const stats = fs.statSync(found.fullPath);
    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, stats.size);
    const totalChunks = Math.ceil(stats.size / CHUNK_SIZE);

    if (start >= stats.size) {
      res.status(416).json({ error: 'Chunk out of range' });
      return;
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', (end - start).toString());
    res.setHeader('X-Total-Size', stats.size.toString());
    res.setHeader('X-Total-Chunks', totalChunks.toString());
    res.setHeader('X-Chunk-Index', chunkIndex.toString());

    const stream = fs.createReadStream(found.fullPath, { start, end: end - 1 });
    stream.pipe(res);
  } catch (error: any) {
    console.error('Chunk download error:', error);
    res.status(500).json({ error: 'Failed to download chunk' });
  }
});

// GET /api/backups/download-info/:filename - Get file metadata for chunked download
router.get('/download-info/:filename', async (req: Request, res: Response) => {
  try {

    const { filename } = req.params;
    if (!validateFilename(filename)) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const found = findBackupFile(filename);
    if (!found) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }

    const stats = fs.statSync(found.fullPath);
    const CHUNK_SIZE = 5 * 1024 * 1024;
    const totalChunks = Math.ceil(stats.size / CHUNK_SIZE);

    res.json({ filename, size: stats.size, sizeHuman: humanSize(stats.size), chunkSize: CHUNK_SIZE, totalChunks });
  } catch (error: any) {
    console.error('Download info error:', error);
    res.status(500).json({ error: 'Failed to get download info' });
  }
});

export default router;
