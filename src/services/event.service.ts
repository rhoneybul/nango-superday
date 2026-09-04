import type { EventName } from '../models/event-name';
import * as events from '../models/event.model';
import type { EventRecord, EventWhere, WindowBucket } from '../models/event.model';

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
  /** Omitted → the database stamps `now()`. */
  timestamp?: Date;
}

export async function ingestEvent(input: IngestInput): Promise<EventRecord> {
  return events.createEvent(input.accountId, input.eventName, input.timestamp);
}

// ---------------------------------------------------------------------------
// GET /events
// ---------------------------------------------------------------------------

export interface ListEventsInput {
  account?: string;
  event?: EventName;
  from?: Date;
  to?: Date;
  /** Present → aggregated mode (counts per bucket) instead of a raw listing. */
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
  buckets: WindowBucket[];
  filters: AppliedFilters;
}

export async function listEvents(input: ListEventsInput): Promise<EventListing | EventWindowCounts> {
  const { account, event, from, to, window, limit, offset } = input;

  const where: EventWhere = {};
  if (account) where.accountId = account;
  if (event) where.eventName = event;
  if (from || to) where.timestamp = { gte: from, lte: to };

  const filters: AppliedFilters = { account, event, from: from?.toISOString(), to: to?.toISOString() };

  if (window) {
    const buckets = await events.countEventsByWindow(where, window.seconds);
    return { window: window.label, windowSeconds: window.seconds, buckets, filters };
  }

  const [data, total] = await Promise.all([events.findEvents(where, limit, offset), events.countEvents(where)]);
  return { data, meta: { total, limit, offset }, filters };
}
