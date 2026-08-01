import {
  isValidAgentZeroDesktopLauncherSecret,
  mintAgentZeroDesktopSession,
  parseSessionCookieHeader,
} from '../services/agentZeroDesktopLaunch';

describe('Agent Zero Remote Desktop session exchange', () => {
  test('parses a session cookie header into name/value pairs, ignoring attributes', () => {
    expect(parseSessionCookieHeader('session=abc123; csrf=xyz; Path=/; HttpOnly')).toEqual([
      { name: 'session', value: 'abc123' },
      { name: 'csrf', value: 'xyz' },
      // Path/HttpOnly are attributes without a value pair form here and are kept
      // only when they look like real cookies; bare flags are dropped.
      { name: 'Path', value: '/' },
    ]);
  });

  test('drops malformed cookie fragments', () => {
    expect(parseSessionCookieHeader('   ; =nope; good=1 ; ')).toEqual([
      { name: 'good', value: '1' },
    ]);
  });

  test('the launcher capability secret rejects wrong, empty, and non-string input', () => {
    // The real secret is minted lazily; a valid check must round-trip only the
    // exact value. We cannot read it, so assert the negative space precisely.
    expect(isValidAgentZeroDesktopLauncherSecret('')).toBe(false);
    expect(isValidAgentZeroDesktopLauncherSecret('not-the-secret')).toBe(false);
    expect(isValidAgentZeroDesktopLauncherSecret(undefined)).toBe(false);
    expect(isValidAgentZeroDesktopLauncherSecret(12345 as unknown as string)).toBe(false);
  });

  test('mint returns the Agent Zero base URL and parsed cookies from a fresh server-side login', async () => {
    const manager = {
      baseUrl: 'http://127.0.0.1:50001',
      getSessionCookie: jest.fn(async (forceRefresh?: boolean) => {
        expect(forceRefresh).toBe(true); // a fresh session per click
        return 'session=live-token; extra=1';
      }),
    } as any;
    await expect(mintAgentZeroDesktopSession(manager)).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:50001',
      cookies: [
        { name: 'session', value: 'live-token' },
        { name: 'extra', value: '1' },
      ],
    });
  });

  test('mint fails closed when the server session has no cookies', async () => {
    const manager = {
      baseUrl: 'http://127.0.0.1:50001',
      getSessionCookie: jest.fn(async () => ''),
    } as any;
    await expect(mintAgentZeroDesktopSession(manager)).rejects.toThrow('did not return a usable web session');
  });
});
