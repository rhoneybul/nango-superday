import { z } from 'zod';
import { EventName } from './event-name';

/**
 * What each metered event means for billing, and what it must carry.
 *
 *   unit      the thing being counted (the billable unit)
 *   quantity  how many units one event represents, read from its metadata
 *   metadata  the fields the event must carry so billing never has to guess;
 *             extra fields are allowed (loose objects) and kept as sent
 *
 * This is the single place to change when a new kind of usage is metered or
 * an existing one needs another field. Validation (src/middleware/validation.ts)
 * and GET /event-types both read it.
 */
export interface EventType {
  description: string;
  unit: string;
  quantity: (metadata: Record<string, unknown>) => number;
  metadata: z.ZodObject<z.ZodRawShape>;
}

const id = z.string().min(1);
const one = () => 1;

export const EVENT_CATALOG: Record<EventName, EventType> = {
  [EventName.ApiRequest]: {
    description: 'A request made through the platform to a third-party API',
    unit: 'requests',
    quantity: one,
    metadata: z.looseObject({ connection_id: id, provider: id, endpoint: id }),
  },
  [EventName.SyncRun]: {
    description: 'One execution of a sync',
    unit: 'sync runs',
    quantity: one,
    metadata: z.looseObject({ connection_id: id, sync: id }),
  },
  [EventName.RecordsSynced]: {
    description: 'Records moved by a sync',
    unit: 'records',
    quantity: (m) => m.records as number,
    metadata: z.looseObject({ connection_id: id, model: id, records: z.number().int().nonnegative() }),
  },
  [EventName.ActionExecuted]: {
    description: 'One execution of an on-demand action',
    unit: 'actions',
    quantity: one,
    metadata: z.looseObject({ connection_id: id, action: id }),
  },
  [EventName.WebhookReceived]: {
    description: 'One inbound webhook received and processed for the customer',
    unit: 'webhooks',
    quantity: one,
    metadata: z.looseObject({ connection_id: id, provider: id }),
  },
  [EventName.ConnectionCreated]: {
    description: 'A new connection (authorised integration) created',
    unit: 'connections',
    quantity: one,
    metadata: z.looseObject({ connection_id: id, provider: id }),
  },
};

/** The catalogue as GET /event-types returns it: what can be metered, its unit, and the metadata each event must carry. */
export function describeEventTypes() {
  return Object.entries(EVENT_CATALOG).map(([name, type]) => ({
    name,
    description: type.description,
    unit: type.unit,
    metadata: Object.fromEntries(Object.entries(type.metadata.shape).map(([field, schema]) => [field, schema instanceof z.ZodNumber ? 'integer' : 'string'])),
  }));
}
