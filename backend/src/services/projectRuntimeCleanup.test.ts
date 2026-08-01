import type { ProjectIdentityRecord } from './projectIdentity';
import {
  PROJECT_RUNTIME_CLEANUP_PROVIDERS,
  __projectRuntimeCleanupTest,
  cleanupProjectRuntime,
  unavailableProjectRuntimeCleanupAdapter,
  type ProjectEgressCleanupAdapter,
  type ProjectRuntimeCleanupAdapter,
  type ProjectRuntimeCleanupAdapterRegistry,
  type ProjectRuntimeCleanupBinding,
  type ProjectRuntimeCleanupProvider,
  type ProjectRuntimeCleanupRepository,
  type ProjectRuntimeCleanupSession,
  type ProjectRuntimeCleanupSnapshot,
  type ProjectRuntimeCleanupState,
  type ProjectRuntimeCleanupTurn,
  type ProjectRuntimeResource,
  type ProjectRuntimeResourceKind,
} from './projectRuntimeCleanup';

const IDENTITY: ProjectIdentityRecord = {
  id: 'de407c34-11bd-44ed-8c40-72c682e99295',
  workspaceOwnerId: 'owner-user-full-id',
  projectName: 'customer-portal',
  canonicalRoot: '/portal/projects/owner-user-full-id/customer-portal',
  rootDevice: '2049',
  rootInode: '901122',
  rootBirthtimeNs: '1777777777000000000',
  generation: 1,
  createdAt: new Date('2026-07-19T12:00:00.000Z'),
  updatedAt: new Date('2026-07-19T12:00:00.000Z'),
};

const INPUT = {
  authenticatedActorId: 'sub-admin-full-id',
  workspaceOwnerId: IDENTITY.workspaceOwnerId,
  projectIdentity: IDENTITY,
};

function cloneSnapshot(snapshot: ProjectRuntimeCleanupSnapshot): ProjectRuntimeCleanupSnapshot {
  return {
    bindings: snapshot.bindings.map((value) => ({ ...value })),
    sessions: snapshot.sessions.map((value) => ({ ...value })),
    states: snapshot.states.map((value) => ({ ...value })),
    activeTurns: snapshot.activeTurns.map((value) => ({ ...value })),
  };
}

class FakeRepository implements ProjectRuntimeCleanupRepository {
  snapshot: ProjectRuntimeCleanupSnapshot;
  cleanupEvidence = new Map<string, {
    provider: ProjectRuntimeCleanupProvider;
    actorUserId: string;
    sessionId: string;
  }>();
  get cleanupActorIds(): Set<string> {
    return new Set(Array.from(this.cleanupEvidence.values()).map((entry) => entry.actorUserId));
  }
  calls: string[] = [];
  loadCount = 0;
  injectTurnOnLoad: number | null = null;
  injectBindingOnLoad: number | null = null;
  injectStateOnLoad: number | null = null;

  constructor(snapshot: Partial<ProjectRuntimeCleanupSnapshot> = {}) {
    this.snapshot = {
      bindings: snapshot.bindings || [],
      sessions: snapshot.sessions || [],
      states: snapshot.states || [],
      activeTurns: snapshot.activeTurns || [],
    };
  }

  async loadSnapshot(projectIdentityId: string): Promise<ProjectRuntimeCleanupSnapshot> {
    this.calls.push('repository:load');
    this.loadCount += 1;
    if (projectIdentityId !== IDENTITY.id) throw new Error('wrong identity');
    if (this.injectTurnOnLoad === this.loadCount && this.snapshot.activeTurns.length === 0) {
      this.snapshot.activeTurns.push(turn({ id: 'raced-turn', actorUserId: 'racer-user' }));
    }
    if (this.injectBindingOnLoad === this.loadCount) {
      this.snapshot.bindings.push(binding({ id: 'raced-binding', userId: 'racer-user' }));
    }
    if (this.injectStateOnLoad === this.loadCount) {
      this.snapshot.states.push(state({ id: 'raced-state', actorUserId: 'racer-user' }));
    }
    return cloneSnapshot(this.snapshot);
  }

