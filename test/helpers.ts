import { beforeEach, vi } from 'vitest';
import * as accountModel from '../src/models/account.model';
import * as model from '../src/models/event.model';
import type { EventRecord } from '../src/models/event.model';
import * as publisherModule from '../src/queue/publisher';

/**
 * The model modules and the queue publisher, with every function replaced by
 * a vi.fn() stub. Each test file must call `vi.mock('../src/models/event.model')`,
 * `vi.mock('../src/models/account.model')` and `vi.mock('../src/queue/publisher')`
 * for this to apply. No broker is involved: POST /ingest ends at `publisher.publishEvent`.
 */
export const events = vi.mocked(model);
export const accounts = vi.mocked(accountModel);
export const publisher = vi.mocked(publisherModule);

export function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: '1',
    accountId: 'acc_1',
    eventName: 'signup',
    timestamp: new Date('2026-09-01T10:00:00.000Z'),
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    ...overrides,
  };
}

// Harmless defaults so a test only has to override what it cares about.
// Every account id exists unless a test says otherwise (accountExists.mockResolvedValueOnce(false)).
beforeEach(() => {
  vi.resetAllMocks();
  accounts.accountExists.mockResolvedValue(true);
  events.createEvent.mockImplementation(async (accountId, eventName, timestamp) =>
    makeEvent({ accountId, eventName, timestamp: timestamp ?? new Date() }),
  );
  events.findEvents.mockResolvedValue([]);
  events.countEvents.mockResolvedValue(0);
  events.countEventsByWindow.mockResolvedValue([]);
  publisher.publishEvent.mockResolvedValue(undefined);
});
