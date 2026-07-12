import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { actionEvents, deliveries, messages, topics, users } from '../db/schema.js';
import { isExpired } from '../lib/tokens.js';
import { requireUser } from '../lib/auth.js';
import { acknowledgeMessageForUser } from '../lib/acknowledge.js';
import { sendActionWebhook } from '../lib/webhook.js';
import type { NotificationAction } from '../router/types.js';

/**
 * Acknowledgement and action endpoints.
 *
 * Acknowledging any delivery sets its status to 'acknowledged'; the escalation
 * worker checks this at the start of each step, so a timely ack cancels the
 * chain. SMS ack tokens are single-use and expiring — the token itself is the
 * authorization, since it arrives in a text message.
 */
export async function registerAckRoutes(app: FastifyInstance): Promise<void> {
  // Short link used in SMS: /a/:token -> confirmation page.
  app.get('/a/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const ok = await acknowledgeByToken(app, token);
    reply.type('text/html');
    return ok
      ? '<!doctype html><meta charset=utf-8><title>Acknowledged</title><body style="font-family:system-ui;text-align:center;padding-top:20vh"><h1>✓ Acknowledged</h1><p>The alert has been marked as handled.</p>'
      : reply
          .code(410)
          .send(
            '<!doctype html><meta charset=utf-8><title>Expired</title><body style="font-family:system-ui;text-align:center;padding-top:20vh"><h1>Link expired</h1><p>This acknowledgement link is no longer valid.</p>',
          );
  });

  // API form of the token ack.
  app.post('/v1/ack/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const ok = await acknowledgeByToken(app, token);
    if (!ok) return reply.code(410).send({ error: { code: 'gone', message: 'Token invalid or expired' } });
    return reply.send({ status: 'acknowledged' });
  });

  /**
   * Acknowledge by delivery id. Used by the service worker, which knows which
   * copy of the alert it rendered. Acknowledging any copy acknowledges the alert.
   */
  app.post(
    '/v1/deliveries/:id/ack',
    { preHandler: requireUser() },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.userPrincipal!.userId;

      const delivery = (
        await app.db
          .select({ messageId: deliveries.messageId })
          .from(deliveries)
          .where(and(eq(deliveries.id, id), eq(deliveries.userId, userId)))
          .limit(1)
      )[0];
      if (!delivery) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Delivery not found' } });
      }

      await acknowledgeMessageForUser(app.db, delivery.messageId, userId);
      return reply.send({ status: 'acknowledged' });
    },
  );

  /**
   * Acknowledge by message id. This is what the Inbox uses, because the Inbox
   * shows alerts, not delivery copies.
   */
  app.post(
    '/v1/messages/:id/ack',
    { preHandler: requireUser() },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.userPrincipal!.userId;

      const count = await acknowledgeMessageForUser(app.db, id, userId);
      if (count === 0) {
        // Either it is not addressed to this user, or it was already handled.
        const existing = (
          await app.db
            .select({ id: deliveries.id })
            .from(deliveries)
            .where(and(eq(deliveries.messageId, id), eq(deliveries.userId, userId)))
            .limit(1)
        )[0];
        if (!existing) {
          return reply.code(404).send({ error: { code: 'not_found', message: 'Message not found' } });
        }
      }
      return reply.send({ status: 'acknowledged' });
    },
  );

  /**
   * Action button (other than ack).
   *
   * The webhook can perform a real physical action, so we do not fire and
   * forget: the call is signed (HMAC-SHA256), the outcome is recorded in
   * `action_events`, and the result is returned to the caller so the UI can
   * tell the user whether the button press actually reached the house.
   */
  app.post(
    '/v1/actions/:messageId/:actionId',
    { preHandler: requireUser() },
    async (req, reply) => {
      const { messageId, actionId } = req.params as {
        messageId: string;
        actionId: string;
      };
      const principal = req.userPrincipal!;

      const msg = (
        await app.db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
      )[0];
      if (!msg) return reply.code(404).send({ error: { code: 'not_found', message: 'Message not found' } });

      const actions = (msg.actions as NotificationAction[] | null) ?? [];
      const action = actions.find((a) => a.id === actionId);
      if (!action) return reply.code(404).send({ error: { code: 'not_found', message: 'Action not found' } });

      const event = (
        await app.db
          .insert(actionEvents)
          .values({
            messageId,
            actionId,
            userId: principal.userId,
            status: 'pending',
          })
          .returning({ id: actionEvents.id })
      )[0]!;

      // An action with no URL is a plain acknowledgement-style tap: record it,
      // but there is nothing to call.
      if (!action.url) {
        await app.db
          .update(actionEvents)
          .set({ status: 'no_url' })
          .where(eq(actionEvents.id, event.id));
        return reply.send({ status: 'recorded', action: action.id });
      }

      const user = (
        await app.db.select().from(users).where(eq(users.id, principal.userId)).limit(1)
      )[0]!;
      const topic = msg.topicId
        ? (await app.db.select().from(topics).where(eq(topics.id, msg.topicId)).limit(1))[0]
        : undefined;

      const result = await sendActionWebhook(
        action.url,
        app.ctx.config.WEBHOOK_SIGNING_SECRET ?? app.ctx.config.SESSION_SECRET,
        {
          message_id: messageId,
          action_id: actionId,
          user_id: user.id,
          user_name: user.name,
          topic: topic?.name ?? null,
          priority: msg.priority,
          title: msg.title,
          triggered_at: new Date().toISOString(),
        },
      );

      await app.db
        .update(actionEvents)
        .set({
          status: result.ok ? 'ok' : 'failed',
          httpStatus: result.httpStatus,
          error: result.error,
        })
        .where(eq(actionEvents.id, event.id));

      if (!result.ok) {
        return reply.code(502).send({
          error: {
            code: 'webhook_failed',
            message: result.error ?? 'The action could not be delivered',
          },
        });
      }

      return reply.send({ status: 'triggered', action: action.id });
    },
  );
}

async function acknowledgeByToken(app: FastifyInstance, token: string): Promise<boolean> {
  const delivery = (
    await app.db.select().from(deliveries).where(eq(deliveries.ackToken, token)).limit(1)
  )[0];
  if (!delivery) return false;
  if (delivery.status === 'acknowledged') return false; // single-use
  if (isExpired(delivery.ackTokenExp)) return false;

  // Acknowledge every copy of this alert for this user, not just the one whose
  // token was used. The SMS and the web push are one alert, not two.
  await acknowledgeMessageForUser(app.db, delivery.messageId, delivery.userId);
  return true;
}
