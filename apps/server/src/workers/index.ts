import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { AppContext } from '../context.js';
import { QUEUE_NAMES } from '../router/queue.js';
import { messages, topics } from '../db/schema.js';
import type { MessageInput, NotificationAction } from '../router/types.js';
import type { Priority } from '../lib/priority.js';

/**
 * Notify worker. Consumes the `notify` queue (fed by the API), loads the stored
 * message and runs it through the router.
 */
export function startNotifyWorker(ctx: AppContext, connection: Redis): Worker {
  return new Worker(
    QUEUE_NAMES.notify,
    async (job) => {
      const { messageId } = job.data as { messageId: string };
      const msg = (
        await ctx.db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
      )[0];
      if (!msg) return;

      let topicName: string | null = null;
      let dedupCooldownSeconds: number | null = null;
      if (msg.topicId) {
        const t = (
          await ctx.db.select().from(topics).where(eq(topics.id, msg.topicId)).limit(1)
        )[0];
        topicName = t?.name ?? null;
        dedupCooldownSeconds = t?.dedupCooldownSeconds ?? null;
      }

      const input: MessageInput = {
        id: msg.id,
        tenantId: msg.tenantId,
        topicId: msg.topicId,
        topicName,
        priority: msg.priority as Priority,
        title: msg.title,
        body: msg.body,
        dedupKey: msg.dedupKey,
        actions: (msg.actions as NotificationAction[] | null) ?? null,
        dedupCooldownSeconds,
        escalates: msg.escalates,
      };
      await ctx.router.route(input);
    },
    { connection, concurrency: 5 },
  );
}

/**
 * Aggregation worker. Fires when a dedup cooldown expires and folds any
 * duplicates suppressed during the window back into the original notification,
 * so the user learns the sensor fired seven more times instead of never hearing
 * about it.
 */
export function startAggregationWorker(ctx: AppContext, connection: Redis): Worker {
  return new Worker(
    QUEUE_NAMES.aggregation,
    async (job) => {
      const { tenantId, dedupKey } = job.data as {
        tenantId: string;
        dedupKey: string;
      };
      await ctx.aggregation.run(tenantId, dedupKey);
    },
    { connection, concurrency: 5 },
  );
}

/**
 * Escalation worker. Consumes the delayed `escalation` queue and runs one step
 * of the escalation chain. Acknowledgement is re-checked at the start of every
 * step, so a timely ack cancels the whole chain.
 */
export function startEscalationWorker(ctx: AppContext, connection: Redis): Worker {
  return new Worker(
    QUEUE_NAMES.escalation,
    async (job) => {
      const { messageId, stepOrder } = job.data as {
        messageId: string;
        stepOrder: number;
      };
      const msg = (
        await ctx.db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
      )[0];
      if (!msg) return;
      await ctx.escalation.run(msg.tenantId, messageId, msg.topicId, stepOrder);
    },
    { connection, concurrency: 5 },
  );
}
