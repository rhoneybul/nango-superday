/**
 * k6 load script: publishes events to `POST /ingest` at a fixed rate per stream.
 *
 * Input is a JSON file (see ./example.json and ./README.md):
 *
 *   {
 *     "target": "http://localhost:3000",
 *     "duration": "30s",
 *     "events": [
 *       { "account_id": "acc_acme", "event_name": "api_request", "rps": 20 },
 *       { "account_id": "acc_globex", "event_name": "sync_run", "rps": 5 }
 *     ],
 *     "expectedStatuses": [202],
 *     "thresholds": { "p95Ms": 250, "maxErrorRate": 0.01 }
 *   }
 *
 * `account_id` must be a seeded account (src/models/seeded-accounts.ts); the API
 * answers 404 for any other id, which is a handy way to exercise that path.
 *
 * Each entry in `events` becomes an independent k6 scenario using the
 * `constant-arrival-rate` executor, so every stream holds its own requests
 * per second for the whole `duration` regardless of how fast the API answers.
 *
 * Run:   k6 run -e CONFIG=./example.json publish.js
 * Env:   CONFIG  path to the JSON file (default ./example.json, relative to this script)
 *        TARGET  overrides `target` from the file (used by docker compose: http://api:3000)
 *
 * Everything below `options` is plain k6. `handleSummary` at the bottom replaces
 * k6's default report with a short one: accepted / rate limited / unknown account / failed
 * counts, one latency line, and the threshold results.
 */
import http from 'k6/http';
import exec from 'k6/execution';
import { check, fail, sleep } from 'k6';
import { Counter } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Config: read + validate the JSON file (init context only)
// ---------------------------------------------------------------------------

const CONFIG_PATH = __ENV.CONFIG || './example.json';
const config = parseConfig(open(CONFIG_PATH));
const TARGET = (__ENV.TARGET || config.target).replace(/\/+$/, '');

