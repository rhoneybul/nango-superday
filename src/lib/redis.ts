import { createClient } from 'redis';
import { config } from '../config';
import { log } from './logger';

/**
 * The Redis connection behind the rate-limit counters. `undefined` when
 * REDIS_URL is unset (tests, local dev without Redis): the counters then
 * live in process memory.
 */
function connect(url: string) {
  const client = createClient({ url });
  client.on('error', (err) => log.error({ err }, 'redis error'));
  void client.connect(); // commands issued before this resolves are queued by the client
  return client;
}

export type RedisClient = ReturnType<typeof connect>;

export const redis: RedisClient | undefined = config.redisUrl ? connect(config.redisUrl) : undefined;
