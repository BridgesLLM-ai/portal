import { EventEmitter } from 'events';
jest.mock('../config/database', () => ({ prisma: {} }));
jest.mock('../utils/gatewayToken', () => ({ getGatewayToken: () => 'fixture-only' }));
jest.mock('../utils/deviceIdentity', () => ({
  ...jest.requireActual('../utils/deviceIdentity'),
  getOrCreateDeviceKeys: () => ({}), buildSignedDevice: () => ({ id: 'fixture' }),
}));
jest.mock('../services/openClawExecutionAdmission', () => ({
  assertOpenClawDispatchNotDurablyBlocked: () => {}, OpenClawExecutionAdmissionError: class extends Error {},
}));
jest.mock('../services/chatImages/chatImageModelPolicy', () => ({ ...jest.requireActual('../services/chatImages/chatImageModelPolicy'), assertOpenClawImageInput: jest.fn(async () => 'fixture/vision') }));
jest.mock('../services/portalWidgetTurnSocket', () => ({ openPortalWidgetTurnSocket: jest.fn() }));
const sent: any[] = [];
const sockets: FakeSocket[] = [];
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  constructor() { super(); sockets.push(this); setImmediate(() => {
    this.emit('open'); this.receive({ type: 'event', event: 'connect.challenge', payload: { nonce: 'fixture-long-enough-nonce', ts: Date.now() } });
  }); }
  receive(frame: any) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
  send(data: string) {
    const frame = JSON.parse(data); sent.push(frame);
    setImmediate(() => this.receive({ type: 'res', id: frame.id, ok: true,
      payload: frame.method === 'connect' ? { server: { version: '2026.9.9' }, features: { methods: ['canvas.document.view'] }, auth: { scopes: ['operator.questions', 'operator.write', 'operator.read', 'operator.admin'] } } : { sessions: [], runId: 'ordinary-run' } }));
  }
  close() {} ping() {}
}
jest.mock('ws', () => ({ __esModule: true, default: FakeSocket }));
import { assertOpenClawImageInput } from '../services/chatImages/chatImageModelPolicy';
import { openPortalWidgetTurnSocket } from '../services/portalWidgetTurnSocket';
import { consumePortalHostTurnAuthority, withPortalHostTurnAuthority } from '../services/portalHostTurnAuthority';
import { observeOpenClawHello, clearOpenClawHello } from '../services/openClawCompatibility';
import { streamEventBus, type StreamEvent } from '../services/StreamEventBus';
import { subscribeSessionWorkChanges } from '../services/openClawSessionWork';
import { __persistentGatewayWsTest, initPersistentGatewayWs, shutdownPersistentGatewayWs, sendChatMessage } from '../agents/providers/PersistentGatewayWs';
const key = 'agent:main:portal-dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const host: any = { id: 'fixture-journal', actorUserId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', actorAuthorizationVersion: 1,
  executionScope: 'HOST_OPERATOR', provider: 'OPENCLAW', sessionKey: key };
let receiveWidget: (event: string, payload: any) => void;
let widgetFrame: any;
let widgetRunId = 'owned-widget-run';
const closeWidget = jest.fn();
beforeAll(async () => {
  initPersistentGatewayWs();
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
});
beforeEach(() => {
  (assertOpenClawImageInput as jest.Mock).mockReset().mockResolvedValue('fixture/vision');
  (openPortalWidgetTurnSocket as jest.Mock).mockReset(); closeWidget.mockClear(); widgetFrame = undefined;
  (openPortalWidgetTurnSocket as jest.Mock).mockImplementation(async (sessionKey, receive) => {
    const current = consumePortalHostTurnAuthority(sessionKey); receiveWidget = receive;
    return { close: closeWidget, send(data: string) { current(); widgetFrame = JSON.parse(data);
      setImmediate(() => receive('response', { id: widgetFrame.id, ok: true, payload: { runId: widgetRunId } })); } };
  });
  observeOpenClawHello({ server: { version: '2026.9.9' }, features: { methods: ['canvas.document.view'] } });
});
afterEach(() => { __persistentGatewayWsTest.resetSession(key); clearOpenClawHello(); });
afterAll(() => shutdownPersistentGatewayWs());

