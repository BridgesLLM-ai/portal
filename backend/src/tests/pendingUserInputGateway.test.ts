import {
  ACTIVE_RUN_STEER_GATEWAY_METHOD,
  answerPendingUserInputWithRpc,
  dismissPendingUserInputWithRpc,
  PendingUserInputAnswerError,
  PENDING_USER_INPUT_DISMISS_GATEWAY_METHOD,
  PENDING_USER_INPUT_GATEWAY_METHOD,
  PENDING_USER_INPUT_READ_GATEWAY_METHOD,
  readPendingUserInputWithRpc,
  steerActiveRunWithRpc,
} from '../agents/providers/PersistentGatewayWs';

const sessionKey = 'agent:main:portal-owner';
const runId = 'run-1';
const requestId = 'request-1';

describe('PersistentGatewayWs native pending-user-input RPC', () => {
  test('reads and validates an exact native request snapshot', async () => {
    const rpc = jest.fn(async () => ({
      pending: true,
      runId,
      requestId,
      questions: [{
        id: 'database',
        header: 'Database',
        question: 'Which database?',
        isOther: true,
        options: [{ label: 'PostgreSQL', description: 'Recommended' }],
      }],
      createdAt: 1_000,
      expiresAt: 301_000,
    }));

    await expect(readPendingUserInputWithRpc(rpc, sessionKey, runId)).resolves.toEqual({
      pending: true,
      runId,
      requestId,
      questions: [{
        id: 'database',
        header: 'Database',
        question: 'Which database?',
        multiSelect: false,
        isOther: true,
        options: [{ label: 'PostgreSQL', description: 'Recommended' }],
      }],
      createdAt: 1_000,
      expiresAt: 301_000,
    });
    expect(rpc).toHaveBeenCalledWith(PENDING_USER_INPUT_READ_GATEWAY_METHOD, {
      sessionKey,
      expectedRunId: runId,
    }, 10_000);
  });

  test('accepts a verified no-pending snapshot without inventing identity', async () => {
    const rpc = jest.fn(async () => ({ pending: false, runId, code: 'NO_PENDING_INPUT' }));
    await expect(readPendingUserInputWithRpc(rpc, sessionKey, runId))
      .resolves.toEqual({ pending: false });
  });

  test.each([
    ['HOTFIX_UNAVAILABLE', 503],
    ['HOTFIX_INVALID_STATE', 502],
    ['HOTFIX_ERROR', 502],
  ])('does not disguise plugin inspection failure %s as no pending input', async (code, statusCode) => {
    await expect(readPendingUserInputWithRpc(
      jest.fn(async () => ({ pending: false, code })),
      sessionKey,
      runId,
    )).rejects.toMatchObject({ code, statusCode });
  });

  test.each([
    [{ pending: true, runId: 'other-run', requestId, questions: [{ id: 'q', question: 'Q?' }] }],
    [{ pending: true, runId, requestId: '', questions: [{ id: 'q', question: 'Q?' }] }],
    [{ pending: true, runId, requestId, questions: [{ question: 'Missing id' }] }],
    [{ pending: true, runId, requestId, questions: [{ id: '__proto__', question: 'One?' }, { id: '__proto__', question: 'Two?' }] }],
    [{ pending: true, runId, requestId, questions: [{ id: 'q', question: 'Q?' }], createdAt: 2, expiresAt: 1 }],
  ])('rejects malformed or mismatched pending snapshots', async (payload) => {
    await expect(readPendingUserInputWithRpc(jest.fn(async () => payload), sessionKey, runId))
      .rejects.toMatchObject({ code: 'INVALID_GATEWAY_RESPONSE', statusCode: 502 });
  });

  test('rejects duplicate native question IDs before answers can overwrite', async () => {
    const rpc = jest.fn(async () => ({
      pending: true,
      runId,
      requestId,
      questions: [
        { id: 'same', header: 'First', question: 'First?' },
        { id: 'same', header: 'Second', question: 'Second?' },
      ],
    }));
    await expect(readPendingUserInputWithRpc(rpc, sessionKey, runId))
      .rejects.toMatchObject({ code: 'INVALID_GATEWAY_RESPONSE', statusCode: 502 });
  });

  test('rejects invented native multi-select semantics', async () => {
    const rpc = jest.fn(async () => ({
      pending: true,
      runId,
      requestId,
      questions: [{
        id: 'choices',
        header: 'Choices',
        question: 'Pick several?',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }],
      }],
    }));
    await expect(readPendingUserInputWithRpc(rpc, sessionKey, runId))
      .rejects.toMatchObject({
        code: 'INVALID_GATEWAY_RESPONSE',
        message: expect.stringMatching(/multi-select/i),
      });
  });

  test('answers only the exact run and request and verifies the echoed identities', async () => {
    const rpc = jest.fn(async () => ({
      accepted: true,
      replayed: false,
      runId,
      requestId,
    }));
    await expect(answerPendingUserInputWithRpc(
      rpc,
      sessionKey,
      runId,
      requestId,
      'PostgreSQL',
    )).resolves.toEqual({
      accepted: true,
      replayed: false,
      idempotentReplay: false,
      runId,
      requestId,
    });
    expect(rpc).toHaveBeenCalledWith(PENDING_USER_INPUT_GATEWAY_METHOD, {
      sessionKey,
      expectedRunId: runId,
      requestId,
      text: 'PostgreSQL',
    }, 10_000);
  });

  test('dismisses only the exact run and request', async () => {
    const rpc = jest.fn(async () => ({
      accepted: true,
      replayed: true,
      runId,
      requestId,
    }));
    await expect(dismissPendingUserInputWithRpc(rpc, sessionKey, runId, requestId))
      .resolves.toMatchObject({ accepted: true, idempotentReplay: true, runId, requestId });
    expect(rpc).toHaveBeenCalledWith(PENDING_USER_INPUT_DISMISS_GATEWAY_METHOD, {
      sessionKey,
      expectedRunId: runId,
      requestId,
    }, 10_000);
  });

  test('steers through the dedicated exact-run method, never the pending-answer method', async () => {
    const rpc = jest.fn(async () => ({
      accepted: true,
      replayed: false,
      runId,
      requestId: 'steer-1',
    }));
    await expect(steerActiveRunWithRpc(
      rpc,
      sessionKey,
      runId,
      'steer-1',
      'Focus on the durable fix.',
    )).resolves.toMatchObject({
      accepted: true,
      idempotentReplay: false,
      runId,
      requestId: 'steer-1',
    });
    expect(rpc).toHaveBeenCalledWith(ACTIVE_RUN_STEER_GATEWAY_METHOD, {
      sessionKey,
      expectedRunId: runId,
      requestId: 'steer-1',
      text: 'Focus on the durable fix.',
    }, 10_000);
    expect(ACTIVE_RUN_STEER_GATEWAY_METHOD).not.toBe(PENDING_USER_INPUT_GATEWAY_METHOD);
  });

  test.each([
    ['NO_ACTIVE_RUN', 404],
    ['REQUEST_NOT_FOUND', 404],
    ['QUEUE_REJECTED', 409],
  ])('fails closed when the plugin returns %s', async (code, statusCode) => {
    const rpc = jest.fn(async () => ({ accepted: false, code, runId, requestId }));
    await expect(answerPendingUserInputWithRpc(
      rpc,
      sessionKey,
      runId,
      requestId,
      'PostgreSQL',
    )).rejects.toMatchObject({
      name: 'PendingUserInputAnswerError',
      code,
      statusCode,
    });
  });

  test('rejects an accepted response that does not echo both identities', async () => {
    const rpc = jest.fn(async () => ({
      accepted: true,
      replayed: false,
      runId: 'different-run',
      requestId,
    }));
    await expect(answerPendingUserInputWithRpc(
      rpc,
      sessionKey,
      runId,
      requestId,
      'PostgreSQL',
    )).rejects.toMatchObject({
      code: 'INVALID_GATEWAY_RESPONSE',
      statusCode: 502,
    });
  });

  test.each([
    ['', runId, requestId, 'PostgreSQL'],
    [sessionKey, '', requestId, 'PostgreSQL'],
    [sessionKey, runId, '', 'PostgreSQL'],
    [sessionKey, runId, requestId, ''],
    ['agent:main:portal\u0000owner', runId, requestId, 'PostgreSQL'],
    [sessionKey, runId, requestId, 'bad\u0000answer'],
  ])('rejects invalid bounded answer input without making an RPC', async (session, run, request, text) => {
    const rpc = jest.fn();
    await expect(answerPendingUserInputWithRpc(rpc, session, run, request, text))
      .rejects.toBeInstanceOf(PendingUserInputAnswerError);
    expect(rpc).not.toHaveBeenCalled();
  });
});
