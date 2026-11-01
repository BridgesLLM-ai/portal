jest.mock('../config/openclaw', () => ({ getOpenClawWsUrl: () => 'ws://127.0.0.1:18789' }));
jest.mock('../utils/gatewayToken', () => ({ getGatewayToken: () => 'test-token', hasGatewayToken: () => true }));
jest.mock('../utils/openclawCli', () => ({ ensureOpenClawModelDeclaration: jest.fn() }));
jest.mock('../agents/providers/PersistentGatewayWs', () => ({
  isConnected: () => true,
  callGatewayRpc: jest.fn(),
}));

const PersistentGatewayWs = require('../agents/providers/PersistentGatewayWs') as {
  callGatewayRpc: jest.Mock;
};
const {
  deleteSession,
  probeSessionPurgeParameter,
} = require('./openclawGatewayRpc') as typeof import('./openclawGatewayRpc');

function gatewayError(code: string, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), {
    errorCode: code,
    errorMessage: message,
    errorDetails: details,
  });
}

// Mirrors stock 9.9/10.9: closed params schema, then the handler's first CAS
// check refuses a missing entry when expectedSessionId is set.
function stockGateway(acceptedParameters: readonly string[] = []) {
  const allowed = new Set([
    'key',
    'agentId',
    'deleteTranscript',
    'expectedSessionId',
    'expectedLifecycleRevision',
    'expectedSessionUpdatedAt',
    'emitLifecycleHooks',
    'archivedOnly',
    ...acceptedParameters,
  ]);
  const sessions = new Map<string, { sessionId: string; updatedAt: number }>([
    ['agent:main:retired-chat', { sessionId: 'transcript-1', updatedAt: 1700 }],
  ]);
  PersistentGatewayWs.callGatewayRpc.mockImplementation(async (method: string, params: any) => {
    if (method === 'sessions.describe') {
      const session = sessions.get(params.key);
      return { session: session ? { key: params.key, agentId: 'main', ...session } : null };
    }
    if (method !== 'sessions.delete') throw new Error(`unexpected method ${method}`);
    const unexpected = Object.keys(params).find((name) => !allowed.has(name));
    if (unexpected) {
      throw gatewayError(
        'INVALID_REQUEST',
        `invalid sessions.delete params: at root: unexpected property '${unexpected}'`,
      );
    }
    const entry = sessions.get(params.key);
    if (params.expectedSessionId && entry?.sessionId !== params.expectedSessionId) {
      throw gatewayError(
        'INVALID_REQUEST',
        `Session ${params.key} changed before deletion. Retry.`,
        { reason: 'session-lifecycle-changed' },
      );
    }
    sessions.delete(params.key);
    const purge = acceptedParameters.some((name) => params[name] === true);
    return {
      ok: true,
      key: params.key,
      deleted: Boolean(entry),
      archived: entry && !purge && params.deleteTranscript !== false
        ? [`/root/.openclaw/agents/main/sessions/${entry.sessionId}.jsonl.deleted.2026-10-30T00-00-00.000Z`]
        : [],
    };
  });
  return sessions;
}

