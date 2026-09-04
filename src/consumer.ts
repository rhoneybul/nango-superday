import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { config } from './config';
import { log } from './lib/logger';
import { prisma } from './lib/prisma';
import * as events from './models/event.model';
import { decodeEventMessage } from './queue/message';
import { assertTopology, QUEUE } from './queue/topology';

/**
 * The consumer service: reads the `events` queue and inserts each event into
 * Postgres. Runs as the `consumer` compose service (same image as the API,
 * `node dist/consumer.js`) or locally with `npm run dev:consumer`.
 *
 * Every message ends in exactly one of:
 *   ack                  inserted
 *   nack, requeue=false  undecodable (poison) → dead-letter queue immediately
 *   nack, requeue=true   insert failed (e.g. Postgres down) → redelivered; the broker
 *                        dead-letters it after DELIVERY_LIMIT deliveries (see queue/topology.ts)
 */
const PREFETCH = 50; // messages in flight at once, i.e. concurrent inserts

export async function handleMessage(channel: Pick<Channel, 'ack' | 'nack'>, msg: ConsumeMessage): Promise<void> {
  let message;
  try {
    message = decodeEventMessage(msg.content);
  } catch (err) {
    log.error({ err, body: msg.content.toString() }, 'invalid message, dead-lettering');
    channel.nack(msg, false, false);
    return;
  }
  try {
    await events.createEvent(message);
    channel.ack(msg);
  } catch (err) {
    log.error({ err, message, redelivered: msg.fields.redelivered }, 'insert failed, requeueing');
    channel.nack(msg, false, true);
  }
}

async function main(): Promise<void> {
  const connection = await amqp.connect(config.rabbitmqUrl, {
    recovery: {
      maxDelay: 5000, // retry at least every 5s while the broker is down
      setup: async (model: ChannelModel) => {
        const channel = await model.createChannel();
        await channel.prefetch(PREFETCH);
        await assertTopology(channel);
        await channel.consume(QUEUE, (msg) => {
          if (msg) void handleMessage(channel, msg);
        });
        log.info({ queue: QUEUE, prefetch: PREFETCH }, 'consuming');
      },
    },
  });
  connection.on('disconnect', (err) => log.warn({ err }, 'consumer disconnected, reconnecting'));

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    await connection.close(); // unacked messages go back to the queue
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    log.error({ err }, 'consumer failed to start');
    process.exit(1);
  });
}
