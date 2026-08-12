import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';

jest.mock('../config/database', () => ({ prisma: {} }));
jest.mock('../config/env', () => ({ config: { portalProjectRuntimeImageId: '' } }));
jest.mock('./projectDependencyPromotionDecision', () => ({
  findProjectDependencyPromotionDecisionByDestination: jest.fn(async () => null),
  readProjectDependencyPromotionLifecycleByProject: jest.fn(async () => null),
  ProjectDependencyPromotionDecisionIndeterminateError: class extends Error {},
}));

import type { PortalProjectWorkloadPlan } from './projectWorkloadRuntime';
import type { ProjectLifecycleProcess } from './project-lifecycle.service';
import {
  acquireLockedProjectDependencyInstallTarget,
  runAuthorizedProjectDependencyInstall,
  type ProjectDependencyInstallDependencies,
  type ProjectDependencyInstallInput,
} from './projectDependencyInstall';
import {
  publishSessionRevoked,
  sessionRevocationSubscriberCount,
  subscribeToSessionRevocations,
} from './sessionRevocationBus';
import type { JwtPayload } from '../utils/jwt';
import { ProjectDependencyPromotionDecisionIndeterminateError } from './projectDependencyPromotionDecision';
import { ProjectDependencyPromotionWriterFenceError } from './projectDependencyPromotionWriterFence';
import {
  acquireProjectDeletionLock,
  projectDeletionLockKey,
  type ProjectDeletionLockLease,
} from './projectDeletionLock';

const NOW = new Date('2026-08-11T18:00:00.000Z');
const USER_ID = 'install-user';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.finish(null, signal);
    return true;
  }
}

function controlledJob() {
  const child = new FakeChildProcess();
  const cleanup = deferred<void>();
  const cancel = jest.fn(() => child.kill('SIGTERM'));
  const job: ProjectLifecycleProcess = {
    process: child as unknown as ChildProcess,
    containerName: 'dependency-job',
    cancel,
    cleanup: cleanup.promise,
    plan: {} as PortalProjectWorkloadPlan,
  };
  return { child, cleanup, cancel, job };
}

function payload(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    userId: USER_ID,
    sessionId: 'session-a',
    email: 'user@example.test',
    role: 'USER',
    accountStatus: 'ACTIVE',
    authorizationVersion: 3,
    ...overrides,
  };
}

function activeUser(sessionId = 'session-a') {
  return {
    id: USER_ID,
    email: 'user@example.test',
    role: 'USER',
    accountStatus: 'ACTIVE',
    isActive: true,
    sandboxEnabled: false,
    authorizationVersion: 3,
    sessions: [{ id: sessionId, expiresAt: new Date(NOW.getTime() + 60_000) }],
  };
}

function authorizationDependencies() {
  const unsubscribeAuthorization = jest.fn();
  const unsubscribeGlobalFence = jest.fn();
  const unsubscribeSession = jest.fn();
  return {
    dependencies: {
      database: { user: { findUnique: jest.fn(async () => activeUser()) } },
      now: () => NOW,
      setTimer: jest.fn(() => ({ unref: jest.fn() } as unknown as NodeJS.Timeout)),
      clearTimer: jest.fn(),
      subscribeAuthorization: jest.fn(() => unsubscribeAuthorization),
      subscribeGlobalFence: jest.fn(() => unsubscribeGlobalFence),
      subscribeSession: jest.fn((userId, sessionId, listener) => {
        const unsubscribe = subscribeToSessionRevocations(userId, sessionId, listener);
        return () => {
          unsubscribeSession();
          unsubscribe();
        };
      }),
    },
    unsubscribeAuthorization,
    unsubscribeGlobalFence,
    unsubscribeSession,
  };
}

