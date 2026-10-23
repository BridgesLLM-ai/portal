import { SharedInteractiveBrowser } from './sharedInteractiveBrowser';

const caller = { agentId: 'alpha', sessionKey: 'agent:alpha:portal-user-a', runId: 'run-1', toolCallId: 'call-1' };
function selected() { const browser = new SharedInteractiveBrowser(); browser.select('a', caller.sessionKey, caller.agentId); return browser; }
function returned(browser: SharedInteractiveBrowser) { browser.control('a', browser.snapshot('a')!.revision, 'return'); }

test('fresh/restarted instance has no agent grant and selection begins in human control', () => {
  const browser = new SharedInteractiveBrowser(); expect(() => browser.begin(caller)).toThrow('no shared browser selection');
  browser.select('a', caller.sessionKey, caller.agentId); expect(browser.humanCanConnect('a')).toBe(true);
  expect(() => browser.begin(caller)).toThrow('Human control');
});
test('user, session and agent targeting are exact (including same-user second session)', () => {
  const browser = selected(); returned(browser);
  expect(() => browser.snapshot('b')).toThrow('unavailable');
  expect(browser.humanCanConnect('b')).toBe(false);
  expect(() => browser.control('b', browser.snapshot('a')!.revision, 'take')).toThrow('unavailable');
  expect(() => browser.begin({ ...caller, sessionKey: caller.sessionKey + '-other' })).toThrow('no shared browser selection');
  expect(() => browser.begin({ ...caller, agentId: 'other' })).toThrow('no shared browser selection');
  expect(() => browser.select('b', 'other', 'other')).toThrow('Release');
  browser.begin(caller);
});
test('takeover drains the exact active call before enabling noVNC, and return revokes human input', () => {
  const browser = selected(); returned(browser); browser.begin(caller);
  browser.control('a', browser.snapshot('a')!.revision, 'take');
  expect(browser.snapshot('a')!.mode).toBe('taking-control'); expect(browser.humanCanConnect('a')).toBe(false);
  expect(() => browser.begin({ ...caller, toolCallId: 'next' })).toThrow('Human control');
  expect(() => browser.control('a', browser.snapshot('a')!.revision, 'return')).toThrow('Wait');
  expect(() => browser.finish({ ...caller, runId: 'another-run' })).toThrow('does not match');
  browser.finish(caller); expect(browser.humanCanConnect('a')).toBe(true);
  returned(browser); expect(browser.humanCanConnect('a')).toBe(false); browser.begin({ ...caller, toolCallId: 'next' });
});
test('stale controls, concurrent actions, missing call IDs and revoked authority fail closed', () => {
  const browser = selected(); const revision = browser.snapshot('a')!.revision; returned(browser);
  expect(() => browser.control('a', revision, 'take')).toThrow('changed');
  expect(() => browser.begin({ ...caller, toolCallId: undefined })).toThrow('identity unavailable');
  browser.begin(caller); expect(() => browser.begin(caller)).toThrow('already active');
  browser.revoke('a'); expect(browser.humanCanConnect('a')).toBe(false);
  expect(() => browser.begin(caller)).toThrow('no shared browser selection');
  browser.finish(caller); expect(browser.snapshot('a')!.mode).toBe('revoked');
});
test('owner-only handover does not grant control; decline leaves agent lease unchanged', () => {
  const browser = selected(); returned(browser); browser.requestHandover(caller);
  expect(browser.snapshot('a')!.handoverRequested).toBe(true); expect(browser.humanCanConnect('a')).toBe(false);
  expect(() => browser.requestHandover({ ...caller, sessionKey: 'foreign' })).toThrow();
  browser.control('a', browser.snapshot('a')!.revision, 'decline'); expect(browser.snapshot('a')!.mode).toBe('agent');
  expect(browser.snapshot('a')!.handoverRequested).toBe(false);
});
test('inflight persistence precedes admission and survives backend restart without granting takeover', () => {
  let pending: string | null = null;
  const browser = new SharedInteractiveBrowser(); browser.restoreCall(null, key => { pending = key; });
  browser.select('a', caller.sessionKey, caller.agentId); returned(browser); browser.begin(caller);
  expect(pending).not.toBeNull();
  const restarted = new SharedInteractiveBrowser(); restarted.restoreCall(pending, key => { pending = key; });
  expect(() => restarted.select('a', caller.sessionKey, caller.agentId)).toThrow('previous browser call');
  restarted.finish(caller); expect(pending).toBeNull(); restarted.select('a', caller.sessionKey, caller.agentId);
});
test('failed persistence cannot grant an action', () => {
  const browser = new SharedInteractiveBrowser(); browser.restoreCall(null, () => { throw new Error('disk full'); });
  browser.select('a', caller.sessionKey, caller.agentId); returned(browser); expect(() => browser.begin(caller)).toThrow('disk full');
  browser.control('a', browser.snapshot('a')!.revision, 'take'); expect(browser.humanCanConnect('a')).toBe(true);
});
