import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import { prisma } from '../config/database';

export const BACKUP_TYPES = ['daily', 'weekly', 'monthly', 'comprehensive'] as const;
export type BackupType = typeof BACKUP_TYPES[number];
export type BackupCompleteness = 'complete' | 'degraded' | 'unknown';

export interface BackupFile {
  filename: string;
  fullPath: string;
  type: BackupType;
  size: number;
  mtimeMs: number;
  mtimeNs: string;
  dev: string;
  ino: string;
  locked: boolean;
  completeness: BackupCompleteness;
  degradedComponents: string[];
  classificationAuthenticated: boolean;
}

export interface BackupStatus {
  id: string;
  type: BackupType;
  status: 'queued' | 'running' | 'completed' | 'degraded' | 'failed';
  startedAt: string;
  completedAt?: string;
  pid?: number;
  exitCode?: number;
  archivePath?: string;
  error?: string;
  failureCode?: string;
  failureDetail?: string;
  phase?: string;
  phaseLabel?: string;
  phaseIndex?: number;
  phaseTotal?: number;
  output?: string;
  consecutiveFailures?: number;
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
const MAX_RECEIPT_BYTES = 16 * 1024;
const BACKUP_RECEIPT_SCHEMA = 'bridgesllm.backup-publication.v1';
export const BACKUP_REQUEST_RECEIPT_SCHEMA = 'bridgesllm.backup-request.v1';
const BACKUP_REQUEST_ID_PATTERN = /^request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BACKUP_TIMER_ID_PATTERN = /^timer-(daily|weekly|monthly|comprehensive)-[0-9]{8}T[0-9]{6}-[1-9][0-9]*$/;
const MAX_BACKUP_REQUEST_RECEIPTS = 32;

export interface BackupRequestReceipt {
  schema: typeof BACKUP_REQUEST_RECEIPT_SCHEMA;
  id: string;
  type: BackupType;
  requestedAt: string;
}

export interface CreatedBackupRequestReceipt {
  receipt: BackupRequestReceipt;
  fullPath: string;
  dev: string;
  ino: string;
}

interface AttestedBackupRequestReceipt extends CreatedBackupRequestReceipt {
  state: 'pending' | 'claimed';
}

export class BackupRequestPublicError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'BackupRequestPublicError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

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

function expectedOwnerGid(): number {
  return typeof process.getgid === 'function' ? process.getgid() : 0;
}

export function expectedBackupOwnerIdentity(): { uid: number; gid: number } {
  return { uid: expectedOwnerUid(), gid: expectedOwnerGid() };
}

/**
 * Hold the same kernel flock used by backup-full.sh. This coordinates Portal
 * backup mutations with shell rotation/pruning and intentionally accepts an
 * already-open descriptor in the child so a pathname swap cannot redirect the
 * lock after validation.
 */
interface BackupMutationLeaseState {
  child: ReturnType<typeof spawn>;
  descriptors: number[];
  live: boolean;
  releasing: boolean;
}

const activeBackupMutationLeases = new WeakMap<object, BackupMutationLeaseState>();
export interface BackupMutationLockLease { readonly kind: 'backup-mutation-lock'; }

export function assertBackupMutationLockLease(lease: BackupMutationLockLease): void {
  const state = lease ? activeBackupMutationLeases.get(lease) : undefined;
  if (!state || !state.live || state.releasing
    || state.child.exitCode !== null || state.child.signalCode !== null) {
    throw new Error('Backup mutation lock lease is not held');
  }
}

export interface BackupMutationLockOptions {
  operationLockPath?: string;
  stateDirectory?: string;
  timeoutSeconds?: number;
}

export class BackupMutationLockContentionError extends Error {
  readonly code = 'BACKUP_MUTATION_LOCK_CONTENDED';

  constructor(public readonly lockExitCode: 71 | 72) {
    super('Backup mutation lock remains owned by another operation');
    this.name = 'BackupMutationLockContentionError';
  }
}

export async function acquireBackupMutationLock(options: BackupMutationLockOptions = {}): Promise<{
  lease: BackupMutationLockLease;
  release(): Promise<void>;
}> {
  const stateDirectory = path.resolve(options.stateDirectory || BACKUP_STATE_DIR);
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const stateStat = fs.lstatSync(stateDirectory);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()
    || stateStat.uid !== expectedOwnerUid() || stateStat.gid !== expectedOwnerGid()
    || (stateStat.mode & 0o077) !== 0) {
    throw new Error('Backup state directory is unsafe');
  }
  const lockPaths = [
    path.resolve(options.operationLockPath
      || process.env.PORTAL_OPERATION_LOCK_FILE
      || '/run/lock/bridgesllm-portal-installer.lock'),
    path.join(stateDirectory, 'backup.lock'),
  ];
  const descriptors: number[] = [];
  let descriptorsTransferred = false;
  try {
    for (const lockPath of lockPaths) {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o755 });
      const descriptor = fs.openSync(
        lockPath,
        fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      descriptors.push(descriptor);
      fs.fchmodSync(descriptor, 0o600);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1
        || stat.uid !== expectedOwnerUid() || stat.gid !== expectedOwnerGid()
        || (stat.mode & 0o077) !== 0) {
        throw new Error('Backup mutation lock is unsafe');
      }
    }
    const acquired = await new Promise<{
      lease: BackupMutationLockLease;
      child: ReturnType<typeof spawn>;
    }>((resolve, reject) => {
      const timeoutSeconds = Math.max(1, Math.min(300, Number(options.timeoutSeconds ?? 60)));
      const child = spawn(
        '/bin/sh',
        [
          '-c',
          '/usr/bin/flock --exclusive --timeout "$1" 3 || exit 71; '
            + '/usr/bin/flock --exclusive --timeout "$1" 4 || exit 72; '
            + 'printf "LOCKED\\n"; IFS= read -r _',
          'bridgesllm-backup-mutation-lock',
          String(timeoutSeconds),
        ],
        { stdio: ['pipe', 'pipe', 'pipe', ...descriptors], detached: true },
      );
      let settled = false;
      let ready = false;
      let stdout = '';
      let stderr = '';
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        child.stdin?.destroy();
        reject(error);
      };
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk) => { stderr += chunk; });
      child.on('error', fail);
      child.on('exit', (code) => {
        if (!settled && !ready) {
          fail(code === 71 || code === 72
            ? new BackupMutationLockContentionError(code)
            : new Error(`Backup mutation lock failed (${code ?? 'signal'}): ${stderr.trim()}`));
        }
      });
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk) => {
        if (settled || ready) return;
        stdout += chunk;
        if (!stdout.includes('\n')) return;
        if (stdout.trim() !== 'LOCKED') {
          fail(new Error('Backup mutation lock returned an invalid handshake'));
          return;
        }
        ready = true;
        const lease: BackupMutationLockLease = Object.freeze({ kind: 'backup-mutation-lock' });
        const state: BackupMutationLeaseState = {
          child,
          // flock(2) locks the inherited open-file descriptions. Retaining
          // the parent's descriptors preserves kernel exclusion even if the
          // helper dies before Node can process its exit event. Explicit
          // release below is the sole lock-release point.
          descriptors,
          live: true,
          releasing: false,
        };
        activeBackupMutationLeases.set(lease, state);
        child.once('exit', () => {
          state.live = false;
          activeBackupMutationLeases.delete(lease);
        });
        descriptorsTransferred = true;
        settled = true;
        resolve({ lease, child });
      });
    });
    let released = false;
    return {
      lease: acquired.lease,
      release: async () => {
        if (released) return;
        released = true;
        const state = activeBackupMutationLeases.get(acquired.lease);
        if (state) state.releasing = true;
        activeBackupMutationLeases.delete(acquired.lease);
        await new Promise<void>((resolve) => {
          if (acquired.child.exitCode !== null || acquired.child.signalCode !== null) return resolve();
          acquired.child.once('exit', () => resolve());
          if (state?.live) {
            acquired.child.stdin?.once('error', () => undefined);
            acquired.child.stdin?.end('\n');
          }
        });
        for (const descriptor of state?.descriptors || descriptors) {
          try { fs.closeSync(descriptor); } catch {}
        }
      },
    };
  } finally {
    if (!descriptorsTransferred) {
      for (const descriptor of descriptors) fs.closeSync(descriptor);
    }
  }
}

