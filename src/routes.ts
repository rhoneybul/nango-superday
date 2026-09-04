import { Router } from 'express';
import * as eventController from './controllers/event.controller';
import { metrics } from './lib/metrics';
import { batchRateLimit, ingestRateLimit } from './middleware/rate-limit';
import { requireAccountIn, requireBatchAccounts, requireIngestAccount } from './middleware/require-account';
import { validateIngest, validateIngestBatch, validateListEvents } from './middleware/validation';

export const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});
router.get('/metrics', metrics);
router.post('/ingest', validateIngest, requireIngestAccount, ingestRateLimit, eventController.ingest);
router.post('/ingest/batch', validateIngestBatch, requireBatchAccounts, batchRateLimit, eventController.ingestBatchEvents);
router.get('/events', validateListEvents, requireAccountIn('listEvents'), eventController.list);
