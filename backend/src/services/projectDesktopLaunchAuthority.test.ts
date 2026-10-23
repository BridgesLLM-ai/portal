/** Durable authority at the Desktop host launch and the detached worker lease. Filesystem, child processes and the
 * desktop launcher are in-memory mocks; no host unit, process or file is touched. */
const tree = new Map<string, string>();
const events: Array<{ event: string; aborted?: boolean; where?: string }> = [];
const host = { running: true, revokeAt: null as null | 'old-unit-stop' | 'account-lookup', controller: new AbortController(), revoked: false };
const RUNTIME = '/virtual/desktop-projects/review-project';
const PREVIOUS = '11111111-1111-4111-8111-111111111111';
const descriptor = { version: 1, target: 'desktop', language: 'cpp', interface: 'gui', framework: 'qt', binary: 'app' };
const receipt = { version: 1, descriptor, executable: '.desktop-out/application', args: [], node: false, libraryPath: null, qtPluginPath: null };

function revoke(where: string) {
  if (host.revoked) return;
  host.revoked = true; host.controller.abort(); events.push({ event: 'session-revoked', where });
}
jest.mock('fs', () => {
  const stat = { uid: 0, mode: 0o755, isDirectory: () => true, isSymbolicLink: () => false };
  const move = (from: string, to: string) => {
    for (const key of [...tree.keys()]) if (key === from || key.startsWith(from + '/')) { tree.set(to + key.slice(from.length), tree.get(key)!); tree.delete(key); }
  };
  const rm = async (target: string) => { for (const key of [...tree.keys()]) if (key === target || key.startsWith(target + '/')) tree.delete(key); };
  const api = {
    existsSync: (p: string) => tree.has(p), mkdirSync: (p: string) => { tree.set(p, 'directory'); },
    lstatSync: () => stat, realpathSync: (p: string) => p, chownSync: () => undefined, chmodSync: () => undefined,
    writeFileSync: (p: string, data: string) => { tree.set(p, String(data)); }, renameSync: move,
    unlinkSync: (p: string) => { tree.delete(p); },
    promises: { realpath: async (p: string) => p, readdir: async () => [], mkdir: async (p: string) => { tree.set(p, 'directory'); }, rm },
  };
  return { __esModule: true, default: api, ...api };
});
jest.mock('child_process', () => ({
  execFile: (command: string, args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    let stdout = '';
    if (command === '/usr/bin/id') { if (host.revokeAt === 'account-lookup') revoke('account-lookup'); stdout = '1001\n'; }
    else if (command === '/usr/bin/systemctl' && args[0] === 'stop') {
      events.push({ event: 'unit-stop', aborted: host.controller.signal.aborted });
      if (host.revokeAt === 'old-unit-stop') revoke('old-unit-stop');
      host.running = false;
    } else if (command === '/usr/bin/systemctl' && args[0] === 'show') {
      stdout = `LoadState=loaded\nActiveState=${host.running ? 'active' : 'inactive'}\nMainPID=${host.running ? 100 : 0}\nExecMainStatus=0\n`;
    } else throw new Error('Unexpected host call ' + command);
    queueMicrotask(() => callback(null, { stdout, stderr: '' }));
  },
}));
jest.mock('../utils/desktopEnv', () => ({
  getDesktopEnvVars: () => ({}),
  desktopExecDetachedArgv: () => { host.running = true; events.push({ event: 'HOST-LAUNCH', aborted: host.controller.signal.aborted }); },
}));
jest.mock('./projectDesktopRuntime', () => ({
  PROJECT_DESKTOP_RUNTIME_ROOT: '/virtual/desktop-projects', ensureSecureProjectDesktopRuntimeRoot: () => undefined,
  buildProjectDesktopRuntimeIdentity: () => ({ runtimeDir: RUNTIME, systemdUnit: 'bridgesllm-project-review.service', processMarker: 'review', windowTitle: 'review' }),
}));
jest.mock('./projectDesktopBuild', () => ({ readDesktopBuildReceipt: () => receipt }));
jest.mock('./projectDesktopContract', () => ({ parseDesktopProjectDescriptor: (value: unknown) => value }));
jest.mock('./projectSurfacePolicy', () => ({
  readProjectTextFile: (root: string, name: string) => { const value = tree.get(root + '/' + name); return value === undefined || value === 'directory' ? null : value; },
}));

jest.mock('../config/database', () => ({ prisma: {} }));

import fs from 'fs';
import { DesktopLaunchCancelledError, promoteDesktopBuild, startDesktopProject } from './projectDesktopDeployment';
import { durableDesktopDispatchGate } from './projectDesktopLaunchAuthority';
import { acquireWorkspaceAuthorizationMutationLease, closeWorkspaceAuthorizationAdmission } from './workspaceAuthorizationBarrier';

