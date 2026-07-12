import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Queue as BullQueue } from 'bullmq';
import { messages } from '../db/schema.js';
import { QUEUE_NAMES } from '../router/queue.js';
import { requireApiScope } from '../lib/auth.js';
import { resolveTopic } from './notify.js';
import { PRIORITIES } from '../lib/priority.js';

/**
 * Home Assistant compatible endpoint. Accepts HA's native notify payload
 * ({ message, title, target, data }) and maps it to an internal notification,
 * so users can call a `notify.home` service from their automations.
 *
 * Convention: HA `target` -> topic name; HA `data.priority` -> priority.
 */
export async function registerHomeAssistantRoutes(app: FastifyInstance): Promise<void> {
  const notifyQueue = new BullQueue(QUEUE_NAMES.notify, { connection: app.ctx.redis });

  app.post('/v1/homeassistant/notify', { preHandler: requireApiScope('notify') }, async (req, reply) => {
    const schema = z.object({
      message: z.string(),
      title: z.string().optional(),
      target: z.union([z.string(), z.array(z.string())]).optional(),
      data: z
        .object({
          priority: z.enum(PRIORITIES).optional(),
          dedup_key: z.string().optional(),
        })
        .optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });

    const d = parsed.data;
    const tenantId = req.apiPrincipal!.tenantId;
    const topicName = Array.isArray(d.target) ? d.target[0] ?? 'general' : d.target ?? 'general';
    const topicId = await resolveTopic(app, tenantId, topicName);

    const msg = (
      await app.db
        .insert(messages)
        .values({
          tenantId,
          topicId,
          priority: d.data?.priority ?? 'normal',
          title: d.title ?? 'Home Assistant',
          body: d.message,
          dedupKey: d.data?.dedup_key ?? null,
          source: 'homeassistant',
        })
        .returning({ id: messages.id })
    )[0]!;

    await notifyQueue.add('route', { messageId: msg.id }, { removeOnComplete: 1000 });
    return reply.code(202).send({ message_id: msg.id, status: 'accepted' });
  });
}
