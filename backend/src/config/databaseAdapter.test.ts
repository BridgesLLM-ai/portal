import {
  assertRustFreePrismaEnvironment,
  buildPostgresAdapterConfig,
} from './databaseAdapter';

describe('assertRustFreePrismaEnvironment', () => {
  it.each([
    'PRISMA_CLIENT_ENGINE_TYPE',
    'PRISMA_QUERY_ENGINE_BINARY',
    'PRISMA_QUERY_ENGINE_LIBRARY',
    'PRISMA_CLIENT_GET_TIME',
    'NODE_PG_FORCE_NATIVE',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'PGUSER',
    'PGDATABASE',
    'PGPORT',
    'PGHOST',
    'PGPASSWORD',
    'PGBINARY',
    'PGOPTIONS',
    'PGSSLMODE',
    'PGSSLNEGOTIATION',
    'PGCLIENT_ENCODING',
    'PGREPLICATION',
    'PGAPPNAME',
    'PGCONNECT_TIMEOUT',
  ])('rejects an explicit %s assignment without exposing its value', (name) => {
    const environment = { [name]: 'sensitive-override' } as NodeJS.ProcessEnv;
    expect(() => assertRustFreePrismaEnvironment(environment)).toThrow(name);
    try {
      assertRustFreePrismaEnvironment(environment);
    } catch (error) {
      expect(String(error)).not.toContain('sensitive-override');
    }
  });

  it('accepts an environment with no Prisma engine override', () => {
    expect(() =>
      assertRustFreePrismaEnvironment({ NODE_ENV: 'production' }),
    ).not.toThrow();
  });
});

