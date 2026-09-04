import { requireAccount } from '../services/account.service';
import type { IngestInput, ListEventsInput } from '../services/event.service';
import type { Validated } from './validation';

/**
 * Rejects requests that reference an unknown account with a 404. Runs after
 * validation (it needs the parsed input) and, on POST /ingest, before the rate
 * limiter, so unknown accounts never consume quota.
 */

export const requireIngestAccount: Validated<{ ingest: IngestInput }> = async (_req, res, next) => {
  await requireAccount(res.locals.ingest.accountId);
  next();
};

/** GET /events: only when the `account` filter is present. */
export const requireEventsAccount: Validated<{ listEvents: ListEventsInput }> = async (_req, res, next) => {
  const id = res.locals.listEvents.account;
  if (id !== undefined) await requireAccount(id);
  next();
};
