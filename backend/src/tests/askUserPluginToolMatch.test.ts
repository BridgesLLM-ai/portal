const mockResolveActiveEmbeddedRunSessionId = jest.fn();

jest.mock('openclaw/plugin-sdk/agent-harness-runtime', () => ({
  resolveActiveEmbeddedRunSessionId: mockResolveActiveEmbeddedRunSessionId,
}), { virtual: true });

// Pin tests to the exact CommonJS entry point the installer copies into the
// OpenClaw extension directory. OpenClaw supplies the SDK alias mocked above.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const askUserPlugin = require('../../../installer/openclaw-ask-user-plugin/index.js');

type GatewayHandler = (input: {
  params: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
}) => Promise<void>;

function register(): Map<string, { handler: GatewayHandler; options: Record<string, unknown> }> {
  const registrations = new Map();
  askUserPlugin.register({
    registerGatewayMethod: (method: string, handler: GatewayHandler, options: unknown) => {
      registrations.set(method, { handler, options });
    },
  });
  return registrations;
}

async function invoke(
  handler: GatewayHandler,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; payload: any; error: any }> {
  let response: any;
  await handler({
    params,
    respond: (ok, payload, error) => {
      response = { ok, payload, error };
    },
  });
  if (!response) throw new Error('gateway handler did not respond');
  return response;
}

const expectedRunId = 'portal-run-11111111-1111-4111-8111-111111111111';
const requestId = 'request-22222222-2222-4222-8222-222222222222';
const validTarget = {
  sessionKey: 'agent:main:portal-owner',
  expectedRunId,
};
const validAnswer = {
  ...validTarget,
  requestId,
  text: 'Use PostgreSQL.',
};
const pendingSnapshot = {
  requestId,
  runId: expectedRunId,
  createdAt: 1_000,
  expiresAt: 601_000,
  questions: [{
    id: 'database',
    header: 'Database',
    question: 'Which database should I use?',
    isOther: true,
    isSecret: false,
    options: [
      { label: 'PostgreSQL', description: 'Best for production.' },
      { label: 'SQLite', description: 'Best for a local prototype.' },
    ],
  }],
};

function installRuntime(overrides: Record<string, unknown> = {}) {
  const runtime = Object.freeze({
    version: 1,
    read: jest.fn(() => pendingSnapshot),
    answer: jest.fn(() => ({
      ok: true,
      code: 'ANSWERED',
      requestId,
      runId: expectedRunId,
    })),
    dismiss: jest.fn(() => ({
      ok: true,
      code: 'DISMISSED',
      requestId,
      runId: expectedRunId,
    })),
    steer: jest.fn(async () => ({
      ok: true,
      code: 'STEERED',
      runId: expectedRunId,
    })),
    ...overrides,
  });
  (globalThis as any)[askUserPlugin.__test.RUNTIME_SYMBOL] = runtime;
  return runtime as any;
}

function method(
  registrations: Map<string, { handler: GatewayHandler; options: Record<string, unknown> }>,
  name: 'pending' | 'answer' | 'dismiss' | 'steer',
): GatewayHandler {
  const registered = registrations.get(askUserPlugin.__test.GATEWAY_METHODS[name]);
  if (!registered) throw new Error(`${name} gateway method was not registered`);
  return registered.handler;
}

