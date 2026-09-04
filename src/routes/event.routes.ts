import { Router } from 'express';
import { createEventController, type EventController } from '../controllers/event.controller';

export function createEventRoutes(controller: EventController = createEventController()): Router {
  const router = Router();
  router.post('/ingest', controller.ingest);
  router.get('/events', controller.list);
  return router;
}
