import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { users, pushSubscriptions, subscriptions, topics } from '../db/schema.js';
import { requireUser, sessionCookieOptions } from '../lib/auth.js';
import { verifyPassword } from '../lib/password.js';
import { encodeSession } from '../lib/session.js';
import { sql } from 'drizzle-orm';

/**
 * Session-based auth for PWA users, plus Web Push subscription management and
 * the VAPID public key endpoint the browser needs to subscribe.
 */
/**
 * The profile payload returned by both login and /v1/me.
 *
 * These used to be built separately, and login omitted `subscriptions`. The PWA
 * stored the login response as its user object, so Settings then called
 * `.map()` on an undefined list and blanked the whole tab until a reload
 * happened to fetch the fuller shape. One builder, one shape, no drift.
 */
export async function loadProfile(app: FastifyInstance, userId: string) {
  const user = (
    await app.db.select().from(users).where(eq(users.id, userId)).limit(1)
  )[0];
  if (!user) return null;

  const subs = await app.db
    .select({
      topicId: subscriptions.topicId,
      topicName: topics.name,
      minPriority: subscriptions.minPriority,
      quietStart: subscriptions.quietStart,
      quietEnd: subscriptions.quietEnd,
      channelPref: subscriptions.channelPref,
    })
    .from(subscriptions)
    .innerJoin(topics, eq(topics.id, subscriptions.topicId))
    .where(eq(subscriptions.userId, userId));

  return {
    id: user.id,
    name: user.name,
    role: user.role,
    sms_number: user.smsNumber,
    subscriptions: subs,
  };
}

export async function registerAuthAndPushRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/auth/login', async (req, reply) => {
    const schema = z.object({ name: z.string(), password: z.string() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'name and password required' } });

    const user = (
      await app.db.select().from(users).where(eq(users.name, parsed.data.name)).limit(1)
    )[0];
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, parsed.data.password))) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid credentials' } });
    }

    const maxAgeSeconds = app.ctx.config.SESSION_MAX_AGE_DAYS * 24 * 60 * 60;
    const token = encodeSession(user.id, user.sessionVersion);
    req.session = { userId: user.id, version: user.sessionVersion, issuedAt: Date.now() };
    reply.setCookie('sid', token, sessionCookieOptions(app.ctx.config, maxAgeSeconds));

    const profile = await loadProfile(app, user.id);
    return reply.send({
      ...profile,
      session_expires_in_days: app.ctx.config.SESSION_MAX_AGE_DAYS,
    });
  });

  app.post('/v1/auth/logout', async (_req, reply) => {
    reply.clearCookie('sid', { path: '/' });
    return reply.send({ status: 'ok' });
  });

  /**
   * Sign out everywhere. Bumps the user's session version, which immediately
   * invalidates every cookie they hold — on a lost phone, for instance. Without
   * a version there would be no way to do this at all: a signed user-id cookie
   * stays valid until it expires, and here that is over a year.
   */
  app.post('/v1/auth/logout-all', { preHandler: requireUser() }, async (req, reply) => {
    const userId = req.userPrincipal!.userId;
    await app.db
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, userId));
    reply.clearCookie('sid', { path: '/' });
    return reply.send({ status: 'all_sessions_revoked' });
  });

  app.get('/v1/me', { preHandler: requireUser() }, async (req, reply) => {
    const profile = await loadProfile(app, req.userPrincipal!.userId);
    if (!profile) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'User not found' } });
    }
    return reply.send(profile);
  });

  app.get('/v1/push/vapid-public-key', async (_req, reply) => {
    return reply.send({ key: app.ctx.config.VAPID_PUBLIC_KEY });
  });

  app.post('/v1/push/subscribe', { preHandler: requireUser() }, async (req, reply) => {
    const schema = z.object({
      endpoint: z.string().url(),
      keys: z.object({ p256dh: z.string(), auth: z.string() }),
      platform: z.enum(['ios', 'android', 'desktop']).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });

    const userId = req.userPrincipal!.userId;
    const { endpoint, keys, platform } = parsed.data;
    await app.db
      .insert(pushSubscriptions)
      .values({ userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, platform })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { userId, p256dh: keys.p256dh, auth: keys.auth, platform, lastSeenAt: new Date() },
      });
    return reply.code(201).send({ status: 'subscribed' });
  });

  app.delete('/v1/push/subscribe', { preHandler: requireUser() }, async (req, reply) => {
    const schema = z.object({ endpoint: z.string().url() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    await app.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, parsed.data.endpoint));
    return reply.send({ status: 'unsubscribed' });
  });
}