function preparedPromotion() {
  return {
    manifest: {
      schemaVersion: 1 as const,
      operationId: '00000000-0000-4000-8000-000000000001',
      workspaceOwnerId: 'workspace-owner',
      projectName: 'Example',
      projectIdentityId: 'project-1',
      projectIdentityGeneration: 1,
      projectRootBirthtimeNs: '1',
      operationParentCanonicalRoot: '/live',
      operationParentIdentity: {
        device: '1', inode: '1', kind: 'directory' as const, mode: 0o755, uid: 0, gid: 0, birthtimeNs: '1',
      },
      destinationCanonicalRoot: '/live/project',
      destinationIdentity: {
        device: '1', inode: '2', kind: 'directory' as const, mode: 0o755, uid: 0, gid: 0, birthtimeNs: '1',
      },
      stagingCanonicalRoot: '/staging/promotion',
      stagingIdentity: {
        device: '1', inode: '3', kind: 'directory' as const, mode: 0o700, uid: 0, gid: 0, birthtimeNs: '2',
      },
      entries: [],
      manifestDigest: 'a'.repeat(64),
    },
    reattest: jest.fn(),
    commit: jest.fn(),
    rollback: jest.fn(),
    finalize: jest.fn(),
    cleanup: jest.fn(async () => {}),
    cleanupPreparedStagingOnly: jest.fn(async () => {}),
  };
}

function fakeLifecycleLock(): ProjectDeletionLockLease {
  let held = true;
  const lease = (() => { held = false; }) as ProjectDeletionLockLease;
  Object.defineProperties(lease, {
    key: { value: JSON.stringify(['workspace-owner', 'Example']) },
    workspaceOwnerId: { value: 'workspace-owner' },
    projectName: { value: 'Example' },
    isHeld: { value: () => held },
  });
  return lease;
}

function promotionBoundaryDependencies(): ProjectDependencyInstallDependencies {
  const handoff = {
    key: JSON.stringify(['workspace-owner', 'Example']),
    workspaceOwnerId: 'workspace-owner',
    projectName: 'Example',
    operationId: '00000000-0000-4000-8000-000000000001',
    manifestDigest: 'a'.repeat(64),
  } as any;
  const proof = { preDrain: {}, postDrain: {} } as any;
  let held = true;
  const fence = {
    proveQuiescent: jest.fn(async () => proof),
    assertHeld: jest.fn((candidate) => {
      if (!held || candidate !== proof) throw new Error('invalid fence proof');
    }),
    releaseAfterSafeState: jest.fn(async (attest) => {
      await attest();
      held = false;
    }),
    isHeld: () => held,
  };
  return {
    closeWriterFence: jest.fn((input) => {
      input.closeAdmissionAndSettleInstaller();
      input.releaseProjectLease();
      return fence;
    }),
    createLockHandoff: jest.fn(() => handoff),
    reacquireLock: jest.fn(async () => ({
      lifecycleLock: fakeLifecycleLock(),
      handoff,
    })) as any,
    assertPromotionLock: jest.fn(),
    attestFenceReleaseState: jest.fn(async () => {}),
    quarantinePromotion: jest.fn(async () => ({ lifecycleStatus: 'DEPENDENCY_QUARANTINED' })) as any,
  };
}

function successfulDecisionMocks() {
  return {
    ...promotionBoundaryDependencies(),
    authorizePromotion: jest.fn(async () => ({
      kind: 'authorized' as const,
      record: { status: 'AUTHORIZED' },
    })) as any,
    markPromotionApplied: jest.fn(async () => ({ status: 'APPLIED' })) as any,
    deletePromotionDecision: jest.fn(async () => true) as any,
  };
}

function refusedDecisionMock() {
  return jest.fn(async () => ({
    kind: 'denied' as const,
    reason: 'AUTHORIZATION_CHANGED' as const,
  })) as any;
}

type EstablishAuthorization = NonNullable<
  ProjectDependencyInstallDependencies['establishAuthorization']
>;

