# nango-events

A metering API: customers post events, the API queues them, a consumer stores them, and you can query counts back out.
Express 5, RabbitMQ, Postgres (Prisma), Redis, Prometheus and Grafana.

```
POST /ingest ──▶ API ──publish──▶ RabbitMQ ──▶ consumer ──insert──▶ Postgres ◀── GET /events
                 202
```

## Run

```bash
docker compose up --build
```

| Service    | Where                                   |
|------------|-----------------------------------------|
| API        | `localhost:3000`                        |
| Grafana    | `localhost:3001` (admin / admin)        |
| RabbitMQ   | `localhost:15672` (nango / nango)       |
| Prometheus | `localhost:9090`                        |

Migrations run and accounts are seeded on start. Use `--build` after changing code, otherwise Docker reuses the old image.
For Slack alerts, put a bot token in `.env` as `SLACK_BOT_TOKEN` (scope `chat:write`, bot invited to `#superday-rob`).

To run the API on the host instead:

```bash
cp .env.example .env
docker compose up -d db rabbitmq redis
npm install && npx prisma migrate deploy && npm run seed
npm run dev              # API
npm run dev:consumer     # consumer, second terminal
```

## Accounts

Events belong to accounts (customers). The API only accepts the ids listed in `src/models/seeded-accounts.ts`:
`acc_acme`, `acc_globex`, `acc_initech`, `acc_umbrella`, `acc_hooli`. Anything else is `404 Account acc_x not found`.
To add one, add the id to the list and run `npm run seed`.

## Endpoints

### `POST /ingest` → 202

```json
{ "account_id": "acc_acme", "event_name": "records_synced", "quantity": 250,
  "metadata": { "connection_id": "conn_42", "provider": "hubspot", "model": "Contact" },
  "timestamp": "2026-09-01T10:15:00Z" }
```

| Field        | Meaning                                                                                              |
|--------------|------------------------------------------------------------------------------------------------------|
| `event_name` | What was metered: `api_request`, `sync_run`, `records_synced`, `action_executed`, `webhook_received`, `connection_created` |
| `quantity`   | Units of usage the event represents (records synced, requests, …). Integer ≥ 1, default 1. Billing sums it |
| `metadata`   | Optional object with anything billing or debugging needs (connection id, provider, model, …). Up to 4 KB |
| `timestamp`  | Optional, defaults to now, may not be in the future                                                 |

The event is published to the queue and stored by the consumer a moment later; the response echoes what was queued.

### `POST /ingest/batch` → 202

```json
{ "events": [ { "account_id": "acc_acme", "event_name": "sync_run", "timestamp": "2026-09-01T10:00:00Z", "metadata": { "connection_id": "conn_42" } },
              { "account_id": "acc_acme", "event_name": "records_synced", "quantity": 1200, "timestamp": "2026-09-01T10:00:05Z" } ] }
```

1 to 100 events, each with a required `timestamp`. The batch is accepted or rejected as a whole: any problem returns
`400` with one `details` entry per problem (`events.<index>.<field>`), including unknown accounts.
Response: `{ "data": { "queued": n } }`.

### `GET /events` → 200

| Param     | Meaning                                                                     |
|-----------|-----------------------------------------------------------------------------|
| `account` | Filter by account id                                                        |
| `event`   | Filter by event name                                                        |
| `from`, `to` | Inclusive time range (ISO-8601 or epoch ms)                              |
| `window`  | Bucket size: `minute`, `hour`, `day`, or `15m`, `6h`, `1w`. Requires `from` and `to` |
| `limit`, `offset` | Paging (default 100 per page, max 1000)                             |

Without `window`: raw events, newest first.

```json
{ "data": [ … ], "meta": { "total": 2, "limit": 100, "offset": 0 }, "filters": { "account": "acc_acme" } }
```

