import crypto from 'crypto';
import type { Request } from 'express';

const HOSTED_TICKET_MAX_TTL_MS = 2 * 60 * 1000;
const HOSTED_SESSION_MAX_TTL_MS = 2 * 60 * 60 * 1000;

export type HostedAccessKind = 'ticket' | 'session';

interface HostedAccessPayload {
  v: 2;
  kind: HostedAccessKind;
  deployId: string;
  /** Current workspace owner whose deployed app is being accessed. */
  userId: string;
  /** Authenticated actor who received this capability. */
  actorUserId: string;
  authorizationVersion: number;
  nonce?: string;
  expiresAt: number;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '127.0.0.1'
    || normalized === '::1';
}

/**
 * Active app HTML/JS must live on an origin distinct from the authenticated
 * Portal. When no valid origin is configured, app content fails closed.
 */
export function configuredAppContentOrigin(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = String(environment.APP_CONTENT_ORIGIN || '').trim();
  if (!raw || raw.length > 512 || /[\r\n]/.test(raw)) return undefined;

  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    if (parsed.pathname && parsed.pathname !== '/') return undefined;
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/**
 * The authenticated Portal origin, for bouncing an unauthenticated hosted-app
 * visit back through the Portal so it can mint an access ticket.
 */
export function configuredPortalOrigin(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const domain = String(environment.PORTAL_PUBLIC_ORIGIN || environment.DOMAIN || '').trim();
  if (!domain || domain.length > 512 || /[\s\r\n\\/]/.test(domain.replace(/^https?:\/\//, ''))) return undefined;
  try {
    const parsed = new URL(domain.includes('://') ? domain : `https://${domain}`);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

export function effectiveRequestOrigin(req: Pick<Request, 'protocol' | 'headers' | 'get'>): string | undefined {
  const host = String(req.get('host') || '').trim();
  if (!host || /[\s\\/]/.test(host)) return undefined;
  try {
    return new URL(`${req.protocol}://${host}`).origin;
  } catch {
    return undefined;
  }
}

export function isAppContentRequest(
  req: Pick<Request, 'protocol' | 'headers' | 'get'>,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = configuredAppContentOrigin(environment);
  const current = effectiveRequestOrigin(req);
  return Boolean(configured && current && configured === current);
}

export function appContentRedirectUrl(
  originalUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const origin = configuredAppContentOrigin(environment);
  if (!origin || !originalUrl.startsWith('/') || originalUrl.startsWith('//')) return undefined;
  try {
    return new URL(originalUrl, `${origin}/`).toString();
  } catch {
    return undefined;
  }
}

export function appContentIsolationIsDistinct(
  portalOrigins: string[],
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const appOrigin = configuredAppContentOrigin(environment);
  if (!appOrigin) return false;
  return appContentOriginIsDistinct(portalOrigins, appOrigin);
}

/**
 * Validate a candidate app-content origin without mutating process.env. This
 * is shared by the installer/domain control plane so it cannot accidentally
 * provision a sibling hostname or alternate port that still shares Portal
 * cookie scope.
 */
export function appContentOriginIsDistinct(
  portalOrigins: string[],
  candidateOrigin: string,
): boolean {
  const appOrigin = configuredAppContentOrigin({ APP_CONTENT_ORIGIN: candidateOrigin } as NodeJS.ProcessEnv);
  if (!appOrigin) return false;
  const appUrl = new URL(appOrigin);
  // A different port or sibling subdomain is a different browser origin but
  // still shares cookie scope/site semantics. Require a different site for
  // production hosts so an app cannot shadow Portal auth cookies with Domain
  // cookies. The compact last-two-label check is intentionally conservative;
  // custom public-suffix deployments can use an entirely separate domain.
  const siteKey = (hostname: string) => {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (isLoopbackHost(normalized) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return normalized;
    const labels = normalized.split('.').filter(Boolean);
    return labels.slice(-2).join('.');
  };
  return !portalOrigins.some((origin) => {
    try {
      const portalUrl = new URL(origin);
      return portalUrl.origin === appOrigin
        || portalUrl.hostname === appUrl.hostname
        || siteKey(portalUrl.hostname) === siteKey(appUrl.hostname);
    } catch {
      return false;
    }
  });
}

function unsafeMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(method.toUpperCase());
}

/**
 * Cookie-authenticated Portal API mutations require a same-origin browser
 * request. This prevents an isolated (including same-site subdomain) app from
 * using a form/fetch as a CSRF primitive against the Portal.
 */
export function rejectCookieAuthenticatedCrossOriginMutation(
  req: Pick<Request, 'method' | 'path' | 'protocol' | 'headers' | 'get'> & { cookies?: Record<string, unknown> },
): boolean {
  if (!unsafeMethod(req.method) || !(req.path === '/api' || req.path.startsWith('/api/'))) return false;
  if (!req.cookies?.accessToken && !req.cookies?.refreshToken) return false;

  const authorization = String(req.headers.authorization || '');
  if (/^Bearer\s+\S+/i.test(authorization)) return false;

  const expectedOrigin = effectiveRequestOrigin(req);
  const suppliedOrigin = String(req.headers.origin || '').trim();
  if (!expectedOrigin || !suppliedOrigin) return true;

  try {
    if (new URL(suppliedOrigin).origin !== expectedOrigin) return true;
  } catch {
    return true;
  }

  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  return Boolean(fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none');
}

function signEncodedPayload(encodedPayload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

export function issueHostedAccessToken(
  payload: Omit<HostedAccessPayload, 'v'>,
  secret: string,
  now = Date.now(),
): string {
  const maxTtl = payload.kind === 'ticket' ? HOSTED_TICKET_MAX_TTL_MS : HOSTED_SESSION_MAX_TTL_MS;
  if (!payload.deployId
    || !payload.userId
    || !payload.actorUserId
    || !Number.isSafeInteger(payload.authorizationVersion)
    || payload.authorizationVersion < 1
    || payload.expiresAt <= now
    || payload.expiresAt - now > maxTtl) {
    throw new Error('Invalid hosted app access payload');
  }
  const nonce = payload.kind === 'ticket' ? crypto.randomBytes(16).toString('base64url') : undefined;
  const encoded = Buffer.from(JSON.stringify({ v: 2, ...payload, nonce } satisfies HostedAccessPayload)).toString('base64url');
  return `${encoded}.${signEncodedPayload(encoded, secret)}`;
}

export function verifyHostedAccessToken(
  token: unknown,
  expected: { kind: HostedAccessKind; deployId: string },
  secret: string,
  now = Date.now(),
): HostedAccessPayload | null {
  try {
    if (typeof token !== 'string' || token.length > 2048) return null;
    const [encoded, suppliedSignature, extra] = token.split('.');
    if (!encoded || !suppliedSignature || extra) return null;
    const expectedSignature = signEncodedPayload(encoded, secret);
    const supplied = Buffer.from(suppliedSignature, 'base64url');
    const wanted = Buffer.from(expectedSignature, 'base64url');
    if (supplied.length !== wanted.length || !crypto.timingSafeEqual(supplied, wanted)) return null;

    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as HostedAccessPayload;
    const maxTtl = expected.kind === 'ticket' ? HOSTED_TICKET_MAX_TTL_MS : HOSTED_SESSION_MAX_TTL_MS;
    if (parsed.v !== 2 || parsed.kind !== expected.kind || parsed.deployId !== expected.deployId) return null;
    if (typeof parsed.userId !== 'string' || !parsed.userId) return null;
    if (typeof parsed.actorUserId !== 'string' || !parsed.actorUserId) return null;
    if (!Number.isSafeInteger(parsed.authorizationVersion) || parsed.authorizationVersion < 1) return null;
    if (expected.kind === 'ticket' && (typeof parsed.nonce !== 'string' || !/^[A-Za-z0-9_-]{20,32}$/.test(parsed.nonce))) return null;
    if (!Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= now || parsed.expiresAt - now > maxTtl) return null;
    return parsed;
  } catch {
    return null;
  }
}

export class HostedTicketReplayGuard {
  private readonly consumed = new Map<string, number>();
  constructor(private readonly maxEntries = 10_000) {}

  consume(ticket: string, expiresAt: number, now = Date.now()): boolean {
    for (const [digest, expiry] of this.consumed) {
      if (expiry <= now) this.consumed.delete(digest);
    }
    const digest = crypto.createHash('sha256').update(ticket).digest('hex');
    if (this.consumed.has(digest)) return false;
    while (this.consumed.size >= this.maxEntries) {
      const oldest = this.consumed.keys().next().value as string | undefined;
      if (!oldest) break;
      this.consumed.delete(oldest);
    }
    this.consumed.set(digest, expiresAt);
    return true;
  }

  get size(): number {
    return this.consumed.size;
  }
}

export function hostedAccessCookieName(deployId: string): string {
  return `hosted_access_${crypto.createHash('sha256').update(deployId).digest('hex').slice(0, 24)}`;
}

export const __appContentSecurityTest = {
  HOSTED_TICKET_MAX_TTL_MS,
  HOSTED_SESSION_MAX_TTL_MS,
};
