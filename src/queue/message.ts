import { z } from 'zod';
import { EventName } from '../models/event-name';
import type { NewEvent } from '../models/event.model';

/** One JSON message per event, exactly what the consumer stores; the contract between the API (publisher) and the consumer. */
export type EventMessage = NewEvent;

const schema: z.ZodType<EventMessage, unknown> = z.object({
  accountId: z.string().min(1),
  eventId: z.string().min(1),
  eventName: z.enum(EventName),
  metadata: z.record(z.string(), z.unknown()),
  timestamp: z.coerce.date(),
});

export function encodeEventMessage(message: EventMessage): Buffer {
  return Buffer.from(JSON.stringify(message));
}

/** Throws (ZodError or SyntaxError) for anything that is not a well-formed event: the consumer dead-letters those. */
export function decodeEventMessage(content: Buffer): EventMessage {
  return schema.parse(JSON.parse(content.toString('utf8')));
}
