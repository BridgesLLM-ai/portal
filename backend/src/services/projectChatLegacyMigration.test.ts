import {
  attestLegacyOpenClawProjectSessionKeys,
  migrateLegacyProjectChatState,
} from './projectChatLegacyMigration';

function databaseFixture(input: {
  legacy?: any[];
  current?: Record<string, any>;
  migrationStatus?: string;
  leasePhase?: string | null;
  leaseExpiresAt?: Date;
} = {}) {
  const calls: Array<{ operation: string; args: any }> = [];
  const current = input.current || {};
  const tx = {
    projectIdentity: {
      findUnique: jest.fn(async () => ({
        legacyOpenClawMigrationStatus: input.migrationStatus || 'NONE',
      })),
    },
    legacyOpenClawProjectMigrationLease: {
      findUnique: jest.fn(async () => (
        input.leasePhase ? {
          phase: input.leasePhase,
          leaseExpiresAt: input.leaseExpiresAt || new Date(Date.now() + 60_000),
        } : null
      )),
    },
    projectChatProviderBinding: {
      findMany: jest.fn(async () => input.legacy || []),
      findUnique: jest.fn(async (args: any) => current[args.where.userId_projectId_provider.provider] || null),
      update: jest.fn(async (args: any) => { calls.push({ operation: 'binding.update', args }); }),
      delete: jest.fn(async (args: any) => { calls.push({ operation: 'binding.delete', args }); }),
    },
    projectChatSession: {
      updateMany: jest.fn(async (args: any) => { calls.push({ operation: 'session.updateMany', args }); }),
    },
    projectChatMessage: {
      updateMany: jest.fn(async (args: any) => { calls.push({ operation: 'message.updateMany', args }); }),
    },
  };
  return {
    calls,
    tx,
    database: { $transaction: jest.fn(async (callback: any) => callback(tx)) },
  };
}

