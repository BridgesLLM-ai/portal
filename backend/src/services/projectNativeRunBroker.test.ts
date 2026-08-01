import type {
  AgentProvider,
  AgentSendResult,
  OnChunkCallback,
  OnStatusCallback,
} from '../agents/AgentProvider.interface';
import { AgentAbortError } from '../agents/AgentProvider.interface';
import { AgentRegistry } from '../agents';
import { streamEventBus } from './StreamEventBus';
import * as projectProviderRegistry from './projectChatProviderRegistry';
import {
  abortProjectNativeRun,
  clearProjectNativeRunBrokerForTests,
  getProjectNativeRunSnapshot,
  PROJECT_NATIVE_MAX_RUN_TEXT,
  quiesceProjectNativeRunForDestructiveReset,
  startProjectNativeRun,
  waitForProjectNativeRunSettlement,
} from './projectNativeRunBroker';

const USER_ID = 'project-owner';
const PROJECT_ID = 'project-a';

let resolveSend: (value: AgentSendResult) => void;
let rejectSend: (error: Error) => void;
let onChunk: OnChunkCallback | undefined;
let onStatus: OnStatusCallback | undefined;
let sendMessage: jest.Mock;
let abortActiveRun: jest.Mock;

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  clearProjectNativeRunBrokerForTests();
  onChunk = undefined;
  onStatus = undefined;
  sendMessage = jest.fn((
    _sessionId: string,
    _message: string,
    chunkCallback?: OnChunkCallback,
    statusCallback?: OnStatusCallback,
  ) => {
    onChunk = chunkCallback;
    onStatus = statusCallback;
    return new Promise<AgentSendResult>((resolve, reject) => {
      resolveSend = resolve;
      rejectSend = reject;
    });
  });
  abortActiveRun = jest.fn().mockResolvedValue(true);
  const provider: AgentProvider = {
    displayName: 'Codex',
    providerName: 'CODEX',
    startSession: jest.fn(),
    sendMessage,
    getHistory: jest.fn(),
    listSessions: jest.fn(),
    terminateSession: jest.fn(),
    abortActiveRun,
  };
  jest.spyOn(AgentRegistry, 'get').mockReturnValue(provider);
  jest.spyOn(streamEventBus, 'startStream').mockImplementation(() => true);
  jest.spyOn(streamEventBus, 'publish').mockImplementation(() => undefined);
  jest.spyOn(streamEventBus, 'updateStreamPhase').mockImplementation(() => true);
  jest.spyOn(streamEventBus, 'softClearStream').mockImplementation(() => true);
  jest.spyOn(streamEventBus, 'clearStream').mockImplementation(() => true);
});

afterEach(() => {
  clearProjectNativeRunBrokerForTests();
  jest.restoreAllMocks();
});

test('streams, rekeys, and completes one Portal-owned Codex project run', async () => {
  const onSessionResolved = jest.fn();
  const onComplete = jest.fn().mockResolvedValue(undefined);
  const initial = startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    sessionId: 'codex-temporary',
    message: 'Inspect this project',
    model: 'gpt-5.5',
    onSessionResolved,
    onComplete,
  });

  expect(initial).toMatchObject({ active: true, complete: false, status: 'running', lastSeq: 1 });
  expect(sendMessage).toHaveBeenCalledWith(
    'codex-temporary',
    'Inspect this project',
    expect.any(Function),
    expect.any(Function),
    expect.any(Function),
    undefined,
  );

  onStatus?.({ type: 'session', sessionId: 'codex-native-thread' });
  onStatus?.({ type: 'thinking', content: 'Planning' });
  onStatus?.({ type: 'tool_start', toolName: 'exec', content: 'Running tests' });
  onChunk?.('Finished safely.');
  resolveSend({
    fullText: 'Finished safely.',
    metadata: { resolvedSessionId: 'codex-native-thread', model: 'gpt-5.5' },
  });
  await flushPromises();
  await flushPromises();

  const snapshot = getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  });
  expect(snapshot).toMatchObject({
    active: false,
    complete: true,
    status: 'completed',
    text: 'Finished safely.',
    sessionId: 'codex-native-thread',
  });
  expect(snapshot?.events.map((event) => event.type)).toEqual([
    'status',
    'thinking',
    'tool_start',
    'text',
    'done',
  ]);
  expect(onSessionResolved).toHaveBeenCalledWith('codex-native-thread');
  expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 'codex-native-thread',
    fullText: 'Finished safely.',
  }));
  expect(snapshot?.status).toBe('completed');
});

