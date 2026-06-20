jest.mock('../config/database', () => ({
  prisma: {
    user: {
      findFirst: jest.fn().mockResolvedValue({ id: 'owner-user' }),
    },
  },
}));

import { getWorkspaceOwnerId, shouldIsolateUser } from '../utils/workspaceScope';

function user(overrides: Partial<any>) {
  return {
    userId: 'regular-user',
    email: 'user@example.com',
    role: 'USER',
    accountStatus: 'ACTIVE',
    sandboxEnabled: false,
    ...overrides,
  };
}

describe('workspace scoping', () => {
  test('regular users are always scoped to their own workspace', async () => {
    await expect(getWorkspaceOwnerId(user({ sandboxEnabled: false }))).resolves.toBe('regular-user');
    await expect(getWorkspaceOwnerId(user({ sandboxEnabled: true }))).resolves.toBe('regular-user');

    expect(shouldIsolateUser(user({ sandboxEnabled: false }))).toBe(true);
    expect(shouldIsolateUser(user({ sandboxEnabled: true }))).toBe(true);
  });

  test('sub-admins can use shared owner workspace unless sandboxed', async () => {
    await expect(getWorkspaceOwnerId(user({ role: 'SUB_ADMIN', sandboxEnabled: false }))).resolves.toBe('owner-user');
    await expect(getWorkspaceOwnerId(user({ role: 'SUB_ADMIN', sandboxEnabled: true }))).resolves.toBe('regular-user');

    expect(shouldIsolateUser(user({ role: 'SUB_ADMIN', sandboxEnabled: false }))).toBe(false);
    expect(shouldIsolateUser(user({ role: 'SUB_ADMIN', sandboxEnabled: true }))).toBe(true);
  });
});
