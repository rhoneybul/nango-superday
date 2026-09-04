import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { events } from './helpers';

vi.mock('../src/models/event.model');

describe('POST /ingest', () => {
  it('creates an event and defers timestamp to the DB default when omitted', async () => {
    const res = await request(app).post('/ingest').send({ account_id: 'acc_1', event_name: 'signup' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ accountId: 'acc_1', eventName: 'signup' });
    expect(events.createEvent).toHaveBeenCalledWith('acc_1', 'signup', undefined);
  });

  it('uses the supplied timestamp', async () => {
    const res = await request(app).post('/ingest').send({ account_id: 'acc_1', event_name: 'signup', timestamp: '2026-09-01T10:00:00Z' });
    expect(res.status).toBe(201);
    expect(events.createEvent).toHaveBeenCalledWith('acc_1', 'signup', new Date('2026-09-01T10:00:00Z'));
  });

  it.each([
    [{ event_name: 'signup' }, /account_id: .*received undefined/],
    [{ account_id: 'acc_1' }, /event_name: Invalid option/],
    [{ account_id: '  ', event_name: 'signup' }, /account_id: Too small/],
    [{ account_id: 123, event_name: 'signup' }, /account_id: .*expected string/],
    [{ account_id: 'acc_1', event_name: 'signup', timestamp: 'not-a-date' }, /timestamp: must be an ISO-8601 date/],
    [{ account_id: 'acc_1', event_name: 'page_view' }, /event_name: Invalid option: expected one of "signup"\|"login"\|"logout"\|"purchase"/],
  ])('rejects invalid body %j', async (body, message) => {
    const res = await request(app).post('/ingest').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(events.createEvent).not.toHaveBeenCalled();
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
