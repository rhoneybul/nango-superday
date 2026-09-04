import type { ConsumeMessage } from 'amqplib';
import { describe, expect, it, vi } from 'vitest';
import { handleMessage } from '../src/consumer';
import { EventName } from '../src/models/event-name';
import { encodeEventMessage } from '../src/queue/message';
import { events } from './helpers';

vi.mock('../src/models/event.model');
vi.mock('../src/models/account.model');
vi.mock('../src/queue/publisher');

/** A delivery as amqplib hands it to the consume callback (only what the handler reads). */
const delivery = (content: Buffer) => ({ content, fields: { redelivered: false }, properties: {} }) as unknown as ConsumeMessage;
const channel = () => ({ ack: vi.fn(), nack: vi.fn() });
const valid = encodeEventMessage({ accountId: 'acc_1', eventName: EventName.ConnectionCreated, quantity: 1, timestamp: new Date('2026-09-01T10:00:00Z') });

describe('consumer', () => {
  it('inserts a well-formed message and acks it', async () => {
    const ch = channel();
    const msg = delivery(valid);
    await handleMessage(ch, msg);
    expect(events.createEvent).toHaveBeenCalledWith({ accountId: 'acc_1', eventName: 'connection_created', quantity: 1, timestamp: new Date('2026-09-01T10:00:00Z') });
    expect(ch.ack).toHaveBeenCalledWith(msg);
    expect(ch.nack).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', Buffer.from('{oops')],
    ['missing fields', Buffer.from('{"accountId":"acc_1"}')],
    ['an unknown event name', Buffer.from('{"accountId":"acc_1","eventName":"page_view","timestamp":"2026-09-01T10:00:00Z"}')],
  ])('dead-letters a message that is %s', async (_name, content) => {
    const ch = channel();
    const msg = delivery(content);
    await handleMessage(ch, msg);
    expect(events.createEvent).not.toHaveBeenCalled();
    expect(ch.nack).toHaveBeenCalledWith(msg, false, false); // requeue=false → straight to the DLQ
  });

  it('requeues a message whose insert failed', async () => {
    events.createEvent.mockRejectedValueOnce(new Error('connection refused'));
    const ch = channel();
    const msg = delivery(valid);
    await handleMessage(ch, msg);
    expect(ch.nack).toHaveBeenCalledWith(msg, false, true); // requeue=true → redelivered; DLQ after the delivery limit
    expect(ch.ack).not.toHaveBeenCalled();
  });
});
