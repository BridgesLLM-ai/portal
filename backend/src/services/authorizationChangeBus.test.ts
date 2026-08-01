import {
  authorizationChangeSubscriberCount,
  publishAuthorizationChanged,
  subscribeToAuthorizationChanges,
} from './authorizationChangeBus';

describe('authorization change bus', () => {
  test('delivers only to the exact target user and releases subscriptions', () => {
    const first = jest.fn();
    const second = jest.fn();
    const unsubscribeFirst = subscribeToAuthorizationChanges('user-a', first);
    const unsubscribeSecond = subscribeToAuthorizationChanges('user-b', second);

    publishAuthorizationChanged({
      type: 'authorization_changed',
      userId: 'user-a',
      authorizationVersion: 2,
      reasons: ['workspace_scope'],
    });

    expect(first).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-a',
      authorizationVersion: 2,
    }));
    expect(second).not.toHaveBeenCalled();
    expect(authorizationChangeSubscriberCount()).toBe(2);

    unsubscribeFirst();
    unsubscribeSecond();
    expect(authorizationChangeSubscriberCount()).toBe(0);
  });

  test('one failing listener cannot suppress another session', () => {
    const failing = jest.fn(() => { throw new Error('disconnected'); });
    const healthy = jest.fn();
    const removeFailing = subscribeToAuthorizationChanges('user-c', failing);
    const removeHealthy = subscribeToAuthorizationChanges('user-c', healthy);
    const event = {
      type: 'authorization_changed' as const,
      userId: 'user-c',
      authorizationVersion: 3,
      reasons: ['role'] as Array<'role'>,
    };

    expect(() => publishAuthorizationChanged(event)).not.toThrow();
    expect(healthy).toHaveBeenCalledWith(event);
    removeFailing();
    removeHealthy();
  });
});
