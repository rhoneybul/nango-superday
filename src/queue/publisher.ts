import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import { config } from '../config';
import { log } from '../lib/logger';
import { encodeEventMessage, type EventMessage } from './message';
import { assertTopology, EXCHANGE, QUEUE } from './topology';

/**
 * Publishes events to RabbitMQ for POST /ingest. Uses a confirm channel, so
 * `publishEvent` resolves once the broker has stored the message. amqplib's
 * recovery mode reconnects with backoff if the broker goes away; until the
 * channel is back, publishing fails and the request gets a 500.
 */
let channel: ConfirmChannel | undefined;

export async function startPublisher(): Promise<void> {
  const connection = await amqp.connect(config.rabbitmqUrl, {
    recovery: {
      maxDelay: 5000, // retry at least every 5s while the broker is down
      // Runs after every (re)connect; channels do not survive a connection loss.
      setup: async (model: ChannelModel) => {
        const ch = await model.createConfirmChannel();
        await assertTopology(ch);
        channel = ch;
        log.info('publisher connected');
      },
    },
  });
  connection.on('disconnect', (err) => {
    channel = undefined;
    log.warn({ err }, 'publisher disconnected');
  });
}

export function publishEvent(message: EventMessage): Promise<void> {
  const ch = channel;
  if (!ch) return Promise.reject(new Error('event queue not connected'));
  return new Promise((resolve, reject) => {
    ch.publish(EXCHANGE, QUEUE, encodeEventMessage(message), { persistent: true, contentType: 'application/json' }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}
