# nango-events

Event ingestion API. Express 5 + TypeScript + RabbitMQ 4 (amqplib) + Prisma 7 (engine-free, `@prisma/adapter-pg`) + Postgres 16. `POST /ingest` publishes to RabbitMQ (202); `src/consumer.ts` (a second process, same image) reads the queue and inserts into Postgres. No auth; every event must belong to a seeded account.

## Development
- Implement everything with a core focus on simplicity and readability 
- Please make sure that we have components well structured and clearly laid out
- Use a clear controller/service/model pattern where controllers handle requests, service handle application logic and models handle thedata access patterns
- Ensure that key operations and modules have their own files
- Implement with a key focus on error handling and clear error message publishing
- Make sure we implement with operability in mind, so hence make sure this has appropriate and clear json logging etc
- Make sure that we have tests implemented however don't need to test every single edge case, focus on testing key functionality and common error paths


## Commands

- `npm run dev` — tsx watch on `src/server.ts` (needs Postgres + RabbitMQ; `docker compose up -d db rabbitmq`)
- `npm run dev:consumer` — tsx watch on `src/consumer.ts` (`start:consumer` = `node dist/consumer.js`, what compose runs)
- `npm test` — vitest, no DB/broker required (model layer and publisher are stubbed)
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — `prisma generate && tsc` → `dist/`
- `npx prisma migrate dev --name <name>` — new migration; `npx prisma migrate deploy` — apply
- `npm run seed` — upsert `SEEDED_ACCOUNTS` (`src/models/seeded-accounts.ts`) into `accounts` (also `npx prisma db seed`; idempotent). Compose runs `node dist/seed.js` after migrations on every start
- `docker compose up --build` — Postgres :5432, RabbitMQ :5672 (mgmt UI :15672, nango/nango), API :3000, consumer; migrations applied on start
- `npm run load` / `npm run load:throughput` — k6 via compose: `load/example.json` (rate-limit behaviour) / `load/throughput.json` (100 events/s stored for 60s; lift the limiter first with `INGEST_RATE_LIMIT_PER_MINUTE=100000 docker compose up -d api`)
- `docker compose up --build` — Postgres on :5432 + API on :3000, migrations applied on start

`npm install` runs `prisma generate` (postinstall). Generated client lives in `src/generated/prisma` (gitignored) — never edit it, never import from `@prisma/client` directly; import `../generated/prisma/client`.

## Layout

