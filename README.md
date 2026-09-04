# nango-events

Barebones event ingestion API: Express 5 + RabbitMQ + Prisma 7 + Postgres.

```
POST /ingest ─▶ API ─publish─▶ RabbitMQ `events` ─▶ consumer ─insert─▶ Postgres ◀─ GET /events
                202                    │ bad message / 5 failed deliveries
                                       ▼
                                  `events.dlq`
```

## Run with Docker

```bash
docker compose up --build
```

Starts Postgres on `:5432`, Redis on `:6379`, RabbitMQ on `:5672` (management UI `:15672`, `nango`/`nango`), Prometheus on `:9090`, Grafana on `:3001` (login `admin`/`admin`, with the events database and Prometheus pre-configured as datasources), the API on `:3000` and the consumer. Migrations are applied and the [accounts](#accounts) seeded automatically on startup. Host ports can be overridden with `DB_PORT`, `REDIS_PORT`, `RABBITMQ_PORT`, `RABBITMQ_MANAGEMENT_PORT`, `PROMETHEUS_PORT`, `GRAFANA_PORT`, `API_PORT`. `--scale consumer=3` runs more consumers.
For Slack alerts, put a Slack bot token in `.env` as `SLACK_BOT_TOKEN` before starting. The bot needs the `chat:write` scope and must be invited to `#superday-rob` (see [Alerting](#alerting)).

## Run locally

```bash
cp .env.example .env         # DATABASE_URL points at the compose Postgres by default
docker compose up -d db rabbitmq
npm install                  # also runs `prisma generate`
npx prisma migrate deploy
npm run seed                 # upsert the seeded accounts (src/models/seeded-accounts.ts)
npm run dev                  # the API
npm run dev:consumer         # the consumer, in another terminal
```

## Accounts

Events belong to accounts, and the API only accepts events for accounts it knows. The list lives in
`src/models/seeded-accounts.ts` (`id`, `name`, `mainContact`) and `npm run seed` upserts it into the
`accounts` table (compose does this on every start, so re-running is safe):

| id             | name          | main contact                    |
|----------------|---------------|---------------------------------|
| `acc_acme`     | Acme Corp     | jane.doe@acme.example           |
| `acc_globex`   | Globex        | hank.scorpio@globex.example     |
| `acc_initech`  | Initech       | peter.gibbons@initech.example   |
| `acc_umbrella` | Umbrella Corp | ops@umbrella.example            |
| `acc_hooli`    | Hooli         | gavin.belson@hooli.example      |

`POST /ingest` and the `account` filter on `GET /events` both check the id and answer
`404 { "error": "Account acc_x not found" }` for anything else. The check is cached in Redis (`account:<id>`,
`ACCOUNT_CACHE_TTL_SECONDS`, default 300; a miss is cached for 30s) so it costs a Redis round trip rather
than a database query per request; without `REDIS_URL` the cache is in process memory. To onboard an
account, add it to the list and run the seed; it is live within 30s.

## Endpoints

### `POST /ingest`

```json
{ "account_id": "acc_1", "event_name": "signup", "timestamp": "2026-09-01T10:15:00Z" }
```

`account_id` must be a seeded [account](#accounts) (`404` otherwise). `event_name` must be one of `signup`, `login`, `logout`, `purchase` (the `EventName` enum in `src/models/event-name.ts`). `timestamp` is optional and defaults to the time the API received the event; it may not be in the future.

Returns `202` with the event as queued (`{ "data": { "accountId", "eventName", "timestamp" } }`): the API publishes it to RabbitMQ and the consumer inserts it into Postgres a moment later. See [Queue](#queue).

Ingest is rate limited to `INGEST_RATE_LIMIT_PER_MINUTE` (default 100) per `account_id` + `event_name` pair, so one noisy event never blocks an account's other events. Over the limit returns `429 { "error": "Too many requests" }` with standard `RateLimit-*` headers. Counters are stored in Redis (`REDIS_URL`); without it they are kept in process memory. The account check runs before the limiter, so unknown accounts never consume quota. Every rejection is counted in the `ingest_rate_limited_total` metric, which drives the `RateLimitExceeded` alert (see [Alerting](#alerting)).

### `GET /events`

| Param     | Description                                                                 |
|-----------|-----------------------------------------------------------------------------|
| `account` | Filter by account id (must be a seeded account, `404` otherwise)            |
| `event`   | Filter by event name (must be a known `EventName`)                          |
| `from`    | Inclusive lower bound on `timestamp` (ISO-8601 or epoch ms)                 |
| `to`      | Inclusive upper bound on `timestamp` (ISO-8601 or epoch ms)                 |
| `window`  | Aggregation bucket size: `minute`, `hour`, `day`, or `30s`, `15m`, `1h`, `1d`, `1w` (max `366d`). Switches to aggregated mode |
| `limit`   | Page size (default `EVENTS_DEFAULT_LIMIT`, max `EVENTS_MAX_LIMIT`)          |
| `offset`  | Page offset (simple paging; cost grows with depth)                          |
| `cursor`  | Raw listing only: `meta.nextCursor` from the previous page (keyset paging; constant cost). Not with `offset` |

Without `window` the response is the raw events, newest first:

```json
{ "data": [...], "meta": { "total": 2, "limit": 100, "offset": 0, "nextCursor": null }, "filters": { "account": "acc_1" } }
```

With `window` the response is a count per bucket, oldest first. Buckets are aligned to the clock (a `1h`
bucket starts on the hour, `1d` at 00:00 UTC, `1w` on a Monday), and when `from` and `to` are given every
bucket in the range is present, so a 24h range at `window=1h` is exactly 24 values, empty ones as `0`.
Buckets are paged with `limit`/`offset`; `meta.total` is the number of buckets in the range. A query that
would produce more than `EVENTS_MAX_BUCKETS` (10000) buckets is a `400`.

```bash
curl 'localhost:3000/events?account=acc_acme&window=1h&from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z'
```

```json
{ "window": "1h", "windowSeconds": 3600,
  "buckets": [{ "windowStart": "2026-09-01T00:00:00.000Z", "count": 0 }, { "windowStart": "2026-09-01T01:00:00.000Z", "count": 2 }, "…22 more"],
  "meta": { "total": 24, "limit": 100, "offset": 0 },
  "filters": { "account": "acc_acme", "from": "2026-09-01T00:00:00.000Z", "to": "2026-09-02T00:00:00.000Z" } }
```

### `GET /metrics`

Includes `http_requests_total` and `http_request_duration_seconds` (labels `method`, `route`, `status`) for every request, plus the rate-limit metrics below.

Prometheus exposition of the API's metrics: `ingest_rate_limited_total{account_id,event_name}` (rejections), `ingest_rate_limited_last_seen_timestamp_seconds{account_id,event_name}` (time of the latest rejection), plus Node process defaults. Scraped every 10s by the `prometheus` compose service.

Invalid input returns `400 { "error": "field: reason; …", "details": [{ "path": "field", "message": "reason" }] }`; an unknown account returns `404 { "error": "Account acc_x not found" }`. Every response carries an `X-Request-Id` header (your own is echoed back if you send one), and the same id appears on every JSON log line for that request.

## Queue

`POST /ingest` publishes each event as a JSON message to the `events` exchange (confirmed by the broker before the `202`); `src/consumer.ts` reads the `events` queue and inserts rows, acknowledging each message after its insert. The topology (`src/queue/topology.ts`) is asserted by both on connect, so a fresh broker needs no setup, and both reconnect on their own if the broker restarts.

Dead-letter queue: a message the consumer cannot decode is rejected and goes straight to `events.dlq`. A message whose insert fails (Postgres down, …) is requeued and redelivered; after 5 deliveries the broker moves it to `events.dlq` itself. Inspect dead-lettered messages in the management UI (`:15672` → Queues → `events.dlq`); once the cause is fixed, use its *Move messages* section (shovel plugin) to put them back on the `events` queue, or purge them. The **Event Queue** Grafana dashboard shows the depth of both queues, messages in flight, consumers attached and message rates (from RabbitMQ's Prometheus plugin).

## Alerting

Event driven, no database involved: the rate limiter records each 429 it sends as a metric, Prometheus scrapes it, and [Grafana alerting](https://grafana.com/docs/grafana/latest/alerting/) does the rest. Everything on the Grafana side is provisioned from `grafana/provisioning/alerting/` and also editable in the UI under Alerting:

- `rules.yml` — the alert rules. `RateLimitExceeded` evaluates `time() - ingest_rate_limited_last_seen_timestamp_seconds < 60` every 10s: an `account_id` + `event_name` pair is alerting while its latest rejection is under a minute old, and resolves after a minute without one. One alert instance per pair.
- `contact-points.yml` — where alerts go. Slack `#superday-rob` (bot token from `SLACK_BOT_TOKEN`, channel set by `recipient`) is the only one; add a `webhook`, `pagerduty`, `email`, … receiver to the same contact point to fan every alert out to another consumer.
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
to read the report. The default example uses the seeded accounts and mixes streams that stay under the ingest
rate limit with ones that trip it, plus one unknown account that is answered with `404`.

## Layout

```
src/
  config/        settings read from env (single source of truth)
  routes.ts      URL → validation middleware → controller wiring
  middleware/    request id, request logging, input validation (zod), account check (404), rate limiting
  controllers/   HTTP concerns: status codes, response shape
  services/      business logic on validated input: ingest publishes to the queue, listing queries the model; cached account lookups
  models/        Prisma data access (events, accounts tables), the seeded account list
  queue/         RabbitMQ topology (exchange, queue, dead-letter queue), message codec, the API's publisher
  consumer.ts    the consumer service: queue → Postgres
  lib/           prisma client, shared Redis client + cache, error types/handler, pino logger, Prometheus metrics registry
  generated/     Prisma client output (gitignored, created by `prisma generate`)
  seed.ts        upserts the seeded accounts (`npm run seed`; run by compose on start)
prisma/          schema + migrations
rabbitmq/        broker config mounted by compose (enabled plugins, per-queue Prometheus metrics)
prometheus/      scrape config (the API's /metrics, RabbitMQ)
grafana/         Grafana provisioning: datasources (Postgres, Prometheus); alert rules, contact points, notification policies
load/            k6 load generator: publish.js + JSON run configs (see load/README.md)
test/            vitest + supertest against the real app, model module mocked with vi.mock
```

Indexes on `events`: `(account_id, timestamp)`, `(account_id, event_name, timestamp)`, `(event_name, timestamp)`.

## Dashboards

Grafana (`:3001`) comes with three provisioned dashboards: **Event Queue** (queue and dead-letter queue depth, in-flight messages, consumers, message rates), **API HTTP** (requests/s, latency, error rate, rate-limit hits, from Prometheus) and **Events** (events over time, by name, top accounts, latest events, straight from Postgres). Source: `grafana/provisioning/dashboards/*.json`.

## Postman

Import `postman/nango-events.postman_collection.json`. It covers the health and metrics endpoints, valid ingests, each kind of invalid input, unknown accounts (`404`), the rate limit (run the "Rate limit" request 101 times with the Collection Runner), and the query endpoint. The `accountId` variable defaults to the seeded `acc_acme`; set `baseUrl` if the API is not on `http://localhost:3000`.

## Tests

```bash
npm test
```

No database, Redis or RabbitMQ required — the model layer (events, accounts) and the queue publisher are stubbed, and the account cache runs in memory. `test/consumer.test.ts` calls the consumer's message handler with a fake channel.
