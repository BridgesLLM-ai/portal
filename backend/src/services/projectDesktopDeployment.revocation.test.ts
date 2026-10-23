/** Revocation at Desktop launch boundaries. Filesystem, child processes and the
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

import { DesktopLaunchCancelledError, promoteDesktopBuild, startDesktopProject } from './projectDesktopDeployment';

const deployed = () => JSON.parse(tree.get(RUNTIME + '/deployment.json') || '{}').generation;
const launches = () => events.filter(item => item.event === 'HOST-LAUNCH');

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  tree.clear(); events.length = 0;
  Object.assign(host, { running: true, revokeAt: null, controller: new AbortController(), revoked: false });
  tree.set(RUNTIME, 'directory'); tree.set(RUNTIME + '/generations', 'directory'); tree.set(RUNTIME + '/generations/' + PREVIOUS, 'directory');
  tree.set(RUNTIME + '/deployment.json', JSON.stringify({ version: 1, projectId: 'review-project', generation: PREVIOUS, previousGeneration: null, sourceDigest: 'a'.repeat(64), builtAt: '2026-10-23T00:00:00Z', receipt }));
});
afterEach(() => jest.useRealTimers());

async function settle<T>(promise: Promise<T>): Promise<T> {
  // The post-launch observation waits 750 ms; advance fake time until the call settles.
  let done = false; promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 50 && !done; i++) { await Promise.resolve(); await jest.advanceTimersByTimeAsync(800); }
  return promise;
}
function promote(persist = async () => undefined) {
  return settle(promoteDesktopBuild({ projectId: 'review-project', projectName: 'Review', workspace: '/virtual/build', receipt: receipt as any,
    signal: host.controller.signal, beforePromotion: async () => undefined, persist }));
}

describe('Desktop launch revocation', () => {
  it.each(['old-unit-stop', 'account-lookup'] as const)('never launches after revocation during %s and keeps the previous deployment', async (where) => {
    host.revokeAt = where;
    const persist = jest.fn(async () => undefined);
    const error: any = await promote(persist).catch(value => value);
    expect(error).toBeInstanceOf(DesktopLaunchCancelledError);
    expect(error.statusCode).toBe(403);
    expect(error.previousDeploymentRetained).toBe(true);
    expect(launches()).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    expect(deployed()).toBe(PREVIOUS);
  });

  it('launches a valid, unrevoked promotion exactly once and records the new generation', async () => {
    const persist = jest.fn(async () => undefined);
    const result = await promote(persist);
    expect(launches()).toEqual([{ event: 'HOST-LAUNCH', aborted: false }]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.deployment.generation).not.toBe(PREVIOUS);
    expect(deployed()).toBe(result.deployment.generation);
  });

  it('rolls back to the previous deployment and restarts it only for a still-authorized caller', async () => {
    const error: any = await promote(async () => { throw new Error('persist failed after launch'); }).catch(value => value);
    expect(error.message).toBe('persist failed after launch');
    expect(error.previousDeploymentRetained).toBe(true);
    expect(deployed()).toBe(PREVIOUS);
    expect(launches()).toEqual([{ event: 'HOST-LAUNCH', aborted: false }, { event: 'HOST-LAUNCH', aborted: false }]);
  });

  it('does not restart the previous app when authority ends during the rollback restart', async () => {
    let lookups = 0;
    const armRevocation = () => { host.revokeAt = 'account-lookup'; lookups++; };
    const error: any = await promote(async () => { armRevocation(); throw new Error('persist failed after launch'); }).catch(value => value);
    expect(lookups).toBe(1);
    expect(error.previousDeploymentRetained).toBe(true);
    expect(deployed()).toBe(PREVIOUS);
    expect(launches()).toEqual([{ event: 'HOST-LAUNCH', aborted: false }]);
  });

  it('control start stops at the launch boundary when authority ends during account lookup', async () => {
    host.running = false; host.revokeAt = 'account-lookup';
    await expect(settle(startDesktopProject('review-project', 'Review', { signal: host.controller.signal }))).rejects.toBeInstanceOf(DesktopLaunchCancelledError);
    expect(launches()).toEqual([]);
    host.revokeAt = null; host.controller = new AbortController(); host.revoked = false;
    await settle(startDesktopProject('review-project', 'Review', { signal: host.controller.signal }));
    expect(launches()).toEqual([{ event: 'HOST-LAUNCH', aborted: false }]);
  });
});