export const __backupMutationLockTest = {
  terminateHolderExternally(lease: BackupMutationLockLease): void {
    const state = activeBackupMutationLeases.get(lease);
    if (!state) throw new Error('Backup mutation holder is unavailable');
    if (state.child.pid) process.kill(-state.child.pid, 'SIGKILL');
  },
};

export async function withBackupMutationLock<T>(
  callback: (lease: BackupMutationLockLease) => Promise<T>,
  options: BackupMutationLockOptions = {},
): Promise<T> {
  const acquired = await acquireBackupMutationLock(options);
  try {
    assertBackupMutationLockLease(acquired.lease);
    const result = await callback(acquired.lease);
    assertBackupMutationLockLease(acquired.lease);
    return result;
  } finally {
    await acquired.release();
  }
}

export async function isBackupReferencedByLiveDependencyRepair(file: Pick<BackupFile,
  'fullPath' | 'dev' | 'ino' | 'size' | 'mtimeNs'>): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "ProjectDependencyRepairOperation"
      WHERE "status" = 'PROMOTING'
        AND "backupPath" = ${file.fullPath}
        AND "backupDevice" = ${file.dev}
        AND "backupInode" = ${file.ino}
        AND "backupSize" = ${BigInt(file.size)}
        AND "backupMtimeNs" = ${file.mtimeNs}
    ) AS "exists"
  `;
  return rows[0]?.exists === true;
}

export interface RepairOwnedBackupLockMarker {
  schemaVersion: 1;
  kind: 'bridgesllm.project-dependency-repair-backup-pin';
  repairId: string;
  backupFingerprintDigest: string;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  workspaceOwnerId: string;
  projectName: string;
  promotionOperationId: string;
  manifestDigest: string;
}

export function readRepairOwnedBackupLockMarker(
  file: Pick<BackupFile, 'fullPath'>,
): RepairOwnedBackupLockMarker | null {
  const marker = `${file.fullPath}.locked`;
  try {
    const stat = fs.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== expectedOwnerUid() || stat.gid !== expectedOwnerGid()
      || (stat.mode & 0o777) !== 0o600 || stat.size <= 0 || stat.size > 16_384) return null;
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
    const after = fs.lstatSync(marker);
    const valid = after.dev === stat.dev && after.ino === stat.ino && after.size === stat.size
      && after.mtimeMs === stat.mtimeMs && after.nlink === 1
      && parsed?.schemaVersion === 1
      && parsed?.kind === 'bridgesllm.project-dependency-repair-backup-pin'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        String(parsed?.repairId || ''),
      )
      && /^[a-f0-9]{64}$/.test(String(parsed?.backupFingerprintDigest || ''))
      && typeof parsed?.projectIdentityId === 'string' && parsed.projectIdentityId.length > 0
      && Number.isInteger(parsed?.projectIdentityGeneration) && parsed.projectIdentityGeneration > 0
      && typeof parsed?.workspaceOwnerId === 'string' && parsed.workspaceOwnerId.length > 0
      && typeof parsed?.projectName === 'string' && parsed.projectName.length > 0
      && !parsed.projectName.includes('/') && !parsed.projectName.includes('\\')
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        String(parsed?.promotionOperationId || ''),
      )
      && /^[a-f0-9]{64}$/.test(String(parsed?.manifestDigest || ''));
    return valid ? parsed as RepairOwnedBackupLockMarker : null;
  } catch { return null; }
}

export function isRepairOwnedBackupLockMarker(file: Pick<BackupFile, 'fullPath'>): boolean {
  return readRepairOwnedBackupLockMarker(file) !== null;
}

export function removeExactRepairOwnedBackupLockMarker(input: {
  file: Pick<BackupFile, 'fullPath'>;
  expected: RepairOwnedBackupLockMarker;
  lease: BackupMutationLockLease;
}): void {
  assertBackupMutationLockLease(input.lease);
  const current = readRepairOwnedBackupLockMarker(input.file);
  if (!current || JSON.stringify(current) !== JSON.stringify(input.expected)) {
    throw new Error('Repair-owned backup pin changed before retirement');
  }
  const marker = `${input.file.fullPath}.locked`;
  assertBackupMutationLockLease(input.lease);
  fs.unlinkSync(marker);
  const parent = fs.openSync(
    path.dirname(marker),
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
  );
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

export function backupReceiptSigningPayload(input: {
  archive: string;
  backupType: BackupType;
  completeness: Exclude<BackupCompleteness, 'unknown'>;
  archiveSize: number;
  archiveMtimeNs: string;
  manifestHmac: string;
  degradedComponents: string[];
}): Buffer {
  const fields = [
    BACKUP_RECEIPT_SCHEMA,
    input.archive,
    input.backupType,
    input.completeness,
    String(input.archiveSize),
    input.archiveMtimeNs,
    input.manifestHmac,
    String(input.degradedComponents.length),
    ...input.degradedComponents,
  ];
  return Buffer.from(`${fields.join('\0')}\0`, 'utf8');
}

function readBackupTrustKey(): Buffer {
  const rawRoot = process.env.BRIDGESLLM_BACKUP_TRUST_ROOT || '/var/lib/bridgesllm/backup-trust';
  if (!path.isAbsolute(rawRoot) || path.resolve(rawRoot) !== rawRoot) {
    throw new Error('Backup trust root is not canonical');
  }
  const rootStat = fs.lstatSync(rawRoot);
  if (rootStat.isSymbolicLink()
    || !rootStat.isDirectory()
    || rootStat.uid !== expectedOwnerUid()
    || rootStat.gid !== expectedOwnerGid()
    || (rootStat.mode & 0o077) !== 0
    || fs.realpathSync(rawRoot) !== rawRoot) {
    throw new Error('Backup trust root is unsafe');
  }
  const keyPath = path.join(rawRoot, 'archive-hmac.key');
  const keyStat = fs.lstatSync(keyPath);
  if (keyStat.isSymbolicLink()
    || !keyStat.isFile()
    || keyStat.uid !== expectedOwnerUid()
    || keyStat.gid !== expectedOwnerGid()
    || keyStat.nlink !== 1
    || (keyStat.mode & 0o777) !== 0o600
    || keyStat.size !== 32) {
    throw new Error('Backup trust key is unsafe');
  }
  const key = fs.readFileSync(keyPath);
  if (key.length !== 32) throw new Error('Backup trust key length changed');
  return key;
}

function authenticatedBackupClassification(
  fullPath: string,
  type: BackupType,
  expected: Exclude<BackupCompleteness, 'unknown'>,
): Pick<BackupFile, 'completeness' | 'degradedComponents' | 'classificationAuthenticated'> {
  const unknown = {
    completeness: 'unknown' as const,
    degradedComponents: [],
    classificationAuthenticated: false,
  };
  try {
    const receiptPath = `${fullPath}.receipt.json`;
    const receiptStat = fs.lstatSync(receiptPath);
    if (receiptStat.isSymbolicLink()
      || !receiptStat.isFile()
      || receiptStat.uid !== expectedOwnerUid()
      || receiptStat.gid !== expectedOwnerGid()
      || receiptStat.nlink !== 1
      || (receiptStat.mode & 0o777) !== 0o600
      || receiptStat.size <= 0
      || receiptStat.size > MAX_RECEIPT_BYTES) return unknown;
    const parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort();
    const expectedKeys = [
      'archive', 'archiveMtimeNs', 'archiveSize', 'backupType', 'completeness',
      'degradedComponents', 'manifestHmac', 'schema', 'signature',
    ].sort();
    if (keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])) return unknown;
    const archiveStat = fs.lstatSync(fullPath, { bigint: true });
    const completeness = parsed.completeness;
    const degradedComponents = parsed.degradedComponents;
    if (parsed.schema !== BACKUP_RECEIPT_SCHEMA
      || parsed.archive !== path.basename(fullPath)
      || parsed.backupType !== type
      || completeness !== expected
      || (completeness !== 'complete' && completeness !== 'degraded')
      || !Number.isSafeInteger(parsed.archiveSize)
      || BigInt(parsed.archiveSize as number) !== archiveStat.size
      || typeof parsed.archiveMtimeNs !== 'string'
      || !/^\d{1,32}$/.test(parsed.archiveMtimeNs)
      || BigInt(parsed.archiveMtimeNs) !== archiveStat.mtimeNs
      || typeof parsed.manifestHmac !== 'string'
      || !/^[0-9a-f]{64}$/.test(parsed.manifestHmac)
      || !Array.isArray(degradedComponents)
      || degradedComponents.length > 128
      || degradedComponents.some((entry) => typeof entry !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry))
      || degradedComponents.some((entry, index) => index > 0 && entry <= degradedComponents[index - 1])
      || (completeness === 'complete' && degradedComponents.length !== 0)
      || (completeness === 'degraded' && degradedComponents.length === 0)
      || typeof parsed.signature !== 'string'
      || !/^[0-9a-f]{64}$/.test(parsed.signature)) return unknown;
    const signed = backupReceiptSigningPayload({
      archive: parsed.archive as string,
      backupType: type,
      completeness,
      archiveSize: parsed.archiveSize as number,
      archiveMtimeNs: parsed.archiveMtimeNs,
      manifestHmac: parsed.manifestHmac,
      degradedComponents: degradedComponents as string[],
    });
    const expectedSignature = crypto.createHmac('sha256', readBackupTrustKey()).update(signed).digest();
    const actualSignature = Buffer.from(parsed.signature, 'hex');
    if (actualSignature.length !== expectedSignature.length
      || !crypto.timingSafeEqual(actualSignature, expectedSignature)) return unknown;
    return {
      completeness,
      degradedComponents: degradedComponents as string[],
      classificationAuthenticated: true,
    };
  } catch {
    return unknown;
  }
}

/** Re-run the signed publication receipt against the archive's current bytes. */
export function reauthenticateBackupClassification(
  fullPath: string,
  type: BackupType,
  expected: Exclude<BackupCompleteness, 'unknown'>,
): Pick<BackupFile, 'completeness' | 'degradedComponents' | 'classificationAuthenticated'> {
  return authenticatedBackupClassification(fullPath, type, expected);
}

function assertSecureDirectoryChain(
  directory: string,
  expectedUid = expectedOwnerUid(),
  expectedGid = expectedOwnerGid(),
): void {
  const parsed = path.parse(directory);
  let current = parsed.root;
  const segments = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);

  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Backup path cannot contain symbolic links: ${current}`);
    if (!stat.isDirectory()) throw new Error(`Backup path component is not a directory: ${current}`);
    if (stat.uid !== expectedUid) throw new Error(`Backup path must be owned by uid ${expectedUid}: ${current}`);
    if (stat.gid !== expectedGid) throw new Error(`Backup path must be owned by gid ${expectedGid}: ${current}`);
    if ((stat.mode & 0o022) !== 0) throw new Error(`Backup path cannot be group/world writable: ${current}`);
  }
}

