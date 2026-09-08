import {
  __persistentGatewayWsTest,
  ACTIVE_RUN_STEER_RPC_TIMEOUT_MS,
  ACTIVE_RUN_STEER_GATEWAY_METHOD,
  answerPendingUserInputWithRpc,
  dismissPendingUserInputWithRpc,
  LEGACY_PENDING_USER_INPUT_DISMISS_GATEWAY_METHOD,
  LEGACY_PENDING_USER_INPUT_GATEWAY_METHOD,
  LEGACY_PENDING_USER_INPUT_READ_GATEWAY_METHOD,
  pendingUserInputAuthorityForVersion,
  PendingUserInputAnswerError,
  PENDING_USER_INPUT_DISMISS_GATEWAY_METHOD,
  PENDING_USER_INPUT_GATEWAY_METHOD,
  PENDING_USER_INPUT_READ_GATEWAY_METHOD,
  readPendingUserInputWithRpc,
  resolvePendingUserInputAuthorityWithRpc,
  steerActiveRunWithRpc,
} from '../agents/providers/PersistentGatewayWs';

const sessionKey = 'agent:main:portal-owner';
const runId = 'run-1';
const requestId = 'ask_11111111111111111111111111111111';

const databaseQuestion = {
  questionId: 'database',
  header: 'Database',
  question: 'Which database?',
  isOther: true,
  options: [{ label: 'PostgreSQL', description: 'Recommended' }],
};

function nativeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: requestId,
    sessionKey,
    runId,
    questions: [databaseQuestion],
    createdAtMs: 1_000,
    expiresAtMs: 301_000,
    status: 'pending',
    ...overrides,
  };
}

describe('PersistentGatewayWs dual OpenClaw question authority', () => {
  test('persistent transport permits legacy RPC but requires the granted 9.1 question scope', () => {
    expect(__persistentGatewayWsTest.gatewayMethodHasRequiredScope(
      'sessions.list',
      ['operator.admin', 'operator.read'],
    )).toBe(true);
    expect(__persistentGatewayWsTest.gatewayMethodHasRequiredScope(
      'question.list',
      ['operator.admin', 'operator.read'],
    )).toBe(false);
    expect(__persistentGatewayWsTest.gatewayMethodHasRequiredScope(
      'question.resolve',
      ['operator.admin', 'operator.read', 'operator.questions'],
    )).toBe(true);
  });

  test.each([
    ['2026.7.1', 'legacy-custom'],
    ['2026.7.1-2', 'legacy-custom'],
    ['2026.9.1', 'native'],
    ['2026.7.1-3', null],
    ['2026.9.1-3', null],
    ['2026.8.2', null],
    ['2027.1.0', null],
    ['', null],
  ])('maps runtime %s to the exact supported authority', (version, expected) => {
    expect(pendingUserInputAuthorityForVersion(version)).toBe(expected);
  });

  test('attests the live runtime before selecting a question authority', async () => {
    const legacyRpc = jest.fn(async () => ({ runtimeVersion: '2026.7.1-2' }));
    const nativeRpc = jest.fn(async () => ({ runtimeVersion: '2026.9.1' }));
    const futureRpc = jest.fn(async () => ({ runtimeVersion: '2026.9.0' }));

    await expect(resolvePendingUserInputAuthorityWithRpc(legacyRpc))
      .resolves.toBe('legacy-custom');
    await expect(resolvePendingUserInputAuthorityWithRpc(nativeRpc)).resolves.toBe('native');
    await expect(resolvePendingUserInputAuthorityWithRpc(futureRpc))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_OPENCLAW_QUESTION_RUNTIME', statusCode: 503 });
    expect(legacyRpc).toHaveBeenCalledWith(
      'status',
      { includeChannelSummary: false },
      10_000,
    );
  });

  test('reads and settles retained 7.1 questions only through the installed legacy bridge', async () => {
    const legacyQuestion = {
      id: 'database',
      header: 'Database',
      question: 'Which database?',
      options: [{ label: 'PostgreSQL', description: 'Recommended' }],
    };
    const readRpc = jest.fn(async () => ({
      pending: true,
      requestId,
      runId,
      questions: [legacyQuestion],
      createdAt: 1_000,
      expiresAt: 301_000,
    }));
    await expect(readPendingUserInputWithRpc(
      readRpc,
      sessionKey,
      runId,
      'legacy-custom',
    )).resolves.toEqual({
      pending: true,
      requestId,
      runId,
      questions: [{
        id: 'database',
        header: 'Database',
        question: 'Which database?',
        multiSelect: false,
        options: [{ label: 'PostgreSQL', description: 'Recommended' }],
      }],
      createdAt: 1_000,
      expiresAt: 301_000,
    });
    expect(readRpc).toHaveBeenCalledWith(LEGACY_PENDING_USER_INPUT_READ_GATEWAY_METHOD, {
      sessionKey,
      expectedRunId: runId,
    }, 10_000);

    const answerRpc = jest.fn(async () => ({
      accepted: true,
      replayed: false,
      requestId,
      runId,
    }));
    await expect(answerPendingUserInputWithRpc(
      answerRpc,
      sessionKey,
      runId,
      requestId,
      'PostgreSQL',
      undefined,
      'legacy-custom',
    )).resolves.toMatchObject({ accepted: true, idempotentReplay: false });
    expect(answerRpc).toHaveBeenCalledWith(LEGACY_PENDING_USER_INPUT_GATEWAY_METHOD, {
      sessionKey,
      expectedRunId: runId,
      requestId,
      text: 'PostgreSQL',
    }, 10_000);

    const dismissRpc = jest.fn(async () => ({
      accepted: true,
      replayed: true,
      requestId,
      runId,
    }));
    await expect(dismissPendingUserInputWithRpc(
      dismissRpc,
      sessionKey,
      runId,
      requestId,
      'legacy-custom',
    )).resolves.toMatchObject({ accepted: true, idempotentReplay: true });
    expect(dismissRpc).toHaveBeenCalledWith(LEGACY_PENDING_USER_INPUT_DISMISS_GATEWAY_METHOD, {
      sessionKey,
      expectedRunId: runId,
      requestId,
    }, 10_000);

    const allMethods = [readRpc, answerRpc, dismissRpc]
      .flatMap((rpc) => (rpc.mock.calls as unknown[][]).map((call) => call[0]));
    expect(allMethods).not.toEqual(expect.arrayContaining([
      'question.list',
      'question.get',
      'question.resolve',
    ]));
  });
});

