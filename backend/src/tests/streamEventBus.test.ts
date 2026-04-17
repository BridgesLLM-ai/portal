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
});
