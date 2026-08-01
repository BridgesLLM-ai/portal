// @vitest-environment jsdom
import '../test/setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  historyConfirmsPendingProjectChatSend,
  inspectProjectChatPendingSend,
  loadPendingProjectChatSend,
  projectChatPendingSendStorageKey,
  reconcilePendingProjectChatSend,
  runCoordinatedProjectChatReset,
  runCoordinatedProjectChatSend,
  subscribeProjectChatSendState,
  type ProjectChatCoordinatorOptions,
  type ProjectChatSendScope,
} from './projectChatPendingSend';

type LockManager = NonNullable<ProjectChatCoordinatorOptions['lockManager']>;

class SerialLockManager implements LockManager {
  private readonly tails = new Map<string, Promise<void>>();

  async request<T>(
    name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(name) || Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => held);
    this.tails.set(name, tail);

    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new DOMException('The lock request was aborted.', 'AbortError'));
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener('abort', abort, { once: true });
      previous.then(() => {
        options.signal.removeEventListener('abort', abort);
        resolve();
      }, reject);
    });

    try {
      return await callback();
    } finally {
      release();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const scope: ProjectChatSendScope = {
  actorUserId: 'user-1',
  projectId: 'immutable-project-alpha',
  provider: 'OPENCLAW',
};

function sendInput(overrides: Partial<Parameters<typeof runCoordinatedProjectChatSend<string>>[0]> = {}) {
  return {
    scope,
    draftText: 'retry me',
    payloadText: 'retry me\n\nAttached files:\n- /project/file.txt',
    model: 'openai/gpt-5.5',
    dispatch: vi.fn(async () => 'accepted'),
    classifyError: () => 'ambiguous' as const,
    options: { lockManager: new SerialLockManager(), attemptStartedAt: 1_000 },
    ...overrides,
  };
}

describe('Project Chat pending send coordination', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('stores only immutable-ID-scoped fingerprints and never message or attachment plaintext', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const dispatch = vi.fn(async () => { throw new Error('connection lost'); });

    await expect(runCoordinatedProjectChatSend(sendInput({ dispatch }))).rejects.toThrow('connection lost');

    const key = projectChatPendingSendStorageKey(scope.actorUserId, scope.projectId, scope.provider);
    const serialized = localStorage.getItem(key) || '';
    expect(serialized).not.toContain('retry me');
    expect(serialized).not.toContain('file.txt');
    expect(JSON.parse(serialized)).toMatchObject({
      schema: 2,
      projectId: scope.projectId,
      messageId: 'project-chat-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa',
    });
    expect(JSON.parse(serialized)).not.toHaveProperty('projectName');
  });

  it('holds one cross-tab lock through the real outcome and dispatches a queued attempt exactly once', async () => {
    const lockManager = new SerialLockManager();
    const firstOutcome = deferred<string>();
    const firstDispatch = vi.fn(() => firstOutcome.promise);
    const secondDispatch = vi.fn(async () => 'should-not-dispatch');
    vi.spyOn(Date, 'now').mockReturnValue(2_000);
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

    const first = runCoordinatedProjectChatSend(sendInput({
      dispatch: firstDispatch,
      options: { lockManager, attemptStartedAt: 1_000 },
    }));
    await vi.waitFor(() => expect(firstDispatch).toHaveBeenCalledTimes(1));
    const second = runCoordinatedProjectChatSend(sendInput({
      dispatch: secondDispatch,
      options: { lockManager, attemptStartedAt: 1_500 },
    }));

    await Promise.resolve();
    expect(secondDispatch).not.toHaveBeenCalled();
    firstOutcome.resolve('accepted');
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.confirmedBeforeDispatch).toBe(false);
    expect(secondResult.confirmedBeforeDispatch).toBe(true);
    expect(secondResult.staged.messageId).toBe(firstResult.staged.messageId);
    expect(firstDispatch).toHaveBeenCalledTimes(1);
    expect(secondDispatch).not.toHaveBeenCalled();
  });

  it('does not release the lock after the old 45-second boundary while dispatch is still live', async () => {
    const lockManager = new SerialLockManager();
    const outcome = deferred<string>();
    const firstDispatch = vi.fn(() => outcome.promise);
    const secondDispatch = vi.fn(async () => 'unexpected');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const first = runCoordinatedProjectChatSend(sendInput({
      dispatch: firstDispatch,
      options: { lockManager, attemptStartedAt: 1_000 },
    }));
    await vi.waitFor(() => expect(firstDispatch).toHaveBeenCalledTimes(1));

    // Simulate the wall clock moving beyond the removed 45-second outcome
    // deadline. Only lock acquisition is bounded; an acquired lock remains
    // owned until the actual request promise settles.
    clock.mockReturnValue(46_001);
    const second = runCoordinatedProjectChatSend(sendInput({
      dispatch: secondDispatch,
      options: { lockManager, lockWaitMs: 20, attemptStartedAt: 46_000 },
    }));
    await expect(second).rejects.toThrow(/another tab is still confirming/i);
    expect(secondDispatch).not.toHaveBeenCalled();

    outcome.resolve('accepted');
    await first;
  });

  it('keeps the same identity across a project rename because the storage scope is the immutable project ID', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    const lockManager = new SerialLockManager();
    const fail = vi.fn(async () => { throw new Error('ambiguous'); });
    await expect(runCoordinatedProjectChatSend(sendInput({
      dispatch: fail,
      options: { lockManager, attemptStartedAt: 1_000 },
    }))).rejects.toThrow('ambiguous');
    const beforeRename = loadPendingProjectChatSend(scope);

    // The display name is intentionally not part of the scope or record. A
    // renamed route therefore returns to the same preserved delivery identity.
    await expect(runCoordinatedProjectChatSend(sendInput({
      dispatch: fail,
      options: { lockManager, attemptStartedAt: 2_000 },
    }))).rejects.toThrow('ambiguous');
    expect(loadPendingProjectChatSend(scope)?.messageId).toBe(beforeRename?.messageId);
  });

  it('never collapses identical text sent with a different effective model', async () => {
    const lockManager = new SerialLockManager();
    const fail = vi.fn(async () => { throw new Error('ambiguous'); });
    await expect(runCoordinatedProjectChatSend(sendInput({
      dispatch: fail,
      options: { lockManager, attemptStartedAt: 1_000 },
    }))).rejects.toThrow('ambiguous');

    await expect(runCoordinatedProjectChatSend(sendInput({
      model: 'anthropic/claude-fable-5',
      dispatch: fail,
      options: { lockManager, attemptStartedAt: 1_500 },
    }))).rejects.toThrow(/exact original message and model/i);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it('fails closed on malformed storage instead of treating it as absent', async () => {
    localStorage.setItem(
      projectChatPendingSendStorageKey(scope.actorUserId, scope.projectId, scope.provider),
      '{"schema":2,"messageId":"forged"}',
    );
    const dispatch = vi.fn(async () => 'unexpected');

    expect(inspectProjectChatPendingSend(scope)).toMatchObject({ status: 'corrupt' });
    await expect(runCoordinatedProjectChatSend(sendInput({ dispatch }))).rejects.toThrow(/malformed/i);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('clears only explicit never-admitted outcomes and preserves ambiguous failures', async () => {
    const lockManager = new SerialLockManager();
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
      .mockReturnValueOnce('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    await expect(runCoordinatedProjectChatSend(sendInput({
      dispatch: vi.fn(async () => { throw new Error('gateway timeout'); }),
      classifyError: () => 'ambiguous',
      options: { lockManager, attemptStartedAt: 1_000 },
    }))).rejects.toThrow('gateway timeout');
    expect(loadPendingProjectChatSend(scope)).not.toBeNull();

    await reconcilePendingProjectChatSend({
      scope,
      resolve: async () => 'never-admitted',
      options: { lockManager },
    });
    expect(loadPendingProjectChatSend(scope)).toBeNull();

    await expect(runCoordinatedProjectChatSend(sendInput({
      dispatch: vi.fn(async () => { throw new Error('validated rejection'); }),
      classifyError: () => 'never-admitted',
      options: { lockManager, attemptStartedAt: 3_000 },
    }))).rejects.toThrow('validated rejection');
    expect(loadPendingProjectChatSend(scope)).toBeNull();
  });

  it('uses confirmation timestamps to distinguish a queued retry from a later identical message', async () => {
    const lockManager = new SerialLockManager();
    vi.spyOn(Date, 'now').mockReturnValue(2_000);
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const first = await runCoordinatedProjectChatSend(sendInput({
      options: { lockManager, attemptStartedAt: 1_000 },
    }));
    const laterDispatch = vi.fn(async () => 'accepted-again');
    const later = await runCoordinatedProjectChatSend(sendInput({
      dispatch: laterDispatch,
      options: { lockManager, attemptStartedAt: 2_001 },
    }));

    expect(later.confirmedBeforeDispatch).toBe(false);
    expect(later.staged.messageId).not.toBe(first.staged.messageId);
    expect(laterDispatch).toHaveBeenCalledTimes(1);
  });

  it('confirms fingerprints from any matching history page and reacts to cross-tab storage changes', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProjectChatSendState(scope, listener);
    const key = projectChatPendingSendStorageKey(scope.actorUserId, scope.projectId, scope.provider);
    window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage }));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();

    const lockManager = new SerialLockManager();
    const dispatch = vi.fn(async () => { throw new Error('ambiguous'); });
    await expect(runCoordinatedProjectChatSend(sendInput({
      dispatch,
      options: { lockManager, attemptStartedAt: 1_000 },
    }))).rejects.toThrow('ambiguous');
    const pending = loadPendingProjectChatSend(scope);
    expect(pending).not.toBeNull();
    expect(await historyConfirmsPendingProjectChatSend(pending!, [{
      role: 'user',
      content: 'retry me\n\nAttached files:\n- /project/file.txt',
      messageId: pending!.messageId,
    }])).toBe(true);
  });

  it('clears every provider record only for the authenticated immutable project identity', async () => {
    const lockManager = new SerialLockManager();
    const otherScope = { ...scope, projectId: 'immutable-project-beta' };
    const fail = vi.fn(async () => { throw new Error('ambiguous'); });
    await expect(runCoordinatedProjectChatSend(sendInput({
      dispatch: fail,
      options: { lockManager, attemptStartedAt: 1_000 },
    }))).rejects.toThrow();
    await expect(runCoordinatedProjectChatSend(sendInput({
      scope: otherScope,
      dispatch: fail,
      options: { lockManager, attemptStartedAt: 2_000 },
    }))).rejects.toThrow();

    await expect(runCoordinatedProjectChatReset({
      actorUserId: scope.actorUserId,
      projectId: scope.projectId,
      reset: async () => 'reset',
      options: { lockManager },
    })).resolves.toBe('reset');
    expect(loadPendingProjectChatSend(scope)).toBeNull();
    expect(loadPendingProjectChatSend(otherScope)).not.toBeNull();
  });

  it('serializes a destructive reset behind an in-flight send and removes its final outcome', async () => {
    const lockManager = new SerialLockManager();
    const dispatchOutcome = deferred<string>();
    const dispatch = vi.fn(() => dispatchOutcome.promise);
    const reset = vi.fn(async () => 'reset-complete');
    const send = runCoordinatedProjectChatSend(sendInput({
      dispatch,
      options: { lockManager, attemptStartedAt: 1_000 },
    }));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

    const clear = runCoordinatedProjectChatReset({
      actorUserId: scope.actorUserId,
      projectId: scope.projectId,
      reset,
      options: { lockManager },
    });
    await Promise.resolve();
    expect(reset).not.toHaveBeenCalled();

    dispatchOutcome.resolve('accepted');
    await send;
    await expect(clear).resolves.toBe('reset-complete');
    expect(reset).toHaveBeenCalledTimes(1);
    expect(inspectProjectChatPendingSend(scope)).toEqual({ status: 'absent', pending: null });
  });
});
