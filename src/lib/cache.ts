import { log } from './logger';
import { redis, type RedisClient } from './redis';

/**
 * Minimal string cache with per-entry TTL. Backed by Redis when REDIS_URL is
 * set, otherwise by a Map in this process (same fallback rule as the rate
 * limiter). Redis failures are logged and treated as a miss, so an outage
 * slows lookups down rather than failing requests.
 */
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

class RedisCache implements Cache {
  constructor(private readonly client: RedisClient) {}

  async get(key: string): Promise<string | null> {
    try {
      const value = await this.client.get(key);
      return value === null ? null : String(value);
    } catch (err) {
      log.warn({ err, key }, 'cache get failed');
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, value, { EX: ttlSeconds });
    } catch (err) {
      log.warn({ err, key }, 'cache set failed');
    }
  }
}

class MemoryCache implements Cache {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}

export const cache: Cache = redis ? new RedisCache(redis) : new MemoryCache();
