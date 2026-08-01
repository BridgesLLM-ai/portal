import { extractIP, lookupGeo } from '../utils/auth-tracking';
import type { Request } from 'express';

describe('auth tracking GeoIP metadata', () => {
  test('uses only Express canonical req.ip and ignores spoofed forwarding headers', () => {
    const req = {
      ip: '198.51.100.8',
      headers: {
        'x-forwarded-for': '203.0.113.99',
        'cf-connecting-ip': '203.0.113.77',
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    expect(extractIP(req)).toBe('198.51.100.8');
  });

  test('normalizes IPv4-mapped addresses and rejects non-IP proxy values', () => {
    expect(extractIP({ ip: '::ffff:192.0.2.7', socket: {} } as unknown as Request)).toBe('192.0.2.7');
    expect(extractIP({ ip: 'attacker-controlled', socket: {} } as unknown as Request)).toBe('unknown');
  });

  test.each(['127.0.0.1', '::1', '10.2.3.4', '172.20.1.2', '192.168.2.4', 'fd00::1'])(
    'recognizes local address %s without a database lookup',
    (ip) => expect(lookupGeo(ip).summary).toBe('Local Network'),
  );

  test('uses bounded Cloudflare location headers for display metadata', () => {
    expect(lookupGeo('203.0.113.8', {
      'cf-ray': 'abc-IAD',
      'cf-connecting-ip': '203.0.113.8',
      'cf-ipcity': 'Richmond%20City',
      'cf-region-code': 'VA',
      'cf-ipcountry': 'US',
    })).toEqual({
      city: 'Richmond City',
      region: 'VA',
      country: 'US',
      summary: 'Richmond City, VA, US',
    });
  });

  test('does not trust standalone geolocation headers outside Cloudflare context', () => {
    expect(lookupGeo('203.0.113.8', { 'cf-ipcountry': 'US' })).toEqual({
      city: '',
      region: '',
      country: '',
      summary: 'Unknown location',
    });
  });

  test('drops control characters and Cloudflare unknown-country markers', () => {
    expect(lookupGeo('203.0.113.8', {
      'cf-ray': 'abc-IAD',
      'cf-ipcity': 'Bad%00City',
      'cf-ipcountry': 'T1',
    })).toEqual({
      city: 'BadCity',
      region: '',
      country: '',
      summary: 'BadCity',
    });
  });
});
