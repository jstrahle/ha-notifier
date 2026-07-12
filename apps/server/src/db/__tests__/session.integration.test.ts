import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Db } from '../client.js';
import { runMigrations } from '../migrate.js';
import { deliveries, messages, topics, tenants, users, apiKeys } from '../schema.js';
import { encodeSession, decodeSession } from '../../lib/session.js';

/**
 * Session revocation is a database concern: the cookie carries a version and the
 * user row holds the authoritative one. Only a real database proves the two stay
 * in step, and that the migration actually adds the column.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = DATABASE_URL ? describe : describe.skip;

suite('session revocation (real Postgres)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let tenantId: string;
  let userId: string;

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
    // Clean in foreign-key order — other suites may have left rows behind.
    await db.delete(deliveries);
    await db.delete(messages);
    await db.delete(apiKeys);
    await db.delete(topics);
    await db.delete(users);
    await db.delete(tenants);
    tenantId = (
      await db.insert(tenants).values({ name: 'Home' }).returning({ id: tenants.id })
    )[0]!.id;
    userId = (
      await db
        .insert(users)
        .values({ tenantId, name: 'alice', passwordHash: 'x' })
        .returning({ id: users.id })
    )[0]!.id;
  });

  /** Mirrors the check in requireUser(). */
  async function accepts(cookie: string): Promise<boolean> {
    const token = decodeSession(cookie);
    if (!token) return false;
    const user = (
      await db
        .select({ sessionVersion: users.sessionVersion })
        .from(users)
        .where(eq(users.id, token.userId))
        .limit(1)
    )[0];
    return Boolean(user) && user!.sessionVersion === token.version;
  }

  it('starts every user at version 1', async () => {
    const user = (
      await db.select({ v: users.sessionVersion }).from(users).where(eq(users.id, userId)).limit(1)
    )[0]!;
    expect(user.v).toBe(1);
  });

  it('accepts a freshly issued cookie', async () => {
    expect(await accepts(encodeSession(userId, 1))).toBe(true);
  });

  it('rejects every existing cookie once the version is bumped', async () => {
    const phone = encodeSession(userId, 1);
    const laptop = encodeSession(userId, 1);
    expect(await accepts(phone)).toBe(true);

    // "Log out all devices" / password change.
    await db
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, userId));

    expect(await accepts(phone)).toBe(false);
    expect(await accepts(laptop)).toBe(false);

    // A cookie issued after the bump works again.
    expect(await accepts(encodeSession(userId, 2))).toBe(true);
  });

  it('rejects a forged version', async () => {
    // Even if an attacker could mint the payload, the version must match the
    // database. (The cookie is signed, so they cannot — this is defence in depth.)
    expect(await accepts(encodeSession(userId, 99))).toBe(false);
  });

  it('rejects a cookie for a deleted user', async () => {
    const cookie = encodeSession(userId, 1);
    await db.delete(users).where(eq(users.id, userId));
    expect(await accepts(cookie)).toBe(false);
  });
});
