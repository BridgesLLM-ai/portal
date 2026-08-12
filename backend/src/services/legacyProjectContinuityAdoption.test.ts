import fs from 'fs';
import os from 'os';
import path from 'path';
import { attestProjectRoot, type ProjectIdentityRecord } from './projectIdentity';
import {
  auditLegacyProjectContinuityReadiness,
  initializeLegacyProjectContinuityAdoption,
  LegacyProjectContinuityAdoptionError,
  repairLegacyProjectContinuityLinks,
} from './legacyProjectContinuityAdoption';

function makeIdentity(
  workspaceOwnerId: string,
  projectName: string,
  projectRoot: string,
  index: number,
): ProjectIdentityRecord {
  const root = attestProjectRoot(projectRoot);
  return {
    id: `legacy-identity-${String(index).padStart(3, '0')}`,
    workspaceOwnerId,
    projectName,
    canonicalRoot: root.canonicalRoot,
    rootDevice: root.rootDevice,
    rootInode: root.rootInode,
    rootBirthtimeNs: root.rootBirthtimeNs,
    generation: 1,
    lifecycleStatus: 'ACTIVE',
    legacyOpenClawMigrationStatus: 'NONE',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  };
}

function makeDatabase(input: {
  ownerId: string;
  apps: any[];
  identities: Map<string, ProjectIdentityRecord>;
  operations: string[];
  beforeTransaction?: () => void;
}) {
  const projectIdentity = {
    findUnique: jest.fn(async ({ where }: any) => {
      const compound = where.workspaceOwnerId_projectName;
      if (compound) return input.identities.get(`${compound.workspaceOwnerId}\0${compound.projectName}`) || null;
      for (const identity of input.identities.values()) {
        if (identity.id === where.id) return identity;
      }
      return null;
    }),
  };
  const database: any = {
    user: {
      findMany: jest.fn(async () => [{ id: input.ownerId }]),
    },
    projectIdentity,
    app: {
      findMany: jest.fn(async (args: any) => {
        const rows = input.apps.filter((app) => (
          args?.where?.projectIdentityId?.not === null
            ? app.projectIdentityId !== null
            : true
        ));
        if (args?.orderBy?.id === 'asc') rows.sort((left, right) => left.id.localeCompare(right.id));
        return rows.map((app) => ({ ...app }));
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const app = input.apps.find((candidate) => candidate.id === where.id);
        if (data.projectIdentityId === null) {
          if (
            !app
            || app.userId !== where.userId
            || app.projectIdentityId !== where.projectIdentityId
            || app.name !== where.name
            || app.zipPath !== where.zipPath
            || app.deployType !== where.deployType
            || app.processStatus !== where.processStatus
          ) return { count: 0 };
          input.operations.push(`quarantine:${app.id}:${data.processStatus || app.processStatus}`);
          app.projectIdentityId = null;
          if (data.processStatus) app.processStatus = data.processStatus;
          return { count: 1 };
        }
        if (
          !app
          || app.userId !== where.userId
          || app.name !== where.name
          || app.zipPath !== where.zipPath
          || app.projectIdentityId !== null
        ) return { count: 0 };
        input.operations.push(`app:${app.id}:${app.processStatus}`);
        app.projectIdentityId = data.projectIdentityId;
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(async (work: (transaction: any) => Promise<unknown>) => {
      input.beforeTransaction?.();
      return work(database);
    }),
  };
  return database;
}

describe('Portal 3.x Project/App startup continuity', () => {
  let temporaryRoot: string;
  let projectsRoot: string;
  let deployRoot: string;
  let legacyDeployRoot: string;
  let desktopRuntimeRoot: string;
  const ownerId = '11111111-2222-4333-8444-555555555555';

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-project-continuity-'));
    projectsRoot = path.join(temporaryRoot, 'projects');
    deployRoot = path.join(temporaryRoot, 'apps');
    legacyDeployRoot = path.join(temporaryRoot, 'legacy-hosted-apps');
    desktopRuntimeRoot = path.join(temporaryRoot, 'desktop-runtime');
    fs.mkdirSync(path.join(projectsRoot, ownerId), { recursive: true });
    fs.mkdirSync(deployRoot, { recursive: true });
    fs.mkdirSync(legacyDeployRoot, { recursive: true });
    fs.mkdirSync(desktopRuntimeRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test('covers a mixed current, legacy, full-stack, and standalone App inventory without promoting legacy roots', async () => {
    const identities = new Map<string, ProjectIdentityRecord>();
    const operations: string[] = [];
    const apps: any[] = [];
    const ownerRoot = path.join(projectsRoot, ownerId);

    for (let index = 0; index < 9; index += 1) {
      const projectName = `project-${String(index).padStart(2, '0')}`;
      const projectRoot = path.join(ownerRoot, projectName);
      fs.mkdirSync(projectRoot);
      fs.writeFileSync(path.join(projectRoot, 'state.txt'), `project ${index}\n`);
    }
    fs.mkdirSync(path.join(ownerRoot, '.bridgesllm-lifecycle-quarantine'));
    fs.mkdirSync(path.join(projectsRoot, 'orphaned-owner', 'preserved-project'), { recursive: true });

    for (let index = 0; index < 9; index += 1) {
      const currentManaged = index < 5;
      const legacyManaged = index >= 5 && index < 7;
      const fullstack = index < 2 || index === 5;
      let name: string;
      let zipPath: string;
      if (currentManaged) {
        name = index < 4
          ? `project-${String(index).padStart(2, '0')}`
          : 'standalone-00';
        zipPath = path.join(deployRoot, `${ownerId}-${name}`);
      } else if (legacyManaged) {
        name = index === 5 ? 'project-04' : 'standalone-01';
        zipPath = path.join(legacyDeployRoot, `${ownerId}-${name}`);
      } else {
        // One desktop runtime row happens to share a Project owner/name and one
        // does not. Neither is a hosted-App deployment, so both stay nullable.
        name = index === 7 ? 'project-02' : 'standalone-02';
        zipPath = path.join(desktopRuntimeRoot, `runtime-${index}`);
      }
      fs.mkdirSync(zipPath);
      apps.push({
        id: `app-${String(index).padStart(2, '0')}`,
        userId: ownerId,
        projectIdentityId: null,
        name,
        zipPath,
        deployType: fullstack ? 'fullstack' : (index >= 27 ? 'desktop' : 'static'),
        processStatus: index === 0 || index >= 27 ? 'running' : 'stopped',
      });
    }

    const database = makeDatabase({ ownerId, apps, identities, operations });
    const ensureIdentity = jest.fn(async ({ workspaceOwnerId, projectName, projectRoot }: any) => {
      const key = `${workspaceOwnerId}\0${projectName}`;
      let identity = identities.get(key);
      if (!identity) {
        identity = makeIdentity(workspaceOwnerId, projectName, projectRoot, identities.size);
        identities.set(key, identity);
      }
      operations.push(`identity:${projectName}:${identity.legacyOpenClawMigrationStatus}`);
      return identity;
    });

    const result = await initializeLegacyProjectContinuityAdoption({
      projectsRoot,
      deployRoot,
      legacyDeployRoot,
      database,
      ensureIdentity: ensureIdentity as any,
    });

    expect(result).toEqual({
      projectsFound: 9,
      identitiesEnrolled: 9,
      appsBackfilled: 5,
      appsAlreadyAssociated: 0,
      appsLeftStandalone: 4,
      appsQuarantined: 0,
      ignoredInternalDirectories: 1,
      preservedUnownedDirectories: 1,
    });
    expect(identities.size).toBe(9);
    expect(Array.from(identities.values()).every(
      (identity) => identity.legacyOpenClawMigrationStatus === 'NONE',
    )).toBe(true);
    expect(apps.filter((app) => app.projectIdentityId !== null)).toHaveLength(5);
    expect(apps.filter((app) => app.deployType === 'fullstack').every(
      (app) => app.projectIdentityId !== null,
    )).toBe(true);
    expect(apps.filter((app) => app.projectIdentityId === null)).toHaveLength(4);
    expect(apps.slice(7).every((app) => app.projectIdentityId === null)).toBe(true);
    expect(apps[0]).toEqual(expect.objectContaining({
      processStatus: 'running',
      projectIdentityId: identities.get(`${ownerId}\0project-00`)!.id,
    }));

    const firstAppMutation = operations.findIndex((operation) => operation.startsWith('app:'));
    const lastIdentityEnrollment = operations.reduce(
      (latest, operation, index) => operation.startsWith('identity:') ? index : latest,
      -1,
    );
    expect(firstAppMutation).toBeGreaterThan(lastIdentityEnrollment);
    expect(operations[firstAppMutation]).toBe('app:app-00:running');
  });

  test('leaves a same-name standalone App nullable when its path is not the exact managed deployment', async () => {
    const identities = new Map<string, ProjectIdentityRecord>();
    const operations: string[] = [];
    const projectName = 'same-name';
    const projectRoot = path.join(projectsRoot, ownerId, projectName);
    fs.mkdirSync(projectRoot);
    const exactPath = path.join(deployRoot, `${ownerId}-${projectName}`);
    const unrelatedPath = path.join(temporaryRoot, 'unrelated-standalone');
    fs.mkdirSync(exactPath);
    fs.mkdirSync(unrelatedPath);
    const apps = [
      {
        id: 'exact-app', userId: ownerId, projectIdentityId: null, name: projectName,
        zipPath: exactPath, deployType: 'fullstack', processStatus: 'running',
      },
      {
        id: 'standalone-app', userId: ownerId, projectIdentityId: null, name: projectName,
        zipPath: unrelatedPath, deployType: 'static', processStatus: 'stopped',
      },
    ];
    const database = makeDatabase({ ownerId, apps, identities, operations });
    const ensureIdentity = jest.fn(async (input: any) => {
      const identity = makeIdentity(input.workspaceOwnerId, input.projectName, input.projectRoot, 1);
      identities.set(`${input.workspaceOwnerId}\0${input.projectName}`, identity);
      return identity;
    });

    const result = await initializeLegacyProjectContinuityAdoption({
      projectsRoot,
      deployRoot,
      legacyDeployRoot,
      database,
      ensureIdentity: ensureIdentity as any,
    });

    expect(result.appsBackfilled).toBe(1);
    expect(apps[0].projectIdentityId).toBe(identities.get(`${ownerId}\0${projectName}`)!.id);
    expect(apps[1].projectIdentityId).toBeNull();
  });

  test('read-only audit seals exact stale links, update repair quarantines them, and boot never rebinds them', async () => {
    const identities = new Map<string, ProjectIdentityRecord>();
    const operations: string[] = [];
    const apps: any[] = [];
    const projects = [
      { name: 'portal-stale_v4', appId: 'portal-stale', deployType: 'fullstack', status: 'running' },
      { name: 'static-stale_v4', appId: 'static-stale', deployType: 'static', status: 'stopped' },
      { name: 'external-stale_v4', appId: 'external-stale', deployType: 'fullstack', status: 'running' },
    ];
    const priorExternalTarget = process.env.APP_API_TARGET_EXTERNAL_STALE;
    process.env.APP_API_TARGET_EXTERNAL_STALE = 'http://127.0.0.1:5999';
    for (const [index, fixture] of projects.entries()) {
      const projectRoot = path.join(projectsRoot, ownerId, fixture.name);
      const oldDeployPath = path.join(deployRoot, `${ownerId}-${fixture.name.replace(/_v4$/, '')}`);
      fs.mkdirSync(projectRoot, { recursive: true });
      fs.mkdirSync(oldDeployPath, { recursive: true });
      const identity = makeIdentity(ownerId, fixture.name, projectRoot, index);
      identities.set(`${ownerId}\0${fixture.name}`, identity);
      apps.push({
        id: fixture.appId,
        userId: ownerId,
        projectIdentityId: identity.id,
        name: fixture.name,
        zipPath: oldDeployPath,
        deployType: fixture.deployType,
        processStatus: fixture.status,
      });
    }
    const database = makeDatabase({ ownerId, apps, identities, operations });
    const ensureIdentity = jest.fn(async ({ workspaceOwnerId, projectName }: any) => (
      identities.get(`${workspaceOwnerId}\0${projectName}`)!
    ));

    try {
      const audit = await auditLegacyProjectContinuityReadiness({
        deployRoot,
        legacyDeployRoot,
        database,
      });
      expect(audit).toEqual(expect.objectContaining({
        linkedApps: 3,
        staleLinkedApps: 3,
        repairableStaleLinkedApps: 3,
        repairPlanToken: expect.stringMatching(/^[a-f0-9]{64}$/),
      }));
      expect(operations).toEqual([]);
      expect(database.app.updateMany).not.toHaveBeenCalled();

      await expect(repairLegacyProjectContinuityLinks({
        expectedPlanToken: audit.repairPlanToken,
        deployRoot,
        legacyDeployRoot,
        database,
      })).resolves.toEqual({
        appsQuarantined: 3,
        quarantinedAppIds: ['external-stale', 'portal-stale', 'static-stale'],
      });

      const result = await initializeLegacyProjectContinuityAdoption({
        projectsRoot,
        deployRoot,
        legacyDeployRoot,
        database,
        ensureIdentity: ensureIdentity as any,
      });

      expect(result).toEqual(expect.objectContaining({
        appsQuarantined: 0,
        appsBackfilled: 0,
        appsLeftStandalone: 3,
      }));
      expect(apps.map((app) => app.projectIdentityId)).toEqual([null, null, null]);
      expect(apps.map((app) => app.processStatus)).toEqual(['error', 'stopped', 'running']);
      expect(operations).toEqual([
        'quarantine:external-stale:running',
        'quarantine:portal-stale:error',
        'quarantine:static-stale:stopped',
      ]);
    } finally {
      if (priorExternalTarget === undefined) delete process.env.APP_API_TARGET_EXTERNAL_STALE;
      else process.env.APP_API_TARGET_EXTERNAL_STALE = priorExternalTarget;
    }
  });

  test('never backfills a nullable App into an identity that existed before this boot', async () => {
    const projectName = 'already-enrolled';
    const projectRoot = path.join(projectsRoot, ownerId, projectName);
    const deployPath = path.join(deployRoot, `${ownerId}-${projectName}`);
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(deployPath);
    const identity = makeIdentity(ownerId, projectName, projectRoot, 1);
    const identities = new Map([[`${ownerId}\0${projectName}`, identity]]);
    const operations: string[] = [];
    const apps = [{
      id: 'nullable-existing-app',
      userId: ownerId,
      projectIdentityId: null,
      name: projectName,
      zipPath: deployPath,
      deployType: 'fullstack',
      processStatus: 'stopped',
    }];
    const database = makeDatabase({ ownerId, apps, identities, operations });

    const result = await initializeLegacyProjectContinuityAdoption({
      projectsRoot,
      deployRoot,
      legacyDeployRoot,
      database,
      ensureIdentity: jest.fn(async () => identity) as any,
    });

    expect(result).toEqual(expect.objectContaining({
      identitiesEnrolled: 0,
      appsBackfilled: 0,
      appsLeftStandalone: 1,
    }));
    expect(apps[0].projectIdentityId).toBeNull();
    expect(operations.filter((operation) => operation.startsWith('app:'))).toEqual([]);
  });

  test('boot contains a non-v4 stale link with a missing deployment instead of crash-looping', async () => {
    const projectName = 'arbitrary-stale';
    const projectRoot = path.join(projectsRoot, ownerId, projectName);
    fs.mkdirSync(projectRoot);
    const identity = makeIdentity(ownerId, projectName, projectRoot, 1);
    const identities = new Map([[`${ownerId}\0${projectName}`, identity]]);
    const operations: string[] = [];
    const missingDeployment = path.join(deployRoot, `${ownerId}-missing-elsewhere`);
    const apps = [{
      id: 'arbitrary-stale-app',
      userId: ownerId,
      projectIdentityId: identity.id,
      name: projectName,
      zipPath: missingDeployment,
      deployType: 'fullstack',
      processStatus: 'running',
    }];
    const database = makeDatabase({ ownerId, apps, identities, operations });

    await expect(initializeLegacyProjectContinuityAdoption({
      projectsRoot,
      deployRoot,
      legacyDeployRoot,
      database,
      ensureIdentity: jest.fn(async () => identity) as any,
    })).resolves.toEqual(expect.objectContaining({
      appsQuarantined: 1,
      appsBackfilled: 0,
      appsLeftStandalone: 1,
    }));

    expect(apps[0]).toEqual(expect.objectContaining({
      id: 'arbitrary-stale-app',
      projectIdentityId: null,
      processStatus: 'error',
      zipPath: missingDeployment,
    }));
    expect(fs.existsSync(missingDeployment)).toBe(false);
    expect(operations).toEqual(['quarantine:arbitrary-stale-app:error']);
  });

  test('update audit seals and repairs a non-v4 missing-path link before strict reattestation', async () => {
    const projectName = 'non-v4-update-repair';
    const projectRoot = path.join(projectsRoot, ownerId, projectName);
    fs.mkdirSync(projectRoot);
    const identity = makeIdentity(ownerId, projectName, projectRoot, 2);
    const identities = new Map([[`${ownerId}\0${projectName}`, identity]]);
    const operations: string[] = [];
    const apps = [{
      id: 'non-v4-update-app',
      userId: ownerId,
      projectIdentityId: identity.id,
      name: projectName,
      zipPath: path.join(deployRoot, `${ownerId}-missing-non-v4`),
      deployType: 'fullstack',
      processStatus: 'running',
    }];
    const database = makeDatabase({ ownerId, apps, identities, operations });

    const audit = await auditLegacyProjectContinuityReadiness({
      deployRoot,
      legacyDeployRoot,
      database,
    });
    expect(audit).toEqual(expect.objectContaining({
      staleLinkedApps: 1,
      repairableStaleLinkedApps: 1,
      repairPlanToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(operations).toEqual([]);

    await expect(repairLegacyProjectContinuityLinks({
      expectedPlanToken: audit.repairPlanToken,
      deployRoot,
      legacyDeployRoot,
      database,
    })).resolves.toEqual({
      appsQuarantined: 1,
      quarantinedAppIds: ['non-v4-update-app'],
    });
    await expect(auditLegacyProjectContinuityReadiness({
      deployRoot,
      legacyDeployRoot,
      database,
    })).resolves.toEqual(expect.objectContaining({
      staleLinkedApps: 0,
      repairableStaleLinkedApps: 0,
    }));
    expect(apps[0]).toEqual(expect.objectContaining({
      projectIdentityId: null,
      processStatus: 'error',
    }));
  });

  test('quarantines links whose ACTIVE Project root is missing or has changed inode', async () => {
    const identities = new Map<string, ProjectIdentityRecord>();
    const operations: string[] = [];
    const apps: any[] = [];
    for (const [index, projectName] of ['missing-project-root', 'drifted-project-root'].entries()) {
      const projectRoot = path.join(projectsRoot, ownerId, projectName);
      const deployPath = path.join(deployRoot, `${ownerId}-${projectName}`);
      fs.mkdirSync(projectRoot);
      fs.mkdirSync(deployPath);
      const identity = makeIdentity(ownerId, projectName, projectRoot, 20 + index);
      identities.set(`${ownerId}\0${projectName}`, identity);
      apps.push({
        id: `${projectName}-app`,
        userId: ownerId,
        projectIdentityId: identity.id,
        name: projectName,
        zipPath: deployPath,
        deployType: 'fullstack',
        processStatus: 'running',
      });
      if (projectName === 'missing-project-root') {
        fs.rmSync(projectRoot, { recursive: true });
      } else {
        fs.renameSync(projectRoot, `${projectRoot}.prior-inode`);
        fs.mkdirSync(projectRoot);
      }
    }
    const database = makeDatabase({ ownerId, apps, identities, operations });

    const audit = await auditLegacyProjectContinuityReadiness({
      deployRoot,
      legacyDeployRoot,
      database,
    });
    expect(audit).toEqual(expect.objectContaining({
      linkedApps: 2,
      staleLinkedApps: 2,
      repairableStaleLinkedApps: 2,
    }));
    expect(database.app.updateMany).not.toHaveBeenCalled();

    await expect(repairLegacyProjectContinuityLinks({
      expectedPlanToken: audit.repairPlanToken,
      deployRoot,
      legacyDeployRoot,
      database,
    })).resolves.toEqual({
      appsQuarantined: 2,
      quarantinedAppIds: ['drifted-project-root-app', 'missing-project-root-app'],
    });
    expect(apps.every((app) => app.projectIdentityId === null)).toBe(true);
    expect(apps.every((app) => app.processStatus === 'error')).toBe(true);
  });

  test('preserves exact RENAMING and DELETING links for lifecycle recovery', async () => {
    const identities = new Map<string, ProjectIdentityRecord>();
    const operations: string[] = [];
    const apps: any[] = [];

    const renamingName = 'rename-source';
    const renamingRoot = path.join(projectsRoot, ownerId, renamingName);
    const renamingDeploy = path.join(deployRoot, `${ownerId}-${renamingName}`);
    fs.mkdirSync(renamingRoot);
    fs.mkdirSync(renamingDeploy);
    const renamingIdentity = makeIdentity(ownerId, renamingName, renamingRoot, 30);
    const renamingDeployIdentity = attestProjectRoot(renamingDeploy);
    Object.assign(renamingIdentity, {
      lifecycleStatus: 'RENAMING',
      renameTargetName: 'rename-target',
      renameLeaseTokenHash: 'a'.repeat(64),
      renameLeaseExpiresAt: new Date(Date.now() + 60_000),
      renameStartedAt: new Date(),
      renameCleanupStartedAt: null,
      renameRuntimeCleanedAt: null,
      renameDeployPresent: true,
      renameDeployDevice: renamingDeployIdentity.rootDevice,
      renameDeployInode: renamingDeployIdentity.rootInode,
      renameDeployBirthtimeNs: renamingDeployIdentity.rootBirthtimeNs,
    });
    identities.set(`${ownerId}\0${renamingName}`, renamingIdentity);
    apps.push({
      id: 'renaming-app', userId: ownerId, projectIdentityId: renamingIdentity.id,
      name: renamingName, zipPath: renamingDeploy, deployType: 'fullstack', processStatus: 'stopped',
    });

    const deletingName = 'deleting-source';
    const deletingRoot = path.join(projectsRoot, ownerId, deletingName);
    const deletingDeploy = path.join(deployRoot, `${ownerId}-${deletingName}`);
    fs.mkdirSync(deletingRoot);
    fs.mkdirSync(deletingDeploy);
    const deletingIdentity = makeIdentity(ownerId, deletingName, deletingRoot, 31);
    Object.assign(deletingIdentity, {
      lifecycleStatus: 'DELETING',
      deletionStartedAt: new Date(),
    });
    identities.set(`${ownerId}\0${deletingName}`, deletingIdentity);
    apps.push({
      id: 'deleting-app', userId: ownerId, projectIdentityId: deletingIdentity.id,
      name: deletingName, zipPath: deletingDeploy, deployType: 'fullstack', processStatus: 'stopped',
    });
    // A crash after lifecycle quarantine removes the canonical root but leaves
    // the durable DELETING row as the authority to finish cleanup.
    fs.rmSync(deletingRoot, { recursive: true });

    const database = makeDatabase({ ownerId, apps, identities, operations });
    await expect(auditLegacyProjectContinuityReadiness({
      deployRoot,
      legacyDeployRoot,
      database,
    })).resolves.toEqual(expect.objectContaining({
      linkedApps: 2,
      staleLinkedApps: 0,
      repairableStaleLinkedApps: 0,
    }));
    expect(database.app.updateMany).not.toHaveBeenCalled();
  });

  test('fails before the App foreign key changes when its attested deployment inode is swapped', async () => {
    const identities = new Map<string, ProjectIdentityRecord>();
    const operations: string[] = [];
    const projectName = 'swap-race';
    const projectRoot = path.join(projectsRoot, ownerId, projectName);
    const deployPath = path.join(deployRoot, `${ownerId}-${projectName}`);
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(deployPath);
    const apps = [{
      id: 'raced-app', userId: ownerId, projectIdentityId: null, name: projectName,
      zipPath: deployPath, deployType: 'fullstack', processStatus: 'running',
    }];
    let transactionCount = 0;
    const database = makeDatabase({
      ownerId,
      apps,
      identities,
      operations,
      beforeTransaction: () => {
        transactionCount += 1;
        if (transactionCount !== 2) return;
        fs.renameSync(deployPath, `${deployPath}.replaced`);
        fs.mkdirSync(deployPath);
      },
    });
    const ensureIdentity = jest.fn(async (input: any) => {
      const identity = makeIdentity(input.workspaceOwnerId, input.projectName, input.projectRoot, 1);
      identities.set(`${input.workspaceOwnerId}\0${input.projectName}`, identity);
      return identity;
    });

    await expect(initializeLegacyProjectContinuityAdoption({
      projectsRoot,
      deployRoot,
      legacyDeployRoot,
      database,
      ensureIdentity: ensureIdentity as any,
    })).rejects.toBeInstanceOf(LegacyProjectContinuityAdoptionError);
    expect(apps[0].projectIdentityId).toBeNull();
    expect(operations.filter((operation) => operation.startsWith('app:'))).toEqual([]);
  });

  test('allows an absent optional legacy deployment root without broadening the current root', async () => {
    fs.rmSync(legacyDeployRoot, { recursive: true });
    const identities = new Map<string, ProjectIdentityRecord>();
    const operations: string[] = [];
    const database = makeDatabase({ ownerId, apps: [], identities, operations });

    await expect(initializeLegacyProjectContinuityAdoption({
      projectsRoot,
      deployRoot,
      legacyDeployRoot,
      database,
      ensureIdentity: jest.fn() as any,
    })).resolves.toEqual(expect.objectContaining({
      projectsFound: 0,
      appsBackfilled: 0,
    }));
  });

  test('refuses a configured legacy deployment root that resolves through a symbolic link', async () => {
    const realLegacyRoot = `${legacyDeployRoot}-real`;
    fs.renameSync(legacyDeployRoot, realLegacyRoot);
    fs.symlinkSync(realLegacyRoot, legacyDeployRoot);
    const identities = new Map<string, ProjectIdentityRecord>();
    const operations: string[] = [];
    const database = makeDatabase({ ownerId, apps: [], identities, operations });

    await expect(initializeLegacyProjectContinuityAdoption({
      projectsRoot,
      deployRoot,
      legacyDeployRoot,
      database,
      ensureIdentity: jest.fn() as any,
    })).rejects.toBeInstanceOf(LegacyProjectContinuityAdoptionError);
  });

  test('runs continuity enrollment and App backfill before legacy gating and keeps legacy copy preparation non-destructive', () => {
    const serverSource = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
    const continuity = serverSource.indexOf(
      'const projectContinuity = await initializeLegacyProjectContinuityAdoption();',
    );
    const legacyGate = serverSource.indexOf(
      'claimedLegacyOpenClawMigrationCoordinator = await beginLegacyOpenClawProjectMigration();',
    );
    const runningApps = serverSource.indexOf('await initializeAppProcessRuntime();');
    expect(continuity).toBeGreaterThan(0);
    expect(legacyGate).toBeGreaterThan(continuity);
    expect(runningApps).toBeGreaterThan(legacyGate);

    const continuitySource = fs.readFileSync(path.resolve(__dirname, 'legacyProjectContinuityAdoption.ts'), 'utf8');
    expect(continuitySource).not.toContain("from './projectLegacyAdoption'");
    expect(continuitySource).not.toContain("legacyOpenClawMigrationStatus: 'CURRENT'");

    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const routeStart = routeSource.indexOf("router.post('/:name/chat/migrate-legacy'");
    const routeEnd = routeSource.indexOf("router.get('/:name/chat/providers'", routeStart);
    const route = routeSource.slice(routeStart, routeEnd);
    expect(route).toContain('prepareProjectLegacyAdoptionStaging({');
    expect(route).toContain('await createCurrentProjectIdentity({');
    expect(route).toContain('await finalizeCurrentProjectIdentityCreation({');
    expect(route).toContain('await rebindLegacyProjectAppToCurrentCopy({');
    expect(route).toContain('beginProjectAppRebindOperation({');
    expect(route).toContain('beginProjectCopyOperation(operationInput)');
    expect(route).toContain('recordProjectAppRebindManifest({');
    expect(route).toContain('bindProjectAppRebindTarget({');
    expect(route).toContain('assertProjectMigrationTargetOwnedByOperation(operation, currentIdentity)');
    expect(route).not.toContain('appDeploymentPromotion = prepareFullstackDeploymentTree(');
    expect(route).toContain('shareLinksPreserved: appRebind?.shareLinksPreserved');
    expect(route).toContain('sourceProjectId: projectIdentity.id');
    // Initial copy receives two pre-publication scans; both interrupted
    // pre-move and post-move publication paths re-prove legacy absence.
    expect(route.match(/assertNoLegacyOpenClawProjectCreationCollision\(\{/g)).toHaveLength(4);
    expect(route).not.toContain('adoptLegacyProjectInPlace');
    expect(route).not.toContain('assertNoLegacyOpenClawProjectEvidence');
    expect(route).not.toContain('legacyOpenClawMigrationStatus: \'CURRENT\'');

    const rebindRouteStart = routeSource.indexOf("router.post('/:name/app/rebind-current'");
    const rebindRouteEnd = routeSource.indexOf("router.post('/:name/chat/migrate-legacy'", rebindRouteStart);
    const rebindRoute = routeSource.slice(rebindRouteStart, rebindRouteEnd);
    expect(rebindRoute).toContain("journal.operationKind !== 'PROJECT_APP_REBIND'");
    expect(rebindRoute).toContain('assertProjectMigrationTargetOwnedByOperation(journal, targetIdentity)');
    expect(rebindRoute).toContain('No durable Project migration receipt authorizes this App rebind.');
    expect(rebindRoute).not.toContain('prepareFullstackDeploymentTree(sourceDeployPath, targetDeployPath)');
  });

  // P4-B267. The rebootability preflight audits continuity BEFORE this
  // release's migrations apply, so every read it performs still lands on the
  // outgoing schema. An unqualified findUnique asks for every scalar in the
  // candidate schema; on a real 4.0.16 database that fails with
  // "The column `(not available)` does not exist in the current database" and
  // rejects the upgrade on 100% of hosts. The ordinary mocks in this file
  // ignore `select` entirely, which is why the full corpus stayed green while
  // the real installer aborted — this database does not.
  test('audits continuity against a pre-migration database that lacks this release columns', async () => {
    const projectName = 'pre-migration-audit';
    const projectRoot = path.join(projectsRoot, ownerId, projectName);
    fs.mkdirSync(projectRoot);
    const identity = makeIdentity(ownerId, projectName, projectRoot, 7);

    // The ProjectIdentity scalar columns as they exist in 4.0.16 — that is, the
    // candidate schema minus dependencyQuarantinedAt, which
    // 20260812_project_dependency_repair_force_forward has not added yet at
    // preflight time.
    const outgoingColumns = new Set([
      'id', 'workspaceOwnerId', 'projectName', 'canonicalRoot',
      'rootDevice', 'rootInode', 'rootBirthtimeNs', 'generation',
      'lifecycleStatus', 'legacyOpenClawMigrationStatus', 'deletionStartedAt',
      'renameTargetName', 'renameLeaseTokenHash', 'renameLeaseExpiresAt',
      'renameStartedAt', 'renameCleanupStartedAt', 'renameRuntimeCleanedAt',
      'renameDeployPresent', 'renameDeployDevice', 'renameDeployInode',
      'renameDeployBirthtimeNs', 'lastRenameSourceName', 'lastRenameCompletedAt',
      'createdAt', 'updatedAt',
    ]);
    const rejectedReads: string[] = [];

    const preMigrationFindUnique = jest.fn(async ({ where, select }: any) => {
      if (!select) {
        // Prisma would request every candidate-schema scalar, including the
        // column this release has not created yet.
        rejectedReads.push('unqualified');
        throw new Error('The column `(not available)` does not exist in the current database.');
      }
      const requested = Object.keys(select).filter((column) => select[column]);
      const missing = requested.filter((column) => !outgoingColumns.has(column));
      if (missing.length > 0) {
        rejectedReads.push(missing.join(','));
        throw new Error('The column `(not available)` does not exist in the current database.');
      }
      const compound = where.workspaceOwnerId_projectName;
      const matched = compound
        ? (compound.workspaceOwnerId === ownerId && compound.projectName === projectName)
        : where.id === identity.id;
      if (!matched) return null;
      return Object.fromEntries(
        requested.map((column) => [column, (identity as any)[column]]),
      );
    });

    const database: any = {
      user: { findMany: jest.fn(async () => [{ id: ownerId }]) },
      projectIdentity: { findUnique: preMigrationFindUnique },
      app: {
        findMany: jest.fn(async () => [{
          id: 'pre-migration-app',
          userId: ownerId,
          projectIdentityId: identity.id,
          name: projectName,
          zipPath: path.join(deployRoot, `${ownerId}-${projectName}`),
          deployType: 'fullstack',
          processStatus: 'stopped',
        }]),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      $transaction: jest.fn(async (handler: any) => handler(database)),
    };

    await expect(auditLegacyProjectContinuityReadiness({
      deployRoot,
      legacyDeployRoot,
      database,
    })).resolves.toEqual(expect.objectContaining({
      linkedApps: 1,
    }));

    expect(preMigrationFindUnique).toHaveBeenCalled();
    expect(rejectedReads).toEqual([]);
    for (const [{ select }] of preMigrationFindUnique.mock.calls as any[]) {
      expect(select).toBeDefined();
      expect(select).not.toHaveProperty('dependencyQuarantinedAt');
    }
  });
});