test.each(['2026.9.9', '2026.10.5', '2026.10.6'])('dispatches the admitted originating turn and JPEG/widget/work projection on %s', async (version) => {
  widgetRunId = 'owned-widget-run-' + version;
  observeOpenClawHello({ server: { version }, features: { methods: ['canvas.document.view'] } });
  const events: StreamEvent[] = []; const work: any[] = [];
  const unsub = streamEventBus.subscribe(key, event => events.push(event));
  const unsubWork = subscribeSessionWorkChanges(event => work.push(event));
  const jpeg = await require('sharp')({ create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } } }).jpeg().toBuffer();
  const image: any = { type: 'image', mimeType: 'image/jpeg', content: jpeg.toString('base64'), fileName: 'fixture.jpg', origin: 'file', sizeBytes: 1, width: 1, height: 1 };
  try {
    await withPortalHostTurnAuthority(host, 'OWNER', () => sendChatMessage(key, 'widget', 'fixture-idempotency', widgetRunId, undefined, [image], true, 'fixture/vision', async () => {}));
    expect(widgetFrame.params.attachments).toEqual([{ type: image.type, mimeType: image.mimeType, content: image.content, fileName: image.fileName }]);
    expect(Buffer.from(widgetFrame.params.attachments[0].content, 'base64').subarray(0, 2)).toEqual(Buffer.from([255, 216]));
    expect(assertOpenClawImageInput).toHaveBeenCalledWith(key);
    expect(widgetFrame.params.sessionKey).toBe(key);
    expect(sent.filter(frame => frame.method === 'chat.send')).toHaveLength(0);
    expect(sent.find(frame => frame.method === 'connect').params.caps).not.toContain('inline-widgets');
    receiveWidget('agent', { sessionKey: key, runId: widgetRunId, seq: 1, stream: 'tool', data: {
      phase: 'result', name: 'show_widget', toolCallId: 'widget-tool', output: { kind: 'canvas', presentation: { target: 'assistant_message', sandbox: 'scripts', title: 'Example' }, view: { id: 'native-doc', url: '/__openclaw__/canvas/documents/native-doc/index.html' } },
    } });
    expect(events.find(event => event.type === 'tool_end')?.toolResult).toContain('bridgesllm.widget-ref.v1');
    receiveWidget('agent', { sessionKey: key, runId: widgetRunId, seq: 2, stream: 'tool', data: { phase: 'update', name: 'create_goal' } });
    expect(work).toEqual(expect.arrayContaining([expect.objectContaining({ sessionKey: key, parts: ['progress', 'goal', 'children'] })]));
    receiveWidget('chat', { sessionKey: key, runId: widgetRunId, state: 'final', message: { role: 'assistant', content: [{ type: 'text', text: 'Created' }] } });
    expect(closeWidget).toHaveBeenCalled();
  } finally { unsub(); unsubWork(); }
});
test('a flag without an admitted Host capability never dispatches chat', async () => {
  await expect(sendChatMessage(key, 'widget', 'unowned', 'unowned-run', undefined, [], true)).rejects.toThrow('authority');
  expect(widgetFrame).toBeUndefined();
});
test('a non-Canvas hello never opens an inline-capable turn socket', async () => {
  observeOpenClawHello({ server: { version: '2026.9.3' }, features: { methods: [] } });
  await sendChatMessage(key, 'ordinary', 'legacy', 'ordinary-run', undefined, [], true);
  expect(openPortalWidgetTurnSocket).not.toHaveBeenCalled();
});

test('images fail closed without fresh authority or model support, and a retry revalidates before its one socket write', async () => {
  const image: any = { type: 'image', mimeType: 'image/jpeg', content: '/9j/fixture', fileName: 'photo.jpg', width: 1, height: 1, sizeBytes: 3 };
  const before = sent.filter(frame => frame.method === 'chat.send').length;
  await expect(sendChatMessage(key, 'photo', 'missing', 'missing-run', undefined, [image])).rejects.toThrow('IMAGE_AUTHORITY_REQUIRED');
  const revalidate = jest.fn(async () => {});
  (assertOpenClawImageInput as jest.Mock).mockRejectedValueOnce(new Error('IMAGE_MODEL_UNSUPPORTED'));
  await expect(sendChatMessage(key, 'photo', 'unsupported', 'unsupported-run', undefined, [image], false, 'fixture/vision', revalidate)).rejects.toThrow('IMAGE_MODEL_UNSUPPORTED');
  expect(sent.filter(frame => frame.method === 'chat.send')).toHaveLength(before);
  await sendChatMessage(key, 'photo', 'retry', 'ordinary-run', undefined, [image], false, 'fixture/vision', revalidate);
  expect(revalidate).toHaveBeenCalledTimes(1);
  expect(sent.filter(frame => frame.method === 'chat.send')).toHaveLength(before + 1);
  const final = sent.filter(frame => frame.method === 'chat.send').at(-1);
  expect(Object.keys(final.params.attachments[0]).sort()).toEqual(['content','fileName','mimeType','type']);
});


test('custody refusal prevents a write and retry reruns the final revalidation after model attestation', async () => {
  const image: any = { type: 'image', mimeType: 'image/jpeg', content: '/9j/fixture', fileName: 'photo.jpg', width: 1, height: 1, sizeBytes: 3 };
  const before = sent.filter(frame => frame.method === 'chat.send').length;
  const checks: string[] = [];
  (assertOpenClawImageInput as jest.Mock).mockImplementation(async () => {
    checks.push('model');
    return 'fixture/vision';
  });
  const revalidate = jest.fn(async () => {
    checks.push('custody');
    expect(sent.filter(frame => frame.method === 'chat.send')).toHaveLength(before);
    if (checks.length === 2) throw new Error('IMAGE_ACTOR_DENIED');
  });
  await expect(sendChatMessage(key, 'photo', 'custody-retry', 'custody-first-attempt', undefined, [image], false, 'fixture/vision', revalidate)).rejects.toThrow('IMAGE_ACTOR_DENIED');
  expect(sent.filter(frame => frame.method === 'chat.send')).toHaveLength(before);
  await sendChatMessage(key, 'photo', 'custody-retry', 'ordinary-run', undefined, [image], false, 'fixture/vision', revalidate);
  expect(revalidate).toHaveBeenCalledTimes(2);
  expect(checks).toEqual(['model', 'custody', 'model', 'custody']);
  expect(sent.filter(frame => frame.method === 'chat.send')).toHaveLength(before + 1);
});

test('a changed exact model rejects images before dispatch or custody revalidation', async () => {
  const image: any = { type: 'image', mimeType: 'image/jpeg', content: '/9j/fixture', fileName: 'photo.jpg', width: 1, height: 1, sizeBytes: 3 };
  const before = sent.filter(frame => frame.method === 'chat.send').length;
  const revalidate = jest.fn(async () => {});
  (assertOpenClawImageInput as jest.Mock).mockResolvedValueOnce('fixture/different-vision');
  await expect(sendChatMessage(key, 'photo', 'changed-model', 'ordinary-run', undefined, [image], false, 'fixture/vision', revalidate)).rejects.toThrow('IMAGE_MODEL_CHANGED');
  expect(revalidate).not.toHaveBeenCalled();
  expect(sent.filter(frame => frame.method === 'chat.send')).toHaveLength(before);
});
