import { appContentIsolationIsDistinct } from './appContentSecurity';

export type PortalOriginMode = 'domain' | 'local' | 'tailnet';
export type PortalFeatureName = 'mail' | 'appHosting';

export interface PortalFeatureAvailability {
  available: boolean;
  reason: string | null;
}

export interface PortalFeatureCapabilities {
  originMode: PortalOriginMode;
  experimental: boolean;
  privateNetworkOnly: boolean;
  mail: PortalFeatureAvailability;
  appHosting: PortalFeatureAvailability;
}

export class PortalFeatureUnavailableError extends Error {
  readonly code = 'PORTAL_FEATURE_UNAVAILABLE';
  readonly retryable = false;

  constructor(
    readonly feature: PortalFeatureName,
    message: string,
  ) {
    super(message);
    this.name = 'PortalFeatureUnavailableError';
  }
}

export const TAILNET_MAIL_UNAVAILABLE_REASON =
  'Mail requires a public domain and is unavailable in experimental private Tailnet mode.';
export const LOCAL_MAIL_UNAVAILABLE_REASON =
  'Mail requires a public domain and is unavailable in experimental local mode.';
export const TAILNET_APP_HOSTING_UNAVAILABLE_REASON =
  'Hosted apps and share links require a separate public app-content origin and are unavailable in experimental private Tailnet mode.';
export const APP_HOSTING_UNCONFIGURED_REASON =
  'Hosted apps and share links are unavailable until a separate app-content origin is configured.';

export function configuredPortalOriginMode(
  environment: NodeJS.ProcessEnv = process.env,
): PortalOriginMode {
  const originMode = String(environment.ORIGIN_MODE || '').trim().toLowerCase();
  if (originMode === 'tailnet') return 'tailnet';
  if (String(environment.INSTALL_PROFILE || '').trim().toLowerCase() === 'local') return 'local';
  return 'domain';
}

export function getPortalFeatureCapabilities(
  environment: NodeJS.ProcessEnv = process.env,
): PortalFeatureCapabilities {
  const originMode = configuredPortalOriginMode(environment);
  const tailnet = originMode === 'tailnet';
  const mailAvailable = originMode === 'domain';
  const portalOrigins = String(environment.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const appHostingAvailable = !tailnet
    && appContentIsolationIsDistinct(portalOrigins, environment);

  return {
    originMode,
    experimental: originMode !== 'domain',
    privateNetworkOnly: tailnet,
    mail: {
      available: mailAvailable,
      reason: mailAvailable
        ? null
        : tailnet
          ? TAILNET_MAIL_UNAVAILABLE_REASON
          : LOCAL_MAIL_UNAVAILABLE_REASON,
    },
    appHosting: {
      available: appHostingAvailable,
      reason: appHostingAvailable
        ? null
        : tailnet
          ? TAILNET_APP_HOSTING_UNAVAILABLE_REASON
          : APP_HOSTING_UNCONFIGURED_REASON,
    },
  };
}

export function portalFeatureUnavailableResponse(
  feature: PortalFeatureName,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const capability = getPortalFeatureCapabilities(environment)[feature];
  if (capability.available) return null;
  return {
    error: capability.reason || 'This feature is unavailable for the current Portal origin.',
    code: 'PORTAL_FEATURE_UNAVAILABLE',
    feature,
    retryable: false,
  } as const;
}

export function assertPortalFeatureAvailable(
  feature: PortalFeatureName,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const unavailable = portalFeatureUnavailableResponse(feature, environment);
  if (unavailable) {
    throw new PortalFeatureUnavailableError(feature, unavailable.error);
  }
}

/**
 * Recovery from legacy Email Code 2FA is a password-only downgrade and must
 * never become reachable through a stale public-domain route after an origin
 * migration. The caller supplies an already normalized effective request
 * origin derived from trusted proxy protocol + Host; this helper then requires
 * exact configured-origin membership and private-mode host semantics.
 */
export function privateRecoveryOriginIsAllowed(
  requestOrigin: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const capabilities = getPortalFeatureCapabilities(environment);
  if (
    capabilities.mail.available
    || (capabilities.originMode !== 'tailnet' && capabilities.originMode !== 'local')
    || !requestOrigin
  ) {
    return false;
  }

  let requestUrl: URL;
  try {
    requestUrl = new URL(requestOrigin);
  } catch {
    return false;
  }
  if (requestUrl.origin !== requestOrigin) return false;

  const hostname = requestUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1'
    || hostname === '::1';
  if (capabilities.originMode === 'tailnet') {
    const tailnetHttps = requestUrl.protocol === 'https:'
      && requestUrl.port === ''
      && hostname.endsWith('.ts.net')
      && hostname !== 'ts.net';
    const loopbackTunnel = requestUrl.protocol === 'http:' && loopback;
    if (!tailnetHttps && !loopbackTunnel) return false;
  } else {
    if (requestUrl.protocol !== 'http:' || !loopback) return false;
  }

  const configuredOrigins = String(environment.CORS_ORIGIN || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return null;
      }
    })
    .filter((value): value is string => Boolean(value));
  return configuredOrigins.includes(requestUrl.origin);
}
