import {
  detachLegacyOpenClawAgentRegistration,
  LegacyOpenClawAgentDetachError,
  listLegacyOpenClawAgentRegistrations,
} from './legacyOpenClawAgentDetach';

const openClawHome = '/srv/openclaw-test';

function legacyAgent(agentId = 'portal-1234abcd-project_one', binds: string[] = []) {
  return {
    id: agentId,
    workspace: `${openClawHome}/sandboxes/${agentId}-workspace`,
    sandbox: {
      mode: 'all',
      scope: 'session',
      docker: {
        image: 'openclaw-sandbox:bookworm-slim',
        network: 'bridge',
        dangerouslyAllowExternalBindSources: true,
        binds,
      },
    },
    tools: { deny: ['message'] },
  };
}

function persistedAgentEntries(agents: Record<string, any>[]) {
  return Object.fromEntries(agents.map((agent) => {
    const { id, ...entry } = agent;
    return [id, entry];
  }));
}

function rpcSnapshot(agents: unknown[], hash: string) {
  return {
    ok: true,
    data: {
      config: {
        agents: { ownership: 'explicit', entries: persistedAgentEntries(agents as Record<string, any>[]) },
        gateway: { mode: 'local' },
      },
      hash,
    },
  };
}

function legacyRpcSnapshot(agents: Record<string, any>[], hash: string) {
  return {
    ok: true,
    data: {
      config: { agents: { list: agents }, gateway: { mode: 'local' } },
      hash,
    },
  };
}

