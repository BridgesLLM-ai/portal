import fs from 'fs';
import os from 'os';
import path from 'path';

const mockTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-project-chat-abort-route-'));
const mockProjectsRoot = path.join(mockTempRoot, 'projects');
const mockActorUserId = 'project-chat-abort-owner';
const mockProjectName = 'abort-project';
const mockProjectRoot = path.join(mockProjectsRoot, mockActorUserId, mockProjectName);
const mockProjectIdentityId = 'project-chat-abort-identity';
const mockTurnId = 'project-chat-abort-turn';
const mockProviderSessionId = 'project-chat-abort-provider-session';
const mockRuntime = 'openclaw-dedicated-project-agent';
const mockPreviousEnvironment = new Map([
  ['DATABASE_URL', process.env.DATABASE_URL],
  ['PORTAL_PROJECTS_ROOT', process.env.PORTAL_PROJECTS_ROOT],
  ['APPS_ROOT', process.env.APPS_ROOT],
  ['PORTAL_PROJECT_ZIPS_ROOT', process.env.PORTAL_PROJECT_ZIPS_ROOT],
  ['PORTAL_UPLOAD_TEMP_ROOT', process.env.PORTAL_UPLOAD_TEMP_ROOT],
]);

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/portal_test';
process.env.PORTAL_PROJECTS_ROOT = mockProjectsRoot;
process.env.APPS_ROOT = path.join(mockTempRoot, 'apps');
process.env.PORTAL_PROJECT_ZIPS_ROOT = path.join(mockTempRoot, 'zips');
process.env.PORTAL_UPLOAD_TEMP_ROOT = path.join(mockTempRoot, 'uploads');
fs.mkdirSync(mockProjectRoot, { recursive: true });

let mockSelectedProvider = 'OPENCLAW';
let mockStateVersion = 7;
let mockTurnActive = true;
let mockBrokerSnapshot: Record<string, unknown> | null = null;

const mockReadProjectIdentity = jest.fn(async () => ({
  id: mockProjectIdentityId,
  workspaceOwnerId: mockActorUserId,
  projectName: mockProjectName,
  canonicalRoot: mockProjectRoot,
  rootDevice: '1',
  rootInode: '2',
  rootBirthtimeNs: '3',
  generation: 1,
  lifecycleStatus: 'ACTIVE',
  legacyOpenClawMigrationStatus: 'CURRENT',
  createdAt: new Date('2026-08-22T00:00:00.000Z'),
  updatedAt: new Date('2026-08-22T00:00:00.000Z'),
}));
const mockEnsureProjectChatState = jest.fn(async () => undefined);
const mockReadProjectChatCoordinationState = jest.fn(async () => ({
  state: {
    id: 'project-chat-abort-state',
    actorUserId: mockActorUserId,
    projectIdentityId: mockProjectIdentityId,
    selectedProvider: mockSelectedProvider,
    version: mockStateVersion,
    activeTurnId: mockTurnActive ? mockTurnId : null,
  },
  activeTurn: mockTurnActive ? {
    id: mockTurnId,
    actorUserId: mockActorUserId,
    projectIdentityId: mockProjectIdentityId,
    provider: 'OPENCLAW',
    runtime: mockRuntime,
    requestId: 'project-chat-abort-request',
    providerSessionId: mockProviderSessionId,
    status: 'RUNNING',
  } : null,
}));
const mockRequestProjectChatTurnAbort = jest.fn(async () => undefined);
const mockConfirmProjectChatTurnAbort = jest.fn(async () => {
  mockTurnActive = false;
  mockStateVersion += 1;
  return {
    id: mockTurnId,
    status: 'ABORTED',
  };
});
const mockReadExistingProjectChatBinding = jest.fn(async () => ({
  binding: {
    provider: 'OPENCLAW',
    runtime: mockRuntime,
    sessionKey: mockProviderSessionId,
    externalSessionId: null,
  },
  providerSessionKey: mockProviderSessionId,
}));
const mockAbortActiveRun = jest.fn(async () => true);
const mockGetProjectNativeRunSnapshot = jest.fn(() => mockBrokerSnapshot);
const mockAbortProjectNativeRun = jest.fn(async () => true);
const mockWaitForProjectNativeRunSettlement = jest.fn(async () => true);
const mockClearProjectNativeRun = jest.fn();

jest.mock('../services/projectIdentity', () => ({
  ...jest.requireActual('../services/projectIdentity'),
  readProjectIdentity: mockReadProjectIdentity,
}));

jest.mock('../services/projectChatKernel', () => ({
  ...jest.requireActual('../services/projectChatKernel'),
  buildUnqualifiedProjectSandboxExecutionContext: () => ({
    scope: 'PROJECT_SANDBOX',
    projectId: mockProjectIdentityId,
    actorUserId: mockActorUserId,
    workspaceOwnerId: mockActorUserId,
    projectName: mockProjectName,
    projectRoot: mockProjectRoot,
    policyFingerprint: 'project-chat-abort-policy',
  }),
  getProjectChatProviderCapability: (provider: string) => ({
    provider,
    displayName: provider === 'OPENCLAW' ? 'OpenClaw' : provider,
    runtime: mockRuntime,
    supportsAbort: true,
  }),
  serializeProjectSandboxContext: (context: Record<string, unknown>) => ({
    scope: context.scope,
    projectId: context.projectId,
    policyFingerprint: context.policyFingerprint,
  }),
}));

jest.mock('../services/projectChatTurnLease', () => ({
  ...jest.requireActual('../services/projectChatTurnLease'),
  ensureProjectChatState: mockEnsureProjectChatState,
  readProjectChatCoordinationState: mockReadProjectChatCoordinationState,
  requestProjectChatTurnAbort: mockRequestProjectChatTurnAbort,
  confirmProjectChatTurnAbort: mockConfirmProjectChatTurnAbort,
}));