describe('OC-PURGE sessions.delete capability probe', () => {
  beforeEach(() => {
    PersistentGatewayWs.callGatewayRpc.mockReset();
  });

  test('stock Gateway rejects every purge parameter through its closed schema', async () => {
    const sessions = stockGateway();
    for (const parameter of ['purgeTranscript', 'deleteTranscriptWithoutArchive'] as const) {
      await expect(probeSessionPurgeParameter(parameter, 'main')).resolves.toEqual({
        result: 'rejected',
        detail: 'closed sessions.delete params schema',
      });
    }
    expect(sessions.has('agent:main:retired-chat')).toBe(true);
  });

  test('probe uses a fresh random key and CAS guards that cannot match a real session', async () => {
    stockGateway(['purgeTranscript']);
    await expect(probeSessionPurgeParameter('purgeTranscript', 'main')).resolves.toMatchObject({
      result: 'accepted',
    });
    await probeSessionPurgeParameter('purgeTranscript', 'main');
    const calls = PersistentGatewayWs.callGatewayRpc.mock.calls.filter(([method]) => method === 'sessions.delete');
    expect(calls).toHaveLength(2);
    const [first, second] = calls.map(([, params]) => params);
    for (const params of [first, second]) {
      expect(params.key).toMatch(/^agent:main:bridgesllm-purge-probe-[0-9a-f-]{36}$/);
      expect(params.expectedSessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(params.expectedSessionUpdatedAt).toBe(0);
      expect(params.purgeTranscript).toBe(true);
      expect(params.deleteTranscript).toBeUndefined();
    }
    expect(first.key).not.toBe(second.key);
    expect(first.expectedSessionId).not.toBe(second.expectedSessionId);
  });

  test('a Gateway that answers not-found for the probe key is also accepting', async () => {
    PersistentGatewayWs.callGatewayRpc.mockResolvedValue({ ok: true, deleted: false, archived: [] });
    await expect(probeSessionPurgeParameter('purgeTranscript', 'main')).resolves.toMatchObject({
      result: 'accepted',
    });
  });

  test('unclassifiable answers are unknown, never a capability', async () => {
    PersistentGatewayWs.callGatewayRpc.mockRejectedValueOnce(gatewayError('UNAVAILABLE', 'gateway restarting'));
    await expect(probeSessionPurgeParameter('purgeTranscript', 'main')).resolves.toMatchObject({
      result: 'unknown',
    });
    PersistentGatewayWs.callGatewayRpc.mockRejectedValueOnce(gatewayError(
      'INVALID_REQUEST',
      "invalid sessions.delete params: at root: unexpected property 'somethingElse'",
    ));
    await expect(probeSessionPurgeParameter('purgeTranscript', 'main')).resolves.toMatchObject({
      result: 'unknown',
    });
    PersistentGatewayWs.callGatewayRpc.mockResolvedValueOnce({ ok: true, deleted: true, archived: [] });
    await expect(probeSessionPurgeParameter('purgeTranscript', 'main')).resolves.toMatchObject({
      result: 'unknown',
    });
    await expect(probeSessionPurgeParameter('notAParameter' as any, 'main')).resolves.toMatchObject({
      result: 'unknown',
    });
    await expect(probeSessionPurgeParameter('purgeTranscript', '../main')).resolves.toMatchObject({
      result: 'unknown',
    });
  });
});

describe('deleteSession transcript options', () => {
  beforeEach(() => {
    PersistentGatewayWs.callGatewayRpc.mockReset();
  });

  test('stock delete sends only stock parameters and reports the archive receipt', async () => {
    stockGateway();
    const result = await deleteSession('agent:main:retired-chat', {
      agentId: 'main',
      expectedSessionId: 'transcript-1',
      deleteTranscript: true,
    });
    expect(result).toEqual({
      ok: true,
      key: 'agent:main:retired-chat',
      deleted: true,
      archived: ['/root/.openclaw/agents/main/sessions/transcript-1.jsonl.deleted.2026-10-30T00-00-00.000Z'],
    });
    const [, params] = PersistentGatewayWs.callGatewayRpc.mock.calls.find(([method]) => method === 'sessions.delete')!;
    expect(params).toEqual({
      key: 'agent:main:retired-chat',
      agentId: 'main',
      expectedSessionId: 'transcript-1',
      expectedSessionUpdatedAt: 1700,
      deleteTranscript: true,
    });
  });

  test('a probed purge parameter is sent alone, without archive options', async () => {
    stockGateway(['purgeTranscript']);
    const result = await deleteSession('agent:main:retired-chat', {
      agentId: 'main',
      expectedSessionId: 'transcript-1',
      purgeParameter: 'purgeTranscript',
    });
    expect(result).toMatchObject({ ok: true, deleted: true, archived: [] });
    const [, params] = PersistentGatewayWs.callGatewayRpc.mock.calls.find(([method]) => method === 'sessions.delete')!;
    expect(params.purgeTranscript).toBe(true);
    expect(params).not.toHaveProperty('deleteTranscript');
    expect(params).not.toHaveProperty('deleteTranscriptWithoutArchive');
  });

  test('purge parameters cannot be combined with archive options or invented', async () => {
    stockGateway(['purgeTranscript']);
    await expect(deleteSession('agent:main:retired-chat', {
      agentId: 'main',
      purgeParameter: 'purgeTranscript',
      deleteTranscript: true,
    })).resolves.toMatchObject({ ok: false });
    await expect(deleteSession('agent:main:retired-chat', {
      agentId: 'main',
      purgeParameter: 'purgeTranscript',
      archivedOnly: false,
    })).resolves.toMatchObject({ ok: false });
    await expect(deleteSession('agent:main:retired-chat', {
      agentId: 'main',
      purgeParameter: 'hardDelete' as any,
    })).resolves.toMatchObject({ ok: false });
    expect(PersistentGatewayWs.callGatewayRpc).not.toHaveBeenCalled();
  });

  test('a stock Gateway refuses an unprobed purge parameter without deleting', async () => {
    const sessions = stockGateway();
    const result = await deleteSession('agent:main:retired-chat', {
      agentId: 'main',
      expectedSessionId: 'transcript-1',
      purgeParameter: 'deleteTranscriptWithoutArchive',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unexpected property 'deleteTranscriptWithoutArchive'/);
    expect(sessions.has('agent:main:retired-chat')).toBe(true);
  });
});