describe('legacy OpenClaw agent operator detach', () => {
  const originalOpenClawHome = process.env.OPENCLAW_HOME;

  beforeAll(() => {
    process.env.OPENCLAW_HOME = openClawHome;
  });

  afterAll(() => {
    if (originalOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalOpenClawHome;
  });

  test('lists stale bind-less registrations without making bound or ambiguous entries detachable', async () => {
    const stale = legacyAgent();
    const bound = legacyAgent('portal-1234abcd-bound_project', [
      '/portal/projects/user/project:/home/user/project:rw',
    ]);
    const ambiguous = { ...legacyAgent('portal-1234abcd-ambiguous'), workspace: '/tmp/not-owned' };
    const malformedId = legacyAgent('portal-not-a-retired-id');
    const rpc = jest.fn().mockResolvedValue(rpcSnapshot([
      { id: 'main' }, stale, bound, ambiguous, malformedId,
    ], 'hash-one'));

    const result = await listLegacyOpenClawAgentRegistrations({ rpc });

    expect(result.configHash).toBe('hash-one');
    expect(result.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: stale.id, state: 'STALE_BINDLESS', detachable: true, bindCount: 0 }),
      expect.objectContaining({ agentId: bound.id, state: 'BOUND', detachable: false, bindCount: 1 }),
      expect.objectContaining({ agentId: ambiguous.id, state: 'AMBIGUOUS', detachable: false }),
      expect.objectContaining({ agentId: malformedId.id, state: 'AMBIGUOUS', detachable: false }),
    ]));
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test('detaches only the exact stale row, preserves every other row, and records encrypted rollback evidence', async () => {
    const main = { id: 'main', default: true };
    const stale = legacyAgent();
    const parity = { id: 'parity', model: 'anthropic/example' };
    const listRpc = jest.fn().mockResolvedValue(rpcSnapshot([main, stale, parity], 'before-hash'));
    const listed = await listLegacyOpenClawAgentRegistrations({ rpc: listRpc });
    const fingerprint = listed.agents.find((entry) => entry.agentId === stale.id)!.fingerprint;
    const rpc = jest.fn()
      .mockResolvedValueOnce(rpcSnapshot([main, stale, parity], 'before-hash'))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(rpcSnapshot([main, parity], 'after-hash'));
    const createReceipt = jest.fn().mockResolvedValue({ id: 'receipt-1' });
    const updateReceipt = jest.fn().mockResolvedValue(undefined);

    const result = await detachLegacyOpenClawAgentRegistration({
      actorUserId: 'actor-1',
      agentId: stale.id,
      expectedFingerprint: fingerprint,
      confirmation: `DETACH ${stale.id}`,
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    }, {
      rpc,
      seal: (value) => `sealed:${Buffer.from(value).toString('base64url')}`,
      createReceipt,
      updateReceipt,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      agentId: stale.id,
      receiptId: 'receipt-1',
      transcriptsPreserved: true,
      workspacePreserved: true,
    }));
    expect(rpc).toHaveBeenNthCalledWith(2, 'config.patch', {
      raw: JSON.stringify({ agents: { entries: { [stale.id]: null } } }),
      baseHash: 'before-hash',
      replacePaths: expect.arrayContaining([
        `agents.entries.${stale.id}.sandbox.docker.binds`,
        `agents.entries.${stale.id}.tools.deny`,
      ]),
    }, 15_000);
    expect(createReceipt).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'actor-1',
      agentId: stale.id,
      metadata: expect.objectContaining({
        schemaVersion: 2,
        state: 'PREPARED',
        originalIndex: 1,
        originalEntryKey: stale.id,
        transcriptDirectoriesDeleted: false,
        workspaceDirectoriesDeleted: false,
        removedAgentCiphertext: expect.stringMatching(/^sealed:/),
      }),
    }));
    expect(updateReceipt).toHaveBeenLastCalledWith('receipt-1', expect.objectContaining({
      state: 'DETACHED',
      configHashAfter: 'after-hash',
    }), 'WARNING');
  });

  test('detaches the same registration through the retained 2026.7.1 list contract', async () => {
    const main = { id: 'main', default: true };
    const stale = legacyAgent();
    const parity = { id: 'parity', model: 'anthropic/example' };
    const listed = await listLegacyOpenClawAgentRegistrations({
      rpc: jest.fn().mockResolvedValue(legacyRpcSnapshot([main, stale, parity], 'listed')),
    });
    const fingerprint = listed.agents.find((entry) => entry.agentId === stale.id)!.fingerprint;
    const rpc = jest.fn()
      .mockResolvedValueOnce(legacyRpcSnapshot([main, stale, parity], 'before'))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(legacyRpcSnapshot([main, parity], 'after'));
    const createReceipt = jest.fn().mockResolvedValue({ id: 'legacy-receipt' });

    await expect(detachLegacyOpenClawAgentRegistration({
      actorUserId: 'actor-1',
      agentId: stale.id,
      expectedFingerprint: fingerprint,
      confirmation: `DETACH ${stale.id}`,
    }, {
      rpc,
      seal: (value) => `sealed:${value}`,
      createReceipt,
      updateReceipt: jest.fn().mockResolvedValue(undefined),
    })).resolves.toEqual(expect.objectContaining({ ok: true, agentId: stale.id }));

    expect(rpc).toHaveBeenNthCalledWith(2, 'config.patch', {
      raw: JSON.stringify({ agents: { list: [main, parity] } }),
      baseHash: 'before',
      replacePaths: ['agents.list'],
    }, 15_000);
    expect(createReceipt).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        schemaVersion: 2,
        rosterStorage: 'list',
        originalIndex: 1,
      }),
    }));
  });

  test.each([
    ['bound', legacyAgent('portal-1234abcd-bound', ['/portal/projects/u/p:/home/user/project:rw'])],
    ['ambiguous', { ...legacyAgent(), workspace: '/tmp/operator-controlled' }],
  ])('refuses a %s registration without creating a receipt', async (_label, candidate) => {
    const rpc = jest.fn().mockResolvedValue(rpcSnapshot([{ id: 'main' }, candidate], 'before'));
    const listed = await listLegacyOpenClawAgentRegistrations({ rpc });
    const registration = listed.agents.find((entry) => entry.agentId === candidate.id)!;
    const createReceipt = jest.fn();

    await expect(detachLegacyOpenClawAgentRegistration({
      actorUserId: 'actor-1',
      agentId: candidate.id,
      expectedFingerprint: registration.fingerprint,
      confirmation: `DETACH ${candidate.id}`,
    }, { rpc, createReceipt })).rejects.toMatchObject<Partial<LegacyOpenClawAgentDetachError>>({
      code: 'AGENT_NOT_DETACHABLE',
    });
    expect(createReceipt).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  test('refuses stale inventory after its fingerprint changes', async () => {
    const stale = legacyAgent();
    const rpc = jest.fn().mockResolvedValue(rpcSnapshot([stale], 'before'));
    const createReceipt = jest.fn();

    await expect(detachLegacyOpenClawAgentRegistration({
      actorUserId: 'actor-1',
      agentId: stale.id,
      expectedFingerprint: '0'.repeat(64),
      confirmation: `DETACH ${stale.id}`,
    }, { rpc, createReceipt })).rejects.toMatchObject<Partial<LegacyOpenClawAgentDetachError>>({
      code: 'AGENT_CHANGED',
    });
    expect(createReceipt).not.toHaveBeenCalled();
  });

  test('retains a prepared receipt and fails closed when readback differs', async () => {
    const stale = legacyAgent();
    const main = { id: 'main' };
    const listRpc = jest.fn().mockResolvedValue(rpcSnapshot([main, stale], 'listed'));
    const listed = await listLegacyOpenClawAgentRegistrations({ rpc: listRpc });
    const rpc = jest.fn()
      .mockResolvedValueOnce(rpcSnapshot([main, stale], 'before'))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(rpcSnapshot([{ id: 'unexpected' }], 'after'));
    const updateReceipt = jest.fn().mockResolvedValue(undefined);

    await expect(detachLegacyOpenClawAgentRegistration({
      actorUserId: 'actor-1',
      agentId: stale.id,
      expectedFingerprint: listed.agents[0].fingerprint,
      confirmation: `DETACH ${stale.id}`,
    }, {
      rpc,
      seal: (value) => value,
      createReceipt: async () => ({ id: 'receipt-2' }),
      updateReceipt,
    })).rejects.toMatchObject<Partial<LegacyOpenClawAgentDetachError>>({
      code: 'VERIFY_FAILED',
    });
    expect(updateReceipt).toHaveBeenLastCalledWith('receipt-2', expect.objectContaining({
      state: 'VERIFY_FAILED',
    }), 'ERROR');
  });

  test('implementation never invokes agents.delete or a filesystem removal primitive', () => {
    const source = require('fs').readFileSync(require.resolve('./legacyOpenClawAgentDetach'), 'utf8');
    expect(source).not.toContain("'agents.delete'");
    expect(source).not.toMatch(/\b(?:rmSync|unlinkSync|rmdirSync)\b/u);
  });
});
