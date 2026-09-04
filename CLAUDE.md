# nango-events

Event ingestion API. Express 4 + TypeScript + Prisma 7 (engine-free, `@prisma/adapter-pg`) + Postgres 16. No auth; every event must belong to a seeded account.

## Development
- Implement everything with a core focus on simplicity and readability 
- Please make sure that we have components well structured and clearly laid out
- Use a clear controller/service/model pattern where controllers handle requests, service handle application logic and models handle thedata access patterns
- Ensure that key operations and modules have their own files
- Implement with a key focus on error handling and clear error message publishing
- Make sure we implement with operability in mind, so hence make sure this has appropriate and clear json logging etc
- Make sure that we have tests implemented however don't need to test every single edge case, focus on testing key functionality and common error paths


## Commands

- `npm run dev` — tsx watch on `src/server.ts` (needs Postgres; `docker compose up -d db`)
- `npm test` — vitest, no DB required (model layer is stubbed)
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — `prisma generate && tsc` → `dist/`
- `npx prisma migrate dev --name <name>` — new migration; `npx prisma migrate deploy` — apply
- `npm run seed` — upsert `SEEDED_ACCOUNTS` (`src/models/seeded-accounts.ts`) into `accounts` (also `npx prisma db seed`; idempotent). Compose runs `node dist/seed.js` after migrations on every start
- `docker compose up --build` — Postgres on :5432 + API on :3000, migrations applied on start

`npm install` runs `prisma generate` (postinstall). Generated client lives in `src/generated/prisma` (gitignored) — never edit it, never import from `@prisma/client` directly; import `../generated/prisma/client`.

## Layout

```
src/config/      typed config from env via Zod. ONLY place that reads process.env. Import `config` from here.
src/routes/      URL → controller wiring only
src/controllers/ HTTP concerns: status codes, response shape, `next(err)`. No validation logic.
src/services/    all input validation + business logic. Throws ValidationError (400) from src/lib/errors.
src/models/      Prisma data access for `events`. Receives already-validated input. Raw SQL only for `countByWindow`. `account.model.ts` (`findAccount`, `upsertAccount`); `seeded-accounts.ts` (`SEEDED_ACCOUNTS`: id, name, mainContact — the only place accounts are defined).
src/middleware/require-account.ts  `requireIngestAccount` / `requireEventsAccount`: cached account lookup, NotFoundError → 404. Runs after validation and before the rate limiter.
src/services/account.service.ts    `getAccount` / `requireAccount` through the cache (key `account:<id>`; hit TTL `ACCOUNT_CACHE_TTL_SECONDS`, miss cached 30s as the string `missing`).
src/lib/redis.ts, src/lib/cache.ts  the one shared Redis client (`undefined` without REDIS_URL) and the `Cache` interface over it (in-memory Map fallback; Redis errors → warn + miss).
src/seed.ts      seed entry point (compiled to dist/seed.js for compose)
src/lib/         prisma client (pg adapter), HttpError/ValidationError + errorHandler
src/app.ts       createApp(deps) — deps injectable for tests
src/server.ts    listen + graceful shutdown
prisma/          schema.prisma + migrations (initial migration is hand-written; keep it in sync with schema)
test/            vitest + supertest. helpers.ts builds the real app wired to a vi.fn() model stub.
```

Dependency injection pattern: `createEventService(model)` → `createEventController(service)` → `createApp({ eventController })`. Add new resources the same way.

## Data model

`accounts`: `id TEXT PK`, `name TEXT`, `main_contact TEXT`, `created_at TIMESTAMPTZ`. Populated only by the seed from `SEEDED_ACCOUNTS`; no FK from `events` (existing rows may predate the table), the application check is what enforces membership.
`events`: `id BIGSERIAL`, `account_id TEXT`, `event_name TEXT`, `timestamp TIMESTAMPTZ DEFAULT now()`, `created_at TIMESTAMPTZ`.
Indexes: `(account_id, timestamp)`, `(account_id, event_name, timestamp)`, `(event_name, timestamp)`.
BigInt ids are serialised to strings in API responses (`toRecord` in the model).

## API

- `POST /ingest` body `{ account_id, event_name, timestamp? }` → 201 `{ data: event }`. `account_id` must be a seeded account → otherwise `404 { error: "Account <id> not found" }` (checked after validation, before the rate limit, so unknown accounts consume no quota). Missing timestamp → DB `now()`.
- `GET /events?account&event&from&to&window&limit&offset`
  - `from`/`to`: ISO-8601 or epoch ms, inclusive. `from > to` → 400.
  - No `window`: raw events newest-first, `{ data, meta: { total, limit, offset }, filters }`. `limit` defaults to `EVENTS_DEFAULT_LIMIT`, capped at `EVENTS_MAX_LIMIT`.
  - With `window` (`<n><s|m|h|d|w>`, e.g. `15m`, `1h`, `1d`): aggregated mode, `{ window, windowSeconds, buckets: [{ windowStart, count }], filters }`. Buckets are epoch-aligned via Postgres `date_bin`; empty buckets omitted.
  - `account` must be a seeded account → otherwise 404 (same check and cache as ingest). No `account` → no lookup.
  - Repeated query params (`?account=a&account=b`) → 400. Empty string params are treated as absent.
- Errors: `400 { error, details? }` for validation, `404 { error: "Account <id> not found" }` (NotFoundError), `500 { error: "Internal server error" }` otherwise (no leak).
- `GET /health` → `{ status: "ok" }`.

## Conventions

- Accounts: to onboard one, add it to `SEEDED_ACCOUNTS` and run `npm run seed` (no migration). The cache picks it up within 30s (miss TTL) or `ACCOUNT_CACHE_TTL_SECONDS` for a changed name/contact.
- Tests `vi.mock` both model modules (`event.model`, `account.model`); helpers.ts makes every account id exist unless a test overrides `findAccount`. No REDIS_URL, so the cache is in memory and shared within a test file: use distinct account ids per test when counting lookups.
- Validation messages are asserted by regex in tests — changing wording means updating `test/`.
- Test env (`vitest.config.ts`) sets `EVENTS_DEFAULT_LIMIT=50`, `EVENTS_MAX_LIMIT=500`; tests depend on those values.
- Config is frozen; add new settings to the Zod schema + `Config` type in `src/config/index.ts`, and to `.env.example` and `docker-compose.yml`.
- Prisma engines can't be downloaded in some sandboxes; `PRISMA_SCHEMA_ENGINE_BINARY=/usr/bin/true npx prisma generate` still works for `generate` (WASM-based). `migrate` does need the real engine.

