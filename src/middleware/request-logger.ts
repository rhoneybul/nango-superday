import type { RequestHandler } from 'express';
import { log } from '../lib/logger';
import { httpRequestDuration, httpRequests } from '../lib/metrics';

/** Logs one line and records the HTTP metrics for every request once the response has been sent. */
export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    log.info({ method: req.method, path: req.originalUrl, status: res.statusCode, durationMs }, 'request');

    const labels = { method: req.method, route: req.route?.path ?? 'unmatched', status: String(res.statusCode) };
    httpRequests.inc(labels);
    httpRequestDuration.observe(labels, durationMs / 1000);
  });
  next();
};
