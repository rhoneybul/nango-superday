import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from './helpers';

describe('POST /ingest', () => {
  it('creates an event and defers timestamp to the DB default when omitted', async () => {
    const { app, model } = buildApp();
    const res = await request(app).post('/ingest').send({ account_id: 'acc_1', event_name: 'signup' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ accountId: 'acc_1', eventName: 'signup' });
    expect(model.create).toHaveBeenCalledWith({ accountId: 'acc_1', eventName: 'signup', timestamp: undefined });
  });

  it('uses the supplied timestamp', async () => {
    const { app, model } = buildApp();
    const res = await request(app).post('/ingest').send({ account_id: 'acc_1', event_name: 'signup', timestamp: '2026-09-01T10:00:00Z' });
    expect(res.status).toBe(201);
    expect(model.create).toHaveBeenCalledWith({ accountId: 'acc_1', eventName: 'signup', timestamp: new Date('2026-09-01T10:00:00Z') });
  });

  it.each([
    [{ event_name: 'signup' }, /account_id is required/],
    [{ account_id: 'acc_1' }, /event_name is required/],
    [{ account_id: '  ', event_name: 'signup' }, /account_id is required/],
    [{ account_id: 123, event_name: 'signup' }, /account_id is required/],
    [{ account_id: 'acc_1', event_name: 'signup', timestamp: 'not-a-date' }, /timestamp must be an ISO-8601 date/],
  ])('rejects invalid body %j', async (body, message) => {
    const { app, model } = buildApp();
    const res = await request(app).post('/ingest').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/ingest').set('Content-Type', 'application/json').send('{"account_id": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Malformed JSON body');
  });
});
