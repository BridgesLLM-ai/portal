import fs from 'fs';
import os from 'os';
import path from 'path';
import { acquireRemoteDesktopMutationLock, RemoteDesktopMutationBusyError } from './remoteDesktopMutationLock';

describe('Remote Desktop mutation admission lock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-rd-lock-'));
    lockPath = path.join(dir, 'remote-desktop.lock');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('serializes setup and recovery and releases only its own lease', () => {
    const setup = acquireRemoteDesktopMutationLock('setup', { lockPath });
    expect(() => acquireRemoteDesktopMutationLock('recovery', { lockPath }))
      .toThrow(RemoteDesktopMutationBusyError);
    setup.release();
    const recovery = acquireRemoteDesktopMutationLock('recovery', { lockPath });
    recovery.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('reclaims malformed stale state exactly once', () => {
    fs.writeFileSync(lockPath, 'not-json\n', { mode: 0o600 });
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, stale, stale);
    const lease = acquireRemoteDesktopMutationLock('setup', { lockPath });
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).operation).toBe('setup');
    lease.release();
  });

  test('treats fresh malformed state as an in-progress exclusive create', () => {
    fs.writeFileSync(lockPath, 'not-json\n', { mode: 0o600 });
    expect(() => acquireRemoteDesktopMutationLock('recovery', { lockPath }))
      .toThrow(RemoteDesktopMutationBusyError);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('not-json\n');
  });

  test('does not remove a replacement lease during stale release', () => {
    const first = acquireRemoteDesktopMutationLock('setup', { lockPath });
    fs.unlinkSync(lockPath);
    const replacement = acquireRemoteDesktopMutationLock('recovery', { lockPath });
    first.release();
    expect(fs.existsSync(lockPath)).toBe(true);
    replacement.release();
  });

  test('never steals a long-running lease while the same process identity is alive', () => {
    const first = acquireRemoteDesktopMutationLock('slow package install', { lockPath });
    const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    fs.writeFileSync(lockPath, `${JSON.stringify({ ...record, acquiredAt: '2000-01-01T00:00:00.000Z' })}\n`);
    expect(() => acquireRemoteDesktopMutationLock('recovery', { lockPath }))
      .toThrow(RemoteDesktopMutationBusyError);
    first.release();
  });
});
