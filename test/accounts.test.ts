import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { META, accounts, events, publisher } from './helpers';

vi.mock('../src/models/event.model');
vi.mock('../src/models/account.model');
vi.mock('../src/queue/publisher');

describe('account validation', () => {
  describe('POST /ingest', () => {
    it('accepts an event for a known account', async () => {
      const res = await request(app).post('/ingest').send({ account_id: 'acc_known', event_name: 'connection_created', metadata: META.connection_created });
      expect(res.status).toBe(202);
      expect(accounts.accountExists).toHaveBeenCalledWith('acc_known');
      expect(publisher.publishEvent).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc_known', eventName: 'connection_created' }));
    });

    it('returns 404 for an unknown account and queues nothing', async () => {
      accounts.accountExists.mockResolvedValueOnce(false);
      const res = await request(app).post('/ingest').send({ account_id: 'acc_nope', event_name: 'connection_created', metadata: META.connection_created });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Account acc_nope not found' });
      expect(publisher.publishEvent).not.toHaveBeenCalled();
    });

    it('checks the account after validation and before the rate limit', async () => {
      // Invalid body: rejected before any lookup.
      const invalid = await request(app).post('/ingest').send({ account_id: 'acc_order', event_name: 'page_view' });
      expect(invalid.status).toBe(400);
      expect(accounts.accountExists).not.toHaveBeenCalled();

      // Unknown account: rejected before the limiter, so no RateLimit-* headers and no quota used.
      accounts.accountExists.mockResolvedValueOnce(false);
      const unknown = await request(app).post('/ingest').send({ account_id: 'acc_order', event_name: 'connection_created', metadata: META.connection_created });
      expect(unknown.status).toBe(404);
      expect(unknown.headers['ratelimit-limit']).toBeUndefined();

      const known = await request(app).post('/ingest').send({ account_id: 'acc_order', event_name: 'connection_created', metadata: META.connection_created });
      expect(known.status).toBe(202);
      expect(known.headers['ratelimit-limit']).toBe('100');
    });
  });

  describe('GET /events', () => {
    it('returns 404 when the account filter names an unknown account', async () => {
      accounts.accountExists.mockResolvedValueOnce(false);
      const res = await request(app).get('/events').query({ account: 'acc_nope' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Account acc_nope not found' });
      expect(events.findEvents).not.toHaveBeenCalled();
    });

    it('applies to aggregated mode too', async () => {
      accounts.accountExists.mockResolvedValueOnce(false);
      const res = await request(app).get('/events').query({ account: 'acc_nope', window: '1h', from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' });
      expect(res.status).toBe(404);
      expect(events.countEventsByWindow).not.toHaveBeenCalled();
    });

    it('does not look anything up without an account filter', async () => {
      const res = await request(app).get('/events').query({ event: 'connection_created' });
      expect(res.status).toBe(200);
      expect(accounts.accountExists).not.toHaveBeenCalled();
    });
  });
});
