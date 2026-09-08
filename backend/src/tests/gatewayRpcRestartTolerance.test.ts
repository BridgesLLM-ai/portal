import { EventEmitter } from 'events';

type SocketScript = 'refuse' | 'serve' | 'drop-after-dispatch' | 'reject';

const socketScripts: SocketScript[] = [];
const socketsOpened: string[] = [];
const sentFrames: Array<Record<string, any>> = [];
let grantedScopes = ['operator.admin', 'operator.read'];

class FakeGatewaySocket extends EventEmitter {
  private readonly script: SocketScript;

  constructor(url: string) {
    super();
    socketsOpened.push(url);
    this.script = socketScripts.shift() || 'serve';
    setImmediate(() => this.run());
  }

  private run(): void {
    if (this.script === 'refuse') {
      this.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:18789'));
      return;
    }
    this.emit('open');
    this.emit('message', Buffer.from(JSON.stringify({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'test-nonce' },
    })));
  }

  send(raw: string): void {
    const frame = JSON.parse(raw);
    sentFrames.push(frame);
    if (frame.method === 'connect') {
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({
        type: 'res',
        id: frame.id,
        ok: true,
        payload: { auth: { role: 'operator', scopes: [...grantedScopes] } },
      }))));
      return;
    }
    setImmediate(() => {
      if (this.script === 'drop-after-dispatch') {
        this.emit('close');
        return;
      }
      if (this.script === 'reject') {
        this.emit('message', Buffer.from(JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'config.patch rejected agents.list',
          },
        })));
        return;
      }
      this.emit('message', Buffer.from(JSON.stringify({
        type: 'res', id: frame.id, ok: true, payload: { sessions: [] },
      })));
    });
  }

  close(): void {}
}

jest.mock('ws', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((url: string) => new FakeGatewaySocket(url)),
}));
jest.mock('../config/openclaw', () => ({ getOpenClawWsUrl: () => 'ws://127.0.0.1:18789' }));
jest.mock('../utils/gatewayToken', () => ({ getGatewayToken: () => 'test-token', hasGatewayToken: () => true }));
jest.mock('../utils/deviceIdentity', () => ({
  getOrCreateDeviceKeys: () => ({ publicKey: 'pk', privateKey: 'sk' }),
  buildSignedDevice: () => ({ id: 'device', signature: 'sig' }),
}));
jest.mock('../utils/openclawCli', () => ({ ensureOpenClawModelDeclaration: jest.fn() }));
jest.mock('../agents/providers/PersistentGatewayWs', () => ({
  isConnected: () => false,
  callGatewayRpc: jest.fn(),
}));

const { gatewayRpcCall } = require('../utils/openclawGatewayRpc') as
  typeof import('../utils/openclawGatewayRpc');

describe('gateway RPC tolerance for a restarting gateway', () => {
  beforeEach(() => {
    socketScripts.length = 0;
    socketsOpened.length = 0;
    sentFrames.length = 0;
    grantedScopes = ['operator.admin', 'operator.read'];
    jest.useRealTimers();
  });

  test('a refused connection is retried until the gateway comes back', async () => {
    socketScripts.push('refuse', 'refuse', 'serve');
    const result = await gatewayRpcCall('sessions.list', { agentId: 'main' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ sessions: [] });
    expect(socketsOpened).toHaveLength(3);
  }, 20000);

  test('a gateway that never comes back reports the restart clearly', async () => {
    for (let index = 0; index < 12; index += 1) socketScripts.push('refuse');
    const result = await gatewayRpcCall('sessions.list', { agentId: 'main' });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/gateway is restarting/i);
    expect(String(result.error)).toMatch(/ECONNREFUSED/);
  }, 30000);

  test('a call already dispatched to the gateway is never repeated', async () => {
    socketScripts.push('drop-after-dispatch');
    const result = await gatewayRpcCall('chat.send', { message: 'hello' });
    expect(result.ok).toBe(false);
    expect(socketsOpened).toHaveLength(1);
  }, 20000);

  test('a healthy gateway is answered on the first connection', async () => {
    socketScripts.push('serve');
    const result = await gatewayRpcCall('sessions.list', { agentId: 'main' });
    expect(result.ok).toBe(true);
    expect(socketsOpened).toHaveLength(1);
  }, 20000);

  test('retains the gateway errorCode and errorMessage from a rejected method', async () => {
    socketScripts.push('reject');
    const result = await gatewayRpcCall('config.patch', { raw: '{}', baseHash: 'hash' });
    expect(result).toMatchObject({
      ok: false,
      error: 'config.patch rejected agents.list',
      errorCode: 'INVALID_REQUEST',
      errorMessage: 'config.patch rejected agents.list',
    });
    expect(socketsOpened).toHaveLength(1);
  }, 20000);

  test('2026.7.1 may drop the unknown question scope while ordinary RPC still connects', async () => {
    socketScripts.push('serve');
    grantedScopes = ['operator.admin', 'operator.read'];

    const result = await gatewayRpcCall('sessions.list', { agentId: 'main' });

    expect(result.ok).toBe(true);
    const connect = sentFrames.find((frame) => frame.method === 'connect');
    expect(connect?.params?.scopes).toEqual(expect.arrayContaining([
      'operator.admin',
      'operator.read',
      'operator.questions',
    ]));
    expect(sentFrames.some((frame) => frame.method === 'sessions.list')).toBe(true);
  }, 20000);

  test('refuses native question RPC when the Gateway did not grant operator.questions', async () => {
    socketScripts.push('serve');
    grantedScopes = ['operator.admin', 'operator.read'];

    const result = await gatewayRpcCall('question.list', {});

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'FORBIDDEN',
    });
    expect(String(result.error)).toContain('operator.questions');
    expect(sentFrames.some((frame) => frame.method === 'question.list')).toBe(false);
  }, 20000);

  test('dispatches native question RPC only after 2026.9.1 grants operator.questions', async () => {
    socketScripts.push('serve');
    grantedScopes = ['operator.admin', 'operator.read', 'operator.questions'];

    const result = await gatewayRpcCall('question.list', {});

    expect(result.ok).toBe(true);
    expect(sentFrames.some((frame) => frame.method === 'question.list')).toBe(true);
  }, 20000);
});
