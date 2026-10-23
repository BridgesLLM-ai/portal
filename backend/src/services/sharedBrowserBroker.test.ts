import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { Server } from 'http';

const owner = '00000000-0000-0000-0000-000000000001';
const caller = { agentId: 'alpha', sessionKey: `agent:alpha:portal-${owner}-chat`, runId: 'run', toolCallId: 'call' };
let root: string;
let server: Server | null;
let runtime: typeof import('./sharedBrowserBroker');
let browser: typeof import('./sharedInteractiveBrowser')['sharedInteractiveBrowser'];
beforeEach(() => {
  jest.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-browser-broker-'));
  fs.mkdirSync(path.join(root, 'broker'), { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'owner'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'owner/profile-owner.json'), JSON.stringify(owner), { mode: 0o600 });
  jest.doMock('./sharedInteractiveBrowser', () => ({ ...jest.requireActual('./sharedInteractiveBrowser'),
    SHARED_BROWSER_SOCKET: path.join(root, 'broker/broker.sock'), SHARED_BROWSER_OWNER_DIR: path.join(root, 'owner') }));
  process.env.SHARED_INTERACTIVE_BROWSER_ENABLED = '1';
  process.env.SHARED_INTERACTIVE_BROWSER_OWNER_ID = owner;
  runtime = require('./sharedBrowserBroker');
  browser = require('./sharedInteractiveBrowser').sharedInteractiveBrowser;
  server = null;
});
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  delete process.env.SHARED_INTERACTIVE_BROWSER_ENABLED;
  delete process.env.SHARED_INTERACTIVE_BROWSER_OWNER_ID;
  fs.rmSync(root, { recursive: true, force: true });
});
function post(action: string, who = caller): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: path.join(root, 'broker/broker.sock'), path: '/v1/browser', method: 'POST' }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode!));
    });
    request.on('error', reject); request.end(JSON.stringify({ action, caller: who }));
  });
}
test('real private HTTP socket drains an admitted action before takeover and denies revocation', async () => {
  server = await runtime.startSharedBrowserBroker(async who => { browser.ownsCaller(who); });
  expect(fs.statSync(path.join(root, 'broker/broker.sock')).mode & 0o777).toBe(0o600);
  browser.select(owner, caller.sessionKey, caller.agentId);
  expect(await post('begin')).toBe(409);
  browser.control(owner, browser.snapshot(owner)!.revision, 'return');
  expect(await post('begin')).toBe(200);
  expect(fs.existsSync(path.join(root, 'broker/inflight.json'))).toBe(true);
  browser.control(owner, browser.snapshot(owner)!.revision, 'take');
  expect(browser.humanCanConnect(owner)).toBe(false);
  expect(await post('finish', { ...caller, toolCallId: 'wrong' })).toBe(403);
  expect(await post('finish')).toBe(200);
  expect(browser.humanCanConnect(owner)).toBe(true);
  expect(fs.existsSync(path.join(root, 'broker/inflight.json'))).toBe(false);
  browser.revoke(owner);
  expect(await post('begin')).toBe(403);
});
test('runtime never creates or transfers a persistent profile-owner pin', async () => {
  const pin = path.join(root, 'owner/profile-owner.json');
  fs.unlinkSync(pin);
  await expect(runtime.startSharedBrowserBroker(async () => {})).rejects.toThrow('not been explicitly commissioned');
  expect(fs.existsSync(pin)).toBe(false);
  fs.writeFileSync(pin, JSON.stringify('00000000-0000-0000-0000-000000000002'), { mode: 0o600 });
  await expect(runtime.startSharedBrowserBroker(async () => {})).rejects.toThrow('owner differs');
});
test('opt-in is inert by default; unsafe broker custody is refused', async () => {
  delete process.env.SHARED_INTERACTIVE_BROWSER_ENABLED;
  expect(await runtime.startSharedBrowserBroker(async () => {})).toBeNull();
  process.env.SHARED_INTERACTIVE_BROWSER_ENABLED = '1';
  fs.chmodSync(path.join(root, 'broker'), 0o755);
  await expect(runtime.startSharedBrowserBroker(async () => {})).rejects.toThrow('0700');
});
