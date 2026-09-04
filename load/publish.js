/**
 * k6 load script: publishes events to `POST /ingest` at a fixed rate per stream.
 *
 * Input is a JSON file (see ./example.json and ./README.md):
 *
 *   {
 *     "target": "http://localhost:3000",
 *     "duration": "30s",
 *     "events": [
 *       { "account_id": "acc_1", "event_name": "signup", "rps": 20 },
 *       { "account_id": "acc_2", "event_name": "purchase", "rps": 5 }
 *     ],
 *     "expectedStatuses": [201],
 *     "thresholds": { "p95Ms": 250, "maxErrorRate": 0.01 }
 *   }
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
 * k6's default report with a short one: successful / rate limited / failed
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
  const problems = [];
  const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

  if (!isObject(cfg)) problems.push('top level must be an object');
  else {
    if (typeof cfg.target !== 'string' || !/^https?:\/\//.test(cfg.target)) {
      problems.push('target: must be an http(s) URL, e.g. "http://localhost:3000"');
    }
    if (typeof cfg.duration !== 'string' || !/^\d+(ms|s|m|h)$/.test(cfg.duration)) {
      problems.push('duration: must be <number><ms|s|m|h>, e.g. "30s", "5m"');
    }
    if (!Array.isArray(cfg.events) || cfg.events.length === 0) {
      problems.push('events: must be a non-empty array');
    } else {
      cfg.events.forEach((entry, i) => {
        const at = `events[${i}]`;
        if (!isObject(entry)) return problems.push(`${at}: must be an object`);
        if (typeof entry.account_id !== 'string' || entry.account_id.trim() === '') {
          problems.push(`${at}.account_id: must be a non-empty string`);
        }
        if (typeof entry.event_name !== 'string' || entry.event_name.trim() === '') {
          problems.push(`${at}.event_name: must be a non-empty string`);
        }
        if (typeof entry.rps !== 'number' || !(entry.rps > 0)) {
          problems.push(`${at}.rps: must be a number greater than 0`);
        }
        if (entry.maxVUs !== undefined && !(Number.isInteger(entry.maxVUs) && entry.maxVUs > 0)) {
          problems.push(`${at}.maxVUs: must be a positive integer`);
        }
      });
    }
    if (cfg.expectedStatuses !== undefined) {
      const ok = Array.isArray(cfg.expectedStatuses) && cfg.expectedStatuses.length > 0
        && cfg.expectedStatuses.every((n) => Number.isInteger(n) && n >= 100 && n <= 599);
      if (!ok) problems.push('expectedStatuses: must be a non-empty array of HTTP status codes, e.g. [201, 429]');
    }
    if (cfg.thresholds !== undefined) {
      if (!isObject(cfg.thresholds)) problems.push('thresholds: must be an object');
      else {
        const t = cfg.thresholds;
        if (t.p95Ms !== undefined && !(typeof t.p95Ms === 'number' && t.p95Ms > 0)) {
          problems.push('thresholds.p95Ms: must be a number of milliseconds greater than 0');
        }
        if (t.maxErrorRate !== undefined && !(typeof t.maxErrorRate === 'number' && t.maxErrorRate >= 0 && t.maxErrorRate <= 1)) {
          problems.push('thresholds.maxErrorRate: must be a fraction between 0 and 1');
        }
      }
    }
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
// Metrics: every response is exactly one of successful / rate limited / failed
// (failed = any other status, including 0 for a connection error or timeout)
// ---------------------------------------------------------------------------

const outcomes = {
  successful: new Counter('successful'),
  rate_limited: new Counter('rate_limited'),
  failed: new Counter('failed'),
};

function outcome(status) {
  if (status === 201) return 'successful';
  if (status === 429) return 'rate_limited';
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
    line('successful (201)', 'successful'),
    line('rate limited (429)', 'rate_limited'),
    line('failed (other)', 'failed'),
    '',
    `  latency  p50=${ms('p(50)')}  p95=${ms('p(95)')}  p99=${ms('p(99)')}  avg=${ms('avg')}  max=${ms('max')}`,
    `  dropped iterations (rps not reached): ${m('dropped_iterations').count || 0}`,
    '',
    ...(thresholds.length ? ['Thresholds:', ...thresholds, ''] : []),
  ];
  return { stdout: out.join('\n') + '\n' };
}
