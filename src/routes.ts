import { Router } from 'express';
import * as eventController from './controllers/event.controller';
import { validateIngest, validateListEvents } from './middleware/validation';

export const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});
router.post('/ingest', validateIngest, eventController.ingest);
router.get('/events', validateListEvents, eventController.list);
