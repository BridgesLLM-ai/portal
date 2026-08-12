import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { readProjectRuntimeRecoveryStatus } from '../services/projectRuntimeRecoveryReplay';

const mockTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-project-runtime-routes-'));
const mockProjectsRoot = path.join(mockTempRoot, 'projects');
const mockOwnerId = 'runtime-owner';
const mockProjectName = 'runtime-project';
const mockProjectRoot = path.join(mockProjectsRoot, mockOwnerId, mockProjectName);
fs.mkdirSync(mockProjectRoot, { recursive: true });

const mockEnvironmentKeys = [
  'DATABASE_URL',
  'PORTAL_PROJECTS_ROOT',
  'APPS_ROOT',
  'PORTAL_PROJECT_ZIPS_ROOT',
  'PORTAL_UPLOAD_TEMP_ROOT',
] as const;
const mockPreviousEnvironment = new Map(
  mockEnvironmentKeys.map((key) => [key, process.env[key]]),
);

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:5432/portal_test';
process.env.PORTAL_PROJECTS_ROOT = mockProjectsRoot;
process.env.APPS_ROOT = path.join(mockTempRoot, 'apps');
process.env.PORTAL_PROJECT_ZIPS_ROOT = path.join(mockTempRoot, 'zips');
process.env.PORTAL_UPLOAD_TEMP_ROOT = path.join(mockTempRoot, 'uploads');

let mockApp: any;
let mockIdentity: any;
const mockStartApp = jest.fn();
const mockStopApp = jest.fn();
const mockRestartApp = jest.fn();
const mockForgetAppRuntime = jest.fn();
const mockGetAppStatus = jest.fn();
const mockDetectDeployType = jest.fn(() => 'static');
const mockAllocatePort = jest.fn(async () => 5002);
const mockAppFindMany = jest.fn(async () => mockApp ? [mockApp] : []);
const mockAppUpdateMany = jest.fn(async () => ({ count: 1 }));
const mockAppDeleteMany = jest.fn(async () => ({ count: 1 }));
const mockAppCount = jest.fn(async () => 0);
const mockAppUpdate = jest.fn(async ({ data }: any) => {
  mockApp = { ...mockApp, ...data };
  return mockApp;
});
const mockAppFindFirst = jest.fn(async () => mockApp);
const mockActivityCreate = jest.fn(async () => ({}));
const mockAssertLegacyOpenClawProjectMigrationInactive = jest.fn(async () => undefined);
const mockAssertProjectRuntimeImageAvailable = jest.fn(async () => (
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
));
const mockPrepareFullstackDeploymentTree = jest.fn();
const mockRecoveryProof = 'v1.11111111-1111-4111-8111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const mockReadDeploymentRevision = jest.fn(async () => ({ deploymentRevision: '0' }));
const mockAdvanceDeploymentRevision = jest.fn(async () => ({ deploymentRevision: '1' }));
const mockIssueRecoveryProof = jest.fn(async () => ({
  proof: mockRecoveryProof,
  operationId: '11111111-1111-4111-8111-111111111111',
  deploymentRevision: '0',
  expiresAt: new Date('2026-08-09T02:00:00.000Z'),
}));
const mockReadRecoveryStatus: jest.MockedFunction<typeof readProjectRuntimeRecoveryStatus> = jest.fn(async (_input) => ({
  kind: 'issued' as const,
  operationId: '11111111-1111-4111-8111-111111111111',
  deploymentRevision: '0',
  expiresAt: new Date('2026-08-09T02:00:00.000Z'),
}));
const mockClaimRecoveryProof = jest.fn(async () => ({
  kind: 'claimed' as const,
  operationId: '11111111-1111-4111-8111-111111111111',
  deploymentRevision: '1',
}));
const mockCompleteRecovery = jest.fn(async ({ response }: any) => response);
const mockFailRecovery = jest.fn(async () => ({
  kind: 'failed' as const,
  operationId: '11111111-1111-4111-8111-111111111111',
  deploymentRevision: '1',
  failureCode: 'PROJECT_RUNTIME_TEST_FAILED',
}));
class MockProjectRuntimeStateAttestationError extends Error {
  readonly code = 'PROJECT_RUNTIME_STATE_ATTESTATION_FAILED';
  readonly retryable = false;
}

