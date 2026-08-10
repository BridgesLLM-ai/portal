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
      <output data-testid="provider">{chat.provider}</output>
      <output data-testid="model">{chat.selectedModel}</output>
      <output data-testid="history-error">{chat.historyError || ''}</output>
      <output data-testid="history-loading">{chat.isLoadingHistory ? 'loading' : 'idle'}</output>
      <output data-testid="message-count">{chat.messages.length}</output>
      <output data-testid="messages">{JSON.stringify(chat.messages)}</output>
      <output data-testid="queue-count">{chat.messageQueue.length}</output>
      <output data-testid="thinking">{JSON.stringify({
        content: chat.thinkingContent,
        subject: chat.thinkingSubject,
        segments: chat.streamSegments,
      })}</output>
      <output data-testid="streaming-assistant-id">{chat.streamingAssistantId || ''}</output>
      <output data-testid="fast">{chat.fastModeEnabled ? 'on' : 'off'}</output>
      <output data-testid="owner">{chat.sessionControlMutation || 'idle'}</output>
      <output data-testid="error">{chat.sessionControlsError || chat.compactionModelError || ''}</output>
      <output data-testid="compaction">{chat.compactionModelOverride}</output>
      <output data-testid="activity-titles">{JSON.stringify(chat.activityTitles)}</output>
      <output data-testid="pending-questions">{chat.pendingUserQuestions.length}</output>
      <output data-testid="status-text">{chat.statusText || ''}</output>
      <output data-testid="ws-connected">{chat.wsConnected ? 'connected' : 'disconnected'}</output>
      <output data-testid="is-running">{chat.isRunning ? 'running' : 'idle'}</output>
      <output data-testid="stream-stale">{chat.isRunning && !chat.wsConnected ? 'stale' : 'clear'}</output>
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
      <button type="button" onClick={() => void chat.selectSession('agent:main:second')}>
        Navigate session
      </button>
      <button type="button" onClick={() => chat.selectProviderAgent('CODEX')}>
        Switch to Codex
      </button>
      <button type="button" onClick={() => chat.selectProviderAgent('OPENCLAW')}>
        Switch to OpenClaw main
      </button>
      <button type="button" onClick={() => chat.selectProviderAgent('OPENCLAW', 'parity')}>
        Switch to OpenClaw parity
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

  it('restores the last provider-scoped session when the provider changes', async () => {
    localStorage.setItem('agent-chat-session:CODEX', 'codex-last-session');
    const user = userEvent.setup();
    await renderReadyHarness();

    await user.click(screen.getByRole('button', { name: 'Switch to Codex' }));

    await waitFor(() => expect(screen.getByTestId('provider')).toHaveTextContent('CODEX'));
    expect(screen.getByTestId('session')).toHaveTextContent('codex-last-session');
    await waitFor(() => expect(chatMocks.clientGet).toHaveBeenCalledWith(
      '/gateway/history',
      expect.objectContaining({
        params: expect.objectContaining({
          provider: 'CODEX',
          session: 'codex-last-session',
        }),
      }),
    ));

    await user.click(screen.getByRole('button', { name: 'Switch to OpenClaw main' }));
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('agent:main:first'));
    await user.click(screen.getByRole('button', { name: 'Switch to Codex' }));
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('codex-last-session'));
  });

  it('uses manual refresh to reconnect a dropped Codex Agent Chat stream', async () => {
    localStorage.setItem('agent-chat-session:CODEX', 'codex-refresh-session');
    const user = userEvent.setup();
    await renderReadyHarness();
    await user.click(screen.getByRole('button', { name: 'Switch to Codex' }));
    await waitFor(() => expect(screen.getByTestId('provider')).toHaveTextContent('CODEX'));
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('codex-refresh-session'));

    const droppedSocket = PendingWebSocket.instances[0];
    act(() => {
      droppedSocket.open();
      droppedSocket.emit({ type: 'connected' });
      droppedSocket.emit({
        type: 'text',
        provider: 'CODEX',
        sessionKey: 'codex-refresh-session',
        runId: 'run-codex-refresh',
        content: 'Partial Codex response',
      });
      droppedSocket.onclose?.({
        code: 1006,
        reason: '',
        wasClean: false,
      } as CloseEvent);
    });
    expect(PendingWebSocket.instances).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId('stream-stale')).toHaveTextContent('stale'));

    await user.click(screen.getByRole('button', { name: 'Retry history' }));
    expect(PendingWebSocket.instances).toHaveLength(2);

    const recoveredSocket = PendingWebSocket.instances[1];
    act(() => {
      recoveredSocket.open();
      recoveredSocket.emit({ type: 'connected' });
    });
    await waitFor(() => expect(screen.getByTestId('ws-connected')).toHaveTextContent('connected'));
    expect(screen.getByTestId('stream-stale')).toHaveTextContent('clear');
    expect(recoveredSocket.sent).toContainEqual(expect.objectContaining({
      type: 'reconnect',
      provider: 'CODEX',
      session: 'codex-refresh-session',
    }));

    // The provider can finish while the browser transport is down. Reconnect
    // must settle that stale local run from the backend's authoritative
    // terminal snapshot; transport recovery alone is not enough.
    act(() => {
      recoveredSocket.emit({
        type: 'stream_status',
        provider: 'CODEX',
        sessionKey: 'codex-refresh-session',
        active: false,
        inactiveReason: 'terminal',
        safeToClear: true,
      });
    });
    await waitFor(() => expect(screen.getByTestId('is-running')).toHaveTextContent('idle'));
    expect(screen.getByTestId('stream-stale')).toHaveTextContent('clear');
  });

  it('keeps OpenClaw agent sessions independent across provider round trips', async () => {
    localStorage.setItem('agent-chat-session:OPENCLAW:main', 'agent:main:last-main');
    localStorage.setItem('agent-chat-session:OPENCLAW:parity', 'agent:parity:last-parity');
    localStorage.setItem('agent-chat-session:CODEX', 'codex-last-session');
    const user = userEvent.setup();
    render(
      <ChatStateProvider>
        <SessionControlsHarness />
      </ChatStateProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('agent:main:last-main'));

    await user.click(screen.getByRole('button', { name: 'Switch to OpenClaw parity' }));
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('agent:parity:last-parity'));

    await user.click(screen.getByRole('button', { name: 'Switch to Codex' }));
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('codex-last-session'));

    await user.click(screen.getByRole('button', { name: 'Switch to OpenClaw main' }));
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('agent:main:last-main'));
    expect(localStorage.getItem('agent-chat-session:OPENCLAW:parity')).toBe('agent:parity:last-parity');
  });

  it('never restores another OpenClaw agent from the legacy provider key', async () => {
    localStorage.removeItem('agent-chat-session:OPENCLAW:main');
    localStorage.setItem('agent-chat-session:OPENCLAW', 'agent:parity:last-parity');
    localStorage.setItem('agent-chat-session', 'agent:parity:last-parity');
    localStorage.setItem('agent-chat-provider', 'CODEX');
    localStorage.setItem('agent-chat-session:CODEX', 'codex-last-session');
    const user = userEvent.setup();

    render(
      <ChatStateProvider>
        <SessionControlsHarness />
      </ChatStateProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('codex-last-session'));

    await user.click(screen.getByRole('button', { name: 'Switch to OpenClaw main' }));
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('agent:main:main'));
    expect(screen.getByTestId('session')).not.toHaveTextContent('parity');
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

  it('renders a foreign user message and live reasoning before the turn finishes', async () => {
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'user_message',
        sessionKey: 'agent:main:first',
        runId: 'foreign-run',
        messageId: 'discord-message-1',
        messageTimestamp: 1_786_150_000_000,
        sourceChannel: 'discord',
        content: 'Prompt sent from Discord',
      });
      socket.emit({
        type: 'run_resumed',
        sessionKey: 'agent:main:first',
        runId: 'foreign-run',
      });
      socket.emit({
        type: 'thinking',
        sessionKey: 'agent:main:first',
        runId: 'foreign-run',
        content: 'Reasoning is visible before completion',
      });
      socket.emit({
        type: 'user_message',
        sessionKey: 'agent:main:first',
        runId: 'foreign-run',
        messageId: 'discord-steer-2',
        messageTimestamp: 1_786_150_001_000,
        content: 'Also check the retry path',
      });
      socket.emit({
        type: 'status',
        sessionKey: 'agent:main:first',
        runId: 'foreign-run',
        turnEvent: {
          schema: 'bridgesllm.runtime-turn-event.v1',
          type: 'assistant_reasoning',
          sessionKey: 'agent:main:first',
          runId: 'foreign-run',
          seq: 2,
          text: 'Reasoning remains visible after the steer',
          replace: true,
          visible: true,
          source: {
            transport: 'portal-stream-event-bus',
            eventType: 'status',
            preambleProgress: true,
          },
        },
      });
      socket.emit({
        type: 'tool_start',
        sessionKey: 'agent:main:first',
        runId: 'foreign-run',
        toolCallId: 'read-after-steer',
        toolName: 'Read',
      });
    });

    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent('Prompt sent from Discord'));
    expect(screen.getByTestId('messages')).toHaveTextContent('Also check the retry path');
    expect(screen.getByTestId('thinking')).toHaveTextContent('Reasoning is visible before completion');
    expect(screen.getByTestId('thinking')).toHaveTextContent('Reasoning remains visible after the steer');
    expect(screen.getByTestId('message-count')).toHaveTextContent('3');
    const streamingAssistantId = screen.getByTestId('streaming-assistant-id').textContent || '';
    const parsedMessages = JSON.parse(screen.getByTestId('messages').textContent || '[]');
    expect(parsedMessages.find((message: { id: string }) => message.id === streamingAssistantId)?.role).toBe('assistant');
    expect(parsedMessages.at(-1)?.role).toBe('user');
    expect(screen.getByTestId('is-running')).toHaveTextContent('running');
  });

  it('promotes trusted cumulative preamble progress into persistent thinking before a tool call', async () => {
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'run_resumed',
        sessionKey: 'agent:main:first',
        runId: 'opus-preamble-run',
      });
      socket.emit({
        type: 'thinking',
        sessionKey: 'agent:main:first',
        runId: 'opus-preamble-run',
        content: 'Raw Opus reasoning survives the preamble transition',
        replace: true,
      });
      socket.emit({
        type: 'status',
        sessionKey: 'agent:main:first',
        runId: 'opus-preamble-run',
        content: 'Inspecting',
        replace: true,
        turnEvent: {
          schema: 'bridgesllm.runtime-turn-event.v1',
          type: 'assistant_reasoning',
          sessionKey: 'agent:main:first',
          runId: 'opus-preamble-run',
          seq: 1,
          text: 'Inspecting',
          replace: true,
          visible: true,
          source: {
            transport: 'portal-stream-event-bus',
            eventType: 'status',
            preambleProgress: true,
          },
        },
      });
      socket.emit({
        type: 'status',
        sessionKey: 'agent:main:first',
        runId: 'opus-preamble-run',
        content: 'Inspecting the affected files',
        replace: true,
        turnEvent: {
          schema: 'bridgesllm.runtime-turn-event.v1',
          type: 'assistant_reasoning',
          sessionKey: 'agent:main:first',
          runId: 'opus-preamble-run',
          seq: 2,
          text: 'Inspecting the affected files',
          replace: true,
          visible: true,
          source: {
            transport: 'portal-stream-event-bus',
            eventType: 'status',
            preambleProgress: true,
          },
        },
      });
    });

    expect(screen.getByTestId('thinking')).toHaveTextContent('Inspecting the affected files');
    expect(screen.getByTestId('thinking')).toHaveTextContent(
      'Raw Opus reasoning survives the preamble transition',
    );
    expect(screen.getByTestId('thinking')).not.toHaveTextContent('InspectingInspecting');

    act(() => {
      socket.emit({
        type: 'tool_start',
        sessionKey: 'agent:main:first',
        runId: 'opus-preamble-run',
        toolCallId: 'opus-read-1',
        toolName: 'Read',
      });
    });
    expect(screen.getByTestId('thinking')).toHaveTextContent('"kind":"thinking"');
    expect(screen.getByTestId('thinking')).toHaveTextContent('Inspecting the affected files');

    act(() => {
      socket.emit({
        type: 'tool_end',
        sessionKey: 'agent:main:first',
        runId: 'opus-preamble-run',
        toolCallId: 'opus-read-1',
        toolName: 'Read',
        toolResult: 'done',
      });
      socket.emit({
        type: 'done',
        sessionKey: 'agent:main:first',
        runId: 'opus-preamble-run',
        content: 'The Opus turn finished.',
      });
    });
    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent('The Opus turn finished.'));
    expect(screen.getByTestId('messages')).toHaveTextContent('Inspecting the affected files');
    expect(screen.getByTestId('messages')).toHaveTextContent(
      'Raw Opus reasoning survives the preamble transition',
    );
    expect(screen.getByTestId('messages')).toHaveTextContent('opus-read-1');
  });

  it('does not leak a completed run thinking timeline into the next done-only foreign run', async () => {
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'run_resumed',
        sessionKey: 'agent:main:first',
        runId: 'completed-r1',
      });
      socket.emit({
        type: 'thinking',
        sessionKey: 'agent:main:first',
        runId: 'completed-r1',
        content: 'R1 private timeline must stay in R1',
      });
      socket.emit({
        type: 'done',
        sessionKey: 'agent:main:first',
        runId: 'completed-r1',
        content: 'R1 final',
      });
      socket.emit({
        type: 'run_resumed',
        sessionKey: 'agent:main:first',
        runId: 'foreign-r2',
      });
      socket.emit({
        type: 'done',
        sessionKey: 'agent:main:first',
        runId: 'foreign-r2',
        content: 'R2 final without reasoning',
      });
    });

    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent(
      'R2 final without reasoning',
    ));
    const parsed = JSON.parse(screen.getByTestId('messages').textContent || '[]');
    const r1 = parsed.find((message: { content: string }) => message.content === 'R1 final');
    const r2 = parsed.find((message: { content: string }) => message.content === 'R2 final without reasoning');
    expect(JSON.stringify(r1?.segments || [])).toContain('R1 private timeline must stay in R1');
    expect(JSON.stringify(r2?.segments || [])).not.toContain('R1 private timeline must stay in R1');
  });

  it('restores attested preamble reasoning from a reconnect snapshot through tool completion', async () => {
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'stream_resume',
        sessionKey: 'agent:main:first',
        runId: 'opus-reconnect-run',
        phase: 'thinking',
        startedAt: Date.now(),
        turnEvents: [
          {
            schema: 'bridgesllm.runtime-turn-event.v1',
            type: 'assistant_reasoning',
            sessionKey: 'agent:main:first',
            runId: 'opus-reconnect-run',
            seq: 1,
            ts: Date.now(),
            text: 'Raw reasoning restored after reconnect',
            replace: true,
            visible: true,
            source: {
              transport: 'portal-stream-event-bus',
              eventType: 'thinking',
            },
          },
          {
            schema: 'bridgesllm.runtime-turn-event.v1',
            type: 'assistant_reasoning',
            sessionKey: 'agent:main:first',
            runId: 'opus-reconnect-run',
            seq: 2,
            ts: Date.now(),
            text: 'Inspecting the files before the gateway restarted',
            replace: true,
            visible: true,
            source: {
              transport: 'portal-stream-event-bus',
              eventType: 'status',
              preambleProgress: true,
            },
          },
        ],
      });
    });

    expect(screen.getByTestId('thinking')).toHaveTextContent(
      'Inspecting the files before the gateway restarted',
    );
    expect(screen.getByTestId('thinking')).toHaveTextContent('Raw reasoning restored after reconnect');

    act(() => {
      socket.emit({
        type: 'tool_start',
        sessionKey: 'agent:main:first',
        runId: 'opus-reconnect-run',
        toolCallId: 'opus-reconnect-tool',
        toolName: 'Read',
      });
      socket.emit({
        type: 'tool_end',
        sessionKey: 'agent:main:first',
        runId: 'opus-reconnect-run',
        toolCallId: 'opus-reconnect-tool',
        toolName: 'Read',
        toolResult: 'done',
      });
      socket.emit({
        type: 'done',
        sessionKey: 'agent:main:first',
        runId: 'opus-reconnect-run',
        content: 'Reconnect completed.',
      });
    });

    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent('Reconnect completed.'));
    expect(screen.getByTestId('messages')).toHaveTextContent(
      'Inspecting the files before the gateway restarted',
    );
    expect(screen.getByTestId('messages')).toHaveTextContent('Raw reasoning restored after reconnect');
    expect(screen.getByTestId('messages')).toHaveTextContent('opus-reconnect-tool');
  });

  it('preserves visible WebSocket reasoning when inactive reconciliation replaces a missed terminal', async () => {
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'run_resumed',
        sessionKey: 'agent:main:first',
        runId: 'ws-missed-terminal-run',
      });
      socket.emit({
        type: 'status',
        sessionKey: 'agent:main:first',
        runId: 'ws-missed-terminal-run',
        content: 'Reasoning visible before the WebSocket outage',
        preambleProgress: true,
        replace: true,
      });
      socket.emit({
        type: 'stream_ended',
        sessionKey: 'agent:main:first',
        runId: 'ws-missed-terminal-run',
        inactiveReason: 'terminal',
        safeToClear: true,
      });
    });

    await waitFor(() => expect(screen.getByTestId('is-running')).toHaveTextContent('idle'));
    expect(screen.getByTestId('messages')).toHaveTextContent(
      'Reasoning visible before the WebSocket outage',
    );
    expect(screen.getByTestId('messages')).not.toHaveTextContent('live view detached');
    expect(screen.getByTestId('messages')).not.toHaveTextContent('may still be working');
  });

  it('does not merge cleared R1 reasoning into an immediate R2 continuation', async () => {
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({ type: 'run_resumed', sessionKey: 'agent:main:first', runId: 'batched-r1' });
      socket.emit({
        type: 'thinking',
        sessionKey: 'agent:main:first',
        runId: 'batched-r1',
        content: 'R1 thought preserved only in the completed bubble',
      });
      socket.emit({
        type: 'stream_ended',
        sessionKey: 'agent:main:first',
        runId: 'batched-r1',
        inactiveReason: 'terminal',
        safeToClear: true,
      });
      socket.emit({ type: 'run_resumed', sessionKey: 'agent:main:first', runId: 'batched-r2' });
      socket.emit({
        type: 'thinking',
        sessionKey: 'agent:main:first',
        runId: 'batched-r2',
        content: 'R2 fresh thought',
      });
    });

    expect(screen.getByTestId('thinking')).toHaveTextContent('R2 fresh thought');
    expect(screen.getByTestId('thinking')).not.toHaveTextContent(
      'R1 thought preserved only in the completed bubbleR2 fresh thought',
    );
    expect(screen.getByTestId('messages')).toHaveTextContent(
      'R1 thought preserved only in the completed bubble',
    );
  });

  it('preserves visible SSE reasoning when inactive reconciliation replaces a missed terminal', async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal('fetch', vi.fn(async () => {
      const frames = [
        { type: 'session', sessionId: 'agent:main:first' },
        {
          type: 'thinking',
          sessionKey: 'agent:main:first',
          runId: 'sse-missed-terminal-run',
          content: 'Raw SSE reasoning before the preamble',
          replace: true,
        },
        {
          type: 'status',
          sessionKey: 'agent:main:first',
          runId: 'sse-missed-terminal-run',
          content: 'Reasoning visible before the SSE outage',
          preambleProgress: true,
          replace: true,
        },
        {
          type: 'stream_ended',
          sessionKey: 'agent:main:first',
          runId: 'sse-missed-terminal-run',
          inactiveReason: 'terminal',
          safeToClear: true,
        },
      ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
      let read = false;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn(async () => {
              if (read) return { done: true, value: undefined };
              read = true;
              return { done: false, value: encoder.encode(frames) };
            }),
            cancel: vi.fn(async () => undefined),
          }),
        },
      } as unknown as Response;
    }));
    const user = userEvent.setup();
    await renderReadyHarness();

    await user.click(screen.getByRole('button', { name: 'Answer pending with Yes' }));

    await waitFor(() => expect(screen.getByTestId('is-running')).toHaveTextContent('idle'));
    expect(screen.getByTestId('messages')).toHaveTextContent(
      'Reasoning visible before the SSE outage',
    );
    expect(screen.getByTestId('messages')).toHaveTextContent('Raw SSE reasoning before the preamble');
    expect(screen.getByTestId('messages')).not.toHaveTextContent('live view detached');
    expect(screen.getByTestId('messages')).not.toHaveTextContent('may still be working');
  });

  it('preserves a live foreign prompt while history lags, then dedupes it when durable history catches up', async () => {
    let durablePromptReady = false;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        return {
          data: {
            activeStream: { active: true, runId: 'foreign-live-run', phase: 'thinking', startedAt: Date.now() },
            messages: durablePromptReady ? [{
              id: 'durable-foreign-prompt',
              role: 'user',
              content: 'Foreign prompt still waiting on durable history',
              timestamp: '2026-08-08T02:10:00.000Z',
            }] : [],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'user_message',
        sessionKey: 'agent:main:first',
        runId: 'foreign-live-run',
        messageId: 'live-foreign-prompt',
        messageTimestamp: Date.parse('2026-08-08T02:10:00.000Z'),
        content: 'Foreign prompt still waiting on durable history',
      });
      socket.emit({
        type: 'thinking',
        sessionKey: 'agent:main:first',
        runId: 'foreign-live-run',
        content: 'Live work continues',
      });
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'gateway-session-resubscribed',
      });
    });

    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent(
      'Foreign prompt still waiting on durable history',
    ));
    let parsed = JSON.parse(screen.getByTestId('messages').textContent || '[]');
    expect(parsed.filter((message: { role: string; content: string }) => (
      message.role === 'user' && message.content === 'Foreign prompt still waiting on durable history'
    ))).toHaveLength(1);

    durablePromptReady = true;
    act(() => {
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'foreign-prompt-durable',
      });
    });
    await waitFor(() => {
      const calls = chatMocks.clientGet.mock.calls.filter(([url]) => url === '/gateway/history');
      expect(calls.length).toBeGreaterThanOrEqual(3);
    });
    parsed = JSON.parse(screen.getByTestId('messages').textContent || '[]');
    expect(parsed.filter((message: { role: string; content: string }) => (
      message.role === 'user' && message.content === 'Foreign prompt still waiting on durable history'
    ))).toHaveLength(1);
    expect(parsed.find((message: { id: string }) => message.id === 'durable-foreign-prompt')).toBeDefined();
  });

  it('keeps identical cross-channel prompts distinct while durable history catches up one row at a time', async () => {
    let durableCount = 1;
    const firstTs = Date.parse('2026-08-08T02:20:00.000Z');
    const secondTs = firstTs + 1_000;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        const durableMessages = [
          {
            id: 'foreign-identical-1',
            role: 'user',
            content: 'Run the same check',
            timestamp: new Date(firstTs).toISOString(),
          },
          {
            id: 'foreign-identical-2',
            role: 'user',
            content: 'Run the same check',
            timestamp: new Date(secondTs).toISOString(),
          },
        ].slice(0, durableCount);
        return {
          data: {
            activeStream: {
              active: true,
              runId: 'foreign-identical-run',
              phase: 'thinking',
              startedAt: firstTs,
            },
            messages: durableMessages,
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'user_message',
        sessionKey: 'agent:main:first',
        runId: 'foreign-identical-run',
        messageId: 'foreign-identical-1',
        messageTimestamp: firstTs,
        content: 'Run the same check',
      });
      socket.emit({
        type: 'user_message',
        sessionKey: 'agent:main:first',
        runId: 'foreign-identical-run',
        messageId: 'foreign-identical-2',
        messageTimestamp: secondTs,
        content: 'Run the same check',
      });
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'first-identical-row-durable',
      });
    });

    await waitFor(() => {
      const parsed = JSON.parse(screen.getByTestId('messages').textContent || '[]');
      expect(parsed.filter((message: { role: string; content: string }) => (
        message.role === 'user' && message.content === 'Run the same check'
      ))).toHaveLength(2);
    });

    durableCount = 2;
    act(() => {
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'second-identical-row-durable',
      });
    });
    await waitFor(() => {
      const parsed = JSON.parse(screen.getByTestId('messages').textContent || '[]');
      const identical = parsed.filter((message: { role: string; content: string }) => (
        message.role === 'user' && message.content === 'Run the same check'
      ));
      expect(identical.map((message: { id: string }) => message.id)).toEqual([
        'foreign-identical-1',
        'foreign-identical-2',
      ]);
    });
  });

  it('preserves R1 thinking and text before an HTTP snapshot adopts replacement run R2', async () => {
    let replacementSnapshotReady = false;
    let replacementRevision = 1;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        return {
          data: {
            activeStream: replacementSnapshotReady ? {
              active: true,
              runId: 'replacement-r2',
              phase: 'streaming',
              content: 'R2 replacement text',
              startedAt: Date.now(),
              turnEvents: [{
                schema: 'bridgesllm.runtime-turn-event.v1',
                type: 'assistant_reasoning',
                sessionKey: 'agent:main:first',
                runId: 'replacement-r2',
                seq: 1,
                ts: Date.now(),
                text: 'R2 preamble restored after replacement adoption',
                replace: true,
                visible: true,
                source: {
                  transport: 'portal-stream-event-bus',
                  eventType: 'status',
                  preambleProgress: true,
                },
              }],
            } : { active: false },
            messages: replacementSnapshotReady ? [{
              id: 'runtime-r2-overlay',
              role: 'assistant',
              content: 'R2 replacement text',
              timestamp: '2026-08-08T03:00:00.000Z',
              provenance: 'runtime-turn-event-history',
              segments: [
                {
                  text: 'R2 preamble restored after replacement adoption',
                  position: 'before',
                  kind: 'thinking',
                  source: 'preamble',
                  ts: Date.parse('2026-08-08T03:00:00.000Z'),
                  order: 0,
                },
                ...(replacementRevision > 1 ? [{
                  text: 'R2 durable phase added on the second refresh',
                  position: 'between',
                  kind: 'thinking',
                  source: 'preamble',
                  ts: Date.parse('2026-08-08T03:00:02.000Z'),
                  order: 2,
                }] : []),
              ],
              toolCalls: [
                {
                  id: 'r2-read',
                  name: 'Read',
                  startedAt: Date.parse('2026-08-08T03:00:01.000Z'),
                  endedAt: replacementRevision > 1
                    ? Date.parse('2026-08-08T03:00:01.500Z')
                    : undefined,
                  status: replacementRevision > 1 ? 'done' : 'running',
                  order: 1,
                },
                ...(replacementRevision > 1 ? [{
                  id: 'r2-exec',
                  name: 'Exec',
                  startedAt: Date.parse('2026-08-08T03:00:03.000Z'),
                  status: 'running',
                  order: 3,
                }] : []),
              ],
              __portal: {
                kind: 'runtime-turn-event-history',
                runId: 'replacement-r2',
              },
            }] : [],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'run_resumed',
        sessionKey: 'agent:main:first',
        runId: 'predecessor-r1',
      });
      socket.emit({
        type: 'thinking',
        sessionKey: 'agent:main:first',
        runId: 'predecessor-r1',
        content: 'R1 visible reasoning',
      });
      socket.emit({
        type: 'text',
        sessionKey: 'agent:main:first',
        runId: 'predecessor-r1',
        content: 'R1 visible answer fragment',
      });
    });
    replacementSnapshotReady = true;
    act(() => {
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'replacement-run-ready',
      });
    });

    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent('R2 replacement text'));
    expect(screen.getByTestId('thinking')).toHaveTextContent('R1 visible reasoning');
    expect(screen.getByTestId('thinking')).toHaveTextContent('R1 visible answer fragment');
    expect(screen.getByTestId('thinking')).toHaveTextContent(
      'R2 preamble restored after replacement adoption',
    );
    let adoptedMessages = JSON.parse(screen.getByTestId('messages').textContent || '[]');
    expect(adoptedMessages.filter((message: { runtimeRunId?: string }) => (
      message.runtimeRunId === 'replacement-r2'
    ))).toHaveLength(1);
    const firstTimeline = JSON.parse(screen.getByTestId('thinking').textContent || '{}').segments;
    const r1TextOrder = firstTimeline.find((segment: { text: string }) => (
      segment.text === 'R1 visible answer fragment'
    ))?.order;
    const r2PreambleOrder = firstTimeline.find((segment: { text: string }) => (
      segment.text === 'R2 preamble restored after replacement adoption'
    ))?.order;
    expect(r2PreambleOrder).toBeGreaterThan(r1TextOrder);

    replacementRevision = 2;
    act(() => {
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'replacement-overlay-updated',
      });
    });
    await waitFor(() => expect(screen.getByTestId('thinking')).toHaveTextContent(
      'R2 durable phase added on the second refresh',
    ));
    adoptedMessages = JSON.parse(screen.getByTestId('messages').textContent || '[]');
    expect(adoptedMessages.filter((message: { runtimeRunId?: string }) => (
      message.runtimeRunId === 'replacement-r2'
    ))).toHaveLength(1);
    const activeProjection = adoptedMessages.find((message: { runtimeRunId?: string }) => (
      message.runtimeRunId === 'replacement-r2'
    ));
    expect(activeProjection.toolCalls.map((tool: { id: string }) => tool.id)).toEqual([
      'r2-read',
      'r2-exec',
    ]);

    const preLiveContinuation = JSON.parse(screen.getByTestId('thinking').textContent || '{}').segments;
    const maxOverlayOrder = Math.max(...preLiveContinuation.map((segment: { order: number }) => segment.order));
    act(() => {
      socket.emit({
        type: 'tool_end',
        sessionKey: 'agent:main:first',
        runId: 'replacement-r2',
        toolCallId: 'r2-exec',
        toolName: 'Exec',
        status: 'done',
      });
      socket.emit({
        type: 'thinking',
        sessionKey: 'agent:main:first',
        runId: 'replacement-r2',
        content: 'R2 live reasoning after repeated history refresh',
        replace: true,
      });
      socket.emit({
        type: 'tool_start',
        sessionKey: 'agent:main:first',
        runId: 'replacement-r2',
        toolCallId: 'r2-post-refresh-tool',
        toolName: 'Read',
      });
    });
    const postRefreshTimeline = JSON.parse(screen.getByTestId('thinking').textContent || '{}').segments;
    const postRefreshReasoning = postRefreshTimeline.find((segment: { text: string }) => (
      segment.text === 'R2 live reasoning after repeated history refresh'
    ));
    expect(postRefreshReasoning.order).toBeGreaterThan(maxOverlayOrder);
    expect(screen.getByTestId('is-running')).toHaveTextContent('running');
  });

  it('keeps one live assistant identity when reconnect history commits R1 before the R1 to R2 recovery', async () => {
    const user = userEvent.setup();
    const r1RunId = 'portal-r1-before-gateway-restart';
    const r2RunId = 'gateway-recovery-r2';
    const r1Text = 'Starting the regression test sequence now. RAIL_PRE';
    const r2Text = 'Tool execution completed as expected. RAIL_POST';
    const toolId = 'r1-exec-tool';
    const baseTs = Date.now();
    let historyPhase: 'empty' | 'r1-committed' | 'terminal' = 'empty';
    let historyReads = 0;
    const durableR1 = {
      id: 'durable-r1-assistant',
      role: 'assistant',
      content: r1Text,
      timestamp: new Date(baseTs).toISOString(),
      toolCalls: [{
        id: toolId,
        name: 'exec',
        status: 'done',
        result: 'RAIL_TOOL',
        startedAt: baseTs + 10,
        endedAt: baseTs + 20,
        order: 1,
      }],
    };
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        historyReads += 1;
        return {
          data: historyPhase === 'terminal'
            ? {
                activeStream: { active: false, inactiveReason: 'terminal', safeToClear: true },
                messages: [
                  durableR1,
                  {
                    id: 'durable-r2-assistant',
                    role: 'assistant',
                    content: r2Text,
                    timestamp: new Date(baseTs + 30).toISOString(),
                  },
                ],
                pagination: { beforeCursor: null, hasMoreBefore: false },
              }
            : {
                // The Portal reconnect can read the now-durable R1 transcript
                // while the gateway is still down. The subsequent stream_resume
                // is the first active snapshot that arrives after restart.
                activeStream: { active: false },
                messages: historyPhase === 'r1-committed' ? [durableR1] : [],
                pagination: { beforeCursor: null, hasMoreBefore: false },
              },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const startupHistoryReads = historyReads;
    const firstSocket = PendingWebSocket.instances[0];

    act(() => {
      firstSocket.open();
      firstSocket.emit({ type: 'connected' });
      firstSocket.emit({
        type: 'run_resumed',
        sessionKey: 'agent:main:first',
        runId: r1RunId,
      });
      firstSocket.emit({
        type: 'text',
        sessionKey: 'agent:main:first',
        runId: r1RunId,
        content: r1Text,
      });
      firstSocket.emit({
        type: 'tool_start',
        sessionKey: 'agent:main:first',
        runId: r1RunId,
        toolCallId: toolId,
        toolName: 'exec',
      });
      firstSocket.emit({
        type: 'tool_end',
        sessionKey: 'agent:main:first',
        runId: r1RunId,
        toolCallId: toolId,
        toolName: 'exec',
        toolResult: 'RAIL_TOOL',
      });
    });
    const liveAssistantId = screen.getByTestId('streaming-assistant-id').textContent || '';
    expect(liveAssistantId).toBeTruthy();

    historyPhase = 'r1-committed';
    act(() => {
      firstSocket.onclose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);
    });
    await user.click(screen.getByRole('button', { name: 'Reconnect socket' }));
    const recoveredSocket = PendingWebSocket.instances.at(-1)!;
    act(() => recoveredSocket.open());
    await waitFor(() => expect(historyReads).toBeGreaterThan(startupHistoryReads));

    act(() => {
      recoveredSocket.emit({
        type: 'stream_resume',
        sessionKey: 'agent:main:first',
        runId: r1RunId,
        phase: 'tool',
        content: r1Text,
        statusText: 'Reconnecting to stream…',
        toolCalls: [{
          id: toolId,
          name: 'exec',
          status: 'done',
          result: 'RAIL_TOOL',
          startedAt: baseTs + 10,
          endedAt: baseTs + 20,
        }],
        turnEvents: [],
      });
    });

    let assistants = JSON.parse(screen.getByTestId('messages').textContent || '[]')
      .filter((message: { role: string }) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ id: liveAssistantId });
    expect(JSON.parse(screen.getByTestId('thinking').textContent || '{}').segments)
      .toContainEqual(expect.objectContaining({ kind: 'text', text: r1Text }));

    historyPhase = 'terminal';
    act(() => {
      recoveredSocket.emit({
        type: 'run_resumed',
        sessionKey: 'agent:main:first',
        runId: r2RunId,
      });
      recoveredSocket.emit({
        type: 'thinking',
        sessionKey: 'agent:main:first',
        runId: r2RunId,
        content: 'Continuing after the exact gateway recovery',
      });
      recoveredSocket.emit({
        type: 'done',
        sessionKey: 'agent:main:first',
        runId: r2RunId,
        content: r2Text,
      });
    });
    await user.click(screen.getByRole('button', { name: 'Retry history' }));

    await waitFor(() => {
      assistants = JSON.parse(screen.getByTestId('messages').textContent || '[]')
        .filter((message: { role: string }) => message.role === 'assistant');
      expect(assistants.map((message: { id: string }) => message.id)).toEqual([
        'durable-r1-assistant',
        'durable-r2-assistant',
      ]);
    });
  });

  it('keeps the richer live identity when split durable tool and prefix rows collapse during recovery', async () => {
    const runId = 'split-history-r1';
    const r1Prefix = 'Starting the split-history recovery sequence.';
    const r1Text = `${r1Prefix} RAIL_PRE cumulative continuation.`;
    const toolId = 'split-history-tool';
    const baseTs = Date.now();
    let durableHistoryReady = false;
    let historyReads = 0;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        historyReads += 1;
        return {
          data: {
            activeStream: durableHistoryReady
              ? { active: true, runId, phase: 'streaming', content: r1Text, startedAt: baseTs }
              : { active: false },
            messages: durableHistoryReady ? [
              {
                id: 'durable-r1-tool-only',
                role: 'assistant',
                content: '',
                timestamp: new Date(baseTs).toISOString(),
                toolCalls: [{
                  id: toolId,
                  name: 'exec',
                  status: 'done',
                  result: 'RAIL_TOOL',
                  startedAt: baseTs,
                  endedAt: baseTs + 10,
                }],
              },
              {
                id: 'durable-r1-text',
                role: 'assistant',
                content: r1Prefix,
                timestamp: new Date(baseTs + 11).toISOString(),
              },
            ] : [],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const startupHistoryReads = historyReads;
    const socket = PendingWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({ type: 'run_resumed', sessionKey: 'agent:main:first', runId });
      socket.emit({
        type: 'tool_start',
        sessionKey: 'agent:main:first',
        runId,
        toolCallId: toolId,
        toolName: 'exec',
      });
      socket.emit({
        type: 'tool_end',
        sessionKey: 'agent:main:first',
        runId,
        toolCallId: toolId,
        toolName: 'exec',
        toolResult: 'RAIL_TOOL',
      });
      socket.emit({
        type: 'text',
        sessionKey: 'agent:main:first',
        runId,
        content: r1Text,
      });
    });
    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent(r1Text));
    const liveAssistantId = screen.getByTestId('streaming-assistant-id').textContent || '';
    expect(liveAssistantId).toBeTruthy();

    durableHistoryReady = true;
    act(() => {
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'split-r1-history-committed',
      });
    });
    await waitFor(() => expect(historyReads).toBeGreaterThan(startupHistoryReads));
    act(() => {
      socket.emit({
        type: 'stream_resume',
        sessionKey: 'agent:main:first',
        runId,
        phase: 'streaming',
        content: r1Text,
        toolCalls: [{
          id: toolId,
          name: 'exec',
          status: 'done',
          result: 'RAIL_TOOL',
          startedAt: baseTs,
          endedAt: baseTs + 10,
        }],
        turnEvents: [],
      });
    });

    const assistants = JSON.parse(screen.getByTestId('messages').textContent || '[]')
      .filter((message: { role: string }) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ id: liveAssistantId, content: r1Text });
    expect(screen.getByTestId('messages')).not.toHaveTextContent('durable-r1-tool-only');
  });

  it('pairs same-run split projections across an in-turn steer', async () => {
    const runId = 'same-run-steer-split-r1';
    const r1Text = 'The same active run continues after the alternate-channel steer.';
    const toolId = 'same-run-steer-tool';
    const baseTs = Date.now();
    const initialUserTs = baseTs - 1_000;
    let durableHistoryReady = false;
    let historyReads = 0;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        historyReads += 1;
        return {
          data: {
            activeStream: { active: false },
            messages: durableHistoryReady ? [
              {
                id: 'same-run-steer-initial-user',
                role: 'user',
                content: 'Start the same-run split turn',
                timestamp: new Date(initialUserTs).toISOString(),
              },
              {
                id: 'same-run-steer-tool-only',
                role: 'assistant',
                content: '',
                timestamp: new Date(baseTs + 10).toISOString(),
                provenance: 'runtime-turn-event-history',
                toolCalls: [{
                  id: toolId,
                  name: 'exec',
                  status: 'done',
                  result: 'same-run result',
                  startedAt: baseTs + 10,
                  endedAt: baseTs + 20,
                }],
                __portal: { kind: 'runtime-turn-event-history', runId },
              },
              {
                id: 'same-run-steer-user',
                role: 'user',
                content: 'Continue this same run after the tool',
                timestamp: new Date(baseTs + 30).toISOString(),
              },
              {
                id: 'same-run-steer-visible',
                role: 'assistant',
                content: r1Text,
                timestamp: new Date(baseTs + 40).toISOString(),
                provenance: 'runtime-turn-event-history',
                __portal: { kind: 'runtime-turn-event-history', runId },
              },
            ] : [],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const startupHistoryReads = historyReads;
    const socket = PendingWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'user_message',
        sessionKey: 'agent:main:first',
        runId,
        messageId: 'same-run-steer-initial-user',
        messageTimestamp: initialUserTs,
        content: 'Start the same-run split turn',
      });
      socket.emit({ type: 'run_resumed', sessionKey: 'agent:main:first', runId });
      socket.emit({
        type: 'tool_start',
        sessionKey: 'agent:main:first',
        runId,
        toolCallId: toolId,
        toolName: 'exec',
      });
      socket.emit({
        type: 'user_message',
        sessionKey: 'agent:main:first',
        runId,
        messageId: 'same-run-steer-user',
        messageTimestamp: baseTs + 30,
        content: 'Continue this same run after the tool',
      });
      socket.emit({
        type: 'text',
        sessionKey: 'agent:main:first',
        runId,
        content: r1Text,
      });
    });
    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent(r1Text));
    const liveAssistantId = screen.getByTestId('streaming-assistant-id').textContent || '';
    expect(liveAssistantId).toBeTruthy();

    durableHistoryReady = true;
    act(() => {
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'same-run-steer-split-history',
      });
    });
    await waitFor(() => expect(historyReads).toBeGreaterThan(startupHistoryReads));

    const assistants = JSON.parse(screen.getByTestId('messages').textContent || '[]')
      .filter((message: { role: string }) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({
      id: liveAssistantId,
      runtimeRunId: runId,
      content: r1Text,
    });
    expect(assistants[0].toolCalls[0]).toMatchObject({ id: toolId });
    expect(screen.getByTestId('messages')).not.toHaveTextContent('same-run-steer-tool-only');
  });

  it('does not pair a current tool-only projection across a user boundary with identical text', async () => {
    const runId = 'scoped-split-r1';
    const repeatedText = 'A historical response can match the current live text.';
    const currentToolId = 'scoped-current-tool';
    const baseTs = Date.now();
    const currentUserTs = baseTs - 1_000;
    let durableHistoryReady = false;
    let historyReads = 0;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        historyReads += 1;
        return {
          data: {
            activeStream: { active: false },
            messages: durableHistoryReady ? [
              {
                id: 'scoped-old-user',
                role: 'user',
                content: 'Start the historical turn',
                timestamp: new Date(baseTs - 7_000).toISOString(),
              },
              {
                id: 'scoped-unrelated-old-tool',
                role: 'assistant',
                content: '',
                timestamp: new Date(baseTs - 6_500).toISOString(),
                toolCalls: [{
                  id: 'unrelated-old-tool-id',
                  name: 'exec',
                  status: 'done',
                  result: 'historical result',
                  startedAt: baseTs - 6_500,
                  endedAt: baseTs - 6_400,
                }],
              },
              {
                id: 'scoped-old-identical-assistant',
                role: 'assistant',
                content: repeatedText,
                // Deliberately inside the 10s clock tolerance. Only transcript
                // structure (the current user between these rows) separates it.
                timestamp: new Date(baseTs - 5_000).toISOString(),
              },
              {
                id: 'scoped-current-user',
                role: 'user',
                content: 'Start the current turn',
                timestamp: new Date(currentUserTs).toISOString(),
              },
              {
                id: 'scoped-current-tool-only',
                role: 'assistant',
                content: '',
                timestamp: new Date(baseTs + 10).toISOString(),
                toolCalls: [{
                  id: currentToolId,
                  name: 'exec',
                  status: 'running',
                  startedAt: baseTs + 10,
                }],
              },
            ] : [],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const startupHistoryReads = historyReads;
    const socket = PendingWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'user_message',
        sessionKey: 'agent:main:first',
        runId,
        messageId: 'scoped-current-user',
        messageTimestamp: currentUserTs,
        content: 'Start the current turn',
      });
      socket.emit({ type: 'run_resumed', sessionKey: 'agent:main:first', runId });
      socket.emit({
        type: 'tool_start',
        sessionKey: 'agent:main:first',
        runId,
        toolCallId: currentToolId,
        toolName: 'exec',
      });
      socket.emit({
        type: 'text',
        sessionKey: 'agent:main:first',
        runId,
        content: repeatedText,
      });
    });
    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent(repeatedText));
    const liveAssistantId = screen.getByTestId('streaming-assistant-id').textContent || '';
    expect(liveAssistantId).toBeTruthy();

    durableHistoryReady = true;
    act(() => {
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'scoped-split-history',
      });
    });
    await waitFor(() => expect(historyReads).toBeGreaterThan(startupHistoryReads));

    const assistants = JSON.parse(screen.getByTestId('messages').textContent || '[]')
      .filter((message: { role: string }) => message.role === 'assistant');
    expect(assistants.map((message: { id: string }) => message.id)).toEqual([
      'scoped-unrelated-old-tool',
      'scoped-old-identical-assistant',
      liveAssistantId,
    ]);
    expect(assistants[0].toolCalls[0]).toMatchObject({ id: 'unrelated-old-tool-id' });
    expect(assistants[2]).toMatchObject({ id: liveAssistantId, content: repeatedText });
    expect(assistants[2].toolCalls[0]).toMatchObject({ id: currentToolId });
    expect(screen.getByTestId('messages')).not.toHaveTextContent('scoped-current-tool-only');
  });

  it('binds the live identity to the current durable R1 when older assistant text is identical', async () => {
    const runId = 'identical-history-r1';
    const repeatedText = 'The same assistant response can legitimately be sent again.';
    const baseTs = Date.now();
    const currentUserTs = baseTs - 1_000;
    let durableHistoryReady = false;
    let historyReads = 0;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        historyReads += 1;
        return {
          data: {
            activeStream: durableHistoryReady
              ? { active: true, runId, phase: 'streaming', content: repeatedText, startedAt: baseTs }
              : { active: false },
            messages: durableHistoryReady ? [
              {
                id: 'older-identical-user',
                role: 'user',
                content: 'Repeat the response from the old turn',
                timestamp: new Date(baseTs - 3_601_000).toISOString(),
              },
              {
                id: 'older-identical-assistant',
                role: 'assistant',
                content: repeatedText,
                timestamp: new Date(baseTs - 3_600_000).toISOString(),
              },
              {
                id: 'current-identical-user',
                role: 'user',
                content: 'Repeat the response for the current turn',
                timestamp: new Date(currentUserTs).toISOString(),
              },
              {
                id: 'current-durable-r1-assistant',
                role: 'assistant',
                content: repeatedText,
                timestamp: new Date(baseTs + 10).toISOString(),
              },
            ] : [],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const startupHistoryReads = historyReads;
    const socket = PendingWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'user_message',
        sessionKey: 'agent:main:first',
        runId,
        messageId: 'current-identical-user',
        messageTimestamp: currentUserTs,
        content: 'Repeat the response for the current turn',
      });
      socket.emit({ type: 'run_resumed', sessionKey: 'agent:main:first', runId });
      socket.emit({
        type: 'text',
        sessionKey: 'agent:main:first',
        runId,
        content: repeatedText,
      });
      // A later cross-channel steer belongs to the same active run, but it did
      // not initiate this assistant bubble and must not move its match boundary.
      socket.emit({
        type: 'user_message',
        sessionKey: 'agent:main:first',
        runId,
        messageId: 'later-identical-steer',
        messageTimestamp: baseTs + 30_000,
        content: 'Keep going after the current response starts',
      });
    });
    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent(repeatedText));
    const liveAssistantId = screen.getByTestId('streaming-assistant-id').textContent || '';
    expect(liveAssistantId).toBeTruthy();

    durableHistoryReady = true;
    act(() => {
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'current-identical-r1-committed',
      });
    });
    await waitFor(() => expect(historyReads).toBeGreaterThan(startupHistoryReads));

    const assistants = JSON.parse(screen.getByTestId('messages').textContent || '[]')
      .filter((message: { role: string }) => message.role === 'assistant');
    expect(assistants.map((message: { id: string }) => message.id)).toEqual([
      'older-identical-assistant',
      liveAssistantId,
    ]);
  });

  it('does not let a lone far historical identical assistant hijack the live identity', async () => {
    const runId = 'old-only-identical-r1';
    const repeatedText = 'The same assistant response can legitimately be sent again.';
    const baseTs = Date.now();
    const currentUserTs = baseTs - 1_000;
    let durableHistoryReady = false;
    let historyReads = 0;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        historyReads += 1;
        return {
          data: {
            activeStream: durableHistoryReady
              ? { active: true, runId, phase: 'streaming', content: repeatedText, startedAt: baseTs }
              : { active: false },
            messages: durableHistoryReady ? [
              {
                id: 'old-only-identical-user',
                role: 'user',
                content: 'Repeat the response from the old turn',
                timestamp: new Date(baseTs - 3_601_000).toISOString(),
              },
              {
                id: 'old-only-identical-assistant',
                role: 'assistant',
                content: repeatedText,
                timestamp: new Date(baseTs - 3_600_000).toISOString(),
              },
              {
                id: 'old-only-current-user',
                role: 'user',
                content: 'Repeat the response for the current turn',
                timestamp: new Date(currentUserTs).toISOString(),
              },
            ] : [],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const startupHistoryReads = historyReads;
    const socket = PendingWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'user_message',
        sessionKey: 'agent:main:first',
        runId,
        messageId: 'old-only-current-user',
        messageTimestamp: currentUserTs,
        content: 'Repeat the response for the current turn',
      });
      socket.emit({ type: 'run_resumed', sessionKey: 'agent:main:first', runId });
      socket.emit({
        type: 'text',
        sessionKey: 'agent:main:first',
        runId,
        content: repeatedText,
      });
    });
    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent(repeatedText));
    const liveAssistantId = screen.getByTestId('streaming-assistant-id').textContent || '';
    expect(liveAssistantId).toBeTruthy();

    durableHistoryReady = true;
    act(() => {
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'old-only-identical-history',
      });
    });
    await waitFor(() => expect(historyReads).toBeGreaterThan(startupHistoryReads));

    const assistants = JSON.parse(screen.getByTestId('messages').textContent || '[]')
      .filter((message: { role: string }) => message.role === 'assistant');
    expect(assistants.map((message: { id: string }) => message.id)).toEqual([
      'old-only-identical-assistant',
      liveAssistantId,
    ]);
    expect(screen.getByTestId('streaming-assistant-id')).toHaveTextContent(liveAssistantId);
  });

  it('retains a mismatched runtime row without letting it consume the live assistant', async () => {
    const activeRunId = 'runtime-authority-r2';
    const staleRunId = 'runtime-authority-r1';
    const toolId = 'shared-runtime-tool-id';
    const activeText = 'Current runtime result continues beyond the stale prefix.';
    const baseTs = Date.now();
    const currentUserTs = baseTs - 1_000;
    let durableHistoryReady = false;
    let historyReads = 0;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        historyReads += 1;
        return {
          data: {
            // The inactive snapshot is intentionally ambiguous. It must not
            // override the locally authoritative R2 or make stale R1 eligible.
            activeStream: { active: false },
            messages: durableHistoryReady ? [
              {
                id: 'stale-runtime-user',
                role: 'user',
                content: 'Start the superseded runtime turn',
                timestamp: new Date(baseTs - 61_000).toISOString(),
              },
              {
                id: 'stale-runtime-assistant',
                role: 'assistant',
                content: 'Current runtime result',
                timestamp: new Date(baseTs - 60_000).toISOString(),
                provenance: 'runtime-turn-event-history',
                toolCalls: [{
                  id: toolId,
                  name: 'exec',
                  status: 'done',
                  result: 'stale result',
                  startedAt: baseTs - 60_000,
                  endedAt: baseTs - 59_000,
                }],
                __portal: { kind: 'runtime-turn-event-history', runId: staleRunId },
              },
              {
                id: 'runtime-authority-current-user',
                role: 'user',
                content: 'Start the authoritative runtime turn',
                timestamp: new Date(currentUserTs).toISOString(),
              },
            ] : [],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const startupHistoryReads = historyReads;
    const socket = PendingWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'user_message',
        sessionKey: 'agent:main:first',
        runId: activeRunId,
        messageId: 'runtime-authority-current-user',
        messageTimestamp: currentUserTs,
        content: 'Start the authoritative runtime turn',
      });
      socket.emit({ type: 'run_resumed', sessionKey: 'agent:main:first', runId: activeRunId });
      socket.emit({
        type: 'tool_start',
        sessionKey: 'agent:main:first',
        runId: activeRunId,
        toolCallId: toolId,
        toolName: 'exec',
      });
      socket.emit({
        type: 'text',
        sessionKey: 'agent:main:first',
        runId: activeRunId,
        content: activeText,
      });
    });
    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent(activeText));
    const liveAssistantId = screen.getByTestId('streaming-assistant-id').textContent || '';
    expect(liveAssistantId).toBeTruthy();

    durableHistoryReady = true;
    act(() => {
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'mismatched-runtime-history',
      });
    });
    await waitFor(() => expect(historyReads).toBeGreaterThan(startupHistoryReads));

    let assistants = JSON.parse(screen.getByTestId('messages').textContent || '[]')
      .filter((message: { role: string }) => message.role === 'assistant');
    expect(assistants.map((message: { id: string }) => message.id)).toEqual([
      'stale-runtime-assistant',
      liveAssistantId,
    ]);
    expect(assistants[0]).toMatchObject({ runtimeRunId: staleRunId });
    expect(assistants[1]).toMatchObject({ id: liveAssistantId, content: activeText });
    expect(screen.getByTestId('streaming-assistant-id')).toHaveTextContent(liveAssistantId);

    act(() => {
      socket.emit({
        type: 'stream_resume',
        sessionKey: 'agent:main:first',
        runId: activeRunId,
        phase: 'tool',
        content: activeText,
        toolCalls: [{ id: toolId, name: 'exec', status: 'running' }],
        turnEvents: [],
      });
    });
    assistants = JSON.parse(screen.getByTestId('messages').textContent || '[]')
      .filter((message: { role: string }) => message.role === 'assistant');
    expect(assistants.map((message: { id: string }) => message.id)).toEqual([
      'stale-runtime-assistant',
      liveAssistantId,
    ]);
  });

  it('reuses a matching R1 runtime row from an ambiguous inactive reconnect history', async () => {
    const runId = 'runtime-history-r1';
    const r1Text = 'R1 runtime history must remain the single live assistant.';
    const baseTs = Date.now();
    let runtimeHistoryReady = false;
    let historyReads = 0;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        historyReads += 1;
        return {
          data: {
            activeStream: { active: false },
            messages: runtimeHistoryReady ? [{
              id: 'runtime-r1-history-row',
              role: 'assistant',
              content: r1Text,
              timestamp: new Date(baseTs).toISOString(),
              provenance: 'runtime-turn-event-history',
              __portal: { kind: 'runtime-turn-event-history', runId },
            }] : [],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const startupHistoryReads = historyReads;
    const socket = PendingWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({ type: 'run_resumed', sessionKey: 'agent:main:first', runId });
      socket.emit({
        type: 'text',
        sessionKey: 'agent:main:first',
        runId,
        content: r1Text,
      });
    });
    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent(r1Text));
    const liveAssistantId = screen.getByTestId('streaming-assistant-id').textContent || '';
    expect(liveAssistantId).toBeTruthy();

    runtimeHistoryReady = true;
    act(() => {
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'ambiguous-inactive-runtime-r1-history',
      });
    });
    await waitFor(() => expect(historyReads).toBeGreaterThan(startupHistoryReads));
    act(() => {
      socket.emit({
        type: 'stream_resume',
        sessionKey: 'agent:main:first',
        runId,
        phase: 'streaming',
        content: r1Text,
        turnEvents: [],
      });
    });

    const assistants = JSON.parse(screen.getByTestId('messages').textContent || '[]')
      .filter((message: { role: string }) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({
      id: liveAssistantId,
      runtimeRunId: runId,
      content: r1Text,
    });
  });

  it('does not regress newer same-run cumulative thinking to a delayed overlay prefix', async () => {
    let overlayReady = false;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        return {
          data: {
            activeStream: overlayReady
              ? {
                  active: true,
                  runId: 'same-run-prefix',
                  phase: 'thinking',
                  startedAt: Date.now(),
                  turnEvents: [],
                }
              : { active: false },
            messages: overlayReady ? [{
              id: 'same-run-prefix-overlay',
              role: 'assistant',
              content: '',
              timestamp: '2026-08-08T03:10:00.000Z',
              provenance: 'runtime-turn-event-history',
              segments: [{
                text: 'Inspecting files',
                position: 'before',
                kind: 'thinking',
                source: 'preamble',
                ts: Date.parse('2026-08-08T03:10:00.000Z'),
                order: 0,
              }],
              __portal: {
                kind: 'runtime-turn-event-history',
                runId: 'same-run-prefix',
              },
            }] : [],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'run_resumed',
        sessionKey: 'agent:main:first',
        runId: 'same-run-prefix',
      });
      socket.emit({
        type: 'status',
        sessionKey: 'agent:main:first',
        runId: 'same-run-prefix',
        turnEvent: {
          schema: 'bridgesllm.runtime-turn-event.v1',
          type: 'assistant_reasoning',
          sessionKey: 'agent:main:first',
          runId: 'same-run-prefix',
          seq: 1,
          text: 'Inspecting files and tests',
          replace: true,
          visible: true,
          source: {
            transport: 'portal-stream-event-bus',
            eventType: 'status',
            preambleProgress: true,
          },
        },
      });
    });
    overlayReady = true;
    act(() => {
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'delayed-prefix-overlay',
      });
    });

    await waitFor(() => {
      const thinking = JSON.parse(screen.getByTestId('thinking').textContent || '{}');
      expect(thinking.content).toBe('Inspecting files and tests');
      expect(thinking.segments.map((segment: { text: string }) => segment.text))
        .not.toContain('Inspecting files');
    });
  });

  it('dedupes an identical preamble overlay after the live thought graduates at a tool boundary', async () => {
    let overlayReady = false;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        return {
          data: {
            activeStream: overlayReady
              ? { active: true, runId: 'same-run-graduated', phase: 'tool', startedAt: Date.now() }
              : { active: false },
            messages: overlayReady ? [{
              id: 'same-run-graduated-overlay',
              role: 'assistant',
              content: '',
              timestamp: '2026-08-08T03:15:00.000Z',
              provenance: 'runtime-turn-event-history',
              segments: [{
                text: 'Exact preamble before tool',
                position: 'before',
                kind: 'thinking',
                source: 'preamble',
                ts: Date.parse('2026-08-08T03:15:00.000Z'),
                order: 0,
              }],
              __portal: {
                kind: 'runtime-turn-event-history',
                runId: 'same-run-graduated',
              },
            }] : [],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'run_resumed',
        sessionKey: 'agent:main:first',
        runId: 'same-run-graduated',
      });
      socket.emit({
        type: 'status',
        sessionKey: 'agent:main:first',
        runId: 'same-run-graduated',
        turnEvent: {
          schema: 'bridgesllm.runtime-turn-event.v1',
          type: 'assistant_reasoning',
          sessionKey: 'agent:main:first',
          runId: 'same-run-graduated',
          seq: 1,
          text: 'Exact preamble before tool',
          replace: true,
          visible: true,
          source: {
            transport: 'portal-stream-event-bus',
            eventType: 'status',
            preambleProgress: true,
          },
        },
      });
      socket.emit({
        type: 'tool_start',
        sessionKey: 'agent:main:first',
        runId: 'same-run-graduated',
        toolCallId: 'same-run-read',
        toolName: 'Read',
      });
    });
    overlayReady = true;
    act(() => {
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'graduated-preamble-durable',
      });
    });

    await waitFor(() => {
      const thinking = JSON.parse(screen.getByTestId('thinking').textContent || '{}');
      expect(thinking.segments.filter((segment: { text: string }) => (
        segment.text === 'Exact preamble before tool'
      ))).toHaveLength(1);
    });
  });

  it('dedupes a persisted status-source thought after the live status graduates at a tool boundary', async () => {
    let overlayReady = false;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        return {
          data: {
            activeStream: overlayReady
              ? { active: true, runId: 'same-run-status', phase: 'tool', startedAt: Date.now() }
              : { active: false },
            messages: overlayReady ? [{
              id: 'same-run-status-overlay',
              role: 'assistant',
              content: '',
              timestamp: '2026-08-08T03:16:00.000Z',
              provenance: 'runtime-turn-event-history',
              segments: [{
                text: 'Exact status reasoning before tool',
                position: 'before',
                kind: 'thinking',
                source: 'status',
                ts: Date.parse('2026-08-08T03:16:00.000Z'),
                order: 0,
              }],
              __portal: {
                kind: 'runtime-turn-event-history',
                runId: 'same-run-status',
              },
            }] : [],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'run_resumed',
        sessionKey: 'agent:main:first',
        runId: 'same-run-status',
      });
      socket.emit({
        type: 'status',
        sessionKey: 'agent:main:first',
        runId: 'same-run-status',
        content: 'Exact status reasoning before tool',
      });
      socket.emit({
        type: 'tool_start',
        sessionKey: 'agent:main:first',
        runId: 'same-run-status',
        toolCallId: 'same-run-status-read',
        toolName: 'Read',
      });
    });
    const liveThinking = JSON.parse(screen.getByTestId('thinking').textContent || '{}');
    expect(liveThinking.segments.filter((segment: { text: string }) => (
      segment.text === 'Exact status reasoning before tool'
    ))).toEqual([
      expect.objectContaining({ lane: 'raw' }),
    ]);
    overlayReady = true;
    act(() => {
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'graduated-status-durable',
      });
    });

    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent(
      '"runtimeRunId":"same-run-status"',
    ));
    await waitFor(() => {
      const thinking = JSON.parse(screen.getByTestId('thinking').textContent || '{}');
      expect(thinking.segments.filter((segment: { text: string }) => (
        segment.text === 'Exact status reasoning before tool'
      ))).toHaveLength(1);
    });
  });

  it('merges durable cross-channel history after the upstream message subscription returns', async () => {
    let durablePromptReady = false;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        return {
          data: {
            activeStream: durablePromptReady
              ? { active: true, runId: 'outage-run', phase: 'thinking', startedAt: Date.now() }
              : { active: false },
            messages: durablePromptReady ? [{
              id: 'discord-during-outage',
              role: 'user',
              content: 'Prompt sent while the gateway was restarting',
              timestamp: '2026-08-08T02:05:00.000Z',
            }] : [],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];
    durablePromptReady = true;

    act(() => {
      socket.open();
      socket.emit({
        type: 'history_changed',
        sessionKey: 'agent:main:first',
        reason: 'gateway-session-resubscribed',
      });
    });

    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent(
      'Prompt sent while the gateway was restarting',
    ));
    expect(screen.getByTestId('is-running')).toHaveTextContent('running');
  });

  it('acknowledges an echoed optimistic user message without duplicating it', async () => {
    const user = userEvent.setup();
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
    });

    await user.click(screen.getByRole('button', { name: 'Answer pending with Yes' }));
    await waitFor(() => expect(socket.sent.some((frame) => frame.type === 'send')).toBe(true));
    const sendFrame = socket.sent.find((frame) => frame.type === 'send');
    const clientMessageId = String(sendFrame?.clientMessageId || '');

    act(() => {
      socket.emit({
        type: 'user_message',
        sessionKey: 'agent:main:first',
        runId: 'echo-run',
        messageId: clientMessageId,
        messageTimestamp: Date.now(),
        content: 'Yes',
      });
    });

    const parsed = JSON.parse(screen.getByTestId('messages').textContent || '[]');
    expect(parsed.filter((message: { role: string; content: string }) => (
      message.role === 'user' && message.content === 'Yes'
    ))).toHaveLength(1);
    expect(parsed.find((message: { id: string }) => message.id === clientMessageId)?.pendingAck).toBe(false);
  });

  it('queues a duplicate send attempt and reattaches when the backend reports an active turn', async () => {
    const user = userEvent.setup();
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
    });

    await user.click(screen.getByRole('button', { name: 'Answer pending with Yes' }));
    await waitFor(() => expect(socket.sent.some((frame) => frame.type === 'send')).toBe(true));
    const sendFrame = socket.sent.find((frame) => frame.type === 'send');
    expect(sendFrame?.clientMessageId).toEqual(expect.any(String));

    act(() => {
      socket.emit({
        type: 'active_turn_conflict',
        sessionKey: 'agent:main:first',
        clientMessageId: sendFrame?.clientMessageId,
      });
    });

    await act(async () => {});
    expect(socket.sent.filter((frame) => frame.type === 'send')).toHaveLength(1);

    act(() => {
      socket.emit({
        type: 'stream_resume',
        sessionKey: 'agent:main:first',
        runId: 'already-active-run',
        phase: 'thinking',
        content: 'Existing turn remains visible',
        turnEvents: [],
      });
    });

    await waitFor(() => expect(screen.getByTestId('queue-count')).toHaveTextContent('1'));
    expect(screen.getByTestId('messages')).toHaveTextContent('"queued":true');
    expect(screen.getByTestId('messages')).toHaveTextContent('Existing turn remains visible');
    expect(screen.getByTestId('is-running')).toHaveTextContent('running');

    act(() => {
      socket.emit({
        type: 'active_turn_conflict',
        sessionKey: 'agent:main:first',
        clientMessageId: sendFrame?.clientMessageId,
      });
      socket.emit({
        type: 'active_turn_conflict',
        sessionKey: 'agent:main:first',
      });
      socket.emit({
        type: 'active_turn_conflict',
        sessionKey: 'agent:main:first',
        clientMessageId: 'stale-client-message',
      });
    });
    expect(screen.getByTestId('queue-count')).toHaveTextContent('1');
    expect(screen.getByTestId('messages')).toHaveTextContent('Existing turn remains visible');
    expect(screen.getByTestId('is-running')).toHaveTextContent('running');
  });

  it('passes the exact optimistic message ID through SSE conflict recovery and reattaches', async () => {
    const encoder = new TextEncoder();
    let requestBody: Record<string, unknown> | null = null;
    let fetchCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      fetchCount += 1;
      if (fetchCount > 1) {
        return {
          ok: false,
          status: 503,
          text: vi.fn(async () => JSON.stringify({ error: 'queued retry test stop' })),
        } as unknown as Response;
      }
      requestBody = JSON.parse(String(init?.body || '{}'));
      const clientMessageId = String(requestBody?.clientMessageId || '');
      const frames = [
        { type: 'session', sessionId: 'agent:main:first' },
        {
          type: 'active_turn_conflict',
          sessionKey: 'agent:main:first',
          clientMessageId,
        },
        {
          type: 'stream_resume',
          sessionKey: 'agent:main:first',
          runId: 'existing-sse-run',
          phase: 'thinking',
          content: 'Existing SSE turn remains visible',
          turnEvents: [],
        },
        {
          type: 'text',
          sessionKey: 'agent:main:first',
          runId: 'existing-sse-run',
          content: ' and continued after reattach',
        },
        {
          type: 'tool_start',
          sessionKey: 'agent:main:first',
          runId: 'existing-sse-run',
          toolCallId: 'sse-tool-1',
          toolName: 'Read',
        },
        {
          type: 'tool_end',
          sessionKey: 'agent:main:first',
          runId: 'existing-sse-run',
          toolCallId: 'sse-tool-1',
          toolName: 'Read',
          toolResult: 'read complete',
        },
        {
          type: 'done',
          sessionKey: 'agent:main:first',
          runId: 'existing-sse-run',
          content: 'Existing SSE turn final after reattach',
        },
      ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
      let read = false;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn(async () => {
              if (read) return { done: true, value: undefined };
              read = true;
              return { done: false, value: encoder.encode(frames) };
            }),
            cancel: vi.fn(async () => undefined),
          }),
        },
      } as unknown as Response;
    }));
    const user = userEvent.setup();
    await renderReadyHarness();

    await user.click(screen.getByRole('button', { name: 'Answer pending with Yes' }));
    await waitFor(() => expect(requestBody).not.toBeNull());
    const capturedRequestBody = requestBody as unknown as Record<string, unknown>;
    expect(capturedRequestBody.clientMessageId).toEqual(expect.any(String));
    await waitFor(() => expect(screen.getByTestId('messages')).toHaveTextContent(
      'Existing SSE turn final after reattach',
    ));
    expect(screen.getByTestId('messages')).toHaveTextContent(
      'Existing SSE turn remains visible and continued after reattach',
    );
    expect(screen.getByTestId('messages')).toHaveTextContent('sse-tool-1');
    await waitFor(() => expect(fetchCount).toBeGreaterThanOrEqual(2));
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

  it('navigates away from an in-flight session without emitting an abort for that run', async () => {
    const user = userEvent.setup();
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'text',
        sessionKey: 'agent:main:first',
        runId: 'run-stays-live',
        content: 'First-session work is still running',
      });
    });
    await waitFor(() => expect(screen.getByTestId('is-running')).toHaveTextContent('running'));

    await user.click(screen.getByRole('button', { name: 'Navigate session' }));

    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('agent:main:second'));
    await waitFor(() => expect(chatMocks.clientGet).toHaveBeenCalledWith(
      '/gateway/history',
      expect.objectContaining({
        params: expect.objectContaining({ session: 'agent:main:second' }),
      }),
    ));
    expect(socket.sent.some((frame) => frame.type === 'abort')).toBe(false);

    act(() => {
      socket.emit({
        type: 'done',
        sessionKey: 'agent:main:first',
        runId: 'run-stays-live',
        content: 'First-session work finished',
      });
    });
    expect(screen.getByTestId('session')).toHaveTextContent('agent:main:second');
    expect(screen.getByTestId('messages')).not.toHaveTextContent('First-session work finished');
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

  it('keeps a replacement socket authoritative when the replaced socket closes late', async () => {
    const user = userEvent.setup();
    await renderReadyHarness();
    const replacedSocket = PendingWebSocket.instances[0];
    act(() => {
      replacedSocket.open();
      replacedSocket.emit({ type: 'connected' });
      replacedSocket.emit({
        type: 'text',
        sessionKey: 'agent:main:first',
        runId: 'run-socket-replacement',
        content: 'Still working',
      });
    });

    await user.click(screen.getByRole('button', { name: 'Reconnect socket' }));
    const replacementSocket = PendingWebSocket.instances[1];
    expect(replacementSocket).toBeDefined();
    act(() => {
      replacementSocket.open();
      replacedSocket.onclose?.({
        code: 1000,
        reason: 'replaced',
        wasClean: true,
      } as CloseEvent);
      replacementSocket.emit({ type: 'connected' });
    });

    expect(replacementSocket.sent).toContainEqual(expect.objectContaining({
      type: 'reconnect',
      provider: 'OPENCLAW',
      session: 'agent:main:first',
    }));
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

  it('drops a stale runtime replay frame before it duplicates the live tool timeline', async () => {
    const user = userEvent.setup();
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];
    act(() => socket.open());
    const emitTurnEvent = (turnEvent: Record<string, unknown>) => act(() => socket.emit({
      sessionKey: 'agent:main:first',
      turnEvent: {
        schema: 'bridgesllm.runtime-turn-event.v1',
        sessionKey: 'agent:main:first',
        runId: 'run-sequence-fence',
        visible: true,
        ...turnEvent,
      },
    }));

    emitTurnEvent({ type: 'assistant_delta', seq: 1, text: 'A' });
    emitTurnEvent({
      type: 'tool_started',
      seq: 2,
      tool: { id: 'tool-sequence', name: 'read', status: 'running' },
    });
    emitTurnEvent({
      type: 'tool_output',
      seq: 3,
      tool: { id: 'tool-sequence', name: 'read', status: 'done', result: 'config' },
    });
    emitTurnEvent({ type: 'assistant_delta', seq: 4, text: ' B' });

    // A maintenance reconnect can replay an older normalized frame after the
    // browser has already applied later sequence numbers from the same turn.
    emitTurnEvent({
      type: 'tool_started',
      seq: 2,
      tool: { id: 'tool-sequence', name: 'read', status: 'running' },
    });

    const parsed = JSON.parse(screen.getByTestId('messages').textContent || '[]');
    const assistant = parsed.find((message: { role: string }) => message.role === 'assistant');
    expect(assistant.toolCalls).toEqual([
      expect.objectContaining({
        id: 'tool-sequence',
        name: 'read',
        status: 'done',
        result: 'config',
        order: 1,
      }),
    ]);

    act(() => socket.emit({ type: 'connected' }));
    emitTurnEvent({
      type: 'tool_started',
      seq: 1,
      tool: { id: 'tool-after-reconnect', name: 'exec', status: 'running' },
    });
    const afterReconnect = JSON.parse(screen.getByTestId('messages').textContent || '[]')
      .find((message: { role: string }) => message.role === 'assistant');
    expect(afterReconnect.toolCalls).toEqual([
      expect.objectContaining({ id: 'tool-sequence', status: 'done' }),
      expect.objectContaining({ id: 'tool-after-reconnect', status: 'running' }),
    ]);

    emitTurnEvent({
      type: 'tool_output',
      seq: 2,
      tool: { id: 'tool-after-reconnect', name: 'exec', status: 'done', result: 'ok' },
    });
    emitTurnEvent({ type: 'assistant_final', seq: 3, text: 'First turn complete.' });
    await user.click(screen.getByRole('button', { name: 'Answer pending with Yes' }));
    emitTurnEvent({
      type: 'tool_started',
      seq: 1,
      runId: 'run-second-turn',
      tool: { id: 'tool-second-turn', name: 'read', status: 'running' },
    });

    const afterNewTurn = JSON.parse(screen.getByTestId('messages').textContent || '[]')
      .filter((message: { role: string }) => message.role === 'assistant')
      .at(-1);
    expect(afterNewTurn.toolCalls).toEqual([
      expect.objectContaining({ id: 'tool-second-turn', status: 'running' }),
    ]);
  });

  it('quarantines a forward sequence gap until an authoritative snapshot repairs it', async () => {
    let historyReads = 0;
    let recoverySnapshotReady = false;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        historyReads += 1;
        return {
          data: {
            activeStream: recoverySnapshotReady
              ? {
                  active: true,
                  phase: 'tool',
                  runId: 'run-forward-gap',
                  content: 'A B',
                  toolName: 'read',
                  toolCalls: [{
                    id: 'tool-future',
                    name: 'read',
                    status: 'running',
                    order: 1,
                  }],
                  turnEvents: [
                    { type: 'assistant_delta', seq: 1, runId: 'run-forward-gap' },
                    { type: 'assistant_delta', seq: 2, runId: 'run-forward-gap' },
                    // Older/native snapshots may omit runId; the backend keeps
                    // those events inside the already attested active snapshot.
                    { type: 'tool_started', seq: 3 },
                  ],
                  lastEventAt: Date.now(),
                }
              : { active: false },
            messages: [],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const startupHistoryReads = historyReads;
    expect(startupHistoryReads).toBeGreaterThanOrEqual(1);
    recoverySnapshotReady = true;

    const socket = PendingWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
    });
    const emitTurnEvent = (turnEvent: Record<string, unknown>) => act(() => socket.emit({
      sessionKey: 'agent:main:first',
      turnEvent: {
        schema: 'bridgesllm.runtime-turn-event.v1',
        sessionKey: 'agent:main:first',
        runId: 'run-forward-gap',
        visible: true,
        ...turnEvent,
      },
    }));

    // Keep Date on the same fake clock as the timeout boundary. Leaving Date
    // real makes the 449 ms / 450 ms assertions depend on machine load.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      emitTurnEvent({ type: 'assistant_delta', seq: 1, text: 'A' });
      emitTurnEvent({
        type: 'tool_started',
        seq: 3,
        tool: { id: 'tool-future', name: 'read', status: 'running' },
      });

      let assistant = JSON.parse(screen.getByTestId('messages').textContent || '[]')
        .find((message: { role: string }) => message.role === 'assistant');
      expect(assistant.toolCalls || []).toEqual([]);

      emitTurnEvent({ type: 'assistant_delta', seq: 2, text: ' B' });
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      assistant = JSON.parse(screen.getByTestId('messages').textContent || '[]')
        .find((message: { role: string }) => message.role === 'assistant');
      expect(assistant.content).toBe('A B');
      expect(assistant.toolCalls || []).toEqual([]);

      await act(async () => { await vi.advanceTimersByTimeAsync(299); });
      expect(historyReads).toBe(startupHistoryReads);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(historyReads).toBe(startupHistoryReads + 1);

      assistant = JSON.parse(screen.getByTestId('messages').textContent || '[]')
        .find((message: { role: string }) => message.role === 'assistant');
      expect(assistant.toolCalls).toEqual([
        expect.objectContaining({ id: 'tool-future', name: 'read', status: 'running', order: 1 }),
      ]);

      emitTurnEvent({ type: 'assistant_delta', seq: 4, text: ' C' });
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      assistant = JSON.parse(screen.getByTestId('messages').textContent || '[]')
        .find((message: { role: string }) => message.role === 'assistant');
      expect(assistant.content).toBe('A B C');
      expect(assistant.toolCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers one durable final after a segmented turn loses its terminal content', async () => {
    let historyReads = 0;
    let recoveryHistoryReads = 0;
    let durableRecoveryReady = false;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        historyReads += 1;
        if (durableRecoveryReady) recoveryHistoryReads += 1;
        const messages = durableRecoveryReady && recoveryHistoryReads >= 2
          ? [{
              id: 'durable-segmented-final',
              role: 'assistant',
              content: 'The complete durable final.',
              timestamp: new Date().toISOString(),
              segments: [
                { kind: 'thinking', subject: 'Checking files', text: 'Need the config', order: 0, ts: Date.now() - 2 },
                { kind: 'text', text: 'The complete durable final.', order: 2, ts: Date.now() },
              ],
              toolCalls: [{
                id: 'tool-one',
                name: 'read',
                status: 'done',
                result: 'config',
                order: 1,
              }],
            }]
          : [];
        return {
          data: {
            activeStream: { active: false },
            messages,
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });
    await renderReadyHarness();
    const startupHistoryReads = historyReads;
    expect(startupHistoryReads).toBeGreaterThanOrEqual(1);
    durableRecoveryReady = true;

    // The recovery contract has exact 449 ms / 450 ms boundaries. A real Date
    // clock can cross that boundary while the full suite is under load.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const socket = PendingWebSocket.instances[0];
      const emit = (payload: Record<string, unknown>) => act(() => socket.emit({
        sessionKey: 'agent:main:first',
        runId: 'run-segmented-recovery',
        ...payload,
      }));

      emit({ type: 'thinking', subject: 'Checking files', content: 'Need the config' });
      emit({ type: 'tool_start', toolCallId: 'tool-one', toolName: 'read' });
      emit({ type: 'tool_end', toolCallId: 'tool-one', toolName: 'read', toolResult: 'config' });
      emit({ type: 'done', content: '' });

      await act(async () => { await vi.advanceTimersByTimeAsync(449); });
      expect(historyReads).toBe(startupHistoryReads);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(historyReads).toBe(startupHistoryReads + 1);
      expect(screen.getByTestId('messages')).toHaveTextContent('Need the config');

      await act(async () => { await vi.advanceTimersByTimeAsync(2499); });
      expect(historyReads).toBe(startupHistoryReads + 1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(historyReads).toBe(startupHistoryReads + 2);

      const parsed = JSON.parse(screen.getByTestId('messages').textContent || '[]');
      const assistants = parsed.filter((message: { role: string }) => message.role === 'assistant');
      expect(assistants).toHaveLength(1);
      expect(assistants[0]).toMatchObject({
        id: 'durable-segmented-final',
        content: 'The complete durable final.',
      });
      expect(assistants[0].toolCalls).toHaveLength(1);
      expect(assistants[0].toolCalls[0]).toMatchObject({
        id: 'tool-one',
        name: 'read',
        status: 'done',
        result: 'config',
        order: 1,
      });
      expect(assistants[0].segments.filter((segment: { kind: string }) => segment.kind === 'text'))
        .toEqual([expect.objectContaining({ text: 'The complete durable final.', order: 2 })]);

      const chronology = [
        ...assistants[0].segments.map((segment: { kind: string; text: string; order: number }) => ({
          kind: segment.kind,
          label: segment.text,
          order: segment.order,
        })),
        ...assistants[0].toolCalls.map((tool: { name: string; order: number }) => ({
          kind: 'tool',
          label: tool.name,
          order: tool.order,
        })),
      ].sort((left, right) => left.order - right.order);
      expect(chronology).toEqual([
        { kind: 'thinking', label: 'Need the config', order: 0 },
        { kind: 'tool', label: 'read', order: 1 },
        { kind: 'text', label: 'The complete durable final.', order: 2 },
      ]);
    } finally {
      vi.useRealTimers();
    }
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

  it('ignores a delayed inactive R1 history snapshot after a new local R2 turn starts', async () => {
    const delayedHistory = deferred<any>();
    let historyCalls = 0;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        historyCalls += 1;
        if (historyCalls === 2) return delayedHistory.promise;
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
    const user = userEvent.setup();
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({
        type: 'run_resumed',
        sessionKey: 'agent:main:first',
        runId: 'history-r1',
      });
      socket.emit({
        type: 'thinking',
        sessionKey: 'agent:main:first',
        runId: 'history-r1',
        content: 'R1 reasoning before delayed history',
      });
    });

    await user.click(screen.getByRole('button', { name: 'Retry history' }));
    await waitFor(() => expect(historyCalls).toBe(2));
    expect(screen.getByTestId('history-loading')).toHaveTextContent('loading');
    act(() => {
      socket.emit({
        type: 'stream_ended',
        sessionKey: 'agent:main:first',
        runId: 'history-r1',
        inactiveReason: 'terminal',
        safeToClear: true,
      });
    });
    await user.click(screen.getByRole('button', { name: 'Answer pending with Yes' }));
    act(() => {
      socket.emit({
        type: 'run_resumed',
        sessionKey: 'agent:main:first',
        runId: 'history-r2',
      });
      socket.emit({
        type: 'thinking',
        sessionKey: 'agent:main:first',
        runId: 'history-r2',
        content: 'R2 must survive the stale inactive response',
      });
    });
    await act(async () => {
      delayedHistory.resolve({
        data: {
          activeStream: { active: false, inactiveReason: 'terminal', safeToClear: true },
          messages: [{
            id: 'stale-inactive-runtime-r1',
            role: 'assistant',
            content: 'Stale inactive R1 runtime overlay must not render',
            timestamp: new Date().toISOString(),
            provenance: 'runtime-turn-event-history',
            segments: [{
              text: 'Stale inactive R1 reasoning must not render',
              position: 'before',
              kind: 'thinking',
              source: 'reasoning',
              order: 0,
            }],
            __portal: { kind: 'runtime-turn-event-history', runId: 'history-r1' },
          }],
          pagination: { beforeCursor: null, hasMoreBefore: false },
        },
      });
      await delayedHistory.promise;
    });

    await waitFor(() => expect(screen.getByTestId('history-loading')).toHaveTextContent('idle'));
    expect(screen.getByTestId('is-running')).toHaveTextContent('running');
    expect(screen.getByTestId('thinking')).toHaveTextContent(
      'R2 must survive the stale inactive response',
    );
    expect(screen.getByTestId('messages')).not.toHaveTextContent(
      'Stale inactive R1 runtime overlay must not render',
    );
    expect(screen.getByTestId('thinking')).not.toHaveTextContent(
      'Stale inactive R1 reasoning must not render',
    );
  });

  it('ignores a delayed active R1 overlay after a new local R2 turn starts', async () => {
    const delayedHistory = deferred<any>();
    let historyCalls = 0;
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        historyCalls += 1;
        if (historyCalls === 2) return delayedHistory.promise;
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
    const user = userEvent.setup();
    await renderReadyHarness();
    const socket = PendingWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'connected' });
      socket.emit({ type: 'run_resumed', sessionKey: 'agent:main:first', runId: 'active-history-r1' });
      socket.emit({
        type: 'thinking',
        sessionKey: 'agent:main:first',
        runId: 'active-history-r1',
        content: 'R1 local reasoning',
      });
    });
    await user.click(screen.getByRole('button', { name: 'Retry history' }));
    await waitFor(() => expect(historyCalls).toBe(2));
    act(() => {
      socket.emit({
        type: 'stream_ended',
        sessionKey: 'agent:main:first',
        runId: 'active-history-r1',
        inactiveReason: 'terminal',
        safeToClear: true,
      });
    });
    await user.click(screen.getByRole('button', { name: 'Answer pending with Yes' }));
    act(() => {
      socket.emit({ type: 'run_resumed', sessionKey: 'agent:main:first', runId: 'active-history-r2' });
      socket.emit({
        type: 'thinking',
        sessionKey: 'agent:main:first',
        runId: 'active-history-r2',
        content: 'R2 exact reasoning remains authoritative',
      });
    });
    await act(async () => {
      delayedHistory.resolve({
        data: {
          activeStream: {
            active: true,
            runId: 'active-history-r1',
            phase: 'streaming',
            content: 'Stale R1 snapshot text must not replace R2',
            startedAt: Date.now() - 1_000,
            turnEvents: [],
          },
          messages: [{
            id: 'stale-runtime-r1',
            role: 'assistant',
            content: 'Stale R1 runtime overlay must not render',
            timestamp: new Date().toISOString(),
            provenance: 'runtime-turn-event-history',
            __portal: { kind: 'runtime-turn-event-history', runId: 'active-history-r1' },
          }],
          pagination: { beforeCursor: null, hasMoreBefore: false },
        },
      });
      await delayedHistory.promise;
    });

    await waitFor(() => expect(screen.getByTestId('history-loading')).toHaveTextContent('idle'));
    expect(screen.getByTestId('is-running')).toHaveTextContent('running');
    expect(screen.getByTestId('thinking')).toHaveTextContent('R2 exact reasoning remains authoritative');
    expect(screen.getByTestId('messages')).not.toHaveTextContent('Stale R1 snapshot text');
    expect(screen.getByTestId('messages')).not.toHaveTextContent('Stale R1 runtime overlay');
  });

  it('adopts an exact active runtime-history overlay as one live assistant bubble', async () => {
    chatMocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/gateway/history') {
        return {
          data: {
            activeStream: {
              active: true,
              runId: 'overlay-active-run',
              phase: 'tool',
              content: 'Overlay partial answer',
              toolName: 'Read',
              toolCalls: [{ id: 'overlay-tool', name: 'Read', status: 'running' }],
              startedAt: Date.now(),
              turnEvents: [],
            },
            messages: [{
              id: 'runtime-overlay-assistant',
              role: 'assistant',
              content: 'Overlay partial answer',
              timestamp: new Date().toISOString(),
              provenance: 'runtime-turn-event-history',
              segments: [{
                kind: 'thinking',
                text: 'Overlay reasoning remains visible',
                order: 0,
              }],
              toolCalls: [{ id: 'overlay-tool', name: 'Read', status: 'running' }],
              __portal: { kind: 'runtime-turn-event-history', runId: 'overlay-active-run' },
            }],
            pagination: { beforeCursor: null, hasMoreBefore: false },
          },
        };
      }
      if (url === '/gateway/stream-status') return { data: { active: false } };
      return { data: {} };
    });

    await renderReadyHarness();
    await waitFor(() => expect(screen.getByTestId('is-running')).toHaveTextContent('running'));
    const parsed = JSON.parse(screen.getByTestId('messages').textContent || '[]');
    expect(parsed.filter((message: { role: string }) => message.role === 'assistant')).toHaveLength(1);
    expect(parsed[0].id).toBe('runtime-overlay-assistant');
    expect(screen.getByTestId('messages')).toHaveTextContent('Overlay partial answer');
    expect(screen.getByTestId('thinking')).toHaveTextContent('Overlay reasoning remains visible');
    expect(screen.getByTestId('messages')).toHaveTextContent('overlay-tool');
  });
});
