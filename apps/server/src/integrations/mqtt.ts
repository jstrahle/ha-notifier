import mqtt from 'mqtt';
import { Queue as BullQueue } from 'bullmq';
import type { AppContext } from '../context.js';
import { messages, topics } from '../db/schema.js';
import { QUEUE_NAMES } from '../router/queue.js';
import { and, eq } from 'drizzle-orm';
import { PRIORITIES, isPriority } from '../lib/priority.js';
import { getSingleTenantId } from '../lib/auth.js';
import { subscribeAllUsersToTopic } from '../lib/subscriptions.js';

/**
 * MQTT bridge. Subscribes to `{prefix}#` and converts each message into an
 * internal notification.
 *
 * Topic convention: `{prefix}{topic}/{priority}`, e.g. `notify/security/critical`.
 * Payload may be JSON `{ title, body, dedup_key?, actions? }` or plain text
 * (used as the body, with the topic name as the title). Malformed payloads are
 * logged and skipped — the bridge never crashes the process.
 */
export async function startMqttBridge(ctx: AppContext): Promise<mqtt.MqttClient | null> {
  if (!ctx.config.MQTT_ENABLED) return null;

  const tenantId = await getSingleTenantId(ctx.db);
  const notifyQueue = new BullQueue(QUEUE_NAMES.notify, { connection: ctx.redis });
  const prefix = ctx.config.MQTT_TOPIC_PREFIX;
  const client = mqtt.connect(ctx.config.MQTT_URL);

  client.on('connect', () => {
    client.subscribe(`${prefix}#`, (err) => {
      if (err) console.error('MQTT subscribe failed:', err.message);
      else console.log(`MQTT bridge subscribed to ${prefix}#`);
    });
  });

  client.on('message', async (fullTopic, payloadBuf) => {
    try {
      const rest = fullTopic.startsWith(prefix) ? fullTopic.slice(prefix.length) : fullTopic;
      const parts = rest.split('/').filter(Boolean);
      const topicName = parts[0] ?? 'general';
      const maybePriority = parts[1];
      const priority = maybePriority && isPriority(maybePriority) ? maybePriority : 'normal';

      const raw = payloadBuf.toString('utf8').trim();
      let title = topicName;
      let body = raw;
      let dedupKey: string | null = null;

      if (raw.startsWith('{')) {
        const obj = JSON.parse(raw) as {
          title?: string;
          body?: string;
          dedup_key?: string;
        };
        title = obj.title ?? topicName;
        body = obj.body ?? '';
        dedupKey = obj.dedup_key ?? null;
      }

      const topicId = await resolveTopicId(ctx, tenantId, topicName);
      const msg = (
        await ctx.db
          .insert(messages)
          .values({ tenantId, topicId, priority, title, body, dedupKey, source: 'mqtt' })
          .returning({ id: messages.id })
      )[0]!;
      await notifyQueue.add('route', { messageId: msg.id }, { removeOnComplete: 1000 });
    } catch (err) {
      console.error('MQTT message handling failed:', err instanceof Error ? err.message : err);
    }
  });

  return client;
}

async function resolveTopicId(ctx: AppContext, tenantId: string, name: string): Promise<string> {
  const existing = (
    await ctx.db
      .select({ id: topics.id })
      .from(topics)
      .where(and(eq(topics.tenantId, tenantId), eq(topics.name, name)))
      .limit(1)
  )[0];
  if (existing) return existing.id;
  const created = (
    await ctx.db.insert(topics).values({ tenantId, name }).onConflictDoNothing().returning({ id: topics.id })
  )[0];
  if (created) {
    await subscribeAllUsersToTopic(ctx.db, tenantId, created.id);
    return created.id;
  }
  const again = (
    await ctx.db
      .select({ id: topics.id })
      .from(topics)
      .where(and(eq(topics.tenantId, tenantId), eq(topics.name, name)))
      .limit(1)
  )[0]!;
  return again.id;
}

void PRIORITIES;
