import { MemoryStore, type Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis, type RedisClient } from './redis';

/**
 * The counter store behind both ingest rate limits: the express-rate-limit
 * middleware on POST /ingest and the batch check in the event service. One
 * instance so keys are consistent; Redis when REDIS_URL is set (shared across
 * API replicas), otherwise in-process memory (tests, local dev without Redis).
 */
function redisStore(client: RedisClient) {
  return new RedisStore({ sendCommand: (...args: string[]) => client.sendCommand(args) });
}

export const rateLimitStore: Store = redis ? redisStore(redis) : new MemoryStore();
