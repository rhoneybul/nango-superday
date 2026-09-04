import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import './helpers';

vi.mock('../src/models/event.model');

// No REDIS_URL in the test env, so the limiter uses its in-memory store.
// This file gets a fresh module registry, and therefore a fresh store.

describe('POST /ingest rate limit', () => {
  it('allows 100 per minute per account_id:event_name, then returns 429', async () => {
    for (let i = 0; i < 100; i++) {
      const res = await request(app).post('/ingest').send({ account_id: 'acc_rl', event_name: 'signup' });
      expect(res.status).toBe(201);
    }

    const blocked = await request(app).post('/ingest').send({ account_id: 'acc_rl', event_name: 'signup' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many requests' });
    expect(blocked.headers['ratelimit-limit']).toBe('100');
  });

  it('does not block other events for the same account', async () => {
    const res = await request(app).post('/ingest').send({ account_id: 'acc_rl', event_name: 'purchase' });
    expect(res.status).toBe(201);
  });

  it('records the rejection in the rate-limit metrics on GET /metrics', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/plain');
    expect(res.text).toMatch(/^ingest_rate_limited_total\{account_id="acc_rl",event_name="signup"\} 1$/m);
    expect(res.text).toMatch(/^ingest_rate_limited_last_seen_timestamp_seconds\{account_id="acc_rl",event_name="signup"\} \d+/m);
    expect(res.text).not.toMatch(/event_name="purchase"/);
  });
});
