import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { prisma } from '../config/database';

export const BACKUP_TYPES = ['daily', 'weekly', 'monthly', 'comprehensive'] as const;
export type BackupType = typeof BACKUP_TYPES[number];

export interface BackupFile {
  filename: string;
  fullPath: string;
  type: BackupType;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  locked: boolean;
}

export interface BackupStatus {
  id: string;
  type: BackupType;
  status: 'queued' | 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  pid?: number;
  exitCode?: number;
  archivePath?: string;
  error?: string;
  failureDetail?: string;
  phase?: string;
  phaseLabel?: string;
  phaseIndex?: number;
  phaseTotal?: number;
  output?: string;
}

export interface BackupSchedule {
  type: Exclude<BackupType, 'weekly'>;
  source: 'systemd';
  timerUnit: string;
  serviceUnit: string;
  loaded: boolean;
  enabled: boolean;
  active: boolean;
  onCalendar: string | null;
  nextRun: string | null;
  lastRun: string | null;
}

const execFileAsync = promisify(execFile);
const PORTAL_ROOT = process.env.PORTAL_ROOT || '/opt/bridgesllm/portal';
export const DEFAULT_BACKUP_ROOT = '/root/backups';
export const BACKUP_STATE_DIR = process.env.BACKUP_STATE_DIR
  || path.join(PORTAL_ROOT, 'backend', '.data', 'backups');
export const BACKUP_CONFIG_FILE = process.env.BACKUP_CONFIG_FILE
  || path.join(BACKUP_STATE_DIR, 'backup-base-path');
const BACKUP_STATUS_FILE = path.join(BACKUP_STATE_DIR, 'status.json');
const BACKUP_OUTPUT_FILE = path.join(BACKUP_STATE_DIR, 'current.log');
const MAX_STATUS_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_PATH_BYTES = 1024;

const TIMER_UNITS: Array<{
  type: Exclude<BackupType, 'weekly'>;
  timerUnit: string;
  serviceUnit: string;
}> = [
  { type: 'daily', timerUnit: 'bridgesllm-backup-daily.timer', serviceUnit: 'bridgesllm-backup@daily.service' },
  { type: 'comprehensive', timerUnit: 'bridgesllm-backup-comprehensive.timer', serviceUnit: 'bridgesllm-backup@comprehensive.service' },
  { type: 'monthly', timerUnit: 'bridgesllm-backup-monthly.timer', serviceUnit: 'bridgesllm-backup@monthly.service' },
];

const BROAD_FORBIDDEN_ROOTS = new Set([
  '/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/media',
  '/mnt', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp',
  '/usr', '/var',
]);

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function expectedOwnerUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

function assertSecureDirectoryChain(directory: string, expectedUid = expectedOwnerUid()): void {
  const parsed = path.parse(directory);
  let current = parsed.root;
  const segments = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);

  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Backup path cannot contain symbolic links: ${current}`);
    if (!stat.isDirectory()) throw new Error(`Backup path component is not a directory: ${current}`);
    if (stat.uid !== expectedUid) throw new Error(`Backup path must be owned by uid ${expectedUid}: ${current}`);
    if ((stat.mode & 0o022) !== 0) throw new Error(`Backup path cannot be group/world writable: ${current}`);
  }
}

function assertSecureExistingPrefix(directory: string, expectedUid = expectedOwnerUid()): void {
  const parsed = path.parse(directory);
  let current = parsed.root;
  const segments = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Backup path cannot contain symbolic links: ${current}`);
    if (!stat.isDirectory()) throw new Error(`Backup path component is not a directory: ${current}`);
    if (stat.uid !== expectedUid) throw new Error(`Backup path must be owned by uid ${expectedUid}: ${current}`);
    if ((stat.mode & 0o022) !== 0) throw new Error(`Backup path cannot be group/world writable: ${current}`);
  }
}

