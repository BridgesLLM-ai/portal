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

  it('keeps command approval details off the ordinary session status stream', () => {
    const event = __persistentGatewayWsTest.buildApprovalWaitStatusEvent('approval-run');

    expect(event).toEqual({
      type: 'status',
      content: '⏳ Waiting for command approval…',
      runId: 'approval-run',
    });
    expect(event).not.toHaveProperty('approval');
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

  it('adopts the replacement run only inside an exact gateway-restart recovery fence', () => {
    const restartSessionKey = 'test-gateway-restart-replacement';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(restartSessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.registerRun(restartSessionKey, 'run-before-restart')).toBe(true);
      streamEventBus.publish(restartSessionKey, {
        type: 'text',
        content: 'Visible before restart.',
        runId: 'run-before-restart',
      });
      __persistentGatewayWsTest.beginReconnectRunRecovery(restartSessionKey, 'run-before-restart');

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey: restartSessionKey,
        runId: 'run-after-restart',
        stream: 'thinking',
        data: { text: 'Recovered thought', delta: 'Recovered thought' },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: 'run-after-restart' }),
        expect.objectContaining({ type: 'thinking', content: 'Recovered thought', runId: 'run-after-restart' }),
      ]));
      expect(streamEventBus.getTrackedStream(restartSessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: 'run-after-restart',
      }));

      __persistentGatewayWsTest.handleChatEvent({
        sessionKey: restartSessionKey,
        runId: 'run-before-restart',
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Late stale final' }] },
      });
      expect(events.some((event) => event.content === 'Late stale final')).toBe(false);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(restartSessionKey);
    }
  });

  it('replays run-only replacement frames once and in order after exact sessions.list adoption', () => {
    const restartSessionKey = 'test-run-only-restart-quarantine';
    const predecessorRunId = 'run-only-r1';
    const replacementRunId = 'run-only-r2';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(restartSessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.registerRun(restartSessionKey, predecessorRunId)).toBe(true);
      __persistentGatewayWsTest.beginReconnectRunRecovery(restartSessionKey, predecessorRunId);
      __persistentGatewayWsTest.armReconnectRunRecoveryAfterAuthentication(restartSessionKey);

      // OpenClaw may recover R1 as R2 and emit runtime frames before the
      // post-resubscribe sessions.list response supplies an exact session map.
      __persistentGatewayWsTest.handleAgentEvent({
        runId: replacementRunId,
        stream: 'thinking',
        data: { text: 'R2 thought before identity adoption.' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        runId: replacementRunId,
        stream: 'tool',
        data: { phase: 'start', name: 'read', toolCallId: 'run-only-tool' },
      });
      __persistentGatewayWsTest.handleChatEvent({
        runId: replacementRunId,
        state: 'delta',
        message: { role: 'assistant', content: 'R2 text after the tool started.' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        runId: replacementRunId,
        stream: 'tool',
        data: {
          phase: 'result',
          name: 'read',
          toolCallId: 'run-only-tool',
          result: 'read complete',
        },
      });
      __persistentGatewayWsTest.handleChatEvent({
        runId: replacementRunId,
        state: 'final',
        message: { role: 'assistant', content: 'R2 text after the tool started.' },
      });

      expect(__persistentGatewayWsTest.quarantinedRunFrameCount(replacementRunId)).toBe(5);
      expect(events.some((event) => event.runId === replacementRunId)).toBe(false);

      expect(__persistentGatewayWsTest.reconcileAuthoritativeLiveRun(
        restartSessionKey,
        replacementRunId,
      )).toBe(true);

      expect(__persistentGatewayWsTest.quarantinedRunFrameCount(replacementRunId)).toBe(0);
      expect(events.filter((event) => (
        event.runId === replacementRunId
        && ['run_resumed', 'thinking', 'tool_start', 'text', 'tool_end', 'done'].includes(event.type)
      )).map((event) => event.type)).toEqual([
        'run_resumed',
        'thinking',
        'tool_start',
        'text',
        'tool_end',
        'done',
      ]);
      expect(events.filter((event) => (
        event.type === 'run_resumed' && event.runId === replacementRunId
      ))).toHaveLength(1);

      const eventCountAfterReplay = events.length;
      expect(__persistentGatewayWsTest.reconcileAuthoritativeLiveRun(
        restartSessionKey,
        replacementRunId,
      )).toBe(false);
      expect(events).toHaveLength(eventCountAfterReplay);

      // The recovered final must release Portal's local ownership fence so the
      // next user send is admitted instead of failing "different run active".
      expect(__persistentGatewayWsTest.reserveLogicalRun(
        restartSessionKey,
        'run-after-recovered-final',
      )).toBe(true);

      // R1 is tombstoned by the CAS. A late run-only frame must be dropped,
      // never admitted to a fresh quarantine after the replacement is live.
      __persistentGatewayWsTest.handleAgentEvent({
        runId: predecessorRunId,
        stream: 'thinking',
        data: { text: 'Late R1 thought must stay hidden.' },
      });
      expect(__persistentGatewayWsTest.quarantinedRunFrameCount(predecessorRunId)).toBe(0);
      expect(events.some((event) => event.content === 'Late R1 thought must stay hidden.')).toBe(false);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(restartSessionKey);
    }
  });

  it('bounds and expires unresolved run-only frames without replaying them later', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-08T04:00:00.000Z'));
    const sessionKey = 'test-run-only-quarantine-bounds';
    const predecessorRunId = 'bounded-r1';
    const replacementRunId = 'bounded-r2';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.registerRun(sessionKey, predecessorRunId)).toBe(true);
      __persistentGatewayWsTest.beginReconnectRunRecovery(sessionKey, predecessorRunId);
      __persistentGatewayWsTest.armReconnectRunRecoveryAfterAuthentication(sessionKey);

      const { maxFramesPerRun, ttlMs } = __persistentGatewayWsTest.runFrameQuarantineLimits;
      for (let index = 0; index < maxFramesPerRun + 5; index += 1) {
        __persistentGatewayWsTest.handleAgentEvent({
          runId: replacementRunId,
          stream: 'thinking',
          data: { text: `bounded thought ${index}` },
        });
      }
      expect(__persistentGatewayWsTest.quarantinedRunFrameCount(replacementRunId)).toBe(maxFramesPerRun);

      jest.advanceTimersByTime(ttlMs + 1);
      expect(__persistentGatewayWsTest.quarantinedRunFrameCount(replacementRunId)).toBe(0);
      expect(__persistentGatewayWsTest.reconcileAuthoritativeLiveRun(
        sessionKey,
        replacementRunId,
      )).toBe(true);
      expect(events.some((event) => String(event.content).startsWith('bounded thought'))).toBe(false);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
      jest.useRealTimers();
    }
  });

  it('preserves mixed session-key and run-only frame order across dispatch acknowledgement', () => {
    const sessionKey = 'test-mixed-pre-ack-frame-order';
    const reservationRunId = 'mixed-reservation';
    const upstreamRunId = 'mixed-upstream-run';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.reserveLogicalRun(sessionKey, reservationRunId)).toBe(true);
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: upstreamRunId,
        stream: 'thinking',
        data: { text: 'A: session-key reasoning' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        runId: upstreamRunId,
        stream: 'tool',
        data: { phase: 'start', name: 'read', toolCallId: 'B-run-only-tool' },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: upstreamRunId,
        state: 'delta',
        message: { role: 'assistant', content: 'C: session-key text' },
      });

      expect(events).toEqual([]);
      expect(__persistentGatewayWsTest.quarantinedRunFrameCount(upstreamRunId)).toBe(1);
      expect(__persistentGatewayWsTest.acknowledgeRunReservation(
        sessionKey,
        reservationRunId,
        upstreamRunId,
      )).toBe(true);

      expect(events.filter((event) => (
        event.runId === upstreamRunId
        && ['thinking', 'tool_start', 'text'].includes(event.type)
      )).map((event) => event.type)).toEqual([
        'thinking',
        'tool_start',
        'text',
      ]);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('quarantines a desired-session foreign run before messages.subscribe acknowledges', () => {
    const sessionKey = 'test-desired-session-run-only-window';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      // registerRun installs the durable desired subscription. Completing R1
      // removes active ownership while leaving that desired subscription in
      // place for the reconnect path.
      expect(__persistentGatewayWsTest.registerRun(sessionKey, 'desired-r1')).toBe(true);
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'desired-r1',
        state: 'final',
        message: { role: 'assistant', content: 'R1 complete.' },
      });
      events.length = 0;

      __persistentGatewayWsTest.handleAgentEvent({
        runId: 'desired-foreign-r2',
        stream: 'thinking',
        data: { text: 'Foreign R2 arrived before messages.subscribe ACK.' },
      });
      expect(__persistentGatewayWsTest.quarantinedRunFrameCount('desired-foreign-r2')).toBe(1);
      expect(events).toEqual([]);

      expect(__persistentGatewayWsTest.reconcileAuthoritativeLiveRun(
        sessionKey,
        'desired-foreign-r2',
      )).toBe(true);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: 'desired-foreign-r2' }),
        expect.objectContaining({
          type: 'thinking',
          content: 'Foreign R2 arrived before messages.subscribe ACK.',
          runId: 'desired-foreign-r2',
        }),
      ]));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('does not resurrect a tombstoned replacement reported by a stale reconnect probe', () => {
    const restartSessionKey = 'test-stale-reconnect-probe-replacement';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(restartSessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.registerRun(restartSessionKey, 'run-already-terminal')).toBe(true);
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey: restartSessionKey,
        runId: 'run-already-terminal',
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Finished earlier.' }] },
      });
      expect(streamEventBus.getStreamStatus(restartSessionKey)).toBeNull();

      expect(__persistentGatewayWsTest.registerRun(
        restartSessionKey,
        'run-before-restart',
        'run-already-terminal',
      )).toBe(true);
      __persistentGatewayWsTest.beginReconnectRunRecovery(restartSessionKey, 'run-before-restart');

      expect(__persistentGatewayWsTest.reconcileReconnectRunProbeResult(
        restartSessionKey,
        ['run-already-terminal'],
      )).toBe(false);

      expect(streamEventBus.getTrackedStream(restartSessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: 'run-before-restart',
      }));
      expect(events).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: 'run-already-terminal' }),
      ]));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(restartSessionKey);
    }
  });

  it('keeps the restart fence open when the replacement appears after delayed recovery', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-08T02:00:00.000Z'));
    const delayedSessionKey = 'test-delayed-gateway-replacement';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(delayedSessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.registerRun(delayedSessionKey, 'run-before-restart')).toBe(true);
      __persistentGatewayWsTest.beginReconnectRunRecovery(delayedSessionKey, 'run-before-restart');

      __persistentGatewayWsTest.reconcileReconnectRunProbeResult(
        delayedSessionKey,
        ['run-before-restart'],
      );
      jest.advanceTimersByTime(30_000);
      __persistentGatewayWsTest.reconcileReconnectRunProbeResult(
        delayedSessionKey,
        ['run-before-restart'],
      );
      jest.advanceTimersByTime(12_000);

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey: delayedSessionKey,
        runId: 'run-after-delayed-recovery',
        stream: 'thinking',
        data: { text: 'Replacement arrived after the old run probes.', delta: 'Replacement arrived after the old run probes.' },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: 'run-after-delayed-recovery' }),
        expect.objectContaining({
          type: 'thinking',
          content: 'Replacement arrived after the old run probes.',
          runId: 'run-after-delayed-recovery',
        }),
      ]));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(delayedSessionKey);
      jest.useRealTimers();
    }
  });

  it('starts the bounded replacement window after authentication, not socket close', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-08T02:00:00.000Z'));
    const delayedAuthSessionKey = 'test-delayed-gateway-authentication';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(delayedAuthSessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.registerRun(delayedAuthSessionKey, 'run-before-outage')).toBe(true);
      __persistentGatewayWsTest.beginReconnectRunRecovery(delayedAuthSessionKey, 'run-before-outage');
      jest.advanceTimersByTime(3 * 60_000);
      __persistentGatewayWsTest.armReconnectRunRecoveryAfterAuthentication(delayedAuthSessionKey);

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey: delayedAuthSessionKey,
        runId: 'run-after-long-outage',
        stream: 'thinking',
        data: { text: 'Recovered after authentication.', delta: 'Recovered after authentication.' },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: 'run-after-long-outage' }),
        expect.objectContaining({ type: 'thinking', content: 'Recovered after authentication.' }),
      ]));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(delayedAuthSessionKey);
      jest.useRealTimers();
    }
  });

  it('keeps unknown reconnect state fail-closed instead of inventing a terminal', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-08T02:00:00.000Z'));
    const unknownSessionKey = 'test-unknown-reconnect-state';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(unknownSessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.registerRun(unknownSessionKey, 'run-unknown')).toBe(true);
      __persistentGatewayWsTest.beginReconnectRunRecovery(unknownSessionKey, 'run-unknown');
      __persistentGatewayWsTest.armReconnectRunRecoveryAfterAuthentication(unknownSessionKey);
      __persistentGatewayWsTest.reconcileReconnectRunProbeResult(unknownSessionKey, null);
      jest.advanceTimersByTime(120_001);
      await __persistentGatewayWsTest.settleReconnectRunRecovery(unknownSessionKey);

      expect(streamEventBus.getStreamStatus(unknownSessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: 'run-unknown',
      }));
      expect(events.some((event) => event.type === 'error' || event.type === 'done')).toBe(false);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'status',
          content: expect.stringContaining('still verifying'),
        }),
      ]));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(unknownSessionKey);
      jest.useRealTimers();
    }
  });

  it('settles an exactly inactive recovered run from its durable final', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-08T02:00:00.000Z'));
    const inactiveSessionKey = 'test-inactive-reconnect-history';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(inactiveSessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.registerRun(inactiveSessionKey, 'run-inactive')).toBe(true);
      __persistentGatewayWsTest.rememberRunOriginUser(
        inactiveSessionKey,
        'run-inactive',
        'portal-original-request',
      );
      __persistentGatewayWsTest.beginReconnectRunRecovery(inactiveSessionKey, 'run-inactive');
      __persistentGatewayWsTest.armReconnectRunRecoveryAfterAuthentication(inactiveSessionKey);

      expect(await __persistentGatewayWsTest.reconcileInactiveReconnectHistoryPayload(inactiveSessionKey, {
        messages: [
          {
            role: 'user',
            idempotencyKey: 'portal-original-request:user',
            content: 'Finish this during the outage.',
          },
          {
            role: 'user',
            runId: 'run-inactive',
            content: 'Injected guidance inside the same interrupted turn.',
          },
          {
            role: 'assistant',
            timestamp: Date.now(),
            content: 'Durable response completed during the outage.',
          },
        ],
      })).toBe(true);

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'history_changed' }),
        expect.objectContaining({ type: 'done', content: 'Durable response completed during the outage.' }),
      ]));
      expect(streamEventBus.getStreamStatus(inactiveSessionKey)).toBeNull();
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(inactiveSessionKey);
      jest.useRealTimers();
    }
  });

  it('finds a pre-ack origin beyond 100 later rows without taking a newer turn final', async () => {
    const sessionKey = 'test-pre-ack-origin-deep-history';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));
    let acceptedRunId = '';

    try {
      expect(__persistentGatewayWsTest.reconnectInactiveHistoryLimit).toBe(1_000);
      expect(__persistentGatewayWsTest.reserveLogicalRun(sessionKey, 'route-deep')).toBe(true);
      __persistentGatewayWsTest.parkAmbiguousRunDispatch(sessionKey, 'route-deep', {
        expectedUserIdempotencyKey: 'portal-route-deep',
        accept: async (runId: string) => {
          acceptedRunId = runId;
          if (!__persistentGatewayWsTest.acknowledgeRunReservation(sessionKey, 'route-deep', runId)) {
            throw new Error('Could not acknowledge deep-history recovered run');
          }
        },
        reject: () => undefined,
      });

      const injectedRows = Array.from({ length: 125 }, (_, index) => ({
        role: index % 2 === 0 ? 'system' : 'user',
        ...(index % 2 === 0 ? {} : { runId: 'upstream-deep' }),
        content: `Injected same-turn history row ${index + 1}`,
      }));
      expect(await __persistentGatewayWsTest.reconcileInactiveReconnectHistoryPayload(sessionKey, {
        messages: [
          {
            role: 'user',
            runId: 'upstream-deep',
            idempotencyKey: 'portal-route-deep:user',
            content: 'The exact Portal request whose ACK was lost.',
          },
          ...injectedRows,
          { role: 'assistant', content: 'The correct durable outage final.' },
          {
            role: 'user',
            idempotencyKey: 'discord-new-turn:user',
            content: 'A genuinely newer turn.',
          },
          { role: 'assistant', content: 'Foreign newer final must not be attributed.' },
        ],
      })).toBe(true);

      expect(acceptedRunId).toBe('upstream-deep');
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'done',
          content: 'The correct durable outage final.',
          runId: 'upstream-deep',
        }),
      ]));
      expect(events.some((event) => event.content === 'Foreign newer final must not be attributed.')).toBe(false);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('terminally rejects an exactly inactive dispatch after bounded missing-origin refreshes', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-08T02:00:00.000Z'));
    const sessionKey = 'test-pre-ack-inactive-missing-origin';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));
    const rejectedErrors: Error[] = [];
    const readHistory = jest.fn(async (_key: string, limit: number) => ({
      messages: [
        { role: 'user', idempotencyKey: 'different-origin:user', content: 'Not the lost dispatch.' },
        { role: 'assistant', content: 'A response belonging to that different turn.' },
      ],
      limit,
    }));

    try {
      expect(__persistentGatewayWsTest.reserveLogicalRun(sessionKey, 'route-missing')).toBe(true);
      __persistentGatewayWsTest.parkAmbiguousRunDispatch(sessionKey, 'route-missing', {
        expectedUserIdempotencyKey: 'portal-route-missing',
        accept: async () => undefined,
        reject: (error: Error) => { rejectedErrors.push(error); },
      });
      __persistentGatewayWsTest.armReconnectRunRecoveryAfterAuthentication(sessionKey);
      __persistentGatewayWsTest.reconcileReconnectRunProbeResult(sessionKey, []);

      for (let attempt = 0; attempt < __persistentGatewayWsTest.reconnectInactiveHistoryMaxAttempts; attempt += 1) {
        await __persistentGatewayWsTest.settleReconnectRunRecovery(sessionKey, readHistory);
      }

      expect(readHistory).toHaveBeenCalledTimes(3);
      expect(readHistory.mock.calls.every(([, limit]) => limit === 1_000)).toBe(true);
      expect(rejectedErrors).toHaveLength(1);
      expect(rejectedErrors[0].message).toContain('origin could not be verified');
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'history_changed',
          reason: 'reconnect-inactive-history-exhausted',
        }),
        expect.objectContaining({ type: 'error', terminal: true, runId: 'route-missing' }),
      ]));
      expect(streamEventBus.getStreamStatus(sessionKey)).toBeNull();
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
      jest.useRealTimers();
    }
  });

  it('stops durable recovery at a later unkeyed cross-channel user boundary', async () => {
    const sessionKey = 'test-unkeyed-foreign-turn-boundary';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.registerRun(sessionKey, 'run-origin')).toBe(true);
      __persistentGatewayWsTest.rememberRunOriginUser(
        sessionKey,
        'run-origin',
        'portal-origin-request',
      );
      __persistentGatewayWsTest.beginReconnectRunRecovery(sessionKey, 'run-origin');
      __persistentGatewayWsTest.armReconnectRunRecoveryAfterAuthentication(sessionKey);

      expect(await __persistentGatewayWsTest.reconcileInactiveReconnectHistoryPayload(sessionKey, {
        messages: [
          {
            role: 'user',
            runId: 'run-origin',
            idempotencyKey: 'portal-origin-request:user',
            content: 'Portal request whose terminal was lost.',
          },
          {
            role: 'user',
            content: 'Later Discord request without Portal idempotency metadata.',
          },
          {
            role: 'assistant',
            content: 'Foreign final must never settle the Portal request.',
          },
        ],
      })).toBe(true);

      expect(events.some((event) => (
        event.type === 'done'
        && event.content === 'Foreign final must never settle the Portal request.'
      ))).toBe(false);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'error', terminal: true, runId: 'run-origin' }),
      ]));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('adopts one exact outage-started foreign run before its run-only reasoning arrives', () => {
    const outageSessionKey = 'test-outage-started-foreign-run';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(outageSessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.reconcileAuthoritativeLiveRun(outageSessionKey, 'foreign-outage-run')).toBe(true);
      __persistentGatewayWsTest.handleAgentEvent({
        runId: 'foreign-outage-run',
        stream: 'thinking',
        data: { text: 'Live again before terminal.', delta: 'Live again before terminal.' },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: 'foreign-outage-run' }),
        expect.objectContaining({ type: 'thinking', content: 'Live again before terminal.' }),
      ]));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(outageSessionKey);
    }
  });

  it('does not resurrect a completed run from a stale sessions.list response', () => {
    const staleListSessionKey = 'test-stale-list-after-terminal';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(staleListSessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.registerRun(staleListSessionKey, 'completed-run')).toBe(true);
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey: staleListSessionKey,
        runId: 'completed-run',
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Finished once.' }] },
      });
      expect(streamEventBus.getStreamStatus(staleListSessionKey)).toBeNull();

      expect(__persistentGatewayWsTest.reconcileAuthoritativeLiveRun(
        staleListSessionKey,
        'completed-run',
      )).toBe(false);
      expect(streamEventBus.getStreamStatus(staleListSessionKey)).toBeNull();
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(staleListSessionKey);
    }
  });

  it('recovers a pre-ack disconnect without installing the durable-failure fence', async () => {
    const preAckSessionKey = 'test-pre-ack-disconnect';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(preAckSessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.reserveLogicalRun(preAckSessionKey, 'route-reservation')).toBe(true);
      __persistentGatewayWsTest.parkAmbiguousRunDispatch(preAckSessionKey, 'route-reservation', {
        expectedUserIdempotencyKey: 'portal-route-reservation',
        accept: async (runId: string) => {
          if (!__persistentGatewayWsTest.acknowledgeRunReservation(
            preAckSessionKey,
            'route-reservation',
            runId,
          )) throw new Error('Could not acknowledge recovered test run');
        },
        reject: (error: Error) => { throw error; },
      });
      __persistentGatewayWsTest.handleSessionMessageEvent({
        sessionKey: preAckSessionKey,
        hasActiveRun: true,
        activeRunIds: ['accepted-upstream-run'],
        message: {
          role: 'user',
          idempotencyKey: 'portal-route-reservation:user',
          content: 'The request whose acknowledgement was lost.',
        },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey: preAckSessionKey,
        runId: 'accepted-upstream-run',
        stream: 'thinking',
        data: { text: 'The ACK was lost, not the turn.', delta: 'The ACK was lost, not the turn.' },
      });
      expect(events.some((event) => event.type === 'thinking')).toBe(false);

      expect(await __persistentGatewayWsTest.finalizeAmbiguousRunDispatch(
        preAckSessionKey,
        'accepted-upstream-run',
      )).toBe(true);

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: 'accepted-upstream-run' }),
        expect.objectContaining({ type: 'thinking', content: 'The ACK was lost, not the turn.' }),
      ]));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(preAckSessionKey);
    }
  });

  it('does not misattribute a foreign outage run to a lost Portal dispatch', async () => {
    const collisionSessionKey = 'test-pre-ack-foreign-collision';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(collisionSessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.reserveLogicalRun(collisionSessionKey, 'portal-request-a')).toBe(true);
      __persistentGatewayWsTest.parkAmbiguousRunDispatch(collisionSessionKey, 'portal-request-a', {
        expectedUserIdempotencyKey: 'portal-portal-request-a',
        accept: async (runId: string) => {
          if (!__persistentGatewayWsTest.acknowledgeRunReservation(
            collisionSessionKey,
            'portal-request-a',
            runId,
          )) throw new Error('Could not acknowledge recovered test run');
        },
        reject: (error: Error) => { throw error; },
      });
      __persistentGatewayWsTest.handleSessionMessageEvent({
        sessionKey: collisionSessionKey,
        hasActiveRun: true,
        activeRunIds: ['discord-run-b'],
        message: {
          role: 'user',
          idempotencyKey: 'discord-run-b:user',
          content: 'A different prompt sent from Discord.',
        },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        runId: 'discord-run-b',
        stream: 'thinking',
        data: { text: 'Foreign reasoning must stay fenced.', delta: 'Foreign reasoning must stay fenced.' },
      });

      expect(await __persistentGatewayWsTest.finalizeAmbiguousRunDispatch(
        collisionSessionKey,
        'discord-run-b',
      )).toBe(false);
      expect(events.some((event) => event.content === 'Foreign reasoning must stay fenced.')).toBe(false);
      expect(streamEventBus.getStreamStatus(collisionSessionKey)).toEqual(expect.objectContaining({
        active: true,
        runId: 'portal-request-a',
      }));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(collisionSessionKey);
    }
  });

  it('commits a correlated pre-ack run before replaying its durable outage final', async () => {
    const sessionKey = 'test-pre-ack-inactive-final';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));
    let acceptedRunId = '';

    try {
      expect(__persistentGatewayWsTest.reserveLogicalRun(sessionKey, 'route-final')).toBe(true);
      __persistentGatewayWsTest.parkAmbiguousRunDispatch(sessionKey, 'route-final', {
        expectedUserIdempotencyKey: 'portal-route-final',
        accept: async (runId: string) => {
          acceptedRunId = runId;
          if (!__persistentGatewayWsTest.acknowledgeRunReservation(sessionKey, 'route-final', runId)) {
            throw new Error('Could not acknowledge recovered test run');
          }
        },
        reject: (error: Error) => { throw error; },
      });
      __persistentGatewayWsTest.handleSessionMessageEvent({
        sessionKey,
        hasActiveRun: true,
        activeRunIds: ['upstream-final'],
        message: {
          role: 'user',
          idempotencyKey: 'portal-route-final:user',
          content: 'Complete during the outage.',
        },
      });

      expect(await __persistentGatewayWsTest.reconcileInactiveReconnectHistoryPayload(sessionKey, {
        messages: [
          { role: 'user', idempotencyKey: 'portal-route-final:user', content: 'Complete during the outage.' },
          { role: 'assistant', content: 'Durable pre-ACK final.' },
        ],
      })).toBe(true);

      expect(acceptedRunId).toBe('upstream-final');
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'done', content: 'Durable pre-ACK final.', runId: 'upstream-final' }),
      ]));
      expect(streamEventBus.getStreamStatus(sessionKey)).toBeNull();
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('settles a correlated pre-ack run as an error when exact inactive history has no final', async () => {
    const sessionKey = 'test-pre-ack-inactive-empty';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.reserveLogicalRun(sessionKey, 'route-empty')).toBe(true);
      __persistentGatewayWsTest.parkAmbiguousRunDispatch(sessionKey, 'route-empty', {
        expectedUserIdempotencyKey: 'portal-route-empty',
        accept: async (runId: string) => {
          if (!__persistentGatewayWsTest.acknowledgeRunReservation(sessionKey, 'route-empty', runId)) {
            throw new Error('Could not acknowledge recovered test run');
          }
        },
        reject: (error: Error) => { throw error; },
      });
      __persistentGatewayWsTest.handleSessionMessageEvent({
        sessionKey,
        hasActiveRun: true,
        activeRunIds: ['upstream-empty'],
        message: {
          role: 'user',
          idempotencyKey: 'portal-route-empty:user',
          content: 'This turn never produced a final.',
        },
      });

      expect(await __persistentGatewayWsTest.reconcileInactiveReconnectHistoryPayload(sessionKey, {
        messages: [{
          role: 'user',
          idempotencyKey: 'portal-route-empty:user',
          content: 'This turn never produced a final.',
        }],
      })).toBe(true);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'error', terminal: true, runId: 'upstream-empty' }),
      ]));
      expect(streamEventBus.getStreamStatus(sessionKey)).toBeNull();
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('publishes and deduplicates foreign user messages before their run finishes', () => {
    const foreignSessionKey = 'test-foreign-live-user-message';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(foreignSessionKey, (event) => events.push(event));
    const userPayload = {
      sessionKey: foreignSessionKey,
      hasActiveRun: true,
      activeRunIds: ['foreign-run'],
      message: {
        id: 'foreign-user-message-1',
        role: 'user',
        idempotencyKey: 'foreign-run:user',
        sourceChannel: 'discord',
        timestamp: 1_786_150_000_000,
        content: 'Visible from Discord while the turn is active.',
      },
    };
    const secondUserPayload = {
      ...userPayload,
      message: {
        ...userPayload.message,
        id: 'foreign-user-message-2',
        content: 'A second same-run Discord steer remains independently visible.',
      },
    };

    try {
      __persistentGatewayWsTest.handleSessionMessageEvent(userPayload);
      __persistentGatewayWsTest.handleSessionMessageEvent(userPayload);
      __persistentGatewayWsTest.handleSessionMessageEvent(secondUserPayload);
      __persistentGatewayWsTest.handleAgentEvent({
        runId: 'foreign-run',
        stream: 'thinking',
        data: { text: 'Live foreign thought', delta: 'Live foreign thought' },
      });

      expect(events.filter((event) => event.type === 'user_message')).toEqual([
        expect.objectContaining({
          content: 'Visible from Discord while the turn is active.',
          messageId: 'foreign-user-message-1',
          sourceChannel: 'discord',
          runId: 'foreign-run',
        }),
        expect.objectContaining({
          content: 'A second same-run Discord steer remains independently visible.',
          messageId: 'foreign-user-message-2',
          runId: 'foreign-run',
        }),
      ]);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: 'foreign-run' }),
        expect.objectContaining({ type: 'thinking', content: 'Live foreign thought', runId: 'foreign-run' }),
      ]));
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(foreignSessionKey);
    }
  });

  it('admits an exact newer foreign run after a failed Portal reservation without reviving late failed frames', () => {
    const sessionKey = 'test-foreign-run-after-failed-portal-reservation';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.reserveLogicalRun(sessionKey, 'failed-portal-reservation')).toBe(true);
      __persistentGatewayWsTest.setPendingRunUserIdempotency(
        sessionKey,
        'failed-portal-reservation',
        'portal-failed-request',
      );
      __persistentGatewayWsTest.failPendingRunReservation(sessionKey, 'failed-portal-reservation');

      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'failed-portal-reservation',
        stream: 'thinking',
        data: { text: 'Late failed-frame reasoning must stay hidden.' },
      });
      __persistentGatewayWsTest.handleSessionMessageEvent({
        sessionKey,
        activeRunIds: ['foreign-run-after-failure'],
        message: {
          id: 'foreign-user-after-failure',
          role: 'user',
          sourceChannel: 'discord',
          content: 'A newer Discord turn should heal live visibility.',
        },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'foreign-run-after-failure',
        stream: 'thinking',
        data: { text: 'Visible foreign reasoning after the failed Portal send.' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'foreign-run-after-failure',
        stream: 'tool',
        data: { phase: 'start', name: 'read', toolCallId: 'foreign-tool-after-failure' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId: 'foreign-run-after-failure',
        stream: 'tool',
        data: {
          phase: 'result',
          name: 'read',
          toolCallId: 'foreign-tool-after-failure',
          result: 'tool complete',
        },
      });
      __persistentGatewayWsTest.handleChatEvent({
        sessionKey,
        runId: 'foreign-run-after-failure',
        state: 'final',
        message: { role: 'assistant', content: 'Visible foreign final after recovery.' },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'user_message',
          messageId: 'foreign-user-after-failure',
          content: 'A newer Discord turn should heal live visibility.',
        }),
        expect.objectContaining({ type: 'run_resumed', runId: 'foreign-run-after-failure' }),
        expect.objectContaining({
          type: 'thinking',
          content: 'Visible foreign reasoning after the failed Portal send.',
          runId: 'foreign-run-after-failure',
        }),
        expect.objectContaining({ type: 'tool_start', toolCallId: 'foreign-tool-after-failure' }),
        expect.objectContaining({
          type: 'done',
          content: 'Visible foreign final after recovery.',
          runId: 'foreign-run-after-failure',
        }),
      ]));
      expect(events.some((event) => event.content === 'Late failed-frame reasoning must stay hidden.')).toBe(false);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('heals a failed Portal fence from one exact post-resubscribe foreign run when its user mirror was missed', () => {
    const sessionKey = 'test-authoritative-foreign-run-after-failed-reservation';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      expect(__persistentGatewayWsTest.reserveLogicalRun(sessionKey, 'failed-reservation-r1')).toBe(true);
      __persistentGatewayWsTest.setPendingRunUserIdempotency(
        sessionKey,
        'failed-reservation-r1',
        'portal-failed-r1',
      );
      __persistentGatewayWsTest.failPendingRunReservation(sessionKey, 'failed-reservation-r1');

      __persistentGatewayWsTest.handleAgentEvent({
        runId: 'foreign-r2-from-sessions-list',
        stream: 'thinking',
        data: { text: 'R2 reasoning after resubscribe' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        runId: 'foreign-r2-from-sessions-list',
        stream: 'tool',
        data: { phase: 'start', name: 'read', toolCallId: 'r2-tool-after-resubscribe' },
      });
      __persistentGatewayWsTest.handleAgentEvent({
        runId: 'foreign-r2-from-sessions-list',
        stream: 'tool',
        data: {
          phase: 'result',
          name: 'read',
          toolCallId: 'r2-tool-after-resubscribe',
          result: 'done',
        },
      });
      __persistentGatewayWsTest.handleChatEvent({
        runId: 'foreign-r2-from-sessions-list',
        state: 'final',
        message: { role: 'assistant', content: 'R2 final after resubscribe.' },
      });

      expect(__persistentGatewayWsTest.quarantinedRunFrameCount(
        'foreign-r2-from-sessions-list',
      )).toBe(4);
      expect(events).toEqual([]);

      expect(__persistentGatewayWsTest.reconcileAuthoritativeLiveRun(
        sessionKey,
        'foreign-r2-from-sessions-list',
      )).toBe(true);

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run_resumed', runId: 'foreign-r2-from-sessions-list' }),
        expect.objectContaining({ type: 'thinking', content: 'R2 reasoning after resubscribe' }),
        expect.objectContaining({ type: 'tool_start', toolCallId: 'r2-tool-after-resubscribe' }),
        expect.objectContaining({ type: 'done', content: 'R2 final after resubscribe.' }),
      ]));
      expect(__persistentGatewayWsTest.reconcileAuthoritativeLiveRun(
        sessionKey,
        'failed-reservation-r1',
      )).toBe(false);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('publishes and deduplicates a Portal-origin echo under its exact optimistic message id', () => {
    const sessionKey = 'test-portal-optimistic-user-message';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      const payload = {
        sessionKey,
        runId: 'portal-run',
        message: {
          id: 'openclaw-row-id-must-not-win',
          role: 'user',
          idempotencyKey: 'portal-server-request-1:client:msg-1786150000000-7:user',
          timestamp: 1_786_150_000_000,
          content: 'Already rendered optimistically by Portal.',
        },
      };
      __persistentGatewayWsTest.handleSessionMessageEvent(payload);
      __persistentGatewayWsTest.handleSessionMessageEvent(payload);

      expect(events.filter((event) => event.type === 'user_message')).toEqual([
        expect.objectContaining({
          content: 'Already rendered optimistically by Portal.',
          messageId: 'msg-1786150000000-7',
          runId: 'portal-run',
        }),
      ]);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('reads only exact live identities from a bounded sessions.list payload', () => {
    expect(__persistentGatewayWsTest.liveRunIdsFromSessionList({
      sessions: [
        { key: 'agent:main:other', hasActiveRun: true, activeRunIds: ['wrong-run'] },
        { key: 'agent:main:target', hasActiveRun: true, activeRunIds: ['replacement-run'] },
      ],
    }, 'agent:main:target')).toEqual(['replacement-run']);
    expect(__persistentGatewayWsTest.liveRunIdsFromSessionList({
      sessions: [{ key: 'agent:main:target', hasActiveRun: false, activeRunIds: [] }],
    }, 'agent:main:target')).toEqual([]);
    expect(__persistentGatewayWsTest.liveRunIdsFromSessionList({
      sessions: [{ key: 'agent:main:target', hasActiveRun: true }],
    }, 'agent:main:target')).toBeNull();
    expect(__persistentGatewayWsTest.liveRunIdsFromSessionList({
      sessions: [{ key: 'agent:main:target', activeRunIds: ['unattested-run'] }],
    }, 'agent:main:target')).toBeNull();
    expect(__persistentGatewayWsTest.liveRunIdsFromSessionList({
      sessions: [{ key: 'agent:main:target', hasActiveRun: false, activeRunIds: ['contradictory-run'] }],
    }, 'agent:main:target')).toBeNull();
    expect(__persistentGatewayWsTest.liveRunIdsFromSessionList({
      sessions: [{ key: 'agent:main:other', hasActiveRun: false }],
    }, 'agent:main:target')).toBeNull();
    expect(__persistentGatewayWsTest.liveRunIdsFromSessionList({
      sessions: [
        { key: 'agent:main:target', hasActiveRun: false, activeRunIds: [] },
        { key: 'agent:main:target', hasActiveRun: false, activeRunIds: [] },
      ],
    }, 'agent:main:target')).toBeNull();
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
      // Claude CLI can expose encrypted reasoning only as a cumulative token
      // count. Keep that activity visible without pretending it is thought text.
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
      const progressStatusEvents = events.filter((event) => event.type === 'status');
      expect(progressStatusEvents).toEqual([
        expect.objectContaining({
          content: 'Thinking… (~128 tokens)',
          replace: true,
          transient: true,
          runId: 'run-thinking-snapshot',
        }),
      ]);
      expect(progressStatusEvents[0].turnEvent).toBeUndefined();
      expect(streamEventBus.getTrackedStream(sessionKey)).toMatchObject({
        phase: 'thinking',
        statusText: 'Thinking… (~128 tokens)',
      });
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('publishes provider preamble progress as one replaceable status block', () => {
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

      const progress = events.find((event) => event.type === 'status');
      expect(progress).toMatchObject({
        type: 'status',
        content: '**Inspecting runtime** password=[redacted]',
        replace: true,
        preambleProgress: true,
        runId: 'run-thinking-subject',
      });
      expect(progress?.turnEvent).toMatchObject({
        type: 'assistant_reasoning',
        text: '**Inspecting runtime** password=[redacted]',
        replace: true,
        visible: true,
        source: { preambleProgress: true },
      });
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('collapses tokenized cumulative Codex preambles into one growing thought', () => {
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
        events.filter((event) => event.type === 'status').map((event) => ({
          content: event.content,
          replace: event.replace,
          subject: event.subject,
        })),
      ).toEqual([
        { content: 'Inspecting files', replace: true, subject: undefined },
        { content: 'Inspecting filesRunning tests', replace: true, subject: undefined },
        { content: 'Inspecting filesRunning testsSummarizing results', replace: true, subject: undefined },
      ]);
      expect(
        streamEventBus.getRecentTurnEvents(sessionKey)
          .filter((event) => event.type === 'assistant_reasoning'),
      ).toEqual([
        expect.objectContaining({
          text: 'Inspecting filesRunning testsSummarizing results',
          replace: true,
        }),
      ]);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('evicts the oldest preamble items after the distinct-item bound', () => {
    const sessionKey = 'test-preamble-item-bound';
    const runId = 'run-preamble-item-bound';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, runId);
      const { maxItems } = __persistentGatewayWsTest.preambleProgressLimits;
      for (let index = 0; index < maxItems + 2; index += 1) {
        __persistentGatewayWsTest.handleAgentEvent({
          sessionKey,
          runId,
          stream: 'item',
          data: {
            kind: 'preamble',
            itemId: `preamble-${index}`,
            progressText: `[progress:${index}]`,
          },
        });
      }

      const latestProgress = events.filter((event) => event.type === 'status').at(-1)?.content || '';
      expect(latestProgress).not.toContain('[progress:0]');
      expect(latestProgress).not.toContain('[progress:1]');
      expect(latestProgress).toContain('[progress:2]');
      expect(latestProgress).toContain(`[progress:${maxItems + 1}]`);
      expect(latestProgress.split('\n\n')).toHaveLength(maxItems);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('truncates an oversized cumulative preamble while preserving its newest tail', () => {
    const sessionKey = 'test-preamble-character-bound';
    const runId = 'run-preamble-character-bound';
    const events: StreamEvent[] = [];
    const unsubscribe = streamEventBus.subscribe(sessionKey, (event) => events.push(event));

    try {
      __persistentGatewayWsTest.registerRun(sessionKey, runId);
      const { maxChars, truncationMarker } = __persistentGatewayWsTest.preambleProgressLimits;
      const newestTail = '[latest progress survives]';
      __persistentGatewayWsTest.handleAgentEvent({
        sessionKey,
        runId,
        stream: 'item',
        data: {
          kind: 'preamble',
          itemId: 'oversized-preamble',
          progressText: `${'x'.repeat(maxChars + 256)}${newestTail}`,
        },
      });

      const latestProgress = events.filter((event) => event.type === 'status').at(-1)?.content || '';
      expect(latestProgress).toHaveLength(maxChars);
      expect(latestProgress.startsWith(truncationMarker)).toBe(true);
      expect(latestProgress.endsWith(newestTail)).toBe(true);
    } finally {
      unsubscribe();
      __persistentGatewayWsTest.resetSession(sessionKey);
    }
  });

  it('treats a non-extending anonymous preamble snapshot as an authoritative replacement', () => {
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
        events.filter((event) => event.type === 'status').map((event) => event.content),
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

      expect(events.filter((event) => event.type === 'thinking' || event.type === 'status').map((event) => ({
        subject: event.subject,
        content: event.content,
        replace: event.replace,
      }))).toEqual([
        { subject: undefined, content: 'Inspecting files', replace: true },
        { subject: undefined, content: 'Reading file A.', replace: undefined },
        { subject: undefined, content: 'Running tests', replace: true },
        { subject: undefined, content: 'Running test B.', replace: undefined },
      ]);
      expect(streamEventBus.getRecentTurnEvents(sessionKey)).toEqual([
        expect.objectContaining({ type: 'assistant_reasoning', text: 'Inspecting files', replace: true }),
        expect.objectContaining({ type: 'assistant_reasoning', text: 'Reading file A.' }),
        expect.objectContaining({ type: 'assistant_reasoning', text: 'Running tests', replace: true }),
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
