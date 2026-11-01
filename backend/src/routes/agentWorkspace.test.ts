import { EventEmitter } from 'events';
jest.mock('../middleware/auth', () => ({ authenticateToken: (req: any, res: any, next: any) => req.user ? next() : res.status(401).json({}) }));
jest.mock('../utils/openclawGatewayRpc', () => ({ gatewayRpcCall: jest.fn() }));
import { createAgentWorkspaceRouter, openClawBrowserServiceAvailable } from './agentWorkspace';

const KEY = 'agent:main:portal-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actor = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'OWNER', accountStatus: 'ACTIVE' };
function harness(available = true) {
  const authorize = jest.fn(async (key: string) => { if (key !== KEY) throw Error('foreign'); });
  const rpc = jest.fn(async (): Promise<any> => ({ ok: true, data: { running: true, tabs: [
    { targetId: 'T1', title: 'Docs', url: 'https://example.com/', type: 'page' },
    { targetId: 'bad id', title: 'x', url: 'https://example.com/' },
    { targetId: 'W1', title: 'worker', url: '', type: 'service_worker' },
  ] } }));
  const router = createAgentWorkspaceRouter(authorize, rpc as any, () => available);
  async function request(path: string, user: any = actor) {
    const req: any = { url: path, originalUrl: path, method: 'GET', user, body: {}, headers: {}, query: Object.fromEntries(new URLSearchParams(path.split('?')[1] || '')) };
    const res: any = new EventEmitter(); res.statusCode = 200; res.headers = {};
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.set = (name: string, value: string) => { res.headers[name] = value; return res; };
    await new Promise<void>((resolve, reject) => {
      res.json = (data: any) => { res.body = data; resolve(); return res; };
      (router as any).handle(req, res, (error: any) => error ? reject(error) : reject(Error('unhandled route')));
    });
    return res;
  }
  return { request, authorize, rpc };
}

test.each(['USER', 'VIEWER'])('role %s cannot read the agent browser', async role => {
  const h = harness();
  expect((await h.request(`/sessions/${encodeURIComponent(KEY)}/browser/tabs`, { ...actor, role })).statusCode).toBe(403);
  expect(h.authorize).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
});
test('a foreign session is indistinguishable from a missing one, with no native read', async () => {
  const h = harness();
  const res = await h.request(`/sessions/${encodeURIComponent('agent:main:portal-other')}/browser/tabs`);
  expect(res.statusCode).toBe(404); expect(h.rpc).not.toHaveBeenCalled();
});
test('an invalid profile is refused before authorization or RPC', async () => {
  const h = harness();
  expect((await h.request(`/sessions/${encodeURIComponent(KEY)}/browser/tabs?profile=..%2Fx`)).statusCode).toBe(400);
  expect(h.authorize).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
});
test('a Gateway without the browser service reports that honestly', async () => {
  const h = harness(false);
  const res = await h.request(`/sessions/${encodeURIComponent(KEY)}/browser/tabs`);
  expect(res.statusCode).toBe(503); expect(res.body.code).toBe('BROWSER_UNSUPPORTED'); expect(h.rpc).not.toHaveBeenCalled();
});
test('tabs are owner-checked, page-only and bounded', async () => {
  const h = harness();
  const res = await h.request(`/sessions/${encodeURIComponent(KEY)}/browser/tabs?profile=openclaw`);
  expect(res.statusCode).toBe(200); expect(res.headers['Cache-Control']).toBe('private, no-store');
  expect(res.body).toEqual({ profile: 'openclaw', running: true, tabs: [{ targetId: 'T1', title: 'Docs', url: 'https://example.com/' }] });
  expect(h.rpc).toHaveBeenCalledWith('browser.request', { method: 'GET', path: '/tabs', query: { profile: 'openclaw' }, timeoutMs: 8000 }, 10_000);
});
test('browser availability follows the Gateway hello methods', () => {
  expect(openClawBrowserServiceAvailable(['chat.send', 'browser.request'])).toBe(true);
  expect(openClawBrowserServiceAvailable(['chat.send'])).toBe(false);
});

describe('widget policy diagnostic', () => {
  const path = `/sessions/${encodeURIComponent(KEY)}/widget-policy`;
  test('reports what hides the display tools, reading native config only', async () => {
    const h = harness();
    h.rpc.mockResolvedValueOnce({ ok: true, data: { hash: 'h', config: { tools: { deny: ['canvas'] },
      agents: { entries: { main: { tools: { allow: ['read', 'group:agents'] } } } } } } });
    const res = await h.request(path);
    expect(res.body).toEqual({ checked: true, agentId: 'main', findings: [
      { tool: 'show_widget', kind: 'deny', setting: 'tools.deny', entry: 'canvas' },
    ] });
    expect(h.rpc.mock.calls.map((call: any[]) => call[0])).toEqual(['config.get']);
  });
  test('claims nothing when the configuration cannot be read, and hides foreign chats', async () => {
    const h = harness();
    h.rpc.mockResolvedValueOnce({ ok: false, error: 'busy' });
    expect((await h.request(path)).body).toEqual({ checked: false, findings: [] });
    const foreign = await h.request(`/sessions/${encodeURIComponent('agent:main:portal-other')}/widget-policy`);
    expect(foreign.statusCode).toBe(404); expect(h.rpc).toHaveBeenCalledTimes(1);
  });
});
