import type { RequestHandler } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { ValidationError } from '../lib/errors';
import { EventName } from '../models/event-name';
import type { IngestInput, ListEventsInput } from '../services/event.service';

/**
 * Request validation with zod. Each middleware parses the raw body / query
 * string against a schema, throws a ValidationError (→ 400) on bad input, and
 * stores the typed result on `res.locals` for the controller.
 */

/** Express handler whose `res.locals` carries the validated input `T`. */
export type Validated<T extends Record<string, unknown>> = RequestHandler<Record<string, string>, unknown, unknown, unknown, T>;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  const summary = details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join('; ');
  throw new ValidationError(summary, details);
}

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

/** ISO-8601 string or epoch milliseconds → Date. */
const date = z.preprocess(
  (value) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value),
  z.coerce.date({ error: 'must be an ISO-8601 date or epoch milliseconds' }),
);

const SECONDS_PER_UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** `15m`, `1h`, `7d` … → `{ label, seconds }`. */
const window = z
  .string()
  .trim()
  .regex(/^\d+[smhdw]$/, 'expected <number><s|m|h|d|w>, e.g. 15m, 1h, 1d')
  .transform((label) => ({ label, seconds: Number(label.slice(0, -1)) * SECONDS_PER_UNIT[label.slice(-1)] }))
  .refine((w) => w.seconds > 0, 'must be greater than zero');

// ---------------------------------------------------------------------------
// POST /ingest
// ---------------------------------------------------------------------------

const ingestSchema: z.ZodType<IngestInput> = z
  .object({
    account_id: z.string().trim().min(1),
    event_name: z.enum(EventName),
    timestamp: date.refine((d) => d <= new Date(), 'must not be in the future').optional(),
  })
  .transform((body) => ({ accountId: body.account_id, eventName: body.event_name, timestamp: body.timestamp }));

export const validateIngest: Validated<{ ingest: IngestInput }> = (req, res, next) => {
  res.locals.ingest = parse(ingestSchema, req.body);
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

const limitMessage = `must be between 1 and ${config.eventsMaxLimit}`;

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
  .refine((q) => !q.from || !q.to || q.from <= q.to, { path: ['from'], message: 'must be before or equal to to' });

export const validateListEvents: Validated<{ listEvents: ListEventsInput }> = (req, res, next) => {
  res.locals.listEvents = parse(listEventsSchema, req.query);
  next();
};