function assertSecureExistingPrefix(
  directory: string,
  expectedUid = expectedOwnerUid(),
  expectedGid = expectedOwnerGid(),
): void {
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
    if (stat.gid !== expectedGid) throw new Error(`Backup path must be owned by gid ${expectedGid}: ${current}`);
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

  for (const name of [...BACKUP_TYPES, 'logs', 'degraded'] as const) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()
      || stat.uid !== expectedOwnerUid() || stat.gid !== expectedOwnerGid()
      || (stat.mode & 0o022) !== 0) {
      throw new Error(`Backup directory is not securely owned: ${directory}`);
    }
  }
  for (const type of BACKUP_TYPES) {
    const directory = path.join(root, 'degraded', type);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()
      || stat.uid !== expectedOwnerUid() || stat.gid !== expectedOwnerGid()
      || (stat.mode & 0o022) !== 0) {
      throw new Error(`Degraded backup directory is not securely owned: ${directory}`);
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
    const descriptor = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      mode,
    );
    try {
      fs.fchmodSync(descriptor, mode);
      fs.writeFileSync(descriptor, content, { encoding: 'utf8' });
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, mode);
    const published = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    try { fs.fsyncSync(published); } finally { fs.closeSync(published); }
    fsyncDirectory(path.dirname(filePath));
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY
      | (fs.constants.O_DIRECTORY || 0)
      | (fs.constants.O_NOFOLLOW || 0),
  );
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function ensureBackupRequestDirectory(stateDirectory = BACKUP_STATE_DIR): string {
  const normalizedState = path.resolve(stateDirectory);
  if (!path.isAbsolute(stateDirectory)
    || normalizedState !== stateDirectory
    || normalizedState === path.parse(normalizedState).root
    || Buffer.byteLength(normalizedState, 'utf8') > MAX_PATH_BYTES
    || /[\x00-\x1f\x7f]/.test(normalizedState)) {
    throw new Error('Backup request state directory is not canonical and bounded');
  }
  assertSecureExistingPrefix(normalizedState);
  fs.mkdirSync(normalizedState, { recursive: true, mode: 0o700 });
  fs.chmodSync(normalizedState, 0o700);
  assertSecureDirectoryChain(normalizedState);
  const stateStat = fs.lstatSync(normalizedState);
  if ((stateStat.mode & 0o777) !== 0o700 || fs.realpathSync(normalizedState) !== normalizedState) {
    throw new Error('Backup request state directory is unsafe');
  }

  const requestDirectory = path.join(normalizedState, 'requests');
  try {
    const existing = fs.lstatSync(requestDirectory);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error('Backup request receipt directory is unsafe');
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    fs.mkdirSync(requestDirectory, { mode: 0o700 });
  }
  fs.chmodSync(requestDirectory, 0o700);
  const requestStat = fs.lstatSync(requestDirectory);
  if (!requestStat.isDirectory()
    || requestStat.isSymbolicLink()
    || requestStat.uid !== expectedOwnerUid()
    || requestStat.gid !== expectedOwnerGid()
    || (requestStat.mode & 0o777) !== 0o700
    || fs.realpathSync(requestDirectory) !== requestDirectory) {
    throw new Error('Backup request receipt directory is unsafe');
  }
  return requestDirectory;
}

