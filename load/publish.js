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
 * Everything below `options` is plain k6; the end-of-test summary is k6's own.
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
  return Object.assign({ thresholds: {} }, cfg);
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
    // Enough VUs for ~200ms responses; k6 grows towards maxVUs (with a warning) if the API is slower.
    preAllocatedVUs: Math.max(2, Math.ceil(entry.rps / 5)),
    maxVUs: entry.maxVUs || Math.max(20, Math.ceil(entry.rps * 2)),
    gracefulStop: '5s',
    tags: { account: entry.account_id, event: entry.event_name },
  };
});

// ---------------------------------------------------------------------------
// Thresholds: real pass/fail gates from the config, plus always-true ones that
// make k6 print per-status-code and per-stream breakdowns in the summary.
// ---------------------------------------------------------------------------

const thresholds = {};
if (config.thresholds.p95Ms !== undefined) thresholds.http_req_duration = [`p(95)<${config.thresholds.p95Ms}`];
if (config.thresholds.maxErrorRate !== undefined) thresholds.http_req_failed = [`rate<=${config.thresholds.maxErrorRate}`];

// Status codes the API is known to return; anything else lands in the responses_* counters below.
for (const status of [201, 400, 500]) thresholds[`http_reqs{status:${status}}`] = ['count>=0'];
for (const name of Object.keys(scenarios)) {
  thresholds[`http_reqs{scenario:${name}}`] = ['count>=0'];
  thresholds[`http_req_duration{scenario:${name}}`] = ['p(95)>=0'];
}

export const options = {
  scenarios,
  thresholds,
  discardResponseBodies: true,
  summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'avg', 'max'],
  summaryTimeUnit: 'ms',
};

// ---------------------------------------------------------------------------
// Metrics: response class counters (status 0 = connection error / timeout)
// ---------------------------------------------------------------------------

const responses = {
  '2xx': new Counter('responses_2xx'),
  '4xx': new Counter('responses_4xx'),
  '5xx': new Counter('responses_5xx'),
  other: new Counter('responses_other'),
};

function classify(status) {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'other';
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Wait for the API before the clock starts (compose may still be booting it). */
export function setup() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    const res = http.get(`${TARGET}/health`, { tags: { name: 'health' } });
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
  responses[classify(res.status)].add(1);
  check(res, { 'ingest returned 201': (r) => r.status === 201 });
}
