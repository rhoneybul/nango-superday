import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { ingestBatchRateLimited, ingestBatchRateLimitedLastSeen, ingestRateLimited, ingestRateLimitedLastSeen } from '../lib/metrics';
import { rateLimitStore } from '../lib/rate-limit-store';
import type { BatchState, IngestInput } from '../services/event.service';
import type { Validated } from './validation';

/** Set by validateIngest, which runs before the limiter. */
type IngestLocals = { ingest: IngestInput };

/**
 * POST /ingest: INGEST_RATE_LIMIT_PER_MINUTE per `account_id:event_name`, so a
 * noisy event cannot starve an account's other (critical) events. Counters
 * live in Redis when REDIS_URL is set, otherwise in memory (tests, local dev).
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
  store: rateLimitStore,
  handler: (_req, res, _next, options) => {
    const { ingest } = res.locals as IngestLocals;
    const labels = { account_id: ingest.accountId, event_name: ingest.eventName };
    ingestRateLimited.inc(labels);
    ingestRateLimitedLastSeen.set(labels, Date.now() / 1000);
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * POST /ingest/batch: INGEST_BATCH_RATE_LIMIT_PER_MINUTE batches per account per
 * minute, a batch counting once against every account it still has events for
 * (keys `batch:<account>` in the same store). An account over its limit has
 * its events moved to `errors`; other accounts' events carry on. Rejections
 * drive the separate BatchRateLimitExceeded alert.
 */
export const batchRateLimit: Validated<{ batch: BatchState }> = async (_req, res, next) => {
  const { batch } = res.locals;
  const limit = config.ingestBatchRateLimitPerMinute;
  const over = new Set<string>();
  for (const account of new Set(batch.accepted.map((e) => e.input.accountId))) {
    const { totalHits } = await rateLimitStore.increment(`batch:${account}`);
    if (totalHits > limit) {
      over.add(account);
      ingestBatchRateLimited.inc({ account_id: account });
      ingestBatchRateLimitedLastSeen.set({ account_id: account }, Date.now() / 1000);
    }
  }
  for (const { index, input } of batch.accepted) {
    if (over.has(input.accountId)) {
      batch.errors.push({ index, path: `events.${index}`, message: `Account ${input.accountId} is over its batch limit of ${limit} per minute`, reason: 'rate_limited' });
    }
  }
  batch.accepted = batch.accepted.filter((e) => !over.has(e.input.accountId));
  next();
};
