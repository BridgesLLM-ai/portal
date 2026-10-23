jest.mock('./portalHostTurnAuthority', () => ({ consumePortalHostTurnAuthority: jest.fn(() => () => {}) }));
import { EventEmitter } from 'events';
const sockets: FakeSocket[] = [];
class FakeSocket extends EventEmitter {
  sent: any[] = []; close = jest.fn(() => {});
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(frame: any) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
}
jest.mock('ws', () => ({ __esModule: true, default: jest.fn(() => { const s = new FakeSocket(); sockets.push(s); return s; }) }));
jest.mock('../utils/appContentSecurity', () => ({ configuredPortalOrigin: jest.fn(() => 'https://portal.example:4001') }));
import { configuredPortalOrigin } from '../utils/appContentSecurity';
import WebSocket from 'ws';
jest.mock('../utils/gatewayToken', () => ({ getGatewayToken: () => 'fixture-only' }));
jest.mock('../utils/deviceIdentity', () => ({ getOrCreateDeviceKeys: () => ({}), buildSignedDevice: () => ({ id: 'fixture' }), validateGatewayChallenge: (value: any) => value }));
import { consumePortalHostTurnAuthority } from './portalHostTurnAuthority';
import { openPortalWidgetTurnSocket, portalWidgetBridgeOrigin } from './portalWidgetTurnSocket';
const hello = { server: { version: '2026.9.9' }, features: { methods: ['chat.send', 'canvas.document.view'] } };
async function connect(key = 'agent:main:portal-owned') {
  const onEvent = jest.fn(); const pending = openPortalWidgetTurnSocket(key, onEvent);
  const ws = sockets[sockets.length - 1]; ws.receive({ type: 'event', event: 'connect.challenge', payload: { nonce: 'fixture-nonce', ts: Date.now() } });
  ws.receive({ type: 'res', id: ws.sent[0].id, ok: true, payload: hello });
  return { socket: await pending, ws, onEvent };
}
describe('Portal per-owned-turn inline capability transport', () => {
  test('missing admitted Host capability refuses before constructing a native socket', async () => {
    const count=sockets.length;
    (consumePortalHostTurnAuthority as jest.Mock).mockImplementationOnce(()=>{throw Error('not admitted');});
    await expect(openPortalWidgetTurnSocket('agent:main:portal-owned',jest.fn())).rejects.toThrow('not admitted');
    expect(sockets).toHaveLength(count);
  });
  test('capability exists only on a one-dispatch webchat socket, not generic RPC; foreign events and repeated dispatch denied', async () => {
    const { socket, ws, onEvent } = await connect();
    expect(WebSocket).toHaveBeenLastCalledWith('ws://localhost:18789', { maxPayload: 12 * 1024 * 1024, origin: 'http://localhost:18789' });
    expect(ws.sent[0].params.caps).toEqual(['tool-events', 'inline-widgets']);
    expect(ws.sent[0].params.client.id).toBe('webchat');
    expect(ws.sent[0].params.scopes).toEqual(['operator.admin', 'operator.read', 'operator.write', 'operator.questions']);
    expect(() => socket.send(JSON.stringify({ method: 'canvas.document.view', params: { docId: 'foreign' } }))).toThrow('scope mismatch');
    expect(() => socket.send(JSON.stringify({ method: 'chat.send', params: { sessionKey: 'agent:main:foreign' } }))).toThrow('scope mismatch');
    socket.send(JSON.stringify({ id: 'dispatch-owned', method: 'chat.send', params: { sessionKey: 'agent:main:portal-owned' } }));
    ws.receive({ type: 'event', event: 'agent', payload: { sessionKey: 'agent:main:foreign' } });
    expect(onEvent).not.toHaveBeenCalled();
    ws.receive({ type: 'event', event: 'agent', payload: { sessionKey: 'agent:main:portal-owned', stream: 'tool' } });
    ws.receive({ type: 'res', id: 'dispatch-owned', ok: true, payload: { runId: 'run-owned' } });
    expect(onEvent.mock.calls.map(call => call[0])).toEqual(['agent', 'response']);
    expect(() => socket.send(JSON.stringify({ method: 'chat.send', params: { sessionKey: 'agent:main:portal-owned' } }))).toThrow();
    socket.close(); expect(ws.close).toHaveBeenCalled();
  });
  test('wrong pin/missing method refuse before any turn is dispatched; no capless or singleton fallback', async () => {
    for (const payload of [{ ...hello, server: { version: '2026.9.6' } }, { ...hello, features: { methods: ['chat.send'] } }]) {
      const pending = openPortalWidgetTurnSocket('agent:main:portal-owned', jest.fn()); const ws = sockets[sockets.length - 1];
      ws.receive({ type: 'event', event: 'connect.challenge', payload: { nonce: 'fixture', ts: Date.now() } });
      ws.receive({ type: 'res', id: ws.sent[0].id, ok: true, payload });
      await expect(pending).rejects.toThrow('qualified'); expect(ws.sent).toHaveLength(1); expect(ws.close).toHaveBeenCalled();
    }
  });
});

describe('Portal bridge origin and truthful handshake errors', () => {
  test.each([
    ['ws://localhost:18789', 'http://localhost:18789'],
    ['ws://127.0.0.1:18789/', 'http://127.0.0.1:18789'],
    ['wss://[::1]:18789/gateway', 'https://[::1]:18789'],
  ])('local endpoint %s retains the Gateway origin and explicit port', (url, origin) => {
    expect(portalWidgetBridgeOrigin(url)).toBe(origin);
  });
  test('remote and lookalike hosts use only the configured Portal origin, never fabricate a local origin', () => {
    for (const url of ['wss://gateway.example:18789', 'ws://localhost.attacker.example:18789', 'ws://10.0.0.4:18789'])
      expect(portalWidgetBridgeOrigin(url)).toBe('https://portal.example:4001');
    (configuredPortalOrigin as jest.Mock).mockReturnValueOnce(undefined);
    expect(() => portalWidgetBridgeOrigin('wss://gateway.example')).toThrow('configured Portal origin');
  });
  test.each(['http://localhost:18789', 'ws://user:secret@localhost:18789', 'not a URL'])('refuses invalid endpoint %s', url => {
    expect(() => portalWidgetBridgeOrigin(url)).toThrow();
  });
  test.each([
    ['CONTROL_UI_ORIGIN_NOT_ALLOWED', 'Gateway rejected the Portal widget connection origin'],
    ['PAIRING_REQUIRED', 'Gateway requires pairing for the Portal widget connection'],
    ['AUTH_TOKEN_MISMATCH', 'Gateway rejected the Portal widget connection'],
  ])('retains the rejection category %s without exposing upstream text or sending chat', async (code, expected) => {
    const pending = openPortalWidgetTurnSocket('agent:main:portal-owned', jest.fn());
    const ws = sockets[sockets.length - 1];
    ws.receive({ type: 'event', event: 'connect.challenge', payload: { nonce: 'fixture', ts: Date.now() } });
    ws.receive({ type: 'res', id: ws.sent[0].id, ok: false, error: { message: 'secret upstream text', details: { code } } });
    await expect(pending).rejects.toThrow(expected);
    expect(ws.sent).toHaveLength(1); expect(ws.close).toHaveBeenCalled();
  });
});