const mockPrisma = {
  $queryRaw: jest.fn(async () => []),
  projectIdentity: {
    findUnique: jest.fn(async () => mockIdentity),
    findFirst: jest.fn(async () => null),
    create: jest.fn(),
  },
  app: {
    findMany: mockAppFindMany,
    findFirst: mockAppFindFirst,
    updateMany: mockAppUpdateMany,
    deleteMany: mockAppDeleteMany,
    count: mockAppCount,
    update: mockAppUpdate,
  },
  activityLog: { create: mockActivityCreate },
};

jest.mock('../config/database', () => ({ prisma: mockPrisma }));
jest.mock('../utils/workspaceScope', () => ({
  getWorkspaceOwnerId: jest.fn(async (user: any) => user.userId),
}));
jest.mock('../utils/portalFeatureCapabilities', () => ({
  portalFeatureUnavailableResponse: jest.fn(() => null),
}));
jest.mock('../services/app-process.service', () => ({
  detectDeployType: mockDetectDeployType,
  allocatePort: mockAllocatePort,
  startApp: mockStartApp,
  restartApp: mockRestartApp,
  stopApp: mockStopApp,
  forgetAppRuntime: mockForgetAppRuntime,
  getAppStatus: mockGetAppStatus,
  ProjectRuntimeStateAttestationError: MockProjectRuntimeStateAttestationError,
}));
jest.mock('../services/project-lifecycle.service', () => {
  const actual = jest.requireActual('../services/project-lifecycle.service');
  mockPrepareFullstackDeploymentTree.mockImplementation(actual.prepareFullstackDeploymentTree);
  return {
    ...actual,
    assertProjectRuntimeImageAvailable: mockAssertProjectRuntimeImageAvailable,
    prepareFullstackDeploymentTree: mockPrepareFullstackDeploymentTree,
  };
});
jest.mock('../services/projectRuntimeRecoveryReplay', () => ({
  ...jest.requireActual('../services/projectRuntimeRecoveryReplay'),
  readProjectDeploymentLifecycleRevision: mockReadDeploymentRevision,
  advanceProjectDeploymentLifecycleRevision: mockAdvanceDeploymentRevision,
  issueProjectRuntimeRecoveryProof: mockIssueRecoveryProof,
  readProjectRuntimeRecoveryStatus: mockReadRecoveryStatus,
  claimProjectRuntimeRecoveryProof: mockClaimRecoveryProof,
  completeProjectRuntimeRecovery: mockCompleteRecovery,
  failProjectRuntimeRecovery: mockFailRecovery,
}));
jest.mock('../services/legacyOpenClawProjectRetirement', () => ({
  ...jest.requireActual('../services/legacyOpenClawProjectRetirement'),
  assertLegacyOpenClawProjectMigrationInactive: mockAssertLegacyOpenClawProjectMigrationInactive,
}));

const { attestProjectRoot } = require('../services/projectIdentity') as typeof import('../services/projectIdentity');
const projectsRouter = require('../routes/projects').default;

function appProcessHandler() {
  const layer = (projectsRouter as any).stack.find((candidate: any) => (
    candidate.route?.path === '/:name/app-process'
    && candidate.route?.methods?.post === true
  ));
  expect(layer).toBeDefined();
  const handlers = layer.route.stack;
  return handlers[handlers.length - 1].handle as (req: any, res: any) => Promise<void>;
}

function routeHandler(method: 'post' | 'delete', routePath: string) {
  const layer = (projectsRouter as any).stack.find((candidate: any) => (
    candidate.route?.path === routePath
    && candidate.route?.methods?.[method] === true
  ));
  expect(layer).toBeDefined();
  const handlers = layer.route.stack;
  return handlers[handlers.length - 1].handle as (req: any, res: any) => Promise<void>;
}

