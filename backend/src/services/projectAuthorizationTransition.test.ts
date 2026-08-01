import {
  PRIVILEGED_CONFIRMATION,
  confirmationForOwnershipTransfer,
} from '../utils/privilegedConfirmation';
import {
  createProjectAuthorizationTransitionCoordinator,
  PROJECT_AUTHORIZATION_TRANSITION_ACTIVE_CODE,
  PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
} from './projectAuthorizationTransition';

const NOW = new Date('2026-07-29T20:00:00.000Z');

function user(overrides: Record<string, unknown>) {
  return {
    id: 'user',
    email: 'user@example.com',
    username: 'user',
    firstName: null,
    lastName: null,
    role: 'USER',
    accountStatus: 'ACTIVE',
    isActive: true,
    sandboxEnabled: false,
    authorizationVersion: 1,
    passwordHash: 'bcrypt:CurrentPassword123!',
    twoFactorEnabled: false,
    twoFactorSecret: null,
    twoFactorBackupCodes: null,
    twoFactorMethod: null,
    twoFactorLastUsedStep: null,
    lastLoginAt: null,
    createdAt: NOW,
    avatarPath: null,
    ...overrides,
  };
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-1',
    workspaceOwnerId: 'owner',
    projectName: 'alpha',
    canonicalRoot: '/srv/projects/alpha',
    rootDevice: '11',
    rootInode: '22',
    rootBirthtimeNs: '33',
    generation: 1,
    lifecycleStatus: 'ACTIVE',
    legacyOpenClawMigrationStatus: 'COMPLETE',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function matchesScalar(actual: unknown, expected: unknown): boolean {
  if (
    expected
    && typeof expected === 'object'
    && !Array.isArray(expected)
    && !(expected instanceof Date)
  ) {
    const condition = expected as Record<string, unknown>;
    if ('not' in condition && actual === condition.not) return false;
    if ('lt' in condition && !(actual instanceof Date && actual < (condition.lt as Date))) return false;
    if ('gt' in condition && !(actual instanceof Date && actual > (condition.gt as Date))) return false;
    return true;
  }
  return actual === expected;
}

function matchesWhere(row: Record<string, any>, where: Record<string, any> = {}): boolean {
  if (Array.isArray(where.OR) && !where.OR.some((entry: any) => matchesWhere(row, entry))) {
    return false;
  }
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return true;
    return matchesScalar(row[key], expected);
  });
}

class FakeDatabase {
  readonly users: any[];
  readonly identities: any[];
  readonly transitions: any[] = [];
  readonly transitionProjects: any[] = [];
  readonly challenges: any[] = [];
  readonly sessions: any[] = [];
  readonly emailCodes: any[] = [];
  readonly passwordResets: any[] = [];
  readonly activityLogs: any[] = [];

  constructor(options: { users?: any[]; identities?: any[] } = {}) {
    this.users = options.users || [
      user({ id: 'owner', email: 'owner@example.com', username: 'owner', role: 'OWNER' }),
      user({ id: 'target', email: 'target@example.com', username: 'target' }),
      user({ id: 'third', email: 'third@example.com', username: 'third' }),
    ];
    this.identities = options.identities || [project()];
  }

  $transaction = async (operation: (transaction: this) => Promise<any>) => operation(this);

  projectAuthorizationTransition = {
    findFirst: async () => null,
  } as any;

  projectAuthorizationTransitionProject = {} as any;
  projectIdentity = {} as any;
  user = {} as any;
  twoFactorChallenge = {} as any;
  session = {} as any;
  emailVerificationCode = {} as any;
  passwordResetToken = {} as any;
  activityLog = {} as any;

