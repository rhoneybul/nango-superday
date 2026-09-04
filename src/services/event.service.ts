import { z } from 'zod';
import { config } from '../config';
import { RateLimitError, ValidationError } from '../lib/errors';
import { ingestBatchRateLimited, ingestBatchRateLimitedLastSeen } from '../lib/metrics';
import { rateLimitStore } from '../lib/rate-limit-store';
import { date, parse } from '../middleware/validation';
import { EventName } from '../models/event-name';
import * as events from '../models/event.model';
import type { EventRecord, EventWhere, WindowBucket, WindowGroup } from '../models/event.model';
import type { EventMessage } from '../queue/message';
import { publishEvent } from '../queue/publisher';
import { getAccount } from './account.service';

/**
 * Business logic for events. Single ingest and queries receive input already
 * validated by the middleware in src/middleware/validation.ts. Batch ingest is
 * the exception: `ingestBatch` takes the raw body and does its own validation,
 * account check and rate limit, so that everything about a batch is in one place.
 */

// ---------------------------------------------------------------------------
// POST /ingest
// ---------------------------------------------------------------------------

export interface IngestInput {
  accountId: string;
  eventName: EventName;
  /** Omitted → the time the API received the event. */
  timestamp?: Date;
}

/** Publishes the event to the queue; src/consumer.ts inserts it into Postgres. Returns what was queued. */
export async function ingestEvent(input: IngestInput): Promise<EventMessage> {
  const message: EventMessage = { accountId: input.accountId, eventName: input.eventName, timestamp: input.timestamp ?? new Date() };
  await publishEvent(message);
  return message;
}

// ---------------------------------------------------------------------------
// POST /ingest/batch
// ---------------------------------------------------------------------------

export const BATCH_MAX_EVENTS = 100;

/** Same rules as a single ingest, except `timestamp` is required: a batch arrives after the fact, so "now" is not a sensible default. */
const batchEventSchema = z.object({
  account_id: z.string().trim().min(1),
  event_name: z.enum(EventName),
  timestamp: z
    .custom<unknown>((value) => value !== undefined, 'is required')
    .pipe(date)
    .refine((d) => d <= new Date(), 'must not be in the future'),
});

const batchSchema = z
  .object({
    events: z
      .array(batchEventSchema)
      .min(1, 'must contain at least one event')
      .max(BATCH_MAX_EVENTS, `must contain at most ${BATCH_MAX_EVENTS} events`),
  })
  .transform((body) => body.events.map((e): IngestInput => ({ accountId: e.account_id, eventName: e.event_name, timestamp: e.timestamp })));

/**
 * Batch ingest, all-or-nothing:
 *   1. every event is validated (one `details` entry per problem, path `events.<index>.<field>`);
 *   2. every distinct account must exist (unknown ones are listed the same way);
 *   3. each account may send INGEST_BATCH_RATE_LIMIT_PER_MINUTE batches a minute, counted in the
 *      shared rate-limit store under `batch:<account>`; any account over → 429 listing them;
 *   4. only then is every event published. Returns how many were queued.
 */
export async function ingestBatch(body: unknown): Promise<{ queued: number }> {
  const inputs = parse(batchSchema, body);

  const accountIds = [...new Set(inputs.map((e) => e.accountId))];
  const found = await Promise.all(accountIds.map((id) => getAccount(id)));
  const unknown = new Set(accountIds.filter((_, i) => found[i] === null));
  if (unknown.size) {
    const details = inputs.flatMap((e, i) => (unknown.has(e.accountId) ? [{ path: `events.${i}.account_id`, message: `Account ${e.accountId} not found` }] : []));
    throw new ValidationError(details.map((d) => `${d.path}: ${d.message}`).join('; '), details);
  }

  const limit = config.ingestBatchRateLimitPerMinute;
  const over: { account: string; limit: number }[] = [];
  for (const account of accountIds) {
    const { totalHits } = await rateLimitStore.increment(`batch:${account}`);
    if (totalHits > limit) {
      ingestBatchRateLimited.inc({ account_id: account });
      ingestBatchRateLimitedLastSeen.set({ account_id: account }, Date.now() / 1000);
      over.push({ account, limit });
    }
  }
  if (over.length) throw new RateLimitError(over);

  await Promise.all(inputs.map((input) => ingestEvent(input)));
  return { queued: inputs.length };
}

// ---------------------------------------------------------------------------
// GET /events
// ---------------------------------------------------------------------------

