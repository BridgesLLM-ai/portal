import fs from 'fs';
import os from 'os';
import path from 'path';
import { attestProjectRoot, type ProjectIdentityRecord } from './projectIdentity';
import {
  initializeLegacyProjectContinuityAdoption,
  LegacyProjectContinuityAdoptionError,
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
      findMany: jest.fn(async () => input.apps.map((app) => ({ ...app }))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const app = input.apps.find((candidate) => candidate.id === where.id);
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
    const database = makeDatabase({
      ownerId,
      apps,
      identities,
      operations,
      beforeTransaction: () => {
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

  test('runs continuity enrollment and App backfill before legacy gating and running-App restore', () => {
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
    expect(route.indexOf('await assertLegacyOpenClawProjectMigrationInactive(projectIdentity.id);'))
      .toBeLessThan(route.indexOf('const result = await adoptLegacyProjectInPlace'));
    expect(route.indexOf('await assertNoLegacyOpenClawProjectEvidence();'))
      .toBeLessThan(route.indexOf('const result = await adoptLegacyProjectInPlace'));
    expect(route).toContain('error instanceof LegacyOpenClawProjectRetirementError');
    expect(route).toContain('LEGACY_OPENCLAW_RETIREMENT_PENDING_MESSAGE');
    expect(route).not.toContain('legacyEvidenceError?.message');
  });
});
