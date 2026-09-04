import type { ErrorRequestHandler } from 'express';
import { log } from './logger';

/**
 * The one error type the app throws on purpose: an HTTP status, a message,
 * and optionally a per-item breakdown that goes out as `details`.
 *
 *   400  bad input          new HttpError(400, 'account_id: Too small', details)
 *   404  unknown account    new HttpError(404, 'Account acc_x not found')
 *   429  batch rate limit   new HttpError(429, 'Too many requests', details)
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Single place where errors become HTTP responses. Express 5 routes both
 * thrown errors and rejected promises here, so handlers need no try/catch.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  // express.json() throws a SyntaxError (with a `body` property) on malformed JSON.
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Malformed JSON body' });
    return;
  }
  log.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error' });
};
