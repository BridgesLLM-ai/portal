import { defineConfig } from 'prisma/config';

// The installer injects DATABASE_URL for migrations and removes it for generation.
// Never reload .env here: that would restore stripped database authority.
// Developer migrate/studio scripts opt into dotenv explicitly.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
