import { log } from './lib/logger';
import { prisma } from './lib/prisma';
import { upsertAccount } from './models/account.model';
import { SEEDED_ACCOUNTS } from './models/seeded-accounts';

/**
 * Seeds the `accounts` table from SEEDED_ACCOUNTS. Idempotent (upsert), so it
 * runs on every container start (docker-compose.yml) and via `npm run seed`
 * or `npx prisma db seed` locally.
 */
async function main() {
  for (const account of SEEDED_ACCOUNTS) await upsertAccount(account);
  log.info({ count: SEEDED_ACCOUNTS.length, ids: SEEDED_ACCOUNTS.map((a) => a.id) }, 'accounts seeded');
}

main()
  .catch((err) => {
    log.error({ err }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
