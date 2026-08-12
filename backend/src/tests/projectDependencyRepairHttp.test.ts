import { EventEmitter } from 'events';
import http from 'http';
import express from 'express';

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/portal_test';

const mockInspectStatus = jest.fn();
const mockListActive = jest.fn(async (_input?: any) => []);
const mockInspectBackup = jest.fn();
const mockPrepareRepairEvidence = jest.fn((_input?: any): any => undefined);
const mockAcquireBackupMutationLock = jest.fn(async (_input?: any): Promise<any> => undefined);
const mockAcquireProjectLock = jest.fn(async (_input?: any): Promise<any> => undefined);
const mockCloseWriterFence = jest.fn((_input?: any): any => undefined);
const mockReleaseRepairBackupLock = jest.fn((_input?: any): any => undefined);

const mockPrisma = {
  projectIdentity: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  app: { findMany: jest.fn(async () => []) },
  user: { findFirst: jest.fn() },
  activityLog: { create: jest.fn(), updateMany: jest.fn() },
  $queryRaw: jest.fn(async () => []),
};

jest.mock('../config/database', () => ({ prisma: mockPrisma }));
jest.mock('../utils/workspaceScope', () => ({
  getWorkspaceOwnerId: jest.fn(async (user: any) => user.userId),
}));
jest.mock('../middleware/auth', () => ({
  browserAuthRedirect: (_req: any, _res: any, next: () => void) => next(),
  authenticateToken: (req: any, res: any, next: () => void) => {
    const bearer = String(req.headers.authorization || '');
    const base = {
      userId: 'repair-owner',
      email: 'repair-owner@example.invalid',
      accountStatus: 'ACTIVE',
      authorizationVersion: 11,
      sandboxEnabled: false,
    };
    if (bearer === 'Bearer owner') {
      req.user = {
        ...base,
        role: 'OWNER',
        sessionId: 'repair-session',
        sessionExpiresAt: new Date(Date.now() + 60_000),
      };
      next();
      return;
    }
    if (bearer === 'Bearer owner-stale-version') {
      res.status(409).json({
        error: 'Workspace authorization changed. Reload the Portal before continuing.',
        code: 'WORKSPACE_SCOPE_CHANGED',
        authorizationVersion: 11,
      });
      return;
    }
    if (bearer === 'Bearer owner-no-session') {
      req.user = { ...base, role: 'OWNER' };
      next();
      return;
    }
    if (bearer === 'Bearer owner-expired') {
      req.user = {
        ...base,
        role: 'OWNER',
        sessionId: 'expired-session',
        sessionExpiresAt: new Date(Date.now() - 1),
      };
      next();
      return;
    }
    if (bearer === 'Bearer user') {
      req.user = {
        ...base,
        role: 'USER',
        sessionId: 'user-session',
        sessionExpiresAt: new Date(Date.now() + 60_000),
      };
      next();
      return;
    }
    res.status(401).json({ error: 'Access token required' });
  },
}));
jest.mock('../services/projectDependencyRepair', () => ({
  ...jest.requireActual('../services/projectDependencyRepair'),
  inspectProjectDependencyRepairStatus: (input: any) => mockInspectStatus(input),
  listActiveProjectDependencyRepairsForOwner: (input: any) => mockListActive(input),
  normalizeProjectDependencyRepairBackup: jest.fn((input: any) => ({
    path: input.path,
    filename: input.filename,
    device: input.device,
    inode: input.inode,
    size: input.size,
    mtimeNs: input.mtimeNs,
    receiptDigest: input.receiptDigest,
    fingerprintDigest: input.fingerprintDigest,
  })),
  attestProjectDependencyRepairBackupFingerprint: jest.fn(() => true),
  prepareProjectDependencyRepairEvidence: (input: any) => mockPrepareRepairEvidence(input),
  releaseProjectDependencyRepairBackupLock: (input: any) => mockReleaseRepairBackupLock(input),
}));
jest.mock('../services/backup.service', () => ({
  ...jest.requireActual('../services/backup.service'),
  acquireBackupMutationLock: (input?: any) => mockAcquireBackupMutationLock(input),
}));
jest.mock('../services/projectDeletionLock', () => ({
  ...jest.requireActual('../services/projectDeletionLock'),
  acquireProjectDeletionLockWithoutGuard: (input?: any) => mockAcquireProjectLock(input),
}));
jest.mock('../services/projectDependencyPromotionWriterFence', () => ({
  ...jest.requireActual('../services/projectDependencyPromotionWriterFence'),
  closeProjectDependencyPromotionWriterFence: (input?: any) => mockCloseWriterFence(input),
}));
jest.mock('../routes/system-maintenance', () => ({
  ...jest.requireActual('../routes/system-maintenance'),
  inspectMaintenanceBackupAdmission: (...args: any[]) => mockInspectBackup(...args),
  verifyMaintenanceBackupArchive: jest.fn(async () => true),
}));

