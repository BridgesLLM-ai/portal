import { canUseDesktopRuntimeDeployment } from '../utils/authz';

describe('Remote Desktop project-runtime authorization', () => {
  test.each(['OWNER', 'SUB_ADMIN'])('allows active %s host operators', (role) => {
    expect(canUseDesktopRuntimeDeployment(role, 'ACTIVE', true)).toBe(true);
  });

  test.each(['USER', 'GUEST', '', undefined])('rejects ordinary role %s', (role) => {
    expect(canUseDesktopRuntimeDeployment(role, 'ACTIVE', true)).toBe(false);
  });

  test.each(['PENDING', 'DISABLED', 'BANNED'])('rejects elevated but non-active status %s', (status) => {
    expect(canUseDesktopRuntimeDeployment('OWNER', status, true)).toBe(false);
  });

  test('rejects an explicitly inactive elevated account', () => {
    expect(canUseDesktopRuntimeDeployment('SUB_ADMIN', 'ACTIVE', false)).toBe(false);
  });
});
