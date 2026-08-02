// @vitest-environment jsdom
import '../test/setup';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChatStateProvider,
  useChatState,
} from './ChatStateProvider';

const chatMocks = vi.hoisted(() => ({
  clientGet: vi.fn(),
  clientPost: vi.fn(),
  createSession: vi.fn(),
  getConfigPath: vi.fn(),
  patchConfigPath: vi.fn(),
  patchSession: vi.fn(),
  patchSessionModel: vi.fn(),
  pendingQuestions: vi.fn(),
  answerQuestion: vi.fn(),
  sessionInfo: vi.fn(),
}));

vi.mock('../api/client', () => ({
  default: {
    get: chatMocks.clientGet,
    post: chatMocks.clientPost,
  },
}));

vi.mock('../api/endpoints', () => ({
  gatewayAPI: {
    createSession: chatMocks.createSession,
    getConfigPath: chatMocks.getConfigPath,
    patchConfigPath: chatMocks.patchConfigPath,
    patchSession: chatMocks.patchSession,
    patchSessionModel: chatMocks.patchSessionModel,
    pendingQuestions: chatMocks.pendingQuestions,
    answerQuestion: chatMocks.answerQuestion,
    sessionInfo: chatMocks.sessionInfo,
  },
}));

vi.mock('../api/auth', () => ({
  authAPI: { refresh: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ useDirectGateway: false }),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

class PendingWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: PendingWebSocket[] = [];

  readonly url: string;
  readyState = PendingWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: Array<Record<string, unknown>> = [];

  constructor(url: string) {
    this.url = url;
    PendingWebSocket.instances.push(this);
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = PendingWebSocket.CLOSED;
  }

  open() {
    this.readyState = PendingWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  emit(payload: Record<string, unknown>) {
    this.onmessage?.({
      data: JSON.stringify(payload),
    } as MessageEvent);
  }
}

function sessionInfo(fastMode: boolean) {
  return {
    session: {
      fastMode,
      reasoningLevel: 'stream',
      thinkingDefault: 'high',
      thinkingLevel: 'high',
      thinkingOptions: ['off', 'high'],
    },
  };
}

function SessionControlsHarness() {
  const chat = useChatState();
  return (
    <div>
      <output data-testid="session">{chat.session}</output>
      <output data-testid="model">{chat.selectedModel}</output>
      <output data-testid="history-error">{chat.historyError || ''}</output>
      <output data-testid="message-count">{chat.messages.length}</output>
      <output data-testid="messages">{JSON.stringify(chat.messages)}</output>
      <output data-testid="thinking">{JSON.stringify({
        content: chat.thinkingContent,
        subject: chat.thinkingSubject,
        segments: chat.streamSegments,
      })}</output>
      <output data-testid="fast">{chat.fastModeEnabled ? 'on' : 'off'}</output>
      <output data-testid="owner">{chat.sessionControlMutation || 'idle'}</output>
      <output data-testid="error">{chat.sessionControlsError || chat.compactionModelError || ''}</output>
      <output data-testid="compaction">{chat.compactionModelOverride}</output>
      <output data-testid="activity-titles">{JSON.stringify(chat.activityTitles)}</output>
      <output data-testid="pending-questions">{chat.pendingUserQuestions.length}</output>
      <output data-testid="status-text">{chat.statusText || ''}</output>
      <button type="button" onClick={() => void chat.ensureSessionControlsMetadataLoaded({ force: true })}>
        Load controls
      </button>
      <button type="button" onClick={() => void chat.toggleFastMode()}>
        Toggle fast
      </button>
      <button type="button" onClick={() => void chat.setThinkingLevel('off')}>
        Thinking off
      </button>
      <button type="button" onClick={() => void chat.setCompactionModelOverride('openai/next')}>
        Set compaction
      </button>
      <button type="button" onClick={() => chat.setSession('agent:main:second')}>
        Switch session
      </button>
      <button type="button" onClick={() => void chat.refreshChat()}>
        Retry history
      </button>
      <button type="button" onClick={() => void chat.cancelStream()}>
        Cancel stream
      </button>
      <button type="button" onClick={() => chat.reconnectSocket()}>
        Reconnect socket
      </button>
      <button type="button" onClick={() => void chat.sendMessage('Yes')}>
        Answer pending with Yes
      </button>
    </div>
  );
}

async function renderReadyHarness() {
  render(
    <ChatStateProvider>
      <SessionControlsHarness />
    </ChatStateProvider>,
  );
  await waitFor(() => expect(chatMocks.clientGet).toHaveBeenCalledWith(
    '/gateway/history',
    expect.objectContaining({
      params: expect.objectContaining({ session: 'agent:main:first' }),
    }),
  ));
  await act(async () => {});
}

describe('ChatStateProvider session-control ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    PendingWebSocket.instances = [];
    vi.stubGlobal('WebSocket', PendingWebSocket);
    localStorage.clear();
    localStorage.setItem('agent-chat-provider', 'OPENCLAW');
    localStorage.setItem('agent-chat-agentId', 'main');
    localStorage.setItem('agent-chat-session', 'agent:main:first');
    localStorage.setItem('agent-chat-session:OPENCLAW', 'agent:main:first');

    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        return {
          data: {
            activeStream: { active: false },
            messages: [],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    chatMocks.clientPost.mockResolvedValue({ data: { ok: true } });
    chatMocks.createSession.mockResolvedValue({ ok: true });
    chatMocks.getConfigPath.mockResolvedValue({ value: 'openai/base' });
    chatMocks.patchConfigPath.mockResolvedValue({ ok: true });
    chatMocks.patchSession.mockImplementation(async (_session: string, patch: Record<string, unknown>) => ({
      session: {
        fastMode: patch.fastMode ?? false,
        reasoningLevel: patch.reasoning ?? 'stream',
        thinkingLevel: patch.thinking ?? 'high',
      },
    }));
    chatMocks.patchSessionModel.mockResolvedValue({ ok: true });
    chatMocks.pendingQuestions.mockResolvedValue({ questions: [] });
    chatMocks.answerQuestion.mockImplementation(async (id: string) => ({
      ok: true,
      id,
      state: 'answered',
    }));
    chatMocks.sessionInfo.mockResolvedValue(sessionInfo(false));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads missing session-control metadata without mutating the session', async () => {
    chatMocks.sessionInfo.mockResolvedValueOnce({
      session: {
        thinkingDefault: 'high',
        thinkingOptions: ['off', 'high'],
      },
    });
    const user = userEvent.setup();
    await renderReadyHarness();

    await user.click(screen.getByRole('button', { name: 'Load controls' }));

    await waitFor(() => expect(chatMocks.sessionInfo).toHaveBeenCalledWith(
      'agent:main:first',
      { silent: true },
    ));
    expect(chatMocks.patchSession).not.toHaveBeenCalled();
  });

  it('does not create a session merely because an existing synthetic-key session is opened', async () => {
    localStorage.setItem('agent-chat-session', 'agent:main:new-existing-session');
    localStorage.setItem('agent-chat-session:OPENCLAW', 'agent:main:new-existing-session');

    render(
      <ChatStateProvider>
        <SessionControlsHarness />
      </ChatStateProvider>,
    );

    await waitFor(() => expect(chatMocks.clientGet).toHaveBeenCalledWith(
      '/gateway/history',
      expect.objectContaining({
        params: expect.objectContaining({ session: 'agent:main:new-existing-session' }),
      }),
    ));
    expect(chatMocks.createSession).not.toHaveBeenCalled();
  });

  it('single-flights a same-frame fast toggle and rejects its stale response after a session switch', async () => {
    const user = userEvent.setup();
    await renderReadyHarness();
    await user.click(screen.getByRole('button', { name: 'Load controls' }));
    await waitFor(() => expect(chatMocks.sessionInfo).toHaveBeenCalledWith(
      'agent:main:first',
      { silent: true },
    ));
    await waitFor(() => expect(screen.getByTestId('fast')).toHaveTextContent('off'));

    const firstPatch = deferred<{ session: { fastMode: boolean } }>();
    chatMocks.patchSession.mockReturnValueOnce(firstPatch.promise);
    const fastButton = screen.getByRole('button', { name: 'Toggle fast' });
    act(() => {
      fastButton.click();
      fastButton.click();
    });
    expect(chatMocks.patchSession).toHaveBeenCalledTimes(1);
    expect(chatMocks.patchSession).toHaveBeenLastCalledWith(
      'agent:main:first',
      { fastMode: true },
      'OPENCLAW',
    );
    expect(screen.getByTestId('owner')).toHaveTextContent('fastMode');

    await user.click(screen.getByRole('button', { name: 'Switch session' }));
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('agent:main:second'));
    await waitFor(() => expect(screen.getByTestId('owner')).toHaveTextContent('idle'));

    chatMocks.sessionInfo.mockResolvedValueOnce(sessionInfo(false));
    await user.click(screen.getByRole('button', { name: 'Load controls' }));
    await waitFor(() => expect(chatMocks.sessionInfo).toHaveBeenCalledWith(
      'agent:main:second',
      { silent: true },
    ));

    const secondPatch = deferred<{ session: { fastMode: boolean } }>();
    chatMocks.patchSession.mockReturnValueOnce(secondPatch.promise);
    act(() => {
      screen.getByRole('button', { name: 'Toggle fast' }).click();
    });
    expect(chatMocks.patchSession).toHaveBeenCalledTimes(2);
    expect(chatMocks.patchSession).toHaveBeenLastCalledWith(
      'agent:main:second',
      { fastMode: true },
      'OPENCLAW',
    );

    await act(async () => {
      secondPatch.resolve({ session: { fastMode: true } });
      await secondPatch.promise;
    });
    await waitFor(() => expect(screen.getByTestId('fast')).toHaveTextContent('on'));

    await act(async () => {
      firstPatch.resolve({ session: { fastMode: false } });
      await firstPatch.promise;
    });
    expect(screen.getByTestId('session')).toHaveTextContent('agent:main:second');
    expect(screen.getByTestId('fast')).toHaveTextContent('on');
    expect(screen.getByTestId('error')).toHaveTextContent('');
  });

  it('serializes different controls and rolls an ambiguous failure back to canonical server truth', async () => {
    const user = userEvent.setup();
    await renderReadyHarness();
    await user.click(screen.getByRole('button', { name: 'Load controls' }));
    await waitFor(() => expect(screen.getByTestId('compaction')).toHaveTextContent('openai/base'));

    const configPatch = deferred<{ ok: boolean }>();
    chatMocks.patchConfigPath.mockReturnValueOnce(configPatch.promise);
    act(() => {
      screen.getByRole('button', { name: 'Set compaction' }).click();
      screen.getByRole('button', { name: 'Thinking off' }).click();
    });
    expect(chatMocks.patchConfigPath).toHaveBeenCalledTimes(1);
    expect(chatMocks.patchConfigPath).toHaveBeenCalledWith(
      'agents.defaults.compaction.model',
      'openai/next',
    );
    expect(chatMocks.patchSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('owner')).toHaveTextContent('compactionModel');

    chatMocks.getConfigPath.mockResolvedValueOnce({ value: 'openai/next' });
    await act(async () => {
      configPatch.resolve({ ok: true });
      await configPatch.promise;
    });
    await waitFor(() => expect(screen.getByTestId('compaction')).toHaveTextContent('openai/next'));

    const failedPatch = deferred<{ session: { fastMode: boolean } }>();
    chatMocks.patchSession.mockReturnValueOnce(failedPatch.promise);
    act(() => {
      screen.getByRole('button', { name: 'Toggle fast' }).click();
    });
    expect(screen.getByTestId('fast')).toHaveTextContent('on');
    chatMocks.sessionInfo.mockResolvedValueOnce(sessionInfo(false));
    await act(async () => {
      failedPatch.reject(new Error('Fast mode was rejected'));
      await failedPatch.promise.catch(() => undefined);
    });
    await waitFor(() => expect(screen.getByTestId('fast')).toHaveTextContent('off'));
    expect(screen.getByTestId('error')).toHaveTextContent('Fast mode was rejected');
    expect(screen.getByTestId('owner')).toHaveTextContent('idle');
  });

  it('keeps a stored Agent Zero model inactive and exposes a retryable initial-history error', async () => {
    localStorage.clear();
    localStorage.setItem('agent-chat-provider', 'AGENT_ZERO');
    localStorage.setItem('agent-chat-session', 'agent_zero-user-a0-1');
    localStorage.setItem('agent-chat-session:AGENT_ZERO', 'agent_zero-user-a0-1');
    localStorage.setItem('agentChats.lastModel.AGENT_ZERO', 'codex_oauth/gpt-5.6-sol');
    let historyAttempts = 0;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        historyAttempts += 1;
        if (historyAttempts === 1) throw new Error('connector unavailable');
        return {
          data: {
            activeStream: { active: false },
            messages: [{
              id: 'local-a0-answer',
              role: 'assistant',
              content: 'Recovered local history',
              timestamp: '2026-07-22T10:00:00.000Z',
            }],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();

    render(
      <ChatStateProvider>
        <SessionControlsHarness />
      </ChatStateProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('history-error')).toHaveTextContent(
      'Agent Zero chat history could not be loaded',
    ));
    expect(screen.getByTestId('model')).toBeEmptyDOMElement();
    expect(screen.getByTestId('message-count')).toHaveTextContent('0');
    expect(localStorage.getItem('agentChats.lastModel.AGENT_ZERO')).toBe('codex_oauth/gpt-5.6-sol');

    await user.click(screen.getByRole('button', { name: 'Retry history' }));
    await waitFor(() => expect(screen.getByTestId('history-error')).toBeEmptyDOMElement());
    await waitFor(() => expect(screen.getByTestId('message-count')).toHaveTextContent('1'));
    expect(screen.getByTestId('model')).toBeEmptyDOMElement();
    consoleError.mockRestore();
  });

  it('isolates attested activity titles by session and clears only matching lifecycle events', async () => {
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => {
      socket.emit({
        type: 'thinking',
        sessionKey: 'agent:main:parallel',
        runId: 'raw-run',
        subject: 'Unattested raw title',
      });
      socket.emit({
        type: 'activity_title',
        activityScope: 'project-chat',
        activityType: 'thinking',
        sessionKey: 'agent:main:parallel',
        runId: 'project-run',
        subject: 'Wrong scope',
      });
    });
    expect(screen.getByTestId('activity-titles')).toHaveTextContent('{}');

    act(() => {
      socket.emit({
        type: 'activity_title',
        activityScope: 'agent-chat',
        activityType: 'thinking',
        sessionKey: 'agent:main:parallel',
        runId: 'run-1',
        subject: 'Inspecting the runtime',
      });
      socket.emit({
        type: 'activity_title',
        activityScope: 'agent-chat',
        activityType: 'thinking',
        sessionKey: 'agent:main:other',
        runId: 'run-2',
        subject: 'Reviewing another session',
      });
    });
    expect(screen.getByTestId('activity-titles')).toHaveTextContent(
      '"agent:main:parallel":"Inspecting the runtime"',
    );
    expect(screen.getByTestId('activity-titles')).toHaveTextContent(
      '"agent:main:other":"Reviewing another session"',
    );

    act(() => {
      socket.emit({
        type: 'activity_title',
        activityScope: 'agent-chat',
        activityType: 'done',
        sessionKey: 'agent:main:parallel',
        runId: 'stale-run',
      });
    });
    expect(screen.getByTestId('activity-titles')).toHaveTextContent(
      '"agent:main:parallel":"Inspecting the runtime"',
    );

    act(() => {
      socket.emit({
        type: 'activity_title',
        activityScope: 'agent-chat',
        activityType: 'run_resumed',
        sessionKey: 'agent:main:parallel',
        runId: 'replacement-run',
      });
    });
    expect(screen.getByTestId('activity-titles')).not.toHaveTextContent(
      '"agent:main:parallel"',
    );
    expect(screen.getByTestId('activity-titles')).toHaveTextContent(
      '"agent:main:other":"Reviewing another session"',
    );

    act(() => {
      socket.emit({
        type: 'activity_title',
        activityScope: 'agent-chat',
        activityType: 'done',
        sessionKey: 'agent:main:other',
        runId: 'run-2',
      });
    });
    expect(screen.getByTestId('activity-titles')).toHaveTextContent('{}');
  });

  it('clears the exact session title after a confirmed WebSocket abort result', async () => {
    const user = userEvent.setup();
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'activity_title',
        activityScope: 'agent-chat',
        activityType: 'thinking',
        sessionKey: 'agent:main:first',
        runId: 'run-cancel',
        subject: 'Stopping this run',
      });
      socket.emit({
        type: 'text',
        sessionKey: 'agent:main:first',
        content: 'Partial response',
      });
    });
    expect(screen.getByTestId('activity-titles')).toHaveTextContent(
      '"agent:main:first":"Stopping this run"',
    );

    await user.click(screen.getByRole('button', { name: 'Cancel stream' }));
    await waitFor(() => expect(socket.sent.some((frame) => frame.type === 'abort')).toBe(true));
    const abortFrame = socket.sent.find((frame) => frame.type === 'abort');
    expect(abortFrame).toMatchObject({
      session: 'agent:main:first',
      provider: 'OPENCLAW',
    });

    act(() => {
      socket.emit({
        type: 'abort_result',
        requestId: abortFrame?.requestId,
        ok: true,
      });
    });
    await waitFor(() => expect(screen.getByTestId('activity-titles')).toHaveTextContent('{}'));
  });

  it('clears activity titles on disconnect and again on reconnect', async () => {
    const user = userEvent.setup();
    await renderReadyHarness();
    const firstSocket = PendingWebSocket.instances[0];
    act(() => {
      firstSocket.open();
      firstSocket.emit({
        type: 'activity_title',
        activityScope: 'agent-chat',
        activityType: 'thinking',
        sessionKey: 'agent:main:parallel',
        runId: 'run-disconnect',
        subject: 'Waiting on transport',
      });
    });
    expect(screen.getByTestId('activity-titles')).toHaveTextContent('Waiting on transport');

    act(() => {
      firstSocket.onclose?.({
        code: 1006,
        reason: '',
        wasClean: false,
      } as CloseEvent);
    });
    expect(screen.getByTestId('activity-titles')).toHaveTextContent('{}');

    await user.click(screen.getByRole('button', { name: 'Reconnect socket' }));
    const secondSocket = PendingWebSocket.instances.at(-1)!;
    act(() => {
      secondSocket.open();
      secondSocket.emit({
        type: 'activity_title',
        activityScope: 'agent-chat',
        activityType: 'thinking',
        sessionKey: 'agent:main:parallel',
        runId: 'run-reconnect',
        subject: 'Restored transport',
      });
    });
    expect(screen.getByTestId('activity-titles')).toHaveTextContent('Restored transport');

    await user.click(screen.getByRole('button', { name: 'Reconnect socket' }));
    const thirdSocket = PendingWebSocket.instances.at(-1)!;
    act(() => {
      thirdSocket.open();
    });
    await waitFor(() => expect(screen.getByTestId('activity-titles')).toHaveTextContent('{}'));
  });

  it('preserves Agent text/tool chronology and stores only the residual cumulative final segment', async () => {
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];
    const emit = (payload: Record<string, unknown>) => act(() => socket.emit({
      sessionKey: 'agent:main:first',
      ...payload,
    }));

    emit({ type: 'text', content: 'A' });
    emit({ type: 'tool_start', toolCallId: 'tool-one', toolName: 'read' });
    emit({ type: 'tool_end', toolCallId: 'tool-one', toolName: 'read', toolResult: 'one' });
    emit({ type: 'text', content: ' B' });
    emit({ type: 'tool_start', toolCallId: 'tool-two', toolName: 'exec' });
    emit({ type: 'tool_end', toolCallId: 'tool-two', toolName: 'exec', toolResult: 'two' });
    emit({ type: 'text', content: ' C' });
    emit({ type: 'done', content: 'A B C' });

    const parsed = JSON.parse(screen.getByTestId('messages').textContent || '[]');
    const assistant = parsed.find((message: { role: string }) => message.role === 'assistant');
    expect(assistant.content).toBe('A B C');
    expect(assistant.segments.map((segment: { text: string; order: number }) => ({
      text: segment.text.trim(),
      order: segment.order,
    }))).toEqual([
      { text: 'A', order: 0 },
      { text: 'B', order: 2 },
      { text: 'C', order: 4 },
    ]);
    expect(assistant.toolCalls.map((tool: { id: string; order: number }) => ({
      id: tool.id,
      order: tool.order,
    }))).toEqual([
      { id: 'tool-one', order: 1 },
      { id: 'tool-two', order: 3 },
    ]);
  });

  it('graduates changed thinking subjects and restores both phases from reconnect history', async () => {
    const user = userEvent.setup();
    await renderReadyHarness();
    const firstSocket = PendingWebSocket.instances[0];
    act(() => firstSocket.open());
    const emit = (payload: Record<string, unknown>) => act(() => firstSocket.emit({
      sessionKey: 'agent:main:first',
      ...payload,
    }));

    emit({ type: 'thinking', subject: 'Subject A', content: 'Body A', replace: true });
    emit({ type: 'thinking', subject: 'Subject B', content: 'Body B', replace: true });
    emit({ type: 'done', content: 'Final answer' });

    let parsed = JSON.parse(screen.getByTestId('messages').textContent || '[]');
    let assistant = parsed.find((message: { role: string }) => message.role === 'assistant');
    expect(assistant.segments.map((segment: { subject?: string; text: string }) => ({
      subject: segment.subject,
      text: segment.text,
    }))).toEqual([
      { subject: 'Subject A', text: 'Body A' },
      { subject: 'Subject B', text: 'Body B' },
      { subject: undefined, text: 'Final answer' },
    ]);

    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        return {
          data: {
            activeStream: { active: false },
            messages: [{
              id: 'history-subjects',
              role: 'assistant',
              content: 'Final answer',
              timestamp: '2026-07-29T06:00:00.000Z',
              segments: [
                { kind: 'thinking', subject: 'Subject A', text: 'Body A', order: 0, ts: 1_000 },
                { kind: 'thinking', subject: 'Subject B', text: 'Body B', order: 1, ts: 2_000 },
                { kind: 'text', text: 'Final answer', order: 2, ts: 3_000 },
              ],
            }],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });

    await user.click(screen.getByRole('button', { name: 'Reconnect socket' }));
    const reconnectSocket = PendingWebSocket.instances.at(-1)!;
    act(() => reconnectSocket.open());
    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent('history-subjects'));

    parsed = JSON.parse(screen.getByTestId('messages').textContent || '[]');
    assistant = parsed.find((message: { id: string }) => message.id === 'history-subjects');
    expect(assistant.segments.map((segment: { subject?: string; text: string }) => ({
      subject: segment.subject,
      text: segment.text,
    }))).toEqual([
      { subject: 'Subject A', text: 'Body A' },
      { subject: 'Subject B', text: 'Body B' },
      { subject: undefined, text: 'Final answer' },
    ]);
  });

  it('expires an orphaned activity title after the bounded fallback window', async () => {
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];
    expect(socket).toBeDefined();
    const nativeSetTimeout = globalThis.setTimeout;
    let expireTitle: (() => void) | null = null;
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((
      (handler: TimerHandler, timeout?: number, ...args: any[]) => {
        if (timeout === 2 * 60_000 && typeof handler === 'function') {
          expireTitle = () => handler(...args);
          return 42 as unknown as ReturnType<typeof setTimeout>;
        }
        return nativeSetTimeout(handler, timeout, ...args);
      }
    ) as typeof setTimeout);

    try {
      act(() => {
        socket.onmessage?.({
          data: JSON.stringify({
            type: 'activity_title',
            activityScope: 'agent-chat',
            activityType: 'thinking',
            sessionKey: 'agent:main:parallel',
            runId: 'run-expiry',
            subject: 'Waiting for a missing terminal',
          }),
        } as MessageEvent);
      });
      expect(screen.getByTestId('activity-titles')).toHaveTextContent(
        '"agent:main:parallel":"Waiting for a missing terminal"',
      );

      act(() => {
        expireTitle?.();
      });
      expect(expireTitle).not.toBeNull();
      expect(screen.getByTestId('activity-titles')).toHaveTextContent('{}');
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('answers one active Agent Chat question through its exact broker record', async () => {
    chatMocks.pendingQuestions.mockResolvedValue({
      questions: [{
        id: 'askq-agent-one',
        sessionKey: 'agent:main:first',
        surface: 'agent-chat',
        state: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
        questions: [{ id: 'question-continue', question: 'Continue?', multiSelect: false, options: [] }],
      }],
    });
    const user = userEvent.setup();
    await renderReadyHarness();
    await waitFor(() => expect(screen.getByTestId('pending-questions')).toHaveTextContent('1'));
    const socket = PendingWebSocket.instances[0];
    act(() => {
      socket.emit({
        type: 'text',
        sessionKey: 'agent:main:first',
        runId: 'run-question',
        content: 'Waiting for your answer',
      });
    });

    await user.click(screen.getByRole('button', { name: 'Answer pending with Yes' }));

    await waitFor(() => expect(chatMocks.answerQuestion).toHaveBeenCalledWith(
      'askq-agent-one',
      { 'question-continue': 'Yes' },
    ));
    expect(screen.getByTestId('pending-questions')).toHaveTextContent('0');
    expect(chatMocks.clientPost).not.toHaveBeenCalledWith(
      '/gateway/answer-user-input',
      expect.anything(),
    );
  });

  it('fails closed when one Agent Chat composer value cannot answer every question', async () => {
    chatMocks.pendingQuestions.mockResolvedValue({
      questions: [{
        id: 'askq-agent-many',
        sessionKey: 'agent:main:first',
        surface: 'agent-chat',
        state: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
        questions: [
          { id: 'question-environment', question: 'Environment?', multiSelect: false, options: [] },
          { id: 'question-region', question: 'Region?', multiSelect: false, options: [] },
        ],
      }],
    });
    const user = userEvent.setup();
    await renderReadyHarness();
    await waitFor(() => expect(screen.getByTestId('pending-questions')).toHaveTextContent('1'));
    const socket = PendingWebSocket.instances[0];
    act(() => {
      socket.emit({
        type: 'text',
        sessionKey: 'agent:main:first',
        runId: 'run-question-many',
        content: 'Waiting for your answers',
      });
    });

    await user.click(screen.getByRole('button', { name: 'Answer pending with Yes' }));

    expect(await screen.findByTestId('status-text')).toHaveTextContent('needs more than one answer');
    expect(chatMocks.answerQuestion).not.toHaveBeenCalled();
  });

  it('retries active Agent Chat steering with the same delivery id when no question is pending', async () => {
    const user = userEvent.setup();
    await renderReadyHarness();
    await waitFor(() => expect(chatMocks.pendingQuestions).toHaveBeenCalledWith('agent:main:first'));
    const socket = PendingWebSocket.instances[0];
    act(() => {
      socket.emit({
        type: 'text',
        sessionKey: 'agent:main:first',
        runId: 'run-steer',
        content: 'Working',
      });
    });
    let steerAttempts = 0;
    chatMocks.clientPost.mockImplementation(async (url: string, body?: Record<string, unknown>) => {
      if (url !== '/gateway/session-steer') return { data: { ok: true } };
      steerAttempts += 1;
      if (steerAttempts === 1) throw new Error('response lost');
      return {
        data: {
          ok: true,
          sessionKey: 'agent:main:first',
          requestId: body?.requestId,
          interruptedActiveRun: false,
        },
      };
    });

    const send = screen.getByRole('button', { name: 'Answer pending with Yes' });
    await user.click(send);
    expect(await screen.findByTestId('status-text')).toHaveTextContent('response lost');
    await user.click(send);

    await waitFor(() => expect(steerAttempts).toBe(2));
    const steeringBodies = chatMocks.clientPost.mock.calls
      .filter(([url]) => url === '/gateway/session-steer')
      .map(([, body]) => body as Record<string, unknown>);
    expect(steeringBodies[0].requestId).toBeTruthy();
    expect(steeringBodies[1].requestId).toBe(steeringBodies[0].requestId);
    expect(steeringBodies[1]).toMatchObject({
      session: 'agent:main:first',
      message: 'Yes',
    });
  });
});