export function normalizeBackupRoot(input: string, portalRoot = PORTAL_ROOT): string {
  const raw = String(input || '').trim();
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_PATH_BYTES || /[\x00-\x1f\x7f]/.test(raw)) {
    throw new Error('Backup path is empty, contains unsafe control characters, or is too long');
  }
  if (!path.isAbsolute(raw)) throw new Error('Backup path must be absolute');

  const normalized = path.resolve(raw);
  if (BROAD_FORBIDDEN_ROOTS.has(normalized)) {
    throw new Error('Backup path must be a dedicated subdirectory, not a system root');
  }

  const protectedRoots = [
    portalRoot,
    process.env.APPS_ROOT || path.join(process.env.INSTALL_ROOT || '/opt/bridgesllm', 'apps'),
    process.env.LEGACY_APP_FILES_DIR || '/var/www/bridgesllm-apps',
    process.env.PORTAL_FILES_DIR || '/var/portal-files',
    process.env.RUNTIME_ROOT || '/portal',
    process.env.OPENCLAW_DIR || '/root/.openclaw',
    process.env.STALWART_DIR || '/var/stalwart',
    '/portal',
    '/var/portal-files',
    '/root/.openclaw',
    '/var/stalwart',
    '/var/stalwart-mail',
    '/etc/caddy',
  ].map((entry) => path.resolve(entry));
  if (protectedRoots.some((protectedRoot) => (
    isWithin(normalized, protectedRoot) || isWithin(protectedRoot, normalized)
  ))) {
    throw new Error('Backup path cannot overlap live Portal, app, OpenClaw, mail, or configuration data');
  }
  return normalized;
}

export function ensureBackupLayout(input: string, portalRoot = PORTAL_ROOT): string {
  const root = normalizeBackupRoot(input, portalRoot);
  // Refuse symlinked/writable ancestors before recursive mkdir has a chance to
  // follow them and create directories outside the requested root.
  assertSecureExistingPrefix(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertSecureDirectoryChain(root);

  for (const name of [...BACKUP_TYPES, 'logs'] as const) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== expectedOwnerUid() || (stat.mode & 0o022) !== 0) {
      throw new Error(`Backup directory is not securely owned: ${directory}`);
    }
  }
  return root;
}

function readSmallFile(filePath: string, maxBytes: number): string | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function atomicWrite(filePath: string, content: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode, flag: 'wx' });
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, mode);
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

export function writeBackupConfiguration(root: string): void {
  const validated = ensureBackupLayout(root);
  fs.mkdirSync(BACKUP_STATE_DIR, { recursive: true, mode: 0o700 });
  try {
    const stat = fs.lstatSync(BACKUP_CONFIG_FILE);
    const current = readSmallFile(BACKUP_CONFIG_FILE, MAX_PATH_BYTES + 2)?.trim();
    if (stat.isFile()
      && !stat.isSymbolicLink()
      && stat.uid === expectedOwnerUid()
      && (stat.mode & 0o077) === 0
      && current === validated) return;
  } catch {}
  atomicWrite(BACKUP_CONFIG_FILE, `${validated}\n`);
}

export async function getConfiguredBackupRoot(options: { syncFile?: boolean } = {}): Promise<string> {
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'system.backupPath' } });
  const configured = setting?.value || readSmallFile(BACKUP_CONFIG_FILE, MAX_PATH_BYTES + 2)?.trim() || DEFAULT_BACKUP_ROOT;
  const root = ensureBackupLayout(configured);
  if (options.syncFile !== false) writeBackupConfiguration(root);
  return root;
}

export async function initializeBackupConfiguration(): Promise<void> {
  await getConfiguredBackupRoot({ syncFile: true });
}

