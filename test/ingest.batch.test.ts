import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { accounts, events, publisher } from './helpers';

vi.mock('../src/models/event.model');
vi.mock('../src/models/account.model');
vi.mock('../src/queue/publisher');

const ok = (account_id: string, event_name: string, timestamp = '2026-09-01T10:00:00Z') => ({ account_id, event_name, timestamp });

describe('POST /ingest/batch', () => {
  it('queues every event and answers 202 with the count', async () => {
    const res = await request(app)
      .post('/ingest/batch')
      .send({ events: [ok('acc_1', 'signup'), ok('acc_1', 'login', '2026-09-01T11:00:00Z'), ok('acc_2', 'purchase')] });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ data: { queued: 3 } });
    expect(publisher.publishEvent).toHaveBeenCalledTimes(3);
    expect(publisher.publishEvent).toHaveBeenCalledWith({ accountId: 'acc_1', eventName: 'login', timestamp: new Date('2026-09-01T11:00:00Z') });
    expect(events.createEvent).not.toHaveBeenCalled();
  });

  it('rejects the whole batch and lists every invalid event, with its index', async () => {
    const res = await request(app)
      .post('/ingest/batch')
      .send({ events: [ok('acc_1', 'signup'), ok('acc_1', 'page_view'), { account_id: 'acc_1', event_name: 'login' }, ok('', 'signup', '2999-01-01T00:00:00Z')] });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { path: 'events.1.event_name', message: expect.stringContaining('Invalid option') },
      { path: 'events.2.timestamp', message: 'is required' },
      { path: 'events.3.account_id', message: expect.stringContaining('Too small') },
      { path: 'events.3.timestamp', message: 'must not be in the future' },
    ]);
    expect(publisher.publishEvent).not.toHaveBeenCalled();
  });

  it.each([
    [{}, /events: .*received undefined/],
    [{ events: [] }, /events: must contain at least one event/],
    [{ events: Array.from({ length: 101 }, () => ok('acc_1', 'signup')) }, /events: must contain at most 100 events/],
    [[ok('acc_1', 'signup')], /expected object, received array/],
  ])('rejects a malformed batch %j', async (body, message) => {
    const res = await request(app).post('/ingest/batch').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(publisher.publishEvent).not.toHaveBeenCalled();
  });

  it('lists unknown accounts by event index and queues nothing', async () => {
    accounts.accountExists.mockImplementation(async (id) => id !== 'acc_nope');
    const res = await request(app)
      .post('/ingest/batch')
      .send({ events: [ok('acc_nope', 'signup'), ok('acc_ok', 'signup'), ok('acc_nope', 'login')] });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { path: 'events.0.account_id', message: 'Account acc_nope not found' },
      { path: 'events.2.account_id', message: 'Account acc_nope not found' },
    ]);
    expect(publisher.publishEvent).not.toHaveBeenCalled();
  });

  it('allows 10 batches per account per minute, then rejects with the accounts that are over', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/ingest/batch').send({ events: [ok('acc_b', 'logout'), ok('acc_b', 'login')] });
      expect(res.status).toBe(202);
    }

    const over = await request(app).post('/ingest/batch').send({ events: [ok('acc_b', 'purchase')] });
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ error: 'Too many requests', details: [{ account: 'acc_b', limit: 10 }] });
    expect(publisher.publishEvent).toHaveBeenCalledTimes(20);

    // Another account is unaffected, and single ingests for acc_b are not, either: batches have their own counter.
    expect((await request(app).post('/ingest/batch').send({ events: [ok('acc_c', 'signup')] })).status).toBe(202);
    expect((await request(app).post('/ingest').send({ account_id: 'acc_b', event_name: 'logout' })).status).toBe(202);
  });

  it('records batch rejections in their own metrics, not the single-ingest ones', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^ingest_batch_rate_limited_total\{account_id="acc_b"\} 1$/m);
    expect(res.text).toMatch(/^ingest_batch_rate_limited_last_seen_timestamp_seconds\{account_id="acc_b"\} \d+/m);
    expect(res.text).not.toMatch(/ingest_rate_limited_total\{account_id="acc_b"/);
  });

  it('counts a mixed batch once against every account it contains', async () => {
    for (let i = 0; i < 10; i++) await request(app).post('/ingest/batch').send({ events: [ok('acc_m1', 'signup'), ok('acc_m2', 'signup')] });
    const res = await request(app).post('/ingest/batch').send({ events: [ok('acc_m1', 'signup'), ok('acc_m2', 'signup'), ok('acc_m3', 'signup')] });
    expect(res.status).toBe(429);
    expect(res.body.details).toEqual([
      { account: 'acc_m1', limit: 10 },
      { account: 'acc_m2', limit: 10 },
    ]);
  });
});
