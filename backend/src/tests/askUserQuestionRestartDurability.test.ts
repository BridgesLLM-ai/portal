import {
  ASK_USER_MAX_WAIT_MS,
  __resetAskUserQuestionsForTests,
  commitAskUserQuestionAnswer,
  commitAskUserQuestionCancellation,
  listPendingAskUserQuestions,
  prepareAskUserQuestionAnswer,
  reconcilePendingAskUserQuestions,
  registerAskUserQuestion,
  releaseAskUserQuestionDelivery,
  reserveAskUserQuestionDelivery,
} from '../services/askUserQuestionBroker';
import {
  deliverNativeAskUserQuestionAnswer,
  syncNativeAskUserQuestionsForActor,
  type NativeAskUserQuestionChannelDependencies,
} from '../services/nativeAskUserQuestionChannel';

const mockResolveActiveEmbeddedRunSessionId = jest.fn();

jest.mock('openclaw/plugin-sdk/agent-harness-runtime', () => ({
  resolveActiveEmbeddedRunSessionId: mockResolveActiveEmbeddedRunSessionId,
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const askUserPlugin = require('../../../installer/openclaw-ask-user-plugin/index.js');

/**
 * OpenClaw 2026.9.1 owns native question state and settlement. The Portal
 * broker is only a bounded presentation cache, and plugin 4.0 owns no question
 * tool, hook, answer method, or question receipt. After either process restarts,
 * Portal must re-attest the native request before it can present or settle it.
 *
 * Plugin 4.0 does retain exact-run steering with process-local deduplication.
 * The steering checks below pin that narrow boundary without recreating the
 * retired custom question authority in a mixed-generation fixture.
 */

const sessionKey = 'agent:main:portal-owner';
const expectedRunId = 'portal-run-11111111-1111-4111-8111-111111111111';
const requestId = 'request-22222222-2222-4222-8222-222222222222';
const ownerUserId = 'user-1';

const questions = [{
  id: 'database',
  header: 'Database',
  question: 'Which database should I use?',
  multiSelect: false as const,
  options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
}];

type GatewayHandler = (input: {
  params: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
}) => Promise<void>;

/**
 * Models the pinned OpenClaw active-run steering bridge. `restart()` drops the
 * active run and plugin steering receipts together, as a Gateway restart does.
 */
class FakeOpenClawProcess {
  private activeRunId: string | null = null;

  startRun(runId = expectedRunId): void {
    this.activeRunId = runId;
  }

  restart(): void {
    this.activeRunId = null;
    askUserPlugin.__test.reset();
  }

  readonly api = Object.freeze({
    version: 1,
    steer: async (session: unknown, runId: unknown) => {
      if (String(session) !== sessionKey || this.activeRunId === null) {
        return { ok: false as const, code: 'NO_ACTIVE_RUN' };
      }
      if (String(runId) !== this.activeRunId) {
        return { ok: false as const, code: 'RUN_MISMATCH', runId: this.activeRunId };
      }
      this.deliveries += 1;
      return { ok: true as const, code: 'STEERED', runId: this.activeRunId };
    },
  });

  /** How many times text actually entered an active run. */
  deliveries = 0;
}

interface PluginRegistrations {
  methods: Map<string, GatewayHandler>;
  tools: unknown[];
  hooks: unknown[];
}

function registerPlugin(): PluginRegistrations {
  const methods = new Map<string, GatewayHandler>();
  const tools: unknown[] = [];
  const hooks: unknown[] = [];
  askUserPlugin.register({
    registerGatewayMethod: (method: string, handler: GatewayHandler) => {
      methods.set(method, handler);
    },
    registerTool: (...args: unknown[]) => { tools.push(args); },
    on: (...args: unknown[]) => { hooks.push(args); },
  });
  return { methods, tools, hooks };
}

async function invoke(
  handler: GatewayHandler,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; payload: any }> {
  let response: any;
  await handler({
    params,
    respond: (ok, payload) => { response = { ok, payload }; },
  });
  if (!response) throw new Error('gateway handler did not respond');
  return response;
}

describe('OpenClaw 2026.9.1 plugin ownership and steering restart semantics', () => {
  const runtimeSymbol = askUserPlugin.__test.ACTIVE_RUN_RUNTIME_SYMBOL;
  const steerMethod = askUserPlugin.__test.GATEWAY_METHODS.steer;
  let openclaw: FakeOpenClawProcess;
  let registrations: PluginRegistrations;

  beforeEach(() => {
    __resetAskUserQuestionsForTests();
    askUserPlugin.__test.reset();
    openclaw = new FakeOpenClawProcess();
    openclaw.startRun();
    Object.defineProperty(globalThis, runtimeSymbol, {
      value: openclaw.api,
      configurable: true,
    });
    mockResolveActiveEmbeddedRunSessionId.mockReturnValue(sessionKey);
    registrations = registerPlugin();
  });

  afterEach(() => {
    delete (globalThis as any)[runtimeSymbol];
    __resetAskUserQuestionsForTests();
    askUserPlugin.__test.reset();
  });

  const steerParams = {
    sessionKey,
    expectedRunId,
    requestId,
    text: 'PostgreSQL',
  };

  test('registers only exact-run steer', () => {
    expect(askUserPlugin.__test.GATEWAY_METHODS).toEqual({
      steer: 'bridgesllm.ask_user.steer',
    });
    expect([...registrations.methods.keys()]).toEqual(['bridgesllm.ask_user.steer']);
    expect(registrations.tools).toEqual([]);
    expect(registrations.hooks).toEqual([]);
    expect(askUserPlugin.__test.RUNTIME_SYMBOL).toBeUndefined();
    expect(askUserPlugin.__test.GENERIC_PENDING_TTL_MS).toBeUndefined();
    expect(askUserPlugin.__test.GATEWAY_METHODS.answer).toBeUndefined();
    expect(askUserPlugin.__test.GATEWAY_METHODS.pending).toBeUndefined();
    expect(askUserPlugin.__test.GATEWAY_METHODS.dismiss).toBeUndefined();
  });

  test('an interrupted response replays the exact steer and enters the run once', async () => {
    const first = await invoke(registrations.methods.get(steerMethod)!, steerParams);
    expect(first.payload).toMatchObject({ accepted: true, replayed: false });
    expect(openclaw.deliveries).toBe(1);

    const replay = await invoke(registrations.methods.get(steerMethod)!, steerParams);
    expect(replay.payload).toMatchObject({ accepted: true, replayed: true });
    expect(openclaw.deliveries).toBe(1);
  });

  test('changed text under a completed steer identity is refused', async () => {
    await invoke(registrations.methods.get(steerMethod)!, steerParams);
    const conflicting = await invoke(registrations.methods.get(steerMethod)!, {
      ...steerParams,
      text: 'SQLite',
    });
    expect(conflicting.payload?.accepted).not.toBe(true);
    expect(conflicting.payload).toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect(openclaw.deliveries).toBe(1);
  });

  test('a gateway restart drops steering receipts and rejects a stale run identity', async () => {
    const accepted = await invoke(registrations.methods.get(steerMethod)!, steerParams);
    expect(accepted.payload).toMatchObject({ accepted: true });
    expect(openclaw.deliveries).toBe(1);

    openclaw.restart();

    const afterRestart = await invoke(registrations.methods.get(steerMethod)!, steerParams);
    expect(afterRestart.payload?.accepted).not.toBe(true);
    expect(afterRestart.payload).toMatchObject({ code: 'NO_ACTIVE_RUN' });
    expect(openclaw.deliveries).toBe(1);

    openclaw.startRun('portal-run-44444444-4444-4444-8444-444444444444');
    const staleIdentity = await invoke(registrations.methods.get(steerMethod)!, steerParams);
    expect(staleIdentity.payload?.accepted).not.toBe(true);
    expect(staleIdentity.payload).toMatchObject({ code: 'RUN_MISMATCH' });
    expect(openclaw.deliveries).toBe(1);
  });
});

describe('Portal broker restart semantics', () => {
  const candidate = {
    sessionKey,
    runId: expectedRunId,
    ownerUserId,
    surface: 'agent-chat' as const,
    authorityId: 'host-run-1',
    actorAuthorizationVersion: 7,
    projectIdentityId: null,
  };
  const proof = { ...candidate, toolCallId: requestId };

  function channel(
    runtime: { pending: boolean; answerRuntime: jest.Mock },
  ): NativeAskUserQuestionChannelDependencies {
    return {
      discoverRuns: jest.fn(async () => [candidate]),
      readPending: jest.fn(async () => (runtime.pending
        ? {
            pending: true as const,
            runId: expectedRunId,
            requestId,
            questions,
            createdAt: Date.now(),
            expiresAt: Date.now() + ASK_USER_MAX_WAIT_MS,
          }
        : { pending: false as const })),
      attestRuntimeRequest: jest.fn(async () => proof),
      register: registerAskUserQuestion,
      reconcile: reconcilePendingAskUserQuestions,
      list: listPendingAskUserQuestions,
      reattestRecord: jest.fn(async (id: string) => {
        const found = listPendingAskUserQuestions({ actorUserId: ownerUserId })
          .find((entry) => entry.id === id);
        if (!found) throw new Error('reattestation failed');
        return { ...found, ...proof } as any;
      }),
      prepareAnswer: prepareAskUserQuestionAnswer,
      reserveDelivery: reserveAskUserQuestionDelivery,
      answerRuntime: runtime.answerRuntime as any,
      dismissRuntime: jest.fn(),
      commitAnswer: commitAskUserQuestionAnswer,
      commitCancellation: commitAskUserQuestionCancellation,
      releaseDelivery: releaseAskUserQuestionDelivery,
    };
  }

  beforeEach(() => __resetAskUserQuestionsForTests());
  afterEach(() => __resetAskUserQuestionsForTests());

  test('a Portal restart never re-presents a request the runtime already settled', async () => {
    const runtime = { pending: true, answerRuntime: jest.fn() };
    const deps = channel(runtime);
    expect(await syncNativeAskUserQuestionsForActor(
      { actorUserId: ownerUserId, actorAuthorizationVersion: 7 },
      deps,
    )).toHaveLength(1);

    // The answer lands, then Portal restarts and loses its whole cache. The
    // runtime is the only authority for what is still pending.
    __resetAskUserQuestionsForTests();
    runtime.pending = false;

    expect(await syncNativeAskUserQuestionsForActor(
      { actorUserId: ownerUserId, actorAuthorizationVersion: 7 },
      deps,
    )).toEqual([]);
    expect(runtime.answerRuntime).not.toHaveBeenCalled();
  });

  test('a gateway restart leaves no answerable card behind', async () => {
    const runtime = {
      pending: true,
      answerRuntime: jest.fn(async () => { throw new Error('socket closed'); }),
    };
    const deps = channel(runtime);
    const [card] = await syncNativeAskUserQuestionsForActor(
      { actorUserId: ownerUserId, actorAuthorizationVersion: 7 },
      deps,
    );

    // Delivery is interrupted, so the record must stay pending rather than
    // claim an answer Portal never confirmed.
    await expect(deliverNativeAskUserQuestionAnswer(
      { id: card.id, actorUserId: ownerUserId, answers: { database: 'PostgreSQL' } },
      deps,
    )).rejects.toThrow('socket closed');
    expect(listPendingAskUserQuestions({ actorUserId: ownerUserId })).toHaveLength(1);

    // The gateway restarts: the run is gone, so the next reconciliation must
    // retire the card instead of offering a retry that can never be delivered.
    runtime.pending = false;
    expect(await syncNativeAskUserQuestionsForActor(
      { actorUserId: ownerUserId, actorAuthorizationVersion: 7 },
      deps,
    )).toEqual([]);
    expect(listPendingAskUserQuestions({ actorUserId: ownerUserId })).toHaveLength(0);
  });
});