  async loadCleanupEvidence(projectIdentityId: string) {
    if (projectIdentityId !== IDENTITY.id) throw new Error('wrong identity');
    return Array.from(this.cleanupEvidence.values()).map((entry) => ({ ...entry }));
  }

  async recordCleanupActors(
    projectIdentityId: string,
    resources: readonly ProjectRuntimeResource[],
  ): Promise<void> {
    if (projectIdentityId !== IDENTITY.id) throw new Error('wrong identity');
    for (const resource of resources) {
      if (!resource.actorUserId || !resource.provider) continue;
      const actor = {
        provider: resource.provider,
        actorUserId: resource.actorUserId,
        sessionId: '',
      };
      this.cleanupEvidence.set(`${actor.provider}\0${actor.actorUserId}\0`, actor);
      const sessionId = resource.kind === 'AGENT_ZERO_SESSION'
        ? resource.id.slice('agent-zero-session:'.length)
        : resource.kind === 'NATIVE_SESSION'
          ? resource.id.slice('native-session:'.length)
          : '';
      if (sessionId) {
        this.cleanupEvidence.set(`${actor.provider}\0${actor.actorUserId}\0${sessionId}`, {
          ...actor,
          sessionId,
        });
      }
    }
  }

  async clearCleanupActors(projectIdentityId: string): Promise<void> {
    if (projectIdentityId !== IDENTITY.id) throw new Error('wrong identity');
    this.cleanupEvidence.clear();
  }

  async markBindingsCleanupPending(projectIdentityId: string, bindingIds: readonly string[]): Promise<void> {
    this.calls.push('repository:pending');
    for (const binding of this.snapshot.bindings) {
      if (binding.projectId === projectIdentityId && bindingIds.includes(binding.id)) {
        binding.status = __projectRuntimeCleanupTest.CLEANUP_PENDING_STATUS;
      }
    }
  }

  async beginTurnAbort(value: ProjectRuntimeCleanupTurn): Promise<ProjectRuntimeCleanupTurn> {
    this.calls.push(`repository:begin:${value.provider}:${value.id}`);
    const current = this.snapshot.activeTurns.find((candidate) => candidate.id === value.id);
    if (!current) throw new Error('turn missing');
    current.status = 'ABORTING';
    return { ...current };
  }

  async finishTurnAbort(
    value: ProjectRuntimeCleanupTurn,
    evidence: string,
    lifecycleReason: 'delete' | 'rename',
  ): Promise<void> {
    this.calls.push(`repository:finish:${value.provider}:${value.id}:${evidence}:${lifecycleReason}`);
    this.snapshot.activeTurns = this.snapshot.activeTurns.filter((candidate) => candidate.id !== value.id);
    for (const state of this.snapshot.states) {
      if (state.activeTurnId === value.id) state.activeTurnId = null;
    }
  }

  async markBindingsCleanupComplete(projectIdentityId: string, bindingIds: readonly string[]): Promise<void> {
    this.calls.push('repository:complete');
    for (const binding of this.snapshot.bindings) {
      if (binding.projectId === projectIdentityId && bindingIds.includes(binding.id)) {
        binding.status = __projectRuntimeCleanupTest.CLEANUP_COMPLETE_STATUS;
      }
    }
  }
}

interface MockProviderAdapter extends ProjectRuntimeCleanupAdapter {
  resources: ProjectRuntimeResource[];
  enumerate: jest.Mock;
  quiesceTurn: jest.Mock;
  cleanup: jest.Mock;
  verifyClean: jest.Mock;
}

interface MockEgressAdapter extends ProjectEgressCleanupAdapter {
  resources: ProjectRuntimeResource[];
  enumerate: jest.Mock;
  cleanup: jest.Mock;
  verifyClean: jest.Mock;
}

