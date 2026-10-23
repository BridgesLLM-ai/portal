jest.mock('../utils/websocketOrigin', () => ({ isAllowedWebSocketOrigin: () => true }));
jest.mock('../middleware/auth', () => ({ authenticateToken: (_req: any, _res: any, next: any) => next() }));
jest.mock('./gateway', () => ({ assertExistingGatewaySessionAccess: jest.fn(async () => {}) }));
jest.mock('./agentBrowser', () => ({ fetchCdpTargets: jest.fn(async () => []), captureScreenshotFromTarget: jest.fn() }));
jest.mock('../services/sharedBrowserBroker', () => ({ sharedBrowserEnabled: () => true, sharedBrowserRuntimeReady: () => true,
  sharedBrowserOwnerId: () => '00000000-0000-0000-0000-000000000001', startSharedBrowserBroker: jest.fn() }));
jest.mock('../services/accessTokenAuthorization', () => ({ authorizeAccessTokenPayload: jest.fn() }));
jest.mock('../services/portalTransportAuthorization', () => ({ authorizeAgentBrowserWebSocketTransport: jest.fn(), completeAuthorizedWebSocketUpgrade: jest.fn() }));
jest.mock('../utils/jwt', () => ({ verifyAccessToken: jest.fn() }));
import router, { authorizeSharedBrowserCaller } from './sharedBrowser';
import { sharedInteractiveBrowser as browser } from '../services/sharedInteractiveBrowser';
import { authorizeAccessTokenPayload } from '../services/accessTokenAuthorization';
import { assertExistingGatewaySessionAccess } from './gateway';
const owner = '00000000-0000-0000-0000-000000000001';
const foreign = '00000000-0000-0000-0000-000000000002';
const key = 'agent:alpha:portal-' + owner + '-chat';
const identity = { userId: owner, role: 'OWNER', authorizationVersion: 1 };
async function route(path: string, body: any, user = identity) {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path);
  const response: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json(value: any) { this.body = value; return this; } };
  await layer.route.stack[0].handle({ body, user }, response);
  return response;
}
beforeEach(() => { (authorizeAccessTokenPayload as jest.Mock).mockResolvedValue({ ok: true, identity }); });
afterEach(() => {
  const lease = browser.snapshot(owner);
  if (lease) browser.control(owner, lease.revision, 'release');
  jest.clearAllMocks();
});
test('wrong user namespace and Project keys are denied before upstream access or claim', async () => {
  for (const sessionKey of ['agent:alpha:portal-' + foreign, 'project:example', key + ':project:x']) {
    expect((await route('/select', { sessionKey })).statusCode).toBe(404);
  }
  expect(assertExistingGatewaySessionAccess).not.toHaveBeenCalled(); expect(browser.snapshot(owner)).toBeNull();
});
test('owned selection checks access; foreign OWNER and stale buttons cannot control it', async () => {
  const response = await route('/select', { sessionKey: key }); expect(response.statusCode).toBe(200);
  expect(assertExistingGatewaySessionAccess).toHaveBeenCalledWith(key, identity);
  expect((await route('/control', { revision: response.body.lease.revision, action: 'return' }, { ...identity, userId: foreign })).statusCode).toBe(404);
  expect((await route('/control', { revision: response.body.lease.revision - 1, action: 'return' })).statusCode).toBe(409);
  expect(browser.humanCanConnect(owner)).toBe(true);
});
test('broker rechecks live selection authority and never confers control after revocation', async () => {
  await route('/select', { sessionKey: key });
  (authorizeAccessTokenPayload as jest.Mock).mockResolvedValue({ ok: true, identity });
  await authorizeSharedBrowserCaller({ sessionKey: key, agentId: 'alpha' });
  (authorizeAccessTokenPayload as jest.Mock).mockResolvedValue({ ok: false, reason: 'session_revoked' });
  await expect(authorizeSharedBrowserCaller({ sessionKey: key, agentId: 'alpha' })).rejects.toThrow('revoked');
  expect(browser.humanCanConnect(owner)).toBe(false);
});

test('persistent browser owner gate excludes another admin even when no lease exists', () => {
  const gate = (router as any).stack.find((entry: any, index: number) => index > 0 && !entry.route).handle;
  const response: any = { setHeader: jest.fn(), status(code: number) { this.statusCode = code; return this; }, json: jest.fn() };
  const next = jest.fn();
  gate({ user: { ...identity, userId: foreign } }, response, next);
  expect(response.statusCode).toBe(404); expect(next).not.toHaveBeenCalled();
  gate({ user: identity }, response, next); expect(next).toHaveBeenCalledTimes(1);
});

test('selection cannot be granted after authority is revoked during upstream access', async () => {
  (assertExistingGatewaySessionAccess as jest.Mock).mockImplementationOnce(async () => {
    (authorizeAccessTokenPayload as jest.Mock).mockResolvedValue({ ok: false, reason: 'session_revoked' });
  });
  expect((await route('/select', { sessionKey: key })).statusCode).toBe(403);
  expect(browser.snapshot(owner)).toBeNull();
});

test('preview is not delivered when selection is released during asynchronous capture', async () => {
  await route('/select', { sessionKey: key });
  const preview = require('./agentBrowser');
  preview.fetchCdpTargets.mockResolvedValueOnce([{ id: 'page' }]);
  preview.captureScreenshotFromTarget.mockImplementationOnce(async () => {
    browser.control(owner, browser.snapshot(owner)!.revision, 'release');
    return Buffer.from('private-preview');
  });
  const handler = (router as any).stack.find((entry: any) => entry.route?.path === '/screenshot/:targetId').route.stack[0].handle;
  const response: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; },
    json: jest.fn(), type: jest.fn().mockReturnThis(), send: jest.fn() };
  await handler({ user: identity, params: { targetId: 'page' } }, response);
  expect(response.statusCode).toBe(404); expect(response.send).not.toHaveBeenCalled();
});
