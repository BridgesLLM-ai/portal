import {
  ACTIVE_STATUS,
  BANNED_STATUS,
  DISABLED_STATUS,
  PENDING_STATUS,
  canUseDirectGateway,
  canUseInteractivePortal,
} from '../utils/authz';

describe('gateway transport access policy', () => {
  test.each([
    ['OWNER', true],
    ['SUB_ADMIN', true],
    ['USER', false],
    ['VIEWER', false],
  ])('direct operator transport role %s allowed=%s', (role, allowed) => {
    expect(canUseDirectGateway(role, ACTIVE_STATUS, true)).toBe(allowed);
  });

  test.each([
    ['OWNER', true],
    ['SUB_ADMIN', true],
    ['USER', true],
    ['VIEWER', false],
  ])('isolated Portal transport role %s allowed=%s', (role, allowed) => {
    expect(canUseInteractivePortal(role, ACTIVE_STATUS, true)).toBe(allowed);
  });

  test.each([PENDING_STATUS, DISABLED_STATUS, BANNED_STATUS])(
    'direct operator transport rejects %s accounts regardless of role',
    (accountStatus) => {
      expect(canUseDirectGateway('OWNER', accountStatus, true)).toBe(false);
      expect(canUseDirectGateway('SUB_ADMIN', accountStatus, true)).toBe(false);
    },
  );

  it('rejects inactive elevated accounts from both transports', () => {
    expect(canUseDirectGateway('OWNER', ACTIVE_STATUS, false)).toBe(false);
    expect(canUseInteractivePortal('OWNER', ACTIVE_STATUS, false)).toBe(false);
  });
});
