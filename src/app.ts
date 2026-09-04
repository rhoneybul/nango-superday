import express from 'express';
import { errorHandler } from './lib/errors';
import { requestId } from './middleware/request-id';
import { requestLogger } from './middleware/request-logger';
import { router } from './routes';

export const app = express();

app.disable('x-powered-by');
app.use(requestId);
app.use(requestLogger);
app.use(express.json({ limit: '1mb' }));
app.use(router);
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});
app.use(errorHandler);
