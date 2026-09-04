# nango-events

Barebones event ingestion API: Express 5 + Prisma 7 + Postgres.

## Run with Docker

```bash
docker compose up --build
```

Starts Postgres on `:5432`, Redis on `:6379`, Prometheus on `:9090`, Grafana on `:3001` (login `admin`/`admin`, with the events database and Prometheus pre-configured as datasources) and the API on `:3000`. Migrations are applied automatically on startup. Host ports can be overridden with `DB_PORT`, `REDIS_PORT`, `PROMETHEUS_PORT`, `GRAFANA_PORT`, `API_PORT`.
For Slack alerts, put a Slack incoming-webhook URL for `#superday-rob` in `.env` as `SLACK_WEBHOOK_URL` before starting (see [Alerting](#alerting)).

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

Ingest is rate limited to `INGEST_RATE_LIMIT_PER_MINUTE` (default 100) per `account_id` + `event_name` pair, so one noisy event never blocks an account's other events. Over the limit returns `429 { "error": "Too many requests" }` with standard `RateLimit-*` headers. Counters are stored in Redis (`REDIS_URL`); without it they are kept in process memory. Every rejection is counted in the `ingest_rate_limited_total` metric, which drives the `RateLimitExceeded` alert (see [Alerting](#alerting)).

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

### `GET /metrics`

Prometheus exposition of the API's metrics: `ingest_rate_limited_total{account_id,event_name}` (rejections), `ingest_rate_limited_last_seen_timestamp_seconds{account_id,event_name}` (time of the latest rejection), plus Node process defaults. Scraped every 10s by the `prometheus` compose service.

Invalid input returns `400 { "error": "field: reason; …", "details": [{ "path": "field", "message": "reason" }] }`. Every response carries an `X-Request-Id` header (your own is echoed back if you send one), and the same id appears on every JSON log line for that request.

## Alerting

Event driven, no database involved: the rate limiter records each 429 it sends as a metric, Prometheus scrapes it, and [Grafana alerting](https://grafana.com/docs/grafana/latest/alerting/) does the rest. Everything on the Grafana side is provisioned from `grafana/provisioning/alerting/` and also editable in the UI under Alerting:

- `rules.yml` — the alert rules. `RateLimitExceeded` evaluates `time() - ingest_rate_limited_last_seen_timestamp_seconds < 60` every 10s: an `account_id` + `event_name` pair is alerting while its latest rejection is under a minute old, and resolves after a minute without one. One alert instance per pair.
- `contact-points.yml` — where alerts go. Slack `#superday-rob` (via `SLACK_WEBHOOK_URL`) is the only one; add a `webhook`, `pagerduty`, `email`, … receiver to the same contact point to fan every alert out to another consumer.
- `notification-policies.yml` — grouping (one notification per pair) and routing. Add a route with matchers to send only some alerts to another contact point.

Grafana handles state, deduplication and delivery. On firing, Slack gets:

> :rotating_light: RateLimitExceeded — Account acc_1 is over its signup ingest limit: its signup events are being rejected with 429.

Once the pair has gone a minute without a rejection the same contact points get:

> :white_check_mark: Resolved: RateLimitExceeded — Account acc_1 is back under its signup ingest limit: no rejections for a minute.

Adding an alert: record a metric in `src/lib/metrics.ts` at the point where the thing happens, then add a rule to `rules.yml` with a Prometheus query, a threshold, and `summary`/`resolved` annotations (one plain, actionable line each).

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
  lib/           prisma client, error type/handler, pino logger, Prometheus metrics registry
  generated/     Prisma client output (gitignored, created by `prisma generate`)
prisma/          schema + migrations
prometheus/      scrape config (the API's /metrics)
grafana/         Grafana provisioning: datasources (Postgres, Prometheus); alert rules, contact points, notification policies
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
