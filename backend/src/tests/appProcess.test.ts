import net from 'net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const settingStore = new Map<string, string>();
const appStatusStore = new Map<string, string>();
const prismaMock = {
  $transaction: jest.fn(),
  app: {
    count: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  systemSetting: {
    create: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
    upsert: jest.fn(),
  },
  projectIdentity: {
    findUnique: jest.fn(),
  },
};

const lifecycleMock = {
  assertProjectRuntimeImageAvailable: jest.fn(),
  // Returns false: these tests cover the path where readiness never arrives,
  // so the loopback bridge must be attempted and must not rescue the deploy.
  bridgeContainerLoopbackPort: jest.fn(() => false),
  inspectProjectAppContainer: jest.fn(),
  projectAppContainerName: jest.fn(({ workloadId }: any) => `bridgesllm-project-app-${workloadId}`),
  readProjectAppLogs: jest.fn(),
  runProjectLifecycleCommand: jest.fn(),
  startProjectAppContainer: jest.fn(),
  stopProjectAppContainer: jest.fn(),
};

jest.mock('../config/database', () => ({
  prisma: prismaMock,
}));

jest.mock('../services/project-lifecycle.service', () => lifecycleMock);

import {
  __appProcessTest,
  allocatePort,
  forgetAppRuntime,
  getAppTarget,
  getAppStatus,
  initializeAppProcessRuntime,
  preflightAppProcessRuntimeRestoration,
  restartApp as restartAppWithAdmission,
  shutdownAll,
  startApp as startAppWithAdmission,
  stopApp,
  withProjectAppDeploymentLocks,
} from '../services/app-process.service';
import {
  acquireProjectDeletionLockWithoutGuard,
  projectDeletionLockKey,
  type ProjectDeletionLockLease,
} from '../services/projectDeletionLock';

function makeDeployDir(withNodeModules = true): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'portal-app-process-test-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }));
  if (withNodeModules) mkdirSync(path.join(dir, 'node_modules'));
  return dir;
}

function runningContainer(restartCount = 0) {
  return {
    running: true,
    status: 'running',
    exitCode: 0,
    restartCount,
    error: '',
  };
}

const APP_IDENTITY = { actorId: 'user-1', projectId: 'project-identity-1' };
const APP_PROJECT_NAME = 'demo';
let appLifecycleLock: ProjectDeletionLockLease;

function startApp(
  appId: string,
  deployId: string,
  deployPath: string,
  port: number,
  identity: typeof APP_IDENTITY,
) {
  return startAppWithAdmission(appId, deployId, deployPath, port, {
    ...identity,
    projectGeneration: 1,
    lifecycleLock: appLifecycleLock,
  });
}