function binding(input: Partial<ProjectRuntimeCleanupBinding> = {}): ProjectRuntimeCleanupBinding {
  return {
    id: input.id || 'binding-openclaw',
    userId: input.userId || 'actor-one-full-id',
    projectId: input.projectId || IDENTITY.id,
    provider: input.provider || 'OPENCLAW',
    runtime: input.runtime || 'test-runtime',
    sessionKey: input.sessionKey ?? 'session-one',
    externalSessionId: input.externalSessionId ?? 'external-one',
    status: input.status || 'active',
  };
}

function session(input: Partial<ProjectRuntimeCleanupSession> = {}): ProjectRuntimeCleanupSession {
  return {
    id: input.id || 'session-row-one',
    userId: input.userId || 'actor-one-full-id',
    projectId: input.projectId || IDENTITY.id,
    sessionKey: input.sessionKey || 'session-key-one',
    activeProvider: input.activeProvider || 'OPENCLAW',
    runtime: input.runtime || 'test-runtime',
    status: input.status || 'active',
  };
}

function state(input: Partial<ProjectRuntimeCleanupState> = {}): ProjectRuntimeCleanupState {
  return {
    id: input.id || 'state-one',
    actorUserId: input.actorUserId || 'actor-one-full-id',
    projectIdentityId: input.projectIdentityId || IDENTITY.id,
    activeTurnId: input.activeTurnId ?? null,
  };
}

function turn(input: Partial<ProjectRuntimeCleanupTurn> = {}): ProjectRuntimeCleanupTurn {
  return {
    id: input.id || 'turn-one',
    stateId: input.stateId || 'state-one',
    actorUserId: input.actorUserId || 'actor-one-full-id',
    projectIdentityId: input.projectIdentityId || IDENTITY.id,
    provider: input.provider || 'OPENCLAW',
    runtime: input.runtime || 'test-runtime',
    requestId: input.requestId || 'user-turn-request',
    status: input.status || 'RUNNING',
    leaseExpiresAt: input.leaseExpiresAt || new Date('2099-01-01T00:00:00.000Z'),
    providerSessionId: input.providerSessionId ?? 'provider-session-one',
  };
}

function resource(
  provider: ProjectRuntimeCleanupProvider | null,
  kind: ProjectRuntimeResourceKind,
  id: string,
  input: Partial<ProjectRuntimeResource> = {},
): ProjectRuntimeResource {
  return {
    id,
    kind,
    projectIdentityId: input.projectIdentityId || IDENTITY.id,
    actorUserId: input.actorUserId === undefined ? 'actor-one-full-id' : input.actorUserId,
    provider,
  };
}

function createProviderAdapter(
  provider: ProjectRuntimeCleanupProvider,
  calls: string[],
): MockProviderAdapter {
  const adapter = {
    provider,
    resources: [] as ProjectRuntimeResource[],
    enumerate: jest.fn(async () => {
      calls.push(`${provider}:enumerate`);
      return [...adapter.resources];
    }),
    quiesceTurn: jest.fn(async (_scope, activeTurn: ProjectRuntimeCleanupTurn) => {
      calls.push(`${provider}:quiesce:${activeTurn.id}`);
      return { quiesced: true as const, evidence: `verified-${activeTurn.id}` };
    }),
    cleanup: jest.fn(async (_scope, resources: readonly ProjectRuntimeResource[]) => {
      calls.push(`${provider}:cleanup:${resources.length}`);
      const removed = new Set(resources.map((entry) => `${entry.kind}\u0000${entry.id}`));
      adapter.resources = adapter.resources.filter((entry) => !removed.has(`${entry.kind}\u0000${entry.id}`));
    }),
    verifyClean: jest.fn(async () => {
      calls.push(`${provider}:verify`);
      return [...adapter.resources];
    }),
  } satisfies MockProviderAdapter;
  return adapter;
}

