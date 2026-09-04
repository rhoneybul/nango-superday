import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { META, events, publisher } from './helpers';

vi.mock('../src/models/event.model');
vi.mock('../src/models/account.model');
vi.mock('../src/queue/publisher');

describe('POST /ingest', () => {
  it('publishes the event to the queue and answers 202, without touching the database', async () => {
    const before = Date.now();
    const res = await request(app).post('/ingest').send({ account_id: 'acc_1', event_name: 'connection_created', metadata: META.connection_created });

    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ accountId: 'acc_1', eventName: 'connection_created', metadata: META.connection_created, timestamp: expect.any(String) });
    // No timestamp supplied → stamped with the time the API received it.
    expect(new Date(res.body.data.timestamp).getTime()).toBeGreaterThanOrEqual(before);
    expect(publisher.publishEvent).toHaveBeenCalledWith({ accountId: 'acc_1', eventName: 'connection_created', metadata: META.connection_created, timestamp: expect.any(Date) });
    expect(events.createEvent).not.toHaveBeenCalled();
  });

  it('carries metadata through to the queue', async () => {
    const body = { account_id: 'acc_1', event_name: 'records_synced', metadata: { connection_id: 'conn_42', model: 'Contact', records: 250, provider: 'hubspot' } };
    const res = await request(app).post('/ingest').send(body);
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ eventName: 'records_synced', metadata: body.metadata });
    expect(publisher.publishEvent).toHaveBeenCalledWith(expect.objectContaining({ metadata: body.metadata }));
  });

  it('validates metadata against the event catalogue and reports each missing or wrong field', async () => {
    const res = await request(app).post('/ingest').send({ account_id: 'acc_1', event_name: 'records_synced', metadata: { connection_id: 'conn_1', records: 'lots' } });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { path: 'metadata.model', message: expect.stringContaining('expected string') },
      { path: 'metadata.records', message: expect.stringContaining('expected number') },
    ]);
    expect(publisher.publishEvent).not.toHaveBeenCalled();
  });

  it('keeps extra metadata fields', async () => {
    const res = await request(app).post('/ingest').send({ account_id: 'acc_1', event_name: 'sync_run', metadata: { ...META.sync_run, region: 'eu' } });
    expect(res.status).toBe(202);
    expect(res.body.data.metadata).toEqual({ ...META.sync_run, region: 'eu' });
  });

  it('GET /event-types describes the catalogue', async () => {
    const res = await request(app).get('/event-types');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(6);
    expect(res.body.data.find((t: { name: string }) => t.name === 'records_synced')).toEqual({
      name: 'records_synced',
      description: 'Records moved by a sync',
      unit: 'records',
      metadata: { connection_id: 'string', model: 'string', records: 'integer' },
    });
  });

  it.each([
    [{ metadata: undefined }, /metadata: .*received undefined/],
    [{ metadata: 'not-an-object' }, /metadata: .*expected record/],
    [{ metadata: { blob: 'x'.repeat(5000) } }, /metadata: must be at most 4096 bytes/],
  ])('rejects bad metadata %j', async (extra, message) => {
    const res = await request(app).post('/ingest').send({ account_id: 'acc_1', event_name: 'api_request', metadata: META.api_request, ...extra });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(publisher.publishEvent).not.toHaveBeenCalled();
  });

  it('uses the supplied timestamp', async () => {
    const res = await request(app).post('/ingest').send({ account_id: 'acc_1', event_name: 'connection_created', timestamp: '2026-09-01T10:00:00Z', metadata: META.connection_created });
    expect(res.status).toBe(202);
    expect(res.body.data.timestamp).toBe('2026-09-01T10:00:00.000Z');
    expect(publisher.publishEvent).toHaveBeenCalledWith(expect.objectContaining({ timestamp: new Date('2026-09-01T10:00:00Z') }));
  });

  it('answers 500 when the queue is unavailable', async () => {
    publisher.publishEvent.mockRejectedValueOnce(new Error('event queue not connected'));
    const res = await request(app).post('/ingest').send({ account_id: 'acc_1', event_name: 'connection_created', metadata: META.connection_created });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it.each([
    [{ event_name: 'connection_created' }, /account_id: .*received undefined/],
    [{ account_id: 'acc_1' }, /event_name: Invalid option/],
    [{ account_id: '  ', event_name: 'connection_created', metadata: META.connection_created }, /account_id: Too small/],
    [{ account_id: 123, event_name: 'connection_created', metadata: META.connection_created }, /account_id: .*expected string/],
    [{ account_id: 'acc_1', event_name: 'connection_created', timestamp: 'not-a-date', metadata: META.connection_created }, /timestamp: must be an ISO-8601 date/],
    [{ account_id: 'acc_1', event_name: 'page_view' }, /event_name: Invalid option: expected one of "api_request"\|"sync_run"\|"records_synced"\|"action_executed"\|"webhook_received"\|"connection_created"/],
    [{ account_id: 'acc_1', event_name: 'connection_created', timestamp: '2999-01-01T00:00:00Z', metadata: META.connection_created }, /timestamp: must not be in the future/],
  ])('rejects invalid body %j', async (body, message) => {
    const res = await request(app).post('/ingest').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(publisher.publishEvent).not.toHaveBeenCalled();
  });

  it('rejects an array body', async () => {
    const res = await request(app).post('/ingest').send([{ account_id: 'acc_1', event_name: 'connection_created', metadata: META.connection_created }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expected object, received array/);
  });

  it('reports every invalid field in details', async () => {
    const res = await request(app).post('/ingest').send({ timestamp: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { path: 'account_id', message: expect.stringContaining('expected string') },
      { path: 'event_name', message: expect.stringContaining('Invalid option') },
      { path: 'metadata', message: expect.stringContaining('expected record') },
      { path: 'timestamp', message: 'must be an ISO-8601 date or epoch milliseconds' },
    ]);
  });

  it('rejects malformed JSON', async () => {
    const res = await request(app).post('/ingest').set('Content-Type', 'application/json').send('{"account_id": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Malformed JSON body');
  });
});
