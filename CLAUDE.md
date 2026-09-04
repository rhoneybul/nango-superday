# nango-events

Event ingestion API. Express 5 + TypeScript + Prisma 7 (engine-free, `@prisma/adapter-pg`) + Postgres 16 + Redis 7 (rate-limit counters) + Prometheus/Grafana (metrics, alerting). No auth.

## Commands

- `npm run dev` — tsx watch on `src/server.ts` (needs Postgres; `docker compose up -d db`)
- `npm test` — vitest, no DB required (model layer is stubbed)
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — `prisma generate && tsc` → `dist/`
- `npx prisma migrate dev --name <name>` — new migration; `npx prisma migrate deploy` — apply
- `docker compose up --build` — Postgres :5432, Redis :6379, Prometheus :9090 (scrapes the API's /metrics), Grafana :3001 (admin/admin; Postgres + Prometheus datasources, alert rules, contact points and notification policies pre-provisioned from `grafana/provisioning`), API :3000; migrations applied on start. Set `SLACK_WEBHOOK_URL` in `.env` for Slack alerts.

`npm install` runs `prisma generate` (postinstall). Generated client lives in `src/generated/prisma` (gitignored) — never edit it, never import from `@prisma/client` directly; import `../generated/prisma/client`.

## Layout

```
src/config/      plain object read from env (no schema library). ONLY place that reads process.env. Import `config` from here.
src/routes.ts    URL → [validation middleware →] controller wiring only
src/middleware/  request-id (AsyncLocalStorage, `currentRequestId()`), request-logger, rate-limit (express-rate-limit + Redis store; its `handler` records each 429 in the rate-limit metrics), validation (zod schemas for every input; typed result on `res.locals`)
src/controllers/ HTTP concerns only: read `res.locals`, call the service, set status + response shape. No try/catch, no validation.
src/services/    business logic on already-validated input, including building the Prisma `where` (`EventWhere`).
src/models/      Prisma data access for `events`: plain exported functions that receive a ready `where`. Raw SQL only for `countEventsByWindow`. `event-name.ts` holds the `EventName` enum.
src/lib/         prisma client (pg adapter), ValidationError + errorHandler, pino `log`, metrics (prom-client `registry`, the rate-limit counter/gauge, GET /metrics handler)
src/app.ts       exports the configured Express `app`
src/server.ts    listen + graceful shutdown
prisma/          schema.prisma + migrations (initial migration is hand-written; keep it in sync with schema)
prometheus/      prometheus.yml (scrapes api:3000/metrics every 10s)
grafana/         provisioning/datasources (Postgres; Prometheus uid `prometheus`), provisioning/alerting (rules.yml, contact-points.yml, notification-policies.yml)
test/            vitest + supertest against the real `app`. Each test file `vi.mock`s the model module; helpers.ts resets the stubs to defaults.
```

No dependency injection: modules import each other directly (`routes` → `middleware/validation` → `controllers` → `services` → `models`). Tests swap the model with `vi.mock('../src/models/event.model')`.

Request flow: `requestId` → `requestLogger` → `express.json` → route (`ingestRateLimit` on POST /ingest, then `validateX` middleware throws `ValidationError` → 400, then controller) → `errorHandler`. Express 5 forwards thrown errors and rejected promises to `errorHandler`, so nothing else catches errors.

## Data model

`events`: `id BIGSERIAL`, `account_id TEXT`, `event_name TEXT`, `timestamp TIMESTAMPTZ DEFAULT now()`, `created_at TIMESTAMPTZ`.
`event_name` is validated against the `EventName` enum in `src/models/event-name.ts` (`signup`, `login`, `logout`, `purchase`) on ingest and on the `event` filter; the column itself stays text, so adding a value is a code change only, no migration.
Indexes: `(account_id, timestamp)`, `(account_id, event_name, timestamp)`, `(event_name, timestamp)`.
BigInt ids are serialised to strings in API responses (`toRecord` in the model).

## API

- `POST /ingest` body `{ account_id, event_name, timestamp? }` → 201 `{ data: event }`. Missing timestamp → DB `now()`. Rate limited per `account_id:event_name` to `INGEST_RATE_LIMIT_PER_MINUTE` (100) → `429 { error: "Too many requests" }` with `RateLimit-*` headers ; each rejection is recorded in the rate-limit metrics (see Alerting). Counters in Redis when `REDIS_URL` is set, otherwise in-process memory. Unknown `event_name` → 400 listing the allowed values.
- `GET /events?account&event&from&to&window&limit&offset`
  - `from`/`to`: ISO-8601 or epoch ms, inclusive. `from > to` → 400.
  - No `window`: raw events newest-first, `{ data, meta: { total, limit, offset }, filters }`. `limit` defaults to `EVENTS_DEFAULT_LIMIT`, capped at `EVENTS_MAX_LIMIT`.
  - With `window` (`<n><s|m|h|d|w>`, e.g. `15m`, `1h`, `1d`): aggregated mode, `{ window, windowSeconds, buckets: [{ windowStart, count }], filters }`. Buckets are epoch-aligned via Postgres `date_bin`; empty buckets omitted.
  - Repeated query params (`?account=a&account=b`) → 400. Empty string params are treated as absent.
- Errors: `400 { error, details: [{ path, message }] }` for validation (`error` is the joined `path: message` list, e.g. `limit: must be between 1 and 1000`), `400 { error: "Malformed JSON body" }`, `500 { error: "Internal server error" }` otherwise (no leak; the error is logged).
- `GET /health` → `{ status: "ok" }`.
- `GET /metrics` → Prometheus text format from `registry` in `src/lib/metrics.ts`: `ingest_rate_limited_total{account_id,event_name}`, `ingest_rate_limited_last_seen_timestamp_seconds{account_id,event_name}`, Node default metrics.
- Every response carries `X-Request-Id` (echoes the incoming header, else a UUID). The id is in every log line for that request.

## Alerting

Event driven and database-free: the limiter's `handler` records every 429 in the metrics (`src/lib/metrics.ts`), Prometheus scrapes `/metrics`, Grafana alert rules query Prometheus, and Grafana's Alertmanager owns state (firing → resolved), dedupe and delivery. The Grafana side is file-provisioned in `grafana/provisioning/alerting/` and also editable in the UI:

- `rules.yml`: one rule per thing to alert on = Prometheus instant query (each series is an alert instance, its labels become alert labels) + threshold expression + `summary` (firing text) and `resolved` (resolved text) annotations, each one plain actionable line. `RateLimitExceeded`: `time() - max by (account_id, event_name) (ingest_rate_limited_last_seen_timestamp_seconds) < 60`, every 10s, `for: 0s`, `noDataState: OK`. The rule uses the last-seen gauge, not `increase(ingest_rate_limited_total[1m])`, because Prometheus cannot see the first jump of a brand-new counter series: a single burst of 429s between two scrapes would never fire. Grafana does not expand env vars inside rule queries or annotations.
- `contact-points.yml`: `slack` contact point → `#superday-rob` via `$SLACK_WEBHOOK_URL` (compose passes it from `.env`, placeholder if unset). Templates print `.CommonAnnotations.summary` when firing and `.CommonAnnotations.resolved` when resolved. Fan-out = more receivers on the same contact point (webhook, pagerduty, email, …).
- `notification-policies.yml`: default receiver `slack`, `group_by` alertname + account_id + event_name, `group_wait 0s`, `group_interval 30s`, `repeat_interval 1h`. Selective delivery = a `routes` entry with matchers.

Grafana's built-in Alertmanager does not accept externally pushed alerts (`POST /api/alertmanager/grafana/api/v2/alerts` only proxies to external Alertmanager datasources), which is why the app publishes metrics rather than alerts. `account_id` is a metric label, so cardinality grows with the number of rate-limited accounts; fine at this scale, revisit if it becomes thousands.

## Conventions

- Validation is zod (`src/middleware/validation.ts`). Field messages are zod's defaults, prefixed with the field path; only refinements (window format, from/to order, limit range) carry custom wording. Tests assert messages by regex, so changing a schema means updating `test/`.
- Test env (`vitest.config.ts`) sets `EVENTS_DEFAULT_LIMIT=50`, `EVENTS_MAX_LIMIT=500`; tests depend on those values.
- To add a setting, add one line to the `config` object in `src/config/index.ts` (use the `integer()` helper for numbers), and add it to `.env.example` and `docker-compose.yml`.
- Logging is pino: `import { log } from '../lib/logger'`; `log.info({ fields }, 'message')` (object first, pino style). `requestId` is added to every line via a mixin. Errors go under the `err` key. `LOG_LEVEL` is `debug|info|warn|error|silent` (tests use `silent`). Never `console.log`.
- To validate a new endpoint's input, add a zod schema + `validateX` middleware in `src/middleware/validation.ts` that sets `res.locals.x`, and type the controller as `Validated<{ x: XInput }>`.
- Prisma engines can't be downloaded in some sandboxes; `PRISMA_SCHEMA_ENGINE_BINARY=/usr/bin/true npx prisma generate` still works for `generate` (WASM-based). `migrate` does need the real engine.

## Status

Phase 1 complete: scaffold, compose, schema/indexes, both endpoints, config package. Verified end-to-end against a real Postgres 16.
Phase 2 complete: per-`account_id:event_name` rate limiting on POST /ingest (Redis-backed), Redis + Grafana in compose. 62 tests.
Phase 3 complete: rate-limit metrics + GET /metrics, Prometheus in compose, Grafana-provisioned alerting (RateLimitExceeded rule on Prometheus, Slack contact point, notification policy). 63 tests. Firing → resolved verified against a real Prometheus 3 + Grafana 13 with a webhook stand-in for Slack.