function backupFilenameMatches(filename: string, type: BackupType): boolean {
  const escapedType = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^portal-${escapedType}-[A-Za-z0-9._-]+\\.tar\\.gz$`).test(filename);
}

export function listBackupFiles(root: string): BackupFile[] {
  const validatedRoot = ensureBackupLayout(root);
  const files: BackupFile[] = [];

  for (const type of BACKUP_TYPES) {
    const directory = path.join(validatedRoot, type);
    const realDirectory = fs.realpathSync(directory);
    for (const filename of fs.readdirSync(directory)) {
      if (!backupFilenameMatches(filename, type)) continue;
      const fullPath = path.join(directory, filename);
      try {
        const stat = fs.lstatSync(fullPath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== expectedOwnerUid()) continue;
        const realPath = fs.realpathSync(fullPath);
        if (!isWithin(realPath, realDirectory)) continue;
        const lockPath = `${fullPath}.locked`;
        let locked = false;
        try {
          const lockStat = fs.lstatSync(lockPath);
          locked = lockStat.isFile() && !lockStat.isSymbolicLink() && lockStat.uid === expectedOwnerUid();
        } catch {}
        files.push({
          filename,
          fullPath,
          type,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          dev: stat.dev,
          ino: stat.ino,
          locked,
        });
      } catch {}
    }
  }
  return files;
}

export function findBackupFile(root: string, filename: string): BackupFile | null {
  if (!filename || filename.length > 255 || filename !== path.basename(filename)) return null;
  return listBackupFiles(root).find((file) => file.filename === filename) || null;
}

function isBackupProcess(status: BackupStatus): boolean {
  if (!status.pid || !Number.isSafeInteger(status.pid) || status.pid <= 1) return false;
  try {
    const cmdline = fs.readFileSync(`/proc/${status.pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return cmdline.includes('backup-full.sh') && cmdline.includes(status.type);
  } catch {
    return false;
  }
}

function readOutputTail(): string | undefined {
  try {
    const stat = fs.lstatSync(BACKUP_OUTPUT_FILE);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const bytes = Math.min(stat.size, MAX_OUTPUT_BYTES);
    const fd = fs.openSync(BACKUP_OUTPUT_FILE, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const bytesRead = fs.readSync(fd, buffer, 0, bytes, Math.max(0, stat.size - bytes));
      return buffer.subarray(0, bytesRead).toString('utf8').trim() || undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

export function parseBackupStatus(raw: string): BackupStatus | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BackupStatus>;
    if (!parsed || typeof parsed.id !== 'string' || parsed.id.length > 128) return null;
    if (!BACKUP_TYPES.includes(parsed.type as BackupType)) return null;
    if (!['queued', 'running', 'completed', 'failed'].includes(String(parsed.status))) return null;
    if (typeof parsed.startedAt !== 'string' || !Number.isFinite(Date.parse(parsed.startedAt))) return null;
    const boundedText = (value: unknown, maximum: number): value is string => (
      typeof value === 'string'
      && Buffer.byteLength(value, 'utf8') <= maximum
      && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
    );
    if (parsed.error !== undefined && !boundedText(parsed.error, 1000)) return null;
    if (parsed.failureDetail !== undefined && !boundedText(parsed.failureDetail, 1000)) return null;
    const progressFields = [parsed.phase, parsed.phaseLabel, parsed.phaseIndex, parsed.phaseTotal];
    const hasProgress = progressFields.some((value) => value !== undefined);
    if (hasProgress && (
      typeof parsed.phase !== 'string'
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(parsed.phase)
      || !boundedText(parsed.phaseLabel, 160)
      || !Number.isSafeInteger(parsed.phaseIndex)
      || !Number.isSafeInteger(parsed.phaseTotal)
      || (parsed.phaseIndex as number) < 1
      || (parsed.phaseTotal as number) < 1
      || (parsed.phaseTotal as number) > 1000
      || (parsed.phaseIndex as number) > (parsed.phaseTotal as number)
    )) return null;
    return parsed as BackupStatus;
  } catch {
    return null;
  }
}

function boundedStatusText(value: string, maximumBytes: number): string {
  const clean = value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(clean, 'utf8') <= maximumBytes) return clean;
  let result = '';
  let bytes = 0;
  for (const character of clean) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function writeBackupStatus(status: BackupStatus): void {
  const normalized = { ...status };
  if (typeof normalized.error === 'string') normalized.error = boundedStatusText(normalized.error, 1000);
  if (typeof normalized.failureDetail === 'string') {
    normalized.failureDetail = boundedStatusText(normalized.failureDetail, 1000);
  }
  if (typeof normalized.phaseLabel === 'string') {
    normalized.phaseLabel = boundedStatusText(normalized.phaseLabel, 160);
  }
  atomicWrite(BACKUP_STATUS_FILE, `${JSON.stringify(normalized)}\n`);
}

export function readBackupStatus(): BackupStatus | null {
  const raw = readSmallFile(BACKUP_STATUS_FILE, MAX_STATUS_BYTES);
  if (!raw) return null;
  const status = parseBackupStatus(raw);
  if (!status) return null;

  const queuedTooLong = status.status === 'queued'
    && Date.now() - Date.parse(status.startedAt) > 2 * 60 * 1000;
  if ((status.status === 'running' && !isBackupProcess(status)) || queuedTooLong) {
    const reconciled: BackupStatus = {
      ...status,
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: status.status === 'queued'
        ? 'Backup service did not start within two minutes'
        : 'Backup process stopped before recording completion',
    };
    reconciled.failureDetail = reconciled.error;
    writeBackupStatus(reconciled);
    return { ...reconciled, output: readOutputTail() };
  }
  return { ...status, output: readOutputTail() };
}

export async function startBackupUnit(type: BackupType): Promise<BackupStatus | null> {
  if (!BACKUP_TYPES.includes(type)) throw new Error('Invalid backup type');
  await getConfiguredBackupRoot({ syncFile: true });

  const existing = readBackupStatus();
  if (existing && ['queued', 'running'].includes(existing.status)) {
    const error = new Error('A backup is already in progress');
    (error as NodeJS.ErrnoException).code = 'EBUSY';
    throw error;
  }

  const requestStatus: BackupStatus = {
    id: `request-${crypto.randomUUID()}`,
    type,
    status: 'queued',
    startedAt: new Date().toISOString(),
  };
  writeBackupStatus(requestStatus);
  const unit = `bridgesllm-backup@${type}.service`;
  try {
    await execFileAsync('systemctl', ['start', '--no-block', unit], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    });
  } catch (error: any) {
    const current = readBackupStatus();
    if (current?.id === requestStatus.id) {
      const failureDetail = boundedStatusText(
        String(error?.message || 'The installed backup service could not be started'),
        1000,
      );
      writeBackupStatus({
        ...requestStatus,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: failureDetail,
        failureDetail,
      });
    }
    throw error;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = readBackupStatus();
    if (status && status.id !== requestStatus.id) return status;
  }
  return readBackupStatus() || requestStatus;
}