  initialize(): this {
    this.projectAuthorizationTransition = {
      findFirst: async (args: any) => (
        this.transitions.find((row) => matchesWhere(row, args?.where)) || null
      ),
      findUnique: async (args: any) => {
        const row = this.transitions.find((entry) => entry.id === args.where.id);
        if (!row) return null;
        return {
          ...row,
          ...(args.include?.projects
            ? {
              projects: this.transitionProjects
                .filter((entry) => entry.transitionId === row.id)
                .sort((left, right) => left.projectIdentityId.localeCompare(right.projectIdentityId))
                .map((entry) => ({ ...entry })),
            }
            : {}),
        };
      },
      create: async (args: any) => {
        const row = {
          id: args.data.id,
          singletonKey: args.data.singletonKey,
          kind: args.data.kind,
          phase: args.data.phase,
          initiatedByUserId: args.data.initiatedByUserId,
          targetUserId: args.data.targetUserId || null,
          sourceOwnerUserId: args.data.sourceOwnerUserId || null,
          payload: args.data.payload,
          result: null,
          gatewayWasActive: null,
          gatewayFenceProof: null,
          hostRuntimeQuiescenceProof: null,
          leaseOwner: null,
          leaseTokenHash: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          createdAt: NOW,
          updatedAt: NOW,
        };
        this.transitions.push(row);
        return { ...row };
      },
      update: async (args: any) => {
        const row = this.transitions.find((entry) => entry.id === args.where.id);
        if (!row) throw new Error('transition missing');
        Object.assign(row, args.data);
        return { ...row };
      },
      updateMany: async (args: any) => {
        const rows = this.transitions.filter((row) => matchesWhere(row, args.where));
        for (const row of rows) Object.assign(row, args.data);
        return { count: rows.length };
      },
    };
    this.projectAuthorizationTransitionProject = {
      createMany: async (args: any) => {
        this.transitionProjects.push(...args.data.map((entry: any) => ({
          ...entry,
          quiescenceEvidence: null,
          quiescedAt: null,
        })));
        return { count: args.data.length };
      },
      updateMany: async (args: any) => {
        const rows = this.transitionProjects.filter((row) => matchesWhere(row, args.where));
        for (const row of rows) Object.assign(row, args.data);
        return { count: rows.length };
      },
      findUnique: async (args: any) => {
        const key = args.where.transitionId_projectIdentityId;
        return this.transitionProjects.find((entry) => (
          entry.transitionId === key.transitionId
          && entry.projectIdentityId === key.projectIdentityId
        )) || null;
      },
    };
    this.projectIdentity = {
      findMany: async () => this.identities.map((entry) => ({ ...entry })),
      findUnique: async (args: any) => {
        const entry = this.identities.find((identity) => identity.id === args.where.id);
        return entry ? { ...entry } : null;
      },
    };
    this.user = {
      findUnique: async (args: any) => {
        const entry = this.users.find((candidate) => candidate.id === args.where.id);
        return entry ? { ...entry } : null;
      },
      findMany: async (args: any) => {
        const rows = [...this.users].sort((left, right) => left.id.localeCompare(right.id));
        if (args?.select) {
          return rows.map((entry) => Object.fromEntries(
            Object.keys(args.select)
              .filter((key) => args.select[key])
              .map((key) => [key, entry[key]]),
          ));
        }
        return rows.map((entry) => ({ ...entry }));
      },
      update: async (args: any) => {
        const entry = this.users.find((candidate) => candidate.id === args.where.id);
        if (!entry) throw new Error('user missing');
        this.applyUserData(entry, args.data);
        return { ...entry };
      },
      updateMany: async (args: any) => {
        const rows = this.users.filter((entry) => matchesWhere(entry, args.where || {}));
        for (const entry of rows) this.applyUserData(entry, args.data);
        return { count: rows.length };
      },
    };
    this.twoFactorChallenge = {
      findUnique: async (args: any) => {
        const entry = this.challenges.find((candidate) => candidate.id === args.where.id);
        return entry ? { ...entry } : null;
      },
      updateMany: async (args: any) => {
        const rows = this.challenges.filter((entry) => matchesWhere(entry, args.where));
        for (const entry of rows) Object.assign(entry, args.data);
        return { count: rows.length };
      },
      deleteMany: async (args: any) => {
        const before = this.challenges.length;
        for (let index = this.challenges.length - 1; index >= 0; index -= 1) {
          if (matchesWhere(this.challenges[index], args.where)) this.challenges.splice(index, 1);
        }
        return { count: before - this.challenges.length };
      },
      count: async (args: any) => this.challenges.filter(
        (entry) => matchesWhere(entry, args.where),
      ).length,
    };
    this.session = {
      deleteMany: async (args: any) => {
        const before = this.sessions.length;
        for (let index = this.sessions.length - 1; index >= 0; index -= 1) {
          if (matchesWhere(this.sessions[index], args.where)) this.sessions.splice(index, 1);
        }
        return { count: before - this.sessions.length };
      },
      count: async (args: any) => this.sessions.filter(
        (entry) => matchesWhere(entry, args.where),
      ).length,
    };
    this.emailVerificationCode = {
      deleteMany: async (args: any) => {
        const before = this.emailCodes.length;
        for (let index = this.emailCodes.length - 1; index >= 0; index -= 1) {
          if (matchesWhere(this.emailCodes[index], args.where)) this.emailCodes.splice(index, 1);
        }
        return { count: before - this.emailCodes.length };
      },
      count: async (args: any) => this.emailCodes.filter(
        (entry) => matchesWhere(entry, args.where),
      ).length,
    };
    this.passwordResetToken = {
      updateMany: async (args: any) => {
        const rows = this.passwordResets.filter((entry) => matchesWhere(entry, args.where));
        for (const entry of rows) Object.assign(entry, args.data);
        return { count: rows.length };
      },
      count: async (args: any) => this.passwordResets.filter(
        (entry) => matchesWhere(entry, args.where),
      ).length,
    };
    this.activityLog = {
      create: async (args: any) => {
        const row = { id: `activity-${this.activityLogs.length + 1}`, ...args.data };
        this.activityLogs.push(row);
        return { ...row };
      },
    };
    return this;
  }

  private applyUserData(entry: any, data: Record<string, any>): void {
    for (const [key, value] of Object.entries(data)) {
      if (
        value
        && typeof value === 'object'
        && !Array.isArray(value)
        && 'increment' in value
      ) {
        entry[key] = Number(entry[key] || 0) + Number(value.increment);
      } else {
        entry[key] = value;
      }
    }
  }
}

