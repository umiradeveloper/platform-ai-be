import { Global, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ThrottlerStorage } from '@nestjs/throttler';

/**
 * Redis bersifat OPSIONAL.
 *  - REDIS_URL di-set  → rate limit & sinyal "stop" dibagi antar instance (cocok untuk >1 proses API / cluster PM2).
 *  - REDIS_URL kosong  → semuanya disimpan di memori proses (cukup untuk 1 instance API).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis | null;

  constructor() {
    const url = process.env.REDIS_URL?.trim();
    if (!url) {
      this.client = null;
      this.logger.log('REDIS_URL tidak di-set — memakai penyimpanan in-memory (mode 1 instance).');
      return;
    }
    this.client = new Redis(url, { maxRetriesPerRequest: 2 });
    this.client.on('error', (e) => this.logger.warn(`Redis error: ${e.message}`));
  }

  get enabled() {
    return !!this.client;
  }

  /** Koneksi terpisah untuk subscribe (Redis mewajibkan koneksi khusus untuk mode pub/sub). */
  duplicate(): Redis | null {
    return this.client ? this.client.duplicate() : null;
  }

  async onModuleDestroy() {
    await this.client?.quit().catch(() => undefined);
  }
}

/** Penyimpanan rate-limit: Redis bila tersedia, fallback ke Map di memori. */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly mem = new Map<string, { hits: number; expiresAt: number; blockedUntil: number }>();

  constructor(private readonly redis: RedisService) {
    // bersihkan entri kedaluwarsa secara berkala
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.mem) if (v.expiresAt < now && v.blockedUntil < now) this.mem.delete(k);
    }, 60_000).unref();
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    const k = `throttle:${throttlerName}:${key}`;
    const block = blockDuration || ttl;
    const r = this.redis.client;

    if (!r) {
      const now = Date.now();
      let e = this.mem.get(k);
      if (e && e.blockedUntil > now) {
        const s = Math.ceil((e.blockedUntil - now) / 1000);
        return { totalHits: limit + 1, timeToExpire: s, isBlocked: true, timeToBlockExpire: s };
      }
      if (!e || e.expiresAt <= now) e = { hits: 0, expiresAt: now + ttl, blockedUntil: 0 };
      e.hits++;
      const isBlocked = e.hits > limit;
      if (isBlocked) e.blockedUntil = now + block;
      this.mem.set(k, e);
      return {
        totalHits: e.hits,
        timeToExpire: Math.ceil((e.expiresAt - now) / 1000),
        isBlocked,
        timeToBlockExpire: isBlocked ? Math.ceil(block / 1000) : 0,
      };
    }

    const blockKey = `${k}:blocked`;
    const blockedTtl = await r.pttl(blockKey);
    if (blockedTtl > 0) {
      const s = Math.ceil(blockedTtl / 1000);
      return { totalHits: limit + 1, timeToExpire: s, isBlocked: true, timeToBlockExpire: s };
    }
    const totalHits = await r.incr(k);
    if (totalHits === 1) await r.pexpire(k, ttl);
    const pttl = await r.pttl(k);
    const isBlocked = totalHits > limit;
    if (isBlocked) await r.set(blockKey, '1', 'PX', block);
    return {
      totalHits,
      timeToExpire: Math.max(0, Math.ceil(pttl / 1000)),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.ceil(block / 1000) : 0,
    };
  }
}

@Global()
@Module({ providers: [RedisService, RedisThrottlerStorage], exports: [RedisService, RedisThrottlerStorage] })
export class RedisModule {}
