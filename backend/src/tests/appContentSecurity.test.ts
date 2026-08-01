import {
  __appContentSecurityTest,
  appContentIsolationIsDistinct,
  appContentRedirectUrl,
  configuredAppContentOrigin,
  hostedAccessCookieName,
  HostedTicketReplayGuard,
  isAppContentRequest,
  issueHostedAccessToken,
  rejectCookieAuthenticatedCrossOriginMutation,
  verifyHostedAccessToken,
} from '../utils/appContentSecurity';
import fs from 'fs';
import path from 'path';

const serverSource = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

function request(overrides: Record<string, any> = {}): any {
  const headers = overrides.headers || {};
  return {
    method: 'GET',
    path: '/',
    protocol: 'https',
    headers,
    cookies: {},
    get(name: string) {
      if (name.toLowerCase() === 'host') return headers.host || 'portal.example';
      return headers[name.toLowerCase()];
    },
    ...overrides,
  };
}

describe('isolated app-content origin', () => {
  const environment = { APP_CONTENT_ORIGIN: 'https://apps.example.net' };

  test('requires an explicit HTTPS origin distinct from the Portal', () => {
    expect(configuredAppContentOrigin(environment)).toBe('https://apps.example.net');
    expect(configuredAppContentOrigin({ APP_CONTENT_ORIGIN: 'https://apps.example.net/path' })).toBeUndefined();
    expect(configuredAppContentOrigin({ APP_CONTENT_ORIGIN: 'http://apps.example.net' })).toBeUndefined();
    expect(configuredAppContentOrigin({ APP_CONTENT_ORIGIN: 'http://127.0.0.1:4010' })).toBe('http://127.0.0.1:4010');
    expect(configuredAppContentOrigin({ APP_CONTENT_ORIGIN: 'http://apps.localhost:4010' })).toBe('http://apps.localhost:4010');
    expect(appContentIsolationIsDistinct(['https://portal.example'], environment)).toBe(true);
    expect(appContentIsolationIsDistinct(['https://apps.example.net'], environment)).toBe(false);
    expect(appContentIsolationIsDistinct(['https://portal.example'], {
      APP_CONTENT_ORIGIN: 'https://apps.portal.example',
    })).toBe(false);
  });

  test('recognizes and redirects only to the configured content origin', () => {
    expect(isAppContentRequest(request({ headers: { host: 'apps.example.net' } }), environment)).toBe(true);
    expect(isAppContentRequest(request({ headers: { host: 'portal.example' } }), environment)).toBe(false);
    expect(appContentRedirectUrl('/share/token/path?x=1', environment))
      .toBe('https://apps.example.net/share/token/path?x=1');
    expect(appContentRedirectUrl('//attacker.example/path', environment)).toBeUndefined();
  });

  test('rejects cookie-authenticated cross-origin mutations, including same-site subdomains', () => {
    const base = {
      method: 'POST',
      path: '/api/projects',
      cookies: { accessToken: 'http-only-cookie' },
    };
    expect(rejectCookieAuthenticatedCrossOriginMutation(request({
      ...base,
      headers: { host: 'portal.example', origin: 'https://apps.portal.example', 'sec-fetch-site': 'same-site' },
    }))).toBe(true);
    expect(rejectCookieAuthenticatedCrossOriginMutation(request({
      ...base,
      headers: { host: 'portal.example', origin: 'https://portal.example', 'sec-fetch-site': 'same-origin' },
    }))).toBe(false);
    expect(rejectCookieAuthenticatedCrossOriginMutation(request({
      ...base,
      headers: { host: 'portal.example', authorization: 'Bearer external-client-token' },
    }))).toBe(false);
  });

  test('binds hosted tickets and sessions to one deploy id, user, kind, and expiry', () => {
    const now = 1_700_000_000_000;
    const ticket = issueHostedAccessToken({
      kind: 'ticket',
      deployId: 'user-app',
      userId: 'user',
      actorUserId: 'actor',
      authorizationVersion: 7,
      expiresAt: now + 60_000,
    }, 'secret', now);
    expect(verifyHostedAccessToken(ticket, { kind: 'ticket', deployId: 'user-app' }, 'secret', now))
      .toEqual(expect.objectContaining({
        userId: 'user',
        actorUserId: 'actor',
        authorizationVersion: 7,
      }));
    expect(verifyHostedAccessToken(ticket, { kind: 'ticket', deployId: 'other-app' }, 'secret', now)).toBeNull();
    expect(verifyHostedAccessToken(ticket, { kind: 'session', deployId: 'user-app' }, 'secret', now)).toBeNull();
    expect(verifyHostedAccessToken(`${ticket}x`, { kind: 'ticket', deployId: 'user-app' }, 'secret', now)).toBeNull();
    expect(verifyHostedAccessToken(ticket, { kind: 'ticket', deployId: 'user-app' }, 'secret', now + 60_001)).toBeNull();
    expect(() => issueHostedAccessToken({
      kind: 'ticket',
      deployId: 'user-app',
      userId: 'user',
      actorUserId: 'actor',
      authorizationVersion: 7,
      expiresAt: now + __appContentSecurityTest.HOSTED_TICKET_MAX_TTL_MS + 1,
    }, 'secret', now)).toThrow();
    expect(hostedAccessCookieName('user-app')).toMatch(/^hosted_access_[a-f0-9]{24}$/);

    const replayGuard = new HostedTicketReplayGuard(2);
    const verified = verifyHostedAccessToken(ticket, { kind: 'ticket', deployId: 'user-app' }, 'secret', now)!;
    expect(replayGuard.consume(ticket, verified.expiresAt, now)).toBe(true);
    expect(replayGuard.consume(ticket, verified.expiresAt, now)).toBe(false);
  });

  test('revalidates the actor generation and current workspace owner on every hosted-app capability use', () => {
    const helperStart = serverSource.indexOf('async function findHostedAppForAuthorizedCapability');
    const helperEnd = serverSource.indexOf('/**', helperStart);
    const helper = serverSource.slice(helperStart, helperEnd);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helper).toContain('capability.actorUserId');
    expect(helper).toContain('authorizationVersion: true');
    expect(helper).toContain('capability.authorizationVersion');
    expect(helper).toContain('await getWorkspaceOwnerId');
    expect(helper).toContain('currentOwnerId !== capability.userId');
    expect(serverSource.match(/findHostedAppForAuthorizedCapability\(/g)?.length).toBeGreaterThanOrEqual(4);
    expect(serverSource.match(/admitWorkspaceAuthorizationRead\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(serverSource).toContain('admitWorkspaceAuthorizationMutation(');
    expect(serverSource).toContain('settleWorkspaceAuthorizationRequestIfResponseEnded(req, res)');
    expect(serverSource).toContain('actorUserId: req.user!.userId');
    expect(serverSource).toContain('authorizationVersion: Number(req.user!.authorizationVersion ?? 1)');
  });
});
