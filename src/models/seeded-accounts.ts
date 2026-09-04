/**
 * The accounts the API knows about. `npm run seed` (src/seed.ts) upserts them
 * into the `accounts` table; the compose `api` service does the same on start.
 * To onboard an account, add it here and re-run the seed. Cached lookups pick
 * the change up within ACCOUNT_CACHE_TTL_SECONDS (a previous miss within 30s).
 */
export interface SeededAccount {
  id: string;
  name: string;
  /** Who to reach about this account's events; surfaced in alerts. */
  mainContact: string;
}

export const SEEDED_ACCOUNTS: readonly SeededAccount[] = [
  { id: 'acc_acme', name: 'Acme Corp', mainContact: 'jane.doe@acme.example' },
  { id: 'acc_globex', name: 'Globex', mainContact: 'hank.scorpio@globex.example' },
  { id: 'acc_initech', name: 'Initech', mainContact: 'peter.gibbons@initech.example' },
  { id: 'acc_umbrella', name: 'Umbrella Corp', mainContact: 'ops@umbrella.example' },
  { id: 'acc_hooli', name: 'Hooli', mainContact: 'gavin.belson@hooli.example' },
];
