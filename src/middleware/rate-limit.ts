import rateLimit, { MemoryStore, type Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { config } from '../config';
import { ingestBatchRateLimited, ingestBatchRateLimitedLastSeen, ingestRateLimited, ingestRateLimitedLastSeen } from '../lib/metrics';
import { redis, type RedisClient } from '../lib/redis';
import type { IngestInput } from '../services/event.service';
import type { Validated } from './validation';

/** Set by validateIngest, which runs before the limiter. */
type IngestLocals = { ingest: IngestInput };

function redisStore(client: RedisClient) {
  return new RedisStore({ sendCommand: (...args: string[]) => client.sendCommand(args) });
}

/** One store for both ingest endpoints, so a pair's quota is shared between single and batch requests. */
const store: Store = redis ? redisStore(redis) : new MemoryStore();

function recordRejection(accountId: string, eventName: string): void {
  const labels = { account_id: accountId, event_name: eventName };
  ingestRateLimited.inc(labels);
  ingestRateLimitedLastSeen.set(labels, Date.now() / 1000);
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
  store,
  handler: (_req, res, _next, options) => {
    const { ingest } = res.locals as IngestLocals;
    recordRejection(ingest.accountId, ingest.eventName);
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * POST /ingest/batch: INGEST_BATCH_RATE_LIMIT_PER_MINUTE batches per account per
 * minute (a batch counts once against every account it contains; each batch
 * holds at most BATCH_MAX_EVENTS). Keys live in the same store under `batch:`.
 * If any account in the batch is over, the whole batch is rejected with a 429
 * that lists those accounts, and nothing is queued. Rejections are recorded in
 * the batch rate-limit metrics, which drive the separate BatchRateLimitExceeded alert.
 */
export const batchRateLimit: Validated<{ batch: IngestInput[] }> = async (_req, res, next) => {
  const limit = config.ingestBatchRateLimitPerMinute;
  const accounts = [...new Set(res.locals.batch.map((e) => e.accountId))];
  const over: { account: string; limit: number }[] = [];
  for (const account of accounts) {
    const { totalHits } = await store.increment(`batch:${account}`);
    if (totalHits > limit) {
      ingestBatchRateLimited.inc({ account_id: account });
      ingestBatchRateLimitedLastSeen.set({ account_id: account }, Date.now() / 1000);
      over.push({ account, limit });
    }
  }
  if (over.length) {
    res.status(429).json({ error: 'Too many requests', details: over });
    return;
  }
  next();
};
