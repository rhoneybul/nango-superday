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

/** Valid metadata for each event name, per src/models/event-catalog.ts. */
export const META: Record<string, Record<string, unknown>> = {
  api_request: { connection_id: 'conn_1', provider: 'hubspot', endpoint: '/crm/v3/objects/contacts' },
  sync_run: { connection_id: 'conn_1', sync: 'contacts' },
  records_synced: { connection_id: 'conn_1', model: 'Contact', records: 250 },
  action_executed: { connection_id: 'conn_1', action: 'create-contact' },
  webhook_received: { connection_id: 'conn_1', provider: 'hubspot' },
  connection_created: { connection_id: 'conn_1', provider: 'hubspot' },
};

export function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: '1',
    accountId: 'acc_1',
    eventName: 'connection_created',
    metadata: META.connection_created,
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
  events.createEvent.mockImplementation(async (event) => makeEvent(event));
  events.findEvents.mockResolvedValue([]);
  events.countEvents.mockResolvedValue(0);
  events.countEventsByWindow.mockResolvedValue([]);
  publisher.publishEvent.mockResolvedValue(undefined);
});
