import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DATABASE_URL ||= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
process.env.JWT_SECRET ||= 'project-app-rebind-test-secret-that-is-long-enough';

const prismaMock = {
  app: { count: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  appShareLink: { findMany: jest.fn() },
  projectIdentity: { findUnique: jest.fn() },
  systemSetting: { findUnique: jest.fn(), deleteMany: jest.fn() },
  $transaction: jest.fn(),
};

jest.mock('../config/database', () => ({ prisma: prismaMock }));

import { attestProjectRoot, type ProjectIdentityRecord } from './projectIdentity';
import {
  assertProjectMigrationTargetOwnedByOperation,
  beginProjectCopyOperation,
  bindProjectAppRebindTarget,
  ProjectAppIdentityRebindError,
  readProjectAppRebindOperation,
  recordProjectAppRebindManifest,
  rebindLegacyProjectAppToCurrentCopy,
} from './projectAppIdentityRebind';
import {
  buildProjectLegacyAdoptionManifest,
  prepareProjectLegacyAdoptionStaging,
  verifyProjectLegacyAdoptionManifestSummary,
} from './projectLegacyAdoption';

function identity(id: string, owner: string, name: string, root: string, current: boolean): ProjectIdentityRecord {
  const attested = attestProjectRoot(root);
  return {
    id,
    workspaceOwnerId: owner,
    projectName: name,
    canonicalRoot: attested.canonicalRoot,
    rootDevice: attested.rootDevice,
    rootInode: attested.rootInode,
    rootBirthtimeNs: attested.rootBirthtimeNs,
    generation: 1,
    lifecycleStatus: 'ACTIVE',
    legacyOpenClawMigrationStatus: current ? 'CURRENT' : 'NONE',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  };
}

function runtimeLock(retirePersistedState: jest.Mock = jest.fn(async () => undefined)): any {
  return async (_input: unknown, work: (lease: { retirePersistedState(): Promise<void> }) => Promise<unknown>) => (
    work({ retirePersistedState })
  );
}

function fixture(options: { owner?: string; deployType?: string; processStatus?: string; quarantined?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-app-rebind-'));
  const owner = options.owner || 'owner-1';
  const sourceName = 'legacy';
  const targetName = 'legacy_Portal4_abcd';
  const sourceProjectRoot = path.join(root, 'projects', sourceName);
  const targetProjectRoot = path.join(root, 'projects', targetName);
  const deployRoot = path.join(root, 'apps');
  const sourceDeployPath = path.join(deployRoot, `${owner}-${sourceName}`);
  const targetDeployPath = path.join(deployRoot, `${owner}-${targetName}`);
  const journalRoot = path.join(root, 'journal');
  for (const directory of [sourceProjectRoot, targetProjectRoot, sourceDeployPath]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(sourceProjectRoot, 'README.md'), 'legacy project\n');
  fs.writeFileSync(path.join(targetProjectRoot, 'README.md'), 'current project\n');
  fs.writeFileSync(path.join(sourceDeployPath, 'server.js'), 'console.log("stable")\n');
  const source = identity('source-id', owner, sourceName, sourceProjectRoot, false);
  const target = identity('target-id', owner, targetName, targetProjectRoot, true);
  const shares = [
    { id: 'share-1', token: 'token-one' },
    { id: 'share-2', token: 'token-two' },
  ];
  const app: any = {
    id: 'app-1',
    userId: owner,
    projectIdentityId: options.quarantined ? null : source.id,
    name: options.quarantined ? targetName : sourceName,
    zipPath: sourceDeployPath,
    deployType: options.deployType || 'static',
    processStatus: options.processStatus || 'stopped',
    updatedAt: new Date('2026-08-02T00:00:00Z'),
  };
  const updateMany = jest.fn(async ({ where, data }: any) => {
    if (
      where.id !== app.id
      || where.userId !== app.userId
      || where.projectIdentityId !== app.projectIdentityId
      || where.name !== app.name
      || where.zipPath !== app.zipPath
      || where.deployType !== app.deployType
      || where.processStatus !== app.processStatus
      || where.updatedAt.getTime() !== app.updatedAt.getTime()
    ) return { count: 0 };
    Object.assign(app, data, { updatedAt: new Date(app.updatedAt.getTime() + 1_000) });
    return { count: 1 };
  });
  const database: any = {
    projectIdentity: {
      findUnique: jest.fn(async ({ where }: any) => (
        where.id === source.id ? source : where.id === target.id ? target : null
      )),
    },
    app: {
      findMany: jest.fn(async () => [{ ...app }]),
      count: jest.fn(async () => 0),
      updateMany,
      findUnique: jest.fn(async () => ({ ...app })),
    },
    appShareLink: {
      findMany: jest.fn(async () => shares.map((share) => ({ ...share }))),
    },
    $transaction: jest.fn(async (work: (transaction: any) => Promise<unknown>) => work(database)),
  };
  const input = {
    workspaceOwnerId: owner,
    appId: app.id,
    sourceProjectIdentityId: source.id,
    sourceProjectName: sourceName,
    sourceAppName: app.name,
    sourceProjectRoot,
    sourceDeployPath,
    targetProjectIdentityId: target.id,
    targetProjectName: targetName,
    targetProjectRoot,
    targetDeployPath,
  };
  return {
    root,
    owner,
    source,
    target,
    app,
    shares,
    database,
    updateMany,
    input,
    journalRoot,
    sourceDeployPath,
    targetDeployPath,
  };
}

describe('legacy Project App identity rebind', () => {
  test('publishes journals inside required Portal state and recovers an interrupted two-link create', () => {
    const f = fixture();
    const previousPortalRoot = process.env.PORTAL_ROOT;
    const previousJournalRoot = process.env.PORTAL_PROJECT_APP_REBIND_ROOT;
    delete process.env.PORTAL_PROJECT_APP_REBIND_ROOT;
    process.env.PORTAL_ROOT = path.join(f.root, 'portal');
    fs.mkdirSync(process.env.PORTAL_ROOT, { recursive: true });
    try {
      const journal = beginProjectCopyOperation({
        workspaceOwnerId: f.owner,
        sourceProjectIdentityId: f.source.id,
        sourceProjectName: f.source.projectName,
        sourceProjectRoot: f.source.canonicalRoot,
        sourceDeployPath: f.sourceDeployPath,
        targetProjectName: f.target.projectName,
        targetProjectRoot: f.target.canonicalRoot,
        targetDeployPath: f.targetDeployPath,
      });
      const root = path.join(process.env.PORTAL_ROOT, '.data', 'project-app-rebind');
      const files = fs.readdirSync(root);
      expect(files).toHaveLength(1);
      const file = path.join(root, files[0]);
      const unrelatedTemp = path.join(root, `.${files[0]}.${process.pid}.orphan.tmp`);
      fs.writeFileSync(unrelatedTemp, '{}\n', { mode: 0o600 });
      const interruptedTemp = path.join(root, `.${files[0]}.${process.pid}.deadbeef.tmp`);
      fs.linkSync(file, interruptedTemp);
      expect(fs.statSync(file).nlink).toBe(2);

      expect(readProjectAppRebindOperation({
        workspaceOwnerId: f.owner,
        sourceProjectIdentityId: f.source.id,
        sourceProjectName: f.source.projectName,
        sourceProjectRoot: f.source.canonicalRoot,
      })).toEqual(journal);
      expect(fs.existsSync(interruptedTemp)).toBe(false);
      expect(fs.existsSync(unrelatedTemp)).toBe(true);
      expect(fs.statSync(file).nlink).toBe(1);
      const backup = fs.readFileSync(path.resolve(__dirname, '../../../backup-full.sh'), 'utf8');
      expect(backup).toContain('archive_required_component portal-state "$PORTAL_STATE_DIR"');
    } finally {
      if (previousPortalRoot === undefined) delete process.env.PORTAL_ROOT;
      else process.env.PORTAL_ROOT = previousPortalRoot;
      if (previousJournalRoot === undefined) delete process.env.PORTAL_PROJECT_APP_REBIND_ROOT;
      else process.env.PORTAL_PROJECT_APP_REBIND_ROOT = previousJournalRoot;
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('a Project-only retry keeps the same target receipt and rejects an intervening claimant', () => {
    const f = fixture();
    try {
      const operation = beginProjectCopyOperation({
        workspaceOwnerId: f.owner,
        sourceProjectIdentityId: f.source.id,
        sourceProjectName: f.source.projectName,
        sourceProjectRoot: f.source.canonicalRoot,
        sourceDeployPath: f.sourceDeployPath,
        targetProjectName: f.target.projectName,
        targetProjectRoot: f.target.canonicalRoot,
        targetDeployPath: f.targetDeployPath,
      }, { journalRoot: f.journalRoot });
      const fullManifest = buildProjectLegacyAdoptionManifest(f.target.canonicalRoot);
      recordProjectAppRebindManifest({
        sourceProjectIdentityId: f.source.id,
        manifest: {
          fileCount: fullManifest.fileCount,
          totalBytes: fullManifest.totalBytes,
          sha256: fullManifest.sha256,
        },
      }, { journalRoot: f.journalRoot });
      bindProjectAppRebindTarget({
        sourceProjectIdentityId: f.source.id,
        targetProjectIdentityId: operation.operationId,
      }, { journalRoot: f.journalRoot });
      const afterProcessDeath = readProjectAppRebindOperation({
        workspaceOwnerId: f.owner,
        sourceProjectIdentityId: f.source.id,
        sourceProjectName: f.source.projectName,
        sourceProjectRoot: f.source.canonicalRoot,
      }, { journalRoot: f.journalRoot });
      expect(afterProcessDeath).toEqual(expect.objectContaining({
        operationId: operation.operationId,
        targetProjectName: f.target.projectName,
        targetProjectRoot: f.target.canonicalRoot,
        targetProjectIdentityId: operation.operationId,
      }));
      expect(() => assertProjectMigrationTargetOwnedByOperation(operation, {
        id: 'intervening-project-id',
        workspaceOwnerId: f.owner,
        projectName: f.target.projectName,
      })).toThrow('Another Project claimed the durable migration target');
      expect(() => assertProjectMigrationTargetOwnedByOperation(operation, {
        id: operation.operationId,
        workspaceOwnerId: f.owner,
        projectName: f.target.projectName,
      })).not.toThrow();
      const interruptedStaging = path.join(
        f.root,
        'projects',
        '.bridgesllm-project-creation-staging',
        `app-rebind-${operation.operationId}`,
      );
      fs.mkdirSync(interruptedStaging, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(interruptedStaging, 'partial-copy.tmp'), 'partial');
      const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
      const routeStart = routeSource.indexOf("router.post('/:name/chat/migrate-legacy'");
      const routeEnd = routeSource.indexOf("router.get('/:name/chat/providers'", routeStart);
      const route = routeSource.slice(routeStart, routeEnd);
      const partialRecovery = route.indexOf('&& !operation?.projectManifest');
      expect(partialRecovery).toBeGreaterThan(0);
      expect(route.indexOf('attestProjectRoot(durableStagingRoot)', partialRecovery)).toBeGreaterThan(partialRecovery);
      expect(route.indexOf('fs.rmSync(durableStagingRoot', partialRecovery)).toBeGreaterThan(partialRecovery);
      expect(route.indexOf('createProjectAppRebindStagingDirectory(operation.operationId)', partialRecovery))
        .toBeGreaterThan(partialRecovery);
      const creatingRecovery = route.indexOf('currentIdentity.id === operation.operationId');
      expect(creatingRecovery).toBeGreaterThan(0);
      expect(route.indexOf('verifyProjectLegacyAdoptionManifestSummary(', creatingRecovery))
        .toBeGreaterThan(creatingRecovery);
      expect(route.indexOf('moveAttestedDirectoryNoReplace({', creatingRecovery))
        .toBeGreaterThan(creatingRecovery);
      expect(route.indexOf('finalizeCurrentProjectIdentityCreation({', creatingRecovery))
        .toBeGreaterThan(creatingRecovery);
      expect(() => verifyProjectLegacyAdoptionManifestSummary(
        f.target.canonicalRoot,
        afterProcessDeath!.projectManifest!,
      )).not.toThrow();
      fs.writeFileSync(path.join(f.target.canonicalRoot, 'README.md'), 'hijacked target\n');
      expect(() => verifyProjectLegacyAdoptionManifestSummary(
        f.target.canonicalRoot,
        afterProcessDeath!.projectManifest!,
      )).toThrow('published Project copy changed');
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('recopies a missing journaled Project stage and admits only the durable manifest', () => {
    const f = fixture();
    const stagingRoot = path.join(f.root, 'projects', 'durable-retry-stage');
    const durable = buildProjectLegacyAdoptionManifest(f.source.canonicalRoot);
    const summary = {
      fileCount: durable.fileCount,
      totalBytes: durable.totalBytes,
      sha256: durable.sha256,
    };
    try {
      // This is the retry window: the journal survived, but catch cleanup (or
      // process-death cleanup) removed the old staged inode. The route has just
      // recreated an empty deterministic staging directory.
      fs.mkdirSync(stagingRoot, { mode: 0o700 });
      const recovered = prepareProjectLegacyAdoptionStaging({
        sourceRoot: f.source.canonicalRoot,
        stagingRoot,
        stagedCopyExisted: false,
        durableManifest: summary,
      });
      expect(recovered).toEqual(expect.objectContaining(summary));
      expect(fs.readFileSync(path.join(stagingRoot, 'README.md'), 'utf8')).toBe('legacy project\n');

      // A surviving staged copy is verified rather than copied over.
      expect(prepareProjectLegacyAdoptionStaging({
        sourceRoot: f.source.canonicalRoot,
        stagingRoot,
        stagedCopyExisted: true,
        durableManifest: summary,
      })).toEqual(expect.objectContaining(summary));

      // Rebuilding after the source changed must not silently replace the
      // snapshot whose digest was already committed to the durable journal.
      fs.rmSync(stagingRoot, { recursive: true });
      fs.mkdirSync(stagingRoot, { mode: 0o700 });
      fs.writeFileSync(path.join(f.source.canonicalRoot, 'README.md'), 'changed after receipt\n');
      expect(() => prepareProjectLegacyAdoptionStaging({
        sourceRoot: f.source.canonicalRoot,
        stagingRoot,
        stagedCopyExisted: false,
        durableManifest: summary,
      })).toThrow('published Project copy changed');
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('CAS-rebinds the same App id, retires stopped runtime evidence first, and preserves shares', async () => {
    const f = fixture();
    const retire = jest.fn(async () => undefined);
    f.updateMany.mockImplementationOnce(async (args: any) => {
      expect(retire).toHaveBeenCalledTimes(1);
      const { where, data } = args;
      if (where.updatedAt.getTime() !== f.app.updatedAt.getTime()) return { count: 0 };
      Object.assign(f.app, data, { updatedAt: new Date(f.app.updatedAt.getTime() + 1_000) });
      return { count: 1 };
    });
    try {
      await expect(rebindLegacyProjectAppToCurrentCopy(f.input, {
        database: f.database,
        journalRoot: f.journalRoot,
        runtimeLock: runtimeLock(retire),
      })).resolves.toEqual({ appId: f.app.id, shareLinksPreserved: 2 });

      expect(f.app).toEqual(expect.objectContaining({
        projectIdentityId: f.target.id,
        name: f.target.projectName,
        zipPath: f.targetDeployPath,
      }));
      expect(fs.readFileSync(path.join(f.targetDeployPath, 'server.js'), 'utf8')).toContain('stable');
      expect(readProjectAppRebindOperation({
        workspaceOwnerId: f.owner,
        sourceProjectIdentityId: f.source.id,
        sourceProjectName: f.source.projectName,
        sourceProjectRoot: f.source.canonicalRoot,
      }, { journalRoot: f.journalRoot })).toEqual(expect.objectContaining({
        stage: 'COMPLETED',
        shareLinksPreserved: 2,
      }));
      expect(f.shares).toHaveLength(2);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('refuses a running Portal-managed App without mutating its row', async () => {
    const f = fixture({ deployType: 'fullstack', processStatus: 'running' });
    try {
      await expect(rebindLegacyProjectAppToCurrentCopy(f.input, {
        database: f.database,
        journalRoot: f.journalRoot,
        runtimeLock: runtimeLock(),
      })).rejects.toBeInstanceOf(ProjectAppIdentityRebindError);
      expect(f.updateMany).not.toHaveBeenCalled();
      expect(f.app.projectIdentityId).toBe(f.source.id);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('recovers the confirmed quarantined shape into one CURRENT target', async () => {
    const f = fixture({ deployType: 'fullstack', processStatus: 'error', quarantined: true });
    try {
      await expect(rebindLegacyProjectAppToCurrentCopy(f.input, {
        database: f.database,
        journalRoot: f.journalRoot,
        runtimeLock: runtimeLock(),
      })).resolves.toEqual({ appId: f.app.id, shareLinksPreserved: 2 });
      expect(f.app).toEqual(expect.objectContaining({
        projectIdentityId: f.target.id,
        name: f.target.projectName,
        zipPath: f.targetDeployPath,
        processStatus: 'error',
      }));
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('converges an exact retry after death between deployment rename and journal update', async () => {
    const f = fixture();
    let killed = false;
    try {
      await expect(rebindLegacyProjectAppToCurrentCopy(f.input, {
        database: f.database,
        journalRoot: f.journalRoot,
        runtimeLock: runtimeLock(),
        testCheckpoint: (stage) => {
          if (stage === 'DEPLOYMENT_PROMOTED' && !killed) {
            killed = true;
            throw new Error('simulated process death');
          }
        },
      })).rejects.toThrow('simulated process death');
      const promotedIdentity = attestProjectRoot(f.targetDeployPath);
      expect(f.app.projectIdentityId).toBe(f.source.id);

      await expect(rebindLegacyProjectAppToCurrentCopy(f.input, {
        database: f.database,
        journalRoot: f.journalRoot,
        runtimeLock: runtimeLock(),
      })).resolves.toEqual({ appId: f.app.id, shareLinksPreserved: 2 });
      expect(attestProjectRoot(f.targetDeployPath)).toEqual(promotedIdentity);
      expect(fs.readdirSync(path.dirname(f.targetDeployPath)).filter((entry) => (
        entry.includes(`.${path.basename(f.targetDeployPath)}.deploy-`)
      ))).toEqual([]);
      expect(f.updateMany).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('converges an exact retry after DB commit but before the durable receipt', async () => {
    const f = fixture();
    let killed = false;
    try {
      await expect(rebindLegacyProjectAppToCurrentCopy(f.input, {
        database: f.database,
        journalRoot: f.journalRoot,
        runtimeLock: runtimeLock(),
        testCheckpoint: (stage) => {
          if (stage === 'APP_COMMITTED' && !killed) {
            killed = true;
            throw new Error('simulated process death');
          }
        },
      })).rejects.toThrow('simulated process death');
      expect(f.app.projectIdentityId).toBe(f.target.id);
      expect(f.updateMany).toHaveBeenCalledTimes(1);

      await expect(rebindLegacyProjectAppToCurrentCopy(f.input, {
        database: f.database,
        journalRoot: f.journalRoot,
        runtimeLock: runtimeLock(),
      })).resolves.toEqual({ appId: f.app.id, shareLinksPreserved: 2 });
      expect(f.updateMany).toHaveBeenCalledTimes(1);
      expect(readProjectAppRebindOperation({
        workspaceOwnerId: f.owner,
        sourceProjectIdentityId: f.source.id,
        sourceProjectName: f.source.projectName,
        sourceProjectRoot: f.source.canonicalRoot,
      }, { journalRoot: f.journalRoot })?.stage).toBe('COMPLETED');
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  test.each(['DEPLOYMENT_PROMOTED', 'APP_COMMITTED'] as const)(
    'survives real SIGKILL at %s and resumes the same operation in a fresh process',
    (checkpoint) => {
      const f = fixture();
      const stateFile = path.join(f.root, 'fixture-state.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        app: { ...f.app, updatedAt: f.app.updatedAt.toISOString() },
        source: { ...f.source, createdAt: f.source.createdAt.toISOString(), updatedAt: f.source.updatedAt.toISOString() },
        target: { ...f.target, createdAt: f.target.createdAt.toISOString(), updatedAt: f.target.updatedAt.toISOString() },
        shares: f.shares,
        runtimeRetired: false,
      }));
      const config = JSON.stringify({ stateFile, input: f.input, journalRoot: f.journalRoot, checkpoint });
      const command = [
        '-r', 'ts-node/register/transpile-only',
        path.join(__dirname, 'projectAppIdentityRebind.crash-fixture.ts'),
      ];
      const killed = spawnSync(process.execPath, command, {
        cwd: path.resolve(__dirname, '../..'),
        env: { ...process.env, NODE_ENV: 'test', PROJECT_APP_REBIND_CRASH_FIXTURE: config },
        timeout: 30_000,
      });
      expect(killed.signal).toBe('SIGKILL');

      const recovered = spawnSync(process.execPath, command, {
        cwd: path.resolve(__dirname, '../..'),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PROJECT_APP_REBIND_CRASH_FIXTURE: JSON.stringify({
            stateFile,
            input: f.input,
            journalRoot: f.journalRoot,
            checkpoint: null,
          }),
        },
        encoding: 'utf8',
        timeout: 30_000,
      });
      try {
        expect(recovered.status).toBe(0);
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        expect(state.app).toEqual(expect.objectContaining({
          id: f.app.id,
          projectIdentityId: f.target.id,
          name: f.target.projectName,
          zipPath: f.targetDeployPath,
        }));
        expect(state.runtimeRetired).toBe(true);
        expect(fs.existsSync(f.targetDeployPath)).toBe(true);
        expect(readProjectAppRebindOperation({
          workspaceOwnerId: f.owner,
          sourceProjectIdentityId: f.source.id,
          sourceProjectName: f.source.projectName,
          sourceProjectRoot: f.source.canonicalRoot,
        }, { journalRoot: f.journalRoot })?.stage).toBe('COMPLETED');
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
