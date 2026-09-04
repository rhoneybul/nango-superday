import { prisma } from '../lib/prisma';

/**
 * Data access for the `accounts` table. Reads go through
 * src/services/account.service.ts, which caches them; only the seed writes.
 */

export interface Account {
  id: string;
  name: string;
  mainContact: string;
}

const select = { id: true, name: true, mainContact: true } as const;

export async function findAccount(id: string): Promise<Account | null> {
  return prisma.account.findUnique({ where: { id }, select });
}

/** Insert or update (by id). Used by the seed, so re-running it is safe. */
export async function upsertAccount(account: Account): Promise<Account> {
  const { id, name, mainContact } = account;
  return prisma.account.upsert({ where: { id }, create: { id, name, mainContact }, update: { name, mainContact }, select });
}
