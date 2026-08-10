import fs from 'fs';
import os from 'os';
import path from 'path';

const mockTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-project-list-resilience-'));
const mockProjectsRoot = path.join(mockTempRoot, 'projects');
const mockAppsRoot = path.join(mockTempRoot, 'apps');
const mockOwnerId = 'owner-list-resilience';
const mockEnvironmentKeys = [
  'DATABASE_URL',
  'PORTAL_PROJECTS_ROOT',
  'APPS_ROOT',
  'PORTAL_PROJECT_ZIPS_ROOT',
  'PORTAL_UPLOAD_TEMP_ROOT',
  'APP_API_TARGET_APP_EXTERNAL_INVENTORY',
] as const;
const mockPreviousEnvironment = new Map(
  mockEnvironmentKeys.map((key) => [key, process.env[key]]),
);
let mockLifecycleConflictProjectName: string | null = null;
let mockInventoryApps: any[] = [];

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:5432/portal_test';
process.env.PORTAL_PROJECTS_ROOT = mockProjectsRoot;
process.env.APPS_ROOT = mockAppsRoot;
process.env.PORTAL_PROJECT_ZIPS_ROOT = path.join(mockTempRoot, 'zips');
process.env.PORTAL_UPLOAD_TEMP_ROOT = path.join(mockTempRoot, 'uploads');

const mockIdentityRows = new Map<string, any>();
const mockProjectIdentity = {
  findUnique: jest.fn(async (args: any) => {
    const projectName = args?.where?.workspaceOwnerId_projectName?.projectName;
    return typeof projectName === 'string' ? mockIdentityRows.get(projectName) || null : null;
  }),
  findFirst: jest.fn(async () => null),
  create: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
  delete: jest.fn(),
  deleteMany: jest.fn(async () => ({ count: 0 })),
  findMany: jest.fn(async () => Array.from(mockIdentityRows.values())),
};
const mockPrisma = {
  projectIdentity: mockProjectIdentity,
  app: {
    findMany: jest.fn(async (args: any) => (
      mockLifecycleConflictProjectName
      && JSON.stringify(args).includes(`\"name\":\"${mockLifecycleConflictProjectName}\"`)
        ? [{ id: 'conflicting-app-1' }, { id: 'conflicting-app-2' }]
        : mockInventoryApps
    )),
  },
};

jest.mock('../config/database', () => ({ prisma: mockPrisma }));
jest.mock('../utils/workspaceScope', () => ({
  getWorkspaceOwnerId: jest.fn(async (user: any) => user.userId),
}));

const { attestProjectRoot } = require('../services/projectIdentity') as typeof import('../services/projectIdentity');
const projectsRouter = require('../routes/projects').default;

function listRouteHandler() {
  const layer = (projectsRouter as any).stack.find((candidate: any) => (
    candidate.route?.path === '/'
    && candidate.route?.methods?.get === true
  ));
  expect(layer).toBeDefined();
  const handlers = layer.route.stack;
  return handlers[handlers.length - 1].handle as (req: any, res: any) => Promise<void>;
}

function identityFor(projectName: string, projectRoot: string) {
  const root = attestProjectRoot(projectRoot);
  const now = new Date();
  return {
    id: `identity-${projectName}`,
    workspaceOwnerId: mockOwnerId,
    projectName,
    canonicalRoot: root.canonicalRoot,
    rootDevice: root.rootDevice,
    rootInode: root.rootInode,
    rootBirthtimeNs: root.rootBirthtimeNs,
    generation: 1,
    lifecycleStatus: 'ACTIVE',
    legacyOpenClawMigrationStatus: 'CURRENT',
    createdAt: now,
    updatedAt: now,
  };
}

