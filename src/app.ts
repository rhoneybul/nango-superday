import express, { type Express } from 'express';
import { errorHandler } from './lib/errors';
import { createRouter, type RouteDeps } from './routes';

/** Builds the Express app. Dependencies are injectable so tests can stub the service layer. */
export function createApp(deps: RouteDeps = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(createRouter(deps));
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);
  return app;
}
