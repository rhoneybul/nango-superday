import 'dotenv/config';
import { z } from 'zod';

/**
 * Central configuration package.
 *
 * All runtime configuration is read from the environment once at startup,
 * validated, and exposed as a typed, frozen object. Anything that needs a
 * config value imports from here rather than reading process.env directly.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** Default page size for GET /events when `limit` is not supplied. */
  EVENTS_DEFAULT_LIMIT: z.coerce.number().int().positive().default(100),
  /** Hard cap on page size for GET /events. */
  EVENTS_MAX_LIMIT: z.coerce.number().int().positive().default(1000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  events: { defaultLimit: number; maxLimit: number };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  return Object.freeze({
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    events: Object.freeze({ defaultLimit: e.EVENTS_DEFAULT_LIMIT, maxLimit: e.EVENTS_MAX_LIMIT }),
    logLevel: e.LOG_LEVEL,
  });
}

export const config: Config = loadConfig();
