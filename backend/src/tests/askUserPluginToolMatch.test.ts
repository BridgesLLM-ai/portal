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

type AskUserTool = {
  name: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

type AskUserToolFactory = (context: Record<string, unknown>) => AskUserTool | null;
type BeforeToolCallHandler = (
  event: Record<string, unknown>,
  context: Record<string, unknown>,
) => void;

type Registrations = Map<string, {
  handler: GatewayHandler;
  options: Record<string, unknown>;
}> & {
  toolFactory?: AskUserToolFactory;
  toolOptions?: Record<string, unknown>;
  beforeToolCall?: BeforeToolCallHandler;
  beforeToolCallOptions?: Record<string, unknown>;
};

function register(): Registrations {
  const registrations = new Map() as Registrations;
  askUserPlugin.register({
    registerGatewayMethod: (
      method: string,
      handler: GatewayHandler,
      options: Record<string, unknown>,
    ) => {
      registrations.set(method, { handler, options });
    },
    registerTool: (factory: AskUserToolFactory, options: Record<string, unknown>) => {
      registrations.toolFactory = factory;
      registrations.toolOptions = options;
    },
    on: (
      name: string,
      handler: BeforeToolCallHandler,
      options: Record<string, unknown>,
    ) => {
      if (name !== 'before_tool_call') throw new Error(`unexpected hook ${name}`);
      registrations.beforeToolCall = handler;
      registrations.beforeToolCallOptions = options;
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

function installRuntime(
  overrides: Record<string, unknown> = {},
  symbol = askUserPlugin.__test.RUNTIME_SYMBOL,
) {
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
  (globalThis as any)[symbol] = runtime;
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

function beginGenericQuestion(
  registrations: Registrations,
  options: {
    runId?: string;
    toolCallId?: string;
    signal?: AbortSignal;
    params?: Record<string, unknown>;
  } = {},
) {
  const runId = options.runId || expectedRunId;
  const toolCallId = options.toolCallId || requestId;
  const sessionId = 'internal-session-id';
  const toolContext = {
    sessionKey: validTarget.sessionKey,
    sessionId,
    activeModel: { provider: 'anthropic', modelId: 'claude-sonnet' },
  };
  const tool = registrations.toolFactory?.(toolContext);
  if (!tool || !registrations.beforeToolCall) throw new Error('ask-user tool was not registered');
  registrations.beforeToolCall(
    { toolName: 'ask_user_question', runId, toolCallId, params: options.params || {} },
    {
      toolName: 'ask_user_question',
      sessionKey: validTarget.sessionKey,
      sessionId,
      runId,
      toolCallId,
    },
  );
  const params = options.params || {
    questions: [{
      header: 'Database',
      question: 'Which database should I use?',
      options: [
        { label: 'PostgreSQL', description: 'Best for production.' },
        { label: 'SQLite', description: 'Best for a local prototype.' },
      ],
    }],
  };
  return {
    runId,
    toolCallId,
    execution: tool.execute(toolCallId, params, options.signal),
  };
}

describe('OpenClaw exact-run ask-user plugin', () => {
  beforeEach(() => {
    askUserPlugin.__test.reset();
    mockResolveActiveEmbeddedRunSessionId.mockReset();
    for (const symbol of askUserPlugin.__test.RUNTIME_SYMBOLS) {
      delete (globalThis as any)[symbol];
    }
  });

  afterEach(() => {
    for (const symbol of askUserPlugin.__test.RUNTIME_SYMBOLS) {
      delete (globalThis as any)[symbol];
    }
    jest.restoreAllMocks();
  });

  test('registers the provider-neutral tool, identity hook, and exact gateway API', () => {
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
    expect(registrations.toolOptions).toEqual({ name: 'ask_user_question' });
    expect(registrations.beforeToolCallOptions).toEqual({ priority: 100 });
    const tool = registrations.toolFactory?.({
      sessionKey: validTarget.sessionKey,
      sessionId: 'internal-session-id',
      activeModel: { provider: 'anthropic', modelId: 'claude-sonnet' },
    });
    expect(tool).toEqual(expect.objectContaining({
      name: 'ask_user_question',
      parameters: expect.objectContaining({ type: 'object' }),
    }));
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

  test('pauses an Anthropic run, exposes its exact question, and resumes with the answer', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const registrations = register();
    const pendingTool = beginGenericQuestion(registrations);

    const pending = await invoke(method(registrations, 'pending'), validTarget);
    expect(pending).toEqual({
      ok: true,
      payload: {
        pending: true,
        requestId,
        runId: expectedRunId,
        createdAt: expect.any(Number),
        expiresAt: expect.any(Number),
        questions: [{
          id: '1',
          header: 'Database',
          question: 'Which database should I use?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'PostgreSQL', description: 'Best for production.' },
            { label: 'SQLite', description: 'Best for a local prototype.' },
          ],
        }],
      },
      error: undefined,
    });

    expect((await invoke(method(registrations, 'answer'), validAnswer)).payload).toEqual({
      accepted: true,
      replayed: false,
      code: 'ANSWERED',
      requestId,
      runId: expectedRunId,
    });
    await expect(pendingTool.execution).resolves.toEqual({
      content: [{ type: 'text', text: 'Use PostgreSQL.' }],
    });
  });

  test('continues past an idle native Codex adapter to the provider-neutral pending call', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const nativeRuntime = installRuntime({
      read: jest.fn(() => null),
      answer: jest.fn(() => ({ ok: false, code: 'NO_PENDING_INPUT' })),
    });
    const registrations = register();
    const pendingTool = beginGenericQuestion(registrations);

    expect((await invoke(method(registrations, 'pending'), validTarget)).payload.pending).toBe(true);
    expect((await invoke(method(registrations, 'answer'), validAnswer)).payload.accepted).toBe(true);
    await expect(pendingTool.execution).resolves.toEqual({
      content: [{ type: 'text', text: validAnswer.text }],
    });
    expect(nativeRuntime.answer).toHaveBeenCalledTimes(1);
  });

  test('requires a host-attested run binding before a provider-neutral tool can wait', async () => {
    const registrations = register();
    const tool = registrations.toolFactory?.({
      sessionKey: validTarget.sessionKey,
      sessionId: 'internal-session-id',
      activeModel: { provider: 'anthropic', modelId: 'claude-sonnet' },
    });
    if (!tool) throw new Error('ask-user tool was not registered');

    await expect(tool.execute(requestId, {
      questions: [{ question: 'Unsafe unbound question?' }],
    })).rejects.toThrow(/did not attest this exact tool call/i);
  });

  test('quarantines a provider tool-call id after overlapping runs collide', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const registrations = register();
    const sessionId = 'internal-session-id';
    const tool = registrations.toolFactory?.({
      sessionKey: validTarget.sessionKey,
      sessionId,
      activeModel: { provider: 'anthropic', modelId: 'claude-sonnet' },
    });
    if (!tool || !registrations.beforeToolCall) throw new Error('ask-user tool was not registered');
    const reusedToolCallId = 'provider-reused-tool-call';
    for (const runId of ['run-a', 'run-b']) {
      registrations.beforeToolCall(
        { toolName: 'ask_user_question', runId, toolCallId: reusedToolCallId, params: {} },
        {
          toolName: 'ask_user_question',
          sessionKey: validTarget.sessionKey,
          sessionId,
          runId,
          toolCallId: reusedToolCallId,
        },
      );
    }

    await expect(tool.execute(reusedToolCallId, {
      questions: [{ question: 'Which run owns this?' }],
    })).rejects.toThrow(/did not attest this exact tool call/i);

    // A timer is not an authority boundary. The delayed execute from run B can
    // arrive after the original binding TTL, so expiry must not rehabilitate
    // the provider-owned id inside the same embedded session.
    now += 30_001;

    // A third hook must not make the identity eligible again. Otherwise the
    // still-delayed execute from run B could consume run C's binding and wait
    // on an answer that the Portal correctly attributes to run C.
    registrations.beforeToolCall(
      {
        toolName: 'ask_user_question',
        runId: 'run-c',
        toolCallId: reusedToolCallId,
        params: {},
      },
      {
        toolName: 'ask_user_question',
        sessionKey: validTarget.sessionKey,
        sessionId,
        runId: 'run-c',
        toolCallId: reusedToolCallId,
      },
    );
    await expect(tool.execute(reusedToolCallId, {
      questions: [{ question: 'Can delayed run B steal run C?' }],
    })).rejects.toThrow(/did not attest this exact tool call/i);
    expect((await invoke(method(registrations, 'pending'), validTarget)).payload).toEqual({
      pending: false,
      code: 'NO_PENDING_INPUT',
    });
  });

  test('keeps quarantine saturation scoped to the offending embedded session', async () => {
    const poisonedSessionKey = validTarget.sessionKey;
    const poisonedSessionId = 'poisoned-internal-session';
    const freshSessionKey = 'agent:main:fresh-anthropic-session';
    const freshSessionId = 'fresh-internal-session';
    mockResolveActiveEmbeddedRunSessionId.mockImplementation((sessionKey: string) => (
      sessionKey === freshSessionKey ? freshSessionId : poisonedSessionId
    ));
    const registrations = register();
    if (!registrations.beforeToolCall) throw new Error('ask-user hook was not registered');

    for (let index = 0; index < 257; index += 1) {
      const toolCallId = `colliding-call-${index}`;
      for (const runId of [`run-a-${index}`, `run-b-${index}`]) {
        registrations.beforeToolCall(
          { toolName: 'ask_user_question', runId, toolCallId, params: {} },
          {
            toolName: 'ask_user_question',
            sessionKey: poisonedSessionKey,
            sessionId: poisonedSessionId,
            runId,
            toolCallId,
          },
        );
      }
    }

    const freshRunId = 'fresh-run';
    const freshToolCallId = 'fresh-tool-call';
    const freshTool = registrations.toolFactory?.({
      sessionKey: freshSessionKey,
      sessionId: freshSessionId,
      activeModel: { provider: 'anthropic', modelId: 'claude-sonnet' },
    });
    if (!freshTool) throw new Error('ask-user tool was not registered');
    registrations.beforeToolCall(
      {
        toolName: 'ask_user_question',
        runId: freshRunId,
        toolCallId: freshToolCallId,
        params: {},
      },
      {
        toolName: 'ask_user_question',
        sessionKey: freshSessionKey,
        sessionId: freshSessionId,
        runId: freshRunId,
        toolCallId: freshToolCallId,
      },
    );
    const execution = freshTool.execute(freshToolCallId, {
      questions: [{ question: 'Does this fresh Anthropic session still work?' }],
    });
    const freshTarget = { sessionKey: freshSessionKey, expectedRunId: freshRunId };
    expect((await invoke(method(registrations, 'pending'), freshTarget)).payload.pending).toBe(true);
    expect((await invoke(method(registrations, 'answer'), {
      ...freshTarget,
      requestId: freshToolCallId,
      text: 'Yes.',
    })).payload.accepted).toBe(true);
    await expect(execution).resolves.toEqual({
      content: [{ type: 'text', text: 'Yes.' }],
    });
  });

  test('keeps active binding capacity scoped to one embedded session', async () => {
    const busySessionKey = validTarget.sessionKey;
    const busySessionId = 'busy-internal-session';
    const freshSessionKey = 'agent:main:fresh-capacity-session';
    const freshSessionId = 'fresh-capacity-internal-session';
    mockResolveActiveEmbeddedRunSessionId.mockImplementation((sessionKey: string) => (
      sessionKey === freshSessionKey ? freshSessionId : busySessionId
    ));
    const registrations = register();
    if (!registrations.beforeToolCall) throw new Error('ask-user hook was not registered');

    for (let index = 0; index < 256; index += 1) {
      const runId = `held-run-${index}`;
      const toolCallId = `held-call-${index}`;
      registrations.beforeToolCall(
        { toolName: 'ask_user_question', runId, toolCallId, params: {} },
        {
          toolName: 'ask_user_question',
          sessionKey: busySessionKey,
          sessionId: busySessionId,
          runId,
          toolCallId,
        },
      );
    }

    const freshRunId = 'fresh-capacity-run';
    const freshToolCallId = 'fresh-capacity-call';
    const freshTool = registrations.toolFactory?.({
      sessionKey: freshSessionKey,
      sessionId: freshSessionId,
      activeModel: { provider: 'anthropic', modelId: 'claude-sonnet' },
    });
    if (!freshTool) throw new Error('ask-user tool was not registered');
    registrations.beforeToolCall(
      {
        toolName: 'ask_user_question',
        runId: freshRunId,
        toolCallId: freshToolCallId,
        params: {},
      },
      {
        toolName: 'ask_user_question',
        sessionKey: freshSessionKey,
        sessionId: freshSessionId,
        runId: freshRunId,
        toolCallId: freshToolCallId,
      },
    );
    const execution = freshTool.execute(freshToolCallId, {
      questions: [{ question: 'Can an unrelated Anthropic session still ask?' }],
    });
    const freshTarget = { sessionKey: freshSessionKey, expectedRunId: freshRunId };
    expect((await invoke(method(registrations, 'pending'), freshTarget)).payload.pending).toBe(true);
    expect((await invoke(method(registrations, 'answer'), {
      ...freshTarget,
      requestId: freshToolCallId,
      text: 'Yes.',
    })).payload.accepted).toBe(true);
    await expect(execution).resolves.toEqual({
      content: [{ type: 'text', text: 'Yes.' }],
    });
  });

  test('reclaims quarantined ids only after OpenClaw attests a session-id rollover', async () => {
    const sessionKey = validTarget.sessionKey;
    let activeSessionId = 'old-internal-session';
    mockResolveActiveEmbeddedRunSessionId.mockImplementation(() => activeSessionId);
    const registrations = register();
    if (!registrations.beforeToolCall) throw new Error('ask-user hook was not registered');
    const reusedToolCallId = 'rollover-call';
    for (const runId of ['old-run-a', 'old-run-b']) {
      registrations.beforeToolCall(
        { toolName: 'ask_user_question', runId, toolCallId: reusedToolCallId, params: {} },
        {
          toolName: 'ask_user_question',
          sessionKey,
          sessionId: activeSessionId,
          runId,
          toolCallId: reusedToolCallId,
        },
      );
    }

    activeSessionId = 'new-internal-session';
    const freshRunId = 'new-run';
    const freshTool = registrations.toolFactory?.({
      sessionKey,
      sessionId: activeSessionId,
      activeModel: { provider: 'anthropic', modelId: 'claude-sonnet' },
    });
    if (!freshTool) throw new Error('ask-user tool was not registered');
    registrations.beforeToolCall(
      {
        toolName: 'ask_user_question',
        runId: freshRunId,
        toolCallId: reusedToolCallId,
        params: {},
      },
      {
        toolName: 'ask_user_question',
        sessionKey,
        sessionId: activeSessionId,
        runId: freshRunId,
        toolCallId: reusedToolCallId,
      },
    );
    const execution = freshTool.execute(reusedToolCallId, {
      questions: [{ question: 'Did OpenClaw attest the replacement session?' }],
    });
    expect((await invoke(method(registrations, 'pending'), {
      sessionKey,
      expectedRunId: freshRunId,
    })).payload.pending).toBe(true);
    expect((await invoke(method(registrations, 'answer'), {
      sessionKey,
      expectedRunId: freshRunId,
      requestId: reusedToolCallId,
      text: 'Yes.',
    })).payload.accepted).toBe(true);
    await expect(execution).resolves.toEqual({
      content: [{ type: 'text', text: 'Yes.' }],
    });
  });

  test('does not let a stale run answer or dismiss a newer provider-neutral question', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const registrations = register();
    const pendingTool = beginGenericQuestion(registrations);
    const staleTarget = { ...validTarget, expectedRunId: 'portal-run-stale' };

    expect((await invoke(method(registrations, 'answer'), {
      ...validAnswer,
      expectedRunId: staleTarget.expectedRunId,
    })).payload).toEqual({ accepted: false, code: 'RUN_MISMATCH', requestId });
    expect((await invoke(method(registrations, 'dismiss'), {
      ...staleTarget,
      requestId,
    })).payload).toEqual({ accepted: false, code: 'RUN_MISMATCH', requestId });

    expect((await invoke(method(registrations, 'dismiss'), {
      ...validTarget,
      requestId,
    })).payload.accepted).toBe(true);
    await expect(pendingTool.execution).resolves.toEqual({
      content: [{ type: 'text', text: 'The user dismissed the question without answering.' }],
    });
  });

  test('removes a provider-neutral pending question when its exact run aborts', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const controller = new AbortController();
    const registrations = register();
    const pendingTool = beginGenericQuestion(registrations, { signal: controller.signal });
    expect((await invoke(method(registrations, 'pending'), validTarget)).payload.pending).toBe(true);

    controller.abort();
    await expect(pendingTool.execution).rejects.toThrow(/run ended while waiting/i);
    expect((await invoke(method(registrations, 'pending'), validTarget)).payload).toEqual({
      pending: false,
      code: 'NO_PENDING_INPUT',
    });
  });

  test('rejects malformed provider-neutral questions before publishing pending state', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const registrations = register();
    const pendingTool = beginGenericQuestion(registrations, {
      params: {
        questions: [{
          question: 'Choose?',
          options: [{ label: 'Same' }, { label: 'same' }],
        }],
      },
    });
    await expect(pendingTool.execution).rejects.toThrow(/bounded, answerable questions/i);
    expect((await invoke(method(registrations, 'pending'), validTarget)).payload).toEqual({
      pending: false,
      code: 'NO_PENDING_INPUT',
    });
  });

  test('resolves the exact run across the external provider and core runtime channels', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const [providerSymbol, coreSymbol] = askUserPlugin.__test.RUNTIME_SYMBOLS;
    const providerRuntime = installRuntime({
      read: jest.fn(() => null),
      answer: jest.fn(() => ({ ok: false, code: 'NO_ACTIVE_RUN' })),
    }, providerSymbol);
    const coreRuntime = installRuntime({}, coreSymbol);
    const registrations = register();

    expect((await invoke(method(registrations, 'pending'), validTarget)).payload).toEqual({
      pending: true,
      ...pendingSnapshot,
    });
    expect((await invoke(method(registrations, 'answer'), validAnswer)).payload).toEqual({
      accepted: true,
      replayed: false,
      code: 'ANSWERED',
      requestId,
      runId: expectedRunId,
    });
    expect(providerRuntime.read).toHaveBeenCalledTimes(1);
    expect(coreRuntime.read).toHaveBeenCalledTimes(1);
    expect(providerRuntime.answer).toHaveBeenCalledTimes(1);
    expect(coreRuntime.answer).toHaveBeenCalledTimes(1);
  });

  test('prefers the loaded external Codex provider when it owns the exact run', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const [providerSymbol, coreSymbol] = askUserPlugin.__test.RUNTIME_SYMBOLS;
    const providerRuntime = installRuntime({}, providerSymbol);
    const coreRuntime = installRuntime({
      read: jest.fn(() => null),
      answer: jest.fn(() => ({ ok: false, code: 'NO_ACTIVE_RUN' })),
    }, coreSymbol);
    const registrations = register();

    expect((await invoke(method(registrations, 'pending'), validTarget)).payload.pending).toBe(true);
    expect((await invoke(method(registrations, 'answer'), validAnswer)).payload.accepted).toBe(true);
    expect(providerRuntime.read).toHaveBeenCalledTimes(1);
    expect(providerRuntime.answer).toHaveBeenCalledTimes(1);
    expect(coreRuntime.read).not.toHaveBeenCalled();
    expect(coreRuntime.answer).not.toHaveBeenCalled();
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
    ['NO_PENDING_INPUT', 'internal-session-id'],
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
