import { config } from '../config';
import { cache } from '../lib/cache';
import { NotFoundError } from '../lib/errors';
import * as accounts from '../models/account.model';
import type { Account } from '../models/account.model';

/**
 * Account lookups, cached so that checking every request costs one Redis
 * round trip instead of a database query. Hits are cached for
 * ACCOUNT_CACHE_TTL_SECONDS; misses for a short fixed time, so a flood of
 * requests for an unknown id does not reach Postgres, while an account
 * seeded after a miss is picked up quickly.
 */

const MISS = 'missing';
const MISS_TTL_SECONDS = 30;

const cacheKey = (id: string) => `account:${id}`;

export async function getAccount(id: string): Promise<Account | null> {
  const cached = await cache.get(cacheKey(id));
  if (cached !== null) return cached === MISS ? null : (JSON.parse(cached) as Account);

  const account = await accounts.findAccount(id);
  await cache.set(cacheKey(id), account ? JSON.stringify(account) : MISS, account ? config.accountCacheTtlSeconds : MISS_TTL_SECONDS);
  return account;
}

/** The account, or a NotFoundError (→ 404) when the id is not a seeded account. */
export async function requireAccount(id: string): Promise<Account> {
  const account = await getAccount(id);
  if (!account) throw new NotFoundError(`Account ${id} not found`);
  return account;
}
