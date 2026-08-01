import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const DEFAULT_LOCK_PATH = '/run/bridgesllm-remote-desktop.lock';
const MALFORMED_LOCK_STALE_MS = 30_000;
type LockRecord = {
  schema: 1;
  token: string;
  pid: number;
  operation: string;
  acquiredAt: string;
  processStartTicks: string;
};

export class RemoteDesktopMutationBusyError extends Error {
  constructor(public readonly operation: string | null) {
    super(operation
      ? `Remote Desktop operation already in progress: ${operation}`
      : 'Another Remote Desktop operation is already in progress');
    this.name = 'RemoteDesktopMutationBusyError';
  }
}

export type RemoteDesktopMutationLease = {
  path: string;
  release: () => void;
};

function readRecord(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<LockRecord>;
    if (parsed.schema !== 1 || typeof parsed.token !== 'string' || !Number.isSafeInteger(parsed.pid)
      || typeof parsed.operation !== 'string' || typeof parsed.acquiredAt !== 'string'
      || typeof parsed.processStartTicks !== 'string' || !/^\d+$/.test(parsed.processStartTicks)) return null;
    return parsed as LockRecord;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function processStartTicks(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closingParen = stat.lastIndexOf(')');
    if (closingParen < 0) return null;
    const fieldsAfterComm = stat.slice(closingParen + 2).trim().split(/\s+/);
    const startTicks = fieldsAfterComm[19]; // proc(5) field 22; this array begins at field 3.
    return /^\d+$/.test(startTicks || '') ? startTicks : null;
  } catch {
    return null;
  }
}

function malformedLockIsStale(lockPath: string, now = Date.now()): boolean {
  try {
    const stat = fs.lstatSync(lockPath);
    return stat.isFile() && now - stat.mtimeMs >= MALFORMED_LOCK_STALE_MS;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
}

function lockIsStale(record: LockRecord | null, lockPath: string): boolean {
  // An owner writes the small record immediately after an exclusive create. A concurrent
  // request can observe the inode during that write, so fresh malformed state must be busy.
  if (!record) return malformedLockIsStale(lockPath);
  const acquiredAt = Date.parse(record.acquiredAt);
  if (!Number.isFinite(acquiredAt)) return true;
  const currentStartTicks = processStartTicks(record.pid);
  if (currentStartTicks) return currentStartTicks !== record.processStartTicks;
  return !processIsAlive(record.pid);
}

export function acquireRemoteDesktopMutationLock(
  operation: string,
  options: { lockPath?: string } = {},
): RemoteDesktopMutationLease {
  const lockPath = options.lockPath || process.env.REMOTE_DESKTOP_MUTATION_LOCK || DEFAULT_LOCK_PATH;
  const ownProcessStartTicks = processStartTicks(process.pid);
  if (!ownProcessStartTicks) throw new Error('Could not attest the Portal process identity for the Remote Desktop mutation lock');
  const record: LockRecord = {
    schema: 1,
    token: randomUUID(),
    pid: process.pid,
    operation,
    acquiredAt: new Date().toISOString(),
    processStartTicks: ownProcessStartTicks,
  };

  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o755 });
  let retriedStaleLock = false;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readRecord(lockPath);
      if (!retriedStaleLock && lockIsStale(existing, lockPath)) {
        retriedStaleLock = true;
        try { fs.unlinkSync(lockPath); } catch (unlinkError: any) {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        }
        continue;
      }
      throw new RemoteDesktopMutationBusyError(existing?.operation || null);
    }
  }

  let released = false;
  return {
    path: lockPath,
    release: () => {
      if (released) return;
      released = true;
      const current = readRecord(lockPath);
      if (current?.token !== record.token) return;
      try { fs.unlinkSync(lockPath); } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  };
}