describe('GET /api/projects inventory resilience', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIdentityRows.clear();
    mockLifecycleConflictProjectName = null;
    mockInventoryApps = [];
    delete process.env.APP_API_TARGET_APP_EXTERNAL_INVENTORY;
    fs.rmSync(mockProjectsRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(mockProjectsRoot, mockOwnerId), { recursive: true });
    fs.mkdirSync(mockAppsRoot, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(mockTempRoot, { recursive: true, force: true });
    for (const key of mockEnvironmentKeys) {
      const previous = mockPreviousEnvironment.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  test('returns healthy projects and a sanitized disabled row when one immutable directory is stale', async () => {
    const ownerRoot = path.join(mockProjectsRoot, mockOwnerId);
    const healthyRoot = path.join(ownerRoot, 'healthy-project');
    const staleRoot = path.join(ownerRoot, 'stale-project');
    fs.mkdirSync(healthyRoot);
    fs.mkdirSync(staleRoot);

    mockIdentityRows.set('healthy-project', identityFor('healthy-project', healthyRoot));
    mockIdentityRows.set('stale-project', identityFor('stale-project', staleRoot));

    // Replacing the directory preserves its visible name while changing the
    // server-attested device/inode/birthtime identity.
    fs.renameSync(staleRoot, path.join(mockTempRoot, 'stale-project-replaced-root'));
    fs.mkdirSync(staleRoot);

    const response: any = {
      status: jest.fn(),
      json: jest.fn(),
    };
    response.status.mockReturnValue(response);
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await listRouteHandler()({
      user: { userId: mockOwnerId, role: 'OWNER' },
    }, response);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledTimes(1);
    const body = response.json.mock.calls[0][0];
    expect(body.projects).toHaveLength(2);

    const healthy = body.projects.find((project: any) => project.name === 'healthy-project');
    expect(healthy).toMatchObject({
      detectedDeployType: 'static',
      identity: { id: 'identity-healthy-project', generation: 1 },
      destructiveActions: { allowed: true, reason: null },
    });

    const stale = body.projects.find((project: any) => project.name === 'stale-project');
    expect(stale).toMatchObject({
      identity: { id: 'identity-stale-project', generation: 1 },
      availability: {
        available: false,
        code: 'PROJECT_IDENTITY_RECONCILIATION_REQUIRED',
        action: 'RECONCILE_PROJECT_IDENTITY',
        retryable: false,
      },
      destructiveActions: { allowed: false },
    });
    expect(stale).not.toHaveProperty('detail');
    expect(JSON.stringify(stale)).not.toContain(
      'Project Chat is disabled until the project is re-enrolled',
    );
    expect(mockPrisma.app.findMany).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  test('isolates a lifecycle conflict to its project inventory row', async () => {
    const ownerRoot = path.join(mockProjectsRoot, mockOwnerId);
    const healthyRoot = path.join(ownerRoot, 'healthy-project');
    const conflictRoot = path.join(ownerRoot, 'lifecycle-conflict');
    fs.mkdirSync(healthyRoot);
    fs.mkdirSync(conflictRoot);
    mockIdentityRows.set('healthy-project', identityFor('healthy-project', healthyRoot));
    mockIdentityRows.set('lifecycle-conflict', identityFor('lifecycle-conflict', conflictRoot));
    mockLifecycleConflictProjectName = 'lifecycle-conflict';

    const response: any = {
      status: jest.fn(),
      json: jest.fn(),
    };
    response.status.mockReturnValue(response);
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await listRouteHandler()({
      user: { userId: mockOwnerId, role: 'OWNER' },
    }, response);

    expect(response.status).not.toHaveBeenCalled();
    const body = response.json.mock.calls[0][0];
    expect(body.projects).toHaveLength(2);
    expect(body.projects.find((project: any) => project.name === 'healthy-project'))
      .toMatchObject({ destructiveActions: { allowed: true } });
    expect(body.projects.find((project: any) => project.name === 'lifecycle-conflict'))
      .toMatchObject({
        availability: {
          available: false,
          code: 'PROJECT_LIFECYCLE_RECONCILIATION_REQUIRED',
          action: 'RECONCILE_PROJECT_LIFECYCLE',
          retryable: false,
        },
        destructiveActions: { allowed: false },
      });
    expect(JSON.stringify(body)).not.toContain(
      'More than one App claims the same immutable Project identity',
    );
    warning.mockRestore();
  });

  test('publishes external runtime ownership and removes destructive lifecycle capabilities', async () => {
    const ownerRoot = path.join(mockProjectsRoot, mockOwnerId);
    const projectName = 'external-inventory';
    const projectRoot = path.join(ownerRoot, projectName);
    fs.mkdirSync(projectRoot);
    const identity = identityFor(projectName, projectRoot);
    mockIdentityRows.set(projectName, identity);
    mockInventoryApps = [{
      id: 'app-external-inventory',
      userId: mockOwnerId,
      projectIdentityId: identity.id,
      name: projectName,
      zipPath: path.join(mockAppsRoot, `${mockOwnerId}-${projectName}`),
      port: null,
      deployType: 'static',
      processStatus: 'stopped',
      isActive: true,
    }];
    process.env.APP_API_TARGET_APP_EXTERNAL_INVENTORY = 'http://127.0.0.1:5996';
    const response: any = { status: jest.fn(), json: jest.fn() };
    response.status.mockReturnValue(response);

    await listRouteHandler()({
      user: { userId: mockOwnerId, role: 'OWNER' },
    }, response);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json.mock.calls[0][0].projects).toEqual([
      expect.objectContaining({
        name: projectName,
        destructiveActions: expect.objectContaining({
          allowed: false,
          code: 'PROJECT_RUNTIME_EXTERNALLY_MANAGED',
        }),
        deployment: expect.objectContaining({
          runtimeManagement: 'external-loopback',
          statusSource: 'external-binding',
          supportedLifecycleActions: ['redeploy'],
        }),
      }),
    ]);

    for (const [detectedDeployType, packageJson] of [
      ['fullstack', { scripts: { start: 'node server.js' } }],
      ['runtime', { name: 'cli-without-start' }],
    ] as const) {
      fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify(packageJson));
      const changedResponse: any = { status: jest.fn(), json: jest.fn() };
      changedResponse.status.mockReturnValue(changedResponse);
      await listRouteHandler()({
        user: { userId: mockOwnerId, role: 'OWNER' },
      }, changedResponse);
      expect(changedResponse.json.mock.calls[0][0].projects[0]).toMatchObject({
        detectedDeployType,
        deployment: {
          runtimeManagement: 'external-loopback',
          supportedLifecycleActions: [],
        },
      });
    }
  });

  test('publishes a safe compatible state for a present but invalid runtime binding', async () => {
    const ownerRoot = path.join(mockProjectsRoot, mockOwnerId);
    const projectName = 'external-inventory';
    const projectRoot = path.join(ownerRoot, projectName);
    fs.mkdirSync(projectRoot);
    const identity = identityFor(projectName, projectRoot);
    mockIdentityRows.set(projectName, identity);
    mockInventoryApps = [{
      id: 'app-external-inventory',
      userId: mockOwnerId,
      projectIdentityId: identity.id,
      name: projectName,
      zipPath: path.join(mockAppsRoot, `${mockOwnerId}-${projectName}`),
      port: 5002,
      deployType: 'fullstack',
      processStatus: 'running',
      isActive: true,
    }];
    process.env.APP_API_TARGET_APP_EXTERNAL_INVENTORY = '   ';
    const response: any = { status: jest.fn(), json: jest.fn() };
    response.status.mockReturnValue(response);

    await listRouteHandler()({
      user: { userId: mockOwnerId, role: 'OWNER' },
    }, response);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json.mock.calls[0][0].projects[0]).toMatchObject({
      destructiveActions: {
        allowed: false,
        code: 'PROJECT_RUNTIME_BINDING_INVALID',
      },
      deployment: {
        runtimeManagement: 'external-loopback',
        statusSource: 'external-binding',
        bindingStatus: 'invalid',
        configurationCode: 'PROJECT_RUNTIME_BINDING_INVALID',
        supportedLifecycleActions: [],
      },
    });
    expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain('APP_API_TARGET_');
  });

  test('ignores a directory that disappears after the inventory snapshot', async () => {
    const ownerRoot = path.join(mockProjectsRoot, mockOwnerId);
    const healthyRoot = path.join(ownerRoot, 'healthy-project');
    const disappearingRoot = path.join(ownerRoot, 'disappearing-project');
    fs.mkdirSync(healthyRoot);
    fs.mkdirSync(disappearingRoot);
    mockIdentityRows.set('healthy-project', identityFor('healthy-project', healthyRoot));
    mockIdentityRows.set('disappearing-project', identityFor('disappearing-project', disappearingRoot));
    mockProjectIdentity.findUnique.mockImplementation(async (args: any) => {
      const projectName = args?.where?.workspaceOwnerId_projectName?.projectName;
      if (projectName === 'disappearing-project') {
        fs.rmSync(disappearingRoot, { recursive: true, force: true });
      }
      return typeof projectName === 'string' ? mockIdentityRows.get(projectName) || null : null;
    });

    const response: any = {
      status: jest.fn(),
      json: jest.fn(),
    };
    response.status.mockReturnValue(response);
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await listRouteHandler()({
      user: { userId: mockOwnerId, role: 'OWNER' },
    }, response);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({
      projects: [expect.objectContaining({ name: 'healthy-project' })],
    });
    warning.mockRestore();
  });

  test('keeps unexpected list failures generic instead of returning raw exception detail', async () => {
    fs.mkdirSync(path.join(mockProjectsRoot, mockOwnerId, 'database-failure-project'));
    mockProjectIdentity.findUnique.mockRejectedValueOnce(
      new Error('private database connection detail'),
    );
    const response: any = {
      status: jest.fn(),
      json: jest.fn(),
    };
    response.status.mockReturnValue(response);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await listRouteHandler()({
      user: { userId: mockOwnerId, role: 'OWNER' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: 'Failed to list projects',
      code: 'PROJECT_LIST_FAILED',
      retryable: true,
    });
    expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain(
      'private database connection detail',
    );
    error.mockRestore();
  });
});
