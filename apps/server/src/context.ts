import { Redis } from 'ioredis';
import type { AppConfig } from './config.js';
import { createDb, type Db } from './db/client.js';
import { WebPushChannel } from './channels/webpush.js';
import { createSmsProvider, type SmsProvider } from './channels/sms/index.js';
import { DrizzleStore } from './router/store.js';
import { RedisDedupStore } from './router/dedup.js';
import { BullMqQueue } from './router/queue.js';
import { Router } from './router/router.js';
import { EscalationProcessor } from './router/escalation.js';
import { AggregationProcessor } from './router/aggregation.js';
import { WebhookActionInvoker } from './channels/action-invoker.js';

/**
 * Central composition root. Builds the concrete adapters and injects them into
 * the router and escalation processor. Everything downstream depends on this
 * context rather than constructing infrastructure ad hoc.
 */
export interface AppContext {
  config: AppConfig;
  db: Db;
  redis: Redis;
  webpush: WebPushChannel;
  sms: SmsProvider;
  store: DrizzleStore;
  queue: BullMqQueue;
  router: Router;
  escalation: EscalationProcessor;
  aggregation: AggregationProcessor;
  close(): Promise<void>;
}

export function createContext(config: AppConfig): AppContext {
  const { db, sql } = createDb(config.DATABASE_URL);
  // BullMQ requires maxRetriesPerRequest: null on its connection.
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  const webpush = new WebPushChannel(config);
  const sms = createSmsProvider(config);
  const store = new DrizzleStore(db);
  const dedup = new RedisDedupStore(redis);
  const queue = new BullMqQueue(redis);

  const routerConfig = {
    dedupCooldownSeconds: config.DEDUP_COOLDOWN_SECONDS,
    ackTokenTtlSeconds: config.ACK_TOKEN_TTL_SECONDS,
    // The router must not select the SMS channel when no provider is
    // configured, or critical alerts would queue deliveries that only fail.
    smsEnabled: sms.enabled,
  };
  const router = new Router(store, dedup, queue, routerConfig);
  const escalation = new EscalationProcessor(
    store,
    queue,
    routerConfig,
    new WebhookActionInvoker(config),
  );
  const aggregation = new AggregationProcessor(store, queue);

  return {
    config,
    db,
    redis,
    webpush,
    sms,
    store,
    queue,
    router,
    escalation,
    aggregation,
    async close() {
      await queue.close();
      redis.disconnect();
      await sql.end();
    },
  };
}
