jest.mock('./agentJobs', () => ({
  quiesceAgentJobsForProjectDependencyPromotion: jest.fn(),
}));
jest.mock('./hostAgentRunJournal', () => ({
  quiesceHostAgentRunsForProjectDependencyPromotion: jest.fn(),
}));
jest.mock('./openClawHostRunJournal', () => ({
  quiesceOpenClawHostRunsForProjectDependencyPromotion: jest.fn(),
}));
jest.mock('./projectChatDependencyPromotionQuiescence', () => ({
  attestProjectChatsQuiescentForProjectDependencyPromotion: jest.fn(),
}));
jest.mock('./projectNativeRunBroker', () => ({
  quiesceProjectNativeRunsForProjectDependencyPromotion: jest.fn(),
}));
jest.mock('./terminalSystemdScopeBoundary', () => ({
  quiesceTerminalSystemdScopesForProjectDependencyPromotion: jest.fn(),
}));

import {
  closeProjectDependencyPromotionWriterFence,
  ProjectDependencyPromotionWriterFenceError,
  type ProjectDependencyPromotionWriterFenceDependencies,
} from './projectDependencyPromotionWriterFence';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function quiescenceDependencies(
  events: string[],
  overrides: Partial<ProjectDependencyPromotionWriterFenceDependencies> = {},
): ProjectDependencyPromotionWriterFenceDependencies {
  let pass = 0;
  const step = (name: string, value: object) => jest.fn(async () => {
    events.push(`${pass}:${name}`);
    if (name === 'durable-project-chat') pass += 1;
    return value as never;
  });
  return {
    quiesceTerminalScopes: step('terminal', {
      preparationCount: 0,
      sessionCount: 0,
      recoveredCount: 0,
    }),
    quiesceAgentJobs: step('agent-jobs', {
      jobCount: 0,
      liveRuntimeCount: 0,
      persistedRuntimeSignalCount: 0,
    }),
    quiesceHostAgentRuns: step('host-runs', {
      runCount: 0,
      inMemoryAbortCount: 0,
      persistedRuntimeSignalCount: 0,
      recoveredCount: 0,
    }),
    quiesceOpenClawHostRuns: step('openclaw', {
      schemaVersion: 1,
      actorUserIds: [],
      rowCount: 0,
      sessionCount: 0,
      sessions: [],
    }),
    quiesceProjectNativeRuns: step('project-native', { runCount: 0 }),
    attestDurableProjectChat: step('durable-project-chat', {
      activeTurnCount: 0,
      activeStateCount: 0,
    }),
    ...overrides,
  };
}

