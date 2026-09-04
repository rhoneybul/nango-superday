import { beforeEach, vi } from 'vitest';
import * as accountModel from '../src/models/account.model';
import type { Account } from '../src/models/account.model';
import * as model from '../src/models/event.model';
import type { EventRecord } from '../src/models/event.model';

/**
 * The model modules, with every function replaced by a vi.fn() stub.
 * Each test file must call `vi.mock('../src/models/event.model')` and
 * `vi.mock('../src/models/account.model')` for this to apply.
 */
export const events = vi.mocked(model);
export const accounts = vi.mocked(accountModel);

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

export function makeAccount(overrides: Partial<Account> = {}): Account {
  return { id: 'acc_1', name: 'Acme Corp', mainContact: 'jane.doe@acme.example', ...overrides };
}

// Harmless defaults so a test only has to override what it cares about.
// Every account id exists unless a test says otherwise (findAccount.mockResolvedValueOnce(null)).
beforeEach(() => {
  vi.resetAllMocks();
  accounts.findAccount.mockImplementation(async (id) => makeAccount({ id }));
  events.createEvent.mockImplementation(async (accountId, eventName, timestamp) =>
    makeEvent({ accountId, eventName, timestamp: timestamp ?? new Date() }),
  );
  events.findEvents.mockResolvedValue([]);
  events.countEvents.mockResolvedValue(0);
  events.countEventsByWindow.mockResolvedValue([]);
});
