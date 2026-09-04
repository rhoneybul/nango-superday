import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Used by the Prisma CLI (migrate/generate). Runtime config lives in src/config.
// Read process.env directly rather than prisma's env() helper: env() throws when the
// variable is missing, but `generate` (run on npm install, e.g. in the Docker build) needs no URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx src/seed.ts' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
