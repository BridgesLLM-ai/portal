import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  SharePasswordAttemptLimiter,
  __shareAccessSecurityTest,
  isValidShareToken,
  issueShareGrant,
  parseShareLinkOptions,
  parseShareLinkPolicyPatch,
  shareCredentialStateIsValid,
  shareLinkAvailability,
  shareGrantCookieName,
  shareGrantTtlMs,
  sharePasswordBinding,
  shareVisitorIdentityHash,
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
      maxConcurrentVisitors: '10',
    }, now)).toEqual({
      expiresAt: new Date(now + 60_000),
      maxUses: 3,
      rateLimitMaxRequests: 25,
      rateLimitWindowSeconds: 300,
      maxConcurrentVisitors: 10,
    });
    expect(parseShareLinkOptions({}, now)).toEqual({
      expiresAt: null,
      maxUses: null,
      rateLimitMaxRequests: null,
      rateLimitWindowSeconds: null,
      maxConcurrentVisitors: null,
    });
    expect(parseShareLinkOptions({ rateLimitMaxRequests: 10 }, now)).toEqual({
      expiresAt: null,
      maxUses: null,
      rateLimitMaxRequests: 10,
      rateLimitWindowSeconds: 60,
      maxConcurrentVisitors: null,
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
    expect(() => parseShareLinkOptions({ maxConcurrentVisitors: 0 }, now)).toThrow('Concurrent visitors');
    expect(() => parseShareLinkOptions({ maxConcurrentVisitors: 10_001 }, now)).toThrow('Concurrent visitors');
  });

  test('edits only supplied policy fields and resets a changed durable rate window', () => {
    const now = 1_700_000_000_000;
    const current = {
      expiresAt: null,
      maxUses: 20,
      rateLimitMaxRequests: 30,
      rateLimitWindowSeconds: 60,
      maxConcurrentVisitors: 3,
    };
    expect(parseShareLinkPolicyPatch({
      maxUses: 10,
      maxConcurrentVisitors: null,
      rateLimitWindowSeconds: 300,
    }, current, now)).toEqual({
      maxUses: 10,
      maxConcurrentVisitors: null,
      rateLimitMaxRequests: 30,
      rateLimitWindowSeconds: 300,
      rateLimitRequestCount: 0,
      rateLimitWindowStartedAt: null,
    });
    expect(parseShareLinkPolicyPatch({ rateLimitMaxRequests: null }, current, now)).toEqual({
      rateLimitMaxRequests: null,
      rateLimitWindowSeconds: null,
      rateLimitRequestCount: 0,
      rateLimitWindowStartedAt: null,
    });
    expect(parseShareLinkPolicyPatch({ expiresAt: null }, current, now)).toEqual({ expiresAt: null });
    expect(() => parseShareLinkPolicyPatch({
      rateLimitMaxRequests: null,
      rateLimitWindowSeconds: 60,
    }, current, now)).toThrow('request count is required');
    expect(() => parseShareLinkPolicyPatch({
      maxConcurrentVisitors: 10_001,
    }, current, now)).toThrow('Concurrent visitors');
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

  test('share-serving diagnostics never interpolate the bearer capability', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/apps.ts'), 'utf8');
    expect(routeSource).not.toMatch(/Serving HTML with <base> tag:[^\n]*token:/);
    expect(routeSource).toContain('The share token is a bearer capability. Never write it to logs.');
  });

  test('both management surfaces persist editable limits and Project shares stay bounded', () => {
    const appsRoute = fs.readFileSync(path.resolve(__dirname, '../routes/apps.ts'), 'utf8');
    const projectsRoute = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
    expect(appsRoute).toContain('maxConcurrentVisitors: options.maxConcurrentVisitors');
    expect(appsRoute).toContain('parseShareLinkPolicyPatch(body');
    expect(appsRoute).toContain("action: hasPolicyUpdate\n          ? 'APP_SHARE_POLICY_UPDATE'");
    expect(projectsRoute).toContain('maxConcurrentVisitors: shareOptions.maxConcurrentVisitors');
    expect(projectsRoute).toContain('parseShareLinkPolicyPatch(body');
    expect(projectsRoute).toContain('if (!hasPolicyUpdate && !hasAccessUpdate)');
    expect(projectsRoute).toContain("typeof isPublic !== 'boolean'");
    expect(projectsRoute).toContain('existingShareCount >= MAX_SHARE_LINKS_PER_APP');
    expect(projectsRoute).toContain('parseShareLinkPagination(req.query)');
    expect(projectsRoute).toContain('take: paginationRequest.limit + 1');
    expect(projectsRoute).toContain('pagination: page.pagination');
  });

  test('every post-auth share content route uses durable concurrent admission', () => {
    const appsRoute = fs.readFileSync(path.resolve(__dirname, '../routes/apps.ts'), 'utf8');
    expect(appsRoute.match(/admitShareRequest\(req, res, (?:link|shareLink), \{ rateLimit: true \}\)/g))
      .toHaveLength(3);
    expect(appsRoute.match(/admitShareRequest\(req, res, (?:link|shareLink), \{ rateLimit: false \}\)/g))
      .toHaveLength(3);
    expect(appsRoute).toContain("code: 'SHARE_CONCURRENT_LIMITED'");
    expect(appsRoute).toContain("code: 'SHARE_CONCURRENT_UNAVAILABLE'");
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
    const visitorIdentity = shareVisitorIdentityHash(grant, { token, linkId: 'link-1' }, 'secret', now);
    expect(visitorIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(shareVisitorIdentityHash(grant, { token, linkId: 'link-1' }, 'secret', now)).toBe(visitorIdentity);
    const secondGrant = issueShareGrant({
      kind: 'visit', token, linkId: 'link-1', expiresAt: now + 60_000,
    }, 'secret', now);
    expect(secondGrant).not.toBe(grant);
    expect(shareVisitorIdentityHash(secondGrant, { token, linkId: 'link-1' }, 'secret', now))
      .not.toBe(visitorIdentity);

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

    // Existing v1 visitor cookies remain valid after the v2 visitor-id upgrade.
    const legacyPayload = Buffer.from(JSON.stringify({
      v: 1,
      kind: 'visit',
      token,
      linkId: 'link-1',
      expiresAt: now + 60_000,
    })).toString('base64url');
    const legacySignature = crypto.createHmac('sha256', 'secret').update(legacyPayload).digest('base64url');
    const legacyGrant = `${legacyPayload}.${legacySignature}`;
    expect(verifyShareGrant(legacyGrant, { kind: 'visit', token, linkId: 'link-1' }, 'secret', now)).toBe(true);
    expect(shareVisitorIdentityHash(legacyGrant, { token, linkId: 'link-1' }, 'secret', now))
      .toMatch(/^[0-9a-f]{64}$/);
  });

  test('concurrent lease migration stores only bounded digests and cascades link cleanup', () => {
    const migrationPath = path.resolve(
      __dirname,
      '../../prisma/migrations/20260820_share_concurrent_request_leases/migration.sql',
    );
    const migration = fs.readFileSync(migrationPath, 'utf8');
    expect(migration).toContain('"maxConcurrentVisitors" BETWEEN 1 AND 10000');
    expect(migration).toContain('"leaseExpiresAt" <= "createdAt" + INTERVAL \'6 minutes\'');
    expect(migration).toContain('ON DELETE CASCADE');
    expect(migration).toContain("CHECK (\"visitorIdHash\" ~ '^[0-9a-f]{64}$')");
    expect(migration).not.toMatch(/cookie|passwordHash|apiTarget|secret/i);
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