function parseConfig(raw) {
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${CONFIG_PATH}: not valid JSON (${e.message})`);
  }
  // Only the fields whose absence would otherwise fail in a confusing way are checked; k6 reports the rest.
  const problems = [];
  if (typeof cfg.target !== 'string' || !/^https?:\/\//.test(cfg.target)) problems.push('target: must be an http(s) URL, e.g. "http://localhost:3000"');
  if (typeof cfg.duration !== 'string' || !/^\d+(ms|s|m|h)$/.test(cfg.duration)) problems.push('duration: must be <number><ms|s|m|h>, e.g. "30s", "5m"');
  if (!Array.isArray(cfg.events) || cfg.events.length === 0) problems.push('events: must be a non-empty array');
  else {
    cfg.events.forEach((entry, i) => {
      if (!entry || typeof entry.account_id !== 'string' || typeof entry.event_name !== 'string') problems.push(`events[${i}]: needs account_id and event_name`);
      if (!entry || typeof entry.rps !== 'number' || !(entry.rps > 0)) problems.push(`events[${i}].rps: must be a number greater than 0`);
    });
  }
  if (problems.length) throw new Error(`${CONFIG_PATH}:\n  - ${problems.join('\n  - ')}`);
  return Object.assign({ thresholds: {}, expectedStatuses: [201] }, cfg);
}

// ---------------------------------------------------------------------------
// Scenarios: one constant-arrival-rate scenario per entry in `events`
// ---------------------------------------------------------------------------

/** k6 scenario names may only contain [A-Za-z0-9_-]. */
const slug = (s) => s.replace(/[^A-Za-z0-9_-]/g, '_');

/** scenario name → config entry, looked up per iteration via exec.scenario.name */
const ENTRIES = {};
const scenarios = {};

config.events.forEach((entry, i) => {
  const name = `${slug(entry.account_id)}__${slug(entry.event_name)}__${i}`;
  ENTRIES[name] = entry;

  // k6 needs an integer rate; fractional rps (e.g. 0.5) is expressed per 1000s.
  const integerRate = Number.isInteger(entry.rps);
  scenarios[name] = {
    executor: 'constant-arrival-rate',
    exec: 'publish',
    rate: integerRate ? entry.rps : Math.round(entry.rps * 1000),
    timeUnit: integerRate ? '1s' : '1000s',
    duration: config.duration,
    // Enough VUs for ~500ms responses; k6 grows towards maxVUs (with a warning) if the API is slower.
    preAllocatedVUs: Math.max(5, Math.ceil(entry.rps / 2)),
    maxVUs: entry.maxVUs || Math.max(20, Math.ceil(entry.rps * 2)),
    gracefulStop: '5s',
    tags: { account: entry.account_id, event: entry.event_name },
  };
});

// ---------------------------------------------------------------------------
// Thresholds: pass/fail gates from the config
// ---------------------------------------------------------------------------

const thresholds = {};
if (config.thresholds.p95Ms !== undefined) thresholds.http_req_duration = [`p(95)<${config.thresholds.p95Ms}`];
if (config.thresholds.maxErrorRate !== undefined) thresholds.http_req_failed = [`rate<=${config.thresholds.maxErrorRate}`];
// Achieved throughput: 201 responses per second over the whole run, i.e. events actually stored.
if (config.thresholds.minSuccessfulRps !== undefined) thresholds.successful = [`rate>=${config.thresholds.minSuccessfulRps}`];

// Which statuses count as success for http_req_failed / the maxErrorRate threshold.
http.setResponseCallback(http.expectedStatuses(...config.expectedStatuses));

const EXPECTED_CHECK = `status in [${config.expectedStatuses.join(', ')}]`;

export const options = {
  scenarios,
  thresholds,
  discardResponseBodies: true,
  summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'avg', 'max'],
  summaryTimeUnit: 'ms',
};

// ---------------------------------------------------------------------------
// Metrics: every response is exactly one of accepted / rate limited / unknown account / failed
// (failed = any other status, including 0 for a connection error or timeout)
// ---------------------------------------------------------------------------

const outcomes = {
  accepted: new Counter('accepted'),
  rate_limited: new Counter('rate_limited'),
  unknown_account: new Counter('unknown_account'),
  failed: new Counter('failed'),
};

function outcome(status) {
  if (status === 202) return 'accepted';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'unknown_account';
  return 'failed';
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Wait for the API before the clock starts (compose may still be booting it). */
export function setup() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    // 200 is the expected status here, whatever expectedStatuses says about /ingest.
    const res = http.get(`${TARGET}/health`, { tags: { name: 'health' }, responseCallback: http.expectedStatuses(200) });
    if (res.status === 200) {
      console.log(`Target ${TARGET} healthy; ${Object.keys(scenarios).length} stream(s) for ${config.duration}`);
      return;
    }
    sleep(1);
  }
  fail(`${TARGET}/health did not return 200 within 30s`);
}

export function publish() {
  const entry = ENTRIES[exec.scenario.name];
  const body = JSON.stringify({ account_id: entry.account_id, event_name: entry.event_name });
  const res = http.post(`${TARGET}/ingest`, body, {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'ingest' },
  });
  outcomes[outcome(res.status)].add(1);
  check(res, { [EXPECTED_CHECK]: (r) => config.expectedStatuses.includes(r.status) });
}

// ---------------------------------------------------------------------------
// Summary: printed to stdout at the end of the run (--summary-export still
// writes the full k6 data to results/summary.json)
// ---------------------------------------------------------------------------

export function handleSummary(data) {
  const m = (name) => (data.metrics[name] && data.metrics[name].values) || {};
  const total = m('http_reqs').count || 0;
  const pct = (n) => (total ? ((100 * n) / total).toFixed(1) : '0.0') + '%';
  const line = (label, name) => {
    const v = m(name);
    const n = v.count || 0;
    return `  ${label.padEnd(20)} ${String(n).padStart(7)}   ${pct(n).padStart(6)}   ${(v.rate || 0).toFixed(2)}/s`;
  };
  const d = m('http_req_duration');
  const ms = (k) => (d[k] === undefined ? '-' : d[k].toFixed(2) + 'ms');
  const thresholds = Object.entries(data.metrics)
    .flatMap(([name, metric]) => Object.entries(metric.thresholds || {}).map(([expr, t]) => `  ${t.ok ? '\u2713' : '\u2717'} ${name} ${expr}`));

  const out = [
    '',
    `Load summary: ${total} requests to ${TARGET}/ingest over ${config.duration} (${(m('http_reqs').rate || 0).toFixed(2)}/s)`,
    '',
    line('accepted (202)', 'accepted'),
    line('rate limited (429)', 'rate_limited'),
    line('unknown account (404)', 'unknown_account'),
    line('failed (other)', 'failed'),
    '',
    `  latency  p50=${ms('p(50)')}  p95=${ms('p(95)')}  p99=${ms('p(99)')}  avg=${ms('avg')}  max=${ms('max')}`,
    `  dropped iterations (rps not reached): ${m('dropped_iterations').count || 0}`,
    '',
    ...(thresholds.length ? ['Thresholds:', ...thresholds, ''] : []),
  ];
  return { stdout: out.join('\n') + '\n' };
}
