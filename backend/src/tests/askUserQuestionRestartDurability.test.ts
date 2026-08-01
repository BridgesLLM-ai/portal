import fs from 'fs';
import path from 'path';
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
 * Accepted-answer receipts are process-local, in both the Portal broker and the
 * OpenClaw plugin. These tests pin the invariant that makes that safe rather
 * than merely convenient:
 *
 *   A receipt only ever has to outlive a transport failure, never a process.
 *
 * The pending native request and its receipt are owned by the same OpenClaw
 * process. If that process restarts, the embedded run that was waiting on the
 * answer dies with it, so there is nothing left to deliver an answer into and a
 * replay is not merely unavailable — it is meaningless. Every restart path must
 * therefore fail closed, and no path may ever settle a question twice.
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
 * Models the patched OpenClaw bundle: one in-process registry of active runs,
 * each holding at most one pending native request. `restart()` is the whole
 * point — it drops runs and receipts together, exactly as a gateway restart
 * does, because both live in the same process.
 */
class FakeOpenClawProcess {
  private runs = new Map<string, { requestId: string; settled: boolean }>();

  startRun(): void {
    this.runs.set(`${sessionKey}\0${expectedRunId}`, { requestId, settled: false });
  }

  restart(): void {
    this.runs.clear();
    askUserPlugin.__test.reset();
  }

  private lookup(session: unknown, runId: unknown) {
    const run = this.runs.get(`${String(session)}\0${String(runId)}`);
    if (!run) return { ok: false as const, code: 'NO_ACTIVE_RUN' };
    return { ok: true as const, run };
  }

  readonly api = Object.freeze({
    version: 1,
    read: (session: unknown, runId: unknown) => {
      const lookup = this.lookup(session, runId);
      if (!lookup.ok || lookup.run.settled) return null;
      return {
        requestId,
        runId: expectedRunId,
        createdAt: 1_000,
        expiresAt: 601_000,
        questions: [{
          id: 'database',
          header: 'Database',
          question: 'Which database should I use?',
          isOther: false,
          isSecret: false,
          options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
        }],
      };
    },
    answer: (session: unknown, runId: unknown, id: unknown) => {
      const lookup = this.lookup(session, runId);
      if (!lookup.ok) return lookup;
      if (lookup.run.settled) {
        return { ok: false as const, code: 'NO_PENDING_INPUT', runId: expectedRunId };
      }
      if (String(id) !== lookup.run.requestId) {
        return { ok: false as const, code: 'REQUEST_MISMATCH', runId: expectedRunId };
      }
      lookup.run.settled = true;
      this.settlements += 1;
      return { ok: true as const, code: 'ANSWERED', requestId, runId: expectedRunId };
    },
    dismiss: (session: unknown, runId: unknown) => {
      const lookup = this.lookup(session, runId);
      if (!lookup.ok) return lookup;
      lookup.run.settled = true;
      this.settlements += 1;
      return { ok: true as const, code: 'DISMISSED', requestId, runId: expectedRunId };
    },
    steer: async () => ({ ok: false as const, code: 'PENDING_INPUT', runId: expectedRunId }),
  });

  /** How many times the run was actually settled. Must never exceed one. */
  settlements = 0;
}

function registerPlugin(): Map<string, GatewayHandler> {
  const registrations = new Map<string, GatewayHandler>();
  askUserPlugin.register({
    registerGatewayMethod: (method: string, handler: GatewayHandler) => {
      registrations.set(method, handler);
    },
  });
  return registrations;
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

describe('native pending-input restart semantics', () => {
  const runtimeSymbol = askUserPlugin.__test.RUNTIME_SYMBOL;
  const answerMethod = askUserPlugin.__test.GATEWAY_METHODS.answer;
  let openclaw: FakeOpenClawProcess;
  let handlers: Map<string, GatewayHandler>;

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
    handlers = registerPlugin();
  });

  afterEach(() => {
    delete (globalThis as any)[runtimeSymbol];
    __resetAskUserQuestionsForTests();
    askUserPlugin.__test.reset();
  });

  const answerParams = {
    sessionKey,
    expectedRunId,
    requestId,
    text: 'PostgreSQL',
  };

  test('a receipt can never expire while its own request is still answerable', () => {
    // The receipt window has to cover the entire window in which a retry is
    // still meaningful. The request's own ceiling is OpenClaw's documented
    // per-hook budget, which the hotfix pins in the patched bundle.
    const hotfix = fs.readFileSync(
      path.join(__dirname, '../../../scripts/patch-openclaw-codex-pending-input-hotfix.sh'),
      'utf8',
    );
    const declared = hotfix.match(/BRIDGESLLM_PENDING_INPUT_TTL_MS\s*=\s*([^;\n]+);/);
    expect(declared).not.toBeNull();
    // eslint-disable-next-line no-eval
    const requestTtlMs = Number(eval(declared![1]));
    expect(requestTtlMs).toBe(ASK_USER_MAX_WAIT_MS);
    expect(askUserPlugin.__test.TERMINAL_RECEIPT_TTL_MS).toBeGreaterThan(requestTtlMs);
  });

  test('an interrupted response replays the exact answer and settles the run once', async () => {
    const first = await invoke(handlers.get(answerMethod)!, answerParams);
    expect(first.payload).toMatchObject({ accepted: true, replayed: false });
    expect(openclaw.settlements).toBe(1);

    // Portal never saw that response. The exact retry must be admitted from the
    // receipt rather than re-entering the runtime.
    const replay = await invoke(handlers.get(answerMethod)!, answerParams);
    expect(replay.payload).toMatchObject({ accepted: true, replayed: true });
    expect(openclaw.settlements).toBe(1);
  });

  test('a changed answer after an interrupted response is refused, never delivered', async () => {
    await invoke(handlers.get(answerMethod)!, answerParams);
    const conflicting = await invoke(handlers.get(answerMethod)!, {
      ...answerParams,
      text: 'SQLite',
    });
    expect(conflicting.payload?.accepted).not.toBe(true);
    expect(conflicting.payload).toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect(openclaw.settlements).toBe(1);
  });

  test('a gateway restart makes replay impossible instead of duplicating the answer', async () => {
    const accepted = await invoke(handlers.get(answerMethod)!, answerParams);
    expect(accepted.payload).toMatchObject({ accepted: true });
    expect(openclaw.settlements).toBe(1);

    // The response is lost and the gateway restarts. The run that was waiting
    // on this answer died with the process, so there is nothing to replay into.
    openclaw.restart();

    const afterRestart = await invoke(handlers.get(answerMethod)!, answerParams);
    expect(afterRestart.payload?.accepted).not.toBe(true);
    expect(afterRestart.payload).toMatchObject({ code: 'NO_ACTIVE_RUN' });
    expect(openclaw.settlements).toBe(1);

    // A brand new run in the restarted process is a different request. The old
    // request identity must not unlock it.
    openclaw.startRun();
    const staleIdentity = await invoke(handlers.get(answerMethod)!, {
      ...answerParams,
      requestId: 'request-33333333-3333-4333-8333-333333333333',
    });
    expect(staleIdentity.payload?.accepted).not.toBe(true);
    expect(openclaw.settlements).toBe(1);
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
