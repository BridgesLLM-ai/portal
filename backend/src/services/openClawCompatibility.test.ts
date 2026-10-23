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
    expect(capabilitiesFromHello({ server: { version: '2026.10.7' }, features: { methods: ['sessions.goal.update', 'sessions.goal.clear'] } }).supported).toBe(false);
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
