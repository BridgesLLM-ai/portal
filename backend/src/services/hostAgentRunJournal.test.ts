import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';

type Row = Record<string, any>;

const BOOT_ID = '01234567-89ab-4cde-8fab-0123456789ab';
const INVOCATION_ID = 'fedcba9876543210fedcba9876543210';
const mockRows = new Map<string, Row>();
const mockGates = new Map<string, {
  socketPath: string;
  ready: Promise<void>;
  prepareTargetEnvironment: jest.Mock<void, [NodeJS.ProcessEnv]>;
  release: jest.Mock<Promise<void>, []>;
  abort: jest.Mock<Promise<void>, []>;
}>();
const mockActor = {
  id: 'owner-1',
  authorizationVersion: 7,
  accountStatus: 'ACTIVE',
  isActive: true,
};
let mockTransitionActive = false;
let mockReservationSequence = 0;
let mockNextGateReady: Promise<void> | null = null;

function unitForSequence(sequence: number): string {
  return `bridgesllm-host-agent-${sequence.toString(16).padStart(32, '0')}.scope`;
}

function tagForSequence(sequence: number): string {
  return sequence.toString(16).padStart(64, '0');
}

function gatePathForUnit(unit: string): string {
  const uuid = unit.slice('bridgesllm-host-agent-'.length, -'.scope'.length);
  return `/run/bridgesllm/host-agent-runs/gate-${uuid}.sock`;
}

function reservation(sequence = Math.max(1, mockReservationSequence)): Record<string, string> {
  const scopeUnit = unitForSequence(sequence);
  const scopeTag = tagForSequence(sequence);
  return {
    scopeUnit,
    scopeTag,
    description: `BridgesLLM host agent run tag=${scopeTag}`,
    bootId: BOOT_ID,
    controlGroup: `/system.slice/${scopeUnit}`,
  };
}

function fakeChild(pid = 4321): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
  }) as unknown as ChildProcess;
}

const mockBoundary: any = {
  reserve: jest.fn(async () => {
    mockReservationSequence += 1;
    return reservation(mockReservationSequence);
  }),
  sameBoot: jest.fn(async () => true),
  inspect: jest.fn(async (scopeUnit: string) => ({
    installed: false,
    loadState: 'not-found',
    activeState: 'inactive',
    subState: 'dead',
    description: scopeUnit,
    invocationId: null,
    controlGroup: null,
    killMode: 'control-group',
  })),
  launch: jest.fn(async ({ reservation: persisted }: { reservation: Record<string, string> }) => ({
    child: fakeChild(),
    identity: { ...persisted, invocationId: INVOCATION_ID },
  })),
  stop: jest.fn(async (identity: Record<string, string>) => ({
    scopeUnit: identity.scopeUnit,
    invocationId: identity.invocationId,
    bootId: identity.bootId,
    stopRequested: true,
    cgroupEmpty: true,
    finalLoadState: 'not-found',
    finalActiveState: 'inactive',
    finalSubState: 'dead',
  })),
};

const mockCreateGate = jest.fn(async (scopeUnit: string) => {
  const socketPath = gatePathForUnit(scopeUnit);
  const gate = {
    socketPath,
    ready: mockNextGateReady || Promise.resolve(),
    prepareTargetEnvironment: jest.fn(),
    release: jest.fn(async () => undefined),
    abort: jest.fn(async () => undefined),
  };
  mockNextGateReady = null;
  mockGates.set(socketPath, gate);
  return gate;
});
const mockRemoveGate = jest.fn();

jest.mock('./systemdHostRunBoundary', () => {
  class SystemdHostRunBoundaryError extends Error {
    constructor(
      message: string,
      public readonly code: string,
      public readonly quarantine = true,
    ) {
      super(message);
    }
  }
  return {
    SystemdHostRunBoundaryError,
    systemdHostRunBoundary: mockBoundary,
  };
});