jest.mock('../services/projectChatBindingRead', () => ({
  ...jest.requireActual('../services/projectChatBindingRead'),
  readExistingProjectChatBinding: mockReadExistingProjectChatBinding,
}));

jest.mock('../services/projectChatProviderRegistry', () => ({
  ...jest.requireActual('../services/projectChatProviderRegistry'),
  getProjectChatProviderAdapter: () => ({ abortActiveRun: mockAbortActiveRun }),
  getProjectChatProviderCleanupController: () => ({
    providerName: mockSelectedProvider,
    abortActiveRun: mockAbortActiveRun,
    terminateSession: jest.fn(),
  }),
  getProjectChatProviderRuntimeDescriptor: () => ({ runtime: mockRuntime }),
}));

jest.mock('../services/projectNativeRunBroker', () => ({
  ...jest.requireActual('../services/projectNativeRunBroker'),
  getProjectNativeRunSnapshot: mockGetProjectNativeRunSnapshot,
  abortProjectNativeRun: mockAbortProjectNativeRun,
  waitForProjectNativeRunSettlement: mockWaitForProjectNativeRunSettlement,
  clearProjectNativeRun: mockClearProjectNativeRun,
}));

const projectsRouter = require('../routes/projects').default;

function abortRouteHandler() {
  const layer = (projectsRouter as any).stack.find((candidate: any) => (
    candidate.route?.path === '/:name/assistant/abort'
    && candidate.route?.methods?.post === true
  ));
  expect(layer).toBeDefined();
  const handlers = layer.route.stack;
  return handlers[handlers.length - 1].handle as (req: any, res: any) => Promise<void>;
}

function response() {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

async function invoke(body: Record<string, unknown>) {
  const res = response();
  await abortRouteHandler()({
    user: { userId: mockActorUserId, role: 'OWNER' },
    params: { name: mockProjectName },
    body,
  }, res);
  return res;
}

describe('POST /api/projects/:name/assistant/abort behavioral boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectedProvider = 'OPENCLAW';
    mockStateVersion = 7;
    mockTurnActive = true;
    mockBrokerSnapshot = null;
    mockAbortActiveRun.mockResolvedValue(true);
  });

  afterAll(() => {
    fs.rmSync(mockTempRoot, { recursive: true, force: true });
    for (const [key, previous] of mockPreviousEnvironment) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  test('returns success only after the exact provider turn confirms cancellation', async () => {
    const res = await invoke({ provider: 'OPENCLAW', stateVersion: 7 });

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      aborted: true,
      provider: 'OPENCLAW',
      runtime: mockRuntime,
      turnId: mockTurnId,
      stateVersion: 8,
    }));
    expect(mockAbortActiveRun).toHaveBeenCalledWith(mockProviderSessionId, mockTurnId);
    expect(mockRequestProjectChatTurnAbort).toHaveBeenCalledWith(expect.objectContaining({
      turnId: mockTurnId,
      expectedProvider: 'OPENCLAW',
    }));
    expect(mockConfirmProjectChatTurnAbort).toHaveBeenCalledWith(expect.objectContaining({
      turnId: mockTurnId,
      providerSessionId: mockProviderSessionId,
    }));
  });

  test('keeps the durable turn active when the provider does not confirm cancellation', async () => {
    mockAbortActiveRun.mockResolvedValue(false);

    const res = await invoke({ provider: 'OPENCLAW', stateVersion: 7 });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PROJECT_CHAT_TURN_ACTIVE',
    }));
    expect(mockRequestProjectChatTurnAbort).toHaveBeenCalledTimes(1);
    expect(mockConfirmProjectChatTurnAbort).not.toHaveBeenCalled();
    expect(mockClearProjectNativeRun).not.toHaveBeenCalled();
    expect(mockTurnActive).toBe(true);
  });

  test('rejects a stale state-version CAS before requesting any abort', async () => {
    const res = await invoke({ provider: 'OPENCLAW', stateVersion: 6 });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PROJECT_CHAT_VERSION_CONFLICT',
    }));
    expect(mockReadExistingProjectChatBinding).not.toHaveBeenCalled();
    expect(mockRequestProjectChatTurnAbort).not.toHaveBeenCalled();
    expect(mockAbortActiveRun).not.toHaveBeenCalled();
  });

  test('rejects a provider mismatch before touching the selected provider turn', async () => {
    const res = await invoke({ provider: 'CODEX', stateVersion: 7 });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PROJECT_CHAT_PROVIDER_MISMATCH',
    }));
    expect(mockReadExistingProjectChatBinding).not.toHaveBeenCalled();
    expect(mockRequestProjectChatTurnAbort).not.toHaveBeenCalled();
    expect(mockAbortActiveRun).not.toHaveBeenCalled();
  });

  test('quarantines a process-local turn mismatch without clearing either run', async () => {
    mockBrokerSnapshot = {
      runId: 'different-project-chat-turn',
      sessionId: mockProviderSessionId,
      active: true,
      complete: false,
      status: 'running',
      events: [],
      updatedAt: Date.now(),
    };

    const res = await invoke({ provider: 'OPENCLAW', stateVersion: 7 });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PROJECT_CHAT_STATE_CORRUPT',
    }));
    expect(mockRequestProjectChatTurnAbort).not.toHaveBeenCalled();
    expect(mockAbortProjectNativeRun).not.toHaveBeenCalled();
    expect(mockAbortActiveRun).not.toHaveBeenCalled();
    expect(mockClearProjectNativeRun).not.toHaveBeenCalled();
  });
});
