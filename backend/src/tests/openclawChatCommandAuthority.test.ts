import { EventEmitter } from 'events';

// The Portal's chat transports connect as operator.admin, and
// OpenClaw runs commands and directives in chat text with that (owner)
// authority, so a USER's `/model <x> -g` wrote the host-wide default model.
// Only Owner/Admin senders keep command authority; every other message carries
// OpenClaw's suppressCommandInterpretation on each chat.send that carries user
// text (send, native steer, the sender-less helper) and reaches the model
// unchanged. The synthetic gateway records the frames exactly as sent.
jest.mock('../config/database', () => ({ prisma: {} }));
jest.mock('../utils/gatewayToken', () => ({ getGatewayToken: () => 'fixture-only', hasGatewayToken: () => true }));
jest.mock('../config/openclaw', () => ({ ...jest.requireActual('../config/openclaw'), getOpenClawWsUrl: () => 'ws://127.0.0.1:18789' }));
jest.mock('../utils/deviceIdentity', () => ({
  ...jest.requireActual('../utils/deviceIdentity'),
  getOrCreateDeviceKeys: () => ({}), buildSignedDevice: () => ({ id: 'fixture' }),
}));
jest.mock('../services/openClawExecutionAdmission', () => ({
  ...jest.requireActual('../services/openClawExecutionAdmission'),
  assertOpenClawDispatchNotDurablyBlocked: () => {},
}));
jest.mock('../services/portalWidgetTurnSocket', () => ({ openPortalWidgetTurnSocket: jest.fn() }));
const sent: any[] = [];
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  constructor() {
    super();
    setImmediate(() => {
      this.emit('open');
      this.receive({ type: 'event', event: 'connect.challenge', payload: { nonce: 'fixture-gateway-challenge-nonce', ts: Date.now() } });
    });
  }
  receive(frame: any) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
  send(data: string) {
    const frame = JSON.parse(data);
    sent.push(frame);
    setImmediate(() => this.receive({ type: 'res', id: frame.id, ok: true,
      payload: frame.method === 'connect'
        ? { server: { version: '2026.10.6' }, features: { methods: [] }, auth: { role: 'operator', scopes: ['operator.admin', 'operator.read', 'operator.write'] } }
        : { runId: 'fixture-run', status: 'started' } }));
  }
  close() {}
  ping() {}
  terminate() {}
}
jest.mock('ws', () => ({ __esModule: true, default: FakeSocket }));

import { observeOpenClawHello, clearOpenClawHello } from '../services/openClawCompatibility';
import {
  __persistentGatewayWsTest,
  initPersistentGatewayWs,
  shutdownPersistentGatewayWs,
  sendChatMessage,
  steerSessionMessage,
  steerSessionMessageWithRpc,
  steerWithNativeChatSendWithRpc,
} from '../agents/providers/PersistentGatewayWs';
import { openClawChatCommandsAllowed } from '../services/openclawChatCommandAuthority';
import { chatSend } from '../utils/openclawGatewayRpc';

const key = 'agent:main:portal-dddddddd-dddd-4ddd-8ddd-dddddddddddd';
// Every form OpenClaw would act on with owner authority: the global and agent
// scopes, the inline form inside a normal message, a configured /<alias>
// shorthand, owner-only commands and the host shell prefix. Plain text too.
const TEXTS = [
  '/model openai/gpt-6.1-sol -g',
  '/model openai/gpt-6.1-sol --agent',
  'Please summarize this file. /model openai/gpt-6.1-sol -g',
  '/opus --global',
  '/restart',
  '/config set agents.defaults.model.primary="openai/gpt-6.1-sol"',
  '! cat /etc/hostname',
  'An ordinary question with no command in it.',
];
const chatSendFrames = () => sent.filter((frame) => frame.method === 'chat.send');

describe('who may use OpenClaw chat commands', () => {
  it('is the Model Providers rule: Owner and Admin (SUB_ADMIN), nobody else, fail closed', () => {
    expect(openClawChatCommandsAllowed('OWNER')).toBe(true);
    expect(openClawChatCommandsAllowed('SUB_ADMIN')).toBe(true);
    for (const role of ['USER', 'VIEWER', 'ADMIN', 'owner', '', ' OWNER', undefined, null, 1, {}]) {
      expect(openClawChatCommandsAllowed(role)).toBe(false);
    }
  });
});

