import fs from 'fs';
import os from 'os';
import path from 'path';

const mockTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-project-route-publication-'));
const mockProjectsRoot = path.join(mockTempRoot, 'projects');
fs.mkdirSync(mockProjectsRoot, { recursive: true });
process.env.PORTAL_PROJECTS_ROOT = mockProjectsRoot;
process.env.APPS_ROOT = path.join(mockTempRoot, 'apps');
process.env.PORTAL_PROJECT_ZIPS_ROOT = path.join(mockTempRoot, 'zips');
process.env.PORTAL_UPLOAD_TEMP_ROOT = path.join(mockTempRoot, 'uploads');

let mockStoredIdentity: any = null;
let mockActiveReadFailurePending = false;

const mockProjectIdentity = {
  findFirst: jest.fn(async () => null),
  findUnique: jest.fn(async (args: any) => {
    if (!mockStoredIdentity) return null;
    const requestedId = args?.where?.id;
    if (requestedId && requestedId !== mockStoredIdentity.id) return null;
    if (mockStoredIdentity.lifecycleStatus === 'ACTIVE' && mockActiveReadFailurePending) {
      mockActiveReadFailurePending = false;
      throw new Error('injected post-CAS read failure');
    }
    return mockStoredIdentity;
  }),
  create: jest.fn(async (args: any) => {
    const now = new Date();
    mockStoredIdentity = { ...args.data, createdAt: now, updatedAt: now };
    return mockStoredIdentity;
  }),
  update: jest.fn(),
  updateMany: jest.fn(async (args: any) => {
    if (!mockStoredIdentity || args?.where?.id !== mockStoredIdentity.id) return { count: 0 };
    mockStoredIdentity = { ...mockStoredIdentity, ...args.data, updatedAt: new Date() };
    if (args.data.lifecycleStatus === 'ACTIVE') mockActiveReadFailurePending = true;
    return { count: 1 };
  }),
  delete: jest.fn(),
  deleteMany: jest.fn(async () => ({ count: 0 })),
  findMany: jest.fn(async () => mockStoredIdentity ? [mockStoredIdentity] : []),
};

const mockRemovePortalProjectWorkloadsForProject = jest.fn(async () => undefined);
const mockPrisma = {
  projectIdentity: mockProjectIdentity,
  activityLog: { create: jest.fn(async () => ({})) },
};

jest.mock('../config/database', () => ({ prisma: mockPrisma }));
jest.mock('../utils/workspaceScope', () => ({
  getWorkspaceOwnerId: jest.fn(async (user: any) => user.userId),
}));
jest.mock('../services/project-git.service', () => ({
  ...jest.requireActual('../services/project-git.service'),
  runProjectGitCommand: jest.fn(async () => undefined),
}));
jest.mock('../services/legacyOpenClawProjectRetirement', () => ({
  ...jest.requireActual('../services/legacyOpenClawProjectRetirement'),
  assertNoLegacyOpenClawProjectCreationCollision: jest.fn(async () => undefined),
}));
jest.mock('../services/projectWorkloadRuntime', () => ({
  ...jest.requireActual('../services/projectWorkloadRuntime'),
  removePortalProjectWorkloadsForProject: mockRemovePortalProjectWorkloadsForProject,
}));

const projectsRouter = require('../routes/projects').default;

function routeHandler(method: 'post', routePath: string) {
  const layer = (projectsRouter as any).stack.find((candidate: any) => (
    candidate.route?.path === routePath
    && candidate.route?.methods?.[method] === true
  ));
  expect(layer).toBeDefined();
  const handlers = layer.route.stack;
  return handlers[handlers.length - 1].handle as (req: any, res: any) => Promise<void>;
}

describe('Project creation publication reconciliation', () => {
  beforeEach(() => {
    mockStoredIdentity = null;
    mockActiveReadFailurePending = false;
    jest.clearAllMocks();
    fs.rmSync(mockProjectsRoot, { recursive: true, force: true });
    fs.mkdirSync(mockProjectsRoot, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(mockTempRoot, { recursive: true, force: true });
  });

  test('template route returns its normal 201 when the post-CAS verification read fails', async () => {
    const handler = routeHandler('post', '/');
    const request = {
      user: { userId: 'owner-1', role: 'OWNER' },
      body: { name: 'post-cas-project', template: 'static-html' },
    };
    const response: any = {
      headersSent: false,
      status: jest.fn(),
      json: jest.fn(),
    };
    response.status.mockReturnValue(response);
    response.json.mockImplementation(() => {
      response.headersSent = true;
      return response;
    });
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await handler(request, response);

    expect(response.status).toHaveBeenCalledTimes(1);
    expect(response.status).toHaveBeenCalledWith(201);
    expect(response.json).toHaveBeenCalledTimes(1);
    expect(response.json).toHaveBeenCalledWith({
      name: 'post-cas-project',
      template: 'static-html',
      identity: {
        id: mockStoredIdentity.id,
        generation: 1,
      },
    });
    expect(mockStoredIdentity).toMatchObject({
      workspaceOwnerId: 'owner-1',
      projectName: 'post-cas-project',
      lifecycleStatus: 'ACTIVE',
      legacyOpenClawMigrationStatus: 'CURRENT',
    });
    expect([mockStoredIdentity].filter((row) => row.lifecycleStatus === 'ACTIVE')).toHaveLength(1);
    expect(mockProjectIdentity.create).toHaveBeenCalledTimes(1);
    expect(mockProjectIdentity.deleteMany).not.toHaveBeenCalled();
    expect(mockRemovePortalProjectWorkloadsForProject).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(mockProjectsRoot, 'owner-1', 'post-cas-project'))).toBe(true);

    warning.mockRestore();
    error.mockRestore();
  });

  test('all five creation routes reconcile publication before mapping an error response', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'projects.ts'), 'utf8');
    expect(source.match(/const reconciliation = await reconcileFailedCurrentProjectCreation\(\{/g)).toHaveLength(5);
    expect(source.match(/if \(reconciliation === 'published'(?: && successResponse)?\) \{/g)).toHaveLength(5);
  });
});
