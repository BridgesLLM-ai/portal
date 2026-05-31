import { __persistentGatewayWsTest } from '../agents/providers/PersistentGatewayWs';
import { streamEventBus, type StreamEvent } from '../services/StreamEventBus';

describe('PersistentGatewayWs Codex idle timeout handling', () => {
  const sessionKey = 'test-codex-idle-timeout';
  const idleTimeoutError = 'codex app-server turn idle timed out waiting for turn/completed';

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
});
