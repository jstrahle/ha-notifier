import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  tenants,
  users,
  topics,
  subscriptions,
  messages,
  deliveries,
  apiKeys,
  escalationRules,
} from '../db/schema.js';
import { requireUser, getSingleTenantId } from '../lib/auth.js';
import { generateToken, hashSecret } from '../lib/tokens.js';
import { hashPassword } from '../lib/password.js';
import {
  subscribeAllUsersToTopic,
  subscribeUserToAllTopics,
} from '../lib/subscriptions.js';
import { PRIORITIES } from '../lib/priority.js';

/**
 * Management API. Read/self-write endpoints require a logged-in user; structural
 * changes (users, api-keys, escalation rules) require an admin.
 */
export async function registerManagementRoutes(app: FastifyInstance): Promise<void> {
  // ---- Tenant (the household) ----
  // The initial name comes from TENANT_NAME in .env, but it must be editable
  // afterwards without redeploying — renaming your household should not require
  // touching a config file.
  app.get('/v1/tenant', { preHandler: requireUser() }, async (req, reply) => {
    const tenantId = req.userPrincipal!.tenantId;
    const row = (
      await app.db
        .select({ id: tenants.id, name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1)
    )[0];
    if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'Tenant not found' } });
    return reply.send(row);
  });

  app.patch('/v1/tenant', { preHandler: requireUser(true) }, async (req, reply) => {
    const parsed = z.object({ name: z.string().min(1).max(100) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const tenantId = req.userPrincipal!.tenantId;
    const row = (
      await app.db
        .update(tenants)
        .set({ name: parsed.data.name })
        .where(eq(tenants.id, tenantId))
        .returning({ id: tenants.id, name: tenants.name })
    )[0]!;
    return reply.send(row);
  });

  // ---- Topics ----
  app.get('/v1/topics', { preHandler: requireUser() }, async (req, reply) => {
    const tenantId = req.userPrincipal!.tenantId;
    const rows = await app.db.select().from(topics).where(eq(topics.tenantId, tenantId));
    return reply.send(rows);
  });

  app.post('/v1/topics', { preHandler: requireUser(true) }, async (req, reply) => {
    const parsed = z
      .object({
        // Topic names are the identifier senders use, so keep them boring:
        // lowercase letters, digits, dash and underscore.
        name: z
          .string()
          .min(1)
          .max(60)
          .regex(/^[a-z0-9_-]+$/, 'Use lowercase letters, digits, - and _ only'),
        dedup_cooldown_seconds: z.number().int().min(0).max(86400).nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const tenantId = req.userPrincipal!.tenantId;
    const row = (
      await app.db
        .insert(topics)
        .values({
          tenantId,
          name: parsed.data.name,
          dedupCooldownSeconds: parsed.data.dedup_cooldown_seconds ?? null,
        })
        .onConflictDoNothing()
        .returning()
    )[0];
    if (row) await subscribeAllUsersToTopic(app.db, tenantId, row.id);
    return reply.code(201).send(row ?? { status: 'exists' });
  });

  /**
   * Per-topic dedup cooldown. NULL falls back to DEDUP_COOLDOWN_SECONDS.
   *
   * Renaming is deliberately NOT supported. Senders address topics by *name*:
   * a Home Assistant automation posts to `"topic": "security"`. Rename that
   * topic and the automation keeps posting the old name — whereupon /v1/notify
   * silently creates a fresh topic under it that nobody is subscribed to, and
   * the alerts vanish with no error anywhere. Deleting and recreating is
   * explicit and visible; renaming is a trap.
   */
  app.patch('/v1/topics/:id', { preHandler: requireUser(true) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        dedup_cooldown_seconds: z.number().int().min(0).max(86400).nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    if (parsed.data.dedup_cooldown_seconds === undefined) return reply.send({ status: 'noop' });

    const tenantId = req.userPrincipal!.tenantId;
    const row = (
      await app.db
        .update(topics)
        .set({ dedupCooldownSeconds: parsed.data.dedup_cooldown_seconds })
        .where(and(eq(topics.id, id), eq(topics.tenantId, tenantId)))
        .returning()
    )[0];
    if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'Topic not found' } });
    return reply.send(row);
  });

  /**
   * Delete a topic. Subscriptions and escalation rules for it go with it;
   * past alerts are kept but detached (messages.topic_id becomes NULL), because
   * deleting a topic should not erase your alert history.
   */
  app.delete('/v1/topics/:id', { preHandler: requireUser(true) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const tenantId = req.userPrincipal!.tenantId;
    const deleted = await app.db
      .delete(topics)
      .where(and(eq(topics.id, id), eq(topics.tenantId, tenantId)))
      .returning({ id: topics.id, name: topics.name });
    if (deleted.length === 0) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Topic not found' } });
    }
    return reply.send({ status: 'deleted', name: deleted[0]!.name });
  });

  // ---- Subscriptions (self) ----
  app.put('/v1/subscriptions', { preHandler: requireUser() }, async (req, reply) => {
    const schema = z.object({
      topic_id: z.string().uuid(),
      min_priority: z.enum(PRIORITIES).default('normal'),
      quiet_start: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
      quiet_end: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
      channel_pref: z.enum(['auto', 'push_only', 'sms_only']).default('auto'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const userId = req.userPrincipal!.userId;
    const d = parsed.data;

    await app.db
      .insert(subscriptions)
      .values({
        userId,
        topicId: d.topic_id,
        minPriority: d.min_priority,
        quietStart: d.quiet_start ?? null,
        quietEnd: d.quiet_end ?? null,
        channelPref: d.channel_pref,
      })
      .onConflictDoUpdate({
        target: [subscriptions.userId, subscriptions.topicId],
        set: {
          minPriority: d.min_priority,
          quietStart: d.quiet_start ?? null,
          quietEnd: d.quiet_end ?? null,
          channelPref: d.channel_pref,
        },
      });
    return reply.send({ status: 'ok' });
  });

  /**
   * Message history (the user's inbox).
   *
   * Grouped by message, NOT by delivery. A critical alert goes out over web push
   * and SMS at once, which is two `deliveries` rows — but it is one alert. Listing
   * deliveries showed the same alert twice and demanded two acknowledgements for
   * it. The channels it went out on are returned as a list instead.
   */
  app.get('/v1/messages', { preHandler: requireUser() }, async (req, reply) => {
    const userId = req.userPrincipal!.userId;
    const limit = Math.min(Number((req.query as { limit?: string }).limit) || 50, 200);

    const rows = await app.db
      .select({
        id: messages.id,
        title: messages.title,
        body: messages.body,
        priority: messages.priority,
        actions: messages.actions,
        duplicateCount: messages.duplicateCount,
        createdAt: messages.createdAt,
        channels: sql<string[]>`array_agg(DISTINCT ${deliveries.channel})`,
        // Acknowledging any copy acknowledges the alert, so the alert is
        // acknowledged if any of this user's deliveries of it is.
        acknowledged: sql<boolean>`bool_or(${deliveries.status} = 'acknowledged')`,
        failed: sql<boolean>`bool_or(${deliveries.status} = 'failed')`,
      })
      .from(deliveries)
      .innerJoin(messages, eq(messages.id, deliveries.messageId))
      .where(eq(deliveries.userId, userId))
      .groupBy(messages.id)
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    return reply.send(rows);
  });

  // ---- Users (admin) ----
  app.get('/v1/users', { preHandler: requireUser(true) }, async (req, reply) => {
    const tenantId = req.userPrincipal!.tenantId;
    const rows = await app.db
      .select({ id: users.id, name: users.name, role: users.role, smsNumber: users.smsNumber })
      .from(users)
      .where(eq(users.tenantId, tenantId));
    return reply.send(rows);
  });

  app.post('/v1/users', { preHandler: requireUser(true) }, async (req, reply) => {
    const schema = z.object({
      name: z.string().min(1),
      password: z.string().min(8),
      sms_number: z.string().regex(/^\+\d{6,15}$/).optional(),
      role: z.enum(['admin', 'member']).default('member'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const tenantId = req.userPrincipal!.tenantId;
    const passwordHash = await hashPassword(parsed.data.password);
    const row = (
      await app.db
        .insert(users)
        .values({
          tenantId,
          name: parsed.data.name,
          smsNumber: parsed.data.sms_number ?? null,
          role: parsed.data.role,
          passwordHash,
        })
        .returning({ id: users.id, name: users.name, role: users.role })
    )[0]!;
    // New users are subscribed to every topic by default so they start
    // receiving notifications immediately.
    await subscribeUserToAllTopics(app.db, tenantId, row.id);
    return reply.code(201).send(row);
  });

  app.patch('/v1/users/:id', { preHandler: requireUser(true) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const schema = z.object({
      sms_number: z.string().regex(/^\+\d{6,15}$/).nullable().optional(),
      role: z.enum(['admin', 'member']).optional(),
      password: z.string().min(8).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const patch: Record<string, unknown> = {};
    if (parsed.data.sms_number !== undefined) patch.smsNumber = parsed.data.sms_number;
    if (parsed.data.role) patch.role = parsed.data.role;
    if (parsed.data.password) {
      patch.passwordHash = await hashPassword(parsed.data.password);
      // Changing a password must actually kick out existing sessions, or the
      // change is cosmetic: sessions here last over a year.
      patch.sessionVersion = sql`${users.sessionVersion} + 1`;
    }
    await app.db.update(users).set(patch).where(eq(users.id, id));
    return reply.send({ status: 'ok' });
  });

  /**
   * Delete a user.
   *
   * Two guards, both learned the hard way in systems like this: you cannot
   * delete yourself (an accidental click should not lock you out mid-session),
   * and you cannot delete the last admin (which would leave the household with
   * no way to administer anything at all).
   *
   * Their delivery history, subscriptions, devices and API keys go with them.
   * Escalation rules that targeted them fall back to notifying the original
   * recipients rather than silently disappearing.
   */
  app.delete('/v1/users/:id', { preHandler: requireUser(true) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const principal = req.userPrincipal!;

    if (id === principal.userId) {
      return reply.code(400).send({
        error: { code: 'cannot_delete_self', message: 'You cannot delete your own account' },
      });
    }

    const target = (
      await app.db
        .select({ id: users.id, role: users.role, name: users.name })
        .from(users)
        .where(and(eq(users.id, id), eq(users.tenantId, principal.tenantId)))
        .limit(1)
    )[0];
    if (!target) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'User not found' } });
    }

    if (target.role === 'admin') {
      const admins = await app.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, principal.tenantId), eq(users.role, 'admin')));
      if (admins.length <= 1) {
        return reply.code(409).send({
          error: {
            code: 'last_admin',
            message: 'Cannot delete the last admin — promote someone else first',
          },
        });
      }
    }

    await app.db.delete(users).where(eq(users.id, id));
    return reply.send({ status: 'deleted', name: target.name });
  });

  // ---- API keys (self-service) ----
  //
  // Keys are owned by the user who created them, so each person can mint and
  // rotate their own sender token without an admin in the loop. Admins can see
  // and revoke every key, including the tenant-level one created by the seed
  // (which has no owner).
  //
  // Only the hash is stored. The plaintext is returned exactly once, at creation
  // or rotation — it is not recoverable afterwards.

  app.get('/v1/api-keys', { preHandler: requireUser() }, async (req, reply) => {
    const principal = req.userPrincipal!;
    const isAdmin = principal.role === 'admin';

    const rows = await app.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        scopes: apiKeys.scopes,
        userId: apiKeys.userId,
        ownerName: users.name,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
      })
      .from(apiKeys)
      .leftJoin(users, eq(users.id, apiKeys.userId))
      .where(
        isAdmin
          ? eq(apiKeys.tenantId, principal.tenantId)
          : and(
              eq(apiKeys.tenantId, principal.tenantId),
              eq(apiKeys.userId, principal.userId),
            ),
      );

    return reply.send(
      rows.map((r) => ({
        ...r,
        mine: r.userId === principal.userId,
      })),
    );
  });

  app.post('/v1/api-keys', { preHandler: requireUser() }, async (req, reply) => {
    const schema = z.object({
      name: z.string().min(1).max(60),
      scopes: z.array(z.enum(['notify', 'admin'])).default(['notify']),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });

    const principal = req.userPrincipal!;
    // Guard against privilege escalation: a member must not be able to mint
    // themselves an admin-scoped key.
    if (parsed.data.scopes.includes('admin') && principal.role !== 'admin') {
      return reply.code(403).send({
        error: { code: 'forbidden', message: 'Only an admin can issue admin-scoped keys' },
      });
    }

    const plaintext = generateToken(24);
    const row = (
      await app.db
        .insert(apiKeys)
        .values({
          tenantId: principal.tenantId,
          userId: principal.userId,
          name: parsed.data.name,
          keyHash: hashSecret(plaintext),
          scopes: parsed.data.scopes,
        })
        .returning({ id: apiKeys.id })
    )[0]!;

    return reply.code(201).send({ id: row.id, name: parsed.data.name, key: plaintext });
  });

  /**
   * Rotate a key: issue a new secret and invalidate the old one immediately,
   * keeping the same key id, name and scopes. This is the operation you want
   * when a token may have leaked — the sender is updated in place rather than
   * having to create a new key and hunt down every reference to the old one.
   */
  app.post('/v1/api-keys/:id/rotate', { preHandler: requireUser() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const principal = req.userPrincipal!;

    const existing = (
      await app.db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, principal.tenantId)))
        .limit(1)
    )[0];
    if (!existing) return reply.code(404).send({ error: { code: 'not_found', message: 'Key not found' } });

    const owns = existing.userId === principal.userId;
    if (!owns && principal.role !== 'admin') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'Not your key' } });
    }

    const plaintext = generateToken(24);
    await app.db
      .update(apiKeys)
      .set({ keyHash: hashSecret(plaintext), lastUsedAt: null })
      .where(eq(apiKeys.id, id));

    return reply.send({ id, name: existing.name, key: plaintext });
  });

  app.delete('/v1/api-keys/:id', { preHandler: requireUser() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const principal = req.userPrincipal!;

    const existing = (
      await app.db
        .select({ userId: apiKeys.userId })
        .from(apiKeys)
        .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, principal.tenantId)))
        .limit(1)
    )[0];
    if (!existing) return reply.code(404).send({ error: { code: 'not_found', message: 'Key not found' } });

    const owns = existing.userId === principal.userId;
    if (!owns && principal.role !== 'admin') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'Not your key' } });
    }

    await app.db.delete(apiKeys).where(eq(apiKeys.id, id));
    return reply.send({ status: 'deleted' });
  });

  // ---- Escalation rules (admin) ----
  app.get('/v1/escalation-rules', { preHandler: requireUser(true) }, async (req, reply) => {
    const tenantId = req.userPrincipal!.tenantId;
    const rows = await app.db.select().from(escalationRules).where(eq(escalationRules.tenantId, tenantId));
    return reply.send(rows);
  });

  app.post('/v1/escalation-rules', { preHandler: requireUser(true) }, async (req, reply) => {
    const schema = z.object({
      topic_id: z.string().uuid().nullable().optional(),
      min_priority: z.enum(PRIORITIES).default('critical'),
      delay_seconds: z.number().int().min(10).default(180),
      next_channel: z.enum(['webpush', 'sms']).nullable().optional(),
      next_user_id: z.string().uuid().nullable().optional(),
      // Optional: if omitted, the step is appended to the end of that topic's
      // chain. Making a person pick a step number by hand is implementation
      // detail leaking into the UI — and getting it wrong creates a gap or a
      // duplicate in the chain.
      step_order: z.number().int().min(1).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const tenantId = req.userPrincipal!.tenantId;
    const d = parsed.data;
    const topicId = d.topic_id ?? null;

    const stepOrder = d.step_order ?? (await nextStepOrder(app, tenantId, topicId));

    const row = (
      await app.db
        .insert(escalationRules)
        .values({
          tenantId,
          topicId,
          minPriority: d.min_priority,
          delaySeconds: d.delay_seconds,
          nextChannel: d.next_channel ?? null,
          nextUserId: d.next_user_id ?? null,
          stepOrder,
        })
        .returning()
    )[0]!;
    return reply.code(201).send(row);
  });

  // ---- Diagnostics ----
  //
  // Sends an SMS straight through the provider, bypassing the router, dedup,
  // quiet hours and escalation entirely. That isolation is the point: if this
  // succeeds, the SMS channel itself works and any remaining problem is in
  // routing or subscriptions. If it fails, you get the provider's actual error
  // instead of a delivery row quietly marked 'failed'.
  //
  // Also worth calling on a schedule: a prepaid SIM can expire or run out of
  // credit without telling you, and a dead alert channel is the worst failure
  // this system has.
  app.post('/v1/admin/test-sms', { preHandler: requireUser(true) }, async (req, reply) => {
    const parsed = z
      .object({ to: z.string().regex(/^\+\d{6,15}$/).optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: 'to must be E.164, e.g. +358401234567' },
      });
    }

    if (!app.ctx.sms.enabled) {
      return reply.code(409).send({
        error: {
          code: 'sms_disabled',
          message: 'SMS_PROVIDER is none — no SMS channel is configured.',
        },
      });
    }

    // Default to the caller's own number so a test cannot be aimed elsewhere by
    // accident.
    const principal = req.userPrincipal!;
    const me = (
      await app.db.select().from(users).where(eq(users.id, principal.userId)).limit(1)
    )[0]!;
    const to = parsed.data.to ?? me.smsNumber;
    if (!to) {
      return reply.code(400).send({
        error: {
          code: 'no_number',
          message: 'You have no SMS number set. Add one, or pass { "to": "+358..." }.',
        },
      });
    }

    const stamp = new Date().toISOString().slice(11, 19);
    try {
      const result = await app.ctx.sms.send(
        to,
        `Test alert from ${app.ctx.config.TENANT_NAME} at ${stamp}. The SMS channel works.`,
      );
      return reply.send({
        status: 'sent',
        to,
        provider: app.ctx.config.SMS_PROVIDER,
        providerId: result.providerId,
      });
    } catch (err) {
      // Surface the provider's real error rather than a generic failure.
      return reply.code(502).send({
        error: {
          code: 'sms_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });

  /** Edit an existing step, rather than deleting and re-adding it. */
  app.patch('/v1/escalation-rules/:id', { preHandler: requireUser(true) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const schema = z.object({
      min_priority: z.enum(PRIORITIES).optional(),
      delay_seconds: z.number().int().min(10).optional(),
      next_channel: z.enum(['webpush', 'sms']).nullable().optional(),
      next_user_id: z.string().uuid().nullable().optional(),
      step_order: z.number().int().min(1).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });

    const d = parsed.data;
    const patch: Record<string, unknown> = {};
    if (d.min_priority !== undefined) patch.minPriority = d.min_priority;
    if (d.delay_seconds !== undefined) patch.delaySeconds = d.delay_seconds;
    if (d.next_channel !== undefined) patch.nextChannel = d.next_channel;
    if (d.next_user_id !== undefined) patch.nextUserId = d.next_user_id;
    if (d.step_order !== undefined) patch.stepOrder = d.step_order;
    if (Object.keys(patch).length === 0) return reply.send({ status: 'noop' });

    const tenantId = req.userPrincipal!.tenantId;
    const row = (
      await app.db
        .update(escalationRules)
        .set(patch)
        .where(and(eq(escalationRules.id, id), eq(escalationRules.tenantId, tenantId)))
        .returning()
    )[0];
    if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'Rule not found' } });
    return reply.send(row);
  });

  app.delete('/v1/escalation-rules/:id', { preHandler: requireUser(true) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const tenantId = req.userPrincipal!.tenantId;
    const deleted = await app.db
      .delete(escalationRules)
      .where(and(eq(escalationRules.id, id), eq(escalationRules.tenantId, tenantId)))
      .returning({ id: escalationRules.id });
    if (deleted.length === 0) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Rule not found' } });
    }
    return reply.send({ status: 'deleted' });
  });
}

/** The next free position in a topic's escalation chain. */
async function nextStepOrder(
  app: FastifyInstance,
  tenantId: string,
  topicId: string | null,
): Promise<number> {
  const rows = await app.db
    .select({ stepOrder: escalationRules.stepOrder })
    .from(escalationRules)
    .where(
      and(
        eq(escalationRules.tenantId, tenantId),
        topicId === null
          ? isNull(escalationRules.topicId)
          : eq(escalationRules.topicId, topicId),
      ),
    );
  const highest = rows.reduce((max, r) => Math.max(max, r.stepOrder), 0);
  return highest + 1;
}

export { getSingleTenantId };
