import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  createPortalSelfUpdateLog,
  getPortalSelfUpdateLog,
  getPortalSelfUpdateProgress,
  parsePortalSelfUpdateUnitActivity,
  parsePortalSelfUpdateUnitIdentity,
  parseStoredPortalSelfUpdateProgress,
} from '../services/portalSelfUpdateProgress';

const OP = '0123456789abcdef0123456789abcdef';
const STARTED = '2026-08-10T06:00:00Z';

describe('atomic Portal self-update progress', () => {
  let fixture: string;
  let stateRoot: string;
  let logRoot: string;
  let logFile: string;

  const state = (overrides: Record<string, unknown> = {}) => ({
    schema: 1,
    operationId: OP,
    previousVersion: '4.0.13',
    expectedVersion: '4.0.14',
    status: 'running',
    phase: 'signed-release',
    percent: 30,
    label: 'Signed release verified',
    detail: 'Manifest signature and digest passed.',
    startedAt: STARTED,
    updatedAt: '2026-08-10T06:00:05Z',
    finishedAt: null,
    events: [{
      status: 'running',
      phase: 'signed-release',
      percent: 30,
      label: 'Signed release verified',
      detail: 'Manifest signature and digest passed.',
      at: '2026-08-10T06:00:05Z',
    }],
    logAvailable: true,
    logFile,
    pendingOutcome: null,
    ...overrides,
  });

  const writeState = (value = state()) => {
    fs.writeFileSync(path.join(stateRoot, `${OP}.json`), `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(stateRoot, 'current'), `${OP}\n`, { mode: 0o600 });
  };

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-progress-'));
    stateRoot = path.join(fixture, 'state');
    logRoot = path.join(fixture, 'logs');
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    fs.mkdirSync(logRoot, { mode: 0o700 });
    logFile = path.join(logRoot, 'self-update-2026-08-10T06-00-00-000Z.log');
    fs.writeFileSync(logFile, '', { mode: 0o600 });
    writeState();
  });

  afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

  test('reads a current or explicitly pinned operation', async () => {
    await expect(getPortalSelfUpdateProgress(undefined, {
      stateRoot,
      logRoot,
      readUnitActivity: async () => 'active',
      resolveCurrentOperation: async () => OP,
    })).resolves.toMatchObject({ operationId: OP, previousVersion: '4.0.13', percent: 30 });
    await expect(getPortalSelfUpdateProgress(OP, {
      stateRoot, logRoot, readUnitActivity: async () => 'active',
    })).resolves.toMatchObject({ phase: 'signed-release' });
  });

  test('treats a secure empty first-run store as idle without requiring a stable helper', async () => {
    fs.unlinkSync(path.join(stateRoot, `${OP}.json`));
    fs.unlinkSync(path.join(stateRoot, 'current'));
    const resolveCurrentOperation = jest.fn(async () => {
      throw new Error('stable helper is absent');
    });
    await expect(getPortalSelfUpdateProgress(undefined, {
      stateRoot,
      logRoot,
      resolveCurrentOperation,
    })).resolves.toMatchObject({ status: 'idle', operationId: null });
    expect(resolveCurrentOperation).not.toHaveBeenCalled();
  });

  test('uses the locked current resolver to repair a missing pointer on cold attachment', async () => {
    fs.unlinkSync(path.join(stateRoot, 'current'));
    const resolveCurrentOperation = jest.fn(async () => {
      fs.writeFileSync(path.join(stateRoot, 'current'), `${OP}\n`, { mode: 0o600 });
      return OP;
    });
    await expect(getPortalSelfUpdateProgress(undefined, {
      stateRoot,
      logRoot,
      resolveCurrentOperation,
      readUnitActivity: async () => 'active',
    })).resolves.toMatchObject({ operationId: OP, status: 'running', isCurrent: true });
    expect(resolveCurrentOperation).toHaveBeenCalledTimes(1);
  });

  test('returns only an atomically recorded terminal success', async () => {
    writeState(state({
      status: 'succeeded', phase: 'complete', percent: 100,
      label: 'Update complete', detail: 'Exact target health passed.',
      updatedAt: '2026-08-10T06:10:00Z', finishedAt: '2026-08-10T06:10:00Z',
    }));
    await expect(getPortalSelfUpdateProgress(OP, {
      stateRoot, logRoot, hasTransactionJournal: () => false,
    }))
      .resolves.toMatchObject({ status: 'succeeded', percent: 100 });
  });

  test('never trusts a terminal receipt while a recovery journal survives', async () => {
    writeState(state({
      status: 'failed', phase: 'failure', percent: 70,
      label: 'Update stopped', detail: 'The wrapper exited nonzero.',
      updatedAt: '2026-08-10T06:10:00Z', finishedAt: '2026-08-10T06:10:00Z',
    }));
    await expect(getPortalSelfUpdateProgress(OP, {
      stateRoot,
      logRoot,
      hasTransactionJournal: () => true,
      now: () => new Date('2026-08-10T06:10:01Z'),
    })).resolves.toMatchObject({
      status: 'recovery_required',
      phase: 'recovery-required',
    });
  });

  test('does not project the current update journal onto a historical terminal receipt', async () => {
    writeState(state({
      status: 'succeeded', phase: 'complete', percent: 100,
      label: 'Update complete', detail: 'Exact target health passed.',
      updatedAt: '2026-08-10T06:10:00Z', finishedAt: '2026-08-10T06:10:00Z',
    }));
    fs.writeFileSync(
      path.join(stateRoot, 'current'),
      'fedcba9876543210fedcba9876543210\n',
      { mode: 0o600 },
    );
    await expect(getPortalSelfUpdateProgress(OP, {
      stateRoot,
      logRoot,
      hasTransactionJournal: () => true,
      now: () => new Date('2026-08-10T06:10:01Z'),
    })).resolves.toMatchObject({
      status: 'succeeded', percent: 100, isCurrent: false, admissionBlocked: false,
    });
  });

  test('marks a resolved attention receipt as historical and no longer admission-blocking', async () => {
    writeState(state({
      status: 'updated_with_errors', phase: 'updated-with-errors', percent: 99,
      label: 'Portal updated with follow-up errors', detail: 'Host repair is required.',
      updatedAt: '2026-08-10T06:10:00Z', finishedAt: '2026-08-10T06:10:00Z',
      pendingOutcome: 'updated_with_errors',
    }));
    fs.unlinkSync(path.join(stateRoot, 'current'));
    await expect(getPortalSelfUpdateProgress(OP, {
      stateRoot,
      logRoot,
      hasTransactionJournal: () => false,
    })).resolves.toMatchObject({
      status: 'updated_with_errors', isCurrent: false, admissionBlocked: false,
    });
  });

  test('does not invent a failure while a newly accepted unit is starting', async () => {
    writeState(state({
      status: 'starting',
      phase: 'admitted',
      percent: 2,
      label: 'Update accepted',
      detail: 'The server owns this update operation.',
      updatedAt: STARTED,
      events: [{
        status: 'running',
        phase: 'admitted',
        percent: 2,
        label: 'Update accepted',
        detail: 'The server owns this update operation.',
        at: STARTED,
      }],
    }));
    await expect(getPortalSelfUpdateProgress(OP, {
      stateRoot, logRoot,
      readUnitActivity: async () => 'inactive',
      now: () => new Date('2026-08-10T06:00:10Z'),
    })).resolves.toMatchObject({ status: 'starting', finishedAt: null });
  });

  test('durably reconciles a dead current unit before returning its outcome', async () => {
    const reconcileOrphan = jest.fn(async (operationId: string) => {
      expect(operationId).toBe(OP);
      writeState(state({
        status: 'failed', phase: 'failure', percent: 30,
        label: 'Update stopped before completion',
        detail: 'Portal remains on the previous version.',
        updatedAt: '2026-08-10T06:01:00Z', finishedAt: '2026-08-10T06:01:00Z',
      }));
    });
    await expect(getPortalSelfUpdateProgress(OP, {
      stateRoot,
      logRoot,
      readUnitActivity: async () => 'inactive',
      hasTransactionJournal: () => false,
      reconcileOrphan,
      now: () => new Date('2026-08-10T06:01:00Z'),
    })).resolves.toMatchObject({ status: 'failed', finishedAt: '2026-08-10T06:01:00Z' });
    expect(reconcileOrphan).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(path.join(stateRoot, `${OP}.json`), 'utf8')).status)
      .toBe('failed');
  });

  test('does not turn a backward wall-clock step into an infinite start grace period', async () => {
    const reconcileOrphan = jest.fn(async () => {
      writeState(state({
        status: 'failed', phase: 'failure', percent: 30,
        label: 'Update stopped before completion', detail: 'Portal remains unchanged.',
        updatedAt: '2026-08-10T06:00:05Z', finishedAt: '2026-08-10T06:00:05Z',
      }));
    });
    await expect(getPortalSelfUpdateProgress(OP, {
      stateRoot,
      logRoot,
      readUnitActivity: async () => 'inactive',
      hasTransactionJournal: () => false,
      reconcileOrphan,
      now: () => new Date('2026-08-10T05:59:00Z'),
    })).resolves.toMatchObject({ status: 'failed' });
    expect(reconcileOrphan).toHaveBeenCalledTimes(1);
  });

  test('never reconciles an explicitly requested historical operation', async () => {
    fs.writeFileSync(
      path.join(stateRoot, 'current'),
      'fedcba9876543210fedcba9876543210\n',
      { mode: 0o600 },
    );
    const reconcileOrphan = jest.fn(async () => undefined);
    await expect(getPortalSelfUpdateProgress(OP, {
      stateRoot,
      logRoot,
      readUnitActivity: async () => 'inactive',
      reconcileOrphan,
      resolveCurrentOperation: async () => 'fedcba9876543210fedcba9876543210',
      now: () => new Date('2026-08-10T06:01:00Z'),
    })).resolves.toMatchObject({ status: 'running', finishedAt: null });
    expect(reconcileOrphan).not.toHaveBeenCalled();
  });

  test('accepts a terminal receipt that ExecStopPost records during the unit query', async () => {
    const reconcileOrphan = jest.fn(async () => undefined);
    await expect(getPortalSelfUpdateProgress(OP, {
      stateRoot,
      logRoot,
      hasTransactionJournal: () => false,
      readUnitActivity: async () => {
        writeState(state({
          status: 'succeeded', phase: 'complete', percent: 100,
          label: 'Update complete', detail: 'Authenticated postflight passed.',
          updatedAt: '2026-08-10T06:01:00Z', finishedAt: '2026-08-10T06:01:00Z',
        }));
        return 'inactive';
      },
      reconcileOrphan,
      now: () => new Date('2026-08-10T06:01:01Z'),
    })).resolves.toMatchObject({ status: 'succeeded', percent: 100 });
    expect(reconcileOrphan).not.toHaveBeenCalled();
  });

  test('does not call a loaded inactive unit dead while a start job is queued', () => {
    expect(parsePortalSelfUpdateUnitActivity([
      'LoadState=loaded',
      'ActiveState=inactive',
      'SubState=dead',
      'Job=/org/freedesktop/systemd1/job/42',
    ].join('\n'))).toBe('active');
    expect(parsePortalSelfUpdateUnitActivity([
      'LoadState=loaded',
      'ActiveState=inactive',
      'SubState=dead',
      'Job=',
    ].join('\n'))).toBe('inactive');
    expect(parsePortalSelfUpdateUnitActivity([
      'LoadState=loaded',
      'ActiveState=deactivating',
      'SubState=stop-post',
      'Job=',
    ].join('\n'))).toBe('active');
    expect(parsePortalSelfUpdateUnitActivity([
      'LoadState=not-found',
      'ActiveState=inactive',
      'SubState=dead',
      'Job=',
    ].join('\n'))).toBe('inactive');
    expect(parsePortalSelfUpdateUnitIdentity([
      'LoadState=loaded',
      'ActiveState=active',
      'SubState=running',
      'Job=',
      `Environment=HOME=/root BRIDGESLLM_DASHBOARD_UPDATE_ID=${OP}`,
    ].join('\n'))).toEqual({ activity: 'active', operationId: OP });
  });

  test('rejects malformed, oversized, linked, and wrong-mode state', async () => {
    expect(parseStoredPortalSelfUpdateProgress({ ...state(), percent: 101 }, logRoot)).toBeNull();
    fs.writeFileSync(path.join(stateRoot, `${OP}.json`), 'x'.repeat(70_000), { mode: 0o600 });
    await expect(getPortalSelfUpdateProgress(OP, { stateRoot, logRoot })).rejects.toThrow();
    writeState();
    fs.chmodSync(path.join(stateRoot, `${OP}.json`), 0o644);
    await expect(getPortalSelfUpdateProgress(OP, { stateRoot, logRoot })).rejects.toThrow();
    fs.chmodSync(path.join(stateRoot, `${OP}.json`), 0o600);
    fs.linkSync(path.join(stateRoot, `${OP}.json`), path.join(stateRoot, 'linked.json'));
    await expect(getPortalSelfUpdateProgress(OP, { stateRoot, logRoot })).rejects.toThrow();
  });

  test('binds bounded sanitized log reads to the operation', () => {
    fs.writeFileSync(logFile, 'first\n\u001b[31mred\u001b[0m\nbad\u0000control\n', { mode: 0o600 });
    expect(getPortalSelfUpdateLog(OP, { stateRoot, logRoot })).toEqual({
      operationId: OP,
      content: 'first\nred\nbadcontrol\n',
    });
    fs.unlinkSync(logFile);
    fs.symlinkSync('/etc/passwd', logFile);
    expect(() => getPortalSelfUpdateLog(OP, { stateRoot, logRoot })).toThrow();
  });

  test('creates collision-safe outer logs without following a directory alias', () => {
    const trustedAncestor = path.join(fixture, 'secure');
    const secureLogRoot = path.join(trustedAncestor, 'logs');
    fs.mkdirSync(trustedAncestor, { mode: 0o700 });
    const expectedUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const dependencies = {
      logRoot: secureLogRoot,
      trustedAncestor,
      expectedUid,
      nowMs: Date.parse('2026-08-10T06:00:00.000Z'),
    };
    const first = createPortalSelfUpdateLog('first\n', dependencies);
    const second = createPortalSelfUpdateLog('second\n', dependencies);
    expect(path.basename(first)).toBe('self-update-2026-08-10T06-00-00-000Z.log');
    expect(path.basename(second)).toBe('self-update-2026-08-10T06-00-00-001Z.log');
    expect(fs.readFileSync(first, 'utf8')).toBe('first\n');
    expect(fs.readFileSync(second, 'utf8')).toBe('second\n');
    expect(fs.statSync(first).mode & 0o777).toBe(0o600);

    const realRoot = path.join(trustedAncestor, 'real-logs');
    fs.renameSync(secureLogRoot, realRoot);
    fs.symlinkSync(realRoot, secureLogRoot);
    expect(() => createPortalSelfUpdateLog('unsafe\n', {
      ...dependencies,
      nowMs: dependencies.nowMs + 2,
    })).toThrow();
  });
});