type Db = { session: boolean; role: string; abortDuring?: boolean };
const NOW = new Date('2026-10-23T04:00:00Z');
function database(db: Db) {
  return { $transaction: async (work: (tx: any) => Promise<unknown>) => {
    events.push({ event: 'locks-acquired' });
    const tx = { $queryRaw: async (query: any) => {
      const text = (query.strings || []).join('?');
      if (text.includes('FROM "User"')) return [{ id: 'owner', email: 'o@example.test', role: db.role, accountStatus: 'ACTIVE', isActive: true, sandboxEnabled: false, authorizationVersion: 1, databaseNow: NOW }];
      if (db.abortDuring) revoke('during-commit');
      return db.session ? [{ id: 'session-1', expiresAt: new Date(NOW.getTime() + 3_600_000) }] : [];
    } };
    try { return await work(tx); } finally { events.push({ event: 'locks-released' }); }
  } } as any;
}
const payload = (exp = Math.floor(NOW.getTime() / 1000) + 600) => ({ userId: 'owner', sid: 'session-1', sessionId: 'session-1', authorizationVersion: 1, exp } as any);
const gate = (db: Db, exp?: number) => durableDesktopDispatchGate({ payload: payload(exp), signal: host.controller.signal, onDenied: () => host.controller.abort(), database: database(db) });
const launches = () => events.filter(item => item.event === 'HOST-LAUNCH');

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  tree.clear(); events.length = 0;
  Object.assign(host, { running: false, revokeAt: null, controller: new AbortController(), revoked: false });
  tree.set(RUNTIME, 'directory'); tree.set(RUNTIME + '/generations', 'directory'); tree.set(RUNTIME + '/generations/' + PREVIOUS, 'directory');
  tree.set(RUNTIME + '/deployment.json', JSON.stringify({ version: 1, projectId: 'review-project', generation: PREVIOUS, previousGeneration: null, sourceDigest: 'a'.repeat(64), builtAt: '2026-10-23T00:00:00Z', receipt }));
});
afterEach(() => jest.useRealTimers());
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false; promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 50 && !done; i++) { await Promise.resolve(); await jest.advanceTimersByTimeAsync(800); }
  return promise;
}
const start = (dispatch: any) => settle(startDesktopProject('review-project', 'Review', { signal: host.controller.signal, dispatch }));

describe('durable Desktop dispatch', () => {
  it('launches a valid Start exactly once while the durable User/Session locks are held', async () => {
    await start(gate({ session: true, role: 'OWNER' }));
    expect(events.map(item => item.event)).toEqual(['locks-acquired', 'HOST-LAUNCH', 'locks-released']);
  });
  it.each([
    ['a deleted Session', { session: false, role: 'OWNER' }, undefined],
    ['an expired token', { session: true, role: 'OWNER' }, Math.floor(NOW.getTime() / 1000) - 1],
    ['a demoted account', { session: true, role: 'USER' }, undefined],
    ['revocation or fence delivered inside the commit', { session: true, role: 'OWNER', abortDuring: true }, undefined],
  ] as const)('never calls the launcher for %s', async (_label, db, exp) => {
    await expect(start(gate(db as Db, exp))).rejects.toBeInstanceOf(DesktopLaunchCancelledError);
    expect(launches()).toEqual([]);
    expect(host.controller.signal.aborted).toBe(true);
  });
  it('refuses promotion and its rollback restart when the Session was deleted before dispatch', async () => {
    host.running = true;
    const persist = jest.fn(async () => undefined), beforePromotion = jest.fn(async () => undefined);
    const error: any = await settle(promoteDesktopBuild({ projectId: 'review-project', projectName: 'Review', workspace: '/virtual/build', receipt: receipt as any,
      signal: host.controller.signal, dispatch: gate({ session: false, role: 'OWNER' }), beforePromotion, persist })).catch(value => value);
    expect(error).toBeInstanceOf(DesktopLaunchCancelledError);
    expect(error.previousDeploymentRetained).toBe(true);
    expect(beforePromotion).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
    expect(launches()).toEqual([]);
    expect(JSON.parse(tree.get(RUNTIME + '/deployment.json')!).generation).toBe(PREVIOUS);
  });
});

describe('detached Desktop worker lease', () => {
  it('keeps the authorization fence waiting until the worker releases its lease', async () => {
    jest.useRealTimers();
    const release = acquireWorkspaceAuthorizationMutationLease('lease-owner');
    const fence = closeWorkspaceAuthorizationAdmission(['lease-owner']);
    await expect(fence.waitForMutationDrain(30)).rejects.toThrow();
    expect(() => acquireWorkspaceAuthorizationMutationLease('lease-owner')).toThrow(/authorization is changing/);
    release();
    await expect(fence.waitForMutationDrain(30)).resolves.toBeUndefined();
    fence.release();
  });
  it('acquires the lease before any 202 and releases it in the worker finally', () => {
    const routes: string = jest.requireActual('fs').readFileSync(require('path').join(__dirname, '../routes/projects.ts'), 'utf8');
    for (const [begin, settled] of [
      ["action: 'check', controller });", 'held?.(); releaseWorkerLease?.(); }'],
      ["action: 'deploy', controller });", 'workspace?.cleanup(); releaseWorkerLease?.(); }'],
    ]) {
      const at = routes.indexOf(begin);
      const lease = routes.lastIndexOf('releaseWorkerLease = acquireWorkspaceAuthorizationMutationLease(req.user!.userId);', at);
      const accepted = routes.indexOf('res.status(202).json({ desktopJob: job })', at);
      expect(at).toBeGreaterThan(0);
      expect(lease).toBeGreaterThan(at - 1500);
      expect(accepted).toBeGreaterThan(at);
      expect(routes.indexOf(settled, at)).toBeGreaterThan(accepted);
    }
    expect(routes.match(/dispatch: durableDesktopDispatchGate\(/g)).toHaveLength(2);
    void fs;
  });
});
