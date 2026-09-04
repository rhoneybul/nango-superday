import { Router } from 'express';
import { createEventRoutes } from './event.routes';
import type { EventController } from '../controllers/event.controller';

export interface RouteDeps {
  eventController?: EventController;
}

export function createRouter(deps: RouteDeps = {}): Router {
  const router = Router();
  router.get('/health', (_req, res) => res.json({ status: 'ok' }));
  router.use(createEventRoutes(deps.eventController));
  return router;
}
