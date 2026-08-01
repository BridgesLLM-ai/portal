const APP_API_SECRET_PREFIX = 'APP_API_SECRET_';
const APP_API_TARGET_PREFIX = 'APP_API_TARGET_';

export const APP_API_SECRET_HEADER = 'x-portal-app-secret';
export const APP_API_ID_HEADER = 'x-portal-app-id';

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
  const normalized = appApiBindingKey(appId);
  if (!normalized) return undefined;

  const raw = String(environment[`${APP_API_TARGET_PREFIX}${normalized}`] || '').trim();
  if (!raw || raw.length > 512 || /[\r\n]/.test(raw)) return undefined;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' || !isLoopbackHostname(parsed.hostname)) return undefined;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    const port = Number(parsed.port);
    if (!parsed.port || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

export function buildAppApiTargetUrl(baseTarget: string, proxiedPath: string, query = ''): string | undefined {
  const cleanPath = String(proxiedPath || '').replace(/^\/+/, '');
  if (!cleanPath || cleanPath.length > 2048 || cleanPath.includes('\\') || cleanPath.includes('\0')) {
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
    target.pathname = `${basePath}/api/${encodedSegments.join('/')}`;
    target.search = query.startsWith('?') ? query.slice(1) : query;
    target.hash = '';
    return target.toString();
  } catch {
    return undefined;
  }
}
