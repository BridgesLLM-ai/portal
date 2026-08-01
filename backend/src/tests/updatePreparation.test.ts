import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  __resetPortalSelfUpdateLaunchStateForTests,
  UPDATE_BACKUP_MAX_AGE_HOURS,
  admitPortalUpdate,
  admitPortalUpdateRelease,
  assessUpdateBackupReadiness,
  findFreshVerifiedUpdateBackup,
  launchPortalSelfUpdate,
  unavailableUpdatePreparation,
  verifyUpdateBackupArchive,
  type PortalUpdatePreparation,
} from '../services/updatePreparation';

const NOW = Date.parse('2026-07-20T20:00:00.000Z');

function preparation(state: PortalUpdatePreparation['backup']['state']): PortalUpdatePreparation {
  return {
    confirmationPhrase: 'UPDATE PORTAL',
    backup: {
      state,
      maxAgeHours: UPDATE_BACKUP_MAX_AGE_HOURS,
      newestCreatedAt: state === 'missing' ? null : '2026-07-20T19:00:00.000Z',
      ageHours: state === 'missing' || state === 'unavailable' ? null : 1,
      activeStatus: state === 'running' ? 'running' : null,
    },
  };
}

describe('Portal update backup readiness', () => {
  beforeEach(() => {
    __resetPortalSelfUpdateLaunchStateForTests();
  });

  test('reports fresh, stale, missing, and active backup states without exposing paths', () => {
    expect(assessUpdateBackupReadiness([
      { mtimeMs: NOW - 2 * 3_600_000, size: 100 },
    ], null, NOW)).toEqual({
      state: 'fresh',
      maxAgeHours: 24,
      newestCreatedAt: '2026-07-20T18:00:00.000Z',
      ageHours: 2,
      activeStatus: null,
    });

    expect(assessUpdateBackupReadiness([
      { mtimeMs: NOW - 25 * 3_600_000, size: 100 },
    ], null, NOW).state).toBe('stale');
    expect(assessUpdateBackupReadiness([], null, NOW).state).toBe('missing');
    expect(assessUpdateBackupReadiness([], { status: 'queued' }, NOW)).toMatchObject({
      state: 'running',
      activeStatus: 'queued',
    });
  });

  test('does not trust empty archives or timestamps far in the future', () => {
    expect(assessUpdateBackupReadiness([
      { mtimeMs: NOW, size: 0 },
    ], null, NOW).state).toBe('missing');
    expect(assessUpdateBackupReadiness([
      { mtimeMs: NOW + 10 * 60_000, size: 100 },
    ], null, NOW)).toMatchObject({ state: 'unavailable', ageHours: null });
  });

  test('requires exact owner confirmation and a fresh-or-explicit backup decision', () => {
    expect(admitPortalUpdate(preparation('fresh'), {
      confirmation: 'update portal',
      backupDecision: 'use-current',
    })).toMatchObject({ ok: false, code: 'UPDATE_CONFIRMATION_REQUIRED' });

    expect(admitPortalUpdate(preparation('stale'), {
      confirmation: 'UPDATE PORTAL',
      backupDecision: 'use-current',
    })).toMatchObject({ ok: false, code: 'FRESH_BACKUP_REQUIRED' });

    expect(admitPortalUpdate(preparation('stale'), {
      confirmation: 'UPDATE PORTAL',
      backupDecision: 'proceed-without-fresh',
    })).toEqual({ ok: true, backupDecision: 'proceed-without-fresh' });

    expect(admitPortalUpdate(preparation('fresh'), {
      confirmation: 'UPDATE PORTAL',
      backupDecision: 'use-current',
    })).toEqual({ ok: true, backupDecision: 'use-current' });
  });

  test('never permits an update while a backup is still running', () => {
    expect(admitPortalUpdate(preparation('running'), {
      confirmation: 'UPDATE PORTAL',
      backupDecision: 'proceed-without-fresh',
    })).toMatchObject({ ok: false, code: 'BACKUP_IN_PROGRESS' });
  });

  test('binds admission to the exact reviewed signed release', () => {
    const verifiedStatus = {
      current: '4.0.0',
      latest: '4.1.0',
      updateAvailable: true,
      detailsStatus: 'verified' as const,
      details: {
        version: '4.1.0',
        provenance: 'signed-release-manifest',
      },
    };

    expect(admitPortalUpdateRelease(verifiedStatus, { expectedVersion: '4.1.0' }))
      .toEqual({ ok: true, expectedVersion: '4.1.0' });
    expect(admitPortalUpdateRelease(verifiedStatus, { expectedVersion: '4.1.1' }))
      .toMatchObject({ ok: false, code: 'UPDATE_RELEASE_CHANGED' });
    expect(admitPortalUpdateRelease(verifiedStatus, { expectedVersion: '../4.1.0' }))
      .toMatchObject({ ok: false, code: 'UPDATE_EXPECTED_VERSION_REQUIRED' });
    expect(admitPortalUpdateRelease({
      ...verifiedStatus,
      detailsStatus: 'unavailable',
      details: null,
    }, { expectedVersion: '4.1.0' }))
      .toMatchObject({ ok: false, code: 'UPDATE_RELEASE_UNVERIFIED' });
  });

  test('uses the recovery archive verifier and rejects an archive changed during verification', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-update-backup-'));
    const fullPath = path.join(directory, 'portal-daily-test.tar.gz');
    fs.writeFileSync(fullPath, 'verified backup bytes');
    const initial = fs.lstatSync(fullPath);
    const candidate = {
      filename: path.basename(fullPath),
      fullPath,
      mtimeMs: initial.mtimeMs,
      size: initial.size,
      dev: initial.dev,
      ino: initial.ino,
    };

    try {
      const execFileImpl = jest.fn().mockResolvedValue(undefined);
      await expect(verifyUpdateBackupArchive(candidate, {
        execFileImpl,
        backupScriptPath: '/opt/bridgesllm/portal/backup-full.sh',
      })).resolves.toBe(true);
      expect(execFileImpl).toHaveBeenCalledWith('/bin/bash', [
        '/opt/bridgesllm/portal/backup-full.sh',
        '--verify-archive',
        fullPath,
      ], expect.objectContaining({ timeout: 120_000, maxBuffer: 64 * 1024 }));

      const mutatingVerifier = jest.fn().mockImplementation(async () => {
        fs.appendFileSync(fullPath, 'tampered');
      });
      await expect(verifyUpdateBackupArchive(candidate, {
        execFileImpl: mutatingVerifier,
        backupScriptPath: '/opt/bridgesllm/portal/backup-full.sh',
      })).resolves.toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('verifies only the newest eligible archive within one bounded request', async () => {
    const newest = {
      filename: 'portal-daily-new.tar.gz',
      fullPath: '/backups/daily/portal-daily-new.tar.gz',
      mtimeMs: NOW - 60_000,
      size: 200,
      dev: 1,
      ino: 2,
    };
    const older = {
      filename: 'portal-daily-old.tar.gz',
      fullPath: '/backups/daily/portal-daily-old.tar.gz',
      mtimeMs: NOW - 2 * 3_600_000,
      size: 100,
      dev: 1,
      ino: 1,
    };
    const verifyArchive = jest.fn(async (_candidate: typeof newest) => false);

    await expect(findFreshVerifiedUpdateBackup([older, newest], NOW, verifyArchive))
      .resolves.toBeNull();
    expect(verifyArchive.mock.calls.map(([candidate]) => candidate.filename))
      .toEqual([newest.filename]);
  });

  test('returns a bounded unavailable fallback when readiness cannot be read', () => {
    expect(unavailableUpdatePreparation()).toEqual({
      confirmationPhrase: 'UPDATE PORTAL',
      backup: {
        state: 'unavailable',
        maxAgeHours: 24,
        newestCreatedAt: null,
        ageHours: null,
        activeStatus: null,
      },
    });
  });

  test('registers the genuine updater as one fixed transient service with argument-safe values', async () => {
    const execFileImpl = jest.fn().mockResolvedValue(undefined);
    await launchPortalSelfUpdate({
      originMode: 'domain',
      domain: 'portal.example.com',
      logFile: '/opt/bridgesllm/logs/self-update-test.log',
      expectedVersion: '4.1.0',
    }, { execFileImpl });

    expect(execFileImpl).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileImpl.mock.calls[0];
    expect(file).toBe('/usr/bin/systemd-run');
    expect(args).toEqual(expect.arrayContaining([
      '--unit=bridgesllm-portal-self-update',
      '--collect',
      '--no-block',
      '/bin/bash',
      'portal.example.com',
      '/opt/bridgesllm/logs/self-update-test.log',
      '4.1.0',
      'domain',
    ]));
    const script = args[args.indexOf('-c') + 1];
    expect(script).toContain('https://bridgesllm.ai/releases/$3/install.sh');
    expect(script).toContain('--domain "$1"');
    expect(script).toContain('>> "$2" 2>&1');
    expect(script).not.toContain('portal.example.com');
    expect(script).not.toContain('/opt/bridgesllm/logs/self-update-test.log');
    expect(script).not.toContain('4.1.0');
    expect(options).toMatchObject({ timeout: 10_000, maxBuffer: 64 * 1024 });
  });

  test('private-origin updates launch plain --update and never inherit a domain argument', async () => {
    for (const originMode of ['tailnet', 'local'] as const) {
      const execFileImpl = jest.fn().mockResolvedValue(undefined);
      await launchPortalSelfUpdate({
        originMode,
        domain: 'stale.example.com',
        logFile: '/opt/bridgesllm/logs/self-update-test.log',
        expectedVersion: '4.1.0',
      }, { execFileImpl });

      const [, args] = execFileImpl.mock.calls[0];
      expect(args).toEqual(expect.arrayContaining([originMode]));
      expect(args).not.toContain('stale.example.com');
      const script = args[args.indexOf('-c') + 1];
      // The domain branch is selected by the validated mode argument only.
      expect(script).toContain('if [ "$4" = "domain" ]; then');
      expect(script).toContain('--update --domain "$1"');
      expect(script).toMatch(/else\n[^\n]*--update >> "\$2" 2>&1/);
    }
  });

  test('rejects an unknown origin mode and a domain-mode launch without a domain', async () => {
    const execFileImpl = jest.fn().mockResolvedValue(undefined);
    await expect(launchPortalSelfUpdate({
      originMode: 'public' as never,
      domain: 'portal.example.com',
      logFile: '/opt/bridgesllm/logs/self-update-test.log',
      expectedVersion: '4.1.0',
    }, { execFileImpl })).rejects.toMatchObject({
      statusCode: 500,
      code: 'PORTAL_UPDATE_LAUNCH_FAILED',
    });
    await expect(launchPortalSelfUpdate({
      originMode: 'domain',
      domain: '',
      logFile: '/opt/bridgesllm/logs/self-update-test.log',
      expectedVersion: '4.1.0',
    }, { execFileImpl })).rejects.toMatchObject({
      statusCode: 500,
      code: 'PORTAL_UPDATE_LAUNCH_FAILED',
    });
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('closes the pre-registration race and translates an existing systemd unit to a clean conflict', async () => {
    let releaseRegistration!: () => void;
    const pendingRegistration = new Promise<void>((resolve) => { releaseRegistration = resolve; });
    const execFileImpl = jest.fn().mockReturnValueOnce(pendingRegistration);
    const input = {
      originMode: 'domain' as const,
      domain: 'portal.example.com',
      logFile: '/opt/bridgesllm/logs/self-update-test.log',
      expectedVersion: '4.1.0',
    };

    const first = launchPortalSelfUpdate(input, { execFileImpl });
    await expect(launchPortalSelfUpdate(input, { execFileImpl })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PORTAL_UPDATE_BUSY',
    });
    expect(execFileImpl).toHaveBeenCalledTimes(1);
    releaseRegistration();
    await first;

    const duplicateUnit = Object.assign(new Error('registration rejected'), {
      stderr: 'Failed to start transient service unit: Unit bridgesllm-portal-self-update.service already exists.',
    });
    await expect(launchPortalSelfUpdate(input, {
      execFileImpl: jest.fn().mockRejectedValue(duplicateUnit),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PORTAL_UPDATE_BUSY',
      message: expect.not.stringContaining('systemd'),
    });
  });

  test('keeps updater registration failures bounded and does not expose host diagnostics', async () => {
    const diagnostic = Object.assign(new Error('token=secret command trace'), {
      stderr: 'private host traceback',
    });
    await expect(launchPortalSelfUpdate({
      originMode: 'domain',
      domain: 'portal.example.com',
      logFile: '/opt/bridgesllm/logs/self-update-test.log',
      expectedVersion: '4.1.0',
    }, {
      execFileImpl: jest.fn().mockRejectedValue(diagnostic),
    })).rejects.toMatchObject({
      statusCode: 500,
      code: 'PORTAL_UPDATE_LAUNCH_FAILED',
      message: 'Portal could not start the signed updater. Check the Portal service log before retrying.',
    });
  });
});
