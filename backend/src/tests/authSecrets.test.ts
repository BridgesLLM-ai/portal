describe('auth secret storage primitives', () => {
  const originalEncryptionKey = process.env.PORTAL_ENCRYPTION_KEY;

  beforeEach(() => {
    jest.resetModules();
    process.env.PORTAL_ENCRYPTION_KEY = 'test-portal-encryption-key-with-high-entropy';
  });

  afterAll(() => {
    if (originalEncryptionKey === undefined) delete process.env.PORTAL_ENCRYPTION_KEY;
    else process.env.PORTAL_ENCRYPTION_KEY = originalEncryptionKey;
  });

  test('uses authenticated randomized ciphertext and decrypts only with the configured key', () => {
    const { decryptSecret, encryptPlaintextSecret, encryptSecret } = require('../utils/authSecrets');
    const first = encryptSecret('mail-or-totp-secret');
    const second = encryptSecret('mail-or-totp-secret');

    expect(first).toMatch(/^portal-secret:v1:/);
    expect(second).not.toBe(first);
    expect(first).not.toContain('mail-or-totp-secret');
    expect(decryptSecret(first)).toBe('mail-or-totp-secret');
    const prefixLikePlaintext = 'portal-secret:v1:not-actually-ciphertext';
    expect(decryptSecret(encryptPlaintextSecret(prefixLikePlaintext))).toBe(prefixLikePlaintext);

    process.env.PORTAL_ENCRYPTION_KEY = 'different-key-that-must-not-decrypt-data';
    expect(() => decryptSecret(first)).toThrow(/could not be authenticated/i);
  });

  test('creates stable purpose-separated keyed digests for indexed token lookup', () => {
    const { digestAuthToken } = require('../utils/authSecrets');
    expect(digestAuthToken('refresh', 'token-a')).toBe(digestAuthToken('refresh', 'token-a'));
    expect(digestAuthToken('refresh', 'token-a')).not.toBe(digestAuthToken('password-reset', 'token-a'));
    expect(digestAuthToken('refresh', 'token-a')).not.toContain('token-a');
  });
});
