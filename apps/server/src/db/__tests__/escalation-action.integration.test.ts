import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '../client.js';
import { runMigrations } from '../migrate.js';
import { DrizzleStore } from '../../router/store.js';
import {
  actionEvents,
  deliveries,
  escalationRules,
  messages,
  subscriptions,
  tenants,
  topics,
  users,
} from '../schema.js';

/**
 * The idempotency guarantee, tested against the real database.
 *
 * "Run the action at most once" is not something application code can promise on
 * its own: a queue job can be retried, and two workers can process the retry at
 * the same time. A check-then-insert would let both through. The claim is
 * therefore an INSERT against a unique partial index, and this suite exists to
 * prove that the index is really there and really holds — because the cost of
 * being wrong is a valve that closes twice, or worse, a physical action repeated
 * on every redelivery.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = DATABASE_URL ? describe : describe.skip;

suite('escalation action idempotency (real Postgres)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let store: DrizzleStore;
  let tenantId: string;
  let topicId: string;
  let messageId: string;

  beforeAll(async () => {
    await runMigrations(DATABASE_URL!);
    const c = createDb(DATABASE_URL!);
    db = c.db;
    store = new DrizzleStore(db);
    close = () => c.sql.end();
  });
  afterAll(async () => close());

  beforeEach(async () => {
    await db.delete(actionEvents);
    await db.delete(deliveries);
    await db.delete(messages);
    await db.delete(escalationRules);
    await db.delete(subscriptions);
    await db.delete(topics);
    await db.delete(users);
    await db.delete(tenants);

    tenantId = (await db.insert(tenants).values({ name: 'Home' }).returning({ id: tenants.id }))[0]!.id;
    topicId = (await db.insert(topics).values({ tenantId, name: 'security' }).returning({ id: topics.id }))[0]!.id;
    messageId = (
      await db
        .insert(messages)
        .values({
          tenantId,
          topicId,
          priority: 'critical',
          title: 'Water leak in kitchen',
          body: 'Kitchen sensor triggered',
          actions: [
            { id: 'shutoff', label: 'Close valve', url: 'https://ha.local/api/webhook/S', escalate: true },
          ],
        })
        .returning({ id: messages.id })
    )[0]!.id;
  });

  it('claims the action once and refuses every retry', async () => {
    expect(await store.claimEscalationAction(messageId, 'shutoff')).toBe(true);
    expect(await store.claimEscalationAction(messageId, 'shutoff')).toBe(false);
    expect(await store.claimEscalationAction(messageId, 'shutoff')).toBe(false);
  });

  it('holds even when two workers race on the same retried job', async () => {
    // A check-then-insert would let both of these through.
    const results = await Promise.all([
      store.claimEscalationAction(messageId, 'shutoff'),
      store.claimEscalationAction(messageId, 'shutoff'),
      store.claimEscalationAction(messageId, 'shutoff'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1); // exactly one winner
    expect(await db.select().from(actionEvents)).toHaveLength(1);
  });

  it('does not confuse two different actions on the same alert', async () => {
    expect(await store.claimEscalationAction(messageId, 'shutoff')).toBe(true);
    expect(await store.claimEscalationAction(messageId, 'power')).toBe(true);
  });

  it('does not block a human pressing the same button', async () => {
    await store.claimEscalationAction(messageId, 'shutoff');

    // The unique index is scoped to triggered_by = 'escalation', so a person can
    // still press the button afterwards — which is what you want if the
    // automatic attempt failed.
    await db.insert(actionEvents).values({
      messageId,
      actionId: 'shutoff',
      userId: null,
      triggeredBy: 'user',
      status: 'ok',
    });

    expect(await db.select().from(actionEvents)).toHaveLength(2);
  });

  it('records the outcome against the claim', async () => {
    await store.claimEscalationAction(messageId, 'shutoff');
    await store.recordEscalationActionResult(messageId, 'shutoff', {
      ok: false,
      httpStatus: 500,
      error: 'Receiver returned 500',
    });

    const row = (await db.select().from(actionEvents))[0]!;
    expect(row.status).toBe('failed');
    expect(row.httpStatus).toBe(500);
    expect(row.userId).toBeNull(); // no human did this
    expect(row.triggeredBy).toBe('escalation');
  });

  it('a system message can never escalate', async () => {
    const sys = await store.createSystemMessage({
      tenantId,
      topicId,
      priority: 'high',
      title: 'Automatic action taken',
      body: 'Close valve ran automatically.',
    });

    const row = (await db.select().from(messages).where(eq(messages.id, sys.id)))[0]!;
    expect(row.escalates).toBe(false);
    expect(row.source).toBe('escalation');
  });

  it('an ordinary alert still escalates by default', async () => {
    const row = (await db.select().from(messages).where(eq(messages.id, messageId)))[0]!;
    expect(row.escalates).toBe(true);
  });
});
