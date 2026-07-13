import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Queue as BullQueue } from 'bullmq';
import { messages } from '../db/schema.js';
import { QUEUE_NAMES } from '../router/queue.js';
import { requireApiScope } from '../lib/auth.js';
import { resolveTopic } from './notify.js';
import { PRIORITIES, type Priority } from '../lib/priority.js';
import type { NotificationAction } from '../router/types.js';

/**
 * Home Assistant compatible endpoint.
 *
 * This accepts HA's native notify payload, which is what both of HA's two
 * integration routes send:
 *
 *  1. `notify.rest` — HA's built-in RESTful notification platform. It gives you
 *     a real `notify.home_alert` action, exactly like `notify.pushover`, with no
 *     custom component. Crucially, its config-level `data:` block is merged into
 *     the payload at the **top level**:
 *
 *         { "message": "...", "title": "...", "target": "security",
 *           "priority": "critical" }
 *
 *  2. `rest_command` and HA's own notify service calls, which nest extras inside
 *     a `data` object:
 *
 *         { "message": "...", "data": { "priority": "critical" } }
 *
 * So the same field can legitimately arrive in either place, and we accept both.
 * Nested wins when both are present, because that is the more specific,
 * per-call form; the top-level one usually comes from static YAML config.
 *
 * Mapping: HA `target` -> topic name, HA `message` -> body.
 */

const actionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  url: z.string().url().optional(),
});

/** Extras, accepted either nested under `data` or flattened at the top level. */
const extrasSchema = z.object({
  priority: z.enum(PRIORITIES).optional(),
  dedup_key: z.string().max(200).optional(),
  actions: z.array(actionSchema).max(4).optional(),
  media_url: z.string().url().optional(),
});

const haPayloadSchema = extrasSchema.extend({
  message: z.string(),
  title: z.string().optional(),
  target: z.union([z.string(), z.array(z.string())]).optional(),
  data: extrasSchema.optional(),
});

export type HaPayload = z.infer<typeof haPayloadSchema>;

export interface NormalisedHaMessage {
  topicName: string;
  priority: Priority;
  title: string;
  body: string;
  dedupKey: string | null;
  actions: NotificationAction[] | null;
  mediaUrl: string | null;
}

/**
 * Flattens an HA payload into our internal shape. Pure — no I/O — so the
 * precedence rules above are directly testable.
 */
export function normaliseHaPayload(p: HaPayload): NormalisedHaMessage {
  // `target` may be a list (HA notify allows multiple targets). We take the
  // first: a message belongs to one topic here, and fanning out to several
  // topics would duplicate the alert rather than reach more people — everyone
  // subscribed to the topic already gets it.
  const target = Array.isArray(p.target) ? p.target[0] : p.target;

  return {
    topicName: target && target.trim() !== '' ? target : 'general',
    priority: p.data?.priority ?? p.priority ?? 'normal',
    title: p.title ?? 'Home Assistant',
    body: p.message,
    dedupKey: p.data?.dedup_key ?? p.dedup_key ?? null,
    actions: p.data?.actions ?? p.actions ?? null,
    mediaUrl: p.data?.media_url ?? p.media_url ?? null,
  };
}

export async function registerHomeAssistantRoutes(app: FastifyInstance): Promise<void> {
  const notifyQueue = new BullQueue(QUEUE_NAMES.notify, { connection: app.ctx.redis });

  app.post('/v1/homeassistant/notify', { preHandler: requireApiScope('notify') }, async (req, reply) => {
    const parsed = haPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    }

    const m = normaliseHaPayload(parsed.data);
    const tenantId = req.apiPrincipal!.tenantId;
    const topicId = await resolveTopic(app, tenantId, m.topicName);

    const msg = (
      await app.db
        .insert(messages)
        .values({
          tenantId,
          topicId,
          priority: m.priority,
          title: m.title,
          body: m.body,
          dedupKey: m.dedupKey,
          actions: m.actions,
          mediaUrl: m.mediaUrl,
          source: 'homeassistant',
        })
        .returning({ id: messages.id })
    )[0]!;

    await notifyQueue.add('route', { messageId: msg.id }, { removeOnComplete: 1000 });
    return reply.code(202).send({ message_id: msg.id, status: 'accepted' });
  });
}
