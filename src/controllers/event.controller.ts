import type { NextFunction, Request, Response } from 'express';
import { ValidationError } from '../lib/errors';
import { eventService, type EventService } from '../services/event.service';

/**
 * Controllers translate HTTP <-> service calls. They own status codes and
 * response shape; all input rules live in the service.
 */
export function createEventController(service: EventService = eventService) {
  return {
    async ingest(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new ValidationError('Request body must be a JSON object');
        }
        const event = await service.ingest(body);
        res.status(201).json({ data: event });
      } catch (err) {
        next(err);
      }
    },

    async list(req: Request, res: Response, next: NextFunction): Promise<void> {
      try {
        const result = await service.list(req.query as Record<string, unknown>);
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  };
}

export type EventController = ReturnType<typeof createEventController>;
