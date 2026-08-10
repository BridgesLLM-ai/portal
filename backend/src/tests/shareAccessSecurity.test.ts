import fs from 'fs';
import path from 'path';
import {
  SharePasswordAttemptLimiter,
  __shareAccessSecurityTest,
  isValidShareToken,
  issueShareGrant,
  parseShareLinkOptions,
  shareCredentialStateIsValid,
  shareLinkAvailability,
  shareGrantCookieName,
  shareGrantTtlMs,
  sharePasswordBinding,
  validateSharePassword,
  verifyShareGrant,
} from '../utils/shareAccessSecurity';

describe('share access security', () => {
  const token = 'abcDEF0123456789_share';

  test('strictly validates share-link lifecycle options', () => {
    const now = 1_700_000_000_000;
    expect(parseShareLinkOptions({
      expiresAt: new Date(now + 60_000).toISOString(),
      maxUses: '3',
      rateLimitMaxRequests: '25',
      rateLimitWindowSeconds: '300',
    }, now)).toEqual({
      expiresAt: new Date(now + 60_000),
      maxUses: 3,
      rateLimitMaxRequests: 25,
      rateLimitWindowSeconds: 300,
    });
    expect(parseShareLinkOptions({}, now)).toEqual({
      expiresAt: null,
      maxUses: null,
      rateLimitMaxRequests: null,
      rateLimitWindowSeconds: null,
    });
    expect(parseShareLinkOptions({ rateLimitMaxRequests: 10 }, now)).toEqual({
      expiresAt: null,
      maxUses: null,
      rateLimitMaxRequests: 10,
      rateLimitWindowSeconds: 60,
    });
    expect(() => parseShareLinkOptions({ expiresAt: new Date(now - 1).toISOString() }, now)).toThrow('future date');
    expect(() => parseShareLinkOptions({ maxUses: 0 }, now)).toThrow('Max uses');
    expect(() => parseShareLinkOptions({ maxUses: 1.5 }, now)).toThrow('Max uses');
    expect(() => parseShareLinkOptions({ rateLimitMaxRequests: 0 }, now)).toThrow('Rate limit requests');
    expect(() => parseShareLinkOptions({ rateLimitMaxRequests: 1.5 }, now)).toThrow('Rate limit requests');
    expect(() => parseShareLinkOptions({ rateLimitMaxRequests: 1_000_001 }, now)).toThrow('Rate limit requests');
    expect(() => parseShareLinkOptions({ rateLimitWindowSeconds: 60 }, now)).toThrow('request count is required');
    expect(() => parseShareLinkOptions({ rateLimitMaxRequests: 10, rateLimitWindowSeconds: 30 }, now)).toThrow('60, 300, or 3600');
    expect(() => parseShareLinkOptions({ rateLimitMaxRequests: 10, rateLimitWindowSeconds: 60.5 }, now)).toThrow('60, 300, or 3600');
  });

  test('reports disabled, expired, and exhausted links as unavailable', () => {
    const now = 1_700_000_000_000;
    expect(shareLinkAvailability({ isActive: true, expiresAt: new Date(now + 1), maxUses: 2, currentUses: 1 }, now)).toBe('active');
    expect(shareLinkAvailability({ isActive: false }, now)).toBe('disabled');
    expect(shareLinkAvailability({ isActive: true, expiresAt: new Date(now) }, now)).toBe('expired');
    expect(shareLinkAvailability({ isActive: true, maxUses: 2, currentUses: 2 }, now)).toBe('exhausted');
  });

  test('accepts exactly one coherent public or private credential state', () => {
    expect(shareCredentialStateIsValid({ isPublic: true, passwordHash: null })).toBe(true);
    expect(shareCredentialStateIsValid({ isPublic: false, passwordHash: 'bcrypt-hash' })).toBe(true);

    expect(shareCredentialStateIsValid({ isPublic: true, passwordHash: '' })).toBe(false);
    expect(shareCredentialStateIsValid({ isPublic: true, passwordHash: 'bcrypt-hash' })).toBe(false);
    expect(shareCredentialStateIsValid({ isPublic: false, passwordHash: null })).toBe(false);
    expect(shareCredentialStateIsValid({ isPublic: false, passwordHash: '' })).toBe(false);
    expect(shareCredentialStateIsValid({ isPublic: true })).toBe(false);
    expect(shareCredentialStateIsValid({ isPublic: false })).toBe(false);
  });

  test('migration disables and normalizes legacy credential drift before adding the exact DB invariant', () => {
    const migrationPath = path.resolve(
      __dirname,
      '../../prisma/migrations/20260808_share_link_rate_limits/migration.sql',
    );
    const migration = fs.readFileSync(migrationPath, 'utf8');
    const compact = migration.replace(/\s+/g, ' ');

    expect(migration.indexOf('UPDATE "AppShareLink"')).toBeLessThan(
      migration.indexOf('ADD CONSTRAINT "AppShareLink_credential_state_check"'),
    );
    expect(compact).toContain(
      '"isPublic" = false AND ("passwordHash" IS NULL OR length("passwordHash") = 0)',
    );
    expect(compact).toContain('"isPublic" = true AND "passwordHash" = \'\'');
    expect(compact).toContain(
      'SET "isActive" = false, "isPublic" = false WHERE "isPublic" = true AND "passwordHash" IS NOT NULL AND length("passwordHash") > 0',
    );
    expect(compact).toContain(
      '("isPublic" = true AND "passwordHash" IS NULL) OR ( "isPublic" = false AND "passwordHash" IS NOT NULL AND length("passwordHash") > 0 )',
    );
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

  test('keeps visitor slots for 30 days while password grants expire after one hour', () => {
    const now = 1_700_000_000_000;
    expect(shareGrantTtlMs('visit')).toBe(30 * 24 * 60 * 60 * 1000);
    expect(shareGrantTtlMs('password')).toBe(60 * 60 * 1000);
    expect(__shareAccessSecurityTest.SHARE_VISIT_GRANT_TTL_MS).toBe(shareGrantTtlMs('visit'));
    expect(__shareAccessSecurityTest.SHARE_PASSWORD_GRANT_TTL_MS).toBe(shareGrantTtlMs('password'));

    expect(() => issueShareGrant({
      kind: 'visit', token, linkId: 'link-1', expiresAt: now + shareGrantTtlMs('visit'),
    }, 'secret', now)).not.toThrow();
    expect(() => issueShareGrant({
      kind: 'visit', token, linkId: 'link-1', expiresAt: now + shareGrantTtlMs('visit') + 1,
    }, 'secret', now)).toThrow('Invalid share access grant');
    expect(() => issueShareGrant({
      kind: 'password', token, linkId: 'link-1', expiresAt: now + shareGrantTtlMs('password'),
    }, 'secret', now)).not.toThrow();
    expect(() => issueShareGrant({
      kind: 'password', token, linkId: 'link-1', expiresAt: now + shareGrantTtlMs('password') + 1,
    }, 'secret', now)).toThrow('Invalid share access grant');
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