With `window`: one row per bucket, oldest first, with `count` (events) and `quantity` (billable usage, the sum of the
events' `quantity`). Buckets align to the clock (an hour bucket starts on the hour) and every bucket in the range is
present, so 24 hours at `window=1h` is exactly 24 values, empty ones as `0`.
More than 10,000 buckets is a `400`.

```json
{ "window": "1h", "windowSeconds": 3600,
  "buckets": [ { "windowStart": "2026-09-01T00:00:00.000Z", "count": 0, "quantity": 0 }, { "windowStart": "2026-09-01T01:00:00.000Z", "count": 2, "quantity": 1450 }, … ],
  "meta": { "total": 24, "limit": 100, "offset": 0 }, "filters": { … } }
```

### Errors

`400 { "error", "details" }` for bad input, `404` for an unknown account, `429` when rate limited, `500` for anything else.
Every response carries an `X-Request-Id` header; the same id is on every log line for that request.

## Rate limits

| Endpoint             | Limit                                          | Setting                              |
|----------------------|------------------------------------------------|--------------------------------------|
| `POST /ingest`       | 100 per minute per account + event name        | `INGEST_RATE_LIMIT_PER_MINUTE`       |
| `POST /ingest/batch` | 10 batches per minute per account in the batch | `INGEST_BATCH_RATE_LIMIT_PER_MINUTE` |

Over the limit: `429 { "error": "Too many requests" }`. Keying single ingest on account + event means a noisy event
never blocks a customer's other events, and every customer stays well under the system's 100 events/s.
Counters live in Redis so the limit holds across API replicas. Unknown accounts are rejected before the limiter and use no quota.

To trigger it: send 101 events for one account and event within a minute, for example

```bash
for i in $(seq 1 101); do curl -s -o /dev/null -w "%{http_code} " -X POST localhost:3000/ingest \
  -H 'content-type: application/json' -d '{"account_id":"acc_umbrella","event_name":"webhook_received"}'; done
```

## Alerts

The API never talks to Slack. Each 429 is counted in a Prometheus metric on `GET /metrics`; Prometheus scrapes it every
10 s; a Grafana alert rule fires while an account (or account + event) has been rejected in the last minute and resolves
after a minute without a rejection; Grafana's Alertmanager sends one Slack message per firing and one on resolve.

Two rules, `RateLimitExceeded` (single ingest) and `BatchRateLimitExceeded` (batches), live in
`grafana/provisioning/alerting/rules.yml`; the Slack contact point and grouping are in the same folder.

> 🚨 RateLimitExceeded — Account acc_acme is over its connection_created ingest limit: its connection_created events are being rejected with 429.
>
> ✅ Resolved: RateLimitExceeded — Account acc_acme is back under its connection_created ingest limit: no rejections for a minute.

## Queue

`POST /ingest` publishes to the `events` queue and only answers 202 once the broker has stored the message. The consumer
(`src/consumer.ts`) inserts each event into Postgres and acknowledges it. A message that cannot be decoded goes straight
to the `events.dlq` dead-letter queue; one whose insert fails is retried up to 5 times, then dead-lettered. Both sides
reconnect on their own if the broker restarts. Run more consumers with `docker compose up -d --scale consumer=3`.

## Dashboards

Grafana comes with three: **Events** (counts over time from Postgres), **API HTTP** (requests, latency, errors, rate-limit
hits) and **Event Queue** (queue depth, consumers, message rates). Source: `grafana/provisioning/dashboards/`.

## Load testing

```bash
npm run load               # load/example.json: mixed streams, some over the limit
npm run load:throughput    # load/throughput.json: 100 events/s for 60 s (lift the limit first, see load/README.md)
```

Prints successful / rate limited / failed counts and p50/p95/p99 latency. Config format in [load/README.md](load/README.md).

## Postman

`postman/nango-events.postman_collection.json`: successful ingests and batches, the invalid cases, queries (raw and windowed)
and the two rate-limit requests to run repeatedly. Set `baseUrl` if the API is not on `localhost:3000`.

## Tests

```bash
npm test
```

No database, Redis or RabbitMQ needed: the models and the queue publisher are mocked.

## Layout

```
src/
  config/        settings from env (the only place that reads process.env)
  routes.ts      every route: validate → check account → rate limit → controller
  middleware/    request id, request log + HTTP metrics, validation (zod), account check, rate limits
  controllers/   status codes and response shape
  services/      business logic: publish to the queue, list or bucket events
  models/        Prisma access to events and accounts, the seeded account ids, the metered event names
  queue/         RabbitMQ topology, message format, publisher
  consumer.ts    queue → Postgres
  lib/           Prisma client, Redis client, rate-limit store, HttpError, logger, metrics
prisma/          schema + migrations
grafana/ prometheus/ rabbitmq/   provisioning and config for the observability stack
load/  postman/  test/            k6 scripts, Postman collection, vitest suite
```