export function parseSystemctlProperties(raw: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    properties[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return properties;
}

export function parseOnCalendar(value: string): string | null {
  const match = value.match(/OnCalendar=([^;}]*)/);
  return match?.[1]?.trim() || null;
}

function systemdTimestamp(value: string | undefined): string | null {
  const normalized = String(value || '').trim();
  return normalized && normalized !== 'n/a' ? normalized : null;
}

export async function readBackupSchedules(): Promise<BackupSchedule[]> {
  return Promise.all(TIMER_UNITS.map(async ({ type, timerUnit, serviceUnit }) => {
    let properties: Record<string, string> = {};
    try {
      const result = await execFileAsync('systemctl', [
        'show', timerUnit, '--no-pager',
        '--property=LoadState',
        '--property=ActiveState',
        '--property=UnitFileState',
        '--property=NextElapseUSecRealtime',
        '--property=LastTriggerUSec',
        '--property=TimersCalendar',
      ], { timeout: 5_000, maxBuffer: 128 * 1024, encoding: 'utf8' });
      properties = parseSystemctlProperties(result.stdout);
    } catch {}

    return {
      type,
      source: 'systemd' as const,
      timerUnit,
      serviceUnit,
      loaded: properties.LoadState === 'loaded',
      enabled: ['enabled', 'enabled-runtime', 'static'].includes(properties.UnitFileState),
      active: properties.ActiveState === 'active',
      onCalendar: parseOnCalendar(properties.TimersCalendar || ''),
      nextRun: systemdTimestamp(properties.NextElapseUSecRealtime),
      lastRun: systemdTimestamp(properties.LastTriggerUSec),
    };
  }));
}

export async function readLegacyBackupCron(): Promise<{ active: string[]; disabled: string[] }> {
  try {
    const result = await execFileAsync('crontab', ['-l'], {
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      encoding: 'utf8',
    });
    const lines = result.stdout.split(/\r?\n/);
    return {
      active: lines.filter((line) => line.includes('backup') && line.trim() && !line.trimStart().startsWith('#')),
      disabled: lines.filter((line) => line.includes('backup') && line.trimStart().startsWith('#')),
    };
  } catch {
    return { active: [], disabled: [] };
  }
}