describe('buildPostgresAdapterConfig', () => {
  it('preserves standard pg options and translates Prisma v6 controls', () => {
    const result = buildPostgresAdapterConfig(
      'postgresql://portal:p%40ss@db.example.test:6543/portal'
      + '?schema=tenant_a&connection_limit=7&connect_timeout=3&pool_timeout=3'
      + '&socket_timeout=11&max_idle_connection_lifetime=45'
      + '&max_connection_lifetime=90&pgbouncer=true&statement_cache_size=0'
      + '&sslmode=require&sslrootcert=%2Fsrv%2Fbridgesllm%2Fcerts%2Froot.pem'
      + '&application_name=bridgesllm%2Bbackup'
      + '&options=-c%20statement_timeout%3D5000',
    );

    const sanitized = new URL(result.pool.connectionString);
    expect(sanitized.username).toBe('portal');
    expect(sanitized.password).toBe('p%40ss');
    expect(sanitized.searchParams.get('sslmode')).toBe('require');
    expect(sanitized.searchParams.get('uselibpqcompat')).toBe('true');
    expect(sanitized.searchParams.get('sslrootcert')).toBe(
      '/srv/bridgesllm/certs/root.pem',
    );
    expect(sanitized.searchParams.get('application_name')).toBe(
      'bridgesllm+backup',
    );
    expect(sanitized.searchParams.get('options')).toBe(
      '-c statement_timeout=5000',
    );
    for (const key of [
      'schema',
      'connection_limit',
      'connect_timeout',
      'pool_timeout',
      'socket_timeout',
      'max_idle_connection_lifetime',
      'max_connection_lifetime',
      'pgbouncer',
      'statement_cache_size',
    ]) {
      expect(sanitized.searchParams.has(key)).toBe(false);
    }
    expect(result).toMatchObject({
      schema: 'tenant_a',
      pool: {
        max: 7,
        connectionTimeoutMillis: 3_000,
        idleTimeoutMillis: 45_000,
        maxLifetimeSeconds: 90,
        query_timeout: 11_000,
      },
    });
  });

  it('uses an explicit pool size and v6-compatible timeout/lifetime defaults', () => {
    const result = buildPostgresAdapterConfig(
      'postgresql://portal:secret@127.0.0.1:5432/portal',
    );

    expect(result.pool.connectionString).toBe(
      'postgresql://portal:secret@127.0.0.1:5432/portal',
    );
    expect(result.pool.max).toBeGreaterThanOrEqual(3);
    expect(result.pool.max % 2).toBe(1);
    expect(result.pool.connectionTimeoutMillis).toBe(5_000);
    expect(result.pool.idleTimeoutMillis).toBe(300_000);
    expect(result.pool.maxLifetimeSeconds).toBe(0);
  });

  it('accepts percent-encoded brackets in database credentials', () => {
    const result = buildPostgresAdapterConfig(
      'postgresql://u%5Bx:p%5Dy@db.example.test:5432/portal?sslmode=require',
    );
    const sanitized = new URL(result.pool.connectionString);
    expect(sanitized.username).toBe('u%5Bx');
    expect(sanitized.password).toBe('p%5Dy');
  });

  it.each([
    ['duplicate schema', '?sslmode=require&schema=public&schema=other'],
    ['invalid connection limit', '?sslmode=require&connection_limit=0'],
    ['invalid timeout', '?sslmode=require&pool_timeout=-1'],
    ['incompatible timeouts', '?sslmode=require&connect_timeout=5&pool_timeout=10'],
    ['invalid pgbouncer flag', '?sslmode=require&pgbouncer=yes'],
    ['oversized schema', `?sslmode=require&schema=${'x'.repeat(64)}`],
    ['case-variant TLS control', '?SSLMODE=require'],
    ['unsupported TLS identity', '?sslmode=require&sslidentity=client.p12'],
    ['ambiguous legacy TLS certificate', '?sslmode=require&sslcert=server.pem'],
    ['unsupported TLS key', '?sslmode=require&sslkey=client.key'],
    [
      'ambiguous TLS certificates',
      '?sslmode=require&sslcert=server.pem&sslrootcert=root.pem',
    ],
    ['unsupported channel binding', '?sslmode=require&channel_binding=require'],
    ['pg-only TLS override', '?sslmode=require&uselibpqcompat=false'],
    ['unsupported prefer semantics', '?sslmode=prefer'],
    ['verify-ca without CA', '?sslmode=verify-ca'],
    ['verify-full without CA', '?sslmode=verify-full'],
    ['relative CA path', '?sslmode=verify-ca&sslrootcert=certs/root.pem'],
    [
      'CA ignored by disabled TLS',
      '?sslmode=disable&sslrootcert=%2Fetc%2Fportal%2Froot.pem',
    ],
    ['raw plus in standard option', '?sslmode=require&application_name=a+b'],
    ['raw equals in standard option', '?sslmode=require&application_name=a=b'],
    ['missing query separator', '?sslmode=require&application_name'],
    ['control in standard option', '?sslmode=require&application_name=%00'],
    ['unknown connection option', '?sslmode=require&unknown_option=value'],
    ['case-variant standard option', '?sslmode=require&Application_Name=value'],
    [
      'duplicate standard option',
      '?sslmode=require&application_name=one&application_name=two',
    ],
    ['ambiguous remote TLS default', ''],
    ['query host override', '?host=remote.example.test'],
    ['encoded query password override', '?pass%77ord=override'],
    ['fragment authority', '?sslmode=require#other'],
    ['empty fragment', '?sslmode=require#'],
    [
      'reserved database-name encoding',
      '%2Fname?sslmode=require',
    ],
    [
      'reserved database-query encoding',
      '%3Fname?sslmode=require',
    ],
    ['extra database path separator', '/portal?sslmode=require'],
  ])('rejects %s without exposing the URL', (_label, suffix) => {
    const databaseUrl =
      `postgresql://portal:sensitive-password@db.example.test/portal${suffix}`;
    expect(() => buildPostgresAdapterConfig(databaseUrl)).toThrow(/DATABASE_URL/);

    try {
      buildPostgresAdapterConfig(databaseUrl);
    } catch (error) {
      expect(String(error)).not.toContain('sensitive-password');
    }
  });

  it.each([
    'postgresql://localhost/database',
    'postgresql://portal@localhost/database',
    'postgresql:///database?sslmode=disable',
    'postgresql://portal:secret@localhost/',
    'postgresql://portal:secret@localhost:0/database',
    'postgresql://portal:secret@localhost:05432/database',
    'postgresql://portal:secret@localhost:/database',
    'postgresql://portal:secret@localhost:5432/database#',
    'postgresql://portal:secret@localhost:5432/database?#',
    'postgresql://portal:secret@[fe80::1%25eth0]:7654/database?sslmode=require',
    'postgresql://portal:secret@[::1]:5432/database',
    'postgresql://portal:secret@[2001:db8::1]:5432/database?sslmode=require',
    'postgresql://portal:secret@db.example.test/a/../b?sslmode=require',
    'postgresql://portal:secret@db.example.test/.?sslmode=require',
    'postgresql://portal:secret@db.example.test/%2e%2e?sslmode=require',
    'postgresql://portal:secret@127.0.0.1/database?sslrootcert=%2Fetc%2Fportal%2Froot.pem',
    'postgresql://portal:secret@LOCALHOST:5432/database',
    'postgresql://portal:secret@[FE80::1]:5432/database?sslmode=require',
    'postgresql://portal:secret@[0:0:0:0:0:0:0:1]:5432/database',
    'postgresql://portal:secret@[0:0::1]:5432/database',
    'postgresql://portal:secret@[::0:1]:5432/database',
    'postgresql://portal:secret@éxample.com:5432/database?sslmode=require',
    'postgresql://portal@owner:secret@db.example.test:5432/database?sslmode=require',
    'postgresql://u[x:secret@db.example.test:5432/database?sslmode=require',
    'postgresql://u]x:secret@db.example.test:5432/database?sslmode=require',
    'postgresql://portal:p[x@db.example.test:5432/database?sslmode=require',
    'postgresql://portal:p]x@db.example.test:5432/database?sslmode=require',
    'postgresql://portal:secret@exa mple.com:5432/database?sslmode=require',
    'postgresql://portal:secret@evil<host:5432/database?sslmode=require',
    'postgresql://portal:secret@evil>host:5432/database?sslmode=require',
    'postgresql://portal:secret@evil\\host:5432/database?sslmode=require',
    'postgresql://portal:secret@evil^host:5432/database?sslmode=require',
    'postgresql://portal:secret@evil|host:5432/database?sslmode=require',
    'postgresql://portal:sec%ZZret@db.example.test:5432/database?sslmode=require',
    'postgresql://portal:secret@db.example.test:5432/database?sslmode=require&application_name=%ZZ',
    'postgresql://portal:secret@db.example.test:5432/database?sslmode=verify-ca&sslrootcert=%2Fetc%2F%ZZ.pem',
  ])('rejects incomplete database authority: %s', (databaseUrl) => {
    expect(() => buildPostgresAdapterConfig(databaseUrl)).toThrow(/DATABASE_URL/);
  });

  it('rejects raw control characters before URL normalization', () => {
    expect(() =>
      buildPostgresAdapterConfig(
        'postgresql://portal:secret@local\nhost/database?sslmode=disable',
      ),
    ).toThrow(/control characters/);
  });

  it('shares the exact installer/runtime database URL byte ceiling', () => {
    const prefix = 'postgresql://portal:';
    const suffix = '@127.0.0.1:5432/portal';
    const passwordLength = 128_000 - Buffer.byteLength(prefix + suffix, 'utf8');
    const boundaryUrl = `${prefix}${'x'.repeat(passwordLength)}${suffix}`;
    expect(Buffer.byteLength(boundaryUrl, 'utf8')).toBe(128_000);
    expect(() => buildPostgresAdapterConfig(boundaryUrl)).not.toThrow();
    expect(() =>
      buildPostgresAdapterConfig(
        `${prefix}${'x'.repeat(passwordLength + 1)}${suffix}`,
      ),
    ).toThrow(/size limit/);
  });
});
