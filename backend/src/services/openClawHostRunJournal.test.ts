import {
  createOpenClawHostRunJournal,
  OpenClawHostRunJournalError,
  type OpenClawHostRunHandle,
} from './openClawHostRunJournal';
import { closeProjectDependencyPromotionWriterFence } from './projectDependencyPromotionWriterFence';

const HANDLE: OpenClawHostRunHandle = Object.freeze({
  id: 'portal-route-1',
  actorUserId: 'user-1',
  actorAuthorizationVersion: 7,
  provider: 'OPENCLAW',
  executionScope: 'HOST_OPERATOR',
  sessionKey: 'agent:main:portal-user-1',
});

type Row = Record<string, any>;

function matchesValue(actual: any, expected: any): boolean {
  if (
    expected
    && typeof expected === 'object'
    && !Array.isArray(expected)
    && !(expected instanceof Date)
  ) {
    if ('in' in expected) return expected.in.includes(actual);
    if ('not' in expected) return actual !== expected.not;
  }
  return actual === expected;
}

function matchesWhere(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'id' && expected && typeof expected === 'object' && 'in' in expected) {
      return expected.in.includes(row.id);
    }
    if (key === 'actorUserId' && expected && typeof expected === 'object' && 'in' in expected) {
      return expected.in.includes(row.actorUserId);
    }
    if (key === 'status' && expected && typeof expected === 'object') {
      return matchesValue(row.status, expected);
    }
    return matchesValue(row[key], expected);
  });
}

