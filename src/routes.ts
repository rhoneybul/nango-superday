import { Router } from 'express';
import * as eventController from './controllers/event.controller';
import { metrics } from './lib/metrics';
import { ingestRateLimit } from './middleware/rate-limit';
import { requireEventsAccount, requireIngestAccount } from './middleware/require-account';
import { validateIngest, validateListEvents } from './middleware/validation';

export const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});
router.get('/metrics', metrics);
router.post('/ingest', validateIngest, requireIngestAccount, ingestRateLimit, eventController.ingest);
router.get('/events', validateListEvents, requireEventsAccount, eventController.list);
