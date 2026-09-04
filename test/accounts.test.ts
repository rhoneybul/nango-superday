import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { accounts, events, publisher } from './helpers';

vi.mock('../src/models/event.model');
vi.mock('../src/models/account.model');
vi.mock('../src/queue/publisher');

// No REDIS_URL in the test env, so the account cache is the in-memory one.
// Each test uses its own account id: the cache is shared across the file.

describe('account validation', () => {
  describe('POST /ingest', () => {
    it('accepts an event for a known account', async () => {
      const res = await request(app).post('/ingest').send({ account_id: 'acc_known', event_name: 'signup' });
      expect(res.status).toBe(202);
      expect(accounts.findAccount).toHaveBeenCalledWith('acc_known');
      expect(publisher.publishEvent).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc_known', eventName: 'signup' }));
    });

    it('returns 404 for an unknown account and queues nothing', async () => {
      accounts.findAccount.mockResolvedValueOnce(null);
      const res = await request(app).post('/ingest').send({ account_id: 'acc_nope', event_name: 'signup' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Account acc_nope not found' });
      expect(publisher.publishEvent).not.toHaveBeenCalled();
    });

    it('checks the account after validation and before the rate limit', async () => {
      // Invalid body: rejected before any lookup.
      const invalid = await request(app).post('/ingest').send({ account_id: 'acc_order', event_name: 'page_view' });
      expect(invalid.status).toBe(400);
      expect(accounts.findAccount).not.toHaveBeenCalled();

      // Unknown account: rejected before the limiter, so no RateLimit-* headers and no quota used.
      accounts.findAccount.mockResolvedValueOnce(null);
      const unknown = await request(app).post('/ingest').send({ account_id: 'acc_order_missing', event_name: 'signup' });
      expect(unknown.status).toBe(404);
      expect(unknown.headers['ratelimit-limit']).toBeUndefined();

      const known = await request(app).post('/ingest').send({ account_id: 'acc_order', event_name: 'signup' });
      expect(known.status).toBe(202);
      expect(known.headers['ratelimit-limit']).toBe('100');
    });
  });

  describe('GET /events', () => {
    it('returns 404 when the account filter names an unknown account', async () => {
      accounts.findAccount.mockResolvedValueOnce(null);
      const res = await request(app).get('/events').query({ account: 'acc_nope_list' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Account acc_nope_list not found' });
      expect(events.findEvents).not.toHaveBeenCalled();
    });

    it('applies to aggregated mode too', async () => {
      accounts.findAccount.mockResolvedValueOnce(null);
      const res = await request(app).get('/events').query({ account: 'acc_nope_window', window: '1h' });
      expect(res.status).toBe(404);
      expect(events.countEventsByWindow).not.toHaveBeenCalled();
    });

    it('does not look anything up without an account filter', async () => {
      const res = await request(app).get('/events').query({ event: 'signup' });
      expect(res.status).toBe(200);
      expect(accounts.findAccount).not.toHaveBeenCalled();
    });
  });

  describe('cache', () => {
    it('hits the account model once for repeated requests from the same account', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await request(app).post('/ingest').send({ account_id: 'acc_cached', event_name: 'login' });
        expect(res.status).toBe(202);
      }
      const listed = await request(app).get('/events').query({ account: 'acc_cached' });
      expect(listed.status).toBe(200);
      expect(accounts.findAccount).toHaveBeenCalledTimes(1);
    });

    it('caches misses so repeated unknown ids do not reach the database', async () => {
      accounts.findAccount.mockResolvedValue(null);
      for (let i = 0; i < 3; i++) {
        const res = await request(app).post('/ingest').send({ account_id: 'acc_cached_miss', event_name: 'login' });
        expect(res.status).toBe(404);
      }
      expect(accounts.findAccount).toHaveBeenCalledTimes(1);
    });
  });
});
