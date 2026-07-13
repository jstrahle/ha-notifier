import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '../client.js';
import { runMigrations } from '../migrate.js';
import {
  apiKeys,
  deliveries,
  escalationRules,
  messages,
  pushSubscriptions,
  subscriptions,
  tenants,
  topics,
  users,
} from '../schema.js';

/**
 * Deletion semantics.
 *
 * Before this change the foreign keys had no ON DELETE action, so deleting a
 * topic or a user that had ever been used failed outright with a constraint
 * violation. The rules encoded here are a product decision, not an
 * implementation detail, so they are pinned by tests:
 *
 *   - deleting a topic keeps the alert history (messages survive, detached)
 *   - deleting a topic removes its subscriptions and its escalation rules
 *   - deleting a user removes their inbox, devices and keys
 *   - an escalation rule that targeted a deleted user survives, falling back to
 *     notifying the original recipients
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = DATABASE_URL ? describe : describe.skip;

suite('deletion semantics (real Postgres)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let tenantId: string;
  let aliceId: string;
  let bobId: string;
  let topicId: string;

  beforeAll(async () => {
    await runMigrations(DATABASE_URL!);
    const c = createDb(DATABASE_URL!);
    db = c.db;
    close = () => c.sql.end();
  });
  afterAll(async () => close());

  beforeEach(async () => {
    await db.delete(deliveries);
    await db.delete(messages);
    await db.delete(escalationRules);
    await db.delete(apiKeys);
    await db.delete(pushSubscriptions);
    await db.delete(subscriptions);
    await db.delete(topics);
    await db.delete(users);
    await db.delete(tenants);

    tenantId = (await db.insert(tenants).values({ name: 'Home' }).returning({ id: tenants.id }))[0]!.id;
    aliceId = (await db.insert(users).values({ tenantId, name: 'alice' }).returning({ id: users.id }))[0]!.id;
    bobId = (await db.insert(users).values({ tenantId, name: 'bob' }).returning({ id: users.id }))[0]!.id;
    topicId = (await db.insert(topics).values({ tenantId, name: 'security' }).returning({ id: topics.id }))[0]!.id;
  });

  async function seedUsage() {
    await db.insert(subscriptions).values({ userId: aliceId, topicId });
    const messageId = (
      await db
        .insert(messages)
        .values({ tenantId, topicId, title: 'Leak', body: 'x', priority: 'critical' })
        .returning({ id: messages.id })
    )[0]!.id;
    await db.insert(deliveries).values({ messageId, userId: aliceId, channel: 'webpush' });
    await db.insert(escalationRules).values({
      tenantId,
      topicId,
      nextChannel: 'sms',
      nextUserId: bobId,
      stepOrder: 1,
    });
    await db.insert(pushSubscriptions).values({
      userId: aliceId,
      endpoint: 'https://push.example/1',
      p256dh: 'k',
      auth: 'a',
    });
    await db.insert(apiKeys).values({ tenantId, userId: aliceId, name: 'k', keyHash: 'h' });
    return messageId;
  }

  // ---- topic deletion ----

  it('can delete a topic that has been used (this used to be impossible)', async () => {
    await seedUsage();
    await expect(db.delete(topics).where(eq(topics.id, topicId))).resolves.toBeDefined();
  });

  it('keeps the alert history after deleting its topic', async () => {
    const messageId = await seedUsage();
    await db.delete(topics).where(eq(topics.id, topicId));

    const msg = (
      await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    )[0];
    expect(msg).toBeTruthy();          // history survives...
    expect(msg!.topicId).toBeNull();   // ...detached from the deleted topic
  });

  it('removes subscriptions and escalation rules with the topic', async () => {
    await seedUsage();
    await db.delete(topics).where(eq(topics.id, topicId));

    expect(await db.select().from(subscriptions)).toHaveLength(0);
    expect(await db.select().from(escalationRules)).toHaveLength(0);
  });

  it('leaves tenant-wide escalation rules (topic_id NULL) alone', async () => {
    await db.insert(escalationRules).values({
      tenantId,
      topicId: null, // applies to every topic
      nextChannel: 'sms',
      stepOrder: 1,
    });
    await db.delete(topics).where(eq(topics.id, topicId));

    expect(await db.select().from(escalationRules)).toHaveLength(1);
  });

  // ---- user deletion ----

  it('can delete a user who has received alerts', async () => {
    await seedUsage();
    await expect(db.delete(users).where(eq(users.id, aliceId))).resolves.toBeDefined();
  });

  it("removes the deleted user's inbox, devices and keys", async () => {
    await seedUsage();
    await db.delete(users).where(eq(users.id, aliceId));

    expect(await db.select().from(deliveries)).toHaveLength(0);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
    expect(await db.select().from(apiKeys)).toHaveLength(0);
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });

  it('keeps an escalation rule that targeted the deleted user, falling back to the original recipients', async () => {
    await seedUsage();
    await db.delete(users).where(eq(users.id, bobId)); // bob was the escalation target

    const rules = await db.select().from(escalationRules);
    expect(rules).toHaveLength(1);
    // next_user_id NULL means "re-notify the original recipients" — the chain
    // still fires rather than silently vanishing with the person.
    expect(rules[0]!.nextUserId).toBeNull();
  });

  it('does not touch the tenant or other users', async () => {
    await seedUsage();
    await db.delete(users).where(eq(users.id, aliceId));

    expect(await db.select().from(users)).toHaveLength(1); // bob remains
    expect(await db.select().from(tenants)).toHaveLength(1);
  });
});
