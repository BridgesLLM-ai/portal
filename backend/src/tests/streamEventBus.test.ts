import { StreamEventBus } from '../services/StreamEventBus';

describe('StreamEventBus', () => {
  test('treats multiple browser tabs as fan-out while preserving exact role counts', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:two-browser-tabs';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unsubscribeProvider = bus.subscribe(sessionKey, () => undefined, { role: 'provider-waiter' });
    const unsubscribeTerminal = bus.subscribe(sessionKey, () => undefined, { role: 'route-terminal' });
    const unsubscribeFirstTab = bus.subscribe(sessionKey, () => undefined, { role: 'browser-ws' });
    const unsubscribeSecondTab = bus.subscribe(sessionKey, () => undefined, { role: 'browser-ws' });

    try {
      expect(bus.getSubscriberDiagnostics(sessionKey)).toEqual({
        total: 4,
        roles: {
          'provider-waiter': 1,
          'route-terminal': 1,
          'browser-ws': 2,
          'browser-sse': 0,
          internal: 0,
          unspecified: 0,
        },
      });

      bus.startStream(sessionKey, 'run-fanout');
      bus.publish(sessionKey, { type: 'text', content: 'visible in both tabs', runId: 'run-fanout' });
      expect(warn).not.toHaveBeenCalled();

      unsubscribeFirstTab();
      expect(bus.getSubscriberDiagnostics(sessionKey)).toMatchObject({
        total: 3,
        roles: { 'browser-ws': 1 },
      });
    } finally {
      unsubscribeProvider();
      unsubscribeTerminal();
      unsubscribeFirstTab();
      unsubscribeSecondTab();
      warn.mockRestore();
    }
    expect(bus.getSubscriberDiagnostics(sessionKey).total).toBe(0);
  });

  test('warns on duplicated internal turn ownership instead of raw browser count', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:duplicated-provider-owner';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unsubscribeFirst = bus.subscribe(sessionKey, () => undefined, { role: 'provider-waiter' });
    const unsubscribeSecond = bus.subscribe(sessionKey, () => undefined, { role: 'provider-waiter' });

    try {
      bus.startStream(sessionKey, 'run-duplicate');
      bus.publish(sessionKey, { type: 'text', content: 'one turn', runId: 'run-duplicate' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('subscriber accumulation');
      expect(warn.mock.calls[0][0]).toContain('provider-waiter=2');
    } finally {
      unsubscribeFirst();
      unsubscribeSecond();
      warn.mockRestore();
    }
  });

  test('notifies global reconnect listeners even while an internal session observer exists', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'native:reconnect-during-internal-observer';
    const direct: any[] = [];
    const global: any[] = [];

    bus.subscribe(sessionKey, (event) => direct.push(event));
    bus.subscribeGlobal((observedSession, event) => global.push({ observedSession, event }));
    bus.startStream(sessionKey, 'run-1');
    bus.publish(sessionKey, { type: 'text', content: 'survives reconnect', runId: 'run-1' });

    expect(direct).toHaveLength(1);
    expect(global).toEqual([{
      observedSession: sessionKey,
      event: expect.objectContaining({ type: 'text', content: 'survives reconnect', runId: 'run-1' }),
    }]);
  });

  test('keeps the tool phase and tool label while maintenance status updates arrive', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:main';

    bus.startStream(sessionKey, 'run-1');
    bus.updateStreamPhase(sessionKey, { phase: 'tool', toolName: 'exec' });
    bus.publish(sessionKey, { type: 'tool_start', toolName: 'exec', content: 'Using tool: exec', runId: 'run-1' });

    bus.updateStreamPhase(sessionKey, {
      phase: 'thinking',
      statusText: 'Preparing context maintenance…',
      compactionPhase: 'compacting',
    });
    bus.publish(sessionKey, {
      type: 'status',
      content: 'Preparing context maintenance…',
      maintenanceKind: 'maintenance',
    });

    const status = bus.getStreamStatus(sessionKey);
    expect(status).not.toBeNull();
    expect(status?.phase).toBe('tool');
    expect(status?.toolName).toBe('exec');
    expect(status?.compactionPhase).toBe('compacting');
    expect(status?.statusText).toBe('Using exec…');
    expect(status?.toolCalls?.[0]?.status).toBe('running');
  });

  test('creates tool-phase snapshots when a running tool call is already present', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:resume-test';

    bus.updateStreamPhase(sessionKey, {
      phase: 'thinking',
      toolCalls: [{
        id: 'tool-1',
        name: 'web_fetch',
        startedAt: Date.now(),
        status: 'running',
      }],
      statusText: 'Preparing context maintenance…',
      compactionPhase: 'compacting',
    });

    const status = bus.getStreamStatus(sessionKey);
    expect(status).not.toBeNull();
    expect(status?.phase).toBe('tool');
    expect(status?.compactionPhase).toBe('compacting');
    expect(status?.toolCalls?.[0]?.name).toBe('web_fetch');
  });

  test('does not copy visible reasoning into stream snapshot status text', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:rail-leak-test';

    bus.startStream(sessionKey, 'run-1');
    bus.updateStreamPhase(sessionKey, {
      phase: 'thinking',
      statusText: 'I should inspect the files before answering.',
    });
    bus.publish(sessionKey, {
      type: 'thinking',
      content: 'I should inspect the files before answering.',
      replace: true,
      runId: 'run-1',
    });
    bus.publish(sessionKey, {
      type: 'status',
      content: 'I am moving from the tool result back into reasoning.',
      runId: 'run-1',
    });

    const status = bus.getStreamStatus(sessionKey);
    expect(status).not.toBeNull();
    expect(status?.statusText).toBe('Thinking…');
  });

  test('keeps lifecycle status available for the rail', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:maintenance-rail-test';

    bus.startStream(sessionKey, 'run-1');
    bus.publish(sessionKey, {
      type: 'status',
      content: 'Preparing context maintenance…',
      maintenanceKind: 'maintenance',
    });

    const status = bus.getStreamStatus(sessionKey);
    expect(status?.statusText).toBe('Preparing context maintenance…');
  });

  test('shows delayed Codex completion as recoverable status instead of hiding it', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:codex-idle-timeout-test';

    bus.startStream(sessionKey, 'run-1');
    bus.publish(sessionKey, {
      type: 'status',
      content: 'Codex turn completion is delayed; waiting for the final response…',
      runId: 'run-1',
    });

    const status = bus.getStreamStatus(sessionKey);
    expect(status?.statusText).toBe('Codex turn completion is delayed; waiting for the final response…');
  });

  test('attaches normalized runtime turn events to outbound stream events', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:turn-event-test';
    const received: any[] = [];

    bus.subscribe(sessionKey, (event) => received.push(event));
    bus.startStream(sessionKey, 'run-1', { model: 'openai-codex/gpt-5.5', provenance: 'via OpenClaw' });
    bus.publish(sessionKey, { type: 'status', content: 'Preparing tools…', runId: 'run-1' });
    bus.publish(sessionKey, { type: 'thinking', content: 'I should inspect the file.', runId: 'run-1' });
    bus.publish(sessionKey, { type: 'tool_start', toolName: 'read', toolArgs: { path: 'README.md' }, runId: 'run-1' });
    bus.publish(sessionKey, { type: 'tool_end', toolName: 'read', toolResult: 'ok', runId: 'run-1' });
    bus.publish(sessionKey, { type: 'text', content: 'Fixed.', runId: 'run-1' });
    bus.publish(sessionKey, { type: 'done', content: 'Fixed.', runId: 'run-1' });

    expect(received.map((event) => event.turnEvent?.type)).toEqual([
      'assistant_status',
      'assistant_reasoning',
      'tool_started',
      'tool_output',
      'assistant_delta',
      'assistant_final',
    ]);
    expect(received[0].turnEvent.schema).toBe('bridgesllm.runtime-turn-event.v1');
    expect(received[1].turnEvent.visible).toBe(true);
    expect(received[2].turnEvent.tool).toMatchObject({ name: 'read', status: 'running' });
    expect(received[5].turnEvent).toMatchObject({ terminal: true, model: 'openai-codex/gpt-5.5', provenance: 'via OpenClaw' });
    expect(bus.getRecentTurnEvents(sessionKey).map((event) => event.type)).toEqual(received.map((event) => event.turnEvent.type));
  });

  test('retains subject-only reasoning in live and durable turn events', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:subject-only';
    const received: any[] = [];

    bus.subscribe(sessionKey, (event) => received.push(event));
    bus.startStream(sessionKey, 'run-subject');
    bus.publish(sessionKey, {
      type: 'thinking',
      content: '',
      subject: '**Checking**\nsecret=top-secret',
      runId: 'run-subject',
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'thinking',
      subject: 'Checking [redacted]',
      content: '',
    });
    expect(received[0].turnEvent).toMatchObject({
      type: 'assistant_reasoning',
      subject: 'Checking [redacted]',
      visible: true,
    });
    expect(bus.getRecentTurnEvents(sessionKey)).toEqual([
      expect.objectContaining({
        type: 'assistant_reasoning',
        subject: 'Checking [redacted]',
      }),
    ]);
  });

  test('marks failed tool completions as runtime tool errors', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:failed-tool-test';
    const received: any[] = [];

    bus.subscribe(sessionKey, (event) => received.push(event));
    bus.startStream(sessionKey, 'run-1');
    bus.publish(sessionKey, { type: 'tool_start', toolName: 'bash', content: 'Using tool: bash', runId: 'run-1' });
    bus.publish(sessionKey, {
      type: 'tool_end',
      toolName: 'bash',
      content: '❌ Tool failed: bash',
      toolResult: 'exit code 75',
      status: 'error',
      runId: 'run-1',
    });

    const status = bus.getStreamStatus(sessionKey);
    expect(status?.toolCalls?.[0]?.status).toBe('error');
    expect(received[1].turnEvent).toMatchObject({
      type: 'tool_output',
      tool: { name: 'bash', status: 'error', result: 'exit code 75' },
    });
  });

  test('correlates interleaved tools by supplied id and preserves provider failure shapes', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:parallel-native-tools';
    const received: any[] = [];

    bus.subscribe(sessionKey, (event) => received.push(event));
    bus.startStream(sessionKey, 'run-parallel');
    bus.publish(sessionKey, { type: 'tool_start', toolName: 'read', toolCallId: 'call-a', toolArgs: { path: 'a' }, runId: 'run-parallel' });
    bus.publish(sessionKey, { type: 'tool_start', toolName: 'exec', toolCallId: 'call-b', toolArgs: { command: 'test' }, runId: 'run-parallel' });
    bus.publish(sessionKey, { type: 'tool_update', toolCallId: 'call-a', toolResult: 'partial-a', runId: 'run-parallel' });
    bus.publish(sessionKey, {
      type: 'tool_end',
      toolName: 'read',
      toolCallId: 'call-a',
      toolResult: 'read failed',
      isError: true,
      runId: 'run-parallel',
    });

    let status = bus.getStreamStatus(sessionKey);
    expect(status?.toolCalls).toEqual([
      expect.objectContaining({ id: 'call-a', name: 'read', result: 'read failed', status: 'error' }),
      expect.objectContaining({ id: 'call-b', name: 'exec', status: 'running' }),
    ]);
    expect(status?.toolName).toBe('exec');
    expect(status?.statusText).toBe('Using exec…');
    expect(received[3]).toMatchObject({
      toolCallId: 'call-a',
      turnEvent: {
        type: 'tool_output',
        runId: 'run-parallel',
        tool: { id: 'call-a', status: 'error', result: 'read failed' },
      },
    });
    const eventCountAfterTerminalA = received.length;
    bus.publish(sessionKey, { type: 'tool_update', toolCallId: 'call-a', toolResult: 'late replay', runId: 'run-parallel' });
    expect(received).toHaveLength(eventCountAfterTerminalA);
    expect(bus.getStreamStatus(sessionKey)?.toolCalls?.[0]).toMatchObject({
      id: 'call-a',
      status: 'error',
      result: 'read failed',
    });

    bus.publish(sessionKey, {
      type: 'tool_end',
      toolName: 'exec',
      toolCallId: 'call-b',
      status: 'failed',
      toolResult: 'exit 1',
      runId: 'run-parallel',
    });
    status = bus.getStreamStatus(sessionKey);
    expect(status?.toolCalls?.[1]).toMatchObject({ id: 'call-b', status: 'error', result: 'exit 1' });
    expect(received.at(-1).turnEvent).toMatchObject({
      type: 'tool_output',
      runId: 'run-parallel',
      tool: { id: 'call-b', status: 'error', result: 'exit 1' },
    });
    expect(received
      .filter((event) => event.turnEvent?.type === 'tool_started' || event.turnEvent?.type === 'tool_output')
      .every((event) => event.turnEvent.runId === 'run-parallel')).toBe(true);
  });

  test('clears dormant prior-run reasoning, tools, and sequence before the next run', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:per-run-freshness';
    const received: any[] = [];

    bus.subscribe(sessionKey, (event) => received.push(event));
    bus.startStream(sessionKey, 'run-old');
    bus.publish(sessionKey, {
      type: 'thinking',
      content: 'Old private reasoning',
      runId: 'run-old',
    });
    bus.publish(sessionKey, {
      type: 'tool_start',
      toolName: 'read',
      toolCallId: 'old-tool',
      runId: 'run-old',
    });
    bus.publish(sessionKey, {
      type: 'tool_end',
      toolName: 'read',
      toolCallId: 'old-tool',
      toolResult: 'old result',
      runId: 'run-old',
    });
    expect(bus.getRecentTurnEvents(sessionKey)).toHaveLength(3);

    bus.softClearStream(sessionKey);
    expect(bus.getStreamStatus(sessionKey)).toBeNull();
    expect(bus.getRecentTurnEvents(sessionKey)).toHaveLength(3);

    expect(bus.adoptStreamRun(sessionKey, 'run-old', 'run-new')).toBe(true);
    expect(bus.resumeStream(sessionKey, 'run-new')).toBe(true);
    expect(bus.getRecentTurnEvents(sessionKey)).toEqual([]);
    expect(bus.getTrackedStream(sessionKey)).toMatchObject({
      active: true,
      runId: 'run-new',
      toolCalls: [],
    });

    bus.publish(sessionKey, {
      type: 'thinking',
      content: 'New reasoning',
      runId: 'run-new',
    });
    const recent = bus.getRecentTurnEvents(sessionKey);
    expect(recent).toEqual([
      expect.objectContaining({
        type: 'assistant_reasoning',
        runId: 'run-new',
        seq: 1,
        text: 'New reasoning',
      }),
    ]);
    expect(JSON.stringify(recent)).not.toMatch(/run-old|Old private reasoning|old-tool|old result/);
    expect(received.at(-1)?.turnEvent).toMatchObject({ runId: 'run-new', seq: 1 });
  });

  test('preserves partial latest text while the active run moves through tool and thinking phases', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:partial-text-phases';

    bus.startStream(sessionKey, 'run-phases');
    bus.publish(sessionKey, { type: 'text', content: 'Partial answer', runId: 'run-phases' });
    bus.updateStreamPhase(sessionKey, { phase: 'tool', toolName: 'exec', runId: 'run-phases' });
    bus.publish(sessionKey, {
      type: 'tool_start',
      toolName: 'exec',
      toolCallId: 'phase-tool',
      runId: 'run-phases',
    });

    expect(bus.getLatestText(sessionKey)).toBe('Partial answer');
    expect(bus.getTrackedStream(sessionKey)?.latestText).toBe('Partial answer');

    bus.publish(sessionKey, {
      type: 'tool_end',
      toolName: 'exec',
      toolCallId: 'phase-tool',
      toolResult: 'ok',
      runId: 'run-phases',
    });
    bus.updateStreamPhase(sessionKey, { phase: 'thinking', runId: 'run-phases' });

    expect(bus.getLatestText(sessionKey)).toBe('Partial answer');
    expect(bus.getTrackedStream(sessionKey)).toMatchObject({
      phase: 'thinking',
      latestText: 'Partial answer',
      runId: 'run-phases',
    });
  });

  test('coalesces cumulative reasoning snapshots in reconnect memory', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:reasoning-snapshot-test';

    bus.startStream(sessionKey, 'run-1');
    bus.publish(sessionKey, { type: 'thinking', content: 'Inspect', runId: 'run-1' });
    bus.publish(sessionKey, { type: 'thinking', content: 'Inspect the', runId: 'run-1', replace: true });
    bus.publish(sessionKey, { type: 'thinking', content: 'Inspect the file', runId: 'run-1', replace: true });

    expect(bus.getRecentTurnEvents(sessionKey)).toEqual([
      expect.objectContaining({
        type: 'assistant_reasoning',
        text: 'Inspect the file',
        replace: true,
        seq: 3,
      }),
    ]);
  });

  test('represents empty terminal events as turn_done instead of assistant_final', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:empty-final-test';
    const received: any[] = [];

    bus.subscribe(sessionKey, (event) => received.push(event));
    bus.startStream(sessionKey, 'run-empty');
    bus.publish(sessionKey, { type: 'done', content: '', runId: 'run-empty' });

    expect(received[0].turnEvent).toMatchObject({
      type: 'turn_done',
      visible: false,
      terminal: true,
      runId: 'run-empty',
    });
  });

  test('hard clear retires reconnect turn-event memory and sequence state', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:hard-clear-test';
    const received: any[] = [];

    bus.subscribe(sessionKey, (event) => received.push(event));
    bus.startStream(sessionKey, 'run-before-clear');
    bus.publish(sessionKey, { type: 'text', content: 'before', runId: 'run-before-clear' });
    expect(bus.getRecentTurnEvents(sessionKey)).toHaveLength(1);

    bus.clearStream(sessionKey);
    expect(bus.getRecentTurnEvents(sessionKey)).toEqual([]);

    bus.startStream(sessionKey, 'run-after-clear');
    bus.publish(sessionKey, { type: 'text', content: 'after', runId: 'run-after-clear' });
    expect(received.at(-1)?.turnEvent?.seq).toBe(1);
  });

  test('drops delayed events from a different logical run before snapshot or delivery', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:run-isolation-test';
    const received: any[] = [];

    bus.subscribe(sessionKey, (event) => received.push(event));
    bus.startStream(sessionKey, 'run-current');
    bus.publish(sessionKey, { type: 'text', content: 'current', runId: 'run-current' });
    bus.publish(sessionKey, { type: 'text', content: ' stale', runId: 'run-retired' });
    bus.publish(sessionKey, { type: 'done', content: 'stale terminal', runId: 'run-retired' });

    expect(received).toHaveLength(1);
    expect(bus.getLatestText(sessionKey)).toBe('current');
    expect(bus.getStreamStatus(sessionKey)).toMatchObject({
      active: true,
      runId: 'run-current',
      latestText: 'current',
    });
    expect(bus.getRecentTurnEvents(sessionKey)).toEqual([
      expect.objectContaining({ runId: 'run-current', text: 'current' }),
    ]);
  });

  test('strict start and phase updates cannot replace an identified run', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:strict-run-ownership';

    expect(bus.startStream(sessionKey, 'run-new')).toBe(true);
    expect(bus.updateStreamPhase(sessionKey, {
      phase: 'streaming',
      runId: 'run-new',
      model: 'model-new',
    })).toBe(true);

    expect(bus.startStream(sessionKey, 'run-old', { model: 'model-old' })).toBe(false);
    expect(bus.updateStreamPhase(sessionKey, {
      phase: 'tool',
      toolName: 'stale-tool',
      runId: 'run-old',
      model: 'model-old',
    })).toBe(false);
    expect(bus.startStream(sessionKey)).toBe(false);

    expect(bus.getTrackedStream(sessionKey)).toMatchObject({
      active: true,
      phase: 'streaming',
      runId: 'run-new',
      model: 'model-new',
      toolCalls: [],
    });
    expect(bus.getTrackedStream(sessionKey)?.toolName).toBeUndefined();
  });

  test('undefined and blank phase run IDs never erase an existing identity', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:undefined-run-assertion';

    expect(bus.startStream(sessionKey, 'run-current')).toBe(true);
    expect(bus.updateStreamPhase(sessionKey, {
      phase: 'streaming',
      runId: undefined,
    })).toBe(true);
    expect(bus.updateStreamPhase(sessionKey, {
      phase: 'thinking',
      runId: '   ',
    })).toBe(true);

    expect(bus.getTrackedStream(sessionKey)).toMatchObject({
      active: true,
      phase: 'thinking',
      runId: 'run-current',
    });
  });

  test('rejects id-less run-scoped events while an identified run is active', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:idless-run-events';
    const received: any[] = [];

    bus.subscribe(sessionKey, (event) => received.push(event));
    expect(bus.startStream(sessionKey, 'run-current')).toBe(true);

    bus.publish(sessionKey, { type: 'text', content: 'stale text' });
    bus.publish(sessionKey, { type: 'thinking', content: 'stale thought' });
    bus.publish(sessionKey, { type: 'tool_start', toolName: 'stale-tool' });
    bus.publish(sessionKey, { type: 'tool_update', toolName: 'stale-tool', toolResult: 'stale update' });
    bus.publish(sessionKey, { type: 'tool_end', toolName: 'stale-tool', toolResult: 'stale result' });
    bus.publish(sessionKey, { type: 'tool_used', toolName: 'stale-tool' });
    bus.publish(sessionKey, { type: 'status', content: 'Still working…' });
    bus.publish(sessionKey, { type: 'segment_break' });
    bus.publish(sessionKey, { type: 'exec_approval', content: 'stale approval' });
    bus.publish(sessionKey, { type: 'run_resumed' });
    bus.publish(sessionKey, { type: 'done', content: 'stale terminal' });
    bus.publish(sessionKey, { type: 'error', content: 'stale error' });

    expect(received).toEqual([]);
    expect(bus.getLatestText(sessionKey)).toBe('');
    expect(bus.getRecentTurnEvents(sessionKey)).toEqual([]);
    expect(bus.getTrackedStream(sessionKey)).toMatchObject({
      active: true,
      phase: 'thinking',
      runId: 'run-current',
      toolCalls: [],
      latestText: '',
    });
  });

  test('accepts id-less compaction and maintenance status as session-level events', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:session-level-events';
    const received: any[] = [];

    bus.subscribe(sessionKey, (event) => received.push(event));
    expect(bus.startStream(sessionKey, 'run-current')).toBe(true);
    bus.publish(sessionKey, {
      type: 'compaction_start',
      content: 'Compacting context…',
      maintenanceKind: 'compaction',
    });
    bus.publish(sessionKey, {
      type: 'status',
      content: 'Preparing context maintenance…',
      maintenanceKind: 'maintenance',
    });
    bus.publish(sessionKey, {
      type: 'compaction_end',
      content: 'Context compacted',
      completed: true,
      maintenanceKind: 'compaction',
    });
    bus.publish(sessionKey, {
      type: 'compaction_start',
      content: 'Stale compaction',
      maintenanceKind: 'compaction',
      runId: 'run-retired',
    });

    expect(received.map((event) => event.type)).toEqual([
      'compaction_start',
      'status',
      'compaction_end',
    ]);
    expect(bus.getTrackedStream(sessionKey)).toMatchObject({
      active: true,
      runId: 'run-current',
      compactionPhase: 'compacted',
    });
  });

  test('CAS adoption requires the exact predecessor and blocks stale terminal cleanup', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:cas-adoption';
    const received: any[] = [];

    bus.subscribe(sessionKey, (event) => received.push(event));
    expect(bus.startStream(sessionKey, 'run-old')).toBe(true);
    bus.publish(sessionKey, { type: 'text', content: 'partial', runId: 'run-old' });

    expect(bus.adoptStreamRun(sessionKey, 'wrong-predecessor', 'run-new')).toBe(false);
    expect(bus.adoptStreamRun(sessionKey, 'run-old', '   ')).toBe(false);
    expect(bus.getTrackedStream(sessionKey)?.runId).toBe('run-old');

    expect(bus.adoptStreamRun(sessionKey, 'run-old', 'run-new', {
      phase: 'thinking',
      model: 'model-new',
    })).toBe(true);
    bus.publish(sessionKey, { type: 'run_resumed', runId: 'run-new' });

    bus.publish(sessionKey, { type: 'done', content: 'stale terminal', runId: 'run-old' });
    expect(bus.softClearStream(sessionKey, 'run-old')).toBe(false);
    expect(bus.clearStream(sessionKey, 'run-old')).toBe(false);
    expect(bus.startStream(sessionKey, 'run-old')).toBe(false);
    expect(bus.updateStreamPhase(sessionKey, { phase: 'streaming', runId: 'run-old' })).toBe(false);

    expect(received.map((event) => event.type)).toEqual(['text', 'run_resumed']);
    expect(bus.getLatestText(sessionKey)).toBe('partial');
    expect(bus.getTrackedStream(sessionKey)).toMatchObject({
      active: true,
      phase: 'thinking',
      runId: 'run-new',
      model: 'model-new',
      latestText: 'partial',
    });
  });

  test('guarded dormant adoption keeps stale starts and cleanup fenced out', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:dormant-cas-adoption';
    const received: any[] = [];

    bus.subscribe(sessionKey, (event) => received.push(event));
    expect(bus.startStream(sessionKey, 'run-old')).toBe(true);
    expect(bus.softClearStream(sessionKey, 'run-old')).toBe(true);
    expect(bus.getTrackedStream(sessionKey)).toMatchObject({ active: false, runId: 'run-old' });

    expect(bus.updateStreamPhase(sessionKey, { phase: 'streaming' })).toBe(false);
    expect(bus.updateStreamPhase(sessionKey, { phase: 'streaming', runId: 'run-old' })).toBe(false);
    expect(bus.startStream(sessionKey, 'run-old')).toBe(false);
    bus.publish(sessionKey, { type: 'text', content: 'late same-run text', runId: 'run-old' });
    expect(bus.startStream(sessionKey, 'run-new')).toBe(false);
    expect(bus.adoptStreamRun(sessionKey, 'run-old', 'run-new')).toBe(true);
    expect(bus.getTrackedStream(sessionKey)).toMatchObject({ active: false, runId: 'run-new' });
    expect(bus.clearStream(sessionKey, 'run-old')).toBe(false);
    expect(bus.softClearStream(sessionKey, 'run-old')).toBe(false);
    expect(bus.startStream(sessionKey, 'run-old')).toBe(false);
    bus.publish(sessionKey, { type: 'done', content: 'stale old terminal', runId: 'run-old' });
    bus.publish(sessionKey, { type: 'done', content: 'stale id-less terminal' });
    expect(received).toEqual([]);
    expect(bus.getLatestText(sessionKey)).toBe('');

    expect(bus.resumeStream(sessionKey, 'run-new')).toBe(true);
    bus.publish(sessionKey, { type: 'text', content: 'new answer', runId: 'run-new' });
    expect(bus.getRecentTurnEvents(sessionKey)).toEqual([
      expect.objectContaining({ runId: 'run-new', seq: 1, text: 'new answer' }),
    ]);
  });
});
