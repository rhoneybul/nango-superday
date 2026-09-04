import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { events, publisher } from './helpers';

vi.mock('../src/models/event.model');
vi.mock('../src/models/account.model');
vi.mock('../src/queue/publisher');

describe('POST /ingest', () => {
  it('publishes the event to the queue and answers 202, without touching the database', async () => {
    const before = Date.now();
    const res = await request(app).post('/ingest').send({ account_id: 'acc_1', event_name: 'signup' });

    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ accountId: 'acc_1', eventName: 'signup', timestamp: expect.any(String) });
    // No timestamp supplied → stamped with the time the API received it.
    expect(new Date(res.body.data.timestamp).getTime()).toBeGreaterThanOrEqual(before);
    expect(publisher.publishEvent).toHaveBeenCalledWith({ accountId: 'acc_1', eventName: 'signup', timestamp: expect.any(Date) });
    expect(events.createEvent).not.toHaveBeenCalled();
  });

  it('uses the supplied timestamp', async () => {
    const res = await request(app).post('/ingest').send({ account_id: 'acc_1', event_name: 'signup', timestamp: '2026-09-01T10:00:00Z' });
    expect(res.status).toBe(202);
    expect(res.body.data.timestamp).toBe('2026-09-01T10:00:00.000Z');
    expect(publisher.publishEvent).toHaveBeenCalledWith(expect.objectContaining({ timestamp: new Date('2026-09-01T10:00:00Z') }));
  });

  it('answers 500 when the queue is unavailable', async () => {
    publisher.publishEvent.mockRejectedValueOnce(new Error('event queue not connected'));
    const res = await request(app).post('/ingest').send({ account_id: 'acc_1', event_name: 'signup' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it.each([
    [{ event_name: 'signup' }, /account_id: .*received undefined/],
    [{ account_id: 'acc_1' }, /event_name: Invalid option/],
    [{ account_id: '  ', event_name: 'signup' }, /account_id: Too small/],
    [{ account_id: 123, event_name: 'signup' }, /account_id: .*expected string/],
    [{ account_id: 'acc_1', event_name: 'signup', timestamp: 'not-a-date' }, /timestamp: must be an ISO-8601 date/],
    [{ account_id: 'acc_1', event_name: 'page_view' }, /event_name: Invalid option: expected one of "signup"\|"login"\|"logout"\|"purchase"/],
    [{ account_id: 'acc_1', event_name: 'signup', timestamp: '2999-01-01T00:00:00Z' }, /timestamp: must not be in the future/],
  ])('rejects invalid body %j', async (body, message) => {
    const res = await request(app).post('/ingest').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(publisher.publishEvent).not.toHaveBeenCalled();
  });

  it('rejects an array body', async () => {
    const res = await request(app).post('/ingest').send([{ account_id: 'acc_1', event_name: 'signup' }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expected object, received array/);
  });

  it('reports every invalid field in details', async () => {
    const res = await request(app).post('/ingest').send({ timestamp: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { path: 'account_id', message: expect.stringContaining('expected string') },
      { path: 'event_name', message: expect.stringContaining('Invalid option') },
      { path: 'timestamp', message: 'must be an ISO-8601 date or epoch milliseconds' },
    ]);
  });

  it('rejects malformed JSON', async () => {
    const res = await request(app).post('/ingest').set('Content-Type', 'application/json').send('{"account_id": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Malformed JSON body');
  });
});
