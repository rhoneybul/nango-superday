import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, makeEvent } from './helpers';

// vitest.config.ts sets EVENTS_DEFAULT_LIMIT=50 and EVENTS_MAX_LIMIT=500 for these tests.

describe('GET /events', () => {
  describe('no filters', () => {
    it('returns all events with default pagination', async () => {
      const { app, model } = buildApp();
      model.findMany.mockResolvedValueOnce([makeEvent({ id: '2' }), makeEvent({ id: '1' })]);
      model.count.mockResolvedValueOnce(2);

      const res = await request(app).get('/events');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0]).toMatchObject({ id: '2', accountId: 'acc_1', eventName: 'signup', timestamp: '2026-09-01T10:00:00.000Z' });
      expect(res.body.meta).toEqual({ total: 2, limit: 50, offset: 0 });
      expect(res.body.filters).toEqual({});
      expect(model.findMany).toHaveBeenCalledWith({ accountId: undefined, eventName: undefined, from: undefined, to: undefined, limit: 50, offset: 0 });
      expect(model.count).toHaveBeenCalledWith({ accountId: undefined, eventName: undefined, from: undefined, to: undefined });
      expect(model.countByWindow).not.toHaveBeenCalled();
    });
  });

  describe('account filter', () => {
    it('passes account through as accountId', async () => {
      const { app, model } = buildApp();
      const res = await request(app).get('/events').query({ account: 'acc_42' });
      expect(res.status).toBe(200);
      expect(res.body.filters).toEqual({ account: 'acc_42' });
      expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc_42' }));
      expect(model.count).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc_42' }));
    });

    it('treats an empty account as absent', async () => {
      const { app, model } = buildApp();
      const res = await request(app).get('/events?account=');
      expect(res.status).toBe(200);
      expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({ accountId: undefined }));
    });

    it('rejects a repeated account parameter', async () => {
      const { app, model } = buildApp();
      const res = await request(app).get('/events?account=a&account=b');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/account must be supplied once/);
      expect(model.findMany).not.toHaveBeenCalled();
    });
  });

  describe('event filter', () => {
    it('passes event through as eventName', async () => {
      const { app, model } = buildApp();
      const res = await request(app).get('/events').query({ event: 'purchase' });
      expect(res.status).toBe(200);
      expect(res.body.filters).toEqual({ event: 'purchase' });
      expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({ eventName: 'purchase' }));
    });

    it('combines account and event', async () => {
      const { app, model } = buildApp();
      await request(app).get('/events').query({ account: 'acc_1', event: 'purchase' });
      expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc_1', eventName: 'purchase' }));
    });

    it('rejects a repeated event parameter', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/events?event=a&event=b');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/event must be supplied once/);
    });
  });

  describe('from / to range', () => {
    it('parses ISO-8601 from and to', async () => {
      const { app, model } = buildApp();
      const res = await request(app).get('/events').query({ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' });
      expect(res.status).toBe(200);
      expect(res.body.filters).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' });
      expect(model.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-02T00:00:00Z') }),
      );
    });

    it('accepts date-only strings', async () => {
      const { app, model } = buildApp();
      const res = await request(app).get('/events').query({ from: '2026-09-01' });
      expect(res.status).toBe(200);
      expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({ from: new Date('2026-09-01'), to: undefined }));
    });

    it('accepts epoch milliseconds', async () => {
      const { app, model } = buildApp();
      const ms = Date.UTC(2026, 8, 1);
      const res = await request(app).get('/events').query({ from: String(ms) });
      expect(res.status).toBe(200);
      expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({ from: new Date(ms) }));
    });

    it('accepts only from (open-ended range)', async () => {
      const { app, model } = buildApp();
      await request(app).get('/events').query({ from: '2026-09-01T00:00:00Z' });
      expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({ from: new Date('2026-09-01T00:00:00Z'), to: undefined }));
    });

    it('accepts only to (open-ended range)', async () => {
      const { app, model } = buildApp();
      await request(app).get('/events').query({ to: '2026-09-01T00:00:00Z' });
      expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({ from: undefined, to: new Date('2026-09-01T00:00:00Z') }));
    });

    it('rejects an unparseable from', async () => {
      const { app, model } = buildApp();
      const res = await request(app).get('/events').query({ from: 'yesterday' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/from must be an ISO-8601 date/);
      expect(model.findMany).not.toHaveBeenCalled();
    });

    it('rejects an unparseable to', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/events').query({ to: '2026-13-45' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/to must be an ISO-8601 date/);
    });

    it('rejects from after to', async () => {
      const { app, model } = buildApp();
      const res = await request(app).get('/events').query({ from: '2026-09-02T00:00:00Z', to: '2026-09-01T00:00:00Z' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/from must be before or equal to to/);
      expect(model.findMany).not.toHaveBeenCalled();
    });

    it('allows from equal to to', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/events').query({ from: '2026-09-01T00:00:00Z', to: '2026-09-01T00:00:00Z' });
      expect(res.status).toBe(200);
    });
  });

  describe('window (bucketed counts)', () => {
    it('returns bucketed counts and skips the raw listing', async () => {
      const { app, model } = buildApp();
      model.countByWindow.mockResolvedValueOnce([
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
      expect(model.countByWindow).toHaveBeenCalledWith({ accountId: 'acc_1', eventName: 'signup', from: undefined, to: undefined }, 3600);
      expect(model.findMany).not.toHaveBeenCalled();
      expect(model.count).not.toHaveBeenCalled();
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
      const { app, model } = buildApp();
      const res = await request(app).get('/events').query({ window });
      expect(res.status).toBe(200);
      expect(res.body.windowSeconds).toBe(seconds);
      expect(model.countByWindow).toHaveBeenCalledWith(expect.anything(), seconds);
    });

    it('passes from/to through to the windowed query', async () => {
      const { app, model } = buildApp();
      await request(app).get('/events').query({ window: '1d', from: '2026-09-01T00:00:00Z', to: '2026-09-03T00:00:00Z' });
      expect(model.countByWindow).toHaveBeenCalledWith(
        expect.objectContaining({ from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-03T00:00:00Z') }),
        86400,
      );
    });

    it.each(['1', 'h', '1hour', '1.5h', '-1h', '0h', 'abc', '1y'])('rejects invalid window %s', async (window) => {
      const { app, model } = buildApp();
      const res = await request(app).get('/events').query({ window });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/window/);
      expect(model.countByWindow).not.toHaveBeenCalled();
    });

    it('treats an empty window as absent and returns the raw listing', async () => {
      const { app, model } = buildApp();
      const res = await request(app).get('/events?window=');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(model.countByWindow).not.toHaveBeenCalled();
    });

    it('still validates from/to when window is set', async () => {
      const { app, model } = buildApp();
      const res = await request(app).get('/events').query({ window: '1h', from: 'nope' });
      expect(res.status).toBe(400);
      expect(model.countByWindow).not.toHaveBeenCalled();
    });
  });

  describe('pagination', () => {
    it('honours limit and offset', async () => {
      const { app, model } = buildApp();
      const res = await request(app).get('/events').query({ limit: '10', offset: '20' });
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ total: 0, limit: 10, offset: 20 });
      expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, offset: 20 }));
    });

    it('caps limit at the configured maximum', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/events').query({ limit: '501' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/limit must be <= 500/);
    });

    it.each(['0', '-1', 'ten', '1.5'])('rejects invalid limit %s', async (limit) => {
      const { app } = buildApp();
      const res = await request(app).get('/events').query({ limit });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/limit/);
    });

    it('rejects a negative offset', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/events').query({ offset: '-5' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/offset must be >= 0/);
    });
  });

  describe('errors from the data layer', () => {
    it('returns 500 without leaking details', async () => {
      const { app, model } = buildApp();
      model.findMany.mockRejectedValueOnce(new Error('connection refused'));
      const res = await request(app).get('/events');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
    });
  });
});
