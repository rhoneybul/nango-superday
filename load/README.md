# Load generator (`load/`)

Publishes events to `POST /ingest` at a fixed requests-per-second rate per stream and reports
throughput, status codes and p50/p95/p99 latency. It is a plain [k6](https://grafana.com/docs/k6/latest/)
script, so there is no CLI code to maintain: the only files are [`publish.js`](publish.js) (the k6 script)
and a JSON config describing the run.

## Quick start

```bash
npm run load
```

That runs [`example.json`](example.json) through the `k6` service in `docker-compose.yml`. Docker starts
Postgres, Redis and the API first, waits for the API to be healthy, runs the load, prints k6's summary and
writes `load/results/summary.json`.

To run a different config, put the file in `load/` and name it:

```bash
LOAD_CONFIG=my-run.json npm run load
```

If you have k6 installed locally (`brew install k6`) and the API is already running on `localhost:3000`:

```bash
npm run load:local
```

(`LOAD_CONFIG` works there too; `TARGET=http://host:port` overrides the `target` in the file.)

## Config file

```json
{
  "target": "http://localhost:3000",
  "duration": "60s",
  "events": [
    { "account_id": "acc_acme", "event_name": "signup", "rps": 1 },
    { "account_id": "acc_globex", "event_name": "purchase", "rps": 5, "maxVUs": 50 }
  ],
  "expectedStatuses": [202, 429],
  "thresholds": { "p95Ms": 250, "maxErrorRate": 0.01 }
}
```

| Field                      | Required | Meaning                                                                                                   |
|----------------------------|----------|-----------------------------------------------------------------------------------------------------------|
| `target`                   | yes      | Base URL of the API. Overridden by the `TARGET` env var (compose sets it to `http://api:3000`).            |
| `duration`                 | yes      | How long every stream runs: `<number><ms\|s\|m\|h>`, e.g. `30s`, `5m`.                                     |
| `events[]`                 | yes      | One entry per stream. All streams run in parallel for the full `duration`.                                |
| `events[].account_id`      | yes      | Sent as `account_id`. Must be a seeded account (`src/models/seeded-accounts.ts`), otherwise every request is a `404`. |
| `events[].event_name`      | yes      | Sent as `event_name`. Unknown names are a handy way to generate `400`s.                                   |
| `events[].rps`             | yes      | Requests per second for this stream. Fractions are fine (`0.5` = one request every 2s).                   |
| `events[].maxVUs`          | no       | Cap on concurrent requests for the stream (default `max(20, 2 × rps)`). Raise it if k6 warns about VUs.   |
| `expectedStatuses`         | no       | Statuses that count as success for the error rate (default `[202]`). Add `429` when limiting is expected, `404` when a stream uses an unknown account on purpose. |
| `thresholds.p95Ms`         | no       | Fail the run (non-zero exit) if p95 latency across all requests is at or above this many ms.              |
| `thresholds.maxErrorRate`  | no       | Fail the run if the fraction of unexpected statuses/network errors exceeds this (`0.01` = 1%).            |
| `thresholds.minSuccessfulRps` | no    | Fail the run if fewer than this many `201` responses per second were achieved over the whole run.         |

Bad configs fail fast with a list of problems before any request is sent.

## Reading the summary

The script prints its own short report instead of k6's default one:

```
Load summary: 1054 requests to http://api:3000/ingest over 60s (17.53/s)

  accepted (202)           352    33.4%   5.86/s
  rate limited (429)       700    66.4%  11.65/s
  unknown account (404)     30     2.8%   0.50/s
  failed (other)             2     0.2%   0.03/s

  latency  p50=5.28ms  p95=11.76ms  p99=308.38ms  avg=14.19ms  max=433.53ms
  dropped iterations (rps not reached): 0

Thresholds:
  ✓ http_req_duration p(95)<250
  ✓ http_req_failed rate<=0.01
```

| Line                  | What it tells you                                                                                                   |
|-----------------------|---------------------------------------------------------------------------------------------------------------------|
| `accepted (202)`      | Events accepted onto the queue (inserted into Postgres by the consumer shortly after).                              |
| `rate limited (429)`  | Rejected by the per `account_id` + `event_name` limit.                                                              |
| `unknown account (404)` | `account_id` is not a seeded account (see `src/models/seeded-accounts.ts`).                                       |
| `failed (other)`      | Everything else: `400` (bad input), `5xx`, or a connection error / timeout.                                         |
| `latency`             | p50 / p95 / p99 / average / max over every request, in ms.                                                          |
| `dropped iterations`  | Requests k6 could not start on time. Non-zero means the target rps was not reached: raise `maxVUs` or lower `rps`.  |
| `Thresholds`          | One line per gate from the config. Any ✗ makes k6 exit non-zero, which is what you want in CI.                     |

The full k6 data (every built-in metric, per-scenario tags) is still written to `load/results/summary.json`
(git-ignored) if you need more detail.

## Accounts and rate limiting in the example

Every `account_id` must be one of the seeded accounts (`acc_acme`, `acc_globex`, `acc_initech`,
`acc_umbrella`, `acc_hooli`; see `src/models/seeded-accounts.ts`). The API looks each one up in its
Redis cache and answers `404` for anything else, so the cache is exercised on every request.

`POST /ingest` allows `INGEST_RATE_LIMIT_PER_MINUTE` (100 by default) requests per minute for each
`account_id` + `event_name` pair, so a stream at or below roughly 1.6 rps is always stored, and a faster
stream gets `429` for the rest of each minute once it has used its 100. In `example.json`:

| Stream                      | rps | Requests in 60s | Stored | Rate limited | Unknown account |
|-----------------------------|-----|-----------------|--------|--------------|-----------------|
| `acc_acme` / `signup`       | 1   | 60              | 60     | 0            | 0               |
| `acc_acme` / `login`        | 1.5 | 90              | 90     | 0            | 0               |
| `acc_globex` / `purchase`   | 5   | 300             | ~100   | ~200         | 0               |
| `acc_initech` / `login`     | 10  | 600             | ~100   | ~500         | 0               |
| `acc_unknown` / `signup`    | 0.5 | 30              | 0      | 0            | 30 (`404`)      |

`expectedStatuses` includes `429` and `404` there so the error-rate threshold only trips on real failures.
The `accepted` / `rate limited` / `unknown account` lines in the summary show the split.

## Advanced

Everything is standard k6, so any k6 flag works. To pass your own flags, call the service directly:

```bash
docker compose --profile load run --rm k6 run -e CONFIG=/load/example.json --out json=/load/results/raw.json /load/publish.js
```

If another stack already uses the default host ports, override them: `DB_PORT`, `REDIS_PORT`, `API_PORT`,
`GRAFANA_PORT` (e.g. `DB_PORT=15432 API_PORT=13000 npm run load`).
