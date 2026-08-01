import {
  __resetAskUserQuestionsForTests,
  AskUserQuestionError,
  ASK_USER_MAX_WAIT_MS,
  commitAskUserQuestionAnswer,
  commitAskUserQuestionCancellation,
  formatAskUserAnswerForModel,
  listPendingAskUserQuestions,
  normalizeAskUserQuestions,
  prepareAskUserQuestionAnswer,
  reconcilePendingAskUserQuestions,
  registerAskUserQuestion,
  releaseAskUserQuestionDelivery,
  reserveAskUserQuestionDelivery,
  subscribeAskUserQuestions,
} from '../services/askUserQuestionBroker';

describe('native ask-user question broker', () => {
  afterEach(() => __resetAskUserQuestionsForTests());

  const sampleQuestions = [{
    id: 'database',
    question: 'Which database should the project use?',
    header: 'Database',
    multiSelect: false,
    isOther: true,
    options: [
      { label: 'PostgreSQL', description: 'Already installed' },
      { label: 'SQLite' },
    ],
  }];
  const agentAuthority = {
    sessionKey: 'agent:main:main',
    runId: 'upstream-run-1',
    toolCallId: 'native-request-1',
    ownerUserId: 'user-1',
    surface: 'agent-chat' as const,
    authorityId: 'host-run-1',
    actorAuthorizationVersion: 1,
    projectIdentityId: null,
  };

  function register(overrides: Record<string, unknown> = {}) {
    return registerAskUserQuestion({
      ...agentAuthority,
      questions: sampleQuestions,
      ...overrides,
    } as any);
  }

  test('registers a runtime-identified, owner-scoped public card with surface', () => {
    const record = register();
    expect(record.id).toMatch(/^askq_[0-9a-f]{24}$/);
    expect(record.questions[0]).toMatchObject({ id: 'database', isOther: true });
    expect(listPendingAskUserQuestions({
      actorUserId: 'user-1',
      sessionKey: agentAuthority.sessionKey,
    })).toEqual([expect.objectContaining({
      id: record.id,
      surface: 'agent-chat',
      questions: [expect.objectContaining({ id: 'database' })],
    })]);
    expect(listPendingAskUserQuestions({ actorUserId: 'user-2' })).toEqual([]);
  });

  test('prepares the raw single answer without settling, then commits only after reservation', () => {
    const record = register();
    const prepared = prepareAskUserQuestionAnswer({
      id: record.id,
      actorUserId: 'user-1',
      answers: { database: 'PostgreSQL' },
    });
    expect(prepared.text).toBe('PostgreSQL');
    expect(record.state).toBe('pending');
    expect(record.answers).toBeNull();

    const reservation = reserveAskUserQuestionDelivery(record.id, 'user-1');
    try {
      expect(commitAskUserQuestionAnswer(prepared, reservation)).toBe(record);
    } finally {
      releaseAskUserQuestionDelivery(reservation);
    }
    expect(record.state).toBe('answered');
    expect(record.answers).toEqual({ database: 'PostgreSQL' });
    expect(Object.getPrototypeOf(record.answers)).toBeNull();
    expect(formatAskUserAnswerForModel(record)).toBe('PostgreSQL');
  });

  test('formats multiple answers as parser-safe numeric keyed lines', () => {
    const record = register({
      questions: [
        { id: 'database', question: 'Database?', options: [] },
        { id: 'region', question: 'Region?', options: [] },
      ],
    });
    const prepared = prepareAskUserQuestionAnswer({
      id: record.id,
      actorUserId: 'user-1',
      answers: { database: 'PostgreSQL', region: 'us-east-1' },
    });
    expect(prepared.text).toBe('1: PostgreSQL\n2: us-east-1');
  });

  test('numeric formatting survives native IDs that are not valid OpenClaw line keys', () => {
    const record = register({
      questions: [
        { id: 'db-choice', question: 'Database?', options: [] },
        { id: 'region:primary=1', question: 'Region?', options: [] },
      ],
    });
    const prepared = prepareAskUserQuestionAnswer({
      id: record.id,
      actorUserId: 'user-1',
      answers: {
        'db-choice': 'PostgreSQL',
        'region:primary=1': 'us-east-1',
      },
    });
    expect(prepared.text).toBe('1: PostgreSQL\n2: us-east-1');
  });

  test('rejects incomplete and unknown answer identities without mutation', () => {
    const record = register({
      questions: [
        { id: 'first', question: 'First?', options: [] },
        { id: 'second', question: 'Second?', options: [] },
      ],
    });
    expect(() => prepareAskUserQuestionAnswer({
      id: record.id,
      actorUserId: 'user-1',
      answers: { first: 'one' },
    })).toThrow(/Every question requires an answer/i);
    expect(() => prepareAskUserQuestionAnswer({
      id: record.id,
      actorUserId: 'user-1',
      answers: { first: 'one', second: 'two', extra: 'nope' },
    })).toThrow(/unknown question identity/i);
    expect(record.state).toBe('pending');
  });

  test('rejects free text when native Codex only permits listed options', () => {
    const record = register({
      questions: [{
        id: 'database',
        question: 'Database?',
        isOther: false,
        options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
      }],
    });
    expect(() => prepareAskUserQuestionAnswer({
      id: record.id,
      actorUserId: 'user-1',
      answers: { database: 'Oracle' },
    })).toThrow(/must match one of the available options/i);
    expect(prepareAskUserQuestionAnswer({
      id: record.id,
      actorUserId: 'user-1',
      answers: { database: '2' },
    }).text).toBe('SQLite');
    expect(prepareAskUserQuestionAnswer({
      id: record.id,
      actorUserId: 'user-1',
      answers: { database: 'postgresql' },
    }).text).toBe('PostgreSQL');
  });

  test('serializes delivery and leaves the record pending when delivery is released uncommitted', () => {
    const record = register();
    const first = reserveAskUserQuestionDelivery(record.id, 'user-1');
    expect(() => reserveAskUserQuestionDelivery(record.id, 'user-1'))
      .toThrow(/already being delivered/i);
    releaseAskUserQuestionDelivery(first);
    expect(record.state).toBe('pending');
    const retry = reserveAskUserQuestionDelivery(record.id, 'user-1');
    releaseAskUserQuestionDelivery(retry);
  });

  test('dismissal is also a post-delivery commit', () => {
    const record = register();
    const reservation = reserveAskUserQuestionDelivery(record.id, 'user-1');
    try {
      commitAskUserQuestionCancellation(reservation);
    } finally {
      releaseAskUserQuestionDelivery(reservation);
    }
    expect(record.state).toBe('cancelled');
    expect(formatAskUserAnswerForModel(record)).toMatch(/dismissed/i);
  });

  test('another actor cannot prepare, reserve, discover, or dismiss an owned question', () => {
    const record = register();
    expect(() => prepareAskUserQuestionAnswer({
      id: record.id,
      actorUserId: 'attacker',
      answers: { database: 'SQLite' },
    })).toThrow(/no longer open/i);
    expect(() => reserveAskUserQuestionDelivery(record.id, 'attacker'))
      .toThrow(/no longer open/i);
    expect(listPendingAskUserQuestions({ actorUserId: 'attacker' })).toEqual([]);
    expect(record.state).toBe('pending');
  });

  test.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'treats prototype-shaped native id %s as ordinary data',
    (questionId) => {
      const record = register({
        questions: [{ id: questionId, question: 'Literal?', options: [] }],
      });
      expect(() => prepareAskUserQuestionAnswer({
        id: record.id,
        actorUserId: 'user-1',
        answers: {},
      })).toThrow(/requires an answer/i);
      const supplied = JSON.parse(JSON.stringify({ [questionId]: 'literal answer' }));
      const prepared = prepareAskUserQuestionAnswer({
        id: record.id,
        actorUserId: 'user-1',
        answers: supplied,
      });
      expect(prepared.text).toBe('literal answer');
      expect(prepared.answers[questionId]).toBe('literal answer');
      expect(Object.getPrototypeOf(prepared.answers)).toBeNull();
    },
  );

  test('reconciliation cancels stale runtime calls but not exact active calls', () => {
    const current = register();
    const stale = register({ toolCallId: 'native-request-old' });
    reconcilePendingAskUserQuestions({
      actorUserId: 'user-1',
      activeCalls: [{
        sessionKey: current.sessionKey,
        runId: current.runId,
        toolCallId: current.toolCallId,
      }],
    });
    expect(current.state).toBe('pending');
    expect(stale.state).toBe('cancelled');
    expect(listPendingAskUserQuestions({ actorUserId: 'user-1' }))
      .toEqual([expect.objectContaining({ id: current.id })]);
  });

  test('registration retries are idempotent while changed native payloads conflict', () => {
    const first = register();
    expect(register()).toBe(first);
    expect(() => register({
      questions: [{ id: 'database', question: 'Changed?', options: [] }],
    })).toThrow(/different content/i);
  });

  test('normalization preserves IDs, scrubs controls, and rejects duplicate identities', () => {
    expect(normalizeAskUserQuestions({ questions: sampleQuestions }))
      .toEqual(normalizeAskUserQuestions(sampleQuestions));
    const scrubbed = normalizeAskUserQuestions([{
      id: 'question-1',
      question: 'Pick one\u0007\u001b[31m',
      header: 'A very long header that is truncated',
      options: ['ok', { label: '' }, { label: 'also ok' }],
    }]);
    expect(scrubbed[0].question).toBe('Pick one[31m');
    expect(scrubbed[0].options.map((option) => option.label)).toEqual(['ok', 'also ok']);
    expect(() => register({
      questions: [
        { id: 'same', question: 'One?', options: [] },
        { id: 'same', question: 'Two?', options: [] },
      ],
    })).toThrow(/identities must be unique/i);
  });

  test('broker rejects duplicate native IDs and unsupported multi-select fail closed', () => {
    expect(() => register({
      questions: [
        { id: 'duplicate', question: 'One?', options: [] },
        { id: 'duplicate', question: 'Two?', options: [] },
      ],
    })).toThrow(/identities must be unique/i);
    expect(listPendingAskUserQuestions({ actorUserId: 'user-1' })).toEqual([]);

    expect(() => register({
      questions: [{
        id: 'many',
        question: 'Pick several?',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }],
      }],
    })).toThrow(/do not support multi-select/i);
    expect(listPendingAskUserQuestions({ actorUserId: 'user-1' })).toEqual([]);
  });

  test('wait budget remains bounded and subscribers stay owner-scoped', () => {
    const seen: string[] = [];
    const foreign: string[] = [];
    const unsubscribe = subscribeAskUserQuestions('user-1', (entry) => seen.push(entry.state));
    const unsubscribeForeign = subscribeAskUserQuestions('user-2', (entry) => foreign.push(entry.state));
    const record = register({ waitMs: 99_999_999 });
    expect(record.expiresAt - record.createdAt).toBe(ASK_USER_MAX_WAIT_MS);
    const reservation = reserveAskUserQuestionDelivery(record.id, 'user-1');
    try {
      commitAskUserQuestionCancellation(reservation);
    } finally {
      releaseAskUserQuestionDelivery(reservation);
      unsubscribe();
      unsubscribeForeign();
    }
    expect(seen).toEqual(['pending', 'cancelled']);
    expect(foreign).toEqual([]);
  });

  test('fails closed without server-verified run authority', () => {
    expect(() => register({ ownerUserId: '' })).toThrow(AskUserQuestionError);
    expect(() => register({ runId: '' })).toThrow(AskUserQuestionError);
  });
});
