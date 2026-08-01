import net from 'net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const settingStore = new Map<string, string>();
const prismaMock = {
  app: {
    findMany: jest.fn(),
    update: jest.fn(),
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

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => prismaMock),
}));

jest.mock('../services/project-lifecycle.service', () => lifecycleMock);

import {
  __appProcessTest,
  allocatePort,
  getAppTarget,
  getAppStatus,
  initializeAppProcessRuntime,
  shutdownAll,
  startApp,
  stopApp,
} from '../services/app-process.service';

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

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('app-process.service', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    settingStore.clear();
    __appProcessTest.resetRuntimeState();

    prismaMock.app.update.mockResolvedValue({});
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

    lifecycleMock.startProjectAppContainer.mockImplementation(({ nameHint, actorId, projectId, workloadId }: any) => ({
      containerName: `bridgesllm-project-app-${nameHint}`,
      containerId: `container-${nameHint}`,
      networkAddress: '172.30.0.4',
      plan: { runtimeFingerprint: `fingerprint-${nameHint}`, identity: { actorId, projectId, workloadId } },
    }));
    lifecycleMock.inspectProjectAppContainer.mockReturnValue(runningContainer());
    lifecycleMock.readProjectAppLogs.mockReturnValue(['ready']);
    __appProcessTest.setReadinessProbe(async () => true);
  });

  afterEach(() => {
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
        runtimeFingerprint: 'fingerprint-deploy-1',
      }));
      expect(getAppStatus('deploy-1')).toBeNull();
      expect(prismaMock.app.update).toHaveBeenLastCalledWith({
        where: { id: 'app-1' },
        data: { processStatus: 'stopped' },
      });
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
      expect(prismaMock.app.update).toHaveBeenCalledWith({
        where: { id: 'app-ready' },
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
      expect(prismaMock.app.update).toHaveBeenCalledWith({
        where: { id: 'app-not-ready' },
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
      const callCountAfterStop = prismaMock.app.update.mock.calls.length;

      jest.advanceTimersByTime(__appProcessTest.STARTUP_TIMEOUT_MS * 2);
      await flushAsyncWork();

      expect(prismaMock.app.update).toHaveBeenCalledTimes(callCountAfterStop);
      expect(prismaMock.app.update).toHaveBeenLastCalledWith({
        where: { id: 'app-race' },
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
      prismaMock.app.update.mockClear();

      jest.advanceTimersByTime(__appProcessTest.STARTUP_TIMEOUT_MS);
      await flushAsyncWork();

      expect(prismaMock.app.update).not.toHaveBeenCalledWith({
        where: { id: 'app-old' },
        data: { processStatus: 'running' },
      });
      expect(prismaMock.app.update).toHaveBeenCalledWith({
        where: { id: 'app-new' },
        data: { processStatus: 'running' },
      });
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('serializes an in-flight startup status write ahead of a later stop', async () => {
    const deployDir = makeDeployDir();
    let releaseRunningWrite: (() => void) | undefined;
    try {
      await startApp('app-status-race', 'deploy-status-race', deployDir, 5003, APP_IDENTITY);
      prismaMock.app.update.mockImplementation(({ data }: any) => {
        if (data.processStatus !== 'running') return Promise.resolve({});
        return new Promise((resolve) => {
          releaseRunningWrite = () => resolve({});
        });
      });

      jest.advanceTimersByTime(__appProcessTest.STARTUP_PROBE_DELAY_MS);
      await flushAsyncWork();
      expect(releaseRunningWrite).toBeDefined();
      const stopping = stopApp('deploy-status-race');
      await flushAsyncWork();
      releaseRunningWrite?.();
      await stopping;

      expect(prismaMock.app.update).toHaveBeenLastCalledWith({
        where: { id: 'app-status-race' },
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
      expect(prismaMock.app.update).toHaveBeenLastCalledWith({
        where: { id: 'app-crashed' },
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

  it('does not authorize a running standalone App through an owner/name coincidence', async () => {
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
      await expect(initializeAppProcessRuntime()).rejects.toThrow(
        'did not have an exact immutable Project association',
      );

      expect(prismaMock.projectIdentity.findUnique).not.toHaveBeenCalled();
      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
      expect(prismaMock.app.update).not.toHaveBeenCalled();
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });

  it('fails startup without mutation when a running App foreign key resolves to another Project', async () => {
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
      await expect(initializeAppProcessRuntime()).rejects.toThrow(
        'did not have an exact immutable Project association',
      );
      expect(prismaMock.projectIdentity.findUnique).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'wrong-project-id' },
      }));
      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
      expect(prismaMock.app.update).not.toHaveBeenCalled();
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
      await flushAsyncWork();
      expect(releaseLease).toBeDefined();
      const shuttingDown = shutdownAll();
      releaseLease?.();

      await expect(starting).rejects.toThrow('App process runtime is shutting down');
      await shuttingDown;
      expect(lifecycleMock.startProjectAppContainer).not.toHaveBeenCalled();
      expect(getAppStatus('deploy-shutdown-race')).toBeNull();
    } finally {
      rmSync(deployDir, { recursive: true, force: true });
    }
  });
});