function restartApp(
  appId: string,
  deployId: string,
  deployPath: string,
  port: number,
  identity: typeof APP_IDENTITY,
) {
  return restartAppWithAdmission(appId, deployId, deployPath, port, {
    ...identity,
    projectGeneration: 1,
    lifecycleLock: appLifecycleLock,
  });
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function flushManagedPersistence(deployId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const managed = __appProcessTest.runningApps.get(deployId);
    if (!managed?.pendingStatusPersistence && !managed?.pendingRuntimePersistence) return;
    await flushAsyncWork();
  }
  throw new Error(`Managed persistence did not settle for ${deployId}`);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function applyAppStatusUpdateMany({ where, data }: any) {
  if (!where?.id) return { count: 0 };
  const currentStatus = appStatusStore.get(where.id);
  if (
    where.processStatus?.not !== undefined
    && currentStatus === where.processStatus.not
  ) return { count: 0 };
  if (typeof data?.processStatus === 'string') {
    appStatusStore.set(where.id, data.processStatus);
  }
  return { count: 1 };
}

describe('app-process.service', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    settingStore.clear();
    appStatusStore.clear();
    __appProcessTest.resetRuntimeState();

    prismaMock.$transaction.mockImplementation(async (work: (transaction: typeof prismaMock) => Promise<unknown>) => {
      const settingSnapshot = new Map(settingStore);
      const statusSnapshot = new Map(appStatusStore);
      try {
        return await work(prismaMock);
      } catch (error) {
        settingStore.clear();
        for (const [key, value] of settingSnapshot) settingStore.set(key, value);
        appStatusStore.clear();
        for (const [key, value] of statusSnapshot) appStatusStore.set(key, value);
        throw error;
      }
    });

    prismaMock.app.update.mockImplementation(async ({ where, data }: any) => {
      if (typeof data?.processStatus === 'string') {
        appStatusStore.set(where.id, data.processStatus);
      }
      return { id: where.id, ...data };
    });
    prismaMock.app.updateMany.mockImplementation(applyAppStatusUpdateMany);
    prismaMock.app.count.mockResolvedValue(1);
    prismaMock.app.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id }));
    prismaMock.app.findMany.mockResolvedValue([]);
    prismaMock.projectIdentity.findUnique.mockResolvedValue({ id: APP_IDENTITY.projectId, lifecycleStatus: 'ACTIVE' });
    prismaMock.systemSetting.create.mockImplementation(async ({ data }: any) => {
      if (settingStore.has(data.key)) {
        const error: any = new Error('Unique constraint');
        error.code = 'P2002';
        throw error;
      }
      settingStore.set(data.key, data.value);
      return data;
    });
    prismaMock.systemSetting.findUnique.mockImplementation(async ({ where }: any) => {
      const value = settingStore.get(where.key);
      return value === undefined ? null : { key: where.key, value };
    });
    prismaMock.systemSetting.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (settingStore.get(where.key) !== where.value) return { count: 0 };
      settingStore.set(where.key, data.value);
      return { count: 1 };
    });
    prismaMock.systemSetting.deleteMany.mockImplementation(async ({ where }: any) => {
      if (where.value !== undefined && settingStore.get(where.key) !== where.value) return { count: 0 };
      const removed = settingStore.delete(where.key);
      return { count: removed ? 1 : 0 };
    });
    prismaMock.systemSetting.upsert.mockImplementation(async ({ where, create, update }: any) => {
      const value = settingStore.has(where.key) ? update.value : create.value;
      settingStore.set(where.key, value);
      return { key: where.key, value };
    });

    lifecycleMock.startProjectAppContainer.mockImplementation(({ actorId, projectId, workloadId }: any) => ({
      containerName: `bridgesllm-project-app-${workloadId}`,
      containerId: `container-${workloadId}`,
      networkAddress: '172.30.0.4',
      plan: { runtimeFingerprint: `fingerprint-${workloadId}`, identity: { actorId, projectId, workloadId } },
    }));
    lifecycleMock.inspectProjectAppContainer.mockReturnValue(runningContainer());
    lifecycleMock.assertProjectRuntimeImageAvailable.mockResolvedValue(
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    lifecycleMock.readProjectAppLogs.mockReturnValue(['ready']);
    __appProcessTest.setReadinessProbe(async () => true);
    appLifecycleLock = await acquireProjectDeletionLockWithoutGuard(
      projectDeletionLockKey(APP_IDENTITY.actorId, APP_PROJECT_NAME),
    );
  });

  afterEach(() => {
    appLifecycleLock?.();
    __appProcessTest.resetRuntimeState();
    jest.useRealTimers();
  });

  it('starts and stops full-stack apps only through the isolated container runtime', async () => {
    const deployDir = makeDeployDir();

    try {
      await startApp('app-1', 'deploy-1', deployDir, 5001, APP_IDENTITY);

      expect(lifecycleMock.startProjectAppContainer).toHaveBeenCalledWith({
        ...APP_IDENTITY,
        workspace: deployDir,
        command: 'npm',
        args: ['start'],
        nameHint: 'deploy-1',
        port: 5001,
        production: true,
        mode: 'app',
        workloadId: 'app-1',
        network: true,
      });
      expect(prismaMock.app.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'app-1',
          userId: APP_IDENTITY.actorId,
          name: APP_PROJECT_NAME,
          zipPath: deployDir,
          port: 5001,
          deployType: 'fullstack',
          isActive: true,
          projectIdentityId: APP_IDENTITY.projectId,
          projectIdentity: {
            is: {
              id: APP_IDENTITY.projectId,
              workspaceOwnerId: APP_IDENTITY.actorId,
              projectName: APP_PROJECT_NAME,
              generation: 1,
              lifecycleStatus: 'ACTIVE',
            },
          },
        },
        select: { id: true },
      });
      expect(lifecycleMock.runProjectLifecycleCommand).not.toHaveBeenCalled();

      jest.advanceTimersByTime(__appProcessTest.STARTUP_PROBE_DELAY_MS);
      await flushAsyncWork();
      expect(getAppStatus('deploy-1')).toEqual({
        status: 'running',
        port: 5001,
        logs: ['ready'],
        lastError: undefined,
        restartCount: 0,
      });
      expect(getAppTarget('deploy-1')).toBe('http://172.30.0.4:5001');

      await stopApp('deploy-1');
      expect(lifecycleMock.stopProjectAppContainer).toHaveBeenCalledWith(expect.objectContaining({
        runtimeFingerprint: 'fingerprint-app-1',
      }));
      expect(getAppStatus('deploy-1')).toBeNull();
      expect(prismaMock.app.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'app-1', processStatus: { not: 'stopped' } },
        data: { processStatus: 'stopped' },
      });
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('rejects a stale Start queued behind the shared Project App deployment lane', async () => {
    const deployDir = makeDeployDir();
    const admittedRebind = deferred<void>();
    const heldLane = withProjectAppDeploymentLocks(['user-1-demo'], async () => {
      await admittedRebind.promise;
    });
    await flushAsyncWork();
    prismaMock.app.findFirst.mockResolvedValueOnce(null);

    try {
      const queuedStart = startApp(
        'app-stale',
        'user-1-demo',
        deployDir,
        5001,
        APP_IDENTITY,
      );
      admittedRebind.resolve();
      await heldLane;
      await expect(queuedStart).rejects.toMatchObject({
        code: 'PROJECT_RUNTIME_STATE_ATTESTATION_FAILED',
      });
      expect(lifecycleMock.assertProjectRuntimeImageAvailable).not.toHaveBeenCalled();
      expect(lifecycleMock.stopProjectAppContainer).not.toHaveBeenCalled();
      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
    } finally {
      admittedRebind.resolve();
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('rejects a queued Start whose exact Project lifecycle lease was released', async () => {
    const deployDir = makeDeployDir();
    const admitQueuedStart = deferred<void>();
    const heldLane = withProjectAppDeploymentLocks(['deploy-released-lease'], async () => {
      await admitQueuedStart.promise;
    });
    await flushAsyncWork();

    try {
      const queuedStart = startApp(
        'app-released-lease',
        'deploy-released-lease',
        deployDir,
        5001,
        APP_IDENTITY,
      );
      appLifecycleLock();
      admitQueuedStart.resolve();
      await heldLane;
      await expect(queuedStart).rejects.toThrow(/held exact Project lifecycle lock lease/i);
      expect(prismaMock.app.findFirst).not.toHaveBeenCalled();
      expect(lifecycleMock.assertProjectRuntimeImageAvailable).not.toHaveBeenCalled();
      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
    } finally {
      admitQueuedStart.resolve();
      await heldLane.catch(() => undefined);
      if (!appLifecycleLock.isHeld()) {
        appLifecycleLock = await acquireProjectDeletionLockWithoutGuard(
          projectDeletionLockKey(APP_IDENTITY.actorId, APP_PROJECT_NAME),
        );
      }
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('rejects forged and wrong-Project lifecycle leases before App re-attestation', async () => {
    const deployDir = makeDeployDir();
    const forgedLifecycleLock = (() => undefined) as unknown as ProjectDeletionLockLease;
    const wrongLifecycleLock = await acquireProjectDeletionLockWithoutGuard(
      projectDeletionLockKey(APP_IDENTITY.actorId, 'different-project'),
    );
    try {
      for (const lifecycleLock of [forgedLifecycleLock, wrongLifecycleLock]) {
        await expect(startAppWithAdmission(
          'app-invalid-lease',
          'user-1-demo',
          deployDir,
          5001,
          {
            ...APP_IDENTITY,
            projectGeneration: 1,
            appName: APP_PROJECT_NAME,
            lifecycleLock,
          },
        )).rejects.toThrow(/held exact Project lifecycle lock lease/i);
      }
      expect(prismaMock.app.findFirst).not.toHaveBeenCalled();
      expect(lifecycleMock.assertProjectRuntimeImageAvailable).not.toHaveBeenCalled();
      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
    } finally {
      wrongLifecycleLock();
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('keeps repeated unchanged status and hosted-target reads fully persistence-free', async () => {
    const deployDir = makeDeployDir();
    try {
      await startApp('app-status-noop', 'deploy-status-noop', deployDir, 5011, APP_IDENTITY);
      expect(appStatusStore.get('app-status-noop')).toBe('running');
      prismaMock.app.updateMany.mockClear();
      prismaMock.systemSetting.upsert.mockClear();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(getAppStatus('deploy-status-noop')).toEqual(expect.objectContaining({
          status: 'running',
        }));
        expect(getAppTarget('deploy-status-noop')).toBe('http://172.30.0.4:5011');
      }
      await flushAsyncWork();

      expect(prismaMock.app.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.systemSetting.upsert).not.toHaveBeenCalled();
      expect(appStatusStore.get('app-status-noop')).toBe('running');
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('persists each material reconciliation once and then returns to read-only status', async () => {
    const deployDir = makeDeployDir();
    try {
      await startApp('app-status-transition', 'deploy-status-transition', deployDir, 5012, APP_IDENTITY);
      prismaMock.app.updateMany.mockClear();
      prismaMock.systemSetting.upsert.mockClear();

      lifecycleMock.inspectProjectAppContainer.mockReturnValue(runningContainer(2));
      expect(getAppStatus('deploy-status-transition')).toEqual(expect.objectContaining({
        status: 'running',
        restartCount: 2,
      }));
      await flushAsyncWork();
      expect(prismaMock.app.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(1);

      expect(getAppTarget('deploy-status-transition')).toBe('http://172.30.0.4:5012');
      await flushAsyncWork();
      expect(prismaMock.app.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(1);

      lifecycleMock.inspectProjectAppContainer.mockReturnValue({
        running: false,
        status: 'exited',
        exitCode: 9,
        restartCount: 2,
        error: 'fixture exited',
      });
      expect(getAppStatus('deploy-status-transition')).toEqual(expect.objectContaining({
        status: 'error',
        lastError: 'fixture exited',
        restartCount: 2,
      }));
      await flushAsyncWork();
      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.app.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'app-status-transition', processStatus: { not: 'error' } },
        data: { processStatus: 'error' },
      });
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(2);

      expect(getAppStatus('deploy-status-transition')).toEqual(expect.objectContaining({
        status: 'error',
      }));
      expect(getAppTarget('deploy-status-transition')).toBeNull();
      await flushAsyncWork();
      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('retries a failed status write on a later unchanged observation without rewriting runtime state', async () => {
    const deployDir = makeDeployDir();
    const appId = 'app-status-write-retry';
    const deployId = 'deploy-status-write-retry';
    const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await startApp(appId, deployId, deployDir, 5013, APP_IDENTITY);
      prismaMock.app.updateMany.mockClear();
      prismaMock.systemSetting.upsert.mockClear();
      prismaMock.app.updateMany.mockRejectedValueOnce(new Error('transient status write failure'));
      lifecycleMock.inspectProjectAppContainer.mockReturnValue({
        running: false,
        status: 'exited',
        exitCode: 11,
        restartCount: 0,
        error: 'status retry fixture',
      });

      expect(getAppStatus(deployId)).toEqual(expect.objectContaining({ status: 'error' }));
      await flushManagedPersistence(deployId);
      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(1);
      expect(appStatusStore.get(appId)).toBe('running');
      expect(JSON.parse(settingStore.get(stateKey) || '{}')).toEqual(expect.objectContaining({
        status: 'error',
        desiredStatus: 'error',
      }));

      expect(getAppStatus(deployId)).toEqual(expect.objectContaining({ status: 'error' }));
      await flushManagedPersistence(deployId);
      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(2);
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(1);
      expect(appStatusStore.get(appId)).toBe('error');

      expect(getAppTarget(deployId)).toBeNull();
      await flushAsyncWork();
      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(2);
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('retries a failed runtime-state write on a later unchanged observation without rewriting status', async () => {
    const deployDir = makeDeployDir();
    const appId = 'app-state-write-retry';
    const deployId = 'deploy-state-write-retry';
    const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await startApp(appId, deployId, deployDir, 5014, APP_IDENTITY);
      prismaMock.app.updateMany.mockClear();
      prismaMock.systemSetting.upsert.mockClear();
      prismaMock.systemSetting.upsert.mockRejectedValueOnce(new Error('transient state write failure'));
      lifecycleMock.inspectProjectAppContainer.mockReturnValue(runningContainer(1));

      expect(getAppStatus(deployId)).toEqual(expect.objectContaining({
        status: 'running',
        restartCount: 1,
      }));
      await flushManagedPersistence(deployId);
      expect(prismaMock.app.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(1);
      expect(JSON.parse(settingStore.get(stateKey) || '{}')).toEqual(expect.objectContaining({
        restartCount: 0,
        containerRestartCount: 0,
      }));

      expect(getAppTarget(deployId)).toBe('http://172.30.0.4:5014');
      await flushManagedPersistence(deployId);
      expect(prismaMock.app.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(2);
      expect(JSON.parse(settingStore.get(stateKey) || '{}')).toEqual(expect.objectContaining({
        restartCount: 1,
        containerRestartCount: 1,
      }));

      expect(getAppStatus(deployId)).toEqual(expect.objectContaining({ status: 'running' }));
      await flushAsyncWork();
      expect(prismaMock.app.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('retries failed status and runtime-state writes together on a later unchanged observation', async () => {
    const deployDir = makeDeployDir();
    const appId = 'app-both-writes-retry';
    const deployId = 'deploy-both-writes-retry';
    const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await startApp(appId, deployId, deployDir, 5015, APP_IDENTITY);
      prismaMock.app.updateMany.mockClear();
      prismaMock.systemSetting.upsert.mockClear();
      prismaMock.app.updateMany.mockRejectedValueOnce(new Error('combined status write failure'));
      prismaMock.systemSetting.upsert.mockRejectedValueOnce(new Error('combined state write failure'));
      lifecycleMock.inspectProjectAppContainer.mockReturnValue({
        running: false,
        status: 'exited',
        exitCode: 12,
        restartCount: 0,
        error: 'combined retry fixture',
      });

      expect(getAppStatus(deployId)).toEqual(expect.objectContaining({ status: 'error' }));
      await flushManagedPersistence(deployId);
      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(1);
      expect(appStatusStore.get(appId)).toBe('running');
      expect(JSON.parse(settingStore.get(stateKey) || '{}')).toEqual(expect.objectContaining({
        status: 'running',
        desiredStatus: 'running',
      }));

      expect(getAppStatus(deployId)).toEqual(expect.objectContaining({ status: 'error' }));
      await flushManagedPersistence(deployId);
      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(2);
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(2);
      expect(appStatusStore.get(appId)).toBe('error');
      expect(JSON.parse(settingStore.get(stateKey) || '{}')).toEqual(expect.objectContaining({
        status: 'error',
        desiredStatus: 'error',
        lastError: 'combined retry fixture',
      }));

      expect(getAppTarget(deployId)).toBeNull();
      await flushAsyncWork();
      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(2);
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('queues a newer transition behind pending old writes and deduplicates each pending fingerprint', async () => {
    const deployDir = makeDeployDir();
    const appId = 'app-pending-transition';
    const deployId = 'deploy-pending-transition';
    const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;
    const oldStatusWrite = deferred<void>();
    const oldStateWrite = deferred<void>();
    try {
      await startApp(appId, deployId, deployDir, 5016, APP_IDENTITY);
      prismaMock.app.updateMany.mockClear();
      prismaMock.systemSetting.upsert.mockClear();
      prismaMock.app.updateMany.mockImplementationOnce(async (args: any) => {
        await oldStatusWrite.promise;
        return applyAppStatusUpdateMany(args);
      });
      prismaMock.systemSetting.upsert.mockImplementationOnce(async ({ where, create, update }: any) => {
        await oldStateWrite.promise;
        const value = settingStore.has(where.key) ? update.value : create.value;
        settingStore.set(where.key, value);
        return { key: where.key, value };
      });
      lifecycleMock.inspectProjectAppContainer.mockReturnValue({
        running: false,
        status: 'restarting',
        exitCode: 0,
        restartCount: 0,
        error: 'pending old transition',
      });

      expect(getAppStatus(deployId)).toEqual(expect.objectContaining({ status: 'starting' }));
      await flushAsyncWork();
      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(1);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(getAppStatus(deployId)).toEqual(expect.objectContaining({ status: 'starting' }));
      }
      await flushAsyncWork();
      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(1);

      // This returns to the already-durable baseline fingerprint, but the old
      // queued write would overwrite it. The newer transition must therefore
      // be queued behind the old one rather than mistaken for a no-op.
      lifecycleMock.inspectProjectAppContainer.mockReturnValue(runningContainer());
      expect(getAppStatus(deployId)).toEqual(expect.objectContaining({ status: 'running' }));
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(getAppTarget(deployId)).toBe('http://172.30.0.4:5016');
      }
      await flushAsyncWork();
      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(1);

      oldStatusWrite.resolve();
      oldStateWrite.resolve();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (prismaMock.app.updateMany.mock.calls.length === 2
          && prismaMock.systemSetting.upsert.mock.calls.length === 2) break;
        await flushAsyncWork();
      }
      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(2);
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(2);
      expect(appStatusStore.get(appId)).toBe('running');
      expect(JSON.parse(settingStore.get(stateKey) || '{}')).toEqual(expect.objectContaining({
        status: 'running',
        desiredStatus: 'running',
        restartCount: 0,
        containerRestartCount: 0,
      }));

      expect(getAppStatus(deployId)).toEqual(expect.objectContaining({ status: 'running' }));
      await flushAsyncWork();
      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(2);
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(2);
    } finally {
      oldStatusWrite.resolve();
      oldStateWrite.resolve();
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('keeps the existing manager live when restart image preflight fails', async () => {
    const deployDir = makeDeployDir();
    try {
      await startApp('app-image-preflight', 'deploy-image-preflight', deployDir, 5012, APP_IDENTITY);
      const targetBefore = getAppTarget('deploy-image-preflight');
      const stopCallsBefore = lifecycleMock.stopProjectAppContainer.mock.calls.length;
      const unavailable = Object.assign(new Error('runtime image missing'), {
        code: 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE',
      });
      lifecycleMock.assertProjectRuntimeImageAvailable.mockRejectedValueOnce(unavailable);

      await expect(restartApp(
        'app-image-preflight',
        'deploy-image-preflight',
        deployDir,
        5012,
        APP_IDENTITY,
      )).rejects.toBe(unavailable);

      expect(lifecycleMock.stopProjectAppContainer).toHaveBeenCalledTimes(stopCallsBefore);
      expect(getAppTarget('deploy-image-preflight')).toBe(targetBefore);
      expect(getAppStatus('deploy-image-preflight')).toEqual(expect.objectContaining({
        status: 'running',
      }));
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('runs dependency lifecycle scripts in a one-shot sandbox before starting the app', async () => {
    const deployDir = makeDeployDir(false);

    try {
      await startApp('app-2', 'deploy-2', deployDir, 5002, APP_IDENTITY);

      expect(lifecycleMock.runProjectLifecycleCommand).toHaveBeenCalledWith({
        ...APP_IDENTITY,
        workspace: deployDir,
        command: 'npm',
        args: ['install', '--omit=dev', '--no-audit', '--no-fund'],
        timeoutMs: 180000,
        nameHint: 'deploy-2:install',
        production: true,
        network: true,
      });
      expect(lifecycleMock.startProjectAppContainer).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('does not report deployment success until the loopback HTTP endpoint answers', async () => {
    const deployDir = makeDeployDir();
    const probes: Array<[string, number]> = [];
    __appProcessTest.setReadinessProbe(async (networkAddress, port) => {
      probes.push([networkAddress, port]);
      return probes.length >= 2;
    });

    try {
      const starting = startApp('app-ready', 'deploy-ready', deployDir, 5008, APP_IDENTITY);
      await jest.advanceTimersByTimeAsync(0);
      expect(probes).toEqual([['172.30.0.4', 5008]]);

      await jest.advanceTimersByTimeAsync(250);
      await expect(starting).resolves.toEqual(expect.objectContaining({
        status: 'running',
        port: 5008,
      }));
      expect(probes).toEqual([
        ['172.30.0.4', 5008],
        ['172.30.0.4', 5008],
      ]);
      expect(prismaMock.app.updateMany).toHaveBeenCalledWith({
        where: { id: 'app-ready', processStatus: { not: 'running' } },
        data: { processStatus: 'running' },
      });
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('stops the confined container when loopback HTTP readiness never arrives', async () => {
    const deployDir = makeDeployDir();
    __appProcessTest.setReadinessProbe(async () => false);

    try {
      const starting = startApp('app-not-ready', 'deploy-not-ready', deployDir, 5009, APP_IDENTITY);
      const rejection = expect(starting).rejects.toThrow(
        'App did not answer HTTP on its isolated runtime at 172.30.0.4:5009',
      );
      await jest.advanceTimersByTimeAsync(__appProcessTest.STARTUP_TIMEOUT_MS + 500);
      await rejection;
      expect(lifecycleMock.stopProjectAppContainer).toHaveBeenCalledWith({
        ...APP_IDENTITY,
        workloadId: 'app-not-ready',
      });
      expect(getAppStatus('deploy-not-ready')).toBeNull();
      expect(prismaMock.app.updateMany).toHaveBeenCalledWith({
        where: { id: 'app-not-ready', processStatus: { not: 'error' } },
        data: { processStatus: 'error' },
      });
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('cancels and identity-guards startup probes after an app is stopped', async () => {
    const deployDir = makeDeployDir();
    try {
      await startApp('app-race', 'deploy-race', deployDir, 5003, APP_IDENTITY);
      await stopApp('deploy-race');
      const callCountAfterStop = prismaMock.app.updateMany.mock.calls.length;

      jest.advanceTimersByTime(__appProcessTest.STARTUP_TIMEOUT_MS * 2);
      await flushAsyncWork();

      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(callCountAfterStop);
      expect(prismaMock.app.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'app-race', processStatus: { not: 'stopped' } },
        data: { processStatus: 'stopped' },
      });
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('prevents a replaced startup probe from overwriting the restarted app identity', async () => {
    const deployDir = makeDeployDir();
    try {
      await startApp('app-old', 'deploy-replaced', deployDir, 5003, APP_IDENTITY);
      await startApp('app-new', 'deploy-replaced', deployDir, 5003, APP_IDENTITY);
      prismaMock.app.updateMany.mockClear();
      prismaMock.systemSetting.upsert.mockClear();
      lifecycleMock.inspectProjectAppContainer.mockImplementation((containerName: string) => (
        runningContainer(containerName.endsWith('app-new') ? 1 : 9)
      ));

      jest.advanceTimersByTime(__appProcessTest.STARTUP_TIMEOUT_MS);
      await flushAsyncWork();

      expect(prismaMock.app.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(1);
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { key: `${__appProcessTest.APP_STATE_PREFIX}app-new` },
      }));
      expect(prismaMock.systemSetting.upsert).not.toHaveBeenCalledWith(expect.objectContaining({
        where: { key: `${__appProcessTest.APP_STATE_PREFIX}app-old` },
      }));
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('serializes an in-flight material probe write ahead of a later stop', async () => {
    const deployDir = makeDeployDir();
    let releaseReconciliationWrite: (() => void) | undefined;
    try {
      await startApp('app-status-race', 'deploy-status-race', deployDir, 5003, APP_IDENTITY);
      prismaMock.app.updateMany.mockImplementation((args: any) => {
        if (args.data.processStatus !== 'error') return applyAppStatusUpdateMany(args);
        return new Promise((resolve) => {
          releaseReconciliationWrite = () => resolve({ count: 1 });
        });
      });
      lifecycleMock.inspectProjectAppContainer.mockReturnValue({
        running: false,
        status: 'exited',
        exitCode: 5,
        restartCount: 0,
        error: 'startup probe transition fixture',
      });

      jest.advanceTimersByTime(__appProcessTest.STARTUP_PROBE_DELAY_MS);
      await flushAsyncWork();
      expect(releaseReconciliationWrite).toBeDefined();
      const stopping = stopApp('deploy-status-race');
      await flushAsyncWork();
      releaseReconciliationWrite?.();
      await stopping;

      expect(prismaMock.app.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'app-status-race', processStatus: { not: 'stopped' } },
        data: { processStatus: 'stopped' },
      });
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('transactionally leases distinct ports under concurrent allocation', async () => {
    jest.useRealTimers();
    const [first, second] = await Promise.all([allocatePort(), allocatePort()]);
    expect(first).not.toBe(second);
    expect(first).toBeGreaterThanOrEqual(5001);
    expect(second).toBeLessThanOrEqual(5099);
    expect(__appProcessTest.portLeases.size).toBe(2);
  });

  it('skips a port already bound by another process', async () => {
    jest.useRealTimers();
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 5001 }, () => resolve());
    });

    try {
      await expect(allocatePort()).resolves.not.toBe(5001);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('atomically reclaims a non-expired lease from a crashed Portal identity', async () => {
    jest.useRealTimers();
    const leaseKey = `${__appProcessTest.PORT_LEASE_PREFIX}5001`;
    settingStore.set(leaseKey, JSON.stringify({
      token: 'stale-token',
      portalInstanceId: 'dead-portal',
      pid: process.pid,
      processStartTime: 'definitely-not-the-current-start-marker',
      port: 5001,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));

    await expect(allocatePort()).resolves.toBe(5001);
    expect(JSON.parse(settingStore.get(leaseKey) || '{}')).toEqual(expect.objectContaining({
      portalInstanceId: expect.not.stringMatching('dead-portal'),
      port: 5001,
    }));
  });

  it('restores graceful-shutdown intent without allowing an old startup timer to overwrite it', async () => {
    const deployDir = makeDeployDir();
    try {
      await startApp('app-restore', 'user-1-demo', deployDir, 5004, APP_IDENTITY);
      jest.advanceTimersByTime(__appProcessTest.STARTUP_PROBE_DELAY_MS);
      await flushAsyncWork();
      await shutdownAll();
      expect(getAppStatus('user-1-demo')).toBeNull();

      __appProcessTest.resetRuntimeState();
      __appProcessTest.setReadinessProbe(async () => true);
      prismaMock.app.findMany.mockResolvedValue([{
        id: 'app-restore',
        userId: 'user-1',
        projectIdentityId: APP_IDENTITY.projectId,
        name: 'demo',
        zipPath: deployDir,
        port: 5004,
        deployType: 'fullstack',
        processStatus: 'running',
      }]);
      prismaMock.projectIdentity.findUnique.mockResolvedValue({
        id: APP_IDENTITY.projectId,
        workspaceOwnerId: 'user-1',
        projectName: 'demo',
        lifecycleStatus: 'ACTIVE',
      });
      lifecycleMock.inspectProjectAppContainer.mockReturnValue(null);

      await initializeAppProcessRuntime();

      expect(lifecycleMock.startProjectAppContainer).toHaveBeenCalledTimes(2);
      expect(prismaMock.projectIdentity.findUnique).toHaveBeenCalledWith({
        where: { id: APP_IDENTITY.projectId },
        select: {
          id: true,
          workspaceOwnerId: true,
          projectName: true,
          lifecycleStatus: true,
        },
      });
      lifecycleMock.inspectProjectAppContainer.mockReturnValue(runningContainer());
      expect(getAppStatus('user-1-demo')).toEqual(expect.objectContaining({
        status: 'running',
        port: 5004,
      }));
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('reconciles an exhausted crashed container and its durable restart count after restart', async () => {
    const deployDir = makeDeployDir();
    const stateKey = `${__appProcessTest.APP_STATE_PREFIX}app-crashed`;
    settingStore.set(stateKey, JSON.stringify({
      version: 2,
      appId: 'app-crashed',
      deployId: 'user-2-crashed',
      port: 5005,
      containerName: 'bridgesllm-project-app-user-2-crashed',
      containerId: 'container-crashed',
      deployPath: deployDir,
      status: 'running',
      desiredStatus: 'running',
      restartCount: 1,
      containerRestartCount: 1,
      updatedAt: new Date().toISOString(),
      actorId: 'user-2',
      projectId: APP_IDENTITY.projectId,
      workloadId: 'app-crashed',
    }));
    prismaMock.app.findMany.mockResolvedValue([{
      id: 'app-crashed',
      userId: 'user-2',
      projectIdentityId: APP_IDENTITY.projectId,
      name: 'crashed',
      zipPath: deployDir,
      port: 5005,
      deployType: 'fullstack',
      processStatus: 'running',
    }]);
    prismaMock.projectIdentity.findUnique.mockResolvedValue({
      id: APP_IDENTITY.projectId,
      workspaceOwnerId: 'user-2',
      projectName: 'crashed',
      lifecycleStatus: 'ACTIVE',
    });
    lifecycleMock.inspectProjectAppContainer.mockReturnValue({
      running: false,
      status: 'exited',
      exitCode: 1,
      restartCount: 3,
      error: '',
    });

    try {
      await initializeAppProcessRuntime();

      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
      expect(prismaMock.app.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'app-crashed', processStatus: { not: 'error' } },
        data: { processStatus: 'error' },
      });
      expect(JSON.parse(settingStore.get(stateKey) || '{}')).toEqual(expect.objectContaining({
        status: 'error',
        desiredStatus: 'error',
        restartCount: 3,
        containerRestartCount: 3,
      }));
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('removes a stale container when persisted database intent is stopped', async () => {
    const deployDir = makeDeployDir();
    prismaMock.app.findMany.mockResolvedValue([{
      id: 'app-stopped',
      userId: 'user-3',
      projectIdentityId: APP_IDENTITY.projectId,
      name: 'stopped',
      zipPath: deployDir,
      port: 5006,
      deployType: 'fullstack',
      processStatus: 'stopped',
    }]);
    prismaMock.projectIdentity.findUnique.mockResolvedValue({
      id: APP_IDENTITY.projectId,
      workspaceOwnerId: 'user-3',
      projectName: 'stopped',
      lifecycleStatus: 'ACTIVE',
    });

    try {
      await initializeAppProcessRuntime();

      expect(lifecycleMock.stopProjectAppContainer).toHaveBeenCalledWith({
        actorId: 'user-3',
        projectId: APP_IDENTITY.projectId,
        workloadId: 'app-stopped',
      });
      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
      expect(getAppStatus('user-3-stopped')).toBeNull();
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('contains one stopped App cleanup failure and continues reconciling other Apps', async () => {
    const stoppedDir = makeDeployDir();
    const runningDir = makeDeployDir();
    const stoppedProjectId = 'project-stopped-cleanup-failure';
    const runningProjectId = 'project-running-after-cleanup-failure';
    prismaMock.app.findMany.mockResolvedValue([
      {
        id: 'app-stopped-cleanup-failure',
        userId: 'user-stopped-cleanup-failure',
        projectIdentityId: stoppedProjectId,
        name: 'stopped-cleanup-failure',
        zipPath: stoppedDir,
        port: 5020,
        deployType: 'fullstack',
        processStatus: 'stopped',
      },
      {
        id: 'app-running-after-cleanup-failure',
        userId: 'user-running-after-cleanup-failure',
        projectIdentityId: runningProjectId,
        name: 'running-after-cleanup-failure',
        zipPath: runningDir,
        port: 5021,
        deployType: 'fullstack',
        processStatus: 'running',
      },
    ]);
    prismaMock.projectIdentity.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === stoppedProjectId) {
        return {
          id: stoppedProjectId,
          workspaceOwnerId: 'user-stopped-cleanup-failure',
          projectName: 'stopped-cleanup-failure',
          lifecycleStatus: 'ACTIVE',
        };
      }
      return {
        id: runningProjectId,
        workspaceOwnerId: 'user-running-after-cleanup-failure',
        projectName: 'running-after-cleanup-failure',
        lifecycleStatus: 'ACTIVE',
      };
    });
    lifecycleMock.stopProjectAppContainer.mockRejectedValueOnce(
      new Error('exact stale container attestation failed'),
    );
    lifecycleMock.inspectProjectAppContainer.mockReturnValue(null);

    try {
      await expect(initializeAppProcessRuntime()).resolves.toBeUndefined();

      expect(lifecycleMock.stopProjectAppContainer).toHaveBeenCalledWith({
        actorId: 'user-stopped-cleanup-failure',
        projectId: stoppedProjectId,
        workloadId: 'app-stopped-cleanup-failure',
      });
      expect(prismaMock.app.updateMany).toHaveBeenCalledWith({
        where: { id: 'app-stopped-cleanup-failure', processStatus: { not: 'error' } },
        data: { processStatus: 'error' },
      });
      expect(lifecycleMock.startProjectAppContainer).toHaveBeenCalledWith(expect.objectContaining({
        actorId: 'user-running-after-cleanup-failure',
        projectId: runningProjectId,
        workloadId: 'app-running-after-cleanup-failure',
      }));
    } finally {
      rmSync(stoppedDir, { recursive: true, force: true });
      rmSync(runningDir, { recursive: true, force: true });
    }
  });

  it.each(['RENAMING', 'DELETING'] as const)(
    'settles an interrupted %s lifecycle runtime instead of blocking Portal startup',
    async (lifecycleStatus) => {
      const deployDir = makeDeployDir();
      const appId = `app-interrupted-${lifecycleStatus.toLowerCase()}`;
      const ownerId = `user-interrupted-${lifecycleStatus.toLowerCase()}`;
      const projectId = `project-interrupted-${lifecycleStatus.toLowerCase()}`;
      const projectName = `interrupted-${lifecycleStatus.toLowerCase()}`;
      const deployId = `${ownerId}-${projectName}`;
      const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;
      settingStore.set(stateKey, JSON.stringify({
        version: 2,
        appId,
        deployId,
        port: 5014,
        containerName: `bridgesllm-project-app-${appId}`,
        containerId: `container-${appId}`,
        deployPath: deployDir,
        status: 'running',
        desiredStatus: 'running',
        restartCount: 0,
        containerRestartCount: 0,
        updatedAt: new Date().toISOString(),
        actorId: ownerId,
        projectId,
        workloadId: appId,
      }));
      prismaMock.app.findMany.mockResolvedValue([{
        id: appId,
        userId: ownerId,
        projectIdentityId: projectId,
        name: projectName,
        zipPath: deployDir,
        port: 5014,
        deployType: 'fullstack',
        processStatus: 'running',
      }]);
      prismaMock.projectIdentity.findUnique.mockResolvedValue({
        id: projectId,
        workspaceOwnerId: ownerId,
        projectName,
        lifecycleStatus,
      });

      try {
        await expect(initializeAppProcessRuntime()).resolves.toBeUndefined();

        expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
        expect(lifecycleMock.stopProjectAppContainer).toHaveBeenCalledWith({
          actorId: ownerId,
          projectId,
          workloadId: appId,
        });
        expect(settingStore.has(stateKey)).toBe(false);
        expect(appStatusStore.get(appId)).toBe('stopped');
        expect(getAppStatus(deployId)).toBeNull();
        expect(prismaMock.app.updateMany).toHaveBeenCalledWith({
          where: {
            id: appId,
            projectIdentityId: projectId,
            userId: ownerId,
            deployType: 'fullstack',
            zipPath: deployDir,
            port: 5014,
          },
          data: { processStatus: 'stopped' },
        });
      } finally {
        rmSync(deployDir, { recursive: true, force: true });
      }
    },
  );

  it('contains an unknown non-active Project lifecycle state to the affected App', async () => {
    const deployDir = makeDeployDir();
    prismaMock.app.findMany.mockResolvedValue([{
      id: 'app-unknown-lifecycle',
      userId: 'user-unknown-lifecycle',
      projectIdentityId: 'project-unknown-lifecycle',
      name: 'unknown-lifecycle',
      zipPath: deployDir,
      port: 5015,
      deployType: 'fullstack',
      processStatus: 'running',
    }]);
    prismaMock.projectIdentity.findUnique.mockResolvedValue({
      id: 'project-unknown-lifecycle',
      workspaceOwnerId: 'user-unknown-lifecycle',
      projectName: 'unknown-lifecycle',
      lifecycleStatus: 'CORRUPT',
    });

    try {
      await expect(initializeAppProcessRuntime()).resolves.toBeUndefined();
      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
      expect(lifecycleMock.stopProjectAppContainer).not.toHaveBeenCalled();
      expect(prismaMock.app.updateMany).toHaveBeenCalledWith({
        where: { id: 'app-unknown-lifecycle', processStatus: { not: 'error' } },
        data: { processStatus: 'error' },
      });
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('preserves mismatched runtime evidence during interrupted lifecycle startup cleanup', async () => {
    const deployDir = makeDeployDir();
    const appId = 'app-interrupted-mismatch';
    const ownerId = 'user-interrupted-mismatch';
    const projectId = 'project-interrupted-mismatch';
    const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;
    const mismatchedValue = JSON.stringify({
      version: 2,
      appId,
      deployId: `${ownerId}-interrupted-mismatch`,
      port: 5016,
      containerName: `bridgesllm-project-app-${appId}`,
      containerId: `container-${appId}`,
      deployPath: `${deployDir}-different`,
      status: 'running',
      desiredStatus: 'running',
      restartCount: 0,
      containerRestartCount: 0,
      updatedAt: new Date().toISOString(),
      actorId: ownerId,
      projectId,
      workloadId: appId,
    });
    settingStore.set(stateKey, mismatchedValue);
    prismaMock.app.findMany.mockResolvedValue([{
      id: appId,
      userId: ownerId,
      projectIdentityId: projectId,
      name: 'interrupted-mismatch',
      zipPath: deployDir,
      port: 5016,
      deployType: 'fullstack',
      processStatus: 'running',
    }]);
    prismaMock.projectIdentity.findUnique.mockResolvedValue({
      id: projectId,
      workspaceOwnerId: ownerId,
      projectName: 'interrupted-mismatch',
      lifecycleStatus: 'RENAMING',
    });

    try {
      await expect(initializeAppProcessRuntime()).rejects.toMatchObject({
        code: 'PROJECT_RUNTIME_STATE_ATTESTATION_FAILED',
      });
      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
      expect(lifecycleMock.stopProjectAppContainer).not.toHaveBeenCalled();
      expect(prismaMock.app.updateMany).not.toHaveBeenCalled();
      expect(settingStore.get(stateKey)).toBe(mismatchedValue);
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('forgets an orphan manager lane through exact container identity before durable state removal', async () => {
    const appId = 'app-orphan-manager';
    const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;
    settingStore.set(stateKey, JSON.stringify({
      version: 2,
      appId,
      deployId: 'user-1-orphan',
      port: 5006,
      containerName: `bridgesllm-project-app-${appId}`,
      containerId: 'container-orphan',
      deployPath: '/managed/orphan',
      status: 'running',
      desiredStatus: 'running',
      restartCount: 0,
      containerRestartCount: 0,
      updatedAt: new Date().toISOString(),
      actorId: APP_IDENTITY.actorId,
      projectId: APP_IDENTITY.projectId,
      workloadId: appId,
    }));

    await forgetAppRuntime(appId, 'user-1-orphan', {
      ...APP_IDENTITY,
      deployPath: '/managed/orphan',
      port: 5006,
    });

    expect(lifecycleMock.stopProjectAppContainer).toHaveBeenCalledWith({
      ...APP_IDENTITY,
      workloadId: appId,
    });
    expect(settingStore.has(stateKey)).toBe(false);
    expect(prismaMock.app.update).not.toHaveBeenCalled();
  });

  it('fences delayed material reconciliation writes before Stop settles durable intent', async () => {
    const deployDir = makeDeployDir();
    const appId = 'app-stop-write-race';
    const deployId = 'user-1-stop-write-race';
    const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;
    const delayedStatusWrite = deferred<void>();
    const delayedStateWrite = deferred<void>();
    const heldRemoval = deferred<void>();

    try {
      await startApp(appId, deployId, deployDir, 5006, APP_IDENTITY);
      expect(appStatusStore.get(appId)).toBe('running');
      expect(settingStore.has(stateKey)).toBe(true);

      const statusCallsBeforeQueuedRead = prismaMock.app.updateMany.mock.calls.length;
      const stateCallsBeforeQueuedRead = prismaMock.systemSetting.upsert.mock.calls.length;

      prismaMock.app.updateMany.mockImplementationOnce(async ({ where, data }: any) => {
        await delayedStatusWrite.promise;
        appStatusStore.set(where.id, data.processStatus);
        return { count: 1 };
      });
      prismaMock.systemSetting.upsert.mockImplementationOnce(async ({ where, create, update }: any) => {
        await delayedStateWrite.promise;
        const value = settingStore.has(where.key) ? update.value : create.value;
        settingStore.set(where.key, value);
        return { key: where.key, value };
      });

      // Force a real running→error transition. Observation-only reads are now
      // persistence-free, while this material reconciliation still admits
      // both fire-and-forget writes before runtime retirement.
      lifecycleMock.inspectProjectAppContainer.mockReturnValue({
        running: false,
        status: 'exited',
        exitCode: 7,
        restartCount: 0,
        error: 'delayed reconciliation fixture',
      });
      expect(getAppStatus(deployId)).toEqual(expect.objectContaining({ status: 'error' }));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (prismaMock.app.updateMany.mock.calls.length > statusCallsBeforeQueuedRead
          && prismaMock.systemSetting.upsert.mock.calls.length > stateCallsBeforeQueuedRead) break;
        await flushAsyncWork();
      }
      expect(prismaMock.app.updateMany.mock.calls.length).toBe(statusCallsBeforeQueuedRead + 1);
      expect(prismaMock.systemSetting.upsert.mock.calls.length).toBe(stateCallsBeforeQueuedRead + 1);

      lifecycleMock.stopProjectAppContainer.mockImplementationOnce(() => heldRemoval.promise);
      let cleanupSettled = false;
      const cleanup = forgetAppRuntime(appId, deployId, {
        ...APP_IDENTITY,
        deployPath: deployDir,
        port: 5006,
      }, { settleStatus: 'stopped' }).finally(() => {
        cleanupSettled = true;
      });

      for (let attempt = 0; attempt < 20 && lifecycleMock.stopProjectAppContainer.mock.calls.length < 1; attempt += 1) {
        await flushAsyncWork();
      }
      expect(lifecycleMock.stopProjectAppContainer).toHaveBeenCalled();

      // Once retirement starts, status and hosted proxy reads cannot discover
      // the lane or admit another persistence write while Docker is pending.
      const statusCallsDuringRemoval = prismaMock.app.updateMany.mock.calls.length;
      const stateCallsDuringRemoval = prismaMock.systemSetting.upsert.mock.calls.length;
      expect(getAppStatus(deployId)).toBeNull();
      expect(getAppTarget(deployId)).toBeNull();
      await flushAsyncWork();
      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(statusCallsDuringRemoval);
      expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(stateCallsDuringRemoval);

      heldRemoval.resolve();
      await flushAsyncWork();
      expect(cleanupSettled).toBe(false);
      expect(settingStore.has(stateKey)).toBe(true);

      // The old implementation crossed its delete/update boundaries while
      // these writes were unresolved. The fenced implementation waits, then
      // re-reads, attests, settles, and deletes after both have landed.
      delayedStatusWrite.resolve();
      delayedStateWrite.resolve();
      await cleanup;

      expect(settingStore.has(stateKey)).toBe(false);
      expect(appStatusStore.get(appId)).toBe('stopped');
      expect(getAppStatus(deployId)).toBeNull();
      expect(getAppTarget(deployId)).toBeNull();
      expect(prismaMock.app.updateMany).toHaveBeenCalledWith({
        where: {
          id: appId,
          projectIdentityId: APP_IDENTITY.projectId,
          userId: APP_IDENTITY.actorId,
          deployType: 'fullstack',
          zipPath: deployDir,
          port: 5006,
        },
        data: { processStatus: 'stopped' },
      });

      const startsBeforeRestart = lifecycleMock.startProjectAppContainer.mock.calls.length;
      prismaMock.app.findMany.mockResolvedValue([{
        id: appId,
        userId: APP_IDENTITY.actorId,
        projectIdentityId: APP_IDENTITY.projectId,
        name: 'stop-write-race',
        zipPath: deployDir,
        port: 5006,
        deployType: 'fullstack',
        processStatus: appStatusStore.get(appId),
      }]);
      prismaMock.projectIdentity.findUnique.mockResolvedValue({
        id: APP_IDENTITY.projectId,
        workspaceOwnerId: APP_IDENTITY.actorId,
        projectName: 'stop-write-race',
        lifecycleStatus: 'ACTIVE',
      });

      await initializeAppProcessRuntime();
      expect(lifecycleMock.startProjectAppContainer).toHaveBeenCalledTimes(startsBeforeRestart);
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('preserves durable evidence and App intent when exact container removal fails', async () => {
    const deployDir = makeDeployDir();
    const appId = 'app-stop-failure';
    const deployId = 'user-1-stop-failure';
    const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;

    try {
      await startApp(appId, deployId, deployDir, 5007, APP_IDENTITY);
      const stateBefore = settingStore.get(stateKey);
      expect(stateBefore).toBeDefined();
      expect(appStatusStore.get(appId)).toBe('running');
      prismaMock.app.updateMany.mockClear();
      lifecycleMock.stopProjectAppContainer.mockRejectedValueOnce(new Error('container removal failed'));

      await expect(forgetAppRuntime(appId, deployId, {
        ...APP_IDENTITY,
        deployPath: deployDir,
        port: 5007,
      }, { settleStatus: 'stopped' })).rejects.toThrow('container removal failed');

      expect(settingStore.get(stateKey)).toBe(stateBefore);
      expect(appStatusStore.get(appId)).toBe('running');
      expect(prismaMock.app.updateMany).not.toHaveBeenCalled();
      expect(getAppStatus(deployId)).toBeNull();
      expect(getAppTarget(deployId)).toBeNull();

      await expect(forgetAppRuntime(appId, deployId, {
        ...APP_IDENTITY,
        deployPath: deployDir,
        port: 5007,
      }, { settleStatus: 'stopped' })).resolves.toBeUndefined();
      expect(settingStore.has(stateKey)).toBe(false);
      expect(appStatusStore.get(appId)).toBe('stopped');
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('re-attests durable state after container removal and preserves a concurrent replacement', async () => {
    const deployDir = makeDeployDir();
    const appId = 'app-final-attestation-race';
    const deployId = 'user-1-final-attestation-race';
    const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;
    const heldRemoval = deferred<void>();

    try {
      await startApp(appId, deployId, deployDir, 5008, APP_IDENTITY);
      const replacementState = JSON.stringify({
        ...JSON.parse(settingStore.get(stateKey) || '{}'),
        deployId: `${deployId}-replacement`,
        updatedAt: new Date().toISOString(),
      });
      prismaMock.app.updateMany.mockClear();
      lifecycleMock.stopProjectAppContainer.mockImplementationOnce(() => heldRemoval.promise);

      const cleanup = forgetAppRuntime(appId, deployId, {
        ...APP_IDENTITY,
        deployPath: deployDir,
        port: 5008,
      }, { settleStatus: 'stopped' });
      for (let attempt = 0; attempt < 20 && lifecycleMock.stopProjectAppContainer.mock.calls.length < 1; attempt += 1) {
        await flushAsyncWork();
      }
      settingStore.set(stateKey, replacementState);
      heldRemoval.resolve();

      await expect(cleanup).rejects.toMatchObject({
        code: 'PROJECT_RUNTIME_STATE_ATTESTATION_FAILED',
      });
      expect(settingStore.get(stateKey)).toBe(replacementState);
      expect(appStatusStore.get(appId)).toBe('running');
      expect(prismaMock.app.updateMany).not.toHaveBeenCalled();
      expect(getAppStatus(deployId)).toBeNull();
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('rolls back stopped intent when the final durable-state CAS loses', async () => {
    const deployDir = makeDeployDir();
    const appId = 'app-final-cas-race';
    const deployId = 'user-1-final-cas-race';
    const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;

    try {
      await startApp(appId, deployId, deployDir, 5009, APP_IDENTITY);
      const originalState = settingStore.get(stateKey);
      expect(originalState).toBeDefined();
      prismaMock.app.updateMany.mockClear();
      prismaMock.systemSetting.deleteMany.mockImplementationOnce(async ({ where }: any) => {
        settingStore.set(where.key, `${where.value}\n`);
        return { count: 0 };
      });

      await expect(forgetAppRuntime(appId, deployId, {
        ...APP_IDENTITY,
        deployPath: deployDir,
        port: 5009,
      }, { settleStatus: 'stopped' })).rejects.toMatchObject({
        code: 'PROJECT_RUNTIME_STATE_ATTESTATION_FAILED',
      });

      expect(settingStore.get(stateKey)).toBe(originalState);
      expect(appStatusStore.get(appId)).toBe('running');
      expect(prismaMock.app.updateMany).toHaveBeenCalledTimes(1);
      expect(getAppStatus(deployId)).toBeNull();

      await expect(forgetAppRuntime(appId, deployId, {
        ...APP_IDENTITY,
        deployPath: deployDir,
        port: 5009,
      }, { settleStatus: 'stopped' })).resolves.toBeUndefined();
      expect(settingStore.has(stateKey)).toBe(false);
      expect(appStatusStore.get(appId)).toBe('stopped');
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it.each(['malformed', 'mismatched'] as const)(
    'refuses recovery Stop when durable runtime state is %s',
    async (kind) => {
      const appId = `app-recovery-${kind}`;
      const deployId = `user-1-recovery-${kind}`;
      const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;
      const expected = {
        ...APP_IDENTITY,
        deployPath: `/managed/recovery-${kind}`,
        port: 5010,
      };
      const value = kind === 'malformed'
        ? '{not-json'
        : JSON.stringify({
          version: 2,
          appId,
          deployId: `${deployId}-other`,
          port: expected.port,
          containerName: `bridgesllm-project-app-${appId}`,
          containerId: `container-${appId}`,
          deployPath: expected.deployPath,
          status: 'running',
          desiredStatus: 'running',
          restartCount: 0,
          containerRestartCount: 0,
          updatedAt: new Date().toISOString(),
          actorId: expected.actorId,
          projectId: expected.projectId,
          workloadId: appId,
        });
      settingStore.set(stateKey, value);

      await expect(forgetAppRuntime(appId, deployId, expected)).rejects.toMatchObject({
        code: 'PROJECT_RUNTIME_STATE_ATTESTATION_FAILED',
      });

      expect(lifecycleMock.stopProjectAppContainer).not.toHaveBeenCalled();
      expect(prismaMock.systemSetting.deleteMany).not.toHaveBeenCalled();
      expect(prismaMock.app.update).not.toHaveBeenCalled();
      expect(settingStore.get(stateKey)).toBe(value);
    },
  );

  it('removes only Portal shadow state and never restores an externally bound App', async () => {
    const deployDir = makeDeployDir();
    const appId = 'app-external';
    const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;
    const environmentKey = 'APP_API_TARGET_APP_EXTERNAL';
    const previousTarget = process.env[environmentKey];
    process.env[environmentKey] = 'http://127.0.0.1:5999';
    settingStore.set(stateKey, JSON.stringify({
      version: 2,
      appId,
      deployId: 'user-external-service',
      port: 5007,
      containerName: `bridgesllm-project-app-${appId}`,
      containerId: 'container-external-shadow',
      deployPath: deployDir,
      status: 'running',
      desiredStatus: 'running',
      restartCount: 0,
      containerRestartCount: 0,
      updatedAt: new Date().toISOString(),
      actorId: 'user-external',
      projectId: APP_IDENTITY.projectId,
      workloadId: appId,
    }));
    const appRecord = {
      id: appId,
      userId: 'user-external',
      projectIdentityId: APP_IDENTITY.projectId,
      name: 'service',
      zipPath: deployDir,
      port: 5007,
      deployType: 'fullstack',
      processStatus: 'running',
    };
    prismaMock.app.findMany.mockResolvedValue([appRecord]);
    prismaMock.projectIdentity.findUnique.mockResolvedValue({
      id: APP_IDENTITY.projectId,
      workspaceOwnerId: 'user-external',
      projectName: 'service',
      lifecycleStatus: 'ACTIVE',
    });

    try {
      await initializeAppProcessRuntime();

      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
      expect(lifecycleMock.runProjectLifecycleCommand).not.toHaveBeenCalled();
      expect(lifecycleMock.stopProjectAppContainer).toHaveBeenCalledWith({
        actorId: 'user-external',
        projectId: APP_IDENTITY.projectId,
        workloadId: appId,
      });
      expect(prismaMock.app.update).not.toHaveBeenCalled();
      expect(settingStore.has(stateKey)).toBe(false);
      expect(appStatusStore.get(appId)).toBe('stopped');
      expect(prismaMock.app.updateMany).toHaveBeenCalledWith({
        where: {
          id: appId,
          projectIdentityId: APP_IDENTITY.projectId,
          userId: 'user-external',
          deployType: 'fullstack',
          zipPath: deployDir,
          port: 5007,
        },
        data: { processStatus: 'stopped' },
      });
      expect(getAppStatus('user-external-service')).toBeNull();

      // Removing the operator binding later must not reinterpret the stale
      // pre-adoption running intent and resurrect a Portal shadow container.
      delete process.env[environmentKey];
      __appProcessTest.resetRuntimeState();
      lifecycleMock.startProjectAppContainer.mockClear();
      prismaMock.app.findMany.mockResolvedValue([{
        ...appRecord,
        processStatus: appStatusStore.get(appId),
      }]);

      await initializeAppProcessRuntime();

      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
      expect(getAppStatus('user-external-service')).toBeNull();
    } finally {
      if (previousTarget === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = previousTarget;
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('fails startup and preserves durable external state when cleanup identity is unattested', async () => {
    const deployDir = makeDeployDir();
    const appId = 'app-external-unattested';
    const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;
    const environmentKey = 'APP_API_TARGET_APP_EXTERNAL_UNATTESTED';
    const previousTarget = process.env[environmentKey];
    process.env[environmentKey] = 'http://127.0.0.1:5998';
    const persistedValue = JSON.stringify({
      version: 2,
      appId,
      deployId: 'user-external-unattested-service',
      port: 5008,
      containerName: `bridgesllm-project-app-${appId}`,
      containerId: 'container-unattested-shadow',
      deployPath: deployDir,
      status: 'running',
      desiredStatus: 'running',
      restartCount: 0,
      containerRestartCount: 0,
      updatedAt: new Date().toISOString(),
      actorId: 'user-external-unattested',
      projectId: 'unattested-project',
      workloadId: appId,
    });
    settingStore.set(stateKey, persistedValue);
    prismaMock.app.findMany.mockResolvedValue([{
      id: appId,
      userId: 'user-external-unattested',
      projectIdentityId: null,
      name: 'service',
      zipPath: deployDir,
      port: 5008,
      deployType: 'fullstack',
      processStatus: 'running',
    }]);

    try {
      await expect(initializeAppProcessRuntime()).rejects.toMatchObject({
        code: 'PROJECT_RUNTIME_STATE_ATTESTATION_FAILED',
      });
      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
      expect(lifecycleMock.stopProjectAppContainer).not.toHaveBeenCalled();
      expect(prismaMock.app.update).not.toHaveBeenCalled();
      expect(settingStore.get(stateKey)).toBe(persistedValue);
    } finally {
      if (previousTarget === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = previousTarget;
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it.each(['malformed', 'mismatched'] as const)(
    'preserves %s external runtime evidence even when the current Project identity is valid',
    async (kind) => {
      const deployDir = makeDeployDir();
      const appId = `app-external-valid-${kind}`;
      const ownerId = `user-external-valid-${kind}`;
      const projectId = `project-external-valid-${kind}`;
      const deployId = `${ownerId}-service`;
      const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;
      const environmentKey = `APP_API_TARGET_${appId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      const previousTarget = process.env[environmentKey];
      process.env[environmentKey] = 'http://127.0.0.1:5995';
      const value = kind === 'malformed'
        ? 'not-json'
        : JSON.stringify({
          version: 2,
          appId,
          deployId,
          port: 5011,
          containerName: `bridgesllm-project-app-${appId}`,
          containerId: `container-${appId}`,
          deployPath: `${deployDir}-mismatch`,
          status: 'running',
          desiredStatus: 'running',
          restartCount: 0,
          containerRestartCount: 0,
          updatedAt: new Date().toISOString(),
          actorId: ownerId,
          projectId,
          workloadId: appId,
        });
      settingStore.set(stateKey, value);
      prismaMock.app.findMany.mockResolvedValue([{
        id: appId,
        userId: ownerId,
        projectIdentityId: projectId,
        name: 'service',
        zipPath: deployDir,
        port: 5011,
        deployType: 'fullstack',
        processStatus: 'running',
      }]);
      prismaMock.projectIdentity.findUnique.mockResolvedValue({
        id: projectId,
        workspaceOwnerId: ownerId,
        projectName: 'service',
        lifecycleStatus: 'ACTIVE',
      });

      try {
        await expect(initializeAppProcessRuntime()).rejects.toMatchObject({
          code: 'PROJECT_RUNTIME_STATE_ATTESTATION_FAILED',
        });
        expect(lifecycleMock.stopProjectAppContainer).not.toHaveBeenCalled();
        expect(prismaMock.systemSetting.deleteMany).not.toHaveBeenCalled();
        expect(prismaMock.app.update).not.toHaveBeenCalled();
        expect(settingStore.get(stateKey)).toBe(value);
      } finally {
        if (previousTarget === undefined) delete process.env[environmentKey];
        else process.env[environmentKey] = previousTarget;
        rmSync(deployDir, { recursive: true, force: true });
      }
    },
  );

  it('leaves an external standalone App alone when no Portal runtime state exists', async () => {
    const appId = 'app-external-standalone';
    const environmentKey = 'APP_API_TARGET_APP_EXTERNAL_STANDALONE';
    const previousTarget = process.env[environmentKey];
    process.env[environmentKey] = 'http://127.0.0.1:5997';
    prismaMock.app.findMany.mockResolvedValue([{
      id: appId,
      userId: 'user-external-standalone',
      projectIdentityId: null,
      name: 'standalone',
      zipPath: '/operator-owned/standalone',
      port: 5009,
      deployType: 'fullstack',
      processStatus: 'running',
    }]);

    try {
      await expect(initializeAppProcessRuntime()).resolves.toBeUndefined();
      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
      expect(lifecycleMock.stopProjectAppContainer).not.toHaveBeenCalled();
      expect(prismaMock.app.update).not.toHaveBeenCalled();
      expect(prismaMock.systemSetting.deleteMany).not.toHaveBeenCalled();
    } finally {
      if (previousTarget === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = previousTarget;
    }
  });

  it('never restores an invalid binding and preserves its attested durable state for repair', async () => {
    const deployDir = makeDeployDir();
    const appId = 'app-invalid-binding';
    const ownerId = 'user-invalid-binding';
    const projectId = 'project-invalid-binding';
    const deployId = `${ownerId}-service`;
    const stateKey = `${__appProcessTest.APP_STATE_PREFIX}${appId}`;
    const environmentKey = 'APP_API_TARGET_APP_INVALID_BINDING';
    const previousTarget = process.env[environmentKey];
    process.env[environmentKey] = '   ';
    const value = JSON.stringify({
      version: 2,
      appId,
      deployId,
      port: 5012,
      containerName: `bridgesllm-project-app-${appId}`,
      containerId: `container-${appId}`,
      deployPath: deployDir,
      status: 'running',
      desiredStatus: 'running',
      restartCount: 0,
      containerRestartCount: 0,
      updatedAt: new Date().toISOString(),
      actorId: ownerId,
      projectId,
      workloadId: appId,
    });
    settingStore.set(stateKey, value);
    prismaMock.app.findMany.mockResolvedValue([{
      id: appId,
      userId: ownerId,
      projectIdentityId: projectId,
      name: 'service',
      zipPath: deployDir,
      port: 5012,
      deployType: 'fullstack',
      processStatus: 'running',
    }]);
    prismaMock.projectIdentity.findUnique.mockResolvedValue({
      id: projectId,
      workspaceOwnerId: ownerId,
      projectName: 'service',
      lifecycleStatus: 'ACTIVE',
    });

    try {
      await initializeAppProcessRuntime();
      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
      expect(lifecycleMock.stopProjectAppContainer).toHaveBeenCalledWith({
        actorId: ownerId,
        projectId,
        workloadId: appId,
      });
      expect(prismaMock.systemSetting.deleteMany).not.toHaveBeenCalled();
      expect(prismaMock.app.update).not.toHaveBeenCalled();
      expect(settingStore.get(stateKey)).toBe(value);
    } finally {
      if (previousTarget === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = previousTarget;
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('contains a running standalone App without authorizing an owner/name coincidence', async () => {
    const deployDir = makeDeployDir();
    prismaMock.app.findMany.mockResolvedValue([{
      id: 'app-standalone',
      userId: 'user-4',
      projectIdentityId: null,
      name: 'same-name',
      zipPath: deployDir,
      port: 5009,
      deployType: 'fullstack',
      processStatus: 'running',
    }]);
    prismaMock.projectIdentity.findUnique.mockResolvedValue({
      id: 'unrelated-project',
      workspaceOwnerId: 'user-4',
      projectName: 'same-name',
      lifecycleStatus: 'ACTIVE',
    });

    try {
      await expect(initializeAppProcessRuntime()).resolves.toBeUndefined();

      expect(prismaMock.projectIdentity.findUnique).not.toHaveBeenCalled();
      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
      expect(lifecycleMock.stopProjectAppContainer).not.toHaveBeenCalled();
      expect(prismaMock.app.updateMany).toHaveBeenCalledWith({
        where: { id: 'app-standalone', processStatus: { not: 'error' } },
        data: { processStatus: 'error' },
      });
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('rejects a stale App association in update preflight, then contains it on ordinary boot', async () => {
    const deployDir = makeDeployDir();
    prismaMock.app.findMany.mockResolvedValue([{
      id: 'app-wrong-project',
      userId: 'user-5',
      projectIdentityId: 'wrong-project-id',
      name: 'expected-name',
      zipPath: deployDir,
      port: 5010,
      deployType: 'fullstack',
      processStatus: 'starting',
    }]);
    prismaMock.projectIdentity.findUnique.mockResolvedValue({
      id: 'wrong-project-id',
      workspaceOwnerId: 'different-owner',
      projectName: 'different-name',
      lifecycleStatus: 'ACTIVE',
    });

    try {
      await expect(preflightAppProcessRuntimeRestoration({
        rejectUnsafeRunningApps: true,
      })).rejects.toThrow(
        'did not have an exact immutable Project association',
      );
      expect(prismaMock.app.updateMany).not.toHaveBeenCalled();

      await expect(initializeAppProcessRuntime()).resolves.toBeUndefined();
      expect(prismaMock.projectIdentity.findUnique).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'wrong-project-id' },
      }));
      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
      expect(lifecycleMock.stopProjectAppContainer).not.toHaveBeenCalled();
      expect(prismaMock.app.updateMany).toHaveBeenCalledWith({
        where: { id: 'app-wrong-project', processStatus: { not: 'error' } },
        data: { processStatus: 'error' },
      });
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('closes startup admission before shutdown and leaves no late container behind', async () => {
    const deployDir = makeDeployDir();
    let releaseLease: (() => void) | undefined;
    prismaMock.systemSetting.create.mockImplementationOnce(({ data }: any) => new Promise((resolve) => {
      releaseLease = () => {
        settingStore.set(data.key, data.value);
        resolve(data);
      };
    }));

    try {
      const starting = startApp('app-shutdown-race', 'deploy-shutdown-race', deployDir, 5007, APP_IDENTITY);
      const startingRejected = expect(starting).rejects.toThrow('App process runtime is shutting down');
      for (let attempt = 0; attempt < 20 && !releaseLease; attempt += 1) {
        await flushAsyncWork();
      }
      expect(releaseLease).toBeDefined();
      const shuttingDown = shutdownAll();
      releaseLease?.();

      await startingRejected;
      await shuttingDown;
      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
      expect(getAppStatus('deploy-shutdown-race')).toBeNull();
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('rejects stop and retirement mutations admitted after shutdown snapshots the deploy queue', async () => {
    const deployDir = makeDeployDir();
    const releaseShutdownStop = deferred<void>();

    try {
      await startApp('app-shutdown-stop-race', 'deploy-shutdown-stop-race', deployDir, 5007, APP_IDENTITY);
      lifecycleMock.stopProjectAppContainer.mockImplementationOnce(
        () => releaseShutdownStop.promise,
      );
      const statusWritesBeforeShutdown = prismaMock.app.updateMany.mock.calls.length;

      const shuttingDown = shutdownAll();
      await flushAsyncWork();

      await expect(stopApp('deploy-shutdown-stop-race')).rejects.toMatchObject({
        code: 'APP_PROCESS_RUNTIME_SHUTTING_DOWN',
      });
      await expect(forgetAppRuntime(
        'app-shutdown-stop-race',
        'deploy-shutdown-stop-race',
        {
          ...APP_IDENTITY,
          deployPath: deployDir,
          port: 5007,
        },
      )).rejects.toMatchObject({
        code: 'APP_PROCESS_RUNTIME_SHUTTING_DOWN',
      });

      // The rejected late calls neither perform a second container removal nor
      // publish a stopped/retired database state over graceful-restart intent.
      expect(prismaMock.app.updateMany.mock.calls.length).toBe(statusWritesBeforeShutdown);

      releaseShutdownStop.resolve();
      await shuttingDown;
      expect(lifecycleMock.stopProjectAppContainer).toHaveBeenCalledTimes(1);
      expect(prismaMock.app.updateMany.mock.calls.length).toBe(statusWritesBeforeShutdown);
      expect(getAppStatus('deploy-shutdown-stop-race')).toBeNull();
    } finally {
      releaseShutdownStop.resolve();
      rmSync(deployDir, { recursive: true, force: true });
    }
  });
});
