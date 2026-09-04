import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { config } from '../config';
import { ingestRateLimited, ingestRateLimitedLastSeen } from '../lib/metrics';
import { redis, type RedisClient } from '../lib/redis';
import type { IngestInput } from '../services/event.service';

/** Set by validateIngest, which runs before the limiter. */
type IngestLocals = { ingest: IngestInput };

function redisStore(client: RedisClient) {
  return new RedisStore({ sendCommand: (...args: string[]) => client.sendCommand(args) });
}

/**
 * Rate limit for POST /ingest, keyed on `account_id:event_name` so a noisy
 * event cannot starve an account's other (critical) events.
 * Counters live in Redis when REDIS_URL is set, otherwise in memory (tests, local dev).
 * Every rejection is recorded in the rate-limit metrics; that is what the
 * RateLimitExceeded alert (grafana/provisioning/alerting/rules.yml) is built on.
 */
export const ingestRateLimit = rateLimit({
  windowMs: 60_000,
  limit: config.ingestRateLimitPerMinute,
  keyGenerator: (_req, res) => {
    const { ingest } = res.locals as IngestLocals;
    return `${ingest.accountId}:${ingest.eventName}`;
  },
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
  store: redis ? redisStore(redis) : undefined,
  handler: (_req, res, _next, options) => {
    const { ingest } = res.locals as IngestLocals;
    const labels = { account_id: ingest.accountId, event_name: ingest.eventName };
    ingestRateLimited.inc(labels);
    ingestRateLimitedLastSeen.set(labels, Date.now() / 1000);
    res.status(options.statusCode).json(options.message);
  },
});
