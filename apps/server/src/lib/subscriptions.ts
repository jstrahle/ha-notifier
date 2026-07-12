import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { subscriptions, topics, users } from '../db/schema.js';

/**
 * Auto-subscription.
 *
 * The router only delivers to users who have a row in `subscriptions`. Without
 * these helpers a fresh install has topics and users but no subscription rows,
 * so nothing is ever delivered until each user manually saves their preferences
 * — which is exactly the "it only works after I change a setting" trap.
 *
 * Policy: every user is subscribed to every topic by default, with the default
 * preferences (min_priority=normal, channel_pref=auto, no quiet hours). Users
 * can then narrow it in Settings. `onConflictDoNothing` means we never clobber
 * a preference a user has already set.
 */

/** Subscribe one user to every topic in the tenant. */
export async function subscribeUserToAllTopics(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<number> {
  const allTopics = await db
    .select({ id: topics.id })
    .from(topics)
    .where(eq(topics.tenantId, tenantId));
  if (allTopics.length === 0) return 0;

  await db
    .insert(subscriptions)
    .values(allTopics.map((t) => ({ userId, topicId: t.id })))
    .onConflictDoNothing();
  return allTopics.length;
}

/** Subscribe every user in the tenant to one topic. */
export async function subscribeAllUsersToTopic(
  db: Db,
  tenantId: string,
  topicId: string,
): Promise<number> {
  const allUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.tenantId, tenantId));
  if (allUsers.length === 0) return 0;

  await db
    .insert(subscriptions)
    .values(allUsers.map((u) => ({ userId: u.id, topicId })))
    .onConflictDoNothing();
  return allUsers.length;
}
