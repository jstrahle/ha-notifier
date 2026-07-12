import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Queue as BullQueue } from 'bullmq';
import { messages, topics } from '../db/schema.js';
import { QUEUE_NAMES } from '../router/queue.js';
import { requireApiScope, getSingleTenantId } from '../lib/auth.js';
import { PRIORITIES } from '../lib/priority.js';
import { subscribeAllUsersToTopic } from '../lib/subscriptions.js';

const actionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  url: z.string().url().optional(),
});

const notifySchema = z.object({
  topic: z.string().min(1).default('general'),
  priority: z.enum(PRIORITIES).default('normal'),
  title: z.string().min(1).max(200),
  body: z.string().max(2000).default(''),
  dedup_key: z.string().max(200).optional(),
  actions: z.array(actionSchema).max(4).optional(),
  media_url: z.string().url().optional(),
});

/**
 * Ingest endpoint. Validates, resolves/creates the topic, stores the message,
 * and enqueues it for the router. Returns 202 immediately — routing is async.
 * `source` lets us distinguish api/mqtt/homeassistant/webhook callers.
 */
export async function registerNotifyRoutes(app: FastifyInstance): Promise<void> {
  const notifyQueue = new BullQueue(QUEUE_NAMES.notify, { connection: app.ctx.redis });

  app.post('/v1/notify', { preHandler: requireApiScope('notify') }, async (req, reply) => {
    const parsed = notifySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    }
    const input = parsed.data;
    const tenantId = req.apiPrincipal!.tenantId;

    const topicId = await resolveTopic(app, tenantId, input.topic);

    const msg = (
      await app.db
        .insert(messages)
        .values({
          tenantId,
          topicId,
          priority: input.priority,
          title: input.title,
          body: input.body,
          dedupKey: input.dedup_key ?? null,
          actions: input.actions ?? null,
          mediaUrl: input.media_url ?? null,
          source: 'api',
        })
        .returning({ id: messages.id })
    )[0]!;

    await notifyQueue.add('route', { messageId: msg.id }, { removeOnComplete: 1000 });

    return reply.code(202).send({ message_id: msg.id, status: 'accepted' });
  });
}

/** Resolve a topic by name within the tenant, creating it if absent. */
export async function resolveTopic(
  app: FastifyInstance,
  tenantId: string,
  name: string,
): Promise<string> {
  const existing = (
    await app.db
      .select({ id: topics.id })
      .from(topics)
      .where(and(eq(topics.tenantId, tenantId), eq(topics.name, name)))
      .limit(1)
  )[0];
  if (existing) return existing.id;

  const created = (
    await app.db
      .insert(topics)
      .values({ tenantId, name })
      .onConflictDoNothing()
      .returning({ id: topics.id })
  )[0];
  if (created) {
    // A brand-new topic must reach the existing users, otherwise the first
    // notification to it silently goes nowhere.
    await subscribeAllUsersToTopic(app.db, tenantId, created.id);
    return created.id;
  }

  // Race: another request created it — read again.
  const again = (
    await app.db
      .select({ id: topics.id })
      .from(topics)
      .where(and(eq(topics.tenantId, tenantId), eq(topics.name, name)))
      .limit(1)
  )[0]!;
  return again.id;
}

export { getSingleTenantId };
