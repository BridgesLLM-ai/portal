import { hashPassword, comparePassword } from '../utils/password';

describe('auth utilities', () => {
  test('hashPassword + comparePassword roundtrip', async () => {
    const password = 'TestPassword123!';
    const hash = await hashPassword(password);

    expect(hash).toBeTruthy();
    await expect(comparePassword(password, hash)).resolves.toBe(true);
    await expect(comparePassword('wrong-password', hash)).resolves.toBe(false);
  });
});
