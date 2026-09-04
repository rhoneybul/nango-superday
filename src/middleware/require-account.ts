import { accountExists } from '../models/account.model';
import { requireAccount } from '../services/account.service';
import type { BatchState, IngestInput, ListEventsInput } from '../services/event.service';
import type { Validated } from './validation';

/**
 * Rejects requests that reference an unknown account. Runs after validation
 * (it needs the parsed input) and before any rate limiter, so unknown
 * accounts never consume quota.
 */

/** POST /ingest → 404. */
export const requireIngestAccount: Validated<{ ingest: IngestInput }> = async (_req, res, next) => {
  await requireAccount(res.locals.ingest.accountId);
  next();
};

/** GET /events: only when the `account` filter is present → 404. */
export const requireEventsAccount: Validated<{ listEvents: ListEventsInput }> = async (_req, res, next) => {
  if (res.locals.listEvents.account !== undefined) await requireAccount(res.locals.listEvents.account);
  next();
};

/** POST /ingest/batch: events for unknown accounts move to `errors`; the rest carry on. */
export const requireBatchAccounts: Validated<{ batch: BatchState }> = async (_req, res, next) => {
  const { batch } = res.locals;
  const ids = [...new Set(batch.accepted.map((e) => e.input.accountId))];
  const exists = await Promise.all(ids.map((id) => accountExists(id)));
  const unknown = new Set(ids.filter((_, i) => !exists[i]));
  for (const { index, input } of batch.accepted) {
    if (unknown.has(input.accountId)) {
      batch.errors.push({ index, path: `events.${index}.account_id`, message: `Account ${input.accountId} not found`, reason: 'unknown_account' });
    }
  }
  batch.accepted = batch.accepted.filter((e) => !unknown.has(e.input.accountId));
  next();
};
