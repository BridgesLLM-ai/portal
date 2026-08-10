import {
  assertRustFreePrismaEnvironment,
} from './databaseEnvironmentGuard';

assertRustFreePrismaEnvironment();

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { buildPostgresAdapterConfig } from './databaseAdapter';

const prismaClientSingleton = () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required before initializing the database client');
  }

  const adapterConfig = buildPostgresAdapterConfig(connectionString);
  return new PrismaClient({
    adapter: new PrismaPg(adapterConfig.pool, {
      schema: adapterConfig.schema,
    }),
    log: ['warn', 'error'],
  });
};

declare global {
  // `var` is required for a process-global declaration that survives module reloads.
  // eslint-disable-next-line no-var
  var prisma: undefined | ReturnType<typeof prismaClientSingleton>;
}

export const prisma = globalThis.prisma ?? prismaClientSingleton();

if (process.env.NODE_ENV !== 'production') {
  globalThis.prisma = prisma;
}

export default prisma;
