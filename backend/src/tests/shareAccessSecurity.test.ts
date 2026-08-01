import {
  SharePasswordAttemptLimiter,
  isValidShareToken,
  issueShareGrant,
  parseShareLinkOptions,
  shareLinkAvailability,
  shareGrantCookieName,
  sharePasswordBinding,
  validateSharePassword,
  verifyShareGrant,
} from '../utils/shareAccessSecurity';

describe('share access security', () => {
  const token = 'abcDEF0123456789_share';

  test('strictly validates share-link lifecycle options', () => {
    const now = 1_700_000_000_000;
    expect(parseShareLinkOptions({ expiresAt: new Date(now + 60_000).toISOString(), maxUses: '3' }, now))
      .toEqual({ expiresAt: new Date(now + 60_000), maxUses: 3 });
    expect(parseShareLinkOptions({}, now)).toEqual({ expiresAt: null, maxUses: null });
    expect(() => parseShareLinkOptions({ expiresAt: new Date(now - 1).toISOString() }, now)).toThrow('future date');
    expect(() => parseShareLinkOptions({ maxUses: 0 }, now)).toThrow('Max uses');
    expect(() => parseShareLinkOptions({ maxUses: 1.5 }, now)).toThrow('Max uses');
  });

  test('reports disabled, expired, and exhausted links as unavailable', () => {
    const now = 1_700_000_000_000;
    expect(shareLinkAvailability({ isActive: true, expiresAt: new Date(now + 1), maxUses: 2, currentUses: 1 }, now)).toBe('active');
    expect(shareLinkAvailability({ isActive: false }, now)).toBe('disabled');
    expect(shareLinkAvailability({ isActive: true, expiresAt: new Date(now) }, now)).toBe('expired');
    expect(shareLinkAvailability({ isActive: true, maxUses: 2, currentUses: 2 }, now)).toBe('exhausted');
  });

  test('rejects malformed tokens and bcrypt-truncating passwords', () => {
    expect(isValidShareToken(token)).toBe(true);
    expect(isValidShareToken('../short')).toBe(false);
    expect(validateSharePassword('correct horse battery staple')).toBe('correct horse battery staple');
    expect(() => validateSharePassword('short')).toThrow();
    expect(() => validateSharePassword('é'.repeat(37))).toThrow('72 UTF-8 bytes');
  });

  test('signs grants for one link, token, kind, and expiry', () => {
    const now = 1_700_000_000_000;
    const grant = issueShareGrant({
      kind: 'visit',
      token,
      linkId: 'link-1',
      expiresAt: now + 60_000,
    }, 'secret', now);
    expect(verifyShareGrant(grant, { kind: 'visit', token, linkId: 'link-1' }, 'secret', now)).toBe(true);
    expect(verifyShareGrant(grant, { kind: 'password', token, linkId: 'link-1' }, 'secret', now)).toBe(false);
    expect(verifyShareGrant(grant, { kind: 'visit', token, linkId: 'link-2' }, 'secret', now)).toBe(false);
    expect(verifyShareGrant(grant, { kind: 'visit', token, linkId: 'link-1' }, 'secret', now + 60_001)).toBe(false);
    expect(shareGrantCookieName('visit', token)).toMatch(/^share_visit_[a-f0-9]{24}$/);

    const passwordGrant = issueShareGrant({
      kind: 'password',
      token,
      linkId: 'link-1',
      binding: sharePasswordBinding('bcrypt-hash-v1'),
      expiresAt: now + 60_000,
    }, 'secret', now);
    expect(verifyShareGrant(passwordGrant, {
      kind: 'password', token, linkId: 'link-1', binding: sharePasswordBinding('bcrypt-hash-v1'),
    }, 'secret', now)).toBe(true);
    expect(verifyShareGrant(passwordGrant, {
      kind: 'password', token, linkId: 'link-1', binding: sharePasswordBinding('bcrypt-hash-v2'),
    }, 'secret', now)).toBe(false);
  });

  test('bounds password attempts per IP/link and across distributed IPs', () => {
    const limiter = new SharePasswordAttemptLimiter();
    const now = 1_700_000_000_000;

    for (let index = 0; index < 5; index += 1) {
      expect(limiter.begin('192.0.2.1', token, now).allowed).toBe(true);
    }
    expect(limiter.begin('192.0.2.1', token, now)).toEqual(expect.objectContaining({ allowed: false }));

    const distributed = new SharePasswordAttemptLimiter();
    for (let index = 0; index < 25; index += 1) {
      expect(distributed.begin(`198.51.100.${index}`, token, now).allowed).toBe(true);
    }
    expect(distributed.begin('203.0.113.50', token, now)).toEqual(expect.objectContaining({ allowed: false }));

    const successful = new SharePasswordAttemptLimiter();
    expect(successful.begin('192.0.2.2', token, now).allowed).toBe(true);
    successful.success('192.0.2.2', token);
    expect(successful.begin('192.0.2.2', token, now).allowed).toBe(true);
  });
});
