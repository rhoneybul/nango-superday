import type { RequestHandler } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics, served on GET /metrics and scraped by the `prometheus`
 * compose service. Alert rules (grafana/provisioning/alerting/rules.yml) are
 * evaluated against these, so a new kind of alert = record a metric here at
 * the point where the event happens + a rule there. Nothing polls the database.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const httpLabels = ['method', 'route', 'status'] as const;

/** One increment per finished HTTP request. `route` is the matched Express route, or "unmatched" for 404s. */
export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests handled, by method, matched route and status code',
  labelNames: httpLabels,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds, by method, matched route and status code',
  labelNames: httpLabels,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

const rateLimitLabels = ['account_id', 'event_name'] as const;

/** Incremented for every POST /ingest rejected with 429. */
export const ingestRateLimited = new Counter({
  name: 'ingest_rate_limited_total',
  help: 'POST /ingest requests rejected by the per account_id:event_name rate limit',
  labelNames: rateLimitLabels,
  registers: [registry],
});

/**
 * Unix time of the latest rejection per pair; the alert rule fires while this
 * is under a minute old. A counter alone is not enough for alerting: Prometheus
 * cannot see the first jump of a brand-new series, so a single burst of 429s
 * landing between two scrapes would never show up in increase()/rate().
 */
export const ingestRateLimitedLastSeen = new Gauge({
  name: 'ingest_rate_limited_last_seen_timestamp_seconds',
  help: 'Unix time of the most recent POST /ingest rejected by the rate limit, per account_id:event_name',
  labelNames: rateLimitLabels,
  registers: [registry],
});

/** Incremented for every POST /ingest/batch rejected with 429 (per account: batches are limited per account, not per event). */
export const ingestBatchRateLimited = new Counter({
  name: 'ingest_batch_rate_limited_total',
  help: 'POST /ingest/batch requests rejected by the per-account batch rate limit',
  labelNames: ['account_id'] as const,
  registers: [registry],
});

/** Unix time of the latest batch rejection per account; drives the BatchRateLimitExceeded alert the same way as the gauge above. */
export const ingestBatchRateLimitedLastSeen = new Gauge({
  name: 'ingest_batch_rate_limited_last_seen_timestamp_seconds',
  help: 'Unix time of the most recent POST /ingest/batch rejected by the batch rate limit, per account_id',
  labelNames: ['account_id'] as const,
  registers: [registry],
});

export const metrics: RequestHandler = async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
};