jest.mock('./hostAgentRunActivationGate', () => ({
  HOST_AGENT_RUN_RUNTIME_ROOT: '/run/bridgesllm/host-agent-runs',
  initializeHostAgentRunGateStorage: jest.fn(() => '/run/bridgesllm/host-agent-runs'),
  hostAgentRunGatePath: jest.fn((scopeUnit: string) => gatePathForUnit(scopeUnit)),
  createHostAgentRunActivationGate: mockCreateGate,
  removePersistedHostAgentRunGate: mockRemoveGate,
}));

function matches(row: Row, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Array.isArray(expected.in)) return expected.in.includes(actual);
      if (expected.not !== undefined) return actual !== expected.not;
    }
    return actual === expected;
  });
}

const mockHostAgentRun = {
  create: jest.fn(async ({ data }: { data: Row }) => {
    if (
      mockRows.has(data.id)
      || [...mockRows.values()].some((row) => (
        row.sessionId === data.sessionId
        && ['PREPARED', 'SPAWNED', 'DISPATCHED', 'QUARANTINED'].includes(row.status)
      ))
    ) {
      const error: any = new Error('unique');
      error.code = 'P2002';
      throw error;
    }
    const now = new Date();
    const row: Row = {
      scopeUnit: null,
      scopeTag: null,
      bootId: null,
      controlGroup: null,
      gatePath: null,
      scopeInvocationId: null,
      launcherPid: null,
      dispatchActivatedAt: null,
      settledAt: null,
      terminalReason: null,
      evidence: null,
      createdAt: now,
      updatedAt: now,
      ...data,
    };
    mockRows.set(row.id, row);
    return { ...row };
  }),
  findUnique: jest.fn(async ({ where }: { where: Row }) => {
    const row = mockRows.get(where.id);
    return row ? { ...row } : null;
  }),
  findMany: jest.fn(async ({ where }: { where?: Row } = {}) => (
    [...mockRows.values()].filter((row) => matches(row, where)).map((row) => ({ ...row }))
  )),
  findFirst: jest.fn(async ({ where }: { where?: Row } = {}) => {
    const row = [...mockRows.values()].find((candidate) => matches(candidate, where));
    return row ? { ...row } : null;
  }),
  updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
    let count = 0;
    for (const [id, row] of mockRows) {
      if (!matches(row, where)) continue;
      const next = { ...row };
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined) next[key] = value;
      }
      next.updatedAt = new Date();
      mockRows.set(id, next);
      count += 1;
    }
    return { count };
  }),
};

const mockPrisma = {
  hostAgentRun: mockHostAgentRun,
  user: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (
      where.id === mockActor.id ? { ...mockActor } : null
    )),
  },
  projectAuthorizationTransition: {
    findFirst: jest.fn(async () => (mockTransitionActive ? { id: 'transition-1' } : null)),
  },
  $transaction: jest.fn(async (operation: (transaction: any) => Promise<unknown>) => (
    operation(mockPrisma)
  )),
};

jest.mock('../config/database', () => ({ prisma: mockPrisma }));

const journal = require('./hostAgentRunJournal') as typeof import('./hostAgentRunJournal');

function handle(id: string): import('./hostAgentRunJournal').HostAgentRunHandle {
  return {
    id,
    actorUserId: mockActor.id,
    actorAuthorizationVersion: mockActor.authorizationVersion,
    provider: 'CODEX',
    sessionId: `native-session-${id}`,
  };
}

