import { prisma } from '../lib/prisma';

/** Data access for the `accounts` table: a primary-key lookup, and the upsert the seed uses. */

export async function accountExists(id: string): Promise<boolean> {
  return (await prisma.account.findUnique({ where: { id }, select: { id: true } })) !== null;
}

/** Insert if missing (by id). Used by the seed, so re-running it is safe. */
export async function upsertAccount(id: string): Promise<void> {
  await prisma.account.upsert({ where: { id }, create: { id }, update: {} });
}
