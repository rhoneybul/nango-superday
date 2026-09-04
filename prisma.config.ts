import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Used by the Prisma CLI (migrate/generate). Runtime config lives in src/config.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
