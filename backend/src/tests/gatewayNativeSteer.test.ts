import {
  ACTIVE_RUN_STEER_GATEWAY_METHOD,
  nativeSteerIdempotencyKey,
  PendingUserInputAnswerError,
  steerSessionMessageWithRpc,
  steerWithNativeChatSendWithRpc,
} from '../agents/providers/PersistentGatewayWs';
import { portalClientMessageIdFromIdempotencyKey } from '../agents/providers/PortalMessageIdentity';

const sessionKey = 'agent:main:portal-steer-chat';
const withPlugin = ['chat.send', ACTIVE_RUN_STEER_GATEWAY_METHOD];
const stockOnly = ['chat.send'];

/** A fake gateway: answers the plugin method and chat.send, records every call. */
function fakeGateway(responses: {
  plugin?: Record<string, unknown>;
  chatSend?: Record<string, unknown>;
}) {
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  const rpc = jest.fn(async (method: string, params: Record<string, any>) => {
    calls.push({ method, params });
    if (method === ACTIVE_RUN_STEER_GATEWAY_METHOD) return responses.plugin;
    if (method === 'chat.send') return responses.chatSend;
    throw new Error(`unexpected method ${method}`);
  });
  return { rpc, calls };
}

describe('Agent Chat steering capability switch', () => {
  test('uses the exact-run plugin path wherever its runtime is present', async () => {
    const gateway = fakeGateway({
      plugin: { accepted: true, code: 'STEERED', requestId: 'steer-1', runId: 'run-a', replayed: false },
    });
    const native = fakeGateway({});
    const result = await steerSessionMessageWithRpc(
      gateway.rpc, native.rpc, withPlugin, sessionKey, 'run-a', 'Also check the logs.', 'steer-1',
    );
    expect(result).toEqual({
      mode: 'exact-run', interruptedActiveRun: false, replayed: false, requestId: 'steer-1', runId: 'run-a',
    });
    expect(gateway.calls.map((call) => call.method)).toEqual([ACTIVE_RUN_STEER_GATEWAY_METHOD]);
    expect(native.rpc).not.toHaveBeenCalled();
  });

  test('falls back to stock chat.send steering when the plugin reports its runtime unavailable', async () => {
    const gateway = fakeGateway({ plugin: { accepted: false, code: 'HOTFIX_UNAVAILABLE', requestId: 'steer-2' } });
    const native = fakeGateway({ chatSend: { runId: 'oc-run-new', status: 'started', messageSeq: 7 } });
    const result = await steerSessionMessageWithRpc(
      gateway.rpc, native.rpc, withPlugin, sessionKey, 'run-a', 'Also check the logs.', 'steer-2',
    );
    expect(result).toEqual({
      mode: 'native-steer', outcome: 'unconfirmed', interruptedActiveRun: false, replayed: false,
      requestId: 'steer-2', steerRunId: 'oc-run-new',
    });
    expect(result).not.toHaveProperty('runId');
    expect(native.calls).toEqual([{
      method: 'chat.send',
      params: {
        sessionKey,
        message: 'Also check the logs.',
        idempotencyKey: nativeSteerIdempotencyKey(sessionKey, 'steer-2'),
        deliver: false,
        queueMode: 'steer',
        // No command authority was passed: the text is plain.
        suppressCommandInterpretation: true,
      },
    }]);
    // Never pretend to target a run: chat.send does not assert this for steer.
    expect(native.calls[0].params).not.toHaveProperty('expectedLeafEntryId');
    expect(native.calls[0].params).not.toHaveProperty('expectedRunId');
  });

  test('goes straight to chat.send steering when the gateway does not advertise the plugin method', async () => {
    const gateway = fakeGateway({});
    const native = fakeGateway({ chatSend: { runId: 'oc-run-new', status: 'started' } });
    const result = await steerSessionMessageWithRpc(
      gateway.rpc, native.rpc, stockOnly, sessionKey, 'run-a', 'Use the staging data.', 'steer-3',
    );
    expect(result.mode).toBe('native-steer');
    expect(gateway.rpc).not.toHaveBeenCalled();
    expect(native.calls.map((call) => call.params.queueMode)).toEqual(['steer']);
  });

  test.each(['NO_ACTIVE_RUN', 'RUN_MISMATCH', 'RUNTIME_REJECTED'])(
    'keeps the plugin refusal %s instead of resending through chat.send',
    async (code) => {
      const gateway = fakeGateway({ plugin: { accepted: false, code, requestId: 'steer-4' } });
      const native = fakeGateway({ chatSend: { runId: 'oc-run-new', status: 'started' } });
      await expect(steerSessionMessageWithRpc(
        gateway.rpc, native.rpc, withPlugin, sessionKey, 'run-a', 'Stop after this file.', 'steer-4',
      )).rejects.toMatchObject({ code });
      expect(native.rpc).not.toHaveBeenCalled();
    },
  );
});

describe('stock chat.send steering', () => {
  test('a deduplicated retry reports a replay, never a second delivery', async () => {
    const native = fakeGateway({ chatSend: { runId: 'oc-run-new', status: 'in_flight' } });
    const result = await steerWithNativeChatSendWithRpc(native.rpc, sessionKey, 'steer-5', 'Retry text');
    expect(result).toMatchObject({ mode: 'native-steer', replayed: true, steerRunId: 'oc-run-new' });
  });

  test('passes through an interrupted active run instead of hiding it', async () => {
    const native = fakeGateway({ chatSend: { runId: 'oc-run-new', status: 'started', interruptedActiveRun: true } });
    const result = await steerWithNativeChatSendWithRpc(native.rpc, sessionKey, 'steer-6', 'Text');
    expect(result.interruptedActiveRun).toBe(true);
  });

  test.each([
    [{ status: 'started' }],
    [{ runId: 'oc-run-new', status: 'error' }],
    [null],
  ])('fails closed on an ack without a started run id %j', async (ack) => {
    const native = fakeGateway({ chatSend: ack as any });
    await expect(steerWithNativeChatSendWithRpc(native.rpc, sessionKey, 'steer-7', 'Text'))
      .rejects.toMatchObject({ code: 'INVALID_GATEWAY_RESPONSE', statusCode: 502 });
  });

  test('rejects empty text before any gateway call', async () => {
    const native = fakeGateway({ chatSend: { runId: 'oc-run-new', status: 'started' } });
    await expect(steerWithNativeChatSendWithRpc(native.rpc, sessionKey, 'steer-8', '   '))
      .rejects.toBeInstanceOf(PendingUserInputAnswerError);
    expect(native.rpc).not.toHaveBeenCalled();
  });

  test('the idempotency key is stable per session and request and maps back to the local row', () => {
    const key = nativeSteerIdempotencyKey(sessionKey, 'steer-9');
    expect(nativeSteerIdempotencyKey(sessionKey, 'steer-9')).toBe(key);
    expect(nativeSteerIdempotencyKey('agent:main:other', 'steer-9')).not.toBe(key);
    expect(portalClientMessageIdFromIdempotencyKey(key)).toBe('active-steer:steer-9');
    expect(portalClientMessageIdFromIdempotencyKey(`${key}:user`)).toBe('active-steer:steer-9');
  });
});
