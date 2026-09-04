/**
 * Rate limiting for ingestion. Two endpoints, one Redis store (memory without REDIS_URL):
 *
 *   POST /ingest        100 requests per minute per `account:event`      → 429 (ingestRateLimit)
 *   POST /ingest/batch  10 batches per minute per account, and then each
 *                       event in the batch counts against the same
 *                       `account:event` counter as single ingest          → events rejected one by one (batchRateLimit)
 *
 * Every rejection is recorded in the metrics in src/lib/metrics.ts; that is the
 * only input to the Grafana alerts (RateLimitExceeded, BatchRateLimitExceeded).
 */
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

/** Both limiters share this: one hit on `key`, true if that pushed it past `limit`. */
async function overLimit(key: string, limit: number): Promise<boolean> {
  const { totalHits } = await rateLimitStore.increment(key);
  return totalHits > limit;
}

/**
 * POST /ingest/batch. Two limits, both in the same store as POST /ingest:
 *
 *   1. Request shaping: INGEST_BATCH_RATE_LIMIT_PER_MINUTE batches per account per
 *      minute (`batch:<account>`), counted once per account the batch still has
 *      events for. An account over it has all its events in this batch rejected.
 *   2. Usage: every remaining event costs one hit on `<account>:<event>`, the very
 *      same counter POST /ingest uses, with the same INGEST_RATE_LIMIT_PER_MINUTE.
 *      So 100 events of one kind per minute is the ceiling whichever endpoint they
 *      arrive through; events past it are rejected one by one, the rest carry on.
 *
 * Rejected events move to `errors` with reason `rate_limited`. Limit 1 feeds the
 * batch metrics (BatchRateLimitExceeded alert); limit 2 feeds the same metrics as
 * single ingest (RateLimitExceeded alert), because it is the same limit.
 */
export const batchRateLimit: Validated<{ batch: BatchState }> = async (_req, res, next) => {
  const { batch } = res.locals;
  const reject = (index: number, message: string) => batch.errors.push({ index, path: `events.${index}`, message, reason: 'rate_limited' });

  // 1. batches per account
  const batchLimit = config.ingestBatchRateLimitPerMinute;
  const overBatches = new Set<string>();
  for (const account of new Set(batch.accepted.map((e) => e.input.accountId))) {
    if (await overLimit(`batch:${account}`, batchLimit)) {
      overBatches.add(account);
      ingestBatchRateLimited.inc({ account_id: account });
      ingestBatchRateLimitedLastSeen.set({ account_id: account }, Date.now() / 1000);
    }
  }
  for (const { index, input } of batch.accepted) {
    if (overBatches.has(input.accountId)) reject(index, `Account ${input.accountId} is over its batch limit of ${batchLimit} per minute`);
  }
  batch.accepted = batch.accepted.filter((e) => !overBatches.has(e.input.accountId));

  // 2. events per account + event name, charged in batch order
  const eventLimit = config.ingestRateLimitPerMinute;
  const stillAccepted: typeof batch.accepted = [];
  for (const item of batch.accepted) {
    const { accountId, eventName } = item.input;
    if (await overLimit(`${accountId}:${eventName}`, eventLimit)) {
      const labels = { account_id: accountId, event_name: eventName };
      ingestRateLimited.inc(labels);
      ingestRateLimitedLastSeen.set(labels, Date.now() / 1000);
      reject(item.index, `Account ${accountId} is over its ${eventName} limit of ${eventLimit} per minute`);
    } else {
      stillAccepted.push(item);
    }
  }
  batch.accepted = stillAccepted;
  next();
};
