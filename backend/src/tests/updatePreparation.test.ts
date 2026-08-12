import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createHash, createPublicKey } from 'crypto';
import {
  __resetPortalSelfUpdateLaunchStateForTests,
  UPDATE_BACKUP_MAX_AGE_HOURS,
  admitPortalUpdate,
  admitPortalUpdateRelease,
  assessUpdateBackupReadiness,
  findFreshVerifiedUpdateBackup,
  launchPortalSelfUpdate,
  PORTAL_INSTALLER_AUTHENTICATION_SCRIPT,
  unavailableUpdatePreparation,
  verifyUpdateBackupArchive,
  type PortalUpdatePreparation,
} from '../services/updatePreparation';

jest.mock('../config/database', () => ({
  prisma: {
    systemSetting: { findUnique: jest.fn() },
  },
}));

const NOW = Date.parse('2026-07-20T20:00:00.000Z');
const progressWriter = () => jest.fn().mockResolvedValue(undefined);
const admittedBackup = {
  type: 'comprehensive' as const,
  completeness: 'complete' as const,
  classificationAuthenticated: true,
};

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

  test('reports candidate, strictly verified, stale, missing, and active states without exposing paths', () => {
    expect(assessUpdateBackupReadiness([
      { ...admittedBackup, mtimeMs: NOW - 2 * 3_600_000, size: 100 },
    ], null, NOW)).toEqual({
      state: 'candidate',
      maxAgeHours: 24,
      newestCreatedAt: '2026-07-20T18:00:00.000Z',
      ageHours: 2,
      activeStatus: null,
    });
    expect(assessUpdateBackupReadiness([
      { ...admittedBackup, mtimeMs: NOW - 2 * 3_600_000, size: 100 },
    ], null, NOW, { strictlyVerified: true }).state).toBe('fresh');

    expect(assessUpdateBackupReadiness([
      { ...admittedBackup, mtimeMs: NOW - 25 * 3_600_000, size: 100 },
    ], null, NOW).state).toBe('stale');
    expect(assessUpdateBackupReadiness([], null, NOW).state).toBe('missing');
    expect(assessUpdateBackupReadiness([], { status: 'queued' }, NOW)).toMatchObject({
      state: 'running',
      activeStatus: 'queued',
    });
  });

  test('does not trust empty archives or timestamps far in the future', () => {
    expect(assessUpdateBackupReadiness([
      { ...admittedBackup, mtimeMs: NOW, size: 0 },
    ], null, NOW).state).toBe('missing');
    expect(assessUpdateBackupReadiness([
      { ...admittedBackup, mtimeMs: NOW + 10 * 60_000, size: 100 },
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

    expect(admitPortalUpdate(preparation('candidate'), {
      confirmation: 'UPDATE PORTAL',
      backupDecision: 'use-current',
    })).toMatchObject({ ok: false, code: 'FRESH_BACKUP_REQUIRED' });
    expect(admitPortalUpdate(preparation('candidate'), {
      confirmation: 'UPDATE PORTAL',
      backupDecision: 'use-current',
    }, { allowAuthenticatedCandidate: true })).toEqual({
      ok: true,
      backupDecision: 'use-current',
    });
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
    const fullPath = path.join(directory, 'portal-comprehensive-test.tar.gz');
    fs.writeFileSync(fullPath, 'verified backup bytes');
    const initial = fs.lstatSync(fullPath, { bigint: true });
    const candidate = {
      filename: path.basename(fullPath),
      fullPath,
      mtimeMs: Number(initial.mtimeMs),
      mtimeNs: initial.mtimeNs.toString(),
      size: Number(initial.size),
      dev: initial.dev.toString(),
      ino: initial.ino.toString(),
      ...admittedBackup,
    };

    try {
      const execFileImpl = jest.fn().mockResolvedValue(undefined);
      await expect(verifyUpdateBackupArchive(candidate, {
        execFileImpl,
        restoreScriptPath: '/opt/bridgesllm/portal/restore-full.sh',
      })).resolves.toBe(true);
      expect(execFileImpl).toHaveBeenCalledWith('/bin/bash', [
        '/opt/bridgesllm/portal/restore-full.sh',
        '--verify-archive',
        fullPath,
      ], expect.objectContaining({ timeout: 900_000, maxBuffer: 64 * 1024 }));

      const mutatingVerifier = jest.fn().mockImplementation(async () => {
        fs.appendFileSync(fullPath, 'tampered');
      });
      await expect(verifyUpdateBackupArchive(candidate, {
        execFileImpl: mutatingVerifier,
        restoreScriptPath: '/opt/bridgesllm/portal/restore-full.sh',
      })).resolves.toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('checks a bounded newest-first set and accepts the next restore-admitted archive', async () => {
    const newest = {
      filename: 'portal-comprehensive-new.tar.gz',
      fullPath: '/backups/comprehensive/portal-comprehensive-new.tar.gz',
      mtimeMs: NOW - 60_000,
      mtimeNs: String(BigInt(NOW - 60_000) * 1_000_000n),
      size: 200,
      dev: '1',
      ino: '2',
      ...admittedBackup,
    };
    const older = {
      filename: 'portal-comprehensive-old.tar.gz',
      fullPath: '/backups/comprehensive/portal-comprehensive-old.tar.gz',
      mtimeMs: NOW - 2 * 3_600_000,
      mtimeNs: String(BigInt(NOW - 2 * 3_600_000) * 1_000_000n),
      size: 100,
      dev: '1',
      ino: '1',
      ...admittedBackup,
    };
    const verifyArchive = jest.fn(async (candidate: { filename: string }) => candidate.filename === older.filename);

    await expect(findFreshVerifiedUpdateBackup([older, newest], NOW, verifyArchive))
      .resolves.toEqual(older);
    expect(verifyArchive.mock.calls.map(([candidate]) => candidate.filename))
      .toEqual([newest.filename, older.filename]);
  });

  test('shares one verification deadline across candidates instead of multiplying timeouts', async () => {
    let clockMs = 1_000;
    const candidates = [0, 1, 2].map((offset) => ({
      filename: `portal-comprehensive-${offset}.tar.gz`,
      fullPath: `/backups/comprehensive/portal-comprehensive-${offset}.tar.gz`,
      mtimeMs: NOW - offset * 1_000,
      mtimeNs: String(BigInt(NOW - offset * 1_000) * 1_000_000n),
      size: 100,
      dev: '1',
      ino: String(offset + 1),
      ...admittedBackup,
    }));
    const observedTimeouts: number[] = [];
    const verifyArchive = jest.fn(async (_candidate: { filename: string }, timeoutMs = 0) => {
      observedTimeouts.push(timeoutMs);
      clockMs += timeoutMs;
      return false;
    });

    await expect(findFreshVerifiedUpdateBackup(candidates, NOW, verifyArchive, {
      clock: () => clockMs,
      totalTimeoutMs: 5_000,
    })).resolves.toBeNull();
    expect(observedTimeouts).toEqual([5_000]);
  });

  test('ignores daily, degraded, and unauthenticated archives even when newer', () => {
    expect(assessUpdateBackupReadiness([
      { ...admittedBackup, mtimeMs: NOW - 3_600_000, size: 100 },
      { ...admittedBackup, type: 'daily', mtimeMs: NOW - 1_000, size: 999 },
      { ...admittedBackup, completeness: 'degraded', mtimeMs: NOW - 2_000, size: 999 },
      { ...admittedBackup, classificationAuthenticated: false, mtimeMs: NOW - 3_000, size: 999 },
    ], null, NOW)).toMatchObject({
      state: 'candidate',
      newestCreatedAt: '2026-07-20T19:00:00.000Z',
    });
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
    const progressExecFileImpl = progressWriter();
    await launchPortalSelfUpdate({
      originMode: 'domain',
      domain: 'portal.example.com',
      logFile: '/opt/bridgesllm/logs/self-update-test.log',
      previousVersion: '4.0.13',
      expectedVersion: '4.1.0',
    }, { execFileImpl, progressExecFileImpl });

    expect(execFileImpl).toHaveBeenCalledTimes(1);
    expect(progressExecFileImpl).toHaveBeenCalledWith('/usr/bin/python3', expect.arrayContaining([
      'create', '--previous-version', '4.0.13', '--target-version', '4.1.0',
    ]), expect.any(Object));
    const [file, args, options] = execFileImpl.mock.calls[0];
    expect(file).toBe('/usr/bin/systemd-run');
    expect(args).toEqual(expect.arrayContaining([
      '--unit=bridgesllm-portal-self-update',
      '--collect',
      '--no-block',
      '--property=RuntimeMaxSec=4h',
      '--property=TimeoutStartSec=4h',
      '--property=TimeoutStopSec=30min',
      expect.stringMatching(/^--property=ExecStopPost=\/usr\/bin\/python3 \/var\/lib\/bridgesllm-installer\/dashboard-update-progress\.py finalize-service --operation-id [a-f0-9]{32}$/),
      expect.stringMatching(/^--setenv=BRIDGESLLM_DASHBOARD_UPDATE_ID=[a-f0-9]{32}$/),
      '/bin/bash',
      'portal.example.com',
      '/opt/bridgesllm/logs/self-update-test.log',
      '4.1.0',
      'domain',
      '4.0.13',
    ]));
    const script = args[args.indexOf('-c') + 1];
    expect(spawnSync('/bin/bash', ['-n'], { input: script }).status).toBe(0);
    expect(script).toContain('set -Eeuo pipefail');
    expect(script).not.toContain('finish --operation-id');
    expect(script).toContain('/bin/sync -f "$2" || true');
    expect(script).toContain('https://bridgesllm.ai/releases/$3/install.sh');
    expect(script).toContain('https://bridgesllm.ai/releases/$3/install.sh.sig');
    expect(script).toContain('https://bridgesllm.ai/releases/$3/portal-release.manifest');
    expect(script).toContain('https://bridgesllm.ai/releases/$3/portal-release.sig');
    expect(script).toContain('--connect-timeout 15 --max-time 120');
    expect(script).toContain('--retry 3 --retry-delay 2 --retry-max-time 300 --retry-all-errors');
    expect(script).toContain('--max-filesize 2097152 -o "$installer_file"');
    expect(script).toContain('--max-filesize 64 -o "$installer_signature_file"');
    expect(script).toContain('/usr/bin/mktemp /var/lib/bridgesllm-installer/dashboard-update-installer.XXXXXX');
    expect(script).not.toContain('| /bin/bash');
    expect(script).not.toContain('http://127.0.0.1:4001/health');
    expect(script).not.toContain('/bin/bash "$installer_file"');
    expect(PORTAL_INSTALLER_AUTHENTICATION_SCRIPT).toContain('/bin/bash "$installer_fd"');
    expect(PORTAL_INSTALLER_AUTHENTICATION_SCRIPT).toContain('--domain "$domain"');
    expect(PORTAL_INSTALLER_AUTHENTICATION_SCRIPT).toContain('pkeyutl -verify');
    expect(PORTAL_INSTALLER_AUTHENTICATION_SCRIPT).toContain('expected_version="$7"');
    expect(spawnSync('/bin/bash', ['-n'], {
      input: PORTAL_INSTALLER_AUTHENTICATION_SCRIPT,
    }).status).toBe(0);
    expect(script).toContain('>> "$2" 2>&1');
    expect(script).not.toContain('portal.example.com');
    expect(script).not.toContain('/opt/bridgesllm/logs/self-update-test.log');
    expect(script).not.toContain('4.1.0');
    expect(options).toMatchObject({ timeout: 10_000, maxBuffer: 64 * 1024 });
  });

  test('private-origin updates launch plain --update and never inherit a domain argument', async () => {
    for (const originMode of ['tailnet', 'local'] as const) {
      const execFileImpl = jest.fn().mockResolvedValue(undefined);
      const progressExecFileImpl = progressWriter();
      await launchPortalSelfUpdate({
        originMode,
        domain: 'stale.example.com',
        logFile: '/opt/bridgesllm/logs/self-update-test.log',
        previousVersion: '4.0.13',
        expectedVersion: '4.1.0',
      }, { execFileImpl, progressExecFileImpl });

      const [, args] = execFileImpl.mock.calls[0];
      expect(args).toEqual(expect.arrayContaining([originMode]));
      expect(args).not.toContain('stale.example.com');
      const script = args[args.indexOf('-c') + 1];
      // The authenticated executor selects the domain branch only after all
      // release evidence and the exact installer inode have verified.
      expect(script).toContain('/bin/bash -c "$8" portal-installer-auth');
      expect(PORTAL_INSTALLER_AUTHENTICATION_SCRIPT).toContain('if [ "$origin_mode" = "domain" ]; then');
      expect(PORTAL_INSTALLER_AUTHENTICATION_SCRIPT).toContain('--update --domain "$domain"');
      expect(PORTAL_INSTALLER_AUTHENTICATION_SCRIPT).toMatch(/else\n[^\n]*--update/);
    }
  });

  test('authenticates exact version-bound installer bytes before bash and fails closed for bad evidence', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-installer-auth-'));
    const privateKey = path.join(directory, 'release-private.pem');
    const publicKey = path.join(directory, 'release-public.pem');
    const installer = path.join(directory, 'install.sh');
    const installerSignature = path.join(directory, 'install.sh.sig');
    const manifest = path.join(directory, 'portal-release.manifest');
    const manifestSignature = path.join(directory, 'portal-release.sig');
    const marker = path.join(directory, 'executed');

    const openssl = (...args: string[]) => {
      const result = spawnSync('/usr/bin/openssl', args, { encoding: 'utf8' });
      expect(result.status).toBe(0);
    };
    const sign = (source: string, destination: string) => {
      openssl('pkeyutl', '-sign', '-inkey', privateKey, '-rawin', '-in', source, '-out', destination);
      fs.chmodSync(destination, 0o600);
      expect(fs.statSync(destination).size).toBe(64);
    };
    const writeFixture = (installerVersion = '4.1.0', manifestVersion = '4.1.0') => {
      fs.writeFileSync(installer, [
        '#!/usr/bin/env bash',
        `readonly VERSION="${installerVersion}"`,
        'printf "%s\\n" "$*" > "$BRIDGESLLM_AUTH_TEST_MARKER"',
        '',
      ].join('\n'), { mode: 0o600 });
      fs.chmodSync(installer, 0o600);
      fs.writeFileSync(manifest, [
        'schema=2',
        `version=${manifestVersion}`,
        'artifact=portal.tar.gz',
        'sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'size=1',
        'released=2026-08-11',
        'release_class=hotfix',
        'highlights=WyJ0ZXN0Il0',
        '',
      ].join('\n'), { mode: 0o600 });
      fs.chmodSync(manifest, 0o600);
      sign(installer, installerSignature);
      sign(manifest, manifestSignature);
      try { fs.unlinkSync(marker); } catch {}
    };
    const runAuthentication = () => spawnSync('/bin/bash', [
      '-c', PORTAL_INSTALLER_AUTHENTICATION_SCRIPT, 'portal-installer-auth',
      installer, installerSignature, manifest, manifestSignature,
      publicKey,
      createHash('sha256').update(createPublicKey(fs.readFileSync(publicKey)).export({
        type: 'spki',
        format: 'der',
      })).digest('hex'),
      '4.1.0', 'domain', 'portal.example.com',
    ], {
      encoding: 'utf8',
      env: { ...process.env, BRIDGESLLM_AUTH_TEST_MARKER: marker },
    });
    const expectNoExecution = () => expect(fs.existsSync(marker)).toBe(false);

    try {
      openssl('genpkey', '-algorithm', 'ED25519', '-out', privateKey);
      openssl('pkey', '-in', privateKey, '-pubout', '-out', publicKey);
      fs.chmodSync(privateKey, 0o600);
      fs.chmodSync(publicKey, 0o644);

      writeFixture();
      expect(runAuthentication().status).toBe(0);
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe('--update --domain portal.example.com');

      writeFixture();
      fs.appendFileSync(installer, '# tampered after signature\n');
      expect(runAuthentication().status).not.toBe(0);
      expectNoExecution();

      writeFixture();
      fs.appendFileSync(manifest, 'tampered=true\n');
      expect(runAuthentication().status).not.toBe(0);
      expectNoExecution();

      writeFixture();
      fs.unlinkSync(installerSignature);
      expect(runAuthentication().status).not.toBe(0);
      expectNoExecution();

      writeFixture('4.1.1');
      expect(runAuthentication().status).not.toBe(0);
      expectNoExecution();

      writeFixture('4.1.0', '4.1.1');
      expect(runAuthentication().status).not.toBe(0);
      expectNoExecution();

      writeFixture();
      fs.appendFileSync(installer, 'readonly VERSION="4.1.0"\n');
      sign(installer, installerSignature);
      expect(runAuthentication().status).not.toBe(0);
      expectNoExecution();

      writeFixture();
      fs.writeFileSync(installerSignature, Buffer.alloc(64), { mode: 0o600 });
      fs.chmodSync(installerSignature, 0o600);
      expect(runAuthentication().status).not.toBe(0);
      expectNoExecution();

      writeFixture();
      fs.writeFileSync(manifestSignature, Buffer.alloc(65), { mode: 0o600 });
      fs.chmodSync(manifestSignature, 0o600);
      expect(runAuthentication().status).not.toBe(0);
      expectNoExecution();

      writeFixture();
      fs.writeFileSync(manifest, Buffer.alloc(16_385, 0x61), { mode: 0o600 });
      fs.chmodSync(manifest, 0o600);
      sign(manifest, manifestSignature);
      expect(runAuthentication().status).not.toBe(0);
      expectNoExecution();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects an unknown origin mode and a domain-mode launch without a domain', async () => {
    const execFileImpl = jest.fn().mockResolvedValue(undefined);
    const progressExecFileImpl = progressWriter();
    await expect(launchPortalSelfUpdate({
      originMode: 'public' as never,
      domain: 'portal.example.com',
      logFile: '/opt/bridgesllm/logs/self-update-test.log',
      previousVersion: '4.0.13',
      expectedVersion: '4.1.0',
    }, { execFileImpl, progressExecFileImpl })).rejects.toMatchObject({
      statusCode: 500,
      code: 'PORTAL_UPDATE_LAUNCH_FAILED',
    });
    await expect(launchPortalSelfUpdate({
      originMode: 'domain',
      domain: '',
      logFile: '/opt/bridgesllm/logs/self-update-test.log',
      previousVersion: '4.0.13',
      expectedVersion: '4.1.0',
    }, { execFileImpl, progressExecFileImpl })).rejects.toMatchObject({
      statusCode: 500,
      code: 'PORTAL_UPDATE_LAUNCH_FAILED',
    });
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('closes the pre-registration race and translates an existing systemd unit to a clean conflict', async () => {
    let releaseRegistration!: () => void;
    const pendingRegistration = new Promise<void>((resolve) => { releaseRegistration = resolve; });
    const execFileImpl = jest.fn().mockReturnValueOnce(pendingRegistration);
    const progressExecFileImpl = progressWriter();
    const input = {
      originMode: 'domain' as const,
      domain: 'portal.example.com',
      logFile: '/opt/bridgesllm/logs/self-update-test.log',
      previousVersion: '4.0.13',
      expectedVersion: '4.1.0',
    };

    const first = launchPortalSelfUpdate(input, { execFileImpl, progressExecFileImpl });
    await expect(launchPortalSelfUpdate(input, { execFileImpl, progressExecFileImpl })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PORTAL_UPDATE_BUSY',
    });
    expect(execFileImpl).toHaveBeenCalledTimes(1);
    releaseRegistration();
    await first;

    const duplicateUnit = Object.assign(new Error('registration rejected'), {
      stderr: 'Failed to start transient service unit: Unit bridgesllm-portal-self-update.service already exists.',
    });
    const duplicateProgressWriter = progressWriter();
    const duplicateActivityReader = jest.fn(async () => ({
      activity: 'active' as const,
      operationId: 'fedcba9876543210fedcba9876543210',
    }));
    await expect(launchPortalSelfUpdate(input, {
      execFileImpl: jest.fn().mockRejectedValue(duplicateUnit),
      progressExecFileImpl: duplicateProgressWriter,
      readUnitIdentityImpl: duplicateActivityReader,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PORTAL_UPDATE_BUSY',
      operationId: expect.stringMatching(/^[a-f0-9]{32}$/),
      message: expect.not.stringContaining('systemd'),
    });
    expect(duplicateActivityReader).not.toHaveBeenCalled();
    expect(duplicateProgressWriter.mock.calls.flatMap((call) => call[1])).toContain('fail-launch');
  });

  test('fails before systemd when durable operation creation is busy, unresolved, or unavailable', async () => {
    const input = {
      originMode: 'domain' as const,
      domain: 'portal.example.com',
      logFile: '/opt/bridgesllm/logs/self-update-test.log',
      previousVersion: '4.0.13',
      expectedVersion: '4.1.0',
    };
    const execFileImpl = jest.fn().mockResolvedValue(undefined);
    await expect(launchPortalSelfUpdate(input, {
      execFileImpl,
      progressExecFileImpl: jest.fn().mockRejectedValue(Object.assign(new Error('busy'), { code: 2 })),
    })).rejects.toMatchObject({ statusCode: 409, code: 'PORTAL_UPDATE_BUSY' });
    expect(execFileImpl).not.toHaveBeenCalled();

    await expect(launchPortalSelfUpdate(input, {
      execFileImpl,
      progressExecFileImpl: jest.fn().mockRejectedValue(Object.assign(new Error('attention'), { code: 4 })),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PORTAL_UPDATE_ATTENTION_REQUIRED',
      message: expect.stringContaining('operator attention'),
    });
    expect(execFileImpl).not.toHaveBeenCalled();

    await expect(launchPortalSelfUpdate(input, {
      execFileImpl,
      progressExecFileImpl: jest.fn().mockRejectedValue(new Error('state unavailable')),
    })).rejects.toMatchObject({ statusCode: 500, code: 'PORTAL_UPDATE_LAUNCH_FAILED' });
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('keeps updater registration failures bounded and does not expose host diagnostics', async () => {
    const diagnostic = Object.assign(new Error('token=secret command trace'), {
      stderr: 'private host traceback',
    });
    const progressExecFileImpl = progressWriter();
    await expect(launchPortalSelfUpdate({
      originMode: 'domain',
      domain: 'portal.example.com',
      logFile: '/opt/bridgesllm/logs/self-update-test.log',
      previousVersion: '4.0.13',
      expectedVersion: '4.1.0',
    }, {
      execFileImpl: jest.fn().mockRejectedValue(diagnostic),
      progressExecFileImpl,
      readUnitIdentityImpl: async () => ({ activity: 'inactive', operationId: null }),
    })).rejects.toMatchObject({
      statusCode: 500,
      code: 'PORTAL_UPDATE_LAUNCH_FAILED',
      message: 'Portal could not start the signed updater. Check the Portal service log before retrying.',
    });
    expect(progressExecFileImpl).toHaveBeenCalledWith('/usr/bin/python3', expect.arrayContaining([
      '/var/lib/bridgesllm-installer/dashboard-update-progress.py',
      'fail-launch',
    ]), expect.any(Object));
  });

  test.each(['active', 'unknown'] as const)(
    'reattaches to the durable operation when systemd registration is %s after reply loss',
    async (unitActivity) => {
      const progressExecFileImpl = progressWriter();
      const result = await launchPortalSelfUpdate({
        originMode: 'domain',
        domain: 'portal.example.com',
        logFile: '/opt/bridgesllm/logs/self-update-test.log',
        previousVersion: '4.0.13',
        expectedVersion: '4.1.0',
      }, {
        execFileImpl: jest.fn().mockRejectedValue(new Error('D-Bus reply was lost')),
        progressExecFileImpl,
        readUnitIdentityImpl: async () => {
          const createArgs = progressExecFileImpl.mock.calls[0][1] as string[];
          const operationId = createArgs[createArgs.indexOf('--operation-id') + 1];
          return {
            activity: unitActivity,
            operationId: unitActivity === 'active' ? operationId : null,
          };
        },
      });

      expect(result.operationId).toMatch(/^[a-f0-9]{32}$/);
      expect(progressExecFileImpl).toHaveBeenCalledTimes(1);
      expect(progressExecFileImpl.mock.calls[0][1]).toContain('create');
      expect(progressExecFileImpl.mock.calls.flatMap((call) => call[1])).not.toContain('fail-launch');
    },
  );

  test('does not attach a lost registration reply to a foreign fixed-unit operation', async () => {
    const progressExecFileImpl = progressWriter();
    await expect(launchPortalSelfUpdate({
      originMode: 'domain',
      domain: 'portal.example.com',
      logFile: '/opt/bridgesllm/logs/self-update-test.log',
      previousVersion: '4.0.13',
      expectedVersion: '4.1.0',
    }, {
      execFileImpl: jest.fn().mockRejectedValue(new Error('ambiguous D-Bus timeout')),
      progressExecFileImpl,
      readUnitIdentityImpl: async () => ({
        activity: 'active',
        operationId: 'fedcba9876543210fedcba9876543210',
      }),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PORTAL_UPDATE_BUSY',
      operationId: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
    expect(progressExecFileImpl.mock.calls.flatMap((call) => call[1])).toContain('fail-launch');
  });

  test('reattaches when an accepted unit progresses before the lost reply is queried', async () => {
    const progressExecFileImpl = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('receipt already progressed'));
    const result = await launchPortalSelfUpdate({
      originMode: 'domain',
      domain: 'portal.example.com',
      logFile: '/opt/bridgesllm/logs/self-update-test.log',
      previousVersion: '4.0.13',
      expectedVersion: '4.1.0',
    }, {
      execFileImpl: jest.fn().mockRejectedValue(new Error('D-Bus reply was lost')),
      progressExecFileImpl,
      readUnitIdentityImpl: async () => ({ activity: 'inactive', operationId: null }),
      readProgressImpl: async (operationId) => ({ operationId, status: 'running' }),
    });

    expect(result.operationId).toMatch(/^[a-f0-9]{32}$/);
    expect(progressExecFileImpl.mock.calls.flatMap((call) => call[1])).toContain('fail-launch');
  });

  test('closes and returns an exact admission fsynced before a create-helper timeout', async () => {
    const progressExecFileImpl = jest.fn()
      .mockRejectedValueOnce(new Error('helper IPC timeout'))
      .mockResolvedValueOnce(undefined);
    const execFileImpl = jest.fn().mockResolvedValue(undefined);
    const result = await launchPortalSelfUpdate({
      originMode: 'domain',
      domain: 'portal.example.com',
      logFile: '/opt/bridgesllm/logs/self-update-test.log',
      previousVersion: '4.0.13',
      expectedVersion: '4.1.0',
    }, {
      execFileImpl,
      progressExecFileImpl,
      readProgressImpl: async (operationId) => ({ operationId, status: 'starting' }),
    });

    expect(result.operationId).toMatch(/^[a-f0-9]{32}$/);
    expect(execFileImpl).not.toHaveBeenCalled();
    expect(progressExecFileImpl).toHaveBeenCalledTimes(2);
    expect(progressExecFileImpl.mock.calls[1][1]).toEqual(expect.arrayContaining([
      'fail-launch', '--operation-id', result.operationId,
    ]));
  });

  test('reattaches when fail-launch fsyncs its receipt before losing the helper reply', async () => {
    const progressExecFileImpl = jest.fn()
      .mockRejectedValueOnce(new Error('create helper IPC timeout'))
      .mockRejectedValueOnce(new Error('fail-launch helper IPC timeout'));
    let progressRead = 0;
    const result = await launchPortalSelfUpdate({
      originMode: 'domain',
      domain: 'portal.example.com',
      logFile: '/opt/bridgesllm/logs/self-update-test.log',
      previousVersion: '4.0.13',
      expectedVersion: '4.1.0',
    }, {
      execFileImpl: jest.fn().mockResolvedValue(undefined),
      progressExecFileImpl,
      readProgressImpl: async (operationId) => ({
        operationId,
        status: progressRead++ === 0 ? 'starting' : 'failed',
      }),
    });
    expect(result.operationId).toMatch(/^[a-f0-9]{32}$/);
    expect(progressRead).toBe(2);
  });
});
