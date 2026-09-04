import { beforeEach, vi } from 'vitest';
import * as model from '../src/models/event.model';
import type { EventRecord } from '../src/models/event.model';

/**
 * The model module, with every function replaced by a vi.fn() stub.
 * Each test file must call `vi.mock('../src/models/event.model')` for this to apply.
 */
export const events = vi.mocked(model);

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
beforeEach(() => {
  vi.resetAllMocks();
  events.createEvent.mockImplementation(async (accountId, eventName, timestamp) =>
    makeEvent({ accountId, eventName, timestamp: timestamp ?? new Date() }),
  );
  events.findEvents.mockResolvedValue([]);
  events.countEvents.mockResolvedValue(0);
  events.countEventsByWindow.mockResolvedValue([]);
});