function createFixture(snapshot: Partial<ProjectRuntimeCleanupSnapshot> = {}) {
  const calls: string[] = [];
  const repository = new FakeRepository(snapshot);
  const adapters = Object.fromEntries(
    PROJECT_RUNTIME_CLEANUP_PROVIDERS.map((provider) => [provider, createProviderAdapter(provider, calls)]),
  ) as unknown as Record<ProjectRuntimeCleanupProvider, MockProviderAdapter>;
  const egressAdapter = {
    resources: [] as ProjectRuntimeResource[],
    enumerate: jest.fn(async () => {
      calls.push('EGRESS:enumerate');
      return [...egressAdapter.resources];
    }),
    cleanup: jest.fn(async (_scope, resources: readonly ProjectRuntimeResource[]) => {
      calls.push(`EGRESS:cleanup:${resources.length}`);
      const removed = new Set(resources.map((entry) => `${entry.kind}\u0000${entry.id}`));
      egressAdapter.resources = egressAdapter.resources.filter((entry) => !removed.has(`${entry.kind}\u0000${entry.id}`));
    }),
    verifyClean: jest.fn(async () => {
      calls.push('EGRESS:verify');
      return [...egressAdapter.resources];
    }),
  } satisfies MockEgressAdapter;
  return {
    calls,
    repository,
    adapters,
    egressAdapter,
    options: {
      repository,
      adapters: adapters as unknown as ProjectRuntimeCleanupAdapterRegistry,
      egressAdapter,
    },
  };
}