function response() {
  const res: any = { status: jest.fn(), json: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

async function invoke(action: string, recoveryReplay?: Record<string, unknown>) {
  const res = response();
  await appProcessHandler()({
    user: { userId: mockOwnerId, role: 'OWNER' },
    params: { name: mockProjectName },
    body: { action, ...(recoveryReplay ? { recoveryReplay } : {}) },
  }, res);
  return res;
}

describe('Project runtime management HTTP boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.APP_API_TARGET_APP_PORTAL;
    delete process.env.APP_API_TARGET_APP_EXTERNAL;
    const root = attestProjectRoot(mockProjectRoot);
    mockIdentity = {
      id: 'project-runtime-identity',
      workspaceOwnerId: mockOwnerId,
      projectName: mockProjectName,
      canonicalRoot: root.canonicalRoot,
      rootDevice: root.rootDevice,
      rootInode: root.rootInode,
      rootBirthtimeNs: root.rootBirthtimeNs,
      generation: 1,
      lifecycleStatus: 'ACTIVE',
      legacyOpenClawMigrationStatus: 'CURRENT',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockApp = {
      id: 'app-portal',
      userId: mockOwnerId,
      projectIdentityId: mockIdentity.id,
      name: mockProjectName,
      zipPath: mockProjectRoot,
      port: 5002,
      deployType: 'fullstack',
      processStatus: 'running',
      isActive: true,
      updatedAt: new Date('2026-08-09T01:02:03.004Z'),
    };
    mockStartApp.mockResolvedValue({});
    mockStopApp.mockResolvedValue(undefined);
    mockRestartApp.mockResolvedValue({});
    mockForgetAppRuntime.mockResolvedValue(undefined);
    mockGetAppStatus.mockReturnValue(null);
    mockAssertProjectRuntimeImageAvailable.mockReset().mockResolvedValue(
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    mockPrepareFullstackDeploymentTree.mockClear();
    mockReadDeploymentRevision.mockReset().mockResolvedValue({ deploymentRevision: '0' });
    mockAdvanceDeploymentRevision.mockReset().mockResolvedValue({ deploymentRevision: '1' });
    mockIssueRecoveryProof.mockClear();
    mockReadRecoveryStatus.mockReset().mockResolvedValue({
      kind: 'issued',
      operationId: '11111111-1111-4111-8111-111111111111',
      deploymentRevision: '0',
      expiresAt: new Date('2026-08-09T02:00:00.000Z'),
    });
    mockClaimRecoveryProof.mockReset().mockResolvedValue({
      kind: 'claimed',
      operationId: '11111111-1111-4111-8111-111111111111',
      deploymentRevision: '1',
    });
    mockCompleteRecovery.mockClear();
    mockFailRecovery.mockClear();
    mockAssertLegacyOpenClawProjectMigrationInactive.mockReset().mockResolvedValue(undefined);
    fs.rmSync(path.join(mockTempRoot, 'apps'), { recursive: true, force: true });
    fs.mkdirSync(path.join(mockTempRoot, 'apps'), { recursive: true });
    fs.writeFileSync(
      path.join(mockProjectRoot, 'package.json'),
      JSON.stringify({ scripts: { start: 'node server.js' } }),
    );
    mockDetectDeployType.mockReturnValue('static');
  });

  afterAll(() => {
    delete process.env.APP_API_TARGET_APP_PORTAL;
    delete process.env.APP_API_TARGET_APP_EXTERNAL;
    fs.rmSync(mockTempRoot, { recursive: true, force: true });
    for (const key of mockEnvironmentKeys) {
      const previous = mockPreviousEnvironment.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  test('rejects a partial Project delete identity proof before reading or mutating Project state', async () => {
    const res = response();

    await routeHandler('delete', '/:name')({
      user: { userId: mockOwnerId, role: 'OWNER' },
      params: { name: mockProjectName },
      body: { projectIdentityId: mockIdentity.id },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'An exact immutable Project identity proof requires projectIdentityId and projectGeneration.',
      code: 'PROJECT_DELETE_IDENTITY_REQUIRED',
      status: 'not_admitted',
      admitted: false,
      retryable: false,
    });
    expect(mockPrisma.projectIdentity.findUnique).not.toHaveBeenCalled();
    expect(mockStartApp).not.toHaveBeenCalled();
    expect(mockStopApp).not.toHaveBeenCalled();
    expect(mockForgetAppRuntime).not.toHaveBeenCalled();
    expect(mockAppUpdate).not.toHaveBeenCalled();
    expect(mockAppDeleteMany).not.toHaveBeenCalled();
  });

  test('rejects a stale Project delete identity proof before lifecycle admission', async () => {
    const res = response();

    await routeHandler('delete', '/:name')({
      user: { userId: mockOwnerId, role: 'OWNER' },
      params: { name: mockProjectName },
      body: {
        projectIdentityId: 'replacement-project-identity',
        projectGeneration: mockIdentity.generation,
      },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'The Project identity changed before deletion admission. Refresh Projects before trying again.',
      code: 'PROJECT_DELETE_IDENTITY_MISMATCH',
      status: 'not_admitted',
      admitted: false,
      retryable: false,
    });
    expect(mockStartApp).not.toHaveBeenCalled();
    expect(mockStopApp).not.toHaveBeenCalled();
    expect(mockForgetAppRuntime).not.toHaveBeenCalled();
    expect(mockAppUpdate).not.toHaveBeenCalled();
    expect(mockAppDeleteMany).not.toHaveBeenCalled();
    expect(mockActivityCreate).not.toHaveBeenCalled();
  });

  test('rejects a same-name replacement that appears after the Project delete lock is acquired', async () => {
    const replacementIdentity = {
      ...mockIdentity,
      id: 'replacement-project-identity',
      generation: 1,
    };
    mockPrisma.projectIdentity.findUnique
      .mockResolvedValueOnce(mockIdentity)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(replacementIdentity);
    const res = response();

    await routeHandler('delete', '/:name')({
      user: { userId: mockOwnerId, role: 'OWNER' },
      params: { name: mockProjectName },
      body: {
        projectIdentityId: mockIdentity.id,
        projectGeneration: mockIdentity.generation,
      },
    }, res);

    expect(mockPrisma.projectIdentity.findUnique).toHaveBeenCalledTimes(3);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PROJECT_DELETE_IDENTITY_MISMATCH',
      status: 'not_admitted',
      admitted: false,
      retryable: false,
    }));
    expect(mockAppFindFirst).not.toHaveBeenCalled();
    expect(mockStartApp).not.toHaveBeenCalled();
    expect(mockStopApp).not.toHaveBeenCalled();
    expect(mockForgetAppRuntime).not.toHaveBeenCalled();
    expect(mockAppUpdate).not.toHaveBeenCalled();
    expect(mockAppDeleteMany).not.toHaveBeenCalled();
    expect(mockActivityCreate).not.toHaveBeenCalled();
  });

  test('rejects generation drift on the locked Project delete reread', async () => {
    mockPrisma.projectIdentity.findUnique
      .mockResolvedValueOnce(mockIdentity)
      .mockResolvedValueOnce({ ...mockIdentity, generation: mockIdentity.generation + 1 });
    const res = response();

    await routeHandler('delete', '/:name')({
      user: { userId: mockOwnerId, role: 'OWNER' },
      params: { name: mockProjectName },
      body: {
        projectIdentityId: mockIdentity.id,
        projectGeneration: mockIdentity.generation,
      },
    }, res);

    expect(mockPrisma.projectIdentity.findUnique).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PROJECT_DELETE_IDENTITY_MISMATCH',
      status: 'not_admitted',
      admitted: false,
      retryable: false,
    }));
    expect(mockAppFindFirst).not.toHaveBeenCalled();
    expect(mockStartApp).not.toHaveBeenCalled();
    expect(mockStopApp).not.toHaveBeenCalled();
    expect(mockForgetAppRuntime).not.toHaveBeenCalled();
    expect(mockAppUpdate).not.toHaveBeenCalled();
    expect(mockAppDeleteMany).not.toHaveBeenCalled();
    expect(mockActivityCreate).not.toHaveBeenCalled();
  });

  test('external process mutations return structured 409 before any Portal manager call', async () => {
    mockApp.id = 'app-external';
    process.env.APP_API_TARGET_APP_EXTERNAL = 'http://127.0.0.1:5999';

    for (const action of ['start', 'stop', 'restart']) {
      const res = await invoke(action);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'PROJECT_RUNTIME_EXTERNALLY_MANAGED',
        runtimeManagement: 'external-loopback',
        supportedActions: [],
        action,
        retryable: false,
      }));
    }

    expect(mockGetAppStatus).not.toHaveBeenCalled();
    expect(mockStartApp).not.toHaveBeenCalled();
    expect(mockStopApp).not.toHaveBeenCalled();
    expect(mockRestartApp).not.toHaveBeenCalled();
    expect(mockForgetAppRuntime).not.toHaveBeenCalled();
    expect(mockAppUpdateMany).not.toHaveBeenCalled();
  });

  test('external status is a bounded read-only availability result with no manager call', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP test server did not bind');
    mockApp.id = 'app-external';
    process.env.APP_API_TARGET_APP_EXTERNAL = `http://127.0.0.1:${address.port}`;

    try {
      const res = await invoke('status');
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        status: 'running',
        statusSource: 'external-binding',
        runtimeManagement: 'external-loopback',
        supportedActions: [],
        logs: [],
      }));
      expect(mockGetAppStatus).not.toHaveBeenCalled();
      expect(mockStartApp).not.toHaveBeenCalled();
      expect(mockStopApp).not.toHaveBeenCalled();
      expect(mockRestartApp).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('present but invalid binding returns a safe unavailable state without manager fallback', async () => {
    process.env.APP_API_TARGET_APP_PORTAL = '   ';

    for (const action of ['status', 'start']) {
      const res = await invoke(action);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'PROJECT_RUNTIME_BINDING_INVALID',
        runtimeManagement: 'external-loopback',
        bindingStatus: 'invalid',
        supportedActions: [],
        retryable: false,
      }));
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('APP_API_TARGET_');
    }

    expect(mockGetAppStatus).not.toHaveBeenCalled();
    expect(mockStartApp).not.toHaveBeenCalled();
    expect(mockStopApp).not.toHaveBeenCalled();
    expect(mockForgetAppRuntime).not.toHaveBeenCalled();
    expect(mockAppUpdateMany).not.toHaveBeenCalled();
  });

  test('missing manager state preserves active intent and advertises only recovery actions', async () => {
    const res = await invoke('status');

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'unknown',
      persistedStatus: 'running',
      statusSource: 'persisted-app',
      recoveryRequired: true,
      runtimeManagement: 'portal-container',
      supportedActions: ['start', 'stop', 'status'],
    }));
    expect(mockStartApp).not.toHaveBeenCalled();
    expect(mockStopApp).not.toHaveBeenCalled();
    expect(mockRestartApp).not.toHaveBeenCalled();
  });

  test('missing manager state preserves a persisted error instead of fabricating stopped', async () => {
    mockApp.processStatus = 'error';
    const res = await invoke('status');

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      persistedStatus: 'error',
      statusSource: 'persisted-app',
      recoveryRequired: false,
      supportedActions: ['start', 'status'],
    }));
  });

  test('Stop delegates exact App settlement to the fenced runtime cleanup', async () => {
    const res = await invoke('stop');

    expect(mockForgetAppRuntime).toHaveBeenCalledWith(
      mockApp.id,
      `${mockOwnerId}-${mockProjectName}`,
      {
        actorId: mockOwnerId,
        projectId: mockIdentity.id,
        deployPath: mockApp.zipPath,
        port: mockApp.port,
      },
      { settleStatus: 'stopped' },
    );
    expect(mockAppUpdateMany).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'stopped',
      persistedStatus: 'stopped',
      statusSource: 'persisted-app',
      recoveryRequired: false,
      supportedActions: ['start', 'status'],
    }));
  });

  test('Stop does not settle App status when durable runtime attestation fails', async () => {
    mockForgetAppRuntime.mockRejectedValueOnce(new MockProjectRuntimeStateAttestationError());

    const res = await invoke('stop');

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PROJECT_RUNTIME_STATE_ATTESTATION_FAILED',
      recoveryAction: 'REVIEW_RUNTIME_STATE',
    }));
    expect(mockAppUpdateMany).not.toHaveBeenCalled();
  });

  test('a delayed Start owns the shared Project lock until undeploy can re-read and mutate', async () => {
    let releaseStart: (() => void) | undefined;
    mockStartApp.mockImplementationOnce(() => new Promise((resolve) => {
      releaseStart = () => resolve({});
    }));
    const startResponse = response();
    const startPromise = appProcessHandler()({
      user: { userId: mockOwnerId, role: 'OWNER' },
      params: { name: mockProjectName },
      body: { action: 'start' },
    }, startResponse);
    for (let attempt = 0; attempt < 20 && !releaseStart; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(releaseStart).toBeDefined();

    const undeployResponse = response();
    const undeployPromise = routeHandler('delete', '/:name/deploy')({
      user: { userId: mockOwnerId, role: 'OWNER' },
      params: { name: mockProjectName },
      body: {},
    }, undeployResponse);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockForgetAppRuntime).not.toHaveBeenCalled();
    expect(mockAppDeleteMany).not.toHaveBeenCalled();

    releaseStart?.();
    await startPromise;
    await undeployPromise;

    expect(startResponse.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }));
    expect(mockForgetAppRuntime).toHaveBeenCalledWith(
      mockApp.id,
      `${mockOwnerId}-${mockProjectName}`,
      {
        actorId: mockOwnerId,
        projectId: mockIdentity.id,
        deployPath: mockApp.zipPath,
        port: mockApp.port,
      },
      { settleStatus: 'stopped' },
    );
    expect(mockAppDeleteMany).toHaveBeenCalledWith({
      where: {
        id: mockApp.id,
        projectIdentityId: mockIdentity.id,
        userId: mockOwnerId,
      },
    });
    expect(undeployResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Project deployment removed',
      sourcePreserved: true,
    }));
  });

  test('missing runtime image maps to a safe structured 503 without exposing its digest', async () => {
    mockApp.processStatus = 'stopped';
    mockAssertProjectRuntimeImageAvailable.mockRejectedValueOnce(Object.assign(
      new Error('sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa missing'),
      { code: 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE' },
    ));

    const res = await invoke('start');

    expect(res.status).toHaveBeenCalledWith(503);
    const payload = res.json.mock.calls[0][0];
    expect(payload).toEqual(expect.objectContaining({
      code: 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE',
      retryable: true,
      recoveryAction: 'REPAIR_PROJECT_RUNTIME_IMAGE',
      recoveryReplay: {
        proof: mockRecoveryProof,
        action: 'start',
        projectIdentity: {
          id: mockIdentity.id,
          generation: mockIdentity.generation,
        },
        expectedAppId: mockApp.id,
      },
    }));
    expect(JSON.stringify(payload)).not.toContain('sha256:');
    expect(JSON.stringify(payload)).not.toContain('aaaaaaaa');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });

  test('rejects malformed and stale runtime-repair replay proofs before manager mutation', async () => {
    mockApp.processStatus = 'stopped';

    const malformed = await invoke('start', {
      action: 'start',
      projectIdentity: { id: mockIdentity.id, generation: mockIdentity.generation },
      expectedAppId: mockApp.id,
      expectedAppUpdatedAt: mockApp.updatedAt.toISOString(),
      unexpected: true,
    });
    expect(malformed.status).toHaveBeenCalledWith(400);
    expect(malformed.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PROJECT_RUNTIME_RECOVERY_REPLAY_INVALID',
      retryable: false,
    }));

    const stale = await invoke('start', {
      proof: mockRecoveryProof,
      action: 'start',
      projectIdentity: { id: mockIdentity.id, generation: mockIdentity.generation + 1 },
      expectedAppId: mockApp.id,
    });
    expect(stale.status).toHaveBeenCalledWith(409);
    expect(stale.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PROJECT_RUNTIME_RECOVERY_REPLAY_STALE',
      retryable: false,
    }));
    expect(mockStartApp).not.toHaveBeenCalled();
  });

  test('accepts the exact current runtime-repair replay proof for only its bound Start action', async () => {
    mockApp.processStatus = 'stopped';
    const recoveryReplay = {
      proof: mockRecoveryProof,
      action: 'start',
      projectIdentity: { id: mockIdentity.id, generation: mockIdentity.generation },
      expectedAppId: mockApp.id,
    };

    const res = await invoke('start', recoveryReplay);

    expect(res.status).not.toHaveBeenCalled();
    expect(mockStartApp).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }));
  });

  test('rejects a process recovery proof bound to a different Project identity', async () => {
    mockApp.processStatus = 'stopped';
    const res = await invoke('start', {
      proof: mockRecoveryProof,
      action: 'start',
      projectIdentity: { id: 'project-from-another-route', generation: mockIdentity.generation },
      expectedAppId: mockApp.id,
    });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PROJECT_RUNTIME_RECOVERY_REPLAY_STALE',
      retryable: false,
    }));
    expect(mockReadRecoveryStatus).not.toHaveBeenCalled();
    expect(mockClaimRecoveryProof).not.toHaveBeenCalled();
    expect(mockStartApp).not.toHaveBeenCalled();
  });

  test('returns a completed receipt for the same Project without re-executing after App drift', async () => {
    const completion = {
      statusCode: 200 as const,
      body: {
        success: true as const,
        action: 'start' as const,
        projectIdentityId: mockIdentity.id,
        projectIdentityGeneration: mockIdentity.generation,
        appId: 'app-from-completed-operation',
        deploymentRevision: '4',
      },
    };
    mockReadRecoveryStatus.mockResolvedValueOnce({
      kind: 'completed',
      operationId: '11111111-1111-4111-8111-111111111111',
      deploymentRevision: '4',
      result: completion,
    });

    const res = await invoke('start', {
      proof: mockRecoveryProof,
      action: 'start',
      projectIdentity: { id: mockIdentity.id, generation: mockIdentity.generation },
      expectedAppId: 'app-from-completed-operation',
    });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(completion.body);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(mockClaimRecoveryProof).not.toHaveBeenCalled();
    expect(mockStartApp).not.toHaveBeenCalled();
  });

  test('rejects a first-deploy proof from another Project before preparing identical source', async () => {
    mockDetectDeployType.mockReturnValue('fullstack');
    mockApp = null;
    const res = response();
    await routeHandler('post', '/:name/deploy')({
      user: { userId: mockOwnerId, role: 'OWNER' },
      params: { name: mockProjectName },
      body: {
        recoveryReplay: {
          proof: mockRecoveryProof,
          action: 'deploy',
          projectIdentity: { id: 'project-from-another-route', generation: mockIdentity.generation },
          expectedAppId: null,
          expectedDeployType: 'fullstack',
          sourceDigest: 'a'.repeat(64),
        },
      },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PROJECT_RUNTIME_RECOVERY_REPLAY_STALE',
    }));
    expect(mockReadRecoveryStatus).not.toHaveBeenCalled();
    expect(mockPrepareFullstackDeploymentTree).not.toHaveBeenCalled();
    expect(mockClaimRecoveryProof).not.toHaveBeenCalled();
  });

  test('fullstack deploy preserves runtime-image identity through rollback and returns safe 503', async () => {
    mockDetectDeployType.mockReturnValue('fullstack');
    mockApp.processStatus = 'stopped';
    mockAssertProjectRuntimeImageAvailable.mockRejectedValueOnce(Object.assign(
      new Error('sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb missing'),
      { code: 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE' },
    ));
    const res = response();

    await routeHandler('post', '/:name/deploy')({
      user: { userId: mockOwnerId, role: 'OWNER' },
      params: { name: mockProjectName },
      body: {},
    }, res);

    expect(res.status).toHaveBeenCalledWith(503);
    const payload = res.json.mock.calls[0][0];
    expect(payload).toEqual(expect.objectContaining({
      code: 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE',
      retryable: true,
      recoveryAction: 'REPAIR_PROJECT_RUNTIME_IMAGE',
      recoveryReplay: expect.objectContaining({
        proof: mockRecoveryProof,
        action: 'deploy',
        projectIdentity: {
          id: mockIdentity.id,
          generation: mockIdentity.generation,
        },
        expectedAppId: mockApp.id,
        expectedDeployType: 'fullstack',
        sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));
    expect(JSON.stringify(payload)).not.toContain('sha256:');
    expect(JSON.stringify(payload)).not.toContain('bbbbbbbb');
  });

  test('does not issue a replay proof when missing-image promotion rollback is indeterminate', async () => {
    mockDetectDeployType.mockReturnValue('fullstack');
    mockApp.processStatus = 'stopped';
    mockPrepareFullstackDeploymentTree.mockImplementationOnce(() => ({
      sourceDigest: 'c'.repeat(64),
      promote: jest.fn(),
      finalize: jest.fn(),
      rollback: jest.fn(() => { throw new Error('rollback fixture failed'); }),
    }));
    mockAssertProjectRuntimeImageAvailable.mockRejectedValueOnce(Object.assign(
      new Error('runtime image missing'),
      { code: 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE' },
    ));
    const res = response();

    await routeHandler('post', '/:name/deploy')({
      user: { userId: mockOwnerId, role: 'OWNER' },
      params: { name: mockProjectName },
      body: {},
    }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PROJECT_RUNTIME_RECOVERY_PROOF_UNAVAILABLE',
      retryable: false,
    }));
    expect(mockIssueRecoveryProof).not.toHaveBeenCalled();
  });

  test.each([
    ['fullstack', 'static'],
    ['fullstack', 'runtime'],
    ['runtime', 'static'],
    ['runtime', 'fullstack'],
    ['static', 'fullstack'],
    ['static', 'runtime'],
  ] as const)(
    'requires identity-attested undeploy before changing deployment type from %s to %s',
    async (priorDeployType, nextDeployType) => {
      mockApp.deployType = priorDeployType;
      mockDetectDeployType.mockReturnValue(nextDeployType);
      const sourceBefore = fs.readFileSync(path.join(mockProjectRoot, 'package.json'));
      const res = response();

      await routeHandler('post', '/:name/deploy')({
        user: { userId: mockOwnerId, role: 'OWNER' },
        params: { name: mockProjectName },
        body: {},
      }, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        code: 'PROJECT_DEPLOY_TYPE_TRANSITION_REQUIRES_UNDEPLOY',
        error: `This Project is already deployed as ${priorDeployType}. Remove the current deployment before deploying it as ${nextDeployType}.`,
        detail: 'Removing the deployment stops and clears its current runtime while preserving the Project source. You can then deploy the new type.',
        priorDeployType,
        nextDeployType,
        recoveryAction: 'UNDEPLOY_CURRENT_DEPLOYMENT',
        retryable: false,
      });
      expect(mockStartApp).not.toHaveBeenCalled();
      expect(mockStopApp).not.toHaveBeenCalled();
      expect(mockRestartApp).not.toHaveBeenCalled();
      expect(mockForgetAppRuntime).not.toHaveBeenCalled();
      expect(mockAllocatePort).not.toHaveBeenCalled();
      expect(mockAppUpdate).not.toHaveBeenCalled();
      expect(mockAppUpdateMany).not.toHaveBeenCalled();
      expect(mockAppDeleteMany).not.toHaveBeenCalled();
      expect(mockActivityCreate).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(mockProjectRoot, 'package.json'))).toEqual(sourceBefore);
    },
  );

  test('rechecks deployment type after immutable identity enrollment before any mutation', async () => {
    mockApp.deployType = 'fullstack';
    mockDetectDeployType.mockReturnValue('static');
    mockAppFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([mockApp]);
    const res = response();

    await routeHandler('post', '/:name/deploy')({
      user: { userId: mockOwnerId, role: 'OWNER' },
      params: { name: mockProjectName },
      body: {},
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PROJECT_DEPLOY_TYPE_TRANSITION_REQUIRES_UNDEPLOY',
      priorDeployType: 'fullstack',
      nextDeployType: 'static',
      recoveryAction: 'UNDEPLOY_CURRENT_DEPLOYMENT',
    }));
    expect(mockStartApp).not.toHaveBeenCalled();
    expect(mockStopApp).not.toHaveBeenCalled();
    expect(mockForgetAppRuntime).not.toHaveBeenCalled();
    expect(mockAllocatePort).not.toHaveBeenCalled();
    expect(mockAppUpdate).not.toHaveBeenCalled();
    expect(mockActivityCreate).not.toHaveBeenCalled();
  });
});