describe('legacy Project Chat identity migration', () => {
  test('attests only actor-bound 3.x OpenClaw session identities for destructive reset', () => {
    const actor = 'actor-1234-legacy';
    const sessionId = `portal-${actor}-my_project-abc123`;
    const agentId = `portal-${actor.slice(0, 8)}-my_project-abc123`.slice(0, 64);
    expect(attestLegacyOpenClawProjectSessionKeys({
      actorUserId: actor,
      storedSessionIds: [sessionId],
      storedBindingSessionKeys: [`agent:${agentId}:${sessionId}`],
      exactServerOwnedSessionKeys: ['agent:p4oc-current:portal-project'],
      adapterOwnedSessionKeys: ['agent:p4oc-current:portal-project'],
    })).toEqual([
      `agent:${agentId}:${sessionId}`,
      `agent:portal:${sessionId}`,
    ].sort());
  });

  test('rejects a legacy binding that could target another actor session', () => {
    expect(() => attestLegacyOpenClawProjectSessionKeys({
      actorUserId: 'authenticated-actor',
      storedSessionIds: [],
      storedBindingSessionKeys: [
        'agent:portal-attacker-other:portal-attacker-other-foreign-project',
      ],
      exactServerOwnedSessionKeys: ['agent:p4oc-current:portal-project'],
    })).toThrow(/authenticated 3\.x actor identity/i);
  });

  test('moves actor bindings/sessions but leaves ambiguous 3.x SQL messages non-visible', async () => {
    const fixture = databaseFixture({
      legacy: [{
        id: 'legacy-binding', provider: 'OPENCLAW', sessionKey: 'old-session', externalSessionId: null,
        model: 'model', status: 'active', lastActivity: new Date('2026-07-01T00:00:00Z'),
      }],
    });
    await migrateLegacyProjectChatState({
      actorUserId: 'sub-admin-actor',
      legacyProjectId: 'shared-project',
      immutableProjectId: 'immutable-project-uuid',
    }, fixture.database as any);

    expect(fixture.tx.projectChatProviderBinding.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'sub-admin-actor', projectId: 'shared-project' },
    }));
    expect(fixture.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'binding.update', args: expect.objectContaining({
        where: { id: 'legacy-binding' },
        data: { projectId: 'immutable-project-uuid' },
      }) }),
      expect.objectContaining({ operation: 'session.updateMany', args: expect.objectContaining({
        where: { userId: 'sub-admin-actor', projectId: 'shared-project' },
      }) }),
    ]));
    expect(fixture.calls.some((entry) => entry.operation === 'message.updateMany')).toBe(false);
  });

  test('merges a duplicate provider binding without overwriting current session provenance', async () => {
    const fixture = databaseFixture({
      legacy: [{
        id: 'legacy-binding', provider: 'CODEX', sessionKey: 'legacy-session', externalSessionId: 'legacy-ext',
        model: 'legacy-model', status: 'active', lastActivity: new Date('2026-07-02T00:00:00Z'),
      }],
      current: {
        CODEX: {
          id: 'current-binding', projectId: 'immutable-project-uuid', sessionKey: 'current-session',
          externalSessionId: 'current-ext', model: 'current-model', status: 'active',
          lastActivity: new Date('2026-07-03T00:00:00Z'),
        },
      },
    });
    await migrateLegacyProjectChatState({
      actorUserId: 'actor', legacyProjectId: 'project-name', immutableProjectId: 'immutable-project-uuid',
    }, fixture.database as any);

    const merge = fixture.calls.find((entry) => entry.operation === 'binding.update');
    expect(merge?.args).toMatchObject({
      where: { id: 'current-binding' },
      data: {
        sessionKey: 'current-session',
        externalSessionId: 'current-ext',
        model: 'current-model',
      },
    });
    expect(fixture.calls).toContainEqual({ operation: 'binding.delete', args: { where: { id: 'legacy-binding' } } });
  });

  test('never adopts name-keyed 3.x state into a CURRENT Project identity', async () => {
    const fixture = databaseFixture({
      migrationStatus: 'CURRENT',
      leasePhase: 'DISCOVERING',
      legacy: [{
        id: 'preserved-binding', provider: 'OPENCLAW', sessionKey: 'preserved-session',
        externalSessionId: null, model: null, status: 'active', lastActivity: new Date(0),
      }],
    });

    await migrateLegacyProjectChatState({
      actorUserId: 'actor',
      legacyProjectId: 'reused-name',
      immutableProjectId: 'current-project-uuid',
    }, fixture.database as any);

    expect(fixture.tx.projectChatProviderBinding.findMany).not.toHaveBeenCalled();
    expect(fixture.tx.projectChatSession.updateMany).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
  });

  test.each([
    { migrationStatus: 'NONE', leasePhase: 'DISCOVERING', retryable: true },
    { migrationStatus: 'PENDING', leasePhase: null, retryable: true },
    {
      migrationStatus: 'NONE',
      leasePhase: 'DISCOVERING',
      leaseExpiresAt: new Date(0),
      retryable: false,
    },
  ])('blocks preserved legacy state before any binding or session mutation (%o)', async (state) => {
    const fixture = databaseFixture(state);

    await expect(migrateLegacyProjectChatState({
      actorUserId: 'actor',
      legacyProjectId: 'legacy-name',
      immutableProjectId: 'legacy-project-uuid',
    }, fixture.database as any)).rejects.toMatchObject({
      code: state.retryable
        ? 'LEGACY_OPENCLAW_PROJECT_MIGRATION_ACTIVE'
        : 'LEGACY_OPENCLAW_PROJECT_RETIREMENT_PENDING',
      retryable: state.retryable,
    });

    expect(fixture.tx.projectChatProviderBinding.findMany).not.toHaveBeenCalled();
    expect(fixture.tx.projectChatSession.updateMany).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
  });

  test('is a no-op when the stored id is already immutable', async () => {
    const fixture = databaseFixture();
    await migrateLegacyProjectChatState({
      actorUserId: 'actor', legacyProjectId: 'same', immutableProjectId: 'same',
    }, fixture.database as any);
    expect(fixture.database.$transaction).not.toHaveBeenCalled();
  });
});
