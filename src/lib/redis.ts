import { createClient } from 'redis';
import { config } from '../config';
import { log } from './logger';

/**
 * The one Redis connection, shared by the rate-limit store and the account
 * cache. `undefined` when REDIS_URL is unset (tests, local dev without Redis):
 * both consumers then fall back to in-process memory.
 */
function connect(url: string) {
  const client = createClient({ url });
  client.on('error', (err) => log.error({ err }, 'redis error'));
  void client.connect(); // commands issued before this resolves are queued by the client
  return client;
}

export type RedisClient = ReturnType<typeof connect>;

export const redis: RedisClient | undefined = config.redisUrl ? connect(config.redisUrl) : undefined;
