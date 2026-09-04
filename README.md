# nango-events

Barebones event ingestion API: Express + Prisma 7 + Postgres.

## Run with Docker

```bash
docker compose up --build
```

Starts Postgres on `:5432` and the API on `:3000`. Migrations are applied automatically on startup.

## Run locally

```bash
cp .env.example .env         # DATABASE_URL points at the compose Postgres by default
docker compose up -d db
npm install                  # also runs `prisma generate`
npx prisma migrate deploy
npm run dev
```

## Endpoints

### `POST /ingest`

```json
{ "account_id": "acc_1", "event_name": "signup", "timestamp": "2026-09-01T10:15:00Z" }
```

`timestamp` is optional and defaults to `NOW()` in the database. Returns `201` with the stored event.

### `GET /events`

| Param     | Description                                                                 |
|-----------|-----------------------------------------------------------------------------|
| `account` | Filter by account id                                                        |
| `event`   | Filter by event name                                                        |
| `from`    | Inclusive lower bound on `timestamp` (ISO-8601 or epoch ms)                 |
| `to`      | Inclusive upper bound on `timestamp` (ISO-8601 or epoch ms)                 |
| `window`  | Bucket size, e.g. `30s`, `15m`, `1h`, `1d`, `1w`. Switches to aggregated mode |
| `limit`   | Page size (default `EVENTS_DEFAULT_LIMIT`, max `EVENTS_MAX_LIMIT`)          |
| `offset`  | Page offset                                                                 |

Without `window` the response is the raw events, newest first:

```json
{ "data": [...], "meta": { "total": 2, "limit": 100, "offset": 0 }, "filters": { "account": "acc_1" } }
```

With `window` the response is a count per time bucket (epoch-aligned via Postgres `date_bin`; empty buckets omitted):

```json
{ "window": "1h", "windowSeconds": 3600, "buckets": [{ "windowStart": "2026-09-01T10:00:00.000Z", "count": 2 }], "filters": {} }
```

Invalid input returns `400 { "error": "..." }`.

## Layout

```
src/
  config/        typed config loaded from env (single source of truth)
  routes/        URL → controller wiring
  controllers/   HTTP concerns: status codes, response shape
  services/      input validation + business logic
  models/        Prisma data access (events table)
  lib/           prisma client, error types/handler
  generated/     Prisma client output (gitignored, created by `prisma generate`)
prisma/          schema + migrations
test/            vitest + supertest, service/controller wired to a stubbed model
```

Indexes on `events`: `(account_id, timestamp)`, `(account_id, event_name, timestamp)`, `(event_name, timestamp)`.

## Tests

```bash
npm test
```

No database required — the model layer is stubbed and the tests focus on `GET /events` parameter handling.
