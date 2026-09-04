import type { RequestHandler } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { HttpError } from '../lib/errors';
import { EventName } from '../models/event-name';
import type { IngestInput, ListEventsInput } from '../services/event.service';

/**
 * Request validation with zod. Each middleware parses the raw body / query
 * string against a schema, throws a 400 listing every problem on bad input,
 * and stores the typed result on `res.locals` for the next handler.
 */

/** Express handler whose `res.locals` carries the validated input `T`. */
export type Validated<T extends Record<string, unknown>> = RequestHandler<Record<string, string>, unknown, unknown, unknown, T>;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  throw new HttpError(400, details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join('; '), details);
}

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

/** ISO-8601 string or epoch milliseconds → Date. */
const date = z.preprocess(
  (value) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value),
  z.coerce.date({ error: 'must be an ISO-8601 date or epoch milliseconds' }),
);
const pastDate = date.refine((d) => d <= new Date(), 'must not be in the future');

const METADATA_MAX_BYTES = 4096;

/** One metered event as the client sends it. */
const eventSchema = z.object({
  account_id: z.string().trim().min(1),
  event_name: z.enum(EventName),
  /** Units of usage this event represents, e.g. records synced. Default 1. */
  quantity: z.number().int().positive().default(1),
  /** Free-form context kept with the event for billing (connection id, provider, model, …). */
  metadata: z
    .record(z.string(), z.unknown())
    .refine((m) => JSON.stringify(m).length <= METADATA_MAX_BYTES, `must be at most ${METADATA_MAX_BYTES} bytes as JSON`)
    .optional(),
  timestamp: pastDate.optional(),
});
const toInput = (e: z.infer<typeof eventSchema>): IngestInput => ({
  accountId: e.account_id,
  eventName: e.event_name,
  quantity: e.quantity,
  metadata: e.metadata,
  timestamp: e.timestamp,
});

// ---------------------------------------------------------------------------
// POST /ingest
// ---------------------------------------------------------------------------

export const validateIngest: Validated<{ ingest: IngestInput }> = (req, res, next) => {
  res.locals.ingest = toInput(parse(eventSchema, req.body));
  next();
};

// ---------------------------------------------------------------------------
// POST /ingest/batch
// ---------------------------------------------------------------------------

export const BATCH_MAX_EVENTS = 100;

/** Same as a single event, except `timestamp` is required: a batch arrives after the fact, so "now" is not a sensible default. */
const batchEventSchema = eventSchema.extend({
  timestamp: z.custom<unknown>((value) => value !== undefined, 'is required').pipe(pastDate),
});

/** Every event is checked; any failure rejects the whole batch with one `details` entry per problem (path `events.<index>.<field>`). */
const batchSchema = z.object({
  events: z
    .array(batchEventSchema)
    .min(1, 'must contain at least one event')
    .max(BATCH_MAX_EVENTS, `must contain at most ${BATCH_MAX_EVENTS} events`),
});

export const validateIngestBatch: Validated<{ batch: IngestInput[] }> = (req, res, next) => {
  res.locals.batch = parse(batchSchema, req.body).events.map(toInput);
  next();
};

// ---------------------------------------------------------------------------
// GET /events
// ---------------------------------------------------------------------------

/** `?account=` means "no account filter", so empty params are removed before validation. */
function dropEmptyParams(query: unknown): unknown {
  if (typeof query !== 'object' || query === null) return query;
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== ''));
}

const SECONDS_PER_UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
const WORD_WINDOWS: Record<string, string> = { minute: '1m', hour: '1h', day: '1d', week: '1w' };

/** Aggregation bucket size: `minute`, `hour`, `day`, or `<n><s|m|h|d|w>` such as `15m`, `6h`, `7d` → `{ label, seconds }`. */
const window = z
  .string()
  .trim()
  .transform((raw) => WORD_WINDOWS[raw] ?? raw)
  .pipe(z.string().regex(/^\d+[smhdw]$/, 'expected minute|hour|day or <number><s|m|h|d|w>, e.g. 15m, 1h, 1d'))
  .transform((label) => ({ label, seconds: Number(label.slice(0, -1)) * SECONDS_PER_UNIT[label.slice(-1)] }))
  .refine((w) => w.seconds > 0, 'must be greater than zero');

const limitMessage = `must be between 1 and ${config.eventsMaxLimit}`;

/** How many buckets a windowed query over [from, to] produces. */
const bucketCount = (from: Date, to: Date, windowSeconds: number) => Math.ceil((to.getTime() - from.getTime()) / 1000 / windowSeconds) + 1;

const listEventsSchema: z.ZodType<ListEventsInput> = z
  .preprocess(
    dropEmptyParams,
    z.object({
      account: z.string().optional(),
      event: z.enum(EventName).optional(),
      from: date.optional(),
      to: date.optional(),
      window: window.optional(),
      limit: z.coerce.number().int().min(1, limitMessage).max(config.eventsMaxLimit, limitMessage).default(config.eventsDefaultLimit),
      offset: z.coerce.number().int().min(0, 'must be >= 0').default(0),
    }),
  )
  .refine((q) => !q.from || !q.to || q.from <= q.to, { path: ['from'], message: 'must be before or equal to to' })
  .refine((q) => !q.window || (q.from && q.to), { path: ['window'], message: 'requires from and to' })
  .refine((q) => !q.window || !q.from || !q.to || bucketCount(q.from, q.to, q.window.seconds) <= config.eventsMaxBuckets, {
    path: ['window'],
    message: `would produce more than ${config.eventsMaxBuckets} buckets; use a larger window or a narrower from/to`,
  });

export const validateListEvents: Validated<{ listEvents: ListEventsInput }> = (req, res, next) => {
  res.locals.listEvents = parse(listEventsSchema, req.query);
  next();
};
