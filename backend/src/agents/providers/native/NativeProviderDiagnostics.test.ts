import {
  isNativeProviderAuthFailure,
  redactNativeProviderText,
  sanitizeNativeProviderEvent,
} from './NativeProviderDiagnostics';

describe('NativeProviderDiagnostics', () => {
  test('redacts sensitive structured keys across naming styles', () => {
    const sanitized = sanitizeNativeProviderEvent({
      password: 'p@ssword',
      generic_secret: 'secret-value',
      sessionToken: 'session-value',
      authToken: 'auth-value',
      bearerToken: 'bearer-value',
      gatewayToken: 'gateway-value',
      deviceToken: 'device-value',
      jwt: 'jwt-value',
      privateKeyPem: 'private-key-value',
      nested: {
        clientCredential: 'credential-value',
        tokenCount: 42,
      },
    });

    expect(sanitized).toEqual({
      password: '[redacted]',
      generic_secret: '[redacted]',
      sessionToken: '[redacted]',
      authToken: '[redacted]',
      bearerToken: '[redacted]',
      gatewayToken: '[redacted]',
      deviceToken: '[redacted]',
      jwt: '[redacted]',
      privateKeyPem: '[redacted]',
      nested: {
        clientCredential: '[redacted]',
        tokenCount: 42,
      },
    });
  });

  test('removes URL userinfo, paths, queries, and fragments', () => {
    const safe = redactNativeProviderText(
      'request failed at https://user:pass@example.test/private/project/token?code=oauth-secret#callback',
    );

    expect(safe).toContain('https://example.test/[path/query redacted]');
    expect(safe).not.toContain('user');
    expect(safe).not.toContain('pass');
    expect(safe).not.toContain('/private/project/token');
    expect(safe).not.toContain('oauth-secret');
    expect(safe).not.toContain('callback');
  });

  test('redacts before truncation can separate a label from its value', () => {
    const secret = `BOUNDARY_SECRET_${'z'.repeat(96)}`;
    const safe = redactNativeProviderText(`${'x'.repeat(80)} password=${secret}`, 64);

    expect(safe).not.toContain('BOUNDARY_SECRET');
    expect(Buffer.byteLength(safe, 'utf8')).toBeLessThanOrEqual(64);
  });

  test('redacts quoted JSON-like secrets and incomplete private-key blocks', () => {
    const safe = redactNativeProviderText([
      '{"password":"value with spaces","sessionToken":"token-value"}',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'private-material-without-an-end-marker',
    ].join('\n'));

    expect(safe).toContain('password=[redacted]');
    expect(safe).toContain('sessionToken=[redacted]');
    expect(safe).toContain('[private key redacted]');
    expect(safe).not.toContain('value with spaces');
    expect(safe).not.toContain('token-value');
    expect(safe).not.toContain('private-material');
  });

  test('does not classify unrelated bare tool HTTP statuses as provider auth failure', () => {
    expect(isNativeProviderAuthFailure('User tool fetched https://example.test and received HTTP 403')).toBe(false);
    expect(isNativeProviderAuthFailure('Provider authentication failed with HTTP 403')).toBe(true);
    expect(isNativeProviderAuthFailure('Access token expired')).toBe(true);
  });
});
