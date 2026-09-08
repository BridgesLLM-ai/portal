const mockResolveActiveEmbeddedRunSessionId = jest.fn();

jest.mock('openclaw/plugin-sdk/agent-harness-runtime', () => ({
  resolveActiveEmbeddedRunSessionId: mockResolveActiveEmbeddedRunSessionId,
}), { virtual: true });

// Pin tests to the exact CommonJS entry point copied into OpenClaw's extension
// directory. OpenClaw supplies the SDK alias mocked above.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runtimeGuardPlugin = require('../../../installer/openclaw-ask-user-plugin/index.js');

type GatewayHandler = (input: {
  params: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
  context?: Record<string, any>;
}) => Promise<void>;

type RegisteredMethod = {
  handler: GatewayHandler;
  options: Record<string, unknown>;
};

type Registrations = {
  methods: Map<string, RegisteredMethod>;
  registerTool: jest.Mock;
  on: jest.Mock;
};

function register(): Registrations {
  const methods = new Map<string, RegisteredMethod>();
  const registerTool = jest.fn();
  const on = jest.fn();
  runtimeGuardPlugin.register({
    registerGatewayMethod: (
      method: string,
      handler: GatewayHandler,
      options: Record<string, unknown>,
    ) => methods.set(method, { handler, options }),
    registerTool,
    on,
  });
  return { methods, registerTool, on };
}

async function invoke(
  handler: GatewayHandler,
  params: Record<string, unknown>,
  context?: Record<string, any>,
): Promise<{ ok: boolean; payload: any; error: any }> {
  let response: any;
  await handler({
    params,
    respond: (ok, payload, error) => {
      response = { ok, payload, error };
    },
    context,
  });
  if (!response) throw new Error('gateway handler did not respond');
  return response;
}

function method(
  registrations: Registrations,
  name: 'steer',
): GatewayHandler {
  const registered = registrations.methods.get(runtimeGuardPlugin.__test.GATEWAY_METHODS[name]);
  if (!registered) throw new Error(`${name} gateway method was not registered`);
  return registered.handler;
}

const expectedRunId = 'portal-run-11111111-1111-4111-8111-111111111111';
const requestId = 'request-22222222-2222-4222-8222-222222222222';
const validSteer = {
  sessionKey: 'agent:main:portal-owner',
  expectedRunId,
  requestId,
  text: 'Continue with PostgreSQL.',
};

function installActiveRunRuntime(overrides: Record<string, unknown> = {}) {
  const runtime = Object.freeze({
    version: 1,
    steer: jest.fn(async () => ({
      ok: true,
      code: 'STEERED',
      runId: expectedRunId,
    })),
    ...overrides,
  });
  (globalThis as any)[runtimeGuardPlugin.__test.ACTIVE_RUN_RUNTIME_SYMBOL] = runtime;
  return runtime as any;
}

describe('OpenClaw 2026.9.1 exact-run steer plugin', () => {
  beforeEach(() => {
    runtimeGuardPlugin.__test.reset();
    mockResolveActiveEmbeddedRunSessionId.mockReset();
    delete (globalThis as any)[runtimeGuardPlugin.__test.ACTIVE_RUN_RUNTIME_SYMBOL];
  });

  afterEach(() => {
    delete (globalThis as any)[runtimeGuardPlugin.__test.ACTIVE_RUN_RUNTIME_SYMBOL];
    jest.restoreAllMocks();
  });

  test('registers only exact-run steer while native OpenClaw owns questions', () => {
    const registrations = register();

    expect([...registrations.methods.keys()]).toEqual([
      'bridgesllm.ask_user.steer',
    ]);
    expect(registrations.methods.get('bridgesllm.ask_user.steer')?.options)
      .toEqual({ scope: 'operator.write' });
    expect(registrations.registerTool).not.toHaveBeenCalled();
    expect(registrations.on).not.toHaveBeenCalled();
    expect([...registrations.methods.keys()]).not.toEqual(expect.arrayContaining([
      'bridgesllm.ask_user.probe',
      'bridgesllm.ask_user.pending',
      'bridgesllm.ask_user.answer',
      'bridgesllm.ask_user.dismiss',
    ]));
  });

  test('steers the exact active session and attested run', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const runtime = installActiveRunRuntime();

    await expect(invoke(method(register(), 'steer'), validSteer)).resolves.toEqual({
      ok: true,
      payload: {
        accepted: true,
        code: 'STEERED',
        requestId,
        runId: expectedRunId,
        replayed: false,
      },
      error: undefined,
    });
    expect(mockResolveActiveEmbeddedRunSessionId)
      .toHaveBeenCalledWith(validSteer.sessionKey);
    expect(runtime.steer).toHaveBeenCalledWith(
      'internal-session-id',
      expectedRunId,
      validSteer.text,
    );
  });

  test('fails closed when no exact active run can be resolved', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
    const runtime = installActiveRunRuntime();

    await expect(invoke(method(register(), 'steer'), validSteer)).resolves.toEqual({
      ok: true,
      payload: {
        accepted: false,
        code: 'NO_ACTIVE_RUN',
        requestId,
      },
      error: undefined,
    });
    expect(runtime.steer).not.toHaveBeenCalled();
  });

  test('deduplicates exact retries and rejects a changed payload for one request id', async () => {
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue('internal-session-id');
    const runtime = installActiveRunRuntime();
    const steer = method(register(), 'steer');

    const first = await invoke(steer, validSteer);
    const replay = await invoke(steer, validSteer);
    const conflict = await invoke(steer, { ...validSteer, text: 'Use SQLite instead.' });

    expect(first.payload).toMatchObject({ accepted: true, replayed: false });
    expect(replay.payload).toMatchObject({ accepted: true, replayed: true });
    expect(conflict.payload).toEqual({
      accepted: false,
      code: 'REQUEST_CONFLICT',
      requestId,
      runId: expectedRunId,
    });
    expect(runtime.steer).toHaveBeenCalledTimes(1);
  });

  test('rejects malformed steer input before resolving or touching a run', async () => {
    const runtime = installActiveRunRuntime();
    const response = await invoke(method(register(), 'steer'), {
      ...validSteer,
      text: `bad${String.fromCharCode(0)}text`,
    });

    expect(response).toMatchObject({
      ok: false,
      payload: { accepted: false, code: 'INVALID_REQUEST' },
      error: { code: 'invalid_request' },
    });
    expect(mockResolveActiveEmbeddedRunSessionId).not.toHaveBeenCalled();
    expect(runtime.steer).not.toHaveBeenCalled();
  });

});
