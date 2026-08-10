import fs from 'fs';
import os from 'os';
import path from 'path';

export { assertRustFreePrismaEnvironment } from './databaseEnvironmentGuard';

const PRISMA_ONLY_QUERY_PARAMETERS = new Set([
  'schema',
  'connection_limit',
  'connect_timeout',
  'pool_timeout',
  'socket_timeout',
  'pgbouncer',
  'statement_cache_size',
  'max_idle_connection_lifetime',
  'max_connection_lifetime',
]);

const SECURITY_RELEVANT_QUERY_PARAMETERS = new Set([
  ...PRISMA_ONLY_QUERY_PARAMETERS,
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'sslidentity',
  'sslpassword',
  'sslaccept',
  'channel_binding',
  'uselibpqcompat',
]);

const UNSUPPORTED_ADAPTER_QUERY_PARAMETERS = new Set([
  'sslcert',
  'sslkey',
  'sslidentity',
  'sslpassword',
  'sslaccept',
  'channel_binding',
  'uselibpqcompat',
]);

const PRESERVED_CONNECTION_QUERY_PARAMETERS = new Set([
  'application_name',
  'fallback_application_name',
  'options',
  'client_encoding',
  'replication',
]);

const ALLOWED_CONNECTION_QUERY_PARAMETERS = new Set([
  ...SECURITY_RELEVANT_QUERY_PARAMETERS,
  ...PRESERVED_CONNECTION_QUERY_PARAMETERS,
]);

const FORBIDDEN_AUTHORITY_QUERY_PARAMETERS = new Set([
  'password',
  'passfile',
  'service',
  'servicefile',
  'host',
  'hostaddr',
  'port',
  'user',
  'dbname',
  'database',
]);

const MAX_CONNECTIONS = 1_000;
const MAX_TIMEOUT_SECONDS = 86_400;
const MAX_DATABASE_URL_BYTES = 128_000;
type ParsedParameter = {
  key: string;
  value: string;
};

export interface PostgresAdapterConfig {
  pool: {
    connectionString: string;
    max: number;
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
    maxLifetimeSeconds: number;
    query_timeout?: number;
  };
  schema?: string;
}

function parseBoundedInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`DATABASE_URL ${name} must be an integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `DATABASE_URL ${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function milliseconds(seconds: number): number {
  return seconds * 1_000;
}

function requireSafeUrlComponent(value: string, name: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`DATABASE_URL ${name} is malformed`);
  }
  if (!decoded || /[\u0000-\u001f\u007f]/.test(decoded)) {
    throw new Error(`DATABASE_URL ${name} is missing or invalid`);
  }
}

function defaultConnectionLimit(): number {
  const available = Math.max(1, os.availableParallelism());
  try {
    const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const physicalCores = new Set<string>();
    for (const block of cpuInfo.split(/\n\s*\n/)) {
      const physicalId = block.match(/^physical id\s*:\s*(.+)$/m)?.[1];
      const coreId = block.match(/^core id\s*:\s*(.+)$/m)?.[1];
      if (physicalId !== undefined && coreId !== undefined) {
        physicalCores.add(`${physicalId}:${coreId}`);
      }
    }
    if (physicalCores.size > 0) {
      return Math.min(physicalCores.size, available) * 2 + 1;
    }
  } catch {
    // Non-Linux and restricted containers use the scheduler-visible count.
  }
  return available * 2 + 1;
}

/**
 * Translate Prisma v6 PostgreSQL URL controls to their node-postgres
 * equivalents. Driver adapters do not interpret Prisma-only URL parameters;
 * leaving them in place would silently change pooling and schema behavior.
 */
