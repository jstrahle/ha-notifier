import { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { AppContext } from '../context.js';
import { QUEUE_NAMES } from '../router/queue.js';
import {
  deliveries,
  messages,
  users,
  pushSubscriptions,
} from '../db/schema.js';
import type { NotificationAction } from '../router/types.js';
import { toGsm7Sms } from '../lib/gsm7.js';
import { toPublicActions, type PublicAction } from '../lib/actions.js';

/**
 * Delivery worker. Consumes the `delivery` queue and dispatches each delivery
 * to its channel. Web Push failures with 404/410 prune the dead subscription;
 * other failures throw so BullMQ retries with backoff.
 */
export function startDeliveryWorker(ctx: AppContext, connection: Redis): Worker {
  return new Worker(
    QUEUE_NAMES.delivery,
    async (job) => {
      const { deliveryId } = job.data as { deliveryId: string };
      const delivery = (
        await ctx.db.select().from(deliveries).where(eq(deliveries.id, deliveryId)).limit(1)
      )[0];
      if (!delivery) return;
      if (delivery.status === 'acknowledged') return; // already handled

      const message = (
        await ctx.db.select().from(messages).where(eq(messages.id, delivery.messageId)).limit(1)
      )[0];
      if (!message) return;

      if (delivery.channel === 'webpush') {
        await deliverWebPush(ctx, deliveryId, delivery.userId, delivery.ackToken, message);
      } else if (delivery.channel === 'sms') {
        await deliverSms(ctx, deliveryId, delivery.userId, delivery.ackToken, message);
      }
    },
    { connection, concurrency: 5 },
  );
}

/**
 * Ensures the notification always offers a way to acknowledge. Senders may omit
 * `actions` entirely; without this, an alert would arrive with no Acknowledge
 * button and escalation could only be stopped from the app.
 */
export function withAckAction(
  actions: NotificationAction[] | null,
): PublicAction[] {
  // Strip the webhook URLs first: they are secrets, and the device has no use
  // for them. The server makes the outbound call itself when a button is pressed.
  const list = toPublicActions(actions) ?? [];
  if (!list.some((a) => a.id === 'ack')) {
    list.unshift({ id: 'ack', label: 'Acknowledge' });
  }
  return list;
}

async function deliverWebPush(
  ctx: AppContext,
  deliveryId: string,
  userId: string,
  ackToken: string | null,
  message: typeof messages.$inferSelect,
): Promise<void> {
  const subs = await ctx.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  if (subs.length === 0) {
    await mark(ctx, deliveryId, 'failed', 'no push subscriptions');
    return;
  }

  let anySuccess = false;
  for (const sub of subs) {
    const result = await ctx.webpush.send(
      { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
      {
        title: message.title,
        body: message.body,
        priority: message.priority,
        tag: message.dedupKey,
        actions: withAckAction(message.actions as NotificationAction[] | null),
        data: { messageId: message.id, deliveryId, ackToken },
      },
    );
    if (result.ok) {
      anySuccess = true;
    } else if (result.gone) {
      // Prune the dead subscription.
      await ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
    }
  }

  await mark(ctx, deliveryId, anySuccess ? 'sent' : 'failed', anySuccess ? null : 'all endpoints failed');
}

async function deliverSms(
  ctx: AppContext,
  deliveryId: string,
  userId: string,
  ackToken: string | null,
  message: typeof messages.$inferSelect,
): Promise<void> {
  const user = (await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!user?.smsNumber) {
    await mark(ctx, deliveryId, 'failed', 'no sms number');
    return;
  }

  // The ack link must survive verbatim, so build it first and give the prose
  // whatever room is left. Sanitising to GSM-7 is not optional: RouterOS drops
  // non-GSM-7 characters silently, which would quietly corrupt a Finnish alert.
  const ackLink = ackToken ? ` Ack: ${ctx.config.APP_URL}/a/${ackToken}` : '';
  const prose = toGsm7Sms(`${message.title}. ${message.body}.`, 160 - ackLink.length);
  const text = prose + ackLink;

  try {
    await ctx.sms.send(user.smsNumber, text);
    await mark(ctx, deliveryId, 'sent', null);
  } catch (err) {
    await mark(ctx, deliveryId, 'failed', err instanceof Error ? err.message : String(err));
    throw err; // let BullMQ retry
  }
}

async function mark(
  ctx: AppContext,
  deliveryId: string,
  status: 'sent' | 'failed',
  error: string | null,
): Promise<void> {
  await ctx.db
    .update(deliveries)
    .set({
      status,
      error,
      sentAt: status === 'sent' ? new Date() : undefined,
    })
    .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, 'queued')));
}