function rejectedAuthorizationMock(): EstablishAuthorization & jest.Mock {
  return jest.fn(async () => ({
    ok: false as const,
    reason: 'session_revoked' as const,
  })) as unknown as EstablishAuthorization & jest.Mock;
}

function harness(language: 'python' | 'node' = 'node') {
  let clientClosed = false;
  let clientCloseListener: (() => void) | null = null;
  const unsubscribeClientClose = jest.fn();
  const initialLock = fakeLifecycleLock();
  let routeLock: ProjectDeletionLockLease | null = initialLock;
  const admission = {
    waitForMutationDrain: jest.fn(async () => {}),
    release: jest.fn(),
  };
  const input: ProjectDependencyInstallInput = {
    payload: payload(),
    ownerId: 'workspace-owner',
    projectName: 'Example',
    projectId: 'project-1',
    projectDir: '/live/project',
    lifecycleLock: initialLock,
    closeGlobalAdmissionAndSettleRequest: jest.fn(() => admission),
    releaseLifecycleLock: jest.fn((expected) => {
      if (routeLock !== expected) throw new Error('wrong route lock release');
      routeLock = null;
      expected();
    }),
    adoptLifecycleLock: jest.fn((next) => {
      if (routeLock) throw new Error('route lock already held');
      routeLock = next;
    }),
    projectProof: {
      projectIdentityId: 'project-1',
      projectIdentityGeneration: 1,
      workspaceOwnerId: 'workspace-owner',
      projectName: 'Example',
      canonicalRoot: '/live/project',
      rootDevice: '1',
      rootInode: '2',
      rootBirthtimeNs: '1',
    },
    language,
    packages: language === 'python' ? ['requests'] : ['(npm install)'],
    onAuthorized: jest.fn(),
    onEvent: jest.fn(),
    onAuthorityLost: jest.fn(),
    subscribeClientClose: jest.fn((listener) => {
      clientCloseListener = listener;
      return unsubscribeClientClose;
    }),
    isClientClosed: () => clientClosed,
    writeDependencyCache: jest.fn(),
  };
  return {
    input,
    admission,
    unsubscribeClientClose,
    closeClient: () => {
      clientClosed = true;
      clientCloseListener?.();
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for dependency installer test state');
}

describe('durable-session Project dependency installation', () => {
  afterEach(() => {
    expect(sessionRevocationSubscriberCount()).toBe(0);
    jest.clearAllMocks();
  });

  test('legacy access token fails before SSE, workspace, or install work begins', async () => {
    const request = harness('node');
    delete request.input.payload.sessionId;
    const dependencies: ProjectDependencyInstallDependencies = {
      establishAuthorization: jest.fn(),
      createWorkspace: jest.fn(),
      spawnCommand: jest.fn(),
    };

    await expect(runAuthorizedProjectDependencyInstall(request.input, dependencies)).resolves.toEqual({
      status: 'authorization_denied',
      reason: 'session_revoked',
    });
    expect(dependencies.establishAuthorization).not.toHaveBeenCalled();
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
    expect(dependencies.spawnCommand).not.toHaveBeenCalled();
    expect(request.input.onAuthorized).not.toHaveBeenCalled();
  });

  test('exact revocation cancels the current Python venv container and never promotes', async () => {
    const auth = authorizationDependencies();
    const request = harness('python');
    const venv = controlledJob();
    const workspaceCleanup = jest.fn();
    const promotion = preparedPromotion();
    const dependencies: ProjectDependencyInstallDependencies = {
      ...promotionBoundaryDependencies(),
      authorization: auth.dependencies,
      createWorkspace: jest.fn(() => ({ path: '/staging/project', cleanup: workspaceCleanup })),
      spawnCommand: jest.fn(async () => venv.job),
      preparePromotion: jest.fn(async () => promotion),
    };

    const operation = runAuthorizedProjectDependencyInstall(request.input, dependencies);
    await waitUntil(() => (dependencies.spawnCommand as jest.Mock).mock.calls.length === 1);

    publishSessionRevoked({ userId: USER_ID, sessionId: 'session-a', reason: 'logout' });
    venv.cleanup.resolve();

    await expect(operation).resolves.toEqual({
      status: 'cancelled',
      reason: 'authority_revoked',
      revocationReason: 'session_revoked',
    });
    expect(venv.cancel).toHaveBeenCalledTimes(1);
    expect(dependencies.spawnCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'python3',
      args: ['-m', 'venv', '.venv'],
    }));
    expect(dependencies.preparePromotion).not.toHaveBeenCalled();
    expect(promotion.commit).not.toHaveBeenCalled();
    expect(request.input.writeDependencyCache).not.toHaveBeenCalled();
    expect(workspaceCleanup).toHaveBeenCalledTimes(1);
    expect(request.input.onAuthorityLost).toHaveBeenCalledWith('session_revoked');
    expect(auth.unsubscribeAuthorization).toHaveBeenCalledTimes(1);
    expect(auth.unsubscribeGlobalFence).toHaveBeenCalledTimes(1);
    expect(auth.unsubscribeSession).toHaveBeenCalledTimes(1);
    expect(request.unsubscribeClientClose).toHaveBeenCalledTimes(1);
  });

  test('revocation during asynchronous staging prevents the locked promotion and cache commit', async () => {
    const auth = authorizationDependencies();
    const request = harness('node');
    const install = controlledJob();
    const promotion = preparedPromotion();
    const promotionReady = deferred<ReturnType<typeof preparedPromotion>>();
    const dependencies: ProjectDependencyInstallDependencies = {
      authorization: auth.dependencies,
      createWorkspace: jest.fn(() => ({ path: '/staging/project', cleanup: jest.fn() })),
      spawnCommand: jest.fn(async () => install.job),
      preparePromotion: jest.fn(() => promotionReady.promise),
      ...successfulDecisionMocks(),
    };

    const operation = runAuthorizedProjectDependencyInstall(request.input, dependencies);
    await waitUntil(() => (dependencies.spawnCommand as jest.Mock).mock.calls.length === 1);
    install.child.finish(0);
    install.cleanup.resolve();
    await waitUntil(() => (dependencies.preparePromotion as jest.Mock).mock.calls.length === 1);

    publishSessionRevoked({ userId: USER_ID, sessionId: 'session-a', reason: 'logout' });
    promotionReady.resolve(promotion);

    await expect(operation).resolves.toMatchObject({
      status: 'cancelled',
      reason: 'authority_revoked',
    });
    expect(dependencies.authorizePromotion).not.toHaveBeenCalled();
    expect(promotion.commit).not.toHaveBeenCalled();
    expect(promotion.cleanup).toHaveBeenCalledTimes(1);
  });

  test('a sibling Session revocation does not cancel or suppress a successful promotion', async () => {
    const auth = authorizationDependencies();
    const request = harness('node');
    const install = controlledJob();
    const promotion = preparedPromotion();
    const workspaceCleanup = jest.fn();
    const dependencies: ProjectDependencyInstallDependencies = {
      authorization: auth.dependencies,
      createWorkspace: jest.fn(() => ({ path: '/staging/project', cleanup: workspaceCleanup })),
      spawnCommand: jest.fn(async () => install.job),
      preparePromotion: jest.fn(async () => promotion),
      ...successfulDecisionMocks(),
    };

    const operation = runAuthorizedProjectDependencyInstall(request.input, dependencies);
    await waitUntil(() => (dependencies.spawnCommand as jest.Mock).mock.calls.length === 1);
    publishSessionRevoked({ userId: USER_ID, sessionId: 'session-b', reason: 'logout' });
    expect(install.cancel).not.toHaveBeenCalled();

    install.child.stdout.write('added 3 packages');
    install.child.finish(0);
    install.cleanup.resolve();

    await expect(operation).resolves.toEqual({ status: 'completed' });
    expect(request.input.writeDependencyCache).toHaveBeenCalledWith('/staging/project');
    expect(dependencies.preparePromotion).toHaveBeenCalledWith(
      '/staging/project',
      '/live/project',
      ['node_modules', 'package-lock.json', '.deps-installed'],
      request.input.projectProof,
    );
    expect(promotion.commit).toHaveBeenCalledTimes(1);
    expect(promotion.finalize).toHaveBeenCalledTimes(1);
    expect(promotion.cleanup).toHaveBeenCalledTimes(1);
    expect(workspaceCleanup).toHaveBeenCalledTimes(1);
    expect(auth.unsubscribeAuthorization).toHaveBeenCalledTimes(1);
    expect(auth.unsubscribeGlobalFence).toHaveBeenCalledTimes(1);
    expect(auth.unsubscribeSession).toHaveBeenCalledTimes(1);
    expect(auth.unsubscribeGlobalFence.mock.invocationCallOrder[0]).toBeLessThan(
      (request.input.closeGlobalAdmissionAndSettleRequest as jest.Mock).mock.invocationCallOrder[0],
    );
    expect(
      (request.input.closeGlobalAdmissionAndSettleRequest as jest.Mock).mock.invocationCallOrder[0],
    ).toBeLessThan(
      (request.input.releaseLifecycleLock as jest.Mock).mock.invocationCallOrder[0],
    );
    expect((request.input.releaseLifecycleLock as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (dependencies.reacquireLock as jest.Mock).mock.invocationCallOrder[0],
    );
    expect((dependencies.reacquireLock as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (dependencies.authorizePromotion as jest.Mock).mock.invocationCallOrder[0],
    );
    expect((dependencies.deletePromotionDecision as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (dependencies.attestFenceReleaseState as jest.Mock).mock.invocationCallOrder[0],
    );
    expect(dependencies.attestFenceReleaseState).toHaveBeenCalledWith(expect.objectContaining({
      expectedState: 'ACTIVE',
    }));
  });

  test('client close cancels the exact current job and retains no authority or workspace', async () => {
    const auth = authorizationDependencies();
    const request = harness('python');
    const venv = controlledJob();
    const workspaceCleanup = jest.fn();
    const dependencies: ProjectDependencyInstallDependencies = {
      authorization: auth.dependencies,
      createWorkspace: jest.fn(() => ({ path: '/staging/project', cleanup: workspaceCleanup })),
      spawnCommand: jest.fn(async () => venv.job),
      preparePromotion: jest.fn(async () => preparedPromotion()),
    };

    const operation = runAuthorizedProjectDependencyInstall(request.input, dependencies);
    await waitUntil(() => (dependencies.spawnCommand as jest.Mock).mock.calls.length === 1);
    request.closeClient();
    venv.cleanup.resolve();

    await expect(operation).resolves.toEqual({
      status: 'cancelled',
      reason: 'client_closed',
    });
    expect(venv.cancel).toHaveBeenCalledTimes(1);
    expect(workspaceCleanup).toHaveBeenCalledTimes(1);
    expect(auth.unsubscribeAuthorization).toHaveBeenCalledTimes(1);
    expect(auth.unsubscribeGlobalFence).toHaveBeenCalledTimes(1);
    expect(auth.unsubscribeSession).toHaveBeenCalledTimes(1);
  });

  test('the locked durable recheck can refuse promotion after the process succeeds', async () => {
    const auth = authorizationDependencies();
    const request = harness('node');
    const install = controlledJob();
    const promotion = preparedPromotion();
    const dependencies: ProjectDependencyInstallDependencies = {
      ...promotionBoundaryDependencies(),
      authorization: auth.dependencies,
      createWorkspace: jest.fn(() => ({ path: '/staging/project', cleanup: jest.fn() })),
      spawnCommand: jest.fn(async () => install.job),
      preparePromotion: jest.fn(async () => promotion),
      authorizePromotion: refusedDecisionMock(),
    };

    const operation = runAuthorizedProjectDependencyInstall(request.input, dependencies);
    await waitUntil(() => (dependencies.spawnCommand as jest.Mock).mock.calls.length === 1);
    install.child.finish(0);
    install.cleanup.resolve();

    await expect(operation).resolves.toEqual({
      status: 'cancelled',
      reason: 'authority_revoked',
      revocationReason: 'authorization_changed',
    });
    expect(promotion.commit).not.toHaveBeenCalled();
    expect(promotion.cleanup).toHaveBeenCalledTimes(1);
    expect(request.input.onAuthorityLost).toHaveBeenCalledWith('authorization_changed');
  });

  test('an APPLIED transition failure after authorization preserves forward evidence and never rolls back', async () => {
    const auth = authorizationDependencies();
    const request = harness('node');
    const install = controlledJob();
    const promotion = preparedPromotion();
    const transitionFailure = new Error('database transition unavailable');
    const dependencies: ProjectDependencyInstallDependencies = {
      ...promotionBoundaryDependencies(),
      authorization: auth.dependencies,
      createWorkspace: jest.fn(() => ({ path: '/staging/project', cleanup: jest.fn() })),
      spawnCommand: jest.fn(async () => install.job),
      preparePromotion: jest.fn(async () => promotion),
      authorizePromotion: successfulDecisionMocks().authorizePromotion,
      markPromotionApplied: jest.fn(async () => { throw transitionFailure; }),
      deletePromotionDecision: jest.fn(async () => true),
    };

    const operation = runAuthorizedProjectDependencyInstall(request.input, dependencies);
    await waitUntil(() => (dependencies.spawnCommand as jest.Mock).mock.calls.length === 1);
    install.child.finish(0);
    install.cleanup.resolve();

    await expect(operation).rejects.toMatchObject({
      code: 'PROJECT_DEPENDENCY_PROMOTION_CONTAINED',
      fenceRetained: false,
    });
    expect(promotion.commit).toHaveBeenCalledTimes(1);
    expect(promotion.finalize).toHaveBeenCalledTimes(1);
    expect(promotion.rollback).not.toHaveBeenCalled();
    expect(promotion.cleanup).not.toHaveBeenCalled();
    expect(dependencies.quarantinePromotion).toHaveBeenCalledTimes(1);
    expect(dependencies.attestFenceReleaseState).toHaveBeenCalledWith(expect.objectContaining({
      expectedState: 'DEPENDENCY_QUARANTINED',
    }));
  });

  test('a post-drain Project identity replacement refuses authorization and cleans private staging only', async () => {
    const auth = authorizationDependencies();
    const request = harness('node');
    const install = controlledJob();
    const promotion = preparedPromotion();
    (promotion.reattest as jest.Mock)
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => { throw new Error('Project root identity changed'); });
    const dependencies: ProjectDependencyInstallDependencies = {
      ...successfulDecisionMocks(),
      authorization: auth.dependencies,
      createWorkspace: jest.fn(() => ({ path: '/staging/project', cleanup: jest.fn() })),
      spawnCommand: jest.fn(async () => install.job),
      preparePromotion: jest.fn(async () => promotion),
    };

    const operation = runAuthorizedProjectDependencyInstall(request.input, dependencies);
    await waitUntil(() => (dependencies.spawnCommand as jest.Mock).mock.calls.length === 1);
    install.child.finish(0);
    install.cleanup.resolve();

    await expect(operation).rejects.toThrow('Project root identity changed');
    expect(dependencies.authorizePromotion).not.toHaveBeenCalled();
    expect(promotion.commit).not.toHaveBeenCalled();
    expect(promotion.cleanup).not.toHaveBeenCalled();
    expect(promotion.cleanupPreparedStagingOnly).toHaveBeenCalledTimes(1);
    expect(dependencies.attestFenceReleaseState).toHaveBeenCalledWith(expect.objectContaining({
      expectedState: 'PREDECISION_CLEAN',
    }));
  });

  test('client close during writer quiescence cancels before the durable decision and reopens only after cleanup', async () => {
    const auth = authorizationDependencies();
    const request = harness('node');
    const install = controlledJob();
    const promotion = preparedPromotion();
    const boundary = promotionBoundaryDependencies();
    const closeWriterFence = boundary.closeWriterFence as jest.Mock;
    closeWriterFence.mockImplementation((input) => {
      input.closeAdmissionAndSettleInstaller();
      input.releaseProjectLease();
      const proof = { preDrain: {}, postDrain: {} };
      let held = true;
      return {
        proveQuiescent: jest.fn(async () => {
          request.closeClient();
          return proof;
        }),
        assertHeld: jest.fn(),
        releaseAfterSafeState: jest.fn(async (attest) => {
          await attest();
          held = false;
        }),
        isHeld: () => held,
      };
    });
    const dependencies: ProjectDependencyInstallDependencies = {
      ...boundary,
      ...successfulDecisionMocks(),
      closeWriterFence,
      authorization: auth.dependencies,
      createWorkspace: jest.fn(() => ({ path: '/staging/project', cleanup: jest.fn() })),
      spawnCommand: jest.fn(async () => install.job),
      preparePromotion: jest.fn(async () => promotion),
    };

    const operation = runAuthorizedProjectDependencyInstall(request.input, dependencies);
    await waitUntil(() => (dependencies.spawnCommand as jest.Mock).mock.calls.length === 1);
    install.child.finish(0);
    install.cleanup.resolve();

    await expect(operation).resolves.toEqual({ status: 'cancelled', reason: 'client_closed' });
    expect(dependencies.authorizePromotion).not.toHaveBeenCalled();
    expect(promotion.commit).not.toHaveBeenCalled();
    expect(promotion.cleanup).toHaveBeenCalledTimes(1);
    expect(dependencies.attestFenceReleaseState).toHaveBeenCalledWith(expect.objectContaining({
      expectedState: 'PREDECISION_CLEAN',
    }));
  });

  test('an indeterminate authorization decision preserves evidence and retains global admission', async () => {
    const auth = authorizationDependencies();
    const request = harness('node');
    const install = controlledJob();
    const promotion = preparedPromotion();
    const boundary = promotionBoundaryDependencies();
    const dependencies: ProjectDependencyInstallDependencies = {
      ...boundary,
      authorization: auth.dependencies,
      createWorkspace: jest.fn(() => ({ path: '/staging/project', cleanup: jest.fn() })),
      spawnCommand: jest.fn(async () => install.job),
      preparePromotion: jest.fn(async () => promotion),
      authorizePromotion: jest.fn(async () => {
        throw new ProjectDependencyPromotionDecisionIndeterminateError('database unavailable');
      }) as any,
    };

    const operation = runAuthorizedProjectDependencyInstall(request.input, dependencies);
    await waitUntil(() => (dependencies.spawnCommand as jest.Mock).mock.calls.length === 1);
    install.child.finish(0);
    install.cleanup.resolve();

    await expect(operation).rejects.toMatchObject({
      code: 'PROJECT_DEPENDENCY_PROMOTION_WRITER_FENCE_UNPROVEN',
      fenceRetained: true,
    });
    expect(promotion.commit).not.toHaveBeenCalled();
    expect(promotion.cleanup).not.toHaveBeenCalled();
    expect(promotion.cleanupPreparedStagingOnly).not.toHaveBeenCalled();
    const fence = (boundary.closeWriterFence as jest.Mock).mock.results[0].value;
    expect(fence.releaseAfterSafeState).not.toHaveBeenCalled();
    expect(fence.isHeld()).toBe(true);
  });

  test('an unproven durable writer residual cleans private staging but retains global admission', async () => {
    const auth = authorizationDependencies();
    const request = harness('node');
    const install = controlledJob();
    const promotion = preparedPromotion();
    const boundary = promotionBoundaryDependencies();
    const closeWriterFence = boundary.closeWriterFence as jest.Mock;
    closeWriterFence.mockImplementation((input) => {
      input.closeAdmissionAndSettleInstaller();
      input.releaseProjectLease();
      let held = true;
      return {
        proveQuiescent: jest.fn(async () => {
          throw new ProjectDependencyPromotionWriterFenceError(
            'An orphan durable Project Chat turn remains active.',
          );
        }),
        assertHeld: jest.fn(),
        releaseAfterSafeState: jest.fn(async (attest) => {
          await attest();
          held = false;
        }),
        isHeld: () => held,
      };
    });
    const dependencies: ProjectDependencyInstallDependencies = {
      ...boundary,
      closeWriterFence,
      authorization: auth.dependencies,
      createWorkspace: jest.fn(() => ({ path: '/staging/project', cleanup: jest.fn() })),
      spawnCommand: jest.fn(async () => install.job),
      preparePromotion: jest.fn(async () => promotion),
    };

    const operation = runAuthorizedProjectDependencyInstall(request.input, dependencies);
    await waitUntil(() => (dependencies.spawnCommand as jest.Mock).mock.calls.length === 1);
    install.child.finish(0);
    install.cleanup.resolve();

    await expect(operation).rejects.toMatchObject({
      code: 'PROJECT_DEPENDENCY_PROMOTION_WRITER_FENCE_UNPROVEN',
      fenceRetained: true,
    });
    expect(promotion.commit).not.toHaveBeenCalled();
    expect(promotion.cleanup).toHaveBeenCalledTimes(1);
    const fence = closeWriterFence.mock.results[0].value;
    expect(fence.releaseAfterSafeState).not.toHaveBeenCalled();
    expect(fence.isHeld()).toBe(true);
  });

  test('authorization is established before any disposable workspace is created', async () => {
    const request = harness('node');
    const createWorkspace = jest.fn();
    const dependencies: ProjectDependencyInstallDependencies = {
      establishAuthorization: rejectedAuthorizationMock(),
      createWorkspace,
    };

    await expect(runAuthorizedProjectDependencyInstall(request.input, dependencies)).resolves.toEqual({
      status: 'authorization_denied',
      reason: 'session_revoked',
    });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(request.input.onAuthorized).not.toHaveBeenCalled();
    expect(request.unsubscribeClientClose).toHaveBeenCalledTimes(1);
  });

  test('delete and recreate cannot hand an old Project generation to a queued install', async () => {
    const ownerId = 'workspace-owner-race';
    const projectName = 'SameName';
    const releaseDelete = await acquireProjectDeletionLock(
      projectDeletionLockKey(ownerId, projectName),
    );
    let currentGeneration = '/projects/retired-generation';
    const resolveProjectDir = jest.fn(() => currentGeneration);
    const resolveIdentity = jest.fn(async (projectDir: string) => ({
      id: projectDir.endsWith('replacement-generation') ? 'identity-b' : 'identity-a',
    }));

    const queuedInstall = acquireLockedProjectDependencyInstallTarget({
      ownerId,
      projectName,
      resolveProjectDir,
      recoverProject: jest.fn(async () => {}),
      resolveIdentity,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolveProjectDir).not.toHaveBeenCalled();
    expect(resolveIdentity).not.toHaveBeenCalled();

    // The destructive holder removes A and publishes B before releasing the
    // shared name lock. Only then may the install resolve path + identity.
    currentGeneration = '/projects/replacement-generation';
    releaseDelete();
    const target = await queuedInstall;

    expect(target.projectDir).toBe('/projects/replacement-generation');
    expect(target.identity).toEqual({ id: 'identity-b' });
    expect(resolveIdentity).toHaveBeenCalledWith('/projects/replacement-generation');
    target.release();
  });
});
