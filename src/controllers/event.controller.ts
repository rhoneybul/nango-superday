import type { Validated } from '../middleware/validation';
import { ingestBatch, ingestEvent, listEvents, type IngestInput, type ListEventsInput } from '../services/event.service';

/**
 * Controllers translate HTTP <-> service calls: they read the validated input
 * from `res.locals` and own the status code and response shape.
 * No try/catch needed: Express 5 forwards rejected promises to `errorHandler`.
 */

/** 202: the event is queued, not yet in the database. */
export const ingest: Validated<{ ingest: IngestInput }> = async (_req, res) => {
  res.status(202).json({ data: await ingestEvent(res.locals.ingest) });
};

/** 202: every event in the batch is queued. */
export const ingestBatchEvents: Validated<{ batch: IngestInput[] }> = async (_req, res) => {
  res.status(202).json({ data: await ingestBatch(res.locals.batch) });
};

export const list: Validated<{ listEvents: ListEventsInput }> = async (_req, res) => {
  res.status(200).json(await listEvents(res.locals.listEvents));
};
