import { validatePasswordStrength } from '../utils/password';

describe('password strength policy', () => {
  test('accepts passwords that meet the shared policy', () => {
    expect(validatePasswordStrength('StrongerPass123')).toEqual({
      valid: true,
      errors: [],
    });
  });

  test('rejects weak passwords with actionable errors', () => {
    expect(validatePasswordStrength('weakpass')).toEqual({
      valid: false,
      errors: [
        'Password must contain at least one uppercase letter',
        'Password must contain at least one number',
      ],
    });
  });

  test('rejects too-short passwords even if they otherwise match the pattern', () => {
    expect(validatePasswordStrength('Aa1')).toEqual({
      valid: false,
      errors: ['Password must be at least 8 characters long'],
    });
  });
});
