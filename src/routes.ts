import { Router } from 'express';
import * as eventController from './controllers/event.controller';
import { metrics } from './lib/metrics';
import { batchRateLimit, ingestRateLimit } from './middleware/rate-limit';
import { requireBatchAccounts, requireEventsAccount, requireIngestAccount } from './middleware/require-account';
import { validateIngest, validateIngestBatch, validateListEvents } from './middleware/validation';

/** Every route reads: validate → check accounts → rate limit → controller. */
export const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});
router.get('/metrics', metrics);
router.get('/event-types', eventController.eventTypes);
router.post('/ingest', validateIngest, requireIngestAccount, ingestRateLimit, eventController.ingest);
router.post('/ingest/batch', validateIngestBatch, requireBatchAccounts, batchRateLimit, eventController.ingestBatchEvents);
router.get('/events', validateListEvents, requireEventsAccount, eventController.list);