describe('project runtime cleanup', () => {
  beforeEach(() => {
    __projectRuntimeCleanupTest.resetLocks();
  });

  it('quiesces every durable turn and removes all provider and egress resources in fail-closed order', async () => {
    const fixture = createFixture({
      bindings: [
        binding(),
        binding({ id: 'binding-codex', userId: 'actor-two-full-id', provider: 'CODEX' }),
        binding({ id: 'binding-a0', provider: 'AGENT_ZERO' }),
      ],
      sessions: [session({ userId: 'actor-three-full-id' })],
      states: [
        state({ activeTurnId: 'turn-openclaw' }),
        state({ id: 'state-two', actorUserId: 'actor-two-full-id', activeTurnId: 'turn-codex' }),
      ],
      activeTurns: [
        turn({ id: 'turn-openclaw' }),
        turn({ id: 'turn-codex', stateId: 'state-two', actorUserId: 'actor-two-full-id', provider: 'CODEX', status: 'ABORTING' }),
      ],
    });
    fixture.adapters.OPENCLAW.resources.push(
      resource('OPENCLAW', 'OPENCLAW_AGENT', 'agent-immutable'),
      resource('OPENCLAW', 'OPENCLAW_SESSION', 'session-immutable'),
      resource('OPENCLAW', 'OPENCLAW_CONTAINER', 'container-immutable'),
    );
    fixture.adapters.CODEX.resources.push(
      resource('CODEX', 'NATIVE_SESSION', 'codex-session'),
      resource('CODEX', 'NATIVE_RUN_BROKER', 'codex-broker'),
      resource('CODEX', 'NATIVE_RUNTIME_CONTAINER', 'codex-container'),
    );
    fixture.adapters.AGENT_ZERO.resources.push(
      resource('AGENT_ZERO', 'AGENT_ZERO_SESSION', 'a0-session'),
      resource('AGENT_ZERO', 'AGENT_ZERO_CONTAINER', 'a0-container'),
      resource('AGENT_ZERO', 'AGENT_ZERO_NETWORK', 'a0-network'),
      resource('AGENT_ZERO', 'AGENT_ZERO_VOLUME', 'a0-volume'),
      resource('AGENT_ZERO', 'AGENT_ZERO_CREDENTIAL', 'a0-credential'),
    );
    fixture.egressAdapter.resources.push(
      resource(null, 'EGRESS_PROXY_CONTAINER', 'proxy', { actorUserId: null }),
      resource(null, 'EGRESS_INTERNAL_NETWORK', 'internal', { actorUserId: null }),
      resource(null, 'EGRESS_PUBLIC_NETWORK', 'public', { actorUserId: null }),
      resource(null, 'EGRESS_FIREWALL_CHAIN', 'firewall', { actorUserId: null }),
    );

    const result = await cleanupProjectRuntime(INPUT, fixture.options);

    expect(result).toEqual({
      projectIdentityId: IDENTITY.id,
      actorCount: 5,
      bindingCount: 3,
      sessionCount: 1,
      quiescedTurnCount: 2,
      removedResourceCount: 15,
      alreadyClean: false,
    });
    expect(fixture.repository.snapshot.activeTurns).toEqual([]);
    expect(fixture.repository.snapshot.bindings.every(
      (entry) => entry.status === __projectRuntimeCleanupTest.CLEANUP_COMPLETE_STATUS,
    )).toBe(true);
    expect(fixture.adapters.OPENCLAW.quiesceTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectIdentity: expect.objectContaining({ id: IDENTITY.id }),
        knownActorIds: expect.arrayContaining([
          INPUT.authenticatedActorId,
          IDENTITY.workspaceOwnerId,
          'actor-one-full-id',
          'actor-two-full-id',
          'actor-three-full-id',
        ]),
      }),
      expect.objectContaining({ id: 'turn-openclaw', status: 'ABORTING' }),
    );
    const firstRoundLastProviderVerify = Math.max(
      ...PROJECT_RUNTIME_CLEANUP_PROVIDERS.map((provider) => fixture.calls.indexOf(`${provider}:verify`)),
    );
    expect(fixture.calls.indexOf('EGRESS:cleanup:4')).toBeGreaterThan(firstRoundLastProviderVerify);
    expect(fixture.repository.calls.at(-1)).toBe('repository:complete');
  });

  it('preflights all providers even when Portal has no bindings', async () => {
    const fixture = createFixture();

    const result = await cleanupProjectRuntime(INPUT, fixture.options);

    for (const provider of PROJECT_RUNTIME_CLEANUP_PROVIDERS) {
      expect(fixture.adapters[provider].enumerate).toHaveBeenCalledTimes(2);
      expect(fixture.adapters[provider].cleanup).toHaveBeenCalledWith(expect.anything(), []);
      expect(fixture.adapters[provider].verifyClean).toHaveBeenCalledTimes(2);
    }
    expect(fixture.egressAdapter.enumerate).toHaveBeenCalledTimes(2);
    expect(result.alreadyClean).toBe(true);
    expect(fixture.adapters.OPENCLAW.enumerate).toHaveBeenCalledWith(expect.objectContaining({
      knownActorIds: [IDENTITY.workspaceOwnerId, INPUT.authenticatedActorId].sort(),
    }));
  });

  it('scans server-attested candidate actors that have no Portal binding row', async () => {
    const fixture = createFixture();
    await cleanupProjectRuntime({
      ...INPUT,
      candidateActorIds: ['orphan-provider-actor', INPUT.authenticatedActorId],
      lifecycleReason: 'authorization_change',
    }, fixture.options);

    expect(fixture.adapters.OPENCLAW.enumerate).toHaveBeenCalledWith(expect.objectContaining({
      knownActorIds: [
        IDENTITY.workspaceOwnerId,
        INPUT.authenticatedActorId,
        'orphan-provider-actor',
      ].sort(),
    }));
  });

  it('does not quiesce or enumerate runtime while a live mutation admission owns the project CAS slot', async () => {
    const admission = turn({
      requestId: 'portal-runtime-admission:ensure-session:admission-uuid',
      leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    });
    const fixture = createFixture({
      states: [state({ activeTurnId: admission.id })],
      activeTurns: [admission],
    });

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).rejects.toMatchObject({
      code: 'TURN_STILL_ACTIVE',
      provider: 'OPENCLAW',
    });
    expect(fixture.adapters.OPENCLAW.enumerate).not.toHaveBeenCalled();
    expect(fixture.adapters.OPENCLAW.quiesceTurn).not.toHaveBeenCalled();
    expect(fixture.repository.calls).toEqual(['repository:load']);
  });

  it('rejects an identity that does not belong to the supplied workspace owner before touching adapters', async () => {
    const fixture = createFixture();

    await expect(cleanupProjectRuntime({
      ...INPUT,
      workspaceOwnerId: 'different-owner-full-id',
    }, fixture.options)).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });

    expect(fixture.repository.calls).toEqual([]);
    expect(fixture.adapters.OPENCLAW.enumerate).not.toHaveBeenCalled();
  });

  it('requires a complete provider registry and refuses partial cleanup', async () => {
    const fixture = createFixture();
    const partial = { ...fixture.adapters } as Record<string, ProjectRuntimeCleanupAdapter | undefined>;
    delete partial.AGENT_ZERO;

    await expect(cleanupProjectRuntime(INPUT, {
      ...fixture.options,
      adapters: partial as ProjectRuntimeCleanupAdapterRegistry,
    })).rejects.toMatchObject({ code: 'ADAPTER_MISSING', provider: 'AGENT_ZERO' });

    expect(fixture.repository.calls).toEqual([]);
  });

  it('fails before mutations when provider discovery is unavailable', async () => {
    const fixture = createFixture({ bindings: [binding()] });
    fixture.adapters.GEMINI.enumerate.mockRejectedValueOnce(new Error('docker unavailable'));

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).rejects.toMatchObject({
      code: 'ENUMERATION_FAILED',
      provider: 'GEMINI',
    });

    expect(fixture.repository.snapshot.bindings[0].status).toBe('active');
    expect(fixture.adapters.OPENCLAW.cleanup).not.toHaveBeenCalled();
  });

  it('rejects an external resource whose immutable project UUID does not match', async () => {
    const fixture = createFixture();
    fixture.adapters.OPENCLAW.resources.push(resource(
      'OPENCLAW',
      'OPENCLAW_CONTAINER',
      'foreign-container',
      { projectIdentityId: 'another-project-uuid' },
    ));

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).rejects.toMatchObject({
      code: 'RESOURCE_IDENTITY_MISMATCH',
      provider: 'OPENCLAW',
    });

    expect(fixture.adapters.OPENCLAW.cleanup).not.toHaveBeenCalled();
  });

  it('rejects a provider adapter that claims a resource kind outside its ownership boundary', async () => {
    const fixture = createFixture();
    fixture.adapters.CODEX.resources.push(resource(
      'CODEX',
      'OPENCLAW_CONTAINER',
      'misclassified-container',
    ));

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).rejects.toMatchObject({
      code: 'RESOURCE_IDENTITY_MISMATCH',
      provider: 'CODEX',
    });
  });

  it('fails closed on a stale active-turn pointer instead of discarding it', async () => {
    const fixture = createFixture({
      states: [state({ activeTurnId: 'missing-turn' })],
    });

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).rejects.toMatchObject({
      code: 'TURN_STILL_ACTIVE',
    });

    expect(fixture.adapters.OPENCLAW.enumerate).not.toHaveBeenCalled();
  });

  it('rejects deletion when one durable turn cannot be quiesced', async () => {
    const fixture = createFixture({
      bindings: [binding()],
      states: [state({ activeTurnId: 'turn-one' })],
      activeTurns: [turn()],
    });
    fixture.adapters.OPENCLAW.quiesceTurn.mockRejectedValueOnce(new Error('abort probe timed out'));

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).rejects.toMatchObject({
      code: 'TURN_ABORT_FAILED',
      provider: 'OPENCLAW',
    });

    expect(fixture.repository.snapshot.activeTurns[0].status).toBe('ABORTING');
    for (const provider of PROJECT_RUNTIME_CLEANUP_PROVIDERS) {
      expect(fixture.adapters[provider].cleanup).not.toHaveBeenCalled();
    }
    expect(fixture.egressAdapter.cleanup).not.toHaveBeenCalled();
  });

  it('uses the turn provider adapter even when the binding row is missing', async () => {
    const fixture = createFixture({
      states: [state({ actorUserId: 'orphan-actor', activeTurnId: 'orphan-turn' })],
      activeTurns: [turn({
        id: 'orphan-turn',
        actorUserId: 'orphan-actor',
        provider: 'AGENT_ZERO',
      })],
    });

    const result = await cleanupProjectRuntime(INPUT, fixture.options);

    expect(fixture.adapters.AGENT_ZERO.quiesceTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'orphan-turn', projectIdentityId: IDENTITY.id }),
    );
    expect(result.quiescedTurnCount).toBe(1);
  });

  it('records rename-specific abort semantics instead of deletion history', async () => {
    const fixture = createFixture({
      states: [state({ activeTurnId: 'rename-turn' })],
      activeTurns: [turn({ id: 'rename-turn' })],
    });

    await cleanupProjectRuntime({ ...INPUT, lifecycleReason: 'rename' }, fixture.options);

    expect(fixture.repository.calls).toContain(
      'repository:finish:OPENCLAW:rename-turn:verified-rename-turn:rename',
    );
  });

  it('leaves bindings pending and rejects when verification finds residual resources', async () => {
    const fixture = createFixture({ bindings: [binding()] });
    fixture.adapters.CODEX.resources.push(resource('CODEX', 'NATIVE_SESSION', 'stubborn-session'));
    fixture.adapters.CODEX.cleanup.mockImplementationOnce(async () => undefined);

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).rejects.toMatchObject({
      code: 'RESIDUAL_RESOURCE',
      provider: 'CODEX',
    });

    expect(fixture.repository.snapshot.bindings[0].status)
      .toBe(__projectRuntimeCleanupTest.CLEANUP_PENDING_STATUS);
    expect(fixture.repository.calls).not.toContain('repository:complete');
    expect(fixture.egressAdapter.cleanup).not.toHaveBeenCalled();
  });

  it('is restart-safe: a retry resumes pending cleanup after a provider failure', async () => {
    const fixture = createFixture({
      bindings: [binding()],
      states: [state({ activeTurnId: 'turn-one' })],
      activeTurns: [turn()],
    });
    fixture.adapters.OPENCLAW.resources.push(resource('OPENCLAW', 'OPENCLAW_CONTAINER', 'runtime-one'));
    fixture.adapters.OPENCLAW.cleanup.mockRejectedValueOnce(new Error('docker daemon restarted'));

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).rejects.toMatchObject({
      code: 'CLEANUP_FAILED',
      provider: 'OPENCLAW',
    });
    expect(fixture.repository.snapshot.activeTurns).toEqual([]);
    expect(fixture.repository.snapshot.bindings[0].status)
      .toBe(__projectRuntimeCleanupTest.CLEANUP_PENDING_STATUS);

    const retry = await cleanupProjectRuntime(INPUT, fixture.options);

    expect(retry.quiescedTurnCount).toBe(0);
    expect(fixture.repository.snapshot.bindings[0].status)
      .toBe(__projectRuntimeCleanupTest.CLEANUP_COMPLETE_STATUS);
    expect(fixture.adapters.OPENCLAW.cleanup).toHaveBeenCalledTimes(2);
  });

  it('journals a resource-only actor across the post-deletion convergence crash window', async () => {
    const fixture = createFixture();
    const resourceOnlyActor = 'resource-only-actor-full-id';
    fixture.adapters.OLLAMA.resources.push(
      resource('OLLAMA', 'NATIVE_SESSION', 'native-session:resource-only-session', {
        actorUserId: resourceOnlyActor,
      }),
      resource('OLLAMA', 'NATIVE_RUNTIME_CONTAINER', 'resource-only-container', {
        actorUserId: resourceOnlyActor,
      }),
    );
    fixture.adapters.OLLAMA.cleanup
      .mockImplementationOnce(async () => {
        fixture.adapters.OLLAMA.resources = [];
        throw new Error('process crashed after external runtime deletion');
      })
      .mockImplementationOnce(async (scope, resources) => {
        expect(resources).toEqual([]);
        expect(scope.knownActorIds).toContain(resourceOnlyActor);
        expect(scope.cleanupSessionEvidence).toContainEqual({
          provider: 'OLLAMA',
          actorUserId: resourceOnlyActor,
          sessionId: 'resource-only-session',
        });
      });

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).rejects.toMatchObject({
      code: 'CLEANUP_FAILED',
      provider: 'OLLAMA',
    });
    expect(fixture.repository.cleanupActorIds).toContain(resourceOnlyActor);

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).resolves.toMatchObject({
      projectIdentityId: IDENTITY.id,
    });
    expect(fixture.repository.cleanupActorIds.size).toBe(0);
  });

  it('rechecks durable state and rejects a turn that races cleanup completion', async () => {
    const fixture = createFixture({ bindings: [binding()] });
    fixture.repository.injectTurnOnLoad = 3;

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).rejects.toMatchObject({
      code: 'TURN_STILL_ACTIVE',
    });

    expect(fixture.repository.calls).not.toContain('repository:complete');
  });

  it('rejects a new actor binding that races cleanup completion', async () => {
    const fixture = createFixture({ bindings: [binding()] });
    fixture.repository.injectBindingOnLoad = 3;

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).rejects.toMatchObject({
      code: 'TURN_STILL_ACTIVE',
    });

    expect(fixture.repository.calls).not.toContain('repository:complete');
  });

  it('rejects a new coordination state that races cleanup completion', async () => {
    const fixture = createFixture();
    fixture.repository.injectStateOnLoad = 3;

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).rejects.toMatchObject({
      code: 'TURN_STILL_ACTIVE',
    });

    expect(fixture.repository.calls).not.toContain('repository:complete');
  });

  it('removes project egress only after every provider verifies clean', async () => {
    const fixture = createFixture();
    fixture.egressAdapter.resources.push(resource(null, 'EGRESS_PROXY_CONTAINER', 'egress-proxy', {
      actorUserId: null,
    }));
    fixture.adapters.OLLAMA.verifyClean.mockRejectedValueOnce(new Error('provider inspect failed'));

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).rejects.toMatchObject({
      code: 'CLEANUP_FAILED',
      provider: 'OLLAMA',
    });

    expect(fixture.egressAdapter.cleanup).not.toHaveBeenCalled();
  });

  it('fails closed when the egress verification API is unavailable', async () => {
    const fixture = createFixture({ bindings: [binding()] });
    fixture.egressAdapter.verifyClean.mockRejectedValueOnce(new Error('iptables unavailable'));

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).rejects.toMatchObject({
      code: 'CLEANUP_FAILED',
      provider: 'EGRESS',
    });

    expect(fixture.repository.calls).not.toContain('repository:complete');
  });

  it('serializes concurrent cleanup calls for one immutable project UUID', async () => {
    const fixture = createFixture();
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    fixture.adapters.OPENCLAW.cleanup.mockImplementationOnce(async () => cleanupGate);

    const first = cleanupProjectRuntime(INPUT, fixture.options);
    while (fixture.adapters.OPENCLAW.cleanup.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const second = cleanupProjectRuntime(INPUT, fixture.options);
    await new Promise((resolve) => setImmediate(resolve));

    expect(fixture.adapters.OPENCLAW.enumerate).toHaveBeenCalledTimes(2);
    releaseCleanup();
    await Promise.all([first, second]);
    expect(fixture.adapters.OPENCLAW.enumerate).toHaveBeenCalledTimes(4);
  });

  it('provides an explicit unavailable adapter that never fabricates cleanup success', async () => {
    const fixture = createFixture();
    fixture.adapters.CLAUDE_CODE = unavailableProjectRuntimeCleanupAdapter(
      'CLAUDE_CODE',
      'real project launcher cleanup is not wired',
    ) as MockProviderAdapter;

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).rejects.toMatchObject({
      code: 'ENUMERATION_FAILED',
      provider: 'CLAUDE_CODE',
    });
  });

  it('accepts the persisted GROK alias only as the GROK_BUILD cleanup provider', async () => {
    const fixture = createFixture({
      bindings: [binding({ provider: 'GROK' })],
      sessions: [session({ activeProvider: 'GROK' })],
    });

    await expect(cleanupProjectRuntime(INPUT, fixture.options)).resolves.toMatchObject({
      bindingCount: 1,
      sessionCount: 1,
    });
    expect(fixture.adapters.GROK_BUILD.enumerate).toHaveBeenCalledTimes(2);
  });
});
