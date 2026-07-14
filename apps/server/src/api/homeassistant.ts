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
  /**
   * May an escalation run this without a human? Opt-in, per action, per alert.
   * Only ever set it on actions that move things to a SAFE state — closing a
   * valve, cutting power. Never on unlocking a door.
   */
  escalate: z.boolean().optional(),
});

/**
 * `actions` may arrive as a real array, or as a JSON string.
 *
 * The string form is not a quirk to tolerate — it is the only way Home Assistant
 * can pass per-call action buttons through `notify.rest`, and it is therefore the
 * normal case.
 *
 * `notify.rest` renders its `data_template:` block against the service call's
 * arguments (rest/notify.py), which is what lets an automation supply the buttons:
 *
 *     data_template:
 *       actions: "{{ data.actions | to_json }}"
 *
 * But it renders with `parse_result=False`, so the result is always a *string*.
 * Refusing it would mean a notifier per alert type instead of one per priority —
 * and worse, an alert that arrives looking perfectly normal while quietly having
 * no buttons, so the escalation has nothing to run and the valve never closes.
 */
const actionsField = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return undefined; // `{{ ... | default([]) }}` on an empty call
  try {
    return JSON.parse(trimmed);
  } catch {
    // Leave it; the array schema rejects it with a message that names the field,
    // rather than an opaque parse error.
    return value;
  }
}, z.array(actionSchema).max(4).optional());

/** An empty template render (`{{ data.dedup_key | default('') }}`) means "none". */
const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().max(200).optional(),
);

/** Extras, accepted either nested under `data` or flattened at the top level. */
const extrasSchema = z.object({
  priority: z.enum(PRIORITIES).optional(),
  dedup_key: optionalString,
  actions: actionsField,
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

/**
 * Validates and normalises a raw Home Assistant body in one step.
 *
 * Exported so the wire formats can be tested exactly as they arrive: the
 * JSON-string form of `actions` is handled by the schema, not by the normaliser,
 * so testing the normaliser alone would prove nothing about the case that
 * actually matters.
 */
export function parseHaPayload(
  body: unknown,
): { ok: true; message: NormalisedHaMessage } | { ok: false; error: string } {
  const parsed = haPayloadSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, message: normaliseHaPayload(parsed.data) };
}

export async function registerHomeAssistantRoutes(app: FastifyInstance): Promise<void> {
  const notifyQueue = new BullQueue(QUEUE_NAMES.notify, { connection: app.ctx.redis });

  app.post('/v1/homeassistant/notify', { preHandler: requireApiScope('notify') }, async (req, reply) => {
    const parsed = parseHaPayload(req.body);
    if (!parsed.ok) {
      return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error } });
    }

    const m = parsed.message;
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
