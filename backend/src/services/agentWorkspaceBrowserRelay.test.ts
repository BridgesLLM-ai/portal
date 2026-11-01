import { once } from 'events';
import WebSocket, { WebSocketServer } from 'ws';
jest.mock('../utils/openclawGatewayRpc', () => ({ gatewayRpcCall: jest.fn() }));
jest.mock('./workspaceAuthorizationBarrier', () => ({ acquireWorkspaceAuthorizationMutationLease: jest.fn(() => () => undefined) }));
import { BROWSER_RELAY_CLOSE, relayAgentWorkspaceBrowser } from './agentWorkspaceBrowserRelay';
const header = { url: 'https://example.com/', cssWidth: 1920, cssHeight: 1080 };
const message = (ws: WebSocket, predicate: (v: any) => boolean) => new Promise<any>((resolve, reject) => {
  const timer = setTimeout(() => { ws.off('message', handler); reject(Error('message timeout')); }, 3000);
  const handler = (data: any, binary: boolean) => { if (!binary) { const v = JSON.parse(data.toString()); if (predicate(v)) { clearTimeout(timer); ws.off('message', handler); resolve(v); } } };
  ws.on('message', handler);
});
const nextFrame = (ws: WebSocket) => new Promise<void>((resolve) => { const h = (_data: any, binary: boolean) => { if (binary) { ws.off('message', h); resolve(); } }; ws.on('message', h); });
const action = (id: number, extra: any = {}) => ({ type: 'input', id, url: header.url, action: 'click', x: 0.5, y: 0.25, ...extra });

