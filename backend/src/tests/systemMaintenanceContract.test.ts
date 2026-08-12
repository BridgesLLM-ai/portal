import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  buildPortalMaintenanceComponent,
  buildOpenClawMaintenanceComponent,
  checkedMaintenanceServiceUnits,
  findFreshVerifiedMaintenanceBackup,
  getMaintenanceActionContract,
  inspectMaintenanceBackupAdmission,
  MAINTENANCE_BACKUP_MAX_AGE_HOURS,
  maintenanceBackupRejectionPayload,
  MaintenanceRefreshCoordinator,
  maintenanceActionCanRun,
  maintenanceActionConfirmationValid,
  maintenanceWindowAcknowledgementValid,
  portalCompatibilitySnapshot,
} from '../routes/system-maintenance';
import { backupReceiptSigningPayload } from '../services/backup.service';

jest.mock('../config/database', () => ({
  prisma: {
    agentJob: { findFirst: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
  },
}));

function openClawReadiness(overrides: Record<string, unknown> = {}) {
  return {
    installed: true,
    version: '2026.7.1',
    corePackageVersion: '2026.7.1-2',
    runningVersion: '2026.7.1',
    codexPluginVersion: '2026.7.1-1',
    testedCorePackageVersion: '2026.7.1-2',
    testedRuntimeVersion: '2026.7.1',
    testedCodexPluginVersion: '2026.7.1-1',
    testedPairReady: true,
    blockers: [],
    ...overrides,
  } as any;
}

describe('system maintenance action contract', () => {
  let backupFixtureRoot: string;
  let backupTrustRoot: string;
  let previousBackupTrustRoot: string | undefined;
  const backupTrustKey = Buffer.alloc(32, 0x5a);

  beforeEach(() => {
    backupFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-maintenance-contract-'));
    backupTrustRoot = path.join(backupFixtureRoot, 'trust');
    fs.mkdirSync(backupTrustRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(backupTrustRoot, 'archive-hmac.key'), backupTrustKey, { mode: 0o600 });
    previousBackupTrustRoot = process.env.BRIDGESLLM_BACKUP_TRUST_ROOT;
    process.env.BRIDGESLLM_BACKUP_TRUST_ROOT = backupTrustRoot;
  });

  afterEach(() => {
    if (previousBackupTrustRoot === undefined) delete process.env.BRIDGESLLM_BACKUP_TRUST_ROOT;
    else process.env.BRIDGESLLM_BACKUP_TRUST_ROOT = previousBackupTrustRoot;
    fs.rmSync(backupFixtureRoot, { recursive: true, force: true });
  });

  function authenticatedCandidate(filename: string, requestedMtimeMs: number) {
    const archiveRoot = path.join(backupFixtureRoot, 'backups');
    fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
    const fullPath = path.join(archiveRoot, filename);
    fs.writeFileSync(fullPath, Buffer.alloc(4_096, filename.length & 0xff), { mode: 0o600 });
    const requestedMtime = new Date(requestedMtimeMs);
    fs.utimesSync(fullPath, requestedMtime, requestedMtime);
    const stat = fs.lstatSync(fullPath, { bigint: true });
    const manifestHmac = 'a'.repeat(64);
    const receipt = {
      schema: 'bridgesllm.backup-publication.v1',
      archive: filename,
      backupType: 'comprehensive' as const,
      completeness: 'complete' as const,
      archiveSize: Number(stat.size),
      archiveMtimeNs: stat.mtimeNs.toString(),
      manifestHmac,
      degradedComponents: [] as string[],
      signature: '',
    };
    receipt.signature = crypto.createHmac('sha256', backupTrustKey)
      .update(backupReceiptSigningPayload(receipt))
      .digest('hex');
    fs.writeFileSync(`${fullPath}.receipt.json`, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    return {
      filename,
      fullPath,
      size: Number(stat.size),
      mtimeMs: Number(stat.mtimeNs) / 1_000_000,
      mtimeNs: stat.mtimeNs.toString(),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      type: 'comprehensive' as const,
      completeness: 'complete' as const,
      degradedComponents: [] as string[],
      classificationAuthenticated: true,
    };
  }

  test('single-flights concurrent host collection requests', async () => {
    let resolveCollection!: (value: { status: string }) => void;
    const collect = jest.fn(() => new Promise<{ status: string }>((resolve) => {
      resolveCollection = resolve;
    }));
    const coordinator = new MaintenanceRefreshCoordinator(collect);

    const first = coordinator.requestRefresh();
    const second = coordinator.requestRefresh();
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.promise).toBe(first.promise);
    await Promise.resolve();
    expect(collect).toHaveBeenCalledTimes(1);

    resolveCollection({ status: 'healthy' });
    await first.promise;
    expect(coordinator.snapshot()).toMatchObject({
      refreshing: false,
      refreshError: null,
      retryAfterMs: null,
    });
  });

  test('backs persistent failures off from five seconds to a sixty-second cap', async () => {
    let nowMs = 10_000;
    const collect = jest.fn(async () => {
      throw new Error('apt/systemd probe failed');
    });
    const coordinator = new MaintenanceRefreshCoordinator(collect, { nowMs: () => nowMs });
    const expectedDelays = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];

    for (const expectedDelay of expectedDelays) {
      const attempt = coordinator.requestRefresh();
      expect(attempt.started).toBe(true);
      await attempt.promise;
      expect(coordinator.snapshot()).toMatchObject({
        refreshing: false,
        refreshError: 'apt/systemd probe failed',
        retryAfterMs: expectedDelay,
      });
      expect(coordinator.requestRefresh()).toMatchObject({ started: false, promise: null });
      nowMs += expectedDelay;
    }

    expect(collect).toHaveBeenCalledTimes(expectedDelays.length);
  });

  test('resets the failure exponent after a successful refresh', async () => {
    let nowMs = 20_000;
    let outcome: 'failure' | 'success' = 'failure';
    const coordinator = new MaintenanceRefreshCoordinator(async () => {
      if (outcome === 'failure') throw new Error('temporary host probe failure');
      return { status: 'healthy' };
    }, { nowMs: () => nowMs });

    await coordinator.requestRefresh().promise;
    expect(coordinator.snapshot().retryAfterMs).toBe(5_000);
    nowMs += 5_000;
    outcome = 'success';
    await coordinator.requestRefresh().promise;
    expect(coordinator.snapshot()).toEqual({
      cache: { at: nowMs, status: { status: 'healthy' } },
      refreshing: false,
      refreshError: null,
      retryAfterMs: null,
    });

    outcome = 'failure';
    await coordinator.requestRefresh().promise;
    expect(coordinator.snapshot().retryAfterMs).toBe(5_000);
  });

  test('keeps read-only planning available to both elevated roles', () => {
    const plan = getMaintenanceActionContract('generate-maintenance-plan');
    const rebootChecklist = getMaintenanceActionContract('prepare-reboot-checklist');
    expect(plan).toMatchObject({ changesSystem: false, requiresOwner: false, confirmationPhrase: null });
    expect(rebootChecklist).toMatchObject({ changesSystem: false, requiresOwner: false, confirmationPhrase: null });
    expect(maintenanceActionCanRun('SUB_ADMIN', plan!)).toBe(true);
    expect(maintenanceActionConfirmationValid(plan!, undefined)).toBe(true);
  });

  test('keeps every server mutation owner-only with an exact typed confirmation', () => {
    for (const actionId of ['refresh-package-cache', 'apply-security-updates', 'create-maintenance-backup']) {
      const action = getMaintenanceActionContract(actionId);
      expect(action).toMatchObject({ changesSystem: true, requiresOwner: true });
      expect(action?.confirmationPhrase).toBeTruthy();
      expect(maintenanceActionCanRun('SUB_ADMIN', action!)).toBe(false);
      expect(maintenanceActionCanRun('OWNER', action!)).toBe(true);
      expect(maintenanceActionConfirmationValid(action!, action!.confirmationPhrase)).toBe(true);
      expect(maintenanceActionConfirmationValid(action!, String(action!.confirmationPhrase).toLowerCase())).toBe(false);
    }
  });

  test('requires an explicit maintenance-window acknowledgement for guarded updates', () => {
    const updates = getMaintenanceActionContract('apply-security-updates')!;
    const backup = getMaintenanceActionContract('create-maintenance-backup')!;
    const refresh = getMaintenanceActionContract('refresh-package-cache')!;
    expect(maintenanceWindowAcknowledgementValid(updates, undefined)).toBe(false);
    expect(maintenanceWindowAcknowledgementValid(updates, false)).toBe(false);
    expect(maintenanceWindowAcknowledgementValid(updates, true)).toBe(true);
    expect(backup).toMatchObject({
      downtimeExpected: true,
      requiresMaintenanceWindow: true,
      automationLevel: 'guarded',
    });
    expect(maintenanceWindowAcknowledgementValid(backup, false)).toBe(false);
    expect(maintenanceWindowAcknowledgementValid(backup, true)).toBe(true);
    expect(maintenanceWindowAcknowledgementValid(refresh, undefined)).toBe(true);
  });

  test('accepts only a fresh archive that passes integrity verification', async () => {
    const nowMs = Date.parse('2026-07-19T12:00:00.000Z');
    const candidate = (filename: string, ageHours: number) => (
      authenticatedCandidate(filename, nowMs - ageHours * 3_600_000)
    );
    const corrupt = candidate('portal-comprehensive-corrupt.tar.gz', 1);
    const verified = candidate('portal-comprehensive-verified.tar.gz', MAINTENANCE_BACKUP_MAX_AGE_HOURS);
    const stale = candidate('portal-comprehensive-stale.tar.gz', MAINTENANCE_BACKUP_MAX_AGE_HOURS + 0.1);
    const newerDaily = { ...candidate('portal-daily-newer.tar.gz', 0.5), type: 'daily' as const };
    const degraded = { ...candidate('portal-comprehensive-degraded.tar.gz', 0.25), completeness: 'degraded' as const };
    const checked: string[] = [];

    await expect(findFreshVerifiedMaintenanceBackup({
      nowMs,
      candidates: [stale, verified, corrupt, newerDaily, degraded],
      verifyArchive: async (entry) => {
        checked.push(entry.filename);
        return entry.filename === verified.filename;
      },
    })).resolves.toMatchObject({ filename: verified.filename, ageHours: MAINTENANCE_BACKUP_MAX_AGE_HOURS });
    expect(checked).toEqual([corrupt.filename, verified.filename]);
  });

  test('returns bounded actionable rejection categories without leaking archive paths', async () => {
    const nowMs = Date.parse('2026-07-19T12:00:00.000Z');
    const candidate = (overrides: Record<string, unknown> = {}) => ({
      ...authenticatedCandidate(
        `portal-comprehensive-candidate-${crypto.randomUUID()}.tar.gz`,
        nowMs - 60_000,
      ),
      ...overrides,
    });

    const degraded = await inspectMaintenanceBackupAdmission({
      nowMs,
      candidates: [candidate({
        completeness: 'degraded',
        degradedComponents: ['projects', 'hosted-apps', 'projects'],
      }) as any],
    });
    expect(degraded).toEqual({
      backup: null,
      backupRejection: 'AUTHENTICATED_DEGRADED_ARCHIVE',
      degradedComponents: ['hosted-apps', 'projects'],
    });
    const degradedPayload = maintenanceBackupRejectionPayload(degraded);
    expect(degradedPayload).toMatchObject({
      code: 'FRESH_VERIFIED_BACKUP_REQUIRED',
      backupRejection: 'AUTHENTICATED_DEGRADED_ARCHIVE',
      degradedComponents: ['hosted-apps', 'projects'],
    });
    expect(JSON.stringify(degradedPayload)).not.toContain('/private/backups');

    await expect(inspectMaintenanceBackupAdmission({
      nowMs,
      candidates: [candidate({ completeness: 'unknown', classificationAuthenticated: false }) as any],
    })).resolves.toMatchObject({ backupRejection: 'UNCLASSIFIED_ARCHIVE' });
    await expect(inspectMaintenanceBackupAdmission({
      nowMs,
      candidates: [{ ...candidate(), type: 'daily' }],
    })).resolves.toMatchObject({ backupRejection: 'NO_COMPREHENSIVE_CANDIDATE' });
    await expect(inspectMaintenanceBackupAdmission({
      nowMs,
      candidates: [candidate()],
      verifyArchive: async () => false,
    })).resolves.toMatchObject({ backupRejection: 'STRICT_VERIFICATION_FAILED_OR_TIMED_OUT' });
  });

  test('shares one bounded strict-verification deadline across maintenance candidates', async () => {
    const nowMs = Date.parse('2026-07-19T12:00:00.000Z');
    let clockMs = 500;
    const observedTimeouts: number[] = [];
    const candidates = [0, 1, 2].map((offset) => authenticatedCandidate(
      `portal-comprehensive-${offset}.tar.gz`,
      nowMs - offset * 1_000,
    ));

    await expect(inspectMaintenanceBackupAdmission({
      nowMs,
      candidates,
      clock: () => clockMs,
      totalTimeoutMs: 4_000,
      verifyArchive: async (_candidate, timeoutMs = 0) => {
        observedTimeouts.push(timeoutMs);
        clockMs += timeoutMs;
        return false;
      },
    })).resolves.toMatchObject({ backupRejection: 'STRICT_VERIFICATION_FAILED_OR_TIMED_OUT' });
    expect(observedTimeouts).toEqual([4_000]);
  });

  test('checks the complete installed service and backup-timer surface', () => {
    const units = new Map(checkedMaintenanceServiceUnits().map((unit) => [unit.name, unit.required]));
    expect(Array.from(units.keys())).toEqual(expect.arrayContaining([
      'openclaw-gateway.service',
      'postgresql.service',
      'stalwart-mail.service',
      'clamav-daemon.service',
      'clamav-freshclam.service',
      'monarx-agent.service',
      'bridgesllm-backup-daily.timer',
      'bridgesllm-backup-comprehensive.timer',
      'bridgesllm-backup-monthly.timer',
    ]));
    expect(units.get('clamav-daemon.service')).toBe(true);
    expect(units.get('bridgesllm-backup-daily.timer')).toBe(true);
    expect(units.get('monarx-agent.service')).toBe(false);
  });

  test('fails Portal compatibility closed on version or deployment-provenance drift', () => {
    const cleanStamp = {
      kind: 'portal' as const,
      schema: '1',
      releaseVersion: '4.0.0',
      sourceVersion: '4.0.0',
      artifactSha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
      manifestSchema: '1',
      installedAt: '2026-07-19T12:00:00.000Z',
      sourceHead: null,
      sourceDirty: null,
      deployedAt: null,
    };
    expect(buildPortalMaintenanceComponent({
      packageVersion: '4.0.0',
      sourceVersion: null,
      compiledVersion: '4.0.0',
      installerVersion: '4.0.0',
      deployStamp: cleanStamp,
    })).toMatchObject({ status: 'ok' });
    expect(buildPortalMaintenanceComponent({
      packageVersion: '4.0.0',
      sourceVersion: null,
      compiledVersion: '4.0.0',
      installerVersion: '4.0.0',
      deployStamp: { ...cleanStamp, manifestSchema: '2' },
    })).toMatchObject({ status: 'ok' });
    expect(buildPortalMaintenanceComponent({
      packageVersion: '4.0.0',
      sourceVersion: '4.0.0',
      compiledVersion: '3.26.1',
      installerVersion: '4.0.0',
      deployStamp: cleanStamp,
    })).toMatchObject({ status: 'blocked' });
    expect(buildPortalMaintenanceComponent({
      packageVersion: '4.0.0',
      sourceVersion: null,
      compiledVersion: '4.0.0',
      installerVersion: '4.0.0',
      deployStamp: null,
    })).toMatchObject({ status: 'review' });
    expect(buildPortalMaintenanceComponent({
      packageVersion: '4.0.0',
      sourceVersion: null,
      compiledVersion: '4.0.0',
      installerVersion: '4.0.0',
      deployStamp: { ...cleanStamp, releaseVersion: '3.26.1', sourceVersion: '3.26.1' },
    })).toMatchObject({ status: 'blocked' });
    expect(buildPortalMaintenanceComponent({
      packageVersion: '4.0.0',
      sourceVersion: null,
      compiledVersion: '4.0.0',
      installerVersion: '4.0.0',
      deployStamp: { ...cleanStamp, manifestSha256: null },
    })).toMatchObject({ status: 'review' });
    expect(buildPortalMaintenanceComponent({
      packageVersion: '4.0.0',
      sourceVersion: null,
      compiledVersion: '4.0.0',
      installerVersion: '4.0.0',
      deployStamp: {
        ...cleanStamp,
        kind: 'candidate',
        schema: null,
        releaseVersion: null,
        sourceVersion: null,
        manifestSha256: null,
        manifestSchema: null,
        installedAt: null,
        sourceHead: '0123456',
        sourceDirty: 'clean',
        deployedAt: '2030-01-02T12:00:00.000Z',
      },
    })).toMatchObject({ status: 'review' });
  });

  test('consumes the installer-owned stamp format and rejects malformed provenance', () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-compatibility-'));
    const portalRoot = path.join(testRoot, 'portal');
    try {
      fs.mkdirSync(path.join(portalRoot, 'backend', 'dist'), { recursive: true });
      fs.mkdirSync(path.join(portalRoot, 'installer'), { recursive: true });
      fs.writeFileSync(path.join(portalRoot, 'backend', 'package.json'), '{"version":"4.0.0"}\n');
      fs.writeFileSync(path.join(portalRoot, 'backend', 'dist', 'version.js'), 'exports.PORTAL_VERSION = "4.0.0";\n');
      fs.writeFileSync(path.join(portalRoot, 'installer', 'install.sh'), 'readonly VERSION="4.0.0"\n');
      const stampPath = path.join(testRoot, '.last-portal-deploy');
      const stamp = [
        'schema=1',
        'source_version=4.0.0',
        'release_version=4.0.0',
        `artifact_sha256=${'a'.repeat(64)}`,
        `manifest_sha256=${'b'.repeat(64)}`,
        'manifest_schema=1',
        'installed_at=2026-07-19T12:00:00Z',
        '',
      ].join('\n');
      fs.writeFileSync(stampPath, stamp, { mode: 0o600 });
      expect(buildPortalMaintenanceComponent(portalCompatibilitySnapshot(portalRoot))).toMatchObject({ status: 'ok' });

      fs.appendFileSync(stampPath, 'release_version=4.0.0\n');
      expect(buildPortalMaintenanceComponent(portalCompatibilitySnapshot(portalRoot))).toMatchObject({ status: 'blocked' });
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('does not call an arbitrary installed OpenClaw version compatible', () => {
    expect(buildOpenClawMaintenanceComponent(openClawReadiness())).toMatchObject({
      status: 'ok',
      supportedVersion: 'core 2026.7.1-2 · runtime 2026.7.1 · Codex 2026.7.1-1',
    });

    expect(buildOpenClawMaintenanceComponent(openClawReadiness({
      corePackageVersion: '2026.7.2-beta.3',
      testedPairReady: false,
      blockers: [{
        code: 'core-package-mismatch',
        message: 'OpenClaw core must be 2026.7.1-2; detected 2026.7.2-beta.3.',
      }],
    }))).toMatchObject({
      status: 'blocked',
      note: 'OpenClaw core must be 2026.7.1-2; detected 2026.7.2-beta.3.',
    });
  });
});
