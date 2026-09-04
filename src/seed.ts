import { log } from './lib/logger';
import { prisma } from './lib/prisma';
import { upsertAccount } from './models/account.model';
import { SEEDED_ACCOUNT_IDS } from './models/seeded-accounts';

/**
 * Seeds the `accounts` table from SEEDED_ACCOUNT_IDS. Idempotent (upsert), so
 * it runs on every container start (docker-compose.yml) and via `npm run seed`
 * or `npx prisma db seed` locally.
 */
async function main() {
  for (const id of SEEDED_ACCOUNT_IDS) await upsertAccount(id);
  log.info({ ids: SEEDED_ACCOUNT_IDS }, 'accounts seeded');
}

main()
  .catch((err) => {
    log.error({ err }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
