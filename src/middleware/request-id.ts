import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Gives every request an id and keeps it in AsyncLocalStorage for the rest of
 * that request, so anything downstream (services, models, the logger) can
 * read it with `currentRequestId()` without it being passed around by hand.
 */

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/** Honours an incoming `X-Request-Id` header, otherwise generates a UUID. Echoed back on the response. */
export const requestId: RequestHandler = (req, res, next) => {
  const id = req.get('x-request-id') || randomUUID();
  res.set('X-Request-Id', id);
  requestContext.run({ requestId: id }, next);
};