function harness(database = new FakeDatabase().initialize()) {
  const events: string[] = [];
  const published: any[] = [];
  let gatewayActive = true;
  let failGatewayStart = false;
  let failCleanup = false;
  let onDrain: (() => void | Promise<void>) | null = null;
  let uuid = 0;

  const coordinator = createProjectAuthorizationTransitionCoordinator({
    database,
    closeAdmission: () => {
      events.push('admission:closed');
      return {
        waitForMutationDrain: async () => {
          events.push('admission:drained');
          await onDrain?.();
        },
        release: () => {
          events.push('admission:released');
        },
      };
    },
    quiesceAgentJobs: async () => {
      events.push('jobs:quiesced');
      return { jobCount: 1, liveRuntimeCount: 1, persistedRuntimeSignalCount: 0 };
    },
    quiesceHostRuns: async () => {
      events.push('hosts:quiesced');
      return {
        runCount: 1,
        inMemoryAbortCount: 1,
        persistedRuntimeSignalCount: 0,
        recoveredCount: 1,
      };
    },
    quiesceOpenClawHostRuns: async (actorUserIds: readonly string[]) => {
      events.push(`openclaw:quiesced:${actorUserIds.join(',')}`);
      return {
        schemaVersion: 1,
        actorUserIds: [...actorUserIds],
        rowCount: 1,
        sessionCount: 1,
        sessions: [{
          schemaVersion: 1,
          sessionKey: 'agent:main:portal-target',
          beforeSessionId: 'before',
          resetSessionId: 'after',
          readbackSessionId: 'after',
          reattestedSessionId: 'after',
          rowCount: 1,
          rowIdentitySha256: 'a'.repeat(64),
          resetAt: NOW.toISOString(),
        }],
      };
    },
    cleanupProject: async () => {
      events.push('project:cleaned');
      if (failCleanup) throw new Error('cleanup unavailable');
      return {
        projectIdentityId: 'project-1',
        actorCount: 3,
        bindingCount: 1,
        sessionCount: 1,
        quiescedTurnCount: 1,
        removedResourceCount: 1,
        alreadyClean: false,
      };
    },
    assertProjectRoot: (identity, root) => {
      if (identity.canonicalRoot !== root) throw new Error('root mismatch');
      return {};
    },
    gateway: {
      inspect: async () => ({
        installed: true,
        masked: false,
        active: gatewayActive,
        activeState: gatewayActive ? 'active' : 'inactive',
        subState: gatewayActive ? 'running' : 'dead',
        killMode: 'control-group',
        mainPid: gatewayActive ? 123 : 0,
        controlGroup: gatewayActive ? '/system.slice/openclaw-gateway.service' : null,
        fragmentPath: '/etc/systemd/system/openclaw-gateway.service',
        dropInPaths: [
          '/etc/systemd/system/openclaw-gateway.service.d/20-bridgesllm-authorization-fence.conf',
        ],
        needDaemonReload: false,
      }),
      stop: async () => {
        events.push('gateway:stopped');
        const priorActive = gatewayActive;
        gatewayActive = false;
        return {
          unit: 'openclaw-gateway.service',
          stopped: true,
          priorActive,
          priorMainPid: priorActive ? 123 : 0,
          priorControlGroup: priorActive ? '/system.slice/openclaw-gateway.service' : null,
          observedActiveState: 'inactive',
          observedMainPid: 0,
          cgroupEmpty: true,
          listenerPort: 18_789,
          listenersAbsent: true,
          markerPath: '/var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1',
          markerDevice: '2049',
          markerInode: '71234',
          dropInPath:
            '/etc/systemd/system/openclaw-gateway.service.d/20-bridgesllm-authorization-fence.conf',
          rootUserDropInPath:
            '/root/.config/systemd/user/openclaw-gateway.service.d/20-bridgesllm-authorization-fence.conf',
          rootUserManagerActive: false,
          rootUserUnitInstalled: false,
          rootUserUnitMasked: false,
          rootUserUnitPriorActive: false,
          rootUserUnitObservedActiveState: 'inactive',
          rootUserUnitObservedMainPid: 0,
          rootUserCgroupEmpty: true,
        };
      },
      release: async (restart: boolean) => {
        if (restart) events.push('gateway:started');
        if (restart && failGatewayStart) throw new Error('gateway start unavailable');
        gatewayActive = restart;
        return {
          installed: true,
          masked: false,
          active: restart,
          activeState: restart ? 'active' : 'inactive',
          subState: restart ? 'running' : 'dead',
          killMode: 'control-group',
          mainPid: restart ? 456 : 0,
          controlGroup: restart ? '/system.slice/openclaw-gateway.service' : null,
          fragmentPath: '/etc/systemd/system/openclaw-gateway.service',
          dropInPaths: [
            '/etc/systemd/system/openclaw-gateway.service.d/20-bridgesllm-authorization-fence.conf',
          ],
          needDaemonReload: false,
        };
      },
    },
    publish: (event) => {
      events.push(`published:${event.userId}`);
      published.push(event);
    },
    now: () => new Date(NOW),
    randomUUID: () => `uuid-${++uuid}`,
    randomBytes: () => Buffer.alloc(32, 7),
  } as any);

  return {
    coordinator,
    database,
    events,
    published,
    setFailGatewayStart(value: boolean) {
      failGatewayStart = value;
    },
    setFailCleanup(value: boolean) {
      failCleanup = value;
    },
    setOnDrain(operation: (() => void | Promise<void>) | null) {
      onDrain = operation;
    },
  };
}