describe('chat.send carries the sender\'s command authority', () => {
  beforeAll(async () => {
    initPersistentGatewayWs();
    for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  });
  beforeEach(() => {
    sent.length = 0;
    observeOpenClawHello({ server: { version: '2026.10.6' }, features: { methods: [] } });
  });
  afterEach(() => { __persistentGatewayWsTest.resetSession(key); clearOpenClawHello(); });
  afterAll(() => shutdownPersistentGatewayWs());

  it.each(TEXTS)('a send without command authority is plain text, unchanged: %s', async (text) => {
    await sendChatMessage(key, text, `fixture-${sent.length}`, 'fixture-reservation');
    const [frame] = chatSendFrames();
    expect(frame.params.suppressCommandInterpretation).toBe(true);
    expect(frame.params.message).toBe(text);
  });

  it.each(TEXTS)('an Owner/Admin send keeps OpenClaw command handling: %s', async (text) => {
    await sendChatMessage(key, text, `fixture-${sent.length}`, 'fixture-reservation',
      undefined, [], false, undefined, undefined, true);
    const [frame] = chatSendFrames();
    expect(frame.params).not.toHaveProperty('suppressCommandInterpretation');
    expect(frame.params.message).toBe(text);
  });

  it.each(TEXTS)('a native steer (which may start a new turn) follows the same rule: %s', async (text) => {
    const calls: Array<Record<string, any>> = [];
    const rpc = jest.fn(async (_method: string, params: Record<string, any>) => {
      calls.push(params);
      return { runId: 'fixture-steer', status: 'started' };
    });
    await steerWithNativeChatSendWithRpc(rpc as any, key, 'fixture-request-1', text);
    await steerWithNativeChatSendWithRpc(rpc as any, key, 'fixture-request-2', text, true);
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['chat.send', 'chat.send']);
    expect(calls[0]).toEqual(expect.objectContaining({ message: text, queueMode: 'steer', suppressCommandInterpretation: true }));
    expect(calls[1]).toEqual(expect.objectContaining({ message: text, queueMode: 'steer' }));
    expect(calls[1]).not.toHaveProperty('suppressCommandInterpretation');
  });

  it('the steer dispatcher passes the authority to the stock chat.send fallback', async () => {
    const native = jest.fn(async () => ({ runId: 'fixture-steer', status: 'started' }));
    const exact = jest.fn();
    await steerSessionMessageWithRpc(exact as any, native as any, [], key, 'run-1', '/model openai/x -g', 'r-1');
    await steerSessionMessageWithRpc(exact as any, native as any, [], key, 'run-1', '/model openai/x -g', 'r-2', true);
    expect(exact).not.toHaveBeenCalled();
    const params = native.mock.calls.map((call: any[]) => call[1]);
    expect(params[0]).toEqual(expect.objectContaining({ suppressCommandInterpretation: true }));
    expect(params[1]).not.toHaveProperty('suppressCommandInterpretation');
  });

  it('the exact-run steer queues data into the attested run and carries no chat.send flags', async () => {
    const exact = jest.fn(async () => ({ accepted: true, code: 'STEERED', requestId: 'r-3', runId: 'run-1', replayed: false }));
    const native = jest.fn();
    await steerSessionMessageWithRpc(exact as any, native as any, ['bridgesllm.ask_user.steer'], key, 'run-1',
      '/model openai/x -g', 'r-3');
    expect(native).not.toHaveBeenCalled();
    expect(exact).toHaveBeenCalledWith('bridgesllm.ask_user.steer',
      expect.objectContaining({ sessionKey: key, expectedRunId: 'run-1', text: '/model openai/x -g' }), expect.any(Number));
  });

  it('steerSessionMessage hands the route\'s authority to the stock steer', async () => {
    await steerSessionMessage(key, 'run-1', '/model openai/x -g', 'r-4');
    await steerSessionMessage(key, 'run-1', '/model openai/x -g', 'r-5', true);
    const [plain, owner] = chatSendFrames();
    expect(plain.params).toEqual(expect.objectContaining({ queueMode: 'steer', suppressCommandInterpretation: true }));
    expect(owner.params).toEqual(expect.objectContaining({ queueMode: 'steer' }));
    expect(owner.params).not.toHaveProperty('suppressCommandInterpretation');
  });

  it('the sender-less chatSend helper always sends plain text', async () => {
    const result = await chatSend(key, '/model openai/gpt-6.1-sol -g', 'fixture-helper');
    expect(result.ok).toBe(true);
    const frame = chatSendFrames().at(-1);
    expect(frame.params).toEqual(expect.objectContaining({
      message: '/model openai/gpt-6.1-sol -g', suppressCommandInterpretation: true,
    }));
  });
});
