import { parseSafeCookieHeader } from '../utils/safeCookies';

describe('raw cookie parsing', () => {
  test('decodes valid cookie values', () => {
    expect(parseSafeCookieHeader('accessToken=abc%2Edef; theme=dark')).toEqual({
      accessToken: 'abc.def',
      theme: 'dark',
    });
  });

  test('ignores malformed percent encoding without throwing or losing valid pairs', () => {
    expect(() => parseSafeCookieHeader('broken=%E0%A4%A; accessToken=valid-token')).not.toThrow();
    expect(parseSafeCookieHeader('broken=%E0%A4%A; accessToken=valid-token')).toEqual({
      accessToken: 'valid-token',
    });
  });

  test('rejects oversized headers, excessive pairs, control characters, and invalid names', () => {
    expect(parseSafeCookieHeader(`accessToken=${'x'.repeat(17 * 1024)}`)).toEqual({});
    expect(parseSafeCookieHeader(Array.from({ length: 129 }, (_, index) => `c${index}=x`).join(';'))).toEqual({});
    expect(parseSafeCookieHeader('bad name=value; accessToken=line%0Abreak')).toEqual({});
  });
});