export function buildPostgresAdapterConfig(
  connectionString: string,
): PostgresAdapterConfig {
  if (!connectionString || /[\u0000-\u001f\u007f]/.test(connectionString)) {
    throw new Error('DATABASE_URL contains invalid control characters');
  }
  if (Buffer.byteLength(connectionString, 'utf8') > MAX_DATABASE_URL_BYTES) {
    throw new Error('DATABASE_URL exceeds the supported size limit');
  }
  if (/%(?![0-9A-Fa-f]{2})/.test(connectionString)) {
    throw new Error('DATABASE_URL contains malformed percent encoding');
  }
  if (connectionString.includes('#')) {
    throw new Error('DATABASE_URL must not contain a fragment');
  }
  const rawUrlMatch = connectionString.match(
    /^postgres(?:ql)?:\/\/([^/?#]+)\/([^/?#]+)(?:\?[^#]*)?(?:#.*)?$/i,
  );
  if (!rawUrlMatch) {
    throw new Error('DATABASE_URL must contain exactly one database path segment');
  }
  const rawUserInfo = rawUrlMatch[1].slice(0, rawUrlMatch[1].lastIndexOf('@'));
  if (
    rawUrlMatch[1].split('@').length !== 2
    || /[\[\]]/.test(rawUserInfo)
  ) {
    throw new Error(
      'DATABASE_URL user information must percent-encode @ and bracket characters',
    );
  }
  const rawEndpoint = rawUrlMatch[1].slice(rawUrlMatch[1].lastIndexOf('@') + 1);
  if (rawEndpoint.startsWith('[')) {
    throw new Error(
      'DATABASE_URL IPv6 authorities are not supported by the PostgreSQL adapter',
    );
  }
  const rawPortSeparator = rawEndpoint.lastIndexOf(':');
  const rawClosingBracket = rawEndpoint.startsWith('[')
    ? rawEndpoint.indexOf(']')
    : -1;
  const rawHost = rawEndpoint.startsWith('[')
    ? rawEndpoint.slice(1, rawClosingBracket)
    : rawPortSeparator >= 0
      ? rawEndpoint.slice(0, rawPortSeparator)
      : rawEndpoint;
  if (
    !rawHost
    || rawHost !== rawHost.toLowerCase()
    || !/^[\x21-\x7e]+$/.test(rawHost)
    || rawHost.includes('%')
  ) {
    throw new Error(
      'DATABASE_URL host must use lowercase ASCII without encoded labels',
    );
  }
  const rawPort = rawEndpoint.startsWith('[')
    ? rawEndpoint.slice(rawClosingBracket + 1)
    : rawPortSeparator >= 0
      ? rawEndpoint.slice(rawPortSeparator)
      : '';
  if (rawPort && !/^:[1-9]\d*$/.test(rawPort)) {
    throw new Error('DATABASE_URL port must use canonical decimal spelling');
  }
  const rawQueryStart = connectionString.indexOf('?');
  if (rawQueryStart >= 0) {
    const rawFragmentStart = connectionString.indexOf('#', rawQueryStart + 1);
    const rawQuery = connectionString.slice(
      rawQueryStart + 1,
      rawFragmentStart >= 0 ? rawFragmentStart : undefined,
    );
    if (rawQuery.includes('+')) {
      throw new Error(
        'DATABASE_URL query values must percent-encode literal plus characters',
      );
    }
    if (rawQuery) {
      for (const rawPair of rawQuery.split('&')) {
        const pairSeparator = rawPair.indexOf('=');
        if (pairSeparator < 0) {
          throw new Error('DATABASE_URL query parameter must contain a value');
        }
        const rawKey = rawPair.slice(0, pairSeparator);
        const rawValue = rawPair.slice(pairSeparator + 1);
        if (rawValue.includes('=')) {
          throw new Error(
            'DATABASE_URL query values must percent-encode literal equals characters',
          );
        }
        let decodedKey: string;
        let decodedValue: string;
        try {
          decodedKey = decodeURIComponent(rawKey);
          decodedValue = decodeURIComponent(rawValue);
        } catch {
          throw new Error('DATABASE_URL query parameter is malformed');
        }
        if (
          !decodedKey
          || /[\u0000-\u001f\u007f]/.test(decodedKey)
          || /[\u0000-\u001f\u007f]/.test(decodedValue)
        ) {
          throw new Error('DATABASE_URL query parameter is invalid');
        }
      }
    }
  }
  let rawDatabase: string;
  try {
    rawDatabase = decodeURIComponent(rawUrlMatch[2]);
  } catch {
    throw new Error('DATABASE_URL database is malformed');
  }
  if (rawDatabase === '.' || rawDatabase === '..' || rawDatabase.includes('/')) {
    throw new Error('DATABASE_URL database path is not supported');
  }
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use the postgres or postgresql scheme');
  }
  if (url.hash) {
    throw new Error('DATABASE_URL must not contain a fragment');
  }
  requireSafeUrlComponent(url.username, 'user');
  requireSafeUrlComponent(url.password, 'password');
  requireSafeUrlComponent(url.hostname, 'host');
  const encodedDatabase = url.pathname.replace(/^\//, '');
  requireSafeUrlComponent(encodedDatabase, 'database');
  if (decodeURI(encodedDatabase) !== decodeURIComponent(encodedDatabase)) {
    throw new Error(
      'DATABASE_URL database name contains encoding unsupported by the PostgreSQL adapter',
    );
  }
  if (url.port && Number(url.port) < 1) {
    throw new Error('DATABASE_URL port must be between 1 and 65535');
  }
  if (url.hostname.includes(',')) {
    throw new Error('DATABASE_URL must name exactly one PostgreSQL host');
  }
  if (url.hostname.includes('%')) {
    throw new Error('DATABASE_URL scoped IPv6 hosts are not supported');
  }
  if (
    url.hostname !== url.hostname.toLowerCase()
    || /\s/.test(url.hostname)
  ) {
    throw new Error('DATABASE_URL host must be lowercase ASCII without spaces');
  }

  const parsed = new Map<string, ParsedParameter>();
  const securityParameters = new Map<string, ParsedParameter>();
  const seenParameters = new Set<string>();
  for (const [rawKey, value] of url.searchParams.entries()) {
    const key = rawKey.toLowerCase();
    if (FORBIDDEN_AUTHORITY_QUERY_PARAMETERS.has(key)) {
      throw new Error(
        `DATABASE_URL ${key} must not override connection authority in query parameters`,
      );
    }
    if (!ALLOWED_CONNECTION_QUERY_PARAMETERS.has(key)) {
      throw new Error(`DATABASE_URL ${key} is not a supported connection option`);
    }
    if (rawKey !== key) {
      throw new Error(`DATABASE_URL ${key} must use its lowercase name`);
    }
    if (seenParameters.has(key)) {
      throw new Error(`DATABASE_URL ${key} must not be repeated`);
    }
    seenParameters.add(key);
    if (SECURITY_RELEVANT_QUERY_PARAMETERS.has(key)) {
      securityParameters.set(key, { key: rawKey, value });
    }
    if (!PRISMA_ONLY_QUERY_PARAMETERS.has(key)) {
      continue;
    }
    parsed.set(key, { key: rawKey, value });
  }

  for (const unsupported of UNSUPPORTED_ADAPTER_QUERY_PARAMETERS) {
    if (securityParameters.has(unsupported)) {
      throw new Error(
        `DATABASE_URL ${unsupported} is not supported by the Rust-free PostgreSQL adapter`,
      );
    }
  }

  for (const { key } of parsed.values()) {
    url.searchParams.delete(key);
  }

  const sslMode = securityParameters.get('sslmode')?.value;
  if (
    sslMode !== undefined
    && !['disable', 'require', 'verify-ca', 'verify-full'].includes(sslMode)
  ) {
    throw new Error('DATABASE_URL sslmode is not supported');
  }
  const hasSslMode = sslMode !== undefined;
  const loopbackHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    url.hostname,
  );
  if (!hasSslMode && !loopbackHost) {
    throw new Error(
      'DATABASE_URL for a remote PostgreSQL host must set sslmode explicitly',
    );
  }
  const sslRootCert = securityParameters.get('sslrootcert')?.value;
  if (
    sslRootCert !== undefined
    && (
      sslRootCert.length === 0
      || /[\u0000-\u001f\u007f]/.test(sslRootCert)
      || !path.isAbsolute(sslRootCert)
    )
  ) {
    throw new Error('DATABASE_URL sslrootcert must be an absolute file path');
  }
  if (
    sslRootCert !== undefined
    && !['require', 'verify-ca', 'verify-full'].includes(sslMode || '')
  ) {
    throw new Error(
      'DATABASE_URL sslrootcert requires an explicit certificate-validating sslmode',
    );
  }
  if (
    ['verify-ca', 'verify-full'].includes(sslMode || '')
    && sslRootCert === undefined
  ) {
    throw new Error(
      'DATABASE_URL sslrootcert is required for certificate-verifying sslmode',
    );
  }
  if (hasSslMode) {
    // pg 8 defaults several sslmode values to stricter aliases. Prisma v6
    // followed libpq semantics, so opt in explicitly when preserving an
    // existing Prisma URL across the driver-adapter migration.
    url.searchParams.append('uselibpqcompat', 'true');
  }

  const schemaValue = parsed.get('schema')?.value;
  if (
    schemaValue !== undefined
    && (
      schemaValue.length === 0
      || Buffer.byteLength(schemaValue, 'utf8') > 63
      || /[\u0000-\u001f\u007f]/.test(schemaValue)
    )
  ) {
    throw new Error('DATABASE_URL schema must be a valid PostgreSQL identifier');
  }

  const connectionLimit = parsed.has('connection_limit')
    ? parseBoundedInteger(
        parsed.get('connection_limit')!.value,
        'connection_limit',
        1,
        MAX_CONNECTIONS,
      )
    : defaultConnectionLimit();
  const connectTimeout = parsed.has('connect_timeout')
    ? parseBoundedInteger(
        parsed.get('connect_timeout')!.value,
        'connect_timeout',
        0,
        MAX_TIMEOUT_SECONDS,
      )
    : 5;
  const poolTimeout = parsed.has('pool_timeout')
    ? parseBoundedInteger(
        parsed.get('pool_timeout')!.value,
        'pool_timeout',
        0,
        MAX_TIMEOUT_SECONDS,
      )
    : 10;
  if (
    (parsed.has('connect_timeout') || parsed.has('pool_timeout'))
    && connectTimeout !== poolTimeout
  ) {
    throw new Error(
      'DATABASE_URL connect_timeout and pool_timeout must be equal for the PostgreSQL adapter',
    );
  }
  const idleTimeout = parsed.has('max_idle_connection_lifetime')
    ? parseBoundedInteger(
        parsed.get('max_idle_connection_lifetime')!.value,
        'max_idle_connection_lifetime',
        0,
        MAX_TIMEOUT_SECONDS,
      )
    : 300;
  const maxLifetime = parsed.has('max_connection_lifetime')
    ? parseBoundedInteger(
        parsed.get('max_connection_lifetime')!.value,
        'max_connection_lifetime',
        0,
        MAX_TIMEOUT_SECONDS,
      )
    : 0;

  const pgbouncer = parsed.get('pgbouncer')?.value;
  if (pgbouncer !== undefined && !['true', 'false'].includes(pgbouncer)) {
    throw new Error('DATABASE_URL pgbouncer must be true or false');
  }
  if (parsed.has('statement_cache_size')) {
    parseBoundedInteger(
      parsed.get('statement_cache_size')!.value,
      'statement_cache_size',
      0,
      1_000_000,
    );
  }

  const pool: PostgresAdapterConfig['pool'] = {
    connectionString: url.toString(),
    max: connectionLimit,
    // pg exposes one timeout for both opening and acquiring a connection.
    // The no-override path keeps Prisma v6's stricter 5-second connect bound;
    // explicit URL overrides are admitted only when both semantics agree.
    connectionTimeoutMillis: milliseconds(connectTimeout),
    idleTimeoutMillis: milliseconds(idleTimeout),
    maxLifetimeSeconds: maxLifetime,
  };

  if (parsed.has('socket_timeout')) {
    pool.query_timeout = milliseconds(
      parseBoundedInteger(
        parsed.get('socket_timeout')!.value,
        'socket_timeout',
        0,
        MAX_TIMEOUT_SECONDS,
      ),
    );
  }

  return {
    pool,
    ...(schemaValue === undefined ? {} : { schema: schemaValue }),
  };
}
