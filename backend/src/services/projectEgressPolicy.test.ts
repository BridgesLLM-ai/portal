import {
  PROJECT_EGRESS_BLOCKED_IPV4_CIDRS,
  PROJECT_EGRESS_BLOCKED_IPV6_CIDRS,
  ProjectEgressPolicyError,
  isPublicProjectEgressAddress,
  parseProjectEgressUrl,
  resolveProjectEgressTarget,
} from './projectEgressPolicy';

describe('project egress target policy', () => {
  test.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
  ])('accepts globally routable address %s', (address) => {
    expect(isPublicProjectEgressAddress(address)).toBe(true);
  });

  test.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '169.254.169.254',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '100::1',
    '2001::1',
    '2001:db8::1',
    '2002:0808:0808::1',
    '3fff::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    'not-an-ip',
  ])('denies non-global or transition address %s', (address) => {
    expect(isPublicProjectEgressAddress(address)).toBe(false);
  });

  test('exports explicit firewall deny sets for both address families', () => {
    expect(PROJECT_EGRESS_BLOCKED_IPV4_CIDRS).toEqual(expect.arrayContaining([
      '10.0.0.0/8',
      '100.64.0.0/10',
      '127.0.0.0/8',
      '169.254.0.0/16',
      '172.16.0.0/12',
      '192.168.0.0/16',
    ]));
    expect(PROJECT_EGRESS_BLOCKED_IPV6_CIDRS).toEqual(expect.arrayContaining([
      '::1/128',
      '::ffff:0:0/96',
      'fc00::/7',
      'fe80::/10',
    ]));
  });

  test('applies host-specific and Docker-specific deny CIDRs after global validation', () => {
    expect(isPublicProjectEgressAddress('8.8.8.8', ['8.8.8.8/32'])).toBe(false);
    expect(isPublicProjectEgressAddress('2606:4700:4700::1111', ['2606:4700:4700::/48'])).toBe(false);
    expect(() => isPublicProjectEgressAddress('8.8.8.8', ['bad-cidr'])).toThrow('Invalid project egress deny CIDR');
  });

  test.each([
    ['ftp://example.com/file', 'UNSUPPORTED_SCHEME'],
    ['file:///etc/passwd', 'UNSUPPORTED_SCHEME'],
    ['http://user:password@example.com/', 'URL_CREDENTIALS'],
    ['http://example.com:8080/', 'DISALLOWED_PORT'],
    ['https://example.com:8443/', 'DISALLOWED_PORT'],
    ['http://localhost/', 'INVALID_HOST'],
    ['http://service.internal/', 'PRIVATE_HOSTNAME'],
    ['http://printer.local/', 'PRIVATE_HOSTNAME'],
    ['http://example.com\u0000/', 'INVALID_URL'],
  ])('rejects unsafe URL %s with %s', (url, code) => {
    try {
      parseProjectEgressUrl(url);
      throw new Error('expected policy rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectEgressPolicyError);
      expect((error as ProjectEgressPolicyError).code).toBe(code);
    }
  });

  test('normalizes public IDN hosts, strips fragments, and preserves only default ports', () => {
    const parsed = parseProjectEgressUrl('https://BÜCHER.de./path?q=1#secret');
    expect(parsed.hostname).toBe('xn--bcher-kva.de');
    expect(parsed.port).toBe(443);
    expect(parsed.url.href).toBe('https://xn--bcher-kva.de/path?q=1');
  });

  test('rejects a mixed public/private DNS answer instead of selecting the public result', async () => {
    const resolver = jest.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '169.254.169.254', family: 4 as const },
    ]);
    await expect(resolveProjectEgressTarget('https://example.com/', { resolver }))
      .rejects.toMatchObject({ code: 'DNS_NON_PUBLIC' });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  test('rejects empty, malformed, and family-mismatched DNS answers', async () => {
    await expect(resolveProjectEgressTarget('https://example.com/', { resolver: async () => [] }))
      .rejects.toMatchObject({ code: 'DNS_EMPTY' });
    await expect(resolveProjectEgressTarget('https://example.com/', {
      resolver: async () => [{ address: 'garbage', family: 4 }],
    })).rejects.toMatchObject({ code: 'DNS_INVALID' });
    await expect(resolveProjectEgressTarget('https://example.com/', {
      resolver: async () => [{ address: '8.8.8.8', family: 6 }],
    })).rejects.toMatchObject({ code: 'DNS_INVALID' });
  });

  test('resolves once, validates every answer, and pins a deterministic exact IP', async () => {
    const resolver = jest.fn(async () => [
      { address: '2606:4700:4700::1111', family: 6 as const },
      { address: '93.184.216.35', family: 4 as const },
      { address: '93.184.216.34', family: 4 as const },
      { address: '93.184.216.34', family: 4 as const },
    ]);
    const target = await resolveProjectEgressTarget('https://example.com/download', { resolver });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(target.addresses).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    expect(target.selectedAddress).toBe('93.184.216.34');
    expect(target.selectedFamily).toBe(4);
  });

  test('normalizes ambiguous numeric IPv4 syntax before denying loopback', async () => {
    await expect(resolveProjectEgressTarget('http://2130706433/', {
      resolver: async (hostname) => [{ address: hostname, family: 4 }],
    })).rejects.toMatchObject({ code: 'DNS_NON_PUBLIC' });
  });
});
