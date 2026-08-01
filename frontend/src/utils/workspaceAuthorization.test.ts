// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_AUTHORIZATION_CHANGED_EVENT,
  StaleWorkspaceAuthorizationResponseError,
  announceWorkspaceAuthorizationVersion,
  assertWorkspaceAuthorizationResponseIsCurrent,
  observedWorkspaceAuthorizationVersion,
  resetWorkspaceAuthorizationForTests,
  setWorkspaceAuthorizationBaseline,
  workspaceAuthorizationAbortSignal,
} from './workspaceAuthorization';

describe('workspace authorization generation', () => {
  beforeEach(() => resetWorkspaceAuthorizationForTests());

  it('announces only a strictly newer generation for the same user', () => {
    const listener = vi.fn();
    window.addEventListener(WORKSPACE_AUTHORIZATION_CHANGED_EVENT, listener);
    setWorkspaceAuthorizationBaseline('user-1', 4);

    expect(announceWorkspaceAuthorizationVersion('user-1', 4, 'socket')).toBe(false);
    expect(announceWorkspaceAuthorizationVersion('user-1', 5, 'socket')).toBe(true);
    expect(observedWorkspaceAuthorizationVersion('user-1')).toBe(5);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(WORKSPACE_AUTHORIZATION_CHANGED_EVENT, listener);
  });

  it('rejects a delayed response from an older generation', () => {
    setWorkspaceAuthorizationBaseline('user-1', 7);
    expect(() => assertWorkspaceAuthorizationResponseIsCurrent('user-1', 6))
      .toThrow(StaleWorkspaceAuthorizationResponseError);
  });

  it('resets the monotonic baseline when a different user signs in', () => {
    setWorkspaceAuthorizationBaseline('user-1', 20);
    expect(setWorkspaceAuthorizationBaseline('user-2', 1)).toBe(1);
    expect(observedWorkspaceAuthorizationVersion('user-2')).toBe(1);
  });

  it('aborts every transport bound to the retired generation', () => {
    setWorkspaceAuthorizationBaseline('user-1', 3);
    const signal = workspaceAuthorizationAbortSignal('user-1', 3);
    expect(signal.aborted).toBe(false);

    announceWorkspaceAuthorizationVersion('user-1', 4, 'socket');

    expect(signal.aborted).toBe(true);
    expect(workspaceAuthorizationAbortSignal('user-1', 3).aborted).toBe(true);
    expect(workspaceAuthorizationAbortSignal('user-1', 4).aborted).toBe(false);
  });
});