describe('OpenClaw native pending-user-input gateway plugin', () => {
  beforeEach(() => {
    askUserPlugin.__test.reset();
    mockResolveActiveEmbeddedRunSessionId.mockReset();
    delete (globalThis as any)[askUserPlugin.__test.RUNTIME_SYMBOL];
  });

  afterEach(() => {
    delete (globalThis as any)[askUserPlugin.__test.RUNTIME_SYMBOL];
    jest.restoreAllMocks();
  });

  test('registers only the exact pending-input API with operator write scope', () => {
    expect(typeof askUserPlugin.register).toBe('function');
    expect(askUserPlugin.register.constructor.name).toBe('Function');
    const registrations = register();
    expect([...registrations.keys()]).toEqual([
      'bridgesllm.ask_user.pending',
      'bridgesllm.ask_user.answer',
      'bridgesllm.ask_user.dismiss',
      'bridgesllm.ask_user.steer',
    ]);
    expect([...registrations.values()].every(({ options }) => (
      JSON.stringify(options) === JSON.stringify({ scope: 'operator.write' })
    ))).toBe(true);
  });

  test('reads the real request identity and structured questions from the exact run', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const runtime = installRuntime();
    const response = await invoke(method(register(), 'pending'), validTarget);

    expect(response).toEqual({
      ok: true,
      payload: { pending: true, ...pendingSnapshot },
      error: undefined,
    });
    expect(mockResolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(validTarget.sessionKey);
    expect(runtime.read).toHaveBeenCalledWith('internal-session-id', expectedRunId);
  });

  test('answers only the attested run and native request identity', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const runtime = installRuntime();
    const response = await invoke(method(register(), 'answer'), validAnswer);

    expect(response).toEqual({
      ok: true,
      payload: {
        accepted: true,
        replayed: false,
        code: 'ANSWERED',
        requestId,
        runId: expectedRunId,
      },
      error: undefined,
    });
    expect(runtime.answer).toHaveBeenCalledWith(
      'internal-session-id',
      expectedRunId,
      requestId,
      validAnswer.text,
    );
  });

  test('dismisses only the attested run and native request identity', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const runtime = installRuntime();
    const response = await invoke(method(register(), 'dismiss'), {
      ...validTarget,
      requestId,
    });

    expect(response.payload).toEqual({
      accepted: true,
      replayed: false,
      code: 'DISMISSED',
      requestId,
      runId: expectedRunId,
    });
    expect(runtime.dismiss).toHaveBeenCalledWith(
      'internal-session-id',
      expectedRunId,
      requestId,
    );
  });

  test('steers only the attested active run through the dedicated awaited runtime method', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const runtime = installRuntime();
    const response = await invoke(method(register(), 'steer'), validAnswer);

    expect(response.payload).toEqual({
      accepted: true,
      replayed: false,
      code: 'STEERED',
      requestId,
      runId: expectedRunId,
    });
    expect(runtime.steer).toHaveBeenCalledWith(
      'internal-session-id',
      expectedRunId,
      validAnswer.text,
    );
  });

  test('replays only the exact accepted steer and does not record asynchronous rejection', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const runtime = installRuntime({
      steer: jest.fn()
        .mockResolvedValueOnce({ ok: false, code: 'QUEUE_REJECTED', runId: expectedRunId })
        .mockResolvedValueOnce({ ok: true, code: 'STEERED', runId: expectedRunId }),
    });
    const handler = method(register(), 'steer');

    expect((await invoke(handler, validAnswer)).payload).toEqual({
      accepted: false,
      code: 'QUEUE_REJECTED',
      requestId,
      runId: expectedRunId,
    });
    expect((await invoke(handler, validAnswer)).payload).toEqual({
      accepted: true,
      replayed: false,
      code: 'STEERED',
      requestId,
      runId: expectedRunId,
    });
    expect((await invoke(handler, validAnswer)).payload).toEqual({
      accepted: true,
      replayed: true,
      code: 'STEERED',
      requestId,
      runId: expectedRunId,
    });
    expect((await invoke(handler, { ...validAnswer, text: 'different steer' })).payload).toEqual({
      accepted: false,
      code: 'REQUEST_CONFLICT',
      requestId,
      runId: expectedRunId,
    });
    expect(runtime.steer).toHaveBeenCalledTimes(2);
  });

  test('replays an exact accepted answer and rejects changed payload or action', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const runtime = installRuntime();
    const registrations = register();
    const handler = method(registrations, 'answer');

    expect((await invoke(handler, validAnswer)).payload.accepted).toBe(true);
    expect((await invoke(handler, validAnswer)).payload).toEqual({
      accepted: true,
      replayed: true,
      code: 'ANSWERED',
      requestId,
      runId: expectedRunId,
    });
    expect((await invoke(handler, { ...validAnswer, text: 'Use SQLite.' })).payload).toEqual({
      accepted: false,
      code: 'REQUEST_CONFLICT',
      requestId,
      runId: expectedRunId,
    });
    expect((await invoke(method(registrations, 'dismiss'), {
      ...validTarget,
      requestId,
    })).payload).toEqual({
      accepted: false,
      code: 'REQUEST_CONFLICT',
      requestId,
      runId: expectedRunId,
    });
    expect(runtime.answer).toHaveBeenCalledTimes(1);
    expect(runtime.dismiss).not.toHaveBeenCalled();
  });

  test('does not record runtime rejection as a terminal receipt', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const runtime = installRuntime({
      answer: jest.fn()
        .mockReturnValueOnce({ ok: false, code: 'REQUEST_EXPIRED', runId: expectedRunId })
        .mockReturnValueOnce({ ok: true, code: 'ANSWERED', requestId, runId: expectedRunId }),
    });
    const handler = method(register(), 'answer');

    expect((await invoke(handler, validAnswer)).payload.accepted).toBe(false);
    expect((await invoke(handler, validAnswer)).payload).toEqual({
      accepted: true,
      replayed: false,
      code: 'ANSWERED',
      requestId,
      runId: expectedRunId,
    });
    expect(runtime.answer).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['NO_ACTIVE_RUN', undefined],
    ['HOTFIX_UNAVAILABLE', 'internal-session-id'],
  ])('fails closed with %s before reading or answering', async (code, sessionId) => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue(sessionId);
    const registrations = register();
    const pending = await invoke(method(registrations, 'pending'), validTarget);
    const answer = await invoke(method(registrations, 'answer'), validAnswer);

    expect(pending.payload).toEqual({ pending: false, code });
    expect(answer.payload).toEqual({ accepted: false, code, requestId });
  });

  test('rejects a runtime snapshot whose request or run identity is not exact', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    installRuntime({ read: jest.fn(() => ({ ...pendingSnapshot, runId: 'newer-run' })) });

    expect((await invoke(method(register(), 'pending'), validTarget)).payload).toEqual({
      pending: false,
      code: 'HOTFIX_INVALID_STATE',
    });
  });

  test('does not convert runtime throws or malformed success into acceptance', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    installRuntime({ answer: jest.fn(() => { throw new Error('delivery failed'); }) });
    expect((await invoke(method(register(), 'answer'), validAnswer)).payload).toEqual({
      accepted: false,
      code: 'HOTFIX_ERROR',
      requestId,
    });

    installRuntime({
      answer: jest.fn(() => ({
        ok: true,
        code: 'ANSWERED',
        requestId,
        runId: 'different-run',
      })),
    });
    expect((await invoke(method(register(), 'answer'), validAnswer)).payload).toEqual({
      accepted: false,
      code: 'RUNTIME_REJECTED',
      requestId,
    });
  });

  test.each([
    [{ ...validAnswer, sessionKey: '' }],
    [{ ...validAnswer, expectedRunId: `run-${'x'.repeat(600)}` }],
    [{ ...validAnswer, requestId: `request-${'x'.repeat(300)}` }],
    [{ ...validAnswer, text: 'bad\u0000text' }],
    [{ ...validAnswer, text: 'x'.repeat(32_769) }],
  ])('rejects malformed or unbounded input before resolving a run', async (params) => {
    const response = await invoke(method(register(), 'answer'), params);
    expect(response.ok).toBe(false);
    expect(response.payload).toEqual({ accepted: false, code: 'INVALID_REQUEST' });
    expect(response.error).toEqual(expect.objectContaining({ code: 'invalid_request' }));
    expect(mockResolveActiveEmbeddedRunSessionId).not.toHaveBeenCalled();
  });
});
