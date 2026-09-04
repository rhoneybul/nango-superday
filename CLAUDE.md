# nango-events

Event ingestion API. Express 4 + TypeScript + Prisma 7 (engine-free, `@prisma/adapter-pg`) + Postgres 16. No auth.

## Commands

- `npm run dev` — tsx watch on `src/server.ts` (needs Postgres; `docker compose up -d db`)
- `npm test` — vitest, no DB required (model layer is stubbed)
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — `prisma generate && tsc` → `dist/`
- `npx prisma migrate dev --name <name>` — new migration; `npx prisma migrate deploy` — apply
- `docker compose up --build` — Postgres on :5432 + API on :3000, migrations applied on start

`npm install` runs `prisma generate` (postinstall). Generated client lives in `src/generated/prisma` (gitignored) — never edit it, never import from `@prisma/client` directly; import `../generated/prisma/client`.

## Layout

```
src/config/      typed config from env via Zod. ONLY place that reads process.env. Import `config` from here.
src/routes/      URL → controller wiring only
src/controllers/ HTTP concerns: status codes, response shape, `next(err)`. No validation logic.
src/services/    all input validation + business logic. Throws ValidationError (400) from src/lib/errors.
src/models/      Prisma data access for `events`. Receives already-validated input. Raw SQL only for `countByWindow`.
src/lib/         prisma client (pg adapter), HttpError/ValidationError + errorHandler
src/app.ts       createApp(deps) — deps injectable for tests
src/server.ts    listen + graceful shutdown
prisma/          schema.prisma + migrations (initial migration is hand-written; keep it in sync with schema)
test/            vitest + supertest. helpers.ts builds the real app wired to a vi.fn() model stub.
```

Dependency injection pattern: `createEventService(model)` → `createEventController(service)` → `createApp({ eventController })`. Add new resources the same way.

## Data model

`events`: `id BIGSERIAL`, `account_id TEXT`, `event_name TEXT`, `timestamp TIMESTAMPTZ DEFAULT now()`, `created_at TIMESTAMPTZ`.
Indexes: `(account_id, timestamp)`, `(account_id, event_name, timestamp)`, `(event_name, timestamp)`.
BigInt ids are serialised to strings in API responses (`toRecord` in the model).

## API

- `POST /ingest` body `{ account_id, event_name, timestamp? }` → 201 `{ data: event }`. Missing timestamp → DB `now()`.
- `GET /events?account&event&from&to&window&limit&offset`
  - `from`/`to`: ISO-8601 or epoch ms, inclusive. `from > to` → 400.
  - No `window`: raw events newest-first, `{ data, meta: { total, limit, offset }, filters }`. `limit` defaults to `EVENTS_DEFAULT_LIMIT`, capped at `EVENTS_MAX_LIMIT`.
  - With `window` (`<n><s|m|h|d|w>`, e.g. `15m`, `1h`, `1d`): aggregated mode, `{ window, windowSeconds, buckets: [{ windowStart, count }], filters }`. Buckets are epoch-aligned via Postgres `date_bin`; empty buckets omitted.
  - Repeated query params (`?account=a&account=b`) → 400. Empty string params are treated as absent.
- Errors: `400 { error, details? }` for validation, `500 { error: "Internal server error" }` otherwise (no leak).
- `GET /health` → `{ status: "ok" }`.

## Conventions

- Validation messages are asserted by regex in tests — changing wording means updating `test/`.
- Test env (`vitest.config.ts`) sets `EVENTS_DEFAULT_LIMIT=50`, `EVENTS_MAX_LIMIT=500`; tests depend on those values.
- Config is frozen; add new settings to the Zod schema + `Config` type in `src/config/index.ts`, and to `.env.example` and `docker-compose.yml`.
- Prisma engines can't be downloaded in some sandboxes; `PRISMA_SCHEMA_ENGINE_BINARY=/usr/bin/true npx prisma generate` still works for `generate` (WASM-based). `migrate` does need the real engine.

## Status

Phase 1 complete: scaffold, compose, schema/indexes, both endpoints, config package, 51 tests (43 on GET /events). Verified end-to-end against a real Postgres 16.
