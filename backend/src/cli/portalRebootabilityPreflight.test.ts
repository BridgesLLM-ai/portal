import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  portalRebootabilityPreflightMain,
  preflightDependencyContainmentReadOnly,
} from './portalRebootabilityPreflight';
import { acquireBackupMutationLock } from '../services/backup.service';

const continuityAudit = (linkedApps: number, repairableStaleLinkedApps = 0) => ({
  linkedApps,
  staleLinkedApps: repairableStaleLinkedApps,
  repairableStaleLinkedApps,
  repairPlanToken: 'a'.repeat(64),
});

describe('Portal rebootability preflight', () => {
  test('loads the protected environment before the read-only App startup preflight', async () => {
    const calls: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(portalRebootabilityPreflightMain(
      [
        '--env-file', '/opt/bridgesllm/portal/backend/.env.production',
        '--plan-file', '/opt/bridgesllm/update-stage/continuity-plan.json',
      ],
      {
        stdout: { write: (value: string | Uint8Array) => { stdout.push(String(value)); return true; } },
        stderr: { write: (value: string | Uint8Array) => { stderr.push(String(value)); return true; } },
      },
      {
        getUid: () => 0,
        loadEnvironment: () => { calls.push('environment'); },
        loadDependencies: async () => {
          calls.push('dependencies');
          return {
            preflightDependencyContainment: async () => {
              calls.push('dependency-containment');
              return { repairs: 0, projects: 0, pins: 0 };
            },
            preflightContinuity: async () => {
              calls.push('continuity');
              return continuityAudit(3, 1);
            },
            preflightBindings: async () => {
              calls.push('bindings');
              return { checkedApps: 4, blockers: [], warnings: [] };
            },
            preflightApps: async (strict) => {
              calls.push(`preflight:${strict}`);
              return { apps: [{ id: 'one' }, { id: 'two' }] };
            },
            disconnect: async () => { calls.push('disconnect'); },
          };
        },
        writePlan: (_planFile, audit) => {
          calls.push(`plan:${audit.repairableStaleLinkedApps}`);
        },
      },
    )).resolves.toBe(0);

    expect(calls).toEqual([
      'environment', 'dependencies', 'dependency-containment', 'continuity', 'bindings',
      'preflight:false', 'plan:1', 'disconnect',
    ]);
    expect(stdout.join('')).toBe(
      'Portal rebootability preflight complete: full-stack-apps=2 linked-apps=3 repairable-stale-links=1 app-api-bindings=4 dependency-containment=0\n',
    );
    expect(stderr).toEqual([]);
  });

  test('fails closed with bounded output and still disconnects', async () => {
    const calls: string[] = [];
    const stderr: string[] = [];

    await expect(portalRebootabilityPreflightMain(
      ['--env-file', '/opt/bridgesllm/portal/backend/.env.production'],
      {
        stdout: { write: () => true },
        stderr: { write: (value: string | Uint8Array) => { stderr.push(String(value)); return true; } },
      },
      {
        getUid: () => 0,
        loadEnvironment: () => undefined,
        loadDependencies: async () => ({
          preflightDependencyContainment: async () => ({ repairs: 0, projects: 0, pins: 0 }),
          preflightContinuity: async () => continuityAudit(0),
          preflightBindings: async () => ({ checkedApps: 0, blockers: [], warnings: [] }),
          preflightApps: async () => {
            throw new Error('private database detail');
          },
          disconnect: async () => { calls.push('disconnect'); },
        }),
      },
    )).resolves.toBe(1);

    expect(calls).toEqual(['disconnect']);
    expect(stderr.join('')).toBe('Portal rebootability preflight failed: STARTUP_STATE_REJECTED\n');
  });

  test('blocks missing id bindings, reports exact key names, and never runs App startup preflight', async () => {
    const calls: string[] = [];
    const stderr: string[] = [];

    await expect(portalRebootabilityPreflightMain(
      ['--env-file', '/opt/bridgesllm/portal/backend/.env.production'],
      {
        stdout: { write: () => true },
        stderr: { write: (value: string | Uint8Array) => { stderr.push(String(value)); return true; } },
      },
      {
        getUid: () => 0,
        loadEnvironment: () => undefined,
        loadDependencies: async () => ({
          preflightDependencyContainment: async () => ({ repairs: 0, projects: 0, pins: 0 }),
          preflightContinuity: async () => continuityAudit(1),
          preflightBindings: async () => ({
            checkedApps: 1,
            blockers: [{
              kind: 'missing-id-binding',
              appId: 'app-123',
              obsoleteNameKey: 'APP_API_TARGET_RATE_TOOL',
              requiredIdKey: 'APP_API_TARGET_APP_123',
            }],
            warnings: [],
          }),
          preflightApps: async () => {
            calls.push('preflight');
            return { apps: [] };
          },
          disconnect: async () => { calls.push('disconnect'); },
        }),
      },
    )).resolves.toBe(1);

    expect(calls).toEqual(['disconnect']);
    expect(stderr.join('')).toContain('APP_API_TARGET_RATE_TOOL');
    expect(stderr.join('')).toContain('APP_API_TARGET_APP_123');
    expect(stderr.join('')).toContain('APP_API_TARGET_BINDING_MIGRATION_REQUIRED');
    expect(stderr.join('')).toContain('did not copy or infer a value');
  });

  test('warns on redundant name keys without blocking', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(portalRebootabilityPreflightMain(
      ['--env-file', '/opt/bridgesllm/portal/backend/.env.production'],
      {
        stdout: { write: (value: string | Uint8Array) => { stdout.push(String(value)); return true; } },
        stderr: { write: (value: string | Uint8Array) => { stderr.push(String(value)); return true; } },
      },
      {
        getUid: () => 0,
        loadEnvironment: () => undefined,
        loadDependencies: async () => ({
          preflightDependencyContainment: async () => ({ repairs: 0, projects: 0, pins: 0 }),
          preflightContinuity: async () => continuityAudit(0),
          preflightBindings: async () => ({
            checkedApps: 1,
            blockers: [],
            warnings: [{
              kind: 'obsolete-name-binding',
              appId: 'app-123',
              obsoleteNameKey: 'APP_API_TARGET_RATE_TOOL',
              requiredIdKey: 'APP_API_TARGET_APP_123',
            }],
          }),
          preflightApps: async () => ({ apps: [] }),
          disconnect: async () => undefined,
        }),
      },
    )).resolves.toBe(0);

    expect(stderr.join('')).toContain('obsolete App API target key APP_API_TARGET_RATE_TOOL');
    expect(stderr.join('')).toContain('APP_API_TARGET_APP_123 is authoritative');
    expect(stdout.join('')).toContain('app-api-bindings=1');
  });

  test.each([
    ['a live repair', { repairs: 1, projects: 0, pins: 0 }],
    ['a contained Project with no linked App', { repairs: 0, projects: 1, pins: 0 }],
    ['a repair-owned backup pin without an App', { repairs: 0, projects: 0, pins: 1 }],
  ])('blocks downtime for %s before any App-scoped audit', async (_label, containment) => {
    const calls: string[] = [];
    const stderr: string[] = [];
    await expect(portalRebootabilityPreflightMain(
      ['--env-file', '/opt/bridgesllm/portal/backend/.env.production'],
      {
        stdout: { write: () => true },
        stderr: { write: (value: string | Uint8Array) => { stderr.push(String(value)); return true; } },
      },
      {
        getUid: () => 0,
        loadEnvironment: () => undefined,
        loadDependencies: async () => ({
          preflightDependencyContainment: async () => {
            calls.push('dependency-containment');
            throw new Error('PROJECT_DEPENDENCY_CONTAINMENT_ACTIVE');
          },
          preflightContinuity: async () => {
            calls.push('continuity');
            return continuityAudit(0);
          },
          preflightBindings: async () => {
            calls.push('bindings');
            return { checkedApps: 0, blockers: [], warnings: [] };
          },
          preflightApps: async () => {
            calls.push('apps');
            return { apps: [] };
          },
          disconnect: async () => { calls.push('disconnect'); },
        }),
      },
    )).resolves.toBe(1);
    expect(containment.repairs + containment.projects + containment.pins).toBeGreaterThan(0);
    expect(calls).toEqual(['dependency-containment', 'disconnect']);
    expect(stderr.join('')).toContain('PROJECT_DEPENDENCY_CONTAINMENT_ACTIVE');
  });

  describe('default dependency-containment pin classifier', () => {
    let root = '';

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-preflight-pin-'));
      fs.chmodSync(root, 0o700);
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    function fixture() {
      const ownerId = 'owner-a';
      const projectName = 'Project_A';
      const projectIdentityId = 'project-identity-a';
      const repairId = '11111111-1111-4111-8111-111111111111';
      const promotionOperationId = '22222222-2222-4222-8222-222222222222';
      const manifestDigest = 'a'.repeat(64);
      const ownerRoot = path.join(root, ownerId);
      const projectRoot = path.join(ownerRoot, projectName);
      fs.mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
      fs.chmodSync(ownerRoot, 0o700);
      fs.chmodSync(projectRoot, 0o700);
      const archive = path.join(root, 'portal-comprehensive-test.tar.gz');
      fs.writeFileSync(archive, 'archive', { mode: 0o600 });
      fs.chmodSync(archive, 0o600);
      const receipt = Buffer.from('{"receipt":true}\n', 'utf8');
      fs.writeFileSync(`${archive}.receipt.json`, receipt, { mode: 0o600 });
      fs.chmodSync(`${archive}.receipt.json`, 0o600);
      const stat = fs.lstatSync(archive, { bigint: true });
      const receiptDigest = crypto.createHash('sha256').update(receipt).digest('hex');
      const file = {
        filename: path.basename(archive),
        fullPath: archive,
        type: 'comprehensive',
        size: Number(stat.size),
        mtimeMs: Number(stat.mtimeNs) / 1_000_000,
        mtimeNs: stat.mtimeNs.toString(),
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        locked: true,
        completeness: 'complete',
        degradedComponents: [],
        classificationAuthenticated: true,
      };
      const fingerprintDigest = crypto.createHash('sha256').update(JSON.stringify({
        path: archive,
        filename: file.filename,
        device: file.dev,
        inode: file.ino,
        size: String(file.size),
        mtimeNs: file.mtimeNs,
        receiptDigest,
      }), 'utf8').digest('hex');
      const marker = {
        schemaVersion: 1,
        kind: 'bridgesllm.project-dependency-repair-backup-pin',
        repairId,
        backupFingerprintDigest: fingerprintDigest,
        projectIdentityId,
        projectIdentityGeneration: 3,
        workspaceOwnerId: ownerId,
        projectName,
        promotionOperationId,
        manifestDigest,
      };
      const markerBytes = Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8');
      fs.writeFileSync(`${archive}.locked`, markerBytes, { mode: 0o600 });
      fs.chmodSync(`${archive}.locked`, 0o600);
      return {
        ownerId, projectName, projectIdentityId, repairId, promotionOperationId,
        manifestDigest, ownerRoot, projectRoot, file, marker, receiptDigest,
        markerDigest: crypto.createHash('sha256').update(markerBytes).digest('hex'),
      };
    }

    function dependencies(value: ReturnType<typeof fixture>, queryResults: unknown[]) {
      return {
        database: {
          prisma: {
            $queryRaw: jest.fn()
              .mockImplementation(() => Promise.resolve(queryResults.shift())),
            systemSetting: { findUnique: jest.fn().mockResolvedValue({ value: root }) },
          },
        },
        backup: {
          getConfiguredBackupRootReadOnly: jest.fn(() => root),
          listBackupFiles: jest.fn(() => [value.file]),
          readRepairOwnedBackupLockMarker: jest.fn(() => value.marker),
        },
      };
    }

    test('allows an exact COMPLETE orphan while the updater owns the operation lock', async () => {
      const value = fixture();
      const basename = `.bridgesllm-project-repair-${value.repairId}`;
      const deps = dependencies(value, [
        [{ repairs: 0n, projects: 0n }],
        [{ relation: '"ProjectDependencyRepairOperation"' }],
        [{ repairs: 0n }],
        [{
          repairId: value.repairId,
          status: 'APPLIED',
          phase: 'COMPLETE',
          projectIdentityId: value.projectIdentityId,
          projectIdentityGeneration: 3,
          workspaceOwnerId: value.ownerId,
          projectName: value.projectName,
          promotionOperationId: value.promotionOperationId,
          manifestDigest: value.manifestDigest,
          backupFingerprintDigest: value.marker.backupFingerprintDigest,
          backupLockOwned: true,
          backupLockMarkerPath: `${value.file.fullPath}.locked`,
          backupLockMarkerDigest: value.markerDigest,
          backupPath: value.file.fullPath,
          backupFilename: value.file.filename,
          backupDevice: value.file.dev,
          backupInode: value.file.ino,
          backupSize: BigInt(value.file.size),
          backupMtimeNs: value.file.mtimeNs,
          backupReceiptDigest: value.receiptDigest,
          repairJournalCanonicalPath: path.join(value.ownerRoot, `${basename}.journal.json`),
          displacementCanonicalRoot: path.join(value.ownerRoot, basename),
          identityCanonicalRoot: value.projectRoot,
          lifecycleStatus: 'ACTIVE',
          dependencyQuarantinedAt: null,
          decisionExists: false,
        }],
      ]);
      const lock = await acquireBackupMutationLock({
        operationLockPath: path.join(root, 'installer.lock'),
        stateDirectory: path.join(root, 'backup-state'),
        timeoutSeconds: 2,
      });
      try {
        await expect(preflightDependencyContainmentReadOnly(deps as any)).resolves.toEqual({
          repairs: 0, projects: 0, pins: 0,
        });
      } finally {
        await lock.release();
      }
    });

    test('allows an exact marker-only pre-go-bit orphan while the updater owns the operation lock', async () => {
      const value = fixture();
      const ownerStat = fs.lstatSync(value.ownerRoot, { bigint: true });
      const deps = dependencies(value, [
        [{ repairs: 0n, projects: 1n }],
        [{ relation: '"ProjectDependencyRepairOperation"' }],
        [{ repairs: 0n }],
        [],
        [{
          projectIdentityId: value.projectIdentityId,
          decisionProjectIdentityId: value.projectIdentityId,
          workspaceOwnerId: value.ownerId,
          decisionWorkspaceOwnerId: value.ownerId,
          projectName: value.projectName,
          decisionProjectName: value.projectName,
          generation: 3,
          projectIdentityGeneration: 3,
          canonicalRoot: value.projectRoot,
          lifecycleStatus: 'DEPENDENCY_QUARANTINED',
          dependencyQuarantinedAt: new Date(),
          operationId: value.promotionOperationId,
          manifestDigest: value.manifestDigest,
          decisionStatus: 'AUTHORIZED',
          operationParentCanonicalRoot: value.ownerRoot,
          operationParentDevice: ownerStat.dev.toString(),
          operationParentInode: ownerStat.ino.toString(),
          operationParentBirthtimeNs: ownerStat.birthtimeNs.toString(),
          operationParentMode: Number(ownerStat.mode & 0o777n),
          operationParentUid: Number(ownerStat.uid),
          operationParentGid: Number(ownerStat.gid),
        }],
      ]);
      const lock = await acquireBackupMutationLock({
        operationLockPath: path.join(root, 'installer.lock'),
        stateDirectory: path.join(root, 'backup-state'),
        timeoutSeconds: 2,
      });
      try {
        await expect(preflightDependencyContainmentReadOnly(deps as any)).resolves.toEqual({
          repairs: 0, projects: 0, pins: 0,
        });
      } finally {
        await lock.release();
      }
    });

    test('fails closed for a recognizable tampered repair marker', async () => {
      const value = fixture();
      fs.writeFileSync(
        `${value.file.fullPath}.locked`,
        '{"kind":"bridgesllm.project-dependency-repair-backup-pin","repairId":"tampered"}\n',
        { mode: 0o600 },
      );
      const deps = dependencies(value, [
        [{ repairs: 0n, projects: 0n }],
        [{ relation: '"ProjectDependencyRepairOperation"' }],
        [{ repairs: 0n }],
        [{ exists: false }],
      ]);
      deps.backup.readRepairOwnedBackupLockMarker.mockReturnValue(null as any);
      await expect(preflightDependencyContainmentReadOnly(deps as any))
        .rejects.toThrow('PROJECT_DEPENDENCY_CONTAINMENT_ACTIVE');
    });

    test('fails closed for recognizable tampered repair evidence on a prior schema', async () => {
      const value = fixture();
      fs.writeFileSync(
        `${value.file.fullPath}.locked`,
        '{"kind":"bridgesllm.project-dependency-repair-backup-pin","repairId":"tampered"}\n',
        { mode: 0o600 },
      );
      const deps = dependencies(value, [
        [{ repairs: 0n, projects: 0n }],
        [{ relation: null }],
      ]);
      deps.backup.readRepairOwnedBackupLockMarker.mockReturnValue(null as any);
      await expect(preflightDependencyContainmentReadOnly(deps as any))
        .rejects.toThrow('PROJECT_DEPENDENCY_CONTAINMENT_ACTIVE');
    });
  });
});