describe('real WebSocket browser relay', () => {
  let native: WebSocketServer, portal: WebSocketServer, clients: WebSocket[], upstreamInput: number;
  let rpc: jest.Mock, authorize: jest.Mock, inputAllowed: boolean;
  beforeEach(async () => {
    clients = []; upstreamInput = 0; inputAllowed = true;
    rpc = jest.fn(async (_method, params) => ({ ok: true, data: params.path === '/tabs' ? [{ targetId: 'test-tab', url: header.url }] : {} }));
    authorize = jest.fn(async () => {});
    native = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(native, 'listening');
    const nativeUrl = `ws://127.0.0.1:${(native.address() as any).port}`;
    native.on('connection', ws => {
      ws.on('message', () => { upstreamInput++; });
      const json = Buffer.from(JSON.stringify(header)); const data = Buffer.alloc(json.length + 7); data.writeUInt32BE(json.length); json.copy(data, 4);
      ws.send(data, { binary: true });
    });
    portal = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(portal, 'listening');
    portal.on('connection', ws => relayAgentWorkspaceBrowser(ws, nativeUrl, { target: 'test-tab', profile: 'openclaw', authorize, userId: 'test-owner', inputAllowed }, rpc as any));
  });
  afterEach(async () => {
    clients.forEach(ws => ws.terminate()); portal.clients.forEach(ws => ws.terminate()); native.clients.forEach(ws => ws.terminate());
    await Promise.all([new Promise<void>(resolve => portal.close(() => resolve())), new Promise<void>(resolve => native.close(() => resolve()))]);
  });
  const connect = async () => { const ws = new WebSocket(`ws://127.0.0.1:${(portal.address() as any).port}`); clients.push(ws); const frame = nextFrame(ws); await once(ws, 'open'); await frame; return ws; };
  const enable = async (ws: WebSocket) => { const response = message(ws, m => m.type === 'control'); ws.send(JSON.stringify({ type: 'control', enabled: true })); return response; };
  const send = async (ws: WebSocket, input: any) => { const response = message(ws, m => m.type === 'input' && m.id === input.id); ws.send(JSON.stringify(input)); return response; };

  it('requires opt-in, binds native target/profile, checks current URL and never forwards viewer data to the screencast', async () => {
    const ws = await connect(); expect((await send(ws, action(1))).ok).toBe(false); expect(rpc).not.toHaveBeenCalled();
    expect((await enable(ws)).enabled).toBe(true);
    expect((await send(ws, action(2))).ok).toBe(true);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenLastCalledWith('browser.request', expect.objectContaining({ path: '/act', body: { kind: 'clickCoords', x: 960, y: 270, button: 'left', doubleClick: false, targetId: 'test-tab', profile: 'openclaw' } }), 10000);
    expect(upstreamInput).toBe(0);
  });
  it('prevents two simultaneous Portal controllers, and allows deliberate handoff', async () => {
    const a = await connect(), b = await connect(); expect((await enable(a)).enabled).toBe(true); expect((await enable(b)).enabled).toBe(false);
    const released = message(a, m => m.type === 'control' && !m.enabled); a.send(JSON.stringify({ type: 'control', enabled: false })); await released;
    expect((await enable(b)).enabled).toBe(true); expect((await send(a, action(1))).ok).toBe(false); expect((await send(b, action(2))).ok).toBe(true);
  });
  it('fails closed on a changed page and authorization loss without echoing private data', async () => {
    const ws = await connect(); await enable(ws);
    rpc.mockResolvedValueOnce({ ok: true, data: [{ targetId: 'test-tab', url: 'https://different.test/' }] });
    expect((await send(ws, { type: 'input', id: 1, url: header.url, action: 'text', text: 'private-text' })).ok).toBe(false);
    expect(rpc.mock.calls.every(c => c[1].path !== '/act')).toBe(true);
    await enable(ws); authorize.mockRejectedValueOnce(Error('private-auth-secret'));
    const response = await send(ws, action(2)); expect(response.ok).toBe(false); expect(JSON.stringify(response)).not.toContain('private');
    expect(rpc.mock.calls.every(c => c[1].path !== '/act')).toBe(true);
  });
  it('lets a non-owner watch but never act in the host-wide managed browser', async () => {
    inputAllowed = false;
    const ws = await connect();
    const refused = await enable(ws);
    expect(refused.enabled).toBe(false);
    expect(refused.message).toContain('Portal owner');
    expect((await send(ws, action(1))).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled(); expect(upstreamInput).toBe(0);
  });
  it('rejects arbitrary control payloads and closes the viewer', async () => {
    const ws = await connect(); const closed = once(ws, 'close');
    ws.send(JSON.stringify(action(1, { action: 'evaluate', fn: 'evil()' })));
    expect((await closed)[0]).toBe(BROWSER_RELAY_CLOSE.invalidInput.code); expect(rpc).not.toHaveBeenCalled(); expect(upstreamInput).toBe(0);
  });
  it('gives every reason the relay ends a live view its own close code', async () => {
    expect(new Set(Object.values(BROWSER_RELAY_CLOSE).map(close => close.code)).size).toBe(Object.keys(BROWSER_RELAY_CLOSE).length);
    for (const { code } of Object.values(BROWSER_RELAY_CLOSE)) expect([4003, 4004, 4005, 4006]).not.toContain(code);
  });
  it('closes with its own codes for an input it cannot use and for too many inputs', async () => {
    const binary = await connect(); const binaryClosed = once(binary, 'close');
    binary.send(Buffer.from([1, 2, 3]), { binary: true });
    const [binaryCode, binaryReason] = await binaryClosed;
    expect([binaryCode, binaryReason.toString()]).toEqual([4400, 'invalid_input']);

    const busy = await connect(); const busyClosed = once(busy, 'close');
    for (let i = 0; i < 81; i += 1) busy.send(JSON.stringify({ type: 'control', enabled: false }));
    const [busyCode, busyReason] = await busyClosed;
    expect([busyCode, busyReason.toString()]).toEqual([4429, 'input_rate_limit']);
    expect(upstreamInput).toBe(0);
  });
  it.each([
    ['tab closed passes through', 4004, 'target_closed', 4004, 'target_closed'],
    ['blocked page passes through', 4003, 'navigation_blocked', 4003, 'navigation_blocked'],
    ['the native authority ended', 4006, 'authority_revoked', 4410, 'session_ended'],
    ['live view unsupported', 4005, 'unsupported', 4503, 'browser_unavailable'],
    ['an unknown native code', 4099, 'something new', 4503, 'browser_unavailable'],
    ['a normal native close', 1000, 'bye', 4503, 'browser_unavailable'],
    ['a native server error', 1011, 'internal', 4503, 'browser_unavailable'],
  ])('maps the native screencast ending (%s)', async (_label, nativeCode, nativeReason, code, reason) => {
    const ws = await connect(); const closed = once(ws, 'close');
    native.clients.forEach(upstream => upstream.close(nativeCode as number, nativeReason as string));
    const [closedCode, closedReason] = await closed;
    expect([closedCode, closedReason.toString()]).toEqual([code, reason]);
  });
  it('a native stream that drops without a close says the browser is unavailable', async () => {
    const ws = await connect(); const closed = once(ws, 'close');
    native.clients.forEach(upstream => upstream.terminate());
    const [closedCode, closedReason] = await closed;
    expect([closedCode, closedReason.toString()]).toEqual([4503, 'browser_unavailable']);
  });
});
