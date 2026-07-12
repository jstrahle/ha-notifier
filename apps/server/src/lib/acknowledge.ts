import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { deliveries } from '../db/schema.js';

/**
 * Acknowledgement semantics.
 *
 * A single alert can reach one person over several channels at once — a critical
 * message goes out as web push *and* SMS in parallel. Those are two `deliveries`
 * rows, but they are one alert, and "I acknowledge" means "I have seen this
 * alert", not "I have seen this copy of it".
 *
 * So every acknowledgement path funnels through here: whichever copy the user
 * happened to act on (the notification button, the SMS link, the Inbox), we mark
 * *all* of that user's deliveries of that message as acknowledged. Otherwise the
 * Inbox shows the same alert twice and demands two acknowledgements for it.
 *
 * Note this is deliberately scoped to one user. Another family member's copies
 * stay unacknowledged, because they have not seen it. Escalation is a separate
 * question and is already handled: the chain checks whether *anyone*
 * acknowledged, so one person acting is enough to stop it.
 */
export async function acknowledgeMessageForUser(
  db: Db,
  messageId: string,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const updated = await db
    .update(deliveries)
    .set({
      status: 'acknowledged',
      acknowledgedAt: now,
      // Burn any outstanding ack tokens for this alert: they are single-use, and
      // the SMS link must not stay live once the alert is handled.
      ackToken: null,
    })
    .where(
      and(
        eq(deliveries.messageId, messageId),
        eq(deliveries.userId, userId),
        ne(deliveries.status, 'acknowledged'),
      ),
    )
    .returning({ id: deliveries.id });

  return updated.length;
}
