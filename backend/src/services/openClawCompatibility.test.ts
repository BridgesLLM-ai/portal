import { assembleChatSnapshot, capabilitiesFromHello, GatewayFrameFence } from './openClawCompatibility';

describe('OpenClaw 9.9 public transport compatibility', () => {
  test('assembles incremental text and honors an empty replacement', () => {
    let snapshot = assembleChatSnapshot('', { deltaText: 'Hello' }, '');
    snapshot = assembleChatSnapshot(snapshot, { deltaText: ' world' }, '');
    expect(snapshot).toBe('Hello world');
    expect(assembleChatSnapshot(snapshot, { deltaText: '', replace: true }, 'ignored')).toBe('');
    expect(assembleChatSnapshot(snapshot, {}, 'legacy cumulative')).toBe('legacy cumulative');
  });
  test('only advertises controls proved by the authenticated hello', () => {
    expect(capabilitiesFromHello({ server: { version: '2026.9.9' }, features: { methods: [] } }).goals).toBe(false);
    expect(capabilitiesFromHello({ server: { version: '2026.9.9' }, features: { methods: ['sessions.goal.update', 'sessions.goal.clear'] } }).goals).toBe(true);
  });
  test('admits any release at or above the floor and gates each feature on its own methods', () => {
    const allFeatures = ['sessions.goal.update', 'sessions.goal.clear', 'progressCard.get', 'canvas.document.view'];
    for (const version of ['2026.10.7', '2026.10.9', '2026.9.36', '2027.2.1']) {
      const caps = capabilitiesFromHello({ protocol: 4, server: { version }, features: { methods: allFeatures, events: ['chat'] } });
      expect(caps).toMatchObject({ supported: true, goals: true, progress: true, inlineWidgets: true, disabledReasons: {} });
    }
    const partial = capabilitiesFromHello({ server: { version: '2026.10.9' }, features: { methods: ['progressCard.get'] } });
    expect(partial).toMatchObject({ supported: true, goals: false, progress: true, inlineWidgets: false });
    expect(partial.disabledReasons.goals).toMatch(/does not expose sessions\.goal\.update, sessions\.goal\.clear/);
    expect(partial.disabledReasons.inlineWidgets).toMatch(/canvas\.document\.view/);
  });
  test('says why features are off below the floor or below a feature floor', () => {
    const old = capabilitiesFromHello({ server: { version: '2026.8.12' }, features: { methods: ['sessions.goal.update', 'sessions.goal.clear', 'progressCard.get'] } });
    expect(old).toMatchObject({ supported: false, goals: false, progress: false });
    expect(old.disabledReasons.goals).toMatch(/older than the supported floor 2026\.9\.1/);
    const earlyCanvas = capabilitiesFromHello({ server: { version: '2026.9.3' }, features: { methods: ['canvas.document.view'] } });
    expect(earlyCanvas.inlineWidgets).toBe(false);
    expect(earlyCanvas.disabledReasons.inlineWidgets).toMatch(/2026\.9\.9 or newer/);
    expect(capabilitiesFromHello(null).disabledReasons.goals).toMatch(/not connected/);
    // The retained 2026.7.1 contract stays supported; it simply has no goal methods.
    expect(capabilitiesFromHello({ server: { version: '2026.7.1' }, features: { methods: [] } })).toMatchObject({ supported: true, goals: false });
  });
  test('drops duplicate lane frames but never confuses independent runs or lanes', () => {
    const fence = new GatewayFrameFence();
    const frame = { sessionKey: 's', runId: 'r', seq: 2, stream: 'assistant' };
    expect(fence.accept('agent', frame)).toBe('accept');
    expect(fence.accept('agent', frame)).toBe('duplicate');
    expect(fence.accept('agent', { ...frame, stream: 'tool' })).toBe('accept');
    expect(fence.accept('agent', { ...frame, runId: 'new-run' })).toBe('accept');
    expect(fence.accept('agent', { ...frame, seq: 9 })).toBe('accept');
    fence.clear();
    expect(fence.accept('agent', frame)).toBe('accept');
  });
});
