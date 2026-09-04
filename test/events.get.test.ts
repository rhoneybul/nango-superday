import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { events, makeEvent } from './helpers';

vi.mock('../src/models/event.model');

// vitest.config.ts sets EVENTS_DEFAULT_LIMIT=50 and EVENTS_MAX_LIMIT=500 for these tests.

describe('GET /events', () => {
  describe('no filters', () => {
    it('returns all events with default pagination', async () => {
      events.findEvents.mockResolvedValueOnce([makeEvent({ id: '2' }), makeEvent({ id: '1' })]);
      events.countEvents.mockResolvedValueOnce(2);

      const res = await request(app).get('/events');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0]).toMatchObject({ id: '2', accountId: 'acc_1', eventName: 'signup', timestamp: '2026-09-01T10:00:00.000Z' });
      expect(res.body.meta).toEqual({ total: 2, limit: 50, offset: 0 });
      expect(res.body.filters).toEqual({});
      expect(events.findEvents).toHaveBeenCalledWith({}, 50, 0);
      expect(events.countEvents).toHaveBeenCalledWith({});
      expect(events.countEventsByWindow).not.toHaveBeenCalled();
    });
  });

  describe('account filter', () => {
    it('passes account through as accountId', async () => {
      const res = await request(app).get('/events').query({ account: 'acc_42' });
      expect(res.status).toBe(200);
      expect(res.body.filters).toEqual({ account: 'acc_42' });
      expect(events.findEvents).toHaveBeenCalledWith({ accountId: 'acc_42' }, 50, 0);
      expect(events.countEvents).toHaveBeenCalledWith({ accountId: 'acc_42' });
    });

    it('treats an empty account as absent', async () => {
      const res = await request(app).get('/events?account=');
      expect(res.status).toBe(200);
      expect(events.findEvents).toHaveBeenCalledWith({}, 50, 0);
    });

    it('rejects a repeated account parameter', async () => {
      const res = await request(app).get('/events?account=a&account=b');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/account: .*received array/);
      expect(events.findEvents).not.toHaveBeenCalled();
    });
  });

  describe('event filter', () => {
    it('passes event through as eventName', async () => {
      const res = await request(app).get('/events').query({ event: 'purchase' });
      expect(res.status).toBe(200);
      expect(res.body.filters).toEqual({ event: 'purchase' });
      expect(events.findEvents).toHaveBeenCalledWith({ eventName: 'purchase' }, 50, 0);
    });

    it('combines account and event', async () => {
      await request(app).get('/events').query({ account: 'acc_1', event: 'purchase' });
      expect(events.findEvents).toHaveBeenCalledWith({ accountId: 'acc_1', eventName: 'purchase' }, 50, 0);
    });

    it('rejects an unknown event name', async () => {
      const res = await request(app).get('/events').query({ event: 'page_view' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/event: Invalid option: expected one of/);
      expect(events.findEvents).not.toHaveBeenCalled();
    });

    it('rejects a repeated event parameter', async () => {
      const res = await request(app).get('/events?event=a&event=b');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/event: /);
    });
  });

  describe('from / to range', () => {
    it('parses ISO-8601 from and to', async () => {
      const res = await request(app).get('/events').query({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' });
      expect(res.status).toBe(200);
      expect(res.body.filters).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' });
      expect(events.findEvents).toHaveBeenCalledWith(
        { timestamp: { gte: new Date('2026-09-01T00:00:00Z'), lte: new Date('2026-09-02T00:00:00Z') } },
        50,
        0,
      );
    });

    it('accepts date-only strings', async () => {
      const res = await request(app).get('/events').query({ from: '2026-09-01' });
      expect(res.status).toBe(200);
      expect(events.findEvents).toHaveBeenCalledWith({ timestamp: { gte: new Date('2026-09-01') } }, 50, 0);
    });

    it('accepts epoch milliseconds', async () => {
      const ms = Date.UTC(2026, 8, 1);
      const res = await request(app).get('/events').query({ from: String(ms) });
      expect(res.status).toBe(200);
      expect(events.findEvents).toHaveBeenCalledWith({ timestamp: { gte: new Date(ms) } }, 50, 0);
    });

    it('accepts only from (open-ended range)', async () => {
      await request(app).get('/events').query({ from: '2026-09-01T00:00:00Z' });
      expect(events.findEvents).toHaveBeenCalledWith({ timestamp: { gte: new Date('2026-09-01T00:00:00Z') } }, 50, 0);
    });

    it('accepts only to (open-ended range)', async () => {
      await request(app).get('/events').query({ to: '2026-09-01T00:00:00Z' });
      expect(events.findEvents).toHaveBeenCalledWith({ timestamp: { lte: new Date('2026-09-01T00:00:00Z') } }, 50, 0);
    });

    it('rejects an unparseable from', async () => {
      const res = await request(app).get('/events').query({ from: 'yesterday' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/from: must be an ISO-8601 date/);
      expect(events.findEvents).not.toHaveBeenCalled();
    });

    it('rejects an unparseable to', async () => {
      const res = await request(app).get('/events').query({ to: '2026-13-45' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/to: must be an ISO-8601 date/);
    });

    it('rejects from after to', async () => {
      const res = await request(app).get('/events').query({ from: '2026-09-02T00:00:00Z', to: '2026-09-01T00:00:00Z' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/from: must be before or equal to to/);
      expect(events.findEvents).not.toHaveBeenCalled();
    });

    it('allows from equal to to', async () => {
      const res = await request(app).get('/events').query({ from: '2026-09-01T00:00:00Z', to: '2026-09-01T00:00:00Z' });
      expect(res.status).toBe(200);
    });
  });

  describe('window (bucketed counts)', () => {
    it('returns bucketed counts and skips the raw listing', async () => {
      events.countEventsByWindow.mockResolvedValueOnce([
        { windowStart: new Date('2026-09-01T10:00:00Z'), count: 3 },
        { windowStart: new Date('2026-09-01T11:00:00Z'), count: 1 },
      ]);

      const res = await request(app).get('/events').query({ account: 'acc_1', event: 'signup', window: '1h' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        window: '1h',
        windowSeconds: 3600,
        buckets: [
          { windowStart: '2026-09-01T10:00:00.000Z', count: 3 },
          { windowStart: '2026-09-01T11:00:00.000Z', count: 1 },
        ],
        filters: { account: 'acc_1', event: 'signup' },
      });
      expect(events.countEventsByWindow).toHaveBeenCalledWith({ accountId: 'acc_1', eventName: 'signup' }, 3600);
      expect(events.findEvents).not.toHaveBeenCalled();
      expect(events.countEvents).not.toHaveBeenCalled();
    });

    it.each([
      ['30s', 30],
      ['15m', 900],
      ['1h', 3600],
      ['6h', 21600],
      ['1d', 86400],
      ['1w', 604800],
      [' 2h ', 7200],
    ])('parses window %s as %i seconds', async (window, seconds) => {
      const res = await request(app).get('/events').query({ window });
      expect(res.status).toBe(200);
      expect(res.body.windowSeconds).toBe(seconds);
      expect(events.countEventsByWindow).toHaveBeenCalledWith(expect.anything(), seconds);
    });

    it('passes from/to through to the windowed query', async () => {
      await request(app).get('/events').query({ window: '1d', from: '2026-09-01T00:00:00Z', to: '2026-09-03T00:00:00Z' });
      expect(events.countEventsByWindow).toHaveBeenCalledWith(
        { timestamp: { gte: new Date('2026-09-01T00:00:00Z'), lte: new Date('2026-09-03T00:00:00Z') } },
        86400,
      );
    });

    it.each(['1', 'h', '1hour', '1.5h', '-1h', '0h', 'abc', '1y'])('rejects invalid window %s', async (window) => {
      const res = await request(app).get('/events').query({ window });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/window/);
      expect(events.countEventsByWindow).not.toHaveBeenCalled();
    });

    it('treats an empty window as absent and returns the raw listing', async () => {
      const res = await request(app).get('/events?window=');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(events.countEventsByWindow).not.toHaveBeenCalled();
    });

    it('still validates from/to when window is set', async () => {
      const res = await request(app).get('/events').query({ window: '1h', from: 'nope' });
      expect(res.status).toBe(400);
      expect(events.countEventsByWindow).not.toHaveBeenCalled();
    });
  });

  describe('pagination', () => {
    it('honours limit and offset', async () => {
      const res = await request(app).get('/events').query({ limit: '10', offset: '20' });
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ total: 0, limit: 10, offset: 20 });
      expect(events.findEvents).toHaveBeenCalledWith({}, 10, 20);
    });

    it('caps limit at the configured maximum', async () => {
      const res = await request(app).get('/events').query({ limit: '501' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/limit: must be between 1 and 500/);
    });

    it.each(['0', '-1', 'ten', '1.5'])('rejects invalid limit %s', async (limit) => {
      const res = await request(app).get('/events').query({ limit });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/limit/);
    });

    it('rejects a negative offset', async () => {
      const res = await request(app).get('/events').query({ offset: '-5' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/offset: must be >= 0/);
    });
  });

  describe('errors from the data layer', () => {
    it('returns 500 without leaking details', async () => {
      events.findEvents.mockRejectedValueOnce(new Error('connection refused'));
      const res = await request(app).get('/events');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
    });
  });
});