test('does not adopt a provider session identity rejected by durable Project attestation', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const onSessionResolved = jest.fn(async (sessionId: string) => {
    if (sessionId !== 'codex-attested-session') {
      throw new Error('provider attempted to replace the immutable Project session');
    }
  });
  const onSettled = jest.fn().mockResolvedValue(undefined);

  startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    sessionId: 'codex-attested-session',
    message: 'Keep this session identity confined',
    onSessionResolved,
    onSettled,
  });

  onStatus?.({ type: 'session', sessionId: 'codex-foreign-session' });
  resolveSend({
    fullText: 'This result belongs to a rejected session identity.',
    metadata: { resolvedSessionId: 'codex-foreign-session' },
  });
  await flushPromises();
  await flushPromises();

  const snapshot = getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  });
  expect(onSessionResolved).toHaveBeenCalledTimes(1);
  expect(onSessionResolved).toHaveBeenCalledWith('codex-foreign-session');
  expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 'codex-attested-session',
    status: 'error',
    error: 'Project session binding persistence failed',
  }));
  expect(snapshot).toMatchObject({
    active: false,
    complete: true,
    status: 'error',
    sessionId: 'codex-attested-session',
    error: 'Project session binding persistence failed',
  });
  expect(snapshot?.events.at(-1)).toMatchObject({
    type: 'error',
    content: 'Project session binding persistence failed',
    terminal: true,
  });
});

test('uses the same bounded durable broker for an OpenClaw Project turn', async () => {
  const sender = {
    label: 'owner@example.com',
    userId: USER_ID,
    role: 'OWNER',
    requestId: 'durable-turn-uuid',
  };
  startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'OPENCLAW',
    runtime: 'openclaw-project-sandbox',
    sessionId: 'agent:portal-project-a:project-a',
    message: 'Inspect safely',
    sender,
  });

  expect(sendMessage).toHaveBeenCalledWith(
    'agent:portal-project-a:project-a',
    'Inspect safely',
    expect.any(Function),
    expect.any(Function),
    expect.any(Function),
    sender,
  );
  onStatus?.({ type: 'thinking', content: 'Planning' });
  onChunk?.('Done.');
  resolveSend({ fullText: 'Done.' });
  await flushPromises();
  await flushPromises();

  expect(getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'OPENCLAW',
  })).toMatchObject({
    active: false,
    complete: true,
    status: 'completed',
    text: 'Done.',
  });
});

test('passes bounded provider fullText to settlement when no text chunks were emitted', async () => {
  const onSettled = jest.fn().mockResolvedValue(undefined);
  startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'OPENCLAW',
    runtime: 'openclaw-project-sandbox',
    sessionId: 'agent:portal-project-a:project-a',
    message: 'Return one final response without streaming',
    onSettled,
  });

  resolveSend({ fullText: 'Authoritative non-streamed response' });
  await flushPromises();
  await flushPromises();

  expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({
    status: 'completed',
    fullText: 'Authoritative non-streamed response',
  }));
});

test.each([
  ['completed' as const, () => resolveSend({ fullText: 'Durable response' }), 'done'],
  ['error' as const, () => rejectSend(new Error('provider failed')), 'error'],
  ['aborted' as const, () => rejectSend(new AgentAbortError()), 'done'],
])(
  'keeps the post-settlement %s broker event out of the inactive durable turn',
  async (status, finishProvider, terminalEventType) => {
    const durableEvents: string[] = [];
    const lifecycle: string[] = [];
    startProjectNativeRun({
      userId: USER_ID,
      projectId: PROJECT_ID,
      provider: 'OPENCLAW',
      runtime: 'openclaw-project-sandbox',
      sessionId: 'agent:portal-project-a:project-a',
      message: 'Finish without a post-settlement append',
      onEvent: (event) => {
        durableEvents.push(event.type);
        lifecycle.push(`durable:${event.type}`);
      },
      onSettled: async (settlement) => {
        lifecycle.push(`settled:${settlement.status}`);
      },
    });

    finishProvider();
    await flushPromises();
    await flushPromises();

    expect(getProjectNativeRunSnapshot({
      userId: USER_ID,
      projectId: PROJECT_ID,
      provider: 'OPENCLAW',
    })).toMatchObject({
      active: false,
      complete: true,
      status,
      events: expect.arrayContaining([
        expect.objectContaining({ type: terminalEventType }),
      ]),
    });
    expect(durableEvents).toEqual(['status']);
    expect(lifecycle).toEqual([
      'durable:status',
      `settled:${status}`,
    ]);
  },
);

