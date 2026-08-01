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
      __persistentGatewayWsTest.registerRun(sessionKey, 'run-1');
      streamEventBus.publish(sessionKey, {
        type: 'text',
        content: 'Final answer is already visible.',
        replace: true,
        runId: 'run-1',
      });

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
      __persistentGatewayWsTest.registerRun(sessionKey, 'run-terminal');
      streamEventBus.publish(sessionKey, {
        type: 'text',
        content: 'Visible answer survived the missing terminal event.',
        replace: true,
        runId: 'run-terminal',
      });

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
      __persistentGatewayWsTest.registerRun(sessionKey, 'run-2');
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

  it('queues pre-ack agent events and adopts only the run named by the acknowledgement', () => {
    const fastSessionKey = 'test-fast-agent-before-ack';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(fastSessionKey, (event) => events.push(event));

    try {
      expect(streamEventBus.startStream(fastSessionKey, 'route-reservation')).toBe(true);
      expect(__persistentGatewayWsTest.reserveLogicalRun(fastSessionKey, 'route-reservation')).toBe(true);

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey: fastSessionKey,
        runId: 'stale-competing-run',
        stream: 'assistant',
        data: { text: 'Stale competing text' },
      });

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey: fastSessionKey,
        runId: 'gateway-run',
        stream: 'assistant',
        data: { text: 'Fast agent text' },
      });

      expect(events).toEqual([]);
      expect(streamEventBus.getTrackedStream(fastSessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: 'route-reservation',
      }));
      expect(__persistentGatewayWsTest.acknowledgeRunReservation(
        fastSessionKey,
        'route-reservation',
        'gateway-run',
      )).toBe(true);

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: 'gateway-run' }),
        expect.objectContaining({ type: 'text', content: 'Fast agent text', runId: 'gateway-run' }),
      ]));
      expect(streamEventBus.getTrackedStream(fastSessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: 'gateway-run',
      }));
      expect(events.some((event) => event.content === 'Stale competing text')).toBe(false);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(fastSessionKey);
    }
  });

  it('queues pre-ack chat events and adopts only the run named by the acknowledgement', () => {
    const fastSessionKey = 'test-fast-chat-before-ack';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(fastSessionKey, (event) => events.push(event));

    try {
      expect(streamEventBus.startStream(fastSessionKey, 'route-reservation')).toBe(true);
      expect(__persistentGatewayWsTest.reserveLogicalRun(fastSessionKey, 'route-reservation')).toBe(true);

      __persistentGatewayWsTest.handleChatEvent({
        sessionKey: fastSessionKey,
        runId: 'stale-competing-run',
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Stale competing chat text' }] },
      });

      __persistentGatewayWsTest.handleChatEvent({
        sessionKey: fastSessionKey,
        runId: 'gateway-run',
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Fast chat text' }] },
      });

      expect(events).toEqual([]);
      expect(__persistentGatewayWsTest.acknowledgeRunReservation(
        fastSessionKey,
        'route-reservation',
        'gateway-run',
      )).toBe(true);

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: 'gateway-run' }),
        expect.objectContaining({ type: 'text', content: 'Fast chat text', runId: 'gateway-run' }),
      ]));
      expect(streamEventBus.getTrackedStream(fastSessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: 'gateway-run',
      }));
      expect(events.some((event) => event.content === 'Stale competing chat text')).toBe(false);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(fastSessionKey);
    }
  });

  it('keeps pre-ack output hidden until durable dispatch persistence completes', async () => {
    const fastSessionKey = 'test-durable-dispatch-before-visible';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(fastSessionKey, (event) => events.push(event));
    let releasePersistence!: () => void;
    const persistenceBlocked = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const persistDispatch = jest.fn(async () => persistenceBlocked);

    try {
      expect(__persistentGatewayWsTest.reserveLogicalRun(
        fastSessionKey,
        'route-reservation',
      )).toBe(true);
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey: fastSessionKey,
        runId: 'gateway-run',
        stream: 'assistant',
        data: { text: 'Durable text' },
      });
      __persistentGatewayWsTest.handleSessionMessageEvent({
        sessionKey: fastSessionKey,
        runId: 'gateway-run',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Codex reasoning: Durable thought' }],
          __openclaw: { mirrorIdentity: 'portal:reasoning' },
        },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey: fastSessionKey,
        runId: 'gateway-run',
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Durable text' }],
        },
      });

      const acceptance = __persistentGatewayWsTest
        .persistDispatchThenAcknowledgeRunReservation(
          fastSessionKey,
          'route-reservation',
          'gateway-run',
          persistDispatch,
        );
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(persistDispatch).toHaveBeenCalledWith('gateway-run');
      expect(events).toEqual([]);

      releasePersistence();
      await acceptance;

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: 'gateway-run' }),
        expect.objectContaining({ type: 'thinking', content: 'Durable thought', runId: 'gateway-run' }),
        expect.objectContaining({ type: 'text', content: 'Durable text', runId: 'gateway-run' }),
        expect.objectContaining({ type: 'done', content: 'Durable text', runId: 'gateway-run' }),
      ]));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(fastSessionKey);
    }
  });

  it('also gates matching reservation ids and suppresses late frames after persistence failure', async () => {
    const fastSessionKey = 'test-failed-dispatch-never-visible';
    const reservationRunId = 'same-provider-run';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(fastSessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.reserveLogicalRun(
        fastSessionKey,
        reservationRunId,
      )).toBe(true);
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey: fastSessionKey,
        runId: reservationRunId,
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Must stay hidden' }],
        },
      });
      expect(events).toEqual([]);

      await expect(
        __persistentGatewayWsTest.persistDispatchThenAcknowledgeRunReservation(
          fastSessionKey,
          reservationRunId,
          reservationRunId,
          async () => {
            throw new Error('dispatch journal unavailable');
          },
        ),
      ).rejects.toThrow('dispatch journal unavailable');
      expect(events).toEqual([]);

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey: fastSessionKey,
        runId: 'unknown-late-provider-run',
        stream: 'assistant',
        data: { text: 'Late hidden text' },
      });
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(fastSessionKey);
    }
  });

  it('preserves whitespace-only assistant deltas from the persistent gateway mirror', () => {
    const deltaSessionKey = 'test-assistant-delta-whitespace';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(deltaSessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(deltaSessionKey, 'run-delta-whitespace');

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey: deltaSessionKey,
        runId: 'run-delta-whitespace',
        stream: 'assistant',
        data: { delta: 'Hello' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey: deltaSessionKey,
        runId: 'run-delta-whitespace',
        stream: 'assistant',
        data: { delta: ' ' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey: deltaSessionKey,
        runId: 'run-delta-whitespace',
        stream: 'assistant',
        data: { delta: 'world' },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text', content: 'Hello' }),
        expect.objectContaining({ type: 'text', content: ' ' }),
        expect.objectContaining({ type: 'text', content: 'world' }),
      ]));
      expect(streamEventBus.getLatestText(deltaSessionKey)).toBe('Hello world');
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(deltaSessionKey);
    }
  });

  it('lets cumulative chat.delta resume immediately after a tool boundary', () => {
    const sessionKey = 'test-chat-delta-after-tool';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, 'run-tool-fallback');
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'run-tool-fallback',
        stream: 'assistant',
        data: { text: 'Before tool. ' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'run-tool-fallback',
        stream: 'tool',
        data: { phase: 'start', name: 'exec' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'run-tool-fallback',
        stream: 'tool',
        data: { phase: 'result', name: 'exec', output: 'ok' },
      });
      // The chat lane first appears after the tool and carries the whole turn.
      // Only its new post-tool segment should be emitted.
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'run-tool-fallback',
        state: 'delta',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Before tool. After tool visible text.' }],
        },
      });

      expect(events.filter((event) => event.type === 'text')).toEqual([
        expect.objectContaining({ content: 'Before tool.' }),
        expect.objectContaining({ content: ' After tool visible text.', replace: true }),
      ]);
      expect(streamEventBus.getLatestText(sessionKey).trim()).toBe('After tool visible text.');
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('lets chat.delta take over after the assistant text lane goes silent', () => {
    jest.useFakeTimers();
    const sessionKey = 'test-chat-delta-after-lane-silence';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, 'run-lane-silence');
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'run-lane-silence',
        stream: 'assistant',
        data: { text: 'Assistant prefix' },
      });
      // A mirrored snapshot during the grace period is deduplicated.
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'run-lane-silence',
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Assistant prefix' }] },
      });

      jest.advanceTimersByTime(2_001);
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'run-lane-silence',
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Assistant prefix and fallback tail' }] },
      });

      expect(events.filter((event) => event.type === 'text').map((event) => event.content)).toEqual([
        'Assistant prefix',
        ' and fallback tail',
      ]);
      expect(streamEventBus.getLatestText(sessionKey)).toBe('Assistant prefix and fallback tail');
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('replaces cumulative assistant snapshots on shrink and non-prefix rewrites', () => {
    const sessionKey = 'test-assistant-snapshot-rewrite';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, 'run-snapshot-rewrite');
      for (const text of [
        'A long cumulative snapshot',
        'Short reset',
        'A completely different and longer rewritten snapshot',
      ]) {
        __persistentGatewayWsTest.handleAgentEvent({
          sessionKey,
          runId: 'run-snapshot-rewrite',
          stream: 'assistant',
          data: { text },
        });
      }

      const textEvents = events.filter((event) => event.type === 'text');
      expect(textEvents).toEqual([
        expect.objectContaining({ content: 'A long cumulative snapshot' }),
        expect.objectContaining({ content: 'Short reset', replace: true }),
        expect.objectContaining({ content: 'A completely different and longer rewritten snapshot', replace: true }),
      ]);
      expect(streamEventBus.getLatestText(sessionKey)).toBe('A completely different and longer rewritten snapshot');
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('adopts a continuation only after its predecessor settles and rejects stale or id-less active-run events', () => {
    const sessionKey = 'test-strict-run-continuation';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, 'old-run');
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'old-run',
        stream: 'assistant',
        data: { text: 'Old run text' },
      });

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'new-run',
        stream: 'thinking',
        data: { text: 'Premature new thought', delta: 'Premature new thought' },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'new-run',
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Premature new answer' }] },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        stream: 'assistant',
        data: { text: 'Id-less stale agent text' },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Id-less stale chat text' }] },
      });

      expect(streamEventBus.getTrackedStream(sessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: 'old-run',
        latestText: 'Old run text',
      }));
      expect(events.some((event) => String(event.content || '').includes('Premature'))).toBe(false);
      expect(events.some((event) => String(event.content || '').includes('Id-less'))).toBe(false);

      // The old run must settle before a provider-driven continuation may CAS
      // the retained dormant predecessor into a new identity.
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'old-run',
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Old run text' }] },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'new-run',
        stream: 'thinking',
        data: { text: 'New run thought', delta: 'New run thought' },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'new-run',
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'New run answer' }] },
      });
      expect(streamEventBus.getTrackedStream(sessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: 'new-run',
        latestText: 'New run answer',
      }));

      // A delayed terminal for the settled predecessor cannot clear or
      // overwrite the active continuation.
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'old-run',
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Late old final' }] },
      });
      expect(streamEventBus.getTrackedStream(sessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: 'new-run',
        latestText: 'New run answer',
      }));

      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'new-run',
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'New run answer' }] },
      });

      // The same stale terminal after completion must also stay tombstoned.
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'old-run',
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Late old final' }] },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: 'new-run' }),
        expect.objectContaining({ type: 'thinking', content: 'New run thought', runId: 'new-run' }),
        expect.objectContaining({ type: 'text', content: 'New run answer' }),
        expect.objectContaining({ type: 'done', content: 'New run answer' }),
      ]));
      expect(events.some((event) => event.content === 'Late old final')).toBe(false);
      expect(events.filter((event) => event.type === 'done')).toHaveLength(2);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('publishes cumulative reasoning snapshots as replace-style thinking events', () => {
    const sessionKey = 'test-thinking-snapshot';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, 'run-thinking-snapshot');

      // OpenClaw 2026.7.1 claude-cli thinking lane: cumulative snapshot + delta.
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'run-thinking-snapshot',
        stream: 'thinking',
        data: { text: 'Plan', delta: 'Plan', isReasoningSnapshot: true },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'run-thinking-snapshot',
        stream: 'thinking',
        data: { text: 'Plan the fix carefully', delta: ' the fix carefully', isReasoningSnapshot: true },
      });
      // Exact duplicate snapshot must be dropped.
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'run-thinking-snapshot',
        stream: 'thinking',
        data: { text: 'Plan the fix carefully', delta: '', isReasoningSnapshot: true },
      });
      // A non-extending snapshot is a new thinking phase: fresh segment, no replace.
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'run-thinking-snapshot',
        stream: 'thinking',
        data: { text: 'Second thought', delta: 'Second thought', isReasoningSnapshot: true },
      });
      // progressTokens-only events carry no text and must not publish.
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'run-thinking-snapshot',
        stream: 'thinking',
        data: { progressTokens: 128 },
      });

      const thinkingEvents = events.filter((event) => event.type === 'thinking');
      expect(thinkingEvents).toEqual([
        expect.objectContaining({ content: 'Plan' }),
        expect.objectContaining({ content: 'Plan the fix carefully', replace: true }),
        expect.objectContaining({ content: 'Second thought' }),
      ]);
      expect(thinkingEvents[0].replace).toBeUndefined();
      expect(thinkingEvents[2].replace).toBeUndefined();
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('publishes provider preamble progress as a safe subject instead of reasoning body text', () => {
    const sessionKey = 'test-thinking-subject';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, 'run-thinking-subject');
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'run-thinking-subject',
        stream: 'item',
        data: {
          kind: 'preamble',
          progressText: '**Inspecting runtime** password=hunter2',
        },
      });

      const thinking = events.find((event) => event.type === 'thinking');
      expect(thinking).toMatchObject({
        type: 'thinking',
        content: '',
        subject: 'Inspecting runtime [redacted]',
        runId: 'run-thinking-subject',
      });
      expect(thinking?.replace).toBeUndefined();
      expect(thinking?.turnEvent).toMatchObject({
        type: 'assistant_reasoning',
        subject: 'Inspecting runtime [redacted]',
        visible: true,
      });
      expect(thinking?.turnEvent?.text).toBeUndefined();
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('splits cumulative Codex preamble snapshots instead of smearing titles together', () => {
    // Codex repeats every earlier title on each preamble event and appends the
    // new one with no separator. Taking the whole blob as the subject smears
    // several titles into one, and makes every event look like a subject
    // change -- which graduates a title-only thinking segment before its body
    // has arrived. Only the newly appended tail may become the subject.
    const sessionKey = 'test-preamble-cumulative';
    const runId = 'run-preamble-cumulative';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, runId);
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'item',
        data: { kind: 'preamble', progressText: 'Inspecting files' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'item',
        data: { kind: 'preamble', progressText: 'Inspecting filesRunning tests' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'item',
        data: {
          kind: 'preamble',
          progressText: 'Inspecting filesRunning testsSummarizing results',
        },
      });

      expect(
        events.filter((event) => event.type === 'thinking').map((event) => event.subject),
      ).toEqual(['Inspecting files', 'Running tests', 'Summarizing results']);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('treats a non-extending preamble snapshot as an authoritative restart', () => {
    const sessionKey = 'test-preamble-restart';
    const runId = 'run-preamble-restart';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, runId);
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'item',
        data: { kind: 'preamble', progressText: 'Inspecting filesRunning tests' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'item',
        data: { kind: 'preamble', progressText: 'Starting over' },
      });

      expect(
        events.filter((event) => event.type === 'thinking').map((event) => event.subject),
      ).toEqual(['Inspecting filesRunning tests', 'Starting over']);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('keeps cumulative thinking bodies inside their matching subject boundary', () => {
    const sessionKey = 'test-thinking-subject-boundaries';
    const runId = 'run-thinking-subject-boundaries';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, runId);
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'item',
        data: { kind: 'preamble', progressText: 'Inspecting files' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'thinking',
        data: { text: 'Reading file A.', delta: 'Reading file A.', isReasoningSnapshot: true },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'item',
        data: { kind: 'preamble', progressText: 'Running tests' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'thinking',
        data: {
          text: 'Reading file A.Running test B.',
          delta: 'Running test B.',
          isReasoningSnapshot: true,
        },
      });

      expect(events.filter((event) => event.type === 'thinking').map((event) => ({
        subject: event.subject,
        content: event.content,
        replace: event.replace,
      }))).toEqual([
        { subject: 'Inspecting files', content: '', replace: undefined },
        { subject: undefined, content: 'Reading file A.', replace: undefined },
        { subject: 'Running tests', content: '', replace: undefined },
        { subject: undefined, content: 'Running test B.', replace: undefined },
      ]);
      expect(streamEventBus.getRecentTurnEvents(sessionKey)).toEqual([
        expect.objectContaining({ type: 'assistant_reasoning', subject: 'Inspecting files' }),
        expect.objectContaining({ type: 'assistant_reasoning', text: 'Reading file A.' }),
        expect.objectContaining({ type: 'assistant_reasoning', subject: 'Running tests' }),
        expect.objectContaining({ type: 'assistant_reasoning', text: 'Running test B.' }),
      ]);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('appends legacy delta-only thinking chunks without replace', () => {
    const sessionKey = 'test-thinking-delta-only';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, 'run-thinking-delta');

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'run-thinking-delta',
        stream: 'thinking',
        data: { delta: 'first chunk ' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'run-thinking-delta',
        stream: 'thinking',
        data: { delta: 'second chunk' },
      });

      const thinkingEvents = events.filter((event) => event.type === 'thinking');
      expect(thinkingEvents).toEqual([
        expect.objectContaining({ content: 'first chunk ' }),
        expect.objectContaining({ content: 'second chunk' }),
      ]);
      expect(thinkingEvents.every((event) => event.replace === undefined)).toBe(true);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
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

  it('keeps a tool-bearing chat.final open until tool result and the true final response', () => {
    const sessionKey = 'test-tool-bearing-final-lifecycle';
    const runId = 'run-tool-bearing-final';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, runId);

      // OpenClaw marks the assistant tool-request message as chat.final even
      // though the same run will continue after the tool executes.
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'final',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect the project first.' },
            { type: 'toolCall', id: 'tool-1', name: 'exec', arguments: { command: 'pwd' } },
          ],
        },
      });

      // The same tool-request message can also arrive on the subscribed
      // session.message lane. That mirror is not the final delivery either.
      __persistentGatewayWsTest.handleSessionMessageEvent({
        sessionKey,
        runId,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect the project first.' },
            { type: 'toolCall', id: 'tool-1', name: 'exec', arguments: { command: 'pwd' } },
          ],
        },
      });

      expect(events.filter((event) => event.type === 'done')).toHaveLength(0);
      expect(streamEventBus.getStreamStatus(sessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId,
      }));

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'tool',
        data: { phase: 'start', name: 'exec', toolCallId: 'tool-1', args: { command: 'pwd' } },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'tool',
        data: { phase: 'result', name: 'exec', toolCallId: 'tool-1', output: '/workspace/project' },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The project is ready.' }],
        },
      });

      // A duplicate terminal frame must be ignored after the run is tombstoned.
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The project is ready.' }],
        },
      });

      expect(events.map((event) => event.type)).toEqual([
        'text',
        'segment_break',
        'tool_start',
        'tool_end',
        'text',
        'done',
      ]);
      expect(events[0]).toEqual(expect.objectContaining({
        type: 'text',
        content: 'I will inspect the project first.',
      }));
      expect(events[4]).toEqual(expect.objectContaining({
        type: 'text',
        content: 'The project is ready.',
        replace: true,
      }));
      expect(events[2]).toEqual(expect.objectContaining({
        type: 'tool_start',
        toolCallId: 'tool-1',
        runId,
      }));
      expect(events[3]).toEqual(expect.objectContaining({
        type: 'tool_end',
        toolCallId: 'tool-1',
        runId,
      }));
      expect(events.filter((event) => event.type === 'done')).toEqual([
        expect.objectContaining({ type: 'done', content: 'The project is ready.' }),
      ]);
      expect(streamEventBus.getStreamStatus(sessionKey)).toBeNull();
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('publishes only the residual tail of a cumulative final after multiple tools', () => {
    const sessionKey = 'test-multi-tool-cumulative-final';
    const runId = 'run-multi-tool-cumulative-final';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, runId);
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'assistant',
        data: { text: 'A ' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'tool',
        data: { phase: 'start', name: 'read', toolCallId: 'tool-a' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'tool',
        data: { phase: 'result', name: 'read', toolCallId: 'tool-a', output: 'one' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'assistant',
        data: { text: 'B ' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'tool',
        data: { phase: 'start', name: 'exec', toolCallId: 'tool-b' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'tool',
        data: { phase: 'result', name: 'exec', toolCallId: 'tool-b', output: 'two' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'assistant',
        data: { text: 'C' },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'A B C' }],
        },
      });

      expect(events.filter((event) => event.type === 'text').map((event) => event.content))
        .toEqual(['A', 'B', 'C']);
      expect(events.filter((event) => event.type === 'segment_break')).toHaveLength(2);
      expect(events.filter((event) => event.type === 'tool_start')).toHaveLength(2);
      expect(events.filter((event) => event.type === 'tool_end')).toHaveLength(2);
      expect(events.filter((event) => event.type === 'done')).toEqual([
        expect.objectContaining({
          content: 'C',
          aggregateContent: 'A B C',
          runId,
        }),
      ]);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('does not arm the empty-final timeout for a tool-only chat.final', () => {
    jest.useFakeTimers();
    const sessionKey = 'test-tool-only-final-lifecycle';
    const runId = 'run-tool-only-final';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, runId);
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'final',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tool-2', name: 'read', arguments: { path: 'README.md' } },
          ],
        },
      });

      jest.advanceTimersByTime(3_000);

      expect(events.filter((event) => event.type === 'done')).toHaveLength(0);
      expect(streamEventBus.getStreamStatus(sessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId,
      }));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('defers an early terminal mirror until every requested tool result arrives', () => {
    const sessionKey = 'test-multiple-pending-tools';
    const runId = 'run-multiple-pending-tools';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, runId);
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'final',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I need two checks.' },
            { type: 'toolCall', id: 'tool-a', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'toolCall', id: 'tool-b', name: 'read', arguments: { path: 'b.ts' } },
          ],
        },
      });
      for (const id of ['tool-a', 'tool-b']) {
        __persistentGatewayWsTest.handleAgentEvent({
          sessionKey,
          runId,
          stream: 'tool',
          data: { phase: 'start', name: 'read', toolCallId: id, args: { path: `${id}.ts` } },
        });
      }

      // This delivery mirror and chat.final are intentionally early. Neither
      // may close the run while even one requested tool is unresolved.
      __persistentGatewayWsTest.handleSessionMessageEvent({
        sessionKey,
        runId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Both files are valid.' }] },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Both files are valid.' }] },
      });

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'tool',
        data: { phase: 'result', name: 'read', toolCallId: 'tool-a', output: 'A' },
      });
      expect(events.filter((event) => event.type === 'done')).toHaveLength(0);

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'tool',
        data: { phase: 'result', name: 'read', toolCallId: 'tool-b', output: 'B' },
      });

      expect(events.filter((event) => event.type === 'done')).toEqual([
        expect.objectContaining({ type: 'done', content: 'Both files are valid.' }),
      ]);
      const lastToolResultIndex = events.map((event) => event.type).lastIndexOf('tool_end');
      const doneIndex = events.findIndex((event) => event.type === 'done');
      expect(doneIndex).toBeGreaterThan(lastToolResultIndex);
      expect(streamEventBus.getStreamStatus(sessionKey)).toBeNull();
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('reconciles id-less tool-request mirrors with id-bearing tool events', () => {
    const sessionKey = 'test-idless-tool-mirror';
    const runId = 'run-idless-tool-mirror';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, runId);
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'final',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'toolCall', name: 'read', arguments: { path: 'b.ts' } },
          ],
        },
      });
      for (const id of ['read-a', 'read-b']) {
        __persistentGatewayWsTest.handleAgentEvent({
          sessionKey,
          runId,
          stream: 'tool',
          data: { phase: 'start', name: 'read', toolCallId: id },
        });
      }
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Both reads finished.' }] },
      });
      for (const id of ['read-a', 'read-b']) {
        __persistentGatewayWsTest.handleAgentEvent({
          sessionKey,
          runId,
          stream: 'tool',
          data: { phase: 'result', name: 'read', toolCallId: id, output: id },
        });
      }

      expect(events.filter((event) => event.type === 'tool_end')).toHaveLength(2);
      expect(events.filter((event) => event.type === 'done')).toEqual([
        expect.objectContaining({ content: 'Both reads finished.' }),
      ]);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('does not resurrect a settled parallel tool from a duplicate tool-bearing final', () => {
    const sessionKey = 'test-settled-tool-final-replay';
    const runId = 'run-settled-tool-final-replay';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));
    const toolFinal = {
      sessionKey,
      runId,
      state: 'final',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tool-a', name: 'read' },
          { type: 'toolCall', id: 'tool-b', name: 'read' },
        ],
      },
    };

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, runId);
      __persistentGatewayWsTest.handleChatEvent(toolFinal);
      for (const id of ['tool-a', 'tool-b']) {
        __persistentGatewayWsTest.handleAgentEvent({
          sessionKey,
          runId,
          stream: 'tool',
          data: { phase: 'start', name: 'read', toolCallId: id },
        });
      }
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'tool',
        data: { phase: 'result', name: 'read', toolCallId: 'tool-a', output: 'A' },
      });

      __persistentGatewayWsTest.handleChatEvent(toolFinal);
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'tool',
        data: { phase: 'result', name: 'read', toolCallId: 'tool-b', output: 'B' },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Both settled.' }] },
      });

      expect(events.filter((event) => event.type === 'tool_start')).toHaveLength(2);
      expect(events.filter((event) => event.type === 'tool_end')).toHaveLength(2);
      expect(events.filter((event) => event.type === 'done')).toEqual([
        expect.objectContaining({ content: 'Both settled.' }),
      ]);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('deduplicates interleaved parallel same-name tool phases by tool call id', () => {
    const sessionKey = 'test-parallel-tool-dedup';
    const runId = 'run-parallel-tool-dedup';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, runId);
      for (const id of ['tool-a', 'tool-b', 'tool-a']) {
        __persistentGatewayWsTest.handleAgentEvent({
          sessionKey,
          runId,
          stream: 'tool',
          data: { phase: 'start', name: 'read', toolCallId: id },
        });
      }
      for (const id of ['tool-b', 'tool-a', 'tool-b']) {
        __persistentGatewayWsTest.handleAgentEvent({
          sessionKey,
          runId,
          stream: 'tool',
          data: { phase: 'result', name: 'read', toolCallId: id, output: id },
        });
      }
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Parallel tools complete.' }] },
      });

      expect(events.filter((event) => event.type === 'tool_start')).toHaveLength(2);
      expect(events.filter((event) => event.type === 'tool_end')).toHaveLength(2);
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('ignores a delayed tool-bearing final after that tool already settled', () => {
    const sessionKey = 'test-delayed-tool-final-after-result';
    const runId = 'run-delayed-tool-final-after-result';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, runId);
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'tool',
        data: { phase: 'start', name: 'read', toolCallId: 'tool-late' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'tool',
        data: { phase: 'result', name: 'read', toolCallId: 'tool-late', output: 'done' },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-late', name: 'read' }] },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Settled before its mirror.' }] },
      });

      expect(events.filter((event) => event.type === 'tool_start')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'tool_end')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'done')).toEqual([
        expect.objectContaining({ content: 'Settled before its mirror.' }),
      ]);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('clears pending tools on abort before the next plain turn', () => {
    const sessionKey = 'test-abort-clears-pending-tools';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, 'run-aborted-tools');
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'run-aborted-tools',
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-abort', name: 'exec' }] },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'run-aborted-tools',
        state: 'aborted',
        text: 'Stopped.',
      });

      __persistentGatewayWsTest.registerRun(sessionKey, 'run-after-abort');
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'run-after-abort',
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'New turn completed.' }] },
      });

      expect(events.filter((event) => event.type === 'done')).toEqual([
        expect.objectContaining({ content: 'Stopped.' }),
        expect.objectContaining({ content: 'New turn completed.' }),
      ]);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('never lets an unpaired or stale session.message close an active run', () => {
    const sessionKey = 'test-session-message-run-correlation';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, 'run-current');
      __persistentGatewayWsTest.handleSessionMessageEvent({
        sessionKey,
        runId: 'run-current',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Pre-tool mirror.' }] },
      });
      __persistentGatewayWsTest.handleSessionMessageEvent({
        sessionKey,
        runId: 'run-previous',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Late prior answer.' }] },
      });

      expect(events.filter((event) => event.type === 'done')).toHaveLength(0);
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'run-current',
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'True final.' }] },
      });
      expect(events.filter((event) => event.type === 'done')).toEqual([
        expect.objectContaining({ content: 'True final.' }),
      ]);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('uses only a post-tool session mirror to satisfy an empty final', () => {
    const sessionKey = 'test-post-tool-empty-final-mirror';
    const runId = 'run-post-tool-empty-final-mirror';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, runId);
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'final',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Pre-tool prose.' },
            { type: 'toolCall', id: 'tool-mirror', name: 'read' },
          ],
        },
      });
      __persistentGatewayWsTest.handleSessionMessageEvent({
        sessionKey,
        runId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Pre-tool prose.' }] },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'tool',
        data: { phase: 'start', name: 'read', toolCallId: 'tool-mirror' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'tool',
        data: { phase: 'result', name: 'read', toolCallId: 'tool-mirror', output: 'ok' },
      });
      __persistentGatewayWsTest.handleSessionMessageEvent({
        sessionKey,
        runId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Post-tool answer.' }] },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'final',
        message: { role: 'assistant', content: [] },
      });

      expect(events.filter((event) => event.type === 'done')).toEqual([
        expect.objectContaining({ content: 'Post-tool answer.' }),
      ]);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('redacts provider secrets and credential paths before fatal errors reach live or durable events', () => {
    const sessionKey = 'test-fatal-error-redaction';
    const runId = 'run-fatal-error-redaction';
    const delivered: StreamEvent[] = [];
    let durableDuringDelivery: unknown[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => {
      delivered.push(event);
      durableDuringDelivery = streamEventBus.getRecentTurnEvents(sessionKey);
    });

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, runId);
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId,
        state: 'error',
        errorMessage: [
          'password=hunter2',
          'Authorization: Bearer abcdefghijklmnop',
          'Cookie: session=private-cookie',
          'request https://provider.example/private/callback?token=private-token',
          'credentials /root/.config/openclaw/credentials.json',
        ].join('\n'),
      });

      const retained = JSON.stringify({ delivered, durableDuringDelivery });
      expect(delivered).toEqual([
        expect.objectContaining({ type: 'error', terminal: true, runId }),
      ]);
      expect(retained).toContain('[redacted]');
      expect(retained).toContain('https://provider.example/[path/query redacted]');
      expect(retained).not.toMatch(/hunter2|abcdefghijklmnop|private-cookie|private-token|credentials\.json/);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });
});
