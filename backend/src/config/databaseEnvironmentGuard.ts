const FORBIDDEN_DATABASE_RUNTIME_ENVIRONMENT = [
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
] as const;

export function assertRustFreePrismaEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  for (const name of FORBIDDEN_DATABASE_RUNTIME_ENVIRONMENT) {
    if (Object.prototype.hasOwnProperty.call(environment, name)) {
      throw new Error(
        `${name} is not supported by the Portal database runtime`,
      );
    }
  }
}

// This module is intentionally the first runtime dependency of database.ts.
// NODE_PG_FORCE_NATIVE is consumed while pg itself loads, so constructor-time
// validation would be too late to preserve the attested JavaScript driver.
assertRustFreePrismaEnvironment();
