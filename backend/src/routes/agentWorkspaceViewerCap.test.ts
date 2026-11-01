import { EventEmitter } from 'events';

// The viewer cap is pure bookkeeping around the upgrade; every collaborator
// that would reach a database, a Gateway or a real socket is replaced.
const mockClients = new Set<EventEmitter>();
jest.mock('ws', () => ({
  WebSocketServer: jest.fn().mockImplementation(() => ({
    clients: mockClients,
    handleUpgrade: (_req: unknown, _socket: unknown, _head: unknown, callback: (client: EventEmitter) => void) => {
      const { EventEmitter: Emitter } = jest.requireActual('events');
      const client: EventEmitter = new Emitter();
      mockClients.add(client);
      client.once('close', () => mockClients.delete(client));
      callback(client);
    },
  })),
}));
jest.mock('../config/openclaw', () => ({ getOpenClawWsUrl: () => 'ws://127.0.0.1:18789' }));
jest.mock('../middleware/auth', () => ({ authenticateToken: jest.fn() }));
jest.mock('../middleware/requireAdmin', () => ({ requireAdmin: jest.fn() }));
jest.mock('../middleware/requireApproved', () => ({ requireApproved: jest.fn() }));
jest.mock('../utils/jwt', () => ({ verifyAccessToken: () => ({ userId: 'owner-1', role: 'OWNER' }) }));
jest.mock('../utils/safeCookies', () => ({ parseSafeCookieHeader: () => ({ accessToken: 'token' }) }));
jest.mock('../utils/websocketOrigin', () => ({ isAllowedWebSocketOrigin: () => true }));
jest.mock('../utils/authz', () => ({ isOwnerRole: () => true }));
jest.mock('../utils/openclawGatewayRpc', () => ({ gatewayRpcCall: jest.fn() }));
jest.mock('../services/openClawCompatibility', () => ({ getOpenClawCapabilities: () => ({ methods: ['browser.request'] }) }));
jest.mock('../services/agentWorkspaceBrowserRelay', () => ({ relayAgentWorkspaceBrowser: jest.fn() }));
const mockTransportAuthorizations: Array<(ok: boolean) => void> = [];
jest.mock('../services/portalTransportAuthorization', () => ({
  authorizeAgentBrowserWebSocketTransport: () => new Promise((resolve) => {
    mockTransportAuthorizations.push((ok) => resolve(ok
      ? { ok: true, identity: { userId: 'owner-1', role: 'OWNER' }, dispose: () => undefined }
      : { ok: false, reason: 'forbidden' }));
  }),
  // Same contract as the real helper: every failure destroys the socket.
  completeAuthorizedWebSocketUpgrade: (input: any) => {
    void input.authorize(() => input.socket.destroy()).then((result: any) => {
      if (!result.ok || input.socket.destroyed) { input.socket.destroy(); return; }
      input.onAuthorized(result);
    });
  },
}));

import type { Server } from 'http';
import { AGENT_WORKSPACE_BROWSER_STREAM_PATH, attachAgentWorkspaceBrowserStream } from './agentWorkspace';

class FakeSocket extends EventEmitter {
  destroyed = false;
  write(): boolean { return true; }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    process.nextTick(() => this.emit('close'));
  }
}

const flush = async () => { for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve)); };

function setup(mint: () => Promise<{ ok: boolean; data?: any }>) {
  const server = new EventEmitter();
  const rpc = jest.fn(async () => mint());
  const handle = attachAgentWorkspaceBrowserStream(server as unknown as Server, async () => undefined, rpc as any);
  const upgrade = () => {
    const socket = new FakeSocket();
    server.emit('upgrade', {
      url: `${AGENT_WORKSPACE_BROWSER_STREAM_PATH}?session=agent%3Amain%3Aportal-1&target=tab-1`,
      headers: { cookie: 'accessToken=token', origin: 'https://portal.example', host: 'portal.example' },
    }, socket, Buffer.alloc(0));
    return socket;
  };
  return { handle, upgrade };
}

describe('agent browser viewer cap', () => {
  beforeEach(() => { mockClients.clear(); mockTransportAuthorizations.length = 0; });

  test('counts upgrades still being authorized, so ten simultaneous viewers admit only eight', async () => {
    const { handle, upgrade } = setup(async () => ({ ok: true, data: { wsPath: '/browser/screencast?token=abc' } }));
    const sockets = Array.from({ length: 10 }, upgrade);
    expect(sockets.filter((socket) => socket.destroyed)).toHaveLength(2);
    expect(handle.viewerLoad()).toEqual({ connected: 0, pending: 8 });

    for (const approve of mockTransportAuthorizations) approve(true);
    await flush();
    expect(handle.viewerLoad()).toEqual({ connected: 8, pending: 0 });
    expect(upgrade().destroyed).toBe(true);

    for (const client of [...mockClients]) client.emit('close');
    await flush();
    expect(handle.viewerLoad()).toEqual({ connected: 0, pending: 0 });
  });

  test('releases each reservation exactly once on denial, failed screencast and early close', async () => {
    let mints = 0;
    const { handle, upgrade } = setup(async () => (++mints <= 2 ? { ok: false } : { ok: true, data: { wsPath: '/browser/screencast?token=abc' } }));
    const sockets = Array.from({ length: 8 }, upgrade);
    expect(handle.viewerLoad().pending).toBe(8);

    sockets[7].destroy(); // the browser gave up while authorization was pending
    await flush();
    expect(handle.viewerLoad().pending).toBe(7);

    mockTransportAuthorizations.forEach((settle, index) => settle(index >= 3)); // three denials
    await flush();
    // Two of the five authorized viewers fail to mint a screencast; the closed one never connects.
    expect(handle.viewerLoad()).toEqual({ connected: 2, pending: 0 });
    sockets[7].emit('close'); // a duplicate close must not release twice
    expect(handle.viewerLoad().pending).toBe(0);

    const late = upgrade();
    expect(late.destroyed).toBe(false);
    expect(handle.viewerLoad().pending).toBe(1);
  });
});
