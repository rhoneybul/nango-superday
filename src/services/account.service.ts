import { HttpError } from '../lib/errors';
import { accountExists } from '../models/account.model';

/** Throws a 404 unless `id` is a seeded account. A primary-key lookup, cheap enough to run on every request. */
export async function requireAccount(id: string): Promise<void> {
  if (!(await accountExists(id))) throw new HttpError(404, `Account ${id} not found`);
}