test.each([
  ['CLAUDE_CODE' as const, 'claude-code-project-adapter', 'Claude Code'],
  ['GEMINI' as const, 'antigravity-project-adapter', 'Google Antigravity'],
])('uses the durable broker and provider-specific provenance for %s', async (providerName, runtime, label) => {
  startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: providerName,
    runtime,
    sessionId: providerName.toLowerCase() + '-portal-session',
    message: 'Inspect safely',
  });

  expect(AgentRegistry.get).toHaveBeenCalledWith(providerName);
  expect(getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: providerName,
  })?.events[0]).toMatchObject({
    type: 'status',
    content: label + ' is working…',
  });
  resolveSend({
    fullText: 'Done.',
    metadata: { resolvedSessionId: providerName.toLowerCase() + '-portal-session' },
  });
  await flushPromises();
  await flushPromises();
  expect(getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: providerName,
  })).toMatchObject({ active: false, complete: true, status: 'completed' });
});

test('uses the dedicated Agent Zero Project adapter and retains correlated lifecycle events', async () => {
  const dedicated: AgentProvider = {
    displayName: 'Agent Zero (Project Sandbox)',
    providerName: 'AGENT_ZERO',
    startSession: jest.fn(),
    sendMessage,
    getHistory: jest.fn(),
    listSessions: jest.fn(),
    terminateSession: jest.fn(),
    abortActiveRun,
  };
  const resolveProjectAdapter = jest.spyOn(projectProviderRegistry, 'getProjectChatProviderAdapter')
    .mockReturnValue(dedicated);
  jest.mocked(AgentRegistry.get).mockClear();

  startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'AGENT_ZERO',
    runtime: 'agent-zero-project-sandbox-v4',
    sessionId: 'agent-zero-context-1',
    message: 'Inspect safely',
    model: 'codex_oauth/gpt-5.2-codex',
  });
  expect(resolveProjectAdapter).toHaveBeenCalledWith('AGENT_ZERO');
  expect(AgentRegistry.get).not.toHaveBeenCalled();
  onStatus?.({
    type: 'thinking',
    content: 'Planning',
  });
  onStatus?.({
    type: 'tool_start',
    toolName: 'Project file edit',
    toolCallId: 'a0-call-1',
  });
  onStatus?.({
    type: 'tool_update',
    toolName: 'Project file edit',
    toolCallId: 'a0-call-1',
    content: 'Editing',
  });
  onStatus?.({
    type: 'tool_end',
    toolName: 'Project file edit',
    toolCallId: 'a0-call-1',
    completed: true,
  });
  onChunk?.('Done.');
  resolveSend({
    fullText: 'Done.',
    metadata: {
      model: 'gpt-5.2-codex',
      oauthProviderId: 'codex_oauth',
    },
  });
  await flushPromises();
  await flushPromises();

  const snapshot = getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'AGENT_ZERO',
  });
  expect(snapshot).toMatchObject({
    active: false,
    complete: true,
    status: 'completed',
    text: 'Done.',
  });
  expect(snapshot?.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'thinking' }),
    expect.objectContaining({ type: 'tool_start', toolCallId: 'a0-call-1' }),
    expect.objectContaining({ type: 'tool_update', toolCallId: 'a0-call-1' }),
    expect.objectContaining({ type: 'tool_end', toolCallId: 'a0-call-1', completed: true }),
    expect.objectContaining({ type: 'done', model: 'gpt-5.2-codex' }),
  ]));
});

test('fails closed instead of publishing done when transcript persistence fails', async () => {
  startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    sessionId: 'codex-temporary',
    message: 'Persist this',
    onComplete: async () => { throw new Error('database unavailable'); },
  });
  resolveSend({ fullText: 'Response that must be persisted' });
  await flushPromises();
  await flushPromises();

  const snapshot = getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  });
  expect(snapshot).toMatchObject({
    active: false,
    complete: true,
    status: 'error',
    error: 'Project transcript persistence failed',
    text: 'Response that must be persisted',
  });
  expect(snapshot?.events.some((event) => event.type === 'done')).toBe(false);
  expect(snapshot?.events.at(-1)).toMatchObject({
    type: 'error',
    content: 'Project transcript persistence failed',
  });
});

