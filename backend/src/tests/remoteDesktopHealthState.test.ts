import fs from 'fs';
import os from 'os';
import path from 'path';
import { readRemoteDesktopHealthState } from '../routes/remote-desktop';

describe('Remote Desktop automatic health state reader', () => {
  let tempRoot: string;
  const nowMs = Date.UTC(2026, 6, 20, 22, 30, 0);
  const nowSeconds = Math.floor(nowMs / 1000);
  const ownerUid = typeof process.getuid === 'function' ? process.getuid() : 0;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridges-rd-health-state-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeState(value: unknown, mode = 0o644): string {
    const target = path.join(tempRoot, 'health-state.json');
    fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { mode });
    fs.chmodSync(target, mode);
    return target;
  }

  test('returns only a bounded, sanitized, fresh recovery record', () => {
    const target = writeState({
      schema: 1,
      status: 'recovered',
      note: 'Restarted\u0000 and\n verified',
      checkedAt: nowSeconds - 5,
      lastRecoveryAt: nowSeconds - 5,
      suppressedUntil: null,
      ignoredSecret: 'must-not-escape',
    });

    expect(readRemoteDesktopHealthState(target, nowMs, ownerUid)).toEqual({
      status: 'recovered',
      note: 'Restarted and verified',
      checkedAt: new Date((nowSeconds - 5) * 1000).toISOString(),
      lastRecoveryAt: new Date((nowSeconds - 5) * 1000).toISOString(),
      suppressedUntil: null,
      fresh: true,
      suppressed: false,
    });
  });

  test('surfaces rate suppression and stale checks without treating them as ready', () => {
    const suppressed = writeState({
      schema: 1,
      status: 'suppressed',
      note: 'Automatic recovery paused.',
      checkedAt: nowSeconds - 300,
      lastRecoveryAt: null,
      suppressedUntil: nowSeconds + 900,
    });

    expect(readRemoteDesktopHealthState(suppressed, nowMs, ownerUid)).toMatchObject({
      status: 'suppressed',
      fresh: false,
      suppressed: true,
      suppressedUntil: new Date((nowSeconds + 900) * 1000).toISOString(),
    });

    const recovering = writeState({
      schema: 1,
      status: 'recovering',
      note: 'Restarting managed services.',
      checkedAt: nowSeconds,
      lastRecoveryAt: null,
      suppressedUntil: null,
    });
    expect(readRemoteDesktopHealthState(recovering, nowMs, ownerUid)).toMatchObject({
      status: 'recovering',
      fresh: true,
      suppressed: false,
    });

    const busy = writeState({
      schema: 1,
      status: 'busy',
      note: 'Another Remote Desktop mutation owns the shared lease.',
      checkedAt: nowSeconds,
      lastRecoveryAt: null,
      suppressedUntil: null,
    });
    expect(readRemoteDesktopHealthState(busy, nowMs, ownerUid)).toMatchObject({
      status: 'busy',
      fresh: true,
      suppressed: false,
    });
  });

  test('rejects linked, writable, oversized, and malformed state files', () => {
    const valid = writeState({
      schema: 1,
      status: 'healthy',
      note: 'Healthy.',
      checkedAt: nowSeconds,
      lastRecoveryAt: null,
      suppressedUntil: null,
    });
    const linked = path.join(tempRoot, 'linked.json');
    fs.symlinkSync(valid, linked);
    expect(readRemoteDesktopHealthState(linked, nowMs, ownerUid)).toBeNull();

    fs.chmodSync(valid, 0o666);
    expect(readRemoteDesktopHealthState(valid, nowMs, ownerUid)).toBeNull();

    const oversized = path.join(tempRoot, 'oversized.json');
    fs.writeFileSync(oversized, 'x'.repeat(4097), { mode: 0o644 });
    expect(readRemoteDesktopHealthState(oversized, nowMs, ownerUid)).toBeNull();

    const malformed = path.join(tempRoot, 'malformed.json');
    fs.writeFileSync(malformed, '{nope}\n', { mode: 0o644 });
    expect(readRemoteDesktopHealthState(malformed, nowMs, ownerUid)).toBeNull();
  });
});
