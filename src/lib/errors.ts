import type { ErrorRequestHandler } from 'express';
import { log } from './logger';

/** Thrown for bad input. Rendered as a 400 by `errorHandler`. */
export class ValidationError extends Error {
  constructor(
    message: string,
    /** Optional per-field breakdown, echoed in the response as `details`. */
    public readonly details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Thrown when a referenced resource (an account) does not exist. Rendered as a 404 by `errorHandler`. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Thrown when a request exceeds a rate limit checked in code (batch ingest). Rendered as a 429 by `errorHandler`. */
export class RateLimitError extends Error {
  constructor(
    /** Which accounts are over which limit, echoed in the response as `details`. */
    public readonly details: { account: string; limit: number }[],
  ) {
    super('Too many requests');
    this.name = 'RateLimitError';
  }
}

/**
 * Single place where errors become HTTP responses. Express 5 routes both
 * thrown errors and rejected promises here, so handlers need no try/catch.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message, details: err.details });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof RateLimitError) {
    res.status(429).json({ error: err.message, details: err.details });
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