export interface ListEventsInput {
  account?: string;
  event?: EventName;
  from?: Date;
  to?: Date;
  /** Present → aggregated mode: counts per bucket of this size, instead of a raw listing. */
  window?: { label: string; seconds: number };
  /** Aggregated mode only: one row per bucket per account and/or event instead of one per bucket. */
  group_by?: WindowGroup[];
  limit: number;
  offset: number;
}

/** The filters that were applied, echoed back in every response. */
export interface AppliedFilters {
  account?: string;
  event?: string;
  from?: string;
  to?: string;
}

export interface EventListing {
  data: EventRecord[];
  meta: { total: number; limit: number; offset: number };
  filters: AppliedFilters;
}

export interface EventWindowCounts {
  window: string;
  windowSeconds: number;
  /** Echo of `group_by`; each bucket row then also carries `account` and/or `event`. */
  groupBy: WindowGroup[];
  /** One entry per bucket, oldest first. With `from` and `to` every bucket in the range is present (empty ones as 0). */
  buckets: WindowBucket[];
  /** `total` is the number of buckets in the range; `buckets` is the page `offset`..`offset + limit`. */
  meta: { total: number; limit: number; offset: number };
  filters: AppliedFilters;
}

export async function listEvents(input: ListEventsInput): Promise<EventListing | EventWindowCounts> {
  const { account, event, from, to, window, group_by: groupBy = [], limit, offset } = input;

  const where: EventWhere = {};
  if (account) where.accountId = account;
  if (event) where.eventName = event;
  if (from || to) where.timestamp = { gte: from, lte: to };

  const filters: AppliedFilters = { account, event, from: from?.toISOString(), to: to?.toISOString() };

  if (window) {
    // One more than the cap: a full page means the range is too wide for this window.
    const counted = await events.countEventsByWindow(where, window.seconds, config.eventsMaxBuckets + 1, groupBy);
    if (counted.length > config.eventsMaxBuckets) {
      throw new ValidationError(`window: would produce more than ${config.eventsMaxBuckets} buckets; use a larger window, a narrower from/to or fewer groups`);
    }
    const buckets = from && to ? fillEmptyBuckets(counted, from, to, window.seconds) : counted;
    return {
      window: window.label,
      windowSeconds: window.seconds,
      groupBy,
      buckets: buckets.slice(offset, offset + limit),
      meta: { total: buckets.length, limit, offset },
      filters,
    };
  }

  const [data, total] = await Promise.all([events.findEvents(where, limit, offset), events.countEvents(where)]);
  return { data, meta: { total, limit, offset }, filters };
}

/**
 * A 24h range with window=1h is 24 values, so buckets with no events are
 * added as 0. When grouped, every group that appears in the range gets the
 * full set of buckets. Buckets start at the same origin as the SQL
 * (`BUCKET_ORIGIN_MS`, see the model) and cover every start from bin(from)
 * up to, but not including, `to`; a bucket the database returned is always kept.
 */
function fillEmptyBuckets(counted: WindowBucket[], from: Date, to: Date, windowSeconds: number): WindowBucket[] {
  const windowMs = windowSeconds * 1000;
  const bin = (t: number) => events.BUCKET_ORIGIN_MS + Math.floor((t - events.BUCKET_ORIGIN_MS) / windowMs) * windowMs;
  const groupKey = (b: Pick<WindowBucket, 'account' | 'event'>) => JSON.stringify([b.account ?? null, b.event ?? null]);

  const groups = new Map<string, Pick<WindowBucket, 'account' | 'event'>>();
  for (const b of counted) groups.set(groupKey(b), { ...(b.account !== undefined && { account: b.account }), ...(b.event !== undefined && { event: b.event }) });
  if (groups.size === 0) groups.set(groupKey({}), {}); // no data at all: still one (ungrouped) series of zeros

  const rows = new Map(counted.map((b) => [`${groupKey(b)}@${b.windowStart.getTime()}`, b]));
  for (const [key, group] of groups) {
    for (let start = bin(from.getTime()); start < to.getTime(); start += windowMs) {
      const id = `${key}@${start}`;
      if (!rows.has(id)) rows.set(id, { windowStart: new Date(start), ...group, count: 0 });
    }
  }
  return [...rows.values()].sort(
    (a, b) => a.windowStart.getTime() - b.windowStart.getTime() || (a.account ?? '').localeCompare(b.account ?? '') || (a.event ?? '').localeCompare(b.event ?? ''),
  );
}
