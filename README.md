# nango-events

Barebones event ingestion API: Express 5 + Prisma 7 + Postgres.

## Run with Docker

```bash
docker compose up --build
```

Starts Postgres on `:5432`, Redis on `:6379`, Grafana on `:3001` (login `admin`/`admin`, the events database is pre-configured as a datasource) and the API on `:3000`. Migrations are applied automatically on startup.

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

`event_name` must be one of `signup`, `login`, `logout`, `purchase` (the `EventName` enum in `src/models/event-name.ts`). `timestamp` is optional and defaults to `NOW()` in the database; it may not be in the future. Returns `201` with the stored event.

Ingest is rate limited to `INGEST_RATE_LIMIT_PER_MINUTE` (default 100) per `account_id` + `event_name` pair, so one noisy event never blocks an account's other events. Over the limit returns `429 { "error": "Too many requests" }` with standard `RateLimit-*` headers. Counters are stored in Redis (`REDIS_URL`); without it they are kept in process memory.

### `GET /events`

| Param     | Description                                                                 |
|-----------|-----------------------------------------------------------------------------|
| `account` | Filter by account id                                                        |
| `event`   | Filter by event name (must be a known `EventName`)                          |
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

Invalid input returns `400 { "error": "field: reason; …", "details": [{ "path": "field", "message": "reason" }] }`. Every response carries an `X-Request-Id` header (your own is echoed back if you send one), and the same id appears on every JSON log line for that request.

## Load testing

```bash
npm run load                          # load/example.json
LOAD_CONFIG=my-run.json npm run load  # any file inside load/
```

Runs [k6](https://grafana.com/docs/k6/latest/) via Docker Compose against the API, one fixed-rate stream per
`{ account_id, event_name, rps }` entry in the JSON config, for a configurable duration, and prints throughput,
status-code counts and p50/p95/p99 latency. See [load/README.md](load/README.md) for the config format and how
to read the report. The default example mixes streams that stay under the ingest rate limit with ones that
trip it.

## Layout

```
src/
  config/        settings read from env (single source of truth)
  routes.ts      URL → validation middleware → controller wiring
  middleware/    request id, request logging, rate limiting, input validation (zod)
  controllers/   HTTP concerns: status codes, response shape
  services/      business logic (filter building, model calls) on validated input
  models/        Prisma data access (events table)
  lib/           prisma client, error type/handler, pino logger
  generated/     Prisma client output (gitignored, created by `prisma generate`)
prisma/          schema + migrations
load/            k6 load generator: publish.js + JSON run configs (see load/README.md)
test/            vitest + supertest against the real app, model module mocked with vi.mock
```

Indexes on `events`: `(account_id, timestamp)`, `(account_id, event_name, timestamp)`, `(event_name, timestamp)`.

## Postman

Import `postman/nango-events.postman_collection.json`. It covers valid ingests, each kind of invalid input, the rate limit (run the "Rate limit" request 101 times with the Collection Runner), and the query endpoint. Set the `baseUrl` variable if the API is not on `http://localhost:3000`.

## Tests

```bash
npm test
```

No database required — the model layer is stubbed and the tests focus on `GET /events` parameter handling.