function backupRequestReceiptPath(
  type: BackupType,
  id: string,
  stateDirectory = BACKUP_STATE_DIR,
): string {
  if (!BACKUP_TYPES.includes(type) || !BACKUP_REQUEST_ID_PATTERN.test(id)) {
    throw new Error('Backup request receipt identity is invalid');
  }
  const requestDirectory = ensureBackupRequestDirectory(stateDirectory);
  const fullPath = path.join(requestDirectory, `${type}.${id}.pending.json`);
  if (path.dirname(fullPath) !== requestDirectory || !isWithin(fullPath, requestDirectory)) {
    throw new Error('Backup request receipt escaped its state directory');
  }
  return fullPath;
}

/**
 * Publish the exact UI request identity before systemd is started. The shell
 * claims this root-owned O_EXCL receipt under the backup lock; no environment
 * expansion or mutable unit property carries authority across that boundary.
 */
export function createBackupRequestReceipt(
  type: BackupType,
  options: { id?: string; requestedAt?: string; stateDirectory?: string } = {},
): CreatedBackupRequestReceipt {
  const id = options.id || `request-${crypto.randomUUID()}`;
  const requestedAt = options.requestedAt || new Date().toISOString();
  const parsedRequestedAt = Date.parse(requestedAt);
  if (!Number.isFinite(parsedRequestedAt)
    || new Date(parsedRequestedAt).toISOString() !== requestedAt) {
    throw new Error('Backup request receipt timestamp is invalid');
  }
  const stateDirectory = options.stateDirectory || BACKUP_STATE_DIR;
  const fullPath = backupRequestReceiptPath(type, id, stateDirectory);
  const receipt: BackupRequestReceipt = {
    schema: BACKUP_REQUEST_RECEIPT_SCHEMA,
    id,
    type,
    requestedAt,
  };
  const payload = `${JSON.stringify(receipt)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > 4096) {
    throw new Error('Backup request receipt is unexpectedly large');
  }

  let descriptor: number | null = null;
  let created = false;
  try {
    descriptor = fs.openSync(
      fullPath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    created = true;
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, payload, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()
      || opened.nlink !== 1n
      || opened.uid !== BigInt(expectedOwnerUid())
      || opened.gid !== BigInt(expectedOwnerGid())
      || (opened.mode & 0o777n) !== 0o600n) {
      throw new Error('Backup request receipt did not retain its file contract');
    }
    fs.closeSync(descriptor);
    descriptor = null;
    fsyncDirectory(path.dirname(fullPath));
    return {
      receipt,
      fullPath,
      dev: opened.dev.toString(),
      ino: opened.ino.toString(),
    };
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (created) {
      try { fs.unlinkSync(fullPath); } catch {}
      try { fsyncDirectory(path.dirname(fullPath)); } catch {}
    }
    throw error;
  }
}

function attestBackupRequestReceipt(
  requestDirectory: string,
  filename: string,
): AttestedBackupRequestReceipt {
  const match = /^(daily|weekly|monthly|comprehensive)\.(request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(pending|claimed)\.json$/
    .exec(filename);
  if (!match) {
    throw new BackupRequestPublicError(
      'BACKUP_REQUEST_RECOVERY_REQUIRED',
      'Backup request authority is unsafe or ambiguous and requires administrator recovery',
    );
  }
  const [, rawType, id, rawState] = match;
  const type = rawType as BackupType;
  const state = rawState as 'pending' | 'claimed';
  const fullPath = path.join(requestDirectory, filename);
  if (path.dirname(fullPath) !== requestDirectory || !isWithin(fullPath, requestDirectory)) {
    throw new BackupRequestPublicError(
      'BACKUP_REQUEST_RECOVERY_REQUIRED',
      'Backup request authority escaped its protected state directory',
    );
  }
  const before = fs.lstatSync(fullPath, { bigint: true });
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1n
    || before.uid !== BigInt(expectedOwnerUid())
    || before.gid !== BigInt(expectedOwnerGid())
    || (before.mode & 0o777n) !== 0o600n
    || before.size <= 0n
    || before.size > 4096n) {
    throw new BackupRequestPublicError(
      'BACKUP_REQUEST_RECOVERY_REQUIRED',
      'Backup request authority has unsafe ownership, permissions, or size',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (cause) {
    throw new BackupRequestPublicError(
      'BACKUP_REQUEST_RECOVERY_REQUIRED',
      'Backup request authority is unreadable and requires administrator recovery',
      cause,
    );
  }
  const receipt = parsed as Partial<BackupRequestReceipt>;
  const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.keys(parsed as Record<string, unknown>).sort()
    : [];
  const requestedAtMs = typeof receipt.requestedAt === 'string'
    ? Date.parse(receipt.requestedAt)
    : Number.NaN;
  const after = fs.lstatSync(fullPath, { bigint: true });
  if (keys.join(',') !== 'id,requestedAt,schema,type'
    || receipt.schema !== BACKUP_REQUEST_RECEIPT_SCHEMA
    || receipt.id !== id
    || receipt.type !== type
    || typeof receipt.requestedAt !== 'string'
    || !Number.isFinite(requestedAtMs)
    || new Date(requestedAtMs).toISOString() !== receipt.requestedAt
    || requestedAtMs > Date.now() + 60_000
    || requestedAtMs < Date.now() - 30 * 24 * 60 * 60 * 1000
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mtimeNs !== before.mtimeNs) {
    throw new BackupRequestPublicError(
      'BACKUP_REQUEST_RECOVERY_REQUIRED',
      'Backup request authority changed or is malformed and requires administrator recovery',
    );
  }
  return {
    receipt: receipt as BackupRequestReceipt,
    fullPath,
    dev: before.dev.toString(),
    ino: before.ino.toString(),
    state,
  };
}

function enumerateBackupRequestReceipts(
  lease: BackupMutationLockLease,
): AttestedBackupRequestReceipt[] {
  assertBackupMutationLockLease(lease);
  const requestDirectory = ensureBackupRequestDirectory();
  const directory = fs.opendirSync(requestDirectory);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      names.push(entry.name);
      if (names.length > MAX_BACKUP_REQUEST_RECEIPTS) {
        throw new BackupRequestPublicError(
          'BACKUP_REQUEST_RECOVERY_REQUIRED',
          'Backup request authority contains too many recovery candidates',
        );
      }
    }
  } finally {
    directory.closeSync();
  }
  const receipts = names.sort().map((name) => attestBackupRequestReceipt(requestDirectory, name));
  if (receipts.length > 1) {
    throw new BackupRequestPublicError(
      'BACKUP_REQUEST_RECOVERY_REQUIRED',
      'Multiple backup request authorities require administrator recovery before dispatch',
    );
  }
  assertBackupMutationLockLease(lease);
  return receipts;
}

function removeAttestedBackupRequestReceipt(
  attested: AttestedBackupRequestReceipt,
  lease: BackupMutationLockLease,
): boolean {
  assertBackupMutationLockLease(lease);
  try {
    const current = attestBackupRequestReceipt(
      path.dirname(attested.fullPath),
      path.basename(attested.fullPath),
    );
    if (current.dev !== attested.dev
      || current.ino !== attested.ino
      || current.state !== attested.state
      || current.receipt.requestedAt !== attested.receipt.requestedAt) {
      throw new BackupRequestPublicError(
        'BACKUP_REQUEST_RECOVERY_REQUIRED',
        'Backup request authority changed before exact retirement',
      );
    }
    assertBackupMutationLockLease(lease);
    fs.unlinkSync(attested.fullPath);
    fsyncDirectory(path.dirname(attested.fullPath));
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/** Remove only the still-pending inode published by createBackupRequestReceipt. */
export function removeExactBackupRequestReceipt(
  created: CreatedBackupRequestReceipt,
): boolean {
  const expectedPath = backupRequestReceiptPath(
    created.receipt.type,
    created.receipt.id,
    path.dirname(path.dirname(created.fullPath)),
  );
  if (expectedPath !== created.fullPath) {
    throw new Error('Backup request receipt path changed before retirement');
  }
  try {
    const stat = fs.lstatSync(created.fullPath, { bigint: true });
    if (!stat.isFile()
      || stat.isSymbolicLink()
      || stat.nlink !== 1n
      || stat.uid !== BigInt(expectedOwnerUid())
      || stat.gid !== BigInt(expectedOwnerGid())
      || (stat.mode & 0o777n) !== 0o600n
      || stat.dev.toString() !== created.dev
      || stat.ino.toString() !== created.ino) {
      throw new Error('Backup request receipt changed before retirement');
    }
    fs.unlinkSync(created.fullPath);
    fsyncDirectory(path.dirname(created.fullPath));
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
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

/** Resolve the configured root without creating, chmodding, or syncing paths. */
export function getConfiguredBackupRootReadOnly(databaseValue?: string | null): string {
  const configured = databaseValue
    || readSmallFile(BACKUP_CONFIG_FILE, MAX_PATH_BYTES + 2)?.trim()
    || DEFAULT_BACKUP_ROOT;
  return normalizeBackupRoot(configured);
}

export async function initializeBackupConfiguration(): Promise<void> {
  await getConfiguredBackupRoot({ syncFile: true });
}

function backupFilenameMatches(filename: string, type: BackupType): boolean {
  const escapedType = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^portal-${escapedType}-[A-Za-z0-9._-]+\\.tar\\.gz$`).test(filename);
}

