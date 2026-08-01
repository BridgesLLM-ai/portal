import { __thinkingSubjectTest, sanitizeThinkingSubject } from './thinkingSubject';

describe('sanitizeThinkingSubject', () => {
  test('converts provider progress into bounded plain text', () => {
    const value = sanitizeThinkingSubject(
      '# **Inspecting** [the runtime](https://example.test)\nnext step\u202e'
      + 'x'.repeat(160),
    );

    expect(value).toMatch(/^Inspecting the runtime next stepx+$/);
    expect(value).toHaveLength(__thinkingSubjectTest.maxChars);
    expect(value).not.toMatch(/[\n\r\u202e*#[\]()`]/);
  });

  test('removes reply metadata and redacts obvious credentials', () => {
    expect(sanitizeThinkingSubject(
      '<openclaw-reply id="42">Checking</openclaw-reply> api_key=sk-abcdefghijklmnopqrstuv',
    )).toBe('Checking [redacted]');
    expect(sanitizeThinkingSubject(
      '-----BEGIN PRIVATE KEY----- definitely-not-a-title',
    )).toBe('');
  });

  test('redacts opaque Authorization, Bearer, and Basic credentials as complete values', () => {
    expect(sanitizeThinkingSubject(
      'Checking Authorization: Bearer opaque-production-credential next',
    )).toBe('Checking [redacted] next');
    expect(sanitizeThinkingSubject(
      'Checking Bearer opaque-production-credential next',
    )).toBe('Checking [redacted] next');
    expect(sanitizeThinkingSubject(
      'Checking Basic dXNlcjpwYXNzd29yZA== next',
    )).toBe('Checking [redacted] next');
    expect(sanitizeThinkingSubject(
      'Checking Bearer "opaque\\"auth-secret" next',
    )).toBe('Checking [redacted] next');
    expect(sanitizeThinkingSubject(
      'Checking Authorization=Signature opaque-signature-secret next',
    )).toBe('Checking [redacted] next');
    expect(sanitizeThinkingSubject(
      'Checking Proxy-Authorization=Digest opaque-digest-secret next',
    )).toBe('Checking [redacted] next');
  });

  test.each([
    ['token assignment', 'Checking token=opaque-token-value next', 'opaque-token-value'],
    ['credential URL', 'Checking https://user:pass@example.test/private?code=opaque-query-secret#frag', 'opaque-query-secret'],
    ['database URL', 'Checking postgres://dbuser:dbpass@db.example.test/app?sslkey=opaque-db-secret#fragment', 'opaque-db-secret'],
    ['cookie header', 'Checking Cookie: session=opaque-cookie-secret', 'opaque-cookie-secret'],
    ['set-cookie header', 'Checking Set-Cookie: session=opaque-set-cookie-secret; Secure', 'opaque-set-cookie-secret'],
    ['custom token header', 'Checking X-Portal-Auth-Token: opaque-custom-header-secret', 'opaque-custom-header-secret'],
    ['unknown authorization scheme', 'Checking Authorization: Signature opaque-signature-secret', 'opaque-signature-secret'],
    ['JSON credentials', '{"password":"opaque-body-secret","refresh_token":"opaque-refresh-secret"}', 'opaque-body-secret'],
    ['bidi-obfuscated scheme', 'Checking Be\u202earer opaque-production-credential', 'opaque-production-credential'],
    ['control-obfuscated scheme', 'Checking Be\u0000arer opaque-control-credential', 'opaque-control-credential'],
    ['bidi-obfuscated label', 'Checking to\u202eken=opaque-bidi-label-secret', 'opaque-bidi-label-secret'],
    ['bidi-obfuscated token label', 'Checking to\u202eken=opaque-bidi-token', 'opaque-bidi-token'],
    ['control-obfuscated label', 'Checking api\u0000_key=opaque-control-label-secret', 'opaque-control-label-secret'],
    ['whitespace-control label', 'Checking pass\tword=opaque-tab-label-secret', 'opaque-tab-label-secret'],
    ['markup-obfuscated label', 'Checking re<b>fresh_token=opaque-markup-label-secret', 'opaque-markup-label-secret'],
    ['markdown-obfuscated password', 'Checking pa**ss**word=opaque-markup-password', 'opaque-markup-password'],
    ['HTML-obfuscated api key', 'Checking <span>api</span>_key=opaque-html-key', 'opaque-html-key'],
    ['generic credential', 'Checking credential=opaque-generic-credential', 'opaque-generic-credential'],
    ['exact custom token header', 'Checking X-Auth-Token: opaque-custom-header', 'opaque-custom-header'],
    ['exact set-cookie header', 'Checking Set-Cookie: session=opaque-set-cookie', 'opaque-set-cookie'],
    ['namespaced assignment', 'Checking runtime.openai.credentials.refresh_token=opaque-namespaced-secret', 'opaque-namespaced-secret'],
    ['underscore database namespace', 'Checking DATABASE_PASSWORD=opaque-database-password', 'opaque-database-password'],
    ['underscore runtime namespace', 'Checking runtime_api_key=opaque-runtime-api-key', 'opaque-runtime-api-key'],
    ['secret inside AWS namespace', 'Checking AWS_SECRET_ACCESS_KEY=opaque-aws-secret', 'opaque-aws-secret'],
    ['api key inside Google namespace', 'Checking GOOGLE_API_KEY_JSON=opaque-google-key', 'opaque-google-key'],
    ['escaped-quote password', 'Checking password="opaque\\"password-secret" next', 'password-secret'],
    ['mixed-case prefix', 'Checking SK-ABCDEFGHIJKLMNOPQRSTUVWX', 'SK-ABCDEFGHIJKLMNOPQRSTUVWX'],
  ])('redacts %s without leaving the credential value', (_name, input, secret) => {
    const value = sanitizeThinkingSubject(input);
    expect(value).not.toContain(secret);
    expect(value).toContain('[redacted]');
  });

  test('redacts every credential value in a JSON-shaped subject', () => {
    const value = sanitizeThinkingSubject(
      '{"password":"opaque-body-secret","refresh_token":"opaque-refresh-secret"}',
    );
    expect(value).not.toContain('opaque-body-secret');
    expect(value).not.toContain('opaque-refresh-secret');
  });

  test('keeps harmless prose that merely discusses authentication concepts', () => {
    expect(sanitizeThinkingSubject(
      'Reviewing token usage and authorization rules before running tests',
    )).toBe('Reviewing token usage and authorization rules before running tests');
  });
});
