import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { log } from '../src/lib/logger';
import { events } from './helpers';

vi.mock('../src/models/event.model');

// vitest.config.ts silences logs for the other suites; this one needs them on.
// `vi.hoisted` runs before the imports above, i.e. before config reads the env.
vi.hoisted(() => {
  process.env.LOG_LEVEL = 'info';
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Captures every JSON log line written during a test. */
function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(JSON.parse(String(chunk)));
    return true;
  });
  return lines;
}

describe('request id', () => {
  it('generates a UUID when the client sends none', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('echoes an incoming X-Request-Id', async () => {
    const res = await request(app).get('/health').set('X-Request-Id', 'client-abc');
    expect(res.headers['x-request-id']).toBe('client-abc');
  });
});

describe('json logging', () => {
  let lines: Record<string, unknown>[];
  beforeEach(() => {
    lines = captureLogs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs one JSON line per request, tagged with the request id', async () => {
    await request(app).get('/events?account=acc_1').set('X-Request-Id', 'req-1');

    expect(lines).toEqual([
      expect.objectContaining({
        level: 'info',
        msg: 'request',
        requestId: 'req-1',
        method: 'GET',
        path: '/events?account=acc_1',
        status: 200,
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it('logs unhandled errors with the request id and the error details', async () => {
    events.findEvents.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app).get('/events').set('X-Request-Id', 'req-2');

    expect(res.status).toBe(500);
    expect(lines[0]).toMatchObject({
      level: 'error',
      msg: 'unhandled error',
      requestId: 'req-2',
      err: { type: 'Error', message: 'connection refused', stack: expect.stringContaining('connection refused') },
    });
    expect(lines[1]).toMatchObject({ msg: 'request', requestId: 'req-2', status: 500 });
  });

  it('does not log below the configured level', () => {
    log.debug('hidden');
    log.info('shown');
    expect(lines.map((l) => l.msg)).toEqual(['shown']);
  });
});
