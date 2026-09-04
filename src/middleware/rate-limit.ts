import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { ingestRateLimited, ingestRateLimitedLastSeen } from '../lib/metrics';
import { rateLimitStore } from '../lib/rate-limit-store';
import type { IngestInput } from '../services/event.service';

/** Set by validateIngest, which runs before the limiter. */
type IngestLocals = { ingest: IngestInput };

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
  store: rateLimitStore,
  handler: (_req, res, _next, options) => {
    const { ingest } = res.locals as IngestLocals;
    recordRejection(ingest.accountId, ingest.eventName);
    res.status(options.statusCode).json(options.message);
  },
});
