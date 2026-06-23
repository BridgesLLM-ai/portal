import { __persistentGatewayWsTest } from '../agents/providers/PersistentGatewayWs';
import { streamEventBus, type StreamEvent } from '../services/StreamEventBus';

describe('PersistentGatewayWs Codex idle timeout handling', () => {
  const sessionKey = 'test-codex-idle-timeout';
  const idleTimeoutError = 'codex app-server turn idle timed out waiting for turn/completed';
  const missingTerminalError = 'Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.';

  afterEach(() => {
    jest.useRealTimers();
    __persistentGatewayWsTest.resetSession(sessionKey);
  });

  it('completes the turn when the idle timeout arrives after visible assistant text', () => {
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      streamEventBus.publish(sessionKey, { type: 'text', content: 'Final answer is already visible.', replace: true });

      const handled = __persistentGatewayWsTest.deferCodexIdleTimeoutError(sessionKey, 'run-1', idleTimeoutError);

      expect(handled).toBe(true);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'done', content: 'Final answer is already visible.', runId: 'run-1' }),
      ]));
      expect(events.some((event) => event.type === 'error')).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it('completes the turn when OpenClaw reports a missing Codex terminal event after visible text', () => {
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      streamEventBus.publish(sessionKey, { type: 'text', content: 'Visible answer survived the missing terminal event.', replace: true });

      const handled = __persistentGatewayWsTest.deferCodexIdleTimeoutError(sessionKey, 'run-terminal', missingTerminalError);

      expect(handled).toBe(true);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'done', content: 'Visible answer survived the missing terminal event.', runId: 'run-terminal' }),
      ]));
      expect(events.some((event) => event.type === 'error')).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it('shows a recoverable delayed-completion status before failing a truly empty turn', () => {
    jest.useFakeTimers();
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      const handled = __persistentGatewayWsTest.deferCodexIdleTimeoutError(sessionKey, 'run-2', idleTimeoutError);

      expect(handled).toBe(true);
      expect(events).toEqual([
        expect.objectContaining({
          type: 'status',
          content: 'Codex turn completion is delayed; waiting for the final response…',
          runId: 'run-2',
        }),
      ]);

      jest.advanceTimersByTime(15000);

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'error', content: idleTimeoutError }),
      ]));
    } finally {
      unsubscribe();
    }
  });

  it('processes lifecycle events for a direct-proxy session before a run id is known', () => {
    const directSessionKey = 'test-direct-proxy-session-tracking';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(directSessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(directSessionKey);

      expect(__persistentGatewayWsTest.shouldProcessTrackedSessionEvent(directSessionKey)).toBe(true);

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey: directSessionKey,
        runId: 'run-direct-1',
        stream: 'lifecycle',
        data: {
          phase: 'started',
          statusText: 'Codex is working...',
        },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: 'run-direct-1' }),
        expect.objectContaining({ type: 'status', content: 'Codex is working...' }),
      ]));
      expect(streamEventBus.getStreamStatus(directSessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: 'run-direct-1',
        phase: 'thinking',
      }));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(directSessionKey);
    }
  });

  it('completes chat events for a direct-proxy run registered from chat.send ack', () => {
    const directSessionKey = 'test-direct-proxy-final-tracking';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(directSessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(directSessionKey, 'run-direct-final');

      __persistentGatewayWsTest.handleChatEvent({
        sessionKey: directSessionKey,
        runId: 'run-direct-final',
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Recovered final answer.' }],
        },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text', content: 'Recovered final answer.', replace: true }),
        expect.objectContaining({ type: 'done', content: 'Recovered final answer.' }),
      ]));
      expect(streamEventBus.getStreamStatus(directSessionKey)).toBeNull();
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(directSessionKey);
    }
  });
});