async function reserveAndSpawn(
  run: import('./hostAgentRunJournal').HostAgentRunHandle,
) {
  const reserved = await journal.reserveHostAgentRunAttempt(run);
  const launch = await journal.spawnGatedHostAgentRunAttempt({
    handle: run,
    reservation: reserved,
    command: '/usr/bin/test-cli',
    args: ['--json'],
    options: {
      cwd: '/var/portal-files/user-1',
      env: { PATH: '/usr/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  });
  return { reserved, launch };
}

beforeEach(() => {
  mockRows.clear();
  mockGates.clear();
  mockTransitionActive = false;
  mockActor.authorizationVersion = 7;
  mockReservationSequence = 0;
  mockNextGateReady = null;
  jest.clearAllMocks();
  mockBoundary.reserve.mockImplementation(async () => {
    mockReservationSequence += 1;
    return reservation(mockReservationSequence);
  });
  mockBoundary.sameBoot.mockResolvedValue(true);
  mockBoundary.inspect.mockImplementation(async (scopeUnit: string) => ({
    installed: false,
    loadState: 'not-found',
    activeState: 'inactive',
    subState: 'dead',
    description: scopeUnit,
    invocationId: null,
    controlGroup: null,
    killMode: 'control-group',
  }));
  mockBoundary.launch.mockImplementation(async ({ reservation: persisted }) => ({
    child: fakeChild(),
    identity: { ...persisted, invocationId: INVOCATION_ID },
  }));
  mockBoundary.stop.mockImplementation(async (identity) => ({
    scopeUnit: identity.scopeUnit,
    invocationId: identity.invocationId,
    bootId: identity.bootId,
    stopRequested: true,
    cgroupEmpty: true,
    finalLoadState: 'not-found',
    finalActiveState: 'inactive',
    finalSubState: 'dead',
  }));
  mockCreateGate.mockImplementation(async (scopeUnit: string) => {
    const socketPath = gatePathForUnit(scopeUnit);
    const gate = {
      socketPath,
      ready: mockNextGateReady || Promise.resolve(),
      prepareTargetEnvironment: jest.fn(),
      release: jest.fn(async () => undefined),
      abort: jest.fn(async () => undefined),
    };
    mockNextGateReady = null;
    mockGates.set(socketPath, gate);
    return gate;
  });
  journal.__hostAgentRunJournalTest.resetRuntimeState();
});

describe('host-native systemd scope journal', () => {
  test('rejects stale generation and unresolved transition admission', async () => {
    const stale = handle('stale');
    stale.actorAuthorizationVersion = 6;
    await expect(journal.beginHostAgentRun(stale)).rejects.toMatchObject({
      code: 'AUTHORIZATION_CHANGED',
    });

    mockTransitionActive = true;
    await expect(journal.beginHostAgentRun(handle('transition'))).rejects.toMatchObject({
      code: 'AUTHORIZATION_TRANSITION_ACTIVE',
    });
    expect(mockRows.size).toBe(0);
  });

  test('persists the complete reservation before systemd launch and releases only after DISPATCHED', async () => {
    const run = handle('two-phase-dispatch');
    await journal.beginHostAgentRun(run);
    const reserved = await journal.reserveHostAgentRunAttempt(run);
    expect(mockRows.get(run.id)).toMatchObject({
      status: 'PREPARED',
      attempt: 1,
      scopeUnit: reserved.scopeUnit,
      scopeTag: reserved.scopeTag,
      bootId: BOOT_ID,
      controlGroup: reserved.controlGroup,
      gatePath: reserved.gatePath,
      scopeInvocationId: null,
    });
    expect(mockBoundary.launch).not.toHaveBeenCalled();

    const launch = await journal.spawnGatedHostAgentRunAttempt({
      handle: run,
      reservation: reserved,
      command: '/usr/bin/test-cli',
      args: [],
      options: {
        cwd: '/tmp',
        env: { PATH: '/usr/bin', LD_PRELOAD: '/tmp/hostile.so' },
      },
    });
    expect(mockRows.get(run.id)).toMatchObject({
      status: 'SPAWNED',
      scopeInvocationId: INVOCATION_ID,
    });
    const gate = mockGates.get(reserved.gatePath)!;
    expect(gate.release).not.toHaveBeenCalled();
    gate.release.mockImplementationOnce(async () => {
      expect(mockRows.get(run.id)?.status).toBe('DISPATCHED');
    });

    await journal.activateGatedHostAgentRunAttempt(run, launch);
    expect(mockRows.get(run.id)).toMatchObject({
      status: 'DISPATCHED',
      dispatchActivatedAt: expect.any(Date),
    });
    expect(gate.release).toHaveBeenCalledTimes(1);
    expect(mockBoundary.launch.mock.calls[0][0]).toMatchObject({
      wrapperCommand: process.execPath,
      cwd: '/tmp',
    });
    expect(mockBoundary.launch.mock.calls[0][0]).not.toHaveProperty('env');
    expect(gate.prepareTargetEnvironment).toHaveBeenCalledWith({
      PATH: '/usr/bin',
      LD_PRELOAD: '/tmp/hostile.so',
    });
    expect(mockBoundary.launch.mock.calls[0][0].wrapperArgs.join(' ')).toContain(
      reserved.gatePath,
    );
  });

  test('fails closed when authorization changes between SPAWNED and dispatch', async () => {
    const run = handle('dispatch-authorization-race');
    await journal.beginHostAgentRun(run);
    const { reserved, launch } = await reserveAndSpawn(run);
    mockActor.authorizationVersion += 1;

    await expect(
      journal.activateGatedHostAgentRunAttempt(run, launch),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_CHANGED' });
    expect(mockGates.get(reserved.gatePath)?.release).not.toHaveBeenCalled();
    expect(mockBoundary.stop).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeUnit: reserved.scopeUnit,
        invocationId: INVOCATION_ID,
      }),
    );
    expect(mockRows.get(run.id)?.status).toBe('RECOVERED');
  });

  test('a DISPATCHED CAS failure stops the scope and never releases the wrapper', async () => {
    const run = handle('dispatch-cas-race');
    await journal.beginHostAgentRun(run);
    const { reserved, launch } = await reserveAndSpawn(run);
    mockHostAgentRun.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      journal.activateGatedHostAgentRunAttempt(run, launch),
    ).rejects.toMatchObject({ code: 'HOST_RUN_DISPATCH_COMMIT_FAILED' });
    expect(mockGates.get(reserved.gatePath)?.release).not.toHaveBeenCalled();
    expect(mockBoundary.stop).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: INVOCATION_ID }),
    );
    expect(mockRows.get(run.id)?.status).toBe('RECOVERED');
  });

  test('a crash-equivalent release failure retires the already-DISPATCHED scope', async () => {
    const run = handle('release-failure');
    await journal.beginHostAgentRun(run);
    const { reserved, launch } = await reserveAndSpawn(run);
    mockGates.get(reserved.gatePath)?.release.mockRejectedValueOnce(
      new Error('parent socket disappeared'),
    );

    await expect(
      journal.activateGatedHostAgentRunAttempt(run, launch),
    ).rejects.toThrow('parent socket disappeared');
    expect(mockBoundary.stop).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: INVOCATION_ID }),
    );
    expect(mockRows.get(run.id)?.status).toBe('RECOVERED');
  });

  test('a terminalized reservation cannot launch late after recovery wins the race', async () => {
    const run = handle('late-launch-after-recovery');
    await journal.beginHostAgentRun(run);
    const reserved = await journal.reserveHostAgentRunAttempt(run);
    Object.assign(mockRows.get(run.id)!, {
      status: 'RECOVERED',
      settledAt: new Date(),
    });

    await expect(journal.spawnGatedHostAgentRunAttempt({
      handle: run,
      reservation: reserved,
      command: '/usr/bin/test-cli',
      args: [],
      options: { cwd: '/tmp', env: {} },
    })).rejects.toMatchObject({ code: 'HOST_RUN_ATTEMPT_RACE' });
    expect(mockBoundary.launch).not.toHaveBeenCalled();
    expect(mockGates.get(reserved.gatePath)?.release).not.toHaveBeenCalled();
  });

  test('recovers the crash cut where a scope exists before InvocationID persistence', async () => {
    const run = handle('pre-spawned-crash');
    await journal.beginHostAgentRun(run);
    const reserved = await journal.reserveHostAgentRunAttempt(run);
    mockBoundary.inspect.mockResolvedValueOnce({
      installed: true,
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      description: reserved.description,
      invocationId: INVOCATION_ID,
      controlGroup: reserved.controlGroup,
      killMode: 'control-group',
    });

    journal.__hostAgentRunJournalTest.resetRuntimeState();
    await expect(journal.reconcilePersistedHostAgentRuns()).resolves.toMatchObject({
      recovered: 1,
      quarantined: 0,
      signaled: 1,
    });
    expect(mockBoundary.stop).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeUnit: reserved.scopeUnit,
        scopeTag: reserved.scopeTag,
        invocationId: INVOCATION_ID,
      }),
    );
    expect(mockRows.get(run.id)?.status).toBe('RECOVERED');
  });

  test('quarantines a same-boot unit/tag mismatch without signaling it', async () => {
    const run = handle('mismatched-unit');
    await journal.beginHostAgentRun(run);
    const reserved = await journal.reserveHostAgentRunAttempt(run);
    mockBoundary.inspect.mockResolvedValueOnce({
      installed: true,
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      description: `BridgesLLM host agent run tag=${'f'.repeat(64)}`,
      invocationId: INVOCATION_ID,
      controlGroup: reserved.controlGroup,
      killMode: 'control-group',
    });

    journal.__hostAgentRunJournalTest.resetRuntimeState();
    await expect(journal.reconcilePersistedHostAgentRuns()).rejects.toMatchObject({
      code: 'HOST_RUN_RECOVERY_UNPROVEN',
    });
    expect(mockBoundary.stop).not.toHaveBeenCalled();
    expect(mockRows.get(run.id)?.status).toBe('QUARANTINED');
  });

  test('a changed boot proves the old reservation impossible without inspect or signal', async () => {
    const run = handle('reboot-recovery');
    await journal.beginHostAgentRun(run);
    await journal.reserveHostAgentRunAttempt(run);
    mockBoundary.sameBoot.mockResolvedValue(false);

    journal.__hostAgentRunJournalTest.resetRuntimeState();
    await expect(journal.reconcilePersistedHostAgentRuns()).resolves.toMatchObject({
      recovered: 1,
      signaled: 0,
    });
    expect(mockBoundary.inspect).not.toHaveBeenCalled();
    expect(mockBoundary.stop).not.toHaveBeenCalled();
    expect(mockRows.get(run.id)).toMatchObject({
      status: 'RECOVERED',
      evidence: expect.objectContaining({ bootChanged: true }),
    });
  });

  test('recovers PREPARED attempt zero without any systemd identity lookup', async () => {
    const run = handle('unreserved-recovery');
    await journal.beginHostAgentRun(run);

    journal.__hostAgentRunJournalTest.resetRuntimeState();
    await expect(journal.reconcilePersistedHostAgentRuns()).resolves.toMatchObject({
      recovered: 1,
      signaled: 0,
    });
    expect(mockBoundary.sameBoot).not.toHaveBeenCalled();
    expect(mockBoundary.inspect).not.toHaveBeenCalled();
    expect(mockBoundary.stop).not.toHaveBeenCalled();
  });

  test('same-boot gate identity drift quarantines without signaling a unit', async () => {
    const run = handle('gate-identity-drift');
    await journal.beginHostAgentRun(run);
    await journal.reserveHostAgentRunAttempt(run);
    journal.__hostAgentRunJournalTest.resetRuntimeState();
    mockRemoveGate.mockImplementationOnce(() => {
      throw new Error('socket replaced by symlink');
    });

    await expect(journal.reconcilePersistedHostAgentRuns()).rejects.toMatchObject({
      code: 'HOST_RUN_RECOVERY_UNPROVEN',
    });
    expect(mockBoundary.stop).not.toHaveBeenCalled();
    expect(mockRows.get(run.id)?.status).toBe('QUARANTINED');
  });

  test('blocks and quarantines retry when prior exact scope settlement is unproven', async () => {
    const run = handle('retry-overlap');
    await journal.beginHostAgentRun(run);
    const { launch } = await reserveAndSpawn(run);
    await journal.activateGatedHostAgentRunAttempt(run, launch);
    mockBoundary.stop.mockRejectedValueOnce(new Error('populated=1'));

    await expect(journal.reserveHostAgentRunAttempt(run)).rejects.toMatchObject({
      code: 'HOST_RUN_RETRY_BOUNDARY_UNPROVEN',
    });
    expect(mockBoundary.reserve).toHaveBeenCalledTimes(1);
    expect(mockRows.get(run.id)?.status).toBe('QUARANTINED');
  });

  test('terminal settlement actively stops the scope after launcher close', async () => {
    const run = handle('daemon-after-launcher');
    await journal.beginHostAgentRun(run);
    const { launch } = await reserveAndSpawn(run);
    await journal.activateGatedHostAgentRunAttempt(run, launch);

    await journal.settleHostAgentRun(run, 'COMPLETED');
    expect(mockBoundary.stop).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: INVOCATION_ID }),
    );
    expect(mockRows.get(run.id)).toMatchObject({
      status: 'COMPLETED',
      settledAt: expect.any(Date),
      evidence: expect.objectContaining({ exactCleanupConfirmed: true }),
    });
  });

  test('terminal settlement quarantines a still-populated or unreadable scope', async () => {
    const run = handle('terminal-boundary-unproven');
    await journal.beginHostAgentRun(run);
    const { launch } = await reserveAndSpawn(run);
    await journal.activateGatedHostAgentRunAttempt(run, launch);
    mockBoundary.stop.mockRejectedValueOnce(new Error('populated 1'));

    await expect(journal.settleHostAgentRun(run, 'COMPLETED')).rejects.toMatchObject({
      code: 'HOST_RUN_SETTLEMENT_BOUNDARY_UNPROVEN',
    });
    expect(mockRows.get(run.id)).toMatchObject({
      status: 'QUARANTINED',
      settledAt: null,
    });
  });

  test('gate handshake failure stops the attested scope and never persists SPAWNED', async () => {
    const run = handle('gate-failure');
    await journal.beginHostAgentRun(run);
    const reserved = await journal.reserveHostAgentRunAttempt(run);
    mockNextGateReady = Promise.reject(new Error('gate rejected'));
    const gate = mockGates.get(reserved.gatePath)!;
    gate.ready = mockNextGateReady;

    await expect(journal.spawnGatedHostAgentRunAttempt({
      handle: run,
      reservation: reserved,
      command: '/usr/bin/test-cli',
      args: [],
      options: { cwd: '/tmp', env: {} },
    })).rejects.toThrow('gate rejected');
    expect(mockBoundary.stop).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: INVOCATION_ID }),
    );
    expect(mockRows.get(run.id)).toMatchObject({
      status: 'PREPARED',
      scopeInvocationId: null,
    });
  });

  test('never falls back to the Portal service environment', async () => {
    const run = handle('environment-required');
    await journal.beginHostAgentRun(run);
    const reserved = await journal.reserveHostAgentRunAttempt(run);

    await expect(journal.spawnGatedHostAgentRunAttempt({
      handle: run,
      reservation: reserved,
      command: '/usr/bin/test-cli',
      args: [],
      options: { cwd: '/tmp' },
    })).rejects.toMatchObject({ code: 'HOST_RUN_ENV_REQUIRED' });
    expect(mockBoundary.launch).not.toHaveBeenCalled();
    expect(
      mockGates.get(reserved.gatePath)?.prepareTargetEnvironment,
    ).not.toHaveBeenCalled();
  });

  test('authorization quiescence stops and recovers every persisted scope', async () => {
    const run = handle('authorization-quiescence');
    await journal.beginHostAgentRun(run);
    const { launch } = await reserveAndSpawn(run);
    await journal.activateGatedHostAgentRunAttempt(run, launch);

    await expect(
      journal.quiesceHostAgentRunsForAuthorizationTransition([mockActor.id]),
    ).resolves.toMatchObject({
      runCount: 1,
      persistedRuntimeSignalCount: 1,
      recoveredCount: 1,
    });
    expect(mockRows.get(run.id)?.status).toBe('RECOVERED');
  });

  test('production runtime identity is fixed and ignores environment overrides', () => {
    process.env.PORTAL_HOST_AGENT_RUN_ROOT = '/tmp/unsafe-test-override';
    expect(journal.__hostAgentRunJournalTest.runtimeRoot).toBe(
      '/run/bridgesllm/host-agent-runs',
    );
    delete process.env.PORTAL_HOST_AGENT_RUN_ROOT;
  });
});
