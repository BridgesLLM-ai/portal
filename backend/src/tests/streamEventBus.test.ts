import { StreamEventBus } from '../services/StreamEventBus';

describe('StreamEventBus', () => {
  test('keeps the tool phase and tool label while maintenance status updates arrive', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:main';

    bus.startStream(sessionKey, 'run-1');
    bus.updateStreamPhase(sessionKey, { phase: 'tool', toolName: 'exec' });
    bus.publish(sessionKey, { type: 'tool_start', toolName: 'exec', content: 'Using tool: exec' });

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
    });
    bus.publish(sessionKey, {
      type: 'status',
      content: 'I am moving from the tool result back into reasoning.',
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

  test('attaches normalized runtime turn events to outbound stream events', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:turn-event-test';
    const received: any[] = [];

    bus.subscribe(sessionKey, (event) => received.push(event));
    bus.startStream(sessionKey, 'run-1', { model: 'openai-codex/gpt-5.5', provenance: 'via OpenClaw' });
    bus.publish(sessionKey, { type: 'status', content: 'Preparing tools…' });
    bus.publish(sessionKey, { type: 'thinking', content: 'I should inspect the file.' });
    bus.publish(sessionKey, { type: 'tool_start', toolName: 'read', toolArgs: { path: 'README.md' } });
    bus.publish(sessionKey, { type: 'tool_end', toolName: 'read', toolResult: 'ok' });
    bus.publish(sessionKey, { type: 'text', content: 'Fixed.' });
    bus.publish(sessionKey, { type: 'done', content: 'Fixed.' });

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

  test('marks failed tool completions as runtime tool errors', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:failed-tool-test';
    const received: any[] = [];

    bus.subscribe(sessionKey, (event) => received.push(event));
    bus.startStream(sessionKey, 'run-1');
    bus.publish(sessionKey, { type: 'tool_start', toolName: 'bash', content: 'Using tool: bash' });
    bus.publish(sessionKey, {
      type: 'tool_end',
      toolName: 'bash',
      content: '❌ Tool failed: bash',
      toolResult: 'exit code 75',
      status: 'error',
    });

    const status = bus.getStreamStatus(sessionKey);
    expect(status?.toolCalls?.[0]?.status).toBe('error');
    expect(received[1].turnEvent).toMatchObject({
      type: 'tool_output',
      tool: { name: 'bash', status: 'error', result: 'exit code 75' },
    });
  });

  test('represents empty terminal events as turn_done instead of assistant_final', () => {
    const bus = new StreamEventBus();
    const sessionKey = 'agent:main:empty-final-test';
    const received: any[] = [];

    bus.subscribe(sessionKey, (event) => received.push(event));
    bus.startStream(sessionKey, 'run-empty');
    bus.publish(sessionKey, { type: 'done', content: '' });

    expect(received[0].turnEvent).toMatchObject({
      type: 'turn_done',
      visible: false,
      terminal: true,
      runId: 'run-empty',
    });
  });
});
