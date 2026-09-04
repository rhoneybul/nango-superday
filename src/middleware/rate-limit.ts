import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createClient } from 'redis';
import { config } from '../config';
import { log } from '../lib/logger';

function redisStore(url: string) {
  const client = createClient({ url });
  client.on('error', (err) => log.error({ err }, 'redis error'));
  void client.connect();
  return new RedisStore({ sendCommand: (...args: string[]) => client.sendCommand(args) });
}

/**
 * Rate limit for POST /ingest, keyed on `account_id:event_name` so a noisy
 * event cannot starve an account's other (critical) events.
 * Counters live in Redis when REDIS_URL is set, otherwise in memory (tests, local dev).
 */
export const ingestRateLimit = rateLimit({
  windowMs: 60_000,
  limit: config.ingestRateLimitPerMinute,
  keyGenerator: (req) => `${req.body?.account_id}:${req.body?.event_name}`,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
  store: config.redisUrl ? redisStore(config.redisUrl) : undefined,
});
