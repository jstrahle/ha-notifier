import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '../client.js';
import { runMigrations } from '../migrate.js';
import {
  deliveries,
  messages,
  apiKeys,
  subscriptions,
  topics,
  tenants,
  users,
} from '../schema.js';
import { loadProfile } from '../../api/auth.js';

/**
 * Guards the profile payload shape.
 *
 * The bug: login returned { id, name, role } while /v1/me returned that plus
 * `subscriptions`. The PWA stored the login response as its user object, so the
 * Settings tab called `.map()` on an undefined list and rendered nothing until a
 * reload happened to fetch the fuller shape. Both endpoints now build the
 * profile with `loadProfile`, and this test pins the contract the client relies
 * on.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = DATABASE_URL ? describe : describe.skip;

suite('profile payload (real Postgres)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let tenantId: string;
  let userId: string;
  let topicId: string;

  // loadProfile only needs `app.db`.
  const appStub = () => ({ db }) as unknown as Parameters<typeof loadProfile>[0];

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
    await db.delete(deliveries);
    await db.delete(messages);
    await db.delete(apiKeys);
    await db.delete(subscriptions);
    await db.delete(topics);
    await db.delete(users);
    await db.delete(tenants);

    tenantId = (
      await db.insert(tenants).values({ name: 'Home' }).returning({ id: tenants.id })
    )[0]!.id;
    userId = (
      await db
        .insert(users)
        .values({ tenantId, name: 'alice', smsNumber: '+358401111111' })
        .returning({ id: users.id })
    )[0]!.id;
    topicId = (
      await db
        .insert(topics)
        .values({ tenantId, name: 'security' })
        .returning({ id: topics.id })
    )[0]!.id;
  });

  it('always carries every field the client dereferences', async () => {
    const profile = await loadProfile(appStub(), userId);

    expect(profile).not.toBeNull();
    expect(Object.keys(profile!).sort()).toEqual(
      ['id', 'name', 'role', 'sms_number', 'subscriptions'].sort(),
    );
  });

  it('returns an empty subscriptions array, never undefined', async () => {
    // A user with no subscriptions is the case that used to blow up: the client
    // maps over this list unconditionally.
    const profile = await loadProfile(appStub(), userId);

    expect(Array.isArray(profile!.subscriptions)).toBe(true);
    expect(profile!.subscriptions).toHaveLength(0);
  });

  it('includes the topic name alongside each subscription', async () => {
    await db.insert(subscriptions).values({
      userId,
      topicId,
      minPriority: 'high',
      channelPref: 'push_only',
    });

    const profile = await loadProfile(appStub(), userId);

    expect(profile!.subscriptions).toHaveLength(1);
    expect(profile!.subscriptions[0]).toMatchObject({
      topicId,
      topicName: 'security',
      minPriority: 'high',
      channelPref: 'push_only',
    });
  });

  it('returns null for an unknown user rather than a partial object', async () => {
    expect(
      await loadProfile(appStub(), '00000000-0000-0000-0000-000000000000'),
    ).toBeNull();
  });
});
