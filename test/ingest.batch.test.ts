import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { META, accounts, events, publisher } from './helpers';

vi.mock('../src/models/event.model');
vi.mock('../src/models/account.model');
vi.mock('../src/queue/publisher');

const ok = (account_id: string, event_name: string, timestamp = '2026-09-01T10:00:00Z') => ({ account_id, event_name, timestamp, metadata: META[event_name] ?? META.api_request });

describe('POST /ingest/batch', () => {
  it('queues every event and answers 202 with the count', async () => {
    const res = await request(app)
      .post('/ingest/batch')
      .send({ events: [ok('acc_1', 'connection_created'), ok('acc_1', 'api_request', '2026-09-01T11:00:00Z'), ok('acc_2', 'sync_run')] });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ data: { success: 3, failed: 0, errors: [] } });
    expect(publisher.publishEvent).toHaveBeenCalledTimes(3);
    expect(publisher.publishEvent).toHaveBeenCalledWith({ accountId: 'acc_1', eventName: 'api_request', metadata: META.api_request, timestamp: new Date('2026-09-01T11:00:00Z') });
    expect(events.createEvent).not.toHaveBeenCalled();
  });

  it('queues the valid events and lists every invalid one with its index', async () => {
    const res = await request(app)
      .post('/ingest/batch')
      .send({ events: [ok('acc_1', 'connection_created'), ok('acc_1', 'page_view'), { account_id: 'acc_1', event_name: 'api_request', metadata: META.api_request }, ok('', 'connection_created', '2999-01-01T00:00:00Z')] });

    expect(res.status).toBe(202);
    expect(res.body.data.success).toBe(1);
    expect(res.body.data.failed).toBe(3); // index 3 has two problems but is one failed event
    expect(res.body.data.errors).toEqual([
      { index: 1, path: 'events.1.event_name', message: expect.stringContaining('Invalid option'), reason: 'invalid' },
      { index: 2, path: 'events.2.timestamp', message: 'is required', reason: 'invalid' },
      { index: 3, path: 'events.3.account_id', message: expect.stringContaining('Too small'), reason: 'invalid' },
      { index: 3, path: 'events.3.timestamp', message: 'must not be in the future', reason: 'invalid' },
    ]);
    expect(publisher.publishEvent).toHaveBeenCalledTimes(1);
    expect(publisher.publishEvent).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc_1', eventName: 'connection_created' }));
  });

  it('answers 400 when nothing could be queued', async () => {
    const res = await request(app).post('/ingest/batch').send({ events: [ok('acc_1', 'page_view'), { account_id: 'acc_1', event_name: 'api_request', metadata: META.api_request }] });
    expect(res.status).toBe(400);
    expect(res.body.data).toMatchObject({ success: 0, failed: 2 });
    expect(publisher.publishEvent).not.toHaveBeenCalled();
  });

  it.each([
    [{}, /events: .*received undefined/],
    [{ events: [] }, /events: must contain at least one event/],
    [{ events: Array.from({ length: 101 }, () => ok('acc_1', 'connection_created')) }, /events: must contain at most 100 events/],
    [[ok('acc_1', 'connection_created')], /expected object, received array/],
  ])('rejects a malformed batch %j', async (body, message) => {
    const res = await request(app).post('/ingest/batch').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(publisher.publishEvent).not.toHaveBeenCalled();
  });

  it('queues events for known accounts and lists the ones for unknown accounts', async () => {
    accounts.accountExists.mockImplementation(async (id) => id !== 'acc_nope');
    const res = await request(app)
      .post('/ingest/batch')
      .send({ events: [ok('acc_nope', 'connection_created'), ok('acc_ok', 'connection_created'), ok('acc_nope', 'api_request')] });

    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({
      success: 1,
      failed: 2,
      errors: [
        { index: 0, path: 'events.0.account_id', message: 'Account acc_nope not found', reason: 'unknown_account' },
        { index: 2, path: 'events.2.account_id', message: 'Account acc_nope not found', reason: 'unknown_account' },
      ],
    });
    expect(publisher.publishEvent).toHaveBeenCalledTimes(1);
    expect(publisher.publishEvent).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc_ok' }));
  });

  it('allows 10 batches per account per minute, then rejects that account\'s events with 429 when nothing else is queued', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/ingest/batch').send({ events: [ok('acc_b', 'webhook_received'), ok('acc_b', 'api_request')] });
      expect(res.status).toBe(202);
    }

    const over = await request(app).post('/ingest/batch').send({ events: [ok('acc_b', 'sync_run')] });
    expect(over.status).toBe(429);
    expect(over.body.data).toEqual({
      success: 0,
      failed: 1,
      errors: [{ index: 0, path: 'events.0', message: 'Account acc_b is over its batch limit of 10 per minute', reason: 'rate_limited' }],
    });
    expect(publisher.publishEvent).toHaveBeenCalledTimes(20);

    // Another account is unaffected, and single ingests for acc_b are not, either: batches have their own counter.
    expect((await request(app).post('/ingest/batch').send({ events: [ok('acc_c', 'connection_created')] })).status).toBe(202);
    expect((await request(app).post('/ingest').send({ account_id: 'acc_b', event_name: 'webhook_received', metadata: META.webhook_received })).status).toBe(202);
  });

  it('records batch rejections in their own metrics, not the single-ingest ones', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^ingest_batch_rate_limited_total\{account_id="acc_b"\} 1$/m);
    expect(res.text).toMatch(/^ingest_batch_rate_limited_last_seen_timestamp_seconds\{account_id="acc_b"\} \d+/m);
    expect(res.text).not.toMatch(/ingest_rate_limited_total\{account_id="acc_b"/);
  });

  it('drops only the over-limit accounts from a mixed batch and queues the rest', async () => {
    for (let i = 0; i < 10; i++) await request(app).post('/ingest/batch').send({ events: [ok('acc_m1', 'connection_created'), ok('acc_m2', 'connection_created')] });
    const res = await request(app).post('/ingest/batch').send({ events: [ok('acc_m1', 'connection_created'), ok('acc_m2', 'connection_created'), ok('acc_m3', 'connection_created')] });
    expect(res.status).toBe(202);
    expect(res.body.data.success).toBe(1);
    expect(res.body.data.errors.map((e: { index: number; reason: string }) => [e.index, e.reason])).toEqual([[0, 'rate_limited'], [1, 'rate_limited']]);
    expect(publisher.publishEvent).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 'acc_m3' }));
  });

  it('charges each batch event against the same account + event limit as single ingest', async () => {
    // 100 single ingests use up acc_s:api_request for the minute …
    for (let i = 0; i < 100; i++) expect((await request(app).post('/ingest').send({ account_id: 'acc_s', event_name: 'api_request', metadata: META.api_request })).status).toBe(202);

    // … so a batch with two more of them, plus one of another kind, queues only the other kind.
    const res = await request(app).post('/ingest/batch').send({ events: [ok('acc_s', 'api_request'), ok('acc_s', 'sync_run'), ok('acc_s', 'api_request')] });
    expect(res.status).toBe(202);
    expect(res.body.data.success).toBe(1);
    expect(res.body.data.errors).toEqual([
      { index: 0, path: 'events.0', message: 'Account acc_s is over its api_request limit of 100 per minute', reason: 'rate_limited' },
      { index: 2, path: 'events.2', message: 'Account acc_s is over its api_request limit of 100 per minute', reason: 'rate_limited' },
    ]);
    expect(publisher.publishEvent).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 'acc_s', eventName: 'sync_run' }));

    // And the other way round: a batch that fills a pair's quota makes the next single ingest a 429.
    const fill = await request(app).post('/ingest/batch').send({ events: Array.from({ length: 100 }, () => ok('acc_t', 'webhook_received')) });
    expect(fill.body.data.success).toBe(100);
    expect((await request(app).post('/ingest').send({ account_id: 'acc_t', event_name: 'webhook_received', metadata: META.webhook_received })).status).toBe(429);
  });
});
