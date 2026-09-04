import type { Validated } from '../middleware/validation';
import { ingestEvent, listEvents, type IngestInput, type ListEventsInput } from '../services/event.service';

/**
 * Controllers translate HTTP <-> service calls: they read the validated input
 * from `res.locals` and own the status code and response shape.
 * No try/catch needed: Express 5 forwards rejected promises to `errorHandler`.
 */

export const ingest: Validated<{ ingest: IngestInput }> = async (_req, res) => {
  const event = await ingestEvent(res.locals.ingest);
  res.status(201).json({ data: event });
};

export const list: Validated<{ listEvents: ListEventsInput }> = async (_req, res) => {
  const result = await listEvents(res.locals.listEvents);
  res.status(200).json(result);
};