describe('PersistentGatewayWs OpenClaw 2026.9.1 native question RPC', () => {
  test('reads the exact native record and ignores unrelated caller-visible questions', async () => {
    const unrelated = {
      id: 'host-consent',
      questions: [{
        questionId: 'unrelated',
        header: 'Unrelated',
        question: 'Pick several?',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }],
      }],
      createdAtMs: 2_000,
      expiresAtMs: 302_000,
      status: 'pending',
    };
    const rpc = jest.fn(async () => ({ questions: [unrelated, nativeRecord()] }));

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
    expect(rpc).toHaveBeenCalledWith(PENDING_USER_INPUT_READ_GATEWAY_METHOD, {}, 10_000);
  });

  test('returns no pending input when the native list has no exact run identity', async () => {
    const rpc = jest.fn(async () => ({
      questions: [nativeRecord({ sessionKey: 'agent:main:someone-else', runId: 'other-run' })],
    }));
    await expect(readPendingUserInputWithRpc(rpc, sessionKey, runId))
      .resolves.toEqual({ pending: false });
  });

  test.each([
    [nativeRecord({ id: '' })],
    [nativeRecord({ status: 'unknown' })],
    [nativeRecord({ questions: [{ ...databaseQuestion, header: '' }] })],
    [nativeRecord({ questions: [{ ...databaseQuestion, questionId: '__proto__' }] })],
    [nativeRecord({ questions: [databaseQuestion, databaseQuestion] })],
    [nativeRecord({ createdAtMs: 2, expiresAtMs: 1 })],
  ])('rejects a malformed exact-run native question record', async (record) => {
    await expect(readPendingUserInputWithRpc(
      jest.fn(async () => ({ questions: [record] })),
      sessionKey,
      runId,
    )).rejects.toMatchObject({ code: 'INVALID_GATEWAY_RESPONSE', statusCode: 502 });
  });

  test('rejects two pending native requests for one exact run as ambiguous', async () => {
    const rpc = jest.fn(async () => ({
      questions: [nativeRecord(), nativeRecord({ id: 'ask_22222222222222222222222222222222' })],
    }));
    await expect(readPendingUserInputWithRpc(rpc, sessionKey, runId))
      .rejects.toMatchObject({ code: 'PENDING_INPUT_AMBIGUOUS', statusCode: 409 });
  });

  test('projects target multi-select without flattening its answer contract', async () => {
    const rpc = jest.fn(async () => ({
      questions: [nativeRecord({
        questions: [{
          ...databaseQuestion,
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      })],
    }));
    await expect(readPendingUserInputWithRpc(rpc, sessionKey, runId)).resolves.toMatchObject({
      pending: true,
      questions: [expect.objectContaining({ id: 'database', multiSelect: true })],
    });
  });

  test('resolves native multi-select with an ordered answer array', async () => {
    const questions = [{
      ...databaseQuestion,
      multiSelect: true,
      isOther: false,
      options: [{ label: 'A' }, { label: 'B' }],
    }];
    const expectedAnswers = { database: ['A', 'B'] };
    const rpc = jest.fn(async (method: string) => (
      method === 'question.get'
        ? { question: nativeRecord({ questions }) }
        : { status: 'answered', answers: { answers: expectedAnswers } }
    ));
    await expect(answerPendingUserInputWithRpc(
      rpc,
      sessionKey,
      runId,
      requestId,
      'A, B',
      expectedAnswers,
    )).resolves.toMatchObject({ accepted: true, idempotentReplay: false });
    expect(rpc).toHaveBeenNthCalledWith(2, PENDING_USER_INPUT_GATEWAY_METHOD, {
      id: requestId,
      answers: { answers: expectedAnswers },
      resolvedBy: 'bridgesllm-portal',
    }, 10_000);
  });

  test('accepts and replays a five-value native multi-select answer', async () => {
    const questions = [{
      ...databaseQuestion,
      multiSelect: true,
      isOther: true,
      options: [
        { label: 'A' },
        { label: 'B' },
        { label: 'C' },
        { label: 'D' },
      ],
    }];
    const expectedAnswers = { database: ['A', 'B', 'C', 'D', 'typed value'] };
    let reads = 0;
    const rpc = jest.fn(async (method: string) => {
      if (method === 'question.get') {
        reads += 1;
        return {
          question: nativeRecord(reads === 1 ? { questions } : {
            questions,
            status: 'answered',
            answers: { answers: expectedAnswers },
          }),
        };
      }
      throw new Error('socket closed after commit');
    });

    await expect(answerPendingUserInputWithRpc(
      rpc,
      sessionKey,
      runId,
      requestId,
      'A, B, C, D, typed value',
      expectedAnswers,
    )).resolves.toMatchObject({ accepted: true, idempotentReplay: true });
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  test('never projects a native secret-store prompt into the normal Portal answer path', async () => {
    const rpc = jest.fn(async () => ({
      questions: [nativeRecord({
        questions: [{
          ...databaseQuestion,
          isSecret: true,
          secretStore: { name: 'OPENAI_API_KEY', kind: 'secret' },
          options: [],
        }],
      })],
    }));
    await expect(readPendingUserInputWithRpc(rpc, sessionKey, runId))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_SECRET_INPUT', statusCode: 409 });
  });

  test('gets the exact question before resolving it with the native answer envelope', async () => {
    const rpc = jest.fn(async (method: string) => {
      if (method === 'question.get') return { question: nativeRecord() };
      if (method === 'question.resolve') {
        return { status: 'answered', answers: { answers: { database: ['PostgreSQL'] } } };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(answerPendingUserInputWithRpc(
      rpc,
      sessionKey,
      runId,
      requestId,
      'PostgreSQL',
      { database: 'PostgreSQL' },
    )).resolves.toEqual({
      accepted: true,
      replayed: false,
      idempotentReplay: false,
      runId,
      requestId,
    });
    expect(rpc).toHaveBeenNthCalledWith(1, 'question.get', { id: requestId }, 10_000);
    expect(rpc).toHaveBeenNthCalledWith(2, PENDING_USER_INPUT_GATEWAY_METHOD, {
      id: requestId,
      answers: { answers: { database: ['PostgreSQL'] } },
      resolvedBy: 'bridgesllm-portal',
    }, 10_000);
  });

  test('preserves question IDs when resolving a multi-question native record', async () => {
    const questions = [
      databaseQuestion,
      {
        questionId: 'region',
        header: 'Region',
        question: 'Which region?',
        options: [{ label: 'East' }, { label: 'West' }],
      },
    ];
    const expectedAnswers = { database: ['PostgreSQL'], region: ['East'] };
    const rpc = jest.fn(async (method: string) => (
      method === 'question.get'
        ? { question: nativeRecord({ questions }) }
        : { status: 'answered', answers: { answers: expectedAnswers } }
    ));

    await expect(answerPendingUserInputWithRpc(
      rpc,
      sessionKey,
      runId,
      requestId,
      '1: PostgreSQL\n2: East',
      { database: 'PostgreSQL', region: 'East' },
    )).resolves.toMatchObject({ accepted: true, idempotentReplay: false });
    expect(rpc).toHaveBeenNthCalledWith(2, PENDING_USER_INPUT_GATEWAY_METHOD, {
      id: requestId,
      answers: { answers: expectedAnswers },
      resolvedBy: 'bridgesllm-portal',
    }, 10_000);
  });

  test('recognizes an already committed identical answer as an idempotent replay', async () => {
    const rpc = jest.fn(async () => ({
      question: nativeRecord({
        status: 'answered',
        answers: { answers: { database: ['PostgreSQL'] } },
      }),
    }));
    await expect(answerPendingUserInputWithRpc(
      rpc,
      sessionKey,
      runId,
      requestId,
      'PostgreSQL',
      { database: 'PostgreSQL' },
    )).resolves.toMatchObject({ accepted: true, idempotentReplay: true });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test('recovers a committed answer when question.resolve loses its response', async () => {
    let reads = 0;
    const rpc = jest.fn(async (method: string) => {
      if (method === 'question.get') {
        reads += 1;
        return {
          question: nativeRecord(reads === 1 ? {} : {
            status: 'answered',
            answers: { answers: { database: ['PostgreSQL'] } },
          }),
        };
      }
      throw new Error('socket closed after commit');
    });
    await expect(answerPendingUserInputWithRpc(
      rpc,
      sessionKey,
      runId,
      requestId,
      'PostgreSQL',
      { database: 'PostgreSQL' },
    )).resolves.toMatchObject({ accepted: true, idempotentReplay: true });
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  test('does not replay a terminal answer with different values', async () => {
    const rpc = jest.fn(async () => ({
      question: nativeRecord({
        status: 'answered',
        answers: { answers: { database: ['SQLite'] } },
      }),
    }));
    await expect(answerPendingUserInputWithRpc(
      rpc,
      sessionKey,
      runId,
      requestId,
      'PostgreSQL',
      { database: 'PostgreSQL' },
    )).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND', statusCode: 404 });
  });

  test('dismisses the exact native question and verifies native cancellation', async () => {
    const rpc = jest.fn(async (method: string) => (
      method === 'question.get'
        ? { question: nativeRecord() }
        : { status: 'cancelled' }
    ));
    await expect(dismissPendingUserInputWithRpc(rpc, sessionKey, runId, requestId))
      .resolves.toMatchObject({ accepted: true, idempotentReplay: false, runId, requestId });
    expect(rpc).toHaveBeenNthCalledWith(2, PENDING_USER_INPUT_DISMISS_GATEWAY_METHOD, {
      id: requestId,
      cancel: true,
      resolvedBy: 'bridgesllm-portal',
    }, 10_000);
  });

  test('recognizes an already committed cancellation as an idempotent replay', async () => {
    const rpc = jest.fn(async () => ({ question: nativeRecord({ status: 'cancelled' }) }));
    await expect(dismissPendingUserInputWithRpc(rpc, sessionKey, runId, requestId))
      .resolves.toMatchObject({ accepted: true, idempotentReplay: true });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test('rejects a question.get record from a replacement run', async () => {
    const rpc = jest.fn(async () => ({ question: nativeRecord({ runId: 'run-2' }) }));
    await expect(answerPendingUserInputWithRpc(
      rpc,
      sessionKey,
      runId,
      requestId,
      'PostgreSQL',
    )).rejects.toMatchObject({ code: 'REQUEST_MISMATCH', statusCode: 404 });
  });

  test('projects a native hidden-or-gone question as a privacy-safe terminal result', async () => {
    const missing = Object.assign(new Error('question was not found'), {
      errorCode: 'INVALID_REQUEST',
    });
    const rpc = jest.fn(async () => { throw missing; });
    await expect(answerPendingUserInputWithRpc(
      rpc,
      sessionKey,
      runId,
      requestId,
      'PostgreSQL',
    )).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND', statusCode: 404 });
  });

  test('steers through the dedicated exact-run method, never question.resolve', async () => {
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
    }, ACTIVE_RUN_STEER_RPC_TIMEOUT_MS);
    expect(ACTIVE_RUN_STEER_RPC_TIMEOUT_MS).toBe(15_000);
    expect(ACTIVE_RUN_STEER_GATEWAY_METHOD).not.toBe(PENDING_USER_INPUT_GATEWAY_METHOD);
  });

  test('rejects a steering success that echoes a replacement run', async () => {
    const rpc = jest.fn(async () => ({
      accepted: true,
      replayed: false,
      runId: 'run-2',
      requestId: 'steer-r1',
    }));
    await expect(steerActiveRunWithRpc(
      rpc,
      sessionKey,
      runId,
      'steer-r1',
      'This belongs to R1.',
    )).rejects.toMatchObject({ code: 'INVALID_GATEWAY_RESPONSE', statusCode: 502 });
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
