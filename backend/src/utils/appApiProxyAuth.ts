const APP_API_SECRET_PREFIX = 'APP_API_SECRET_';
const APP_API_TARGET_PREFIX = 'APP_API_TARGET_';

export type ConfiguredAppApiTargetBinding =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'invalid' }>
  | Readonly<{ status: 'configured'; target: string }>;

export const APP_API_SECRET_HEADER = 'x-portal-app-secret';
export const APP_API_ID_HEADER = 'x-portal-app-id';
export const APP_API_TARGET_INVALID_CODE = 'APP_API_TARGET_INVALID';

export function invalidAppApiTargetResponse() {
  return {
    code: APP_API_TARGET_INVALID_CODE,
    error: 'This App API backend has an invalid server configuration.',
    detail: 'Ask the Portal operator to correct or remove the App-specific API target, then try again.',
    retryable: false,
  };
}

/**
 * Environment binding key for one concrete App row.
 *
 * The old proxy selected APP_API_TARGET/SECRET from the first caller supplied
 * `/api/` path segment. A share link for app A could therefore ask for app B's
 * namespace and receive B's target and secret. Bind configuration to the
 * server-selected App id instead; the requested API path never participates in
 * credential or target selection.
 */
export function appApiBindingKey(appId: string): string {
  return String(appId || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * Return a server-configured per-app proxy secret. Incoming client headers are
 * never consulted; callers inject this value only after Portal/share access
 * checks have passed.
 */
export function configuredAppApiSecret(
  appId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const normalized = appApiBindingKey(appId);
  if (!normalized) return undefined;

  const value = String(environment[`${APP_API_SECRET_PREFIX}${normalized}`] || '').trim();
  if (!value || value.length > 512 || /[\r\n]/.test(value)) return undefined;
  return value;
}

export function addConfiguredAppApiSecret(
  headers: Record<string, string>,
  appId: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const secret = configuredAppApiSecret(appId, environment);
  if (secret) headers[APP_API_SECRET_HEADER] = secret;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1';
}

/**
 * Resolve the optional server-managed upstream for one App row.
 * Only loopback HTTP services are valid: this is a reverse-proxy binding, not
 * a user-controlled SSRF feature.
 */
export function configuredAppApiTarget(
  appId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const binding = configuredAppApiTargetBinding(appId, environment);
  return binding.status === 'configured' ? binding.target : undefined;
}

/**
 * Distinguish an absent optional override from a present but unsafe one.
 * Callers making runtime-ownership decisions must use this three-state result;
 * treating an invalid binding as absent could silently start or proxy to a
 * different Portal-managed runtime.
 */
export function configuredAppApiTargetBinding(
  appId: string,
  environment: NodeJS.ProcessEnv = process.env,
): ConfiguredAppApiTargetBinding {
  const normalized = appApiBindingKey(appId);
  if (!normalized) return { status: 'absent' };

  const key = `${APP_API_TARGET_PREFIX}${normalized}`;
  const configuredValue = environment[key];
  if (configuredValue === undefined) return { status: 'absent' };
  const raw = String(configuredValue).trim();
  if (!raw || raw.length > 512 || /[\\\u0000-\u001f\u007f]/.test(raw)) {
    return { status: 'invalid' };
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' || !isLoopbackHostname(parsed.hostname)) return { status: 'invalid' };
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return { status: 'invalid' };
    const port = Number(parsed.port);
    if (!parsed.port || !Number.isInteger(port) || port < 1 || port > 65535) return { status: 'invalid' };
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return {
      status: 'configured',
      target: parsed.toString().replace(/\/$/, ''),
    };
  } catch {
    return { status: 'invalid' };
  }
}

export function buildAppApiTargetUrl(baseTarget: string, proxiedPath: string, query = ''): string | undefined {
  const rawPath = String(proxiedPath || '');
  if (rawPath.length > 2048 || rawPath.includes('\\') || rawPath.includes('\0')) {
    return undefined;
  }

  // A directory-style request ("app/") is a legitimate upstream path, not an
  // empty segment. Preserve the trailing slash for the upstream while keeping
  // it out of segment validation; internal empty segments ("a//b") stay
  // rejected so path traversal and namespace confusion remain impossible.
  //
  // Exactly one trailing slash is removed, never a run of them: collapsing
  // "auth//" to "auth/" would silently rewrite one upstream path into a
  // different one, which is the same namespace confusion the empty-segment
  // check exists to prevent.
  const hadTrailingSlash = /\/$/.test(rawPath);
  const cleanPath = rawPath.replace(/^\/+/, '').replace(/\/$/, '');
  if (!cleanPath) {
    return undefined;
  }

  const segments = cleanPath.split('/');
  const encodedSegments: string[] = [];
  for (const segment of segments) {
    if (!segment) return undefined;
    try {
      const decoded = decodeURIComponent(segment);
      if (!decoded || decoded === '.' || decoded === '..' || /[\\/\0]/.test(decoded)) return undefined;
      encodedSegments.push(encodeURIComponent(decoded));
    } catch {
      return undefined;
    }
  }

  try {
    const target = new URL(baseTarget);
    const basePath = target.pathname.replace(/\/+$/, '');
    target.pathname = `${basePath}/api/${encodedSegments.join('/')}${hadTrailingSlash ? '/' : ''}`;
    target.search = query.startsWith('?') ? query.slice(1) : query;
    target.hash = '';
    return target.toString();
  } catch {
    return undefined;
  }
}
