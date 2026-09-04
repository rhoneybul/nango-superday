import type { Channel } from 'amqplib';

/**
 * The RabbitMQ topology, asserted by the API and the consumer on connect (idempotent):
 *
 *   POST /ingest ─▶ exchange `events` ─▶ queue `events` ─▶ consumer ─▶ Postgres
 *                                             │ rejected, or DELIVERY_LIMIT failed deliveries
 *                                             ▼
 *                                  exchange `events.dlx` ─▶ queue `events.dlq`
 *
 * `events` is a quorum queue so the broker itself dead-letters a message after
 * DELIVERY_LIMIT deliveries; a message that keeps failing can never loop forever.
 * Queue arguments are fixed at declaration: to change one, delete the queue first.
 */
export const EXCHANGE = 'events';
export const QUEUE = 'events';
export const DEAD_LETTER_EXCHANGE = 'events.dlx';
export const DEAD_LETTER_QUEUE = 'events.dlq';
export const DELIVERY_LIMIT = 5;

export async function assertTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', { durable: true });
  await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
  await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '');

  await channel.assertExchange(EXCHANGE, 'direct', { durable: true });
  await channel.assertQueue(QUEUE, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE, 'x-delivery-limit': DELIVERY_LIMIT },
  });
  await channel.bindQueue(QUEUE, EXCHANGE, QUEUE);
}
