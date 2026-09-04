import { z } from 'zod';
import { EventName } from '../models/event-name';

/** One JSON message per event; the contract between the API (publisher) and the consumer. */
export interface EventMessage {
  accountId: string;
  eventName: EventName;
  timestamp: Date;
}

const schema: z.ZodType<EventMessage, unknown> = z.object({
  accountId: z.string().min(1),
  eventName: z.enum(EventName),
  timestamp: z.coerce.date(),
});

export function encodeEventMessage(message: EventMessage): Buffer {
  return Buffer.from(JSON.stringify(message));
}

/** Throws (ZodError or SyntaxError) for anything that is not a well-formed event: the consumer dead-letters those. */
export function decodeEventMessage(content: Buffer): EventMessage {
  return schema.parse(JSON.parse(content.toString('utf8')));
}
