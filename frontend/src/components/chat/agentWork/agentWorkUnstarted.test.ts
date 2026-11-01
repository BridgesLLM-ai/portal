import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../api/client', () => ({ default: { get: mocks.get, post: vi.fn() } }));

import { AgentWorkRequestError, fetchSessionWork, isUnstartedSessionWork } from './agentWorkApi';

const KEY = 'agent:main:main';
const unstarted = (extra: Record<string, unknown> = {}) => ({
  v: 1, sessionKey: KEY, fetchedAt: '2026-10-31T23:15:13.000Z', caps: { goals: false, progress: false },
  started: false, session: null, goal: null, progress: null, children: [], ...extra,
});

afterEach(() => { mocks.get.mockReset(); });

describe('a chat the gateway has not stored yet', () => {
  it('is the same empty state as a missing conversation, without a failed request', async () => {
    mocks.get.mockResolvedValue({ data: unstarted() });
    const failure = await fetchSessionWork(KEY).catch((error) => error);
    expect(failure).toBeInstanceOf(AgentWorkRequestError);
    expect(failure).toMatchObject({ kind: 'not-found', status: 200, code: 'SESSION_NOT_STARTED' });
  });

  it('is recognised only for the exact key, v1, an explicit started:false and no row', () => {
    expect(isUnstartedSessionWork(unstarted(), KEY)).toBe(true);
    expect(isUnstartedSessionWork(unstarted(), 'agent:main:other')).toBe(false);
    expect(isUnstartedSessionWork(unstarted({ v: 2 }), KEY)).toBe(false);
    expect(isUnstartedSessionWork(unstarted({ started: undefined }), KEY)).toBe(false);
    expect(isUnstartedSessionWork(unstarted({ session: { key: KEY } }), KEY)).toBe(false);
    expect(isUnstartedSessionWork('<!doctype html>', KEY)).toBe(false);
  });

  it('a malformed or foreign answer is still not trusted', async () => {
    mocks.get.mockResolvedValue({ data: unstarted({ sessionKey: 'agent:main:other' }) });
    await expect(fetchSessionWork(KEY)).rejects.toMatchObject({ kind: 'unavailable', status: 200 });
    mocks.get.mockResolvedValue({ data: unstarted({ started: undefined }) });
    await expect(fetchSessionWork(KEY)).rejects.toMatchObject({ kind: 'unavailable', status: 200 });
  });

  it('a stored chat still loads normally', async () => {
    mocks.get.mockResolvedValue({ data: unstarted({ started: undefined,
      session: { kind: 'session', key: KEY, label: 'Main', status: 'idle' }, caps: { goals: true, progress: false } }) });
    const work = await fetchSessionWork(KEY);
    expect(work.session.key).toBe(KEY);
    expect(work.caps).toEqual({ goals: true, progress: false });
  });
});