describe('Project dependency promotion writer fence', () => {
  test('closes and self-excludes synchronously, then performs pre/drain/post inventory', async () => {
    const events: string[] = [];
    const drain = deferred();
    const admission = {
      waitForMutationDrain: jest.fn(() => {
        events.push('drain');
        return drain.promise;
      }),
      release: jest.fn(() => { events.push('reopen'); }),
    };
    const fence = closeProjectDependencyPromotionWriterFence({
      closeAdmissionAndSettleInstaller: () => {
        events.push('close-and-exclude-self');
        return admission;
      },
      releaseProjectLease: () => { events.push('release-project-lock'); },
    }, quiescenceDependencies(events));

    const proving = fence.proveQuiescent();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual([
      'close-and-exclude-self',
      'release-project-lock',
      '0:terminal',
      '0:agent-jobs',
      '0:host-runs',
      '0:openclaw',
      '0:project-native',
      '0:durable-project-chat',
      'drain',
    ]);
    drain.resolve();
    const proof = await proving;
    expect(events.slice(-6)).toEqual([
      '1:terminal',
      '1:agent-jobs',
      '1:host-runs',
      '1:openclaw',
      '1:project-native',
      '1:durable-project-chat',
    ]);
    expect(() => fence.assertHeld(proof)).not.toThrow();

    const attestation = jest.fn(async () => { events.push('safe-state'); });
    await fence.releaseAfterSafeState(attestation);
    expect(events.slice(-2)).toEqual(['safe-state', 'reopen']);
    expect(fence.isHeld()).toBe(false);
  });

  test('the second inventory catches a writer journaled just before drain settlement', async () => {
    const events: string[] = [];
    let inventory = 0;
    const dependencies = quiescenceDependencies(events, {
      quiesceHostAgentRuns: jest.fn(async () => ({
        runCount: inventory++,
        inMemoryAbortCount: 0,
        persistedRuntimeSignalCount: 0,
        recoveredCount: 0,
      })),
    });
    const fence = closeProjectDependencyPromotionWriterFence({
      closeAdmissionAndSettleInstaller: () => ({
        waitForMutationDrain: async () => {},
        release: jest.fn(),
      }),
      releaseProjectLease: jest.fn(),
    }, dependencies);

    const proof = await fence.proveQuiescent();
    expect(proof.preDrain.hostAgentRuns.runCount).toBe(0);
    expect(proof.postDrain.hostAgentRuns.runCount).toBe(1);
  });

  test('the post-drain durable scan retains the fence for a late orphan Project Chat turn', async () => {
    const release = jest.fn();
    let durableScans = 0;
    const dependencies = quiescenceDependencies([], {
      attestDurableProjectChat: jest.fn(async () => {
        durableScans += 1;
        if (durableScans === 2) throw new Error('orphan durable Project Chat turn');
        return { activeTurnCount: 0, activeStateCount: 0 };
      }),
    });
    const fence = closeProjectDependencyPromotionWriterFence({
      closeAdmissionAndSettleInstaller: () => ({
        waitForMutationDrain: async () => {},
        release,
      }),
      releaseProjectLease: jest.fn(),
    }, dependencies);

    await expect(fence.proveQuiescent()).rejects.toMatchObject({
      code: 'PROJECT_DEPENDENCY_PROMOTION_WRITER_FENCE_UNPROVEN',
      fenceRetained: true,
    });
    expect(dependencies.attestDurableProjectChat).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
    expect(fence.isHeld()).toBe(true);
  });

  test.each([
    'quiesceTerminalScopes',
    'quiesceAgentJobs',
    'quiesceHostAgentRuns',
    'quiesceOpenClawHostRuns',
    'quiesceProjectNativeRuns',
    'attestDurableProjectChat',
  ] as const)('retains admission if %s cannot prove its residual set empty', async (name) => {
    const events: string[] = [];
    const release = jest.fn();
    const dependencies = quiescenceDependencies(events, {
      [name]: jest.fn(async () => { throw new Error('residual writer'); }),
    });
    const fence = closeProjectDependencyPromotionWriterFence({
      closeAdmissionAndSettleInstaller: () => ({
        waitForMutationDrain: async () => {},
        release,
      }),
      releaseProjectLease: jest.fn(),
    }, dependencies);

    await expect(fence.proveQuiescent()).rejects.toMatchObject({
      code: 'PROJECT_DEPENDENCY_PROMOTION_WRITER_FENCE_UNPROVEN',
      fenceRetained: true,
    });
    expect(release).not.toHaveBeenCalled();
    expect(fence.isHeld()).toBe(true);
  });

  test('never reopens when ACTIVE/quarantine attestation is indeterminate', async () => {
    const release = jest.fn();
    const fence = closeProjectDependencyPromotionWriterFence({
      closeAdmissionAndSettleInstaller: () => ({
        waitForMutationDrain: async () => {},
        release,
      }),
      releaseProjectLease: jest.fn(),
    }, quiescenceDependencies([]));
    await fence.proveQuiescent();

    await expect(fence.releaseAfterSafeState(async () => {
      throw new Error('database unavailable');
    })).rejects.toBeInstanceOf(ProjectDependencyPromotionWriterFenceError);
    expect(release).not.toHaveBeenCalled();
    expect(fence.isHeld()).toBe(true);
  });
});