function createTestDatabase() {
  const rows: Row[] = [];
  const users: Row[] = [{
    id: 'user-1',
    authorizationVersion: 7,
    accountStatus: 'ACTIVE',
    isActive: true,
  }, {
    id: 'user-2',
    authorizationVersion: 3,
    accountStatus: 'ACTIVE',
    isActive: true,
  }];
  const transitions: Row[] = [];
  const agentSessions: Row[] = [{
    id: 'agent-session-1',
    userId: 'user-1',
    provider: 'OPENCLAW',
    externalId: HANDLE.sessionKey,
  }];
  let failResetProofCommit = false;
  let beforeNextTransaction: (() => void | Promise<void>) | null = null;
  let beforeNextResetProofUpdate: (() => void | Promise<void>) | null = null;

  const openClawHostRun = {
    create: jest.fn(async ({ data }: any) => {
      if (rows.some((row) => row.id === data.id)) {
        const error: any = new Error('unique');
        error.code = 'P2002';
        throw error;
      }
      const now = new Date('2026-07-29T22:00:00.000Z');
      const row = {
        upstreamRunId: null,
        visibleSettledAt: null,
        quiescedAt: null,
        terminalReason: null,
        evidence: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      rows.push(row);
      return row;
    }),
    findUnique: jest.fn(async ({ where }: any) => (
      rows.find((row) => row.id === where.id) || null
    )),
    findMany: jest.fn(async ({ where }: any = {}) => (
      rows
        .filter((row) => matchesWhere(row, where))
        .sort((left, right) => (
          String(left.sessionKey).localeCompare(String(right.sessionKey))
          || left.createdAt.getTime() - right.createdAt.getTime()
          || String(left.id).localeCompare(String(right.id))
        ))
    )),
    updateMany: jest.fn(async ({ where, data }: any) => {
      if (data.status === 'QUIESCED' && beforeNextResetProofUpdate) {
        const beforeUpdate = beforeNextResetProofUpdate;
        beforeNextResetProofUpdate = null;
        await beforeUpdate();
      }
      const selected = rows.filter((row) => matchesWhere(row, where));
      if (failResetProofCommit && data.status === 'QUIESCED') return { count: 0 };
      for (const row of selected) Object.assign(row, data, { updatedAt: new Date() });
      return { count: selected.length };
    }),
    count: jest.fn(async ({ where }: any) => (
      rows.filter((row) => matchesWhere(row, where)).length
    )),
  };

  const database: any = {
    openClawHostRun,
    user: {
      findMany: jest.fn(async ({ where }: any) => (
        users.filter((user) => where.id.in.includes(user.id))
      )),
    },
    projectAuthorizationTransition: {
      findFirst: jest.fn(async () => (
        transitions.find((entry) => entry.phase !== 'COMPLETE') || null
      )),
    },
    agentSession: {
      findFirst: jest.fn(async ({ where }: any) => (
        agentSessions.find((session) => matchesWhere(session, where)) || null
      )),
      findMany: jest.fn(async ({ where }: any) => (
        agentSessions
          .filter((session) => matchesWhere(session, where))
          .sort((left, right) => (
            String(left.externalId).localeCompare(String(right.externalId))
            || String(left.id).localeCompare(String(right.id))
          ))
      )),
    },
  };

  database.$transaction = jest.fn(async (callback: any) => {
    const beforeTransaction = beforeNextTransaction;
    beforeNextTransaction = null;
    if (beforeTransaction) await beforeTransaction();
    return callback({
      ...database,
      user: {
        ...database.user,
        findUnique: jest.fn(async ({ where }: any) => (
          users.find((user) => user.id === where.id) || null
        )),
      },
    });
  });

  return {
    database,
    rows,
    users,
    transitions,
    agentSessions,
    setFailResetProofCommit(value: boolean) {
      failResetProofCommit = value;
    },
    setBeforeNextTransaction(callback: () => void | Promise<void>) {
      beforeNextTransaction = callback;
    },
    setBeforeNextResetProofUpdate(callback: () => void | Promise<void>) {
      beforeNextResetProofUpdate = callback;
    },
  };
}

function dependencies(overrides: Record<string, any> = {}) {
  const test = createTestDatabase();
  let nowTick = 0;
  const getSessionInfo = jest.fn(async (sessionKey: string) => ({
    ok: true,
    data: {
      key: sessionKey,
      sessionId: nowTick === 0 ? 'session-before' : 'session-after',
    },
  }));
  const gatewayRpcCall = jest.fn(async (_method: string, params: Record<string, unknown>) => {
    nowTick = 1;
    return {
      ok: true,
      data: {
        ok: true,
        key: params.key,
        entry: { sessionId: 'session-after' },
      },
    };
  });
  const journal = createOpenClawHostRunJournal({
    database: test.database,
    portalInstanceId: 'portal-instance-test',
    now: () => new Date('2026-07-29T22:00:00.000Z'),
    getSessionInfo,
    gatewayRpcCall,
    ...overrides,
  });
  return { ...test, journal, getSessionInfo, gatewayRpcCall };
}

async function beginDispatchedVisible(test: ReturnType<typeof dependencies>) {
  await test.journal.begin(HANDLE);
  await test.journal.markDispatchAccepted(HANDLE, 'portal-upstream-1');
  await test.journal.markVisibleSettled(HANDLE, 'completed');
}

describe('OpenClaw host-run journal', () => {
  test('persists exact authorization and provider identity before dispatch', async () => {
    const test = dependencies();

    await expect(test.journal.begin(HANDLE)).resolves.toEqual(HANDLE);

    expect(test.rows).toHaveLength(1);
    expect(test.rows[0]).toMatchObject({
      ...HANDLE,
      portalInstanceId: 'portal-instance-test',
      status: 'PREPARED',
      upstreamRunId: null,
    });
  });

  test('admits an exact retry of the same unresolved provider request only', async () => {
    const test = dependencies();
    await test.journal.begin(HANDLE);

    await expect(test.journal.begin(HANDLE)).resolves.toEqual(HANDLE);
    await expect(test.journal.begin({
      ...HANDLE,
      actorUserId: 'user-2',
      actorAuthorizationVersion: 3,
    })).rejects.toMatchObject({ code: 'OPENCLAW_SESSION_OWNERSHIP_CONFLICT' });
    expect(test.rows).toHaveLength(1);
  });

  test('fails admission closed on authorization drift or an active transition', async () => {
    const drift = dependencies();
    drift.users[0].authorizationVersion = 8;
    await expect(drift.journal.begin(HANDLE)).rejects.toMatchObject({
      code: 'AUTHORIZATION_CHANGED',
    });
    expect(drift.rows).toHaveLength(0);

    const transitioning = dependencies();
    transitioning.transitions.push({ id: 'transition-1', phase: 'QUIESCING' });
    await expect(transitioning.journal.begin(HANDLE)).rejects.toMatchObject({
      code: 'AUTHORIZATION_TRANSITION_ACTIVE',
    });
    expect(transitioning.rows).toHaveLength(0);
  });

  test('fails admission closed when the provider session lacks exact durable ownership', async () => {
    const test = dependencies();
    test.agentSessions.length = 0;

    await expect(test.journal.begin(HANDLE)).rejects.toMatchObject({
      code: 'OPENCLAW_SESSION_OWNERSHIP_CONFLICT',
    });
    expect(test.rows).toHaveLength(0);
  });

  test('keeps visible completion unresolved until provider session reset', async () => {
    const test = dependencies();
    await beginDispatchedVisible(test);

    expect(test.rows[0]).toMatchObject({
      status: 'VISIBLE_DONE',
      upstreamRunId: 'portal-upstream-1',
      terminalReason: 'completed',
      evidence: expect.objectContaining({ providerQuiescent: false }),
    });
  });

  test('quarantines an ambiguous provider outcome without releasing authority', async () => {
    const test = dependencies();
    await test.journal.begin(HANDLE);

    await test.journal.quarantine(HANDLE, new Error('transport closed'));

    expect(test.rows[0]).toMatchObject({
      status: 'QUARANTINED',
      terminalReason: 'provider_outcome_ambiguous',
      evidence: expect.objectContaining({
        reason: 'transport closed',
        providerQuiescent: false,
      }),
    });
  });

  test('resets each affected session and commits exact rotated-session proof', async () => {
    const test = dependencies();
    await beginDispatchedVisible(test);

    const proof = await test.journal.quiesceForAuthorizationTransition(['user-1']);

    expect(test.gatewayRpcCall).toHaveBeenCalledWith(
      'sessions.reset',
      { key: HANDLE.sessionKey, reason: 'reset' },
      45_000,
    );
    expect(test.getSessionInfo).toHaveBeenCalledTimes(3);
    expect(test.rows[0]).toMatchObject({
      status: 'QUIESCED',
      terminalReason: 'authorization_transition_session_reset',
      evidence: expect.objectContaining({
        beforeSessionId: 'session-before',
        resetSessionId: 'session-after',
        readbackSessionId: 'session-after',
        reattestedSessionId: 'session-after',
      }),
    });
    expect(proof).toMatchObject({
      rowCount: 1,
      sessionCount: 1,
      actorUserIds: ['user-1'],
    });
  });

  test.each([
    ['valid stable-ID reset', {}, 2000, true],
    ['missing lifecycle revision', { lifecycleRevision: undefined }, 2000, false],
    ['unchanged boundary', { updatedAt: 1000, sessionStartedAt: 1000 }, 1000, false],
    ['ordinary metadata update', { sessionStartedAt: 1000 }, 2000, false],
    ['readback drift', {}, 2001, false],
  ])('9.1 reset: %s', async (_label, overrides, readbackTime, accepted) => {
    let resetDone = false;
    const entry = {
      sessionId: 'stable-conversation',
      lifecycleRevision: '7283cd2d-6e89-4e88-9fbf-edc0878d845f',
      updatedAt: 2000,
      sessionStartedAt: 2000,
      ...overrides as Record<string, unknown>,
    };
    const test = dependencies({
      getSessionInfo: jest.fn(async () => ({
        ok: true,
        data: {
          key: HANDLE.sessionKey,
          sessionId: entry.sessionId,
          updatedAt: resetDone ? readbackTime : 1000,
        },
      })),
      gatewayRpcCall: jest.fn(async () => {
        resetDone = true;
        return { ok: true, data: { ok: true, key: HANDLE.sessionKey, entry } };
      }),
    });
    await beginDispatchedVisible(test);
    const result = test.journal.quiesceForAuthorizationTransition(['user-1']);
    if (accepted) {
      await expect(result).resolves.toMatchObject({ rowCount: 1 });
      expect(test.rows[0]).toMatchObject({
        status: 'QUIESCED',
        evidence: { resetBoundary: { lifecycleRevision: entry.lifecycleRevision, updatedAt: 2000 } },
      });
    } else {
      await expect(result).rejects.toMatchObject({ code: 'OPENCLAW_SESSION_IDENTITY_DRIFT' });
      expect(test.rows[0].status).toBe('VISIBLE_DONE');
    }
  });

  test('global dependency-promotion quiescence discovers unresolved actors and retires late callbacks', async () => {
    const test = dependencies();
    await test.journal.begin(HANDLE);

    await expect(test.journal.quiesceForProjectDependencyPromotion()).resolves.toMatchObject({
      rowCount: 1,
      sessionCount: 1,
      actorUserIds: ['user-1'],
    });
    expect(test.rows[0]).toMatchObject({
      status: 'QUIESCED',
      terminalReason: 'project_dependency_promotion_session_reset',
    });

    await expect(test.journal.markDispatchAccepted(HANDLE, 'late-run')).resolves.toBeUndefined();
    await expect(test.journal.markVisibleSettled(HANDLE, 'completed')).resolves.toBeUndefined();
    await expect(test.journal.quarantine(HANDLE, new Error('late failure'))).resolves.toBeUndefined();
    expect(test.rows[0]).toMatchObject({
      status: 'QUIESCED',
      upstreamRunId: null,
      terminalReason: 'project_dependency_promotion_session_reset',
    });
  });

  test('allows an absent pre-dispatch session only when reset creates and reattests it', async () => {
    let calls = 0;
    const test = dependencies({
      getSessionInfo: jest.fn(async () => {
        calls += 1;
        if (calls === 1) return { ok: false, error: 'Session not found' };
        return {
          ok: true,
          data: { key: HANDLE.sessionKey, sessionId: 'session-after' },
        };
      }),
    });
    await test.journal.begin(HANDLE);

    const proof = await test.journal.quiesceForAuthorizationTransition(['user-1']);

    expect(proof.sessions[0].beforeSessionId).toBeNull();
    expect(test.rows[0].status).toBe('QUIESCED');
  });

  test('resets a pre-upgrade owned session even when it has no durable run rows', async () => {
    const test = dependencies();

    const proof = await test.journal.quiesceForAuthorizationTransition(['user-1']);

    expect(proof).toMatchObject({
      rowCount: 0,
      sessionCount: 1,
      sessions: [expect.objectContaining({
        sessionKey: HANDLE.sessionKey,
        rowCount: 0,
      })],
    });
    expect(test.gatewayRpcCall).toHaveBeenCalledTimes(1);
  });

  test('dependency-promotion startup fence skips historical zero-row sessions', async () => {
    let resetCommitted = false;
    const getSessionInfo = jest.fn(async (sessionKey: string) => ({
      ok: true,
      data: {
        key: sessionKey,
        sessionId: resetCommitted ? 'session-after' : 'session-before',
      },
    }));
    const gatewayRpcCall = jest.fn(async (_method: string, params: Record<string, unknown>) => {
      if (params.key !== HANDLE.sessionKey) {
        throw new Error(`historical session reset must fail: ${String(params.key)}`);
      }
      resetCommitted = true;
      return {
        ok: true,
        data: {
          ok: true,
          key: HANDLE.sessionKey,
          entry: { sessionId: 'session-after' },
        },
      };
    });
    const test = dependencies({ getSessionInfo, gatewayRpcCall });
    for (let index = 0; index < 150; index += 1) {
      test.agentSessions.push({
        id: `agent-session-history-${index}`,
        userId: 'user-1',
        provider: 'OPENCLAW',
        externalId: `agent:main:portal-user-1-history-${index}`,
      });
    }
    await test.journal.begin(HANDLE);

    const releaseAdmission = jest.fn();
    const fence = closeProjectDependencyPromotionWriterFence({
      closeAdmissionAndSettleInstaller: () => ({
        waitForMutationDrain: async () => {},
        release: releaseAdmission,
      }),
      releaseProjectLease: jest.fn(),
    }, {
      quiesceTerminalScopes: jest.fn(async () => ({
        preparationCount: 0,
        sessionCount: 0,
        recoveredCount: 0,
      })),
      quiesceAgentJobs: jest.fn(async () => ({
        jobCount: 0,
        liveRuntimeCount: 0,
        persistedRuntimeSignalCount: 0,
      })),
      quiesceHostAgentRuns: jest.fn(async () => ({
        runCount: 0,
        inMemoryAbortCount: 0,
        persistedRuntimeSignalCount: 0,
        recoveredCount: 0,
      })),
      quiesceOpenClawHostRuns: test.journal.quiesceForProjectDependencyPromotion,
      quiesceProjectNativeRuns: jest.fn(async () => ({ runCount: 0 })),
      attestDurableProjectChat: jest.fn(async () => ({
        activeTurnCount: 0,
        activeStateCount: 0,
      })),
    });

    const proof = await fence.proveQuiescent();

    expect(proof.preDrain.openClawHostRuns).toMatchObject({
      rowCount: 1,
      sessionCount: 1,
      sessions: [expect.objectContaining({
        sessionKey: HANDLE.sessionKey,
        rowCount: 1,
      })],
    });
    expect(proof.postDrain.openClawHostRuns).toMatchObject({
      rowCount: 0,
      sessionCount: 0,
      sessions: [],
    });
    expect(gatewayRpcCall).toHaveBeenCalledTimes(1);
    expect(gatewayRpcCall).toHaveBeenCalledWith(
      'sessions.reset',
      { key: HANDLE.sessionKey, reason: 'reset' },
      45_000,
    );
    await fence.releaseAfterSafeState(async () => {});
    expect(releaseAdmission).toHaveBeenCalledTimes(1);
  });

  test('dependency promotion does no provider work when no unresolved receipt exists', async () => {
    const test = dependencies();

    await expect(test.journal.quiesceForProjectDependencyPromotion()).resolves.toMatchObject({
      rowCount: 0,
      sessionCount: 0,
      sessions: [],
    });
    expect(test.gatewayRpcCall).not.toHaveBeenCalled();
    expect(test.getSessionInfo).not.toHaveBeenCalled();
  });

  test('rejects cross-actor unresolved rows for one session before provider reset', async () => {
    const test = dependencies();
    await test.journal.begin(HANDLE);
    test.rows.push({
      ...test.rows[0],
      id: 'portal-route-cross-actor',
      actorUserId: 'user-2',
      actorAuthorizationVersion: 3,
    });

    await expect(test.journal.quiesceForProjectDependencyPromotion()).rejects.toMatchObject({
      code: 'OPENCLAW_SESSION_OWNERSHIP_CONFLICT',
      sessionKey: HANDLE.sessionKey,
    });
    expect(test.gatewayRpcCall).not.toHaveBeenCalled();
    expect(test.getSessionInfo).not.toHaveBeenCalled();
  });

  test('rejects a reset that does not rotate or cannot be read back exactly', async () => {
    const noRotation = dependencies({
      getSessionInfo: jest.fn(async () => ({
        ok: true,
        data: { key: HANDLE.sessionKey, sessionId: 'session-after' },
      })),
    });
    await noRotation.journal.begin(HANDLE);
    await expect(
      noRotation.journal.quiesceForAuthorizationTransition(['user-1']),
    ).rejects.toMatchObject({ code: 'OPENCLAW_SESSION_IDENTITY_DRIFT' });
    expect(noRotation.rows[0].status).toBe('PREPARED');

    let calls = 0;
    const drift = dependencies({
      getSessionInfo: jest.fn(async () => {
        calls += 1;
        return {
          ok: true,
          data: {
            key: HANDLE.sessionKey,
            sessionId: calls === 1 ? 'session-before' : `session-after-${calls}`,
          },
        };
      }),
    });
    await drift.journal.begin(HANDLE);
    await expect(
      drift.journal.quiesceForAuthorizationTransition(['user-1']),
    ).rejects.toMatchObject({ code: 'OPENCLAW_SESSION_IDENTITY_DRIFT' });
    expect(drift.rows[0].status).toBe('PREPARED');
  });

  test('rejects session metadata whose exact requested key is absent', async () => {
    const test = dependencies({
      getSessionInfo: jest.fn(async () => ({
        ok: true,
        data: { sessionId: 'session-before' },
      })),
    });
    await test.journal.begin(HANDLE);

    await expect(
      test.journal.quiesceForAuthorizationTransition(['user-1']),
    ).rejects.toMatchObject({ code: 'OPENCLAW_SESSION_IDENTITY_DRIFT' });
    expect(test.gatewayRpcCall).not.toHaveBeenCalled();
    expect(test.rows[0].status).toBe('PREPARED');
  });

  test('wraps a rejected session read with stable journal diagnostics', async () => {
    const test = dependencies({
      getSessionInfo: jest.fn(async () => {
        throw new Error('gateway\nread\u0000failed');
      }),
    });
    await test.journal.begin(HANDLE);

    await expect(test.journal.quiesceForProjectDependencyPromotion()).rejects.toMatchObject({
      code: 'OPENCLAW_SESSION_READ_FAILED',
      sessionKey: HANDLE.sessionKey,
      causeMessage: 'gateway read failed',
    });
    expect(test.gatewayRpcCall).not.toHaveBeenCalled();
    expect(test.rows[0].status).toBe('PREPARED');
  });

  test('wraps a rejected reset RPC through the journal and writer fence', async () => {
    const gatewayRpcCall = jest.fn(async () => {
      throw new Error('reset transport\nclosed');
    });
    const test = dependencies({ gatewayRpcCall });
    await test.journal.begin(HANDLE);
    const fence = closeProjectDependencyPromotionWriterFence({
      closeAdmissionAndSettleInstaller: () => ({
        waitForMutationDrain: async () => {},
        release: jest.fn(),
      }),
      releaseProjectLease: jest.fn(),
    }, {
      quiesceTerminalScopes: jest.fn(async () => ({
        preparationCount: 0,
        sessionCount: 0,
        recoveredCount: 0,
      })),
      quiesceAgentJobs: jest.fn(async () => ({
        jobCount: 0,
        liveRuntimeCount: 0,
        persistedRuntimeSignalCount: 0,
      })),
      quiesceHostAgentRuns: jest.fn(async () => ({
        runCount: 0,
        inMemoryAbortCount: 0,
        persistedRuntimeSignalCount: 0,
        recoveredCount: 0,
      })),
      quiesceOpenClawHostRuns: test.journal.quiesceForProjectDependencyPromotion,
      quiesceProjectNativeRuns: jest.fn(async () => ({ runCount: 0 })),
      attestDurableProjectChat: jest.fn(async () => ({
        activeTurnCount: 0,
        activeStateCount: 0,
      })),
    });

    await expect(fence.proveQuiescent()).rejects.toMatchObject({
      code: 'PROJECT_DEPENDENCY_PROMOTION_WRITER_FENCE_UNPROVEN',
      subsystem: 'openClawHostRuns',
      causeCode: 'OPENCLAW_SESSION_RESET_FAILED',
      causeMessage: 'reset transport closed',
      sessionKey: HANDLE.sessionKey,
    });
    expect(gatewayRpcCall).toHaveBeenCalledTimes(1);
    expect(test.rows[0].status).toBe('PREPARED');
  });

  test('wraps invalid provider identities with stable codes and the requested session', async () => {
    const invalidRead = dependencies({
      getSessionInfo: jest.fn(async () => ({
        ok: true,
        data: { key: HANDLE.sessionKey, sessionId: '' },
      })),
    });
    await invalidRead.journal.begin(HANDLE);
    await expect(
      invalidRead.journal.quiesceForProjectDependencyPromotion(),
    ).rejects.toMatchObject({
      code: 'OPENCLAW_SESSION_IDENTITY_DRIFT',
      sessionKey: HANDLE.sessionKey,
      causeMessage: 'Invalid OpenClaw session generation',
    });

    const invalidReset = dependencies({
      gatewayRpcCall: jest.fn(async () => ({
        ok: true,
        data: { ok: true, key: '', entry: { sessionId: 'session-after' } },
      })),
    });
    await invalidReset.journal.begin(HANDLE);
    await expect(
      invalidReset.journal.quiesceForProjectDependencyPromotion(),
    ).rejects.toMatchObject({
      code: 'OPENCLAW_SESSION_IDENTITY_DRIFT',
      sessionKey: HANDLE.sessionKey,
      causeMessage: 'Invalid reset session key',
    });
  });

  test('rejects and never diagnoses a session key with an oversized agent id', async () => {
    const oversizedSessionKey = `agent:${'a'.repeat(2_048)}:x`;
    const test = dependencies();

    await expect(test.journal.begin({
      ...HANDLE,
      sessionKey: oversizedSessionKey,
    })).rejects.toMatchObject({ code: 'OPENCLAW_HOST_RUN_INVALID' });
    const diagnostic = new OpenClawHostRunJournalError(
      'invalid session',
      503,
      'OPENCLAW_SESSION_READ_FAILED',
      oversizedSessionKey,
    );
    expect(diagnostic.sessionKey).toBeNull();
    expect(test.rows).toHaveLength(0);
  });

  test.each([
    ['DISPATCHED', null],
    ['VISIBLE_DONE', new Date('2026-07-29T22:00:01.000Z')],
  ])(
    'rejects a concurrent PREPARED -> %s drift while the provider reset is in flight',
    async (status, visibleSettledAt) => {
      const test = dependencies();
      await test.journal.begin(HANDLE);
      test.setBeforeNextTransaction(() => {
        Object.assign(test.rows[0], {
          status,
          upstreamRunId: 'portal-upstream-raced',
          visibleSettledAt,
          terminalReason: status === 'VISIBLE_DONE' ? 'completed' : null,
        });
      });

      await expect(
        test.journal.quiesceForAuthorizationTransition(['user-1']),
      ).rejects.toMatchObject({ code: 'OPENCLAW_HOST_RUN_IDENTITY_DRIFT' });
      expect(test.rows[0]).toMatchObject({
        status,
        upstreamRunId: 'portal-upstream-raced',
      });
      expect(test.rows[0].evidence).toBeNull();
    },
  );

  test('CAS rejects dispatch drift after the post-reset digest read but before proof write', async () => {
    const test = dependencies();
    await test.journal.begin(HANDLE);
    test.setBeforeNextResetProofUpdate(() => {
      Object.assign(test.rows[0], {
        status: 'DISPATCHED',
        upstreamRunId: 'portal-upstream-cas-raced',
      });
    });

    await expect(
      test.journal.quiesceForAuthorizationTransition(['user-1']),
    ).rejects.toMatchObject({ code: 'OPENCLAW_SESSION_RESET_PROOF_FAILED' });
    expect(test.rows[0]).toMatchObject({
      status: 'DISPATCHED',
      upstreamRunId: 'portal-upstream-cas-raced',
      evidence: null,
    });
  });

  test('rejects a cross-user durable claim on one provider session', async () => {
    const test = dependencies();
    await test.journal.begin(HANDLE);
    test.rows.push({
      ...test.rows[0],
      id: 'portal-route-2',
      actorUserId: 'user-2',
      actorAuthorizationVersion: 3,
    });

    await expect(
      test.journal.quiesceForAuthorizationTransition(['user-1']),
    ).rejects.toMatchObject({ code: 'OPENCLAW_SESSION_OWNERSHIP_CONFLICT' });
    expect(test.gatewayRpcCall).not.toHaveBeenCalled();
  });

  test('does not release rows when reset proof persistence fails', async () => {
    const test = dependencies();
    await test.journal.begin(HANDLE);
    test.setFailResetProofCommit(true);

    await expect(
      test.journal.quiesceForAuthorizationTransition(['user-1']),
    ).rejects.toMatchObject({ code: 'OPENCLAW_SESSION_RESET_PROOF_FAILED' });
    expect(test.rows[0].status).toBe('PREPARED');
  });

  test('startup rejects unresolved rows whose actor generation drifted', async () => {
    const test = dependencies();
    await test.journal.begin(HANDLE);
    test.users[0].authorizationVersion = 8;

    await expect(test.journal.initialize()).rejects.toMatchObject({
      code: 'OPENCLAW_HOST_RUN_AUTHORIZATION_DRIFT',
    });
  });

  test('startup rejects an unresolved row after its durable session owner disappears', async () => {
    const test = dependencies();
    await test.journal.begin(HANDLE);
    test.agentSessions.length = 0;

    await expect(test.journal.initialize()).rejects.toMatchObject({
      code: 'OPENCLAW_SESSION_OWNERSHIP_CONFLICT',
    });
  });

  test('startup accepts unresolved rows only while exact actor authority remains current', async () => {
    const test = dependencies();
    await beginDispatchedVisible(test);

    await expect(test.journal.initialize()).resolves.toEqual({ unresolved: 1 });
  });
});
