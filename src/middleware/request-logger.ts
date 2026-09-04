import type { RequestHandler } from 'express';
import { log } from '../lib/logger';

/** Logs one line per request once the response has been sent. */
export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    log.info(
      { method: req.method, path: req.originalUrl, status: res.statusCode, durationMs: Date.now() - startedAt },
      'request',
    );
  });
  next();
};