```
src/config/      typed config from env via Zod. ONLY place that reads process.env. Import `config` from here.
src/routes/      URL → controller wiring only
src/controllers/ HTTP concerns: status codes, response shape, `next(err)`. No validation logic.
src/services/    all input validation + business logic. Throws HttpError from src/lib/errors.
src/queue/       topology.ts (exchange `events` → quorum queue `events` with x-dead-letter-exchange `events.dlx` + x-delivery-limit 5 → `events.dlq`; `assertTopology`), message.ts (EventMessage zod codec), publisher.ts (`startPublisher` with amqplib recovery, `publishEvent` on a confirm channel; rejects while disconnected → 500).
src/consumer.ts  `handleMessage`: decode fail → nack requeue=false (DLQ now); insert fail → nack requeue=true (broker dead-letters after the delivery limit); else ack. `main()` connects (recovery), prefetch 50, consumes.
src/models/      Prisma data access for `events`. Receives already-validated input. Raw SQL only for `countByWindow`. `account.model.ts` (`findAccount`, `upsertAccount`); `seeded-accounts.ts` (`SEEDED_ACCOUNTS`: id, name, mainContact — the only place accounts are defined).
src/middleware/require-account.ts  `requireIngestAccount` (404), `requireEventsAccount` (404 when the filter is set), `requireBatchAccounts` (400 listing `events.<i>.account_id`). Run after validation and before the rate limiter.
src/services/account.service.ts    `requireAccount(id)`: primary-key lookup, `HttpError(404)` when missing. No cache: the table is tiny and the lookup is sub-millisecond.
src/lib/redis.ts, src/lib/rate-limit-store.ts  the Redis client (`undefined` without REDIS_URL) and the express-rate-limit store over it (MemoryStore fallback), shared by the /ingest limiter and `batchRateLimit`.
src/seed.ts      seed entry point (compiled to dist/seed.js for compose)
src/lib/         prisma client (pg adapter), HttpError/ValidationError + errorHandler
src/app.ts       the express app
src/server.ts    starts the publisher (background), listen + graceful shutdown
rabbitmq/        rabbitmq.conf (per-queue Prometheus metrics) + enabled_plugins, mounted by compose
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

- `POST /ingest` body `{ account_id, event_name, timestamp? }` → 202 `{ data: { accountId, eventName, timestamp } }` once the broker confirmed the publish (no DB id yet; the consumer inserts later). `account_id` must be a seeded account → otherwise `404 { error: "Account <id> not found" }` (checked after validation, before the rate limit, so unknown accounts consume no quota). Missing timestamp → the API's receive time. Broker down → 500.
- `POST /ingest/batch` body `{ events: [{ account_id, event_name, timestamp }] }` (1–100 events, `timestamp` required) → 202 `{ data: { queued } }`. Same middleware chain as single ingest: `validateIngestBatch` (400, `details` per problem at `events.<i>.<field>`), `requireBatchAccounts` (400 listing unknown accounts), `batchRateLimit` (`INGEST_BATCH_RATE_LIMIT_PER_MINUTE`, 10 per account per minute, keys `batch:<account>`; any account over → `429 { error, details: [{ account, limit }] }`, recorded in `ingest_batch_rate_limited_*`). All-or-nothing.
- `GET /events?account&event&from&to&window&limit&offset`
  - `from`/`to`: ISO-8601 or epoch ms, inclusive. `from > to` → 400.
  - No `window`: raw events newest-first, `{ data, meta: { total, limit, offset }, filters }`. `limit` defaults to `EVENTS_DEFAULT_LIMIT`, capped at `EVENTS_MAX_LIMIT`; page with `offset`.
  - With `window` (**aggregation bucket size**: `minute|hour|day` or `<n><s|m|h|d|w>`; **requires `from` and `to`**): `{ window, windowSeconds, buckets: [{ windowStart, count }], meta: { total, limit, offset }, filters }`. Buckets come from Postgres `date_bin` aligned to `BUCKET_ORIGIN_MS` (1970-01-05, a Monday → hours/days/weeks start on the hour/00:00 UTC/Monday); `fillEmptyBuckets` in the service adds missing buckets as 0, so a 24h range at `1h` is exactly 24 values. Buckets are paged with `limit`/`offset` (`meta.total` = bucket count). More than `EVENTS_MAX_BUCKETS` (10000) buckets → 400, checked in validation from `from`/`to`/`window`.
  - Repeated query params (`?account=a&account=b`) → 400. Empty string params are treated as absent.
- Errors: `400 { error, details? }` for validation, `404 { error: "Account <id> not found" }` (NotFoundError), `500 { error: "Internal server error" }` otherwise (no leak).
- `GET /health` → `{ status: "ok" }`.

## Conventions

- Accounts: to onboard one, add its id to `SEEDED_ACCOUNT_IDS` and run `npm run seed` (no migration). Accounts are ids only.
- Tests `vi.mock` both model modules (`event.model`, `account.model`) and `queue/publisher`; helpers.ts makes every account id exist and every publish succeed unless a test overrides `findAccount` / `publishEvent`. Config requires RABBITMQ_URL (set in vitest.config.ts).
- Queue args are fixed at declaration (RabbitMQ refuses a redeclare with different args): delete the queue in the management UI before changing DELIVERY_LIMIT. Grafana dashboard `queue.json` uses RabbitMQ's per-queue metrics (`prometheus.return_per_object_metrics = true` in rabbitmq/rabbitmq.conf). No REDIS_URL, so the cache is in memory and shared within a test file: use distinct account ids per test when counting lookups.
- Validation messages are asserted by regex in tests — changing wording means updating `test/`.
- Test env (`vitest.config.ts`) sets `EVENTS_DEFAULT_LIMIT=50`, `EVENTS_MAX_LIMIT=500`; tests depend on those values.
- Config is frozen; add new settings to the Zod schema + `Config` type in `src/config/index.ts`, and to `.env.example` and `docker-compose.yml`.
- Prisma engines can't be downloaded in some sandboxes; `PRISMA_SCHEMA_ENGINE_BINARY=/usr/bin/true npx prisma generate` still works for `generate` (WASM-based). `migrate` does need the real engine.


Pagination rule: every list-shaped fetch is bounded and paged with `limit` (≤ `EVENTS_MAX_LIMIT`) and `offset`: `findEvents` for the raw listing, the windowed buckets in the service (capped by `EVENTS_MAX_BUCKETS`). Account reads are by primary key only; Grafana panel SQL carries its own `LIMIT`.
