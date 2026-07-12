import { and, desc, eq, isNull, ne, or, sql as dsql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  deliveries,
  messages,
  subscriptions,
  users,
  escalationRules,
} from '../db/schema.js';
import type { Priority } from '../lib/priority.js';
import type {
  Channel,
  EscalationRule,
  Store,
  Subscriber,
} from '../router/types.js';
import { summarize } from './aggregation.js';

/** Postgres/Drizzle implementation of the router's Store port. */
export class DrizzleStore implements Store {
  constructor(private db: Db) {}

  async getSubscribers(
    _tenantId: string,
    topicId: string | null,
  ): Promise<Subscriber[]> {
    if (!topicId) return [];
    const rows = await this.db
      .select({
        userId: subscriptions.userId,
        smsNumber: users.smsNumber,
        minPriority: subscriptions.minPriority,
        quietStart: subscriptions.quietStart,
        quietEnd: subscriptions.quietEnd,
        channelPref: subscriptions.channelPref,
      })
      .from(subscriptions)
      .innerJoin(users, eq(users.id, subscriptions.userId))
      .where(eq(subscriptions.topicId, topicId));

    return rows.map((r) => ({
      userId: r.userId,
      smsNumber: r.smsNumber,
      minPriority: r.minPriority as Priority,
      quietStart: normalizeTime(r.quietStart),
      quietEnd: normalizeTime(r.quietEnd),
      channelPref: r.channelPref as Subscriber['channelPref'],
    }));
  }

  async getUserById(userId: string): Promise<Subscriber | null> {
    const row = (
      await this.db
        .select({ userId: users.id, smsNumber: users.smsNumber })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    )[0];
    if (!row) return null;
    return {
      userId: row.userId,
      smsNumber: row.smsNumber,
      minPriority: 'low',
      quietStart: null,
      quietEnd: null,
      channelPref: 'auto',
    };
  }

  async getEscalationRules(
    tenantId: string,
    topicId: string | null,
  ): Promise<EscalationRule[]> {
    const topicCond = topicId
      ? or(eq(escalationRules.topicId, topicId), isNull(escalationRules.topicId))
      : isNull(escalationRules.topicId);

    const rows = await this.db
      .select()
      .from(escalationRules)
      .where(and(eq(escalationRules.tenantId, tenantId), topicCond))
      .orderBy(escalationRules.stepOrder);

    return rows.map((r) => ({
      id: r.id,
      topicId: r.topicId,
      minPriority: r.minPriority as Priority,
      delaySeconds: r.delaySeconds,
      nextChannel: (r.nextChannel as Channel | null) ?? null,
      nextUserId: r.nextUserId,
      stepOrder: r.stepOrder,
    }));
  }

  async createDelivery(input: {
    messageId: string;
    userId: string;
    channel: Channel;
    ackToken: string | null;
    ackTokenExp: Date | null;
  }): Promise<{ id: string }> {
    const row = (
      await this.db
        .insert(deliveries)
        .values({
          messageId: input.messageId,
          userId: input.userId,
          channel: input.channel,
          ackToken: input.ackToken,
          ackTokenExp: input.ackTokenExp,
          status: 'queued',
        })
        .returning({ id: deliveries.id })
    )[0]!;
    return { id: row.id };
  }

  async isMessageAcknowledged(messageId: string): Promise<boolean> {
    const row = (
      await this.db
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
    return Boolean(row);
  }

  /** Count a suppressed duplicate against the message it was folded into. */
  async recordDuplicate(tenantId: string, dedupKey: string): Promise<void> {
    const target = await this.latestForDedupKey(tenantId, dedupKey);
    if (!target) return;
    await this.db
      .update(messages)
      .set({ duplicateCount: dsql`${messages.duplicateCount} + 1` })
      .where(eq(messages.id, target.id));
  }

  async getAggregationCandidate(
    tenantId: string,
    dedupKey: string,
  ): Promise<{ messageId: string; duplicateCount: number } | null> {
    const row = await this.latestForDedupKey(tenantId, dedupKey);
    if (!row) return null;
    return { messageId: row.id, duplicateCount: row.duplicateCount };
  }

  async applyAggregation(
    messageId: string,
    duplicateCount: number,
  ): Promise<void> {
    const row = (
      await this.db
        .select({ body: messages.body })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1)
    )[0];
    if (!row) return;

    await this.db
      .update(messages)
      .set({
        body: summarize(row.body, duplicateCount),
        // Reset so a later window starts from zero rather than re-reporting.
        duplicateCount: 0,
      })
      .where(eq(messages.id, messageId));
  }

  async getResendableDeliveries(messageId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.messageId, messageId),
          eq(deliveries.channel, 'webpush'),
          ne(deliveries.status, 'acknowledged'),
        ),
      );
    return rows.map((r) => r.id);
  }

  /** Most recent message carrying this dedup key within the tenant. */
  private async latestForDedupKey(tenantId: string, dedupKey: string) {
    return (
      await this.db
        .select({
          id: messages.id,
          duplicateCount: messages.duplicateCount,
        })
        .from(messages)
        .where(
          and(eq(messages.tenantId, tenantId), eq(messages.dedupKey, dedupKey)),
        )
        .orderBy(desc(messages.createdAt))
        .limit(1)
    )[0];
  }
}

/** postgres.js returns time as "HH:MM:SS"; the router expects "HH:MM" or null. */
function normalizeTime(t: string | null): string | null {
  if (!t) return null;
  return t.slice(0, 5);
}
