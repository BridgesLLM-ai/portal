import { buildPasswordResetPath } from './passwordResetLink';

describe('password reset link construction', () => {
  it('keeps the bearer secret in the URL fragment instead of the HTTP request target', () => {
    expect(buildPasswordResetPath('secret/value?and=email')).toBe(
      '/reset-password#token=secret%2Fvalue%3Fand%3Demail',
    );
  });
});
