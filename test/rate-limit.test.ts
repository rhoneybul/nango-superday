import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import './helpers';

vi.mock('../src/models/event.model');
vi.mock('../src/models/account.model');
vi.mock('../src/queue/publisher');

// No REDIS_URL in the test env, so the limiter uses its in-memory store.
// This file gets a fresh module registry, and therefore a fresh store.

describe('POST /ingest rate limit', () => {
  it('allows 100 per minute per account_id:event_name, then returns 429', async () => {
    for (let i = 0; i < 100; i++) {
      const res = await request(app).post('/ingest').send({ account_id: 'acc_rl', event_name: 'connection_created' });
      expect(res.status).toBe(202);
    }

    const blocked = await request(app).post('/ingest').send({ account_id: 'acc_rl', event_name: 'connection_created' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many requests' });
    expect(blocked.headers['ratelimit-limit']).toBe('100');
  });

  it('does not block other events for the same account', async () => {
    const res = await request(app).post('/ingest').send({ account_id: 'acc_rl', event_name: 'sync_run' });
    expect(res.status).toBe(202);
  });

  it('records the rejection in the rate-limit metrics on GET /metrics', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/plain');
    expect(res.text).toMatch(/^ingest_rate_limited_total\{account_id="acc_rl",event_name="connection_created"\} 1$/m);
    expect(res.text).toMatch(/^ingest_rate_limited_last_seen_timestamp_seconds\{account_id="acc_rl",event_name="connection_created"\} \d+/m);
    expect(res.text).not.toMatch(/event_name="sync_run"/);
  });

  it('records HTTP request metrics per method, route and status', async () => {
    const res = await request(app).get('/metrics');
    expect(res.text).toMatch(/^http_requests_total\{method="POST",route="\/ingest",status="202"\} 101$/m);
    expect(res.text).toMatch(/^http_requests_total\{method="POST",route="\/ingest",status="429"\} 1$/m);
    expect(res.text).toMatch(/^http_request_duration_seconds_count\{method="POST",route="\/ingest",status="202"\} 101$/m);
  });
});