describe('durable Project authorization transitions', () => {
  test('quiesces every plane before one exact user generation commit', async () => {
    const test = harness();
    const result = await test.coordinator.updateUserAuthorization({
      initiatedByUserId: 'owner',
      targetUserId: 'target',
      update: { role: 'SUB_ADMIN' },
      confirmation: PRIVILEGED_CONFIRMATION.grantServerAccess,
    });

    expect(result.user).toMatchObject({
      id: 'target',
      role: 'SUB_ADMIN',
      authorizationVersion: 2,
    });
    expect(test.database.transitions).toHaveLength(1);
    expect(test.database.transitions[0]).toMatchObject({
      phase: 'COMPLETE',
      gatewayWasActive: true,
      leaseOwner: null,
      leaseTokenHash: null,
    });
    expect(test.database.transitionProjects[0]).toMatchObject({
      status: 'QUIESCED',
      projectIdentityId: 'project-1',
    });
    expect(test.database.transitions[0].hostRuntimeQuiescenceProof).toMatchObject({
      schemaVersion: 1,
      affectedActorIds: ['target'],
      attempts: [
        expect.objectContaining({
          openClawHostRuns: expect.objectContaining({
            actorUserIds: ['target'],
          }),
        }),
        expect.objectContaining({
          openClawHostRuns: expect.objectContaining({
            actorUserIds: ['target'],
          }),
        }),
      ],
    });
    const firstJobQuiescence = test.events.indexOf('jobs:quiesced');
    const drain = test.events.indexOf('admission:drained');
    const secondJobQuiescence = test.events.indexOf(
      'jobs:quiesced',
      firstJobQuiescence + 1,
    );
    expect(firstJobQuiescence).toBeLessThan(drain);
    expect(drain).toBeLessThan(secondJobQuiescence);
    expect(test.events).toContain('openclaw:quiesced:target');
    expect(test.events.indexOf('project:cleaned')).toBeLessThan(
      test.events.indexOf('gateway:stopped'),
    );
    expect(test.events.indexOf('gateway:stopped')).toBeLessThan(
      test.events.indexOf('published:target'),
    );
    expect(test.events.indexOf('published:target')).toBeLessThan(
      test.events.indexOf('gateway:started'),
    );
    expect(test.events.indexOf('gateway:started')).toBeLessThan(
      test.events.indexOf('admission:released'),
    );
    expect(test.published).toEqual([expect.objectContaining({
      userId: 'target',
      authorizationVersion: 2,
      reasons: ['role'],
    })]);
  });

  test('durably quiesces provider authority before emergency credential recovery', async () => {
    const database = new FakeDatabase({
      users: [
        user({ id: 'owner', email: 'owner@example.com', username: 'owner', role: 'OWNER' }),
        user({
          id: 'target',
          email: 'target@example.com',
          username: 'target',
          authorizationVersion: 7,
          passwordHash: 'bcrypt:CurrentPassword123!',
          twoFactorEnabled: true,
          twoFactorSecret: 'encrypted-email-state',
          twoFactorBackupCodes: '[]',
          twoFactorMethod: 'email',
          twoFactorLastUsedStep: 11,
        }),
      ],
      identities: [project()],
    }).initialize();
    database.challenges.push({
      id: 'challenge-1',
      userId: 'target',
      tokenHash: 'portal-token:v1:2fa-challenge:durable-test',
      consumedAt: null,
      expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000),
    });
    database.sessions.push({ id: 'session-1', userId: 'target' });
    database.emailCodes.push({ id: 'code-1', userId: 'target' });
    database.passwordResets.push({ id: 'reset-1', userId: 'target', usedAt: null });
    const test = harness(database);

    const result = await test.coordinator.recoverEmailTwoFactor({
      targetUserId: 'target',
      challengeId: 'challenge-1',
      challengeTokenHash: 'portal-token:v1:2fa-challenge:durable-test',
      expectedPasswordHash: 'bcrypt:CurrentPassword123!',
      expectedBackupCodes: '[]',
      ipAddress: '127.0.0.1',
      userAgent: 'authorization-transition-test',
    });

    expect(result).toMatchObject({
      user: {
        id: 'target',
        authorizationVersion: 8,
      },
      authorizationReasons: ['credential_recovery'],
    });
    expect(database.transitions).toHaveLength(1);
    expect(database.transitions[0]).toMatchObject({
      kind: 'CREDENTIAL_RECOVERY',
      phase: 'COMPLETE',
    });
    expect(database.users.find((entry) => entry.id === 'target')).toMatchObject({
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorBackupCodes: null,
      twoFactorMethod: null,
      twoFactorLastUsedStep: null,
      authorizationVersion: 8,
    });
    expect(database.challenges).toHaveLength(0);
    expect(database.sessions).toHaveLength(0);
    expect(database.emailCodes).toHaveLength(0);
    expect(database.passwordResets[0].usedAt).toEqual(NOW);
    expect(database.activityLogs[0]).toMatchObject({
      userId: 'target',
      action: 'EMAIL_2FA_EMERGENCY_RECOVERY',
      metadata: expect.objectContaining({
        durableAuthorizationTransitionId: database.transitions[0].id,
      }),
    });
    expect(test.events.indexOf('gateway:stopped')).toBeLessThan(
      test.events.indexOf('published:target'),
    );
    expect(test.events.indexOf('published:target')).toBeLessThan(
      test.events.indexOf('gateway:started'),
    );
    expect(test.published).toEqual([{
      type: 'authorization_changed',
      userId: 'target',
      authorizationVersion: 8,
      reasons: ['credential_recovery'],
    }]);
  });

  test('atomically revokes every stale authentication artifact when an inaccessible account becomes accessible', async () => {
    const database = new FakeDatabase({
      users: [
        user({ id: 'owner', email: 'owner@example.com', username: 'owner', role: 'OWNER' }),
        user({
          id: 'target',
          email: 'target@example.com',
          username: 'target',
          accountStatus: 'PENDING',
          isActive: false,
          authorizationVersion: 7,
        }),
        user({ id: 'third', email: 'third@example.com', username: 'third' }),
      ],
      identities: [project()],
    }).initialize();
    database.sessions.push(
      { id: 'target-session', userId: 'target' },
      { id: 'third-session', userId: 'third' },
    );
    database.challenges.push(
      { id: 'target-challenge', userId: 'target' },
      { id: 'third-challenge', userId: 'third' },
    );
    database.emailCodes.push(
      { id: 'target-email-code', userId: 'target' },
      { id: 'third-email-code', userId: 'third' },
    );
    database.passwordResets.push(
      { id: 'target-reset', userId: 'target', usedAt: null },
      { id: 'third-reset', userId: 'third', usedAt: null },
    );
    const test = harness(database);

    await expect(test.coordinator.updateUserAuthorization({
      initiatedByUserId: 'owner',
      targetUserId: 'target',
      update: { accountStatus: 'ACTIVE', isActive: true },
      confirmation: PRIVILEGED_CONFIRMATION.grantServerAccess,
    })).resolves.toMatchObject({
      user: {
        id: 'target',
        accountStatus: 'ACTIVE',
        isActive: true,
        authorizationVersion: 8,
      },
    });

    expect(database.transitions[0].phase).toBe('COMPLETE');
    expect(database.sessions).toEqual([{ id: 'third-session', userId: 'third' }]);
    expect(database.challenges).toEqual([{ id: 'third-challenge', userId: 'third' }]);
    expect(database.emailCodes).toEqual([{ id: 'third-email-code', userId: 'third' }]);
    expect(database.passwordResets).toEqual([
      { id: 'target-reset', userId: 'target', usedAt: NOW },
      { id: 'third-reset', userId: 'third', usedAt: null },
    ]);
  });

  test('preserves authentication artifacts for an active-to-active authorization update', async () => {
    const database = new FakeDatabase().initialize();
    database.sessions.push({ id: 'session-1', userId: 'target' });
    database.challenges.push({ id: 'challenge-1', userId: 'target' });
    database.emailCodes.push({ id: 'email-code-1', userId: 'target' });
    database.passwordResets.push({ id: 'reset-1', userId: 'target', usedAt: null });
    const test = harness(database);

    await expect(test.coordinator.updateUserAuthorization({
      initiatedByUserId: 'owner',
      targetUserId: 'target',
      update: { sandboxEnabled: true },
    })).resolves.toMatchObject({
      user: {
        id: 'target',
        sandboxEnabled: true,
        authorizationVersion: 2,
      },
    });

    expect(database.sessions).toHaveLength(1);
    expect(database.challenges).toHaveLength(1);
    expect(database.emailCodes).toHaveLength(1);
    expect(database.passwordResets).toEqual([
      { id: 'reset-1', userId: 'target', usedAt: null },
    ]);
  });

  test.each([
    {
      artifact: 'session',
      inject: (database: FakeDatabase) => {
        database.sessions.push({ id: 'late-session', userId: 'target' });
      },
    },
    {
      artifact: 'two-factor challenge',
      inject: (database: FakeDatabase) => {
        database.challenges.push({ id: 'late-challenge', userId: 'target' });
      },
    },
    {
      artifact: 'email verification code',
      inject: (database: FakeDatabase) => {
        database.emailCodes.push({ id: 'late-email-code', userId: 'target' });
      },
    },
    {
      artifact: 'unused password reset',
      inject: (database: FakeDatabase) => {
        database.passwordResets.push({
          id: 'late-password-reset',
          userId: 'target',
          usedAt: null,
        });
      },
    },
  ])('fails COMMITTED recovery before gateway release when a late $artifact appears', async ({
    inject,
  }) => {
    const database = new FakeDatabase({
      users: [
        user({ id: 'owner', email: 'owner@example.com', username: 'owner', role: 'OWNER' }),
        user({
          id: 'target',
          email: 'target@example.com',
          username: 'target',
          accountStatus: 'PENDING',
          isActive: false,
        }),
      ],
      identities: [project()],
    }).initialize();
    const test = harness(database);
    test.setFailGatewayStart(true);

    await expect(test.coordinator.updateUserAuthorization({
      initiatedByUserId: 'owner',
      targetUserId: 'target',
      update: { accountStatus: 'ACTIVE', isActive: true },
      confirmation: PRIVILEGED_CONFIRMATION.grantServerAccess,
    })).rejects.toMatchObject({
      code: 'PROJECT_AUTHORIZATION_TRANSITION_FAILED',
    });
    expect(database.transitions[0].phase).toBe('COMMITTED');

    inject(database);
    const startsBefore = test.events.filter(
      (event) => event === 'gateway:started',
    ).length;
    test.setFailGatewayStart(false);

    await expect(test.coordinator.recoverUnfinished()).rejects.toMatchObject({
      code: PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE,
    });
    expect(test.events.filter(
      (event) => event === 'gateway:started',
    )).toHaveLength(startsBefore);
    expect(database.transitions[0].phase).toBe('COMMITTED');
  });

  test('signals provider work before waiting for its mutation lease to drain', async () => {
    const test = harness();
    test.setOnDrain(() => {
      expect(test.events).toContain('jobs:quiesced');
      expect(test.events).toContain('hosts:quiesced');
      expect(test.events).toContain('openclaw:quiesced:target');
    });

    await expect(test.coordinator.updateUserAuthorization({
      initiatedByUserId: 'owner',
      targetUserId: 'target',
      update: { sandboxEnabled: true },
    })).resolves.toMatchObject({
      user: {
        id: 'target',
        sandboxEnabled: true,
      },
    });

    expect(test.events.filter((event) => event === 'jobs:quiesced')).toHaveLength(2);
    expect(test.events.filter((event) => event === 'hosts:quiesced')).toHaveLength(2);
    expect(
      test.events.filter((event) => event === 'openclaw:quiesced:target'),
    ).toHaveLength(2);
  });

  test('publishes revocation before a failed release and recovers it idempotently under one admission fence', async () => {
    const test = harness();
    test.setFailGatewayStart(true);
    await expect(test.coordinator.updateUserAuthorization({
      initiatedByUserId: 'owner',
      targetUserId: 'target',
      update: { sandboxEnabled: true },
    })).rejects.toMatchObject({
      code: 'PROJECT_AUTHORIZATION_TRANSITION_FAILED',
      message: expect.not.stringContaining('gateway start unavailable'),
    });

    expect(test.database.transitions[0].phase).toBe('COMMITTED');
    expect(test.database.users.find((entry) => entry.id === 'target')).toMatchObject({
      sandboxEnabled: true,
      authorizationVersion: 2,
    });
    expect(test.published).toEqual([expect.objectContaining({
      userId: 'target',
      authorizationVersion: 2,
      reasons: ['workspace_scope'],
    })]);
    expect(test.events.indexOf('published:target')).toBeLessThan(
      test.events.indexOf('gateway:started'),
    );
    expect(test.events).not.toContain('admission:released');

    await expect(test.coordinator.recoverUnfinished()).rejects.toMatchObject({
      code: 'PROJECT_AUTHORIZATION_TRANSITION_FAILED',
    });
    expect(test.database.transitions[0].phase).toBe('COMMITTED');
    expect(test.events.filter((event) => event === 'admission:closed')).toHaveLength(1);
    expect(test.events).not.toContain('admission:released');

    test.setFailGatewayStart(false);
    await expect(test.coordinator.recoverUnfinished()).resolves.toEqual({
      recovered: true,
      transitionId: test.database.transitions[0].id,
    });
    expect(test.database.transitions[0].phase).toBe('COMPLETE');
    expect(test.database.users.find((entry) => entry.id === 'target').authorizationVersion).toBe(2);
    expect(test.published).toEqual([
      expect.objectContaining({
        userId: 'target',
        authorizationVersion: 2,
        reasons: ['workspace_scope'],
      }),
      expect.objectContaining({
        userId: 'target',
        authorizationVersion: 2,
        reasons: ['workspace_scope'],
      }),
      expect.objectContaining({
        userId: 'target',
        authorizationVersion: 2,
        reasons: ['workspace_scope'],
      }),
    ]);
    expect(test.events.filter((event) => event === 'admission:closed')).toHaveLength(1);
    expect(test.events.filter((event) => event === 'admission:released')).toHaveLength(1);
  });

  test.each([
    {
      name: 'missing proof',
      corrupt: () => null,
    },
    {
      name: 'fewer than two inventory attempts',
      corrupt: (proof: any) => ({
        ...proof,
        attempts: proof.attempts.slice(0, 1),
      }),
    },
    {
      name: 'unknown attempt field',
      corrupt: (proof: any) => {
        proof.attempts[0].unexpected = true;
        return proof;
      },
    },
    {
      name: 'non-monotonic attempt timestamps',
      corrupt: (proof: any) => {
        proof.attempts[0].recordedAt = '2026-07-29T21:00:00.000Z';
        proof.attempts[1].recordedAt = '2026-07-29T20:30:00.000Z';
        return proof;
      },
    },
    {
      name: 'non-numeric agent-job count',
      corrupt: (proof: any) => {
        proof.attempts[0].agentJobs.jobCount = '1';
        return proof;
      },
    },
    {
      name: 'inconsistent native host-run count',
      corrupt: (proof: any) => {
        proof.attempts[0].nativeHostRuns.recoveredCount = 2;
        return proof;
      },
    },
    {
      name: 'OpenClaw schema drift',
      corrupt: (proof: any) => {
        proof.attempts[0].openClawHostRuns.schemaVersion = 2;
        return proof;
      },
    },
    {
      name: 'OpenClaw actor drift',
      corrupt: (proof: any) => {
        proof.attempts[0].openClawHostRuns.actorUserIds = ['owner'];
        return proof;
      },
    },
    {
      name: 'OpenClaw session-count drift',
      corrupt: (proof: any) => {
        proof.attempts[0].openClawHostRuns.sessionCount = 0;
        return proof;
      },
    },
    {
      name: 'duplicate OpenClaw session identity',
      corrupt: (proof: any) => {
        const openClaw = proof.attempts[0].openClawHostRuns;
        openClaw.sessions.push({ ...openClaw.sessions[0] });
        openClaw.sessionCount = 2;
        openClaw.rowCount = 2;
        return proof;
      },
    },
    {
      name: 'OpenClaw reset-generation drift',
      corrupt: (proof: any) => {
        proof.attempts[0].openClawHostRuns.sessions[0].readbackSessionId = 'other';
        return proof;
      },
    },
    {
      name: 'OpenClaw row digest drift',
      corrupt: (proof: any) => {
        proof.attempts[0].openClawHostRuns.sessions[0].rowIdentitySha256 =
          'A'.repeat(64);
        return proof;
      },
    },
    {
      name: 'OpenClaw row-count drift',
      corrupt: (proof: any) => {
        proof.attempts[0].openClawHostRuns.rowCount = 0;
        return proof;
      },
    },
    {
      name: 'non-canonical reset timestamp',
      corrupt: (proof: any) => {
        proof.attempts[0].openClawHostRuns.sessions[0].resetAt =
          '2026-07-29 20:00:00Z';
        return proof;
      },
    },
  ])('rejects $name on COMMITTED recovery before gateway release', async ({
    corrupt,
  }) => {
    const test = harness();
    test.setFailGatewayStart(true);
    await expect(test.coordinator.updateUserAuthorization({
      initiatedByUserId: 'owner',
      targetUserId: 'target',
      update: { sandboxEnabled: true },
    })).rejects.toMatchObject({ code: 'PROJECT_AUTHORIZATION_TRANSITION_FAILED' });
    expect(test.database.transitions[0].phase).toBe('COMMITTED');

    const proof = JSON.parse(JSON.stringify(
      test.database.transitions[0].hostRuntimeQuiescenceProof,
    ));
    test.database.transitions[0].hostRuntimeQuiescenceProof = corrupt(proof);
    const startsBefore = test.events.filter(
      (event) => event === 'gateway:started',
    ).length;
    test.setFailGatewayStart(false);

    await expect(test.coordinator.recoverUnfinished()).rejects.toMatchObject({
      code: 'PROJECT_AUTHORIZATION_TRANSITION_JOURNAL_INVALID',
    });
    expect(test.events.filter(
      (event) => event === 'gateway:started',
    )).toHaveLength(startsBefore);
    expect(test.database.transitions[0].phase).toBe('COMMITTED');
  });

  test('rejects a corrupted proof on PROVIDER_FENCED recovery before authorization commit', async () => {
    const test = harness();
    test.setFailCleanup(true);
    await expect(test.coordinator.updateUserAuthorization({
      initiatedByUserId: 'owner',
      targetUserId: 'target',
      update: { sandboxEnabled: true },
    })).rejects.toMatchObject({ code: 'PROJECT_AUTHORIZATION_TRANSITION_FAILED' });
    expect(test.database.transitions[0].phase).toBe('QUIESCING');

    test.database.transitions[0].phase = 'PROVIDER_FENCED';
    test.database.transitions[0]
      .hostRuntimeQuiescenceProof
      .attempts[0]
      .openClawHostRuns
      .sessions[0]
      .rowIdentitySha256 = 'A'.repeat(64);
    test.setFailCleanup(false);

    await expect(test.coordinator.recoverUnfinished()).rejects.toMatchObject({
      code: 'PROJECT_AUTHORIZATION_TRANSITION_JOURNAL_INVALID',
    });
    expect(test.database.users.find((entry) => entry.id === 'target')).toMatchObject({
      sandboxEnabled: false,
      authorizationVersion: 1,
    });
    expect(test.database.transitions[0].phase).toBe('PROVIDER_FENCED');
  });

  test('requires sorted exact affected actors in a recovered ownership proof', async () => {
    const test = harness();
    test.setFailGatewayStart(true);
    await expect(test.coordinator.transferOwnership({
      sourceOwnerUserId: 'owner',
      targetUserId: 'target',
      confirmation: confirmationForOwnershipTransfer('target@example.com'),
    })).rejects.toMatchObject({ code: 'PROJECT_AUTHORIZATION_TRANSITION_FAILED' });
    expect(test.database.transitions[0].phase).toBe('COMMITTED');

    test.database.transitions[0].hostRuntimeQuiescenceProof.affectedActorIds =
      ['third', 'target', 'owner'];
    test.setFailGatewayStart(false);
    await expect(test.coordinator.recoverUnfinished()).rejects.toMatchObject({
      code: 'PROJECT_AUTHORIZATION_TRANSITION_JOURNAL_INVALID',
    });
    expect(test.database.transitions[0].phase).toBe('COMMITTED');
  });

  test('keeps the durable admission fence unresolved when provider cleanup fails', async () => {
    const test = harness();
    test.setFailCleanup(true);
    await expect(test.coordinator.updateUserAuthorization({
      initiatedByUserId: 'owner',
      targetUserId: 'target',
      update: { accountStatus: 'DISABLED', isActive: false },
    })).rejects.toMatchObject({
      code: 'PROJECT_AUTHORIZATION_TRANSITION_FAILED',
      message: expect.not.stringContaining('cleanup unavailable'),
    });

    expect(test.database.transitions[0]).toMatchObject({
      phase: 'QUIESCING',
      lastErrorCode: 'PROJECT_AUTHORIZATION_TRANSITION_FAILED',
    });
    expect(test.database.users.find((entry) => entry.id === 'target')).toMatchObject({
      accountStatus: 'ACTIVE',
      authorizationVersion: 1,
    });

    test.setFailCleanup(false);
    await expect(test.coordinator.recoverUnfinished()).resolves.toMatchObject({ recovered: true });
    expect(test.database.users.find((entry) => entry.id === 'target')).toMatchObject({
      accountStatus: 'DISABLED',
      authorizationVersion: 2,
    });
  });

  test('rejects a malformed durable request before retrying cleanup', async () => {
    const test = harness();
    test.setFailCleanup(true);
    await expect(test.coordinator.updateUserAuthorization({
      initiatedByUserId: 'owner',
      targetUserId: 'target',
      update: { sandboxEnabled: true },
    })).rejects.toMatchObject({ code: 'PROJECT_AUTHORIZATION_TRANSITION_FAILED' });

    test.database.transitions[0].payload = {
      ...test.database.transitions[0].payload,
      candidateActorIds: ['owner', 'owner', 'target', 'third'],
    };
    test.setFailCleanup(false);
    await expect(test.coordinator.recoverUnfinished()).rejects.toMatchObject({
      code: 'PROJECT_AUTHORIZATION_TRANSITION_JOURNAL_INVALID',
    });
    expect(test.database.users.find((entry) => entry.id === 'target').authorizationVersion).toBe(1);
  });

  test('re-attests a committed result before restarting the provider gateway', async () => {
    const test = harness();
    test.setFailGatewayStart(true);
    await expect(test.coordinator.updateUserAuthorization({
      initiatedByUserId: 'owner',
      targetUserId: 'target',
      update: { sandboxEnabled: true },
    })).rejects.toMatchObject({ code: 'PROJECT_AUTHORIZATION_TRANSITION_FAILED' });
    expect(test.database.transitions[0].phase).toBe('COMMITTED');
    const startsBefore = test.events.filter((event) => event === 'gateway:started').length;

    test.database.transitions[0].result.user.authorizationVersion = 999;
    test.setFailGatewayStart(false);
    await expect(test.coordinator.recoverUnfinished()).rejects.toMatchObject({
      code: 'PROJECT_AUTHORIZATION_TRANSITION_JOURNAL_INVALID',
    });
    expect(test.events.filter((event) => event === 'gateway:started')).toHaveLength(startsBefore);
    expect(test.database.transitions[0].phase).toBe('COMMITTED');
  });

  test('fails closed when the immutable Project manifest changes before commit', async () => {
    const test = harness();
    test.setOnDrain(() => {
      test.database.identities[0].generation = 2;
    });

    await expect(test.coordinator.updateUserAuthorization({
      initiatedByUserId: 'owner',
      targetUserId: 'target',
      update: { sandboxEnabled: true },
    })).rejects.toMatchObject({ code: PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE });
    expect(test.database.transitions[0].phase).toBe('QUIESCING');
    expect(test.database.users.find((entry) => entry.id === 'target').authorizationVersion).toBe(1);
  });

  test('fails closed when an admitted Project creation commits after the manifest snapshot', async () => {
    const test = harness();
    test.setOnDrain(() => {
      test.database.identities.push(project({
        id: 'project-2',
        projectName: 'beta',
        canonicalRoot: '/srv/projects/beta',
        rootInode: '44',
      }));
    });

    await expect(test.coordinator.updateUserAuthorization({
      initiatedByUserId: 'owner',
      targetUserId: 'target',
      update: { sandboxEnabled: true },
    })).rejects.toMatchObject({ code: PROJECT_AUTHORIZATION_TRANSITION_DRIFT_CODE });
    expect(test.database.transitions[0].phase).toBe('QUIESCING');
    expect(test.database.users.find((entry) => entry.id === 'target').authorizationVersion).toBe(1);
  });

  test('rejects a different concurrent transition and resumes an identical retry', async () => {
    const test = harness();
    test.setFailCleanup(true);
    const first = {
      initiatedByUserId: 'owner',
      targetUserId: 'target',
      update: { sandboxEnabled: true },
    } as const;
    await expect(test.coordinator.updateUserAuthorization(first)).rejects.toThrow();
    await expect(test.coordinator.updateUserAuthorization({
      initiatedByUserId: 'owner',
      targetUserId: 'third',
      update: { sandboxEnabled: true },
    })).rejects.toMatchObject({ code: PROJECT_AUTHORIZATION_TRANSITION_ACTIVE_CODE });
    expect(test.database.transitions).toHaveLength(1);

    test.setFailCleanup(false);
    await expect(test.coordinator.updateUserAuthorization(first)).resolves.toMatchObject({
      user: { id: 'target', authorizationVersion: 2 },
    });
    expect(test.database.transitions).toHaveLength(1);
  });

  test('applies a profile-only change without provider teardown', async () => {
    const test = harness();
    const result = await test.coordinator.updateUserAuthorization({
      initiatedByUserId: 'owner',
      targetUserId: 'target',
      update: { firstName: 'Taylor' },
    });
    expect(result.user.firstName).toBe('Taylor');
    expect(result.user.authorizationVersion).toBe(1);
    expect(test.database.transitions).toHaveLength(0);
    expect(test.events).not.toContain('gateway:stopped');
  });

  test('transfers ownership and advances every extant generation once', async () => {
    const database = new FakeDatabase().initialize();
    database.sessions.push({ id: 'session-1', userId: 'target' });
    database.challenges.push({ id: 'challenge-1', userId: 'target' });
    database.emailCodes.push({ id: 'email-code-1', userId: 'target' });
    database.passwordResets.push({ id: 'reset-1', userId: 'target', usedAt: null });
    const test = harness(database);
    const result = await test.coordinator.transferOwnership({
      sourceOwnerUserId: 'owner',
      targetUserId: 'target',
      confirmation: confirmationForOwnershipTransfer('target@example.com'),
    });
    expect(test.database.users.find((entry) => entry.id === 'owner')).toMatchObject({
      role: 'SUB_ADMIN',
      authorizationVersion: 2,
    });
    expect(test.database.users.find((entry) => entry.id === 'target')).toMatchObject({
      role: 'OWNER',
      authorizationVersion: 2,
    });
    expect(test.database.users.find((entry) => entry.id === 'third').authorizationVersion).toBe(2);
    expect(result.changedAuthorizations).toHaveLength(3);
    expect(test.published).toHaveLength(3);
    expect(test.events).toContain('openclaw:quiesced:owner,target,third');
    expect(database.sessions).toHaveLength(1);
    expect(database.challenges).toHaveLength(1);
    expect(database.emailCodes).toHaveLength(1);
    expect(database.passwordResets).toEqual([
      { id: 'reset-1', userId: 'target', usedAt: null },
    ]);
  });
});
