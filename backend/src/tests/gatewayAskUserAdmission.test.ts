const assertOpenClawExecutionAdmittedMock = jest.fn();
const syncAskUserQuestionsForActorMock = jest.fn();
const deliverAskUserQuestionAnswerMock = jest.fn();
const deliverAskUserQuestionDismissalMock = jest.fn();
const readPendingAskUserQuestionForActorMock = jest.fn();

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';

jest.mock('../services/openClawExecutionAdmission', () => ({
  ...jest.requireActual('../services/openClawExecutionAdmission'),
  assertOpenClawExecutionAdmitted: assertOpenClawExecutionAdmittedMock,
}));

jest.mock('../services/nativeAskUserQuestionChannel', () => ({
  ...jest.requireActual('../services/nativeAskUserQuestionChannel'),
  syncAskUserQuestionsForActor: syncAskUserQuestionsForActorMock,
  deliverAskUserQuestionAnswer: deliverAskUserQuestionAnswerMock,
  deliverAskUserQuestionDismissal: deliverAskUserQuestionDismissalMock,
}));

jest.mock('../services/askUserQuestionBroker', () => ({
  ...jest.requireActual('../services/askUserQuestionBroker'),
  readPendingAskUserQuestionForActor: readPendingAskUserQuestionForActorMock,
}));

const gatewayRouter = require('../routes/gateway').default as typeof import('../routes/gateway').default;
const { OpenClawExecutionAdmissionError } = require('../services/openClawExecutionAdmission') as
  typeof import('../services/openClawExecutionAdmission');

function routeHandler(path: string): (req: any, res: any) => Promise<void> {
  const layer = (gatewayRouter as any).stack.find((entry: any) => entry.route?.path === path);
  if (!layer) throw new Error(`gateway ${path} route not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function responseDouble() {
  const response: any = {
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

const unavailableAdmission = {
  state: 'maintenance' as const,
  ready: false,
  reason: 'OpenClaw maintenance is active.',
  checkedAt: '2026-08-31T20:00:00.000Z',
  evidence: {
    authorizationFence: 'absent' as const,
    maintenanceMarker: 'present' as const,
    hostMutationJournal: 'absent' as const,
  },
  readinessBlockers: [],
};

describe('provider-neutral ask-user route admission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertOpenClawExecutionAdmittedMock.mockResolvedValue({ state: 'ready', ready: true });
    syncAskUserQuestionsForActorMock.mockResolvedValue([]);
    readPendingAskUserQuestionForActorMock.mockReturnValue({
      id: 'askq_project',
      surface: 'project-chat',
    });
    deliverAskUserQuestionAnswerMock.mockResolvedValue({
      record: { id: 'askq_project', state: 'answered' },
      idempotentReplay: false,
    });
    deliverAskUserQuestionDismissalMock.mockResolvedValue({
      record: { id: 'askq_project', state: 'cancelled' },
      idempotentReplay: false,
    });
  });

  test.each([
    ['/ask-user/pending', { query: {} }],
    ['/ask-user/answer', { body: { id: 'askq_project', answers: { database: 'PostgreSQL' } } }],
    ['/ask-user/dismiss', { body: { id: 'askq_project' } }],
  ])('%s fails closed before broker or runtime I/O', async (path, request) => {
    assertOpenClawExecutionAdmittedMock.mockRejectedValue(
      new OpenClawExecutionAdmissionError(unavailableAdmission),
    );
    const response = responseDouble();

    await routeHandler(path)({
      ...request,
      user: { userId: 'user-1', authorizationVersion: 7 },
    }, response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'OPENCLAW_EXECUTION_MAINTENANCE',
      retryable: true,
    }));
    expect(syncAskUserQuestionsForActorMock).not.toHaveBeenCalled();
    expect(readPendingAskUserQuestionForActorMock).not.toHaveBeenCalled();
    expect(deliverAskUserQuestionAnswerMock).not.toHaveBeenCalled();
    expect(deliverAskUserQuestionDismissalMock).not.toHaveBeenCalled();
  });

  test('Project Chat answers pass the same central admission boundary as Agent Chat', async () => {
    const response = responseDouble();

    await routeHandler('/ask-user/answer')({
      body: { id: 'askq_project', answers: { database: 'PostgreSQL' } },
      user: { userId: 'user-1', authorizationVersion: 7 },
    }, response);

    expect(assertOpenClawExecutionAdmittedMock).toHaveBeenCalledTimes(1);
    expect(readPendingAskUserQuestionForActorMock).toHaveBeenCalledWith(
      'askq_project',
      'user-1',
    );
    expect(deliverAskUserQuestionAnswerMock).toHaveBeenCalledTimes(1);
    expect(response.json).toHaveBeenCalledWith({
      ok: true,
      id: 'askq_project',
      state: 'answered',
      idempotentReplay: false,
    });
  });
});
