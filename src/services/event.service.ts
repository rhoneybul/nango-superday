import { randomUUID } from 'node:crypto';
import type { EventName } from '../models/event-name';
import * as events from '../models/event.model';
import type { EventRecord, EventWhere, WindowBucket } from '../models/event.model';
import type { EventMessage } from '../queue/message';
import { publishEvent } from '../queue/publisher';

/**
 * Business logic for events. Input has already been validated by the
 * middleware in src/middleware/validation.ts, so these functions only
 * translate typed input into queue publishes and model calls.
 */

// ---------------------------------------------------------------------------
// POST /ingest and POST /ingest/batch
// ---------------------------------------------------------------------------

export interface IngestInput {
  accountId: string;
  /** Idempotency key. Omitted → the API generates a UUID, so every stored event has one. */
  eventId?: string;
  eventName: EventName;
  /** The fields the event's catalogue entry requires, plus anything extra the client sent. */
  metadata: Record<string, unknown>;
  /** Omitted → the time the API received the event. */
  timestamp?: Date;
}

/** Publishes the event to the queue; src/consumer.ts inserts it into Postgres. Returns what was queued. */
export async function ingestEvent(input: IngestInput): Promise<EventMessage> {
  const message: EventMessage = { ...input, eventId: input.eventId ?? randomUUID(), timestamp: input.timestamp ?? new Date() };
  await publishEvent(message);
  return message;
}

/**
 * A batch in flight. Each middleware in the chain moves events it rejects
 * from `accepted` to `errors`; whatever is still accepted at the end is queued.
 * So one request can partly succeed: clients get a `success` count plus one error per
 * event that did not make it, with its position in the batch they sent.
 */
export interface BatchState {
  accepted: { index: number; input: IngestInput }[];
  errors: BatchError[];
}

export interface BatchError {
  index: number;
  /** `events.<index>.<field>` for a bad field, `events.<index>` for a whole event. */
  path: string;
  message: string;
  reason: 'invalid' | 'unknown_account' | 'rate_limited';
}

export interface BatchResult {
  /** Events accepted and published to the queue. */
  success: number;
  /** Events that were not (an event with several problems counts once). */
  failed: number;
  errors: BatchError[];
}

/** Publishes every still-accepted event of a batch and reports `success` / `failed` counts, errors in batch order. */
export async function ingestBatch(batch: BatchState): Promise<BatchResult> {
  await Promise.all(batch.accepted.map(({ input }) => ingestEvent(input)));
  const errors = [...batch.errors].sort((a, b) => a.index - b.index);
  return { success: batch.accepted.length, failed: new Set(errors.map((e) => e.index)).size, errors };
}

// ---------------------------------------------------------------------------
// GET /events
// ---------------------------------------------------------------------------

export interface ListEventsInput {
  account?: string;
  event?: EventName;
  from?: Date;
  to?: Date;
  /** Present → aggregated mode: counts per bucket of this size over [from, to], instead of a raw listing. */
  window?: { label: string; seconds: number };
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
  /** One entry per bucket from `from` to `to`, oldest first, empty buckets as 0: a 24h range at 1h is 24 values. */
  buckets: WindowBucket[];
  /** `total` is the number of buckets in the range; `buckets` is the page `offset`..`offset + limit`. */
  meta: { total: number; limit: number; offset: number };
  filters: AppliedFilters;
}

export async function listEvents(input: ListEventsInput): Promise<EventListing | EventWindowCounts> {
  const { account, event, from, to, window, limit, offset } = input;

  const where: EventWhere = {};
  if (account) where.accountId = account;
  if (event) where.eventName = event;
  if (from || to) where.timestamp = { gte: from, lte: to };

  const filters: AppliedFilters = { account, event, from: from?.toISOString(), to: to?.toISOString() };

  if (window && from && to) {
    const counted = await events.countEventsByWindow(where, window.seconds);
    const buckets = fillEmptyBuckets(counted, from, to, window.seconds);
    return {
      window: window.label,
      windowSeconds: window.seconds,
      buckets: buckets.slice(offset, offset + limit),
      meta: { total: buckets.length, limit, offset },
      filters,
    };
  }

  const [data, total] = await Promise.all([events.findEvents(where, limit, offset), events.countEvents(where)]);
  return { data, meta: { total, limit, offset }, filters };
}

/**
 * The database only returns buckets that have events; add the rest as 0 so
 * every bucket from bin(from) up to (not including) `to` is present. Buckets
 * start at the same origin as the SQL (`BUCKET_ORIGIN_MS`, see the model).
 */
function fillEmptyBuckets(counted: WindowBucket[], from: Date, to: Date, windowSeconds: number): WindowBucket[] {
  const windowMs = windowSeconds * 1000;
  const byStart = new Map(counted.map((b) => [b.windowStart.getTime(), b]));
  const firstStart = events.BUCKET_ORIGIN_MS + Math.floor((from.getTime() - events.BUCKET_ORIGIN_MS) / windowMs) * windowMs;
  for (let start = firstStart; start < to.getTime(); start += windowMs) {
    if (!byStart.has(start)) byStart.set(start, { windowStart: new Date(start), count: 0 });
  }
  return [...byStart.values()].sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime());
}