export function listBackupFiles(root: string, options: { readOnly?: boolean } = {}): BackupFile[] {
  const validatedRoot = options.readOnly ? normalizeBackupRoot(root) : ensureBackupLayout(root);
  if (options.readOnly) {
    assertSecureDirectoryChain(validatedRoot);
    const rootStat = fs.lstatSync(validatedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
      || fs.realpathSync.native(validatedRoot) !== validatedRoot) {
      throw new Error('Backup root is unsafe');
    }
  }
  const files: BackupFile[] = [];

  for (const type of BACKUP_TYPES) {
    const locations: Array<{
      directory: string;
      expected: Exclude<BackupCompleteness, 'unknown'>;
    }> = [
      { directory: path.join(validatedRoot, type), expected: 'complete' },
      { directory: path.join(validatedRoot, 'degraded', type), expected: 'degraded' },
    ];
    for (const { directory, expected } of locations) {
      let realDirectory: string;
      try {
        const directoryStat = fs.lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
          || directoryStat.uid !== expectedOwnerUid() || directoryStat.gid !== expectedOwnerGid()
          || (directoryStat.mode & 0o022) !== 0) throw new Error('Backup directory is unsafe');
        realDirectory = fs.realpathSync(directory);
        if (realDirectory !== directory) throw new Error('Backup directory is not canonical');
      } catch (error: any) {
        if (options.readOnly && error?.code === 'ENOENT') continue;
        throw error;
      }
      for (const filename of fs.readdirSync(directory)) {
        if (!backupFilenameMatches(filename, type)) continue;
        const fullPath = path.join(directory, filename);
        try {
          const stat = fs.lstatSync(fullPath, { bigint: true });
          if (stat.isSymbolicLink() || !stat.isFile()
            || stat.uid !== BigInt(expectedOwnerUid()) || stat.gid !== BigInt(expectedOwnerGid())
            || stat.nlink !== 1n || (stat.mode & 0o022n) !== 0n) continue;
          const realPath = fs.realpathSync(fullPath);
          if (!isWithin(realPath, realDirectory)) continue;
          const lockPath = `${fullPath}.locked`;
          let locked = false;
          try {
            const lockStat = fs.lstatSync(lockPath);
            locked = lockStat.isFile() && !lockStat.isSymbolicLink()
              && lockStat.uid === expectedOwnerUid() && lockStat.gid === expectedOwnerGid()
              && lockStat.nlink === 1 && (lockStat.mode & 0o077) === 0;
          } catch {}
          files.push({
            filename,
            fullPath,
            type,
            size: Number(stat.size),
            mtimeMs: Number(stat.mtimeNs) / 1_000_000,
            mtimeNs: stat.mtimeNs.toString(),
            dev: stat.dev.toString(),
            ino: stat.ino.toString(),
            locked,
            ...authenticatedBackupClassification(fullPath, type, expected),
          });
        } catch {}
      }
    }
  }
  return files;
}

export function findBackupFile(root: string, filename: string): BackupFile | null {
  if (!filename || filename.length > 255 || filename !== path.basename(filename)) return null;
  const matches = listBackupFiles(root).filter((file) => file.filename === filename);
  return matches.length === 1 ? matches[0] : null;
}

