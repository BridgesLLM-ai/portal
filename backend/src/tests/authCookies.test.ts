import { clearAuthCookies, getAuthCookieOptions } from '../utils/authCookies';

describe('authCookies', () => {
  test('derives secure cookies from forwarded https requests', () => {
    const req = {
      headers: {
        'x-forwarded-proto': 'https',
      },
    } as any;

    expect(getAuthCookieOptions(req)).toEqual(
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
      })
    );
  });

  test('clearAuthCookies clears both auth cookies with matching options', () => {
    const req = {
      headers: {
        'x-forwarded-proto': 'https',
      },
    } as any;
    const res = {
      clearCookie: jest.fn(),
    } as any;

    clearAuthCookies(req, res);

    expect(res.clearCookie).toHaveBeenCalledTimes(2);
    expect(res.clearCookie).toHaveBeenNthCalledWith(
      1,
      'accessToken',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
      })
    );
    expect(res.clearCookie).toHaveBeenNthCalledWith(
      2,
      'refreshToken',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
      })
    );
  });
});
