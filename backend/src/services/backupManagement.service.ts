import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  BACKUP_CONFIG_FILE,
  BACKUP_STATE_DIR,
  expectedBackupOwnerIdentity,
  getConfiguredBackupRoot,
} from './backup.service';

/**
 * Backup retention settings and cleanup are owned by backup-data.py, the same
 * program the systemd timers run. This bridge only forwards owner requests to
 * it; it holds no policy rules of its own, so the UI and scheduled backups can
 * never disagree about what may be deleted.
 */

const PORTAL_ROOT = process.env.PORTAL_ROOT || '/opt/bridgesllm/portal';
const MAX_OUTPUT_BYTES = 1024 * 1024;

const REFUSAL_STATUS: Record<string, number> = {
  POLICY_INVALID: 400,
  USAGE: 400,
  BUSY: 409,
  MAINTENANCE: 409,
  STALE: 409,
  CHANGED: 409,
  PARTIAL: 409,
  PINS_UNAVAILABLE: 503,
};

export class BackupManagementError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackupManagementError';
  }
}

export interface BackupDataCommandOptions {
  python?: string;
  script?: string;
  timeoutMs?: number;
  input?: string;
}

function assertTrustedScript(script: string): void {
  const expected = expectedBackupOwnerIdentity();
  const stat = fs.lstatSync(script);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expected.uid || (stat.mode & 0o022) !== 0) {
    throw new BackupManagementError(500, 'BACKUP_MANAGEMENT_UNAVAILABLE', 'The installed backup program is unavailable');
  }
  for (let directory = path.dirname(script); ; directory = path.dirname(directory)) {
    const parent = fs.lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== expected.uid || (parent.mode & 0o022) !== 0) {
      throw new BackupManagementError(500, 'BACKUP_MANAGEMENT_UNAVAILABLE', 'The installed backup program is unavailable');
    }
    if (directory === path.dirname(directory)) break;
  }
}

export function runBackupDataCommand(args: string[], options: BackupDataCommandOptions = {}): Promise<any> {
  const script = options.script || path.join(PORTAL_ROOT, 'backup-data.py');
  try {
    assertTrustedScript(script);
  } catch (error) {
    return Promise.reject(error instanceof BackupManagementError ? error
      : new BackupManagementError(500, 'BACKUP_MANAGEMENT_UNAVAILABLE', 'The installed backup program is unavailable'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(options.python || '/usr/bin/python3', [script, ...args], {
      cwd: '/',
      env: {
        PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: 'C.UTF-8',
        PORTAL_ROOT,
        BACKUP_STATE_DIR,
        BACKUP_CONFIG_FILE,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new BackupManagementError(500, 'BACKUP_MANAGEMENT_FAILED', 'Backup management returned too much output'));
        return;
      }
      target.push(chunk);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new BackupManagementError(504, 'BACKUP_MANAGEMENT_TIMEOUT', 'Backup management did not finish in time'));
    }, options.timeoutMs ?? 120_000);
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', () => finish(new BackupManagementError(500, 'BACKUP_MANAGEMENT_UNAVAILABLE',
      'The installed backup program could not start')));
    child.on('close', (code) => {
      const text = Buffer.concat(stdout).toString('utf8');
      if (code === 0 || code === 3) {
        let parsed: any;
        try { parsed = JSON.parse(text); } catch {
          finish(new BackupManagementError(500, 'BACKUP_MANAGEMENT_FAILED', 'Backup management returned an unreadable result'));
          return;
        }
        if (code === 0) {
          finish(null, parsed);
          return;
        }
        const refusalCode = typeof parsed?.code === 'string' && /^[A-Z_]{1,40}$/.test(parsed.code) ? parsed.code : 'REFUSED';
        const message = typeof parsed?.error === 'string' ? parsed.error.slice(0, 1000) : 'Backup management refused the request';
        finish(new BackupManagementError(REFUSAL_STATUS[refusalCode] || 409, refusalCode, message));
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8')
        .replace(/^Portal data backup: /, '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 300);
      finish(new BackupManagementError(500, 'BACKUP_MANAGEMENT_FAILED', detail || 'Backup management failed'));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
}

export function readBackupPolicy(): Promise<any> {
  return runBackupDataCommand(['policy', 'show'], { timeoutMs: 30_000 });
}

/** Saves settings only. backup-data.py validates them; nothing is deleted or run. */
export function saveBackupPolicy(input: unknown): Promise<any> {
  return runBackupDataCommand(['policy', 'set'], { timeoutMs: 30_000, input: JSON.stringify(input ?? null) });
}

export async function previewBackupCleanup(): Promise<any> {
  await getConfiguredBackupRoot({ syncFile: true });
  return runBackupDataCommand(['cleanup', 'preview'], { timeoutMs: 120_000 });
}

export async function runBackupCleanup(planToken: string): Promise<any> {
  if (!/^[0-9a-f]{64}$/.test(planToken)) {
    throw new BackupManagementError(400, 'STALE', 'Review the cleanup before deleting backups.');
  }
  await getConfiguredBackupRoot({ syncFile: true });
  return runBackupDataCommand(['cleanup', 'run', `--plan=${planToken}`], { timeoutMs: 600_000 });
}