export function deleteBackupFile(file: BackupFile, lease?: BackupMutationLockLease): void {
  if (lease) assertBackupMutationLockLease(lease);
  const archiveStat = fs.lstatSync(file.fullPath, { bigint: true });
  if (archiveStat.isSymbolicLink()
    || !archiveStat.isFile()
    || archiveStat.uid !== BigInt(expectedOwnerUid())
    || archiveStat.gid !== BigInt(expectedOwnerGid())
    || archiveStat.nlink !== 1n
    || (archiveStat.mode & 0o022n) !== 0n
    || archiveStat.dev.toString() !== file.dev
    || archiveStat.ino.toString() !== file.ino
    || archiveStat.size !== BigInt(file.size)
    || archiveStat.mtimeNs.toString() !== file.mtimeNs) {
    throw new Error('Backup changed before deletion');
  }
  const receiptPath = `${file.fullPath}.receipt.json`;
  try {
    const receiptStat = fs.lstatSync(receiptPath);
    if (receiptStat.isSymbolicLink()
      || !receiptStat.isFile()
      || receiptStat.uid !== expectedOwnerUid()
      || receiptStat.gid !== expectedOwnerGid()
      || receiptStat.nlink !== 1
      || (receiptStat.mode & 0o077) !== 0) {
      throw new Error('Backup receipt is unsafe to delete');
    }
    // Remove authentication metadata first. A crash can leave an explicitly
    // unclassified archive, but never a stale authenticated receipt that can
    // bind to a later file with the same name.
    if (lease) assertBackupMutationLockLease(lease);
    fs.unlinkSync(receiptPath);
    const directoryFd = fs.openSync(path.dirname(file.fullPath), 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const current = fs.lstatSync(file.fullPath, { bigint: true });
  if (current.isSymbolicLink()
    || !current.isFile()
    || current.dev !== archiveStat.dev
    || current.ino !== archiveStat.ino
    || current.size !== archiveStat.size
    || current.mtimeNs !== archiveStat.mtimeNs) {
    throw new Error('Backup changed while deletion was prepared');
  }
  if (lease) assertBackupMutationLockLease(lease);
  fs.unlinkSync(file.fullPath);
  const directoryFd = fs.openSync(path.dirname(file.fullPath), 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}

function isBackupProcess(status: BackupStatus): boolean {
  if (!status.pid || !Number.isSafeInteger(status.pid) || status.pid <= 1) return false;
  try {
    const cmdline = fs.readFileSync(`/proc/${status.pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return (cmdline.includes('backup-full.sh') || cmdline.includes('backup-data.py')) && cmdline.includes(status.type);
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
    if (!['queued', 'running', 'completed', 'degraded', 'failed'].includes(String(parsed.status))) return null;
    if (typeof parsed.startedAt !== 'string' || !Number.isFinite(Date.parse(parsed.startedAt))) return null;
    const boundedText = (value: unknown, maximum: number): value is string => (
      typeof value === 'string'
      && Buffer.byteLength(value, 'utf8') <= maximum
      && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
    );
    if (parsed.error !== undefined && !boundedText(parsed.error, 1000)) return null;
    if (parsed.failureCode !== undefined && (
      typeof parsed.failureCode !== 'string'
      || !/^BACKUP_[A-Z0-9_]{1,56}$/.test(parsed.failureCode)
    )) return null;
    if (parsed.failureDetail !== undefined && !boundedText(parsed.failureDetail, 1000)) return null;
    if (parsed.consecutiveFailures !== undefined && (
      !Number.isSafeInteger(parsed.consecutiveFailures)
      || (parsed.consecutiveFailures as number) < 0
      || (parsed.consecutiveFailures as number) > 100_000
    )) return null;
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
  if (typeof normalized.failureCode === 'string'
    && !/^BACKUP_[A-Z0-9_]{1,56}$/.test(normalized.failureCode)) {
    throw new Error('Backup failure code is invalid');
  }
  if (typeof normalized.failureDetail === 'string') {
    normalized.failureDetail = boundedStatusText(normalized.failureDetail, 1000);
  }
  if (typeof normalized.phaseLabel === 'string') {
    normalized.phaseLabel = boundedStatusText(normalized.phaseLabel, 160);
  }
  atomicWrite(BACKUP_STATUS_FILE, `${JSON.stringify(normalized)}\n`);
}

interface BackupStatusSnapshot {
  status: BackupStatus | null;
  identity: null | {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
  };
}

function readPersistedBackupStatusSnapshot(): BackupStatusSnapshot {
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(BACKUP_STATUS_FILE, { bigint: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { status: null, identity: null };
    throw error;
  }
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1n
    || before.uid !== BigInt(expectedOwnerUid())
    || before.gid !== BigInt(expectedOwnerGid())
    || (before.mode & 0o777n) !== 0o600n
    || before.size <= 0n
    || before.size > BigInt(MAX_STATUS_BYTES)) {
    throw new BackupRequestPublicError(
      'BACKUP_STATUS_RECOVERY_REQUIRED',
      'Persistent backup status is unsafe and requires administrator recovery',
    );
  }
  const raw = fs.readFileSync(BACKUP_STATUS_FILE, 'utf8');
  const after = fs.lstatSync(BACKUP_STATUS_FILE, { bigint: true });
  const status = parseBackupStatus(raw);
  if (!status
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mtimeNs !== before.mtimeNs) {
    throw new BackupRequestPublicError(
      'BACKUP_STATUS_RECOVERY_REQUIRED',
      'Persistent backup status changed or is malformed and requires administrator recovery',
    );
  }
  return {
    status,
    identity: {
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
    },
  };
}

function readPersistedBackupStatus(): BackupStatus | null {
  return readPersistedBackupStatusSnapshot().status;
}

function statusSnapshotIsCurrent(snapshot: BackupStatusSnapshot): boolean {
  try {
    const current = fs.lstatSync(BACKUP_STATUS_FILE, { bigint: true });
    return snapshot.identity !== null
      && current.isFile()
      && !current.isSymbolicLink()
      && current.nlink === 1n
      && current.dev === snapshot.identity.dev
      && current.ino === snapshot.identity.ino
      && current.size === snapshot.identity.size
      && current.mtimeNs === snapshot.identity.mtimeNs;
  } catch (error: any) {
    return error?.code === 'ENOENT' && snapshot.identity === null;
  }
}

function writeBackupStatusCas(
  snapshot: BackupStatusSnapshot,
  status: BackupStatus,
  lease: BackupMutationLockLease,
): BackupStatusSnapshot {
  assertBackupMutationLockLease(lease);
  if (!statusSnapshotIsCurrent(snapshot)) {
    throw new BackupRequestPublicError(
      'BACKUP_STATUS_RECOVERY_REQUIRED',
      'Persistent backup status changed during exact reconciliation',
    );
  }
  writeBackupStatus(status);
  assertBackupMutationLockLease(lease);
  return readPersistedBackupStatusSnapshot();
}

export interface QueuedBackupFailure {
  failureCode: string;
  failureDetail: string;
}

export function queuedBackupFailureFromSystemdProperties(
  properties: Record<string, string>,
): QueuedBackupFailure {
  const loadState = properties.LoadState || 'unknown';
  const activeState = properties.ActiveState || 'unknown';
  const rawResult = properties.Result || 'unknown';
  const result = /^(?:success|exit-code|signal|core-dump|timeout|watchdog|start-limit-hit|resources|protocol)$/
    .test(rawResult) ? rawResult : 'unknown';
  const status = /^\d{1,5}$/.test(properties.ExecMainStatus || '')
    ? properties.ExecMainStatus
    : 'unknown';
  if (loadState !== 'loaded') {
    return {
      failureCode: 'BACKUP_SERVICE_UNAVAILABLE',
      failureDetail: 'The installed backup service unit is unavailable',
    };
  }
  if (activeState === 'failed' || !['unknown', 'success'].includes(result)) {
    return {
      failureCode: 'BACKUP_SERVICE_EXITED_BEFORE_CLAIM',
      failureDetail: `The backup service exited before claiming its request (result=${result}, status=${status})`,
    };
  }
  if (['active', 'activating', 'reloading'].includes(activeState)) {
    return {
      failureCode: 'BACKUP_REQUEST_CLAIM_DELAYED',
      failureDetail: 'The backup service is active but has not yet claimed its durable request',
    };
  }
  return {
    failureCode: 'BACKUP_SERVICE_STOPPED_BEFORE_CLAIM',
    failureDetail: 'The backup service stopped before claiming its durable request',
  };
}

function inspectQueuedBackupFailure(type: BackupType): QueuedBackupFailure {
  try {
    const raw = execFileSync('/usr/bin/systemctl', [
      'show', `bridgesllm-backup@${type}.service`, '--no-pager',
      '--property=LoadState', '--property=ActiveState', '--property=SubState',
      '--property=Result', '--property=ExecMainCode', '--property=ExecMainStatus',
    ], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return queuedBackupFailureFromSystemdProperties(parseSystemctlProperties(raw));
  } catch {
    return {
      failureCode: 'BACKUP_SERVICE_STATE_UNAVAILABLE',
      failureDetail: 'The backup service did not claim its request and its unit state could not be inspected',
    };
  }
}

export function readBackupStatus(): BackupStatus | null {
  const status = readPersistedBackupStatus();
  if (!status) return null;

  const queuedTooLong = status.status === 'queued'
    && Date.now() - Date.parse(status.startedAt) > 2 * 60 * 1000;
  if (queuedTooLong) {
    const advisory = inspectQueuedBackupFailure(status.type);
    // A type-scoped unit state has no request or invocation provenance. It may
    // explain why a request is delayed, but can never turn the exact durable
    // request authority into a terminal result.
    return {
      ...status,
      failureCode: advisory.failureCode,
      failureDetail: advisory.failureDetail,
      output: readOutputTail(),
    };
  }
  if (status.status === 'running' && !isBackupProcess(status)) {
    const failure = {
      failureCode: 'BACKUP_PROCESS_EXITED',
      failureDetail: 'The backup process stopped before recording completion',
    };
    const observed: BackupStatus = {
      ...status,
      status: 'failed',
      completedAt: new Date(Date.parse(status.startedAt) + 2 * 60 * 1000).toISOString(),
      error: failure.failureDetail,
      failureCode: failure.failureCode,
      failureDetail: failure.failureDetail,
    };
    // Status reads are deliberately non-mutating. Only the lock-owning shell
    // or the exact start call may retire request authority and publish a
    // terminal receipt; a delayed unit can still claim this request safely.
    return { ...observed, output: readOutputTail() };
  }
  return { ...status, output: readOutputTail() };
}

interface PreparedBackupDispatch {
  authority: AttestedBackupRequestReceipt;
  status: BackupStatus;
}

function backupBusy(message: string): never {
  const error = new BackupRequestPublicError('EBUSY', message);
  throw error;
}

function receiptOwnsStatus(
  receipt: AttestedBackupRequestReceipt,
  status: BackupStatus | null,
): status is BackupStatus {
  return status?.id === receipt.receipt.id
    && status.type === receipt.receipt.type
    && status.startedAt === receipt.receipt.requestedAt;
}

function failedBackupStatus(
  status: BackupStatus,
  failure: QueuedBackupFailure,
): BackupStatus {
  return {
    ...status,
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: failure.failureDetail,
    failureCode: failure.failureCode,
    failureDetail: failure.failureDetail,
  };
}

function reconcileStatusWithoutReceipt(
  snapshot: BackupStatusSnapshot,
  lease: BackupMutationLockLease,
): BackupStatusSnapshot {
  const status = snapshot.status;
  if (!status || ['completed', 'degraded', 'failed'].includes(status.status)) return snapshot;
  if (status.status === 'running') {
    if (isBackupProcess(status)) backupBusy('A backup is already in progress');
    const failure: QueuedBackupFailure = {
      failureCode: 'BACKUP_PROCESS_EXITED',
      failureDetail: 'The backup process stopped before recording completion',
    };
    return writeBackupStatusCas(snapshot, failedBackupStatus(status, failure), lease);
  }

  const age = Date.now() - Date.parse(status.startedAt);
  if (age <= 2 * 60 * 1000) {
    backupBusy('A backup request is still awaiting its exact service claim');
  }
  const failure = inspectQueuedBackupFailure(status.type);
  if ([
    'BACKUP_REQUEST_CLAIM_DELAYED',
    'BACKUP_SERVICE_STATE_UNAVAILABLE',
  ].includes(failure.failureCode)) {
    backupBusy('A backup request remains active or its service state is indeterminate');
  }
  if (BACKUP_TIMER_ID_PATTERN.test(status.id)) {
    const timerMatch = BACKUP_TIMER_ID_PATTERN.exec(status.id);
    if (timerMatch?.[1] !== status.type) {
      throw new BackupRequestPublicError(
        'BACKUP_REQUEST_RECOVERY_REQUIRED',
        'A stale timer backup status has inconsistent ownership and requires administrator recovery',
      );
    }
    return writeBackupStatusCas(snapshot, failedBackupStatus(status, {
      failureCode: 'BACKUP_TIMER_REQUEST_STALE',
      failureDetail: 'A prior timer-owned backup request stopped before establishing process ownership',
    }), lease);
  }
  if (BACKUP_REQUEST_ID_PATTERN.test(status.id)) {
    throw new BackupRequestPublicError(
      'BACKUP_REQUEST_RECOVERY_REQUIRED',
      'A queued backup status has lost its exact request receipt and requires administrator recovery',
    );
  }
  throw new BackupRequestPublicError(
    'BACKUP_STATUS_RECOVERY_REQUIRED',
    'Persistent queued backup status has unknown ownership and requires administrator recovery',
  );
}

function prepareBackupDispatch(
  type: BackupType,
  lease: BackupMutationLockLease,
): PreparedBackupDispatch {
  let receipts = enumerateBackupRequestReceipts(lease);
  let authority: AttestedBackupRequestReceipt | null = receipts.length === 1
    ? receipts[0]
    : null;
  let snapshot = readPersistedBackupStatusSnapshot();

  if (authority?.state === 'claimed') {
    if (!receiptOwnsStatus(authority, snapshot.status)) {
      throw new BackupRequestPublicError(
        'BACKUP_REQUEST_RECOVERY_REQUIRED',
        'A claimed backup request has no exact persistent status owner',
      );
    }
    if (['completed', 'degraded', 'failed'].includes(snapshot.status.status)) {
      if (!removeAttestedBackupRequestReceipt(authority, lease)) {
        throw new BackupRequestPublicError(
          'BACKUP_REQUEST_RECOVERY_REQUIRED',
          'A terminal backup request claim disappeared before exact retirement',
        );
      }
    } else if (snapshot.status.status === 'running' && isBackupProcess(snapshot.status)) {
      backupBusy('A backup is already in progress');
    } else {
      // A claimed receipt plus its exact id/type/startedAt status is request-
      // scoped authority. Reaching this branch while holding both canonical
      // mutation locks proves the prior shell no longer owns those locks; the
      // live-process check above is an additional fail-closed fence. Recover
      // that exact claim before admitting the user's manual retry. Never use
      // type-scoped systemd history for this terminal decision.
      const failure: QueuedBackupFailure = {
        failureCode: 'BACKUP_PROCESS_EXITED',
        failureDetail: 'The backup process stopped before recording completion',
      };
      snapshot = writeBackupStatusCas(snapshot, failedBackupStatus(snapshot.status, failure), lease);
      if (!removeAttestedBackupRequestReceipt(authority, lease)) {
        throw new BackupRequestPublicError(
          'BACKUP_REQUEST_RECOVERY_REQUIRED',
          'A recovered backup request claim disappeared before exact retirement',
        );
      }
    }
    authority = null;
    receipts = [];
    snapshot = readPersistedBackupStatusSnapshot();
  }

  if (authority?.state === 'pending') {
    if (receiptOwnsStatus(authority, snapshot.status)) {
      if (snapshot.status.status === 'failed'
        && snapshot.status.failureCode === 'BACKUP_SERVICE_START_FAILED') {
        if (!removeAttestedBackupRequestReceipt(authority, lease)) {
          throw new BackupRequestPublicError(
            'BACKUP_REQUEST_RECOVERY_REQUIRED',
            'A terminal backup request receipt disappeared before exact retirement',
          );
        }
        authority = null;
        receipts = [];
        snapshot = readPersistedBackupStatusSnapshot();
      } else if (['completed', 'degraded', 'failed'].includes(snapshot.status.status)) {
        throw new BackupRequestPublicError(
          'BACKUP_REQUEST_RECOVERY_REQUIRED',
          'A terminal status still has pending request authority and requires locked shell recovery',
        );
      } else if (snapshot.status.status === 'running') {
        if (isBackupProcess(snapshot.status)) backupBusy('A backup is already in progress');
        throw new BackupRequestPublicError(
          'BACKUP_REQUEST_RECOVERY_REQUIRED',
          'A running backup status still owns an unclaimed request receipt',
        );
      } else {
        const age = Date.now() - Date.parse(snapshot.status.startedAt);
        if (age <= 2 * 60 * 1000) {
          backupBusy('A backup request is still awaiting its exact service claim');
        }
        const failure = inspectQueuedBackupFailure(snapshot.status.type);
        if ([
          'BACKUP_REQUEST_CLAIM_DELAYED',
          'BACKUP_SERVICE_STATE_UNAVAILABLE',
        ].includes(failure.failureCode)) {
          backupBusy('A backup request remains active or its service state is indeterminate');
        }
        // The unit is definitely not active, but its historical result has no
        // request identity. Re-dispatch the same durable receipt; do not
        // terminalize it or mint a replacement request.
        return { authority, status: snapshot.status };
      }
    } else {
      snapshot = reconcileStatusWithoutReceipt(snapshot, lease);
      const adoptedStatus: BackupStatus = {
        id: authority.receipt.id,
        type: authority.receipt.type,
        status: 'queued',
        startedAt: authority.receipt.requestedAt,
      };
      snapshot = writeBackupStatusCas(snapshot, adoptedStatus, lease);
      return { authority, status: snapshot.status! };
    }
  }

  if (!authority) snapshot = reconcileStatusWithoutReceipt(snapshot, lease);
  if (receipts.length !== 0) {
    throw new BackupRequestPublicError(
      'BACKUP_REQUEST_RECOVERY_REQUIRED',
      'Backup request authority did not converge before dispatch',
    );
  }

  const created = createBackupRequestReceipt(type);
  const createdAuthority: AttestedBackupRequestReceipt = { ...created, state: 'pending' };
  const exactInventory = enumerateBackupRequestReceipts(lease);
  if (exactInventory.length !== 1
    || exactInventory[0].fullPath !== createdAuthority.fullPath
    || exactInventory[0].dev !== createdAuthority.dev
    || exactInventory[0].ino !== createdAuthority.ino) {
    throw new BackupRequestPublicError(
      'BACKUP_REQUEST_RECOVERY_REQUIRED',
      'New backup request authority did not become the sole durable candidate',
    );
  }
  const dispatchedStatus: BackupStatus = {
    id: created.receipt.id,
    type,
    status: 'queued',
    startedAt: created.receipt.requestedAt,
  };
  try {
    snapshot = writeBackupStatusCas(snapshot, dispatchedStatus, lease);
  } catch (cause) {
    try { removeAttestedBackupRequestReceipt(exactInventory[0], lease); } catch {}
    throw new BackupRequestPublicError(
      'BACKUP_STATUS_PUBLISH_FAILED',
      'Backup request status could not be committed before service dispatch',
      cause,
    );
  }
  return { authority: exactInventory[0], status: snapshot.status! };
}

async function terminalizeDefiniteDispatchFailure(
  prepared: PreparedBackupDispatch,
  cause: unknown,
): Promise<never> {
  try {
    await withBackupMutationLock(async (lease) => {
      const receipts = enumerateBackupRequestReceipts(lease);
      const current = readPersistedBackupStatusSnapshot();
      const authority = receipts[0];
      if (!authority
        || authority.state !== 'pending'
        || authority.fullPath !== prepared.authority.fullPath
        || authority.dev !== prepared.authority.dev
        || authority.ino !== prepared.authority.ino
        || !receiptOwnsStatus(authority, current.status)
        || current.status.status !== 'queued') {
        throw new BackupRequestPublicError(
          'BACKUP_SERVICE_DISPATCH_INDETERMINATE',
          'Backup service dispatch changed ownership before rejection could be reconciled',
          cause,
        );
      }
      const failure: QueuedBackupFailure = {
        failureCode: 'BACKUP_SERVICE_START_FAILED',
        failureDetail: 'The installed backup service rejected the backup request before it started',
      };
      writeBackupStatusCas(current, failedBackupStatus(current.status, failure), lease);
      if (!removeAttestedBackupRequestReceipt(authority, lease)) {
        throw new BackupRequestPublicError(
          'BACKUP_SERVICE_DISPATCH_INDETERMINATE',
          'Backup service rejection was recorded but request retirement requires recovery',
          cause,
        );
      }
    });
  } catch (reconcileCause) {
    if (reconcileCause instanceof BackupRequestPublicError
      && reconcileCause.code === 'BACKUP_SERVICE_DISPATCH_INDETERMINATE') {
      throw reconcileCause;
    }
    throw new BackupRequestPublicError(
      'BACKUP_SERVICE_DISPATCH_INDETERMINATE',
      'Backup service dispatch could not be reconciled; its request authority was preserved',
      reconcileCause,
    );
  }
  throw new BackupRequestPublicError(
    'BACKUP_SERVICE_START_FAILED',
    'The installed backup service rejected the backup request before it started',
    cause,
  );
}

export async function startBackupUnit(type: BackupType): Promise<BackupStatus | null> {
  if (!BACKUP_TYPES.includes(type)) throw new Error('Invalid backup type');
  await getConfiguredBackupRoot({ syncFile: true });
  let prepared: PreparedBackupDispatch;
  try {
    // Publish/recover authority under both canonical locks, then release them
    // before systemd starts the unit that must acquire those same locks.
    prepared = await withBackupMutationLock(async (lease) => prepareBackupDispatch(type, lease));
  } catch (error: any) {
    if (error?.code === 'BACKUP_MUTATION_LOCK_CONTENDED') {
      backupBusy('A backup or Portal operation is already in progress');
    }
    throw error;
  }

  const unit = `bridgesllm-backup@${prepared.status.type}.service`;
  try {
    await execFileAsync('/usr/bin/systemctl', ['start', '--no-block', unit], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    });
  } catch (cause: any) {
    const dispatchIsIndeterminate = cause?.killed === true
      || cause?.code === 'ETIMEDOUT'
      || typeof cause?.signal === 'string';
    if (dispatchIsIndeterminate) {
      throw new BackupRequestPublicError(
        'BACKUP_SERVICE_DISPATCH_INDETERMINATE',
        'Backup service dispatch could not be confirmed; its exact request remains queued',
        cause,
      );
    }
    return terminalizeDefiniteDispatchFailure(prepared, cause);
  }

  const requestStatus = prepared.status;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = readPersistedBackupStatus();
    if (status && status.id !== requestStatus.id) return status;
  }
  return readPersistedBackupStatus() || requestStatus;
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