test('publishes a fixed terminal error when durable settlement fails after provider success', async () => {
  const onSettled = jest.fn().mockRejectedValue(new Error('database details must stay private'));
  const durableEvents: string[] = [];
  startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    sessionId: 'codex-temporary',
    message: 'Finish this safely',
    onSettled,
    onEvent: (event) => {
      durableEvents.push(event.type);
    },
  });
  resolveSend({ fullText: 'Provider work completed' });
  await flushPromises();
  await flushPromises();

  const snapshot = getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  });
  expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  expect(snapshot).toMatchObject({
    active: false,
    complete: true,
    status: 'error',
    error: 'Project Chat could not finalize durable turn state. Refresh before retrying.',
    text: 'Provider work completed',
  });
  expect(snapshot?.events.some((event) => event.type === 'done')).toBe(false);
  expect(snapshot?.events.at(-1)).toMatchObject({
    type: 'error',
    content: 'Project Chat could not finalize durable turn state. Refresh before retrying.',
    terminal: true,
  });
  expect(durableEvents).toEqual(['status']);
  expect(JSON.stringify(snapshot)).not.toContain('database details must stay private');
  expect(streamEventBus.clearStream).toHaveBeenCalledWith(
    'codex-temporary',
    expect.any(String),
  );
});

test.each([
  ['provider failure', () => new Error('provider internals'), 'error'],
  ['provider abort', () => new AgentAbortError(), 'aborted'],
] as const)(
  'replaces %s with a fixed terminal error when its durable settlement also fails',
  async (_label, makeProviderError, expectedSettlementStatus) => {
    const onSettled = jest.fn().mockRejectedValue(new Error('database details must stay private'));
    startProjectNativeRun({
      userId: USER_ID,
      projectId: PROJECT_ID,
      provider: 'CODEX',
      runtime: 'codex-project-adapter',
      sessionId: 'codex-temporary',
      message: 'Fail this safely',
      onSettled,
    });
    rejectSend(makeProviderError());
    await flushPromises();
    await flushPromises();

    const snapshot = getProjectNativeRunSnapshot({
      userId: USER_ID,
      projectId: PROJECT_ID,
      provider: 'CODEX',
    });
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({
      status: expectedSettlementStatus,
    }));
    expect(snapshot).toMatchObject({
      active: false,
      complete: true,
      status: 'error',
      error: 'Project Chat could not finalize durable turn state. Refresh before retrying.',
    });
    expect(snapshot?.events.at(-1)).toMatchObject({
      type: 'error',
      content: 'Project Chat could not finalize durable turn state. Refresh before retrying.',
      terminal: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain('database details must stay private');
    expect(JSON.stringify(snapshot)).not.toContain('provider internals');
  },
);

test('aborts through both temporary and rekeyed native session identities', async () => {
  const started = startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    sessionId: 'codex-temporary',
    message: 'Long task',
  });
  onStatus?.({ type: 'session', sessionId: 'codex-native-thread' });
  await flushPromises();

  await expect(abortProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  })).resolves.toBe(true);
  expect(abortActiveRun).toHaveBeenCalledWith('codex-native-thread', started.runId);

  rejectSend(new AgentAbortError());
  await flushPromises();
  const snapshot = getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  });
  expect(snapshot).toMatchObject({
    active: false,
    complete: true,
    status: 'aborted',
    error: 'Turn cancelled',
  });
});

test('abort acknowledgement does not settle before delayed onError and onSettled callbacks finish', async () => {
  let releaseError!: () => void;
  let releaseSettlement!: () => void;
  const errorPending = new Promise<void>((resolve) => { releaseError = resolve; });
  const settlementPending = new Promise<void>((resolve) => { releaseSettlement = resolve; });
  const started = startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    sessionId: 'codex-delayed-abort',
    message: 'Abort while terminal callbacks are delayed',
    onError: () => errorPending,
    onSettled: () => settlementPending,
  });

  await expect(abortProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  })).resolves.toBe(true);
  rejectSend(new AgentAbortError());
  await flushPromises();

  const wait = waitForProjectNativeRunSettlement({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
    runId: started.runId!,
    timeoutMs: 1_000,
  });
  let settled = false;
  void wait.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(settled).toBe(false);
  expect(getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  })).toMatchObject({ active: true, complete: false });

  releaseError();
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(settled).toBe(false);
  expect(getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  })).toMatchObject({ active: true, complete: true, status: 'aborted' });

  releaseSettlement();
  await expect(wait).resolves.toBe(true);
  expect(getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  })).toMatchObject({ active: false, complete: true, status: 'aborted' });
});

test('rejects overlapping runs for the same user, project, and provider', () => {
  startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    sessionId: 'codex-temporary',
    message: 'First task',
  });

  expect(() => startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    sessionId: 'codex-second',
    message: 'Second task',
  })).toThrow('CODEX already has an active turn for this project');
});

