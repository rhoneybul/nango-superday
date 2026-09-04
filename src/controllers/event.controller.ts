import type { RequestHandler } from 'express';
import type { Validated } from '../middleware/validation';
import { describeEventTypes } from '../models/event-catalog';
import { ingestBatch, ingestEvent, listEvents, type BatchState, type IngestInput, type ListEventsInput } from '../services/event.service';

/**
 * Controllers translate HTTP <-> service calls: they read the validated input
 * from `res.locals` and own the status code and response shape.
 * No try/catch needed: Express 5 forwards rejected promises to `errorHandler`.
 */

/** 202: the event is queued, not yet in the database. */
export const ingest: Validated<{ ingest: IngestInput }> = async (_req, res) => {
  res.status(202).json({ data: await ingestEvent(res.locals.ingest) });
};

/**
 * 202 when at least one event was queued (the body says how many, and lists the
 * ones that were not). 429 when nothing was queued because of the rate limit,
 * 400 when nothing was queued for any other reason.
 */
export const ingestBatchEvents: Validated<{ batch: BatchState }> = async (_req, res) => {
  const result = await ingestBatch(res.locals.batch);
  const status = result.success > 0 ? 202 : result.errors.every((e) => e.reason === 'rate_limited') ? 429 : 400;
  res.status(status).json({ data: result });
};

export const list: Validated<{ listEvents: ListEventsInput }> = async (_req, res) => {
  res.status(200).json(await listEvents(res.locals.listEvents));
};

/** The metering catalogue: what can be metered, its billable unit, and the metadata each event must carry. */
export const eventTypes: RequestHandler = (_req, res) => {
  res.json({ data: describeEventTypes() });
};