const projectsRouter = require('../routes/projects').default;
const { __projectDependencyRepairRouteTest } = require('../routes/projects') as typeof import('../routes/projects');
const { projectDeletionLockKey } = require('../services/projectDeletionLock') as typeof import('../services/projectDeletionLock');
const { ProjectDependencyPromotionWriterFenceError } = require(
  '../services/projectDependencyPromotionWriterFence'
) as typeof import('../services/projectDependencyPromotionWriterFence');

function request(server: http.Server, path: string, bearer?: string, input: {
  method?: 'GET' | 'POST';
  body?: unknown;
} = {}): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server is not listening');
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? '' : JSON.stringify(input.body);
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      path,
      method: input.method || 'GET',
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: JSON.parse(responseBody),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('Owner dependency repair behavioral HTTP boundary', () => {
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/projects', projectsRouter);
    server = await new Promise<http.Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
  });

  afterAll(async () => {
    __projectDependencyRepairRouteTest.resetState();
    __projectDependencyRepairRouteTest.resetTerminateProcess();
    await new Promise<void>((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    __projectDependencyRepairRouteTest.resetState();
    mockPrepareRepairEvidence.mockReset();
    mockAcquireBackupMutationLock.mockReset();
    mockAcquireProjectLock.mockReset();
    mockCloseWriterFence.mockReset();
    mockReleaseRepairBackupLock.mockReset();
    mockInspectStatus.mockResolvedValue({
      lifecycle: {
        id: 'repair-project',
        workspaceOwnerId: 'repair-owner',
        projectName: 'project-a',
        generation: 7,
        lifecycleStatus: 'DEPENDENCY_QUARANTINED',
        dependencyQuarantinedAt: new Date('2026-08-12T12:00:00.000Z'),
      },
      decision: {
        operationId: '22222222-2222-4222-8222-222222222222',
        manifestDigest: 'a'.repeat(64),
        status: 'AUTHORIZED',
      },
      repair: null,
    });
  });

  test.each([
    [undefined, 401, 'Access token required'],
    ['user', 403, 'Owner access required'],
    ['owner-no-session', 401, 'A live durable Owner session is required'],
    ['owner-expired', 401, 'A live durable Owner session is required'],
  ] as const)('rejects non-durable/non-Owner status caller %s', async (bearer, status, error) => {
    const response = await request(
      server,
      '/api/projects/project-a/dependency-repair/status',
      bearer,
    );
    expect(response.status).toBe(status);
    expect(response.body.error).toContain(error);
    expect(mockInspectStatus).not.toHaveBeenCalled();
  });

  test.each([
    ['/api/projects/dependency-repair/active', undefined, 401],
    ['/api/projects/dependency-repair/active', 'user', 403],
    ['/api/projects/dependency-repair/active', 'owner-no-session', 401],
    ['/api/projects/dependency-repair/active', 'owner-expired', 401],
  ] as const)('gates active discovery %s for caller %s', async (path, bearer, status) => {
    const response = await request(server, path, bearer);
    expect(response.status).toBe(status);
    expect(mockListActive).not.toHaveBeenCalled();
  });

  test.each([
    [undefined, 401],
    ['user', 403],
    ['owner-no-session', 401],
    ['owner-expired', 401],
    ['owner-stale-version', 409],
  ] as const)('rejects force-forward caller %s before inspecting or mutating Project state', async (bearer, status) => {
    const response = await request(
      server,
      '/api/projects/project-a/dependency-repair/force-forward',
      bearer,
      {
        method: 'POST',
        body: {
          confirmation: 'FORCE FORWARD project-a',
          repairId: '33333333-3333-4333-8333-333333333333',
        },
      },
    );
    expect(response.status).toBe(status);
    expect(mockInspectStatus).not.toHaveBeenCalled();
    expect(mockInspectBackup).not.toHaveBeenCalled();
  });

  test('rejects typed-confirmation mismatch before inspecting or mutating Project state', async () => {
    const response = await request(
      server,
      '/api/projects/project-a/dependency-repair/force-forward',
      'owner',
      { method: 'POST', body: { confirmation: 'FORCE FORWARD another-project' } },
    );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'PROJECT_DEPENDENCY_REPAIR_CONFIRMATION_REQUIRED',
      confirmationPhrase: 'FORCE FORWARD project-a',
    });
    expect(mockInspectStatus).not.toHaveBeenCalled();
    expect(mockInspectBackup).not.toHaveBeenCalled();
  });

  test('an exact durable repair without its live fence requires startup instead of advertising POST retry', async () => {
    const repairId = '33333333-3333-4333-8333-333333333333';
    const operationId = '22222222-2222-4222-8222-222222222222';
    const manifestDigest = 'a'.repeat(64);
    mockInspectStatus.mockResolvedValue({
      lifecycle: {
        id: 'repair-project',
        workspaceOwnerId: 'repair-owner',
        projectName: 'project-a',
        generation: 7,
        lifecycleStatus: 'DEPENDENCY_PROMOTING',
        dependencyQuarantinedAt: new Date('2026-08-12T12:00:00.000Z'),
      },
      decision: { operationId, manifestDigest, status: 'AUTHORIZED' },
      repair: {
        repairId,
        projectIdentityId: 'repair-project',
        projectIdentityGeneration: 7,
        promotionOperationId: operationId,
        manifestDigest,
        status: 'PROMOTING',
        phase: 'GO_BIT',
      },
    });
    const response = await request(
      server,
      '/api/projects/project-a/dependency-repair/force-forward',
      'owner',
      {
        method: 'POST',
        body: {
          confirmation: 'FORCE FORWARD project-a',
          repairId,
          expectedProjectIdentityId: 'repair-project',
          expectedProjectIdentityGeneration: 7,
          expectedPromotionOperationId: operationId,
          expectedManifestDigest: manifestDigest,
        },
      },
    );
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      code: 'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE',
      retryable: false,
      restartRequired: true,
    });
    expect(mockInspectBackup).not.toHaveBeenCalled();
    expect(mockAcquireBackupMutationLock).not.toHaveBeenCalled();
    expect(mockCloseWriterFence).not.toHaveBeenCalled();
  });

  test('POST flushes a non-retryable startup handoff response while retaining the global fence and kernel locks', async () => {
    const releaseProjectLock = jest.fn();
    const releaseBackupLease = jest.fn(async () => undefined);
    const terminate = jest.fn();
    const proveQuiescent = jest.fn(async () => {
      throw new ProjectDependencyPromotionWriterFenceError('residual writer');
    });
    const releaseAfterSafeState = jest.fn(async () => {
      throw new ProjectDependencyPromotionWriterFenceError('safe release not proven');
    });
    const writerFence = {
      proveQuiescent,
      assertHeld: jest.fn(),
      releaseAfterSafeState,
      isHeld: jest.fn(() => true),
    };
    mockInspectBackup.mockResolvedValue({
      backup: {
        path: '/validation/backups/repair.tar.gz',
        filename: 'repair.tar.gz',
        createdAt: '2026-08-12T13:00:00.000Z',
        ageHours: 0,
        size: 4096,
        device: '501',
        inode: '502',
        mtimeNs: '999999999999999999',
        receiptDigest: 'c'.repeat(64),
        fingerprintDigest: 'd'.repeat(64),
      },
      backupRejection: null,
      degradedComponents: [],
    });
    mockAcquireBackupMutationLock.mockResolvedValue({
      lease: { kind: 'backup-mutation-lock' },
      release: releaseBackupLease,
    });
    mockAcquireProjectLock.mockResolvedValue(releaseProjectLock);
    mockCloseWriterFence.mockImplementation((input: any) => {
      input.releaseProjectLease();
      return writerFence;
    });
    __projectDependencyRepairRouteTest.setTerminateProcess(terminate);
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await request(
      server,
      '/api/projects/project-a/dependency-repair/force-forward',
      'owner',
      {
        method: 'POST',
        body: {
          confirmation: 'FORCE FORWARD project-a',
          repairId: '33333333-3333-4333-8333-333333333333',
          expectedProjectIdentityId: 'repair-project',
          expectedProjectIdentityGeneration: 7,
          expectedPromotionOperationId: '22222222-2222-4222-8222-222222222222',
          expectedManifestDigest: 'a'.repeat(64),
        },
      },
    );
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      code: 'PROJECT_DEPENDENCY_PROMOTION_WRITER_FENCE_UNPROVEN',
      retryable: false,
      restartRequired: true,
    });
    const key = projectDeletionLockKey('repair-owner', 'project-a');
    expect(__projectDependencyRepairRouteTest.preGoHandoffs.has(key)).toBe(true);
    const statusReads = mockInspectStatus.mock.calls.length;
    const backupReads = mockInspectBackup.mock.calls.length;
    const backupLockAcquisitions = mockAcquireBackupMutationLock.mock.calls.length;
    const retry = await request(
      server,
      '/api/projects/project-a/dependency-repair/force-forward',
      'owner',
      {
        method: 'POST',
        body: {
          confirmation: 'FORCE FORWARD project-a',
          repairId: '33333333-3333-4333-8333-333333333333',
          expectedProjectIdentityId: 'repair-project',
          expectedProjectIdentityGeneration: 7,
          expectedPromotionOperationId: '22222222-2222-4222-8222-222222222222',
          expectedManifestDigest: 'a'.repeat(64),
        },
      },
    );
    expect(retry.status).toBe(503);
    expect(retry.body).toMatchObject({
      code: 'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE',
      retryable: false,
      restartRequired: true,
    });
    expect(mockInspectStatus).toHaveBeenCalledTimes(statusReads);
    expect(mockInspectBackup).toHaveBeenCalledTimes(backupReads);
    expect(mockAcquireBackupMutationLock).toHaveBeenCalledTimes(backupLockAcquisitions);
    expect(proveQuiescent).toHaveBeenCalledTimes(1);
    expect(releaseAfterSafeState).toHaveBeenCalledTimes(1);
    expect(releaseBackupLease).not.toHaveBeenCalled();
    expect(writerFence.isHeld()).toBe(true);
    expect(releaseProjectLock).toHaveBeenCalledTimes(1);
    expect(terminate).not.toHaveBeenCalled();
    __projectDependencyRepairRouteTest.resetState();
    __projectDependencyRepairRouteTest.resetTerminateProcess();
    errorLog.mockRestore();
  });

  test('a retry serialized behind a completed exact repair returns COMPLETE before closing a writer fence', async () => {
    const repairId = '33333333-3333-4333-8333-333333333333';
    const operationId = '22222222-2222-4222-8222-222222222222';
    const manifestDigest = 'a'.repeat(64);
    const quarantine = {
      lifecycle: {
        id: 'repair-project',
        workspaceOwnerId: 'repair-owner',
        projectName: 'project-a',
        generation: 7,
        lifecycleStatus: 'DEPENDENCY_QUARANTINED',
        dependencyQuarantinedAt: new Date('2026-08-12T12:00:00.000Z'),
      },
      decision: { operationId, manifestDigest, status: 'AUTHORIZED', manifest: {} },
      repair: null,
    };
    const completedRepair: any = {
      repairId,
      action: 'FORCE_FORWARD_STAGED',
      promotionOperationId: operationId,
      manifestDigest,
      actorUserId: 'repair-owner',
      sessionId: 'repair-session',
      authorizationVersion: 11,
      projectIdentityId: 'repair-project',
      projectIdentityGeneration: 7,
      workspaceOwnerId: 'repair-owner',
      projectName: 'project-a',
      quarantinedAt: new Date('2026-08-12T12:00:00.000Z'),
      repairJournalCanonicalPath: '/validation/repair.json',
      displacementCanonicalRoot: '/validation/displaced',
      repairBindingDigest: 'b'.repeat(64),
      backup: {
        path: '/validation/backups/repair.tar.gz',
        filename: 'repair.tar.gz',
        device: '501',
        inode: '502',
        size: '4096',
        mtimeNs: '999999999999999999',
        receiptDigest: 'c'.repeat(64),
        fingerprintDigest: 'd'.repeat(64),
      },
      backupLock: {},
      movePlanDigest: 'e'.repeat(64),
      cleanupPlanDigest: 'f'.repeat(64),
      status: 'APPLIED',
      phase: 'COMPLETE',
      startedAt: new Date('2026-08-12T13:00:00.000Z'),
      allNewAt: new Date('2026-08-12T13:01:00.000Z'),
      appliedAt: new Date('2026-08-12T13:02:00.000Z'),
      evidenceCleanedAt: new Date('2026-08-12T13:03:00.000Z'),
      completedAt: new Date('2026-08-12T13:04:00.000Z'),
      createdAt: new Date('2026-08-12T13:00:00.000Z'),
      updatedAt: new Date('2026-08-12T13:04:00.000Z'),
    };
    const complete = {
      lifecycle: {
        ...quarantine.lifecycle,
        lifecycleStatus: 'ACTIVE',
        dependencyQuarantinedAt: null,
      },
      decision: null,
      repair: completedRepair,
    };
    let durableState: any = quarantine;
    mockInspectStatus.mockImplementation(async () => durableState);
    mockInspectBackup.mockResolvedValue({
      backup: {
        path: completedRepair.backup.path,
        filename: completedRepair.backup.filename,
        createdAt: '2026-08-12T13:00:00.000Z',
        ageHours: 0,
        size: 4096,
        device: completedRepair.backup.device,
        inode: completedRepair.backup.inode,
        mtimeNs: completedRepair.backup.mtimeNs,
        receiptDigest: completedRepair.backup.receiptDigest,
        fingerprintDigest: completedRepair.backup.fingerprintDigest,
      },
      backupRejection: null,
      degradedComponents: [],
    });
    let releaseWaitingLock!: (value: any) => void;
    const waitingLock = new Promise<any>((resolve) => { releaseWaitingLock = resolve; });
    let waitingRequestReachedLock!: () => void;
    const reachedLock = new Promise<void>((resolve) => { waitingRequestReachedLock = resolve; });
    mockAcquireBackupMutationLock
      .mockImplementationOnce(() => {
        waitingRequestReachedLock();
        return waitingLock;
      })
      .mockResolvedValue({
        lease: { kind: 'backup-mutation-lock', owner: 'winner' },
        release: jest.fn(async () => undefined),
      });
    mockAcquireProjectLock.mockResolvedValue(jest.fn());
    const body = {
      confirmation: 'FORCE FORWARD project-a',
      repairId,
      expectedProjectIdentityId: 'repair-project',
      expectedProjectIdentityGeneration: 7,
      expectedPromotionOperationId: operationId,
      expectedManifestDigest: manifestDigest,
    };

    const waitingRequest = request(
      server,
      '/api/projects/project-a/dependency-repair/force-forward',
      'owner',
      { method: 'POST', body },
    );
    await reachedLock;
    durableState = complete;
    const winningRetry = await request(
      server,
      '/api/projects/project-a/dependency-repair/force-forward',
      'owner',
      { method: 'POST', body },
    );
    expect(winningRetry.status).toBe(200);
    expect(winningRetry.body).toMatchObject({ accepted: true, completed: true, state: 'COMPLETE' });
    releaseWaitingLock({
      lease: { kind: 'backup-mutation-lock', owner: 'waiting' },
      release: jest.fn(async () => undefined),
    });
    const reconciled = await waitingRequest;
    expect(reconciled.status).toBe(200);
    expect(reconciled.body).toMatchObject({ accepted: true, completed: true, state: 'COMPLETE' });
    expect(mockAcquireBackupMutationLock).toHaveBeenCalledTimes(2);
    expect(mockCloseWriterFence).not.toHaveBeenCalled();
    expect(mockReleaseRepairBackupLock).toHaveBeenCalledTimes(1);
  });

  test('reload discovers a row-less pre-go handoff through exact Project status without backup advertising', async () => {
    const releaseBackupLease = jest.fn();
    __projectDependencyRepairRouteTest.preGoHandoffs.set(
      projectDeletionLockKey('repair-owner', 'project-a'),
      {
        fence: {
          isHeld: () => true,
          proveQuiescent: jest.fn(),
          assertHeld: jest.fn(),
          releaseAfterSafeState: jest.fn(),
        },
        terminalHandoffTimer: null,
        restartRequired: true,
        backupLease: { kind: 'backup-mutation-lock' },
        releaseBackupLease,
      },
    );
    const response = await request(
      server,
      '/api/projects/project-a/dependency-repair/status',
      'owner',
    );
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({
      state: 'QUARANTINED',
      restartRequired: true,
      retryable: false,
      statusRetryable: false,
      backup: { eligible: false, pinned: false },
    });
    expect(mockInspectStatus).toHaveBeenCalledWith({
      workspaceOwnerId: 'repair-owner',
      projectName: 'project-a',
    });
    expect(mockInspectBackup).not.toHaveBeenCalled();
    expect(releaseBackupLease).not.toHaveBeenCalled();
  });

  test.each([
    ['QUARANTINED', true, false],
    ['PROMOTING', false, true],
    ['UNAVAILABLE', false, true],
  ] as const)(
    '%s response stops current-process retry when startup handoff is required',
    (state, retryableWithoutRestart, statusRetryableWithoutRestart) => {
      const common: any = {
        state,
        projectName: 'project-a',
        lifecycle: null,
        decision: null,
        repair: null,
      };
      expect(__projectDependencyRepairRouteTest.response(common)).toMatchObject({
        retryable: retryableWithoutRestart,
        statusRetryable: statusRetryableWithoutRestart,
        restartRequired: false,
      });
      expect(__projectDependencyRepairRouteTest.response({
        ...common,
        restartRequired: true,
      })).toMatchObject({
        retryable: false,
        statusRetryable: false,
        restartRequired: true,
      });
    },
  );

  test('response flush schedules exactly one SIGTERM while the retained fence and locks stay owned', () => {
    jest.useFakeTimers();
    const terminate = jest.fn();
    __projectDependencyRepairRouteTest.setTerminateProcess(terminate);
    const response = new EventEmitter() as EventEmitter & { writableFinished: boolean };
    response.writableFinished = false;
    const fence = { isHeld: jest.fn(() => true), releaseAfterSafeState: jest.fn() };
    const releaseBackupLease = jest.fn();
    const handoff: any = {
      fence,
      terminalHandoffTimer: null,
      restartRequired: false,
      backupLease: { kind: 'backup-mutation-lock' },
      releaseBackupLease,
    };
    __projectDependencyRepairRouteTest.scheduleStartupHandoffAfterResponse(
      response as any,
      handoff,
      'behavioral test',
    );
    expect(handoff.restartRequired).toBe(true);
    expect(terminate).not.toHaveBeenCalled();
    response.emit('finish');
    response.emit('close');
    jest.advanceTimersByTime(999);
    expect(terminate).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(fence.releaseAfterSafeState).not.toHaveBeenCalled();
    expect(releaseBackupLease).not.toHaveBeenCalled();
    __projectDependencyRepairRouteTest.resetState();
    __projectDependencyRepairRouteTest.resetTerminateProcess();
    jest.useRealTimers();
  });

  test('an already-destroyed response still schedules exactly one retained-fence startup handoff', () => {
    jest.useFakeTimers();
    const terminate = jest.fn();
    __projectDependencyRepairRouteTest.setTerminateProcess(terminate);
    const response = new EventEmitter() as EventEmitter & {
      writableFinished: boolean;
      destroyed: boolean;
    };
    response.writableFinished = false;
    response.destroyed = true;
    const fence = { isHeld: jest.fn(() => true), releaseAfterSafeState: jest.fn() };
    const releaseBackupLease = jest.fn();
    const handoff: any = {
      fence,
      terminalHandoffTimer: null,
      restartRequired: false,
      backupLease: { kind: 'backup-mutation-lock' },
      releaseBackupLease,
    };
    __projectDependencyRepairRouteTest.scheduleStartupHandoffAfterResponse(
      response as any,
      handoff,
      'destroyed response behavioral test',
    );
    expect(handoff.restartRequired).toBe(true);
    response.emit('finish');
    response.emit('close');
    jest.advanceTimersByTime(1_000);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(fence.releaseAfterSafeState).not.toHaveBeenCalled();
    expect(releaseBackupLease).not.toHaveBeenCalled();
    __projectDependencyRepairRouteTest.resetState();
    __projectDependencyRepairRouteTest.resetTerminateProcess();
    jest.useRealTimers();
  });
});