test('does not publish terminal completion until transcript persistence settles', async () => {
  let releasePersistence!: () => void;
  const persistencePending = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });

  startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    sessionId: 'codex-temporary',
    message: 'Persist this response',
    onComplete: () => persistencePending,
  });
  resolveSend({ fullText: 'Persisted response' });
  await flushPromises();

  expect(getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  })).toMatchObject({ active: true, complete: false, status: 'running' });

  releasePersistence();
  await flushPromises();
  expect(getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  })).toMatchObject({ active: false, complete: true, status: 'completed' });
});

test('does not confirm semantic settlement while a delayed terminal callback can still publish', async () => {
  let releaseSettlement!: () => void;
  const settlementPending = new Promise<void>((resolve) => {
    releaseSettlement = resolve;
  });
  const started = startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    sessionId: 'codex-temporary',
    message: 'Finish, then pause settlement',
    onSettled: () => settlementPending,
  });
  resolveSend({ fullText: 'Terminal response' });
  await flushPromises();

  expect(getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  })).toMatchObject({ active: true, complete: true, status: 'completed' });

  let waitResolved = false;
  const wait = waitForProjectNativeRunSettlement({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
    runId: started.runId!,
    timeoutMs: 1_000,
  }).then((value) => {
    waitResolved = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(waitResolved).toBe(false);

  releaseSettlement();
  await expect(wait).resolves.toBe(true);
  expect(getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  })).toMatchObject({ active: false, complete: true, status: 'completed' });
});

test('destructive reset quiesces the exact callback boundary even after provider completion', async () => {
  let releaseSettlement!: () => void;
  const settlementPending = new Promise<void>((resolve) => {
    releaseSettlement = resolve;
  });
  startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    sessionId: 'codex-detached-durable-turn',
    message: 'Complete while durable state is already detached',
    onSettled: () => settlementPending,
  });
  resolveSend({ fullText: 'Terminal response pending settlement' });
  await flushPromises();

  const quiescence = quiesceProjectNativeRunForDestructiveReset({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
    timeoutMs: 1_000,
  });
  let resolved = false;
  void quiescence.then(() => { resolved = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(resolved).toBe(false);
  expect(abortActiveRun).not.toHaveBeenCalled();

  releaseSettlement();
  await expect(quiescence).resolves.toMatchObject({ quiescent: true });
});

test('bounds long-run text and redacts sensitive nested tool metadata', async () => {
  startProjectNativeRun({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
    runtime: 'codex-project-adapter',
    sessionId: 'codex-temporary',
    message: 'Produce a large response',
  });
  onStatus?.({
    type: 'tool_start',
    toolName: 'exec',
    toolCallId: 'bounded-tool-1',
    toolArgs: {
      command: 'inspect project',
      password: 'must-not-leak',
      nested: {
        authorization: 'Bearer secret',
        accessToken: 'access-secret',
        privateKey: 'private-secret',
        jwt: 'jwt-secret',
      },
    },
  });
  onStatus?.({
    type: 'tool_end',
    toolName: 'exec',
    toolCallId: 'bounded-tool-1',
    toolResult: 'permission denied',
    isError: true,
  });
  const oversized = 'x'.repeat(PROJECT_NATIVE_MAX_RUN_TEXT + 128);
  onChunk?.(oversized);

  const running = getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  });
  expect(running?.text).toHaveLength(PROJECT_NATIVE_MAX_RUN_TEXT);
  expect(running?.events).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: 'tool_start',
      toolCallId: 'bounded-tool-1',
      toolArgs: {
        command: 'inspect project',
        password: '[redacted]',
        nested: {
          authorization: '[redacted]',
          accessToken: '[redacted]',
          privateKey: '[redacted]',
          jwt: '[redacted]',
        },
      },
    }),
    expect.objectContaining({
      type: 'tool_end',
      toolCallId: 'bounded-tool-1',
      toolResult: 'permission denied',
      isError: true,
    }),
    expect.objectContaining({
      type: 'status',
      content: expect.stringContaining('safety limit'),
    }),
  ]));
  expect(running?.events.find((event) => event.type === 'text')?.content).toHaveLength(80_000);

  resolveSend({ fullText: oversized });
  await flushPromises();
  await flushPromises();
  expect(getProjectNativeRunSnapshot({
    userId: USER_ID,
    projectId: PROJECT_ID,
    provider: 'CODEX',
  })).toMatchObject({ active: false, complete: true, status: 'completed' });
});
