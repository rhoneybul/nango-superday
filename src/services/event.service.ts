import { config } from '../config';
import { encodeCursor, type EventCursor } from '../lib/cursor';
import { ValidationError } from '../lib/errors';
import type { EventName } from '../models/event-name';
import * as events from '../models/event.model';
import type { EventRecord, EventWhere, WindowBucket } from '../models/event.model';
import type { EventMessage } from '../queue/message';
import { publishEvent } from '../queue/publisher';

/**
 * Business logic for events. Input has already been validated by the
 * middleware in src/middleware/validation.ts, so these functions only
 * translate typed input into model calls.
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
// GET /events
// ---------------------------------------------------------------------------

export interface ListEventsInput {
  account?: string;
  event?: EventName;
  from?: Date;
  to?: Date;
  /** Present → aggregated mode: counts per bucket of this size, instead of a raw listing. */
  window?: { label: string; seconds: number };
  limit: number;
  offset: number;
  /** Keyset cursor from a previous page's `meta.nextCursor` (raw listing only); exclusive with a non-zero offset. */
  cursor?: EventCursor;
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
  /** `nextCursor` is null on the last page. Pass it as `cursor` to fetch the next one. */
  meta: { total: number; limit: number; offset: number; nextCursor: string | null };
  filters: AppliedFilters;
}

export interface EventWindowCounts {
  window: string;
  windowSeconds: number;
  /** One entry per bucket, oldest first. With `from` and `to` every bucket in the range is present (empty ones as 0). */
  buckets: WindowBucket[];
  /** `total` is the number of buckets in the range; `buckets` is the page `offset`..`offset + limit`. */
  meta: { total: number; limit: number; offset: number };
  filters: AppliedFilters;
}

export async function listEvents(input: ListEventsInput): Promise<EventListing | EventWindowCounts> {
  const { account, event, from, to, window, limit, offset, cursor } = input;

  const where: EventWhere = {};
  if (account) where.accountId = account;
  if (event) where.eventName = event;
  if (from || to) where.timestamp = { gte: from, lte: to };

  const filters: AppliedFilters = { account, event, from: from?.toISOString(), to: to?.toISOString() };

  if (window) {
    // One more than the cap: a full page means the range is too wide for this window.
    const counted = await events.countEventsByWindow(where, window.seconds, config.eventsMaxBuckets + 1);
    if (counted.length > config.eventsMaxBuckets) {
      throw new ValidationError(`window: would produce more than ${config.eventsMaxBuckets} buckets; use a larger window or a narrower from/to`);
    }
    const buckets = from && to ? fillEmptyBuckets(counted, from, to, window.seconds) : counted;
    return {
      window: window.label,
      windowSeconds: window.seconds,
      buckets: buckets.slice(offset, offset + limit),
      meta: { total: buckets.length, limit, offset },
      filters,
    };
  }

  // Fetch one row past the page so we know whether a next page exists without a second query.
  const [rows, total] = await Promise.all([events.findEvents(where, limit + 1, { offset, after: cursor }), events.countEvents(where)]);
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor({ timestamp: last.timestamp, id: BigInt(last.id) }) : null;
  return { data, meta: { total, limit, offset, nextCursor }, filters };
}

/**
 * A 24h range with window=1h is 24 values, so buckets with no events are
 * added as 0. Buckets start at the same origin as the SQL (`BUCKET_ORIGIN_MS`,
 * see the model) and cover every start from bin(from) up to, but not
 * including, `to`; a bucket the database returned is always kept.
 */
function fillEmptyBuckets(counted: WindowBucket[], from: Date, to: Date, windowSeconds: number): WindowBucket[] {
  const windowMs = windowSeconds * 1000;
  const bin = (t: number) => events.BUCKET_ORIGIN_MS + Math.floor((t - events.BUCKET_ORIGIN_MS) / windowMs) * windowMs;
  const byStart = new Map(counted.map((b) => [b.windowStart.getTime(), b.count]));
  for (let start = bin(from.getTime()); start < to.getTime(); start += windowMs) {
    if (!byStart.has(start)) byStart.set(start, 0);
  }
  return [...byStart.entries()].sort(([a], [b]) => a - b).map(([start, count]) => ({ windowStart: new Date(start), count }));
}
