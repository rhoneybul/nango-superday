import { HttpError } from '../lib/errors';
import { accountExists } from '../models/account.model';
import { requireAccount } from '../services/account.service';
import type { IngestInput, ListEventsInput } from '../services/event.service';
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

/** POST /ingest/batch → 400 listing every event whose account is unknown (path `events.<index>.account_id`). */
export const requireBatchAccounts: Validated<{ batch: IngestInput[] }> = async (_req, res, next) => {
  const ids = [...new Set(res.locals.batch.map((e) => e.accountId))];
  const exists = await Promise.all(ids.map((id) => accountExists(id)));
  const unknown = new Set(ids.filter((_, i) => !exists[i]));
  if (unknown.size) {
    const details = res.locals.batch.flatMap((e, i) => (unknown.has(e.accountId) ? [{ path: `events.${i}.account_id`, message: `Account ${e.accountId} not found` }] : []));
    throw new HttpError(400, details.map((d) => `${d.path}: ${d.message}`).join('; '), details);
  }
  next();
};
