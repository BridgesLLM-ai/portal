import fs from 'fs';
import os from 'os';
import path from 'path';

describe('atomic user deletion cleanup', () => {
  const originalEnv = { ...process.env };
  let root: string;
  let portalRoot: string;
  let appSourcePath: string;
  let prismaMock: any;
  let stopApp: jest.Mock;
  let deleteMailbox: jest.Mock;
  let publishAuthorizationChanged: jest.Mock;
  let withGlobalWorkspaceAuthorizationFenceMock: jest.Mock;
  let updateUserAuthorizationMock: jest.Mock;
  let transferOwnershipMock: jest.Mock;

  async function loadService(appPath = appSourcePath) {
    jest.resetModules();
    process.env.PORTAL_DATA_ROOT = portalRoot;
    process.env.PORTAL_ROOT = portalRoot;
    process.env.PORTAL_PROJECTS_ROOT = path.join(portalRoot, 'projects');
    process.env.PORTAL_FILES_ROOT = path.join(portalRoot, 'files');
    process.env.PORTAL_APPS_ROOT = path.join(portalRoot, 'apps');
    process.env.APPS_ROOT = path.join(portalRoot, 'hosted-apps');
    process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR = path.join(portalRoot, 'native-sessions');
    process.env.PORTAL_AGENT_JOBS_ROOT = path.join(portalRoot, 'jobs');

    prismaMock = {
      user: {
        findUnique: jest.fn(async () => ({ id: 'user-1', username: 'alice', avatarPath: null })),
      },
      app: {
        findMany: jest.fn(async () => ([{ id: 'app-1', name: 'demo', zipPath: appPath }])),
      },
      mailboxAccount: {
        findMany: jest.fn(async () => []),
      },
      agentJob: {
        findMany: jest.fn(async () => []),
      },
      activityLog: {
        create: jest.fn(async () => ({})),
      },
    };
    stopApp = jest.fn(async () => undefined);
    deleteMailbox = jest.fn(async () => undefined);
    publishAuthorizationChanged = jest.fn();
    withGlobalWorkspaceAuthorizationFenceMock = jest.fn(
      async (operation: () => Promise<unknown>) => operation(),
    );
    updateUserAuthorizationMock = jest.fn(async ({ targetUserId, update }) => ({
      user: {
        id: targetUserId,
        email: 'target@example.com',
        username: 'target',
        firstName: null,
        lastName: null,
        role: update.role || 'USER',
        accountStatus: update.accountStatus || 'ACTIVE',
        isActive: update.isActive ?? true,
        sandboxEnabled: update.sandboxEnabled ?? false,
        authorizationVersion: 2,
      },
      existing: {
        id: targetUserId,
        email: 'target@example.com',
        username: 'target',
        role: 'USER',
        accountStatus: 'ACTIVE',
        isActive: true,
        sandboxEnabled: false,
        authorizationVersion: 1,
      },
      authorizationReasons: ['workspace_scope'],
    }));
    transferOwnershipMock = jest.fn(async () => ({
      changedAuthorizations: [
        { id: 'current-owner', authorizationVersion: 9 },
        { id: 'target-owner', authorizationVersion: 5 },
      ],
      targetEmail: 'next-owner@example.com',
    }));

    jest.doMock('../config/database', () => ({ prisma: prismaMock }));
    jest.doMock('../services/app-process.service', () => ({ stopApp }));
    jest.doMock('../services/userMailService', () => ({ deleteUserMailboxByUserId: deleteMailbox }));
    jest.doMock('../services/imageAssets', () => ({
      AVATARS_DIR: path.join(portalRoot, 'avatars'),
      BRANDING_DIR: path.join(portalRoot, 'branding'),
      createImageUpload: jest.fn(() => (_req: any, _res: any, next: any) => next()),
    }));
    jest.doMock('../utils/openclawGatewayRpc', () => ({
      deleteSession: jest.fn(async () => ({ ok: true })),
      gatewayRpcCall: jest.fn(async () => ({ ok: true, data: { config: { agents: { list: [] } } } })),
    }));
    jest.doMock('../services/authorizationChangeBus', () => ({ publishAuthorizationChanged }));
    jest.doMock('../services/workspaceAuthorizationBarrier', () => ({
      withGlobalWorkspaceAuthorizationFence: withGlobalWorkspaceAuthorizationFenceMock,
      withWorkspaceAuthorizationFence: async (_userId: string, operation: () => Promise<unknown>) => operation(),
      withWorkspaceAuthorizationFences: async (_userIds: string[], operation: () => Promise<unknown>) => operation(),
    }));
    jest.doMock('../services/projectRuntimeAuthorizationPolicy', () => ({
      ...jest.requireActual('../services/projectRuntimeAuthorizationPolicy'),
    }));
    jest.doMock('../services/projectAuthorizationTransition', () => ({
      projectAuthorizationTransitionCoordinator: {
        updateUserAuthorization: updateUserAuthorizationMock,
        transferOwnership: transferOwnershipMock,
      },
      ProjectAuthorizationTransitionError: class ProjectAuthorizationTransitionError extends Error {
        readonly code = 'TEST_TRANSITION_ERROR';
        readonly statusCode = 503;
        readonly retryable = true;
      },
    }));

    return import('../services/adminUserDeletion.service');
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridges-user-delete-'));
    portalRoot = path.join(root, 'portal');
    appSourcePath = path.join(portalRoot, 'apps', 'user-1-demo-source');
    fs.mkdirSync(appSourcePath, { recursive: true });
    fs.writeFileSync(path.join(appSourcePath, 'sentinel.txt'), 'keep until commit');
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('terminally disables the legacy deletion entry point before database or external mutation', async () => {
    const { deleteUserDataWithCleanup } = await loadService();
    const commit = jest.fn(async () => { throw new Error('transaction rolled back'); });

    await expect(deleteUserDataWithCleanup('user-1', commit)).rejects.toMatchObject({
      code: 'ADMIN_USER_DELETION_RETIREMENT_PENDING',
    });

    expect(commit).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(appSourcePath, 'sentinel.txt'))).toBe(true);
    expect(stopApp).not.toHaveBeenCalled();
    expect(deleteMailbox).not.toHaveBeenCalled();
  });

  test('also blocks a project-free user even when the supplied transaction would succeed', async () => {
    const { deleteUserDataWithCleanup } = await loadService();
    const commit = jest.fn(async () => undefined);

    await expect(deleteUserDataWithCleanup('user-1', commit)).rejects.toMatchObject({
      code: 'ADMIN_USER_DELETION_RETIREMENT_PENDING',
    });

    expect(commit).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(appSourcePath, 'sentinel.txt'))).toBe(true);
    expect(stopApp).not.toHaveBeenCalled();
    expect(deleteMailbox).not.toHaveBeenCalled();
  });

  test('the dormant cleanup planner still rejects tampered app paths without filesystem mutation', async () => {
    const outsidePath = path.join(root, 'outside-app');
    fs.mkdirSync(outsidePath);
    fs.writeFileSync(path.join(outsidePath, 'sentinel.txt'), 'outside');
    const { prepareUserDeletionCleanup } = await loadService(outsidePath);

    await expect(prepareUserDeletionCleanup('user-1')).rejects.toThrow('outside managed roots');

    expect(fs.existsSync(path.join(outsidePath, 'sentinel.txt'))).toBe(true);
  });

  test('admin route returns terminal 409 without starting a transaction or external cleanup', async () => {
    await loadService();
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'target-user',
      email: 'target@example.com',
      role: 'USER',
    });
    prismaMock.$transaction = jest.fn(async () => undefined);
    prismaMock.activityLog = { create: jest.fn(async () => ({})) };
    const adminRouter = (await import('../routes/admin')).default as any;
    const layer = adminRouter.stack.find((candidate: any) => (
      candidate.route?.path === '/users/:id'
      && candidate.route?.methods?.delete === true
    ));
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const request = {
      params: { id: 'target-user' },
      user: { userId: 'owner-user', role: 'OWNER' },
      body: {},
    };
    const response: any = { status: jest.fn(), json: jest.fn() };
    response.status.mockReturnValue(response);
    const next = jest.fn();

    await handler(request, response, next);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({
      error: 'Admin user deletion is unavailable while Portal 4 identity-aware user retirement is pending.',
      code: 'ADMIN_USER_DELETION_RETIREMENT_PENDING',
      retryable: false,
    });
    expect(next).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled();
    expect(stopApp).not.toHaveBeenCalled();
    expect(deleteMailbox).not.toHaveBeenCalled();
  });

  test('keeps the Project owner FK non-cascading through an atomic migration', () => {
    const schema = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const migration = fs.readFileSync(path.join(
      __dirname,
      '../../prisma/migrations/20260722_project_identity_owner_restrict/migration.sql',
    ), 'utf8');

    expect(schema).toMatch(/workspaceOwner\s+User[^\n]+onDelete: Restrict/);
    expect(migration.trim().startsWith('--')).toBe(true);
    expect(migration).toMatch(/BEGIN;[\s\S]+DROP CONSTRAINT[\s\S]+ON DELETE RESTRICT[\s\S]+COMMIT;/);
    expect(migration).toContain('DROP CONSTRAINT "ProjectIdentity_workspaceOwnerId_fkey"');
    expect(migration).toContain('ON DELETE RESTRICT ON UPDATE CASCADE');
  });

  test('returns the durable safety contract and delegates authorization changes', async () => {
    await loadService();
    prismaMock.user.findMany = jest.fn(async () => []);
    prismaMock.user.count = jest.fn(async () => 0);
    const adminRouter = (await import('../routes/admin')).default as any;

    const listLayer = adminRouter.stack.find((candidate: any) => (
      candidate.route?.path === '/users'
      && candidate.route?.methods?.get === true
    ));
    const listHandler = listLayer.route.stack[listLayer.route.stack.length - 1].handle;
    const listResponse: any = { json: jest.fn() };
    await listHandler({ query: {} }, listResponse, jest.fn());
    expect(listResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      authorizationSafety: expect.objectContaining({
        ready: true,
        code: 'PROJECT_RUNTIME_AUTHORIZATION_DURABLE',
        fixedGenerationProjectExecution: true,
        authorizationScopeChanges: true,
        retryable: false,
      }),
    }));

    const patchLayer = adminRouter.stack.find((candidate: any) => (
      candidate.route?.path === '/users/:id'
      && candidate.route?.methods?.patch === true
    ));
    const patchHandler = patchLayer.route.stack[patchLayer.route.stack.length - 1].handle;
    const patchResponse: any = { json: jest.fn() };
    const patchNext = jest.fn();
    await patchHandler({
      params: { id: 'target-user' },
      user: { userId: 'owner-user', role: 'OWNER' },
      body: { sandboxEnabled: true },
    }, patchResponse, patchNext);

    const transferLayer = adminRouter.stack.find((candidate: any) => (
      candidate.route?.path === '/users/:id/transfer-ownership'
      && candidate.route?.methods?.post === true
    ));
    const transferHandler = transferLayer.route.stack[transferLayer.route.stack.length - 1].handle;
    const transferResponse: any = { json: jest.fn() };
    const transferNext = jest.fn();
    await transferHandler({
      params: { id: 'target-user' },
      user: { userId: 'owner-user', role: 'OWNER' },
      body: { confirmation: 'TRANSFER TO target@example.com' },
    }, transferResponse, transferNext);

    expect(patchNext).not.toHaveBeenCalled();
    expect(transferNext).not.toHaveBeenCalled();
    expect(updateUserAuthorizationMock).toHaveBeenCalledWith({
      initiatedByUserId: 'owner-user',
      targetUserId: 'target-user',
      update: { sandboxEnabled: true },
      confirmation: undefined,
    });
    expect(transferOwnershipMock).toHaveBeenCalledWith({
      sourceOwnerUserId: 'owner-user',
      targetUserId: 'target-user',
      confirmation: 'TRANSFER TO target@example.com',
    });
    expect(patchResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      id: 'target-user',
      sandboxEnabled: true,
    }));
    expect(transferResponse.json).toHaveBeenCalledWith({ success: true });
  });

  test('passes normalized authorization fields to the durable coordinator', async () => {
    await loadService();

    const adminRouter = (await import('../routes/admin')).default as any;
    const layer = adminRouter.stack.find((candidate: any) => (
      candidate.route?.path === '/users/:id'
      && candidate.route?.methods?.patch === true
    ));
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const request = {
      params: { id: 'target-user' },
      user: { userId: 'owner-user', role: 'OWNER' },
      body: { accountStatus: 'DISABLED', sandboxEnabled: true },
    };
    const response: any = { json: jest.fn() };
    const next = jest.fn();

    await handler(request, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(updateUserAuthorizationMock).toHaveBeenCalledWith({
      initiatedByUserId: 'owner-user',
      targetUserId: 'target-user',
      update: {
        accountStatus: 'DISABLED',
        isActive: false,
        sandboxEnabled: true,
      },
      confirmation: undefined,
    });
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      sandboxEnabled: true,
      authorizationVersion: 2,
    }));
  });

  test('returns coordinator failures through the route error boundary', async () => {
    await loadService();
    const transitionModule = await import('../services/projectAuthorizationTransition');
    updateUserAuthorizationMock.mockRejectedValue(
      new transitionModule.ProjectAuthorizationTransitionError(
        'TEST_TRANSITION_ERROR',
        'Test transition failure',
      ),
    );

    const adminRouter = (await import('../routes/admin')).default as any;
    const layer = adminRouter.stack.find((candidate: any) => (
      candidate.route?.path === '/users/:id'
      && candidate.route?.methods?.patch === true
    ));
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const response: any = {
      status: jest.fn(function status() { return response; }),
      json: jest.fn(),
    };
    const next = jest.fn();

    await handler({
      params: { id: 'target-user' },
      user: { userId: 'owner-user', role: 'OWNER' },
      body: { sandboxEnabled: false },
    }, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      error: 'TEST_TRANSITION_ERROR',
      code: 'TEST_TRANSITION_ERROR',
      retryable: true,
    });
  });

  test('delegates ownership transfer with the exact actor and confirmation', async () => {
    await loadService();

    const adminRouter = (await import('../routes/admin')).default as any;
    const layer = adminRouter.stack.find((candidate: any) => (
      candidate.route?.path === '/users/:id/transfer-ownership'
      && candidate.route?.methods?.post === true
    ));
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const response: any = { json: jest.fn() };
    const next = jest.fn();

    await handler({
      params: { id: 'target-owner' },
      user: { userId: 'current-owner', role: 'OWNER' },
      body: { confirmation: 'TRANSFER TO next-owner@example.com' },
    }, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(transferOwnershipMock).toHaveBeenCalledWith({
      sourceOwnerUserId: 'current-owner',
      targetUserId: 'target-owner',
      confirmation: 'TRANSFER TO next-owner@example.com',
    });
    expect(response.json).toHaveBeenCalledWith({ success: true });
  });
});
