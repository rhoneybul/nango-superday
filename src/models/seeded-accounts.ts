/**
 * The accounts (customers) the API accepts events for. `npm run seed`
 * (src/seed.ts) upserts them into the `accounts` table; the compose `api`
 * service does the same on every start. To onboard an account, add its id
 * here and re-run the seed.
 */
export const SEEDED_ACCOUNT_IDS: readonly string[] = ['acc_acme', 'acc_globex', 'acc_initech', 'acc_umbrella', 'acc_hooli'];
