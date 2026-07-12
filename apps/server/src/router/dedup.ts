import type { Redis } from 'ioredis';
import type { DedupStore } from './types.js';

/**
 * Redis implementation of the deduplication cooldown. Uses SET with NX+PX for
 * an atomic check-and-set: if the key already exists we are within cooldown
 * (duplicate); otherwise we claim it with a TTL. Also maintains a counter so a
 * future summary ("occurred N times") can be produced.
 */
export class RedisDedupStore implements DedupStore {
  constructor(private redis: Redis) {}

  async checkAndSet(
    tenantId: string,
    dedupKey: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const key = `dedup:${tenantId}:${dedupKey}`;
    const result = await this.redis.set(key, '1', 'PX', ttlSeconds * 1000, 'NX');
    if (result === null) {
      // Key already existed -> on cooldown -> duplicate.
      await this.redis.incr(`dedupcount:${tenantId}:${dedupKey}`);
      await this.redis.expire(
        `dedupcount:${tenantId}:${dedupKey}`,
        ttlSeconds,
      );
      return true;
    }
    return false;
  }
}
