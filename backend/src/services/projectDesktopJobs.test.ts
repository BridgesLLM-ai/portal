import fs from 'fs';
import path from 'path';
import os from 'os';
import { createDesktopJobStore } from './projectDesktopJobs';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-jobs-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
it('records bounded real progress and a durable result scoped to the immutable project', () => {
  const store = createDesktopJobStore(root), controller = new AbortController();
  const job = store.beginDesktopJob({ projectId: 'first', actorId: 'actor', action: 'deploy', controller });
  store.updateDesktopJob('first', 'Compiling', 'x'.repeat(30 * 1024));
  expect(store.readDesktopJob('first', job.id)?.output.length).toBe(24 * 1024);
  expect(store.readDesktopJob('other', job.id)).toBeNull();
  store.finishDesktopJob('first', { appId: 'application', deployType: 'runtime' });
  const reopened = createDesktopJobStore(root).readDesktopJob('first', job.id);
  expect(reopened?.status).toBe('succeeded'); expect(reopened?.result?.appId).toBe('application');
});
it('marks unproven prior-process builds interrupted, never successful or still live', () => {
  const store = createDesktopJobStore(root);
  const job = store.beginDesktopJob({ projectId: 'first', actorId: 'actor', action: 'check', controller: new AbortController() });
  const afterRestart = createDesktopJobStore(root).readDesktopJob('first', job.id);
  expect(afterRestart?.status).toBe('interrupted'); expect(afterRestart?.result).toBeUndefined();
  expect(afterRestart?.error).toContain('restarted');
});
it('cancels only the exact active job and persists cancellation after its worker settles', () => {
  const store = createDesktopJobStore(root), controller = new AbortController();
  const job = store.beginDesktopJob({ projectId: 'first', actorId: 'actor', action: 'check', controller });
  expect(store.cancelDesktopJob('first', 'wrong-id')).toBe(false); expect(controller.signal.aborted).toBe(false);
  expect(store.cancelDesktopJob('first', job.id)).toBe(true); expect(controller.signal.aborted).toBe(true);
  expect(store.readDesktopJob('first')?.status).toBe('running');
  store.finishDesktopJob('first', undefined, new Error('cancelled compiler'));
  expect(createDesktopJobStore(root).readDesktopJob('first')?.status).toBe('cancelled');
});
it('bounds concurrency and rejects duplicate project jobs and unsafe store links', () => {
  const store = createDesktopJobStore(root);
  const begin = (projectId: string) => store.beginDesktopJob({ projectId, actorId: 'actor', action: 'check', controller: new AbortController() });
  begin('one'); expect(() => begin('one')).toThrow('active'); begin('two'); expect(() => begin('three')).toThrow('Two');
  store.finishDesktopJob('one', { ok: true });
  fs.symlinkSync(path.join(root, 'one'), path.join(root, 'alias'));
  expect(() => begin('alias')).toThrow('unsafe'); expect(() => begin('../escape')).toThrow('identity');
});

it('releases the concurrency slot if final receipt persistence fails, without reporting a durable success', () => {
  const store = createDesktopJobStore(root);
  const job = store.beginDesktopJob({ projectId: 'first', actorId: 'actor', action: 'build', controller: new AbortController() });
  const original = fs.renameSync;
  const failure = jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('fixture disk failure'); });
  expect(() => store.finishDesktopJob('first', { ok: true })).toThrow('fixture disk failure');
  failure.mockImplementation(original); failure.mockRestore();
  expect(store.readDesktopJob('first', job.id)?.status).toBe('interrupted');
  expect(() => store.beginDesktopJob({ projectId: 'first', actorId: 'actor', action: 'build', controller: new AbortController() })).not.toThrow();
});
