import { ValidationError } from '../lib/errors';
import { getAccount, requireAccount } from '../services/account.service';
import type { IngestInput } from '../services/event.service';
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

/** Query endpoints: only when the `account` filter is present. `key` is where the validator stored the input. */
export function requireAccountIn<K extends string>(key: K): Validated<Record<K, { account?: string }>> {
  return async (_req, res, next) => {
    const id = res.locals[key].account;
    if (id !== undefined) await requireAccount(id);
    next();
  };
}

/** POST /ingest/batch: every distinct account is looked up once; unknown ones are listed in a 400 with the index of each offending event. */
export const requireBatchAccounts: Validated<{ batch: IngestInput[] }> = async (_req, res, next) => {
  const ids = [...new Set(res.locals.batch.map((e) => e.accountId))];
  const found = await Promise.all(ids.map((id) => getAccount(id)));
  const unknown = new Set(ids.filter((_, i) => found[i] === null));
  if (unknown.size) {
    const details = res.locals.batch.flatMap((e, i) => (unknown.has(e.accountId) ? [{ path: `events.${i}.account_id`, message: `Account ${e.accountId} not found` }] : []));
    throw new ValidationError(details.map((d) => `${d.path}: ${d.message}`).join('; '), details);
  }
  next();
};
