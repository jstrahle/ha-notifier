import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, desc, eq, sql } from 'drizzle-orm';
import { createDb, type Db } from '../client.js';
import { runMigrations } from '../migrate.js';
import {
  tenants,
  users,
  topics,
  messages,
  deliveries,
} from '../schema.js';
import { acknowledgeMessageForUser } from '../../lib/acknowledge.js';

/**
 * Integration tests against a real PostgreSQL.
 *
 * These exist because the bug they cover is invisible to the type checker: the
 * inbox query uses `GROUP BY` with `array_agg` / `bool_or`, and the
 * acknowledgement semantics are a multi-row UPDATE. Both are SQL behaviour, and
 * SQL behaviour is only proven by running it.
 *
 * Skipped automatically when TEST_DATABASE_URL is not set, so the normal
 * `npm test` run stays dependency-free.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = DATABASE_URL ? describe : describe.skip;

suite('inbox grouping and acknowledgement (real Postgres)', () => {
  let db: Db;
  let close: () => Promise<void>;

  let tenantId: string;
  let aliceId: string;
  let bobId: string;
  let topicId: string;

  beforeAll(async () => {
    await runMigrations(DATABASE_URL!);
    const created = createDb(DATABASE_URL!);
    db = created.db;
    close = () => created.sql.end();
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    // Clean slate, respecting foreign keys.
    await db.delete(deliveries);
    await db.delete(messages);
    await db.delete(topics);
    await db.delete(users);
    await db.delete(tenants);

    tenantId = (
      await db.insert(tenants).values({ name: 'Home' }).returning({ id: tenants.id })
    )[0]!.id;
    aliceId = (
      await db
        .insert(users)
        .values({ tenantId, name: 'alice', smsNumber: '+358401111111' })
        .returning({ id: users.id })
    )[0]!.id;
    bobId = (
      await db
        .insert(users)
        .values({ tenantId, name: 'bob', smsNumber: '+358402222222' })
        .returning({ id: users.id })
    )[0]!.id;
    topicId = (
      await db
        .insert(topics)
        .values({ tenantId, name: 'security' })
        .returning({ id: topics.id })
    )[0]!.id;
  });

  /** Mirrors the query in api/management.ts `/v1/messages`. */
  async function inboxFor(userId: string) {
    return db
      .select({
        id: messages.id,
        title: messages.title,
        channels: sql<string[]>`array_agg(DISTINCT ${deliveries.channel})`,
        acknowledged: sql<boolean>`bool_or(${deliveries.status} = 'acknowledged')`,
        failed: sql<boolean>`bool_or(${deliveries.status} = 'failed')`,
      })
      .from(deliveries)
      .innerJoin(messages, eq(messages.id, deliveries.messageId))
      .where(eq(deliveries.userId, userId))
      .groupBy(messages.id)
      .orderBy(desc(messages.createdAt));
  }

  async function criticalAlertTo(
    userIds: string[],
    title = 'Water leak',
  ): Promise<string> {
    const messageId = (
      await db
        .insert(messages)
        .values({
          tenantId,
          topicId,
          priority: 'critical',
          title,
          body: 'Kitchen sensor triggered',
        })
        .returning({ id: messages.id })
    )[0]!.id;

    // Exactly what the router does for a critical alert: web push AND SMS.
    for (const userId of userIds) {
      await db.insert(deliveries).values([
        { messageId, userId, channel: 'webpush', status: 'sent', ackToken: `w-${userId}` },
        { messageId, userId, channel: 'sms', status: 'sent', ackToken: `s-${userId}` },
      ]);
    }
    return messageId;
  }

  it('shows a critical alert once, not once per channel', async () => {
    await criticalAlertTo([aliceId]);

    const inbox = await inboxFor(aliceId);

    // The bug this test exists for: two deliveries used to mean two inbox rows.
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.channels.sort()).toEqual(['sms', 'webpush']);
    expect(inbox[0]!.acknowledged).toBe(false);
  });

  it('acknowledging clears every channel the alert used', async () => {
    const messageId = await criticalAlertTo([aliceId]);

    const cleared = await acknowledgeMessageForUser(db, messageId, aliceId);
    expect(cleared).toBe(2); // both the push and the SMS copy

    const rows = await db
      .select({ status: deliveries.status, ackToken: deliveries.ackToken })
      .from(deliveries)
      .where(eq(deliveries.messageId, messageId));

    expect(rows.every((r) => r.status === 'acknowledged')).toBe(true);
    // Outstanding SMS ack links must be burned once the alert is handled.
    expect(rows.every((r) => r.ackToken === null)).toBe(true);

    const inbox = await inboxFor(aliceId);
    expect(inbox[0]!.acknowledged).toBe(true);
  });

  it("does not acknowledge on another user's behalf", async () => {
    const messageId = await criticalAlertTo([aliceId, bobId]);

    await acknowledgeMessageForUser(db, messageId, aliceId);

    // Alice is done; Bob has still not seen it.
    expect((await inboxFor(aliceId))[0]!.acknowledged).toBe(true);
    expect((await inboxFor(bobId))[0]!.acknowledged).toBe(false);

    // But escalation must still stand down, because *someone* handled it.
    const anyAck = (
      await db
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(
          and(
            eq(deliveries.messageId, messageId),
            eq(deliveries.status, 'acknowledged'),
          ),
        )
        .limit(1)
    )[0];
    expect(anyAck).toBeTruthy();
  });

  it('is idempotent — acknowledging twice is not an error', async () => {
    const messageId = await criticalAlertTo([aliceId]);

    expect(await acknowledgeMessageForUser(db, messageId, aliceId)).toBe(2);
    expect(await acknowledgeMessageForUser(db, messageId, aliceId)).toBe(0);
    expect((await inboxFor(aliceId))[0]!.acknowledged).toBe(true);
  });

  it('reports a failed delivery without hiding the alert', async () => {
    const messageId = (
      await db
        .insert(messages)
        .values({ tenantId, topicId, priority: 'critical', title: 'Fire', body: 'x' })
        .returning({ id: messages.id })
    )[0]!.id;
    await db.insert(deliveries).values([
      { messageId, userId: aliceId, channel: 'webpush', status: 'sent' },
      { messageId, userId: aliceId, channel: 'sms', status: 'failed', error: 'no credit' },
    ]);

    const inbox = await inboxFor(aliceId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.failed).toBe(true);
    expect(inbox[0]!.acknowledged).toBe(false);
  });

  it('a push-only alert still shows exactly one row', async () => {
    const messageId = (
      await db
        .insert(messages)
        .values({ tenantId, topicId, priority: 'normal', title: 'Door', body: 'x' })
        .returning({ id: messages.id })
    )[0]!.id;
    await db
      .insert(deliveries)
      .values({ messageId, userId: aliceId, channel: 'webpush', status: 'sent' });

    const inbox = await inboxFor(aliceId);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.channels).toEqual(['webpush']);
  });
});
