import 'dotenv/config';

/**
 * All settings come from environment variables (`.env` is loaded in development).
 * This is the only file that reads `process.env`; everything else imports `config`.
 */
const env = process.env;

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

function integer(name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${value}"`);
  return n;
}

function logLevel(fallback: LogLevel): LogLevel {
  const value = env.LOG_LEVEL ?? fallback;
  if (!LOG_LEVELS.includes(value as LogLevel)) throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${value}"`);
  return value as LogLevel;
}

if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!env.RABBITMQ_URL) throw new Error('RABBITMQ_URL is required');

export const config = {
  env: env.NODE_ENV ?? 'development',
  port: integer('PORT', 3000),
  databaseUrl: env.DATABASE_URL,
  /** RabbitMQ: POST /ingest publishes events here, src/consumer.ts inserts them into Postgres. */
  rabbitmqUrl: env.RABBITMQ_URL,
  logLevel: logLevel('info'),
  /** Optional. When unset, rate-limit counters are kept in memory instead. */
  redisUrl: env.REDIS_URL || undefined,

  /** Page size for GET /events when `limit` is not supplied. */
  eventsDefaultLimit: integer('EVENTS_DEFAULT_LIMIT', 100),
  /** Largest `limit` a caller may ask for on GET /events. */
  eventsMaxLimit: integer('EVENTS_MAX_LIMIT', 1000),
  /** Most buckets a windowed GET /events may return; narrower ranges or wider windows are required beyond it. */
  eventsMaxBuckets: integer('EVENTS_MAX_BUCKETS', 10000),
  /** POST /ingest requests allowed per minute for each `account_id:event_name`. */
  ingestRateLimitPerMinute: integer('INGEST_RATE_LIMIT_PER_MINUTE', 100),
  /** How long a successful account lookup stays cached (Redis, or memory without REDIS_URL). */
  accountCacheTtlSeconds: integer('ACCOUNT_CACHE_TTL_SECONDS', 300),
};
