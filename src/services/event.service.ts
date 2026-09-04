import { config } from '../config';
import { ValidationError } from '../lib/errors';
import { eventModel, type EventModel, type EventRecord, type WindowBucket } from '../models/event.model';

export interface IngestInput {
  account_id: unknown;
  event_name: unknown;
  timestamp?: unknown;
}

export interface ListEventsQuery {
  account?: unknown;
  event?: unknown;
  from?: unknown;
  to?: unknown;
  window?: unknown;
  limit?: unknown;
  offset?: unknown;
}

export interface ListEventsResult {
  data: EventRecord[];
  meta: { total: number; limit: number; offset: number };
  filters: NormalisedFilters;
}

export interface WindowedEventsResult {
  window: string;
  windowSeconds: number;
  buckets: WindowBucket[];
  filters: NormalisedFilters;
}

export interface NormalisedFilters {
  account?: string;
  event?: string;
  from?: string;
  to?: string;
}

const WINDOW_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
const WINDOW_RE = /^(\d+)(s|m|h|d|w)$/;

/** Parses a window like `15m`, `1h`, `7d` into seconds. */
export function parseWindow(raw: string): number {
  const m = WINDOW_RE.exec(raw.trim());
  if (!m) throw new ValidationError(`Invalid window "${raw}". Expected <number><s|m|h|d|w>, e.g. 15m, 1h, 1d`);
  const n = Number(m[1]);
  if (n <= 0) throw new ValidationError('window must be greater than zero');
  return n * WINDOW_UNITS[m[2]];
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) throw new ValidationError(`${name} must be supplied once`);
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${name} is required and must be a non-empty string`);
  return value.trim();
}

function parseDate(value: unknown, name: string): Date | undefined {
  const s = optionalString(value, name);
  if (s === undefined) return undefined;
  // Accept ISO-8601 strings and integer epoch milliseconds.
  const d = /^\d+$/.test(s) ? new Date(Number(s)) : new Date(s);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${name} must be an ISO-8601 date or epoch milliseconds`);
  return d;
}

function parseInteger(value: unknown, name: string, fallback: number, opts: { min: number; max?: number }): number {
  const s = optionalString(value, name);
  if (s === undefined) return fallback;
  if (!/^-?\d+$/.test(s)) throw new ValidationError(`${name} must be an integer`);
  const n = Number(s);
  if (n < opts.min) throw new ValidationError(`${name} must be >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new ValidationError(`${name} must be <= ${opts.max}`);
  return n;
}

export function createEventService(model: EventModel = eventModel) {
  return {
    async ingest(input: IngestInput): Promise<EventRecord> {
      const accountId = requiredString(input.account_id, 'account_id');
      const eventName = requiredString(input.event_name, 'event_name');
      const timestamp = parseDate(input.timestamp, 'timestamp'); // undefined → DB default NOW()
      return model.create({ accountId, eventName, timestamp });
    },

    async list(query: ListEventsQuery): Promise<ListEventsResult | WindowedEventsResult> {
      const accountId = optionalString(query.account, 'account');
      const eventName = optionalString(query.event, 'event');
      const from = parseDate(query.from, 'from');
      const to = parseDate(query.to, 'to');
      if (from && to && from > to) throw new ValidationError('from must be before or equal to to');

      const filters: NormalisedFilters = {
        ...(accountId && { account: accountId }),
        ...(eventName && { event: eventName }),
        ...(from && { from: from.toISOString() }),
        ...(to && { to: to.toISOString() }),
      };
      const filter = { accountId, eventName, from, to };

      const window = optionalString(query.window, 'window');
      if (window !== undefined) {
        const windowSeconds = parseWindow(window);
        const buckets = await model.countByWindow(filter, windowSeconds);
        return { window: window.trim(), windowSeconds, buckets, filters };
      }

      const limit = parseInteger(query.limit, 'limit', config.events.defaultLimit, { min: 1, max: config.events.maxLimit });
      const offset = parseInteger(query.offset, 'offset', 0, { min: 0 });
      const [data, total] = await Promise.all([model.findMany({ ...filter, limit, offset }), model.count(filter)]);
      return { data, meta: { total, limit, offset }, filters };
    },
  };
}

export type EventService = ReturnType<typeof createEventService>;
export const eventService = createEventService();
